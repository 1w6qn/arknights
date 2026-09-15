# Lua 插件开发参考

> 2026-09-14 初版 · 客户端基线 2.7.71 · 对应源码 `lua/plugin/`（`core/ + ui/ + plugins/` 三层）
>
> **本文定位**：写/改插件时的 **API 与契约参考**（怎么调、有哪些坑、协议长什么样）。
> 与 `docs/lua-plugins-guide.md`（使用与真机验证指南：怎么打包下发、怎么在设备上验收）互补。
> 契约速记版见技能 `skills/arknights-lua-plugin-contracts/SKILL.md`；环境/探针见
> `docs/frida-mumu-lua-plugin-playbook-2026-09-14.md`。

---

## 0. 30 秒速览

- 一个插件 = `lua/plugin/plugins/<Name>.lua`，**继承 `BasePlugin`**，实现 `OnLoad()` / `OnUnload()`，`return` 类本身。
- 在 `lua/plugin/PluginDefs.lua` 登记 `{ id, name, desc, module = "Plugin/plugins/<Name>" }` 后即被加载。
- 打补丁只用基类的 `self:Hotfix(cls, method, fn)`（包装，可调 `orig`）或 `self:Fix_ex(cls, method, fn)`（替换）；
  **不要**自己 `xlua.hotfix`——多插件 hook 同一方法会互相覆盖。
- 可调参数声明在 `lua/plugin/core/PluginOptions.lua`，用 `PluginOptions:Get(id, key)` 读、订阅变更实时重应用。
- 所有从游戏回调/定时器进出的东西（`UISender` 回调、`TimerModel:Delay` 回调）**必须是带 `Call` 方法的对象**
  （`Event.CreateStatic(fn)`），传裸函数会让**整个客户端 abort**。
- 自建 UI 必须挂在 `PluginUI.FindCanvas()` 返回的自建 Overlay 画布上，交互用 `PluginUI.EnableClick/EnableDrag`，
  **不要**用 UGUI `Button`（自建画布上会点击穿透）。
- 客户端清单只有一个文件 `persistentDataPath/plugin_config.json`，一律经 `PluginConfigFile.Update` 读→改→写。
- 需要**从外部驱动客户端**（MCP/Agent 做 e2e 自动化）时，用 `Plugin/core/AutomationBridge` +
  `Plugin/plugins/AutomationPlugin` 注册命令处理器，协议见 §5.0。

---

## 1. 目录与注册契约

```
lua/plugin/
├── PluginDefs.lua   ← 唯一注册表（务必改这里，否则模块永不加载）
├── core/            ← 基础设施（一般不改；改要跑回归）
├── ui/PluginUI.lua  ← 共享 UI 控件工厂
└── plugins/         ← 业务插件（每个插件一个文件）
```

新增插件必须同时满足三处一致：

| 位置 | 要写什么 |
| --- | --- |
| `PluginDefs.lua` | `{ id = "my_plugin", name = "...", desc = "...", module = "Plugin/plugins/MyPlugin" }` |
| 插件文件 | `local MyPlugin = Class("MyPlugin", require("Plugin/core/BasePlugin"))`，`return MyPlugin` |
| `PluginOptions.Defs`（可选） | 若插件有可调参数，追加 `{ id = "my_plugin", options = { ... } }`（`id` 必须与 PluginDefs 一致） |
| `ui_entry = true`（可选） | 仅**提供游戏内面板/浮窗按钮**的插件才标：标记后参与「入口守卫」（见 §10.13） |

- `module` = **Lua require 路径** = `Plugin/` + 相对 `lua/plugin/` 去 `.lua` 的 POSIX 路径。
- 客户端按 require 路径推导容器 key（`dyn/gamedata/[uc]lua/<小写相对路径>.bytes`），
  `repack-lua-bundle` 同时登记 basename 别名 key ⇒ **basename 必须全局唯一**（守卫 `tests/unit/plugin/plugin-module-layout.test.ts`）。
- 插件 `id` 是启停态/选项的持久化键，一经发布不要改（改 = 丢用户配置）。
- 违规会被守卫测试拦住：目录规范、require 可解析、basename 唯一、服务端 `FALLBACK_CATALOG` 不漂移。

---

## 2. 生命周期与加载链

### 2.1 加载顺序（客户端启动）

```
entry.lua → Hotfixes/DefinedFix.lua
  → HotfixProcesser.Do(fixes)            -- 游戏原生热修管线
     → require "Plugin/core/PluginBootHotfixer" + new() + Init() → OnInit()
        → _BootstrapGlobals()            -- 挂 _G.PluginDefs/PluginManager/PluginEntry/PluginHeartbeat
        → PluginEntry.init()
           → PluginManager.me:Init()
              → 读 plugin_config.json 的 enabled
              → for def in PluginDefs: require(def.module) → new(id, name, desc)
              → 启用态为 true 的插件 plugin:Load() → OnLoad()
        → PluginHeartbeat.ScheduleAuto()
```

