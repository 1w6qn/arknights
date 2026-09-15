# MCP 自动化桥真机打通 + 正常登录流程实测（2026-09-15）

> 客户端基线 2.7.71（MuMu / ARM64 + Houdini，asis 验签模式）· 私服 8443 · MCP server `scripts/mcp-automation-server.ts`
> 相关源码：`lua/plugin/core/AutomationBridge.lua`、`lua/plugin/plugins/AutomationPlugin.lua`、
> `scripts/inject-lua-inplace.ts`（资产内 Lua 引导脚本）、`docs/mcp-automation-2026-09-15.md`（设施总览）

## 0. 一句话

**自动化桥此前在真机上从未真正工作过**（`docs/mcp-automation-2026-09-15.md` §5.2 是待办清单，
§5.1 的"实测证据"全部来自协议陪练 `automation:sim`）。本次定位并修掉两个互相独立、都会让桥静默的缺陷，
真机验收通过（持续轮询 + 全部工具可用），随后用 MCP 工具实跑了一遍登录流程，
推进到登录界面并拿到结构化断言；**卡点在 SDK 登录步骤**（极验一键登录 / 无 telephony / 若干插件挂点漂移），见 §5。

---

## 1. 症状

| 观察面 | 现象 |
| --- | --- |
| 私服访问日志 | 每次客户端启动只出现**一条** `GET /plugin/automation/poll/<sid>/1`，之后永远静默（`hub.sessions[].pollCount === 1`） |
| MCP 工具 | `game_ping` 第一次能通，之后**任何**命令（含再次 ping）一律 `命令超时（20000ms）` |
| 客户端 | 进程存活、画面在动、插件全部加载（`plugin_boot_trace.txt` 8 个插件 ON） |

两条症状各自独立：一条是**轮询不再被驱动**，一条是**结果不再回传**。

---

## 2. 根因 A：引导脚本把客户端全局每帧循环吞掉了

### 机理

`scripts/inject-lua-inplace.ts` 注入的引导 chunk（`dts_http`，挂在 `Hotfixes/AVGStickerAutoClickHotfixer`
的 `apply` 里执行）为了在 UISender 就绪前重试 `/plugin/lua`，hotfix 了**每帧入口**：

```lua
local G = CS.Torappu.GlobalInitializerAndUpdater
local orig = G.Update            -- ← 恒为 nil
xlua.hotfix(G, "Update", function(...)
  if orig ~= nil then orig(...) end
  ...
end)
```

`GlobalInitializerAndUpdater.Update` 是 **private 实例方法**，xLua 对未生成（ReflectionWrap）的类型
不暴露实例方法 ⇒ `G.Update == nil`（实测：`hookCandidate("GlobalInitUpdate", …)` 直接报
`方法不可读（可能未注册/未生成）`，`private_accessible` 也救不回来）。
于是包装里那句 `orig(...)` 从不执行 ⇒ **原实现被整体旁路**：

```
GlobalInitializerAndUpdater.Update
  ├─ LuaManager.Update(dt)  → LuaEntry.Update → EntryTable.Update → TimerModel:Update   ← 被吞
  └─ TimeManager.Tick(dt)                                                                ← 被吞
```

后果：`LuaEntry.driveUpdate` 虽然是 true、`TimerModel._newborn` 里也堆着定时器，但 `_timers` 永远是 0
——**没有任何 Lua 定时器会 tick**。桥的第一次轮询是在 `Start()` 里直接发出的，之后靠
`_Schedule → timer:Delay` 续命，于是"排期成功、回调永不触发"，服务端只看到一条 `/poll`。

### 证据（设备侧 `plugin_automation_trace.txt`，修复前）

```
[9942ms] 启动时 driveUpdate=true disableLuaTick=… switcher=true timers=0 newborn=2
[9942ms] 轮询发出 #1 first=1 sid=dts_Android11_a8aac0
[10236ms] 响应后 driveUpdate=true … switcher=true timers=0 newborn=3
[10238ms] 排期: TimerModel 就绪 span=1000ms
（到此为止，之后再无任何一行 —— 定时器既不提升也不回调）
```

