/**
 * 活动路由：milestone（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import { confirmOneActivityMission, autoConfirmActivityMissionsIn, ItemTypeToString } from "../shared/shared";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { ItemBundle } from "@excel/excel";
import excel from "@excel/excel";
import { logger } from "@utils/logger";
import { activityDictKey } from "../shared/unlockActivity";
import { recordPurchase } from "../../pay/public";
import {
  informantNextState,
  informantSelectChoice,
  informantStartGame,
  informantUseInsight,
  resolveAct44Data,
} from "../act44side/public";
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
import { handleRewardMilestone, handleRewardAllMilestone, handleConfirmActivityMission, handleConfirmActivityMissionList, handleConfirmActivityMissionGroup, handleAutoConfirmMissions, handleExchangeActivityShopItem, handleGetActivityCollectionReward, handleGetActivityShopInfo } from "./logic";
router.post("/rewardMilestone", validateBody(ReqSchema.rewardMilestoneSchema), async (req, res) => {
  res.send(await handleRewardMilestone(getPlayer(), req.body as RewardMilestoneRequest));
});

router.post("/rewardAllMilestone", validateBody(ReqSchema.rewardAllMilestoneSchema), async (req, res) => {
  res.send(await handleRewardAllMilestone(getPlayer(), req.body as RewardAllMilestoneRequest));
});

router.post("/confirmActivityMission", validateBody(ReqSchema.confirmActivityMissionSchema), async (req, res) => {
  res.send(await handleConfirmActivityMission(getPlayer(), req.body as ConfirmActivityMissionRequest));
});

router.post("/confirmActivityMissionList", validateBody(ReqSchema.confirmActivityMissionListSchema), async (req, res) => {
  res.send(await handleConfirmActivityMissionList(getPlayer(), req.body as ConfirmActivityMissionListRequest));
});

router.post("/confirmActivityMissionGroup", validateBody(ReqSchema.confirmActivityMissionGroupSchema), async (req, res) => {
  res.send(await handleConfirmActivityMissionGroup(getPlayer(), req.body as ConfirmActivityMissionGroupRequest));
});

router.post("/autoConfirmMissions", validateBody(ReqSchema.autoConfirmMissionsSchema), async (req, res) => {
  res.send(await handleAutoConfirmMissions(getPlayer(), req.body as AutoConfirmMissionsRequest));
});

router.post("/exchangeActivityShopItem", validateBody(ReqSchema.exchangeActivityShopItemSchema), async (req, res) => {
  res.send(await handleExchangeActivityShopItem(getPlayer(), req.body as ExchangeActivityShopItemRequest));
});

router.post("/getActivityCollectionReward", validateBody(ReqSchema.getActivityCollectionRewardSchema), async (req, res) => {
  res.send(await handleGetActivityCollectionReward(getPlayer(), req.body as GetActivityCollectionRewardRequest));
});

router.post("/getActivityShopInfo", validateBody(ReqSchema.getActivityShopInfoSchema), async (req, res) => {
  res.send(await handleGetActivityShopInfo(getPlayer(), req.body as GetActivityShopInfoRequest));
});

export default router;
