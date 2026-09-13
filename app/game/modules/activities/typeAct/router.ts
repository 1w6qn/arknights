/**
 * 活动路由：typeAct（由 router/activity.ts 拆分而来，实现未改动）
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
router.post("/typeAct3d0/selectFaction", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});

router.post("/typeAct3d0/gacha", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});

router.post("/typeAct3d0/getGachaInfo", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});

router.post("/typeAct3d0/getMilestoneReward", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send({
    items: [],
    ...player.delta,
  } satisfies ActivityStubItemsResponse);
});

// typeAct4d0 / typeAct5d0 / typeAct9d0（剧情类）
for (const typeAct4d0Route of ["finishStory", "getReward", "unlockStory"]) {
  router.post(`/typeAct4d0/${typeAct4d0Route}`, validateBody(ReqSchema.activityStubSchema), async (req, res) => {
    const player = getPlayer();
    req.body as ActivityStubRequest;
    res.send({
      items: [],
      ...player.delta,
    } satisfies ActivityStubItemsResponse);
  });
}

router.post("/typeAct5d0/getReward", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send({
    items: [],
    ...player.delta,
  } satisfies ActivityStubItemsResponse);
});

router.post("/typeAct9d0/readNews", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});

// typeAct5d1（危机合约类）

router.post("/typeAct5d1/getInfo", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});

router.post("/typeAct5d1/getGoodsList", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});

router.post("/typeAct5d1/buyGoods", validateBody(ReqSchema.act5d1BuyGoodsSchema), async (req, res) => {
  const player = getPlayer();
  req.body as Act5d1BuyGoodsRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});

router.post("/typeAct5d1/buyRune", validateBody(ReqSchema.act5d1BuyGoodsSchema), async (req, res) => {
  const player = getPlayer();
  req.body as Act5d1BuyGoodsRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});

// typeAct20side（展会）
for (const typeAct20sideRoute of [
  "competitionStart",
  "competitionFinish",
  "confirmExhiCar",
  "judge",
  "pick",
  "quickGetMilestoneAward",
  "quickRecycle",
]) {
  router.post(`/typeAct20side/${typeAct20sideRoute}`, validateBody(ReqSchema.activityStubSchema), async (req, res) => {
    const player = getPlayer();
    req.body as ActivityStubRequest;
    res.send({
      items: [],
      ...player.delta,
    } satisfies ActivityStubItemsResponse);
  });
}

// autochessSeason（自走棋赛季，多人流程 stub）
for (const autochessSeasonRoute of [
  "createTeam",
  "joinTeam",
  "queryMatch",
  "startMatch",
  "syncInfo",
  "quitSingleGame",
  "startGuideBattle",
  "finishGuideBattle",
  "multiBattleStart",
  "multiBattleFinish",
  "settleGame",
  "settleLike",
  "report",
  "getFriendCharAssistList",
  "setChessPoolAssist",
  "setChessPoolDeploy",
  "setChessPoolDiyChar",
  "removeChessPoolChar",
]) {
  router.post(`/autochessSeason/${autochessSeasonRoute}`, validateBody(ReqSchema.activityStubSchema), async (req, res) => {
    const player = getPlayer();
    req.body as ActivityStubRequest;
    res.send(player.delta satisfies ActivityStubResponse);
  });
}

/**
 * 生息演算开始战斗
 * @route POST /act25side/battleStart
 * CS: Act25sideBattleStartRequest : DefaultStartBattleRequest；复用标准战斗开始
 */
export const rootRouter = Router();

export default router;
