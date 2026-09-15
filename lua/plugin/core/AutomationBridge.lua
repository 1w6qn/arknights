--[[
  AutomationBridge.lua —— 游戏内自动化命令桥（基础设施）

  ## 为什么需要它

  客户端 **没有入站监听能力**（Unity 侧只有 `UISender.me:SendGet/SendRequest` 主动出站），
  所以 MCP 服务器不可能跑在 Lua 里。可行拓扑是三角色：

      外部 Agent ──MCP(stdio)──▶ scripts/mcp-automation-server.ts
                                        │ HTTP
                                        ▼
                              私服 /plugin/automation/*（命令队列 + 结果重组）
                                        ▲ GET 轮询 / 分片回传
                                        │
                                本模块（游戏内执行器）

  本模块只负责**传输与调度**（轮询取命令、按序执行、把结果分片回传），
  具体能做什么由 `Plugin/plugins/AutomationPlugin` 经 `Register` 注入的处理器决定。

  ## 线协议（与 app/game/modules/system/automation.routes.ts 一一对应）

    GET /plugin/automation/poll/<sid>/<first>
        → { status=0, commands = { { id, name, args }, ... }, nextPollMs }
          `first` 为 1 表示本会话首次轮询（服务端据此登记会话/打日志）。

    GET /plugin/automation/result/<sid>/<cmdId>/<seq>/<total>/<base64url chunk>
        → { status=0 }
          结果 JSON 先 base64url 编码，再按 _MAX_CHUNK 切成 total 片顺序上传（seq 从 1 起）。
          服务端拼回整串 → base64url 解码 → JSON.parse 得到信封：
            { id, sid, ok, ms, result, error }

  ## 为什么走「路径 + base64url」而不是 POST body

    1. `SendGet` 是唯一在真机上被反复验证过的通道（心跳/选项同步都走它）；
    2. base64url 字母表（`A-Za-z0-9-_`）全部是 RFC3986 非保留字符 ⇒ **无需百分号转义**，
       分片等于原文长度，不像 JSON 百分号转义会膨胀 2~3 倍；
    3. 分片后单条请求行稳定在 ~2KB，避开 Node 默认 16KB 请求头上限。

  ## 硬契约（违反会让整个客户端 abort，见 docs/lua-plugin-dev-reference.md §10）

    - 所有交给游戏回调/定时器的东西必须是 **带 Call 方法的对象**（`Event.CreateStatic`），
      本模块统一经 `_AsEvent` / `_AsTimerCallback` 包装；
    - 所有 C# 调用与回调体一律 `xpcall` 兜底：本模块在**每一次轮询回调**里运行，
      一次逸出就是一次未捕获托管异常；
    - 释放前先停：`Stop()` 递增代际号，让所有在途定时器/回调自行作废（避免 `LuaEnv.Dispose` 时
      还有 C# 持有的 Lua 回调）。
--]]
local AutomationBridge = {}
local eutil = CS.Torappu.Lua.Util

-- 协议版本：与 app/ops/automation/automation-hub.ts 的 PROTOCOL_VERSION 对齐
AutomationBridge.PROTOCOL = 1

-- 与 automation.routes.ts 的路由前缀一致
local _BASE = "/plugin/automation"

-- 单个结果分片的最大字符数（base64url，无转义膨胀）
local _MAX_CHUNK = 1800
-- 结果信封序列化后的上限（超出则丢弃结果体、只回报超限原因），默认 512KB
local _MAX_RESULT_BYTES = 512 * 1024
-- 结果里单个字符串的上限（超出截断并标记）。
-- 刻意给得很大：截图 base64 就是一个大字符串，卡到 4KB 会把它拦腰截断；
-- 真正的总量闸门是 `_MAX_RESULT_BYTES`（超限整条结果降级为错误说明，语义清晰）。
local _MAX_STR = 400000
-- 结果递归深度上限（防止把整棵场景树序列化出去）
local _MAX_DEPTH = 8
-- 本地日志环形缓冲容量
local _LOG_CAP = 200

--[[
  异步处理器哨兵。

  处理器签名：`fn(args, ctx) -> table | AutomationBridge.ASYNC`
    - 返回 table    ⇒ 同步命令，返回值即 result；
    - 返回 ASYNC    ⇒ 异步命令，处理器必须在之后调用 `ctx.done(ok, result, err)`；
    - `error(msg)`  ⇒ 被 xpcall 捕获，回报 { ok = false, error = msg }。

  用独立哨兵而不是「返回 nil」来区分，是因为 `nil` 是合法的「无结果」语义。
--]]
AutomationBridge.ASYNC = setmetatable({}, {
  __tostring = function()
    return "AutomationBridge.ASYNC"
  end,
})

--------------------------------------------------------------------------------
-- 运行时状态
--------------------------------------------------------------------------------

-- 处理器注册表：name -> fn
local _handlers = {}
-- 本会话标识（服务端按它做命令寻址）
local _sid = nil
-- 当前配置（由插件经 Configure 注入）
local _opts = {
  sessionTag = "dts",
  pollIntervalMs = 1000,
  cmdTimeoutMs = 15000,
  maxResultBytes = _MAX_RESULT_BYTES,
  verbose = false,
}
-- 运行代际号：Stop/Start 时自增，在途回调凭它作废（防止重载后双链轮询）
local _gen = 0
local _running = false
local _busy = false
local _firstPoll = true
local _failures = 0
-- TimerModel 未就绪时登记待补排
local _pendingKick = false
local _driverHookInstalled = false
-- ModelMgr.Init 包装是否已装（引导早于模型实例化，是最可靠的补排时点）
local _modelHookInstalled = false
-- 帧驱动兜底（hotfix LuaManager.Update）是否已装
local _pumpInstalled = false
-- 帧计数（帧驱动按帧节流，不需要每帧都做看门狗判断）
local _pumpFrames = 0
-- 在途请求的起始时刻（0 = 无在途）；响应回调丢失时凭它解锁 `_busy`
local _busySince = 0
-- 下一次轮询的应到时刻（0 = 有在途请求/未排期）
local _nextDueAt = 0
-- 最近一次真正发出轮询的时刻
local _lastTickAt = 0
-- 生命周期诊断落盘的行数预算（见 `_TraceLife`）
local _traceBudget = 400
-- 生命周期诊断的行缓冲（WriteToFile 是覆盖写，必须自己累积全文）
local _lifeBuf = {}
-- 帧驱动包装的全局标记名：插件重载时凭它复用同一层包装而不是层层套娃
local _PUMP_KEY = "__DTS_AUTOMATION_FRAME_PUMP"
-- 备用帧驱动（GlobalInitializerAndUpdater.Update）的全局标记名
local _PUMP_KEY_GI = "__DTS_AUTOMATION_FRAME_PUMP_GI"
-- 备用帧驱动安装尝试次数（引导脚本还原它的时点不确定，只重试几次）
local _giPumpAttempts = 0
-- 「修复型」帧驱动的全局标记名 / 是否已装
local _PUMP_KEY_REPAIR = "__DTS_AUTOMATION_FRAME_PUMP_REPAIR"
local _repairPumpInstalled = false
-- 最近一次排期的时刻（判定「定时器排了却一直不跑」需要它）
local _lastScheduleAt = 0
-- 是否有过任何驱动触发（有 ⇒ 每帧入口是活的，不需要修）
local _driverFired = false
-- tick 死活探针：插件加载时刻的 (newborn, 时间)。判据是**状态对比**而不是固定时间窗——
-- 健康时这些定时器会在下一帧被提升进 `_timers`，被吞掉时 40ms 后仍原样堆在 `_newborn`。
-- （历史缺陷：先前用「距观察点 ≥120ms」判断，而首轮轮询的回调有时只隔 41ms ⇒ 漏判 ⇒ 桥继续静默）
local _tickProbeAt = 0
local _tickProbeNewborn = 0
-- 帧驱动安装失败原因（诊断用）
local _pumpLastError = nil
-- 轮询计数（诊断落盘的节流判据）
local _tickCount = 0
-- 排期计数（诊断落盘的节流判据）
local _scheduleCount = 0
-- 本地日志环形缓冲
local _logBuf = {}
local _logSeq = 0
-- Logger 单例缓存（惰性解析，避免引导阶段 CS 命名空间未就绪时反复失败）
local _rapidjson = nil
local _rapidjsonTried = false

--------------------------------------------------------------------------------
-- 小工具
--------------------------------------------------------------------------------

--[[
  单调递增的毫秒时间戳（用于耗时统计）。
  `Time.realtimeSinceStartup` 是 float 秒；不可用时退回 `os.time`（秒级精度）。
  @return 毫秒数
--]]
local function _Now()
  local ok, v = pcall(function()
    return CS.UnityEngine.Time.realtimeSinceStartup
  end)
  if ok and type(v) == "number" then
    return math.floor(v * 1000)
  end
  return os.time() * 1000
end

--[[
  写设备侧诊断文件（默认关闭，`verbose` 选项打开；IO 失败静默）。
  @param msg 文本
--]]
local function _Trace(msg)
  if not _opts.verbose then
    return
  end
  pcall(function()
    local path = CS.UnityEngine.Application.persistentDataPath .. "/plugin_automation_trace.txt"
    CS.Torappu.FileUtil.WriteToFile("[AutomationBridge] " .. tostring(msg), path, true)
  end)
end

--[[
  生命周期诊断落盘（不受 `verbose` 开关约束，但有预算）。

  存在的意义：「桥只轮询一次就静默」这类故障在服务端只能看到第一条请求，
  判据全在客户端侧（响应回调有没有回来 / 定时器排期成没成 / 帧驱动有没有兜底）。
  不落盘就只能靠重启 + 复现去猜，所以这几行代价换的是可观测性。

  ⚠️ `FileUtil.WriteToFile` 的第 3 参是 `useRetry` 而**不是 append**（每次覆盖写），
  所以必须自己在内存里累积全文再整体落盘——否则文件里永远只剩最后一行。
  @param msg 文本
--]]
local function _TraceLife(msg)
  if _traceBudget <= 0 then
    return
  end
  _traceBudget = _traceBudget - 1
  _lifeBuf[#_lifeBuf + 1] = "[" .. tostring(_Now()) .. "ms] " .. tostring(msg)
  while #_lifeBuf > 300 do
    table.remove(_lifeBuf, 1)
  end
  pcall(function()
    local path = CS.UnityEngine.Application.persistentDataPath .. "/plugin_automation_trace.txt"
    CS.Torappu.FileUtil.WriteToFile(table.concat(_lifeBuf, "\n"), path, false)
  end)
end

--[[
  把「Lua tick / 定时器」的真实状态落盘。

  判据来源：桥在登录阶段停摆时，必须区分三种可能——
    ① `LuaEntry.driveUpdate=false`（定时器系统自己关的，:_SetTimer 会替我们打开）
    ② `DynamicConfig.disableLuaTick=true`（游戏在加载期主动冻结整个 Lua tick）
    ③ 定时器排期成功但 `TimerModel:Update` 根本没被调用
  没有这几行就只能靠猜。
  @param tag 标记文本
--]]
local function _TraceTimerState(tag)
  pcall(function()
    local du = "?"
    pcall(function()
      du = tostring(CS.Torappu.Lua.LuaEntry.driveUpdate)
    end)
    local dlt = "不可达"
    pcall(function()
      dlt = tostring(CS.Torappu.DynamicConfig.instance.disableLuaTick)
    end)
    local sw, nt, nb = "?", "?", "?"
    pcall(function()
      local me = TimerModel.me
      sw = tostring(me._switcher ~= nil)
      nt = tostring(me._timers ~= nil and #me._timers or -1)
      nb = tostring(me._newborn ~= nil and #me._newborn or -1)
      -- 探针：记录「此刻有多少定时器堆在 _newborn」。健康时它们下一帧就会进 `_timers`。
      if _tickProbeAt == 0 and me._newborn ~= nil and me._timers ~= nil
        and #me._newborn > 0 and #me._timers == 0 then
        _tickProbeAt = _Now()
        _tickProbeNewborn = #me._newborn
      end
    end)
    _TraceLife(
      tag
        .. " driveUpdate="
        .. du
        .. " disableLuaTick="
        .. dlt
        .. " switcher="
        .. sw
        .. " timers="
        .. nt
        .. " newborn="
        .. nb
    )
  end)
end

--[[
  记一条本地日志：环形缓冲（供 `log.recent` 命令回读）+ 客户端日志。
  缓冲有上限，热路径调用不会无限增长。
  @param msg 文本
--]]
local function _Log(msg)
  _logSeq = _logSeq + 1
  _logBuf[#_logBuf + 1] = { seq = _logSeq, t = _Now(), msg = tostring(msg) }
  if #_logBuf > _LOG_CAP then
    table.remove(_logBuf, 1)
  end
  pcall(function()
    eutil.Log("[AutomationBridge] " .. tostring(msg))
  end)
  -- 客户端错误文本（未知命令/命令异常/结果上传失败…）没有第二条通道能读到，
  -- 而 `client.logs` 命令本身在链路故障时也调不通，所以一并落诊断文件。
  _TraceLife("[log] " .. tostring(msg))
end

--[[
  取 rapidjson（惰性 + 失败缓存）。引导阶段 CS 命名空间可能未就绪，
  失败后不缓存失败结果之外的任何副作用，仅避免每次都重试 require。
  @return rapidjson 模块或 nil
--]]
local function _Json()
  if _rapidjson == nil and not _rapidjsonTried then
    _rapidjsonTried = true
    local ok, mod = pcall(require, "rapidjson")
    if ok then
      _rapidjson = mod
    end
  end
  return _rapidjson
end

--[[
  把回调包成「带 Call 方法的对象」。

  ★ 契约：游戏侧 `callback.onProceed:Call(response)`（UISender:ExportOnProceed）；
  传裸函数会抛 `attempt to index a function value (field 'onProceed')` 并从
  C# 回调逸出 ⇒ 整个客户端 abort（2.7.71 实测，见 docs/plugin-ui-verify-2026-09-14.md）。
  @param fn 回调
  @return 可安全交给 UISender 的对象
--]]
local function _AsEvent(fn)
  local cb = fn
  pcall(function()
    if Event ~= nil and Event.CreateStatic ~= nil then
      cb = Event.CreateStatic(fn)
    end
  end)
  return cb
end

--[[
  把回调包成「带 Call 方法的对象」交给 TimerModel。

  ★ 契约：`Timer:Update` 是 `self.m_call:Call()`（data/[uc]lua/Timer.lua:52），
  而 `TimerModel:Delay(delay, cb)` 把 cb 直接当 m_call 存；传裸函数同样 abort。
  @param fn 回调
  @return 可交给 TimerModel 的对象
--]]
local function _AsTimerCallback(fn)
  return _AsEvent(fn)
end

--[[
  取 TimerModel 单例（未初始化返回 nil，不抛错）。
  @return TimerModel 或 nil
--]]
local function _Timer()
  local ok, timer = pcall(function()
    if TimerModel ~= nil then
      return TimerModel.me
    end
    return nil
  end)
  if ok then
    return timer
  end
  return nil
end

--[[
  发送就绪判定：单例与实例方法都在位（引导阶段 `UISender.me` 可能为 nil）。
  @return 是否可用于发送
--]]
local function _SenderReady()
  return UISender ~= nil and UISender.me ~= nil and UISender.me.SendGet ~= nil
end

--------------------------------------------------------------------------------
-- base64url 编码（纯 Lua，避免依赖 xLua 的 byte[] 映射口径）
--------------------------------------------------------------------------------

local _B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

--[[
  字符串 → base64url（无 `=` 填充）。

  为什么不用 `CS.System.Convert.ToBase64String`：xLua 对 `byte[]` 的映射口径随配置/版本变化
  （有时给 Lua string、有时给 userdata），纯 Lua 实现没有这类不确定性。
  @param data 原始字节串
  @return base64url 字符串
--]]
local function _Base64Url(data)
  local out = {}
  local n = #data
  local i = 1
  while i <= n do
    local b1 = string.byte(data, i)
    local b2 = i + 1 <= n and string.byte(data, i + 1) or nil
    local b3 = i + 2 <= n and string.byte(data, i + 2) or nil
    local c1 = math.floor(b1 / 4)
    local c2 = (b1 % 4) * 16 + (b2 ~= nil and math.floor(b2 / 16) or 0)
    out[#out + 1] = string.sub(_B64_ALPHABET, c1 + 1, c1 + 1)
    out[#out + 1] = string.sub(_B64_ALPHABET, c2 + 1, c2 + 1)
    if b2 ~= nil then
      local c3 = (b2 % 16) * 4 + (b3 ~= nil and math.floor(b3 / 64) or 0)
      out[#out + 1] = string.sub(_B64_ALPHABET, c3 + 1, c3 + 1)
    end
    if b3 ~= nil then
      local c4 = b3 % 64
      out[#out + 1] = string.sub(_B64_ALPHABET, c4 + 1, c4 + 1)
    end
    i = i + 3
  end
  return table.concat(out)
end

--------------------------------------------------------------------------------
-- 结果安全化
--------------------------------------------------------------------------------

--[[
  把任意 Lua 值转成「一定可被 rapidjson 编码」的纯数据。

  为什么必须做：处理器很容易顺手把 Unity 对象（userdata）、函数、循环引用塞进结果，
  `rapidjson.encode` 会抛错；而抛错点在**上传路径**上，会导致该命令的结果永远回不去。
  这里统一收敛：标量保留、字符串截断、表递归（限深）、其余 `tostring`（再失败给占位符）。
  @param value 任意值
  @param depth 当前深度
  @return 可序列化的值（nil 表示键被丢弃）
--]]
local function _Safe(value, depth)
  local t = type(value)
  if t == "nil" then
    return nil
  end
  if t == "boolean" then
    return value
  end
  if t == "number" then
    -- NaN/Inf 不能被 JSON 表示，直接字符串化（保留「当时确实不是有限数」的信息）
    if value ~= value or value == math.huge or value == -math.huge then
      return tostring(value)
    end
    return value
  end
  if t == "string" then
    if #value > _MAX_STR then
      return string.sub(value, 1, _MAX_STR) .. "...<truncated " .. tostring(#value) .. "B>"
    end
    return value
  end
  if t == "table" then
    if depth >= _MAX_DEPTH then
      return "<max-depth>"
    end
    local out = {}
    for key, val in pairs(value) do
      local kt = type(key)
      if kt == "string" or kt == "number" then
        local safe = _Safe(val, depth + 1)
        if safe ~= nil then
          out[key] = safe
        end
      end
    end
    return out
  end
  -- userdata / function / thread（Unity 对象等）：tostring 本身也可能抛（已销毁对象）
  local ok, s = pcall(tostring, value)
  if ok then
    return s
  end
  return "<" .. t .. ">"
end

--------------------------------------------------------------------------------
-- HTTP 传输
--------------------------------------------------------------------------------

--[[
  发一个 GET 并把响应体解析成表后回调。

  响应形态（实测）：回调拿到的是 `{ text = <原始响应体字符串> }`，需要先取 `.text`
  再 `rapidjson.decode`——不是直接的表（见技能 arknights-lua-plugin-contracts）。
  @param url    请求路径（含查询/路径参数；本模块一律把参数编码进路径）
  @param onDone function(data, text)：data 为解码后的表（失败为 nil）
  @return 是否「真的发出」（未就绪/调用异常返回 false）
--]]
local function _SendGet(url, onDone)
  if not _SenderReady() then
    return false
  end
  local ok = pcall(function()
    UISender.me:SendGet(url, nil, {
      onProceed = _AsEvent(function(resp)
        -- 回调体整体兜底：这里跑在 C# 的响应分发路径上，逸出即 abort
        xpcall(function()
          local text = nil
          if resp ~= nil then
            text = resp.text
          end
          local data = nil
          if type(text) == "string" and #text > 0 then
            local rj = _Json()
            if rj ~= nil and rj.decode ~= nil then
              local okd, decoded = pcall(rj.decode, text)
              if okd then
                data = decoded
              end
            end
          elseif type(text) == "table" then
            -- 兼容有些版本直接把解析好的表塞进 text
            data = text
          end
          if onDone ~= nil then
            onDone(data, text)
          end
        end, debug.traceback)
      end),
      useMask = false,
    })
  end)
  return ok
end

--------------------------------------------------------------------------------
-- 结果分片上传
--------------------------------------------------------------------------------

--[[
  把一个结果信封分片上传（seq 从 1 到 total，顺序发送；最后一片到达即完成）。

  逐片串行而不是并发：`UISender` 的并发语义（ENQUEUE）下顺序到达才保证服务端
  能按 seq 拼接，且避免瞬时打出几十个请求把游戏网络层压住。
  @param cmdId   命令标识
  @param ok      命令是否成功
  @param result  结果体（任意可序列化的值）
  @param err     错误文本（成功时为 nil）
  @param ms      耗时毫秒
  @param onDone  全部上传完毕（或彻底失败）后的回调
--]]
local function _SendResult(cmdId, ok, result, err, ms, onDone)
  local gen = _gen
  local function finish()
    if onDone ~= nil then
      onDone()
    end
  end

  local envelope = {
    id = cmdId,
    sid = _sid,
    protocol = AutomationBridge.PROTOCOL,
    ok = ok and true or false,
    ms = ms or 0,
    result = _Safe(result, 0),
    error = err ~= nil and tostring(err) or nil,
  }

  local rj = _Json()
  _TraceLife("结果准备: cmd=" .. tostring(cmdId) .. " ok=" .. tostring(ok) .. " err=" .. tostring(err))
  local json = nil
  if rj ~= nil and rj.encode ~= nil then
    local okj, encoded = pcall(rj.encode, envelope)
    if okj and type(encoded) == "string" then
      json = encoded
    end
  end
  if json == nil then
    -- 编码失败：降级成一条纯文本错误（绝不能因为结果体不可编码而静默丢结果）
    json = string.format(
      '{"id":"%s","sid":"%s","protocol":%d,"ok":false,"ms":%d,"error":"result encode failed"}',
      tostring(cmdId),
      tostring(_sid),
      AutomationBridge.PROTOCOL,
      ms or 0
    )
  end

  local limit = tonumber(_opts.maxResultBytes) or _MAX_RESULT_BYTES
  if #json > limit then
    _Log("结果超限丢弃: cmd=" .. tostring(cmdId) .. " " .. tostring(#json) .. "B > " .. tostring(limit) .. "B")
    json = string.format(
      '{"id":"%s","sid":"%s","protocol":%d,"ok":false,"ms":%d,"error":"result too large","result":{"bytes":%d,"limit":%d}}',
      tostring(cmdId),
      tostring(_sid),
      AutomationBridge.PROTOCOL,
      ms or 0,
      #json,
      limit
    )
  end

  local b64 = _Base64Url(json)
  local total = math.max(1, math.ceil(#b64 / _MAX_CHUNK))
  local seq = 0
  local retried = false
  _TraceLife("结果上传: cmd=" .. tostring(cmdId) .. " json=" .. tostring(#json) .. "B chunks=" .. tostring(total))

  local function step()
    if gen ~= _gen or not _running then
      return
    end
    seq = seq + 1
    if seq > total then
      finish()
      return
    end
    local chunk = string.sub(b64, (seq - 1) * _MAX_CHUNK + 1, seq * _MAX_CHUNK)
    local url = string.format("%s/result/%s/%s/%d/%d/%s", _BASE, _sid, cmdId, seq, total, chunk)
    local sent = _SendGet(url, function(data)
      if data == nil and not retried then
        -- 单片失败重试一次：网络抖动不该让整条结果作废
        retried = true
        seq = seq - 1
        step()
        return
      end
      step()
    end)
    if not sent then
      if not retried then
        retried = true
        seq = seq - 1
        step()
      else
        _Log("结果分片发送失败: cmd=" .. tostring(cmdId) .. " seq=" .. tostring(seq) .. "/" .. tostring(total))
        finish()
      end
    end
  end

  step()
end

--------------------------------------------------------------------------------
-- 命令执行
--------------------------------------------------------------------------------

--[[
  执行单条命令并回调结果（同步/异步统一出口）。

  异步处理器（返回 `AutomationBridge.ASYNC`）由自身调用 `ctx.done` 收尾，
  这里挂一个超时兜底，防止命令把轮询链永久卡住（`_busy` 不复位 ⇒ 后续命令全积压）。
  @param gen    运行代际号
  @param cmd    { id, name, args }
  @param onDone function(ok, result, err, ms)
--]]
local function _ExecCommand(gen, cmd, onDone)
  local name = cmd ~= nil and cmd.name or nil
  local handler = name ~= nil and _handlers[tostring(name)] or nil
  local started = _Now()

  --[[
    「本条命令只收尾一次」的闸门。

    ★ 必须是 local：写漏这个声明会让 `finished` 变成**全局**，于是「第一条命令收尾」之后
    所有后续命令的 `finish()` 都在第一行短路返回 ⇒ 结果永远不上传 ⇒ MCP 侧一律超时，
    同时批次永不结束、后续命令全部积压。真机现象：`client.ping` 第一次成功，
    之后**任何**命令（含再次 ping）都超时。
  ]]
  local finished = false

  local function finish(ok, result, err)
    if finished then
      return
    end
    finished = true
    if gen ~= _gen or not _running then
      return
    end
    onDone(ok, result, err, _Now() - started)
  end

  if handler == nil then
    _Log("未知命令: " .. tostring(name))
    finish(false, nil, "未知命令（客户端未注册）: " .. tostring(name))
    return
  end

  local ctx = {
    id = cmd.id,
    sid = _sid,
    done = function(ok, result, err)
      finish(ok == true, result, err)
    end,
  }

  local ok, ret = xpcall(function()
    return handler(_Safe(cmd.args, 0) or {}, ctx)
  end, debug.traceback)

  if not ok then
    _Log("命令异常: " .. tostring(name) .. " -> " .. tostring(ret))
    finish(false, nil, tostring(ret))
    return
  end

  if ret == AutomationBridge.ASYNC then
    local timeoutMs = tonumber(_opts.cmdTimeoutMs) or 15000
    local timer = _Timer()
    if timer ~= nil then
      local okDelay = pcall(function()
        timer:Delay(math.max(0.05, timeoutMs / 1000), _AsTimerCallback(function()
          finish(false, nil, string.format("命令超时（%dms）: %s", timeoutMs, tostring(name)))
        end))
      end)
      if not okDelay then
        _Log("超时定时器排期失败: " .. tostring(name))
      end
    end
    return
  end

  finish(true, ret, nil)
end

--[[
  顺序执行一批命令（逐条「执行 → 回传结果 → 下一条」）。
  串行是刻意的：命令之间常有先后依赖（先点开面板再读层级），并发会让结果不可复现。
  @param gen      运行代际号
  @param commands 命令数组
  @param index    当前下标
  @param onDone   全部完成后的回调
--]]
local function _RunBatch(gen, commands, index, onDone)
  if gen ~= _gen or not _running then
    return
  end
  local cmd = commands[index]
  if cmd == nil or cmd.id == nil or cmd.name == nil then
    if cmd ~= nil then
      _Log("跳过格式非法的命令条目 #" .. tostring(index))
    end
    if cmd == nil then
      onDone()
      return
    end
    _RunBatch(gen, commands, index + 1, onDone)
    return
  end
  _ExecCommand(gen, cmd, function(ok, result, err, ms)
    _SendResult(cmd.id, ok, result, err, ms, function()
      _RunBatch(gen, commands, index + 1, onDone)
    end)
  end)
end

--------------------------------------------------------------------------------
-- 调度循环
--------------------------------------------------------------------------------

-- 前向声明：`_Schedule` 在 TimerModel 未就绪时要重试安装驱动钩子（实现见本段末尾）
local _InstallDriverHook
-- 前向声明：帧驱动兜底（实现见 `_InstallDriverHook` 之后）
local _InstallFramePump
local _FramePump
-- 前向声明：备用帧驱动（GlobalInitializerAndUpdater.Update）
local _InstallGlobalInitPump
-- 前向声明：修复型帧驱动 + Lua tick 死活判定
local _InstallRepairPump
local _LuaTickLooksDead

--[[
  排下一次轮询（毫秒）。

  `_nextDueAt` 是**帧驱动兜底的判据**：无论定时器排期成没成，都先记下「应到时刻」，
  帧驱动据此发现「应到而未到」并补跑（见 `_FramePump`）。
  @param ms 延迟毫秒
--]]
local function _Schedule(ms)
  if not _running then
    return
  end
  local span = tonumber(ms) or _opts.pollIntervalMs or 1000
  if span < 50 then
    span = 50
  end
  _lastScheduleAt = _Now()
  _nextDueAt = _lastScheduleAt + span
  local gen = _gen
  local timer = _Timer()
  if timer == nil then
    _pendingKick = true
    _InstallDriverHook()
    _InstallFramePump()
    if _scheduleCount <= 10 then
      _TraceLife("排期: TimerModel 未就绪 span=" .. tostring(span) .. "ms → 帧驱动兜底")
    end
    _scheduleCount = _scheduleCount + 1
    return
  end
  if _scheduleCount <= 10 or _scheduleCount % 30 == 0 then
    _TraceLife("排期: TimerModel 就绪 span=" .. tostring(span) .. "ms")
  end
  _scheduleCount = _scheduleCount + 1
  local ok = pcall(function()
    timer:Delay(math.max(0.05, span / 1000), _AsTimerCallback(function()
      if gen ~= _gen or not _running then
        return
      end
      AutomationBridge._Tick()
    end))
  end)
  if not ok then
    _Log("轮询排期失败（TimerModel 异常）")
    _TraceLife("排期失败（TimerModel 异常）→ 交给帧驱动兜底")
    _InstallFramePump()
  else
    -- `TimerModel:_SetTimer` 只在「switcher 存在且当前没有活定时器」时替我们打开
    -- `LuaEntry.driveUpdate`。桥的空闲轮询恰好是「排期 → 到期 → 再排期」，中间存在
    -- 没有活定时器的瞬间，drive 会被 :Update 关掉，于是下一次排期的定时器永远不跑
    -- （定时器 tick 依赖 `LuaEntry.Update`，而它又依赖 driveUpdate）。这里显式兜底。
    local forced = false
    pcall(function()
      if CS.Torappu.Lua.LuaEntry.driveUpdate ~= true then
        CS.Torappu.Lua.LuaEntry.driveUpdate = true
        forced = true
      end
    end)
    if forced then
      _TraceLife("driveUpdate 原为 false，已补开（定时器否则永不 tick）")
      _TraceTimerState("补开后")
    end
  end
end

--[[
  一次轮询：取命令 → 执行 → 回传 → 立刻再轮询（把队列排空）。

  `_busy` 是**必须**的：轮询回调是异步的，不设闸门的话上一次还没回来就会叠一堆请求。
  代价是**回调丢失即锁死**——所以 `_busySince` + 帧驱动看门狗是配套的（见 `_FramePump`）。
--]]
function AutomationBridge._Tick()
  if not _running or _busy then
    return
  end
  if not _SenderReady() then
    _Schedule(1000)
    return
  end
  _busy = true
  _busySince = _Now()
  _lastTickAt = _busySince
  _nextDueAt = 0
  _tickCount = _tickCount + 1
  local gen = _gen
  local first = _firstPoll and "1" or "0"
  local url = string.format("%s/poll/%s/%s", _BASE, _sid, first)
  if _tickCount <= 5 or _tickCount % 60 == 0 then
    _TraceLife("轮询发出 #" .. tostring(_tickCount) .. " first=" .. first .. " sid=" .. tostring(_sid))
  end
  local sent = _SendGet(url, function(data)
    _busy = false
    _busySince = 0
    -- 引导脚本还原 `GlobalInitializerAndUpdater.Update` 的时点晚于插件加载，
    -- 所以备用帧驱动放在这里补装（响应回来时通常已过那一帧）
    if _G[_PUMP_KEY_GI] == nil then
      _InstallGlobalInitPump()
    end
    if _tickCount <= 3 then
      _TraceTimerState("响应后")
    end
    if _LuaTickLooksDead() then
      _TraceLife("判定每帧入口已被吞掉（newborn 不提升）→ 装修复型帧驱动")
      _InstallRepairPump()
    end
    if gen ~= _gen or not _running then
      return
    end
    if data == nil then
      _failures = _failures + 1
      _TraceLife("轮询响应不可解析（第 " .. tostring(_failures) .. " 次）")
      local backoff = _opts.pollIntervalMs * (2 ^ math.min(_failures, 4))
      _Schedule(math.min(backoff, 10000))
      return
    end
    _failures = 0
    _firstPoll = false
    local commands = data.commands
    if type(commands) ~= "table" or #commands == 0 then
      if _tickCount <= 5 or _tickCount % 60 == 0 then
        _TraceLife("轮询响应 OK（无命令）→ 排下一次")
      end
      _Schedule(tonumber(data.nextPollMs) or _opts.pollIntervalMs)
      return
    end
    _Trace("收到 " .. tostring(#commands) .. " 条命令")
    _TraceLife("轮询响应 OK，收到 " .. tostring(#commands) .. " 条命令")
    _RunBatch(gen, commands, 1, function()
      _Schedule(0)
    end)
  end)
  if not sent then
    _busy = false
    _busySince = 0
    _failures = _failures + 1
    _TraceLife("轮询未发出（UISender 异常）")
    _Schedule(1000)
  end
end

--[[
  把暂存的首次轮询补跑掉（驱动接通后调用；未就绪则原样留着，等下次触发）。
--]]
local function _FlushPending()
  if not _running or not _pendingKick then
    return
  end
  if _Timer() == nil then
    return
  end
  _pendingKick = false
  AutomationBridge._Tick()
end

--[[
  安装驱动钩子（幂等，可反复调用直到成功）。

  时序（官方 entry.lua 实测顺序）：
      require "Base/BaseModule"            -- ModelMgr / TimerModel 类表就位
      HotfixProcesser.Do(DefinedFix)       -- ★ 插件在这里加载，此时 TimerModel.me == nil
      InitFeature → ModelMgr.Init()        -- 各 model 实例化
                 → DlgMgr.Init(...)
                 → TimerModel.me:BindSwitcher(...)  -- 驱动接通，此后 Timer 才真的走
  所以要装两个钩子：
    - `ModelMgr.Init`：早于一切实例化，装到就一定能在模型就绪后补跑（**主力**）；
    - `TimerModel.BindSwitcher`：驱动接通的精确时点（与 PluginUI 的同类包装链式共存）。
  两者都只装一次，装不上（对应全局还不存在）就下次再试。
--]]
_InstallDriverHook = function()
  if not _modelHookInstalled then
    xpcall(function()
      if type(ModelMgr) ~= "table" or type(ModelMgr.Init) ~= "function" then
        return
      end
      _modelHookInstalled = true
      local orig = ModelMgr.Init
      ModelMgr.Init = function(...)
        orig(...)
        _InstallDriverHook()
        _FlushPending()
      end
    end, debug.traceback)
  end
  if not _driverHookInstalled then
    xpcall(function()
      if type(TimerModel) ~= "table" or type(TimerModel.BindSwitcher) ~= "function" then
        return
      end
      _driverHookInstalled = true
      local orig = TimerModel.BindSwitcher
      TimerModel.BindSwitcher = function(self, switcher)
        orig(self, switcher)
        _FlushPending()
      end
    end, debug.traceback)
  end
end

--[[
  帧驱动兜底：hotfix `LuaManager.Update`（C# `GlobalInitializerAndUpdater.Update`
  每帧调用它，见 reference/arknights-2.7.71-csharp/…/LuaManager.cs:184）。

  **为什么必须有这一层**：`ModelMgr.Init` / `TimerModel.BindSwitcher` 是「引导期刚好
  在场」才能装上的补排时点。而插件代码是**运行时经 HTTP 下发**的（`/plugin/lua`），
  晚于 `entry.lua` 的 `InitFeature`——两个钩子装上时对应调用早已过去，于是：
  第一次轮询（`Start()` 内直接发）之后**再没有任何东西驱动第二次**，
  并且第一次轮询的回调一旦丢失，`_busy` 就永久锁死。服务端只能看到一条 `/poll/<sid>/1`。

  这一层不依赖上述任何时序：只要 Lua 还在跑，它每帧都会看到
  「应到而未到」或「在途太久」，并把轮询补上。
  选 `LuaManager.Update` 而不是 `GlobalInitializerAndUpdater.Update`：后者已被
  插件引导脚本 hotfix 占着，且它拿到插件后会 `xlua.hotfix(…, orig)` 还原，
  会把我们后装的包装一起冲掉。

  幂等：包装只装一层，跨插件重载复用 `stamp.orig`（真·原方法），只换 `stamp.fn`。
--]]
_InstallFramePump = function()
  if _pumpInstalled then
    return true
  end
  if xlua == nil or xlua.hotfix == nil then
    _pumpLastError = "xlua.hotfix 不可用"
    _TraceLife("帧驱动安装失败: " .. tostring(_pumpLastError))
    return false
  end

  local tried = {}

  --[[
    C# 每帧入口的 xLua hotfix 候选当前**关闭**（对照实验用）。

    原因：装上 `LuaManager.Update` 后客户端停在启动早期（连资源下载都不开始），
    且纯 Lua 的 `TimerModel.Update` 包装一次都没触发 —— 与「hotfix 包装里
    调用捕获到的 orig 会再次进入 hotfix」的递归特征一致。先关掉这一路，
    观察「不装 C# hotfix 时 Lua tick 是否正常」，再决定怎么挂钩（见 docs）。
  ]]
  local HOTFIX_DRIVERS_ENABLED = false

  --[[
    挂一个候选：`cls[method]` 可读时链式包装（先调原方法再跑泵），不可读则跳过。
    每个候选第一次真正触发时落一行 —— 这一行是「登录阶段到底哪个每帧入口是活的」的判据。
  ]]
  local function hookCandidate(label, cls, method)
    local key = "__DTS_AB_DRV_" .. label
    if _G[key] ~= nil then
      return true
    end
    local ok, err = pcall(function()
      if cls == nil then
        error("类型不可达")
      end
      -- 私有方法 xLua 默认不可见：先开 private_accessible 再读，否则 orig 为 nil 就没法链式调用
      pcall(function()
        if xlua.private_accessible ~= nil then
          xlua.private_accessible(cls)
        end
      end)
      local orig = cls[method]
      if orig == nil then
        error("方法不可读（可能未注册/未生成）")
      end
      local fired = false
      _G[key] = { orig = orig }
      xlua.hotfix(cls, method, function(...)
        local s = _G[key]
        if s ~= nil and s.orig ~= nil then
          xpcall(s.orig, debug.traceback, ...)
        end
        if not fired then
          fired = true
          _driverFired = true
          _TraceLife("驱动触发: " .. label .. "（_pumpFrames=" .. tostring(_pumpFrames) .. "）")
        end
        xpcall(_FramePump, function(e)
          _TraceLife("驱动异常 " .. label .. ": " .. tostring(e))
        end)
      end)
    end, debug.traceback)
    tried[#tried + 1] = label .. "=" .. (ok and "已挂" or ("跳过(" .. tostring(err) .. ")"))
    return ok == true
  end

  if not HOTFIX_DRIVERS_ENABLED then
    tried[#tried + 1] = "C#每帧hotfix候选=已禁用(对照实验)"
  end

  -- 候选 1：GlobalInitializerAndUpdater.Update —— 客户端最外层的每帧入口
  -- （原生 hook 已实测它每帧都跑；插件引导脚本也用同一挂点做 /plugin/lua 重试）
  if HOTFIX_DRIVERS_ENABLED then
    pcall(function()
      hookCandidate("GlobalInitUpdate", CS.Torappu.GlobalInitializerAndUpdater, "Update")
    end)
    pcall(function()
      hookCandidate("LuaManagerUpdate", CS.Torappu.Lua.LuaManager, "Update")
    end)
    pcall(function()
      hookCandidate("TimeManagerTick", CS.Torappu.TimeManager, "Tick")
    end)
  end

  -- 候选 4：Lua 级猴子补丁 TimerModel.Update（不依赖 C# 桥；用来判断 Lua tick 是否在走）
  pcall(function()
    if type(TimerModel) == "table" and type(TimerModel.Update) == "function" then
      local key = "__DTS_AB_DRV_TimerModelUpdate"
      if _G[key] == nil then
        local orig = TimerModel.Update
        local fired = false
        _G[key] = { orig = orig }
        TimerModel.Update = function(self, ...)
          local s = _G[key]
          if s ~= nil and s.orig ~= nil then
            xpcall(s.orig, debug.traceback, self, ...)
          end
          if not fired then
            fired = true
            _TraceLife("驱动触发: TimerModelUpdate（Lua tick 在走）")
          end
          xpcall(_FramePump, function(e)
            _TraceLife("驱动异常 TimerModelUpdate: " .. tostring(e))
          end)
        end
        tried[#tried + 1] = "TimerModelUpdate=已挂"
      end
    else
      tried[#tried + 1] = "TimerModelUpdate=跳过(不可达)"
    end
  end)

  -- 只要有一个候选挂上就认为「帧驱动已装」；实际是否触发由 `驱动触发:` 那行回答
  _pumpInstalled = #tried > 0
  _TraceLife("帧驱动安装: " .. table.concat(tried, " | "))
  return _pumpInstalled
end

--[[
  备用帧驱动：hotfix `GlobalInitializerAndUpdater.Update`。

  风险已知：插件引导脚本（`scripts/inject-lua-inplace.ts` 注入的那段）也挂在同一方法上，
  并在 `/plugin/lua` 拿到插件后 `xlua.hotfix(cls, "Update", orig)` **还原**——它会连带
  冲掉我们这层包装。所以本函数只在「引导已还原之后」的时机调用才有效
  （由 `_Tick` 的响应回调 / `Kick` 触发），且它只是 `LuaManager.Update` 之外的第二条腿。
  @return 是否装上
--]]
_InstallGlobalInitPump = function()
  if _G[_PUMP_KEY_GI] ~= nil then
    return true
  end
  if _giPumpAttempts >= 3 then
    return false
  end
  _giPumpAttempts = _giPumpAttempts + 1  local ok, err = pcall(function()
    if xlua == nil or xlua.hotfix == nil then
      return
    end
    local cls = CS.Torappu.GlobalInitializerAndUpdater
    if cls == nil then
      return
    end
    pcall(function()
      if xlua.private_accessible ~= nil then
        xlua.private_accessible(cls)
      end
    end)
    if cls.Update == nil then
      return
    end
    local stamp = _G[_PUMP_KEY_GI]
    if type(stamp) == "table" and stamp.orig ~= nil then
      stamp.fn = _FramePump
      return
    end
    _G[_PUMP_KEY_GI] = { orig = cls.Update, fn = _FramePump }
    xlua.hotfix(cls, "Update", function(...)
      local s = _G[_PUMP_KEY_GI]
      if s == nil then
        return
      end
      if s.orig ~= nil then
        xpcall(s.orig, debug.traceback, ...)
      end
      if s.fn ~= nil then
        xpcall(s.fn, function(e)
          _TraceLife("备用帧驱动异常: " .. tostring(e))
        end)
      end
    end)
  end, debug.traceback)
  local installed = _G[_PUMP_KEY_GI] ~= nil
  _TraceLife("备用帧驱动安装 " .. (installed and "成功（GlobalInitializerAndUpdater.Update）" or ("失败: " .. tostring(err))))
  return installed
end

--[[
  「修复型」帧驱动：当判定客户端每帧入口已经被**吞掉**时，自己把它补回来。

  判定依据（三条同时成立）：
    1. 已经排过至少一个定时器，且 `TimerModel._newborn` 一直非空、`_timers` 为空
       —— 定时器进不了 `_timers` 说明 `TimerModel:Update` 根本没被调用；
    2. 任何驱动都没触发过（`_driverFired == false`）；
    3. 距离上次排期已超过 300ms（排除「同一帧内还没来得及提升」的假阳性）。

  为什么需要它：插件引导脚本（`scripts/inject-lua-inplace.ts` 注入的那段）会
  `local orig = CS.Torappu.GlobalInitializerAndUpdater.Update` —— 而
  `GlobalInitializerAndUpdater.Update` 是**私有方法**，xLua 对未生成类型不暴露实例方法，
  该表达式恒为 nil；于是它的包装 `if orig ~= nil then orig(...) end` 从不调用原实现，
  **整个全局每帧循环（`LuaManager.Update` → `EntryTable.Update` → `TimerModel:Update`）
  被静默吞掉**：Lua 定时器永不 tick、插件桥排期成功后不会再轮询。

  修复动作：在同一个方法上装我们自己的包装，把缺掉的那一环（Lua tick）显式调回来，
  再把桥的帧泵挂上去。因为只在「已确认 tick 死掉」时安装，不会覆盖正常运行的原实现。
--]]
_InstallRepairPump = function()
  if _repairPumpInstalled then
    return true
  end
  local ok, err = pcall(function()
    if xlua == nil or xlua.hotfix == nil then
      error("xlua.hotfix 不可用")
    end
    local cls = CS.Torappu.GlobalInitializerAndUpdater
    if cls == nil then
      error("GlobalInitializerAndUpdater 不可达")
    end
    local entry = CS.Torappu.Lua.LuaEntry
    if entry == nil then
      error("LuaEntry 不可达")
    end
    _G[_PUMP_KEY_REPAIR] = true
    xlua.hotfix(cls, "Update", function(self, ...)
      -- 补回原实现里被吞掉的那一环：`LuaManager.Update` 负责 Lua tick
      -- （`LuaEntry.Update`）、`LuaEnv.Tick()`（待处理回调/GC）与资源缓存清理
      xpcall(function()
        local lm = CS.Torappu.Lua.LuaManager
        if lm ~= nil and lm.Update ~= nil then
          lm.Update(CS.UnityEngine.Time.unscaledDeltaTime)
        end
      end, function(e)
        _TraceLife("LuaManager.Update 调用异常: " .. tostring(e))
      end)
      xpcall(_FramePump, function(e)
        _TraceLife("修复型帧驱动异常: " .. tostring(e))
      end)
    end)
    _repairPumpInstalled = true
  end, debug.traceback)
  if _repairPumpInstalled then
    _TraceLife("修复型帧驱动安装成功（已把被吞掉的 Lua tick 补回）")
  else
    _TraceLife("修复型帧驱动安装失败: " .. tostring(err))
  end
  return _repairPumpInstalled
end

--[[
  判定 Lua tick 是否已经被吞掉（见 `_InstallRepairPump` 的判据）。
  @return 布尔
--]]
_LuaTickLooksDead = function()
  if _driverFired then
    return false
  end
  if _tickProbeAt <= 0 or _tickProbeNewborn <= 0 then
    return false
  end
  -- 下限只用来排除「同一帧内还没来得及提升」：60fps 下 25ms 已是 1~2 帧
  if _Now() - _tickProbeAt < 25 then
    return false
  end
  local dead = false
  pcall(function()
    local me = TimerModel.me
    if me == nil or me._newborn == nil or me._timers == nil then
      return
    end
    -- 关键判据：**探针时刻的那批定时器**至今仍未被提升（数量没减、_timers 仍空）
    dead = #me._timers == 0 and #me._newborn >= _tickProbeNewborn
  end)
  return dead
end

--[[
  帧驱动主体（按帧节流到 ~10Hz）。两件事：

    1. 在途看门狗：`_busy` 超过 `cmd_timeout_ms`（至少 5s）仍无响应回调 ⇒ 判定回调
       丢失，解锁并让第 2 条规则立刻补跑。没有它，一次丢回调 = 桥永久静默。
    2. 排期兜底：`_nextDueAt` 已过 + 宽限仍没轮到 ⇒ 说明定时器排期/回调链失效，
       直接补跑一次轮询。

  超时用 `_Now()`（realtimeSinceStartup）而不是累加 dt，避免后台/掉帧时的漂移。
--]]
_FramePump = function()
  if not _running then
    return
  end
  _pumpFrames = _pumpFrames + 1
  -- 6 帧一次（60fps 下 ~10Hz）：看门狗不需要每帧判断，且别占启动期的帧预算
  if _pumpFrames % 6 ~= 0 then
    return
  end
  if not _pumpInstalled then
    _InstallFramePump()
  end
  local now = _Now()
  -- 心跳：每 ~10s 记一行状态，用于区分「驱动没跑」和「驱动跑了但没补跑」
  if _pumpFrames % 600 == 0 then
    _TraceLife(
      "帧驱动存活 n="
        .. tostring(_pumpFrames)
        .. " busy="
        .. tostring(_busy)
        .. " due="
        .. tostring(_nextDueAt)
        .. " last="
        .. tostring(_lastTickAt)
        .. " now="
        .. tostring(now)
    )
  end
  local timeout = math.max(5000, tonumber(_opts.cmdTimeoutMs) or 15000)
  if _busy and _busySince > 0 and now - _busySince > timeout then
    _TraceLife("在途轮询超时解锁: " .. tostring(now - _busySince) .. "ms（回调丢失）")
    _busy = false
    _busySince = 0
    _nextDueAt = 0
    _failures = _failures + 1
  end
  if _busy then
    return
  end
  local due = _nextDueAt
  if due > 0 and now > due + 1500 then
    _TraceLife("排期兜底补跑: overdue=" .. tostring(now - due) .. "ms")
    AutomationBridge._Tick()
  elseif due == 0 and _lastTickAt > 0
    and now - _lastTickAt > (tonumber(_opts.pollIntervalMs) or 1000) * 3 then
    _TraceLife("空闲兜底补跑: idle=" .. tostring(now - _lastTickAt) .. "ms")
    AutomationBridge._Tick()
  end
end

--------------------------------------------------------------------------------
-- 对外 API
--------------------------------------------------------------------------------

--[[
  注册一个命令处理器（同名后注册覆盖先注册）。
  @param name 命令名（与 MCP 工具一一对应，如 "client.state"）
  @param fn   function(args, ctx) -> table | AutomationBridge.ASYNC
--]]
function AutomationBridge.Register(name, fn)
  if name == nil or type(fn) ~= "function" then
    return
  end
  _handlers[tostring(name)] = fn
end

--[[
  批量注册。
  @param map { name = fn, ... }
--]]
function AutomationBridge.RegisterMany(map)
  if type(map) ~= "table" then
    return
  end
  for name, fn in pairs(map) do
    AutomationBridge.Register(name, fn)
  end
end

--[[
  注销命令处理器。
  @param name 命令名
--]]
function AutomationBridge.Unregister(name)
  if name ~= nil then
    _handlers[tostring(name)] = nil
  end
end

--[[
  清空处理器（插件停用时调用，避免停用后仍能被执行器触达）。
--]]
function AutomationBridge.ClearHandlers()
  _handlers = {}
end

--[[
  当前已注册的命令名（升序，便于对比/自检/上报能力清单）。
  @return 字符串数组
--]]
function AutomationBridge.Handlers()
  local names = {}
  for name in pairs(_handlers) do
    names[#names + 1] = name
  end
  table.sort(names)
  return names
end

--[[
  取/生成会话标识。

  格式 `<tag>_<平台>_<秒级时间戳 hex>`：可读、URL 安全、无随机数
  （**刻意不用 math.random**——改游戏侧 RNG 种子会影响战斗随机数）。
  @return 会话标识
--]]
function AutomationBridge.SessionId()
  if _sid == nil then
    local tag = tostring(_opts.sessionTag or "dts"):gsub("[^%w_%-]", "")
    if tag == "" then
      tag = "dts"
    end
    local platform = "unk"
    pcall(function()
      platform = tostring(CS.UnityEngine.Application.platform)
    end)
    platform = platform:gsub("[^%w]", "")
    _sid = string.format("%s_%s_%x", tag, platform, os.time() % 0xffffff)
  end
  return _sid
end

--[[
  应用配置（插件在 OnLoad 与选项变更时调用）。
  运行中改 `pollIntervalMs` 会在下一次排期生效，无需重启循环。
  @param opts { sessionTag, pollIntervalMs, cmdTimeoutMs, maxResultBytes, verbose }
--]]
function AutomationBridge.Configure(opts)
  if type(opts) ~= "table" then
    return
  end
  for key, value in pairs(opts) do
    if value ~= nil then
      _opts[key] = value
    end
  end
end

--[[
  当前配置快照（只读语义，供能力上报/自检）。
  @return 配置表
--]]
function AutomationBridge.Options()
  return {
    sessionTag = _opts.sessionTag,
    pollIntervalMs = _opts.pollIntervalMs,
    cmdTimeoutMs = _opts.cmdTimeoutMs,
    maxResultBytes = _opts.maxResultBytes,
    verbose = _opts.verbose,
  }
end

--[[
  启动轮询循环（幂等）。引导阶段 TimerModel 未就绪时登记待补排。
--]]
function AutomationBridge.Start()
  if _running then
    return
  end
  _running = true
  _busy = false
  _busySince = 0
  _nextDueAt = 0
  _lastTickAt = 0
  _firstPoll = true
  _failures = 0
  AutomationBridge.SessionId()
  _Log("自动化桥启动: sid=" .. tostring(_sid) .. " 处理器 " .. tostring(#AutomationBridge.Handlers()) .. " 个")
  _TraceLife(
    "启动: sid="
      .. tostring(_sid)
      .. " handlers="
      .. tostring(#AutomationBridge.Handlers())
      .. " timer="
      .. tostring(_Timer() ~= nil)
  )
  _InstallDriverHook()
  _InstallFramePump()
  _TraceTimerState("启动时")
  AutomationBridge._Tick()
end

--[[
  外部补跑入口：驱动钩子/兜底钩子触发时调用。

  存在的意义：引导阶段 `TimerModel.me` 还不存在，排不了定时器；如果 `ModelMgr.Init`
  包装恰好没装上（例如 `ModelMgr` 尚未 define），桥就会**静默不启动**——这是最难查的一类
  故障（服务端看不到任何轮询）。所以插件额外挂一个「必然晚于登录与网络就绪」的
  `UIController.Awake` 兜底，在那里调本函数。
--]]
function AutomationBridge.Kick()
  if not _running then
    return
  end
  _InstallDriverHook()
  _InstallFramePump()
  _InstallGlobalInitPump()
  _pendingKick = true
  _FlushPending()
end

--[[
  停止轮询循环：递增代际号让全部在途回调/定时器作废。
  ★ 释放语义：`LuaEnv.Dispose()` 时若还有 C# 持有的 Lua 回调会抛异常并 abort，
  所以插件 `OnUnload` 必须调它（见 docs/lua-plugin-dev-reference.md §2.2）。
--]]
function AutomationBridge.Stop()
  if not _running then
    return
  end
  _running = false
  _busy = false
  _busySince = 0
  _nextDueAt = 0
  _pendingKick = false
  _gen = _gen + 1
  _Log("自动化桥停止")
end

--[[
  是否在跑。
  @return 布尔
--]]
function AutomationBridge.IsRunning()
  return _running
end

--[[
  能力清单：给 `client.hello` 上报用（MCP 侧据此判断工具是否可用）。
  @return { protocol, sid, running, handlers }
--]]
function AutomationBridge.Capabilities()
  return {
    protocol = AutomationBridge.PROTOCOL,
    sid = _sid,
    running = _running,
    handlers = AutomationBridge.Handlers(),
  }
end

--[[
  读本地日志环形缓冲。
  @param limit 条数上限（缺省 50）
  @return { { seq, t, msg }, ... }
--]]
function AutomationBridge.Recent(limit)
  local n = tonumber(limit) or 50
  local out = {}
  for i = math.max(1, #_logBuf - n + 1), #_logBuf do
    out[#out + 1] = _logBuf[i]
  end
  return out
end

--[[
  记一条桥日志（供插件处理器写入可回读的自动化事件流）。
  @param msg 文本
--]]
function AutomationBridge.Log(msg)
  _Log(msg)
end

--[[
  发一个 GET 并把响应体解析成表后回调。
  详见 `_SendGet`（本函数是它对插件的导出形式）。
  @param url    请求路径
  @param onDone function(data, text)
  @return 是否真的发出
--]]
function AutomationBridge.Get(url, onDone)
  return _SendGet(url, onDone)
end

--[[
  排一个延迟回调（导出给插件复用，回调自动包成 Event 对象）。

  插件里凡是「先点一下、等一会儿、再点下一个」的异步命令都要走它：
  裸函数交给 `TimerModel:Delay` 会抛 `attempt to index a function value (field 'm_call')`
  并从定时器逸出 ⇒ 整个客户端 abort。
  @param sec 延迟秒
  @param fn  回调
  @return 是否排期成功（TimerModel 未就绪返回 false）
--]]
function AutomationBridge.Delay(sec, fn)
  local timer = _Timer()
  if timer == nil then
    return false
  end
  return pcall(function()
    timer:Delay(math.max(0.05, tonumber(sec) or 0.05), _AsTimerCallback(fn))
  end)
end

--[[
  base64url 编码（导出给插件复用，例如截图字节转文本）。
  @param data 原始字节串
  @return base64url 字符串（无 `=` 填充）
--]]
AutomationBridge.Base64Url = _Base64Url

--[[
  值安全化（导出给插件复用：把 Unity 对象/函数收敛成可序列化数据）。
  @param value 任意值
  @return 可 JSON 序列化的值
--]]
AutomationBridge.Sanitize = function(value)
  return _Safe(value, 0)
end

return AutomationBridge
