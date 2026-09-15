# MCP 自动化桥：让 Agent 真正操作客户端做 e2e 验证

> 2026-09-15 初版 · 客户端基线 2.7.71 · 私服侧 `app/ops/automation/`（`automation-hub.ts` + `automation.routes.ts`，组合根挂载） · 客户端侧 `lua/plugin/core/AutomationBridge.lua` + `lua/plugin/plugins/AutomationPlugin.lua` · MCP 侧 `scripts/mcp-automation-server.ts`
>
> **本文定位**：这套设施**是什么、协议长什么样、怎么用、怎么验证**。
> 插件开发契约见 `docs/lua-plugin-dev-reference.md`；游戏内 UI/回调硬契约见技能 `arknights-lua-plugin-contracts`。

---

## 0. 一句话

私服的 e2e 验证一直卡在「怎么让真实客户端做某件事，并确认它真的做了」——
以前要么手点、要么 adb 截图、要么写一次性 frida 探针。本设施把这件事变成 **MCP 工具调用**：
Agent 能查状态、点 UI、跳关卡、驱动战斗、截屏，并以**客户端自己的网络栈**验证私服端点。

---

## 1. 拓扑：为什么必须有三个角色

```
   外部 Agent（Claude/DSH/任意 MCP 客户端）
        │  MCP over stdio（JSON-RPC 2.0）
        ▼
   scripts/mcp-automation-server.ts          ← 角色 ③ MCP server（Node 进程，官方 SDK）
        │  HTTP POST /plugin/automation/call
        ▼
   私服进程（Express）
     app/ops/automation/automation.routes.ts        ← 角色 ② 命令中转（队列 + 结果重组）
     app/ops/automation/automation-hub.ts
        ▲  GET /poll（取命令）  GET /result（分片回传）
        │  HTTP（游戏原生 UISender）
   ┌────┴─────────────────────────────────┐
   │ 游戏客户端（Unity + xLua）             │  ← 角色 ① 执行器
   │  lua/plugin/core/AutomationBridge.lua │     轮询 / 调度 / 分片上传
   │  lua/plugin/plugins/AutomationPlugin  │     25 个命令处理器
   └──────────────────────────────────────┘
```

**为什么 MCP server 不放在 Lua 里**：客户端只有出站能力（`UISender.me:SendGet/SendRequest`），
没有入站监听，无法当 HTTP 服务器。所以 Lua 侧只能做**拉取式执行器**，MCP server 落在 Node 侧。

**为什么不直接让 MCP server 连客户端**：客户端在模拟器/手机里，且唯一的可用通道是游戏自己的
`UISender`（带会话、掩码、验签语义）。私服是双方唯一都够得着的会合点，顺带还能记录全链路日志。

---

## 2. 线协议（唯一权威定义，两侧代码与此对齐）

### 2.1 客户端 → 私服

| 端点 | 说明 |
| --- | --- |
| `GET /plugin/automation/poll/<sid>/<first>` | 取命令。`first=1` 表示本会话首次轮询（服务端据此登记会话并打日志）。响应 `{ status, result, protocol, commands: [{id,name,args}], nextPollMs? }`；`nextPollMs` **只在还有积压时**出现，提示客户端立刻续取 |
| `GET /plugin/automation/result/<sid>/<cmdId>/<seq>/<total>/<chunk>` | 回传结果分片，`seq` 从 1 起。响应 `{ status, result, done }`，`done=1` 表示该命令结果已凑齐 |

### 2.2 MCP / 管理端 → 私服

| 端点 | 说明 |
| --- | --- |
| `POST /plugin/automation/call` | 下发一条命令并**同步等结果**（`{ sid, name, args?, timeoutMs? }`）；超时不是 HTTP 错误，而是 `ok=false` 的业务结果 |
| `GET /plugin/automation/sessions` | 在线会话快照（sid / 最近轮询 / 积压 / 在途）+ hub 统计 |

### 2.3 结果信封与分片

结果先序列化成**信封**，再 base64url 编码，再按 1800 字符切片：

```jsonc
{
  "id": "<cmdId>", "sid": "<sid>", "protocol": 1,
  "ok": true, "ms": 12,
  "result": { /* 任意纯数据 */ },
  "error": null
}
```

三个关键决定，都是被约束逼出来的：

1. **走路径而不是 POST body**：客户端唯一被真机反复验证过的通道是 `SendGet`（心跳/选项同步都走它）。
2. **base64url 而不是百分号转义 JSON**：base64url 字母表 `A-Za-z0-9-_` 全是 RFC3986 非保留字符
   ⇒ **零转义膨胀**；JSON 直接进 URL 会膨胀 2~3 倍。分片后单条请求行稳定在 ~2KB，
   远离 Node 默认 16KB 请求头上限。
