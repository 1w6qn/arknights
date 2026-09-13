/**
 * 活动路由：enemyDuel（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import excel from "@excel/excel";
import config from "@core/config/index";
import * as ReqSchema from "../shared/activity.schema";
import { activityDetailJson, isJsonObjectValue } from "../shared/activity-json";

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
import { validateBody } from "../../../kernel/http/validate-body";
import { getEnemyDuelSessionAddress } from "./public";

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

/**
 * 会话服对外地址（客户端拿 serverAddress 后 TCP 连过去）
 *
 * 会话服已启动时用其实际监听端口（端口避让后仍正确）；未启动回退配置端口/HTTP 端口
 * （客户端连不上会超时，等价旧的 stub 行为）。
 */
function enemyDuelServerAddress(): string {
  const running = getEnemyDuelSessionAddress();
  if (running) return running;
  const host = String(config.Host).replace(/^https?:\/\//, "");
  return `${host}:${config.multiplayer?.port ?? config.PORT}`;
}

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

const router = Router();
router.post("/enemyDuel/singleBattleStart", validateBody(ReqSchema.enemyDuelSingleBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  req.body as EnemyDuelSingleBattleStartRequest;
  res.send({
    result: 0,
    battleId: genEnemyDuelId(),
    apFailReturn: 0,
    isApProtect: 0,
    inApProtectPeriod: false,
    notifyPowerScoreNotEnoughIfFailed: false,
    ...player.delta,
  } satisfies EnemyDuelBattleStartResponse);
});

/**
 * 怪猎对决单人战斗结算
 * @route POST /activity/enemyDuel/singleBattleFinish
 * CS: EnemyDuelSingleBattleFinishRequest : CommonFinishBattleRequest + settle/surviveUnits/bornUnits；
 * 结算返回排行榜（settle.rankList + 活动表 NPC 填充）与怪猎专属字段
 */

router.post("/enemyDuel/singleBattleFinish", validateBody(ReqSchema.enemyDuelSingleBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EnemyDuelSingleBattleFinishRequest;
  res.send({
    ...buildEnemyDuelFinishResponse(body.activityId, body.settle?.rankList),
    ...player.delta,
  } satisfies EnemyDuelSingleBattleFinishResponse);
});

/**
 * 怪猎对决开始匹配
 * @route POST /activity/enemyDuel/startMatch
 * CS: EnemyDuelStartMatchRequest {activityId, modeId}；记录匹配状态供 queryMatch 使用
 */

router.post("/enemyDuel/startMatch", validateBody(ReqSchema.enemyDuelStartMatchSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EnemyDuelStartMatchRequest;
  enemyDuelMatchState = { activityId: body.activityId, modeId: body.modeId };
  res.send({ result: 0, ...player.delta } satisfies EnemyDuelStartMatchResponse);
});

/**
 * 怪猎对决查询匹配
 * @route POST /activity/enemyDuel/queryMatch
 * CS: EnemyDuelQueryMatchRequest {activityId, needLeave}；返回队伍信息
 * （serverToken = modeId|curStage，curStage 取玩家 ENEMY_DUEL modeInfo）
 */

router.post("/enemyDuel/queryMatch", validateBody(ReqSchema.enemyDuelQueryMatchSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EnemyDuelQueryMatchRequest;
  if (body.needLeave || !enemyDuelMatchState) {
    return res.send({
      result: 1,
      team: null,
      playerCnt: 0,
      ...player.delta,
    } satisfies EnemyDuelQueryMatchResponse);
  }
  const { activityId, modeId } = enemyDuelMatchState;
  const modeInfo = player._playerdata.activity?.ENEMY_DUEL?.[activityId]?.modeInfo;
  const curStage = modeInfo?.[modeId]?.curStage ?? "";
  res.send({
    result: 0,
    team: {
      teamId: genEnemyDuelId(),
      serverAddress: enemyDuelServerAddress(),
      serverToken: `${modeId}|${curStage}`,
    },
    playerCnt: 8,
    ...player.delta,
  } satisfies EnemyDuelQueryMatchResponse);
});

/**
 * 怪猎对决创建队伍
 * @route POST /activity/enemyDuel/createTeam
 * CS: EnemyDuelCreateTeamRequest {activityId, modeId}；私服无真实多人，返回固定队伍 stub
 */

router.post("/enemyDuel/createTeam", validateBody(ReqSchema.enemyDuelCreateTeamSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EnemyDuelCreateTeamRequest;
  res.send({
    result: 0,
    team: {
      teamId: genEnemyDuelId(),
      serverAddress: enemyDuelServerAddress(),
      serverToken: `${body.modeId}|create`,
    },
    ...player.delta,
  } satisfies EnemyDuelCreateTeamResponse);
});

/**
 * 怪猎对决加入队伍
 * @route POST /activity/enemyDuel/joinTeam
 * CS: EnemyDuelJoinTeamRequest {activityId, teamId}；私服无真实多人，返回队伍 stub
 */

router.post("/enemyDuel/joinTeam", validateBody(ReqSchema.enemyDuelJoinTeamSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EnemyDuelJoinTeamRequest;
  res.send({
    result: 0,
    team: {
      teamId: body.teamId,
      serverAddress: enemyDuelServerAddress(),
      serverToken: "join",
    },
    ...player.delta,
  } satisfies EnemyDuelJoinTeamResponse);
});

/**
 * 怪猎对决多人开始战斗
 * @route POST /activity/enemyDuel/multiBattleStart
 * CS: EnemyDuelMultiBattleStartRequest {activityId, sceneId}；同单人，返回 battleId stub
 */

router.post("/enemyDuel/multiBattleStart", validateBody(ReqSchema.enemyDuelMultiBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  req.body as EnemyDuelMultiBattleStartRequest;
  res.send({
    result: 0,
    battleId: genEnemyDuelId(),
    apFailReturn: 0,
    isApProtect: 0,
    inApProtectPeriod: false,
    notifyPowerScoreNotEnoughIfFailed: false,
    ...player.delta,
  } satisfies EnemyDuelBattleStartResponse);
});

/**
 * 怪猎对决多人战斗结算
 * @route POST /activity/enemyDuel/multiBattleFinish
 * CS: EnemyDuelMultiBattleFinishRequest : CommonFinishBattleRequest + sceneId；
 * 响应同单人结算（含 rankList/choiceCnt 等怪猎专属字段）
 */

router.post("/enemyDuel/multiBattleFinish", validateBody(ReqSchema.enemyDuelMultiBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EnemyDuelMultiBattleFinishRequest;
  res.send({
    ...buildEnemyDuelFinishResponse(body.activityId),
    ...player.delta,
  } satisfies EnemyDuelMultiBattleFinishResponse);
});

/* ===== 怪猎（act24side，参考 ODPY activity.py act24side + OBS misc_bp + CS 2.7.61）===== */

/**
 * 怪猎合成抽奖
 * @route POST /activity/act24side/alchemy
 * 参考 ODPY act24alchemy：消耗 act50melding_N 素材计分（2/3/5/10/20/200 分），
 * 每 100 分从 meldingGachaBoxGoodDataMap[gachaBox] 抽一次（不重复抽完即止），
 * 奖励经 items:get 发放，抽中记录写入 activity.TYPE_ACT24SIDE[activityId].alchemy.gacha
 */
export default router;
