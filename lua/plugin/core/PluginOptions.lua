--[[
  PluginOptions.lua —— 插件选项定义与取值存储（单一数据源）

  三件事：
    1. 定义：每个插件可调的选项（类型 / 默认值 / 取值域 / 显示名），面板据此渲染控件；
    2. 存储：取值持久化在 plugin_config.json 的 options 字段（经 PluginConfigFile 读改写真，
       与 PluginManager 的 enabled 字段互不覆盖）；
    3. 通知：取值变更（面板点选或服务端心跳下发）后广播给订阅者，插件实时重应用。

  选项类型：
    - switch：布尔开关；
    - number：数值，按 min/max/step 约束并吸附到步进网格；
    - enum：枚举，值为 choices[i].value（字符串）。

  非法取值（未知 key / 类型不符 / 越界归一化失败）一律忽略并回退默认值，
  保证 configure 出来的脏数据不会把插件带崩。
--]]
local PluginOptions = {}

local PluginConfigFile = require("Plugin/core/PluginConfigFile")

--[[
  选项定义清单（顺序即面板页签顺序）。每项：
    id      插件标识（与 PluginDefs.lua 一致）
    options 选项数组：
      key     选项键（持久化键名，字母/下划线开头）
      label   显示名
      type    "switch" | "number" | "enum"
      default 默认值（当前硬编码行为，保证未改选项时行为不变）
      desc    说明（可选）
      min/max/step/format  number 专用
      choices enum 专用：{ { value = "x", label = "显示名" }, ... }
--]]
PluginOptions.Defs = {
  {
    id = "enemy_hp",
    options = {
      {
        key = "font_size",
        label = "文本字号",
        type = "number",
        default = 16,
        min = 10,
        max = 40,
        step = 2,
        format = "%d",
        desc = "血量文本字号",
      },
      {
        key = "color",
        label = "文本颜色",
        type = "enum",
        default = "red",
        desc = "血量文本颜色",
        choices = {
          { value = "red", label = "红" },
          { value = "orange", label = "橙" },
          { value = "white", label = "白" },
          { value = "green", label = "绿" },
        },
      },
      {
        key = "offset_x",
        label = "水平偏移",
        type = "number",
        default = 155,
        min = -200,
        max = 400,
        step = 5,
        format = "%d",
        desc = "相对血条的横向位置",
      },
      {
        key = "offset_y",
        label = "垂直偏移",
        type = "number",
        default = -15,
        min = -80,
        max = 80,
        step = 5,
        format = "%d",
        desc = "相对血条的纵向位置",
      },
    },
  },
  {
    id = "enemy_info",
    options = {
      {
        key = "panel_alpha",
        label = "面板不透明度",
        type = "number",
        default = 1,
        min = 0.2,
        max = 1,
        step = 0.1,
        format = "%.1f",
        desc = "属性面板整体透明度",
      },
      {
        key = "panel_side",
        label = "面板停靠侧",
        type = "enum",
        default = "right",
        desc = "属性面板贴在屏幕哪一侧",
        choices = {
          { value = "right", label = "右侧" },
          { value = "left", label = "左侧" },
        },
      },
      {
        key = "pick_radius",
        label = "拾取半径",
        type = "number",
        default = 50,
        min = 20,
        max = 120,
        step = 5,
        format = "%d",
        desc = "点击选敌的判定半径(px)",
      },
    },
  },
  {
    id = "battle_assist",
    options = {
      {
        key = "show_timer",
        label = "战斗时间轴",
        type = "switch",
        default = true,
        desc = "角落显示战斗时间",
      },
      {
        key = "font_size",
        label = "时间轴字号",
        type = "number",
        default = 24,
        min = 14,
        max = 48,
        step = 2,
        format = "%d",
        desc = "时间轴文本字号",
      },
      {
        key = "hotkey_pause",
        label = "暂停/继续按键",
        type = "enum",
        default = "X",
        desc = "切换暂停状态的按键",
        choices = {
          { value = "X", label = "X" },
          { value = "Z", label = "Z" },
          { value = "C", label = "C" },
          { value = "P", label = "P" },
          { value = "F1", label = "F1" },
          { value = "F2", label = "F2" },
        },
      },
      {
        key = "hotkey_speed",
        label = "三倍速按键",
        type = "enum",
        default = "Alpha3",
        desc = "切到 SUPER_FAST 的按键",
        choices = {
          { value = "Alpha1", label = "Alpha1" },
          { value = "Alpha2", label = "Alpha2" },
          { value = "Alpha3", label = "Alpha3" },
          { value = "Alpha4", label = "Alpha4" },
          { value = "F3", label = "F3" },
          { value = "F4", label = "F4" },
        },
      },
    },
  },
  {
    id = "network_redirect",
    options = {
      {
        key = "server",
        label = "服务器",
        type = "enum",
        -- 默认与历史行为一致：本地私服（127.0.0.1:8443）
        default = "local",
        desc = "切换后重启客户端生效",
        -- choices.value 必须与 NetworkRedirectPlugin 的 SERVER_PRESETS 一致（守卫固化）
        choices = {
          { value = "local", label = "本地私服" },
          { value = "official_cn", label = "国服官服" },
          { value = "official_tw", label = "台服官服" },
          { value = "official_jp", label = "日服官服" },
          { value = "official_kr", label = "韩服官服" },
          { value = "official_en", label = "国际服官服" },
          { value = "custom", label = "自定义" },
        },
      },
    },
  },
}

