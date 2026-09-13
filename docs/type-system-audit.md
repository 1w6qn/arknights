# 类型系统审计与收敛策略

> 生成物守卫：`tests/unit/architecture/type-debt-ratchet.test.ts`（棘轮，只减不增）
> 度量 CLI：`pnpm run type:debt` / `pnpm run type:debt -- --write` / `pnpm run type:debt -- --write-escapes`
> 扫描器：`scripts/lib/type-debt-scan.ts`（守卫与 CLI 共用，口径一致）
> **扫描范围（2026-09-11 起）**：`app/` + `scripts/` + `tests/` + `hook/` + 根 `index.ts`
> （`SCAN_DIRS`）；范围扩容用 `--write --expand-scope`（只放行新文件，既有文件仍禁止上升）。
> **两条独立棘轮**：模糊类型计数（`type-debt-baseline.json`）与逃逸点计数
> （`type-escape-baseline.json`，只数 `as unknown as`）。

## 1. 审计结论（证据）

审计范围 `app/**/*.ts` + `index.ts`（403 文件 / 13.8 万行），以「裸类型关键字」为口径
（剥离注释、字符串、模板与正则字面量后统计；排除成员访问，故 `z.object({...})` 不计）：

| 阶段 | any | unknown | object | 合计 |
| --- | --- | --- | --- | --- |
| 初始基线（228 文件） | 1520 | 469 | 236 | 2225 |
| 修复后（226 文件） | 1518 | 469 | **73** | **2060** |

**核心结论：`object` 债有 69% 来自两个生成文件，根因在生成器而非业务代码。**

### 1.1 全范围现状（2026-09-11 扫描范围扩容后的**历史快照**，当前值见 §1.2）

| 范围 | any | unknown | object | 是否在 tsc 覆盖内 |
| --- | --- | --- | --- | --- |
| `app/**` + `index.ts` | 1516 | 468 | 72 | ✅ `tsconfig.json` |
| `tests/**` | 5511 | 62 | 15 | ❌（纳入后暴露 1260 个既有错误） |
| `scripts/**` | 104 | 34 | 14 | ❌（纳入后暴露 19 个既有错误） |
| `hook/` | 0 | 1 | 0 | ❌（`hook/main.ts` 由 frida-compile 构建） |
| **合计** | **7131** | **565** | **101** | — |

`any` 的形态分布（app）：`: any` 648、`as any` 683、`any[]` 80、`Record<string, any>` 66、
`z.any()` 122（20 文件）、`Promise<any>` 13。测试侧 `any` 主要来自无类型的测试桩
（`mockPlayerData` 的 `gainItem/delta/_trigger/excel`）导致的调用点 `as any`。

**收敛路线（2026-09-11 批准）**：`any` 一律清零（app → scripts → tests 分阶段），
每条 `any` 的归宿只有四种——① 精确手写类型；② 生成器覆盖表登记 + 重生成；③ I/O 边界
改 `unknown` + 就地收窄；④ 路由契约用 `z.json()`/精确 schema。

### 1.2 终局结果（2026-09-12 全仓 `any` = 0；2026-09-13 复核更新 unknown/object）

| 范围 | any 起始 → 终局 | unknown | object | tsc 配置 |
| --- | --- | --- | --- | --- |
| `app/**` + `index.ts` | 1516 → **0** | 327 | **6** | ✅ `tsconfig.json`（0 错误） |
| `tests/**` | 5511 → **0** | 15 | 0 | ✅ `tsconfig.tests.json`（0 错误） |
| `scripts/**` | 104 → **0** | 7 | 0 | ✅ `tsconfig.scripts.json`（0 错误） |
| `hook/` | 0 → **0** | 1 | 0 | ❌（`hook/main.ts` 由 frida-compile 构建） |
| **合计** | **7131 → 0** | **350** | **6** | — |

`any` 已由守卫固化：`tests/unit/architecture/type-debt-ratchet.test.ts` 的
「全仓 `any === 0`」用例（`totalOf(scanTypeDebt(REPO_ROOT)).any === 0`）在任何位置
重新引入 `any` 时红灯。`unknown`/`object` 尚未清零，仍走逐文件棘轮（只减不增 +
新文件必须零模糊类型）。

**2026-09-13 复核**：全仓 `as unknown as` 从 56 处降到 **9 处**，并由独立的
**逃逸点棘轮**固化（见 §2.4）——此前它只以「`unknown` 关键字 +1」的形式混在模糊类型
计数里，既无法与边界上的正确 `unknown` 区分，也可以被同文件别处的 `unknown` 下降「交换」掉。

