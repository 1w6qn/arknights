--[[
  PluginHeartbeat.lua —— 插件生效确认心跳 + 服务端状态同步
  插件系统在游戏内构建 UI 后，经游戏原生 UISender 向服务端发送请求：
    - GET  /plugin/heartbeat  生效确认（响应含服务端启停状态，best-effort 应用）
    - GET  /plugin/config/<id>/<0|1>  客户端启停状态推送（路径编码，无需参数表约定）
  用于真机验证「插件是否真正加载生效」，并让管理端/面板的启停状态保持同步。

  时序说明：内置 bundle 由 DefinedFix 在 HotfixProcesser.Do 阶段引导（先于
  ModelMgr.Init / 网络就绪）。因此：
    - 引导阶段立即尝试一次；`_SendOnce` 只在**真的发出**时才回报成功，
      未就绪不会误标记已确认；
    - `ScheduleAuto` 必然装上进入战斗 UI 的 `UIController.Awake` 兜底（必然晚于
      登录与网络就绪）：那里补发心跳，并在 TimerModel 就绪后补排延迟重试链；
    - 面板打开时由 PanelPlugin 显式调用 Send() 再次确认。
  全程 xpcall 兜底，绝不阻断游戏。所有发送统一走 `UISender.me:`（官方实例方法，见
  data/[uc]lua/UISender.lua:65，内部依赖 self.m_callbacks 登记回调）。
--]]
local PluginHeartbeat = {}
local eutil = CS.Torappu.Lua.Util
local PluginHotfix = require("Plugin/PluginHotfix")

local _MAX_RETRY = 6
local _RETRY_DELAY_SEC = 5
-- 每会话自动确认只发一次（战斗 UI 兜底 / 重试链共用）
local _autoConfirmed = false

--[[
  解析心跳响应并应用服务端启停状态（best-effort）。
  响应体可能直接为 {catalog=...}，也可能被游戏网络层包一层 {result=...}。
  @param data 心跳响应数据
--]]
local function _OnHeartbeatResponse(data)
  xpcall(function()
    if data == nil then return end
    local body = data
    if type(data.result) == "table" then
      body = data.result
    end
    local catalog = body.catalog
    if type(catalog) ~= "table" then return end
    for _, p in ipairs(catalog) do
      if type(p) == "table" and p.id ~= nil then
        local enabled = (p.enabled == true)
        local cur = PluginManager.me:GetPlugin(tostring(p.id))
        if cur ~= nil and cur.enabled ~= enabled then
          PluginManager.me:SetEnabled(tostring(p.id), enabled)
        end
      end
    end
  end, debug.traceback)
end

--[[
  带回调的心跳发送（尝试应用服务端状态）。
  ⚠️ 必须 `UISender.me:SendGet`：官方 `UISender:SendGet(url,param,config)` 内部用 `self.m_callbacks`
  做请求登记（`data/[uc]lua/UISender.lua:65-79`），把类表当 self 会让回调永远不被调用
  （官方代码 51 处全部走 `.me`）。回调只认 `config.onProceed/onBlock/onFinal`。
  @param url 请求路径
  @param fn  响应回调
  @return 调用是否成功（不代表服务端已应答）
--]]
local function _SendWithCallback(url, fn)
  return pcall(function()
    UISender.me:SendGet(url, nil, { onProceed = fn, useMask = false })
  end)
end

--[[
  发送就绪判定：单例与实例方法都在位。
  @return UISender 是否可用于发送
--]]
local function _SenderReady()
  return UISender ~= nil and UISender.me ~= nil and UISender.me.SendGet ~= nil
end

--[[
  核心发送：向服务端发送确认（可选应用服务端启停状态）。
  @param applyServerState 是否尝试带回调发送并应用服务端状态
  @return 是否**真的发出了**请求（未就绪/调用失败都返回 false，避免调用方误标记已确认）
--]]
local function _SendOnce(applyServerState)
  if not _SenderReady() then
    eutil.LogHotfixError("[PluginHeartbeat] UISender 未就绪，跳过心跳")
    return false
  end
  if applyServerState then
    local ok = _SendWithCallback("/plugin/heartbeat", _OnHeartbeatResponse)
    if ok then
      eutil.Log("[PluginHeartbeat] 已向服务端发送插件生效确认（含状态同步）")
      return true
    end
  end
  local okFallback = pcall(function()
    UISender.me:SendGet("/plugin/heartbeat", nil, { useMask = false })
  end)
  if okFallback then
    eutil.Log("[PluginHeartbeat] 已向服务端发送插件生效确认")
  end
  return okFallback
