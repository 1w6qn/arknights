/**
 * Unity 日志回传存储（客户端 → 私服的单向日志回流）
 *
 * 角色：客户端 Lua 插件 `UnityLogPlugin`（`lua/plugin/plugins/UnityLogPlugin.lua`）
 * 把运行期日志（Unity 引擎日志 + 游戏日志）经 `UISender.me:SendGet` 批量回传，
 * 服务端在这里拼片、落盘、建索引，供离线分析（崩溃现场、报错上下文、版本漂移）。
 *
 * 线协议（与插件顶部注释一一对应）：
 *
 *   GET /plugin/log/ingest/<sid>/<batchId>/<seq>/<total>/<base64url chunk>
 *       JSON 信封 → base64url → 1800 字符切片顺序上传；本模块按 (sid,batchId) 拼回：
 *         { v, sid, seq, ts, dropped, device, records: [ { t, l, m, s, c } ] }
 *
 * 落盘布局（`data/plugin/logs/`）：
 *   <sid>.ndjson      一行一条记录（追加写；超过 maxSessionBytes 轮转为 <sid>.1.ndjson）
 *   <sid>.meta.json   会话索引（会话列表/统计只读它，避免离线 CLI 读整份日志）
 *
 * 为什么放在 ops 层：这套端点服务的是「调试/验证工具链」，不是游戏业务；
 * 落 game 会触发架构守卫 R5（game 不得依赖 ops），与 `/plugin/automation` 同理。
 * 与 `/plugin/*` 既有端点一样**不做鉴权**——本私服是单机调试设施，
 * 对外暴露时请置于反代鉴权之后（或停用 `unity_log` 插件）。
 *
 * 安全边界（客户端可构造任意请求）：
 *   - sid/batchId 只放行 `[A-Za-z0-9_-]`（防路径穿越）；
 *   - 分片长度、分片总数、拼装总字节、每批条数、正文/堆栈长度全部有上限；
 *   - 未凑齐的分片有数量上限与 TTL，避免被灌内存。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "@utils/logger";
import { isJsonArray, isJsonObject, type JsonObject, type JsonValue } from "@core/utils/json-value";

/** 日志根目录（相对项目根，与 data/plugin/config.json 同级） */
export const PLUGIN_LOG_DIR = join(__dirname, "..", "..", "..", "data", "plugin", "logs");

/** 标识（sid / batchId）合法字符与长度 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 单片 base64url 长度上限（客户端 1800，留 2 倍余量） */
const MAX_CHUNK_CHARS = 4096;
/** 单批分片数上限 */
const MAX_TOTAL_CHUNKS = 2048;
/** 单批拼装后的字节上限（2MB） */
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
/** 单批记录条数上限 */
const MAX_BATCH_RECORDS = 2000;
/** 单条正文/堆栈长度上限（超出截断，不拒绝整批） */
const MAX_TEXT_CHARS = 8192;
/** 未凑齐分片的缓存条目上限与 TTL（毫秒） */
const MAX_PARTIALS = 64;
const PARTIAL_TTL_MS = 60_000;
/** 单会话落盘上限（超出轮转一次到 <sid>.1.ndjson） */
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
/** 镜像到服务端统一日志的正文长度（TUI 输出闸门：单条日志 ≤400 字符） */
const MIRROR_TEXT_CHARS = 400;

/** 一条已落盘的日志记录 */
export interface UnityLogRecord {
  /** 会话标识（谁报的） */
  sid: string;
  /** 批次标识 */
  batchId: string;
  /** 服务端接收时间（毫秒） */
  receivedAt: number;
  /** 客户端单调时间戳（毫秒，可缺省） */
  t?: number;
  /** 级别码：D/I/W/E（未知级别归一为 I） */
  l: string;
  /** 正文 */
  m: string;
  /** 调用堆栈（可选） */
  s?: string;
  /** 连续重复次数（客户端把连续相同的日志合并成一条） */
  c?: number;
}