**扫描器口径修正（假阳性）**：`scripts/lib/type-debt-scan.ts` 的裸关键字正则
`(?<![\w$.])kw\b(?!\s*:)` 中，`(?!\s*:)` 排除**属性名**位置（`{ any: 0 }`、
`interface X { object: string }` 不是类型债；负样本见守卫的
「负样本自证：注释、字符串、正则中的关键字不计为类型债」用例）。此前扫描器自身的
`const any = …` 与简写属性 `return { any, unknown, object }` 会被自计（属假阳性），
现已把局部变量改名 `cntAny`/`cntUnknown`/`cntObject`、返回语句写显式属性名，
**公开键名 `TypeDebtCounts.any/unknown/object` 保持不变**（基线与消费点依赖）。
遗留边界：简写属性 `{ any }` 仍会被计入（无 `:` 可判），故扫描器自身及新代码避免
用这三个词做局部标识符。

`object` 存量（6 处，2026-09-13 实测两处是**合法惯用法**，不应再"修"）：

| 文件 | 处数 | 形态 | 处置 |
| --- | --- | --- | --- |
| `app/core/utils/object.ts` | 3 | `T extends object` 泛型约束 | **豁免**：改成 `Record<string, unknown>` 会拒绝一切无索引签名的 interface（语义倒退） |
| `app/game/modules/roguelike/response.ts` | 1 | `T extends object` 泛型约束 | 同上 |
| `app/game/kernel/events/rlv2.ts` | 1 | `[string, object]` 事件载荷 | 待办：载荷是 30+ 个调用点各自具名的具名接口，改 `JsonValue` 会全线不可赋值；需先给事件载荷建模 |
| `app/game/modules/roguelike/events.ts` | 1 | `[string, object]` 事件载荷 | 同上 |


**`as any` / `as unknown as` 政策（2026-09-13 更正）**：`as any` 与 `any` 关键字同源，
已随「全仓 `any === 0`」门禁彻底清零；`as unknown as` **此前并无守卫**，本文件曾写
「一律不再允许直接出现在调用点，仅存两处集中在 `tests/helpers`」——与当时实测的
**56 处 / 27 文件**（app 48 / scripts 5 / tests 3）不符。现已改为**逃逸点棘轮**（§2.4）：
56 → 30 处，剩余逐文件记录在 `tests/unit/architecture/type-escape-baseline.json`。

「替身 → 契约」硬边界仍集中在 `tests/helpers`，且用的是 `@ts-expect-error`（不是
`as unknown as`）：`asPlayerManager`（`PlayerDataManager` 含私有实现，鸭子替身不可结构兼容）与
`asExcelPort`（`ExcelData` 是 32 个成员全必填的 `Pick<Excel, …>`，窄端口与完整契约**双向**
都不可结构兼容）；两者均带 JSDoc 说明断言方向与运行期同一对象引用，禁止用它掩盖
字段名/字段类型不匹配（后者必须就地修夹具）。
`asChildModules`（子模块注入视图）方向合法，**无需** suppression。

| 文件 | 初始 object |
| --- | --- |
| `app/game/excel/types_excel_gen.ts` | 86 |
| `app/game/excel/types-playerdata.ts` | 77 |
| 其余 226 个文件合计 | 73 |

`any` 债则相反：高度集中在少数业务文件（medal 事件分发、roguelike、admin 运维层），
属「就地逃生」而非生成器问题，需要逐个按领域建模。

## 2. 策略：三类表述的处置

### 2.1 `any` —— 一律禁止

`any` 关闭类型检查且会沿赋值链**传染**，是唯一没有任何合理用途的表述。
唯一历史豁免是生成的 `[key: string]: any` 索引签名（已改为 `JsonValue`）。

### 2.2 `object` —— 禁止**值位置**，泛型约束位置豁免

TS 的 `object` 关键字在**值位置**上既不可索引也不可取属性，调用方唯一出路是 `as any`——
它不表达「未知」而表达「不可用」，是把类型洞藏在字段声明里的形式。本仓库
`object` 的真实语义有两类，分别替换：

1. **形状可知** → 直接写精确类型（首选）。如 `PlayerAvatar.avatar_icon` 改为
   `{ [key: string]: { ts: number; src: string } }`。
2. **确实未建模的服务端 payload** → 用严格 JSON 域类型替代（见 §3）。

**豁免**：`<T extends object>` 这类**泛型约束**位置保留——它约束的是"必须是非原始值"，
改成 `Record<string, unknown>` 会拒绝一切没有索引签名的 interface（`interface` 不获得
隐式索引签名），是语义倒退（2026-09-13 复核：`utils/object.ts` ×3、`roguelike/response.ts` ×1）。

**方法**：值位置的 `object` 优先换**精确类型 / `JsonValue`**，而不是换 `unknown`——
逐文件棘轮是**按键位**比较的，`object → unknown` 会让该文件 `unknown` 上升而被判违规
（`--write` 会直接拒绝），而 `object → JsonValue` 同时压低两项、天然通过。

### 2.3 `unknown` —— 不禁止，但必须「就地收窄」

`unknown` 在**不可信输入的边界**上是唯一正确的类型（`catch (e: unknown)`、
未校验的外部 JSON），把它换成 `any` 是**倒退**。构造性要求：

