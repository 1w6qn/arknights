# 私服 mod 下发打通 + Lua 插件加载崩溃排查（2026-09-14）

承接 [docs/frida-mumu-il2cpp-2026-09-13.md](frida-mumu-il2cpp-2026-09-13.md)（MuMu 上把 Frida 接进 ARM64 il2cpp）。本轮目标仍是「改包名 → 自己用 MuMu 调试 → Lua 插件正常启动 + Frida 可注入查看日志」，实际进展是**打通了客户端下载私服 mod 的最后一环**，并**定位到插件加载即崩的新阻塞**。

## 0. 结论速览

| 事项 | 状态 |
| --- | --- |
| 运行期域名重定向（il2cpp 层）→ 客户端连私服 | ✅ 可用 |
| 客户端**下载并登记**私服下发的 Lua mod bundle | ✅ **本轮打通**（关键修复见 §2） |
| 客户端加载该 bundle 后 Lua 插件执行 | ❌ 阻塞：加载阶段进程进入 SIGSEGV 循环（§4） |
| Frida 观测（合成模块 + il2cpp + Unity 日志） | ✅ 可用（§1 附带修掉日志洪水） |

## 1. 本轮一并修掉的三处环境/工具缺陷

### 1.1 `get_latest_game_info` 返回 `{}` 会卡死 game 侧热更门禁

`app/core/config/launcher.ts` 里 `/api/game/get_latest_game_info` 原本是 `res.send({})`（注释写着"与 get_latest 同响应"但实现只发空对象）。客户端 `HGGameUpdateSDK.GetLatestGame()` 解析出 `{"code":0,"version":"","action":3,...}` 后**静默卡死**：不再请求 network_config / version / hot_update_list（实测一轮 140s 内零后续请求，本地 `Bundles/hot_update_list.json`、`persistent_res_list.json` 完全未更新）。

> 历史对照：07:38 那一轮能进热更流程，是因为当时**还没有 Java 层重定向**，该请求走的是官服、拿到的是有效响应。加了 Java 重定向后才暴露。

现按 game 侧抓包（2026-09-13）的官方形态补齐：`{"code":0,"version":"<回显请求 version>","updateType":0,"updateInfo":"","state":0}`。

### 1.2 Windows `127.0.0.1:8443` 到不了 WSL 私服

本机 WSL2 的 localhost 转发只在 IPv6（`[::1]`）上生效，`adb reverse tcp:8443` 落点却是 Windows 的 **IPv4** loopback → 客户端永远打不到私服。修法：给 `tmp/port-relay.mjs` 加了可选 `targetHost`（`node tmp/port-relay.mjs 8443 8443 <WSL_IP>`），在 Windows 侧把 8443/8543 中继进 WSL。

```bash
WSLIP=$(ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+')
"/mnt/c/Program Files/nodejs/node.exe" D:/develop/DoctorateTs/tmp/port-relay.mjs 8443 8443 "$WSLIP"
"/mnt/c/Program Files/nodejs/node.exe" D:/develop/DoctorateTs/tmp/port-relay.mjs 8543 8543 "$WSLIP"
# frida 两路（进 Windows loopback 的 adb forward）：27043→27042、27098→27099
```

### 1.3 宿主日志洪水（也是 DSH 崩溃的放大器）

`hook/host-logs.js` 原本会原样转发宿主 liblog 的每一条：MuMu 的 houdini 转译层用 `__android_log_print` 高频打 `[%d] %s`，实测**单轮 27.5 万行 / 14.9MB，占整份日志 99.96%**（去噪后同样一轮只有 4.4KB / 69 行）。现加了两道闸：标签黑名单（`houdini`）+ 单轮 `MAX_SEND=4000` 兜底上限。

> 关联：本轮开头 DSH 崩溃的根因是 WSL 客户机内存压力下 node/V8 集体 `SIGILL` 中止（`dmesg`：`traps: node ... invalid opcode` at `libnode.so.127+0x203e5c5`，机器码 `0f 0b` = V8 的 `ud2` 致命中止，紧跟在 `mini_init: drop_caches` 之后）。缓解：私服改为 `run_in_background` + **输出重定向到文件**（别让 harness 的 job 缓冲区吃日志），并压掉上面这类日志洪水。

## 2. 关键修复：mod 条目必须**保留官方身份字段**

### 2.1 现象

私服下发的 `hot_update_list.json` 确实被客户端拿到了（`versionId=26-09-09-07-16-57_540c27`，条目 `md5=ba45090f…`、`abSize=1213360` 全部正确），但客户端**从不请求** `anon/63bbacd2fab677125a1516d4396114ab.bin`；它写回的 `persistent_res_list.json` 里该 bundle 仍是官方值（`hash/md5="d21c"`、`abSize=1121653`）。

