import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import type { JsonValue } from "@excel/json-value";

const configMock = vi.hoisted(() => ({ default: { authMode: "single" } }));
vi.mock("@core/config/index", () => configMock);

vi.mock("@game/modules/account/account-manager", () => ({
  accountManager: {
    tokenByPhonePassword: vi.fn().mockResolvedValue("token_123"),
    getUidByToken: vi.fn().mockResolvedValue("10000"),
    getUserConfig: vi.fn().mockResolvedValue({ auth: { phone: "13800000000" } }),
  },
}));
vi.mock("@utils/time", () => ({ now: () => 1234567890 }));
vi.mock("@utils/file", () => ({
  readJson: vi.fn().mockResolvedValue({ version: "1", appVersion: "1.0" }),
}));

import authRouter from "@core/auth/auth";
import { accountManager } from "@game/modules/account/account-manager";
import { registerAccountAuthPort } from "@core/auth/account-port";
// 账号端口注册：core/kernel 不再直连本模块（R1/R2），mock 的 accountManager 需显式注册进端口注册表
registerAccountAuthPort(accountManager);
import type { UserConfig } from "@game/modules/account/account-manager";
import { asModel } from "../../helpers";

/** auth 路由的测试请求视图：只声明用例传入且被测分支读到的成员（真实 express Request 可赋给它） */
interface MockReq {
  method: string;
  url: string;
  body?: JsonValue;
  query?: Request["query"];
}

/** auth 路由的测试响应视图：只声明被测分支调用的四个方法（真实 express Response 可赋给它） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

type AuthRouter = typeof authRouter;

/**
 * getUserConfig 缺失分支夹具
 *
 * 真实实现 `return this.configs[uid]!`（AccountManager.ts:231）在 uid 不存在时返回 undefined，
 * 用例模拟该分支；返回类型声明为 `UserConfig | undefined`，调用点按非空分支做一次单向（收窄）断言。
 */
function missingUserConfig(): UserConfig | undefined {
  return undefined;
}

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

async function call(router: AuthRouter, req: MockReq, res: MockRes): Promise<MockRes> {
  // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
  router(req as Parameters<AuthRouter>[0], res as Response, () => {});
  // 等待异步 handler 完成
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("auth 路由", () => {
  it("GET /general/v1/server_time 应返回服务器时间", async () => {
    const res = mockRes();
    await call(authRouter, { method: "GET", url: "/general/v1/server_time" }, res);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 0,
        data: { serverTime: 1234567890, isHoliday: false },
      }),
    );
  });

  it("GET /app/v1/config 应返回应用配置", async () => {
    const res = mockRes();
    await call(authRouter, { method: "GET", url: "/app/v1/config" }, res);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ version: "1" }));
  });

  it("POST /user/auth/v1/token_by_phone_password 应返回 token", async () => {
    const res = mockRes();
    await call(
      authRouter,
      { method: "POST", url: "/user/auth/v1/token_by_phone_password", body: { phone: "13800000000", password: "pwd" } },
      res,
    );
    expect(accountManager.tokenByPhonePassword).toHaveBeenCalledWith(
      "13800000000",
      "pwd",
    );
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: { token: "token_123" } }),
    );
  });

  it("GET /user/info/v1/basic 应返回用户 auth 信息", async () => {
    const res = mockRes();
    await call(authRouter, { method: "GET", url: "/user/info/v1/basic", query: { token: "t" } }, res);
    expect(accountManager.getUidByToken).toHaveBeenCalledWith("t");
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phone: "13800000000" }),
      }),
    );
  });

  it("GET /user/info/v1/basic token 无效（用户不存在）应返回 200 + 空 auth（不卡流程）", async () => {
    configMock.default.authMode = "single";
    vi.mocked(accountManager.getUserConfig).mockResolvedValueOnce(missingUserConfig() as UserConfig);
    const res = mockRes();
    await call(authRouter, { method: "GET", url: "/user/info/v1/basic", query: { token: "invalid" } }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ status: 0, data: expect.objectContaining({ isLatestUserAgreement: true }) }),
    );
  });

  it("real 模式：token 无效应返回 404（严格校验）", async () => {
    configMock.default.authMode = "real";
    vi.mocked(accountManager.getUidByToken).mockResolvedValueOnce("");
    const res = mockRes();
    await call(authRouter, { method: "GET", url: "/user/info/v1/basic", query: { token: "invalid" } }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ status: 1 }));
  });

  it("POST /user/info/v1/need_cloud_auth 应返回 OK", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/info/v1/need_cloud_auth" }, res);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ status: 0, msg: "OK" }));
  });

  it("POST /user/oauth2/v1/grant 应返回授权码与 uid（兼容 v1）", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/oauth2/v1/grant", body: { token: "t3" } }, res);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: { code: "t3", uid: "10000" } }),
    );
  });

  it("POST /u8/user/verifyAccount 应返回账号验证结果", async () => {
    const res = mockRes();
    await call(
      authRouter,
      { method: "POST", url: "/u8/user/verifyAccount", body: { extension: JSON.stringify({ access_token: "t4" }) } },
      res,
    );
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: 0, uid: "10000", token: "t4" }),
    );
  });

  it("POST /user/oauth2/v2/grant 应返回授权码与 uid", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/oauth2/v2/grant", body: { token: "t2" } }, res);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: { code: "t2", uid: "10000" } }),
    );
  });

  it("POST /u8/user/v1/getToken 应解析渠道扩展并返回 token", async () => {
    const res = mockRes();
    await call(
      authRouter,
      { method: "POST", url: "/u8/user/v1/getToken", body: { extension: JSON.stringify({ code: "u8code" }) } },
      res,
    );
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ token: "u8code", uid: "10000" }),
    );
  });

  it("POST /user/online/v1/loginout 应返回登出成功结果（参考 DoctoratePy onlineV1LoginOut）", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/online/v1/loginout" }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 0 });
  });

  it("POST /u8/pay/getAllProductList 应返回商品列表（读 AllProductList.json）", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/u8/pay/getAllProductList" }, res);
    expect(res.send).toHaveBeenCalledWith({ version: "1", appVersion: "1.0" });
  });
});

