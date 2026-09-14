--[[
  PluginUI.lua —— 插件 UI 通用控件工厂

  插件面板（PanelPlugin / OptionsPanelPlugin）都用 UnityEngine.UI 动态搭界面，
  这里收敛四件重复事：
    - 控件创建：图片 / 文本 / 按钮 / 空容器（矩形定位统一走 anchoredPosition3D）；
    - 渲染前置条件：层级（layer）继承父节点、文本字体（Font）解析
      ——运行时 new 出来的 GameObject 默认在 layer 0 且 Text.font 为空，
      屏幕空间-相机模式的 Canvas 会按相机 cullingMask 剔除、无字体的 Text 不渲染，
      两者都会表现为「UI 建好了但看不见」，必须在建控件时补齐；
    - 挂载点定位：主 UI Canvas 查找 + Canvas 未就绪时的 TimerModel 延迟重试；
    - 浮动开关按钮：统一构造「开合面板」按钮。

  仅使用 UnityEngine / UnityEngine.UI，任何调用失败由各插件自行 pcall 兜底。
--]]
local PluginUI = {}

local UnityEngine = CS.UnityEngine
local UGUI = CS.UnityEngine.UI

-- 浮动开关按钮尺寸/底色（PanelPlugin 与 OptionsPanelPlugin 保持一致外观）
--[[ 自建 overlay 画布（保证浮窗可见；见 FindCanvas 注释） ]] local _ownCanvas = nil
local _FLOAT_BTN_SIZE = UnityEngine.Vector2(120, 60)
local _FLOAT_BTN_COLOR = UnityEngine.Color(0.1, 0.1, 0.1, 0.8)

-- 解析到的可用字体（缓存；Text.font 为空时文本不渲染）
local _font = nil
-- 字体解析尝试次数（未解析到时避免每次建文本都做全场景扫描）
local _fontTries = 0
local _FONT_MAX_TRIES = 5

-- 等待 TimerModel 就绪的插件：plugin -> { maxRetry, delaySec }
-- 为什么需要：插件在 DefinedFix 阶段初始化，早于 ModelMgr.Init（见官方 entry.lua），
-- 此时 TimerModel.me 尚不存在，排不了延迟重试。
local _pending = {}
local _driverHookInstalled = false

--[[
  把新建对象的 layer 对齐父节点。

  历史缺陷：运行时 `GameObject(name)` 默认落在 layer 0（Default）。当主 UI Canvas 是
  Screen Space - Camera 且 UI 相机 cullingMask 不含 Default 时，挂上去的控件会被整体
  剔除——对象都在、位置也对，就是看不见。
  @param obj    新建的 GameObject
  @param parent 父 Transform
--]]
local function _BindLayer(obj, parent)
  xpcall(function()
    if parent == nil or obj == nil then return end
    obj.layer = parent.gameObject.layer
  end, function() end)
end

--[[
  从一组 UnityEngine.Object 里取第一个非空 font（C# 数组 0 基，见官方 Lua 用法）。
  @param objs C# 数组或 nil
  @return Font 或 nil
--]]
local function _FirstFont(objs)
  if objs == nil then return nil end
  for i = 0, objs.Length - 1 do
    local obj = objs[i]
    if obj ~= nil then
      local ok, font = pcall(function() return obj.font end)
      if ok and font ~= nil then return font end
    end
  end
  return nil
end

