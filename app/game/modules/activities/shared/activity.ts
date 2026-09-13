/**
 * 活动协议类型
 *
 * 对应客户端 com.hypergryph.arknights_2.7.61.cs 中 Torappu 命名空间的
 * GetChainLogInRewardRequest / Activity.ActivityConfirmCheckinRequest /
 * Activity.ActivityRewardMilestoneRequest / Activity.Act12side.RecycleCharmsRequest 等
 * Request/Response 类；字段以 CS 类为准，服务端未返回的协议字段标为可选。
 * 部分接口（签到对决/开关活动/活动商店等）无直接 CS 类对应，标注为服务端自定义。
 */
import { ItemBundle } from "@excel/excel";
import { PlayerSquad, SquadFriendData } from "../../../kernel/model";
import { CommonStartBattleRequest } from "../../../kernel/battle-model";
import { PlayerDeltaResponse } from "../../../kernel/http/common";

/* ===== 签到类 ===== */

/** 获取连签登录奖励请求（CS: GetChainLogInRewardRequest） */
export interface GetChainLogInRewardRequest {
  index: number;
}

/**
 * 获取连签登录奖励响应（CS: GetChainLogInRewardResponse）
 * CS 的 reward 为单条 ActivityItemModel，服务端返回 ItemBundle[]
 */
export interface GetChainLogInRewardResponse extends PlayerDeltaResponse {
  reward: ItemBundle[];
}

/** 获取连签最终奖励请求（CS: GetChainLogInFinalRewardsRequest，无字段） */
export interface GetChainLogInFinalRewardsRequest {}

/**
 * 获取连签最终奖励响应（CS: GetChainLogInFinalRewardsResponse）
 * CS 字段名为 rewards，服务端返回 reward（以服务端为准）
 */
export interface GetChainLogInFinalRewardsResponse extends PlayerDeltaResponse {
  reward: ItemBundle[];
}

/** 获取开服签到奖励请求（CS: GetOpenServerCheckInRewardRequest） */
export interface GetOpenServerCheckInRewardRequest {
  index: number;
}

/**
 * 获取开服签到奖励响应（CS: GetOpenServerCheckInRewardResponse）
 * CS 的 reward 为单条 ActivityItemModel，服务端返回 ItemBundle[]
 */
export interface GetOpenServerCheckInRewardResponse extends PlayerDeltaResponse {
  reward: ItemBundle[];
}

/**
 * 获取活动签到奖励请求（CS: Activity.ActivityConfirmCheckinRequest）
 * CS 另有 dynOpt 字段，服务端未读取
 */
export interface GetActivityCheckInRewardRequest {
  index: number;
  activityId: string;
  dynOpt?: string;
}

/** 获取活动签到奖励响应（CS: Activity.ActivityConfirmCheckinResponse） */
export interface GetActivityCheckInRewardResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 获取登录奖励请求（CS: LoginOnlyService.GET_REWARD "/activity/loginOnly/getReward"）
 * 字段：activityId（官服抓包 R-1707618442119.734-4504）
 */
export interface LoginOnlyGetRewardRequest {
  activityId: string;
}

/** 获取登录奖励响应（官服抓包：reward 数组 + playerDataDelta） */
export interface LoginOnlyGetRewardResponse extends PlayerDeltaResponse {
  reward: ItemBundle[];
}

/** 全服签到活动签到请求（CS: CheckinAllPlayerServiceCode.CHECKIN；读 activityId/index） */
export interface CheckinAllPlayerCheckinRequest {
  activityId: string;
  index: number;
}

/** 全服签到活动签到响应（items + delta） */
export interface CheckinAllPlayerCheckinResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/** 全服签到活动行为数据同步请求（CS: CheckinAllPlayerServiceCode.SYNC_DATA） */
export interface CheckinAllPlayerSyncRequest {
  activityId: string;
}

/** 全服签到活动行为数据同步响应（空增量） */
export type CheckinAllPlayerSyncResponse = PlayerDeltaResponse;

/** 全服签到活动行为奖励领取请求（CS: CheckinAllPlayerServiceCode.GET_ALL_REWARD） */
export interface CheckinAllPlayerGetAllRewardRequest {
  activityId: string;
}

/** 全服签到活动行为奖励领取响应（items + delta） */
export interface CheckinAllPlayerGetAllRewardResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 签到对决活动签到请求（服务端自定义）
 * 参考 CS PlayerActivity.PlayerCheckinVsTypeActivity / VersusCheckInData.TasteInfoData
 * tasteChoice：1=甜，2=咸
 */
export interface ActCheckinvsSignRequest {
  actId: string;
  tasteChoice: number;
}

/** 签到对决活动签到响应（服务端自定义） */
export interface ActCheckinvsSignResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 获取开关型活动奖励请求（服务端自定义）
 * 参考 CS PlayerActivity.PlayerSwitchOnlyActivity
 */
