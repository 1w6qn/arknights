import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 基建房间建造/升级/降级前置与限制（Round 21：B8）+ 每名在岗干员基础效率（B2）
 *
 * 数据源实证（data/excel/building_data.json）：
 * - `rooms[roomId].phases[level-1].unlockCondId`（如 MANUFACTURE#2）
 * - `roomUnlockConds[condId].number[*] = { type, level, count }`（type=FUNCTIONAL 为功能房间数）
 * - `rooms[roomId].canLevelDown`：CONTROL/WORKSHOP/HIRE/TRAINING/MEETING 为 false
 * - `manufactData.basicSpeedBuff = 0.01` / `tradingData.basicSpeedBuff = 0.01`
 */
/** excel mock 的行形状（本文件只需 `name`，供 `itemName` 回退读取） */
interface ExcelRowMock { name?: string }

const excelMock = vi.hoisted(() => ({
  default: {
    // —— 本文件不提供的表（占位；`?.` 读取下与「键不存在」运行时等价）——
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    CharacterTable: undefined as Record<string, ExcelRowMock> | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

    BuildingData: {
      manufactData: {
        basicSpeedBuff: 0.01,
        phases: [
          { speed: 1, outputCapacity: 24 },
          { speed: 1, outputCapacity: 36 },
          { speed: 1, outputCapacity: 54 },
        ],
      },
      tradingData: { basicSpeedBuff: 0.01, phases: [{ orderSpeed: 1, orderLimit: 6, orderRarity: 1 }] },
      meetingData: { basicSpeedBuff: 0.05, phases: [{ friendSlotInc: 10, maxVisitorNum: 10, gatheringSpeed: 100 }] },
      // 官方 roomUnlockConds 子集（实测值）
      roomUnlockConds: {
        "CONTROL#1": { id: "CONTROL#1", number: { 1: { type: 0, level: 0, count: 0 } } },
        "CONTROL#2": { id: "CONTROL#2", number: { 1: { type: "FUNCTIONAL", level: 1, count: 5 } } },
        "MANUFACTURE#1": { id: "MANUFACTURE#1", number: { 1: { type: "POWER", level: 1, count: 1 } } },
        "MANUFACTURE#2": { id: "MANUFACTURE#2", number: { 1: { type: "CONTROL", level: 3, count: 1 } } },
        "MANUFACTURE#3": { id: "MANUFACTURE#3", number: { 1: { type: "CONTROL", level: 4, count: 1 } } },
        "TRADING#1": { id: "TRADING#1", number: { 1: { type: "MANUFACTURE", level: 1, count: 1 } } },
      },
      rooms: {
        CONTROL: {
          canLevelDown: false,
          phases: [
            { unlockCondId: "CONTROL#1", buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1, electricity: 0 },
            { unlockCondId: "CONTROL#2", buildCost: { items: [], time: 0, labor: 20 }, maxStationedNum: 2, electricity: 0 },
            { unlockCondId: "CONTROL#3", buildCost: { items: [], time: 0, labor: 30 }, maxStationedNum: 3, electricity: 0 },
            { unlockCondId: "CONTROL#4", buildCost: { items: [], time: 0, labor: 40 }, maxStationedNum: 4, electricity: 0 },
            { unlockCondId: "CONTROL#5", buildCost: { items: [], time: 0, labor: 50 }, maxStationedNum: 5, electricity: 0 },
          ],
        },
        MANUFACTURE: {
          canLevelDown: true,
          phases: [
            { unlockCondId: "MANUFACTURE#1", buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1, electricity: -10 },
            { unlockCondId: "MANUFACTURE#2", buildCost: { items: [], time: 0, labor: 20 }, maxStationedNum: 2, electricity: -30 },
            { unlockCondId: "MANUFACTURE#3", buildCost: { items: [], time: 0, labor: 30 }, maxStationedNum: 3, electricity: -60 },
          ],
        },
        TRADING: {
          canLevelDown: true,
          phases: [
            { unlockCondId: "TRADING#1", buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1, electricity: -10 },
          ],
        },
        POWER: {
          canLevelDown: true,
          phases: [
            { buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1, electricity: 60 },
            { buildCost: { items: [], time: 0, labor: 60 }, maxStationedNum: 1, electricity: 130 },
            { buildCost: { items: [], time: 0, labor: 120 }, maxStationedNum: 1, electricity: 270 },
          ],
        },
        MEETING: { canLevelDown: false, phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1, electricity: -10 }] },
      },
      goldItems: { "3003": 500 },
      laborRecoverTime: 360,
      basicFavorPerDay: 720,
      apToLaborRatio: 2,
      manufactReduceTimeUnit: 180,
      tradingReduceTimeUnit: 180,
    },
  },
}));
vi.mock("@excel/excel", () => excelMock);