### 2.2 根因：注入把「身份字段」也换了

官方清单里该条目（`assets/26-09-09-07-16-57_d4e461/redirect/hot_update_list.json` ⟶ 纯净官方副本）：

```json
{"name":"anon/63bbacd2fab677125a1516d4396114ab.bin","hash":"d21c","md5":"d21c",
 "totalSize":1112961,"abSize":1121653,"cid":2457,"cat":1,"meta":1}
```

旧注入逻辑（`asset.ts`）是「**删掉官方同名条目 + 末尾追加 `{...mod, cid:max+1}`**」，于是变成：

```json
{"name":"anon/63bbacd2…bin","hash":"ba45090f…","md5":"ba45090f…",
 "totalSize":1175777,"abSize":1213360,"cid":15225}
```

机制层解释（三条证据一致）：

- 客户端把 `abInfos` 分两类：`meta=1`（`ABMetaFlag.IGNORE_MD5`）的 **148 条 `anon/*` 是独立下载项**；其余 `meta=0` 的 15018 条由 lpack 大包按 `pid` 分发。我们的条目**既无 `meta` 也无 `pid`** → 两条路径都不认领。
- `HotUpdater._CheckIfAssetDirty(abInfo, oldHashMap, oldMD5Map, oldTypeMap)` 以 `abInfo.hash` 去 `oldMD5Map` 取旧 `md5` —— 说明 **`hash` 是 bundle 身份键、`md5` 是内容指纹**（主体包两者不同：`shaders/other.ab` hash `3a3fec0c…` vs md5 `ef1db26a…`）。我们把身份键换成了客户端从没见过的 32 位 md5。
- 同一轮里 `.idx`（清单）那条的 `hash` 被改写成新 resVersion（客户端旧表里没这个键），客户端同样**没有**重新下载 34.7MB 的 `.idx` —— 与「未知 hash ⇒ 跳过」完全吻合。

### 2.3 修法（`app/ops/assets/asset.ts`）

注入改为「**就地替换官方同名条目**」：保留 `name/hash/cid/cat/meta`，只覆盖内容字段：

```ts
function applyModToAbInfo(abInfo: HotUpdateAbInfo, mod: ModMeta): HotUpdateAbInfo {
  const shortToken = abInfo.md5.length > 0 && abInfo.md5.length <= 8;   // 匿名 bundle：4 位内容令牌
  const md5 = shortToken && mod.md5.length >= 4 ? mod.md5.slice(0, 4) : mod.md5;
  return { ...abInfo, hash: shortToken ? md5 : abInfo.hash, md5,
           totalSize: mod.totalSize, abSize: mod.abSize };
}
```

另外给 resVersion 签名加了**注入方案版本**（`MOD_INJECT_FORMAT = "merge-identity-v2"`）：注入语义变了但 mod 集合/内容没变时，签名必须变，否则客户端继续用本地缓存旧清单、永远不重新评估。

回归测试：`tests/unit/asset-mod.test.ts` 新增「清单注入：mod 覆盖官方同名条目，保留身份字段（cid/cat/meta/hash），只换内容令牌与尺寸」（8/8 通过）。

### 2.4 验证（决定性）

一轮 `frida:mumu`（只挂 il2cpp 层重定向、不挂 Java 层）后：

```
GET /assetbundle/official/Android/assets/26-09-09-07-16-57_941633/hot_update_list.json  200
GET /assetbundle/official/Android/assets/26-09-09-07-16-57_941633/anon_63bbacd2…dat     200   ← 客户端终于来拉 mod
[Asset] serve mod file anon_63bbacd2fab677125a1516d4396114ab.dat → mods/android/anon_63bbacd2….dat
```

设备侧（`/storage/emulated/0/Android/data/com.hypergryph.arknights/files/Bundles/`）：

- `anon/63bbacd2…bin`：1,121,653 B → **1,213,360 B**，且该文件 **md5 = `ba45090f85f0d3876400a82a396503f7`**，与服务端公布的 mod md5 逐字节一致（客户端下载 zip 后解压落盘）。
- `persistent_res_list.json`：`{"hash":"ba45","md5":"ba45","totalSize":1175777,"abSize":1213360,"cid":2457,"cat":1,"meta":1}` —— 身份字段与官方一致，只有内容令牌和尺寸变了。
- `hot_update_list.json`：3,211,956 B（私服新清单）。

