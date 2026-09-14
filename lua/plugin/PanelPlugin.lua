--[[
  PanelPlugin.lua —— 插件管理面板插件
  动态构建一个现代化管理面板：浮动开关按钮 + 插件列表（名称/描述/启停开关），
  通过 PluginManager:SetEnabled 实时启停插件。面板用 UnityEngine.UI 动态构建。
  各插件的可调参数在「选项」面板（Plugin/OptionsPanelPlugin，右下角「选项」按钮）里调节。

  时序说明：插件系统在 DefinedFix 引导阶段初始化（早于登录与主 UI 创建），
  此时 Canvas 尚不存在。因此 OnLoad 不直接构建，而是：
    - 立即尝试一次；
    - TimerModel 可用时按间隔重试（上限 _MAX_RETRY 次）；
    - 兜底 hook UIController.Awake（进入战斗 UI，必然晚于主界面）时再尝试。
  面板构建成功（或重建）后均会重新挂载，场景切换导致 Canvas 销毁时也能自愈。
--]]
local PanelPlugin = Class("PanelPlugin", require("Plugin/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginUI = require("Plugin/PluginUI")
local PluginHeartbeat = require("Plugin/PluginHeartbeat")

local UnityEngine = CS.UnityEngine
local UGUI = CS.UnityEngine.UI

-- 重试上限与间隔（TimerModel 可用时）
local _MAX_RETRY = 20
local _RETRY_DELAY_SEC = 3

-- 面板尺寸 / 行布局（6 个插件也能完整放下）
local _PANEL_SIZE = UnityEngine.Vector2(460, 520)
local _ROW_TOP = 190
local _ROW_STEP = 66

--[[
  插件启用：尝试构建面板；失败则延迟重试 + 战斗 UI 兜底。
--]]
function PanelPlugin:OnLoad()
  self._open = false
  self._root = nil
  self._floatBtn = nil
  self._canvas = nil
  self._listRoot = nil
  self._retryCount = 0

  self:_EnsureCanvasAndBuild()

  -- 兜底：进入战斗 UI（必然晚于登录与主界面）时再次尝试构建
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    self:_EnsureCanvasAndBuild()
  end)
  eutil.Log("[PanelPlugin] 插件管理面板已启用")
end

--[[
  确保面板已构建：查找 Canvas，缺失则调度重试；已构建则无操作。
  根节点/按钮被销毁（场景切换）时自动重建。
--]]
function PanelPlugin:_EnsureCanvasAndBuild()
  if self._root ~= nil and self._floatBtn ~= nil then return end
  self._canvas = PluginUI.FindCanvas()
  if self._canvas == nil then
    PluginUI.RetryEnsure(self, _MAX_RETRY, _RETRY_DELAY_SEC)
    return
  end
  if self._floatBtn == nil then
    self._floatBtn = PluginUI.CreateFloatingButton(self._canvas, "插件", UnityEngine.Vector3(-300, -160, 0), function()
      self:TogglePanel()
    end)
  end
  if self._root == nil then
    self:_BuildPanel()
  end
end

--[[
  构建面板主体（初始隐藏）。
--]]
function PanelPlugin:_BuildPanel()
  local root = PluginUI.CreateImage(self._canvas, "PluginPanel(Clone)", UnityEngine.Vector3(-260, 0, 0), _PANEL_SIZE, UnityEngine.Color(0.05, 0.05, 0.08, 0.92))
  local title = PluginUI.CreateText(root.transform, "Title", UnityEngine.Vector3(0, _PANEL_SIZE.y / 2 - 26, 0), UnityEngine.Vector2(440, 40), 26, UnityEngine.Color(0.9, 0.9, 1, 1))
  title.alignment = UnityEngine.TextAnchor.MiddleCenter
  title.text = "Lua 插件管理"
  -- 列表容器：重建只清容器子节点，标题得以保留
  -- （历史缺陷：直接在根节点上清空到 child 0，把标题一起删了）
  self._listRoot = PluginUI.CreateContainer(root.transform, "List", UnityEngine.Vector3.zero, UnityEngine.Vector2(420, 400))
  local hint = PluginUI.CreateText(root.transform, "Hint", UnityEngine.Vector3(0, -(_PANEL_SIZE.y / 2 - 22), 0), UnityEngine.Vector2(420, 30), 13, UnityEngine.Color(0.6, 0.6, 0.7, 1))
  hint.alignment = UnityEngine.TextAnchor.MiddleCenter
  hint.text = "各插件参数在右下角「选项」面板中调节"
  self._root = root
  self._root:SetActive(false)
  self:Refresh()
end

--[[
  重建插件列表（每次开合/启停后调用，保证状态实时）。
--]]
function PanelPlugin:Refresh()
  if self._root == nil or self._listRoot == nil then return end
  PluginUI.ClearChildren(self._listRoot)
  -- 逐插件渲染行（遍历 PluginDefs 以覆盖加载失败的插件）
  local mgr = PluginManager.me
  local trans = self._listRoot
  local y = _ROW_TOP
  for _, def in ipairs(PluginDefs) do
    local plugin = mgr:GetPlugin(def.id)
    local err = mgr:GetError(def.id)
    local rowBg, _ = PluginUI.CreateImage(trans, "Row", UnityEngine.Vector3(0, y, 0), UnityEngine.Vector2(420, 56), UnityEngine.Color(0.2, 0.2, 0.25, 0.6))
    local nameText = PluginUI.CreateText(rowBg.transform, "Name", UnityEngine.Vector3(-150, 14, 0), UnityEngine.Vector2(260, 24), 20, UnityEngine.Color(1, 1, 1, 1))
    nameText.text = def.name
    local descText = PluginUI.CreateText(rowBg.transform, "Desc", UnityEngine.Vector3(-150, -12, 0), UnityEngine.Vector2(260, 20), 13, UnityEngine.Color(0.7, 0.7, 0.7, 1))
    descText.text = err ~= nil and err or def.desc
    descText.color = err ~= nil and UnityEngine.Color(1, 0.5, 0.5, 1) or UnityEngine.Color(0.7, 0.7, 0.7, 1)
    -- 状态/错误标记
    local state = PluginUI.CreateText(rowBg.transform, "State", UnityEngine.Vector3(150, 14, 0), UnityEngine.Vector2(70, 24), 16, UnityEngine.Color(0.4, 1, 0.4, 1))
    state.alignment = UnityEngine.TextAnchor.MiddleCenter
    if plugin == nil then
      state.text = "ERR"
      state.color = UnityEngine.Color(1, 0.3, 0.3, 1)
    else
      state.text = plugin.enabled and "ON" or "OFF"
      state.color = plugin.enabled and UnityEngine.Color(0.4, 1, 0.4, 1) or UnityEngine.Color(1, 0.4, 0.4, 1)
    end
    -- 开关按钮（加载失败的插件无可启停对象，禁用）
    local btnObj, _ = PluginUI.CreateImage(rowBg.transform, "Toggle", UnityEngine.Vector3(150, -12, 0), UnityEngine.Vector2(64, 28), plugin == nil and UnityEngine.Color(0.4, 0.4, 0.4, 1) or UnityEngine.Color(0.3, 0.6, 1, 1))
    local btnText = PluginUI.CreateText(btnObj.transform, "Text", UnityEngine.Vector3.zero, UnityEngine.Vector2(64, 28), 14, UnityEngine.Color(1, 1, 1, 1))
    btnText.alignment = UnityEngine.TextAnchor.MiddleCenter
    btnText.text = "切换"
    if plugin ~= nil then
      local btn = btnObj:AddComponent(typeof(UGUI.Button))
      local pluginId = def.id
      local selfRef = self
      btn.onClick:AddListener(function()
        PluginManager.me:SetEnabled(pluginId, not plugin.enabled)
        selfRef:Refresh()
      end)
    end
    y = y - _ROW_STEP
  end
end

--[[
  开合面板（面板未构建时先尝试构建，失败则静默返回）。
--]]
function PanelPlugin:TogglePanel()
  if self._root == nil then
    self:_EnsureCanvasAndBuild()
    if self._root == nil then
      eutil.LogHotfixError("[PanelPlugin] 面板未构建，无法开合（Canvas 尚不可用）")
      return
    end
  end
  self._open = not self._open
  self._root:SetActive(self._open)
  if self._open then
    self:Refresh()
    -- 面板打开（登录后、网络就绪）时再次发送插件生效确认，作为可复现的服务端日志依据
    PluginHeartbeat.Send()
  end
end

--[[
  插件停用：销毁面板与浮动按钮。
--]]
function PanelPlugin:OnUnload()
  if self._root ~= nil then
    UnityEngine.Object.Destroy(self._root)
  end
  if self._floatBtn ~= nil then
    UnityEngine.Object.Destroy(self._floatBtn)
  end
  self._root = nil
  self._floatBtn = nil
  self._canvas = nil
  self._listRoot = nil
  self._open = false
  eutil.Log("[PanelPlugin] 插件管理面板已停用")
end

return PanelPlugin
