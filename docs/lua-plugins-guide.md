# 游戏内 Lua 插件系统 — 使用与真机验证指南

> 在明日方舟客户端内，用游戏原生 XLua 热更 + 纯 Lua hotfix + 游戏内 Lua UI，实现敌人血量显示、敌人属性面板、战斗辅助，并提供现代化插件管理面板。
> 设计见 `.trae/specs/lua-plugins/spec.md`；实施任务见 `tasks.md` / `checklist.md`。

## 1. 源码结构

```
lua/plugin/                    ← 插件明文源码
├── BasePlugin.lua             ← 插件基类（继承官方 HotfixBase，OnLoad/OnUnload + Hotfix/Fix_ex）
├── PluginHotfix.lua           ← 共享 hotfix 注册表（多插件 hook 同方法互不覆盖）
├── PluginDefs.lua             ← 插件清单（id/name/desc/module）
├── PluginManager.lua          ← 注册表：加载/启停/配置持久化（自举全局）
├── PluginHeartbeat.lua        ← 生效确认心跳 + 服务端启停状态同步
├── NetworkRedirectPlugin.lua  ← 私服引导（DefinedFix 首个 hotfixer，早于网络初始化）
├── EnemyHpPlugin.lua          ← 敌人血量显示（UIUnitHUD.Attach）
├── EnemyInfoPlugin.lua        ← 敌人属性面板（动态 UnityEngine.UI，触摸 + 鼠标）
├── BattleAssistPlugin.lua     ← 战斗辅助（时间轴/倍速/TAS 单帧步进）
└── PanelPlugin.lua            ← 插件管理面板（浮动按钮 + 列表开关，延迟挂载）
```

> 每个插件 = 一个继承 `BasePlugin`（→ 官方 `HotfixBase`）的自包含 hotfixer，逐条登记在
> `DefinedFix.lua` 清单（`Plugin/<X>`）。客户端经游戏原生 `HotfixProcesser.Do` 管线对清单每个
> 条目 `require(v).new()` + `Init()`（→ `OnInit()`），插件在 `OnInit()` 注册到 `PluginManager` 并按
> 持久化启用态 `Load`（打补丁）。无独立引导 hotfixer / 入口文件——取消互补、各插件直接接入管线。

## 2. 打包与下发（方案 A：重打包内置 Lua bundle）

客户端 Lua 由一个**内置主 bundle**（`anon/7d91430e114d86fef7d3b3511151e12d.bin`）承载，客户端启动时按其加载 `entry.lua`。要让插件生效，需把插件 merge 进该 bundle 并 patch `DefinedFix.lua`（经游戏原生 hotfix 管线引导）：

> ⚠️ 关于「从官方 hot_update_list 提取」：该内置 Lua bundle 是**客户端 base 资产**，**不在**官方 `hot_update_list.json` 的 abInfos 中（清单仅含可热更增量资产；当前 2.7.61 清单 14981 条无此 hash，CDN 各版本路径亦 404）。bundle 哈希由官方 `resource_manifest_idx.json`（ArknightsGameData）确认：全部 `gamedata/[uc]lua/*` 资产的 `bundleIndex=2246` → `bundles[2246].name = anon/7d91430e114d86fef7d3b3511151e12d.bin`。取数源只能是已装客户端内的该 bundle。

### 2.0 一键自动工作流（推荐）：抓最新 APK → 注入 Lua 引导

`pnpm run apk:lua` 自动完成「下载最新版官服 Android APK → 解包定位内置 Lua bundle → 提取明文 → 注入插件引导」全链路：

```powershell
pnpm run apk:lua                                   # 自动下载最新 APK → 提取 → 注入 → 启用 mod
pnpm run apk:lua -- --apk ./arknights.apk          # 用本地 APK（跳过下载）
pnpm run apk:lua -- --extract-only                 # 只解包提取明文 Lua（不注入）
pnpm run apk:lua -- --repack-only <bundle.bin> --bundle-name anon/xxx.bin  # 已有 bundle，只注入
pnpm run apk:lua -- --force                        # 忽略已下载缓存，强制重下 APK
pnpm run apk:lua -- --no-extract                   # 跳过明文提取（仅注入）
```

