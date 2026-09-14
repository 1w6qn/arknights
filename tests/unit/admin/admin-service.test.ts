import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { AdminService } from "@ops/admin/admin-service";
import { accountManager } from "@game/modules/account/account-manager";
import type { UserConfig } from "@game/modules/account/account-manager";
import { mailManager } from "@game/modules/mail/mail-manager";
import type { MailItem } from "@game/modules/mail/mail.model";
import { mockPlayerData, asModel, asPlayerManager } from "../../helpers";
import type { MockPlayerDataManager, MockStatusManager } from "../../helpers";
import type { PlayerCharacter, PlayerDataModel } from "@game/kernel/playerdata";
import type { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import type { ItemBundle } from "@excel/excel";
import config from "@core/config/index";
import { appendFile, mkdir } from "fs/promises";
import { runMigration } from "../../../scripts/migrate-official";
import { runOfficialAction, runOfficialCall, uploadPixelArtBatch as uploadPixelArtBatchMock, getPixelArtList as getPixelArtListMock, deletePixelArt as deletePixelArtMock } from "@ops/admin/official-ops";

/** excel mock 物品/关卡行形状（本文件用到的字段即可） */
interface ExcelRowMock {
  name?: string;
  classifyType?: string;
  sortId?: number;
}

/** excel mock 干员行形状（名称解析/等级相位/技能） */
interface ExcelCharRowMock {
  name?: string;
  rarity?: number;
  maxPotentialLevel?: number;
  phases?: { maxLevel?: number }[];
  skills?: { skillId?: string }[];
}

/**
 * UserConfig 夹具视图
 *
 * 历史夹具带 `social` 字段（UserConfig 已移除该键，社交数据以 social.db 为唯一源）；
 * 按可选字段放宽以保留夹具原值，其余字段（含 `auth`/`gacha`）仍受 UserConfig 约束。
 */
interface UserConfigFixture extends UserConfig {
  /** 历史夹具字段（当前用例不消费，保留原值） */
  social?: Record<string, never>;
}

/**
 * accountManager 夹具写入视图
 *
 * `data`/`configs` 是公开字段；用例写入的是 `mockPlayerData()` 替身与局部 UserConfig
 * 夹具（真实 PlayerDataManager 含私有成员）。AdminService 只读 `data[uid]._playerdata`
 * 与 `configs[uid]`，故按该读取面声明窄视图——真实公开字段可赋给本视图，无需断言。
 */
interface AccountManagerFixtureView {
  data: { [uid: string]: { _playerdata: PlayerDataModel } };
  configs: { [uid: string]: UserConfigFixture };
}

/** 把 accountManager 视作夹具写入视图（真实字段可赋给本视图） */
function fixtureAccounts(manager: typeof accountManager): AccountManagerFixtureView {
  return manager;
}

/** 夹具写入视图（与 accountManager 同一对象引用） */
const accounts = fixtureAccounts(accountManager);

/** onCharGet 替身返回（被测实现只读 isNew/charInstId） */
interface GrantCharStubResult {
  charInstId: number;
  charId: string;
  isNew: number;
  itemGet?: ItemBundle[];
}

/** rogueSimState 夹具快照（用例只读 current.player.state） */
interface Rlv2StateFixture {
  current: { player: { state: string } };
}

/**
 * admin-service 用例的玩家替身视图
 *
 * 在 `MockPlayerDataManager` 上按用例写入面补齐被测实现实际读取的子管理器桩
 * （inventory/char/building/mission/rlv2——真实 `PlayerDataManager` 上存在，
 * 但 mock 替身面未声明）。派生视图的共享成员与基类型同形，故 `mockPlayerData(...)`
 * 结果可安全断言为本视图（单向：本视图可赋给 MockPlayerDataManager）。
 */
interface AdminFixturePlayer extends MockPlayerDataManager {
  /** 物品管道替身（gainItem 为被测实现唯一读取入口） */
  inventory: { gainItem: (item: ItemBundle) => Promise<void> };
  /** 干员管理器替身 */
  char: { onCharGet: (args: [string, { from: string }]) => Promise<GrantCharStubResult> };
  /** 基建管理器替身 */
  building: { advance: (secs: number) => Promise<number> };
  /** 任务管理器替身 */
  mission: { dailyRefresh: () => Promise<void> };
  /** 肉鸽管理器替身 */
  rlv2: { toJSON: () => Rlv2StateFixture };
}

/** 带 refreshTime 的状态替身视图（真实 StatusManager 入口，MockStatusManager 面未覆盖） */
interface StatusStub extends MockStatusManager {
  refreshTime: Mock<() => Promise<void>>;
}

/**
 * 卡池 UP 选择视图（服务端自建键）
 *
 * AdminService.getPlayerPoolState/setPlayerPoolUp 经 json-path 在
 * `_playerdata.gacha.<type>[poolId].upChar` 上读写；生成模型
 * `PlayerGacha_PlayerGachaPool` 未声明该键，故按该键声明视图
 * （真实模型可赋给本视图——全部成员可选，故为合法的单向断言）。
 */
interface GachaPoolUpCharView {
  upChar?: string[];
}

// 官服迁移 mock（不真实联网/写库）
vi.mock("../../../scripts/migrate-official", () => ({
  runMigration: vi.fn(),
  parseAccounts: vi.fn(),
}));
// 官服操作 mock（不真实联网）
vi.mock("@ops/admin/official-ops", () => ({
  runOfficialAction: vi.fn(),
  runOfficialCall: vi.fn(),
  validateCgi: (cgi: string) => cgi,
  uploadPixelArt: vi.fn(),
  uploadPixelArtBatch: vi.fn(),
  getPixelArtList: vi.fn(),
  deletePixelArt: vi.fn(),
}));

// excel 表桩（名称解析/物品校验/满配/干员属性共用）
vi.mock("@excel/excel", () => {
  // 三张带 string 索引的表抽成显式 Record，避免门面方法的 `this.X[id]` 报 TS7053
  /** 物品表夹具 */
  const ItemTable: { items: Record<string, ExcelRowMock> } = {
    items: {
      "4001": { name: "龙门币", classifyType: "NORMAL", sortId: 100 },
      "4003": { name: "合成玉", classifyType: "NORMAL", sortId: 100 },
      "9999": { name: "未知材料", classifyType: "MATERIAL", sortId: 100 },
      "consumable_x": { name: "消耗券", classifyType: "CONSUME", sortId: 100 },
    },
  };
  /** 干员表夹具 */
  const CharacterTable: Record<string, ExcelCharRowMock> = {
    char_002_amiya: {
      name: "阿米娅",
      rarity: 4,
      maxPotentialLevel: 5,
      phases: [{ maxLevel: 30 }, { maxLevel: 55 }, { maxLevel: 90 }],
      skills: [{ skillId: "skill_amiya_1" }],
    },
  };
  /** 关卡表夹具 */
  const StageTable: { stages: Record<string, ExcelRowMock> } = {
    stages: {
      "main_01-01": {},
      "main_01-02": {},
    },
  };
  return {
    default: {
      // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
      getItem(id: string): ExcelRowMock | undefined { return ItemTable.items[id]; },
      itemName(id: string): string { return this.getItem(id)?.name ?? id; },
      makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
      charData(charId: string): ExcelCharRowMock | undefined { return CharacterTable[charId]; },
      stageData(stageId: string): ExcelRowMock | undefined { return StageTable.stages[stageId]; },

      ItemTable,
      CharacterTable,
      StageTable,
      SkinTable: {
        charSkins: {
          "char_002_amiya#2": { charId: "char_002_amiya", displaySkin: { skinName: "开初" } },
        },
      },
      UniequipTable: { charEquip: { char_002_amiya: [] } },
      BuildingData: { rooms: { room_1: { phases: [{}, {}, {}] } } },
      GachaTable: {
        gachaPoolClient: [
          {
            gachaPoolId: "NORMAL_0_1",
            gachaPoolName: "测试卡池",
            gachaRuleType: "NORMAL",
            openTime: 0,
            endTime: 9999999999,
            guarantee5Count: 10,
            guarantee5Avail: 1,
            gachaPoolSummary: "test",
          },
        ],
      },
      GachaDetailTable: {
        details: {
          NORMAL_0_1: {
            upCharInfo: {
              perCharList: [
                { rarityRank: 5, charIdList: ["char_002_amiya"], percent: 2, count: 1 },
              ],
            },
            availCharInfo: {
              perAvailList: [
                { rarityRank: 4, charIdList: ["char_002_amiya"], totalPercent: 50 },
              ],
            },
            limitedChar: [],
          },
        },
      },
      CheckinTable: {
        groups: {
          group1: {
            groupId: "group1",
            title: "签到组",
            signStartTime: 0,
            signEndTime: 9999999999,
            items: [{ itemId: "4001", itemType: "GOLD", count: 100 }],
          },
        },
        currentMonthlySubId: "",
        monthlySubItem: {},
      },
    },
  };
});

// 拦截所有 fs/promises 写操作（createUser 走 .tmp+rename 原子写；_audit 走 mkdir+appendFile，
// 均避免写真实文件/目录）
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
  };
});

