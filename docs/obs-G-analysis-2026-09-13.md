# OpenBachelorG 深度分析（APK 重打包 + frida-gadget 免 root 注入）

- 对象：`reference/obs/OpenBachelorG-master.zip`（38.4 MB / 26 条目），已解到 `tmp/obs-analysis/G/`
- 定位：obs 三件套里的 **G**adget —— 把官方 APK 用 apktool 拆开、植入 frida-gadget、改包名共存、重编译签名；
  与 **C**（adb+frida-server，root 路线）互补，G 走的是**免 root**路线
- 掩护命名：包名 `anime.pvz.online`（EN 版 `anime.pvz.online.en`）、应用名 `PvZ Online`、gadget 库名 `libflorida.so`
- 上游 README 明说「For PvZ Online / Compatible with OpenBachelor Client / Able to coexist with original apk」

## 1. 包内清单

| 条目 | 大小 | 作用 |
| --- | --- | --- |
| `main.py` | 8.1 KB / 318 行 | 全流程编排（解包→注入→patch→改清单→回编译→签名） |
| `apktool.jar` | 25.3 MB | 解包/回编译（**要重编译 smali + 资源**） |
| `uber-apk-signer.jar` | 3.1 MB | zipalign + v1/v2/v3 重签 |
| `frida-gadget-17.9.1-android-arm64.so.xz` | 6.8 MB | gadget 本体（LZMA） |
| `smali.patch` / `smali_mumu.patch` | 0.5 / 0.6 KB | 往 `U8UnityContext.<clinit>` 注入 `loadLibrary` |
| `misc.patch` | 1.3 KB | **把 MTP 检测/上报改成空实现**（反作弊相关） |
| `proxy_patch_mumu.txt` | 2.0 KB | MuMu 专用：替换 `okhttp3/HttpUrl.get` 做**全量流量重定向** |
| `smali_gen/` | 2.3 MB | javac+dx+baksmali 试验田（`Example.java` → `.smali`，用来验证 smali 片段） |
| `build_apk{,_mumu,_standalone}.cmd` | — | `python main.py [--mumu|--standalone]` |

> 仓库 `tmp/obs-analysis/G/` 只解出了文本（jar 与 gadget `.xz` 未落盘），需要时从 zip 现取。

## 2. 全流程（`main.py` 逐段）

```
clear_last_build()            # 删 ak/ ak-g-unsigned.apk ak-g-apk/（Windows rmdir/del）
decode_apk()                  # java -jar apktool.jar d <官方apk> -o ak
unzip_gadget()                # lzma 解 gadget → ak/lib/arm64-v8a/libflorida.so
write_gadget_conf(standalone) # 写 ak/lib/arm64-v8a/libflorida.config.so（JSON，见 §3）
modify_smali[_mumu]()         # git apply smali*.patch（见 §4）
modify_manifest()             # 改包名/删 provider/删 permission/开 cleartext/加权限（见 §5）
modify_name()                 # res/values{,-zh}/strings.xml 的 app_name → "PvZ Online"
apply_misc_patch()            # git apply misc.patch（关 MTP，见 §6）
[--mumu] unload_lib_mumu()    # smali 里 "msaoaidsec"/"anogs" → "xlua"（见 §7）
[--mumu] proxy_patch_mumu()   # 替换 okhttp3/HttpUrl.get 为 redirect_url（见 §7）
build_apk()                   # java -jar apktool.jar b ak -o ak-g-unsigned.apk
sign_apk()                    # java -jar uber-apk-signer.jar -a ... -o ak-g-apk
```

## 3. gadget 的两种交互模式（`write_gadget_conf`）

| 模式 | 配置 | 配合方 |
| --- | --- | --- |
| `listen`（默认） | `{"interaction":{"type":"listen","address":"127.0.0.1","port":10443,"on_port_conflict":"fail","on_load":"wait"}}` | C 的 `gadget_port=10443` + `adb forward tcp:27042→10443`，由宿主 Frida `attach("Gadget")` |
| `script-directory`（`--standalone`） | `{"interaction":{"type":"script-directory","path":"/sdcard/openbachelor"}}` | C 的 `standalone_helper.py` 推 `rel/*.js` + 同名 `.config` 到该目录，**完全免宿主**，参数经 gadget `parameters` 传入 |

要点：`on_load:"wait"` = 启动即阻塞等宿主连接（保证不错过早期 Java 类加载）；`libX.config.so` 是 gadget 约定的**伴生配置命名**（同目录、同前缀 + `.config.so`）。

## 4. 注入点（`smali.patch` / `smali_mumu.patch`）

官方 `com/u8/sdk/U8UnityContext.smali` 的静态构造器本来是空的：

```smali
.method static constructor <clinit>()V
    .locals 0
    return-void
.end method
```

