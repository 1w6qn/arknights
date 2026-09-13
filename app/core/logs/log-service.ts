/**
 * 统一日志服务
 *
 * 聚合管理所有日志来源，供 Dashboard「日志」Tab / 管理 REST API / CLI 使用：
 * - 服务器日志：logs/server-YYYYMMDD.log（logger 按天轮转，文本行格式）
 * - 看门狗日志：logs/watchdog-*.log
 * - 审计日志：data/admin/logs.jsonl（持久化在 ops/admin；本服务经 AuditLogSource 端口读取）
 * - 实时日志：logger 订阅（subscribeLog）→ SSE 尾随
 *
 * 服务器日志行格式：`YYYY-MM-DD HH:MM:SS [LEVEL] [TAG] 内容`（与 logger 落盘一致）。
 */
import { readdir, readFile, rm } from "fs/promises";
import * as path from "path";
import { subscribeLog, logDir, LogEvent } from "@utils/logger";

/** 服务器日志文件名前缀 */
const SERVER_PREFIX = "server-";
const WATCHDOG_PREFIX = "watchdog-";

/** 服务器日志行解析正则：时间 [级别] [标签] 内容 */
const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(DEBUG|INFO|WARN|ERROR)\] \[([^\]]*)\] (.*)$/;

/** 单条服务器日志（解析后） */
export interface ServerLogEntry {
  ts: string;
  level: string;
  tag: string;
  text: string;
  raw: string;
}

/** 服务器日志查询条件 */
export interface ServerLogQuery {
  /** 日志日期（YYYYMMDD；缺省当天） */
  date?: string;
  /** 级别过滤（debug/info/warn/error） */
  level?: string;
  /** 标签过滤（精确匹配） */
  tag?: string;
  /** 内容关键字（raw 子串） */
  q?: string;
  limit?: number;
  offset?: number;
}

/** 服务器日志查询结果 */
export interface ServerLogResult {
  total: number;
  offset: number;
  limit: number;
  items: ServerLogEntry[];
}

/** 实时日志订阅类型 */
export type LiveLogKind = "server" | "audit" | "capture";

/** 审计日志条目（与 AdminService.AuditLogEntry 一致） */
export interface AuditLogEntry {
  ts: number;
  action: string;
  uid: string;
  detail: string;
}

/**
 * 审计日志源端口（core 定义，ops/admin 注入）
 *
 * 审计日志的**持久化实现在 ops/admin**（data/admin/logs.jsonl，由 `AdminService` 负责）。
 * core 不得依赖 ops（R1），故此处只声明「读取最近 N 条」的最小契约；`AdminService`
 * 在构造时经 {@link registerAuditLogSource} 注册自身（ops → core 允许）。
 */
export interface AuditLogSource {
  /**
   * 读取最近 N 条审计条目（时间倒序）
   * @param limit - 最大条数
   */
  logs(limit: number): Promise<AuditLogEntry[]>;
}

/** 已注册的审计日志源（未注册 = ops/admin 尚未加载，读取返回空） */
let auditSource: AuditLogSource | undefined;

/**
 * 注册审计日志源（由 `AdminService` 构造时调用）
 * @param src - 审计日志源；传 undefined 注销
 */
export function registerAuditLogSource(src: AuditLogSource | undefined): void {
  auditSource = src;
}

/**
 * 统一日志服务
 */
class LogService {
  /** 审计日志实时订阅（AdminService._audit 每次写入后广播） */
  private _auditListeners = new Set<(e: AuditLogEntry) => void>();

  /** 服务器日志日期列表（logs/server-*.log，按日期倒序） */
  async listServerLogDates(): Promise<string[]> {
    const names = await readdir(logDir()).catch(() => [] as string[]);
    return names
      .filter((n) => n.startsWith(SERVER_PREFIX) && n.endsWith(".log"))
      .map((n) => n.slice(SERVER_PREFIX.length, SERVER_PREFIX.length + 8))
      .sort((a, b) => b.localeCompare(a));
  }

