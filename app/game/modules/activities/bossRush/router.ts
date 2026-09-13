/**
 * 活动路由：bossRush（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import * as ReqSchema from "../shared/activity.schema";
import { activityDetailJson, isJsonObjectValue } from "../shared/activity-json";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import excel from "@excel/excel";
import config from "@core/config/index";
import {
  ActCheckinvsSignRequest,
  ActCheckinvsSignResponse,
  AutoConfirmMissionsRequest,
  AutoConfirmMissionsResponse,
  ChangeFestivalCharRequest,
  ChangeFestivalCharResponse,
  ConfirmActivityMissionGroupRequest,
  ConfirmActivityMissionGroupResponse,
  ConfirmActivityMissionListRequest,
  ConfirmActivityMissionListResponse,
  ConfirmActivityMissionRequest,
  ConfirmActivityMissionResponse,
  ExchangeActivityShopItemRequest,
  ExchangeActivityShopItemResponse,
  GetActivityCheckInRewardRequest,
  GetActivityCheckInRewardResponse,
  GetActivityCollectionRewardRequest,
  GetActivityCollectionRewardResponse,
  GetActivityShopInfoRequest,
  GetActivityShopInfoResponse,
  GetChainLogInFinalRewardsRequest,
  GetChainLogInFinalRewardsResponse,
  GetChainLogInRewardRequest,
  GetChainLogInRewardResponse,
  GetCheckInRewardRequest,
  GetCheckInRewardResponse,
  GetOpenServerCheckInRewardRequest,
  GetOpenServerCheckInRewardResponse,
  GetSwitchOnlyRewardRequest,
  GetSwitchOnlyRewardResponse,
  RecycleCharmsRequest,
  RecycleCharmsResponse,
  RewardAllMilestoneRequest,
  RewardAllMilestoneResponse,
  RewardMilestoneRequest,
  RewardMilestoneResponse,
  TryGetCharmFirstRewardRequest,
  TryGetCharmFirstRewardResponse,
  BossRushStartBattleRequest,
  BossRushStartBattleResponse,
  BossRushFinishBattleRequest,
  BossRushFinishBattleResponse,
  BossRushRelicSelectRequest,
  BossRushRelicSelectResponse,
  BossRushRelicUpgradeRequest,
  BossRushRelicUpgradeResponse,
  EnemyDuelBattleStartResponse,
  EnemyDuelCreateTeamRequest,
  EnemyDuelCreateTeamResponse,
  EnemyDuelJoinTeamRequest,
  EnemyDuelJoinTeamResponse,
  EnemyDuelMultiBattleFinishRequest,
  EnemyDuelMultiBattleFinishResponse,
  EnemyDuelMultiBattleStartRequest,
  EnemyDuelQueryMatchRequest,
  EnemyDuelQueryMatchResponse,
  EnemyDuelRankInfo,
  EnemyDuelSingleBattleFinishRequest,
  EnemyDuelSingleBattleFinishResponse,
  EnemyDuelSingleBattleStartRequest,
  EnemyDuelStartMatchRequest,
  EnemyDuelStartMatchResponse,
  Act24sideAlchemyRequest,
  Act24sideAlchemyResponse,
  Act24sideBattleFinishRequest,
  Act24sideBattleFinishResponse,
  Act24sideBattleStartRequest,
  Act24sideBattleStartResponse,
  Act24sideEatRequest,
  Act24sideEatResponse,
  Act24sideGetHuntCollectRewardsRequest,
  Act24sideGetHuntCollectRewardsResponse,
  Act24sideSetToolRequest,
  Act24sideSetToolResponse,
  Act25sideBattleFinishRequest,
  Act25sideBattleFinishResponse,
  Act25sideBattleStartRequest,
  Act25sideBattleStartResponse,
  Act25sideDailyRefreshRequest,
  Act25sideDailyRefreshResponse,
  Act25sideFinishInvestigationRequest,
  Act25sideFinishInvestigationResponse,
  Act25sideHarvestRequest,
  Act25sideHarvestResponse,
  Act25sideInvestigateRequest,
  Act25sideInvestigateResponse,
  Act29sideCommitMelodyRequest,
  Act29sideCommitMelodyResponse,
  Act29sideStartMajorInvestRequest,
  Act29sideStartMajorInvestResponse,
  Act29sideSyncthesizeRequest,
  Act29sideSyncthesizeResponse,
  Act36sideConfirmDexNavRewardRequest,
  Act36sideConfirmDexNavRewardResponse,
  FootballBattleFinishRequest,
  FootballBattleFinishResponse,
  FootballBattleStartRequest,
  FootballBattleStartResponse,
  TrainingGroundBattleFinishRequest,
  TrainingGroundBattleFinishResponse,
  TrainingGroundBattleStartRequest,
  TrainingGroundBattleStartResponse,
  Act13sideDailyMissionCommitRequest,
  Act13sideDailyMissionRandomRequest,
  Act1vhalfidleRequest,
  Act35sideBuyRequest,
  Act35sideCreateRequest,
  Act42sideGetDailyRewardsRequest,
  Act44sideNextStateRequest,
  Act44sideSelectChoiceRequest,
  Act44sideStartGameRequest,
  Act45sideConfirmRequest,
  Act46sideGameRequest,
  Act5d1BuyGoodsRequest,
  ActivityGetRewardRequest,
  ActivityMiniBattleFinishRequest,
  ActivityMiniBattleFinishResponse,
  ActivityMiniBattleStartRequest,
  ActivityMiniBattleStartResponse,
  ActivityStubItemsResponse,
  ActivityStubRequest,
  ActivityStubResponse,
} from "../shared/activity";
import { validateBody } from "@core/http/validate-body";

const router = Router();
router.post("/bossRush/battleStart", validateBody(ReqSchema.bossRushStartBattleSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BossRushStartBattleRequest;
  const result = await player.bossRush.battleStart(body);
  if (!result.ok) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send({
    ...result.data,
    ...player.delta,
  } satisfies BossRushStartBattleResponse);
});

/**
 * 尖灭测试战斗结算
 * @route POST /activity/bossRush/battleFinish
 * @param req.body - CS: BossRushFinishBattleRequest（CommonFinishBattleRequest + activityId）
 * @returns 结算信息 + 尖灭专属字段（wave/milestone/token）
 *
 * 复用标准战斗结算（battle.finish：掉落/关卡解锁/图鉴），再按 BossRushManager.battleFinish
 * 数据驱动更新 activity.BOSS_RUSH[activityId] 的 milestone.point / relic.token{current,total} /
 * bestWaveDic[stageId]；wave 从战斗数据 extraBattleInfo 的 bossrush_finished_wave 解析，
 * 加值取 activity.bossRush[actId].stageDropDataMap[stageId][wave]（milestone_point / token_relic）。
 */

