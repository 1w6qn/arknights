--[[
  EnemyHpPlugin.lua —— 敌人血量显示插件
  参考 Arknights-Assist 的 EnemyHpSliderHook：hotfix Torappu.Battle.UI.UIUnitHUD.Attach，
  对非 Character/Token 的单位，在血条（_hpSlider）下动态创建「当前/最大」血量文本。
  文本字号/颜色/偏移由 PluginOptions 的 enemy_hp 选项控制（游戏内「选项」面板可调），
  取值变更时即时重应用到已创建的血量文本。
  注：方法/字段名以真机 dump 校准为准（客户端版本可能漂移），此处已做 pcall 兜底。
--]]
local EnemyHpPlugin = Class("EnemyHpPlugin", require("Plugin/core/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginOptions = require("Plugin/core/PluginOptions")

-- 选项所属插件 id
local _ID = "enemy_hp"

-- 选项 color 取值 → 颜色
local _COLORS = {
  red = { 1, 0, 0, 1 },
  orange = { 1, 0.6, 0, 1 },
  white = { 1, 1, 1, 1 },
  green = { 0.4, 1, 0.4, 1 },
}

-- 全局字体（懒取一次，供血量文本使用）
EnemyHpPlugin._font = nil

--[[
  解析 UITextSlider.TextMode.A_SLASH_B 枚举值；解析失败返回 nil。
  @return 枚举值或 nil
--]]
local function _ResolveTextMode()
  local ok, mode = pcall(function()
    return CS.Torappu.UI.UITextSlider.TextMode.A_SLASH_B
  end)
  return ok and mode or nil
end

--[[
  获取血量文本字体（懒加载）。优先取内置 Arial，失败返回 nil（用 Unity 默认字体）。
  @return UnityEngine.Font 或 nil
--]]
local function _GetFont()
  if EnemyHpPlugin._font == nil then
    local ok, font = pcall(function()
      return CS.UnityEngine.Resources.GetBuiltinResource(typeof(CS.UnityEngine.Font), "Arial.ttf")
    end)
    EnemyHpPlugin._font = ok and font or nil
  end
  return EnemyHpPlugin._font
end

--[[
  继承感知的类型判断：owner 是否为 t 或其子类（对应 C# `is` 语义）。
  IsAssignableFrom 不可用（版本漂移）时回退精确类型比较。
  @param owner 单位实例
  @param t     C# 类型
  @return owner 是 t 或其子类时为 true
--]]
local function _IsA(owner, t)
  local ok, v = pcall(function() return t:IsAssignableFrom(owner:GetType()) end)
  if ok and v ~= nil then
    return v == true
  end
  local ok2, v2 = pcall(function() return owner:GetType() == t end)
  return ok2 and v2 == true or false
end

--[[
  把当前选项取值应用到单个血量文本（字号/颜色/偏移）。
  @param text 血量文本组件
--]]
function EnemyHpPlugin:_ApplyStyle(text)
  if text == nil then return end
  local colorName = PluginOptions:Get(_ID, "color")
  local rgb = _COLORS[colorName] or _COLORS.red
  text.fontSize = PluginOptions:Get(_ID, "font_size")
  text.color = CS.UnityEngine.Color(rgb[1], rgb[2], rgb[3], rgb[4])
  local rect = text.gameObject:GetComponent(typeof(CS.UnityEngine.RectTransform))
  if rect ~= nil then
    rect.anchoredPosition3D = CS.UnityEngine.Vector3(
      PluginOptions:Get(_ID, "offset_x"),
      PluginOptions:Get(_ID, "offset_y"),
      0
    )
  end
end

--[[
  把当前选项取值应用到全部已创建的血量文本（选项变更时调用）。
  文本所在 UI 随战斗场景销毁后会变成不可访问对象，逐个 pcall 隔离并剔除。
--]]
function EnemyHpPlugin:_ApplyAllStyles()
  local alive = {}
  for _, text in ipairs(self._texts or {}) do
    local ok = pcall(function() self:_ApplyStyle(text) end)
    if ok then
      alive[#alive + 1] = text
    end
  end
  self._texts = alive
end

--[[
  在指定血条下动态创建血量文本子节点并挂到 _hpSlider。
  @param hp UITextSlider（_hpSlider 字段）
--]]
function EnemyHpPlugin:_CreateHpText(hp)
  local obj = CS.UnityEngine.GameObject("HpText_C(Clone)")
  obj.transform:SetParent(hp.transform, false)
  local text = obj:AddComponent(typeof(CS.UnityEngine.UI.Text))
  local rect = obj:GetComponent(typeof(CS.UnityEngine.RectTransform))
  rect.localScale = CS.UnityEngine.Vector3.one
  rect.sizeDelta = CS.UnityEngine.Vector2(400, 20)
  local font = _GetFont()
  if font ~= nil then text.font = font end
  hp._text = text
  local mode = _ResolveTextMode()
  if mode ~= nil then hp._textMode = mode end
  if self._texts == nil then self._texts = {} end
  self._texts[#self._texts + 1] = text
  self:_ApplyStyle(text)
end

--[[
  插件启用：订阅选项变更 + hotfix UIUnitHUD.Attach。
--]]
function EnemyHpPlugin:OnLoad()
  self._texts = {}
  self._onOption = PluginOptions.Subscribe(function(id)
    if id ~= _ID then return end
    self:_ApplyAllStyles()
  end)
  local plugin = self
  self:Hotfix(CS.Torappu.Battle.UI.UIUnitHUD, "Attach", function(selfHud, orig, owner)
    local ok, err = xpcall(function()
      -- 继承匹配：Character/Token 的子类（干员/召唤物派生类型）也视为己方单位
      local isCharacter = _IsA(owner, typeof(CS.Torappu.Battle.Character))
      local isToken = _IsA(owner, typeof(CS.Torappu.Battle.Token))
      if not isCharacter and not isToken then
        local hp = selfHud._hpSlider
        if hp ~= nil and hp._text == nil then
          plugin:_CreateHpText(hp)
        end
      end
    end, debug.traceback)
    if not ok then
      eutil.LogHotfixError("[EnemyHpPlugin] Attach fix 失败: " .. err)
    end
    return orig(selfHud, owner)
  end)
  eutil.Log("[EnemyHpPlugin] 敌人血量显示已启用")
end

--[[
  插件停用：退订选项变更 + 清理引用（补丁由 BasePlugin 统一还原）。
--]]
function EnemyHpPlugin:OnUnload()
  if self._onOption ~= nil then
    PluginOptions.Unsubscribe(self._onOption)
    self._onOption = nil
  end
  self._texts = {}
  eutil.Log("[EnemyHpPlugin] 敌人血量显示已停用")
end

return EnemyHpPlugin