- 允许：I/O 边界、`catch`、三方库回调。
- 要求：`unknown` 必须在同一个小函数内被收窄（`typeof` / zod `safeParse` / 类型守卫）
  后才可外流；**不允许**把 `unknown` 存进领域模型或跨模块传递。
- 已有约定：POST 路由必须经 `validateBody(zodSchema)`
  （守卫 `tests/unit/architecture/schema-first-guard.test.ts`）——这就是「边界收窄」的范式。

> 棘轮把 `unknown` 一并计数，是为了**驱动逐处复核**，而不是把 379 处清零。
> 复核结论若为「边界上的正确用法」，应在 `SERVER_*_ADAPT` 或代码注释中说明，
> 而不是把它改成 `any`。
> 已知的「正确但计入」密集点：`user/freshPlayer.ts` 45 处（模板克隆 + 键级改写的
> `Record<string, unknown>` 结构脚手架）、`utils/logger.ts` 17 处（变参日志
> `unknown[]`）、`activities/shared/activity.ts` 19 处（活动数据边界）、
> `arkhub/gateway/protocol.ts` 14 处（网关线协议）。

### 2.4 逃生通道的独立棘轮（`as unknown as` / `@ts-*`）

模糊类型计数（`any`/`unknown`/`object`）漏掉两条逃生通道，故各自单列指标 + 逐文件棘轮：

**（a）`as unknown as X`** —— 「先抹掉类型再断言」，让**两侧**类型都失去约束；它与边界上的
正确 `unknown` 共享同一个关键字计数，因此无法用关键字口径区分：

- 度量：`countEscapeCasts`（`scripts/lib/type-debt-scan.ts`，剥离注释/字符串/正则后匹配）
- 基线：`type-escape-baseline.json`；刷新 `pnpm run type:debt -- --write-escapes`
- 当前 9 处的构成见 §2.4.1

**（b）`@ts-expect-error` / `@ts-ignore` / `@ts-nocheck`** —— 把编译错误「合法化」，且
**完全不进任何关键字指标**（此前的最大盲区）：

- 度量：`countTsSuppressions`——只认**注释行开头**的指令（`^[ \t]*//[ \t]*@ts-…`）；
  JSDoc 里的「提及」（`* 实现体一次 @ts-expect-error`）与字符串里的同名字样不计
  （守卫有负样本自证用例）。
- 基线：`type-suppression-baseline.json`；刷新 `pnpm run type:debt -- --write-suppressions`
- 当前 5 处（全仓唯三文件，均带 JSDoc 理由）：`events/runtime.ts` 3（Emittery 泛型签名收窄）、
  `tests/helpers/mockPlayerData.ts` 1（含私有字段的类替身）、
  `tests/helpers/diAdapters.ts` 1（窄端口 ↔ 32 成员全必填的 `ExcelData`）。

**三项指标在同一次读盘内算完**（本仓 WSL 9p 每次 `readFileSync` 约 36ms，多一遍全仓扫描
要多花 15~20s）。两条逃生通道的棘轮规则一致：**不得新增文件、既有文件不得上升、
已清零必须移除、基线与明细自洽**。

#### 2.4.1 剩余 9 处逃逸点台账（2026-09-13）

| 位置 | 处数 | 根因 / 下一步 |
| --- | --- | --- |
| `roguelike/logic.ts`（`outer`/`current`/`update`）+ `roguelike/troop.ts`（`getChar`） | 4 | 跨「硬编码 rlv2 契约模型 `rlv2-model.ts` ↔ 线格式生成模型」的真实冲突，共三层：① 枚举线格式（已解决 `pending.type` / `EndingBrief.mode`）；② **结构差异**：`pending.content.battle.tmpChar` 的生成类型 `PlayerRoguelikeV2_CurrentData_Char` 比契约模型的 `Char` 少 6 个字段（`skin`/`defaultSkillIndex`/`skills`/`voiceLan` …，即 #32 的 `Char`/`RecruitChar.instId` 缺口），而本仓写的是「服务端增强版 Char」；③ `getChar` 的 `instId` number→string 表示变更。②③ 需先确认「客户端是否接受增强字段」再动 |
| `AccountManager.ts` | 1 | 全新存档构造器（`freshPlayer.ts`）产出的是键级改写脚手架，转 `PlayerDataModel` 的断言 |
| `battle.ts` | 1 | 悖论模拟关卡（`mem_`）不在 StageTable，回退构造最小 stage 片段 → `ExcelStage` |
| `excel.ts#makeItem` | 1 | `{ id, count }`（无 type）→ `ItemBundle`：type 缺省由库存层推导。已收敛为**全仓唯一**的该形态断言点（调用点已全部改走 `makeItem` 或 `ItemBundleInput`） |
| `official-ops.ts` / `apk-lua.ts` | 2 | 平台类型不重叠（DOM `BodyInit`、Node `ReadableStream`）——**合法边界，保留** |


## 3. 根因修复：生成器不再产出 `object`

### 3.1 哨兵归一化

