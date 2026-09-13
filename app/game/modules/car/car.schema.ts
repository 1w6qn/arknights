/**
 * 出战战车（/car/*）请求 zod schema
 *
 * 对应 car.ts 的 Request 类型，供 routes.ts 经 validateBody 做运行时校验。
 */
import { z } from "zod";

/** 确认出战战车请求（服务端自定义 { car }）；car 复杂，用 z.json() */
export const confirmBattleCarSchema = z.object({
  car: z.json(),
});
