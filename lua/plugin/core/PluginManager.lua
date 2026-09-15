--[[
  PluginManager.lua —— 插件管理器（单例）
  按 PluginDefs 加载各插件，维护启用态与加载状态，并持久化到 persistentDataPath/plugin_config.json。
  提供 Init / GetPlugin / SetEnabled / GetAll 供面板与入口使用。
  单个插件加载失败不拖垮系统：记录错误状态，其余插件照常加载。
--]]
local PluginManager = Class("PluginManager")
local eutil = CS.Torappu.Lua.Util
-- 配置文件（plugin_config.json）读写收敛在 Plugin/core/PluginConfigFile：
-- 启停态与本插件系统之外写入的 options 字段必须互不覆盖（读 → 改 → 写）。
local PluginConfigFile = require("Plugin/core/PluginConfigFile")

-- 单例
PluginManager.me = nil

--[[
  构造插件管理器（仅创建一次）。
--]]
function PluginManager:ctor()
  self._plugins = {}        -- [id] = BasePlugin 实例（加载成功）
  self._defs = {}           -- [id] = 定义表
  self._errors = {}         -- [id] = 错误信息（加载失败）
  self._initialized = false
  self._uiEntryIds = nil    -- UI 入口插件 id 列表（惰性计算，见 _UiEntryIds）
end

--[[
  返回配置持久化路径（经 PluginConfigFile 计算并缓存）。
  @return 配置文件绝对路径
--]]
function PluginManager:_GetConfigPath()
  return PluginConfigFile.Path()
end

--[[
  读取持久化的启用态配置；文件不存在、依赖不可用或解析失败时返回全启用默认值。
  @return table：[id] = bool
--]]
function PluginManager:_ReadConfig()
  local cfg = PluginConfigFile.Read()
  local stored = cfg.enabled
  local enabled = {}
  for _, def in ipairs(PluginDefs) do
    local value = nil
    if type(stored) == "table" then value = stored[def.id] end
    enabled[def.id] = (value == nil) and true or (value == true) -- 缺省全部启用
  end
  return enabled
end

--[[
  把启用态配置写入磁盘（幂等；依赖不可用或写入失败仅静默，不阻断业务）。
  经 PluginConfigFile.Update 读 → 改 → 写：既有配置（含加载失败插件的历史状态、
  以及 PluginOptions 负责的 options 字段）原样保留，只覆盖当前插件的启用态。
--]]
function PluginManager:_SaveConfig()
  PluginConfigFile.Update(function(cfg)
    if type(cfg.enabled) ~= "table" then cfg.enabled = {} end
    for defId, plugin in pairs(self._plugins) do
      cfg.enabled[defId] = plugin.enabled
    end
  end)
end

