/**
 * GM 面板路由（挂在 `/gm`）
 *
 * 契约对齐归档服务端 GM 面板，并做了两处能力扩展（面板自用，路径同前缀）：
 * - 静态资源：`/gm/`、`/gm/gm.css`、`/gm/js/*.js`（免认证，同 Dashboard；开发期禁缓存）
 * - 引导：`GET /gm/config`、`/gm/players`、`/gm/data`、`/gm/state`、`/gm/char?id=`
 * - 操作：`/admin/<op>`（见 gm-ops-router.ts）
 *
 * 安全口径：引导端点默认**仅回环**可访问（对齐归档 `admin_allow_remote=false`）；
 * `data/config.json` 的 `admin.allowRemote=true` 时允许远程，但需带有效管理令牌，
 * 且 `/gm/config` 仅在回环下回传 `admin_token`（远程不回传，面板退化为页面内输入令牌）。
 */
import express, { Router } from "express";
import type { Request, Response } from "express";
import path from "path";
import config from "@core/config";
import { logger } from "@utils/logger";
import { timingSafeEqualString } from "@utils/crypt";
import { getAdminConfig } from "../admin-config";
import { adminGame } from "../game-gateway";
import { gmService } from "./gm-service";
import { GmOpError } from "./gm-types";
import { buildGmData, buildGmState } from "./gm-data";
import type { GmConfigPayload, GmPlayersPayload, GmStateResponse } from "./gm-types";

/** 面板版本（响应体回显，便于确认前端与后端同版） */
const GM_PANEL_VERSION = "1.0.0";

/** 面板静态资源目录 */
const PANEL_DIR = path.join(process.cwd(), "app", "ops", "admin", "gm", "panel");

/** 回环地址集合（IPv4/IPv6/映射形态） */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * 请求是否来自回环
 * @param req - Express 请求
 * @returns 是否回环
 */
function isLoopback(req: Request): boolean {
  return LOOPBACK_ADDRESSES.has(String(req.socket?.remoteAddress ?? ""));
}

/**
 * 请求是否携带有效管理令牌（Bearer / X-Admin-Token / ?token=）
 * @param req - Express 请求
 * @returns 是否有效
 */
function hasValidToken(req: Request): boolean {
  const cfg = getAdminConfig();
  const header = (req.headers.authorization as string) || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const queryToken = typeof req.query?.token === "string" ? req.query.token : "";
  const token = bearer || (req.headers["x-admin-token"] as string) || queryToken || "";
  return Boolean(token) && timingSafeEqualString(token, cfg.token);
}

/**
 * 引导端点访问判定
 * @param req - Express 请求
 * @returns 是否允许访问
 */
function allowBootstrap(req: Request): boolean {
  const cfg = getAdminConfig();
  if (!cfg.enable) return false;
  if (isLoopback(req)) return true;
  if (config.admin?.allowRemote !== true) return false;
  return hasValidToken(req);
}

/**
 * 引导端点统一拒绝响应（把「未启用」与「未授权」分开提示，便于面板给出准确文案）
 * @param req - Express 请求
 * @param res - Express 响应
 * @returns 是否已拒绝
 */
function rejectBootstrap(req: Request, res: Response): boolean {
  const cfg = getAdminConfig();
  if (!cfg.enable) {
    res.status(403).json({ detail: "管理接口未启用：请在 data/config.json 中设置 admin.enable=true" });
    return true;
  }
  if (!allowBootstrap(req)) {
    res.status(401).json({ detail: "GM 面板引导接口仅限本机访问（或开启 admin.allowRemote 并携带令牌）" });
    return true;
  }
  return false;
}

/**
 * 全部账号 uid（升序）
 * @returns uid 列表
 */
function playerUids(): string[] {
  return Object.keys(adminGame.accountManager.configs).sort((a, b) => Number(a) - Number(b));
}

/**
 * 当前默认玩家 uid（singleUid 存在时优先，否则取首个账号）
 * @returns uid
 */
function currentUid(): string {
  const players = playerUids();
  const preferred = String(config.singleUid ?? "");
  return players.includes(preferred) ? preferred : (players[0] ?? preferred) || "1";
}

/** GM 面板路由 */
const router = Router();

/**
 * 面板访问门禁（2026-09 审阅：静态页与 API 用法原先对任何来源开放）
 *
 * 非回环访问需显式开启 `admin.allowRemote`（与引导端点一致）；开启后页面可加载，
 * 引导数据仍各自校验管理令牌。放在静态挂载之前，因此静态资源与引导端点一并受控。
 * @param req - Express 请求
 * @param res - Express 响应
 * @param next - 放行回调
 */
router.use((req: Request, res: Response, next) => {
  if (isLoopback(req) || config.admin?.allowRemote === true) {
    next();
    return;
  }
  res.status(403).json({ detail: "GM 面板仅限本机访问（或开启 admin.allowRemote）" });
});

/** 面板静态资源（index.html / gm.css / js/*.js；开发期禁缓存） */
router.use(
  express.static(PANEL_DIR, {
    index: ["index.html"],
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", "no-cache, no-store, must-revalidate"),
  }),
);

/** 引导配置（回环下回传 admin_token；远程不回传） */
router.get("/config", (req: Request, res: Response) => {
  const cfg = getAdminConfig();
  if (!cfg.enable) {
    res.status(403).json({ detail: "管理接口未启用：请在 data/config.json 中设置 admin.enable=true" });
    return;
  }
  if (!isLoopback(req) && config.admin?.allowRemote !== true) {
    res.status(401).json({ detail: "GM 面板引导接口仅限本机访问（或开启 admin.allowRemote）" });
    return;
  }
  const payload: GmConfigPayload = {
    base_url: "",
    admin_token: isLoopback(req) ? cfg.token : "",
    panel_title: "DoctorateTs GM",
    panel_version: GM_PANEL_VERSION,
  };
  res.json(payload);
});

/** 玩家列表（全部账号 uid + 当前单账号 uid） */
router.get("/players", (req: Request, res: Response) => {
  if (rejectBootstrap(req, res)) return;
  const payload: GmPlayersPayload = { players: playerUids(), current: currentUid() };
  res.json(payload);
});

/** 轻量状态刷新（赛季页/顶栏：不重取整份引导数据） */
router.get("/state", (req: Request, res: Response) => {
  if (rejectBootstrap(req, res)) return;
  const payload: GmStateResponse = {
    gm_state: buildGmState(),
    players: playerUids(),
    current: currentUid(),
    panel_version: GM_PANEL_VERSION,
  };
  res.json(payload);
});

/** 干员可选参数（面板「干员调整」页的阶段/技能槽/模组下拉） */
router.get("/char", (req: Request, res: Response) => {
  if (rejectBootstrap(req, res)) return;
  const query = (req.query ?? {}) as { id?: string };
  const charId = String(query.id ?? "");
  if (!charId) {
    res.status(400).json({ detail: "缺少 id 参数" });
    return;
  }
  try {
    res.json(gmService.charOptions(charId));
  } catch (error) {
    if (error instanceof GmOpError) {
      res.status(error.status).json({ detail: error.message });
      return;
    }
    logger.error("gm", `charOptions 失败: ${(error as Error).message}`);
    res.status(500).json({ detail: (error as Error).message });
  }
});

/** 面板引导数据（活动/赛季/物品/干员/自走棋棋池/重置键/全局状态/边界） */
router.get("/data", async (req: Request, res: Response) => {
  if (rejectBootstrap(req, res)) return;
  res.json(await buildGmData());
});

export default router;