end

--[[
  每会话一次的自动确认（重试链 / 战斗 UI 兜底共用）。
  仅当**真的发出**（`_SendOnce` 返回 true）才标记已确认，保证引导阶段失败后
  后续重试 / 战斗 UI 兜底仍能补发。
--]]
local function _AutoConfirm()
  if _autoConfirmed then return end
  if _SendOnce(true) then
    _autoConfirmed = true
  end
end

--[[ 延迟重试链是否已排（TimerModel 可能晚于引导阶段就绪，需要在其可用后补排）]]
local _retriesScheduled = false

--[[ 取 TimerModel 单例（未初始化返回 nil，不抛错）]]
local function _Timer()
  local ok, tm = pcall(function()
    if TimerModel ~= nil then return TimerModel.me end
    return nil
  end)
  if ok then return tm end
  return nil
end

--[[
  排延迟重试链：网络就绪前 `_AutoConfirm` 发不出去不会误标记，故这里反复重试直到成功。
  幂等——`ScheduleAuto` 与战斗 UI 兜底都会调用，只会排一次。
--]]
local function _ScheduleRetries()
  if _retriesScheduled or _autoConfirmed then return end
  local tm = _Timer()
  if tm == nil then return end
  _retriesScheduled = true
  local retries = 0
  local function retry()
    retries = retries + 1
    _AutoConfirm()
    local nextTimer = _Timer()
    if retries < _MAX_RETRY and nextTimer ~= nil then
      nextTimer:Delay(_RETRY_DELAY_SEC, retry)
    end
  end
  tm:Delay(_RETRY_DELAY_SEC, retry)
end

--[[
  安装战斗 UI 兜底确认：hook UIController.Awake（必然晚于登录与网络就绪），
  经共享注册表与其它插件同方法 hook 链式共存；_autoConfirmed 保证只确认一次。
  进入战斗 UI 时 TimerModel 通常已就绪 → 顺便补排延迟重试链。
--]]
local _battleHookInstalled = false
local function _InstallBattleConfirm()
  if _battleHookInstalled then return end
  _battleHookInstalled = true
  xpcall(function()
    PluginHotfix.Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", PluginHeartbeat, function(selfCtrl, orig)
      orig(selfCtrl)
      _AutoConfirm()
      _ScheduleRetries()
    end)
  end, debug.traceback)
end

--[[
  对外发送入口：立即发送一次并尝试应用服务端状态（面板打开等显式场景）。
  发送成功后标记自动确认已达成，避免战斗 UI 兜底重复发送。
--]]
function PluginHeartbeat.Send()
  if _SendOnce(true) then
    _autoConfirmed = true
  end
end

--[[
  自动确认：引导阶段调用。**必然**装上战斗 UI 兜底；TimerModel.me 已就绪则顺带排
  延迟重试链，未就绪（ModelMgr 尚未 Init）时由战斗 UI 兜底阶段补排（见 `_ScheduleRetries`）。
--]]
function PluginHeartbeat.ScheduleAuto()
  _InstallBattleConfirm()
  _AutoConfirm()
  _ScheduleRetries()
end

--[[
  客户端启停状态推送：面板切换插件后调用，best-effort 同步到服务端
  data/plugin/config.json（路径编码，避免依赖 UISender 参数表约定）。
  @param id    插件标识
  @param value true 启用 / false 停用
--]]
function PluginHeartbeat.PushState(id, value)
  xpcall(function()
    if not _SenderReady() then
      return
    end
    local v = value and "1" or "0"
    UISender.me:SendGet("/plugin/config/" .. tostring(id) .. "/" .. v, nil, { useMask = false })
  end, debug.traceback)
end

return PluginHeartbeat