3. **分片而不是单发**：截图 base64 动辄几十 KB，单条 URL 装不下；分片后服务端按 `seq` 拼回，
   **乱序到达也能重组**（单测固化），客户端只需串行发。

> 结果上限由插件选项 `max_result_bytes`（缺省 512KB）兜底：超限时整条结果降级为
> `ok=false, error="result too large"`，语义清晰（而不是悄悄截断出一个看似正常的结果）。

---

## 3. 工具清单（27 个）

MCP 工具名 ↔ 游戏内命令名一一对应（守卫 `tests/unit/scripts/mcp-automation-tools.test.ts`
直接比对 `AutomationPlugin.lua` 的 `handlers[...]`，改名漏改会被测试拦住）。

| MCP 工具 | 命令 | 用途 |
| --- | --- | --- |
| `automation_sessions` | —（服务端本地） | 列出在线会话，多设备时选 sid |
| `game_ping` | `client.ping` | 连通性探测（排查超时的第一步） |
| `game_hello` | `client.hello` | 客户端版本/平台/场景 + 已注册命令与桥配置 |
| `game_state` | `client.state` | 场景 / UIPage / 战斗 / 玩家存档摘要 / 插件状态 |
| `game_logs` | `client.logs` | 桥的环形日志 + 插件加载错误 |
| `client_eval` | `client.eval` | 执行任意 Lua（需打开 `allow_eval`） |
| `plugin_list` | `plugin.list` | 插件清单与启停/错误 |
| `plugin_set_enabled` | `plugin.set_enabled` | 启停插件（会被**入口守卫**拒绝：不能关掉最后一个游戏内 UI 入口面板，结果里 `applied=false` + `note`） |
| `plugin_set_option` | `plugin.set_option` | 改插件选项（归一化 + 回推服务端） |
| `plugin_reload` | `plugin.reload` | 先停后启（验证释放路径） |
| `client_http_get` | `http.get` | **以客户端身份** GET 私服端点 |
| `client_http_post` | `http.post` | 以客户端身份 POST（服务码门禁可能拒绝，失败改用 GET） |
| `ui_find` | `ui.find` | 路径/名字查对象（激活态/屏幕坐标/组件/文本）——**函数断言主力**：`activeInHierarchy=false` 即「存在但已隐藏」 |
| `ui_check` | `ui.check` | **批量断言**（在不在/是否激活/文本对不对），一次往返拿结论——验证界面状态的首选 |
| `ui_dump` | `ui.dump` | 导出界面层级文本树（含文本与 `[inactive]`）——只用于**探索**不熟悉的界面 |
| `ui_find_text` | `ui.find_text` | 按文本找控件（比硬编码路径更抗版本漂移） |
| `ui_click` | `ui.click` | 点击（按 path/text/name 定位，自动向上找 Button/Toggle） |
| `ui_tap` | `ui.tap` | 屏幕像素坐标点击（射线命中栈顶） |
| `ui_set` | `ui.set` | 写 Toggle/InputField/Slider/激活态 |
| `stage_enter` | `stage.enter` | 找关卡格子 → 点开始（best-effort，回报每步实际动作） |
| `scene_current` | `scene.current` | 当前场景与已激活 UIPage |
| `scene_list` | `scene.list` | 构建配置里的场景清单 |
| `scene_load` | `scene.load` | 直接 LoadScene（绕过正常流程，慎用） |
| `battle_info` | `battle.info` | 是否在战斗 / 倍速 / 暂停 / 战斗时间 |
| `battle_control` | `battle.control` | 暂停 / 继续 / 倍速 / 单帧步进（TAS） |
| `game_screenshot` | `screenshot` | 截屏并以 **MCP image content** 返回——**最后手段**，仅用于程序读不到的视觉事实（渲染/布局/像素） |
| `game_wait` | `wait` | 客户端侧等待（串联「操作 → 等动画 → 断言」） |

### 3.1 验证一律先走函数调用，截图是最后手段

**原则**：能结构化读到的事实，就不要用图去看。截图要缩放 + JPEG 压缩 + base64 分片回传
（一次几十个请求），返回的图片还占大量上下文；而下面这些事实本来就是**可精确读取**的。