--[[
  解析一个可用于渲染中文的字体。

  优先级：场景里既有 UGUI.Text 的字体 → UIMultiRegionTextGraphic（游戏主 UI 用的图形，
  带 CJK 字形）的字体 → Unity 内置字体。运行时 AddComponent 出来的 Text 没有默认字体，
  不显式赋值就是一个字都画不出来。解析成功即缓存；未解析到则下次调用再试（游戏 UI 可能
  比插件晚就绪）。
  @return Font 或 nil
--]]
function PluginUI.ResolveFont()
  if _font ~= nil then return _font end
  if _fontTries >= _FONT_MAX_TRIES then return nil end
  _fontTries = _fontTries + 1
  xpcall(function()
    _font = _FirstFont(UnityEngine.Object.FindObjectsOfType(typeof(UGUI.Text)))
  end, function() end)
  if _font == nil then
    xpcall(function()
      local graphicCls = CS.Torappu.UI.UIMultiRegionTextGraphic
      _font = _FirstFont(UnityEngine.Object.FindObjectsOfType(typeof(graphicCls)))
    end, function() end)
  end
  if _font == nil then
    xpcall(function()
      _font = UnityEngine.Resources.GetBuiltinResource(typeof(UnityEngine.Font), "Arial.ttf")
    end, function() end)
  end
  if _font == nil then
    xpcall(function()
      _font = UnityEngine.Resources.GetBuiltinResource(typeof(UnityEngine.Font), "LegacyRuntime.ttf")
    end, function() end)
  end
  return _font
end

--[[
  判定 Unity 对象是否仍然存活（场景切换 / 卸载后引用仍在但不是 Lua nil）。

  面板/按钮被销毁后，`self._root ~= nil` 仍为真，若不判存活就永远走不到重建分支
  ——这正是「切场景后插件面板消失且不再出现」的原因。
  @param obj UnityEngine.Object 或 nil
  @return 是否存活（非 Unity 对象按存活处理，兼容测试桩）
--]]
function PluginUI.IsAlive(obj)
  if obj == nil then return false end
  local ok, alive = pcall(function() return not obj:Equals(nil) end)
  if ok then return alive == true end
  return true
end

--[[
  创建带背景的 UI 对象。
  @param parent 父 Transform
  @param name   对象名
  @param pos    位置（Vector3，相对父节点中心）
  @param size   尺寸（Vector2）
  @param color  背景色
  @return 对象（GameObject）, Image 组件
--]]
function PluginUI.CreateImage(parent, name, pos, size, color)
  local obj = UnityEngine.GameObject(name)
  obj.transform:SetParent(parent, false)
  _BindLayer(obj, parent)
  local img = obj:AddComponent(typeof(UGUI.Image))
  local rect = obj:GetComponent(typeof(UnityEngine.RectTransform))
  rect.anchoredPosition3D = pos
  rect.localScale = UnityEngine.Vector3.one
  rect.sizeDelta = size
  img.color = color
  return obj, img
end

--[[
  创建文本组件（自动补字体，否则不渲染）。
  @param parent 父 Transform
  @param name   对象名
  @param pos    位置
  @param size   尺寸
  @param fontSize 字号
  @param color  颜色
  @return 文本组件
--]]
function PluginUI.CreateText(parent, name, pos, size, fontSize, color)
  local obj = UnityEngine.GameObject(name)
  obj.transform:SetParent(parent, false)
  _BindLayer(obj, parent)
  local text = obj:AddComponent(typeof(UGUI.Text))
  local rect = obj:GetComponent(typeof(UnityEngine.RectTransform))
  rect.anchoredPosition3D = pos
  rect.localScale = UnityEngine.Vector3.one
  rect.sizeDelta = size
  local font = PluginUI.ResolveFont()
  if font ~= nil then
    text.font = font
  end
  text.fontSize = fontSize
  text.color = color
  return text
end

--[[
  创建纯布局容器（全透明 Image + 关闭射线，保证 RectTransform 存在但不挡点击）。
  面板重建列表时只清容器的子节点，标题等外层节点得以保留。
  @param parent 父 Transform
  @param name   对象名
  @param pos    位置
  @param size   尺寸
  @return 容器 Transform
--]]
function PluginUI.CreateContainer(parent, name, pos, size)
  local obj, img = PluginUI.CreateImage(parent, name, pos, size, UnityEngine.Color(0, 0, 0, 0))
  pcall(function() img.raycastTarget = false end)
  return obj.transform
