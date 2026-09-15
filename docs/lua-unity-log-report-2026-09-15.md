# Unity 日志回传（Lua 插件 → 私服）· 2026-09-15

> 客户端基线 2.7.71 / MuMu（ARM64 il2cpp + Houdini）· 相关源码
> `lua/plugin/plugins/UnityLogPlugin.lua`、`lua/plugin/core/PluginOptions.lua`、
> `app/ops/plugin/plugin-log-store.ts`、`app/ops/plugin/plugin-log.routes.ts`、
> `scripts/admin-cli.ts`（`plugin logs …`）

## 0. 一句话

游戏内新增「日志回传」插件（`unity_log`）：把客户端**运行期 Unity/游戏日志**采集进
内存环形缓冲，按级别过滤、批量 base64url 分片回传到私服，落盘
`data/plugin/logs/<sid>.ndjson`，用 `pnpm run admin -- plugin logs …` 离线分析。
私服原本看不到设备侧日志——这是唯一的回流通道。

## 1. 采集锚点：为什么是 `Torappu.FileLogger._OnCatchLog`

选锚点前把线程上的候选全部证伪了一遍（证据都在本机 dump / 反编译源里）：

| 候选 | 为什么不行 |
| --- | --- |
| `CS.UnityEngine.Application.add_logMessageReceived(fn)` | 没有 `UnityEngineApplicationWrap`（客户端只 gen 了 300 个 `XLua.CSObjectWrap.*`），且 `Application.LogCallback` 未登记 `CSharpCallLua` ⇒ Lua 无法注册委托 |
| `xlua.hotfix(CS.UnityEngine.Debug, "Log", …)` | `tmp/dts-dump/UnityEngine.CoreModule.cs` 里 `__Hotfix0_` 计数 **0** ⇒ UnityEngine 程序集没有 hotfix 桥，热修无从挂起 |
| `CS.UnityEngine.DLog` / `Hypergryph.Log.DLogger` | 有 `AddDefaultLogger(ILogger)` 但 `Hypergryph.Log.ILogger` 未登记 `CSharpCallLua` ⇒ Lua 无法实现该接口；`DLog` 自身也无 hotfix 桥（全仓 grep `__Hotfix0` = 0） |
| `CS.Torappu.Lua.Util.Log` | 静态类、非 `IHotfixable`，无桥 |
| 官方 Lua / 现有插件 | 全仓 grep `logMessageReceived` 只命中 `Torappu.FileLogger`（ctor 里 `Application.logMessageReceived += _OnCatchLog`） |

于是唯一可行的锚点是 **`Torappu.FileLogger._OnCatchLog(string, string, LogType)`**：

- 带 `__Hotfix0__OnCatchLog` 桥（私有方法 ⇒ 先 `xlua.private_accessible(CS.Torappu.FileLogger)`，
  与 `EventLogBlockPlugin._InstallSdkHooks`、官方 `AVGDialogAutoClickHotfixer` 同款）；
- 它是 `Application.logMessageReceived` 的唯一托管订阅者 ⇒ 拿到的是**完整 Unity 日志流**
  （Log/Warning/Error/Assert/Exception + `stackTrace`）。

**但 FileLogger 在游戏里没人构造**：唯一构造点 `Torappu.DFLogger.InitIfNot` 在反编译源里
没有任何调用方，而 `GlobalInitializerAndUpdater.OnApplicationQuit` 却会调
`DFLogger.CloseIfNot()`。所以插件自己建 sink：

```lua
local opts = CS.Torappu.FileLogger.Options()   -- 嵌套值类型，走 xLua 反射回退
opts.logLevel = <sink_level>; opts.receiveUnityLog = <sink_file>; opts.autoFlush = true
CS.Torappu.DFLogger.InitIfNot(opts, "{0}/DTS-unity-{1}-{2}.log")   -- 失败则退回直接构造
```

- 走 `DFLogger` 单例的好处：退出时 `CloseIfNot()` 能正常 Dispose（不留悬挂实例）；
- 顺带得到设备侧日志文件 `persistentDataPath/DTS-unity-*.log`，必要时 `adb pull`；
- 未 gen 的类型/嵌套 struct 靠 xLua 的 `Utils.ReflectionWrap` 回退（`ObjectTranslator.TryDelayWrapLoader`：
  `DelayWrapLoader` 缺失即 `ReflectionWrap`，并递归包装 public 嵌套类型）。

