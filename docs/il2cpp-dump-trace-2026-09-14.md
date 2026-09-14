# il2cpp 元数据 dump 与运行期 trace（MuMu / ARM64 gadget）

2026-09-14。目标：在**不改 APK** 的前提下，把官方客户端的 il2cpp 元数据完整落盘，并对 Lua 加载链做运行期
trace，为「Lua 插件注入」提供准确的类名、方法签名与 RVA。

工具：`hook/il2cpp-dump-trace.ts`（新增入口）+ `scripts/frida-mumu-arm64.py --script-mode <dump|trace|both>`（新增开关）。

## 1. 怎么跑

```bash
# 元数据 dump（88 个 assembly → 设备上按 assembly 分文件）
python3 scripts/frida-mumu-arm64.py \
  --script hook/build/il2cpp-dump-trace.js --script-mode dump \
  --java-script "" --duration 300

# 拉回（产物在应用私有目录，flatten 一下）
adb pull /data/user/0/com.hypergryph.arknights/files/dts-dump/ tmp/dts-dump/

# 调用链 trace（启动 + Lua 加载）
python3 scripts/frida-mumu-arm64.py \
  --script hook/build/il2cpp-dump-trace.js --script-mode trace \
  --java-script "" --duration 150 --max-output-bytes 2000000 > tmp/trace-run.log 2>&1
```

前置条件（与其它 frida 调试一致）：设备侧 `frida-server` 在跑、四条 Windows 侧中继
（27043→27042 frida-server、27098→27099 gadget、8443/8543→WSL 私服）与 `adb forward tcp:27042/27099` 就绪、
`--install-gadget` 已完成（ARM64 gadget 在应用 native 库目录里）。

## 2. 为什么 dump 与 trace 分开（`--script-mode`）

Frida 的 Interceptor 回调在**被 hook 的那个线程**上执行，进 JS 前要抢 JS 运行时锁；dump 是纯 JS 循环
（逐类取元数据，几十秒量级），若与 trace 同时进行，被 trace 的游戏线程会一直等锁 → 游戏卡住甚至 ANR。
故默认两者互斥，`both` 模式也是「先挂 trace，60s 后再 dump」。

## 3. 实现要点（踩坑都在这里）

1. **不能用桥自带的 `Il2Cpp.dump()`**：它写 `Il2Cpp.application.dataPath`，而该方法在 Android 上返回
   `/storage/emulated/0/Android/data/<pkg>/files`（本客户端实测）——是**可写的外部私有目录**，但桥的默认
   文件名/路径策略与「按 assembly 分文件、可中途拉回」的诉求不符，且桥内部用 Frida 的 `File` API。
   这里改为：`libc` 的 `fopen/fputs/fflush/fclose/mkdir` + `Module.findGlobalExportByName()`（Houdini 下
   guest libc 不在 x86_64 模块注册表里，必须走全局查找），逐类流式写盘、每 200 类 `fflush` 一次。
2. **写入位置**：应用私有目录 `/data/user/0/<pkg>/files/dts-dump`（应用可写、adb(root) 可拉）优先；
   不可写时退回 `persistentDataPath`。`/data/local/tmp` 是 `0771 root:shell`，应用 uid 写不进去。
3. **`Il2Cpp.application.identifier` 在本客户端返回 null**（Unity 2021.3.39f1 / il2cpp），包名要从
   `persistentDataPath` 里正则抠（`/Android/data/<pkg>`）。
4. **写入缓冲**：单个 assembly 的文本可能远超任何固定缓冲（Assembly-CSharp 一个 assembly 就 42 MB），
   所以必须**逐类流式写**，不能先 `join` 再写。单类文本超 4 MB 会截断（实际未触发）。
5. **单个类取不出来不致命**：`${klass}` 对少量元数据异常的类会抛
   `Error: access violation accessing 0x1`，逐类 `try/catch` 跳过，只把最后一个错误记进 `_index.tsv`
   的 `PARTIAL` 标记。

## 4. dump 结果

- **88 个 assembly、49,370 个类、53,193,706 字节**（设备侧 52 MB），62 秒完成，0 缓冲截断。
- 产物：`tmp/dts-dump/<assembly>.cs` + `_index.tsv`（assembly / classes / bytes / 错误标记）。
- 最大者：`Assembly-CSharp.cs` 37,814 类 / 41.9 MB（尾部为 `__XLUA_GEN`，结构完整）。
- Lua 链相关类都在 `Assembly-CSharp.cs`：`Torappu.Lua.LuaManager`、`Torappu.Lua.LuaEntry`、
  `Torappu.Lua.Util`、`Torappu.Lua.PageEntry/StateEntry`、`XLua.LuaEnv`、`XLua.LuaTable`；
  `Torappu.VersionCompat` 在 `Torappu.Common.cs`。

关键签名与 RVA（`Torappu.Lua.LuaManager`）：

