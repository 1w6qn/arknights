# reference/obs/ 分析报告：OpenBachelor 私服套件（7 个项目）

- 分析日期：2026-09-13
- 分析对象：`reference/obs/` 下 7 个 zip（共 **259 MB**，约 4.1k 条目）。`reference/` 在 `.gitignore` 内，本报告只读分析，**未改动 reference/ 下任何文件**；解压与中间产物均在 `tmp/obs-analysis/`（已 gitignore）。
- 结论定位：这是一个《明日方舟》（Arknights）**私服 + 客户端注入 + 资源 Mod + 联机对局 + 数据挖掘**的完整工具套件，README 统一用「For PvZ Online」作代号。上游仓库为 GitHub 上的 `OpenBachelor*` 系列 master 快照。
- 与本仓的关系：本仓 `api.md:1607`、`design-spec.md:1818-1832` 明确记录过「从 `reference/OpenBachelorS-master` 移植端点」，obs 里的 S 快照即该参考源（刷新到与本仓**同一天同一版本**，见 §2.1）。

---

## 1. 清单与组件全景

| 项目 | 压缩包 | 条目 | 语言/栈 | 定位 |
|---|---|---|---|---|
| **S**erver | `OpenBachelorS-master.zip` | 313 | Python 3.12 + FastAPI/uvicorn + 可选 PostgreSQL | 主游戏服（HTTP 协议全量实现 + 资源热更分发 + Mod 挂载） |
| **C**lient | `OpenBachelorC-master.zip` | 95 | Python 启动器 + TypeScript Frida 脚本 | 把 Frida 注入官服客户端并接管流量 |
| **G**adget | `OpenBachelorG-master.zip` | 26 | Python + apktool/uber-apk-signer | 重打包官方 APK 植入 frida-gadget（免 root） |
| **CF**iddler | `OpenBachelorCF-master.zip` | 5 | C#（Fiddler Classic） | Fiddler 脚本：域名重定向到 `127.0.0.1:8443` |
| **M**od | `OpenBachelorM-master.zip` | 1943 | Python + UnityPy(fork) + flatc | Mod 构建器；附带 **38 个游戏版本的 FBS schema** |
| **Insight** | `OpenBachelorInsight-master.zip` | 1709 | TypeScript Frida + Python/Flask + LightGBM | 对局数据抓取 + 敌人胜率模型 |
| **SS**ession | `OpenBachelorSS-master.zip` | 37 | Go 1.24 | EnemyDuel 实时对局会话服（TCP 二进制协议） |

大小分布：C 108 MB（内含 frida-server/gadget/adb 二进制）、Insight 78 MB（1639 张敌人图 + 数据）、G 38 MB（apktool 等 jar）、S 33 MB、M 9.4 MB（含 1816 个 .fbs 与 18 版生成代码）、CF 4.5 MB（含 Fiddler 安装包）、SS 24 KB。

### 组件关系（端口为各项目自述的默认值）

```
   官服客户端 APK
        │  ① G：apktool 解包 → 植入 libflorida.so(frida-gadget) → 改包名 anime.pvz.online → uber-apk-signer 签名
        ▼
   改包 APK（可与原版共存）
        │  ② gadget listen 127.0.0.1:10443（或 script-directory /sdcard/openbachelor）
        ▼
   C 启动器 ──(adb reverse tcp:8443/8543/8544)──► 本机私服
        │        注入 rel/{java,native,extra,trainer}.js（Frida）
        │        CF：PC/不 root 场景改用 Fiddler 把 *.hypergryph.com / *.yostarplat.com 重定向到 127.0.0.1:8443
        ▼
   ┌────────────────────┐        ┌───────────────────────────┐
   │ S 主服 :8443       │ 下发   │ SS 会话服 :8543 (EnemyDuel)│
   │ HTTP JSON(无加密)  │───────►│ TCP 8B 大端帧 + 二进制载荷 │
   │ 玩家存档 delta     │ 地址   │ :8544 (icebreaker) 空壳    │
   └────────────────────┘        └───────────────────────────┘
        ▲  资源 /assetbundle/official/...   ▲
        │  M 产出的 mod/*.dat（AB 整包替换） │  Insight：Frida 抓对局 → jsonl → csv → LightGBM 胜率
```

---

## 2. 逐项目分析

### 2.1 OpenBachelorS（服务端，参考价值最高）

**技术栈与启动**：`pyproject.toml:8-25`（fastapi 0.136 / uvicorn / hypercorn / orjson / pycryptodome / psycopg[binary]+pool / aiofiles / httpx；aria2c 为外部可执行）。入口 `src/openbachelors/app.py:69` → `main()` 硬编码 `127.0.0.1:8443`；`poe dev/prod`（dev = uvicorn --reload，prod = hypercorn -w 16）；PyInstaller 打包入口 `src/win_binary/main.py`。

**区域/版本**：`const/region.py` 是写死的常量 `GAME_REGION = CN`（切 EN 需改源码），但仓内同时带三套 excel：`res/`（CN）、`res_2461/`（CN 2.4.61 旧版）、`res_en/`（EN 36.7.22，EN excel 171.7 MB）；三套合计约 420 MB JSON；`conf/version*.json` 也按 CN/EN/2.4.61/Windows 分文件。**其 `conf/version.json` 与本仓 `data/config.json` 逐字段一致**（`2.7.71` / `26-09-09-07-16-57_d4e461`；Windows `26-09-09-08-18-15_d25676`）——即该快照是与本仓同期的上游，不是历史陈旧包。

