--[[
  PluginEntry.lua —— 插件系统入口
  提供显式的 init()/dispose()，由 PluginBootHotfixer（挂进 DefinedFix 清单、
  经游戏原生 HotfixProcesser.Do 管线）在 OnInit 中调用。
  相比「包装 LuaEntry.Init」方案，直接调用更稳定，避免在 Init 执行期间重入。
--]]
local PluginEntry = {}
local eutil = CS.Torappu.Lua.Util

--[[
  初始化插件系统（按配置启停各插件）。
--]]
--[[
  安装「LuaEnv 释放/重载前先卸载插件」防护。

  为什么必须做：插件的 hotfix 会留下由 C# 持有的回调（DelegateBridge）。游戏一旦
  `LuaManager.ReloadScripts()` → `_DoDisposeLuaEnv()` → `LuaEnv.Dispose()`，xLua 会抛
  `InvalidOperationException: try to dispose a LuaEnv with C# callback!`，
  该异常逸出后**整个客户端 abort**（2.7.71 实测）。

  做法：热修 `LuaManager.ReloadScripts`（它的 `__Hotfix0_ReloadScripts` 是热修补点）：
  先把插件全部 `Unload()`（各插件经 PluginHotfix 撤销自己的 hotfix → 释放回调），
  再撤掉本包装器本身，最后调用原始实现。重载后 entry/hotfix 链会重跑，
  引导会重新初始化插件系统，因此这里不需要自己重建。
--]]
local _disposeGuardInstalled = false
local function _InstallDisposeGuard()
  if _disposeGuardInstalled then return end
  _disposeGuardInstalled = true
  xpcall(function()
    local M = CS.Torappu.Lua.LuaManager
    if M == nil or M.ReloadScripts == nil then return end
    local orig = M.ReloadScripts
    xlua.hotfix(M, "ReloadScripts", function()
      xpcall(function() PluginEntry.dispose() end, function() end)
      xpcall(function() xlua.hotfix(M, "ReloadScripts", nil) end, function() end)
      _disposeGuardInstalled = false
      if orig ~= nil then orig() end
    end)
  end, function() end)
end

function PluginEntry.init()
  PluginManager.me:Init()
  _InstallDisposeGuard()
  eutil.Log("[PluginEntry] Lua 插件系统初始化完成")
end

--[[
  释放插件系统（停用全部插件）。
--]]
function PluginEntry.dispose()
  for _, p in ipairs(PluginManager.me:GetAll()) do
    p:Unload()
  end
  eutil.Log("[PluginEntry] Lua 插件系统已释放")
end

return PluginEntry