**语义解释**：`totalSize` = 可下载 `.dat`（zip）体积、`abSize` = 解压后 bundle 体积、`md5` = **解压后内容**的 md5（见 `asset.ts` 内注释）。匿名条目 `meta=1` 时客户端跳过 md5 校验，所以内容令牌取 4 位已足够触发重下。

## 3. 重定向分层（本轮厘清）

- **资产流量**（`/config/prod/official/*`、`/assetbundle/...`）走 UnityWebRequest（il2cpp 原生），由 `hook/build/il2cpp-client-redirect.js` 改写 → 私服。**mod 下发全靠这一层，不需要 Java 层。**
- **Java 层**（HGSDK / launcher / 账号，okhttp）由 `hook/build/java-redirect.js` 改写。实测只重定向 Java 层会**踩到 §1.1 的门禁**，而只挂 il2cpp 层时客户端反而能顺利走完热更（launcher 门禁走官服）。因此调试 mod 管线时用：

```bash
python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js --java-script "" --duration 170
```

## 4. 新阻塞：加载重打包 bundle → SIGSEGV 循环

### 4.1 事实

- mod 落盘后再冷启动客户端（**带或不带 frida都一样**），进程约 12~90s 后进入信号循环：

```
E CRASH (28517): signal 11 (SIGSEGV), code 0 (SI_USER), fault addr --------
                 Unity 2021.3.39f1 arm64-v8a, pid 28517 tid 28570 name UnityMain
backtrace #00 /system/lib64/arm64/nb/libc.so (syscall+32)   # nb = Houdini 翻译层
D houdini: [28570] arm backtrace: pc = 00000000038095e4 lr = 000000380a318   ← 同一地址无限刷
E CRASH: No handler for signal 11                                            ← 每秒数十条
```

- `SI_USER` 表示信号是被 `kill/tgkill` **主动投递**的（Houdini 会用它把 guest 信号转发给 guest 线程），所以不能据此断定是反外挂 kill；`houdini` 在同一 pc 上无限 backtrace 更像**翻译代码里真实的内存错误 + 信号处理被扰乱**。
- **注入的 Lua 代码从未执行**：整个生命周期内 logcat 无 `[DoctorateTs]` 标记（引导里 `_dtTrace` 是 `Debug.LogError` + 落盘双通道），设备上也没有 `plugin_boot_trace.txt`。即崩溃发生在「加载/初始化该 bundle」阶段，而不是我们的插件逻辑里。
- ACE（`com.ace.gshell.GP7Service`）在**每一轮**启动阶段都会拉起（未崩的那轮也拉），所以它存在与否不是区分变量。

### 4.2 已排除

把设备上的官方 bundle 拉回来（`tmp/official-lua.bin`，1,121,653 B / md5 `e27e60f9…`）与我们的重打包产物（`tmp/mod-bundle.bin`，1,213,360 B）做结构对照：

```
官方: SerializedFile=1154896B TextAsset=344 明文可解=320
我们: SerializedFile=1213216B TextAsset=344 明文可解=320
只在官方有(0) / 只在我们有(0)
同名但体积不同的资产(2): entry.lua 2489B→59324B、DefinedFix.lua 265B→296B
```

- 资产集合一一对应，**只有设计上要改的两个文件变了** → 不是资产丢失/错位。
- 密文格式自洽：`m_Script = [128B 头][16B IV^mask][AES-128-CBC(PKCS7)]` ⟹ `enc = 144 + PKCS7(plain)`；官方 entry.lua 2,489→2,640（+151）、DefinedFix 265→416（+151）；我们 59,324→59,472（+148）、296→448（+152）—— 全部符合 PKCS7 取整，**不是加密长度问题**。
- 注入后的 `entry.lua` 文本可解析（`require/local/function/Class` 齐全），内容 = 原 2,489B 原文 + 约 46KB 插件套件（12 个 `package.preload["Plugin/…"]` 模块：PluginManager / PluginHeartbeat / PluginEntry / PluginBootHotfixer …）。

### 4.3 下一步候选（按性价比排序）

