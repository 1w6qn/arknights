/**
 * 活动路由：act42side（由 router/activity.ts 拆分而来，实现未改动）
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
router.post("/act42side/getDailyRewards", validateBody(ReqSchema.act42sideGetDailyRewardsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as Act42sideGetDailyRewardsRequest;
  // 参考 ODPY：写 TYPE_ACT42SIDE[activityId].dailyRewardState = 0
  await player.update(async (draft) => {
    const act = draft.activity.TYPE_ACT42SIDE;
    if (!act) return;
    const entry = act[body.activityId!] ?? (act[body.activityId!] = {});
    entry.dailyRewardState = 0;
  });
  res.send(player.delta satisfies ActivityStubResponse);
});

router.post("/act42side/getDailyTrustedItem", validateBody(ReqSchema.act42sideGetDailyRewardsSchema), async (req, res) => {
  const player = getPlayer();
  req.body as Act42sideGetDailyRewardsRequest;
  res.send({
    items: [],
    ...player.delta,
  } satisfies ActivityStubItemsResponse);
});

router.post("/act42side/acceptTask", validateBody(ReqSchema.act42sideTaskSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as { activityId?: string; taskId?: string };
  // 参考 ODPY：写 taskMap[taskId] = 2（接取）
  await player.update(async (draft) => {
    const act = draft.activity.TYPE_ACT42SIDE;
    if (!act) return;
    const entry = act[body.activityId!] ?? (act[body.activityId!] = {});
    if (!entry.taskMap) entry.taskMap = {};
    entry.taskMap[body.taskId!] = 2;
  });
  res.send(player.delta satisfies ActivityStubResponse);
});

router.post("/act42side/confirmTask", validateBody(ReqSchema.act42sideTaskSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as { activityId?: string; taskId?: string };
  // 参考 ODPY：写 taskMap[taskId] = 4（完成）
  await player.update(async (draft) => {
    const act = draft.activity.TYPE_ACT42SIDE;
    if (!act) return;
    const entry = act[body.activityId!] ?? (act[body.activityId!] = {});
    if (!entry.taskMap) entry.taskMap = {};
    entry.taskMap[body.taskId!] = 4;
  });
  res.send(player.delta satisfies ActivityStubResponse);
});

// act44side（「墟」情报屋）：状态机实现在 @game/modules/activities/act44side/informant，
// 协议形状以官服抓包为准（activity.TYPE_ACT44SIDE[actId].game，见 spec
// .trae/specs/act44side-informant/spec.md）；响应均为纯 PlayerDeltaResponse。
/**
 * 开始新营业日（发槽位 0 特殊顾客）
 * @route POST /act44side/startGame
 */
export default router;