**HTTP 层**：`app.py:72-104` 逐个 `include_router` 33 个蓝图，**全部无 prefix**，路径在装饰器里写全；`@router.*` 共 **264 条唯一字面路径**（misc_bp 60、bp_sandboxPerm 30、bp_rlv2 16、bp_building 15、bp_user 14、bp_shop 13、bp_gacha 11、bp_aprilFool 11）。响应统一 `orjson.dumps + application/json`（`player_data.py:1302-1304`）：**无协议加密、无压缩**；全仓唯一 AES 是 `helper.py:248-265 decode_battle_log`（解密客户端战斗日志）。多用户靠 `secret` 头 → `helper.py:45 get_username_by_token` 当主键（`player_data.py:1105`）——与本仓「强制 secret=1、单账号」是最大架构差异。

**玩家数据模型（本仓最该对照的部分）**：
- 三态叠加：只读模板 `ConstJson`（`build_player_data_template()` `player_data.py:71-711` 由 excel 反推「全解锁」存档，57 个顶层 key）+ `DeltaJson{modified_dict, deleted_dict}`（:735-759）+ `OverlayJson` 读写代理（:827-919）。
- 持久化两条路：`FileBasedDeltaJson`（:975）→ `sav/delta.json` + `sav/pending_delta.json`（多用户 `multi_sav/<username>/`）；`DBBasedDeltaJson`（:992）+ `DBSaveAggregator`（:1058）一条 UPDATE 写 `delta/pending_delta/extra` 三列（表结构 `db_manager.py:52-71`），DB 不可用自动降级文件（:102-110）。
- 请求收口：`player_data_decorator`（:1276-1308）统一 create → 业务 → 推消息 → `build_delta_response()`（:1217-1235）→ save → 注入 `json_response["playerDataDelta"]`。**业务函数只改数据，delta 由框架算**——与本仓 `player.update(recipe)` + `player.delta`（读完即清 `_changes` 并触发 save）思路同源；差异是 OBS 区分 `delta` 与 `pending_delta` 两级累积，本仓是单级（见 §3.3 第 4 行）。
- 懒加载：`util/const_json_loader.py:87-137` 启动只登记路径、首次访问才 `json.load`——这是躲开几百 MB excel 的关键手法（本仓 excel 已做单例/懒加载，可互证）。

**业务亮点**：`bp_gacha.py` 用 `GACHA_RULE_TYPE_DICT`(:357-371) 把 `gachaRuleType` 映射到池管理器，Simple/Double/Single/Newbee/Limited/Normal/Linkage 七类各自覆写 `get_advanced_gacha_result`，保底（`BASIC_TIER_6_PITY_THRESHOLD=50`、`PERCENT=0.02`，:529-540 线性叠加）落在 `extra_save` 而非协议 delta；`bp_rlv2.py`（theme 子类表驱动）、`bp_sandboxPerm.py`（`calc_extra_rune` 从 runeDatas/itemTrapData 拼 extraRunes）、`bp_building.py assignChar`（:94-132 房间↔干员双向一致性）、`bp_config.py network_config`（:16-56 按 request.host 动态生成 gs/as/u8/... 地址，10 档 funcVer）。

**资源分发与 Mod（本仓空白点）**：
- `/assetbundle/official/{platform}/assets/{res_version}/{asset_filename}`（`bp_assetbundle.py:173-175`）：文件锁防并发；本地无包且 `config.redirect_asset` 且非 `hot_update_list.json` 时 302 回官方 CDN（:155-158），否则 aria2c 下载到 `asset/<resVersion>/` 再 `FileResponse`。
- Mod：目录下任意 `*.dat`（实为 zip，**条目名即 AB 路径**）→ `mod_loader.py:85-110` 从 `MOD_CID=1000000` 起伪造 cid 注入 `hot_update_list.abInfos`，并从原清单剔除被覆盖项；`bp_config.py:67-75` 在 resVersion 尾部拼 `uuid4().hex[:6]` 伪造新版本号让客户端重拉清单；命中则直接回 mod 文件（`bp_assetbundle.py:83-115`）。开关 `conf/config.json:10 "mod"`。

**联机**：`conf/config.json:13-14` 只有 `multiplayer_addr:127.0.0.1:8543` / `icebreaker_addr:127.0.0.1:8544`，`misc_bp.py:474,482` 与 `:684,692` 把它们当 `serverAddress` 下发；`serverToken` 由主服自造（`get_server_token` :449、`get_icebreaker_server_token` :650-673，从 activity_table 随机抽 stageId 拼 `mode,stage|mode,stage`）。**S 内没有任何对局/房间/WebSocket 实现**——对局逻辑在 SS。

**局限**：`bp_common.py` 56 KB 里绝大多数是 Yostar/EN SDK 静态字典（`client-code` 1000+ 行错误码）；`bp_shop.py getLowGoodList` 是 400 行硬编码商品表；`misc_bp.py` 60 条活动多为 stub；无测试覆盖以外的质量手段（仅 `test/` 7 个文件，其中 `test_player_data.py` 反而很有价值）。

### 2.2 OpenBachelorC（客户端启动器 + Frida 脚本）