**时序要点**：这段跑在 `ModelMgr.Init()` / 网络 / 主 UI **之前**。所以引导阶段：

- `TimerModel.me` 可能为 `nil`（`TimerModel` 的 Update 要等 `BindSwitcher` 接通驱动）；
- `UISender.me` 可能为 `nil`（心跳发不出去属正常，会被自动重试）；
- `UI/Main/LuaUIRoot` 通常不存在 ⇒ 见 §7 自愈链。

### 2.2 释放（重载/退出）

游戏 `LuaManager.ReloadScripts()` → `_DoDisposeLuaEnv()` → `LuaEnv.Dispose()`。
若此时还有 C# 持有的 Lua 回调，xLua 会抛 `InvalidOperationException: try to dispose a LuaEnv with C# callback!`
并让**整个客户端 abort**。`PluginEntry` 已热修 `LuaManager.ReloadScripts`：先 `PluginEntry.dispose()`
（逐个 `plugin:Unload()` → 经 `PluginHotfix` 撤销补丁、释放回调），再撤包装器，最后调原实现。

> 你只要保证 `OnUnload()` 把自己创建的东西清干净（销毁 UI、退订选项、清引用），补丁由基类统一注销。

### 2.3 BasePlugin 生命周期

| 方法 | 谁调 | 说明 |
| --- | --- | --- |
| `plugin:Load()` | `PluginManager:Init/SetEnabled` | 幂等；置 `enabled=true` 后调 `OnLoad()`；失败则回滚 `enabled` 并注销本轮补丁 |
| `plugin:Unload()` | 同上 / `PluginEntry.dispose()` | 调 `OnUnload()` + 注销全部补丁；即使处于停用态也会清理残留补丁 |
| `plugin:OnLoad()` | 子类实现 | 打补丁、订阅选项、建 UI |
| `plugin:OnUnload()` | 子类实现 | 销毁 UI、退订、清引用 |

`OnLoad` 内部异常由基类 `xpcall` 兜住并写 `LogHotfixError`，**不会**拖垮其它插件（但该插件会被置为停用态）。

---

## 3. 补丁 API

### 3.1 两种模式

```lua
-- 包装模式：fixFunc(self, orig, ...)，orig 是链上「下一段」实现
self:Hotfix(CS.Some.Type, "MethodName", function(selfObj, orig, arg1)
  -- 前置逻辑（建议整个包在 xpcall 里，见 §10.7）
  local result = orig(selfObj, arg1)   -- 保留原行为
  -- 后置逻辑
  return result
end)

-- 完整替换：fixFunc(self, ...) 取代整条链（同一方法同时只有一个生效，后注册覆盖先注册）
self:Fix_ex(CS.Torappu.Network.Networker, "get_overrideRouterUrl", function(selfObj)
  return "http://127.0.0.1:8443/config/prod/official/network_config"
end)
```

### 3.2 共享注册表语义（`PluginHotfix`）

多插件 hook 同一 `(cls, method)` 时，注册表**只装一个 `xlua.hotfix` 包装器**，各插件的处理函数按注册顺序链式组合：

- `Hotfix`：后注册者的 `orig` = 前一段组合，最终 `orig` = 原方法。卸载只摘自己的那段，最后一个摘完才还原原方法。
- `Fix_ex`：整条链被替换；多插件同时 `Fix_ex` 同一方法会互相覆盖（避免这样用）。
- 目标方法不存在（版本漂移）时注册返回 `false`，`BasePlugin` 记 `目标方法不存在（版本漂移?）: <method>` 日志；
  **不影响**其它插件。属性 getter 用 `get_xxx`（如 `get_overrideRouterUrl`）。

> `BasePlugin:Fix_ex/_UnregisterAll` 会记录 `(cls, method)` 并在 `Unload()` 时经 `PluginHotfix.Unfix` 撤销，
> 所以**只需用基类方法**，不要手写 `xlua.hotfix`。

### 3.3 方法名漂移排查

日志出现 `目标方法不存在（版本漂移?）` 时，用 `pnpm run decompile` 产出的 C# 源码或
`tmp/dts-dump` 的类/方法表核对真实名字，再「修正类名/方法名 + 重新打包」。插件内所有对游戏 API 的调用
都应 `pcall`/`xpcall` 兜底，避免一次漂移把整个插件（或客户端）带崩。

---

## 4. 选项系统（`PluginOptions`）

### 4.1 声明

在 `lua/plugin/core/PluginOptions.lua` 的 `PluginOptions.Defs` 追加（顺序即选项面板页签顺序）：

