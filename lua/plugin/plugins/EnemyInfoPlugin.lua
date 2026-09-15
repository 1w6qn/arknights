--[[
  EnemyInfoPlugin.lua —— 敌人属性面板插件
  参考 Arknights-Assist 的 EnemyHUD：战斗中按住 Z 键并点击敌人，动态构建半透明属性面板，
  显示名字/ID/描述与黑板信息（攻击/防御/法抗/移速/攻速/重量/目标点等）。
  面板用 UnityEngine.UI 动态构建，挂在关卡 UI 静态层下。API 随版本可能漂移，已做 pcall 兜底。
--]]
local EnemyInfoPlugin = Class("EnemyInfoPlugin", require("Plugin/core/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginOptions = require("Plugin/core/PluginOptions")

-- 选项所属插件 id
local _ID = "enemy_info"

local UnityEngine = CS.UnityEngine
local UGUI = CS.UnityEngine.UI

--[[
  依据边界创建带文本的 UI 子对象。
  @param parent 父 Transform
  @param name   对象名
  @param pos    锚点位置（Vector3）
  @param size   尺寸（Vector2）
  @param fontSize 字号
  @param color  颜色
  @return 文本组件
--]]
local function _CreateText(parent, name, pos, size, fontSize, color)
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
  创建面板根节点（半透明深色底 + CanvasGroup）。初始完全透明，显示时再按
  选项 panel_alpha 赋值；停靠侧与透明度均由 _ApplyPanelStyle 统一应用。
  @param parent 父 Transform
  @return 面板 GameObject + CanvasGroup
--]]
function EnemyInfoPlugin:_CreatePanel(parent)
  local root = UnityEngine.GameObject("EnemyInfoPanel(Clone)")
  root.transform:SetParent(parent, false)
  local img = root:AddComponent(typeof(UGUI.Image))
  local group = root:AddComponent(typeof(UnityEngine.CanvasGroup))
  local rect = root:GetComponent(typeof(UnityEngine.RectTransform))
  rect.localScale = UnityEngine.Vector3.one
  rect.sizeDelta = UnityEngine.Vector2(560, 260)
  img.color = UnityEngine.Color(0, 0, 0, 0.6)
  group.blocksRaycasts = false
  group.alpha = 0
  -- 先清掉上一场战斗的引用，再应用停靠侧（避免 _ApplyPanelStyle 碰到已销毁的旧 CanvasGroup）
  self._group = nil
  self._visible = false
  self._panelRect = rect
  self:_ApplyPanelStyle()
  return root, group
end

--[[
  把当前选项取值应用到面板：停靠侧（panel_side）→ 锚点/位置；
  不透明度（panel_alpha）→ CanvasGroup.alpha（仅在面板可见时刷新，隐藏态保持 0）。
--]]
function EnemyInfoPlugin:_ApplyPanelStyle()
  local rect = self._panelRect
  if rect ~= nil then
    if PluginOptions:Get(_ID, "panel_side") == "left" then
      rect.anchorMin = UnityEngine.Vector2(0, 1)
      rect.anchorMax = UnityEngine.Vector2(0, 1)
      rect.anchoredPosition3D = UnityEngine.Vector3(300, -300, 0)
    else
      rect.anchorMin = UnityEngine.Vector2.one
      rect.anchorMax = UnityEngine.Vector2.one
      rect.anchoredPosition3D = UnityEngine.Vector3(-300, -300, 0)
    end
  end
  if self._group ~= nil and self._visible then
    self._group.alpha = PluginOptions:Get(_ID, "panel_alpha")
  end
end

--[[
  插件启用：拦截关卡 UI 创建，构建面板并注册每帧更新。
--]]
function EnemyInfoPlugin:OnLoad()
  self._panel = nil
  self._group = nil
  self._panelRect = nil
  self._nameText = nil
  self._idText = nil
  self._blackboardText = nil
  self._lastEnemy = nil
  self._visible = false

  -- 选项变更（面板透明度/停靠侧）即时重应用
  self._onOption = PluginOptions.Subscribe(function(id)
    if id ~= _ID then return end
    self:_ApplyPanelStyle()
  end)

  -- 尝试在战斗 UI 创建时挂接面板（UIController.Awake，包装保留原逻辑）
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    local ok, groupStatic = pcall(function() return selfCtrl:get_groupStatic() end)
    if not ok or groupStatic == nil then return end
    local root, group = self:_CreatePanel(groupStatic)
    self._panel = root
    self._group = group
    self._nameText = _CreateText(root.transform, "EnemyName", UnityEngine.Vector3(0, 90, 0), UnityEngine.Vector2(300, 40), 30, UnityEngine.Color(0.8, 0.2, 0, 1))
    self._idText = _CreateText(root.transform, "EnemyID", UnityEngine.Vector3(0, 55, 0), UnityEngine.Vector2(300, 20), 14, UnityEngine.Color(0.6, 0.6, 0.6, 1))
    self._blackboardText = _CreateText(root.transform, "EnemyBB", UnityEngine.Vector3(0, -20, 0), UnityEngine.Vector2(520, 200), 16, UnityEngine.Color(1, 1, 1, 1))
    self._panel:SetActive(false)
  end)

  -- 每帧更新：检测按键+点击选敌并刷新面板数据
  self:Hotfix(CS.Torappu.Battle.BattleController, "Update", function(selfCtrl, orig)
    orig(selfCtrl)
    self:_Update(selfCtrl)
  end)
  eutil.Log("[EnemyInfoPlugin] 敌人属性面板已启用")