- **下载源多级回退**：官方稳定链接 `https://ak.hypergryph.com/downloads/android_lastest`（302 → 最新 APK）→ gryph-links 跟踪链接（GitHub raw，社区定时维护）→ 手动 `--apk`。
- **自动定位 bundle**：扫描 APK 内所有候选文件，按 UnityFS 魔数 + `.lua` 资产（entry/DefinedFix 锚点）识别内置 Lua bundle（**不依赖硬编码 hash，版本升级自动适配**）；推断客户端资源名（`assets/AB/Android/anon/xxx.bin` → `anon/xxx.bin`），可用 `--bundle-name` 覆盖。
- **Android 加密自适应**：Android 客户端内置 Lua 为 **CRYPTIC_A 加密**（实测格式 `[128B 随机头][IV XOR mask[16:32]][AES-128-CBC(key,IV) 密文]`，key/mask = excel 管线同款 `UITpAi82pHAWwnzqHRMCwPonJLIB3WCl`）。repack 自动检测加密：解密内置资产 → 合并插件 → patch DefinedFix → 全部重新加密；插件资产按 Android 裸文件名布局（客户端 require 归一化为 basename 匹配）。明文提取输出到 `tmp/apk-work/<版本>/lua-plain/`（与 Windows 参考目录隔离）。
- **幂等与缓存**：APK 缓存于 `tmp/apk/<版本>/`（>50MB 视为完整复用），bundle 副本落 `tmp/apk-work/<版本>/`；重复运行不会重复下载。
- **产出**：注入 mod → `mods/anon_<hash>.dat`（bundle 名随版本变化时自动对应）；自动启用 `data/config.json` 的 `assets.enableMods`。
- 版本漂移（DefinedFix 锚点不匹配）时脚本会报错，按 §5 校准锚点后重跑即可。

### 2.0.1 私服引导插件（NetworkRedirectPlugin）

`lua/plugin/NetworkRedirectPlugin.lua` 提供**纯 Lua 私服引导**（无需 Frida）：客户端经内置 Lua 管线启动时
hotfix 两个 C# 方法：

1. `Torappu.Network.Networker.get_overrideRouterUrl` → 返回 `${SERVER_URL}/config/prod/official/network_config`，
   引导客户端从私服拉取网络路由配置（`Networker` 实现 `IHotfixable`，该属性 getter 有 XLua hotfix 委托字段，官方预留热更入口）；
2. `Torappu.CryptUtils.VerifySignMD5RSA` → 恒返回 `true`，绕过官服 RSA-MD5 响应签名校验
   （校验点：`NetworkRouter.cs:409` network_config、`BsonNetConverter_WithSign.cs:56` BSON 响应、
   `CrypticConverter_WithSign.cs:109` 加密响应——私服无官方私钥，必须绕过）。

- 插件默认启用（PluginDefs 首条，ID `network_redirect`）；**关闭即连不回私服**。
- 私服地址改插件顶部 `SERVER_URL` 常量（默认 `http://192.168.0.100:8443`，与 `hook/main.ts` 一致）。
- Java/native 层（Hypergryph SDK URL、ACE/MTP 反作弊）Lua 覆盖不了，仍走 Frida（`hook/main.ts`）。

### 2.0.2 APK 校验 / 反作弊 / 暗桩审查（apk:audit）

`pnpm run apk:audit` 对客户端反编译源码做静态安全审查，输出 `docs/apk-security-audit.md`：

```powershell
pnpm run apk:audit                                     # 默认源码目录 → 报告
pnpm run apk:audit -- --apk ./arknights.apk            # 追加 APK 签名方案检测（V1/V2/V3）
pnpm run apk:audit -- --json                           # 同时输出 JSON 原始结果
```

三类审查：
- **A 完整性/签名校验**：`VerifySignMD5RSA` 定义与三大调用点、`HotUpdater` 热更 md5/hash 校验；
- **B 反作弊**：CodeStage.AntiCheat 六类检测器（定义存在；游戏代码无直接引用，推测经场景组件挂载）、
  `Obscured*` 混淆数值类型 15+ 处、ACE/MTP（Java/native 层，标注需动态分析，`hook/main.ts` 已有处理点）；
- **C 暗桩/埋点**：EventLogSDK 事件上报、CrashSight 崩溃上报、OneChannel/Webview、硬编码外联域名
  （结论：官服域名不硬编码，全部配置驱动——正是 `overrideRouterUrl` 引导可行性的基础）。

### 2.0.3 APK 本体改造：注入版 bundle 回灌 + 重签名（apk:mod / apk:patch / apk:sign）

