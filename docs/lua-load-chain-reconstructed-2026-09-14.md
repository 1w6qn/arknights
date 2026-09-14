# 从 AssetBundle 到 Lua 执行：加载链路源码还原（2.7.71 Android）

本文还原「客户端如何从热更 bundle 一路走到 `entry.lua` 执行 / 插件 hotfixer 加载」的完整链路，并给出沿途**实测**的格式与约束。目的是解释我们私服 mod 的两个现象：**插件永不执行** 与 **加载我们重打包的 bundle 即崩**。

> 素材与证据等级：反编译源码 `reference/arknights-2.7.71-csharp/`（Cpp2IL，**方法体常被破坏**：`throw new Cpp2IlInjected.AnalysisFailedException` / `__Gen_Delegate_Imp*`；字段与方法签名、RVA 可信）。Lua 侧为**官方真机 bundle 解出的明文**（`tmp/official-lua.bin` 内的 344 个 TextAsset），比 `tmp/apk-work/2.7.71/lua-plain/`（339 个，**过期素材**）权威。
> 标记约定：**【确证】** = 有可复现证据；**【推断】** = 由调用点/格式反推；**【不可读】** = Cpp2IL 丢失方法体。

---

## 0. 端到端链路（一图流）

```
[热更阶段]
  version/network_config ──→ VersionCompat.CUR_FUNC_VER = content.funcVer      【确证】(HotUpdateViewController.cs:4266)
  下载 anon/63bbacd2….bin ──→ <persistent>/Bundles/anon/63bbacd2….bin          【确证】(设备实测)
  ConsistencyChecker: 长度 == abSize 即判有效（meta&1 ⇒ 跳过 md5）              【确证】(ConsistencyChecker.cs:213-233)

[启动阶段 · C# 侧]
  GlobalInitializerAndUpdater.Awake (:726)                                      【确证】
    → _DoInitInAwake (:734) → _LoadInitialAssetsImpl(true) (:830)
      → LuaManager.ReloadScripts() (:924) / LuaManager.InitIfNot() (:925)       【确证】
        → LuaManager 构造期 _DoCreateLuaEnv()（:666 → :463-506）
             new LuaEnv() + AddBuildin("rapidjson") + 注入 TEST/UNITY_EDITOR/HOTFIX_ENABLE=true/DEVINFO_ENABLE (:585-608)
             m_env.AddLoader(_CustomLoader)                                     【确证】(LuaManager.cs:499-500)
        → _DoLoadEntryScript(options) (:283-319)
             m_folder = LuaOptions.luaFolder（推断 = "gamedata/[uc]lua"）
             m_env.DoString("require 'entry'")                                  【确证】(LuaManager.cs:296-298)
               → xLua searcher#3（StaticLuaCallbacks.cs:1001）→ LuaManager._CustomLoader (:423-426) 【不可读】
        → LuaEntry.Init/Dispose/Update = _G.GetInPath("EntryTable.*") (:302-304) 【确证】
        → LuaEntry.Init()（:306 只剩 invoke 残迹）                              【推断】

[Lua 侧 · 官方明文]
  entry.lua（2,489B）
    require "GlobalConfig"                                        ← CUR_FUNC_VER = "V077"
    if CS.Torappu.VersionCompat.CUR_FUNC_VER ~= GlobalConfig.CUR_FUNC_VER then
        → EntryTable.Init/Dispose 变空实现；**顶层 return 结束整个 chunk**   ★ 版本门禁
    EntryTable.Init():
        Preprocess()
        local fixes = require("Hotfixes/DefinedFix")   ← 返回 hotfixer 清单
        HotfixProcesser.Do(fixes)                      ← ★ 插件/官方 hotfix 的驱动点
        InitFeature()（LuaUIContext.SetDialogMgr / ModelMgr.Init / DlgMgr.Init / TimerModel）
        InitBattle()
    CS.Torappu.Lua.LuaEntry.Init/Update/Dispose = EntryTable.*

  HotfixProcesser.Do(fixes)（HotfixProcesser.lua:10-22）
    for _, v in pairs(fixes): cls = require(v); mo = cls.new();
        table.insert(m_fixes, mo); xpcall(mo.Init, debug.traceback, mo)   ← 单条失败只记日志
  HotfixBase:Init() → self:OnInit()；Fix/Fix_ex → xlua.hotfix + _Record（HotfixBase.lua:5-51）
```