```lua
{
  id = "my_plugin",              -- 必须与 PluginDefs.lua 的 id 一致
  options = {
    { key = "enabled_hud", label = "显示 HUD", type = "switch", default = true, desc = "…" },
    { key = "font_size",   label = "字号",     type = "number", default = 16,
      min = 10, max = 40, step = 2, format = "%d", desc = "…" },
    { key = "color",       label = "颜色",     type = "enum",   default = "red",
      choices = { { value = "red", label = "红" }, { value = "green", label = "绿" } } },
  },
}
```

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `key` | 全部 | 持久化键名；**必须匹配服务端约束** `^[A-Za-z_][A-Za-z0-9_]{0,31}$`（≤32 字符） |
| `label` / `desc` | 全部 | 面板显示名 / 说明（`desc` 可选） |
| `type` | 全部 | `"switch"` \| `"number"` \| `"enum"` |
| `default` | 全部 | 未配置 / 脏数据时的回退值（**改默认值会改变未动过选项的玩家行为**） |
| `min` / `max` / `step` / `format` | number | 夹取与步进网格；`format` 只影响面板显示 |
| `choices` | enum | `{ { value = <字符串>, label = <显示名> }, ... }` |

### 4.2 取值归一化规则（非法值一律回退 `default`）

- `switch`：接受 `true/false`、`1/0`、`"1"/"0"`、`"true"/"false"`。
- `number`：`tonumber` 后夹到 `[min,max]`，再吸附到 `min + round((n-min)/step)*step`（`step>0` 时；步进基准是 `min`，缺省 0），
  末值用 `%.4f` 消浮点尾差。
- `enum`：与 `choices[i].value` 做 `tostring` 相等比较，命中则取定义值。
- ⚠️ `false` 是合法取值，读值不要写 `raw or default`（会把「显式关闭」误判成未配置）。

### 4.3 API 速查

| 调用 | 说明 |
| --- | --- |
| `PluginOptions:Get(id, key)` | 当前生效值；未知选项返回 `nil` |
| `PluginOptions:Set(id, key, value)` | 归一化后写入 + 落盘 + 广播；非法返回 `nil` |
| `PluginOptions:ApplyServer(id, key, value)` | 应用服务端下发值（与本地相同则跳过，避免写盘/回推死循环） |
| `PluginOptions:Reset(id)` | 恢复该插件全部默认值并广播 |
| `PluginOptions:Snapshot(id)` | 返回 `{ [key] = value }` 快照（推送服务端用） |
| `PluginOptions.Subscribe(fn)` | 订阅变更；`fn(id, key, value)`，异常被 xpcall 隔离；返回 `fn` 供退订 |
| `PluginOptions.Unsubscribe(fn)` | 按引用退订 |
| `PluginOptions:Reload()` | 丢弃缓存，下次读盘（选项面板打开时调用） |

**插件侧标准写法**：`OnLoad` 里 `self._onOption = PluginOptions.Subscribe(...)`，`OnUnload` 里 `Unsubscribe`；
热路径（如每帧 `Update`）**不要**每帧查 `Get`，应在变更回调里缓存到 `self._opts`（参考 `BattleAssistPlugin`）。

### 4.4 服务端边界

服务端**不重复维护选项定义域**（定义域以 `PluginOptions.lua` 为单一数据源）。`app/ops/plugin/plugin-config-service.ts` 只校验：

- 插件 id 在目录内；
- `key` 匹配 `^[A-Za-z_][A-Za-z0-9_]{0,31}$`；
- 值为布尔 / 有限数值（`|v| ≤ 1e9`）/ 短字符串（长度 1..64，无控制字符）；
- 单插件选项键 ≤ 64 个。

⇒ **加一个选项只需改 Lua**，服务端无需改动。

---

## 5. 心跳与服务端协议

客户端 `PluginHeartbeat` 走游戏原生 `UISender.me:SendGet`（`useMask = false`）。端点在
`app/game/modules/system/plugin.routes.ts`，配置落在 `data/plugin/config.json`。

| 方法 / 路径 | 方向 | 说明 |
| --- | --- | --- |
| `GET /plugin/heartbeat` | 客户端 → 服务端 | 生效确认；响应回传 `catalog`（启停态）与 `options`（选项取值），客户端 best-effort 应用 |
| `GET /plugin/config/:id/:value` | 客户端 → 服务端 | 启停态推送，`value` = `0`/`1` |
| `GET /plugin/option/:id/:key/:value` | 客户端 → 服务端 | 选项推送，`value` 编码见下 |
| `GET /plugin/lua` | 客户端 → 服务端 | 「资产内引导 + 私服下发」模式的插件源码 chunk（自包含，见 §9.3） |
| `GET /plugin/log/ingest/…` | 客户端 → 服务端 | Unity 日志回传分片（`unity_log` 插件，见 §5.4） |

