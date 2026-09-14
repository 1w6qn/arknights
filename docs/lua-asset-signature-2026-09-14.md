# 「重加密的 Lua 为什么被客户端拒绝」——128B 头是 RSA-MD5 签名

2026-09-14。回答 `docs/lua-load-chain-reconstructed-2026-09-14.md` §8.3 留下的那个悬案：
**凡是被我们重新加密过的 Lua 资产，`LuaManager._CustomLoader` 一律返回 null。** 现在根因已确证，
而且这条结论把「改 Lua 资产」这条路**重新打开了**。

## 0. 结论（一句话）

`TextAsset.m_Script` 的 128 字节头**不是随机数据，而是 RSA-1024 / PKCS#1 v1.5 / MD5 签名**，
签名覆盖 `script[128:]`（16B IV 域 + AES 密文），由客户端
`Torappu.CryptUtils.VerifySignMD5RSA(byte[] contentBytes, byte[] sign, string publicKey)`（RVA `0x042FD3F0`）
用 `GlobalOptions.cryptoPubKey` 校验。我们只换了密文却留着旧签名 ⇒ 验签失败 ⇒ 加载器返回 null。

## 1. 判定证据（全部本地可复跑，不需要设备）

脚本：`tmp/verify-official-key.ts`、`tmp/analyze-lua-roundtrip.ts`、`tmp/analyze-lua-signature.ts`、
`tmp/prove-lua-resign.ts`。

| 命题 | 方法 | 结果 |
| --- | --- | --- |
| 官方公钥怎么读 | 用官服 `/config/prod/official/network_config` 的真实 `sign`+`content` 反证端序与摘要 | **大端 + MD5 验签通过**（小端解读 ✗）⇒ 官方 XML 的 Modulus 是**大端**；官方指数 `EQ==` = **17** |
| 我们的 AES 模型是否精确 | 344 个资产：用官方 IV 原样重加密，比对是否逐字节复现官方密文 | **344/344 复现** ⇒ 加解密模型与客户端完全一致 |
| 128B 头是不是签名 | 对 344 个头做 `head^e mod n`，看是否 PKCS#1 v1.5 结构并解析 DigestInfo | **344/344 结构成立，摘要一律 == MD5(script[128:])** |
| 签名用的是哪把钥匙 | 换 `data/crypto/public.xml` 再验 | **0/344**（负对照通过） |
| 重签名能否满足客户端契约 | 解密 → **新 IV** 重加密 → 用 `data/crypto/private.pem` 重签 `script[128:]` → 按同一契约验签 | **344/344 通过**（@private.pem 导出公钥）；@官方公钥 0/344 |

⇒ 早先「头是随机数据、加载期无完整性校验」的判断**是错的**：校验不在 `CrypticConverter_A`
（它确实只做 AES），而在**方法体不可读的 `LuaManager._CustomLoader`** 里内联实现；
`CrypticConverter_WithSign`（`SIGN_HEADER_LENGTH = 128` + `_CheckIfSignMatchOrThrow`）只是同一套契约的
「可读版本」，容易让人以为签名校验只服务于 excel。

## 2. 之前几个对照实验为何全部失败（现在都能解释）

| 实验 | 当时的解释 | 真因 |
| --- | --- | --- |
| 明文改成等长 | 排除长度校验 | 长度本来就不是问题；**签名覆盖的是密文，明文等长无用** |
| 保留原始 128B 头 | 排除头校验 | 头是签名，但**被签的内容（IV+密文）已经变了** |
| 明文逐字节相同、只换 IV | 说明「客户端拒绝任何重加密」 | 只换了 IV 也足以让签名失效（签名覆盖 `script[128:]`，IV 在其中） |
| 同 bundle 内未改动资产正常 | — | 它们的签名仍然有效 |

## 3. 由此打开的路（以及新的前置条件）