/** 会话索引（列表/统计只读它） */
export interface UnityLogSessionInfo {
  /** 会话标识 */
  sid: string;
  /** 首次接收时间（毫秒） */
  firstAt: number;
  /** 最近接收时间（毫秒） */
  lastAt: number;
  /** 收到的批次数 */
  batches: number;
  /** 记录条数 */
  records: number;
  /** 客户端因缓冲溢出/限流丢弃的条数（累计最大值，单调不减） */
  dropped: number;
  /** Error/Exception 条数 */
  errors: number;
  /** Warning 条数 */
  warnings: number;
  /** 已落盘字节数 */
  bytes: number;
  /** 是否发生过轮转（旧日志已滚动到 <sid>.1.ndjson） */
  truncated: boolean;
  /** 设备信息（客户端 best-effort 上报） */
  device: Record<string, string>;
}

/** 查询记录的过滤条件 */
export interface UnityLogQuery {
  /** 最多返回多少条（取尾部；缺省 100） */
  limit?: number;
  /** 只返回该级别码（D/I/W/E），缺省全部 */
  level?: string;
}

/** 全局统计 */
export interface UnityLogStats {
  /** 会话数 */
  sessions: number;
  /** 记录总数 */
  records: number;
  /** Error/Exception 总数 */
  errors: number;
  /** Warning 总数 */
  warnings: number;
  /** 已落盘字节总数 */
  bytes: number;
  /** 目录 */
  dir: string;
}

/** 未凑齐分片的缓存条目 */
interface PartialBatch {
  total: number;
  chunks: (string | null)[];
  received: number;
  chars: number;
  at: number;
}

/** 内存中的会话状态（meta 文件的写缓冲 + 近期记录） */
interface SessionState {
  info: UnityLogSessionInfo;
  /** 近期记录（尾部，供快速查询；完整历史读文件） */
  recent: UnityLogRecord[];
}

/** 信封里的一条记录（尚未落盘：缺 sid/batchId/receivedAt） */
interface ParsedLogRecord {
  t?: number;
  l: string;
  m: string;
  s?: string;
  c?: number;
}

/** 解析出的信封字段 */
interface ParsedEnvelope {
  records: ParsedLogRecord[];
  dropped: number;
  device: Record<string, string>;
}

/**
 * 取日志级别码的归一形式。
 * @param raw - 客户端上报的级别码
 * @returns D/I/W/E（未知一律 I）
 */
function normalizeLevel(raw: JsonValue | undefined): string {
  const code = typeof raw === "string" ? raw.toUpperCase() : "";
  return code === "D" || code === "I" || code === "W" || code === "E" ? code : "I";
}

/**
 * 截断文本到上限（客户端已截断，这里防伪造/防异常客户端）。
 * @param raw   - 原始值
 * @param limit - 字符上限
 * @returns 文本（非字符串返回空串）
 */
function clampText(raw: JsonValue | undefined, limit: number): string {
  if (typeof raw !== "string") return "";
  return raw.length > limit ? `${raw.slice(0, limit)}…[truncated]` : raw;
}

/**
 * 把设备信息收敛成 `Record<string, string>`（只保留标量字段）。
 * @param raw - 客户端上报的 device 值
 * @returns 设备信息
 */
function parseDevice(raw: JsonValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined || !isJsonObject(raw)) return out;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value).slice(0, 200);
    }
  }
  return out;
}

/**
 * 解析一批记录（严格收敛，任何越界都归一而不是拒绝整批）。
 * @param raw - 客户端上报的 records 数组
 * @returns 记录列表（缺字段的条目跳过）
 */
function parseRecords(raw: JsonValue | undefined): ParsedLogRecord[] {
  const out: ParsedLogRecord[] = [];
  if (raw === undefined || !isJsonArray(raw)) return out;
  for (const item of raw) {
    if (out.length >= MAX_BATCH_RECORDS) break;
    if (!isJsonObject(item)) continue;
    const body = clampText(item.m, MAX_TEXT_CHARS);
    if (body.length === 0) continue;
    const rec: ParsedLogRecord = {
      l: normalizeLevel(item.l),
      m: body,
    };
    if (typeof item.t === "number" && Number.isFinite(item.t)) rec.t = Math.floor(item.t);
    const stack = clampText(item.s, MAX_TEXT_CHARS);
    if (stack.length > 0) rec.s = stack;
    if (typeof item.c === "number" && Number.isFinite(item.c) && item.c > 1) rec.c = Math.min(Math.floor(item.c), 1e6);
    out.push(rec);
  }
  return out;
}