两个 patch 都**插入指令**（原 `.locals 0` → `.locals 1/2` + `const-string` + `invoke-static loadLibrary`）：

```smali
# smali.patch        → loadLibrary("florida")
const-string v0, "florida"
invoke-static {v0}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V

# smali_mumu.patch   → 先 loadLibrary("il2cpp")，再 loadLibrary("florida")
```

- 选 `U8UnityContext.<clinit>` 是因为 SDK 一启动就会被引用，**保证 gadget 在游戏早期就加载**；
- MuMu 变体先显式 `loadLibrary("il2cpp")`——ARM 翻译层下 gadget 与 il2cpp 的加载顺序会影响符号可见性（与我们实测
  「MuMu 上 `libil2cpp.so` 对宿主 Frida 不可见」是同一类问题）；
- `apply_patch()` 的实现值得一提：patch 文件里用**占位路径** `/ak/smali/`，脚本对 `ak/` 下每个 `smali*` 分包目录替换成
  真实目录名后写到 `patch_tmp/`，再 `git apply -v` —— 这样**同一个 patch 能适配任意 dex 分包数量**。

## 5. `modify_manifest()` 做了什么

| 动作 | 细节 |
| --- | --- |
| 包名 | `com.hypergryph.arknights` → `anime.pvz.online`；`com.YoStarEN.Arknights` → `anime.pvz.online.en`；其它直接 `raise` |
| ContentProvider | 非 `com.YoStarEN.Arknights` 前缀的 provider **一律删除**；EN 前缀的重写 authorities |
| permission | 删除所有 `com.hypergryph.arknights*` / `com.YoStarEN.Arknights*` 自定义权限声明 |
| 明文流量 | `android:usesCleartextTraffic="true"` ← **Java/okhttp 重定向到 `http://127.0.0.1:8443` 的前提**（Android 9+ 默认禁明文） |
| 存储权限 | 追加 `android.permission.MANAGE_EXTERNAL_STORAGE`（推脚本/读日志方便） |

## 6. `misc.patch`：关闭 MTP（反作弊）——**本仓红线**

```smali
# com/hg/sdk/MTPDetection.smali
.method public onUserLogin(...)V   →  .locals 0 / return-void     # 不再上报登录
# com/hg/sdk/MTPProxyApplication.smali
.method public onProxyCreate()V     →  .locals 0 / return-void     # 不再 initSDKWhenAppCreate/initWhenActivityCreate
```

即把 `com.hg.sdk` 的 **MTP（腾讯移动安全/反作弊上报）** 入口改成空函数。这属于「绕过官方反作弊」，
按本仓红线（`docs/no-root-injection-chain-2026-09-13.md` §7）**不进入本仓代码与发布产物**。

## 7. MuMu 专属处理

```python
unload_lib_mumu():   smali 内 "msaoaidsec" → "xlua"；"anogs" → "xlua"   # 让这两个 native 库不加载
proxy_patch_mumu():  用 proxy_patch_mumu.txt 整体替换 okhttp3/HttpUrl.smali 的 get(String)
```

1. **库名替换**：把 `System.loadLibrary("msaoaidsec")` / `"anogs"` 的参数换成 `"xlua"`（已加载过的库名，二次加载是 no-op）
   → MSA OAID 与 ANOGS 组件在 MuMu 上不加载、不崩溃。**注意**：2.7.71 的 `lib/arm64-v8a/` 里只有
   `libmsaoaidsec.so`（1.7 MB，与我们找到的 MSA OAID 证书对应），**没有 `libanogs.so`** ⇒ `"anogs"` 那条在本版本是 no-op。
2. **Java 层全量重定向**（`proxy_patch_mumu.txt`，逻辑等价于包内 `smali_gen/example/Example.java`）：

```java
public static String redirect_url(String url) {
    String proxy_url = "http://127.0.0.1:8443";
    if (url.startsWith("https://") || url.startsWith("http://")) {
        int i = url.indexOf("://") + 3;
        int j = url.indexOf("/", i);
        if (j == -1) return proxy_url;
        return String.format("%s%s", proxy_url, url.substring(j));   // 保留 path?query
    }
    return url;
}
// 再把 okhttp3/HttpUrl.get(String) 换成 redirect_url + Builder.parse + build
```

   这样**所有走 okhttp 的 Java 请求（SDK/热更/账号）全部打到 `127.0.0.1:8443`**，比我们改 Unity 资源里域名的
   `apk:url-redirect` 覆盖得更彻底（C#/UnityWebRequest 与 Java/okhttp 一并接管）。

## 8. 与本仓现状的对照