| 想确认的事 | 用哪个函数调用 | 为什么不用截图 |
| --- | --- | --- |
| 现在在哪一屏 / 在不在战斗 | `game_state` | UIPage 列表与战斗状态是结构化字段，比看图准 |
| 面板/控件开着没 | `ui_find`（看 `activeInHierarchy`）、`ui_check` | 布尔事实，`false` 就是已隐藏；截图只能肉眼判断 |
| 某个文本对不对 | `ui_find`（返回 `text`）、`ui_check { expect_text }` | 精确字符串比对，还能把 N 项写进一次调用 |
| 控件在不在（含已隐藏） | `ui_check { expect_exists / expect_active }` | 路径解析包含未激活对象，结论可复现 |
| 按文案找按钮 | `ui_find_text` | 直接给对象路径，可接着 `ui_click` |
| 服务端端点返回什么 | `client_http_get` | 走客户端真实网络栈，拿到响应体原文 |
| 插件有没有生效/报错 | `game_state` / `game_logs` / `plugin_list` | 启停态与错误文本都在结构化结果里 |
| 操作有没有生效 | `game_wait` 后再 `ui_check`/`game_state` | 「等一帧再断言」比「等一帧再截图」可靠 |
| **渲染/布局/贴图/像素级现象** | ❌ 只能 `game_screenshot` | 这是唯一程序读不到的类别（例：UI 到底有没有画出来） |

**典型 e2e 剧本**（Agent 侧，断言优先）：

```
game_ping                        → 确认在线
game_state                       → 当前在哪一屏
ui_find_text "开始行动"           → 找到按钮对象路径
ui_click  { text: "开始行动" }    → 点击
game_wait { ms: 1500 }           → 等动画
ui_check {                       → 一次断言多项（替代「截图看画面」）
  items = {
    { text = "开始行动", expect_active = false },          -- 按钮所在层已隐藏
    { name = "OptionsPanel(Clone)", expect_active = true,  -- 目标面板出现…
      expect_text_contains = "插件选项" },                  -- …且标题正确
  } }
client_http_get { url = "/config/prod/official/network_config" }  → 以客户端身份验证私服端点
# 只有上面都回答不了（例如要确认某个 UI 真的渲染出来了）才：game_screenshot
```

---

## 4. 怎么用

### 4.1 交付插件到客户端

与其它插件完全一致（插件系统已内置下发链路）：

```bash
pnpm run repack:lua      # 重打包内置 bundle（会把 lua/plugin/** 全量合并，无需额外登记资产）
# 或调试期：pnpm run watch:lua
```

新插件（`automation_bridge`）已在 `PluginDefs.lua`、`PluginOptions.lua`、
`app/ops/plugin/plugin-catalog.ts#FALLBACK_CATALOG` 三处登记，守卫会校验一致性。

### 4.2 起 MCP server

```bash
pnpm run start:quick                    # 私服（另开终端）
pnpm run mcp:automation                 # MCP server（stdio）
pnpm run mcp:automation -- --list-tools # 只打印工具清单（自检）
pnpm run mcp:automation -- --call game_state   # 不接 MCP 客户端，直接调一次
```

注册到 MCP 客户端（以 `.mcp.json` 风格为例）：

```jsonc
{
  "mcpServers": {
    "doctorate-ts-automation": {
      "command": "pnpm",
      "args": ["run", "mcp:automation"],
      "env": { "DTS_SERVER_URL": "http://127.0.0.1:8443" }
    }
  }
}
```

环境变量：

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `DTS_SERVER_URL` | `http://127.0.0.1:8443` | 私服基址 |
| `DTS_AUTOMATION_SID` | 空 | 默认目标会话（多设备时免去每次传 `sid`） |

### 4.3 会话 id 从哪来

客户端自己生成：`<tag>_<平台>_<秒级时间戳 hex>`（如 `dts_Android_1a2b3c`），**刻意不用随机数**
——改游戏侧 RNG 种子会影响战斗随机数。用 `automation_sessions` 列出候选；
只有一个在线会话时会自动选中。

---

## 5. 验证清单

### 5.1 无游戏也能验证整条链（推荐先跑这个）

`scripts/automation-sim-client.ts` 扮演**协议陪练**（同样的轮询与分片回传），

```bash
pnpm run start:quick                     # 终端 A
pnpm run automation:sim                  # 终端 B（打印收到的命令）
pnpm run mcp:automation -- --call game_state     # 终端 C：结构化状态
pnpm run mcp:automation -- --call ui_check \
  --args '{"items":[{"path":"UI/Main/LuaUIRoot/OptionsPanel(Clone)","expect_active":false}]}'
pnpm run mcp:automation -- --call game_screenshot # 仅验证「多分片 + image 渲染」这条传输路径
```

**本次实测证据**（2026-09-15，私服 + 模拟客户端 + MCP CLI）：