/**
 * 解析信封（`{ v, sid, seq, dropped, device, records }`）。
 * @param value - JSON.parse 的结果
 * @returns 解析结果；不是合法对象时返回 null
 */
function parseEnvelope(value: JsonValue): ParsedEnvelope | null {
  if (!isJsonObject(value)) return null;
  const droppedRaw = value.dropped;
  const dropped = typeof droppedRaw === "number" && Number.isFinite(droppedRaw) ? Math.max(0, Math.floor(droppedRaw)) : 0;
  return {
    records: parseRecords(value.records),
    dropped,
    device: parseDevice(value.device),
  };
}

/**
 * 读取目录下的会话 meta（不存在/损坏时跳过）。
 * @param file - meta 文件绝对路径
 * @returns 会话索引或 null
 */
function readMeta(file: string): UnityLogSessionInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as JsonValue;
    if (!isJsonObject(parsed)) return null;
    const sid = parsed.sid;
    if (typeof sid !== "string" || !ID_RE.test(sid)) return null;
    const num = (key: string): number => {
      const v = parsed[key];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };
    return {
      sid,
      firstAt: num("firstAt"),
      lastAt: num("lastAt"),
      batches: num("batches"),
      records: num("records"),
      dropped: num("dropped"),
      errors: num("errors"),
      warnings: num("warnings"),
      bytes: num("bytes"),
      truncated: parsed.truncated === true,
      device: parseDevice(parsed.device),
    };
  } catch {
    return null;
  }
}

/**
 * Unity 日志回传存储。
 *
 * 进程内单例（`pluginLogStore`）供路由使用；CLI 离线分析可自行 new 一个实例，
 * 所有查询都直接读落盘文件，不依赖服务器进程。
 */
export class PluginLogStore {
  private readonly dir: string;
  private readonly maxSessionBytes: number;
  /** 未凑齐分片：key = `${sid}/${batchId}` */
  private readonly partials = new Map<string, PartialBatch>();
  /** 会话状态缓存（meta 写缓冲 + 近期记录） */
  private readonly sessions = new Map<string, SessionState>();

  /**
   * 构造存储实例。
   * @param dir             - 日志目录（缺省 data/plugin/logs）
   * @param maxSessionBytes - 单会话落盘上限（缺省 16MB，超出轮转一次）
   */
  constructor(dir: string = PLUGIN_LOG_DIR, maxSessionBytes: number = MAX_SESSION_BYTES) {
    this.dir = dir;
    this.maxSessionBytes = maxSessionBytes;
  }

  /**
   * 日志目录绝对路径（CLI 展示用）。
   * @returns 目录路径
   */
  get directory(): string {
    return this.dir;
  }

  /**
   * 确保目录存在。
   * @returns 无
   */
  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * 会话数据文件路径。
   * @param sid - 会话标识
   * @returns 绝对路径
   */
  private dataPath(sid: string): string {
    return join(this.dir, `${sid}.ndjson`);
  }

  /**
   * 会话 index 文件路径。
   * @param sid - 会话标识
   * @returns 绝对路径
   */
  private metaPath(sid: string): string {
    return join(this.dir, `${sid}.meta.json`);
  }

  /**
   * 清理过期 / 超量的未凑齐分片。
   * @param now - 当前时间（毫秒）
   * @returns 无
   */
  private sweepPartials(now: number): void {
    for (const [key, entry] of this.partials) {
      if (now - entry.at > PARTIAL_TTL_MS) {
        this.partials.delete(key);
      }
    }
    if (this.partials.size <= MAX_PARTIALS) return;
    // 超量：按最旧优先丢弃（客户端会重发整批，丢的是拼不完的残片）
    const sorted = [...this.partials.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < sorted.length - MAX_PARTIALS; i++) {
      const key = sorted[i][0];
      this.partials.delete(key);
      logger.warn("UnityLog", `分片缓存超量，丢弃残片: ${key}`);
    }
  }

