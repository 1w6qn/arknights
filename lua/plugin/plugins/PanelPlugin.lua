--[[
  PanelPlugin.lua —— 插件管理面板插件
  动态构建一个现代化管理面板：浮动开关按钮 + 插件列表（名称/描述/启停开关），
  通过 PluginManager:SetEnabled 实时启停插件。面板用 UnityEngine.UI 动态构建。
  各插件的可调参数在「选项」面板（Plugin/plugins/OptionsPanelPlugin，浮动「选项」按钮）里调节。

  时序说明：插件系统在官方 entry.lua 的 HotfixProcesser.Do 阶段初始化，早于 ModelMgr.Init
  与主 UI 创建——此时 TimerModel.me 尚未就绪、Canvas 通常也不存在。因此 OnLoad 不直接依赖
  「一次成功」，而是：
    - 立即尝试一次；
    - 交给 PluginUI 的自愈链：TimerModel 未就绪时登记待补排，驱动接通（BindSwitcher）后
      按间隔重试，建成后转低频巡检（场景切换销毁面板/Canvas 时自动重建）；
    - 兜底 hook UIController.Awake（进入战斗 UI，必然晚于主界面）时再尝试。
--]]
local PanelPlugin = Class("PanelPlugin", require("Plugin/core/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginUI = require("Plugin/ui/PluginUI")
local PluginHeartbeat = require("Plugin/core/PluginHeartbeat")

-- 插件标识（与 PluginDefs.lua 一致；本面板自身就是一个 UI 入口，用于自排除）
local _ID = "plugin_panel"

local UnityEngine = CS.UnityEngine
local UGUI = CS.UnityEngine.UI

-- 建成前的重试上限与间隔（TimerModel 驱动接通后自愈链按此节奏跑；建成后转低频巡检不计次）
local _MAX_RETRY = 100
local _RETRY_DELAY_SEC = 3

-- 面板尺寸 / 行布局（6 个插件也能完整放下）
local _PANEL_SIZE = UnityEngine.Vector2(460, 520)
local _ROW_TOP = 190
local _ROW_STEP = 66

--[[
  插件启用：尝试构建面板并启动自愈链（Canvas 未就绪 / 场景切换销毁都能自动重建）。
--]]
function PanelPlugin:OnLoad()
  self._open = false
  self._root = nil
  self._floatBtn = nil
  self._canvas = nil
  self._listRoot = nil
  self._hint = nil
  self._retryActive = false

  self:_EnsureCanvasAndBuild()
  -- 自愈链：TimerModel 就绪前登记待补排，就绪后按间隔重试/巡检
  PluginUI.RetryEnsure(self, _MAX_RETRY, _RETRY_DELAY_SEC)

  -- 兜底：进入战斗 UI（必然晚于登录与主界面）时再次尝试构建
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    self:_EnsureCanvasAndBuild()
  end)
  eutil.Log("[PanelPlugin] 插件管理面板已启用")
end

--[[
  确保面板已构建：先按存活状态清理被场景切换销毁的引用，再查找 Canvas 重建；
  Canvas 缺失时由 PluginUI 的自愈链继续重试。
--]]
function PanelPlugin:_EnsureCanvasAndBuild()
  if not PluginUI.IsAlive(self._root) then
    self._root = nil
    self._listRoot = nil
    self._hint = nil
  end
  if not PluginUI.IsAlive(self._floatBtn) then
    self._floatBtn = nil
  end
  if not PluginUI.IsAlive(self._canvas) then
    self._canvas = nil
  end
  if self._canvas == nil then
    self._canvas = PluginUI.FindCanvas()
  end
  if self._canvas == nil then
    PluginUI.RetryEnsure(self, _MAX_RETRY, _RETRY_DELAY_SEC)
    return
  end
  if self._root ~= nil and self._floatBtn ~= nil then return end
  if self._floatBtn == nil then
    self._floatBtn = -- 位置：右下角（屏幕 1920x1080 居中锚点：右边缘留 20、下边缘留 20）——不压面板，也不挡游戏主 UI
    PluginUI.CreateFloatingButton(self._canvas, "插件", UnityEngine.Vector3(-80, -490, 0), function()
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
  -- 位置：屏幕居中略偏上（460x520），与右下角的浮窗按钮互不遮挡
  local root = PluginUI.CreateImage(self._canvas, "PluginPanel(Clone)", UnityEngine.Vector3(0, 20, 0), _PANEL_SIZE, UnityEngine.Color(0.05, 0.05, 0.08, 0.92))
  local title = PluginUI.CreateText(root.transform, "Title", UnityEngine.Vector3(0, _PANEL_SIZE.y / 2 - 26, 0), UnityEngine.Vector2(440, 40), 26, UnityEngine.Color(0.9, 0.9, 1, 1))
  -- 拖标题栏 = 拖动整块面板（命中用标题、移动的是 root）
  PluginUI.EnableDrag(root, nil, title, false)
  title.alignment = UnityEngine.TextAnchor.MiddleCenter
  title.text = "Lua 插件管理"
  -- 列表容器：重建只清容器子节点，标题得以保留
  -- （历史缺陷：直接在根节点上清空到 child 0，把标题一起删了）
  self._listRoot = PluginUI.CreateContainer(root.transform, "List", UnityEngine.Vector3.zero, UnityEngine.Vector2(420, 400))
  local hint = PluginUI.CreateText(root.transform, "Hint", UnityEngine.Vector3(0, -(_PANEL_SIZE.y / 2 - 22), 0), UnityEngine.Vector2(420, 30), 13, UnityEngine.Color(0.6, 0.6, 0.7, 1))
  hint.alignment = UnityEngine.TextAnchor.MiddleCenter
  self._hint = hint
  self._root = root
  self._root:SetActive(false)
  self:Refresh()
end

--[[
  重建插件列表（每次开合/启停后调用，保证状态实时）。

  ★ 入口守卫的**用户可见面**：只剩一个 UI 入口时，它的开关渲染成不可点的「常驻」
  （PluginManager:CanDisable 为假）。否则玩家一点就把自己关在门外——
  实测故障：`plugin_panel` 与 `options_panel` 同时被关掉后，游戏内再无任何入口。
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
    -- 入口插件且它是当前唯一启用中的入口 ⇒ 不可停用（常驻）
    local locked = plugin ~= nil and plugin.enabled and not mgr:CanDisable(def.id)
    local rowBg, _ = PluginUI.CreateImage(trans, "Row", UnityEngine.Vector3(0, y, 0), UnityEngine.Vector2(420, 56), UnityEngine.Color(0.2, 0.2, 0.25, 0.6))
    -- 文本区几何（2026-09-15 修「文字超出边框」）：
    -- 行宽 420 ⇒ x ∈ [-210, 210]；右侧 State/Toggle 从 115 起。文本框居中于 -45、宽 310
    -- ⇒ 实际落在 [-200, 110]，**完全在行内**且不压右侧控件。
    -- 历史缺陷：文本框居中于 -150、宽 260 ⇒ 落在 [-280, -20]，左侧整整探出行外 70px；
    -- 且 260px 装不下最长 447px 的描述，Warp+Truncate 下被切一半。
    local nameText = PluginUI.CreateText(rowBg.transform, "Name", UnityEngine.Vector3(-45, 14, 0), UnityEngine.Vector2(310, 24), 20, UnityEngine.Color(1, 1, 1, 1))
    nameText.text = def.name
    PluginUI.FitText(nameText, 300)
    local descText = PluginUI.CreateText(rowBg.transform, "Desc", UnityEngine.Vector3(-45, -12, 0), UnityEngine.Vector2(310, 20), 13, UnityEngine.Color(0.7, 0.7, 0.7, 1))
    descText.text = err ~= nil and err or def.desc
    PluginUI.FitText(descText, 300)
    descText.color = err ~= nil and UnityEngine.Color(1, 0.5, 0.5, 1) or UnityEngine.Color(0.7, 0.7, 0.7, 1)
    -- 状态/错误标记
    local state = PluginUI.CreateText(rowBg.transform, "State", UnityEngine.Vector3(150, 14, 0), UnityEngine.Vector2(70, 24), 16, UnityEngine.Color(0.4, 1, 0.4, 1))
    state.alignment = UnityEngine.TextAnchor.MiddleCenter
    if plugin == nil then
      state.text = "ERR"
      state.color = UnityEngine.Color(1, 0.3, 0.3, 1)
    elseif locked then
      -- 常驻：停用它会让游戏内失去最后一个插件入口
      state.text = "常驻"
      state.color = UnityEngine.Color(1, 0.85, 0.3, 1)
    else
      state.text = plugin.enabled and "ON" or "OFF"
      state.color = plugin.enabled and UnityEngine.Color(0.4, 1, 0.4, 1) or UnityEngine.Color(1, 0.4, 0.4, 1)
    end
    -- 开关按钮（加载失败的插件无可启停对象；常驻的入口面板只显示锁定标记）
    local btnColor = UnityEngine.Color(0.4, 0.4, 0.4, 1)
    if plugin ~= nil then
      btnColor = locked and UnityEngine.Color(0.35, 0.3, 0.2, 1) or UnityEngine.Color(0.3, 0.6, 1, 1)
    end
    local btnObj, _ = PluginUI.CreateImage(rowBg.transform, "Toggle", UnityEngine.Vector3(150, -12, 0), UnityEngine.Vector2(64, 28), btnColor)
    local btnText = PluginUI.CreateText(btnObj.transform, "Text", UnityEngine.Vector3.zero, UnityEngine.Vector2(64, 28), 14, UnityEngine.Color(1, 1, 1, 1))
    btnText.alignment = UnityEngine.TextAnchor.MiddleCenter
    btnText.text = locked and "锁定" or "切换"
    if plugin ~= nil and not locked then
      -- 不用 UGUI.Button（自建 Overlay 画布上会点击穿透）；统一走自绘点击
      local pluginId = def.id
      local selfRef = self
      PluginUI.EnableClick(btnObj, function()
        PluginManager.me:SetEnabled(pluginId, not plugin.enabled)
        selfRef:Refresh()
      end)
    end
    y = y - _ROW_STEP
  end
  self:_RefreshHint()
end

--[[
  刷新底部提示：说明「为什么某个入口是常驻的」，以及被关掉的入口该怎么恢复。

  两种状态分别给不同的话术——把「去哪儿点」直接写出来，比让玩家自己猜要省事得多。
--]]
function PanelPlugin:_RefreshHint()
  if self._hint == nil then
    return
  end
  local mgr = PluginManager.me
  local closedName = nil
  if mgr ~= nil and mgr.UiEntryIds ~= nil then
    for _, id in ipairs(mgr:UiEntryIds()) do
      if id ~= _ID then
        local other = mgr:GetPlugin(id)
        if other ~= nil and not other.enabled then
          closedName = other.name or id
        end
      end
    end
  end
  if closedName ~= nil then
    self._hint.text = "「" .. tostring(closedName) .. "」已关闭：在上方列表打开它即可恢复其浮窗按钮"
  else
    self._hint.text = "「常驻」是最后的插件入口，不可关闭（否则游戏内将没有入口）"
  end
  -- 提示语里嵌了插件名，长度不可控：同样收进框内（Hint 框宽 420，留 10px 边距）
  PluginUI.FitText(self._hint, 400)
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
    -- 面板盖在按钮上会拦截点击，展开时把按钮提到最上层，保证还能点回去
    PluginUI.BringToFront(self._floatBtn)
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
  self._hint = nil
  self._open = false
  self._retryActive = false
  eutil.Log("[PanelPlugin] 插件管理面板已停用")
end

return PanelPlugin
