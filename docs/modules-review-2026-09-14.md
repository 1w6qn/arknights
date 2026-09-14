# modules 审阅报告（2026-09-14）

> 范围：`app/game/modules/**`（50 个模块目录、326 个 TS 文件、约 118k LOC）+ 挂载表 `app/game/routes.ts` + 架构守卫。
> 方法：**只读静态审阅**。7 组并行子代理按模块族深查 + 主线程横切取证（复跑 9 个 architecture 守卫、静态扫描脚本、抓包库 `tmp/capture/index.db` 交叉验证）。未修改任何源码、未跑全量测试套件（仅在 WSL/9p 上复跑了 architecture 守卫）。
> 取证脚本：`tmp/module-review-scan.mjs`（一次性，gitignored）。

---

## 0. 结论摘要

- **架构卫生状态良好**：9 个 architecture 守卫 55 个用例全绿；物品管道「直发事件」已清零并由棘轮固化（口径盲区见 §2.8）；全仓 `any` 为 0（modules 内 7 处命中全在注释里）；modules 内无 `console.*`、无空 `catch`、无直接 `player.save()`、无未挂载路由文件。
- **主要问题不在「结构」而在「边界与校验」**：路由契约盲区（`handler.ts` 不在 schema-first 扫描面）、会话服信任客户端上报、多处奖励/扣费路径不闭环、若干输入未校验可致存档损坏（NaN/负库存）、巨型文件守卫覆盖面偏窄。
- 7 组子代理合计标出 **约 25 条 P0**（其中「双前缀死挂载」等跨组重复，去重后 §0.2 收敛为 9 项先修）、**60+ 条 P1**、**一批 P2 与死代码/协议桩**；另有 4 份 review 类文档已明显滞后于代码。

### 0.1 威胁模型与优先级口径（重要）

这是**单账号私服**（`game/app.ts` 强制 uid=1），因此「客户端自报参数换免费道具」的危害远低于公网服务：玩家刷的是自己的档。本报告按**危害性质**而非「可被利用」排序：

1. **不可逆数据损坏 / 丢档**（最高）：`building` 的 NaN 写入、`rlv2` 重登丢 5 个字段、`pay-store` 订单清零、路径穿越写文件。
2. **客户端可见的功能不闭环**：领了没奖励、买了没扣费也没货、任务完成无奖、500 崩溃。
3. **经济与边界校验缺口**（对私服是「正确性/还原度」问题，不是安全事件）。
4. **网络暴露**（仅 `arkhub`/`enemyDuel` 网关，缺省绑全网卡）——只有在 LAN/公网可达时才是真风险。
5. **死代码 / 协议桩 / 文档漂移**。

### 0.2 最该先修的 9 件事

| # | 事项 | 证据 |
|---|---|---|
| 1 | building 生产/交付写入 NaN 与负库存（存档不可逆污染 + 刷金币/合成玉） | §3.6 |
| 2 | tower 奖励双通道入库（直写库存 + `gainItem` 各发一次） | §3.8 |
| 3 | rlv2 `status.toJSON()` 丢 `runResult/zoneReward/…` → 重登丢局、结算判失败 | §3.1 |
| 4 | 发奖不闭环/可重复：活动族 3 处、`_confirmActivityTableMission` 无限领、medal 118 模板无事件源 | §3.2 / §3.8 |
| 5 | 抽卡/商店扣费缺口（`useTkt` 无 default 0 成本、伪造 `ticketId`、现金商店无支付校验、crisis 商店不扣费） | §3.4 / §3.8 |
| 6 | 相册缩略图 `leafId` 路径穿越（写/删任意 `.jpg`） | §3.5 |
| 7 | 会话网关无鉴权 + 战斗奖励全信客户端 + 会话内状态不落盘 | §3.3 |
| 8 | 新账号 474 条任务/medal target 播种错误 → 任务板不可见、勋章提前完成 | §3.8 |
| 9 | 契约盲区：16 条 building POST 未挂现成 schema（`handler.ts` 逃过守卫） | §2.1 |

规模与覆盖（脚本实测）：

| 指标 | 值 |
|---|---|
| 模块目录 / TS 文件 / LOC | 50 / 326 / ≈118k |
| POST 路由注册点 | 658 |
| `validateBody` 覆盖 | 行内联匹配 634 / 658；8 行窗口实测真正缺失 **17**（building 16 + gacha 1，另有 multipart 豁免） |
| `public.ts` 门面 | 10 个 |
| 零引用模块文件 | 1（`account/user.model.ts`，0 字节） |
| >1000 行文件 | 15（其中 13 个不在 file-size 守卫命名面内） |
| 测试文件 | 全仓 287；模块相关分布在 `tests/unit/modules/**`（74）与 `tests/unit/{manager,router}/**`（98） |

---

## 1. 已验证的架构基线（正面结论，避免误报）

复跑 `node_modules/.bin/vitest run tests/unit/architecture/`：**9 文件 / 55 用例全绿（14.2s）**。

- **物品管道**：`inventory-pipeline-baseline.json` 为 `total: 0`。grep 命中的 45 处 `items:get|items:use` 经逐条核对**全部是注释/JSDoc**（如 `building/logic.ts:108`、`character/char.ts:88`、`gacha/trigger.ts:4`）。AGENTS「84 处 → 0 并由棘轮守卫固化」属实。
- **类型债**：modules 内 `any` 命中 7 处，全部位于注释（`depot/routes.ts` JSDoc、`roguelike/logic.ts:920` 等），无真实逃逸。
- **错误处理**：modules 内无空 `catch`、无未 `await` 的 `gainItem` 管道链（抽查 `shop/logic/fes.ts:67`、`social/social-manager.ts:226` 均为 `await mgr._player.gainItem`）。
- **响应契约**：无 `const d = player.delta` 后再 `res.send(player.delta)` 的双读；`building/routes.ts:153` 与 `roguelike/response.ts:96` 是单次快照 + 就地改写，合规。
- **挂载完整性**：所有 `routes.ts/handler.ts/router.ts` 文件都能在挂载表或活动聚合根里找到，无「写了路由但没挂」的死端点。

---

## 2. 横切问题（主线程取证，含可执行修复）

### 2.1 [P1] 路由契约盲区：`handler.ts` 不在守卫扫描面，building 16 条 POST 裸奔（**已于 §7 整改**）

`schema-first-guard.test.ts` 的 `ROUTER_FACE` 只匹配 `routes.ts` / `*.routes.ts` / `plugin-heartbeat.ts`，注释里自述「building/gacha 等 handler.ts 不在册，留待 T4 裁决」。后果：

- `app/game/modules/building/routes.ts` 有 **16 条** POST 未过 `validateBody`（`207/301/322/340/356/368/388/396/415/468/530/602/652/704/726/737`）；其中 **15 条在 `building/building.schema.ts` 里已有现成 schema 却未接线**（另 1 条 `getMessageBoardContent:704` 连 schema 都没有）。现成 schema 变成孤儿（`buildRoomSchema`、`settleSaleSchema`、`accelerateSolutionSchema`、`sendEmojiSchema` …）。根因是 building 没有 `routes.ts`（路由直接写在 `handler.ts`），而守卫只扫 `routes.ts`。
- `app/game/modules/gacha/routes.ts:267` 的裸 `router.post("/")` 未校验（body 未使用，风险低）。

修复（低成本、高收益）：把 `building/routes.ts:207…737` 的 15 条路由逐条包上对应 schema，再把 `ROUTER_FACE` 扩到 `handler.ts`（gacha 的 `/` 走空 body 即可）。这也顺带清掉 15 个死 schema。

### 2.2 [P2] 文件规模守卫命名面偏窄，13 个 >1000 行文件未受约束（**路由载体部分已于 §7 整改**）

`file-size-guard.test.ts` 只扫 `*logic.ts` / `*router.ts` / `*handler.ts`（阈值 1500）。实测超限或逼近但**不在面内**的文件：

| 行数 | 文件 | 守卫 |
|---|---|---|
| 3939 | `medal/medal.ts` | 盲区 |
| 1644 | `battle/battle.ts` | 盲区 |
| 1549 | `activities/enemyDuel/session/payloads.ts` | 盲区 |
| 1488 | `roguelike/modules/grid_zone.ts` | 盲区 |
| 1466 | `crisis/routes.ts` | 盲区（`routes.ts` 不在命名面） |
| 1217 | `user/routes.ts` | 盲区 |
| 1199 | `sandbox/routes.ts` | 盲区 |
| 22021 | `roguelike/data/blackstream-data.ts` | 盲区（数据表，另议） |

建议：守卫改为「按扩展名扫全 `modules/**/*.ts`，数据/生成文件走显式白名单」，否则新逻辑可以继续塞进 `medal.ts` 这类文件。

### 2.3 [P2] 4 个「死挂载」+ 若干半死挂载

`app/game/routes.ts` 对自带模块前缀的 router 又在同名前缀挂了一次，产生 `/x/x/*`：

- `{prefix:"/retro"}`（`retro/routes.ts` 路径为 `/retro/*`）
- `{prefix:"/roguelike"}`（`roguelike/routes.ts` 路径为 `/roguelike/*`）→ `/roguelike/roguelike/*`
- `{prefix:"/campaignV2"}`（`campaignV2/routes.ts` 路径为 `/campaignV2/*`）
- `{prefix:"/interlock"}`（`interlock/routes.ts` 路径为 `/interlock/*`）

这些挂载**永不匹配**（正确入口由 `/` 或 `/activity` 挂载提供），抓包证实客户端走 `/activity/roguelike/*`、`/campaignV2/*`、`/activity/interlock/*`。属于无害死配置，但会误导后续排查；建议删除或加注释说明兼容意图。半死的有 `/autochess/autochessSeason/*`、`/vecbreak/vecBreakV2/*`、`/multiplayer/multiplayerV3/*` 等自前缀子集。

### 2.4 [P1] 官方端点仍缺 1 条：`/rlv2/finishGame`

`docs/接口覆盖分析-未实现与stub清单.md`（2026-08-17）列的 6 条未实现 rlv2 端点，其中 5 条已由 `bfdd16c5`（setSeed / 战令直购 / 铜钱换牌 / 科技树解锁）补齐并有 handler 注册；**`/rlv2/finishGame` 至今无任何注册**（`roguelike/rlv2.routes.ts` 只有 `gameSettle` / `giveUpGame`），是全仓唯一确认缺失的官方接口。建议补路由或在文档显式标注「以 gameSettle 替代」。

### 2.5 [信息] 抓包库里的 404/500 已核实，勿误读

