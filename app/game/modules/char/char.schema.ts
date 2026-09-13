/**
 * 干员星级标记（/char/*）请求 zod schema
 *
 * 对应 char.ts 的 Request 类型，供 routes.ts 经 validateBody 做运行时校验。
 */
import { z } from "zod";

/** 修改干员星级标记请求（CS: ChangeStarMarkCharRequest { chrIdDict }）；chrIdDict 为 charId→标记 字典，handler 逐项读取 */
export const changeMarkStarSchema = z.object({
  chrIdDict: z.record(z.string(), z.number()),
});
