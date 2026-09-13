/**
 * 活动（activity）请求 zod schema
 *
 * 对应 protocol/activity.ts 的 Request 类型（参考 CS 2.7.61 协议类），
 * 供 router/activity.ts 经 validateBody 做运行时校验：缺失必填字段 /
 * 类型不符时返回 HTTP 4xx，避免非法 body 传入控制器抛 500。
 *
 * 约定：
 * - 服务端实际读取的字段标必填；服务端不读或抓包确认可不传的字段标 .optional()。
 * - 复杂嵌套对象（squad/ownSlots/assistFriend/battleData 等）用 z.json()：接受任意 JSON
 *   值并原样透传（无 any 债，且对 JSON body 与替换前的 any schema 行为一致），避免误伤客户端完整结构。
 * - handler 只读其中少数字段的（如 settle.rankList、act24side items、arkhub squads），
 *   按被读层级收紧结构并用 .passthrough() 保留其余字段。
 * - 空请求体（stub 路由）用 z.object({})。
 */
import { z } from "zod";

/* ===== 签到类 ===== */

/** 获取连签登录奖励（CS: GetChainLogInRewardRequest { index }） */
export const getChainLogInRewardSchema = z.object({
  index: z.number(),
});

/** 获取连签最终奖励（CS: GetChainLogInFinalRewardsRequest，空请求体） */
export const getChainLogInFinalRewardsSchema = z.object({});

/** 获取开服签到奖励（CS: GetOpenServerCheckInRewardRequest { index }） */
export const getOpenServerCheckInRewardSchema = z.object({
  index: z.number(),
});

/** 获取活动签到奖励（CS: ActivityConfirmCheckinRequest；服务端读 activityId/index） */
export const getActivityCheckInRewardSchema = z.object({
  activityId: z.string(),
  index: z.number(),
  // CS 另有 dynOpt，服务端不读，标可选
  dynOpt: z.string().optional(),
});

/** 签到对决签到（服务端自定义；服务端读 actId/tasteChoice） */
export const actCheckinvsSignSchema = z.object({
  actId: z.string(),
  tasteChoice: z.number(),
});

/** 获取开关型活动奖励（服务端自定义；服务端读 activityId/reward） */
export const getSwitchOnlyRewardSchema = z.object({
  activityId: z.string(),
  reward: z.string(),
});

/** 获取签到奖励通用入口（服务端自定义；服务端读 activityId） */
export const getCheckInRewardSchema = z.object({
  activityId: z.string(),
});

/** 登录奖励领取（CS: LoginOnlyService.GET_REWARD；服务端读 activityId） */
export const loginOnlyGetRewardSchema = z.object({
  activityId: z.string(),
});

/** 全服签到活动签到（CS: CheckinAllPlayerServiceCode.CHECKIN；服务端读 activityId/index） */
export const checkinAllPlayerCheckinSchema = z.object({
  activityId: z.string(),
  index: z.number(),
});

/** 全服签到活动行为数据同步（CS: CheckinAllPlayerServiceCode.SYNC_DATA；服务端读 activityId） */
export const checkinAllPlayerSyncSchema = z.object({
  activityId: z.string(),
});

/** 全服签到活动行为奖励领取（CS: CheckinAllPlayerServiceCode.GET_ALL_REWARD；服务端读 activityId） */
export const checkinAllPlayerGetAllRewardSchema = z.object({
  activityId: z.string(),
});

/** 更换节日干员（服务端自定义；服务端读 activityId/index/newChar） */
export const changeFestivalCharSchema = z.object({
  activityId: z.string(),
  index: z.number(),
  newChar: z.string(),
});

/* ===== 里程碑 ===== */

/** 领取活动里程碑奖励（CS: ActivityRewardMilestoneRequest；服务端读 activityId/milestoneId） */
export const rewardMilestoneSchema = z.object({
  activityId: z.string(),
  // milestoneId 可缺省（服务端按条件写入）
  milestoneId: z.string().optional(),
});

