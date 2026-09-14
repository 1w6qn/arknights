import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 客户端交互三问题修复测试（2026-08-19）
 *
 * 1. deliveryBatchOrder：兼容请求字段变体（slotList/slotIdList/roomSlotIdList/单值）
 *    ——客户端改造版字段名不同导致 200 但空循环不交付
 * 2. batchChangeWorkChar：空请求体（官方 CS 无字段）时**自动选中心情相对高的预设**——
 *    客户端"换班"按钮期望应用下一组排班，原实现空体不改分配
 * 3. confirmMission：旧存档已领任务（state=3 无 confirmed 字段）不重复发放
 *    ——原实现只判 confirmed，8-12 模板迁移存档会重复发奖 + dailyPoint 无限累积
 */

/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }

/** 任务定义 mock 行（本文件写入的字段） */
interface MissionRowMock { id: string; type: string; periodicalPoint: number }

/** WEEKLY 周期奖励定义 mock 行（本文件写入的字段） */
interface WeeklyRewardMock {
  id: string;
  periodicalPointCost: number;
  type: string;
  groupId: string;
  beginTime: number;
  endTime: number;
  rewards: { type: string; id: string; count: number }[];
}

/** 周期奖励定义 mock 行（本文件不提供具体行，保持空表） */
interface PeriodicalRewardMock { id?: string }

const excelMock = vi.hoisted(() => ({
  default: {
    // —— 本文件不提供的表（占位，保持门面方法的 `this.XxxTable` 读取路径）——
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    CharacterTable: undefined as Record<string, ExcelRowMock> | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

    BuildingData: {
      goldItems: { "3003": 500 },
      laborRecoverTime: 360,
      buffs: {},
      chars: {},
      manufactData: { phases: [{ speed: 1, outputCapacity: 24 }] },
      meetingData: { phases: [{ friendSlotInc: 10, maxVisitorNum: 10, gatheringSpeed: 100 }] },
      hireData: { phases: [{ resSpeed: 100, refreshTimes: 3 }] },
      manufactFormulas: {},
      rooms: {
        TRADING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        MANUFACTURE: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
      },
    },
    MissionTable: {
      missions: {
        "daily_claimed": { id: "daily_claimed", type: "DAILY", periodicalPoint: 5 },
        "daily_pending": { id: "daily_pending", type: "DAILY", periodicalPoint: 5 },
      } as Record<string, MissionRowMock>,
      periodicalRewards: {} as Record<string, PeriodicalRewardMock>,
      // WEEKLY 周期奖励定义表（confirmMission 按任务 type 分流读取；原键不存在 → 用 undefined 占位保持等价）
      weeklyRewards: undefined as Record<string, WeeklyRewardMock> | undefined,
    },
    ActivityTable: { missionData: [] },
  },
}));
vi.mock("@excel/excel", () => excelMock);
const timeMock = vi.hoisted(() => ({ now: 1787000000 }));
vi.mock("@utils/time", () => ({ now: () => timeMock.now, checkBetween: () => true, userTimestamp: () => timeMock.now }));
vi.mock("@game/kernel/player-data-manager", () => ({ PlayerDataManager: vi.fn() }));

import {
  mockPlayerData,
  mockTypedEventEmitter,
  asPlayerManager,
  asModel,
  type MockPlayerDataManager,
  type MockPlayerDataSeed,
  type MockSeed,
  type MockUpdateRecipe,
} from "../../helpers";
import type { Draft } from "mutative";
import type {
  MissionPlayerDataGroup,
  PlayerBuilding,
  PlayerBuildingChar,
  PlayerBuildingManufacture,
  PlayerBuildingWorkshop,
  PlayerDataModel,
} from "@game/kernel/playerdata";
import type { RoomTimestamp } from "@game/modules/building/logic/ext-types";
import { BuildingManager } from "@game/modules/building/logic";
import { MissionManager } from "@game/modules/mission/logic";

/**
 * 基建夹具视图
 *
 * 与 {@link MockPlayerDataSeed} 的 building 子树同形，唯一差异：服务端存档的
 * `rooms.WORKSHOP[slot]` 带 `state`（生成模型 `PlayerBuildingWorkshop` 只有 buff/statistic，
 * 读取侧按 {@link RoomTimestamp} 处理），故 WORKSHOP 槽位按该视图表达。
 */
type BuildingFixture = MockSeed<Omit<PlayerBuilding, "rooms">> & {
  rooms?: MockSeed<Omit<PlayerBuilding["rooms"], "WORKSHOP">> & {
    WORKSHOP?: Record<string, MockSeed<PlayerBuildingWorkshop> & RoomTimestamp>;
  };
};