`tmp/capture/index.db`（2177 条）中 702 条 422 全部来自 2026-09-11 的**空 body 探针会话**（`req_size: 2` = `{}`），属于 `validateBody` 正常拒绝，不是缺陷。4 条 500（`/u8/user/v1/getToken`、`/user/auth/v1/token_by_phone_password`）在 `app/core/auth/auth.ts:116,289` 已修为 400/401，**已解决**。43 条 404 中大部分是 `gettestGoodList` / `arknights/test` 之类探针路径。真正值得跟踪的缺失端点见 §2.4。

### 2.6 [P2] 测试覆盖：数量充足，但断言深度与本次 P0 错位

全仓 `tests/unit/**` 共 **287** 个测试文件，模块测试分布在两处：新布局 `tests/unit/modules/**`（74 文件，含 `rlv2/` 49）与旧镜像 `tests/unit/{manager,router}/**`（98 文件，battle/medal/mail/pay/crisis/tower/user/social… 都在这里）。因此**不存在「关键模块没测试」的问题**，实际问题是：

- 完全没有专属测试的模块基本是协议桩：`sandbox`、`multiplayer`、`deepsea`、`explore`、`rune`、`siracusaMap`、`businessCard`、`system`、`interlock`、`misc-alignment`（除 sandbox 2.3k LOC 外均 <500 LOC）。
- **断言深度不足**：`tests/unit/modules/activities/milestone-exchange.test.ts` 3 条用例只断言「购买记录写入/拒绝」，恰好漏掉 §3.2 的「不发物也不扣费」P0；`tests/unit/modules/rlv2/*` 有「用例名承诺 > 断言」「把空桩固化为期望」两类浅测试（§3.7）。
- 注意 AGENTS 的测试性能不变量：每新增一个测试文件要重载整张 app 模块图（10~20s/文件），所以**优先并入既有文件**。

### 2.7 [P1/P2] 文档漂移

| 文档 | 漂移点 |
|---|---|
| `docs/接口覆盖分析-未实现与stub清单.md`（08-17） | 6 条未实现 → 实际剩 1 条（§2.4）；文中路径示例已随重构失效 |
| `docs/module-audit-2026-08-29.md` | 已修/过时：「物品绕过管道」部分修复（§2.8）、battle AP 已在 `battleStart` 预扣（`battle/battle.ts:433-434`）、campaignV2 剿灭已落地（不再固定 1 碎片）、storyreview 余额校验已加、checkin 索引已加门禁、act24side/act1vhalfidle 战斗奖励已修、prts-wiki §5.6-2/3/4/5/7 已修。仍成立：crisis 商店不扣费、medal 占位、六星/密录奖励未落地、sandbox 最空、rlv2 alchemyReward 忽略 index。**「dungeon 全关卡默认三星」需改写**——代码确为默认 `state=3`，但 `stage:update` 无生产者，当前不可达（§3.8） |
| `docs/重复实现审查-整合清单.md`、`docs/代码冗余审查-2026-09-10.md` | 大量行号/路径引用 `app/game/controller/*`、`router/*` 等已随 2026-09-13 重构消失（controller 层已删除），需重跑脚本重定位；部分 P0 已修（如活动任务单条/列表版已合并进 `activities/shared/shared.ts`） |
| `AGENTS.md` | 「物品管道已全量迁移」应改为「无直发事件」（§2.8）；「玩家存档主事实源是 social.db gzip BLOB」与 design-spec 的 JSON 存储说法并存，建议统一 |

---

### 2.8 [P1] 「物品已全量迁移」的口径比字面窄：守卫只抓「直发事件」，不抓「直改 draft」

`AGENTS.md` 的说法是「物品增减统一经 `player.gainItem.setTarget(...).use()/handle()` 管道……已全量迁移并由棘轮守卫固化（84 处 → 0）」。复跑后确认字面属实，但 `scripts/lib/items-pipeline-scan.ts:37` 的判定正则是 `_trigger\.emit\(\s*["']items:(?:get|use)["']` ——**只统计直接 emit 事件**，不统计直接改写 `draft.inventory[...]` / `draft.status.gold`。实测 modules 内仍有 6 处硬编码直写（`building/logic/construction.ts:384,421`、`reslock/reslock.ts:105,132`、`tower/routes.ts:805`、`tower/tower-reward.ts:337-338`），另有 `building` 通过 `_pendingGainEvents` 手动补发追踪事件、`_applyGoldDelta` 连补发都没有 —— 等于在管道之外维护了第二套入账+事件实现。

结论：棘轮的 `total: 0` 应理解为「无直发事件」，不是「无旁路入账」。建议把扫描面扩到 `draft.inventory[...] =` / `draft.status.gold +=` 形态（或改 AST），并把 building 的 `_apply*` 三函数收敛进管道。

---

## 3. 模块族深查发现

> 全部为只读代码取证，`文件:行` 可直接跳转复核。标注「（已复核）」的 P0 由主线程亲自读码确认；其余为对应子代理的取证结论（保留了原始行号，未逐条二次复核）。

### 3.1 roguelike / rlv2（36.9k LOC，48 文件）

**P0（已复核）**

- `roguelike/battle-nav.ts:213-237` — `battlePassGetReward` 只查 `bp.reward[id]` 去重，**从不校验 `milestone.tokenNum <= bp.point`**。客户端把 `rewards` 填成整条里程碑列表即可一次性领完全部档位（含大奖）。→ 领取前校验累计点数门槛。
- `roguelike/battle-nav.ts:254-282` — `buyReward` 的 `cost` 完全由客户端声明（`roguelike/rlv2.schema.ts:188-192` 仅 `nonnegative`），`cost:0` 即 0 点直购任意里程碑/大奖；代码注释自承「不校验价格本身」。→ 价格由服务端 `milestones/grandPrizes` 推导或按 tokenNum 校验。

**P1**

- `roguelike/status.ts:160-171` — `toJSON()` 未输出 `runResult / innerMission / nodeMission / zoneReward / traderReturn`，而 `load()`（同文件 99-103）从存档读这些字段；落盘走 `JSON.stringify(_playerdata)`（`kernel/player-status.ts:182-184`）→ **重登后这些字段全部丢失**：`runResult=""` 会让 `settle.ts:468-469` 判 `success=0`，待领 zone 奖励与节点任务一并消失。→ `toJSON` 补齐 5 个字段。
- `roguelike/module.ts:242-261` — `applyModuleDelta` 在 `this.toJSON()` 的新副本上累加（各模块 `toJSON` 返回新对象，如 `modules/dice.ts:44-46`），事件选项的 `m_get/m_lose`（san/dice/weather）变更被静默丢弃。→ 对真实模块实例写，或让模块暴露 `applyDelta`。
- `roguelike/recruit.ts:154-156` — `active(id)` 先 `this.tickets[id].state = 1` 再判存在；`/rlv2/activeRecruitTicket {id:任意}`（`recruit-flow.ts:19` 未判空即 emit）→ TypeError 500。
- `roguelike/recruit-flow.ts:105-113` — `useStashedTicket` 在 ticket 缺失时 `sid.includes("")` 恒真并**整体清空 `stashRecruit`**，清空动作还在判空 return 之前 → 调一次即丢光留存券。
- `roguelike/inventory.ts:238` + `shop.ts:124-126,150,239-264` — 商店 `toolPool` 会卖 `ACTIVE_TOOL`，而 `ACTIVE_TOOL: (item) => {}` 是空处理器 → 先扣金币、零收益。
- `roguelike/battle-nav.ts:33-65` + `map.ts:470-475` — `moveTo` 不校验目标节点存在/相邻，`findNode` 无兜底即读 `next.type` → 非法坐标 500，合法坐标可任意跳点绕过路径与代价。
- `roguelike/game-init.ts:401-482` — `chooseInitialRecruitSet` 无挂起事件前置/幂等校验（对比 `chooseInitialRelic` `game-init.ts:389-392` 有 `if (!event) return`）→ 循环调用每次再发 3 张招募券。
- `roguelike/game-init.ts:109-177` + `status.ts:124-129` — `createGame` 不校验 `theme/modeGrade/predefinedId` 与 init 表匹配，`find(...)!` 未命中即 `undefined` 解引用 → 非法 body 500。

**P2**

- `roguelike/rlv2.routes.ts:738-742` + `logic.ts:701-705` — 路由丢弃已校验的 `body.index`、硬编码 `{index:0}`，`alchemyReward` 本身也忽略 index。**module-audit 的这条 P0 结论仍成立、未修**。
- `roguelike/events.ts:331-336` — 每次构造 `GAME_INIT_RECRUIT` 都 `_trigger.on("rlv2:choose_init_recruit_set", …)`，跨局累积监听器与旧闭包（Emittery 不自动回收）。
- `roguelike/status.ts:147-158` — `status.bankPut()`（50% 且不扣金币）无调用点，与 `bank.ts:11` 的正确实现重复且行为分叉 → 删。
- `roguelike/grid-nav.ts:583-584` — 无挂起事件时用客户端 `args.stageId` 兜底开战，任意关卡可结算奖励。
- `roguelike/grid-nav.ts:432-434` — `gainPreciousScrap` 直接等于 `gainRandomScrap`，语义丢失。
- `roguelike/logic.ts:1057-1421` — 尾段 40+ 方法全是对 shop/bank/settle/grid-nav/game-init/event/battle-nav 的同名薄委派（改一处要改两处）；另有 `RoguelikePushMessage`、`isBlackstream`、`getPlayerOptional` 未使用导入。
- v1 旧路由 `routes.ts:35-89` 的 `createGame/finishGame/giveUpGame/milestoneReward` 仍是空桩（配合 §2.3 的双前缀问题）。

### 3.2 活动族（activities/，除 arkhub/enemyDuel）

**P0（已复核）**

- `activities/milestone/logic.ts:456,469-477` — `exchangeActivityShopItem` 的 `rewardItem` 声明后**从未赋值**，`if (rewardItem)` 恒 false；但 `recordPurchase`（`kernel/util/purchase-record.ts:26-31`）已把限购 count 累加 → **不扣货币、不发物，却吃满限购**，活动商店永久「售罄且零到账」。→ 从 excel 商品表读 cost/item，扣币后发奖，失败不记账。
- `activities/shared/shared.ts:184-207` — `confirmOneActivityMission` 兜底分支（missionId 不在 `MissionTable` 时）不读已领标记，写 `state=3` 后**无条件** `gainItem.add` → 对 `ActivityTable.missionData` 任意 id 反复调 `/activity/confirmActivityMission` 可无限领奖。→ 先判 state/已领。
- `activities/milestone/logic.ts:383-404` — `confirmActivityMissionGroup` 兜底分支先发 `missionGroup.rewards`，最后才写 `missionGroups[id]=1`，全程不读旧值 → 同一 groupId 可反复领。→ 先判已领。

