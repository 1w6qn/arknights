import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import type { JsonValue } from "@excel/json-value";

/** excel 行夹具视图（本文件不提供的表也要显式占位，否则门面方法的 `this.XxxTable` 报 TS2339/TS7023） */
interface ExcelRowMock { name?: string }

/** 配置替身视图：excel 门面方法 + authMode/Host/PORT */
interface AuthConfigMock {
  // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
  getItem(id: string): ExcelRowMock | undefined;
  itemName(id: string): string;
  makeItem(id: string, count: number, type?: string): { id: string; count: number; type?: string };
  charData(charId: string): ExcelRowMock | undefined;
  stageData(stageId: string): ExcelRowMock | undefined;
  ItemTable: { items?: Record<string, ExcelRowMock> } | undefined;
  CharacterTable: Record<string, ExcelRowMock> | undefined;
  StageTable: { stages?: Record<string, ExcelRowMock> } | undefined;
  authMode: string;
  Host: string;
  PORT: number;
}

const configMock = vi.hoisted((): { default: AuthConfigMock } => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
    ItemTable: undefined,
    CharacterTable: undefined,
    StageTable: undefined,
 authMode: "real", Host: "http://127.0.0.1", PORT: 8443 },
}));
vi.mock("@core/config/index", () => configMock);

