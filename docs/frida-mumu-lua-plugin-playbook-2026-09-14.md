# 明日方舟 · MuMu + Frida + Lua 插件：本会话经验总纲（2026-09-14）

把本次长会话（从「改包名自用调试」到「Lua 插件浮窗可用」）的经验压缩成一份**可复用手册**：
先讲清环境与链路，再给「契约清单 / 诊断套路 / 操作纪律」，最后索引细节文档。
细节都各有专文，这里只留**决策与判据**。

---

## 0. 一句话结论（现状）

官方客户端（2.7.71）**不改 APK**，用 frida 只做两件事——**换验签公钥**（仅 Lua 加载上下文）与**观测**；
Lua 内容由私服下发**我们重签名**的 bundle，插件源码由 `GET /plugin/lua` 下发，资产内只留 ~1.3KB 引导。
插件 6/6 ON、浮窗可见可拖可点、`CRASH: 0`。**所有能力都不碰 ACE。**

---

## 1. 环境与拓扑（一次搭好，长期复用）

| 组件 | 关键事实 |
| --- | --- |
| MuMu 12「明日方舟专版」 | Android 12/API32、**SELinux Permissive**、**root**；包名 `com.hypergryph.arknights`（注意同机还有 `com.hypergryph.arkmumu12`，别搞混） |
| 架构分裂 | 进程是 **x86_64 ART**，游戏逻辑（libil2cpp/libunity）是 **ARM64**、由 Houdini(`libnb.so`/`libnb`) 翻译 ⇒ x86_64 agent **看不到** ARM64 模块 |
| 因此必须 ARM64 gadget | `Java.perform` → `Runtime.load0(appClass, gadgetPath)` → NativeBridge/Houdini 映射 ARM64 gadget；gadget 监听 `127.0.0.1:27099` |
| WSL↔Windows 中继 | Windows loopback 从 WSL 不可达 ⇒ `tmp/port-relay.mjs <listen> <target> [host]`：`27043→27042`(frida-server)、`27098→27099`(gadget)、`8443/8543→WSL_IP`(私服) |
| 设备侧 | `adb forward tcp:27042/27099`；`adb reverse tcp:80→8443,8443,8543`；`/etc/hosts` 写 9 条 `*x` 域名 → `127.0.0.1`（配合 APK 的等长域名改写；用 frida 时可省） |
| 中继保活 | WSL 工具调用之间**后台作业会被清掉** ⇒ 中继要用一个常驻作业托住（`& ... wait`），每次开工先自检 `27043/27098/8443` 是否可达 |

**自检命令**（开工第一件事）：
```bash
for p in 27043 27098 8443; do timeout 3 bash -c "</dev/tcp/172.30.32.1/$p" 2>/dev/null && echo "$p up" || echo "$p DOWN"; done
timeout 3 curl -s -o /dev/null -w "server=%{http_code}\n" http://127.0.0.1:8443/gm/
```

---

## 2. 三条交付链路（按可用性排序）

1. **Lua VM 注入**（最稳，调试首选）：`hook/il2cpp-client-redirect.ts` 在 `_DoLoadEntryScript` 之后、`_DoUpdate` 的
   onEnter 里 `LuaEnv.DoString(payload)`；payload 自带插件源码 + searcher。**不要在 `_CustomLoader` 里注入**（Lua 栈是活的）。
2. **资产内引导 + 私服 HTTP**（半免 frida）：`inject-lua-inplace.ts --bootstrap fetch` 把几百字节引导写进
   `AVGStickerAutoClickHotfixer`（官方 DefinedFix 列表内、明文预算 3544B），运行时 `UISender.me:SendGet("/plugin/lua")`
   取回 83KB 自包含 chunk（`app/ops/plugin/lua-chunk-builder.ts`）再 `load()`。frida 只剩换公钥。
   帧轮询必须挂 **`GlobalInitializerAndUpdater.Update`**（`LuaManager._DoUpdate` 在部分状态下不是每帧调用）。
