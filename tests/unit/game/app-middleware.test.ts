import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

const configMock = vi.hoisted(() => ({ default: { authMode: "single" } }));
vi.mock("@core/config/index", () => configMock);
/**
 * 账号管理器替身
 *
 * `getPlayerData` 返回仅含 uid 的玩家占位（真实签名要求完整 PlayerDataManager），
 * 故以 vi.fn 桩整体替换模块；中间件把返回值原样存入 httpContext 供断言。
 */
const accountMock = vi.hoisted(() => ({
  accountManager: {
    getPlayerData: vi.fn(),
    getUidByToken: vi.fn(),
    // 认证端口其余成员（2026-09-13：kernel 认证策略经 @core/auth/account-port 取账号能力，
    // 不再直连 AccountManager，故 mock 需补齐端口形状并注册）
    tokenByPhonePassword: vi.fn(),
    getUserConfig: vi.fn(),
    configs: {} as Record<string, never>,
    registerUser: vi.fn(),
    updatePassword: vi.fn(),
    updatePhone: vi.fn(),
  },
}));
vi.mock("@game/modules/account/AccountManager", () => accountMock);
import { registerAccountAuthPort } from "@core/auth/account-port";
registerAccountAuthPort(accountMock.accountManager);
vi.mock("express-http-context2", () => ({
  default: { set: vi.fn(), get: vi.fn(), middleware: vi.fn() },
}));

import { authMiddleware } from "../../../app/game/app";
import httpContext from "express-http-context2";

/** 中间件请求视图：authMiddleware 只读/覆写 headers.secret */
interface MockReq {
  headers: Request["headers"];
}

/** 中间件响应视图：只声明 401 分支用到的两个方法 */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
}

function mockReqRes(headers: Request["headers"]): {
  req: MockReq;
  res: MockRes;
  next: NextFunction;
} {
  return {
    req: { headers },
    res: {
      send: vi.fn<Response["send"]>(),
      status: vi.fn<Response["status"]>().mockReturnThis(),
    },
    next: vi.fn(),
  };
}

describe("authMiddleware 认证中间件", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.default.authMode = "single";
    accountMock.accountManager.getPlayerData.mockResolvedValue({ uid: "1" });
  });

  it("single 模式：secret 强制为 1（单账号）", async () => {
    const { req, res, next } = mockReqRes({ secret: "2221" });
    await authMiddleware(req as Request, res as Response, next);
    expect(req.headers.secret).toBe("1");
    expect(accountMock.accountManager.getPlayerData).toHaveBeenCalledWith("1");
    expect(httpContext.set).toHaveBeenCalledWith("playerData", { uid: "1" });
    expect(next).toHaveBeenCalled();
  });

  it("real 模式：保留客户端 secret（多账号）", async () => {
    configMock.default.authMode = "real";
    accountMock.accountManager.getUidByToken.mockResolvedValue("2221");
    accountMock.accountManager.getPlayerData.mockResolvedValue({ uid: "2221" });
    const { req, res, next } = mockReqRes({ secret: "2221" });
    await authMiddleware(req as Request, res as Response, next);
    expect(req.headers.secret).toBe("2221");
    expect(accountMock.accountManager.getPlayerData).toHaveBeenCalledWith("2221");
    expect(httpContext.set).toHaveBeenCalledWith("playerData", { uid: "2221" });
  });

  it("real 模式：secret 为账号 token 时应解析 uid（参考 DoctoratePy）", async () => {
    configMock.default.authMode = "real";
    accountMock.accountManager.getUidByToken.mockResolvedValue("2221");
    accountMock.accountManager.getPlayerData.mockResolvedValue({ uid: "2221" });
    const { req, res, next } = mockReqRes({ secret: "secret_2221" });
    await authMiddleware(req as Request, res as Response, next);
    expect(accountMock.accountManager.getUidByToken).toHaveBeenCalledWith("secret_2221");
    expect(accountMock.accountManager.getPlayerData).toHaveBeenCalledWith("2221");
    expect(httpContext.set).toHaveBeenCalledWith("playerData", { uid: "2221" });
  });

  it("real 模式：secret 无效返回 401", async () => {
    configMock.default.authMode = "real";
    accountMock.accountManager.getUidByToken.mockResolvedValue("");
    const { req, res, next } = mockReqRes({ secret: "bad" });
    await authMiddleware(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("无 secret 头时（single 模式）也应注入 uid=1", async () => {
    configMock.default.authMode = "single";
    accountMock.accountManager.getPlayerData.mockResolvedValue({ uid: "1" });
    const { req, res, next } = mockReqRes({});
    await authMiddleware(req as Request, res as Response, next);
    expect(accountMock.accountManager.getPlayerData).toHaveBeenCalledWith("1");
    expect(httpContext.set).toHaveBeenCalledWith("playerData", { uid: "1" });
    expect(next).toHaveBeenCalled();
  });
});