/** 领取所有活动里程碑奖励（CS: ActivityRewardAllMilestoneRequest；服务端读 activityId） */
export const rewardAllMilestoneSchema = z.object({
  activityId: z.string(),
});

/* ===== 活动任务 ===== */

/** 确认活动任务并领奖（CS: ActivityConfirmMissionRequest；服务端读 missionId） */
export const confirmActivityMissionSchema = z.object({
  missionId: z.string(),
  // CS 另有 activityId，服务端不读，标可选
  activityId: z.string().optional(),
});

/** 批量确认活动任务（CS: ConfirmMissionListRequest；服务端读 missionIdList） */
export const confirmActivityMissionListSchema = z.object({
  missionIdList: z.array(z.string()),
  // CS 字段名为 missionIds / activityId，服务端不读，标可选
  missionIds: z.array(z.string()).optional(),
  activityId: z.string().optional(),
});

/** 确认活动任务组（CS: ActivityConfirmMissionGroupRequest；服务端读 missionGroupId） */
export const confirmActivityMissionGroupSchema = z.object({
  missionGroupId: z.string(),
  // CS 字段名为 groupId / activityId，服务端不读，标可选
  groupId: z.string().optional(),
  activityId: z.string().optional(),
});

/** 自动确认活动任务（CS: AutoConfirmMissionsRequest；服务端读 type） */
export const autoConfirmMissionsSchema = z.object({
  type: z.string(),
});

/* ===== 活动商店 ===== */

/** 兑换活动商店商品（服务端自定义；服务端读 shopId/goodId/count） */
export const exchangeActivityShopItemSchema = z.object({
  shopId: z.string(),
  goodId: z.string(),
  // count 缺省时服务端按 1 处理
  count: z.number().optional(),
});

/** 获取活动收集奖励（CS: ActivityGetCollectionRewardRequest；服务端读 activityId/collectionId） */
export const getActivityCollectionRewardSchema = z.object({
  activityId: z.string(),
  // CS 字段名为 index，服务端读 collectionId；两者均可缺省
  index: z.number().optional(),
  collectionId: z.number().optional(),
});

/** 获取活动商店信息（服务端自定义；服务端读 shopId） */
export const getActivityShopInfoSchema = z.object({
  shopId: z.string(),
});

/* ===== 信物 ===== */

/** 回收信物（CS: RecycleCharmsRequest；服务端读 charmIds） */
export const recycleCharmsSchema = z.object({
  // CS 字段为 activityId，服务端不读，标可选
  activityId: z.string().optional(),
  // charmIds 缺省时服务端按空数组处理
  charmIds: z.array(z.string()).optional(),
});

/** 尝试获取信物首通奖励（CS: GetCharmFirstRewardRequest；服务端读 charmId） */
export const tryGetCharmFirstRewardSchema = z.object({
  // CS 字段为 activityId，服务端不读，标可选
  activityId: z.string().optional(),
  charmId: z.string(),
});

/* ===== 尖灭测试（bossRush） ===== */

/** 尖灭测试开始战斗（CS: BossRushStartBattleRequest；ownSlots/assistFriend 为复杂对象） */
export const bossRushStartBattleSchema = z.object({
  activityId: z.string(),
  stageId: z.string(),
  teamId: z.string().optional(),
  // 编队/助战为复杂嵌套对象，仅保证存在
  ownSlots: z.json(),
  assistFriend: z.json(),
});

/** 尖灭测试战斗结算（CS: BossRushFinishBattleRequest；服务端读 activityId/data/battleData） */
export const bossRushBattleFinishSchema = z.object({
  activityId: z.string(),
  data: z.string(),
  // 客户端完整战报对象，仅保证存在，不做深检
  battleData: z.json(),
});

