--[[
  BattleAssistPlugin.lua —— 战斗辅助插件
  提供：战斗时间轴文本、3 倍速、TAS 暂停（暂停/继续键，Alpha1 单帧）。参考 Arknights-Assist TASHook。
  时间轴开关/字号、暂停键、倍速键由 PluginOptions 的 battle_assist 选项控制
  （游戏内「选项」面板可调），按键选项只开放一批常用键位，避免任意键位误触。
  高风险项（高倍速）默认关闭。API 随版本可能漂移，已做 pcall 兜底。
--]]
local BattleAssistPlugin = Class("BattleAssistPlugin", require("Plugin/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginOptions = require("Plugin/PluginOptions")

-- 选项所属插件 id
local _ID = "battle_assist"

local UnityEngine = CS.UnityEngine
local UGUI = CS.UnityEngine.UI

-- 按键映射缓存（显式逐键 pcall 获取，避免动态索引枚举在部分版本上不可用）
local _keyCache = nil

--[[
  构建「选项名 → KeyCode」映射（懒加载一次；取不到的键位不写入，运行期回退 X）。
  @return 映射表
--]]
local function _KeyMap()
  if _keyCache == nil then
    local map = {}
    local function add(name, getter)
      local ok, keyCode = pcall(getter)
      if ok and keyCode ~= nil then map[name] = keyCode end
    end
    add("X", function() return UnityEngine.KeyCode.X end)
    add("Z", function() return UnityEngine.KeyCode.Z end)
    add("C", function() return UnityEngine.KeyCode.C end)
    add("P", function() return UnityEngine.KeyCode.P end)
    add("F1", function() return UnityEngine.KeyCode.F1 end)
    add("F2", function() return UnityEngine.KeyCode.F2 end)
    add("F3", function() return UnityEngine.KeyCode.F3 end)
    add("F4", function() return UnityEngine.KeyCode.F4 end)
    add("Alpha1", function() return UnityEngine.KeyCode.Alpha1 end)
    add("Alpha2", function() return UnityEngine.KeyCode.Alpha2 end)
    add("Alpha3", function() return UnityEngine.KeyCode.Alpha3 end)
    add("Alpha4", function() return UnityEngine.KeyCode.Alpha4 end)
    _keyCache = map
  end
  return _keyCache
end

--[[
  按选项名取 KeyCode；未知/获取失败回退 X（默认暂停键）。
  @param name 键位名（如 "Alpha3"）
  @return KeyCode
--]]
local function _KeyCode(name)
  local map = _KeyMap()
  return map[name] or map["X"] or UnityEngine.KeyCode.X
end

--[[
  创建屏幕角落文本（时间轴显示）。
  @param parent 父 Transform
  @param name   对象名
  @param pos    位置
  @param fontSize 字号
  @return 文本组件
--]]
local function _CreateHudText(parent, name, pos, fontSize)
  local obj = UnityEngine.GameObject(name)
  obj.transform:SetParent(parent, false)
  local text = obj:AddComponent(typeof(UGUI.Text))
  local rect = obj:GetComponent(typeof(UnityEngine.RectTransform))
  rect.anchoredPosition3D = UnityEngine.Vector3(pos.x, pos.y, 0)
  rect.localScale = UnityEngine.Vector3.one
  rect.sizeDelta = UnityEngine.Vector2(400, 40)
  text.fontSize = fontSize
  text.color = UnityEngine.Color(1, 1, 1, 1)
  return text
end

--[[
  插件启用：订阅选项变更 + 创建 HUD 文本 + hook 战斗更新逻辑。
--]]
function BattleAssistPlugin:OnLoad()
  self._timeText = nil
  self._paused = false
  self._stepFrames = nil -- TAS 单帧步进计数（nil = 不在步进中）
  self._opts = nil

  -- 选项变更即时重应用（开关时间轴、字号、键位）
  self._onOption = PluginOptions.Subscribe(function(id)
    if id ~= _ID then return end
    self:_ApplyOptions()
  end)
  self:_ApplyOptions()

  -- 在战斗 UI 创建时挂时间轴文本（UIController.Awake，包装保留原逻辑）
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    local ok, groupStatic = pcall(function() return selfCtrl:get_groupStatic() end)
    if not ok or groupStatic == nil then return end
    self._timeText = _CreateHudText(groupStatic, "BattleTime(Clone)", UnityEngine.Vector3(-560, 300, 0), self._opts.font_size)
    self:_ApplyOptions()
  end)

  -- 每帧执行辅助逻辑
  self:Hotfix(CS.Torappu.Battle.BattleController, "Update", function(selfCtrl, orig)
    orig(selfCtrl)
    self:_Update(selfCtrl)
  end)
  eutil.Log("[BattleAssistPlugin] 战斗辅助已启用")
end

--[[
  把当前选项取值缓存到 self._opts 并即时应用到已创建的时间轴文本。
  热路径（_Update 每帧）只读缓存，避免每帧反复查选项。
--]]
function BattleAssistPlugin:_ApplyOptions()
  local opts = {
    show_timer = PluginOptions:Get(_ID, "show_timer") == true,
    font_size = PluginOptions:Get(_ID, "font_size"),
    pause_key = _KeyCode(PluginOptions:Get(_ID, "hotkey_pause")),
    speed_key = _KeyCode(PluginOptions:Get(_ID, "hotkey_speed")),
  }
  self._opts = opts
  if self._timeText ~= nil then
    local ok = pcall(function()
      self._timeText.gameObject:SetActive(opts.show_timer)
      self._timeText.fontSize = opts.font_size
    end)
    if not ok then
      self._timeText = nil
    end
  end
end

--[[
  每帧辅助逻辑：时间轴刷新、键盘指令（暂停/单帧/倍速）。
  @param ctrl BattleController 实例
--]]
function BattleAssistPlugin:_Update(ctrl)
  local opts = self._opts
  if opts == nil then return end
  local input = UnityEngine.Input
  -- 时间轴文本（关闭时不刷新）
  if self._timeText ~= nil and opts.show_timer then
    local ok, t = pcall(function() return ctrl:get_fixedPlayTime() end)
    if ok then
      self._timeText.text = "战斗时间: " .. tostring(t) .. "s"
    end
  end
  -- 暂停/继续（默认 X 键，可在选项面板改）
  if opts.pause_key ~= nil and input:GetKeyDown(opts.pause_key) then
    self:_SetPaused(ctrl, not self._paused)
    if not self._paused then
      -- 手动恢复运行时取消步进
      self._stepFrames = nil
    end
  end
  -- 单帧步进（Alpha1，TAS）：暂停状态下放行恰好一帧后回归暂停。
  -- 步进计数从 -1 起步：按键所在帧不计数（暂停态切换要到下一帧才生效），
  -- 下一帧即放行帧，计数到 1 时回归暂停。
  if input:GetKeyDown(UnityEngine.KeyCode.Alpha1) then
    self._stepFrames = -1
    self:_SetPaused(ctrl, false)
  end
  -- 三倍速（默认 Alpha3，可在选项面板改）
  if opts.speed_key ~= nil and input:GetKeyDown(opts.speed_key) then
    self:_SetSpeed(ctrl, "SUPER_FAST")
  end
  -- 步进计数：放行一帧后回归暂停
  if self._stepFrames ~= nil then
    self._stepFrames = self._stepFrames + 1
    if self._stepFrames >= 1 then
      self._stepFrames = nil
      self:_SetPaused(ctrl, true)
    end
  end
end

--[[
  设置暂停状态。
  @param ctrl  BattleController
  @param value true 暂停 / false 继续
--]]
function BattleAssistPlugin:_SetPaused(ctrl, value)
  self._paused = value
  xpcall(function() ctrl:SetPaused(value, false, false) end, debug.traceback)
end

--[[
  设置战斗速度档位。
  @param ctrl   BattleController
  @param levelName 速度档枚举名（如 SUPER_FAST）
--]]
function BattleAssistPlugin:_SetSpeed(ctrl, levelName)
  xpcall(function()
    local level = CS.Torappu.Battle.SpeedLevel[levelName]
    ctrl:set_speedLevel(level)
  end, debug.traceback)
end

--[[
  插件停用：退订选项变更 + 清空时间轴文本。
--]]
function BattleAssistPlugin:OnUnload()
  if self._onOption ~= nil then
    PluginOptions.Unsubscribe(self._onOption)
    self._onOption = nil
  end
  if self._timeText ~= nil then
    self._timeText.gameObject:SetActive(false)
  end
  self._timeText = nil
  self._paused = false
  self._stepFrames = nil
  self._opts = nil
  eutil.Log("[BattleAssistPlugin] 战斗辅助已停用")
end

return BattleAssistPlugin