`newborn` 从 2 涨到 3、`timers` 始终 0，就是"`TimerModel:Update` 从未被调用"的判据。

### 修复

1. **源头（已改，需重建 Lua 资产才生效）**：`scripts/inject-lua-inplace.ts` 的引导脚本改挂
   `CS.Torappu.Lua.LuaManager.Update`——public static、**可读**，因此 `orig(...)` 能链式调用原实现；
   它本身就在 `GlobalInitializerAndUpdater.Update` 里每帧被调用，重试能力不变，但不再旁路任何东西。
2. **客户端兜底（经 `/plugin/lua` 即时下发，本轮真机走的就是这条）**：`AutomationBridge` 增加
   *修复型帧驱动*——观察到「定时器堆在 `_newborn` 且 120ms 后仍不提升」即判定每帧入口被吞，
   自己在同一个方法上装包装，把 `LuaManager.Update`（Lua tick + `LuaEnv.Tick()`）显式调回来，
   再挂桥的帧泵。修复实测：

```
[10300ms] 判定每帧入口已被吞掉（newborn 不提升）→ 装修复型帧驱动
[10301ms] 修复型帧驱动安装成功（已把被吞掉的 Lua tick 补回）
[10343ms] 驱动触发: TimerModelUpdate（Lua tick 在走）        ← 42ms 后 Lua tick 复活
[15341ms] 帧驱动存活 n=600 busy=false due=15561 last=14525 now=15341
```

---

## 3. 根因 B：`_ExecCommand` 的 `finished` 漏写 `local`

```lua
local function _ExecCommand(gen, cmd, onDone)
  ...
  local function finish(ok, result, err)
    if finished then return end   -- ← finished 未声明
    finished = true               -- ← 写进了 _G，全进程共享
```

`finished` 是**全局变量**：第一条命令收尾后它永久为 true ⇒ 之后每条命令的 `finish()` 在第一行短路
⇒ 结果永不进入 `_SendResult` ⇒ MCP 侧一律超时；同时批次永不结束，后续命令在客户端侧积压。
服务端表现：`/plugin/automation/result/...` 只出现过一次（那条 `client.ping`），hub 里 `inflight` 长期为 1。

**修复**：`local finished = false`（已加注释说明为什么漏了会变成"只有第一条命令能回结果"）。

---

## 4. 桥的其他加固（`lua/plugin/core/AutomationBridge.lua`）

| 改动 | 作用 |
| --- | --- |
| 帧泵 `_FramePump`（挂在可读的每帧入口上，~10Hz） | 排期兜底：`_nextDueAt` 已过 + 宽限还没轮到就直接补跑一次轮询 |
| 在途看门狗（`_busySince` + `cmd_timeout_ms` 上限） | 响应回调丢失不再等于桥永久静默 |
| 多候选驱动 `_InstallFramePump` | `GlobalInitUpdate` / `LuaManagerUpdate` / `TimeManagerTick` / `TimerModel.Update`（Lua 级）逐一带 `private_accessible` 尝试，各自报告"已挂/跳过(原因)" |
| `_TraceLife` 生命周期落盘 | ⚠️ `FileUtil.WriteToFile` 第 3 参是 `useRetry` **不是 append**（每次覆盖写），所以必须内存累积全文再整体写；这点先前坑过一次（文件里只剩最后一行） |
| `_Log` 同步落诊断文件 | `client.logs` 命令本身在链路故障时也调不通，客户端错误文本必须有第二条通道 |
| 结果上传埋点 | `结果准备 / 结果上传 cmd=… json=…B chunks=…`，直接区分"没执行"与"执行了但传不回来" |

---

## 5. MCP 登录流程实测

