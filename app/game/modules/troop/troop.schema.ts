/**
 * 特殊干员置顶（/troop/*）请求 zod schema
 *
 * 对应 troop.ts 的 Request 类型，供 routes.ts 经 validateBody 做运行时校验。
 */
import { z } from "zod";

/** 特殊干员置顶请求（服务端自定义 { instId }，instId 可为数字/字符串） */
export const pinSpecialOperatorSchema = z.object({
  instId: z.union([z.string(), z.number()]),
});
