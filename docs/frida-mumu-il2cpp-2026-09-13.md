# MuMu 上把 Frida 接进 ARM64 il2cpp（2026-09-13）

**结论**：在 MuMu 12（明日方舟专版）上，**官方包、不改 APK、不重签名**即可拿到一个 **ARM64 Frida agent**，
进而 hook il2cpp 并输出详细 Unity 日志。落地工具：

```bash
node scripts/build-frida-hook.mjs                  # 打包 hook/ → hook/build/*.js
python3 scripts/frida-mumu-arm64.py --install-gadget   # 首次：把 arm64 gadget 装到设备
python3 scripts/frida-mumu-arm64.py --duration 60      # 冷启动 + 注入 + 双路日志
```

实测输出（冷启动后 ~5s 即挂好）：

```
  4.76s [arm64] {'t': 'il2cpp', 'unityVersion': '2021.3.39f1', 'assemblies': 88}
  4.79s [arm64] {'t': 'managed-entries', 'debug': ['Debug.Log(System.Object)[0]', ...], 'logger': ['Logger.Log(UnityEngine.LogType,System.Object)[2]', ...]}
  4.78s [managed] Debug.Log     frida-il2cpp-hook-online          ← 自证：agent 主动写的日志被钩子捕获
 11.20s [managed] Debug.Log     init():result: 0
 11.20s [managed] Logger.Log    GetLatestGame():start call queryLatestGameUpdateInfo...
  3.93s [native]  Unity         Company Name: HyperGryph          ← ARM guest liblog（引擎日志）
  3.63s [host]    EGL_emulation [getAttribValue] Bad attribute idx ← 宿主 x86_64 liblog（Java/宿主）
```

---

## 1. 环境事实（实测）

| 项 | 值 |
|---|---|
| 模拟器 | MuMu 12 明日方舟专版 `YXArkNights-12.0`，Android 12 / API 32 |
| 宿主 ABI | `ro.product.cpu.abi=x86_64`，`abilist=x86_64,arm64-v8a,x86,armeabi-v7a,armeabi` |
| native bridge | `ro.dalvik.vm.native.bridge=libnb.so`、`persist.sys.nativebridge=1` |
| 翻译器 | `libnb.so`（x86_64 垫片）→ `libhoudini.so`（x86_64，7.4 MB）；`get_translator_library_name()` 返回 `libhoudini.so` |
| 配置表 | `/data/system/etc/mumu-configs/abi-select-android12.config` → `com\.hypergryph\.arknights.*  x86`；`translator.config` → `:12_0_1_y_Netease_ev2:H:*:N` |
| 应用进程 | `app_process64`（**x86_64**），SELinux = Permissive，adb = `127.0.0.1:16384` |
| 应用库 | `/data/app-lib/Yxmrfz2/*.so`，全部 `e_machine=0xb700`（**AArch64**）：libil2cpp(210 MB)、libunity、libtersafe2… |

进程是 x86_64，但游戏的 Unity/il2cpp 是 ARM64，由 Houdini 在**同一进程内**翻译执行
（`/system/lib64/arm64/…` 是 guest bionic，`/system/lib64/arm64/nb/libc.so`、`liblog.so` 等）。

---

## 2. 障碍一：x86_64 agent 看不见 ARM64 模块

x86_64 `frida-server`（17.9.9）可以正常 attach，但：

```
Process.enumerateModules().length = 296        # 全部 e_machine=0x3e(x86_64)
Process.findModuleByName("libil2cpp.so") = null # 但 /proc/self/maps 里明明有
```

`/proc/self/maps`（x86_64 agent 视角）里 il2cpp/unity/tersafe 都在，只是 **Frida 的模块注册表按架构过滤**，
异架构 ELF 一律不出现在 `enumerateModules()` 里。这意味着：

- `Module.findExportByName("libil2cpp.so", …)` 拿不到；
- 即使手工按 maps 解析出地址再 `Interceptor.attach` 会「看似成功」（ARM64 代码段可读），
  但 **agent 是 x86_64，trampoline/ABI/CpuContext 全是 x86_64 的**，跨架构 hook 与 `NativeFunction` 调用都不可用。

⇒ 想要真正 hook il2cpp，必须让 **ARM64 agent** 进进程。

---

## 3. 障碍二：怎么把 ARM64 gadget 装进进程

试过并失败的路径（留作教训）：

