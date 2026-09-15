# PC 官服客户端勘察：目录、防护面与注入实现方式

> 目标：`D:\Game\Hypergryph Launcher\games\Arknights`（官方 PC 客户端）
> 方法：只读静态勘察（PE 头/导入导出、资产字面量、反编译源交叉验证），未启动游戏、未触碰 ACE。
> 日期：2026-09-14 ｜ 工具：`tmp/pe-exports.py`（本次新增，极简 PE 导入/导出解析器）

---

## 0. 结论速览

1. **这个客户端已经被本仓反编译过**：`reference/arknights-2.7.71-csharp/` 就是它——Unity `2021.3.39f1`、IL2CPP metadata `v29`、游戏版本 `2.7.71`，三处指纹完全对齐（见 §1.3）。schema/types 链路的地基就在这个目录上。
2. **私服所需的两处"开关"都在明文可改的资产里，不需要注入**：
   - 全部服务端入口 URL 是 `Arknights_Data/sharedassets1.assets` 里的 Unity 序列化字符串字面量（56 处命中）；
   - 客户端验签公钥是 `Arknights_Data/sharedassets0.assets` 里**唯一**一个 `<RSAKeyValue>`（offset **73040**）。
   - 两者都可**等长原地改写**（见 §5），且**不改动任何带 Authenticode 签名的二进制**——这正是 Android 上"重签名 APK 必被 ACE 击杀"的反面。
3. **要注入也有明确入口**：本机 KnownDLLs 只有 39 项、**不含 `version.dll` / `winhttp.dll`**，而 `UnityPlayer.dll` 的导入表里两者都有 ⇒ 游戏根目录放同名代理 DLL 即可在 `UnityPlayer` 加载期拿到用户态代码执行（UnityDoorstop 同款机制）。
4. **拿到代码执行后要做什么，本仓已有 90% 的现成答案**：PC 与 Android 的 Lua 层契约同构（`LuaManager.InitIfNot → _DoLoadEntryScript → LuaEnv.DoString`），`hook/il2cpp-client-redirect.ts` 里那些"与平台无关"的坑（DoString 重载消歧、在 `_DoUpdate` onEnter 注入、读 `LuaManager.m_env`、hotfix 桥遮蔽）可以逐条搬过来。
5. **唯一的真障碍是 ACE**（内核驱动 + 进程内 63MB `ACE-Base64.dll`，含 Detours 节区）。按本仓红线：不 hook、不禁用、不欺骗 ACE。因此：
   - **私服投递首选"零注入"路线**（§5）；
   - 运行时注入只作为**本机研究手段**（§4），不要拿官方账号跑。

---

## 1. 勘察结果

### 1.1 目录清单（游戏根 `games/Arknights/`）

