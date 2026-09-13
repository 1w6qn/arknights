# event 系统评估（2026-09-13）

评估对象：`app/game/kernel/events/`（契约层 + 运行时）及其在全仓的使用方式。
方法：静态交叉比对（声明 / 发射点 / 订阅点 / 数据模板引用）+ 真实存档实例化实测。所有数字可复跑，脚本见文末。

---

## 0. 结论速览

| 维度 | 评分 | 一句话结论 |
|---|---|---|
| 契约设计（类型安全） | 良 | `emit`/`on` 双向受 `EventMap` 约束，载荷为元组，编译期可查；无重复键 |
| 契约约束一致性 | 中 | 任务模板受 `EventMap` 强制约束，勋章模板用 `Record<string, ...>` + `as` 断言绕开，同一机制两种强度 |
| 运行时实现 | 差 | 生产只用裸 `TypedEventEmitter`（Emittery）；为此设计的 `EventBus`（优先级/中间件/验证器/日志）≈450 行在 `app/` 内**零引用** |
| 测试与生产一致性 | 差 | 74 个事件测试全部只验证 `EventBus`——一条生产不执行的代码路径 |
| 契约存活率 | 差 | 236 个声明事件中 47 个无任何发射点、16 个完全死掉；实测玩家实例 **48.4% 的监听器**注册在永不发射的事件名上 |
| 并发语义 | 差（高风险） | Emittery `emit` **并发**执行监听器 + `PlayerStatus._activeDraft` **调用栈式**复用 → 已两次触发 `proxy revoked`，修复是逐点规避而非系统解决 |
| 派发性能 | 良 | 实测 2000 监听器/次派发 ≈ 0.0011ms，CPU 开销可忽略；问题不在性能而在语义 |

**总评：契约层是这套系统最好的部分，运行时是最大的浪费，并发语义是唯一的真实风险源。**
事件系统当前实际扮演的是「进程内解耦广播」，但其中约一半的接线是死的，而真正需要它保证的顺序性它并不提供。

---

## 1. 结构与契约层

```
app/game/kernel/events/
├── priority.ts    11 行  Priority 枚举（HIGH/MEDIUM/LOW）
├── core.ts       210 行  78 事件：生命周期 / 对象变更 / 战斗 / 共享交易
├── mission.ts     45 行  17 事件：任务模板
├── medal.ts       12K    71 事件：勋章模板
├── rlv2.ts        59 事件：肉鸽
├── activity.ts    11 事件：活动
├── runtime.ts    482 行  TypedEventEmitter / EventBus / 中间件 / 验证器
└── index.ts       27 行  EventMap = 五域交叉 + re-export
```

`EventMap = EventMapCore & EventMapMission & EventMapMedal & EventMapRlv2 & EventMapActivity`，共 **236 个唯一键，无重复键冲突**（脚本校验通过）。

**载荷形态：元组。** 每个键的值是参数数组（如 `"char:get": [string, {from: string; extraInput?}, cb?]`）。
消费方式取决于走哪条路径：

- `TypedEventEmitter`（= `class extends Emittery<EventMap>`，**生产唯一路径**）：Emittery 1.2.1 的 `emit(name, eventData)` 只收**一个**参数，所以约定是「把整条元组作为单个参数传出，监听端解构」：
  ```ts
  await this._trigger.emit("items:get", [this._targets]);
  this._trigger.on("items:get", async ([items]: [PipelineItem[]]) => { ... });
  ```
- `EventBus`（**生产零引用**）：`emit(name, ...args)` 变参展开 + 串行 await。

两种约定互不兼容，全仓 333 个发射点按前者书写。这个「元组即单参」的隐式约定在 `medal.ts:426` 有注释说明，但**没有任何文档或守卫固化**；新增监听器若按 `EventBus` 直觉写成 `(a, b) => ...` 会静默拿到 `undefined`。TS 在多数位置能拦住，但被 `as keyof EventMap` 的断言位置拦不住（见 §3.3）。

**命名混用三种风格**：冒号域事件 78（`save` / `char:get`）、PascalCase 模板名 157（`CompleteStage`）、其余 camel 79。模板名即事件名是刻意设计（`ActivityTable.missionData.template` / `medal_table.template` 直接当键用），但结果是 `EventMap` 同时承担「内部信号」和「外部数据驱动的模板注册表」两种语义，这是后面所有死契约的结构性根源。

---

## 2. 运行时实现：一半的代码从未运行

