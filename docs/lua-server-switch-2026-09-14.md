# 服务器切换与上报截断（Lua 插件）

> 日期：2026-09-14 · 客户端基线 2.7.71（可 hotfix 目标以 `tmp/dts-dump/` 的 il2cpp 签名为准）
> 源码：`lua/plugin/plugins/NetworkRedirectPlugin.lua`（服务器切换）、`lua/plugin/plugins/EventLogBlockPlugin.lua`（上报截断）
> 相关：`docs/lua-plugins-guide.md` §2.0.1/§2.0.2（使用与打包）、`docs/lua-plugin-dev-reference.md`（插件开发契约）

---

## 1. 交付物

| 文件 | 变更 |
| --- | --- |
| `lua/plugin/plugins/NetworkRedirectPlugin.lua` | 由「写死单一私服地址」改为**多预设服务器切换**：预设表 + 选项 + 游戏内「服务器」浮窗 + **network_config 验签放行**（见 §4） |
| `lua/plugin/plugins/EventLogBlockPlugin.lua` | 新增：**官方日志/埋点上报截断**（三条互补拦截线） |
| `lua/plugin/PluginDefs.lua` | `network_redirect` 更名「服务器切换」；新增 `event_log_block` |
| `lua/plugin/core/PluginOptions.lua` | 新增 `network_redirect.server`（enum，7 预设）与 `event_log_block` 三开关 |
| `app/ops/plugin/plugin-catalog.ts` / `app/ops/admin/api-spec.ts` / `data/plugin/config.json` | 服务端目录与文档同步 |
| `tests/unit/plugin/plugin-module-layout.test.ts` | 新增两条守卫：选项 id 不得为孤儿；预设 value 与选项 choices 逐项一致 |
| `tests/unit/plugin/{lua-chunk-builder,plugin-config-service}.test.ts` | 模块数 16→17、目录顺序补 `event_log_block` |

两个插件都在 `PluginDefs.lua` 登记，遵循「一插件一职责」：切换只管网络出口，截断只管上报出口。

---

## 2. 服务器预设

`SERVER_PRESETS`（插件文件内，顺序即面板行顺序）。端址来源：`docs/多服支持-可行性探索.md` §3 实测表与
`reference/opendoctoratepy-ex-public/tools/update_config.py`。

| value | 面板名 | 基址 | 状态 |
| --- | --- | --- | --- |
| `local` | 本地私服 | `http://127.0.0.1:8443` | **默认**，与历史行为一致（端口同 `data/config.json` 的 `PORT`） |
| `official_cn` | 国服官服 | `https://ak-conf.hypergryph.com` | 实测可达 |
| `official_tw` | 台服官服 | `https://ak-conf-tw.gryphline.com` | 实测可达（version/热更清单结构与国服一致） |
| `official_jp` | 日服官服 | `https://ak-conf.arknights.jp` | 域名可达，`/config/prod/official/*` 路径社区未实测通 |
| `official_kr` | 韩服官服 | `https://ak-conf.arknights.kr` | 同上 |
| `official_en` | 国际服官服 | `https://ak-conf.arknights.global` | 同上 |
| `custom` | 自定义 | 文件顶部 `CUSTOM_SERVER_BASE`（默认空 = 不重定向） | 用户自填域名/局域网 IP |
| — | — | — | 路由地址 = 基址 + `/config/prod/official/network_config` |

契约与守卫：预设 `value` 必须与 `PluginOptions` 的 `server` 枚举 `choices` **逐项一致**，
`tests/unit/plugin/plugin-module-layout.test.ts` 的「服务器切换预设与选项 choices 逐项一致」用例固化；
新增/改名预设时两处同时改，否则守卫失败。

---

## 3. 切换机制与生效时机

hotfix 目标（实例属性 getter，包装模式，保留其它插件的链）：

| 目标 | 签名证据 |
| --- | --- |
| `Torappu.Network.Networker.get_overrideRouterUrl` | `tmp/dts-dump/Torappu.Common.cs` `__Hotfix0_get_overrideRouterUrl`（`0x28`） |
| `Torappu.Network.NetworkRouter._DeserializeRouterContent` | `tmp/dts-dump/Assembly-CSharp.cs:102665` `__Hotfix0__DeserializeRouterContent`（见 §4） |

- 客户端启动取路由配置时读一次该 getter ⇒ **切换后需重启客户端**（面板与选项描述均已提示）。
- 选择 `custom` 且基址为空时返回 `nil` 并回退 `orig`，即「跟随客户端默认路由」。
- 切换入口：游戏内右下角「服务器」浮窗（点击整行即切换，当前项高亮并标「当前」）或「选项」面板的
  `server` 枚举（`<` / `>` 循环）；写盘 + `PluginHeartbeat.PushOption` 同步服务端，管理端也能看到取值。
- 面板按 `PluginUI` 标准模式构建：自建 Overlay 画布 + 自绘点击 + `RetryEnsure` 自愈链 + 拖标题栏移动，
  与 `PanelPlugin` / `OptionsPanelPlugin` 一致（见 `docs/lua-plugin-dev-reference.md` §7）。

