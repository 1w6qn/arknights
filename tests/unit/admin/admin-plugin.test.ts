import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { asModel } from "../../helpers";
import type { PluginCatalogEntry } from "@ops/plugin";

vi.mock("@ops/admin/admin-service", () => ({
  adminService: {},
}));
vi.mock("@ops/admin/admin-auth", () => ({
  adminAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));
vi.mock("@ops/admin/cli-exec", () => ({ cliExec: vi.fn() }));
vi.mock("@core/config/index", () => ({ default: {} }));
vi.mock("@capture/capture-manager", () => ({ captureManager: {} }));
vi.mock("@logs/log-service", () => ({ logService: {} }));
vi.mock("@utils/sse", () => ({ createSse: vi.fn(() => () => {}), sseSend: vi.fn() }));
vi.mock("@plugin/index", () => ({
  pluginConfigService: {
    getAll: vi.fn(),
    getAllOptions: vi.fn(),
    setEnabled: vi.fn(),
  },
}));

import adminRouter from "@ops/admin/admin-router";
import { pluginConfigService } from "@plugin/index";

/** 插件路由测试请求视图：只声明被测分支读到的成员 */
interface MockReq {
  method: string;
  url: string;
  params?: Request["params"];
}

/**
 * res.sendFile 的单签名视图
 *
 * 真实声明是两个重载签名，vitest 的 `Mock<T>` 不可赋给重载函数类型，
 * 故按 `Parameters` 取末位重载收成单签名。
 */
type SendFileFn = (...args: Parameters<Response["sendFile"]>) => void;

/** 插件路由测试响应视图：只声明被测分支读到的成员 */
interface MockRes {
  send: Response["send"];
  sendFile: SendFileFn;
  status: Response["status"];
  json: Response["json"];
  sendStatus: Response["sendStatus"];
  set: Response["set"];
}

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    sendFile: vi.fn<SendFileFn>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    json: vi.fn<Response["json"]>(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    set: vi.fn<Response["set"]>().mockReturnThis(),
  };
}

type RouterReq = Parameters<typeof adminRouter>[0];

async function call(req: MockReq, res: MockRes) {
  adminRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("admin 插件管理端点", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/plugin 应返回插件列表", async () => {
    vi.mocked(pluginConfigService.getAll).mockResolvedValue([
      asModel<PluginCatalogEntry & { enabled: boolean }>({
        id: "enemy_hp",
        name: "敌人血量显示",
        desc: "",
        enabled: true,
      }),
    ]);
    vi.mocked(pluginConfigService.getAllOptions).mockResolvedValue({
      enemy_hp: { font_size: 20 },
    });
    const res = mockRes();
    await call({ method: "GET", url: "/api/plugin" }, res);
    expect(pluginConfigService.getAll).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      plugins: [{ id: "enemy_hp", name: "敌人血量显示", desc: "", enabled: true }],
      options: { enemy_hp: { font_size: 20 } },
    });
  });

  it("POST /api/plugin/:id/enable 应启用插件", async () => {
    vi.mocked(pluginConfigService.setEnabled).mockResolvedValue(true);
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/plugin/enemy_hp/enable", params: { id: "enemy_hp" } },
      res,
    );
    expect(pluginConfigService.setEnabled).toHaveBeenCalledWith("enemy_hp", true);
    expect(res.json).toHaveBeenCalledWith({ ok: true, id: "enemy_hp", enabled: true });
  });

  it("POST /api/plugin/:id/disable 应停用插件", async () => {
    vi.mocked(pluginConfigService.setEnabled).mockResolvedValue(false);
    const res = mockRes();
    await call(
      { method: "POST", url: "/api/plugin/battle_assist/disable", params: { id: "battle_assist" } },
      res,
    );
    expect(pluginConfigService.setEnabled).toHaveBeenCalledWith("battle_assist", false);
    expect(res.json).toHaveBeenCalledWith({ ok: true, id: "battle_assist", enabled: false });
  });

  it("enable 时插件不存在应返回 400", async () => {
    vi.mocked(pluginConfigService.setEnabled).mockRejectedValue(new Error("未知插件: nope"));
    const res = mockRes();
    await call({ method: "POST", url: "/api/plugin/nope/enable", params: { id: "nope" } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "未知插件: nope" });
  });
});