### 2.1 `EventBus` 在生产环境零引用（已确证）

```
$ grep -rn "EventBus" app --include=*.ts | grep -v kernel/events/runtime.ts
app/game/kernel/events/priority.ts:5: * 独立成文件以便 EventBus 与领域事件映射解耦引用。   ← 仅注释
```

`useMiddleware` / `createLoggingMiddleware` / `createValidationMiddleware` / `addValidator` /
`setStrictValidation` / `enableLogging` / `getRegisteredEvents` / `globalEventBus` 在 `app/` 中**全部零引用**，只出现在测试里。
生产构造点在 `PlayerDataManager.ts:191`：`this._trigger = new TypedEventEmitter();`

即 `runtime.ts` 482 行中，生产实际执行的是 `export class TypedEventEmitter extends Emittery<EventMap> {}` 这 1 行，其余 ≈450 行（优先级监听器、中间件、验证器、日志开关、`subscribe`/`once` 覆写）是死代码。

**机会成本**：`EventBus` 的串行优先级派发（HIGH→MEDIUM→LOW，逐个 `await`）恰好是 §4 并发问题的解药，但它没被采用——问题和解药在同一个文件里共存了。

### 2.2 `EventBus` 自身的潜在缺陷（若要启用须先修）

1. `createValidationMiddleware(this.validators, this.strictValidation)`（runtime.ts:368）**按值捕获** `strictValidation`；此后调用 `setStrictValidation(true)` 不会影响已创建的中间件，而 `emit` 内联的验证分支读取的是实时字段——两条实现口径不一致。
2. `emit` 的优先级分支是裸 `await listener(...)` 串行无 `try/catch`：任一监听器抛错会**中断其余所有监听器**。这与 Emittery `emit` 的「其余监听器仍执行」语义相反，静默改变故障爆炸半径。
3. `emit` 末尾 `Emittery.prototype.emit.call(this, eventName, args[0])` 只透传首参，绕过 `on()` 直接经 Emittery 订阅的监听器（含 `onAny`）只能拿到元组首个元素（runtime.ts:226-230 有注释承认）。
4. `once` 覆写返回 `void`，与父类返回 `Promise` 的签名冲突，靠 `@ts-expect-error` 压制。

### 2.3 测试与生产脱节

- `tests/unit/game/model/events.test.ts` 与 `tests/unit/model/events.test.ts`：**37 × 2 = 74 个测试，两份近乎完全相同的文件**（后者用 `unknown` 夹具，前者已做类型化改造），全部 `expect` 都针对 `EventBus`，即生产不执行的那条路径。实测两侧均通过。
- 两份路径**都不镜像真实源码位置**（AGENTS.md 约定 `tests/unit/**` 镜像 `app/`）——真实路径是 `app/game/kernel/events/`，`tests/unit/game/kernel/events/` 不存在。这是两次重构（`service/`→`kernel/`、目录上移）留下的双重残留。
- 结果：生产真实的「元组即单参 + 并发执行」语义没有专门的单元测试，只能靠模块级集成测试间接覆盖。
- `tests/unit/architecture/` 下 11 个守卫中**没有任何事件契约守卫**（无死事件检测、无重复键检测、无 `emit`/`on` 载荷一致性检测）。

---

## 3. 覆盖度：一半接线是死的

### 3.1 静态交叉比对（代码层）

| 口径 | 数量 |
|---|---|
| `EventMap` 声明事件 | 236 |
| 存在发射点（字面量 `.emit("..."`） | 190 |
| 声明但**无任何订阅方**（纯空转） | 21 |
| 声明但**无任何发射点** | 47 |
| 既无发射点也无订阅（完全死） | 16 |
| 发射但未声明（幽灵键，仅 `downloaded`，属 asset 模块自建 emitter，非本总线） | 1 |

- 完全死掉的 16 个：`battle:complete`、`char:evolve`、`char:potential`、`char:skillUp`、`item:get`、`item:use`、`log:event`、`medal:reward`、`medal:unlock`、`mission:complete`、`mission:reward`、`mission:update`、`player:login`、`rlv2:bank:withdraw`、`rlv2:game:end`、`rlv2:node:complete`。
- 有订阅者但永不发射（监听器形同摆设）：`char:levelUp`（char.ts:73）、`game:fix`（troop.ts:22）、`stage:update`（dungeon.ts:11）。
  `game:fix` 的历史在 `PlayerDataManager.ts:215` 有自述：「历史上一度通过 `game:fix` 事件触发但无 emit 方 → 从不执行」，现改为构造期直接调用——但 `troop.ts` 的**订阅仍在**，属未清理的残留。