**P1**

- `activities/charm/routes.ts:193-206` + `kernel/inventory.ts:543` — 首通奖励以 `{type:"CHARM"}` 走管道，而 `CHARM: async () => {}` 是空实现；`charm.charms` 全仓唯一写入点是 `charm/routes.ts:144` 的扣减 → **首通奖励静默丢失，且 `firstReward[charmId]=1` 已置位不可补领**。→ 管道内落 `draft.charm.charms`。
- `activities/milestone/logic.ts:480-528` — `getActivityCollectionReward` 只判「是否领过」，不校验收集进度；配置查不到时仍写 0 标记 → 可白拿 + 标记先落导致奖励作废。
- `activities/act1vhalfidle/logic.ts:442,459`（`shared/activity.schema.ts:442-444` 仅 `z.number()`）— `upgradeChar/upgradeSkill` 直接写存档，无消耗无上限（只有 `evolveChar:475-479` 有 `halfIdleRankCap` 钳制）。
- `activities/act24side/routes.ts:279-289` + `activity.schema.ts:303` — `items` 为 `z.record(z.string(), z.number())`，无正整数/白名单：负 count 使 `itemsData[key] -= count` **反而加素材**，未知 key 写入 `NaN` 污染存档。
- `activities/act42side/routes.ts:139-146,161-168,175-182` — 三个端点只写状态、不发奖励、不读旧状态 → 「任务完成但无奖励」（module-audit 结论仍成立）。
- `activities/bossRush/bossrush.ts:81,83,207,384-387` — 互斥 `_ongoingBattleId` 与防重 `_settledBattleIds` 都是实例内存态：放弃不结算则互斥永不清空（本进程永久 battle-in-progress）；重启后防重清空可重复结算。

**P2**

- `checkin/logic.ts:641,672,695` — `CHECKIN_ACCESS!` / `BLESS_ONLY!` 非空断言，活动不在 unlockActivity 时间窗时 TypeError→500。
- `checkin/logic.ts:355-366` — `CHECKIN_VS.availSignCnt` 恒为 1，从不按自然日重置 → 整期只能签一次。
- `act44side/informant.ts:460-463` — CHOICE 轮次无耐心上限，可无限 `selectChoice` 堆满 `successRate`。
- `shared/shared.ts:137-156` 与 `football/routes.ts:186-207` — miniBattle 三函数逐字复制（含同一固定 battleId），shared 版已存在未复用。
- **协议桩约 60/110 条**：`act13side`（含 `/act27side/*` 七条买卖全无）、`act25side`、`act29side`、`act35side`、`act36side`、`act38side`、`act45side`、`act46side`、`arcade`、`football`（selfScore 恒 99）、`typeAct`（38 条）、`teamQuest`、`trainingGround`、`interlockRefresh`、checkin 约 7 条、`act24side:500-506`、`act1vhalfidle:487-489`；其中 49 条所在文件无任何 `player.update`/`gainItem`。文档已标为协议桩，未误称可玩。
- 文档对照：`checkin` 索引无上限、`act24side` 战斗奖励、`act1vhalfidle` 招募扣票/战斗结算、prts-wiki §5.6-2/3/4/5/7 **均已修**（module-audit 相应条目过时）；`bossRush battleId 仅内存`、`milestone 商店空交易`、`act42side 奖励缺失`、`act25side 经营全缺`、`typeAct 全桩` **仍成立**。

### 3.3 会话服 arkhub / enemyDuel（长连接网关）

**P0（已复核）**

- `activities/arkhub/session/handlers/play.ts:405-468` — 对局奖励**完全信任客户端上报**：`battle_id` 由客户端给定并作为去重键（缺省 `"unknown"`），`winner` 自报，空/不可解析上报默认 `win=true`（442 行）；换个 battleKey 即再 +15 券。`handleEndCapture`（343-344）槽位越界回退全量且不校验是否在捕捉区；`arkhub/domain/dex.ts:327-334` `arkhubScanSucceed` 无条件 `grantSeal(+15)`，全链无每日/次数闸门。→ 服务端自持 battle/encounter 会话与状态机。
- `activities/arkhub/session/handlers/hub.ts:530-533,564-578` — 登录 uid 只取帧 field1、忽略 field2（协议文档载明 field2 = secret/token），注释自述「任意凭据均放行（私服）」；`arkhub/session/server.ts:252` 的 `server.listen(p)` **未指定 host（绑全网卡）**，`enemyDuel/session/server.ts:130` 默认 `host="0.0.0.0"` → 局域网内任何人可以任意 uid 进入会话并操作该存档（扣券/发奖/删画）。→ 绑 `127.0.0.1` + 校验 secret/单账号白名单。

**P1**

- `arkhub/session/server.ts:96-229` 无心跳强制/空闲回收/连接表（对比 `enemyDuel/session/server.ts:209-220` 有 `sweepTimer`+`idleMs=10s`）；`contract.ts:183` 的 `settledDuelBattles` 无上限增长。
- `arkhub/session/handlers/hub.ts:810,878,887-894` — `HUB_REWARD_MAP`（5012/5022 各 50 券）只用于日志，响应写死常量，两个 id 全仓无道具定义、无 `gainItem` → 客户端弹「获得奖励」而存档不变。→ 真实入账或删死表。
- `arkhub/session/handlers/shop.ts:513-526` + `domain/pixel.ts:175-188` — 网关删除像素只传 id，`deletePixel` 无 uid 校验（而 `listPixelsByUid` 按 uid 过滤、像素文档自述跨账号共享）→ 任意连接可删他人画作与文件。
- `player-data-manager.ts:237-241` + `arkhub/session/bindings.ts:92-103,178-181,273-283` — 落盘唯一触发点是 `player.delta` getter，而网关回调只 `player.update()` + catch 日志、从不读 delta → **会话内发券/状态仅在内存**，异常退出即丢（仅停机 flush）。
- `arkhub/capture/proxy.ts:206-235` — 每个 chunk 起一个未串行化的 `writeFile(flag:"a")`，且 `upBuf/downBuf` 驻留整条会话 → 追加序可能交错、长会话内存无界。
- `arkhub/session/codec.ts:149-166` — `readLengthDelimited` 用未校验 varint 推游标，`readUInt32BE` 不足即 RangeError（现无调用点）；入站只校验整帧 16..65536。对比 `enemyDuel/session/codec.ts:375-378` 的 `_require` 硬校验。
- `enemyDuel/routes.ts:274` + `session/game.ts:874-891` — `serverToken` 为明文 `${modeId}|${curStage}`，无签名/时效，客户端自报 teamId/modeId/stageId 即可加入/新建任意对局。
- `arkhub/session/handlers/shop.ts:423-446` + `domain/pixel.ts:149` — 上传 token 沿用客户端给的 `pixel_art_id`，若 id 已存在而 HTTP `savePixel` 另派新 id → 曾修复的「上传后加载不到」可回归。→ 以服务端分配 id 为准。

**P2**

- `arkhub/public.ts:13-28` 是 11 个文件的 `export *`（含 capture/proxy、session/server），R6 门面守卫被形式满足；`enemyDuel/public.ts:7-14` 才是精选具名导出。
- `arkhub/session/contract.ts:220` + `dispatch.ts:125` — 契约声明 `=> void` 却存在 async handler，dispatch 同步调用 → 浮动 Promise、可致 unhandledRejection。
- 端口避让 listen 逻辑三份近逐字复制（`arkhub/session/server.ts:233-268`、`enemyDuel/session/server.ts:183-237`、`arkhub/capture/proxy.ts:351-381`）→ 可抽公共 TCP 宿主。
- 死代码/桩：`arkhub/logic.ts:168-170`（report 忽略 body）、`logic.ts:181-188`（review 丢 body）、`domain/pixel.ts:69`、`domain/pixel.ts:268`（与 `@utils/multipart` 重复）、`enemyDuel/session/game.ts:566-571`（`pruneClosedSessions` 无调用 → 关闭会话永留内存）。
- `activities/shared/activity.schema.ts:408-410` — `activityStubSchema` 仅 `{activityId?}`，zod 默认剥离未知键 → enterHall/syncInfo/report 的请求字段被静默丢弃。
- `arkhub/routes.ts:61-62,76` vs `session/handlers/shop.ts:146-154` — 发布上限双计数器（`pixelPublished` vs `listPixelsByUid().length`），删画后网关放行而 HTTP 仍拒。
- 测试缺口：`tests/unit/modules/activities/arkhub/gateway/local.test.ts` 全部只断言协议应答形状，0 例覆盖非法帧长/空闲回收/未鉴权；`enemyDuel-session.test.ts` 无 sweep 回收用例。

### 3.4 角色养成 / 抽卡 / 商店 / 库存 / 桩模块

**P0**

- `gacha/logic.ts:417-445`（单抽同形 `:363-385`）— `switch(useTkt)` **无 `default`**，未知类型不产生任何 cost；`_verifyCost` 对空数组直接放行 → 传未列出的 `useTkt`（3/99 等）即 **0 成本十连**。（已复核）众数还缺 `LimitSingle` 分支。→ 补 `default` 抛 `BadRequestError`。
- `shop/routes.ts:844-846` + `shop/logic/misc.ts:367-469` — `buyGoodWithTicket` 的 `ticketId` 全由客户端提供；`kernel/inventory.ts:187` 对不在 ItemTable 的 id 返回 `canConsume=null`，`_useItem`（`:251-257`）WARN 后跳过 → **伪造 ticketId 即不扣凭证、礼包照发**。→ 由 goodId 反查凭证并校验。
- `shop/routes.ts:595-616` + `shop/logic/misc.ts:218-251` — 现金商店 `buyCashGood` 无支付/订单校验，直接发钻石（并按 `doubleCount` 首充翻倍）→ 直调接口白嫖充值。→ 只允许 pay 已支付订单路径发货。
- `sandbox/routes.ts:229-239`（另 `:1130/:1140/:1193` 重复注册 racing，后者为死路由；`sandbox.schema.ts:45` 的 `z.object({})` 把 `data/sandboxV2Data` 全部 strip）— 75 条路由中 **53 条 `sendStatus(202)`、`player.update` 0 次、`player.delta` 仅 1 处**；`battleStart/battleFinish/settleGame` 手拼空 delta 假成功，状态完全不落盘。module-audit「sandbox 协议桩」仍成立且更空。