end

--[[
  创建带文字的可点击按钮。
  @param parent 父 Transform
  @param name   对象名
  @param pos    位置
  @param size   尺寸
  @param bgColor 底色
  @param label  按钮文字
  @param labelSize 文字字号
  @param onClick 点击回调（可为 nil）
  @return 按钮对象（GameObject）, 文本组件, Button 组件
--]]
function PluginUI.CreateButton(parent, name, pos, size, bgColor, label, labelSize, onClick)
  local obj, _ = PluginUI.CreateImage(parent, name, pos, size, bgColor)
  local text = PluginUI.CreateText(obj.transform, "Text", UnityEngine.Vector3.zero, size, labelSize, UnityEngine.Color(1, 1, 1, 1))
  text.alignment = UnityEngine.TextAnchor.MiddleCenter
  text.text = label
  -- 不用 UGUI.Button：统一走自绘点击判定（见 EnableClick 注释）
  if onClick ~= nil then
    PluginUI.EnableClick(obj, onClick)
  end
  return obj, text, obj
end

--[[
  清空某节点的全部子节点（销毁 GameObject）。
  @param transform 目标 Transform
--]]
function PluginUI.ClearChildren(transform)
  for i = transform.childCount - 1, 0, -1 do
    UnityEngine.Object.Destroy(transform:GetChild(i).gameObject)
  end
end

--[[
  定位主 UI Canvas。

  优先官方 Lua UI 根（entry.lua 的 `canvasPath = "UI/Main/LuaUIRoot"`）；找不到时在所有
  激活 Canvas 中取 sortingOrder 最高者——旧实现用 FindObjectOfType 取「任意一个」，
  可能落到被其它 UI 完全盖住的子 Canvas 上，控件建了也看不见。
  @return Canvas 的 Transform，找不到返回 nil
--]]
function PluginUI.FindCanvas()
  -- ① 优先自建 ScreenSpaceOverlay 画布：与游戏 UI 的渲染模式/相机无关，排序值拉满 ⇒ 必定可见。
  --    为什么要这样：在 `hot_update` 等非战斗场景里 `UI/Main/LuaUIRoot` 不存在，退回"任意画布"时
  --    会拿到 `ScreenSpaceCamera`（相机为空/被游戏 UI 遮挡）→ 对象 activeInHierarchy=true 却**看不见**
  --    （实测：探针报 root_hier=true、屏幕坐标 (497,498) 在屏内，但截屏找不到面板像素）。
  if _ownCanvas == nil or not PluginUI.IsAlive(_ownCanvas) then
    pcall(function()
      local go = UnityEngine.GameObject("DoctorateTsPluginCanvas")
      UnityEngine.Object.DontDestroyOnLoad(go)
      local canvas = go:AddComponent(typeof(UnityEngine.Canvas))
      canvas.renderMode = UnityEngine.RenderMode.ScreenSpaceOverlay
      canvas.sortingOrder = 30000
      pcall(function() go:AddComponent(typeof(UGUI.CanvasScaler)) end)
      pcall(function() go:AddComponent(typeof(UGUI.GraphicRaycaster)) end)
      _ownCanvas = go
    end)
  end
  if _ownCanvas ~= nil and PluginUI.IsAlive(_ownCanvas) then
    return _ownCanvas.transform
  end
  -- ② 退回游戏主 UI 根
  local ok, luaRoot = pcall(function()
    return UnityEngine.GameObject.Find("UI/Main/LuaUIRoot")
  end)
  if ok and luaRoot ~= nil then
    return luaRoot.transform
  end
  local best, bestOrder = nil, nil
  pcall(function()
    local canvases = UnityEngine.Object.FindObjectsOfType(typeof(UnityEngine.Canvas))
    for i = 0, canvases.Length - 1 do
      local canvas = canvases[i]
      if canvas ~= nil then
        local okActive, active = pcall(function() return canvas.isActiveAndEnabled end)
        if okActive and active then
          local okOrder, order = pcall(function() return canvas.sortingOrder end)
          order = (okOrder and order) or 0
          if best == nil or order > bestOrder then
            best, bestOrder = canvas, order
          end
        end
      end
    end
  end)
  if best ~= nil then
    return best.transform
  end
  -- 极端兜底：旧 API（仅测试桩使用）
  local ok2, canvas = pcall(function()
    return UnityEngine.Object.FindObjectOfType(typeof(UnityEngine.Canvas))
  end)
  if ok2 and canvas ~= nil then
    return canvas.transform
  end
  return nil
