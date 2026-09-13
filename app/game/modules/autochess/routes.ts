/**
 * 自走棋（AutoChess，卫戍协议）赛季路由
 *
 * 客户端路由前缀 /activity/autochessSeason/*（reference/client-routes.txt 90-107 行）；
 * 本 router 以 /autochessSeason/* 相对路径注册，由 app/game/routes.ts 挂载于
 * /activity 与 /autochess 两个前缀下。请求/响应类型见 ./autochess.protocol。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import { emptyAutoChessFinishPayload } from "./autochess";
import {
  autoChessCreateTeamSchema,
  autoChessGetFriendAssistListSchema,
  autoChessJoinTeamSchema,
  autoChessMultiBattleFinishSchema,
  autoChessMultiBattleStartSchema,
  autoChessQueryMatchSchema,
  autoChessQuitSingleGameSchema,
  autoChessRemoveChessPoolCharSchema,
  autoChessReportSchema,
  autoChessSeasonEntrySchema,
  autoChessSettleGameSchema,
  autoChessSettleLikeSchema,
  autoChessSetChessPoolAssistSchema,
  autoChessSetChessPoolDeploySchema,
  autoChessSetChessPoolDiyCharSchema,
  autoChessStartMatchSchema,
  autoChessSyncInfoSchema,
  autoChessTrainingBattleFinishSchema,
  autoChessTrainingBattleStartSchema,
} from "./autochess.schema";
import type {
  ActAutoChessSyncInfoRequest,
  ActAutoChessSyncInfoResponse,
  AutoChessCreateTeamRequest,
  AutoChessCreateTeamResponse,
  AutoChessFinishBattleResponse,
  AutoChessGetFriendAssistListRequest,
  AutoChessGetFriendAssistListResponse,
  AutoChessJoinTeamRequest,
  AutoChessJoinTeamResponse,
  AutoChessMultiBattleFinishRequest,
  AutoChessMultiBattleStartRequest,
  AutoChessQueryMatchRequest,
  AutoChessQueryMatchResponse,
  AutoChessQuitSingleGameRequest,
  AutoChessQuitSingleGameResponse,
  AutoChessRemoveChessPoolCharRequest,
  AutoChessRemoveChessPoolCharResponse,
  AutoChessReportRequest,
  AutoChessReportResponse,
  AutoChessSetChessPoolDeployRequest,
  AutoChessSetChessPoolDeployResponse,
  AutoChessSetChessPoolDiyCharRequest,
  AutoChessSetChessPoolDiyCharResponse,
  AutoChessSetFriendAssistRequest,
  AutoChessSetFriendAssistResponse,
  AutoChessSettleGameRequest,
  AutoChessSettleGameResponse,
  AutoChessSettleLikeRequest,
  AutoChessSettleLikeResponse,
  AutoChessStartMatchRequest,
  AutoChessStartMatchResponse,
  AutoChessStartBattleResponse,
  AutoChessTrainingBattleFinishRequest,
  AutoChessTrainingBattleStartRequest,
} from "./autochess.protocol";

const router = Router();

/** 同步赛季信息（CS: ActAutoChessSyncInfoRequest/Response） */
router.post("/autochessSeason/syncInfo", validateBody(autoChessSyncInfoSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ActAutoChessSyncInfoRequest;
  const payload = await player.autoChess.syncInfo(body);
  res.send({ ...payload, ...player.delta } satisfies ActAutoChessSyncInfoResponse);
});

/** 设置棋池部署（CS: AutoChessSetChessPoolDeployRequest/Response） */
router.post("/autochessSeason/setChessPoolDeploy", validateBody(autoChessSetChessPoolDeploySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessSetChessPoolDeployRequest;
  const result = await player.autoChess.setChessPoolDeploy(body);
  if (!result.ok) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send(player.delta satisfies AutoChessSetChessPoolDeployResponse);
});

/** 设置棋池自定干员（CS: AutoChessSetChessPoolDiyCharRequest/Response） */
router.post("/autochessSeason/setChessPoolDiyChar", validateBody(autoChessSetChessPoolDiyCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessSetChessPoolDiyCharRequest;
  const result = await player.autoChess.setChessPoolDiyChar(body);
  if (!result.ok) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send(player.delta satisfies AutoChessSetChessPoolDiyCharResponse);
});

/** 移除棋池角色（CS: AutoChessRemoveChessPoolCharRequest/Response） */
router.post("/autochessSeason/removeChessPoolChar", validateBody(autoChessRemoveChessPoolCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessRemoveChessPoolCharRequest;
  const result = await player.autoChess.removeChessPoolChar(body);
  if (!result.ok) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send(player.delta satisfies AutoChessRemoveChessPoolCharResponse);
});

/** 设置棋池助战（CS: AutoChessSetFriendAssistRequest/Response） */
router.post("/autochessSeason/setChessPoolAssist", validateBody(autoChessSetChessPoolAssistSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessSetFriendAssistRequest;
  const result = await player.autoChess.setChessPoolAssist(body);
  if (!result.ok) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send(player.delta satisfies AutoChessSetFriendAssistResponse);
});

/** 获取好友助战列表（CS: AutoChessGetFriendAssistListRequest/Response） */
router.post("/autochessSeason/getFriendCharAssistList", validateBody(autoChessGetFriendAssistListSchema), async (req, res) => {
  const player = getPlayer();
  req.body as AutoChessGetFriendAssistListRequest;
  const payload = await player.autoChess.getFriendCharAssistList();
  res.send({ ...payload, ...player.delta } satisfies AutoChessGetFriendAssistListResponse);
});