**P1**

- `character/recruit.ts:127-135,270-283` — `normalGacha` 原样保存客户端 `tagList`；结算时 9h + 词条 11（高级资深）即锁 6★，**不校验词条是否在 slot 刷出的 5 个 tags 内** → 稳定白嫖六星。→ finish 前校验 `tagList ⊆ slot.tags`。
- `character/recruit.ts:112-117` — `buyRecruitSlot` 只写 `state=1`，不扣源石、不校验槽位上限（module-audit 该条仍成立）。
- `shop/logic/fes.ts:207-237` — `buyLMTGSGood` 是唯一缺 `_assertBuyCount` 的 `buy*`：`count<0` 时余额/限购断言双双早退，先把负数写进 `LMTGS.info.count`，随后 `gainItem.use()` 抛错 → **状态已提交**，可把限购计数刷负绕过限购。
- `character/troop.ts:29-32`（`quest/quest.schema.ts:17-22` 用 `z.json()`）— `squadFormation` 整段写入客户端 slots，不校验 squadId/干员归属与拥有/重复/槽位上限 → 可编入未拥有干员携入战斗。
- `character/char.ts:576-580` + `character/routes.ts:382-392` — `changeCharSkin/changeSkinSpState` 不校验皮肤归属/存在 → 白嫖皮肤、脏存档。
- `pay/routes.ts:513` — 金额校验仅在 `total_amount != null` 时执行（省略即绕过）；`:367-392` fake 模式 `markPaid(orderId)` 不校验 `order.uid`/状态 → 任意 orderId 可置 paid 后发货。（real 验签与 storeId↔goodId 校验已修，见 `:220-245,511-525`）

**P2**

- `character/recruit.ts:167-171` — finish 先写 `selectTags[].pick`，紧接着 `await this.cancel()`（`:102-108`）清空 `selectTags` → 划词结果死写，客户端不可见；`:204-213` boost 仍忽略 buy；`:309-316` 跨词条补偿算出即弃。
- `character/char.ts:466,479-481` — 干员不存在/非法潜能道具静默 return（`evolveChar` 已改为抛错）；`routes.ts:139-142` `boostPotential` 成功也恒 `result:1`，成败不可区分；`char.ts:1125-1151` 专精直升券不校验 `mainSkillLvl≥7`。
- `shop/routes.ts:944-947` `buyGPGoodWithTicket` 恒空 delta 不核销；`shop/logic/misc.ts:556-560` `checkForbidden` 恒 false（两条 module-audit 结论仍成立）。
- `templateShop/routes.ts:165-184` — `getGoodList` 每次都把商店币补足到「购全店总额」→ 购买等同免费、限购失效（注释称私服便利，但经济影响等同缺失）。
- `depot/routes.ts:99-107` `voucherGacha` 只回 delta；`multiplayer/routes.ts:109,129` battleId 硬编码 `abcdefgh-1234-…`（全部战斗同 ID），21 条路由全空 delta/固定桩。
- `rune/routes.ts:92-95` score/from/to 恒 0；`deepsea/routes.ts:88-92` 仅 placeId 计数、无奖励无消耗且全仓无消费者；`arkodc/routes.ts:143` battleId 固定、`:195-197` catch 吞异常无日志、`:407` `void player.delta` 后手拼 delta。
- `retro/routes.ts:74-79` act20side 固定 `level:"SS"`；`aprilFool` 只解析不落盘不发奖（`recvReward` 注释与代码不符）；`misc-alignment/routes.ts` 26 条全 stub、0 次 update；`batchEvent/routes.ts:19` `res.send({})`。
- `mail/routes.ts:44-50,67-73` — 先 `receiveAllMail`（`mail-manager.ts:121-129` 内 `saveDatabase` 标已领）再 `gainItem.handle()` 发放 → **两步非原子**，中途失败即邮件已消耗但奖励未到。
- `siracusaMap/routes.ts:42-46,76-80` — 6 端点只把客户端 id 写进 `siracusaMap.area`，`taskRingGainReward` 不发奖 → 奖励永久丢失。
- `gacha/routes.ts:267-270` 裸 `/gacha` 无 `validateBody` 且为空 delta 桩。

**文档对照**：已修（module-audit/prts-wiki 过时）——`evolveChar` 静默失败、公招已走 gainItem、pay notify 金额+real 验签/createOrder storeId↔goodId/并发双发货、`setStarFriendList` 空实现、retro 解锁不校验 coin、arkodc 直发 items、campaignV2 sweep/getBreakReward；仍成立——`buyRecruitSlot` 不扣源石、boost 忽略 buy、`buyGPGoodWithTicket` 空增量、`checkForbidden` 恒放行、sandbox 最空、rune score 恒 0、deepsea 计数器、arkodc battleId stub、misc-alignment 全桩。

### 3.5 用户 / 账号 / 社交 / 邮件 / 支付（补充批次）

**P0（已复核）**

- `user/routes.ts:186,195-196,218,228`（入口 `:1062` V1、`:1086` V2 multipart）— 杂志缩略图名 `${uid}_magazine_${leafId}.jpg` 直接 `join("./data/user/gallery", …)`，`leafId` 仅 `z.string().optional()`（`account/user.schema.ts:167`）且**无白名单/规范化** → `leafId="x/../../../../tmp/pwn"` 可越出目录写/删任意 `.jpg` 相对路径，写入内容（base64）完全可控；`mkdirSync/writeFileSync/unlinkSync` 还在请求线程同步执行。→ `leafId` 白名单 `^[A-Za-z0-9_-]+$` + `realpathSync` 前缀断言。

**P1**

- `pay/routes.ts:459-469,482-484` — `deliverOrder` 先入账、后置 `delivered` 并 `saveOrders`；catch 保留订单可重试（注释自承「部分发放已写入」）→ 重试双发。`shop/logic/misc.ts:449-467` 同型：先写限购再逐件发放，中途抛错即「已计限购但未发」。→ 状态与发放放同一事务/先标记后发放幂等化。
- `pay/routes.ts:371,386` + `pay/pay-store.ts:54` — `markPaid` 不校验 `order.uid`（fake 模式可把任意 orderId 标 paid）；`:269,316,356` 的 sign 恒为 `randomHex(32)`；`:287,336` createOrder 不校验 order.uid；`pay-store.ts:38-40` `loadOrders` 解析失败静默返回 `[]`，随后 `saveOrders` 覆盖 → **历史订单清零**。
- `user/routes.ts:1170-1182` — `/gallery/getCollectionRewards` 不校验是否持有 `collectionSets[setId].items`（对照 `:769-773` mainlineClue 有校验）→ 白领整套收集奖励。
- `user/routes.ts:423-425` — `useRenameCard` 先 `bindNickName` 再扣卡：扣卡失败（`kernel/inventory.ts:131-136` 抛 400）仍已改名，且绕过 `:387-408` 的 16 字/敏感词校验。
- `mail/mail-manager.ts:143-149` — `removeAllReceivedMail` 不检查 `receiveAt/hasItem/state`，传未领取 mailId 即删除含附件邮件（附件永久丢失）。
- `battle/battle.ts:1109-1117` — 助战方 `assistUid` 取自请求体 `battleInfo.assistFriend.uid`（无归属校验），且 `owner.update()` 未持对方账号锁（`game/app.ts:96` 仅锁当前 uid）→ 与对方本人请求并发时丢更新。
- `core/auth/auth.ts:516-537,545-590` — 改密/换绑仅在客户端「携带旧密码」时才校验，仅凭会话 token 即可改密并轮换 secret（账号接管）。→ 强制校验旧凭据。
- `social/routes.ts:126-131` + `social-manager.ts:319-326`（`social.schema.ts:63` 用 `z.array(z.json())`）— `assistCharList` 原样入库，无归属/条数上限；`routes.ts:99-107` + `social-manager.ts:145-158` `getFriendList` 可按 idList 读**任意 uid** 名片，无好友关系校验。
- `user/status.ts:166-171` `buyAp` 先扣次数后扣源石（源石不足时次数白扣）；`:182-188` `exchangeDiamondShard` 先发后扣。

**P2**

- `pay/routes.ts` 的 real 渠道形态：全仓只挂 `bodyParser.json()`（`game/app.ts:28`）、**无 `urlencoded`** → 真实渠道 form 回调 body 为空，real 模式实际不可用；验签为自造 `HMAC-SHA256(orderId|amount)`，非支付宝 RSA2/微信 v3。`docs/prts-wiki-实现评估-2026-09-09.md:519` 的 Round 12 三项修复代码均在，属「形式已修、收益有限」。
- `user/routes.ts:527-537` `bindBirthday` 无月/日范围校验；`user/cg-store.ts:42-56` `cgId` 不校验、列表无上限、每次全量同步读写。
- `checkin/checkin.ts:114-117` `monthlySubItem[..][1].items` 无防御；`mail/mail-manager.ts:10-14` 在模块导入期 `readFileSync`（`mails.json` 缺失会导致 mail 路由 import 失败）、`:167-172` 落盘无 tmp+rename（非原子）。
- 契约纪律复核（该批次范围）：**未发现**同响应两次读 `player.delta`，**未发现**漏 `await` 的异步调用（0 处）。`system/routes.ts:26` `/audit/*` 与 `core/auth/auth.ts:490-503` 属设计内桩。

### 3.6 building / home / 商务卡 / 载具 / 保险库 / vecbreak

**P0**

- `building/logic/trading.ts:326-337` + `logic/construction.ts:381-384` — `_settleOrderInternal` 对订单 delivery 只 `_applyBundles(...,-1)` **不做余量校验**（`_canAfford` 全模块只在 `construction.ts:101/294` 用），而 `_applyItemDelta` 自述「允许为负、不做任何钳制」→ 凭证 3003=0 也能交付、库存转负仍净得金币（`trading.ts:117`），`O_DIAMOND` 订单同理 → 无限刷金币/合成玉；`/deliveryOrder`、`/deliveryBatchOrder`、`/settleSale`、`/accelerateOrder` 全部命中。（已复核 `_applyItemDelta` 无钳制）
- `building/logic/meeting.ts:143-153,198-210` — `sendClue` 把线索从 ownStock splice 进**自己**的 receiveStock 并立刻 `socialPoint += 20`（`friendId` 不校验好友、不写对方存档；`sendClueAuto:167-181` 连好友参数都没有），`receiveClueToStock` 再搬回 ownStock 给 15/10/5 信用 → **send→receive 两请求净 +35 信用、可无限循环**。
- `building/routes.ts:396`（未挂 `validateBody`，schema 已在 `building/building.schema.ts:187-191`，**已于 §7 接线**）+ `logic/manufacture.ts:246-251` — `solutionCount` 无校验，传字符串 → `Math.max(0,Math.floor(NaN))=NaN` 写入 `remainSolutionCnt/processPoint/outputSolutionCnt`，再经 `_applyItemDelta` 把 `inventory[itemId]` 写成 **NaN** → 存档数值永久污染、房间停摆不可恢复。

