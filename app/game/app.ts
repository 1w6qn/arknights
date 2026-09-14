/**
 * 游戏应用主模块
 * 
 * 创建 Express 应用实例，配置中间件，注册所有游戏路由。
 */

import httpContext from "express-http-context2";
import express from "express";
import bodyParser from "body-parser";
import { accountManager } from "./modules/account/account-manager";
import { isGameError } from "@core/http/errors";
import { PlayerDataManager } from "./kernel/player-data-manager";
import { setPlayer, getPlayerOptional } from "./kernel/http/request-context";
import { acquireLock } from "@utils/mutex";
import { logger } from "@utils/logger";
import config from "@core/config/index";
import { routes } from "./routes";
import { createAuthStrategy, type AuthStrategy } from "./kernel/http/auth-strategy";
import { responseSchemaMiddleware } from "./kernel/http/resp-schema";
import { logService } from "@logs/log-service";

/** Express 应用实例 */
const app = express();

/** 注册 httpContext 中间件，用于请求上下文管理 */
app.use(httpContext.middleware);

/** 注册 JSON 解析中间件 */
app.use(bodyParser.json());

/**
 * 定向请求记录（原 reqres-log 中间件已并入 utils/traffic-recorder 并删除）：
 * 等价能力改由环境变量 REQRES_LOG + traffic-recorder 的 include 前缀记录提供
 * （默认关闭；设 REQRES_LOG=<路径前缀|all> 启用，include 优先于 exclude），见 @utils/traffic-recorder。
 */

/** 缓存的认证策略实例（按 authMode 失效重建——测试运行时切换模式也能生效） */
let cachedAuthStrategy: AuthStrategy | null = null;
/** 缓存策略对应的 authMode 键 */
let cachedAuthStrategyMode: string | null = null;

/**
 * 获取当前认证策略（懒加载 + 按 authMode 缓存）
 * 策略工厂是唯一做 single/real 决策的地方，中间件此处仅取回对应实例。
 * @returns 对应当前 config.authMode 的认证策略实例
 */
function getAuthStrategy(): AuthStrategy {
  const mode = config.authMode ?? "single";
  if (!cachedAuthStrategy || cachedAuthStrategyMode !== mode) {
    cachedAuthStrategy = createAuthStrategy(config);
    cachedAuthStrategyMode = mode;
  }
  return cachedAuthStrategy;
}

/**
 * 认证中间件：通过认证策略解析 secret 并注入玩家数据上下文
 * - single（单例）：策略固定返回 uid=1（单账号私服，任意 secret 都映射到固定账号）
 * - real（真实）：策略校验 secret 为有效 uid 或账号 token。
 *   仅当请求「携带了 secret 但无效」才 401；未携带 secret 视为匿名请求放行
 *   （登录前 /account/login、/batch_event、/admin 等控制/登录路径不依赖 secret）。
 */
export const authMiddleware: express.RequestHandler = async (req, res, next) => {
  const strategy = getAuthStrategy();
  const uid = await strategy.resolveUid(req);
  if (uid === undefined) {
    // real 模式：未携带 secret → 匿名放行（不注入 playerData，业务路由自行处理）；
    // 携带了 secret 但解析失败 → 401
    if (req.headers?.secret) {
      // 鉴权失败审计（2026-09 审阅）：记录来源与路径，便于发现被篡改/盗用的 secret
      void logService.audit(
        "authInvalidSecret",
        "",
        `ip=${String(req.ip || req.socket?.remoteAddress || "unknown")} path=${req.path}`,
      );
      return res.status(401).send({ status: 401, msg: "无效的 secret" });
    }
    next();
    return;
  }
  if (strategy.forceSecretHeader) {
    // single 模式：任意/缺失 secret 强制归一为固定账号
    req.headers.secret = uid;
  }
  setPlayer(await accountManager.getPlayerData(uid));
  next();
};

app.use(authMiddleware);

/** 全局响应骨架校验（可开关，失败仅告警不阻断；靠后挂载以覆盖各业务路由，见 resp-schema.ts） */
app.use(responseSchemaMiddleware);

