import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, SCHEMA_SQL, closeDatabase } from "@core/db/database";
import type { SqlDatabase } from "@core/db/types";
import { UserRepository, migrateUsersFromJsonFile } from "@core/db/user-repo";
import type { UserConfig } from "@game/modules/account/account-manager";
import { asModel } from "../../helpers";

/**
 * 用户配置仓储用例的遗留夹具视图
 *
 * users.json 旧种子带 `social` 与内嵌 `battle.replays/infos`（社交/回放已迁出为独立表，
 * 见 app/core/db/user-repo.ts#stripSocial 与 AccountManager 的迁移注释）；UserConfig 已不声明
 * 这些键，而本用例沿用历史夹具（其真值性被被测实现读取，改值即改运行期夹具数据），
 * 故就地声明其读写视图。
 */
interface LegacyUserConfigFixture extends UserConfig {
  social?: {
    friends?: { uid: string; alias?: string }[];
    friendRequests?: string[];
    visited?: string[];
  };
  battle: {
    stageId: string;
    replays?: Record<string, string>;
    infos?: Record<string, string>;
  };
}

const fileMock = vi.hoisted(() => ({ readJson: vi.fn() }));
vi.mock("@utils/file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@utils/file")>();
  return { ...actual, readJson: fileMock.readJson };
});

describe("UserRepository", () => {
  let repo: UserRepository;
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.exec(SCHEMA_SQL);
    repo = new UserRepository(db);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it("upsert 后 getAll 应回读完整 UserConfig（JSON 往返）", async () => {
    const conf = asModel<LegacyUserConfigFixture>({
      uid: "1",
      password: "p",
      secret: "s",
      auth: {
        hgId: "1",
        phone: "1",
        email: "",
        identityNum: "d",
        identityName: "d",
        isMinor: false,
        isLatestUserAgreement: true,
      },
      social: { friends: [], friendRequests: [], visited: [] },
      battle: { stageId: "", replays: { act35side_09: "BASE64==" }, infos: {} },
      gacha: { NORMAL: { beforeNonHitCnt: 4 } },
      rlv2: {},
    });
    await repo.upsert("1", conf);
    const persisted = (await repo.getAll())["1"];
    // 社交字段不入库（社交表为唯一事实源——R3）
    const { social: _social, ...expected } = conf;
    expect(persisted).toEqual(expected);
    expect((persisted as LegacyUserConfigFixture).social).toBeUndefined();
    await expect(repo.count()).resolves.toBe(1);
  });

  it("upsertAll 默认剔除 social（社交单事实源）", async () => {
    await repo.upsertAll({
      "1": asModel<LegacyUserConfigFixture>({
        uid: "1",
        password: "p",
        social: { friends: [{ uid: "2", alias: "" }], friendRequests: [], visited: [] },
      }),
    });
    const persisted = (await repo.getAll())["1"] as LegacyUserConfigFixture;
    expect(persisted.social).toBeUndefined();
    expect(persisted.uid).toBe("1");
  });

  it("upsertAll keepSocial=true 保留 social（首次种子迁移 → 社交表的桥）", async () => {
    await repo.upsertAll(
      {
        "1": asModel<LegacyUserConfigFixture>({
          uid: "1",
          social: { friends: [{ uid: "2", alias: "" }], friendRequests: [], visited: [] },
        }),
      },
      true,
    );
    const persisted = (await repo.getAll())["1"] as LegacyUserConfigFixture;
    expect(persisted.social).toEqual({
      friends: [{ uid: "2", alias: "" }],
      friendRequests: [],
      visited: [],
    });
  });

  it("upsertAll 应事务全量覆盖（旧 uid 不残留）", async () => {
    await repo.upsertAll({ "1": asModel<UserConfig>({ uid: "1" }), "2": asModel<UserConfig>({ uid: "2" }) });
    await expect(repo.count()).resolves.toBe(2);
    await repo.upsertAll({ "1": asModel<UserConfig>({ uid: "1", password: "new" }) });
    await expect(repo.count()).resolves.toBe(1);
    expect((await repo.getAll())["1"].password).toBe("new");
  });

  it("get 不存在返回 undefined", async () => {
    await expect(repo.get("999")).resolves.toBeUndefined();
  });

  it("get 存在返回对应 UserConfig", async () => {
    await repo.upsert("7", asModel<UserConfig>({ uid: "7", password: "x" }));
    expect((await repo.get("7"))?.password).toBe("x");
  });
});

describe("migrateUsersFromJsonFile", () => {
  let repo: UserRepository;

  beforeEach(async () => {
    fileMock.readJson.mockReset();
    const db = await openDatabase(":memory:");
    await db.exec(SCHEMA_SQL);
    repo = new UserRepository(db);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it("users 表空时应从 users.json 导入", async () => {
    fileMock.readJson.mockResolvedValue({
      "1": { uid: "1", password: "p1" },
      "2": { uid: "2", password: "p2" },
    });
    const n = await migrateUsersFromJsonFile(repo);
    expect(n).toBe(2);
    await expect(repo.count()).resolves.toBe(2);
    expect((await repo.getAll())["2"].password).toBe("p2");
  });

  it("users 表非空时应跳过（幂等）", async () => {
    await repo.upsert("9", asModel<UserConfig>({ uid: "9" }));
    const n = await migrateUsersFromJsonFile(repo);
    expect(n).toBe(0);
    await expect(repo.get("9")).resolves.toBeDefined();
    await expect(repo.count()).resolves.toBe(1);
  });

  it("users.json 不存在时返回 0 不抛错", async () => {
    fileMock.readJson.mockRejectedValue(new Error("ENOENT"));
    const n = await migrateUsersFromJsonFile(repo);
    expect(n).toBe(0);
  });
});