> 启停推送受**入口守卫**约束：试图关掉最后一个 `ui_entry` 面板时，服务端返回
> `{ status: 1, msg: "不能停用最后一个插件入口…" }`，客户端也会拒绝并把自己实际仍启用的
> 状态推回来（见 §10.13）。因此「客户端与服务端配置收敛」不会因为这次拒绝而互相打架。

### 5.0 自动化桥（`automation_bridge`：MCP 驱动的反向通道）

`Plugin/core/AutomationBridge.lua` + `Plugin/plugins/AutomationPlugin.lua` 复用同一套
「客户端只出站」约束做**反向驱动**：客户端轮询私服取命令、执行、把结果分片回传，
于是外部 Agent（MCP 工具）能操作客户端做 e2e 验证。

| 方法 / 路径 | 方向 | 说明 |
| --- | --- | --- |
| `GET /plugin/automation/poll/<sid>/<first>` | 客户端 → 服务端 | 取一批命令（短轮询）；响应含 `commands` 与可选的 `nextPollMs`（仅积压时出现） |
| `GET /plugin/automation/result/<sid>/<cmdId>/<seq>/<total>/<base64url>` | 客户端 → 服务端 | 结果分片回传（信封 JSON → base64url → 1800 字符切片） |
| `POST /plugin/automation/call` | MCP / 管理端 → 服务端 | 下发命令并同步等结果（超时是 `ok=false` 的业务结果，不是 HTTP 错误） |
| `GET /plugin/automation/sessions` | MCP / 管理端 → 服务端 | 在线会话快照 |

- 结果大小闸门是插件选项 `max_result_bytes`（缺省 512KB）：超限整条结果降级为错误说明。
- 命令**串行**执行，单条超时由插件选项 `cmd_timeout_ms` 兜底；`Poll()` 用 `_busy` 闸门防重入。
- 完整协议、27 个 MCP 工具与 e2e 验证清单见 `docs/mcp-automation-2026-09-15.md`。

心跳响应（`res.json`）：

```jsonc
{
  "status": 0, "result": 0,
  "pluginCount": 7, "enabled": 7,
  "catalog": [ { "id": "enemy_hp", "name": "敌人血量显示", "enabled": true }, /* … */ ],
  "options": { "enemy_hp": { "font_size": 18, "color": "orange" } },
  "serverTime": 1730000000000
}
```

> 客户端解析时兼容 `{ result = … }` 包一层（`_OnHeartbeatResponse`）。

### 5.1 选项值路径编码（Lua `_EncodeOption` ↔ 服务端 `decodeOptionValue`）

| 值 | 编码 |
| --- | --- |
| `true` / `false` | `b1` / `b0` |
| `number` | `n<数字>`（`string.format("%g")`） |
| 其它（字符串） | `s<URL 编码>`（仅放行 `%w-._~`，其余 `%XX`） |

### 5.2 时序与重试

- 引导阶段立刻尝试一次；`_SendOnce` **只有真的发出**才回报成功，未就绪不会误标记已确认。
- `ScheduleAuto()` 必然装上 `UIController.Awake` 兜底（必然晚于登录/网络就绪）补发，并在 `TimerModel` 就绪后
  排延迟重试链（最多 6 次、每次 5s）。
- 面板打开时由 `PanelPlugin` 调 `PluginHeartbeat.Send()` 再确认一次。
- 客户端侧改动即时推送：`SetEnabled` → `PushState`；选项面板提交 → `PushOption`。

### 5.3 两个 `SendGet` 契约（高频踩坑）

1. **必须 `UISender.me:SendGet(...)`**（实例方法），把类表当 `self` 会让回调永不触发。
2. **回调必须是带 `Call` 方法的对象**：

```lua
local cb = Event.CreateStatic(function(resp) … end)   -- ✅
-- UISender.me:SendGet(url, nil, { onProceed = cb, useMask = false })
-- 传裸函数 ⇒ attempt to index a function value (field 'onProceed') ⇒ 客户端 abort
```

### 5.4 Unity 日志回传（`unity_log` 插件 → `/plugin/log/*`）

客户端**没有**可订阅的 Unity 日志 API（`Application` 无 wrapper、CoreModule 无 hotfix 桥），
唯一锚点是 `Torappu.FileLogger._OnCatchLog`（`Application.logMessageReceived` 的唯一托管订阅者）；
而 `DFLogger.InitIfNot` 在游戏里无人调用，故插件**自己建 sink** 再热修它。
完整论证、协议与存储见 `docs/lua-unity-log-report-2026-09-15.md`。