/** 构造带完整结构的 mock 玩家（满配/基建/干员用例共用） */
function makeFullPd(): AdminFixturePlayer {
  const pd = mockPlayerData({
    status: {
      uid: "1",
      nickName: "阿米娅",
      nickNumber: "1",
      level: 60,
      exp: 100,
      gold: 99999,
      androidDiamond: 100,
      iosDiamond: 0,
      maxAp: 135,
      ap: 0,
      registerTs: 1000,
      lastOnlineTs: 2000,
    },
    troop: {
      curCharInstId: 5,
      chars: {
        "1": {
          instId: 1,
          charId: "char_002_amiya",
          level: 1,
          exp: 0,
          evolvePhase: 0,
          potentialRank: 0,
          favorPoint: 0,
          mainSkillLvl: 1,
          gainTime: 0,
          voiceLan: "CN_MANDARIN",
          skills: [{ skillId: "skill_amiya_1", unlock: 1, state: 0, specializeLevel: 0, completeUpgradeTime: -1 }],
        },
      },
    },
    inventory: {},
    consumable: {},
    skin: { characterSkins: {}, skinTs: {} },
    gacha: { normal: {}, limit: {} },
    dungeon: { stages: {} },
    mission: { missions: {}, missionRewards: {}, missionGroups: {} },
    medal: { medals: {}, custom: {} },
    shop: {},
    activity: {},
    checkIn: {
      canCheckIn: 1,
      checkInGroupId: "group1",
      checkInRewardIndex: 0,
      checkInHistory: [],
      newbiePackage: { open: false, groupId: "", finish: 0, stopSale: 0 },
    },
  }) as AdminFixturePlayer;
  // 基建夹具经 Object.assign 写入：roomId 用历史夹具值 "room_1"（真实
  // BuildingData_RoomType 枚举无该值，而 AdminService.buildingMax 按该键查
  // mock BuildingData.rooms；改值会改变用例驱动的相位数据，故保留原值）。
  Object.assign(pd._playerdata, {
    building: {
      roomSlots: {
        slot_1: { level: 1, state: 1, roomId: "room_1", charInstIds: [], completeConstructTime: 0 },
      },
    },
  });
  return pd;
}

/** 基本账号桩（listUsers/getUserInfo/sendMail 等只读与邮件路径用） */
function stubAccounts(pd: AdminFixturePlayer) {
  accounts.configs = {
    "1": asModel<UserConfigFixture>({
      uid: "1",
      password: "1",
      auth: { phone: "13800000000" },
      social: {},
      battle: {},
      gacha: {},
      rlv2: {},
    }),
  };
  accounts.data = { "1": pd };
}

describe("AdminService 只读能力", () => {
  let service: AdminService;

  beforeEach(() => {
    service = new AdminService();
    const pd = makeFullPd();
    stubAccounts(pd);
  });

  it("listUsers 应返回 uid/昵称/等级摘要", async () => {
    const users = await service.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ uid: "1", nickName: "阿米娅", level: 60 });
  });

  it("getUserInfo 应返回资金与带中文名的道具摘要", async () => {
    const pd = accounts.data["1"];
    pd._playerdata.inventory = { "4001": 100, "9999": 5 };
    const info = await service.getUserInfo("1");
    expect(info!.gold).toBe(99999);
    expect(info!.nickName).toBe("阿米娅");
    expect(info!.inventoryInfo).toEqual([
      { id: "4001", name: "龙门币", count: 100 },
      { id: "9999", name: "未知材料", count: 5 },
    ]);
    // 更多资源字段（makeFullPd status: ap 0 / maxAp 135）
    expect(info!.ap).toBe(0);
    expect(info!.maxAp).toBe(135);
  });

  it("getUserInfo 对不存在用户应返回 null", async () => {
    expect(await service.getUserInfo("999")).toBeNull();
  });

  it("getOfficialBackend 缺省应返回官方地址（自定义未启用）", () => {
    const b = service.getOfficialBackend();
    expect(b.enabled).toBe(false);
    expect(b.game).toContain("ak-gs-gf.hypergryph.com");
  });

  it("getMapvizData 应剥掉 game-data.js 前缀并解析 JSON，附加 gridzone 构造数据", async () => {
    const readFileSpy = vi
      .spyOn(await import("fs/promises"), "readFile")
      .mockResolvedValue(
        `/* 自动生成 */\nwindow.MAPVIZ_DATA = {"rogue_1":{"normal":["ro1_n_1_1"],"elite":[],"boss":[],"zones":{}}};\n`,
      );
    const data = await service.getMapvizData();
    expect(data?.themes).toEqual({ rogue_1: { normal: ["ro1_n_1_1"], elite: [], boss: [], zones: {} } });
    // gridzone 构造数据（黑流树海 rogue_6 无相地图）
    expect(data?.grid?.constructions?.length).toBeGreaterThan(0);
    expect(data?.grid?.distanceRules?.length).toBeGreaterThan(0);
    expect(data?.grid?.countRules?.length).toBeGreaterThan(0);
    expect(readFileSpy).toHaveBeenCalled();
    readFileSpy.mockRestore();
  });

  it("getMapvizData 文件读取失败应返回 null", async () => {
    vi.spyOn(await import("fs/promises"), "readFile").mockRejectedValue(
      new Error("ENOENT"),
    );
    expect(await service.getMapvizData()).toBeNull();
  });

  it("getMapvizData 格式异常（缺 = 或 ;）应返回 null", async () => {
    vi.spyOn(await import("fs/promises"), "readFile").mockResolvedValue(
      "window.MAPVIZ_DATA 没有分号",
    );
    expect(await service.getMapvizData()).toBeNull();
  });

  it("listUsers 应支持按昵称/手机号/uid 过滤", async () => {
    expect(await service.listUsers("阿米娅")).toHaveLength(1);
    expect(await service.listUsers("13800000000")).toHaveLength(1);
    expect(await service.listUsers("99999")).toHaveLength(0);
    expect(await service.listUsers("")).toHaveLength(1);
  });

  it("status 应返回用户数与端口信息", async () => {
    const st = await service.status();
    expect(st.userCount).toBe(1);
    expect(typeof st.port).toBe("number");
    expect(st.dataFiles.length).toBeGreaterThan(0);
    expect(typeof st.totalDataKB).toBe("number");
  });
});