| 尝试 | 结果 |
|---|---|
| x86_64 agent 里 `dlopen("/data/app-lib/…/libfrida-gadget.so")` | ✗ `dlopen failed: … is for EM_AARCH64 (183) instead of EM_X86_64 (62)` —— 宿主 linker 不认异架构 |
| 手调 `libnb.so` 的 `NativeBridgeItf.loadLibrary(path, flag)` | ✗ `access violation accessing 0x1`：`libnb` 只是转发器，真正实现在 Houdini，且**调用线程没有 Houdini 的 TCB**（guest 环境 `libtcb.so`） |
| `System.load` / `Runtime.load` | ✗ `NullPointerException: … Class.getClassLoader() on a null object reference`，栈顶就是 `Runtime.load0:934`——它们靠 VMStack 取**调用者类**，原生线程没有 Java 帧 |
| `Interceptor.replace` 掉桥的 `loadLibrary` 再注入 | ✗ 实测该入口在应用启动后**一次都没被调用**（应用库由 guest 内部 linker 装载） |

**可行路径**：直接调私有 `Runtime.load0(Class, String)`，显式传入应用自己的 Class：

```ts
const app = Java.use("android.app.ActivityThread").currentApplication();
Java.classFinder… // 实际用 Java.classFactory.loader = app.getClassLoader()
Java.use("java.lang.Runtime").getRuntime().load0(app.getClass(), GADGET);
```

于是链路变成：ART `OpenNativeLibrary` → `NativeBridgeLoadLibrary` → Houdini 映射 ARM64 ELF
→ **gadget 构造函数在翻译层里跑起来**（实测 `/proc/self/maps` 出现 gadget，`127.0.0.1:27099` 开始监听）。
官方包签名未变、ACE 无反应。

> 注意：`frida-java-bridge` 在此环境直接 `Java.use("java.lang.System").load()` 仍会 NPE（同一个 VMStack 原因），
> 所以 `Runtime.load0` 是必需的一步，不是可选优化。

---

## 4. 障碍三：arm64 agent 里模块注册表仍然缺 `libil2cpp.so`

拿到 arm64 agent（`Process.arch=arm64`）后，libunity/libmain/libtersafe2 都可见了，
但 **libil2cpp.so 依旧不在 `Process.enumerateModules()` 里**（maps 里有）：

```
[arm64] {'t':'cmp','mods':54,'inMaps':['libil2cpp.so','libunity.so',…],'inMods':['libunity.so','libmain.so','libtersafe2.so']}
```

于是 `frida-il2cpp-bridge` 的 `forModule("libil2cpp.so")` 找不到，退化成
「hook linker 的 dlopen 等模块出现」，而 guest 环境没有 `linker64` 模块 → `unable to find module 'linker'`。

**解法**：`hook/synth-module.ts` 自己从 `/proc/self/maps` + ELF 解析合成一个模块替身，
挂到 `Process.findModuleByName` 上（注意 `Process.getModuleByName` 是**只读属性**，赋值会抛
`TypeError: 'getModuleByName' is read-only`；而 `findModuleByName` 的 descriptor 是 writable）。
bridge 的 `forModule` 先查 `findModuleByName`，命中即返回，不会落到 linker 分支。

实现里踩过的三个坑（都已在代码注释中标注）：

1. **同一文件有两套映射**：一套是「整文件线性只读视图」（单段 `r--p` offset 0），
   另一套才是真正的装载段（起始段 offset 0 + 其后 offset>0 的 `.data/.bss`）。
   判定：候选基址所在区域（4 MB 空洞内）必须含 `offset>0` 的段。选错基址会让符号地址整体偏移。
2. **节表不在内存里**：`e_shoff=210,620,384` 恰好落在最后一个 PT_LOAD 之后，
   装载镜像里根本读不到 → 必须走 **PT_DYNAMIC**（`DT_SYMTAB/DT_STRTAB/DT_HASH/DT_GNU_HASH`）取 `.dynsym`/`.dynstr` 与符号数。
3. **两个 API 陷阱**：Frida 17 的 `NativePointer` **没有 `toNumber()`**（只有 `toInt32/toUInt32/toString`）；
   且 `NativePointer.toString()` 默认**十六进制**，而 `readU64()` 返回的 `UInt64.toString()` 默认**十进制**——
   混用会把 `e_shoff` 解析成天文数字，表现为「导出符号 0 个」。

**交叉验证**：合成模块算出的 `il2cpp_init = base + 0x232B6D0`，
与早先 Frida 注册表可见时的 `0x7ebc971716d0 − 0x7ebc94e46000 = 0x232B6D0` **完全一致**；
`Il2Cpp.perform` 拿到 88 个 assembly（`Assembly-CSharp`、`Torappu.Common`、`UnityEngine.CoreModule`…）。