/** 尖灭测试密文选择（CS: BossRushRelicSelectRequest；服务端读 activityId/relicId） */
export const bossRushRelicSelectSchema = z.object({
  activityId: z.string(),
  relicId: z.string(),
});

/** 尖灭测试密文升级（CS: BossRushRelicUpgradeRequest；服务端读 activityId/relicId） */
export const bossRushRelicUpgradeSchema = z.object({
  activityId: z.string(),
  relicId: z.string(),
});

/* ===== 怪猎对决（enemyDuel） ===== */

/**
 * 怪猎对决单回合存活单位（CS: Torappu.EnemyDuel.SurviveUnitInfo）
 *
 * 真值来自官方客户端抓包（`reference/obs` 的 Insight `data/*.jsonl`）：
 * `[{ round, unitIds: { <enemyId>: <count> } }]`，round 0..9 每回合一条。
 * 服务端当前只校验结构、不读值，但按协议收紧后解锁结算校验/统计能力。
 */
export const enemyDuelSurviveUnitSchema = z.object({
  round: z.number(),
  unitIds: z.record(z.string(), z.number()),
});

/**
 * 怪猎对决单回合出生单位（CS: Torappu.EnemyDuel.BornUnitInfo）
 *
 * 抓包真值：`[{ round, leftUnitIds: { <enemyId>: <count> }, rightUnitIds: {...} }]`；
 * Insight 另把右阵营计负数合并为单一 `<enemyId> → ±count` 映射（`reader.ts:21-29`），
 * 那是它自己的展示口径，不是请求线格式——请求里左右分开。
 */
export const enemyDuelBornUnitSchema = z.object({
  round: z.number(),
  leftUnitIds: z.record(z.string(), z.number()),
  rightUnitIds: z.record(z.string(), z.number()),
});

/** 怪猎对决单人开始战斗（CS: EnemyDuelSingleBattleStartRequest；服务端不读 body） */
export const enemyDuelSingleBattleStartSchema = z.object({
  activityId: z.string().optional(),
  modeId: z.string().optional(),
});

/** 怪猎对决单人结算（CS: EnemyDuelSingleBattleFinishRequest；服务端读 activityId/settle.rankList） */
export const enemyDuelSingleBattleFinishSchema = z.object({
  activityId: z.string(),
  // settle 只被读 rankList（enemyDuel/router.ts 取 `settle?.rankList` 作为排行榜回填/兜底），
  // 元素内层字段不做服务端读取，故整体作为 JSON 数组透传；passthrough 保留其余结算字段
  settle: z
    .object({
      rankList: z.array(z.json()).optional(),
    })
    .passthrough()
    .optional(),
  // 服务端不读 data/battleData，标可选
  data: z.string().optional(),
  battleData: z.json().optional(),
  // surviveUnits/bornUnits 结构已由抓包真值确定，按协议收紧（不再透传任意 JSON）
  surviveUnits: z.array(enemyDuelSurviveUnitSchema).optional(),
  bornUnits: z.array(enemyDuelBornUnitSchema).optional(),
});

/** 怪猎对决开始匹配（CS: EnemyDuelStartMatchRequest；服务端读 activityId/modeId） */
export const enemyDuelStartMatchSchema = z.object({
  activityId: z.string(),
  modeId: z.string(),
});

/** 怪猎对决查询匹配（CS: EnemyDuelQueryMatchRequest；服务端读 needLeave） */
export const enemyDuelQueryMatchSchema = z.object({
  activityId: z.string().optional(),
  needLeave: z.boolean().optional(),
});

/** 怪猎对决创建队伍（CS: EnemyDuelCreateTeamRequest；服务端读 modeId） */
export const enemyDuelCreateTeamSchema = z.object({
  activityId: z.string().optional(),
  modeId: z.string(),
});

/** 怪猎对决加入队伍（CS: EnemyDuelJoinTeamRequest；服务端读 teamId） */
export const enemyDuelJoinTeamSchema = z.object({
  activityId: z.string().optional(),
  teamId: z.string(),
});