`scripts/playerdata-parser.ts#CSHARP_TO_TS_TYPE_MAP` 与两张 override 表
（`SERVER_ADD_FIELDS` / `EXCEL_FIELD_TYPES` 等）里的 `"object"` 是**哨兵**，
表示「C# 类型无对应具名结构」。生成器现在在输出阶段统一归一化
（`scripts/types-builder.ts#normalizeJsonType`），按域分流：

| 域 | 归一化目标 | 位置 | 理由 |
| --- | --- | --- | --- |
| excel 表数据（只读） | `JsonValue`（递归联合） | `app/game/excel/json-value.ts` | 表数据层次深，递归联合可精确表达 |
| 玩家存档 | `ServerPayload`（**非递归**，两层） | 同上 | `Draft<PlayerDataModel>` 无法承受递归类型 |

### 3.2 为什么玩家存档必须用非递归类型

mutative 的 `Draft<T>` 会**递归映射** T 的每个属性。把递归类型放进
`PlayerDataModel` 会让 `Draft` 无限展开，触发
`TS2589: Type instantiation is excessively deep and possibly infinite`——
实测 4 处（inventory / unlockActivity / construction / misc）当场合不上。

`ServerPayload` 显式展开两层（标量 / 标量数组 / 一层嵌套对象），仍是严格类型，
但保证 `Draft` 可终结。**新增玩家存档字段时不要用 `JsonValue`。**

### 3.3 服务端活动字典的精确化配方（2026-09-11 验证）

`PlayerActivity` 是服务端独有的形状：`{ [类型key]: { [actId]: 活动数据 } }`
（客户端模型是 60 个分列表字段），此前整接口覆盖为 `{ [typeKey: string]: { [actId: string]: object } }`
→ 归一成两层 `ServerPayload`，**任何第三层访问都要 `as any`**（全仓 `draft.activity as any` 51 处、
`_playerdata.activity as any` 6 处的主要根因）。

配方（登记在 `scripts/playerdata-server-adapt.ts` 的 `SERVER_OVERRIDE_FIELDS.PlayerActivity["[server]"]`）：

1. **只给服务端真正读写的类型键**写具名成员，其余键继续走兜底索引签名；
2. 具名成员**一律可选（`?:`）**——索引签名语义下键不保证存在（存档惰性建键），
   写必填会让 `draft.activity = {}` 这类赋值直接报错，访问侧也必须用 `?.`；
3. 兜底索引签名必须用**交叉类型**挂载：具名成员与索引签名写在同一个对象字面量里会
   触发 **TS2411**（具名值类型不可赋给索引签名值类型）；交叉写法绕开该检查，
   且**不会**让 `Draft` 深度爆炸（已实测：交叉写法 + `--playerdata` 重生成后
   `tsc -p tsconfig.json` 全绿）；
4. 成员内部**保持非递归**（禁止 `JsonValue`，兜底类型用 `ServerPayload`）；
5. 重生成：`pnpm run generate:playerdata`（本仓等价 `tsx scripts/generate-types.ts --playerdata`），
   然后删掉访问点的 cast；生成文件不得手改。

已登记（首例，2026-09-11）：`BOSS_RUSH`（`milestone` / `relic` / `bestWaveDic`）。

### 3.4 顺带修出的真实缺陷

- **`StoryReviewTable` 声明为单行类型**（`app/game/excel/excel.ts`）：
  该表实际是 `{ [groupId]: StoryReviewGroupClientData }`（已用
  `data/excel/story_review_table.json` 核对），原先误标为单行对象，使
  `StoryReviewTable[groupId]` 落到索引签名上返回 `any`，`?.rewards` 完全失去检查。
  已改为字典类型。
- **`[key: string]: any` 索引签名**：`CharacterData` / `StoryReviewGroupClientData`
  在 interface 上挂索引签名与具名字段冲突（TS2411）。改为交叉类型
  `{ ...具名字段 } & { [key: string]: JsonValue }`，既保留精确字段又保留字典访问。
- **索引签名掩盖具名字段**：`StoryReviewGroupClientData.rewards` 曾被索引签名吞掉。

## 4. 剩余债务与后续专项轮

`any` 已归零（§1.2），本节的「Top 违规文件」清单随之作废。剩余工作分两类：

### 4.1 `unknown` / `object` 存量（继续棘轮）

按「权重 = unknown×1 + object×2」的现存量（2026-09-13 第五轮实测）：`app` unknown 327 / object 6、
`tests` unknown 15 / object 0、`scripts` unknown 7 / object 0、`hook` unknown 1。
集中在：`user/freshPlayer.ts` 45、`activities/shared/activity.ts` 19、`utils/logger.ts` 17、
`ops/capture/capture-manager.ts` 15、`activities/arkhub/gateway/protocol.ts` 14、
`crisis/crisis.ts` 14、`autochess/autochess.protocol.ts` 12 等——多为可信边界（zod/I-O）、
未建模 JSON 域或结构脚手架。**不设清零期限**：`unknown` 在不信任输入边界是正确类型，
只在「确实已收窄」时才下降；`object` 按 §2.2 两条替换（精确类型 / 严格 JSON 域），
泛型约束位置豁免。