---

## 4. 验签放行（上下游追踪）

### 4.1 上下游链路

```
NetworkRouter 启动取配置
  _SendFetchConfigService()            // Networker.SendGet(<overrideRouterUrl>)
    → _DeserializeRouterContent(responseText)   ← 唯一解析 network_config 的出口（私有静态）
        → CryptUtils.VerifySignMD5RSA(content, sign, GlobalOptions.cryptoPubKey.text)
             验证失败 → throw NullReferenceException → 启动失败
```

| 层 | 目标 | 能否 Lua hotfix | 依据 |
| --- | --- | --- | --- |
| 验签函数 | `Torappu.CryptUtils.VerifySignMD5RSA`（string/byte[] 两个重载） | ❌ 无桥 | `Assembly-CSharp.cs:94500` 的 CryptUtils 类**无 `__Hotfix0_` 字段** |
| **调用方（采用）** | `Torappu.Network.NetworkRouter._DeserializeRouterContent` | ✅ 有桥 | `Assembly-CSharp.cs:102665` `__Hotfix0__DeserializeRouterContent` |
| 信任锚 | `Torappu.GlobalOptions.cryptoPubKey`（公有 `TextAsset` 字段） | ✅ 可写 | `Torappu.Common/Torappu/GlobalOptions.cs:29` |

### 4.2 实现：三级递进放行

在**唯一调用方** `_DeserializeRouterContent` 上包装（私有静态，先 `xlua.private_accessible`）：

1. **原实现成功**（官服 / 客户端已换我方公钥 / 签名匹配）⇒ 原样返回，零副作用；
2. **私服预设且原实现抛错** ⇒ 临时把信任锚 `GlobalOptions.cryptoPubKey` 换成 `TextAsset(我方公钥 XML)`
   重放一次原实现，**成败都立即还原**（解析仍走游戏自身路径，不做 Lua 侧重建）；
3. **仍失败**（服务端未配密钥对、`sign` 为占位符）⇒ 按未验签内容接管：
   `rapidjson.decode` 取 `content` → `JsonConvert.DeserializeObject(content, Type.GetType(
   "Torappu.Network.NetworkRouterConfig+Content, Torappu.Common"))`。

选择官服预设时**不介入**（原样重放，保留原异常类型）。

> 为什么不做「全局换锚」：`VerifySignMD5RSA(byte[],byte[],string)` 同时服务 network_config、
> excel/DB 的 `CrypticConverter_WithSign` 与 Lua 资产；全局换锚会让**官服签名的 excel/DB 资产全部验不过**
> （`docs/lua-asset-signature-2026-09-14.md` §146 记录过同类事故），故只在这一次解析窗口内换、且立即还原。

### 4.3 与资产公钥替换的关系

- `pnpm run sign:key -- --patch-apk`（替换 asset 公钥）仍是**内置 Lua bundle 自身**能被加载的前提
  ——`entry.lua` 的 128B 头在插件运行前就已被校验，Lua 侧无从干预；本插件负责的是**它运行之后**的验签。
- `--sync-plugin` 会按 `local PUBLIC_KEY_XML = [[…]]` 正则回写插件内公钥（常量格式不要改），
  保证「插件带的公钥 == 服务端 `data/crypto/private.pem` 的配对公钥」。未配密钥对时走第 3 级兜底。
- **已替换资产公钥的客户端无法连接官方服务器**：官服响应验签走 `Torappu.DB.*Converter_WithSign`
  （同样无 hotfix 桥），切回官服需还原官方公钥资产；面板底部已提示。

---

## 5. 上报截断（EventLogBlockPlugin）

官方埋点/日志上报分三层，插件对**上游入口**逐一截断（选项可分别关闭）：

| 线 | 选项 | hotfix 目标 | 签名证据 |
| --- | --- | --- | --- |
| 埋点源头 | `block_sdk` | `Torappu.EventTrack.EventLogTrace._LogToSDK` | `Assembly-CSharp.cs:177407` `__Hotfix0__LogToSDK` |
| 埋点源头 | `block_sdk` | `Torappu.SDK.SDKGameBI._IsSysEnabled` / `_SetData` | `Assembly-CSharp.cs:101493/101494` |
| 上报请求 | `block_http` | `Torappu.Network.Networker.SendGet` / `SendPost` | `Torappu.Common.cs:10288/10290/10291`（含 `__Hotfix1_SendPost` 重载） |
| SDK 心跳 | `pause_beat` | `CS.Hypergryph.SDK.HGEventLogSDKAppInstance.PauseBeat()` + `EnableRealTimeSend(false)` | 无 hotfix 桥，只能经 `CS.*` 直接调用（pcall 兜底） |

- `_LogToSDK` 是游戏侧**唯一**的 C# 埋点出口（全仓仅 `EventLogTrace.cs:4492` 调 `HGEventLogSDKAppInstance.EventTrack`）。
- 上述私有方法挂补丁前需 `xlua.private_accessible(类)`，否则取不到目标。
- 命中上报路径时返回一个**已取消**的 `WebHttpResult`（不发出任何请求），不返回 `nil`，避免调用方空指针。

