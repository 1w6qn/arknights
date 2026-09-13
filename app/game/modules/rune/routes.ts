/**
 * 符文学徒试炼（rune）路由
 *
 * 对应客户端 com.hypergryph.arknights_2.7.61.cs 中
 * Torappu.RuneStartBattleRequest（: CommonStartBattleRequest + rune/isPractice）/
 * RuneFinishBattleRequest（: CommonFinishBattleRequest + battleLog）/
 * RuneFinishBattleResponse（: CommonFinishBattleResponse + score/from/to）。
 * 复用标准战斗开始/结算（battle.start/finish）。
 */
import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import {
  runeFinishBattleSchema,
  runeStartBattleSchema,
} from "./rune.schema";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { ItemBundle } from "@excel/excel";
import { PlayerDeltaResponse } from "../../kernel/http/common";
import { CommonStartBattleRequest } from "../../kernel/battle-model";

const router = Router();

/** 符文学徒试炼开始战斗请求（CS: RuneStartBattleRequest : CommonStartBattleRequest） */
export interface RuneStartBattleRequest extends CommonStartBattleRequest {
  rune?: string[];
  isPractice?: boolean;
}

/** 符文学徒试炼开始战斗响应（CS: RuneStartBattleResponse : CommonStartBattleResponse） */
export interface RuneStartBattleResponse extends PlayerDeltaResponse {
  result: number;
  battleId: string;
  apFailReturn: number;
  isApProtect: number;
  inApProtectPeriod: boolean;
  notifyPowerScoreNotEnoughIfFailed: boolean;
}

/** 符文学徒试炼战斗结算请求（CS: RuneFinishBattleRequest : CommonFinishBattleRequest） */
export interface RuneFinishBattleRequest {
  data: string;
  battleData: { isCheat: string; completeTime: number };
  battleLog?: string;
}

/** 符文学徒试炼战斗结算响应（CS: RuneFinishBattleResponse : CommonFinishBattleResponse） */
export interface RuneFinishBattleResponse extends PlayerDeltaResponse {
  result?: number;
  apFailReturn?: number;
  itemReturn?: ItemBundle[];
  rewards?: ItemBundle[];
  unusualRewards?: ItemBundle[];
  additionalRewards?: ItemBundle[];
  furnitureRewards?: ItemBundle[];
  goldScale?: number;
  expScale?: number;
  firstRewards?: ItemBundle[];
  unlockStages?: string[];
  pryResult?: unknown[];
  alert?: unknown[];
  suggestFriend?: boolean;
  score: number;
  from: number;
  to: number;
}

/** 符文学徒试炼开始战斗（CS: RuneStartBattleRequest） */
router.post("/battleStart", validateBody(runeStartBattleSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RuneStartBattleRequest;
  res.send({
    ...(await player.battle.start(body)),
    ...player.delta,
  } satisfies RuneStartBattleResponse);
});

/** 符文学徒试炼战斗结算（CS: RuneFinishBattleRequest；score/from/to 固定 0 stub） */
router.post("/battleFinish", validateBody(runeFinishBattleSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RuneFinishBattleRequest;
  // 缺参校验：data/battleData 缺失时返回业务错误，避免 undefined 传入 battle.finish 抛 500
  if (body.data == null || body.battleData == null) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  const result = await player.battle.finish({
    data: body.data,
    battleData: body.battleData,
  });
  res.send({
    ...result,
    score: 0,
    from: 0,
    to: 0,
    ...player.delta,
  } satisfies RuneFinishBattleResponse);
});

export default router;