### 4.2 两个专项轮（不混入 any 清零提交，单独立项）

- **轮 A：生成器登记回收**——把「生成类型未覆盖服务端真值 → 测试只能就地收窄/局部视图」
  的登记缺口一次性补进 `scripts/playerdata-server-adapt.ts` / `excel-server-adapt.ts` 后重生成。
  清单见 `tmp/probe/PROGRESS.md` 台账 **#28**（PlayerGacha.classic、CampaignsV2State.missions、
  MissionPlayerDataGroup.confirmed、BattleStats.packedRuneDataList/idList、pinned、ItemBundle.type）
  与 **#32**（BattleData、RoguelikeStageEarn、Game.mode、OuterData.Record、Blackboard_DataPair、
  PlayerRoguelikePendingEvent、cursor.position、Buff.capsule、Troop.expeditionReturn、Inventory.trap、
  RecruitChar.instId、eventChoices.incidents、PlayerSkinShopData）。
  （2026-09-13 已开刀：`PlayerGacha.newbee`、`Properties.hpShowState` 两项已落地，见 §4.4；其余按本清单继续。）
- **轮 B：helpers 替身补全 + R1 配方复核**——补齐 `MockBattleManager.finish`（改可选）/
  `getActiveBattle`、`MockPlayerDataManager.modules/bossRush`；按 R1 配方（`SERVER_OVERRIDE_FIELDS.PlayerActivity`）
  具名登记三层活动子树（halfidle / act44 / act24 / bossrush）与 `PlayerCrisisSeason`，消除种子
  `Object.assign` 绕行与两层 `ServerPayload` 的类型不可达。

两轮的已知真实缺陷台账同见 `tmp/probe/PROGRESS.md`（#6~#32），修缺陷需「补测试 + 说明行为差异」。

### 4.3 第一轮（2026-09-13 上午）：断言清理

一轮专项复核把 `as unknown as` 从 56 处降到 27 处（-29），`object` 从 26 处降到 6 处（-20），
`unknown` 从 413 降到 376；`any` 保持 0，三份 tsc 配置 0 错误，架构守卫全绿。改动分七类：

| 类别 | 处数 | 做法 |
| --- | --- | --- |
| Express `req.rawBody` 无类型声明 | -8 | 新增 `app/core/http/express-request.ts` 的 `declare global` 增强（`@types/express` 的 `Express.Request` 本就是开放接口），消费点直接 `req.rawBody` |
| 管道物品入参类型撒谎 | -4 | `GainItemPipeline.add()` 入参改为新类型 `ItemBundleInput`（`type?`：库存层按 `item_table` 推导后就地回填），4 处 `as unknown as ItemBundle` 消失；**响应报文里的 `ItemBundle.type` 仍必填**，未放宽生成类型 |
| `campaignsV2` 不在生成模型 | -6 | `accrue.ts#campaignsV2View(root)` 单点断言（断言目标写成 `入参 & { campaignsV2?: … }`，不需要 `unknown`）；`CampaignsV2State` 补 `missions` 字段，去掉两处内部断言 |
| 类型与运行期不符 | -6 | `BattleInfoStore.getBattleInfo` 契约改为 `Promise<BattleInfo \| undefined>`（原声明恒有值，逼出实现侧 `as` 与调用侧 `!`，且 `battleFinish` 无上下文时会解构 undefined 崩 500，现归一到"未知关卡"空结算）；`decryptBattleReplay` 返回 `JsonValue`；`readJson/readJsonSync` 默认类型参数 `object → JsonValue`；`writeJson`/`encryptBattleData` 入参改泛型；`traffic-recorder` 的 res 标记改精确 symbol 键视图 |
| 测试夹具缺陷就地修 | -2 | `mockExcel` 补齐 `MissionTable`/`StageTable` 缺字段（`crossAppShareMissionConst`、`storylineConst`、`sixStarCompatibleInfo`、`conditionalDropInfo`）后，两处 `as unknown as` 变普通 `as` 断言 |
| 其余 `object` 收紧 | -8 | `battle-model.BattleStats` 10 处 → `JsonValue`；`asset.ts#ModsList.mods` → `JsonValue[]` + `isJsonObject` 收窄；`AccountManager.UserConfig.rlv2` → `JsonValue`；`depot.extraDataDic` → `Record<string, ServerPayloadLeaf>`；`character/routes` 用 `typeof result === "object"` 真实收窄 |
| 顺带修掉 3 处「多余断言」 | -3 | `SocialService` 的两处 `GameDataConst as unknown as { maxStarFriendNum/requestSameFriendCd }`——两字段本就声明在生成类型里；`trade-orders` 的 `as unknown as Record<number, …>` 用注解即可（字符串索引签名兼容数字索引） |
| `JsonValue` 归位 core | 0 | 规范定义移到 `app/core/utils/json-value.ts`，`@excel/json-value` 改为 re-export——原先 core 的 `file.ts`/`crypt.ts` 直接 import `@excel/json-value` 违反架构守卫 R1（core 不得依赖 game）；生成类型的相对 import `./json-value` 与业务 import 路径均不变 |