**启动器**（`src/launcher/openbachelorc/`，六模块，`config.py:5-6` 导入即读 `conf/config.json` 为全局单例）：
- `adb.py`：发现/连接设备（MuMu 16384+32i、LD 5555+2i）；按 `ro.product.cpu.abi` 上传 frida-server，并把二进制内 `frida-agent-<arch>.so` **改名成 `florida-123-<arch>.so`**（`adb.py:106-108`）躲进程名检测，推到 `/data/local/tmp/florida-17.9.1`；提权（`adb root` → `su -c id -u`）；`adb reverse tcp:<port>`（`adb.py:221-225`，**8443/8543/8544 三个端口都做**）、`adb forward tcp:27042→gadget_port|frida_port`；`monkey` 启包；推 standalone 脚本到 `/sdcard/openbachelor`。
- `inject.py`：四脚本 attach 顺序 java → native →（extra/trainer）；`use_emulated_realm` 只作用于后三者（`inject.py:144/154/164`），java 恒用默认 realm；gadget 模式 `pid="Gadget"`；`no_spawn` 时枚举进程名含 `arknights`/`明日方舟` 附着，否则 `spawn`；加载后逐条 `post({type:"conf",k,v})` 下发配置（`inject.py:52-54`），trainer 指令用 `{k:"invoke"}`。
- `dump.py`：把 `/sdcard/Android/data/{包名}/files/` 下的 `xxx_db (Torappu.XxxDB).json` **映射为与官方 excel 同名**（`dump.py:11-62`，如 `handbook_info_db`→`handbook_info_table`），一键产出可喂私服的表 —— 对 excel 溯源/表名核对很有用。
- `main.py`：`--no_proxy / --dump_json / --attach_pc`；**`no_proxy` 时强制关 trainer**（:77-79）；交互命令 `enable/disable [all] <cmd>`、`!` 透传、`?` 触发 dump 回捞。

**`conf/config.json` 字段**：`host/port=8443`（拼成 `proxy_url`）、`multiplayer_port=8543`、`icebreaker_port=8544`、`no_proxy`（脚本内直接返回原 URL）、`attach_pc`、`frida_port=9443`、`gadget_port=10443`、`use_su`（root 走 frida-server）、`use_gadget`（免 root 走 gadget，包名变 `anime.pvz.online`）、`use_emulated_realm`（Frida `realm="emulated"`，模拟器/转译环境）、`no_spawn`、`enable_extra`（`pause_deploy/3x_speed/vision/vision_font_size`）、`enable_trainer`（`dump_json`）。`load_config_*.cmd` 用 jq 切换这几组开关。

**四个 Frida 脚本实际 hook 的内容**（来自官方发布的 `rel/*.js` 反混淆副本；原始 TS 源码不可得，见下）：
- `java.js`（Java 层，网络/风控）：`_GetOAID` 置空、`Tracking.activation` 屏蔽、`hgsdk…Util.check`→true、**`OkHttpUtils$TrustAllCerts.checkServerTrusted` 与 `NetworkService$TrustAllCerts.checkServerTrusted` 空实现**、**`okhttp3.HttpUrl.get(String)` 重写成 `proxy_url + path`**、`MTPProxyApplication.onProxyCreate` + `MTPDetection.onUserLogin` 置空、`libcore.net.NetworkSecurityPolicy.setInstance` 置空、`isCleartextTrafficPermitted`→true、**`TrustManagerImpl.checkTrusted` 返回空 ArrayList（信任链造假）**。
- `native.js`（il2cpp/native 层）：同款 URL 改写；**`Interceptor.replace(android_dlopen_ext)` 带缓存——路径含 `msaoaidsec`/`anogs` 时直接返回上次句柄（=不加载该 so）**；**`Torappu.Network.Certificate.*BouncyCastleCertVerifyer.IsValid`→true**；`UnityWebRequest.Get` / `.ctor(string,string)` 改 URL；**`Torappu.CryptUtils.VerifySignMD5RSA`→true、`RSACryptoServiceProvider.VerifyHash`→true（签名校验整体绕过）**；PC 分支 hook `Qt5Core.dll` 的 `QUrl` 构造以改流量。
- `extra.js`（游戏性增强）：`pause_deploy` = 用 `SetPaused` 包裹 `UIController.OnBottomMaskClicked` / `OnCardBeginDrag` 并强制 `UISwitchToggle.SetInteractable`；`3x_speed` = 直接改 `UITopBar.OnSpeedSwitcherClicked` 里的 `speedLevel.value__`；`vision` = 造 `obc-vision` 文本 + hook `UIUnitHUD.Attach` / `UIHudEnemyHpSlider.OnAttach` / `UIEnemyGiantBossInfoPanel.Attach` 显示敌血。
- `trainer.js`（17 组作弊）：`S(name,cb)` 注册表 + `invoke` 分发，`disable` 一律 `.revert()`；`dump` = `Il2Cpp.dump("dump.cs")`，`dump_json` = 关 `AbstractTable.get_enableAsyncLoad` 后把 `DBLoader._DoLoadTable` 的表序列化落盘。17 组命令覆盖 cost/deployCnt/cooldown/token/SP/撤回/治疗/弹药/阻挡/范围/对空/AOE/禁用卡/助战/重复干员/自动技能，**其被 hook 方法名（`Card.get_cost`、`get_dontOccupyDeployCnt`、`get_remainingCnt`、`get_cardPolicy`、`get_maxTargetNum`、`Entity.get_lifePointReduce`、`RangeSelector`、`AuraAbility` …）等于一份官方战斗数值模型 getter 索引**，可用来与本仓 battle 模块及反编译源逐字段对照。

**源码加密发布（重要口径）**：`src/script/{java,native,extra,trainer,util}/index.ts`、`src/helper/helper.{js,py}`、连 `build_js_rel.cmd` 本身在仓内都是 `.encrypted`（自研 `locker.py`：AES-EAX，密钥 = `sha256(key_v1.png)`，头部 1024 B = 4 B 版本号 + 16 B nonce + 补零）。**`key_v1.png` 被 gitignore 且未随 zip 发布，所以上述脚本结论来自 `rel/*.js` 编译产物的反混淆推断，不是源码原文**；`src/helper/helper.{js,py}.encrypted` 在仓内未见任何引用（疑为死文件）。
**流量接管两条路**：① host=127.0.0.1 时走 `adb reverse`（8443/8543/8544）；② 非本机/PC/不 root 场景走 CF（Fiddler）。`--no_proxy` 只做注入、不改流量。`frida-server/*.xz`、`frida-gadget/*.xz`、`platform-tools/`（adb.exe 等）随仓分发，故压缩包很大。