end

--[[
  每帧更新：处理选敌与面板数据刷新。
  @param ctrl BattleController 实例
--]]
function EnemyInfoPlugin:_Update(ctrl)
  if self._panel == nil then return end
  local input = UnityEngine.Input
  -- 触摸输入（移动端/模拟器触摸）：触摸按下 + 按住 Z
  if input.touchCount > 0 then
    local touch = input:GetTouch(0)
    if touch.m_Phase:ToString() == "Began" and input:GetKey(UnityEngine.KeyCode.Z) then
      local enemy = self:_PickEnemyNear(ctrl, touch.m_Position)
      if enemy ~= nil then
        self:_ShowEnemy(enemy)
      end
    end
  end
  -- 鼠标输入（Windows 客户端）：按住 Z + 左键点击
  if input:GetKey(UnityEngine.KeyCode.Z) and input:GetMouseButtonDown(0) then
    local mp = input.mousePosition
    local enemy = self:_PickEnemyNear(ctrl, UnityEngine.Vector2(mp.x, mp.y))
    if enemy ~= nil then
      self:_ShowEnemy(enemy)
    end
  end
  if self._lastEnemy ~= nil and self._visible then
    self:_RefreshBlackboard(self._lastEnemy)
  end
end

--[[
  依屏幕坐标拾取最近的敌人（粗略：遍历 m_managedFinalEnemies 求最近）。
  @param ctrl  BattleController
  @param scrPos 屏幕坐标（Vector2）
  @return Enemy 或 nil
--]]
function EnemyInfoPlugin:_PickEnemyNear(ctrl, scrPos)
  local ok, scheduler = pcall(function() return ctrl:get_scheduler() end)
  if not ok or scheduler == nil then return nil end
  local enemies = scheduler.m_managedFinalEnemies
  if enemies == nil then return nil end
  local cam = UnityEngine.Camera.main
  local radius = PluginOptions:Get(_ID, "pick_radius")
  local radius2 = radius * radius
  local best, bestDist = nil, math.huge
  for i = 0, enemies.Count - 1 do
    local enemy = enemies:GetItem(i)
    local worldPos = enemy.transform.position
    local okSp, sp = pcall(function() return cam:WorldToScreenPoint(worldPos) end)
    if okSp then
      local dx = sp.x - scrPos.x
      local dy = sp.y - scrPos.y
      local d = dx * dx + dy * dy
      if d < radius2 and d < bestDist then -- 命中半径由选项 pick_radius 控制（默认 50px）
        best, bestDist = enemy, d
      end
    end
  end
  return best
end

--[[
  显示指定敌人的信息面板。
  @param enemy Enemy 实例
--]]
function EnemyInfoPlugin:_ShowEnemy(enemy)
  self._lastEnemy = enemy
  self._visible = true
  self._panel:SetActive(true)
  self._group.alpha = PluginOptions:Get(_ID, "panel_alpha")
  local ok, edata = pcall(function() return enemy:get_data() end)
  if ok and edata ~= nil then
    self._nameText.text = tostring(edata.name)
    self._idText.text = tostring(edata.key)
  end
  self:_RefreshBlackboard(enemy)
end

--[[
  刷新黑板信息（属性文本）。逐项 pcall 兜底，缺失项显示占位。
  @param enemy Enemy 实例
--]]
function EnemyInfoPlugin:_RefreshBlackboard(enemy)
  local bb = self._blackboardText
  if bb == nil then return end
  local function get(fn)
    local ok, v = pcall(fn)
    return ok and v or "?"
  end
  local lines = {
    "攻击  <color=#D63A00>" .. tostring(get(function() return enemy:get_atk() end)) .. "</color>",
    "防御  <color=#D63A00>" .. tostring(get(function() return enemy:get_def() end)) .. "</color>",
    "法抗  <color=#D63A00>" .. tostring(get(function() return enemy:get_magicResistance() end)) .. "</color>",
    "移速  <color=#66CCFF>" .. tostring(get(function() return enemy:get_moveSpeed() end)) .. "</color>",
    "重量  <color=#66CCFF>" .. tostring(get(function() return enemy:get_massLevel() end)) .. "</color>",
    "目标点 <color=#66CCFF>" .. tostring(get(function() return enemy:get_lifePointReduce() end)) .. "</color>",
  }
  bb.text = table.concat(lines, "\n")
end

--[[
  插件停用：隐藏并清理面板。
--]]
function EnemyInfoPlugin:OnUnload()
  if self._onOption ~= nil then
    PluginOptions.Unsubscribe(self._onOption)
    self._onOption = nil
  end
  if self._panel ~= nil then
    self._panel:SetActive(false)
  end
  self._panelRect = nil
  self._lastEnemy = nil
  self._visible = false
  eutil.Log("[EnemyInfoPlugin] 敌人属性面板已停用")
end

return EnemyInfoPlugin