## 1. bundle 的**寻址方案**（客户端怎么找到 `entry.lua`）

| 层次 | 值 | 证据 |
| --- | --- | --- |
| `.idx` 清单（`manifestName` 指向的 `ResourceManifest` FBS） | `gamedata/[uc]lua/entry.lua` → `bundleIndex 2455` → `bundles[2455].name = anon/63bbacd2fab677125a1516d4396114ab.bin` | `reference/ArknightsGameData/zh_CN/resource_manifest_idx.json`（344 条 `gamedata/[uc]lua/**` 全指向 2455）【确证】 |
| bundle 内 AssetBundle 对象（class 142） | `m_Name = init/gamedata/[uc]lua.ab`，`pathId = 1` | 实测解包 `tmp/official-lua.bin`【确证】 |
| **容器 key**（`AssetBundle.LoadAsset(key)` 用） | `dyn/gamedata/[uc]lua/**<小写相对路径>**.lua.bytes`（344 条） | 同上【确证】 |
| TextAsset 的 `m_Name` | **裸 basename**（`entry.lua`、`DefinedFix.lua`…），不含目录 | 同上【确证】 |

**要点**：目录信息只存在于「清单 + 容器 key」，`m_Name` 是裸名 —— 这正是 `require "Base/BaseModule"` 能命中扁平资产的原因；重打包**必须保留容器 key 集合**（本仓 `scripts/vendor/unityfs.ts#parseSerializedFileFull` 的注释也写了这一点）。

`.idx`（`ResourceManifest`，FBS）字段只有 `RawCount / Bundles[Name,Props,SccIndex,AllDeps] / AssetToBundleList[AssetName,BundleIndex,Name,Path]`，**没有 offset/size/hash 列** ⇒ 替换 bundle 内容不会造成清单错位；但**新 asset 名必须先出现在清单里**——这是「插件只能内联进 `entry.lua`、不能新增 .lua 资产」的根本原因。【确证】(recon-B §5)

## 2. Lua 密文格式与解密（CRYPTIC_A）

```
m_Script = [128B 随机头][16B IV^mask][AES-128-CBC(PKCS7)]        （enc = 144 + pad16(plain)）
mask     = "UITpAi82pHAWwnzqHRMCwPonJLIB3WCl"   ← Torappu.PlayerData.chatMask (PlayerData.cs:184)
key      = UTF8(mask[0:16])    iv = 密文[128:144] XOR UTF8(mask[16:32])
```
- 解密实现：`Torappu.DB.ConverterFactory.Create(CRYPTIC_A)` → `CrypticConverter_A.DecodeInternal`（`CrypticConverter_A.cs:113-166`，`CreateDecryptor :144`）；`LuaOptions.cryptType = CRYPTIC_A`（`LuaOptions.cs:28`），仅在 `DBOptions.Mode.PRODUCTION` 下构造解密器（`LuaManager.cs:147/266`）。【确证】
- **128B 头的跳过点不在可读 C# 里**（`ConverterInput.ReadContentBytes` = `ReadAllBytes(0)`）；全树唯一的 `override ReadContentBytes` 属于 excel 用的 `CrypticConverter_WithSign`（128B = RSA 签名头）。⇒ 128B 跳过应发生在 `_CustomLoader`（方法体不可读）。【推断】
- **xLua 未启用 `SignatureLoader`** ⇒ **无 Lua 脚本签名校验**。【确证】
- 我们本仓的 `scripts/vendor/lua-crypt.ts` 与该格式一致，且**用同一把 mask 能成功解密官方 344 个资产中的 320 个**（其余为二进制/空），说明 key 与头布局正确。【确证】