export interface GetSwitchOnlyRewardRequest {
  activityId: string;
  reward: string;
}

/** 获取开关型活动奖励响应（服务端自定义；items + 增量） */
export interface GetSwitchOnlyRewardResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 获取签到奖励（通用入口）请求（服务端自定义）
 * 参考 CS PlayerActivity.PlayerCheckinAccessTypeActivity / PlayerBlessOnlyActivity
 */
export interface GetCheckInRewardRequest {
  activityId: string;
}

/** 获取签到奖励（通用入口）响应（服务端自定义） */
export interface GetCheckInRewardResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 更换节日干员请求（服务端自定义）
 * 参考 CS PlayerActivity.PlayerBlessOnlyActivity.BlessOnlyFestival
 */
export interface ChangeFestivalCharRequest {
  activityId: string;
  index: number;
  newChar: string;
}

/** 更换节日干员响应（服务端自定义；仅增量） */
export type ChangeFestivalCharResponse = PlayerDeltaResponse;

/* ===== 里程碑 ===== */

/**
 * 领取活动里程碑奖励请求（CS: Activity.ActivityRewardMilestoneRequest）
 * 服务端 milestoneId 可缺省
 */
export interface RewardMilestoneRequest {
  activityId: string;
  milestoneId?: string;
}

/**
 * 领取活动里程碑奖励响应（CS: Activity.ActivityRewardMilestoneResponse）
 * CS 字段名为 items，服务端返回 item（以服务端为准）
 */
export interface RewardMilestoneResponse extends PlayerDeltaResponse {
  item: ItemBundle[];
}

/** 领取所有活动里程碑奖励请求（CS: Activity.ActivityRewardAllMilestoneRequest） */
export interface RewardAllMilestoneRequest {
  activityId: string;
}

/**
 * 领取所有活动里程碑奖励响应（CS: Activity.ActivityRewardAllMilestoneResponse）
 * CS 字段含 milestoneList/items，服务端仅返回 item（以服务端为准）
 */
export interface RewardAllMilestoneResponse extends PlayerDeltaResponse {
  item: ItemBundle[];
}

/* ===== 活动任务 ===== */

/**
 * 确认活动任务并领取奖励请求（CS: Activity.ActivityConfirmMissionRequest）
 * CS 另有 activityId 字段，服务端未读取
 */
export interface ConfirmActivityMissionRequest {
  missionId: string;
  activityId?: string;
}

/**
 * 确认活动任务并领取奖励响应（CS: Activity.ActivityConfirmMissionResponse）
 * 修复：CS 字段名为 items（客户端据此弹"获得奖励"提示），原服务端返回 rewards 客户端读不到
 */
export interface ConfirmActivityMissionResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 批量确认活动任务请求（CS: ConfirmMissionListRequest）
 * CS 与抓包字段名为 missionIds，服务端读取 missionIdList（以服务端为准）
 */
export interface ConfirmActivityMissionListRequest {
  missionIdList: string[];
  missionIds?: string[];
  activityId?: string;
}

/** 批量确认活动任务响应（CS 同单任务结构，字段名为 items——客户端弹"获得奖励"提示） */
export interface ConfirmActivityMissionListResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 确认活动任务组请求（CS: Activity.ActivityConfirmMissionGroupRequest）
 * CS 字段名为 groupId，服务端读取 missionGroupId（以服务端为准）；CS 另有 activityId
 */
export interface ConfirmActivityMissionGroupRequest {
  missionGroupId: string;
  groupId?: string;
  activityId?: string;
}

/**
 * 确认活动任务组响应（CS: Activity.ActivityConfirmMissionGroupResponse）
 * 修复：CS 字段名为 items（客户端据此弹"获得奖励"提示）
 */
export interface ConfirmActivityMissionGroupResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 自动确认活动任务请求（CS: AutoConfirmMissionsRequest）
 * CS 的 type 为 MissionType 枚举，服务端以字符串读取
 */
export interface AutoConfirmMissionsRequest {
  type: string;
}

/** 自动确认活动任务响应（CS: AutoConfirmMissionsResponse） */
export interface AutoConfirmMissionsResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/* ===== 活动商店 ===== */

/**
 * 兑换活动商店商品请求（服务端自定义）
 * count 缺省时服务端按 1 处理
 */
export interface ExchangeActivityShopItemRequest {
  shopId: string;
  goodId: string;
  count?: number;
}

/** 兑换活动商店商品响应（服务端自定义） */
export interface ExchangeActivityShopItemResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/**
 * 获取活动收集奖励请求（CS: Activity.ActivityGetCollectionRewardRequest）
 * CS 字段为 index，服务端读取 collectionId（以服务端为准）
 */