vi.mock("@game/kernel/player-data-manager", () => ({ PlayerDataManager: vi.fn() }));
vi.mock("@utils/time", () => ({ now: () => 1234567890 }));

import {
  mockPlayerData,
  mockTypedEventEmitter,
  asPlayerManager,
  asModel,
  type MockPlayerDataSeed,
  type MockSeed,
  type MockUpdateRecipe,
} from "../../helpers";
import { BuildingManager } from "@game/modules/building/logic";
import type { PlayerBuilding, PlayerBuildingManufacture, PlayerBuildingRoomSlot, PlayerDataModel } from "@game/kernel/playerdata";
import type { BuildingData_ManufactFormula, BuildingData_RoomType } from "@excel/types_excel_gen";
import type { Draft } from "mutative";

/**
 * 房间槽位夹具视图
 *
 * 未建造槽位在旧存档与夹具中以 `roomId: null` 表示，而生成模型把 `roomId` 声明为必填的
 * {@link BuildingData_RoomType}（不含 null 态）。运行期值一字不改，仅在种子边界放宽本字段。
 */
type RoomSlotSeed = Omit<MockSeed<PlayerBuildingRoomSlot>, "roomId"> & {
  /** 未建造为 null（生成模型无 null 态） */
  roomId?: BuildingData_RoomType | null;
};

/**
 * building 夹具视图
 *
 * 与 {@link MockPlayerDataSeed} 的 building 子树同形（深可选），仅 `roomSlots`
 * 按 {@link RoomSlotSeed} 放宽 `roomId`。
 */
type BuildingFixture = MockSeed<Omit<PlayerBuilding, "roomSlots">> & {
  /** 房间槽位字典（键为 slotId） */
  roomSlots?: Record<string, RoomSlotSeed>;
};