  /** 当天日期（YYYYMMDD） */
  private today(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  /**
   * 读取并过滤服务器日志（倒序——最新在前，分页）
   */
  async readServerLog(q: ServerLogQuery = {}): Promise<ServerLogResult> {
    const date = q.date ?? this.today();
    const file = path.join(logDir(), `${SERVER_PREFIX}${date}.log`);
    let raw = "";
    try {
      raw = await readFile(file, "utf-8");
    } catch {
      return { total: 0, offset: 0, limit: q.limit ?? 100, items: [] };
    }
    const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), 2000);
    const offset = Math.max(Math.floor(q.offset ?? 0), 0);
    const level = q.level?.toUpperCase();
    const tag = q.tag?.trim();
    const kw = q.q?.trim();
    const entries: ServerLogEntry[] = [];
    for (const line of raw.split("\n")) {
      const m = LINE_RE.exec(line);
      if (!m) continue;
      if (level && m[2] !== level) continue;
      if (tag && m[3] !== tag) continue;
      if (kw && !line.includes(kw)) continue;
      entries.push({ ts: m[1], level: m[2], tag: m[3], text: m[4], raw: line });
    }
    // 修复：offset 超界（offset >= entries.length）时 entries.length - offset 为负，
    // slice 负端按从末尾截断 → 返回错误的"最后 N 条"；钳制 end 到 0
    const start = Math.max(entries.length - offset - limit, 0);
    const end = Math.max(entries.length - offset, 0);
    const items = entries.slice(start, end).reverse();
    return { total: entries.length, offset, limit, items };
  }

  /** 看门狗日志（文件列表 + 全部行） */
  async readWatchdogLog(): Promise<{ files: string[]; entries: { file: string; line: string }[] }> {
    const names = (await readdir(logDir()).catch(() => [] as string[])).filter(
      (n) => n.startsWith(WATCHDOG_PREFIX) && n.endsWith(".log"),
    );
    const entries: { file: string; line: string }[] = [];
    for (const n of names) {
      try {
        const raw = await readFile(path.join(logDir(), n), "utf-8");
        for (const line of raw.split("\n")) {
          if (line.trim()) entries.push({ file: n, line });
        }
      } catch {
        /* 单个文件读取失败跳过 */
      }
    }
    return { files: names, entries: entries.slice(-500).reverse() };
  }

  /**
   * 审计日志（经 {@link AuditLogSource} 端口读取 ops/admin 的持久化实现，再按条件过滤）
   * @param q - 过滤条件（action/uid/关键字/条数上限）
   * @returns 过滤后的审计条目（时间倒序）
   */
  async readAuditLog(q: { action?: string; uid?: string; q?: string; limit?: number } = {}): Promise<AuditLogEntry[]> {
    const limit = Math.min(Math.max(Math.floor(q.limit ?? 100), 1), 1000);
    // 审计日志源未注册（ops/admin 未加载：纯 core 单测、CLI 未触达 admin）→ 返回空列表
    if (!auditSource) return [];
    const entries = await auditSource.logs(limit);
    const action = q.action?.trim();
    const uid = q.uid?.trim();
    const kw = q.q?.trim();
    return entries.filter((e: AuditLogEntry) => {
      if (action && e.action !== action) return false;
      if (uid && e.uid !== uid) return false;
      if (kw && !(`${e.action} ${e.uid ?? ""} ${e.detail}`.includes(kw))) return false;
      return true;
    });
  }

  /** 清空服务器日志（确认词保护；删除全部 server-*.log） */
  async clearServerLogs(confirmWord: string): Promise<{ cleared: number }> {
    if (confirmWord !== "CLEAR") {
      throw new Error('危险操作：需传 confirmWord="CLEAR" 确认');
    }
    const names = await readdir(logDir()).catch(() => [] as string[]);
    let cleared = 0;
    for (const n of names.filter(
      (n) => n.startsWith(SERVER_PREFIX) && /\.log(\.\d+)?$/.test(n),
    )) {
      await rm(path.join(logDir(), n), { force: true }).catch(() => undefined);
      cleared++;
    }
    return { cleared };
  }

  /** 订阅服务器实时日志（bridge logger.subscribeLog） */
  subscribeServer(fn: (e: LogEvent) => void): () => void {
    return subscribeLog(fn);
  }

  /** 订阅审计实时日志（AdminService._audit 广播） */
  subscribeAudit(fn: (e: AuditLogEntry) => void): () => void {
    this._auditListeners.add(fn);
    return () => {
      this._auditListeners.delete(fn);
    };
  }

  /** 广播审计条目（AdminService._audit 调用） */
  emitAudit(e: AuditLogEntry): void {
    for (const fn of this._auditListeners) {
      try {
        fn(e);
      } catch {
        /* 订阅者异常不影响审计写入 */
      }
    }
  }
}

/** 全局单例 */
export const logService = new LogService();
