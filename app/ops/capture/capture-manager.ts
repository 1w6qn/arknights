/**
 * 统一抓包管理器（现代化抓包管理系统核心）
 *
 * 所有抓包来源（私服 traffic-recorder / capture 官服转发 / 独立代理 proxy-harness /
 * arkhub 网关 TCP 转发器 / 官服操作 official-ops）统一写入同一存储：
 *
 *   tmp/capture/
 *     index.db                  ← SQLite 元数据索引（sessions + records）
 *     records/{rid}/            ← 每条记录的 body 文件目录
 *       req.json | req.bin      ← 请求体（JSON 可解析→.json；原始字节→.bin）
 *       res.json | res.bin      ← 响应体
 *       up.bin / down.bin       ← 网关连接原始字节流（direction=gateway-bidi）
 *       parsed.json / messages.json  ← arkhub 网关连接关闭时生成的网关帧解析产物
 *       meta.json               ← 完整元数据副本（导出/便携用）
 *     exports/                  ← 会话导出 zip
 *
 * 设计要点：
 * - DB 只存元数据，body 走文件（大响应如 syncData 多 MB 不膨胀 DB）。
 * - 写入失败绝不阻断业务（addRecordAsync fire-and-forget + catch）。
 * - 无显式会话的记录自动归入「自动-{yyyyMMdd}」默认会话（保持全量记录旧行为）。
 * - subscribe() 提供新记录事件，供 SSE 实时尾随（Dashboard「抓包」Tab）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile, rm, stat, readdir } from "fs/promises";
import * as path from "path";
import JSZip from "jszip";
import { allRows, openCaptureDb, CAPTURE_DB_FILENAME } from "./capture-db";
import { logger } from "@utils/logger";

/** 抓包来源 */
export type CaptureSource = "private" | "official" | "harness" | "gateway" | "ops";
/** 记录方向：http 请求/响应 | 网关双向字节流 */
export type CaptureDirection = "http" | "gateway-bidi";
/** body 文件类型 */
export type BodyKind = "json" | "bin" | "none";

/** 抓包记录（DB 行） */
export interface CaptureRecord {
  id: number;
  rid: string;
  sessionId: string | null;
  ts: number;
  method: string | null;
  path: string | null;
  query: string | null;
  module: string | null;
  endpoint: string | null;
  status: number | null;
  latencyMs: number | null;
  source: CaptureSource;
  direction: string;
  reqHeaders: string | null;
  reqBodyType: BodyKind;
  reqBodyFile: string | null;
  reqSize: number | null;
  resHeaders: string | null;
  resBodyType: BodyKind;
  resBodyFile: string | null;
  resSize: number | null;
  note: string | null;
}

/** 抓包会话（DB 行） */
export interface CaptureSession {
  id: string;
  name: string;
  source: string;
  startedAt: number;
  endedAt: number | null;
  note: string | null;
}

/** 新记录元数据输入 */
export interface CaptureRecordInput {
  sessionId?: string | null;
  /** 记录时间（epoch ms；缺省 Date.now()） */
  ts?: number;
  method?: string;
  /** 归一化路径（不含 query） */
  path?: string;
  /** 原始 query 字符串 */
  query?: string;
  status?: number | null;
  latencyMs?: number | null;
  source: CaptureSource;
  direction?: CaptureDirection;
  reqHeaders?: Record<string, unknown> | null;
  resHeaders?: Record<string, unknown> | null;
  /** 已存在于记录目录中的 body 文件（commitRecord 用；gateway 方向自动用 up.bin/down.bin） */
  reqBodyFile?: string | null;
  resBodyFile?: string | null;
  /** body 尺寸（缺省按文件 stat） */
  reqSize?: number | null;
  resSize?: number | null;
  note?: string;
}

/** 单个 body 输入 */
export interface CaptureBodyInput {
  kind: BodyKind;
  /** json：对象/字符串；bin：Buffer/字符串（原始字节） */
  data: unknown;
}

/** body 文件输入 */
export interface CaptureBodiesInput {
  req?: CaptureBodyInput | null;
  res?: CaptureBodyInput | null;
  /** 网关连接（direction=gateway-bidi）：原始字节流 + 解析产物 */
  gateway?: {
    up: Buffer;
    down: Buffer;
    parsed?: unknown;
    messages?: unknown;
    /** 额外写进 meta.json 的字段（如 targetAddr/reason） */
    metaExtra?: Record<string, unknown>;
  } | null;
}