```
$ curl .../plugin/automation/sessions
{"count":1,"sids":["fake_Ubuntu_e2e01"],"hub":{"sessions":1,"waiters":0,"partials":0}}

$ mcp-automation-server.ts --call game_ping        # sid 自动选中
{ "pong": true, "sid": "fake_Ubuntu_e2e01", "t": 1789430435041 }

$ mcp-automation-server.ts --call client_http_get --args '{"url":"/config/prod/official/network_config"}'
{ "url": "/config/prod/official/network_config", "body": "{\"fake\":true}", "bytes": 13 }

$ mcp-automation-server.ts --call ui_check --args '{"items":[{"path":"...OptionsPanel(Clone)","expect_active":false}]}'
{ "pass": true, "total": 1, "failedCount": 0, "failed": [],
  "results": [ { "found": true, "activeInHierarchy": false, "text": "插件选项", "ok": true, "reason": null } ] }
# ↑「面板已隐藏」是一次可复现的布尔断言，不需要截图

$ mcp-automation-server.ts --call game_screenshot  # 9000 字符 base64 ⇒ 5 片，全部重组成功
[image image/jpeg 9000 chars base64]
截图 8x8（原始 ?x?），会话 fake_Ubuntu_e2e01，客户端耗时 2ms

# 私服日志（下发轨迹）
[Automation] 客户端自动化桥已连接: sid=fake_Ubuntu_e2e01
[Automation] 下发 1 条命令给 sid=fake_Ubuntu_e2e01: client.ping
[Automation] 下发 1 条命令给 sid=fake_Ubuntu_e2e01: http.get
[Automation] 下发 1 条命令给 sid=fake_Ubuntu_e2e01: screenshot
```

### 5.2 真机验证

> **2026-09-15 更新（必读）**：本节最初只是待办清单；真机实测发现桥**从未真正工作过**
> （只轮询一次就静默 + 只有第一条命令能回结果）。根因两条：① 注入的引导脚本 hotfix
> `GlobalInitializerAndUpdater.Update`——它其实是私有实例方法、`G.Update` 恒为 nil，于是包装
> 里的 `orig(...)` 从不执行，**把客户端全局每帧循环（`LuaManager.Update` → Lua 定时器）整体吞掉**；
> ② `AutomationBridge._ExecCommand` 的 `finished` 漏写 `local`，变成全局后第一条命令收尾即永久短路。
> 修复、证据链与登录流程实跑见 `docs/mcp-login-flow-2026-09-15.md`。下面 1~5 步在修复后已逐步通过
> （第 2 步实测为 26 条 handler；登录流程卡在 SDK 登录步骤，见该文 §5.2）。

1. 客户端启动（插件系统生效）→ 私服日志出现 `客户端自动化桥已连接: sid=…`；
   游戏内插件面板能看到「自动化桥」且为 ON。
2. `game_hello` 应返回 25 个已注册命令（`handlers` 字段）——**这是「Lua 侧真的起来了」的判据**。
3. `game_state` / `ui_find` / `ui_check` 应能读到当前界面与控件状态（**先用它们断言**）；
   `ui_dump` 用于探索不熟悉的界面；确实需要看图（渲染/布局/像素）时才 `game_screenshot`。
4. `client_http_get { url: "/config/prod/official/network_config" }` 必须返回 200 体——
   这是「客户端网络栈 → 私服」的真实闭环。
5. 逐条命令失败时先看 `game_logs`（桥的环形缓冲会记下未知命令/异常）。

### 5.3 自动化回归

```bash
node tmp/check-lua-syntax.mjs                                   # Lua 语法（19 个文件）
pnpm exec vitest run tests/unit/ops/automation-hub.test.ts      # 队列/分片/HTTP 形状
pnpm exec vitest run tests/unit/scripts/mcp-automation-tools.test.ts  # 工具表 ↔ Lua 命令名漂移
pnpm exec vitest run tests/unit/plugin/plugin-module-layout.test.ts   # 目录/注册/FALLBACK 同步
pnpm run typecheck:scripts
pnpm run type:debt
```

> 环境提示：本机沙箱的 `/tmp` 时间戳精度异常，会让 `lua-mod-builder.test.ts` 里依赖
> mtime 的 from-ref 用例偶发失败。把临时目录指到工作区内即可拿到真值：
> `mkdir -p tmp/vitest-tmp && TMPDIR=$PWD/tmp/vitest-tmp pnpm exec vitest run tests/unit/plugin/lua-mod-builder.test.ts`。

---

## 6. 设计取舍（踩坑与理由）