1. **UnityFS 容器参数核对**：`pack-lua-bundle.ts`/`repack-lua-bundle.ts` 重建 bundle 时的压缩模式/flags/块划分（官方是 mode-4 LZ4? 逐块 flags）是否与官方完全一致。手写头解析已踩坑（字段布局），改用 UnityPy/AssetStudio 之类的成熟解析器或直接读 `unityfsToSF` 的中间量更稳。
2. **用官方内容做对照 mod**（只重打包、不注入插件）：若同样崩 → 问题在重打包容器；若正常 → 问题在插件套件或 `entry.lua` 尺寸暴涨。官方 bundle 已存于 `tmp/official-lua.bin`。
3. **抓 guest ARM64 崩溃栈**：`/data/tombstones` 最新只到 07:29（这次没落 tombstone）。可在 x86_64 agent 里 hook `kill/tgkill`，并对 `:GP7Service` 进程单独挂一份，确认投递者；或在 gadget 的 arm64 agent 里装 `Process.setExceptionHandler` 打印 guest 异常地址对应的模块（Houdini 下模块名可能是 `<anonymous>`，需回查 `/proc/self/maps`）。
4. **降级到最小注入**：先只改 `DefinedFix.lua`（265→296B，官方量级）验证"小改动可用"，再逐步加插件，定位是"尺寸暴涨"还是"某个插件"的问题。

## 5. 当前仓库/环境状态

- 代码改动：`app/ops/assets/asset.ts`（身份字段保留 + `MOD_INJECT_FORMAT`）、`app/core/config/launcher.ts`（门禁响应）、`hook/java-redirect.ts`（去掉 `as unknown as`，类型债棘轮 17/17 通过）、`hook/host-logs.js`（噪声闸）、`tests/unit/asset-mod.test.ts`（新增回归用例）、`tmp/port-relay.mjs`（`targetHost` 参数）。
- 验证：`tsc -p tsconfig.json --incremental false` 0 错；`vitest run tests/unit/asset-mod.test.ts` 8/8；`type-debt-ratchet` 17/17。
- 模拟器已恢复官方可玩状态：清掉客户端热更缓存后由客户端自行回补（`hot_update_list.json` 3,211,956 B、Lua bundle 回到官方 1,121,653 B，进程稳定无崩溃循环）。
- mod 产物保留在 `mods/android/anon_63bbacd2fab677125a1516d4396114ab.dat.disabled`（改名即禁用下发）；`mods.Android.json` 缓存已删，恢复时改回 `.dat` 即可。
- 复现命令：
  ```bash
  node scripts/build-frida-hook.mjs
  node_modules/.bin/tsx index.ts -s          # 私服（后台，输出重定向到文件）
  python3 scripts/frida-mumu-arm64.py --script hook/build/il2cpp-client-redirect.js --java-script "" --duration 170
  ```

## 6. 2026-09-15 复查：oursonly + 我们的重签容器已全线打通（附带两个客户端状态坑）

§4 的"加载重打包 bundle → SIGSEGV 循环"在当前产物上**不再复现**（当前 mod 只注入引导：
`TestStubHotfixer.lua` 496B，`entry.lua` 仍是官方 2,489B 明文，仅整包换成我们的签名），
`--pubkey-mode oursonly` 一条链路走通，验收证据：

| 检查 | 结果 |
| --- | --- |
| mod 容器内 Lua 签名（本地逐资产验签） | `mods/android/anon_63bb….dat` **344/344 通过** `data/crypto/public.xml` |
| 客户端实际生效的 bundle | `files/Bundles/anon/63bb….bin` md5 `3892e532…` = **我们的 mod**（非官方 `e27e60f9…`） |
| 客户端验签 | 60 次调用 0 失败：`depth=0/keyReplaced=false` 6 次（官方 excel/DB 资产，保持官方公钥）+ `depth=1/keyReplaced=true` 54 次（Lua 上下文换成我们公钥，全 True） |
| Lua 入口 | `lua-load entry.lua len=2489` → `GlobalConfig` / `Base/*` 顺序加载，无 abort |
| 资产内引导（§2 路线） | `plugin_boot_trace.txt` 更新且内容 `DTS_PLUGIN_OK enemy_hp=1 … automation_bridge=1`（8 插件 ON） |
| 私服侧 | `/plugin/lua`、`/plugin/heartbeat`×7 命中 |

为把"验签失败"这类问题从"猜"变成"读日志"，hook 的 `verify-bin` 事件补了两个字段：
`depth`（进入钩子时的 `luaLoaderDepth`）与 `keyReplaced`（本次是否真的把公钥换成了我们的）。
判读法：**`ok:false` 且 `keyReplaced:false` = 换公钥被上下文守卫跳过（不是内容不对）**；
`ok:false` 且 `keyReplaced:true` = 内容确实不是我们签的。

### 6.1 坑一：客户端注册表与磁盘内容不一致 → 换公钥必崩

现象（08:32–08:47 三次复现）：`verify-bin call 7 ok:false` → `lua-load entry.lua len=-1` →
`require "entry.lua"` 抛 LuaException → `Il2CppExceptionWrapper` abort（tombstone_00/01 为该时段）。

