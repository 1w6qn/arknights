/**
 * 陷阱队（/templateTrap/*）请求 zod schema
 *
 * 对应 templateTrap.ts 的 Request 类型，供 routes.ts 经 validateBody 做运行时校验。
 */
import { z } from "zod";

/** 设置陷阱队请求（CS: SetTemplateTrapRequest { trapDomainId, trapSquad }）；trapSquad 可为数字/字符串 id */
export const setTrapSquadSchema = z.object({
  trapDomainId: z.string(),
  trapSquad: z.array(z.union([z.string(), z.number()])),
});