  /**
   * 收下一个结果分片；凑齐则落盘。
   *
   * @param sid     会话标识
   * @param batchId 批次标识
   * @param seq     分片序号（从 1 起）
   * @param total   分片总数
   * @param chunk   base64url 分片
   * @returns 本片是否让该批凑齐
   */
  pushChunk(sid: string, batchId: string, seq: number, total: number, chunk: string): boolean {
    const now = Date.now();
    this.sweepPartials(now);
    if (!ID_RE.test(sid) || !ID_RE.test(batchId)) {
      logger.warn("UnityLog", `非法标识: sid=${sid} batch=${batchId}`);
      return false;
    }
    if (!Number.isInteger(seq) || !Number.isInteger(total) || seq < 1 || total < 1 || seq > total) {
      logger.warn("UnityLog", `非法分片序号: ${seq}/${total}`);
      return false;
    }
    if (total > MAX_TOTAL_CHUNKS || chunk.length > MAX_CHUNK_CHARS || /[^A-Za-z0-9_-]/.test(chunk)) {
      logger.warn("UnityLog", `分片不合法（长度/字符集/总数）: sid=${sid} ${seq}/${total} ${chunk.length}B`);
      return false;
    }
    const key = `${sid}/${batchId}`;
    let entry = this.partials.get(key);
    if (entry === undefined || entry.total !== total) {
      entry = { total, chunks: new Array<string | null>(total).fill(null), received: 0, chars: 0, at: now };
      this.partials.set(key, entry);
    }
    const index = seq - 1;
    if (entry.chunks[index] === null) {
      entry.chunks[index] = chunk;
      entry.received += 1;
      entry.chars += chunk.length;
    }
    entry.at = now;
    if (entry.chars > MAX_BATCH_BYTES) {
      this.partials.delete(key);
      logger.warn("UnityLog", `批次超限丢弃: ${key} ${entry.chars}B`);
      return false;
    }
    if (entry.received < entry.total) return false;
    this.partials.delete(key);
    this.complete(sid, batchId, entry.chunks.join(""));
    return true;
  }

