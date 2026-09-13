# 免 root Android 注入链（开发/抓包工具链）

- 日期：2026-09-13　配套：`docs/obs-suite-analysis-2026-09-13.md`、`docs/apk-security-audit.md`
- 定位：**仅开发/抓包用途的工具链记录**，不进入产品运行路径，不改变私服默认行为。
- 来源：`reference/obs/OpenBachelorC-master.zip`（PC Android 脚本 + adb 编排，下称 **C**）、
  `reference/obs/OpenBachelorG-master.zip`（frida-gadget 注入，下称 **G**）。
  抽包命令见 `docs/obs-可借鉴清单-2026-09-13.md` 附录 B。

## 0. 本仓现状（已有 / 缺什么）

| 能力 | 本仓现有 | 缺口 |
| --- | --- | --- |
| PC Frida 注入 / dump | `hook/main.ts`（活跃 SDK URL hook + `Il2Cpp.dump("d.cs")`）、`scripts/frida-observe.ps1`、编译产物 `2221.js` | — |
| APK 内 Lua 注入 | `scripts/apk-lua.ts`（往官方 APK 注入 Lua bundle，`:457-468` 自动开 `assets.enableMods`）、`scripts/apk-audit.ts` | — |
| 抓包 | `scripts/proxy-harness.ts`（官服代理，落统一抓包存储 `tmp/capture/`） | — |
| **免 root 真机/模拟器 + frida-gadget** | 无 | 即本文档 |

前提：设备已开 USB 调试、`adb` 在 PATH；本仓地址记为 `<PC_IP>:8443`（HTTP）与 `:8543`（EnemyDuel 会话服）。

## 1. adb 端口编排（C `src/launcher/openbachelorc/adb.py:221-252`）

让设备侧 `127.0.0.1` 直达 PC 上的本仓，比 Fiddler 转发省事（证书固定/不 root 场景必须走这层）：

```bash
# 设备侧 127.0.0.1:<port> → PC 侧同端口（客户端连私服用）
adb -s <serial> reverse tcp:8443 tcp:8443
adb -s <serial> reverse tcp:8543 tcp:8543

# PC 侧 127.0.0.1:27042 → 设备侧 gadget/frida-server 端口（Frida CLI attach 用）
adb -s <serial> forward tcp:27042 tcp:27042
# 清理
adb -s <serial> forward --remove-all
```

> EnemyDuel 会话服（`app/core/config/index.ts` 的 `multiplayer.port`，缺省 8543）需要同样 reverse，
> 否则客户端拿到的 `serverAddress` 是 PC 地址、连不通。

## 2. frida-server 改名伪装（C `adb.py:106-108`）

obs 把 `frida-agent-<arch>.so` 字面量替换为 `florida-123-<arch>.so` 再 push（避免按进程名/文件名声纹识别）。
本仓若走 frida-server 路线，照做即可；注意这是**规避检测**行为，仅限自有设备/模拟器调试。

## 3. gadget 双模式（G `main.py:105-127`）

| 模式 | 配置 | 适用 |
| --- | --- | --- |
| listen | `listen 127.0.0.1:10443` | 配合 `adb forward tcp:27042 tcp:10443` 用 Frida CLI attach |
| script-directory | `script-directory /sdcard/openbachelor`（`parameters` 传参） | 脱机注入：app 启动即加载脚本，无需 PC |

## 4. 随 APK 加载 gadget（G `smali.patch:1-16`）

在 `com/u8/sdk/U8UnityContext.<clinit>` 里插入 `System.loadLibrary("florida")`，使 gadget 随进程启动加载。
需要先 `apktool` 反编译、打补丁、回编、重签名——本仓 `scripts/apk-lua.ts` 已有 APK 改写/签名基础设施，可复用其流程。

## 5. 改包名共存（G `main.py:177-249`）

改 `applicationId` + 删 provider/permission + 重签名，与原版 APK 并存（便于对比调试）。

## 6. 注入配置协议：脚本常量 → 运行时参数（C `inject.py:52-54`）

obs 用 `post({type:"conf", k, v})` 逐条下发配置。本仓 `hook/main.ts:225` 目前把 `serverUrl` 写成脚本常量
（`http://<本机IP>:8443`）——若要频繁切换 PC 地址，可把该常量改成 gadget `parameters` 读取，避免每次重编译 hook。

> 现成可解注代码：`hook/main.ts:277-283` 的 `Networker.get_overrideRouterUrl` 与
> `:288-289` 的 `CryptUtils.VerifySignMD5RSA` **都在 262-338 的块注释内、当前未生效**；
> 走 PC attach 抓官服流量时可解注。解注会绕过签名校验——只在你自己的设备上做。

## 7. 红线（只文档化，不入产品代码）

以下 obs 做法**不引入本仓**，理由与对应安全审计见 `docs/apk-security-audit.md`：

1. `G misc.patch`：阉割 MTP 反外挂。
2. `G java.js` / `native.js`：证书链绕过（`TrustManagerImpl.checkTrusted`、`BouncyCastleCertVerifyer`）、
   签名校验绕过（`VerifySignMD5RSA`）、`android_dlopen_ext` 屏蔽 `msaoaidsec`/`anogs` 反作弊 so。
3. 任何以「绕过官方反作弊/校验」为目的的注入，都不进入本仓代码与发布产物。

本仓安全路线（`scripts/apk-audit.ts` + `docs/apk-security-audit.md`）是**审计**官方 APK，不是绕过它。

## 8. 复现入口

```bash
# 抽 obs 三件套（C/G/SS）源码到 tmp（gitignore）
python3 - <<'EOF'
import zipfile, os
for zf, prefix, dst in [
    ('reference/obs/OpenBachelorC-master.zip', 'OpenBachelorC-master/', 'tmp/obs-analysis/C'),
    ('reference/obs/OpenBachelorG-master.zip', 'OpenBachelorG-master/', 'tmp/obs-analysis/G'),
]:
    z = zipfile.ZipFile(zf)
    for n in z.namelist():
        if n.startswith(prefix) and not n.endswith('/'):
            out = os.path.join(dst, n[len(prefix):]); os.makedirs(os.path.dirname(out), exist_ok=True)
            open(out, 'wb').write(z.read(n))
EOF
```

| 借鉴点 | obs 出处 |
| --- | --- |
| adb reverse/forward 编排 | `C src/launcher/openbachelorc/adb.py:221-252` |
| frida-server 改名伪装 | `C src/launcher/openbachelorc/adb.py:106-108` |
| gadget 双模式 | `G main.py:105-127` |
| 随 APK 加载 gadget（smali patch） | `G smali.patch:1-16` |
| 改包名共存 | `G main.py:177-249` |
| 注入配置协议 `{type:"conf",k,v}` | `C src/launcher/openbachelorc/inject.py:52-54` |
