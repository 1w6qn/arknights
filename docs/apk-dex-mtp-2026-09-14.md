# APK dex 级关闭 MTP（等长补丁，免注入）

> 2026-09-14 · 落点 `scripts/apk-dex-mtp.ts`（`pnpm run apk:dex-mtp`）+ `scripts/lib/dex.ts` + `scripts/lib/apk-io.ts`
> 红线变更记录见 §7（原红线：`docs/no-root-injection-chain-2026-09-13.md` §7.1）

## 1. 结论

- 新增 `pnpm run apk:dex-mtp`：把客户端 `classes4.dex` 里 MTP（Hypergryph 反外挂框架 `com.hg.sdk`）
  的两个入口方法体**等长原地置空**（`return-void` + `nop` 填充），**不需要 Frida 注入环境**。
- 只改**指令字节 + dex 头部**（SHA-1 签名 / Adler-32 校验），dex 长度与结构**零位移**；
  写盘走的仍是既有的 zip 级增量重写（`apk:patch`），**不反编译、不回编译 smali**。
- 目标（与 `hook/main.ts:250-253` 运行期 hook 完全对齐）：
  - `com.hg.sdk.MTPProxyApplication#onProxyCreate` → 不再 `initSDKWhenAppCreate` / `initWhenActivityCreate`
  - `com.hg.sdk.MTPDetection#onUserLogin` → 不再上报登录环境（实测该方法是
    `onUserLogin(IILjava/lang/String;Ljava/lang/String;)V`，同名重载全部命中）
- native 层（`libtersafe2.so` TSS/ACE、`libmsaoaidsec.so`）**一律不碰**。

## 2. 为什么是「等长原地改写」而不是 apktool

apktool 那条路要「baksmali → 改 smali → smali 回编译」，回编译会**重排 dex**（类/方法顺序、索引表、
map 区），ACE/TSS 的完整性自校验极易发现并直接终止进程。本仓已有的实测反例：

```
09-14 14:50:24.342 ... D houdini : #00 pc 0000000000456830 .../lib/arm64/libtersafe2.so
09-14 14:50:24.369 I ActivityManager: Process com.hypergryph.arknights (pid 20975) has died
09-14 14:50:24.370 I Zygote  : Process 20975 exited due to signal 11 (Segmentation fault)
```
（`tmp/apk-mod/ace-kill-logcat.txt`）

因此沿用本仓既有纪律：`apk:patch`（zip 级增量重写）、`apk:rename`（等长二进制替换）。
方法体置空后 `insns_size`、`try_item` 偏移、`class_data_item` 布局全部不变，只有：

| 区间 | 变化 |
| --- | --- |
| `code_item.insns` | 原指令 → `return-void`(0x000e) + `nop`(0x0000) 填充到原字数 |
| `code_item.registers_size` | 仅当**非 void** 返回且原值为 0 时抬到 1（字段等长，不影响入参寄存器） |
| header `[8,12)` | Adler-32 校验重算 |
| header `[12,32)` | SHA-1 签名重算 |

## 3. 实测（2.7.71 / `arknights-hg-2771.apk`，5 dex / 22,574 类）

`pnpm run apk:dex-mtp -- --list` 结果（MTP 全部在 `classes4.dex`）：

| 类 | 方法（实测签名） | 指令字数 |
| --- | --- | --- |
| `com.hg.sdk.MTPDetection` | `<init>(Landroid/app/Activity;)V` | 21 |
| | `getData(ILjava/lang/String;)Ljava/lang/String;` | 9 |
| | `isSupportMethod(Ljava/lang/String;)Z` | 21 |
| | **`onUserLogin(IILjava/lang/String;Ljava/lang/String;)V`** | **8** |
| | `setData(ILjava/lang/String;)V` | 8 |
| `com.hg.sdk.MTPProxyApplication` | `<init>()V` | 4 |
| | `onProxyAttachBaseContext(Landroid/content/Context;)V` | 1 |
| | `onProxyConfigurationChanged()V` | 1 |
| | **`onProxyCreate()V`** | **15** |
| | `onProxyTerminate()V` | 1 |
| `com.hg.sdk.MTPSDK` | `initSDKWhenAppCreate()V` | 82 |
| | `initWhenActivityCreate()V` | 13 |
| | `onUserLogin()V` | 37 |
| | `getData()Ljava/lang/String;` / `getInstance()` | 59 / 14 |
| `com.hg.sdk.MTPSDK$MyTssInfoReceiver` | `onReceive(...)`（TSS 广播回调） | 150 |

