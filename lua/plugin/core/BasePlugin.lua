--[[
  BasePlugin.lua —— 插件基类
  封装插件生命周期（Load/Unload）与统一打补丁入口，子类实现 OnLoad/OnUnload
  完成具体功能。所有异常用 xpcall 兜底并记日志。

  补丁机制（经 PluginHotfix 共享注册表，见 Plugin/core/PluginHotfix）：
    - 多插件 hook 同一 C# 方法时共享一个 xlua.hotfix 包装器，卸载互不干扰；
    - Fix_ex(cls, method, fixFunc)：完整替换，fixFunc(self, ...) 取代原方法；
    - Hotfix(cls, method, fixFunc)：包装模式，fixFunc(self, orig, ...)，
      orig 为链上下一段实现，可调 orig(self, ...) 保留原行为。
  两种模式均按 (cls, method) 注册到共享注册表，Unload / Load 失败时统一注销。

  须在 Base/BaseModule（提供 Class）之后加载。
--]]
local BasePlugin = Class("BasePlugin")
local eutil = CS.Torappu.Lua.Util
local PluginHotfix = require("Plugin/core/PluginHotfix")

--[[
  构造插件实例。
  @param id   插件唯一标识（如 "enemy_hp"，与 PluginDefs 一致）
  @param name 显示名（面板展示用）
  @param desc 描述（面板展示用）
--]]
function BasePlugin:ctor(id, name, desc)
  self.id = id
  self.name = name
  self.desc = desc
  self.enabled = false      -- 当前是否启用
  self._fixes = {}          -- 已注册补丁记录（{cls, method}），卸载/回滚时注销
end

--[[
  完整替换模式：fixFunc 取代原方法，不保留原调用。
  fixFunc 签名 = function(self, ...)，与 C# 方法签名一致。
  @param cls     C# 类型
  @param method  方法名
  @param fixFunc 替换实现
--]]
function BasePlugin:Fix_ex(cls, method, fixFunc)
  local ok, err = xpcall(function()
    if not PluginHotfix.FixEx(cls, method, self, fixFunc) then
      error("目标方法不存在（版本漂移?）: " .. tostring(method))
    end
    self._fixes[#self._fixes + 1] = { cls = cls, method = method }
  end, debug.traceback)
  if not ok then
    eutil.LogHotfixError("[BasePlugin] " .. self.id .. " Fix_ex(" .. method .. ") 失败: " .. err)
  end
end

--[[
  包装模式：fixFunc 经 orig 调用原方法。
  fixFunc 签名 = function(self, orig, ...)，orig 为链上下一段实现。
  @param cls     C# 类型
  @param method  方法名
  @param fixFunc 包装实现（function(self, orig, ...)）
--]]
function BasePlugin:Hotfix(cls, method, fixFunc)
  local ok, err = xpcall(function()
    if not PluginHotfix.Hotfix(cls, method, self, fixFunc) then
      error("目标方法不存在（版本漂移?）: " .. tostring(method))
    end
    self._fixes[#self._fixes + 1] = { cls = cls, method = method }
  end, debug.traceback)
  if not ok then
    eutil.LogHotfixError("[BasePlugin] " .. self.id .. " Hotfix(" .. method .. ") 失败: " .. err)
  end
end

--[[
  注销本插件注册的全部补丁（幂等）。共享注册表会移除本插件的处理函数；
  仅当无其它插件使用同一方法时才还原原方法，因此不会破坏其它插件的 hook。
--]]
function BasePlugin:_UnregisterAll()
  for _, fix in ipairs(self._fixes) do
    xpcall(function() PluginHotfix.Unfix(fix.cls, fix.method, self) end, debug.traceback)
  end
  self._fixes = {}
end

--[[
  启用插件：置 enabled 并调用 OnLoad。失败则回滚 enabled 并注销已注册补丁
  （避免 OnLoad 中途失败留下半应用的 hook）。
--]]
function BasePlugin:Load()
  if self.enabled then return end
  self.enabled = true
  local ok, err = xpcall(function() self:OnLoad() end, debug.traceback)
  if not ok then
    self.enabled = false
    self:_UnregisterAll()
    eutil.LogHotfixError("[BasePlugin] " .. self.id .. " OnLoad 失败: " .. err)
  end
end

--[[
  停用插件：调用 OnUnload 并注销全部已注册补丁。
  即使处于停用态也会清理残留补丁（防御 Load 失败等异常路径）。
--]]
function BasePlugin:Unload()
  if not self.enabled then
    self:_UnregisterAll()
    return
  end
  local ok, err = xpcall(function() self:OnUnload() end, debug.traceback)
  self.enabled = false
  self:_UnregisterAll()
  if not ok then
    eutil.LogHotfixError("[BasePlugin] " .. self.id .. " OnUnload 失败: " .. err)
  end
end

--[[
  子类覆盖：插件启用时执行（打补丁 / 建 UI）。
--]]
function BasePlugin:OnLoad() end

--[[
  子类覆盖：插件停用时执行（清理临时状态）。
--]]
function BasePlugin:OnUnload() end

return BasePlugin
