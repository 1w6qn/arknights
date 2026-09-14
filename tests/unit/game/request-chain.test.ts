import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import bodyParser from "body-parser";
import httpContext from "express-http-context2";

// —— 模块级 mock（需在 import 被测模块前建立）——

/** 被测模块 app/core/config 的 mock：authMode/singleUid 可热切换
 *
 * （此前的 excel 门面方法为历史复制粘贴残留，config 模块并无这些成员、也无调用方，故移除）
 */
const configMock = vi.hoisted(() => ({
  default: {
    authMode: "single",
    singleUid: "1",
  },
}));
vi.mock("@core/config/index", () => configMock);

/** 被测模块 AccountManager 的 mock：getPlayerData/getUidByToken 由各用例注入行为 */
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
vi.mock("@game/modules/account/account-manager", () => accountMock);
import { registerAccountAuthPort } from "@core/auth/account-port";
registerAccountAuthPort(accountMock.accountManager);

/** excel 行夹具视图（本文件不读取行字段） */
interface ExcelRowMock {
  name?: string;
}

/**
 * excel 替身夹具视图
 *
 * 门面方法按 excel.ts 实现索引替身表；本文件未提供的表声明为可选
 * （`this.X?.` 读取与「键不存在」运行期等价，不改变替身形状）。
 */
interface ExcelMockFixture {
  getItem(id: string): ExcelRowMock | undefined;
  itemName(id: string): string;
  makeItem(id: string, count: number, type?: string): { id: string; count: number; type?: string };
  charData(charId: string): ExcelRowMock | undefined;
  stageData(stageId: string): ExcelRowMock | undefined;
  ItemTable?: { items?: Record<string, ExcelRowMock> };
  CharacterTable?: Record<string, ExcelRowMock>;
  StageTable?: { stages?: Record<string, ExcelRowMock> };
  DisplayMetaTable: null;
}

/** 避免加载真实 excel 数据表（重量级磁盘 IO），仅满足路由 import 的依赖形状 */
vi.mock("@excel/excel", (): { default: ExcelMockFixture } => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
 DisplayMetaTable: null },
}));

import { authMiddleware, gameErrorHandler } from "../../../app/game/app";
import userRouter from "@game/modules/user/routes";
import miscAlignmentRouter from "@game/modules/misc-alignment/routes";
import auditRouter from "@game/modules/system/routes";

/** mock 玩家的存档种子（链路只经 update recipe 读写；delta 由 getter 提供） */
interface RequestChainPlayerData {
  status: { uid: number; nickName: string };
}

/** update 配方（draft 与 mock 存档同形） */
type RequestChainRecipe = (
  draft: RequestChainPlayerData,
) => RequestChainPlayerData | Promise<RequestChainPlayerData>;

/**
 * 创建可满足被测路由契约的 mock 玩家
 *
 * 仅提供被测链路上需要的成员：delta 只读 getter（返回合法 playerDataDelta 结构）、
 * update 配方执行器、checkIn 子管理器。其余子管理器按需补齐。
 * @param opts - 可选 uid（默认 "1"）
 * @returns 形如 PlayerDataManager 的 mock 对象
 */
function createMockPlayer(opts: { uid?: string } = {}) {
  const uid = opts.uid ?? "1";
  const playerdata: RequestChainPlayerData = { status: { uid: Number(uid), nickName: "TestUser" } };
  return {
    uid,
    _playerdata: playerdata,
    update: vi.fn(async (recipe: RequestChainRecipe) => {
      await recipe(playerdata);
    }),
    checkIn: { checkIn: vi.fn(async () => ({ result: 0 })) },
    _trigger: { emit: vi.fn() },
    get delta() {
      return { playerDataDelta: { modified: {}, deleted: {} } };
    },
  };
}

/**
 * 构造被测 Express 应用
 *
 * 复刻真实链路顺序：httpContext 中间件 → JSON 解析 → authMiddleware →
 * 业务/杂项/审计路由 → 统一错误处理。挂载 /user、根级 misc-alignment、/audit。
 * @returns 未监听的 Express 应用
 */
function buildApp(): express.Express {
  const app = express();
  app.use(httpContext.middleware);
  app.use(bodyParser.json());
  app.use(authMiddleware);
  app.use("/user", userRouter);
  app.use(miscAlignmentRouter); // 根级挂载（telemetry/odpy-only/api 等 stub）
  app.use("/audit", auditRouter);
  app.use(gameErrorHandler);
  return app;
}

describe("客户端请求链集成（auth → 路由 → delta）", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(buildApp());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    configMock.default.authMode = "single";
    configMock.default.singleUid = "1";
    accountMock.accountManager.getPlayerData.mockResolvedValue(createMockPlayer({ uid: "1" }));
  });

  it("single 模式：带任意 secret 的请求解析到 uid=1 并进入业务路由", async () => {
    const res = await fetch(`${baseUrl}/user/checkIn`, {
      method: "POST",
      headers: { "content-type": "application/json", secret: "2221" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 高流量业务链返回合法 playerDataDelta 结构
    expect(body.playerDataDelta).toBeDefined();
    expect(body.playerDataDelta).toHaveProperty("modified");
    expect(body.playerDataDelta).toHaveProperty("deleted");
    expect(accountMock.accountManager.getPlayerData).toHaveBeenCalledWith("1");
  });

  it("single 模式：缺失 secret 的请求同样注入 uid=1 并进入业务路由", async () => {
    const res = await fetch(`${baseUrl}/user/checkIn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.playerDataDelta).toBeDefined();
    expect(accountMock.accountManager.getPlayerData).toHaveBeenCalledWith("1");
  });

  it("real 模式：有效 secret 解析到对应账号并进入业务路由", async () => {
    configMock.default.authMode = "real";
    accountMock.accountManager.getUidByToken.mockResolvedValue("2221");
    accountMock.accountManager.getPlayerData.mockResolvedValue(createMockPlayer({ uid: "2221" }));

    const res = await fetch(`${baseUrl}/user/checkIn`, {
      method: "POST",
      headers: { "content-type": "application/json", secret: "token_2221" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(accountMock.accountManager.getUidByToken).toHaveBeenCalledWith("token_2221");
    expect(accountMock.accountManager.getPlayerData).toHaveBeenCalledWith("2221");
    const body = await res.json();
    expect(body.playerDataDelta).toBeDefined();
  });

  it("real 模式：无效 secret 返回 401 且不进入业务路由", async () => {
    configMock.default.authMode = "real";
    accountMock.accountManager.getUidByToken.mockResolvedValue("");

    const res = await fetch(`${baseUrl}/user/checkIn`, {
      method: "POST",
      headers: { "content-type": "application/json", secret: "bad" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(accountMock.accountManager.getPlayerData).not.toHaveBeenCalled();
  });

  it("real 模式：未携带 secret 的请求匿名放行（登录/控制路径不 401）", async () => {
    configMock.default.authMode = "real";
    // 匿名请求解析失败 → 放行进入 stub 路由（misc-alignment，不依赖 playerData），不注入 playerData
    const res = await fetch(`${baseUrl}/analytics/collect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(accountMock.accountManager.getPlayerData).not.toHaveBeenCalled();
  });

  it("stub 端点：遥测路径返回空但不 500", async () => {
    const res = await fetch(`${baseUrl}/analytics/collect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("stub 端点：资源版本审计 /audit/official/* 返回空但不 500", async () => {
    const res = await fetch(
      `${baseUrl}/audit/official/Android/assets/abc123/version_res`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});