describe("AdminService 发放物品", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = mockPlayerData({
      status: { uid: "1", nickName: "阿米娅", level: 1, gold: 0 },
      troop: { curCharInstId: 2 },
    }) as AdminFixturePlayer;
    // mock 的 PlayerDataManager 没有 inventory 管理器，附加 stub 模拟 GOLD 分支
    pd.inventory = {
      gainItem: vi.fn<(item: ItemBundle) => Promise<void>>().mockImplementation(async (item) => {
        pd._playerdata.status.gold += item.count;
      }),
    };
    stubAccounts(pd);
    // 拦截落盘与审计，避免写真实文件
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("发放金币应累加到 status.gold 并落盘", async () => {
    await service.grantItem("1", "4001", 5000);
    expect(pd._playerdata.status.gold).toBe(5000);
    expect(pd.inventory.gainItem).toHaveBeenCalledWith({ id: "4001", count: 5000 });
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("支持中文名/别名发放（如 合成玉）", async () => {
    await service.grantItem("1", "合成玉", 10);
    expect(pd.inventory.gainItem).toHaveBeenCalledWith({ id: "4003", count: 10 });
  });

  it("对未知物品应抛错", async () => {
    await expect(service.grantItem("1", "no_such_item", 1)).rejects.toThrow(/未知物品/);
  });

  it("对不在 ItemTable 的 ID 应抛错", async () => {
    await expect(service.grantItem("1", "7777", 1)).rejects.toThrow(/不在 ItemTable/);
  });

  it("对不存在用户应抛出明确错误", async () => {
    await expect(service.grantItem("999", "4001", 1)).rejects.toThrow(/不存在/);
  });

  it("数量必须为正整数", async () => {
    await expect(service.grantItem("1", "4001", -1)).rejects.toThrow(/数量/);
  });
});

describe("AdminService 干员/皮肤发放", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = makeFullPd();
    pd.char = {
      onCharGet: vi.fn().mockResolvedValue({ charInstId: 5, charId: "char_002_amiya", isNew: 1, itemGet: [] }),
    };
    pd.inventory = {
      gainItem: vi.fn().mockResolvedValue(undefined),
    };
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("grantChar 应调用 onCharGet（不走 char:get 事件）", async () => {
    const res = await service.grantChar("1", "char_002_amiya");
    expect(pd.char.onCharGet).toHaveBeenCalledWith([
      "char_002_amiya",
      { from: "ADMIN" },
    ]);
    expect(res).toMatchObject({ isNew: 1, name: "阿米娅" });
  });

  it("grantChar 支持中文名", async () => {
    await service.grantChar("1", "阿米娅");
    expect(pd.char.onCharGet).toHaveBeenCalledWith([
      "char_002_amiya",
      { from: "ADMIN" },
    ]);
  });

  it("grantChar 对未知干员应抛错", async () => {
    await expect(service.grantChar("1", "char_999")).rejects.toThrow(/未知干员/);
  });

  it("grantSkin 应以 CHAR_SKIN 类型解锁皮肤", async () => {
    await service.grantSkin("1", "char_002_amiya#2");
    expect(pd.inventory.gainItem).toHaveBeenCalledWith({
      id: "char_002_amiya#2",
      count: 1,
      type: "CHAR_SKIN",
    });
  });

  it("grantSkin 对未知皮肤应抛错", async () => {
    await expect(service.grantSkin("1", "char_999#1")).rejects.toThrow(/未知皮肤/);
  });
});

describe("AdminService 干员管理", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("listChars 应返回带中文名/星级/最大等级的摘要", async () => {
    const chars = await service.listChars("1");
    expect(chars).toHaveLength(1);
    expect(chars[0]).toMatchObject({
      instId: 1,
      charId: "char_002_amiya",
      name: "阿米娅",
      rarity: 4,
      level: 1,
      maxLevel: 30,
    });
  });

  it("getCharDetail 应返回干员详情（技能/语音/装备）", async () => {
    const d = await service.getCharDetail("1", 1);
    expect(d).toMatchObject({
      instId: 1,
      name: "阿米娅",
      rarity: 4,
      voiceLan: "CN_MANDARIN",
      maxLevel: 30,
    });
    expect(d!.skills).toHaveLength(1);
    expect(d!.equip).toBeDefined();
  });

  it("getCharDetail 对不存在干员应返回 null", async () => {
    expect(await service.getCharDetail("1", 99)).toBeNull();
  });

  it("getShopSummary 应汇总各商店类型购买记录数", async () => {
    // LS.info[].id 用历史数字夹具值（真实 PlayerGoodItemData.id 为 string）；
    // AdminService.getShopSummary 只统计 info.length，故经 Object.assign 保留原值。
    Object.assign(pd._playerdata, {
      shop: {
        LS: { curShopId: "shop1", info: [{ id: 1 }] },
        SOCIAL: { curShopId: "shop2", info: [] },
      },
    });
    const st = await service.getShopSummary("1");
    expect(st.total).toBe(1);
    expect(st.types.find((t) => t.type === "LS")).toMatchObject({
      curShopId: "shop1",
      items: 1,
    });
  });

  it("setCharAttrs 应钳制越界值（精二/等级/潜能/技能）", async () => {
    await service.setCharAttrs("1", 1, {
      level: 999,
      evolvePhase: 5,
      potentialRank: 9,
      mainSkillLvl: 9,
    });
    const ch = pd._playerdata.troop.chars["1"];
    expect(ch.evolvePhase).toBe(2); // phases.length-1
    expect(ch.level).toBe(90); // phases[2].maxLevel
    expect(ch.potentialRank).toBe(5); // maxPotentialLevel
    expect(ch.mainSkillLvl).toBe(7);
    expect(ch.exp).toBe(0);
  });

  it("setCharAttrs 不提供任何属性应抛错", async () => {
    await expect(service.setCharAttrs("1", 1, {})).rejects.toThrow(/未提供/);
  });

  it("setCharAttrs 对不存在干员应抛错", async () => {
    await expect(service.setCharAttrs("1", 99, { level: 10 })).rejects.toThrow(/干员不存在/);
  });
});

