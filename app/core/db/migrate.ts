/**
 * 社交数据迁移模块
 *
 * 首次创建数据库时，将 users.json 中每个用户的 social 字段
 * （friends / friendRequests / visited）导入社交表，
 * 之后 JSON 中的 social 字段不再作为数据源（重置为空结构）。
 */
import { FriendRepository } from "./friend-repo";
import type { SqlDatabase } from "./types";
import type { UserConfig } from "./types";

/**
 * UserConfig 的历史遗留社交字段（旧 users.json 内嵌 friends/friendRequests/visited）
 *
 * 社交表（social.db）为唯一事实源后 UserConfig 不再声明 social；本次一次性迁移
 * 仍按遗留形状读取，并把 JSON 侧重置为空结构。
 */
interface LegacyUserConfigSocial {
  friends?: { uid: string; alias?: string }[];
  friendRequests?: string[];
  visited?: string[];
}

/**
 * 从用户配置迁移社交数据到数据库，并重置 JSON 中的 social 字段
 * @param db - 数据库句柄（后端无关）
 * @param configs - accountManager.configs（user 配置映射）
 */
export async function migrateFromUserConfigs(
  db: SqlDatabase,
  configs: { [key: string]: UserConfig },
): Promise<void> {
  const repo = new FriendRepository(db);
  for (const uid of Object.keys(configs)) {
    const config = configs[uid] as UserConfig & { social?: LegacyUserConfigSocial };
    const social = config.social;
    if (!social) continue;

    for (const friend of social.friends ?? []) {
      await repo.addFriend(uid, friend.uid, friend.alias ?? "");
    }
    for (const fromUid of social.friendRequests ?? []) {
      await repo.sendFriendRequest(fromUid, uid);
    }
    for (const visitedUid of social.visited ?? []) {
      await repo.addVisit(uid, visitedUid);
    }
    // 重置 JSON 中的社交字段（社交表为唯一事实源）
    config.social = { friends: [], friendRequests: [], visited: [] };
  }
}