| 能力 | G 的做法 | 本仓现状 | 结论 |
| --- | --- | --- | --- |
| 改包名共存 | apktool 解包 → 改 `AndroidManifest` 的 `package` → 回编译 | `pnpm run apk:rename`（**zip 级等长二进制改写**，AXML/arsc/dex/配置，免反编译） | **本仓更轻**：不用 apktool、不改变 dex/资源结构（ACE 风险更低） |
| 流量接管 | 改 Unity 资源域名（C 侧）+ **Java okhttp 全量重定向**（G） | `apk:url-redirect`（Unity 资源字符串等长改写） | **G 多一层 Java 侧**：我们的方案覆盖不到 Java SDK/热更清单请求 |
| 免 root 注入 | gadget 植入 + `loadLibrary` 注入点（需重编译 smali） | 只有 `frida-server`（需 root）与 `frida-log.py` | G 的链路本仓缺；但**注入点必须插指令/新增 .so**，zip 级等长改写做不到（见 §9） |
| 反作弊处理 | `misc.patch` 关 MTP + 库名替换躲检测 | 不碰 ACE/MTP（红线） | **G 靠关反作弊才跑通**——反向印证我们的红线判断 |
| 明文流量 | `usesCleartextTraffic=true` | 未改（我们只改了 Unity 资源里的域名，未验证过 App 内 http 明文请求） | Java/okhttp 侧要重定向到 `http://` 就**必须**开（Android 9+ 默认禁明文）；C# 侧 UnityWebRequest 走原生栈、一般不触发该策略，但**本轮未实测** |
| smali patch 复用 | 占位路径 + 遍历 `smali*/` 分包的 `git apply` 模式 | 无（不走 smali） | 若将来引入 dex 级补丁工作流，这是现成范式 |

## 9. 为什么「gadget 注入」在本仓的等长改写路线上不可行

G 的注入点 `U8UnityContext.<clinit>` 原始是 `.locals 0` 的空方法 ⇒ 必须**插入** `const-string` + `invoke-static` 指令，
dex 文件会变长（不是等长替换）。本仓的 `apk:rename`/`apk:url-redirect` 走的是「字符串等长替换 + zip 级重写」，
无法插入指令。若想继续零反编译：

- 需要找到一个**已存在、会被加载、且名字恰好 7 字符（= `florida`）**的 `loadLibrary` 参数供等长替换；
  2.7.71 已确认的原生库名为 `tersafe2`(8)、`msaoaidsec`(10)、`CrashSight`(10)、`main`(4)、`il2cpp`(6)、`unity`(5)、
  `xlua`(4)、`tprt`(4)、`smsdk`(5)… **没有 7 字符候选**；而且即便改 `tersafe2` 那类名字，也等于让反作弊不加载（红线）。
- 因此免 root 注入若要做，只有两条：① 走 G 的 apktool/smali 重编译（本仓不采纳其关反作弊部分，且重签包仍会被 ACE 终止，
  见 `docs/apk-mod-2771-2026-09-13.md` §8.7）；② **继续用 Frida attach 路线**（本仓已有 `scripts/frida-log.py`、
  `hook/verify-sign.js`），在能 root 的环境下 work。

## 10. 可借鉴清单（按可落地性排序）

1. **Java/okhttp 层重定向思路** → 建议给本仓补一个 **Frida Java hook** 版（不改包、ACE 安全）：
   `hook/java-redirect.js`：`Java.perform` 里 hook `okhttp3.HttpUrl.get/parse` 把 host 换成私服 +
   hook `android.security.NetworkSecurityPolicy.isCleartextTrafficPermitted` 返回 `true`（否则 http 明文被挡）。
   这样能覆盖我们 `apk:url-redirect` 覆盖不到的 Java SDK/CDN 请求。
2. **gadget 双模式配置范式**（`listen`+`on_load=wait` / `script-directory`+`parameters`）——若将来要做免 root 独立注入，
   配置格式可直接照用（`libX.so` + `libX.config.so` 伴生命名）。
3. **MuMu 特化的两条经验**：① 先加载 `il2cpp` 再加载注入库；② `msaoaidsec` 在模拟器上易出问题（本包 2.7.71 有，
   `anogs` 无）。这两条解释了我们 MuMu 调试中遇到的「guest 模块不可见」「早期崩溃」现象。
4. **manifest 处理清单**：删无用 provider、删自定义 permission、`usesCleartextTraffic=true`、加 `MANAGE_EXTERNAL_STORAGE`
   —— 我们若增加「私服 http 直连」支持，第 3 项是必需的（但**加属性会改变 AXML 长度**，等长改写做不到，
   需评估 apktool 或改用 https+自签 CA）。
5. **多 dex 分包 patch 循环**（占位路径 + `git apply`）——未来若引入 smali 级补丁的范本。

### 明确不采纳（红线）

- `misc.patch` 关闭 MTP 检测/上报（反作弊绕过）；
- `unload_lib_mumu` 用库名替换让 MSA/TSS 组件不加载（规避检测）；
- 以「躲进程名/躲检测」为目的的改名伪装（C 的 `libflorida-123-<arch>.so` 同类）。