## 3. 加载期**没有**完整性校验（重要）

- 5 处 `AssetBundle.LoadFromFile` **全是单参**；全树 `AssetBundleManifest` / `crc` 关键字 **0 命中** ⇒ 加载 bundle 时不校验 CRC/清单/依赖。【确证】(recon-B §4)
- 校验只在**启动持久层**：`ConsistencyChecker.cs:213-233` 以 `长度 == abSize` 判有效；`PersistentResRecover.cs:551-582` 只在 `meta&1 == 0` 时才算 md5 —— 匿名 bundle `meta=1` ⇒ **只比长度**。
- 另有 `manifestVersion` 门禁（`BundleRouter.cs:174-178`）。
- bundle 名不硬编码，来自 `.idx`（`bundleIndex → name`）；加载顺序 `<persistent>/Bundles/…` 优先、否则 APK 内 `assets/AB/Android/…`（`BundleHolder.cs:166`）。【确证】

⇒ 我们下发的 mod 之所以能被接受并加载，是因为**长度对得上**（`abSize` = 解压后 bundle 字节数，客户端落盘后长度一致）。

## 4. 两条实测出来的真问题

### 4.1 ★ 私服 `funcVer` 与客户端 Lua 版本不匹配 ⇒ Lua 侧整套初始化被跳过

- 客户端：`GlobalConfig.lua` → `CUR_FUNC_VER = "V077"`；`entry.lua:4` 做等值判断，不等则 **`EntryTable.Init` 变空实现并顶层 `return`**（chunk 提前结束，后续追加的代码**也不会执行**）。
- 私服：`data/config.json:24` → `"funcVer": "V070"`，经 `network_config` 原样下发 → `VersionCompat.CUR_FUNC_VER`（`VersionCompat.cs:12`，后端字段 `s_targetFunVer`；唯一写入点 `HotUpdateViewController.cs:4266 = content.funcVer`）= `V070` ≠ `V077`。
- ⇒ **在私服上跑，客户端 Lua 主流程根本不执行**（`DlgMgr/ModelMgr` 不初始化、`HotfixProcesser.Do` 不被调用）——这与「插件从不启动」的现象**完全吻合**，且**与 bundle 是否被替换无关**。
- 修复：把 `funcVer` 改成与客户端一致的 `V077`（并加回归守卫：客户端 `GlobalConfig.CUR_FUNC_VER` 与私服下发值必须一致）。验证手段：`logcat` 搜 `not compatible with current c#`（门禁里的 `print`）。

> 注：这条也解释了为什么 `_dtTrace` 的 `[DoctorateTs]` 从未出现——**即使 bundle 正常加载**，我们在 `entry.lua` 末尾追加的 prelude 也位于那条 `return` 之后。

### 4.2 ★ 崩溃源已定位到「我们重打包的 SerializedFile」

做过并排除的项（每项都是实测，不是推断）：

| 假设 | 实验 | 结果 |
| --- | --- | --- |
| 清单条目身份字段（hash/cid/cat/meta）写法 | 改为保留官方身份字段 | **修复了下发**（客户端开始下载 mod）✅ |
| 是 frida/ACE 环境问题 | 同一 frida 管线 + 官方 bundle | **0 崩溃**（进程健康）⇒ 崩溃由我们的 bundle 引起 |
| UnityFS 容器/CAB 名 | 用官方 CAB `CAB-86d1ff…` + 128KiB 分块 + mode-4 LZ4AK 重建（v2） | **仍崩** ⇒ 容器参数不是原因 |
| 资产集合/容器 key/映射/pathId | 逐项对比官方 vs 我们：344 资产名一致、344 容器 key 一致、`key→资产名` 映射 344/344 一致、按名比 `pathId` 全部相同、AssetBundle `m_Name`/`pathId`(1) 相同 | 全部一致 ⇒ 寻址层无缺陷 |
| 密文格式 | `enc = 144 + pad16(plain)`：官方 +151、我们 +148/+152 均自洽；同 mask 可解官方密文 | 加密/解密正确 |
| **容器机器 vs SF 内容（C1）** | 用**官方 SF 字节零改动**套我们的容器（`buildUnityFSCompressed` + 官方 CAB） | **0 崩溃、进程健康**、设备端文件即我们的容器产物 ⇒ **容器机器没问题** ✅ |
| **SF 构造器 vs 内容变大（C2）** | 用 `packLuaBundle` 重建一份**内容与官方逐字节相同**的 SF（原样传官方密文/容器 key/pathIds/typeTable），再套同一容器 | 客户端**下载后拒绝并回退到内置 bundle**（设备端 md5 仍是官方 `e27e60f9…`、`persistent_res_list` 令牌仍是 `d21c`），全程无崩溃 ⇒ **缺陷在 SF 构造器本身，与内容变大无关** ✅ |