  /**
   * 解码并落盘一个已凑齐的批次。
   *
   * @param sid     会话标识
   * @param batchId 批次标识
   * @param payload 拼接后的 base64url 串
   * @returns 无
   */
  private complete(sid: string, batchId: string, payload: string): void {
    let envelope: ParsedEnvelope | null = null;
    try {
      const text = Buffer.from(payload, "base64url").toString("utf8");
      envelope = parseEnvelope(JSON.parse(text) as JsonValue);
    } catch (error) {
      logger.warn("UnityLog", `批次解码失败: ${sid}/${batchId} ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (envelope === null) {
      logger.warn("UnityLog", `批次信封非法（不是 JSON 对象）: ${sid}/${batchId}`);
      return;
    }
    this.append(sid, batchId, envelope);
  }

  /**
   * 追加一批记录并更新会话索引。
   *
   * @param sid      会话标识
   * @param batchId  批次标识
   * @param envelope 解析后的信封
   * @returns 无
   */
  private append(sid: string, batchId: string, envelope: ParsedEnvelope): void {
    const now = Date.now();
    const state = this.state(sid);
    const info = state.info;
    const lines: string[] = [];
    for (const rec of envelope.records) {
      const full: UnityLogRecord = {
        sid,
        batchId,
        receivedAt: now,
        l: rec.l,
        m: rec.m,
      };
      if (rec.t !== undefined) full.t = rec.t;
      if (rec.s !== undefined) full.s = rec.s;
      if (rec.c !== undefined) full.c = rec.c;
      lines.push(JSON.stringify(full));
      state.recent.push(full);
      info.records += 1;
      if (full.l === "E") info.errors += 1;
      if (full.l === "W") info.warnings += 1;
      if (full.l === "E") {
        // 错误同时镜像到服务端统一日志（SSE / logs server 可见），便于实时盯
        logger.warn("UnityLog", `[${sid}] ${full.m.slice(0, MIRROR_TEXT_CHARS)}`);
      }
    }
    if (state.recent.length > 200) {
      state.recent.splice(0, state.recent.length - 200);
    }
    info.batches += 1;
    info.lastAt = now;
    if (info.firstAt === 0) info.firstAt = now;
    if (envelope.dropped > info.dropped) info.dropped = envelope.dropped;
    if (Object.keys(envelope.device).length > 0) info.device = envelope.device;

    if (lines.length > 0) {
      this.ensureDir();
      const payload = `${lines.join("\n")}\n`;
      const bytes = Buffer.byteLength(payload, "utf8");
      if (info.bytes + bytes > this.maxSessionBytes) {
        this.rotate(sid);
        info.truncated = true;
        info.bytes = 0;
      }
      appendFileSync(this.dataPath(sid), payload, "utf8");
      info.bytes += bytes;
    }
    this.writeMeta(state);
    logger.info(
      "UnityLog",
      `日志批到达: sid=${sid} batch=${batchId} 记录=${envelope.records.length} 累计=${info.records} 丢弃=${info.dropped}`,
    );
  }

  /**
   * 轮转一个会话的数据文件（旧文件保留一份 `<sid>.1.ndjson`）。
   * @param sid - 会话标识
   * @returns 无
   */
  private rotate(sid: string): void {
    const current = this.dataPath(sid);
    const rotated = join(this.dir, `${sid}.1.ndjson`);
    try {
      if (existsSync(rotated)) rmSync(rotated, { force: true });
      if (existsSync(current)) renameSync(current, rotated);
      logger.warn("UnityLog", `会话日志超限轮转: ${sid} → ${sid}.1.ndjson`);
    } catch (error) {
      logger.warn("UnityLog", `轮转失败（继续追加）: ${sid} ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 取（或惰性建立）会话状态，缺省从 meta 文件恢复。
   * @param sid - 会话标识
   * @returns 会话状态
   */
  private state(sid: string): SessionState {
    const cached = this.sessions.get(sid);
    if (cached !== undefined) return cached;
    const fromFile = existsSync(this.metaPath(sid)) ? readMeta(this.metaPath(sid)) : null;
    const info: UnityLogSessionInfo =
      fromFile ?? {
        sid,
        firstAt: 0,
        lastAt: 0,
        batches: 0,
        records: 0,
        dropped: 0,
        errors: 0,
        warnings: 0,
        bytes: existsSync(this.dataPath(sid)) ? statSync(this.dataPath(sid)).size : 0,
        truncated: existsSync(join(this.dir, `${sid}.1.ndjson`)),
        device: {},
      };
    const state: SessionState = { info, recent: [] };
    this.sessions.set(sid, state);
    return state;
  }

  /**
   * 落盘会话索引（`<sid>.meta.json`）。
   * @param state - 会话状态
   * @returns 无
   */
  private writeMeta(state: SessionState): void {
    try {
      this.ensureDir();
      const info = state.info;
      const payload = JSON.stringify(info, null, 2);
      // meta 很小，直接同步原子写（每批一次），避免异步队列在进程退出时丢索引
      const target = this.metaPath(info.sid);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, target);
    } catch (error) {
      logger.warn("UnityLog", `会话索引写入失败: ${state.info.sid} ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 列出全部会话（合并内存态与磁盘 meta；按最近活动倒序）。
   * @returns 会话索引列表
   */
  listSessions(): UnityLogSessionInfo[] {
    const out = new Map<string, UnityLogSessionInfo>();
    for (const [sid, state] of this.sessions) {
      out.set(sid, state.info);
    }
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith(".meta.json")) continue;
        const info = readMeta(join(this.dir, name));
        if (info === null) continue;
        const cached = out.get(info.sid);
        // 内存态更新（进程内刚写过），否则用磁盘态
        if (cached === undefined || info.records > cached.records) out.set(info.sid, info);
      }
    }
    return [...out.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * 读取某会话的记录（优先内存近期缓冲，否则读文件）。
   *
   * @param sid   会话标识
   * @param query 过滤条件（limit 缺省 100；level 缺省全部）
   * @returns 记录列表（按时间正序）
   */
  readRecords(sid: string, query: UnityLogQuery = {}): UnityLogRecord[] {
    const limit = Math.max(1, Math.min(query.limit ?? 100, 100_000));
    const level = typeof query.level === "string" && query.level.length > 0 ? query.level.toUpperCase() : "";
    const cached = this.sessions.get(sid);
    if (cached !== undefined && cached.recent.length >= limit) {
      return filterRecords(cached.recent, level).slice(-limit);
    }
    const file = this.dataPath(sid);
    if (!existsSync(file)) {
      return cached === undefined ? [] : filterRecords(cached.recent, level).slice(-limit);
    }
    const out: UnityLogRecord[] = [];
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as JsonValue;
        if (!isJsonObject(parsed)) continue;
        const rec = toRecord(parsed, sid);
        if (rec === null) continue;
        if (level !== "" && rec.l !== level) continue;
        out.push(rec);
        // 只留尾部 limit 条，避免大文件撑爆内存
        if (out.length > limit) out.shift();
      } catch {
        // 单行损坏不影响其余记录
      }
    }
    return out;
  }

  /**
   * 全局统计。
   * @returns 统计结果
   */
  stats(): UnityLogStats {
    const sessions = this.listSessions();
    let records = 0;
    let errors = 0;
    let warnings = 0;
    let bytes = 0;
    for (const s of sessions) {
      records += s.records;
      errors += s.errors;
      warnings += s.warnings;
      bytes += s.bytes;
    }
    return { sessions: sessions.length, records, errors, warnings, bytes, dir: this.dir };
  }

  /**
   * 清空日志（单会话或全部）。
   *
   * @param sid - 会话标识；缺省清空全部
   * @returns 删除的文件数
   */
  clear(sid?: string): number {
    let removed = 0;
    if (sid !== undefined) {
      if (!ID_RE.test(sid)) return 0;
      for (const file of [this.dataPath(sid), this.metaPath(sid), join(this.dir, `${sid}.1.ndjson`)]) {
        if (existsSync(file)) {
          rmSync(file, { force: true });
          removed += 1;
        }
      }
      this.sessions.delete(sid);
      return removed;
    }
    this.sessions.clear();
    this.partials.clear();
    if (!existsSync(this.dir)) return 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".ndjson") && !name.endsWith(".meta.json") && !name.endsWith(".tmp")) continue;
      rmSync(join(this.dir, name), { force: true });
      removed += 1;
    }
    return removed;
  }
}

/**
 * 按级别码过滤记录。
 * @param records - 记录列表
 * @param level   - 级别码（空串表示不过滤）
 * @returns 过滤后的记录
 */
function filterRecords(records: UnityLogRecord[], level: string): UnityLogRecord[] {
  return level === "" ? [...records] : records.filter((r) => r.l === level);
}

/**
 * 把磁盘上的一行 JSON 还原成记录。
 * @param obj - 解析出的 JSON 对象
 * @param sid - 会话标识（兜底补全）
 * @returns 记录或 null
 */
function toRecord(obj: JsonObject, sid: string): UnityLogRecord | null {
  const m = obj.m;
  if (typeof m !== "string") return null;
  const rec: UnityLogRecord = {
    sid: typeof obj.sid === "string" ? obj.sid : sid,
    batchId: typeof obj.batchId === "string" ? obj.batchId : "",
    receivedAt: typeof obj.receivedAt === "number" ? obj.receivedAt : 0,
    l: normalizeLevel(obj.l),
    m,
  };
  if (typeof obj.t === "number") rec.t = obj.t;
  if (typeof obj.s === "string") rec.s = obj.s;
  if (typeof obj.c === "number") rec.c = obj.c;
  return rec;
}

/** 进程内单例（路由使用；CLI 可另建实例离线读同一目录） */
export const pluginLogStore = new PluginLogStore();