**P1**

- `building/logic/chars.ts:344-376` — `assignChar` 直写 `roomSlots[id].charInstIds`：不校验槽存在（未知 id→500）、无位数上限/去重、不校验干员归属；`roomSpeedBonus`（`buff.ts:113-131`）按列表长度全量叠加 → 一个房间塞入全 roster 或重复 id 即加成线性爆炸。`usePresetQueue` 同缺槽位守卫。
- `building/logic/chars.ts:661-672,682-713,740-754` — 信赖无冷却：`_intimacyGain` 每次 +12，`gainIntimacy/gainAllIntimacy/gainAssistIntimacy` 可无限调用；`confirmPrivateDormIntimacy` 直接把 `favorPoint` 置 25570（无归属校验、无冷却）。
- `building/logic/manufacture.ts:164-169` vs `186-205` + `logic.ts:121-135` — 先 `_applyItemDelta(+gainCount)` 并 emit `ManufactureItem`，材料不足才回退库存；`_pendingGainEvents` 只登记正增量**不回收** → 零产出也推进制造任务/勋章（含 `ActivityCoinGain`）。
- `building/logic/accrue.ts:358-364` — 调度侧用 `capacity=base×(1+bonus)`（≈96）当产出速率算 `left/capacity`，而真实速率是 `1+speed`（≈1.78）：产出侧已在 `manufacture.ts:47-59` 修好这个 54× 错误，**调度侧漏修** → 倒计时提前约 54 倍结束，客户端反复 sync/收空产出（正是该文件注释要消灭的高频 sync）。
- `building/logic/manufacture.ts:267-307` — `changeDiySolution` 按客户端 solution 的家具 id 求和 comfort，**从不查 `draft.building.furniture` 持有量**；`slot_36` 硬编码、`rooms.MEETING[roomSlotId]` 无存在性守卫 → 凭空摆放任意家具换氛围/心情恢复/宿舍信用（路由 `building/routes.ts:415` 亦无 `validateBody`）。
- `kernel/player-status.ts:126-129,237-240` — `update` 在 `_activeDraft` 存在时**跨请求复用同一 draft**，而 `delta` getter 会清空 `_changes` 并发 `save`；building 的 recipe 内确有 `await`（`manufacture.ts:167`、`trading.ts:378`）→ 两个并发 POST 交错时，后到者的 delta/save 先落地、先到者 `finish()` 的补丁落到已清空的 `_changes`（串到下一响应或丢失）。→ 按玩家串行化；draft 复用应限定在同一请求内。

**P2**

- `building/logic.ts`（963 行）约 100 个一行委派（`335-337`、`643-649`…），参数类型字面量在 facade 与子模块重复（`logic.ts:643-647` vs `manufacture.ts:222-226`）→ 签名双改；`logic/accrue.ts`（932 行）混 6 类关注点（dailyRefresh/周切、劳动力、线索、招募、训练、心情/信赖、sync）→ 建议拆 `refresh/rooms/chars/sync`。
- `_applyItemDelta/_applyBundles/_applyGoldDelta`（`construction.ts:381-422`）与 `kernel/inventory.ts:153-165` 构成**同口径事件的第二套实现**：building 用 `_pendingGainEvents` 手动补发追踪事件，`_applyGoldDelta` 连补发都没有。这是「items 已全量迁移」结论之外的残留（见 §2.8）。
- 死代码/桩：`logic/misc.ts` `sendEmoji` 恒 `return args`、`getThumbnailUrl` 恒 `{list:[]}`；`construction.ts:637-641` `upgradeDiyLevel` 只改 `event.building`（handler 返回 202）→ 审计「预留」仍成立；`handler.ts` 10 处裸 `req.body as X;` 无副作用语句（151/225/257/510/521/532/543/673/684/695）。
- `home` 拆分核查**通过**：`routes.ts:131-137` 的 7 个模块均已真挂载 `/`，各 1–2 条路径、11 条路径零重复、无死文件；home 保留 4 文件/4 端点。`businessCard` 未知 flag 静默成功且会**无条件推进 EditBusinessCard 任务**（`flag switch default:break` + 无条件 emit）。
- `car/routes.ts:20` 用 `z.json()` 直写 `draft.car.battleCar`（无形状/大小约束）；`templateTrap/routes.ts:29` 不校验 `domains[id]` 存在（→500）与陷阱是否持有；`char/routes.ts:20` `chrIdDict` 取值无域（可写 `starMark=999`）。
- `reslock` 是本组唯一校验完备的模块（`reslock.schema.ts:16-29` 正整数、`reslock.ts:96-137` 余额+资格校验），仅使用 `draft.inventory` 直改（同 §2.8 缺口）。
- `vecbreak/routes.ts:154-195` — `defendBattleFinish` 不调 `battle.finish`、不读 `body.data`（无战果校验即发里程碑点数），依赖内存 Map `vecBreakBattleCtxs`（重启丢失）；且 315 行业务逻辑写在 `routes.ts` 里，偏离薄壳约定。
- 负结论（避免误报）：**未发现递归/循环 buff**；`special.ts`/`buffs/*` 只读原始字段，`roomSpeedBonus` 不回入 `controlGlobalBonus`。
- `accrue.ts:214-218` 劳动力恢复 `floor(elapsed/rate)` 后直接置 `lastUpdateTime=ts`，丢弃余数秒 → 恢复偏慢。

### 3.7 roguelike 数据层 / 子模块 / 测试质量

**P1**

- `roguelike/data/blackstream-data.ts:1-2` — 头部声明 `GENERATED by scripts/_extract-blackstream.ts`，但该脚本**不存在**（`scripts/` 只有 `extract-lua-*`；`grid_zone.ts:134-136` 亦自认「抽取脚本（已不存在）」），数据实际来自第三方 wiki「路标档案馆」。22k 行是不可再生快照，`pnpm run update` 不覆盖，AGENTS.md 未登记为生成物，也没有 `*.meta.json` 溯源。→ 补回生成脚本或至少落 meta + 新鲜度门禁。
- `roguelike/modules/copper.ts:116-128` — `redraw()` 先把 `isDrawn` 清零再对**同一批 key** 重新置 1 并原样返回，袋子零变化，却已在 `:110-114` 扣金币且 `redrawFreezeCnt += 1` → 付费重抽无效果（配合 `tests/unit/modules/rlv2/rlv2-modules.test.ts:248-259` 只断言「长度 3」的用例，缺陷被测试放过）。
- `roguelike/modules/copper.ts:53-54,76` — 只取 `copperDrawFreezeCostCount?.[0]`，而官方 `moduleConsts` 为 `[1,5]`；`redrawFreeze=3`、开局抽 3 枚均为手写魔数 → 重抽费用不递增、抽牌张数与 1..6 规则偏离。
- `roguelike/modules/grid_zone.ts:143-148` — `distanceColumnForLayer` 永不返回 4，而距离规则表有 6 列（列 4 =「IV 追忆」）→ 整列死数据、层 V 的 `险路尽头` 在该列 `null` 永不入选。
- `roguelike/modules/grid_zone.ts:637-642,670-693` — 层类型过滤用中文标签表，表里只有 `命运所指`，而数据标签是 `命运所指（二结局）` → `PROPHECY` 永不进候选集，`blackstream-data.ts:28` 的数量规则成死条目；标签→节点映射现有三份并行表（`:108-131`、`:138-140`、`:670-693`）。
- `roguelike/logic.ts:593-601` — 骰子奖励硬编码 `rogue_2_gold` 3/5/2，`detail` 取完即 `void detail;`；官方 `diceRuleGroups` 全仓无消费者。`logic.ts:616-627` + `modules/dice.ts:12-13` 的 `rollDice` 点数与事件各自独立随机（无映射），`count` 只写不消费、`upgradeDiceId` 未使用 → 骰子点数与结果无关、数量无上限。
- `roguelike/modules/wrath_sky.ts:56-83` + `modules/weather.ts:58-72` — SKY 恒 `zones:{}`、WEATHER 进层恒清空，而官方 `sky/wrath/weather` 数据齐备（3904B/12670B/10269B）→ rogue_5/6 两大机制纯桩。
- `roguelike/module.ts:218-229` — rogue_5 兜底只覆盖 copper/wrath/sky，官方 `moduleTypes` 含 **CANDLE** 且有数据，但 `rlv2-module-composition.ts:83-98` 无 `CANDLE` 工厂也无兜底 → 客户端收不到 `module.candle`。
- **测试质量**：`tests/unit/modules/rlv2/rlv2-gridzone-smoke.test.ts:149-167` 用例名承诺「距离规则校验」，断言只 `toBeGreaterThanOrEqual(1)` 且 `undefined` 直接 `continue`（恒真）；`rlv2-modules.test.ts:248-259,196-206,301-306` 把空桩固化为期望 `{zones:{}}`（后续补实现必红）；`rlv2-strict-diff.test.ts:140,186` 的白名单 `d.startsWith("outer.rogue_6.")` 恒不匹配且只比类型/键集不比标量值；49 个测试文件中 45 个内联 `vi.mock("@excel/excel")`、40 个逐字重复同一套 excel 样板，而 `tests/helpers/mockExcel.ts` 在该目录 **0 次**使用。

**P2**

- `app/ops/admin/admin-service.ts:22-23,94,2907` 深路径 import `@game/modules/roguelike/logic`、`data/blackstream-data`，而 roguelike **没有 `public.ts`** → 违反「模块外只经 public.ts」（守卫的 R3 只判 src 在 modules 的情况，ops→modules 未覆盖）。
- 零引用导出：`theme-rules.ts:172,178` `ROGUE6_VOCAL_OUTBUFF/ROGUE6_PALM_OUTBUFF`、`models.ts:224,231` `RoguelikeStubRequest/Response`、`trigger.ts:8` 空实现 `registerRlv2Triggers`、`index.ts` barrel 无任何 import。
- 概率魔数无数据源：`grid_zone.ts:439`（0.6/0.4）、`grid-nav.ts:488,530`、`modules/disaster.ts:29`。
- `roguelike/routes.ts:6` `getPlayerOptional` 未使用导入 + `req.body as X` 无效丢弃语句；6 端点均为 `result:0/items:[]` 桩（同 §3.1）。

