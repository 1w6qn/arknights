# DoctorateTs 模块实现成熟度审计报告（2026-08-29）

> **后续（2026-09-09）**：prts.wiki 对照续篇见 `docs/prts-wiki-实现评估-2026-09-09.md`（耦合量化 + 约 90 条「与实际效果不符」清单 + P0/P1/P2 修复清单）。
> 该续篇修订本报告 3 处结论：`social` 借出方 socialPoint 已实现（`battle.ts:824-830`）、`user` CG 已落盘（`user/cg-store.ts`）、`dungeon` 全关卡默认三星在运行时不成立（`stage:update` 无 emit）；并证伪「主线记录奖励未落地」（`recordRewardData` 为 null，空 items 与数据一致）。

> 调查方式：全仓只读静态审计（未运行测试/构建/服务器），由 11 个并行子代理按模块族分工，结合四类证据：服务器代码、官服反编译 C# 源码（reference/arknights-2.7.61-csharp，21825 文件）、本地 excel 数据（data/excel，63 表 + data_version.txt，约 101MB）、官服抓包（tmp/capture，11614 条记录）。
> 项目规模：app/ 约 139k LOC TS（core 3.5k / game 124k / ops 10.7k），scripts 12.6k，tests/unit 242 个测试文件（56.9k LOC）。服务器路由面：679 POST + 16 GET（63 个来源文件）。

## 1. 总览

- 抓包覆盖 40+ 模块族，高频链路（rlv2 1860、building 791、gacha 645、shop 421、user 421、quest 109、mission 79 等）均有实包可对照。
- 无抓包样本的模块（未经验证）：tower、autochessSeason、multiplayerV3、rune、deepsea、siracusaMap、vecBreakV2、interlock、aprilFool、arkodc(HTTP)、football、arcade、act24side、act29/35/36/38/42/45/46side、typeAct、crisis 战斗、campaignV2 战斗、bossRush finish、enemyDuel、trainingGround/teamQuest。
- 成熟度分级结论：**核心可玩**（较完整）18 个模块族；**部分实现** 17 个；**骨架** 9 个；**协议桩** 16 个（见下）。

## 2. 成熟度分布

### 较完整（核心玩法真实可用，仍有明确缺口）
| 模块 | 结论要点 |
|---|---|
| building 基建 | 70+ 端点，13 测试文件/约304 用例；时间结算、制造/贸易/线索/buff 引擎成熟；缺口：物品仍绕过 gainItem 管道、房间降级不返还材料、upgradeDiyLevel 预留、部分 POST 缺 validateBody |
| battle/quest 战斗 | 结算/掉落/解锁/回放完整；AP 在 finish 才扣（官服 start 扣，断线可规避）、battleContinue 为固定 stub、主线记录奖励/迷雾/六星奖励未落地 |
| gacha 抽卡 | 13 端点，规则策略表显式分派、保底纯函数 resolveGachaRank；buyRecruitSlot 不扣源石、boost 忽略 buy 参数、公招未走 gainItem |
| shop 商店 | 34 端点，各商店独立构建+购买+限购；buyGPGoodWithTicket 空增量、checkForbidden 恒放行 |
| templateShop | 真配置驱动，写官服 tshop 结构；getGoodList 自动补余额（私服便利逻辑）、nextSyncTime=-1、PROGRESS 批量跨档错算风险 |
| mission 任务 | 日/周/链式解锁/周期奖励完整（1208 任务）；少数 CompleteStage 模板占位、未知模板静默标 invalid |
| checkin 每日签到 | 与抓包高度一致；索引无上限递增、缺防御检查 |
| storyreview | 解锁/阅读/组奖/试玩奖完整；资格校验不足（不验前置/余额） |
| equipmentMission | 模组任务数据驱动，战斗统计推进；enemyStats 全队击杀归因不准、缺失统计兜底置满 |
| character 养成 | 升级/晋升/潜能/技能/专精/模组完整；多处直发 items 事件未走管道、evolveChar 静默失败 |
| rlv2 肉鸽 | 64 端点，47 测试文件/约355 用例，官方结构 diff 测试；黑流树海三结局/骰子 ruleGroup/铜币/远征简化，alchemyReward 忽略 index，旧 /game/rlv2 与 /roguelike 双前缀兼容缺失 |
| arkhub 奇象巡展 | HTTP 10 端点（9 个 `/activity/arkhub/*` + 根级 `/pixelArt/review`）+ 长连接会话协议完整；部分 schema 仍 activityStubSchema、report 桩。**2026-09-13 已按 enemyDuel 样式分层**（`domain/`+`session/`+`capture/`，模块外仅经 `public.ts`，启动绑定在 `session/bindings.ts`），见 `docs/arkhub-重构-2026-09-13.md` |
| bossRush | 波次/遗物/结算完整；battleId 仅内存、缺 finish 抓包验证 |
| act44side 情报屋 | 完整营业日状态机 + 抓包样本比对；BEFORE_SINGLE_RESULT 不支持 |
| arkodc ODC | 5 端点，varSeq/奖励数据驱动；battleId stub、物品直发 items:get 违规 |
| account | login/syncData/syncStatus/syncPushMessage 真实；syncPushMessage 无推送队列（YAGNI） |
| social | SQLite 好友/申请/助战/信用；setStarFriendList 空实现、借出方 socialPoint 未实现 |
| businessCard | 编辑/读取真实；无专属测试、未知 flag 静默成功 |
| mail | 邮件/附件/批量领取完整；getMetaInfoList 忽略 from、并发写无锁 |

