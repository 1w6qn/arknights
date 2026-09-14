# 插件浮窗验证 + 两个「契约型」致命 bug 的定位与修复（2026-09-14）

目标：验证插件的**浮窗/面板**（`plugin_panel` / `options_panel`）在真机上真的建出来、看得见、能开合。
过程中顺带定位并修掉了两个会让**整个客户端 abort** 的契约型 bug。

## 0. 结论速览

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 浮窗按钮 | ✅ 已建、`activeInHierarchy=true`、父节点=自建 overlay 画布 | 探针 `btn_name=插件Toggle(Clone) btn_hier=true btn_parent=DoctorateTsPluginCanvas` |
| 面板 | ✅ 已建、`activeInHierarchy=true`、**6 行**（每个插件一行） | 探针 `root_name=PluginPanel(Clone) root_hier=true rows=6` |
| 可见性 | ✅ **截屏里能扫到**（不是只在层级里 active） | 面板开：蓝 `#4D99FF`（开关色）**10021 px**、区域 `[818,33]-[1890,705]`；面板关：只剩游戏自身的 499 px |
| 开合 | ✅ `TogglePanel()` 生效 | 探针 `after_open=false` 与像素同时变化 |
| 客户端稳定性 | ✅ 不再 abort（本轮修复前每轮必崩） | `CRASH: 0`（修复后连续 3 轮） |

## 1. 修掉的致命 bug ①：`UISender` 回调必须是「对象」

```
XLua.LuaException: Base/Network/UISender:131: attempt to index a function value (field 'onProceed')
  → 从 HotFixes/...(_HandleGetResponse) 逸出 → 未捕获托管异常 → 进程 abort
```
游戏侧 `UISender:ExportOnProceed` 是 `callback.onProceed:Call(response)`（`data/[uc]lua/Base/Network/UISender.lua:131`），
官方 Lua 一律传 `Event.Create(self, fn)`。我们插件传了**裸函数** → 抛异常 → abort。
**修复**：`lua/plugin/PluginHeartbeat.lua` 的 `_SendWithCallback` 用 `Event.CreateStatic(fn)` 包装。
（顺带说明：这也解释了为什么"插件心跳"一直只有发送、回调从未真正执行。）

## 2. 修掉的致命 bug ②：`TimerModel` 回调同样必须是「对象」

```
XLua.LuaException: Base/Timer/Timer:52: attempt to index a function value (field 'm_call')
stack traceback:
  Base/Timer/Timer:52: in method 'Update'
  Base/Timer/TimerModel:111: in method 'Update'
  entry.lua:103: in function <entry.lua:102>
```
`Timer:Update` 是 `self.m_call:Call()`（`data/[uc]lua/Timer.lua:52`），而 `TimerModel:Delay(delay, cb)` 把 cb 直接存成 `m_call`。
我们传裸函数 → 同一类异常 → 从 `TimerModel:Update` 逸出 → **abort**。
**修复**：`lua/plugin/PluginUI.lua`（自愈链的 `Delay`，2 处）与 `lua/plugin/PluginHeartbeat.lua`（重试链，2 处）
统一经 `_AsTimerCallback(fn)`（=`Event.CreateStatic`）包装；frida payload 里的延时复核同样处理。

> 这两个 bug 的定位工具（已并入 `hook/il2cpp-client-redirect.ts`，可复用）：
> `XLua.LuaException..ctor(string)` 抓异常文本、`XLua.LuaEnv.ThrowExceptionFromError` 抓"Lua 错误转托管异常"的时刻、
> `XLua.LuaEnv.Dispose` / `LuaManager._DoDisposeLuaEnv` 抓释放路径、`UnityEngine.Debug.LogException` 抓异常日志。
> 没有它们只能看到 `terminating with uncaught exception of type Il2CppExceptionWrapper`，无从下手。

## 3. 修掉的可观测性 bug ③：面板挂在「不可见」的画布上

修复 ①②后客户端稳定了，但探针显示 `canvas_mode=ScreenSpaceCamera`、`scene=hot_update`：
`PluginUI.FindCanvas()` 在找不到 `UI/Main/LuaUIRoot`（非战斗场景）时退回"任意画布"，拿到的是相机空间画布
（相机为空/被游戏 UI 遮挡）⇒ 对象 `activeInHierarchy=true` 却**屏幕上看不见**（截屏扫不到任何面板像素）。
**修复**：`PluginUI.FindCanvas()` 改为**自建 `ScreenSpaceOverlay` 画布**
（`DoctorateTsPluginCanvas`，`sortingOrder=30000`，`DontDestroyOnLoad`），与游戏 UI 的渲染模式/相机无关。
修完后截屏立刻能扫到面板开关的蓝色像素。

## 4. 复跑与验证命令