| 方法 / 路径 | 方向 | 说明 |
| --- | --- | --- |
| `GET /plugin/log/ingest/<sid>/<batchId>/<seq>/<total>/<chunk>` | 客户端 → 服务端 | 日志分片（JSON 信封 → base64url → 1800 字符切片） |
| `GET /plugin/log/sessions` | 分析侧 → 服务端 | 会话列表 + 全局统计 |
| `GET /plugin/log/records/<sid>?last=N&level=E` | 分析侧 → 服务端 | 某会话尾部记录 |
| `GET /plugin/log/stats` | 分析侧 → 服务端 | 仅统计 |

- 落盘 `data/plugin/logs/<sid>.ndjson` + `<sid>.meta.json`（一行一条，外部工具可直接消费）；
  离线分析入口 `pnpm run admin -- plugin logs sessions|show|stats|export|clear`。
- 单例 `pluginLogStore`（`app/ops/plugin/plugin-log-store.ts`）对客户端输入全部设上限
  （标识字符集 / 分片长度与数量 / 单批字节与条数 / 单条正文与堆栈），未凑齐分片有 TTL 与条数上限。
- 其它插件可借道上报诊断：`require("Plugin/plugins/UnityLogPlugin").Report("warning", "…")`。

---

## 6. 客户端配置文件

**只有一个文件**：`CS.UnityEngine.Application.persistentDataPath .. "/plugin_config.json"`，两块内容共用：

```jsonc
{
  "enabled": { "enemy_hp": true, "plugin_panel": false },   // PluginManager 负责
  "options": { "enemy_hp": { "font_size": 18 } }            // PluginOptions 负责
}
```

两块必须走 `PluginConfigFile.Update(mutator)`（读 → 改 → 写）以避免互相清空；未知顶层键原样保留。
`rapidjson` / `System.IO.File` 在引导阶段可能尚不可用，故本模块**惰性获取 + 失败缓存**，读写失败只返回空表/`false`，绝不抛错。

| 调用 | 说明 |
| --- | --- |
| `PluginConfigFile.Path()` | 配置绝对路径（懒计算缓存） |
| `PluginConfigFile.Read()` | 读表；异常/缺文件返回 `{}`（绝不 `nil`） |
| `PluginConfigFile.Write(cfg)` | 覆盖写；失败返回 `false` |
| `PluginConfigFile.Update(mutator)` | 读→`mutator(cfg)`→写；返回修改后的表 |

> 注意区分：**设备侧**是 `persistentDataPath/plugin_config.json`；**服务端侧**是仓库 `data/plugin/config.json`
> （`app/ops/plugin/plugin-config-service.ts` 维护）。二者经 §5 的心跳/推送收敛，不共享文件。

---

## 7. UI 工具箱（`PluginUI`）

### 7.1 硬契约

1. **画布必须自建**：用 `PluginUI.FindCanvas()`（内部建 `DoctorateTsPluginCanvas`，`ScreenSpaceOverlay`，`sortingOrder = 30000`，
   `DontDestroyOnLoad`）。不要复用游戏画布——`hot_update` 等场景没有 `UI/Main/LuaUIRoot`，退回「任意画布」会拿到相机遮挡的
   `ScreenSpaceCamera`，表现为**对象 active 却看不见**。
2. **交互用自绘输入**：`PluginUI.EnableClick(obj, fn)` / `PluginUI.EnableDrag(obj, onTap, hitObj, clickOnly)`。
   自建 Overlay 画布上 UGUI `Button` 命中不稳定（点击穿透）且不能拖。
   驱动是逐帧热修 `CS.Torappu.GlobalInitializerAndUpdater.Update`（只装一次），读 `Input.GetMouseButton(0)` +
   `Input.mousePosition`，用 `RectTransformUtility.RectangleContainsScreenPoint(rect, pos, nil)` 判命中；
   位移 > 10px 计拖动，否则松手算点击。
3. **不要依赖一帧成功**：引导早于主 UI，用 `PluginUI.RetryEnsure(plugin, maxRetry, delaySec)` 启动自愈链
   （`TimerModel` 未就绪时登记待补排，`BindSwitcher` 接通后补跑；建成后低频巡检，场景切换销毁自动重建）。

### 7.2 API

