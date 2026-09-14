import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { JsonValue } from "@excel/json-value";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("@utils/time", () => ({ now: () => 1234567890, userTimestamp: () => 1234567890 }));

const accountMock = vi.hoisted(() => ({
  getUidByToken: vi.fn(),
  getUserConfig: vi.fn(),
}));
vi.mock("@game/modules/account/account-manager", () => ({
  accountManager: accountMock,
}));

import type { Response } from "express";
import accountRouter from "@game/modules/account/routes";
import httpContext from "express-http-context2";

/** 账号请求体视图（本文件各端点字段合集） */
interface AccountBody {
  token?: string;
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body?: AccountBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
  type: Response["type"];
}

type RouterReq = Parameters<typeof accountRouter>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
    type: vi.fn<Response["type"]>().mockReturnThis(),
  };
}

async function call(req: MockReq, res: MockRes): Promise<MockRes> {
  // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
  accountRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

/** 账号存档 draft 夹具视图（只声明本用例读写的 pushFlags.status） */
interface AccountDraftFixture {
  pushFlags: { status: number };
}

/** account 玩家组合根替身视图 */
interface AccountPlayerFixture {
  delta: {
    playerDataDelta: {
      modified: { pushFlags: { status: number } };
      deleted: Record<string, never>;
    };
  };
  update: Mock<(recipe: (draft: AccountDraftFixture) => Promise<void>) => Promise<void>>;
  toJSON: Mock<() => AccountDraftFixture>;
  toJSONString: Mock<() => string>;
  _playerdata: AccountDraftFixture;
  _trigger: { emit: Mock<(eventName: string, payload: JsonValue[]) => Promise<void>> };
  pushLoginNotice: Mock<() => void>;
}

/**
 * 账号用例的组合根替身
 *
 * update 复刻真实组合根的「draft 回写」语义（本用例只关心 pushFlags.status）。
 */
function makeMockPlayer(): AccountPlayerFixture {
  const self: AccountPlayerFixture = {
    delta: {
      playerDataDelta: { modified: { pushFlags: { status: 1234567890 } }, deleted: {} },
    },
    update: vi
      .fn<(recipe: (draft: AccountDraftFixture) => Promise<void>) => Promise<void>>()
      .mockImplementation(async (recipe) => {
        const draft: AccountDraftFixture = { pushFlags: { status: 0 } };
        await recipe(draft);
        self._playerdata.pushFlags.status = draft.pushFlags.status;
      }),
    toJSON: vi.fn(() => self._playerdata),
    toJSONString: vi.fn(() => JSON.stringify(self._playerdata)),
    _playerdata: { pushFlags: { status: 0 } },
    _trigger: { emit: vi.fn().mockResolvedValue(undefined) },
    pushLoginNotice: vi.fn(),
  };
  return self;
}

describe("account 路由", () => {
  let mockPlayer: AccountPlayerFixture;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlayer = makeMockPlayer();
    vi.mocked(httpContext.get).mockReturnValue(mockPlayer);
  });

  it("login 应按 token 解析：single 模式任意 token 收敛到单例账号并返回账号 secret", async () => {
    accountMock.getUidByToken.mockResolvedValue("2222");
    accountMock.getUserConfig.mockResolvedValue({
      uid: "2222",
      secret: "md5secret",
      auth: {},
      social: {},
      battle: {},
      gacha: {},
      rlv2: {},
    });
    const res = mockRes();
    await call({ method: "POST", url: "/login", body: { token: "whatever" } }, res);
    expect(accountMock.getUidByToken).toHaveBeenCalledWith("whatever");
    expect(res.send).toHaveBeenCalledWith({
      result: 0,
      uid: "2222",
      secret: "md5secret",
      serviceLicenseVersion: 0,
      majorVersion: "446",
    });
  });

  it("login 应按 token 解析：real 模式有效 token 返回对应 uid + 账号 secret", async () => {
    accountMock.getUidByToken.mockResolvedValue("5");
    accountMock.getUserConfig.mockResolvedValue({
      uid: "5",
      secret: "s5",
      auth: {},
      social: {},
      battle: {},
      gacha: {},
      rlv2: {},
    });
    const res = mockRes();
    await call({ method: "POST", url: "/login", body: { token: "s5" } }, res);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: 0, uid: "5", secret: "s5" }),
    );
  });

  it("login 应按 token 解析：real 模式无效 token 返回 result 3（记忆已模糊）", async () => {
    accountMock.getUidByToken.mockResolvedValue("");
    const res = mockRes();
    await call({ method: "POST", url: "/login", body: { token: "bad-token" } }, res);
    expect(res.send).toHaveBeenCalledWith({ result: 3 });
  });

  it("login 应按 token 解析：无 secret 旧账号回退 uid 作为 secret", async () => {
    accountMock.getUidByToken.mockResolvedValue("9");
    accountMock.getUserConfig.mockResolvedValue(undefined);
    const res = mockRes();
    await call({ method: "POST", url: "/login", body: { token: "9" } }, res);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: 0, uid: "9", secret: "9" }),
    );
  });

  it("syncData 应更新 pushFlags.status 并返回 user + playerDataDelta", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/syncData" }, res);
    // 更新登录时间戳
    expect(mockPlayer.update).toHaveBeenCalled();
    expect(mockPlayer._playerdata.pushFlags.status).toBe(1234567890);
    // 保留 playerDataDelta（Immer patches 增量）
    const arg = JSON.parse(vi.mocked(res.send).mock.calls[0][0] as string);
    // 契约形状对齐官服抓包（reference/tmp/account_syncData_*.json）：{ result, ts, user, playerDataDelta }
    expect(Object.keys(arg).sort()).toEqual([
      "playerDataDelta",
      "result",
      "ts",
      "user",
    ]);
    expect(arg.result).toBe(0);
    expect(arg.ts).toBe(1234567890);
    // user 字段 = player.toJSON()（序列化后的玩家数据）
    expect(arg.user).toEqual(mockPlayer._playerdata);
    expect(arg.playerDataDelta).toEqual({
      modified: { pushFlags: { status: 1234567890 } },
      deleted: {},
    });
    // 登录提示：首次数同步调用一次本项目信息推送
    expect(mockPlayer.pushLoginNotice).toHaveBeenCalledTimes(1);
  });

  it("syncStatus 应触发 status:refresh:time 事件", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/syncStatus" }, res);
    expect(mockPlayer._trigger.emit).toHaveBeenCalledWith("status:refresh:time", []);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ ts: 1234567890, result: {} }),
    );
  });

  it("syncPushMessage 应返回 now/next 与 delta（对齐官服 now/next 字段）", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/syncPushMessage" }, res);
    expect(res.send).toHaveBeenCalledWith({
      now: 1234567890,
      next: 1234567950,
      playerDataDelta: { modified: { pushFlags: { status: 1234567890 } }, deleted: {} },
    });
  });

  it("syncData 无 playerData（real 模式无 secret 头）应返回 401 而非 500", async () => {
    vi.mocked(httpContext.get).mockReturnValue(undefined);
    const res = mockRes();
    await call({ method: "POST", url: "/syncData" }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ status: 401, msg: "未登录（缺少 secret）" });
  });
});