### 2.3 OpenBachelorG（APK 重打包，免 root 注入）

`main.py` 全流程：`clear_last_build` → `apktool d` 解包 → 把 `frida-gadget-17.9.1-android-arm64.so.xz` 解成 `lib/arm64-v8a/libflorida.so` + 写 `libflorida.config.so`（JSON）→ `git apply` 三个 patch（对每个 `smali*` 分包目录把补丁里 `/ak/smali/` 替换成真实目录再应用，`main.py:130-162`）→ 改 `AndroidManifest.xml` → `apktool b` → `uber-apk-signer` 签名到 `ak-g-apk/`。
- gadget 两种模式（`main.py:105-127`）：`listen 127.0.0.1:10443`（`on_load=wait`，配合 C 的 `gadget_port` + adb forward 27042）或 `script-directory /sdcard/openbachelor`（独立注入，配合 C 的 `standalone_helper.py` 推 `rel/*.js` + 同名 `.config`，参数走 `parameters`）。
- `smali.patch`：在 `com/u8/sdk/U8UnityContext.<clinit>` 注入 `System.loadLibrary("florida")` —— gadget 随 SDK 静态构造加载；`smali_mumu.patch` 额外先加载 `il2cpp`。
- `misc.patch`：把 `com/hg/sdk/MTPDetection.onUserLogin` 与 `MTPProxyApplication.onProxyCreate` 清成空方法 —— **关闭鹰角反外挂 SDK（MTP）的初始化与上报**，与 `java.js` 的同名 hook 形成双保险。
- Manifest 改造（`main.py:177-249`）：包名 `com.hypergryph.arknights → anime.pvz.online`（EN → `.en`）；同步/删除 provider authorities（:191-206）；删除原包名前缀的 `<permission>`（:209-224）；`usesCleartextTraffic=true`；追加 `MANAGE_EXTERNAL_STORAGE`；`app_name` 改 “PvZ Online”。改包名 + 改 label + 重签名 → Android 视为另一个应用，**与原版共存**（README.md:5）。
- MUMU 专用降级：把 smali 里的 `"msaoaidsec"`/`"anogs"` 字符串改成 `"xlua"`（`main.py:258-268`），并用 `proxy_patch_mumu.txt`（手写 smali）**整段替换 `okhttp3.HttpUrl.get`**，重定向算法与其 `smali_gen/example/Example.java` 一致 —— 即 MUMU 上**不依赖 Frida 也能把流量导到 127.0.0.1:8443**（对应 C 的 `load_config_2461.cmd`）。

### 2.4 OpenBachelorCF（Fiddler Classic 重定向）

`main.cs:7-23` 的 `OnBeforeRequest`：域名白名单（非 `*.hypergryph.com` / `*.yostarplat.com` 一律 `Ignore()`）；对 `CONNECT` 用 `x-ReplyWithTunnel` 回一个占位串**直接结束隧道**；其余请求把 `UriScheme` 改成 `http`、`oSession.host = "127.0.0.1:8443"`。
思路：**不做 TLS 中间人、不需要装根证书**——先让客户端的 HTTPS 隧道「失败」，再把后续请求整体改写成明文 http 打到本机私服；证书校验与 URL 改写实际由客户端脚本来兜底（与 §2.2 的 java/native hook 互补）。`fc.txt`/`url.txt` 只是 Fiddler 自更新/下载地址。

### 2.5 OpenBachelorM（Mod 构建器 + 38 版 FBS schema 时间线）

**定位**：不是服务端，是把 Python mod 源码编译成 S 可加载的 `mod/<name>/*.dat`（`resource.py:299-324`；每个 .dat 是只含单条目的 ZIP，条目名 = 原 AB 名，`/`→`_`、`#`→`__` 转义）。依赖 UnityPy（MooncellWiki fork，`.env: UNITYPY_AK=1`）、flatbuffers 25、anytree、pycryptodome。

**六个 mod**：`sample_mod` / `sample_mod_win`（教学模板：改 `char_1035_wisdel` 数值、`skchr_wisdel_3` spCost、铺满 range `3-9`、level_main_00-01 改敌人与波次）、`chronosphere`（主线，2.7.61 起回溯 16 版）、`chronosphere_win`、`chronosphere_2461`（2.4.61 起回溯到 2.0.40）、`april_shuo`（act7fun 6 关，直接 `UnityPy.load` 后整包回写）。

**核心模块**：
- `resource.py`：拉 `hot_update_list.json` → 按 manifestName 下载 manifest AB → 去 0x80 头后 flatc 解 `resource_manifest.fbs`；**<2.4.01 无 FBO manifest**，改读 `torappu_index.ab` 的 MonoBehaviour typetree + `torappu.ab` 的 AssetBundleManifest 合成同构伪清单（:200-214，兼容层）。mod_table/mod_level 定位 AB → 取 TextAsset `m_Script` → 交给用户函数（装饰器自动 FBO 编解码）。
- `manifest.py`：跨版本资产合并；`is_merger_tree_path_allowed()` 只允许 `gamedata/levels/activities/*` 进合并树；`merge_special_anon_bundle()` 把 anon 包里缺失的 MonoScript 以随机 int32 key 注入，用于注册 mod 新增关卡脚本类型。
- `level_helper.py`：旧关卡迁移三段式（<2.0.40 是 bson 或 AES 加密 JSON → 2.0.40+ 直接 flatc 转码 → 统一过 `prts___levels_generated.py` 的 `InitFromPackedBuf()/Pack()` 递归补 `Undefinable` 包装）。**这就是 `fbs_codegen/` 18 个版本 Python 产物的唯一用途**。
- `helper.py:245-269`：`AES_KEY=UITpAi82pHAWwnzq` + `AES_IV_MASK=HRMCwPonJLIB3WCl`，IV = 前 16B XOR mask —— **与本仓 `scripts/vendor/lua-crypt.ts:20` 的 `LUACRYPT_MASK` 完全一致**，两条管线互相印证；`HEADER_SIZE=0x80` 亦对应 `lua-crypt.ts:12` 注释的 128B 随机头。