未做（需单独立项）：`rlv2:event:create` 等事件载荷的 `object`（30+ 调用点各自具名接口，
要先给载荷建模）；`ItemBundle.type` 在**应答**位置（`char.evolveCost`、`depot` 选择发放、
`gacha` 成本列表、`campaignV2` 突破奖励）的缺省语义；生成类型未覆盖服务端真值的登记回收
（见 §4.2 轮 A/#28 与 #32，第二轮已开刀，见 §4.4）。

### 4.4 第二轮（2026-09-13）：生成器登记回收 + 断言降级

第二轮把 `as unknown as` 从 27 处降到 **16 处**（-11），`unknown` 从 376 降到 **364**，
`object` 维持 6 处；`any` 保持 0，三份 tsc 配置 0 错误。**登记回收路径已实测可用**：
`tsx scripts/generate-types.ts --playerdata` 在无登记改动时产出**逐字节相同**的文件
（幂等），因此登记 → 重生成可以按「最小 diff」审查。

| 类别 | 处数 | 做法 |
| --- | --- | --- |
| 登记：`PlayerGacha.newbee` 可选 | -2 | `SERVER_OPTIONAL_FIELDS` 新增 `PlayerGacha: ["newbee"]`（管理器惰性建键、旧存档整块缺失），生成 diff 仅 `newbee?`；`gacha/logic.ts` 的建键与读取改 `??=`，并去掉 `_newbeeQuota` 的冗余断言 |
| 登记：`Properties.hpShowState` | 0 | `SERVER_ADD_FIELDS` 新增（CS 有 `Properties.RewardHpShowStatus hpShowState`，官服报文不含、服务端 init 写 `"NORMAL"`；硬编码模型早已声明）；生成 diff 仅 +1 行 |
| gacha 回退详情去重 | -1 | 两处重复的「最小通用池」构造收敛为 `gacha-up-list.ts#buildFallbackGachaDetail`；断言目标写成 `构造物 & GachaDetailData`（交叉类型必然重叠），不再 `as unknown as` |
| 抓包库行类型断言集中 | -3 | `capture-db.ts#allRows<T>`（`as T[]`——TS 会做**重叠性检查**，与 `as unknown as` 不同）；`capture-manager` 三处 SQL 行断言全部消失 |
| 多余断言清理 | -2 | `sqlite.ts#bind`（`SqlBindValue[]` 本就兼容 `SQLInputValue[]`）；`RetroManager`（`initRetroCoin`/`retroCoinPerWeek`/`retroCoinMaxOfLevels` 三字段本就在 `RetroStageTable` 里） |
| 复用既有单点 | -1 | `battle.ts` 的 `CampaignsComplete` 载荷改用 `campaignsV2View` + `CampaignsV2State`（同时去掉其后的载荷断言） |
| 断言降级（`as unknown as` → `as`） | -1 | `roguelike/logic.ts#toJSON`；其余 4 处试降级**失败并已回退**——失败信息暴露出真实模型冲突（见下） |

**第二轮新发现（真实不一致，未改动行为，待定夺）**：

1. **`PlayerRoguelikePendingEvent.type`**：生成类型（线格式）为 `number`，硬编码模型
   `rlv2-model.ts` 为 `string`；而本仓运行时写入的是**字符串枚举名**（`events.ts#createEvent`
   的参数来自各 emit 点的 `"SCENE"`/`"BATTLE"`/`"RECRUIT"`）。`pending` 属于回包给客户端的
   存档子树——若客户端按 int 解析该字段，就是一处协议偏差，需要抓包/客户端验证后再定
   「改运行时写数字」还是「登记为字符串枚举（`SERVER_ENUM_KEEP_AS_STRING`）」。
2. **`PlayerRoguelikeV2_OuterData_Collection_DifficultyUnlockInfo.progress`**：登记表与生成类型
   为 `number`，硬编码模型为 `number[]`；同处 `collect.modeGrade` 的内层键生成类型为
   `number`、硬编码模型为 `string`。两者必有一错，需按实际存档核对。
3. 这正是 `roguelike/logic.ts` 的 `outer`/`current`/`update` 三处逃逸点**不能**简单降级的原因：
   它们跨越的是「硬编码 rlv2 模型 ↔ 线格式生成模型」的真实类型冲突，不是单纯的断言偷懒。

### 4.5 第三轮（2026-09-13）：`ItemBundle` 应答形态收口 + 一处真 bug

第三轮把 `as unknown as` 从 16 处降到 **10 处**（-6），`unknown` 从 364 降到 **356**，
`object` 维持 6 处；`any` 保持 0，三份 tsc 配置 0 错误，架构守卫与相关模块用例全绿。

