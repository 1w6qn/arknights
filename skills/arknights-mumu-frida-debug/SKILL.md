---
name: arknights-mumu-frida-debug
description: 在 MuMu 上用 Frida 调试明日方舟（x86_64 ART + ARM64 Houdini 游戏、官方包不改 APK）的完整环境、管线、探针与诊断钩子；含一键启动 start-mumu.cmd（模拟器+私服+中继+adb+hook+注入）、中继/hosts/reverse 自检、换公钥模式、无眼 UI 验证与长会话操作纪律。
---

# MuMu + Frida 调试明日方舟（环境与管线）

## 何时用
需要在这台 MuMu 上：起私服并让客户端连过来、接 frida 进 ARM64 il2cpp、跑/验 Lua 插件、
或排查"客户端 abort 但只打印 `Il2CppExceptionWrapper`"这类问题。

## 硬约束（先记住，能省几小时）
- 进程是 **x86_64 ART**，游戏逻辑是 **ARM64（Houdini 翻译）** ⇒ x86_64 agent 看不到 ARM64 模块，
  **必须**用 ARM64 frida-gadget（`Java.perform` → `Runtime.load0(appClass, gadgetPath)`）。
- **任何重签名/改包名后的 APK 都会被 ACE（`libtersafe2.so`）在 ~10s 内 SIGSEGV 击杀**（与包名无关）。
  所以走"官方包 + 运行时改造"；不要 hook/禁用/欺骗 ACE（红线），也不要靠它绕过。
- 卸载重装会换 uid（`u0_a36`→`u0_a39`）；恢复 `Android/data/<pkg>/files` 前必须
  `chown -R u0_a<N>:ext_data_rw`，否则应用写不了自己的目录（会报"存储空间不足"之类假错）。

## 一键启动（首选，2026-09-15 起）
Windows 双击 `start-mumu.cmd`（等价：WSL 里 `pnpm run mumu`），一次做完
「起 MuMu → 起私服 → 起 4 条中继 → adb forward/reverse → 增量构建 hook → 冷启动客户端 → 双 agent 注入」：
```cmd
start-mumu.cmd                 :: 全链路（默认注入 600s，Ctrl+C 结束）
start-mumu.cmd --dry-run       :: 只自检打印计划，不起任何进程
start-mumu.cmd --no-frida      :: 只起基础设施（模拟器+私服+中继+adb+hook 构建）
start-mumu.cmd --duration 120 --pubkey-mode ours
```
- 文件：`scripts/mumu-boot.mjs`（Windows 编排）/ `scripts/mumu-relay.mjs`（4 条中继，状态文件 + `--check`）/
  `scripts/mumu-start.sh`（WSL 主体）。日志：`tmp/mumu/server.log`、`tmp/mumu/frida.log`。
- 中继自己起：**别再用 `tmp/port-relay.mjs` 起 4 个进程**（脚本会认领端口；WSL 换 IP 时它会自动重启中继）。
- 上方"开工自检/中继/启动管线"三段仍可用于手工排查；只做观测时用 `--no-frida` 后手动跑 python 管线。
- 客户端 abort 时脚本会在结尾提示 `grep -n CRASH tmp/mumu/frida.log` 与设备
  `Android/data/com.hypergryph.arknights/files/tombstone_*`（abort 现场只埋在 tombstone）。

## 开工自检
```bash
ADB="/mnt/d/Program Files/YXArkNights-12.0/shell/adb.exe"
for p in 27043 27098 8443; do timeout 3 bash -c "</dev/tcp/172.30.32.1/$p" 2>/dev/null && echo "$p up" || echo "$p DOWN"; done
timeout 3 curl -s -o /dev/null -w "server=%{http_code}\n" http://127.0.0.1:8443/gm/
"$ADB" reverse --list; "$ADB" shell "ps -A | grep -c frida-server"
```
中继（Windows 侧，由 WSL 启动；**仅在没有一键脚本时的兜底**）：
```bash
WSL_IP=$(hostname -I | awk '{print $1}')
"/mnt/c/Program Files/nodejs/node.exe" scripts/mumu-relay.mjs "$WSL_IP"   # 一条进程起全 4 条
```
（用 `run_in_background` 跑，让作业托住中继；工具调用之间后台作业会被清掉。`tmp/port-relay.mjs` 是单口老脚本，
一键链路里已被 `scripts/mumu-relay.mjs` 取代。）

## 启动管线
```bash
node scripts/build-frida-hook.mjs il2cpp-client-redirect     # 改 hook 后必须重建
python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js \
  --java-script "" --pubkey-mode oursonly --duration 120 > tmp/run.log 2>&1
```
`--pubkey-mode`：`asis` 不动公钥 / `ours` 换公钥+注入 payload / **`oursonly` 只换公钥**（插件由资产+HTTP 交付）/
`flip`、`ab`（公钥端序 A/B）。

## 诊断钩子（排 abort 的标准动作）
只看到 `terminating with uncaught exception of type Il2CppExceptionWrapper` 时，挂这些（`hook/il2cpp-client-redirect.ts` 已内置）：
- `XLua.LuaException..ctor(string)` → **直接拿 Lua 错误文本 + traceback（最有用）**
- `XLua.LuaEnv.ThrowExceptionFromError(int)` → 错误转托管异常的时刻 + C# 栈
- `XLua.LuaEnv.Dispose` / `LuaManager._DoDisposeLuaEnv` → 释放路径（官方 Lua 会 hotfix `LuaManager`，
  挂在原方法体上**可能不触发**）
- `UnityEngine.Debug.LogException` → 异常日志（没走这里说明是 il2cpp 直接 abort）

## 无眼验证 UI（不需要截图也能判）
1. 探针：`_root/_floatBtn.activeInHierarchy`、行数、`RectTransformUtility.WorldToScreenPoint` 屏幕坐标、
   `Canvas.renderMode/sortingOrder`。**排程要挂 `GlobalInitializerAndUpdater.Update`**
   （`LuaManager._DoUpdate` 在部分客户端状态下不是每帧调用，会整段错过）。
2. 真实事件：`adb shell input tap <x> <y>`（**top-down**；探针给的是 Unity bottom-up，`y=1080-y`）、
   `adb shell input swipe x1 y1 x2 y2 500`。
3. 像素核对：`adb exec-out screencap > f.raw`（头 16B + RGBA，先算 `off = len - w*h*4`），
   扫 `#4D99FF`（面板开关色）：开 ≈1e4 px / 关 ≈5e2 px。

## 操作纪律
- 输出有界：`--max-output-bytes`（2MB）、单行 ≤2000 字符、日志重定向到文件后用 `tail -c`/`grep -c` 读。
- 同时只留必要进程（私服 1 + 中继 1 组）；长调试换新会话。
- 每次改动留撤销手段（`.disabled` 产物、`.bak`、`git checkout --`）。

## 相关文档
`docs/frida-mumu-lua-plugin-playbook-2026-09-14.md`（总纲）、`docs/frida-mumu-il2cpp-2026-09-13.md`（管线细节）、
`docs/il2cpp-dump-trace-2026-09-14.md`（dump/trace 与 RVA 表）。