/** 查询过滤条件 */
export interface CaptureQuery {
  sessionId?: string;
  source?: string;
  method?: string;
  /** path 子串匹配 */
  path?: string;
  module?: string;
  endpoint?: string;
  direction?: string;
  status?: number;
  /** ts >= from（epoch ms） */
  from?: number;
  /** ts <= to（epoch ms） */
  to?: number;
  /** 在 path/module/endpoint 中搜索 */
  q?: string;
  limit?: number;
  offset?: number;
  /** 时间升序（缺省倒序——最新在前） */
  asc?: boolean;
}

/** 查询结果 */
export interface CaptureQueryResult {
  total: number;
  offset: number;
  limit: number;
  items: CaptureRecord[];
}

/** 记录详情（含 body 内容，供 API/UI） */
export interface CaptureRecordDetail extends CaptureRecord {
  reqBody?: unknown;
  resBody?: unknown;
  /** 引用文件缺失（已删除/清理）的文件名列表 */
  missingFiles: string[];
}

/** 抓包统计 */
export interface CaptureStats {
  total: number;
  sessions: number;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  byDay: { day: string; count: number }[];
  dbPath: string;
  root: string;
}

/** 会话导出结果 */
export interface CaptureExportResult {
  path: string;
  records: number;
  size: number;
}

/** 默认存储根目录（gitignored） */
const DEFAULT_ROOT = "tmp/capture";

/** 危险操作确认词（防误清） */
const CONFIRM_WORD = "CLEAR";

/** SQL 参数类型（node:sqlite 接受的输入类型） */
type SqlParam = string | number | null | bigint | Uint8Array;

/**
 * 统一抓包管理器
 *
 * 单例 captureManager：configure() 注入测试目录后 init()；
 * 生产路径 index.ts 启动时 init()，写入方（recorder/gateway/ops）经 addRecord 统一落库。
 * 未 init 时写入方调用会触发惰性 init（ensureInit），保证独立工具（proxy-harness/CLI）开箱即用。
 */
class CaptureManager {
  private _root = DEFAULT_ROOT;
  private _dbPath = path.join(DEFAULT_ROOT, CAPTURE_DB_FILENAME);
  private _db: DatabaseSync | null = null;
  /** rid 序号（同毫秒多条记录保证唯一、可排序） */
  private _ridSeq = 0;
  private _listeners = new Set<(r: CaptureRecord) => void>();

  /**
   * 注入存储配置（测试用：独立临时根目录 + DB 路径，绝不碰真实 tmp/capture/）
   * 已 init 时先关闭旧连接，下次 init 生效。
   */
  configure(opts: { root?: string; dbPath?: string }): void {
    if (opts.root) {
      this._root = opts.root;
      if (!opts.dbPath) this._dbPath = path.join(opts.root, CAPTURE_DB_FILENAME);
    }
    if (opts.dbPath) this._dbPath = opts.dbPath;
    this.close();
  }

  /** 当前存储根目录 */
  get root(): string {
    return this._root;
  }

  /** 记录 body 目录（records/{rid}/ 的父目录） */
  recordsDir(): string {
    return path.join(this._root, "records");
  }

  /** DB 是否已打开 */
  isReady(): boolean {
    return this._db !== null;
  }

  /**
   * 初始化（幂等）：建目录 + 开库建表
   * 服务器启动（index.ts）与独立工具（proxy-harness/CLI）均调用。
   */
  async init(): Promise<void> {
    if (this._db) return;
    await mkdir(this._root, { recursive: true });
    await mkdir(this.recordsDir(), { recursive: true });
    await mkdir(this.exportDir(), { recursive: true });
    this._db = openCaptureDb(this._dbPath);
  }

  /** 惰性初始化（写入方安全调用：未 init 时补 init） */
  async ensureInit(): Promise<void> {
    if (!this._db) await this.init();
  }

