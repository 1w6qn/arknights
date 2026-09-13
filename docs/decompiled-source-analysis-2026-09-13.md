# 官服客户端反编译源码分析（2.7.71）

> **分析日期**：2026-09-13　|　**基线提交**：`5781efa`
> **分析对象**：`reference/arknights-2.7.71-csharp/`（Cpp2IL + ilspycmd 产出的 C# 源码，23,168 个 `.cs` / 221 MB）＋ `reference/com.hypergryph.arknights_2.7.71.cs`（签名单文件，1,046,522 行 / 54.7 MB）
> **对照物**：本仓 `app/`（DoctorateTs 私服，Express 5 + TS）
> **方法**：只读静态阅读 + 命令实测；七路并行深挖（代码地图 / 网络协议 / schema 链路 / 战斗 / 基建肉鸽沙盒 / 活动抽卡任务 / 路由覆盖度），每条结论附文件路径（尽量带行号），区分「已验证」与「推测」

> ⚠️ **并发编辑声明（重要）**：本次分析期间，仓库工作区**正在被另一会话修改**（实测：`app/game/modules/sandbox/routes.ts` 于 10:55:55 新增 23 行 OBS 别名路由、`AGENTS.md` 于 10:57:37 更新命令表）。因此：
> 1. 本报告对 `reference/`（反编译产物）的一切结论是**稳定**的；
> 2. 对 `app/` 的一切行号与「当前实现状态」结论，其快照时刻为 **2026-09-13 11:00 前后**，工作区当时有 **62 个文件未提交改动**（`git status`）——引用服务端行号前请以 `git log -1` + 实际文件为准；
> 3. 本次分析全程只读，未修改 `app/`、`scripts/`、`reference/` 下任何文件（所有一次性脚本与中间产物在 `tmp/decompiled-analysis/`，已 gitignore）。

> **章节与引用约定**：本报告顶层章节统一编号 `0`~`10`（另有两个主分析者附录 `4b`、`8b`），跨节引用一律写作「第 N 节」。各节**正文内部**出现的 `§N` / `§N.M` 是**该节原有的局部小节编号**（七路分稿各自成体系，汇总时只重编了标题、未改写正文引用），请按所在节上下文理解；凡带文件名前缀者（如 `design-spec.md §35.9`）指该文件自身的章节号。

## 0. 摘要

**一句话结论**：官服 2.7.71 的反编译源码是一份**高可信的「结构与契约」参考资料、中等可信的「行为」参考资料**——类型/字段/枚举/路由常量足以直接驱动服务端开发（本仓的 schema 与类型链路已证明这一点，三条门禁全绿），但方法体有 5% 的 IL 恢复失败与大量部分恢复，**不能据此照抄数值与公式**。用它对照本私服后，共发现 **49 条差异**（P0 14 / P1 20 / P2 15），收敛为 **9 条全局 P0**；服务端路由覆盖率为 **96.41%**（缺失 14 条），最大结构性缺口是**生息演算/沙盒完全未实现**与**约 6 个活动族整族无路由**。

### 0.1 关键数字

| 维度 | 数值 |
|---|---|
| 反编译产物 | 23,168 个 `.cs` / 221 MB（`Assembly-CSharp` 22,017 文件、5,617,383 行） |
| 签名文件 | 1,046,522 行 / 54.7 MB（38,702 类、3,613 枚举） |
| Cpp2IL IL 恢复成功率 | **95%（200,163 / 210,414 方法）** → 约 10,251 个方法失败 |
| 失败标记落地情况 | 3,540 个文件含 `AnalysisFailedException`（8,601 处）＋ 111,954 行部分恢复注释 |
| 客户端代码构成 | UI 表现层 49.5%、协议/数据面 13.0%、活动族 3216、战斗 2589（服务端真正要建模的约 13%） |
| 协议类总量 | **1489 个**（746 `*Request` / 689 `*Response`，1442 个文件；扁平 `Torappu/` 仅是其子集） |
| 请求体编码 | HTTP 层是 **JSON**（非 FlatBuffers）；FBS/FBO 只用于 excel 游戏数据，MASK/AES 也只在 excel 管线 |
| schema 门禁 | `schema:check` / `schema:crosscheck` / `schema:audit` **全部退出码 0**，slot 位移 **0**，残余 11 个冻结类 |
| 数据表 | excel 63 张（全部带溯源 meta，`csSource` 指向 2.7.71）、FBS schema 61 张 |
| 路由覆盖度 | 客户端 696 条 ⇄ 服务端 1,209 条可见路径；命中 682、**缺失 14**、覆盖率 96.41%（严格）/ 97.99%（含大小写）；两路独立提取的 9 vs 14 冲突已裁决（见第 8b 节） |
| 差异总量 | 49 条（P0 14 / P1 20 / P2 15），其中全局 P0 9 条 |

### 0.2 十条最重要的发现

1. **反编译产物自带「可信度仪表」**：Cpp2IL 自报 95% 成功率，但源码里只有 8,601 处失败标记——**约 1,650 个方法是静默降级**（方法体被换成 `return default(...)` 却不报错）。「没有异常标记」≠「方法体可信」。（第 1.3 节）
2. **FBO 转换器恰好是最读不出来的部分**：`Torappu.FlatBuffers/FlatLookupConverter.cs`（74,998 行）有 1,026 个方法 IL 恢复失败，而它正是「报文 → C# 字段」的映射代码。这从反面证明了本仓改用**签名文件字段声明顺序**推导 schema 的必要性。（第 1.3 / 4 节）
3. **schema 链路是健康的**：三口径独立验证全部通过，无 slot 位移；残余差异全部是「尾部残留 / neverHit」或已登记的非线字段，不存在中部插入导致的解码错位风险。（第 4 节）
4. **抽卡有 4 个池会直接 500**（P0，已亲自复核）：`CLASSIC_ATTAIN_45/57/68_0_2` 的 `gachaRuleType` 是数字 `7`、`RETURN_71_0_1` 是 `11`，而服务端策略表只认枚举名，`String(raw)` 后查不到 → `InternalError` → HTTP 500；且 `RETURN_71_0_1` 的结束时间到 2030 年。（第 7.2 节）
5. **233 个标准池被标成限定池**（P0）：枚举污染导致保底按池隔离、标准池可领 300 抽赠送、误发限定凭证，并连带商店「高级凭证区/中坚甄选券」恒空。（第 7.2 节）
6. **生息演算/沙盒是「协议壳」而非实现**（P0，已复核 `player.update(` 计数 = 0）：80 个 handler 中 53 个裸 202、21 个空 delta、6 个硬编码，存档模型在 CS 里齐全但服务端从不落库。（第 6.3 节）
7. **活动族缺口是「整族级」的**：客户端约 63 族，服务端 32 族；`Act12D6`(57 文件)、`CommonVasebreaker`(45)、`Act54Side`(44) 等整族既无路由也无实现——而 2.7.71 新增的 `/activity/act54side/*`、`/activity/act1dp/*` 连 excel 数据都缺。（第 7.1 / 8 节）
8. **契约层缺少「以 CS 为真值」的守卫**：基建 2 条 P0、战斗 P0-1 都是同一个病根——手写 zod schema 与 CS 类字段不一致时，表现为 422 或静默丢字段；另有 16 条基建 POST 绕过 `validateBody`，而架构守卫的正则恰好把 `handler.ts` 排除在外。（第 9.3 节）
9. **危机合约的结算丢弃战报**（P0）：`crisis.schema.ts` 的 `battleFinish` 是空对象 schema，失败也能刷最高分；同时全服务端结算都信任客户端 `completeState`，`isCheat` 既不校验也不落库。（第 5 节）
10. **服务端对「CS 字段」的臆造已产生实际错误**：把 `gachaObjGroups` 当必需字段补，但 CS 签名里该字段计数为 0，真实字段是 `gachaObjList`；类似地 `GetCurrentGachaObjGroupType` 的 1..4 被恒回 0。（第 7.2 节）

### 0.3 报告导航

| 节 | 内容 | 主要读者收益 |
|---|---|---|
| 1 | 反编译产物与工具链、**可信度量化**、阅读陷阱与检索配方 | 建立「哪些代码能信」的判断力 |
| 2 | 命名空间/模块代码地图与职责分层 | 快速定位任意功能的代码位置 |
| 3 | 网络与协议层：请求链路、错误码、FBS 角色、协议类清单 | 写/改路由与契约时的第一手依据 |
| 4 | 数据与 schema 生成链路（含三条门禁实跑记录、静默失败风险） | 版本更新时的操作手册 |
| 5 | 战斗系统：生命周期、结算入口、16 条差异 | 战斗相关修复的优先序 |
| 6 | 基建 / 肉鸽 / 生息演算：25 条差异 | 三大长线玩法的缺口清单 |
| 7 | 活动族 / 抽卡 / 任务签到勋章：8 条差异 + 整族缺口对照 | 运营内容与抽卡事故 |
| 8 | 客户端 696 条路由 ⇄ 服务端覆盖度重算 | 端到端可达性 |
| 9 | 差异总表、全局 P0、**文档纠偏清单** | 直接可执行的修复计划 |
| 10 | 方法论、可复跑命令、残留未验证项 | 复核与复现 |

### 0.4 使用建议（三条）

1. **把反编译源码当「契约与结构」的单一真值，而不是行为真值**：字段、枚举、路由常量、类继承关系可信度最高；数值、公式、状态机细节必须用 `data/excel/*.json` 或真机抓包交叉验证。
2. **建立「CS 契约 ↔ zod schema」的门禁**，否则第 9.3 节那类 422/静默丢字段会反复出现（这是本次分析中性价比最高的一条工程建议）。
3. **优先修 P0 中的「数据事故」而非「功能缺失」**：抽卡 500 与 233 池误标限定是**数据层面的连锁错误**，修复成本低、影响面大；沙盒与活动族整族缺失属于工程量问题，应单独立项。

---

---

## 1. 反编译产物与工具链

### 1.1 链路

`pnpm run decompile` → `scripts/decompile-client.sh`（全离线，静态反编译本机官服客户端，不受 ACE 反作弊影响）：

| 步骤 | 工具 / 版本 | 输入 | 产物 |
|---|---|---|---|
| 1 | Cpp2IL `2022.0.7` | `GameAssembly.dll` + `global-metadata.dat`（IL2CPP metadata **v29**，Unity **2021.3**） | 91 个 dummy DLL（含内嵌 IL 方法体）＋ `tmp/decompile/cpp2il_out/types/**/*_metadata.txt` 逐类分析 |
| 2 | ilspycmd `11.0.0.9375` | 13 个游戏程序集 | `reference/arknights-2.7.71-csharp/`（可浏览的 C# 项目，含方法体） |
| 3 | `scripts/dump-cs-signature.py`（纯 Python ECMA-335 元数据读取，零三方依赖） | `cpp2il_out` | `reference/com.hypergryph.arknights_2.7.71.cs`（Il2CppDumper 风格签名 dump，无方法体） |
| 4 | `scripts/cs2schema.ts --check` | 签名文件 | **FBO schema 漂移门禁**，漂移则非 0 退出并提示 `pnpm run schema:write` |

反编译对象程序集（13 个，见 `scripts/decompile-client.sh` 的 `GAME_ASSEMBLIES`）：`Assembly-CSharp` / `Assembly-CSharp-firstpass` / `Torappu.Common` / `Torappu.CETest` / `Torappu.UICommonEditor` / `Torappu.Sofdec` / `Hypergryph.EventLogSDK` / `Hypergryph.GameUpdate` / `Hypergryph.Log` / `Hypergryph.OneChannel` / `Hypergryph.Webview` / `torappu.CrashSight.Standalone` / `enum2int`（`Hypergryph.NativeBridge` 无类型，Cpp2IL 跳过）。

### 1.2 产物清单与规模（实测）

```text
reference/arknights-2.7.71-csharp/     221 MB   23,168 个 .cs
├── Assembly-CSharp/                   219 MB   22,017 个 .cs
│   ├── Torappu/                       (扁平)    2,853 个 .cs  ← 协议类 + 状态/数据类
│   ├── Torappu.UI/                                1,154
│   ├── Torappu.Battle/                              868
│   ├── Torappu.UI.SandboxPerm.SandboxV2/            703
│   ├── Torappu.UI.Roguelike/                        607
│   ├── Torappu.UI.SandboxPerm.SandboxV3/            539
│   └── …（共 474 个顶层命名空间目录，完整清单见 tmp/decompiled-analysis/ns-counts.txt）
├── Torappu.Common/                    2.1 MB      853 个 .cs  ← 运行时/网络/资源/Audio/Lua
├── Hypergryph.OneChannel/             303 KB       66
├── torappu.CrashSight.Standalone/      79 KB       25
├── Torappu.CETest/                     57 KB       17
├── Hypergryph.EventLogSDK/             56 KB       14
├── Hypergryph.Log/                     13 KB       13
├── Hypergryph.GameUpdate/              28 KB       12
├── Hypergryph.Webview/                 47 KB       20
├── Torappu.Sofdec/                     16 KB       19
├── Torappu.UICommonEditor/            8.0 KB        9
├── enum2int/                          2.0 KB        8
└── Assembly-CSharp-firstpass/         235 KB       95
reference/com.hypergryph.arknights_2.7.71.cs   56 MB  1,046,522 行
```

`Torappu/` 是**扁平存放**的协议与数据类区：含 290 个 `*Request.cs`、286 个 `*Response.cs`，命名形如 `public class BuildingBuildRoomRequest : BuildingRequest { public string roomSlotId; public string roomId; }`（`Assembly-CSharp/Torappu/BuildingBuildRoomRequest.cs:9`）。这条「扁平区放协议、子目录放玩法/UI」的分布是检索的第一原则。

### 1.3 产物可信度：哪些代码可以信，哪些不能信

**这是使用反编译源码前必须知道的前提。** 用 `tmp/decompile/` 的留存日志实测：

| 指标 | 数值 | 来源 |
|---|---|---|
| Cpp2IL 处理方法总数 | **210,414** | `tmp/decompile/cpp2il_run.log`（UTF-16LE，需 `iconv`） |
| Cpp2IL 分析成功方法数 | **200,163（95%）** | 同上：`Overall analysis success rate: 95% (200163) of 210414 methods.` |
| **IL 恢复失败方法数** | **约 10,251（5%）** | 由上一行反推 |
| 分析耗时 | ~1,526 s（24 types/s，137 methods/s） | 同上 |
| Cpp2IL 警告数 | 1,322（`[Analyze]` 948 / `[Program]` 299 / `[Analysis]` 75） | 同上 |
| 警告主因 | `Failed to perform analysis on method …`（不可恢复的 IL），另有 14 处 `Exception generating IL` | 同上 |
| ilspycmd 逐文件反编译报错 | **26 个文件**（`Error decompiling for …`，主因 `Unable to cast object of type 'BlockStatement' to type 'Expression'`） | `tmp/decompile/ilspy_project.log` |
| ilspycmd 整体失败类型 | 0（无 `could not decompile`） | 同上 |

失败在源码里的两种形态，读到就该降低信任：

1. **整方法不可用**：方法体只剩
   `throw new Cpp2IlInjected.AnalysisFailedException("CPP2IL failed to recover any usable IL for this method.");`
   （例：`Assembly-CSharp/Torappu.Battle/BattleController.cs:131`）。
2. **部分恢复**：控制流上有 `//IL_0029: Expected native int or pointer, but got I0` 之类的注释
   （例：`Assembly-CSharp/Torappu.Battle/BattleController.cs:152-155`），说明该处 IL 栈类型推断失败——
   **这段控制流不可照抄**，只能当作意图参考。

**文件级分布**（`tmp/decompiled-analysis/decompile-artifacts.txt`，全树 `xargs -P8` 扫描实测）：

| 指标 | 数值 |
|---|---|
| 含 `AnalysisFailedException` 标记的文件 | **3,540 / 22,017**（16.1%） |
| 标记出的失败方法总数 | **8,601** |
| 部分恢复的 `//IL_` 注释行 | **111,954** |
| 失败最集中的文件 | `Torappu.FlatBuffers/FlatLookupConverter.cs` **1026**、`Torappu.Battle.Action/Nodes.cs` 121、`Torappu.Battle.GameMode/GameModeFactory.cs` 62、`Torappu.LongServiceKit.Protocol/LongServiceProtocolSerializer.cs` 55、`Torappu.UI.Roguelike/RoguelikeDungeonPage.cs` 43、`FullInspector/tk.cs` 42、`Torappu.Battle/Scheduler.cs` 30 … |

> **两组数字不一致，这是关键结论**：Cpp2IL 自报失败 10,251 个方法（5%），而源码里只有 8,601 处 `AnalysisFailedException` 标记——**差额约 1,650 个失败方法是「静默降级」的**：方法体被替换成 `return default(...)` 之类而无任何告警标记。实证：`enum2int/EnumInt32ToInt.cs` 的 `Convert<TEnum>` 只剩 `return default(int);`。
> 因此：**「没有 `AnalysisFailedException`」不等于「方法体可用」**。判断某方法是否可信，还要看它是否只有 `return default` / 空体，或与同 RVA 的样板体雷同。

两个对 schema 工作有直接影响的失败点：`Torappu.FlatBuffers/FlatLookupConverter.cs`（74,998 行、1026 个方法失败）是 FBO 表 → C# 对象的转换注册表（每个表挂 `Func<Table, object> unpack`），**它正是「报文字段怎么映射到 C# 字段」的代码，却几乎读不出实现**——这解释了为什么本仓的 schema 链路（`cs2schema.ts`）必须改用**签名文件的字段声明顺序**而非从转换器代码反推（见第 4 节）；`Torappu.LongServiceKit.Protocol/LongServiceProtocolSerializer.cs`（55 个失败）是长连接协议序列化器，读长连接协议时需格外小心。

推论（分析时应遵守的纪律）：**类型、字段名、字段顺序、枚举值、常量字符串的可信度远高于方法体**；方法体在 `Torappu.Battle*`、`Torappu.UI.*` 这类重逻辑区域约有 5% 损失，凡要据此实现数值/公式，必须用 `data/excel/*.json` 或抓包报文交叉验证。

### 1.4 阅读陷阱与导航配方

**（1）`Cpp2IlInjected` 属性是元数据锚点，不是噪音**

| 属性 | 含义 | 用法 |
|---|---|---|
| `[Token("0x2000CBB")]` | IL2CPP metadata 行标识（类型/字段/方法） | **跨客户端版本追踪同一实体**——改名也能对上；比按名字 diff 可靠 |
| `[FieldOffset(Offset = "0x18")]` | 运行时字段布局偏移 | 判断字段是否真的在实例上、以及字段的物理顺序 |
| `[Address(RVA/Offset/VA)]` | 方法体地址 | **RVA 相同 ⇒ 同一份方法体**（共享/样板代码） |

RVA 复用的实证：`Assembly-CSharp/Torappu/BuildingBuildRoomRequest.cs:17` 与 `Assembly-CSharp/Torappu.UI.Roguelike/RL05Service.cs:18` 两个毫不相关的构造函数，`RVA` 都是 `0x544E90`——即它们共用同一个空样板体，读这类方法毫无信息量。

**（2）编译器生成物会污染检索**：异步状态机与闭包被 ilspy 转义成 `_003C_SendPostCoroutine_003Ed`、`<xxx>c__DisplayClass`、`<>c` 等
（实证：`Torappu.Common/Torappu.Network/` 下有 `_003C_SendPostCoroutine_003Ed`、`_003C_PostWithBestHttp_003Ed` 等各 3 处）。检索协议行为时优先看**声明类本身**，把 `_003C…_003E` 前缀的成员当作实现细节。

**（3）签名文件（`com.hypergryph.arknights_2.7.71.cs`）的字段偏移注释全是 `// 0x0`**——解析器（`generate-types.ts` 的 `parseFile`）不消费偏移，它只提供**类型名、基类、字段名与字段声明顺序、枚举名与数值**。要真实偏移，回到 `reference/arknights-<ver>-csharp/` 看 `FieldOffset`。

**（4）项目不可编译**：只有类型与 IL 转写体，缺 Unity/游戏自身引用。`scripts/decompile-client.sh:186-199` 会在产物目录写一份 README（当前 `reference/arknights-2.7.71-csharp/` 下该 README 已不在，但脚本文案仍在），其中明确：「含方法体（IL2CPP x86-64 重建，可读伪代码）；类型/字段/接口/枚举完整还原；少量方法体为 ILSpy 占位（体内有错误说明）；**项目不可编译，仅作协议/逻辑研究参考**」。不要试图对它执行 `dotnet build`。

**（5）`enum2int` 程序集的 8 个文件是 IL2CPP 的枚举装箱辅助**（`EnumInt32ToInt.Convert<TEnum>/RevertToEnum<TEnum>`），方法体未恢复（只剩 `return default(int)`），无分析价值，检索时可整体跳过。

**（6）检索配方（在 /mnt/d 上尤其重要）**：本目录 22,017 个文件、单文件读取 ~36 ms，**全树 `grep -r` 需十几分钟、全仓 `glob **/*` 会直接超时**。推荐顺序：

```bash
# ① 找协议类：扁平区，按类名
ls reference/arknights-2.7.71-csharp/Assembly-CSharp/Torappu/ | grep -i '^Gacha.*Request\.cs$'
# ② 找路由常量：只扫 Service/ServiceCode 类（253 个文件，秒级）
grep -rn --include='*Service*.cs' -E 'const string [A-Z_0-9]+ = "/' reference/arknights-2.7.71-csharp/Assembly-CSharp
# ③ 找玩法实现：先按命名空间目录定位，再进目录内检索
ls -d reference/arknights-2.7.71-csharp/Assembly-CSharp/Torappu.Battle*
# ④ 找状态字段：数据类集中在扁平区 Torappu/（如 PlayerDataModel.cs）
grep -n 'JsonProperty' reference/arknights-2.7.71-csharp/Assembly-CSharp/Torappu/PlayerDataModel.cs
# ⑤ 规模统计（只遍历目录项，不读文件内容，快）
for d in reference/arknights-2.7.71-csharp/Assembly-CSharp/*/; do printf "%6d %s\n" "$(find "$d" -name '*.cs' | wc -l)" "$(basename "$d")"; done | sort -rn
```

> 本报告后续章节若引用 `Assembly-CSharp/Torappu.*` 下的行号，均为该基线下的实际行号；客户端版本更新后行号会漂移，届时以 `Cpp2IlInjected.Token` 为准重新定位。

---

## 2. 反编译产物与代码地图

> 本章所有数字均来自本文中给出的命令在本机（WSL，`/mnt/d` 9p/drvfs）的实际输出，未使用估算值。
> 采集时间：2026-09-13；产物版本：客户端 **2.7.71**。
> 读取约定：`reference/` 只读分析，本章未修改其中任何文件。

### 2.1 产物清单

#### 2.1.1 产物根目录

```
$ ls -la reference/
-rwxrwxrwx 142011422 Sep 10 21:37 Arknights.7z            # 原始客户端包（142 MB）
drwxrwxrwx            reference/arknights-2.7.71-csharp   # 含方法体的 C# 反编译工程
-rwxrwxrwx  58391453 Sep 10 20:24 com.hypergryph.arknights_2.7.71.cs   # 签名文件（56 MB）
drwxrwxrwx            reference/OpenArknightsFBS-main     # FBS 交叉校验参考（919 K）
drwxrwxrwx            reference/hotupdate                 # 热更 resources（232 MB）
drwxrwxrwx            reference/obs                      # 历史版本快照（259 MB）
drwxrwxrwx            reference/opendoctoratepy-ex-public
```

`arknights-2.7.71-csharp/` 的规模：

```
$ cd reference/arknights-2.7.71-csharp
$ for d in */; do printf '%s files=%s size=%s\n' "$d" "$(find "$d" -name '*.cs' -type f | wc -l)" "$(du -sh "$d" | cut -f1)"; done
$ find . -name '*.cs' -type f | wc -l      # 23168
$ du -sh .                                 # 221M
```

| 程序集目录 | `.cs` 文件数 | `du -sh` |
|---|---:|---:|
| `Assembly-CSharp/` | **22017** | 219M |
| `Torappu.Common/` | 853 | 2.1M |
| `Assembly-CSharp-firstpass/` | 95 | 235K |
| `Hypergryph.OneChannel/` | 66 | 303K |
| `torappu.CrashSight.Standalone/` | 25 | 79K |
| `Hypergryph.Webview/` | 20 | 47K |
| `Torappu.Sofdec/` | 19 | 16K |
| `Torappu.CETest/` | 17 | 57K |
| `Hypergryph.EventLogSDK/` | 14 | 56K |
| `Hypergryph.Log/` | 13 | 13K |
| `Hypergryph.GameUpdate/` | 12 | 28K |
| `Torappu.UICommonEditor/` | 9 | 8.0K |
| `enum2int/` | 8 | 2.0K |
| **合计** | **23168** | **221M** |

含方法体的源码总行数（一次流式 `cat | wc -l`，实测）：

```
$ cd reference/arknights-2.7.71-csharp
$ (cd Assembly-CSharp && find . -name '*.cs' -type f -print0 | xargs -0 cat | wc -l)   # 5617383
$ (cd Torappu.Common   && find . -name '*.cs' -type f -print0 | xargs -0 cat | wc -l)   # 49895
```

- `Assembly-CSharp`：**5,617,383 行** / 22017 文件 ≈ 255 行/文件；
- `Torappu.Common`：**49,895 行** / 853 文件 ≈ 58 行/文件（共享程序集以短小接口与工具类为主）。

13 个程序集与 `arknights-2.7.sln` 中的 13 个 `.csproj` 一一对应：

```
$ grep -o '"[^"]*\.csproj"' reference/arknights-2.7.71-csharp/arknights-2.7.sln | sort -u
# Assembly-CSharp / Assembly-CSharp-firstpass / Hypergryph.EventLogSDK / Hypergryph.GameUpdate
# Hypergryph.Log / Hypergryph.OneChannel / Hypergryph.Webview / Torappu.CETest / Torappu.Common
# Torappu.Sofdec / Torappu.UICommonEditor / enum2int / torappu.CrashSight.Standalone
```

`enum2int` 不是游戏程序集，而是反编译链的辅助工程（见 §3.4）。

#### 2.1.2 签名文件

`com.hypergryph.arknights_2.7.71.cs`（Il2CppDumper 风格，**无方法体**，供类型再生消费）：

```
$ ls -la reference/com.hypergryph.arknights_2.7.71.cs   # 58391453 bytes
$ wc -l reference/com.hypergryph.arknights_2.7.71.cs    # 1046522
$ head -c 200 reference/com.hypergryph.arknights_2.7.71.cs
// AntiSDK.dll
internal class <Module> : 
{ // Fields  // Methods }
public static class Beyond.SDK.AntiSDK : System.Object
```

格式特征（`scripts/dump-cs-signature.py` 头部注释自述）：`public class/struct Torappu.* : base, ifaces { public <Type> <field>; }`、`public enum Torappu.* { public const <Enum> NAME = <n>; }`，嵌套类型以点号展平（`Outer.Inner`），字段/方法偏移注释统一为 `// 0x0`（解析器不消费）。真实偏移只在含方法体的 `arknights-<ver>-csharp/` 中。

#### 2.1.3 为什么必须「通配探测」而不能硬编码

两条独立事实叠加，使硬编码路径必然随客户端更新静默失效：

1. **`reference/` 被 gitignore**（`.gitignore:35` 即 `reference/`），CI/新克隆环境根本不存在该目录，任何 `existsSync` 守卫会静默走 fallback；
2. **版本号内嵌在文件名/目录名**里（`arknights-2.7.71-csharp`、`com.hypergryph.arknights_2.7.71.cs`），每次客户端更新改名。

仓库现有的两个探测入口（二者分工不同，勿混淆）：

| 解析目标 | 实现 | 匹配规则 |
|---|---|---|
| 签名文件 `com.hypergryph.arknights_<ver>.cs` | `scripts/lib/cs-source.ts#resolveCsFile()` | `CS_FILE_RE = /^com\.hypergryph\.arknights_.+\.cs$/`，字典序升序取最后一个；可用 `--cs` / `GENERATE_CS` 覆盖 |
| 含方法体的源码目录 `arknights-<ver>-csharp/` | `scripts/apk-audit.ts#resolveDecompiledSrcDir()` | `/^arknights-.+-csharp$/` 目录过滤 + `sort()` 取最后一个 |

> **未验证/风险点**：`apk-audit.ts` 在 `reference/` 不存在或正则无匹配时，仍会 fallback 到硬编码的 `arknights-2.7.61-csharp`（第 36、44 行），此时不会报错。这是 `cs-source.ts` 已修掉的那类静默漂移在另一处的残留；本次 `resolveCsFile()` 路径正常工作（`reference/` 存在且文件匹配）。本任务未修改该文件。

### 2.2 代码地图

#### 2.2.1 命名空间 → 目录的映射规律（先确认，再统计）

ilspycmd 输出**一个命名空间一个顶层目录，且目录名把命名空间各段用点连成一个名字**（`Torappu.Battle/`，而非 `Torappu/Battle/`），目录**不再嵌套**（最大深度 = 2，即 `./<Namespace>/`）：

```
$ cd reference/arknights-2.7.71-csharp/Assembly-CSharp
$ find . -type d | awk -F/ '{print NF}' | sort -rn | head -1   # 2  → 无二级子目录
$ find . -maxdepth 1 -type d | wc -l                            # 475（含 "." → 474 个命名空间目录）
$ find . -maxdepth 1 -name '*.cs' -type f | wc -l               # 52 个全局命名空间根文件
$ find . -name '*.cs' -type f | awk -F/ '{print $2}' | sort | uniq -c | sort -rn | wc -l   # 526 = 474 + 52 ✔
```

因此「命名空间文件数」可以**零读盘**地用路径聚合得到（对慢盘至关重要）：

```
$ find . -name '*.cs' -type f | awk -F/ '{print $2}' | sort | uniq -c | sort -rn
```

两个直接可用的推论：
- 命名空间 = 顶层目录名（含点），`Torappu/` 就是扁平命名空间 `Torappu`；
- **一个顶层类型一个文件** → 类型名 = 文件名（`PlayerTroop` → `Torappu/PlayerTroop.cs`，已实测），所以「找类型」优先 `ls | grep`，不要全树 `grep -r`。

#### 2.2.2 分层总表（Assembly-CSharp，22017 文件，分桶求和恰好等于 22017）

| 层次 | 命名空间前缀 | 文件数 | 命名空间个数 |
|---|---|---:|---:|
| 协议/数据类（扁平） | `Torappu`（无子命名空间） | **2853** | 1 |
| UI 层 | `Torappu.UI.*` | **10907** | 175 |
| 活动层 | `Torappu.Activity.*` | 2602 | 87 |
| 活动层 | `Torappu.Arkvent.*` | 420 | 5 |
| 活动层 | `Torappu.AVG.*` | 194 | 3 |
| 战斗层 | `Torappu.Battle.*` | **2589** | 62 |
| 其余 Torappu 运行时（基建/渲染/多人/网络…） | `Torappu.Building.*`、`Torappu.Rendering` 等 | 1521 | 108 |
| 第三方 Lua 绑定 | `XLua.*` | 363 | — |
| 第三方 Inspector | `FullInspector.*` | 165 | — |
| 第三方序列化 | `FullSerializer.*` | 57 | — |
| 第三方 SDK | `HGSDK.*` | 120 | — |
| 第三方 SDK | `XDSDK.*` | 35 | — |
| 第三方 UI 遮罩 | `SoftMasking.*` | 10 | — |
| 注入属性定义 | `Cpp2IlInjected` | 6 | 1 |
| 其他第三方 | `Colorful` 63 / `BitBenderGames` 23 / `HedgehogTeam.EasyTouch` 17 / `YostarSDKV2` 11 / `Prime31` 5 / `__XLUA_GEN` 1 / `YostarTrace` 1 / `UnityStandardAssets.Water` 1 / `Properties` 1 | 123 | 9 |
| 全局命名空间根文件 | （无 namespace，如 `Bugly*`、`LogSeverity.cs`） | 52 | — |
| **合计** | | **22017** | 474 |

> 分桶命令（每行恰好落入一个桶，实测和 = 22017）：
> `awk '{...}'` 见 `tmp/decompiled-analysis/.ns-asmcsharp.txt`（本次落盘的 526 行原始聚合）。
> `Torappu.*` 合计 **21086**（= 2853 扁平 + 18233 分子命名空间）。

#### 2.2.3 各类前 10 大命名空间

**UI 层 `Torappu.UI.*`**（10907 文件 / 175 命名空间）

| # | 命名空间 | 文件数 |
|---:|---|---:|
| 1 | `Torappu.UI` | 1154 |
| 2 | `Torappu.UI.SandboxPerm.SandboxV2` | 703 |
| 3 | `Torappu.UI.Roguelike` | 607 |
| 4 | `Torappu.UI.SandboxPerm.SandboxV3` | 539 |
| 5 | `Torappu.UI.Stage` | 385 |
| 6 | `Torappu.UI.ActArchive` | 345 |
| 7 | `Torappu.UI.ClimbTower` | 245 |
| 8 | `Torappu.UI.AutoChess` | 241 |
| 9 | `Torappu.UI.Home` | 231 |
| 10 | `Torappu.UI.Roguelike.RL06` | 226 |

子域聚合：`Torappu.UI.Roguelike.*` = **1387**、`Torappu.UI.SandboxPerm.*` = **1329**、`Torappu.UI.Act*` = **1099**、`Stage|Shop|Home` = **1017**。也就是说集成战略（Roguelike）+ 生息演算（SandboxPerm）两族独占 UI 层约 25%，是 UI 层最大的两块。

**战斗层 `Torappu.Battle.*`**（2589 文件 / 62 命名空间）

| # | 命名空间 | 文件数 |
|---:|---|---:|
| 1 | `Torappu.Battle` | 868 |
| 2 | `Torappu.Battle.Abilities` | 292 |
| 3 | `Torappu.Battle.UI` | 217 |
| 4 | `Torappu.Battle.Projectiles` | 112 |
| 5 | `Torappu.Battle.Effects` | 111 |
| 6 | `Torappu.Battle.SandboxV3` | 109 |
| 7 | `Torappu.Battle.Runes.Internal` | 90 |
| 8 | `Torappu.Battle.AutoChess` | 80 |
| 9 | `Torappu.Battle.ArkDex` | 66 |
| 10 | `Torappu.Battle.Roguelike.Internal` | 58 |

战斗层另有 **61 个**一级子命名空间（`find Torappu.Battle -maxdepth 1 -type d | wc -l` → 62，含 `Torappu.Battle` 自身），例如 `Torappu.Battle.Action.TNodeAction`、`Torappu.Battle.Cooperate`、`Torappu.Battle.GameMode.Vase`、`Torappu.Battle.HalfIdle`、`Torappu.Battle.Legion`、`Torappu.Battle.Racing`、`Torappu.Battle.Strife`、`Torappu.Battle.Timeline`、`Torappu.Battle.TPhysic2D`、`Torappu.Battle.UniEquip` —— 每出一种新玩法基本就是新增一个 `Torappu.Battle.<Mode>` 命名空间。

**活动层 `Torappu.Activity.* / Arkvent / AVG`**（3216 文件 / 95 命名空间）

| # | 命名空间 | 文件数 |
|---:|---|---:|
| 1 | `Torappu.Activity.ActMultiV3` | 228 |
| 2 | `Torappu.Activity.Act1VHalfIdle` | 220 |
| 3 | `Torappu.Arkvent` | 214 |
| 4 | `Torappu.AVG` | 189 |
| 5 | `Torappu.Activity.VecBreakV2` | 165 |
| 6 | `Torappu.Arkvent.UnitSystem` | 154 |
| 7 | `Torappu.Activity.Act24side` | 143 |
| 8 | `Torappu.Activity`（活动框架本体） | 116 |
| 9 | `Torappu.Activity.Act20side` | 103 |
| 10 | `Torappu.Activity.Act42D0` | 94 |

约定：活动代码按**活动代号**建命名空间（`Act24side`、`Act42D0`、`Act1VHalfIdle`；`side`=支线、`D0/D5/D6`=联动/主线节点打标），`Torappu.Arkvent*` 是周期性玩法（含 `UnitSystem` 自走棋式单位系统），`Torappu.AVG` 是剧情演出（ADV/AVG 引擎）。

**协议/数据类（扁平 `Torappu`，2853 文件）**——文件名后缀就是分类维度：

| 后缀 | 数量 | 说明 |
|---|---:|---|
| `*Data.cs` | **946** | excel 表行数据 + 玩家数据子结构（`PlayerDexNavData`、`Act1VHalfIdleCharBuffData`…） |
| `*Request.cs` | **290** | 客户端→服务端请求体（扁平 `Torappu` 命名空间） |
| `*Response.cs` | **286** | 服务端→客户端响应体 |
| `*Table.cs` | **37** | excel 表级容器（见 §5.4 清单） |
| 其余 | ~1294 | 枚举、常量、工具（`BattleSearchUtils.cs`、`BattleUIConst.cs`…） |

命令：`ls Torappu | grep -c 'Data\.cs$'` 等（实测输出即上表）。

**其余 Torappu 运行时**（1521 文件 / 108 命名空间，TOP10）

`Torappu.Building.UI` 131 / `Torappu.Building.DIY.UI` 100 / `Torappu.Building` 73 / `Torappu.Building.DIY` 67 / `Torappu.Building.UI.Meeting` 63 / `Torappu.Rendering` 50 / `Torappu.Multiplayer` 47 / `Torappu.Building.UI.SM` 46 / `Torappu.Building.UI.Float` 44 / `Torappu.Building.UI.StationSelect` 40。基建（Building）子系统在此层占绝对多数（含 DIY/Meeting/Manufact/Shop/Vault 等 UI 子域）。

**第三方与 SDK**（非 Torappu，123 + 690 文件）

| 命名空间 | 文件数 | 归属 |
|---|---:|---|
| `XLua.CSObjectWrap` | 300 | XLua 的 C# wrap 层（雪碧化绑定） |
| `FullInspector` / `.Internal` | 91 / 52 | 编辑器 Inspector 框架（**运行时无用**） |
| `HGSDK` / `HGSDK.UI` | 68 / 43 | 鹰角账号/SDK |
| `Colorful` | 63 | 渲染后处理 |
| `XDSDK` | 35 | 心动 SDK |
| `FullSerializer` / `.Internal` | 25 / 23 | 序列化 |
| `SoftMasking` | 10 | UI 遮罩 |
| `BitBenderGames` 23 / `HedgehogTeam.EasyTouch` 17 / `YostarSDKV2` 11 / `Prime31` 5 | 56 | 触摸、广告、支付等杂项 |

**运行时共享层 `Torappu.Common/`**（853 文件 / 2.1M / 30 个命名空间目录 + 1 个根文件 `DotNetExtensionMethods.cs`）

| 命名空间 | 文件数 | 职责 |
|---|---:|---|
| `XLua` | 362 | Lua 虚拟机与绑定核心（共享程序集侧） |
| `Torappu` | 241 | 共享基础类型/工具（扁平） |
| `Torappu.UI` | 52 | 共享 UI 原子件/补间 |
| `Torappu.ECS` | 31 | 自研 ECS |
| `Torappu.Audio.RPG` | 26 | 音频（RPG 播放器） |
| `Torappu.Network` | 24 | 网络传输 |
| `Torappu.Audio.Engine` | 20 | 音频引擎抽象 |
| `Torappu.Resource` | 19 | 资源加载/句柄 |
| `Torappu.Audio` | 12 | 音频门面 |
| `Torappu.Config` | 11 | 配置 |
| 其余 | 55 | `Torappu.SDK(.AntiData)` 8+3、`Torappu.Particle` 4、`Torappu.Notification` 4、`Torappu.I18N` 3、`Torappu.TimeModule` 2、`Torappu.Lua` 2、`Torappu.Reflection`、`Torappu.Optimize`、`Torappu.Video` 1、`Torappu.SafeArea.Core` 1、`Torappu.Log`、`Torappu.EventPoolInternal`、`Torappu.Network.Certificate` 2、`Torappu.Audio.Engine.FMOD` 6、`Torappu.UI.DynTargetTween` 5、`__XLUA_GEN` 1、`Cpp2IlInjected` 6、`UnityEngine` 1（+ `Properties/AssemblyInfo.cs`） |

> 注意同名命名空间跨程序集：`Torappu.Common` 里的 `Torappu.Network`（24 文件）是共享网络传输层，与 `Assembly-CSharp` 里的 `Torappu.Network`（5 文件）**不是同一批代码**；检索时务必带程序集前缀。
> 校验：`Torappu.Common` 顶层目录 30 个（含无命名空间的 `Properties/`）+ 根文件 `DotNetExtensionMethods.cs` 1 个 = 31 个聚合组；文件数 853 = 上表各行之和（362+241+52+31+26+24+20+19+12+11 = 798，余额 55）。
> 命令：`cd reference/arknights-2.7.71-csharp/Torappu.Common && find . -maxdepth 1 -type d ! -name . | wc -l` → 30；`find . -maxdepth 1 -name '*.cs' -type f | wc -l` → 1。

其余程序集的命名空间构成（实测）：

- `Hypergryph.OneChannel` → `U8.SDK` 54 + `U8.SDK.MiniJSON` 1 + `Hypergryph.PlatformFacade` 4（Yostar/U8 渠道 SDK）
- `Hypergryph.Webview` 13 / `Hypergryph.EventLogSDK` 7 / `Hypergryph.GameUpdate` 5 → 均为 `Hypergryph.SDK.*`
- `torappu.CrashSight.Standalone` → `GCloud.UQM` 11 + `.MiniJSON` 1
- `Assembly-CSharp-firstpass` → `AdvancedInspector` 84（编辑器扩展；同样是运行时无用）
- `Torappu.Sofdec` → `XLua` 10 + `__XLUA_GEN` 1 + `Torappu.Video` 1（Lua 解密/视频）
- 每个程序集都带自己的 `Cpp2IlInjected`（6 个文件）与 `Properties/AssemblyInfo.cs`

**层次划分结论**：UI 层独占 Assembly-CSharp 的 **49.5%**（10907/22017），是战斗层（11.8%）的 4.2 倍。私服后端真正需要建模的协议/数据面只占 **13.0%**（2853 扁平 `Torappu`）；战斗层与 UI 层共 61.3% 的代码是**客户端表现层**，服务端只消费其数据结构与枚举，不要移植其逻辑。

### 2.3 阅读代码的实用注意

#### 2.3.1 `Cpp2IlInjected.Token` = ECMA-335 元数据令牌，可用于判类型归属与声明序

形态：`[Cpp2IlInjected.Token(Token = "0x2000CBB")]`。高字节是 ECMA-335 元数据表号，据此可判定该成员的身份：

| 高字节 | 元数据表 | 出现位置 |
|---|---|---|
| `0x02` | TypeDef | 类型（class/struct/enum） |
| `0x04` | Field | 字段 |
| `0x06` | MethodDef | 方法 |

实测计数（`Torappu.Battle/Buff.cs`）：`Token = "0x2…"` 6 个、`"0x4…"` 576 个、`"0x6…"` 410 个（总 Token 属性 1040），与同文件 `Cpp2IlInjected.Address(RVA=…)` 的 **410** 个方法完全吻合——即 `0x6` 计数 = 反编译出的方法数，可作为「这个类有多少方法」的快速探针。

字段 Token 在**声明顺序上连续递增**（`Torappu/PlayerDataModel.cs` 字段令牌 `0x4004574` → `0x40045B3`，首尾见 12、273 行）。因此：**同一类型内，Token 升序 == 元数据声明序 == 内存布局序**，可用来交叉验证 FBO vtable slot（slot = 4 + 2·i）。

#### 2.3.2 `Cpp2IlInjected.FieldOffset` = 真实 C++ 结构体字节偏移，直接编码字段序

形态：`[Cpp2IlInjected.FieldOffset(Offset = "0x10")]`。实测（两个文件分别 `grep -n FieldOffset` 得到）：

```
PlayerDataModel.cs（class，字段自 0x10 起；0x0~0xF 为对象头/klass 指针）：
  0x10 events → 0x18 pushFlags → 0x20 status → 0x28 monthlySub → 0x30 troop → …
PlayerStatus.cs：
  0x30 lastApAddTime → 0x38 lastRefreshTs → 0x40 lastOnlineTs
  → 0x48 level → 0x4C exp → 0x50 maxAp → 0x54 practiceTicket → 0x58 gold
```

偏移单调递增，且 `0x48→0x4C→0x50→0x54` 的 4 字节步进对应 `int`、`0x58` 起的 `long gold` 回到 8 字节步进——即**字段宽度与对齐留空可直接从偏移读出**。**用途有两个**：(a) 字段先后顺序的权威依据（比源码行序更硬，因为它是布局而非书写顺序）；(b) 判断某字段是内联值还是引用（8 字节步进 vs 4 字节步进）。属性定义随每个程序集重复产出：`Cpp2IlInjected/` 目录恒定 6 个文件（`AddressAttribute` / `TokenAttribute` / `FieldOffsetAttribute` / `MetadataOffsetAttribute` / `AttributeAttribute` / `AnalysisFailedException`），在 `Assembly-CSharp`、`Torappu.Common`、`Hypergryph.*`、`Torappu.Sofdec` 等程序集中实测均为 6。

#### 2.3.3 方法体是**真实 IL 反编译**，但也有明确的伪影边界

规模佐证（行数来自 `wc -l`，非估算）：

| 文件 | 行数 | `Address(RVA=…)` 方法数 | `//IL_` 注释 | `throw new NullReferenceException()` |
|---|---:|---:|---:|---:|
| `Torappu.Battle/BattleController.cs` | **11667** | 441 | 245 | 39 |
| `Torappu.Battle/Buff.cs` | **15970** | 410 | 247 | 27 |

确实是方法体而非签名桩——`BattleController.cs:307` 的 `Clear()` 体为真实语句 `((Queue<T>)(object)m_queue).Clear();`。

但必须同时知道它**不可信的那一面**：Cpp2IL 在结构体/泛型/枚举转换场景下会丢失 IL 语义，于是产出三类伪影：

1. `throw new NullReferenceException();` —— 控制流在此被**截断**（BattleController 39 处、Buff 27 处），后文根本不存在；
2. `//IL_0021: Expected O, but got I4` —— Cpp2IL 自己标注的类型推断失败；
3. `(Queue<T>)(object)m_queue` 这类强制转换 + `int num = 0; int num2 = 0;` 占位局部变量。

**结论**：反编译源码可放心用于**枚举/字段/类型/命名/依赖关系与调用点发现**，**不可用于**推断精确运行时行为或分支条件；需要精确行为时以抓包 + 服务端实测算。

#### 2.3.4 `enum2int` 的用途（目录已实际查看）

```
$ ls reference/arknights-2.7.71-csharp/enum2int/
Cpp2IlInjected/  EnumInt32ToInt.cs  Properties/  enum2int.csproj      （2.0K，8 个 .cs）
$ cat enum2int/enum2int.csproj   # net40 / LangVersion 14.0 / AllowUnsafeBlocks
$ cat enum2int/EnumInt32ToInt.cs # [Cpp2IlInjected.Token(Token="0x2000002")] public class EnumInt32ToInt
                                 #   public static int  Convert<TEnum>(TEnum value)    where TEnum : struct
                                 #   public static TEnum RevertToEnum<TEnum>(int value) where TEnum : struct
```

它**不是游戏类型**（无方法体实现，`return default(int);`），而是 Cpp2IL/ilspycmd 反编译时给「IL 里本应隐式发生的枚举 ↔ int32 转换」提供的可编译替身。调用点在反编译源码里真实存在：

```
$ grep -rn 'EnumInt32ToInt\.' reference/arknights-2.7.71-csharp/Assembly-CSharp/Torappu.Battle --include='*.cs' | head -3
Torappu.Battle/Attributes.cs:1047:  AbnormalFlag abnormalFlag = EnumInt32ToInt.RevertToEnum<AbnormalFlag>(num);
Torappu.Battle/Attributes.cs:1057:  abnormalCombo = EnumInt32ToInt.RevertToEnum<AbnormalCombo>(num);
Torappu.Battle/Buff.cs:15123:       int num7 = EnumInt32ToInt.Convert(attributeModifier.attributeType);
```

`Torappu.Battle` 内共 17 处 `Convert` + 5 处 `RevertToEnum`，分布在 6 个文件（`Attributes.cs`、`BattleBGMManager.cs`、`Buff.cs`、`CardUtil.cs`、`Entity.cs`、`MoveLikeRespawnSkillHelper.cs`）。**阅读时的含义**：凡是看到 `EnumInt32ToInt.Convert(x)` / `RevertToEnum<T>(n)`，说明该处原 IL 是位运算或枚举底层数值直接参与计算（常见于位标志 `AbnormalFlag`），这也是服务端最容易与客户端实现产生分歧的地方——**没有对应 C# 语义可照抄，只能自行定义位语义**。

#### 2.3.5 噪音形态（抽样确认）

Cpp2IL 会把 IL 标识符里的 `<` `>` 转义成 `_003C` / `_003E`，编译器生成的嵌套类型因此长成：

| 形态 | 含义 | 实测样例 |
|---|---|---|
| `private sealed class _003C_003Ec` | `<>c`，lambda 缓存单例 | `Torappu.Battle/BattleController.cs:562`、`Torappu.UI/AutoHideComponent.cs:17` |
| `_003C_003Ec__DisplayClass8_0` | `<>c__DisplayClass8_0`，闭包捕获类 | `Torappu.UI/AsyncImageRenderer.cs:141` |
| `private sealed class _003C_SwitchSceneLoop_003Ed__16 : IEnumerator<object>, IEnumerator, IDisposable` | `<SwitchSceneLoop>d__16`，迭代器/协程状态机 | `Torappu.UI/AdditiveSceneSwitchKernel.cs:194` 等连续 5 个 |

抽样规模（`Torappu.Battle`，868 文件）：

```
$ grep -rl '_003C_003Ec'        Torappu.Battle --include='*.cs' | wc -l   # 36
$ grep -rl '__DisplayClass'     Torappu.Battle --include='*.cs' | wc -l   # 9
$ grep -rl '_003Ed__'           Torappu.Battle --include='*.cs' | wc -l   # 36
```

关键点是这些类型**一律是宿主类型内部的嵌套私有类，不单独成文件**（ilspycmd 每个顶层类型一个文件）。所以噪音不会污染「按文件数统计的命名空间规模」，但会让单文件行数虚高、并在阅读时插入大段与业务无关的胶水代码。

另一类噪音：`Assembly-CSharp/-PrivateImplementationDetails-.cs` —— **0 行空文件**（`wc -l` 实测；`<PrivateImplementationDetails>` 是编译器为静态数组初始值生成的容器类，此处落成空壳）。

> shell 提示：该文件名以下划线夹减号开头（`-`），`cat`/`sed` 会把它当选项解析（本任务实测 `sed: invalid option -- 'P'`），需写 `sed -n '1,25p' ./-PrivateImplementationDetails-.cs` 或用 `read` 工具。

### 2.4 导航索引：想找 X 该去哪

#### 2.4.1 五条通则（先记住，能省 90% 的时间）

1. **类型名 = 文件名**（ilspycmd 一个顶层类型一个文件）→ 找类型用 `ls <命名空间目录> | grep '^TypeName'`，**不要** `grep -r` 全树（在 `/mnt/d` 上对 2853 文件的 `Torappu/` 做递归 grep 会直接超 60 s，本任务已实测超时）。
2. **命名空间 = 目录名**（含点）→ 找某玩法/活动/UI 模块直接 `ls -d <Namespace.Prefix>*`。
3. **协议类后缀即方向**：`*Request.cs` = 客户端上行，`*Response.cs` = 服务端下行，均在扁平 `Torappu/`。带 `Network` 的命名空间只有 `Torappu.Network`（5 文件）+ `Torappu.SocketNetwork.*`（54 文件，长连接底层：`Msg` 21 / `ServerBase` 12 / `SvrCom` 11 / `Connections` 6 / 本体 3 / `Connections.Impl` 1），**里面没有 `*Request.cs` 协议体**；另有 `Torappu.LongServiceKit.Protocol`（12）+ `.Protocol.Data`（6）承载长连接消息定义。找 HTTP 协议体一律去扁平 `Torappu/`。
   命令：`grep -iE 'network|longservice' tmp/decompiled-analysis/.ns-asmcsharp.txt`。
4. **excel 数据类没有独立命名空间**：全部落在扁平 `Torappu/*Data.cs` / `*Table.cs`（实测 `grep 'Excel' .ns-asmcsharp.txt` 结果为 0），按**文件后缀 + 表名前缀**检索。
5. **FBO schema 的类名 = `clz_<命名空间>_<类型>`**（点变下划线，嵌套类型再追加 `_<Inner>`）→ 从 CS 类型名可直接推出 schema 键。

#### 2.4.2 十二条实测可用命令（R1–R12，均已在本机跑通）

```bash
cd /mnt/d/develop/DoctorateTs

# R1 按协议语义找全部 Request 类（例：寻访相关）
ls reference/arknights-*/Assembly-CSharp/Torappu/ | grep -E 'Gacha.*Request\.cs$'
#  → AdvancedGachaRequest.cs / BoostNormalGachaRequest.cs / CancelNormalGachaRequest.cs
#    FinishNormalGachaRequest.cs / GetDetailGachaRequest.cs / NormalGachaRequest.cs / …（11 个）

# R2 看玩家存档顶层结构里的某字段
grep -n 'public PlayerTroop troop' reference/arknights-*/Assembly-CSharp/Torappu/PlayerDataModel.cs
#  → 40:	public PlayerTroop troop;

# R3 找该字段类型的定义（先用文件名猜，快且命中）
ls reference/arknights-*/Assembly-CSharp/Torappu/ | grep -E '^PlayerTroop'
grep -n 'class PlayerTroop' reference/arknights-*/Assembly-CSharp/Torappu/PlayerTroop.cs
#  → PlayerTroop.cs ; 7:public class PlayerTroop

# R4 由 CS 类型名反查 FBO schema 表文件（类名 → clz_ 键 → 所在 json）
grep -l 'clz_Torappu_ItemData' scripts/vendor/fbs-schemas/*.json
#  → scripts/vendor/fbs-schemas/item_table.json

# R5 看某张 excel 表 schema 里声明了多少结构体（'clz_' 计数）
grep -c '"clz_' scripts/vendor/fbs-schemas/character_table.json

# R6 命名空间规模排行（零读盘，路径聚合；注意先 cd 进程序集目录，$1 才是命名空间）
find reference/arknights-2.7.71-csharp/Assembly-CSharp -name '*.cs' -type f \
  | sed 's|.*Assembly-CSharp/||' | awk -F/ '{print $1}' | sort | uniq -c | sort -rn | head -5
#  → 2853 Torappu / 1154 Torappu.UI / 868 Torappu.Battle / 703 ...SandboxV2 / 607 ...Roguelike

# R7 战斗大类的规模与实现位置
wc -l reference/arknights-*/Assembly-CSharp/Torappu.Battle/Buff.cs
#  → 15970 reference/arknights-2.7.71-csharp/Assembly-CSharp/Torappu.Battle/Buff.cs

# R8 定位编译器生成噪音（评估某个文件「真实代码」占比）
grep -c '_003C_003Ec' reference/arknights-*/Assembly-CSharp/Torappu.Battle/BattleController.cs
#  → 10

# R9 找某个活动的全部实现文件（活动代号命名空间）
ls reference/arknights-*/Assembly-CSharp/Torappu.Activity.Act24side/ | head -5
#  → ACT24SIDE_MELDING_SMALL_ITEM_BG_TYPE.cs / Act24SideAlchemyRequest.cs / …Response.cs / …

# R10 枚举 ↔ int 陷阱扫描（服务端最易踩坑处）
grep -n 'EnumInt32ToInt' reference/arknights-*/Assembly-CSharp/Torappu.Battle/Buff.cs | head -2
#  → 15123 / 15127 行
```

补充两条专用路径：

```bash
# R11 签名文件里按「命名空间.点号展平」的类名定位（无方法体，用于类型再生核对）
grep -n 'class Torappu.PlayerDataModel' reference/com.hypergryph.arknights_2.7.71.cs
#  → 72020:public class Torappu.PlayerDataModel : System.Object

# R12 查某个类在战斗层的声明与基类
grep -n 'class BattleController' \
  reference/arknights-2.7.71-csharp/Assembly-CSharp/Torappu.Battle/BattleController.cs
#  → 41:public class BattleController : SingletonMonoBehaviour<BattleController>, ILuaCallCSharp, IHotfixable, …
```

### 2.5 关键锚点类清单

#### 2.5.1 玩家存档根

| 锚点 | 路径 | 行数 | 关键内容 |
|---|---|---:|---|
| `PlayerDataModel` | `Assembly-CSharp/Torappu/PlayerDataModel.cs` | **495** | `public class PlayerDataModel`（第 10 行）；类型 Token `0x2000CBB`；字段常量 `ACTIVITY_FIELD="activity"`(13)、`SANDBOX_PERM_FIELD="sandboxPerm"`(16)、`SANDBOX_PERM_TEMPLATE_FIELD="template"`(19)；字段 `events`(24) `pushFlags`(28) `status`(32) `monthlySub`(36) `troop`(40) `dungeon`(44) `checkIn`(48) `openServer`(52) `activity`(57) `templateTrap`(61) `retro`(65) `dexNav`(69) `skin`(73) `medal`(77) `PlayerAvatar`(82) `collectionReward`(86)；72 个 Token 属性 |
| `PlayerStatus` | `Assembly-CSharp/Torappu/PlayerStatus.cs` | **281** | `public class PlayerStatus : IHotfixable, IPlayerStatus`（第 12 行）；`nickName`(16) `nickNumber`(20) `serverName`(24) `ap`(28) `lastApAddTime`(32) `lastRefreshTs`(36) `lastOnlineTs`(40) `level`(44) `exp`(48) `maxAp`(52) `practiceTicket`(56) `gold`(60 附近)；FieldOffset `0x30…0x58` 连续 |

> 阅读提示：`PlayerDataModel` 只有 495 行/72 个字段，因为它**只到第一层**——每个字段的具体结构在 `Torappu/Player*Data.cs` 里各自的文件中（如 `PlayerTroop.cs`、`PlayerSkins.cs`），这也是扁平 `Torappu/` 里 `*Data.cs` 多达 946 个的原因。

#### 2.5.2 战斗（客户端表现层，服务端不移植）

| 锚点 | 路径 | 行数 |
|---|---|---:|
| `BattleController` | `Assembly-CSharp/Torappu.Battle/BattleController.cs` | **11667** |
| `Buff` | `Assembly-CSharp/Torappu.Battle/Buff.cs` | **15970** |
| `BattleFinishBkg`（结算背景，最小样例） | `Assembly-CSharp/Torappu.Battle/BattleFinishBkg.cs` | 16 |
| `Attributes`（位标志与 enum2int 重灾区） | `Assembly-CSharp/Torappu.Battle/Attributes.cs` | — |

`BattleController` 声明（第 41 行）：`public class BattleController : SingletonMonoBehaviour<BattleController>, ILuaCallCSharp, IHotfixable, ISingletonNotAutoCreate, ISingletonMonoHost` —— 说明战斗核心同时挂 Lua 热更与单例宿主，**类图不可当纯 C# 看**（有 Lua 侧同名逻辑）。

#### 2.5.3 战斗结算类族（18 个文件，合计 917 行，全部位于扁平 `Torappu/`）

```
$ cd reference/arknights-2.7.71-csharp/Assembly-CSharp/Torappu
$ ls | grep -i 'FinishBattle'                  # 18 个
$ wc -l *FinishBattle*.cs | tail -1            # 917 total
```

| 文件 | 行数 | 角色 |
|---|---:|---|
| `DefaultFinishBattleRequest.cs` / `…Response.cs` | 13 / 82 | 最简档（示例/训练） |
| `CampaignFinishBattleRequest.cs` / `…Response.cs` | 13 / 59 | 主线/活动关卡 |
| **`CommonFinishBattleRequest.cs` / `…Response.cs`** | **154 / 139** | **主结算载体**（字段最多，服务端结算解析入口） |
| `RoguelikeFinishBattleRequest.cs` / `…Response.cs` | 30 / 46 | 集成战略 |
| `RuneFinishBattleRequest.cs` / `…Response.cs` | 25 / 58 | 符文 |
| `IFinishBattleResult.cs` / `IFinishBattleServiceSender.cs` / `IFinishBattleServiceConfig.cs` / `IFinishBattleWithLog.cs` | 8 / 20 / 27 / 11 | 结算服务抽象 |
| `FinishBattleServiceConfig.cs` / `LongFinishBattleServiceConfig.cs` | 99 / 91 | 长连接/普通两种上传策略配置 |
| `FinishBattleResponseExtraData.cs` / `FinishBattleRespExtraSixStarData.cs` | 17 / 25 | 响应附加数据（六星附加判定） |

规律：**结算按玩法分型，各自一对 `Request`/`Response`**，公共字段下沉到基类 + `FinishBattleResponseExtraData`。服务端要新增玩法结算，须先确认是否已有对应 `*FinishBattleRequest`，否则字段语义无权威来源。

#### 2.5.4 excel 数据类的存放规律

- **位置**：全部在扁平命名空间 `Torappu`（目录 `Assembly-CSharp/Torappu/`），**没有** `Torappu.Excel.*` 之类的命名空间（实测命名空间名中 `Excel` 命中 0）。
- **两种粒度**：
  - 行数据：`*Data.cs`（946 个）——与 excel 行一一对应；
  - 表容器：`*Table.cs`（37 个）——表级元信息 + 字典装载。
- **37 个 `*Table.cs` 全量清单**（`ls Torappu | grep 'Table\.cs$'` 实测）：

```
ActArchiveComponentTable  ActivityTable  AprilFoolTable  ArkOdcTable  CampaignConstTable
CampaignTable  CharMetaTable  CharWordTable  CheckInTable  ClimbTowerTable  FavorTable
HandbookInfoTable  HotUpdateMetaTable  MetaUIDisplayTable  MissionTable  ReplicateTable
RetroStageTable  RoguelikeActivityTable  RoguelikeConstTable  RoguelikeItemTable
RoguelikeTable  RoguelikeTopicTable  RuneTable  SandboxPermTable  SandboxV3BuildConfigTable
SandboxV3BuildingTable  SandboxV3RandomLevelTable  ServerItemTable  SkinTable
SpecialOperatorTable  StageDiffGroupTable  StageTable  StoryReviewMetaTable  TipTable
UniEquipTable  WeeklyForceOpenTable  ZoneTable
```

- **与 schema/物化数据的映射**：`scripts/vendor/fbs-schemas/*.json`（61 个文件，实测 `ls | wc -l`）每文件对应一张 excel 表，文件内 `tables` 键为 `clz_Torappu_<Type>` 或嵌套 `clz_Torappu_<Outer>_<Inner>`；例如 `item_table.json` 的 root 是 `clz_Torappu_InventoryData`，内含 `clz_Torappu_ItemData_StageDropInfo`。schema 键 → CS 类型的反向解析在 `scripts/cs2schema.ts`（`for (const [key, oldFields] of Object.entries(schema.tables))`，只处理 `clz_` 前缀，`const base = file.replace(/\.json$/, "")` 得表名）。
- **生成链**：`Torappu/*Data.cs`(含方法体) + `com.hypergryph.arknights_<ver>.cs`(签名) → `scripts/generate-types.ts --excel/--playerdata` → `app/game/excel/types_excel_gen.ts` / `types-playerdata.ts`（后者 796 interfaces / 1065 enums，数字来自 AGENTS.md，**本任务未复验**）。

### 2.6 未验证项

- ~~全树总行数未测~~ **已补测**：`Assembly-CSharp` 5,617,383 行、`Torappu.Common` 49,895 行（命令见 §1.1）。其余 11 个程序集（合计 298 文件）未单独统计总行数。
- 程序集的**精确字节数**：`du -sb`（需逐文件 stat，22017 次）在 60 s 超时；本章采用 `du -sh` 的块计数结果（Assembly-CSharp 219M / 总计 221M）。精确字节仅对 `com.hypergryph.arknights_2.7.71.cs`（58,391,453 B，来自 `ls -la`）与 `Arknights.7z`（142,011,422 B）成立。
- 闭包/迭代器噪音计数只抽样了 `Torappu.Battle`（868 文件）与 `Torappu.UI` 的少量文件；**全仓** 22017 文件的比例未统计（递归 grep 全树在本机不可行）。
- `types-playerdata.ts` 的 796/1065 数字转引自 `AGENTS.md`，未在本任务中重新计数。

## 3. 网络与协议层（2.7.71 反编译 ⇄ DoctorateTs 私服）

> 分析对象：`reference/arknights-2.7.71-csharp/`（Cpp2IL + ilspycmd 反编译，**方法体大多未恢复**，只有签名/常量/字段）、`reference/com.hypergryph.arknights_2.7.71.cs`（58MB 全量签名 dump，无方法体）、`app/`（本私服）。
> 证据分级：**【已验证】** = 本文件作者实际读过源码 / 跑过 grep 或脚本所得；**【推测】** = 由签名结构、命名或第三方实现推断，未取得直接证据；**未取证** = 明确说明无法确认。
> 口径边界：反编译源码是**签名级**的——`Networker.cs` 里 `_GenerateRequestHeader`、`_ParseServiceUrl`、`_PostImpl` 等关键方法体是 `return null;` / 空体（见 `Torappu.Common/Torappu.Network/Networker.cs:1855-2026`）。因此凡是"运行时才确定"的细节（header 全量名单、URL 拼接字符串），本文只给**能取证的常量、字段与调用形状**，不作补全式编造。

---

### 3.0 结论速览

| 主题 | 结论 |
| --- | --- |
| 请求链路 | `Networker.SendRequest<Res>(Request{serviceCode, body, overrideUrl, isRetry, header})` → `_ParseServiceUrl(entry, serviceCode)` 拼 URL → `_GenerateRequestHeader` 造头 → `_PostImpl` → UnityWebRequest / BestHTTP 二选一（大请求 61440B 走专用通道）→ `_ProcessHttpWebResponse` → `RespMsgBundle<T>` |
| Route 形态 | **不是**两个命名段，而是「base URL（`Networker.Configuration` 里的 gameServerUrl/sdkServerUrl…）+ 单个 `serviceCode` 字符串」；`ServiceCode.cs` 348 个常量里 **139 个不带前导 `/`**（如 `building/buildRoom`），说明 `serviceCode` 允许是相对段，前导 `/` 在拼接期补 |
| URL 配置 | 客户端先拉 `/config/prod/official/network_config`（`{sign, content}`，MD5-RSA 验签）→ `NetworkRouterConfig.Content.configs[CUR_FUNC_VER].network` → `Networker.Configuration`；私服 `app/core/config/prod.ts:90` 返回 **`sign:"sign"` 占位**（非真签名），靠 Frida hook 绕过验签 |
| Header | 能确证的只有 `secret`（服务端 `app/game/app.ts:68,76`；客户端 `Networker.LoginInfo.secret`）、`uid`（客户端 `LoginInfo.uid`；ODPY 参考实现读 `Uid` 头）、`Content-Type`/`Content-Encoding`（`Networker.cs:1357-1369`）。**全量 header 名单在反编译源码中无法取证**（唯一构造点 `_GenerateRequestHeader` 方法体未恢复） |
| Body 编码 | 游戏接口 = **JSON**（`CONTENT_TYPE_JSON`，`application/json`）+ 上传场景 `multipart/form-data`（JSON 部件名 `json`、文件名 `json_info`）；**HTTP 报文与 FBS/FlatBuffers 无关**——FBS(FBO) 只用于 excel 游戏数据。私服 `MASK_V2`/AES-128-CBC 也只在 excel 数据管线（`scripts/official-excel.ts:182-205`），不在协议层 |
| Delta 补丁 | 响应体 `playerDataDelta: {modified: JObject, deleted: JObject}`（客户端 `PlayerDataDelta.cs:805-820`；基类 `PlayerDeltaResponse.playerDataDelta`，525 个 Response 类继承它）；服务端同一形状 `app/game/kernel/PlayerStatus.ts:62` |
| 错误码 | 4 层：`ResponseStatus` 9 值枚举 → `ResponseError{statusCode,error,message,code,level,errorStatus}` → 客户端自定义码 `10000/10010/10020/20000/30000` → 每端点 `*Response.ResultCode` 业务枚举（实测 `RoguelikeTopicSetSeedResponse.ResultCode` 7 值） |
| 协议类规模 | 全树（Assembly-CSharp）**748 个 `*Request.cs` + 694 个 `*Response.cs` = 1442 文件 → 1489 个类声明（746 Request / 689 Response）**；题面所指 `Assembly-CSharp/Torappu/` 平铺目录只是子集（290+286 文件 → 564 类） |
| 私服契约差异 | ①**已确认缺失 9 条 route**（`/rlv2/finishGame`、`/activity/act1dp/*`×2、`/activity/act54side/*`×2、`/sandboxPerm/sandboxV2/racing/{register,learnTalent,release,saveMark}`）；②`docs/接口覆盖分析-未实现与stub清单.md`（2026-08-17）的"6 条未实现"**已过时**——其中 5 条现已实现；③`network_config` 签名为占位；④3 处请求契约字段名/结构不一致（`BuildingBuyLaborRequest` / `CancelNormalGachaRequest` / `ChangeAvatarRequest`） |

---

### 3.1 一次请求的完整链路

#### 3.1.1 配置获取与 URL 拼装

**（a）网络配置来源（已验证）**

1. `NetworkRouter.FetchConfig()`（`Assembly-CSharp/Torappu.Network/NetworkRouter.cs:310-348`）取 `NetworkOptions.GetActiveRouterUrl()`（`Torappu.Common/Torappu.Network/NetworkOptions.cs:121`），经 `NetworkUtil.ConvertLatestUrl()` 后 `SendGet(url)`，并置 **`forceNotSecured = true`**（`NetworkRouter.cs:334`；`forceNotSecured` 定义在 `WebHttpResult.cs:27`）。
2. 响应 `{sign, content}` 反序列化为 `NetworkRouterConfig`（`NetworkRouterConfig.cs:59-65`：`sign`、`content`），用 `GlobalOptions.cryptoPubKey.text` 做 `CryptUtils.VerifySignMD5RSA(content, sign, pubKey)`，失败抛 `NullReferenceException`（`NetworkRouter.cs:401-416`）。
3. 验签通过后 `JsonConvert.DeserializeObject<NetworkRouterConfig.Content>`；`Content` 含 `configVer / funcVer / configs: Dictionary<string, Config>`（`NetworkRouterConfig.cs:12-38`），`Config` 含 `useOverride`(JsonProperty `override`) 与 `network: JObject`（`NetworkRouterConfig.cs:41-57`）。
4. `Content.GetCurrentConfig()` 按 `VersionCompat.CUR_FUNC_VER` 取当前配置（`NetworkRouter.cs:352-370`，line 362 引用 `CUR_FUNC_VER`）。
5. `Networker.Configuration.FromNetConfiguration(Config)`（`Networker.cs:192`）把 `network` JObject 展平成 11 个 URL 字段：`gameServerUrl / sdkServerUrl / u8ServerUrl / hotUpdateUrl / htUdtVerUrl / remoteConfigUrl / announceUrl / preAnnounceUrl / serviceLicenseUrl / officialUrl / packageDownloadUrlAndroid / packageDownloadUrlIOS` + `devsdk`（`Networker.cs:125-183`）。

**（b）私服侧的对应实现（已验证）**

- `app/server.ts:213` `app.use("/config/prod", prod)`；`app/core/config/prod.ts:90-95` `GET /official/network_config` 返回 `{ sign, content }`，但 **`sign` 是字面量 `"sign"`（`prod.ts:92`）**，且 `data/config.json:118` 的 `privateKey` 为空串 → 私服并未实现 MD5-RSA 签名。客户端 `NetworkRouter` 侧会验签失败，因此必须依赖：
  - Frida hook 把 `Networker.get_overrideRouterUrl` 直接改写成 `http://<私服IP>:8443/config/prod/official/network_config`（`hook/main.ts:273-283`，**当前被注释**，见 §5），或
  - 把 `CryptUtils.VerifySignMD5RSA` 恒返回 `true`（`hook/main.ts:284-292`，**同样被注释**）。
- 另有官方新版路径 `GET /api/remote_config/1/prod/default/{Windows|Android}/network_config`（`app/core/config/remote-config.ts:81,97`），与客户端 `NetworkOptions.BuildNetworkConfigUrl()`（`NetworkOptions.cs:156`）/ `NetworkUtil.CreateNetworkConfigUrl()`（`Assembly-CSharp/Torappu.Network/NetworkUtil.cs:238`）对应。

**（c）单次业务请求的 URL（已验证 + 推测）**

- 请求对象是 `struct Request { string serviceCode; IMsgBundle body; string overrideUrl; bool isRetry; Dictionary<string,string> header; bool isGameService {get;} }`（`Torappu.Common/Torappu.Network/Request.cs:7-38`）。
- 入口：`Networker.SendRequest<ResType>(Request request)`（`Networker.cs:1786`）与 `SendMultiFormRequest<ResType>(Request, BinaryData[])`（`Networker.cs:1793`）；另有裸 URL 的 `SendGet(url,param)`（1800）、`SendPost(url,param,contentType)`（1814）、`SendPost(url,param,contentType,header)`（1821）、`YieldSendGet/YieldSendPost`（1807/1828）。
- URL 拼接唯一入口是 **`private string _ParseServiceUrl(string entry, string serviceCode)`（`Networker.cs:1855`）**，方法体未恢复。**【推测】**`entry` 取自 `Configuration`（按 `Request.isGameService` 在 `gameServerUrl`/`sdkServerUrl`/`u8ServerUrl` 间选择），`serviceCode` 追加在其后；证据是 `serviceCode` 常量**两种前缀形态并存**：
  - 带 `/`：`/account/login`、`/rlv2/createGame`、`/quest/battleStart`；
  - 不带 `/`：`building/buildRoom`（`ServiceCode.cs:659`）、`charBuild/upgradeChar`、`shop/getSkinGoodList`、`mail/receiveAllMail` …
  全量统计（脚本 `tmp/decompiled-analysis/.servicecode-consts.txt`）：`ServiceCode.cs` 共 **348 个 `public const string`，其中 139 个不带前导 `/`**。
- 实测的真实 serviceCode 值（调用点，已验证）：`"/rlv2/battleFinish"`、`"/trainingGround/battleFinish"`——由 `FinishBattleServiceConfig(serviceCode)` / `StartBattleServiceConfig_SendService(serviceCode, request)` 传入（`Assembly-CSharp/Torappu/FinishBattleServiceConfig.cs:45`、`Torappu/BattleStartController.cs:1098`、`Torappu/IFinishBattleServiceSender.cs:11`）。
- 因此**不是** serviceName+route 两个字段，而是「base（entry）+ 单串 serviceCode」；`_ParseServiceUrl` 同时负责补前导 `/`（推测）。

#### 3.1.2 请求头

唯一构造点是 `private Dictionary<string,string> _GenerateRequestHeader(Request request)`（`Networker.cs:2023`，**方法体未恢复**）；所有 header 都经由它汇总——`WebHttpResult.beforeRequest: Func<string,string,bool>`（`WebHttpResult.cs:19`）与 `WebHttpResult.response`（`:15`）是钩子点。

| Header | 证据 | 等级 |
| --- | --- | --- |
| `secret` | 服务端读/改写 `req.headers.secret`（`app/game/app.ts:68,76`）；客户端 `Networker.LoginInfo.secret`（`Networker.cs:207`）、`m_loginInfoHash`（`:340`，推测为登录态指纹） | 已验证（存在性/用途） |
| `uid` | 客户端 `LoginInfo.uid`（`Networker.cs:203`）；第三方参考实现 ODPY 直接 `request.headers.get("Uid")`（`reference/opendoctoratepy-ex-public/server/account.py:26`，**大小写按 Flask 不敏感**） | 已验证（客户端字段 + 参考实现）；header 名大小写未取证 |
| `Content-Type` | `Networker.cs:1357` `application/json`、`:1360` `image/jpeg`、`:1363` `multipart/form-data`；`SendPost(url,param,contentType,...)` 显式传 contentType（`Networker.cs:1814/1821`） | 已验证 |
| `Content-Encoding: gzip` / gzip 响应解包 | `Networker.cs:1366`、`GZIP_MAGIC_BYTES`（`:1369`）、`_CheckIfGZip`（`:1982`）、`_ReadWebRequestResponse(request, enableGZip, ...)`（`:1975`） | 已验证（常量与方法签名） |
| `Authorization` | 仅见 `reference/opendoctoratepy-ex-public/server/admin/admin.py:10,33`（**管理端**），非游戏协议 | 与游戏协议无关 |
| 平台 / token / 版本 | **未取证**。`NetworkUtil.GetPlatformKey()`（`NetworkUtil.cs:55` 起）与 `PlatformKey` 枚举用于**URL 平台段**（`.../default/Windows/network_config`，见 `app/core/config/remote-config.ts:81,97`）；`token` 只出现在 SDK 请求体字段（`AuthRequest.token`）与登录页字典（`Torappu.UI.Login/LoginNativeLicense.cs:196,281`） | 未取证 |

- 另有一层**原生防护**：`NetworkSecurity.Init/SecureUrl(rawUrl, out newUrl, out errorCode)/SecureHeader(Dictionary<string,string>)`（`Torappu.Common/Torappu.Network/NetworkSecurity.cs:12-28`），方法体为空（native 实现），`Networker._SecureUrl(url, out secureUrl, out errorCode)`（`Networker.cs:2066`）是包装；`WebHttpResult.forceNotSecured` 可跳过（`WebHttpResult.cs:27`）。**【推测】**SecureHeader 会注入签名/校验类字段，但字段名无法从 C# 侧取证。
- 全树 grep（脚本 `tmp/decompiled-analysis/.flat-header-strings.raw`，`grep -rnE '"(secret|uid|Authorization|User-Agent|token|X-[A-Za-z-]+)"' reference/.../Assembly-CSharp/`）**没有任何 HTTP header 名常量**，仅命中 protobuf/遥测字典 —— 反向支持"header 名硬编码在被 Cpp2IL 丢掉的 native/方法体里"这一判断。

#### 3.1.3 HTTP 方法与 body 编码

- 方法：`private enum HttpMethod { NONE, GET, POST }`（`Networker.cs:20-28`）——**只有 GET/POST**，与 `api.md` 所述"游戏接口均为 POST"一致（`api.md:5`）。GET 用于 `SendGet`（`NetworkRouter` 拉配置、公告等）。
- 内容类型常量：`application/json` / `image/jpeg` / `multipart/form-data`（`Networker.cs:1357-1363`）。
- multipart：`MULTI_FORM_JSON_PART_NAME = "json"`、`MULTI_FORM_JSON_PART_FILE_NAME = "json_info"`（`Networker.cs:1399-1402`）；二进制附件模型 `BinaryData { fileName, fileBytes, contentType, fieldName }`（`BinaryData.cs:6-22`）；走 `SendMultiFormRequest`（`Networker.cs:1793`）。`isMultiFormAvail`（`Networker.cs:307`）为可用性开关。
- **JSON 而非 FBS**：`MsgBundle<T>.Serialize(JsonSerializerSettings)`（`MsgBundle.cs:16`）与 `RespMsgBundle<T>.Deserialize(string text, ...)`（`RespMsgBundle.cs:33`）都只处理**字符串**，序列化器是 Newtonsoft.Json（`using Newtonsoft.Json`，`MsgBundle.cs:2`）。反编译树中不存在把请求体写成 FlatBuffers 的路径。
- **FBS/FlatBuffers 与 HTTP 协议无关**：FBO 只承载 excel 游戏数据（详见 §2）。
- **MASK/AES**：私服侧 `MASK_V2` 与 AES-128-CBC 仅用于 excel 数据解密（`scripts/official-excel.ts:182-205`，`aesDecrypt` 从 `subarray(128)` 起解、key=mask[0..16)、iv=data[0..16) XOR mask[16..32) + PKCS7 去填充；`MASK_V2 = vendor/lua-crypt.ts LUACRYPT_MASK`）；**不在 HTTP body 编码链路上**（已验证）。
- 大请求分流：`LARGE_REQUEST_THRESHOLD = 61440`（60KB，`Networker.cs:1390`）、`_CheckIfUseExtraLargeRequest(url, text)`（`:1954`）、`_PostExtraLargeReqeust`（`:1946`）；传输实现三选一：`_PostWithUnityWebRequest`（`:1962`）、`_PostWithBestHttp`（`:1996`）、`CheckIfUseBestHttp(url, isRetry)`（`:1933`）。

#### 3.1.4 响应解包与 delta 补丁

- 响应模型：`struct Response<T> { ResponseStatus status; ResponseError error; RespMsgBundle<T> body; }`（`Response.cs:6-19`）。
- **请求侧 bundle 支持 population**：`struct MsgBundle<T> : IMsgBundle, IMsgBundleWithPopulation`（`MsgBundle.cs:8`），有 `Serialize(JsonSerializerSettings)`（`:16`）、**`Serialize(JObject population, JsonSerializerSettings)`（`:23`）**、`Deserialize(text, setting)`（`:30`）。population = 客户端把本地已有的 `JObject` 作为填充源/模板合入请求体（`IMsgBundleWithPopulation` 定义 `Torappu.Common/Torappu.Network/IMsgBundleWithPopulation.cs:8-13`）。
- **响应侧不含 population**：`struct RespMsgBundle<T> : IMsgBundle { T data; object meta; }`（`RespMsgBundle.cs:7-15`），私有 `_IsCustomizedBundle()`（`:19`）、`Serialize`（`:26`）、`Deserialize(text, setting)`（`:33`）。
- `meta` 与 mock 语义：`RespMsgBundle.meta`、`MockMeta { [JsonProperty("case")] serviceCase; object meta; }`（`MockMeta.cs:7-19`）、`RequestResult<T>.mockMeta`（`RequestResult.cs:19`）——mock/回放链路的应答标注（`EmptyRequestHandler` 只是抛 `_NotImplemented()` 的占位实现，`Networker.cs:63-124`）。
- **delta 补丁形状（已验证，双端一致）**：
  - 客户端：`abstract class PlayerDeltaResponse : IPlayerPushMsgResponse { [JsonProperty("playerDataDelta")] PlayerDataDelta playerDataDelta; [JsonProperty("pushMessage")] List<PlayerPushMessage> pushMessage; }`（`Assembly-CSharp/Torappu/PlayerDeltaResponse.cs:10-22`）；常量 `DELTA_FIELD="playerDataDelta"`、`MODIFY_FIELD="modified"`、`DELETED_FIELD="deleted"`（`PlayerDataDelta.cs:805-810`）、`public JObject modified; public JObject deleted;`（`:815-820`）；内部 `DirtyPath` 亦持 `m_modified: JObject` / `m_deleted`（`:299-307`）。
  - 服务端：`get delta(): { playerDataDelta: { modified: {}; deleted: {} }; changed: boolean }`（`app/game/kernel/PlayerStatus.ts:62`），响应统一 `res.send(player.delta)`（AGENTS.md「Response contract」）。
  - 全树统计：**525 个 `*Response` 类直接继承 `PlayerDeltaResponse`**（§3.2），即绝大多数游戏响应都带 `playerDataDelta`。
- 序列号/重试上下文：`m_seqNum`、`m_latestSucceedSeqNum`、`m_lastSeqNumFailed`、`m_serviceCount`（`Networker.cs:1424-1436`）+ `PostRetryContext { HTTPRequest lastRequest; bool isRetry; }`（`:226-266`）。**【推测】**seqNum 用于请求排序/重试去重；具体语义无法从签名确认。

#### 3.1.5 超时与重试（已验证常量 + 推测行为）

| 项 | 值 | 位置 |
| --- | --- | --- |
| `GENERAL_TIMEOUT` | `30`（推测单位：秒） | `Networker.cs:1387` |
| `LARGE_REQUEST_THRESHOLD` | `61440` | `Networker.cs:1390` |
| 超时错误码 | `CUSTOM_ERROR_CODE_TIMEOUT = 10000` | `Networker.cs:1372` |
| 连接关闭 | `CUSTOM_ERROR_CODE_CONCLOSED = 10010` | `Networker.cs:1375` |
| TLS 错误 | `CUSTOM_ERROR_CODE_TLS_ERROR = 10020`（private） | `Networker.cs:1378` |
| 安全系统基址 | `CUSTOM_ERROR_CODE_SECURE_BASE = 20000` | `Networker.cs:1381` |
| 客户端内部错误 | `CUSTOM_ERROR_CODE_CLIENT_ERROR = 30000` | `Networker.cs:1384` |
| 重试判定 | `_CheckNetworkShouldRetry(WebHttpResponse)`（`:1926`）、`Request.isRetry`（`Request.cs:23`）、`RetryContext`（`:226`）、`PostRetryContext.BestHttpBeforeSendRequest`（`:261`） | — |

- 私服侧无对应重试实现（客户端行为）；服务端仅在 `app/game/app.ts:88-118` 做**同 uid 请求串行化**（`acquireLock`），与超时无关。
- 空闲保持：`IdelPeriodGameServerProbe`（`Assembly-CSharp/Torappu.Network/IdelPeriodGameServerProbe.cs:12`），`IDEL_SECS_DEFAULT = 60`、`IDEL_SECS_MIN = 10`（`:218-221`），内部 `PingRequest` / `PingResponse : PlayerDeltaResponse { long now; long next; }`（`:15-37`），有 `OnBeforeRequest()`（`:286`）/`OnHandleResponse()`（`:301`）/`_OnIdelIntervalEnd()`（`:336`）——**【推测】**空闲 60s 后 ping 游戏服探活。

#### 3.1.6 错误码体系

**第 1 层：`ResponseStatus` 枚举（9 值，顺序即取值 0..9）** — `Torappu.Common/Torappu.Network/ResponseStatus.cs:6-27`

```
0 OK  1 ERROR_IGNORE  2 ERROR_RETRY  3 ERROR_SYNC_DATA  4 ERROR_RELOGIN
5 ERROR_TIMEOUT  6 ERROR_CLIENT  7 CANCEL  8 ERROR_SECURE_SYS  9 ERROR_UNKNOW
```

**第 2 层：`ResponseError` 结构** — `ResponseError.cs:6-37`

| 字段 | 类型 | 含义（推测） |
| --- | --- | --- |
| `statusCode` | int | HTTP/传输状态码 |
| `error` | string | 错误短名 |
| `message` | string | 文案 |
| `code` | long | 业务码（与 `IsServerBusinessError` 配合，`Networker.cs:1835`） |
| `level` | int | 严重级 |
| `errorStatus` | ResponseStatus | 归一化状态 |

辅助判断：`Networker.IsServerBusinessError(long responseCode)`（`:1835`）、`Networker.IsServerAuthTimeout(long responseCode)`（`:1842`），及转发器 `NetworkUtil.IsServerBusinessError` / `IsServerAuthTimeout`（`Assembly-CSharp/Torappu.Network/NetworkUtil.cs:197-206`，内部 `?? Networker.*`）。

**第 3 层：客户端自定义码** — 见 §1.5 表（10000/10010/10020/20000/30000）。`WebHttpResponse { isTimeout, isError, responseCode, header, text, data, error }` + `GetErrorCode()`（`WebHttpResponse.cs:7-48`）。

**第 4 层：每端点业务 `ResultCode` 枚举（实测样例）** — `reference/com.hypergryph.arknights_2.7.71.cs:461199` 起：

```
public enum Torappu.UI.RoguelikeTopic.RoguelikeTopicSetSeedResponse.ResultCode
{ SUCCESS=0, INVALID_LENGTH=1, INVALID_CHARSET=2, SENSITIVE_WORD=3,
  FUNCTION_CLOSE=4, USER_BANNED=5, FAIL=6 }
```

即业务码是**按响应类型分别定义**的（嵌套在 Response 类里），不是全局统一枚举。全量清单未逐一枚举（58MB 签名文件需全量扫描，本轮只按需抽样，见 `tmp/decompiled-analysis/.setseed-resultcode.txt`）。

**服务端侧（已验证）**：成功统一 `{ result: 0, ...playerDataDelta, data? }`（`api.md:12-27`）；失败经统一异常体系 `GameError(message, code, status, detail)`（`app/game/kernel/http/errors.ts:16-24`）由 `gameErrorHandler` 映射为 `{ status:1, msg, code }` + HTTP 状态码（`app/game/app.ts:160-188`），子类 `BadRequestError(400)/ForbiddenError(403)/NotFoundError(404)/InternalError(500)`（`errors.ts:26-54`）。**注意双轨**：`status: 1` 是 HTTP 层错误信封，与游戏内 `result` 字段并存（例如 `building/handler.ts:195-197` 直接 `res.send({ result: 1, ...player.delta })`）。

---

### 3.2 FBS / FlatBuffers 在本客户端的角色

#### 3.2.1 分界（已验证）

| 域 | 编码 | 载体 |
| --- | --- | --- |
| HTTP 游戏协议 | JSON / multipart | `Networker` + `MsgBundle<T>`（Newtonsoft） |
| 客户端本地游戏数据（excel） | **FBO（FlatBuffers Objects）** | `Google.FlatBuffers.Table` + `FlatStoreUtil` + `FlatLookupConverter` |
| 私服 excel 管线 | FBO schema JSON + 部分 AES-CBC JSON | `scripts/vendor/fbo.ts` + `scripts/vendor/fbs-schemas/*.json`（61 张表） |

#### 3.2.2 客户端的 FBO 表注册与 schema 来源（已验证）

- 运行时库是 Google 官方 C# 实现：`using Google.FlatBuffers;`（`Assembly-CSharp/Torappu.FlatBuffers/FlatLookupConverter.cs:6`），表对象 `Google.FlatBuffers.Table`。
- **注册表**（`FlatLookupConverter.cs`）：
  - `private static Dictionary<Type, DictionaryConverter> s_unpackDictFuncs`（`:10549`）、`Dictionary<Type, ClassConverter> s_unpackClassFuncs`（`:10552`）、`Dictionary<Type, NullableInArray> s_nullableInArray`（`:10555`）、`Dictionary<Type, string> s_rootTypeMD5s`（`:10558`）。
  - `ClassConverter { Func<Table,object> unpack; Func<FlatBufferBuilder,object,Offset<object>> pack; }`（`:21-34`）——**每张表按 C# 运行时 `Type` 注册「解包/打包」函数对**。
  - 静态构造器（`:74855-74866`）→ `_ForceReloadAll()`（`:74870-74915`）：`_LoadClassConverters()` → `_LoadDictConverters()` → `_BuildinNullableInArray()` → **`_LoadRootTypeMD5()`** → `_LoadUniversal*()`。
  - 查询入口：`TryGetClass(Type, out ClassConverter)`（`:74949`）、`TryGetDict`（`:74956`）、`TryGetNullableInArray`（`:74963`）、`GetClass/GetDict`（`:74970/74977`）、`GetMD5(Type)`（`:74984`）。
- **schema 版本指纹**：`_LoadRootTypeMD5()`（`:10816` 起）为每个 root 类型硬编码 6 位 hex，例如 `StageTable → "9f5b77"`（`:10820-10821`）、`GameDataConsts → "20ed20"`（`:10822`）、`GachaData → "286841"`（`:10826`）、`BuildingData → "bae87f"`（`:10832`）、`SkinTable → "a2c857"`（`:10849`）、`RoguelikeTopicTable → "d06993"`（`:10880`）……这是客户端自带的"FBO schema 指纹表"，用来校验下发数据与客户端 schema 是否同版本。
- **字段读取原语**：`FlatStoreUtil`（`Assembly-CSharp/Torappu.FlatBuffers/FlatStoreUtil.cs:16`）——`UnpackJObject(Table,int offset,string defaultVal)`（`:27`）、`IndirectTo(ByteBuffer)`（`:247`）、`TryIndirectTo(Table,int,out Table)`（`:255`）、`UnpackBool/Byte/Ushort/Int/Uint/Long/Ulong`（`:274/287/300/313/324/337/348`）、`UnpackVector3/Vector2/GridPosition`（`:80/142/195`）、集合族 `Unpack*List/Array/HashSet/Dict`（`:493-1161`）、`Unpack(Type,Table,int)`（`:765`）、`UnpackDirectly`（`:780`）、`UnpackRootDict`（`:1161`）。这些签名里随处可见 **`(Table table, int offset)`** ——offset 就是调用方（生成的访问器）写死的 vtable slot。

#### 3.2.3 本仓的 schema 生成与消费链路（已验证）

- 生成：`scripts/cs2schema.ts`（898 行）。头注释即原理声明：
  > 「C# 运行时模型字段序 = 客户端 .fbs 声明序 = FBO vtable slot 序（**slot = 4 + 2×字段序**）」（`cs2schema.ts:4`）
- 字段序规则 = **自身字段 + 基类链字段（自身在前，同名保首次）**（函数 `wireFields(full, seen)` 在 `cs2schema.ts:275-299`，其文档注释在 `:218-224`；泛型实例按实参展开 `wireFieldsInstance`，`:261-273`；泛型合成表名 `clz_<Base>_<arity>_<args>_`，`:249`）。slot 分配点 `slot: 4 + 2 * i`（`:670`，另见 `:765/797`）。
- 必须剔除的非线格式字段：`NON_WIRE_TYPES`（`System.Object`、`LevelData.ActionID/RuntimeData`、`ObscuredRect`，`:195-202`）与 `NON_WIRE_FIELDS`（`StageData.DisplayDetailRewards.{GetPercent,CannotGetPercent,Expectation,SumOfCountWeight}`、`ActivityBossRushData.DisplayDetailRewards.*`、音频 `SnapshotBank.targetFxBank`、`SoundFXBank.mixerDesc`，`:204-211`）。原因写在注释里：**"它们若留在 schema 里会挤占中间 slot，使其后字段整体位移"**（`:192-193`）。
- 消费：`scripts/vendor/fbo.ts`（328 行）——`FBO.fieldOffset(pos, slot)` 实现 vtable 语义：`soffset = u32(pos)` → `vtablePos = pos - soffset` → 读 vtable 声明大小，`slot >= vtableSize` 则字段缺省（`:67-80`）；`tableToJson/_tableToJson` 按 schema 逐字段读（`:92-120`）；`FBO.observer` 是可选的"报文真值审计"钩子（`:30-42`，vtable 字段数 ↔ schema 字段数比对，被 `scripts/schema-audit.ts` 使用）。
- 门禁与交叉校验：`pnpm run schema:check`（CS 签名口径）、`schema:crosscheck`（OpenArknightsFBS 参考口径）、`schema:audit`（报文 vtable 真值口径）；修复记录见 `docs/fbs-schema-repair-2026-09-12.md`（根因 R1–R7，其中 **R3 就是"运行时字段挤占中间 slot → 其后位移"**，`:13`）。

#### 3.2.4 为什么"字段插入中部"会整体错位（已验证，含活样本）

FBO 表头的 vtable 是**定长条目数组**：`vtable[slot]` 与字段一一对应，slot 在**编译期**由字段声明序决定（`4 + 2i`）。官方写入方与读取方必须用同一份字段序；任何在中部插入/删除字段都会让其后的所有 slot 整体平移，读取方按旧 slot 取到的是**相邻字段的字节**，表现为数值离谱（向量长度变天文数字）、结构错位或越界 OOM：

- `scripts/cs2schema.ts:8-9` 直接记录：2.7.71 的 `Torappu.ItemData` 在 `classifyType` 前新增 `reslockStatus`/`canReslock`，旧 schema 的 `StageDropList#30` 起全部前移 4 字节 → 实测向量长度 **8192 / 196608**。
- 本仓 schema 实测 slot 序列（`scripts/vendor/fbs-schemas/item_table.json` → `clz_Torappu_ItemData`，root `clz_Torappu_InventoryData`）：

```
4 ItemId   6 Name   8 Description   10 Rarity   12 IconId   14 OverrideBkg   16 StackIconId
18 SortId  20 Usage  22 ObtainApproach  24 HideInItemGet
26 ReslockStatus  28 CanReslock        ← 2.7.71 中部插入
30 ClassifyType  32 ItemType  34 StageDropList  36 BuildingProductList
38 VoucherRelateList  40 ShopRelateInfoList
```

- 跨版本活样本（`docs/fbs-schema-repair-2026-09-12.md:119-127`）：obs 2.7.61 的 `item_table` 无 `reslockStatus/canReslock`，`classifyType` 在 slot 26；2.7.71 插到 24/28 之间后 `classifyType` 后移 2 槽（30）——**用 2.7.71 schema 解 2.7.61 报文会从 `classifyType` 起整体错位**，这正是 `schema:check` 门禁要拦的形态。
- 反向陷阱（已记录）：CS 声明序≠线上序的少数冻结表（RL0x EndingText 的 `Summary*`，`docs/fbs-schema-repair-2026-09-12.md:73-80`）——生成器在 `wireFields` 与旧定义冲突时**保留旧表**（丢字段比错位更危险，`cs2schema.ts:679`）。

---

### 3.3 协议类清单方法学

#### 3.3.1 统计口径（已验证）

| 口径 | 数值 | 数据源 |
| --- | --- | --- |
| 全树 `*Request.cs` | **748** | `find reference/arknights-2.7.71-csharp/Assembly-CSharp -name "*Request.cs"` |
| 全树 `*Response.cs` | **694** | 同上 |
| 全树 Request/Response 文件 | **1442** | 同上 |
| 类/结构声明（名字以 Request/Response 结尾） | **1489**（Request 746 / Response 689；唯一名 1450） | `tmp/decompiled-analysis/.protocol-census-full.cjs` → `.protocol-census-full.json` |
| 含 ≥1 个 public 字段的类 | **982**（public 字段合计 **2217**） | 同上 |
| 题面所指 `Assembly-CSharp/Torappu/` 平铺目录 | 290 `*Request.cs` + 286 `*Response.cs` → **564 类** | `.protocol-census.cjs` → `.protocol-census.json` |

> 方法学：解析每个文件里 `public [sealed|abstract] class|struct <Name>[: Base[, IFace...]]`，只保留名字以 `Request`/`Response` 结尾者；字段只统计 `public <type> <name>;` 形式（属性的 backing field / private 序列化字段不计）。**基类字段不计入子类字段列表**——这是 §4.4 里许多"注释与字段不一致"的来源，解读时必须带上。

#### 3.3.2 基类继承树（全树，top）

| 基类 | 子类数 | 说明 |
| --- | --- | --- |
| （无显式基类） | 695 | 多数是 namespace 内的独立请求/响应 DTO |
| `PlayerDeltaResponse` | **525** | 全部带 `playerDataDelta`/`pushMessage`（`Torappu/PlayerDeltaResponse.cs:10-22`） |
| `BuildingRequest` | 53 | 基建域统一基类（`Torappu/BuildingRequest.cs`） |
| `CommonFinishBattleRequest` | 33 | 战斗结算请求族 |
| `CommonStartBattleResponse` | 22 | |
| `DefaultFinishBattleResponse` | 21 | |
| `CommonFinishBattleResponse` | 18 | |
| `DefaultStartBattleResponse` | 15 | |
| `EnemyDuelServiceBattleRequest` | 9 | 联机（敌我决斗）域 |
| `ExaminResponse` | 8 | 测验/调查域 |
| `IHotfixable` | 6 | XLua 热修接口作首个"基类"位置出现 |
| `EnemyDuelServiceTeamRequest` | 6 | |
| `CrisisStartBattleBaseResponse/Request` | 4 / 3 | 危机合约战斗基类 |
| `DefaultFinishBattleRequest` / `DefaultStartBattleRequest` | 5 / 3 | |
| `APIV2RequestBase` / `APIV2ResponseBase` | 3 / 3 | HGSDK v2 请求族 |
| `CommonStartBattleRequest` | 3 | |
| `MonopolyCommonGameEventResponse` | 3 | |
| `ISharedItemModel` / `IPlayerStatus` / `IMessageBoardVisitorData` / `IPlayerPushMsgResponse` | 5 / 2 / 2 / 2 | 接口 |

平铺 `Torappu/` 子集的基类分布更集中：`PlayerDeltaResponse 232`、`BuildingRequest 53`、`ExaminResponse 8`、`CommonFinishBattleResponse 8`、`CommonFinishBattleRequest 7`、`CommonStartBattleResponse 4`、`CommonStartBattleRequest 3`。

#### 3.3.3 前缀域 → 类数（全树 1489 类；前缀取"类名最长的已知域名前缀"，其余归"其他"）

| 前缀域 | 类数 | 代表类 |
| --- | --- | --- |
| `Act*`（含 `Act25side*`/`Act42D0*`/`Act54side*`…） + `Activity*` | 240 + 22 | `Act25sideDailyHarvestRequest`、`ActivityGetChainLogInRewardRequest` |
| `Sandbox*`（V2/V3） | **137** | `SandboxV2AlchemyRequest`、`SandboxV3ShopBuyRequest` |
| `Building*` | **120** | `BuildingBuildRoomRequest : BuildingRequest` |
| `Roguelike*` | **116** | `RoguelikeTopicBattlePassPurchaseRequest`、`RoguelikeTopicSetSeedRequest` |
| `AutoChess*` | 38 | `AutoChessCreateTeamRequest` |
| `EnemyDuel*` | 34 | `EnemyDuelServiceBattleRequest` 族 |
| `Car*` | 28 | |
| `ClimbTower*` | 28 | |
| `User*` | 24 | `UserBuyApRequest` 等 |
| `Pay*` | 21 | |
| `DeepSea*` | 18 | |
| `Grocery*` | 18 | |
| `Crisis*` | 16 | `CrisisV2StartBattleRequest` |
| `Item*` | 15 | |
| `VecBreak*` | 14 | |
| `Siracusa*` | 12 | |
| `ArtMagazine*` / `Monopoly*` | 11 / 11 | |
| `Retro*` / `Voucher*` / `ArkOdc*` / `Firework*` | 10 ×4 | |
| `Campaign*` / `Template*` | 9 / 9 | |
| 其他（动词开头或无域前缀） | **444** | `AdvancedGachaRequest`、`BoostPotentialRequest`、`BuyApRequest`、`ChangeAvatarRequest`、`GetXXXRequest`、`ReceiveXXXRequest`、`UpgradeXXXRequest`… |

> 注意：`Gacha*` / `Mission*` / `Shop*` / `Social*` / `Tower*` 在本版本**并非类名前缀**（gacha 类是 `AdvancedGacha/NormalGacha/CancelNormalGacha…`；mission 类是 `AutoConfirmMissions/MissionConfirmMission…`）。因此"前缀域"表只能作为**命名分域的下界**，与路由域（§4）不是一一对应。

#### 3.3.4 典型字段形态（已验证）

- 字段类型分布（2217 个 public 字段）：`string 1006`、`int 376`、`bool 114`、`List<string> 98`、`List<RewardItemModel> 70`、`long 60`、`List<ItemBundle> 16`、`List<int> 14`、`DateTime 13`、`List<ItemGet> 13`、`List<RewardModel> 11`、`JObject 10`、`int[] 10`、`List<RequestSquadSlot> 10`、`SquadFriendData 10`、`PlatformKey 9`、`string[] 9`。
- 形态样例：
  - 极简：`public class BuildingBuildRoomRequest : BuildingRequest { public string roomSlotId; public string roomId; }`（`Torappu/BuildingBuildRoomRequest.cs`）。
  - 中额：`RoguelikeTopicBattlePassPurchaseRequest { string theme; string reward; int cost; }`（`Torappu.UI.RoguelikeTopic/RoguelikeTopicBattlePassPurchaseRequest.cs`）。
  - 战斗：`Act3FunBattleFinishRequest { data, battleData }`、`ArkOdcBattleFinishRequest { data, battleData, operationId?, actorId? }`（注释口径，见 §4.4）。
- 字段名风格：**lowerCamel**，与 JSON 线上名一致（服务端 zod 也按 lowerCamel，见 §4）。

---

### 3.4 与本私服实现的对照

#### 3.4.1 服务端协议结构（已验证）

- 聚合注册：`app/game/routes.ts:87-173` 是**有序声明式路由表** `{prefix, module, exportName?, rewrite?}`；`app/game/app.ts:126-152` 的 `setup()` 并行 `import` 后按声明顺序 `app.use(prefix, router)`。挂载点包括：普通前缀（`/businessCard`、`/account`、`/charBuild`、`/building`、`/quest`、`/user`、`/activity`、`/mission`、`/shop`、`/rlv2`、`/gacha`、`/mail`、`/social`、`/retro`、`/crisis`、`/deepsea`、`/explore`、`/tower`、`/sandbox`、`/campaignV2`、`/autochess`…）、根级挂载（`/` + 模块自带前缀的 `rootRouter`）、URL 重写别名（`/crisisV2`→`/v2`，`routes.ts:50-57`；`/sandboxPerm/sandboxV2|V3`→`/v2|/v3`，`routes.ts:67-78`）。
- 薄壳 + 契约：模块 `routes.ts`/`handler.ts` 只做 `router.post(path, validateBody(zodSchema), handler)`，业务在 manager/logic；契约守卫见 `tests/unit/architecture/schema-first-guard.test.ts`（AGENTS.md「新路由先落 contract」）。**但也有旁路**，例如 `app/game/modules/building/handler.ts:207` 的 `/buildRoom` 没有 `validateBody`，直接在 handler 里读 `req.body`。
- 响应统一：`res.send(player.delta)`（`app/game/kernel/PlayerStatus.ts:62`）。

#### 3.4.2 路由差集（方法 + 覆盖边界）

- 客户端路由全集提取：全树 `grep -rhoE '"/[A-Za-z0-9_/{}.$-]+"'` → 601 条字面量，剔除 `/{0}` 这类插值模板后 **552～553 条**（`tmp/decompiled-analysis/.tree-route-strings.txt`）。这与旧文档 `docs/接口覆盖分析-未实现与stub清单.md`（2.7.61 口径 544 条）量级一致。
- 服务端路由全集：解析 `app/game/routes.ts` 挂载表 + 每个挂载点**所在目录下全部 `.ts`** 的 `.post/.get/.all/use("/path")` 字面量，并补 `/crisisV2`、`/sandboxPerm` 的重写映射 → **1345 条**（脚本 `tmp/decompiled-analysis/.routes-diff-full.cjs` → `.routes-diff-full.json`）。
- 判定为"候选缺失" **62 条**，逐条人工复核后收敛为 **9 条真缺失**（下节）。复核方法：对候选的最后一段/全路径在 `app/` 内做 `grep -rlF`，命中即视为"以循环或数组形式注册"。
- **覆盖边界（必须声明）**：客户端路由集合可能漏掉"运行时拼接"的字符串；服务端集合因为按目录收集而**偏大**（过包含）——所以差集方向是"客户端有、服务端疑似没有"，不会反向报假阳性为真缺失（真缺失仍需人工确认，本报告已逐条确认）。旧文档提到的 `scripts/_extract-routes.py` / `scripts/_diff-client-routes.py` 在当前仓**已不存在**（`ls scripts/` 无此二者），无法复跑其 544 条口径。

#### 3.4.3 确认缺失的 route（9 条，逐条已验证）

| 客户端 route（字面量来源） | 服务端现状 | 证据 |
| --- | --- | --- |
| `/rlv2/finishGame` | 只有 `/roguelike/finishGame`（另一个挂载前缀），`/rlv2` 下无 | 客户端：`Torappu.UI.RoguelikeTopic/RoguelikeTopicService.cs:12`（`FINISH_GAME`）；服务端：`app/game/modules/roguelike/routes.ts:46` 挂 `/roguelike`；`app/game/modules/roguelike/handler.ts`（挂 `/rlv2`）的路由清单 175–831 行**无 finishGame**。全树 grep `RoguelikeTopicService.FINISH_GAME` 无调用点 → 可能是死常量，但路径确未注册 |
| `/activity/act1dp/battleStart`、`/activity/act1dp/battleFinish` | 无 | `grep -rn "act1dp" app/ --include=*.ts` 零命中；客户端字面量在 `.tree-route-strings.txt`（各出现 2 次） |
| `/activity/act54side/reading`、`/activity/act54side/getFinalReward` | 无 | `grep -rn "act54side" app/ --include=*.ts` 零命中（`Act54SideData` 只存在于 excel 类型生成文件） |
| `/sandboxPerm/sandboxV2/racing/register`、`.../learnTalent`、`.../release`、`.../saveMark` | 服务端只有 `/v2/racing/battleStart|battleFinish`（经 `sandboxPermRewrite` 映射为 `/sandboxPerm/sandboxV2/racing/battleStart|battleFinish`） | 客户端 6 条 racing 字面量；服务端 `app/game/modules/sandbox/routes.ts:1103-1140` 只有 battleStart/battleFinish（注释 `routes.ts:1124-1127` 明确说明映射关系） |

**重要更正**：`docs/接口覆盖分析-未实现与stub清单.md:28-33` 列的"6 条完全未实现"在 2.7.71 服务端**已有 5 条落地**：`/rlv2/battlePass/buyReward`（`roguelike/handler.ts:527`）、`/rlv2/copper/change`（`:561`）、`/rlv2/copper/confirmDraw`（`:569`）、`/rlv2/normal/unlockBuff`（`:549`）、`/rlv2/setSeed`（`:541`）；仅 `/rlv2/finishGame` 仍缺。该文档结论已过时。

抽验的"已实现"样本（客户端字面量 ⇄ 服务端注册）：

| route | 客户端证据 | 服务端注册 |
| --- | --- | --- |
| `/activity/bossRush/battleStart` | `.tree-route-strings.txt` | `app/game/modules/activities/bossRush/router.ts:138` |
| `/activity/recycleCharms` | 同上 | `app/game/modules/activities/charm/router.ts:137` |
| `/activity/interlock/refreshSquad` | 同上 | `app/game/modules/activities/interlockRefresh/router.ts:142` |
| `/activity/arkhub/setSecretary` | 同上 | `app/game/modules/activities/arkhub/router.ts:212`（`validateBody(arkhubSetSecretarySchema)`） |
| `/activity/typeAct4d0/getReward` | 同上 | `app/game/modules/activities/typeAct/router.ts:163-164`（`for` 循环 + 模板串注册 → 字面量匹配不到，属工具局限） |
| `/building/useOnePresetQueue` | `.client-building-routes.txt`（7 条之一） | `app/game/modules/building/handler.ts:586`（`/building/*` 共 65 条注册） |
| `/sandboxPerm/sandboxV2/racing/battleStart` | 同上 | `app/game/modules/sandbox/routes.ts:1130`（经 rewrite） |
| `/rlv2/setSeed` | `RoguelikeTopicService.cs:33` | `app/game/modules/roguelike/handler.ts:541` |
| `/trainingGround/battleFinish` | `Torappu/FinishBattleServiceConfig.cs` 调用点字面量 | `app/game/modules/activities/trainingGround/router.ts`（rootRouter） |

#### 3.4.4 客户端-服务端契约不一致（字段名/类型/结构）

服务端源码在 zod schema 上方普遍写了 `/** ... （CS: XxxRequest { a, b }） */` 的契约注释。本轮把**全部 308 条注释**与反编译源码中该类的真实 public 字段逐条比对（脚本 `tmp/decompiled-analysis/.contract-audit.cjs` → `.contract-audit.txt`）：

```
注释条数 308；字段名/顺序完全一致 246；类名在 2.7.71 树中未找到 15；不一致 47
```

**解读警告（已验证）**：47 条不一致里**多数是合理差异**，两类原因：
1. 注释写的是**线上全量字段（含基类）**，而我的 CS 侧只统计"自身 public 字段" —— 例如 `BuildingChangeManufactResponse` 注释 `{change, playerDataDelta}`、CS 自身只有 `change`（`playerDataDelta` 来自 `PlayerDeltaResponse`）；`*Response { result, ... }` 同理。
2. CS 侧字段是 **private 序列化字段/属性**（如 `PlayerDeltaResponse.playerDataDelta` 是 public 但基类字段），或类无 public 字段（`actual=[]`）。

**逐条人工确认的 3 处真实不一致**：

| 端点 | 客户端（2.7.71 CS，已验证） | 服务端 | 判定 |
| --- | --- | --- | --- |
| `/building/buyLabor` | `BuildingBuyLaborRequest { public int costAp; public long ts; }`（`Torappu/BuildingBuyLaborRequest.cs`） | `buyLaborSchema = { buyCount: z.number(), costAp?: number, ts?: number }`（`app/game/modules/building/schemas.ts:388-392`，注释写 `CS: BuildingBuyLaborRequest { buyCount }`） | **字段名不一致**：`buyCount` **不是** 2.7.71 CS 字段；服务端靠 `costAp?/ts?` 可选项兜底，但 `buyCount` 为必填 → 若客户端只发 `costAp/ts` 会 422 |
| `/gacha/cancelNormalGacha` | `CancelNormalGachaRequest { public int slotId; }`（`Torappu/CancelNormalGachaRequest.cs`，**无 tagList**） | `cancelNormalGachaSchema = { slotId?: number, tagList?: number[] }`（`app/game/modules/gacha/schemas.ts:40-44`，注释写 `{ slotId, tagList }`） | **注释/契约多余字段**（`tagList` 在 2.7.71 客户端不存在）；因两者皆 optional 不会拒绝请求，但契约描述失真 |
| `/user/changeAvatar` | `ChangeAvatarRequest { public PlayerAvatarType type; public string id; }`（`Torappu/ChangeAvatarRequest.cs`） | `changeAvatarSchema = { avatar: z.json() }`（`app/game/modules/account/user.schema.ts:25-27`） | **字段名/结构不一致**：服务端只按 `avatar` 透传给 `status.avatar`，与 CS 的 `{type,id}` 形状不同（有意设计，注释已说明"不读内层字段"） |

**注释字段名在图里找不到的 15 个类**（`notFound`）——多为改名/拼写差，属于"契约注释陈旧"风险项，例如 `AutoChessTeamInfo`、`Deploy`、`EditNameCardContent`、`ExploreSelectEventOptionRequest`、`ExploreSelectInitGroupRequest`、`ExploreSelectTargetOptionRequest`、`MissionArchiveClaimNodeRewardRequest`、`RoguelikeNodePosition`、`Anniv7thGetRewardsRequest/Response`、`useCharGachaVoucherRequest`。其中 `useCharGachaVoucherRequest` 在树里确有同名 **小写开头** 的类文件（`Assembly-CSharp/Torappu/useCharGachaVoucherRequest.cs`），说明部分"找不到"只是大小写/命名规范差。**建议**：把契约注释纳入 `schema:check` 类门禁（自动比对 CS 字段名），而不是靠人工抄写。

**另一处结构性不一致（已验证）**：`/config/prod/official/network_config` 的 `sign` 是占位字符串（`app/core/config/prod.ts:92`、`data/config.json:118` 的 `privateKey` 为空），而客户端会做 MD5-RSA 验签（`NetworkRouter.cs:409`）→ **未打 patch 的真实客户端无法通过验签**，必须配合 Frida hook（`hook/main.ts:273-292`，当前被注释，见 §5）或客户端侧 override。

#### 3.4.5 与既有文档的关系

- `docs/接口覆盖分析-未实现与stub清单.md`（2026-08-17，2.7.61 口径）：**总体结构仍可用**（stub 分组、misc-alignment 清单、沙盒 202 语义），但两点必须更新：① "6 条完全未实现"→ 现仅剩 1 条（`/rlv2/finishGame`）；② 其工具脚本 `scripts/_extract-routes.py` / `_diff-client-routes.py` 已删除，结论不可复跑。
- `docs/fbs-crosscheck-2026-09-12.md` / `docs/fbs-schema-repair-2026-09-12.md`：FBO 与协议层**无关**（不同域），§2 只引用其 slot 位移结论，不重复其内容。
- `docs/arkhub-gateway-protocol.md`：是**长连接/帧协议**（奇象巡展 socket 网关，长度前缀帧 + Protobuf 风格 msgId），与本文的 HTTP JSON 协议是两套东西；相关代码在 `Torappu.LongServiceKit.*` / `Torappu.SocketNetwork*` / `Torappu.UI.ActArkhub.Server*`，本报告未深入。

---

### 3.5 抓包 / 观测手段

#### 3.5.1 capture 模式（已验证）

- 入口：`pnpm run start:capture` = `tsx index.ts -s --capture`（AGENTS.md）；亦可用 `data/config.json` 的 `capture.enabled: true`（`app/server.ts:76-77`）。
- 行为（`app/server.ts`）：
  - `:79-87` capture 模式**强制关闭 mod**（`assets.enableMods=false`），保证还原官服原生资源/清单；
  - `:186-210` 捕获非 JSON 原始请求体（multipart），并按 `capture ? "official" : "private"` 选择流量落盘 `source`；
  - `:240-274` 起通用转发管线：`config.capture.asHost`（默认 `https://as.hypergryph.com`）与 `gsHost`（默认 `https://ak-gs-gf.hypergryph.com`），经 `createProxyForwarder({arkhubGateway})` 转发上游并写入统一抓包存储；`resolveProxyTarget(method, url, host, upstreams)` 在 `app/ops/proxy/upstream.ts`；
  - `:255-274` 奇象巡展（arkhub）长连接网关同时挂在 `gatewayPort`（默认 **30000**），记录经 `setGatewayRecordSink(captureManager)` 注入。
- 存储：统一抓包存储 `app/ops/capture/capture-manager.ts` + `capture-db.ts`，落盘 `tmp/capture/`。SQLite 表 `records`（实测 schema，`tmp/capture/index.db`）字段：`rid, session_id, ts, method, path, query, module, endpoint, status, latency_ms, source, direction, req_headers, req_body_type, req_body_file, req_size, res_headers, res_body_type, res_body_file, res_size, note`。
  - 实测状态（2026-09-13 读库）：**2024 条记录，`source` 全为 `private`**（无 `official`/`harness` 记录）→ 当前库里的 header 样本来自本私服的自动化测试客户端（`secret: "1"`、`content-type: application/json`、`user-agent: node`），**不能当作官方客户端 header 证据**。
- 查看：`pnpm run admin -- capture records --json`、`capture sessions/show/stats/export/clear`（AGENTS.md）。
- 独立代理：`pnpm run ts` = `scripts/proxy-harness.ts`（端口 **8444**，`proxy-harness.ts:33`）。它把客户端（network_config 指向本代理）按路径前缀分发到官服主机（`:22-31`：`/config/*`→ak-conf、`/u8/*`→as/u8、`/auth/*`→as、`/app/*`→as/app、`/user/auth|info|online|oauth2*`、`/general/*`→as、`/game/*`→ak-gs、`/api/gate/*`→ak-webview…），转发头**剥离** `host/content-length/transfer-encoding`（`:88-93`），记录 `reqHeaders` 原样入统一抓包存储且 `source="harness"`（`:138-152`）。**这是拿真实官服往返（含真实客户端 header）的唯一现成通道**。

#### 3.5.2 hook / Frida（已验证）

`hook/main.ts`（338 行，`pnpm run hook` 编译为 `2221.js`，不入 tsc）：

- **当前生效**：`Il2Cpp.perform(() => Il2Cpp.dump("d.cs"))`（`:255-261`，延迟 500ms 后 dump il2cpp 元数据）；`Java.perform` 块（`:234-254`）——改写 `com.hypergryph.platform.hgsdk.contants.SDKConst$UrlInfo.getRemoteUrl` 与 `hguseragreement…getRemoteUrl` 为 `${serverUrl}/auth`（`:238-248`，`serverUrl = http://192.168.0.100:8443`，`:221-225`），并跳过 ACE（`com.hg.sdk.MTPProxyApplication.onProxyCreate`、`MTPDetection.onUserLogin`，`:249-253`）。
- **已被注释掉**（`:262-338`，整段 `/* ... */`）——但这正是协议分析最需要的 hook 组合：
  1. `Torappu.Common → Torappu.Network.Networker.get_overrideRouterUrl` → 返回 `${serverUrl}/config/prod/official/network_config`（`:274-283`）；
  2. `Assembly-CSharp → Torappu.CryptUtils.VerifySignMD5RSA` → 恒 `true`（`:285-292`）；
  3. `UnityEngine.Application.CallLogCallback` 的 `Interceptor.attach` 把 Unity 日志转控制台（`:293-337`）。
- 资产观测另有一支：`hook/observe-assetbundle.js`（87 行，纯核心 Frida API，抓 `anon|Bundles` 目录的文件打开，用于判定 gamedata-Lua bundle 名字）+ `scripts/frida-observe.ps1`（63 行，先停 ACE 服务、spawn 游戏、默认 150s 后恢复 ACE）。
- **对本报告的意义**：hook 里对 `get_overrideRouterUrl` 的改写，是"客户端如何决定 router 基址"的**直接行为证据**；`VerifySignMD5RSA` hook 的存在，反过来证明 §4.4 的"私服 network_config 未真签名"必须靠 patch 绕过。

---

### 3.6 未取证 / 推测清单（后续可做的事）

1. **header 全量名单**：`Networker._GenerateRequestHeader`（`Networker.cs:2023`）方法体缺失；`NetworkSecurity.SecureHeader` 是 native。→ 需要 Frida hook `_GenerateRequestHeader` 的 void 方法（当前 hook 未包含）或读 native 符号。**当前只能确证 `secret`/`uid`/`Content-Type` 系列。**
2. **URL 拼接精确串**：`_ParseServiceUrl(entry, serviceCode)`（`Networker.cs:1855`）方法体缺失；`entry` 的具体取值路径未取证（推测来自 `Configuration` + `isGameService`）。
3. **超时单位与重试策略**：`GENERAL_TIMEOUT = 30`（`Networker.cs:1387`）与 `_CheckNetworkShouldRetry`（`:1926`）方法体缺失；`m_seqNum`/`m_latestSucceedSeqNum` 的语义未取证。
4. **`fbc`/FBS 网关（长连接）**：`Torappu.LongServiceKit.Protocol` / `Torappu.SocketNetwork*` 的帧格式与 Protobuf 字段，本报告只确认其存在（`docs/arkhub-gateway-protocol.md` 已覆盖 arkhub 一支），未展开。
5. **官方客户端真实 header 抓包**：`tmp/capture/index.db` 目前无 `official`/`harness` 记录；跑一次 `pnpm run ts -- --session <名字>`（客户端 network_config 指向 8444）即可补上这批证据。
6. **业务 `ResultCode` 全量枚举**：58MB 签名文件需全量扫描（本轮只抽样 `RoguelikeTopicSetSeedResponse.ResultCode`）；命令参考：`grep -n 'ResultCode : $' reference/com.hypergryph.arknights_2.7.71.cs`（注意该文件在 `/mnt/d` 上单次全扫 ~1–2 分钟）。
7. **契约注释门禁化**：把 §4.4 的 308 条 `CS: XxxRequest {...}` 注释接入自动比对（本报告脚本 `tmp/decompiled-analysis/.contract-audit.cjs` 可作为起点，需补"基类字段展开"与"private 序列化字段"两处口径）。

---

### 3.7 附：本报告使用的可复跑脚本与中间产物

| 文件 | 用途 |
| --- | --- |
| `.protocol-census-full.cjs` / `.protocol-census-full.json` | 全树 1442 文件 → 1489 类协议类普查（类名/基类/字段/命名空间） |
| `.protocol-census.cjs` / `.protocol-census.json` | 平铺 `Torappu/` 子集 576 文件 → 564 类 |
| `.routes-diff-full.cjs` / `.routes-diff-full.json` | 客户端 552 条字面量 ⇄ 服务端 1345 条注册（含 rewrite 映射）差集 |
| `.contract-audit.cjs` / `.contract-audit.txt` | 308 条服务端契约注释 ⇄ CS 真实字段比对 |
| `.tree-route-strings.txt` | 全树路由字面量（`grep -rhoE '"/[A-Za-z0-9_/{}.$-]+"'`） |
| `.servicecode-consts.txt` | `ServiceCode.cs` 348 条常量（含 139 条无前导 `/`） |
| `.client-building-routes.txt` / `.server-building-routes.txt` | `/building/*` 客户端 7 条 ⇄ 服务端 65 条 |
| `.flat-header-strings.raw` | 全树 header 名常量 grep 结果（仅 25 处，均为 protobuf/遥测，非 HTTP header） |
| `.setseed-resultcode.txt` | `RoguelikeTopicSetSeedResponse.ResultCode` 枚举实测 7 值 |

## 4. 数据与 schema 生成链路

> 目标读者：后续维护者。本文件的所有结论都带「文件路径:行号」或「真实命令输出」；未亲自验证的一律标 **未验证**。
> 环境注记（重要）：本会话 WSL 沙箱里 `HOME=/root` 为只读，`pnpm` 直接崩：
> `Error: create the package-manager env directory at /root/.local/share/pnpm/global/v11 — Read-only file system (os error 30)`；
> 设 `XDG_DATA_HOME=<可写目录>` 后 `pnpm` 不报错但**永久挂起**（`timeout 20 pnpm --version` → rc=124）。
> 因此三条门禁改用 `pnpm run <script>` 的等价底层命令 `node_modules/.bin/tsx <scripts/...>` 真实执行（与 package.json 的 script 定义逐字一致），
> 下文所有输出均为该方式实测，退出码单独记录。`pnpm` 包装层本身未跑通属于**环境限制**，不是链路结论。

---

### 4.1 链路总览

```
本机官服客户端
  GameAssembly.dll + global-metadata.dat        (scripts/decompile-client.sh:62-63 前置校验)
        │  Cpp2IL 2022.0.7（--experimental-enable-il-to-assembly…，约 20-30 min）
        ▼
tmp/decompile/cpp2il_out/*.dll  (92 个 dummy DLL，含内嵌 IL；scripts/decompile-client.sh:124-138)
        │  ilspycmd 11.0.0.9375（13 个游戏程序集，exit 0/70 都算成功）
        ▼
reference/arknights-<ver>-csharp/  (23,168 个 .cs，含方法体；decompile-client.sh:140-159)
        │  python scripts/dump-cs-signature.py --in cpp2il_out --out …
        ▼
reference/com.hypergryph.arknights_<ver>.cs   ← 签名文件（58.4 MB / 1,046,522 行，2.7.71）
        │                               （decompile-client.sh:161-165）
        │  scripts/lib/cs-source.ts#resolveCsFile() 通配探测最新版本（禁止硬编码）
        ├──────────────────────────────┐
        ▼                              ▼
scripts/cs2schema.ts            scripts/generate-types.ts
  --check / --write               --excel / --playerdata
        ▼                              ▼
scripts/vendor/fbs-schemas/*.json   app/game/excel/types_excel_gen.ts / types-playerdata.ts
（61 文件 / 2953 表 / 554 枚举）      （生成物，禁止手改）
        │
        ▼
scripts/vendor/fbo.ts  解码官方 bundle → scripts/excel-convert.ts 转换 → data/excel/*.json
        ▲                                                              + *.json.meta.json 指纹
        └── scripts/schema-audit.ts 用报文 vtable 真值反查 schema ──────┘
```

三条口径门禁互为交叉验证（AGENTS.md「Schema 生成规则」段）：

| 口径 | 命令 | 对照物 | 是否依赖外部参考 |
| --- | --- | --- | --- |
| `schema:check` | `tsx scripts/cs2schema.ts --check` | CS 签名（`reference/*.cs`） | 否（但依赖本地反编译产物） |
| `schema:crosscheck` | `tsx scripts/fbs-crosscheck.ts` | `reference/OpenArknightsFBS-main/FBS` | 是（社区参考，可能落后一个版本） |
| `schema:audit` | `tsx scripts/schema-audit.ts` | 官方 bundle 报文 vtable 真值 | **否**（唯一不依赖任何外部参考） |

---

### 4.2 阶段一：反编译产物与签名格式

#### 4.2.1 `scripts/decompile-client.sh` 各步骤

- 版本识别：从 `globalgamemanagers` 正则抽三段版本号、从 `global-metadata.dat` 读魔数 `0xFAB11BAF` 与 metadata 版本，metadata < 28 直接 fail（`decompile-client.sh:71-97`）。
- 工具缓存与幂等：Cpp2IL/ilspycmd 缓存在 `tmp/decompile/tools/`；Cpp2IL 已完成判据是「`cpp2il_out/Assembly-CSharp.dll` 存在且日志含 `Done.`」（`:128`）；ilspycmd 已完成判据是「目标目录含 `csharp-src.sln`」（`:142`）。
- 反编译：把 `GAME_ASSEMBLIES`（13 个，`:41-47`）里实际存在的 DLL 交给 ilspycmd，exit code 只接受 `0` 或 `70`（70 = 个别方法体反编译失败，属正常，`:157-158`）。
- 签名生成：`python scripts/dump-cs-signature.py --in "$CPP2IL_OUT" --out "$SIG_FILE"`（`:164-165`）。
- 末尾安全阀：`pnpm exec tsx scripts/cs2schema.ts --check`，非 0 时只**告警**不中断（`:172-184`）。
- 汇总：统计 `*.cs` 文件数、失败方法体数、`Overall analysis success rate`、签名里 Torappu 类/枚举数（`:201-213`）。

一个易忽略的细节：签名文件实际是 **CRLF**（`file reference/com.hypergryph.arknights_2.7.71.cs` → `ASCII text, with CRLF line terminators`），因为 `dump-cs-signature.py:636` 用 `Path.write_text()`，在 Windows Python 上默认把 `\n` 翻成 `\r\n`。消费端已容忍：`cs2schema.ts:68` 用 `split(/\r?\n/)`；`playerdata-parser.ts` 走大正则不依赖行尾。

#### 4.2.2 `dump-cs-signature.py` 抽了什么

它不是调用 ILSpy，而是**纯 Python 手写 ECMA-335 元数据读取器**（`dump-cs-signature.py:1-19` 头注），直接读 Cpp2IL 产出的 dummy DLL：

| 抽取内容 | 实现位置 | 说明 |
| --- | --- | --- |
| `#~` 表流 / heap 布局 | `:37-109`（`TABLE_LAYOUT`）、`:227-255` | 手工解析 TypeDef/Field/MethodDef/Constant/InterfaceImpl/NestedClass/GenericParam 等；列宽按 heap 大小动态判定（`:266-294`） |
| 类 / 结构体 / 枚举身份 | `:494-519` | `extends` 是否 `System.Enum`/`System.ValueType` 决定 enum/struct；`TD_INTERFACE` 决定 interface；abstract+sealed 判 static |
| **基类与接口**（关键） | `:521-536` | 非 enum/struct 才把 `extends` 作为基类，再追加 `InterfaceImpl` 的全部接口；写成 `public class X : Base, IFace` |
| **字段顺序**（关键中的关键） | `:563-578` | 按元数据 `FieldList`→下一行 `FieldList` 的**原始顺序**遍历（`:148` 预计算区间），一行一个字段，**不做任何重排** |
| 字段类型 | `:439-441` + `:376-437` | 解析 FieldSig blob：标量、VALUETYPE/CLASS、GENERICINST、SZARRAY/ARRAY、VAR/MVAR、PTR/BYREF/FNPTR 等 |
| 枚举常量值 | `:542-559` | `value__` 之后把 `MD_LITERAL` 字段渲染成 `public const <Enum> NAME = <n>;`，常量取 Constant 表（`:455-473`） |
| 可见性/修饰符 | `:476-484`、`:571-577` | 渲染成 `public/private/protected/internal` + `static/readonly/const` |
| 嵌套类型展平 | `:321-333` | `Outer.Inner` 点号展平；命名空间前缀只在最外层补 |
| 泛型参数 | `:503-504`、`:310-312` | `class Foo<T0,T1>` 声明形态保留 |
| 方法（**有，但 schema 链路不消费**） | `:582-604` | 会渲染方法签名；`cs2schema` 遇到 `// Methods` 立即 break（`cs2schema.ts:85`） |
| 偏移注释 | `:16-17`、每行 `// 0x0` | 一律写 `0x0`，解析器不消费 |

**结论（回答任务问题）**：签名文件抽了「类/结构体/枚举、基类+接口、字段声明序、字段类型、枚举常量」；**字段序 = 元数据声明序**，这正是 FBO vtable slot 的依据（`cs2schema.ts:4` 注释：`slot = 4 + 2×字段序`）。方法体不在签名里（那在 `reference/arknights-<ver>-csharp/`）。

#### 4.2.3 实测规模（2.7.71）

```
$ wc -l reference/com.hypergryph.arknights_2.7.71.cs
1046522 reference/com.hypergryph.arknights_2.7.71.cs        # 58,391,453 B
$ grep -c '^// ' <sig>            → 92        # 92 个程序集段标记
$ grep -cE '^public (abstract |static |sealed )?(class|struct) Torappu\.' <sig>  → 31527
$ grep -cE '^public enum Torappu\.' <sig>                                        → 2263
$ find reference/arknights-2.7.71-csharp -name '*.cs' | wc -l                    → 23168
```

`cs2schema.ts` 内部解析结果略大（`:216` 打印）：**38702 个类 / 3613 个枚举**——因为它不按 `Torappu.` 前缀过滤，且把 `System.*` 类型也收进 map。

---

### 4.3 阶段二：CS 源路径探测 `resolveCsFile()`

`scripts/lib/cs-source.ts` 是唯一入口：

- `CS_FILE_RE = /^com\.hypergryph\.arknights_.+\.cs$/`（`:25`）——文件名内嵌版本号。
- `resolveCsFile()`（`:38-54`）：优先级 = 显式 `explicit`（存在才用）> `GENERATE_CS`（调用方传入）> `reference/` 下 `readdirSync` 过滤正则后 **`.sort()` 取最后一个**；目录不存在返回 `null`。
- `requireCsFile()`（`:62-72`）：`null` 时抛错并提示先跑 `pnpm run decompile` 或用 `--cs` / `GENERATE_CS`。
- `csVersionOf()`（`:75-78`）：从基名提版本号。
- `PROJECT_ROOT`（`:22`）固定上溯两级（`scripts/lib` → 根），注释 `:15-21` 明确记录了「写一级会探到 `scripts/reference` 而失败」的历史缺陷。

**已知弱点（代码注释自认）**：排序是**字典序**（`:31-32`），跨大版本时 `2.9.x` 会排在 `2.10.x` 之后，取到旧的。当前 `reference/` 只有 `com.hypergryph.arknights_2.7.71.cs` 一个候选（实测 `ls reference/ | grep '\.cs$'` 只此一个），所以暂时不触发。

调用方：`cs2schema.ts:30-34`、`generate-types.ts:26-28`、`excel-convert.ts:259`（`buildMeta` 记 `csSource`）。

---

### 4.4 阶段三：`cs2schema.ts` 生成算法

#### 4.4.1 解析 CS（`parseCs`，`:57-126`）

- 类/结构体/枚举声明正则 `:69` `^public (?:sealed |abstract |static )?(class|struct|enum) ([\w.`]+)`。
- 字段收集正则 `:91`，只收实例字段，跳过 `static/const/readonly`；**私有字段只保留两类**（`:94-97`）：自动属性 backing field `<X>k__BackingField` 与 `m_xxx` 数据成员（注释 `:87-90` 说明漏掉会整片丢数据）。`priv` 标记 `:97`。
- 同时记录 `bases`（首个基类，`:102-103`）与 `baseList`（按尖括号深度切分的完整基类/接口列表，`:104-123`）——泛型基类展开需要原文。

#### 4.4.2 字段表 = 自身 + 基类链（`wireFields`，`:275-299`）

- 自身字段在前，然后递归拼接 base chain；`seen` 防环（`:276`）。
- 基类是**泛型实例**时走 `wireFieldsInstance`（`:261-273`）+ `genericInst`（`:241-253`）+ `substGeneric`（`:256-258`）：`RoomBean<ShopPhase>` → 合成表名 `clz_Torappu_BuildingData_RoomBean_1_Torappu_BuildingData_ShopPhase_`（`:249`，命名与旧 vendored schema 一致）。
- 剔除 `NON_WIRE_FIELDS`（`:204-211`）与 `NON_WIRE_TYPES`（`:195-202`）登记的运行时字段/类型。
- 同名去重保留首次（`:291-298`，注释特意警告不能用 `Set.add` 返回值过滤）。

#### 4.4.3 类型映射（`mapType` `:333-369` / `mapElem` `:370-408`）

- 标量 `SCALAR`（`:135-147`）：`Byte→ubyte`、`Int16→short`、`UInt16→ushort`、`UInt32→int`…（窄整型宽度对齐线格式，`:128-134` 注释给出 `edgeWalkableMask` 越读实例）。
- 线上覆盖 `WIRE_OVERRIDE`（`:159-171`）：反作弊 `ObscuredInt→enum`、`Torappu.Blackboard→vec:clz_Torappu_Blackboard_DataPair`、`JObject→hg__internal__JObject`。
- 集合约定（`:326-408`）：字典字段带 `vec:` 前缀（`vec:dict__K__V`），作为字典值出现时用 `list_dict__K__V`，`KeyValuePair` 用 `kvp__K__V`。
- 无字段的「泛型集合派生类」走 `collectionBaseToken`（`:421-436`）直接内联成集合 token。
- `isListFromGenericBase`（`:454-469`）：`KeyFrames<T>` 系列**故意不重生成**，保留旧合成 token，注释 `:448-452` 记录了「character_table 2377 条 attributesKeyFrames 退化成 `{level:null,data:null}`」的惨案。
- 无法识别的类型进 `ctx`，最终返回字面量 `"unknown"`（`:367-368`）。

#### 4.4.4 闭包补齐（`ensureReferenced`，`:744-814`）

从 `schema.root as string` + 所有字段引用出发（`:749-754`），最多 24 轮迭代到不动点：
1. 泛型实例（`insts`，`:759-778`）；
2. `SYNTHETIC_TABLES` 合成表（`:780-790`，`:179-186` 定义 `hg__internal__JObject` / `hg__internal__MapData`）；
3. CS 类反查（`:791-809`）。
表内容 `JSON.stringify` 比对（`differs`，`:747-748`）保证幂等；含未解析类型则**不生成半成品表**（`:799-801`）。

#### 4.4.5 不可达表清理（`pruneUnreachable`，`:825-841`）

从 root 做引用闭包 DFS，未被引用直接 `delete`。这是 R7 的解，用于清掉旧 vendored 残留（`:817-824` 注释）。

#### 4.4.6 KV 表补齐（`collectMissingKvTables`，`:486-513`）

`dict__K__V` / `kvp__K__V` 不由 CS 类派生，需要按名称现场合成：`Key@4 = K`、`Value@6 = normalizeKvValue(V)`（`:496-499`）；最多 8 轮补嵌套 dict 值（`:502-511`）。`referencedTables`（`:562-578`）负责从字段类型抽表引用（含 `list_X` 解包，`:565-567`）。

#### 4.4.7 两个安全阀 + 退出码契约

- 安全阀 1（`protectedClasses`，`:672-677`）：任何字段类型无法映射 → **整表保留旧定义**，只统计不报错。
- 安全阀 2（`protectedLoss`，`:691-708`）：重生成会丢旧字段 → 保留旧表。但先做**改名判定**（`:698-700`）：同 slot 且线格式种类一致（`wireKind`，`:590-609`）就算改名而非丢失，避免把官方重构误判为结构变化（注释 `:681-690` 记录 `UnlockCond→InitialUnlockCond` 导致 rlv2 招募技能裁剪失效）。历史合成字段 `*AsNumpy` 与 `NON_WIRE_FIELDS` 里的字段不算丢失（`:695-697`）。
- `--check` 退出码契约（`:879-895`）：**只有 slot 位移非 0 退出**；纯类型 token 差异不算失败（int/enum 同义，`eqType` `:614`）。

---

### 4.5 阶段四：生成物 `fbs-schemas/*.json` 形态

实测结构（`scripts/vendor/fbs-schemas/item_table.json` 为例）：

```json
{
  "root": "clz_Torappu_InventoryData",
  "tables": {
    "clz_Torappu_ItemData": [
      { "name": "ItemId", "type": "string", "slot": 4 },
      { "name": "Name", "type": "string", "slot": 6 },
      ...
      { "name": "ReslockStatus", "type": "enum", "slot": 26 },
      { "name": "CanReslock", "type": "bool", "slot": 28 },
      { "name": "ClassifyType", "type": "enum", "slot": 30 },
      ...
      { "name": "StageDropList", "type": "vec:clz_Torappu_ItemData_StageDropInfo", "slot": 34 }
    ]
  },
  "enums": { "...": { "VALUE": 0 } }
}
```

- 三键：`root`（解码起点表）、`tables`（表名 → 字段数组，字段自带 `slot` = vtable offset）、`enums`。
- 字段名是 **PascalCase**（`cs2schema.ts:649` `pascal()`），且同槽位大小写差异时保留旧写法（`:650-660`）。
- `slot` 由位置推导 `4 + 2*i`（`:670`）；类型 token 由 `mapType` 决定。

**实测统计（脚本遍历 61 个 json）：**

```
schema files: 61 | total tables: 2953 | total enums: 554 | empty(0-field) tables: 6
top5: activity_table(1036 表) > sandbox_perm_table(335) > roguelike_topic_table(332)
      > building_data(108) > display_meta_table(92)
```

6 张 0 字段占位表（`building_data:ControlRoomPhase/PowerPhase`、`prts___levels:clz_System_Object`、
`roguelike_topic_table:RoguelikeZoneVariationData/ObscuredRect`、`sandbox_perm_table:ObscuredRect`）——
CS 里对应类无线上字段或类型被 `NON_WIRE_TYPES` 剔空，`ensureReferenced` 留下空占位避免悬空（`:757`）。

---

### 4.6 阶段五：`generate-types.ts` 如何出 TS

1. 选源：`requireCsFile({ explicit: --cs ?? GENERATE_CS })`（`generate-types.ts:26-28`）；显式文件不存在或探测为空直接抛错。
2. 增量跳过（`:86-104`）：若 `types-playerdata.ts` mtime ≥ max(CS mtime, `*adapt.ts`/`types-builder.ts` mtime)，且 `types_excel_gen.ts` ≥ max(CS, 最新 `data/excel/*.json`, adapt) → 打印「类型已是最新…跳过生成」直接 return。**这是纯 mtime 判据，没有内容指纹**。
3. 解析：`buildTypes(content, config)`（`types-builder.ts:127-192`），底层 `playerdata-parser.ts#parseFile`（`:203`）：
   - 只认 `public (abstract )?(class|struct) Torappu.X`（`:207`），只收 `public` 字段（`:215-220`，与 `cs2schema` 收私有 backing field 不同）；
   - 继承合并：基类字段在前、子类覆盖重名（`:237-260`）；`List<T>` 继承 → 数组别名；`Undefinable<T>` 透明展开（`:155-161`）；
   - C#→TS 映射 `mapType`（`:102-178`）：`Dictionary<K,V>→{[key:string]:V}`、`List<T>→T[]`、`KeyValuePair→{Key;Value}`。
4. 闭包：`buildClassClosure`（`types-builder.ts:11-35`）从 roots 沿字段引用扩张；枚举取闭包字段引用到的（`:140-146`）；**自检**未定义引用并抛错（`:148-164`）。
5. 域适配：
   - `--playerdata`：`applyWireFormat(applyServerAdapt(...))`（`generate-types.ts:38`），root = `PlayerDataModel`，JSON 域类型 `ServerPayload`。
   - `--excel`：`reconcileExcelJsonKeys(applyExcelAdapt(...))`（`:55`），roots = `allTableRoots()`（`excel-server-adapt.ts:70-76`，从 `EXCEL_TABLE_ROOTS`（`:14`）聚合，如 `item_table→InventoryData`），JSON 域类型 `JsonValue`。
6. 输出：枚举 → 字符串字面量联合 `export type X = "A" | "B";`（`types-builder.ts:79-84`，可被 `EXCEL_ENUM_ADDITIONS` 补值）；接口/别名 → `generateInterfaceCode`（`:86-121`，含数组别名、纯字典索引签名、交叉类型索引签名）。
7. 头部注明源文件：`从 reference/com.hypergryph.arknights_2.7.71.cs 反编译文件生成`（实测 `types_excel_gen.ts:1-7`），版本从**实际选中的文件名**取（`generate-types.ts:30-31`），不硬编码。

**实测产物规模**（`grep -c`）：

| 文件 | 行数 | `export interface` | `export type` | 其中枚举式联合 |
| --- | --- | --- | --- | --- |
| `app/game/excel/types_excel_gen.ts` | 15323 | 1564 | 363 | 351 |
| `app/game/excel/types-playerdata.ts` | 6048 | 815 | 128 | 115 |

> ⚠️ 与 AGENTS.md 的记载不一致：AGENTS.md 写 `types-playerdata.ts (796 interfaces, 1065 enums)`，
> 实测当前文件是 **815 interfaces / 128 type alias（其中 115 个枚举联合）**。文件 mtime 2026-09-13 10:21:33，
> 晚于 `scripts/playerdata-server-adapt.ts` 的 10:21:23，说明是刚生成过的最新产物；**AGENTS.md 的 1065 enums 数字已与产物脱节**（未验证其统计口径，可能是把 CS 闭包枚举全量算进去了）。

---

### 4.7 三条门禁实跑记录（真实执行）

> 执行方式：`node_modules/.bin/tsx <script>`（等价 package.json 的 `pnpm run <script>`；pnpm 在本沙箱挂起，见文首注记）。
> 日志原件：`tmp/decompiled-analysis/gate-check.log` / `gate-crosscheck.log` / `gate-audit.log`。

#### 4.7.1 `schema:check`（对照 CS 签名）— 退出码 **0**

```
$ time node_modules/.bin/tsx scripts/cs2schema.ts --check
解析 com.hypergryph.arknights_2.7.71.cs：38702 个类 / 3613 个枚举
比对表类: 1821；有差异的表文件: 0（无差异 61）
因未解析类型而保留旧字段表的类: 2
因会丢失旧字段而保留旧字段表的类: 9
丢字段样例（前 9 个）:
  clz_Torappu_SharedCharData 丢: SkinId, Skills, CurrentEquip
  clz_Torappu_BuffData 丢: PriorityBbkeys
  clz_Torappu_LevelData_WaveData_FragmentData_ActionData 丢: ExtraMeta, ActionId
  clz_Torappu_RL01EndingText 丢: SummaryActor, SummaryTop, SummaryZone, SummaryEnding, SummaryDifficultyZone, SummaryDifficultyEnding
  clz_Torappu_RL03EndingText 丢: SummaryActor, SummaryTop, SummaryZone, SummaryEnding, SummaryDifficultyZone, SummaryDifficultyEnding
  clz_Torappu_RL04EndingText 丢: SummaryActor, SummaryTop, SummaryZone, SummaryEnding, SummaryDifficultyZone, SummaryDifficultyEnding
  clz_Torappu_RL05EndingText 丢: SummaryActor, SummaryTop, SummaryZone, SummaryEnding, SummaryDifficultyZone, SummaryDifficultyEnding
  clz_Torappu_RL06EndingText 丢: SummaryActor, SummaryTop, SummaryZone, SummaryEnding, SummaryDifficultyZone, SummaryDifficultyEnding
  clz_Torappu_CharSkinData 丢: DynIllustId, AvatarId, SpAvatarId, PortraitId, SpPortraitId, DynPortraitId
差异统计: 新增字段 0 / slot 位移 0 / 类型变化 0 / 新增表 0

=== slot 位移（真正的结构漂移）0 张表 ===

=== 仅类型 token 差异（int/enum 之外）0 张表 ===
未在 C# 中找到的类 (64): clz_Torappu_SimpleKVTable_clz_Torappu_BattleEquipPack, …
未识别类型明细 (2 种):
   System.Int16[,] × 1
   Torappu.IGlobalBuffSource × 1

[OK] 未检出 slot 位移（结构布局与现有 schema 一致）

real	0m36.529s   CHECK_EXIT=0
```

**结论：无 slot 位移、无字段/类型/新表差异（61 个 schema 文件全部「无差异」）。**
两个安全阀的计数（2 + 9 = 11 个类被冻结）与 `docs/fbs-schema-repair-2026-09-12.md:73-80` 完全对得上（见第八节）。
`未在 C# 中找到的类 (64)` 不是错误：其中包含 `SimpleKVTable<X>`、`KeyFrames<A,B>`、泛型实例合成名，以及 6 张 0 字段占位表——这些表由旧 vendored 约定或 `SYNTHETIC_TABLES` 提供，属于预期的「非 CS 派生表」。

#### 4.7.2 `schema:crosscheck`（对照 OpenArknightsFBS）— 退出码 **0**（未加 `--strict`）

```
$ time node_modules/.bin/tsx scripts/fbs-crosscheck.ts
比对 61 组 schema（FBS 2964 表 / 本地 2953 表）
表集合: FBS 独有 2（另有 11 张 list_ 向量包装表，本地内联为 vec:，非缺口） / 本地独有 4
表内字段: 本地缺字段 4 表；同槽位改名 41 表；本地多字段 19 表；序不一致 0 表；类型宽度不一致 7 表
悬空引用: 本地 0 处 / FBS 0 处
本地未解析类型 token(unknown): 5 处
slot 自洽性异常: 0 处；root 不一致: 0 处

=== FBS 有、本地缺失的表（引到时解码为 {}）===
  audio_data         clz_Torappu_Audio_MixerDesc (3 字段)
  battle_equip_table clz_Torappu_TalentData (9 字段)

=== 本地缺字段的表（FBS 有、本地解不出）===
  clz_Torappu_Audio_Middleware_Data_SoundFXBank   FBS 7 vs 本地 6；缺: mixerdesc
  clz_Torappu_BuffData                            FBS 39 vs 本地 38；缺: remainingtimekey
  clz_Torappu_SandboxBuildingItemData             FBS 3 vs 本地 2；缺: itemsubtype
  clz_Torappu_SandboxDevelopmentData              FBS 13 vs 本地 13；缺: buffid, bufflimitedid, canbuffresearch, buffresearchdesc, buffname

=== 类型宽度差异（前 10）===
  clz_Torappu_RuneData_Selector.playersidemask: FBS 8 vs 本地 32   (×5)
  clz_Torappu_LevelData_GlobalBuffData.playersidemask: FBS 8 vs 本地 32

real	0m30.275s   CROSSCHECK_EXIT=0
```

**结论：无 slot 位移（序不一致 0）、悬空引用两侧均 0、root 全等、slot 自洽。**
残余差异全部是「参考副本落后 / 已知登记项」：缺字段 4 表中 `SoundFXBank.mixerDesc` 是**主动登记**进 `NON_WIRE_FIELDS` 的（`cs2schema.ts:210`），`BuffData.remainingTimeKey` 是被冻结表（见 7.1）；FBS 独有 2 表（`Audio_MixerDesc`、`TalentData`）是本地按 CS 把字段内联/剔除后的结构差。宽差异 7 处全是 `playerSideMask`（FBS `ubyte`/8bit vs 本地 `enum`/32bit），与 `docs/fbs-crosscheck-2026-09-12.md` 的 P1-4 同源，**未修**。

#### 4.7.3 `schema:audit`（报文 vtable 真值）— 退出码 **0**，耗时 **14m11s**

```
$ time node_modules/.bin/tsx scripts/schema-audit.ts --json tmp/decompiled-analysis/schema-audit.json
快照: hot_update_list_26-09-09-08-18-15_d25676.json
解码 57 张（跳过 92），审计 1580 张表定义
字段数与报文 vtable 不一致的表: 67
  [本地多31] char_patch_table  clz_Torappu_AttributesDeltaData  wire=3  schema=34 记录=997
  [本地多19] char_patch_table  clz_Torappu_AttributesData       wire=15 schema=34 记录=4845
  [本地多6]  roguelike_topic_table clz_Torappu_RL01EndingText   wire=36 schema=42 记录=1
  [本地多6]  roguelike_topic_table clz_Torappu_RL03EndingText   wire=47 schema=53 记录=1
  [本地多3]  activity_table    clz_Torappu_Act24SideData_MeldingGachaBoxGoodData  wire=9 schema=12 …
  …（其余略，见日志/JSON）
已写出 tmp/decompiled-analysis/schema-audit.json
real	14m11.315s   AUDIT_EXIT=0
```

对落盘 JSON 做二次统计（`rows=1580`）：

```
不一致表 67 张；其中 wire>schema（本地缺字段）= 0 张；schema>wire（本地多字段）= 67 张
「多出字段中有命中」（= 可能夹在中间造成位移）的表 = 0 张
```

**结论：本地缺字段 0 张（报文里有的字段 schema 全都有）；67 张本地多字段的表，多出的字段在全部样本中
从未命中，全部为尾部残留，无中部插入 → 无 slot 位移风险。** 与 `docs/fbs-schema-repair-2026-09-12.md:56`
的「本地缺字段 0 张；不一致仅剩 68 张本地多字段且全部为尾部残留」一致，张数 68→67 的 1 张差异
**未验证**（推测与本次 bundle 样本覆盖 / 后续代码微调有关）。

---

### 4.8 与 `docs/fbs-schema-repair-2026-09-12.md` 的交叉验证

| 文档结论（2026-09-12） | 本次实测（2026-09-13） | 一致性 |
| --- | --- | --- |
| `schema:check` 无 slot 位移 | 0 张 slot 位移、61 文件全无差异 | ✅ 一致 |
| 仍冻结 **11 个类** = 会丢字段 9 + 类型无法映射 2（文档 `:73-80`） | `protectedLoss=9`（`SharedCharData`/`BuffData`/`LevelData.WaveData.FragmentData.ActionData`/`RL01,03,04,05,06EndingText`/`CharSkinData`）+ `protectedClasses=2`（`System.Int16[,]`、`Torappu.IGlobalBuffSource`） | ✅ **逐类逐字段完全一致** |
| crosscheck 修复后：FBS 独有 2、悬空引用 0、缺字段 4 表（`:57`） | FBS 独有 2、悬空 0、缺字段 4 表 | ✅ 一致 |
| audit 修复后：本地缺字段 0 张、68 张本地多字段全为尾部残留（`:56`） | 本地缺字段 **0** 张、**67** 张本地多字段且多出字段全部 neverHit（无中部插入） | ✅ 一致（68→67 的 1 张差异未验证，疑为样本覆盖） |

**是否仍有漂移 / 残余冻结表：**

- **slot 漂移：无**（三条独立口径全判 0：check 0 位移 / crosscheck 序不一致 0 / audit 无中部插入的多字段）。
- **残余冻结表（9 张，保护性冻结，非缺陷）**：
  `clz_Torappu_SharedCharData`、`clz_Torappu_BuffData`、`clz_Torappu_LevelData_WaveData_FragmentData_ActionData`、
  `clz_Torappu_RL01EndingText`、`clz_Torappu_RL03EndingText`、`clz_Torappu_RL04EndingText`、`clz_Torappu_RL05EndingText`、`clz_Torappu_RL06EndingText`、`clz_Torappu_CharSkinData`。
- **因类型无法映射而冻结（2 张）**：`System.Int16[,]`（二维数组）与 `Torappu.IGlobalBuffSource`（接口）所在表，保留旧表。
- **对参考的残余差异（不构成 slot 风险，但会让对应字段解不出值）**：
  `clz_Torappu_BuffData.remainingTimeKey`、`clz_Torappu_SandboxBuildingItemData.itemSubType`、
  `clz_Torappu_SandboxDevelopmentData.buffId/buffLimitedId/canBuffResearch/buffResearchDesc/buffName`、
  `clz_Torappu_Audio_Middleware_Data_SoundFXBank.mixerDesc`（已登记 NON_WIRE）、
  以及 FBS 独有表 `clz_Torappu_Audio_MixerDesc`、`clz_Torappu_TalentData`。
- RL0x EndingText 的冻结有**数据反证**支持（文档 `:77-78`）：CS 声明序 ≠ 线上序，按 CS 序解出的 `SummaryActor` 是错误值，所以冻结是保护而非债。本次 `schema:audit` 从报文侧给了**间接支持**：`RL01EndingText`（wire=36 / schema=42）与 `RL03EndingText`（wire=47 / schema=53）都是「本地多、且多出字段从未命中」，即报文里出现的字段 schema 全都覆盖到了，没有 `本地少` —— 冻结没有造成丢字段。但「按 CS 声明序会解错」这一具体论断需要对新旧 schema 做同一 bundle 复解码才能直接证实，**本次未做，标记未验证**。

---

### 4.9 风险清单：链路里的「静默失败」倾向

| # | 静默失败点 | 代码位置 | 症状 | 检测手段 |
| --- | --- | --- | --- | --- |
| R1 | **硬编码版本号**（历史缺陷） | 已修复：唯一入口 `lib/cs-source.ts:38-54`；调用方 `cs2schema.ts:30-34`、`generate-types.ts:26-28`、`excel-convert.ts:259` | 客户端改名后 `existsSync` 守卫永不命中 → 类型生成被跳过、CS 枚举补充被禁用，**不报错** | grep 全仓 `com.hypergryph.arknights_.*\.cs` 字面量；`resolveCsFile` 单点审计。`cs-source.ts:7-10` 记录了案发经过 |
| R2 | **字典序排序的版本比较** | `cs-source.ts:31-32, 48-53` | `2.10.x` 排在 `2.9.x` 前 → 探测到旧源 | 目录里同时存在多版本时人工确认；跨大版本时用 `--cs` 显式指定。当前 `reference/` 只有 1 个候选，未触发 |
| R3 | **`generate-types` 增量 mtime 判据** | `generate-types.ts:86-104` | checkout/复制导致 mtime 倒挂 → 该生成时不生成（或反向白跑），**无内容指纹** | 对比产物 mtime 与 CS/adapt mtime；加 `--force` 强制重生成；产物头部有源文件名可核对 |
| R4 | **两处安全阀只统计不失败** | `cs2schema.ts:672-677`（protectedClasses）、`:691-708`（protectedLoss） | 表被永久冻结在旧结构上，`--check` 仍退出 0（因为 slot 位移统计不含被跳过表） | 关注 `schema:check` 输出的 `因…保留旧字段表的类: N`；N 变化即为新冻结；用 `schema:audit` 报文真值复核 |
| R5 | **`--check` 退出码只认 slot 位移** | `cs2schema.ts:879-895` | 纯类型 token 差异 / 大面积冻结不会让门禁失败 | 需人工读 `类型变化` 与冻结计数；CI 可加 `--diff N` |
| R6 | **`isUpToDate` 指纹判据** | `excel-convert.ts:318-333`（`META_KEY:223`、`CONVERTER_VERSION:227`、`buildMeta:254`、`writeMeta:283`、`readSidecarMeta:292`） | 元数据缺失/转换器改语义未升版本 → 旧产物被判「已最新」，**静默沿用错误数据** | `CONVERTER_VERSION` 递增即全量失效（`:238-244` 记录了「改规则后首跑仍跳过 63 张表」的实战）；`verifyTableFreshness`（`app/game/excel/data-version.ts:166-229`）看 `convertedAt` 极差与 `sourceMtime` 极差是否同批 |
| R7 | **`writeMeta` 旁挂 sidecar 可能丢** | `excel-convert.ts:283-285`、`:292-301` | sidecar 被删/未写 → `isUpToDate` 返回 false 强制重转（**偏安全**），但 `verifyTableFreshness` 无元数据时 `ok:true`（`:201-210`）→ 新鲜度**不可判定却报成功** | 看 message；无 `withMeta` 的表说明没走新管线 |
| R8 | **`schema:audit` 静默 SKIP** | `schema-audit.ts:90-100`（无 name 缓存/无热更清单直接 `[SKIP]` 返回） | 依赖 `reference/hotupdate/`（gitignored），缺失时门禁看起来「跑过」其实什么都没查 | 检查输出是否出现 `[SKIP]`；本次实测有快照与 164 个 bundle，未 SKIP |
| R9 | **反编译工作流幂等判据是存在性** | `decompile-client.sh:128`（`Done.` 日志 + dll 存在）、`:142`（`csharp-src.sln` 存在） | 客户端更新后若目录未换名/残留旧标记 → 跳过分析，用旧源码生成新签名 | 每次升级核对 `GAME_VERSION` 与 `SIG_FILE` 名；必要时删 `tmp/decompile/cpp2il_out` 与目标 `arknights-*-csharp` |
| R10 | **`generate-types` 对 CS 私有字段的取舍与 cs2schema 不同** | `playerdata-parser.ts:215-220`（只收 public）vs `cs2schema.ts:94-97`（收 backing field/`m_*`） | TS 类型少字段（读不到）但**不报错**；两套解析器口径漂移 | 交叉比对同表在 `types_excel_gen.ts` 的字段数与 schema 字段数 |

---

### 4.10 客户端版本更新后的正确操作顺序

```bash
# 0) 前置：确认 Node（仓库要求 24；本沙箱实测 22.22.1，未验证是否影响脚本）
node -v

# 1) 反编译 + 自动生成签名 + 末尾自带 schema:check 安全阀（约 20-40 min，幂等）
pnpm run decompile                 # = bash scripts/decompile-client.sh
                                   # 产出 reference/arknights-<新版本>-csharp/ 与 com.hypergryph.arknights_<新版本>.cs
                                   # 注意：末尾的 schema:check 只告警不中断（decompile-client.sh:172-184）

# 2) 显式复跑漂移门禁，确认是否有 slot 位移（这一步才是硬门禁）
pnpm run schema:check              # 退出码 0 = 无 slot 位移；非 0 = 存在位移
#   pnpm run schema:diff           # 需要明细时：--check --diff 20

# 3) 有位移才重写 schema（会直接改 scripts/vendor/fbs-schemas/*.json）
pnpm run schema:write
pnpm run schema:check              # 复核：应回到 0

# 4) 交叉校验两条口径
pnpm run schema:crosscheck         # 参考口径（含 --strict 可在硬漂移时非 0）
pnpm run schema:audit              # 报文真值口径（唯一不依赖外部参考；最慢）

# 5) 再生成 TS 类型（schema 改动不会自动触发类型重生成）
pnpm run generate:types            # 或 --excel / --playerdata 分域；必要时 --force

# 6) 重跑数据管线让 data/excel/*.json 与 meta.json 指纹一起刷新
pnpm run update                    # 全量：热更下载/解码/转换 + 类型 + 版本同步
#   之后 verifyTableFreshness 会自动校验「各表是否同批刷新」（update-data.ts:241-243）

# 7) 回归守卫
pnpm exec vitest run tests/unit/scripts/fbs-schema-invariants.test.ts tests/unit/vendor/fbo.test.ts
pnpm run typecheck:scripts
```

**最容易踩的坑（按危害排序）：**

1. **把 `decompile` 末尾的 schema:check 当门禁**：它只告警不中断（`decompile-client.sh:180-183`），漂移会照常产出新签名与旧 schema。必须**显式** `pnpm run schema:check` 并按退出码判定。
2. **只跑 `schema:write` 不跑 `schema:check`**：`--write` 不走 slot 位移退出码契约（`cs2schema.ts:883` 明确 `--check && !--write` 才判定），写坏了也不报。
3. **改完 schema 忘了重生成 TS 类型**：两者是独立步骤，`generate:types` 还要过 mtime 增量闸（`generate-types.ts:86-104`），schema 变新**不会**让类型产物 mtime 变新——判据里只看 CS/adapt/data-excel，不看 `fbs-schemas/`。若只改 schema，必须 `--force`。
4. **改完 schema 忘了 `pnpm run update`**：`isUpToDate` 用 `schemaMtime` 指纹（`excel-convert.ts:257-258, 329`），schema 一变指纹即失效、会自动重转；但如果 meta sidecar 缺失或 `CONVERTER_VERSION` 没升，可能静默沿用旧产物——关注 `verifyTableFreshness` 输出。
5. **手动登记遗漏导致 slot 位移**：`NON_WIRE_FIELDS`/`NON_WIRE_TYPES` 只登记了实测不在报文里的字段（`cs2schema.ts:195-211`）。新版本若把某运行时字段「变成线上字段」或反之，漏登记会让其后 slot 全体位移——这正是 `schema:check` 要拦的形态，所以**版本更新后不要跳过 `schema:check`**。
6. **`resolveCsFile` 字典序**：新旧版本目录并存时（如 2.9 与 2.10），可能取到旧签名。用 `GENERATE_CS`/`--cs` 显式指定最稳。
7. **`schema:audit` 成本高且会 SKIP**：本次实测耗时 **14m11s**（`FBO.observer` 逐记录×逐字段统计命中，O(记录×字段)）；若 `reference/hotupdate/` 缺失会 `[SKIP]` 返回（`schema-audit.ts:90-100`），别把「无输出 / 只有一行快照」当成通过。

---

### 4.11 附：本报告用到的实测命令与产物

| 命令（底层等价形式） | 退出码 | 日志 |
| --- | --- | --- |
| `node_modules/.bin/tsx scripts/cs2schema.ts --check` | 0 | `tmp/decompiled-analysis/gate-check.log` |
| `node_modules/.bin/tsx scripts/fbs-crosscheck.ts` | 0 | `tmp/decompiled-analysis/gate-crosscheck.log` |
| `node_modules/.bin/tsx scripts/schema-audit.ts --json tmp/decompiled-analysis/schema-audit.json` | 0（14m11s） | `tmp/decompiled-analysis/gate-audit.log` + `schema-audit.json`（1580 行） |
| `pnpm run …`（原样包装） | — | 环境失败：`/root/.local/share/pnpm` 只读；设 XDG 后挂起 |

未修改 `app/` 与 `reference/` 下任何文件；本报告与全部中间产物均在 `tmp/decompiled-analysis/` 下。

## 4b. 数据面一致性独立核对（主分析者实测）

| 项 | 数值 | 证据 |
|---|---|---|
| `data/excel/*.json` 表数 | **63** | `ls data/excel/*.json \| grep -v '\.meta\.json$' \| wc -l` |
| 溯源 meta 数 | **63** | `ls data/excel/*.meta.json \| wc -l` |
| 配对结果 | **双向零缺口** | `comm` 比对（json 无 meta：无；meta 无 json：无） |
| `scripts/vendor/fbs-schemas/*.json` 表数 | **61** | `ls scripts/vendor/fbs-schemas/*.json \| wc -l` |
| excel meta 的 CS 溯源 | `"csSource":"com.hypergryph.arknights_2.7.71.cs"` | `data/excel/character_table.json.meta.json` |

结论：当前 excel 数据是**对着 2.7.71 签名源生成的**（meta 的 `csSource` 指向当前版本，非陈旧版本），且 63 张表全部带溯源指纹、无孤儿文件。注意 `fbs-schemas` 61 张 < excel 63 张：差额来自 AES-CBC 加密的非 FBS 表（`range`/`player_avatar`/`roguelike`/`sandbox`/`uniequip_data`/`handbook`/`tech_buff` 等，直接用 `MASK_V2` 解密 JSON，不需要 schema 描述）。

> 计数陷阱备忘：`ls data/excel/*.json | grep -v meta` 会漏掉名字里含 "meta" 的真实表（`char_meta_table`、`meta_ui_table`、`display_meta_table`、`story_review_meta_table`、`hotupdate_meta_table` 共 5 张），得到错误的 58。正确做法是过滤 `\.meta\.json$` 后缀（或按上面 `comm` 配对）。

### 4b.1 状态类字段级保真度抽验（`PlayerDataModel`）

对 `Assembly-CSharp/Torappu/PlayerDataModel.cs`（495 行）与生成的 `app/game/excel/types-playerdata.ts:5759` 的 `PlayerDataModel` 接口做字段级比对：

- CS 侧一级字段 **54** 个，TS 侧 **66** 个成员（含 3 个由 CS `const` 转来的常量字段与若干字典字段）。
- **命名规则实测**：TS 字段名取**报文的 JSON 线名**，不是 C# 字段名——当 CS 带 `[JsonProperty]` 时以它为准。实证（`PlayerDataModel.cs`）：
  - `[JsonProperty(PropertyName = "avatar")] public PlayerAvatar PlayerAvatar;`（:81-82）→ TS `avatar: PlayerAvatar`
  - `[JsonProperty("campaignsV2")] public PlayerCampaign campaign;`（:170-171）→ TS `campaignsV2: PlayerCampaignV2`
  - `[JsonProperty("homeTheme")] public PlayerHomeTheme playerHomeTheme;`（:225-226）、`[JsonProperty("setting")] public PlayerSetting playerSetting;`（:235-236）、`[JsonProperty("aprilFool")] public PlayerAprilFool playerAprilFool;`（:240-241）
  - 两种写法都存在：`[JsonProperty(PropertyName = "x")]` 与 `[JsonProperty("x")]`。
- 结论：类型链路在**字段名与字段序**两个维度上对 CS 源是保真的；服务端若要判断「某字段的线上名」，**不能看 C# 字段名，必须看 `JsonProperty`**。

> **脚本陷阱（本次实测踩到）**：反编译 .cs 是 **CRLF** 行尾。用 `grep -E '...;$'` 这类行尾锚定会全部失配（`\r` 挡在 `;` 与行尾之间），必须先 `tr -d '\r'`；另外 C# 泛型类型里含空格（`Dictionary<string, X>`），用 `public [A-Za-z0-9_.<>,]+ name;` 之类的正则会把这类字段整条漏掉。

---

## 5. 战斗系统

> 本文基于 **2.7.71** 反编译客户端 + 本私服 `app/` 现状的只读比对。
> 路径约定：`CS/` = `reference/arknights-2.7.71-csharp/Assembly-CSharp/`（含方法体的反编译源）；
> `SIG:` = `reference/com.hypergryph.arknights_2.7.71.cs`（签名大文件，104 万行）；
> 服务端路径均相对仓库根。
> 证据等级标注：**【已读】** = 本次实际打开源码/签名逐行核对；**【推测】** = 由字段名、调用点或注释推断，未获运行时/抓包验证。
> 反编译产物的方法体大量是 IL2CPP + XLua 热更桩（`DelegateBridge.__Gen_Delegate_ImpNNN` / `throw AnalysisFailedException`），
> 因此**实现细节一律不可从 C# 断言**，行号证据只到「字段声明 / 调用点」粒度。
> 抓包库现状（`tmp/capture/index.db`，2024 条记录）：`source` 全部为 `private`（打私服的自动探测），
> 唯一一条 `/quest/battleStart` 是**空体探测**（`tmp/capture/records/R-1789134620908-0368/req.json` = `{}`，响应 422）。
> **本仓没有真实官方客户端样本可供交叉验证**——本文凡涉及「真实客户端会发什么」的结论，均为静态推断并已显式标注。

---

### 5.1 战斗域代码结构

#### 5.1.1 核心类与职责（客户端）

| 类 | 声明位置 | 职责 | 关键成员（文件:行） |
|---|---|---|---|
| `BattleController` | `CS/Torappu.Battle/BattleController.cs:41` | 战斗总控（单例宿主）：持模块、卡组、费用、日志、GameMode、状态机 | `m_modules:853`、`m_eventPool:857`、`m_deckDict:897`、`m_logger:917`、`m_costManager:943`、`m_gameMode:995`、`m_state:1071`、`m_result:1075`；`LoadGame:5051`、`StartGame:5081`、`FinishGame:5149`、`_DoFinishGame:5186`、`GiveUpGame:5272`、`_RegisterModules:10447`、`_ParseBattleRank:9750` 【已读】 |
| `Entity` | `CS/Torappu.Battle/Entity.cs:20` | 战场一切对象基类（含 HP/属性/buff 挂点/状态机） | `m_stateMachine:1639`、`m_hp:1643`、`m_es:1647`、`m_sp:1651`、`AddBuff:6228`/`:6240` 【已读】 |
| `Unit` | `CS/Torappu.Battle/Unit.cs:22` | 可受击/可施放单位基类（Character 与 Enemy 的共同父类） | `_commonAbilities:414`、`m_currentMode:470`、`FetchHost:2304`、`SwitchMode:2431`、`EnableShadow:2479` 【已读】 |
| `Character` | `CS/Torappu.Battle/Character.cs:27` | 干员 / 召唤物：部署、技能、卡牌费用 | `cost:1595`、`deckBuffs:1603`、`_traitAbility:1688`、`CheckBuildable:5125`、`LocateOnTile:5205`、`SwitchToSkillState:4987`、`OpTrigSkill:4864` 【已读】 |
| `Enemy` | `CS/Torappu.Battle/Enemy.cs:27` | 敌人：AI 状态机（Born/Move/Attack）与计数口径 | `EnemyStateMachine:359`、`BornState:463`、`MoveState:534`、`AttackState:583`、`isSummon:54`、`alwaysCountAsKilled:38`、`noLogInEnemyStatsWhenFinished:70` 【已读】 |
| `Ability` | `CS/Torappu.Battle/Ability.cs:14` | 技能/能力基类（`Entity.FriendComponent` 子类） | `struct Options:20`、`struct Metadata:45`、`enum FamilyGroup:57`、`enum Category:99`、`SetData:1158`、`DoSetData:1180`、`Attach:1296`、`Detach:1315`、`DoFinish:1438` 【已读】 |
| `Buff` | `CS/Torappu.Battle/Buff.cs:15` | Buff 实例：属性修饰 + 异常抗性 + 护盾源；栈管理 | `m_stackCnt:10341`、`m_isFinished:10413`、`_DoUpdateStack:15421`、`_AddStack:15449`、`_ExtendRemainingTime:15521` 【已读】 |
| `Buff.BuffContainer` | `CS/Torappu.Battle/Buff.cs:473` | Buff 容器与覆盖组（OverrideGroup）生命周期 | `NewBuff:1117`、`CreateBuff:1087`、`RemoveBuff:1308`；`OverrideGroup:126`（`Add:180`、`_DoAddInternal:302`）【已读】 |
| `Deck` | `CS/Torappu.Battle/Deck.cs:19` | 卡组/手牌/费用桥：抽卡、入离手、原始费用覆盖、卡组光环 | `Card:94`、`m_cardMap:6621`、`m_cards:6629`、`FindCard:7965`、`OnCardDrawn:8297`、`OnCardCostChanged:8224`、`TryGetOverrideRawCostData:8561`、`AddDeckAura:8432` 【已读】 |
| `Scheduler` | `CS/Torappu.Battle/Scheduler.cs:22` | 波次时间轴调度（`IBattleModule`），驱动 Fragment/Branch 与延迟动作 | `IWavePlugin:25`、`SchedulerSnapshot:45`、`Init:4965`、`UpdateWaves:5006`、`OnGameStart:5061`、`OnGameOver:5113`、`_DoSchedule:5516`、`DoFinishGame:5531` 【已读】 |
| `BattleCostManager` | `CS/Torappu.Battle/BattleCostManager.cs:9` | 费用回复定时器与修正器 | `m_costStatusDict:21`、`m_costTimerDict:25`、`costTimerPeriodTime:151`、`GetCostStatus:214` 【已读】 |
| `CostStatus` | `CS/Torappu.Battle/CostStatus.cs:7` | 单侧费用状态（`ObscuredInt` 内存混淆） | `cost:11`、`minCost:15`、`maxCost:19` 【已读】 |
| `BattleLogger` / `BattleStats` | `CS/Torappu.Battle/BattleLogger.cs:17` / `:318` | 战斗统计采集与快照（battleFinish 上报载荷来源） | `AchieveStats(BattleController):1722`、`TakeSnapShot:749`；`checkKilledCnt:619`、`charStats:543`、`enemyStats:547`、`clientAntiCheatLog:651`、`CharAdvancedStats:391` 【已读】 |

组合关系（自上而下）：`BattleController` 持有 `List<IBattleModule>`（`m_modules:853`，含 `Scheduler`/`SchedulerDriver`）
与 `ListDict<PlayerSide, Deck>`（`m_deckDict:897`）、`BattleLogger`（`:917`）、`BattleCostManager`（`:943`）、`IGameMode`（`:995`）；
`Deck` 产出 `Character`（部署）；`Character`/`Enemy` 都是 `Unit → Entity`，各自挂 `Ability` 与 `Buff`（经 `Entity.AddBuff:6228` 落入 `BuffContainer:473`）；
`Scheduler` 负责敌波与关卡脚本推进。**未找到** `CharacterBase`、`AbilitySpec`、`EBattleState`、`BattlePhase`、`EVolveCostType`（精确 glob/ls 均无；Ability 的「规格」实际是 `Ability.Options`/`Metadata` 结构体）。

#### 5.1.2 战斗生命周期（loading → start → running → finish）

客户端状态机只有一个枚举，**没有独立的 Loading/Phase 枚举**：

- `BattleController.State`：`NONE:47` / `INITED_BUT_NOT_START:49` / `PLAYING:51` / `FINISHED:53`（`CS/Torappu.Battle/BattleController.cs:44`）
- `BattleController.GameResult`：`NOT_YET:60` / `WIN:62` / `LOSE:64`（`:57`）

| 阶段 | 客户端证据 | 服务端证据（本私服） |
|---|---|---|
| loading（初始化） | `Awake:11257` → `_RegisterModules:10447`（注册 `SchedulerDriver`）→ `OnInit:11421` → `LoadGame:5051` | `battleStart` 前：无（服务端不参与加载） |
| start（开局） | `StartGame:5081`：`m_state → PLAYING`（setter `:3974` → `_SwitchState:10433`，`eventPool.Emit(16)`） | `BattleManager.start`（`app/game/modules/battle/battle.ts:297-484`）：生成 `battleId`（`:301`）、登记会话 `_sessions.set`（`:303`）、扣理智/演习券（`:433-441`）、写 `battleInfo`（`:463-475`），返回 `battleId`（`:475-481`） |
| running | `FixedUpdate:11286` 在 `isPlaying && !isPaused` 时装配 `m_tick = OnTick`（`:11293-11297`）；`_UpdateGameInfo:10467` 累计 `m_timeDeltaNoEnemy:10472-10475` | 无（战斗全部客户端演算，服务端只在两端介入） |
| finish | `FinishGame:5149` → `_DoFinishGame:5186`（`m_result` 初值 `NOT_YET:5204`）；投降 `GiveUpGame:5272`（`:5278` 直接 `FINISHED`）；`Scheduler.DoFinishGame:5531` 收尾 | `BattleManager.finish`（`battle.ts:553-752`）：解密（`:561`）→ 取 `battleInfo`（`:562-570`）→ 幂等拒绝（`:585-590`）→ 星级系数（`:626-632`）→ 发 EXP/GOLD（`:637-660`）→ `_settleStageState`（`:661-675`）→ 标记会话 `finished`（`:679-682`）→ 记录留存（`:687-710`）→ 任务事件（`:712-726`） |

#### 5.1.3 胜负判定与星级（completeState）

- 胜负**不在 BattleController 内判定**：接口 `CS/Torappu.Battle.GameMode/IGameMode.cs:12`（`OnGameOver:203`、`FinishGame:423`、`GetBattleCompleteRank:471`），
  默认实现 `DefaultGameMode`（`CS/Torappu.Battle.GameMode/GameModeFactory.cs:25013`）：`FinishGame:26422`、**失败点 `OnPlayerLifeToZero:26556` → `FinishGame(GameResult.LOSE,…)` `:26564`**（生命点归零）【已读】。
- 客户端侧星级类型是 `Torappu.PlayerBattleRank` = **FAIL / PASS / COMPLETE 三档**（`SIG:949202-949208` 附近，供 `completeState` 字段使用；`SIG:86378`、`SIG:104039`），
  运行时经 `BattleController.battleRank` getter（`:4234`）→ `_ParseBattleRank:9750`（方法体未恢复，**三星具体条件在 CS 不可见**）。
- 本仓映射：`app/game/kernel/util/stage-unlock.ts:20-24`（`FAIL:1 / PASS:2 / COMPLETE:3`）。
  **服务端出现的 `completeState === 4`（`battle.ts:875`、首通判定 `:819-822`）在 2.7.71 CS 中找不到枚举依据**【已读 + 未找到】——见差异 P2-14。

---

### 5.2 客户端-服务端交互面

#### 5.2.1 battle 相关端点总览

客户端 URL 常量集中在 `CS/Torappu.Network/ServiceCode.cs`（`/quest/battleStart:104`、`/quest/battleFinish:107`、`SAVE_BATTLE_REPLAY:110`、`LOAD_BATTLE_REPLAY:113`、
CAMP `:140/143/146`、RUNE `:158/161`、charBuild addon `:410/413`、CRISIS `:572/575`、CRISIS_V2 `:617/620`、recalRune `:626/629`、trainingGround `:842/845`、
rlv2 `:914/917/938`、tower `:983/986`、vecBreakV2 `:1010-1019`、arcade `:1031/1034`、football `:1061/1064`）【已读】。

服务端 battle 端点分布于（`grep "router.post(\"*[Bb]attle*\""` 全量枚举，85+ 条）：`quest`（`app/game/modules/quest/routes.ts:112/120/132/144/154`）、
`character`（addonStage，`app/game/modules/character/routes.ts:297/305`）、`crisis`（V1/V2/recalRune，`app/game/modules/crisis/routes.ts:744/1119/1402` 等）、
`tower`、`rune`、`campaignV2`（含 `battleSweep`）、`sandbox`（v2/v3/racing）、`rlv2`（`app/game/modules/roguelike/handler.ts`）、`autochess`、`multiplayer`、`vecbreak`、
`bossRush`、`enemyDuel`、`football`、`arcade`、`act24side/act25side/act1vhalfidle`、`aprilFool`（act3~7fun）、`arkodc`、`trainingGround`、`misc-alignment`（recalRune 别名）。

#### 5.2.2 协议类与字段清单（**官方类名不是 `BattleStartRequest`**）

`BattleStartRequest` / `BattleFinishRequest` / `QuestBattleStartResponse` / `QuestBattleFinishResponse` / `BattleContinueRequest` **在 2.7.71 CS 中都不存在**（逐名 find + SIG grep 均未命中）。
真实继承链：

```
CommonStartBattleRequest (abstract)  CS/Torappu/CommonStartBattleRequest.cs:7
  ├─ DefaultStartBattleRequest       CS/Torappu/DefaultStartBattleRequest.cs:6     ← /quest/battleStart
  ├─ CampaignStartBattleRequest      CS/Torappu/CampaignStartBattleRequest.cs:6   （无新增字段）
  ├─ RuneStartBattleRequest          CS/Torappu/RuneStartBattleRequest.cs:7       （rune / isPractice）
  └─ CrisisStartBattleBaseRequest    CS/Torappu/CrisisStartBattleBaseRequest.cs:6 （**不继承 Common**，独立）
PlayerDeltaResponse (abstract)       CS/Torappu/PlayerDeltaResponse.cs:8
  ├─ CommonStartBattleResponse :6 → DefaultStartBattleResponse :6
  └─ CommonFinishBattleResponse:10 → DefaultFinishBattleResponse:8 / DefaultMultiplyBattleResponse:8
CommonFinishBattleRequest (abstract) CS/Torappu/CommonFinishBattleRequest.cs:12
  └─ DefaultFinishBattleRequest:6、CampaignFinishBattleRequest:6（均无新增字段）
```

**基类字段（所有响应的 wire 前缀）** `CS/Torappu/PlayerDeltaResponse.cs:8`：
`playerDataDelta`（`:13`，`[JsonProperty("playerDataDelta")]`，类型 `PlayerDataDelta`，SIG 中为 struct）、`pushMessage`（`:18`，`List<PlayerPushMessage>`）【已读】。
> 服务端 `res.send(player.delta)` 只产出 `playerDataDelta`（`app/game/kernel/PlayerStatus.ts:62-76`），不带 `pushMessage`；个别端点手工补 `pushMessage`（如 `character/routes.ts:292-294` 勋章推送）。

##### `CommonStartBattleRequest`（battleStart 请求基类）【已读】

| 行 | 字段 | CS 类型 | 语义 |
|---|---|---|---|
| `:47` | `usePracticeTicket` | **bool** | 演习（用演习券开战） |
| `:51` | `stageId` | string | 关卡 id |
| `:55` | `squad` | `SquadModel` | 编队快照（`SquadModel:10`：`squadId:14`、`name:18`、`slots:22`） |
| `:59` | `assistFriend` | `SquadFriendData` | 助战好友（`CS/Torappu/SquadFriendData.cs:9`，继承 `FriendCommonData.cs:10`：`uid:18`、`nickName:14`、`level:30`…） |
| `:63` | `isReplay` | **bool** | 代理指挥/回放开战 |
| `:67` | `startTs` | long | 开局时间戳（★防重放/防加速，**推测**） |
| — | （无 battleId） | — | 请求侧确无 battleId（源码 + `SIG:60686-60691` 双证） |

`RequestSquadSlot`（`CS/Torappu/RequestSquadSlot.cs:8`）：`charInstId:30`、`S_skillIndex:35`、`S_currentTmpl:40`、`S_tmpl:45`、`S_currentEquip:50`；
其中 `S_*` 通过 **`[JsonProperty("skillIndex"/"currentTmpl"/"tmpl"/"currentEquip")]`** 改名（`:34/:39/:44/:49`），`Patch:11`（`skillIndex:15`、`currentEquip:19`）【已读】——**说明该客户端确实用 Newtonsoft 属性重命名，而 `DefaultStartBattleRequest` 上没有这类属性**（见差异 P0-1）。

##### `DefaultStartBattleRequest`（/quest/battleStart 实际发送类）【已读】

| 行 | 字段 | CS 类型 |
|---|---|---|
| `:21` | `isRetro` | **bool** |
| `:25` | **`pry`** | int |
| `:29` | `battleType` | `BattleType`（`enum:9`：`Common=0:13`、`Continuous=1:16`、`MULTIPLE=2:19`） |
| `:33` | **`multiple`** | `MultipleBattleModel`（`CommonStartBattleRequest.cs:32`：`battleTimes:36`） |
| `:37` | `extra` | `StartBattleExtraData`（`StartBattleExtraData.cs:6` → `sixStar:10` → `StartBattleExtraInfoSixStarData.cs:7` → `tags:11`） |

发送点：`CS/Torappu/BattleStartController.cs:1079`
`_DoSendStartBattleService<DefaultStartBattleRequest, DefaultStartBattleResponse>("/quest/battleStart", request);`（campaign 分支同文件 `:1085-1088` 发 `/campaignV2/battleStart`）【已读】。

##### 响应类字段【已读】

| 类 | 字段（行） |
|---|---|
| `CommonStartBattleResponse`（`CS/Torappu/CommonStartBattleResponse.cs:6`） | `result:10`、**`battleId:14`（声明处默认 `"1"`）**；抽象 `GetIsApProtect:33`/`GetApFailReturn:37`/`GetNotifyPowerScoreNotEnoughIfFailed:41`/`GetInApProtectPeriod:45` |
| `DefaultStartBattleResponse`（`:6`） | `isApProtect:10`(**bool**)、`apFailReturn:14`(int)、`notifyPowerScoreNotEnoughIfFailed:18`(**bool**)、`inApProtectPeriod:22`(**bool**) |
| `CommonFinishBattleResponse`（`:10`） | `result:76`、`apFailReturn:80`、`itemReturn:84`、`rewards:88`、`unusualRewards:92`、`overrideRewards:96`、`additionalRewards:100`、`diamondMaterialRewards:104`、`furnitureRewards:108`；`RewardModel:13`（`id:17`、`type:22`、`count:26`、`charGet:30`） |
| `DefaultFinishBattleResponse`（`:8`） | `goldScale:12`(float)、`expScale:16`(float)、`firstRewards:20`、`unlockStages:24`、`pryResult:28`、`alert:32`、`suggestFriend:36`、`extra:40`（`FinishBattleResponseExtraData.cs:6` → `sixStar:10` → `FinishBattleRespExtraSixStarData.cs:6`：`groupId:10`、`before:14`、`after:18`） |
| `DefaultMultiplyBattleResponse`（`:8`） | **`battleId:12`** —— 连战模式下 finish 响应回**下一场**的 battleId（客户端缓存 `CS/Torappu.UI/BattleInfoCache.cs:36/40/222`） |

##### `CommonFinishBattleRequest`（battleFinish 请求）【已读】

| 行 | 字段 | 类型 | 语义 |
|---|---|---|---|
| `:143` | `data` | string | **加密后的战报串** |
| `:147` | `battleData` | `BattleDataInRequest` | 明文伴随：`BattleDataInternal:15` → `isCheat:19`、`completeTime:23`；`BattleDataInRequest:33` → `stats:37`（**wire 是 `Dictionary<string,string>`**） |

`DefaultFinishBattleRequest`（`:6`）与 `CampaignFinishBattleRequest`（`:6`）**无新增字段** → quest 主链路 request body = `{data, battleData:{isCheat, completeTime, stats}}`。
**请求里没有独立 battleId**：battleId 从 `data` 解密后的 JSON 内取出（服务端 `battle.ts:571` `battleData.battleId`；解密实现 `app/core/utils/crypt.ts:23-35`）【已读】。

##### 回放协议【已读】

| 类 | 位置 | 字段 |
|---|---|---|
| `SaveBattleReplayRequest` | `CS/Torappu/SaveBattleReplayRequest.cs:6` | `battleId:10`、`battleReplay:14` |
| `SaveBattleReplayResponse` | `CS/Torappu/SaveBattleReplayResponse.cs:6` | `result:10` |
| `LoadBattleReplayRequest` | `CS/Torappu/LoadBattleReplayRequest.cs:6` | `stageId:10`（**按 stageId 取，不按 battleId**） |
| `LoadBattleReplayReponse` | `CS/Torappu/LoadBattleReplayReponse.cs:6`（官方原始拼写 `Reponse`） | `battleReplay:10` |

无 `BattleReplay` 类；`battleReplay` 的 wire 形态是 **base64(ZIP)，内含 `default_entry` 的 JSON**（服务端反向实现 `app/core/utils/crypt.ts:98-104`）【已读】。

#### 5.2.3 时序

- **battleStart**：客户端在 `BattleStartController.StartBattle` 内先 `_SendStartBattleService()`（`CS/Torappu/BattleStartController.cs:805`）→ `:1079` POST `/quest/battleStart`；
  成功后才 `GameFlowController.StartScene("battle_loader", …)`（`:672`）。即 **HTTP 开战在进入战斗场景之前**；失败走 `_OnStartBattleFail:1144`。快速战斗分支直接 `StartScene("battle_finish")`（`:525`）。
  服务端对应：`quest/routes.ts:112-119` → `BattleManager.start`。
- **battleFinish**：战斗结束 → `UIBattleAccomplishedState._SwitchToBattleFinishService`（`CS/Torappu.Battle.UI/UIBattleAccomplishedState.cs:304-313`）
  → `UIController.SwitchToBattleFinishService`（`CS/Torappu.Battle.UI/UIController.cs:3781-3793`，`:3787` 切到 `UIStateEnum.BATTLE_FINISH_SERVICE:29`）
  → `UIBattleFinishServiceState.OnEnter:311-340`（`:332` `StartCoroutine(_SendBattleService(false))`）
  → 组报文 `_ParseCommonFinishBattleRequest:636-701`（`:665` `BattleData`、`:667` `completeTime`、`:669` `stats`、`:670` `isCheat`、`:677-681` `BattleDataInRequest`）
  → `:120` POST `/quest/battleFinish`。**即「结算界面进场瞬间」上报，而不是战斗结束时**。
  失败重试最多 `MAX_RETRY_COUNT = 3`（`:150`、`:388`、`:584-602`）；成功 `RevFinishBattleResult:750`；连战续战 `_OnContinueBattleServiceSuc:451`（**没有独立的 Continue 请求类**）。
  服务端对应：`quest/routes.ts:120-130` → `BattleManager.finish`。
- **回放上传**：`CS/Torappu.UI/BattleFinishSceneManager.cs:430`、`:1191`、`:1219`、`:1228`（`_DealWithBattleLogSave`、`_SendSaveBattleLogService:1325`），
  压缩工具 `CS/Torappu.UI/AutoBattleConvertUtil.cs:421 CompressString`、`:447 TryDecompressString`、`:476 CompressBattleLog`、`:496 TryDecompressBattleLog`（**压缩算法 IL 未恢复**）。

#### 5.2.4 battleId / replay / 校验字段

- **battleId 只出现在开的响应与「连战」的结算响应里**（`CommonStartBattleResponse.cs:14`、`DefaultMultiplyBattleResponse.cs:12`），请求侧没有任何 battleId 字段 —— 因此服务端在 `battleStart` 生成 `battleId` 并写快照、在 `battleFinish` 用解密出的 battleId 回查，是与客户端契约一致的【已读】。
- **`isCheat` 就是 battleId 的混淆形式**：`app/core/utils/crypt.ts:68-74` `base64(每字节+7)`，逆运算 `:84-88`。
  服务端**既没有落库也没有校验**：`app/game/kernel/battle-info-store.ts:96-97` 声明了 `BattleRecord.isCheat`，但 `battle.ts:687-710` 构造记录时从未赋值（`grep isCheat app/game/modules/battle/battle.ts` 仅命中类型签名 `:555` 与 JSDoc `:544`），`crypt.ts:84 decryptIsCheat` 全仓无调用点 —— 见差异 P2-16【已读】。
- **`data` 的构造（客户端实现不在 C# 层）**：`UIBattleFinishServiceState._AchieveBattleLog:729-746` 方法体即 hotfix 桩（`:745` 转发 `__Gen_Delegate_Imp77`）；
  全树 grep `LOG_TOKEN_KEY` / `pM6Umv` / `EncryptBattleData` / `AesEncrypt` **0 命中**。C# 层仅有的加密实现是同文件族之外的本地日志/库混淆（`CS/Torappu/FormatUtil.cs:1576-1652`、`CS/Torappu.DB/CrypticConverter_A.cs:42-109`），与战报无关。
  同版本可信实现是本仓反向工程：`app/core/utils/crypt.ts:12` `LOG_TOKEN_KEY = "pM6Umv*^hVQuB6t&"`，`:27-33` `key = MD5(LOG_TOKEN_KEY + loginTime)`、`iv = hex(data 末 32 字符)`、AES-128-CBC；
  **锚点 `loginTime` 取「开战时刻」的 `pushFlags.status` 快照**（`battle.ts:150-162` 注释、`:161` `battleLoginTimes`、`:560` 取值）【已读】。
- **开战签名机制（服务端完全未实现）**：客户端对 `/quest/battleStart` 有 RSA+SHA256 签名流程——公钥常量 `CS/Torappu/BattleStartController.cs:689 START_BATTLE_SIGN_KEY`，
  签名实现 `_ProcessStartBattleSigned:1512-1612`（拼 `charId+技能+专精+装备` → `SHA256`），随机种子 `_GenStartBattleSeed:1616-1628`，接口 `CS/Torappu/IStartBattleReqWithSign.cs` / `IStartBattleRespWithSign.cs`（`SetSeed`/`GetSign`）；
  两个接口在 C# 中无实现类（由 Lua 层实现）。另有「反数据」服务白名单 `ANTI_DATA_SERVICES`（`CS/Torappu.Network/ServiceCode.cs:13-20`，含 `/quest/battleStart`、`/quest/battleFinish`，消费者 `CS/Torappu.UI.Login/LoginViewController.cs:219/1965`）。
  **结论**：客户端具备上报 seed/签名与反作弊元数据的能力，服务端既没读也没回签——见差异 P1-6（标注**推测**：C# 无实现类，无法确认真实客户端是否强制走签名分支）。
- **`Torappu.Battle.AntiCheat/` 目录只有 6 个快照结构**（`BlackboardSnapshot.cs:7`、`CharacterSnapshot.cs:12`、`EnemyRuntimeSnapshot.cs:13`、`EnemySnapshot.cs:11`、`RelicSnapshot.cs:11`、`RuneSnapShot.cs:12`），没有协议类。

---

### 5.3 结算逻辑

#### 5.3.1 客户端侧（只上报、只展示，不做裁决）

- 上报：见 §2.3；载荷 `battleData.stats` 来自 `BattleLogger.AchieveStats(BattleController)`（`CS/Torappu.Battle/BattleLogger.cs:1722`），关键计数 `checkKilledCnt:619`。
- 展示：掉落**完全信任服务端**——`CommonFinishBattleResponse` 的 9 个奖励桶直接进 view model：
  `CS/Torappu.UI.BattleFinish/DropInfoGroupViewModel.cs:35/42/49`（`LoadData(CommonFinishBattleResponse)` / `LoadData(PryResult)` / `_BatchServiceItems`）、`DropInfoViewModel.cs`；
  结算面板的十个掉落网格在 `CS/Torappu.UI.BattleFinish/BattleFinishDropInfoView.cs:345-390`（`_itemGridFirst/Unusual/Additional/ItemReturn/DiamondMaterial/Furniture`… 字段声明）与 `:214-248`（按桶 Active/装配逻辑）。
  客户端**没有掉落复算函数**（全树 `dropReward` 0 命中）；`occPercent`/`dropType` 只用于关卡预览（`CS/Torappu.UI.Stage/StageRewardDetailViewModel.cs:15/19/34-37`；枚举 `CS/Torappu/StageDropType.cs:6`、`OccPer.cs:6`）。
- 唯一状态通道是 `playerDataDelta`（`CS/Torappu/PlayerDeltaResponse.cs:13`）；`firstRewards`/`unlockStages` 在结算 UI 里主要用于跳转与展示（`BattleFinishSceneManager.cs:1674/1702`），**发奖一律以 delta 为准**。
- 理智：客户端**无本地预扣/返还**，`apCost`/`apFailReturn` 经 `BattleInOut.InParams`（`CS/Torappu.Battle/BattleInOut.cs:17`，`apCost:93`、`apFailReturn:101`、`:311` 赋值）下发，变更随 delta 回来。

#### 5.3.2 服务端 `BattleManager.finish`（`app/game/modules/battle/battle.ts:553-752`）

| 步 | 内容 | 行 |
|---|---|---|
| 1 | 解密（锚点 = battleStart 快照，防 key 漂移） | `:559-561` |
| 2 | 取 `battleInfo`；缺失归一到「未知关卡」（`stageId:""`） | `:562-574` |
| 3 | 幂等：`settled === 1` → 直接拒绝 `emptyBattleFinishResponse(1)` | `:585-590` |
| 4 | 未知关卡 → 空结算（不 500） | `:609-617` |
| 5 | 星级系数：`completeState 3 → goldScale/expScale = 1.2`，`2 → 1.0` | `:626-632` |
| 6 | 非演习发放 `EXP_PLAYER` / `GOLD(4001)`（走 gainItem 管道） | `:634-661` |
| 7 | `player.update(_settleStageState)`：状态推进/失败返还/解锁链/首通/通关次数/信赖/悖论/掉落 | `:662-675`（实现 `:767-946`） |
| 8 | 会话标记 finished；写 `battle_records`（失败不阻断） | `:678-710` |
| 9 | 任务/勋章事件补发 + 助战信用（`_emitBattleWinEvents`） | `:712-726`、`:948-1137` |
| 10 | 演习分支 `emptyBattleFinishResponse()`；否则返回完整结算体 | `:727-750` |

结算响应契约：`BattleFinishResponse`（`battle.ts:183-199`）＝ `result/apFailReturn/expScale/goldScale/rewards/firstRewards/unlockStages/unusualRewards/additionalRewards/furnitureRewards/alert/suggestFriend/pryResult`；
`pryResult` 恒 `[]`、`suggestFriend` 恒 `false`（`:575`、`:747`）。

#### 5.3.3 各结算要素的代码入口

- **理智**：**开战即扣**（`battle.ts:433-441`：`apCharged` → `draft.status.ap -= apCharged`），演习/免体力/apProtect 期不扣（`:342-347`）；失败返还按 `apFailReturn`，并以 `apCharged` 封顶（`:798-820`：`ctx.apFailReturn = max(0, min(apFailReturn, charged))`，经 `AP_GAMEPLAY` 入账 `:814-816`）。
  演习券按 `stage.practiceTicketCost` 原值扣（`:348-361`、`:426-431`）。
- **首通奖励**：`firstClear` 判定 `:818-822`（`state != 3 && completeState === 3`，或 `state == 3 && completeState === 4`）；仅取 `dropType ∈ [1, 8]`（ONCE/COMPLETE）的条目（`:856-869`），同时写入 `firstRewards` 与 gainItem 管道。
- **掉落**：`dropReward`（`battle.ts:1219-1616`）。核心概率表（均已移植自 Python 参考实现）：
  - 三星（completeState 3）按稀有度 0/1/2 加 count（权重 `[70,20,10]`/`[85,10,5]`）与 `addPercent 15/10/5`（`:1247-1269`）；二星 `[80,12,8]`/`[97,2,1]`（`:1271-1285`）。
  - 活动关（stageId 含 `act`）+12% 加成，普通关 `addPercent += randomChoices([-1,0,1],[5,90,5])`（`:1281-1286`）。
  - `handleMaterial` 硬编码表 `ToughSiege`/`AerialThreat`/`ResourceSearch`（`:1287-1355`）；`CARD_EXP` 走 `TacticalDrill`（`:1357-1397`）；`GOLD` 走 `SpecialGold`（`:1399-1464`）。
  - `occPercent`/`dropType` 分派见 `:1466-1604`（ALWAYS+NORMAL 必掉 `:1474-1481`；pro_ 关卡 50/50 二选一 `:1508-1512`）。
  - 防死循环 depth ≤ 10（`:1608`）。
- **通关奖励**：`goldGain * goldScale` 追加进 `rewards`（`:923-930`）；`completeTimes += 1`（`:878-879`）。
- **信赖**：胜利按 `completeFavor`（三星）/`passFavor`（二星）发放，缺省回退 `apCost`，0 理智关为 0；每名参战干员 +值并 emit `CharFavorCount`/`CharIntimacy`（`battle.ts:881-905`）。
- **剿灭（CAMPAIGN）**：每击杀 +1 合成玉（4003），走 `accrueCampaignKills`（`:1027`）+ 每周上限 + `refreshCampaignMissions`，并发 `CampaignsComplete` 勋章事件（`battle.ts:1022-1055`）。
- **悖论模拟（mem_）**：首通发 `handbook.rewardItem` + 写 `troop.addon.<charID>.stage.<stageId>`（`battle.ts:1173-1217`）。
- **演习（practice）**：`_settleStageState` 只把 `state==0` 推进到 1 后返回（`battle.ts:792-797`）；finish 提前返回空骨架（`:727-730`），不发 EXP/GOLD/掉落/解锁，但仍写 `settled=1`。
- **作战记录（回放）**：`loadReplay`（`:1619-1624`）、`saveReplay`（`:1626-1642`，经 battleId 反查 stageId 后写入 `replays`）；存储门面 `app/game/modules/battle/BattleStore.ts:20-45`、`app/core/db/replay-repo.ts:57/70`。
- **结算 delta 结构**：`res.send({...result, ...player.delta})`（`app/game/modules/quest/routes.ts:120-130`），`playerDataDelta` 由 `app/game/kernel/PlayerStatus.ts:62-76` 的 `delta` getter 生成（清空 `_changes` 并触发落盘）。

---

### 5.4 与本私服实现的差异比对

优先级口径：**P0** 影响可玩性/正确性（或存在作弊面）；**P1** 功能缺失/行为不一致；**P2** 细节不符/死代码/文档过期。
每条给出「客户端证据 ↔ 服务端证据」。**标注【推测】的条目尚未经真机抓包确认**（原因见文首说明）。

#### P0-1　battleStart 请求契约的字段名与类型疑似整体错配【推测，高置信】

- 客户端证据：`/quest/battleStart` 实际发送 `DefaultStartBattleRequest`（`CS/Torappu/BattleStartController.cs:1079`），其字段为 `isRetro:21`(bool)、**`pry:25`(int)**、`battleType:29`、**`multiple:33`**、`extra:37`（`CS/Torappu/DefaultStartBattleRequest.cs`）；
  基类 6 字段为 `usePracticeTicket:47`(**bool**)、`stageId:51`、`squad:55`、`assistFriend:59`、`isReplay:63`(bool)、`startTs:67`（`CS/Torappu/CommonStartBattleRequest.cs`）。
  该类**没有** `[JsonProperty]` 重命名（对比 `CS/Torappu/RequestSquadSlot.cs:34/39/44/49` 明确带 `[JsonProperty(...)]`），故 wire 名即 C# 字段名。
- 服务端证据：`app/game/modules/quest/quest.schema.ts:43-55` **强制** `pray: z.number()`、`battleType: z.number()`、`continuous: z.json()`、`isRetro: z.number()`、`usePracticeTicket: z.number()`；
  类型定义 `app/game/kernel/battle-model.ts:100-112`。全 `app/` 无 `pry`/`multiple` 字样（`grep` 实证）。
  校验失败即 422（`app/game/kernel/http/validate-body.ts:38-52`）。
- 影响：若报文字段名=C# 字段名（默认假设），真实客户端开战会因缺 `pray`/`continuous` 被 422 拦下；`isRetro`/`usePracticeTicket` 的 bool→number 亦然。
- 反证与出处：本仓 `quest.ts:4` 头部自述契约「对应客户端 …_**2.7.61**_.cs」，且同一套 `pray`/`continuous` 命名在多个模块复制（`campaignV2/campaignV2.schema.ts:15-30`、`rune/rune.schema.ts:20`、`activities/shared/activity.schema.ts:311/354`），疑似旧版/参考实现的遗留命名。
- 验证方法（建议）：真机抓一次 `/quest/battleStart` 原始 body，与 `DefaultStartBattleRequest` 字段名逐项比对；或临时把 `battleStartSchema` 改为 `.passthrough()` + 可选字段后观察是否仍 422。

#### P0-2　crisis V1/V2 的 battleFinish 完全丢弃客户端战报 → 失败也能得分

- 客户端证据：`CrisisV2BattleFinishRequest : CommonFinishBattleRequest`（`CS/Torappu/CrisisV2BattleFinishRequest.cs:6`，另有 `battleLog:10`）；`RecalRuneBattleFinishRequest`（`CS/Torappu/RecalRuneBattleFinishRequest.cs:6`）、`RuneFinishBattleRequest`（`CS/Torappu/RuneFinishBattleRequest.cs:6`）同族——客户端**确实上送** `data`+`battleData`。
- 服务端证据：`crisisV1BattleFinishSchema = z.object({})`（`app/game/modules/crisis/crisis.schema.ts:28`）、`crisisV2BattleFinishSchema = z.object({})`（`:87`）→ 路由不读 body、不解密：`crisis/routes.ts:744-747`（V1 只用 start 快照的 `totalRisks` 落 `permanent.point`/`challenge.topPoint`，`:756-780`）、`crisis/routes.ts:1119-1140`（V2 按 `runeSlots` 直接算分）。
- 影响：**战斗失败（或直接放弃）仍会推进危机合约最高分与奖励进度**，属正确性 + 作弊面双重问题。

#### P0-3　结算完全信任客户端 `completeState`，`isCheat` 既不校验也不落库

- 客户端证据：`CS/Torappu.Battle.UI/UIBattleFinishServiceState.cs:636-681` 组装 `data`（加密战报）+ `battleData{isCheat:19, completeTime:23, stats:37}`（`CS/Torappu/CommonFinishBattleRequest.cs`）；反作弊统计 `BattleStats.clientAntiCheatLog:651`、`checkKilledCnt:619`（`CS/Torappu.Battle/BattleLogger.cs`）；客户端存在反数据白名单（`CS/Torappu.Network/ServiceCode.cs:13-20`）。
- 服务端证据：`battle.ts:561-574` 解密后**不做任何一致性校验**，直接使用 `battleData.completeState`（`:626/634/798/875`）；`app/game/kernel/battle-info-store.ts:96-97` 声明 `BattleRecord.isCheat` 但 `battle.ts:687-710` 从未赋值（连「留存」都没做到，见 P2-16）。
- 影响：`LOG_TOKEN_KEY` 与算法是公开常量（`app/core/utils/crypt.ts:12`），构造合法密文上报 `completeState=3` 即可拿三星掉落/首通/信赖；建议至少校验 `battleId ∈ battleStart 快照`、`startTs ≤ completeTime`、`checkKilledCnt` 与 `enemyStats` 自洽。

#### P1-4　battleFinish 响应缺 3 个奖励桶 + 六星 `extra`

- 客户端证据：`CommonFinishBattleResponse`（`CS/Torappu/CommonFinishBattleResponse.cs:10`）含 `itemReturn:84`、`overrideRewards:96`、`diamondMaterialRewards:104`，且结算面板有对应网格（`CS/Torappu.UI.BattleFinish/BattleFinishDropInfoView.cs:375/380`、`:223/238`）；`DefaultFinishBattleResponse.extra:40`（`FinishBattleResponseExtraData.cs:6` → `sixStar{groupId,before,after}`）。
- 服务端证据：quest 响应契约 `app/game/modules/quest/quest.ts:78-95` **没有**这三字段与 `extra`；`battle.ts:734-750` 返回体同样没有。
  同仓其它模块却按官方形状补齐（`app/game/modules/activities/bossRush/router.ts:255-260`、`enemyDuel/router.ts:180-185`、`campaignV2/routes.ts:202`），说明遗漏而非有意。
- 影响：客户端结算面板对应格子恒空；六星加成弹窗无数据（服务端 `quest/routes.ts:177-190` 只写 `dungeon.sixStar.stages[].tagSelected`，不参与结算）。

#### P1-5　连战/连续作战（`battleType=Continuous|MULTIPLE`、`multiple.battleTimes`）未实现

- 客户端证据：`DefaultStartBattleRequest.BattleType`（`CS/Torappu/DefaultStartBattleRequest.cs:9-19`：Common/Continuous/MULTIPLE）与 `multiple:33`；官方结算侧有 `DefaultMultiplyBattleResponse.battleId:12`（`CS/Torappu/DefaultMultiplyBattleResponse.cs:8`），客户端连战缓存 `CS/Torappu.UI/BattleInfoCache.cs:36/40/222`。
- 服务端证据：`battle.ts` 全文未读取 `battleType`/`continuous`/`multiple`（`grep` 实证：仅 `isReplay`、`assistFriend`、`squad`、`usePracticeTicket`）；`_sessions` 只保留「最近一场」（`battle.ts:218-228`、`:301-308`），finish 也从不返回下一场 battleId。
- 影响：客户端「连续作战 N 次」链路无服务端支持；连战场景 `battleId` 不会轮换。

#### P1-6　开战签名（RSA+SHA256）与 `seed` 既不上报也不回签【推测】

- 客户端证据：`CS/Torappu/BattleStartController.cs:689`（`START_BATTLE_SIGN_KEY`）、`_ProcessStartBattleSigned:1512-1612`、`_GenStartBattleSeed:1616-1628`；接口 `CS/Torappu/IStartBattleReqWithSign.cs`（`SetSeed`）、`CS/Torappu/IStartBattleRespWithSign.cs`（`GetSign`）；反数据白名单 `CS/Torappu.Network/ServiceCode.cs:13-20`。
- 服务端证据：`battleStartSchema`（`quest.schema.ts:43-55`）无 `seed`/`sign` 字段；`battle.ts:475-481` 的响应体无签名字段。
- 说明：两接口在 C# 中**无实现类**（由 Lua 层实现），因此无法从反编译断言真实客户端一定走签名分支；此条为**推测**，但「客户端存在该能力而服务端无对应字段」是确定的。

#### P1-7　tower 的结算解密锚点与 quest 不一致（key 漂移风险）

- 客户端证据（间接）：加密实现位于 Lua 热更层不可读（`CS/Torappu.Battle.UI/UIBattleFinishServiceState.cs:729-746` 为桩），「锚点=开战时刻的 `pushFlags.status`」这一事实来自服务端反向实现与其注释（`app/game/modules/battle/battle.ts:150-162`、`app/core/utils/crypt.ts:27-33`）——**无法从 C# 侧独立证实**。
- 服务端证据：`app/game/modules/tower/routes.ts:377` 用 `player.loginTime`（**当前会话值**）解密，而 quest 用 `battleLoginTimes` 快照（`battle.ts:161/560`）。这是本仓内部两套解密口径的不一致。
- 影响：tower 战斗横跨一次 `syncData`（`pushFlags.status` 刷新）就可能 `bad decrypt`，被 `try/catch` 吞成「按失败处理」（`tower/routes.ts:374-390`）。

#### P1-8　回放链路的三处不一致

- 客户端证据：`SaveBattleReplayResponse.result:10`（`CS/Torappu/SaveBattleReplayResponse.cs:6`）为响应契约字段；`LoadBattleReplayRequest.stageId:10`（按关卡取回放）；`battleReplay` 为 base64(ZIP)+`default_entry`（服务端反向实现 `app/core/utils/crypt.ts:98-104`）；上传触发 `CS/Torappu.UI/BattleFinishSceneManager.cs:430/1191/1219/1228`。
- 服务端证据：① `app/game/modules/quest/quest.ts:105-107` 自述「CS 含 result 字段，服务端未返回」→ `quest/routes.ts:144-152` 只回 delta；
  ② `battle.ts:1631-1641` 用 `battleInfo?.stageId` 反查，缺失时 `stageId!` 断言后写入（可能落空键，回放丢失）；
  ③ `battle.ts:1619-1624` 无回放时返回 `""`，客户端侧对空串的处理未验证。
- 影响：回放保存「静默失败」/首存丢档；响应缺 `result` 与其它模块不一致。

#### P2-9　演习结算响应只有空骨架

- 客户端：`DefaultFinishBattleResponse` 的奖励桶字段在演习时同样存在（`CS/Torappu/DefaultFinishBattleResponse.cs:8-40`），且**请求里没有 isPractice 字段**（全树 grep 0）→ 服务端只能靠 `usePracticeTicket` 推断。
- 服务端：`battle.ts:727-730` 直接 `return emptyBattleFinishResponse()`（各桶空、`result:0`）；结算状态回填 `_settleStageState:792-797`。
- 影响：客户端若按桶做「本次获得」展示，演习时全空但与正式同形，风险低，故 P2。

#### P2-10　`pryResult` / `suggestFriend` 恒空、恒 false（好友建议未实现）

- 客户端：`DefaultFinishBattleResponse.pryResult:28`、`suggestFriend:36`；`PryResult` 结构（`SIG:56270-56285`：`pryStage/expScale/goldScale/rewards/overrideRewards/…`）。
- 服务端：`battle.ts:575` `suggestFriend = false`、`:747` `pryResult: []`，`battle.ts:183-199` 注释自承「好友建议逻辑未实现，仅对齐响应结构」。
- 影响：功能缺失，无正确性风险（客户端按空列表渲染）。

#### P2-11　`/quest/battleContinue` 是 ODPY 遗留端点，2.7.71 无对应 HTTP 协议类

- 客户端：`battleContinue` **没有** HTTP Request/Response 类（逐名 find + SIG grep 0 命中）；仅联机域有 `Torappu.Multiplayer.RequestType.BattleContinue = 20`（`SIG:115111`）与 socket 协议 `SIG:116865`；连战续战走 `_OnContinueBattleServiceSuc`（`CS/Torappu.Battle.UI/UIBattleFinishServiceState.cs:451`），无独立请求类。
- 服务端：`app/game/modules/quest/routes.ts:154-167` 返回 `result:1` + 全零 battleId + 空 delta（`api.md:1631` 标注为 stub）。
- 影响：客户端不会调用，属死端点；但若将来做断线续战，需要全新的服务端语义（当前口径无法复用）。

#### P2-12　rune battleFinish 的 `score/from/to` 恒 0

- 客户端：`RuneFinishBattleResponse.score:12`、`from:16`、`to:20`（`CS/Torappu/RuneFinishBattleResponse.cs:8`）。
- 服务端：`app/game/modules/rune/routes.ts:91-97` 在真实 `battle.finish` 结果上硬盖 `score: 0, from: 0, to: 0`。
- 影响：符文学徒试炼（recalRune/rune）计分展示恒 0（`docs/接口覆盖分析-未实现与stub清单.md:120` 已记录）。

#### P2-13　sandbox V3 战斗为 202 空响应

- 客户端：`SandboxV3BattleStartRequest`/`SandboxV3BattleFinishRequest` 存在于协议族，但**在 `Torappu.UI.SandboxPerm.SandboxV3` 命名空间**：`CS/Torappu.UI.SandboxPerm.SandboxV3/SandboxV3BattleStartRequest.cs:6`、`…/SandboxV3BattleFinishRequest.cs:7`（后者继承 `CommonFinishBattleRequest`）。
- 服务端：`app/game/modules/sandbox/routes.ts:906-919` 直接 `res.sendStatus(202)`（不读 body、不结算）。抓包库中存在该路径 202 记录（`tmp/capture/index.db`，`/sandboxPerm/sandboxV3/battleStart`）。
- 影响：沙盒 V3 战斗零结算（`docs/接口覆盖分析-未实现与stub清单.md:96` 同类记录）。

#### P2-14　`completeState === 4` 分支在 2.7.71 CS 中无枚举依据

- 客户端：`PlayerBattleRank` 仅 FAIL/PASS/COMPLETE 三档（`SIG:949202-949208`；`SIG:86378/104039` 用其承载 `completeState`）；本仓映射 `app/game/kernel/util/stage-unlock.ts:20-24` 亦然。
- 服务端：`battle.ts:819-822`（`state == 3 && completeState === 4` 视为首通）、`:874-875`（`state != 3 || completeState === 4` 时写 `state = completeState`）——全文件仅这两处出现 4。
- 影响：疑似不可达分支；若客户端永不发 4，则相关「重打刷首通」逻辑为死代码（**推测**：不排除运行时 hotfix 注入 4）。

#### P2-15　`isApProtect` 类型：官方 bool vs 服务端 number

- 客户端：`DefaultStartBattleResponse.isApProtect:10` 是**bool**（`notifyPowerScoreNotEnoughIfFailed:18`、`inApProtectPeriod:22` 同为 bool）。
- 服务端：`app/game/modules/quest/quest.ts:55-63` 声明 `isApProtect: number`；`battle.ts:475-481` 返回 0/1。
- 影响：若客户端 JSON 反序列化严格校验类型，可能解析异常；本仓同类「bool 用 number 承载」在多处长期存在且未报障，故判 P2（**推测**，无真机证据）。

#### P2-16　`battle_records.isCheat` 声明了但从不落库，`decryptIsCheat` 是死代码

- 客户端证据：`battleData.isCheat` 每次结算必带（`CS/Torappu/CommonFinishBattleRequest.cs:19`；组装点 `CS/Torappu.Battle.UI/UIBattleFinishServiceState.cs:670`），其含义是 battleId 的每字节 +7 混淆。
- 服务端证据：`app/game/kernel/battle-info-store.ts:96-97` 声明 `isCheat?: string`（注释称「仅留存不校验」），但 `battle.ts:687-710` 的记录字面量里没有该字段（`grep isCheat app/game/modules/battle/battle.ts` 只命中 `:544` 的 JSDoc 与 `:555` 的类型签名）；`app/core/utils/crypt.ts:84 decryptIsCheat` 全仓无调用点。
- 影响：反作弊线索既未校验也未留存；JSDoc（`battle.ts:544`「debug 逆向（isCheat 解密）✓」）与实际不符。

> 差异条数统计：**P0 × 3；P1 × 5；P2 × 8，合计 16 条**。
> 前 5 条（P0-1、P0-2、P0-3、P1-4、P1-5）为优先处理项。

---

### 5.5 对私服有直接参考价值的反编译点（可移植/可交叉验证）

1. **结算报文构造（可直接照着写解析器/校验器）**
   `CS/Torappu.Battle.UI/UIBattleFinishServiceState.cs:636-701`：`BattleData`（`completeTime:667`、`stats:669`、`isCheat:670`）→ `BattleDataInRequest`（`:677-681`）→ `data`（`:685`）。
   与之对齐的服务端解析对象是 `app/game/kernel/battle-model.ts:5-98`（`BattleData/BattleLogger/BattleStats`）。
2. **`isCheat` 的构造方式（纯函数，已可双向验证）**
   `app/core/utils/crypt.ts:68-74 encryptIsCheat`（每字节 +7 后 base64）与 `:84-88` 逆运算；服务端目前既不校验也不落库（P0-3/P2-16），可直接拿来做「battleId 一致性」快检。
3. **战报统计口径（决定 `battle_records` 字段语义）**
   `CS/Torappu.Battle/BattleLogger.cs:318 BattleStats`：`checkKilledCnt:619`、`leftHp`/`totalDamage`/`totalHeal`（对应 `app/game/kernel/battle-info-store.ts:70-96` 的 `BattleRecord` 字段）、`clientAntiCheatLog:651`。
   采集入口 `AchieveStats(BattleController):1722`、快照 `TakeSnapShot:749`。
4. **胜负/星级判定（服务端做校验时的语义源）**
   `CS/Torappu.Battle.GameMode/IGameMode.cs:471 GetBattleCompleteRank`、`CS/Torappu.Battle.GameMode/GameModeFactory.cs:25013`（默认模式）、`:26556 OnPlayerLifeToZero → LOSE:26564`；`CS/Torappu.Battle/BattleController.cs:4659 MarkAlwaysWinWhenFinish`（调试旁路）。
   ⚠ 这些方法体多为反编译桩，只能取「生命点归零=失败」这一条稳定语义，不能移植完整算法。
5. **回放压缩（可生成测试夹具）**
   `CS/Torappu.UI/AutoBattleConvertUtil.cs:421 CompressString / :447 TryDecompressString / :476 CompressBattleLog / :496 TryDecompressBattleLog`（实现为 hotfix 桩，算法不可得）；
   服务端侧可信格式见 `app/core/utils/crypt.ts:98-104`（base64 → ZIP → `default_entry`）。
6. **理智与失败返还的字段口径**
   `CS/Torappu.Battle/BattleInOut.cs:17 InParams`（`apCost:93`、`apFailReturn:101`、`:311` 赋值）、`:343 OutParams`；对应服务端 `battle.ts:342-361`（开战判定）、`:433-441`（预扣）、`:798-820`（返还封顶）。
7. **掉落公式**：客户端**没有**可移植的掉落实现（`dropReward` 全树 0 命中；`DropInfoGroupViewModel`/`BattleFinishDropInfoView` 纯展示），
   故服务端 `battle.ts:1219-1616` 的权重表与 `handleMaterial`/`TacticalDrill`/`SpecialGold` 硬编码表就是**唯一权威**，反编译侧只能用于核对字段与桶名（第 3 节）。
8. **开战签名/种子**：`CS/Torappu/BattleStartController.cs:689/1512-1612/1616-1628` 与两个 Sign 接口可用于设计「服务端签名字段」的占位（当前完全缺失）。

---

### 5.6 结论与既有约束核实

1. **战斗链路的权威分工**：客户端演算 + 上报加密战报（`data`；加密方案以服务端反向实现为准：AES-128-CBC / `MD5(key+锚点)` / IV 拼在密文尾部，锚点=开战快照 `pushFlags.status`，见 `app/core/utils/crypt.ts:12/27-33` 与 `battle.ts:161/560`；**C# 层只有桩，无法独立证实**）；
   服务端只做「开战预扣 + 结算发奖 + 状态推进」；客户端**不做任何掉落/理智裁决**（§3.1），故服务端 `battle.ts` 的奖励口径就是全服唯一真相。
2. **结算入口结论**：`BattleManager.finish`（`app/game/modules/battle/battle.ts:553-752`）十步链路完整——解密 → 幂等（`settled`）→ 星级系数 → EXP/GOLD → `_settleStageState`（状态/返还/解锁/首通/通关数/信赖/悖论/掉落）→ 会话结束 → `battle_records` 留存 → 任务/勋章事件 → 助战信用 → 响应组装。
   掉落入口 `dropReward:1219`；首通入口 `:856-869`；失败返还 `:798-820`；回放 `:1619-1642`。
3. **AGENTS 约束「Non-practice battle HTTP chain is incomplete (battleStart lacks battleId)」→ 已不成立，建议更新**：
   - quest：`battle.ts:301/475-481` 生成并回传 `battleId`，`quest/routes.ts:112-119` 并入响应；客户端契约 `CommonStartBattleResponse.battleId:14` 就是该字段。
   - addonStage：`character/troop.ts:240-272` 已改为真实 `battle.start`（不再固定演习、不再丢弃返回值），`character/routes.ts:297-303` 把结果（含 battleId）并入响应。
   - 对应 `design-spec.md:1258`（§12.3）的描述也已过期。
4. **但「非演习战斗 HTTP 链路」仍有真实风险**：P0-1（开战请求字段名/类型疑似错配）可能导致真实客户端开战直接 422；
   在真机抓包验证前，不应把该约束简单标记为「已解决」，建议改为
   「quest 战斗结算链路已完整并被单测覆盖（`tests/unit/manager/battle.test.ts`，1591 行、60+ 用例）；开战请求契约字段名待真机核对（`pray`/`continuous` vs `pry`/`multiple`）」。
5. **最高优先修复顺序**：P0-2（危机合约失败也能得分）→ P0-3（结算无校验）→ P0-1（开战契约）→ P1-4（响应缺桶与六星 extra）→ P1-5（连战）。
6. **文档口径建议**：`docs/module-audit-2026-08-29.md:21/52` 关于「AP 在 finish 才扣」「finish 响应缺 itemReturn/overrideRewards/diamondMaterialRewards」的描述，前者已被 `battle.ts:433-441` 修复（2026-09-09 起 start 预扣），后者对 quest 仍成立但需限定到 `quest/battleFinish`（其它模块已补齐）。

## 6. 基建 / 肉鸽 / 生息演算

> **本章范围**：三个「大系统」玩法域——基建（Building）、集成战略 rlv2（Roguelike）、生息演算（SandboxPerm V2/V3）。
> **客户端基线**：`reference/arknights-2.7.71-csharp/Assembly-CSharp/`（下称 `AC/`）。
> **服务端基线**：`app/game/modules/{building,roguelike,sandbox}/` 与 `app/game/routes.ts` 的挂载表。
> **方法**：协议类逐字段清点（`AC/Torappu/`、`AC/Torappu.UI.*/` 下的 `*Request.cs`）+ 客户端 UI/服务类的 `BindToResponse<T>("path")` 端点字面量 + 服务端路由与 handler 逐条对照；每条结论附 `路径:行号`。
> **证据分级**：`[已验证]` = 本次实际读过该行代码；`[推测]` = 由命名/数据表/同类实现外推，未读到直接证据。行号基于 2.7.71 反编译产物，客户端更新后会漂移，届时以 `Cpp2IlInjected.Token` 重新定位。
>
> **先读结论（TL;DR）**：三域成熟度呈**极端两极**——基建与肉鸽 rlv2 是本仓最成熟的两个业务模块（路由面与客户端逐条对齐、无 202 桩、有大量单测与抓包对照），而生息演算（沙盒）是**唯一「路由面齐全但实现为零」的大域**：66 条客户端可见路径里 62 条返回纯 202/空 delta，全模块 `player.update(` 出现 **0** 次，即**没有任何状态落盘**。因此本章的最高价值结论是：**沙盒域在服务端等于不存在**（详见 5.3 与 5.4 的 P0 条目）。

---

### 6.1 基建（Building）

> 口径：客户端 = `reference/arknights-2.7.71-csharp/Assembly-CSharp/`（下述路径省略该前缀，简写 `Torappu/…`、`Torappu.Building/…`）；服务端 = `app/game/modules/building/`。行号均已用 `read`/`grep -n` 核对。标注「推测」者为未取证论断。
> 端点清单以抓包契约库 `tmp/capture/index.db`（`module='building'` 去重 61 条路径）为准；**该库为契约覆盖抓包（每端点 3 条、请求体多为空探针），不能用作频率口径**。下文「高频」依据客户端调用点（`BuildingServiceController` / `BuildingServiceUtil` / UI 触发点）。

---

#### 6.1.0 结论速览

- 协议面**端点覆盖率接近满**：抓包实证 61 条 `/building/*` 路径，服务端 `handler.ts` 注册 65 条（多个 `cleanRoom`/`getInfoShareReward`/`getMessageBoardContent`/`takeClueFromBoard` 未被抓包覆盖但均有 CS 类依据）。
- 玩法深度**较高且多数经真存档校准**：制造/贸易时间模型、buff 引擎（760 buff）、心情档位、宿舍恢复、线索全公式、专精门控、电力余额、加工站 `ws_bonus` 均已落地（design-spec §11.4–11.14）。
- **真正的缺陷集中在"响应字段形状"与"请求 schema 与 CS 类不符"两类**，而非玩法缺失：4 条 P0/P1 级 schema 字段错配（专精×2、宿舍锁定、DIY 缩略图）会让官方客户端直接 422 或绑定不到字段；4 条响应缺字段会让客户端状态不刷新。
- 明确**不存在**的机制：无人机/BGU 持有点（客户端 2.7.71 全量符号无 `BGU`/`Drone` 命中）、SHOP 房间（`building_data.rooms` 无 SHOP 实例，仅遗留类型）。

---

#### 6.1.1 客户端数据模型与玩法骨架

##### 1.1 顶层状态树

`Torappu/PlayerBuilding.cs`：
- `status: PlayerBuildingStatus`(:25) — `PlayerBuildingStatus.cs:11` `labor`、`:15` `workshop`
- `chars: Dictionary<string, PlayerBuildingChar>`(:37)、`assist: List<int>`(:41) — 助战干员 instId 列表
- `roomSlots: Dictionary<string, PlayerBuildingRoomSlot>`(:41)、`rooms: PlayerBuildingRoom`(:45)
- `furniture: Dictionary<string, PlayerBuildingFurnitureInfo>`(:49)
- `diyPresetSolutions: Dictionary<string, PlayerBuildingDIYPreset>`(:53)
- `solution: PlayerBuildingSolution`(:57) — 内嵌类 `PlayerBuildingSolution.furnitureTs: Dictionary<string,long>`(:14，家具「新增时间」用于新家具角标)
- `music: BuildingMusic`(:61)

`Torappu/PlayerBuildingRoom.cs` 是**按房间类型分桶**的容器，键为 roomSlotId：`manufact`(:12) / `shop`(:17) / `power`(:22) / `control`(:27) / `meeting`(:32) / `hire`(:37) / `dorm`(:42) / `privateDorm`(:47) / `training`(:52) / `workshop`(:57) / `trading`(:62)。

`Torappu/PlayerBuildingRoomSlot.cs`：`level`(:13)、`state: PlayerRoomSlotState`(:17)、`roomId: BuildingData.RoomType`(:22)、`charInstIds: int[]`(:26)、`completeConstructTime`(:30)。

`Torappu/PlayerBuilding.cs`(数据类) 里房间类型枚举在 `Torappu/BuildingData.cs`：`RoomCategory`(:14，位掩码)、`RoomType`(:84，位掩码 NONE/CONTROL=1/POWER=2/MANUFACTURE=4/SHOP=8/DORMITORY=16/MEETING=32/HIRE=64/ELEVATOR=128/CORRIDOR=256/TRADING=512/WORKSHOP=1024/TRAINING=2048/PRIVATE=4096/FUNCTIONAL=3710/ALL=8191)、`OrderType`(:121，O_COMPOUND/O_GOLD/O_DIAMOND)、`FurnitureCategory`(:132)、`RoomUnlockCond`(:564)、`FormulaItemType`(:449)。字符串常量表 `RoomTypeString`(:41)。

**状态枚举**（无独立文件，定义在签名大文件 `reference/com.hypergryph.arknights_2.7.71.cs`）：
- `PlayerRoomSlotState`(:949268) = EMPTY/UPGRADING/BUILT(:949272-949274)
- `PlayerRoomState`(:949279) = STOP/RUN(:949283-949284)
- `PlayerBuildingHiringState`(:65910) = EMPTY/HIRING
- `PlayerBuildingTrainerState`(:66125) = EMPTY/TRAINING/FINISH/WAITING
- `PlayerBuildingTraineeState`(:66137) = EMPTY/TRAINING/OUTOFDATE/WAITING

##### 1.2 干员进驻状态

`Torappu/PlayerBuildingChar.cs`：`charId`(:35)、`lastApAddTime`(:39)、`ap: long`(:43，**raw AP，1 心情点 = manpowerDisplayFactor = 360000**)、`roomSlotId`(:47)、`index`(:51，槽位序号)、`changeScale`(:55，心情变化率 **raw AP/秒**)、`bubble`(:59)、`skinIdInVisit`(:69)。

客户端换算与阈值：`Torappu.Building/BuildingCharModel.cs` `RoundCharApToInt`(:244)、`DisplayCharApToRoughRawValue`(:254，`manpowerDisplayFactor × displayAp`)、`DisplayApFloat`(:291)、`CheckTired`(:311，读 `BuildingData.tiredApThreshold`)。常量落库：`data/excel/building_data.json` → `manpowerDisplayFactor=360000`、`tiredApThreshold=100`、`basicFavorPerDay=720`、`laborRecoverTime=360`；反射声明 `Torappu/BuildingData.cs:2444/2464/2456/2392`。
运行期模型 `BuildingCharModel.cs`：`lastManpower`(:34)、`maxManpower`(:38)、`powerCost`(:42)、`stationIndex`(:50)、`isTraining`(:62)、`isDormLock`(:66)、`canGainIntimacy`(:70)、`assistIntimacy`(:74)、`privateIntimacy`(:78)。

##### 1.3 制造站

`Torappu/PlayerBuildingManufacture.cs`：`buff: PlayerBuildingManufactureBuff`(:12)、`state: PlayerRoomState`(:16)、`formulaId`(:20)、`remainSolutionCnt`(:24)、`outputSolutionCnt`(:28)、`lastUpdateTime`(:32)、`processPoint: double`(:36)、`saveTime`(:40)、`completeWorkTime`(:44)、`capacity`(:48)、`apCost`(:52)、`display: BuildingBuffDisplay`(:56)、`presetQueue: List<List<int>>`(:60)。
`PlayerBuildingManufactureBuff.cs:11` `speed: float`、`:15` `capacity: int`；`PlayerBuildingWorkshopStatus.cs:11` `bonus: Dictionary<string, List<int>>`（`ws_bonus` 蓄力进度 `[cur,total]`）。
配方数据：`BuildingDataConverter.cs:714 GetManufactFormula`；容量相位 `manufactData.phases[].outputCapacity = 24/36/54`（`data/excel/building_data.json`）。
**可确证速率语义**：`Torappu.Building/BuildingDataConverter.cs:1132 LoadManufactSpeed(int level)` 取 `manufactData` 相位 speed（excel 中三档均为 `1`），`basicSpeedBuff = 0.01`（每名在岗干员 +1%）——即**进度速率 = 1×(1+加成) 点/秒，阈值 = 配方基础秒数**（与服务端 dc-fix 结论一致，见 §3.1）。

##### 1.4 贸易站

`Torappu/PlayerBuildingTrading.cs`：`buff`(:14)、`state`(:18)、`lastUpdateTime`(:22)、`strategy: BuildingData.OrderType`(:27)、`stockLimit`(:31)、`apCost`(:35)、`stock: List<PlayerBuildingTradingOrder>`(:39)、`next: PlayerBuildingTradingNext`(:43)、`display`(:50)、`presetQueue`(:54)。
`PlayerBuildingTradingOrder.cs`：`instId: long`(:44)、`type: OrderType`(:49)、`delivery: ItemBundle[]`(:53)、`gain: ItemBundle`(:57)、`buff: TradingOrderBuff[]`(:61，内嵌 `{from:string(:16), param:int(:20)}`)、`extraCost: bool`(:66)、`specGoldTag: TradingGoldTag`(:70，内嵌 `{activated:bool(:35), from:string(:39)}`)。
`PlayerBuildingTradingNext.cs`：`order: long = -1`(:10)、`processPoint: double`(:14)、`speed: double`(:18)、`maxPoint: int`(:22)。
`PlayerBuildingTradingBuff.cs:11` `speed: float`、`:15` `limit: int`。
excel：`tradingData.basicSpeedBuff=0.01`、`phases[].orderSpeed=1`、`orderLimit=6/8/10`、`orderRarity=1/2/3`；订单汇率 `goldItems["3003"]=500`（服务端 `app/game/excel/building_excel.ts:55 getGoldRate`）。

##### 1.5 会客室与线索

`Torappu/PlayerBuildingMeeting.cs`：`visitedUser`(:12)、`buff: PlayerBuildingMeetingBuff{speed}`(:16)、`state: int`(:20)、`processPoint: int`(:24)、`speed: float`(:28)、`ownStock: List<PlayerBuildingMeetingClue>`(:32)、`receiveStock`(:36)、`board: Dictionary<string,string>`(:40)、`socialReward`(:44)、`received: int`(:48)、`infoShare: PlayerBuildingMeetingInfoShareState`(:52)、`lastUpdateTime`(:56)、`dailyReward: PlayerBuildingMeetingClue`(:60)、`presetQueue`(:64)、`messageLeave`(:68)、`diySolution`(:72)。
`PlayerBuildingMeetingClue.cs`：`id`(:11)、`type`(:15)、`number`(:19)、`uid`(:23)、`nickNum`(:27)、`name`(:31)、`chars: List<PlayerBuildingMeetingClueChar>`(:35)、`inUse: int`(:39)、`ts: long`(:43)。
线索常量（`data/excel/clue_data.json`）：`inventoryLimit=10`、`expiredDays=10`、`outputBasicBonus=20`、`outputOperatorsBonus=20`、`cluePointLimit=7200000`、`transferBonus=20`、`recycleBonus=5`、`expiredBonus=25`、`communicationDuration=86400`、`initiatorBonus=210`、`participantsBonus=30`、`messageLeaveBoardConstData{visitorBonus:30, visitorBonusLimit:300, visitorToWeek:10, visitorPreWeek:10}`；类型声明 `reference/com.hypergryph.arknights_2.7.71.cs:91994 MeetingClueData`（`inventoryLimit`:92001、`outputBasicBonus`:92002、`expiredDays`:92005）。
客户端轮询节拍：`Torappu.Building/BuildingServiceController.cs:230 _GetNextUpdateTime()` 取 `PlayerData.events.building` 与 `BuildingDataConverter.GetNextMeetingUpdateTime()` 的较小值 → `:183 _UpdateCountDown()` 用 `CountDownTask`（`onTimeout = _SendSyncDataRequest`，:201）→ `:285 _SendSyncDataRequest()` 调 `BuildingServiceUtil.SendSyncService()`。**这是 `/building/sync` 属于高频轮询端点的直接证据**。

##### 1.6 训练室 / 专精

`Torappu/PlayerBuildingTraining.cs`：`buff`(:11)、`lastUpdateTime`(:15)、`trainer: PlayerBuildingTrainer`(:19)、`trainee: PlayerBuildingTrainee`(:23)、`completeWorkTime`(:27)。
`PlayerBuildingTrainee.cs`：`state`(:10)、`charInstId`(:14)、`processPoint`(:18)、`speed`(:22)、`targetSkill`(:26)。`PlayerBuildingTraineeState` / `TrainerState` 见 §1.1。
协议：**`Torappu/UpgradeSpecializationRequest.cs:10/14/18 = charInstId / skillIndex / targetLevel`**；`Torappu/CompleteUpgradeSpecializationRequest.cs:6`（无字段）；`Torappu/UpdateSpecializationRequest.cs:6/:10 = BuildingRequest + skillIndex`。

##### 1.7 人力办公室 / 加工站 / 发电 / 控制中枢（含 BGU 结论）

- 人力：`PlayerBuildingHire.cs` `buff`(:12)、`recruitSlotId`(:16)、`state: PlayerBuildingHiringState`(:20)、`processPoint`(:24)、`speed`(:28)、`lastUpdateTime`(:32)、`refreshCount`(:36)、`completeWorkTime`(:40)、`presetQueue`(:44)。
- 加工站：`PlayerBuildingWorkshop.cs:11 buff`；状态 `PlayerBuildingWorkshopStatus.bonus`(§1.3)。
- 发电站：`PlayerBuildingPower.cs:15 presetQueue`；`PlayerBuildingPowerBuff.cs:11 laborSpeed: float`。电力供需由客户端 `BuildingDataConverter.cs:1252 SumElectricForBuild` / `:1283 SumElectricForUpgrade` 计算，数据源 `rooms[].phases[].electricity`。
- 控制中枢：`PlayerBuildingControl.cs:11 buff`、`:18 apCost`、`:22 presetQueue`；`PlayerBuildingControlBuff.cs:9 Global{apCost:int(:13)}`。
- **BGU/无人机**：在 `reference/com.hypergryph.arknights_2.7.71.cs` 内 `grep -n 'BGU'` 与 `grep -n 'Drone'` **0 命中**，`Torappu/`、`Torappu.Building*/` 亦无同名类型；控制中枢/发电站结构里没有任何持有量或充能字段。**结论（已读代码验证）：无人机持有点在协议层不存在，机制由客户端本地推算（=不可反编译层），服务端不建模是正确的**（与 design-spec.md:1202 §11.13④ 的审计结论一致）。
- `Torappu.Building.Vault/`（34 文件，`VCameraController`/`VRoom*`/`VFurniture*`）为 3D 展示层，`grep -l 'Request|Response'` 无命中，**不携带协议**。`Torappu.Building.BP/`（30 文件，`BControlRoom`/`BManufactureRoom`/…/`BlueprintMode.cs`）为建造模式视图层。

##### 1.8 宿舍 / 私人宿舍 / 家具 / DIY

`PlayerBuildingDormitory.cs`：`buff`(:60，含 `APCost{all:int(:34), single{target,value}}`)、`comfort`(:64)、`diySolution`(:68)、`lockQueue: int[]`(:72)。
`PlayerBuildingPrivate.cs`：`owners: int[]`(:10)、`comfort`(:14)、`diySolution`(:18)。
`PlayerBuildingDIYSolution.cs`：`wallPaper`(:11)、`floor`(:15)、`carpet: List<PlayerBuildingFurniturePositionInfo>`(:19)、`other`(:23)（即协议里 `changeDiySolution` 的 `solution` 字段）。
`PlayerBuildingDIYPreset.cs`：`name`(:10)、`roomType`(:14)、`solution`(:18)、`thumbnail`(:22)。
`PlayerBuildingLabor.cs`：`buffSpeed`(:11)、`value`(:15)、`maxValue`(:19)、`lastUpdateTime`(:23)、`processPoint: double`(:27)。

##### 1.9 预设队列 / 商店容器

预设队列同时存在于多个房间对象上（`presetQueue: List<List<int>>`）：MANUFACTURE(:60)、TRADING(:54)、POWER(:15)、CONTROL(:22)、MEETING(:64)、HIRE(:44)。
`PlayerBuildingShop.cs:11 stock: PlayerBuildingShopStock[]`；`PlayerBuildingShopStock.cs`：`buffSpeed`(:11)、`state: PlayerRoomState`(:15)、`formulaId`(:19)、`itemCnt`(:23)、`processPoint`(:27)、`lastUpdateTime`(:31)、`saveTime`(:35)、`completeWorkTime`(:39)。**注意：`data/excel/building_data.json` 的 `rooms` 只有 12 项（CONTROL/POWER/MANUFACTURE/TRADING/DORMITORY/PRIVATE/WORKSHOP/HIRE/TRAINING/MEETING/ELEVATOR/CORRIDOR），没有 SHOP 实例**；`BuildingData.RoomType.SHOP=8` 与 `rooms.shop` 桶是遗留物（已读代码验证）。

---

#### 6.1.2 协议面清单

基类：`Torappu/BuildingRequest.cs:6 public abstract class BuildingRequest`（无字段）。**注意 10 个 Request 不继承它**：`BuildingAssistReportRequest`(BuildingAssistReportRequest.cs:6)、`BuildingBuyLaborRequest`(:6)、`BuildingGainAllIntimacyRequest`(:6)、`BuildingGetFriendSortListInfoRequest`(:6)、`BuildingManufactLaborAccelRequest`(:6)、`BuildingSetAssistRequest`(:6)、`BuildingTradingChangeStrategyRequest`(:8)、`BuildingTradingDeleteOrderRequest`(:6)、`BuildingTradingDeliveryRequest`(:6)、`BuildingTradingLaborAccelRequest`(:6)，另 `UpgradeSpecializationRequest.cs:6`；两个 CharBuild 类 `CharBuildIncIntimacyRequest.cs:6`/`CharBuildIncAssistIntimacyRequest.cs:6` 反而继承 `BuildingRequest`。
响应基类：59 个 `Building*Response` 中 **47 个为 `PlayerDeltaResponse`**；例外：`BuildingAssistReportResponse.cs:7`（裸类）、`BuildingGetRecentVisitorsResponse.cs:7`、`BuildingDIYGetPresetThumbnailUrlResponse.cs:7`、`BuildingMeetingClueGetInfoShareVisitorsResponse.cs:6`；`BuildingDIYRenamePresetSolutionResponse.cs:6`/`BuildingDIYSavePresetSolutionResponse.cs:6` 继承 `ExaminResponse`；`BuildingGetFurnitureGoodListResponse.cs:7` 实现 `IShopGetResposne`；`BuildingBuildRoomResponse.cs:7`/`BuildingUpgradeCompleteRoomResponse.cs:7` 另实现 `IAlertResponse`。

##### 2.1 同步 / 基础设置

| CS Request(:行) | 关键字段 | 服务端路由(:handler.ts 行) |
|---|---|---|
| `BuildingSyncRequest.cs:6` | 无 | `/sync`(:149) |
| `BuildingChangeBGMRequest.cs:10` | musicId | `/changeBGM`(:171) |
| `BuildingPayloadSetPrivateDormOwnerRequest.cs:10/14` | slotId, charInsId | `/setPrivateDormOwner`(:181) |
| `BuildingSetAssistRequest.cs:10/14` | type, charInstId | `/setBuildingAssist`(:191) |

##### 2.2 建造 / 升级 / 降级 / 清理

| CS Request | 字段(:行) | 服务端路由 |
|---|---|---|
| `BuildingBuildRoomRequest.cs:10/14` | roomSlotId, roomId | `/buildRoom`(:207) |
| `BuildingUpgradeRoomRequest.cs:10/14` | roomSlotId, targetLevel | `/upgradeRoom`(:215) |
| `BuildingUpgradeCompleteRoomRequest.cs:10/14` | roomSlotId, targetLevel | `/completeUpgradeRoom`(:223，202) |
| `BuildingDegradeRoomRequest.cs:10/14` | roomSlotId, targetLevel | `/degradeRoom`(:231) |
| `BuildingCleanRoomRequest.cs:10` | roomSlotId | `/cleanRoom`(:636) + 兼容 `/cleanRoomSlot`(:644) |
| `UpdateSpecializationRequest.cs:10` | skillIndex | **无对应路由**（见 §4-D2） |
| `CompleteUpgradeSpecializationRequest.cs:6` | 无 | `/completeUpgradeSpecialization`(:247) |
| `UpgradeSpecializationRequest.cs:10/14/18` | charInstId, skillIndex, targetLevel | `/upgradeSpecialization`(:239) |
| —（CS 无） | — | `/upgradeDiyLevel`(:255，stub) |

##### 2.3 换班 / 干员分配 / 信赖

| CS Request | 字段(:行) | 服务端路由 |
|---|---|---|
| `BuildingAssignCharRequest.cs:11/15` | roomSlotId, charInstIdList:List\<int\> | `/assignChar`(:265) |
| `BuildingBatchChangeWorkCharRequest.cs:6` | **无字段** | `/batchChangeWorkChar`(:277，202) |
| `BuildingBatchRestCharRequest.cs:6` | **无字段** | `/batchRestChar`(:285) |
| `CharBuildIncIntimacyRequest.cs:10` | charInstId | `/gainIntimacy`(:293，202)（服务端自注同源：`models.ts:169`/`schemas.ts:116-118`，字段 `charInstId` 吻合；`BuildingServiceUtil.cs:357 SendIncIntimacy`） |
| `BuildingGainAllIntimacyRequest.cs:6` | 无 | `/gainAllIntimacy`(:301，202，返回 normal/assist) |
| `CharBuildIncAssistIntimacyRequest.cs:10` | charInstId | `/gainAssistIntimacy`(:314，202)（`schemas.ts:123-126`；`BuildingServiceUtil.cs:364`） |
| `BuildingPayloadConfirmPrivateDormIntimacyRequest.cs:10` | charInstId | `/confirmPrivateDormIntimacy`(:322) |

##### 2.4 生产 / 贸易 / 加速 / 加工

| CS Request | 字段(:行) | 服务端路由 / 响应补丁 |
|---|---|---|
| `BuildingSettleManufactRequest.cs:11/15` | roomSlotIdList:List\<string\>, supplement | `/settleManufacture`(:376) → `supplement` |
| `BuildingSettleSaleRequest.cs:11` | roomSlotIdList | `/settleSale`(:388，202) |
| `BuildingChangeManufactRequest.cs:10/14/18` | roomSlotId, targetFormulaId, solutionCount | `/changeManufactureSolution`(:396) → `change` |
| `BuildingChangeShopRequest.cs:10/14/18/22` | roomSlotId, stockIndex, targetFormulaId, solutionCount | `/changeSaleSolution`(:407，202) → **缺 `change`** |
| `BuildingTradingChangeStrategyRequest.cs:12/17` | slotId, strategy:OrderType | `/changeStrategy`(:620) |
| `BuildingTradingDeliveryRequest.cs:10/14` | slotId, orderId:long | `/deliveryOrder`(:348) |
| `BuildingDeliveryBatchOrderRequest.cs:11` | slotList:List\<string\> | `/deliveryBatchOrder`(:356) → `delivered` |
| `BuildingTradingDeleteOrderRequest.cs:10/14` | slotId, orderId:long | `/deleteOrder`(:368，202) |
| `BuildingTradingLaborAccelRequest.cs:10/14/18` | slotId, orderId, cost | `/accelerateOrder`(:332，202) |
| `BuildingManufactLaborAccelRequest.cs:10/14` | slotId, cost | `/accelerateSolution`(:340，202)（**推测映射**，服务端 `logic/trading.ts:398` 按 workshop 方案加速实现） |
| `BuildingWorkshopSynthesisRequest.cs:10/14` | formulaId, times | `/workshopSynthesis`(:423) → `results` |
| `BuildingWorkshopDecompositionRequest.cs:10/14` | furniId, times | `/workshopDecomposition`(:434，202) → **缺 `results`** |
| `BuildingDIYChangeDIYSolutionRequest.cs:10/14` | roomSlotId, solution:PlayerBuildingDIYSolution | `/changeDiySolution`(:415) |

##### 2.5 会客室 / 线索 / 留言板 / 情报分享

| CS Request | 字段(:行) | 服务端路由 |
|---|---|---|
| `BuildingMeetingClueGetDailyClueRequest.cs:6` | 无 | `/getDailyClue`(:444，202) |
| `BuildingMeetingClueSendClueRequest.cs:10/14` | friendId, clueId | `/sendClue`(:452，202) |
| `BuildingMeetingClueAutoSendClueRequest.cs:6` | 无 | `/sendClueAuto`(:460，202) → **缺 `count`/`soptAdd`** |
| `BuildingMeetingClueReceiveClueToStockRequest.cs:11` | clues:List\<string\> | `/receiveClueToStock`(:468，202) |
| `BuildingMeetingCluePutClueToTheBoardRequest.cs:10` | clueId | `/putClueToTheBoard`(:476，202) |
| `BuildingMeetingClueAutoEquipCluesRequest.cs:6` | 无 | `/putClueToTheBoardAuto`(:484，202)（**推测映射**：服务端自注见 `models.ts:417`/`schemas.ts:276`，抓包仅证路径存在） |
| `BuildingMeetingClueTakeClueFromBoardRequest.cs:10` | type | `/takeClueFromBoard`(:652) |
| `BuildingMeetingClueDeleteOwnClueRequest.cs:10` | clueId | `/deleteOwnClue`(:492，202) |
| `BuildingMeetingClueDeleteReceiveClueRequest.cs:10` | clueId | `/deleteReceiveClue`(:500，202) |
| `BuildingMeetingClueUpdateWaitingClueRequest.cs:6` | 无 | `/getClueBox`(:508)（**已由抓包响应体确证**：`{"box":[…]}` 对应 `BuildingMeetingClueUpdateWaitingClueResponse.cs:57 box`） |
| `BuildingGetFriendSortListInfoRequest.cs:6` | 无 | `/getClueFriendList`(:519)（**推测映射**：抓包响应 `{"result":[]}` 对应 `BuildingGetFriendSortListInfoResponse.cs:12 result`） |
| `BuildingMeetingClueGetInfoShareVisitorsRequest.cs:6` | 无 | `/getInfoShareVisitorsNum`(:682) → `num` |
| `BuildingMeetingClueReceiveInfoShareRewardRequest.cs:6` | 无 | `/getInfoShareReward`(:530) → `list` |
| `BuildingMeetingClueStartInfoShareRequest.cs:6` | 无 | `/startInfoShare`(:745，202) |
| `BuildingMeetingClueGetMeetingRoomRewardRequest.cs:11` | type:List\<int\> | `/getMeetingroomReward`(:541) → `rewards` |
| `BuildingPayloadConfirmMessageBoardRewardRequest.cs:6` | 无 | `/confirmMessageBoardReward`(:660) → `reward` |
| `BuildingPayloadGetMessageBoardContentRequest.cs:6` | 无 | `/getMessageBoardContent`(:704) |
| `BuildingPayloadGetOthersMessageBoardContentRequest.cs:10` | uid | `/getOthersMessageBoardContent`(:714) |

响应自有字段（客户端绑定契约，服务端须照发）：`BuildingGainAllIntimacyResponse.cs:11/15` `normal`/`assist`；`BuildingSettleManufactResponse.cs:10` `supplement`；`BuildingChangeManufactResponse.cs:10` `change`；`BuildingChangeShopResponse.cs:10` `change`；`BuildingBuildRoomResponse.cs:11/15` `result`/`alert`；`BuildingUpgradeRoomResponse.cs:10` `result`；`BuildingUpgradeCompleteRoomResponse.cs:11/15` `result`/`alert`；`BuildingCleanRoomResponse.cs:10` `result`；`BuildingDegradeRoomResponse.cs:11` `payback`；`BuildingTradingLaborAccelResponse.cs:10` `result`；`BuildingSyncResponse.cs:10` `ts`；`BuildingDeliveryBatchOrderResponse.cs:11` `delivered`；`BuildingWorkshopSynthesisResponse.cs:11/15/19` `results`/`additional`/`recoverCost`；`BuildingWorkshopDecompositionResponse.cs:10` `results`；`BuildingMeetingClueGetMeetingRoomRewardResponse.cs:11` `rewards`；`BuildingMeetingClueGetInfoShareVisitorsResponse.cs:10` `num`；`BuildingMeetingClueAutoEquipCluesResponse.cs:10` `count`；`BuildingMeetingClueAutoSendClueResponse.cs:10/14` `count`/`soptAdd`；`BuildingMeetingClueUpdateWaitingClueResponse.cs:57` `box`；`BuildingMeetingClueReceiveInfoShareRewardResponse.cs:107` `list`；`BuildingGetFriendSortListInfoResponse.cs:12/16` `result`/`starFriendList`；`BuildingGetRecentVisitorsResponse.cs:14…38/49` `Visitor`/`visitors`；`BuildingAssistReportResponse.cs:11` `reports`；`BuildingPayloadConfirmMessageBoardRewardResponse.cs:11` `reward`；`BuildingDIYGetPresetThumbnailUrlResponse.cs:11` `url`；`BuildingGetFurnitureGoodListResponse.cs:11/15/23…196` `Good`/`Group`/`goods`/`groups`；`BuildingSendEmojiResponse.cs:10` `nextTs`；`BuildingBuyFurnitureGoodResponse.cs:11` `items`；`BuildingPayloadGetMessageBoardContentResponse.cs:162…178` `todayVisit`/`weeklyVisit`/`lastWeekVisit`/`lastWeekSpReward`/`lastShowTs`。

##### 2.6 预设队列 / 锁 / DIY 预设 / 缩略图 / 商店

| CS Request | 字段(:行) | 服务端路由 |
|---|---|---|
| `BuildingAddPresetQueueRequest.cs:10` | slotId | `/addPresetQueue`(:554) |
| `BuildingDeletePresetQueueRequest.cs:10/14` | slotId, index | `/deletePresetQueue`(:562) |
| `BuildingEditPresetQueueRequest.cs:7/11/15/19` | slotId, index, queue:List\<int\> | `/editPresetQueue`(:570) |
| `BuildingUsePresetQueueRequest.cs:10/14` | slotId, index | `/usePresetQueue`(:578) + `/useOnePresetQueue`(:586，202) |
| `BuildingSaveDormLockRequest.cs:7/11` | **仅 lockPos:Dictionary\<string,int[]\>** | `/editLockQueue`(:610)（**推测映射**：服务端 schema 含 `lockPos`） |
| `BuildingDIYRenamePresetSolutionRequest.cs:10/14` | solutionId, name | `/changePresetName`(:594，202) |
| `BuildingDIYSavePresetSolutionRequest.cs:10/14/18/22/26` | solutionId, roomType, name, solution, thumbnail | `/saveDiyPresetSolution`(:602，202) |
| `BuildingDIYGetPresetThumbnailUrlRequest.cs:11` | solutionId:List\<int\> | `/getThumbnailUrl`(:726) |
| `BuildingGetFurnitureGoodListRequest.cs:6` | 无 | **不在 building 域**：`shop/getFurniGoodList`（design-spec.md:1038；抓包 `module='shop'`） |
| `BuildingBuyFurnitureGoodRequest.cs:11/21/25/30` | CostType 枚举, goodId, buyCount, costType | **不在 building 域**：`shop/buyFurniGood` |

##### 2.7 访问 / 表情 / 报告

`BuildingGetRecentVisitorsRequest.cs:6` → `/getRecentVisitors`(:693)；`BuildingAssistReportRequest.cs:6` → `/getAssistReport`(:671)；`BuildingSendEmojiRequest.cs:10/14`(friendId, emoji) → `/sendEmoji`(:737，202)；`/visitBuilding`(:753，202) 无独立 `Building*Request`（推测对应 visit 模块的 `VisitBuildingRequest`）；`BuildingSaveDormLock` 见上表。

##### 2.8 高频调用判定

| 端点 | 判定 | 依据 |
|---|---|---|
| `/building/sync` | **确证最高频（定时器驱动）** | `BuildingServiceController.cs:183-226`（`CountDownTask.onTimeout = _SendSyncDataRequest`，:201）→ `:285-298` |
| `/building/assignChar` | 高频（每次换人一条，一房间一请求） | `BuildingServiceUtil.cs:335 SendAssignCharsService`；`:241 SendClearChars`（清人 `[-1]`）；design-spec.md:987 |
| `/building/batchChangeWorkChar` / `batchRestChar` | 界面操作触发（一键换班/休息） | `BuildingServiceUtil.cs:449/456`；服务端回推 `pushMessage`（`logic/chars.ts:528/568`） |
| `/building/gainAllIntimacy` | 一键领取触发（非轮询） | 调用点 `Torappu.Building.UI.Float/BuildingFloatToDoNotifyState.cs:520`（方法体 `_SendGainAllIntimacyService` 定义于 `:644`，请求构造 `:657`，回调 `:418`） |
| `/building/settleManufacture` / `settleSale` / `deliveryBatchOrder` | 收菜/交付时批量触发 | `BuildingServiceUtil.cs:174 SendSettleManufact`(:194 构请求)、`:224 SendSettleShop`、`:431 SendDeliveryBatchOrder` |
| 其余 | 交互触发 | 同文件逐项 Send\* 方法 |

---

#### 6.1.3 关键规则（可确证）

##### 3.1 制造站结算

- 速率：`logic/manufacture.ts:59` `room.processPoint += elapsed * (1 + speedBonus)`；阈值 `formula.costPoint`(:43)，产出 `Math.floor(processPoint / costPoint)`(:60)。**与客户端 `BuildingDataConverter.cs:1132 LoadManufactSpeed`（相位 speed=1）+ `basicSpeedBuff=0.01` 一致**。
- 计划耗尽即停：`manufacture.ts:54-55`（`remainSolutionCnt <= 0` 直接 return）；先按 remain 钳制再扣进度(:62-66)。
- 容量仅作显示：`manufacture.ts:45` `_roomCapacity` 回写 `room.capacity`；excel `manufactData.phases[].outputCapacity = 24/36/54`。
- 免费配方自动补货：`manufacture.ts:103-110`（`costs` 全为 0 且请求带 `supplement>0`）。
- 结算：`manufacture.ts:152-195` 查 `getManufactFormula`(:159)、产出 `count × outputSolutionCnt`(:163)、材料按 `costs` 扣减(:175-177)、`affordable` 不足时部分结算(:195)。

##### 3.2 贸易站订单

- 站级分布（客户端无此表，服务端取 `data/building/trade-order-dist.json`）：`trade-orders.ts:68-78` — warmup β≥1 → β 分布；α≥2 → 双 α；α=1 → α；否则按等级表（Lv1/Lv2/Lv3）。加权抽取 `trade-orders.ts:104-114`（`pickGoldCount`，注入 `roll` 便于测试）。
- 暖机档位由 buffId 后缀判定：`trade-orders.ts:118-122`（`trade_ord_wt&cost[00x]`=α、`[01x]`=β）；阈值 `warmupAlphaHours`/`warmupBetaHours`（3h/5h）。
- 周期时长按订单规模：`trade-orders.ts:90 goldOrderSeconds(count)`，缺表回退 12600；写入 `room._lastOrderSpanSec` 与 `next.maxPoint`（`logic/trading.ts:134-141`）。
- 进度：`logic/trading.ts:218-220` `effSpeed = max(0.01, 1 + bonus)`、`next.processPoint += elapsed × effSpeed`；多笔批量结算用 `while`(:224-236)。
- 特殊订单：开采协力 O_DIAMOND（`trading.ts:63-72`，源石碎片 3141×2 → 合成玉 4003×20）、佩佩独占（:74-84，gain = rate×2）、可露希尔（:86-96，rate×3）、违约/龙舌兰（:104-112）。
- 贸易 buff 回写：`room.buff.speed = bonus`、`room.buff.limit = stockLimit`(:204-207)；订单对象 `buff: []` 恒空(:69/80/92/118)。

##### 3.3 心情 / 体力

- 单位：`mood.ts:17 MAX_AP = 8640000`（24 点 × 360000），1 点/时 = 100 raw AP/秒（`mood.ts:12-13` 注释 + `_recomputeCharScales` 用 `×100`）。
- 档位重算 `logic/chars.ts:218-328`：未进驻 0(:292)、宿舍 = 基础+氛围+技能+控制中枢(:278-282)、工作房间 = 基础消耗 − 技能附加消耗(:294-297)；**头数减免** `+= headcountMoodRelief()×100`(:320-322，`mood.ts:34-38` 2 人 0.05 / 3 人 0.1)；控制中枢特例 `control_mp_cost_double`(:304-311)/`control_mp_cost_reset`(:312-315)。
- 累积：`logic/accrue.ts:826-833` `ap = clamp(ap + 时间 × changeScale, 0, 8640000)`，更新 `lastApAddTime`（`changeScale` 读取于 `:828`）。
- 宿舍恢复公式：基础 `(1.5+0.1×等级) + 氛围×0.0004`（**`logic/chars.ts:188-195`，公式在 `:194`**）+ 控制中枢全局 + 技能按作用域分发（all/self/single/shared）——分发与合并见 `logic/chars.ts:229-283`（`_dormBaseRecoveryPerHour` 调用点 `:236`）。
- 涣散：`mood.ts:24-26 isDispersedAp`（ap ≤ 0），宿舍语境豁免（`chars.ts:248-250 allowDispersed`）。
- 注意力涣散与技能失效的耦合见 §4-D6（已实现）。

##### 3.4 会客室线索

- 基准 20h：`clue-speed.ts:14 CLUE_BASE_SECONDS = 72000`；自有库上限 `clue-speed.ts:20 OWN_CLUE_LIMIT = 10`（= excel `inventoryLimit`，但**硬编码而非读表**）。
- 每日一条：`logic/meeting.ts:84-123` — `dailyReward` 已领不重发(:87)、满库不入库(:97)、`id = uid#random(1000-9999)#now`(:101)、`type` 阵营加权(:102，`_clueFactionWeighted` 定义于 :47-78)、`number = 1+random(0..2)`(:103)、`ts = now + expiredDays×86400`(:112)、发 `outputBasicBonus` 信用(:117-119)、`pushFlags.hasClues=1`(:121)。
- 阵营加权：晓歌 `meet_spd_notOwned` 未上板 ×2、U-Official `meet_spd_Owned` 已上板 ×2（:57-73）。
- 板 = `{阵营: clueId}` + 线索保留在库存 `inUse=1`（`meeting.ts:239-241`）；取回删板项并复位 `inUse=0`(:284-288)。
- 红点：存在 `inUse=0` 线索 → `hasClues=1`（:355-363）。
- 会客室进度按速度累积：`logic/accrue.ts:506-…`（相位 `gatheringSpeed` + 全宿舍氛围档 + 干员稀有度/精英/非涣散 + `meet_*`，:511-541；**未进驻不产出** :516）。
- 信用来源：领奖 `logic/meeting.ts:591-610`（`socialPoint += daily+search`，清零并 `_refreshInfoShare`，返回 `rewards:[{id:"SOCIAL_PT"}]`）；传递 +`transferBonus`(:153/178)；回收 +`recycleBonus`(:314)；接收 +`getClueReceiveBonus(index)`(:206)；访客 `visitorBonus` 封顶 `visitorBonusLimit`（`logic/accrue.ts:284-297`）。

##### 3.5 训练室 / 专精

- 训练累积：`logic/accrue.ts:772-802` — 仅 `trainee.state===1` 推进(:777)，教官 `train_*` 加速(roomSpeedBonus，:783)，达阈值置 `state=2`（OUTOFDATE 待领取，:802）。
- 开始专精：`logic/construction.ts:461-528` — 技能 `state=0` 重置(:461)、训练槽互斥判定(:476)、`skill.state=1`(:508)、`room.trainee.state=1`(:521)、`room.trainer.state=1`(:528)。
- 完成：`construction.ts:559-561/604-616` 置 `trainee/trainer.state=3`（WAITING）；`completeUpgradeSpecialization` 提升专精等级后复位。
- 门控（精英 2 / 技能 7 / 专精≤3 且≤训练室等级 / 材料足额 / `maxPoint = lvlUpTime`）见 design-spec.md:1192-1193。

##### 3.6 建造 / 电力 / 解锁

- 建造前置解锁：`construction.ts:98-99`（`getRoomUnlockCondId(roomId,1)` → `_roomUnlockSatisfied`，:187-200 读 `roomUnlockConds[condId]`）；升级同级校验 `:289-292`。
- 槽位状态机：建造中 `state=1`(:108)、升级中 `state=1`(:301)、完成后 `state=2`(:319/349)。
- 电力余额：`logic.ts:330 _powerBalance` → `construction.ts`；电量增量校验由 `BuildingDataConverter.cs:1252/1283` 对应（design-spec.md:1050-1054：满配余额 0，不足拒绝）。
- 配方解锁：`unlocks.ts`（`requireRooms` 曾达等级+房间数、`requireStages` 关卡星，:30-61）；曾达等级存 `building.maxLevelReached`（`construction.ts:305 _touchMaxLevel`）。
- 材料/金币扣减：`construction.ts _canAffordCosts`/`_applyCosts`/`_applyItemDelta`/`_applyGoldDelta`（`logic.ts:317-372` 委派）。

##### 3.7 加工站

- `logic/manufacture.ts:330-…`: 查 `getWorkshopFormula`(:348)、`goldCost × times`(:355)、`costs` 按次扣(:358)、进驻干员心情扣 `apCost × times`(:372 起)、`ws_bonus` 逐次推进（design-spec.md:1061-1065）、`extraOutcomeRate` 加权副产物。

##### 3.8 劳动力与宿舍锁定

- 劳动力恢复：`laborRecoverTime = 360` 秒/点（`data/excel/building_data.json`；服务端 `logic.ts:164 _recoverLabor`）。
- `buyLabor`：`logic/trading.ts:649-681` — 中枢等级 ≥ `apToLaborUnlockLevel(4)` 时理智兑换（`:664-671`，`apCost = ceil(buyCount/apToLaborRatio)`，1 AP→2 劳动力），否则走源石兼容路径（`:672-676`，1 源石→10 劳动力）；对齐 design-spec.md:1212。
- **宿舍锁定**：客户端状态字段 `PlayerBuildingDormitory.lockQueue`(:72) + `BuildingCharModel.isDormLock`(:66)；服务端**无任何 `lockQueue`/`isDormLock` 写入**（`grep -rn 'lockQueue|isDormLock' app/game/modules/building/` 0 命中）→ 见 §4-D1。

---

#### 6.1.4 与服务端实现的差异比对

> 分类：已实现 / 部分实现 / 缺失 / stub / 行为不一致。P0 = 官方客户端请求必失败或状态必错；P1 = 功能可见失效；P2 = 表现/完整性缺陷。

**D1【P0】宿舍锁定端点 schema 与 CS 类不符，且未写 `lockQueue`/`isDormLock` —— 行为不一致 + 功能缺失**
- 客户端证据：`BuildingSaveDormLockRequest.cs:7/11` **只有** `lockPos: Dictionary<string,int[]>`；发送器 `Torappu.Building/BuildingServiceUtil.cs:523 SendDormLockRequest(Dictionary<string,int[]> lockData, …)`；状态侧 `PlayerBuildingDormitory.cs:72 lockQueue: int[]`、`BuildingCharModel.cs:66 isDormLock`（UI 用于床位锁标记：`Torappu.Building.UI/BuildingUIFloatStationItem.cs:290-297`、`BuildingUIFloatStationView.cs:145-152`）。
- 服务端证据：`app/game/modules/building/schemas.ts:373-377` 要求 `roomSlotId: z.string()` + `locked: z.boolean()`（`lockPos` 标 `.optional()` 且自注"服务端不读"，`schemas.ts:371`）；`models.ts:627-630` 同注；`logic/misc.ts:234-241` 只把 `presetQueues[slotId].locked = args.locked`。
- 判定：官方客户端发 `{lockPos:{…}}` → 缺 `roomSlotId`/`locked` → 422 拒绝（服务端错误消息形态见 `tmp/capture/index.db` 记录 `/building/editLockQueue`，3 条 422 `expected string, received undefined field "roomSlotId"`，虽为空探针但证明该校验分支在链路上）；即便通过也只写预设队列元数据，`dorm.lockQueue` / `chars[].isDormLock` 永不变化 → 宿舍锁定 UI 完全无效。
- 注：`/editLockQueue` ↔ `BuildingSaveDormLockRequest` 为**推测**映射（依据是服务端 schema 自身使用了 `lockPos` 这个 CS 独有字段名）；但两种可能映射下（另一候选为预设队列锁）该 schema 与 CS 均不匹配。

**D2【P0】`/building/upgradeSpecialization`、`/building/completeUpgradeSpecialization` 请求字段与 CS 不符 —— 请求必失败**
- 客户端证据：`Torappu/UpgradeSpecializationRequest.cs:10/14/18` = `charInstId` / `skillIndex` / `targetLevel`（**无 `targetSkill`**）；`Torappu/CompleteUpgradeSpecializationRequest.cs:6` = `: BuildingRequest`，**无任何字段**；同族 `Torappu/UpdateSpecializationRequest.cs:10` 仅有 `skillIndex`。（2.7.71 全量签名里带 "Specialization" 的请求类只有这 3 个：`reference/com.hypergryph.arknights_2.7.71.cs:54373 UpdateSpecializationRequest`、`:54390 CompleteUpgradeSpecializationRequest`、`:55474 UpgradeSpecializationRequest`。）
- 服务端证据：`schemas.ts:68-73` 要求 `charInstId` + **`targetSkill`（必填）**；`schemas.ts:76-79` 要求 `charInstId` + `targetSkill`；`models.ts:102-107` 注释也写 `targetSkill`。
- 对照：同一功能的 charBuild 侧 schema 用的是**正确** CS 字段名 —— `app/game/modules/character/charBuild.schema.ts:69-73`（charInstId/skillIndex/targetLevel）与 `:76-80`，路由 `character/routes.ts:158/172`。→ 仓内同一功能两套字段名，building 侧那套错。
- 判定：官方客户端无论发 `{charInstId,skillIndex,targetLevel}`（Upgrade）还是 `{}`（Complete），building 侧都会被 zod 拒绝（抓包库 `/building/upgradeSpecialization`、`/building/completeUpgradeSpecialization` 各 3 条 422 `expected number, received undefined field "charInstId"`）。**训练室「开始专精/领取专精」链路在 building 命名空间下不可用**（charBuild 路径可用，取决于客户端实际调用哪个）。
- 附带缺失：`UpdateSpecializationRequest{skillIndex}`（`:54373`）在服务端 **无任何路由**（抓包 61 条路径中亦无 `/building/updateSpecialization`）——缺失端点（推测该端点真实存在，需抓包复核）。

**D3【P1】`/changeSaleSolution` 不返回 `change`，客户端不刷新 —— 行为不一致**
- 客户端证据：`Torappu/BuildingChangeShopResponse.cs:10 public bool change;`；同族 `BuildingChangeManufactResponse.cs:10` 亦有 `change`。
- 服务端证据：`/changeManufactureSolution` 正确回填 —— `handler.ts:399-404`（`const { change } = …; res.send({ change, ...player.delta })`）；`/changeSaleSolution` 只发增量 —— `handler.ts:407-412`（`res.status(202).send(player.delta …)`），`logic/trading.ts:601-629` 也确实计算并丢弃了结果（无返回值）。
- 抓包旁证：`tmp/capture/index.db` 中 `/building/changeSaleSolution` 响应体仅 `{"playerDataDelta":{"modified":{},"deleted":{}}}`（空探针下无 `change` 字段）。

**D4【P1】降级不返还材料 —— 缺失**
- 客户端证据：`Torappu/BuildingDegradeRoomResponse.cs:11 public List<ItemBundle> payback;`。
- 服务端证据：`handler.ts:231-236` 仅 `res.send(player.delta)`；`logic/construction.ts:345 degradeRoom` 只改等级，未构造任何返还。
- 交叉口径：`docs/module-audit-2026-08-29.md:20` 已把"房间降级不返还材料"列为 building 缺口。

**D5【P1】`/workshopDecomposition` 不返回 `results`；`/workshopSynthesis` 缺 `additional`/`recoverCost` —— 部分实现**
- 客户端证据：`BuildingWorkshopDecompositionResponse.cs:10 results: ItemBundle`；`BuildingWorkshopSynthesisResponse.cs:11/15/19` = `results` / `additional: List<ItemBundle>` / `recoverCost: long`。
- 服务端证据：`handler.ts:434-439` 只发 202 + 增量（`res.status(202).send(player.delta …)`）；`handler.ts:427-430` 只发 `results`（`logic/manufacture.ts:330 workshopSynthesis` 也不产出 `additional`/`recoverCost`）。
- 抓包旁证：`/building/workshopDecomposition` 响应仅 `playerDataDelta` 空对象。

**D6【P2】建造/升级/清理类响应缺 `result` 与 `alert` —— 部分实现**
- 客户端证据：`BuildingBuildRoomResponse.cs:11/15` `result:int` + `alert:List<ServiceAlertStruct>`（且 `:7` 实现 `IAlertResponse`）；`BuildingUpgradeRoomResponse.cs:10 result`；`BuildingUpgradeCompleteRoomResponse.cs:11/15 result` + `alert`（`:7 IAlertResponse`）；`BuildingCleanRoomResponse.cs:10 result`。
- 服务端证据：`handler.ts:207-236, 636-649` 全部只发 `player.delta`；且 `logic/construction.ts:99/292` 以 `return;` **静默**放弃非法建造/升级（不落任何 delta、不返回业务码）→ 客户端只能看到空 delta，无法区分"资源不足/电力不足/解锁未达成"。（`logic/construction.ts:637-643 cleanRoomSlot` 只把 `charInstIds` 全置 -1，未回 `result`。）

**D7【P2】贸易订单加成标签恒空 —— 部分实现**
- 客户端证据：`PlayerBuildingTradingOrder.cs:61 buff: TradingOrderBuff[]`（`{from,param}`，:16/:20）、`:70 specGoldTag: TradingGoldTag`（`{activated,from}`，:35/:39）。
- 服务端证据：`logic/trading.ts:69/80/92/118` 生成的每笔订单都写 `buff: []`，且从不设置 `specGoldTag`/`extraCost`；`_genTradingOrder` 内部虽通过 `hasBuff(/^trade_ord_…/)` 读取技能，但只用于数值与 `special` 扩展字段，不回写标签。

**D8【P2】DIY 预设缩略图 stub 且字段名写错 —— stub + 行为不一致**
- 客户端证据：`BuildingDIYGetPresetThumbnailUrlResponse.cs:11 public List<string> url;`；请求 `BuildingDIYGetPresetThumbnailUrlRequest.cs:11 solutionId:List<int>`。
- 服务端证据：`logic/misc.ts:491-493 getThumbnailUrl` 返回 `{ list: [] }`；`models.ts:776-779` 把响应字段也定义成 `list`（**CS 为 `url`**）→ 即使将来补数据也无法绑定。design-spec.md:1023 已记为"返回空列表（私服无云端缩略图）"。

**D9【P2】好友排序列表/`starFriendList` 未实现 —— 部分实现**
- 客户端证据：`BuildingGetFriendSortListInfoResponse.cs:12 result: List<FriendSortViewModel>`、`:16 starFriendList: List<string>`。
- 服务端证据：`logic/meeting.ts:483-512 getClueFriendList` 只返回 `{result:[{uid,nickName,nickNumber,level}]}`，**无 `starFriendList`**；且抓包响应 `{"result":[]}`（`tmp/capture/index.db` `/building/getClueFriendList`）说明实际为空。另注：`/getClueFriendList` ↔ `BuildingGetFriendSortListInfoRequest` 为**推测**映射（依据仅响应字段 `result` 同名）。

**D10【P2】表情/最近访客/信息共享等社交端点弱实现 —— stub/部分实现**
- `sendEmoji`：`logic/misc.ts:500-502` 纯透传（返回请求体且不落状态），`handler.ts:737-742` 返回 202 + 增量 → 客户端 `BuildingSendEmojiResponse.cs:10 nextTs`（冷却时间戳）永不变化 → 表情冷却 UI 失效。
- `getRecentVisitors`：`logic/misc.ts:372-…` 用好友列表伪造访客（无真实访问记录）；`getInfoShareVisitorsNum`：`:349-362` 返回好友数。→ 与 design-spec.md:1021 的"已改真实好友数据"一致，但语义仍是替代实现。
- 助战满信赖推送：客户端有 `Torappu.Building.UI/BuildingAssistFullFavorGetTrigger.cs:18`（消费 `BuildingAssistFullFavorPushMsg`），服务端只推 `buildingBatchChangeWorkChar`/`buildingBatchRestChar`（`logic/chars.ts:528/568`），**无 AssistFullFavor 推送**（推送名字符串在客户端不可反编译层，映射为**推测**）。

**D11【P2】守卫盲区：16/65 条 building POST 路由绕过 `validateBody`**
- 服务端证据（`handler.ts`，实测脚本统计 65 条 POST 中 16 条无校验）：`:207 /buildRoom`、`:301 /gainAllIntimacy`、`:322 /confirmPrivateDormIntimacy`、`:340 /accelerateSolution`、`:356 /deliveryBatchOrder`、`:368 /deleteOrder`、`:388 /settleSale`、`:396 /changeManufactureSolution`、`:415 /changeDiySolution`、`:468 /receiveClueToStock`、`:530 /getInfoShareReward`、`:602 /saveDiyPresetSolution`、`:652 /takeClueFromBoard`、`:704 /getMessageBoardContent`、`:726 /getThumbnailUrl`、`:737 /sendEmoji`（对照 `:149 /sync` 等 49 条有校验）。
- 守卫为何不报错：`tests/unit/architecture/schema-first-guard.test.ts:15-21` 的路由面正则只覆盖 `routes.ts` / `*.routes.ts` / `plugin-heartbeat.ts`，**明确排除 `handler.ts`**（同文件 :18-20 注释自述此豁免）。

**D12【P2】excel 数据字段未被使用 —— 部分实现**
- `tradingData.phases[].orderSpeed`(均为 1) / `orderRarity`(1/2/3)：服务端 `logic/trading.ts:189-238` 只用 `basicSpeedBuff` 与硬编码概率表；订单时长走 `data/building/trade-order-dist.json`（`trade-orders.ts:90 goldOrderSeconds`），`orderRarity` 未参与（因只生成 O_GOLD 固定订单）。`orderLimit(6/8/10)` 与存档 `room.stockLimit` 的关系亦未被校验（`trading.ts:223` 直接用存档值）。
- `clue_data.inventoryLimit`：`clue-speed.ts:20` 硬编码 `OWN_CLUE_LIMIT=10`，未走 `getClueConstant("inventoryLimit")`（值相同，属可维护性缺陷）。
- 客户端遗留换算 `BuildingDataConverter.cs:1344 GetOutputCountFromItemInShop`（`shopOutputRatio`）/`:1363 GetCardCountInShop`（`shopStackRatio`）：这两个表在 `data/excel/building_data.json` 中**不存在**，且 `rooms` 无 SHOP 实例 → 判定为不可达遗留代码，服务端无需实现。

---

#### 6.1.5 服务端实现概况（供总装引用）

| 文件 | 行数 | 职责 |
|---|---|---|
| `handler.ts` | 759 | 65 条 `/building/*` 路由（`app/game/routes.ts:92` 挂载） |
| `logic.ts` | 963 | `BuildingManager`(:62) 组合根 + 全量薄委派 |
| `models.ts` / `schemas.ts` | 808 / 428 | 契约类型 / zod 校验 |
| `logic/accrue.ts` | 932 | 时间推进：`sync`/`advance`、劳动力、心情、暖机、信赖、训练、会客、人力、时间戳统一 |
| `logic/chars.ts` | 755 | 进驻/换班/清房/信赖/心情档位重算 |
| `logic/manufacture.ts` | 565 | 制造累积与结算、DIY 方案舒适度、加工合成/分解 |
| `logic/trading.ts` | 681 | 订单生成/交付/删除/策略/加速/买劳动力 |
| `logic/meeting.ts` | 610 | 线索全流程、留言板、情报分享、好友列表 |
| `logic/misc.ts` | 566 | 预设队列、锁、表情、访问、留言板内容、缩略图 |
| `logic/construction.ts` | 641 | 建造/升级/降级/专精/DIY 等级、电力与解锁校验 |
| `buff.ts` / `buff-parse.ts` / `buff-tpl.ts` | 215 / 171 / 58 | buff 激活（`buff.ts:73-104`，cond.level/phase :90-91）、房速/全局/宿舍/心情、富文本数值解析 |
| `buffs/` | 5 文件 | `ControlGlobalTpl`/`DormRecoveryTpl`/`MoodCostTpl`/`RoomSpeedTpl` + `buffTplFor`(:39) |
| `mood.ts` / `trade-orders.ts` / `clue-speed.ts` / `dorm-special.ts` / `unlocks.ts` / `mastery.ts` / `hire-contacts.ts` / `special.ts` | 46 / 122 / 76 / 86 / 75 / 72 / 38 / 205 | 纯函数引擎（2026-08-25 全量对齐官服） |

---

#### 6.1.6 参考清单（本稿引用的关键文件）

- 客户端状态：`Torappu/PlayerBuilding*.cs`（40 个，最大 `PlayerBuildingWorkshopBuff.cs` 170 行）、`Torappu/BuildingData.cs`(2761)、`Torappu/BuildingDB.cs`(526)、`Torappu/BuildingBuffUtil.cs`(202)、`Torappu/BuildingRoomInfoModel.cs`(102)
- 客户端脚手架：`Torappu.Building/BuildingServiceController.cs`(306)、`BuildingServiceUtil.cs`(527)、`BuildingCharModel.cs`(399)、`BuildingDataConverter.cs`(含 `LoadStationedChars:427`、`ConvertPlayerRoomSlotState:325`)、`Torappu.Building.BP/*`、`Torappu.Building.Vault/*`、`Torappu.Building.DIY/*`、`Torappu.Building.UI*/`
- 枚举真值：`reference/com.hypergryph.arknights_2.7.71.cs`（`:65910/:66125/:66137/:949268/:949279/:54373/:54390/:55474/:91994`）
- 服务端：`app/game/modules/building/*`（§5）、`app/game/excel/building_excel.ts`、`data/excel/building_data.json`、`data/excel/clue_data.json`、`data/building/trade-order-dist.json`
- 既有口径：`docs/module-audit-2026-08-29.md:20,51,61`、`design-spec.md:939-1231`

---

### 6.2 肉鸽（Roguelike）

> **取证口径**：客户端 = `reference/arknights-2.7.71-csharp/Assembly-CSharp/`（下文缩写 `CS/`）；服务端 = `app/game/modules/roguelike/`（37,783 行）。全部行号经 `read`/`grep -n` 核对，标注【推测】者为无直接代码/抓包佐证。
> **重要限制**：本客户端为 IL2CPP + Cpp2IL 反编译，**网络发送方法体大量不可恢复**（如 `CS/Torappu.UI.Roguelike/RoguelikeChoiceState.cs:574` `_SendSelectChoiceRequest` 直接 `throw new AnalysisFailedException("CPP2IL failed to recover any usable IL")`）。故「客户端调哪个端点」以**路由常量字符串**为准，而非方法体；端点名不可由 Request 类名硬推。
> 服务端代码中不存在 `RL0x` 字面量，主题一律用 `rogue_N`（`theme-rules.ts:15`）。

---

#### 6.2.1 客户端数据模型与玩法骨架

##### 1.1 状态根对象与 delta 键

| 事实 | 证据 |
|---|---|
| 玩家数据里肉鸽有**两个**根字段：v1 `roguelike`、v2 `rlv2` | `CS/Torappu/PlayerDataModel.cs:158` `public PlayerRoguelike roguelike;`；`:162` `public PlayerRoguelikeV2 rlv2;` |
| v2 统一在 `playerDataDelta` 的 `rlv2` 键下同步（客户端全局读取） | `CS/Torappu.UI.Roguelike/RoguelikeDungeonController.cs:1333` `...data.rlv2.current`；`CS/Torappu.UI.Roguelike/RoguelikeUtil.cs:738`、`:1323`（读 `data.rlv2.outer`）——`CS/Torappu.UI.Roguelike/` 内 `rlv2` 字样共 **149 处**（`grep rlv2` 命中数），绝大多数是 `Singleton<PlayerData>.instance.data.rlv2.*` 读取 |
| 局内状态 `rlv2.current.player.*` | `RoguelikeDungeonPage.cs:486`、`RoguelikePendingCommonCompDialogState.cs:183` |

`PlayerRoguelikeV2`（`CS/Torappu/PlayerRoguelikeV2.cs`，2239 行）结构锚点：

| 层级 | 字段 | 行号 |
|---|---|---|
| `PlayerRoguelikeV2.CurrentData` | `state` / `property` / `cursor` / `pending` / `trace` / `status` / `toEnding` / `chgEnding` / `innerMission` / `nodeMission` / `zoneReward` / `traderReturn` | :231 / :235 / :239 / :243 / :247 / :251 / :255 / :259 / :263 / :267 / :271 / :275 |
| `PlayerStatus.Properties` | `exp`:57 / `level`:61 / `maxLevel`:65 / `hp{current,max}`:21-29 / `shield`:73 / `gold`:77 / `capacity`:81 / `population{cost,max}`:33-41 / `conPerfectBattle`:89 | 见左列 |
| `PlayerStatus.Status` | `bankPut`:139 | :139 |
| `PlayerStatus.NodeMission` | `id`:186 / `state`:190 / `tip`:194 / `progress`:198 | 见左列 |
| `PlayerStatus.ZoneRewardItem` | `id`/`count`/`instId` | :212 / :216 / :220 |
| `PlayerStatus.NodePosition` | `zone`:121 / `position:RoguelikeNodePosition`:125 | 见左列 |

节点坐标类 `CS/Torappu/RoguelikeNodePosition.cs:10,14` → `x` / `y`。

`PlayerRoguelikeV2` 的**顶层三分**（`:2224` `current` / `:2228` `outer:Dictionary<string,OuterData>` / `:2232` `pinned:string`）：`current` = 本局局内状态，`outer[theme]` = 跨局持久化（record/bank/buff/collect/…），`pinned` = 置顶主题。服务端 `settle.ts:476-608` 写 `draft.outer[theme]`；`logic.ts` 的 `_settled` 机制让 `current` 在结算后输出全空。

##### 1.2 局内阶段状态机（客户端枚举）

`CS/Torappu/PlayerRoguelikePlayerState.cs:9-19`：`NONE`(:12) / `INIT`(:14) / `PENDING`(:16) / `WAIT_MOVE`(:18) —— 与服端 `logic.ts` 里 `this._status.state = "WAIT_MOVE" | "PENDING"` 直接对应（如 `logic.ts:743`、`:585`）。客户端据此判分支：`CS/Torappu.UI.Roguelike/RoguelikeDungeonTransitionPendingChecker.cs:122`（`== PENDING`）、`RoguelikeDungeonController.cs:1660`（`== INIT`）。

对局模式枚举 `CS/Torappu/RoguelikeTopicMode.cs:12-24`：`NONE` / `EASY` / `NORMAL` / `HARD` / `NORML_END` / `MONTH_TEAM` / `CHALLENGE`。

##### 1.3 主题（topic）与「模块」体系 ★

`CS/Torappu/RoguelikeModuleType.cs:9-43` 是**官方模块全集**（16 值，含 2 个服务端未实现的枚举名）：

```
NONE:12 SANCHECK:14 DICE:16 CHAOS:18 TOTEMBUFF:20 VISION:22 FRAGMENT:24 DISASTER:26
NODE_UPGRADE:28 COPPER:30 WRATH:32 CANDLE:34 SKY:36 GRID_ZONE:38 WEATHER:40 SCRAP:42
```

各主题挂载的模块（数据侧，`data/excel/roguelike_topic_table.json` → `modules.<theme>.moduleTypes`，服务端在 `module.ts:60` 读取）：

| 主题 | moduleTypes |
|---|---|
| rogue_1 | `[]` |
| rogue_2 | `SANCHECK, DICE` |
| rogue_3 | `CHAOS, TOTEMBUFF, VISION` |
| rogue_4 | `FRAGMENT, DISASTER, NODE_UPGRADE` |
| rogue_5 | `COPPER, WRATH, CANDLE, SKY` |
| rogue_6 | `GRID_ZONE, WEATHER, SCRAP` |

模块数据类（客户端 `CS/Torappu/Roguelike*ModuleData.cs`）关键字段：

| 模块 | 类:行 | 关键字段 |
|---|---|---|
| DICE | `RoguelikeDiceModuleData.cs:7` | `dice`:11 / `diceEvents`:15 / `diceChoices`:19 / **`diceRuleGroups`:23** / `dicePredefines`:27 |
| FRAGMENT | `RoguelikeFragmentModuleData.cs:7` | `fragmentData`:11 / `fragmentTypeData`:15 / `fragmentBuffData`:23 / `alchemyData`:27 / `alchemyFormulaData`:31 / `fragmentLevelData`:35 |
| CHAOS | `RoguelikeChaosModuleData.cs:8` | `chaosDatas`:12 / `chaosRanges`:16 / `levelInfoDict`:20 |
| DISASTER | `RoguelikeDisasterModuleData.cs:7` | `disasterData`:11 |
| NODE_UPGRADE | `RoguelikeNodeUpgradeModuleData.cs:7` | `nodeUpgradeDataMap`:11 |
| COPPER | `RoguelikeCopperModuleData.cs:7` | `copperData`:11 / **`copperDivineData`:15** / `copperGildTypeData`:19 / `changeCopperMap`:23 / `moduleConsts`:27 |
| CANDLE | `RoguelikeCandleModuleData.cs:7` | `candleTicketIdList`:11 / `moduleConsts`:15 / `candleBattleStageIdList`:19 |
| GRID_ZONE | `RoguelikeGridZoneModuleData.cs:7` | `zoneMissionBannerData`:11 / `scrapSideBarStepZeroHintBannerData`:15 / `buoyItemDatas`:19 |

##### 1.4 一局骨架（开局 → 层/节点 → 事件/战斗/商店 → 掉落升级 → 结算）

**开局**：客户端请求 `POST /rlv2/createGame`（常量 `CS/Torappu.UI.RoguelikeTopic/RoguelikeTopicService.cs:9`），body 字段（`RoguelikeTopicCreateGameRequest.cs:10,14,18,22,26`）：`theme` / `mode:RoguelikeTopicMode` / `modeGrade:int` / `predefinedId` / `activityId`。服务端 `handler.ts:196` → `logic.ts:1234` → `game-init.ts:109`（真实写 game/buff/record/map/troop）。
其后依次：选初始遗物 `POST /rlv2/chooseInitialRelic`（`handler.ts:219`，body `select`，`RoguelikeSelectInitialRelicRequest.cs:10`）、选初始招募组合 `chooseInitialRecruitSet`（`handler.ts:229`，`select`，`RoguelikeSelectInitialRecruitSetRequest.cs:10`）、选初始探索工具 `chooseInitialExploreTool`（`handler.ts:240`）。

**层与节点推进**：
- 标准主题：`POST /rlv2/moveTo`（body `to:RoguelikeNodePosition{x,y}`，`CS/Torappu/RoguelikeMoveToRequest.cs:10` + `RoguelikeNodePosition.cs:10,14`）。
- 黑流树海（rogue_6）：**唯一移动入口是网格** `POST /rlv2/gridZone/moveTo`（`CS/Torappu.UI.Roguelike/RL06Service.cs:15` `STEP_MOVE_TO`），body `route:List<string>`（`RoguelikeStepMoveToRequest.cs:11`）；对应 `RL06Service.cs:18` `STEP_MOVE_AND_BATTLE_START` / `:12` `emptyStep` / `:24` `readStepZero`。
- 节点类型是**位标志枚举** `CS/Torappu/RoguelikeEventType.cs:9-79`：`BATTLE_NORMAL=1`(:14) `BATTLE_ELITE=2`(:16) `BATTLE_BOSS=4`(:18) `SHOP=8`(:20) `REST=16`(:22) `INCIDENT=32`(:24) `TREASURE=64`(:26) `ENTERTAINMENT=128`(:28) `UNKNOWN=256`(:30) `WISH=512`(:32) `SACRIFICE=1024`(:34) `EXPEDITION=2048`(:36) `BATTLE_SHOP=4096`(:38) `PORTAL=8192`(:40) `MISSION=16384`(:42) `STORY=32768`(:44) `STORY_HIDDEN=65536`(:46) `ALCHEMY=131072`(:48) `DUEL=262144`(:50) `STASHED_RECRUIT=524288`(:52) `SPECIAL_ZONE=1048576`(:54) `SCRAP_SHOP=2097152`(:56) `DOOR=4194304`(:58) `FINAL=8388608`(:60) `EVACUATE=16777216`(:62) `EMPLOY=33554432`(:64) `LIGHT=67108864`(:66) `BATTLE_SAVAGE=134217728`(:68) `EMPTY=268435456`(:70)，聚合掩码 `BATTLES=134217735`(:72) / `CHOICES=27127536`(:74) / `EVENTS=402521848`(:76) / `ALL=536739583`(:78)。
  服务端 `theme-rules.ts:39-82` 的 `ROGUE6_NODE` 21 项与上表**逐值吻合**（如 `MIRAGE:8192` vs `PORTAL=8192`、`RESIDENT:134217728` vs `BATTLE_SAVAGE`、`VISIBLE_PATH:16777216` vs `EVACUATE`）。

**事件 / 战斗 / 商店**：选择 `POST /rlv2/selectChoice`（body `choice:string`，`CS/Torappu/RoguelikeSelectChoiceRequest.cs:10`）→ 服务端 `handler.ts:313` → `event.ts:402`；战斗走 `POST /rlv2/battleFinish`（`CS/Torappu.UI.Roguelike/RoguelikeSquadState.cs:1354` `new RoguelikeFinishBattleServiceConfig("/rlv2/battleFinish")`）+ `POST /rlv2/finishBattleReward` / `chooseBattleReward`；商店 `POST /rlv2/shopAction`（body `buy:List<string>` / `recycle:List<string>` / `leave:int`，`CS/Torappu/RoguelikeShopActionRequest.cs:11,15,19`）+ `shopRefresh` + `shopBattleStart`。

**掉落与升级**：`POST /rlv2/upgradeNode`（body `nodeType:RoguelikeEventType`，`CS/Torappu/RoguelikeUpgradeNodeRequest.cs:10`）、`rerollNode`（`nodeIndex:string`，`RoguelikeRollNodeRequest.cs:10`）、`sacrificeChoice`（`choice`/`leave`，`RoguelikeSacrificeRequest.cs:10,14`）、模块专属：`RL03Service.cs:9` `useTotem`、`RL04Service.cs:18` `alchemy`、`RL05Service.cs:12` `copper/change`、`RL06Service.cs:21,27` `scrap/loseScrap`、`scrap/identify`。

**结算**：`POST /rlv2/gameSettle`（`RoguelikeTopicService.cs:21`），响应除 `playerDataDelta` 外还有 `game` / `outer` 两个聚合块（`CS/Torappu.UI.RoguelikeTopic/RoguelikeTopicGameSettleResponse.cs:10,14`）；服务端 `handler.ts:204` → `settle.ts:451` / `buildSettleResponse:670`。结局：`current.toEnding`（`PlayerRoguelikeV2.cs:255`）/ `chgEnding`(:259)；客户端读 `data.rlv2.outer` 渲染结局（`CS/Torappu.UI.Roguelike/RoguelikeClassicEndingController.cs:780`）。

**存档与查询**：v2 **没有独立 sync 端点**——所有响应都是 `PlayerDeltaResponse`（见 §2.1），续局靠 `createGame`/`continue` 链路 + `data.rlv2.outer` 本地快照；`RoguelikeDataUtil.EnsurePlayerRoguelike()` 是客户端可用性守卫（`CS/Torappu.UI.Roguelike/RoguelikeDungeonTransitionPendingChecker.cs:122`、`RoguelikeMenuKeyViewModel.cs:29`）。

---

#### 6.2.2 协议面清单

##### 2.1 分布与基类事实（已核实）

| 事实 | 证据 |
|---|---|
| 协议类**不只**在 `Torappu/` 平铺目录，而是三处分布 | 见下 |
| `CS/Torappu/`：41 个 `Roguelike*Request.cs` + 39 个 `Roguelike*Response.cs` | `ls Torappu/ \| grep -E '^Roguelike.*(Request\|Response)\.cs$'` → 80 |
| `CS/Torappu.UI.Roguelike/`：10 Request + 10 Response（RL03~RL06 专属） | `RoguelikeChangeCopperRequest/ChangeVehicle/ConfirmDrawCopper/DiscardScrap/EmptyStep/ReadStepZero/RedrawCopper/SeedIdentify/StepMoveToAndStartBattle/StepMoveTo` (+同名 Response) |
| `CS/Torappu.UI.RoguelikeTopic/`：8 Request + 8 Response（局外/战令/主题级） | `RoguelikeTopicBattlePassPurchase/BpGetReward/CreateGame/GameSettle/GiveUpGame/RefreshMission/SetSeed/UnlockBuff` (+同名 Response) |
| **Request 无公共基类**（裸 class；唯一例外见下） | `grep -n 'class Roguelike.*Request :' Torappu/Roguelike*Request.cs` 仅命中 1 条 |
| 唯一带基类的请求：战斗结束请求 | `CS/Torappu/RoguelikeFinishBattleRequest.cs:7` `: CommonFinishBattleRequest, IFinishBattleWithLog` |
| **Response 几乎全部继承 `PlayerDeltaResponse`**（38/39），1 个继承 `CommonFinishBattleResponse`；UI 侧另有 1 个例外 | `grep -h 'class Roguelike.*Response :' Torappu/Roguelike*Response.cs \| sed 's/.*: //' \| sort \| uniq -c` → `38 PlayerDeltaResponse` / `1 CommonFinishBattleResponse`；`CS/Torappu.UI.Roguelike/RoguelikeStepMoveToAndStartBattleResponse.cs:6` `: DefaultStartBattleResponse` |
| 响应载体基类 | `CS/Torappu/PlayerDeltaResponse.cs:8` `abstract class ... : IPlayerPushMsgResponse`，字段 `playerDataDelta`:13、`pushMessage:List<PlayerPushMessage>`:18 |
| **不存在** `RoguelikeResponse` 包装类，也不存在整状态 sync 响应 | 同上：无该类；状态同步完全靠每个响应内嵌的 `playerDataDelta` |
| **绝大多数响应是空壳**：57 个 Response 里仅约 11 个带业务字段 | 业务字段集中在结算（`RoguelikeTopicGameSettleResponse.cs:10,14`）、招募列表、铜钱、密文、战令领奖、`SetSeed.result`；其余为空壳 → 服务端「空壳 + 正确 `playerDataDelta`」即可覆盖约 90% 端点 |
| **7 个端点只有 URL 常量、无 Request DTO**（2.7.71 未定义请求类） | `useTotem`/`confirmPredict`（`RL03Service.cs:9,12`）、`loseFragment`/`useInspiration`/`setTroopCarry`/`alchemy`/`alchemyReward`（`RL04Service.cs:9,12,15,18,21`）——59 个 Request 类中无同名者；另有 `/rlv2/scrap`（`handler.ts:746`）、`/rlv2/finishBattleReward`（`handler.ts:360`）【推测】请求体形状来自抓包而非 CS 类型 |
| 局内「事件/结算」也走 pending 队列而非响应字段 | `CS/Torappu/PlayerRoguelikePendingEvent.cs:9`（`index`@1123、`type`@1127）；事件类型枚举 `CS/Torappu/PlayerRoguelikePlayerEventType.cs:41` `GAME_SETTLE`、`:53` `ALCHEMY`、`:55` `ALCHEMY_REWARD` |

##### 2.2 分组清单（59 Request / 57 Response）

**A. 开局与选队/主题（8）**
| Request（文件） | 关键字段:行 |
|---|---|
| `RoguelikeTopicCreateGameRequest.cs` | `theme`:10 `mode:RoguelikeTopicMode`:14 `modeGrade:int`:18 `predefinedId`:22 `activityId`:26 |
| `RoguelikeTopicSetSeedRequest.cs` | 种子模式（服务端 `handler.ts:541` 要求 theme/activityId/seed） |
| `RoguelikeSelectInitialRelicRequest.cs` | `select:string`:10 |
| `RoguelikeSelectInitialRecruitSetRequest.cs` | `select:string`:10 |
| `RoguelikeSelectInitialChoiceRequest.cs` | 行动奖励（startbuff）选择 |
| `RoguelikeSelectInitialRecruitRequest.cs` | 初始招募 |
| `RoguelikeSelectInitialExploreToolRequest.cs` | 初始探索工具（RL03 祭坛式雷达等） |
| `RoguelikePinTopicRequest.cs` | 置顶主题 |

**B. 节点推进与事件/战斗（12）**
| Request | 关键字段:行 |
|---|---|
| `RoguelikeMoveToRequest.cs` | `to:RoguelikeNodePosition`:10（`{x,y}` = `RoguelikeNodePosition.cs:10,14`） |
| `RoguelikeStepMoveToRequest.cs`(UI.Roguelike) | `route:List<string>`:11 |
| `RoguelikeStepMoveToAndStartBattleRequest.cs`(UI.Roguelike) | gridZone 战斗移动 |
| `RoguelikeEmptyStepRequest.cs` / `RoguelikeReadStepZeroRequest.cs`(UI.Roguelike) | 空步/首次读取（无字段） |
| `RoguelikeSelectChoiceRequest.cs` | `choice:string`:10 |
| `RoguelikeFinishEventRequest.cs` | 事件收尾 |
| `RoguelikeFinishNodeRequest.cs` / `RoguelikeRollNodeRequest.cs` | `nodeIndex:string`:10 |
| `RoguelikeUpgradeNodeRequest.cs` | `nodeType:RoguelikeEventType`:10 |
| `RoguelikeStartBattleRequest.cs` / `RoguelikeFinishBattleRequest.cs`(:7 唯一带基类) | 战斗开始/结束 |
| `RoguelikeSelectRewardRequest.cs` / `RoguelikeZoneRewardRequest.cs` | 战斗奖励/区域奖励 |
| `RoguelikeSpecialZoneLeaveRequest.cs` / `RoguelikeTraderReturnRequest.cs` / `RoguelikeConfirmNodeMissionRequest.cs` / `RoguelikeGiveUpNodeMissionRequest.cs` / `RoguelikeReadMissionTipRequest.cs` | 特殊层离开/行商归来/节点任务 confirm·giveUp·closeTip |

**C. 商店与银行（6）**
`RoguelikeShopActionRequest.cs`（`buy`:11 `recycle`:15 `leave`:19）、`RoguelikeShopRefreshRequest.cs`、`RoguelikeShopBattleRequest.cs`、`RoguelikeBankInvestRequest.cs`、`RoguelikeBankWithdrawRequest.cs`、`RoguelikeBankWithdrawUseItemRequest.cs`。

**D. 升级与遗物/模块（14）**
`RoguelikeActivateTicketRequest` / `RoguelikeCloseTicketRequest` / `RoguelikeStashTicketRequest` / `RoguelikeStashedTicketUseRequest`（招募券生命周期）、`RoguelikeRecruitCharRequest`（`ticketIndex`:10 `optionId`:14）、`RoguelikeCloseRecruitCharRequest`、`RoguelikeGetTicketAssistListRequest`、`RoguelikeRecruitAssistCharRequest`（助战）、`RoguelikeSacrificeRequest`（`choice`:10 `leave`:14）、`RoguelikeExpeditionRequest` / `RoguelikeExpedReturnRequest`（远征）、`RoguelikeGildRequest`、`RoguelikeRedrawCopperRequest` / `RoguelikeChangeCopperRequest` / `RoguelikeConfirmDrawCopperRequest`（UI.Roguelike，铜币三连）、`RoguelikeDiscardScrapRequest`（`instId`:10）/ `RoguelikeChangeVehicleRequest`（`scrapInstId`:10 `toWalk`:14）/ `RoguelikeSeedIdentifyRequest`（`count`:10）（RL06 零件）、`RoguelikeDiceChoiceRequest`（`choice` 枚举 `REROLL`/`LEAVE`，`:12-22`）、`RoguelikeTopicUnlockBuffRequest`、`RoguelikeTopicBattlePassPurchaseRequest`。

**E. 结算与积分（4）**：`RoguelikeTopicGameSettleResponse.cs:10,14`（`game` / `outer`）、`RoguelikeTopicGiveUpGameRequest.cs`、`RoguelikeReadEndingChangeRequest.cs`、`RoguelikeTopicBpGetRewardRequest.cs`。

**F. 存档与查询（1）**：**不存在** sync/query 端点——状态随每个 `PlayerDeltaResponse` 推送（§2.1）。唯一的“查询”类端点是 `RoguelikeGetTicketAssistListRequest`。

**G. 活动（2）**：`RoguelikeTopicRefreshMissionRequest.cs`（月度任务刷新）、`RoguelikeTopicSetSeedRequest.cs`（种子模式，客户端使用方 `RoguelikeActivitySeedModePanel`，见 `docs/接口覆盖分析-未实现与stub清单.md:33`）。

##### 2.3 客户端实际使用的 `/rlv2/*` 路由字面量（可执行证据）

由服务类常量给出（这是最硬的“客户端调哪个端点”证据）：

| 文件:行 | 常量 → 路径 |
|---|---|
| `CS/Torappu.UI.RoguelikeTopic/RoguelikeTopicService.cs:9,12,15,18,21,24,27,30,33` | `CREATE_GAME`→`/rlv2/createGame`、**`FINISH_GAME`→`/rlv2/finishGame`**、`GIVEUP_GAME`、`UNLOCK_BUFF`→`/rlv2/normal/unlockBuff`、`GAME_SETTLE`、`REFRESH_MISSION`→`/rlv2/normal/refreshMission`、`BATTLEPASS_GET_REWARD`、`BATTLEPASS_PURCHASE`→`/rlv2/battlePass/buyReward`、`SET_SEED` |
| `CS/Torappu.UI.Roguelike.RL03/RL03Service.cs:9,12` | `/rlv2/useTotem`、`/rlv2/confirmPredict` |
| `CS/Torappu.UI.Roguelike.RL04/RL04Service.cs:9,12,15,18,21` | `/rlv2/loseFragment`、`/rlv2/useInspiration`、`SET_FRAGMENT_CHAR`→`/rlv2/setTroopCarry`、`/rlv2/alchemy`、`CLAIM_ALCHEMY_REWARD`→`/rlv2/alchemyReward` |
| `CS/Torappu.UI.Roguelike/RL05Service.cs:9,12,15` | `/rlv2/copper/redraw`、`/rlv2/copper/change`、`/rlv2/copper/confirmDraw` |
| `CS/Torappu.UI.Roguelike/RL06Service.cs:9,12,15,18,21,24,27` | `/rlv2/scrap/changeVehicle`、`/rlv2/gridZone/emptyStep`、`/rlv2/gridZone/moveTo`、`/rlv2/gridZone/moveAndBattleStart`、`/rlv2/scrap/loseScrap`、`/rlv2/gridZone/readStepZero`、`/rlv2/scrap/identify` |
| `CS/Torappu.UI.Roguelike/RoguelikeSquadState.cs:55,1354` | `/rlv2/moveAndBattleStart`、`/rlv2/battleFinish` |

**高频调用**（口径：客户端调用点 + 既有文档；**非**抓包频次）：`createGame` / `moveTo`（或 gridZone/moveTo）/ `selectChoice` / `battleFinish` / `gameSettle` 是每局必经路径；`docs/module-audit-2026-08-29.md:11` 记 rlv2 抓包 1860 条为全仓最高频模块族。**其余端点的逐条调用频次【推测】无法从本仓数据判定**（`tmp/capture/index.db` 是契约覆盖样本，非频率分布）。

---

#### 6.2.3 关键规则（客户端证据 ↔ 服务端证据）

##### 3.1 骰子（rogue_2 DICE）：ruleGroup 未实现 ★★

| 侧 | 证据 |
|---|---|
| 客户端规则结构 | `CS/Torappu/RoguelikeDiceRuleData.cs:10,14,18,22,26,30,34,38,42,46`：`dicePointMax` / `diceResultClass` / `diceGroupId` / `diceEventId` / `resultDesc` / `showType` / `canReroll` / `diceEndingScene` / `diceEndingDesc` / `sound` |
| 客户端规则组结构 | `CS/Torappu/RoguelikeDiceRuleGroupData.cs:10,14`：`ruleGroupId` / `minGoodNum` |
| 客户端模块表 | `RoguelikeDiceModuleData.cs:15` `diceEvents`、`:23` `diceRuleGroups`、`:27` `dicePredefines` |
| 服务端掷骰实现 | `logic.ts:619-637` `rollDice()`：`diceRoll = Math.floor(random()*faceCount)+1`(:624)，随后 `diceEventId = eventIds[Math.floor(random()*eventIds.length)]`(:627-630) —— **事件与点数完全解耦**（均匀随机取事件 id），`dicePointMax`/`diceGroupId`/`diceResultClass` 从未参与匹配 |
| 服务端奖励 | `logic.ts:596-603` 按 `showType` 硬编码 `rogue_2_gold`：`VIRTUE`→3、`KEY`→5、其他→2；`:596` 注释自陈「官方通过 ruleGroup 黑板驱动」 |
| 服务端对规则字段的引用数 | `diceRuleGroups` / `dicePointMax` / `minGoodNum` / `diceResultClass` / `dicePredefines` / `canReroll` 在 `app/game/modules/roguelike/` 内 **引用数均为 0**（`grep -rn <k> --include=*.ts . \| wc -l`）；`diceRuleGroups` 全仓仅出现在生成类型 `app/game/excel/types_excel_gen.ts:10381` |
| 返回值占位 | `logic.ts:634-635`：`mutation:{id:"",chars:[]}`、`virtue:[]` 恒空 |

补充（子代理取证，行号已复核）：
- 客户端结果枚举 `CS/Torappu/DiceResultClass.cs:12-22`：`VERYBAD=0`/`BAD=1`/`NORMAL=2`/`GOOD=3`/`GREAT=4`/`BEST=GREAT`；`CS/Torappu/DiceResultShowType.cs:12-16`：`RAW_TEXT`/`MUTATION`/`VIRTUE`。
- 据此，服务端 `logic.ts:599-600` 的 `showType === "KEY"` 分支**是死代码**（`"KEY"` 不是 `DiceResultShowType` 的合法值）。
- 骰子模块只属于 rogue_2；数据侧 `modules.rogue_2.dice.diceEvents` 42 条（每条带 `dicePointMax`+`diceGroupId`）、`diceRuleGroups` 19 组（`minGoodNum ∈ {1,2,4,5,6,8,13}`）。`minGoodNum=13` 远超单骰 6 面 → 官方必为「多骰计数达标数」判定，而服务端只掷 1 枚（`logic.ts:623-624`）并在 42 条事件上均匀抽 1 条（`:627-630`）——**等价 42 选 1 均匀随机，点数与结果无关**。
- 客户端骰子交互只有 `RoguelikeDiceChoiceRequest.cs:12` 的 `REROLL`/`LEAVE`，响应无结果字段；判定方法体在客户端被 XLua hotfix 包裹（`CS/Torappu.UI.Roguelike.RL02/RL02ChoiceDiceDecoView.cs:49,53` 只做骰面数/保底数的图标渲染）。
- 战斗内骰子另走硬编码：`battle.ts:235-246` 按 `diceUpgradeCount` 定面数 6/8/12 与 `trap_067_dice`/`trap_088_dice2`/`trap_089_dice3`，并恒掷 100 枚（`:245`），未走数据 `battleDiceId`【推测】。

**结论：骰子 ruleGroup 服务端无真实实现（P0）。**

##### 3.2 铜币（rogue_5 COPPER）：divine / gildType / luckyLevel 未实现 ★

| 侧 | 证据 |
|---|---|
| 客户端 divine 结构 | `CS/Torappu/RoguelikeCopperDivineData.cs:10,14,18,22,26`：`eventId` / `groupId` / `showDesc` / `divineType` / `resultType` |
| 客户端枚举 | `RoguelikeCopperDivineType.cs:9-18` `NONE`/`DIVINE`/`EVENT`；`RoguelikeCopperDivineResultType.cs:9-20` `NONE`/`GOOD`/`NORMAL`/`BAD`；`RoguelikeCopperLuckyLevel.cs:9-20` `NONE`/`HIGH`/`MID`/`LOW` |
| 客户端铜币条目 | `RoguelikeCopperData.cs:11,15,19,23,27,31,35,39,43,47`：`id`/`groupId`/`gildTypeId`/`luckyLevel`/`buffType`/`layerCntDesc`/`poemList`/`alwaysShowCountDown`/`buffItemIdList`/`isAllLuckyLevel` |
| 客户端常量 | `RoguelikeCopperModuleConsts.cs:10,14,18,22,26`：`copperDrawMaxNum` / `copperDrawMinNum` / `copperAllLuckyLevelGildId` / `copperDrawFreezeCostItemId` / `copperDrawFreezeCostCount[]` |
| 服务端开局抽币 | `modules/copper.ts:69-87`：从 `copperData` 键**均匀随机抽 3 枚**（硬编码 `i<3`，:76），不读 `copperDrawMinNum/MaxNum`，不判 `luckyLevel` |
| 服务端 redraw | `modules/copper.ts:98-130`：仅翻转已有条目的 `isDrawn`（:116-128），**不抽新币**；返回值 `divineEventId: ""` 恒空（:103、:107、:129 三处） |
| 服务端 gild | `modules/copper.ts:90-95` 仅 `item.layer += 1`，不读 `gildTypeId`/`changeCopperMap` |
| 服务端对铜币数据字段引用数 | `copperDivineData` / `copperGildTypeData` / `changeCopperMap` / `copperDrawMaxNum` / `copperDrawMinNum` / `copperAllLuckyLevelGildId` / `luckyLevel` / `buffType` / `poemList` 在 `app/game/modules/roguelike/` 内**全部为 0**（仅 `copperDrawFreezeCostCount` 被 `copper.ts:53` 使用） |
| 端点真实度 | `/copper/change` 为**空操作**：`logic.ts:738-744` 只写 debug 日志 + `state="WAIT_MOVE"`，注释自陈「保持 ODPY 空操作语义」；`/copper/confirmDraw`（`logic.ts:752-755`）只清 pending |

补充（子代理取证，行号已复核）：
- 客户端把「抽到的铜币 + divine 事件 id + 命中原因」一起下发：`CS/Torappu.UI.Roguelike/RoguelikeRedrawCopperResponse.cs:11,15,19,23` = `copper` / `divineEventId` / `hitReason:Dictionary<string,int>` / `exchangeInfo`；挂起事件同构 `CS/Torappu/PlayerRoguelikePendingEvent.cs:945-961`（内部类 `DrawCopper`）。服务端 `handler.ts:686` 只回 `rlv2Response(player, ret)`，`ret` 仅含 `{copper, divineEventId}`（`modules/copper.ts:129`），**`hitReason` / `exchangeInfo` 永不下发**。
- 客户端读取点：`CS/Torappu.UI.Roguelike/RoguelikeDrawCopperStateBean.cs:69`（读 pending 的 `divineEventId`）、`CS/Torappu.UI.Roguelike.RL05/RL05FreezeCopperDialog.cs:331`（读响应的 `divineEventId`）、`CS/Torappu.UI.Roguelike/RoguelikeDrawCopperViewModel.cs:196-215`（据 `copperDivineData` 查表展示 `showDesc`）。
- 数据规模（rogue_5）：`copperData` **2334** 条（`luckyLevel` LOW 880 / MID 814 / HIGH 640；`buffType` 空 2202 / REFRESH 110 / MOVE 22）；`copperDivineData` **135** 条（`divineType` EVENT 132 / DIVINE 3；`resultType` GOOD 63 / BAD 55 / NORMAL 17；60 个 groupId）。服务端 `copper.ts:76-77` 在 2334 条上无权重均匀抽 3 枚，135 条 divine 表完全未读。
- 客户端幸运分级查询 `CS/Torappu.UI.Roguelike.Copper/RoguelikeCopperUtil.cs:99` `GetLuckyLevelByCopperId`（方法体被 hotfix 包裹 :101-115）。

**结论：铜币 divine（天意/神选）服务端无实现，redraw 语义亦不等价（P1）。**

##### 3.3 结算公式（可确证）

客户端：结算聚合落在响应 `game`/`outer`（`RoguelikeTopicGameSettleResponse.cs:10,14`），分数明细的观感来自 `scoreFactor`（难度倍率）+ 逐项明细；装备/等级字段见 `PlayerRoguelikeV2.cs:57,61,65`（`exp`/`level`/`maxLevel`）。
服务端（`settle.ts`）：

| 规则 | 证据 |
|---|---|
| 层档位分 | `settle.ts:321` `ZONE_SCORES = [0,30,80,150,270,400,550,650]`，取 `min(cursor.zone,7)`(:322) |
| 步数 | `:345` `stepCount × 1` |
| 战斗 | `:346-348` 普通 ×10 / 精英 ×20 / 领袖 ×30（按 `trace` 里节点 `type` 1/2/4 计数，:333-335） |
| 物品/招募 | `:349` `(relic + exploreTool) × 5`；`:350` 已招募数 ×2 |
| 难度倍率 | `:357-364` `difficulties[].scoreFactor`，缺省 1 |
| 总分 | `:370-372` `floor(raw × factor)` |
| 黑流效率（源流样本） | `:398-413` 生命游戏节点占比 ×10% 封顶 +10%；难度 ≥3/≥6/≥9 各 +2% → 1.10/1.12/1.14(+1.16) |
| 源流样本值 | `:447` `floor(exploreScore × efficiency)` |
| 写回 | `gameSettle:451`：`buff.score += exploreScore`(:490)；rogue_6 每满 200 源流样本 → 1 演化算子（:494-497）；非 rogue_6 1:1 计 `pointOwned`(:500)；`record.modeGrade++`(:514)；`collect.endBook[ending]` 仅成功(:560)；`history` 保留 ≤100 局(:544) |
| **响应硬编码占位** | `buildSettleResponse:670`：`bp:{cnt:boosted, from:55000, to:55000}`(:696)、`gp:0`(:697)、`gpChange:[100,100]`(:698)、`accumulation:[20000,20000]`(:699)、`missionBp…scrapBp` 全 `bp(55000)`(:704-709)、`relicUnlock/totemUnlock/fragmentUnlock/copperUnlock/scrapUnlock` 全 `[]`(:710-714)、`gp:0`(:715)、`spOperatorInfo:[]`(:716)、`mission.before = after`(:683-686) |

**注意**：`settle.ts:314` 的注释自陈该公式是「dorothinights gameSettle 参考」——即**第三方参考项目口径**，非从官方客户端反编译得出；【推测】官方实际逐项权重可能与上表不同。

**与官方评分常量的对照**（客户端 `CS/Torappu/RoguelikeConstTable.cs` 字段 + 官方数据表实测值；**注意该表是 v1 `roguelike_table.json#constTable`，rlv2 表内无同名字段**，故仅为强参考而非 rlv2 权威口径）：

| 项 | 官方常量（字段:行 / 实测值） | 服务端 | 结论 |
|---|---|---|---|
| 层数分档 | `clearZoneScores`:127 = `[0,50,140,230,340,450,600]` | `settle.ts:321` = `[0,30,80,150,270,400,550,650]` | **不一致**（长度 7 vs 8，数值全不同） |
| 步数 | `moveToNodeScore`:131 = 1 | `:345` ×1 | 一致 |
| 普通战 | `clearNormalBattleScore`:135 = 10 | `:346` ×10 | 一致 |
| 精英战 | `clearEliteBattleScore`:139 = 20 | `:347` ×20 | 一致 |
| 领袖战 | `clearBossBattleScore`:143 = **40** | `:348` ×**30** | **不一致** |
| 藏品 | `gainRelicScore`:147 = 5 | `:349` ×5（口径含 `exploreTool`） | 数值一致 |
| 招募 | `gainCharacterScore`:151 = **3** | `:350` ×**2** | **不一致** |
| 特殊藏品解锁 | `unlockRelicSpecialScore`:155 = 50 | 0 引用 | 未落地 |
| 编队上限 | `squadCapacityMax`:159 = 13 | 未引用 | 未落地 |

等级/经验侧**已落地**：服务端读 `details[theme].detailConst.playerLevelTable` 做 while 升级与属性成长（`inventory.ts:161-175`），战斗经验「基础 = 下一级需求值 + 三星 3」见 `battle.ts:353-360`（`:350` 注释自陈为近似口径）。

##### 3.4 数值上限 / 常量

| 规则 | 证据 |
|---|---|
| 银行上限/抽奖参数（客户端字段） | `CS/Torappu/RoguelikeGameConst.cs:43` `bankMaxGold`、`:51` `bankDrawCount`、`:55` `bankDrawLimit`、`:59` `bankRewardCountType`、`:131` `gpScoreRatio`、`:111` `chestKeyCnt` |
| 服务端对上述字段引用数 | `bankMaxGold` / `bankDrawLimit` / `bankDrawCount` / `gpScoreRatio` / `chestKeyCnt` / `expItemId` / `bankCostId` 在 `app/game/modules/roguelike/` 内**全部为 0**；`gameConst` 仅在 3 处使用：`battle-nav.ts:37`、`event.ts:292`（`expEndingRelic`）、`theme-rules.ts:199` |
| 层初始行动力（黑流树海） | 服务端 `theme-rules.ts:156` `[0,5,6,7,8,8]`；`docs/rlv2-blackstream-官方文本对照.md:145-149` 对照官方文本 5/6/7/8/8 ✓ |
| 留存招募券上限 3 | 服务端 `recruit-flow.ts:95`（`stashRecruitLimit ?? 3`） |
| 重抽费用/冻结 | 服务端 `copper.ts:53`（`copperDrawFreezeCostCount[0]`）、`:102`（`redrawFreezeCnt >= redrawFreeze` 拒绝）、`:106`（余额不足不扣费） |
| 零件箱上限（难度 7 -2） | 服务端 `theme-rules.ts` 无；`docs/rlv2-blackstream-官方文本对照.md:47` 记 `scrap.ts:39,50` 实现 |
| **rlv2 顶层 `constant` 表（10 项）服务端全部未引用** | 官方值（`data/excel/roguelike_topic_table.json#constant`）：`milestoneTokenRatio=1`、`outerBuffTokenRatio=10`、`relicTokenRatio=10`、`rogueSystemUnlockStage="main_03-08"`、`ordiModeReOpenCoolDown=60`、`monthModeReOpenCoolDown=60`、`monthlyTaskUncompletedTime=3`、`monthlyTaskManualRefreshLimit=4`、`monthlyTeamUncompletedTime=7`、`bpPurchaseSystemUnlockTime=1661976000`。服务端 `grep -rn <name> app/game/modules/roguelike` **命中均为 0**（逐项实测） |
| 客户端常量载体是**数据表字段而非 const 字面量** | `CS/Torappu/RoguelikeGameConst.cs`（442 行）与全部 `Roguelike*ModuleConsts.cs` 内 `grep -n 'const '` 无命中——全是表结构声明；实测值：`gpScoreRatio=200`（全 6 主题）、`bankMaxGold=999`、`bankDrawCount`(rogue_2/5=8, rogue_6=0)、`bankDrawLimit`(rogue_2=0, rogue_5/6=12)、`shopRefreshCostId`(r5=`rogue_5_divinationkit`, r6=`rogue_6_gold`)、`copperDrawMaxNum=6`/`copperDrawMinNum=1`/`copperDrawFreezeCostCount=[1,5]`（rogue_5） |
| 商店：服务端刷新**不扣任何资源**、价格与次数全硬编码 | 客户端只确证「刷新消耗物品种类」`CS/Torappu/RoguelikeGameConst.cs:183 shopRefreshCostId`（`gameConst.shopRefreshCostId` 在 UI 目录 0 引用，逻辑在 hotfix 侧）；服务端 `shop.ts:270-279` `refreshShop` 仅 `shop.refreshCnt -= 1`(:278)、无扣费语句，`refreshCnt: 2`(:196) 与 `bank.withdrawLimit: 20`(:190) 硬编码，价格表硬编码于 `shop.ts:72-86`，折扣 `random() < 0.25` 后 5 折取整(:132-133)；`gameConst.shopRefreshCostId` 0 引用 |

##### 3.5 结局（黑流树海三结局）

| 侧 | 证据 |
|---|---|
| 客户端结局数据类 | `CS/Torappu/RoguelikeEndingData.cs`、`RoguelikeGameEndingData.cs`、`RoguelikeGameFailEndingData.cs`、`RoguelikeEndingRelicDetailText.cs`（存在，字段未逐一展开） |
| 服务端结局状态 | `PlayerRoguelikeV2.cs:255` `toEnding` / `:259` `chgEnding`；服务端 `settle.ts:455` `ending = _status.toEnding`，胜利判定 `:468-469` (`runResult==="success" \|\| chgEnding`) |
| 三结局常量 | `theme-rules.ts:191` `ROGUE6_END2_BOSS_STAGE="ro6_b_5"`；`:194-197` `ROGUE6_END2_RELICS{sandboxAlpha,sandboxBeta}`；`:200` `ROGUE6_END3_RELIC="rogue_6_relic_final_3"` |
| 结局收藏品 | `collect.endBook[ending]` 仅成功时写（`settle.ts:560`）；图鉴 100 局历史上限 `:544` |
| 调谐仪式削弱（final_4/5/6） | 服务端**未实现**，仅保证节点通行（`docs/rlv2-blackstream-官方文本对照.md:187,333`） |

---

#### 6.2.4 客户端 ↔ 服务端差异比对（P0/P1/P2）

> 判定口径：**已实现** = 客户端语义字段被服务端读取并驱动分支；**部分** = 有端点但语义简化；**缺失** = 客户端存在而服务端无任何对应；**行为不一致** = 两侧语义相等但取值/流程不同。

##### D1【P0｜缺失+崩溃】`TOTEMBUFF` 键名不匹配 → rogue_3 图腾管理器永不实例化，`/rlv2/useTotem` 对 rogue_3 会 TypeError
- 客户端证据：`CS/Torappu/RoguelikeModuleType.cs:20` 枚举名为 **`TOTEMBUFF`**（不是 `TOTEM`）；数据 `rogue_3` 的 `moduleTypes = ["CHAOS","TOTEMBUFF","VISION"]`（`data/excel/roguelike_topic_table.json`）。
- 服务端证据：工厂表键为 `TOTEM`（`rlv2-module-composition.ts:87` `TOTEM: () => new RoguelikeTotemManager(...)`），实例化按数据键查表且有 `in` 守卫 → `TOTEMBUFF` 被静默跳过（`module.ts:60-67` 与 `:96-101` 两处 `if (moduleName in moduleHandler ...)`）。
- 触发路径：`logic.ts:460` `this._module.totem.use(args.totemIndex, args.nodeIndex)`（**无 `?.`**），而 getter `module.ts:114-116` 返回 `this._modules["TOTEM"]` → `undefined` → `TypeError`，端点 `/rlv2/useTotem`（`handler.ts:436`）对 rogue_3 应 500。【推测】实战可达性待抓包确认。
- 建议：工厂键改 `TOTEMBUFF`（或加别名表），并把 `logic.ts:460` 改为可选链。

##### D2【P0｜缺失】`CANDLE`（rogue_5 伺烛客）模块整体缺失
- 客户端证据：`CS/Torappu/RoguelikeModuleType.cs:34` `CANDLE`；`RoguelikeCandleModuleData.cs:11,15,19`（`candleTicketIdList` / `moduleConsts` / `candleBattleStageIdList`）；`RoguelikeCandleModuleConsts.cs:10` `candleHolderBuffId`；数据 `rogue_5` 的 `moduleTypes` 含 `CANDLE`。
- 服务端证据：`rlv2-module-composition.ts:83-98` 工厂表**无 `CANDLE`**，`app/game/modules/roguelike/modules/` 无 candle 文件；仅有近似事件 `recruit.ts:450`（`Rlv2CandleTimes`）与 `event.ts:394`（`Rlv2EndingWithCandleChar`）。

##### D3【P0｜缺失】骰子 `ruleGroup` 全缺（详见 §3.1）
- 客户端：`RoguelikeDiceModuleData.cs:23` `diceRuleGroups`、`RoguelikeDiceRuleData.cs:10,18,14`（`dicePointMax`/`diceGroupId`/`diceResultClass`）。
- 服务端：`logic.ts:627-630` 事件 id 与点数无关的均匀随机；`diceRuleGroups` 等 6 个字段引用数 0。

##### D4【P0｜行为不一致】模块增量 `m_get/m_lose` 被静默丢弃
- 客户端：choice 效果含 `m_get`/`m_lose` 模块数值增量（模块状态 `data.rlv2.current.module`，读取点见 `RoguelikeGildCompDialog.cs:247`）。
- 服务端：`module.ts:242-262` `applyModuleDelta()`：`const moduleData = this.toJSON();`(:243) 把增量写进**一次性新对象**，未回写任何管理器；而各管理器 `toJSON()` 均返回新对象（`dice.ts:44-46`、`copper.ts:132-144`）→ 增量丢失。调用点为 `logic.ts` 的效果分发路径。

##### D5【P1｜缺失】铜币 divine / gildType / luckyLevel 缺失（详见 §3.2）
- 客户端：`RoguelikeCopperDivineData.cs:10-26` + 3 个枚举 + `RoguelikeCopperModuleConsts.cs:10-26`。
- 服务端：`modules/copper.ts:69-130`、`logic.ts:738-755`；9 个铜币数据字段引用数 0，`divineEventId` 恒 `""`。

##### D6【P1｜缺失】WRATH / SKY / VISION / WEATHER 有状态字段但恒空
- 客户端：`RoguelikeModuleType.cs:22,32,36,40`（`VISION`/`WRATH`/`SKY`/`WEATHER`）；rogue_5 挂 `WRATH,SKY`、rogue_3 挂 `VISION`、rogue_6 挂 `WEATHER`。
- 服务端：`modules/wrath_sky.ts` 的 `rlv2:wrath:gain` **全仓无 emit 点**（仅 `app/game/kernel/events/rlv2.ts:89` 声明 + 本文件订阅）→ `wraths` 恒空；`modules/chaos.ts:141` `RoguelikeVisionManager` 无写入点 → 恒 `{0,0}`；`modules/weather.ts:54-72` 进层恒清空、不生成随机天气。

##### D7【P1｜桩】结算响应 BP/GP/解锁列表全为占位常量
- 客户端：结算响应结构 `RoguelikeTopicGameSettleResponse.cs:10,14`（`game`/`outer` 聚合），结算页需要 BP 进度、GP、解锁列表。
- 服务端：`settle.ts:696-716` 硬编码 `from/to=55000`、`gp:0`、`gpChange:[100,100]`、`accumulation:[20000,20000]`、5 个 `*Unlock: []`、`spOperatorInfo: []`、`mission.before=after`。

##### D8【P1｜桩/死路径】旧 v1 路由 6 端点中 5 个为纯桩，且 `/roguelike/roguelike/*` 双前缀不可达
- 客户端：v1 协议（`RoguelikeCreateGameRequest` 等）——**2.7.71 的 Torappu/ 中不存在 v1 rlv1 请求类同名文件**（`ls Torappu/ | grep -E '^Roguelike.*Request'` 全为 v2 语义；v1 路由在客户端已基本绝迹）【推测】。
- 服务端：`routes.ts:35,46,57,68,80`（createGame/finishGame/giveUpGame/milestoneReward/milestoneRewardTryBest）全部只回 `{...player.delta, result:0}` 或 `items: []`；仅 `:99` `upgradeOutBuff` 接真逻辑。挂载 `app/game/routes.ts:119`（prefix `/roguelike`）+ 内部路径 `routes.ts:35` 的 `/roguelike/createGame` → 实际 URL `/roguelike/roguelike/createGame`；别名 `/activity`（`app/game/routes.ts:143`）→ `/activity/roguelike/createGame` 才可达。
- 与文档一致：`docs/module-audit-2026-08-29.md:53`。

##### D9【P1｜缺失】`/game/rlv2` 别名仍不存在
- 服务端：`app/game/routes.ts` 仅 `:99` `/rlv2`，无 rewrite（`app/game/app.ts` 直接 `app.use(prefix, router)`），全服务无 `/game` 挂载点。
- 客户端：在本轮检索的 6 个 UI 目录（`Torappu.UI.Roguelike*`、`Torappu.UI.RoguelikeTopic`）中**未出现** `/game/rlv2` 字面量 ——【推测】正式客户端走 `/rlv2/*`，故该缺失的实际影响可能低于既有文档判断（见 `docs/module-audit-2026-08-29.md:30,53`）。

##### D10【P1｜桩】`alchemyReward` 忽略请求 `index`（handler 硬写 0）
- 客户端：`CS/Torappu.UI.Roguelike.RL04/RL04Service.cs:21` `CLAIM_ALCHEMY_REWARD = "/rlv2/alchemyReward"`；请求带 `index`（抓包口径）。
- 服务端：`handler.ts:738-743`：`req.body as RoguelikeAlchemyRewardRequest;`(:740 空断言) 后直接 `alchemyReward({ index: 0 })`(:741)；控制器 `logic.ts:704-707` 仅清 pending。`modules/fragment.ts:194` 的 `alchemyReward` 为死代码（无调用点）。

##### D11【P2｜桩】助战/好友链路静默关闭
- 客户端：`RoguelikeGetTicketAssistListRequest` / `RoguelikeRecruitAssistCharRequest` 存在，`RoguelikeFriendAssistSearchModel.cs:237,259,331,355` 读助战 UI 状态。
- 服务端：`recruit-flow.ts:69-77` 只置 `ticket.needAssist=false` 并保留/初始化空 `assistList`(:76)，从不填候选；`:79-88` `recruitAssistChar` 只置 `needAssist=false`(:87)，不入队助战干员。与 `docs/rlv2-blackstream-官方文本对照.md:133` 一致（单账号私服可接受）。

##### D12【P2｜桩】`scrap` 空操作 / `fragment.alchemyReward` 死代码 / `nodeMission closeTip` 仅写标志
- 服务端：`logic.ts:769-771` `/scrap` 仅 `state="WAIT_MOVE"`；`logic.ts:534-537` `nodeMissionCloseTip` 仅 `tip=false`；`modules/fragment.ts:194` 无调用点。客户端对应端点确实存在：`RL06Service.cs:21,27`（scrap 相关）、`RoguelikeReadMissionTipRequest`。

##### D13【P2｜部分】`giveUpGame` 不写 outer
- 服务端：`game-init.ts:88` 路径只写 `current.record` 并发 GAME_SETTLE，不写 `outer[theme]`；而客户端结算页从 `data.rlv2.outer` 取快照（`CS/Torappu.UI.Roguelike/RoguelikeClassicEndingController.cs:780`、`RoguelikeUtil.cs:1323`）。

##### D14【P2｜行为不一致/来源存疑】银行端点：客户端请求无 `count` 字段，且 `/rlv2/bankPut` 字面量在客户端不可见
- 客户端：`CS/Torappu/RoguelikeBankWithdrawRequest.cs:6-10` **无任何字段**（只有构造器）；带 `count:int` 的是另一个类 `CS/Torappu/RoguelikeBankWithdrawUseItemRequest.cs:10`；`RoguelikeBankInvestRequest` 亦无字段。在 `CS/Torappu.UI.Roguelike*`、`CS/Torappu.UI.RoguelikeTopic/` 6 个目录内检索 `/rlv2/bankPut`、`/rlv2/bankWithdraw`、`bankWithdrawUseItem` **均无字面量命中**【推测】银行端点路径来源为 ODPY/抓包，而非本版客户端常量。
- 服务端：`bank.ts:29` `bankWithdraw(mgr, args:{count?:number})` 读 `args.count ?? 1`(:33)；`bankPut` 扣 1 金(:15-16)，上限/参数不读 `gameConst.bankMaxGold`（见 D16）。
- 影响：即便路径可达，客户端无法传 count；服务端每次固定取 1，与客户端 `RoguelikeBankWithdrawUseItemRequest.count` 语义脱节（该端点在服务端**无对应路由**）。

##### D15【P2｜行为不一致】`MONTH_TEAM` 模式处理与旧文档冲突（文档漂移，代码已修一半）
- 客户端：`CS/Torappu/RoguelikeTopicMode.cs:22` `MONTH_TEAM`、`:24` `CHALLENGE`。
- 服务端：`game-init.ts:137` `mode: args.mode === "CHALLENGE" ? "NORMAL" : args.mode` —— MONTH_TEAM **已保留**；`docs/rlv2-blackstream-官方文本对照.md:29,331` 仍记「MONTH_TEAM/CHALLENGE 一律转 NORMAL」，**该结论已过期**（有 `tests/unit/modules/rlv2/rlv2-month-team.test.ts` 固化）。仍缺的是理想践行者/随行录/委托任务本体。

##### D16【P2｜文档漂移】协议缺失清单已过期
- `docs/接口覆盖分析-未实现与stub清单.md:15,28-35,145` 记 `/rlv2` 有 6 条完全未实现（battlePass/buyReward、copper/change、copper/confirmDraw、finishGame、normal/unlockBuff、setSeed）。实测：其中 5 条**已实现**——`handler.ts:527`（buyReward）、`:561`（copper/change）、`:569`（copper/confirmDraw）、`:549`（normal/unlockBuff）、`:541`（setSeed）；仅 **`/rlv2/finishGame` 仍缺**（`handler.ts` 无该路由；客户端常量 `RoguelikeTopicService.cs:12` 存在，但**全仓无任何调用点**——检索了 `Torappu/`、`Torappu.UI.Roguelike*`、`Torappu.UI.RoguelikeTopic/` 均只有该定义行）【推测该常量为死常量，客户端不调用】。

##### D17【P2｜部分】模块热度/难度常量未落地
- 客户端：`RoguelikeGameConst.cs:43,51,55,59,131,111`（`bankMaxGold`/`bankDrawCount`/`bankDrawLimit`/`bankRewardCountType`/`gpScoreRatio`/`chestKeyCnt`）。
- 服务端：这些字段在 `app/game/modules/roguelike/` 引用数**全为 0**；`gameConst` 仅 3 处使用（`battle-nav.ts:37`、`event.ts:292`、`theme-rules.ts:199`）→ 银行上限/抽奖参数/GP 比率未按官方常量驱动。

##### D18【P1｜行为不一致】结算分数权重与官方评分常量不符
- 客户端/官方证据：`CS/Torappu/RoguelikeConstTable.cs:127,143,151` 字段 `clearZoneScores`/`clearBossBattleScore`/`gainCharacterScore`，实测值 `[0,50,140,230,340,450,600]`/`40`/`3`（`data/excel/roguelike_table.json#constTable`）。
- 服务端证据：`settle.ts:321` `ZONE_SCORES=[0,30,80,150,270,400,550,650]`；`:348` 领袖 ×30；`:350` 招募 ×2。另 `unlockRelicSpecialScore=50`（`:155`）与 `squadCapacityMax=13`（`:159`）在服务端 0 引用；rlv2 顶层 `constant` 10 项（含 `gpScoreRatio` 同族的 `milestoneTokenRatio=1`/`outerBuffTokenRatio=10`/`relicTokenRatio=10`）全部 0 引用。
- 口径保留：官方常量取自 **v1** 表，rlv2 表内无同名字段，故为**强参考**而非 rlv2 权威口径【推测】服务端权重来源为 dorothinights（`settle.ts:314` 注释自陈）。

##### D19【P1｜缺失】非黑流树海主题的结局分支不完整
- 客户端/数据证据：`details.rogue_2.endings` 4 个、`details.rogue_5.endings` 5 个、`rogue_6` 3 个（`data/excel/roguelike_topic_table.json`）；客户端只消费 `brief.ending`（`CS/Torappu.UI.RoguelikeTopic/GameSettleBrief.cs:14`），判定在服务端。
- 服务端证据：默认 `status.ts:144` `toEnding = \`ro${theme.slice(-1)}_ending_1\``；道具切 2 号 `game-init.ts:203`；黑流树海额外两分支 `event.ts:230-238`（怦然信标→ending_3 优先，沙盘α/β→ending_2）。**非 rogue_6 主题无 ending_3+ 的触发路径**（全仓 TS 无 `ro2_ending_3`/`ro5_ending_3` 等字面量）。

##### D20【P2｜行为不一致】商店刷新零成本 + 价格/次数硬编码
- 客户端证据：`CS/Torappu/RoguelikeGameConst.cs:183` `shopRefreshCostId`（数据值 r5=`rogue_5_divinationkit`、r6=`rogue_6_gold`）——官方刷新应消耗该物品。
- 服务端证据：`shop.ts:276-278` `refreshShop` 仅校验并递减 `shop.refreshCnt`（初始硬编码 2，`:196`），**无任何扣费语句**；价格表硬编码于 `shop.ts:72-86`，折扣 `random() < 0.25` 后 5 折取整（`:132-133`）；`bank.withdrawLimit: 20` 硬编码（`:190`）；`gameConst.shopRefreshCostId` 在 `app/game/modules/roguelike/` **0 引用**。

---

#### 6.2.5 结论

- **服务端肉鸽是「黑流树海（rogue_6）单主题深做 + 其余 5 主题通用骨架」的形态**：rogue_6 的网格地图/21 类节点三结局/零件/乌托邦/事件引擎最完整（`theme-rules.ts` 281 行 + `modules/grid_zone.ts` 1487 行 + `incident.ts` 870 行，有 49 个专测文件约 373 用例）；rogue_1..5 靠通用 `event/map/shop/recruit/battle-nav` 走通，模块层**部分实现或恒空**。
- **最硬的结构性缺陷是 3 条**：模块工厂键 `TOTEM`↔数据 `TOTEMBUFF` 不匹配（D1，可致 500）、`CANDLE` 无实现（D2）、`applyModuleDelta` 写临时对象致模块增量丢弃（D4）。这三条既有文档均**未记录**。
- **规则层最大的语义缺口**：骰子 `ruleGroup`（D3）与铜币 `divine`（D5）——两者在客户端都有完整的规则表/枚举结构，服务端分别退化为「均匀随机取事件」与「恒空 divineEventId」。
- **文档漂移需同步**：`docs/接口覆盖分析-未实现与stub清单.md` 的 6 条缺失已补 5 条（D16）；`docs/rlv2-blackstream-官方文本对照.md` 的 MONTH_TEAM 结论已过期（D15）。
- **数值口径是系统性缺口**：官方把上限/冷却/比率全部放在数据表（`rlv2 constant` 10 项、`gameConst` 数十字段、各 `ModuleConsts`），服务端却以字面量实现（商店 `refreshCnt=2`/`withdrawLimit=20`、铜币抽 3、骰面 6、战斗骰 100、源流 200/算子、BP 55000、`ZONE_SCORES`），**逐项 grep 命中 0**（D18/D20/D17）。
- **做得好的部分**（避免误判）：rogue_6 三结局判定优先级正确（`event.ts:228-243`）、等级/经验读官方 `playerLevelTable` 落地（`inventory.ts:161-175`、`battle.ts:353-360`）、节点类型 21 值表与官方 `RoguelikeEventType` 位标志逐值吻合、`/rlv2` 69 端点路由面与客户端常量基本对齐。
- **未验证/待抓包**：客户端网络发送方法体在 Cpp2IL 下不可恢复，端点调用频次与 `useTotem` 实战可达性均属【推测】。

---

### 6.3 生息演算 / 沙盒（SandboxPerm V2·V3）

> 取证基线：客户端 `reference/arknights-2.7.71-csharp/Assembly-CSharp/`（含方法体反编译源码）+ 签名文件 `reference/com.hypergryph.arknights_2.7.71.cs`（58MB，下称 **sig**）+ Excel `data/excel/sandbox_perm_table.json`；服务端 `app/game/modules/sandbox/`。
> 标注约定：**【已读代码验证】** = 亲自 read/grep 到该行；**【推测】** = 由命名/字段形状推断，未经调用点证实。

---

#### 6.3.0 结论速览

**实现完整度：路由面 100% 覆盖、行为面 0% 实现——该域在服务端是一具完整的协议骨架 + 全空内核，不存在任何可玩状态。**

| 维度 | 客户端 | 服务端 |
|---|---|---|
| 端点 | 69 条真实端点字面量（V2 41 + V3 26 + perm 2） | 78 条运行时路由，**69 条全部命中，0 缺失** |
| 协议类 | **137 个**（68 `Request` + 69 `Response`；V3 的 `BuildSave` 仅有序响应无请求类） | `sandbox.ts` 669 行**只有 interface/type 声明，零业务函数** |
| 状态持久化 | `PlayerSandboxPerm` 完整建模（template/summary/pin/isClose/loadTs） | **`player.update(` 出现 0 次** → 从不写入 `sandboxPerm` |
| V2 玩法 | 2200 行状态模型 + 72 张子表（106 关/54 科技/96 配方/8 级基地） | 41 端点：**35 条 202、6 条空 delta** |
| V3 玩法（电力/动物/烹饪/基地） | 完整（`PlayerSandboxV3*` 20 个子类） | 26 端点：**16 条 202、4 条空 delta、6 条硬编码字面量** |

**量化（实测，非引用文档）** — `app/game/modules/sandbox/routes.ts`：
```bash
grep -c 'router\.post('      routes.ts   # 75  (74 顶层 + 1 条 for 循环内模板)
grep -c 'sendStatus(202)'    routes.ts   # 53
grep -c 'modified: {}'       routes.ts   # 15
grep -c 'res.send({'         routes.ts   # 21  → 21-15 = 6 条带非空 modified
grep -c 'player\.update'     routes.ts   # 0     ← 关键
grep -c 'player\.delta'      routes.ts   # 1     (L1195，racing 循环)
```
⇒ **80 个运行时 handler（74 顶层 + 6 循环）中，53 条(66.3%) 裸 202、15 条(18.8%) 空 delta、6 条(7.5%) 硬编码字面量、6 条(7.5%) `player.delta`（因无写入必然为空）。没有任何一条读改沙盒状态。**
> ⚠️ 与既有文档不一致：`docs/prts-wiki-实现评估-2026-09-09.md:182` 记「73 路由中 51 个 `sendStatus(202)`」，总装方口述 72/51，本仓当前实测为 **74/53**（文档基于修订前版本）。
> ✅ 路径差集：客户端 69 条端点经 `sandboxPermRewrite`（`app/game/routes.ts:67-75`，`/sandboxV2/`→`/v2/`、`/sandboxV3/`→`/v3/`）映射后，**相对服务端缺失集合为空**；反向多出 9 条服务端独有路由（6 条 racing 别名 + 3 条死路由）。

---

#### 6.3.1 客户端数据模型与玩法骨架

##### 1.1 命名空间与类分布（已核实）

| 目录 | 文件数 | Request 数 | 内容 |
|---|---|---|---|
| `Torappu.UI.SandboxPerm/` | 80 | 2 | `SandboxPermChangeTopicRequest`、`SandboxPermPinTopicRequest`、`SandboxPermService.cs` |
| `Torappu.UI.SandboxPerm.SandboxV2/` | 703 | 41 | V2 全部协议 + UI/玩法 |
| `Torappu.UI.SandboxPerm.SandboxV3/` | 539 | 25 | V3 全部协议 + UI/玩法 |
| `Torappu.Battle.SandboxV3/` | 109 | 0 | 战斗内系统（`SandboxV3BattleManager` 5501 行、`SandboxV3BattleSaveManager` 5063 行、`SandboxV3BattleShopManager` 1026 行、`SandboxV3BattleConst` 416 行、Relics 17 个） |
| `Torappu/`（平铺） | — | — | **状态类与静态数据类**（`PlayerSandbox*`、`SandboxV2*Data`、`SandboxV3*Data`） |

##### 1.2 顶层状态：`PlayerSandboxPerm`（`Torappu/PlayerSandboxPerm.cs`）

| 行号 | 字段 | 说明 |
|---|---|---|
| L51 | `string topic` | 当前主题 |
| L55 | `PlayerSandboxTemplateData template` | 存档容器 |
| L14-15 | `[JsonProperty("SANDBOX_V2")] ListDict<string, PlayerSandboxV2> sandboxV2TemplateData` | 键 = topicId（`sandbox_1`） |
| L19-20 | `[JsonProperty("SANDBOX_V3")] ListDict<string, PlayerSandboxV3> sandboxV3TemplateData` | 键 = topicId（`sandbox_2`） |
| L63 / L67 / L71 | `bool isClose` / `long loadTs` / `string pin` | 固定主题（对应 pinTopic） |
| L75, L34-40 | `PlayerSandboxSummaryData summary` → `sandboxV2/v3SummaryData` | 列表页摘要 |

> 类型已在服务端生成：`app/game/excel/types-playerdata.ts:5807   sandboxPerm: PlayerSandboxPerm;` —— **但 `app/` 内除 `modules/sandbox/` 自身与路由注释外，无任何代码读写 `sandboxPerm`**（`grep -rn 'sandboxPerm' app/ --include=*.ts | grep -v modules/sandbox/` 仅命中 `app.ts:142` 注释、`routes.ts:15/62/84/159-163` 路由挂载、`types-playerdata.ts:5807` 类型声明）。

##### 1.3 V2 状态模型（`Torappu/PlayerSandboxV2.cs`，2258 行）

**顶层字段（L2137-2229）**：`status:Status`(L2139) · `baseInfo:BaseInfo`(L2144, `[JsonProperty("base")]` L2143) · `main:Dungeon`(L2153) · `rift:Dungeon`(L2157) · `quest:QuestGroup`(L2161) · `expedition:Expedition`(L2166) · `troop:Troop`(L2170) · `cook:Cook`(L2174) · `build:Build`(L2178) · `bag:Bag`(L2182) · `bank:Bank`(L2186) · `riftInfo:RiftInfo`(L2197) · `tech:Tech`(L2208) · `record:Archive`(L2220) · `archive:Collect`(L2225) · `buff:Buff`(L2229)。

**关键嵌套类**：
- `Status`(L46-77)：`state:GameState`(L50) / `ts`(L54) / `isRift`(L58) / `isGuide`(L62) / `isChallenge`(L66) / `mode:int`(L70)。
- `BaseInfo`(L80-115)：`baseLv`(L84) / `portableUnlock`(L88) / `outpostUnlock`(L92) / `trapLimit:Dictionary<string,int>`(L96) / `upgradeProgress:List<List<int>>`(L100) / `repairDiscount`(L104) / `bossKill:List<string>`(L108)。
- `Dungeon`(L118-1142)：`game{mapId,day,maxDay,ap,maxAp}`(L121-148) · `map{season,zone,node}`(L248-267) · `stage:node→NodeStage`(L270-281) · **`NodeStage`(L684-760) 是玩法实体全集**：`baseInfo/port/nest/cave/gate/mine/insect/collect/hunt/trap/building/action/actionKill/animal`（L701-753）· `enemy{enemyRush,rareAnimal}`(L918-933) · `npc:NpcGroup`(L936-1022) · `events:EventGroup`(L1047-1096) · `report:Report`(L284-469，含 `scoreTotal/scoreRatio/techToken/techCent/shopCoin/shopCoinMax` L437-458) · `EnemyRush`(L812-855, `enemyRushType/groupKey/state/day/path/enemy/boss/badge/src`) · `RareAnimal`(L858-897)。
- `Troop`(L1145-1204)：`food:Dictionary<int,CharFood>`(L1189) / `squad:List<Squad>`(L1193) / `usedChar:List<int>`(L1197)。
- `Cook`(L1207-1252)：`drink`(L1233) / `extraDrink`(L1237) / `book:Dictionary<string,int>`(L1241) / `food:Dictionary<string,Food>`(L1245)。
- `Build`(L1255-1278)：`book`(L1259) / `building`(L1263) / `tactical`(L1267) / `animal`(L1271)。
- `Bag`(L1281-1296)：`material:Dictionary<string,int>`(L1285) / `craft:string[]`(L1289)。
- `Bank`(L1299-1314)：`book:List<string>`(L1303) / `coin:Dictionary<string,int>`(L1307)。
- **`Tech`(L1317-1336)**：`token:int`(L1321) / `cent:int`(L1325) / `unlock:string[]`(L1329) ← 科技树进度。
- `QuestGroup`(L1339-1378)：`quests:List<Quest>`(L1367, `[JsonProperty("pending")]` L1366) / `complete:List<string>`(L1371)。
- `Shop`(L1381-1423)：`unlock`(L1408) / `day`(L1412) / `slots:List<ShopSlotData>{goodId,count,price}`(L1416, L1384-1404)。
- `RiftInfo`(L1440-1656)：`isUnlocked`(L1615) / `randomRemain`(L1619) / `reservedRifts`(L1624) / `completedDifficultyLevel`(L1629) / `teamLv`(L1633) / `fixFinish`(L1637) / `reservation{rift,mainTarget,subTarget,climate,terrain,map,enemy,effect,difficulty,team}`(L1461-1512) / `gameInfo{status,mainProgress,subProgress,mainFail,pin}`(L1526-1575) / `settleInfo{reward,portHp}`(L1596-1611)。
- `Archive`(L1749-1772)：`save:List<Save>`(L1753) / `nextLoadTs`(L1757) / `loadTs`(L1761) / `daily:Save`(L1765)（读档系统）。
- `Racing`(L1866-2027)：`unlock`(L2002) / `bag:RacerBag`(L2006) / `bagTmp:TempRacerBag`(L2013) / `token`(L2020)；`RacerInfo{racerId,inst,level,attribute,talent,name,mark,medal}`(L1893-1955)。
- `Challenge`(L2030-2135)：`unlock:Dictionary<string,List<int>>`(L2099) / `status:ChallengeStatus`(L2103) / `cur{startDay,startLoadTimes,hardRatio,enemyKill}`(L2046-2069) / `best/last:History`(L2072-2095) / `reward`(L2119) / `challengeModeActivated`(L2124)。

**枚举状态机（已确证）**：
- `GameState`(L11-21)：`INACTIVE, ACTIVE, SETTLE_DATE, READING_ARCHIVE`
- `NodeState`(L24-32)：`LOCKED, UNLOCKED, COMPLETED`
- `StageState`(L35-43)：`UNEXPLORED, EXPLORED, COMPLETED`
- `RiftInfo.RiftGameStatus`(L1515-1523)：`ACTIVE=0, SETTLE=1, INVALID=99`
- `Challenge.ChallengeStatus`(L2033-2043)：`NOT_IN_CHALLENGE=0, IN_CHALLENGE=1, CHALLENGE_SETTLE=2, UNDEFINED=99`
- `SandboxV2NodeType`(`SandboxV2NodeType.cs:9-46`)：18 值 `NONE/HOME/HOME_OUTPOST/BATTLE/NEST/COLLECT/HUNT/CAVE/MINE/ENCOUNTER/EXPEDITION/SHOP/GATE/MARKET/HOME_PORTABLE/HOME_PORTABLE_RIFT/SELECTION/RACING`

##### 1.4 V3 状态模型（`Torappu/PlayerSandboxV3.cs` 等）

**`PlayerSandboxV3`**（`PlayerSandboxV3.cs`）：`current:PlayerSandboxV3CurrentGame`(L12) · `game{int modeId}`(L16, `PlayerSandboxV3Game.cs:10`) · `map{unlockZones,unlockNodes}`(L20, `PlayerSandboxV3Map.cs:13/18`) · `npc`(L28) · `quest`(L32) · **`basement`(L37, `[JsonProperty("base")]` L36)** · `dungeon`(L41) · **`development`(L49, `[JsonProperty("tech")]` L48)** · `band:Dictionary<string,PlayerSandboxV3Band>`(L53) · `inventory`(L57) · `collect`(L61)。

**`PlayerSandboxV3CurrentGame`**（`PlayerSandboxV3CurrentGame.cs`，L11-56）：`nodeId` / `state:PlayerSandboxV3GameState` / `game:PlayerSandboxV3CurrentInfo` / `map:PlayerSandboxV3CurrentMap` / `band` / `troop` / `shop` / `dailyReport` / `bag` / `eventInfo`(`[JsonProperty("event")]` L47) / `effect:SandboxV3EffectData` / `save:PlayerSandboxV3CurrentSave`。

**V3 状态机 `PlayerSandboxV3GameState`**（`PlayerSandboxV3GameState.cs:9-23`）：`NONE=-1, BAND_SELECT, INIT_GAP, IN_BATTLE, GAP_REPORT, EXPEDITION, NORM_GAP, GAME_FINISH`
**`PlayerSandboxV3Node.State`**（`PlayerSandboxV3Node.cs:9-17`）：`UNLOCK, PLAYED, PASSED`

**V3 新系统（相对 V2）证据**：
| 系统 | 类 / 行号 | 字段 |
|---|---|---|
| **电力** | `PlayerSandboxV3CurrentInfo.cs:38` `int power` | + `PlayerSandboxV3CurrentSave.cs:47 powerValue` / `:51 decimalPowerValue` |
| | `SandboxV3ElectricSupplyType.cs:9-18` | `NONE/WOOD/STONE/IRON` |
| | `SandboxV3ElectricTransferType.cs:9-20` | `NONE/FUNCTION/SUPPLY/ADDITION/AMPLIFY` |
| **动物/畜牧** | `PlayerSandboxV3Basement.cs:32 animal:List<PlayerSandboxV3BaseAnimal>` | `PlayerSandboxV3BaseAnimal.cs:11 pos` / `:15 enemy:Dictionary<string,int>` |
| | `PlayerSandboxV3CurrentSave.cs:43 animalSaves:List<SandboxV3AnimalSave>` | `SandboxV3LivestockData.cs:10-34`（`shinyRate` L30、`isLegend` L34） |
| **烹饪** | `PlayerSandboxV3Inventory.cs:19 cookbook:List<string>` | `PlayerSandboxV3FoodInfo.cs:11 id` / `:15 sub:List<string>` |
| | `PlayerSandboxV3CurrentBag.cs:15 material` / `:23 recipe:List<string>` | `SandboxV3CookbookData.cs:11-31` |
| **基地建造评分** | `PlayerSandboxV3Basement.cs:40 score:long` / `:36 debris` / `:20 wonder` | `SandboxV3BuildScoreData.cs:10-22` |
| **繁荣/美学** | `PlayerSandboxV3CurrentSave.cs:83 prosperity` / `:87 aesthetics` | + `:63 taskSave` / `:59 milestoneSave` |
| **防守** | `PlayerSandboxV3Zone.cs:29 defend:PlayerSandboxV3DefendInfo` | `PlayerSandboxV3DefendInfo.cs:11 mainIds` / `:15 otherIds` |
| **生产/收获** | `PlayerSandboxV3Harvest.cs:11 unlock` / `:15 rate:Dictionary<string,int>` / `:19 refreshTs` / `:23 harvestTs` | `PlayerSandboxV3Basement.cs:45 harvest`(`[JsonProperty("production")]` L44) |
| **科技** | `PlayerSandboxV3Development.cs:10 token` / `:14 unlock:string[]` | 对应 `unlockTech` |
| **日结** | `PlayerSandboxV3CurrentDayPassSettlement.cs:10-26` | `gainPower/pros/aesth/aesthCoin/weather` |
| **模式/难度** | `SandboxV3ModeData.cs:11-35` / `PlayerSandboxV3Dungeon.cs:11 difficulty` | |
| **关卡存档** | `PlayerSandboxV3CurrentSave.cs:11-99` | 20 个 Save 子表（干员/资源/房间/敌人死亡/重要敌人/加工配方/关卡随机/动物/里程碑/任务/召唤/遗物/服务/地图点/繁荣/美学…） |

##### 1.5 静态数据表（Excel 实证）

`data/excel/sandbox_perm_table.json`（2.76MB）三层结构：
- `basicInfo`：`sandbox_1`(`topicTemplate:"SANDBOX_V2"`, 名「沙洲遗闻」, `medalGroupId:"medalGroupSandbox01"`) / `sandbox_2`(`topicTemplate:"SANDBOX_V3"`, 名「重启锚点」, `topicStartTime:1778832000`)。
- `detail.sandboxV2TemplateData.sandbox_1`：**72 张子表** — `mapData/itemTrapData(陷阱)/buildingItemData/craftItemData(96 配方)/craftGroupData/alchemyRecipeData(3)/drinkMatData/foodMatData/foodData(53)/nodeTypeData(17)/nodeUpgradeData/weatherData/stageData(106 关)/zoneData/nodeBuffData/rewardConfigData/enemyRushTypeData/rushEnemyData/gameConst/basicConst/riftConst/developmentConst/questData/npcData/dialogData/questLineData/eventData/eventSceneData/eventChoiceData/expeditionData/shopGoodData/logisticsData/monthRushData(7)/rift*/archiveQuestData/achievementData(71)/baseUpdate(8)/developmentData(54 科技节点)/buildingNodeScoreData/seasonData(4)/racingData(7)/challengeModeData(4)/tutorialData`。
- `detail.sandboxV3TemplateData.sandbox_2`：**88 张子表** — 额外含 `modeDatas/mainMapData/nodeTypeData/exploreStage*/subStageData/stageDropData/navigationNodeIds/itemTypeData/bagItemTypeData/toolkitContentData/itemRandomPoolData/itemExtraData/developmentData/defendScoreData/zoneDefendDatas/basementUpdateDatas/basementPreviewDatas/wonderDatas/buildScoreGroupDatas/basementWeatherWeights/cookbookData/cookSpiceData/baseShop*/stageShopListData/shopDetailData/shopTypeCoinMap/shopGoodPoolData/eventExpeditionData/trapData/trapTypeData/baseTrapData(124)/electricTransferData(48)/electricBuildingList(5)/buildRuleData(7)/buildScoreData(24)/baseTrapUpgradeData/buildAnimalData/baseTrapDeployMap/processRecipeData(105)/buildRecipeData(63)/enemyRewardData/milestoneRewardPools(36)/recipeWeight/paramData(3)/relicData/bandDataMap(6)/modeType2BandIdListMap/taskSlotData/taskPoolData(29)/taskData/livestockData(12)/gameConst`。
- `itemData`：**632 个道具定义**（`itemType` 走 `SandboxPermItemType`：`COIN/BUILDINGMAT/FOODMAT/FOOD/STAMINAPOT/ANIMAL/RELIC/RECIPE/BASEBUILDING/TECHPOINT` 等 29 类，`SandboxPermItemType.cs:9-64`）。

##### 1.6 玩法骨架（由类 + Service + excel 还原）

**V2（沙洲遗闻，topicId=`sandbox_1`）**
1. **进入**：`createGame`(V2Service L9 `/sandboxPerm/sandboxV2/createGame`) → 服务端返回 `SANDBOX_V2[sandbox_1]` 的 `status.state=ACTIVE`，`main.game{mapId,day=1,maxDay,ap,maxAp}`（`PlayerSandboxV2.cs:121-148`）。
2. **驻扎地与建造**：`Build{book,building,tactical,animal}`(L1255-1278) + `BaseInfo{trapLimit,upgradeProgress}`(L80-115)；建造/拆除经 `/v2/build`、保存经 `/v2/homeBuildSave`；配方来自 `craftItemData`(96) 与 `alchemyRecipeData`(3, `onceAlchemyRatio:50`)。
3. **探索节点**：`main.map.node{zone,type:NodeType,state:NodeState,relate{pos,adj,depth},stageId,weatherLv}`(L192-223) + `main.stage.node→NodeStage`(L684-760)；`nextDay`/`settleDay`/`discardAp` 推进 `main.game.day`、`ap`。
4. **战斗**：`battleStart{topicId,nodeId,squadIdx}`(sig L453153) → 响应带 `isEnemyRush/extraRunes/lureInsect/shinyAnimals/shinyUniEnemy`(sig L453164)；`NodeStage` 记录 `action/actionKill/baseInfo/hpRatio` 战后态；`battleFinish` 提交 `SandboxOutput`(sig L453297) → 响应 `success/isEnemyRush/enemyRushCount/rewards/randomRewards`(sig L453307)。
5. **科技树/基地升级**：`Tech{token,cent,unlock[]}`(L1317-1336) + `developmentData` 54 节点（`frontNodeId/nextNodeIds/limitBaseLevel/tokenCost`）→ `/v2/unlockTech`；`baseUpdate` 8 级（`conditions/items/scoreFactor/repairCost/portableRepairCost`）→ `/v2/baseUpgrade`。
6. **敌袭/陌域**：`EnemyRush{enemyRushType,groupKey,state,day,path,enemy,boss}`(L812-855) + `RiftInfo.reservation`(L1461-1512) → `riftCreate/riftSetDifficulty/riftSetTeam/riftSettle/riftClose`。
7. **里程碑与结算**：`archive:Collect{pending{achievement,quest,music},complete{achievement,quest,music}}`(L1775-1826) + `Report/ReportSettle{scoreTotal,scoreRatio,techToken,techCent,shopCoin,shopCoinMax}`(L433-469)；`settleGame` 结算 → `achievementData` 71 项。
8. **挑战/竞速/月度**：`Challenge.ChallengeStatus`(L2033-2043) + `challengeModeData`(4) → `enterChallenge/settleChallenge/exitChallenge`；`Racing`(L1866-2027) + `racingData`(7) → 6 条 racing 端点；`monthRushData`(7) → `monthBattleStart/Finish`。

**V3（重启锚点，topicId=`sandbox_2`）** — 循环制「天-战斗-休整期」：
1. **进入 + 选乐队**：`createGame{topicId,nodeId,difficultyId}`(sig L429916) → `state=BAND_SELECT(0)` → `/v3/chooseBand` → `PlayerSandboxV3Band{level,cond,badge}`；`bandDataMap` 6 支乐队（`band_farmer`「精耕细作」/`band_merchant`「筹划经营」…），每支 3 级效果。
2. **基地建造（`base`）**：`Basement{level,cond,wonder,shop,building,animal,debris,score,production}`(`PlayerSandboxV3Basement.cs`) + `baseTrapData` 124 个陷阱 + `buildRecipeData` 63 条建造配方 + `processRecipeData` 105 条加工配方 + `buildRuleData` 7 条相连加分（`ROAD/CANAL/RAILWAY`）+ `buildScoreData` 24 条评分 → `/v3/homeSave`、`/v3/homeUpgrade`、`/v3/homeEnter`。
3. **电力**：`electricTransferData` 48 条建筑发电（例 `sandbox_2_building_base_pdline_1.powerOutput={"sandbox_2_basegold":0.1}`）+ `electricBuildingList` 5 + `current.game.power`/`save.powerValue` → 电力在 `SandboxV3BattleManager`/`Processor` 中结算（`Torappu.Battle.SandboxV3/` 109 文件）。
4. **探索**：`map{unlockZones,unlockNodes}` + `nodeTypeData`(`SandboxV3NodeType`: NONE/HOME/STORY/EXPLORE) + `exploreStageData/stageDropData` + `current.map{subStage,unlockIndex,initIndex}` + `current.save.levelRandomSaves`。
5. **战斗**：`battleStart{topicId}`(sig L430415) → `BattleStartResponse : CommonStartBattleResponse` 带 `battleShopId`(sig L430424)；`battleFinish` 带 `SandboxV3BattleFinishData`(sig L430449)；战内 `SandboxV3BattleShopManager` 提供战斗内商店。
6. **科技**：`development{token,unlock[]}` + `developmentData/developmentLineSegmentDatas` → `/v3/unlockTech`。
7. **日循环/日结**：`nextDay` → `PlayerSandboxV3CurrentDayPassSettlement{gainPower,pros,aesth,aesthCoin,weather}`；`weatherData` 6 种（`weather_normal`「晴朗」/`weather_rain`「阴雨」`enableFog:true`）；`paramData.prosParams` 按繁荣阈值给加成（`statparams_normal`: threshold 150/250/300/400/500/600/700 → plusValue 0.01→0.25）。
8. **生产/畜牧/烹饪**：`production{unlock,rate,refreshTs,harvestTs}`(`PlayerSandboxV3Harvest.cs`) → `/v3/productionRefresh`、`/v3/productionHarvest`；`livestockData` 12（`shinyRate:0.1`）→ 动物捕获；`cookbookData/cookSpiceData` + `current.bag.material` → `/v3/eatFood`。
9. **商店**：`baseShopGoodData/baseShopSellData/shopGoodPoolData/shopDetailData/shopTypeCoinMap/baseShopCoinList` + `SandboxShopCoinType`(`DIMENSION_COIN/GOLD/BASE_GOLD/BASE_GOLDEX`) → `homeShopBuy/homeShopSell/shopBuy/shopSell/shopRefresh/shopBuyRecruit`。
10. **招募**：`initRecruit/dayPassRecruit/getDailyRecruitList` + `dayPassRecruitRefreshCount:[0,10,20,30]`、`dayPassRecruitProfessionCount:3`、`tempRecruitPercentage:0.35`。
11. **任务/里程碑/结算**：`taskData/taskPoolData(29)/taskSlotData`（`SandboxV3TaskType` 21 种：`DEPLOY_TRAP_BY_GROUP/KILL_ENEMY/GATHER/CATCH_ANIMAL/PROSPERITY_REACH/RAILWAY_CHECK`…）→ `milestoneRewardPools`(36) + `current.save.milestoneSave`；`settleGame` → `SettleGameResponse{score:SandboxV3SettleGameScore, reward:SandboxV3SettleReward, detail:SandboxV3SettleDetail}`(sig L429995)。

---

#### 6.3.2 协议面清单（该域全部 Request/Response）

> 类全部位于 `Torappu.UI.SandboxPerm[.SandboxV2|.SandboxV3]` 命名空间。除特别注明外，**所有 Response 均继承 `Torappu.PlayerDeltaResponse`**（故服务端统一用 `PlayerDeltaResponse` 别名是类型安全的）；`sig` 列 = `reference/com.hypergryph.arknights_2.7.71.cs` 行号。
> **「高频」判定依据**：该端点是否位于每次进入沙盒/每次跨天/每次战斗的必经链路（由 Service 常量 + 流程骨架推断）。**【推测】** 无抓包样本佐证。

##### 2.1 公共（主题切换 / 固定）

| Request (sig) | 字段 | Response (sig) | 额外字段 | 服务端 |
|---|---|---|---|---|
| `SandboxPermChangeTopicRequest` (413418) | `topicId` | `SandboxPermChangeTopicResponse` (413427) | `int result` | L167 空 delta + `result:0` |
| `SandboxPermPinTopicRequest` (413436) | `topicId` | `SandboxPermPinTopicResponse` (413445) | — | L185 `202` |
> 客户端常量：`SandboxPermService.cs:9 CHANGE_TOPIC="/sandboxPerm/changeTopic"`、`:12 PIN_TOPIC="/sandboxPerm/pinTopic"`。

##### 2.2 V2 — 同步 / 进入与存档

| Request (sig) | 关键字段 | Response (sig) | 额外字段 | 服务器 |
|---|---|---|---|---|
| `SandboxV2CreateGameRequest` (452490) | `topicId` | `SandboxV2CreateGameResponse` (452499) | — | L195 空 delta |
| `SandboxV2LoadArchiveRequest` (452524) | `topicId` | `SandboxV2LoadArchiveResponse` (452533) | — | L495 `202` |
| `SandboxV2ReadArchiveRequest` (452938) | `topicId, int day` | `SandboxV2ReadArchiveResponse` (452948) | — | **无对应路由**（客户端 `READ_ARCHIVE="/load"` 复用 load）|
| `SandboxV2SettleGameRequest` (452507) | `topicId` | `SandboxV2SettleGameResponse` (452516) | — | L293 空 delta |
| `SandboxV2GuideLoadRequest` (453024) | `topicId` | `SandboxV2GuideLoadResponse` (453033) | — | L485 `202` |

##### 2.3 V2 — 建造与拆除 / 陷阱

| Request (sig) | 关键字段 | Response (sig) | 服务器 |
|---|---|---|---|
| `SandboxV2ConstructOperationRequest` (452757) | `topicId, nodeId, JArray operation, Dictionary<int,Dictionary<string,int>> catchedAnimals` | `SandboxV2ConstructOperationResponse` (452769) | L415 `202`（绑到 `/v2/build`）|
| `SandboxV2BasementUpgradeRequest` (453007) | `topicId` | `SandboxV2BasementUpgradeResponse` (453016) | L405 `202` |
| `SandboxV2SetSupplyRequest` (452902) | `topicId, List<int> charList` | `SandboxV2SetSupplyResponse` (452912) | L575 `202` |
| `SandboxV2RemoveSupplyRequest` (452920) | `topicId, int charInstId` | `SandboxV2RemoveSupplyResponse` (452930) | L515 `202` |

##### 2.4 V2 — 产出 / 采集 / 制造 / 烹饪

| Request (sig) | 关键字段 | Response (sig) | 额外字段 | 服务器 |
|---|---|---|---|---|
| `SandboxV2CraftRequest` (452613) | `topicId,itemId,count,autoSquad` | `SandboxV2CraftResponse` (452625) | `item:SandboxV2CommonRewardItem, toSquad` | L425 `202`（绑到 `/v2/cook`）|
| `SandboxV2CookFoodRequest` (452571) | `topicId,List<string> main,List<string> sub,int count` | `SandboxV2CookFoodResponse` (452583) | `instId, Cook.Food food, bool newBook` | L266 `202`（死路由）|
| `SandboxV2CookDrinkRequest` (452551) | `topicId,List<CookDrinkItem> material,food` | `SandboxV2CookDrinkResponse` (452562) | `item:CommonRewardItem` | L256 `202`（死路由）|
| `SandboxV2DineRequest` (452594) | `topicId,charInstId,foodInstId` | `SandboxV2DineResponse` (452605) | — | L246 `202` |
| `SandboxV2AlchemyRequest` (452635) | `topicId,recipeId,count` | `SandboxV2AlchemyResponse` (452646) | `item:CommonRewardItem` | L395 `202` |
| `SandboxV2ExpeditionRequest` (452708) | `topicId,nodeId,eventId,choiceId,List<int> charList` | `SandboxV2ExpeditionResponse` (452721) | `bool finish` | L615 `202`（`/v2/startMission`）|

##### 2.5 V2 — 科技树 / 基地升级
`SandboxV2ScienceUnlockRequest{topicId,techId}` (452884) → `SandboxV2ScienceUnlockResponse` (452894)，服务器 L635 `202`；`SandboxV2BasementUpgradeRequest` 见 2.3。

##### 2.6 V2 — 探索与关卡（战斗开始/结束）

| Request (sig) | 基类 | 关键字段 | Response (sig) | 额外字段 |
|---|---|---|---|---|
| `SandboxV2BattleStartRequest` (453153) | `System.Object` | `topicId,nodeId,int squadIdx` | `SandboxV2BattleStartResponse` (453164) | **基类 `CommonStartBattleResponse`** + `isEnemyRush, extraRunes, lureInsect, shinyAnimals, shinyUniEnemy` |
| `SandboxV2BattleFinishRequest` (453297) | **`CommonFinishBattleRequest`** | `topicId, Torappu.Battle.Sandbox.SandboxOutput sandboxV2Data` | `SandboxV2BattleFinishResponse` (453307) | 基类 `CommonFinishBattleResponse` + `success, isEnemyRush, enemyRushCount, rewards, randomRewards` |
| `SandboxV2MonthBattleStartRequest` (453261) | `System.Object` | `topicId,int squadIdx,monthRushId` | `SandboxV2MonthBattleStartResponse` (453272) | `CommonStartBattleResponse` + `extraRunes` |
| `SandboxV2MonthBattleFinishRequest` | `CommonFinishBattleRequest` | (同 V2 基础) | `SandboxV2MonthBattleFinishResponse` (453399) | `success, enemyRushCount, firstPass` |
| `SandboxV2ExploreModeRequest` (453127) | `System.Object` | `topicId,int mode` | — (无 Response 类) | 服务器 L361 空 delta（**死路由**）|
| `SandboxV2DiscardApRequest` (452956) | `topicId` | | `...Response` (452965) | L435 `202` |

##### 2.7 V2 — 事件与对话 / 商店 / 挑战 / 裂隙 / 竞速

| 分组 | Request (sig) | 关键字段 | Response (sig) | 额外字段 | 服务器 |
|---|---|---|---|---|---|
| 事件 | `SandboxV2EventChoiceRequest` (452685) | `topicId,nodeId,eventId,choiceId` | `SandboxV2EventChoiceResponse` (452697) | `success, List<RewardItemModel> items, finish` | L378 空 delta |
| 商店 | `SandboxV2ShopBuyRequest` (452655) | `topicId,int index,int count` | `SandboxV2ShopBuyResponse` (452676) | `item:SandboxV2ShopBuyItem` | L605 `202` |
| 挑战 | `SandboxV2StartChallengeRequest` (453041) | `topicId` | (453050) | — | L445 `202` |
| 挑战 | `SandboxV2ChallengeSettleRequest` (453093) | `topicId` | (453102) | — | L585 `202` |
| 挑战 | `SandboxV2ChallengeExitRequest` (453110) | `topicId` | (453119) | — | L455 `202` |
| 挑战 | `SandboxV2GetChallengeRewardRequest` (453058) | `topicId,List<string> rewardIds` | (453068) | `items:List<RewardItem>` | L475 `202` |
| 裂隙 | `SandboxV2RiftCreateRequest` (452813) / `RiftSetDifficultyRequest` (452777) `{topicId,difficulty}` / `RiftSetTeamRequest` (452795) `{topicId,team}` / `RiftSettleRequest` (452830) / `RiftCloseRequest` (452867) | | (…Response 一一对应) | — | L535/L545/L555/L565/L525 全 `202` |
| 天数 | `SandboxV2NextDayRequest` (452973) / `SandboxV2SettleDayRequest` (452990) | `topicId` | (452982 / 452999) | — | L505 / L595 `202` |
| 编队 | `SandboxV2SetSquadRequest` (452847) | `topicId,int index,List<RequestSquadSlot> slots,List<string> tools` | (452859) | — | L276 空 delta |
| **竞速** | `SandboxV2RacingBattleStartRequest` (453197) | `topicId,nodeId,instId` | (453208) | `CommonStartBattleResponse` + `myRacer, racers[], extraRunes`；`RacerInfo{inst,id,attrib,skill}`(453223)、`RacerTalent{Blackboard born,learned}`(453235) | L1116 `202` / L1130 `202` |
| 竞速 | `SandboxV2RacingBattleFinishRequest` (453336) | `CommonFinishBattleRequest` + `topicId, Racing.RacingOutput racingData` | (453346) | `giveUp,myRacer,myMedalId,rankList[],isNewBest,bestTime,rewards`；`RacerInfo{inst,id,name,time}`(453365) | L1106 `202` |
| 竞速 | `SandboxV2RacingRegisterRequest` (452401) | `topicId,instId` | (452411) | `Racing.RacerName name` | L1159 `202` |
| 竞速 | `SandboxV2RacingReleaseRequest` (452420) | `topicId,List<string> instIds,bool tmp` | (452431) | — | L1169 `202` |
| 竞速 | `SandboxV2RacingLearnTalentRequest` (452439) | `topicId,instId` | (452449) | `instId, talent` | L1149 `202` |
| 竞速 | `SandboxV2RacingSaveMarkRequest` (452459) | `topicId,instId,bool mark` | (452470) | `instId, mark` | L1179 `202` |

##### 2.8 V3 — 进入/模式/基地/生产/科技/防守

| 分组 | Request (sig) | 关键字段 | Response (sig) | 额外字段 | 服务器 |
|---|---|---|---|---|---|
| 进入 | `SandboxV3CreateGameRequest` (429916) | `topicId,nodeId,difficultyId` | `SandboxV3CreateGameResponse` (429927) | — | L799 **硬编码 delta** |
| 进入 | `SandboxV3GiveUpGameRequest` (429935) | `topicId` | (429944) | — | L879 `current:null` |
| 模式 | `SandboxV3SwitchModeRequest` (430106) | `topicId,modeId` | (430116) | — | L645 空 delta |
| 基地 | `SandboxV3EnterBaseRequest` (430558) | `topicId` | (430567) | — | L720 空 delta |
| 基地 | `SandboxV3BuildSaveRequest` | **无 CS 请求类**（仅 Response 430575） | `SandboxV3BuildSaveResponse` (430575) | — | L759 空 delta |
| 基地 | `SandboxV3HomeUpgradeRequest` (430199) | `topicId` | (430208) | **`List<ItemGet> items`** | L786 `202` |
| 生产 | `SandboxV3RefreshHarvestRequest` (429952) | `topicId` | (429961) | — | L663 硬编码 `refreshTs` |
| 生产 | `SandboxV3HarvestRequest` (429969) | `topicId` | (429978) | — | L695 空对象 |
| 科技 | `SandboxV3UnlockTechRequest` (430144) | `topicId,techId` | (430154) | — | L1079 `tech:{}` |
| 防守 | `SandboxV3ChangeDefendRequest` (430162) | `topicId,zoneId,int operate,List<int> chars` | (430174) | — | L930 `map:{}` |
| 乐队 | `SandboxV3ChooseBandRequest` (430067) | `topicId,bandId` | (430077) | — | L957 `202` |
| 日循环 | `SandboxV3NextDayRequest` (430182) | `topicId` | (430191) | — | L1007 `202` |

##### 2.9 V3 — 战斗 / 事件 / 商店 / 招募 / 结算

| 分组 | Request (sig) | 关键字段 | Response (sig) | 额外字段 | 服务器 |
|---|---|---|---|---|---|
| 战斗 | `SandboxV3BattleStartRequest` (430415) | `topicId` | (430424) | **基类 `CommonStartBattleResponse`** + `battleShopId` | L906 `202` |
| 战斗 | `SandboxV3BattleFinishRequest` (430449) | **`CommonFinishBattleRequest`** + `topicId, SandboxV3BattleFinishData sandboxV3Data` | (430459) | 基类 `CommonFinishBattleResponse` | L916 `202` |
| 事件 | `SandboxV3EventChoiceRequest` (430085) | `topicId,choiceId,List<int> charList` | (430096) | `items:List<SandboxV3RspGainItem>, finish` | L987 `202` |
| 商店 | `SandboxV3BaseShopBuyRequest` (430217) | `topicId,goodId,int count` | (430228) | **`items:List<SandboxV3RspGainItem>`** | L740 空 delta |
| 商店 | `SandboxV3BaseShopSellRequest` (430237) | `topicId,itemId,int count` | (430248) | **`items`** | L776 `202` |
| 商店 | `SandboxV3ShopBuyRequest` (430257) | `topicId,int index,int count` | (430268) | **`items`** | L1037 `202` |
| 商店 | `SandboxV3ShopSellRequest` (430294) | `topicId,itemId,int count` | (430305) | **`items`** | L1067 `202` |
| 商店 | `SandboxV3ShopRefreshRequest` (430277) | `topicId` | (430286) | — | L1057 `202` |
| 招募 | `SandboxV3InitRecruitRequest` (430331) | `topicId,List<RequestSquadSlot> ownChars,SquadFriendData assistFriend` | (430342) | — | L1017 `202` |
| 招募 | `SandboxV3GetDayPassRecruitListRequest` (430350) | `topicId,bool refresh` | (430360) | **`subProfessionList,tempCharList,rookieCharList`** | L997 `202` |
| 招募 | `SandboxV3DayPassRecruitRequest` (430371) | `topicId,RequestSquadSlot ownChar,SandboxV3DayPassRecruitThirdCharData thirdChar` | (…Response) | — | L967 `202` |
| 招募 | `SandboxV3ShopBuyRecruitRequest` (430314) | `topicId` | (430323) | — | L1047 `202` |
| 进食 | `SandboxV3EatFoodRequest` (430124) | `topicId,charInstId,cookbook,List<string> sub` | (430136) | — | L977 `202` |
| 结算 | `SandboxV3SettleGameRequest` (429986) | `topicId` | (429995) | **`SettleGameScore score, SettleReward reward, SettleDetail detail`** | L1027 `202` |

**高频链路（骨架必经，服务端全为桩）【推测】**：
`createGame` → `chooseBand` → `homeEnter` → `homeSave`/`homeUpgrade` → `nextDay` → `productionRefresh`/`productionHarvest` → `battleStart`/`battleFinish` → `getDailyRecruitList`/`dailyRecruit` → `shopRefresh`/`shopBuy` → `unlockTech` → `settleGame`（V3，13 步，**全部为桩**）；
V2 对应：`createGame` → `setSupply`/`setSquad` → `build`/`homeBuildSave` → `nextDay`/`settleDay` → `battleStart`/`battleFinish` → `eventChoice` → `shopBuy` → `unlockTech`/`baseUpgrade` → `settleGame`（**全部为桩**）。

---

#### 6.3.3 关键规则（代码 / 数据证据）

##### 3.1 状态机转移（已确证）

| 规则 | 证据 |
|---|---|
| V2 会话状态 4 态 | `PlayerSandboxV2.cs:11-21` `INACTIVE→ACTIVE→SETTLE_DATE→READING_ARCHIVE` |
| V2 节点 3 态 | `PlayerSandboxV2.cs:24-32` `LOCKED→UNLOCKED→COMPLETED` |
| V2 关卡 3 态 | `PlayerSandboxV2.cs:35-43` `UNEXPLORED→EXPLORED→COMPLETED` |
| V2 裂隙 3 态（含哨兵值 99） | `PlayerSandboxV2.cs:1515-1523` `ACTIVE=0, SETTLE=1, INVALID=99` |
| V2 挑战 4 态 | `PlayerSandboxV2.cs:2033-2043` `NOT_IN_CHALLENGE=0, IN_CHALLENGE=1, CHALLENGE_SETTLE=2, UNDEFINED=99` |
| V3 会话 8 态（`NONE=-1` 起） | `PlayerSandboxV3GameState.cs:9-23` `BAND_SELECT(0)→INIT_GAP→IN_BATTLE→GAP_REPORT→EXPEDITION→NORM_GAP→GAME_FINISH(6)` |
| V3 节点 3 态 | `PlayerSandboxV3Node.cs:9-17` `UNLOCK→PLAYED→PASSED` |
| V3 难度 3 态 | `app/game/excel/types-playerdata.ts:182`（由 CS 生成）`LOCK/UNLOCK/PASSED` |
| V3 任务/对话态 | `types-playerdata.ts:180` `UNCOMPLETE/COMPLETED/CLOSED`；`:178` `NONE/BEFORE_BATTLE/IN_BATTLE/AFTER_BATTLE` |
| 挑战模式开关字段名易错 | `PlayerSandboxV2.cs:2123-2124` `[JsonProperty("hasSettleDayDoc")] bool challengeModeActivated`；`:2128 hasEnteredOnce` |

##### 3.2 数值上限（Excel 实测值，非注释）

| 项 | 值 | 证据 |
|---|---|---|
| V3 电力上限 | `electricPowerMax = 99999` | `SandboxV3GameConst.cs:239` 声明；值见 `sandbox_perm_table.json` → `detail.sandboxV3TemplateData.sandbox_2.gameConst.electricPowerMax` |
| V3 基地金币上限 | `baseCoinMax = 9999999` | `SandboxV3GameConst.cs:71` |
| V3 生命点 | `maxLifePoint = 3` | `SandboxV3GameConst.cs:143` |
| V3 干员上限 | `characterLimit = 8` | `SandboxV3GameConst.cs:139` |
| V3 初始/最大 cost | `initialCost = 10` / `maxCost = 999` | `SandboxV3GameConst.cs:147/151` |
| V3 科技点总量 | `developmentPointsTotal = 341` | `SandboxV3GameConst.cs:75` |
| V3 防守次数/进度量 | `maxDefendCount = 3` / `defendProgressVolume = 36` | `SandboxV3GameConst.cs:19/23` |
| V3 商店刷新价 | `refreshPrice = 20`, `multiplyFactor = 2`, `maxRefreshPrice = 10000` | `SandboxV3GameConst.cs:119/123/127` |
| V3 配方刷新价 | `recipeRefreshPriceInit = 5` / `Add = 3` / `Max = 35`（货币 `sandbox_2_gold`） | `SandboxV3GameConst.cs:247/251/255/259` |
| V3 招募价 | `recruitStartPrice = 200`, `recruitPriceMultiply = 2`, `recruitBuyTime = 1` | `SandboxV3GameConst.cs:83/87/79` |
| V3 任务槽 | `taskOptionCnt = 3` | `SandboxV3GameConst.cs:171` |
| V3 幸运奖励上限 | `luckyRewardMax = 4` | `SandboxV3GameConst.cs:295` |
| V2 科技点总量 | `techPointsTotal = 445` | `SandboxV2DevelopmentConst.cs:10` |
| V2 存档位 | `maxSaveCnt = 2` | `SandboxV2GameConst.cs:63` |
| V2 编队/工具箱 | `squadCharCapacity = 12`, `totalSquadCnt = 8`, `toolboxCapacity = 12`, `toolCntLimitInSquad = 15` | `SandboxV2BasicConst.cs:131/135/139/143` |
| V2 后勤位 | `logisticsPosLimit = 18`（`logisticsUnlockLevel = 3`） | `SandboxV2BasicConst.cs:59/63` |
| V2 敌袭同时存在上限 | `maxEnemyCountSameTimeInRush = 300` | `SandboxV2GameConst.cs:55` |
| V2 食物时长上限 | `maxFoodDuration = 30` | `SandboxV2BasicConst.cs:39` |
| V2 饮料/工作台次数 | `drinkMakeLimit = 99`, `workbenchMakeLimit = 99` | `SandboxV2BasicConst.cs:47/55` |
| V2 斥候/珍贵斥候 | `unitFenceLimit = 1`, `unitRareFenceLimit = 2` | `SandboxV2BasicConst.cs:87/91` |
| V2 基地/港口修理费 | `baseRepairCost = 440`, `portRepairCost = 250` | `SandboxV2BasicConst.cs:79/83` |
| V2 饮品消耗 | `miniSquadDrinkCost = 2`, `normalSquadDrinkCost = 3`, `emptySquadDrinkCost = 2`, `drinkCostOnce = 60` | `SandboxV2BasicConst.cs:155/159/163/43` |

##### 3.3 结算与产出公式

| 规则 | 证据 |
|---|---|
| **建造拆除返还 90%** | `buildRecipeData.sandbox_2_recipe_infrastructure_1.withdrawRatio = 90`（V3，63 条配方均含 `withdrawRatio`）；`SandboxV3BuildRecipeData.cs:31 withdrawRatio` |
| **V2 合成返还同 90%** | `craftItemData.sandbox_1_building_1.withdrawRatio = 90`、`outputRatio = 1`（`SandboxV2`，96 条） |
| **V2 炼金 50% 产出比** | `alchemyRecipeData.alchemy_lv1.onceAlchemyRatio = 50`（`SandboxV2AlchemyRequest{topicId,recipeId,count}`，3 条配方） |
| **电力产出** | `electricTransferData.<buildingId>.powerOutput = {<coinId>: <rate>}`，如 `sandbox_2_building_base_pdline_1 → {"sandbox_2_basegold": 0.1}`、`_2 → 0.12`（48 条）；`skillParam:"1000"` |
| **基地建造相连加分** | `buildRuleData`：`{buildType1:1, buildType2:["ROAD"], extraBuildScore:5, extraScoreDesc:"道路相连"}`、`{2,["CANAL"],10}`…（7 条）；`SandboxV3BuildRuleData.cs:11-27` |
| **建造评分表** | `buildScoreData.<itemId>.buildScore`，如 `basenpc_xb2mtr → 20`（24 条）；`SandboxV3BuildScoreData.cs:18` |
| **繁荣→属性加成阶梯** | `paramData.statparams_normal.prosParams = [{threshold:150,plusValue:0.01,level:0} … {threshold:700,plusValue:0.25,level:2}]` |
| **V2 生息基数/评分** | `gameConst.techProgressScore = 200`（`SandboxV2GameConst.cs:107`）；`daysBetweenAssessment = 3`（`:43`） |
| **季节循环** | `seasonTransitionLoop = [2,1,0]`、`seasonDurationLoop = [20,20,20]`、`firstSeasonDuration = 18`、`firstSeasonStartAngle = 90`、`seasonTransitionAngleLoop = [30,-30,90]`（`SandboxV2GameConst.cs:67/71/75/79/83`） |
| **V3 科技点→货币比** | `techTokenRatio = 5e-05`（`SandboxV3GameConst.cs:291`） |
| **V3 放弃奖励** | `giveUpRewardItemId = "sandbox_2_gold"`, `giveUpRewardItemCnt = 15`（`SandboxV3GameConst.cs:155/159`） |
| **V3 重复产出折算** | `repeatRecipeConvertId = "sandbox_2_gold"`, `repeatRecipeConvertCount = 15`, `repeatRelicConvertId = "sandbox_2_guarantee_1"`, `recipeRepeatDamp = 0`, `taskRepeatDamp = 0`（`SandboxV3GameConst.cs:195-207/167/175`） |
| **V3 美学奖励** | `aestheticsRewardItem = "sandbox_2_dimensioncoin"`（`SandboxV3GameConst.cs:191`） |
| **V3 招募集数** | `dayPassRecruitRefreshCount = [0,10,20,30]`、`dayPassRecruitSubProfessionCount = 8`、`dayPassRecruitProfessionCount = 3`、`tempRecruitPercentage = 0.35`（`SandboxV3GameConst.cs:267/271/275/279`） |
| **V3 模式难度系数** | `SandboxV3ModeData.cs:31 float difficultyFactor`；`defaultModeId = "sandbox_2_mode_normal"`、`defaultDifficultyId = "difficulty_0"`、`hardDifficultyLevel = 3`（`SandboxV3GameConst.cs:27/31/35`） |
| **V3 日结字段** | `PlayerSandboxV3CurrentDayPassSettlement.cs:10-26 gainPower/pros/aesth/aesthCoin/weather` |
| **V2 报告评分构成** | `PlayerSandboxV2.cs:437-458 scoreTotal/scoreRatio/techToken/techCent/shopCoin/shopCoinMax`；`:306-336 dayScore/hasRift/riftScore/apScore/exploreScore/enemyRushInfo/homeInfo/make{tacticalScore,foodScore}` |

##### 3.4 随机与保底

| 规则 | 证据 |
|---|---|
| **V3 稀有畜牧闪光概率 10%** | `livestockData.<enemyId>.shinyRate = 0.1`（12 条，如 `enemy_7004_xbdeer`）；`SandboxV3LivestockData.cs:30` |
| **彩虹闪光倍率 5×** | `rainbowShinyAnimalRateMul = 5`（`SandboxV3GameConst.cs:335`） |
| **V2 任务池权重** | `taskPoolData.quest_pool_1.taskWeights = [{taskId:"quest_stage01_3",weight:10},{...,10}]`（V3，29 池）；V2 侧对应 `questData/npcData` + `SandboxV2QuestRouteType`(NONE/ENEMY_RUSH/EVENT/NODE/NPC) |
| **V2 奖励组** | `rewardConfigData` + `SandboxV2RewardConfigGroupData.cs`、`SandboxV2RewardCommonConfig.cs`、`SandboxV2RewardData.cs` |
| **V3 商店折扣范围** | `shopDiscountRate = 0.1`、`shopDiscountNumMin/Max = 1/1`、`shopDiscountValueMin/Max = 0.5/0.5`（`SandboxV3GameConst.cs:99-115`）；运行时折扣存 `SandboxV3EffectData.shopRefreshDiscount` |
| **V3 任务刷新保底** | `taskPredecessorRampUp = 6`、`taskOriginRefreshTimes = 1`、`recipeOriginRefreshTimes = 1`（`SandboxV3GameConst.cs:331/179/163`） |
| **V3 里程碑奖励池** | `milestoneRewardPools` 36 池（如 `recipe_pool_process_l1` 7 项 / `_l2` 10 项）；`milestoneRewardPools` 与 `current.save.milestoneSave{finishTimes,cache}`（`SandboxV3MilestoneSave.cs:12/16`）配套 |
| **V3 随机地图池 / 额外敌人** | `randomMapPool`、`extraLoadEnemies`、`recipeWeight`、`basementWeatherWeights`（`SandboxV3Data.cs` 对应字段） |
| **V2 月度敌袭条件组** | `monthRushData[].conditionGroup = "server_sandbox_1..."`、`rushGroupKey = "monthly_1"`、`weatherId`、`nodeId`（7 条） |

---

#### 6.3.4 与服务端实现的差异比对

##### 4.1 量化基线

- `app/game/modules/sandbox/` 共 3 文件 2280 行（`routes.ts` 1199 + `sandbox.ts` 669 + `sandbox.schema.ts` 437）。
- **`sandbox.ts` 无任何函数/类，只有 `export interface` / `export type`**（L1-669，全部是类型别名，如 `SandboxV2BattleFinishRequest {}` L51、`SandboxV3BuildSaveRequest {}` L325）。
- **`routes.ts` 内 `player.update(` = 0 次**（`grep -c` 实测；`gainItem` 亦为 0 次）⇒ **无任何持久化**。
- **V3 是否有任何真实实现：没有。** 26 条端点中 16 条 202、4 条空 delta、6 条硬编码字符串/字面量对象；即使 `createGame`（L799-871）返回了看似完整的 `current` 结构，也是**每次请求现场拼装的常量**，不落库、不读库。

| 分类 | V2 | V3 | Racing | Perm | 合计 |
|---|---|---|---|---|---|
| 202 空响应 | 35 | 16 | 8 | 1 | **53**（含 6 条别名）|
| 200 空 `modified:{}` | 6 | 4 | (6 条 `player.delta`≡空) | 0 | **15 + 6** |
| 硬编码非空 delta | 0 | 6 | 0 | 0 | **6** |
| 真实状态读写 | 0 | 0 | 0 | 0 | **0** |

- **无该域实现的旁证**：`grep -rn 'sandbox\|Sandbox' app/game/modules/activities/ --include=*.ts` **零命中**；`app/game/modules/templateTrap/*.ts` 对 sandbox **零命中**；`app/` 内 `sandboxPerm` 仅出现在生成类型（`types-playerdata.ts:5807`）、路由挂载注释（`routes.ts:15/62/84/159-163`）与沙盒模块自身。

##### 4.2 差异清单

| # | 级别 | 客户端证据 | 服务端证据 | 分类 |
|---|---|---|---|---|
| **D1** | **P0** | `PlayerSandboxPerm.cs:14-20` 定义 `SANDBOX_V2/SANDBOX_V3` 两张存档表；`types-playerdata.ts:5807 sandboxPerm: PlayerSandboxPerm` | `routes.ts` 全文 `player.update(` **0 次**、`gainItem` 0 次；除 `createGame` 外无任何 handler 触碰 `sandboxPerm` | **缺失（无持久化）** |
| **D2** | **P0** | V3 状态机 `PlayerSandboxV3GameState.cs:9-23`（8 态）；`PlayerSandboxV3CurrentGame.cs:11-56`（12 子块） | `routes.ts:799-871` `createGame` 硬编码：`nodeId:""`(L819)、`state:0`(L820)、`idx:21`(L822)、`day:1`(L826)、`weather:"weather_rain"`(L827)、`windDir:"UP"`(L828)、`power:0`(L829)、`pros:0`/`aesth:0`(L830-831)、`band.id:""`/`level:0`(L839-841)、`shopRefreshDiscount:10`(L849)、`taskRefreshAdd:1`(L859)、`save:null`(L861) | **行为不一致（伪状态）** |
| **D3** | **P0** | `PlayerSandboxV3Development.cs:10 token` / `:14 unlock:string[]`；`PlayerSandboxV3Basement.cs:12 level`；`PlayerSandboxV3Harvest.cs:11 unlock`/`:15 rate`/`:19 refreshTs`/`:23 harvestTs`；`PlayerSandboxV3CurrentSave.cs:47 powerValue` | `/v3/unlockTech`(L1079-1099) 返回 `tech:{}`；`/v3/productionHarvest`(L695-713) 返回 `{}` L705；`/v3/homeUpgrade`(L786) 202；`/v3/changeDefend`(L930) `map:{}` L941；`/v3/giveUpGame`(L879) `current:null` L890；`/v3/nextDay`(L1007) 202 | **stub** |
| **D4** | **P0** | `PlayerSandboxV2.cs:1317-1336 Tech{token,cent,unlock[]}`；`:80-115 BaseInfo{baseLv,trapLimit,upgradeProgress}`；`:1255-1278 Build{building,tactical,animal}`；excel `detail.sandboxV2TemplateData.sandbox_1` 72 张子表（`stageData` 106 / `developmentData` 54 / `craftItemData` 96 / `baseUpdate` 8） | `/v2/unlockTech`(L635) 202、`/v2/baseUpgrade`(L405) 202、`/v2/build`(L415) 202、`/v2/createGame`(L195) 空 delta、其余 V2 全桩 | **缺失（数据齐备但零消费）** |
| **D5** | **P0** | sig `453164 SandboxV2BattleStartResponse : CommonStartBattleResponse` + `isEnemyRush/extraRunes/lureInsect/shinyAnimals/shinyUniEnemy`；sig `453307 ...BattleFinishResponse : CommonFinishBattleResponse` + `success/rewards/randomRewards/enemyRushCount`；sig `430424 SandboxV3BattleStartResponse : CommonStartBattleResponse` + `battleShopId`；sig `430449 SandboxV3BattleFinishRequest : CommonFinishBattleRequest` | `sandbox.ts:461` 把 `SandboxV2BattleStartResponse` 直接 `= PlayerDeltaResponse`（自述「服务端省略 battleId 等协议字段」L460）；`:464` 同 `BattleFinishResponse`（自述「省略结果字段」L463）；`routes.ts:216` V2 battleStart 空 delta、`:233` battleFinish 空 delta、`:906/:916` V3 战斗双 202。与 `design-spec.md`「battleStart lacks battleId」一致 | **缺失（战斗链路断裂）** |
| **D6** | **P1** | 客户端 Service 常量：`SandboxV2Service.cs:12 COOK_DRINK="/…/sandboxV2/extract"`、`:15 COOK_FOOD="/…/sandboxV2/cook"`、`:18 WORKBENCH_CRAFT="/…/sandboxV2/build"`、`:30 CONSTRUCT_SAVE="/…/sandboxV2/homeBuildSave"`；CS 类 `SandboxV2CookDrinkRequest`(sig 452551)/`SandboxV2CookFoodRequest`(452571)/`SandboxV2CraftRequest`(452613)/`SandboxV2ConstructOperationRequest`(452757) | `sandbox.ts:165 SandboxV2ExtractRequest {}`（注释「服务端自定义，无 CS 对应类」）；`:95 SandboxV2HomeBuildSaveRequest {}`（同注释 L94）；`routes.ts:415 /v2/build` 绑 `ConstructOperation`、`:425 /v2/cook` 绑 `CraftRequest`、`:256 /v2/cookDrink` 绑 `CookDrinkRequest`、`:266 /v2/cookFood` 绑 `CookFoodRequest` | **行为不一致（路径↔协议类错位，4 处）**【推测：依据常量名 + CS 类名，未读到调用点】 |
| **D7** | **P1** | 客户端 69 条端点字面量全集（`SandboxPermService.cs:9/12`、`SandboxV2Service.cs:9-129`、`SandboxV3Service.cs:9-84`，字节级扫描产出，**不含** `/cookDrink`、`/cookFood`、`/exploreMode`、`/racingXxx`）；`SandboxV2Service.cs:111 EXPLORE_MODE="/sandboxPerm/sandboxV2/switchMode"` | 服务端独有 9 条：`routes.ts:256 /v2/cookDrink`、`:266 /v2/cookFood`、`:361 /v2/exploreMode`（真死路由）+ `:1106/1116/1149/1159/1169/1179 /racingXxx`（别名，且 `:1130 /v2/racing/battleStart`、`:1140 /v2/racing/battleFinish` 会遮蔽循环注册的 `:1193` 同路径 handler） | **行为不一致（死路由/重复注册）** |
| **D8** | **P1** | `PlayerSandboxV3Harvest.cs:15 rate` + `:23 harvestTs` 是收取量计算输入；`SandboxV3BaseShopBuyResponse.items`(sig 430228)、`SandboxV3ShopBuyResponse.items`(430268)、`SandboxV3BaseShopSellResponse.items`(430248)、`SandboxV3ShopSellResponse.items`(430305)、`SandboxV3HomeUpgradeResponse.items`(430208，`List<ItemGet>`)、`SandboxV3EventChoiceResponse.items`(430096)、`SandboxV3SettleGameResponse{score,reward,detail}`(429995)、`SandboxV3GetDayPassRecruitListResponse{subProfessionList,tempCharList,rookieCharList}`(430360)、`SandboxV2EventChoiceResponse{success,items,finish}`(452697) | `routes.ts:676 refreshTs: now()` 为唯一写入字段；`:705` 收取返回 `{}`；`sandbox.ts:605` 自述「服务端省略 items」（`:614/641/644/653/656/665` 同类）；`:644` 明示省略 `subProfessionList/tempCharList/rookieCharList` | **部分实现（响应字段缺口）** |
| **D9** | **P2** | excel `itemData` 632 项 + `SandboxPermItemType`(29 类) 完整道具体系；`PlayerSandboxV2.cs:1285 Bag.material`、`:1307 Bank.coin`、`:1416 Shop.slots{price}` | `/v2/shopBuy`(L605) 202、`/v3/shopBuy`(L1037) 202、`/v3/homeShopBuy`(L740) 空 delta、`/v3/shopSell`(L1067) 202 —— **玩法内商店全不可用**；仅 `templateShop` 模块提供 `sandbox_1/2` 模板商店（`design-spec.md:1902` 记录已复制 `data/shop/templateShop.json`） | **缺失** |
| **D10** | **P2** | `SandboxV2NodeType`（18 值，`SandboxV2NodeType.cs:9-46`）与 `SandboxV3NodeType`（4 值，`SandboxV3NodeType.cs:9-18`）；`SandboxV3MapNodeData.cs:11-43`（`frontNodeId/unlockTileIdList/gridPos/height`） | 无任何 handler 读 `nodeId` 并做节点/地图迁移：V2 `battleStart`(L212-222) 虽 zod 收 `nodeId`(schema L40) 但 handler 仅 `req.body as ...` 后丢弃；V3 `createGame` 收 `nodeId`(L801 只解构 `topicId`) 后忽略 | **stub** |
| **D11** | **P2** | `docs/prts-wiki-实现评估-2026-09-09.md:925` 已记录：`Sbv2*` 事件因「玩法层空壳」无法接线；`app/game/modules/medal/medal.ts:759-978` 定义 11 个 `Sbv2*` 模板，其 update 全为「注册后天数」占位（如 `:765-777 Sbv2UpgradeBase`、`:785-798 Sbv2FinishQuest`） | 同上 D1-D4（无任何 `sandboxPerm` 写入）⇒ 勋章进度恒为 0，条件永不可达 | **缺失（下游依赖断裂）** |

##### 4.3 修复优先级建议（供总装参考）

1. **P0-1 建立持久化骨架**：在 `modules/sandbox/` 增加 manager（参照 `design-spec.md§35.9` 的「域内实体 Instance 类」范式），以 `player.update` 写入 `sandboxPerm.template.SANDBOX_V2|V3[topicId]`，先把 `createGame`/`nextDay`/`settleGame` 三条打通（其余端点才有意义）。
2. **P0-2 消灭伪状态**：`routes.ts:799-871` 的硬编码 `current` 改为按 excel（`nodeId=basementNodeId`、`modeId=defaultModeId`、`difficultyId=defaultDifficultyId`、`weather` 从 `weatherData` 抽签）生成并入档。
3. **P0-3 修复路径↔协议类绑定**（D6）并删除 3 条死路由 + 6 条 racing 别名（D7），同时把 zod 中 `topicId` 由 `optional` 收紧为必填（`sandbox.schema.ts:34` 等）。
4. **P1-1 补齐响应字段**（D8）：`items`（6 处）、`SettleGameResponse{score,reward,detail}`、`GetDayPassRecruitList{...}`、`BattleStartResponse` 基类字段。
5. **P1-2 战斗链路**：与 battle 模块对齐 `CommonStartBattleResponse`/`CommonFinishBattleResponse` 的 `battleId` 契约（与 design-spec「非练习战斗链路不完整」同源）。

---

### 6.4 三域合并结论：实现完整度与差异清单（P0/P1/P2）

#### 5.4.1 成熟度总表

| 子域 | 客户端规模（命名空间文件数） | 服务端规模 | 判断 | 一句话依据 |
|---|---|---|---|---|
| 基建 Building | `Torappu.Building*` 约 600（含 UI 131 / DIY.UI 100 / Meeting 63 / SM 46） | `modules/building/` **9 213 行** + `character`（训练室/charBuild）/`shop`（家具商店） | **已实现（玩法深度高，但有 2 条 P0 契约错配）** | `handler.ts` 注册 65 条路由，全部先调用 `player.building.*` 管理逻辑；`res.sendStatus(202)`（纯空响应）**0** 条，27 条以 `res.status(202).send(player.delta)` 返回（HTTP 状态约定，非桩）；时间结算/制造/贸易/线索/BGU 语义/buff 引擎齐备（5.1、`docs/module-audit-2026-08-29.md:20`） |
| 肉鸽 rlv2 | `Torappu.UI.Roguelike*` 1 300+、协议 59 Request/57 Response | `modules/roguelike/` **37 783 行**（`modules/` 子模块 11 个） | **大部分实现（rogue_6 深做、其余 5 主题骨架）** | rlv2 handler **69** 条路由（另有旧 v1 `routes.ts` 6 条）；63 条客户端可见 `/rlv2|/activity/roguelike` 路径仅 `/rlv2/finishGame` 无注册；模块工厂/骰子/铜币存在结构性缺口（5.2） |
| 生息演算 SandboxPerm | `Torappu.UI.SandboxPerm*` 1 322、协议 68 Request/69 Response | `modules/sandbox/` 共 **2 303 行**（routes 1 198 + sandbox.ts 669 仅类型 + schema 436） | **未实现（只有协议壳）** | 74 条顶层路由 + 1 条 6 路循环 = 80 个运行时 handler：53 条裸 `202`、21 条空 delta、6 条硬编码字面量；`player.update(` **0 次**、`gainItem` **0 次** → 无任何持久化（5.3） |

> **最高价值结论**：`app/game/modules/activities/` 与 `app/game/modules/templateTrap/` 对 `sandbox|Sandbox` **零命中**（`grep -rn` 实测）——**生息演算在整个服务端不存在任何实现路径**，不是「实现得差」，而是「没有实现」。它是本仓当前最大的单点空洞（同时是抓包覆盖最密的链路之一）。
>
> **方法论提示（本章最重要的可复用经验）**：**端点路径不能由 Request 类名推导**——家具商店用的是 `BuildingGetFurnitureGoodListRequest` 但实际走 `shop/getFurniGoodList`（`AC/Torappu.UI.Shop/ShopFurnState.cs:209`）。可靠口径是客户端 Service 常量字符串（如 `SandboxV3Service.cs:9-84`、`RoguelikeTopicService.cs:9-33`）与服务端 `models.ts` 的 `CS: XxxRequest` 映射注释，二者交叉。

#### 5.4.2 差异清单

> 证据记为 `客户端证据 ↔ 服务端证据`；`[验证]` = 本次逐行读过，`[推测]` = 由命名/字段形状外推。

**P0（阻断可玩性 / 请求必失败 / 崩溃 / 零实现）**

| # | 级别 | 差异 | 客户端证据 ↔ 服务端证据 | 分类 |
|---|---|---|---|---|
| 1 | P0 | **基建专精链路请求字段错配（2 条路由）** | `AC/Torappu/UpgradeSpecializationRequest.cs:10/14/18` = `charInstId`/`skillIndex`/`targetLevel`（**无 `targetSkill`**）；`CompleteUpgradeSpecializationRequest.cs:6` 无任何字段 ↔ `app/game/modules/building/schemas.ts:68-74` 与 `:76-79` 均把 `targetSkill: z.number()` 设为**必填** → 符合 CS 的请求体必被 zod 拒（422）；抓包旁证 `tmp/capture/index.db`：`/building/upgradeSpecialization`、`/building/completeUpgradeSpecialization` 各 3 条 422 `[验证]`。对照 charBuild 侧 schema 用的是正确字段名（`modules/character/charBuild.schema.ts:69-80`）→ 仓内同功能两套字段名 | 行为不一致 |
| 2 | P0 | **基建宿舍锁定端点 schema 与 CS 不符，且 `lockQueue`/`isDormLock` 从不落状态** | `AC/Torappu/BuildingSaveDormLockRequest.cs:7/11` **只有** `lockPos: Dictionary<string,int[]>`；状态侧 `PlayerBuildingDormitory.cs:72 lockQueue`、`BuildingCharModel.cs:66 isDormLock` ↔ `schemas.ts:373-377` 要求 `roomSlotId:string` + `locked:boolean`（`lockPos` 标 optional 且自注「服务端不读」）；`logic/misc.ts:234-241` 只写 `presetQueues[slotId].locked`；`grep -rn 'lockQueue|isDormLock' modules/building/` 0 命中 → 客户端发 `{lockPos}` 必 422（抓包旁证 3 条 422），即便通过也不改宿舍锁 UI `[验证]`（`/editLockQueue` ↔ `BuildingSaveDormLockRequest` 映射为 `[推测]`，但两种候选映射下 schema 均与 CS 不符） | 行为不一致+缺失 |
| 3 | P0 | **沙盒完全无持久化**：所有端点不读不写 `sandboxPerm` | `AC/Torappu/PlayerSandboxPerm.cs:14-20`（SANDBOX_V2/V3 双存档表）+ `app/game/excel/types-playerdata.ts:5807 sandboxPerm: PlayerSandboxPerm` ↔ `app/game/modules/sandbox/routes.ts` 全文 `player.update(` 0 次、`gainItem` 0 次 `[验证]` | 缺失 |
| 4 | P0 | **沙盒 V3 开局伪状态**：`createGame` 返回写死常量 | `AC/Torappu/PlayerSandboxV3GameState.cs:9-23`（`NONE=-1,BAND_SELECT=0,…`）+ `PlayerSandboxV3CurrentGame.cs:11-56`（12 子块）↔ `routes.ts:819 nodeId:""`、`:820 state:0`、`:822 idx:21`、`:826 day:1`、`:827 weather:"weather_rain"`、`:861 save:null`；且 `state:0=BAND_SELECT` 而 `/v3/chooseBand`(`:957`) 为 202 → 客户端大概率卡在选乐队 `[验证]` | 行为不一致 |
| 5 | P0 | **肉鸽模块注册断链**：`TOTEMBUFF` 永不实例化，图腾端点抛异常 | `AC/Torappu/RoguelikeModuleType.cs:20 TOTEMBUFF` + excel `modules.rogue_3.moduleTypes=["CHAOS","TOTEMBUFF","VISION"]` ↔ `app/game/modules/roguelike/rlv2-module-composition.ts:87 TOTEM:`（键名不匹配）+ `module.ts:60-67` 的 `in moduleHandler` 守卫静默跳过；`logic.ts:460 this._module.totem.use(...)` **无 `?.`**，getter 返回 `this._modules["TOTEM"]`(`module.ts:114-116`)=`undefined` → `/rlv2/useTotem`(`handler.ts:436`) 对 rogue_3 应 500 `[验证]` | 缺失+崩溃 |
| 6 | P0 | **肉鸽模块增量静默丢弃**：choice 的 `m_get/m_lose` 全失效 | `AC/Torappu/RoguelikeGildCompDialog.cs:247` 读 `data.rlv2.current.module` ↔ `module.ts:242-262 applyModuleDelta()` 把增量写进 `this.toJSON()` 的一次性新对象后即返回，从未回写管理器（各 `toJSON()` 均返回新对象）`[验证]` | 行为不一致 |
| 7 | P0 | **肉鸽 `CANDLE` 模块整体缺失**（rogue_5 伺烛客） | `AC/Torappu/RoguelikeModuleType.cs:34 CANDLE`、`RoguelikeCandleModuleData.cs:11,19`；数据 `rogue_5` moduleTypes 含 `CANDLE` ↔ 工厂表 `rlv2-module-composition.ts:83-98` 无该键、`modules/` 无 candle 文件 `[验证]` | 缺失 |
| 8 | P0 | **肉鸽骰子 ruleGroup 全缺**：点数与事件解耦 | `AC/Torappu/RoguelikeDiceModuleData.cs:23 diceRuleGroups`、`RoguelikeDiceRuleData.cs:10,18`（`dicePointMax`/`diceGroupId`）、`RoguelikeDiceRuleGroupData.cs:14 minGoodNum` ↔ `logic.ts:623-624` 掷点、`:627-630` 在全部事件 id 上均匀随机；6 个规则字段在本模块 grep 命中 **0** `[验证]` | 缺失 |
| 9 | P0 | **沙盒战斗链路断裂**：battleStart/Finish 无战场契约 | sig `453164 SandboxV2BattleStartResponse : CommonStartBattleResponse`、`453307 …BattleFinishResponse : CommonFinishBattleResponse`、`430424/430449`（V3）↔ `modules/sandbox/sandbox.ts:461,464` 把响应类型退化成 `PlayerDeltaResponse`（自注「省略 battleId/结果字段」）；`routes.ts:216/233`（V2）空 delta、`:906/916`（V3）202 `[验证]` | 缺失 |

**P1（功能/语义不符，影响单条链路）**

| # | 级别 | 差异 | 客户端证据 ↔ 服务端证据 | 分类 |
|---|---|---|---|---|
| 10 | P1 | **基建降级不返还材料**（响应 `payback` 不下发） | `AC/Torappu/BuildingDegradeRoomResponse.cs:11 payback: List<ItemBundle>` ↔ `handler.ts:231-236` 仅 `res.send(player.delta)`；`logic/construction.ts:329-330` 注释自陈「简化实现：不返还建造材料」、`:334-351` 只 `slot.level -= 1` `[验证]`（官服返还比例未从客户端反推 `[推测]`） | 缺失 |
| 11 | P1 | **基建 `/changeSaleSolution` 不返回 `change`**，客户端方案切换后不刷新 | `AC/Torappu/BuildingChangeShopResponse.cs:10 public bool change`（同族 `BuildingChangeManufactResponse.cs:10` 亦有）↔ `handler.ts:407-412` 只发 202+delta（对照 `/changeManufactureSolution` `handler.ts:399-404` 正确回填 `change`）；`logic/trading.ts:600-629` 算了结果但无返回值；抓包 `/building/changeSaleSolution` 响应仅空 delta `[验证]` | 行为不一致 |
| 12 | P1 | **基建 `upgradeDiyLevel` 为 202 空壳**；DIY 缩略图 stub 且响应字段名写错 | DIY 契约存在；`AC/Torappu/BuildingDIYGetPresetThumbnailUrlResponse.cs:11 url: List<string>` ↔ `handler.ts:253-259` 注释「简化实现」+ `res.status(202).send(player.delta)`；`logic/misc.ts:491-493 getThumbnailUrl` 返回 `{ list: [] }`（字段名 `list` ≠ CS `url`）`[验证]` | stub |
| 13 | P1 | **基建物品直写 inventory，绕过 gainItem 管道**（任务/活动计数/勋章依赖管道事件） | 客户端不体现（服务端架构债）↔ `logic/construction.ts:371-374 _applyItemDelta()` 直接写 `draft.inventory[itemId]`；`modules/building/` 内 `gainItem` 仅 3 处、`draft.inventory[...]` 直写 2 处 `[验证]`；与 `docs/module-audit-2026-08-29.md:51` 的 P0 架构债同源 | 行为不一致 |
| 14 | P1 | **基建 16 条 POST 绕过 `validateBody`**（守卫盲区：schema-first 守卫正则不含 `handler.ts`） | 客户端请求体字段已由 CS 类固定 ↔ `handler.ts:207/301/322/340/356/368/388/396/415/468/530/602/652/704/726/737` 无校验；`tests/unit/architecture/schema-first-guard.test.ts:15-21` 的路由面正则排除 `handler.ts` `[验证]` | 部分实现 |
| 15 | P1 | **肉鸽铜币 divine/gildType/luckyLevel 未实现**，`redraw` 语义不等价 | `AC/Torappu/RoguelikeCopperDivineData.cs:10-26`、`RoguelikeCopperData.cs:11-47`（`luckyLevel`/`gildTypeId`/`buffType`）、`RoguelikeCopperModuleConsts.cs:10-26` ↔ `modules/copper.ts:69-87` 均匀抽 3 枚（硬编码）、`:98-130` redraw 仅翻 `isDrawn` 且 `divineEventId:""`、`:90-95` gild 仅 `layer+1`；`logic.ts:738-744 /copper/change` 空操作；这些字段在本模块引用数 **0** `[验证]` | 缺失 |
| 16 | P1 | **肉鸽结算权重用第三方口径 + 响应占位** | 官方常量类 `AC/Torappu/RoguelikeConstTable.cs:127 clearZoneScores`、`:143 clearBossBattleScore`、`:147 gainRelicScore`、`:151 gainCharacterScore` ↔ `settle.ts:321 ZONE_SCORES=[0,30,80,150,270,400,550,650]`、`:348 ×30`、`:350 ×2`（`:314` 注释自陈参考第三方项目）；`:696-716` BP/GP/解锁列表硬编码（`from/to=55000`、`gp:0`、5 个 `*Unlock: []`）`[验证]` | 行为不一致+stub |
| 17 | P1 | **沙盒路径↔协议类错位 4 处 + 9 条死路由/别名** | `AC/Torappu.UI.SandboxPerm.SandboxV2/SandboxV2Service.cs:12,15,18,30`（`COOK_DRINK=/extract`、`COOK_FOOD=/cook`、`WORKBENCH_CRAFT=/build`、`CONSTRUCT_SAVE=/homeBuildSave`）；CS 类 `SandboxV2CookDrinkRequest`(sig 452551)/`CookFoodRequest`(452571)/`CraftRequest`(452613)/`ConstructOperationRequest`(452757) ↔ `sandbox.ts:95/165` 自注「无 CS 对应类」，`routes.ts:256/266/415/425` 绑定关系与上表不一致；`:361 /v2/exploreMode` 死路由、`:1106/1116/1149/1159/1169/1179 /racingXxx` 为客户端不可见别名 `[推测]`（依据常量名+CS 类名，未读到调用点） | 行为不一致 |
| 18 | P1 | **沙盒响应字段缺口**：items/结算/招募列表永不下发 | sig `430228/430248/430268/430305`（各响应 `items`）、`430208`（`List<ItemGet>`）、`430096`、`429995`（`score/reward/detail`）、`430360`（`subProfessionList/tempCharList/rookieCharList`）↔ `sandbox.ts:605,614,641,644,653,656,665` 自注「服务端省略 items/列表」；`routes.ts:705` harvest 返回 `{}` `[验证]` | 部分实现 |

**P2（局部/文档漂移/影响可控）**

| # | 级别 | 差异 | 证据 | 分类 |
|---|---|---|---|---|
| 19 | P2 | 基建建造/升级/清理类响应缺 `result`/`alert`，且非法建造被 `return;` 静默吞掉 | `BuildingBuildRoomResponse.cs:11/15`(`result`/`alert`)、`BuildingUpgradeRoomResponse.cs:10`、`BuildingUpgradeCompleteRoomResponse.cs:11/15`、`BuildingCleanRoomResponse.cs:10` ↔ `handler.ts:207-236,636-649` 只发 delta；`logic/construction.ts:99/292` 静默 return `[验证]` | 部分实现 |
| 20 | P2 | 基建贸易订单 `buff: []`/`specGoldTag` 恒空；excel `orderSpeed/orderRarity/orderLimit` 未参与 | `PlayerBuildingTradingOrder.cs:61/70`（`buff`/`specGoldTag` 结构）↔ `logic/trading.ts:69/80/92/118` 恒写 `buff: []`；`orderLimit` 未校验（直接用存档 `stockLimit`）`[验证]` | 部分实现 |
| 21 | P2 | 旧 v1 `/roguelike/*` 6 端点中 5 个纯桩，实际 URL 为 `/roguelike/roguelike/*`（仅 `/activity/roguelike/*` 别名可达） | `modules/roguelike/routes.ts:35-89`（仅 `:99 upgradeOutBuff` 接真逻辑，其余 `{...player.delta,result:0}`）+ `app/game/routes.ts:119`（prefix `/roguelike`）与 `:143`（prefix `/activity`）`[验证]` | stub/死路径 |
| 22 | P2 | 肉鸽 `alchemyReward` 忽略请求 `index`（handler 硬写 0）；WRATH/SKY/VISION/WEATHER 有字段恒空；助战链路静默关闭 | `AC/Torappu.UI.Roguelike.RL04/RL04Service.cs:21`；`RoguelikeModuleType.cs:22,32,36,40` ↔ `handler.ts:737-742 alchemyReward({index:0})`、`modules/wrath_sky.ts` 的 `rlv2:wrath:gain` 全仓无 emit、`modules/weather.ts:54-72` 进层恒清空、`recruit-flow.ts:69-88` 只置 `needAssist=false` `[验证]` | stub/部分 |
| 23 | P2 | `/game/rlv2` 别名仍不存在，但 6 个客户端 UI 目录内检索不到该字面量 | `app/game/routes.ts:99` 仅 `/rlv2`（无 rewrite）↔ 客户端未命中 → 影响低于既有文档判断 `[推测]` | 缺失（低影响） |
| 24 | P2 | **文档漂移**：`docs/接口覆盖分析-未实现与stub清单.md` 的 6 条 rlv2 缺失已补 5 条（仅 `finishGame` 仍缺且疑为死常量）；`docs/rlv2-blackstream-官方文本对照.md` 的 MONTH_TEAM/CHALLENGE 一律转 NORMAL 结论已过期 | `handler.ts:527/541/549/561/569` 已注册 buyReward/setSeed/unlockBuff/copper.change/copper.confirmDraw；`game-init.ts:137` 仅 CHALLENGE→NORMAL，MONTH_TEAM 已保留 `[验证]` | 文档不一致 |
| 25 | P2 | 基建 `clue_data.inventoryLimit` 等 excel 常量被硬编码替代（值相同，可维护性缺陷） | `clue-speed.ts:20 OWN_CLUE_LIMIT = 10` 未走 `getClueConstant("inventoryLimit")`；`data/excel/clue_data.json` 有该字段 `[验证]` | 部分实现 |

#### 5.4.3 建议动作（按投入产出排序）

1. **P0 · 沙盒持久化骨架（唯一「从 0 到 1」）**：在 `modules/sandbox/` 增加 manager（参照 `design-spec.md §35.9` 域内实体范式），用 `player.update` 写 `sandboxPerm.template.SANDBOX_V2|V3[topicId]`；先打通 `createGame → nextDay → settleGame` 三条，其余端点才可能落地。客户端路径已 100% 就位，改造成本低于新建路由面。
2. **P0 · 基建两条 schema 错配（改动量最小、收益直接）**：`schemas.ts:68-79` 改用 CS 字段（`skillIndex`/`targetLevel`；Complete 允许空体）；`schemas.ts:373-377` 改为 `lockPos` 并把 `lockPos` 真正落到 `dormitory.lockQueue`/`char.isDormLock`。
3. **P0 · 肉鸽两处断链**：工厂键 `TOTEM`→`TOTEMBUFF`（或加别名映射）+ `logic.ts:460` 加 `?.`；`applyModuleDelta` 改为回写管理器。
4. **P1 · 肉鸽规则表接线**：骰子 `diceRuleGroups` 与铜币 `copperDivineData` 已随 excel 下发，属「读表驱动」而非新增玩法；settle 权重与 `RoguelikeConstTable` 对齐。
5. **P1 · 基建响应字段与管道收口**：补 `payback`/`change`/`results`/`result`/`alert`；物品改走 `gainItem` 管道；16 条 POST 补 `validateBody`（并把 `handler.ts` 纳入守卫正则）。
6. **同步文档**：`docs/接口覆盖分析-未实现与stub清单.md` 与 `docs/rlv2-blackstream-官方文本对照.md` 按 5.4-24 更新，避免后续按过期清单重复排查。

## 7. 活动族 / 抽卡 / 任务签到勋章

> 分析对象：官服反编译客户端 `reference/arknights-2.7.71-csharp/Assembly-CSharp/`（CS）↔ 本私服 `app/`（SRV），数据以 `data/excel/*.json` 实测值为准。
> 时间：本轮只读静态分析（2026-09-13）。未修改 `app/` 与 `reference/` 任何文件。
> **证据标注约定**：
> - **【验】** = 本轮直接 `read`/`grep` 该行确认；
> - **【子代理】** = 并行子代理已读该行并给出行号，本人未逐行复核（行号经抽样验证的会额外注明）；
> - **【推测】** = 由已验事实推断，未直接读到证据。
> 所有类名/字段名/行号均来自实际文件，未编造。

---

### 7.1 活动族（Activity）

#### 7.1.1 客户端如何抽象活动：表驱动 + `Template*` 基类

**命名纠正（重要）**【子代理，抽样验证 grep 有效】：任务书示例的 `Act<N>Data<,>` 泛型基类、`ActivityTemplate`、`ActivityConst`、`ActState`、`IActivity` 在 2.7.71 **均不存在**（对 `reference/com.hypergryph.arknights_2.7.71.cs` 逐一 grep 计数为 0，而 `ActivityTable` 有 116 命中，证明 grep 有效）。真实体系是 **`ActivityTable` 数据表 + `Template*` 前缀基类 + 每族自有的 `Act<X>*State/StateBean/ViewModel`**。

| 抽象层 | 类型 | 位置 | 说明 |
|---|---|---|---|
| 活动元信息表 | `ActivityTable` | `CS/Torappu/ActivityTable.cs:11`【验】 | 活动总表 |
| 元信息模板 | `ActivityTable.BasicData` | `CS/Torappu/ActivityTable.cs:36`【验】 | `id / type(ActivityType) / displayType / startTime / endTime / rewardEndTime / hasStage / templateShopId / medalGroupId / isReplicate` 等【子代理】 |
| 分类型 DTO 字典 | `ActivityTable.ActivityDetailTable` | `CS/Torappu/ActivityTable.cs:196`【验】；实例字段 `activity` 于 `:791`【验】 | 按活动类型分桶，如 `typeAct13SideData` / `typeAct24SideData` / `typeAct25SideData` / `typeActArcHubData` 等【子代理】 |
| 活动类型枚举 | `ActivityType` | `CS/Torappu/ActivityType.cs:9`【验】 | 70+ 成员（`MISSION_ONLY/CHECKIN_ONLY/TYPE_ACT3D0/…/TYPE_ACT54SIDE`）【子代理】 |
| 舞台控制器基类 | `ActivityStageController : MonoBehaviour, IPageProvider` | `CS/Torappu.UI.ActivityStage/ActivityStageController.cs:24`【验】 | 持 `activityId` |
| **模板化活动控制器** | `TemplateActivityController : ActivityStageController, IBaseActHandler, IPlayerDataListener` | `CS/Torappu.UI.ActivityStage/TemplateActivityController.cs:19`【验】 | 抽象方法 `InitModelDict(string actId)` 于 `:1167`【验】；所有模板化活动继承它 |
| handler 契约 | `IBaseActHandler` | `CS/Torappu.UI.ActivityStage/IBaseActHandler.cs:6`【子代理】 | `GetViewModel(...)` / `GetActId()` / `OnDataUpdated()` / `Bind()` / `CheckIfActivityIsOpen()` / `GetCurrentState()` |
| ViewModel 基类 | `TemplateActivityViewModel` | `CS/Torappu.UI.ActivityStage/TemplateActivityViewModel.cs:9`【子代理】 | 字段 `activityId` |
| 生命周期状态 | `TemplateActivityLifeCycleViewModel.ActState { NOT_OPEN, ON_ACT, ON_REWARD, ONCLOSE }` | `.../TemplateActivityLifeCycleViewModel.cs:10,13,15,17,19`【验】 | 解锁判据 = `CheckIfActivityIsOpen()` 比较 `ActState.ON_ACT`（`TemplateActivityController.cs:1277,1298`）【子代理】 |
| 数据拉取（新） | `TemplateActivityDataFromServer<DataType> : DataFromServer<DataType>`，dataId 前缀 `ACT_{activityId}` | `.../TemplateActivityDataFromServer.cs:8`【子代理】 | `ITemplateActivityDataFromServer.TryFetchDataFromServer()`（`ITemplateActivityDataFromServer.cs:11`【验】） |
| 数据拉取（旧） | `ActivityDataFromServer<DataType>`，dataId 前缀 `ACTIVITY_{activityId}` | `CS/Torappu.Activity/ActivityDataFromServer.cs:8,11,28`【验】 | 与上一代并存 |
| 通用 UI 插件 | `TemplateActivityEntryZonePlugin` / `TemplateActivityMissionPlugin` / `TemplateActivityMilestoneState` / `TemplateActivityCoinView` / `TemplateActivitySpecialZoneState` | `CS/Torappu.UI.ActivityStage/` 同名文件 | 由 `TemplateActivityController` 以参数键注册 |

**通用活动服务码（客户端拿到的 8 条共享端点）**【验】`CS/Torappu.Activity/ActivityServiceCode.cs:9-30`：

```
/activity/confirmActivityMission       (:9)
/activity/exchangeActivityShopItem     (:12)
/activity/confirmActivityMissionGroup  (:15)
/activity/getActivityShopInfo          (:18)
/activity/getActivityCollectionReward  (:21)
/activity/confirmActivityMissionList   (:24)   // 常量名 CHECK_COLLECTION_MISSIONS
/activity/rewardMilestone              (:27)
/activity/rewardAllMilestone           (:30)
```

**结论（对本私服的意义）**：活动不是"每族一套基类"，而是 **一张总表（`ActivityTable`）+ 一套共享 UI 骨架（`TemplateActivity*`）+ 8 条共享端点**；族差异只体现在 `ActivityDetailTable` 的 DTO 形状、控制器 `InitModelDict` 注册的 ViewModel 键，以及各族自己的玩法端点。这意味着服务端**不该按族复制粘贴**，而应有一个"共享骨架模块 + 每族 DTO 适配"。

#### 7.1.2 `ActivityStage` / `ActArchive` / `ActArkhub` / `Arkvent` / `AVG` 的职责划分

| 命名空间 | .cs 数【验：find 计数】 | 抽象什么 | 关键证据 |
|---|---|---|---|
| `Torappu.UI.ActivityStage` | 112 | **活动舞台 UI 骨架**：控制器 + 可插拔 zone/mission/milestone/coin/favor/CG 组件 | `TemplateActivityController.cs:19`、`ActivityStageStateEngine`（`ActivityStageStateEngine.cs:14`【子代理】）、协议模板 `TemplateActivityServerDataRequest`（`:6`【验】）/`TemplateActivityServerDataResponse<DataWrapper> : PlayerDeltaResponse`【子代理】 |
| `Torappu.UI.ActArchive`（+`.RL03`/`.RL06` 各 2） | 345 | **活动档案 / 回顾**（回看剧情、CG、音乐、图鉴、新闻），**不是战斗玩法** | `ActArchiveController : MonoBehaviour`（`ActArchiveController.cs:13`【验】，abstract）、`ActArchivePage : StateEnginePage`（`ActArchivePage.cs:13`【验】）、插件契约 `ActArchivePlugin : IHotfixable`（`ActArchivePlugin.cs:9`【验】）、档案分类枚举 `ActArchiveType`（`CS/Torappu/ActArchiveType.cs:9`【验】：`TIMELINE/MUSIC/PIC/AVG/STORY/NEWS/BUFF/RELIC/…`）【子代理】 |
| `Torappu.UI.ActArkhub`（含 `.Arkdex`/`.Arkdex.Battle`/`.PixelMap`/`.Server`/`.Server.Data`/`.Server.Workflow`） | 623 | **奇象巡展（ARK_HUB）玩法本体**：社交大厅 + 图鉴（ARKDEX）+ 像素画 + 服务端协议 DTO | `ActArkhubActivityController : TemplateActivityController`（`CS/Torappu.Activity.ActArkHub/ActArkhubActivityController.cs:22`【验】）、`ActArkhubConsts`（消息号）【子代理】、`.Server.Data/*Req|*Resp`（`BusinessCardReq.cs:9` 等）【子代理】 |
| `Torappu.Arkvent`（+`.Audio`/`.CinemachineCamera`/`.PlayTest`） | 214 | **ARK_HUB 的 3D 世界层**（场景、单位、相机、交互、气泡） | `AbstractArkventWorld : MonoBehaviour, IGameplayWorld`（`AbstractArkventWorld.cs:13`【子代理】）→ 唯一具体世界 `ArkhubWorld : AbstractArkventWorld`（`ArkhubWorld.cs:14`【验】） |
| `Torappu.Arkvent.UnitSystem` | 154 | **场景内单位 / 能力系统**（Spine 单位、家具、碰撞、HUD）；**不是编队系统**（编队在 `Torappu.UI.Squad`） | `IUnitWorld`（`IUnitWorld.cs:6`）→ `ArkventUnitWorld`（`ArkventUnitWorld.cs:13`）、`ArkventUnitRegistry : EntityRegistry`（`ArkventUnitRegistry.cs:9`【验】）、`ArkventConsts` 动画名【子代理】 |
| `Torappu.AVG` | 189 | **剧情演出引擎（Visual Novel）**，被活动与活动档案（`ActArchiveType.AVG/STORY`）复用 | 单例 `AVG : SingletonMonoBehaviour<AVG>`（`AVG.cs:16`【验】）、核心 API `StartStoryById(string, Story.StoryParam, Action<Story>)`（`AVG.cs:89`【验】） |

> 注：`Arkvent` 是否只服务 ARKHUB（未穷举引用者）、`ActArchive.RL03/RL06` 的确切语义 —— 见 §4 不确定清单。

#### 7.1.3 客户端活动实例清单（按前缀聚合）

**规模**【验】：`find CS -maxdepth 1 -type d -name 'Torappu.Activity*'` = **87 个目录**（1 个通用 `Torappu.Activity` 基座 + 86 个实例子目录），活动相关 `.cs` = **2602 个**；按首段前缀归并 = **约 63 个活动族**。

主要族（文件数降序，节选；`n` = 该前缀下 `.cs` 总数）【验】：

| 族 | n | 服务端归属 |
|---|---|---|
| ActMultiV3（`.Prepare`/`.BattleFinish`） | 308 | `modules/multiplayer`（`/multiplayerV3/*`，`routes.ts:58`【验】） |
| Act1VHalfIdle | 235 | `activities/act1vhalfidle` |
| VecBreakV2 | 165 | `modules/vecbreak`（`/vecBreakV2/*`，`routes.ts:68`【验】） |
| Act24side | 146 | `activities/act24side` |
| **（通用）Torappu.Activity** | 116 | `activities/shared` 对应概念 |
| Act20side | 103 | `modules/retro`（仅 2 路由，`routes.ts:58,69`【验】） |
| Act42D0 | 94 | `activities/arcade` + `typeAct`（熔炉） |
| Act1Arcade | 92 | `activities/arcade` |
| Act25side | 92 | `activities/act25side` |
| Act1Lock | 90 | `modules/interlock`（`/interlock/*`，`routes.ts:24`【验】） |
| Act13Side | 89 | `activities/act13side` |
| Act12side | 75 | `modules/charm`（仅信物部分） |
| AutoChess | 74 | `modules/autochess` |
| Act5D1 / Act3D0 / Act9D0 / Act4D0 / Act5D0 | 72 / 61 / 58 / 39 / 33 | `activities/typeAct` |
| Act12D6 | 57 | **无** |
| Act1Football / Act42side | 46 / 46 | `activities/football` / `activities/act42side` |
| CommonVasebreaker | 45 | **无** |
| Act54Side | 44 | **无** |
| Act1BossRush | 34 | `activities/bossRush` |
| Act36side | 33 | `activities/act36side` |
| Act6fun | 31 | `modules/aprilFool`（`/act6fun/*`） |
| Act1 / Act10D5 | 29 / 29 | **无** |
| Act45Side | 29 | `activities/act45side` |
| ActMainSS 族（Act1mainss+Act4mainSS+ActMainSS） | 21+3+3 | **无** |
| Act29sign / Act33Sign | 17 / 8 | 可能由 `activities/checkin` 通用入口承载（【推测】） |
| Act50side(+`.Melding`) / Act53Side / Act17side / Act38side / Act35side / Act46Side / Act44side / Act27side / Act32side / Act21side … | 14 / 10 / 10 / 12 / 10 / 9 / 6 / 5 / 4 / 5 | 见 §1.5 |

#### 7.1.4 「活动族代码通用骨架」（服务端按族实现的落点）

**客户端骨架（每族通常包含）**【子代理 + 抽样验证】：

1. **DTO**：`CS/Torappu/Act<X>Data.cs`，在 `ActivityTable.ActivityDetailTable` 注册 `typeAct<X>Data`（`ActivityTable.cs:196`），键 = `BasicData.id`；
2. **拉取**：`TemplateActivityDataFromServer<T>` / 旧式 `ActivityDataFromServer<T>`；
3. **控制器**：`Act<X>ActivityController : TemplateActivityController`（`Act25sideActivityController.cs:17`【验】、`Act13SideActivityController.cs:21`、`ActArkhubActivityController.cs:22`【验】）+ `InitModelDict` 注册 ViewModel 键（如 `RESEARCH_PARAM="research"` / `ARCHIVE_PARAM="archive"`，`Act25sideActivityController.cs:137,141`【验】）；
4. **状态层五件套**：`*State` → `*StateBean` → `*Property` → `*ViewModel` → `*View`/`*Plugin`（通用范式 `ActCommonMiniStoryState : PopupFadeState`、`ActCommonFavorUpStateBean : IStateBean`）【子代理】；
5. **协议**：`Act<X><Action>Request` / `Act<X><Action>Response` 成对；战斗走 `SquadCustomFinishBattleServiceConfig<TReq,TRes>`（`Act25sideBattleFinishServiceConfig.cs:6`）【子代理】；
6. **共享通用件**：zone/mission/milestone/coin/favor/CG 插件 + `ActivityServiceCode` 8 端点 + `IMilestoneServiceConfig`。

**服务端对应的共享骨架**【验】：

| 客户端概念 | 服务端落点 |
|---|---|
| `ActivityTable.BasicData` 播种 / 解锁 | `SRV/app/game/modules/activities/shared/unlockActivity.ts` |
| 8 条 `ActivityServiceCode` 端点 | `SRV/app/game/modules/activities/milestone/router.ts:149,153,157,161,165,169,173,177,181`（**8 条全齐**，另多一条 `autoConfirmMissions`） |
| 协议类型（逐类标注 CS 出处） | `SRV/app/game/modules/activities/shared/activity.ts`（1055 行） |
| 请求校验 | `SRV/app/game/modules/activities/shared/activity.schema.ts`（554 行） |
| 每族一包 | `activities/<family>/{router.ts,logic.ts}`，挂载表 `activities/index.ts:36-66`【验】 |

即：**新族的服务端实现 = 读 `ActivityTable` DTO → 落玩家状态 → 在 `shared/activity.ts` 加协议 → 建 `activities/<family>/` → 在 `index.ts` 挂载**。骨架已具备，缺口在"每族的玩法语义"。

#### 7.1.5 服务端已支持的活动族 vs 客户端存在但服务端缺失

**A. `app/game/modules/activities/` 内 24 个族**【验：`activities/index.ts:10-33,36-66`（挂载）+ 各 `router.ts` 路由数】：
`checkin / milestone / charm / bossRush / enemyDuel / act24side / football / arcade / act1vhalfidle / act13side / act35side / act38side / act42side / act44side / act45side / act46side / teamQuest / typeAct / act25side / act29side / act36side / trainingGround / arkhub / interlockRefresh / shared`。

**B. 由兄弟模块承载的族**【验：路由字面量】：
`ActMultiV3`→`modules/multiplayer`、`VecBreakV2`→`modules/vecbreak`、`Act1Lock`→`modules/interlock`、`AutoChess`→`modules/autochess`、`Act53Side`→`modules/arkodc`、`Act20side`→`modules/retro`（仅 2 路由）、`Act12side`→`modules/charm`（仅信物）、`Act3fun~Act7fun`→`modules/aprilFool`。

**C. 客户端存在但服务端任何模块都无路由**（按客户端代码量降序）：

| 客户端族目录 | .cs | 判定 | 优先级 |
|---|---|---|---|
| `Torappu.Activity.Act12D6` | 57 | 整族缺失 | P1 |
| `Torappu.Activity.CommonVasebreaker`(+`.Milestone`) | 45 | 整族缺失 | P1 |
| `Torappu.Activity.Act54Side` | 44 | 整族缺失 | P1 |
| `Torappu.Activity.Act1` | 29 | 缺失 | P2 |
| `Torappu.Activity.Act10D5` | 29 | 缺失 | P2 |
| `Act1mainss`+`Act4mainSS`+`ActMainSS`（typeMainSS 族） | 27 | 缺失 | P2 |
| `Torappu.Activity.Act50side`(+`.Melding`) | 14 | 缺失（**【推测】**可能由 sandbox 承载） | P2 |
| `Torappu.Activity.GameCity.Battle.UI` | 11 | 缺失 | P2 |
| `Torappu.Activity.Act17side` | 10 | 缺失 | P2 |
| `Act21side` / `Act27side`(路由已 stub) / `Act32side` / `ActFun` | 5/5/4/2 | 缺失 | P2 |
| `Act0D5/13D5/14Side/15D0/16D6/17D0/1D5/3D5/48side/49side` | 1~6 | 碎片残件 | P2 |

**D. 服务端有、客户端无对应活动目录**：`activities/trainingGround`（客户端 `find` 无 `TrainingGround` 目录）、`activities/enemyDuel`、`activities/interlockRefresh`（客户端仅数据表 `ActivityInterlockData`）、`activities/charm`（客户端为 `Torappu/CharmData.cs` 等，非活动目录）——【子代理，未穷举确认】。

#### 7.1.6 活动族差异表

| # | 分类 | 优先级 | 客户端证据 | 服务端证据 |
|---|---|---|---|---|
| A1 | 缺失 | P1 | `CS/Torappu.Activity.Act12D6/` 57 个 `.cs`；`CommonVasebreaker` 45 个；`Act54Side` 44 个【验：find 计数】 | `activities/index.ts:36-66` 无对应挂载；`app/` 全仓 grep `act12d6/vasebreaker/act54side` **仅命中生成类型**（`types-playerdata.ts:1850,1881` 等 PlayerActivity_* 结构存在但无消费方）→ 无任何路由【验】 |
| A2 | stub | P1 | `ActivityServiceCode` 之外各族玩法端点（如 `Act35side*Request`、`Act38side*Request`） | `activities/act35side/router.ts:138,153`、`act38side:138,145,153`、`act42side:145,152,168,182`、`act45side:138,145`、`act46side:138,144`、`arcade:165,172,181`、`teamQuest:138`、`typeAct:138,144,150,157,168,178` 全部 `res.send(player.delta satisfies ActivityStubResponse)` / `items: []`【验】 |
| A3 | stub | P2 | `Act25side` 91 个 `.cs`（研究/档案/区域/调查） | `activities/act25side/router.ts` 的 `dailyRefresh` 固定 `tokenDelta:0`、`harvest` 固定 `items:[]`、`investigate` 仅 delta、`finishInvestigation` 固定 `items:[]`【验：`act25side/router.ts` 根路由块】 |
| A4 | 部分实现 | P2 | `Act13side*DailyMission*Request/Response` 等 8 类 | `activities/act13side/router.ts:135-138`（`clearFlag` 空 delta）+ `:177-180`（act27side 7 条循环 stub）【验】 |
| A5 | 已实现 | — | `ActivityServiceCode.cs:9-30` 的 8 条共享端点 | `activities/milestone/router.ts:149,153,157,161,165,173,177,181` 一一对应【验】 |
| A6 | 缺失 | P2 | `Torappu.Activity.Act1mainss`(21)/`Act4mainSS`(3)/`ActMainSS`(3) 存在 | `activities/typeAct/router.ts` 仅覆盖 3d0/4d0/5d0/5d1/9d0/20side/autochess（`typeAct/router.ts` 循环）【验：路由数 13】，无 TYPE_MAINSS 分支 |
| A7 | stub | P2 | `GetOpenServerCheckInRewardRequest` 等开服签到协议（`ServiceCode.cs:341`【验】） | `activities/checkin/router.ts:249,253,257` 三条仍为 `activityStubSchema` stub【子代理】 |

---

### 7.2 抽卡（Gacha）

#### 7.2.1 协议类与字段（纠正任务书假设）

**不存在** `GachaSyncRequest / GachaSearchRequest / GachaSelectRequest / GachaPullRequest`【子代理：`ls CS/Torappu | grep -i gacha` 全量 45 文件】。实际两组：

**A. 高级寻访组**

| 类 | 文件:行 | 字段 |
|---|---|---|
| `AdvancedGachaRequest` | `CS/Torappu/AdvancedGachaRequest.cs:6,10,14,18`【子代理】 | `poolId:string` / `useTkt:GachaType` / `itemId:string` |
| `AdvancedGachaResponse` | `AdvancedGachaResponse.cs:6,10,14` | `result:int` / `charGet:GachaResult` |
| `TenAdvancedGachaRequest` | `TenAdvancedGachaRequest.cs:7,11,15,19` | `poolId` / `useTkt` / `itemList:List<CombineGachaItem>` |
| `TenAdvancedGachaResponse` | `TenAdvancedGachaResponse.cs:6,10,14` | `result` / `gachaResultList:GachaResult[]` |
| `CombineGachaItem` | `CombineGachaItem.cs:6,10,14` | `id:string` / `count:int`（**无 type**） |
| `GetDetailGachaRequest` | `GetDetailGachaRequest.cs:6,10,14` | `poolId` / `gachaObjGroupType` |
| `GetDetailGachaResponse` | `GetDetailGachaResponse.cs:6,10,14,18` | `detailInfo:GachaDetailData` / `gachaObjGroupType` / `hasRateUp:bool` |
| `ChoosePoolUpRequest` | `ChoosePoolUpRequest.cs:7,11,15` | `poolId` / `chooseChar:Dictionary<int,List<string>>` |
| `ChoosePoolUpResponse` / `GetFreeCharRequest` | `ChoosePoolUpResponse.cs:6,10` / `GetFreeCharRequest.cs:6,10` | `poolId` |
| `GetFreeCharResponse` | `GetFreeCharResponse.cs:7,11` | **仅** `items:List<RewardItemModel>` |
| `UseCharGachaVoucherRequest/Response`、`VoucherGachaDetail*` | `ls CS/Torappu/*Voucher*`【子代理】 | **服务端未实现** |

**B. 公开招募组**（`Normal` 前缀）：`SyncNormalGachaRequest`（无字段）/`NormalGachaRequest{slotId,tagList:int[],specialTagId,duration:long}`（`NormalGachaRequest.cs:10,14,18,22`）/`FinishNormalGachaResponse{result,charGet}`/`CancelNormalGachaResponse{result}`/`BoostNormalGachaResponse{result}`/`BuyRecruitSlotRequest{slotId}`/`RefreshTagsGachaRequest{slotId}`【子代理】。

**关键点**【子代理，本人采信】：**十连没有 `count` 字段**——次数由 `useTkt=CombineTenTicket(9)` + `itemList` 表达；**保底计数与剩余次数不在任何响应体内**，只通过 `playerDataDelta` 下发。因此服务端把保底写进 `gacha.normal[poolId]{cnt,maxCnt,avail}` 是正确路径。

#### 7.2.2 池类型 / 规则枚举的**来源**：本地 excel，不是服务端下发

- `GachaRuleType`（**字符串枚举**，`[JsonConverter(typeof(StringEnumConverter))]`）`CS/Torappu/GachaRuleType.cs:8,9`【验】；12 成员 `:12-34`【验】：`NORMAL=0, LIMITED=1, LINKAGE=2, ATTAIN=3, CLASSIC=4, SINGLE=5, FESCLASSIC=6, CLASSIC_ATTAIN=7, SPECIAL=8, DOUBLE=9, CLASSIC_DOUBLE=10, BACKFLOW=11`。
- `GachaType`（数值 `useTkt`）`CS/Torappu/GachaType.cs:6,9-29`【验】：`None=-1, Diamond=0, SingleTicket=1, TenTicket=2, LimitSingle=3, UseItem=4, TenSingleTkt=5, ClassicSingleTicket=6, ClassicTenTicket=7, classicTenSingleTicket=8, CombineTenTicket=9`。
- **规则的宿主字段**：`GachaPoolClientData.gachaRuleType`（`GachaPoolClientData.cs:69`【验】，`GachaRuleType` 类型）；整表 `GachaData.gachaPoolClient`（`GachaData.cs:228`【子代理】）；取表入口 `GachaDB : ConstTable<GachaData, GachaDB>`（`GachaDB.cs:14,15`【子代理】）= **客户端本地打包表**，非服务端下发。
- **策略参数内嵌在 `gachaPoolClient` 行内，没有独立策略表**：`dynMeta:73` / `linkageRuleId:77` / `linkageParam:81` / `limitParam:85`【验：`GachaPoolClientData.cs`】↔ `SRV/app/game/excel/types_excel_gen.ts:8859-8862`【子代理】。`ls data/excel | grep gacha` **只有** `gacha_table.json`（446 池）+ `.meta.json`【验】；不存在 `gachaDetailTable`/`gachaRule` 表。
- **服务端下发的部分**：池**详情** `GachaDetailData` 走 `POST /gacha/getPoolDetail`（`SRV/app/game/modules/gacha/handler.ts:175-183`【验】；`SRV/app/game/excel/excel.ts:310` 装载 `data/gacha_detail_table.json`，447 池【验】）；玩家状态 `PlayerGacha` 属 `playerdata`（`CS/Torappu/PlayerDataModel.cs:126`【子代理】）。

#### 7.2.3 各类寻访池规则（客户端证据）

| 规则 | 客户端证据 |
|---|---|
| 单抽 / 消耗策略 | `CS/Torappu.UI/RecruitDataConverter.cs:838-859`（`SingleGachaPolicy`）；`TenGachaCost` `:80-100`、`TenGachaPolicy` `:103-150`、`CheckTenGachaPolicy:1182`、`_CheckTenGachaCost:1233`、`_TryCalculateCombineGachaList:1361`【子代理】 |
| 十连按钮 | `CS/Torappu.UI.Recruit/RecruitSlideState.cs:963-980,985-1021,1025`【子代理】 |
| 保底（50 抽后 +2%、10 抽必 4★+） | `GachaPoolClientData.guarantee5Avail:45`/`guarantee5Count:49`【验】；玩家 `PlayerGacha.PlayerGachaPool{cnt,maxCnt,avail}`（`PlayerGacha.cs:34-53`）【子代理】；UI `RecruitGachaItemView.cs:604-617`、`RecruitClassicGachaItemView.cs:377-387`【子代理】 |
| 限定池每日免费 | `GachaData.freeGacha`（`:276`，元素结构 `:71-94`）【子代理】↔ `SRV/app/game/modules/gacha/limit-gacha.ts:48-64,96-101`（`excel.GachaTable.freeGacha`，实测 26 条，`freeCount=1`【验：node 读取】） |
| 限定池 300 抽赠送 | `PlayerGacha.PlayerFreeLimitGacha{leastFree,poolCnt,recruitedFreeChar}`（`PlayerGacha.cs:56-75`）【子代理】↔ `SRV .../limit-gacha.ts:20`（阈值 300）+ `logic.ts:207-232`（`claimLimitFreeChar`）【验】 |
| 自选 / 换池（中坚甄选 · 特殊自选） | `ChoosePoolUpRequest.cs:15`；UI `RecruitSpecialGachaUpCharListDialog.cs:451-470`、`RecruitUpCharSlotSelectDialog.cs:256-265`；对象组 `GachaDetailData.GachaObjGroupType`（`GachaDetailData.cs:79-91`【验】）+ `RecruitDataConverter.GetCurrentGachaObjGroupType(poolId, gachaRuleType)`（`RecruitDataConverter.cs:1843`【验】） |
| 新手池（21 抽 / 末抽必 6★） | `NewbeeGachaPoolClientData`（`NewbeeGachaPoolClientData.cs:12-36`）；`RecruitNewbeeGachaItemView.cs:44,107`；`TenGachaPolicy.NEWBEE`（`RecruitDataConverter.cs:109,1197-1203`）【子代理】 |
| 中坚 / 常驻 / 回归 / 链式 | `RecruitClassicGachaItemView.cs:407-417,500-508`；`RecruitSpecialGachaViewModel.cs:155`（BACKFLOW）；`RecruitDataConverter.cs:844-852`（linkage）【子代理】 |

> 客户端 `GachaObjGroupType` 枚举全部成员【验：`GachaDetailData.cs:79-91`】：`ALL=0, BEFORE_FES_CLASSIC_CHOSEN=1, AFTER_FES_CLASSIC_CHOSEN=2, BEFORE_SPECIAL_PICKUP_CHOSEN=3, AFTER_SPECIAL_PICKUP_CHOSEN=4`。

#### 7.2.4 服务端现状与**数据异常（本文档最高优先级发现）**

**服务端规模**【验】：`gacha.ts 79 / logic.ts 925 / limit-gacha.ts 102 / recruit.ts 442 / models.ts 151 / schemas.ts 98 / handler.ts 272 / gacha-up-list.ts 130`，共 13 条路由（`handler.ts:64,77,94,116,132,149,162,175,191,207,229,255,267`）。

**策略表分支**：`logic.ts:548-641` 的 `funcs` 表 13 键 —— `NORMAL:549, NEWBEE:554, DOUBLE:580, CLASSIC_DOUBLE:581, BACKFLOW:582, SPECIAL:583, LIMITED:584, LINKAGE:595, ATTAIN:596, CLASSIC:597, SINGLE:598, FESCLASSIC:638, CLASSIC_ATTAIN:639`【验】——覆盖 CS 全部 12 种 `GachaRuleType` + 客户端独立表来的 `NEWBEE`。未知键**显式抛错**（`logic.ts:645-651` `InternalError`）【验】。`_ruleTypeOf` 归一化（`:86-94`）把 `undefined/null/0/""` 视为 `NORMAL`，其余 `String(raw)`【验】。`resolveGachaRank`（`gacha.ts:52-79`）是**纯稀有度摇取函数**（六星曲线 `:68`、一次性 4★ 保底 `:70,75-77`），不含池类型分支【验】。规则→玩家子结构映射 `gacha-up-list.ts:17-31`【验】。

**⚠ P0 数据异常（本轮实测，两处）**

1. **`gachaRuleType` 存在未转换的数字枚举**：`data/excel/gacha_table.json` 的 `gachaPoolClient`（446 池）分布【验：node 直读】：
   `{"LIMITED":259,"DOUBLE":40,"CLASSIC":41,"SINGLE":35,"CLASSIC_DOUBLE":32,"SPECIAL":21,"LINKAGE":9,"ATTAIN":5,"7":3,"11":1}`
   —— `7` = `CLASSIC_ATTAIN`（`CLASSIC_ATTAIN_45_0_2 / 57_0_2 / 68_0_2`），`11` = `BACKFLOW`（`RETURN_71_0_1`）【验：node 直读 + `GachaRuleType.cs:26,34`】。
   生成类型只声明字符串联合（`types_excel_gen.ts:330`）【验】，与实测数据不符。
   **后果（代码链已验）**：`_ruleTypeOf` 产出 `"7"/"11"` → 不在 `funcs` → `logic.ts:645-651` 抛 `InternalError` → **这 4 个池抽卡直接 500**；同时 `GACHA_RULE_TYPE["7"]` 为 `undefined`，`handler.ts:240` / `gacha-up-list.ts:103` 回落 `"single"`，与 `CLASSIC_ATTAIN: "classic"` 的语义不符。

2. **`NORM_*` 233 池全部标为 `LIMITED`，`FESCLASSIC_*` 14 池全部标为 `SPECIAL`**（按前缀聚合实测）【验：node 直读】：
   | 前缀 | 池数 | 表中 ruleType | 应为 |
   |---|---|---|---|
   | `NORM_*` | 233 | `LIMITED` | `NORMAL(0)`（池详情文本自称"该寻访为【标准寻访】"） |
   | `FESCLASSIC_*` | 14 | `SPECIAL` | `FESCLASSIC(6)`（`FESCLASSIC_38_0_2` 的 `gachaObjList` 有 16 个候选、`upCharInfo.perCharList` 为空） |
   | `CLASSIC_ATTAIN_*` | 3 | `7`（数字） | `CLASSIC_ATTAIN(7)`（值对，类型错） |
   | `RETURN_*` | 1 | `11`（数字） | `BACKFLOW(11)`（值对，类型错） |
   | `LIMITED_*`/`CLASSIC_*`/`SINGLE_*`/`DOUBLE_*`/`LINKAGE_*`/`ATTAIN_*`/`SPECIAL_*`/`CLASSIC_DOUBLE_*` | 其余 | 正确字符串 | — |
   **【推测】** 根因是 excel 生成管线的枚举转换缺陷（该文件由 `git log 7076f0c "excel 生成器与 ArknightsGameData 对齐——…CS 枚举污染，全量重生成"` 引入/重写）；无法用外部源表交叉验证（本轮 web 检索不可用）。**无论根因如何，服务端对表值零防御是已验事实。**
   **后果 1（保底语义）**：`_pityKey`（`logic.ts:162-165`）对 `LIMITED/LINKAGE` 按 `poolId` 隔离【验】→ 233 个标准池变成"每池独立保底"，与官方"标准寻访保底跨池累计、不因池结束清零"（该文本就在 `NORM_0_1_1` 的 `gachaPoolDetail` 内）相反。
   **后果 2（300 抽赠送越权）**：`LIMITED` 分支给每抽塞 `LMTGS_COIN`（`logic.ts:584-593`）【验】，且 `claimLimitFreeChar`（`:207-232`）只校验 `rec.poolCnt >= 300`——标准池抽满 300 也能领"当期 UP 六星"。
   **后果 3（商店选池）**：`currentLimitedPool`（`SRV/app/game/modules/shop/logic/fes.ts:256,259`）按 `gachaRuleType === "LIMITED"` 过滤【验】，现在会命中 233 个标准池 → LMTGS 限定商店可能选到标准池、按错误代币生成商品（`fes.ts:289` 同因）【验】。
   **后果 4（高级凭证区）**：`_currentStandardPool`（`low-high.ts:222,225`）按 `Number(p.gachaRuleType) === 0` 过滤【验】→ 实测无任何池满足 → **恒返回 null**，高级凭证区干员商品无来源。
   **后果 5（中坚甄选券）**：`_currentFesClassicPool`（`low-high.ts:259,262`）按 `=== "FESCLASSIC"` 过滤【验】→ 实测无池满足 → **恒返回 null**，甄选券商品永不生成；`_currentClassicPool`（`:243`）用 `/^(CLASSIC|FESCLASSIC)/` 正则会命中 `CLASSIC_*`，但 `FESCLASSIC_*`（现标 `SPECIAL`）漏掉【验】。

3. **服务端自造字段 `gachaObjGroups` 在 CS 中不存在**【验】：`reference/com.hypergryph.arknights_2.7.71.cs` 中 `gachaObjGroups` 计数 = **0**，真实字段是 `gachaObjList`（签名 `:89984`；`CS/Torappu/GachaDetailData.cs:302`）；`GachaObjGroup`（含 `groupType/startIndex/endIndex`）类也不存在（签名仅 15 处 `GachaObjGroupType`，即枚举名本身）。服务端却把它当"客户端解析必需字段"：
   - 类型声明 `SRV/app/game/excel/excel.ts:854-861`（同时声明了 `gachaObjGroups` 与 `gachaObjList`），`GachaObjGroup` 于 `:875-879`；
   - 强行补齐 `SRV/app/game/modules/gacha/gacha-up-list.ts:93-97` 与 `logic.ts:251-257`；
   - 实际数据 `data/gacha_detail_table.json` 的 detail 键为 `availCharInfo, gachaObjList, limitedChar, showRecruit6StarHint, upCharInfo, weightUpCharInfoList`【验】——**没有 `gachaObjGroups`**。
   影响有限（多一个客户端忽略的字段；`gachaObjList` 在回退分支被 `...first` 保留，只有完全空表的最小分支缺），但注释结论是错的，且回退池会**沿用首个池的 `gachaObjList`**（自选池对象组错位）。
4. **`getPoolDetail` 恒回 `gachaObjGroupType: 0`**（`handler.ts:179`）【验】，忽略请求值（`schemas.ts:57-61` 收下但不用）【验】；客户端 `GetCurrentGachaObjGroupType`（`RecruitDataConverter.cs:1843`）会传 `1..4` 表达"自选前/后"→ 中坚甄选/特殊自选的"已选/未选"对象组切换在服务端不可能生效。

#### 7.2.5 抽卡差异表

| # | 分类 | 优先级 | 客户端证据 | 服务端证据 |
|---|---|---|---|---|
| G1 | 行为不一致（→500） | **P0** | `GachaRuleType.cs:26,34`（`CLASSIC_ATTAIN=7`、`BACKFLOW=11`）↔ `data/excel/gacha_table.json` 实测 3+1 池为数字 `7/11` | `logic.ts:86-93` `String(raw)` → `logic.ts:645-651` 抛 `InternalError`（4 池抽卡 500）；`handler.ts:240` 回落 `single` |
| G2 | 行为不一致 | **P0** | `NORM_0_1_1` 的 `gachaPoolDetail` 自称"标准寻访"＋官方保底跨池累计文案 | `data/excel/gacha_table.json` 233 个 `NORM_*` 标 `LIMITED` → `logic.ts:162-165` 按池隔离保底；`logic.ts:207-232` 允许标准池领 300 抽赠送；`logic.ts:584-593` 误发 `LMTGS_COIN` |
| G3 | 行为不一致 | **P1** | `GachaRuleType.NORMAL=0`（`GachaRuleType.cs:12`） | `shop/logic/low-high.ts:222,225` `Number(p.gachaRuleType) === 0` → 恒 null，高级凭证区商品无来源（同文件 `:218` 注释与实测冲突） |
| G4 | 行为不一致 | **P1** | `GachaRuleType.FESCLASSIC=6`（`GachaRuleType.cs:24`） | `shop/logic/low-high.ts:259,262` `=== "FESCLASSIC"` → 恒 null，甄选券商品不生成 |
| G5 | 缺失 | P2 | `UseCharGachaVoucherRequest/Response`、`VoucherGachaDetail*`（`CS/Torappu/`） | `gacha/handler.ts` 13 条路由无对应实现【验】 |
| G6 | 部分实现 | P2 | `GachaObjGroupType` 5 值（`GachaDetailData.cs:79-91`）+ `RecruitDataConverter.cs:1843` | `handler.ts:179` 恒回 0；`gacha-up-list.ts:93-97` 补的 `gachaObjGroups` 在 CS 不存在（签名计数 0） |
| G7 | 行为不一致 | P2 | `GachaResult.isNew: bool`（`GachaResult.cs:38`）【验】；`CombineGachaItem` 只有 `id/count`（`:6,10,14`） | `kernel/model.ts:24` 声明 `isNew: number`；`models.ts:108-112` 给 `CombineGachaItem` 多一个可选 `type` |
| G8 | 行为不一致 | P2 | `GetFreeCharResponse` 只有 `items`（`GetFreeCharResponse.cs:7,11`） | `models.ts:148-151` 多返回 `result`；`models.ts:91` 把 `hasRateUp` 标可选而 CS `:18` 是必填 |
| G9 | 已实现 | — | `AdvancedGachaRequest/TenAdvancedGachaRequest` 字段（`AdvancedGachaRequest.cs:6-18`） | `models.ts:94-125` + `handler.ts:191,207` 字段一一对应；保底走 `gacha.normal[poolId]{cnt,maxCnt,avail}`【验：`logic.ts:830-857`】 |

---

### 7.3 任务 / 签到 / 勋章（Mission / CheckIn / Medal）

#### 7.3.1 Mission

**协议类**【子代理，行号经由 `ServiceCode.cs` 交叉验证】：`ConfirmMissionRequest{missionId}`、`ConfirmMissionListRequest{missionIds}`、`ConfirmMissionGroupRequest{missionGroupId}`→`ConfirmMissionGroupResponse{items:MissionGroupRewards[]}`、`AutoConfirmMissionsRequest{type:MissionType}`→`AutoConfirmMissionsResponse{items:ItemBundle[]}`、`ExchangeMissionRewardsRequest{targetRewardsId}`；`ConfirmMissionResponse`/`ExchangeMissionRewardsResponse` **只有 `PlayerDeltaResponse`，无自有字段**。

**端点常量（比按类名 grep 更可靠）**【验】`CS/Torappu.Network/ServiceCode.cs`：
`:416` `/mission/exchangeMissionRewards`；`:419` `mission/confirmMission`（**无前导 `/`**）；`:422` `mission/confirmMissionList `（**尾随空格**）；`:425` `mission/confirmMissionGroup`；`:428` `/mission/confirmMultiGroupMissionList`；`:431` `mission/autoConfirmMissions`。

**模板与状态**【验/子代理】：表行 `MissionData`（`MissionData.cs:11,28` type/`:41` template/`:49` param/`:57` unlockParam/`:61` missionGroup/`:73` rewards）；`MissionType`（`MissionType.cs:9`，13 成员，含 `TOWERSEASON:28`【验】）；表 `MissionTable`（`MissionTable.cs:7-51`）；存档 `PlayerDataModel.mission`（`PlayerDataModel.cs:134`）→ `MissionPlayerData{missions, missionRewards, missionGroups, pinnedSpecialOperator}`；`MissionPlayerState{state:MissionHoldingState, progress:List<MissionCalcState>}`（`MissionPlayerState.cs:11,15`【验】）；`MissionHoldingState{NOT_OPEN,IN_EFFECT,CONFIRMED,FINISHED}`（`MissionHoldingState.cs:9-15`【验】）= 客户端 0/1/2/3 显示态；`MissionCalcState{target,value,compare}`。

**每日/每周/主线/活动如何区分（双层）**【验/子代理】：
1. **表字段** `MissionData.type`（`MissionType`）+ `MissionGroup.type`；
2. **存档分桶字符串常量** `MissionPlayerDataGroup.MissionTypeString`（`MissionPlayerDataGroup.cs:10`，成员 `DAILY:13/WEEKLY:16/ACTIVITY:19/MAIN:22/SUB:25/GUIDE:28/OPENSERVER:31/RETRO:34/SPECIAL_OPERATOR:37/SPECIAL_OPERATOR_WEEKLY:40`）【验：`:10` + `DAILY:13`】。

**判定位置**：**客户端不做权威判定**。唯一本地判定是展示用 `MissionViewModel.CheckIfAbleToFinish()`（`CS/Torappu.UI.Mission/MissionViewModel.cs:125`）= `state != CONFIRMED && value >= target`【子代理】；进度累加/完成/发奖全在服务端。

**服务端对照**【验】：端点 `SRV/app/game/modules/mission/handler.ts:36,46,54,64,72,90`（比客户端常量多一条 `confirmMissionList`，少 `confirmMultiGroupMissionList` 之外的差异）；`MissionProgress.init` 的 ACTIVITY 分支从 `excel.ActivityTable.missionData` 查模板（`logic.ts:1009-1031`）【验】；未实现模板 → `valid=false`、无监听器、进度永不推进（`logic.ts:1027-1030`、`:1086-1094`）【验】。

**模板覆盖实测**【验：node 直读 excel + grep 服务端注册表】：
- `MissionTable` 去重模板 **46 个，缺失 0**（`templates/` 6 文件共 95 个注册键，含未被引用的多余键）【验】。
- `ActivityTable.missionData`：**3646 条任务 / 93 个去重模板，其中 49 个未实现**（`PassActStageAndTargetSimple, ActAutoChessSeasonPassRound/PassGame/BondEffectCnt*, ActMultiV3*（13 个）, Act1Halfidle*, Act29SideCompleteDailyInvest, Act20side*, Act13sideCompleteDailyMission, Rlv2FreezeCopper/PassEnding/RecruitChar/PassZone/PerfectBattle/PassNodeType/KillCertainEnemy/CreateWithAct/SettleWithAct, Sandbox*, ActEvolveChar, ActUpgradeChar, ActUpgradeSkill, BattleFinishWithChar, ActMultiplayVerify2PassStageWithScore …`）【验】。

#### 7.3.2 CheckIn

- **协议**：`CheckInRequest`（无字段，`CheckInRequest.cs:6`）→ `CheckInResponse : PlayerDeltaResponse{signInRewards, subscriptionRewards}`（`CheckInResponse.cs:8,68,72`）【子代理】；端点 `CHECKIN_HOME = "/user/checkIn"`（`ServiceCode.cs:398`【验】）。
- **开服/链路签到**：`GetOpenServerCheckInRewardRequest{index}`、`ACTIVITY_CHECKIN = "/activity/getOpenServerCheckInReward"`（`ServiceCode.cs:341`【验】）、`ACTIVITY_CHAIN`（`:338`）/`ACTIVITY_CHAINFINAL`（`:344`）【验】。
- **长期签到**：`ReceiveLongTermCheckInRewardRequest{groupId}` → `Response{rewards:RewardItemModel[]}`，端点 `/user/recvLongTermCheckInReward`【子代理】。
- **状态类** `PlayerCheckIn`【验：`PlayerCheckIn.cs` 字段行】：`canCheckIn:62`、`checkInGroupId:66`、`checkInRewardIndex:70`、`checkInHistory:List<bool>:74`、`newbiePackage:78`、`newbieChooseGP:85`、`showCount:89`、`longTermRecvRecord:93`。
- **奖励表**：`CheckInTable{groups, monthlySubItem, currentMonthlySubId}`（`CheckInTable.cs:7,11,15,19`）↔ 实测 `data/excel/checkin_table.json` 顶层键恰为 `groups/monthlySubItem/currentMonthlySubId`，`groups` 48 组、`currentMonthlySubId="mCard_1"`【验】。
- **长期签到表**：`LongTermCheckInData{groupList, constData}`；实测 `data/excel/open_server_table.json` 顶层 `schedule,dataMap,constant,playerReturn,newbieCheckInPackageList,longTermCheckInData`，`longTermCheckInData.groupList` **4 条**【验】。
- **补签**：2.7.71 **不存在**补签协议/端点【子代理，依据 = 协议类全量列举 + `ServiceCode` checkin 端点仅 4 条】。
- **服务端对照**【验】：`SRV/app/game/modules/checkin/checkin.ts`（128 行）`dailyRefresh:19`（幂等 `:22`、`_bumpShowCount:34`）、`monthlyRefresh:59`、`checkIn:75`（发 `groups[groupId].items[idx]` `:90-104`、月卡 `:105-118`、`checkInHistory.push(0)` `:119`、`emit TotalCheckinCount` `:124`）；路由 `/user/checkIn` 于 `user/routes.ts:506`、长期签到于 `user/routes.ts:611`（条件 `startTs + level + days + longTermRecvRecord` `:621-634`）；活动签到 `activities/checkin/router.ts` 19 条（`:163,167,171,175,179,183,187,197,209,222,229,233,237,241,245,249,253,257,261`）【验：grep 计数 19】。
- **缺口（已验）**：`newbiePackage` / `newbieChooseGP`（`PlayerCheckIn.cs:78,85`）在 `app/` 中**只出现在生成类型** `types-playerdata.ts:365-366`，无任何读写【验：grep】；而数据侧 `open_server_table.json.newbieCheckInPackageList` 有 2 组（`new_bp_g_1` 等，含 `checkInDuration/checkInRewardDict`），客户端类 `NewbieCheckInPackageData`（`CS/Torappu/NewbieCheckInPackageData.cs:7,39,43`）也存在，且已进生成类型（`types_excel_gen.ts:9822-9828` OpenServerSchedule）【验】。

#### 7.3.3 Medal

- **协议**（3 条，均**无大类/展示位字段**）：
  - `GetRewardMedalRequest{medalId, group}`（`GetRewardMedalRequest.cs:6,10,14`【验】）→ `GetRewardMedalResponse{items}`，端点 `MEDAL_REWARD_REQUEST = "/medal/rewardMedal"`（`ServiceCode.cs:392`【验】）；
  - `MedalSetCustomDataRequest{index, data{layout:[{id,pos}]}}`（`MedalSetCustomDataRequest.cs:7,43,47`）→ 空体，端点 `MEDAL_SET_CUSTOM_DATA = "/medal/setCustomData"`（`ServiceCode.cs:395`【验】）；
  - `SetCardShowMedalRequest{type:NameCardMedalType, customIndex, templateGroup}`（`SetCardShowMedalRequest.cs:8,13,17,21`）→ 空体，端点 `SET_CARD_SHOW_MEDAL_REQUEST = "/social/setCardShowMedal"`（`ServiceCode.cs:380`【验】）。
- **模板与枚举**：`MedalData{medalList:MedalPerData[], medalTypeData:Dictionary<string,MedalTypeData>}`（`MedalData.cs:7,11,15`）【子代理】；`MedalPerData.medalId:11/template:35/unlockParam:39/advancedMedal:51/originMedal:55/medalRewardGroup:67`【子代理】；**勋章大类不是 C# 枚举，而是 `medalTypeData` 的字符串键**——实测 `data/excel/medal_table.json` 的 10 个键：`playerMedal/stageMedal/campMedal/towerMedal/growthMedal/storyMedal/buildMedal/activityMedal/rogueMedal/hiddenMedal`【验：node 直读】；`MedalRarity{T1,T1D5,T2,T2D5,T3,T3D5}`、`MedalExpireType{NONE,INIT,TEMP,PERM}`、`NameCardMedalType{EMPTY,CUSTOM,TEMPLATE}`【子代理】。
- **存档** `PlayerMedal{medals:Dictionary<string,PlayerPerMedal>, custom:PlayerMedalCustom}`（`PlayerMedal.cs:7,11,15`【验】）；`PlayerPerMedal.val: List<int[]>`（`val[0][0]`=当前、`val[0][1]`=目标）+ `fts/rts`【子代理】；**无 `display`/`medalList` 字段**。
- **服务端对照**【验】：`SRV/app/game/modules/medal/medal.ts`（3938 行）`MedalManager:36`（`init:68`、`rewardMedal:94`、`setCustomData`、`onMedalComplete:149`、`toJSON:220`）；handler 注册表 `MedalTemplateHandlers`（`medal.ts:3767-3938`）**170 条**，与 excel 的 170 个带 `template` 勋章**完全覆盖（missing = 0）**【验：node 直读 diff】；但其中 **82 个**实现体带注释「当前为占位实现（未接入玩法真实状态）」【验：grep -c = 82】。端点为 `user/routes.ts:570`（`/medal/rewardMedal`，body = `{medalId, group}`，schema `account/user.schema.ts:90-93` 两字段必填【验】）、`user/routes.ts:1160`（`/medal/setCustomData`）、`social/routes.ts:148`（`/social/setCardShowMedal`）【验】。
- **风险（已验）**：`SRV/app/game/modules/social/SocialManager.ts:255-260` 只在 `templateGroup` 含 `"Activity"`/`"Rogue"` 时映射大类，否则 `medalGroupId = ""` → 随即 `medalTypeData[""]` 为 `undefined`，`.groupData.find(...)!.medalId` 会 **TypeError 崩溃**（`SocialManager.ts:258-260`）【验】。

#### 7.3.4 任务/签到/勋章差异表

| # | 分类 | 优先级 | 客户端证据 | 服务端证据 |
|---|---|---|---|---|
| M1 | 行为不一致 | **P1** | `MissionType` 13 成员含 `TOWERSEASON`（`MissionType.cs:28`【验】） | `app/` 全仓仅生成类型出现 `TOWERSEASON`（`types_excel_gen.ts:364`），无任何分支【验：grep】 |
| M2 | 部分实现 | **P1** | `ActivityTable.missionData` 93 模板 / 3646 条（`data/excel/activity_table.json`）【验】 | `mission/templates/index.ts:15` 汇总 95 键；**49 个活动模板未注册** → `logic.ts:1027-1030` 置 `valid=false`，任务进度永不推进【验】 |
| M3 | 行为不一致 | **P1** | `MissionData.preMissionIds`（`MissionData.cs:37`）是链式解锁的权威来源 | `logic.ts:759-763` `_isChainHead` 按 `preMissionIds` 动态判定，而 `unlockNextMission`（`logic.ts:951-978`）仍用硬编码 `DAILY_START_LIST`(`:38`)/`WEEKLY_START_LIST`(`:77`)+`prefix_(num+1)` 推断——**两套口径并存**【验】 |
| M4 | 部分实现 | **P1** | `MedalPerData.template/unlockParam`（`MedalPerData.cs:35,39`），170 个模板勋章【验】 | `medal.ts:3767-3938` 170 键全覆盖，但 **82 个 handler 是"占位实现（未接入玩法真实状态）"**（如 `medal.ts:762,782,803…` 注释）【验】 |
| M5 | 行为不一致 | **P1** | `SetCardShowMedalRequest{type,customIndex,templateGroup}`（`SetCardShowMedalRequest.cs:8-21`） | `social/SocialManager.ts:255-260` 非 Activity/Rogue 的 `templateGroup` → `medalTypeData[""]` undefined 解引用【验】 |
| M6 | 缺失 | P2 | `PlayerCheckIn.newbiePackage:78` / `newbieChooseGP:85`；`NewbieCheckInPackageData.cs:7,39,43` | `app/` 中仅 `types-playerdata.ts:365-366` 声明，无任何读写；`open_server_table.json.newbieCheckInPackageList`（2 组）未被读取【验】 |
| M7 | 行为不一致 | P2 | `PlayerCheckIn.checkInHistory: List<bool>`（`PlayerCheckIn.cs:74`）【验】 | `checkin.ts:119` `checkInHistory.push(0)`，且生成类型写为 `number[]`（`types-playerdata.ts:364`）——不记日期、类型与 CS 不符【验】 |
| M8 | 已实现 | — | `MEDAL_REWARD_REQUEST`/`MEDAL_SET_CUSTOM_DATA`/`SET_CARD_SHOW_MEDAL_REQUEST`（`ServiceCode.cs:392,395,380`） | `user/routes.ts:570,1160` + `social/routes.ts:148` 三条齐全，body 字段与 CS 一致【验】 |
| M9 | 已实现 | — | `MISSION_CONFIRMMISSION:419` / `_LIST:422` / `_GROUP:425` / `_MULTI_GROUP:428` / `AUTOCONFIRM:431` / `EXCHANGE:416`（`ServiceCode.cs`）【验】 | `mission/handler.ts:36,46,54,64,72,90` 六条全齐【验】 |
| M10 | 部分实现（自造模型） | P2 | 客户端**无** `ConfirmMissionListResponse` / `ConfirmMultiGroupMissionListRequest` 类（仅端点常量 `ServiceCode.cs:422,428`）【子代理】 | `mission/models.ts:60,65` 自造这两个类型；`logic.ts:87` 自加 `confirmed` 防重字段（官方无）【子代理】 |

---

### 7.4 不确定 / 推测清单

1. **【推测】** `gacha_table.json` 的 `gachaRuleType` 异常（`NORM→LIMITED`、`FESCLASSIC→SPECIAL`、数字 `7/11`）根因是 excel 生成管线枚举转换缺陷（线索：`git log 7076f0c "…CS 枚举污染，全量重生成"`）。本轮 **web 检索不可用**（检索端点余额不足），无法与官方源表交叉验证；请在修数据前先用官方 CDN 原始表复核。**服务端零防御这一事实与根因无关，已验。**
2. **【子代理】** `GachaType.None = 4294967295`（`SRV gacha.ts:8-20`）对齐 32 位无符号序列化，与 CS `None = -1`（`GachaType.cs:9`）的 JSON 表达是否等价未验证。
3. **【子代理】** 客户端"请求类 → HTTP 路径"的映射表未在 CS 中找到（本轮路径均取自 `Torappu.Network/ServiceCode.cs` 常量、服务端 handler 注释与文档）。
4. **【子代理，未验证】** `SOCharMissionRequest` / `SOCharMissionGroupRequest` 被 `MissionState.cs:379,515` 引用但平铺目录无定义，疑在其它程序集/Lua 侧。
5. **【子代理，未验证】** 任务/勋章的客户端"可否领取"推导（`MissionModel._DealWithMissionData:718`、`MedalGetState` 的具体计算）因 Cpp2IL 标注 `AnalysisFailedException`，只能证明调用存在。
6. **【子代理，未验证】** `Act29sign`(17)/`Act33Sign`(8)/`Act1Blessing` 是否真被 `activities/checkin` 通用入口按 `activityId` 完整覆盖；`Act50side`(14)/`Act54Side`(44) 是否由 `sandbox` 的 `v2/*`、`v3/*` 路由间接承载。
7. **【子代理，未验证】** `Torappu.Arkvent` 是否只服务 ARKHUB；`Torappu.UI.ActArchive.RL03/RL06` 的确切语义。
8. **【未验证】** `activities/trainingGround` 在客户端无同名目录，其真实协议出处未定位。
9. **【验】** 本文所有"实测"数字均来自本轮 `node -e require('data/excel/*.json')` 与 `find … | wc -l`，未修改任何数据文件。

---

### 7.5 P0/P1 速查（跨三块）

| 优先级 | 条目 | 一句话 |
|---|---|---|
| **P0** | G1 | `CLASSIC_ATTAIN_*`×3 + `RETURN_*`×1 的 `gachaRuleType` 是数字 `7/11` → 抽卡 500（`logic.ts:645-651`） |
| **P0** | G2 | 233 个 `NORM_*` 池被标 `LIMITED` → 标准池保底按池隔离、可领 300 抽赠送、误发 `LMTGS_COIN` |
| **P1** | G3/G4 | 高级凭证区 / 中坚甄选券 的选池过滤条件与实测数据不匹配 → 商品恒空 |
| **P1** | A1 | `Act12D6`(57)/`CommonVasebreaker`(45)/`Act54Side`(44) 三族完全无路由 |
| **P1** | A2 | `act35side/38side/42side/45side/46side/arcade/teamQuest/typeAct` 玩法端点全为空 delta stub |
| **P1** | M2 | `ActivityTable.missionData` 49/93 个模板未注册 → 对应活动任务进度永不推进 |
| **P1** | M3 | `unlockNextMission`（`logic.ts:951`）与 `_isChainHead`（`:759`）链头判定两套口径 |
| **P1** | M4/M5 | 82 个勋章 handler 为占位实现；`SocialManager.ts:255-260` 空 key 解引用崩溃风险 |

## 8. 客户端路由 ⇄ 服务端覆盖度（2.7.71）

> 分析日期：2026-09-13　|　客户端：`reference/arknights-2.7.71-csharp`（Cpp2IL 反编译，23168 个 `.cs`）
> 服务端：`app/`（Express 5 + TS，DoctorateTs 当前工作树）
> 数据来源：本机实际执行的 `find | xargs grep` 提取 + `tsx` 挂载感知重建 + Python 差集。全部命令与中间产物见 §7。
> 图例：✅ = 已验证（人工 grep / 逐行读文件确认）　🔶 = 静态近似推断（解析器结论，未逐条人工复核）

---

### 8.1 客户端路由提取

#### 8.1.1 提取命令（实际执行）

```bash
# 口径 A：旧脚本口径 —— `*Service*.cs`/全部 .cs 里以 "/" 开头的字符串字面量
#   （复刻已删除的 scripts/_extract-routes.py：STR_RE 取字面量 → {expr} 归一为 X →
#     ^/[A-Za-z0-9_.][A-Za-z0-9_./-]*$ 且 s[1:] 含 "/"）
REF=reference/arknights-2.7.71-csharp
find $REF/Assembly-CSharp $REF/Assembly-CSharp-firstpass -name '*.cs' -print0 \
  | xargs -0 -P 16 -n 40 sh -c 'grep -EHno "\"/[^\"]*\"" "$@" > tmp/decompiled-analysis/slots/raw.$$' sh
#   → 861 条原始匹配，去重后 552 条
#   注：`-P 16` 并行写同一 fd 会按 4KB 块交织截断行（实测 861→846），故每个 xargs 子进程写独立文件再拼接

# 口径 B：常量声明口径 —— `const string NAME = "VALUE"`，VALUE 为路由形（允许无前导斜杠）
find $REF/Assembly-CSharp $REF/Assembly-CSharp-firstpass -name '*.cs' -print0 \
  | xargs -0 -P 16 -n 40 sh -c 'grep -EHn "const string [A-Za-z0-9_]+ *= *\"" "$@" > tmp/decompiled-analysis/slots/const.$$' sh
#   → 8691 条 const 声明；其中「路由形」452 条；落在 *Service*.cs / Torappu.Network 文件里的 145 条 → 去重 144 条

# 口径 C：交叉验证 —— 除 Assembly-CSharp(+firstpass) 外的其余 assembly
find $REF -mindepth 1 -maxdepth 1 -type d ! -name Assembly-CSharp ! -name Assembly-CSharp-firstpass -print0 \
  | xargs -0 -I{} find {} -name '*.cs' -print0 \
  | xargs -0 -P 16 -n 40 sh -c 'grep -EHno "\"/[^\"]*\"" "$@" > tmp/decompiled-analysis/slots/oth.$$' sh
#   → 其余 assembly 仅 1 条命中（`/proc/cpuinfo`，非路由）→ 路由字面量只存在于 Assembly-CSharp(+firstpass)
```

**最终客户端路由全集 = 口径 A ∪ 口径 B(仅 Service/Network 文件) = 696 条（去重）**，逐行落盘于
`tmp/decompiled-analysis/client-routes-2.7.71.txt`（696 行，每行一条绝对路径）。

#### 8.1.2 口径 B 是本次分析的关键修正（前次 2.7.61 分析未覆盖）

`Torappu.Network/ServiceCode.cs` 共 348 个 `const string`，其中 **209 个带前导 `/`、139 个不带**：

```csharp
// reference/.../Torappu.Network/ServiceCode.cs:659   ← 无前导斜杠
public const string BUILDING_BUILD_ROOM = "building/buildRoom";
// reference/.../Torappu.Network/ServiceCode.cs:710   ← 有前导斜杠
public const string BUILDING_FRIEND_GET_SORT_LIST = "/building/getClueFriendList";
```

旧 `_extract-routes.py` 只收留 `"/..."`，于是**所有无前导斜杠的常量被漏掉**——整整一族 `building/*`（63 条）、
`shop/*`、`charBuild/*`、`crisis/*`、`mail/*`、`mission/*` 等在此之前从未进入覆盖度统计。本次把
`const string` 声明纳入（仅限 `*Service*.cs` / `Torappu.Network`，以剔除 `ResourceUrls.cs`/`ResourceRouter.cs`
的 **304 条资源路径常量**干扰——它们是 `Arts/...`、`UI/...`、`Prefabs/...` 等资产路径，不是 HTTP 路由）。

#### 8.1.3 与「577 匹配」的关系

| 口径 | 文件集 | 原始匹配 | 去重 |
|---|---|---|---|
| 用户先前报告 | `*Service*.cs`（253 文件） | **577** | 未去重 |
| 本次复现 A（`"/[^"]*"` 字面量） | 同上 253 文件 | 604 | **552** |
| 本次复现 B（`const string` + 绝对路径） | 同上 253 文件 | 552 | ~552 |
| **本次全集**（A ∪ B 路由形常量） | Assembly-CSharp(+firstpass) | 861 + 144 | **696** |

- 577 与 604/552 的差异来自**正则写法不同**（是否要求落在 `const string` 声明行、是否计入插值串等）；我未能用任一
  单条正则精确复现 577。
- 真正有意义的数字是**去重后的 552（旧口径）与 696（修正口径）**；577 是「匹配行数」级的中介量。
- 口径 A 的 552 与 2.7.61 文档的 544 是**同一口径**，可直接对比（见 §4）。

---

### 8.2 服务端路由全集重建（挂载感知，静态近似）

#### 8.2.1 解析器

新增一次性脚本 `tmp/decompiled-analysis/.server-routes.ts`（**未改动** `app/`、`scripts/`、`reference/` 任何文件），
解析逻辑自 `scripts/route-diff.ts#collectDtsRoutes` 移植并增强：

```bash
XDG_DATA_HOME=/tmp/xdg-data HOME=/tmp/fakehome \
  ./node_modules/.bin/tsx tmp/decompiled-analysis/.server-routes.ts
# 注：本机 pnpm 全局目录 /root/.local/share/pnpm 只读，故直接调 node_modules/.bin/tsx 并改写 HOME/XDG
```

覆盖的注册形态：

1. `app/game/routes.ts` 声明式挂载表（61 条 `module:` 条目，含 `exportName: "rootRouter"`）；
2. `app/game/app.ts#setup()` 把该表挂到内层 app、`app/server.ts:545 app.use("/", game)` 根挂载（恒等）；
3. `app/server.ts` 的 `app.use("<prefix>", target)`：`/config/prod`、`/api/remote_config`、`/api/gate`、
   `/api/game`、`/`(auth)、`/assetbundle`、`/admin`（含 `await import(...)` 形态）；
4. 模块内 `router.use(child[, "/sub"])` **递归**展开（61 次 `use`，0 次未解析）；同文件局部 router 与跨文件导入 router 均跟踪；
5. `for (const p of ["/a","/b"]) { router.all(p) }` 字面量数组循环（5 处）；
6. **`for (const x of ["a","b"]) { router.post(\`/pre/${x}\`) }` 模板串循环**（12 处）——`route-diff.ts` 原版**不展开**
   这种写法，会把 `act13side/act27side/act35side/act46side/typeAct4d0/typeAct20side/autochessSeason/sandboxV2 racing`
   等成片活动路由误判为缺失，本脚本已补上；
7. `app/server.ts#OLD_AUTH_ALIASES`（11 条别名键）、`app/server.ts`/`app/game/app.ts` 内联 `app.<method>("...")`；
8. URL 重写别名与 `route-diff.ts` 的 `REWRITE_PREFIX_MAP` 一致：`/crisisV2/* ↔ /v2/*`（crisisV2Rewrite）、
   `/sandboxPerm/sandboxV2|V3/* ↔ /v2|/v3/*`（sandboxPermRewrite）；重写挂载下**内部路径与外部路径都保留**。

结果：**原始注册 1254 条 → 客户端可见唯一路径 1209 条**（扫描 81 个路由文件；`routeCalls=1058`、`loop=5`、
`loopTpl=12`、`use=31`、未解析 `router.use` 0 条）。落盘 `tmp/decompiled-analysis/server-routes.json`。

#### 8.2.2 已知局限（全部为静态近似，不排除少量假阳/假阴）

| 局限 | 说明 | 本仓实测影响 |
|---|---|---|
| 无运行时反射 | 未 `import` router 后读 `router.stack`，纯文本推导 | 少见的 `router.route("/x").get()`、变量前缀 `router.use(PREFIX, r)` 会漏；实测 `router.use` 非字面量前缀 **0** 处 |
| 方法维度未参与判定 | 客户端常量只有路径、无 HTTP 方法，故按**路径级**比对 | 覆盖度是「路径可达」而非「方法齐备」 |
| 通配参数近似 | `:param` / `*splat` 按「一段通配」匹配，未实现 Express 完整语义 | 服务端仅 62 条含通配；未出现把客户端路由整片吞掉的 catch-all |
| 重写双挂载 | rewrite 挂载同时保留内部与外部路径 | 使 stale 表里出现 `/crisisV2/v2/*`、`/sandboxPerm/v2/*` 等**非客户端可见**的伪路径 |
| 别名双挂载 | 同域多前缀别名（如 `/autochess` 与 `/activity`）都算命中 | stale 计数偏高（见 §3.2） |
| 未建模 Express 大小写不敏感 | 判定先做小写归一，再区分「严格一致 / 仅大小写不敏感」 | 已单列 11 条（见 §3.1） |

---

### 8.3 差集分析

#### 8.3.1 「客户端有、服务端无」= 14 条（✅ 全部经 grep 复核）

> 判定：696 条客户端路由中，**671 条严格路径命中**，**11 条仅大小写不敏感命中**（Express 默认
> `caseSensitive=false`，运行时可达，不列为缺失），**14 条缺失**。
> 覆盖率：严格 671/696 = **96.41%**；含大小写不敏感 (671+11)/696 = **97.99%**。

| 路径 | 客户端定义位置（文件:行） | 所属域 | 影响 |
|---|---|---|---|
| `/activity/act54side/reading` | `Torappu.Activity.Act54Side/Act54SideService.cs:9`（`ACT54SIDE_DIVINE`） | activity | 2.7.71 新活动 Act54Side 的剧情阅读；excel `Act54SideData` 整族亦缺失（`docs/fbs-crosscheck-2026-09-12.md` 标为「新版活动」）→ 进入活动即 404 |
| `/activity/act54side/getFinalReward` | 同上 `Act54SideService.cs:12` | activity | 同上：活动最终奖励无法领取 |
| `/activity/act1dp/battleStart` | `Torappu.Activity.CommonVasebreaker/ActVasebreakerService.cs:9` | activity | 2.7.71 新活动 ActVasebreaker（act1dp，砸罐小游戏；`ActVasebreakerData` 缺失）战斗无法开始 |
| `/activity/act1dp/battleFinish` | 同上 `ActVasebreakerService.cs:12` | activity | 同上：战斗结算无法提交 |
| `/activity/interlock/battleStart` | `Torappu.Activity.Act1Lock/Act1LockService.cs:24` | activity | 联锁竞赛（act1lock）常规战开始；服务端 `interlock/routes.ts` 仅有 milestone/milestoneBatch/setDefend/setSquad |
| `/activity/interlock/battleFinish` | 同上 `Act1LockService.cs:27` | activity | 同上：常规战结算 |
| `/activity/interlock/finalBattleStart` | 同上 `Act1LockService.cs:30` | activity | 终局战（finalBattle）开始 |
| `/activity/interlock/finalBattleFinish` | 同上 `Act1LockService.cs:33` | activity | 终局战结算 |
| `/rlv2/finishGame` | `Torappu.UI.RoguelikeTopic/RoguelikeTopicService.cs:12` | rlv2 | 肉鸽V2 通关结算；**2.7.61 六条遗留中唯一未补齐的一条**（其余 5 条已实现，见 §4） |
| `/recalRune/gainSeasonReward` | `Torappu.Network/ServiceCode.cs:632` | recalRune | 危机合约「重岳」赛季奖励领取；`recalRune/battleStart|battleFinish` 已是 stub，唯独领奖无注册 |
| `/roguelike/chooseInitialScene` | `Torappu.Network/ServiceCode.cs:851` | roguelike | 肉鸽V1 初始场景选择（`ROGUELIKE_SELECT_INITIAL_CHOICE`） |
| `/roguelike/upgradeChar` | `Torappu.Network/ServiceCode.cs:911` | roguelike | 肉鸽V1 干员升级；注意 `/charBuild/upgradeChar` 已实现（`character/routes.ts:96`），缺的是 roguelike 域 |
| `/shop/buyGPGood` | `Torappu.Network/ServiceCode.cs:497` | shop | GP（高级凭证）商品购买；服务端只有 `/shop/buyGPGoodWithTicket`（`shop/handler.ts:944`），路径不同 |
| `/shop/buyGachaSkinGood` | `Torappu.Network/ServiceCode.cs:506` | shop | 寻访皮肤（`SHOP_BUY_BLINDBOX_GOOD`）凭证购买 |

**缺失域分布：`/activity/` 8（act1dp 2、act54side 2、interlock 4）、`/roguelike/` 2、`/shop/` 2、`/recalRune/` 1、`/rlv2/` 1。**

仅大小写不敏感命中的 11 条（运行时可达，非缺失）：

| 客户端路径 | 服务端实际注册 | 说明 |
|---|---|---|
| `/deepSea/{branch,choice,event,node,place,story,techTreeActive,techTreeUnlock,treasure}`（9 条） | `/deepsea/...` | 客户端 camelCase「Sea」，服务端全小写；Express 默认大小写不敏感 |
| `/shop/buyRepGood` → `/shop/buyREPGood`、`/shop/getRepGoodList` → `/shop/getREPGoodList`（2 条） | 大小写差异 | 同上 |

#### 8.3.2 「服务端有、客户端 2.7.71 已无」= 静态近似清单（🔶）

服务端 1209 条唯一路径中 **527 条**未被任何客户端路由匹配。直接当成「陈旧」会严重高估，按成因拆解：

| 类别 | 数量 | 说明 |
|---|---|---|
| `/admin/*` 运营控制面 | 103 | Dashboard/CLI 用，本就不由游戏客户端调用 |
| `misc-alignment` 全量对齐 stub | 51 | 遥测/ODP/支付变体等「路径可达性」占位 |
| 别名双挂载（同尾路径已被客户端命中） | 114 | 例如 `/autochess/autochessSeason/*` 与 `/activity/autochessSeason/*` 同时注册 |
| **残余** | **263** | 其中基础设施前缀（`/api/`、`/config/`、`/u8/`、`/plugin/`、`/assetbundle/`、`/audit/`、`/announce/`、`/app/`、`/pcSdk/`…）37 条；`sandbox`+`sandboxPerm` 145 条、`crisis`+`crisisV2` 23 条多为 rewrite/别名双挂载（§2.2 已知伪路径） |

去掉上述噪声后，**面向游戏客户端、且 2.7.71 客户端字面量集合中确实没有的注册**（🔶 推断，可能是历史别名、
已下架活动、或客户端用未提取的动态构造拼路径）：

| 路径 | 服务端来源 | 备注 |
|---|---|---|
| `/activity/actBlessOnly/{getCheckInReward,changeFestivalChar}` | `activities/checkin/router.ts:249,253` | 旧版签到活动族 |
| `/activity/actCheckinAccess/getCheckInReward`、`/activity/actCheckinvs/sign` | `checkin/router.ts:257,179` | 旧版签到活动族 |
| `/activity/checkinAllPlayer/{getActivityCheckInReward,syncBehaviorData,getAllBehaviorReward}` | `checkin/router.ts:229,233,237` | 旧版签到活动族 |
| `/activity/{getCheckInReward,getSwitchOnlyReward,getActivityCheckInVideoReward,changeFestivalChar}` | `checkin/router.ts:241,183,222,245` | 旧版签到活动族 |
| `/activity/{loginOnly/getReward,loginOnlyUnique/getReward,prayOnly/getReward}` | `checkin/router.ts:187,209,197` | 旧版签到活动族 |
| `/actcheckinvs/sign` | `checkin/router.ts:268` | 同上（无 `/activity` 前缀的别名） |
| `/activity/autoConfirmMissions` | `activities/milestone/router.ts:169` | 客户端走 `/mission/autoConfirmMissions`（`ServiceCode.cs:431`），此为旧别名 |
| `/activity/teamQuest/refreshInfo` | `activities/teamQuest/router.ts:135` | 客户端 2.7.71 无此路径 |
| `/activity/vecBreakV2/getSeasonRecord` | `vecbreak/routes.ts:68` | 客户端改为根挂载 `/vecBreakV2/getSeasonRecord`（别名挂载残留） |
| `/aprilFool/act4fun/liveSettle` | `aprilFool/routes.ts:142` | 客户端用 `/aprilFool/act4fun/battleFinish` 等 |
| `/businessCard/changeNameCardComponent`、`/businessCard/changeNameCardSkin` | `businessCard/routes.ts:33`、`:23` | 疑似更名/下架 |
| `/gallery/jpg/:jpgName`、`/gallery/jpg/:jpgName.png` | `user/routes.ts:953`、`:964` | 客户端走 `/gallery/*` 其他路径 |
| `/quest/battleContinue`、`/quest/changeSquadName2` | `quest/routes.ts:154`、`:94` | 疑似下架 |
| `/shop/buyGoodWithTicket`、`/shop/buyREPGoodWithTicket` | `shop/handler.ts:832`、`:676` | 客户端 2.7.71 无对应字面量（走 `/shop/buyGPGoodWithTicket`） |
| `/rlv2/{battlePass_getReward,buyGoods,leaveShop,nodeMission_closeTip,nodeMission_confirm,nodeMission_giveUp,scrap}` | `roguelike/handler.ts:514,416,408,634,620,627,746` | 下划线/旧式别名；客户端用 `/rlv2/battlePass/getReward`、`/rlv2/nodeMission/*` |
| `/user/auth/v1/*`（11 条，如 `:356`）、`/user/info/v1/basic`(`auth.ts:138`)、`/user/oauth2/v2/grant`(`:251`) | `auth.ts` | 启动器/SDK 入口与 `OLD_AUTH_ALIASES` 目标，非游戏内客户端直调 |
| `/building/cleanRoom`、`/building/usePresetQueue` | `building/handler.ts:636`、`:578` | 客户端字面量为 `cleanRoomSlot`/`useOnePresetQueue`（`ServiceCode.cs:662,818`） |

---

### 8.4 与 2.7.61 结论对照

`docs/接口覆盖分析-未实现与stub清单.md`（2026-08-17，对象 2.7.61）基线：官方 **544**、已实现 **529**（严格路径）、
大小写变体 **9**、完全未实现 **6**（全部 `/rlv2/*`）。

**同口径（旧脚本 `"/"` 字面量口径）2.7.71 重算：**

| 口径（完全一致） | 2.7.61 | 2.7.71 | Δ |
|---|---|---|---|
| 客户端路由总数（去重） | 544 | **552** | **+8** |
| 严格路径命中 | 529 | **538** | **+9** |
| 仅大小写不敏感命中 | 9 | 9 | 0 |
| 完全未实现 | 6 | **5** | **−1** |
| 覆盖率（含大小写） | 98.90% | 99.09% | +0.19pp |

**2.7.61 的六条未实现接口现状（✅ 逐条 grep 确认）：**

| 2.7.61 缺失路由 | 2.7.71 现状 | 服务端注册位置 |
|---|---|---|
| `/rlv2/battlePass/buyReward` | **已实现** | `app/game/modules/roguelike/handler.ts:527`（逻辑 `battle-nav.ts:240`） |
| `/rlv2/copper/change` | **已实现** | `roguelike/handler.ts:561`（`logic.ts:730`） |
| `/rlv2/copper/confirmDraw` | **已实现** | `roguelike/handler.ts:569`（`logic.ts:747`） |
| `/rlv2/normal/unlockBuff` | **已实现** | `roguelike/handler.ts:549` |
| `/rlv2/setSeed` | **已实现** | `roguelike/handler.ts:541`（`game-init.ts:58`） |
| `/rlv2/finishGame` | **仍缺失** | 无任何注册（`grep` 0 命中） |

**新增/消失：**
- **新增（同口径 +8）**：可点名的是 2.7.71 新活动族 **Act54Side（2 条：reading / getFinalReward）** 与
  **ActVasebreaker = act1dp（2 条：battleStart / battleFinish）**——两者均无任何服务端实现，且对应 excel 整族缺失
  （见 `docs/fbs-crosscheck-2026-09-12.md`「新版活动」）。其余 4 条无法逐条点名，原因见下。
- **消失**：无法给出逐条清单——2.7.61 的完整客户端路由清单 `reference/client-routes.txt` 已随提取脚本一同删除，
  且 `reference/` 被 gitignore（`git log --all` 仅能恢复 `.py` 脚本，恢复不到其输出）。故「−X 条消失」不可验证。
- **任务点名族核对（✅）**：`Act42Side` 4/4 已实现、`Act45Side` 2/2 已实现、`Act42D0` 5/5 已实现、
  `mainlineClue` 3/3 已实现、`act46side` 5/5、`arkodc` 5/5；**`Act54Side` 0/2 缺失**（新活动）。
  `act53side` 在 2.7.71 客户端字面量中为 0 条（该活动无独立 HTTP 路由，走 `/arkodc/*`）。

---

### 8.5 抽验（防止解析器假阴性 / 假阳性）

#### 8.5.1 从「已判定实现」随机抽 5 条 —— ✅ 人工打开服务端文件确认

| 客户端路由 | 服务端注册（文件:行，已逐行核对） | 挂载前缀 |
|---|---|---|
| `/building/gainAssistIntimacy` | `app/game/modules/building/handler.ts:314` → `router.post("/gainAssistIntimacy", …)` | `/building` |
| `/mainlineClue/getRewards` | `app/game/modules/user/routes.ts:757` → `rootRouter.post("/mainlineClue/getRewards", …)` | `/`（rootRouter） |
| `/aprilFool/act4fun/battleFinish` | `app/game/modules/aprilFool/routes.ts:131` → `router.post("/act4fun/battleFinish", …)` | `/aprilFool` |
| `/troop/SpecialOperatorUnlockNode` | `app/game/modules/user/routes.ts:842` → `rootRouter.post("/troop/SpecialOperatorUnlockNode", …)` | `/`（rootRouter） |
| `/activity/autochessSeason/removeChessPoolChar` | `app/game/modules/autochess/routes.ts:103` → `router.post("/autochessSeason/removeChessPoolChar", …)`；同域循环展开见 `activities/typeAct/router.ts:236` | `/activity` |

#### 8.5.2 从「判定缺失」抽 5 条 —— ✅ 全项目（`app/**/*.ts`）grep 无注册

| 缺失路由 | 绝对路径 grep | 末段本地路径 grep（含模板/循环） |
|---|---|---|
| `/activity/act54side/reading` | 0 | 0 |
| `/activity/act1dp/battleStart` | 0 | 0 |
| `/activity/interlock/finalBattleFinish` | 0 | 0 |
| `/recalRune/gainSeasonReward` | 0 | 0 |
| `/shop/buyGPGood` | 0 | 0（`/shop/buyGPGoodWithTicket` 是不同路径） |

> 另 9 条缺失同样 grep 为 0 命中。唯一「干扰命中」是 `/roguelike/upgradeChar` 的末段 `/upgradeChar` 命中
> `app/game/modules/character/routes.ts:96`——但该文件挂载在 `/charBuild` 前缀下，客户端可见路径是
> `/charBuild/upgradeChar`，与 `/roguelike/upgradeChar` 不同域，缺失判定成立。这正是「挂载感知」相较
> 「按末段 grep」的价值。

---

### 8.6 结论表

| 项 | 数量 | 口径 |
|---|---|---|
| 客户端路由总数（去重，2.7.71） | **696** | ✅ 口径 A(552) ∪ 口径 B(144) |
| 服务端注册路由（客户端可见唯一路径） | **1209**（原始注册 1254） | 🔶 挂载感知静态重建 |
| 严格路径命中 | **671** | ✅（含 5 条抽验） |
| 仅大小写不敏感命中（运行时可达） | **11** | ✅（9 deepSea + 2 shop） |
| **缺失** | **14** | ✅ 全部 grep 复核为 0 注册 |
| **覆盖率（严格）** | **96.41%** | 671 / 696 |
| **覆盖率（含大小写不敏感）** | **97.99%** | 682 / 696 |
| 对照：旧脚本同口径（2.7.61 → 2.7.71） | 544 → 552（+8） | 缺失 6 → 5 |
| 「服务端有、客户端无」 | 527（含 admin 103 / stub 51 / 别名 114 / 残余 263） | 🔶 静态近似，多数为别名与伪路径 |

**优先级建议（按影响面）**：
1. `P0` Act54Side 2 条 + ActVasebreaker(act1dp) 2 条 —— 2.7.71 新活动，路由与 excel 双缺，活动完全不可玩；
2. `P1` interlock 4 条 —— 联锁竞赛战斗链路（可与通用 battle 结算复用）；
3. `P1` `/rlv2/finishGame` —— 2.7.61 遗留的肉鸽V2 通关结算；
4. `P2` `/recalRune/gainSeasonReward`、`/roguelike/chooseInitialScene`、`/roguelike/upgradeChar`、
   `/shop/buyGPGood`、`/shop/buyGachaSkinGood` —— 单点接口，多为领奖/购买入口。

---

### 8.7 可复跑产物与脚本

| 文件 | 内容 |
|---|---|
| `client-routes-2.7.71.txt` | **最终客户端路由清单，696 行，每行一条** |
| `.extract2.sh` | 客户端提取（口径 A/B，PID 分文件避免并行交织） |
| `slots/all-located.raw` / `slots/const-decls.raw` | 口径 A（861 条）/ 口径 B（8691 条 const 声明）原始带位置匹配 |
| `.server-routes.ts` + `server-routes.json` | 服务端挂载感知重建（1209 条唯一路径 + 来源 file:line） |
| `.diff-final.json` | 差集全量结果（客户端位置、命中/缺失/大小写、stale 分类） |
| `.old_extract_routes.py` / `.old_diff_client_routes.py` | 自 git `2f92ca3^` 恢复的已删除脚本（仅作口径参照） |

> 复跑顺序：`bash .extract2.sh` → `XDG_DATA_HOME=/tmp/xdg-data HOME=/tmp/fakehome ./node_modules/.bin/tsx .server-routes.ts`
> → 差集 Python（见 `.diff-final.json` 生成命令，脚本内联于本次会话，未落盘为独立文件）。

## 8b. 两路独立提取的口径冲突与裁决（主分析者复核）

本次分析中，「客户端路由 ⇄ 服务端覆盖度」由**两路独立完成**，结论一度不一致，这里给出裁决过程——它本身也是最有价值的方法论产出之一。

| 来源 | 客户端路由口径 | 判定缺失 | 缺失清单 |
|---|---|---|---|
| 第 3 节（协议层视角） | 全树 `"/…"` 字面量 → **552 条** | **9 条** | rlv2/finishGame、act1dp×2、act54side×2、sandboxPerm/sandboxV2/racing/{register,learnTalent,release,saveMark} |
| 第 8 节（覆盖度视角） | 常量声明 + 无前导斜杠修正 → **696 条** | **14 条** | act54side×2、act1dp×2、interlock×4、rlv2/finishGame、recalRune/gainSeasonReward、roguelike/{chooseInitialScene,upgradeChar}、shop/{buyGPGood,buyGachaSkinGood} |

**裁决：以第 8 节的 14 条为准。** 第 3 节那 4 条「沙盒竞速缺失」是**假阳性**，根因已定位并复现：

- 服务端在 `app/game/modules/sandbox/routes.ts:1185-1197` 用 **`for-of` + 模板字符串**批量注册：
  `for (const racingRoute of ["battleStart","battleFinish","learnTalent","register","release","saveMark"]) router.post(\`/v2/racing/${racingRoute}\`, …)`
- 客户端路径 `/sandboxPerm/sandboxV2/racing/register` 经挂载重写 `sandboxPermRewrite` 映射为 `/sandbox` 前缀下的 `/v2/racing/register` → **命中**。
- 第 3 节的静态普查脚本**不展开模板字符串循环**；第 8 节的解析器专门实现了「for-of 模板串展开」（并明确指出 `scripts/route-diff.ts` 原版缺此能力会成片误报）。

**复核证据**（主分析者实跑）：`grep -o '"[^"]*racing[^"]*"' tmp/decompiled-analysis/server-routes.json` 得到 `/sandbox/v2/racing/{battleStart,battleFinish,learnTalent,register,release,saveMark}`；`app/game/modules/sandbox/routes.ts:1193` 为模板串注册点。

**结论**：最终缺失 **14 条**，覆盖率 **96.41%**（严格命中 671/696）/ **97.99%**（含大小写不敏感 11 条）。两路口径的其余结论互补而非冲突——第 3 节提供协议类普查（1489 类）与报文编码结论，第 8 节提供完整路由差集。

> 教训（可直接固化为工具约束）：**任何「服务端路由重建」工具都必须展开 `for-of` 字面量数组与模板字符串注册**，否则会把成片的批量注册误判为缺失；反过来，客户端路由提取必须同时覆盖**带前导斜杠与不带前导斜杠**两种常量写法（`ServiceCode.cs` 348 条常量中有 139 条不带 `/`）。

---

## 9. 差异总表与优先级建议

> 本章是全文的收敛：把第 2~8 节的发现压成一张「域 → 服务端状态 → 最高优先级」总表，并给出修复顺序、文档纠偏清单与置信度说明。
> **主分析者的独立复核**已在表中用 `✅复核` 标出（即我本人重新执行命令/读代码确认过，不只是采信子代理结论）。

### 9.1 全域总览

| 域 | 客户端侧规模（2.7.71） | 服务端现状（快照 2026-09-13 ~11:00） | 差异条目 | 最高优先级 | 章节 |
|---|---|---|---|---|---|
| 代码地图 | 23,168 `.cs`；UI 层 10,907（49.5%）、协议数据面 2,853（13.0%）、活动 3,216、战斗 2,589 | —— | —— | —— | 第 2 节 |
| 网络与协议层 | 全树协议类 **1489 个**（746 `Request` / 689 `Response`，来自 1442 个文件）；扁平 `Torappu/` 只是子集（290+286 → 564 类） | 706 处路由注册、50 个模块；`secret`/`uid`/`Content-Type` 为可确证的请求头；响应 delta 形状与服务端一致 | 3 处请求契约不符 + 4 层错误码体系已对齐 | 契约比对门禁（见 9.3） | 第 3 节 |
| 数据 / schema 链路 | 签名 38,702 类 / 3,613 枚举；FBS schema 61 表；excel 63 表 | 三口径门禁**全绿** | 0 slot 位移；残余 11 冻结类 | 保持门禁，修补静默失败点 | 第 4 节 |
| 战斗 | `Torappu.Battle*` 2,589 文件 | quest 结算链完整（1,591 行单测）；危机合约结算丢弃战报 | P0×3 / P1×2 | **P0：危机合约失败也能得分** | 第 5 节 |
| 基建 | `Torappu.Building*` | 65 路由全部落真实逻辑（无纯空响应桩） | P0×2 + 16 条 POST 绕过 `validateBody` | P0：专精/宿舍 schema 与 CS 不符 → 422 | 第 6.1 节 |
| 肉鸽 rlv2 | `Torappu.UI.Roguelike*` 1,387 | 69 路由，仅 `/rlv2/finishGame` 未注册；rogue_6 深做、其余主题骨架 | P0×6 量级 | P0：`TOTEMBUFF≠TOTEM` 触发 TypeError | 第 6.2 节 |
| 生息演算 / 沙盒 | `SandboxV2` 703 + `SandboxV3` 539 文件 | **未实现**：80 handler 中 53 裸 202 + 21 空 delta + 6 硬编码，`player.update(` **0 次** ✅复核 | P0 结构性 | P0：零持久化 | 第 6.3 节 |
| 活动族 | 87 目录 / 2,602 `.cs` / ≈63 族 | `activities/` 24 族 + 兄弟模块 8 族 | 整族缺失 6+ 族 | P1：act35side/38side/42side/45side/46side/arcade/teamQuest 端点全为空 delta | 第 7.1 节 |
| 抽卡 | `Gacha*` 协议 + `gacha_table.json` 446 池 | 策略表分发（未知类型显式报错） | P0×2 | **P0：4 个池 `gachaRuleType` 为数字 → 抽卡 500** ✅复核 | 第 7.2 节 |
| 任务 / 签到 / 勋章 | `MissionTable` 46 模板 / `ActivityTable.missionData` 93 模板 | 任务链与勋章已实现 | P1×4 | P1：49/93 活动任务模板未注册 → 进度永不推进 | 第 7.3 节 |
| 路由覆盖度 | 客户端 696 条路由 | 服务端 1,209 条可见路径 | 缺失 14 条 | 覆盖率 **96.41%**（严格）/ 97.99%（含大小写） | 第 8 节 |

### 9.2 全局 P0 清单（按建议修复顺序）

| # | 域 | 问题 | 影响 | 证据 | 复核状态 |
|---|---|---|---|---|---|
| 1 | 抽卡 | `gacha_table.json` 中 `CLASSIC_ATTAIN_45/57/68_0_2` 的 `gachaRuleType=7`、`RETURN_71_0_1=11`（数字而非枚举名）；`logic.ts:_ruleTypeOf` 用 `String(raw)` 归一 → `funcs["7"]` 未注册 → `throw new InternalError` → **HTTP 500** | 这 4 个池一旦被选中，抽卡直接失败；`RETURN_71_0_1` 的 `endTime` 到 2030 年，长期可达 | 数据：`data/excel/gacha_table.json`（实测 4 条数字型）；代码：`app/game/modules/gacha/logic.ts:86-95,645-651`；`InternalError` → 500：`app/game/kernel/http/errors.ts:48-54` | ✅复核（数据 + 代码 + 状态码三段均已亲验） |
| 2 | 战斗 | 危机合约 V1/V2 的 `battleFinish` 完全丢弃客户端战报 → **失败也能得分** | 玩法正确性被破坏 | 第 5 节 P0-2（附客户端↔服务端行号） | 未复核 |
| 3 | 战斗 | 结算完全信任客户端 `completeState`，`isCheat` 既不校验也不落库 | 可被客户端伪造结算 | 第 5 节 P0-3 | 未复核 |
| 4 | 沙盒 | 生息演算**零持久化**：全部 handler 无 `player.update(`，V3 `createGame` 写死 `idx:21/day:1/weather:"weather_rain"/save:null` | 该玩法不可玩（进度不落库） | `app/game/modules/sandbox/routes.ts`（`player.update(` 计数 = 0）✅复核 | ✅复核（计数已亲验） |
| 5 | 基建 | `UpgradeSpecializationRequest` CS 类无 `targetSkill`（只有 `charInstId/skillIndex/targetLevel`），服务端 schema 强制必填 → **422**；`BuildingSaveDormLockRequest` 只有 `lockPos`，服务端要求 `roomSlotId+locked` | 专精升级与宿舍锁定在客户端不可用 | 第 6.1 节（含抓包 3+3 条 422 佐证） | 未复核 |
| 6 | 肉鸽 | 模块键 `TOTEMBUFF ≠ TOTEM` 被静默跳过 + `logic.ts:460` 缺 `?.` → `/rlv2/useTotem` 抛 TypeError | 肉鸽图腾功能崩溃 | 第 6.2 节 | 未复核 |
| 7 | 肉鸽 | `applyModuleDelta`（`module.ts:242-262`）写临时 `toJSON()` 对象 → `choice` 的 `m_get/m_lose` 增量全丢 | 肉鸽选项收益不入账 | 第 6.2 节 | 未复核 |
| 8 | 战斗 | `battleStart` 请求契约字段名疑似整体错配（`pray/continuous` vs `pry/multiple`）**【推测，高置信】** | 开战请求可能被服务端误解析 | 第 5 节 P0-1（真机抓包未做） | 未复核（标推测） |
| 9 | 抽卡 | 233 个 `NORM_*` 标准池被标成 `LIMITED`（`FESCLASSIC_*` 14 池标 `SPECIAL`）→ 保底按池隔离、标准池可领 300 抽赠送、误发 `LMTGS_COIN` | 抽卡概率与发放口径错误，且连带商店（高级凭证区/中坚甄选券恒空） | 第 7.2 节；根因推测为 excel 枚举转换缺陷（`git 7076f0c` "CS 枚举污染"），需官方源表复核 | 未复核（数据侧成立，根因待定） |

### 9.3 服务端「契约层」的共性缺陷（比单点 bug 更值得先修）

1. **Request schema 与反编译 CS 类脱钩**：基建两条 P0、战斗 P0-1 都是同一个病根——`validateBody(zod)` 的字段是手写的，与 CS 类字段不一致时**表现为 422 或静默丢字段**，而没有任何工具在守护这层一致性。建议新增一个门禁：以 `reference/` 的 `*Request.cs` 为真值，校验每个 `validateBody` schema 的字段名集合（可比照 `schema-first-guard.test.ts` 的做法落地）。
2. **端点路径不能由 Request 类名推导**（实证：`BuildingGetFurnitureGoodListRequest` 实际走 `/shop/getFurniGoodList`）——任何「类名 ↔ 路径」的自动映射工具都会造假阳性。
3. **stub 与实现的判别标准**：`res.status(202).send(player.delta)` 是**正常**的（HTTP 约定），而 `res.sendStatus(202)`（无 delta、无 `player.update`）才是桩。沙盒 53 条正是后者，基建 0 条。
4. **`validateBody` 覆盖有洞**：基建 65 条路由中 **16 条 POST 绕过** `validateBody`（清单见第 6.1 节），且架构守卫的正则把 `handler.ts` 排除在外——守卫盲区。
5. **协议层已确认 3 处请求契约与 CS 类不符**（第 3 节，均为「服务端多字段或字段名不一致」）：

| 端点 | CS 类（2.7.71） | 服务端 | 后果 |
|---|---|---|---|
| `/building/buyLabor` | `{costAp:int, ts:long}` | `schemas.ts:388-392` 必填 `buyCount` | 客户端正常请求被 422，或字段语义被误解 |
| `/gacha/cancelNormalGacha` | 只有 `slotId` | 注释/zod 多出 `tagList` | 契约注释与真值脱节 |
| `/user/changeAvatar` | `{type:PlayerAvatarType, id}` | 只收 `{avatar: z.json()}` | 请求结构被整体简化，可能丢 `type/id` 语义 |

   另：308 条服务端「CS: `XxxRequest`」契约注释中，**15 条的类名在 2.7.71 树中已找不到**（第 3 节）——注释已开始腐烂，建议纳入自动比对门禁。

### 9.4 文档纠偏清单（本次分析发现的既有文档/知识过期项）

| 位置 | 文档说法 | 实测（2.7.71 基线） | 来源 |
|---|---|---|---|
| `AGENTS.md` | `types-playerdata.ts` 有「796 interfaces, 1065 enums」 | 实测产物为 **815 interfaces / 128 type alias**（其中 115 个枚举联合）；数字已与产物脱节 | 第 4 节 |
| `docs/接口覆盖分析-未实现与stub清单.md` | 6 条 `/rlv2/*` 完全未实现 | 5 条已实现（`roguelike/handler.ts:527/561/569/549/541`），**仅 `/rlv2/finishGame` 仍缺** | 第 8 节 |
| `docs/接口覆盖分析-未实现与stub清单.md` | 官方接口 544 条 | 2.7.71 为 **696 条**（去重；旧口径漏掉 139 条无前导斜杠的常量） | 第 8 节 |
| `docs/rlv2-blackstream-官方文本对照.md` | `MONTH_TEAM → NORMAL` | 已过期：`game-init.ts:137` 现保留 | 第 6.2 节 |
| `docs/prts-wiki-实现评估-2026-09-09.md` | 沙盒「73 路由 / 51 个 202」 | 现为 **74 顶层路由 / 53 个 202**（另 21 空 delta + 6 硬编码） | 第 6.3 节 |
| `docs/module-audit-2026-08-29.md:21/52` | 「AP 在 finish 才扣」「finish 响应缺 itemReturn/overrideRewards/diamondMaterialRewards」 | 前者已修复（`battle.ts:433-441`：start 预扣）；后者对 `quest/battleFinish` 仍成立，需限定范围 | 第 5 节 |
| `AGENTS.md` 已知约束 | 「Non-practice battle HTTP chain is incomplete (battleStart lacks battleId)」 | quest 结算链已完整（1,591 行单测）；建议改为「结算链已完整，开战契约字段名待真机核对」 | 第 5 节 |
| 服务端 gacha 代码 | 把 `gachaObjGroups` 当作 CS 必需字段补 | CS 签名中该字段**计数为 0**，真实字段是 `gachaObjList`（`GachaDetailData.cs:302`）；`GachaObjGroup` 类不存在 | 第 7.2 节 |

### 9.5 置信度与证据等级

- **A 级（命令实测/编码结构）**：反编译规模与失败率、三口径 schema 门禁结论、路由覆盖度、excel/schema 表数——均可复跑（见第 10 节）。
- **B 级（代码双端对照）**：第 5~7 节的绝大多数差异条目，均附「客户端文件:行 ↔ 服务端文件:行」。
- **C 级（推测，已标注）**：战斗 `battleStart` 字段名错配（P0-8）、抽卡枚举污染根因、`FlatLookupConverter` 失败对运行时的具体影响面——需真机抓包或官方源表复核。
- **本报告未做的事**：未做真机抓包验证、未做端到端可玩性回归、未对客户端 UI 层做逻辑移植评估（UI 占 49.5%，属表现层，不建议移植）。

---

## 10. 附录：方法论、可复跑命令与残留未验证项

### 10.1 本次分析的方法论

1. **只读**：全程未修改 `reference/` 与 `app/`；一次性脚本、中间产物、分节稿统一落在 `tmp/decompiled-analysis/`（`tmp/` 已 gitignore）。
2. **定向检索优先**：`reference/` 在 WSL 的 9p/drvfs 上单文件读取 ~36 ms，全树 `grep -r` 需十几分钟、全仓 `glob **/*` 会 30 s 超时。因此按「命名空间目录 → 文件 → 行」三层收敛，长扫描一律放后台（如 `tmp/decompiled-analysis/count-artifacts.sh`）。
3. **证据等级**：每条结论标注「已验证」（实际读过代码/跑过命令）或「推测/静态近似」；数字必须来自实际执行输出。
4. **交叉验证**：涉及 schema 与协议的结论必须与既有口径对照（`schema:check` ⟂ `schema:crosscheck` ⟂ `schema:audit`，详见第 4 节）；涉及服务端实现完整度的结论必须给出「客户端证据 ↔ 服务端证据」双端文件:行。

### 10.2 可复跑命令

```bash
# —— 反编译产物本身 ——
pnpm run decompile                 # Cpp2IL → ilspycmd → 签名文件 → 末尾自动 schema:check
#              留存量：tmp/decompile/cpp2il_run.log（UTF-16LE）、ilspy_project.log、signature_gen.log
#              查看 Cpp2IL 成功率（需先转码）：
iconv -f UTF-16LE -t UTF-8 tmp/decompile/cpp2il_run.log | grep 'success rate'

# —— 产物可信度量化（本报告 1.3 节数据） ——
bash tmp/decompiled-analysis/count-artifacts.sh
#   → tmp/decompiled-analysis/decompile-artifacts.txt

# —— 命名空间规模（本报告 1.2 节表格） ——
for d in reference/arknights-2.7.71-csharp/Assembly-CSharp/*/; do
  printf '%6d %s\n' "$(find "$d" -name '*.cs' | wc -l)" "$(basename "$d")"
done | sort -rn

# —— 三条 schema 口径 ——
pnpm run schema:check              # 对 CS 签名（漂移即非 0 退出）
pnpm run schema:crosscheck         # 对 reference/OpenArknightsFBS-main
pnpm run schema:audit              # 对报文 vtable 真值（不依赖外部参考）

# —— 路由相关 ——
pnpm run routes:diff               # OBS(OpenBachelorS) ⇄ 本仓
#   客户端(2.7.71) ⇄ 本仓的覆盖度重算见第 8 节，脚本与清单落在 tmp/decompiled-analysis/
```

### 10.3 残留未验证项（诚实清单）

| # | 项 | 为什么没验证 | 影响 |
|---|---|---|---|
| 1 | 战斗 `battleStart` 契约字段名错配（`pry/multiple/extra` vs 服务端 `pray/continuous`） | 需真机抓包；本地抓包库无官方样本 | 第 9.2 节 P0-8 标为「推测，高置信」 |
| 2 | 抽卡 233 个 `NORM_*` 池被标 `LIMITED` 的**根因** | 需官方源表复核（本轮 web 检索不可用） | 数据现象已确认，归因（枚举转换缺陷）待定 |
| 3 | RL0x「CS 声明序 ≠ 线上序」的直接证据 | 需对本地报文重新解码；仅有「本地无少字段」的间接支持 | 冻结类结论未被推翻，但直接证据缺失 |
| 4 | `schema:audit` 的不一致表数：文档记 68 张，本次 67 张 | 1 张表的差异未定位 | 不影响 slot 结论（两类均为尾部残留） |
| 5 | 其余 11 个程序集的总行数；`du -sb` 精确字节数 | 逐文件 stat 超过 60 s 超时（221 MB / 22,017 文件） | 第 2 节规模表用 `du -sh` 块计数 |
| 6 | 全仓闭包/迭代器噪音比例 | 全树递归 grep 在本机不可行（>10 min） | 只做了 `Torappu.Battle`、`Torappu.UI` 抽样 |
| 7 | 服务端 `app/` 行号的长期有效性 | 分析期间工作区被**并发编辑**（62 个文件未提交） | 引用行号前请核对当前文件 |
| 8 | 运行时行为验证（可玩性回归） | 本次为纯静态分析，未起服、未跑端到端 | 第 9 节 P0 中标注「未复核」的条目需实测确认 |
| 9 | 命令环境差异 | 子代理沙箱 `/root` 只读，`pnpm run` 不可用，改用 `./node_modules/.bin/tsx <script>` 等价执行；Node 为 v22（仓库要求 24） | 命令结论有效，但「`pnpm run` 原样可用」未经本次验证 |

### 10.4 复核建议（给后续接手者）

1. 先跑第 10.2 节的三条 schema 门禁与路由覆盖度重算，确认本报告结论未随客户端/服务端版本漂移。
2. 按第 9.2 节全局 P0 顺序复核：抽卡（数据事故，成本最低）→ 危机合约结算 → 沙盒持久化 → 基建 schema → 肉鸽模块键。
3. 新增「CS 契约 ↔ zod schema」门禁（第 9.3 节建议 1）后，可把「契约错配」这一类问题从人工排查转为自动拦截。

---