> 时序：`OnLoad` 先装补丁再建 sink；补丁是静态桥，先装后装都生效，但先装可避免漏掉
> sink 构造过程中的日志。

## 2. 线协议（复用自动化桥验证过的通道）

```
GET /plugin/log/ingest/<sid>/<batchId>/<seq>/<total>/<base64url chunk>
```

- JSON 信封 → **base64url** → 按 **1800 字符**切片顺序上传；服务端按 `(sid,batchId)` 拼回。
- 为什么不用 POST body：`UISender.me:SendGet` 是唯一在真机反复验证过的通道；
  base64url 字母表（`A-Za-z0-9-_`）全是 RFC3986 非保留字符，无需百分号转义
  （与 `AutomationBridge` 结果回传同口径）。
- 单片失败重发 1 次；整批「要么全部发出、要么整批回滚留在缓冲」（未就绪绝不丢日志）。
- 卡死复位：分片回调丢失时，Pump 在 30s 后作废本轮（`_sendGen` 代际号）并重试。

信封（服务端 `parseEnvelope` 解析）：

```jsonc
{
  "v": 1,
  "sid": "dts_Android_1a2b3c",      // AutomationBridge.SessionId()（跨插件同源，可与自动化会话对齐）
  "seq": 120,                        // 本批第一条记录的全局序号（单调，检测缺口）
  "ts": 1730000000,                  // 客户端秒级时间
  "dropped": 3,                      // 客户端因缓冲溢出/限流累计丢弃条数
  "device": { "platform": "Android", "version": "2.7.71", "model": "…", "os": "…" },
  "records": [ { "t": 123456, "l": "E", "m": "报错正文", "s": "堆栈", "c": 7 } ]
}
```

`t`=客户端单调毫秒（`Time.realtimeSinceStartup`）、`l`=级别码 `D/I/W/E`、
`c`=连续重复次数（客户端把连续相同日志合并成一条，日志风暴不撑爆缓冲）。

## 3. 服务端存储

```
data/plugin/logs/
├── <sid>.ndjson        一行一条记录（追加写；超上限轮转为 <sid>.1.ndjson）
└── <sid>.meta.json     会话索引（列表/统计只读它，离线 CLI 不必读整份日志）
```

- 查询入口：`pluginLogStore`（`app/ops/plugin/plugin-log-store.ts`，与 PluginConfigService 同层）。
- **输入全部收敛**（客户端可伪造请求）：标识只放行 `[A-Za-z0-9_-]{1,64}`（防路径穿越）、
  分片 ≤4096 字符且只允许 base64url 字符集、分片数 ≤2048、单批拼装 ≤2MB、
  单批记录 ≤2000、单条正文/堆栈 ≤8192 字符（超出截断而非拒绝整批）。
- 未凑齐分片：最多 64 条缓存、TTL 60s，超量丢最旧（客户端会重发整批）。
- 单会话落盘上限 16MB，超出轮转一次（`truncated=true`）。
- `E` 级记录同时 `logger.warn("UnityLog", "[sid] …")` 镜像到服务端统一日志
  （`logs server` / SSE 实时盯得到）。

