--[[
  NetworkRedirectPlugin.lua —— 自定义服务器切换插件

  在若干「服务器预设」之间切换客户端网络路由（预设见 SERVER_PRESETS），并在选中私服时放行验签：
    1. hotfix Torappu.Network.Networker.get_overrideRouterUrl —— 让客户端从所选服务器的
       network_config（路由配置）拉取配置，后续 as/gs/hu/hv 等端点全部指向该服务器；
    2. hotfix Torappu.Network.NetworkRouter._DeserializeRouterContent —— 验签放行（见「验签」小节）。

  当前选择持久化在 plugin_config.json 的 options.network_redirect.server（经 PluginOptions），
  游戏内右下角「服务器」浮窗可一键切换，也可在「选项」面板里左右切换。

  **生效时机**：get_overrideRouterUrl 只在启动取路由配置时读一次 ⇒ 切换后需重启客户端。

  ## 验签上下游（为什么挂在 _DeserializeRouterContent）

  上游：`NetworkRouter._SendFetchConfigService` → `SendGet(<overrideRouterUrl>)`；
  下游：`_DeserializeRouterContent(responseText)` 是**唯一**解析 network_config 的出口，
  内部 `CryptUtils.VerifySignMD5RSA(content, sign, GlobalOptions.cryptoPubKey.text)`，验签失败即 throw。

  `Torappu.CryptUtils` 没有 xLua hotfix 桥（`tmp/dts-dump/Assembly-CSharp.cs` 的 CryptUtils 类无
  `__Hotfix0_` 委托字段），无法直接 hook；但它的**唯一调用方** `_DeserializeRouterContent` 有桥
  （`__Hotfix0__DeserializeRouterContent`，私有静态，需 `xlua.private_accessible`）⇒ 在这里放行。

  放行方式刻意做成**最小作用域 + 三级递进**：
    1. 原实现成功（官服 / 签名匹配）⇒ 原样返回，零副作用；
    2. 失败且选中私服 ⇒ 临时把信任锚 `GlobalOptions.cryptoPubKey` 换成我方公钥（服务端用配套私钥
       签名，见 app/core/utils/rsa-sign.ts 与 scripts/sign-key.ts）重放一次原实现，成败都立即还原；
    3. 仍失败（服务端未配密钥对、sign 为占位符）⇒ 按未验签内容接管（`JsonConvert` 兜底解析）。
  为什么不做「全局换锚」：`VerifySignMD5RSA(byte[],byte[],string)` 这个重载同时服务 network_config、
  excel/DB 的 `CrypticConverter_WithSign` 与 Lua 资产，全局换锚会让官服签名的 excel/DB 资产全部验不过
  （见 docs/lua-asset-signature-2026-09-14.md §146 的同类事故），故只在这一次解析的窗口内换。

  选择官服预设时不放行（原样透传）：官服签名用官方公钥校验，本插件不介入。
  **已替换资产公钥的客户端无法连接官方服务器**（官服响应验签走同样无 hotfix 桥的
  `Torappu.DB.*Converter_WithSign`），切回官服需还原官方公钥资产。

  依赖：Base/BaseModule（Class）、Plugin/core/BasePlugin、Plugin/core/PluginOptions、
        Plugin/ui/PluginUI、Plugin/core/PluginHeartbeat。
--]]
local NetworkRedirectPlugin = Class("NetworkRedirectPlugin", require("Plugin/core/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginUI = require("Plugin/ui/PluginUI")
local PluginOptions = require("Plugin/core/PluginOptions")
local PluginHeartbeat = require("Plugin/core/PluginHeartbeat")

local UnityEngine = CS.UnityEngine

-- 类级元数据（管理器/面板/管理端目录以此为准；与 PluginDefs.lua 保持一致）
NetworkRedirectPlugin.id = "network_redirect"
NetworkRedirectPlugin.name = "服务器切换"
NetworkRedirectPlugin.desc = "在官服/私服预设之间切换网络路由（切换后重启客户端生效）"

local _ID = "network_redirect"

-- 客户端取 network_config 的固定路径（基址 = 预设 base）
local ROUTER_PATH = "/config/prod/official/network_config"

-- 本地私服基址（端口与 data/config.json 的 PORT 一致；客户端与服务端同机时 127.0.0.1 最稳）
local LOCAL_SERVER_BASE = "http://127.0.0.1:8443"
-- 「自定义」预设基址：填自己的域名 / 局域网 IP（含协议与端口，结尾不带斜杠）
local CUSTOM_SERVER_BASE = ""

--[[
  服务器预设（顺序即「服务器」面板行顺序）。

  契约：value 必须与 PluginOptions.Defs 中 network_redirect 的 server 选项 choices 一致
  （守卫见 tests/unit/plugin/plugin-module-layout.test.ts）。

  端址来源：国服/台服取自 docs/多服支持-可行性探索.md 的实测表；日/韩/国际服的 conf 域名
  存在但 `/config/prod/official/*` 路径社区未实测通，标注「路径未实测」。
--]]
local SERVER_PRESETS = {
  { value = "local", label = "本地私服", base = LOCAL_SERVER_BASE, hint = "127.0.0.1:8443（同机私服）" },
  { value = "official_cn", label = "国服官服", base = "https://ak-conf.hypergryph.com", hint = "ak-conf.hypergryph.com" },
  { value = "official_tw", label = "台服官服", base = "https://ak-conf-tw.gryphline.com", hint = "ak-conf-tw.gryphline.com" },
  { value = "official_jp", label = "日服官服", base = "https://ak-conf.arknights.jp", hint = "路径未实测" },
  { value = "official_kr", label = "韩服官服", base = "https://ak-conf.arknights.kr", hint = "路径未实测" },
  { value = "official_en", label = "国际服官服", base = "https://ak-conf.arknights.global", hint = "路径未实测" },
  { value = "custom", label = "自定义", base = CUSTOM_SERVER_BASE, hint = "改文件顶部 CUSTOM_SERVER_BASE" },
}

--[[
  我方验签公钥（.NET XML，须与 `pnpm run sign:key -- --show` 的 public.xml 完全一致；
  长度 243 字节，与官方 asset 内公钥等长，可直接替换 assets/bin/Data/sharedassets0.assets.split5）。

  注意：`pnpm run sign:key -- --sync-plugin` 按「local PUBLIC_KEY_XML + 双中括号字面量」
  的正则回写这一行，改动常量格式会让同步失败。
--]]
local PUBLIC_KEY_XML = [[<RSAKeyValue><Modulus>rMoTooSp2pedN3bvm46CQ+YyPhFwvNiKxv73rG/QxdP3wo6rhD9k852kWlQr9Y5IN6G1E0w6rzPNG8ZIH/AgA+VuTSCV1fSHGu+WiI4ixYaliY8Futth37wObRAOul/CoHxACU7vyo8bs7ZHmUXdOITATwqIOAoHuOPPZYdXhBU=</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>]]

-- 面板尺寸 / 行布局（7 个预设完整放下）
local _PANEL_SIZE = UnityEngine.Vector2(460, 520)
local _ROW_TOP = 170
local _ROW_STEP = 54
local _FLOAT_BTN_POS = UnityEngine.Vector3(-80, -420, 0)

-- 建成前的重试上限与间隔（与其它面板插件一致）
local _MAX_RETRY = 100
local _RETRY_DELAY_SEC = 3

-- 配色
local _COLOR_PANEL = UnityEngine.Color(0.05, 0.05, 0.08, 0.92)
local _COLOR_TITLE = UnityEngine.Color(0.9, 0.9, 1, 1)
local _COLOR_LABEL = UnityEngine.Color(1, 1, 1, 1)
local _COLOR_DESC = UnityEngine.Color(0.65, 0.65, 0.7, 1)
local _COLOR_HINT = UnityEngine.Color(0.6, 0.6, 0.7, 1)
local _COLOR_ROW_ON = UnityEngine.Color(0.2, 0.45, 0.85, 0.75)
local _COLOR_ROW_OFF = UnityEngine.Color(0.18, 0.18, 0.24, 0.7)
local _COLOR_ON = UnityEngine.Color(0.45, 1, 0.55, 1)

--[[
  按 value 取预设。
  @param value 预设标识
  @return 预设表或 nil
--]]
local function _FindPreset(value)
  for _, preset in ipairs(SERVER_PRESETS) do
    if preset.value == value then return preset end
  end
  return nil
end

--[[
  当前生效的预设标识（未配置 / 脏数据回退 local）。
  @return 预设标识字符串
--]]
local function _CurrentValue()
  local value = PluginOptions:Get(_ID, "server")
  if _FindPreset(value) == nil then return "local" end
  return value
end

--[[
  当前选中服务器的 network_config 路由地址。
  @return URL 字符串；预设基址为空（自定义未填写）时返回 nil（跟随客户端默认）
--]]
local function _RouterUrl()
  local preset = _FindPreset(_CurrentValue())
  if preset == nil or preset.base == nil or preset.base == "" then return nil end
  return preset.base .. ROUTER_PATH
end

--[[
  Networker.get_overrideRouterUrl 的包装实现：返回所选服务器的路由地址。
  @param selfObj Networker 实例
  @param orig    链上下一段实现（无预设可用时回退）
  @return 路由 URL
--]]
local function _RouterUrlFix(selfObj, orig)
  local url = _RouterUrl()
  if url ~= nil then return url end
  return orig(selfObj)
end

--[[
  是否私服预设（需要放行验签）：本地私服与自定义（自定义可能指向另一个私服）。
  @param value 预设标识
  @return 私服返回 true
--]]
local function _IsPrivatePreset(value)
  return value == "local" or value == "custom"
end

-- 我方公钥 TextAsset（惰性创建并缓存；创建失败后续调用返回 nil）
local _ourPubKeyAsset = nil

--[[
  取我方公钥 TextAsset（`TextAsset(string)` 构造器）。
  @return TextAsset 或 nil
--]]
local function _OurPubKeyAsset()
  if _ourPubKeyAsset ~= nil then return _ourPubKeyAsset end
  local ok, asset = pcall(function() return CS.UnityEngine.TextAsset(PUBLIC_KEY_XML) end)
  if ok and asset ~= nil then _ourPubKeyAsset = asset end
  return _ourPubKeyAsset
end

--[[
  取 GlobalOptions 单例（客户端全部验签点的信任锚来源：`SingletonScriptableObject<GlobalOptions>`）。
  `instance` 为泛型基类的公有静态属性（官方 Lua 同款写法：`CS.Torappu.PlayerData.instance`），
  `GetInstanceSafe()` 是 DB 转换器实际调用的重载，两者依次兜底。
  @return GlobalOptions 实例或 nil
--]]
local function _GlobalOptions()
  local ok, options = pcall(function() return CS.Torappu.GlobalOptions.instance end)
  if ok and options ~= nil then return options end
  ok, options = pcall(function() return CS.Torappu.GlobalOptions.GetInstanceSafe() end)
  if ok and options ~= nil then return options end
  return nil
end

--[[
  临时把信任锚换成我方公钥。
  @return ok, 原 TextAsset（ok=true 时 prev 可能为 nil，表示原本没有公钥资产）
--]]
local function _PushOurAnchor()
  local asset = _OurPubKeyAsset()
  if asset == nil then return false, nil end
  local options = _GlobalOptions()
  if options == nil then return false, nil end
  local ok, previous = pcall(function()
    local old = options.cryptoPubKey
    options.cryptoPubKey = asset
    return old
  end)
  if not ok then return false, nil end
  return true, previous
end

--[[
  还原信任锚（原地放回原 TextAsset）。
  @param previous 原 TextAsset（可为 nil）
--]]
local function _PopAnchor(previous)
  pcall(function()
    local options = _GlobalOptions()
    if options ~= nil then options.cryptoPubKey = previous end
  end)
end

--[[
  兜底解析：跳过验签，直接把 `{sign, content}` 的 content 反序列化成
  `Torappu.Network.NetworkRouterConfig.Content`（服务端未配置密钥对、sign 为占位符时用）。

  Content 属 Torappu.Common 程序集（NetworkRouter 属 Assembly-CSharp，跨程序集返回），
  故用 `JsonConvert.DeserializeObject(string, Type)` 非泛型重载 + 程序集限定类型名。
  任一步失败返回 nil（调用方原样重抛原异常），绝不把错误抛进 C# 调用链。

  @param responseText 服务端返回的 `{sign, content}` 原文
  @return Content 实例或 nil
--]]
local function _ParseRouterContentUnverified(responseText)
  if type(responseText) ~= "string" then return nil end
  local ok, content = pcall(function()
    local rapidjson = require("rapidjson")
    local envelope = rapidjson.decode(responseText)
    if type(envelope) ~= "table" then return nil end
    local contentJson = envelope.content
    if type(contentJson) ~= "string" then return nil end
    local contentType = CS.System.Type.GetType("Torappu.Network.NetworkRouterConfig+Content, Torappu.Common")
    if contentType == nil then return nil end
    return CS.Newtonsoft.Json.JsonConvert.DeserializeObject(contentJson, contentType)
  end)
  if not ok or content == nil then return nil end
  return content
end

--[[
  `NetworkRouter._DeserializeRouterContent(responseText)` 的包装实现。

  三级处理（越靠前越保守）：
    1. 原实现直接成功（官服 / 已换公钥 / 签名匹配）⇒ 原样返回，零副作用；
    2. 私服预设且原实现抛错 ⇒ 临时把信任锚换成我方公钥重放一次原实现
       （解析仍走游戏自身路径，不做 Lua 侧重建），成败都立即还原；
    3. 仍失败（服务端未配密钥对，sign 为占位符）⇒ 按未验签内容接管（兜底解析）。

  @param responseText 服务端返回的 `{sign, content}` 原文
  @param orig         链上下一段实现（原 `_DeserializeRouterContent`）
  @return NetworkRouterConfig.Content
--]]
local function _DeserializeRouterContentFix(responseText, orig)
  local ok, result = pcall(orig, responseText)
  if ok and result ~= nil then return result end
  if not _IsPrivatePreset(_CurrentValue()) then
    -- 官服预设：不介入验签，按原样重放（保留原异常类型与语义）
    return orig(responseText)
  end

  local pushed, previous = _PushOurAnchor()
  if pushed then
    local okRetry, retried = pcall(orig, responseText)
    _PopAnchor(previous)
    if okRetry and retried ~= nil then
      eutil.Log("[NetworkRedirectPlugin] network_config 验签已按我方公钥放行")
      return retried
    end
    eutil.Log("[NetworkRedirectPlugin] 换锚重放仍失败（公钥与私钥不匹配？跑 pnpm run sign:key -- --sync-plugin）")
  else
    eutil.Log("[NetworkRedirectPlugin] 信任锚不可用（GlobalOptions 未就绪）")
  end

  local bypassed = _ParseRouterContentUnverified(responseText)
  if bypassed ~= nil then
    eutil.Log("[NetworkRedirectPlugin] network_config 已按未验签内容接管")
    return bypassed
  end

  -- 放行失败：原样重放，让原异常按原路径抛出（不做二次包装）
  return orig(responseText)
end

--[[
  静态方法包装自适应：xLua 各版本对静态方法的 `self` 约定不同（带 nil self / 不带），
  PluginHotfix 的包装链会把 (实参, orig) 或 (self, orig, 实参) 传进来。
  这里按「orig 是 function」定位 orig，其余第一个非 nil 值即首个实参。
  @param handler function(arg, orig)
  @return 适配后的包装函数
--]]
local function _Static1Fix(handler)
  return function(a, b, c)
    local orig = nil
    if type(a) == "function" then orig = a
    elseif type(b) == "function" then orig = b
    elseif type(c) == "function" then orig = c end
    if orig == nil then return nil end
    local arg = nil
    if a ~= nil and a ~= orig then arg = a
    elseif b ~= nil and b ~= orig then arg = b
    elseif c ~= nil and c ~= orig then arg = c end
    return handler(arg, orig)
  end
end

--[[
  插件启用：安装路由重定向补丁 + 验签处理，并构建切换面板。
--]]
function NetworkRedirectPlugin:OnLoad()
  self._root = nil
  self._floatBtn = nil
  self._canvas = nil
  self._listRoot = nil
  self._urlText = nil
  self._open = false
  self._retryActive = false

  -- 选项变更（面板点选 / 服务端心跳下发）即时刷新面板与生效地址
  self._onOption = PluginOptions.Subscribe(function(id)
    if id ~= _ID then return end
    self:Refresh()
  end)

  self:Hotfix(CS.Torappu.Network.Networker, "get_overrideRouterUrl", _RouterUrlFix)

  -- 验签放行：挂在 network_config 解析的唯一出口（私有静态，需先开放私有访问）
  pcall(function() xlua.private_accessible(CS.Torappu.Network.NetworkRouter) end)
  self:Hotfix(CS.Torappu.Network.NetworkRouter, "_DeserializeRouterContent", _Static1Fix(_DeserializeRouterContentFix))
  eutil.Log("[NetworkRedirectPlugin] 服务器切换已启用: " .. _CurrentValue())

  self:_EnsureCanvasAndBuild()
  -- 自愈链：TimerModel 就绪前登记待补排，就绪后按间隔重试/巡检
  PluginUI.RetryEnsure(self, _MAX_RETRY, _RETRY_DELAY_SEC)
  -- 兜底：进入战斗 UI（必然晚于登录与主界面）时再次尝试构建
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    self:_EnsureCanvasAndBuild()
  end)
end

--[[
  确保面板已构建：先按存活状态清理被场景切换销毁的引用，再查找 Canvas 重建；
  Canvas 缺失时由 PluginUI 的自愈链继续重试。
--]]
function NetworkRedirectPlugin:_EnsureCanvasAndBuild()
  if not PluginUI.IsAlive(self._root) then
    self._root = nil
    self._listRoot = nil
    self._urlText = nil
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
  if self._floatBtn == nil then
    self._floatBtn = PluginUI.CreateFloatingButton(self._canvas, "服务器", _FLOAT_BTN_POS, function()
      self:TogglePanel()
    end)
  end
  if self._root == nil then
    self:_BuildPanel()
  end
end

--[[
  构建面板主体（初始隐藏）：标题 + 预设列表容器 + 生效地址 + 提示。
--]]
function NetworkRedirectPlugin:_BuildPanel()
  -- 位置：屏幕居中略偏上（460x520），与右下角浮窗按钮、其它插件面板互不遮挡
  local root = PluginUI.CreateImage(self._canvas, "ServerSwitchPanel(Clone)", UnityEngine.Vector3(0, 20, 0), _PANEL_SIZE, _COLOR_PANEL)
  local title = PluginUI.CreateText(root.transform, "Title", UnityEngine.Vector3(0, _PANEL_SIZE.y / 2 - 26, 0), UnityEngine.Vector2(440, 40), 26, _COLOR_TITLE)
  -- 拖标题栏 = 拖动整块面板（命中用标题、移动的是 root）
  PluginUI.EnableDrag(root, nil, title, false)
  title.alignment = UnityEngine.TextAnchor.MiddleCenter
  title.text = "服务器切换"
  -- 列表容器：重建只清容器子节点，标题与底部文本得以保留
  self._listRoot = PluginUI.CreateContainer(root.transform, "List", UnityEngine.Vector3.zero, UnityEngine.Vector2(420, 400))
  self._urlText = PluginUI.CreateText(root.transform, "Url", UnityEngine.Vector3(0, -(_PANEL_SIZE.y / 2 - 48), 0), UnityEngine.Vector2(430, 20), 12, _COLOR_DESC)
  self._urlText.alignment = UnityEngine.TextAnchor.MiddleCenter
  local hint = PluginUI.CreateText(root.transform, "Hint", UnityEngine.Vector3(0, -(_PANEL_SIZE.y / 2 - 24), 0), UnityEngine.Vector2(430, 30), 12, _COLOR_HINT)
  hint.alignment = UnityEngine.TextAnchor.MiddleCenter
  hint.text = "切换后重启客户端生效；已替换资产公钥时无法连接官服"
  self._root = root
  self._root:SetActive(false)
  self:Refresh()
end

--[[
  重建预设列表并刷新生效地址（开合、切换、选项变更后调用）。
--]]
function NetworkRedirectPlugin:Refresh()
  if self._root == nil or self._listRoot == nil then return end
  PluginUI.ClearChildren(self._listRoot)
  local current = _CurrentValue()
  local y = _ROW_TOP
  for _, preset in ipairs(SERVER_PRESETS) do
    local isCurrent = preset.value == current
    local row = PluginUI.CreateImage(
      self._listRoot,
      "Row_" .. preset.value,
      UnityEngine.Vector3(0, y, 0),
      UnityEngine.Vector2(420, 48),
      isCurrent and _COLOR_ROW_ON or _COLOR_ROW_OFF
    )
    local name = PluginUI.CreateText(row.transform, "Name", UnityEngine.Vector3(-120, 9, 0), UnityEngine.Vector2(200, 22), 18, _COLOR_LABEL)
    name.text = preset.label
    local hint = PluginUI.CreateText(row.transform, "Hint", UnityEngine.Vector3(-120, -13, 0), UnityEngine.Vector2(200, 16), 11, _COLOR_DESC)
    hint.text = preset.hint or tostring(preset.base or "")
    local state = PluginUI.CreateText(row.transform, "State", UnityEngine.Vector3(140, 0, 0), UnityEngine.Vector2(110, 24), 15, isCurrent and _COLOR_ON or _COLOR_DESC)
    state.alignment = UnityEngine.TextAnchor.MiddleCenter
    state.text = isCurrent and "当前" or "切换"
    -- 不用 UGUI.Button（自建 Overlay 画布上会点击穿透）；统一走自绘点击
    local value = preset.value
    PluginUI.EnableClick(row, function()
      self:_Select(value)
    end)
    y = y - _ROW_STEP
  end
  if self._urlText ~= nil then
    local url = _RouterUrl()
    self._urlText.text = url ~= nil and url or "（该预设基址为空，跟随客户端默认路由）"
  end
end

--[[
  选择服务器预设：写选项（持久化 + 广播）→ 推送服务端 → 刷新面板。
  路由在下次启动读 network_config 时生效（面板已提示重启）。
  @param value 预设标识
--]]
function NetworkRedirectPlugin:_Select(value)
  local applied = PluginOptions:Set(_ID, "server", value)
  if applied == nil then return end
  xpcall(function() PluginHeartbeat.PushOption(_ID, "server", applied) end, debug.traceback)
  self:Refresh()
end

--[[
  开合面板（面板未构建时先尝试构建，失败则静默返回）。
--]]
function NetworkRedirectPlugin:TogglePanel()
  if self._root == nil then
    self:_EnsureCanvasAndBuild()
    if self._root == nil then
      eutil.LogHotfixError("[NetworkRedirectPlugin] 面板未构建，无法开合（Canvas 尚不可用）")
      return
    end
  end
  self._open = not self._open
  self._root:SetActive(self._open)
  if self._open then
    -- 面板盖在按钮上会拦截点击，展开时把按钮提到最上层，保证还能点回去
    PluginUI.BringToFront(self._floatBtn)
    self:Refresh()
  end
end

--[[
  插件停用：退订选项、销毁面板与浮动按钮（补丁由基类统一注销）。
--]]
function NetworkRedirectPlugin:OnUnload()
  if self._onOption ~= nil then
    PluginOptions.Unsubscribe(self._onOption)
    self._onOption = nil
  end
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
  self._urlText = nil
  self._open = false
  self._retryActive = false
  eutil.Log("[NetworkRedirectPlugin] 服务器切换已停用")
end

return NetworkRedirectPlugin