--[[
  UI 入口插件 id 列表（PluginDefs 里 `ui_entry = true` 的那些）。

  ★ 为什么必须有这个概念：这类插件提供**游戏内**的面板与浮窗按钮，也是玩家在游戏里
  启停插件的唯一途径。实测故障（2026-09-15）：`plugin_panel` 与 `options_panel` 都被
  配置成停用后，游戏内再没有任何入口能把它们调出来（浮动按钮随插件卸载一起销毁），
  只能手改配置文件或走服务端。约定：**任何时刻至少保留一个入口启用**。

  清单里一个都没标时回退到「插件管理面板」——漏标也不能让游戏失去入口。
  @return 插件 id 数组
--]]
function PluginManager:_UiEntryIds()
  if self._uiEntryIds == nil then
    local ids = {}
    for _, def in ipairs(PluginDefs) do
      if def.ui_entry == true then
        ids[#ids + 1] = def.id
      end
    end
    if #ids == 0 then
      ids = { "plugin_panel" }
    end
    self._uiEntryIds = ids
  end
  return self._uiEntryIds
end

--[[
  UI 入口插件 id 列表（对外只读语义，供面板/自动化工具查询）。
  @return 插件 id 数组
--]]
function PluginManager:UiEntryIds()
  return self:_UiEntryIds()
end

--[[
  是否 UI 入口插件。
  @param id 插件标识
  @return 是入口返回 true
--]]
function PluginManager:IsUiEntry(id)
  for _, entryId in ipairs(self:_UiEntryIds()) do
    if entryId == id then
      return true
    end
  end
  return false
end

--[[
  当前处于启用态的 UI 入口插件数量。
  @return 数量
--]]
function PluginManager:_EnabledUiEntryCount()
  local n = 0
  for _, id in ipairs(self:_UiEntryIds()) do
    local plugin = self._plugins[id]
    if plugin ~= nil and plugin.enabled then
      n = n + 1
    end
  end
  return n
end

--[[
  能否停用某插件（**入口守卫**）。
  非入口插件一律可停；入口插件只有在「还有别的入口处于启用态」时才能停。
  面板据此把最后一个入口渲染成「常驻」而不是开关。
  @param id 插件标识
  @return 允许停用返回 true
--]]
function PluginManager:CanDisable(id)
  local plugin = self._plugins[id]
  if plugin == nil then
    return false
  end
  if not self:IsUiEntry(id) then
    return true
  end
  return self:_EnabledUiEntryCount() > 1
end

--[[
  初始化插件系统：按 PluginDefs 加载并依据配置启停各插件。
  单个插件 require/实例化/初始化失败时记录错误到 _errors，其余插件照常加载（可重复调用，幂等）。
--]]
function PluginManager:Init()
  if self._initialized then return end
  self._initialized = true
  local enabled = self:_ReadConfig()
  for _, def in ipairs(PluginDefs) do
    local mod
    local ok, err = pcall(function() mod = require(def.module) end)
    if not ok then
      self._errors[def.id] = "模块加载失败: " .. tostring(err)
      eutil.LogHotfixError("[PluginManager] 加载插件模块失败 " .. def.module .. ": " .. tostring(err))
    else
      local okNew, plugin = pcall(function() return mod.new(def.id, def.name, def.desc) end)
      if not okNew then
        self._errors[def.id] = "实例化失败: " .. tostring(plugin)
      else
        self._plugins[def.id] = plugin
        self._defs[def.id] = def
        if enabled[def.id] then
          local okLoad, loadErr = pcall(function() plugin:Load() end)
          if not okLoad then
            self._errors[def.id] = "初始化失败: " .. tostring(loadErr)
          end
        end
      end
    end
  end
  self:_EnsureUiEntry()
  eutil.Log("[PluginManager] 初始化完成，共 " .. self:_Count() .. " 个插件，失败 " .. self:_ErrorCount() .. " 个")
end

--[[
  入口自愈：配置里把所有 UI 入口都关了（历史死锁配置）时，强制打开第一个入口。

  为什么放在 Init 而不是指望面板：入口插件停用后它的 `OnLoad` 根本不会跑，
  游戏内没有任何代码能替玩家点那个开关——只能在启动阶段纠正。
  @return 被强制启用的插件 id；无需纠正返回 nil
--]]
function PluginManager:_EnsureUiEntry()
  if self:_EnabledUiEntryCount() > 0 then
    return nil
  end
  local fallback = self:_UiEntryIds()[1]
  local plugin = self._plugins[fallback]
  if plugin == nil then
    return nil
  end
  eutil.LogHotfixError(
    "[PluginManager] UI 入口插件全部处于停用态（配置死锁）→ 强制启用 " .. tostring(fallback)
  )
  pcall(function() plugin:Load() end)
  self:_SaveConfig()
  self:_PushState(fallback, true)
  return fallback
end

--[[
  把某插件的启用态 best-effort 推回服务端（未就绪时静默跳过）。
  @param id    插件标识
  @param value true 启用 / false 停用
--]]
function PluginManager:_PushState(id, value)
  if PluginHeartbeat ~= nil and PluginHeartbeat.PushState ~= nil then
    pcall(function() PluginHeartbeat.PushState(id, value) end)
  end
end

--[[
  返回已加载（成功）插件数量。
  @return 数量
--]]
function PluginManager:_Count()
  local n = 0
  for _ in pairs(self._plugins) do n = n + 1 end
  return n
end

--[[
  返回加载失败插件数量。
  @return 数量
--]]
function PluginManager:_ErrorCount()
  local n = 0
  for _ in pairs(self._errors) do n = n + 1 end
  return n
end

--[[
  按 id 获取插件实例；不存在返回 nil。
  @param id 插件标识
  @return 插件实例或 nil
--]]
function PluginManager:GetPlugin(id)
  return self._plugins[id]
end

--[[
  查询插件加载错误信息；未失败返回 nil。
  @param id 插件标识
  @return 错误信息或 nil
--]]
function PluginManager:GetError(id)
  return self._errors[id]
end

--[[
  返回全部插件实例列表（保持 PluginDefs 顺序，仅含加载成功的插件）。
  @return 插件实例数组
--]]
function PluginManager:GetAll()
  local list = {}
  for _, def in ipairs(PluginDefs) do
    local p = self._plugins[def.id]
    if p ~= nil then
      list[#list + 1] = p
    end
  end
  return list
end

--[[
  启停指定插件并持久化配置，随后 best-effort 同步到服务端
  （经 PluginHeartbeat.PushState，路径编码 GET，见 Plugin/core/PluginHeartbeat）。

  ★ 入口守卫：拒绝停用「最后一个启用中的 UI 入口插件」（见 `CanDisable`）。
  被拒时不仅不改本地状态，还会把**实际仍为启用**的状态推回服务端——否则服务端配置
  与客户端会来回打架（心跳下发 OFF → 本地拒绝 → 下一轮又下发 OFF）。
  @param id    插件标识
  @param value true 启用 / false 停用
  @return 是否真的应用了该变更（被守卫拒绝返回 false）
--]]
function PluginManager:SetEnabled(id, value)
  local plugin = self._plugins[id]
  if plugin == nil then return false end
  if value ~= true and plugin.enabled and not self:CanDisable(id) then
    eutil.LogHotfixError(
      "[PluginManager] 拒绝停用 UI 入口插件 " .. tostring(id) .. "：需至少保留一个入口（见 CanDisable）"
    )
    self:_PushState(id, true)
    return false
  end
  if value == true then
    plugin:Load()
  else
    plugin:Unload()
  end
  self:_SaveConfig()
  self:_PushState(id, value == true)
  return true
end

--[[
  重载插件（先停后启，用于验证释放路径 / 让改动即时生效）。

  ★ 刻意**绕过入口守卫**：整个「停 → 起」在同一次调用内完成，不存在入口缺失的可见窗口。
  否则最后一个入口面板的 reload 会被守卫拒绝停用，静默退化成空操作。
  @param id 插件标识
  @return 是否重载（插件不存在返回 false）
--]]
function PluginManager:Reload(id)
  local plugin = self._plugins[id]
  if plugin == nil then return false end
  plugin:Unload()
  plugin:Load()
  self:_SaveConfig()
  self:_PushState(id, plugin.enabled == true)
  return true
end

-- 创建单例
PluginManager.me = PluginManager.new()

return PluginManager