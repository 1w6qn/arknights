import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

// 策略模块经 @game/modules/account/AccountManager 访问 accountManager —— mock 以便隔离验证
vi.mock("@game/modules/account/account-manager", () => ({
  accountManager: { getUidByToken: vi.fn(), registerUser: vi.fn() },
}));

import { accountManager } from "@game/modules/account/account-manager";
import { registerAccountAuthPort } from "@core/auth/account-port";
// 账号端口注册：core/kernel 不再直连本模块（R1/R2），mock 的 accountManager 需显式注册进端口注册表
registerAccountAuthPort(accountManager);
import {
  SingleAccountStrategy,
  RealAccountStrategy,
  createAuthStrategy,
} from "@game/kernel/http/auth-strategy";
import type { AuthAccountPort } from "@game/kernel/http/auth-strategy";

/** 构造最小 Express 请求对象（策略只读取 `headers.secret`；真实 Request 可赋给该替身形状） */
function mockReq(headers: Request["headers"] = {}): Request {
  return { headers } as Request;
}

describe("SingleAccountStrategy 单账号私服策略", () => {
  it("缺省 uid 固定为 1（兼容任意/缺失 secret）", async () => {
    const s = new SingleAccountStrategy({ authMode: "single" });
    expect(await s.resolveUid(mockReq({ secret: "2221" }))).toBe("1");
    expect(await s.resolveUid(mockReq({ secret: "aId1QCwRP8rVkxSYsG4bCzjQ" }))).toBe("1");
    expect(await s.resolveUid(mockReq({}))).toBe("1");
    expect(s.forceSecretHeader).toBe(true);
  });

  it("配置 singleUid 时固定返回该账号（过渡用）", async () => {
    const s = new SingleAccountStrategy({ authMode: "single", singleUid: "2222" });
    expect(await s.resolveUid(mockReq({ secret: "any" }))).toBe("2222");
  });

  it("registerUid 收敛到固定账号（不真正建号）", async () => {
    const s = new SingleAccountStrategy({ authMode: "single" });
    expect(await s.registerUid("13900001111", "pwd123456")).toBe("1");
    const s2 = new SingleAccountStrategy({ authMode: "single", singleUid: "2222" });
    expect(await s2.registerUid("x", "y")).toBe("2222");
  });
});

describe("RealAccountStrategy 真实多账号策略", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("有效 secret（账号 token）→ 解析出对应 uid", async () => {
    vi.mocked(accountManager.getUidByToken).mockResolvedValue("2221");
    const s = new RealAccountStrategy();
    expect(await s.resolveUid(mockReq({ secret: "secret_2221" }))).toBe("2221");
    expect(accountManager.getUidByToken).toHaveBeenCalledWith("secret_2221");
    expect(s.forceSecretHeader).toBe(false);
  });

  it("无效 secret → undefined（中间件据此返回 401）", async () => {
    vi.mocked(accountManager.getUidByToken).mockResolvedValue("");
    const s = new RealAccountStrategy();
    expect(await s.resolveUid(mockReq({ secret: "bad" }))).toBeUndefined();
  });

  it("缺失 secret → undefined", async () => {
    const s = new RealAccountStrategy();
    expect(await s.resolveUid(mockReq({}))).toBeUndefined();
  });

  it("registerUid 委托 AccountManager 真正建号", async () => {
    vi.mocked(accountManager.registerUser).mockResolvedValue("42");
    const s = new RealAccountStrategy();
    expect(await s.registerUid("13800000000", "pwd123456")).toBe("42");
    expect(accountManager.registerUser).toHaveBeenCalledWith("13800000000", "pwd123456");
  });
});

describe("RealAccountStrategy 账号端口注入（AuthAccountPort）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("注入端口后无需模块打桩：resolveUid/registerUid 全部走端口", async () => {
    const port: AuthAccountPort = {
      getUidByToken: vi.fn(async (token: string) => (token === "ok" ? "777" : "")),
      registerUser: vi.fn(async () => "888"),
    };
    const s = new RealAccountStrategy(port);

    expect(await s.resolveUid(mockReq({ secret: "ok" }))).toBe("777");
    expect(await s.resolveUid(mockReq({ secret: "bad" }))).toBeUndefined();
    expect(await s.registerUid("13800000000", "pwd123456")).toBe("888");
    expect(port.getUidByToken).toHaveBeenCalledWith("ok");
    expect(port.registerUser).toHaveBeenCalledWith("13800000000", "pwd123456");
    // 端口被使用即意味着没有回落到全局单例
    expect(accountManager.getUidByToken).not.toHaveBeenCalled();
    expect(accountManager.registerUser).not.toHaveBeenCalled();
  });

  it("缺省端口回落 accountManager 单例（行为与迁移前一致）", async () => {
    vi.mocked(accountManager.getUidByToken).mockResolvedValue("2221");
    const s = new RealAccountStrategy();
    expect(await s.resolveUid(mockReq({ secret: "secret_2221" }))).toBe("2221");
  });

  it("工厂透传端口：createAuthStrategy(cfg, port) 的 real 策略使用注入端口", async () => {
    const port: AuthAccountPort = {
      getUidByToken: vi.fn(async () => "999"),
      registerUser: vi.fn(async () => "999"),
    };
    const s = createAuthStrategy({ authMode: "real" }, port);
    expect(s).toBeInstanceOf(RealAccountStrategy);
    expect(await s.resolveUid(mockReq({ secret: "x" }))).toBe("999");
  });
});

describe("createAuthStrategy 工厂（唯一 authMode 决策点）", () => {
  it("real → RealAccountStrategy；single/缺省 → SingleAccountStrategy", () => {
    expect(createAuthStrategy({ authMode: "real" })).toBeInstanceOf(RealAccountStrategy);
    expect(createAuthStrategy({ authMode: "single" })).toBeInstanceOf(SingleAccountStrategy);
    expect(createAuthStrategy({})).toBeInstanceOf(SingleAccountStrategy);
  });
});