- 有意思的是 §0 的「无订阅方」21 个里包含 `battle:complete`/`player:login`/`log:event`，说明契约是先写下、后接线，而接线从未回填。

### 3.2 实测（真实存档实例化）

用 `data/user/databases/1.json` 构造一个真实 `PlayerDataManager`，包装 `on` 计数：

```
订阅总数 783，事件种类 125
其中「无任何发射点」的死订阅：42 种 / 379 个监听器 (48.4%)
死订阅 Top10: CharStoryUnlock(310), CrisisTempClearSome(11), CrisisUseAssist(6),
              PassStageWithLessDeploy(3), PassStageWithReedResidue(3), PassStageWithBossRush(3), ...
有发射点的事件：83 种 / 404 个监听器
扇出 Top10: PassTower(31), PassStageSome(29), CampaignsComplete(29), MissionCompleteSome(20), ...
```

**单玩家实例 783 个监听器里有 379 个（48.4%）注册在永不发射的事件名上，永不执行。**
其中 `CharStoryUnlock` 一个模板就占 310 个——它的勋章改由 `troop.ts#addonStoryUnlock` **直接写存档**绕过事件系统（`troop.ts:158-172`），旧的监听注册没有被移除。这是一个可复现的「事件系统被绕过、旧接线未清理」样本。

### 3.3 数据侧（真实玩法影响）

事件名 = `medal_table.template` / `ActivityTable.missionData.template`，而**所有发射点都是字面量**（唯一样本 `downloaded` 除外）。因此「模板名无发射点」= 「该模板永远收不到事件」。

**勋章**（`medal_table.json`，共 1626 枚）：

| 项 | 数量 |
|---|---|
| 模板无任何发射点 → 永不可达 | **639 枚 / 39.3%**，涉及 119 种模板 |
| ├─ `CharStoryUnlock`（387 枚）：代码中走直写绕过 | 387 |
| └─ 代码中**零引用**（彻底未实现）| **252 枚 / 15.5%**，118 种模板 |

零引用的 118 种包括整族未接线：`Sbv3*`(9)、`Sbv2*`(11)、`Rlv2*`(9)、`ActMultiV3*`(6)、`PassStageWith*`(20+)、`Crisis*`、`ActivityAutoChess*` 等。

**任务**（`activity_table.json`，共 3752 条）：100 种活动模板中 **57 种无发射点，覆盖 525 条任务 / 14.0%**。

**类型约束的不对称是这里的关键**：

- 任务侧 `MissionTemplateGroup = { [T in keyof Partial<EventMap>]: {...} }`——模板键**被 `EventMap` 强制约束**，写未声明的事件名编译不过；数据里那 57 种未实现模板被 `if (tpl in MissionTemplates)` 挡下并记 `debug` 日志。
- 勋章侧 `const MedalTemplateHandlers: Record<string, MedalTemplateHandler>` + `const eventName = template as keyof EventMap`（medal.ts:424）——**断言绕开了全部类型检查**。所以 119 种永不发射的模板在编译期零信号，只在运行时静默不触发。

**同一套「模板名即事件名」机制，两侧保障强度不同，弱的那一侧正好是问题所在。**

失败模式也很隐蔽：任务侧未实现只记 `logger.debug`（`logic.ts:1029`），生产 `LOG_LEVEL=info` 下**不可见**；勋章侧未实现记 `logger.debug`（`medal.ts:396`），同样不可见。

---

## 4. 并发语义：唯一的真实风险源

### 4.1 机制

生产走 Emittery `emit`，其语义是：
- **监听器按注册顺序被调用，但并发执行**（`Promise.all` 语义）；
- 任一听众 reject → 返回的 promise reject，但其余听众仍执行。

而 `PlayerStatus.update()`（PlayerStatus.ts:126-151）用 `_activeDraft` 做去重：

```ts
if (this._activeDraft) return await recipe(this._activeDraft);   // ← 调用栈式复用
const [draft, finish] = mutCreate(this._playerdata, {...});
this._activeDraft = draft;
try { const result = await recipe(draft); /* finish() 提交 */ }
finally { this._activeDraft = null; }
```

`_activeDraft` 是**调用栈作用域**的守卫（为嵌套 `emit → gainItem → update` 设计），不是并发守卫。两个并发监听器 A、B：