| 调用 | 返回 | 说明 |
| --- | --- | --- |
| `PluginUI.FindCanvas()` | `Transform` / `nil` | 自建 Overlay 画布（优先），失败退回游戏根/最高 sortingOrder 画布 |
| `PluginUI.ResolveFont()` | `Font` / `nil` | 解析可渲染中文的字体（缓存；未解析到会重试，最多 5 次） |
| `PluginUI.IsAlive(obj)` | `boolean` | Unity 对象存活判定（场景切换后引用仍在但已销毁 ⇒ `false`） |
| `PluginUI.CreateImage(parent, name, pos, size, color)` | `GameObject, Image` | 带背景的 UI 对象（`pos` 为 `Vector3`，`size` 为 `Vector2`） |
| `PluginUI.CreateText(parent, name, pos, size, fontSize, color)` | `Text` | 文本（自动补字体，否则不渲染） |
| `PluginUI.CreateContainer(parent, name, pos, size)` | `Transform` | 透明容器 + 关射线；重建列表时只清它的子节点 |
| `PluginUI.CreateButton(parent, name, pos, size, bgColor, label, labelSize, onClick)` | `GameObject, Text, ButtonLike` | 自绘点击按钮（第三个返回值即对象本身，非 UGUI Button） |
| `PluginUI.CreateFloatingButton(canvas, label, pos, onClick)` | `GameObject` | 标准浮动开关按钮（支持拖动，位置被记住） |
| `PluginUI.ClearChildren(transform)` | — | 销毁全部子节点；⚠️ `Object.Destroy` **帧末**才生效，同帧读 `childCount` 会看到旧节点 |
| `PluginUI.BringToFront(obj)` | — | 移到父节点末位（后绘制者在上）；面板展开盖住浮动按钮时保证还能点回去 |
| `PluginUI.RetryEnsure(plugin, maxRetry, delaySec)` | — | 面板/画布自愈链，插件需有 `_root`/`_floatBtn`/`_EnsureCanvasAndBuild()`/`enabled` |
| `PluginUI.EnableClick(obj, fn)` | — | 只点不拖 |
| `PluginUI.EnableDrag(obj, onTap, hitObj, clickOnly)` | — | 拖 + 点；`hitObj` 可用于「拖标题栏移动整块面板」，注册表每帧剪掉已销毁目标 |

### 7.3 面板标准模式（参考 `plugins/PanelPlugin.lua`）

```lua
function XPlugin:OnLoad()
  self._root, self._floatBtn, self._canvas = nil, nil, nil
  self:_EnsureCanvasAndBuild()
  PluginUI.RetryEnsure(self, 100, 3)                    -- 自愈链
  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(c, orig)
    orig(c); self:_EnsureCanvasAndBuild()               -- 战斗 UI 兜底（必然晚于主界面）
  end)
end

function XPlugin:_EnsureCanvasAndBuild()
  if not PluginUI.IsAlive(self._root) then self._root = nil end
  if not PluginUI.IsAlive(self._floatBtn) then self._floatBtn = nil end
  if not PluginUI.IsAlive(self._canvas) then self._canvas = nil end
  if self._canvas == nil then self._canvas = PluginUI.FindCanvas() end
  if self._canvas == nil then PluginUI.RetryEnsure(self, 100, 3); return end
  -- 建浮动按钮 → 建面板（含拖标题栏移动整块面板）
end
```

布局定位统一走 `anchoredPosition3D`；重建列表只清「列表容器」的子节点（**别**在根节点上清到 child 0，会把标题一起删掉）。

---

## 8. 管理器与基础设施 API

| 模块（require 路径） | 对外接口 |
| --- | --- |
| `Plugin/PluginDefs` | 数组；每项 `{ id, name, desc, module }` |
| `Plugin/core/PluginManager` | `PluginManager.me`；`Init()` / `GetPlugin(id)` / `GetError(id)` / `GetAll()` / `SetEnabled(id, bool)->bool`（返回是否真的应用）/ `Reload(id)`（先停后启，绕过入口守卫）/ `CanDisable(id)` / `IsUiEntry(id)` / `UiEntryIds()`（§10.13 入口守卫） |
| `Plugin/core/PluginEntry` | `PluginEntry.init()` / `PluginEntry.dispose()` |
| `Plugin/core/PluginHotfix` | `Hotfix(cls, method, plugin, fn)` / `FixEx(...)` / `Unfix(cls, method, plugin)`（一般经 `BasePlugin` 调用） |
| `Plugin/core/PluginOptions` | 见 §4.3 |
| `Plugin/core/PluginConfigFile` | 见 §6 |
| `Plugin/core/PluginHeartbeat` | `ScheduleAuto()` / `Send()` / `PushState(id, bool)` / `PushOption(id, key, value)` |
| `Plugin/core/AutomationBridge` | `Register(name, fn)` / `RegisterMany(map)` / `ClearHandlers()` / `Handlers()` / `Start()` / `Stop()` / `Configure(opts)` / `Options()` / `SessionId()` / `Capabilities()` / `Recent(n)` / `Log(msg)` / `Get(url, onDone)` / `Delay(sec, fn)` / `Base64Url(s)` / `Sanitize(v)` / `ASYNC`（异步哨兵） |
| `Plugin/ui/PluginUI` | 见 §7.2 |

`PluginManager.me:GetError(id)` 非 `nil` 表示该插件加载/初始化失败，面板会在行内红字显示——排查加载问题时先看它。

---

## 9. 打包、下发与热重载

### 9.1 命令