**为什么需要**：`apk:lua` 产出的注入版 bundle 平时靠私服热更下发，但客户端**首次启动**时还没连上私服、
拿不到热更清单，插件自然加载不了（鸡生蛋）。把注入版 bundle 直接回灌进 APK 本体的内置 bundle 槽位，
客户端首启即走内置 Lua 管线 → `NetworkRedirectPlugin` 立即接管网络路由。

```powershell
# 0) 一次性准备工具链（便携 JRE + uber-apk-signer，落在 tmp/tools/，gitignored）
pnpm run apk:sign -- --fetch-tools

# 一条命令版：抓最新 APK → 注入 → 回灌 → 重签（自动定位 tmp/apk 下最新 APK 与对应 mods/anon_<hash>.dat）
pnpm run apk:lua
pnpm run apk:mod          # → tmp/apk-out/arknights-hg-<版本>-mod-signed.apk

# 分步版（需要自定义路径时）
pnpm run apk:patch -- --in tmp/apk/2.7.71/arknights-hg-2771.apk `
  --lua-bundle mods/anon_3ea52f7d41a320d200aa7e61735f0819.dat `
  --entry assets/AB/Android/anon/3ea52f7d41a320d200aa7e61735f0819.bin `
  --out tmp/apk-out/arknights-hg-2771-mod.apk --sign