/** 怪猎对决多人开始战斗（CS: EnemyDuelMultiBattleStartRequest；服务端不读 body） */
export const enemyDuelMultiBattleStartSchema = z.object({
  activityId: z.string().optional(),
  sceneId: z.string().optional(),
});

/** 怪猎对决多人结算（CS: EnemyDuelMultiBattleFinishRequest；服务端读 activityId） */
export const enemyDuelMultiBattleFinishSchema = z.object({
  activityId: z.string(),
  // 服务端不读以下字段，标可选
  sceneId: z.string().optional(),
  data: z.string().optional(),
  battleData: z.json().optional(),
  surviveUnits: z.array(enemyDuelSurviveUnitSchema).optional(),
  bornUnits: z.array(enemyDuelBornUnitSchema).optional(),
});

/* ===== 怪猎（act24side） ===== */

/** 怪猎合成抽奖（服务端自定义；服务端读 activityId/gachaBox/items） */
export const act24sideAlchemySchema = z.object({
  activityId: z.string(),
  gachaBox: z.string(),
  // items 为 <素材ID, 数量> 扁平映射——act24side/router.ts 逐项读键与数量做扣减/计分，
  // 故按协议类型收紧为 string→number 字典（不再接受任意 JSON）
  items: z.record(z.string(), z.number()),
});

/** 怪猎开始战斗（CS: Act24sideBattleStartRequest : CommonStartBattleRequest；整包转发 battle.start） */
export const act24sideBattleStartSchema = z.object({
  stageId: z.string(),
  // squad 为完整编队对象，仅保证存在
  squad: z.json(),
  isRetro: z.number().optional(),
  pray: z.number().optional(),
  battleType: z.number().optional(),
  continuous: z.json().optional(),
  usePracticeTicket: z.number().optional(),
  assistFriend: z.json().optional(),
  isReplay: z.number().optional(),
  startTs: z.number().optional(),
  activityId: z.string().optional(),
});

/** 怪猎战斗结算（CS: Act24sideBattleFinishRequest；服务端读 data/battleData） */
export const act24sideBattleFinishSchema = z.object({
  activityId: z.string().optional(),
  data: z.string(),
  // 客户端完整战报对象，仅保证存在，不做深检
  battleData: z.json(),
});

/** 怪猎进食（服务端自定义；服务端读 activityId/meal） */
export const act24sideEatSchema = z.object({
  activityId: z.string(),
  meal: z.string(),
});

/** 怪猎设置工具（服务端自定义；服务端读 activityId/tools） */
export const act24sideSetToolSchema = z.object({
  activityId: z.string(),
  tools: z.array(z.string()),
});

/** 怪猎获取狩猎收集奖励（CS: Act24sideGetHuntWikiRewardRequest；服务端不读 body） */
export const act24sideGetHuntCollectRewardsSchema = z.object({
  activityId: z.string().optional(),
});

/* ===== 生息演算（act25side，根路径） ===== */

/** 生息演算开始战斗（CS: Act25sideBattleStartRequest : CommonStartBattleRequest；整包转发 battle.start） */
export const act25sideBattleStartSchema = z.object({
  stageId: z.string(),
  // squad 为完整编队对象，仅保证存在
  squad: z.json(),
  isRetro: z.number().optional(),
  pray: z.number().optional(),
  battleType: z.number().optional(),
  continuous: z.json().optional(),
  usePracticeTicket: z.number().optional(),
  assistFriend: z.json().optional(),
  isReplay: z.number().optional(),
  startTs: z.number().optional(),
});

/** 生息演算战斗结算（CS: Act25sideBattleFinishRequest；服务端读 data/battleData） */
export const act25sideBattleFinishSchema = z.object({
  data: z.string(),
  // 客户端完整战报对象，仅保证存在，不做深检
  battleData: z.json(),
});