describe("AdminService 一键满配与基建", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("maxOutAccount 应拉满资源/干员/背包/皮肤/基建", async () => {
    const stats = await service.maxOutAccount("1");
    const d = pd._playerdata;
    // 资源
    expect(d.status.gold).toBe(99999999);
    expect(d.status.androidDiamond).toBe(99999);
    expect(d.status.level).toBe(120);
    expect(d.status.ap).toBe(135);
    // 背包：NORMAL/MATERIAL → inventory，CONSUME → consumable
    expect(d.inventory["4001"]).toBe(999);
    expect(d.consumable["consumable_x"]).toEqual({ "0": { ts: -1, count: 999 } });
    // 干员：精二满级/满潜/满技能
    const ch = d.troop.chars["1"];
    expect(ch.evolvePhase).toBe(2);
    expect(ch.level).toBe(90);
    expect(ch.potentialRank).toBe(5);
    expect(ch.mainSkillLvl).toBe(7);
    expect(ch.favorPoint).toBe(25570);
    expect(ch.skills![0].specializeLevel).toBe(3);
    // 皮肤解锁
    expect(d.skin.characterSkins["char_002_amiya#2"]).toBe(1);
    // 基建满级（room_1 有 3 个相位）
    expect(d.building.roomSlots.slot_1.level).toBe(3);
    expect(stats).toMatchObject({ chars: 1, rooms: 1, skins: 1 });
  });

  it("buildingMax 应把房间升到最高相位等级", async () => {
    const result = await service.buildingMax("1");
    expect(pd._playerdata.building.roomSlots.slot_1.level).toBe(3);
    expect(result).toEqual({ rooms: 1 });
  });

  it("buildingAdvance 应委托 building.advance 快进并落盘", async () => {
    const advance = vi.fn().mockResolvedValue(1234567890);
    pd.building = { advance };
    const result = await service.buildingAdvance("1", 3600);
    expect(advance).toHaveBeenCalledWith(3600);
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
    expect(result).toEqual({ advanced: 3600 });
  });

  it("buildingAdvance 对非正整数秒数应抛错", async () => {
    await expect(service.buildingAdvance("1", 0)).rejects.toThrow(/正整数/);
    await expect(service.buildingAdvance("1", -60)).rejects.toThrow(/正整数/);
    await expect(service.buildingAdvance("1", NaN)).rejects.toThrow(/正整数/);
  });
});

describe("AdminService 邮件（群发/查看/删除）", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    const pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("sendMailAll 应遍历所有用户发送", async () => {
    const spy = vi
      .spyOn(mailManager, "sendMail")
      .mockResolvedValue(asModel<MailItem>({ mailId: 1000000 }));
    const result = await service.sendMailAll({ subject: "公告", content: "hi", items: [] });
    expect(result).toEqual({ sent: 1 });
    expect(spy).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ subject: "公告" }),
    );
  });

  it("listMails 应返回带中文附件名的邮件摘要", async () => {
    vi.spyOn(mailManager, "listAllMail").mockReturnValue([
      asModel<MailItem>({
        mailId: 1000001,
        subject: "欢迎",
        content: "",
        createAt: 100,
        expireAt: 200,
        receiveAt: -1,
        state: 0,
        hasItem: 1,
        items: [{ id: "4001", type: "GOLD", count: 100 }],
      }),
    ]);
    const mails = await service.listMails("1");
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe("欢迎");
    expect(mails[0].items).toEqual([{ id: "4001", name: "龙门币", count: 100 }]);
  });

  it("deleteMail 应透传删除结果", async () => {
    const spy = vi.spyOn(mailManager, "deleteMail").mockResolvedValue(true);
    expect(await service.deleteMail("1", 1000001)).toBe(true);
    expect(spy).toHaveBeenCalledWith("1", 1000001);
    spy.mockResolvedValue(false);
    expect(await service.deleteMail("1", 999)).toBe(false);
  });
});