| 条目 | 体积 | 判读 |
| --- | --- | --- |
| `Arknights.exe` | 0.8 MB | 仅导入 `ArknightsBase.dll`；9 个节区全部叫 `.std`（节名抹除）；入口在 `.std`；overlay 21 KB ⇒ **TVM 加固壳**，真逻辑在下层 |
| `ArknightsBase.dll` | 34 MB | 只导入 `kernel32.dll` ⇒ 自己 `LoadLibrary` 拉起 `UnityPlayer.dll`；含 `.tvm0`（25 MB，可执行） |
| `UnityPlayer.dll` | 31 MB | 导出唯一 `UnityMain`；导入 19 个系统 DLL（含 **`VERSION.dll`、`WINHTTP.dll`、`SETUPaPI.dll`、`IMM32`、`SHLWAPI`、`WS2_32`…**）；含 `.tvm0` + `.Ovo` + `_RDATA` |
| `UnityPlayer.dll.tvmp` | 953 B | TVM 配置（明文 XML，见 §2.1） |
| `UnityPlayer.pdb` | 23 MB | **官方把符号文件一起发了** ⇒ UnityPlayer 内部函数名/偏移可直接查 |
| `GameAssembly.dll` | 205 MB | IL2CPP 原生代码；**393 个 `il2cpp_*` 导出**齐全；节区 `.text / il2cpp(106MB) / .Sgxm0 / .Sgxm1 / .edata2 / .rsrc2 / .tvm0(9MB)`，入口点落在 `.Sgxm0` |
| `Arknights_Data/il2cpp_data/Metadata/global-metadata.dat` | 45 MB | magic `0xFAB11BAF`、**version 29** |
| `Arknights_Data/Plugins/x86_64/xlua.dll` | 0.8 MB | **xLua / Lua 5.3.5**，251 个导出（`luaL_loadbufferx`、`luaopen_xlua`…） |
| `Arknights_Data/Plugins/x86_64/` 其余 | — | `HGP.dll`（鹰角平台）、`cri_ware_unity/mana_vpx`（CRI 音频）、`CrashSight64.dll`、`lib_burst_generated.dll` |
| `baselib.dll` | 0.24 MB | Unity 官方 `il2cpp_baselib`（导出 `il2cpp_baselib::Thread` 等）——**不是**外来模块，排除误判 |
| `AntiCheatExpert/` | 78 MB | ACE：`ACE-BASE.sys`/`ACE-CORE.sys`(+`.sys2`/`.sysa`/`.sysa2` 变体)、`ACE-Service64.exe`、`ACE-Setup64.exe`、`ACE-Base64.dll`(**63 MB**，节区含 `.detourc`/`.detourd` ⇒ Detours)、`ACE-Base.dat` |
| `Arknights_Data/{sharedassets0,1}.assets` | 0.4 / 9.5 MB | 网络字面量 + 验签公钥（§1.2） |
| `Arknights_Data/PersistentData/Bundles/` | 1.5 GB | 热更落盘：`hot_update_list.json`(3.2MB)、`persistent_res_list.json`、`anon/*.bin`、`config/*.ab`、`8e12a0…idx`(34MB) |
| `Arknights_Data/StreamingAssets/AB/Windows/` | — | 随包资源：同款目录树（`anon/`、`config/`、`refs/`、`battle/`、`ui/`…），含 `hot_update_list.json` |
| `CefView/` + `Qt5*.dll` + `plugins/`+`sdkplugins/` | ~600 MB | 启动器/登录/webview 层（Qt5 + QCefView），与游戏进程分离 |

### 1.2 两处关键资产（本次最硬的证据）

**(a) 服务端入口 = 明文 URL 字面量**，在 `sharedassets1.assets`，共 56 处，例如：

```
https://ak-conf.hypergryph.com/config/prod/official/network_config
https://ak-conf.hypergryph.com/config/prod/announce_meta/
https://ak-gs-gf-audit.hypergryph.com
https://core-api-account-stable.hypergryph.net/u8
https://game-config.hypergryph.com/api/remote_config3
https://ak-asset.hypergryph.com/audit/official
https://ak-webview.hypergryph.com/            https://ak.hycdn.cn
https://gs-n-1-ak-biz.hypergryph.net.         …
```

这与 Android 侧 `scripts/apk-url-redirect.ts` 的注释完全一致（"客户端所有网络入口都是 `sharedassets1.assets` 里 Unity 序列化字符串表中的字面量"）——**PC 上同一个文件、同一批字面量，区别只是它是个散文件，不用回灌 APK、不用重签名**。

**(b) 验签公钥 = `sharedassets0.assets` 里唯一一个 `<RSAKeyValue>`**，offset **73040**：

| | Modulus(base64) | 位数 |
| --- | --- | --- |
| 客户端内官方公钥 | `r5bwHN3uAWXNb7XP+OY0yjKQxXA7…` 长度 **172** | 1024 |
| 本仓 `data/crypto/public.xml` | `rMoTooSp2pedN3bvm46CQ+YyPhFwvNiK…` 长度 **172** | 1024 |

⇒ Modulus 等长，**可原地等长替换**（`Exponent=AQAB` 一致）。

