/**
 * 活动路由：checkin（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import { ItemTypeToString } from "../shared/shared";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { ItemBundle, ItemType } from "@excel/excel";
import excel from "@excel/excel";
import { now } from "@utils/time";
import { activityDictKey } from "../shared/unlockActivity";
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
  CheckinAllPlayerCheckinRequest,
  CheckinAllPlayerGetAllRewardRequest,
  CheckinAllPlayerSyncRequest,
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
  LoginOnlyGetRewardRequest,
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
import {
  handleGetChainLogInReward,
  handleGetChainLogInFinalRewards,
  handleGetOpenServerCheckInReward,
  handleGetActivityCheckInReward,
  handleActCheckinvssign,
  handleGetSwitchOnlyReward,
  handleGetCheckInReward,
  handleChangeFestivalChar,
  handleActBlessOnlygetCheckInReward,
  handleActBlessOnlychangeFestivalChar,
  handleActCheckinAccessgetCheckInReward,
  handleYear5GeneralgetInfReward,
  handleLoginOnlyGetReward,
  handleCheckinAllPlayerCheckin,
  handleCheckinAllPlayerSync,
  handleCheckinAllPlayerGetAllReward,
} from "./logic";

router.post("/getChainLogInReward", validateBody(ReqSchema.getChainLogInRewardSchema), async (req, res) => {
  res.send(await handleGetChainLogInReward(getPlayer(), req.body as GetChainLogInRewardRequest));
});

router.post("/getChainLogInFinalRewards", validateBody(ReqSchema.getChainLogInFinalRewardsSchema), async (req, res) => {
  res.send(await handleGetChainLogInFinalRewards(getPlayer(), req.body as GetChainLogInFinalRewardsRequest));
});

router.post("/getOpenServerCheckInReward", validateBody(ReqSchema.getOpenServerCheckInRewardSchema), async (req, res) => {
  res.send(await handleGetOpenServerCheckInReward(getPlayer(), req.body as GetOpenServerCheckInRewardRequest));
});

router.post("/getActivityCheckInReward", validateBody(ReqSchema.getActivityCheckInRewardSchema), async (req, res) => {
  res.send(await handleGetActivityCheckInReward(getPlayer(), req.body as GetActivityCheckInRewardRequest));
});

router.post("/actCheckinvs/sign", validateBody(ReqSchema.actCheckinvsSignSchema), async (req, res) => {
  res.send(await handleActCheckinvssign(getPlayer(), req.body as ActCheckinvsSignRequest));
});

router.post("/getSwitchOnlyReward", validateBody(ReqSchema.getSwitchOnlyRewardSchema), async (req, res) => {
  res.send(await handleGetSwitchOnlyReward(getPlayer(), req.body as GetSwitchOnlyRewardRequest));
});

router.post("/loginOnly/getReward", validateBody(ReqSchema.loginOnlyGetRewardSchema), async (req, res) => {
  res.send(await handleLoginOnlyGetReward(getPlayer(), req.body as LoginOnlyGetRewardRequest));
});

/**
 * 许愿墙登录奖励（PRAY_ONLY）
 * TODO：本地 excel 无 PRAY_ONLY 活动配置（activity_table.json 仅 basicInfo/homeActConfig/dynActs，
 * 无 prayData 奖励表），无法从表推导奖励；官服抓包见 tmp/capture（prayArray 请求 + DIAMOND_SHD 奖励），
 * 待数据源补全后按 excel 实现，当前返回空增量避免客户端 404。
 */
router.post("/prayOnly/getReward", validateBody(ReqSchema.activityGetRewardSchema), async (req, res) => {
  res.send({
    rewards: [],
    ...getPlayer().delta,
  });
});

/**
 * 登录独有奖励（UNIQUE_ONLY）
 * TODO：本地 excel 无 UNIQUE_ONLY 活动配置（activity_table.json 仅 basicInfo），无法从表推导奖励；
 * 官服抓包 R-1786876473005-0023（voucher/avatar/gallery 奖励），待数据源补全后按 excel 实现。
 */
router.post("/loginOnlyUnique/getReward", validateBody(ReqSchema.activityGetRewardSchema), async (req, res) => {
  res.send({
    reward: [],
    ...getPlayer().delta,
  });
});

/**
 * 视频签到奖励（CHECKIN_VIDEO）
 * TODO：本地 excel 无 CHECKIN_VIDEO 活动配置（activity_table.json 仅 basicInfo），无法从表推导奖励；
 * 客户端路径 /activity/getActivityCheckInVideoReward（ArknightsGameData Lua CheckinVideoServiceCode），
 * 待数据源补全后按 excel 实现，当前返回空增量避免客户端 404。
 */
router.post("/getActivityCheckInVideoReward", validateBody(ReqSchema.activityGetRewardSchema), async (req, res) => {
  res.send({
    items: [],
    ...getPlayer().delta,
  });
});

router.post("/checkinAllPlayer/getActivityCheckInReward", validateBody(ReqSchema.checkinAllPlayerCheckinSchema), async (req, res) => {
  res.send(await handleCheckinAllPlayerCheckin(getPlayer(), req.body as CheckinAllPlayerCheckinRequest));
});

router.post("/checkinAllPlayer/syncBehaviorData", validateBody(ReqSchema.checkinAllPlayerSyncSchema), async (req, res) => {
  res.send(await handleCheckinAllPlayerSync(getPlayer(), req.body as CheckinAllPlayerSyncRequest));
});

router.post("/checkinAllPlayer/getAllBehaviorReward", validateBody(ReqSchema.checkinAllPlayerGetAllRewardSchema), async (req, res) => {
  res.send(await handleCheckinAllPlayerGetAllReward(getPlayer(), req.body as CheckinAllPlayerGetAllRewardRequest));
});

router.post("/getCheckInReward", validateBody(ReqSchema.getCheckInRewardSchema), async (req, res) => {
  res.send(await handleGetCheckInReward(getPlayer(), req.body as GetCheckInRewardRequest));
});

router.post("/changeFestivalChar", validateBody(ReqSchema.changeFestivalCharSchema), async (req, res) => {
  res.send(await handleChangeFestivalChar(getPlayer(), req.body as ChangeFestivalCharRequest));
});

router.post("/actBlessOnly/getCheckInReward", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  res.send(await handleActBlessOnlygetCheckInReward(getPlayer(), req.body as ActivityStubRequest));
});

router.post("/actBlessOnly/changeFestivalChar", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  res.send(await handleActBlessOnlychangeFestivalChar(getPlayer(), req.body as ActivityStubRequest));
});

router.post("/actCheckinAccess/getCheckInReward", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  res.send(await handleActCheckinAccessgetCheckInReward(getPlayer(), req.body as ActivityStubRequest));
});

router.post("/year5General/getInfReward", validateBody(ReqSchema.activityGetRewardSchema), async (req, res) => {
  res.send(await handleYear5GeneralgetInfReward(getPlayer(), req.body as ActivityGetRewardRequest));
});

export default router;

export const rootRouter = Router();
rootRouter.post("/actcheckinvs/sign", validateBody(ReqSchema.actCheckinvsSignSchema), async (req, res) => {
  res.send(await handleActCheckinvssign(getPlayer(), req.body as ActCheckinvsSignRequest));
});

/** 训练场开始战斗（参考 ODPY trainingGroundBattleStart 空 stub） */