转录见 `tmp/mcp-login/transcript-login-scene.txt`、设备侧轨迹 `tmp/mcp-login/trace-final.txt`。

### 5.1 已跑通（每步都是 MCP 工具调用）

| 步骤 | 工具 | 结果 |
| --- | --- | --- |
| 会话选择 | `automation_sessions` | `dts_Android11_a8afdc` |
| 连通性 | `game_ping` | `{pong:true, sid:…}` |
| 桥能力 | `game_hello` | `handlers` 26 条、`options.pollIntervalMs=1000` |
| 当前场景 | `game_state` | `scene=hot_update, pages={}, player.available=true` |
| 热更界面断言 | `ui_check` | `panel_finish / btn_netcheck / panel_progress_bar` → **pass 3/3** |
| 点"开始" | `ui_click {name:"start"}` | `clicked=true, method=Button.onClick@UIRoot/panel_root/panel_finish` |
| 等动画 | `game_wait {ms:3000}` | 客户端侧等待 |
| 断言流程推进 | `game_state` | **`scene=login`**（hot_update → login） |
| 登录界面断言 | `ui_check` | `login_dialog(Clone)` 存在且激活、`btn_register` 激活、`btn_open_preannounce/text == "查看公告"` → **pass 3/3** |
| 界面探索 | `client_eval`（开 `allow_eval` 后） | 列出 `panel_init&sdk1_state=ON`、9 个 Button、无 InputField |

### 5.2 卡点：SDK 登录步骤

- 登录场景状态机停在 `UIRoot/login_state_engine/panel_animation_hub/panel_init&sdk1_state=ON`；
  `btn_login` / `panel_user` / `panel_naming_state` 全部 `[off]`，界面里**没有任何 InputField**。
- Unity 侧只有游戏自己的账号弹窗：`login_dialog(Clone)`（`btn_register` 激活、`btn_open_preannounce` 文案"查看公告"）。
  `ui_click {name:"btn_register"}` 返回 `clicked=true`，但**界面无变化**。
- 客户端原生视图层级（`uiautomator dump`）里没有 WebView，也没有独立 SDK 窗口——登录 UI 不在
  Android View 层，也不在当前 Unity UI 里。
- logcat 显示 SDK（u8 sdk 1.7.0 / HypergryphSDK）走的是**极验一键登录**：
  `Geetest_OneLogin: REQUEST URL: https://onepass.geetest.com/get_config`、`/clientreport_onelogin`，
  且 `TelephonyManager: telephony service is null`（模拟器无 SIM/telephony）⇒ 一键登录在此环境不可用。
- 同时 DontDestroyOnLoad 里挂着多个 `panel_ok_dialog(Clone)`，文案 **"网络请求失败，错误号404"**；
  但私服访问日志里**没有任何来自客户端的 404**（只有我自己的 `curl` 与 favicon），
  说明这条失败请求没有打到私服（或在私有网络栈之外）。
- 另有一批插件挂点在该客户端版本上不存在（logcat `E Unity`）：
  `network_redirect Hotfix(get_overrideRouterUrl) 失败: 目标方法不存在（版本漂移?）`、
  `EventLogBlockPlugin._InstallSdkHooks/_InstallHttpHooks` 多处、`UnityLogPlugin Hotfix(_OnCatchLog/Awake)`。
  这些不影响桥，但会影响"服务器切换/上报截断/Unity 日志回传"三件事的验收。

### 5.3 顺带发现的设施问题

- **运行中的私服是旧构建**：`/plugin/log/*` 查询端点 404（`Cannot GET /plugin/log/sessions`），
  客户端 `/plugin/log/ingest/...` 也全 404 ⇒ Unity 日志回传实际没落盘（`data/plugin/logs/` 不存在）。
  重启私服（`node scripts/watchdog.mjs`）即可带上新路由。
