--[[
  PluginUI.lua —— 插件 UI 通用控件工厂

  插件面板（PanelPlugin / OptionsPanelPlugin）都用 UnityEngine.UI 动态搭界面，
  这里收敛三件重复事：
    - 控件创建：图片 / 文本 / 按钮 / 空容器（矩形定位统一走 anchoredPosition3D）；
    - 挂载点定位：主 UI Canvas 查找 + Canvas 未就绪时的 TimerModel 延迟重试；
    - 浮动开关按钮：右下角「开合面板」按钮的统一构造。

  仅使用 UnityEngine / UnityEngine.UI，任何调用失败由各插件自行 pcall 兜底。
--]]
local PluginUI = {}

local UnityEngine = CS.UnityEngine
local UGUI = CS.UnityEngine.UI

-- 浮动开关按钮尺寸/底色（PanelPlugin 与 OptionsPanelPlugin 保持一致外观）
local _FLOAT_BTN_SIZE = UnityEngine.Vector2(120, 60)
local _FLOAT_BTN_COLOR = UnityEngine.Color(0.1, 0.1, 0.1, 0.8)

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
  local img = obj:AddComponent(typeof(UGUI.Image))
  local rect = obj:GetComponent(typeof(UnityEngine.RectTransform))
  rect.anchoredPosition3D = pos
  rect.localScale = UnityEngine.Vector3.one
  rect.sizeDelta = size
  img.color = color
  return obj, img
end

--[[
  创建文本组件。
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
  local text = obj:AddComponent(typeof(UGUI.Text))
  local rect = obj:GetComponent(typeof(UnityEngine.RectTransform))
  rect.anchoredPosition3D = pos
  rect.localScale = UnityEngine.Vector3.one
  rect.sizeDelta = size
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
  local btn = obj:AddComponent(typeof(UGUI.Button))
  if onClick ~= nil then
    btn.onClick:AddListener(onClick)
  end
  return obj, text, btn
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
  定位主 UI Canvas：优先 LuaUIRoot，其次场景内任意 Canvas。
  @return Canvas 的 Transform，找不到返回 nil
--]]
function PluginUI.FindCanvas()
  local ok, luaRoot = pcall(function()
    return UnityEngine.GameObject.Find("UI/Main/LuaUIRoot")
  end)
  if ok and luaRoot ~= nil then
    return luaRoot.transform
  end
  local ok2, canvas = pcall(function()
    return UnityEngine.Object.FindObjectOfType(typeof(UnityEngine.Canvas))
  end)
  if ok2 and canvas ~= nil then
    return canvas.transform
  end
  return nil
end

--[[
  Canvas 未就绪时的通用延迟重试（TimerModel 可用时）。
  引导阶段 TimerModel 未就绪则静默返回，由各插件 hook UIController.Awake 兜底触发。
  @param plugin   插件实例（需有 _retryCount 字段与 _EnsureCanvasAndBuild 方法）
  @param maxRetry 重试上限
  @param delaySec 重试间隔（秒）
--]]
function PluginUI.RetryEnsure(plugin, maxRetry, delaySec)
  if plugin == nil then return end
  local count = plugin._retryCount or 0
  if count >= maxRetry then return end
  plugin._retryCount = count + 1
  local tm = nil
  pcall(function()
    if TimerModel ~= nil then tm = TimerModel.me end
  end)
  if tm == nil then return end
  tm:Delay(delaySec, function()
    if not plugin.enabled then return end
    plugin:_EnsureCanvasAndBuild()
  end)
end

--[[
  创建右下角浮动开关按钮（点击开合面板）。
  @param canvas  挂载点 Transform
  @param label   按钮文字（也是对象名前缀）
  @param pos     位置
  @param onClick 点击回调
  @return 按钮对象（GameObject）
--]]
function PluginUI.CreateFloatingButton(canvas, label, pos, onClick)
  local obj = PluginUI.CreateImage(canvas, label .. "Toggle(Clone)", pos, _FLOAT_BTN_SIZE, _FLOAT_BTN_COLOR)
  local text = PluginUI.CreateText(obj.transform, "Text", UnityEngine.Vector3.zero, _FLOAT_BTN_SIZE, 22, UnityEngine.Color(1, 1, 1, 1))
  text.alignment = UnityEngine.TextAnchor.MiddleCenter
  text.text = label
  local btn = obj:AddComponent(typeof(UGUI.Button))
  btn.onClick:AddListener(onClick)
  return obj
end

return PluginUI
