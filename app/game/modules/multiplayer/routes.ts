/**
 * 联机V3（多人合作）与邀请路由
 * 请求/响应类型见 @game/modules/multiplayer/multiplayer（参考 CS 2.7.61 协议类）
 */
import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import {
  ActMultiV3BattleFinishRequest,
  ActMultiV3BattleFinishResponse,
  ActMultiV3BattleStartRequest,
  ActMultiV3BattleStartResponse,
  ActMultiV3ChangePhotoRequest,
  ActMultiV3ChangePhotoResponse,
  ActMultiV3ChangeTitleRequest,
  ActMultiV3ChangeTitleResponse,
  ActMultiV3CommitAlbumRequest,
  ActMultiV3CommitAlbumResponse,
  ActMultiV3CreateTeamRequest,
  ActMultiV3CreateTeamResponse,
  ActMultiV3GuideBattleFinishRequest,
  ActMultiV3GuideBattleFinishResponse,
  ActMultiV3GuideBattleStartRequest,
  ActMultiV3GuideBattleStartResponse,
  ActMultiV3JoinTeamRequest,
  ActMultiV3JoinTeamResponse,
  ActMultiV3LikePartnerRequest,
  ActMultiV3LikePartnerResponse,
  ActMultiV3QueryGetInfoRequest,
  ActMultiV3QueryGetInfoResponse,
  ActMultiV3QueryMatchRequest,
  ActMultiV3QueryMatchResponse,
  ActMultiV3ReportPartnerRequest,
  ActMultiV3ReportPartnerResponse,
  ActMultiV3SetSquadEffectRequest,
  ActMultiV3SetSquadEffectResponse,
  ActMultiV3SetSquadRequest,
  ActMultiV3SetSquadResponse,
  ActMultiV3StartMatchRequest,
  ActMultiV3StartMatchResponse,
  ActMultiV3UnlockSquadEffectRequest,
  ActMultiV3UnlockSquadEffectResponse,
  InvitedRefreshRequest,
  InvitedRefreshResponse,
  InvitedSettingRequest,
  InvitedSettingResponse,
  InviteRequest,
  InviteResponse,
  ProcessInviteRequest,
  ProcessInviteResponse,
} from "./multiplayer";
import { emptyRequestSchema } from "./multiplayer.schema";
import { validateBody } from "@core/http/validate-body";

const router = Router();

/** 获取联机信息（CS: ActMultiV3QueryGetInfoRequest） */
router.post("/multiplayerV3/getInfo", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3QueryGetInfoRequest;

  res.send({
    ...player.delta,
    info: {
      teamId: "",
      teamName: "",
      captainUid: "",
      members: [],
      buffList: [],
      squadList: [],
      album: {},
      title: "",
      photo: "",
    },
  } satisfies ActMultiV3QueryGetInfoResponse);
});

/** 修改称号（CS: ActMultiV3ChangeTitleRequest） */
router.post("/multiplayerV3/changeTitle", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3ChangeTitleRequest;

  res.send(player.delta satisfies ActMultiV3ChangeTitleResponse);
});

/** 设置战斗增益（CS: ActMultiV3SetSquadEffectRequest） */
router.post("/multiplayerV3/setBuff", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3SetSquadEffectRequest;

  res.send(player.delta satisfies ActMultiV3SetSquadEffectResponse);
});

/** 设置出战编队（CS: ActMultiV3SetSquadRequest） */
router.post("/multiplayerV3/setSquads", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3SetSquadRequest;

  res.send(player.delta satisfies ActMultiV3SetSquadResponse);
});

/** 引导战斗开始（CS: ActMultiV3GuideBattleStartRequest） */
router.post("/multiplayerV3/guideBattleStart", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3GuideBattleStartRequest;

  res.send({
    ...player.delta,
    battleId: "abcdefgh-1234-5678-a1b2c3d4e5f6",
    result: 0,
  } satisfies ActMultiV3GuideBattleStartResponse);
});