---

## 5. 障碍四：托管日志不在 `Internal_Log`

客户端把 Unity 的 logHandler 换掉了，`DebugLogHandler.Internal_Log` **永不触发**
（这也解释了为什么 logcat 里几乎没有 `Unity` 标签的 `Debug.Log`）。
改为挂**入口方法**：`UnityEngine.Debug.*`（静态，13 个重载）与 `UnityEngine.Logger.*`（实例，6 个）。

消息参数下标不能简单取 `args[0]`/`args[1]`：`Debug.Log(object)` 是 0，
而 `Logger.Log(LogType, object)` 是 2。规则（已实现）：

> 跳过 `this` 与 `LogType/LogOption` 之类的枚举参数，取第一个**非字符串引用参数**；
> `*Format*` 方法例外，取字符串参数（格式串）。

实测各重载解析结果（脚本会打印，便于核对）：

```
Debug.Log(System.Object)[0]                                  Logger.Log(UnityEngine.LogType,System.Object)[2]
Debug.LogFormat(System.String)[0]                            Logger.LogError(System.String,System.Object)[2]
Debug.LogFormat(UnityEngine.LogType,UnityEngine.LogOption,UnityEngine.Object,System.String)[3]
                                                             Logger.LogException(System.Exception,UnityEngine.Object)[1]
```

---

## 6. 交付物

| 文件 | 作用 |
|---|---|
| `hook/inject-gadget.ts` | 用 `Runtime.load0(appClass, gadget)` 把 ARM64 gadget 装进进程（依赖 `frida-java-bridge`） |
| `hook/frida17-compat.ts` | Frida 17 兼容垫片：补回被移除的静态 `Module.findExportByName` 等；安装合成模块 |
| `hook/synth-module.ts` | 合成模块：`/proc/self/maps` 选装载区 + PT_DYNAMIC 解析 `.dynsym` |
| `hook/il2cpp-unity-logs.ts` | il2cpp 托管日志（Debug/Logger 入口 + DebugLogHandler）+ ARM guest liblog |
| `hook/host-logs.js` | 宿主 x86_64 liblog（Java/HGSDK/EGL/vulkan…），普通 JS，无需打包 |
| `scripts/build-frida-hook.mjs` | esbuild 打包 `hook/*.ts` → `hook/build/*.js`（含 `buffer` 垫片） |
| `scripts/frida-mumu-arm64.py` | 双 agent 管线：冷启动 → 装 gadget → 挂宿主日志 + il2cpp 日志 |
| `hook/build/*.js` | 生成的 bundle（gitignored，运行前先 build） |

命令：

```bash
pnpm run frida:build     # = node scripts/build-frida-hook.mjs
pnpm run frida:mumu -- --duration 60
```

前置条件（一次性）：

1. 设备内跑 x86_64 `frida-server`，Windows 侧 `adb forward tcp:27042 tcp:27042`
   + 中继 `node tmp/port-relay.mjs 27043 27042`（WSL 访问不到 Windows 的 loopback）；
2. gadget 端口同样需要中继：脚本会自动 `adb forward tcp:27099 tcp:27099` 并在需要时起
   `node tmp/port-relay.mjs 27098 27099`；
3. `--install-gadget` 会把 arm64 gadget 与配置推到应用的 native 库目录
   （`dumpsys package <pkg>` 的 `legacyNativeLibraryDir`，实测 `/data/app-lib/Yxmrfz2`）。

---

## 7. 边界与红线

* **不需要改 APK、不需要重签名**——这也是它能跑通的原因：重签包会被 ACE（`libtersafe2.so`）SIGSEGV 掉，
  而本方案运行在官方包上。gadget 只是一个调试器，没有触碰反作弊组件，也没有做库名伪装/证书链绕过。
* gadget 需要 root 才能写入应用的 native 库目录（MuMu 默认给 root）。
* `frida-server`（x86_64）与 `frida-gadget`（arm64）版本需同属 17.x，本仓实测 17.9.9 / 17.9.1。
* 客户端停在 HGSDK 登录界面时 Unity 场景基本空闲，托管日志较少；进入游戏后会明显变多。
* 该管线同时是后续「**运行时改造替代改包**」的基础设施：
  有了 arm64 il2cpp agent，重定向网络、替换公钥、注入 Lua 引导都可以在内存里做，
  不必再产出重签包（从而绕开 ACE 与改包路线）。参见 `docs/crypto-resign-2026-09-13.md`、
  `docs/apk-mod-2771-2026-09-13.md`。