**为什么公钥是私服的咽喉**：`Torappu.Network.NetworkRouter._DeserializeRouterContent`（反编译源 `Assembly-CSharp/Torappu.Network/NetworkRouter.cs:407`）用 `GlobalOptions.cryptoPubKey.text` 对 `network_config` 内容做 `CryptUtils.VerifySignMD5RSA`；同一把公钥还管 `BsonNetConverter_WithSign`、`CrypticConverter_WithSign`、`FlatBufferSignedConverter`（Lua 资产也走 `CRYPTIC_A + RSA` 验签）。换句话说：**换掉这把公钥 = 私服可以对客户端下发任意"合法"内容**；不换，就只能原样回放官服签名块，而块里的 as/gs 地址改不了。

### 1.3 版本对齐（确认反编译源可用于 PC 注入设计）

| 指纹 | 本机 PC 客户端 | `reference/arknights-2.7.71-csharp/` |
| --- | --- | --- |
| Unity | `2021.3.39f1`（`UnityPlayer.dll` 字符串 + `globalgamemanagers`） | 2021.3（doc 记载） |
| IL2CPP metadata | **29** | 29 |
| 游戏版本 | `2.7.71` | 2.7.71 |

⇒ 注入挂钩点可以直接照反编译源找，不必先做 RVA 逆向。

---

## 2. 防护面

### 2.1 TVM（腾讯 VMProtect 系）

`UnityPlayer.dll.tvmp` 明文可见——**保护强度比想象中低**：

```xml
<protect><iat_protect value="0"/><section_protect value="0"/><anti_debug value="0"/></protect>
<vm><decoder name="crt"/><memory_integrity enable="true"/>
  <functions>
    <function name="UnityMain" vmtype="V"/>
    <function name="UnityMainImpl(...)" vmtype="V"/>
  </functions></vm></config>
```

- 只有 `UnityMain`/`UnityMainImpl` 被虚拟化；IAT/节区保护都关；
- **`memory_integrity=true`**：UnityPlayer 自身有内存完整性校验（改它的代码段有风险）；
- `GameAssembly.dll` / `ArknightsBase.dll` 没有各自的 `.tvmp` 文件，但都带 `.tvm0` 可执行节区，GameAssembly 的入口点在 `.Sgxm0` ⇒ 壳以"附加节区 + 入口跳板"形式存在。
- 结论：**改 GameAssembly/UnityPlayer 的字节是高风险动作**（完整性校验 + 下面 §2.2 的 ACE 文件校验双重）。

### 2.2 ACE（AntiCheatExpert）

- 系统服务 `AntiCheatExpert Protection`（本次查询：`Stopped / Manual`，游戏没在跑时不起）；
- 驱动 `ACE-BASE.sys` / `ACE-CORE.sys`（另带多份版本变体，按系统选择）；
- 进程内模块 `ACE-Base64.dll`（63 MB，导出 `InitAceClient`/`InitAceClient0..5`，节区 `.detourc`/`.detourd` ⇒ **Detours 挂钩**）：说明 ACE 在游戏进程内做 API 挂钩与自检，并有内核态可见性；
- **红线（沿用 MuMu 侧结论）**：不 hook ACE、不禁用 ACE、不欺骗 ACE；不做"起进程前抢跑/抢先注入以躲过 ACE 初始化"这类反作弊规避。

> 注：`CrashSight64.dll` 的字符串里出现 `AntiCheatExpert`（崩溃上报集成），这是唯一在静态字符串里露出的 ACE 关联点；游戏侧 C# 完全没有 ACE 代码（纯 native 层集成）。

---

## 3. 注入面：按"拿到代码执行"的时机排序

### 3.1 代理 DLL 劫持（推荐研究入口：最早、最省）

链路：`Arknights.exe` →(`import ArknightsBase.dll`)→ `ArknightsBase.dll` →(`LoadLibrary`)→ `UnityPlayer.dll` →(导入表)→ **`VERSION.dll` / `WINHTTP.dll` / …**

Windows 依赖解析顺序里**应用目录（exe 所在目录）优先于 System32**，除非该名字在 KnownDLLs 或进程调用了 `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`。本机实测 KnownDLLs 全量 39 项：

