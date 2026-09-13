/**
 * 特殊干员置顶路由模块
 *
 * 路径：/troop/pinSpecialOperator（根路径挂载），直写 mission.pinnedSpecialOperator。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "../../kernel/http/validate-body";
import { PinSpecialOperatorRequest, PinSpecialOperatorResponse } from "./troop";
import { pinSpecialOperatorSchema } from "./troop.schema";

const router = Router();

/** 特殊干员置顶（服务端自定义 { instId }） */
router.post("/troop/pinSpecialOperator", validateBody(pinSpecialOperatorSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PinSpecialOperatorRequest;
  // 参考 OBS misc_bp.troop_pinSpecialOperator：mission.pinnedSpecialOperator = troop.chars[instId].charId
  await player.update(async (draft) => {
    // 修复：非法 instId（已删干员/乱传）不 500
    const char = draft.troop.chars[body.instId];
    if (!char) return;
    draft.mission.pinnedSpecialOperator = char.charId;
  });
  res.send(player.delta satisfies PinSpecialOperatorResponse);
});

export default router;