**FBS 资产（本次分析最有复用价值的部分）**：
- `fbs/` 共 **38 个版本（2.0.01 → 2.7.61）、1816 个 .fbs、22 MB**；表数随版本单调增长（15 → 61），两个能力台阶是 `prts___levels`（2.0.40 起）与 `resource_manifest`（2.4.01 起）。
- 首行固定 `// This file is auto-generated, see https://github.com/MooncellWiki/OpenArknightsFBS for details.` —— **与本仓 `scripts/vendor/fbs-schemas/*.json`（以及 `reference/OpenArknightsFBS-main`）同一上游**，只是表示法不同：.fbs 是 camelCase schema 源码，本仓 JSON 是 PascalCase 字段名 + 显式 slot（`slot = 4 + 2×字段序`）。
- 逐字段比对 obs 2.7.61 vs 本仓 2.7.71：`skill_table`(28 字段) 与 `resource_manifest`(11) **零差异**；`character_table`(104)、`item_table`(64)、`stage_table`(379)、`prts___levels`(232) 有少量差异且**全部单向**（本仓更新，obs 不含本仓没有的字段，共享字段顺序一致）。典型：`ItemData` 的 `reslockStatus`/`canReslock` 在 CS 2.7.71 里就声明在 `hideInItemGet` 与 `classifyType` **之间**（`reference/com.hypergryph.arknights_2.7.71.cs:91049-91051` 已复核），2.7.61 没有——即本仓 slot 序正确，obs 2.7.61 恰好是这次「中间插入导致其后 slot 全体位移」案例的插入前基线。
- **可直接复用**：本仓 `scripts/fbs-crosscheck.ts` 比较时两侧字段名都 `.toLowerCase()`（:369,374），且支持 `--fbs <dir>` 覆盖参考目录（:19,48）——obs 的 38 个版本目录可**零转换**当作历史真值源：`pnpm run schema:crosscheck -- --fbs reference/obs-fbs/2.5.04`（需先从 zip 抽出）。
- 字段量增长样例（`scripts` 统计，4 空格缩进字段行）：`character_table` 139→160、`stage_table` 220→384、`item_table` 75→84、`roguelike_topic_table` 956→1764、`activity_table` 1904→4770（2.0.61→2.7.61）。
- **限制**：obs 最高 2.7.61，**不含 2.7.71**，不能替代 CS 反编译签名链路；它的价值是「历史时间线 + 位移归因 + 老关卡解码」，不是「最新 schema 真值」。

### 2.6 OpenBachelorInsight（对局数据 + 胜率模型）

- 采集：`src/inject/main.ts` hook `Torappu.Battle.Scheduler._OnActionExecuted` 取 `randomSpawnGroupKey/PackKey`；`reader.ts` hook `Torappu.DataCenter.EnemyDuelDataCenter.AddTeamData`，读 `teamLeft/teamRight` 的 `enemyId/count`，**右侧记为负数**（左正右负的特征约定），`send()` 回 Python。
- 管线：`inject.py`（Frida attach Gadget，把键值 POST 到 `127.0.0.1:7443/obi/*`）→ `main.py`（Flask 采集器，`/obi/begin|update|end`，整局追加写 `data/tmp.jsonl`）→ `to_csv.py`（jsonl → 每对局×10 round 的特征矩阵，败方样本反向增强 + `group_id`）→ `models/baseline_lgb/{train,pred}.py`（GroupShuffleSplit 防同局泄漏，`LGBMClassifier(objective=binary, n_estimators=1000, num_leaves=50)`）→ `winrate.py`（统计每敌人出场/胜场，关联 handbook 名称出 markdown）。
- 数据：`data/*.jsonl` 15 个 3758 行；单行含 `stage_seed`、`round_0..9_seed/victor`（1=左胜 2=右胜）、`born_units`、`survive_units`；csv 71 列（67 敌人 + 3 设备键 + label），34540 样本。模型指标 train acc 0.966 / test acc 0.814、AUC 0.890。`winrate/*.md` 给出 67 个敌人实测胜率（头部多为小样本敌人 0.90，大样本敌人集中在 0.51~0.65）。
- `auto.py` 用 pyautogui 图像匹配自动点击，属于**自动化下注/刷对局**脚本。
- 对本仓的价值：**主要不是技术栈**（本仓已有 `hook/main.ts` 的 il2cpp 追踪与统一抓包存储，能力更强），而是 ① 两个 hook 点（Scheduler / EnemyDuelDataCenter）与 ② `surviveUnits/bornUnits` 的真实结构。本仓 `activity.schema.ts:221-225` 目前把这两个字段标成 `z.array(z.json())` 不读，可用 Insight 的真值把类型补全，从而支持服务端结算校验/回放/胜率统计。`res/excel/`（仅 activity_table + enemy_handbook_table 两张表）与本仓 `data/excel/` 对应表内容等价（键名 PascalCase↔camelCase），冗余，不必引入。

### 2.7 OpenBachelorSS（EnemyDuel 实时会话服，Go）

**更正一个常见误解**：SS **不是通用多人联机服**，8543 端口只有 `EnemyDuel`（`multiOperationMatch`，回合制下注对抗）一个域；8544 的 icebreaker 只有监听占位与空 registry（`pkg/contract/payloads_icebreaker.go:3-7`、`internal/game/game_icebreaker.go:16-18`），**无任何消息定义**。本仓的 `app/game/modules/multiplayer/`（ActMultiV3 多人合作，21 个占位端点）与它是两套协议，不要混用。