### 3.8 battle / quest / mission / medal / campaignV2 / crisis / tower / storyreview / equipmentMission / dungeon / explore

**P0**

- `tower/tower-reward.ts:337-341` + `tower/routes.ts:683-686,728-731,749,767,816` — claim 内 `draft.inventory[lowId/highId] += low/high` 直写，路由又把同一 `granted` 走 `gainItem.add→handle()` → **首通/层奖励/扫荡双倍入库**；封顶按加前库存算可越过 `lowerItemLimit=60`（单测 mock 掩盖）。（与 §2.8 同根）
- `mission/logic.ts:691-735` — `_confirmActivityTableMission` 不看 progress/state 即发 rewards，`if (data) data.confirmed=1`(719) 只对已播种条目落标记；存档 ACTIVITY 桶 0 条而 `ActivityTable` 有 489 条 missionData → **任意活动任务 id 可无限重复领奖** → 未播种即拒绝、confirmed 先落库再发奖。
- `crisis/routes.ts:1446-1447,1458-1461` — `recalRune/battleFinish` 空 body 即 emit `RecalRuneStageScoreSome/CrisisTaskSome`，且硬编码空 `playerDataDelta` → 单请求推进全部 24 枚 `CrisisTaskSome`（`medal/medal.ts:2157-2160` + `360-363` 载荷缺 `seasonId/taskId` 不过滤，12 枚目标=1 直接解锁），勋章增量不下发、`_changes` 泄漏。
- `kernel/fresh-player.ts:200-204` — 新账号/reset 后 `MAIN 94 / SUB 274 / GUIDE 72 / RETRO 34` 条任务**永不播种**（现网 `1.json` 的 MAIN82/SUB262 是官服导入残留，RETRO=0）→ 任务板不可见、`getMissionById` 恒 undefined。

**P1**

- `quest/routes.ts:214-222` — `getMainlineRecordRewards` 恒 `items:[]`，未读 `ZoneTable.zoneRecordRewardData(4 区)/zoneRecordGroupedData[].rewards[].recordReward`（`types_excel_gen.ts:15225-15226` 有数据）→ main_10–13 密录奖励不可领。module-audit 附注「recordRewardData 为 null」**已过时**（只看漏了 `stage_table.recordRewardData=0`）。
- `quest/routes.ts:177-192,260-272` — 六星只写 `tagSelected/sixStarReward` 标志，全仓无写 `sixStar.groups[].state/tagFinish` 的代码，`StageTable.sixStarRuneData`（180 条）零引用 → 里程碑永不 UNLOCK/FINISH。
- `mission/templates/stage.ts:79,121` — `StageWithEnemyKill["0"]/["3"]` 为 `update:()=>{}` → 48 条 DAILY（含当前周期组 `daily_7006/7007`）与 `weekly_707` 恒不推进、链后卡死。
- `battle.ts:1058-1064` + `templates/char.ts:69-79` — `GainIntimacy` 载荷 `count=出战干员数`，语义却是「基建内互动 N 次」→ 一场满编战斗完成日常。
- `battle.ts:896-908` + `templates/char.ts:299-322` — `CharIntimacy` 无 charId 去重 → 同一干员可刷满「信任 N 名干员达 X%」；`battle.ts:899` 信赖 `+=` 无 `maxFavor(25570)` 封顶，`templates/char.ts:312-319` `favorFrames.find(...)!` 无非空保护 → 溢出末帧时 TypeError，该账号 `battleFinish` 永久 500。
- `battle.ts:715-721` vs `724-731` — 演习早退前已 emit `CompleteStageAnyType/CompleteStage` → 0 AP 演习计入通关任务。
- `tower/routes.ts:718-726` — `layerReward` 信任 `body.layers` 不校验 `pass===1` → 未通关层白拿（叠加双倍问题）；`:398` 仅 `completeState===1` 判失败，`0/undefined` 也算通关；`:457-462` 固定桩、`tower-reward.ts:369-396` `TowerCardSquad*` 未覆盖 → 赛季任务永不完成；`:296-298,173-175` 未判 char/未知 tower → 500。
- `equipmentMission.ts:504-506`（及 `327-329,531,544,560,572,585,600`）缺统计即 `set:target` 置满 → 一场通关完成「累计伤害/击杀」；`:259-265` 用全队 `HP_ZERO` 当逐干员击杀。
- `crisis/routes.ts:845-857,1347-1354,869-963` — `buyGoods` 只 `recordPurchase`，**无 coin 扣减/余额校验**；`challengeReward*` `items` 恒 `[]` 且全模块 `gainItem=0` → 商店/奖励空转。`:745-812/1200-1214` 不读战报不校验通关；V2 永不写 `permanent.reward`。`crisis.schema.ts:34-37,99-102` count 无 int/positive + `purchase-record.ts:27-28` 的 `+=` → 负值回退、任意 goodId 无限 push；`routes.ts:825,1299-1306,1349` 直接解引用 `shop.info` → 导入存档 500。
- `storyreview-manager.ts:65-79,92-116` — 只判 `group.rts`/去重，不验已读与试炼达成 → 免前置领奖。
- `explore/routes.ts:48-130` — 8 端点仅写标志，无奖励/流程/前置。
- `campaignV2/routes.ts:122-125` + `accrue.ts:59-74` — `emptyResponse` 在 `update` 外把活对象交给 `ensureCampaignsV2State`（写总上限/周重置）→ **只读路径改存档**、绕过两阶段补丁。

**P2**

- `mission/routes.ts:79-81,99-101,106-108` 空 `catch{}` 吞错（我的全仓扫描未命中是因为它们跨行）；`logic.ts:332-337` 吞模板 init 异常降级 `target=1`。
- `mission/logic.ts:39-82,944-979` — 233 硬编码链头白名单与数据化 `_isChainHead` 双真相源；后继靠 `parseInt+1` 猜（`sub_9 pre=sub_7` 非连续）。
- `mission/templates/stage.ts:216,275` 与 `kernel/util/stage-unlock.ts:27` 重复 `#f#`；`stage.ts:580/602/704/731` `includes` 子串过宽。
**medal 专项（补充批次，行号已复核）**

- **[P0]** `medal/medal.ts:443` 的订阅名取自 excel 模板；与全仓 emit 取差集，**170 个模板中 118 个无任何 emit 点**（252 枚勋章；`CharStoryUnlock` 的 387 枚由 `troop.ts:163` 直写已剔除）→ `val` 恒 0、`fts` 永不设、奖励不可得（`CampaignsDiamondLimit:545`、`PermUpgrade:1031`、`GainSixStarGroupPoint:3312`、`UnlockStoryGroup:2800`）。→ 加「模板名 ⊆ 已 emit ∪ 直写白名单」守卫。
- **[P0]** `activities/shared/unlockActivity.ts:216` 播种 `target` 用 `parseInt(unlockParam[0])||1`，而 `param[0]` 常是赛季/活动 id（如 `medal_activity_1crisisv2_04="crisis_v2_season_1_1"`）→ 种子 `target=1`；`medal.ts:409-417` 只在持久 `val[1]` 为 null/非有限数时才回写真实 target，1 被保留 → `medal.ts:110-117` 判定 `progress[0]>=progress[1]`，**1 次事件即完成领奖**（真实 target 如 `medal.ts:1695` =8）。→ init 无条件用模板 target 覆盖，完成判定收敛到 `isMedalDone()`。
- **[P1]** `medal.ts:392-399` 未实现模板降级为 `val=[[0,0]]`，`0>=0` 在 `:116` 视为已完成 + `:3767-3937` 手写转发表漏登记即零成本领奖（当前 170 全覆盖，属潜伏）。→ 降级改 `[[0, MAX_SAFE_INTEGER]]`，转发表由 prototype 自动生成。
- **[P1]** `medal/medal.ts`（3938 行 = 170 模板方法，`456-3701` 共 3246 行含 1107 行 JSDoc；`3702-3732` 序列化；`3767-3937` 纯转发表 ≈4.4%）——**86 处「占位实现」**、**71 处以 `registerTs` 天数冒充进度**（如 `:772 Sbv2UpgradeBase`）；`Sbv2*` emit=0 → 永久 0，带 `registerTs` 者按天虚假完成。静态表在 `data/excel/medal_table.json`（1626 枚/170 模板），文件内无死模板方法。→ 可拆 `templates/{battle,crisis,roguelike,sandbox,activity}.ts` + 自动转发表。
- **[P2]** 完成判定三处重复（`medal.ts:114-116/191-193/418,430`）；目标语义双实现（各模板 `init` vs `unlockActivity.ts:200-216`，注释自认需同步）；零引用：`medal.ts:449 update()`、`:81 setCustomData`、`:225 toJSON`。
- **契约纪律（medal 侧无缺陷）**：无 `res.send`/`try-catch`，两条路由均 `validateBody`，delta 只读一次，60 个模板 emit 点 0 个未 `await`。

**其余 P2**
- `quest/routes.ts:154-164` `battleContinue` 固定 `result:1`+全零 UUID；`:195-211` `getCowLevelReward` 标记已领却不发物；`:235-239` `unlockStageFog` 全 no-op（`PlayerDungeon` 无 fog 字段）。
- `dungeon/dungeon.ts:14-38` 全关卡默认 `state=3`，但 `stage:update` **全仓无生产者**（仅 `events/core.ts:41` 声明 + `dungeon.ts:11` 订阅）→ 当前不可达的「死代码地雷」：一旦有人补上 emit，全关卡瞬间三星。
- `battle.ts:585-606,733` `markSettled` 失败仅 warn → 并发/落库失败仍可重复结算；`battle-info-store.ts:96` 自认 isCheat 不校验。
- `campaignV2/routes.ts:181-183` 与 `battle.ts:1026-1041` `accrueCampaignKills` 重复实现。

**该组已核实无问题**：12 模块 76 条 POST 全部带 `validateBody`（脚本全量 0 缺失）；无 `player.delta` 同请求双读；无漏 `await` 的 `update/gainItem.handle/emit`。



## 4. 模块成熟度速览（2026-09-14 修订）

> 口径：只读代码 + 本次发现。等级 = 可玩 / 可玩但不可信 / 部分 / 桩。测试列只统计有专属测试的目录，实际用例可更多。