```bash
# 私服 + 中继就绪后（客户端缓存里是我们的重签名 bundle）
python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js \
  --java-script "" --pubkey-mode oursonly --duration 80 > tmp/canvas-run.log 2>&1
# 看探针
grep "plugin-ui" tmp/canvas-run.log
# 看像素（面板开/关各截一帧）
adb exec-out screencap > tmp/shot.raw
node -e "<按 #4D99FF 容差 34 扫描 tmp/shot.raw>"     # 面板开 ≈ 1e4 px，面板关 ≈ 5e2 px（游戏自身元素）
```

`--pubkey-mode oursonly` 的含义：**只换公钥、不注入 Lua payload** —— 插件系统完全由
「资产内引导 + 私服 `GET /plugin/lua`」交付，frida 只做换公钥与观测（可视为"半免 frida"形态）。

## 5. 遗留

- 插件里仍有多处 hotfix 目标在 2.7.71 上不存在（`[BasePlugin] xxx Hotfix(Attach/Awake/Update) 失败: 目标方法不存在（版本漂移?）`），
  战斗类插件的实际效果因此未生效；可用 `tmp/dts-dump` 的类/方法/RVA 清单逐个对准。
- `scene=hot_update`：客户端当时停在热更/登录场景，浮窗已在其中可见；登录进主界面后应仍在（画布是自建 +
  `DontDestroyOnLoad`），但未单独复验。

## 6. 位置调整 + 实际功能验证（同日续作）

### 6.1 位置

| 控件 | 旧位置（居中锚点） | 新位置 | 屏幕坐标（1920×1080） |
| --- | --- | --- | --- |
| 浮窗按钮 `插件Toggle(Clone)` | `(-300,-160)`（在面板区域里，面板一开就被盖住） | **`(-80,-490)`** 右下角，右/下各留 20px | `btn_screen=880,50` |
| 面板 `PluginPanel(Clone)` | `(-260,0)` | **`(0,20)`** 屏幕居中略偏上 | `root_screen=960,560` |

⇒ 两者不再互相遮挡（面板仍会在打开时 `BringToFront` 按钮，保证能点回去）。

### 6.2 实际功能：点开关 → 状态翻转 → 配置持久化（已通过）

探针新增 `invokeRow` 阶段（`probePluginUi(false, true)`）：直接 `Button.onClick:Invoke()` 等价于用户点第一行的「切换」。

```
row0_before=ON   p0_id=enemy_hp  p0_before=true    ← 点击前
row0_invoked=true                                  ← onClick:Invoke() 成功
p0_after=false                                     ← 权威状态（PluginManager:GetPlugin(id).enabled）已翻转
```

设备侧配置落盘（点击前文件不存在 = 默认全启用；点击后）：

```json
{"enabled":{"enemy_hp":false,"plugin_panel":true,"battle_assist":true,
            "enemy_info":true,"network_redirect":true,"options_panel":true}}
```

⇒ **UI 点击 → 插件启停 → 写 `plugin_config.json`** 三链全部打通，且全程 `CRASH: 0`。

两点需说明（都不是 bug）：

- `row0_after=ON` 且 `rows=12`：Unity 的 `Object.Destroy` 是**帧末延迟销毁**，同一帧里旧行还在、新行已追加，
  所以"同一帧读第 0 行文本"会读到旧行；权威状态（`p0_after=false`）与配置文件都已正确翻转，下一帧行数回到 6。
- 服务端同步 `GET /plugin/config/enemy_hp/0` 本轮**没有发出**：`PluginHeartbeat.PushState` 里有
  `_SenderReady()` 守卫（设计如此），当前客户端还停在 `hot_update` 场景、网络发送器未就绪 ⇒ 静默跳过。
  等进入登录后/主界面会正常推送（探针里也能看到 `scene` 变化）。

### 6.3 复跑

```bash
python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js \
  --java-script "" --pubkey-mode oursonly --duration 75 > tmp/func-run4.log 2>&1
grep "plugin-ui" tmp/func-run4.log            # 20s 状态 / 45s 点开关 / 75s 开合面板
adb shell cat /sdcard/Android/data/com.hypergryph.arknights/files/plugin_config.json
```

## 7. 点击穿透修复 + 拖拽支持（同日续作，已用真实 input 事件验收）

### 7.1 现象与根因

现象：浮窗按钮"点不到，点到的是后面的游戏 UI"。
根因：按钮原本走 UGUI（`Image` + `Button`）依赖画布 `GraphicRaycaster`/事件系统命中；
挂在我们自建的 Overlay 画布上时命中不稳定 ⇒ 点击穿透。而且 UGUI `Button` 天然不支持拖动。

### 7.2 改法：自己读输入，不再依赖 UGUI 射线

`lua/plugin/PluginUI.lua` 新增 `PluginUI.EnableDrag(obj, onTap)`：

