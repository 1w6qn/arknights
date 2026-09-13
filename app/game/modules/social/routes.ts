import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import {
  DeleteFriendRequest,
  DeleteFriendResponse,
  GetFriendListRequest,
  GetFriendListResponse,
  GetFriendRequestListRequest,
  GetFriendRequestResponse,
  GetSortListInfoRequest,
  GetSortListInfoResponse,
  ProcessFriendRequest,
  ProcessFriendResponse,
  ReceiveSocialPointRequest,
  ReceiveSocialPointResponse,
  SearchPlayerRequest,
  SearchPlayerResponse,
  SendFriendRequest,
  SendFriendResponse,
  SetAssistCharListRequest,
  SetAssistCharListResponse,
  SetCardShowMedalRequest,
  SetCardShowMedalResponse,
  SetFriendAliasRequest,
  SetFriendAliasResponse,
  SetStarFriendListRequest,
  SetStarFriendListResponse,
} from "./social";
import { validateBody } from "@core/http/validate-body";
import {
  deleteFriendSchema,
  getFriendListSchema,
  getFriendRequestListSchema,
  getSortListInfoSchema,
  processFriendRequestSchema,
  receiveSocialPointSchema,
  searchPlayerSchema,
  sendFriendRequestSchema,
  setAssistCharListSchema,
  setCardShowMedalSchema,
  setFriendAliasSchema,
  setStarFriendListSchema,
} from "./social.schema";

const router = Router();
router.post("/deleteFriend", validateBody(deleteFriendSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as DeleteFriendRequest;
  // 修复：缺 id 必填参数时返回业务错误，而非 500
  if (typeof body?.id !== "string" || body.id === "") {
    return res.send({ result: 1, ...player.delta });
  }
  await player.social.deleteFriend(body);
  res.send(player.delta satisfies DeleteFriendResponse);
});
router.post("/sendFriendRequest", validateBody(sendFriendRequestSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SendFriendRequest;
  // 修复：缺 friendId 必填参数时返回业务错误，而非 500
  if (typeof body?.friendId !== "string" || body.friendId === "") {
    return res.send({ result: 1, ...player.delta });
  }
  await player.social.sendFriendRequest(body);
  res.send(player.delta satisfies SendFriendResponse);
});
router.post("/processFriendRequest", validateBody(processFriendRequestSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ProcessFriendRequest;
  // 修复：缺 friendId/action 必填参数时返回业务错误，而非 500
  if (typeof body?.friendId !== "string" || typeof body?.action !== "number") {
    return res.send({ result: 1, ...player.delta });
  }
  res.send({
    ...(await player.social.processFriendRequest(body)),
    ...player.delta,
  } satisfies ProcessFriendResponse);
});
router.post("/searchPlayer", validateBody(searchPlayerSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SearchPlayerRequest;
  res.send({
    ...(await player.social.searchPlayer(body)),
    ...player.delta,
  } satisfies SearchPlayerResponse);
});
router.post("/getSortListInfo", validateBody(getSortListInfoSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetSortListInfoRequest;
  const result = await player.social.getSortListInfo(body);
  res.send({
    result,
    // 修复（Round 48，审计 §5.4-10）：补 starFriendList（CS GetSortListInfoResponse 字段，
    // 原实现省略 → 客户端好友列表无法标星）
    starFriendList: await player.social.getStarFriendList(),
    ...player.delta,
  } satisfies GetSortListInfoResponse);
});
router.post("/getFriendList", validateBody(getFriendListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetFriendListRequest;
  const result = await player.social.getFriendList(body);
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetFriendListResponse);
});
router.post("/getFriendRequestList", validateBody(getFriendRequestListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetFriendRequestListRequest;
  res.send({
    ...(await player.social.getFriendRequestList(body)),
    ...player.delta,
  } satisfies GetFriendRequestResponse);
});
router.post("/getFriendAndRequestSendList", validateBody(getFriendListSchema), async (req, res) => {
  // 好友+已发送请求合并列表（客户端路由；复用 getFriendList 结构）
  const player = getPlayer();
  const body = req.body as GetFriendListRequest;
  const result = await player.social.getFriendList(body);
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetFriendListResponse);
});
router.post("/setAssistCharList", validateBody(setAssistCharListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetAssistCharListRequest;
  await player.social.setAssistCharList(body);
  res.send(player.delta satisfies SetAssistCharListResponse);
});
router.post("/setFriendAlias", validateBody(setFriendAliasSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetFriendAliasRequest;
  // 修复：缺 friendId/alias 必填参数时返回业务错误，而非 500
  if (typeof body?.friendId !== "string" || typeof body?.alias !== "string") {
    return res.send({ result: 1, ...player.delta });
  }
  await player.social.setFriendAlias(body);
  res.send(player.delta satisfies SetFriendAliasResponse);
});
router.post("/receiveSocialPoint", validateBody(receiveSocialPointSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ReceiveSocialPointRequest;
  await player.social.receiveSocialPoint();
  res.send(player.delta satisfies ReceiveSocialPointResponse);
});
router.post("/setCardShowMedal", validateBody(setCardShowMedalSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetCardShowMedalRequest;
  await player.social.setCardShowMedal(body);
  res.send(player.delta satisfies SetCardShowMedalResponse);
});
  router.post("/setStarFriendList", validateBody(setStarFriendListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetStarFriendListRequest;
  // 修复（2026-09-09，审计 §5.4-10）：原实现为空桩（恒 result 0 + 空 newIdList，
  // 无任何存储）→ 星标好友功能完全不可用。现落库（social.db friends.star）并返回
  // 实际生效列表（仅好友、去重、上限 gamedata_const.maxStarFriendNum = 5）。
  const newIdList = await player.social.setStarFriendList({
    idList: body?.idList,
  });
  res.send({
    result: 0,
    newIdList,
    ...player.delta,
  } satisfies SetStarFriendListResponse);
});
export default router;
