import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SCHEMA_SQL, openDatabase, closeDatabase } from "@core/db/database";
import type { SqlDatabase } from "@core/db/types";
import { FriendRepository } from "@core/db/friend-repo";
import { migrateFromUserConfigs } from "@core/db/migrate";
import { accountManager } from "@game/modules/account/account-manager";
import type { UserConfig } from "@game/modules/account/account-manager";
import { asModel } from "../../helpers";

/**
 * 迁移用例的遗留配置视图
 *
 * 旧 users.json 内嵌 `social`（迁移模块按同款遗留形状读取，见 app/core/db/migrate.ts:18 的
 * `UserConfig & { social?: LegacyUserConfigSocial }`）；UserConfig 已不再声明该字段，
 * 而本用例沿用历史夹具（其真值性被被测实现读取，改值即改运行期夹具数据），
 * 故就地声明该键的读写视图。
 */
interface LegacyUserConfig extends UserConfig {
  social?: {
    friends?: { uid: string; alias?: string }[];
    friendRequests?: string[];
    visited?: string[];
  };
}

describe("社交数据迁移", () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.exec(SCHEMA_SQL);
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it("应从 users.json 的 social 字段迁移好友/申请/访问记录", async () => {
    accountManager.configs = {
      "1": asModel<LegacyUserConfig>({
        uid: "1",
        social: {
          friends: [
            { uid: "2", alias: "阿米娅" },
            { uid: "3", alias: "" },
          ],
          friendRequests: ["4"],
          visited: ["5"],
        },
      }),
      "2": asModel<LegacyUserConfig>({ uid: "2", social: { friends: [], friendRequests: [], visited: [] } }),
    };

    await migrateFromUserConfigs(db, accountManager.configs);

    const repo = new FriendRepository(db);
    expect(await repo.getFriendList("1")).toEqual([
      { uid: "2", alias: "阿米娅" },
      { uid: "3", alias: "" },
    ]);
    expect(await repo.getFriendRequests("1")).toEqual(["4"]);
    expect(await repo.getVisited("1")).toEqual(["5"]);
    // 迁移后 JSON 中的 social 被重置为空结构（社交表为唯一事实源）
    expect((accountManager.configs["1"] as LegacyUserConfig).social).toEqual({
      friends: [],
      friendRequests: [],
      visited: [],
    });
  });

  it("configs 缺失 social 字段时不应报错", async () => {
    accountManager.configs = { "1": asModel<LegacyUserConfig>({ uid: "1" }) };
    await expect(
      migrateFromUserConfigs(db, accountManager.configs),
    ).resolves.toBeUndefined();
  });
});