### 部分（状态能走通，业务规则明显简化）
user（CG 不持久化、mainlineClue/语音档案只写标志、长期签到/演出剧情桩）、depot（voucherGacha 桩、VOUCHER_MGACHA 池缺失）、charm（回收/首奖硬编码简化）、campaignV2（剿灭未实现：sweep 固定发 1 碎片 vs 官服 320+；getBreakReward/getExMissionReward 空）、tower（状态机半套，3 端点 202 桩）、pay（notify 无签名/金额校验、createOrder 不校验 storeId↔goodId、发货非事务）、medal（约百处占位模板，与 design-spec「全部实现」说法冲突）、retro（解锁不校验 coin/前置、act20side 固定桩）、dungeon（全关卡默认三星，绕过真实通关条件）、crisis（商店不扣货币、奖励只写标记、V1 战斗不校验结果）、vecbreak（攻防战斗固定形状）、aprilFool（仅 act5 真实结算）、act24side（专属战斗奖励恒空）、act1vhalfidle（招募不扣票、replaceRate 桩、战斗不结算）、act42side（最小状态推进、奖励缺失）、milestone（活动商店空交易：只记购买不扣费不发物）、checkin 活动族（开服签到真实，其余多数空 items 或不入账）、system（audit 桩、plugin 心跳真实）、roguelike 旧路由（createGame/finishGame/giveUpGame/milestoneReward 为桩）。

### 骨架（仅最小状态/字段适配）
explore（仅写状态标志，无奖励/流程）、rune（标准战斗适配壳，score/from/to 恒 0）、enemyDuel（固定 battleId、无结算/匹配）、football（固定战斗响应）、deepsea（计数器式占位）、siracusaMap（选项/奖励占位）、act25side（经营玩法全缺）、act13side/act27side（有 act27side 16 条抓包但无买卖语义）、typeAct（3d0/4d0/5d0/9d0/5d1/20side/autochess 全桩）。

### 协议桩（仅防 404 / 固定响应）
autochessSeason、multiplayerV3/invite、sandbox 生息演算（V2/V3/racing 路由面大但核心链路 202/空 delta，恰是抓包最密的链路）、arcade/act42d0、trainingGround、teamQuest、interlockRefresh、interlock（另有 /interlock 双前缀路径问题）、act29side、act35side、act36side、act38side、act45side、act46side、misc-alignment（schema 自述全部为 stub，含 /official/Android/assets 空 JSON）。

## 3. 横切系统性问题（优先级最高）

1. **inventory-pipeline 未收敛**：kernel 已有统一物品管道（`gainItem.setTarget().use()/handle()`），但大量模块仍直接 emit `items:get/items:use` 或改 draft.inventory —— building、battle、social、gacha/recruit、character、depot、charm、arkodc、act24side、act1vhalfidle、milestone 等。后果：任务进度/活动计数/勋章推进不可靠。这是全仓最一致、影响面最大的架构债。
2. **战斗时序偏差**：官服 battleStart 即扣 AP，本地 finish 才扣；断线/不结算可白嫖。finish 响应缺 itemReturn/overrideRewards/diamondMaterialRewards 等官服字段。
3. **路由挂载兼容**：rlv2 缺 /game/rlv2 别名、/roguelike 双前缀（/roguelike/roguelike/*）、topicCreateGame、interlock 双前缀；旧 /roguelike createGame 等为桩。
4. **文档漂移**：AGENTS.md/design-spec 仍称 JSON 文件存储，实际玩家存档主事实源是 social.db 的 gzip BLOB；api.md 的 /campaignV2 404 说法与当前代码/测试冲突（design-spec 已记为修复）。
5. **数据版本**：data/excel/data_version.txt 无运行时校验消费；11 张表（audio_data/building_local_data/cooperate_battle_table/handbook_table/init_text/legion_mode_buff_table/level_script_table/main_text/tech_buff_table/tip_table/token_table）未接入 excel 门面。
6. **保存时序**：delta 后 500ms 防抖写库，异常退出存在丢窗口风险；多次读 delta 会丢增量（契约依赖调用纪律）。
7. **抓包设施**：meta 写失败被吞、会话导出硬限 1000 条；无基于 11614 条记录的批量回放/协议差异回归测试。

## 4. 建议优先级

- P0：统一物品/金币发放到 inventory-pipeline（含 building/battle/character/depot/arkodc 等）；修复 rlv2 alchemyReward 与旧路由别名；补齐 sandbox 高频链路的真实状态机（抓包证据最充分却最空）。
- P1：campaignV2 剿灭经济按抓包落地（fee/碎片/代理卡）；medal 模板真实化或显式降级文档；pay notify 签名校验与 storeId↔goodId 校验；milestone 活动商店扣费发物。
- P2：按「无抓包样本模块清单」优先补抓包验证；tower/act25side/act44side 类逐步扩展；对桩模块统一标注协议桩状态，避免被误认为可玩。