export interface GetActivityCollectionRewardRequest {
  activityId: string;
  index?: number;
  collectionId?: number;
}

/**
 * 获取活动收集奖励响应（CS: Activity.ActivityGetCollectionRewardResponse）
 * CS 字段名为 items，服务端返回 item（以服务端为准）
 */
export interface GetActivityCollectionRewardResponse extends PlayerDeltaResponse {
  item: ItemBundle[];
}

/** 获取活动商店信息请求（服务端自定义） */
export interface GetActivityShopInfoRequest {
  shopId: string;
}

/** 活动商店信息（服务端 tshop 结构） */
export interface ActivityShopInfo {
  coin: number;
  info: { id: string; count: number }[];
  progressInfo: { [key: string]: unknown };
}

/** 获取活动商店信息响应（服务端自定义） */
export interface GetActivityShopInfoResponse extends PlayerDeltaResponse {
  shopInfo: ActivityShopInfo;
}

/* ===== 信物 ===== */

/**
 * 回收信物请求（CS: Activity.Act12side.RecycleCharmsRequest）
 * CS 字段为 activityId，服务端读取 charmIds（以服务端为准）
 */
export interface RecycleCharmsRequest {
  activityId?: string;
  charmIds?: string[];
}

/**
 * 回收信物响应（CS: Activity.Act12side.RecycleCharmsResponse）
 * CS 字段含 settles/coinGot/items，服务端仅返回 result/recycleNum（以服务端为准）
 */
export interface RecycleCharmsResponse extends PlayerDeltaResponse {
  result: number;
  recycleNum: number;
}

/**
 * 尝试获取信物首通奖励请求（CS: Activity.Act12side.GetCharmFirstRewardRequest）
 * CS 字段为 activityId，服务端读取 charmId（以服务端为准）
 */
export interface TryGetCharmFirstRewardRequest {
  activityId?: string;
  charmId: string;
}

/**
 * 尝试获取信物首通奖励响应（CS: Activity.Act12side.GetCharmFirstRewardResponse）
 * CS 字段含 settles/coinGot，服务端返回 isFirst/reward（以服务端为准）
 */
export interface TryGetCharmFirstRewardResponse extends PlayerDeltaResponse {
  isFirst: boolean;
  reward: ItemBundle[];
}

/* ===== 尖灭测试（bossRush）===== */

/**
 * 尖灭测试开始战斗请求（CS: Torappu.UI.BossRush.BossRushStartBattleRequest）
 * 参考 DoctoratePy activityBossRushBattleStart / OBS misc_bp bossRush battleStart
 */
export interface BossRushStartBattleRequest {
  activityId: string;
  stageId: string;
  teamId?: string;
  ownSlots: PlayerSquad;
  assistFriend: null | SquadFriendData;
}

/**
 * 尖灭测试开始战斗响应（CS: BossRushStartBattleResponse : CommonStartBattleResponse）
 * 与 quest battleStart 同形（result/battleId/apFailReturn/isApProtect/...）
 */
export interface BossRushStartBattleResponse extends PlayerDeltaResponse {
  result: number;
  battleId: string;
  apFailReturn: number;
  isApProtect: number;
  inApProtectPeriod: boolean;
  notifyPowerScoreNotEnoughIfFailed: boolean;
}

/**
 * 尖灭测试战斗结算请求（CS: BossRushFinishBattleRequest : CommonFinishBattleRequest）
 * CS 在 CommonFinishBattleRequest（data/battleData）基础上增加 activityId
 */
export interface BossRushFinishBattleRequest {
  activityId: string;
  data: string;
  battleData: { isCheat: string; completeTime: number };
}

/**
 * 尖灭测试战斗结算响应（CS: BossRushFinishBattleResponse : DefaultFinishBattleResponse）
 * 基础字段同 quest battleFinish（可缺省），另加尖灭专属 6 字段
 */
export interface BossRushFinishBattleResponse extends PlayerDeltaResponse {
  result?: number;
  apFailReturn?: number;
  expScale?: number;
  goldScale?: number;
  rewards?: ItemBundle[];
  firstRewards?: ItemBundle[];
  unlockStages?: string[];
  unusualRewards?: ItemBundle[];
  additionalRewards?: ItemBundle[];
  furnitureRewards?: ItemBundle[];
  alert?: unknown[];
  suggestFriend?: boolean;
  pryResult?: unknown[];
  wave: number;
  milestoneBefore: number;
  milestoneAdd: number;
  isMilestoneMax: boolean;
  tokenAdd: number;
  isTokenMax: boolean;
}

/** 尖灭测试密文选择请求（CS: BossRushRelicSelectRequest） */
export interface BossRushRelicSelectRequest {
  activityId: string;
  relicId: string;
}