/**
 * 任务记录夹具视图
 *
 * 服务端为防重复领取另存 `confirmed` 标记（生成模型 `MissionEntry` 无此字段，见
 * `modules/mission/logic.ts#MissionEntryView`），此处按同一形状收窄读取。
 */
type MissionEntryFixture = MissionPlayerDataGroup[string][string] & { confirmed?: number };

function baseBuilding(): BuildingFixture {
  return {
    status: {
      labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 1000, maxValue: 100 },
      workshop: { bonusActive: 0, bonus: {} },
    },
    chars: {},
    roomSlots: {},
    rooms: {
      CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {},
      CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {}, TRAINING: {}, PRIVATE: {},
    },
    furniture: {}, diyPresetSolutions: {}, assist: [-1, -1, -1], solution: { furnitureTs: {} }, music: {},
  };
}

function makePlayer(
  building: BuildingFixture,
  extra: Omit<MockPlayerDataSeed, "building"> = {},
) {
  const mockPlayer = mockPlayerData({
    building,
    event: { building: 0 },
    pushFlags: {},
    status: { uid: "1", gold: 1000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
    inventory: { "3003": 10 },
    troop: { chars: {}, charGroup: {} },
    ...extra,
  });
  const mockTrigger = mockTypedEventEmitter();
  mockPlayer._trigger = mockTrigger;
  mockPlayer.update = vi
    .fn<(recipe: MockUpdateRecipe) => Promise<void>>()
    .mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata)) as Draft<PlayerDataModel>;
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  return { mockPlayer, mockTrigger };
}