```
*kernel32, _wow64*, advapi32, clbcatq, combase, COMDLG32, coml2, DifxApi, gdi32, gdiplus,
IMAGEHLP, IMM32, MSCTF, MSVCRT, NORMALIZ, NSI, ole32, OLEAUT32, PSAPI, rpcrt4, sechost,
Setupapi, SHCORE, SHELL32, SHLWAPI, user32, WLDAP32, wow64*, WS2_32, xtajit*
```

⇒ **`VERSION.dll`、`WINHTTP.dll` 不在列表里，`UnityPlayer.dll` 又确实导入它们**：游戏根目录放一个同名转发 DLL，就能在 `UnityPlayer` 加载期（**远早于 il2cpp 初始化**）执行自己的 `DllMain`。

也可用的候选（UnityPlayer 导入表中同样不在 KnownDLLs）：`dwmapi.dll`、`HID.DLL`、`CRYPT32.dll`、`WINMM.dll`、`OPENGL32.dll`、`bcrypt.dll`。
**不可用**（是 KnownDLLs）：`SETUPAPI`、`IMM32`、`SHLWAPI`、`WS2_32`、`ole32`、`gdi32`、`SHELL32`、`user32`。

实现要点：
1. 代理 DLL 必须**完整转发**目标 DLL 的全部导出（`version.dll` 导出很少，最省事；用 `objdump -p` 生成 `.def` 转发，或运行时 `LoadLibrary("C:\\Windows\\System32\\version.dll")` + 手写转发函数）。转发不全 ⇒ `UnityPlayer.dll` 直接加载失败。
2. `DllMain` 里只做最小动作（不能阻塞/加载过重），把真正的加载丢到新线程或 `UnityMain` 之后。
3. 载荷用 `GetModuleHandleW(L"GameAssembly.dll")` + `GetProcAddress` 取 **393 个 `il2cpp_*`** 里的 API（`il2cpp_domain_get` / `il2cpp_class_from_name` / `il2cpp_class_get_method_from_name` / `il2cpp_runtime_invoke`…），即可不用任何第三方桥就把托管方法找出来。挂钩用 MinHook/Detours（自己带，别碰 ACE 的 detour）。
4. 风险：ACE 会枚举模块/校验签名 ⇒ 未签名的额外模块是显眼目标。**这是"能跑"与"不被 ACE 处理"之间的取舍**，不要在官方账号上试。

**这一步有一个便宜的验证探针**（强烈建议先做）：在游戏根放一个 `version.dll`，`DllMain` 里写一行标记文件到 `%TEMP%`，其余导出全部转发。启动游戏（断网/小号）看标记是否出现 ⇒ 一次性确认"应用目录优先 + 时机早于 il2cpp + ACE 是否当场拦截"三件事。

### 3.2 Frida（x64，研究用，最省力）

PC 与 MuMu 的本质差别：这里 **il2cpp 就是原生 x86_64**，没有 Houdini 翻译、没有 `Java.perform`/`Runtime.load0`、没有只能加载 ARM64 gadget 的双 agent 管线。`frida-il2cpp-bridge` 在 PC 上按常规方式即可枚举 `Torappu.Lua.LuaManager`、`Torappu.GlobalOptions`。

- 入口：`frida -f Arknights.exe`（spawn）或在 §3.1 的代理 DLL 里 `LoadLibrary` 一个 gadget；
- 复用：`hook/il2cpp-client-redirect.ts` 里与平台无关的部分——`XLua.LuaEnv::DoString` 的**重载消歧**（`"System.String","System.String","XLua.LuaTable"`）、注入时机选 `LuaManager._DoUpdate` 的 onEnter（Unity Update 驱动、不在 Lua 调用栈内）、从 `LuaManager.m_env` 取环境、以及"官方 Lua 会 hotfix `LuaManager`，不能只挂原方法体"的坑——**逐条成立**；
- Lua 载荷 `hook/plugin-lua.js`（12 模块 + 自建 searcher）可直接复用。
- 障碍：ACE 内核驱动 + 进程内 Detours 对调试器/注入线程的可见性。⇒ **只作为本机研究手段**，且要先明确"这是研究、不是投递"。

