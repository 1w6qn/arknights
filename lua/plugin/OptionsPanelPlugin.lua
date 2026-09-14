--[[
  OptionsPanelPlugin.lua —— 插件选项面板插件

  游戏内动态构建「插件选项」面板：右下角浮动按钮开合，左侧插件页签，右侧按
  PluginOptions 的选项定义渲染控件（开关 / 数值加减 / 枚举左右切换），底部一键重置。
  改动即时写 plugin_config.json 并经 PluginHeartbeat.PushOption 同步服务端，
  插件侧通过 PluginOptions.Subscribe 实时重应用，无需重启游戏。

  时序：插件系统在 DefinedFix 引导阶段初始化（早于 Canvas 创建），故与 PanelPlugin 相同：
    - 立即尝试一次；
    - TimerModel 可用时按间隔重试（上限 _MAX_RETRY 次）；
    - 兜底 hook UIController.Awake（必然晚于主界面）时再尝试。
--]]
local OptionsPanelPlugin = Class("OptionsPanelPlugin", require("Plugin/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginUI = require("Plugin/PluginUI")
local PluginOptions = require("Plugin/PluginOptions")
local PluginDefs = require("Plugin/PluginDefs")
local PluginHeartbeat = require("Plugin/PluginHeartbeat")

local UnityEngine = CS.UnityEngine

-- 重试上限与间隔（TimerModel 可用时）
local _MAX_RETRY = 20
local _RETRY_DELAY_SEC = 3

-- 面板位置/尺寸：贴屏幕右侧，与 PanelPlugin（左侧）错开
local _PANEL_POS = UnityEngine.Vector3(340, 0, 0)
local _PANEL_SIZE = UnityEngine.Vector2(640, 480)
local _FLOAT_BTN_POS = UnityEngine.Vector3(-300, -90, 0)

-- 选项行高与首行 Y（相对选项区容器中心）
local _ROW_H = 56
local _ROW_TOP = 150

-- 配色
local _COLOR_PANEL = UnityEngine.Color(0.05, 0.05, 0.08, 0.94)
local _COLOR_TITLE = UnityEngine.Color(0.9, 0.9, 1, 1)
local _COLOR_LABEL = UnityEngine.Color(1, 1, 1, 1)
local _COLOR_DESC = UnityEngine.Color(0.65, 0.65, 0.65, 1)
local _COLOR_TAB_ON = UnityEngine.Color(0.3, 0.55, 1, 1)
local _COLOR_TAB_OFF = UnityEngine.Color(0.18, 0.18, 0.24, 0.9)
local _COLOR_STEP = UnityEngine.Color(0.25, 0.25, 0.32, 1)
local _COLOR_SWITCH_ON = UnityEngine.Color(0.3, 0.7, 1, 1)
local _COLOR_SWITCH_OFF = UnityEngine.Color(0.35, 0.35, 0.4, 1)
local _COLOR_RESET = UnityEngine.Color(0.5, 0.25, 0.25, 1)
local _COLOR_HINT = UnityEngine.Color(0.6, 0.6, 0.7, 1)

--[[
  按插件 id 取 PluginDefs 中的显示名（找不到回退 id）。
  @param id 插件标识
  @return 显示名
--]]
local function _PluginName(id)
  for _, def in ipairs(PluginDefs) do
    if def.id == id then return def.name end
  end
  return id
end

--[[
  数值格式化（优先用选项定义里的 format，失败回退 tostring）。
  @param def   选项定义
  @param value 数值
  @return 展示文本
--]]
local function _FormatNumber(def, value)
  if def.format ~= nil then
    local ok, s = pcall(string.format, def.format, value)
    if ok and type(s) == "string" then return s end
  end
  return tostring(value)
end

--[[
  枚举当前值在 choices 中的下标（找不到回退 1）。
  @param def   选项定义
  @param value 当前值
  @return 下标
--]]
local function _ChoiceIndex(def, value)
  local choices = def.choices or {}
  for i, choice in ipairs(choices) do
    if choice.value == value then return i end
  end
  return 1
end

--[[
  按步长在 choices 中循环取值（左右切换用）。
  @param def   选项定义
  @param value 当前值
  @param delta +1 / -1
  @return 新值
--]]
local function _CycleEnum(def, value, delta)
  local choices = def.choices or {}
  if #choices == 0 then return value end
  local i = _ChoiceIndex(def, value) + delta
  if i < 1 then i = #choices end
  if i > #choices then i = 1 end
  return choices[i].value
end

--[[
  枚举当前值的显示名。
  @param def   选项定义
  @param value 当前值
  @return 展示文本
--]]
local function _EnumLabel(def, value)
  local choices = def.choices or {}
  local choice = choices[_ChoiceIndex(def, value)]
  if choice ~= nil and choice.label ~= nil then return choice.label end
  return tostring(value)
end

--[[
  插件启用：建面板 + 兜底重试。
--]]
function OptionsPanelPlugin:OnLoad()
  self._open = false
  self._root = nil
  self._floatBtn = nil
  self._canvas = nil
  self._retryCount = 0
  self._selected = nil
  self._tabRoot = nil
  self._optRoot = nil
  self._footer = nil

  self:_EnsureCanvasAndBuild()

  -- 兜底：进入战斗 UI（必然晚于登录与主界面）时再次尝试构建
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    self:_EnsureCanvasAndBuild()
  end)
  eutil.Log("[OptionsPanelPlugin] 插件选项面板已启用")
end

--[[
  确保面板已构建：查找 Canvas，缺失则调度重试；已构建则无操作。
  根节点/按钮被销毁（场景切换）时自动重建。
--]]
function OptionsPanelPlugin:_EnsureCanvasAndBuild()
  if self._root ~= nil and self._floatBtn ~= nil then return end
  self._canvas = PluginUI.FindCanvas()
  if self._canvas == nil then
    PluginUI.RetryEnsure(self, _MAX_RETRY, _RETRY_DELAY_SEC)
    return
  end
  if self._floatBtn == nil then
    self._floatBtn = PluginUI.CreateFloatingButton(self._canvas, "选项", _FLOAT_BTN_POS, function()
      self:TogglePanel()
    end)
  end
  if self._root == nil then
    self:_BuildPanel()
  end
end

--[[
  构建面板骨架（标题 + 页签列 + 选项区 + 底部栏），初始隐藏。
--]]
function OptionsPanelPlugin:_BuildPanel()
  local root = PluginUI.CreateImage(self._canvas, "OptionsPanel(Clone)", _PANEL_POS, _PANEL_SIZE, _COLOR_PANEL)
  local title = PluginUI.CreateText(root.transform, "Title", UnityEngine.Vector3(0, _PANEL_SIZE.y / 2 - 26, 0), UnityEngine.Vector2(600, 36), 26, _COLOR_TITLE)
  title.alignment = UnityEngine.TextAnchor.MiddleCenter
  title.text = "插件选项"
  -- 三块独立容器：重建时只清各自子节点，标题与容器本身保留
  self._tabRoot = PluginUI.CreateContainer(root.transform, "Tabs", UnityEngine.Vector3(-230, -10, 0), UnityEngine.Vector2(150, 380))
  self._optRoot = PluginUI.CreateContainer(root.transform, "Options", UnityEngine.Vector3(70, -10, 0), UnityEngine.Vector2(440, 380))
  self._footer = PluginUI.CreateContainer(root.transform, "Footer", UnityEngine.Vector3(70, -(_PANEL_SIZE.y / 2 - 32), 0), UnityEngine.Vector2(440, 40))
  self._root = root
  self._root:SetActive(false)
  self:Refresh()
end

--[[
  重建页签 + 选项区 + 底部栏（开合、改值、重置后调用）。
--]]
function OptionsPanelPlugin:Refresh()
  if self._root == nil then return end
  self:_RefreshTabs()
  self:_RefreshOptions()
  self:_RefreshFooter()
end

--[[
  重建左侧插件页签（仅列出声明了选项的插件）。
--]]
function OptionsPanelPlugin:_RefreshTabs()
  PluginUI.ClearChildren(self._tabRoot)
  local entries = PluginOptions.Defs
  if self._selected == nil and entries[1] ~= nil then
    self._selected = entries[1].id
  end
  local y = 150
  for _, entry in ipairs(entries) do
    local color = (entry.id == self._selected) and _COLOR_TAB_ON or _COLOR_TAB_OFF
    PluginUI.CreateButton(self._tabRoot, "Tab_" .. entry.id, UnityEngine.Vector3(0, y, 0), UnityEngine.Vector2(140, 48), color, _PluginName(entry.id), 16, function()
      self._selected = entry.id
      self:Refresh()
    end)
    y = y - 58
  end
end

--[[
  重建右侧选项区：逐选项渲染「名称/说明 + 控件」。
--]]
function OptionsPanelPlugin:_RefreshOptions()
  PluginUI.ClearChildren(self._optRoot)
  local entry = PluginOptions:FindEntry(self._selected)
  if entry == nil then
    local empty = PluginUI.CreateText(self._optRoot, "Empty", UnityEngine.Vector3(0, 120, 0), UnityEngine.Vector2(420, 40), 18, _COLOR_DESC)
    empty.alignment = UnityEngine.TextAnchor.MiddleCenter
    empty.text = "无可用选项"
    return
  end
  local y = _ROW_TOP
  for _, def in ipairs(entry.options) do
    local label = PluginUI.CreateText(self._optRoot, "Label_" .. def.key, UnityEngine.Vector3(-120, y + 8, 0), UnityEngine.Vector2(200, 22), 18, _COLOR_LABEL)
    label.text = def.label
    if def.desc ~= nil then
      local desc = PluginUI.CreateText(self._optRoot, "Desc_" .. def.key, UnityEngine.Vector3(-120, y - 12, 0), UnityEngine.Vector2(200, 18), 12, _COLOR_DESC)
      desc.text = def.desc
    end
    if def.type == "switch" then
      self:_BuildSwitchRow(entry.id, def, y)
    elseif def.type == "number" then
      self:_BuildNumberRow(entry.id, def, y)
    elseif def.type == "enum" then
      self:_BuildEnumRow(entry.id, def, y)
    end
    y = y - _ROW_H
  end
end

--[[
  渲染开关控件。
  @param id  插件标识
  @param def 选项定义
  @param y   行 Y 坐标
--]]
function OptionsPanelPlugin:_BuildSwitchRow(id, def, y)
  local on = PluginOptions:Get(id, def.key) == true
  local color = on and _COLOR_SWITCH_ON or _COLOR_SWITCH_OFF
  PluginUI.CreateButton(self._optRoot, "Switch_" .. def.key, UnityEngine.Vector3(150, y, 0), UnityEngine.Vector2(96, 34), color, on and "已开启" or "已关闭", 16, function()
    self:_Commit(id, def.key, not on)
  end)
end

--[[
  渲染数值控件（− / 数值 / +，按 step 步进，Set 内做 min/max 夹取）。
  @param id  插件标识
  @param def 选项定义
  @param y   行 Y 坐标
--]]
function OptionsPanelPlugin:_BuildNumberRow(id, def, y)
  local value = PluginOptions:Get(id, def.key)
  local step = def.step or 1
  PluginUI.CreateButton(self._optRoot, "Minus_" .. def.key, UnityEngine.Vector3(96, y, 0), UnityEngine.Vector2(34, 34), _COLOR_STEP, "-", 20, function()
    self:_Commit(id, def.key, value - step)
  end)
  local text = PluginUI.CreateText(self._optRoot, "Value_" .. def.key, UnityEngine.Vector3(150, y, 0), UnityEngine.Vector2(72, 30), 18, _COLOR_LABEL)
  text.alignment = UnityEngine.TextAnchor.MiddleCenter
  text.text = _FormatNumber(def, value)
  PluginUI.CreateButton(self._optRoot, "Plus_" .. def.key, UnityEngine.Vector3(204, y, 0), UnityEngine.Vector2(34, 34), _COLOR_STEP, "+", 20, function()
    self:_Commit(id, def.key, value + step)
  end)
end

--[[
  渲染枚举控件（< / 当前项 / >，循环切换）。
  @param id  插件标识
  @param def 选项定义
  @param y   行 Y 坐标
--]]
function OptionsPanelPlugin:_BuildEnumRow(id, def, y)
  local value = PluginOptions:Get(id, def.key)
  PluginUI.CreateButton(self._optRoot, "Prev_" .. def.key, UnityEngine.Vector3(88, y, 0), UnityEngine.Vector2(34, 34), _COLOR_STEP, "<", 20, function()
    self:_Commit(id, def.key, _CycleEnum(def, value, -1))
  end)
  local text = PluginUI.CreateText(self._optRoot, "Value_" .. def.key, UnityEngine.Vector3(155, y, 0), UnityEngine.Vector2(100, 30), 16, _COLOR_LABEL)
  text.alignment = UnityEngine.TextAnchor.MiddleCenter
  text.text = _EnumLabel(def, value)
  PluginUI.CreateButton(self._optRoot, "Next_" .. def.key, UnityEngine.Vector3(222, y, 0), UnityEngine.Vector2(34, 34), _COLOR_STEP, ">", 20, function()
    self:_Commit(id, def.key, _CycleEnum(def, value, 1))
  end)
end

--[[
  重建底部栏：重置按钮 + 提示。
--]]
function OptionsPanelPlugin:_RefreshFooter()
  PluginUI.ClearChildren(self._footer)
  PluginUI.CreateButton(self._footer, "Reset", UnityEngine.Vector3(-120, 0, 0), UnityEngine.Vector2(120, 34), _COLOR_RESET, "重置本插件", 15, function()
    self:_ResetSelected()
  end)
  local hint = PluginUI.CreateText(self._footer, "Hint", UnityEngine.Vector3(95, 0, 0), UnityEngine.Vector2(300, 30), 13, _COLOR_HINT)
  hint.alignment = UnityEngine.TextAnchor.MiddleLeft
  hint.text = "改动即时生效并同步服务端"
end

--[[
  提交一次选项改动：写存储 → 推送服务端 → 重建面板刷新控件显示。
  @param id    插件标识
  @param key   选项键
  @param value 目标值（非法值被 PluginOptions 忽略）
--]]
function OptionsPanelPlugin:_Commit(id, key, value)
  local applied = PluginOptions:Set(id, key, value)
  if applied == nil then return end
  PluginHeartbeat.PushOption(id, key, applied)
  self:Refresh()
end

--[[
  重置当前插件全部选项为默认值，并把默认值同步到服务端。
--]]
function OptionsPanelPlugin:_ResetSelected()
  local id = self._selected
  if id == nil then return end
  PluginOptions:Reset(id)
  local snapshot = PluginOptions:Snapshot(id)
  for key, value in pairs(snapshot) do
    PluginHeartbeat.PushOption(id, key, value)
  end
  self:Refresh()
end

--[[
  开合面板（面板未构建时先尝试构建，失败则静默返回）。
  打开时重读磁盘配置（可拿到管理端刚写入的取值）并补发心跳。
--]]
function OptionsPanelPlugin:TogglePanel()
  if self._root == nil then
    self:_EnsureCanvasAndBuild()
    if self._root == nil then
      eutil.LogHotfixError("[OptionsPanelPlugin] 面板未构建，无法开合（Canvas 尚不可用）")
      return
    end
  end
  self._open = not self._open
  self._root:SetActive(self._open)
  if self._open then
    PluginOptions:Reload()
    self:Refresh()
    PluginHeartbeat.Send()
  end
end

--[[
  插件停用：销毁面板与浮动按钮。
--]]
function OptionsPanelPlugin:OnUnload()
  if self._root ~= nil then
    UnityEngine.Object.Destroy(self._root)
  end
  if self._floatBtn ~= nil then
    UnityEngine.Object.Destroy(self._floatBtn)
  end
  self._root = nil
  self._floatBtn = nil
  self._canvas = nil
  self._tabRoot = nil
  self._optRoot = nil
  self._footer = nil
  self._open = false
  eutil.Log("[OptionsPanelPlugin] 插件选项面板已停用")
end

return OptionsPanelPlugin
