# Lua 插件系统在官方客户端上跑起来了（frida 侧注入运行中的 Lua VM）

2026-09-14。目标里最后一块拼图：**不改任何游戏资产**，让 `lua/plugin/` 这套插件系统在官方包上正常启动，
并且整个过程可由 frida 观测。

## 1. 为什么走注入而不是改 bundle

`docs/lua-load-chain-reconstructed-2026-09-14.md` 的 C1/C2 对照实验已经证死：客户端**拒绝任何被我们
重新加密的 Lua 资产**（连「明文逐字节相同、只换 IV」都让 `_CustomLoader` 返回 null；官方密文则整条
hotfix 链正常）。所以运行代码只能从**运行中的 Lua VM** 进去。

## 2. 注入方案（三个关键点全部来自 dump/trace 实测）

见 `docs/il2cpp-dump-trace-2026-09-14.md` 的 RVA 表与调用树。

1. **选对重载**：`XLua.LuaEnv::DoString` 有**两个都是 3 参数**的重载
   （`System.String` 版 `0x0595b788` / `System.Byte[]` 版 `0x0595b944`）。桥的 `method("DoString")`
   取到哪个不确定——之前的 `incorrect parameter types` 就是这么来的。必须显式
   `.overload("System.String", "System.String", "XLua.LuaTable")`，
   第三个参数（env）传空指针常量 `NULL`（传 JS `null` 同样报类型错）。
2. **选对时机**：`LuaManager._DoLoadEntryScript` 返回（`entry` + hotfix 链跑完、Lua 栈退空、游戏侧
   `Class` 等全局已就绪）之后，在 `LuaManager._DoUpdate` 的 **onEnter** 里调用——Unity Update 循环驱动，
   游戏主线程、不在任何 Lua 调用栈内。**不能在 `_CustomLoader` 里注入**：它是 xLua searcher 的回调，
   此刻正在 `require`，重入 Lua VM 会破坏状态（旧实现挂在第 2 次 `_CustomLoader`，属于隐患）。
   兜底：`_DoLoadEntryScript` 迟迟没等到时，900 帧后仍尝试。
3. **payload 自带源码**：插件 12 个模块（59 KB）在**构建期**由 `scripts/build-frida-hook.mjs`
   从 `lua/plugin/*.lua` 生成为 `hook/build/plugin-lua.js`（键名 = require 路径，如 `Plugin/PluginDefs`），
   esbuild 直接 bundle 进 hook。运行期 payload 做三件事：
   - 装一个只认 `Plugin/*` 的 searcher（`table.insert(package.searchers, 1, …)`；找不到时返回错误串，
     Lua 会继续找下一个 searcher）；
   - 按插件自己的引导顺序 require：`_G.PluginDefs` → `_G.PluginManager` → `_G.PluginEntry` →
     `_G.PluginHeartbeat`（与 `PluginBootHotfixer.lua` 的 `_BootstrapGlobals` 一致，全局名是插件内部依赖）；
   - `PluginEntry.init()` + `PluginHeartbeat.ScheduleAuto()`，**并 `return` 自检结论字符串**
     ——经 `DoString` 的返回值（`System.Object[]`，长度在 `+0x18`、元素在 `+0x20`）回传，不依赖日志/文件即可判定。

## 3. 验收证据（三条独立链）

1. **JS 侧自检**（`tmp/inject-final.log`）：
   ```
   {'t': 'entry-script-done', 'frames': 0}
   {'t': 'lua-inject', 'ok': True, 'attempt': 1, 'payloadBytes': 51415, 'retCount': 1,
    'ret': 'DTS_PLUGIN_OK enemy_hp=1 enemy_info=1 battle_assist=1 plugin_panel=1 network_redirect=1'}
   ```
   5 个插件全部装载（`=1`）。
2. **Lua 侧落盘**：设备 `<persistentDataPath>/frida_plugin_trace.txt` = `[DTS] DTS_PLUGIN_OK`
   ——证明注入的 chunk 能调 `CS.*` 绑定并写文件。
3. **端到端（最强）**：私服日志自己打印了插件的生效确认，并收到心跳请求：
   ```
   [PluginHeartbeat] 客户端插件系统生效确认: 共 5 个插件，启用 5 个
     （enemy_hp=ON, enemy_info=ON, battle_assist=ON, plugin_panel=ON, network_redirect=ON）
   ::ffff:172.30.32.1 - GET /plugin/heartbeat HTTP/1.1 200 405 - 8.361 ms
   ```

## 4. 怎么复跑

```bash
# 前置：私服(8443) + 4 条 Windows 中继(27043/27098/8443/8543) + adb forward 27042/27099 + 设备 frida-server
node scripts/build-frida-hook.mjs il2cpp-client-redirect     # 顺带生成 hook/build/plugin-lua.js
python3 scripts/frida-mumu-arm64.py \
  --script hook/build/il2cpp-client-redirect.js --java-script "" \
  --duration 90 --max-output-bytes 300000 > tmp/inject-final.log 2>&1
```
判断：日志里出现 `'t': 'lua-inject', 'ok': True` 且 `ret` 里 5 个插件 `=1`；私服日志出现
`/plugin/heartbeat 200`。改了 `lua/plugin/*.lua` 只需重新 build（无需改 hook）。

## 5. 顺手发现的一个插件缺陷（待修）

`Torappu.FileUtil.WriteToFile(content, path, useRetry)` 的第三个参数是 **useRetry（重试）而不是 append**
（dump 实测签名），所以：
- `PluginBootHotfixer.lua#_Trace` 想「追加」引导标记，实际每次**覆盖**——`plugin_boot_trace.txt` 只会留最后一行
  （用作「走到哪一步」的末态判断还行，历史会丢）；
- `PluginManager.lua#_SaveConfig` 传 `false` 是「不重试」，语义正确，无影响。

修法建议：`_Trace` 改为 Lua 侧累积（`local lines = {}`）或写入带序号的多文件。

## 6. 现状与后续

- **已达成**：官方包（未被重签名 / 未改包名，因此不触发 ACE）+ frida 运行时注入 ⇒ 插件系统正常启动、
  5/5 启用、心跳打通私服 `/plugin/heartbeat`，且注入/观测全流程可复跑。
- 待验证（需要真实交互，本轮未做）：插件面板 UI 的可见性、战斗类插件（`enemy_hp` / `enemy_info` /
  `battle_assist`）在战斗内的实际效果、`plugin_panel` 的开关持久化（`plugin_config.json` 会在首次
  `SetEnabled` 时生成，本轮未产生属预期）。
- 可选增强：给 hook 加一个「只查询不注入」模式（payload 只 `return` 插件状态），把 frida 变成随时可用的
  插件状态探针。