describe("real 模式用户管理闭环（change_password/change_phone）", () => {
  // 扩展 mock：configs + updatePassword/updatePhone
  beforeEach(() => {
    vi.restoreAllMocks();
    accountManager.configs = {
      "10000": asModel<UserConfig>({
        auth: { phone: "13800000000" },
        password: "sha256$old",
        secret: "secret_10000",
      }),
    };
    accountManager.updatePassword = vi.fn().mockResolvedValue(true);
    accountManager.updatePhone = vi.fn().mockResolvedValue(true);
    accountManager.getUidByToken = vi
      .fn()
      .mockImplementation(async (t: string) =>
        t === "secret_10000" ? "10000" : "",
      );
  });

  it("change_password 应校验格式并调用 updatePassword", async () => {
    const res = mockRes();
    await call(
      authRouter,
      { method: "POST", url: "/user/auth/v1/change_password", body: { token: "secret_10000", newPassword: "NewPass123" } },
      res,
    );
    expect(res.send).toHaveBeenCalledWith({ result: 0, token: "secret_10000" });
    expect(accountManager.updatePassword).toHaveBeenCalledWith("10000", "NewPass123");
  });

  it("change_password 密码格式错误应返回 result 1", async () => {
    const res = mockRes();
    await call(
      authRouter,
      { method: "POST", url: "/user/auth/v1/change_password", body: { token: "secret_10000", newPassword: "short" } },
      res,
    );
    expect(res.send).toHaveBeenCalledWith({ result: 1 });
  });

  it("change_phone 应调用 updatePhone（新手机未被占用）", async () => {
    const res = mockRes();
    await call(
      authRouter,
      { method: "POST", url: "/user/auth/v1/change_phone", body: { token: "secret_10000", newPhone: "13899998888" } },
      res,
    );
    expect(res.send).toHaveBeenCalledWith({ result: 0, token: "secret_10000" });
    expect(accountManager.updatePhone).toHaveBeenCalledWith("10000", "13899998888");
  });

  it("change_phone 新手机已被占用应返回 result 8", async () => {
    accountManager.configs["20000"] = asModel<UserConfig>({
      auth: { phone: "13899998888" },
      secret: "secret_20000",
    });
    const res = mockRes();
    await call(
      authRouter,
      { method: "POST", url: "/user/auth/v1/change_phone", body: { token: "secret_10000", newPhone: "13899998888" } },
      res,
    );
    expect(res.send).toHaveBeenCalledWith({ result: 8 });
  });
});

describe("认证端点限流（rateLimit 中间件）", () => {
  it("阈值内放行、超过阈值返回 429", async () => {
    const { rateLimit, resetRateLimits } = await import("@core/auth/rate-limit");
    resetRateLimits();
    const mw = rateLimit({ name: "test:limit", windowMs: 60_000, max: 3 });
    const req = { ip: "10.0.0.1" } as Request;
    const next = vi.fn();
    for (let i = 0; i < 3; i++) mw(req, mockRes() as Response, next);
    expect(next).toHaveBeenCalledTimes(3);
    const blocked = mockRes();
    mw(req, blocked as Response, next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(blocked.status).toHaveBeenCalledWith(429);
  });

  it("不同客户端 IP 独立计数（不误伤）", async () => {
    const { rateLimit, resetRateLimits } = await import("@core/auth/rate-limit");
    resetRateLimits();
    const mw = rateLimit({ name: "test:limit-ip", windowMs: 60_000, max: 1 });
    const next = vi.fn();
    mw({ ip: "10.0.0.2" } as Request, mockRes() as Response, next);
    mw({ ip: "10.0.0.3" } as Request, mockRes() as Response, next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