describe("AdminService 服务器控制与数据导出", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;
  let statusStub: StatusStub;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = makeFullPd();
    statusStub = Object.assign(pd.status, {
      refreshTime: vi.fn().mockResolvedValue(undefined),
    });
    pd.mission = { dailyRefresh: vi.fn().mockResolvedValue(undefined) };
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("refreshUser 应触发每日刷新并落盘", async () => {
    await service.refreshUser("1");
    expect(statusStub.refreshTime).toHaveBeenCalled();
    expect(pd.mission.dailyRefresh).toHaveBeenCalled();
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("refreshUser 对不存在用户应抛错", async () => {
    await expect(service.refreshUser("999")).rejects.toThrow(/不存在/);
  });

  it("saveUser 应立即保存", async () => {
    await service.saveUser("1");
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("getRawJson 应返回完整玩家数据", async () => {
    const raw = await service.getRawJson("1");
    expect(raw).toEqual(pd._playerdata);
  });
});

describe("AdminService 游戏协议代理", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    const pd = makeFullPd();
    stubAccounts(pd);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gameProxy 应以玩家 secret 转发请求并返回解析后的 JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue('{"playerDataDelta":{"modified":{}}}'),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.gameProxy("1", "/user/info", "GET");
    expect(result).toMatchObject({ status: 200, uid: "1" });
    expect(result.data).toEqual({ playerDataDelta: { modified: {} } });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/user/info"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ secret: "1" }),
      }),
    );
  });

  it("gameProxy 应带 JSON body 转发 POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: vi.fn().mockResolvedValue("{}"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await service.gameProxy("1", "/gacha/advancedGacha", "POST", {
      poolId: "p1",
      useTkt: 0,
      itemId: null,
    });
    const [, opts] = fetchMock.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ poolId: "p1", useTkt: 0, itemId: null });
  });

  it("gameProxy 应拒绝代理控制面路径", async () => {
    await expect(service.gameProxy("1", "/admin/api/status")).rejects.toThrow(
      /不允许代理控制面路径/,
    );
    await expect(service.gameProxy("1", "/auth/login")).rejects.toThrow(
      /不允许代理控制面路径/,
    );
  });

  it("gameProxy 对不以 / 开头的路径应抛错", async () => {
    await expect(service.gameProxy("1", "user/info")).rejects.toThrow(/必须以 \//);
  });

  it("gameProxy 对服务器内部请求失败应抛明确错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(service.gameProxy("1", "/user/info")).rejects.toThrow(
      /服务器内部请求失败/,
    );
  });

  it("gameProxy 对非 JSON 响应应原样返回文本", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 500, text: vi.fn().mockResolvedValue("<html>err</html>") }),
    );
    const result = await service.gameProxy("1", "/user/info");
    expect(result.status).toBe(500);
    expect(result.data).toBe("<html>err</html>");
  });

  it("rogueSimStep 白名单外 action 应返回错误", async () => {
    const r = await service.rogueSimStep("1", "hack", {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("非法操作");
  });

  it("rogueSimStep 白名单 action 应经 gameProxy 透传并返回 rlv2 快照", async () => {
    const spy = vi.spyOn(service, "gameProxy").mockResolvedValue({
      status: 200,
      uid: "1",
      data: { playerDataDelta: { modified: { rlv2: { current: { player: { state: "WAIT_MOVE" } } } } } },
    });
    const r = await service.rogueSimStep("1", "moveTo", { to: { x: 0, y: 0 } });
    expect(r.ok).toBe(true);
    expect(r.state!.current!.player!.state).toBe("WAIT_MOVE");
    expect(spy).toHaveBeenCalledWith("1", "/rlv2/moveTo", "POST", { to: { x: 0, y: 0 } });
  });

  it("rogueSimAuto 应编排开局链并推进至 END（mock gameProxy 响应序列）", async () => {
    // 伪造 rlv2 快照序列：INIT 开局 → WAIT_MOVE zone1 → PENDING SCENE → END
    /** 待处理事件夹具（被测实现只读 type 与 content.scene.choices） */
    type PendingFixture = { type: string; content?: { scene?: { choices?: Record<string, number> } } };
    /** 光标终点夹具 */
    type PosFixture = { x: number; y: number };
    const snap = (
      state: string,
      zone: number,
      pending: PendingFixture[] = [],
      zoneEndPos: PosFixture | null = null,
    ) => ({
      current: {
        player: { state, cursor: { zone, position: zoneEndPos }, pending, property: { hp: { current: 10, max: 10 }, gold: 10 } },
        map: {
          zones: {
            "1": {
              nodes: {
                "0": { pos: { x: 0, y: 0 }, type: 32, next: [{ x: 1, y: 0 }] },
                "100": { pos: { x: 1, y: 0 }, type: 8, next: [], zone_end: true },
              },
            },
          },
        },
        record: { record: { cntZone: 1, cntArrivedNode: 2, cntRecruitChar: 0, cntBattleNormal: 0, cntBattleElite: 0, cntBattleBoss: 0, relicList: [] } },
      },
    });
    const responses = [
      // createGame
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("INIT", 0, [{ type: "GAME_INIT_RELIC" }]) } } } },
      // finishEvent（触发事件生成）→ 仍 INIT 带 RELIC
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("INIT", 0, [{ type: "GAME_INIT_RELIC" }]) } } } },
      // chooseInitialRelic → 仍 INIT 带 RECRUIT_SET
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("INIT", 0, [{ type: "GAME_INIT_RECRUIT_SET" }]) } } } },
      // chooseInitialRecruitSet → INIT 空 pending
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("INIT", 0, []) } } } },
      // finishEvent → WAIT_MOVE zone1
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("WAIT_MOVE", 1, [], null) } } } },
      // 主循环 finishEvent → WAIT_MOVE（起点可访问）
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("WAIT_MOVE", 1, [], null) } } } },
      // moveTo(0,0) → PENDING SCENE
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("PENDING", 1, [{ type: "SCENE", content: { scene: { choices: { choice_1: 1 } } } }], { x: 0, y: 0 }) } } } },
      // consumePending: finishEvent → SCENE → selectChoice → WAIT_MOVE
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("WAIT_MOVE", 1, [], { x: 0, y: 0 }) } } } },
      // moveTo(1,0) zone_end → PENDING
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("PENDING", 1, [], { x: 1, y: 0 }) } } } },
      // finishEvent zone_end → END（最终层结算）
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("END", 1, [], { x: 1, y: 0 }) } } } },
      // 主循环检查 state=END 前还有一次 finishEvent
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("END", 1, [], { x: 1, y: 0 }) } } } },
      // gameSettle
      { status: 200, uid: "1", data: { playerDataDelta: { modified: { rlv2: snap("END", 1, []) } } } },
    ];
    const spy = vi.spyOn(service, "gameProxy").mockImplementation(async () => responses.shift()!);
    const r = await service.rogueSimAuto("1", "rogue_1");
    expect(r.ok).toBe(true);
    expect(r.steps.length).toBeGreaterThan(0);
    expect(r.final!.current!.player!.state).toBe("END");
    // 应调用过开局链 + moveTo + gameSettle
    const paths = spy.mock.calls.map((c) => c[1]);
    expect(paths).toContain("/rlv2/createGame");
    expect(paths).toContain("/rlv2/chooseInitialRelic");
    expect(paths).toContain("/rlv2/moveTo");
    expect(paths).toContain("/rlv2/gameSettle");
  });

  it("rogueSimAuto 服务器错误应返回 ok:false", async () => {
    vi.spyOn(service, "gameProxy").mockResolvedValue({ status: 500, uid: "1", data: "boom" });
    const r = await service.rogueSimAuto("1", "rogue_1");
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("rogueSimState 应返回当前 rlv2 toJSON 快照", async () => {
    const pd = makeFullPd();
    stubAccounts(pd);
    // getPlayer 为私有方法（不在 AdminService 公开类型面上），用具名桩替换实例方法
    const getPlayer = vi
      .fn<(uid: string) => Promise<PlayerDataManager>>()
      .mockResolvedValue(asPlayerManager(pd));
    Object.assign(service, { getPlayer });
    pd.rlv2 = { toJSON: () => ({ current: { player: { state: "NONE" } } }) };
    const state = await service.rogueSimState("1");
    expect(state.current.player!.state).toBe("NONE");
    expect(getPlayer).toHaveBeenCalledWith("1");
  });

  it("uploadPixelArtBatch 应一次批量上传并返回逐张结果（登录/网关连接各一次）", async () => {
    const mock = vi.mocked(uploadPixelArtBatchMock);
    mock.mockResolvedValue([
      { index: 0, ok: true, pixelArtId: 1001n, uploadToken: "t1", httpResp: {} },
      { index: 1, ok: true, pixelArtId: 1002n, uploadToken: "t2", httpResp: {} },
    ]);
    // 1728 字节 RGB 数组（全白）
    const px1 = new Array(1728).fill(255);
    const px2 = new Array(1728).fill(255);
    const r = await service.uploadPixelArtBatch("13800000000", "pwd", [px1, px2]);
    expect(r).toEqual([
      { index: 0, ok: true, pixelArtId: "1001" },
      { index: 1, ok: true, pixelArtId: "1002" },
    ]);
    // 只调一次批量函数（内部登录/网关连接各一次）
    expect(mock).toHaveBeenCalledTimes(1);
    const [phone, , buffers] = mock.mock.calls[0];
    expect(phone).toBe("13800000000");
    expect(buffers).toHaveLength(2);
  });

  it("uploadPixelArtBatch 单张校验失败不中断后续且索引保持", async () => {
    const mock = vi.mocked(uploadPixelArtBatchMock);
    mock.mockResolvedValue([
      { index: 0, ok: true, pixelArtId: 2001n, uploadToken: "t", httpResp: {} },
      { index: 1, ok: true, pixelArtId: 2002n, uploadToken: "t", httpResp: {} },
    ]);
    // 第 1 张合法、第 2 张长度非法（校验失败，不进入批量）、第 3 张合法
    const r = await service.uploadPixelArtBatch("13800000000", "pwd", [
      new Array(1728).fill(0),
      [1, 2, 3],
      new Array(1728).fill(0),
    ]);
    expect(r[0]).toMatchObject({ index: 0, ok: true, pixelArtId: "2001" });
    expect(r[1]).toMatchObject({ index: 1, ok: false });
    expect(r[1].error).toContain("长度非法");
    expect(r[2]).toMatchObject({ index: 2, ok: true, pixelArtId: "2002" });
    // 校验失败项不进批量，批量只收 2 张合法数据
    const buffers = mock.mock.calls[0][2];
    expect(buffers).toHaveLength(2);
  });

  it("uploadPixelArtBatch 批量函数单张失败返回 error", async () => {
    const mock = vi.mocked(uploadPixelArtBatchMock);
    mock.mockResolvedValue([
      { index: 0, ok: false, error: "官服 HTTP 500 @ /activity/arkhub/savePixelArt" },
    ]);
    const r = await service.uploadPixelArtBatch("13800000000", "pwd", [new Array(1728).fill(0)]);
    expect(r[0]).toMatchObject({ index: 0, ok: false });
    expect(r[0].error).toContain("官服 HTTP 500");
  });

  it("uploadPixelArtBatch 空列表应返回空数组", async () => {
    const r = await service.uploadPixelArtBatch("13800000000", "pwd", []);
    expect(r).toEqual([]);
  });

  it("uploadPixelArtBatch 缺手机号/密码应抛错", async () => {
    await expect(service.uploadPixelArtBatch("", "", [new Array(1728).fill(0)])).rejects.toThrow(/手机号与密码/);
  });

  it("getPixelArtList 应透传 phone/pwd 并返回像素列表", async () => {
    vi.mocked(getPixelArtListMock).mockResolvedValue([
      { id: "1001", url: "https://x/y.dat", isBanned: false, pixels: new Array(1728).fill(0) },
    ]);
    const r = await service.getPixelArtList("13800000000", "pwd");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("1001");
    expect(vi.mocked(getPixelArtListMock)).toHaveBeenCalledWith("13800000000", "pwd", undefined);
  });

  it("getPixelArtList 缺手机号应抛错", async () => {
    await expect(service.getPixelArtList("", "pwd")).rejects.toThrow(/手机号与密码/);
  });

  it("deletePixelArt 应透传并返回逐张结果", async () => {
    vi.mocked(deletePixelArtMock).mockResolvedValue([
      { id: "1001", ok: true },
      { id: "1002", ok: false, error: "code=403" },
    ]);
    const r = await service.deletePixelArt("13800000000", "pwd", [1001, 1002]);
    expect(r).toHaveLength(2);
    expect(r[1].error).toContain("code=403");
    expect(vi.mocked(deletePixelArtMock)).toHaveBeenCalledWith("13800000000", "pwd", [1001, 1002]);
  });
});

