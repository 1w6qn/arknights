import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { validateBody } from "@core/http/validate-body";
import {
  changeNameCardComponentSchema,
  changeNameCardSkinSchema,
  editNameCardSchema,
  getOtherPlayerNameCardSchema,
} from "./businessCard.schema";
import {
  ChangeNameCardComponentRequest,
  ChangeNameCardComponentResponse,
  ChangeNameCardSkinRequest,
  ChangeNameCardSkinResponse,
  EditNameCardRequest,
  EditNameCardResponse,
  GetOtherPlayerNameCardRequest,
  GetOtherPlayerNameCardResponse,
} from "./businessCard";

const router = Router();
router.post(
  "/changeNameCardSkin",
  validateBody(changeNameCardSkinSchema),
  async (req, res) => {
    const player = getPlayer();
    const body = req.body as ChangeNameCardSkinRequest;
    await player.social.changeNameCardSkin(body);
    res.send(player.delta satisfies ChangeNameCardSkinResponse);
  },
);
router.post(
  "/changeNameCardComponent",
  validateBody(changeNameCardComponentSchema),
  async (req, res) => {
    const player = getPlayer();
    const body = req.body as ChangeNameCardComponentRequest;
    await player.social.changeNameCardComponent(body);
    res.send(player.delta satisfies ChangeNameCardComponentResponse);
  },
);
router.post(
  "/editNameCard",
  validateBody(editNameCardSchema),
  async (req, res) => {
    const player = getPlayer();
    const body = req.body as EditNameCardRequest;
    await player.social.editNameCard(body);
    // 修复：EditBusinessCard 任务事件从未 emit → 编辑名片类任务永不推进
    await player._trigger.emit("EditBusinessCard", []);
    res.send(player.delta satisfies EditNameCardResponse);
  },
);
router.post(
  "/getOtherPlayerNameCard",
  validateBody(getOtherPlayerNameCardSchema),
  async (req, res) => {
    const player = getPlayer();
    const body = req.body as GetOtherPlayerNameCardRequest;
    res.send({
      nameCard: await player.social.getOtherPlayerNameCard(body),
      ...player.delta,
    } satisfies GetOtherPlayerNameCardResponse);
  },
);
export default router;
