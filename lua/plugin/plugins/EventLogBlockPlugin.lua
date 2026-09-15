--[[
  EventLogBlockPlugin.lua —— 官方日志/埋点上报截断插件

  目标：把官方的行为埋点与日志上报流量截断在客户端侧（私服不需要、也不该收到这些数据）。
  三条互补的拦截线（可分别开关，见 PluginOptions 的 event_log_block 选项）：

    1. 埋点源头（block_sdk，默认开）
       - Torappu.EventTrack.EventLogTrace._LogToSDK(eventName, data) —— 游戏内**唯一**的
         C# 埋点出口（内部调 Hypergryph.EventLogSDK 的 EventTrack）；
       - Torappu.SDK.SDKGameBI._IsSysEnabled() / _SetData(data, param) —— U8 GameBI
         上报入口（_IsSysEnabled 为 false 时 _SetData 整体短路）。
       说明：Hypergryph.EventLogSDK / Torappu.CryptUtils 这类**没有 xLua hotfix 桥**
       （无 __Hotfix0_ 委托字段）的类型无法挂 hotfix，故只能从游戏侧的调用方切。

    2. 上报请求（block_http，默认开）
       - Torappu.Network.Networker.SendGet / SendPost —— 命中上报路径时直接返回一个
         「已取消」的空结果，不产生任何出网流量。
       路径表按**精确路径**匹配（`/event` 不会误伤 `/deepSea/event`、`/rlv2/finishEvent`
       与 `/sandboxPerm/*/eventChoice` 等游戏接口）。

    3. SDK 心跳（pause_beat，默认开）
       - Hypergryph.SDK.HGEventLogSDKAppInstance.PauseBeat() + EnableRealTimeSend(false)
         —— 停止 SDK 定时批量心跳与实时上报。该类无 hotfix 桥，只能经 CS.* 直接调用
         （best-effort，pcall 兜底）。

  已知边界：
    - 埋点 SDK 的 data 层实现在 native（libHGEventlog.so）与 Java（com.hypergryph.eventlog）
      层，Lua 只能截断其**上游调用**；若某事件不经上述三个入口（如 Java 侧自采），
      本插件不覆盖。
    - 所有 hotfix 处理函数均自带兜底：判定失败时回退原实现，不让 Lua 异常逸出到 C# 回调
      （异常逸出会让整个客户端 abort，见 docs/lua-plugin-dev-reference.md §10）。

  依赖：Base/BaseModule（Class）、Plugin/core/BasePlugin、Plugin/core/PluginOptions。
--]]
local EventLogBlockPlugin = Class("EventLogBlockPlugin", require("Plugin/core/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginOptions = require("Plugin/core/PluginOptions")

-- 类级元数据（管理器/面板/管理端目录以此为准；与 PluginDefs.lua 保持一致）
EventLogBlockPlugin.id = "event_log_block"
EventLogBlockPlugin.name = "上报截断"
EventLogBlockPlugin.desc = "截断官方日志/埋点上报（EventLogSDK + GameBI + event 类 HTTP 请求）"

local _ID = "event_log_block"

--[[
  上报端点（**精确路径**匹配，去 query / 去 host / 去尾斜杠 / 小写后比较）。
  清单来源：docs/接口覆盖分析-未实现与stub清单.md §3.1（遥测/埋点 stub）与
  reference/opendoctoratepy-ex-public/server/constants.py 的 FILTER_PATHS_SET。
--]]
local REPORT_PATHS = {
  ["/event"] = true,
  ["/batch_event"] = true,
  ["/beat"] = true,
  ["/deviceprofile/v4"] = true,
  ["/analytics/collect"] = true,
  ["/gamebulletin"] = true,
  ["/loggw/logupload.do"] = true,
  ["/mgw.htm"] = true,
  ["/survey/startsurvey"] = true,
  ["/pb/async"] = true,
  ["/rqd/async"] = true,
}

-- 前缀匹配的上报路径（设备指纹 iedsafe 配置族）
local REPORT_PREFIXES = { "/iedsafe/" }

--[[
  提取 URL 的路径部分（去 scheme://host 与 query，去尾斜杠，转小写）。
  @param url 请求 URL（可能是绝对地址或裸路径）
  @return 规范化路径（异常 / 非字符串返回空串）
--]]
local function _PathOf(url)
  if type(url) ~= "string" then return "" end
  local s = url
  local q = s:find("?", 1, true)
  if q ~= nil then s = s:sub(1, q - 1) end
  local scheme = s:find("://", 1, true)
  if scheme ~= nil then
    local slash = s:find("/", scheme + 3, true)
    s = slash ~= nil and s:sub(slash) or "/"
  end
  s = s:gsub("/+$", "")
  return s:lower()
end

--[[
  是否命中上报路径（精确路径 + 前缀两类）。
  @param url 请求 URL
  @return 命中返回 true
--]]
local function _IsReportUrl(url)
  local path = _PathOf(url)
  if path == "" then return false end
  if REPORT_PATHS[path] == true then return true end
  for _, prefix in ipairs(REPORT_PREFIXES) do
    if path:sub(1, #prefix) == prefix then return true end
  end
  return false
end

--[[
  构造一个「已取消」的空网络结果（不发出任何请求）。
  @return WebHttpResult 实例（构造 / Cancel 失败时返回 nil）
--]]
local function _CancelledResult()
  local result = nil
  local ok = pcall(function()
    result = CS.Torappu.Network.WebHttpResult()
    result:Cancel()
  end)
  if not ok then return nil end
  return result
end

--[[
  从 hotfix 包装模式的实参里挑出 orig（链上下一段实现，恒为 function）。
  静态方法的约定在 xLua 各版本间有差异（可能带 self / 不带），故按类型识别而非位置。
  @param a 实参 1
  @param b 实参 2
  @return orig 或 nil
--]]
local function _PickOrig(a, b)
  if type(a) == "function" then return a end
  if type(b) == "function" then return b end
  return nil
end

--[[
  读取选项缓存并判开关（热路径不查配置）。
  兜底：`OnUnload` 先清 `_opts` 再注销补丁，中间窗口里的回调会读到 nil，
  这里统一按「关闭」处理（回退原实现），避免 Lua 异常逸出到 C# 回调。
  @param plugin 插件实例
  @param key    选项键
  @return 开启返回 true
--]]
local function _IsOn(plugin, key)
  local opts = plugin._opts
  return opts ~= nil and opts[key] == true
end

--[[
  插件启用：订阅选项、安装三条拦截线。
--]]
function EventLogBlockPlugin:OnLoad()
  self._opts = { block_sdk = true, block_http = true, pause_beat = true }

  self._onOption = PluginOptions.Subscribe(function(id)
    if id ~= _ID then return end
    local before = _IsOn(self, "pause_beat")
    self:_ApplyOptions()
    -- 心跳开关的开关动作需要显式下发，否则只有下次启动才生效
    if before ~= _IsOn(self, "pause_beat") then
      if _IsOn(self, "pause_beat") then self:_PauseBeat() else self:_ResumeBeat() end
    end
  end)
  self:_ApplyOptions()

  self:_InstallSdkHooks()
  self:_InstallHttpHooks()
  if _IsOn(self, "pause_beat") then self:_PauseBeat() end

  -- 晚启动兜底：UIController.Awake 必然晚于 SDK 初始化，届时补一次心跳暂停
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    if _IsOn(self, "pause_beat") then self:_PauseBeat() end
  end)

  eutil.Log("[EventLogBlockPlugin] 上报截断已启用")
end

--[[
  读取选项到 self._opts 缓存（热路径不查配置，见 docs/lua-plugin-dev-reference.md §4.3）。
--]]
function EventLogBlockPlugin:_ApplyOptions()
  self._opts = {
    block_sdk = PluginOptions:Get(_ID, "block_sdk") == true,
    block_http = PluginOptions:Get(_ID, "block_http") == true,
    pause_beat = PluginOptions:Get(_ID, "pause_beat") == true,
  }
end

--[[
  安装埋点源头补丁（EventLogTrace 与 SDKGameBI）。
  私有方法需先 xlua.private_accessible，否则 PluginHotfix 取不到目标（记「版本漂移」日志）。
--]]
function EventLogBlockPlugin:_InstallSdkHooks()
  pcall(function() xlua.private_accessible(CS.Torappu.EventTrack.EventLogTrace) end)
  pcall(function() xlua.private_accessible(CS.Torappu.SDK.SDKGameBI) end)

  -- 游戏侧唯一 C# 埋点出口；拦截后 EventLogSDK 收不到任何自定义事件
  self:Hotfix(CS.Torappu.EventTrack.EventLogTrace, "_LogToSDK", function(selfObj, orig, eventName, data)
    if _IsOn(self, "block_sdk") then return end
    return orig(selfObj, eventName, data)
  end)

  -- U8 GameBI 总开关（静态无参：orig 位置按类型识别）
  self:Hotfix(CS.Torappu.SDK.SDKGameBI, "_IsSysEnabled", function(a, b)
    if _IsOn(self, "block_sdk") then return false end
    local orig = _PickOrig(a, b)
    if orig == nil then return false end
    local ok, enabled = pcall(orig)
    if not ok then return false end
    return enabled == true
  end)

  -- GameBI 数据上报（_IsSysEnabled 之外的兜底，避免其它调用点绕过开关）
  self:Hotfix(CS.Torappu.SDK.SDKGameBI, "_SetData", function(selfObj, orig, data, param)
    if _IsOn(self, "block_sdk") then return end
    return orig(selfObj, data, param)
  end)
end

--[[
  安装上报请求补丁：命中上报路径直接返回已取消的空结果（不出网）。
  只挂钩返回 WebHttpResult 的同步入口；Yield* 返回 WebHttpInstruction，不在此处理。
--]]
function EventLogBlockPlugin:_InstallHttpHooks()
  local Networker = CS.Torappu.Network.Networker

  self:Hotfix(Networker, "SendGet", function(selfObj, orig, url, param)
    if _IsOn(self, "block_http") and _IsReportUrl(url) then
      local result = _CancelledResult()
      if result ~= nil then return result end
    end
    return orig(selfObj, url, param)
  end)

  self:Hotfix(Networker, "SendPost", function(selfObj, orig, url, ...)
    if _IsOn(self, "block_http") and _IsReportUrl(url) then
      local result = _CancelledResult()
      if result ~= nil then return result end
    end
    return orig(selfObj, url, ...)
  end)
end

--[[
  暂停埋点 SDK 心跳与实时上报（best-effort，异常仅记日志）。
--]]
function EventLogBlockPlugin:_PauseBeat()
  local ok, err = xpcall(function()
    CS.Hypergryph.SDK.HGEventLogSDKAppInstance.PauseBeat()
    CS.Hypergryph.SDK.HGEventLogSDKAppInstance.EnableRealTimeSend(false)
  end, debug.traceback)
  if not ok then
    eutil.Log("[EventLogBlockPlugin] PauseBeat 不可用（版本漂移?）: " .. tostring(err))
  end
end

--[[
  恢复埋点 SDK 心跳与实时上报（关闭 pause_beat 选项时调用）。
--]]
function EventLogBlockPlugin:_ResumeBeat()
  xpcall(function()
    CS.Hypergryph.SDK.HGEventLogSDKAppInstance.EnableRealTimeSend(true)
    CS.Hypergryph.SDK.HGEventLogSDKAppInstance.ResumeBeat()
  end, debug.traceback)
end

--[[
  插件停用：退订选项缓存（补丁由基类统一注销）。
--]]
function EventLogBlockPlugin:OnUnload()
  if self._onOption ~= nil then
    PluginOptions.Unsubscribe(self._onOption)
    self._onOption = nil
  end
  self._opts = nil
  eutil.Log("[EventLogBlockPlugin] 上报截断已停用")
end

return EventLogBlockPlugin