/** 尖灭测试密文选择响应（CS: BossRushRelicSelectResponse : PlayerDeltaResponse） */
export type BossRushRelicSelectResponse = PlayerDeltaResponse;

/** 尖灭测试密文升级请求（CS: BossRushRelicUpgradeRequest） */
export interface BossRushRelicUpgradeRequest {
  activityId: string;
  relicId: string;
}

/** 尖灭测试密文升级响应（CS: BossRushRelicUpgradeResponse : PlayerDeltaResponse） */
export type BossRushRelicUpgradeResponse = PlayerDeltaResponse;

/* ===== 怪猎对决（enemyDuel，参考 ODPY/OBS + CS 2.7.61）===== */

/** 怪猎对决单人开始战斗请求（CS: EnemyDuelSingleBattleStartRequest） */
export interface EnemyDuelSingleBattleStartRequest {
  activityId: string;
  modeId: string;
}

/**
 * 怪猎对决开始战斗响应（CS: EnemyDuelSingleBattleStartResponse : CommonStartBattleResponse）
 * 单人/多人共用同一形状
 */
export interface EnemyDuelBattleStartResponse extends PlayerDeltaResponse {
  result: number;
  battleId: string;
  apFailReturn?: number;
  isApProtect?: number;
  inApProtectPeriod?: boolean;
  notifyPowerScoreNotEnoughIfFailed?: boolean;
}

/** 怪猎对决排名条目（CS: Torappu.UI.EnemyDuel.RankInfo） */
export interface EnemyDuelRankInfo {
  id: string;
  rank: number;
  score: number;
  isPlayer: number;
  playerBrief?: unknown;
}

/**
 * 怪猎对决单回合存活单位（CS: Torappu.EnemyDuel.SurviveUnitInfo）
 * `unitIds` 为 `<enemyId, 数量>` 映射，round 0..9；真值见抓包（Insight `data/*.jsonl`）
 */
export interface EnemyDuelSurviveUnit {
  round: number;
  unitIds: Record<string, number>;
}

/**
 * 怪猎对决单回合出生单位（CS: Torappu.EnemyDuel.BornUnitInfo）
 * 左右阵营分别给出 `<enemyId, 数量>` 映射（右阵营在请求里是正数，非 Insight 的负数合并口径）
 */
export interface EnemyDuelBornUnit {
  round: number;
  leftUnitIds: Record<string, number>;
  rightUnitIds: Record<string, number>;
}

/** 怪猎对决单人结算请求（CS: EnemyDuelSingleBattleFinishRequest : CommonFinishBattleRequest） */
export interface EnemyDuelSingleBattleFinishRequest {
  activityId: string;
  data: string;
  battleData: { isCheat: string; completeTime: number };
  settle?: { rankList?: EnemyDuelRankInfo[] };
  surviveUnits?: EnemyDuelSurviveUnit[];
  bornUnits?: EnemyDuelBornUnit[];
}

/** 怪猎对决多人结算请求（CS: EnemyDuelMultiBattleFinishRequest : CommonFinishBattleRequest） */
export interface EnemyDuelMultiBattleFinishRequest {
  activityId: string;
  sceneId: string;
  data: string;
  battleData: { isCheat: string; completeTime: number };
  surviveUnits?: EnemyDuelSurviveUnit[];
  bornUnits?: EnemyDuelBornUnit[];
}

/**
 * 怪猎对决结算响应公共字段
 * CS: EnemyDuel*BattleFinishResponse : DefaultFinishBattleResponse + 6 个怪猎专属字段
 */
export interface EnemyDuelFinishBattleFields {
  result?: number;
  apFailReturn?: number;
  itemReturn?: unknown[];
  rewards?: ItemBundle[];
  unusualRewards?: ItemBundle[];
  overrideRewards?: ItemBundle[];
  additionalRewards?: ItemBundle[];
  diamondMaterialRewards?: ItemBundle[];
  furnitureRewards?: ItemBundle[];
  goldScale?: number;
  expScale?: number;
  firstRewards?: ItemBundle[];
  unlockStages?: string[] | null;
  pryResult?: unknown[];
  alert?: unknown[];
  suggestFriend?: boolean;
  extra?: unknown;
  choiceCnt: { skip: number; normal: number; allIn: number };
  commentId: string;
  isHighScore: boolean;
  rankList: EnemyDuelRankInfo[];
  dailyMission: { add: number; reward: number };
  bp: number;
}

/** 怪猎对决单人结算响应（CS: EnemyDuelSingleBattleFinishResponse） */
export type EnemyDuelSingleBattleFinishResponse = EnemyDuelFinishBattleFields &
  PlayerDeltaResponse;

/** 怪猎对决多人结算响应（CS: EnemyDuelMultiBattleFinishResponse） */
export type EnemyDuelMultiBattleFinishResponse = EnemyDuelFinishBattleFields &
  PlayerDeltaResponse;

