/**
 * 干员星级标记路由模块
 *
 * 路径：/char/changeMarkStar（根路径挂载），实现走 CharManager#changeMarkStar。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import { ChangeMarkStarRequest, ChangeMarkStarResponse } from "./char";
import { changeMarkStarSchema } from "./char.schema";

const router = Router();

/** 修改干员星级标记（CS: ChangeStarMarkCharRequest { chrIdDict }） */
router.post("/char/changeMarkStar", validateBody(changeMarkStarSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeMarkStarRequest;
  await player.char.changeMarkStar(body);
  res.send(player.delta satisfies ChangeMarkStarResponse);
});

export default router;