| 成员 | 签名 | RVA |
| --- | --- | --- |
| `m_env` | `XLua.LuaEnv`（字段，偏移 `0x18`） | — |
| `InitIfNot` | `static System.Void InitIfNot()` | `0x049b6c60` |
| `ReloadScripts` | `static System.Void ReloadScripts()` | `0x049b6e04` |
| `_DoLoadEntryScript` | `System.Void _DoLoadEntryScript(Torappu.Lua.LuaOptions)` | `0x049b7808` |
| `_DoLoad` | `System.Void _DoLoad(System.String)` | `0x049b7be0` |
| `_CustomLoader` | `System.Byte[] _CustomLoader(System.String&)` | `0x049b7ef8` |
| `_ConvertToFullPath` | `System.String _ConvertToFullPath(System.String)` | `0x049b8600` |
| `CreateLuaEnv` | `static XLua.LuaEnv CreateLuaEnv()` | `0x049b86ec` |
| `_InjectDefinesToLuaEnv` | `static System.Void _InjectDefinesToLuaEnv(XLua.LuaEnv)` | `0x049b890c` |

其它：

| 成员 | RVA |
| --- | --- |
| `Torappu.GlobalInitializerAndUpdater::Awake` | `0x0393dd58` |
| `Torappu.GlobalInitializerAndUpdater::_LoadInitialAssetsImpl(bool)` | `0x0393f390` |
| `XLua.LuaEnv::DoString(System.String, System.String, XLua.LuaTable)` | `0x0595b788` |
| `XLua.LuaEnv::DoString(System.Byte[], System.String, XLua.LuaTable)` | `0x0595b944` |
| `Torappu.VersionCompat::get_CUR_FUNC_VER()` | `0x0902a344` |
| `Torappu.VersionCompat::SetFuncVersion(System.String)` | `0x0902a400` |
| `Torappu.DB.CrypticConverter::DeserializeBytes(System.IO.Stream)` | `0x057898dc` |

> 注意 `XLua.LuaEnv::DoString` 只有 **3 参数**重载（chunk, chunkName, env）——注入时必须按该签名调用，
> 第三个参数传 `NULL`（传 JS 的 `null` 会报 `incorrect parameter types`）。

## 5. trace 结果（10 个类，35 个唯一方法）

跟踪类：`GlobalInitializerAndUpdater`、`LuaManager`、`LuaEntry`、`Lua.Util`、`PageEntry`、`StateEntry`、
`VersionCompat`、`DB.CrypticConverter`、`XLua.LuaEnv`、`XLua.LuaTable`（`filterMethods` 排除
`Update/LateUpdate/FixedUpdate`）。桥的 tracer 默认按消息哈希去重，所以输出是**唯一调用树**而非逐次日志。

运行期实测到的引导链（`tmp/trace-clean.log`，已剥 ANSI）：

```
Torappu.GlobalInitializerAndUpdater::Awake
 ├ _DoInitInAwake / _SetInstanceToBaseAssemblies / _RegisterGlobalListeners / _SetGraphicTierByPlatform
 ├ _LoadInitialAssetsImpl
 │  └ Torappu.Lua.LuaManager::InitIfNot                ← static
 │     ├ .ctor → _DoCreateLuaEnv → CreateLuaEnv → _InjectDefinesToLuaEnv
 │     └ _DoInitIfNot
 │        └ _DoLoadEntryScript(LuaOptions)
 │           └ _DoLoad(string)
 │              └ _CustomLoader(string&) ×344          ← Lua 模块解密加载
 │                 └ _ConvertToFullPath
 ├ WaitForInitCoroutine → IsInited
 └ InvokeWhenInitReadyBeforeWaitingCoroutines
```

- **`_CustomLoader` 唯一加载 344 次**（与「Lua bundle 内 344 个 TextAsset」完全吻合）⇒ 客户端确实把内置
  Lua 全量加载并执行了。
- `XLua.LuaEnv::DoString` 在链中被调用（`DoString(String,…)` → 内部转 `DoString(Byte[],…)`）。
- Lua 侧回调进 C# 的证据：`Torappu.Lua.Util::Log`、`Torappu.Lua.Util::BindPlayerDataListener`
  以**顶层**帧出现（说明是 Lua 调用的，不是 C# 内部调用）。
- 运行期循环：`LuaManager::_DoUpdate` + `XLua.LuaEnv::Tick`/`GC`/`ObjectValidCheck`（Lua VM 正常驱动）。
- `Torappu.VersionCompat::get_CUR_FUNC_VER` 在引导早期被读（即 `entry.lua` 的 funcVer 门禁），
  本次客户端状态匹配，未提前 `return`。
- 输出 155 KB / 无截断（`--max-output-bytes 2000000`）。

## 6. 对「Lua 插件注入」的直接结论

1. 注入点用 `XLua.LuaEnv::DoString(System.String, System.String, XLua.LuaTable)`（RVA `0x0595b788`），
   第三参传 `NULL`；`LuaManager` 实例的 `m_env` 字段在 `+0x18`。
2. 触发时机：`_CustomLoader` 首次被调用时 Lua VM 已建好且在游戏线程上（trace 证实 `_DoCreateLuaEnv`
   早于 `_DoLoadEntryScript`），可以在此刻注入。
3. `Torappu.Lua.Util::Log`（`0x04b93e54`）可作为「注入后的可观测点」——注入脚本调用它会在托管日志里出现。
