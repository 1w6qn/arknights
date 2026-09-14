import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import bodyParser from "body-parser";
import httpContext from "express-http-context2";
import type { JsonValue } from "@excel/json-value";
import type { PlayerDataManager } from "@game/kernel/player-data-manager";
import { openDatabase, closeDatabase } from "@core/db/database";
import excel from "@game/excel/excel";
import { accountManager } from "@game/modules/account/account-manager";
import { authMiddleware, gameErrorHandler } from "../../app/game/app";
import authRouter from "@core/auth/auth";
import userRouter from "@game/modules/user/routes";
import gachaRouter from "@game/modules/gacha/routes";
import shopRouter from "@game/modules/shop/routes";
import mailRouter from "@game/modules/mail/routes";
import socialRouter from "@game/modules/social/routes";
import rlv2Router from "@game/modules/roguelike/rlv2.routes";

/**
 * 一个 HTTP 请求的响应封装
 * @property status - HTTP 状态码
 * @property body - 解析后的 JSON（非 JSON 响应时为空对象）
 * @typeParam TBody - 响应体形状（各端点不同，由调用点按被测契约显式给出）
 */
export interface ApiResponse<TBody extends JsonValue = JsonValue> {
  status: number;
  /**
   * 解析后的 JSON（非 JSON 响应时为空对象）
   *
   * 各端点响应体形状不同且测试按端点做深层断言（`body.playerDataDelta.modified…`），
   * 故此处按调用点显式给出的响应契约参数化（`fx.post<LoginResponse>(…)`），缺省为
   * JSON 域（`JsonValue`）。这样既不再用 `any`，也不把深层断言压成不可读的收窄代码。
   */
  body: TBody;
}

/**
 * 真实集成测试夹具
 *
 * 附带了真实业务运行所需的环境（内存 SQLite + 真实 excel + 真实 accountManager），
 * 并通过真实 HTTP server 暴露游戏路由。测试可据此验证「输入请求体 → 输出 playerDataDelta」。
 * @property baseUrl - 随机端口 HTTP 基础地址
 * @property register - 新建账号（复用官方 /user/auth/v1/register 链路），返回 uid 与 secret
 * @property post - 发送 JSON POST 请求（可带 secret 头），返回状态码与解析后的 body
 * @property getPlayerData - 按 uid 获取内存中的真实玩家数据管理器
 * @property close - 关闭服务器与数据库
 */
export interface ApiFixture {
  baseUrl: string;
  register: (account: string, password: string) => Promise<{ uid: string; secret: string }>;
  post: <TBody extends JsonValue = JsonValue>(
    path: string,
    body?: JsonValue,
    secret?: string,
  ) => Promise<ApiResponse<TBody>>;
  getPlayerData: (uid: string) => PlayerDataManager;
  close: () => Promise<void>;
}

/**
 * 启动一套真实游戏 API 集成测试环境
 *
 * 初始化顺序（有依赖，必须保持）：
 * 1. await openDatabase(":memory:")——建立全局内存 SQLite 连接（绝不读写真实库文件）
 * 2. excel.init()——真实加载 data/excel/*.json 数据表（含 gacha 抽卡配置）
 * 3. accountManager.init()——复用内存库加载/迁移用户配置（只读真实 users.json 种子）
 * 4. 组装 Express 应用并挂载 auth + 各游戏路由（认证→路由→统一错误处理）
 * 5. 监听随机端口
 * @returns 可直接用于发请求的集成夹具
 */
export async function startApiFixture(): Promise<ApiFixture> {
  await openDatabase(":memory:");
  await excel.init();
  await accountManager.init();

  const app = express();
  app.use(httpContext.middleware);
  app.use(bodyParser.json());
  app.use(authMiddleware);
  // 认证路由挂根（含 /user/auth/v1/register、/user/auth/v1/login）
  app.use("/", authRouter);
  app.use("/user", userRouter);
  app.use("/gacha", gachaRouter);
  app.use("/shop", shopRouter);
  app.use("/mail", mailRouter);
  app.use("/social", socialRouter);
  app.use("/rlv2", rlv2Router);
  app.use(gameErrorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    register: async (account, password) => {
      const res = await fetch(`${baseUrl}/user/auth/v1/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, password }),
      });
      const body = await res.json();
      if (res.status !== 200 || body.result !== 0) {
        throw new Error(`注册失败 account=${account}：${JSON.stringify(body)}`);
      }
      return { uid: String(body.uid), secret: String(body.token) };
    },
    post: async <TBody extends JsonValue = JsonValue>(
      path: string,
      body: JsonValue = {},
      secret?: string,
    ): Promise<ApiResponse<TBody>> => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (secret) headers["secret"] = secret;
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: JsonValue = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      // I/O 边界：HTTP 响应体是未建模 JSON（JsonValue），端点契约由调用点经 `TBody` 给出
      // （`fx.post<LoginResponse>(…)`），此处按该契约收窄——TBody 受 `extends JsonValue` 约束，
      // 断言方向合法且运行期值是同一个已解析对象。
      return { status: res.status, body: parsed as TBody };
    },
    getPlayerData: (uid) => accountManager.data[uid],
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDatabase();
    },
  };
}