⇒ 结论：`scripts/pack-lua-bundle.ts` 的 **`buildSerializedFile`（从头重建）产出的 SF 不被客户端接受**；`inject-lua-inplace.ts` 的「原位改写 m_Script、保留官方结构」路径未参与本次产出，也没被证伪。

**已定位到的唯一剩余结构差异**（C2 与官方 SF，内容逐字节相同）：

| 字段 | 官方 | 我们（C2） |
| --- | --- | --- |
| `metadataSize` | 10,777 | 10,761 |
| `dataOffset` | **10,832 = align16(48+10,777)** | **12,288 = align4096(48+10,761)** |
| SF 总长 | 1,154,896 | 1,156,352（差 1,456 ≈ 1,479−7 的填充差） |
| 对象表顺序 | — | 与官方不同（但按资产名比 pathId/尺寸完全一致，容器映射一致） |

即**唯一可归因的偏离是 `dataOffset` 用了 4096 页对齐**（`pack-lua-bundle.ts` 注释写明"并对齐 4096 页"），官方是 16 字节对齐、填充仅 7 字节。**最小下一步实验 C3**：把该对齐改成 16（`DATA_OFFSET = align16(48 + metadataSize)`）重建，若客户端接受则缺陷与修复同时确认（一行改动）。

补充：本次崩溃**落了 tombstone**（`/storage/emulated/0/Android/data/com.hypergryph.arknights/files/tombstone_01`），但信号是 `SIGSEGV, code 0 (SI_USER)`、`fault addr --------`（空）——**由 `kill/tgkill` 投递的人造信号**（Houdini 也会用 tgkill 把 guest 异常转发给 guest 线程），故 tombstone 只有崩溃线程 2 帧（`nb/libc.so (syscall+32)` + `<anonymous>`），需在 guest 侧（arm64 agent 的 `Process.setExceptionHandler`）才能拿到真实故障栈。

## 5. 插件套件本身的缺陷（与崩溃无关，但会独立导致"插件不生效"）

来自对 `lua/plugin/*.lua` 与注入后 `tmp/entry-injected.lua` 的实读：

1. **`NetworkRedirectPlugin` 是死代码**：`PluginDefs` 只登记 4 个插件，该文件从未被 `require` ⇒ 私服重定向插件不会生效。
2. `PluginHeartbeat` 用 `UISender:SendGet(...)`（把类表当 `self`），而官方一律 `UISender.me:` ⇒ 回调挂错对象，服务端启停同步不生效。
3. `_SendOnce` 把 **xpcall 成功标志**当"是否发出"返回，且 `UISender == nil` 的早退也会把 `_autoConfirmed` 置真 ⇒ 重试链与战斗 UI 兜底全部静默放弃。
4. `ScheduleAuto` 跑在 `ModelMgr.Init` 之前，此时 `TimerModel.me` 为 nil ⇒ 延时重试根本不会排。
5. 风险：官方 `HotfixBase:Dispose` 用 `xlua.hotfix(cls, method, nil)` 整槽卸载，会抹掉我方 `PluginHotfix` 对同一方法的包装（两套注册表互不感知）。
6. 注入形态（供参考）：`DefinedFix.lua` 的清单是把它插到 **list 头部**（早于官方 6 条）；`entry.lua` 是**前 2,489 字节原文 + 追加 prelude**（非替换），唯一 chunk 级副作用是 `_dtTrace("preload registered, modules=12")`。