| 模块族 | 规模 | 测试 | 等级 | 一句话结论 |
|---|---|---|---|---|
| roguelike / rlv2 | 36.9k | 49 文件 /13.6k 行 | 可玩但不可信 | 主链路真实且抓包校准过，但战令领奖/直购无门槛、落盘丢字段、DICE/COPPER/WEATHER/WRATH/SKY/CANDLE 半桩；黑流 22k 行数据快照的生成脚本已丢失 |
| activities（act* 族） | ~21k | 9 文件 | 部分 | 约 60/110 端点仅防 404；milestone/checkin/bossRush/act24side/act1vhalfidle/act44side 有真实状态机但发奖路径不闭环 |
| arkhub | 6.8k | activities 下 | 原型 | 长连接栈可用但无鉴权、无空闲回收、奖励只信客户端、会话状态不落盘 |
| enemyDuel | 3.6k | 1 文件 | 可玩但不可信 | 有 sweep/codec 硬校验，但 serverToken 无签名、battleId 为随机 stub、结算直接用客户端 rankList |
| building | 9.2k | 13 文件（manager） | 可玩但不可信 | 时间结算/配方/buff 引擎成熟；交付/线索/信赖/家具/在位数五条路径可被参数放大，16 条 POST 逃过契约守卫，NaN 可污染存档 |
| battle / quest | 2.2k | battle/quest 测试 | 可玩但不可信 | 结算/掉落/解锁/回放完整；六星里程碑与密录奖励未落地、演习计入通关任务、`battleContinue`/牛关/fog 为桩 |
| mission | 4.5k | 4 文件 | 部分 | 日/周/链式框架完整；活动任务免校验无限领奖、48 条 DAILY 空模板卡链、新账号 474 条任务不播种 |
| medal | 3.9k | medal 测试 | 部分（占位重） | 170 模板中 118 个无事件源（奖励不可得）、target 播种=1 导致提前完成、86 处占位 + 71 处按 `registerTs` 天数假完成 |
| campaignV2 / crisis / tower | 0.8k / 2.2k / 1.5k | 有 | 部分 | campaignV2 剿灭已落地但只读路径改存档；crisis 商店/奖励空转、空 body 可解锁勋章；tower 双通道发奖、层奖励不校验 pass |
| character / gacha / shop / depot / templateShop | ~8k | 有 | 可玩但不可信 | 实现扎实（保底纯函数、策略表分派），但 `useTkt` 无 default 可 0 成本、伪造 `ticketId`、公招词条越权、`templateShop` 自动补币 |
| user / account / social / pay / mail / system | ~7k | 有 | 部分 | 相册 `leafId` 路径穿越、pay 发货非原子且 real 渠道不可用、改密仅凭 token、邮件两步非原子、social 可读任意 uid 卡 |
| home / businessCard / car / char / troop / story / batchEvent / firework / templateTrap | 薄壳 | 部分 | 部分 | URL 域拆分干净、真挂载，但 `z.json()` 直写、未知 flag 静默推进任务、未知 id 500 |
| reslock | 0.4k | 1 文件 | 可玩 | 本报告唯一校验完备的模块（正整数 + 余额 + 资格），仅用 `draft.inventory` 直改（§2.8） |
| sandbox | 2.3k | 无 | 桩 | 75 条路由中 53 条 `202`、`player.update` 0 次、假 delta 不落盘 |
| deepsea / rune / retro / aprilFool / arkodc / multiplayer / siracusaMap / interlock / explore / misc-alignment | 小 | 少/无 | 桩 | 计数器式或空 delta；multiplayer 全部战斗共用硬编码 battleId；misc-alignment 26 条全 stub |

---

## 5. 修复优先级建议

### 批次 1 — 数据安全（先做，改动小、收益不可逆）

- `building/routes.ts:396` 立刻挂 `validateBody(B.changeManufactureSolutionSchema)`，manager 内补 `Number.isInteger` 兜底；`_applyItemDelta`（`construction.ts:381-384`）加「负增量不得使库存为负」的门控，交付类入口统一过 `_canAffordCosts`。
- `roguelike/status.ts:160-171` `toJSON()` 补 `runResult / innerMission / nodeMission / zoneReward / traderReturn`。
- `user/routes.ts:195-218,228` `leafId` 白名单 `^[A-Za-z0-9_-]+$` + `realpathSync` 前缀断言（读侧 `:938-943` 已用 `basename()`，写/删侧对齐即可）。
- `pay/pay-store.ts:38-40` `loadOrders` 解析失败不得静默返回 `[]` 后覆盖（改为保留原文件/备份并报错）。

### 批次 2 — 发奖闭环与扣费校验

- `milestone/logic.ts:456-477` 取 excel 商品 cost/item，先扣币再发奖，失败不写购买记录；`:383-404` 与 `shared/shared.ts:184-207` 两处兜底分支补幂等（读已领标记）。
- `kernel/inventory.ts:543` 实现 `CHARM` 处理器（`draft.charm.charms[id] += count`），修补 `charm/routes.ts:193-206` 的首通奖励。
- `gacha/logic.ts:417-445`（及单抽）补 `switch` 的 `default`（抛 `BadRequestError`）与 `LimitSingle` 分支；`shop/routes.ts:844` 由 goodId 反查凭证并校验；`shop/routes.ts:595` `buyCashGood` 只允许 `pay` 已支付订单调用。
- `character/recruit.ts:270-283` finish 前校验 `tagList ⊆ slot.tags`；`:112-117` `buyRecruitSlot` 扣源石并限制上限。
- `mail/routes.ts:44-73` 与 `pay/routes.ts:459-484` 的发货/标记改为幂等（先标记后发放或事务），避免「已消耗未发放 / 重试双发」。

### 批次 3 — 守卫扩容与会话安全

- schema-first 守卫 `ROUTER_FACE` 扩到 `handler.ts`；接线 building 的 15 个孤儿 schema（§2.1）。
- file-size 守卫改为扫 `modules/**/*.ts` + 数据文件白名单（§2.2）。
- `items-pipeline-scan` 扩到 `draft.inventory[...]=` / `draft.status.gold` 形态（§2.8），并把 building 的 `_apply*` 收敛进管道。
- `arkhub/session/server.ts:252` 绑 `127.0.0.1`、登录校验 field2 secret；照搬 `enemyDuel` 的 `sweepTimer`/连接表（`session/server.ts:209-220`）；网关发奖回调末尾显式 flush（§3.3）。
- 删除 4 个死挂载（§2.3）；对 `/rlv2/finishGame` 明确「补齐」或「以 gameSettle 替代」并写进文档（§2.4）。

### 批次 4 — 清理与文档

- 删除死代码：`account/user.model.ts`（0 字节）、`roguelike/status.ts:147-158` `bankPut`、`arkhub/domain/pixel.ts:69,268`、`enemyDuel/session/game.ts:566-571`、`building/routes.ts` 10 处裸 `req.body as X;`。
- 未使用 schema/导入清理（building 15 个孤儿 schema 随批次 3 消除）。
- 刷新 4 份漂移文档（§2.7），并把本次结论回写 `AGENTS.md` 的「物品管道已全量迁移」措辞（改为「无直发事件」）。

### 批次 5 — 回归测试（按 AGENTS 的测试性能不变量，并入既有文件，不新建）

- 针对本次 P0 各加 1–2 条最小用例：milestone 兑换发奖、`useTkt` 非法值、`leafId` 穿越、`status.toJSON` 字段完整性、交付负库存。优先并入 `tests/unit/modules/activities/milestone-exchange.test.ts`（当前 3 条用例只断言购买记录，正好漏掉 P0）、`tests/unit/modules/gacha/*`、`tests/unit/modules/rl/roguelike/*`。

---

## 6. 形式/规范层建议（非缺陷，纯一致性收益）

> 与前面章节的区别：这里不涉及行为正确性，只针对「同一种东西有几种写法」。每条给**实测证据**、建议与代价。优先级按「收益/代价」排，**不建议专门开一批重构 PR**，而是随下一次触碰该文件顺手改（低成本、零行为风险）。

