/**
 * 自动化桥路由（MCP 自动化的服务端中枢）
 *
 * 位于 **ops 层**（与 `/admin` 控制平面同类），在组合根 `app/server.ts` 挂载到
 * `/plugin/automation`——而不是走 `app/game/modules/*` 的业务路由表：
 * 这套端点服务的是「调试/验证工具链」，不是游戏业务，落 game 会触发架构守卫
 * R5（game 不得依赖 ops）。
 *
 * 三个角色共用一组端点：
 *
 *   ┌ 游戏内 Lua 桥（只能出站）
 *   │   GET /plugin/automation/poll/<sid>/<first>            取命令（短轮询，不挂连接）
 *   │   GET /plugin/automation/result/<sid>/<cmdId>/<seq>/<total>/<chunk>
 *   │                                                       回传结果分片（base64url）
 *   └ MCP 服务器 / 管理端
 *       POST /plugin/automation/call                        下发一条命令并等结果
 *       GET  /plugin/automation/sessions                    在线会话快照
 *
 * 设计取舍见 `automation-hub.ts` 顶部注释；协议常量与客户端
 * `lua/plugin/core/AutomationBridge.lua` 顶部的线协议说明一一对应。
 *
 * 安全边界：这些端点能驱动客户端执行任意自动化命令（含 `client.eval`），
 * 与 `/plugin/*` 既有端点一样**不做鉴权**——本私服是单机调试设施。
 * 对外暴露时请自行置于反代鉴权之后，或把 `automation_bridge` 插件停用。
 */
import { Router } from "express";
import { logger } from "@utils/logger";
import { validateBody } from "@core/http/validate-body";
import { automationHub, PROTOCOL_VERSION, type AutomationResult } from "./automation-hub";
import { automationCallSchema, type AutomationCallBody } from "./automation.schema";

const router = Router();

/** `POST /call` 的响应体（MCP 侧据此判定成败） */
interface AutomationCallResponse extends AutomationResult {
  status: number;
  protocol: number;
}

/**
 * 客户端轮询：取走一批待执行命令。
 *
 * 刻意用**短轮询**而不是长轮询：客户端的网络层是 `UISender`（内部 ENQUEUE 并发模型），
 * 挂住一个请求会让后续心跳/游戏请求排在它后面；空闲间隔由客户端自己控制。
 */
router.get("/poll/:sid/:first", (req, res) => {
  const sid = String(req.params.sid ?? "");
  if (!automationHub.isValidSessionId(sid)) {
    res.json({ status: 1, result: -1, msg: `会话标识非法: ${sid}` });
    return;
  }
  const first = String(req.params.first ?? "0") === "1";
  const payload = automationHub.poll(sid, first);
  const body: {
    status: number;
    result: number;
    protocol: number;
    commands: typeof payload.commands;
    nextPollMs?: number;
  } = { status: 0, result: 0, protocol: PROTOCOL_VERSION, commands: payload.commands };
  if (payload.nextPollMs !== undefined) {
    body.nextPollMs = payload.nextPollMs;
  }
  res.json(body);
});

/**
 * 客户端回传一个结果分片。
 *
 * `done=1` 表示这条命令的结果已凑齐，仅作诊断信号（客户端本来就知道自己发了多少片）。
 */
router.get("/result/:sid/:cmdId/:seq/:total/:chunk", (req, res) => {
  const sid = String(req.params.sid ?? "");
  const cmdId = String(req.params.cmdId ?? "");
  const seq = Number(req.params.seq);
  const total = Number(req.params.total);
  const chunk = String(req.params.chunk ?? "");
  if (!automationHub.isValidSessionId(sid) || cmdId === "") {
    res.json({ status: 1, result: -1, msg: "sid/cmdId 非法" });
    return;
  }
  if (!Number.isInteger(seq) || !Number.isInteger(total) || seq < 1 || total < 1) {
    res.json({ status: 1, result: -1, msg: "seq/total 非法" });
    return;
  }
  const done = automationHub.pushResultChunk(sid, cmdId, seq, total, chunk);
  res.json({ status: 0, result: 0, done: done ? 1 : 0 });
});

/**
 * MCP 侧入口：下发一条命令并同步等待结果。
 *
 * 超过 `timeoutMs` 返回 `ok=false`（而非 HTTP 错误）：超时是**业务结果**，
 * 让调用方在同一个响应里拿到「客户端可能掉线/命令卡住」的诊断信息。
 */
router.post("/call", validateBody(automationCallSchema), async (req, res) => {
  const body = req.body as AutomationCallBody;
  let result: AutomationResult;
  try {
    result = await automationHub.call(body.sid, body.name, body.args ?? {}, body.timeoutMs);
  } catch (error) {
    logger.warn(
      "Automation",
      `命令无法下发: sid=${body.sid} name=${body.name} → ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res.json({
      status: 1,
      protocol: PROTOCOL_VERSION,
      id: "",
      sid: body.sid,
      ok: false,
      ms: 0,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      roundTripMs: 0,
    } satisfies AutomationCallResponse);
    return;
  }
  res.json({ status: 0, protocol: PROTOCOL_VERSION, ...result } satisfies AutomationCallResponse);
});

/** 在线会话快照（MCP 的 `automation_sessions` 与人工排查都读它） */
router.get("/sessions", (_req, res) => {
  const sessions = automationHub.listSessions();
  res.json({
    status: 0,
    result: 0,
    protocol: PROTOCOL_VERSION,
    count: sessions.length,
    sessions,
    hub: automationHub.stats(),
  });
});

export default router;
