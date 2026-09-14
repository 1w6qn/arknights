import { describe, it, expect, beforeEach, vi } from "vitest";
import { AdminService } from "@ops/admin/admin-service";
import { accountManager } from "@game/modules/account/account-manager";
import type { UserConfig } from "@game/modules/account/account-manager";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { JsonValue } from "@excel/json-value";
import { exists, readJson, writeJson } from "@utils/file";
import { copyFile, mkdir, readFile, readdir, appendFile, rm, writeFile } from "fs/promises";
import { asModel } from "../../helpers";

/**
 * readdir 的「仅文件名」重载视图
 *
 * `fs/promises.readdir` 为多重载声明，`vi.mocked(readdir)` 缺省推导到末位
 * `Dirent[]` 重载；本用例与 AdminService 用的都是无 options 的 `string[]` 重载，
 * 故显式给出单签名类型参数。
 */
type ReaddirNames = (path: string) => Promise<string[]>;

/**
 * accountManager 夹具写入视图
 *
 * `data`/`configs` 是 AccountManager 的公开字段；用例写入的是只含 `_playerdata`
 * 的局部夹具（真实 `PlayerDataManager` 含私有成员，无法结构兼容）。AdminService
 * 只从 `data[uid]._playerdata` 读存档，故按该读取面声明窄视图——真实公开字段与
 * 本视图同形，可直接赋值，无需任何断言。
 */
interface AccountManagerFixtureView {
  data: { [uid: string]: { _playerdata?: PlayerDataModel } };
  configs: { [uid: string]: UserConfig };
}

/** 把 accountManager 视作夹具写入视图（真实字段可赋给本视图） */
function fixtureAccounts(manager: typeof accountManager): AccountManagerFixtureView {
  return manager;
}

/** 夹具写入视图（与 accountManager 同一对象引用） */
const accounts = fixtureAccounts(accountManager);

/**
 * syncGachaPools 写回的卡池详情表读取视图
 *
 * `writeJson` 的形参声明为普通对象类型，用例只读 `details` 一层键，故具名窄视图收口。
 */
interface GachaDetailWriteView {
  details: Record<string, JsonValue>;
}

// 备份/恢复/审计日志：全部文件操作走 mock，不落盘、不读真实存档
vi.mock("@utils/file", () => ({
  exists: vi.fn(),
  size: vi.fn(),
  readJson: vi.fn(),
  writeJson: vi.fn(),
  // config.ts 模块加载时经 readJsonSync 读配置（返回合法对象避免加载崩溃）
  readJsonSync: vi.fn(() => ({
    Host: "http://127.0.0.1",
    PORT: 8443,
    version: { resVersion: "test", clientVersion: "test" },
  })),
}));
vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue({ code: "ENOENT" }),
  readdir: vi.fn().mockRejectedValue({ code: "ENOENT" }),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
// restore 用 new PlayerDataManager 替换内存；mock 类避免真实构造副作用
vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));
// 官服卡池同步 mock（不真实联网）
vi.mock("@ops/admin/official-ops", () => ({
  runGachaSync: vi.fn(),
}));

import { runGachaSync } from "@ops/admin/official-ops";

