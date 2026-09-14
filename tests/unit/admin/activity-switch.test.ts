import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AdminService } from "@ops/admin/admin-service";
import { accountManager } from "@game/modules/account/account-manager";
import { readJsonSync, writeJson } from "@utils/file";
import config from "@core/config/index";
import type { UserConfig } from "@game/modules/account/account-manager";
import { mockPlayerData, asPlayerManager, asModel } from "../../helpers";

/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock {
  name?: string;
}

/** excel mock 干员行形状（本文件不提供数据，仅占位） */
interface ExcelCharRowMock {
  name?: string;
  rarity?: string | number;
}

// 配置读写走 mock（不落盘真实 data/config.json）
vi.mock("@utils/file", () => ({
  exists: vi.fn(),
  size: vi.fn(),
  readJson: vi.fn(),
  writeJson: vi.fn().mockResolvedValue(undefined),
  readJsonSync: vi.fn(() => ({
    Host: "http://127.0.0.1",
    PORT: 8443,
    version: { resVersion: "test", clientVersion: "test" },
  })),
}));

vi.mock("@excel/excel", () => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): ExcelCharRowMock | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): ExcelRowMock | undefined { return this.StageTable?.stages?.[stageId]; },

    // 本文件不提供的表也显式占位，否则门面方法的 `this.XxxTable` 报 TS2339
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    CharacterTable: undefined as Record<string, ExcelCharRowMock> | undefined,

    ActivityTable: {
      basicInfo: {
        act5d0: {
          id: "act5d0", type: "TYPE_ACT5D0", name: "火蓝之心·复刻", displayType: "SIDESTORY",
          startTime: 1597132800, endTime: 1597953599, rewardEndTime: 1598299199,
        },
        act6bossrush: {
          id: "act6bossrush", type: "BOSS_RUSH", name: "引航者试炼", displayType: "BOSS_RUSH",
          startTime: 1766692800, endTime: 1767902399, rewardEndTime: 1768161599,
        },
        // null 占位条目（真实数据含 20/331）——list/switch 必须跳过不崩溃
        __null__: null,
      },
      missionGroup: [],
      missionData: [],
      activity: {},
    },
    StageTable: { stages: {} as Record<string, ExcelRowMock> },
  },
}));

vi.mock("@game/kernel/player-data-manager", () => ({ PlayerDataManager: vi.fn() }));
vi.mock("@ops/admin/official-ops", () => ({ runGachaSync: vi.fn() }));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    appendFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

describe("AdminService 活动切换（activity switch）", () => {
  let service: AdminService;
  const original = config.developer;
  const originalActivities = config.activities;

  afterEach(() => {
    config.developer = original;
    config.activities = originalActivities;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    accountManager.data = { "1": asPlayerManager(mockPlayerData({ status: { uid: 1 } })) };
    accountManager.configs = { "1": asModel<UserConfig>({ uid: "1", auth: { phone: "" } }) };
    vi.mocked(readJsonSync).mockReturnValue({
      Host: "http://127.0.0.1",
      PORT: 8443,
      version: { resVersion: "test", clientVersion: "test" },
    });
    vi.mocked(writeJson).mockResolvedValue(undefined);
  });

  it("switchActivity(-1) 恢复真实时间：持久化配置并热生效", async () => {
    const r = await service.switchActivity(-1);
    expect(r.ok).toBe(true);
    expect(r.effectiveTs).toBeCloseTo(Math.floor(Date.now() / 1000), 1);
    // 持久化：writeJson 收到含 developer.timestamp=-1 的配置
    expect(writeJson).toHaveBeenCalledWith(
      "./data/config.json",
      expect.objectContaining({ developer: { timestamp: -1 } }),
    );
    // 内存 config 同步（unlockActivity/userTimestamp 立即生效）
    expect(config.developer).toEqual({ timestamp: -1 });
  });

  it("switchActivity(过去时间戳) 冻结并返回打开活动数", async () => {
    const r = await service.switchActivity(1597132800);
    expect(r.ok).toBe(true);
    expect(r.effectiveTs).toBe(1597132800);
    // act5d0 窗口内 → openCount 至少 1
    expect(r.openCount).toBeGreaterThanOrEqual(1);
    expect(config.developer).toEqual({ timestamp: 1597132800 });
  });

  it("switchActivity(未来时间戳) 拒绝", async () => {
    await expect(service.switchActivity(Math.floor(Date.now() / 1000) + 99999)).rejects.toThrow(
      "不能设置未来时间",
    );
  });

  it("switchActivity 非法值拒绝", async () => {
    await expect(service.switchActivity(NaN)).rejects.toThrow("时间戳非法");
  });

  it("listActivities 按生效时间戳判定 open，冻结模式标记 usingOverride", async () => {
    config.developer = { timestamp: 1597132800 };
    const list = await service.listActivities();
    expect(list.usingOverride).toBe(true);
    expect(list.effectiveTs).toBe(1597132800);
    const act5d0 = list.activities.find((a) => a.id === "act5d0");
    const boss = list.activities.find((a) => a.id === "act6bossrush");
    expect(act5d0?.open).toBe(true);
    expect(boss?.open).toBe(false);
  });

  it("listActivities 真实时间模式 usingOverride=false", async () => {
    config.developer = { timestamp: -1 };
    const list = await service.listActivities();
    expect(list.usingOverride).toBe(false);
  });

  it("switchActivity 对象参数：强制开启活动忽略时间窗口并计入 openCount", async () => {
    const r = await service.switchActivity({ forceOpen: ["act6bossrush"] });
    expect(r.ok).toBe(true);
    expect(r.forceOpen).toEqual(["act6bossrush"]);
    // act6bossrush 时间窗口未到（open=false），强制开启后计入 openCount
    expect(r.openCount).toBeGreaterThanOrEqual(1);
    // 持久化配置含 activities.forceOpen
    expect(writeJson).toHaveBeenCalledWith(
      "./data/config.json",
      expect.objectContaining({
        activities: expect.objectContaining({ forceOpen: ["act6bossrush"] }),
      }),
    );
    // 内存同步
    expect(config.activities?.forceOpen).toEqual(["act6bossrush"]);
  });

  it("switchActivity 强制开启不存在的活动拒绝（含近似提示）", async () => {
    await expect(service.switchActivity({ forceOpen: ["act5d0x"] })).rejects.toThrow(
      /疑似应为 act5d0/,
    );
  });

  it("switchActivity 合约赛季文件不存在拒绝", async () => {
    await expect(service.switchActivity({ crisisV1: "cc999" })).rejects.toThrow(
      /危机合约V1赛季 cc999 不存在/,
    );
  });

  it("switchActivity 清空强制开启（forceOpen: []）", async () => {
    const r = await service.switchActivity({ forceOpen: [] });
    expect(r.forceOpen).toEqual([]);
  });

  it("listActivities 返回强制开启标记与合约赛季配置", async () => {
    config.developer = { timestamp: -1 };
    config.activities = { forceOpen: ["act5d0"], crisisV1: "cc1", crisisV2: "cc1", autoBackfill: true };
    const list = await service.listActivities();
    const act5d0 = list.activities.find((a) => a.id === "act5d0");
    expect(act5d0?.forced).toBe(true);
    const boss = list.activities.find((a) => a.id === "act6bossrush");
    expect(boss?.forced).toBe(false);
    expect(list.forceOpen).toEqual(["act5d0"]);
    expect(list.crisisV1).toBe("cc1");
    expect(list.crisisSeasons.v1.length).toBeGreaterThan(0);
    expect(list.autoBackfill).toBe(true);
  });
});