### 3.3 启动器 / Qt / CEF 层（能拿到执行，但不在游戏进程）

`Launcher.exe`/`Games.exe` 是 Qt5 + QCefView 应用，`plugins/`、`sdkplugins/`、`CefView/` 是经典的插件加载面，且这一层没有 ACE。

- 合理的用法：改启动参数/环境变量、预置文件（例如把补丁后的资产就位）、做网络抓包（本仓 `scripts/proxy-harness.ts` 已有官服代理 harness）；
- **不合理的用法**：拦 `CreateProcess` 把游戏以挂起态注入再恢复——那是绕 ACE 初始化，踩红线。

### 3.4 静态改二进制（不推荐）

`GameAssembly.dll` / `UnityPlayer.dll` / `ArknightsBase.dll` 三件套：TVM 完整性 + `.tvm0` 虚拟化 + ACE 文件/内存校验。收益（改 IL 逻辑）远小于风险。**除非**走 §5 那种"改数据资产（assets）不改代码"的路子。

---

## 4. 拿到代码执行之后：要做什么

三条，按优先级：

1. **换公钥**（等价于 Android `--pubkey-mode oursonly`）：定位 `Torappu.GlobalOptions` 单例的 `cryptoPubKey`(TextAsset) 字段，把 `.text` 指到我们的公钥字符串，或直接改客户端内的字符串对象。这解锁：私服 `network_config`、Lua 资产重签名、BSON/FlatBuffer 签名内容。
2. **注入 Lua**：`LuaManager._DoUpdate` onEnter → `LuaEnv.DoString(payload, "chunk", nil)`，与 Android 完全同构；`LuaOptions.entryFile` + `require '<entryFile>'` 的引导方式也一致（`Assembly-CSharp/Torappu.Lua/LuaManager.cs:283-319`）。
3. **网络重定向**：`NetworkRouter._SendFetchConfigService` 对路由配置请求显式设了 `forceNotSecured = true` ⇒ 该接口允许明文 HTTP；`NetworkUtil.ConvertLatestUrl` 做 URL 规范化。Lua 侧网络重定向插件（`network_redirect`）因此同样适用于 PC。

---

## 5. 私服路线：先做"零注入"（推荐）

在 PC 上，Android 那套"改 APK→重签名→被 ACE 杀"的瓶颈**根本不存在**，因为我们只需要动两个**数据文件**，二进制签名完全不动：

| 步骤 | 对象 | 手法 | 证据 |
| --- | --- | --- | --- |
| 1 | `Arknights_Data/sharedassets1.assets` | 域名**等长改写**：`https://` → `http://`（省 1 字节）+ 主机名 +1 字符（如 `ak-conf` → `ak-confx`），整串字节数不变 ⇒ SerializedFile 字符串池长度前缀/偏移全不变 | 56 处字面量已列出（§1.2a）；映射表可直接复用 `scripts/apk-url-redirect.ts#DEFAULT_HOST_MAP` |
| 2 | 系统 `hosts` | `ak-confx.hypergryph.com` 等 → 私服 IP（另可用 §3.3 的代理层做 80 端口转发） | 与 Android 的 `/etc/hosts` + `adb reverse` 同构 |
| 3 | `Arknights_Data/sharedassets0.assets` @ `73040` | 官方 `<RSAKeyValue>` Modulus **等长替换**为本仓公钥（同为 172 字符 / 1024 位） | §1.2b；`pnpm run sign:key --gen` / `--patch-apk` 已有同类实现 |
| 4 | 私服 | 现有管线照发：`network_config`(签名)、`hot_update_list.json`、`anon/*.dat`、execl/delta… | 本仓 Android 侧已跑通 |