1. **重签名原语已落地**（`scripts/vendor/lua-crypt.ts`）：
   - `signLuaScript(script, privateKeyPem)` —— 把 128B 头换成 `RSA-1024/MD5(script[128:])`；
   - `verifyLuaScriptSignature(script, publicKeyXml)` —— 按客户端契约自检；
   - `parseDotNetPublicKeyXml(xml)` —— **大端**解析 .NET XML 公钥。
   配合 `hook/il2cpp-client-redirect.ts` 的运行时公钥替换（或 `sign:key --patch-apk` 改 APK 资产），
   我们自己重打包的 Lua bundle / 直接嵌进 APK 的 Lua 资产就有机会被接受。
2. **必须先修的端序问题（已修，见 §6）**：`data/crypto/public.xml` 里的 Modulus 与官方约定**相反**
   （被 `sign-key.ts` 按 CAPI 小端写出：`private.pem` 导出 n 的前 16B = `acca13a284a9da979d3776ef9b8e8243`，
   而文件里写的是 `1584578765cfe3b8070a38880a4fc084` = 前者的逐字节反转，Exponent 巧合相同）。
   客户端读官方 XML 是「按原样（大端）」，所以替换公钥时必须换成**大端写法**，
   否则客户端算出的模数是错的、我们的签名照样验不过。
3. **hook 漏挂 byte[] 重载（已补）**：`hookVerifySign` 原本只挂了
   `VerifySignMD5RSA(System.String,System.String,System.String)`（`0x042FD310`，网络响应用），
   而 **Lua 资产走的是 `(System.Byte[],System.Byte[],System.String)`（`0x042FD3F0`）** —— 现已一起挂上，
   并加了 `--pubkey-mode` 端序 A/B。

## 4. 复跑

```bash
# 1) 校准「公钥怎么读」（需要官服响应；已存 tmp/official-netcfg.json）
node node_modules/tsx/dist/cli.mjs tmp/verify-official-key.ts
# 2) 密文往返一致性（证明 AES 模型精确）
node node_modules/tsx/dist/cli.mjs tmp/analyze-lua-roundtrip.ts
# 3) 128B 头 = 签名 的判定
node node_modules/tsx/dist/cli.mjs tmp/analyze-lua-signature.ts
# 4) 重签名满足客户端契约的端到端本地证明
node node_modules/tsx/dist/cli.mjs tmp/prove-lua-resign.ts
```

## 6. 设备端 A/B 与端序修复（同日续作，已完成）

### 6.1 实验

新增 `scripts/frida-mumu-arm64.py --pubkey-mode asis|flip|ab|ours`：在
`VerifySignMD5RSA(Byte[],Byte[],String)` 的 onEnter 里**改写第三个参数（公钥）**，并在 onLeave 记录真实返回值。
官方公钥的两种写法由管线在构建时从官方 APK 提取注入（`__OFFICIAL_PUBKEY_BE__` / `__OFFICIAL_PUBKEY_LE__`）。

```
python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js \
  --java-script "" --pubkey-mode ab --duration 70 > tmp/ab-run.log 2>&1     # 交替：奇数次原样(BE)、偶数次反转(LE)
python3 scripts/frida-mumu-arm64.py … --pubkey-mode asis --duration 60 > tmp/ctrl-run.log 2>&1   # 对照
```

| 运行 | 判定 | 结果 |
| --- | --- | --- |
| `ab` | `BE(as-is)` | `ok: true`（call 1/3/5/7…） |
| `ab` | `LE(flipped)` | `ok: false`（call 2/4/6/8…） |
| `asis`（对照） | 原样不动 | 60/60 `ok: true`，**344 个 Lua 资产全部加载**，插件注入成功，**0 崩溃** |

⇒ **客户端按原样（大端）解读 `<RSAKeyValue>` 的 Modulus。**

### 6.2 附带发现：验签失败是**致命**的

