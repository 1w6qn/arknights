/**
 * 活动路由：act13side（由 router/activity.ts 拆分而来，实现未改动）
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
router.post("/act13side/clearFlag", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActivityStubRequest;
  res.send(player.delta satisfies ActivityStubResponse);
});
for (const act13sideRoute of [
  "dailyMissionAccept",
  "dailyMissionCancel",
  "dailyMissionReplace",
  "longMissionCommit",
  "longMissionCommitBatch",
]) {
  router.post(`/act13side/${act13sideRoute}`, validateBody(ReqSchema.act13sideDailyMissionCommitSchema), async (req, res) => {
    const player = getPlayer();
    req.body as Act13sideDailyMissionCommitRequest;
    res.send({
      items: [],
      ...player.delta,
    } satisfies ActivityStubItemsResponse);
  });
}
for (const act13sideRoute of ["dailyMissionCommit", "dailyMissionRandom"]) {
  router.post(`/act13side/${act13sideRoute}`, validateBody(ReqSchema.act13sideDailyMissionRandomSchema), async (req, res) => {
    const player = getPlayer();
    req.body as Act13sideDailyMissionRandomRequest;
    res.send({
      items: [],
      ...player.delta,
    } satisfies ActivityStubItemsResponse);
  });
}

// act27side（售卖小游戏）
for (const act27sideRoute of [
  "inquirePurchase",
  "inquireSell",
  "nextDay",
  "purchase",
  "saleSettle",
  "saleStart",
  "sell",
]) {
  router.post(`/act27side/${act27sideRoute}`, validateBody(ReqSchema.activityStubSchema), async (req, res) => {
    const player = getPlayer();
    req.body as ActivityStubRequest;
    res.send(player.delta satisfies ActivityStubResponse);
  });
}

// act35side（卡牌合成）
export default router;