/** 怪猎对决开始匹配请求（CS: EnemyDuelStartMatchRequest） */
export interface EnemyDuelStartMatchRequest {
  activityId: string;
  modeId: string;
}

/** 怪猎对决开始匹配响应（CS: EnemyDuelStartMatchResponse : PlayerDeltaResponse { result }） */
export interface EnemyDuelStartMatchResponse extends PlayerDeltaResponse {
  result: number;
}

/** 怪猎对决查询匹配请求（CS: EnemyDuelQueryMatchRequest） */
export interface EnemyDuelQueryMatchRequest {
  activityId: string;
  needLeave?: boolean;
}

/** 怪猎对决队伍信息（CS: Torappu.UI.EnemyDuel.EnemyDuelTeamInfo） */
export interface EnemyDuelTeamInfo {
  teamId: string;
  serverAddress: string;
  serverToken: string;
}

/** 怪猎对决查询匹配响应（CS: EnemyDuelQueryMatchResponse : PlayerDeltaResponse） */
export interface EnemyDuelQueryMatchResponse extends PlayerDeltaResponse {
  result: number;
  team: EnemyDuelTeamInfo | null;
  info?: string;
  playerCnt: number;
}

/** 怪猎对决创建队伍请求（CS: EnemyDuelCreateTeamRequest） */
export interface EnemyDuelCreateTeamRequest {
  activityId: string;
  modeId: string;
}

/** 怪猎对决创建队伍响应（CS: EnemyDuelCreateTeamResponse : PlayerDeltaResponse） */
export interface EnemyDuelCreateTeamResponse extends PlayerDeltaResponse {
  result: number;
  team: EnemyDuelTeamInfo;
}

/** 怪猎对决加入队伍请求（CS: EnemyDuelJoinTeamRequest） */
export interface EnemyDuelJoinTeamRequest {
  activityId: string;
  teamId: string;
}

/** 怪猎对决加入队伍响应（CS: EnemyDuelJoinTeamResponse : PlayerDeltaResponse） */
export interface EnemyDuelJoinTeamResponse extends PlayerDeltaResponse {
  result: number;
  team: EnemyDuelTeamInfo;
}

/** 怪猎对决多人开始战斗请求（CS: EnemyDuelMultiBattleStartRequest） */
export interface EnemyDuelMultiBattleStartRequest {
  activityId: string;
  sceneId: string;
}

/* ===== 怪猎（act24side，参考 ODPY/OBS + CS 2.7.61）===== */

/**
 * 怪猎合成抽奖请求（服务端自定义，CS 无对应类）
 * 参考 ODPY act24alchemy：消耗 act50melding_N 素材计分，每 100 分抽一次奖池
 */
export interface Act24sideAlchemyRequest {
  activityId: string;
  gachaBox: string;
  items: { [key: string]: number };
}

/** 怪猎合成抽奖响应（服务端自定义） */
export interface Act24sideAlchemyResponse extends PlayerDeltaResponse {
  rewards: ItemBundle[];
}

/** 怪猎开始战斗请求（CS: Act24sideBattleStartRequest : DefaultStartBattleRequest + activityId） */
export interface Act24sideBattleStartRequest extends CommonStartBattleRequest {
  activityId: string;
}

/** 怪猎开始战斗响应（CS: Act24sideBattleStartResponse : DefaultStartBattleResponse） */
export interface Act24sideBattleStartResponse extends PlayerDeltaResponse {
  result: number;
  battleId: string;
  apFailReturn: number;
  isApProtect: number;
  inApProtectPeriod: boolean;
  notifyPowerScoreNotEnoughIfFailed: boolean;
}

/** 怪猎战斗结算请求（CS: Act24sideBattleFinishRequest : DefaultFinishBattleRequest + activityId） */
export interface Act24sideBattleFinishRequest {
  activityId: string;
  data: string;
  battleData: { isCheat: string; completeTime: number };
}

/**
 * 怪猎战斗结算响应（CS: Act24sideBattleFinishResponse : DefaultFinishBattleResponse）
 * 基础字段同 quest battleFinish，另加怪猎专属 meldingRewards 三字段（当前无掉落配置返回空）
 */
export interface Act24sideBattleFinishResponse extends PlayerDeltaResponse {
  result?: number;
  apFailReturn?: number;
  expScale?: number;
  goldScale?: number;
  rewards?: ItemBundle[];
  firstRewards?: ItemBundle[];
  unlockStages?: string[];
  unusualRewards?: ItemBundle[];
  additionalRewards?: ItemBundle[];
  furnitureRewards?: ItemBundle[];
  alert?: unknown[];
  suggestFriend?: boolean;
  pryResult?: unknown[];
  meldingRewards: ItemBundle[];
  firstMeldingRewards: ItemBundle[];
  mealMeldingRewards: ItemBundle[];
}

