import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 配置替身（仅 admin 段——被测模块只读 config.admin）
 *
 * 类型按真实 Config 的 admin 字段声明（enable 必填、token 可选），用例可逐项覆盖。
 */
const configMock = vi.hoisted(() => ({
  default: {
    admin: undefined as
      | { enable: boolean; token?: string; allowRemote?: boolean }
      | undefined,
  },
}));
vi.mock("@core/config/index", () => configMock);
vi.mock("@utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getAdminConfig } from "@ops/admin/admin-config";

/** 历史硬编码默认令牌（安全审阅要求不再作为回退值） */
const LEGACY_DEFAULT_TOKEN = "doctorate-admin";

describe("getAdminConfig 令牌解析（去硬编码）", () => {
  beforeEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it("ADMIN_TOKEN 环境变量优先于 data/config.json", () => {
    process.env.ADMIN_TOKEN = "env-secret";
    configMock.default.admin = { enable: true, token: "config-secret" };
    expect(getAdminConfig()).toEqual({ enable: true, token: "env-secret" });
    delete process.env.ADMIN_TOKEN;
  });

  it("env 缺失时回退 config.admin.token", () => {
    configMock.default.admin = { enable: true, token: "config-secret" };
    expect(getAdminConfig().token).toBe("config-secret");
  });

  it("均未配置时生成进程内随机令牌（不再回退可猜常量）", () => {
    configMock.default.admin = { enable: false };
    const first = getAdminConfig();
    const second = getAdminConfig();
    expect(first.token).not.toBe(LEGACY_DEFAULT_TOKEN);
    // base64url(24B) = 32 字符
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // 进程内稳定（每次请求不变化）
    expect(second.token).toBe(first.token);
    // enable 缺省仍为 false——令牌缺失不会打开管理接口
    expect(first.enable).toBe(false);
  });
});
