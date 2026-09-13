/**
 * SQLite 驱动（默认后端）
 *
 * 包装 Node 24 内置 `node:sqlite`（`DatabaseSync`，同步 API），以 {@link SqlDatabase}
 * 异步门面暴露——同步执行后立即 resolve，不引入额外调度。
 */
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { normalizeParams, toCount } from "../dialect";
import type {
  SqlDatabase,
  SqlParam,
  SqlRunResult,
  SqlStatement,
} from "../types";

/**
 * node:sqlite 绑定值转换
 *
 * 归一化后只剩下 `string|number|bigint|null|Uint8Array`，均属 `SQLInputValue`
 * （`Uint8Array` 是 `NodeJS.ArrayBufferView` 的子类型，故不需要任何断言）。
 */
function bind(params: SqlParam[]): SQLInputValue[] {
  return normalizeParams(params);
}

/** SQLite 预编译语句（同步执行，异步门面） */
class SqliteStatement implements SqlStatement {
  constructor(private _stmt: StatementSync) {}

  /** 查询单行 */
  async get<T = Record<string, unknown>>(
    ...params: SqlParam[]
  ): Promise<T | undefined> {
    return this._stmt.get(...bind(params)) as T | undefined;
  }

  /** 查询多行 */
  async all<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T[]> {
    return this._stmt.all(...bind(params)) as T[];
  }

  /** 执行写操作 */
  async run(...params: SqlParam[]): Promise<SqlRunResult> {
    const r = this._stmt.run(...bind(params));
    return { changes: toCount(r.changes) };
  }
}

/** SQLite 数据库连接（node:sqlite 封装） */
export class SqliteDatabase implements SqlDatabase {
  /** 后端类型 */
  readonly backend = "sqlite" as const;
  /** 底层同步连接 */
  private _db: DatabaseSync;
  /** 事务嵌套深度（SQLite 不支持嵌套 BEGIN，>0 时复用外层事务） */
  private _txDepth = 0;
  /** 连接是否已关闭 */
  private _closed = false;

  /**
   * 打开 SQLite 数据库并确保表结构存在
   * @param file - 数据库文件路径或 ":memory:"
   * @param schemaSql - 建表 DDL（由 database.ts 按后端生成）
   */
  constructor(file: string, schemaSql: string) {
    this._db = new DatabaseSync(file);
    // WAL 模式：回放/结算/社交高频写时不阻塞读（内存库自动回退 memory 模式，无副作用）
    this._db.exec("PRAGMA journal_mode = WAL");
    this._db.exec(schemaSql);
  }

  /** 准备语句 */
  prepare(sql: string): SqlStatement {
    return new SqliteStatement(this._db.prepare(sql));
  }

  /** 执行原始 SQL（可含多条语句） */
  async exec(sql: string): Promise<void> {
    this._db.exec(sql);
  }

  /** 事务（同一连接；嵌套时复用外层事务） */
  async transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    if (this._txDepth > 0) return fn(this);
    this._db.exec("BEGIN");
    this._txDepth++;
    try {
      const result = await fn(this);
      this._db.exec("COMMIT");
      return result;
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    } finally {
      this._txDepth--;
    }
  }

  /** 连接是否仍可用 */
  isOpen(): boolean {
    return !this._closed;
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._db.close();
  }
}