describe("AdminService 卡池管理", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("listPools 应返回卡池清单并映射 gachaType", () => {
    const pools = service.listPools();
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      poolId: "NORMAL_0_1",
      name: "测试卡池",
      ruleType: "NORMAL",
      gachaType: "normal",
      guarantee5Count: 10,
    });
  });

  it("poolDetail 应返回 UP/可用干员中文名与概率", () => {
    const detail = service.poolDetail("NORMAL_0_1");
    expect(detail!.upChars).toEqual([
      { charId: "char_002_amiya", name: "阿米娅", percent: 2, count: 1, rarityRank: 5 },
    ]);
    expect(detail!.availChars).toHaveLength(1);
    expect(detail!.limitedChars).toEqual([]);
  });

  it("poolDetail 对不存在卡池应返回 null", () => {
    expect(service.poolDetail("NO_SUCH")).toBeNull();
  });

  it("getPlayerPoolState 应返回 UP 选择与保底计数", async () => {
    pd._playerdata.gacha.normal["NORMAL_0_1"] = asModel<
      PlayerDataModel["gacha"]["normal"][string] & GachaPoolUpCharView
    >({ upChar: ["char_002_amiya"] });
    const st = await service.getPlayerPoolState("1", "NORMAL_0_1");
    expect(st.upCharIds).toEqual(["char_002_amiya"]);
    expect(st.upChars).toEqual([{ charId: "char_002_amiya", name: "阿米娅" }]);
    expect(st.beforeNonHitCnt).toBe(0);
    expect(st.guarantee5Count).toBe(10);
  });

  it("setPlayerPoolUp 应写入 gacha[gachaType][poolId].upChar 并支持中文名", async () => {
    await service.setPlayerPoolUp("1", "NORMAL_0_1", ["阿米娅"]);
    expect((pd._playerdata.gacha.normal["NORMAL_0_1"] as GachaPoolUpCharView).upChar).toEqual([
      "char_002_amiya",
    ]);
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("setPlayerPoolUp 空数组应清除 UP", async () => {
    pd._playerdata.gacha.normal["NORMAL_0_1"] = asModel<
      PlayerDataModel["gacha"]["normal"][string] & GachaPoolUpCharView
    >({ upChar: ["char_002_amiya"] });
    await service.setPlayerPoolUp("1", "NORMAL_0_1", []);
    expect((pd._playerdata.gacha.normal["NORMAL_0_1"] as GachaPoolUpCharView).upChar).toEqual([]);
  });

  it("setPlayerPoolUp 对不存在卡池应抛错", async () => {
    await expect(service.setPlayerPoolUp("1", "NO_SUCH", ["char_002_amiya"])).rejects.toThrow(
      /卡池不存在/,
    );
  });

  it("setPlayerPity 应写入账号配置并落盘", async () => {
    const r = await service.setPlayerPity("1", "normal", 42);
    expect(r).toEqual({ uid: "1", ruleType: "NORMAL", beforeNonHitCnt: 42 });
    expect(accounts.configs["1"].gacha.NORMAL.beforeNonHitCnt).toBe(42);
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("setPlayerPity 对负数应抛错", async () => {
    await expect(service.setPlayerPity("1", "NORMAL", -1)).rejects.toThrow(/非负整数/);
  });

  it("getPlayerPity / listPlayerPity 应读取保底", async () => {
    accounts.configs["1"].gacha = { NORMAL: { beforeNonHitCnt: 5 } };
    expect((await service.getPlayerPity("1", "NORMAL")).beforeNonHitCnt).toBe(5);
    expect(await service.listPlayerPity("1")).toEqual([
      { ruleType: "NORMAL", beforeNonHitCnt: 5 },
    ]);
  });
});

describe("AdminService 批量工具", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("grantAllItems 应把全部物品写入背包/消耗品", async () => {
    const r = await service.grantAllItems("1", 999);
    expect(r).toEqual({ items: 4 }); // mock ItemTable: 3 个 NORMAL/MATERIAL + 1 个 CONSUME
    const d = pd._playerdata;
    expect(d.inventory["4001"]).toBe(999);
    expect(d.inventory["4003"]).toBe(999);
    expect(d.inventory["9999"]).toBe(999);
    expect(d.consumable["consumable_x"]).toEqual({ "0": { ts: -1, count: 999 } });
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("grantAllItems 数量非法应抛错", async () => {
    await expect(service.grantAllItems("1", 0)).rejects.toThrow(/正整数/);
  });

  it("maxAllChars 应拉满全部已有干员", async () => {
    const r = await service.maxAllChars("1");
    expect(r).toEqual({ chars: 1 });
    const ch = pd._playerdata.troop.chars["1"];
    expect(ch.evolvePhase).toBe(2);
    expect(ch.level).toBe(90);
    expect(ch.potentialRank).toBe(5);
    expect(ch.mainSkillLvl).toBe(7);
    expect(ch.skills![0].specializeLevel).toBe(3);
  });

  it("listStages 应返回推图进度统计", async () => {
    pd._playerdata.dungeon.stages = asModel<PlayerDataModel["dungeon"]["stages"]>({
      "main_01-01": { stageId: "main_01-01", completeTimes: 3, startTimes: 3, practiceTimes: 0, state: 3, hasBattleReplay: 1, noCostCnt: 0 },
      "main_01-02": { stageId: "main_01-02", completeTimes: 0, startTimes: 1, practiceTimes: 0, state: 1, hasBattleReplay: 0, noCostCnt: 0 },
    });
    const st = await service.listStages("1");
    expect(st.total).toBe(2);
    expect(st.done).toBe(1);
    expect(st.stages[0].stageId).toBe("main_01-01");
  });

  it("repairChars 应补齐缺失字段与阿米娅 tmpl", async () => {
    const ch = pd._playerdata.troop.chars["1"];
    // voiceLan/skills 在生成模型里是必填，用例刻意删除以驱动补齐——按深可选视图删除
    delete (ch as Partial<PlayerCharacter>).voiceLan;
    delete (ch as Partial<PlayerCharacter>).skills;
    // starMark/equip/currentEquip 本就不存在，阿米娅无 currentTmpl/tmpl
    const r = await service.repairChars("1");
    expect(r.chars).toBe(1);
    expect(r.fields).toBeGreaterThanOrEqual(5);
    const fixed = pd._playerdata.troop.chars["1"];
    expect(fixed.voiceLan).toBe("CN_MANDARIN");
    expect(fixed.starMark).toBe(0);
    expect(fixed.skills!.length).toBeGreaterThan(0);
    expect(fixed.currentTmpl).toBe("char_002_amiya");
    expect(fixed.tmpl).toBeDefined();
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("repairChars 对完整干员应无改动", async () => {
    const ch = pd._playerdata.troop.chars["1"];
    // 补齐 mock 干员自然缺失的字段，构成"完整"干员
    ch.starMark = 0;
    ch.currentEquip = null;
    ch.equip = {};
    ch.currentTmpl = "char_002_amiya";
    ch.tmpl = {};
    const before = JSON.stringify(ch);
    const r = await service.repairChars("1");
    expect(r.fields).toBe(0);
    expect(JSON.stringify(pd._playerdata.troop.chars["1"])).toBe(before);
  });
});

describe("AdminService 关卡/物品/任务", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("unlockStage 应写入关卡完成状态", async () => {
    const r = await service.unlockStage("1", "main_01-01");
    expect(r).toEqual({ stageId: "main_01-01" });
    const s = pd._playerdata.dungeon.stages["main_01-01"];
    expect(s.state).toBe(3);
    expect(s.completeTimes).toBe(1);
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("unlockStage 对未知关卡应抛错", async () => {
    await expect(service.unlockStage("1", "no_such_stage")).rejects.toThrow(/关卡不存在/);
  });

  it("unlockAllStages 应补全缺失关卡并跳过已有进度", async () => {
    pd._playerdata.dungeon.stages["main_01-01"] = asModel<PlayerDataModel["dungeon"]["stages"][string]>({ state: 3, completeTimes: 3 });
    const r = await service.unlockAllStages("1");
    expect(r).toEqual({ stages: 1, total: 2 });
    expect(pd._playerdata.dungeon.stages["main_01-02"].state).toBe(3);
    expect(pd._playerdata.dungeon.stages["main_01-01"].completeTimes).toBe(3);
  });

  it("searchItems 应按名称/ID 过滤", () => {
    expect(service.searchItems("龙门币").map((i) => i.id)).toEqual(["4001"]);
    expect(service.searchItems("4003").map((i) => i.id)).toEqual(["4003"]);
    expect(service.searchItems("不存在")).toEqual([]);
    expect(service.searchItems("").length).toBeGreaterThan(0);
  });

  it("listMissionStats 应统计各组完成数", async () => {
    pd._playerdata.mission.missions = asModel<PlayerDataModel["mission"]["missions"]>({
      daily: {
        m1: { state: 2, progress: [] },
        m2: { state: 0, progress: [] },
      },
    });
    const st = await service.listMissionStats("1");
    expect(st.total).toBe(2);
    expect(st.done).toBe(1);
    expect(st.groups).toEqual([{ group: "daily", total: 2, done: 1 }]);
  });

  it("listMedals 应统计已解锁勋章（fts>0）", async () => {
    pd._playerdata.medal.medals = asModel<PlayerDataModel["medal"]["medals"]>({
      medal_1: { id: "medal_1", val: [], fts: 100, rts: 0 },
      medal_2: { id: "medal_2", val: [], fts: 0, rts: 0 },
    });
    const st = await service.listMedals("1");
    expect(st.total).toBe(2);
    expect(st.unlocked).toBe(1);
    expect(st.medals[0]).toMatchObject({ id: "medal_1", unlocked: true });
  });

  it("getActivitySummary 应统计各类型活动数", async () => {
    pd._playerdata.activity = asModel<PlayerDataModel["activity"]>({
      LOGIN_ONLY: { act1: {}, act2: {} },
      MISSION_ONLY: { act3: {} },
    });
    const st = await service.getActivitySummary("1");
    expect(st.total).toBe(3);
    expect(st.types.find((t) => t.type === "LOGIN_ONLY")!.activities).toBe(2);
    expect(st.types.find((t) => t.type === "MISSION_ONLY")!.activities).toBe(1);
  });
});

describe("AdminService 官服迁移", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    const pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(runMigration).mockResolvedValue([
      { phone: "13800000000", uid: "2", nickName: "A" },
      { phone: "13900000000", error: "登录失败" },
    ]);
  });

  it("migrateOfficial 应透传账号文本、热加载成功用户并审计", async () => {
    const reloadSpy = vi.spyOn(service, "reloadUser").mockResolvedValue(undefined);
    const results = await service.migrateOfficial(
      "13800000000 pwd\n13900000000 pwd2",
      "1",
    );
    expect(runMigration).toHaveBeenCalledWith({
      accounts: "13800000000 pwd\n13900000000 pwd2",
      templateUid: "1",
    });
    expect(results).toHaveLength(2);
    // 仅成功账号热加载
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).toHaveBeenCalledWith("2");
    // 审计日志写入
    expect(appendFile).toHaveBeenCalled();
  });

  it("migrateOfficial 空账号应抛错", async () => {
    await expect(service.migrateOfficial("  \n  ", "1")).rejects.toThrow(
      /账号内容为空/,
    );
  });

  it("migrateOfficial 成功账号热加载失败不应中断", async () => {
    vi.mocked(runMigration).mockResolvedValue([
      { phone: "13800000000", uid: "2", nickName: "A" },
    ]);
    vi.spyOn(service, "reloadUser").mockRejectedValue(new Error("文件缺失"));
    const results = await service.migrateOfficial("13800000000 pwd", "1");
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("2");
  });

  it("officialAction 应透传手机号/密码/操作并审计", async () => {
    vi.mocked(runOfficialAction).mockResolvedValue({
      action: "signin",
      ok: true,
      data: "签到成功",
    });
    const r = await service.officialAction("13800000000", "pwd", "signin");
    expect(runOfficialAction).toHaveBeenCalledWith("13800000000", "pwd", "signin");
    expect(r.ok).toBe(true);
    expect(appendFile).toHaveBeenCalled();
  });

  it("officialAction 缺手机号或密码应抛错", async () => {
    await expect(service.officialAction("", "pwd", "signin")).rejects.toThrow(/手机号与密码/);
  });

  it("officialCall 应透传 cgi/body 并审计", async () => {
    vi.mocked(runOfficialCall).mockResolvedValue({
      cgi: "/mail/getMetaInfoList",
      result: { result: [] },
    });
    const r = await service.officialCall("13800000000", "pwd", "/mail/getMetaInfoList", { from: 0 });
    expect(runOfficialCall).toHaveBeenCalledWith("13800000000", "pwd", "/mail/getMetaInfoList", { from: 0 });
    expect(r.result).toEqual({ result: [] });
    expect(appendFile).toHaveBeenCalled();
  });
});

describe("AdminService checkData 干员校验", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
  });

  const validChar = {
    instId: 1,
    charId: "char_002_amiya",
    level: 1,
    evolvePhase: 0,
    potentialRank: 0,
    mainSkillLvl: 1,
    favorPoint: 0,
    gainTime: 0,
    voiceLan: "CN_MANDARIN",
  };

  it("正常干员应通过（含阿米娅三形态结构）", async () => {
    accounts.data = {
      "1": {
        _playerdata: asModel<PlayerDataModel>({
          status: { uid: "1" },
          troop: { chars: { "1": { ...validChar, currentTmpl: "char_002_amiya", tmpl: {} } } },
        }),
      },
    };
    const r = await service.checkData();
    expect(r.ok).toBe(true);
  });

  it("干员缺字段应报错", async () => {
    const { mainSkillLvl, ...noSkill } = validChar;
    accounts.data = {
      "1": {
        _playerdata: asModel<PlayerDataModel>({
          status: { uid: "1" },
          troop: { chars: { "1": noSkill } },
        }),
      },
    };
    const r = await service.checkData();
    expect(r.ok).toBe(false);
    expect(r.users[0].error).toContain("缺少 mainSkillLvl");
  });

  it("干员不在 CharacterTable 应报错", async () => {
    accounts.data = {
      "1": {
        _playerdata: asModel<PlayerDataModel>({
          status: { uid: "1" },
          troop: { chars: { "1": { ...validChar, charId: "char_999" } } },
        }),
      },
    };
    const r = await service.checkData();
    expect(r.ok).toBe(false);
    expect(r.users[0].error).toContain("不在 CharacterTable");
  });

  it("阿米娅缺 currentTmpl/tmpl 应报错", async () => {
    accounts.data = {
      "1": {
        _playerdata: asModel<PlayerDataModel>({
          status: { uid: "1" },
          troop: { chars: { "1": validChar } },
        }),
      },
    };
    const r = await service.checkData();
    expect(r.ok).toBe(false);
    expect(r.users[0].error).toContain("阿米娅");
  });
});

