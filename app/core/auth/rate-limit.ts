/**
 * 认证端点轻量限流（进程内固定窗口计数器）
 *
 * 背景（2026-09 安全审阅）：登录 / 注册 / 短信 / 改密等端点原本无任何频率约束，
 * 可无限次尝试口令或批量建号。本模块提供零依赖的进程内限流中间件——私服为单进程
 * 部署，固定窗口已足以阻断脚本化暴力尝试；多实例部署时应换成共享存储（Redis 等）。
 *
 * 计数键为「端点名 + 客户端 IP」，故不同端点互不影响；窗口内的第 `max + 1` 次请求
 * 返回 429 与 `Retry-After`。阈值来自 `config.authRateLimit`（`max <= 0` 关闭）。
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import config from "../config/index";

/** 单桶计数状态 */
interface Bucket {
  /** 当前窗口内已计数的请求数 */
  count: number;
  /** 窗口重置时间（毫秒时间戳） */
  resetAt: number;
}

/** 计数桶（key = `${name}:${ip}`） */
const buckets = new Map<string, Bucket>();

/** 触发惰性清理的桶数量阈值（防单 IP 海量端点键无限增长） */
const SWEEP_THRESHOLD = 10_000;

/** 清理已过期桶 */
function sweepExpired(nowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= nowMs) buckets.delete(key);
  }
}

/** 取客户端标识（未配 trust proxy 时 req.ip 即直连地址） */
function clientKey(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

/** 限流参数（缺省 60s / 20 次） */
export interface RateLimitOptions {
  /** 端点名（计数键前缀——同名端点共享计数） */
  name: string;
  /** 窗口长度（毫秒，缺省取 config.authRateLimit.windowMs 或 60000） */
  windowMs?: number;
  /** 窗口内最大请求数（缺省取 config.authRateLimit.max 或 20） */
  max?: number;
}

/**
 * 创建限流中间件
 * @param opts - 端点名与可选阈值覆盖
 * @returns Express 中间件；超限时以 429 结束响应
 */
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const windowMs = opts.windowMs ?? config.authRateLimit?.windowMs ?? 60_000;
  const max = opts.max ?? config.authRateLimit?.max ?? 20;
  return (req: Request, res: Response, next: NextFunction): void => {
    // max <= 0 视为关闭限流（本地调试用）
    if (max <= 0) {
      next();
      return;
    }
    const nowMs = Date.now();
    if (buckets.size > SWEEP_THRESHOLD) sweepExpired(nowMs);
    const key = `${opts.name}:${clientKey(req)}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= nowMs) {
      buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000));
      res.set?.("Retry-After", String(retryAfter));
      res.status(429).send({
        status: 1,
        result: 1,
        msg: "请求过于频繁，请稍后再试",
        code: "RATE_LIMITED",
      });
      return;
    }
    next();
  };
}

/**
 * 清空全部计数桶（测试辅助——模块级状态跨用例累积时重置）
 */
export function resetRateLimits(): void {
  buckets.clear();
}
