/**
 * 叙拉古人（siracusaMap）活动路由
 *
 * 对应客户端 Torappu.UI.SiracusaMap.SiracusaMapService 系列接口。
 * 请求均含 groupId + 特性 id；私服做轻量状态记录（写入 siracusaMap.area 计数映射），
 * 返回 playerDataDelta，客户端正常收包不崩溃。
 */

import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { validateBody } from "@core/http/validate-body";
import {
  avgItemCardGainSchema,
  avgOptionSelectSchema,
  avgTaskFinishSchema,
  cardSelectSchema,
  operaCommentLikeSchema,
  taskRingGainRewardSchema,
} from "./siracusaMap.schema";

const router = Router();

/** 在 siracusaMap.area 记一个状态标记（key → value） */
function markArea(player: PlayerDataManager, key: string, value: number): Promise<void> {
  return player.update(async (draft) => {
    draft.siracusaMap.area[key] = value;
  });
}

/** 干员卡选择（CS: SiracusaMapCharCardSelectRequest { groupId, cardId }） */
router.post("/cardSelect", validateBody(cardSelectSchema), async (req, res) => {
  const player = getPlayer();
  const { cardId } = req.body as { groupId?: string; cardId: string };
  await player.update(async (draft) => {
    draft.siracusaMap.select = cardId;
  });
  res.send(player.delta);
});

/** 剧情选项选择（CS: SiracusaMapAvgOptionSelectRequest { groupId, taskId, optionId }） */
router.post("/avgOptionSelect", validateBody(avgOptionSelectSchema), async (req, res) => {
  const player = getPlayer();
  const { optionId } = req.body as { groupId?: string; taskId?: string; optionId: string };
  await markArea(player, optionId, 1);
  res.send(player.delta);
});

/** 剧情任务完成（CS: SiracusaMapAvgTaskFinishRequest { groupId, taskId }） */
router.post("/avgTaskFinish", validateBody(avgTaskFinishSchema), async (req, res) => {
  const player = getPlayer();
  const { taskId } = req.body as { groupId?: string; taskId: string };
  await markArea(player, taskId, 2);
  res.send(player.delta);
});

/** 道具卡获得（CS: SiracusaMapAvgItemCardGainRequest { groupId, taskId, itemCardId }） */
router.post("/avgItemCardGain", validateBody(avgItemCardGainSchema), async (req, res) => {
  const player = getPlayer();
  const { itemCardId } = req.body as { groupId?: string; taskId?: string; itemCardId: string };
  await player.update(async (draft) => {
    draft.siracusaMap.area[itemCardId] = (draft.siracusaMap.area[itemCardId] ?? 0) + 1;
  });
  res.send(player.delta);
});

/** 歌剧评论点赞（CS: SiracusaMapOperaCommentLikeRequest { groupId, operaId, commentId }） */
router.post("/operaCommentLike", validateBody(operaCommentLikeSchema), async (req, res) => {
  const player = getPlayer();
  const { commentId } = req.body as { groupId?: string; operaId?: string; commentId: string };
  await markArea(player, commentId, 1);
  res.send(player.delta);
});

/** 任务环奖励领取（CS: SiracusaTaskRingGainRewardRequest { groupId, taskRingId }） */
router.post("/taskRingGainReward", validateBody(taskRingGainRewardSchema), async (req, res) => {
  const player = getPlayer();
  const { taskRingId } = req.body as { groupId?: string; taskRingId: string };
  await markArea(player, taskRingId, 1);
  res.send(player.delta);
});

export default router;