```

- **两条下发路径（重要）**：`mods/<平台>/*.dat` 是**服务端热更**路径，只能覆盖客户端愿意从
  `files/Bundles/` 持久目录读取的资产；而 **Lua 引导 bundle 走 APK 内路径**
  （`jar:file://…base.apk!/assets/AB/Android/anon/<当前 resVersion 的 hash>.bin`，见
  `docs/apk-mod-2771-2026-09-13.md` §8.1）——要用改包方式生效，必须把注入版 bundle
  用 `apk:patch --add` **新增**到 APK 内该条目（且 bundle 名跟随热更版本，不是 APK 内置旧名）。
- **插件内联（Android 实测推荐）**：客户端清单（`*.idx`）按 pathId 寻址，**新增插件资产无法被解析**；
  `repack:lua --inline-plugins` 把插件源码内联为 `package.preload["Plugin/<X>"]` 追加进 `entry.lua`
  （Lua `require` 先查 preload，绕过资产查找），资产集保持官方 344 条不变（见 `docs/apk-mod-2771-2026-09-13.md` §8.5）。
- **重打包不变量**（缺一即 Unity 报 `Failed to load asset` 或 `libunity.so` 崩溃）：保留官方
  AssetBundle(142) 容器 key、**64 位 pathId**（> 2^53，禁止 Number 转换）、官方类型表
  （`enableTypeTree=true`）、对象数据 **8 字节对齐**；细节与实证见 `docs/apk-mod-2771-2026-09-13.md` §8.2。
- **zip 级重写**：逐条目原样搬运压缩字节，只替换目标条目；数据描述符（bit3）改为本地头直写尺寸；
  STORED 条目按 4 字节（`.so` 按 4096 字节）重对齐（等价 zipalign）；抹掉旧 V1
  （`META-INF/*.SF|RSA|MF`）与 APK Signing Block，再交给 `apk:sign` 重签（V1+V2+V3）。
- **自检**：`apk:patch` 落盘后重扫中央目录，逐条校验 CRC、STORED 布局、对齐、条目区间不重叠，
  任一不过即非 0 退出（漏写 extra、偏移错位这类问题只有结构自检能查出来）。
- **其它用法**：`--list` 概览（条目数 / V1 / 签名块）；`--dry-run` 预演不落盘；
  `--replace <zip条目>=<本地文件>`（可重复）做任意资源替换；自定义密钥
  `pnpm run apk:sign -- --in <apk> --keystore my.jks --alias k --store-pass *** --key-pass ***`。
- **注意**：改包会破坏官方签名，**必须重签名**才能安装（Android 7+ 认 V2 方案）；debug 密钥仅自用/内测，
  勿分发；反作弊/校验绕过不在本仓范围（红线见 `docs/no-root-injection-chain-2026-09-13.md` §7）。

```powershell
# 1) 从已装客户端提取内置 bundle（ArkUnpacker 解包后定位该 .bin，或直接取 .dat）
#    得到 <内置bundle>.dat 或 .bin

# 1b)（可选）把内置 bundle 的明文 Lua 提取到参考目录，之后可用 --from-ref 免客户端重建：
pnpm run extract:lua -- --bundle <内置bundle.dat|.bin>
#    → 写入 reference/ArknightsGameData/zh_CN/gamedata/[uc]lua/（跳过 plugin/*，还原 DefinedFix 注入标记）

# 2) 重打包：merge lua/plugin/ + patch DefinedFix → mods/anon_7d91430e114d86fef7d3b3511151e12d.dat
pnpm run repack:lua -- --bundle <内置bundle.dat|.bin>   # 或：pnpm run repack:lua -- --from-ref
#    （可选）指定目标平台，输出到平台专属 mods/<platform>/ 目录，避免单份 repack 同时下发两平台：
pnpm run repack:lua -- --bundle <内置bundle.dat|.bin> --platform windows
pnpm run repack:lua -- --bundle <内置bundle.dat|.bin> --platform android

# 3) 脚本会自动打开 data/config.json 的 assets.enableMods
# 4) 重启服务，客户端热更拉取覆盖内置 bundle → 客户端启动即加载插件
```

> **启动自动构建（推荐）**：`assets.enableMods=true` 后，服务启动会自动检测
> `mods/anon_7d91430e114d86fef7d3b3511151e12d.dat` 是否缺失或过期（`lua/plugin/` 有更新），
> 是则自动重打包——优先 `reference/.../[uc]lua/` 明文目录，回退以现有 mod 自举
> （解包 → 剔除旧插件/剥离注入 → 合并当前插件，幂等）。日常改插件**无需手动 repack:lua**，
> 重启服务即生效；可用 `data/config.json` 的 `assets.autoBuildLuaMod=false` 关闭。
> 产物为确定性输出（zip 固定时间戳），插件内容不变时 md5 稳定，不会触发客户端重复全量下载。
> 首次运行仍需提供数据源：客户端内置 bundle 经 `pnpm run extract:lua` 生成参考目录，
> 或放置一个现有 mod 作为自举源（二者皆无时启动会 warn 跳过）。

> 说明：
> - `scripts/repack-lua-bundle.ts` 会 **merge** 内置 Lua 资产与 `lua/plugin/*.lua`，并向 `DefinedFix.lua` 清单逐条注入各插件 hotfixer 条目（`Plugin/NetworkRedirectPlugin`、`Plugin/EnemyHpPlugin` …），经游戏原生 `HotfixProcesser.Do` 管线逐条目 `new()` + `Init()` 驱动加载。
> - 插件资产统一用 `gamedata/[uc]lua/Plugin/` 前缀（大写 P），与 require 路径 `Plugin/…` 大小写一致，避免 loader 找不到资源。
> - 单独的 `pnpm run pack:lua-plugins`（产出 `mods/plugin_lua.dat`）仅用于**独立开发/调试**，不能单独替代内置 bundle（否则客户端会丢失全部内置 Lua）。
> - 若 `DefinedFix.lua` 锚点不匹配（版本漂移），脚本会报「未找到 … 锚点」，需人工校准锚点后重跑。

### 2.1 插件热重载（开发迭代）

改一个插件 Lua 无需手动重打包。运行：

```powershell
pnpm run watch:lua            # 监听 lua/plugin/*.lua 变更 → 自动重打包 → 使 mods.json 缓存失效
pnpm run watch:lua -- --once  # 只重打包一次后退出（CI / 手动触发用）
```

- 变更后自动重建 `mods/anon_7d91430e114d86fef7d3b3511151e12d.dat` 并删除 `mods.json` 指纹缓存。
- 客户端下次拉取 `hot_update_list.json` 时 `app/ops/assets/asset.ts` 重扫 mods/ 拿到新指纹 → 重新下载覆盖 → 生效。
- `--debounce <ms>` 调整保存防抖（缺省 300ms）。

### 2.2 插件补丁模式（BasePlugin）

每个插件继承 `BasePlugin`，在 `OnLoad` 里打补丁，`OnUnload` 由基类统一注销。两种补丁模式：

- `Fix_ex(cls, method, fixFunc)`：**完整替换**，`fixFunc(self, ...)` 取代原方法（少用）。
- `Hotfix(cls, method, fixFunc)`：**包装模式**，`fixFunc(self, orig, ...)` 可调 `orig(self, ...)` 保留原行为。

> 补丁经共享注册表 `Plugin/PluginHotfix` 落地：多个插件 hook 同一 C# 方法（如
> `UIController.Awake` / `BattleController.Update` 同时被敌人面板、战斗辅助、管理面板使用）时
> 只安装一个 `xlua.hotfix` 包装器并链式组合，单独启停任一插件不会破坏其它插件的 hook；
> 全部处理函数注销后才还原原方法。
> `Fix_ex` 是完整替换，`fixFunc` 里**不会**传 `orig`；若要调用原方法请改用 `Hotfix`。
> `Load` 失败（OnLoad 中途抛错）时已注册补丁会被自动回滚，不会残留半应用 hook。

## 3. 启用流程（服务端）

- admin 端点（需 `adminAuth` 令牌，默认 `doctorate-admin`）：
  - `GET /admin/api/plugin`            → 插件列表（含启用状态）
  - `POST /admin/api/plugin/<id>/enable`  → 启用
  - `POST /admin/api/plugin/<id>/disable` → 停用
- 配置持久化于 `data/plugin/config.json`（`{ "enabled": { "<id>": bool } }`）。
- **单一数据源**：服务端插件目录由 `app/ops/plugin/plugin-catalog.ts` 从 `lua/plugin/PluginDefs.lua` 动态解析（无需在 TS 侧重复维护清单）；解析失败回退内置目录。新增插件只需改 `PluginDefs.lua` 并重打包即可，admin API 自动反映。
- **启停状态双向同步**：游戏内面板切换插件 → 客户端持久化本地 `plugin_config.json`，并经 `PluginHeartbeat.PushState` 推送 `GET /plugin/config/<id>/<0|1>` 到服务端 `data/plugin/config.json`；管理端 enable/disable 写入同一配置源，客户端在心跳响应（best-effort 回调，真机需按 UISender 回调约定校准）中应用服务端状态。管理端与面板最终收敛到同一状态。
- **加载容错**：单个插件 require/实例化/初始化失败不拖垮系统——`PluginManager` 记录错误，其余插件照常加载；游戏内面板会把失败插件标为红色 `ERR` 并显示错误摘要（`ON/OFF` 按钮禁用）。

## 4. 真机手动验证步骤

> 下列步骤需在已接入本私服的客户端（2.7.61）上执行。方法/字段名以真机 dump 校准为准（客户端版本可能漂移）。

### 4.1 敌人血量显示
1. 进入任意战斗关卡，部署干员并引出敌人。
2. 观察敌人血条旁是否出现红色「当前/最大」血量文本。
3. 启用/停用切换：面板或 admin 端点 `enable`/`disable` enemy_hp 后重新进图，验证文本出现/消失。

### 4.2 敌人属性面板
1. 战斗中按住 `Z` 键并点击敌人。
2. 观察左上/右上出现半透明面板，显示名字/ID/攻击/防御/法抗/移速/重量/目标点。

### 4.3 战斗辅助
- 右上角显示「战斗时间: x.xxxs」时间轴。
- 战斗中按 `X` 暂停/继续；`Alpha1` 单帧；`Alpha3` 三倍速。

### 4.4 插件管理面板
- 登录后主界面出现右下角「插件」浮动按钮（面板在引导阶段延迟挂载：Canvas 就绪或首次进入战斗后出现），点击开合管理面板。
- 面板列出各插件，点「切换」实时启停，并持久化到客户端 `persistentDataPath/plugin_config.json`，同时推送服务端 `data/plugin/config.json`。

## 5. 版本漂移校准

`reference/arknights-2.7.61-csharp` 的 `.cs` 源文件已被 gitignore 移除（仅剩 csproj），方法签名以 `[uc]lua` hotfixer 与 Arknights-Assist JS 为准。若真机报错，按如下方式校准：

1. 用 Frida dump 客户端 il2cpp：`Il2Cpp.dump("d.cs")`（见 `hook/main.ts`）。
2. 搜索目标类（如 `Torappu.Battle.UI.UIUnitHUD`），核对字段/方法名（`_hpSlider`、`Attach`、`get_groupStatic` 等）。
3. 修正 `lua/plugin/*.lua` 中的类名/方法名后重新 `pnpm run repack:lua`（或 `watch:lua`）下发。

所有 hotfix 均经 `xpcall` 兜底，单点失败不会崩溃，仅记 `LogHotfixError`。

## 6. 本仓库可验证项 vs 真机验证项

| 项 | 验证方式 |
|---|---|
| `pack-lua-bundle` 多资产打包/解包 | vitest |
| `pack-lua-plugins` 产出结构 | vitest |
| `PluginConfigService` 读写/幂等/回退 | vitest |
| admin 插件端点 | vitest |
| Lua 插件实际加载/UI 显示/热更 | 真机手动（见 §4） |