- `ui_check` 的 `expect_text` 只看**被查询对象自身**的 Text 组件：按 `name:"btn_open_preannounce"`
  查按钮时 text 为空（文案在子节点 `text` 上），需要按**子节点路径**断言。已按此写法取证。
- `ui_click {name:"btn_confirm"}` 会命中**未激活**的同名对象
  （`panel_naming_state/btn_confirm`）并回报 `clicked=true`；定位同名对象时建议用完整 `path`。

---

## 6. 复跑命令

```bash
# 1) 私服（若已在跑可复用；旧构建建议重启以带上 /plugin/log/* 查询端点）
node scripts/watchdog.mjs

# 2) 模拟器 + 中继 + adb + hook + 注入（asis 验签模式实测可用）
PYTHONPATH=$PWD/tmp/frida-pkg MUMU_PUBKEY_MODE=asis \
  bash scripts/mumu-start.sh --duration 3600 --pubkey-mode asis

# 3) MCP 自检与登录流程（助手脚本见 tmp/mcp-login/mcp.sh）
tmp/mcp-login/mcp.sh sid
tmp/mcp-login/mcp.sh call game_ping
tmp/mcp-login/mcp.sh call game_hello
tmp/mcp-login/mcp.sh state
tmp/mcp-login/mcp.sh call ui_check '{"items":[{"name":"panel_finish","expect_exists":true,"expect_active":true}]}'
tmp/mcp-login/mcp.sh call ui_click '{"name":"start"}'
tmp/mcp-login/mcp.sh call game_wait '{"ms":3000}'
tmp/mcp-login/mcp.sh state                       # 期望 scene=login

# 4) 客户端侧诊断文件（桥的生命周期/驱动/结果上传轨迹）
adb shell cat /storage/emulated/0/Android/data/com.hypergryph.arknights/files/plugin_automation_trace.txt

# 5) 回归
node tmp/check-lua-syntax.mjs
TMPDIR=$PWD/tmp/vitest-tmp node_modules/.bin/vitest run \
  tests/unit/scripts/mcp-automation-tools.test.ts \
  tests/unit/ops/automation-hub.test.ts \
  tests/unit/plugin/plugin-module-layout.test.ts
node_modules/.bin/tsc -p tsconfig.scripts.json --incremental false
```

## 7. 下一步

1. **重建 Lua 资产**（`pnpm run repack:lua` 或重启私服触发 `autoBuildLuaMod`），让 §2 的源头修复生效；
   之后修复型帧驱动不会再触发（`驱动触发: TimerModelUpdate` 应直接出现，且 `_newborn` 会被正常提升）。
2. 用 frida 原生钩子（`hook/il2cpp-client-redirect.ts` 已有每帧钩子与 UI 探针）补一条**不依赖 Lua**
   的驱动，彻底摆脱"客户端 Lua tick 被谁关掉"的时序依赖。
3. 把登录流程断言固化成剧本（`ui_check` 组 + `scene` 期望），并补齐：
   热更界面 → `login` →（SDK 登录）→ `main`；
   SDK 步骤要么改用私服已实现的账号密码链（`/user/auth/v1/token_by_phone_password`、`/u8/user/v1/getToken`），
   要么在模拟器上装可用的 telephony 通道。
4. 修 2.7.71 上失效的插件挂点（`get_overrideRouterUrl`、EventLogBlock 的 SDK/HTTP 钩子、UnityLog 的
   `_OnCatchLog`），它们的失败会让"服务器切换/上报截断/日志回传"的验收失去意义。

---

## 8. 补充：UI 文字溢出 + 404 弹窗（2026-09-15 下半场）

### 8.1 文字超出边框（插件面板）

**现象**：游戏内插件面板（`DoctorateTsPluginCanvas/PluginPanel(Clone)`）每行的说明文字压出行框。

**量到的几何**（MCP `client_eval` 实测，行宽 420 ⇒ x ∈ [-210, 210]）：