`ab` 轮里那半批被判 false 的官方资产，直接让客户端在 `UnityMain` 线程 **SIGABRT**
（`signal 6 (SIGABRT), code 0 (SI_USER)`；`tmp/ab-run.log`），只有 2 个 Lua 资产加载成功；
而对照组（全部 true）跑完 344 个资产毫无异常。⇒ 客户端对 Lua 资产签名**不容错**：
验签失败不是"返回 null 继续"，而是**未处理异常 → 进程 abort**（与可读源码里
`CrypticConverter_WithSign._CheckIfSignMatchOrThrow` 的 `throw new NullReferenceException()` 同构）。

### 6.3 已落地的修复

1. `scripts/sign-key.ts`：`publicKeyToDotNetXml` / `dotNetXmlToPublicKey` 改为**大端原样读写**
   （历史实现是 CAPI 小端，注释里写明端序结论与证据，防止回归）。
2. `data/crypto/public.xml` 按大端重写（**仍是 243 字节**，与官方等长，满足 APK 资产内等长替换；
   旧文件备份在 `tmp/public.xml.le.bak`）。密钥对未变。
3. `node scripts/sign-key.ts --sync-plugin` 重新同步 `lua/plugin/NetworkRedirectPlugin.lua` 内嵌公钥
   （否则插件侧的 strict 验签仍用旧端序）。
4. 本地证明（`tmp/prove-lua-resign.ts`）现在四项全绿：

```
官方原件签名 @官方公钥:                    344/344
重加密+我们重签名 @private.pem 导出公钥:   344/344
重加密+我们重签名 @data/crypto/public.xml: 344/344   ← 修复前是 0/344
重加密+我们重签名 @官方公钥:               0/344（负对照）
重签名产物解密回原明文:                    344/344
```

### 6.4 端到端设备验证（已通过 ✅）

做法（不依赖客户端下载流程，直接把重签产物放进客户端缓存——本机自用调试）：

1. `scripts/inject-lua-inplace.ts` 新增 `--key` / `--resign-all`：改写目标资产后**用我们私钥重签名**，
   并把 bundle 内**全部** 344 个 TextAsset 一并重签（长度不变 ⇒ SF 结构零改动）。
   产物 `tmp/resign-mod/anon_63bbacd2….dat`，本地全量校验 **344/344** 通过（`tmp/verify-resigned-mod.ts`）。
2. 把该 UnityFS（1,125,071B，md5 `8cde8885…`）写入客户端缓存
   `<files>/Bundles/anon/63bbacd2….bin`，并把 `persistent_res_list.json` / `hot_update_list.json` 里这条
   的 `abSize` 改成 1,125,071（`meta:1` ⇒ 客户端只比对长度，md5 不校验），
   `hash`/`md5` 令牌改成 `8cde`；原文件备份为 `.official` / `.bak`。
3. 跑 `--pubkey-mode ours`（运行时把 Lua 验签的公钥换成我们的）。

结果（`tmp/ours-run4.log`）：

```
CRASH: 0
verify-bin ok/总: 60 / 60            ← 我们的签名被客户端全部接受
lua-load: 400（含 HotFixes/TestStubHotfixer → len=347，
          head='local T=Class("T",HotfixBase)\nfunction T:OnI…'）← 我们注入的引导被加载
设备 /sdcard/Android/data/…/files/plugin_boot_trace.txt = "i"  ← 注入的 Lua 真的执行了
```

⇒ **"改 Lua 资产"这条路彻底打通**：不需要 frida 往 Lua VM 里灌代码了，frida 只剩"换公钥 + 观测"。

**关键实现细节（不这样做会踩坑）**：换公钥必须**只在 `_CustomLoader` 上下文里**做。
`VerifySignMD5RSA(byte[],byte[],string)` 这个重载同时服务 Lua 资产与 excel/DB 的
`CrypticConverter_WithSign` 资产；早先不分场合全局换，导致 DB/excel 官方签名全部验不过、
客户端卡在 DB 阶段（实测 `ours` 只走到 2 次验签、Lua 一个都没加载）。
现在用 `_CustomLoader` onEnter/onLeave 维护 `luaLoaderDepth`，非 Lua 上下文保持官方公钥。

