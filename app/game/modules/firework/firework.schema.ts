/**
 * 烟花（/firework/*）请求 zod schema
 *
 * 对应 firework.ts 的 Request 类型，供 routes.ts 经 validateBody 做运行时校验。
 */
import { z } from "zod";

/** 保存烟花棋盘槽位请求（CS: FireworkSavePlateSlotRequest { groupId?, slots }）；slots 复杂，用 z.json() */
export const fireworkSavePlateSlotsSchema = z.object({
  groupId: z.string().optional(),
  slots: z.json(),
});

/** 更换烟花动物请求（CS: FireworkChangeAnimalRequest { animal, groupId? }） */
export const fireworkChangeAnimalSchema = z.object({
  animal: z.string(),
  groupId: z.string().optional(),
});