3. **改 APK / 改 dex**：**死路**——APK 里没有 Lua bundle（按 `.idx` 从 CDN 下，而 CDN 就是我们私服），
   且**任何重签名 APK 都会被 ACE 在约 10s 内 SIGSEGV 击杀**（崩溃栈整条在 `libtersafe2.so`，与包名无关）。

---

## 3. 契约清单（本会话踩过的坑全在这）

> 通式：**游戏侧凡是 `x:Call(...)` 的地方，传进去的必须是「带 `Call` 方法的对象」（`Event.Create/CreateStatic`），裸函数会抛 LuaException 并从游戏回调/定时器里逸出 → 整个客户端 abort。**

| 位置 | 契约 | 传错的后果 |
| --- | --- | --- |
| `UISender:ExportOnProceed`（`Base/Network/UISender.lua:131`） | `onProceed` 必须是 Event 对象 | `attempt to index a function value (field 'onProceed')` → abort |
| `Timer:Update`（`Base/Timer/Timer.lua:52`） | `TimerModel:Delay(delay, cb)` 的 cb 必须是 Event 对象 | `attempt to index a function value (field 'm_call')` → abort（**本会话最久的 bug**） |
| UGUI 交互 | 自建 Overlay 画布上**不要用 UGUI Button**（命中不稳、点击穿透） | 「点不到，只能点到后面的」 |
| 画布可见性 | 不要复用游戏画布（`ScreenSpaceCamera` 常无相机/被遮挡） | 对象 `activeInHierarchy=true` 但**屏幕上看不出** |
| 行/面板重建 | Unity `Object.Destroy` **帧末**才生效 | 同帧读到旧行、`childCount` 翻倍（**误判成 bug**） |
| 一次性初始化 | 插件系统/hotfix 可能被重载；LuaEnv 释放时若有 C# 回调会抛 `try to dispose a LuaEnv with C# callback!` | abort（已加 `PluginEntry` 重载守卫：重载前先 `dispose()`） |

---

## 4. 诊断套路（排「Lua 错误把客户端打崩」的固定动作）

只看 `terminating with uncaught exception of type Il2CppExceptionWrapper` 是**查不出**死因的。固定挂这几个钩子
（`hook/il2cpp-client-redirect.ts` 已内置）：

| 钩子 | 作用 |
| --- | --- |
| `XLua.LuaException..ctor(string)` | **直接拿到 Lua 错误文本 + traceback**（最有用） |
| `XLua.LuaEnv.ThrowExceptionFromError(int)` | 抓「Lua 错误转托管异常」的时刻 + C# 调用栈 |
| `XLua.LuaEnv.Dispose` / `LuaManager._DoDisposeLuaEnv` | 抓释放路径（注意：官方 Lua 会 hotfix `LuaManager`，原方法体上的钩子可能**不触发**） |
| `UnityEngine.Debug.LogException` | 抓异常日志（未走此路说明是 il2cpp 直接 abort） |

**无眼验证 UI**（不需要看截图）：探针查 `_root/_floatBtn.activeInHierarchy`、`rows` 数、
`RectTransformUtility.WorldToScreenPoint` 屏幕坐标、`Canvas.renderMode/sortingOrder`；
再用 `adb shell input tap/swipe` 打真实事件，最后用**原始帧像素**核对
（`screencap` 不带 `-p`，头 16B + RGBA，扫 `#4D99FF` 开关色：面板开 ≈1e4 px / 关 ≈5e2 px）。
探针自检要留 `ui-probe-scheduled` / `ui-probe-enter` 两级日志，确认「排上了、也进来了」。

---

## 5. 操作纪律（长会话不崩、不误伤）