/** 怪猎进食请求（服务端自定义，参考 ODPY act24eat） */
export interface Act24sideEatRequest {
  activityId: string;
  meal: string;
}

/** 怪猎进食响应（服务端自定义） */
export type Act24sideEatResponse = PlayerDeltaResponse;

/** 怪猎设置工具请求（服务端自定义，参考 ODPY/OBS act24setTool） */
export interface Act24sideSetToolRequest {
  activityId: string;
  tools: string[];
}

/** 怪猎设置工具响应（服务端自定义） */
export type Act24sideSetToolResponse = PlayerDeltaResponse;

/** 怪猎获取狩猎收集奖励请求（CS: Act24sideGetHuntWikiRewardRequest） */
export interface Act24sideGetHuntCollectRewardsRequest {
  activityId: string;
}

/** 怪猎获取狩猎收集奖励响应（CS: Act24sideGetHuntWikiRewardResponse） */
export interface Act24sideGetHuntCollectRewardsResponse extends PlayerDeltaResponse {
  rewards: ItemBundle[];
}

/* ===== 生息演算（act25side，根路径挂载，参考 ODPY/OBS + CS 2.7.61）===== */

/**
 * 生息演算开始战斗请求（CS: Act25sideBattleStartRequest : DefaultStartBattleRequest）
 * 复用标准战斗开始（battle.start），同 quest battleStart
 */
export type Act25sideBattleStartRequest = CommonStartBattleRequest;

/** 生息演算开始战斗响应（CS: Act25sideBattleStartResponse : DefaultStartBattleResponse） */
export interface Act25sideBattleStartResponse extends PlayerDeltaResponse {
  result: number;
  battleId: string;
  apFailReturn: number;
  isApProtect: number;
  inApProtectPeriod: boolean;
  notifyPowerScoreNotEnoughIfFailed: boolean;
}

/** 生息演算战斗结算请求（CS: Act25sideBattleFinishRequest : DefaultFinishBattleRequest） */
export interface Act25sideBattleFinishRequest {
  data: string;
  battleData: { isCheat: string; completeTime: number };
}

/** 生息演算战斗结算响应（CS: Act25sideBattleFinishResponse : DefaultFinishBattleResponse） */
export interface Act25sideBattleFinishResponse extends PlayerDeltaResponse {
  result?: number;
  apFailReturn?: number;
  expScale?: number;
  goldScale?: number;
  rewards?: ItemBundle[];
  firstRewards?: ItemBundle[];
  unlockStages?: string[];
  unusualRewards?: ItemBundle[];
  additionalRewards?: ItemBundle[];
  furnitureRewards?: ItemBundle[];
  alert?: unknown[];
  suggestFriend?: boolean;
  pryResult?: unknown[];
}

/** 生息演算每日刷新请求（CS: Act25sideDailyRefreshRequest） */
export interface Act25sideDailyRefreshRequest {
  actId: string;
}

/** 生息演算每日刷新响应（CS: Act25sideDailyRefreshResponse） */
export interface Act25sideDailyRefreshResponse extends PlayerDeltaResponse {
  tokenDelta: number;
  reachRecvMax: boolean;
}

/** 生息演算收获请求（CS: Act25sideDailyHarvestRequest） */
export interface Act25sideHarvestRequest {
  actId: string;
}

/** 生息演算收获响应（CS: Act25sideDailyHarvestResponse） */
export interface Act25sideHarvestResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
  additionalItems: ItemBundle[];
}

/** 生息演算调查请求（CS: Act25sideResearchRequest） */
export interface Act25sideInvestigateRequest {
  actId: string;
  areaId: string;
}

/** 生息演算调查响应（CS: Act25sideResearchResponse） */
export type Act25sideInvestigateResponse = PlayerDeltaResponse;

/** 生息演算完成调查请求（CS: Act25sideFinishInvestigationRequest） */
export interface Act25sideFinishInvestigationRequest {
  actId: string;
  areaId: string;
}

/** 生息演算完成调查响应（CS: Act25sideFinishInvestigationResponse） */
export interface Act25sideFinishInvestigationResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/* ===== 足球（football，参考 ODPY + CS 2.7.61）===== */

/** 足球开始战斗请求（CS: Act1FootballBattleStartRequest） */
export interface FootballBattleStartRequest {
  activityId: string;
  stageId: string;
  squad: PlayerSquad;
  assistFriend: null | SquadFriendData;
}

/** 足球开始战斗响应（CS: Act1FootballBattleStartResponse : DefaultStartBattleResponse） */
export interface FootballBattleStartResponse extends PlayerDeltaResponse {
  result: number;
  battleId: string;
  apFailReturn: number;
  isApProtect: number;
  inApProtectPeriod: boolean;
  notifyPowerScoreNotEnoughIfFailed: boolean;
}