describe("AdminService 备份/恢复", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    accounts.data = { "1": {} };
    accounts.configs = { "1": asModel<UserConfig>({ uid: "1", auth: { phone: "" } }) };
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    // SQLite 感知读取（方案 A+C：存档主体在库，admin 备份/导出经 readPlayerData）
    vi.spyOn(accountManager, "readPlayerData").mockImplementation(
      async (uid: string) => accounts.data[uid]?._playerdata ?? null,
    );
    // 恢复默认 mock 行为（restoreAllMocks 会清空实现）
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(copyFile).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(readFile).mockRejectedValue({ code: "ENOENT" });
    vi.mocked<ReaddirNames>(readdir).mockRejectedValue({ code: "ENOENT" });
    vi.mocked(exists).mockResolvedValue(true);
  });

  it("backup 应写存档 JSON 到备份目录并返回文件信息", async () => {
    accounts.data["1"] = { _playerdata: asModel<PlayerDataModel>({ status: { uid: "1" } }) };
    const json = JSON.stringify({ status: { uid: "1" } });
    vi.mocked(readFile).mockResolvedValue(Buffer.from(json));
    const info = await service.backup("1");
    expect(info.name).toMatch(/^1-\d{8}-\d{6}\.json$/);
    expect(info.size).toBe(json.length);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("./data/user/backups/" + info.name),
      json,
    );
    expect(mkdir).toHaveBeenCalledWith("./data/user/backups", { recursive: true });
    // 审计日志
    expect(appendFile).toHaveBeenCalled();
  });

  it("backup 对无存档用户应抛错", async () => {
    vi.mocked(exists).mockResolvedValue(false);
    await expect(service.backup("999")).rejects.toThrow(/用户不存在/);
  });

  it("listBackups 应只列出该用户备份并按时间倒序", async () => {
    vi.mocked<ReaddirNames>(readdir).mockResolvedValue([
      "1-20250102000000.json",
      "2-20250101000000.json",
      "readme.txt",
    ]);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("{}"));
    const list = await service.listBackups("1");
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("1-20250102000000.json");
    expect(list[0].ts).toBeGreaterThan(0);
  });

  it("listBackups 备份目录不存在应返回空数组", async () => {
    expect(await service.listBackups("1")).toEqual([]);
  });

  it("cleanBackups 应保留最近 N 个并删除旧备份", async () => {
    vi.mocked<ReaddirNames>(readdir).mockResolvedValue([
      "1-20250101000000.json",
      "1-20250102000000.json",
      "1-20250103000000.json",
    ]);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("{}"));
    vi.mocked(rm).mockResolvedValue(undefined);
    const r = await service.cleanBackups("1", 2);
    expect(r).toEqual({ removed: 1, kept: 2 });
    // 删除的是最旧的（20250101）
    expect(rm).toHaveBeenCalledWith(expect.stringContaining("1-20250101000000.json"));
  });

  it("cleanBackups keep 非法应抛错", async () => {
    await expect(service.cleanBackups("1", -1)).rejects.toThrow(/非负整数/);
  });

  it("restore 应拒绝路径穿越文件名", async () => {
    await expect(service.restore("1", "../../etc/passwd")).rejects.toThrow(
      /非法的备份文件名/,
    );
  });

  it("restore 对不存在备份应抛错", async () => {
    vi.mocked(exists).mockResolvedValue(false);
    await expect(service.restore("1", "1-20250101000000.json")).rejects.toThrow(
      /备份不存在/,
    );
  });

  it("restore 应加载备份替换内存并落盘", async () => {
    const backupData = { status: { uid: "1", nickName: "恢复号" } };
    vi.mocked(readJson).mockResolvedValue(backupData);
    await service.restore("1", "1-20250101000000.json");
    expect(PlayerDataManager).toHaveBeenCalledWith(backupData);
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });
});

describe("AdminService 审计日志", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    vi.mocked(readFile).mockRejectedValue({ code: "ENOENT" });
  });

  it("logs 应解析 JSONL 并返回最新在前", async () => {
    vi.mocked(readFile).mockResolvedValue(
      '{"ts":100,"action":"grantItem","uid":"1","detail":"a"}\n' +
        '{"ts":200,"action":"grantChar","uid":"1","detail":"b"}\n',
    );
    const entries = await service.logs(50);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ ts: 200, action: "grantChar" });
    expect(entries[1]).toMatchObject({ ts: 100, action: "grantItem" });
  });

  it("logs 应跳过损坏行并截断到 limit", async () => {
    vi.mocked(readFile).mockResolvedValue(
      '{"ts":1,"action":"a","uid":"1","detail":"x"}\nbroken-line\n{"ts":2,"action":"b","uid":"1","detail":"y"}\n',
    );
    const entries = await service.logs(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("b");
  });

  it("logs 无日志文件时应返回空数组", async () => {
    expect(await service.logs()).toEqual([]);
  });

  it("clearLogs 应清空日志文件并返回条数", async () => {
    vi.mocked(readFile).mockResolvedValue('{"ts":1,"action":"a","uid":"1","detail":"x"}\n');
    const r = await service.clearLogs("CLEAR");
    expect(r.cleared).toBe(1);
    expect(writeFile).toHaveBeenCalledWith("./data/admin/logs.jsonl", "", "utf8");
  });

  it("clearLogs 缺确认词应拒绝", async () => {
    await expect(service.clearLogs()).rejects.toThrow(/CLEAR/);
  });
});