| 类别 | 处数 | 做法 |
| --- | --- | --- |
| 管道入参类型统一 | -1（+1 普通断言） | `char.ts` 删掉本地 `PipelineUseTarget`（与管道入参 `ItemBundleInput` 完全同形），`_useItems` 直接收 `ItemBundleInput`，`pipe.add(item)` 不再断言；`evolveCost.concat([excel.makeItem(...)])` 的断言本属多余（类型早已兼容） |
| 消耗列表改服务端口径 | -1（+1 普通断言） | `gacha/logic.ts` 两处 `costs` 与 `_verifyCost` 入参改 `ItemBundleInput[]`——`type` 由物品表推导、`instId` 为管道扩展字段，`c.instId` 不再需要 `as ItemBundle & {…}` |
| 应答类型改为如实回显 | -1 | `depot` 的 `UseOptionalVoucherResponse.itemGet` 由 `ItemBundle[]` 改为 `OptionalChoiceItem[]`：服务端**原样回显**客户端提交的 `choices`（`{id, count}`，不补 type），旧声明与实际报文不符 |
| 突破奖励条目精确化 | -1 | `campaignV2` 的 `BreakLadder.rewards` 由内联 `{ id; count; type: string }[]` 改为 `ItemBundle[]`（数据形状本就一致），`claimCampaignBreakRewards` 的 `items` 随之成为 `ItemBundle[]`，路由侧断言消失 |
| 测试替身换真实总线 | -1 | `inventory-pipeline.test.ts` 手写 `{ emit }` 替身（Emittery 的 `emit` 是复杂泛型，只能 `as unknown as`）改为 `tests/helpers#mockTypedEventEmitter()` + `on` 订阅记录；顺带把记录类型从 `unknown[]` 收成 `[PipelineItem[]]` |
| **真 bug 修复** | -1 | `autochess.trainingBattleStart` 原先传 `squad: []`——`battle.start` 会 `squad.slots.forEach(...)`（battle.ts:388），运行期 `[].slots` 为 `undefined` → 该端点必 500；断言 `as unknown as CommonStartBattleRequest` 把它藏住了。现传 `{ squadId: "", name: "", slots: [] }`，训练战斗可正常开局（`stageStartConds` 用 `squad?.slots ?? []` 已防御，训练关卡无开局条件） |

**仍无法去除（已在 §2.4.1 逐条说明）**：roguelike 4（模型冲突待定夺）、autochess 1（需给结算响应声明返回类型）、
AccountManager 1（存档脚手架 → 模型）、battle 1（`mem_` 回退 stage）、`makeItem` 1（type 缺省的唯一构造点）、
平台边界 2（合法保留）。

### 4.6 第四轮（2026-09-13）：`battle.finish` 声明式契约 + rlv2 事件类型登记

第四轮把 `as unknown as` 从 10 处降到 **9 处**（-1），`unknown` 从 356 降到 **353**，
`object` 维持 6 处；`any` 保持 0，三份 tsc 配置 0 错误。

| 类别 | 处数 | 做法 |
| --- | --- | --- |
| `battle.finish` 声明返回类型 | -1（+清理 2 处普通断言 + 4 行死代码） | 新增 `BattleFinishResponse` 与 `emptyBattleFinishResponse()`：四个分支（重复结算被拒 / 未知关卡 / 演习 / 正规结算）统一骨架。autochess 的 `as unknown as Omit<AutoChessFinishBattleResponse,…>` 消失；`vecbreak` 的两处 `as Record<string, unknown>` 与展开前的 4 行死代码（展开会覆盖它们）一并清掉；vecbreak 测试夹具补成完整骨架 |
| 登记 rlv2 事件类型枚举 | 0（解开一层模型冲突） | `PlayerRoguelikePendingEvent.type` → `PlayerRoguelikePlayerEventType`。证据：参考实现 `reference/opendoctoratepy-ex-public/server/rlv2.py` 一律写 `"type": "SCENE"`/`"BATTLE"`/`"RECRUIT"`，本仓运行时（`events.ts#createEvent` 各 emit 点）同样写枚举名字符串；生成类型此前为 `number`，与契约模型 `string` 冲突 |
| 登记结束简报 mode | 0 | `PlayerRoguelikePendingEvent_EndingBrief.mode`：同一枚举 `RoguelikeTopicMode` 在 `PlayerRoguelikeV2_OuterData_Record_History.mode` 上已按名字符串登记，保持同族一致 |
| 未登记（写进登记表注释） | — | 同子树其余 6 个枚举字段（`ChoiceAddition.Reward/Cost.type`、`InitRecruitContent.ShowChar.type`、`InitTeam.Char.type`、`BattleContent.battleFailDisplay`、`SacrificeContent/ExpeditionContent.type`）：本仓**从不写非空值**（`showChar: []`、无 initTeam/… 构造函数），零报文风险，但「名字符串」缺客户端侧证据，故只记录不登记 |