/** 足球战斗结算请求（CS: Act1FootballBattleFinishRequest : DefaultFinishBattleRequest） */
export interface FootballBattleFinishRequest {
  activityId: string;
  data: string;
  battleData: { isCheat: string; completeTime: number };
}

/** 足球战斗结算响应（CS: Act1FootballBattleFinishResponse : DefaultFinishBattleResponse） */
export interface FootballBattleFinishResponse extends PlayerDeltaResponse {
  result?: number;
  apFailReturn?: number;
  expScale?: number;
  goldScale?: number;
  rewards?: ItemBundle[];
  firstRewards?: ItemBundle[];
  unlockStages?: string[];
  unusualRewards?: ItemBundle[];
  additionalRewards?: ItemBundle[];
  furnitureRewards?: ItemBundle[];
  alert?: unknown[];
  suggestFriend?: boolean;
  pryResult?: unknown[];
  enemyScore: number;
  selfScore: number;
  isNewRecord: boolean;
  milestoneBefore: number;
  milestoneAdd: number;
}

/* ===== 生息演算（act29side/act36side/trainingGround，根路径，参考 ODPY 202 stub）===== */

/** 生息演算 act29side 提交旋律请求（服务端自定义） */
export interface Act29sideCommitMelodyRequest {
  activityId?: string;
}

/** 生息演算 act29side 提交旋律响应（服务端自定义） */
export type Act29sideCommitMelodyResponse = PlayerDeltaResponse;

/** 生息演算 act29side 开始大投资请求（服务端自定义） */
export interface Act29sideStartMajorInvestRequest {
  activityId?: string;
}

/** 生息演算 act29side 开始大投资响应（服务端自定义） */
export type Act29sideStartMajorInvestResponse = PlayerDeltaResponse;

/** 生息演算 act29side 合成请求（服务端自定义） */
export interface Act29sideSyncthesizeRequest {
  activityId?: string;
}

/** 生息演算 act29side 合成响应（服务端自定义） */
export type Act29sideSyncthesizeResponse = PlayerDeltaResponse;

/** 生息演算 act36side 确认图鉴奖励请求（服务端自定义，参考 dexnav 活动版） */
export interface Act36sideConfirmDexNavRewardRequest {
  activityId?: string;
  rewardId?: string;
}

/** 生息演算 act36side 确认图鉴奖励响应（服务端自定义） */
export interface Act36sideConfirmDexNavRewardResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/** 训练场开始战斗请求（服务端自定义，参考 ODPY 空 stub） */
export interface TrainingGroundBattleStartRequest {}

/** 训练场开始战斗响应（服务端自定义） */
export type TrainingGroundBattleStartResponse = PlayerDeltaResponse;

/** 训练场战斗结算请求（服务端自定义，参考 ODPY 空 stub） */
export interface TrainingGroundBattleFinishRequest {}

/** 训练场战斗结算响应（服务端自定义） */
export type TrainingGroundBattleFinishResponse = PlayerDeltaResponse;

/* ===== 活动小游戏战斗通用 stub（arcade/act42d0/act1vhalfidle 等）===== */

/** 活动小游戏开始战斗请求（服务端自定义 stub，参考 ODPY 202） */
export interface ActivityMiniBattleStartRequest {}

/** 活动小游戏开始战斗响应（服务端自定义 stub，同 CommonStartBattleResponse 形状） */
export interface ActivityMiniBattleStartResponse extends PlayerDeltaResponse {
  result: number;
  battleId: string;
  apFailReturn: number;
  isApProtect: number;
  inApProtectPeriod: boolean;
  notifyPowerScoreNotEnoughIfFailed: boolean;
}

/** 活动小游戏战斗结算请求（服务端自定义 stub） */
export interface ActivityMiniBattleFinishRequest {
  data?: string;
  battleData?: { isCheat: string; completeTime: number };
  /** act1vhalfidle 结算读取：活动 id / 关卡 id（登记关卡产出；见 act1vhalfidle/logic.ts） */
  activityId?: string;
  stageId?: string;
  completeState?: number;
}

/** 活动小游戏战斗结算响应（服务端自定义 stub，仅增量） */
export type ActivityMiniBattleFinishResponse = PlayerDeltaResponse;

/* ===== 活动小游戏状态接口 stub（act13side/act27side/act35side/act38side/act42side 等）===== */
// 参考 ODPY 均为 202 stub（仅返回空）；请求类型按各模块已知字段声明，未读取字段标可选。

/** 通用活动状态请求（未读取 body 的 stub 路由共用） */
export interface ActivityStubRequest {
  activityId?: string;
}