补丁结果（`--dry-run` 与正式出包日志）：

```
[apk-dex-mtp] classes4.dex 置空 com.hg.sdk.MTPProxyApplication#onProxyCreate → 首指令 0x000e，原 15 字指令已用 nop 填充
[apk-dex-mtp] classes4.dex 置空 com.hg.sdk.MTPDetection#onUserLogin        → 首指令 0x000e，原 8 字指令已用 nop 填充
```

与原 dex 逐字节对比（§5 复现命令）：**5,131,540 字节中仅 52 字节不同**——24 字节在头部
（checksum 4 + signature 20），28 字节在两个方法体里（其余原指令恰好本来就是 `nop`/`0x0000`）。

## 4. 三层自检（本仓「多口径交叉验证」纪律）

| 口径 | 手段 | 结果 |
| --- | --- | --- |
| 本脚本自检 | `verifyDex`：Adler-32 / SHA-1 复算 + 首指令断言；出包后 `verifyPatchedApk` 校验条目 CRC | 通过 |
| **独立解析器** | 把补丁后的 dex 塞进最小 APK（manifest + arsc + classes.dex），用 `tmp/tools/apktool.jar` 3.0.3（smali/dexlib2，与本仓实现无关）baksmali | 反编译成功；smali 里 `onProxyCreate` 只剩 `return-void` + 14 个 `nop` |
| 单元测试 | `tests/unit/scripts/dex-patch.test.ts`：合成 dex 夹具覆盖 void / int / wide 返回、native 无方法体、`registers_size=0` 抬升、**结构零位移不变量**（除头部与 `code_item.insns` 外逐字节不变）、apk-io 条目读写 | 8 用例通过 |
| 单元测试 | `tests/unit/scripts/apk-sign.test.ts`：签名产物挑选（对齐中间产物 / 输入自身 / 历史产物负样本） | 4 用例通过 |

产物（2.7.71）：

| 文件 | 说明 |
| --- | --- |
| `tmp/apk-out/arknights-hg-2771-nomtp-unsigned.apk` | 1,885.2 MB，替换 1 条（`classes4.dex`），重写 22.8 s（首次 24.7 s）；`META-INF/` 已被 `apk:patch` 清空（旧官方 V1 签名） |
| `tmp/apk-out/arknights-hg-2771-nomtp-signed.apk` + `.idsig` | 1,885.6 MB + 14.9 MB；uber-apk-signer 对齐 + debug key 签名，日志 `zipalign verified` / `signature verified [v2, v3]`；443 s（首次 887 s） |
| 终检 | 签名包与未签名包内的 `classes4.dex` 都**逐字节等于**留档的补丁 dex（`sha256 3509893ad4de236a…`）；用最终代码重跑 `--dry-run` 复现同一份字节 |

### 4.1 顺带修掉的一个交付物命名 bug（`scripts/apk-sign.ts`）

首次 `--sign` 出来的 `*-signed.apk` **其实是未签名包**：uber-apk-signer 会把输入名末尾的 `-unsigned`
**去掉**再命名（`X-unsigned.apk` → `X-debugSigned.apk`），中间还落一个只对齐未签名的 `X-aligned.apk`；
而 `signApk` 旧实现按「输入名去 `.apk`」做前缀匹配，于是永远匹配不到真签名产物，反而把**输入自身**
改名成了交付物。现已把挑选逻辑抽成 `findSignedArtifact(outDir, inApk, startedAt)`：按后缀
`signed.apk`（覆盖 `-debugSigned.apk` / `-signed.apk`）+ 前缀（输入名去 `-unsigned`）+ 时间戳过滤，
并显式排除输入文件；守卫见 `tests/unit/scripts/apk-sign.test.ts`（4 用例，含对齐中间产物与历史产物负样本）。