### 3.1 只读查询端点（分析侧）

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /plugin/log/sessions` | 会话列表 + 全局统计 |
| `GET /plugin/log/records/<sid>?last=N&level=D\|I\|W\|E` | 某会话尾部记录（`last` ≤5000） |
| `GET /plugin/log/stats` | 仅统计 |

挂载在**组合根**（`app/server.ts`，与 `/plugin/automation` 并列）而非 `app/game/modules/*`：
这套端点服务调试设施，落 game 会触发架构守卫 R5（game 不得依赖 ops）。
与 `/plugin/*` 既有端点一样**不做鉴权**——单机调试设施；对外暴露请置于反代鉴权之后
（或停用 `unity_log`）。

## 4. 选项（`PluginOptions.Defs` 的 `unity_log` 条目）

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `min_level` | enum | `warning` | 只回传不低于该级别的日志（debug 最全、流量最大） |
| `batch_size` | number | 50 | 单批最多条数 |
| `flush_sec` | number | 5 | 批量回传间隔 |
| `max_buffer` | number | 500 | 内存缓冲上限，溢出丢最旧并计数上报 |
| `max_batch_kb` | number | 64 | 单批字节上限（超出少带几条，避免超长请求） |
| `msg_max_len` | number | 800 | 单条正文截断长度 |
| `include_stack` | switch | true | 是否回传调用堆栈 |
| `sink_file` | switch | true | 是否同时写设备日志文件（只影响文件，不影响回传） |
| `sink_level` | enum | `error` | 设备日志文件的级别（改后自动重建 sink） |

选项改动即时生效：`min_level` 等热路径参数直接换缓存；`sink_file`/`sink_level` 触发
`DFLogger.CloseIfNot()` → 重建（`_RebuildSink`）。

## 5. 用法

```bash
# 1) 游戏内：「插件管理面板」启用「日志回传」（默认级别 warning），或让服务端下发
pnpm run admin -- plugin logs sessions                 # 看有哪些客户端会话
pnpm run admin -- plugin logs sessions --json
pnpm run admin -- plugin logs show dts_Android_1a2b3c --last 50 --level E
pnpm run admin -- plugin logs stats --json
pnpm run admin -- plugin logs export dts_Android_1a2b3c --out /tmp/client.ndjson
pnpm run admin -- plugin logs clear dts_Android_1a2b3c --yes     # 危险操作
```

线上直查（服务在跑时）：

```bash
curl -s 'http://127.0.0.1:8443/plugin/log/sessions' | head -c 800
curl -s 'http://127.0.0.1:8443/plugin/log/records/<sid>?last=20&level=E'
```

其它插件想借这条通道上报自己的诊断：

```lua
require("Plugin/plugins/UnityLogPlugin").Report("warning", "[MyPlugin] …")
```

## 6. 真机验收清单

1. 客户端启动后私服日志出现：
   `PluginHeartbeat` 的插件列表里多了 `unity_log=ON`；
   随后出现 `UnityLog 日志批到达: sid=… 记录=N …`。
2. 设备侧日志文件存在（可选）：
   `adb shell ls /sdcard/Android/data/com.hypergryph.arknights/files/DTS-unity-*.log`。
3. 本地落盘：`ls -l data/plugin/logs/`（`<sid>.ndjson` + `<sid>.meta.json`）。
4. `pnpm run admin -- plugin logs sessions` 能看到该会话；`show <sid>` 能打印记录。
5. 触发一条错误（例如故意让某 hotfix 目标不存在）后，`plugin logs show <sid> --level E`
   能看到对应正文与堆栈；`dropped` 不异常增长。
6. 若第 1 步没有任何 `UnityLog` 日志：先看 `plugin logs show <sid>` 里的诊断记录
   （`[unity_log] 日志 sink 创建失败…`）——说明反射构造 `FileLogger.Options` 失败，
   此时 Lua 采集不可用，需换锚点（见 §7）。

## 7. 已知边界

- **只覆盖托管日志**：`Application.logMessageReceived` 不含 native（`__android_log_print`）
  与 Java 侧日志。要看 native 日志仍走 frida `liblog` 管线
  （`docs/frida-mumu-il2cpp-2026-09-13.md`），两者互补。
- **依赖 xLua 反射回退**构造 `/` 赋值 `FileLogger.Options`（嵌套值类型）。若某版本
  `ReflectionWrap` 不再支持值类型的字段写，sink 建立会失败并写一条诊断记录；
  采集本身（Lua 侧）仍随 sink 存在与否决定成败。
- **速率保护**：每会话每秒最多 300 条，超出计数丢弃（`dropped`），保护帧率；
  这不是可选项，日志风暴下宁可丢也不卡帧。
- **不做鉴权**：与 `/plugin/*` 既有端点一致；公网暴露前必须加反代鉴权或停用插件。
- 关闭「日志回传」后设备侧日志文件与已落盘历史**不删除**（`plugin logs clear` 才清）。