describe("AdminService 签到", () => {
  let service: AdminService;
  let pd: AdminFixturePlayer;
  let statusStub: StatusStub;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("getCheckInState 应返回组/档位/总数", async () => {
    const st = await service.getCheckInState("1");
    expect(st).toMatchObject({
      groupId: "group1",
      groupTitle: "签到组",
      canCheckIn: 1,
      rewardIndex: 0,
      historyCount: 0,
      total: 1,
    });
  });

  it("resetCheckIn 应调用月刷新并落盘", async () => {
    Object.assign(pd.checkIn, { monthlyRefresh: vi.fn().mockResolvedValue(undefined) });
    const st = await service.resetCheckIn("1");
    expect(pd.checkIn.monthlyRefresh).toHaveBeenCalled();
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
    expect(st.total).toBe(1);
  });

  it("doCheckIn 应返回带中文名的奖励并落盘", async () => {
    Object.assign(pd.checkIn, {
      checkIn: vi.fn().mockResolvedValue({
        signInRewards: [{ id: "4001", type: "GOLD", count: 100 }],
        subscriptionRewards: [],
      }),
    });
    const r = await service.doCheckIn("1");
    expect(r.rewards).toEqual([{ id: "4001", name: "龙门币", count: 100 }]);
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("dailyRoutine 应刷新+代签并落盘", async () => {
    statusStub = Object.assign(pd.status, { refreshTime: vi.fn().mockResolvedValue(undefined) });
    pd.mission = { dailyRefresh: vi.fn().mockResolvedValue(undefined) };
    Object.assign(pd.checkIn, { checkIn: vi.fn().mockResolvedValue({ signInRewards: [{ id: "4001", count: 1 }] }) });
    const r = await service.dailyRoutine("1");
    expect(r.checkin).toBe("已签");
    expect(statusStub.refreshTime).toHaveBeenCalled();
    expect(accountManager.savePlayerData).toHaveBeenCalledWith("1");
  });

  it("dailyRoutine 不可签应返回不可签且不报错", async () => {
    statusStub = Object.assign(pd.status, { refreshTime: vi.fn().mockResolvedValue(undefined) });
    pd.mission = { dailyRefresh: vi.fn().mockResolvedValue(undefined) };
    Object.assign(pd.checkIn, { checkIn: vi.fn().mockResolvedValue(undefined) });
    const r = await service.dailyRoutine("1");
    expect(r.checkin).toBe("不可签");
  });
});

describe("AdminService 统计", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = new AdminService();
    const pd = makeFullPd();
    stubAccounts(pd);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("stats 应聚合等级分布/注册分布/资源合计", async () => {
    const s = await service.stats();
    expect(s.userCount).toBe(1);
    expect(s.levelDist).toEqual({ "60-69": 1 });
    expect(s.totalGold).toBe(99999);
    expect(s.totalDiamond).toBe(100);
    expect(s.totalChars).toBe(4); // curCharInstId - 1
    expect(s.avgLevel).toBe(60);
  });

  it("stats 对空用户表应返回零值", async () => {
    accounts.data = {};
    accounts.configs = {};
    const s = await service.stats();
    expect(s.userCount).toBe(0);
    expect(s.avgLevel).toBe(0);
  });
});

describe("AdminService 邮件与建号", () => {
  let service: AdminService;

  beforeEach(() => {
    vi.restoreAllMocks();
    // createUser 走 real 模式建号（single 模式下 registerUser 已短路为收敛固定账号）
    config.authMode = "real";
    service = new AdminService();
    const pd = makeFullPd();
    stubAccounts(pd);
    vi.spyOn(accountManager, "savePlayerData").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "saveUserConfig").mockResolvedValue(undefined);
    vi.mocked(appendFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("sendMail 应调用 mailManager 并返回邮件", async () => {
    const spy = vi
      .spyOn(mailManager, "sendMail")
      .mockResolvedValue(asModel<MailItem>({ mailId: 1000000 }));
    const mail = await service.sendMail("1", {
      subject: "欢迎",
      content: "你好",
      items: [{ id: "4001", count: 100 }],
    });
    expect(spy).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ subject: "欢迎" }),
    );
    expect(mail.mailId).toBe(1000000);
  });

  it("sendMail 对不存在用户应报错", async () => {
    await expect(
      service.sendMail("999", { subject: "x", content: "", items: [] }),
    ).rejects.toThrow(/不存在/);
  });

  it("createUser 应生成新 uid 并更新 configs", async () => {
    const uid = await service.createUser("13900000000", "pw123");
    expect(uid).toBe("2");
    expect(accounts.configs[uid]).toBeDefined();
    expect(accounts.configs[uid].auth.phone).toBe("13900000000");
    expect(accountManager.saveUserConfig).toHaveBeenCalled();
  });

  it("createUser 对重复手机号应报错", async () => {
    await expect(service.createUser("13800000000", "pw123")).rejects.toThrow(
      /手机号/,
    );
  });

  it("createUser 对空手机号应报错", async () => {
    await expect(service.createUser("", "pw123")).rejects.toThrow(/手机号/);
  });
});

