import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JsonValue } from "@excel/json-value";
import type { UserConfig } from "@game/modules/account/account-manager";
import { asModel } from "../../helpers";

// databases 存档写入 mock（防真实落盘）；账号注册走 SQLite（:memory:）
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, writeFile: vi.fn().mockResolvedValue(undefined) };
});

import { openDatabase, closeDatabase } from "@core/db/database";
import { UserRepository } from "@core/db/user-repo";
import { registerImportedUser } from "../../../scripts/official-register";
import type { OfficialPlayerData } from "../../../scripts/official-api";

/** 库内账号行读取视图（R3：社交字段不入 users 表；`uid` 为与 UserConfig 的共同属性） */
interface UserRowSocialView {
  uid?: string;
  social?: JsonValue;
}

/** 构造官服玩家数据夹具（`OfficialPlayerData` 只建模 `status`，其余顶层键透传） */
function convertedOfficial(status: { uid: string; nickName: string }): OfficialPlayerData {
  return { status };
}

describe("registerImportedUser", () => {
  let repo: UserRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    // 单例连接指向内存库（registerImportedUser 内部 openDatabase() 复用）
    const db = await openDatabase(":memory:");
    repo = new UserRepository(db);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it("应生成新 uid 并注册账号（写 SQLite users 表）", async () => {
    await repo.upsert("1", asModel<UserConfig>({ uid: "1", password: "p" }));
    const result = await registerImportedUser({
      phone: "13800000000",
      officialUid: "10001",
      convertedData: convertedOfficial({ uid: "2", nickName: "A" }),
    });
    expect(result.uid).toBe("2");
    // 存档写入（databases/2.json）
    const { writeFile } = await import("fs/promises");
    const writeFileMock = vi.mocked(writeFile);
    const saveCall = writeFileMock.mock.calls.find((c) => String(c[0]).includes("databases"));
    expect(saveCall).toBeDefined();
    expect(JSON.parse(String(saveCall![1])).status.uid).toBe("2");
    // SQLite 注册（社交字段不入库——social.db 为唯一事实源 R3）
    const users = await repo.getAll();
    expect(users["2"].auth.phone).toBe("13800000000");
    expect(users["2"].auth.hgId).toBe("10001");
    expect((users["2"] as UserRowSocialView).social).toBeUndefined();
  });

  it("连续注册应递增 uid（基于库内现有账号）", async () => {
    await repo.upsert("1", asModel<UserConfig>({ uid: "1", password: "p" }));
    await registerImportedUser({
      phone: "13800000000",
      officialUid: "10001",
      convertedData: convertedOfficial({ uid: "2", nickName: "A" }),
    });
    const result = await registerImportedUser({
      phone: "13800000001",
      officialUid: "10002",
      convertedData: convertedOfficial({ uid: "3", nickName: "B" }),
    });
    expect(result.uid).toBe("3");
  });
});