- 架构：`cmd/server/main.go` 两条 TCP 监听（8543 EnemyDuel / 8544 icebreaker）；`internal/session` 每连接读写双 goroutine + 1024 缓冲 channel + 10s 写超时；`internal/hub` 全局会话表 + 3s ticker 回收 10s 无活动连接；`internal/admin/server.go` 仅 1 行空壳。
- **帧格式**（`pkg/protocol/protocol.go`）：**8 字节大端定长头 = [uint32 payload 长度][uint32 消息类型] + payload**，读侧限长 1 MB。不是 JSON、不是 protobuf；payload 是手写大端二进制：字符串 = uint16 长度前缀，切片 = uint16 元素数（maxStrSize=1024 / maxSliceSize=128）。
- **消息契约**（21 个类型号，`pkg/contract/messages.go:11-34`）：S2C 11 个 `2 心跳 / 204 Quit / 206 End / 210 Step / 212 History / 214 ClientState / 220 Join / 224 Emoji / 602 TeamJoin / 702 TeamStatus / 714 Kick`；C2S 10 个 `1 心跳 / 201 Ready / 203 Quit / 211 History / 215 Bet / 217 RoundSettle / 219 Join / 221 FinalSettle / 223 Emoji / 601 TeamJoin`。未注册类型降级 `UnknownMessage` 原样透传。
- **玩法状态机**（`internal/game/game.go`，100 ms tick，6 态）：`Waiting`（等全员 ready / `multi_player_wait_sec=30` 超时）→ `Entry`（3s，随机 seed 下发）→ `Bet`（20s 下注）→ `Battle`（150s，客户端跑战斗）→ `Settle`（10s，结算发榜）→ `Finish`（10s，FinalSettle+End）。规则：最多 8 人、10 round、初始 10000 币，彩池 `roundMoneyMap` 递增 2000→50000，胜负由 `reportSide` 多数票决定，超时强制 `0b11`；`single_player: true` 时所需人数压成 1（单人可开局）。`configs/config.yaml` 缺失即 `log.Fatalf`，必须在仓库根目录启动。
- 匹配键：`TeamToken = modeID|stageID`，`gameID = TeamID|modeID|stageID`，Join 用 `SceneID|modeID|stageID` 反查。
- 附带的 `cmd/parser/main.go` 是抓包离线解析器：把 raw TCP dump 灌进 `net.Pipe`，逐帧解码再重新编码做 **字节级 round-trip 校验**，最后打印消息类型直方图 —— 若日后移植该协议，这是现成的验证模板。

---

## 3. 与本仓 DoctorateTs 的关系

### 3.1 已发生的移植（历史事实）
`api.md:1607` 起有「OBS 移植端点（2026-08-08）」小节；`design-spec.md:1818-1832` 记录用 `scripts/_diff-routes.py` 做挂载感知 diff（140 条未覆盖 → 122 条，P1 全覆盖），产出：`/gacha/cancelNormalGacha` 拼写修正、`/mail/listMailBox` 大小写对齐，以及 `quest/battleContinue`、`quest/finishStoryStage`、`quest/editStageSixStarTag`、`gacha/choosePoolUp`、`gacha/getFreeChar`、`charBuild/changeSkinSpState`、`social/setStarFriendList`、`mailCollection/getList`、`medal/setCustomData`、`gallery/saveDiyMagazineV2`、`retro/typeAct20side|competitionStart|competitionFinish` 等新增端点。
> 注意：上游参考目录 `reference/OpenBachelorS-master/` 与工具 `scripts/_diff-routes.py` **如今都已不在工作区**（只剩 obs/ 里的 zip），本报告的路由对照因此改用只读的近似方法（见 §3.2）。

### 3.2 路由覆盖近似统计（方法已标注，勿当精确结论）
对 264 条 OBS 唯一路径做两级匹配（① 全路径字面命中本仓路由声明；② 仅末段方法名命中本仓任一 `*route*/handler*.ts` 声明）：
- 全路径命中 34 条、末段命中 198 条、**两级都不命中 33 条**。
- 这 33 条集中在 SDK/账号/远端配置：`/api/game/get_latest*`、`/api/remote_config/*`、`/api/gate/meta/{Android,Windows}`、`/config/prod/official/{network_config,remote_config,...}`、`/common/{version,client-info,client-code,client-log}`、`/user/auth/v1/*`、`/user/info/v1/*`、`/u8/*`、`/yostar/get-auth`、`/general/v1/send_phone_code`、`/shop/getRepGoodList`。
- 该结果说明：**业务协议端点的移植已接近饱和**；剩余差异几乎全是登录/SDK/远端配置类，本仓由自身的 auth / `core/config` 体系承担。要对 33 条做人工抽查发现**至少 8 条是假阴性**：`/api/gate/meta/*` 在 `app/core/config/gate.ts`、`/api/remote_config/*` 在 `app/core/config/prod.ts`、`/common/{client-code,client-info,client-log,config,version}`、`/yostar/get-auth`、`/user/detail`、`/user/quick-login`（含 `/user/info/v1/send_phone_code`）都是本仓已注册的 stub（`app/game/modules/misc-alignment/routes.ts:210-228`、`app/core/auth/auth.ts:460`），只是声明形式或挂载前缀让字符串匹配失效。**真实缺口是个位数**（例如 `/shop/getRepGoodList`，OBS 自身也只是返回 `{goodList:[],newFlag:[]}` 的空实现）。要做精确结论需重建挂载感知 diff（`scripts/_diff-routes.py` 已丢失，应重写并纳入 `scripts/`）。

