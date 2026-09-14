import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

vi.mock("@ops/admin/admin-service", () => ({
  adminService: {
    status: vi.fn().mockResolvedValue({ online: true }),
    logs: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("@ops/admin/admin-auth", () => ({
  adminAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));
vi.mock("@ops/admin/cli-exec", () => ({ cliExec: vi.fn() }));
vi.mock("@core/config/index", () => ({ default: {} }));
vi.mock("@plugin/index", () => ({
  pluginConfigService: { getAll: vi.fn().mockResolvedValue([]), setEnabled: vi.fn() },
}));

const assetList = {
  items: [
    { id: 1, name: "hot_update_list.json", category: "manifest", source: "cdn", version: "v1", hash: "a", size: 10, updatedAt: 1 },
  ],
  total: 1,
};
const assetLineage = {
  asset: { id: 1, name: "hot_update_list.json", category: "manifest", source: "cdn", version: "v1", hash: "a", size: 10 },
  events: [{ id: 1, eid: "E-1", action: "acquire", actor: "router", source: "cdn", ts: 1 }],
};
const eventList = { items: assetLineage.events, total: 1 };

vi.mock("@asset/asset-service", () => ({
  assetRegistry: {
    listAssets: vi.fn(() => Promise.resolve(assetList)),
    getAssetLineage: vi.fn(() => Promise.resolve(assetLineage)),
    listEvents: vi.fn(() => Promise.resolve(eventList)),
    subscribe: vi.fn(() => () => {}),
  },
}));
vi.mock("@utils/sse", () => ({
  createSse: vi.fn(() => () => {}),
  sseSend: vi.fn(),
}));

import adminRouter from "@ops/admin/admin-router";
import { assetRegistry } from "@asset/asset-service";

/** res.sendFile 的单签名视图（真实为重载签名，vitest Mock 不可赋给重载函数类型） */
type SendFileFn = (...args: Parameters<Response["sendFile"]>) => void;

/** 资产路由测试请求视图：只声明被测分支读到的成员 */
interface MockReq {
  method: string;
  url: string;
  query?: Request["query"];
}

/** 资产路由测试响应视图：只声明被测分支读到的成员 */
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

describe("资产 Admin API", () => {
  beforeEach(() => {
    vi.mocked(assetRegistry.listAssets).mockClear();
    vi.mocked(assetRegistry.getAssetLineage).mockClear();
  });

  it("GET /api/asset 透传分类/名称过滤并返回列表", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/asset", query: { category: "manifest", name: "hot", limit: "50" } }, res);
    expect(assetRegistry.listAssets).toHaveBeenCalledWith({ category: "manifest", name: "hot", limit: 50, offset: undefined });
    expect(res.json).toHaveBeenCalledWith(assetList);
  });

  it("GET /api/asset/lineage 带 name 返回溯源链", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/asset/lineage", query: { name: "hot_update_list.json" } }, res);
    expect(assetRegistry.getAssetLineage).toHaveBeenCalledWith("hot_update_list.json");
    expect(res.json).toHaveBeenCalledWith(assetLineage);
  });

  it("GET /api/asset/lineage 缺 name 返回 400", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/asset/lineage", query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("name") }));
  });

  it("GET /api/asset/events 返回事件流", async () => {
    const res = mockRes();
    await call({ method: "GET", url: "/api/asset/events", query: { action: "acquire" } }, res);
    expect(res.json).toHaveBeenCalledWith(eventList);
  });
});