describe("deliveryBatchOrder 请求字段变体兼容", () => {
  let mockPlayer: MockPlayerDataManager;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;
  let manager: BuildingManager;

  function withStock() {
    const b = baseBuilding();
    b.rooms!.TRADING!.slot_6 = {
      state: 1,
      stock: [
        { instId: 1, delivery: [{ id: "3003", type: "MATERIAL", count: 2 }], type: "O_GOLD", gain: { id: "4001", type: "GOLD", count: 1000 }, buff: [] },
      ],
      stockLimit: 10, strategy: "O_GOLD", lastUpdateTime: 1000,
    };
    ({ mockPlayer, mockTrigger } = makePlayer(b));
    manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("官方字段 slotList 正常交付", async () => {
    withStock();
    await manager.deliveryBatchOrder({ slotList: ["slot_6"] });
    expect(mockPlayer._playerdata.status!.gold).toBe(2000);
    expect(mockPlayer._playerdata.building.rooms.TRADING.slot_6.stock).toEqual([]);
  });

  it("变体 slotIdList 同样交付（防客户端字段名不同）", async () => {
    withStock();
    await manager.deliveryBatchOrder({ slotIdList: ["slot_6"] });
    expect(mockPlayer._playerdata.status!.gold).toBe(2000);
  });

  it("变体 roomSlotIdList 同样交付", async () => {
    withStock();
    await manager.deliveryBatchOrder({ roomSlotIdList: ["slot_6"] });
    expect(mockPlayer._playerdata.status!.gold).toBe(2000);
  });

  it("单值 slotId 兼容", async () => {
    withStock();
    await manager.deliveryBatchOrder({ slotId: "slot_6" });
    expect(mockPlayer._playerdata.status!.gold).toBe(2000);
  });

  it("空字段不 500（无订单可交付）", async () => {
    withStock();
    const res = await manager.deliveryBatchOrder({});
    expect(res).toEqual({});
    expect(mockPlayer._playerdata.status!.gold).toBe(1000); // 未交付
  });

  it("deliveryBatchOrder 交付后 sync 不应立即补满订单（改动不被撤回）", async () => {
    const b = baseBuilding();
    // 静态兜底路径（无 next）：初始库存 2 单，stockLimit 5
    b.rooms!.TRADING!.slot_6 = {
      state: 1,
      stock: [
        { instId: 1, delivery: [{ id: "3003", type: "MATERIAL", count: 2 }], type: "O_GOLD", gain: { id: "4001", type: "GOLD", count: 1000 }, buff: [] },
        { instId: 2, delivery: [{ id: "3003", type: "MATERIAL", count: 2 }], type: "O_GOLD", gain: { id: "4001", type: "GOLD", count: 1000 }, buff: [] },
      ],
      stockLimit: 5, strategy: "O_GOLD", lastUpdateTime: 1000,
    };
    ({ mockPlayer, mockTrigger } = makePlayer(b));
    manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 交付清空全部订单（初始 gold=1000，2 单 × 1000）
    await manager.deliveryBatchOrder({ slotList: ["slot_6"] });
    const room = () => mockPlayer._playerdata.building.rooms.TRADING.slot_6;
    expect(room().stock).toEqual([]);
    expect(mockPlayer._playerdata.status!.gold).toBe(3000);
    // 紧接 sync：修复前补单守卫未初始化 → 当"首次补单"立即补满 5 单（订单回退、
    // 交付被撤回）；修复后交付时刻已记录守卫 → sync 只可能节流补单（间隔内不补）
    await manager.sync();
    expect(room().stock).toEqual([]);
    expect(mockPlayer._playerdata.status!.gold).toBe(3000);
  });
});

describe("batchChangeWorkChar 预设队列轮换", () => {
  let mockPlayer: MockPlayerDataManager;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;
  let manager: BuildingManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    const b = baseBuilding();
    b.roomSlots!.slot_5 = { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [1, 2], completeConstructTime: -1 };
    b.rooms!.MANUFACTURE!.slot_5 = { presetQueue: [[3, 4], [5, 6]] };
    ({ mockPlayer, mockTrigger } = makePlayer(b));
    manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
  });

  it("仅指定 roomSlotId（无干员列表）：当前排班不在队列 → 自动选中心情相对高的预设", async () => {
    // 客户端"换班"按钮：只带房间、不带排班 → 服务端自动选中心情最高的一组
    await manager.batchChangeWorkChar({ roomSlotId: "slot_5" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.charInstIds).toEqual([3, 4]);
  });

  it("仅指定 roomSlotId：应自动选中该房间心情(ap)总和最高的预设组（非轮换）", async () => {
    // 构造心情：组成员的 ap 同为默认（0）时命中首组；第 2 组干员心情更高 → 自动改选第 2 组
    const chars = mockPlayer._playerdata.building.chars;
    // 末调用时第 2 组（干员 7/8 不存在）→ 保持首组语义由既有用例覆盖；
    // 这里显式设置第 2 组干员心情，验证自动改选到心情更高组
    chars["5"] = asModel<PlayerBuildingChar>({ ap: 8000 });
    chars["6"] = asModel<PlayerBuildingChar>({ ap: 8000 });
    chars["3"] = asModel<PlayerBuildingChar>({ ap: 1000 });
    chars["4"] = asModel<PlayerBuildingChar>({ ap: 1000 });
    await manager.batchChangeWorkChar({ roomSlotId: "slot_5" });
    // 第 2 组 [5,6] 心情总和(16000) > 第 1 组 [3,4](2000) → 自动当选
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.charInstIds).toEqual([5, 6]);
    // 再次调用仍选中心情最高的第 2 组（不往返轮换）
    await manager.batchChangeWorkChar({ roomSlotId: "slot_5" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.charInstIds).toEqual([5, 6]);
  });

  it("完全空请求体：全局自动换班（无 roomSlotId 时遍历所有带预设队列的房间应用中心情最高组）", async () => {
    // 客户端"换班"按钮真实发空体 {}（抓包 R-1787464955254）——空体应触发全局换班
    await manager.batchChangeWorkChar({});
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.charInstIds).toEqual([3, 4]);
  });

  it("无预设队列时仅带 roomSlotId 不改分配", async () => {
    mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5 = asModel<PlayerBuildingManufacture>({});
    await manager.batchChangeWorkChar({ roomSlotId: "slot_5" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.charInstIds).toEqual([1, 2]);
  });

  it("显式 charInstIdList 仍直接应用（不改轮换）", async () => {
    await manager.batchChangeWorkChar({ roomSlotId: "slot_5", charInstIdList: [7, 8] });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.charInstIds).toEqual([7, 8]);
  });
});

describe("confirmMission 已完成待领取任务可领取", () => {
  it("state=3 无 confirmed（已完成可领取）应正常发奖并置 confirmed（修复：原误判为已领不发放）", async () => {
    const mission = {
      missions: {
        DAILY: {
          "daily_claimed": { state: 3, progress: [{ value: 1, target: 1 }] }, // 已完成未领取
        },
      },
      missionRewards: { dailyPoint: 10, weeklyPoint: 0, rewards: { DAILY: {}, WEEKLY: {} } },
      missionGroups: {},
    };
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), { mission });
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    const items = await manager.confirmMission({ missionId: "daily_claimed" });
    // periodicalRewards 为空 → items 无实发性（本条只验发放路径打通）
    expect(items).toEqual([]);
    // 发放后置 confirmed 防重复；dailyPoint 正常累计（10 + 5）
    expect((mockPlayer._playerdata.mission!.missions.DAILY["daily_claimed"] as MissionEntryFixture).confirmed).toBe(1);
    expect(mockPlayer._playerdata.mission!.missionRewards.dailyPoint).toBe(15);
    expect(mockPlayer._playerdata.mission!.missions.DAILY["daily_claimed"].state).toBe(3);
  });

  it("state=2 进度满无 confirmed → 正常发放置 3", async () => {
    const mission = {
      missions: {
        DAILY: {
          "daily_pending": { state: 2, progress: [{ value: 1, target: 1 }] },
        },
      },
      missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: { DAILY: {}, WEEKLY: {} } },
      missionGroups: {},
    };
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), { mission });
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.confirmMission({ missionId: "daily_pending" });
    expect(mockPlayer._playerdata.mission!.missions.DAILY["daily_pending"].state).toBe(3);
    expect(mockPlayer._playerdata.mission!.missionRewards.dailyPoint).toBe(5);
  });
});