  /** 关闭连接（测试用；configure 更换目录时自动调用） */
  close(): void {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        /* 已关闭忽略 */
      }
      this._db = null;
    }
  }

  /** 重置（测试用：关闭 + 清订阅 + 清序号） */
  reset(): void {
    this.close();
    this._listeners.clear();
    this._ridSeq = 0;
  }

  /** 会话导出目录 */
  exportDir(): string {
    return path.join(this._root, "exports");
  }

  /** 订阅新记录事件；返回退订函数 */
  subscribe(fn: (r: CaptureRecord) => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private emit(r: CaptureRecord): void {
    for (const fn of this._listeners) {
      try {
        fn(r);
      } catch {
        /* 订阅者异常不影响存储 */
      }
    }
  }

  /** 生成记录目录名：R-{ts}-{seq}（可排序、唯一） */
  private nextRid(ts: number): string {
    this._ridSeq++;
    return `R-${ts}-${String(this._ridSeq).padStart(4, "0")}`;
  }

  /** 今日默认会话名：自动-{yyyyMMdd} */
  private defaultSessionName(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `自动-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  /**
   * 确保默认会话存在（按 源+当天 一个）：无显式会话的记录归入，
   * 保持旧系统"全量记录"行为——即使没人手动建会话也能在 UI/CLI 查到。
   */
  async ensureDefaultSession(source: CaptureSource, ts: number): Promise<string> {
    const d = new Date(ts);
    const name = this.defaultSessionName(d);
    const stmt = this.db().prepare(
      "SELECT id FROM sessions WHERE name = ? AND source = ? AND ended_at IS NULL LIMIT 1",
    );
    const row = stmt.get(name, source) as { id: string } | undefined;
    if (row) return row.id;
    const id = `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.db()
      .prepare("INSERT INTO sessions (id, name, source, started_at, note) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, source, ts, "自动会话（未指定会话的记录）");
    return id;
  }

  /** 内部取 DB（未 init 抛错） */
  private db(): DatabaseSync {
    if (!this._db) throw new Error("captureManager 未初始化，请先调用 init()");
    return this._db;
  }

  /** 新建会话 */
  async startSession(name: string, source: CaptureSource, note = ""): Promise<CaptureSession> {
    await this.ensureInit();
    const id = `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ts = Date.now();
    this.db()
      .prepare("INSERT INTO sessions (id, name, source, started_at, note) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, source, ts, note || null);
    return { id, name, source, startedAt: ts, endedAt: null, note: note || null };
  }

  /** 停止会话（记录停止后不再归入该会话） */
  async stopSession(id: string): Promise<boolean> {
    await this.ensureInit();
    const r = this.db().prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(Date.now(), id);
    return Number(r.changes) > 0;
  }

  /** 会话列表（最新在前；含运行中/已结束与记录数） */
  async listSessions(): Promise<(CaptureSession & { recordCount: number })[]> {
    await this.ensureInit();
    const rows = allRows<CaptureSession & { recordCount: number }>(
      this.db().prepare(
        `SELECT s.id, s.name, s.source, s.started_at AS startedAt, s.ended_at AS endedAt, s.note,
                (SELECT COUNT(*) FROM records r WHERE r.session_id = s.id) AS recordCount
         FROM sessions s ORDER BY s.started_at DESC`,
      ),
    );
    return rows;
  }

  /** 删除会话（级联删除其全部记录与 body 目录） */
  async deleteSession(id: string): Promise<number> {
    await this.ensureInit();
    const recs = allRows<{ rid: string }>(
      this.db().prepare("SELECT rid FROM records WHERE session_id = ?"),
      id,
    );
    const stmt = this.db().prepare("DELETE FROM records WHERE session_id = ?");
    stmt.run(id);
    const del = this.db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
    // 异步删 body 目录（失败不阻断）
    for (const r of recs) {
      void rm(path.join(this.recordsDir(), r.rid), { recursive: true, force: true }).catch(() => undefined);
    }
    return Number(del.changes);
  }

  /**
   * 写入一条抓包记录（完整路径：建目录→写 body→插行→写 meta.json→广播）
   * 供 traffic-recorder / proxy-harness / official-ops 使用。
   */
  async addRecord(
    input: CaptureRecordInput,
    bodies: CaptureBodiesInput = {},
  ): Promise<CaptureRecord> {
    await this.ensureInit();
    const ts = input.ts ?? Date.now();
    const sessionId = input.sessionId ?? (await this.ensureDefaultSession(input.source, ts));
    const rid = this.nextRid(ts);
    const dir = path.join(this.recordsDir(), rid);
    await mkdir(dir, { recursive: true });

    const reqFile = await this.writeBody(dir, "req", bodies.req);
    const resFile = await this.writeBody(dir, "res", bodies.res);
    if (bodies.gateway) {
      await writeFile(path.join(dir, "up.bin"), bodies.gateway.up);
      await writeFile(path.join(dir, "down.bin"), bodies.gateway.down);
      if (bodies.gateway.parsed !== undefined) {
        await writeFile(path.join(dir, "parsed.json"), JSON.stringify(bodies.gateway.parsed, null, 2), "utf-8");
      }
      if (bodies.gateway.messages !== undefined) {
        await writeFile(path.join(dir, "messages.json"), JSON.stringify(bodies.gateway.messages, null, 2), "utf-8");
      }
    }

    const row = this.insertRow(rid, input, sessionId, ts, reqFile, resFile, bodies);
    await this.writeMeta(dir, row, bodies);
    this.emit(row);
    return row;
  }

  /**
   * 提交一条已写文件目录的记录（网关 TCP 转发器用）：
   * 连接期间已把 up.bin/down.bin 等写入 dir，关闭时补插 DB 行 + meta.json。
   */
  async commitRecord(
    rid: string,
    input: CaptureRecordInput,
    dir: string,
    extraMeta?: Record<string, unknown>,
  ): Promise<CaptureRecord | null> {
    // 未初始化（如测试只验证转发不验证索引）时仅保留文件，不落库
    if (!this._db) return null;
    const ts = input.ts ?? Date.now();
    const sessionId = input.sessionId ?? (await this.ensureDefaultSession(input.source, ts));
    const reqFile = input.direction === "gateway-bidi" ? "up.bin" : input.reqBodyFile ?? null;
    const resFile = input.direction === "gateway-bidi" ? "down.bin" : input.resBodyFile ?? null;
    // 尺寸缺省时按文件 stat（网关方向 up.bin/down.bin 已在连接期间写入）
    const reqSize = input.reqSize ?? (reqFile ? await this.fileSize(path.join(dir, reqFile)) : null);
    const resSize = input.resSize ?? (resFile ? await this.fileSize(path.join(dir, resFile)) : null);
    const row = this.insertRow(rid, input, sessionId, ts, {
      type: reqFile ? (reqFile.endsWith(".json") ? "json" : "bin") : "none",
      file: reqFile,
      size: reqSize,
    }, {
      type: resFile ? (resFile.endsWith(".json") ? "json" : "bin") : "none",
      file: resFile,
      size: resSize,
    });
    await this.writeMeta(dir, row, undefined, extraMeta);
    this.emit(row);
    return row;
  }

  /** 文件大小（不存在返回 null） */
  private async fileSize(fp: string): Promise<number | null> {
    try {
      const st = await stat(fp);
      return st.size;
    } catch {
      return null;
    }
  }

  /** 写单个 body 文件（json→.json 美化？compact；bin→原始字节 .bin），返回 { type, file, size } */
  private async writeBody(
    dir: string,
    side: "req" | "res",
    body: CaptureBodyInput | null | undefined,
  ): Promise<{ type: BodyKind; file: string | null; size: number | null }> {
    if (!body || body.kind === "none" || body.data === undefined || body.data === null) {
      return { type: "none", file: null, size: null };
    }
    if (body.kind === "json") {
      const text = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
      const file = `${side}.json`;
      await writeFile(path.join(dir, file), text, "utf-8");
      return { type: "json", file, size: Buffer.byteLength(text, "utf-8") };
    }
    // bin：Buffer 原样；字符串按 utf8 字节
    const buf = Buffer.isBuffer(body.data) ? body.data : Buffer.from(String(body.data), "utf-8");
    const file = `${side}.bin`;
    await writeFile(path.join(dir, file), buf);
    return { type: "bin", file, size: buf.length };
  }

  /** 插入 DB 行（body 文件尺寸缺省时按文件 stat） */
  private insertRow(
    rid: string,
    input: CaptureRecordInput,
    sessionId: string,
    ts: number,
    req: { type: BodyKind; file: string | null; size: number | null },
    res: { type: BodyKind; file: string | null; size: number | null },
    bodies?: CaptureBodiesInput,
  ): CaptureRecord {
    const direction = input.direction ?? "http";
    let reqSize = req.size;
    let resSize = res.size;
    if (bodies?.gateway) {
      reqSize = bodies.gateway.up.length;
      resSize = bodies.gateway.down.length;
    }
    const stmt = this.db().prepare(
      `INSERT INTO records
        (rid, session_id, ts, method, path, query, module, endpoint, status, latency_ms,
         source, direction, req_headers, req_body_type, req_body_file, req_size,
         res_headers, res_body_type, res_body_file, res_size, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const { module, endpoint } = splitPath(input.path ?? "");
    const info = stmt.run(
      rid,
      sessionId,
      ts,
      input.method ?? null,
      input.path ?? null,
      input.query ?? null,
      module,
      endpoint,
      input.status ?? null,
      input.latencyMs ?? null,
      input.source,
      direction,
      input.reqHeaders ? JSON.stringify(input.reqHeaders) : null,
      req.type,
      req.file,
      reqSize,
      input.resHeaders ? JSON.stringify(input.resHeaders) : null,
      res.type,
      res.file,
      resSize,
      input.note ?? null,
    );
    return {
      id: Number(info.lastInsertRowid),
      rid,
      sessionId,
      ts,
      method: input.method ?? null,
      path: input.path ?? null,
      query: input.query ?? null,
      module,
      endpoint,
      status: input.status ?? null,
      latencyMs: input.latencyMs ?? null,
      source: input.source,
      direction,
      reqHeaders: input.reqHeaders ? JSON.stringify(input.reqHeaders) : null,
      reqBodyType: req.type,
      reqBodyFile: req.file,
      reqSize,
      resHeaders: input.resHeaders ? JSON.stringify(input.resHeaders) : null,
      resBodyType: res.type,
      resBodyFile: res.file,
      resSize,
      note: input.note ?? null,
    };
  }

  /** 写 meta.json（完整元数据副本；gateway 额外字段合并） */
  private async writeMeta(
    dir: string,
    row: CaptureRecord,
    bodies?: CaptureBodiesInput,
    extraMeta?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const meta: Record<string, unknown> = { ...row };
      if (bodies?.gateway) {
        meta.gateway = {
          upBytes: bodies.gateway.up.length,
          downBytes: bodies.gateway.down.length,
          hasParsed: bodies.gateway.parsed !== undefined,
          hasMessages: bodies.gateway.messages !== undefined,
          ...(bodies.gateway.metaExtra ?? {}),
        };
      }
      if (extraMeta) Object.assign(meta, extraMeta);
      await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
    } catch {
      /* meta.json 写入失败不影响索引 */
    }
  }

  /**
   * 查询记录（过滤 + 分页 + total；缺省按时间倒序）
   */
  async query(q: CaptureQuery = {}): Promise<CaptureQueryResult> {
    await this.ensureInit();
    const where: string[] = [];
    const params: SqlParam[] = [];
    const add = (cond: string, val: SqlParam) => {
      where.push(cond);
      params.push(val);
    };
    if (q.sessionId) add("session_id = ?", q.sessionId);
    if (q.source) add("source = ?", q.source);
    if (q.method) add("method = ?", q.method);
    if (q.path) add("path LIKE ?", `%${q.path}%`);
    if (q.module) add("module = ?", q.module);
    if (q.endpoint) add("endpoint LIKE ?", `%${q.endpoint}%`);
    if (q.direction) add("direction = ?", q.direction);
    if (q.status !== undefined && q.status !== null) add("status = ?", q.status);
    if (q.from !== undefined) add("ts >= ?", q.from);
    if (q.to !== undefined) add("ts <= ?", q.to);
    if (q.q) {
      where.push("(path LIKE ? OR module LIKE ? OR endpoint LIKE ?)");
      const kw = `%${q.q}%`;
      params.push(kw, kw, kw);
    }
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), 1000);
    const offset = Math.max(Math.floor(q.offset ?? 0), 0);
    const order = q.asc ? "ASC" : "DESC";

    const totalRow = this.db()
      .prepare(`SELECT COUNT(*) AS c FROM records${whereSql}`)
      .get(...params) as { c: number };
    const rows = allRows<CaptureRecord>(
      this.db().prepare(
        `SELECT id, rid, session_id AS sessionId, ts, method, path, query, module, endpoint,
                status, latency_ms AS latencyMs, source, direction,
                req_headers AS reqHeaders, req_body_type AS reqBodyType, req_body_file AS reqBodyFile, req_size AS reqSize,
                res_headers AS resHeaders, res_body_type AS resBodyType, res_body_file AS resBodyFile, res_size AS resSize,
                note
         FROM records${whereSql} ORDER BY ts ${order}, id ${order} LIMIT ? OFFSET ?`,
      ),
      ...params,
      limit,
      offset,
    );
    return { total: totalRow.c, offset, limit, items: rows };
  }

  /** 取单条记录（按数字 id 或 rid 字符串） */
  async getRecord(idOrRid: string | number): Promise<CaptureRecord | null> {
    await this.ensureInit();
    const row =
      typeof idOrRid === "number" || /^\d+$/.test(String(idOrRid))
        ? (this.db()
            .prepare(
              `SELECT id, rid, session_id AS sessionId, ts, method, path, query, module, endpoint,
                      status, latency_ms AS latencyMs, source, direction,
                      req_headers AS reqHeaders, req_body_type AS reqBodyType, req_body_file AS reqBodyFile, req_size AS reqSize,
                      res_headers AS resHeaders, res_body_type AS resBodyType, res_body_file AS resBodyFile, res_size AS resSize,
                      note FROM records WHERE id = ?`,
            )
            .get(Number(idOrRid)) as CaptureRecord | undefined)
        : (this.db()
            .prepare(
              `SELECT id, rid, session_id AS sessionId, ts, method, path, query, module, endpoint,
                      status, latency_ms AS latencyMs, source, direction,
                      req_headers AS reqHeaders, req_body_type AS reqBodyType, req_body_file AS reqBodyFile, req_size AS reqSize,
                      res_headers AS resHeaders, res_body_type AS resBodyType, res_body_file AS resBodyFile, res_size AS resSize,
                      note FROM records WHERE rid = ?`,
            )
            .get(String(idOrRid)) as CaptureRecord | undefined);
    return row ?? null;
  }

  /**
   * 记录详情：行 + 解析后的头/body（JSON body 解析为对象；bin body 返回 { base64, size }）
   */
  async getRecordDetail(idOrRid: string | number): Promise<CaptureRecordDetail | null> {
    const row = await this.getRecord(idOrRid);
    if (!row) return null;
    const dir = path.join(this.recordsDir(), row.rid);
    const missingFiles: string[] = [];
    const reqBody = await this.readBodyFile(dir, row.reqBodyType, row.reqBodyFile, missingFiles);
    const resBody = await this.readBodyFile(dir, row.resBodyType, row.resBodyFile, missingFiles);
    return { ...row, reqBody, resBody, missingFiles };
  }

  /** 读 body 文件（json→解析对象；bin→{base64,size,hexPreview}） */
  private async readBodyFile(
    dir: string,
    type: BodyKind,
    file: string | null,
    missingFiles: string[],
  ): Promise<unknown> {
    if (!file || type === "none") return undefined;
    const fp = path.join(dir, file);
    try {
      const raw = await readFile(fp);
      if (type === "json") {
        try {
          return JSON.parse(raw.toString("utf-8"));
        } catch {
          return raw.toString("utf-8");
        }
      }
      return { base64: raw.toString("base64"), size: raw.length, hexPreview: raw.subarray(0, 32).toString("hex") };
    } catch {
      missingFiles.push(file);
      return undefined;
    }
  }

  /** 删除单条记录（含 body 目录） */
  async deleteRecord(idOrRid: string | number): Promise<boolean> {
    await this.ensureInit();
    const row = await this.getRecord(idOrRid);
    if (!row) return false;
    this.db().prepare("DELETE FROM records WHERE id = ?").run(row.id);
    void rm(path.join(this.recordsDir(), row.rid), { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  /** 清空全部抓包（确认词保护；保留目录骨架） */
  async clearAll(confirmWord: string): Promise<{ cleared: number }> {
    if (confirmWord !== CONFIRM_WORD) {
      throw new Error(`危险操作：需传 confirmWord="${CONFIRM_WORD}" 确认`);
    }
    await this.ensureInit();
    const before = (this.db().prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number }).c;
    this.db().prepare("DELETE FROM records").run();
    this.db().prepare("DELETE FROM sessions").run();
    // 清空 records/ 目录内容（保留骨架目录）
    const dir = this.recordsDir();
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      void rm(path.join(dir, n), { recursive: true, force: true }).catch(() => undefined);
    }
    return { cleared: before };
  }

  /** 抓包统计（来源/状态码/按天） */
  async stats(): Promise<CaptureStats> {
    await this.ensureInit();
    const total = (this.db().prepare("SELECT COUNT(*) AS c FROM records").get() as { c: number }).c;
    const sessions = (this.db().prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
    const bySource: Record<string, number> = {};
    for (const r of this.db().prepare("SELECT source, COUNT(*) AS c FROM records GROUP BY source").all() as {
      source: string;
      c: number;
    }[]) bySource[r.source] = r.c;
    const byStatus: Record<string, number> = {};
    for (const r of this.db().prepare("SELECT status, COUNT(*) AS c FROM records GROUP BY status").all() as {
      status: number | null;
      c: number;
    }[]) byStatus[String(r.status ?? "-")] = r.c;
    const byDay: { day: string; count: number }[] = (
      this.db()
        .prepare(
          `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS c
           FROM records GROUP BY day ORDER BY day DESC LIMIT 30`,
        )
        .all() as { day: string; c: number }[]
    ).map((r) => ({ day: r.day, count: r.c }));
    return { total, sessions, bySource, byStatus, byDay, dbPath: this._dbPath, root: this._root };
  }

  /**
   * 导出会话为 zip（index.json + 全部记录 meta + body 文件）
   * 输出到 {root}/exports/{会话名}-{id}.zip
   */
  async exportSession(sessionId: string): Promise<CaptureExportResult> {
    await this.ensureInit();
    const session = this.db()
      .prepare("SELECT id, name, source, started_at AS startedAt, ended_at AS endedAt, note FROM sessions WHERE id = ?")
      .get(sessionId) as CaptureSession | undefined;
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    const { items } = await this.query({ sessionId, limit: 1000 });
    const zip = new JSZip();
    zip.file("index.json", JSON.stringify({ session, records: items }, null, 2));
    for (const rec of items) {
      const dir = path.join(this.recordsDir(), rec.rid);
      for (const file of [rec.reqBodyFile, rec.resBodyFile, "meta.json"].filter((f): f is string => !!f)) {
        try {
          zip.file(`${rec.rid}/${file}`, await readFile(path.join(dir, file)));
        } catch {
          /* 缺失文件跳过 */
        }
      }
      if (rec.direction === "gateway-bidi") {
        for (const file of ["up.bin", "down.bin", "parsed.json", "messages.json"]) {
          try {
            zip.file(`${rec.rid}/${file}`, await readFile(path.join(dir, file)));
          } catch {
            /* 缺失文件跳过 */
          }
        }
      }
    }
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const safe = String(session.name).replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
    const outPath = path.join(this.exportDir(), `capture-${safe}-${sessionId}.zip`);
    await mkdir(this.exportDir(), { recursive: true });
    await writeFile(outPath, buf);
    const st = await stat(outPath);
    return { path: outPath, records: items.length, size: st.size };
  }

  /** 单条记录导出（zip，用于 UI 下载单条） */
  async exportRecord(idOrRid: string | number): Promise<CaptureExportResult> {
    const row = await this.getRecord(idOrRid);
    if (!row) throw new Error(`记录不存在: ${idOrRid}`);
    const zip = new JSZip();
    zip.file("record.json", JSON.stringify(row, null, 2));
    const dir = path.join(this.recordsDir(), row.rid);
    for (const file of [row.reqBodyFile, row.resBodyFile, "meta.json"].filter((f): f is string => !!f)) {
      try {
        zip.file(file, await readFile(path.join(dir, file)));
      } catch {
        /* 缺失跳过 */
      }
    }
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const outPath = path.join(this.exportDir(), `capture-record-${row.rid}.zip`);
    await mkdir(this.exportDir(), { recursive: true });
    await writeFile(outPath, buf);
    const st = await stat(outPath);
    return { path: outPath, records: 1, size: st.size };
  }
}

/** 从路径拆出 module（首段）/ endpoint（其余段） */
export function splitPath(p: string): { module: string | null; endpoint: string | null } {
  const segments = String(p ?? "")
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  if (!segments.length) return { module: null, endpoint: null };
  const [module, ...rest] = segments;
  return { module, endpoint: rest.join("/") || module };
}

/** 全局单例 */
export const captureManager = new CaptureManager();