/** 构造 mock 玩家（指定房间布局） */
function makePlayer(
  roomSlots: Record<string, RoomSlotSeed>,
  extra: Omit<MockPlayerDataSeed, "building"> = {},
) {
  const building: BuildingFixture = {
      status: { labor: { buffSpeed: 0, processPoint: 0, value: 1000, lastUpdateTime: 0, maxValue: 225 }, workshop: { bonusActive: 0, bonus: {} } },
      chars: {},
      roomSlots,
      rooms: { CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {}, CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {}, TRAINING: {}, PRIVATE: {} },
      furniture: {},
      diyPresetSolutions: {},
      assist: [-1, -1, -1],
      solution: { furnitureTs: {} },
      music: { inUse: false, selected: "bgm_default", state: {} },
  };
  const mockPlayer = mockPlayerData({
    building: building as MockSeed<PlayerBuilding>,
    event: { building: 0 },
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

describe("基建房间前置与限制（B8）", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("buildRoom：制造站建造需发电站 Lv1（MANUFACTURE#1），无电力房间时拒绝", async () => {
    const { mockPlayer, mockTrigger } = makePlayer({
      slot_34: { level: 1, state: 2, roomId: "CONTROL", charInstIds: [-1], completeConstructTime: -1 },
      slot_5: { level: 0, state: 0, roomId: null, charInstIds: [], completeConstructTime: -1 },
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.buildRoom({ roomSlotId: "slot_5", roomId: "MANUFACTURE" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.roomId).toBeNull(); // 前置不满足 → 拒绝
  });

  it("buildRoom：有发电站 Lv1 时允许建造", async () => {
    const { mockPlayer, mockTrigger } = makePlayer({
      slot_24: { level: 1, state: 2, roomId: "POWER", charInstIds: [-1], completeConstructTime: -1 },
      slot_5: { level: 0, state: 0, roomId: null, charInstIds: [], completeConstructTime: -1 },
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.buildRoom({ roomSlotId: "slot_5", roomId: "MANUFACTURE" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.roomId).toBe("MANUFACTURE");
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.level).toBe(1);
  });

  it("upgradeRoom：制造站 Lv2 需中枢 Lv3（MANUFACTURE#2）——中枢 Lv1 时拒绝、Lv3 时允许", async () => {
    const { mockPlayer, mockTrigger } = makePlayer({
      slot_34: { level: 1, state: 2, roomId: "CONTROL", charInstIds: [-1], completeConstructTime: -1 },
      slot_24: { level: 3, state: 2, roomId: "POWER", charInstIds: [-1], completeConstructTime: -1 },
      slot_5: { level: 1, state: 2, roomId: "MANUFACTURE", charInstIds: [-1, -1], completeConstructTime: -1 },
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.upgradeRoom({ roomSlotId: "slot_5", targetLevel: 2 });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.level).toBe(1);
    // 中枢升到 Lv3 → 允许
    mockPlayer._playerdata.building.roomSlots.slot_34.level = 3;
    await manager.upgradeRoom({ roomSlotId: "slot_5", targetLevel: 2 });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.level).toBe(2);
  });

  it("degradeRoom：不可降级房间（控制中枢 canLevelDown=false）拒绝", async () => {
    const { mockPlayer, mockTrigger } = makePlayer({
      slot_34: { level: 3, state: 2, roomId: "CONTROL", charInstIds: [-1], completeConstructTime: -1 },
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.degradeRoom({ roomSlotId: "slot_34" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_34.level).toBe(3);
  });

  it("degradeRoom：发电站降级致电力为负时拒绝；电力充足时允许", async () => {
    const { mockPlayer, mockTrigger } = makePlayer({
      slot_24: { level: 3, state: 2, roomId: "POWER", charInstIds: [-1], completeConstructTime: -1 },
      // 两台 Lv3 制造站（各 -60）→ 270 - 120 = 150；发电站降到 lv2（130）仍为正
      slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [-1], completeConstructTime: -1 },
      slot_6: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [-1], completeConstructTime: -1 },
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.degradeRoom({ roomSlotId: "slot_24" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_24.level).toBe(2);
    // 打到负：再建 4 台 Lv3 制造站（-240）→ 130 - 240 - 120 = -230 → 拒绝继续降级
    for (const id of ["slot_7", "slot_8", "slot_9", "slot_10"]) {
      mockPlayer._playerdata.building.roomSlots[id] = { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [-1], completeConstructTime: -1 };
    }
    await manager.degradeRoom({ roomSlotId: "slot_24" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_24.level).toBe(2);
  });

  it("degradeRoom：耗电房间在电力为负时仍可降级（只省电，不减少供给）", async () => {
    const { mockPlayer, mockTrigger } = makePlayer({
      slot_24: { level: 1, state: 2, roomId: "POWER", charInstIds: [-1], completeConstructTime: -1 },
      slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [-1], completeConstructTime: -1 },
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.degradeRoom({ roomSlotId: "slot_5" });
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.level).toBe(2);
  });

  it("B2：制造站加成含「每名在岗干员 +1%」基础效率", async () => {
    const { mockPlayer, mockTrigger } = makePlayer({
      slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [1, 2, -1], completeConstructTime: -1 },
      slot_6: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [-1, -1], completeConstructTime: -1 },
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata)) as Draft<PlayerDataModel>;
    // _roomCapacity 只在房间对象存在时回写 buff
    draft.building.rooms.MANUFACTURE = {
      slot_5: asModel<PlayerBuildingManufacture>({}),
      slot_6: asModel<PlayerBuildingManufacture>({}),
    };
    // 3 人槽位中 2 人在岗 → +2%；无干员技能与中枢加成时 speed = 0.02
    manager._roomCapacity(draft, "slot_5", asModel<BuildingData_ManufactFormula>({ formulaType: "F_GOLD" }));
    expect(draft.building.rooms.MANUFACTURE.slot_5.buff.speed).toBeCloseTo(0.02);
    manager._roomCapacity(draft, "slot_6", asModel<BuildingData_ManufactFormula>({ formulaType: "F_GOLD" }));
    expect(draft.building.rooms.MANUFACTURE.slot_6.buff.speed).toBe(0);
  });
});