**操作约束**：缓存里换成了我们签名的 bundle 之后，**每次启动都必须带换公钥的 hook**，
否则 Lua 验签失败（且是 abort 级）。要摆脱这个依赖，有两条路：
① `sign:key --patch-apk` 把 APK 资产里的公钥换成我们的（243B 等长，已支持）；
② 或保留官方 bundle、只让"我们额外下发的 Lua"走我们的签名（需要更细的验签分流）。

### 6.5 下一步

1. **把插件源码也走资产路线**：Lua bundle 里最大的 TextAsset 明文只有 33,793B
   （`MainlineBpViewModel.lua`），而 `lua/plugin/*.lua` 合计约 59KB ⇒ 一个资产装不下。
   可行做法：引导脚本改为**从私服拉插件源码**（游戏 Lua 里已有 `UISender` 可发 HTTP），
   取回文本后 `load()` + 装 searcher + `require "Plugin/PluginEntry"` —— 全部不需要 frida 注入 Lua。
2. **嵌进 APK**：`sign:key --patch-apk`（243B 大端 XML）+ APK 内联重签名 Lua；
   剩下的仍是"重签名 APK 被 ACE 杀"的老问题。
3. 把 `mods/android/*.disabled` 那批旧产物按新契约（重签名）重做，避免误导后续排查。

### 6.6 续作：插件源码走 HTTP 下发（**已打通 ✅**）

思路：资产内只放几百字节引导 → 运行时拉 `GET /plugin/lua` → `load()` 执行（插件源码 ~83KB 装不进单个资产）。

**链路与证据**（`tmp/fetch-run11.log` + 设备 trace 文件 + 私服日志）：

```
资产内引导（AVGStickerAutoClickHotfixer，官方 DefinedFix 列表内）
  → 帧轮询等到 UISender 就绪
  → UISender.me:SendGet("/plugin/lua")            ← 私服日志：172.30.32.1 GET /plugin/lua
  → 私服：PluginLua 下发插件 Lua chunk（16 个模块，83231B）
  → 引导解码 JSON → load() 执行
  → 设备 plugin_lua_trace.txt  = [DTS-http] DTS_PLUGIN_OK enemy_hp=1 … network_redirect=1
  → 设备 plugin_boot_trace.txt = [DTS] chunk ok: DTS_PLUGIN_OK enemy_hp=1 … network_redirect=1
  → 私服：PluginHeartbeat 客户端插件系统生效确认: 共 6 个插件，启用 6 个（6 个全 ON）+ GET /plugin/heartbeat
```

本轮 0 崩溃、`verify-bin` 60/60 通过、344 个 Lua 资产加载。

**踩到的两个 API 契约（都不看官方 Lua 源码就会卡住）**：

1. **回调必须是带 `Call` 方法的对象，不能是裸函数**。
   `data/[uc]lua/UISender.lua:126` 的 `ExportOnProceed` 里是 `callback.onProceed:Call(response)`；
   游戏自己的 Lua 一律传 `Event.Create(self, fn)`（`data/[uc]lua/Event.lua`）。
   传裸函数不会报错，只是**永远不回调**（我们为此白跑了 3 轮）。
2. **响应体被包一层 `{ text = <原始响应体> }`**。
   回调拿到的 table 实测 `keys=text:string`，需要先取 `.text` 再 `require("rapidjson").decode(...)`，
   然后才在解出的表里找 `lua` 字段（`findLua` 递归 ≤3 层，兼容 `result` 等包装）。

**另附一个反直觉的触发点结论**：`xlua.hotfix(LuaManager,"Update")` 与 `_DoUpdate` 都**装得上却不被调用**，
真正每帧触发的是 `CS.Torappu.GlobalInitializerAndUpdater.Update` —— 帧驱动轮询就用它。

