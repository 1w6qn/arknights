# 私服验签换钥与 hook（2026-09-13）

- 目标：不用「无条件放行」的绕过方式，而是**换成我们自己的 RSA 密钥对**——客户端 asset 内公钥替换为我方公钥，
  服务端用配套私钥**真实签名**，客户端照常验签（签名不符仍会失败）；同时给出 Lua 侧与 Frida 侧的 hook 手段。
- 配套：`scripts/sign-key.ts`、`app/core/utils/rsa-sign.ts`、`lua/plugin/NetworkRedirectPlugin.lua`、`hook/verify-sign.js`。

## 1. 先弄清「什么真的在验签」（C# 证据）

| 对象 | 校验方式 | 证据 |
| --- | --- | --- |
| `network_config`（路由配置） | **RSA-MD5 验签** | `Torappu.Network/NetworkRouter.cs:407-411` → `CryptUtils.VerifySignMD5RSA(content, sign, pubKey)`，失败即 `throw` |
| BSON 响应 | **RSA-MD5 验签** | `Torappu.DB/BsonNetConverter_WithSign.cs:54-56` |
| 加密响应（Cryptic A/C） | **RSA-MD5 验签** | `Torappu.DB/CrypticConverter_WithSign.cs:107-109`、`Bson_CrypticConverter_WithSign.cs` |
| FBS（FlatBuffer）签名响应 | **RSA-MD5 验签** | `Torappu.DB/FlatBufferSignedConverter.cs:78` |
| **Lua bundle / `.ab` 等资源** | **不做 RSA**——只按热更清单的 `hash/md5/totalSize` + `*.idx` manifest 校验 | `HotUpdater` 资源校验路径；实测替换 bundle 会被拒收/覆盖（`docs/apk-mod-2771-2026-09-13.md` §8.8） |

⇒ 「给所有 Lua 和其他资源重新签名」在客户端语义里**不是 RSA 签名**，而是**让清单/manifest 与内容自洽**
（`md5`/`totalSize`/`abSize` 与实际文件一致）。RSA 签名只需要覆盖**网络响应**那一层。

### 1.1 Android Lua bundle 实测：**没有 RSA 头**

| 层 | 实测 | 结论 |
| --- | --- | --- |
| 外层 bundle | 头 8 字节 `55 6e 69 74 79 46 53 00 00 00 00 08` + `5.x.x` + `2021.3.39f1`，随后块信息/LZ4 块/SerializedFile | 标准 **UnityFS**，**无签名块、无 ASN.1 结构** |
| 内层资产 | `entry.lua` 的 `m_Script` 2640 B，前 16 字节 `6c 48 76 71 43 4c 77 58 …`（随机头）；按 `[128B 随机头][IV XOR mask[16:32]][AES-128-CBC 密文]` 可解出明文 `require "GlobalConfig";…` | **CRYPTIC_A 对称加密**（同 excel 管线的 `MASK_V2` key/mask），**RSA 不参与** |
| bundle 内 `Sign`/`sign` 字样 | 均为 Lua 资产名/玩法词：`FloatParadeSignAnimPanel.lua`、`CheckinVsMainSignItemView.lua`、`signanim` | 与签名无关 |
| 客户端校验点 | `CryptUtils.VerifySignMD5RSA` 全仓仅 3 处调用（`NetworkRouter._DeserializeRouterContent`、`BsonNetConverter_WithSign`、`CrypticConverter_WithSign`）；`Torappu.Lua/*.cs` 无签名/哈希校验；明文 Lua 框架（`entry`/`BaseModule`/`HotfixProcesser`/`HotfixBase`）不调用任何加密 API | **Lua/资产加载链路上没有任何 RSA 验签** |
| 名字带 `sig`/`sin` 的资产 | 只有 TSS/ACE（`__tpinfo.tsc.sig`、`__tpinfo.tsd.sig`、`__tpsinfo.t.p.sin`、`__tpcfinfo.tsa`）与 CrashSight/Google Sign-In 资源 | 没有「Lua bundle 的签名文件」 |

⇒ 「给 Lua 和其他资源重新签名」在 RSA 语义下**不存在**：Lua bundle 既没有 RSA 头也不需要 RSA 头。
资源侧真正管用的是 **清单/manifest**（`hot_update_list.json` 的 `hash`/`md5`/`totalSize`/`abSize` + `*.idx` 的 pathId 表）——
这也是「替换/新增了文件却被客户端判脏重下」的原因（`docs/apk-mod-2771-2026-09-13.md` §8.8）。
RSA 只出现在**网络响应**那一层（见上表），换钥/真签名只需覆盖那一层。

公钥来源（所有验签点共用同一份）：

```csharp
// Torappu.DB/ConverterFactory.cs:84   Torappu.Network/NetworkRouter.cs:407
string text = GlobalOptions.GetInstanceSafe().cryptoPubKey.text;
```

`GlobalOptions` 是 Unity ScriptableObject，`cryptoPubKey` 指向内置 TextAsset：

```
# assets/bin/Data/sharedassets0.assets.split5
[13]"arknights_key"  [243]"<RSAKeyValue><Modulus>r5bwHN3uAWXNb7XP+…</Modulus><Exponent>EQ==</Exponent></RSAKeyValue>"
```

- 官方公钥：**1024 位**（Modulus base64 172 字符）、`Exponent` 为 **1 字节**（`EQ==` ⇒ 小端 0x11）。
- .NET `FromXmlString` 语义：Modulus/Exponent 均为**小端**字节序的 base64。
- `global-metadata.dat` 里另有一处 `<RSAKeyValue>…` 字面量（另一模数，疑似开发遗留）；实际用的是 asset 里那份。

