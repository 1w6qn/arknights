import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, SCHEMA_SQL, closeDatabase } from "@core/db/database";
import type { SqlDatabase } from "@core/db/types";
import { ReplayRepository } from "@core/db/replay-repo";
import { AccountManager } from "@game/modules/account/account-manager";
import type { UserConfig } from "@game/modules/account/account-manager";
import { BattleStore } from "@game/kernel/battle-store";
import { asModel } from "../../helpers";

/**
 * AccountManager 战斗回放独立存储（R4）
 *
 * saveBattleReplay 写 replays 表（不再改写 configs/users 表），
 * getBattleReplay 从 replays 表读回——大字符串不参与用户配置全量保存。
 */
describe("AccountManager 回放独立存储", () => {
  let manager: AccountManager;
  let db: SqlDatabase;

  beforeEach(async () => {
    vi.restoreAllMocks();
    db = await openDatabase(":memory:");
    await db.exec(SCHEMA_SQL);
    manager = new AccountManager();
    manager._battleStore = new BattleStore(new ReplayRepository(db));
    // 夹具只声明被测分支读到的键（UserConfig 的其余字段由 asModel 的深可选视图放宽）
    manager.configs = { "1": asModel<UserConfig>({ uid: "1", password: "p" }) };
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it("saveBattleReplay 写 replays 表；configs 不再携带回放", async () => {
    const saveConfigSpy = vi
      .spyOn(manager, "saveUserConfig")
      .mockResolvedValue(undefined);
    await manager.saveBattleReplay("1", "st_01", "BASE64==");
    // configs 不被改写（回放不入配置）
    expect(manager.configs["1"]?.battle).toBeUndefined();
    // 读回走 replays 表
    expect(await manager.getBattleReplay("1", "st_01")).toBe("BASE64==");
    // 不再触发全量配置保存（每次战斗回放不重写 users 表）
    expect(saveConfigSpy).not.toHaveBeenCalled();
  });

  it("saveBattleInfo 写 battle_infos 表；configs 不携带结算信息（A3）", async () => {
    const saveConfigSpy = vi
      .spyOn(manager, "saveUserConfig")
      .mockResolvedValue(undefined);
    const info = { stageId: "st_01", isPractice: 0, squad: { slots: [] } };
    await manager.saveBattleInfo("1", "battle_001", info);
    // configs 不被改写
    expect(manager.configs["1"]?.battle).toBeUndefined();
    // 读回走 battle_infos 表
    expect(await manager.getBattleInfo("1", "battle_001")).toEqual(info);
    expect(await manager.getBattleInfo("1", "missing")).toBeUndefined();
    // 不再触发全量配置保存（每次战斗结算不重写 users 表）
    expect(saveConfigSpy).not.toHaveBeenCalled();
  });
});
