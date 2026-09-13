/**
 * 剧情推进路由模块
 *
 * 路径：/story/finishStory（根路径挂载），由 PlayerStatus 落盘，并在提交后同步
 * ODC 教程主题 varSeq（经 arkodc/public 门面，避免直连活动模块内部实现）。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import { FinishStoryRequest, FinishStoryResponse } from "./story";
import { finishStorySchema } from "./story.schema";

const router = Router();

/** 完成剧情（CS: FinishStoryRequest { storyId }） */
router.post("/story/finishStory", validateBody(finishStorySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as FinishStoryRequest;
  await player.status.finishStory(body);
  // ODC：教程剧情提交后同步主题 varSeq bool_end_guide_done=1——
  // 否则 logic_game_end_p1（q003_prog==4 && bool_end_guide_done==0 &&
  // q003_banner_showed==1）每次进图 AUTO_ONCE 重放新手教程（无限教程）
  const { finishArkOdcGuideStory } = await import("../arkodc/public");
  await finishArkOdcGuideStory(player, body.storyId);
  res.send({
    items: [],
    ...player.delta,
  } satisfies FinishStoryResponse);
});

export default router;
