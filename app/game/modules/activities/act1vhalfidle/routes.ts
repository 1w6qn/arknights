/**
 * 活动路由：act1vhalfidle（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import { miniBattleStart, miniBattleFinish } from "../shared/shared";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { now } from "@utils/time";
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
import { handleAct1vhalfidlebattleStart, handleAct1vhalfidlebattleFinish, handleAct1vhalfidlerefreshProduct, handleAct1vhalfidleharvest, handleAct1vhalfidleunlockTech, handleAct1vhalfidlerecruitNormal, handleAct1vhalfidlerecruitDirect, handleAct1vhalfidleupgradeChar, handleAct1vhalfidleupgradeSkill, handleAct1vhalfidleevolveChar, handleAct1vhalfidlereplaceRate, handleAct1vhalfidlesetAssistChar } from "./logic";

router.post("/act1vhalfidle/battleStart", validateBody(ReqSchema.activityMiniBattleStartSchema), async (req, res) => {
  res.send(await handleAct1vhalfidlebattleStart(getPlayer(), req.body as ActivityMiniBattleStartRequest));
});

router.post("/act1vhalfidle/battleFinish", validateBody(ReqSchema.act1vhalfidleBattleFinishSchema), async (req, res) => {
  res.send(await handleAct1vhalfidlebattleFinish(getPlayer(), req.body as ActivityMiniBattleFinishRequest));
});

router.post("/act1vhalfidle/refreshProduct", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidlerefreshProduct(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/harvest", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidleharvest(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/unlockTech", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidleunlockTech(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/recruitNormal", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidlerecruitNormal(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/recruitDirect", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidlerecruitDirect(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/upgradeChar", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidleupgradeChar(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/upgradeSkill", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidleupgradeSkill(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/evolveChar", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidleevolveChar(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/replaceRate", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidlereplaceRate(getPlayer(), req.body as Act1vhalfidleRequest));
});

router.post("/act1vhalfidle/setAssistChar", validateBody(ReqSchema.act1vhalfidleSchema), async (req, res) => {
  res.send(await handleAct1vhalfidlesetAssistChar(getPlayer(), req.body as Act1vhalfidleRequest));
});

export default router;
