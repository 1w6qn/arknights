/**
 * 活动路由：act25side（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
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
export const rootRouter = Router();
rootRouter.post("/act25side/battleStart", validateBody(ReqSchema.act25sideBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as Act25sideBattleStartRequest;
  res.send({
    ...(await player.battle.start(body)),
    ...player.delta,
  } satisfies Act25sideBattleStartResponse);
});

/**
 * 生息演算战斗结算
 * @route POST /act25side/battleFinish
 * CS: Act25sideBattleFinishRequest : DefaultFinishBattleRequest；复用标准战斗结算
 */

rootRouter.post("/act25side/battleFinish", validateBody(ReqSchema.act25sideBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as Act25sideBattleFinishRequest;
  // 缺参校验：battle data 缺失时返回业务错误
  if (body.data == null) {
    return res.send({ result: 1, ...player.delta });
  }
  const result = await player.battle.finish({
    data: body.data,
    battleData: body.battleData,
  });
  res.send({
    ...result,
    ...player.delta,
  } satisfies Act25sideBattleFinishResponse);
});

/**
 * 生息演算每日刷新
 * @route POST /act25side/dailyRefresh
 * CS: Act25sideDailyRefreshRequest {actId}；私服简化返回固定 tokenDelta 0
 */

rootRouter.post("/act25side/dailyRefresh", validateBody(ReqSchema.act25sideDailyRefreshSchema), async (req, res) => {
  const player = getPlayer();
  req.body as Act25sideDailyRefreshRequest;
  res.send({
    tokenDelta: 0,
    reachRecvMax: false,
    ...player.delta,
  } satisfies Act25sideDailyRefreshResponse);
});

/**
 * 生息演算收获
 * @route POST /act25side/harvest
 * CS: Act25sideDailyHarvestRequest {actId}；私服简化返回空奖励
 */

rootRouter.post("/act25side/harvest", validateBody(ReqSchema.act25sideHarvestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as Act25sideHarvestRequest;
  res.send({
    items: [],
    additionalItems: [],
    ...player.delta,
  } satisfies Act25sideHarvestResponse);
});

/**
 * 生息演算调查
 * @route POST /act25side/investigate
 * CS: Act25sideResearchRequest {actId, areaId}；仅返回增量
 */

rootRouter.post("/act25side/investigate", validateBody(ReqSchema.act25sideInvestigateSchema), async (req, res) => {
  const player = getPlayer();
  req.body as Act25sideInvestigateRequest;
  res.send(player.delta satisfies Act25sideInvestigateResponse);
});

/**
 * 生息演算完成调查
 * @route POST /act25side/finishInvestigation
 * CS: Act25sideFinishInvestigationRequest {actId, areaId}；私服简化返回空奖励
 */

rootRouter.post("/act25side/finishInvestigation", validateBody(ReqSchema.act25sideInvestigateSchema), async (req, res) => {
  const player = getPlayer();
  req.body as Act25sideFinishInvestigationRequest;
  res.send({
    items: [],
    ...player.delta,
  } satisfies Act25sideFinishInvestigationResponse);
});

/* ===== 其它根路径活动接口（act29side/act36side/trainingGround，参考 ODPY 202 stub）===== */

/** 生息演算 act29side 提交旋律（参考 ODPY act29commitMelody 202 stub） */
export default router;