end

--[[
  取 TimerModel 单例（未初始化返回 nil，不抛错）。
  @return TimerModel 或 nil
--]]
--[[
  把回调包成 Timer 能接受的「带 Call 方法的对象」。

  ★ 契约：`Timer:Update` 是 `self.m_call:Call()`（data/[uc]lua/Timer.lua:52），
  而 `TimerModel:Delay(delay, cb)` 把 cb 直接当 m_call 存。传裸函数会抛
  `attempt to index a function value (field 'm_call')` → 从 `TimerModel:Update` 逸出 →
  未捕获托管异常 → **整个客户端 abort**（2.7.71 实测）。官方 Lua 一律用 `Event.Create/CreateStatic`。
  @param fn 回调
  @return 可交给 TimerModel 的对象
--]]
local function _AsTimerCallback(fn)
  local cb = fn
  pcall(function()
    if Event ~= nil and Event.CreateStatic ~= nil then cb = Event.CreateStatic(fn) end
  end)
  return cb
end

local function _Timer()
  local timer = nil
  pcall(function()
    if TimerModel ~= nil then timer = TimerModel.me end
  end)
  return timer
end

--[[
  补排等待中的插件：TimerModel 驱动接通（BindSwitcher）后立即调用。
--]]
local function _FlushPending()
  if _Timer() == nil then return end
  local pending = _pending
  _pending = {}
  for plugin, cfg in pairs(pending) do
    if plugin.enabled then
      pcall(function() PluginUI.RetryEnsure(plugin, cfg.maxRetry, cfg.delaySec) end)
    end
  end
end

--[[
  安装一次 TimerModel.BindSwitcher 包装。

  插件引导早于 `ModelMgr.Init()`（官方 entry.lua 顺序），引导阶段 `TimerModel.me == nil`；
  而 TimerModel 的 Update 只有在 `BindSwitcher` 把驱动接通（`LuaEntry.driveUpdate = true`）
  后才会被 C# 逐帧调用。因此必须在 BindSwitcher 之后补排重试，否则延迟链永远排不上
  ——这正是「插件 UI 在引导阶段尝试一次后不再出现」的直接原因。
--]]
local function _InstallDriverHook()
  if _driverHookInstalled then return end
  xpcall(function()
    if TimerModel == nil or type(TimerModel.BindSwitcher) ~= "function" then return end
    _driverHookInstalled = true
    local orig = TimerModel.BindSwitcher
    TimerModel.BindSwitcher = function(self, switcher)
      orig(self, switcher)
      _FlushPending()
    end
  end, function() end)
end

