--[[
  UnityLogPlugin.lua —— Unity / 游戏日志采集回传插件（id: unity_log）

  目标：把**客户端运行期日志**（Unity 引擎日志 + 游戏自身日志）批量回传私服，
  落盘到 `data/plugin/logs/<sid>.ndjson`，供离线分析（崩溃现场、报错上下文、
  版本漂移的 hotfix 失败……）。私服本身看不到设备侧日志，这是唯一的回流通道。

  一、采集锚点：为什么是 `Torappu.FileLogger._OnCatchLog`
  ---------------------------------------------------------------------------
  1. Unity 侧唯一的托管日志出口是 `UnityEngine.Application.logMessageReceived`，
     但该事件在 Lua 侧**不可订阅**：
       - `UnityEngine.Application` 没有 xLua wrapper（`Application.LogCallback` 也未
         登记 CSharpCallLua）⇒ 无法从 Lua 注册委托；
       - `UnityEngine.Debug` / `Application` 所在程序集**没有 hotfix 桥**
         （CoreModule 的 `__Hotfix0_` 计数为 0，实测 dump）⇒ 也不能热修拦日志。
  2. 游戏自身订阅该事件的唯一实现是 `Torappu.FileLogger`（ctor 里
     `Application.logMessageReceived += _OnCatchLog`），它是 `IHotfixable`，
     `_OnCatchLog` 带 `__Hotfix0__OnCatchLog` 桥（私有方法，需先
     `xlua.private_accessible`，与 EventLogBlockPlugin / 官方 hotfixer 同款做法）。
  3. 但 `Torappu.DFLogger.InitIfNot`（唯一构造点）在游戏代码里**无人调用**——
     不主动建 sink 就永远收不到日志。因此本插件自己建：
     `CS.Torappu.DFLogger.InitIfNot(opts, "{0}/DTS-unity-{1}-{2}.log")`
     （未 gen 的类型/嵌套 struct 走 xLua 反射回退 `Utils.ReflectionWrap`）。
     顺带得到设备侧日志文件，必要时可直接 `adb pull`。

  二、回传协议（复用自动化桥验证过的「路径 + base64url 分片」通道）
  ---------------------------------------------------------------------------
    GET /plugin/log/ingest/<sid>/<batchId>/<seq>/<total>/<base64url chunk>
        JSON 信封 → base64url → 1800 字符切片顺序上传；服务端按 (sid,batchId) 拼回。
        为什么不走 POST body：`UISender.me:SendGet` 是唯一在真机上反复验证过的通道，
        且 base64url 字母表全是 RFC3986 非保留字符，无需百分号转义。
    信封（服务端 `plugin-log-store.ts` 解析）：
      { v=1, sid, seq, ts, dropped, device={...}, records={ {t,l,m,s,c}, ... } }
      t=毫秒时间戳 l=级别码(D/I/W/E) m=消息 s=堆栈(可选) c=连续重复次数(可选)

  三、纪律（都是踩过的坑）
  ---------------------------------------------------------------------------
    - 热路径**只碰纯 Lua 表**：不查选项不写文件不建对象，且整体 pcall 兜底——
      异常从 C# 日志回调逸出会让**整个客户端 abort**（见技能 arknights-lua-plugin-contracts）。
    - `_inHook` 重入闸门：绝不在日志回调里再打日志（否则 Debug.Log → 回调 → 日志 → 递归）。
    - 发送全部走 Pump（TimerModel 排期），不在回调里发请求。
    - 缓冲溢出丢最旧并记 `dropped`；服务端看得到丢了多少，不会误判成「日志断了」。
    - 同一条消息连续重复只累加计数，日志风暴（每帧刷屏）不会撑爆缓冲。
    - 每轮发送要么整批送出、要么整批回滚留在缓冲（未就绪时绝不丢）。

  依赖：Base/BaseModule（Class）、Plugin/core/BasePlugin、Plugin/core/PluginOptions、
        Plugin/core/AutomationBridge（Get/Delay/Base64Url/SessionId，均为已导出的稳定接口）。
--]]
local UnityLogPlugin = Class("UnityLogPlugin", require("Plugin/core/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginOptions = require("Plugin/core/PluginOptions")
local AutomationBridge = require("Plugin/core/AutomationBridge")

-- 类级元数据（管理器/面板/管理端目录以此为准；与 PluginDefs.lua 保持一致）
UnityLogPlugin.id = "unity_log"
UnityLogPlugin.name = "日志回传"
UnityLogPlugin.desc = "采集 Unity/游戏日志并批量回传私服（供离线分析）"

local _ID = "unity_log"
-- 回传端点前缀（服务端 app/ops/plugin/plugin-log.routes.ts，由 app/server.ts 挂载 /plugin/log）
local _INGEST_BASE = "/plugin/log/ingest"
-- 单片 base64url 字符数（与自动化桥同口径：真机验证过的路径长度）
local _MAX_CHUNK = 1800
-- 单片失败重发次数
local _MAX_CHUNK_RETRY = 1
-- 发送卡死判定（毫秒）：回调丢失时由 Pump 复位，避免永不再发
local _STALL_MS = 30 * 1000
-- 两次分片之间的最小间隔（秒）：避免瞬时打满 UISender 队列
local _CHUNK_GAP_SEC = 0.2
-- 采集速率上限（条/秒）：日志风暴时丢弃并计数，保护帧率
local _MAX_RECORDS_PER_SEC = 300
-- 诊断条数上限（随下一批上报）
local _DIAG_CAP = 20
-- 连续上传失败到该次数即**熔断**停发（见 `_Pump`）
-- 背景（2026-09-15 真机故障）：私服构建过旧、缺 `/plugin/log/ingest` 时，每轮 Pump 都 404，
-- 而游戏网络层对每个错误响应都会弹「网络请求失败，错误号404」——实测刷出 73 次请求 /
-- 4 个并存弹窗。调试设施不该把玩家界面刷爆，所以失败要退避、连续失败要停。
local _MAX_CONSECUTIVE_FAILS = 5
-- 退避上限（秒）
local _BACKOFF_MAX_SEC = 600

-- 级别索引（越大越严重）
local _LEVEL_INDEX = { debug = 0, info = 1, warning = 2, error = 3 }
local _LEVEL_CODE = { "D", "I", "W", "E" }
-- UnityEngine.LogType → 级别索引（Error=0 Assert=1 Warning=2 Log=3 Exception=4）
local _LOGTYPE_LEVEL = { [0] = 3, [1] = 3, [2] = 2, [3] = 1, [4] = 3 }
local _LOGTYPE_NAME = { [0] = "Error", [1] = "Assert", [2] = "Warning", [3] = "Log", [4] = "Exception" }
-- FileLogger.LogLevel：DEBUG=0 INFO=1 WARN=2 ERROR=3（设备侧日志文件级别）
local _SINK_LEVEL = { debug = 0, info = 1, warning = 2, error = 3 }

-- 选项生效值（热路径只读这张表，不查配置）
local _cfg = {
  min_level = 2,
  batch_size = 50,
  flush_sec = 5,
  max_buffer = 500,
  max_batch_bytes = 64 * 1024,
  msg_max_len = 800,
  include_stack = true,
  sink_file = true,
  sink_level = 3,
}

-- 采集缓冲（纯 Lua 表；日志回调不依赖插件实例）
local _buf = {}
-- 因缓冲溢出 / 速率限制丢弃的条数（随下一批上报）
local _dropped = 0
-- 上一条记录的去重键（连续重复合并）
local _lastKey = nil
-- 采集重入闸门：绝不在日志回调里再打日志
local _inHook = false
-- 速率窗口
local _rateWindow = 0
local _rateCount = 0
local _rateDropped = 0

-- 发送状态
local _sid = nil
local _nextSeq = 0
local _batchNo = 0
local _sending = false
local _sendingSince = 0
local _sendGen = 0
-- 在途批次（上传中断/超时兜底时整批回滚进缓冲，保证日志不丢）
local _inflight = nil

-- sink（FileLogger）与一次性诊断
local _sinkCreated = false
local _sinkNote = "未创建"
local _diag = {}
-- Pump 是否已排期（TimerModel 可能晚于引导阶段就绪，需就绪后补排）
local _pumpScheduled = false
local _pumpHooked = false
-- 连续上传失败计数 / 熔断标记（失败退避与停发，见 `_MAX_CONSECUTIVE_FAILS`）
local _failStreak = 0
local _pumpStopped = false

--------------------------------------------------------------------------------
-- 基础工具
--------------------------------------------------------------------------------

--[[
  单调时间（毫秒）：优先 Unity 引擎时间，不可用时回落 os.time。
  @return 毫秒时间戳
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
  惰性取 rapidjson（失败只探一次）。
  @return rapidjson 模块或 nil
--]]
local _rapidjson = nil
local _rapidjsonTried = false
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
  记录一条内部诊断（**不**写 Unity 日志，避免与采集回调递归）。
  诊断随下一批作为普通记录上报，服务端据此判断「sink 是否建起来」「丢了什么」。
  @param msg 文本
--]]
local function _Note(msg)
  if #_diag >= _DIAG_CAP then
    table.remove(_diag, 1)
  end
  _diag[#_diag + 1] = tostring(msg)
end

--[[
  取 LogType 对应的级别索引（兼容 xLua 把枚举推成数字或 userdata 两种口径）。
  @param logType UnityEngine.LogType
  @return 级别索引 0..3
--]]
local function _LevelOfLogType(logType)
  local ok, n = pcall(tonumber, logType)
  if ok and n ~= nil then
    return _LOGTYPE_LEVEL[n] or 1
  end
  local s = tostring(logType)
  for _, name in pairs(_LOGTYPE_NAME) do
    if s:find(name, 1, true) ~= nil then
      if name == "Warning" then return 2 end
      if name == "Log" then return 1 end
      return 3
    end
  end
  return 1
end

--[[
  速率闸门：超过窗口上限即丢弃（保护帧率）。
  @return 是否允许采集
--]]
local function _RateAllow()
  local sec = math.floor(_Now() / 1000)
  if sec ~= _rateWindow then
    _rateWindow = sec
    _rateCount = 0
  end
  if _rateCount >= _MAX_RECORDS_PER_SEC then
    _rateDropped = _rateDropped + 1
    return false
  end
  _rateCount = _rateCount + 1
  return true
end

--------------------------------------------------------------------------------
-- 采集（纯 Lua，热路径）
--------------------------------------------------------------------------------

--[[
  把一条日志推进缓冲（不做任何 C# 调用，除取时间戳）。
  @param level 级别索引 0..3
  @param msg   正文
  @param stack 堆栈或 nil
--]]
local function _Push(level, msg, stack)
  if type(msg) ~= "string" then
    msg = tostring(msg)
  end
  local limit = _cfg.msg_max_len
  if #msg > limit then
    msg = string.sub(msg, 1, limit) .. "…[+" .. tostring(#msg - limit) .. "B]"
  end
  local stk = nil
  if _cfg.include_stack and type(stack) == "string" and #stack > 0 then
    -- Unity 的 stackTrace 通常较长，截断到足以定位即可
    stk = string.sub(stack, 1, 1600)
  end

  -- 连续重复合并：同一 (级别, 正文) 只保留一条并累加计数（日志风暴保护）
  local key = _LEVEL_CODE[level + 1] .. "\1" .. msg
  if _lastKey == key and #_buf > 0 then
    local last = _buf[#_buf]
    last.c = (last.c or 1) + 1
    last.t = _Now()
    return
  end
  _lastKey = key

  if #_buf >= _cfg.max_buffer then
    table.remove(_buf, 1)
    _dropped = _dropped + 1
  end
  _buf[#_buf + 1] = { t = _Now(), l = _LEVEL_CODE[level + 1], m = msg, s = stk }
end

--[[
  采集一条 Unity 日志（C# 日志回调的入口；异常绝不外逸）。
  @param msg     日志正文（`logString`）
  @param stack   堆栈（`stackTrace`）
  @param logType UnityEngine.LogType
--]]
local function _Capture(msg, stack, logType)
  if _inHook then return end
  _inHook = true
  local ok, err = pcall(function()
    local level = _LevelOfLogType(logType)
    if level < _cfg.min_level then return end
    if not _RateAllow() then return end
    _Push(level, msg, stack)
  end)
  _inHook = false
  if not ok then
    _dropped = _dropped + 1
    if #_diag < _DIAG_CAP then
      _diag[#_diag + 1] = "[unity_log] 采集异常: " .. tostring(err)
    end
  end
end

--------------------------------------------------------------------------------
-- sink（FileLogger）：不建 sink 就收不到任何 Unity 日志
--------------------------------------------------------------------------------

--[[
  创建 Unity 日志 sink（幂等；成功后跨插件启停复用，避免每启用一次多开一个日志文件）。

  两级尝试：
    1. `CS.Torappu.DFLogger.InitIfNot(opts, fmt)` —— 走游戏单例，退出时
       `DFLogger.CloseIfNot()` 能正常 Dispose（不留悬挂实例）；
    2. 直接 `CS.Torappu.FileLogger(opts, fmt)` 并持引用防 GC（兜底）。
  `Options` 是嵌套值类型，经 xLua 反射回退构造与赋值；字段赋值失败只影响
  **设备侧文件**（本插件的 Lua 采集仍照常，因为 `_OnCatchLog` 一定会被调用）。

  @return sink 是否可用
--]]
local function _EnsureSink()
  if _sinkCreated then return true end
  local ok, err = pcall(function()
    local FileLogger = CS.Torappu.FileLogger
    local opts = FileLogger.Options()
    pcall(function()
      opts.logLevel = _cfg.sink_level
      opts.receiveUnityLog = _cfg.sink_file == true
      opts.autoFlush = true
    end)
    -- 文件名格式：{0}=persistentDataPath {1}=funcVer {2}=日期
    local fmt = "{0}/DTS-unity-{1}-{2}.log"
    local okInit = pcall(function()
      CS.Torappu.DFLogger.InitIfNot(opts, fmt)
    end)
    if okInit then
      UnityLogPlugin._sink = true
      _sinkNote = "DFLogger.InitIfNot"
    else
      UnityLogPlugin._sink = FileLogger(opts, fmt)
      _sinkNote = "FileLogger(直接构造)"
    end
  end)
  if not ok then
    _sinkNote = "创建失败: " .. tostring(err)
    _Note("[unity_log] Unity 日志 sink 创建失败（Lua 采集不可用）: " .. tostring(err))
    return false
  end
  _sinkCreated = true
  _Note("[unity_log] 日志 sink 已建立（" .. _sinkNote .. "）")
  return true
end

--[[
  按当前选项重建 sink（改文件级别/开关后生效）。
  先 CloseIfNot 释放旧的 StreamWriter 与回调，再重建。
--]]
local function _RebuildSink()
  if not _sinkCreated then
    _EnsureSink()
    return
  end
  pcall(function() CS.Torappu.DFLogger.CloseIfNot() end)
  _sinkCreated = false
  UnityLogPlugin._sink = nil
  _EnsureSink()
end

--------------------------------------------------------------------------------
-- 发送
--------------------------------------------------------------------------------

--[[
  设备信息（best-effort，全部 pcall：不同客户端字段可得性不同）。
  @return 表（至少含 platform）
--]]
local function _DeviceInfo()
  local info = {}
  pcall(function() info.platform = tostring(CS.UnityEngine.Application.platform) end)
  pcall(function() info.version = tostring(CS.UnityEngine.Application.version) end)
  pcall(function() info.model = tostring(CS.UnityEngine.SystemInfo.deviceModel) end)
  pcall(function() info.os = tostring(CS.UnityEngine.SystemInfo.operatingSystem) end)
  return info
end

--[[
  把一批记录放回缓冲头部（发送未发出时回滚，保证不丢日志）。
  缓冲已满时丢最尾（最新）的记录。
  @param records 记录数组（顺序同原缓冲）
--]]
local function _Requeue(records)
  for i = #records, 1, -1 do
    if #_buf >= _cfg.max_buffer then
      table.remove(_buf, #_buf)
      _dropped = _dropped + 1
    end
    table.insert(_buf, 1, records[i])
  end
end

--[[
  按字节预算摘出一批记录（至少 1 条），并从缓冲移除。
  @return 记录数组（可能为空）
--]]
local function _TakeBatch()
  if #_buf == 0 then return {} end
  local budget = _cfg.max_batch_bytes
  local maxCount = _cfg.batch_size
  local picked = {}
  local used = 0
  local n = 0
  for i = 1, #_buf do
    local rec = _buf[i]
    local size = #(rec.m or "") + #(rec.s or "") + 48
    if n > 0 and (used + size > budget or n >= maxCount) then break end
    used = used + size
    n = n + 1
    picked[n] = rec
  end
  local rest = {}
  for i = n + 1, #_buf do
    rest[#rest + 1] = _buf[i]
  end
  _buf = rest
  return picked
end

--[[
  延迟执行；TimerModel 未就绪时立即执行（发送链不能因为排期失败而断掉）。
  @param sec 延迟秒
  @param fn  回调
--]]
local function _Next(sec, fn)
  if sec > 0 and AutomationBridge.Delay(sec, fn) then
    return
  end
  fn()
end

--[[
  记一次**投递失败**（连续失败到阈值即熔断停发）。

  两条失败路径都要走这里，缺一条就止不住弹窗：
    ① `_Upload.finish(false)`：服务端返回非 0（如 404 端点缺失）；
    ② `_Pump` 里 30s 卡死复位：**错误响应不会触发 onProceed**，回调压根不来，
       只能靠超时复位发现——实测 404 走的正是这条路，只计 ① 时熔断永远不触发。
  @param where 失败来源（诊断用）
--]]
local function _NoteDeliveryFailure(where)
  _failStreak = _failStreak + 1
  if _failStreak >= _MAX_CONSECUTIVE_FAILS and not _pumpStopped then
    _pumpStopped = true
    _Note(
      "[unity_log] 连续 "
        .. tostring(_failStreak)
        .. " 次上传失败（"
        .. tostring(where)
        .. "；端点 "
        .. _INGEST_BASE
        .. " 不可用？）→ 已停止日志回传；服务端恢复后重载本插件即可复传"
    )
  end
end

--[[
  上传一批记录：JSON 信封 → base64url → 顺序发分片。

  @param records 记录数组（可为空表——只有诊断时也允许发一批）
  @return 是否**已发出第一片**；false 表示未就绪，调用方负责把记录回滚进缓冲
--]]
local function _Upload(records)
  local rj = _Json()
  if rj == nil or rj.encode == nil then
    _Note("[unity_log] rapidjson 不可用，丢弃一批日志（" .. tostring(#records) .. " 条）")
    return true
  end
  local payload = {}
  for i = 1, #records do
    payload[i] = records[i]
  end
  for _, d in ipairs(_diag) do
    payload[#payload + 1] = { t = _Now(), l = "I", m = d }
  end
  local envelope = {
    v = 1,
    sid = _sid,
    seq = _nextSeq,
    ts = os.time(),
    dropped = _dropped + _rateDropped,
    device = _DeviceInfo(),
    records = payload,
  }
  local okEnc, json = pcall(rj.encode, envelope)
  if not okEnc or type(json) ~= "string" then
    _Note("[unity_log] 信封编码失败，丢弃一批日志（" .. tostring(#records) .. " 条）")
    return true
  end

  _batchNo = _batchNo + 1
  local batchId = string.format("b%d", _batchNo)
  local b64 = AutomationBridge.Base64Url(json)
  local total = math.max(1, math.ceil(#b64 / _MAX_CHUNK))
  local seq = 0
  local gen = _sendGen
  local delivered = 0
  _sending = true
  _sendingSince = _Now()
  -- 在途批次（超时/未就绪时回滚重排，保证「要么整批送达、要么整批还在缓冲」）
  _inflight = records

  local function finish(ok)
    if gen ~= _sendGen then return end
    _sending = false
    local pending = _inflight
    _inflight = nil
    if ok then
      _dropped = 0
      _rateDropped = 0
      _diag = {}
      if _failStreak > 0 then
        _Note("[unity_log] 上传恢复（此前连续失败 " .. tostring(_failStreak) .. " 次）")
        _failStreak = 0
      end
      return
    end
    -- 失败：作废本轮（晚到的回调不再续发分片），整批回滚重排
    -- （服务端按 batchId 拼不齐会自动丢弃残片，重发不会重复落盘）
    _sendGen = _sendGen + 1
    if pending ~= nil then
      _Requeue(pending)
    end
    _Note(
      "[unity_log] 上传中断 batch="
        .. batchId
        .. " 已送达 "
        .. tostring(delivered)
        .. "/"
        .. tostring(total)
        .. "，剩余已回滚重排"
    )
    -- 连续失败计数 + 熔断（端点缺失/服务端过旧时继续重试只会刷「网络请求失败」弹窗）
    _NoteDeliveryFailure("服务端返回非 0")
  end

  local function step()
    if gen ~= _sendGen then return end
    seq = seq + 1
    if seq > total then
      finish(true)
      return
    end
    local chunk = string.sub(b64, (seq - 1) * _MAX_CHUNK + 1, seq * _MAX_CHUNK)
    local url = string.format("%s/%s/%s/%d/%d/%s", _INGEST_BASE, _sid, batchId, seq, total, chunk)
    local retried = 0
    local function onChunk(data)
      if data ~= nil and tonumber(data.status) == 0 then
        delivered = seq
        _Next(_CHUNK_GAP_SEC, step)
        return
      end
      if retried < _MAX_CHUNK_RETRY then
        retried = retried + 1
        seq = seq - 1
        _Next(_CHUNK_GAP_SEC, step)
        return
      end
      _Note(
        "[unity_log] 分片上传失败 batch=" .. batchId .. " seq=" .. tostring(seq) .. "/" .. tostring(total)
      )
      finish(false)
    end
    local sent = AutomationBridge.Get(url, onChunk)
    if not sent then
      _Note("[unity_log] UISender 未就绪，暂停上传（日志留在缓冲）")
      finish(false)
    end
  end

  -- 首片同步尝试：未就绪立刻回滚，等 Pump 下一轮（sendGen 作废后续回调）
  seq = 1
  local firstChunk = string.sub(b64, 1, _MAX_CHUNK)
  local firstUrl = string.format("%s/%s/%s/%d/%d/%s", _INGEST_BASE, _sid, batchId, 1, total, firstChunk)
  local sent = AutomationBridge.Get(firstUrl, function(data)
    if data ~= nil and tonumber(data.status) == 0 then
      delivered = 1
      _Next(_CHUNK_GAP_SEC, step)
      return
    end
    finish(false)
  end)
  if not sent then
    finish(false)
    return false
  end
  return true
end

--------------------------------------------------------------------------------
-- Pump（定时排期发送）
--------------------------------------------------------------------------------

--[[
  发送一轮：卡死复位 → 取批 → 上传（未就绪则回滚）。
--]]
local function _Pump()
  -- 熔断闸：连续失败到阈值后停发。放在这里而不是只在 `_SchedulePump` 里，
  -- 是因为 `Flush()` / 选项变更等路径也直接调 `_Pump`，只有入口统一才真的停下来。
  if _pumpStopped then
    return
  end
  if _sending and _Now() - _sendingSince > _STALL_MS then
    _sendGen = _sendGen + 1
    _sending = false
    local rollback = _inflight
    _inflight = nil
    if rollback ~= nil then
      _Requeue(rollback)
    end
    _Note(
      "[unity_log] 上传超时复位（回调丢失），在途 "
        .. tostring(rollback ~= nil and #rollback or 0)
        .. " 条已回滚重排"
    )
    -- 错误响应不会回调 onProceed，404/端点缺失只有这条超时路径能发现 ⇒ 必须在这里计数
    _NoteDeliveryFailure("回调丢失/错误响应无回调")
  end
  if _sending then return end
  if #_buf == 0 and #_diag == 0 then return end
  if _sid == nil then
    _sid = AutomationBridge.SessionId()
  end
  local records = _TakeBatch()
  local firstSeq = _nextSeq
  _nextSeq = _nextSeq + #records
  if not _Upload(records) then
    -- 只代表「这一批没发出去」（UISender 未就绪等）；真正的投递失败在 `_Upload.finish` 里计数
    _nextSeq = firstSeq
  end
end

--[[
  排 Pump 链（幂等）：每 flush_sec 一轮，链自续。
  TimerModel 未就绪（引导阶段）时返回 false，由战斗 UI 兜底 / 选项变更时补排。
  @return 是否已排期
--]]
local function _SchedulePump()
  if _pumpStopped then
    return false
  end
  if _pumpScheduled then return true end
  -- 失败退避：连续失败时按 2^n 拉长间隔（上限 _BACKOFF_MAX_SEC），避免"每轮都失败"
  local delay = _cfg.flush_sec
  if _failStreak > 0 then
    delay = math.min(_cfg.flush_sec * (2 ^ math.min(_failStreak, 6)), _BACKOFF_MAX_SEC)
  end
  local ok = AutomationBridge.Delay(delay, function()
    _pumpScheduled = false
    xpcall(_Pump, debug.traceback)
    _SchedulePump()
  end)
  if ok then
    _pumpScheduled = true
  end
  return ok
end

--------------------------------------------------------------------------------
-- 插件生命周期
--------------------------------------------------------------------------------

--[[
  读取选项到 `_cfg` 缓存（热路径不查配置）。
  @return sink 相关选项是否发生变化（需要重建 sink）
--]]
function UnityLogPlugin:_ApplyOptions()
  local beforeFile = _cfg.sink_file
  local beforeLevel = _cfg.sink_level
  local minLevel = PluginOptions:Get(_ID, "min_level")
  local sinkLevel = PluginOptions:Get(_ID, "sink_level")
  _cfg.min_level = _LEVEL_INDEX[tostring(minLevel)] or 2
  _cfg.sink_level = _SINK_LEVEL[tostring(sinkLevel)] or 3
  _cfg.batch_size = tonumber(PluginOptions:Get(_ID, "batch_size")) or 50
  _cfg.flush_sec = tonumber(PluginOptions:Get(_ID, "flush_sec")) or 5
  _cfg.max_buffer = tonumber(PluginOptions:Get(_ID, "max_buffer")) or 500
  _cfg.max_batch_bytes = (tonumber(PluginOptions:Get(_ID, "max_batch_kb")) or 64) * 1024
  _cfg.msg_max_len = tonumber(PluginOptions:Get(_ID, "msg_max_len")) or 800
  _cfg.include_stack = PluginOptions:Get(_ID, "include_stack") == true
  _cfg.sink_file = PluginOptions:Get(_ID, "sink_file") == true
  return _sinkCreated and (beforeFile ~= _cfg.sink_file or beforeLevel ~= _cfg.sink_level)
end

--[[
  安装采集补丁：热修 `Torappu.FileLogger._OnCatchLog`（私有方法，先 private_accessible）。
  同一方法其它插件也会包装，PluginHotfix 统一维护调用链，本插件只插一环。
--]]
function UnityLogPlugin:_InstallCapture()
  pcall(function() xlua.private_accessible(CS.Torappu.FileLogger) end)
  self:Hotfix(CS.Torappu.FileLogger, "_OnCatchLog", function(selfObj, orig, logString, stackTrace, logType)
    _Capture(logString, stackTrace, logType)
    return orig(selfObj, logString, stackTrace, logType)
  end)
end

--[[
  晚启动兜底：`UIController.Awake` 必然晚于引导阶段（网络/Timer/主 UI 就绪），
  在那里补排 Pump（与 PluginHeartbeat 同款时序假设）。
--]]
function UnityLogPlugin:_InstallPumpFallback()
  if _pumpHooked then return end
  _pumpHooked = true
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    xpcall(function()
      _SchedulePump()
      _Pump()
    end, debug.traceback)
  end)
end

--[[
  插件启用：订阅选项 → 建 sink → 装采集补丁 → 排上传 Pump。
--]]
function UnityLogPlugin:OnLoad()
  self:_ApplyOptions()

  -- 重载即视为"人工重试"：清掉上轮的失败退避/熔断状态（服务端修好后 reload 就能复传）
  _failStreak = 0
  _pumpStopped = false

  self._onOption = PluginOptions.Subscribe(function(id)
    if id ~= _ID then return end
    xpcall(function()
      local rebuild = self:_ApplyOptions()
      if rebuild then
        _RebuildSink()
      end
      _SchedulePump()
    end, debug.traceback)
  end)

  _EnsureSink()
  self:_InstallCapture()
  self:_InstallPumpFallback()

  xpcall(function()
    if _sid == nil then
      _sid = AutomationBridge.SessionId()
    end
    _SchedulePump()
  end, debug.traceback)

  eutil.Log("[UnityLogPlugin] 日志回传已启用（sink=" .. tostring(_sinkNote) .. "）")
end

--[[
  插件停用：退订 + 补发一轮后停止（补丁由基类统一注销）。
  刻意不 Dispose sink：设备侧日志文件保持可用，且游戏退出时会 `DFLogger.CloseIfNot()`。
--]]
function UnityLogPlugin:OnUnload()
  if self._onOption ~= nil then
    PluginOptions.Unsubscribe(self._onOption)
    self._onOption = nil
  end
  xpcall(function()
    _Pump()
  end, debug.traceback)
  _pumpScheduled = false
  eutil.Log("[UnityLogPlugin] 日志回传已停用")
end

--[[
  手动补发（供其它插件 / 自动化桥命令调用）。
--]]
function UnityLogPlugin.Flush()
  xpcall(_Pump, debug.traceback)
end

--[[
  采集一条自定义日志（供其它插件上报诊断信息，走同一条回传通道）。
  @param level debug|info|warning|error
  @param msg   文本
--]]
function UnityLogPlugin.Report(level, msg)
  if _inHook then return end
  _inHook = true
  pcall(function()
    _Push(_LEVEL_INDEX[tostring(level)] or 1, tostring(msg), nil)
  end)
  _inHook = false
end

return UnityLogPlugin