/** 生息演算每日刷新（CS: Act25sideDailyRefreshRequest；服务端不读 body） */
export const act25sideDailyRefreshSchema = z.object({
  actId: z.string().optional(),
});

/** 生息演算收获（CS: Act25sideDailyHarvestRequest；服务端不读 body） */
export const act25sideHarvestSchema = z.object({
  actId: z.string().optional(),
});

/** 生息演算调查/完成调查（CS: Act25sideResearchRequest/FinishInvestigationRequest；服务端不读 body） */
export const act25sideInvestigateSchema = z.object({
  actId: z.string().optional(),
  areaId: z.string().optional(),
});

/* ===== 足球（football） ===== */

/** 足球开始战斗（CS: Act1FootballBattleStartRequest；服务端不读 body） */
export const footballBattleStartSchema = z.object({
  activityId: z.string().optional(),
  stageId: z.string().optional(),
  // squad/assistFriend 为复杂嵌套对象，仅保证存在
  squad: z.json().optional(),
  assistFriend: z.json().optional(),
});

/** 足球战斗结算（CS: Act1FootballBattleFinishRequest；服务端不读 body） */
export const footballBattleFinishSchema = z.object({
  activityId: z.string().optional(),
  data: z.string().optional(),
  battleData: z.json().optional(),
});

/* ===== 通用 stub（未读取 body 的批量活动接口） ===== */

/** 通用活动状态请求（ActStubRequest；仅 activityId，未读取 body） */
export const activityStubSchema = z.object({
  activityId: z.string().optional(),
});

/** 活动小游戏开始战斗（ActMiniBattleStartRequest；未读取 body） */
export const activityMiniBattleStartSchema = z.object({});

/** 活动小游戏战斗结算（ActMiniBattleFinishRequest；未读取 body） */
export const activityMiniBattleFinishSchema = z.object({});

/** act1vhalfidle 战斗结算（Act1VHalfIdleBattleFinishRequest；读取 activityId + stageId 以登记关卡产出） */
export const act1vhalfidleBattleFinishSchema = z.object({
  activityId: z.string().optional(),
  stageId: z.string().optional(),
  completeState: z.number().optional(),
});

/** 抽奖/登录/许愿类 getReward（ActivityGetRewardRequest；未读取 body） */
export const activityGetRewardSchema = z.object({
  activityId: z.string().optional(),
  index: z.number().optional(),
});

/** act1vhalfidle 半挂机通用请求（服务端读取 activityId 及按接口读取的 poolId/count/charId/level/skillLvl/evolvePhase 等字段） */
export const act1vhalfidleSchema = z.object({
  activityId: z.string().optional(),
  charInstId: z.number().optional(),
  techId: z.string().optional(),
  productId: z.string().optional(),
  rateId: z.string().optional(),
  recruitId: z.string().optional(),
  poolId: z.string().optional(),
  count: z.number().optional(),
  charId: z.string().optional(),
  level: z.number().optional(),
  skillLvl: z.number().optional(),
  evolvePhase: z.number().optional(),
});

/** act13side 日任务提交类（Act13sideDailyMissionCommitRequest；未读取 body） */
export const act13sideDailyMissionCommitSchema = z.object({
  activityId: z.string().optional(),
  missionId: z.string().optional(),
});

/** act13side 日任务随机/替换（Act13sideDailyMissionRandomRequest；未读取 body） */
export const act13sideDailyMissionRandomSchema = z.object({
  activityId: z.string().optional(),
  index: z.number().optional(),
});

/** act35side 卡牌创建（Act35sideCreateRequest；未读取 body） */
export const act35sideCreateSchema = z.object({
  activityId: z.string().optional(),
});

/** act35side 卡牌购买/处理（Act35sideBuyRequest；未读取 body） */
export const act35sideBuySchema = z.object({
  activityId: z.string().optional(),
  cardId: z.string().optional(),
  goodsId: z.string().optional(),
});