router.post("/bossRush/battleFinish", validateBody(ReqSchema.bossRushBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BossRushFinishBattleRequest;
  // 缺参校验：battle data 缺失时返回业务错误，避免解密抛 TypeError → 500
  if (body.data == null) {
    return res.send({ result: 1, ...player.delta });
  }
  const result = await player.bossRush.battleFinish(body);
  res.send({
    ...result,
    ...player.delta,
  } satisfies BossRushFinishBattleResponse);
});

/**
 * 尖灭测试密文选择
 * @route POST /activity/bossRush/relicSelect
 * @param req.body - CS: BossRushRelicSelectRequest（activityId/relicId）
 * @returns 玩家增量
 *
 * 委托 BossRushManager.relicSelect：校验遗物存在且已解锁（空串清除），
 * 写入 relic.selectingRelicId（对齐官服快照结构）。
 */

router.post("/bossRush/relicSelect", validateBody(ReqSchema.bossRushRelicSelectSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BossRushRelicSelectRequest;
  const result = await player.bossRush.relicSelect(body.activityId, body.relicId);
  if (!result.ok) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send(player.delta satisfies BossRushRelicSelectResponse);
});

/**
 * 尖灭测试密文升级
 * @route POST /activity/bossRush/relicUpgrade
 * @param req.body - CS: BossRushRelicUpgradeRequest（activityId/relicId）
 * @returns 玩家增量
 *
 * 委托 BossRushManager.relicUpgrade：数据驱动消耗（relicLevelInfoDataMap 的 needItemCount），
 * 校验已解锁/未满级/代币充足，等级 +1 并扣代币（对齐官服快照结构 unlockedRelicLevelDic）。
 */

router.post("/bossRush/relicUpgrade", validateBody(ReqSchema.bossRushRelicUpgradeSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BossRushRelicUpgradeRequest;
  const result = await player.bossRush.relicUpgrade(body.activityId, body.relicId);
  if (!result.ok) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send(player.delta satisfies BossRushRelicUpgradeResponse);
});

/* ===== 怪猎对决（enemyDuel，参考 ODPY activity.py enemyDuel + OBS misc_bp + CS 2.7.61）===== */

/** 匹配状态（参考 OBS extra_save 保存 activityId/modeId 供 queryMatch 构建 serverToken） */
let enemyDuelMatchState: { activityId: string; modeId: string } | null = null;

/** 生成怪猎对决 battleId/teamId（怪猎为特殊轮次战斗，参考 ODPY 固定 battleId stub） */
function genEnemyDuelId(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(
    16,
    20,
  )}-${out.slice(20)}`;
}

/** 私服多人在线地址（无真实多人在线，指向本服） */
function enemyDuelServerAddress(): string {
  return `${String(config.Host).replace(/^https?:\/\//, "")}:${config.PORT}`;
}

/** 构建怪猎对决结算响应（玩家成绩 + 活动表 NPC 填充排行榜，参考 ODPY/OBS） */
function buildEnemyDuelFinishResponse(
  activityId: string,
  clientRankList?: EnemyDuelRankInfo[],
) {
  const rankList: EnemyDuelRankInfo[] = clientRankList?.length
    ? clientRankList
    : [{ id: "1", rank: 1, score: 0, isPlayer: 1 }];
  const npcData = activityDetailJson(excel.ActivityTable.activity, "ENEMY_DUEL", activityId)?.["npcData"];
  let rank = 2;
  for (const npcId of isJsonObjectValue(npcData) ? Object.keys(npcData) : []) {
    if (rankList.length >= 8) break;
    rankList.push({ id: npcId, rank: rank++, score: 0, isPlayer: 0 });
  }
  return {
    result: 0,
    apFailReturn: 0,
    itemReturn: [],
    rewards: [],
    unusualRewards: [],
    overrideRewards: [],
    additionalRewards: [],
    diamondMaterialRewards: [],
    furnitureRewards: [],
    goldScale: 0,
    expScale: 0,
    firstRewards: [],
    unlockStages: null,
    pryResult: [],
    alert: [],
    suggestFriend: false,
    extra: null,
    choiceCnt: { skip: 0, normal: 5, allIn: 1 },
    commentId: "Comment_Operation_1",
    isHighScore: false,
    rankList,
    dailyMission: { add: 0, reward: 0 },
    bp: 0,
  };
}

/**
 * 怪猎对决单人开始战斗
 * @route POST /activity/enemyDuel/singleBattleStart
 * CS: EnemyDuelSingleBattleStartRequest {activityId, modeId}；怪猎为特殊轮次战斗，
 * 参考 ODPY/OBS 返回固定 battleId stub（不落 battleInfo，结算独立处理）
 */
export default router;
