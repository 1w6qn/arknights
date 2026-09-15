/**
 * 自动化会话中心（MCP 自动化桥的服务端一半）
 *
 * 角色定位：客户端 Lua 插件（`lua/plugin/core/AutomationBridge.lua`）**只能出站拉取**，
 * 没有入站监听能力，所以「MCP 服务器」落在仓内 Node 进程，由本模块承担命令中转：
 *
 *     外部 Agent ──MCP(stdio)──▶ scripts/mcp-automation-server.ts
 *                                        │ HTTP POST /plugin/automation/call
 *                                        ▼
 *                                  本模块（命令队列 + 结果重组 + 等待者）
 *                                        ▲ GET /poll（取命令） / GET /result（分片回传）
 *                                        │
 *                                游戏内 Lua 自动化桥
 *
 * 为什么结果要分片：截图/日志这类载荷动辄几十 KB，而客户端唯一的通道是
 * `UISender.SendGet`（路径传参）；把结果 JSON 做 base64url 后按 ~1.8KB 切片顺序上传，
 * 既避开请求行长度上限，也不需要客户端具备 POST 能力。
 *
 * 状态全部在内存：这是**调试/验证**设施，重启即清空（不落盘，避免把游戏状态写进仓库数据）。
 */
import { randomUUID } from "node:crypto";
import { logger } from "@utils/logger";
import { isJsonArray, isJsonObject, type JsonValue } from "@core/utils/json-value";

/** 与客户端 `AutomationBridge.PROTOCOL` 对齐 */
export const PROTOCOL_VERSION = 1;

/** 单条命令默认超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 20000;
/** 单条命令允许的最大超时（毫秒） */
export const MAX_TIMEOUT_MS = 120000;
/** 一次轮询最多下发的命令数（串行执行，太多会让单轮阻塞过久） */
export const MAX_COMMANDS_PER_POLL = 4;
/** 会话空闲多久后回收 */
const SESSION_IDLE_MS = 10 * 60 * 1000;
/** 未凑齐的结果分片多久后回收 */
const PARTIAL_TTL_MS = 60 * 1000;
/** 单会话待执行命令上限（防呆：客户端掉线时别无限堆积） */
const MAX_PENDING_PER_SESSION = 64;
/** 会话 id 允许的字符集（直接进 URL 路径，必须窄） */
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 一条待执行命令 */
export interface AutomationCommand {
  /** 命令标识（服务端生成，结果按它寻址） */
  id: string;
  /** 命令名（`域.动作`，与 Lua 侧注册名一一对应） */
  name: string;
  /** 参数（JSON 值） */
  args: JsonValue;
}

/** 一条命令的结果 */
export interface AutomationResult {
  id: string;
  sid: string;
  /** 命令是否成功执行 */
  ok: boolean;
  /** 客户端侧耗时（毫秒） */
  ms: number;
  /** 结果载荷（失败时可能为 null） */
  result: JsonValue;
  /** 失败原因（成功时为 null） */
  error: string | null;
  /** 是否因超时而由服务端判定失败（客户端可能仍在执行） */
  timedOut?: boolean;
  /** 服务端观测到的往返耗时（毫秒） */
  roundTripMs: number;
}

/** 会话快照（给 `automation_sessions` 工具/管理端看） */
export interface AutomationSessionSnapshot {
  sid: string;
  firstSeenAt: number;
  lastSeenAt: number;
  pollCount: number;
  pending: number;
  inflight: number;
  idleMs: number;
  lastCommandName: string | null;
}

/** 轮询响应 */
export interface AutomationPollResponse {
  commands: AutomationCommand[];
  /** 仅在「还有积压」时给出，提示客户端立刻再来一次 */
  nextPollMs?: number;
}

/** 客户端回传的结果信封（与 Lua 侧 `_SendResult` 的 envelope 对齐） */
interface AutomationEnvelope {
  id?: string;
  sid?: string;
  protocol?: number;
  ok?: boolean;
  ms?: number;
  result?: JsonValue;
  error?: string | null;
}

