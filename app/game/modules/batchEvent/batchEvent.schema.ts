/**
 * 客户端事件批量上报（/batch_event）请求 zod schema
 *
 * 对应 batchEvent.ts 的 Request 类型（空请求体），供 routes.ts 经 validateBody 校验。
 */
import { z } from "zod";

/** 客户端事件批量上报请求（服务端自定义，空请求体） */
export const batchEventSchema = z.object({});