| 控件 | 修复前 | 修复后 |
| --- | --- | --- |
| `Name` | 260x24 @ x=-150 ⇒ x ∈ [**-280**, -20]（探出行外 70px） | 310x24 @ x=-45 ⇒ x ∈ [-200, 110] |
| `Desc` | 260x20 @ x=-150 ⇒ 同行；且文字需 **447px** 装进 260px ⇒ `Wrap`+`Truncate` 被切一半 | 310x20 @ x=-45；文字按可用宽裁到 **298px**（省略号） |
| `State` / `Toggle` | x ∈ [115, 185] / [118, 182]（未动） | 同左，不重叠 |

**修复**：
- `PluginUI.FitText(text, maxWidth)`：按 `preferredWidth` 实测把文本裁到框内并以 `…` 结尾；
  **按字符而不是字节**截断（`utf8.offset`），否则会切出多字节乱码；文案再长（含任意长的插件报错）也不会出框。
- `PanelPlugin:Refresh` / `_RefreshHint`、`OptionsPanelPlugin` 的 Label/Desc/Value 全部接入 `FitText`。

**验收**（MCP）：面板溢出扫描 `overflowCount` 中来自 `DoctorateTsPluginCanvas` 的条目 **5 → 0**；
`Desc` 实测 `pref=298 ≤ 300`、文本框 x ∈ [-200, 110]。

### 8.2 「网络请求失败，错误号404」弹窗

**现象**：游戏内多个 `panel_ok_dialog(Clone)` 并存，文案 `网络请求失败，错误号404`。

**根因**：客户端 `unity_log` 插件把 Unity 日志分片回传到 `/plugin/log/ingest/...`，
而**运行中的私服是旧构建**（该路由是后加的，进程未重启）⇒ 每个分片请求都 404，
游戏网络层对每个错误响应弹一次窗。私服访问日志实测：`404 x73 GET /plugin/log/ingest/*`。

**修复（两层）**：
1. **客户端侧熔断**（`UnityLogPlugin`，经 `/plugin/lua` 即时下发）：
   - **两条失败路径都要计数**——错误响应**不会回调 `onProceed`**，404 实际走的是
     `_Pump` 的 30s 卡死复位；只计 `finish(false)` 时熔断永不触发（本次踩过）。
   - 连续失败按 `flush_sec × 2^n` 退避（上限 600s），连续 5 次即**停发**并留一条可诊断说明；
     插件重载会清零熔断状态（服务端修好后 reload 即可复传）。
2. **服务端侧**（需重启私服，shell 侧无法代做）：重启后 `/plugin/log/*` 才有 ingest/查询端点，
   404 归零（顺带 `data/plugin/logs/<sid>.ndjson` 开始落盘、`client.logs` 之外多一条日志通道）。

**验收**：
- MCP `client_eval` 扫文本：弹窗文案命中数不再增长（修复前 73 请求 / 4 个并存弹窗）。
- 私服访问日志：`plugin/log/ingest` 请求数在两分钟内封顶（退避 → 熔断），而不是持续 1 次/8s。

### 8.3 顺带发现（环境侧，与本轮修复无关但会伪装成"网络连接失败"）

- **frida URL 重定向钩子偶发装不上**：`hook/il2cpp-client-redirect.ts` 的 `hooks` 事件没出现时，
  客户端请求不会被改写到 `127.0.0.1:8443`，而是走公网 ⇒ 拿不到私服配置、表现为卡住/网络失败。
  判定：`grep "'t': 'hooks'" tmp/mumu/frida.log`（正常应有 `url: ['set_url#1', ...]`）。
- **插件双份下发**：frida 注入（`dts_frida_inject`，`plugin-lua.js`）与资产内引导的 HTTP 下发
  （`dts_http` → `/plugin/lua`）都会 `PluginEntry.init()`；后一次初始化会卸载前一次的插件
  （实测 `[log] 自动化桥停止`），偶发把自动化桥留在停用态。二者取一（建议关掉 frida 注入那条）更稳。