**现状**：插件系统现在有两条独立交付路径：
① 纯运行时 frida 注入（`hook/il2cpp-client-redirect.ts`，已验证 6/6 ON）；
② **资产内引导 + 私服 HTTP 下发**（本节，已 6/6 ON，frida 只剩"换公钥"的作用）。
两条都幂等，可同时存在。

## 7. 「修改 APK」的实测结论：ACE 击杀（同日收尾）

既然重签名与公钥替换都已就绪，本轮把改造包真做出来并上机验证了一次。

**产物**（可复跑）：
1. 从官方 APK 取出公钥资产 `assets/bin/Data/sharedassets0.assets.split5`，把其中的
   `<RSAKeyValue>`（243B）**等长**替换成我们的（大端、243B）；
2. `scripts/apk-url-redirect.ts` 在**同一趟**里完成域名等长改写 + 该资产替换
   （`--replace assets/bin/Data/sharedassets0.assets.split5=…`）→ `tmp/apk-out/dts-mod-unsigned.apk`
   （1.883GB，21.7s，替换 2 条）；
3. `scripts/apk-sign.ts` 用 debug 密钥签名 → `tmp/apk-out/dts-mod-debugSigned.apk`（v2+v3 校验通过）。

顺带确认：**Lua bundle 并不在 APK 里**（3688 个条目中没有 `anon/63bbacd2….bin`）——
它是客户端按 `.idx` 从资源 CDN 下载的，而那个 CDN 就是我们的私服。
也就是说「Lua 内容」这一半根本不需要改 APK；改 APK 只为两件事：域名改写（免 frida 重定向）
与公钥替换（免 frida 换公钥）。

**上机结果：被 ACE 击杀**（本次**未改包名**，所以与包名无关）：

```
D houdini     : #00 pc 000…456830 …/lib/arm64/libtersafe2.so     ← 崩溃栈整条都在 ACE 里
I ActivityManager: Process com.hypergryph.arknights (pid 20975) has died: fg TOP
I Zygote      : Process 20975 exited due to signal 11 (Segmentation fault)
```
时间线：`am start` → 起了 `UserProtocolNoticeActivity` + `U8UnityContext` → 约 **10 秒**后 SIGSEGV 死亡。
官方包在同机同环境长期零崩溃 ⇒ **触发因素就是"APK 被重新签名"**。

⇒ 结论：**在 MuMu 上，任何重签名过的明日方舟 APK 都会被 ACE 立刻击杀**（不是 Lua 层问题、不是包名问题）。
所以"改 APK"的现实边界是：

- 需要的两件事**都能在运行时做**：域名重定向（`hook/java-redirect.ts` + `hook/il2cpp-client-redirect.ts` 重写 URL）、
  换公钥（同一脚本在 `VerifySignMD5RSA` 参数上替换）；
- Lua 内容本来就由私服下发（`anon/63bbacd2….bin`），我们完全控制，且已按 §6 重签名并被客户端接受；
- 于是当前可用形态 = **官方 APK（未改、不被杀）+ frida 换公钥/重定向 + 私服下发重签名 Lua**，
  插件 6/6 ON（§6.6），**不需要动 APK**。

（本轮为验证动过客户端：卸载官方包 → 装改造包 → 确认被杀 → 装回官方包；
客户端外部数据已备份在 `tmp/client-data-backup/`；设备 `/etc/hosts` 已写入 9 条 `*x` 域名 → 127.0.0.1。）

## 8. 影响面（要一并修的旧结论）

- `scripts/vendor/lua-crypt.ts` 的头注释已改（原写「128B 随机头…保留即可」）。
- `docs/lua-load-chain-reconstructed-2026-09-14.md` §2/§3/§8.3 中「无 Lua 签名校验」「头是随机数据」
  的结论按本文更正；§8.3 剩余候选①（解密器对密文有更严约束）**已确证**。
- `mods/android/*.disabled` 那批产物都是**未重签名**的，客户端必然拒绝——不再作为「bundle 路线不通」
  的证据；重签名后再测。