机制：客户端 `files/Bundles/persistent_res_list.json` 还停在 09-14 17:01（记录的是**上一版**
mod 内容令牌），而磁盘上 `anon/63bb….bin` 已是新版；客户端把 bundle 当"脏"发起一轮**加载前校验**，
这一步在 `_CustomLoader` 之外 → hook 按设计**保持官方公钥** → 我们签的内容必然验不过 → Lua 入口拿不到内容 → abort。
对照：`--pubkey-mode asis`（不换公钥、官方内容）同状态能起，正因为没有"我们的签名 vs 官方公钥"这对矛盾。

处置（任选，之后 `oursonly` 恢复正常）：
1. **让客户端完成一次正常热更**：先 `--pubkey-mode asis` 起一次（客户端会重写 `hot_update_list.json`/`persistent_res_list.json`，08:45 那次即如此），再切回 `oursonly`；
2. 或删掉客户端那两份注册表 JSON（`files/Bundles/hot_update_list.json`、`persistent_res_list.json`）后重跑，让它重新登记 mod。

一键脚本已内置定向诊断：命中 `verify-bin ok:false` + `entry.lua len=-1` 时直接打印这条因果与上述处置。

### 6.2 坑二：备份恢复多套了一层 → 客户端出现 `files/files/` 第二棵树

设备上 `files/files/{Bundles,Cookies,HGGameUpdate,il2cpp,…}` 全量存在（mtime 全是 09-14 17:01），
里面是**旧注册表 + 旧 mod 内容**（`anon/63bb….bin` md5 `7814b473…`，与 `files/` 下的 `3892e532…` 不同）。
它不参与 Unity 的 `persistentDataPath`，但会让"哪份是当前状态"变得不可判读。
已改名为 `files/files.bak-20260915`（可回滚）；一键脚本开工时会检测并提示同样处置。

### 6.3 可直接复用的两个工具

- 本地验签：`node_modules/.bin/tsx tmp/verify-mod-sign.ts <mod.dat|.bin|.official> [public.xml]`
  —— 解 zip→UnityFS→SerializedFile，逐 TextAsset 校验 128B 签名并打印 `entry.lua/DefinedFix.lua/TestStubHotfixer.lua` 的明文头。
- 一键链路：`start-mumu.cmd --duration 60`（默认 `oursonly`，即"资产内引导 + 私服 HTTP"路线）。

### 6.4 加固：验签「双信任锚」（hook 侧 JS 自算 RSA/MD5）

§6.1 的死因是**客户端在 Lua 上下文之外**用它自己的公钥验我们签的内容。与其依赖"客户端状态别脏"，
不如让这一层不再取决于客户端拿的是哪把公钥：`hook/il2cpp-client-redirect.ts` 在 `VerifySignMD5RSA(byte[],byte[],string)`
的钩子里，用**纯 JS**（QuickJS 无 `node:crypto`，故自带 MD5 + base64 + BigInt 模幂）按我们的公钥复算
128B PKCS#1 v1.5/MD5 签名；只要内容确实是**我们**签的，就把返回值强制算成功。官方资产仍走客户端自身验签
（我们这把公钥验不过官方签名，锚点不参与），所以 excel/DB 的官方签名路径不受影响。

- 自检：启动时打 `verify-anchor-selftest`（MD5 向量 + BigInt 可用性 + 公钥解析 1024 bit）；不满足则整体禁用锚点，只影响这一层加固。
- 判定：内容经 `readManagedBytes`（il2cpp 数组：长度 `+0x18`、数据 `+0x20`）读出，>256KB 的大 blob 不参与；参数顺序两个方向都试，载荷含 128B 头时摘要覆盖 `[128:]`。
- 日志：`verify-anchor`（本次强制放行，含 `call/depth`）、`verify-anchor-err`（自身上限流）。

**验证（制造"客户端验签必失败"的对照）**：`--pubkey-mode flip` 会把 Lua 上下文的公钥换成官方（反转写法），
即客户端对**我们签的** Lua 必然验签失败 —— 此时锚点接管：

```
verify-anchor', 'call': 7, 'depth': 1, 'forced': True      ← 第 7 次起全部强制放行（日志上限 20 条）
lua-load', 'path': 'entry.lua', 'len': 2489                ← Lua 入口照常加载
[收尾] ✔ frida 管线正常结束（40 s） / ✔ 客户端仍在运行
```

对照未加固前：同一条件（客户端拿官方公钥验我们的内容）就是 §6.1 的 abort。
另外 `--pubkey-mode asis` 现在也能正常起（60 次验签 0 失败）——因为私服下发的 `network_config`
本身会把信任锚换成我们的公钥，锚点只是给"锚还没换过来/状态脏"的窗口兜底。
