--[[
  NetworkRedirectPlugin.lua —— 私服引导插件

  把官服客户端引导到本私服，纯 Lua hotfix 实现（无需 Frida）：
    1. hotfix Torappu.Network.Networker.get_overrideRouterUrl —— 让客户端从私服拉取
       network_config（路由配置），后续 gameServer/sdkServer 等全部指向私服；
    2. hotfix Torappu.CryptUtils.VerifySignMD5RSA —— 返回 true 绕过 RSA 签名校验
       （官服对 network_config 与 BSON 响应做 RSA-MD5 签名，见
       NetworkRouter.cs:409 / BsonNetConverter_WithSign.cs:56，私服无对应私钥必须绕过）。

  说明：
    - Networker 实现 IHotfixable 且 get_overrideRouterUrl 有 __Hotfix0_get_overrideRouterUrl
      委托字段，属性 getter 可被 xLua hotfix（方法名 get_xxx）。
    - 本插件在游戏启动早期（DefinedFix 管线 → HotfixProcesser.Do）加载，早于网络模块初始化，
      因此 getter 首次被读取时即命中私服地址。
    - 私服地址改 SERVER_URL 即可；默认与 hook/main.ts（Frida 版）保持一致。

  依赖：Base/BaseModule（Class）、Plugin/BasePlugin、Plugin/PluginHotfix。
--]]
local NetworkRedirectPlugin = Class("NetworkRedirectPlugin", require("Plugin/BasePlugin"))
local eutil = CS.Torappu.Lua.Util

-- 类级元数据（管理器/面板/管理端目录以此为准；与 PluginDefs.lua 保持一致）
NetworkRedirectPlugin.id = "network_redirect"
NetworkRedirectPlugin.name = "私服引导"
NetworkRedirectPlugin.desc = "将客户端网络路由与签名校验重定向到本私服（保持启用，关闭则连不回私服）"

-- 私服地址（改为你机器的局域网 IP / 域名；端口与 data/config.json 的 server 一致）
-- 客户端与服务端同机时用 127.0.0.1 最稳（绕开防火墙）；跨设备联机时改为本机局域网 IP。
local SERVER_URL = "http://127.0.0.1:8443"

--[[
  验签模式：
    "strict" —— 用本插件内置公钥**真实验签**（服务端用配套私钥签名，见 app/core/utils/rsa-sign.ts
                 与 scripts/sign-key.ts）。语义等于「把信任锚换成我方密钥」，签名不符仍会失败。
    "bypass" —— 恒返回 true（本仓历史行为；未替换 asset 公钥、服务端未签名时使用）。
  MD5 的 OID：RSACryptoServiceProvider.VerifyHash 需要 OID 而不是 "MD5" 名称。
--]]
local SIGN_MODE = "strict"
local MD5_OID = "1.2.840.113549.2.5"

--[[
  我方验签公钥（.NET XML，须与 `pnpm run sign:key -- --show` 的 public.xml 完全一致；
  长度 243 字节，与官方 asset 内公钥等长，可直接替换 assets/bin/Data/sharedassets0.assets.split5）。
--]]
local PUBLIC_KEY_XML = [[<RSAKeyValue><Modulus>rMoTooSp2pedN3bvm46CQ+YyPhFwvNiKxv73rG/QxdP3wo6rhD9k852kWlQr9Y5IN6G1E0w6rzPNG8ZIH/AgA+VuTSCV1fSHGu+WiI4ixYaliY8Futth37wObRAOul/CoHxACU7vyo8bs7ZHmUXdOITATwqIOAoHuOPPZYdXhBU=</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>]]

--[[
  Networker.get_overrideRouterUrl 的替换实现：返回私服 network_config 路由地址。
  @return 私服路由 URL
--]]
local function _RouterUrlFix(self)
  return SERVER_URL .. "/config/prod/official/network_config"
end

--[[
  CryptUtils.VerifySignMD5RSA 的替换实现（strict）：用我方公钥做 RSA-MD5 真实验签。
  客户端两个重载（string,string,string / byte[],byte[],string）按实参类型自适应。
  @param a 内容（string 或 byte[]）
  @param b 签名（base64 string 或 byte[]）
  @return boolean 验签是否通过（异常时记错误日志并返回 false）
--]]
local function _VerifySignStrict(self, a, b, c)
  local ok, result = xpcall(function()
    local contentBytes = type(a) == "string" and CS.System.Text.Encoding.UTF8:GetBytes(a) or a
    local signBytes = type(b) == "string" and CS.System.Convert.FromBase64String(b) or b
    local rsa = CS.System.Security.Cryptography.RSACryptoServiceProvider()
    rsa:FromXmlString(PUBLIC_KEY_XML)
    local md5 = CS.System.Security.Cryptography.MD5.Create()
    local hash = md5:ComputeHash(contentBytes)
    return rsa:VerifyHash(hash, MD5_OID, signBytes)
  end, debug.traceback)
  if not ok then
    eutil.LogError("[NetworkRedirectPlugin] 真实验签异常: " .. tostring(result))
    return false
  end
  return result == true
end

--[[
  CryptUtils.VerifySignMD5RSA 的替换实现（bypass）：恒返回 true（历史兜底）。
  @return true
--]]
local function _VerifySignFix(self, a, b, c)
  return true
end

--[[
  插件启用：安装私服引导补丁（路由重定向 + 验签处理）。
--]]
function NetworkRedirectPlugin:OnLoad()
  self:Fix_ex(CS.Torappu.Network.Networker, "get_overrideRouterUrl", _RouterUrlFix)
  if SIGN_MODE == "strict" then
    self:Fix_ex(CS.Torappu.CryptUtils, "VerifySignMD5RSA", _VerifySignStrict)
    eutil.Log("[NetworkRedirectPlugin] 私服引导已启用（真实验签）: " .. SERVER_URL)
  else
    self:Fix_ex(CS.Torappu.CryptUtils, "VerifySignMD5RSA", _VerifySignFix)
    eutil.Log("[NetworkRedirectPlugin] 私服引导已启用（兜底放行）: " .. SERVER_URL)
  end
end

function NetworkRedirectPlugin:OnUnload()
  eutil.Log("[NetworkRedirectPlugin] 私服引导已停用")
end

return NetworkRedirectPlugin