```bash
pnpm run watch:lua             # 开发首选：监听 lua/plugin/**/*.lua → 自动重打包内置 bundle mod
pnpm run repack:lua            # 手动重打包（merge 插件 + patch DefinedFix）
pnpm run pack:lua-plugins      # 仅打包插件为 mods/plugin_lua.dat（独立调试，不能替代内置 bundle）
pnpm run frida:build           # 重建 hook/build/*.js（frida 注入模式的插件源码表）
```

### 9.2 三条交付链路

| 链路 | 做法 | 适用 |
| --- | --- | --- |
| 重打包内置 bundle | `repack:lua` merge `lua/plugin/**` + 在 DefinedFix 注入**单一引导条目** `Plugin/core/PluginBootHotfixer` | 通用（Windows/Android） |
| 资产内引导 + 私服下发 | 资产里只放几百字节引导，运行时 `GET /plugin/lua` 取自包含 chunk 再 `load()` | 官方包零改动 |
| Frida 注入 Lua VM | `frida:build` 把插件源码表打进 hook，注入运行中的 Lua VM | 调试（不改资产） |

### 9.3 打包约定（改目录/文件名时必读）

- DefinedFix 只注入 `Plugin/core/PluginBootHotfixer` 一条；各业务插件由 `PluginManager` 按 `PluginDefs` 加载。
- 插件资产 m_Name：Windows `gamedata/[uc]lua/Plugin/<相对路径>`；Android 裸相对路径。
- 新资产容器 key 按 require 路径派生（`dyn/gamedata/[uc]lua/plugin/<小写相对路径>.bytes`），
  另补 basename 别名。**basename 必须全局唯一**。
- 内联 prelude 会把**全部** `lua/plugin/**` 注册进 `package.preload["Plugin/<相对路径>"]`（递归）。

---

## 10. 硬契约与陷阱清单

1. **回调必须是对象**：`UISender` 的 `onProceed`、`TimerModel:Delay` 的回调都要 `Event.CreateStatic(fn)`。
   传裸函数 ⇒ `attempt to index a function value` ⇒ 从游戏回调/定时器逸出 ⇒ **整个客户端 abort**。
2. **自建 Overlay 画布**：见 §7.1。否则对象 active 却看不见。
3. **自绘点击/拖拽**：不要用 UGUI `Button`。
4. **`Object.Destroy` 帧末生效**：同帧里旧节点还在、新节点已追加（`childCount` 翻倍、读到旧文本）。
   判「是否生效」读权威状态（`PluginManager.me:GetPlugin(id).enabled`）或下一帧再读。
5. **释放前先卸载**：`OnUnload` 必须清掉自己建的 UI 与订阅；否则 `LuaEnv.Dispose()` 抛异常并 abort（§2.2）。
6. **Unity 对象存活**：场景切换后 Lua 引用仍非 `nil` 但对象已销毁，用 `PluginUI.IsAlive(obj)` 判，否则永远走不到重建分支。
7. **一切游戏调用都要兜底**：hotfix 回调体、`CS.*` 调用、字段访问一律 `pcall`/`xpcall(…, debug.traceback)`，
   失败记 `eutil.LogHotfixError`。版本漂移不可避免。
8. **属性 getter 用 `get_xxx`**；枚举值优先显式逐项 `pcall` 获取（动态索引枚举在部分版本不可用）。
9. **别在热路径查配置**：每帧逻辑读 `self._opts` 缓存，变更回调里更新。
10. **id 一致性**：`PluginDefs.id` = `PluginOptions` 条目 `id` = 插件内 `_ID`。
11. **选项键约束**：≤32 字符、字母/下划线开头（服务端会拒非法键）。
12. **日志用 `CS.Torappu.Lua.Util`**：`eutil.Log(...)` 记正常事件、`eutil.LogHotfixError(...)` 记异常（客户端排查以它为准）。
13. **UI 入口至少要留一个**（2026-09-15 修复的真实故障）：
    提供游戏内面板/浮窗的插件（`PluginDefs` 里 `ui_entry = true`，即 `plugin_panel` / `options_panel`）
    是玩家**在游戏里**启停插件的唯一途径，而浮窗按钮会随插件卸载一起销毁。
    实测：两者都被配置成停用后，游戏内再无任何入口能把它们调出来，只能手改
    `plugin_config.json` 或走服务端。四道防线：

    | 层 | 机制 |
    | --- | --- |
    | 客户端 | `PluginManager:CanDisable(id)`：最后一个启用中的入口不可停用；`SetEnabled` 拒绝后**把实际状态推回服务端**（避免与服务端配置来回打架）；`Init()` 里 `_EnsureUiEntry()` 自愈「配置里入口全关」的死锁 |
    | 管理面板 | 最后一个入口的行渲染成不可点的「常驻」，底部提示写明哪个入口被关了、去哪儿打开 |
    | 选项面板 | 被关掉的是「插件管理面板」时，底部栏出现一键「恢复「插件管理面板」」 |
    | 服务端 | `pluginConfigService.setEnabled` 同样拒绝关掉最后一个入口（`/plugin/config/:id/:value` 返回 `status 1`）；`ui_entry` 从 `PluginDefs.lua` 解析，与 FALLBACK_CATALOG 有守卫比对 |

    ⇒ 新增**面板类**插件时记得标 `ui_entry = true`（否则它被关掉后同样可能把玩家关在门外）；
    只做纯逻辑、没有 UI 的插件**不要**标。`automation_bridge` 的 `plugin.set_enabled` 工具会
    回报 `applied=false` + `note`，被守卫拒绝时不会误报成功。

