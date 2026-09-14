import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { createServer, Server, request } from "http";
import { AddressInfo } from "net";

/**
 * plugin-heartbeat 路由（Lua 插件生效确认 + 启停状态同步）
 *
 * GET /plugin/heartbeat            —— 生效确认（含 catalog/启用态）
 * GET /plugin/config/:id/:value    —— 客户端启停状态同步（value=0/1）
 *
 * 通过 vi.mock 拦截 pluginConfigService，避免测试触碰真实 data/plugin/config.json。
 * mock 路径与生产 import 一致取 `@plugin/index`（裸 `@plugin` 无法被 TS 路径映射解析）。
 */

/** 插件目录行（getAll 的返回面，见 app/ops/plugin/PluginConfigService.ts） */
interface PluginCatalogRow {
  id: string;
  name: string;
  desc: string;
  module: string;
  enabled: boolean;
}

const pluginServiceMock = vi.hoisted(() => ({
  has: vi.fn((id: string) => id === "enemy_hp"),
  setEnabled: vi.fn(async (_id: string, _v: boolean) => true),
  getAll: vi.fn(
    async (): Promise<PluginCatalogRow[]> => [
      { id: "enemy_hp", name: "敌人血量显示", desc: "", module: "Plugin/EnemyHpPlugin", enabled: true },
      { id: "plugin_panel", name: "插件管理面板", desc: "", module: "Plugin/PanelPlugin", enabled: false },
    ],
  ),
}));
vi.mock("@plugin/index", () => ({ pluginConfigService: pluginServiceMock }));

// eslint-disable-next-line import/first
import pluginHeartbeatRouter from "@game/modules/system/plugin.routes";

const mockedService = pluginServiceMock;

/** 端点响应体读取视图（本用例只读这四个字段） */
interface PluginEndpointBody {
  status: number;
  pluginCount: number;
  enabled: number;
  catalog: { id: string; enabled: boolean }[];
}

describe("plugin-heartbeat 路由", () => {
  let server: Server;

  afterEach(() => {
    server?.close();
    vi.clearAllMocks();
  });

  async function startApp(): Promise<string> {
    const app = express();
    app.use("/plugin", pluginHeartbeatRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function getJson(url: string): Promise<{ statusCode: number; body: PluginEndpointBody }> {
    return new Promise((resolve, reject) => {
      const req = request(url, { method: "GET" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("GET /plugin/heartbeat 返回目录与启用态", async () => {
    const base = await startApp();
    const { body } = await getJson(`${base}/plugin/heartbeat`);
    expect(body.status).toBe(0);
    expect(body.pluginCount).toBe(2);
    expect(body.enabled).toBe(1);
    expect(body.catalog).toHaveLength(2);
    expect(body.catalog[0]).toMatchObject({ id: "enemy_hp", enabled: true });
  });

  it("GET /plugin/config/:id/:value 同步启用态并持久化", async () => {
    const base = await startApp();
    const { body } = await getJson(`${base}/plugin/config/enemy_hp/1`);
    expect(body.status).toBe(0);
    expect(mockedService.setEnabled).toHaveBeenCalledWith("enemy_hp", true);
  });

  it("GET /plugin/config 未知插件返回 status=1 且不持久化", async () => {
    const base = await startApp();
    const { body } = await getJson(`${base}/plugin/config/nope/1`);
    expect(body.status).toBe(1);
    expect(mockedService.setEnabled).not.toHaveBeenCalled();
  });

  it("GET /plugin/config 非法 value 返回 status=1 且不持久化", async () => {
    const base = await startApp();
    const { body } = await getJson(`${base}/plugin/config/enemy_hp/2`);
    expect(body.status).toBe(1);
    expect(mockedService.setEnabled).not.toHaveBeenCalled();
  });
});
