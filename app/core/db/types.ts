/**
 * 数据库后端抽象层：类型契约
 *
 * 主数据层（原 `data/user/social.db`）支持三种后端：
 * - `sqlite`（缺省）：Node 24 内置 `node:sqlite`，零第三方依赖，单文件本地库；
 * - `mysql` / `postgresql`：可选后端，驱动（mysql2 / pg）按需动态加载，
 *   未安装且未选用时对启动零影响。
 *
 * 仓储层只依赖本文件的 {@link SqlDatabase} 接口，不感知具体后端——切换后端只改配置。
 *
 * 接口为**异步**：`node:sqlite` 是同步 API，但 mysql2 / pg 只能异步，故统一以 Promise
 * 暴露，三种驱动行为一致（SQLite 驱动内部同步执行后立即 resolve，无额外开销）。
 * 参数占位符统一写 `?`（PostgreSQL 驱动内部改写为 `$n`）。
 */
import type { JsonValue } from "@utils/json-value";

/** 支持的数据库后端类型 */
export type DatabaseBackend = "sqlite" | "mysql" | "postgresql";

/**
 * SQL 绑定参数（三后端公共子集）
 *
 * `Uint8Array` 覆盖 BLOB/BYTEA 二进制列（`Buffer` 是其子类，可直接传入）。
 * `undefined` 由驱动统一归一化为 `null`——node:sqlite 拒绝绑定 undefined。
 */
export type SqlParam =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Uint8Array;

/**
 * 归一化后的绑定值（{@link import("./dialect").normalizeParams} 的输出）
 *
 * 三种驱动均可直接绑定：\`boolean\`/\`undefined\` 已在归一化阶段消除。
 */
export type SqlBindValue = string | number | bigint | null | Uint8Array;

/** 写操作结果 */
export interface SqlRunResult {
  /** 受影响行数（MySQL 的 ON DUPLICATE KEY UPDATE 语义下 1=插入、2=更新） */
  changes: number;
}

/** 预编译语句门面（占位符统一用 `?`） */
export interface SqlStatement {
  /** 查询单行（无结果返回 undefined） */
  get<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T | undefined>;
  /** 查询多行（无结果返回空数组） */
  all<T = Record<string, unknown>>(...params: SqlParam[]): Promise<T[]>;
  /** 执行写操作 */
  run(...params: SqlParam[]): Promise<SqlRunResult>;
}

/** 数据库连接门面（多后端统一） */
export interface SqlDatabase {
  /** 后端类型（仓储层据此方言分支与日志） */
  readonly backend: DatabaseBackend;
  /** 准备一条语句（占位符统一 `?`） */
  prepare(sql: string): SqlStatement;
  /** 执行原始 SQL——可含多条语句（建表 DDL / 迁移用） */
  exec(sql: string): Promise<void>;
  /**
   * 事务：`fn` 内所有语句在同一连接上执行，`fn` 抛错自动回滚。
   *
   * 嵌套调用复用外层事务（SQLite / MySQL 不支持嵌套 BEGIN），此时内层不作为
   * 独立事务边界——语义与 SQLite 原 `BEGIN`/`COMMIT` 手写实现一致。
   * @param fn - 事务体，接收绑定到同一连接的数据库句柄
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
  /** 关闭连接（SQLite 关连接；MySQL/PG 关闭连接池） */
  close(): Promise<void>;
  /**
   * 连接是否仍可用
   *
   * `close()` 后为 `false`。{@link import("./database").openDatabase} 复用单例前据此
   * 判定——避免把已关闭的连接交回调用方（测试逐个用例关闭连接的场景）。
   */
  isOpen(): boolean;
}

/** SQLite 后端配置 */
export interface SqliteDatabaseOptions {
  /** 后端类型 */
  backend: "sqlite";
  /** 数据库文件路径（缺省 ./data/user/social.db；测试传 ":memory:"） */
  file?: string;
}

/** 网络型后端（MySQL / PostgreSQL）公共配置 */
export interface NetworkDatabaseOptions {
  /** 后端类型 */
  backend: "mysql" | "postgresql";
  /** 主机（缺省 127.0.0.1） */
  host?: string;
  /** 端口（缺省：mysql 3306 / postgresql 5432） */
  port?: number;
  /** 用户名（缺省 root / postgres） */
  user?: string;
  /** 密码（缺省空串） */
  password?: string;
  /** 库名（缺省 arknights——须已存在，本层只建表不建库） */
  database?: string;
  /** 连接池最大连接数（缺省 10） */
  connectionLimit?: number;
  /** SSL 配置（透传驱动；true 使用默认 TLS） */
  ssl?: boolean | Record<string, unknown>;
  /** 连接建表字符集（仅 mysql；缺省 utf8mb4——中文/emoji 兼容） */
  charset?: string;
}

/** 数据库连接配置（三种后端联合类型） */
export type DatabaseOptions = SqliteDatabaseOptions | NetworkDatabaseOptions;

/**
 * 用户配置（users 表持久化形状，JSON 列）
 *
 * 存储账号认证、战斗、抽卡等配置。**社交数据不在其中**——好友/申请/访问以 social.db
 * 为唯一事实源；回放与结算信息亦已独立成表（replays / battle_infos / battle_records），
 * `battle` 只保留 `stageId`。
 *
 * 位置：2026-09-13 由 `app/game/modules/account/AccountManager.ts` 下沉 `core/db/types`——
 * `core/db/user-repo.ts` 与 `core/db/migrate.ts` 需要它，而 core 不得依赖 game（R1）。
 * `AccountManager` 仍 re-export 该类型以兼容存量引用点。
 */
export interface UserConfig {
  /** 账号 uid（字符串） */
  uid: string;
  /** 密码（哈希后存储；兼容历史明文） */
  password: string;
  /** 账号密钥（参考 DoctoratePy：MD5(phone + 渠道密钥)，真实模式 token 用） */
  secret?: string;
  /** 是否禁用（Dashboard 删除/禁用用户；禁用后无法登录/鉴权） */
  disabled?: boolean;
  /** 认证信息（官服协议形状） */
  auth: {
    hgId: string;
    phone: string;
    email: string;
    identityNum: string;
    identityName: string;
    isMinor: false;
    isLatestUserAgreement: true;
  };
  /** 战斗配置（仅关卡进度；回放/结算信息见独立表） */
  battle: {
    stageId: string;
  };
  /** 抽卡保底计数（按卡池 key） */
  gacha: {
    [key: string]: {
      beforeNonHitCnt: number;
    };
  };
  /** 肉鸽存档快照（服务端自定义；未建模 JSON，索引/取值均须显式收窄） */
  rlv2: JsonValue;
}
