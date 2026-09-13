/**
 * 抓包索引数据库（SQLite）
 *
 * 统一抓包存储的元数据索引（Node 24 内置 node:sqlite，零第三方依赖）。
 * 数据库只存元数据（时间/路径/状态/来源/body 文件引用），
 * 请求/响应体以文件形式存放在 records/{rid}/ 目录（避免大响应膨胀 DB）。
 *
 * 默认位置：tmp/capture/index.db（gitignored；测试经 captureManager.configure 注入临时目录）。
 */
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";

/** 索引数据库文件名（存储根目录下） */
export const CAPTURE_DB_FILENAME = "index.db";

/** 建表 SQL（幂等；user_version 供未来 schema 迁移判断） */
export const CAPTURE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  source     TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rid           TEXT NOT NULL UNIQUE,
  session_id    TEXT,
  ts            INTEGER NOT NULL,
  method        TEXT,
  path          TEXT,
  query         TEXT,
  module        TEXT,
  endpoint      TEXT,
  status        INTEGER,
  latency_ms    REAL,
  source        TEXT NOT NULL,
  direction     TEXT NOT NULL DEFAULT 'http',
  req_headers   TEXT,
  req_body_type TEXT NOT NULL DEFAULT 'none',
  req_body_file TEXT,
  req_size      INTEGER,
  res_headers   TEXT,
  res_body_type TEXT NOT NULL DEFAULT 'none',
  res_body_file TEXT,
  res_size      INTEGER,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_rec_ts      ON records(ts);
CREATE INDEX IF NOT EXISTS idx_rec_path    ON records(path);
CREATE INDEX IF NOT EXISTS idx_rec_module  ON records(module);
CREATE INDEX IF NOT EXISTS idx_rec_status  ON records(status);
CREATE INDEX IF NOT EXISTS idx_rec_source  ON records(source);
CREATE INDEX IF NOT EXISTS idx_rec_session ON records(session_id);
CREATE INDEX IF NOT EXISTS idx_rec_direction ON records(direction);

PRAGMA user_version = 1;
`;

/**
 * 打开抓包索引数据库（建目录由调用方负责）
 *
 * @param dbPath - 数据库文件路径（测试可传临时目录下的路径）
 * @returns 已建表的 DatabaseSync 连接
 */
export function openCaptureDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // WAL：抓包高频写入时不阻塞读（内存库自动回退 memory 模式）
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(CAPTURE_SCHEMA_SQL);
  return db;
}

/**
 * 查询多行并按调用点声明的行类型返回
 *
 * `node:sqlite` 的 `StatementSync.all()` 声明为 `Record<string, SQLOutputValue>[]`——
 * 列名与行类型的对应关系由 SQL 决定，TS 无从校验。本函数是抓包索引库**唯一**的
 * 「列 → 行类型」断言点，调用点不再各自写 `as unknown as X[]`（逃逸点棘轮禁止新增）。
 * @param stmt - 预编译语句（调用点用 `prepare(sql)` 取得）
 * @param params - 绑定参数（占位符统一 `?`）
 * @returns 行数组（类型由调用点给出，形如 `allRows<CaptureSession>(stmt)`）
 */
export function allRows<T>(stmt: StatementSync, ...params: SQLInputValue[]): T[] {
  return stmt.all(...params) as T[];
}