describe("confirmMission WEEKLY 周期奖励兑换与防御（2026-08-23）", () => {
  it("WEEKLY 任务确认应累加周期点并兑换达标周期奖励（原只累加不兑换 → 无获得物品提示）", async () => {
    // 补 WEEKLY 任务与周期奖励数据（WEEKLY 周期奖励定义在 weeklyRewards，非 periodicalRewards）
    excelMock.default.MissionTable.missions["weekly_claim"] = {
      id: "weekly_claim", type: "WEEKLY", periodicalPoint: 20,
    };
    (excelMock.default.MissionTable.weeklyRewards ??= {})["reward_weekly_1"] = {
      id: "reward_weekly_1", periodicalPointCost: 20, type: "WEEKLY",
      groupId: "reward_weekly_g_test", beginTime: 0, endTime: 1e18,
      rewards: [{ type: "CARD_EXP", id: "2001", count: 5 }],
    };
    const mission = {
      missions: {
        WEEKLY: {
          "weekly_claim": { state: 3, progress: [{ value: 1, target: 1 }] },
        },
      },
      missionRewards: {
        dailyPoint: 0, weeklyPoint: 0,
        rewards: { DAILY: {}, WEEKLY: { reward_weekly_1: 0 } },
      },
      missionGroups: {},
    };
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), { mission });
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    const items = await manager.confirmMission({ missionId: "weekly_claim" });
    // 确认 WEEKLY 任务后应返回兑换的周期奖励（客户端据此弹"获得物品"提示）
    expect(items).toEqual([{ type: "CARD_EXP", id: "2001", count: 5 }]);
    // weeklyPoint 扣减（20 - 20 = 0）且奖励标记已领防重复
    expect(mockPlayer._playerdata.mission!.missionRewards.weeklyPoint).toBe(0);
    expect(mockPlayer._playerdata.mission!.missionRewards.rewards.WEEKLY.reward_weekly_1).toBe(1);
    // 已领任务不重复发放（再次确认 items 空）
    const items2 = await manager.confirmMission({ missionId: "weekly_claim" });
    expect(items2).toEqual([]);
  });

  it("新账号 missionRewards 为空对象时 DAILY/WEEKLY 确认不崩溃（原 rewards[type] 未初始化 500）", async () => {
    // 补 excel 任务（confirmMission 按 missionId 查 MissionTable）
    excelMock.default.MissionTable.missions["daily_fresh"] = {
      id: "daily_fresh", type: "DAILY", periodicalPoint: 1,
    };
    excelMock.default.MissionTable.missions["weekly_fresh"] = {
      id: "weekly_fresh", type: "WEEKLY", periodicalPoint: 1,
    };
    const mission = {
      missions: {
        DAILY: { "daily_fresh": { state: 3, progress: [{ value: 1, target: 1 }] } },
        WEEKLY: { "weekly_fresh": { state: 3, progress: [{ value: 1, target: 1 }] } },
      },
      // freshMission 只给空对象：无 dailyPoint/points/rewards 子树
      missionRewards: {},
      missionGroups: {},
    };
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), { mission });
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    // 不应抛 TypeError；防御初始化后 rewards 子树应存在
    const items = await manager.confirmMission({ missionId: "daily_fresh" });
    expect(Array.isArray(items)).toBe(true);
    await manager.confirmMission({ missionId: "weekly_fresh" });
    expect(mockPlayer._playerdata.mission!.missionRewards.rewards).toBeDefined();
  });
});

describe("dailyRefresh 刷新信用可领取状态（2026-08-23）", () => {
  it("累积信用后应同步更新 infoShare.reward 待领取指示（原只写 socialReward 不刷新 infoShare）", async () => {
    const b = baseBuilding();
    b.rooms!.MEETING!.slot_1 = {
      // 旧存档主动信用（search）尚有待领取量；infoShare 初始 reward=0（客户端曾领过）
      socialReward: { daily: 0, search: 30 },
      infoShare: { ts: 0, reward: 0 },
    };
    const { mockPlayer, mockTrigger } = makePlayer(b);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.dailyRefresh();
    // 修复前：dailyRefresh 只累积 socialReward 从不调 _refreshInfoShare → infoShare.reward 恒 0
    expect(mockPlayer._playerdata.building.rooms.MEETING.slot_1.infoShare.reward).toBe(1);
  });
});