| # | 现象 | 实测证据 | 建议 | 代价 |
|---|---|---|---|---|
| 6.1 ✅已执行 | **路由载体三套命名** | `routes.ts` 39 个、`router.ts` 24 个（activities 族，AGENTS 已承认）、`handler.ts` 5 个（building/gacha/mission/shop/roguelike，无法定地位） | 统一 `routes.ts`；逻辑搬 `logic.ts`/`manager.ts`。AGENTS 要么把 `handler.ts` 写进约定，要么把它列为待迁移存量 | 改名会动挂载表 `routes.ts` 与 import；建议与其职责拆分一起做。**注意 `handler.ts` 正是 schema-first 守卫漏扫面（§2.1）**，统一命名顺带消除该盲区 |
| 6.2 ✅已执行 | **schema 文件双命名** | 原名 `schemas.ts` 5 个（building/gacha/mission/roguelike/shop）vs `*.schema.ts` 41 个；account/character/mail 各有 2 个 `*.schema.ts` | 统一 `*.schema.ts`（与 AGENTS 一致），单模块允许按域拆多个 | 纯 rename + import 路径，最低成本，可单独做 |
| 6.3 ✅已执行 | **Manager 文件名风格混用** | PascalCase 9 个：`AccountManager/SocialManager/SocialService/MailManager/HomeManager/RetroManager/CharRotationManager/StoryreviewManager/AprilFoolManager`；其余为 kebab（`logic.ts`/`char.ts`/`battle.ts`） | AGENTS 只约束目录、未约束文件名 → 明确「文件名 kebab-case，类名 PascalCase」，现有 9 个登记为例外或顺手改 | 改名影响面小但会动大量 import；建议登记例外而非批量改 |
| 6.4 | **`public.ts` 门面覆盖不足，且 R3 不覆盖 ops→modules** | 仅 10/50 模块有 `public.ts`；`app/ops/admin/admin-service.ts:22-23,94,2907` 深路径 import roguelike 内部（roguelike 无 `public.ts`） | 把 `module-boundary` 的 R3 从「src 在 modules」扩到「任何 src 引用 modules 内部」（含 ops/scripts/tests），存量进白名单后只减不增；被外部引用的模块补 `public.ts` | 扩守卫会立刻红出存量（需一次性裁决），属守卫工作而非重构 |
| 6.5 | **未使用导入无任何门禁** | `tsconfig.json` 只开 `strict`，无 `noUnusedLocals`；`tests/unit/architecture/**` 与 `scripts/lib` 无对应扫描器（历史审查称 ~4,000 个未用导入绑定） | 新写 `scripts/lib/unused-import-scan.ts` + 棘轮基线（与 `items:direct`/`type:debt` 同型；**必须走 `helpers/fs-scan` 缓存**，否则每次全树读盘） | 中。不要直接开 `noUnusedLocals`——会同时爆掉生成类型 re-export，且几千条一次性修复不现实 |
| 6.6 | **118 处裸 `req.body as X;` 无副作用语句** | 脚本统计 118 处，如 `account/routes.ts:62`、`activities/act13side/routes.ts:137`、`building/routes.ts` 10 处 | 类型已由 `validateBody` 契约层收敛，这些语句是纯噪音 → 删除；后续若需要类型，改为 `const body = req.body as X` | 低，纯机械；可用 codemod |
| 6.7 | **233 处内联「修复（日期）」历史叙事** | modules 内 `修复（2026-…）` 233 处，含长篇历史说明（如 `building/logic/construction.ts:373-392` 的 ⚠️ 已知缺口段） | 代码注释只留「为什么/不变量」，历史过程交给 commit message 与 docs；已知缺口用统一 `// TODO(known-gap)` 或 `docs/known-gaps.md` 单点登记，便于 grep 与门禁 | 低（改写量中等，但可只在新触碰的代码里执行） |
| 6.8 | **别名与深相对路径混用** | modules 内 `../../..` 深相对 import 391 处 vs `@game/@excel/@core/...` 别名 505 处 | 明确规则：跨模块/跨层用别名，模块内用相对；写进 AGENTS | 低（新代码遵守即可；批量改写风险大于收益） |
| 6.9 | **JSDoc 覆盖不均** | 1440 个 `export` 声明中 185 个（13%）无前置注释（样本 `account/account-manager.ts:111`、`activities/act1vhalfidle/logic.ts:226`）；另一端 `medal.ts` 3938 行里 1107 行是 JSDoc | AGENTS 已有「JSDoc on all classes/methods」但无守卫且难落地 → 加轻量守卫，只查 `export class` 与路由 handler；同时避免「注释比代码长」的另一极端 | 低（守卫） / 中（补注释） |
| 6.10 | **测试两套镜像布局并存** | `tests/unit/modules/**`（74）与 `tests/unit/{manager,router}/**`（98）；同模块测试可能落在任一处（battle/medal 在 manager 与 router 各有文件） | AGENTS 已写「`tests/unit/**` mirrors `app/`」但存量未迁完 → 规则：新测试一律 `tests/unit/modules/<mod>/`，旧文件触碰时迁移，或明确标注 manager/router 为 legacy | 低（规则），中（迁移） |
| 6.11 | **占位文件与过期约定残渣** | `account/user.model.ts` 0 字节；5 个 `trigger.ts`（9–26 行）是空占位，`gacha/trigger.ts:4` 自述「按五文件约定占位」——而「五文件约定」在 AGENTS 中已无出处 | 删除零字节文件；`trigger.ts` 要么并入 manager，要么删掉 | 极低 |
| 6.12 | **文档用行号定位，易腐** | `docs/重复实现审查-整合清单.md`、`docs/代码冗余审查-2026-09-10.md` 的 `L1339/L1890-1906` 等随 2026-09-13 重构**全部失效**；本报告同样会腐 | 文档引用改为「符号名 + 文件名」（如 `building#_settleOrderInternal`），行号仅作参考并标「截至 commit」；review 类文档加日期与修订头 | 低 |

**一句话**：形式层的收益不在「好看」，而在于**消除守卫盲区**——6.1（handler.ts 命名）与 6.4（public.ts + R3 口径）直接对应 §2.1 与 §3.7 的真实漏检，这两条值得优先。

---

## 7. 整改记录：统一命名风格（2026-09-14 已执行）

> 承接 §6.1–6.3。全部为**机械改名 + 引用重写**，无业务逻辑改写（唯一的行为变化见 7.4，是守卫收紧的必然结果）。

### 7.1 规则（已写入 `AGENTS.md` → Conventions）

| 维度 | 唯一约定 | 不再使用 |
|---|---|---|
| 路由载体 | `routes.ts`（模块/活动族主路由）、`<域>.routes.ts`（同一模块的第二个路由文件） | `router.ts`、`handler.ts` |
| 请求契约 | `*.schema.ts`（如 `building.schema.ts`、`rlv2.schema.ts`） | `schemas.ts` |
| 其余文件名 | kebab-case（类名仍 PascalCase：`account-manager.ts` → `class AccountManager`） | `AccountManager.ts` 等 |

### 7.2 改名清单（49 个文件）

- **schema ×5**：`building/gacha/mission/shop/schemas.ts` → `<module>.schema.ts`；`roguelike/schemas.ts` → `roguelike/rlv2.schema.ts`（该模块已有 v1 的 `roguelike.schema.ts`，rlv2 契约独立命名）。
- **Manager ×9**：`AccountManager`、`SocialManager`、`SocialService`、`MailManager`、`HomeManager`、`RetroManager`、`CharRotationManager`、`StoryreviewManager`、`AprilFoolManager` → kebab-case。
- **路由载体 ×30**：`building/gacha/mission/shop/handler.ts` → `routes.ts`；`roguelike/handler.ts` → `rlv2.routes.ts`（同目录已有 v1 `routes.ts`）；`system/plugin-heartbeat.ts` → `plugin.routes.ts`；`activities/*/router.ts` ×24 → `routes.ts`。
- **kernel/ops ×5**：`kernel/PlayerDataManager.ts` → `player-data-manager.ts`、`kernel/PlayerStatus.ts` → `player-status.ts`、`ops/admin/AdminService.ts` → `admin-service.ts`、`ops/plugin/PluginConfigService.ts` → `plugin-config-service.ts`、`ops/admin/schemas.ts` → `admin.schema.ts`。

### 7.3 引用重写与守卫同步

- **说明符重写 345 处**（`from`/`import()`/挂载表 `module:` 133 处 + kernel/ops 160 处 + `vi.mock` 等裸字符串 52 处），按别名/相对两种风格各自保持原样重写，覆盖 `app`/`tests`/`scripts`/`index.ts`。
- **守卫收紧**：`module-boundary.test.ts` R4 约定收敛为 `routes.ts` / `*.routes.ts`（原 `router/handler` 不再接受），并删除 `plugin-heartbeat` 的 R4 豁免；`file-size-guard.test.ts` 的规模上限由 `router.ts/handler.ts` 改为 `routes.ts`，**顺带覆盖了此前不受约束的 `crisis/user/sandbox/routes.ts`（§2.2 的一半）**；`schema-first-guard.test.ts` 的 `ROUTER_FACE` 随之扩面。
- **基线重映射**：`excel-singleton-baseline.json`、`type-debt-baseline.json`、`type-escape-baseline.json` 中的旧路径键同步改名（棘轮口径不变）。
- **注释/文档**：模块 `index.ts` 头部的「五文件约定」表述与 `trigger.ts` 占位注释改为指向 AGENTS 的新命名节；`AGENTS.md` 架构段与 Conventions 增补命名规则。

### 7.4 顺带修复（守卫收紧的必然结果）

路由载体统一后，`building` 与 `gacha` 的路由文件自动进入 schema-first 扫描面，暴露的 17 条未校验 POST **已一并接线**：

- `building/routes.ts` 16 条：15 条挂上 `building.schema.ts` 里原本就存在却未使用的 schema；`/getMessageBoardContent` 新增 `getMessageBoardContentSchema`（`{ uid?, friendId? }`，按 `models.ts` 的请求形状）。
- `gacha/routes.ts` 的裸 `POST /`：新增 `gachaSessionStateSchema = z.object({})`。
- 这正是 §2.1、§0.2#9 的修复；§3.6 中「`solutionCount` 未校验导致 NaN 存档」的入口现在已被 `validateBody(B.changeManufactureSolutionSchema)` 挡住（manager 内部兜底仍建议按 §5 批次 1 补）。

### 7.5 验证结果

| 项 | 结果 |
|---|---|
| `tsc -p tsconfig.json` / `tsconfig.scripts.json` / `tsconfig.tests.json --incremental false` | **全部 0 错误** |
| `tests/unit/architecture/**` | **54 / 55 通过**；唯一红是 `app/core/auth/auth.ts: unknown 1 → 2`，属**既有工作区改动**（该文件在本轮之前已被修改并新增 `maskAccount(value: unknown)`），与命名统一无关 |
| `tests/unit/game` + `tests/unit/admin` + `tests/unit/router` | **72 文件 / 644 用例全过**（181s） |
| `tests/unit/modules`（含 rlv2 49 文件） | **73 文件 / 817 用例过**，1 例偶发失败：`tests/unit/modules/gacha/gacha-rank.test.ts:27` |
| `tests/unit/manager/building*` + `game/routes.test.ts` + `plugin-heartbeat.test.ts` + `templateShop` + `gacha` | **18 文件 / 367 用例全过**（25s） |
| 命名残留扫描 | 无 `schemas.ts` / `router.ts` / `handler.ts`；`app|tests|scripts` 内 **0 个 PascalCase `.ts`**（生成类型除外）；`*.routes.ts` 恰好 4 个（charRotation / mailCollection / rlv2 / plugin），符合新约定 |

**关于那 1 例失败**：`gacha-rank.test.ts:27` 断言「`beforeNonHitCnt=49` 且 `rand=0.021` 时应为非六星」，但 `resolveGachaRank`（`gacha/gacha.ts`）在未命中六星后走 `randomChoices(ranks, weights, 1)`，**该分支用的是全局 `random` 而非注入的 `rand`**，权重 `[0.5, 0.48, 0.02]` 有 2% 概率抽到六星（rank 5）→ 断言偶发失败。单文件隔离跑 10/10 通过，全量跑必现概率约 2%。该文件与实现**均未在本轮改动**（`git status` 无变更），属既有测试缺陷。修法：把 `rand` 也注入权重抽取，或该分支改用确定性权重断言。

### 7.6 未纳入本轮

- §6.4（`public.ts` 门面 + R3 口径扩到 ops→modules）、§6.5（未使用导入门禁）、§6.6（118 处裸 `req.body as X;`）、§6.7（233 处历史叙事注释）、§6.9–6.12 仍待办。
- `docs/` 下其他历史文档里的旧路径（`module-audit`、`重复实现审查`、`代码冗余审查` 等）未批量改写——它们本就带有已失效行号，属 §6.12 的「文档易腐」问题；本报告自身的路径已按新名重写。
- 遗留红：`type-debt` 棘轮里的 `app/core/auth/auth.ts`（既有，需要时用 `pnpm run type:debt -- --write` 收敛，但那是放松棘轮，应由该改动的作者决定）。



