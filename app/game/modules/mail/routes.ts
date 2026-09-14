/**
 * 邮件路由
 * 请求/响应类型见 @game/modules/mail/mail（参考 CS 2.7.61 协议类）
 */
import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { mailManager } from "./mail-manager";
import {
  GetMetaInfoListRequest,
  GetMetaInfoListResponse,
  ListMailBoxRequest,
  ListMailBoxResponse,
  ReceiveAllMailRequest,
  ReceiveAllMailResponse,
  ReceiveMailRequest,
  ReceiveMailResponse,
  RemoveAllReceivedMailRequest,
  RemoveAllReceivedMailResponse,
} from "./mail";
import { validateBody } from "@core/http/validate-body";
import {
  getMetaInfoListSchema,
  listMailBoxSchema,
  receiveAllMailSchema,
  receiveMailSchema,
  removeAllReceivedMailSchema,
} from "./mail.schema";

const router = Router();

/** 一键删除已读邮件（CS: RemoveAllRecievedMailRequest） */
router.post("/removeAllReceivedMail", validateBody(removeAllReceivedMailSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RemoveAllReceivedMailRequest;
  await mailManager.removeAllReceivedMail(player.uid, body);
  res.send({ ...player.delta } satisfies RemoveAllReceivedMailResponse);
});

/** 一键领取邮件（CS: ReceiveAllMailRequest） */
router.post("/receiveAllMail", validateBody(receiveAllMailSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ReceiveAllMailRequest;
  const items = await mailManager.receiveAllMail(player.uid, body);
  // 修复：附件发放（原实现只回显 items，从不入账 → 邮件奖励服务器端丢失）
  if (items.length > 0) {
    for (const it of items) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send({ items, ...player.delta } satisfies ReceiveAllMailResponse);
});

/** 获取邮件元信息列表（CS: GetMetaInfoListRequest） */
router.post("/getMetaInfoList", validateBody(getMetaInfoListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetMetaInfoListRequest;
  res.send({
    result: await mailManager.getMetaInfoList(player.status.uid, body),
    ...player.delta,
  } satisfies GetMetaInfoListResponse);
});

/** 领取单封邮件（CS: ReceiveMailRequest） */
router.post("/receiveMail", validateBody(receiveMailSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ReceiveMailRequest;
  const items = await mailManager.receiveMail(player.status.uid, body);
  // 修复：附件发放（原实现只回显 items，从不入账 → 邮件奖励服务器端丢失）
  if (items.length > 0) {
    for (const it of items) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send({ result: 0, items, ...player.delta } satisfies ReceiveMailResponse);
});

/** 获取邮件列表（CS: ListMailBoxRequest） */
router.post("/listMailBox", validateBody(listMailBoxSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ListMailBoxRequest;
  res.send({
    mailList: await mailManager.listMailbox(player.status.uid, body),
    ...player.delta,
  } satisfies ListMailBoxResponse);
});

export default router;