-- 取值缓存（options 字段的引用，惰性加载）
PluginOptions._cache = nil
-- 变更订阅者数组
PluginOptions._listeners = {}

--[[
  按插件 id 取选项定义条目（线性扫描；Defs 很小）。
  @param id 插件标识
  @return 条目表（含 options）或 nil
--]]
function PluginOptions:FindEntry(id)
  for _, entry in ipairs(PluginOptions.Defs) do
    if entry.id == id then return entry end
  end
  return nil
end

--[[
  按 (插件 id, 选项键) 取选项定义。
  @param id  插件标识
  @param key 选项键
  @return 选项定义或 nil
--]]
function PluginOptions:FindDef(id, key)
  local entry = self:FindEntry(id)
  if entry == nil then return nil end
  for _, def in ipairs(entry.options) do
    if def.key == key then return def end
  end
  return nil
end

--[[
  确保取值缓存已建立（读一次磁盘；文件损坏时为空表）。
  @return options 字段（表，绝不 nil）
--]]
function PluginOptions:_Ensure()
  if PluginOptions._cache == nil then
    local cfg = PluginConfigFile.Read()
    PluginOptions._cache = (type(cfg.options) == "table") and cfg.options or {}
  end
  return PluginOptions._cache
end

--[[
  丢弃缓存，下次读取重新落盘取值（面板打开时调用，可拿到管理端刚写入的配置）。
--]]
function PluginOptions:Reload()
  PluginOptions._cache = nil
end

--[[
  按定义把外部值归一化到合法域；无法归一化返回 nil。
  @param def   选项定义
  @param value 原始值（来自面板 / JSON / 服务端）
  @return 归一化后的值或 nil
--]]
local function _Normalize(def, value)
  if def.type == "switch" then
    if value == true or value == false then return value end
    if value == 1 or value == "1" or value == "true" then return true end
    if value == 0 or value == "0" or value == "false" then return false end
    return nil
  end
  if def.type == "number" then
    if type(value) ~= "number" and type(value) ~= "string" then return nil end
    local n = tonumber(value)
    if n == nil then return nil end
    if def.min ~= nil and n < def.min then n = def.min end
    if def.max ~= nil and n > def.max then n = def.max end
    if def.step ~= nil and def.step > 0 then
      local base = def.min or 0
      n = base + math.floor((n - base) / def.step + 0.5) * def.step
    end
    if def.min ~= nil and n < def.min then n = def.min end
    if def.max ~= nil and n > def.max then n = def.max end
    -- 消除浮点步进尾差（0.30000000000000004 → 0.3）
    return tonumber(string.format("%.4f", n))
  end
  if def.type == "enum" then
    if type(value) ~= "string" and type(value) ~= "number" then return nil end
    local s = tostring(value)
    for _, choice in ipairs(def.choices or {}) do
      if tostring(choice.value) == s then return choice.value end
    end
    return nil
  end
  return nil
end