---

## 11. 调试与自检

```bash
node tmp/check-lua-syntax.mjs          # 全部插件文件语法（17 个，递归）
pnpm run watch:lua                     # 自动重打包
```

设备/服务端侧：

| 现象 / 需求 | 看什么 |
| --- | --- |
| 引导走到哪一步 | 设备 `persistentDataPath/plugin_boot_trace.txt`（`PluginBootHotfixer` 各步落盘） |
| 插件系统是否真的起来 | 服务端日志 `[PluginHeartbeat] 客户端插件系统生效确认: 共 N 个插件…` |
| HTTP 下发模式是否生效 | 设备 `persistentDataPath/plugin_lua_trace.txt`（`DTS_PLUGIN_OK <id>=1 …`） |
| 插件加载失败原因 | 面板行内红字 = `PluginManager.me:GetError(id)` |
| Lua 报错文本 | frida 钩 `XLua.LuaException..ctor(string)`（见 playbook §4） |
| 服务端配置（启停/选项） | `data/plugin/config.json`（`pluginConfigService` 维护） |

新增/移动插件文件后的**回归清单**：语法检查 → `tests/unit/plugin/plugin-module-layout.test.ts` →
`tests/unit/plugin/lua-chunk-builder.test.ts` → `tests/unit/scripts/{repack,pack}-lua-*.test.ts`
→ `pnpm run typecheck:scripts`。

---

## 12. 最小插件模板

`lua/plugin/plugins/MyPlugin.lua`：

```lua
--[[
  MyPlugin.lua —— 一句话说明
  目标方法/字段以真机 dump 校准为准（版本可能漂移），此处已做 pcall 兜底。
--]]
local MyPlugin = Class("MyPlugin", require("Plugin/core/BasePlugin"))
local eutil = CS.Torappu.Lua.Util
local PluginOptions = require("Plugin/core/PluginOptions")

local _ID = "my_plugin"

function MyPlugin:OnLoad()
  -- 选项变更即时重应用（若有选项）
  self._onOption = PluginOptions.Subscribe(function(id)
    if id ~= _ID then return end
    self:_ApplyOptions()
  end)
  self:_ApplyOptions()

  self:Hotfix(CS.Torappu.Battle.UI.UIController, "Awake", function(selfCtrl, orig)
    orig(selfCtrl)
    xpcall(function()
      -- 在这里做正事
    end, debug.traceback)
  end)

  eutil.Log("[MyPlugin] 已启用")
end

function MyPlugin:_ApplyOptions()
  self._opts = { font_size = PluginOptions:Get(_ID, "font_size") }
end

function MyPlugin:OnUnload()
  if self._onOption ~= nil then
    PluginOptions.Unsubscribe(self._onOption)
    self._onOption = nil
  end
  self._opts = nil
  eutil.Log("[MyPlugin] 已停用")
end

return MyPlugin
```

并在 `PluginDefs.lua` 追加：

```lua
{
  id = "my_plugin",
  name = "我的插件",
  desc = "一句话描述",
  module = "Plugin/plugins/MyPlugin",
},
```

---

## 13. 相关文档与技能

| 主题 | 位置 |
| --- | --- |
| 使用与真机验证（打包/下发/验收步骤） | `docs/lua-plugins-guide.md` |
| 自动化桥（MCP 驱动客户端做 e2e：协议/工具/验证清单） | `docs/mcp-automation-2026-09-15.md` |
| 契约速记 + UI 规范（技能） | `skills/arknights-lua-plugin-contracts/SKILL.md` |
| MuMu + Frida 环境/探针/长会话纪律（技能） | `skills/arknights-mumu-frida-debug/SKILL.md` |
| Lua 资产签名与重签名（技能） | `skills/arknights-lua-asset-signing/SKILL.md` |
| 插件浮窗验证 + 两个契约型致命 bug | `docs/plugin-ui-verify-2026-09-14.md` |
| frida 注入 Lua VM 全流程 | `docs/lua-plugin-frida-injection-2026-09-14.md` |
| 加载链路还原（C#→Lua、资产寻址） | `docs/lua-load-chain-reconstructed-2026-09-14.md` |