### 5.1 上报路径清单与匹配口径

**精确路径匹配**（去 query、去 host、去尾斜杠、小写后比较），清单来源：
`docs/接口覆盖分析-未实现与stub清单.md` §3.1（遥测/埋点 stub）与
`reference/opendoctoratepy-ex-public/server/constants.py` 的 `FILTER_PATHS_SET`。

```
/event  /batch_event  /beat  /deviceprofile/v4  /analytics/collect
/gameBulletin  /loggw/logUpload.do  /mgw.htm  /survey/startSurvey  /pb/async  /rqd/async
前缀：/iedsafe/
```

用**精确**而非子串匹配，是为了不误伤游戏接口：`/deepSea/event`、`/rlv2/finishEvent`、
`/sandboxPerm/sandboxV2/eventChoice` 等路径含 `event` 但属正常业务。

### 5.2 边界

`Hypergryph.EventLogSDK`（C#）与 `libHGEventlog.so` / `com.hypergryph.eventlog`（native/Java）无 hotfix 桥，
Lua 只能截其上游调用；若某事件由 Java 侧自采（不经 `EventLogTrace` / `SDKGameBI`），本插件不覆盖。
另外 `/event` `/batch_event` `/beat` 等请求若由 native SDK 直接发出（不经 `Networker`），
`block_http` 也拦不到——这类流量由域名/DNS 层或抓包网关兜底。

---

## 6. 配置

`plugin_config.json`（设备侧）与 `data/plugin/config.json`（服务端侧）选项键：

| 插件 id | key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `network_redirect` | `server` | enum | `local` | 见 §2；切换后重启生效 |
| `event_log_block` | `block_sdk` | switch | `true` | 埋点源头（EventLogTrace + SDKGameBI） |
| `event_log_block` | `block_http` | switch | `true` | 上报请求（Networker 路径防火墙） |
| `event_log_block` | `pause_beat` | switch | `true` | 埋点 SDK 心跳/实时上报 |

插件目录缺省全部启用（客户端与服务端一致）；新增 id 无需迁移配置。

---

## 7. 验证

本次已跑：

```bash
node tmp/check-lua-syntax.mjs                     # 17 个文件全部通过
./node_modules/.bin/vitest run tests/unit/plugin  # 33 passed；1 个 lua-mod-builder 用例失败（先行存在，见下）
./node_modules/.bin/vitest run tests/unit/scripts/repack-lua-bundle.test.ts \
  tests/unit/scripts/pack-lua-min.test.ts tests/unit/scripts/watch-lua-plugins.test.ts \
  tests/unit/game/router/plugin-heartbeat.test.ts # 22 passed
tsc -p tsconfig{,.scripts,.tests}.json --noEmit --incremental false   # 三份均 0 错误
```

> `tests/unit/plugin/lua-mod-builder.test.ts` 的「参考目录更新后再次 from-ref 构建」用例在
> **HEAD 基线 worktree** 上同样失败（基线还多挂一个用例），属该测试与文件系统/构建时序的既有问题，
> 与本次改动无关（本次未触碰 `app/ops/plugin/lua-mod-builder.ts` 与该测试）。

真机验收建议：

1. 打包：`pnpm run repack:lua`（或 `pnpm run watch:lua`）；
2. 设备日志：`[NetworkRedirectPlugin] 服务器切换已启用: local` / `[EventLogBlockPlugin] 上报截断已启用`；
3. 面板：右下角出现「服务器」浮窗，点击行后状态行变「当前」，`plugin_config.json` 的
   `options.network_redirect.server` 随之变更；
4. 截断：服务端不再出现该客户端的 `/batch_event` `/beat` `/event` 请求；日志无 Lua 异常。

---

## 8. 已知限制与后续

1. 日/韩/国际服的 `network_config` 路径未实测；若 404，把对应预设的 `base` 改成实测地址即可（守卫会同步校验）。
2. 放行链路的**新机制待真机验收**（§4.2 三级）：需在设备侧确认日志出现
   `network_config 验签已按我方公钥放行` 或 `已按未验签内容接管`；两条都不出现时应看
   `信任锚不可用` / `换锚重放仍失败`，分别指向 `GlobalOptions` 未就绪与公钥/私钥不配对。
   `_Static1Fix` 的静态方法实参自适应（xLua 对静态方法是否带 nil self）也需真机日志确认。
3. 官方服务器可达性仍受资产公钥约束：已换我方公钥的客户端连官服必失败（`Torappu.DB.*Converter_WithSign`
   无 hotfix 桥），本插件不覆盖；未换公钥的客户端选官服预设时插件完全不介入验签。
4. `pause_beat` 依赖 `HGEventLogSDKAppInstance` 类型可经 `CS.*` 访问（反射模式）；不可用时只记日志，
   其余两条线不受影响。