--[[
  读取选项当前生效值（未配置 / 脏数据回退默认值）。
  @param id  插件标识
  @param key 选项键
  @return 生效值；未知选项返回 nil
--]]
function PluginOptions:Get(id, key)
  local def = self:FindDef(id, key)
  if def == nil then return nil end
  local store = PluginOptions:_Ensure()[id]
  -- 注意不能用 `store[key] or nil` 的 and/or 惯用法：false 是合法取值，
  -- `X and false or nil` 会把「显式关闭」误判成「未配置」而回落默认值。
  local raw = nil
  if type(store) == "table" then raw = store[key] end
  if raw == nil then return def.default end
  local value = _Normalize(def, raw)
  if value == nil then return def.default end
  return value
end

--[[
  写入选项值并广播变更。
  @param id    插件标识
  @param key   选项键
  @param value 目标值（按定义归一化，非法则忽略）
  @return 实际写入的值；未写入返回 nil
--]]
function PluginOptions:Set(id, key, value)
  local def = self:FindDef(id, key)
  if def == nil then return nil end
  local normalized = _Normalize(def, value)
  if normalized == nil then return nil end
  local store = PluginOptions:_Ensure()
  if type(store[id]) ~= "table" then store[id] = {} end
  store[id][key] = normalized
  PluginOptions:_Persist()
  PluginOptions:_Notify(id, key, normalized)
  return normalized
end

--[[
  应用服务端下发的选项值（与本地生效值相同则跳过，避免心跳反复写盘 / 回推）。
  @param id    插件标识
  @param key   选项键
  @param value 服务端值
  @return 生效值；未应用返回 nil
--]]
function PluginOptions:ApplyServer(id, key, value)
  local def = self:FindDef(id, key)
  if def == nil then return nil end
  local normalized = _Normalize(def, value)
  if normalized == nil then return nil end
  if PluginOptions:Get(id, key) == normalized then return normalized end
  return PluginOptions:Set(id, key, normalized)
end

--[[
  恢复某插件的全部选项为默认值并广播。
  @param id 插件标识
--]]
function PluginOptions:Reset(id)
  local entry = self:FindEntry(id)
  if entry == nil then return end
  local store = PluginOptions:_Ensure()
  store[id] = nil
  PluginOptions:_Persist()
  for _, def in ipairs(entry.options) do
    PluginOptions:_Notify(id, def.key, def.default)
  end
end

--[[
  返回某插件全部选项的生效值快照。
  @param id 插件标识
  @return { [key] = value }（未知插件返回空表）
--]]
function PluginOptions:Snapshot(id)
  local entry = self:FindEntry(id)
  local out = {}
  if entry == nil then return out end
  for _, def in ipairs(entry.options) do
    out[def.key] = PluginOptions:Get(id, def.key)
  end
  return out
end

--[[
  订阅选项变更。回调签名 fn(id, key, value)，异常经 xpcall 隔离。
  @param fn 回调
  @return 传入的回调（供 Unsubscribe 使用）
--]]
function PluginOptions.Subscribe(fn)
  if type(fn) ~= "function" then return nil end
  PluginOptions._listeners[#PluginOptions._listeners + 1] = fn
  return fn
end

--[[
  取消订阅（按调用引用匹配；不存在则忽略）。
  @param fn Subscribe 返回的回调
--]]
function PluginOptions.Unsubscribe(fn)
  for i = #PluginOptions._listeners, 1, -1 do
    if PluginOptions._listeners[i] == fn then
      table.remove(PluginOptions._listeners, i)
    end
  end
end

--[[
  把取值写回插件配置文件（读 → 改 → 写，保留 enabled 等其它字段）。
--]]
function PluginOptions:_Persist()
  local store = PluginOptions._cache
  PluginConfigFile.Update(function(cfg)
    cfg.options = store
  end)
end

--[[
  广播一次变更：先快照订阅者数组，避免回调里退订导致遍历错位。
  @param id    插件标识
  @param key   选项键
  @param value 新值
--]]
function PluginOptions:_Notify(id, key, value)
  local snapshot = {}
  for i, fn in ipairs(PluginOptions._listeners) do
    snapshot[i] = fn
  end
  for _, fn in ipairs(snapshot) do
    xpcall(function() fn(id, key, value) end, debug.traceback)
  end
end

return PluginOptions
