/**
 * 用户配置仓储
 *
 * 封装 users 表 CRUD：UserConfig 以 JSON 列存储（AccountManager.configs 内存对象整体序列化）。
 * users.json 退化为「首次迁移种子」——首次启动 users 表空时由 {@link migrateUsersFromJsonFile} 导入。
 *
 * 后端无关：冲突处理经 {@link insertReplaceSql} 按后端生成（SQLite `INSERT OR REPLACE` /
 * MySQL `ON DUPLICATE KEY UPDATE` / PostgreSQL `ON CONFLICT DO UPDATE`）。
 */
import { insertReplaceSql, toCount } from "./dialect";
import type { SqlDatabase } from "./types";
import { readJson } from "@utils/file";
import { now } from "@utils/time";
import type { UserConfig } from "@game/modules/account/AccountManager";

/** users 表列顺序 */
const USERS_COLUMNS = ["uid", "data", "updated_ts"];

/**
 * 持久化前剔除社交字段
 *
 * 社交数据（好友/申请/访问）以社交表为唯一事实源（运行时只写该库），
 * users 表若继续存 social 只会残留过期快照——剔除后单事实源，消除双写不一致。
 * @param config - 用户配置
 * @returns 剔除 social 后的配置
 */
function stripSocial(
  config: UserConfig,
): Omit<UserConfig, "social"> & { social?: never } {
  // UserConfig 已无 social 字段；旧种子数据（users.json 解析）可能仍带 social，按 any 剔除
  const { social: _social, ...rest } = config as UserConfig & {
    social?: unknown;
  };
  return rest;
}

export class UserRepository {
  /** @param db - 后端无关的数据库句柄 */
  constructor(private _db: SqlDatabase) {}

  /**
   * 全量读取用户配置
   * @returns uid → UserConfig 映射
   */
  async getAll(): Promise<{ [uid: string]: UserConfig }> {
    const rows = await this._db
      .prepare("SELECT uid, data FROM users")
      .all<{ uid: string; data: string }>();
    const out: { [uid: string]: UserConfig } = {};
    for (const r of rows) out[r.uid] = JSON.parse(r.data);
    return out;
  }

  /**
   * 读取单个用户配置
   * @param uid - 账号 uid
   */
  async get(uid: string): Promise<UserConfig | undefined> {
    const row = await this._db
      .prepare("SELECT data FROM users WHERE uid = ?")
      .get<{ data: string }>(uid);
    return row ? (JSON.parse(row.data) as UserConfig) : undefined;
  }

  /**
   * 插入/覆盖单个用户配置（社交字段不入库——社交表为唯一事实源）
   * @param uid - 账号 uid
   * @param config - 用户配置
   */
  async upsert(uid: string, config: UserConfig): Promise<void> {
    await this._db
      .prepare(insertReplaceSql(this._db.backend, "users", USERS_COLUMNS, ["uid"]))
      .run(uid, JSON.stringify(stripSocial(config)), now());
  }

  /**
   * 全量同步（事务——结果与传入 configs 完全一致，增量执行）
   *
   * 语义：saveUserConfig 保存的是内存 configs 完整集合，删除的账号不应在数据库残留。
   * 实现（B-3）：逐行覆盖写 + 删除不在 configs 的 uid——不再清空整表重插，
   * 账号多时避免表级锁竞争与全表写放大。
   * 社交字段默认不入库（社交表唯一事实源）；keepSocial 仅首次种子迁移（users.json → 社交表
   * 的桥）时用。
   * @param configs - 内存中的完整用户配置集合
   * @param keepSocial - 是否保留 social 字段（仅种子迁移）
   */
  async upsertAll(
    configs: { [uid: string]: UserConfig },
    keepSocial = false,
  ): Promise<void> {
    const upsertSql = insertReplaceSql(
      this._db.backend,
      "users",
      USERS_COLUMNS,
      ["uid"],
    );
    const existing = (
      await this._db.prepare("SELECT uid FROM users").all<{ uid: string }>()
    ).map((r) => r.uid);
    const next = new Set(Object.keys(configs));
    const ts = now();
    const rows = Object.entries(configs);
    await this._db.transaction(async (tx) => {
      const stmt = tx.prepare(upsertSql);
      for (const [uid, config] of rows) {
        await stmt.run(
          uid,
          JSON.stringify(keepSocial ? config : stripSocial(config)),
          ts,
        );
      }
      const delStmt = tx.prepare("DELETE FROM users WHERE uid = ?");
      for (const uid of existing) {
        if (!next.has(uid)) await delStmt.run(uid);
      }
    });
  }

  /** 用户数量 */
  async count(): Promise<number> {
    const row = await this._db
      .prepare("SELECT COUNT(*) AS n FROM users")
      .get<{ n: unknown }>();
    return toCount(row?.n);
  }
}

/**
 * 从 users.json 迁移用户配置到数据库（幂等：users 表非空跳过）
 * @param repo - 用户仓储
 * @returns 导入的用户数（跳过返回 0）
 */
export async function migrateUsersFromJsonFile(
  repo: UserRepository,
): Promise<number> {
  if ((await repo.count()) > 0) return 0;
  let json: { [uid: string]: UserConfig };
  try {
    json = await readJson<{ [uid: string]: UserConfig }>("./data/user/users.json");
  } catch {
    return 0;
  }
  await repo.upsertAll(json, true); // keepSocial：种子带 social，供首次 migrateFromUserConfigs 导入社交表
  return Object.keys(json).length;
}