describe("pushMessage 发放推送信息", () => {
  it("应设置指定 pushFlags 并返回更新后的标记", async () => {
    const service = new AdminService();
    const pd = mockPlayerData({
      status: { uid: "1" },
      pushFlags: { hasGifts: 0, hasFriendRequest: 0, hasClues: 0, hasFreeLevelGP: 0, status: 0 },
    }) as AdminFixturePlayer;
    vi.spyOn(accountManager, "data", "get").mockReturnValue({ "1": asPlayerManager(pd) });
    const result = await service.pushMessage("1", { hasGifts: 1, hasClues: 1 });
    expect(result.hasGifts).toBe(1);
    expect(result.hasClues).toBe(1);
    expect(result.hasFriendRequest).toBe(0);
    expect(pd._playerdata.pushFlags.hasGifts).toBe(1);
  });

  it("传 0 应清除指定推送标记", async () => {
    const service = new AdminService();
    const pd = mockPlayerData({
      status: { uid: "1" },
      pushFlags: { hasGifts: 1, hasFriendRequest: 0, hasClues: 1, hasFreeLevelGP: 0, status: 0 },
    }) as AdminFixturePlayer;
    vi.spyOn(accountManager, "data", "get").mockReturnValue({ "1": asPlayerManager(pd) });
    const result = await service.pushMessage("1", { hasGifts: 0 });
    expect(result.hasGifts).toBe(0);
    expect(result.hasClues).toBe(1); // 未传的键不变
  });
});