### 3.3 值得对照/移植的清单（按性价比排序）
| # | 目标 | obs 依据 | 本仓现状 | 建议 |
|---|---|---|---|---|
| 1 | **EnemyDuel 会话服（8543）** | `SS pkg/contract/payloads.go`（21 类型号 + 大端编码）、`internal/game/game.go`（六态状态机） | `app/game/modules/activities/enemyDuel/router.ts` 已有 HTTP 侧，且 `serverToken = "${modeId}\|${curStage}"`（:264）与 SS 的 `getModeIDStageID` 逐字一致；`serverAddress` 却指向本服自身（:150-152） | 直接照 SS 移植实时服（Node socket + `Buffer.writeUInt32BE` 帧 + uint16 前缀字符串/切片），`cmd/parser` 的 round-trip 可作验收基准 |
| 2 | **Mod 系统（hot_update_list 注入）** | `S util/mod_loader.py:85-110`（`MOD_CID=1000000` 伪 cid）、`bp_config.py:67-75`（resVersion 拼随机后缀）、`M resource.py` + `mod/*.dat` 约定 | **本仓已实现且更强**：`app/ops/assets/asset.ts`（`config.assets.enableMods`、`mods/<平台>/`、`hot_update_list` 注入、`/`→`_` `#`→`__` 下载名转义、`totalSize`/`abSize` 语义、确定性 6 位 resVersion 签名）+ `app/ops/plugin/lua-mod-builder.ts` + `scripts/pack-lua-*`、`inject-lua-inplace.ts` | 无需移植；OBS 的 `mod_loader.py` 可当**交叉校验**（两边的 .dat 约定与 `totalSize/abSize` 语义完全一致）。注意 `app/game/modules/reslock/` 是「保险库」物品仓储，与本功能无关，勿混淆 |
| 3 | **历史 FBS schema 时间线 + 老关卡解码** | `M fbs/`（38 版 1816 表）、`fbs_codegen/v2_*`（18 版 prts___levels Python） | `scripts/vendor/fbs-schemas/*.json` 只有 2.7.71；`reference/OpenArknightsFBS-main/FBS` 只有最新快照 | 抽出 obs 2.7.61 目录做 slot 位移基线（`schema:crosscheck -- --fbs <dir>` 零转换可用）；老版本关卡解码可复用 flatc 产物链 |
| 4 | **`playerDataDelta` 两级累积语义** | `S player_data.py:975-1235`（`delta` vs `pending_delta`）+ 其单测 `test/test_player_data.py:18-174` | 本仓单级 `_changes`，`delta` getter 读完即清 | 只在「跨请求攒 delta」有需求时参考，勿为对齐而改 |
| 5 | **excel 懒加载** | `S util/const_json_loader.py:87-137` | 本仓已有 excel 单例/懒加载守卫（`tests/unit/architecture/excel-singleton-ratchet.test.ts`） | 仅作交叉验证 |
| 6 | **`surviveUnits/bornUnits` 类型化** | `Insight reader.ts` + `data/*.jsonl` | 本仓 `activity.schema.ts:221-225` 是 `z.array(z.json())` | 低风险、直接消类型债，可支撑结算校验 |
| 7 | **加密常量互证** | `M helper.py:245-269`（AES KEY/IV_MASK） | `scripts/vendor/lua-crypt.ts:20-44` 常量与算法逐字对应 | 作为 excel/关卡解密链路的独立旁证 |
| 8 | **客户端注入基建** | `C adb.py:221-225`（adb reverse 8443/8543/8544 + frida-server 改名伪装）、`G main.py`（gadget 双模式 + 改包名共存）、`CF main.cs`（CONNECT 隧道占位绕过） | 本仓有 `scripts/proxy-harness.ts`（转发 + 路由表 + keep-alive 处理）、`hook/main.ts`（**活跃**：`SDKConst$UrlInfo.getRemoteUrl` :238/:245 + `Il2Cpp.dump` :257）、`scripts/frida-observe.ps1`（PC 停 ACE 后 spawn）、`scripts/apk-lua.ts`（APK 内 Lua 注入） | 本仓在 PC/APK-Lua 两条路已完备，**缺的是「免 root Android + frida-gadget」这条**；可借鉴 `adb reverse` 端口编排、gadget 双模式、`libflorida` 改名、`{type:"conf",k,v}` 注入协议 |
| 9 | **证书/签名绕过点位清单** | `native.js`：`BouncyCastleCertVerifyer.IsValid`、`CryptUtils.VerifySignMD5RSA`、`RSACryptoServiceProvider.VerifyHash`、`android_dlopen_ext` 屏蔽；`java.js`：`TrustManagerImpl.checkTrusted`、`NetworkSecurityPolicy.setInstance`、`okhttp3.HttpUrl.get` | `hook/main.ts` 里 `Networker.get_overrideRouterUrl`（:277-283）与 `CryptUtils.VerifySignMD5RSA`（:288-289）**都在 262-338 的块注释内、当前未生效**（与 C 的能力等价，需要时解注即可） | 抓官服 HTTPS / PC attach 时可直接复用；注意解注前确认 ACE/反外挂行为 |
| 10 | **战斗数值模型 getter 索引** | `trainer.js` 17 组命令被 hook 的官方方法名（`Card.get_cost`、`get_dontOccupyDeployCnt`、`get_remainingCnt`、`get_cardPolicy`、`get_maxTargetNum`、`Entity.get_lifePointReduce`、`RangeSelector`、`AuraAbility`…） | 本仓 battle 模块与 CS 反编译源 | 逐字段对照官方战斗模型，用于补全/校验战斗实现 |
| 11 | **客户端表名映射** | `C dump.py:11-62`（`Torappu.XxxDB` → `xxx_table`） | 本仓 `data/excel/*.json` 命名 | excel 溯源/表名核对的小抄 |