要点与注意：
- 第 1 步的等长改写是**整串**匹配（含路径），替换前建议先 `--list` 统计命中，替换后校验长度与偏移未变（Android 侧 `verifyPatchedApk` 的同类自检可移植过来，改成"文件字节 diff 只允许等长替换"）。
- `anon/*.bin` 在本地是 **UnityFS bundle**，官方 CDN 的 `.dat` 形态是"zip 包一层"——`tmp/audit/wrap-anon.mjs` 已经在做这件事，热更投递链路可直接复用。
- 顺序建议：**先只改第 1 步**跑一次（验证 ACE 不杀 + 客户端能连到私服），再加第 3 步（否则签名不过会在 `_DeserializeRouterContent` 抛 `NullReferenceException`，不易定位）。

---

## 6. 建议的验证顺序（便宜 → 贵）

1. **代理探针**：`version.dll` 转发 + 写标记文件 ⇒ 确认应用目录优先、时机早于 il2cpp、ACE 是否当场反应。（§3.1）
2. **零注入连通性**：备份后只改 `sharedassets1.assets` 一个主机名 + hosts 指向本地 ⇒ 看私服是否收到 `network_config` 请求（本仓抓包存储可直接看）。
3. **公钥替换 A/B**：替换 `sharedassets0.assets` @73040 ⇒ 私服返回自签 `network_config`，观察是否通过 `VerifySignMD5RSA`（失败点：`NetworkRouter.cs:407` 抛 `NullReferenceException`）。
4. **Lua 注入（可选，仅研究）**：Frida 或代理载荷，先打"`_DoUpdate` 命中计数"探针，再上 `hook/plugin-lua.js` 全量载荷。
5. 全程保留 `*.bak` 与回滚脚本；`tmp/pe-exports.py` 可复用于任何新版本客户端的导入/导出复核。

---

## 7. 与 Android/MuMu 路线的差异

| 维度 | Android（MuMu） | Windows PC（本目录） |
| --- | --- | --- |
| 游戏运行时 | x86_64 ART + **ARM64 Houdini 翻译** | 原生 x86_64 |
| il2cpp 枚举 | 需 ARM64 gadget + `Runtime.load0`，双 agent 日志管线 | `frida-il2cpp-bridge` 常规可用；或直接 `GetProcAddress` 393 个 `il2cpp_*` |
| ACE | `libtersafe2.so`，改包必被 ~10s 击杀 | `ACE-*.sys` 内核驱动 + 63MB 进程内 `ACE-Base64.dll`(Detours) |
| 网络入口 | `sharedassets1.assets.split*` 字面量 | `sharedassets1.assets` 字面量（**同一批**，散文件） |
| 改网络入口的代价 | 回灌 APK + 重签名（触发 ACE） | 直接改散文件，**签名不动** |
| 公钥 | 运行时 patch（frida `--pubkey-mode`） | 可静态等长替换（`sharedassets0.assets` @73040），也可运行时 patch |
| Lua 层 | xLua（平台无关契约） | xLua 5.3.5，`LuaManager` 契约同构，hook 逻辑可移植 |
| 额外情报 | — | 官方附 `UnityPlayer.pdb`；`UnityPlayer.dll.tvmp` 明文（保护参数可见） |

**一句话**：PC 侧机械难度全面低于 MuMu 侧（无翻译层、无 gadget 适配），真正的约束从"技术能不能"变成"ACE 允不允许"。

---

## 8. 风险与红线

- **不改 ACE**：不 hook / 不禁用 / 不欺骗 / 不抢先于其初始化。（本仓既有红线）
- **不碰签名二进制**：`Arknights.exe`、`ArknightsBase.dll`、`UnityPlayer.dll`、`GameAssembly.dll` 都带 TVM/ACE 校验，改字节高风险；优先改数据资产。
- **官方账号风险**：任何进程内注入对 ACE 都是可见的；研究请在断网/小号环境，且明确与"投递"分开。
- **未知项（需实测，不要臆断）**：① ACE 是否对 `Arknights_Data/*.assets` 做哈希校验；② `ArknightsBase.dll` 是否调用过 `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`（若是，§3.1 失效）；③ PC 登录链（U8SDK / `core-api-account-stable.hypergryph.net/u8`）私服是否已能签名应答。
  ⇒ 这三条分别用 §6 的探针 1～3 直接证伪/证实，成本都是一次启动。
