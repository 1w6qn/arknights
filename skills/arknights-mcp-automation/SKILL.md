---
name: arknights-mcp-automation
description: 用 MCP 工具驱动真实明日方舟客户端做端到端验证（查状态/点 UI/跳关卡/驱动战斗/截屏/以客户端身份探私服端点）；用于"要验证私服某个改动的真实效果""让 Agent 自动操作游戏复现问题"，或排查"命令超时/工具报客户端未实现"。
---

# MCP 自动化桥：驱动真实客户端做 e2e

## 何时用
- 私服改了某处，想确认**真实客户端**的表现（而不是单测/curl 的结论）；
- 需要让 Agent 自动走一遍流程（进关卡、点按钮、看画面）；
- 排查自动化工具本身的问题（命令超时、工具报「客户端未注册」）。

## 三角色拓扑（先建立这个心智模型）
```
Agent ──MCP(stdio)──▶ scripts/mcp-automation-server.ts
                              │ HTTP POST /plugin/automation/call
                              ▼
                      私服（app/ops/automation/automation-hub.ts + automation.routes.ts）
                              ▲ GET /poll（取命令）  GET /result（分片回传）
                              │
                      游戏客户端（lua/plugin/core/AutomationBridge.lua
                                + lua/plugin/plugins/AutomationPlugin.lua）
```
**客户端只能出站**（`UISender`），所以 Lua 侧是**拉取式执行器**，MCP server 必须在 Node 侧。
客户端离线时命令不会丢：挂在私服队列里等它上线（但会按 `timeoutMs` 超时）。

## 起服与自检
```bash
pnpm run start:quick                       # 终端 A：私服
pnpm run mcp:automation -- --list-tools    # 看 27 个工具
pnpm run mcp:automation -- --call game_ping # 直接调一次（不接 MCP 客户端）
```
注册到 MCP 客户端：`command=pnpm, args=["run","mcp:automation"]`，
可选环境变量 `DTS_SERVER_URL`（缺省 `http://127.0.0.1:8443`）、`DTS_AUTOMATION_SID`。

**没有游戏也能验证链路**（协议陪练）：
```bash
pnpm run automation:sim                    # 扮演客户端的传输层
pnpm run mcp:automation -- --call game_state
```

## 工具用法要点

★ **验证一律先走函数调用，截图是最后手段。** 能结构化读到的事实（在哪一屏、面板开着没、
文本对不对、控件在不在、插件状态、服务端端点返回什么）都用函数调用确认——精确、便宜、可复现；
截图要缩放 + JPEG + base64 分片回传（一次几十个请求）且只能靠人看图，还占大量上下文。
只有**程序读不到的视觉事实**（渲染有没有出来、布局错位、贴图/像素级现象）才用 `game_screenshot`。

| 想确认的事 | 用什么（而不是截图） |
| --- | --- |
| 在哪一屏 / 在不在战斗 / 数值对不对 | `game_state` |
| 面板/控件开着没 | `ui_find`（看 `activeInHierarchy`）或 `ui_check` |
| 一组界面事实（含文本比对） | `ui_check { items = {...} }` —— 一次往返拿结论，**替代「截图看画面」** |
| 按文案找按钮 | `ui_find_text` |
| 服务端端点返回什么 | `client_http_get`（客户端真实网络栈） |
| 插件生效/报错 | `game_state` / `plugin_list` / `game_logs` |

其他要点：
- `automation_sessions` 先看在线会话；只有一个时会自动选中，多设备必须传 `sid`。
- `game_hello` 的 `handlers` 字段是「Lua 侧真的起来了」的判据（应有 26 条）。
- **定位控件优先用 `ui_find_text`（按可见文本），不要硬编码层级路径**——版本改动会改名。
- `ui_find` 的路径解析**包含未激活对象**，所以「面板已关闭」是可断言的（`found=true, activeInHierarchy=false`），不必截图确认。
- `ui_dump` 只用于**探索**不熟悉的界面；已知目标用 `ui_find`/`ui_check`，并限制 `depth`。
- `ui_click` 会自动从目标向上找父节点的 `Button`/`Toggle`，并回报实际触发方式；
  找不到可点的对象时返回 `clicked=false` 而不是报错。