/** 引导战斗结束（CS: ActMultiV3GuideBattleFinishRequest） */
router.post("/multiplayerV3/guideBattleFinish", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3GuideBattleFinishRequest;

  res.send(player.delta satisfies ActMultiV3GuideBattleFinishResponse);
});

/** 联机战斗开始（CS: ActMultiV3BattleStartRequest） */
router.post("/multiplayerV3/battleStart", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3BattleStartRequest;

  res.send({
    ...player.delta,
    battleId: "abcdefgh-1234-5678-a1b2c3d4e5f6",
    result: 0,
  } satisfies ActMultiV3BattleStartResponse);
});

/** 联机战斗结束（CS: ActMultiV3BattleFinishRequest） */
router.post("/multiplayerV3/battleFinish", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3BattleFinishRequest;

  res.send(player.delta satisfies ActMultiV3BattleFinishResponse);
});

/** 更换照片（CS: ActMultiV3ChangePhotoRequest） */
router.post("/multiplayerV3/changePhoto", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3ChangePhotoRequest;

  res.send(player.delta satisfies ActMultiV3ChangePhotoResponse);
});

/** 提交相册（CS: ActMultiV3CommitAlbumRequest） */
router.post("/multiplayerV3/commitAlbum", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3CommitAlbumRequest;

  res.send(player.delta satisfies ActMultiV3CommitAlbumResponse);
});

/** 创建队伍（CS: ActMultiV3CreateTeamRequest） */
router.post("/multiplayerV3/createTeam", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3CreateTeamRequest;

  res.send({
    ...player.delta,
    teamId: "team_" + Math.random().toString(36).substr(2, 9),
  } satisfies ActMultiV3CreateTeamResponse);
});

/** 加入队伍（CS: ActMultiV3JoinTeamRequest） */
router.post("/multiplayerV3/joinTeam", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3JoinTeamRequest;

  res.send(player.delta satisfies ActMultiV3JoinTeamResponse);
});

/** 查询匹配（CS: ActMultiV3QueryMatchRequest） */
router.post("/multiplayerV3/queryMatch", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3QueryMatchRequest;

  res.send({
    ...player.delta,
    matchInfo: null,
    result: 1,
  } satisfies ActMultiV3QueryMatchResponse);
});

/** 举报队友（CS: ActMultiV3ReportPartnerRequest） */
router.post("/multiplayerV3/report", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3ReportPartnerRequest;

  res.send(player.delta satisfies ActMultiV3ReportPartnerResponse);
});

/** 点赞队友（CS: ActMultiV3LikePartnerRequest） */
router.post("/multiplayerV3/settleLike", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3LikePartnerRequest;

  res.send(player.delta satisfies ActMultiV3LikePartnerResponse);
});

/** 开始匹配（CS: ActMultiV3StartMatchRequest） */
router.post("/multiplayerV3/startMatch", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3StartMatchRequest;

  res.send(player.delta satisfies ActMultiV3StartMatchResponse);
});

/** 解锁战斗增益（CS: ActMultiV3UnlockSquadEffectRequest） */
router.post("/multiplayerV3/unlockBuff", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ActMultiV3UnlockSquadEffectRequest;

  res.send(player.delta satisfies ActMultiV3UnlockSquadEffectResponse);
});

/** 刷新邀请列表（CS: InvitedRefreshRequest） */
router.post("/invite/refreshInviteList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as InvitedRefreshRequest;

  res.send({
    ...player.delta,
    inviteList: [],
  } satisfies InvitedRefreshResponse);
});

/** 切换邀请接受状态（CS: InvitedSettingRequest） */
router.post("/invite/switchInviteAccept", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as InvitedSettingRequest;

  res.send(player.delta satisfies InvitedSettingResponse);
});

/** 发送邀请（CS: InviteRequest） */
router.post("/invite/sendInvite", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as InviteRequest;

  res.send(player.delta satisfies InviteResponse);
});

/** 处理邀请（CS: ProcessInviteRequest） */
router.post("/invite/processInvite", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ProcessInviteRequest;

  res.send(player.delta satisfies ProcessInviteResponse);
});

export default router;