## 6. 复现命令

```bash
# 1) 解出官方 / 我们的 SerializedFile 与容器参数
node_modules/.bin/tsx tmp/dump-sf.ts          # → tmp/sf-{official,mod}.bin
node_modules/.bin/tsx tmp/cmp-unityfs.ts      # 容器头/分块/CAB 对比
node_modules/.bin/tsx tmp/cmp-container.ts    # 容器 key → 资产映射对比
node_modules/.bin/tsx tmp/cmp-by-name.ts      # 按资产名比 pathId/尺寸
node_modules/.bin/tsx tmp/check-sf-objects.ts # 对象区间越界/对齐

# 2) 对照实验：官方 SF + 我们的容器（C1，已验证不崩）
node_modules/.bin/tsx tmp/build-control1.ts

# 3) 双 agent 管线（只挂 il2cpp 层重定向）
python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js --java-script "" --duration 140
```

## 7. 修复记录与剩余问题（2026-09-14 首轮）

> 本节记录首轮修复（SF 构造器对齐 / CAB 名 / funcVer / 插件缺陷）。同日续作的探针与更精确的断点定位见 §8。

### 7.1 已修（含验证）

### 7.2 仍未解决：客户端加载我们重打包的 SF 时崩在 `libunity.so`

> ⚠️ 第 1 项修复只是让客户端**接受**了该 bundle（不再回退），**崩溃依旧**：冷启动后 guest（ARM64）栈为
> ```
> D houdini : [945]     #00  pc 00000000005015e0  /data/app-lib/Yxmrfz2/libunity.so
> D houdini : [945]     #01  pc 0000000000502314  /data/app-lib/Yxmrfz2/libunity.so
> ```
> 即**真实故障在 Unity 引擎内部**（先前的 `SIGSEGV/SI_USER` 是 Houdini 把 guest 异常转发给 guest 线程的结果）。
> `entry.lua` 拼装产物（51,797B）**语法已过 luaparse**、24 项结构对照全部一致，且从无 `[DoctorateTs]` ⇒ 故障发生在
> 「bundle/资产被 Unity 读取」阶段，早于 Lua chunk 执行。
> `tmp/rev2/libunity.so`（从 APK 提取，20,000,304B，**stripped**）中 `0x5015e0` 附近最近的导出符号是 `UnitySendMessage@0x42e730`（差 863KB），无法直接符号化。

**下一步（按性价比）**：
1. **改用原位注入路径**（推荐）：`inject-lua-inplace.ts` 保留官方 SF 逐字节结构、只把目标资产的 `m_Script` 密文替换为**等长**密文——绕开我们的 SF 构造器。代价：明文受该资产预算限制（官方 `entry.lua` 密文仅 2,640B ⇒ 明文 ≤ ~1.9KB），**装不下 46KB 插件套件**；可行设计是只注入一个极小引导，由它经私服 HTTP 拉取插件源码并 `loadstring`/`load()` 执行（`.idx` 清单固定 ⇒ 本来也不能新增资产）。
2. **符号化 `libunity.so+0x5015e0`**：找 unstripped 版本（Unity 官方 sym 文件 / 另一渠道构建）或直接反汇编该地址，确认 Unity 在校验/读什么（对齐？类型树？对象尺寸？），再回到构造器修。
3. 复核对象**数据区**的逐对象序列化形态（TextAsset `m_Name`/`m_Script` 的字符串对齐、AssetBundle `m_Container`/`m_PreloadTable` 尾部）与官方是否逐字段一致——目前只验证了「我们的读器能读、名称/尺寸/映射一致」，尚未与官方做**字节级**对象内布局对照。

## 8. 续作（同日）：Lua 加载器探针与「插件为何永不启动」的定位