1. **输出有界**：`--max-output-bytes`（默认 2MB）、单行 ≤2000 字符、单条日志 ≤400 字符；日志一律重定向到文件，用 `tail -c`/`grep -c` 读。TUI 会被 10MB 级输出推爆（V8 `ud2`）。
2. **别碰 ACE**：不 hook/不禁用/不欺骗反外挂；不重签名 APK 上线（会杀）。换公钥是**用自己的密钥对做真实验签**，不是绕过。
3. **客户端状态**：卸载重装会**换 uid**（`u0_a36`→`u0_a39`），恢复缓存前先 `dumpsys package … | grep userId`，再 `chown -R u0_a<N>:ext_data_rw`；否则报「存储空间不足」这类假错。
   清缓存前先 `pm clear` 或备份 `Android/data/<pkg>/files`（`tmp/client-data-backup/`）。
4. **同时只留必要进程**：私服 1 个 + 中继 1 组；vitest/frida 错开跑。
5. **撤销可见**：每次改动都留"怎么撤"（`.disabled` 产物、`.bak`、`git checkout --`）。

---

## 6. 关键 RVA / 名字速查（2.7.71，完整表见 `docs/il2cpp-dump-trace-2026-09-14.md`）

| 名字 | 地址/说明 |
| --- | --- |
| `LuaManager._CustomLoader(System.String&)` | `0x049B7EF8`（返回解密后明文 `byte[]`，长度 `+0x18`、数据 `+0x20`） |
| `LuaManager._DoLoadEntryScript` / `_DoLoad` | `0x049B7808` / `0x049B7BE0` |
| `XLua.LuaEnv.DoString(String,String,LuaTable)` | `0x0595B788`（**只有 3 参数重载**，env 传 `NULL`） |
| `CryptUtils.VerifySignMD5RSA(byte[],byte[],string)` | `0x042FD3F0`（Lua 资产验签）；String 版 `0x042FD310` |
| `GlobalInitializerAndUpdater.Update` | 每帧可靠入口（帧轮询挂这里） |
| Lua 资产格式 | `[128B RSA-1024/MD5 签名(覆盖 script[128:])][16B IV^mask][AES-128-CBC]`；mask=`UITpAi82pHAWwnzqHRMCwPonJLIB3WCl` |

---

## 7. 细节文档索引（按主题）

| 主题 | 文档 |
| --- | --- |
| Frida 接进 ARM64 il2cpp（管线/合成模块/踩坑） | `docs/frida-mumu-il2cpp-2026-09-13.md` |
| il2cpp dump + 运行期 trace（RVA 表） | `docs/il2cpp-dump-trace-2026-09-14.md` |
| Lua 加载链路还原（C#→Lua、资产寻址、CRYPTIC_A） | `docs/lua-load-chain-reconstructed-2026-09-14.md` |
| 私服 mod 下发（身份字段、`get_latest_game_info`、中继） | `docs/lua-mod-delivery-2026-09-14.md` |
| **Lua 资产签名**（128B 头=签名、公钥大端、重签名工具） | `docs/lua-asset-signature-2026-09-14.md` |
| **插件浮窗**（构建/可见/可点/可拖 + 契约型 bug） | `docs/plugin-ui-verify-2026-09-14.md` |
| 插件系统在官方包上跑起来（frida 注入 Lua VM） | `docs/lua-plugin-frida-injection-2026-09-14.md` |
| TUI 崩溃排查与输出闸门 | `docs/dsh-tui-crash-2026-09-14.md` |

## 8. 技能（可被后续会话按名加载）

- `arknights-mumu-frida-debug` —— 环境/管线/探针/诊断钩子/操作纪律（本文件 §1、§4、§5）
- `arknights-lua-plugin-contracts` —— 游戏 Lua 侧的契约与 UI 自绘点击（§3）
- `arknights-lua-asset-signing` —— Lua 资产签名与重签名交付流程（§2.2、§6）

技能源文件：仓库 `skills/<name>/SKILL.md`（项目根），并同步到 `~/.dsh/skills/<name>/SKILL.md`（用户级）。
