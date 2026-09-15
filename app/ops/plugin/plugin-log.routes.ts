/**
 * Unity 日志回传路由（客户端 Lua 插件 → 私服）
 *
 * 位于 **ops 层**（与 `/admin`、`/plugin/automation` 同类），由组合根 `app/server.ts`
 * 挂载到 `/plugin/log`——而不是走 `app/game/modules/*`（会触发架构守卫 R5：
 * game 不得依赖 ops）。本组端点服务的是调试设施，不是游戏业务。
 *
 *   ┌ 游戏内 Lua 插件（`lua/plugin/plugins/UnityLogPlugin.lua`，只能出站）
 *   │   GET /plugin/log/ingest/<sid>/<batchId>/<seq>/<total>/<base64url chunk>
 *   │                                                       回传日志分片（base64url）
 *   └ 分析侧（CLI / MCP / 人工排查）
 *       GET /plugin/log/sessions                            会话列表 + 全局统计
 *       GET /plugin/log/records/<sid>?last=N&level=E        某会话尾部记录
 *       GET /plugin/log/stats                               仅统计
 *
 * 落盘与拼片语义见 `plugin-log-store.ts` 顶部注释。
 *
 * 安全边界：与 `/plugin/*` 既有端点一样**不做鉴权**——本私服是单机调试设施。
 * 写入面只放行 `[A-Za-z0-9_-]` 标识与 base64url 分片，且有长度/条数/总量上限。
 */
import { Router } from "express";
import { logger } from "@utils/logger";
import { pluginLogStore } from "./plugin-log-store";

const router = Router();

/** 查询参数里的记录条数上限（缺省 100） */
const DEFAULT_QUERY_LIMIT = 100;
/** 查询参数里的记录条数硬上限 */
const MAX_QUERY_LIMIT = 5000;

/**
 * 客户端回传一个日志分片。
 *
 * `done=1` 表示该批已凑齐并落盘（仅作诊断信号：客户端本来就知道自己发了多少片）。
 */
router.get("/ingest/:sid/:batchId/:seq/:total/:chunk", (req, res) => {
  const sid = String(req.params.sid ?? "");
  const batchId = String(req.params.batchId ?? "");
  const seq = Number(req.params.seq);
  const total = Number(req.params.total);
  const chunk = String(req.params.chunk ?? "");
  if (sid === "" || batchId === "") {
    res.json({ status: 1, result: -1, msg: "sid/batchId 不能为空" });
    return;
  }
  if (!Number.isInteger(seq) || !Number.isInteger(total) || seq < 1 || total < 1) {
    res.json({ status: 1, result: -1, msg: "seq/total 非法" });
    return;
  }
  const done = pluginLogStore.pushChunk(sid, batchId, seq, total, chunk);
  res.json({ status: 0, result: 0, done: done ? 1 : 0 });
});

/** 会话列表（分析侧入口：先看有哪些会话、各自多少条、错/警多少） */
router.get("/sessions", (_req, res) => {
  const sessions = pluginLogStore.listSessions();
  res.json({
    status: 0,
    result: 0,
    count: sessions.length,
    sessions,
    stats: pluginLogStore.stats(),
  });
});

/** 某会话的尾部记录（支持 `?last=N` 与 `?level=D|I|W|E` 过滤） */
router.get("/records/:sid", (req, res) => {
  const sid = String(req.params.sid ?? "");
  if (sid === "") {
    res.json({ status: 1, result: -1, msg: "sid 不能为空" });
    return;
  }
  const lastRaw = Number(req.query.last);
  const limit = Number.isInteger(lastRaw) && lastRaw > 0 ? Math.min(lastRaw, MAX_QUERY_LIMIT) : DEFAULT_QUERY_LIMIT;
  const level = typeof req.query.level === "string" ? req.query.level : "";
  const records = pluginLogStore.readRecords(sid, { limit, level });
  logger.info("UnityLog", `查询会话日志: sid=${sid} level=${level || "*"} 返回 ${records.length} 条`);
  res.json({ status: 0, result: 0, sid, count: records.length, records });
});

/** 全局统计 */
router.get("/stats", (_req, res) => {
  res.json({ status: 0, result: 0, stats: pluginLogStore.stats() });
});

export default router;