**行为微调（一处，已记录）**：演习分支原先只回 `{ result: 0 }`，与另两个最小分支（重复结算/未知关卡）
返回的完整空壳不一致；现统一为完整空壳（只增不减字段）。

**结论：roguelike `current`/`update` 的断言无法降级**——枚举层解决后，第二层冲突是**结构性的**：
`pending.content.battle.tmpChar` 的生成类型 `PlayerRoguelikeV2_CurrentData_Char` 比契约模型的 `Char`
少 6 个字段（`skin`/`defaultSkillIndex`/`skills`/`voiceLan` …，即 #32 的 `Char`/`RecruitChar.instId` 缺口），
而本仓写入的是「服务端增强版 Char」。这属于「服务端真值 vs 生成模型」的登记缺口，
需先确认客户端是否接受增强字段，再决定登记还是裁剪契约模型。

### 4.7 第五轮（2026-09-13）：补上第三条逃生通道的守卫

第五轮不降指标，而是**堵住最后一个没有守卫的口子**：`@ts-expect-error` / `@ts-ignore` /
`@ts-nocheck` 把编译错误「合法化」，此前**完全不进任何指标**（`any`/`unknown`/`object`
都是关键字口径，看不到它）。

| 改动 | 说明 |
| --- | --- |
| 新指标 `countTsSuppressions` | 只认**注释行开头**的指令（`^[ \t]*//[ \t]*@ts-…`）：JSDoc 里的「提及」（如 `* 实现体一次 @ts-expect-error`）与字符串里的同名字样不计——守卫有负样本自证用例（4 个正样本 + 4 个负样本） |
| 新基线 `type-suppression-baseline.json` | 当前 **5 处 / 3 文件**，均带 JSDoc 理由：`events/runtime.ts` 3（Emittery 泛型签名收窄）、`mockPlayerData.ts` 1（含私有字段的类替身）、`diAdapters.ts` 1（窄端口 ↔ 32 成员全必填 `ExcelData`） |
| 新刷新通道 | `pnpm run type:debt -- --write-suppressions`（只紧不松；脚本里复用逃逸点的违规判定） |
| 守卫用例 | `type-debt-ratchet.test.ts` 新增 5 例（负样本自证 / 基线自洽 / 不得新增 / 不得上升 / 清零须移除），单测总数 12 → 17 |
| 单次读盘三项指标 | `scanTypeMetrics` 一次遍历同时算模糊类型 / 逃逸点 / suppression（WSL 上每次全仓读盘 15~20s，多加一遍就是白花） |
| 清理并发写入引入的新逃逸点 | `tests/unit/router/activity-enemyduel.test.ts` 用 `as unknown as` 把 `{ enemy_1: "1" }`（字符串）塞进 `Record<string, number>`——该用例的意图正是「喂非法数据给 zod 拒绝」，故改为把测试的 HTTP 请求体类型声明成 `EnemyDuelBody \| Record<string, JsonValue>`（HTTP 边界本就是原始 JSON），断言与夹具错误一起消失 |
| 范围扩容放行 | 同期新增的 `scripts/fbs-crosscheck.ts` 带 1 处**合法**边界 `unknown`（`main().catch((err: unknown) => …)`），按既有「新文件经 `--write --expand-scope` 放行」通道纳入基线（总量 353 → 350，既有文件均未上升） |

指标：`any` 0、`unknown` **350**、`object` **6**、逃逸点 **9**、suppression **5**，三条棘轮
delta 均为 0；三份 tsc 配置 0 错误。

## 5. 工作流

```bash
pnpm run type:debt                            # 报告总量 / delta / 逃逸点 / Top 违规文件
pnpm run type:debt -- --write                 # 刷新模糊类型基线（棘轮只紧不松，上升即拒绝并退出 1）
pnpm run type:debt -- --write --expand-scope  # 扫描范围扩容时刷新（只放行新增文件）
pnpm run type:debt -- --write-escapes         # 刷新逃逸点基线（as unknown as，只紧不松）
pnpm run type:debt -- --write-suppressions    # 刷新 suppression 基线（@ts-* 指令，只紧不松）
pnpm exec vitest run tests/unit/architecture/type-debt-ratchet.test.ts
pnpm run typecheck                            # app + index（tsconfig.json）
pnpm run typecheck:scripts                    # app + index + scripts（tsconfig.scripts.json）
pnpm run typecheck:tests                      # app + index + tests（tsconfig.tests.json）
pnpm exec vitest run
```

三份 tsc 配置均为 0 错误；**注意增量模式**：`tsc` 的 `.tsbuildinfo` 会吞掉未变更文件的错误，
判「0 错误」时加 `--incremental false`（或先删 `.tsbuildinfo`），否则可能得到假绿。

修复一个文件后，该文件计数下降无需手工改基线；**清零后必须**从
`tests/unit/architecture/type-debt-baseline.json`（或 `type-escape-baseline.json` /
`type-suppression-baseline.json`）移除该条目
（守卫会红灯提醒）。禁止用 `--force` 放宽棘轮。