/** act42side 领取每日奖励（Act42sideGetDailyRewardsRequest；服务端读 activityId） */
export const act42sideGetDailyRewardsSchema = z.object({
  activityId: z.string().optional(),
});

/** act42side 接取/确认任务（服务端读 activityId/taskId） */
export const act42sideTaskSchema = z.object({
  activityId: z.string().optional(),
  taskId: z.string().optional(),
});

/** act44side 开始游戏/使用洞悉（InformantStartGameRequest/InformantUseInsightRequest；服务端读 activityId） */
export const act44sideStartGameSchema = z.object({
  activityId: z.string().optional(),
});

/** act44side 推进状态（InformantNextStateRequest；服务端读 activityId/state） */
export const act44sideNextStateSchema = z.object({
  activityId: z.string().optional(),
  state: z.number().optional(),
});

/** act44side 选择对话（InformantSelectChoiceRequest；服务端读 activityId/index） */
export const act44sideSelectChoiceSchema = z.object({
  activityId: z.string().optional(),
  index: z.number().optional(),
});

/** act45side 确认干员/邮件（Act45sideConfirmRequest；未读取 body） */
export const act45sideConfirmSchema = z.object({
  activityId: z.string().optional(),
  charInstId: z.number().optional(),
  mailId: z.string().optional(),
});

/** act46side 挖矿（Act46sideGameRequest；未读取 body） */
export const act46sideGameSchema = z.object({
  activityId: z.string().optional(),
  node: z.json().optional(),
});

/** act5d1 危机合约购买（Act5d1BuyGoodsRequest；未读取 body） */
export const act5d1BuyGoodsSchema = z.object({
  activityId: z.string().optional(),
  goodsId: z.string().optional(),
  runeId: z.string().optional(),
});

/* ===== 根路径其它活动接口 ===== */

/** act29side 提交旋律/开始大投资/合成（服务端自定义；未读取 body） */
export const act29sideSchema = z.object({
  activityId: z.string().optional(),
});

/** act36side 确认图鉴奖励（服务端自定义；未读取 body） */
export const act36sideConfirmDexNavRewardSchema = z.object({
  activityId: z.string().optional(),
  rewardId: z.string().optional(),
});

/** 训练场开始/结算战斗（服务端自定义；未读取 body） */
export const trainingGroundSchema = z.object({});

/* ===== 方舟枢纽（arkhub） ===== */

/** 方舟枢纽像素画查询（服务端读 pixelArtIds；activityId 服务端不读） */
export const arkhubGetPixelArtSchema = z.object({
  activityId: z.string().optional(),
  pixelArtIds: z.array(z.number()).optional(),
});

/** 方舟枢纽设置秘书（服务端读 secretary/secretarySkinId） */
export const arkhubSetSecretarySchema = z.object({
  secretary: z.string().optional(),
  secretarySkinId: z.string().optional(),
});

/** 方舟枢纽设置队伍（服务端读 squads；squads 为复杂对象数组） */
export const arkhubSetSquadSchema = z.object({
  // handler 只做 Array.isArray 判定后整段存入 activity.ARK_HUB.squads（不读元素字段），
  // 故按被读层级收紧到「JSON 数组」，元素结构保持透传
  squads: z.array(z.json()).optional(),
});

/**
 * 像素画审核请求（CS: ActArkhubReviewPixelArtRequest { uid, status, items }）
 *
 * 私服仅记录审核动作（`ARK_HUB.act1arkhub.reviewedPixelArts`），返回空增量。
 * 2026-09-13 自 `account/user.schema.ts` 迁入活动族（端点 `/pixelArt/review` 同步归位 arkhub 模块）。
 */
export const arkhubPixelArtReviewSchema = z.object({
  uid: z.string().optional(),
  status: z.number().optional(),
});