| 决定 | 理由 |
| --- | --- |
| **短轮询**（缺省 1s，积压时 100ms）而不是长轮询 | 客户端的 `UISender` 是 ENQUEUE 并发模型：挂住一个请求会让后续心跳/游戏请求排在它后面 |
| 空闲间隔由**客户端**（插件选项）控制，服务端只在有积压时给 `nextPollMs=100` | 客户端离线时服务端无从得知；让最了解自己状态的一侧掌握节奏 |
| 结果**分片**而非分多条命令 | 截图/日志是**一个**语义结果，分片能保持「一次调用一份结果」的原子性 |
| 超时返回 `ok=false` 而不是 HTTP 4xx/5xx | 超时是业务结果，应把「客户端多久没轮询」的诊断一并交给调用方 |
| 超时即把命令**从队列摘除** | 否则客户端上线后会执行一条早已无人等待的命令（幽灵操作，单测已固化） |
| 命令**串行**执行 | 命令间常有依赖（先点开面板再读层级），并发让结果不可复现 |
| **验证以函数调用为主，截图仅作最后手段** | 截图要缩放+JPEG+base64 分片（一次几十个请求）且只能靠人看图；而「在哪一屏/面板开着没/文本对不对/端点返回什么」本就是可结构化读取的事实——为此新增 `ui.check` 批量断言，并让 `ui.find` 的路径解析包含未激活对象（否则「已隐藏」只能靠截图） |
| 结果里的字符串上限放到 400KB 但总量卡 512KB | 截图 base64 是**一个大字符串**，按「单字符串 4KB」卡会把它拦腰截断 |
| 客户端所有 C# 访问都在 `pcall` 里 | 版本漂移只让**单条命令**失败；桥在每次轮询回调里运行，一次逸出就是一次客户端 abort |
| `sid` 不含随机数 | 改游戏侧 RNG 种子会影响战斗随机数 |
| 结果**不落盘** | 调试设施，重启即清；避免把游戏状态写进仓库数据 |

---

## 7. 安全边界（重要）

- 这些端点与既有 `/plugin/*` 一样**不做鉴权**，且能力很强（`client.eval` 可执行任意 Lua、
  `plugin_set_enabled` 可关掉其它插件——但**关不掉最后一个游戏内 UI 入口面板**：
  `plugin_panel` / `options_panel` 至少留一个，否则游戏内将再无入口（入口守卫在客户端与
  服务端两侧都生效，见 `docs/lua-plugin-dev-reference.md` §10.13））。**仅适用于本机单机私服调试**；
  对外暴露必须置于反代鉴权之后，或把 `automation_bridge` 插件停用（停用即桥停止轮询）。
- `client.eval` 额外有一道闸：插件选项 `allow_eval`（缺省**关闭**）。要用先打开。
- `scene_load` 绕过游戏正常流程，可能让 UI 处于不一致状态——优先 `ui_click`/`ui_tap`。
- `MAX_PENDING_PER_SESSION=64`：客户端掉线时不会无限堆积命令，再下发会明确报错。

---

## 8. 已知限制与下一步

- **`ui_click` 的定位依赖对象名/文本**：改名（版本漂移）后需要改剧本；
  所以优先用 `ui_find_text`（按可见文本）而不是硬编码层级路径。
- **`http.post` 的 service code 门禁未经真机验证**：C# `LuaSender.SendRequest` 对
  `overrideUrl` 的接受度受 `AchieveServiceMeta` 影响，失败时请改用 `client_http_get`。
- **截图分辨率/质量受 `max_result_bytes` 约束**：宽度 1280 + JPEG 95 会撞上限而降级为错误；
  默认 480/60 是「能看清且回传快」的折中。
- **`stage.enter` 是 best-effort**：它按「名字含 stage_id 的对象」出现位置找格子，
  不同界面布局可能要先 `ui_click` 进到对应页面；返回值里记录了每步的实际动作，便于诊断。
- **下一步可做**：结果事件的 SSE 推送（现在只能轮询 `game_logs`）、
  `battle.control` 增加「按时间轴跳到第 N 帧」、截图区域裁剪。

---

## 9. 相关文档与技能

| 主题 | 位置 |
| --- | --- |
| 插件开发参考（目录/注册/补丁/选项/心跳/陷阱） | `docs/lua-plugin-dev-reference.md` |
| 插件契约速记（技能） | `skills/arknights-lua-plugin-contracts/SKILL.md` |
| 打包下发与真机验收 | `docs/lua-plugins-guide.md` |
| 环境拓扑与三条交付链路 | `docs/frida-mumu-lua-plugin-playbook-2026-09-14.md` |