- 逐帧驱动挂在**确定的每帧入口** `CS.Torappu.GlobalInitializerAndUpdater.Update`（`xlua.hotfix`，只装一次）；
- 每帧读 `Input.GetMouseButton(0)` + `Input.mousePosition`；
- 按下时用 `RectTransformUtility.RectangleContainsScreenPoint(rect, pos, nil)` 判断是否落在按钮内（Overlay 画布相机传 `nil`）；
- 按住移动 **> 10px** ⇒ 判定为拖动，直接改 `anchoredPosition`（按钮跟着手指走）；
- 松手且未超过阈值 ⇒ 回调（打开/关闭面板）。
- `CreateFloatingButton` 不再加 `Button` 组件，改用 `EnableDrag`。

### 7.3 真实 input 验收（`adb shell input`，不是自测调用）

```
探针#1（点击前）: open=false  btn_rect=-80,-490  btn_screen=880,50
adb shell input tap 880 1030                 # 屏幕坐标：按钮中心（top-down y=1080-50）
探针#2（点击后）: open=true   ← 点击命中，面板被真实点开（此前会穿透到游戏 UI）

adb shell input swipe 880 1030 400 700 500   # 从按钮拖到 (400,700)
探针#3（拖动后）: btn_rect=-528,-182  btn_screen=432,358
                 rows=6（回到 6：帧末销毁旧行，印证 §6.2 的时序说明）
                 ← 按钮跟随手指移动约 (-480,+312)，且**拖动没有误触发点击**
```
全程 `CRASH: 0`。

### 7.4 复跑

```bash
python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js \
  --java-script "" --pubkey-mode oursonly --duration 115 > tmp/click-run.log 2>&1 &
sleep 36; adb shell input tap 880 1030      # 按钮中心（按探针报的 btn_screen 换算 top-down y）
sleep 30; adb shell input swipe 880 1030 400 700 500
grep "plugin-ui" tmp/click-run.log
```

> 探针排程也顺手修了一处真实缺陷：原来挂在 `LuaManager._DoUpdate` 的 onEnter 上，
> 而该方法在**某些客户端状态**下并不是每帧调用 ⇒ 探针整段错过（实测同一脚本时有时无）。
> 现在改挂 `GlobalInitializerAndUpdater.Update`，并用 `ui-probe-scheduled` / `ui-probe-enter`
> 两级日志自证"排上了、也进来了"。

## 8. 二级浮窗（面板行开关 / 选项面板）点击修复（同日续作，已用真实 input 验收）

### 8.1 根因

一级的浮窗按钮已改成自绘点击，但**二级窗口里的按钮仍在用 UGUI `Button`**：

- `PluginUI.CreateButton`（选项面板的 tab / 开关 / `+` `-` / `<` `>` / 重置 全部经它创建）；
- `PanelPlugin` 行内「切换」按钮（`btnObj:AddComponent(typeof(UGUI.Button))`）。

它们挂在自建 Overlay 画布上同样会**点击穿透** ⇒ 「二级浮窗无法点击」。

### 8.2 改法（两个 choke point 一次改完）

- `PluginUI.CreateButton` → 去掉 `UGUI.Button`，改走 `PluginUI.EnableClick(obj, fn)`；
- `PanelPlugin` 行内「切换」→ 同样改 `PluginUI.EnableClick`；
- `PluginUI.EnableDrag(obj, onTap, hitObj, clickOnly)` 扩展：支持**命中区与移动对象分离**（拖标题栏移动整块面板）、`clickOnly`（只点击不移动）；
- `_DragTick` 每帧**剪掉已销毁目标**（行/面板会被 `Refresh` 重建，避免注册表无限增长）；
- 面板与选项面板都支持**拖标题栏移动整块面板**。

### 8.3 真实 input 验收

```
探针#1  open=false  row0_toggle_screen=1110,738  opt_btn_screen=660,450  opt_root_active=false
adb shell input tap 880 1030     # 一级：浮窗按钮（右下角）
探针#2  open=true                                        ← 面板被点开
adb shell input tap 1110 342     # 二级：行内「切换」按钮（top-down y=1080-738）
        → 设备 plugin_config.json 出现 {"enabled":{"enemy_hp":false, ...}}
          （本轮开始前已删除该文件，且探针里的合成 invoke 已停用 =>
            这次翻转确实来自真实点击）
adb shell input tap 660 630      # 二级：选项面板的浮窗按钮（top-down y=1080-450）
探针#3  opt_root_active=true  opt_open=true               ← 选项面板被真实点开
```
全程 `CRASH: 0`；`row0_invoked=selfdraw` 说明探针没有再走 UGUI 合成点击。

### 8.4 复跑（坐标以探针实时输出为准）

```bash
python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js \
  --java-script "" --pubkey-mode oursonly --duration 145 > tmp/level2b-run.log 2>&1 &
sleep 36; adb shell input tap 880 1030     # 开面板
sleep 16; adb shell input tap 1110 342     # 行开关（探针 row0_toggle_screen，y 需 top-down 换算）
sleep 20; adb shell input tap 660 630      # 选项面板按钮（探针 opt_btn_screen）
grep "plugin-ui" tmp/level2b-run.log
adb shell cat /sdcard/Android/data/com.hypergryph.arknights/files/plugin_config.json
```
