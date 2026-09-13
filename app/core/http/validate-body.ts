/**
 * zod 请求体校验中间件
 *
 * 对 rlv2 等路由的 req.body 做 zod schema 校验：缺失必填字段或类型不符时，
 * 直接返回 HTTP 4xx（默认 422），避免非法 body 传入控制器抛 500。
 *
 * 使用：router.post("/x", validateBody(xxxSchema), handler)
 */
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { logger } from "@utils/logger";

/** 校验失败响应体（对齐游戏约定：顶层 result 字段标识业务失败） */
export interface ValidationErrorBody {
  /** 业务失败标记（-1 表示格式校验不通过） */
  result: number;
  /** 人类可读错误摘要（首条 schema issue 的路径 + 消息） */
  message: string;
}

/**
 * 生成请求体校验中间件。
 * 校验失败时 res.status(status).json(errorBody)，不调用 next()；成功则写入
 * req.body（zod parse 会剥离未知字段）并 next()。
 *
 * @param schema  请求体 zod schema
 * @param status  校验失败返回的 HTTP 状态码（默认 422）
 * @returns Express 中间件
 */
export function validateBody(
  schema: z.ZodSchema,
  status = 422,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 未携带 body（GET，或 POST 未发 JSON）时 req.body 为 undefined/null，
    // 先规整为空对象：空请求体 schema（z.object({})）应放行，需必填字段的 schema 仍会报缺失
    const raw = req.body === undefined || req.body === null ? {} : req.body;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first.path.length > 0 ? ` field "${first.path.join(".")}"` : "";
      // 校验失败日志：记录方法/路径/首个失败原因，便于在统一日志与抓包中追踪被 422 拦下的请求
      logger.warn(
        "validate-body",
        `请求体校验失败 ${req.method} ${req.originalUrl ?? req.url} → ${first.message}${where}`,
      );
      const body: ValidationErrorBody = {
        result: -1,
        message: `${first.message}${where ? `${where}` : ""}`,
      };
      res.status(status).json(body);
      return;
    }
    req.body = parsed.data;
    next();
  };
}