1. A 进入 `update()` → `_activeDraft = draftA` → recipe 内 `await` 让出；
2. B 进入 `update()` → 看到 `_activeDraft` → **复用 draftA** → recipe 内 `await` 让出；
3. A 恢复 → `finish()` 提交 → `finally` 置 `_activeDraft = null`；
4. B 恢复 → 继续往**已被 finish 撤销的 draftA** 写入 → `Cannot perform 'set' on a proxy that has been revoked`。

这正是仓库里已两次记录的事故，且两次都是**逐点规避**而非系统修复：

- `mission/logic.ts:1108-1115`：把 `await this.getState()` 提到 `update()` recipe **之外**，并注明「Emittery.emit 并行执行所有监听器…recipe 内 await 产生交错 → proxy revoked，任务状态不落盘」。
- `medal/medal.ts:435-438`：`await this._trigger.emit("medal:complete", ...)` 由 fire-and-forget 改为 await，注明「与同批任务监听器的 update() 并发竞争共享 Immer draft」。

### 4.2 存量暴露面

扫描 `app/` 得 **33 处 `update(async recipe)` 的 recipe 内含 `await`** 的调用点：

```
12  app/game/modules/character/char.ts
 5  app/game/modules/gacha/recruit.ts
 3  app/game/modules/storyreview/StoryreviewManager.ts
 2  app/game/kernel/inventory.ts / home/HomeManager.ts
 1  其余 9 个文件各 1 处（battle / building×2 / troop / checkin / retro / roguelike×2 / aprilFool）
```

这 33 处是否全部危险取决于其调用栈位置（嵌套调用安全，顶层监听器不安全），但**没有守卫区分二者**，也没有 lint 规则。`mission/medal` 两处已修的正是这个模式。

扇出放大了暴露概率（数据推算的单事件监听器上限）：

```
勋章：CharStoryUnlock 387、PassStageSome 197、PassTower 59、GotCharsBeforeTime 55、MissionCompleteSome 52
任务：CompleteAnyStage 1231、CompleteStageAct 1173、CompleteStageCondition 201、StageWithEnemyKill 81
```

任务数据里 `CompleteAnyStage` 挂着 1231 个监听器——一次通关发射会让上千个 listener 进入并发派发。实测（§3.2）单玩家实际注册了 783 个监听器、83 个活跃事件，扇出最高 31，说明存档中大量任务已完成而未注册，但**冷启动/新号场景下的扇出会显著高于此**。

### 4.3 其他健壮性缺口

- **21.9% 的发射未 await**：333 个 `.emit(` 调用中 73 个未 await（68 个在 `roguelike/`）。多数监听众是同步的，因此顺序仍确定（Emittery 同步调用至首个 `await`），属可接受；但异步监听器类不然。
- **`save` 事件 fire-and-forget**：`PlayerDataManager.ts:240` `this._trigger.emit("save", [])` 未 await，而 `delta` getter 紧接着返回给 `res.send`。per-player 监听器是 500ms 防抖（`scheduleSave`），语义上可接受；但 `AccountManager.ts:163` 的 `save` 监听器（`await this.saveUserConfig()`）若抛错，会走全局 `unhandledRejection`——`index.ts:12` 只记一条日志，无重试、无告警。
- **`rlv2:get:items` 时序**：`event.ts:417` 未 await 发射，而监听器 `inventory.ts:46` 是异步的（`for (const item of items) await this.getItem(item)`），紧随其后的 `pending.shift()` 与状态写入交错；物品发放可能落在 `res.send(player.delta)` **之后**，导致该次 delta 不含物品、延迟到下一次响应（`markDirty` 语义下不丢失，但客户端可见延迟）。未证实有线上复现，但机制成立。

---

## 5. 性能

派发本身**不是问题**。实测（2000 个同步监听器 × 2000 次 `emit`）：

```
2000 次 emit（每次 2000 监听器）耗时 2.2ms → 0.0011ms/次
```

真正成本在监听器内部（每个 listener 的 `update()` / excel 查表 / 深 diff），以及请求内串行发射的 15+ 个战斗事件（`battle.ts:905-920`）。379 个死订阅不消耗运行时间，只占注册开销与内存；`CharStoryUnlock` 的 310 个死监听器同理——**这是正确性/可维护性问题，不是性能问题**，评估时不应夸大。

---

## 6. 改进清单

### P0（正确性 / 无声失败）