## 5. 用法与复现

```bash
# 只看 dex 里的 MTP 类/方法（不写盘）
pnpm run apk:dex-mtp -- --list

# 补丁 + 自检，不写盘
pnpm run apk:dex-mtp -- --dry-run

# 出包（未签名）+ 重签；缺省自动定位 tmp/apk/<版本>/*.apk 里最新的 APK
pnpm run apk:dex-mtp -- --sign

# 追加/替换目标，或整类置空
pnpm run apk:dex-mtp -- --target com.hg.sdk.MTPSDK#onUserLogin --sign
pnpm run apk:dex-mtp -- --blank-class com.hg.sdk.MTPDetection --sign

# 更彻底的档位（追加 MTPSDK 初始化/上报入口；设备上未实测，异常时改回 default）
pnpm run apk:dex-mtp -- --profile full --sign

# 指定源/产物
pnpm run apk:dex-mtp -- --apk tmp/apk/2.7.71/arknights-hg-2771.apk --out tmp/apk-out/x.apk
```

复现 §3 的逐字节对比：

```bash
python3 - <<'EOF'
import zipfile
out = zipfile.ZipFile('tmp/apk-out/arknights-hg-2771-nomtp-unsigned.apk')
data = out.read('classes4.dex')
orig = open('tmp/apk-mod/classes4.dex.orig','rb').read()          # 从源 APK 抽出的原 dex
diff = [i for i in range(len(orig)) if orig[i] != data[i]]
print(len(data), 'diff bytes', len(diff), 'header', len([i for i in diff if i < 32]))
EOF
```

补丁后的 dex 会留档到 `tmp/apk-mod/classes4.dex.nomtp.dex`（`--no-keep-dex` 可关），便于反查。

## 6. 边界与风险

- **只动 dex**：native `libtersafe2.so`（TSS/ACE）与 `libmsaoaidsec.so` 原样保留；若其它路径（native 自启、
  `System.loadLibrary` 调用点）仍拉起 MTP native 侧，本补丁不覆盖——那属于「动 so」，本仓不做。
- **`--profile full` 未实测**：它额外置空 `MTPSDK#initSDKWhenAppCreate` / `initWhenActivityCreate` /
  `onUserLogin` 与 `MTPSDK$MyTssInfoReceiver#onReceive`。刻意**不动**有返回值的方法
  （`getData` / `getInstance` / `isSupportMethod`），避免 caller 拿到 null 崩溃。
- 出包默认只产未签名包；`--sign` 会走 uber-apk-signer 的 **zipalign + 签名**（1.8 GB 包实测约 15 min，
  因为要对整包做对齐、摘要与重写）。重签名后如需与原版共存，另跑 `pnpm run apk:rename`（等长改包名）。
- 设备侧仍需 hosts + adb reverse（`docs/apk-mod-2771-2026-09-13.md` §8.7）。
- 每次官方客户端更新后 dex 会变，必须重跑本脚本（`--list` 会给出当版本的真实签名）。
- **用途边界**：只用于自建私服的客户端改造，不要在官服对抗环境使用。

## 7. 红线解除记录（2026-09-14，用户决定）

`G misc.patch`（阉割 MTP 反外挂）原被三处文档列为红线、不进入本仓代码：

1. `docs/no-root-injection-chain-2026-09-13.md` §7.1（已加删除线 + 指向本文档）
2. `docs/obs-可借鉴清单-2026-09-13.md` §5.1（已加「更新」注记）
3. `docs/obs-G-analysis-2026-09-13.md` §6（已加「更新」注记）

2026-09-14 经用户确认**解除**，落地为本脚本。与 G 的差别是刻意保持的：不做 smali 回编译（结构零位移）、
不引入注入式绕过、不动证书链/签名校验、不动 native 反作弊 so。其余红线项（证书链绕过、`VerifySignMD5RSA`
绕过、`android_dlopen_ext` 屏蔽反作弊 so、`trainer.js` 作弊指令）**不变**。