/** 创建队伍（CS: AutoChessCreateTeamRequest/Response） */
router.post("/autochessSeason/createTeam", validateBody(autoChessCreateTeamSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessCreateTeamRequest;
  const payload = player.autoChess.createTeam(body);
  res.send({ ...payload, ...player.delta } satisfies AutoChessCreateTeamResponse);
});

/** 加入队伍（CS: AutoChessJoinTeamRequest/Response） */
router.post("/autochessSeason/joinTeam", validateBody(autoChessJoinTeamSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessJoinTeamRequest;
  const payload = player.autoChess.joinTeam(body);
  res.send({ ...payload, ...player.delta } satisfies AutoChessJoinTeamResponse);
});

/** 开始匹配（CS: AutoChessStartMatchRequest/Response） */
router.post("/autochessSeason/startMatch", validateBody(autoChessStartMatchSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessStartMatchRequest;
  const payload = player.autoChess.startMatch(body);
  res.send({ ...payload, ...player.delta } satisfies AutoChessStartMatchResponse);
});

/** 查询匹配（CS: AutoChessQueryMatchRequest/Response） */
router.post("/autochessSeason/queryMatch", validateBody(autoChessQueryMatchSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessQueryMatchRequest;
  const payload = player.autoChess.queryMatch(body);
  res.send({ ...payload, ...player.delta } satisfies AutoChessQueryMatchResponse);
});

/** 多人战斗开始（CS: AutoChessMultiBattleStartRequest，响应 CommonStartBattleResponse） */
router.post("/autochessSeason/multiBattleStart", validateBody(autoChessMultiBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessMultiBattleStartRequest;
  const result = await player.autoChess.multiBattleStart(body);
  if (!result.ok) {
    return res.send({
      result: 1,
      battleId: "",
      apFailReturn: 0,
      isApProtect: 0,
      inApProtectPeriod: false,
      notifyPowerScoreNotEnoughIfFailed: false,
      ...player.delta,
    } satisfies AutoChessStartBattleResponse);
  }
  res.send({ ...result.data!, ...player.delta } satisfies AutoChessStartBattleResponse);
});

/** 多人战斗结束（CS: AutoChessMultiBattleFinishRequest/Response） */
router.post("/autochessSeason/multiBattleFinish", validateBody(autoChessMultiBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessMultiBattleFinishRequest;
  const result = player.autoChess.multiBattleFinish(body);
  if (!result.ok) {
    return res.send({ ...emptyAutoChessFinishPayload(), result: 1, ...player.delta });
  }
  res.send({ ...result.data!, ...player.delta } satisfies AutoChessFinishBattleResponse);
});

/** 引导（训练）战斗开始（CS: AutoChessTrainingBattleStartRequest，响应 CommonStartBattleResponse） */
router.post("/autochessSeason/startGuideBattle", validateBody(autoChessTrainingBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessTrainingBattleStartRequest;
  const result = await player.autoChess.trainingBattleStart(body);
  if (!result.ok) {
    return res.send({
      result: 1,
      battleId: "",
      apFailReturn: 0,
      isApProtect: 0,
      inApProtectPeriod: false,
      notifyPowerScoreNotEnoughIfFailed: false,
      ...player.delta,
    } satisfies AutoChessStartBattleResponse);
  }
  res.send({ ...result.data!, ...player.delta } satisfies AutoChessStartBattleResponse);
});

/** 引导（训练）战斗结束（CS: AutoChessTrainingBattleFinishRequest/Response） */
router.post("/autochessSeason/finishGuideBattle", validateBody(autoChessTrainingBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessTrainingBattleFinishRequest;
  const result = await player.autoChess.trainingBattleFinish(body);
  if (!result.ok) {
    return res.send({ ...emptyAutoChessFinishPayload(), result: 1, ...player.delta });
  }
  res.send({ ...result.data!, ...player.delta } satisfies AutoChessFinishBattleResponse);
});

/** 退出单机游戏（CS: AutoChessQuitSingleGameRequest/Response） */
router.post("/autochessSeason/quitSingleGame", validateBody(autoChessQuitSingleGameSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessQuitSingleGameRequest;
  const payload = player.autoChess.quitSingleGame(body);
  res.send({ ...payload, ...player.delta } satisfies AutoChessQuitSingleGameResponse);
});

/** 结算游戏（CS: AutoChessSettleGameRequest/Response） */
router.post("/autochessSeason/settleGame", validateBody(autoChessSettleGameSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoChessSettleGameRequest;
  const result = await player.autoChess.settleGame(body);
  if (!result.ok) {
    return res.send({
      result: 1,
      gameSettleData: null,
      ...player.delta,
    } satisfies AutoChessSettleGameResponse);
  }
  res.send({ ...result.data!, ...player.delta } satisfies AutoChessSettleGameResponse);
});

/** 结算点赞（CS: AutoChessSettleLikeRequest/Response） */
router.post("/autochessSeason/settleLike", validateBody(autoChessSettleLikeSchema), async (req, res) => {
  const player = getPlayer();
  req.body as AutoChessSettleLikeRequest;
  player.autoChess.settleLike();
  res.send(player.delta satisfies AutoChessSettleLikeResponse);
});

/** 上报战斗结果（服务端自定义，宽松透传） */
router.post("/autochessSeason/report", validateBody(autoChessReportSchema), async (req, res) => {
  const player = getPlayer();
  req.body as AutoChessReportRequest;
  player.autoChess.report();
  res.send(player.delta satisfies AutoChessReportResponse);
});

/** 赛季入口兜底（客户端按赛季 id 直达入口时的空响应） */
for (const autoChessSeason of ["act1autochess", "act2autochess"]) {
  router.post(`/${autoChessSeason}`, validateBody(autoChessSeasonEntrySchema), async (req, res) => {
    const player = getPlayer();
    res.send(player.delta satisfies { playerDataDelta: unknown });
  });
}

export default router;