--[[
  确保某插件的「Canvas/面板自愈链」在跑（幂等）。

  链路：Delay(delaySec) → `plugin:_EnsureCanvasAndBuild()` → 未建成则继续 Delay，
  建成后转入低频巡检（场景切换销毁面板/Canvas 时自动重建）。
  TimerModel 未就绪时不消耗预算，登记为待补排（见 `_InstallDriverHook`）。
  @param plugin   插件实例（需有 enabled 字段与 _EnsureCanvasAndBuild 方法）
  @param maxRetry 建成前的最大尝试次数（<=0 表示不限）
  @param delaySec 重试间隔（秒）
--]]
function PluginUI.RetryEnsure(plugin, maxRetry, delaySec)
  if plugin == nil then return end
  if plugin._retryActive then return end
  local timer = _Timer()
  if timer == nil then
    if _pending[plugin] == nil then
      _pending[plugin] = { maxRetry = maxRetry, delaySec = delaySec }
    end
    _InstallDriverHook()
    return
  end
  plugin._retryActive = true
  -- 代际号：停用→重载会起新链，旧链残留的定时回调凭代际号自动作废（避免双链）
  plugin._retryGen = (plugin._retryGen or 0) + 1
  local gen = plugin._retryGen
  local attempts = 0
  local function tick()
    if plugin._retryGen ~= gen then return end
    if not plugin.enabled then
      plugin._retryActive = false
      return
    end
    plugin:_EnsureCanvasAndBuild()
    local built = PluginUI.IsAlive(plugin._root) and PluginUI.IsAlive(plugin._floatBtn)
    if built then
      attempts = 0
    else
      attempts = attempts + 1
      if maxRetry ~= nil and maxRetry > 0 and attempts >= maxRetry then
        plugin._retryActive = false
        return
      end
    end
    local nextTimer = _Timer()
    if nextTimer == nil then
      plugin._retryActive = false
      return
    end
    nextTimer:Delay(delaySec, _AsTimerCallback(tick))
  end
  timer:Delay(delaySec, _AsTimerCallback(tick))
end

--[[
  把控件移到父节点最后一个兄弟位（Unity UI 后绘制者在最上层）。
  浮动按钮先于面板创建，面板展开后会盖住按钮并拦截点击（raycastTarget），
  导致「打开了却点不回去」。
  @param obj GameObject 或 nil
--]]
function PluginUI.BringToFront(obj)
  xpcall(function()
    if obj ~= nil then obj.transform:SetAsLastSibling() end
  end, function() end)
end

--[[
  创建浮动开关按钮（点击开合面板）。
  @param canvas  挂载点 Transform
  @param label   按钮文字（也是对象名前缀）
  @param pos     位置
  @param onClick 点击回调
  @return 按钮对象（GameObject）
--]]
--[[
  逐帧输入的拖拽/点击实现（**不走 UGUI 射线**）。

  为什么不用 UGUI Button/EventTrigger：浮窗挂在自建 Overlay 画布上，实测点击会"穿透"到后面的游戏 UI
  （射线命中/事件系统在场都不保证稳定），而且 Button 只能点、不能拖。这里改成自己读输入：
    - 每帧（热修 `GlobalInitializerAndUpdater.Update`）读 `Input.GetMouseButton(0)` + `Input.mousePosition`；
    - 按下时用 `RectTransformUtility.RectangleContainsScreenPoint` 判断是否落在按钮内（Overlay 画布相机传 nil）；
    - 按下后位移 > 阈值 ⇒ 拖动（直接改 `anchoredPosition`）；否则松手算点击 ⇒ 回调。
  只在真正需要时安装一次；热修回调同样遵循「Timer/回调必须是带 Call 的对象」的契约（这里用 xlua.hotfix，天然安全）。
--]]
local _dragTargets = {}
local _dragInstalled = false
local _dragTickWarned = false