## 2. 等长替换的硬约束

公钥整串 **243 字节**，位于字符串池（前置 4 字节长度）。⇒ 新公钥必须**同为 243 字节**，否则 SerializedFile 偏移位移：

- 选 **1024 位模数**（base64 172 字符，与官方一致）；
- 指数用 **65537**（小端 `01 00 01` → base64 `AQAB`，同样 4 字符）。

```text
<RSAKeyValue><Modulus>  (23) + 172 + </Modulus><Exponent> (20) + 4 + </Exponent></RSAKeyValue> (24) = 243 ✓
```

## 3. 工具与改动

| 位置 | 作用 |
| --- | --- |
| `scripts/sign-key.ts`（`pnpm run sign:key`） | `--gen` 生成 1024 位密钥对（`data/crypto/private.pem` + `public.xml`，243 字节校验）；`--patch-apk` 等长替换 asset 内公钥并重签；`--sync-plugin` 把公钥写进 Lua 插件常量；`--sign/--verify-content` 自检 |
| `app/core/utils/rsa-sign.ts` | 服务端签名：`trySignContent`（RSA-MD5/PKCS#1 v1.5，base64）、`signedEnvelope`；**私钥缺失自动回退占位 `sign:"sign"`**，不影响既有流程 |
| `app/core/config/prod.ts` | `/official/network_config` 改为 `signedEnvelope(content)`（有私钥即真签名） |
| `lua/plugin/NetworkRedirectPlugin.lua` | 新增 `SIGN_MODE = "strict"｜"bypass"`：strict 用内置我方公钥走 `RSACryptoServiceProvider.VerifyHash(hash, MD5_OID, sign)` **真实验签**；bypass 为历史「恒 true」兜底 |
| `hook/verify-sign.js`（Frida，免编译） | hook `Torappu.CryptUtils.VerifySignMD5RSA`：打印内容长度/签名/客户端所用公钥；`FORCE_TRUE` 强制放行；`OVERRIDE_PUBLIC_KEY` 替换实参公钥 |
| `tests/unit/scripts/sign-key.test.ts` | 等长 243 字节、XML 往返、签名/验签往返、异钥验签必须失败、签名长度 128 字节 |

`data/crypto/` 已加入 `.gitignore`（**私钥绝不入库**）。

## 4. 三条使用路线

### A. 换钥 + 改包（PC 客户端 / 离线自用）

```bash
pnpm run sign:key -- --gen                      # 生成密钥对（1024 位，公钥 243 字节）
pnpm run sign:key -- --sync-plugin              # 公钥写进 Lua 插件（SIGN_MODE=strict）
pnpm run repack:lua -- --bundle <当前Lua bundle.bin> --bundle-name anon/<hash>.bin --inline-plugins
pnpm run sign:key -- --patch-apk --in <官方.apk> --out <出包.apk> --sign   # 等长替换公钥 + 重签
# 起服：有 data/crypto/private.pem 时自动对 network_config 真实签名（日志 [sign] 响应签名已启用）
```

> ⚠️ MuMu 模拟器上**重签名的包会被 ACE（`libtersafe2.so`）主动终止**（`docs/apk-mod-2771-2026-09-13.md` §8.7），
> 因此路线 A 适用于 PC 客户端或可停 ACE 的调试环境；MuMu 上请走 B/C。

### B. 不改包（MuMu 官方包可用）

保持 asset 官方公钥，插件用 `SIGN_MODE = "bypass"`（历史行为）——服务端无需私钥。
若已按 A 换钥（服务端真签名），则把插件改为 `strict` 并确保插件内置公钥 = `data/crypto/public.xml` ✓。

### C. Frida 观察/改参（调试）

```bash
frida -U -f com.hypergryph.arknights -l hook/verify-sign.js --runtime=v8
# 输出示例： [verify-sign] argc=3 content.len=745 sign=K3f… pubKey=<RSAKeyValue><Modulus>FYRXh2X…
#   → pubKey 前缀等于我方公钥 ⇒ asset 替换成功；否则说明客户端仍在用官方公钥
```

MuMu 的 ARM 翻译层下 `libil2cpp.so` 是 guest 模块，宿主 Frida 枚举不到 → 该脚本在 MuMu 上会提示
`libil2cpp.so 未加载`（见 `docs/apk-mod-2771-2026-09-13.md` §8.3），请用 PC 客户端或真机验证。

## 5. 自检清单

1. `pnpm run sign:key -- --gen` → 输出 `243 字节，等长 ✓`；
2. `pnpm run sign:key -- --sign --content '{"a":1}'` → `--verify-content` 返回 `verify: OK`，改内容后 `FAIL`；
3. 起服后 `curl /config/prod/official/network_config` 的 `sign` 是 **base64**（不是 `"sign"`）；
4. `sign:key -- --patch-apk` 自检通过（条目 CRC/布局/对齐），并用同一条目反查：`<RSAKeyValue>` 长度仍 243；
5. 客户端侧：Frida 打印 `pubKey` 为我方公钥（或插件日志出现 `私服引导已启用（真实验签）`）。

## 6. 边界与红线

- 本方案是**换信任锚**（客户端改用自己的公钥、服务端真实签名），不是无条件放行；`bypass` 只作为历史兼容兜底保留。
- MD5-RSA 与 1024 位是**沿用官方规格**以兼容客户端既有实现，不代表推荐强度。
- 不涉及反外挂（ACE/MTP）的任何绕过；MuMu 上被 ACE 终止属既有事实（§8.7 记录），不在本仓解决范围内。