describe("AdminService 存档导出/导入/校验", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    accounts.data = { "1": {} };
    accounts.configs = { "1": asModel<UserConfig>({ uid: "1", auth: { phone: "" } }) };
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue(Buffer.from("{}"));
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(writeJson).mockResolvedValue(undefined);
  });

  it("exportUser 应读存档并写入目标路径", async () => {
    const data = asModel<PlayerDataModel>({ status: { uid: "1" } });
    accounts.data["1"] = { _playerdata: data };
    const r = await service.exportUser("1", "./tmp/out.json");
    expect(r.path).toBe("./tmp/out.json");
    expect(r.size).toBe(2);
    expect(writeJson).toHaveBeenCalledWith("./tmp/out.json", data);
  });

  it("exportUser 缺省路径应落在 ./exports/ 且带时间戳", async () => {
    accounts.data["1"] = { _playerdata: asModel<PlayerDataModel>({ status: { uid: "1" } }) };
    const r = await service.exportUser("1");
    expect(r.path).toMatch(/^\.\/exports\/1-\d{8}-\d{6}\.json$/);
  });

  it("exportUser 对无存档用户应抛错", async () => {
    await expect(service.exportUser("999")).rejects.toThrow(/用户不存在/);
  });

  it("importUser 应从文件读取并替换指定 uid", async () => {
    const data = { status: { uid: "1" } };
    vi.mocked(readJson).mockResolvedValue(data);
    await service.importUser("./tmp/in.json", "1");
    expect(PlayerDataManager).toHaveBeenCalledWith(data);
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("importUser 缺省 uid 应取文件内 status.uid", async () => {
    vi.mocked(readJson).mockResolvedValue({ status: { uid: "9" } });
    await service.importUser("./tmp/in.json");
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("9");
  });

  it("importUser 对缺少 status.uid 的存档应抛错", async () => {
    vi.mocked(readJson).mockResolvedValue({ troop: {} });
    await expect(service.importUser("./tmp/bad.json")).rejects.toThrow(/status\.uid/);
  });

  it("checkData 应报告异常用户", async () => {
    const good = { _playerdata: asModel<PlayerDataModel>({ status: { uid: "1" }, troop: {} }) };
    const bad = { _playerdata: asModel<PlayerDataModel>({ status: { uid: "2" } }) }; // 缺 troop
    accounts.data = { "1": good, "2": bad };
    const r = await service.checkData();
    expect(r.ok).toBe(false);
    expect(r.users.find((u) => u.uid === "2")!.ok).toBe(false);
    expect(r.users.find((u) => u.uid === "1")!.ok).toBe(true);
  });

  it("checkDataFiles 应校验磁盘全部存档（含未加载/损坏文件）", async () => {
    vi.mocked<ReaddirNames>(readdir).mockResolvedValue(["1.json", "bad.json", "readme.txt"]);
    vi.mocked(readJson).mockImplementation(async (p: string) => {
      if (String(p).includes("bad.json")) return { troop: {} }; // 缺 status
      return { status: { uid: "1" }, troop: {} };
    });
    const r = await service.checkDataFiles();
    expect(r.files).toHaveLength(2); // 只算 .json
    expect(r.files.find((f) => f.uid === "1")!.ok).toBe(true);
    expect(r.files.find((f) => f.uid === "bad")!.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("checkDataFiles 目录不存在应返回空", async () => {
    // restoreAllMocks 不重置模块 mock 的 readdir，显式恢复默认（目录不存在）
    vi.mocked<ReaddirNames>(readdir).mockRejectedValue({ code: "ENOENT" });
    const r = await service.checkDataFiles();
    expect(r.files).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("AdminService 官服卡池同步", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readJson).mockImplementation(async (p: string) => {
      if (String(p).includes("gacha_table")) {
        return { gachaPoolClient: [{ gachaPoolId: "NORM_0_1_3" }, { gachaPoolId: "BAD" }] };
      }
      return { details: { "OLD_POOL": { upCharInfo: null } } };
    });
    vi.mocked(writeJson).mockResolvedValue(undefined);
    vi.mocked(copyFile).mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(runGachaSync).mockResolvedValue([
      { poolId: "NORM_0_1_3", detailInfo: { upCharInfo: { perCharList: [] }, gachaObjList: [] } },
      { poolId: "BAD", error: "官服未返回 detailInfo" },
    ]);
  });

  it("syncGachaPools 应备份旧文件、合并写回、保留未抓取池", async () => {
    const r = await service.syncGachaPools("13800000000", "pwd");
    expect(r).toMatchObject({ total: 2, ok: 1, skipped: 0, updated: 1, failed: [{ poolId: "BAD" }] });
    // 备份旧详情表
    expect(copyFile).toHaveBeenCalledWith(
      "./data/gacha_detail_table.json",
      expect.stringContaining(".bak"),
    );
    // 合并写回：新池更新 + 旧池保留
    const writeCall = vi.mocked(writeJson).mock.calls.find((c) => String(c[0]).includes("gacha_detail"));
    expect(writeCall).toBeDefined();
    const written = writeCall![1] as GachaDetailWriteView;
    expect(written.details["NORM_0_1_3"]).toBeDefined();
    expect(written.details["OLD_POOL"]).toBeDefined(); // 未抓取的旧池保留
    expect(written.details["BAD"]).toBeUndefined(); // 失败的池不写入
    // 审计
    expect(appendFile).toHaveBeenCalled();
  });

  it("syncGachaPools 支持指定 poolIds（不读本地列表）", async () => {
    await service.syncGachaPools("13800000000", "pwd", ["NORM_0_1_3"]);
    expect(runGachaSync).toHaveBeenCalledWith("13800000000", "pwd", ["NORM_0_1_3"]);
  });

  it("syncGachaPools 补全模式应跳过本地已有池", async () => {
    vi.mocked(readJson).mockImplementation(async (p: string) => {
      if (String(p).includes("gacha_table")) {
        return { gachaPoolClient: [{ gachaPoolId: "NORM_0_1_3" }, { gachaPoolId: "NORM_0_1_4" }] };
      }
      return { details: { "NORM_0_1_3": { upCharInfo: null } } };
    });
    vi.mocked(runGachaSync).mockResolvedValue([
      { poolId: "NORM_0_1_4", detailInfo: { upCharInfo: {} } },
    ]);
    const r = await service.syncGachaPools("13800000000", "pwd");
    expect(r.skipped).toBe(1); // NORM_0_1_3 已存在跳过
    expect(runGachaSync).toHaveBeenCalledWith("13800000000", "pwd", ["NORM_0_1_4"]);
  });

  it("syncGachaPools refresh=true 应全量不跳过", async () => {
    vi.mocked(readJson).mockImplementation(async (p: string) => {
      if (String(p).includes("gacha_table")) {
        return { gachaPoolClient: [{ gachaPoolId: "NORM_0_1_3" }] };
      }
      return { details: { "NORM_0_1_3": { upCharInfo: null } } };
    });
    vi.mocked(runGachaSync).mockResolvedValue([
      { poolId: "NORM_0_1_3", detailInfo: { upCharInfo: {} } },
    ]);
    const r = await service.syncGachaPools("13800000000", "pwd", undefined, { refresh: true });
    expect(r.skipped).toBe(0);
    expect(runGachaSync).toHaveBeenCalledWith("13800000000", "pwd", ["NORM_0_1_3"]);
  });

  it("syncGachaPools 缺手机号或密码应抛错", async () => {
    await expect(service.syncGachaPools("", "pwd")).rejects.toThrow(/手机号与密码/);
  });
});

describe("AdminService 删除用户", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    accounts.data = { "1": {}, "2": {} };
    accounts.configs = {
      "1": asModel<UserConfig>({ uid: "1", auth: { phone: "" } }),
      "2": asModel<UserConfig>({ uid: "2", auth: { phone: "" } }),
    };
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(rm).mockClear().mockResolvedValue(undefined);
  });

  it("deleteUser 缺少确认词应拒绝", async () => {
    await expect(service.deleteUser("2")).rejects.toThrow(/DELETE/);
  });

  it("deleteUser 对不存在用户应抛错", async () => {
    await expect(service.deleteUser("999", "DELETE")).rejects.toThrow(/用户不存在/);
  });

  it("deleteUser 不能删除最后一个用户", async () => {
    accounts.data = { "1": {} };
    accounts.configs = { "1": asModel<UserConfig>({ uid: "1", auth: { phone: "" } }) };
    await expect(service.deleteUser("1", "DELETE")).rejects.toThrow(/最后一个用户/);
  });

  it("deleteUser 应删除存档并同步 configs/SQLite", async () => {
    await service.deleteUser("2", "DELETE");
    // deleteAccount（B-2 统一清理）以 force 选项删除存档
    expect(rm).toHaveBeenCalledWith("./data/user/databases/2.json", { force: true });
    expect(accounts.data["2"]).toBeUndefined();
    expect(accounts.configs["2"]).toBeUndefined();
    expect(accountManager.saveUserConfig).toHaveBeenCalled();
  });
});