// mock accountManager：提供 configs（login/register 用）+ 基础方法
vi.mock("@game/modules/account/AccountManager", () => {
  const configs = {
    "10000": {
      uid: "10000",
      password: "pwd123456",
      secret: "secret_10000",
      auth: { phone: "13800000001", hgId: "10000", email: "" },
    },
  };
  return {
    accountManager: {
      configs,
      tokenByPhonePassword: vi.fn().mockResolvedValue("secret_10000"),
      getUidByToken: vi.fn().mockResolvedValue("10000"),
      getUserConfig: vi.fn().mockResolvedValue({ auth: { phone: "13800000001" } }),
      getTokenByUid: vi.fn().mockResolvedValue("10000"),
      registerUser: vi.fn().mockResolvedValue("20000"),
      updatePassword: vi.fn().mockResolvedValue(true),
      updatePhone: vi.fn().mockResolvedValue(true),
    },
  };
});
vi.mock("@utils/time", () => ({ now: () => 1234567890 }));
vi.mock("@utils/file", () => ({
  readJson: vi.fn().mockResolvedValue({ version: "1", appVersion: "1.0" }),
}));
vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import authRouter from "@core/auth/auth";
import { accountManager } from "@game/modules/account/AccountManager";
import { registerAccountAuthPort } from "@core/auth/account-port";
// 账号端口注册：core/kernel 不再直连本模块（R1/R2），mock 的 accountManager 需显式注册进端口注册表
registerAccountAuthPort(accountManager);

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
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("auth 结果补全（参考 DoctoratePy）", () => {
  it("POST /user/online/v1/ping 应返回在线心跳 result 结构", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/online/v1/ping" }, res);
    expect(res.send).toHaveBeenCalledWith({
      alertTime: 600,
      interval: 120,
      message: "OK",
      result: 0,
      timeLeft: -1,
    });
  });

  describe("POST /user/auth/v1/login", () => {
    it("账号密码正确应返回完整 result（uid/token/isAuthenticate）", async () => {
      const res = mockRes();
      await call(
        authRouter,
        { method: "POST", url: "/user/auth/v1/login", body: { account: "13800000001", password: "pwd123456" } },
        res,
      );
      expect(res.send).toHaveBeenCalledWith({
        result: 0,
        uid: "10000",
        token: "secret_10000",
        isAuthenticate: true,
        isMinor: false,
        needAuthenticate: false,
        isLatestUserAgreement: true,
      });
    });

    it("账号不存在应返回 result 4", async () => {
      const res = mockRes();
      await call(
        authRouter,
        { method: "POST", url: "/user/auth/v1/login", body: { account: "13999999999", password: "x" } },
        res,
      );
      expect(res.send).toHaveBeenCalledWith({ result: 4 });
    });

    it("密码错误应返回 result 1", async () => {
      const res = mockRes();
      await call(
        authRouter,
        { method: "POST", url: "/user/auth/v1/login", body: { account: "13800000001", password: "wrong" } },
        res,
      );
      expect(res.send).toHaveBeenCalledWith({ result: 1 });
    });
  });

  describe("POST /user/auth/v1/register", () => {
    it("注册成功应返回 result 0 + token", async () => {
      const res = mockRes();
      await call(
        authRouter,
        { method: "POST", url: "/user/auth/v1/register", body: { account: "13800000002", password: "abc12345" } },
        res,
      );
      expect(res.send).toHaveBeenCalledWith(
        expect.objectContaining({
          result: 0,
          uid: "20000",
          token: expect.any(String),
          isAuthenticate: false,
          needAuthenticate: true,
        }),
      );
    });

    it("账号已存在应返回 result 5 + errMsg", async () => {
      const res = mockRes();
      await call(
        authRouter,
        { method: "POST", url: "/user/auth/v1/register", body: { account: "13800000001", password: "abc12345" } },
        res,
      );
      expect(res.send).toHaveBeenCalledWith(
        expect.objectContaining({ result: 5, errMsg: expect.any(String) }),
      );
    });

    it("密码格式错误应返回 result 5", async () => {
      const res = mockRes();
      await call(
        authRouter,
        { method: "POST", url: "/user/auth/v1/register", body: { account: "13800000003", password: "short" } },
        res,
      );
      expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ result: 5 }));
    });
  });

  it("POST /user/auth/v1/login_by_smscode 账号不存在应返回 result 1", async () => {
    const res = mockRes();
    await call(
      authRouter,
      { method: "POST", url: "/user/auth/v1/login_by_smscode", body: { account: "13999999999", smsCode: "1234" } },
      res,
    );
    expect(res.send).toHaveBeenCalledWith({ result: 1 });
  });

  it("POST /user/auth/v1/send_sms_code 应返回 result 0 + msg OK", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth/v1/send_sms_code", body: { account: "13800000001" } }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 0, msg: "OK" });
  });

  it("POST /user/info/v1/send_phone_code 应返回 status 0 + msg OK", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/info/v1/send_phone_code", body: { type: 0, token: "" } }, res);
    expect(res.send).toHaveBeenCalledWith({ status: 0, msg: "OK" });
  });

  it("POST /user/auth/v1/authenticate_user_identity 应返回实名认证 result", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth/v1/authenticate_user_identity", body: { name: "x", idCardNum: "" } }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 0, message: "OK", isMinor: false });
  });

  it("POST /user/auth/v1/update_agreement 应返回协议确认 result", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth/v1/update_agreement" }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 0, message: "OK", isMinor: false });
  });

  it("POST /u8/user/auth/v1/agreement_version 应返回协议版本（agreementUrl 动态跟随服务器地址）", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/u8/user/auth/v1/agreement_version" }, res);
    const arg = vi.mocked(res.send).mock.calls[0][0];
    expect(arg.status).toBe(0);
    expect(arg.msg).toBe("OK");
    expect(arg.data.authorized).toBe(true);
    expect(arg.data.isLatestUserAgreement).toBe(true);
    expect(arg.data.agreementUrl.privacy).toBe(
      "http://127.0.0.1:8443/protocol/plain/ak/privacy",
    );
  });

  it("GET /u8/user/auth/v1/agreement_version 应返回协议版本（同 POST 结构）", async () => {
    const res = mockRes();
    await call(authRouter, { method: "GET", url: "/u8/user/auth/v1/agreement_version" }, res);
    const arg = vi.mocked(res.send).mock.calls[0][0];
    expect(arg.data.agreementUrl.childrenPrivacy).toContain("/protocol/plain/ak/children_privacy");
    expect(arg.data.authorized).toBe(true);
  });

  it("GET /pcSdk/userInfo 应返回 null（对齐官服抓包）", async () => {
    const res = mockRes();
    await call(authRouter, { method: "GET", url: "/pcSdk/userInfo" }, res);
    expect(res.send).toHaveBeenCalledWith(null);
  });

  it("POST /u8/user/v1/getToken 应返回完整 U8 渠道结构（captcha/error/isNew）", async () => {
    const res = mockRes();
    await call(
      authRouter,
      {
        method: "POST",
        url: "/u8/user/v1/getToken",
        body: { extension: JSON.stringify({ code: "secret_10000" }) },
      },
      res,
    );
    const arg = vi.mocked(res.send).mock.calls[0][0];
    expect(arg).toEqual(
      expect.objectContaining({
        result: 0,
        captcha: {},
        error: "",
        uid: "10000",
        channelUid: "10000",
        token: "secret_10000",
        isGuest: 0,
        isNew: false,
      }),
    );
  });

  it("GET /user/info/v1/basic 应返回完整用户信息（identityNum/isMinor 等）", async () => {
    const res = mockRes();
    await call(
      authRouter,
      { method: "GET", url: "/user/info/v1/basic", query: { token: "secret_10000" } },
      res,
    );
    const arg = vi.mocked(res.send).mock.calls[0][0];
    expect(arg.data).toEqual(
      expect.objectContaining({
        phone: "13800000001",
        identityNum: "10000",
        identityName: "10000",
        isMinor: false,
        isLatestUserAgreement: true,
      }),
    );
  });

  it("POST /user/auth/v1/check_id_card 应返回身份证校验 result", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth/v1/check_id_card", body: { idCardNum: "11010119900101001X" } }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 0, message: "OK", isMinor: false });
  });

  it("POST /user/auth/v1/change_password 应返回 result 0", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth/v1/change_password", body: { newPassword: "abc12345", phoneCode: "1234" } }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 0, token: "secret_10000" });
  });

  it("POST /user/auth/v1/change_phone_check 应返回 result 0", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth/v1/change_phone_check" }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 0 });
  });

  it("POST /user/auth/v1/change_phone 应返回 result 0", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth/v1/change_phone", body: { newPhone: "13800000009", phoneCode: "1", newPhoneCode: "2" } }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 0, token: "secret_10000" });
  });

  it("POST /user/auth/v1/guest_login 应返回 result 3", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth/v1/guest_login" }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 3 });
  });

  it("POST /user/oauth2/v1/unbind_grant 应返回 status 0 + msg OK", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/oauth2/v1/unbind_grant", body: { token: "t", phoneCode: "1" } }, res);
    expect(res.send).toHaveBeenCalledWith({ status: 0, msg: "OK" });
  });

  it("POST /u8/pay/confirmOrderState 应返回 payState 0", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/u8/pay/confirmOrderState", body: { orderId: "1" } }, res);
    expect(res.send).toHaveBeenCalledWith({ payState: 0 });
  });

  it("POST /user/auth 应返回用户状态（token 换 uid/isAuthenticate）", async () => {
    const res = mockRes();
    await call(authRouter, { method: "POST", url: "/user/auth", body: { token: "secret_10000" } }, res);
    expect(res.send).toHaveBeenCalledWith({
      uid: "10000",
      isMinor: false,
      isAuthenticate: true,
      isGuest: false,
      needAuthenticate: false,
      isLatestUserAgreement: true,
    });
  });
});