1. **消除并发派发根因**——三选一，不要继续逐点打补丁：
   - (a) 把 `PlayerDataManager._trigger` 换成采用**串行**派发的实现（要么启用现成的 `EventBus`，要么改用 `emitSerial`）；
   - (b) 给 `PlayerStatus.update()` 加**真并发守卫**（`await this._pending` 链 / 互斥），让并发的 `update` 排队而不是复用 `_activeDraft`——这是最小改动且能一次性覆盖 33 处存量；
   - (c) 至少加一条守卫测试，禁止在顶层事件监听器的 recipe 内出现 `await`。
   *建议 (b) 优先*：`_activeDraft` 的复用是必要的（嵌套场景），缺的只是并发串行化，改动局部、收益全局。
2. **勋章模板键纳入类型约束**——把 `MedalTemplateHandlers: Record<string, ...>` 改为映射 `keyof Partial<EventMap>`（与 `MissionTemplateGroup` 对齐），并把 `template as keyof EventMap` 断言去掉。这一步会在编译期暴露 119 种永不发射的模板。
3. **死契约清理**——47 个无发射点事件、16 个完全死键、21 个无订阅方事件、以及 `game:fix`/`stage:update`/`char:levelUp` 三个摆设监听器，逐个二选一：接线，或从 `EventMap` + 监听点删除（`core.ts:66-70` 已有一次同类清理的先例与注释，照此办理）。

### P1（可维护性）

4. **`EventBus` 去留决策**——约 450 行生产零引用代码，要么在 P0-1 中启用（并先修 §2.2 的四个缺陷），要么整体删除、把 `runtime.ts` 收敛成 20 行的 `TypedEventEmitter` + 契约 re-export。当前「两套语义并存、测试测的是不用的那套」是最坏状态。
5. **合并重复测试**——`tests/unit/model/events.test.ts` 与 `tests/unit/game/model/events.test.ts` 二选一，迁到真实镜像路径 `tests/unit/game/kernel/events/`，并把测试目标从 `EventBus` 改为生产实际使用的 `TypedEventEmitter`（覆盖「元组即单参」约定与并发/错误隔离行为）。
6. **补契约守卫测试**（放进 `tests/unit/architecture/`，与既有棘轮同风格）：
   - `EventMap` 键在代码中存在发射点或显式标注 `@planned`；否则失败；
   - 五域交叉无重复键；
   - 模板键（任务 + 勋章）⊆ `EventMap`。
7. **固化「元组即单参」约定**——在 `events/index.ts` 头注释写明，并考虑加一条 `on` 覆写：当监听器 `fn.length > 1` 时告警（能抓住按 `EventBus` 直觉写错的新代码）。

### P2（一致性 / 可观测性）

8. **未实现模板降级上调**——任务/勋章未实现模板当前记 `logger.debug`，生产不可见。改为启动期汇总一条 `warn`（「本次加载 N 种模板未实现，覆盖 M 条任务 / K 枚勋章」），让覆盖缺口可观测而非静默。
9. **`CharStoryUnlock` 直写样本归位**——要么恢复事件接线（并保留直写为兼容），要么删除勋章侧的 310 个死监听；当前是两套逻辑并存的中间态。
10. **未 await 发射复查**——重点复查 `roguelike/` 的 68 处中监听器为异步的那些（`rlv2:get:items` 等），需要顺序的地方补 `await`。
11. **命名收敛**——`EventMap` 混装内部信号与数据驱动模板名，长期应拆为 `EventMap`（内部，冒号风格）与 `TemplateEventNames`（外部），后者由数据侧校验。

---

## 附：复跑方式

本次评估的脚本位于 `tmp/ev-eval/`（临时目录，未提交）：

```bash
node tmp/ev-eval/ev.js      # 声明 / 发射 / 静态订阅 交叉比对
node tmp/ev-eval/ev2.js     # 含动态模板订阅的完整覆盖分析（A/B/C/D 分类）
node tmp/ev-eval/ev4.js     # 按发射点存在性统计不可达勋章/任务模板
node tmp/ev-eval/ev5.js     # 分离「直写绕过」与「彻底未实现」
./node_modules/.bin/tsx tmp/ev-eval/measure3.ts   # 真实存档实测监听器普查 + 派发基准
```

实测复用真实数据（`data/user/databases/1.json` + `data/excel/`），无需起服；`measure3.ts` 通过包装 `TypedEventEmitter.prototype.on` 计数，不侵入生产代码。
