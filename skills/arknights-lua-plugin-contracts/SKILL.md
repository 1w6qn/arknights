---
name: arknights-lua-plugin-contracts
description: 明日方舟客户端 Lua 侧的硬契约与 UI 实现规范（回调必须是 Event 对象、自建 Overlay 画布、自绘点击/拖拽、插件重载守卫）；用于写/改游戏内 Lua 插件或排查"插件把客户端打崩/点不动/看不见"。
---

# 游戏 Lua 插件：契约与 UI 规范

## 何时用
写或改 `lua/plugin/**/*.lua`（游戏内插件：业务插件在 `plugins/`、基础设施在 `core/`、UI 在 `ui/`），
或遇到：插件加载后客户端 abort、按钮点不到、控件 activeInHierarchy=true 却看不见、拖动不支持。

## 目录与寻址约定（2026-09-14 模块化）
- `lua/plugin/PluginDefs.lua` 是唯一注册表；`module` = require 路径 = `Plugin/<相对路径去 .lua>`（如 `Plugin/plugins/EnemyHpPlugin`）。
- 客户端按 require 路径推导容器 key（`dyn/gamedata/[uc]lua/<小写相对路径>.bytes`）；`repack-lua-bundle` 同时登记 **require 路径 key + basename 别名 key**，兼容 basename 归一化口径 ⇒ **basename 全局唯一**。
- 新增/移动文件后同步 `tests/unit/plugin/plugin-module-layout.test.ts` 守卫与 `app/ops/plugin/plugin-catalog.ts` 的 `FALLBACK_CATALOG`（后者由守卫比对，防双份硬编码漂移）。

## 契约 1：回调必须是「对象」，不能是裸函数
游戏侧凡是 `x:Call(...)` 的地方，传进去的必须是带 `Call` 方法的对象 —— 官方 Lua 一律用
`Event.Create(callee, fn)` / `Event.CreateStatic(fn)`（`data/[uc]lua/Event.lua`）。

| 位置 | 正确写法 |
| --- | --- |
| `UISender.me:SendGet(url, nil, cfg)` 的 `cfg.onProceed` | `Event.CreateStatic(function(resp) ... end)`；错传裸函数 ⇒ `attempt to index a function value (field 'onProceed')` → **abort** |
| `TimerModel.me:Delay(sec, cb)` 的 `cb`（`Timer:52` 是 `self.m_call:Call()`） | `Event.CreateStatic(fn)`；错传裸函数 ⇒ `attempt to index a function value (field 'm_call')` → **abort** |

兜底写法（两处都在用）：
```lua
local function _AsEvent(fn)
  local cb = fn
  pcall(function() if Event ~= nil and Event.CreateStatic ~= nil then cb = Event.CreateStatic(fn) end end)
  return cb
end
```

**响应体形态**：`UISender` 回调拿到的可能是 `{ text = <原始响应体> }`（不是直接的表）；
要先取 `.text`，再 `require("rapidjson").decode(...)`，最后在解出的表里找字段。

## 契约 2：UI 必须自建 Overlay 画布
- 不要复用游戏画布：`hot_update` 等非战斗场景里 `UI/Main/LuaUIRoot` 不存在，
  退回"任意画布"会拿到 `ScreenSpaceCamera`（相机空/被遮挡）⇒ 对象 active 但**屏幕上看不见**。
- 正确做法：自建 `ScreenSpaceOverlay` 画布（`sortingOrder=30000`，`DontDestroyOnLoad`）。

## 契约 3：交互用自绘输入，不要 UGUI Button
自建 Overlay 画布上 UGUI 命中不稳定 ⇒ **点击穿透**（"点不到，只能点到后面的"），且 `Button` 不能拖。

实现（`lua/plugin/ui/PluginUI.lua` 的 `EnableDrag/EnableClick`）：
- 逐帧驱动挂 **`CS.Torappu.GlobalInitializerAndUpdater.Update`**（`xlua.hotfix`，只装一次）；
- 每帧读 `Input.GetMouseButton(0)` + `Input.mousePosition`；
- 按下时 `RectTransformUtility.RectangleContainsScreenPoint(rect, Vector2(mp.x,mp.y), nil)`
  （Overlay 画布相机传 `nil`）；
- 位移 > 10px ⇒ 拖动；否则松手算点击（带阈值，拖动不会误触发点击）；
- **命中区可与移动对象分离**（拖标题栏移动整块面板）；
- 每帧**剪掉已销毁目标**（面板/行会被 `Refresh` 重建，否则注册表无限增长）。

## 契约 4：重载/释放前先卸载
插件的 hotfix 会留下 C# 持有的回调；游戏 `LuaManager.ReloadScripts()` → `_DoDisposeLuaEnv()` →
`LuaEnv.Dispose()` 时 xLua 会抛 `InvalidOperationException: try to dispose a LuaEnv with C# callback!` → abort。
对策：`PluginEntry.init()` 里热修 `LuaManager.ReloadScripts`，先 `PluginEntry.dispose()`（各插件
经 `PluginHotfix` 撤销自己的 hotfix → 释放回调），再撤掉包装器、最后调原实现。

## 时序与陷阱
- `Object.Destroy` **帧末**才生效 ⇒ 同一帧里旧行还在、新行已追加（`childCount` 翻倍、读到旧文本）；
  判"是否生效"请读**权威状态**（`PluginManager.me:GetPlugin(id).enabled`）或下一帧再读。
- 引导阶段 `TimerModel.me` 可能还没就绪；`UISender` 也没就绪 —— 所有发送/定时都要"未就绪就跳过、之后补排"。
- 官方 Lua 会 hotfix `LuaManager` 的多个方法（C# 里满屏 `__Hotfix0_*`），
  挂在原方法体上的 frida 钩子可能不触发；要挂就挂 xLua 自己的入口（如 `LuaEnv.Dispose`）。
- 2.7.71 上不少 hotfix 目标已改名/移位（日志 `目标方法不存在（版本漂移?）: Attach/Awake/Update`）；
  用 `tmp/dts-dump` 的类/方法/RVA 表核对。

## 自检
```bash
node tmp/check-lua-syntax.mjs        # 全部插件文件（16 个，递归 core/ ui/ plugins/）语法
grep "plugin-ui" tmp/<run>.log       # 探针：activeInHierarchy / rows / 屏幕坐标
adb shell cat /sdcard/Android/data/com.hypergryph.arknights/files/plugin_config.json
```

## 相关文档
`docs/lua-plugin-dev-reference.md`（**插件开发参考**：目录/注册、生命周期、补丁与选项 API、PluginUI 工厂、心跳协议、陷阱清单、最小模板）、
`docs/lua-plugins-guide.md`（打包下发与真机验收）、
`docs/plugin-ui-verify-2026-09-14.md`（浮窗验证全过程与真实 input 验收数据）、
`docs/lua-plugin-frida-injection-2026-09-14.md`（插件系统如何被注入/交付）。