/** 每账号请求互斥：同一 uid 的请求串行执行（防止并发 update() 丢变更） */
app.use(async (req, res, next) => {
  const player = getPlayerOptional();
  // /admin 管理接口属控制平面（含 game-proxy 自代理）：不占游戏锁，
  // 否则 single 模式下外层的 admin 请求持有 singleUid 锁、内层代理等待同一把锁会死锁
  if (!player || req.path.startsWith("/admin")) {
    next();
    return;
  }
  const release = await acquireLock(player.uid);
  res.on("finish", release);
  res.on("close", release);
  // 修复（2026-09-09，审计 §5.4 系统性根因）：周期性刷新（每日/每周/每月 04:00 边界）
  // 此前**只有管理端**会触发（AdminService 调 status.refreshTime()）——正常游戏流程中
  // refresh:daily / refresh:weekly / refresh:monthly 永不派发，每日任务、商店日/月重置、
  // 宿舍氛围信用、签到与开服连签等订阅方全部失效。此处于**持有该账号请求锁之后**补触发
  // （内部 60s 节流，一账号至多每分钟一次 update）；失败仅告警，不影响本次请求。
  try {
    await player.status.ensurePeriodicRefresh();
  } catch (err) {
    logger.warn("game", `周期性刷新失败：` + (err as Error).message);
  }
  // 修复（2026-09-09，审计 §5.4-8 前半）：登录签到后的【事相结晶】自动补充
  // （官方 retroDetail：「未达到储存上限时，在登录签到后将自动领取 2 个…60 级后 3 个」）。
  // 方法内含前置判定（无领取机会 / 已达上限直接返回 0）→ 无副作用时不产生 update。
  try {
    await player.retro.ensureWeeklySupplement();
  } catch (err) {
    logger.warn("game", `事相结晶补充失败：` + (err as Error).message);
  }
  next();
});

/**
 * 设置游戏应用路由
 * 
 * 初始化账户管理器并注册所有游戏模块的路由。
 * @param app - Express 应用实例
 */
export async function setup(app: express.Application) {
  await accountManager.init();
  // 路由挂载顺序即匹配优先级（多根挂载与别名匹配依赖先后次序），必须保持顺序。
  // 但模块加载本身彼此独立：并行动态 import 所有路由模块（Node 会并行编译/执行其
  // 依赖链 player/controller/excel），再按声明顺序串行挂载——把启动关键路径上的
  // 串行 import（40+ 模块）收敛为一次并行加载，显著缩短启动耗时。
  const mods = await Promise.all(
    routes.map((reg) => import(reg.module) as Promise<Record<string, unknown>>),
  );
  for (let i = 0; i < routes.length; i++) {
    const reg = routes[i];
    const mod = mods[i];
    const router = (reg.exportName === "rootRouter" ? mod.rootRouter : mod.default) as
      | express.Router
      | express.RequestHandler;
    if (reg.rewrite) {
      // 带 URL 重写中间件的别名挂载（如 /crisisV2、/sandboxPerm）
      app.use(reg.prefix, reg.rewrite, router);
    } else {
      app.use(reg.prefix, router);
    }
  }
  // 统一错误处理：异步 handler 抛错（Express 5 自动捕获）→ JSON 而非 HTML 500。
  // 例：single 模式社交自请求（不能加自己为好友）等业务校验错误，客户端收到可解析 JSON。
  // 必须最后注册，故保留在路由表迭代之外显式追加
  app.use(gameErrorHandler);
}

/**
 * 游戏路由统一错误处理中间件
 *
 * 无此中间件时 Express 默认返回 HTML 500，客户端 JSON 解析失败。
 * @param err - 抛出的错误
 */
export function gameErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
): void {
  // 异常路径回收物品管道队列：正常路径由 player.delta getter 收尾回收，但抛错请求
  // 不会走到 res.send(player.delta)，残留 _targets 会被下一个请求一并发放。
  // resetGainItem 不触发懒建，且上下文缺失（如 /admin 控制平面）时安全跳过。
  getPlayerOptional()?.resetGainItem();
  // 统一业务异常（建议 13）：状态码/错误码/业务文案透传，客户端可解析
  if (isGameError(err)) {
    logger.error("game", `[${err.code}] ${err.message}`);
    res.status(err.status).json({
      status: 1,
      msg: err.message,
      code: err.code,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
    });
    return;
  }
  logger.error("game", (err as Error)?.message || String(err));
  logger.error("game", (err as Error)?.stack || String(err));
  res.status(500).json({
    status: 1,
    msg: "服务器内部错误",
    code: "INTERNAL_ERROR",
  });
}

export default app;