/** 等待中的调用方 */
interface PendingWaiter {
  sid: string;
  name: string;
  startedAt: number;
  resolve: (result: AutomationResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 分片重组中的结果 */
interface PartialResult {
  sid: string;
  total: number;
  chunks: (string | null)[];
  received: number;
  at: number;
}

/** 会话内部状态 */
interface SessionState {
  sid: string;
  firstSeenAt: number;
  lastSeenAt: number;
  pollCount: number;
  pending: AutomationCommand[];
  inflight: Set<string>;
  lastCommandName: string | null;
}

/**
 * 判断解析出来的值是否为严格 JSON 值（对数组/对象递归校验）。
 *
 * 客户端回传的信封是「不可信输入」（可能被截断、串包、或被中间人改写），
 * 直接当 JsonValue 用等于放弃校验；这里逐层确认后才交给等待者。
 * @param value - 待判定值
 * @returns 是否为合法 JSON 值
 */
function isJsonValue(value: JsonValue | undefined): value is JsonValue {
  if (value === undefined || value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return true;
  if (isJsonArray(value)) return value.every((item) => isJsonValue(item));
  if (isJsonObject(value)) return Object.values(value).every((item) => isJsonValue(item));
  return false;
}

/**
 * 自动化会话中心：命令队列 + 结果等待者 + 分片重组。
 *
 * 单例使用（`automationHub`）；测试里用 `new AutomationHub()` 拿隔离实例。
 */
export class AutomationHub {
  private readonly _sessions = new Map<string, SessionState>();
  private readonly _waiters = new Map<string, PendingWaiter>();
  private readonly _partials = new Map<string, PartialResult>();

  /**
   * 校验会话标识（直接进 URL 路径，必须窄字符集）。
   * @param sid - 会话标识
   * @returns 合法返回 true
   */
  isValidSessionId(sid: string): boolean {
    return SID_RE.test(sid);
  }

  /**
   * 取（必要时创建）会话。
   *
   * 创建而非报错是有意的：MCP 侧常常先下发命令、客户端稍后才首次轮询
   * （例如刚重启客户端），此时把命令挂在会话里等它上线即可。
   * @param sid - 会话标识
   * @param first - 是否客户端首次轮询（用于打日志）
   * @returns 会话状态
   */
  private _ensureSession(sid: string, first = false): SessionState {
    let session = this._sessions.get(sid);
    if (session === undefined) {
      session = {
        sid,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        pollCount: 0,
        pending: [],
        inflight: new Set<string>(),
        lastCommandName: null,
      };
      this._sessions.set(sid, session);
      logger.info("Automation", `新建自动化会话: sid=${sid}（等待客户端首次轮询）`);
    }
    if (first) {
      logger.info("Automation", `客户端自动化桥已连接: sid=${sid}`);
    }
    return session;
  }

  /**
   * 客户端轮询：取走一批待执行命令。
   * @param sid - 会话标识
   * @param first - 是否首次轮询
   * @returns 命令列表与下一次轮询建议间隔
   */
  poll(sid: string, first: boolean): AutomationPollResponse {
    const session = this._ensureSession(sid, first);
    session.pollCount += 1;
    session.lastSeenAt = Date.now();
    this._gc();
    const commands = session.pending.splice(0, MAX_COMMANDS_PER_POLL);
    for (const command of commands) {
      session.inflight.add(command.id);
      session.lastCommandName = command.name;
    }
    if (commands.length > 0) {
      logger.info(
        "Automation",
        `下发 ${commands.length} 条命令给 sid=${sid}: ${commands.map((c) => c.name).join(", ")}`,
      );
    }
    const response: AutomationPollResponse = { commands };
    if (session.pending.length > 0) {
      // 还有积压：让客户端立刻续取，别等空闲间隔
      response.nextPollMs = 100;
    }
    return response;
  }

  /**
   * 收一个结果分片；凑齐后解码、解析并唤醒等待者。
   * @param sid - 会话标识
   * @param cmdId - 命令标识
   * @param seq - 分片序号（从 1 起）
   * @param total - 分片总数
   * @param chunk - base64url 分片内容
   * @returns 该命令的结果是否已凑齐
   */
  pushResultChunk(sid: string, cmdId: string, seq: number, total: number, chunk: string): boolean {
    const session = this._ensureSession(sid);
    session.lastSeenAt = Date.now();
    const index = seq - 1;
    if (total < 1 || total > 100000 || index < 0 || index >= total) {
      logger.warn("Automation", `结果分片序号非法: sid=${sid} cmd=${cmdId} ${seq}/${total}`);
      return false;
    }
    let entry = this._partials.get(cmdId);
    if (entry === undefined || entry.total !== total) {
      entry = { sid, total, chunks: new Array<string | null>(total).fill(null), received: 0, at: Date.now() };
      this._partials.set(cmdId, entry);
    }
    if (entry.chunks[index] === null) {
      entry.chunks[index] = chunk;
      entry.received += 1;
    }
    entry.at = Date.now();
    if (entry.received < entry.total) {
      return false;
    }
    this._partials.delete(cmdId);
    session.inflight.delete(cmdId);
    this._completeResult(sid, cmdId, entry.chunks.join(""));
    return true;
  }

  /**
   * 解码并交付一条已凑齐的结果。
   * @param sid - 会话标识
   * @param cmdId - 命令标识
   * @param base64Url - 拼接后的 base64url 结果串
   */
  private _completeResult(sid: string, cmdId: string, base64Url: string): void {
    const waiter = this._waiters.get(cmdId);
    const roundTripMs = waiter === undefined ? 0 : Date.now() - waiter.startedAt;
    let envelope: AutomationEnvelope | null = null;
    try {
      const text = Buffer.from(base64Url, "base64url").toString("utf8");
      envelope = JSON.parse(text) as AutomationEnvelope;
    } catch (error) {
      logger.warn(
        "Automation",
        `结果解码失败: sid=${sid} cmd=${cmdId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (waiter === undefined) {
      // 调用方已超时（或结果无人认领）：丢弃即可，不报错
      logger.debug("Automation", `收到无人等待的结果: sid=${sid} cmd=${cmdId}`);
      return;
    }
    this._waiters.delete(cmdId);
    clearTimeout(waiter.timer);
    if (envelope === null) {
      waiter.resolve({
        id: cmdId,
        sid,
        ok: false,
        ms: 0,
        result: null,
        error: "结果解码失败（分片内容非合法 base64url+JSON）",
        roundTripMs,
      });
      return;
    }
    const ok = envelope.ok === true;
    waiter.resolve({
      id: cmdId,
      sid,
      ok,
      ms: typeof envelope.ms === "number" ? envelope.ms : 0,
      result: isJsonValue(envelope.result) ? (envelope.result ?? null) : null,
      error: typeof envelope.error === "string" ? envelope.error : ok ? null : "客户端未给出错误信息",
      roundTripMs,
    });
  }

  /**
   * 下发一条命令并等待结果。
   *
   * 超时不会抛异常：返回 `ok=false` 的结果，并把该命令从待执行队列里摘掉
   * （否则客户端上线后会执行一条早已无人等待的命令，产生「幽灵操作」）。
   * @param sid - 会话标识
   * @param name - 命令名
   * @param args - 命令参数
   * @param timeoutMs - 超时（毫秒，缺省 20s，上限 120s）
   * @returns 命令结果
   */
  call(sid: string, name: string, args: JsonValue, timeoutMs?: number): Promise<AutomationResult> {
    if (!this.isValidSessionId(sid)) {
      throw new Error(`会话标识非法（只允许字母/数字/_/-，≤64 字符）: ${sid}`);
    }
    if (typeof name !== "string" || name.length === 0 || name.length > 64) {
      throw new Error(`命令名非法: ${String(name)}`);
    }
    const session = this._ensureSession(sid);
    if (session.pending.length >= MAX_PENDING_PER_SESSION) {
      throw new Error(`会话 ${sid} 待执行命令过多（${session.pending.length}），客户端可能已掉线`);
    }
    const limit = Math.min(Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const command: AutomationCommand = { id: randomUUID(), name, args };
    session.pending.push(command);
    session.lastCommandName = name;
    return new Promise<AutomationResult>((resolve) => {
      const timer = setTimeout(() => {
        this._waiters.delete(command.id);
        const rest = this._sessions.get(sid);
        if (rest !== undefined) {
          rest.pending = rest.pending.filter((item) => item.id !== command.id);
          rest.inflight.delete(command.id);
        }
        const idleMs = rest === undefined ? 0 : Date.now() - rest.lastSeenAt;
        logger.warn(
          "Automation",
          `命令超时: sid=${sid} name=${name} ${limit}ms（客户端 ${idleMs}ms 未轮询）`,
        );
        resolve({
          id: command.id,
          sid,
          ok: false,
          ms: 0,
          result: null,
          error: `命令超时（${limit}ms）: ${name}；最近一次客户端轮询在 ${idleMs}ms 前`,
          timedOut: true,
          roundTripMs: limit,
        });
      }, limit);
      this._waiters.set(command.id, { sid, name, startedAt: Date.now(), resolve, timer });
    });
  }

  /**
   * 列出会话快照（含空闲时长，便于判断客户端是不是已经掉了）。
   * @returns 快照数组（按最近活跃降序）
   */
  listSessions(): AutomationSessionSnapshot[] {
    const now = Date.now();
    this._gc(now);
    return [...this._sessions.values()]
      .map((session) => ({
        sid: session.sid,
        firstSeenAt: session.firstSeenAt,
        lastSeenAt: session.lastSeenAt,
        pollCount: session.pollCount,
        pending: session.pending.length,
        inflight: session.inflight.size,
        idleMs: now - session.lastSeenAt,
        lastCommandName: session.lastCommandName,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /**
   * 回收空闲会话与超时未凑齐的分片。
   * @param now - 当前时间戳（缺省取系统时间）
   */
  private _gc(now = Date.now()): void {
    for (const [sid, session] of this._sessions) {
      if (now - session.lastSeenAt > SESSION_IDLE_MS) {
        const hasWaiter = [...this._waiters.values()].some((waiter) => waiter.sid === sid);
        if (!hasWaiter) {
          this._sessions.delete(sid);
          logger.info("Automation", `回收空闲自动化会话: sid=${sid}`);
        }
      }
    }
    for (const [cmdId, partial] of this._partials) {
      if (now - partial.at > PARTIAL_TTL_MS) {
        this._partials.delete(cmdId);
        logger.warn("Automation", `回收未凑齐的结果分片: sid=${partial.sid} cmd=${cmdId}`);
      }
    }
  }

  /** 清空全部状态（测试用） */
  reset(): void {
    for (const waiter of this._waiters.values()) {
      clearTimeout(waiter.timer);
    }
    this._waiters.clear();
    this._partials.clear();
    this._sessions.clear();
  }

  /** 观测指标（管理端/自检用） */
  stats(): { sessions: number; waiters: number; partials: number } {
    return { sessions: this._sessions.size, waiters: this._waiters.size, partials: this._partials.size };
  }
}

/** 全局单例（路由与 MCP server 都经它读写） */
export const automationHub = new AutomationHub();
