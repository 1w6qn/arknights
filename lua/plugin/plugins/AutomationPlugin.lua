--[[
  AutomationPlugin.lua —— 游戏内自动化执行器（MCP 工具的游戏侧实现）

  配合 `Plugin/core/AutomationBridge`（传输/调度）与仓内 `scripts/mcp-automation-server.ts`
  （MCP 服务器），让外部 Agent 可以真实操作客户端并读回权威结果，用于 e2e 验证：

      外部 Agent ──MCP(stdio)──▶ mcp-automation-server ──HTTP──▶ 私服 /plugin/automation/*
                                              ▲ 命令下发 / 结果回传（轮询 + 分片）
                                              └── 本插件（游戏内执行）

  命令清单（与 MCP 工具一一对应，命名 `域.动作`）：

    client.ping / client.hello / client.state / client.logs / client.eval
    plugin.list / plugin.set_enabled / plugin.set_option / plugin.reload
    http.get / http.post                       ← 用**客户端自己的网络栈**打私服端点（真 e2e）
    ui.find / ui.dump / ui.find_text / ui.click / ui.tap / ui.set
    stage.enter                                ← 关卡跳转（找格子 → 点开始，best-effort）
    scene.current / scene.list / scene.load
    battle.info / battle.control               ← 战斗驱动（暂停/倍速/单帧步进）
    screenshot                                 ← 截屏（JPEG/PNG，base64 随结果回传）
    wait

  约定：
    - 所有处理器返回 table（同步）或 `AutomationBridge.ASYNC`（异步，之后调 `ctx.done`）；
    - 所有 C# 访问都在 pcall/xpcall 里，版本漂移只让单条命令失败，不会拖垮客户端；
    - 结果必须是纯数据（不能塞 Unity 对象），桥会在序列化前统一安全化。
--]]
local AutomationPlugin = Class("AutomationPlugin", require("Plugin/core/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local AutomationBridge = require("Plugin/core/AutomationBridge")
local PluginOptions = require("Plugin/core/PluginOptions")
local PluginHeartbeat = require("Plugin/core/PluginHeartbeat")

-- 插件标识（与 PluginDefs.lua / PluginOptions.Defs 一致）
local _ID = "automation_bridge"

local UnityEngine = CS.UnityEngine
local UGUI = CS.UnityEngine.UI
local EventSystems = CS.UnityEngine.EventSystems

-- Lua 5.3 是 table.unpack，5.1 语义下是全局 unpack；两者都兼容
local _unpack = table.unpack or unpack

-- 层级扫描的节点预算（防止在超大场景里把主线程卡死）
local _SCAN_BUDGET = 20000
-- 单次 `ui.dump` 输出行上限
local _DUMP_LIMIT = 400
-- 结果里字符串的兜底上限由桥控制；这里控制「http.get 响应体保留多少」
local _HTTP_BODY_LIMIT = 8192

--------------------------------------------------------------------------------
-- 通用小工具
--------------------------------------------------------------------------------

--[[
  读字段/属性（不存在或抛错返回 nil）。
  @param obj   目标对象
  @param key   字段名
  @return 值或 nil
--]]
local function _Get(obj, key)
  if obj == nil then
    return nil
  end
  local ok, value = pcall(function()
    return obj[key]
  end)
  if ok then
    return value
  end
  return nil
end

--[[
  调实例方法（不存在或抛错返回 nil）。
  @param obj    目标对象
  @param method 方法名
  @param ...    实参
  @return 返回值或 nil
--]]
local function _Call(obj, method, ...)
  if obj == nil then
    return nil
  end
  -- 先收成表再解包：嵌套函数里不能直接用外层 `...`
  local args = { ... }
  local ok, value = pcall(function()
    return obj[method](obj, _unpack(args))
  end)
  if ok then
    return value
  end
  return nil
end

--[[
  按类型名找第一个实例（如 "CS.Torappu.Battle.BattleController"）。
  @param typePath 形如 "CS.A.B.C" 的类型路径
  @return 实例或 nil
--]]
local function _FindOne(typePath)
  local ok, inst = pcall(function()
    local cls = _G
    for part in string.gmatch(typePath, "[^.]+") do
      if cls == nil then
        return nil
      end
      cls = cls[part]
    end
    if cls == nil then
      return nil
    end
    return UnityEngine.Object.FindObjectOfType(typeof(cls))
  end)
  if ok then
    return inst
  end
  return nil
end

--[[
  取当前激活场景名。
  @return 场景名或 nil
--]]
local function _SceneName()
  local ok, name = pcall(function()
    local scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene()
    return scene.name
  end)
  if ok then
    return name
  end
  return nil
end

--[[
  时间戳（毫秒，用于 pong/耗时）。
  @return 毫秒数
--]]
local function _NowMs()
  local ok, v = pcall(function()
    return UnityEngine.Time.realtimeSinceStartup
  end)
  if ok and type(v) == "number" then
    return math.floor(v * 1000)
  end
  return os.time() * 1000
end

--[[
  把 Transform 的层级路径还原成 `GameObject.Find` 可用的字符串。
  @param tr Transform
  @return "A/B/C"
--]]
local function _PathOf(tr)
  local parts = {}
  local node = tr
  local guard = 0
  while node ~= nil and guard < 64 do
    guard = guard + 1
    local name = _Get(node, "name")
    if name == nil then
      break
    end
    table.insert(parts, 1, tostring(name))
    node = _Get(node, "parent")
  end
  return table.concat(parts, "/")
end

--[[
  读对象上的 UGUI 文本（没有返回 nil）。
  @param go GameObject
  @return 文本或 nil
--]]
local function _TextOf(go)
  local text = _Call(go, "GetComponent", typeof(UGUI.Text))
  if text == nil then
    return nil
  end
  local value = _Get(text, "text")
  if value == nil then
    return nil
  end
  return tostring(value)
end

--[[
  对象摘要（路径/激活态/屏幕位置/尺寸/是否可点）。
  @param go GameObject
  @return 表
--]]
local function _Info(go)
  local tr = _Get(go, "transform")
  local info = {
    name = tostring(_Get(go, "name") or ""),
    path = tr ~= nil and _PathOf(tr) or nil,
    activeSelf = _Get(go, "activeSelf") == true,
    activeInHierarchy = _Get(go, "activeInHierarchy") == true,
    layer = _Get(go, "layer"),
    text = _TextOf(go),
  }
  local rect = _Call(go, "GetComponent", typeof(UnityEngine.RectTransform))
  if rect ~= nil then
    local size = _Get(rect, "sizeDelta")
    if size ~= nil then
      info.size = { x = _Get(size, "x"), y = _Get(size, "y") }
    end
    local world = _Get(rect, "position")
    if world ~= nil then
      local ok, screen = pcall(function()
        return UnityEngine.RectTransformUtility.WorldToScreenPoint(nil, world)
      end)
      if ok and screen ~= nil then
        info.screen = { x = _Get(screen, "x"), y = _Get(screen, "y") }
      end
    end
  end
  local components = {}
  if _Call(go, "GetComponent", typeof(UGUI.Button)) ~= nil then
    table.insert(components, "Button")
  end
  if _Call(go, "GetComponent", typeof(UGUI.Toggle)) ~= nil then
    table.insert(components, "Toggle")
  end
  if _Call(go, "GetComponent", typeof(UGUI.InputField)) ~= nil then
    table.insert(components, "InputField")
  end
  if _Call(go, "GetComponent", typeof(UGUI.Slider)) ~= nil then
    table.insert(components, "Slider")
  end
  if rect ~= nil then
    table.insert(components, "RectTransform")
  end
  info.components = components
  return info
end

--[[
  按路径逐段解析（**包含未激活对象**）。

  为什么需要它：`GameObject.Find` 只返回激活对象，而「面板被关掉」恰恰是
  `SetActive(false)` 的未激活态——于是「面板到底关没关」将无法用函数调用断言，
  只能退回截图。这里按 `A/B/C` 逐段比对名字（先找场景根，再沿 childCount 找子节点），
  让未激活对象也能被定位与断言。
  @param path "A/B/C"
  @return GameObject 或 nil
--]]
local function _FindByPathInactive(path)
  local segments = {}
  for segment in string.gmatch(path, "[^/]+") do
    segments[#segments + 1] = segment
  end
  if #segments == 0 then
    return nil
  end
  local node = nil
  pcall(function()
    local scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene()
    local roots = scene:GetRootGameObjects()
    for i = 0, roots.Length - 1 do
      local name = _Get(roots[i], "name")
      if name ~= nil and tostring(name) == segments[1] then
        node = _Get(roots[i], "transform")
        return
      end
    end
  end)
  if node == nil then
    return nil
  end
  for index = 2, #segments do
    local count = _Get(node, "childCount")
    if type(count) ~= "number" then
      return nil
    end
    local child = nil
    for i = 0, count - 1 do
      local candidate = _Call(node, "GetChild", i)
      local name = _Get(candidate, "name")
      if name ~= nil and tostring(name) == segments[index] then
        child = candidate
        break
      end
    end
    if child == nil then
      return nil
    end
    node = child
  end
  return _Get(node, "gameObject")
end

--[[
  按路径找对象。

  先走 `GameObject.Find`（快，但只看激活对象）；失败再走含未激活对象的逐段解析，
  于是 `ui.find { path = "..." }` 对「存在但已隐藏」的面板会返回 `found=true,
  activeInHierarchy=false`，而不是含糊的「找不到」。
  @param path "A/B/C"
  @return GameObject 或 nil
--]]
local function _FindByPath(path)
  if type(path) ~= "string" or path == "" then
    return nil
  end
  local ok, go = pcall(function()
    return UnityEngine.GameObject.Find(path)
  end)
  if ok and go ~= nil then
    return go
  end
  local okFallback, fallback = pcall(_FindByPathInactive, path)
  if okFallback then
    return fallback
  end
  return nil
end

--[[
  广度优先扫描**已激活**的场景根节点，找第一个名字含 needle 的对象。
  广度优先是有意的：关卡格子/按钮通常是浅层节点，浅层命中比深挖更快也更准。
  @param needle 名字片段（区分大小写）
  @param exact  true 表示精确匹配
  @return GameObject 或 nil
--]]
local function _FindByName(needle, exact)
  if type(needle) ~= "string" or needle == "" then
    return nil
  end
  local found = nil
  pcall(function()
    local scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene()
    local roots = scene:GetRootGameObjects()
    local queue = {}
    for i = 0, roots.Length - 1 do
      queue[#queue + 1] = roots[i]
    end
    local visited = 0
    local head = 1
    while head <= #queue and visited < _SCAN_BUDGET do
      local go = queue[head]
      head = head + 1
      visited = visited + 1
      local name = _Get(go, "name")
      if name ~= nil then
        name = tostring(name)
        if (exact and name == needle) or (not exact and string.find(name, needle, 1, true) ~= nil) then
          found = go
          return
        end
      end
      local tr = _Get(go, "transform")
      local count = _Get(tr, "childCount")
      if type(count) == "number" then
        for i = 0, count - 1 do
          local child = _Call(tr, "GetChild", i)
          local childGo = _Get(child, "gameObject")
          if childGo ~= nil then
            queue[#queue + 1] = childGo
          end
        end
      end
    end
  end)
  return found
end

--[[
  递归把层级渲染成文本树（含文本内容与激活态），供 Agent「看见」当前界面。
  @param tr      当前节点
  @param depth   当前深度
  @param maxDepth 最大深度
  @param state   { lines = {}, count = 0 }
--]]
local function _DumpNode(tr, depth, maxDepth, state)
  if tr == nil or state.count >= _DUMP_LIMIT then
    return
  end
  local name = tostring(_Get(tr, "name") or "?")
  local go = _Get(tr, "gameObject")
  local active = _Get(go, "activeSelf") == true
  local line = string.rep("  ", depth) .. name
  if not active then
    line = line .. " [inactive]"
  end
  local text = _TextOf(go)
  if text ~= nil and text ~= "" then
    text = text:gsub("\n", "\\n")
    if #text > 80 then
      text = string.sub(text, 1, 80) .. "…"
    end
    line = line .. " = " .. text
  end
  state.lines[#state.lines + 1] = line
  state.count = state.count + 1
  if depth >= maxDepth then
    return
  end
  local count = _Get(tr, "childCount")
  if type(count) ~= "number" then
    return
  end
  for i = 0, count - 1 do
    local child = _Call(tr, "GetChild", i)
    _DumpNode(child, depth + 1, maxDepth, state)
    if state.count >= _DUMP_LIMIT then
      return
    end
  end
end

--[[
  在全部已激活 UGUI.Text 里按文本查找对象（先精确后包含）。
  @param needle  目标文本
  @param contains true 表示包含匹配
  @param limit   最多返回几个
  @return { { path, text, gameObject }, ... }
--]]
local function _FindByText(needle, contains, limit)
  local out = {}
  if type(needle) ~= "string" or needle == "" then
    return out
  end
  local cap = tonumber(limit) or 8
  pcall(function()
    local texts = UnityEngine.Object.FindObjectsOfType(typeof(UGUI.Text))
    for i = 0, texts.Length - 1 do
      if #out >= cap then
        return
      end
      local text = _Get(texts[i], "text")
      if text ~= nil then
        text = tostring(text)
        local hit = contains and string.find(text, needle, 1, true) ~= nil or text == needle
        if hit then
          local go = _Get(texts[i], "gameObject")
          local tr = _Get(go, "transform")
          out[#out + 1] = {
            path = tr ~= nil and _PathOf(tr) or nil,
            text = text,
            gameObject = go,
          }
        end
      end
    end
  end)
  return out
end

--[[
  点一个对象：从自身往上最多 6 层找可点的东西并触发。

  顺序：UGUI `Button.onClick:Invoke()` → `Toggle.isOn` 翻转 → `ExecuteEvents.pointerClick`。
  为什么要往上找：真正带 Button 的常常是父节点（文本/图标是子节点），
  这也是手动按文本找按钮后仍能点动的原因。
  @param go GameObject
  @return 触发方式字符串，全部失败返回 nil
--]]
local function _Click(go)
  if go == nil then
    return nil
  end
  local node = go
  local depth = 0
  while node ~= nil and depth <= 6 do
    local button = _Call(node, "GetComponent", typeof(UGUI.Button))
    if button ~= nil then
      local interactable = _Get(button, "interactable")
      if interactable ~= false then
        local onClick = _Get(button, "onClick")
        local ok = pcall(function()
          onClick:Invoke()
        end)
        if ok then
          return "Button.onClick@" .. _PathOf(_Get(node, "transform"))
        end
      end
    end
    local toggle = _Call(node, "GetComponent", typeof(UGUI.Toggle))
    if toggle ~= nil then
      local isOn = _Get(toggle, "isOn")
      local ok = pcall(function()
        toggle.isOn = not (isOn == true)
      end)
      if ok then
        return "Toggle.isOn@" .. _PathOf(_Get(node, "transform"))
      end
    end
    node = _Get(_Get(node, "transform"), "parent")
    if node ~= nil then
      node = _Get(node, "gameObject")
    end
    depth = depth + 1
  end
  -- 兜底：直接把点击事件派发给原对象
  local ok = pcall(function()
    local es = EventSystems.EventSystem.current
    if es == nil then
      return
    end
    local data = EventSystems.PointerEventData(es)
    EventSystems.ExecuteEvents.Execute(go, data, EventSystems.ExecuteEvents.pointerClickHandler)
  end)
  if ok then
    return "ExecuteEvents.pointerClick@" .. _PathOf(_Get(go, "transform"))
  end
  return nil
end

--[[
  在屏幕坐标处模拟一次点击：射线命中栈顶对象并派发 down/up/click。
  用于自绘 UI（如插件浮窗）与没有 Button 组件的格子。
  @param x 屏幕 x
  @param y 屏幕 y
  @return { target = path, invoked = bool } 或 nil
--]]
local function _Tap(x, y)
  local result = nil
  pcall(function()
    local es = EventSystems.EventSystem.current
    if es == nil then
      return
    end
    local data = EventSystems.PointerEventData(es)
    local pos = UnityEngine.Vector2(x, y)
    data.position = pos
    data.pressPosition = pos
    data.button = EventSystems.PointerEventData.InputButton.Left
    local hits = CS.System.Collections.Generic.List(EventSystems.RaycastResult)()
    es:RaycastAll(data, hits)
    if hits.Count == 0 then
      return
    end
    local top = hits[0].gameObject
    EventSystems.ExecuteEvents.Execute(top, data, EventSystems.ExecuteEvents.pointerDownHandler)
    EventSystems.ExecuteEvents.Execute(top, data, EventSystems.ExecuteEvents.pointerUpHandler)
    EventSystems.ExecuteEvents.Execute(top, data, EventSystems.ExecuteEvents.pointerClickHandler)
    result = { target = _PathOf(_Get(top, "transform")), invoked = true }
  end)
  return result
end

--[[
  把 .NET 字节数组（或 xLua 直接给的 Lua 字符串）编成 base64url。
  @param bytes byte[] 或 string
  @return base64url 字符串或 nil
--]]
local function _EncodeBytes(bytes)
  if bytes == nil then
    return nil
  end
  if type(bytes) == "string" then
    return AutomationBridge.Base64Url(bytes)
  end
  local ok, s = pcall(function()
    return CS.System.Convert.ToBase64String(bytes)
  end)
  if ok and type(s) == "string" then
    return (s:gsub("%+", "-"):gsub("/", "_"):gsub("=", ""))
  end
  return nil
end

--------------------------------------------------------------------------------
-- 游戏状态读取
--------------------------------------------------------------------------------

--[[
  取客户端玩家数据（`CS.Torappu.PlayerData.instance.data`）。
  @return PlayerDataModel 或 nil
--]]
local function _PlayerData()
  local ok, data = pcall(function()
    return CS.Torappu.PlayerData.instance.data
  end)
  if ok then
    return data
  end
  return nil
end

--[[
  玩家状态摘要（等级/理智/龙门币/主线进度等）——e2e 里最常断言的字段。
  @return 表
--]]
local function _PlayerSummary()
  local data = _PlayerData()
  local status = _Get(data, "status")
  local summary = {
    available = data ~= nil,
    nickName = _Get(status, "nickName"),
    nickNumber = _Get(status, "nickNumber"),
    level = _Get(status, "level"),
    exp = _Get(status, "exp"),
    ap = _Get(status, "ap"),
    maxAp = _Get(status, "maxAp"),
    gold = _Get(status, "gold"),
    diamondShard = _Get(status, "diamondShard"),
    socialPoint = _Get(status, "socialPoint"),
    mainStageProgress = _Get(status, "mainStageProgress"),
    secretary = _Get(status, "secretary"),
  }
  local inventory = _Get(data, "inventory")
  if inventory ~= nil then
    local ok, count = pcall(function()
      return inventory.Count
    end)
    if ok then
      summary.inventoryKinds = count
    end
  end
  return summary
end

--[[
  插件运行态摘要（含加载失败的插件）。
  @return { count, enabled, items = { { id, name, enabled, error }, ... } }
--]]
local function _PluginSummary()
  local summary = { count = 0, enabled = 0, items = {} }
  if PluginManager == nil or PluginManager.me == nil then
    return summary
  end
  local ok, all = pcall(function()
    return PluginManager.me:GetAll()
  end)
  if not ok or type(all) ~= "table" then
    return summary
  end
  for _, plugin in ipairs(all) do
    local id = _Get(plugin, "id")
    local enabled = _Get(plugin, "enabled") == true
    local err = nil
    pcall(function()
      err = PluginManager.me:GetError(id)
    end)
    summary.count = summary.count + 1
    if enabled then
      summary.enabled = summary.enabled + 1
    end
    summary.items[#summary.items + 1] = {
      id = id,
      name = _Get(plugin, "name"),
      enabled = enabled,
      error = err,
    }
  end
  return summary
end

--[[
  当前界面摘要：场景名 + 已激活 UIPage 名列表（回答「我现在在哪一屏」）。
  @return { scene, pages }
--]]
local function _UiSummary()
  local pages = {}
  pcall(function()
    local arr = UnityEngine.Object.FindObjectsOfType(typeof(CS.Torappu.UI.UIPage))
    for i = 0, arr.Length - 1 do
      local name = _Get(arr[i], "pageName")
      if name ~= nil and tostring(name) ~= "" then
        pages[#pages + 1] = tostring(name)
      end
      if #pages >= 16 then
        return
      end
    end
  end)
  return { scene = _SceneName(), pages = pages, pageCount = #pages }
end

--------------------------------------------------------------------------------
-- 战斗驱动
--------------------------------------------------------------------------------

--[[
  取当前战斗控制器（不在战斗中返回 nil）。
  @return BattleController 或 nil
--]]
local function _Battle()
  return _FindOne("CS.Torappu.Battle.BattleController")
end

--[[
  战斗状态摘要。
  @param ctrl BattleController 或 nil
  @return 表
--]]
local function _BattleInfo(ctrl)
  if ctrl == nil then
    return { active = false }
  end
  local level = _Get(ctrl, "speedLevel")
  local levelName = nil
  if level ~= nil then
    local ok, name = pcall(function()
      return tostring(level)
    end)
    if ok then
      levelName = name
    end
  end
  return {
    active = true,
    speedLevel = levelName,
    paused = _Get(ctrl, "paused"),
    playTime = _Call(ctrl, "get_fixedPlayTime"),
    path = _PathOf(_Get(ctrl, "transform")),
  }
end

--[[
  设置战斗速度档（SLOW_MOTION / STANDARD / FAST / SUPER_FAST）。
  @param ctrl   BattleController
  @param levelName 档位名
  @return 是否成功
--]]
local function _SetSpeed(ctrl, levelName)
  if ctrl == nil or type(levelName) ~= "string" then
    return false
  end
  local ok = pcall(function()
    local level = CS.Torappu.Battle.SpeedLevel[levelName]
    if level == nil then
      error("未知速度档: " .. levelName)
    end
    ctrl:set_speedLevel(level)
  end)
  return ok
end

--------------------------------------------------------------------------------
-- 命令处理器
--------------------------------------------------------------------------------

-- 命名空间：所有处理器集中登记，便于一处总览
local handlers = {}

handlers["client.ping"] = function()
  return { pong = true, t = _NowMs(), sid = AutomationBridge.SessionId() }
end

handlers["client.hello"] = function()
  local caps = AutomationBridge.Capabilities()
  caps.clientVersion = _Get(UnityEngine.Application, "version")
  caps.platform = tostring(_Get(UnityEngine.Application, "platform") or "")
  caps.scene = _SceneName()
  caps.options = AutomationBridge.Options()
  return caps
end

handlers["client.state"] = function()
  local ui = _UiSummary()
  local battle = _BattleInfo(_Battle())
  return {
    scene = ui.scene,
    pages = ui.pages,
    pageCount = ui.pageCount,
    battle = battle,
    player = _PlayerSummary(),
    plugins = _PluginSummary(),
    clientVersion = _Get(UnityEngine.Application, "version"),
    platform = tostring(_Get(UnityEngine.Application, "platform") or ""),
    sessionId = AutomationBridge.SessionId(),
    t = _NowMs(),
  }
end

handlers["client.logs"] = function(args)
  return {
    bridge = AutomationBridge.Recent(tonumber(args.limit) or 50),
    plugins = _PluginSummary(),
    sessionId = AutomationBridge.SessionId(),
  }
end

handlers["client.eval"] = function(args)
  if PluginOptions:Get(_ID, "allow_eval") ~= true then
    error("lua.eval 已禁用（在插件选项里打开「允许执行 Lua」后再试）")
  end
  local code = args.code
  if type(code) ~= "string" or code == "" then
    error("code 必填")
  end
  local chunk, loadErr = load(code, "=automation_eval")
  if chunk == nil then
    error("Lua 编译失败: " .. tostring(loadErr))
  end
  local results = { pcall(chunk) }
  local ok = table.remove(results, 1)
  if not ok then
    error("Lua 执行失败: " .. tostring(results[1]))
  end
  return { count = #results, values = results }
end

handlers["plugin.list"] = function()
  return _PluginSummary()
end

handlers["plugin.set_enabled"] = function(args)
  local id = tostring(args.id or "")
  if id == "" then
    error("id 必填")
  end
  if PluginManager == nil or PluginManager.me == nil then
    error("PluginManager 未就绪")
  end
  local enabled = args.enabled ~= false
  local applied = PluginManager.me:SetEnabled(id, enabled)
  local plugin = PluginManager.me:GetPlugin(id)
  return {
    id = id,
    requested = enabled,
    -- false = 被入口守卫拒绝（最后一个游戏内插件入口不可关闭，见 PluginManager:CanDisable）
    applied = applied == true,
    enabled = plugin ~= nil and plugin.enabled == true,
    error = PluginManager.me:GetError(id),
    note = applied ~= true and "被入口守卫拒绝：这是最后一个游戏内插件入口，关闭后无法再从游戏内恢复" or nil,
  }
end

handlers["plugin.set_option"] = function(args)
  local id = tostring(args.id or "")
  local key = tostring(args.key or "")
  if id == "" or key == "" then
    error("id / key 必填")
  end
  local applied = PluginOptions:Set(id, key, args.value)
  if applied == nil then
    error("选项写入被拒（未知插件/选项或取值非法）: " .. id .. "." .. key)
  end
  -- 同步回服务端，保持管理端与游戏内一致
  pcall(function()
    PluginHeartbeat.PushOption(id, key, applied)
  end)
  return { id = id, key = key, value = applied }
end

handlers["plugin.reload"] = function(args)
  local id = tostring(args.id or "")
  if id == "" then
    error("id 必填")
  end
  if PluginManager == nil or PluginManager.me == nil then
    error("PluginManager 未就绪")
  end
  local wasEnabled = false
  local plugin = PluginManager.me:GetPlugin(id)
  if plugin == nil then
    error("未知插件: " .. id)
  end
  wasEnabled = plugin.enabled == true
  -- 走 PluginManager:Reload（先停后启，内部绕过入口守卫——否则最后一个入口面板会被拒绝停用）
  PluginManager.me:Reload(id)
  local after = PluginManager.me:GetPlugin(id)
  return {
    id = id,
    wasEnabled = wasEnabled,
    enabled = after ~= nil and after.enabled == true,
    error = PluginManager.me:GetError(id),
  }
end

handlers["http.get"] = function(args, ctx)
  local url = args.url
  if type(url) ~= "string" or url == "" then
    ctx.done(false, nil, "url 必填")
    return AutomationBridge.ASYNC
  end
  local path = url
  if args.param ~= nil and tostring(args.param) ~= "" then
    path = url .. "?" .. tostring(args.param)
  end
  local limit = tonumber(args.max_bytes) or _HTTP_BODY_LIMIT
  local sent = AutomationBridge.Get(path, function(data, text)
    local body = text
    local truncated = false
    if type(body) == "string" and #body > limit then
      body = string.sub(body, 1, limit)
      truncated = true
    end
    ctx.done(true, {
      url = path,
      bytes = type(text) == "string" and #text or 0,
      truncated = truncated,
      json = data,
      body = body,
    })
  end)
  if not sent then
    ctx.done(false, nil, "UISender 未就绪（网络未初始化？）")
  end
  return AutomationBridge.ASYNC
end

handlers["http.post"] = function(args, ctx)
  local url = args.url
  if type(url) ~= "string" or url == "" then
    ctx.done(false, nil, "url 必填")
    return AutomationBridge.ASYNC
  end
  if UISender == nil or UISender.me == nil or UISender.me.SendRequest == nil then
    ctx.done(false, nil, "UISender.SendRequest 不可用")
    return AutomationBridge.ASYNC
  end
  local limit = tonumber(args.max_bytes) or _HTTP_BODY_LIMIT
  local body = args.body
  if type(body) ~= "table" then
    body = {}
  end
  local ok = pcall(function()
    UISender.me:SendRequest(args.service_code or "dts.automation", body, {
      url = url,
      onProceed = Event.CreateStatic(function(resp)
        -- 回调体整体兜底：这里跑在 C# 响应分发路径上，逸出即 abort
        xpcall(function()
          local text = nil
          if resp ~= nil then
            text = resp.text
          end
          local truncated = false
          local raw = text
          if type(raw) == "string" and #raw > limit then
            raw = string.sub(raw, 1, limit)
            truncated = true
          end
          local decoded = nil
          if type(text) == "string" and #text > 0 then
            local rjOk, rj = pcall(require, "rapidjson")
            if rjOk and rj ~= nil then
              local okDecode, value = pcall(rj.decode, text)
              if okDecode then
                decoded = value
              end
            end
          end
          ctx.done(true, {
            url = url,
            bytes = type(text) == "string" and #text or 0,
            truncated = truncated,
            json = decoded,
            body = raw,
          })
        end, debug.traceback)
      end),
    })
  end)
  if not ok then
    ctx.done(false, nil, "SendRequest 调用失败（URL/服务码不被接受？）")
  end
  return AutomationBridge.ASYNC
end

handlers["ui.find"] = function(args)
  local go = nil
  if type(args.path) == "string" and args.path ~= "" then
    go = _FindByPath(args.path)
  end
  if go == nil and type(args.name) == "string" and args.name ~= "" then
    go = _FindByName(args.name, args.exact == true)
  end
  if go == nil then
    return { found = false, path = args.path, name = args.name }
  end
  local info = _Info(go)
  info.found = true
  return info
end

handlers["ui.dump"] = function(args)
  local root = nil
  if type(args.path) == "string" and args.path ~= "" then
    root = _FindByPath(args.path)
  elseif type(args.name) == "string" and args.name ~= "" then
    root = _FindByName(args.name, args.exact == true)
  else
    -- 默认整场景根：给出全貌（有行数上限兜底）
    pcall(function()
      local scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene()
      local roots = scene:GetRootGameObjects()
      if roots.Length > 0 then
        root = roots[0]
      end
    end)
  end
  if root == nil then
    return { found = false, tree = "" }
  end
  local state = { lines = {}, count = 0 }
  _DumpNode(_Get(root, "transform"), 0, tonumber(args.depth) or 4, state)
  return {
    found = true,
    path = _PathOf(_Get(root, "transform")),
    nodes = state.count,
    truncated = state.count >= _DUMP_LIMIT,
    tree = table.concat(state.lines, "\n"),
  }
end

handlers["ui.find_text"] = function(args)
  local needle = args.text
  if type(needle) ~= "string" or needle == "" then
    error("text 必填")
  end
  local hits = _FindByText(needle, args.contains ~= false, tonumber(args.limit) or 8)
  local out = {}
  for _, hit in ipairs(hits) do
    out[#out + 1] = { path = hit.path, text = hit.text }
  end
  return { count = #out, matches = out }
end

--[[
  批量断言界面事实（**替代截图的首选手段**）。

  为什么要有它：验证「面板开着没 / 文本对不对 / 某个控件在不在」时，截图要缩放 + JPEG +
  分片回传（几十个请求）而且只能靠人看图；而这些都是**可结构化读取**的事实。
  一条 `ui.check` 就能一次判定 N 项并给出逐项原因，代价只有一次命令往返。
  @param args.items 断言数组：{ path? / name? / expect_exists? / expect_active? / expect_text? / expect_text_contains? }
  @return { pass, total, failedCount, failed, results }
--]]
handlers["ui.check"] = function(args)
  local items = args.items
  if type(items) ~= "table" or #items == 0 then
    error("items 必填（至少一项断言）")
  end
  local results = {}
  local failed = {}
  for index, item in ipairs(items) do
    if type(item) ~= "table" then
      item = {}
    end
    local go = nil
    if type(item.path) == "string" and item.path ~= "" then
      go = _FindByPath(item.path)
    end
    if go == nil and type(item.name) == "string" and item.name ~= "" then
      go = _FindByName(item.name, item.exact == true)
    end
    local info = go ~= nil and _Info(go) or nil
    local reasons = {}
    if item.expect_exists == true and info == nil then
      reasons[#reasons + 1] = "对象不存在"
    end
    if item.expect_exists == false and info ~= nil then
      reasons[#reasons + 1] = "对象意外存在"
    end
    if info ~= nil then
      if item.expect_active ~= nil and (info.activeInHierarchy == true) ~= (item.expect_active == true) then
        reasons[#reasons + 1] = string.format(
          "activeInHierarchy=%s（期望 %s）",
          tostring(info.activeInHierarchy),
          tostring(item.expect_active == true)
        )
      end
      if item.expect_text ~= nil and tostring(info.text or "") ~= tostring(item.expect_text) then
        reasons[#reasons + 1] = string.format('text="%s"（期望 "%s"）', tostring(info.text or ""), tostring(item.expect_text))
      end
      if
        item.expect_text_contains ~= nil
        and string.find(tostring(info.text or ""), tostring(item.expect_text_contains), 1, true) == nil
      then
        reasons[#reasons + 1] = 'text 不含 "' .. tostring(item.expect_text_contains) .. '"'
      end
    end
    local ok = #reasons == 0
    local entry = {
      query = item.path or item.name or ("#" .. tostring(index)),
      found = info ~= nil,
      activeInHierarchy = info ~= nil and info.activeInHierarchy or nil,
      text = info ~= nil and info.text or nil,
      ok = ok,
      reason = ok and nil or table.concat(reasons, "; "),
    }
    results[#results + 1] = entry
    if not ok then
      failed[#failed + 1] = entry
    end
  end
  return {
    pass = #failed == 0,
    total = #results,
    failedCount = #failed,
    failed = failed,
    results = results,
  }
end

handlers["ui.click"] = function(args)
  local go = nil
  if type(args.path) == "string" and args.path ~= "" then
    go = _FindByPath(args.path)
  end
  if go == nil and type(args.text) == "string" and args.text ~= "" then
    local hits = _FindByText(args.text, args.contains ~= false, 1)
    if #hits > 0 then
      go = hits[1].gameObject
    end
  end
  if go == nil and type(args.name) == "string" and args.name ~= "" then
    go = _FindByName(args.name, args.exact == true)
  end
  if go == nil then
    return { clicked = false, reason = "未找到目标对象", path = args.path, text = args.text, name = args.name }
  end
  local info = _Info(go)
  local plain = args.plain == true
  local method = nil
  if plain then
    pcall(function()
      local es = EventSystems.EventSystem.current
      if es ~= nil then
        local data = EventSystems.PointerEventData(es)
        EventSystems.ExecuteEvents.Execute(go, data, EventSystems.ExecuteEvents.pointerClickHandler)
        method = "ExecuteEvents.pointerClick(plain)"
      end
    end)
  else
    method = _Click(go)
  end
  return {
    clicked = method ~= nil,
    method = method,
    target = info.path,
    activeInHierarchy = info.activeInHierarchy,
  }
end

handlers["ui.tap"] = function(args)
  local x = tonumber(args.x)
  local y = tonumber(args.y)
  if x == nil or y == nil then
    error("x / y 必填（屏幕像素坐标）")
  end
  local result = _Tap(x, y)
  if result == nil then
    return { tapped = false, reason = "屏幕坐标未命中任何可交互对象（或 EventSystem 未就绪）", x = x, y = y }
  end
  result.tapped = true
  result.x = x
  result.y = y
  return result
end

handlers["ui.set"] = function(args)
  local go = nil
  if type(args.path) == "string" and args.path ~= "" then
    go = _FindByPath(args.path)
  end
  if go == nil and type(args.name) == "string" and args.name ~= "" then
    go = _FindByName(args.name, args.exact == true)
  end
  if go == nil then
    error("未找到目标对象（path/name 至少给一个）")
  end
  local kind = tostring(args.kind or "auto")
  local value = args.value
  local applied = nil
  -- `auto` 的顺序：先按控件语义写（Toggle/InputField/Slider），最后才退到 SetActive。
  -- 反过来的话，给一个 Toggle 传 auto 会被当成「激活/隐藏对象」，语义就错了。
  if kind == "toggle" or kind == "auto" then
    local toggle = _Call(go, "GetComponent", typeof(UGUI.Toggle))
    if toggle ~= nil then
      pcall(function()
        toggle.isOn = value == true
        applied = "Toggle.isOn"
      end)
    end
  end
  if applied == nil and (kind == "input" or kind == "auto") then
    local input = _Call(go, "GetComponent", typeof(UGUI.InputField))
    if input ~= nil then
      pcall(function()
        input.text = tostring(value or "")
        applied = "InputField.text"
      end)
    end
  end
  if applied == nil and (kind == "slider" or kind == "auto") then
    local slider = _Call(go, "GetComponent", typeof(UGUI.Slider))
    if slider ~= nil then
      pcall(function()
        slider.value = tonumber(value) or 0
        applied = "Slider.value"
      end)
    end
  end
  if applied == nil and (kind == "active" or kind == "auto") then
    pcall(function()
      go:SetActive(value == true)
      applied = "GameObject.SetActive"
    end)
  end
  if applied == nil then
    error("未匹配到可写控件（kind=" .. kind .. "），该对象可能既不是 Toggle/InputField/Slider 也不能 SetActive")
  end
  return { path = _PathOf(_Get(go, "transform")), kind = applied }
end

handlers["stage.enter"] = function(args, ctx)
  local stageId = tostring(args.stage_id or "")
  if stageId == "" then
    ctx.done(false, nil, "stage_id 必填")
    return AutomationBridge.ASYNC
  end
  local steps = {}
  local go = _FindByName(stageId, false)
  if go == nil then
    ctx.done(false, nil, "当前界面找不到名字含 stage_id 的对象: " .. stageId)
    return AutomationBridge.ASYNC
  end
  local method = _Click(go)
  steps[#steps + 1] = { phase = "stage", target = _PathOf(_Get(go, "transform")), method = method }
  if method == nil then
    ctx.done(false, { steps = steps }, "关卡格子存在但点不动（无 Button/Toggle/事件处理器）")
    return AutomationBridge.ASYNC
  end
  if args.auto_start == false then
    ctx.done(true, { steps = steps, started = false })
    return AutomationBridge.ASYNC
  end
  local startText = tostring(args.start_text or "开始行动")
  local delaySec = (tonumber(args.step_delay_ms) or 800) / 1000
  local scheduled = AutomationBridge.Delay(delaySec, function()
    local hits = _FindByText(startText, true, 1)
    if #hits == 0 then
      ctx.done(true, { steps = steps, started = false, note = "未找到开始按钮文本: " .. startText })
      return
    end
    local startMethod = _Click(hits[1].gameObject)
    steps[#steps + 1] = { phase = "start", target = hits[1].path, method = startMethod }
    ctx.done(true, { steps = steps, started = startMethod ~= nil })
  end)
  if not scheduled then
    ctx.done(true, { steps = steps, started = false, note = "TimerModel 未就绪，未能自动点开始" })
  end
  return AutomationBridge.ASYNC
end

handlers["scene.current"] = function()
  return _UiSummary()
end

handlers["scene.list"] = function()
  local names = {}
  pcall(function()
    local count = UnityEngine.SceneManagement.SceneManager.sceneCountInBuildSettings
    for i = 0, count - 1 do
      local path = UnityEngine.SceneManagement.SceneUtility.GetScenePathByBuildIndex(i)
      if path ~= nil then
        local name = tostring(path):match("([^/]+)%.unity$") or tostring(path)
        names[#names + 1] = name
      end
    end
  end)
  return { count = #names, scenes = names, current = _SceneName() }
end

handlers["scene.load"] = function(args)
  local name = args.name
  if type(name) ~= "string" or name == "" then
    error("name 必填（先用 scene.list 查可用场景）")
  end
  local before = _SceneName()
  local ok, err = pcall(function()
    UnityEngine.SceneManagement.SceneManager.LoadScene(name)
  end)
  if not ok then
    error("加载场景失败: " .. tostring(err))
  end
  return { requested = name, before = before, after = _SceneName() }
end

handlers["battle.info"] = function()
  return _BattleInfo(_Battle())
end

handlers["battle.control"] = function(args)
  local ctrl = _Battle()
  if ctrl == nil then
    error("当前不在战斗中（找不到 BattleController）")
  end
  local action = tostring(args.action or "")
  if action == "pause" then
    ctrl:SetPaused(true, false, false)
  elseif action == "resume" then
    ctrl:SetPaused(false, false, false)
  elseif action == "speed" then
    if not _SetSpeed(ctrl, tostring(args.level or "SUPER_FAST")) then
      error("设置速度失败（level 应为 SLOW_MOTION/STANDARD/FAST/SUPER_FAST）")
    end
  elseif action == "step" then
    -- 单帧步进：暂停态放行一帧后立刻回到暂停（TAS 语义，与 BattleAssistPlugin 一致）
    ctrl:SetPaused(false, false, false)
    local pauseAgain = AutomationBridge.Delay(0.05, function()
      pcall(function()
        ctrl:SetPaused(true, false, false)
      end)
    end)
    if not pauseAgain then
      error("TimerModel 未就绪，无法单帧步进")
    end
  else
    error("action 必填：pause | resume | speed | step")
  end
  return _BattleInfo(_Battle())
end

handlers["screenshot"] = function(args)
  local width = tonumber(args.width) or PluginOptions:Get(_ID, "screenshot_width") or 480
  local quality = tonumber(args.quality) or PluginOptions:Get(_ID, "screenshot_quality") or 60
  local wantPng = tostring(args.format or "jpeg") == "png"
  local screenW = _Get(UnityEngine.Screen, "width")
  local screenH = _Get(UnityEngine.Screen, "height")
  if type(screenW) ~= "number" or screenW <= 0 then
    error("读不到屏幕尺寸")
  end
  local targetW = math.max(64, math.min(math.floor(width), screenW))
  local targetH = math.max(64, math.floor(targetW * screenH / screenW))
  local payload = nil
  local ok, failure = pcall(function()
    local source = UnityEngine.ScreenCapture.CaptureScreenshotAsTexture()
    local rt = UnityEngine.RenderTexture(targetW, targetH, 24)
    UnityEngine.Graphics.Blit(source, rt)
    local previous = UnityEngine.RenderTexture.active
    UnityEngine.RenderTexture.active = rt
    local tex = UnityEngine.Texture2D(targetW, targetH, UnityEngine.TextureFormat.RGB24, false)
    tex:ReadPixels(UnityEngine.Rect(0, 0, targetW, targetH), 0, 0)
    tex:Apply()
    UnityEngine.RenderTexture.active = previous
    local bytes = nil
    local mime = nil
    if wantPng then
      bytes = tex:EncodeToPNG()
      mime = "image/png"
    else
      bytes = tex:EncodeToJPG(math.max(20, math.min(95, math.floor(quality))))
      mime = "image/jpeg"
    end
    local base64 = _EncodeBytes(bytes)
    if base64 == nil then
      error("截图编码失败（byte[] → base64）")
    end
    payload = {
      mime = mime,
      width = targetW,
      height = targetH,
      sourceWidth = screenW,
      sourceHeight = screenH,
      base64 = base64,
    }
    pcall(function()
      UnityEngine.Object.Destroy(source)
    end)
    pcall(function()
      tex:Release()
      UnityEngine.Object.Destroy(tex)
    end)
    pcall(function()
      rt:Release()
      UnityEngine.Object.Destroy(rt)
    end)
  end)
  if not ok then
    error("截图失败: " .. tostring(failure))
  end
  if payload == nil then
    error("截图失败：未产出图像数据")
  end
  return payload
end

handlers["wait"] = function(args, ctx)
  local ms = tonumber(args.ms) or 500
  ms = math.max(0, math.min(ms, 60000))
  local scheduled = AutomationBridge.Delay(ms / 1000, function()
    ctx.done(true, { waitedMs = ms })
  end)
  if not scheduled then
    ctx.done(false, nil, "TimerModel 未就绪")
  end
  return AutomationBridge.ASYNC
end

--------------------------------------------------------------------------------
-- 插件生命周期
--------------------------------------------------------------------------------

--[[
  把插件选项读进桥配置（OnLoad 与选项变更时调用）。
--]]
function AutomationPlugin:_ApplyOptions()
  AutomationBridge.Configure({
    pollIntervalMs = PluginOptions:Get(_ID, "poll_interval_ms"),
    cmdTimeoutMs = PluginOptions:Get(_ID, "cmd_timeout_ms"),
    maxResultBytes = PluginOptions:Get(_ID, "max_result_bytes"),
    verbose = PluginOptions:Get(_ID, "verbose_log") == true,
  })
  self._opts = AutomationBridge.Options()
end

--[[
  插件启用：注册全部命令处理器并启动轮询桥。
--]]
function AutomationPlugin:OnLoad()
  self._onOption = PluginOptions.Subscribe(function(id)
    if id ~= _ID then
      return
    end
    self:_ApplyOptions()
  end)
  self:_ApplyOptions()

  AutomationBridge.RegisterMany(handlers)
  AutomationBridge.Start()
  -- 兜底启动：引导阶段 TimerModel 未就绪（排不了定时器），而 `ModelMgr.Init` 包装万一没装上，
  -- 桥就会静默不轮询。进入战斗 UI 必然晚于登录与网络就绪，在那里再补一次。
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    xpcall(AutomationBridge.Kick, debug.traceback)
  end)
  eutil.Log(
    "[AutomationPlugin] 自动化执行器已启用: "
      .. tostring(#AutomationBridge.Handlers())
      .. " 个命令, sid="
      .. tostring(AutomationBridge.SessionId())
  )
end

--[[
  插件停用：停桥 + 清处理器。

  `Stop()` 会递增代际号让在途轮询/定时回调作废——这既是「停用后不再操作游戏」的语义，
  也是 `LuaEnv.Dispose()` 不抛 "try to dispose a LuaEnv with C# callback" 的前提。
--]]
function AutomationPlugin:OnUnload()
  if self._onOption ~= nil then
    PluginOptions.Unsubscribe(self._onOption)
    self._onOption = nil
  end
  AutomationBridge.Stop()
  AutomationBridge.ClearHandlers()
  self._opts = nil
  eutil.Log("[AutomationPlugin] 自动化执行器已停用")
end

return AutomationPlugin