### 8.1 新工具：`LuaManager._CustomLoader` 探针（已并入 `hook/il2cpp-client-redirect.ts`）

底层 `Interceptor.attach(method.virtualAddress)` 挂钩 `Torappu.Lua.LuaManager._CustomLoader(ref string) → byte[]`，打印**模块路径 + 返回明文的长度与头部**。要点：

- 该方法的参数签名是 **`this,System.String&`（按引用传递）** —— 按值读会拿到空串，必须先解一层引用（`args[i].readPointer()` 再 `readString`）。这条踩坑记录在案。
- 返回的 `byte[]` 是**解密后的明文**：长度在 `+0x18`（szarray 布局），数据在 `+0x20` —— 于是可以直接看到「加载器到底把哪份内容交给了 xLua」。
- 返回 `retval.isNull()` ⇒ 打印 `len: -1`，即**该模块解析失败**（xLua 的 `require` 会抛错）。

### 8.2 用探针看到的真实链路（无崩溃）

```
entry.lua               → 2489  ✓
GlobalConfig            → 224   ✓
Base/BaseModule …       → ✓（Base/Utils/*、Base/Collections/*、Base/Dialog/* 全在加载）
Base/Hotfix/HotfixBase  → 887   ✓
Base/Hotfix/HotfixProcesser → 735 ✓
Hotfixes/DefinedFix     → 265   ✓（= 官方明文长度）
HotFixes/TestStubHotfixer → -1  ✗ ← 解析失败！链子在这里断
（随后 400+ 条 Feature/* 模块继续加载 —— Lua 系统本身完全正常）
```

结论：**Lua 系统在跑、`entry.lua` 与 `HotfixProcesser` 都在跑，断点精确落在第一个 hotfixer 的 `require`**：
`HotfixProcesser.Do(fixes)` 的 `require(v)` 失败 → `EntryTable.Init` 中止 → 插件永不加载（且不崩溃）✓ 与「无 `[DoctorateTs]`、无 trace 文件、无 heartbeat」完全一致。

### 8.3 两个关键判定

1. **客户端确实在用我们的 bundle**：把 `Hotfixes/DefinedFix` 原位改成明显不同的内容后，探针里它的解析结果从 `265 ✓` 变成 `-1 ✗`（改回不动的资产又恢复 ✓）。此前「客户端是否读热更 bundle」的疑问至此关闭。
2. **凡是被我们重新加密的资产，加载器一律返回 null**（`TestStubHotfixer` 与 `DefinedFix` 都复现），而**同一 bundle 内未改动的资产全部正常**。已排除的机制：
   - ❌ 明文长度：改成与原文等长（347 / 265）后仍 NULL；
   - ❌ 128B 头：改成保留原始头（`encryptLuaScript(plain, srcHead)`）后仍 NULL；
   - ❌ 容器 key / 寻址：`.../hotfixes/teststubhotfixer.lua.bytes` 在官方与我们的 bundle 里都存在；
   - ❌ 崩溃/反外挂：整条原位路径**零 SIGSEGV**（所有原位轮次 `signal 11` 计数为 0）。

   剩余候选：① 客户端解密器对密文有更严的约束（我们只验证了「自己的解密器能解自己的密文」+「同一 mask 能解官方密文」）；② hotfixer 类资产在发行包里**本就不可加载**（需用官方 bundle 做对照确认：官方内容下 `HotFixes/TestStubHotfixer` 是否也返回 -1）。

### 8.4 交付与下一步

本轮同时修掉了注入器的三个真问题（均已在仓库）：

- `--bundle-name` 参数（此前 zip 条目名写死 `anon/6edf14bb…`，与客户端实际拉取的名字不符）；
- 回读校验写死「TextAsset 应为 345」→ 改为与**源 bundle**计数比对（官方 `63bbacd2` 是 344，写死会让正确产物被判失败）；
- 引导脚本里的 `UISender:SendGet` → `UISender.me:SendGet`（与 §7.1 第 5 项同因），并把可观测性从「写文件」改为**游戏自带 Lua 日志**（`CS.Torappu.Lua.Util.LogHotfixError`），因为引导发生在 `UISender` 就绪之前、落盘 API 也不保证可用。