function PluginUI._DragTick()
  local ok = pcall(function()
    local Input = CS.UnityEngine.Input
    local down = Input.GetMouseButton(0)
    local mp = Input.mousePosition
    for i = #_dragTargets, 1, -1 do
      local t = _dragTargets[i]
      local obj = t.obj
      if obj == nil or not PluginUI.IsAlive(obj) then
        table.remove(_dragTargets, i)   -- 行/面板会被 Refresh 重建，及时剪掉旧目标
      else
        local hitObj = t.hit ~= nil and t.hit or obj
        local rect = nil
        if PluginUI.IsAlive(hitObj) then
          rect = hitObj:GetComponent(typeof(UnityEngine.RectTransform))
        end
        if rect ~= nil then
          if down and not t.pressed then
            local inside = CS.UnityEngine.RectTransformUtility.RectangleContainsScreenPoint(
              rect, CS.UnityEngine.Vector2(mp.x, mp.y), nil)
            if inside then
              t.pressed = true
              t.sx, t.sy = mp.x, mp.y
              t.ax = rect.anchoredPosition.x
              t.ay = rect.anchoredPosition.y
              t.moved = false
            end
          elseif t.pressed and down then
            local dx, dy = mp.x - t.sx, mp.y - t.sy
            if math.abs(dx) > 10 or math.abs(dy) > 10 then t.moved = true end
            if not t.clickOnly then
              local moveRect = obj:GetComponent(typeof(UnityEngine.RectTransform))
              if moveRect ~= nil then
                moveRect.anchoredPosition = CS.UnityEngine.Vector2(t.ax + dx, t.ay + dy)
              end
            end
          elseif t.pressed and not down then
            t.pressed = false
            if not t.moved and t.onTap ~= nil then xpcall(t.onTap, function() end) end
          end
        end
      end
    end
  end)
  if not ok and not _dragTickWarned then
    _dragTickWarned = true
    pcall(function()
      local p = CS.UnityEngine.Application.persistentDataPath .. "/plugin_ui_trace.txt"
      CS.Torappu.FileUtil.WriteToFile("[PluginUI] DragTick 失败", p, true)
    end)
  end
end

--[[
  安装逐帧驱动（只装一次）。
--]]
function PluginUI._EnsureDragDriver()
  if _dragInstalled then return end
  _dragInstalled = true
  xpcall(function()
    local G = CS.Torappu.GlobalInitializerAndUpdater
    local orig = G.Update
    xlua.hotfix(G, "Update", function(...)
      if orig ~= nil then orig(...) end
      PluginUI._DragTick()
    end)
  end, function() end)
end

--[[
  让一个 UI 对象支持「拖动 + 点击」（点击判定带位移阈值，拖动不会误触发点击）。
  @param obj     已创建的对象（需带 RectTransform）
  @param onTap   松手且未发生拖动时的回调
--]]
function PluginUI.EnableDrag(obj, onTap, hitObj, clickOnly)
  _dragTargets[#_dragTargets + 1] = {
    obj = obj,
    onTap = onTap,
    hit = hitObj ~= nil and hitObj or obj,
    clickOnly = clickOnly == true,
  }
  PluginUI._EnsureDragDriver()
end

--[[
  只支持点击（不移动对象）。用于面板行开关、选项面板的各类按钮。

  为什么不用 UGUI.Button：与浮窗按钮同因——挂自建 Overlay 画布时点击会穿透到游戏 UI
  （即"二级浮窗无法点击"）。这里统一走自绘命中判定。
  @param obj 目标对象（需带 RectTransform）
  @param fn  点击回调
--]]
function PluginUI.EnableClick(obj, fn)
  PluginUI.EnableDrag(obj, fn, obj, true)
end

function PluginUI.CreateFloatingButton(canvas, label, pos, onClick)
  local obj = PluginUI.CreateImage(canvas, label .. "Toggle(Clone)", pos, _FLOAT_BTN_SIZE, _FLOAT_BTN_COLOR)
  local text = PluginUI.CreateText(obj.transform, "Text", UnityEngine.Vector3.zero, _FLOAT_BTN_SIZE, 22, UnityEngine.Color(1, 1, 1, 1))
  text.alignment = UnityEngine.TextAnchor.MiddleCenter
  text.text = label
  -- 不用 UGUI.Button：改成自绘拖拽/点击（见 EnableDrag 注释），拖动后位置会被记住（对象不销毁）
  PluginUI.EnableDrag(obj, onClick)
  return obj
end

return PluginUI
