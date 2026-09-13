# APK `assets/` 目录逐文件含义分析（明日方舟 2.7.71）

- 分析对象：`tmp/apk/2.7.71/arknights-hg-2771.apk`（官方 2.7.71，1.88 GB）
- 方法：`pnpm run apk:assets -- --filter <正则> [--list]`（分组占用 + 扩展名 + 逐条目**魔数分类**，脚本
  `scripts/apk-assets-report.ts`）+ 与反编译 C#（`reference/arknights-2.7.71-csharp`）、仓内资产管线
  （`app/ops/assets/`）交叉印证
- 规模：`assets/` 共 **2856 条 / 1796.0 MB**（APK 全量 3688 条，其余为 `lib/`（493 MB 原生库）、`classes*.dex`、`res/` 等）

三块构成：

| 区块 | 条目 | 大小 | 性质 |
| --- | --- | --- | --- |
| `assets/AB/Android/` | 2532 | 1623.8 MB | Unity **AssetBundle 资源**（游戏内容）+ 热更清单/manifest |
| `assets/bin/Data/` | 295 | 147.3 MB | Unity **播放器数据**（引擎级，随包固定，不走热更） |
| `assets/` 根级（含 `font/`、`mlkit_barcode_models/`、`cucc/`） | 29 | 24.8 MB | SDK / 渠道 / 反作弊 / WebView / 字体等旁路资产 |

---

## 1. `assets/bin/Data/` —— Unity 播放器数据（引擎级）

