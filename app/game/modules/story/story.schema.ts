/**
 * 剧情推进（/story/*）请求 zod schema
 *
 * 对应 story.ts 的 Request 类型，供 routes.ts 经 validateBody 做运行时校验。
 */
import { z } from "zod";

/** 完成剧情请求（CS: FinishStoryRequest { storyId }） */
export const finishStorySchema = z.object({
  storyId: z.string(),
});