/** 通用活动状态响应（仅增量） */
export type ActivityStubResponse = PlayerDeltaResponse;

/** 通用活动状态响应（含空 items 列表） */
export interface ActivityStubItemsResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/** act13side 日任务提交请求（CS: Activity.Act13side.*） */
export interface Act13sideDailyMissionCommitRequest {
  activityId?: string;
  missionId?: string;
}

/** act13side 日任务随机/替换请求 */
export interface Act13sideDailyMissionRandomRequest {
  activityId?: string;
  index?: number;
}

/** act35side 卡牌创建请求 */
export interface Act35sideCreateRequest {
  activityId?: string;
}

/** act35side 卡牌购买/处理请求 */
export interface Act35sideBuyRequest {
  activityId?: string;
  cardId?: string;
  goodsId?: string;
}

/**
 * act44side 开始游戏/使用洞悉请求
 *
 * 官方 InformantStartGameRequest / InformantUseInsightRequest（Torappu.UI.Informant），
 * 响应均为纯 PlayerDeltaResponse。
 */
export interface Act44sideStartGameRequest {
  activityId?: string;
}

/**
 * act44side 推进状态请求
 *
 * 官方 InformantNextStateRequest；`state` 为客户端报告的当前 InformantState 数值
 * （ENTRY=0/CHOICE=1/CHOICE_END=2/BEFORE_SINGLE_RESULT=3/SINGLE_RESULT=4/RESULT=5），
 * 服务端据此转移状态机。
 */
export interface Act44sideNextStateRequest {
  activityId?: string;
  state?: number;
}

/** act44side 选择对话请求（官方 InformantSelectChoiceRequest：选项下标 0/1） */
export interface Act44sideSelectChoiceRequest {
  activityId?: string;
  index?: number;
}

/** act46side 开始/移动/开采请求 */
export interface Act46sideGameRequest {
  activityId?: string;
  node?: unknown;
}

/** act42side 领取每日奖励请求 */
export interface Act42sideGetDailyRewardsRequest {
  activityId?: string;
}

/** act1vhalfidle 半挂机请求 */
export interface Act1vhalfidleRequest {
  activityId?: string;
  charInstId?: number;
  techId?: string;
  productId?: string;
  rateId?: string;
  recruitId?: string;
  /** recruitNormal：卡池 id / 任命次数 / 指定干员（服务端读取，见 act1vhalfidle/logic.ts） */
  poolId?: string;
  count?: number;
  charId?: string;
  /** upgradeChar / upgradeSkill / evolveChar：等级 / 技能等级 / 精英化阶段 */
  level?: number;
  skillLvl?: number;
  evolvePhase?: number;
}

/* ===== act1vhalfidle（次生预案半挂机）响应 ===== */

/** 收取产出响应（服务端自定义：milestoneAdd + items） */
export interface Act1vhalfidleHarvestResponse extends PlayerDeltaResponse {
  milestoneAdd: number;
  items: { itemId: string; count: number }[];
}

/** 任命响应（CS: Act1VHalfIdleRecruitNormalResponse { ticketCount }） */
export interface Act1vhalfidleRecruitNormalResponse extends PlayerDeltaResponse {
  ticketCount: number;
}

/** 升级等级响应（CS: Act1VHalfIdleCharUpgradeLevelResponse { charId, currentLvl }） */
export interface Act1vhalfidleCharUpgradeLevelResponse extends PlayerDeltaResponse {
  charId: string;
  currentLvl: number;
}

/** 升级技能响应（CS: Act1VHalfIdleCharUpgradeSkillResponse { charId, currentLvl }） */
export interface Act1vhalfidleCharUpgradeSkillResponse extends PlayerDeltaResponse {
  charId: string;
  currentLvl: number;
}

/** 精英化响应（CS: Act1VHalfIdleCharUpgradeEliteResponse { charId, currentEvolvePhase, item }） */
export interface Act1vhalfidleCharUpgradeEliteResponse extends PlayerDeltaResponse {
  charId: string;
  currentEvolvePhase: number;
  item: ItemBundle | null;
}

/** act45side 确认请求 */
export interface Act45sideConfirmRequest {
  activityId?: string;
  charInstId?: number;
  mailId?: string;
}

/** 抽奖/登录/许愿类 getReward 请求 */
export interface ActivityGetRewardRequest {
  activityId?: string;
  index?: number;
}

/** 活动商店（typeAct5d1）购买请求 */
export interface Act5d1BuyGoodsRequest {
  activityId?: string;
  goodsId?: string;
  runeId?: string;
}

/** 肉鸽里程碑奖励请求（activity/roguelike 已在 roguelike 路由实现，此处仅类型） */
export interface ActivityRoguelikeMilestoneRequest {
  activityId?: string;
  milestoneId?: string;
}
