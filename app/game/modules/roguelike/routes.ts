/**
 * 老版集成战略（roguelike v1）路由
 * 请求/响应类型见 @game/modules/roguelike/roguelike（CS 2.7.61 无对应类，以服务端实现为准）
 */
import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import {
  RoguelikeCreateGameRequest,
  RoguelikeCreateGameResponse,
  RoguelikeFinishGameRequest,
  RoguelikeFinishGameResponse,
  RoguelikeGiveUpGameRequest,
  RoguelikeGiveUpGameResponse,
  RoguelikeMilestoneRewardRequest,
  RoguelikeMilestoneRewardResponse,
  RoguelikeMilestoneRewardTryBestRequest,
  RoguelikeMilestoneRewardTryBestResponse,
  RoguelikeUpgradeOutBuffRequest,
  RoguelikeUpgradeOutBuffResponse,
} from "./roguelike";
import { validateBody } from "@core/http/validate-body";
import {
  roguelikeCreateGameSchema,
  roguelikeFinishGameSchema,
  roguelikeGiveUpGameSchema,
  roguelikeMilestoneRewardSchema,
  roguelikeMilestoneRewardTryBestSchema,
  roguelikeUpgradeOutBuffSchema,
} from "./roguelike.schema";

const router = Router();

/** 创建游戏（服务端自定义） */
router.post("/roguelike/createGame", validateBody(roguelikeCreateGameSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeCreateGameRequest;

  res.send({
    ...player.delta,
    result: 0,
  } satisfies RoguelikeCreateGameResponse);
});

/** 结束游戏（服务端自定义） */
router.post("/roguelike/finishGame", validateBody(roguelikeFinishGameSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeFinishGameRequest;

  res.send({
    ...player.delta,
    result: 0,
  } satisfies RoguelikeFinishGameResponse);
});

/** 放弃游戏（服务端自定义） */
router.post("/roguelike/giveUpGame", validateBody(roguelikeGiveUpGameSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeGiveUpGameRequest;

  res.send({
    ...player.delta,
    result: 0,
  } satisfies RoguelikeGiveUpGameResponse);
});

/** 里程碑奖励（服务端自定义） */
router.post("/roguelike/milestoneReward", validateBody(roguelikeMilestoneRewardSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeMilestoneRewardRequest;

  res.send({
    ...player.delta,
    items: [],
    result: 0,
  } satisfies RoguelikeMilestoneRewardResponse);
});

/** 尝试最佳里程碑奖励（服务端自定义） */
router.post("/roguelike/milestoneRewardTryBest", validateBody(roguelikeMilestoneRewardTryBestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeMilestoneRewardTryBestRequest;

  res.send({
    ...player.delta,
    items: [],
    result: 0,
  } satisfies RoguelikeMilestoneRewardTryBestResponse);
});

/**
 * 升级局外增益（解锁增益树/科技树节点）
 *
 * 请求体：{ theme: "rogue_1", id: "outbuff_1" }（兼容 buffId 字段名）
 * 校验与扣点逻辑见 RoguelikeV2Manager.unlockBuff
 *
 * @route POST /roguelike/upgradeOutBuff
 */
router.post("/roguelike/upgradeOutBuff", validateBody(roguelikeUpgradeOutBuffSchema), async (req, res) => {
  const player = getPlayer();
  const { theme, id, buffId } = (req.body ?? {}) as RoguelikeUpgradeOutBuffRequest;
  const buffId2 = id || buffId || "";
  const ret = await player.modules.rlv2.unlockBuff(theme, buffId2);
  res.send({
    ...player.delta,
    result: ret.success ? 0 : 1,
    errorMsg: ret.reason,
  } satisfies RoguelikeUpgradeOutBuffResponse);
});

export default router;