### 3.4 三个可直接执行的结论
1. **协议侧**：端点移植已饱和——近似 diff 的 33 条「未命中」经抽查至少 8 条是假阴性（`/api/gate/meta`、`/api/remote_config`、`/common/*`、`/user/quick-login` 等本仓都已有 stub），真实缺口是个位数且多为空数组 stub。下一步增量在**实时会话服（SS）**与**免 root 客户端注入（C+G）**。
2. **Schema 侧**：把 obs 的 `fbs/2.7.61`（必要时 2.5.04/2.6.91）抽到 `tmp/` 下，用现成的 `--fbs` 参数跑 `schema:crosscheck`，即得到一条**独立于 CS 签名**的历史校验；obs 不含 2.7.71，不可作为最新版门禁。
3. **文档侧**：`api.md` 里应补一句参考源现状（`reference/OpenBachelorS-master/` 与 `_diff-routes.py` 已不在工作区，参考包保留在 `reference/obs/*.zip`），否则后来者按旧路径找不到文件。

---

## 4. 风险与合规提示

- 该套件面向《明日方舟》官服：`G misc.patch` 显式关闭反外挂 SDK，`C` 的 trainer 提供 17 条作弊指令，`Insight` 的胜率模型 + `auto.py` 自动点击组合起来是**对局内下注预测/自动下注**，属于对官方服务与游戏公平性的直接破坏。本仓若引用其**协议/数据结构**（如 SS 的消息编码、Insight 的字段结构）需限定在私服自用场景，不要复用其反外挂绕过与作弊实现。
- `C` 的核心脚本以 `.encrypted` 发布且**未随包提供密钥**（`key_v1.png` 缺失），只公开编译产物；引用其 `rel/*.js` 时注意许可证与来源标注。
- obs 的 `res/`、`res_2461/`、`res_en/` 是官方游戏数据（数百 MB），**不要复制进本仓**（本仓 `data/excel` 已有自己的官方热更链路，且 AGENTS 明确 excel 为生成文件、禁止手改）。
- 测试/CI 覆盖极弱：`Insight` 无测试，`SS` 只有 `protocol_test.go`/`payloads_test.go` 两个单测且无 CI，`S` 仅 7 个测试文件。其实现是「能跑通」级别，移植时不要假定边界处理完备（如 SS 限长之外的畸形帧、Insight 无输入校验）。

---

## 5. 附录

### 5.1 端口约定（各项目 config 汇总）
| 端口 | 用途 | 出处 |
|---|---|---|
| 8443 | 主服 HTTP（私服） | S `conf/config.json:2`、C `port` |
| 8543 | EnemyDuel 实时会话服 | S `multiplayer_addr`、SS `server.addr`、C `multiplayer_port` |
| 8544 | icebreaker（空壳） | S `icebreaker_addr`、SS `icebreaker_server.addr` |
| 9443 | Frida server 端口（C） | C `frida_port` |
| 10443 | frida-gadget listen（C/G） | C `gadget_port`、G `GADGET_PORT` |
| 27042 | Frida 默认端口（C 探测） | `C inject.py:test_remote_port` |
| 7443 | Insight 采集 Flask | `I src/openbachelori/inject.py` |

### 5.2 M 的 FBS 版本覆盖（38 版，节选）
`2.0.01/15 表 → 2.0.40/39 → 2.2.61/41 → 2.4.01/46 → 2.5.04/56 → 2.6.01/58 → 2.7.11/60 → 2.7.61/61`；`prts___levels` 自 2.0.40 起、`resource_manifest` 自 2.4.01 起。`fbs_codegen/` 覆盖 2.4.61~2.7.61 共 **18 个版本目录**，其中 3 组连续版本的 `prts___levels_generated.py` 字节完全相同（v2_6_01~41、v2_6_61~v2_7_11、v2_7_21~41）＝这些版本 schema 无变化；**9 个版本目录（v2_6_82 起）缺 `__init__.py`**，靠 PEP 420 侥幸可 import，打包会丢。

### 5.3 复现命令（只读，产物落 tmp/）
```bash
# 列出某个 zip 的结构（本机无 unzip/7z，用 python 标准库）
python3 - <<'EOF'
import zipfile; z=zipfile.ZipFile('reference/obs/OpenBachelorSS-master.zip')
print('\n'.join(z.namelist()))
EOF

# 把 obs 的某个版本 fbs 抽出来做历史 schema 交叉校验（示意）
python3 -c "
import zipfile,os
z=zipfile.ZipFile('reference/obs/OpenBachelorM-master.zip'); p='OpenBachelorM-master/fbs/2.7.61/'
[ (os.makedirs('tmp/obs-fbs/2.7.61',exist_ok=True), open('tmp/obs-fbs/2.7.61/'+n.split('/')[-1],'wb').write(z.read(n))) for n in z.namelist() if n.startswith(p) and n.endswith('.fbs') ]"
pnpm run schema:crosscheck -- --fbs tmp/obs-fbs/2.7.61
```

### 5.4 本次分析的产物与口径
- 报告：本文件；分项原始报告在 `tmp/obs-analysis/{M-analysis.md, OpenBachelor客户端三件套分析报告.md}`。
- 抽取的源码树（仅供对照，已 gitignore）：`tmp/obs-analysis/{S,C,M,I,SS}`。
- C 的可读副本：`tmp/obs-analysis/C/rel/{java,native,extra,trainer}.clean.js`（对官方发布的 `rel/*.js` 做三重字符串解码得到；**C 的原始 TS 源码因 `key_v1.png` 未发布而不可得**，§2.2 的脚本结论均出自这些副本，属反混淆推断而非源码原文）。
- 口径声明：本报告所有结论都给了「文件 + 行号/函数名」级证据；§3.2 的路由覆盖是**近似统计**（方法见该节），不是精确 diff；`reference/` 下未做任何修改；所有临时产物都在 gitignore 覆盖的 `tmp/` 内，可随时删除。
