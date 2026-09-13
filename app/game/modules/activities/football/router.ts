/**
 * 活动路由：football（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { PlayerDataManager } from "../../../kernel/PlayerDataManager";
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
router.post("/football/battleStart", validateBody(ReqSchema.footballBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  req.body as FootballBattleStartRequest;
  res.send({
    result: 0,
    battleId: "abcdefgh-1234-5678-a1b2c3d4e5f6",
    apFailReturn: 0,
    isApProtect: 0,
    inApProtectPeriod: false,
    notifyPowerScoreNotEnoughIfFailed: false,
    ...player.delta,
  } satisfies FootballBattleStartResponse);
});

/**
 * 足球战斗结算
 * @route POST /activity/football/battleFinish
 * CS: Act1FootballBattleFinishResponse : DefaultFinishBattleResponse
 * 参考 ODPY footballBattleFinish：固定比分（selfScore 99 胜）与里程碑加值 0
 */

router.post("/football/battleFinish", validateBody(ReqSchema.footballBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  req.body as FootballBattleFinishRequest;
  res.send({
    result: 0,
    apFailReturn: 0,
    expScale: 0,
    goldScale: 0,
    rewards: [],
    firstRewards: [],
    unlockStages: [],
    unusualRewards: [],
    additionalRewards: [],
    furnitureRewards: [],
    alert: [],
    suggestFriend: false,
    pryResult: [],
    enemyScore: 0,
    selfScore: 99,
    isNewRecord: true,
    milestoneBefore: 0,
    milestoneAdd: 0,
    ...player.delta,
  } satisfies FootballBattleFinishResponse);
});

/* ===== 活动小游戏 stub 批量（参考 ODPY 均为 202 stub；arcade/act42d0/act1vhalfidle 战斗走标准 stub）===== */

/** 活动小游戏战斗开始 stub（arcade/act42d0/act1vhalfidle/typeAct20side 等共用） */
function miniBattleStart(player: PlayerDataManager) {
  return {
    result: 0,
    battleId: "abcdefgh-1234-5678-a1b2c3d4e5f6",
    apFailReturn: 0,
    isApProtect: 0,
    inApProtectPeriod: false,
    notifyPowerScoreNotEnoughIfFailed: false,
    ...player.delta,
  } satisfies ActivityMiniBattleStartResponse;
}

/** 活动小游戏战斗结算 stub（仅返回增量） */
function miniBattleFinish(player: PlayerDataManager, body: ActivityMiniBattleFinishRequest) {
  reqBodyRef(body);
  return player.delta satisfies ActivityMiniBattleFinishResponse;
}

/** 引用请求体（满足 req.body as XxxRequest 接线约定，实际不读取） */
function reqBodyRef(_body: ActivityMiniBattleFinishRequest): void {
  /* 无操作：stub 路由不读取请求体 */
}

// arcade（街机）
export default router;
