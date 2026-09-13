/**
 * 统一业务异常体系（建议 13）
 *
 * domain/service 业务校验失败时抛对应子类（携带业务文案），
 * 由 app/game/app.ts 的 gameErrorHandler 统一映射为 JSON 响应：
 * `{ status: 1, msg: <业务文案>, code: <错误码> }` + HTTP 状态码。
 * 不再在 handler 内散落 res.status(xxx).json(...) 或裸 throw new Error。
 *
 * 子类语义：
 * - BadRequestError  400：参数/状态校验失败（客户端可修正后重试）
 * - ForbiddenError   403：无权限/被禁止
 * - NotFoundError    404：资源不存在
 * - InternalError    500：服务端内部错误（不向前端泄漏 stack）
 */

export class GameError extends Error {
  constructor(
    message: string,
    public readonly code: string = "GAME_ERROR",
    public readonly status: number = 400,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "GameError";
  }
}

export class BadRequestError extends GameError {
  constructor(message: string, code = "BAD_REQUEST", detail?: unknown) {
    super(message, code, 400, detail);
    this.name = "BadRequestError";
  }
}

export class ForbiddenError extends GameError {
  constructor(message: string, code = "FORBIDDEN", detail?: unknown) {
    super(message, code, 403, detail);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends GameError {
  constructor(message: string, code = "NOT_FOUND", detail?: unknown) {
    super(message, code, 404, detail);
    this.name = "NotFoundError";
  }
}

export class InternalError extends GameError {
  constructor(message: string, code = "INTERNAL_ERROR", detail?: unknown) {
    super(message, code, 500, detail);
    this.name = "InternalError";
  }
}

/** 判断是否为统一业务异常 */
export function isGameError(err: unknown): err is GameError {
  return err instanceof GameError;
}