- `client_http_get` 是**最强的端到端断言**：请求由客户端自己的网络栈发出。
- `client_eval` 需先在插件选项里打开 `allow_eval`（缺省关闭）。

典型剧本：
```
game_ping → game_state → ui_find_text("开始行动") → ui_click{text=...}
→ game_wait{ms=1500} → ui_check{items={{…expect_active=false},{…expect_text_contains="…"}}}
→ client_http_get{url=/...}
# 上面的函数调用都答不了时才 → game_screenshot
```

## 失败排查对照表
| 现象 | 先看什么 |
| --- | --- |
| 工具报「没有客户端连接自动化桥」 | 客户端是否启动；`automation_bridge` 插件是否启用；客户端是否连的是本私服 |
| 工具报「命令超时」 | 私服日志 `[Automation] 下发 …` 有没有；`game_logs`；客户端是否卡在加载/断网 |
| 工具报「未知命令（客户端未注册）」 | 客户端插件版本旧（没重新打包下发）→ `pnpm run repack:lua` |
| 报「多个在线会话」 | 用 `automation_sessions` 拿 sid 显式指定 |
| 截图报「result too large」 | 调小插件选项 `screenshot_width`/`screenshot_quality` 或调大 `max_result_bytes`；**先问一句「这件事能不能用函数断言」** |
| 截图很慢 / 上下文被图撑满 | 改用 `game_state` / `ui_find` / `ui_check` / `client_http_get`；截图是最后手段 |
| MCP 客户端连不上 | 本 server 的 **stdout 只能跑协议**，诊断一律走 stderr；确认没有 `console.log` 混入 |

## 硬约束（改这套设施时）
1. **客户端侧**：回调必须是 `Event` 对象（`Event.CreateStatic`），C# 调用一律 `pcall`——
   桥跑在每次轮询回调里，一次逸出就是整个客户端 abort。
   `AutomationBridge.Delay()` 已封装定时器契约，别自己调 `TimerModel:Delay(裸函数)`。
2. **协议**：客户端→服务端的两个端点是 GET + 路径编码（客户端只有 `SendGet`）；
   结果信封 → base64url → 1800 字符分片。改分片大小要同时改
   `AutomationBridge._MAX_CHUNK` 与 `scripts/automation-sim-client.ts`。
3. **命令名**：`AutomationPlugin.lua` 的 `handlers[...]` 与
   `scripts/lib/automation-tools.ts` 的工具表必须一致——守卫
   `tests/unit/scripts/mcp-automation-tools.test.ts` 直接比对 Lua 源码，改名漏改会红。
4. **新插件登记三处**：`PluginDefs.lua`、`PluginOptions.Defs`、
   `app/ops/plugin/plugin-catalog.ts#FALLBACK_CATALOG`（守卫会校验）。
5. **类型债**：新增 TS 文件必须零 `any`/`unknown`/`object`（`pnpm run type:debt`）。
   JSON 载荷统一用 `@core/utils/json-value` 的 `JsonValue`。
6. **加新能力时优先加「结构化查询/断言」命令，而不是让 Agent 去截图**：
   图像只该用在程序读不到的事实上。例：`ui_check`（批量断言）与
   `ui.find` 的「含未激活对象」路径解析，都是为了把「面板关了没 / 文本对不对」
   从「看图猜」变成可复现的布尔结论。

## 回归命令
```bash
node tmp/check-lua-syntax.mjs
pnpm exec vitest run tests/unit/ops/automation-hub.test.ts
pnpm exec vitest run tests/unit/scripts/mcp-automation-tools.test.ts
pnpm exec vitest run tests/unit/plugin/plugin-module-layout.test.ts
pnpm run typecheck:scripts && pnpm run type:debt
```

## 相关文档
`docs/mcp-automation-2026-09-15.md`（协议全文 + 工具清单 + 实测证据 + 取舍）、
`docs/lua-plugin-dev-reference.md`（§5.0 协议、§8 API）、
技能 `arknights-lua-plugin-contracts`（游戏侧硬契约）。