**下一步（按性价比）**：
1. **先确认 hotfixer 资产在官方包下能否加载**：恢复官方 bundle → 跑探针 → 看 `HotFixes/TestStubHotfixer` 是否解析成功。若官方也 NULL ⇒「注入 hotfixer 资产」这条路根本不通，必须换注入点。
2. **换注入点：替换 `Base/Hotfix/HotfixProcesser`（已证明被加载，明文预算≈735B）** —— 用我们自己的实现（≤735B，保持官方 `Do/Dispose` 语义）在其内部挂上插件加载与 `[DoctorateTs]` 埋点。这条路不依赖 hotfixer 资产是否可加载。
3. 若要走「大插件套件」路线，仍需解决 §7.2 的 **libunity.so 崩溃**（只有它能让 344 资产的大改动被接受）。




| # | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| 1 | **SF 构造器 `dataOffset` 用 4096 页对齐**（官方是 `align16(48+metadataSize)`，填充 ≤15B）——客户端会拒绝/回退该 bundle | `pack-lua-bundle.ts`：`metadataSize = metaContentAligned`（真实长度）、`DATA_OFFSET = (48 + metadataSize + 15) & ~15` | 用 `repack:lua` 重打包注入版 mod（`dataOffset=10816`、16 对齐）→ **客户端接受**（设备端文件 = 我们的 1,215,696B，不再回退为内置 1,121,653B）✅ |
| 2 | **CAB 名硬编码 `CAB-luahotupdate`**（官方是逻辑标识 `CAB-86d1ff…`，两个官方版本共用） | `buildUnityFS(sf, cabName)` 参数化 + `DEFAULT_LUA_CAB_NAME` 常量 + `PackOptions.cabName`；`repack:lua` 从源 bundle 取 `unityfsToSF().cabNodeName` 透传 | 新 mod 回读 `CAB=CAB-86d1ff11409b16a8308b9b0810871c29` ✅ |
| 3 | **私服 `funcVer` 与客户端 Lua 版本不一致**（门禁早退 → Lua 初始化整段跳过） | `data/config.json`：`NetworkConfig.funcVer` `V070→V077` + 档位键 `configs.V077`；`update-data.ts#syncGameVersion` 改为**优先采用客户端明文参考里的 `CUR_FUNC_VER`**（官服未签名请求返回的是旧档位 V070），不一致时告警；`proxy-harness.ts` 同步改 | 新增守卫用例（`tests/unit/config/remote-config.test.ts`：下发 funcVer 必须等于 `data/[uc]lua/GlobalConfig.lua` 的 `CUR_FUNC_VER`）通过；`remote-config`+`update-data-sync` 10/10 ✅ |
| 4 | **`NetworkRedirectPlugin` 是死代码**（未登记 ⇒ 永不 require） | `PluginDefs.lua` 增加 `network_redirect` 条目 | `entry.lua` 注入产物里出现 `network_redirect` ✅；12 个插件文件 luaparse 语法通过 |
| 5 | **`PluginHeartbeat` 三处缺陷** | ① 发送改 `UISender.me:SendGet(url, nil, {onProceed=..., useMask=false})`（官方 `UISender:SendGet` 内部用 `self.m_callbacks`，类表当 self 会让回调永不触发；官方 51 处全用 `.me`）；② `_SendOnce` 改为**只在真的发出时返回 true**（原先把 xpcall 成功标志当"已发送"，未就绪也标记 `_autoConfirmed`，导致重试链与战斗兜底静默失效）；③ `ScheduleAuto` 必然装战斗 UI 兜底 + 新增幂等 `_ScheduleRetries()`，在 TimerModel 就绪后（战斗 UI 阶段）补排延迟重试链 | 语法检查通过；行为修正在设备验证前 |