| 条目 | 大小 | 含义 / 依据 |
| --- | --- | --- |
| `boot.config` | 206 B | Unity 启动参数：`wait-for-native-debugger=0`、`il2cpp-lazy-load-enabled=0`、`il2cpp-mmap-enabled=0`、`shader-runtime-zstd-enabled=0`、`hdr-display-enabled=0`、`gc-max-time-slice=3` |
| `globalgamemanagers` | 781 KB | 引擎全局管理器（PlayerSettings / 质量 / 图形 / 输入 / 内置资源引用表），裸 SerializedFile |
| `globalgamemanagers.assets.split0…8` | 8.7 MB | 上述全局资源的**分片**（Unity 的 1 MB 切片规则；最后一片不满） |
| `level0…level13` | 4.4–88.6 KB | Unity **场景（Scene）** 序列化文件（14 个：启动/主界面/战斗等） |
| `sharedassets0.assets.split0…5`、`sharedassets1.assets.split0…18` | ~23.4 MB | 场景**外部资源**（sharedassets，被 level* 引用） |
| `01205c74…f53f` 等 **227 个 32 位散列名文件** | 43.5 MB | Unity 资源独立文件（文件名 = 资源路径 32 位散列），由引擎引用表按名加载；均判为裸 SerializedFile |
| `Managed/Metadata/global-metadata.dat` | **42.6 MB** | **IL2CPP 元数据**：类型/方法/字段/**全部 C# 字符串常量**（前几轮定位官服域名、包名、`arknights_key` 公钥都靠它） |
| `Managed/Resources/mscorlib.dll-resources.dat`、`Newtonsoft.Json.dll-resources.dat` | 330 KB | 托管程序集内嵌资源 |
| `Resources/unity_builtin_extra` | 1.2 MB | 引擎内置资源（默认材质/着色器/内置字体等） |
| `RuntimeInitializeOnLoads.json` | 2.5 KB | `[RuntimeInitializeOnLoadMethod]` 注册清单 |
| `ScriptingAssemblies.json` | 4.1 KB | 打进包的托管程序集清单（`UnityEngine*.dll`、`Assembly-CSharp.dll`…） |

要点：这一块是**引擎运行必需、且随 APK 固定**的部分；热更不会替换它（改它等于改包 → 触发反外挂自校验）。

---

## 2. `assets/AB/Android/` —— 热更资源与清单

### 2.1 内容 bundle（2435 个 `.ab`，1559.2 MB）

全部以魔数 `UnityFS` 开头（Unity AssetBundle）。按业务目录分布：

| 目录 | 条目 | 大小 | 内容 |
| --- | --- | --- | --- |
| `arts/` | 507 | 337.2 MB | 剧情/关卡美术图 |
| `battle/` | 577 | 280.4 MB | 战斗表现（特效、技能、敌人） |
| `spritepack/` | 175 | 240.3 MB | 图集（UI 精灵，含皮肤立绘） |
| `audio/` | 58 | 187.9 MB | 音频（BGM/语音；`.ab` 内含 FMOD/CRI 资源） |
| `pkgrps/` | 42 | 135.9 MB | 按「资源包组」聚合的大包（下载粒度单位） |
| `scenes/` | 211 | 127.7 MB | 场景资源包 |
| `ui/` | 255 | 101.4 MB | UI 预制/界面 |
| `refs/` | 31 | 72.8 MB | 共享引用资源（公共依赖） |
| `shaders/` | 18 | 18.6 MB | 着色器变体 |
| `building/` | 57 | 15.6 MB | 基建 |
| `charpack/` | 462 | 11.7 MB | 干员基础数据包（小） |
| `prefabs/`、`chararts/`、`activity/`、`config/`、`crisisv2longterm/`、`npcpack/`、`akvt/`、`cutin/`、`graphics/` | 各 1–11 条 | 0.1–8.8 MB | 预制体、干员立绘索引、活动、配置、危机合约长期、NPC、VTuber 联动、切入图、图形设置 |

### 2.2 `anon/`（94 个 `.bin`，54.2 MB）—— 内容寻址 bundle

文件名 = **内容 hash**（如 `3ea52f7d41a320d200aa7e61735f0819.bin`），不在 `.ab` 目录树里被引用，而是由清单/manifest
按 `anon/<hash>.bin` 引用。本仓关心的 **Lua 主 bundle** 就在此处（2.7.71 = `anon/3ea52f7d…bin`，1.11 MB，339 条 Lua；
热更到 26-09-09 版本后变为 `anon/63bbacd2…bin`）。

> 该目录**只要改一个字节就会被客户端判脏并重新下载**（见 `docs/apk-mod-2771-2026-09-13.md` §8.8）。

### 2.3 清单与索引

| 条目 | 大小 | 含义 |
| --- | --- | --- |
| `hot_update_list.json` | 0.4 MB | **热更清单**：`versionId`（26-08-16-13-31-15_02805c）、`abInfos[]`（2529 条：bundle `name`/`hash`/`md5`/`totalSize`/`abSize`/`cid`/`cat`）、`manifestName`。私服通过**重写本文件**（追加 mod 条目）下发自定义资源 |
| `df176d96f660b5463c8c5257d04fb908.idx` | 9.9 MB | **资源 manifest**（`manifestName` 指向它）：资产路径 → bundle 索引 + 每资产 hash/依赖；客户端按 **pathId** 寻址（⇒ 重打包必须保留 pathId，`docs/apk-mod-2771-2026-09-13.md` §8.2） |
| `613696e0b7f401be75f635e43560cf93.idx` | 79 KB | 第二个 idx（pack 分组索引；线上清单的 `packInfos` 有 57 条打包下载组，如 `lpack_init1`，APK 内置清单里该字段为 `null`） |
| `empty` | 0 B | 占位空 bundle（Unity 构建产物，用于目录保留/占位） |
| `[uc]lipsync.ab` / `[uc]shaders.ab` / `[uc]uishaders.ab` | 0.8 / 1.1 / 2.4 MB | `[uc]` 前缀的内置组：口型同步数据、通用着色器、UI 着色器（随包固定，属于最基础的一组） |

---

## 3. `assets/` 根级 —— SDK / 渠道 / 安全 / WebView / 字体

### 3.1 U8 渠道 SDK（登录 / 支付 / 更新 / 埋点）

| 文件 | 要点（实测内容） |
| --- | --- |
| `U8Config.json` | 环境表：`stable`/`prod` 两套 `HG_APP_CODE=7318def77669979d`、`SDK_ENV`、`U8_APPID=1`、EventLog AppID；`globalConfig.default=prod`、`region=cn` |
| `u8ExtraConfig.json` | `channel=default`、`env=prod`、`appCode=GzD1CpaWgmSq1wew`、`enableGameUpdateV2=true`（`appCode` 即 CDN 路径里的那段） |
| `u8_developer_config.properties` | U8 SDK 主配置：`HG_APP_CODE`、`U8_APPKEY`、`U8_ApplicationProxyName`（各 ProxyApplication 列表）、开关组（`U8_DETECTION/UPDATE/VERIFY/GAMEBI/PERMISSIONREQ`…）、`PAYMENT_PLATFORM=GooglePlay`、`TapTap_AppID=70253`、`MTP_AppID=19791`、`CS_*`（CrashSight 上报）、`EventLog_*`、`TapTap_PackageName=com.hypergryph.arknights` |
| `u8_plugin_config.xml` | 插件清单：`com.u8.sdk.HGUser`、`HGPay`、`CommonExtension`、`com.hg.sdk.ExtConfigImp`、**`MTPDetection`**、`PermissionRequest`、`TapTapUpdate`、`HGShareImpl`、`GameBICollection` |
| `hgsdk_config.json` | Hypergryph SDK：客服链接（`user-center-account-staging…`）、扫码登录 scheme `hypergryph://scan_login` |
| `HGShareSDKConfig.json` | 分享/埋点 AppID：QQ `1108300877`、微信 `wx0ae7fb63d830f7c1`、微博 `3913328204`、抖音、TapTap、B 站 clientId/secret |
| `HGEventLogConfig.json` | 事件上报（数数科技）`sm_app_id`/`sm_public_key`（RSA 公钥）+ `enable_risk_control` |
| `HGUniWebUrlMapping.json` | 内置 WebView 页面映射：公告、`rogue_1..6`、`sandbox_1/2`、`act1/2autoChess`、抽卡记录、视频播放器 |
| `supplierconfig.json` | 渠道登录/支付 appid（vivo `100215079`、小米/华为/OPPO 空占位） |

### 3.2 反作弊 / 设备标识 / 风控

| 文件 | 含义 |
| --- | --- |
| `tpginf.dat`（8 B） | 腾讯 TSS 配置标记（`20 15 04 28 00 00 4d 4f`） |
| `__tpinfo.tp`（12 B） | TSS 版本/票据（`<-.. ..x..`） |
| `__tpinfo.tsc`（4.1 KB）/ `__tpinfo.tsd`（3.5 KB） | TSS **加密配置**（魔数 `00 7f 54 7f 53 7f 43` = `\0\x7fT\x7fS\x7fC`；`.tsd` 内含明文合规字符串，如 `73a2471bac4de1a95a7a5dc1a717e51cf43a4327970cd601f85b3338632c064c`） |
| `__tpinfo.tsc.sig` / `__tpinfo.tsd.sig` | 上述配置的**签名**（256 B，RSA-2048） |
| `__tpsinfo.t.p.sin`（188 B） | TSS 系统信息模板/签名 |
| `__tpcfinfo.tsa`（272 B） | TSS 配置签名（另一份） |
| `__acignore.acc`（4 B） | 反作弊忽略标记，内容 `game` |
| `com.hypergryph.arknights.cert.pem` | **MSA OAID SDK** 证书（subject `CN=com.hypergryph.arknights`，issuer `O=MSA, OU=OAID_SDK, CN=com.bun.miitmdid.sign`，2026-06-24 起 1 年）→ 设备标识合规用途 |

> ⚠️ 这些属于 **ACE/TSS 反作弊与合规**资产：本仓不修改、不绕过（红线见 `docs/no-root-injection-chain-2026-09-13.md` §7）。
> 实测重签名的包会在游戏启动阶段被 `libtersafe2.so` 主动终止（`docs/apk-mod-2771-2026-09-13.md` §8.7）。

### 3.3 WebView / 扫码 / 字体 / 渠道

| 文件 | 含义 |
| --- | --- |
| `gt4.js`（15 KB）、`gt4-index.html`、`gt4-loading.gif` | 极验 Geetest v4.2.0 验证码前端（WebView 加载，用于一键登录/风控） |
| `mlkit_barcode_models/*.tflite`（3 个，0.9 MB） | Google ML Kit 条码识别模型（扫码登录） |
| `font/SourceHanSansCN-Medium.ttf`、`SourceHanSerifCN-Medium.ttf` | 思源黑体/宋体（23.9 MB，内置中文字体） |
| `cucc/host_cucc.properties` | 中国联通（CUCC）渠道 SDK 域名：`PRODUCE_STATISTICAL=https://daily.m.zzx9.cn`、`auth.wosms.cn`、`m.zzx.cnklog.com` 等 |

---

## 4. 与改包 / 私服的关系（结论）

1. **幂等校验源 = 清单 + manifest**：`hot_update_list.json`（`abSize`/`md5`）与 `*.idx`（按 pathId 寻址）。
   想替换或新增资产，必须让二者与内容自洽；只手改文件会被判脏并重下（§8.8）。
2. **可安全下发的路径**：由**客户端自己按服务端清单下载**的 `mods/*.dat`（本仓 `app/ops/assets/`），
   或 MITM 官方 CDN 后让客户端自然热更到我们的 bundle——客户端只认自己下载的产物。
3. **不可碰**：`tpginfo*`/`__tp*`/`__acignore.acc`/`libtersafe2.so` 等 ACE/TSS 资产（红线）；
   重签名 APK 亦会被其自校验终止（§8.7）。
4. **改包注意**：`assets/bin/Data/sharedassets0.assets.split5` 内含验签公钥 TextAsset `arknights_key`
   （243 字节 .NET XML，等长可换，见 `docs/crypto-resign-2026-09-13.md`）；`global-metadata.dat` 含全部 C# 字符串常量
   （改它同样属于改包）。

---

## 5. 精简体积（实测）

`pnpm run apk:slim -- --in <apk> --report` 体检结论（以改包后的 1.889 GB 包为例）：

| 分组 | 条目 | 未压缩 | **压缩后（zip 内实际占用）** |
| --- | --- | --- | --- |
| `assets`（AB + bin/Data + 根级） | 2857 | 1797.3 MB | 1703.4 MB |
| `lib/arm64-v8a` | 26 | 263.6 MB | 85.3 MB |
| **`lib/armeabi-v7a`** | 25 | 229.2 MB | **82.0 MB ← 可整目录删除** |
| `classes*.dex` | 5 | 25.3 MB | 13.6 MB |

- **默认低风险精简**：`--keep-abi arm64-v8a` 删掉另一套 ABI → 实测产物 **1.806 GB（省 82.3 MB）**；
  MuMu 12（ARM 翻译跑 arm64）与现行真机都不需要 `armeabi-v7a`。
- `assets/**` 是 `.ab`（UnityFS，包内 STORED、内部已 LZ4 压缩）⇒ 再 deflate 几乎无收益；
  真要瘦身只能**删除按需下载类资产**（`audio/` 188 MB、`spritepack/` 240 MB、`arts/` 337 MB —— 语音/皮肤/剧情图，
  游戏内可重新下载，需 `--allow-risky`）。默认受保护名单：`assets/bin/Data/`、`assets/AB/`、`res/`、
  `AndroidManifest.xml`、`resources.arsc`、`classes*.dex`、保留 ABI 的 `lib/`。
- 产物清理：本轮把 22 个中间包（含 `-aligned`/`-debugSigned`/`.idsig`）从 **39 GB 清到 1.8 GB**；
  源包 `tmp/apk/2.7.71/arknights-hg-2771.apk`（1.8 GB）保留以便复现（`pnpm run apk:assets` 默认读它）。

### 5.1 「只留入口」预设（`--preset entry`）

`pnpm run apk:slim -- --in <apk> --preset entry --keep-abi arm64-v8a --out <out> --sign`

删除 `assets/AB/Android/` 下**非启动必需**的内容组（`arts`/`battle`/`spritepack`/`audio`/`pkgrps`/`scenes`/`ui`/`refs`/
`chararts`/`activity`/`crisisv2longterm`/`npcpack`），保留：

- **引擎数据**：`assets/bin/Data/**`（含 `global-metadata.dat`、`level*`、`sharedassets*`、散列名 SerializedFile）
- **清单/manifest**：`hot_update_list.json` + 两个 `.idx`（**缺了客户端就无从知道要下载什么**）
- **anon/**：内容寻址基础 bundle（含 Lua 引导 bundle）
- **核心小目录**：`config/`、`charpack/`、`shaders/`、`building/`、`prefabs/`、`akvt/`、`cutin/`、`graphics/`
- **根级核心**：`[uc]lipsync.ab`、`[uc]shaders.ab`、`[uc]uishaders.ab`
- 其余顶层（`lib/arm64-v8a`、`classes*.dex`、`res/`、`assets/` 根级 SDK/配置、`AndroidManifest.xml`、`resources.arsc`）

实测（1.889 GB 原包）：删 **1904 条 / 1579.2 MB（压缩后）** → 产物 **≈309 MB**。
被判为「需更新」的内容会在客户端首次热更时按清单从 CDN/私服下载（所以配合私服/CDN 代理使用最合理）。

> 风险：预设是**显式选择**，会绕过 `assets/AB/` 的默认保护；若某内容组在登录前就被加载，首次启动会先触发大额下载
> 甚至报错。建议先用 `--report` 看体积，再保留你确认需要的目录（把目录从删除列表里排除＝用 `--drop-prefix` 精确控制替代 `--preset`）。
