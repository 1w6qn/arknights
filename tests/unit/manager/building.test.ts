import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import config from "@core/config/index";
import type {
  PlayerBuilding,
  PlayerBuildingChar,
  PlayerBuildingDormitory,
  PlayerBuildingManufacture,
  PlayerBuildingMeeting,
  PlayerBuildingMeetingClue,
  PlayerBuildingRoomSlot,
  PlayerBuildingTrainee,
  PlayerBuildingTrading,
  PlayerBuildingTraining,
  PlayerCharacter,
  PlayerTroop,
} from "@game/kernel/playerdata";
import type {
  BuildingWithExt,
  MeetingRoom,
  StatusExt,
  TradingOrder,
} from "@game/modules/building/logic/ext-types";
import type { FriendDataWithNameCard } from "@game/kernel/social-model";

/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }

/** excel mock 干员行形状 */
interface ExcelCharSkillCostRowMock { lvlUpTime: number; levelUpCost: { id: string; count: number; type: string }[] }
interface ExcelCharSkillRowMock { levelUpCostCond?: ExcelCharSkillCostRowMock[] }
interface ExcelCharRowMock { skills?: ExcelCharSkillRowMock[] }

/**
 * 会客室夹具视图
 *
 * 生成模型把 `dailyReward` 声明为必填线索对象、`mfc`/`startApCounter`/`mustgetClue` 声明为 number；
 * 测试夹具则用 null（服务端语义：今日未领，见 ext-types.MeetingRoom）与空对象/空数组占位。
 * 用例不读取后三者的数值语义，故就地登记夹具形态，写入见各 beforeEach。
 */
type MeetingRoomFixture = Omit<MeetingRoom, "mfc" | "startApCounter" | "mustgetClue"> & {
  mfc?: number | Record<string, never>;
  startApCounter?: number | Record<string, never>;
  mustgetClue?: number | never[];
};

/** 贸易订单夹具视图：`isViolated` 为夹具遗留字段（生成模型与 ext-types 均未声明，结算不读取） */
type TradingOrderFixture = TradingOrder & { isViolated?: boolean };

/** 宿舍夹具视图：生成模型的宿舍房间无 `level` 字段（夹具占位；氛围信用结算只读 comfort） */
type DormitoryFixture = PlayerBuildingDormitory & { level?: number };

/** 已删除的线索 id 递增方法视图（仅用于断言其不存在于原型上） */
type LegacyClueIdPrototype = Pick<BuildingManager, "furnCnt"> & { _nextClueId?: () => string };

// Excel BuildingData 样本（真实结构，制造/加工/房间/常量——任务 2-7 复用）
const excelMock = vi.hoisted(() => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

    BuildingData: {
      manufactFormulas: {
        "1": { formulaId: "1", itemId: "2001", count: 1, costPoint: 2700, formulaType: "F_EXP", costs: [] },
        "4": { formulaId: "4", itemId: "3003", count: 1, costPoint: 4320, formulaType: "F_GOLD", costs: [] },
        "5": {
          formulaId: "5", itemId: "3213", count: 1, costPoint: 1, formulaType: "F_ASC",
          costs: [
            { id: "3212", count: 2, type: "MATERIAL" },
            { id: "32001", count: 1, type: "MATERIAL" },
          ],
        },
        "13": {
          formulaId: "13", itemId: "3141", count: 1, costPoint: 3600, formulaType: "F_DIAMOND",
          costs: [
            { id: "30012", count: 2, type: "MATERIAL" },
            { id: "4001", count: 1600, type: "GOLD" },
          ],
        },
      },
      workshopFormulas: {
        "1": {
          formulaId: "1", itemId: "3131", count: 1, goldCost: 800, apCost: 360000,
          costs: [{ id: "3112", count: 2, type: "MATERIAL" }],
          extraOutcomeRate: 0.1,
          extraOutcomeGroup: [{ weight: 100, itemId: "3112", itemCount: 1 }],
        },
      },
      rooms: {
        MANUFACTURE: {
          phases: [
            {
              buildCost: { items: [{ id: "3131", count: 1, type: "MATERIAL" }], time: 0, labor: 10 },
              maxStationedNum: 1,
            },
            {
              buildCost: { items: [{ id: "3132", count: 2, type: "MATERIAL" }], time: 0, labor: 20 },
              maxStationedNum: 2,
            },
          ],
        },
        TRADING: {
          phases: [
            { buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 },
          ],
        },
      },
      goldItems: { "3003": 500 },
      laborRecoverTime: 360,
      basicFavorPerDay: 720,
      apToLaborRatio: 2,
      manufactReduceTimeUnit: 180,
      tradingReduceTimeUnit: 180,
    },
    CharacterTable: {
      char_001: {
        skills: [{
          levelUpCostCond: [
            { lvlUpTime: 28800, levelUpCost: [{ id: "3303", count: 5, type: "MATERIAL" }] },
            { lvlUpTime: 57600, levelUpCost: [{ id: "3303", count: 6, type: "MATERIAL" }] },
            { lvlUpTime: 86400, levelUpCost: [{ id: "3303", count: 10, type: "MATERIAL" }] },
          ],
        }],
      },
      char_1015_aglna2: {
        skills: [
          { levelUpCostCond: [{ lvlUpTime: 28800, levelUpCost: [{ id: "3303", count: 5, type: "MATERIAL" }] }] },
          {},
          {},
        ],
      },
    } as Record<string, ExcelCharRowMock>,
    // 本文件未提供的表显式占位（`?.` 读取下与「键不存在」运行时等价）
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
  },
}));
vi.mock("@excel/excel", () => excelMock);

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

// Mock 时间工具,返回固定时间戳便于断言
vi.mock("@utils/time", () => ({
  now: () => 1234567890,
}));



import { mockPlayerData, mockTypedEventEmitter, asPlayerManager, asModel, type MockSeed, type MockUpdateRecipe } from "../../helpers";
import { BuildingManager } from "@game/modules/building/logic";
import { accountManager } from "@game/modules/account/account-manager";

/**
 * BuildingManager 单元测试
 * 覆盖建筑同步、BGM 切换、宿舍归属、协助干员设置及 getter 访问器
 */
describe("BuildingManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      building: {
        status: {
          labor: {
            buffSpeed: 0,
            processPoint: 0,
            value: 0,
            lastUpdateTime: 0,
            maxValue: 100,
          },
          workshop: {
            bonusActive: 0,
            bonus: {},
          },
        },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {},
          ELEVATOR: {},
          POWER: {},
          MANUFACTURE: {},
          TRADING: {},
          CORRIDOR: {},
          WORKSHOP: {},
          DORMITORY: {},
          MEETING: {
            room_001: {
              buff: {},
              state: 0,
              speed: 0,
              processPoint: 0,
              ownStock: [],
              receiveStock: [],
              board: {
                clue_001: "1",
                clue_002: "2",
              },
              socialReward: { daily: 0, search: 0 },
              expiredReward: 0,
              received: 0,
              infoShare: { ts: 12345, reward: 0 },
              lastUpdateTime: 0,
              completeWorkTime: 0,
            },
          },
          HIRE: {},
          TRAINING: {},
          PRIVATE: {
            slot_001: {
              owners: [],
              comfort: 0,
              diySolution: {
                wallPaper: "",
                floor: "",
                carpet: [],
                other: [],
              },
            },
          },
        },
        furniture: {
          furn_001: { count: 1, inUse: 0 },
          furn_002: { count: 1, inUse: 0 },
          furn_003: { count: 2, inUse: 1 },
        },
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      event: {
        building: 0,
      },
    });

    // 夹具占位：生成模型把 dailyReward 声明为必填线索对象、mfc/startApCounter/mustgetClue 声明为 number，
    // 服务端实际以 null（今日未领）/空对象/空数组承载（见 ext-types.MeetingRoom）——在构造管理器前写入
    const meetingRoom = mockPlayer._playerdata.building!.rooms.MEETING.room_001 as MeetingRoomFixture;
    meetingRoom.dailyReward = null;
    meetingRoom.mfc = {};
    meetingRoom.startApCounter = {};
    meetingRoom.mustgetClue = [];

    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  describe("constructor", () => {
    it("应该正确初始化并注册 char:init 事件监听", () => {
      const onSpy = vi.spyOn(mockTrigger, "on");
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
      // 修复（2026-09-09，审计 §6.3-27）：原订阅 "building:char:init"（全仓无 emit 方），
      // 干员模块真正派发的是 "char:init"
      expect(onSpy).toHaveBeenCalledWith("char:init", expect.any(Function));
    });
  });

  describe("boardInfo", () => {
    it("应该返回 MEETING 房间公告板的 clue 列表", () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager.boardInfo).toEqual(["clue_001", "clue_002"]);
    });
  });

  describe("infoShare", () => {
    it("应该返回 MEETING 房间 infoShare 的时间戳", () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager.infoShare).toBe(12345);
    });
  });

  describe("furnCnt", () => {
    it("应该返回家具总数", () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager.furnCnt).toBe(3);
    });
  });

  describe("sync", () => {
    /** 下一次 4:00/16:00 重置边界（与实现一致：基于 now()——mock 为 1234567890） */
    function nextBoundary(tsSec: number): number {
      const d = new Date(tsSec * 1000);
      const at = (h: number): Date => {
        const x = new Date(d);
        x.setHours(h, 0, 0, 0);
        return x;
      };
      const nowMs = d.getTime();
      const t4 = at(4).getTime();
      const t16 = at(16).getTime();
      const t4t = at(4);
      t4t.setDate(t4t.getDate() + 1);
      return Math.floor(
        (nowMs <= t4 ? t4 : nowMs <= t16 ? t16 : t4t.getTime()) / 1000,
      );
    }

    it("应该设置 event.building 为下一次最近事件时刻（无未来 completeWorkTime 时回到 4:00/16:00 重置边界）并返回当前时间戳", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.sync();

      // 修复前：now()+5000 → 5s 轮询；真实事件时间/远未来 → 客户端沿用过期事件时间
      // 空响应紧循环。修复后：event.building = min(下一 4:00/16:00 重置边界, 最小未来
      // completeWorkTime)——mock 无未来 cwt，故回到重置边界（对齐 DoctoratePy）。
      expect(mockPlayer._playerdata.event!.building).toBe(
        nextBoundary(1234567890),
      );
      expect(result).toBe(1234567890);
    });
  });

  describe("advance", () => {
    /** 前移时间基准后按真实当前时间统一结算（now mock = 1234567890，laborRecoverTime = 360） */
    it("应前移劳动力时间基准并结算恢复量，返回当前时间戳", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      mockPlayer._playerdata.building!.status.labor.lastUpdateTime = 1234567890;
      mockPlayer._playerdata.building!.status.labor.value = 0;

      const result = await manager.advance(3600);

      // elapsed = now - (now - 3600) = 3600 → gain = floor(3600/360) = 10
      expect(mockPlayer._playerdata.building!.status.labor.value).toBe(10);
      expect(mockPlayer._playerdata.building!.status.labor.lastUpdateTime).toBe(1234567890);
      expect(result).toBe(1234567890);
    });

    it("应前移工作时间房间时间戳并在 sync 后复位，停工房间保持不动", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const building = mockPlayer._playerdata.building!;
      building.rooms.MEETING.room_001.state = 1;
      building.rooms.MEETING.room_001.lastUpdateTime = 1234567890;
      building.rooms.MEETING.room_002 = asModel<PlayerBuildingMeeting>({
        state: 0,
        lastUpdateTime: 1234567890,
      });

      await manager.advance(7200);

      // 工作时间房间：被 _touchActiveRooms 复位到当前时间
      expect(building.rooms.MEETING.room_001.lastUpdateTime).toBe(1234567890);
      // 停工房间：既不前移也不 touch，保持原值
      expect(building.rooms.MEETING.room_002.lastUpdateTime).toBe(1234567890);
    });

    it("快进秒数向下取整且至少为 1", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      mockPlayer._playerdata.building!.status.labor.lastUpdateTime = 1234567890;
      mockPlayer._playerdata.building!.status.labor.value = 0;

      await manager.advance(0.5); // floor → 0 → 钳制为 1

      // elapsed = 1 < laborRecoverTime=360 → 不产生恢复，也不推进时间戳
      expect(mockPlayer._playerdata.building!.status.labor.value).toBe(0);
      expect(mockPlayer._playerdata.building!.status.labor.lastUpdateTime).toBe(1234567889);
    });
  });

  describe("changeBGM", () => {
    it("应该更新选中 BGM ID", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.changeBGM({ musicId: "bgm_new" });

      expect(mockPlayer._playerdata.building!.music.selected).toBe("bgm_new");
    });
  });

  describe("setPrivateDormOwner", () => {
    it("应该设置私人宿舍归属干员", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.setPrivateDormOwner({
        slotId: "slot_001",
        charInstId: 1001,
      });

      expect(
        mockPlayer._playerdata.building!.rooms.PRIVATE["slot_001"].owners
      ).toEqual([1001]);
    });
  });

    it("客户端发送 CS 字段名 charInsId 时应正确写入（不再写 null 破坏存档）", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      await manager.setPrivateDormOwner({
        slotId: "slot_001",
        charInsId: 1001, // CS: BuildingPayloadSetPrivateDormOwnerRequest.charInsId
      });
      expect(
        mockPlayer._playerdata.building!.rooms.PRIVATE["slot_001"].owners
      ).toEqual([1001]);
      // 无干员时不应写 null
      await manager.setPrivateDormOwner({ slotId: "slot_001" });
      expect(
        mockPlayer._playerdata.building!.rooms.PRIVATE["slot_001"].owners
      ).toEqual([1001]);
    });

  describe("setBuildingAssist", () => {
    it("应该设置指定协助位置的干员", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.setBuildingAssist({ type: 0, charInstId: 1001 });

      expect(mockPlayer._playerdata.building!.assist[0]).toBe(1001);
    });

    it("当干员已存在于协助列表时应该先清除原位置再设置新位置", async () => {
      const manager = new BuildingManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // 预设:1001 已在位置 0
      mockPlayer._playerdata.building!.assist = [1001, -1, -1];

      // 把 1001 移到位置 1
      await manager.setBuildingAssist({ type: 1, charInstId: 1001 });

      expect(mockPlayer._playerdata.building!.assist[0]).toBe(-1);
      expect(mockPlayer._playerdata.building!.assist[1]).toBe(1001);
    });
  });

  describe("char:init 事件（新干员基建建档）", () => {
    function makeChar(instId: number, charId: string): MockSeed<PlayerCharacter> {
      return {
        instId,
        charId,
        level: 1,
        exp: 0,
        evolvePhase: 0,
        potentialRank: 0,
        favorPoint: 0,
        mainSkillLvl: 1,
        gainTime: 0,
        voiceLan: "CN_MANDARIN",
      };
    }

    it("触发 char:init 事件应该初始化建筑干员数据（官方条目形状）", async () => {
      new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
      await mockTrigger.emit("char:init", [asModel<PlayerCharacter>(makeChar(1001, "char_001"))]);

      const buildingChar =
        mockPlayer._playerdata.building!.chars["1001"];
      expect(buildingChar).toBeDefined();
      expect(buildingChar.charId).toBe("char_001");
      expect(buildingChar.ap).toBe(8640000);
      expect(buildingChar.roomSlotId).toBe("");
      expect(buildingChar.index).toBe(-1);
      expect(buildingChar.bubble.normal.add).toBe(-1);
      expect(buildingChar.bubble.assist.add).toBe(-1);
      expect(buildingChar.workTime).toBe(0);
      expect(buildingChar.privateRooms).toEqual([]);
    });

    it("char:init 幂等：已有建档（心情/私人宿舍）不被覆盖", async () => {
      const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
      await mockTrigger.emit("char:init", [asModel<PlayerCharacter>(makeChar(1001, "char_001"))]);
      // 模拟干员已进驻宿舍 + 心情已消耗 + 已分配私人宿舍
      const rec = mockPlayer._playerdata.building!.chars['1001'];
      rec.ap = 1234;
      rec.roomSlotId = "slot_1";
      rec.privateRooms = ["slot_47"];
      await mockTrigger.emit("char:init", [asModel<PlayerCharacter>(makeChar(1001, "char_001"))]);
      const after = mockPlayer._playerdata.building!.chars['1001'];
      expect(after.ap).toBe(1234);
      expect(after.roomSlotId).toBe("slot_1");
      expect(after.privateRooms).toEqual(["slot_47"]);
      expect(manager).toBeDefined();
    });
  });
});

describe("BuildingManager 内部工具方法", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 0, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {},
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("_findRoomSlotIdByChar 应找到干员所在槽位", () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.roomSlots = {
      slot_1: { level: 1, state: 2, roomId: "MANUFACTURE", charInstIds: [1001, -1], completeConstructTime: 0 },
      slot_2: { level: 1, state: 2, roomId: "TRADING", charInstIds: [1002], completeConstructTime: 0 },
    };
    expect(manager._findRoomSlotIdByChar(1001)).toBe("slot_1");
    expect(manager._findRoomSlotIdByChar(9999)).toBeUndefined();
  });

  it("_clearCharFromRooms 应从所有槽位移除指定干员", () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.roomSlots = {
      slot_1: { level: 1, state: 2, roomId: "MANUFACTURE", charInstIds: [1001, 1002], completeConstructTime: 0 },
      slot_2: { level: 1, state: 2, roomId: "TRADING", charInstIds: [1002], completeConstructTime: 0 },
    };
    manager._clearCharFromRooms([1002]);
    expect(mockPlayer._playerdata.building!.roomSlots.slot_1.charInstIds).toEqual([1001, -1]);
    expect(mockPlayer._playerdata.building!.roomSlots.slot_2.charInstIds).toEqual([-1]);
  });

  it("线索 id 已改为真实格式（不再使用递增 clue_ID 方法）", () => {
    // _nextClueId 已随线索 id 格式对齐真实存档（{uid}#{n}#{ts}）删除
    expect(typeof (BuildingManager.prototype as LegacyClueIdPrototype)._nextClueId).toBe("undefined");
  });
});

describe("BuildingManager 批量干员", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 0, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {
          slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [1001, 1002, 1003], completeConstructTime: 0 },
          slot_6: { level: 3, state: 2, roomId: "TRADING", charInstIds: [1004], completeConstructTime: 0 },
        },
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {},
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("batchChangeWorkChar 应替换指定房间的干员并清空旧位置", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchChangeWorkChar({
      roomSlotId: "slot_5",
      charInstIdList: [1004, 1005],
    });
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds).toEqual([1004, 1005]);
    expect(mockPlayer._playerdata.building!.roomSlots.slot_6.charInstIds).toEqual([-1]);
  });

  it("batchRestChar 应清空指定干员在所有房间的占用", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchRestChar({ charInstIdList: [1001, 1004] });
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds).toEqual([-1, 1002, 1003]);
    expect(mockPlayer._playerdata.building!.roomSlots.slot_6.charInstIds).toEqual([-1]);
  });

  it("batchRestChar 应自动将不在房间且心情为0的干员安排入住宿舍空位", async () => {
    // 构造宿舍空位（DORMITORY 槽位 charInstIds 中 -1 即空床）
    mockPlayer._playerdata.building!.roomSlots.slot_7 = asModel<PlayerBuildingRoomSlot>({
      level: 2, state: 2, roomId: "DORMITORY", charInstIds: [-1, -1, -1], completeConstructTime: 0,
    });
    // 心情为 0 且不在任何房间的干员 → 应被安排入住
    mockPlayer._playerdata.building!.chars["2001"] = asModel<PlayerBuildingChar>({ ap: 0 });
    mockPlayer._playerdata.building!.chars["2002"] = asModel<PlayerBuildingChar>({ ap: 0 });
    // 心情 > 0 且不在房间 → 不需休息，不应被安排
    mockPlayer._playerdata.building!.chars["2003"] = asModel<PlayerBuildingChar>({ ap: 500 });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchRestChar({});
    const dorm = mockPlayer._playerdata.building!.roomSlots.slot_7.charInstIds;
    // 2001/2002 入住空位；2003 心情充足不入住
    expect(dorm).toEqual([2001, 2002, -1]);
  });

  it("batchRestChar 应将宿舍中满心情且未锁定的干员床位视为空位（腾出给需休息干员）", async () => {
    // 宿舍 1 床已由满心情干员 2001 占据（未锁定）
    mockPlayer._playerdata.building!.roomSlots.slot_7 = asModel<PlayerBuildingRoomSlot>({
      level: 2, state: 2, roomId: "DORMITORY", charInstIds: [2001, -1, -1], completeConstructTime: 0,
    });
    mockPlayer._playerdata.building!.chars["2001"] = asModel<PlayerBuildingChar>({ ap: 8640000 }); // 心情已满
    mockPlayer._playerdata.building!.chars["2002"] = asModel<PlayerBuildingChar>({ ap: 0 });       // 需休息
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchRestChar({});
    const dorm = mockPlayer._playerdata.building!.roomSlots.slot_7.charInstIds;
    // 2001 满心情未锁定 → 床位作废让给 2002（空床也填满）
    expect(dorm).toEqual([2002, -1, -1]);
  });

  it("batchRestChar 不得腾出已锁定宿舍的满心情干员床位", async () => {
    mockPlayer._playerdata.building!.roomSlots.slot_7 = asModel<PlayerBuildingRoomSlot>({
      level: 2, state: 2, roomId: "DORMITORY", charInstIds: [2001, -1, -1], completeConstructTime: 0,
    });
    mockPlayer._playerdata.building!.chars["2001"] = asModel<PlayerBuildingChar>({ ap: 8640000 }); // 满心情
    mockPlayer._playerdata.building!.chars["2002"] = asModel<PlayerBuildingChar>({ ap: 0 });       // 需休息
    // 锁定该宿舍（私服扩展 building.presetQueues[slotId].locked）
    (mockPlayer._playerdata.building as BuildingWithExt).presetQueues = { slot_7: { locked: true } };
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchRestChar({});
    const dorm = mockPlayer._playerdata.building!.roomSlots.slot_7.charInstIds;
    // 锁定宿舍的满心情床位不可动；2002 只能入住剩余空床
    expect(dorm).toEqual([2001, 2002, -1]);
  });

  it("cleanRoomSlot 应清空房间全部干员", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.cleanRoomSlot({ roomSlotId: "slot_5" });
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds).toEqual([-1, -1, -1]);
  });
});

describe("BuildingManager 信赖系统", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 0, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {
          slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [1001, 1002], completeConstructTime: 0 },
        },
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {},
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [1003, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      troop: {
        chars: {
          "1001": { charId: "char_001", favorPoint: 100 },
          "1002": { charId: "char_002", favorPoint: 200 },
          "1003": { charId: "char_003", favorPoint: 300 },
        },
        charGroup: {
          char_001: { favorPoint: 100 },
          char_002: { favorPoint: 200 },
          char_003: { favorPoint: 300 },
        },
      },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("gainIntimacy 应给指定干员加信赖（同步 chars 与 charGroup）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.gainIntimacy({ charInstId: 1001 });
    expect(mockPlayer._playerdata.troop!.chars["1001"].favorPoint).toBeGreaterThan(100);
    expect(mockPlayer._playerdata.troop!.charGroup.char_001.favorPoint).toBeGreaterThan(100);
    expect(mockPlayer._playerdata.troop!.chars["1002"].favorPoint).toBe(200);
  });

  it("gainIntimacy 信赖量由 basicFavorPerDay 派生（720/60=12）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.gainIntimacy({ charInstId: 1001 });
    expect(mockPlayer._playerdata.troop!.chars["1001"].favorPoint).toBe(112); // 100 + 12
  });

  it("gainAllIntimacy 应给全部工作干员加信赖", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.gainAllIntimacy({});
    expect(mockPlayer._playerdata.troop!.chars["1001"].favorPoint).toBeGreaterThan(100);
    expect(mockPlayer._playerdata.troop!.chars["1002"].favorPoint).toBeGreaterThan(200);
    // 修复：assist 干员同步结算（CS BuildingGainAllIntimacyResponse 含 assist 计数）
    expect(mockPlayer._playerdata.troop!.chars["1003"].favorPoint).toBeGreaterThan(300);
  });

  it("gainAllIntimacy 应返回 normal/assist 计数（CS BuildingGainAllIntimacyResponse）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const { normal, assist } = await manager.gainAllIntimacy({});
    expect(normal).toBe(2); // slot_5 的 1001/1002
    expect(assist).toBe(1); // assist 列表的 1003
  });

  it("gainAssistIntimacy 应给助战列表干员加信赖", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.gainAssistIntimacy({} as Parameters<BuildingManager["gainAssistIntimacy"]>[0]);
    expect(mockPlayer._playerdata.troop!.chars["1003"].favorPoint).toBeGreaterThan(300);
  });
});

describe("BuildingManager 贸易站", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 0, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {
   slot_6: {
     strategy: "O_GOLD",
     stock: asModel<TradingOrderFixture[]>([
       {
         instId: 28207,
         delivery: [{ id: "3003", type: "MATERIAL", count: 3 }],
         type: "O_GOLD",
         gain: { id: "4001", type: "GOLD", count: 1500 },
         buff: [],
         isViolated: true,
       },
       {
         instId: 28208,
         delivery: [{ id: "3003", type: "MATERIAL", count: 4 }],
         type: "O_GOLD",
         gain: { id: "4001", type: "GOLD", count: 2000 },
         buff: [],
         isViolated: true,
       },
     ]),
     stockLimit: 6,
     completeWorkTime: 0,
   },
 },
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      status: { gold: 1000 },
      inventory: { "3003": 10 },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("settleSale 应按 delivery/gain 结算全部订单（扣 3003 加 4001 金币）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleSale({ slotId: "slot_6" });
    expect(mockPlayer._playerdata.building!.rooms.TRADING.slot_6.stock).toEqual([]);
    // 消耗交付物 3003（3+4=7，初始 10 → 3）
    expect(mockPlayer._playerdata.inventory!["3003"]).toBe(3);
    // 收益按 gain（1500+2000=3500，初始 1000 → 4500）
    expect(mockPlayer._playerdata.status!.gold).toBe(4500);
  });

  it("changeSaleSolution 应更新策略与库存上限", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.changeSaleSolution({ slotId: "slot_6", solution: { strategy: "O_LMD", stockLimit: 8 } });
    expect(mockPlayer._playerdata.building!.rooms.TRADING.slot_6.strategy).toBe("O_LMD");
    expect(mockPlayer._playerdata.building!.rooms.TRADING.slot_6.stockLimit).toBe(8);
  });

  it("deleteOrder 应移除指定订单（按 instId）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.deleteOrder({ slotId: "slot_6", orderId: 28207 });
    expect(mockPlayer._playerdata.building!.rooms.TRADING.slot_6.stock).toHaveLength(1);
    expect(mockPlayer._playerdata.building!.rooms.TRADING.slot_6.stock[0].instId).toBe(28208);
  });

  it("accelerateOrder 应按 delivery/gain 结算指定订单（并消耗无人机）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 修复（2026-09-09）：加速消耗无人机（labor）——给足余额后应结算并扣 1 架
    mockPlayer._playerdata.building!.status.labor.value = 5;
    await manager.accelerateOrder({ slotId: "slot_6", orderId: 28207 });
    expect(mockPlayer._playerdata.building!.rooms.TRADING.slot_6.stock).toHaveLength(1);
    expect(mockPlayer._playerdata.inventory!["3003"]).toBe(7); // 10 - 3
    expect(mockPlayer._playerdata.status!.gold).toBe(2500); // 1000 + 1500
    expect(mockPlayer._playerdata.building!.status.labor.value).toBe(4); // 5 - 1 架
  });

  it("accelerateOrder 无人机不足时不应结算订单", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.status.labor.value = 0;
    await manager.accelerateOrder({ slotId: "slot_6", orderId: 28207 });
    // 订单保留、无收益、无人机不变
    expect(mockPlayer._playerdata.building!.rooms.TRADING.slot_6.stock).toHaveLength(2);
    expect(mockPlayer._playerdata.status!.gold).toBe(1000);
    expect(mockPlayer._playerdata.building!.status.labor.value).toBe(0);
  });

  it("accelerateSolution 应加速制造站方案（消耗无人机、不扣源石碎片）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 修复（2026-09-09）：加速消耗无人机（1 架 = 3 分钟）；给足余额
    mockPlayer._playerdata.building!.status.labor.value = 200;
    // 给 mock 加一个开工的制造站
    mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_25"] = asModel<PlayerBuildingManufacture>({
      state: 1,
      formulaId: "4",
      remainSolutionCnt: 5,
      outputSolutionCnt: 0,
      processPoint: 0,
      lastUpdateTime: 0,
      completeWorkTime: 0,
      capacity: 1,
    });
    mockPlayer._playerdata.status.diamondShard = 1000;
    await manager.accelerateSolution({ slotId: "slot_25", cost: 145 });
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_25"];
    expect(room.outputSolutionCnt).toBe(5);
    expect(room.remainSolutionCnt).toBe(0);
    // 修复：cost 为客户端无人机数，服务端不扣源石碎片（原实现 1000 → 855）
    expect(mockPlayer._playerdata.status!.diamondShard).toBe(1000);
    // 修复（2026-09-09）：消耗 145 架无人机
    expect(mockPlayer._playerdata.building!.status.labor.value).toBe(55); // 200 - 145
  });

  it("accelerateSolution 无人机不足时不应加速（方案保留）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_25"] = asModel<PlayerBuildingManufacture>({
      state: 1,
      formulaId: "4",
      remainSolutionCnt: 5,
      outputSolutionCnt: 0,
      processPoint: 0,
      lastUpdateTime: 0,
      completeWorkTime: 0,
      capacity: 1,
    });
    mockPlayer._playerdata.building!.status.labor.value = 10; // < 145
    await manager.accelerateSolution({ slotId: "slot_25", cost: 145 });
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_25"];
    expect(room.outputSolutionCnt).toBe(0);
    expect(room.remainSolutionCnt).toBe(5);
    expect(mockPlayer._playerdata.building!.status.labor.value).toBe(10);
  });

  it("accelerateSolution 无可加速方案（未开工）不应报错且不改状态", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.status.diamondShard = 1000;
    await manager.accelerateSolution({ slotId: "slot_25", cost: 145 });
    expect(mockPlayer._playerdata.status!.diamondShard).toBe(1000);
  });
});

describe("BuildingManager 制造站（Excel 驱动）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, TRADING: {},
          MANUFACTURE: {
            slot_5: {
              state: 1,
              formulaId: "4",
              remainSolutionCnt: 73,
              outputSolutionCnt: 2,
              lastUpdateTime: 0,
              completeWorkTime: -1,
              capacity: 24,
            },
          },
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      status: { gold: 10000 },
      inventory: { "3212": 10, "32001": 5, "30012": 10 },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("settleManufacture F_GOLD（formulaId 4）应产出 3003×outputSolutionCnt 并重置状态", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"] });
    expect(mockPlayer._playerdata.inventory!["3003"]).toBe(2);
    // lastUpdateTime=0 → (0 || ts)=ts → elapsed 0 → 无累积产出；已产出 2 收获后
    // 计划未耗尽（remain 仍 73 > 0）→ 保留配方继续生产（修复"清空当前计划"）
    expect(mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5.state).toBe(1);
    expect(mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5.formulaId).toBe("4");
    expect(mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5.remainSolutionCnt).toBe(73);
  });

  it("settleManufacture F_EXP（formulaId 1）应产出 2001", async () => {
    mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.formulaId = "1";
    mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.outputSolutionCnt = 3;
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"] });
    expect(mockPlayer._playerdata.inventory!["2001"]).toBe(3);
  });

  it("settleManufacture F_ASC（formulaId 5）应产出 3213 并消耗 3212×2 + 32001×1", async () => {
    mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.formulaId = "5";
    mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.outputSolutionCnt = 1;
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"] });
    expect(mockPlayer._playerdata.inventory!["3213"]).toBe(1);
    expect(mockPlayer._playerdata.inventory!["3212"]).toBe(8);
    expect(mockPlayer._playerdata.inventory!["32001"]).toBe(4);
  });

  it("settleManufacture F_DIAMOND（formulaId 13）应产出 3141 并扣金币 1600×n", async () => {
    mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.formulaId = "13";
    mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.outputSolutionCnt = 1;
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"] });
    expect(mockPlayer._playerdata.inventory!["3141"]).toBe(1);
    expect(mockPlayer._playerdata.inventory!["30012"]).toBe(8);
    expect(mockPlayer._playerdata.status!.gold).toBe(8400);
  });

  it("settleManufacture 未知配方应跳过（不崩溃）", async () => {
    mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.formulaId = "999";
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"] });
    // 未知配方跳过 → 计划未耗尽保留（不崩溃）
    expect(mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5.state).toBe(1);
  });
});

describe("BuildingManager 加工分解与专精", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    // 本组测试验证真实训练室专精路径：禁用 config 的即时完成开发开关，保证走训练等待逻辑
    config.developer!.specializationTimeZero = false;
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 0, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {},
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {
            slot_13: {
              trainee: { charInstId: -1, state: 0, targetSkill: -1, processPoint: 0, speed: 1 },
              trainer: { charInstId: -1, state: 0 },
            },
          },
          PRIVATE: {},
        },
        furniture: {
          furn_001: { count: 3, inUse: 1 },
        },
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      inventory: { "30012": 1, "3303": 20 },
      troop: {
        chars: {
          "1001": {
            charId: "char_001",
            evolvePhase: 2, mainSkillLvl: 7,
            skills: [{ skillId: "skill_1", unlock: 1, state: 0, specializeLevel: 0, completeUpgradeTime: -1 }],
          },
        },
      },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("workshopDecomposition 应分解家具并增加材料", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.workshopDecomposition({ furnitureId: "furn_001", count: 1 });
    expect(mockPlayer._playerdata.building!.furniture.furn_001.count).toBe(2);
    expect(mockPlayer._playerdata.inventory!["30012"]).toBeGreaterThan(1);
  });

  it("upgradeSpecialization 应记录专精目标（state=1）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.upgradeSpecialization({ charInstId: 1001, targetSkill: 0 });
    expect(mockPlayer._playerdata.troop!.chars["1001"].skills[0].state).toBe(1);
  });

  it("upgradeSpecialization 训练目标 trainee.speed 应为官方基础速度 1（修复前硬编码 1000）", async () => {
    mockPlayer._playerdata.building!.rooms.TRAINING.slot_13 = asModel<PlayerBuildingTraining>({
      trainee: { charInstId: -1, state: 0, targetSkill: -1, processPoint: 0, speed: 1 },
      trainer: { charInstId: -1, state: 0 },
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.upgradeSpecialization({ charInstId: 1001, targetSkill: 0 });
    const trainee = mockPlayer._playerdata.building!.rooms.TRAINING.slot_13.trainee;
    expect(trainee.state).toBe(1); // TRAINING
    expect(trainee.targetSkill).toBe(0);
    // 官方模型（4.json 官服快照空态 speed=1、2222 训练中 1.65）；1000 会使 processPoint
    // 秒涨 1000 → 客户端 (total-processPoint)/speed 剩余时间异常
    expect(trainee.speed).toBe(1);
  });

  it("completeUpgradeSpecialization 应提升 specializeLevel 并复位", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.upgradeSpecialization({ charInstId: 1001, targetSkill: 0 });
    // 训练时长门控：带 maxPoint 的 trainee 仅 state=2（待领取）可结算——模拟训练完成
    mockPlayer._playerdata.building.rooms.TRAINING.slot_13.trainee.state = 2;
    await manager.completeUpgradeSpecialization({ charInstId: 1001, targetSkill: 0 });
    const skill = mockPlayer._playerdata.troop!.chars["1001"].skills[0];
    expect(skill.specializeLevel).toBe(1);
    expect(skill.state).toBe(0);
    expect(skill.completeUpgradeTime).toBe(-1);
  });

  afterEach(() => {
    // 恢复开发开关，避免污染共享 config 单例影响其他用例
    config.developer!.specializationTimeZero = true;
  });
});

describe("BuildingManager 加工站合成（Excel 驱动）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, TRADING: {},
          MANUFACTURE: { slot_5: { formulaId: "" } },
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      status: { gold: 10000 },
      inventory: { "3112": 10 },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("workshopSynthesis 应按 workshopFormulas 扣材料/金币并产出", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // > extraOutcomeRate 0.1，不触发副产物
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const result = await manager.workshopSynthesis({ roomSlotId: "slot_5", times: 1, formulaId: "1" });
    expect(mockPlayer._playerdata.inventory!["3112"]).toBe(8); // 10 - 2
    expect(mockPlayer._playerdata.status!.gold).toBe(9200); // 10000 - 800
    expect(mockPlayer._playerdata.inventory!["3131"]).toBe(1);
    expect(result).toEqual({ type: "MATERIAL", id: "3131", count: 1 });
  });

  it("workshopSynthesis 副产物概率触发时额外产出（extraOutcomeGroup 加权）", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.05); // < extraOutcomeRate 0.1
    // 官方（2026-08-25 对齐）：无进驻干员时副产物概率锁定 0%——需进驻加工站干员
    const b = mockPlayer._playerdata.building!;
    b.roomSlots.slot_ws = asModel<PlayerBuildingRoomSlot>({ level: 1, state: 2, roomId: "WORKSHOP", charInstIds: [7], completeConstructTime: -1 });
    b.chars["7"] = asModel<PlayerBuildingChar>({ charId: "char_test", ap: 8640000, lastApAddTime: 0, roomSlotId: "slot_ws", index: 0, changeScale: 0, bubble: {} });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.workshopSynthesis({ roomSlotId: "slot_5", times: 1, formulaId: "1" });
    expect(mockPlayer._playerdata.inventory!["3112"]).toBe(9); // 10 - 2 + 副产物 1
  });

  it("workshopSynthesis 未知配方应跳过（不崩溃）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const result = await manager.workshopSynthesis({ roomSlotId: "slot_5", times: 1, formulaId: "999" });
    expect(result).toBeNull();
    expect(mockPlayer._playerdata.inventory!["3112"]).toBe(10);
  });
});

describe("BuildingManager 线索系统", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 0, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {},
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {
            room_001: {
              ownStock: [],
              receiveStock: [],
              board: {},
              socialReward: { daily: 0, search: 0 },
            },
          }, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      status: { uid: "1", nickName: "A", nickNumber: "1" },
      pushFlags: { hasGifts: 0, hasFriendRequest: 0, hasClues: 0, hasFreeLevelGP: 0, status: 0 },
      event: { building: 0 },
    });
    // 夹具占位：dailyReward/mustgetClue 的服务端实际形态见 MeetingRoomFixture（构造管理器前写入）
    const meetingRoom = mockPlayer._playerdata.building!.rooms.MEETING.room_001 as MeetingRoomFixture;
    meetingRoom.dailyReward = null;
    meetingRoom.mustgetClue = [];
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
    // getClueFriendList 依赖 accountManager
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({ friends: [], friendRequests: [], visited: [] });
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockResolvedValue(
      asModel<FriendDataWithNameCard>({ uid: "2", nickName: "B", nickNumber: "1", level: 1 }),
    );
    // _accrueCharAp 用 Date.now()（毫秒级 elapsed）→ 与 now() mock 对齐（1234567890s = 1234567890000ms）
    vi.spyOn(Date, "now").mockReturnValue(1234567890000);
  });

  /**
   * 会客室进驻 1 名干员。
   * B11（PRTS《罗德岛基建/会客室》）：「仅在有干员进驻时，每日 4:00 可发放 1 份
   * 会客室线索」——未进驻不发放，故 getDailyClue 基线用例需先派驻。
   */
  function stationMeetingChar() {
    const b = mockPlayer._playerdata.building!;
    b.roomSlots.meeting_01 = asModel<PlayerBuildingRoomSlot>({
      level: 1, state: 2, roomId: "MEETING", charInstIds: [9001], completeConstructTime: -1,
    });
    b.chars["9001"] = asModel<PlayerBuildingChar>({
      charId: "char_meet", ap: 8640000, lastApAddTime: 0,
      roomSlotId: "meeting_01", index: 0, changeScale: 0, bubble: {},
    });
    mockPlayer._playerdata.troop = asModel<PlayerTroop>({
      chars: { "9001": { charId: "char_meet", level: 10, evolvePhase: 0 } },
      charGroup: {},
    });
  }

  it("getDailyClue 应获得一条每日线索", async () => {
    stationMeetingChar();
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getDailyClue({});
    const room = mockPlayer._playerdata.building!.rooms.MEETING.room_001;
    expect(room.ownStock).toHaveLength(1);
    expect(room.dailyReward).not.toBeNull();
  });

  it("getDailyClue 应生成阵营线索（type ∈ 7 阵营、id {uid}#{n}#{ts}）", async () => {
    stationMeetingChar();
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getDailyClue({});
    const clue = mockPlayer._playerdata.building!.rooms.MEETING.room_001.dailyReward;
    expect([
      "RHINE", "PENGUIN", "BLACKSTEEL", "URSUS",
      "GLASGOW", "KJERAG", "RHODES",
    ]).toContain(clue.type);
    expect(clue.id).toMatch(/^\d+#\d+#\d+$/);
  });

  // B11（PRTS《罗德岛基建/会客室》）：「仅在有干员进驻时，每日 4:00 可发放 1 份
  // 会客室线索」——原实现无进驻校验，空会客室照常发放。
  it("getDailyClue 未进驻干员不发放", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getDailyClue({});
    const room = mockPlayer._playerdata.building!.rooms.MEETING.room_001;
    expect(room.ownStock).toHaveLength(0);
    expect(room.dailyReward ?? null).toBeNull();
    expect((mockPlayer._playerdata.status).socialPoint ?? 0).toBe(0);
  });

  // B11（PRTS《罗德岛基建/会客室》）：「最多存储 10 份，达到上限时无法继续入库」；
  // 每日发放的线索不适用干员搜集的「滞留」规则，满库即不入库（dailyReward 不置位 →
  // 腾空后当日仍可领取，避免永久损失）。
  it("getDailyClue 自有库满（10）不入库，腾空后可再领", async () => {
    stationMeetingChar();
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = Array.from(
      { length: 10 },
      (_, i) => ({
        id: `1#${i}#0`, type: "RHINE", number: 1, uid: "1", name: "A", nickNum: "1",
        chars: [], inUse: 0, ts: 0,
      }),
    );
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getDailyClue({});
    expect((mockPlayer._playerdata.building!.rooms.MEETING.room_001).ownStock).toHaveLength(10);
    expect((mockPlayer._playerdata.building!.rooms.MEETING.room_001).dailyReward ?? null).toBeNull();
    // 腾出 1 个空位 → 当日仍可领取
    (mockPlayer._playerdata.building!.rooms.MEETING.room_001).ownStock.pop();
    await manager.getDailyClue({});
    expect((mockPlayer._playerdata.building!.rooms.MEETING.room_001).ownStock).toHaveLength(10);
    expect((mockPlayer._playerdata.building!.rooms.MEETING.room_001).dailyReward).not.toBeNull();
  });

  it("getDailyClue 应在线索写入过期时间戳 ts（修复前 ownStock 无 ts → 永不销毁）", async () => {
    stationMeetingChar();
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getDailyClue({});
    const clue = mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock[0];
    // now() mock = 1234567890；缺省 expiredDays = 10 → ts = now + 864000
    expect(clue.ts).toBe(1234567890 + 10 * 86400);
  });

  it("getDailyClue 重复调用不应重复发线索", async () => {
    stationMeetingChar();
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getDailyClue({});
    await manager.getDailyClue({});
    expect(mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock).toHaveLength(1);
  });

  it("dailyRefresh 应重置每日线索（dailyReward=null——修复后每日可再领）", async () => {
    stationMeetingChar();
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getDailyClue({});
    expect(mockPlayer._playerdata.building!.rooms.MEETING.room_001.dailyReward).not.toBeNull();
    // 每日刷新 → dailyReward 复位 → 可再次领取
    await manager.dailyRefresh();
    expect(mockPlayer._playerdata.building!.rooms.MEETING.room_001.dailyReward).toBeNull();
    await manager.getDailyClue({});
    expect(mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock).toHaveLength(2);
  });

  it("dailyRefresh 应自动移除已过期的好友赠送线索", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock = [
      // 已过期
      { id: "clue_expired", type: "PENGUIN", number: 1, uid: "2", name: "B", nickNum: "1", chars: [], inUse: 0, ts: 1234567890 - 1 },
      // 未过期
      { id: "clue_alive", type: "URSUS", number: 1, uid: "3", name: "C", nickNum: "1", chars: [], inUse: 0, ts: 1234567890 + 9999 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.dailyRefresh();
    expect(
      mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock.map((c) => c.id),
    ).toEqual(["clue_alive"]);
  });

  it("sendClue 应将线索从 ownStock 移到 receiveStock", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      { id: "clue_001", type: "clue_1", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sendClue({ id: "clue_001", friendId: "2" });
    const room = mockPlayer._playerdata.building!.rooms.MEETING.room_001;
    expect(room.ownStock).toHaveLength(0);
    expect(room.receiveStock).toHaveLength(1);
  });

  it("sendClue 应在线索写入过期时间戳 ts（now + expiredDays×86400）", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      { id: "clue_001", type: "RHINE", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sendClue({ id: "clue_001", friendId: "2" });
    const clue = mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock[0];
    // now() mock = 1234567890；缺省 expiredDays = 10 → ts = now + 864000
    expect(clue.ts).toBe(1234567890 + 10 * 86400);
  });

  it("sendClueAuto 应在线索写入过期时间戳 ts", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      { id: "clue_001", type: "RHINE", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sendClueAuto({});
    const clue = mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock[0];
    expect(clue.ts).toBe(1234567890 + 10 * 86400);
  });

  it("getClueBox 应自动移除已过期（ts ≤ now）的好友赠送线索", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      { id: "clue_own", type: "RHINE", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0 },
    ];
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock = [
      // 已过期（ts 早于 now=1234567890）
      { id: "clue_expired", type: "PENGUIN", number: 1, uid: "2", name: "B", nickNum: "1", chars: [], inUse: 0, ts: 1234567890 - 1 },
      // 未过期（ts 晚于 now）
      { id: "clue_alive", type: "URSUS", number: 1, uid: "3", name: "C", nickNum: "1", chars: [], inUse: 0, ts: 1234567890 + 9999 },
      // 无 ts（旧存档）→ 视为未过期
      { id: "clue_no_ts", type: "RHODES", number: 1, uid: "4", name: "D", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const box = await manager.getClueBox();
    // 过期线索被移除 → box 仅含 own + 未过期 receive（3 条）
    expect(box.box).toHaveLength(3);
    const ids = box.box.map((c: PlayerBuildingMeetingClue) => c.id);
    expect(ids).not.toContain("clue_expired");
    expect(ids).toContain("clue_own");
    expect(ids).toContain("clue_alive");
    expect(ids).toContain("clue_no_ts");
    // 已落盘：receiveStock 同样清理
    expect(
      mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock.map((c) => c.id),
    ).toEqual(["clue_alive", "clue_no_ts"]);
  });

  it("getClueBox 对无过期线索的线索盒不做任何移除", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock = [
      { id: "clue_alive", type: "URSUS", number: 1, uid: "3", name: "C", nickNum: "1", chars: [], inUse: 0, ts: 1234567890 + 9999 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const box = await manager.getClueBox();
    expect(box.box).toHaveLength(1);
    expect(
      mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock,
    ).toHaveLength(1);
  });

  it("getClueBox 应自动移除 ownStock 中已过期（ts ≤ now）的线索", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      // 已过期（ts 早于 now=1234567890）
      { id: "own_expired", type: "RHINE", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0, ts: 1234567890 - 1 },
      // 未过期
      { id: "own_alive", type: "URSUS", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0, ts: 1234567890 + 9999 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const box = await manager.getClueBox();
    const ids = box.box.map((c: PlayerBuildingMeetingClue) => c.id);
    expect(ids).not.toContain("own_expired");
    expect(ids).toContain("own_alive");
    // 已落盘：ownStock 同样清理（修复前仅清理 receiveStock → ownStock 过期线索永存）
    expect(
      mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock.map((c) => c.id),
    ).toEqual(["own_alive"]);
  });

  it("getClueBox 应为无 ts 的旧线索补写过期时间戳（客户端剩余时长可显示）", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      // 旧存档/修复前 getDailyClue 生成的线索：无 ts → 客户端无剩余时长、永不过期
      { id: "old_clue", type: "RHINE", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const box = await manager.getClueBox();
    expect(box.box).toHaveLength(1);
    // 补写 ts = now + expiredDays×86400（now mock=1234567890，缺省 10 天）
    expect(box.box[0].ts).toBe(1234567890 + 10 * 86400);
    // 已落盘
    expect(
      mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock[0].ts,
    ).toBe(1234567890 + 10 * 86400);
  });

  it("getClueBox 应销毁上板过期线索并清除留言板索引（不留孤儿槽位）", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      // 上板且已过期（inUse=1, ts ≤ now）
      { id: "board_expired", type: "RHINE", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 1, ts: 1234567890 - 1 },
      // 上板未过期
      { id: "board_alive", type: "URSUS", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 1, ts: 1234567890 + 9999 },
    ];
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.board = {
      RHINE: "board_expired",
      URSUS: "board_alive",
      PENGUIN: "ghost_id", // 孤儿索引：指向不存在的线索
    };
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const box = await manager.getClueBox();
    const ids = box.box.map((c: PlayerBuildingMeetingClue) => c.id);
    expect(ids).not.toContain("board_expired");
    expect(ids).toContain("board_alive");
    // 上板过期线索被销毁 → board 对应索引清除；孤儿索引一并清除
    expect(
      mockPlayer._playerdata.building!.rooms.MEETING.room_001.board,
    ).toEqual({ URSUS: "board_alive" });
  });

  it("getInfoShareReward 应推进会客室干员体力累积（官方响应 delta 必含 building.chars）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building.chars = asModel<PlayerBuilding["chars"]>({
      1001: {
        charId: "char_001", lastApAddTime: 1234567890 - 100, ap: 0,
        roomSlotId: "slot_36", index: 0, changeScale: 100,
        bubble: {}, workTime: 0, privateRooms: [],
      },
      // changeScale=0 的干员不推进（空闲/未在会客室）
      1002: {
        charId: "char_002", lastApAddTime: 1234567890 - 100, ap: 100,
        roomSlotId: "", index: -1, changeScale: 0,
        bubble: {}, workTime: 0, privateRooms: [],
      },
    });
    const result = await manager.getInfoShareReward();
    expect(result.list).toEqual([]); // 无好友
    const ch1 = mockPlayer._playerdata.building.chars["1001"];
    expect(ch1.ap).toBe(100 * 100); // 100 秒 × 100 scale
    expect(ch1.lastApAddTime).toBe(1234567890);
    // changeScale=0 干员 ap 不变
    const ch2 = mockPlayer._playerdata.building.chars["1002"];
    expect(ch2.ap).toBe(100);
  });

  it("receiveClueToStock 应将接收的线索转入库存", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock = [
      { id: "clue_001", type: "clue_1", number: 1, uid: "2", name: "B", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.receiveClueToStock({ id: "clue_001" });
    const room = mockPlayer._playerdata.building!.rooms.MEETING.room_001;
    expect(room.receiveStock).toHaveLength(0);
    expect(room.ownStock).toHaveLength(1);
  });

  it("putClueToTheBoard 应放置线索到留言板（官方 board={[阵营]:线索id}，线索保留库存 inUse=1）", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      { id: "clue_001", type: "RHINE", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.putClueToTheBoard({ id: "clue_001" });
    const room = mockPlayer._playerdata.building!.rooms.MEETING.room_001;
    // 修复：官方 board 键为阵营（原实现键为线索 id）
    expect(room.board["RHINE"]).toBe("clue_001");
    // 修复：线索保留在库存（inUse=1 标记上板，原实现 splice 移除）
    expect(room.ownStock).toHaveLength(1);
    expect(room.ownStock[0].inUse).toBe(1);
  });

  it("deleteOwnClue 应删除自己持有的线索", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      { id: "clue_001", type: "clue_1", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.deleteOwnClue({ id: "clue_001" });
    expect(mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock).toHaveLength(0);
  });

  it("getClueBox 应返回 ownStock 与 receiveStock 合并盒", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = [
      { id: "clue_001", type: "clue_1", number: 1, uid: "1", name: "A", nickNum: "1", chars: [], inUse: 0 },
    ];
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.receiveStock = [
      { id: "clue_002", type: "clue_2", number: 1, uid: "2", name: "B", nickNum: "1", chars: [], inUse: 0 },
    ];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const box = await manager.getClueBox();
    expect(box.box).toHaveLength(2);
  });

  it("getClueFriendList 应返回好友列表", async () => {
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [{ uid: "2", alias: "" }],
      friendRequests: [],
      visited: [],
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const result = await manager.getClueFriendList();
    expect(result.result).toHaveLength(1);
    expect(result.result[0].uid).toBe("2");
  });
});

describe("BuildingManager 预设队列", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 0, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {
          slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [-1, -1], completeConstructTime: 0 },
        },
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, TRADING: {},
          MANUFACTURE: {
            slot_5: {
              state: 1,
              formulaId: "4",
              remainSolutionCnt: 73,
              outputSolutionCnt: 0,
              lastUpdateTime: 0,
              completeWorkTime: -1,
              capacity: 54,
              presetQueue: [[1001, 1002]],
            },
          },
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("addPresetQueue 应把房间当前排班追加为预设队列（官方模型 room.presetQueue）", async () => {
    (mockPlayer._playerdata.building!.roomSlots).slot_5.charInstIds = [1001, 1002];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.addPresetQueue({ slotId: "slot_5" });
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    expect(room.presetQueue).toEqual([[1001, 1002], [1001, 1002]]);
  });

  it("deletePresetQueue 应按索引删除", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    room.presetQueue = [[1001], [1002], [1003]];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.deletePresetQueue({ slotId: "slot_5", index: 1 });
    // update 替换 building 对象 → 重新读取
    const after = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    expect(after.presetQueue).toEqual([[1001], [1003]]);
  });

  it("usePresetQueue 应按索引应用预设干员到房间", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    room.presetQueue = [[1001, 1002], [2001, 2002]];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.usePresetQueue({ slotId: "slot_5", index: 1 });
    // update 替换 building 对象 → 重新读取
    const after = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    expect(after.presetQueue).toEqual([[1001, 1002], [2001, 2002]]);
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds).toEqual([2001, 2002]);
  });

  it("useOnePresetQueue 应应用房间内中心情相对高的预设（自动选心情最高组）", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    // 两组预设；第 2 组干员心情(ap)总和更高 → 应自动当选
    room.presetQueue = [[1001, 1002], [2001, 2002]];
    const chars = mockPlayer._playerdata.building!.chars;
    chars["1001"] = asModel<PlayerBuildingChar>({ ap: 1000 });
    chars["1002"] = asModel<PlayerBuildingChar>({ ap: 1000 });
    chars["2001"] = asModel<PlayerBuildingChar>({ ap: 5000 });
    chars["2002"] = asModel<PlayerBuildingChar>({ ap: 5000 });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.useOnePresetQueue({ slotId: "slot_5" });
    // 应自动应用心情更高的第 2 组（2001,2002）
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds).toEqual([2001, 2002]);
  });

  it("useOnePresetQueue 无预设队列时不变更排班（不 500）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds = [1001, 1002];
    await manager.useOnePresetQueue({ slotId: "slot_5" });
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds).toEqual([1001, 1002]);
  });

  it("changePresetName 应记录名称到元数据（官方线格式无名称）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.changePresetName({ slotId: "slot_5", presetName: "金条班" });
    expect((mockPlayer._playerdata.building! as BuildingWithExt).presetQueues!.slot_5.name).toBe("金条班");
  });
});

describe("BuildingManager 劳动力与留言板奖励", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: {
          labor: { buffSpeed: 0, processPoint: 0, value: 50, lastUpdateTime: 0, maxValue: 225 },
          workshop: { bonusActive: 0, bonus: {} },
        },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {},
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {
            room_001: {
              board: { clue_001: "clue_001" },
              socialReward: { daily: 10, search: 5 },
              received: 0,
              messageLeave: {
                inUse: true,
                lastVisitTs: 0,
                lastShowTs: 0,
                lastUpdateSpTs: 0,
                sp: { lastWeek: 300, lastWeekSum: 0, thisWeek: 90, thisWeekSum: 0 },
              },
            },
          }, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      status: { gold: 1000, androidDiamond: 100, socialPoint: 38 },
      inventory: {},
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("buyLabor 应消耗源石并增加劳动力", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.buyLabor({ buyCount: 1 });
    expect(mockPlayer._playerdata.building!.status.labor.value).toBeGreaterThan(50);
    expect(mockPlayer._playerdata.status!.androidDiamond).toBeLessThan(100);
  });

  it("sync 应按 laborRecoverTime 自动恢复劳动力", async () => {
    // lastUpdateTime = now() - 3600（360 秒 1 点 → 恢复 10 点）
    mockPlayer._playerdata.building.status.labor.lastUpdateTime = 1234567890 - 3600;
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    expect(mockPlayer._playerdata.building!.status.labor.value).toBe(60); // 50 + 10
    expect(mockPlayer._playerdata.building!.status.labor.lastUpdateTime).toBe(1234567890);
  });

  it("sync 恢复劳动力不应超过 maxValue 上限", async () => {
    mockPlayer._playerdata.building.status.labor.value = 220;
    mockPlayer._playerdata.building.status.labor.maxValue = 225;
    mockPlayer._playerdata.building.status.labor.lastUpdateTime = 1234567890 - 7200;
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    expect(mockPlayer._playerdata.building!.status.labor.value).toBe(225); // 封顶
  });

  it("confirmMessageBoardReward 应领取 messageLeave.sp.lastWeek 社交点（SOCIAL_PT）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const reward = await manager.confirmMessageBoardReward({});
    expect(reward).toEqual([{ id: "SOCIAL_PT", count: 300, type: "SOCIAL_PT" }]);
    expect(mockPlayer._playerdata.status!.socialPoint).toBe(38 + 300);
    const leave = (mockPlayer._playerdata.building!.rooms.MEETING).room_001.messageLeave;
    expect(leave.sp.lastWeek).toBe(0); // 已领取清零
    expect(leave.sp.lastWeekSum).toBe(300); // 累计
  });

  it("confirmMessageBoardReward 无可领时返回空 reward（不重复发放）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.confirmMessageBoardReward({});
    const second = await manager.confirmMessageBoardReward({});
    expect(second).toEqual([]);
    expect(mockPlayer._playerdata.status!.socialPoint).toBe(38 + 300); // 未重复发放
  });

  it("留言板完整链路：dailyRefresh 累积 thisWeek → 跨周滚动 lastWeek → confirmMessageBoardReward 可领取信用", async () => {
    // 好友访问留言板：1 好友 × visitorBonus=30
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [{ uid: "2", alias: "" }],
      friendRequests: [],
      visited: [],
    });
    const room = (mockPlayer._playerdata.building!.rooms.MEETING).room_001;
    room.messageLeave = {
      inUse: true, lastVisitTs: 0, lastShowTs: 0,
      lastUpdateSpTs: 1234567890 - 7 * 86400, // 一周前 → dailyRefresh 触发周切
      sp: { lastWeek: 0, lastWeekSum: 0, thisWeek: 90, thisWeekSum: 90 },
    };
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 每日刷新：先周切（thisWeek 90 → lastWeek），再累积新一周 thisWeek（1×30=30）
    await manager.dailyRefresh();
    // update 深拷贝替换 building → 重新读取
    const sp = (mockPlayer._playerdata.building!.rooms.MEETING).room_001.messageLeave.sp;
    expect(sp.lastWeek).toBe(90); // 上周可领
    expect(sp.thisWeek).toBe(30); // 本周新累积
    // 领取上周留言板社交点 → 信用入账
    const reward = await manager.confirmMessageBoardReward({});
    expect(reward).toEqual([{ id: "SOCIAL_PT", count: 90, type: "SOCIAL_PT" }]);
    expect(mockPlayer._playerdata.status!.socialPoint).toBe(38 + 90);
    const spAfter = (mockPlayer._playerdata.building!.rooms.MEETING).room_001.messageLeave.sp;
    expect(spAfter.lastWeek).toBe(0); // 已领取清零
    expect(spAfter.lastWeekSum).toBe(90); // 累计
    expect(spAfter.thisWeek).toBe(30); // 本周未动
  });

  it("留言板累积应封顶 visitorBonusLimit（本周社交点 ≤ 300）", async () => {
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [{ uid: "2", alias: "" }, { uid: "3", alias: "" }, { uid: "4", alias: "" }, { uid: "5", alias: "" }, { uid: "6", alias: "" }],
      friendRequests: [],
      visited: [],
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 5 好友 × 30 = 150；连续刷新多天 → 封顶 300
    for (let i = 0; i < 5; i++) {
      await manager.dailyRefresh();
    }
    const sp = (mockPlayer._playerdata.building!.rooms.MEETING).room_001.messageLeave.sp;
    expect(sp.thisWeek).toBe(300);
  });

  it("getMessageBoardContent 应返回留言板内容（访客/统计/上周可领社交点）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const board = await manager.getMessageBoardContent({});
    expect(board.thisWeekVisitors).toEqual([]);
    expect(board.lastWeekSpReward).toBe(300); // sp.lastWeek
    expect(board.weeklyVisit).toBe(90); // sp.thisWeek
    expect(board.lastShowTs).toBeGreaterThan(0);
  });
});

describe("BuildingManager 房间建造与升级（Excel 驱动）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 225 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {
          slot_5: { level: 1, state: 1, roomId: "MANUFACTURE", charInstIds: [], completeConstructTime: -1 },
        },
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, TRADING: {},
          MANUFACTURE: {}, CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      status: { gold: 10000 },
      inventory: { "3131": 10, "3132": 10 },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("buildRoom 应按 buildCost 扣材料与劳动力", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.buildRoom({ roomSlotId: "slot_5", roomId: "MANUFACTURE" });
    expect(mockPlayer._playerdata.inventory!["3131"]).toBe(9); // 10 - 1
    expect(mockPlayer._playerdata.building!.status.labor.value).toBe(90); // 100 - 10
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.state).toBe(1);
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.roomId).toBe("MANUFACTURE");
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.completeConstructTime).toBe(1234567891); // now + 1
  });

  it("upgradeRoom 应按目标等级 buildCost 扣材料与劳动力", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.upgradeRoom({ roomSlotId: "slot_5", targetLevel: 2 });
    expect(mockPlayer._playerdata.inventory!["3132"]).toBe(8); // 10 - 2
    expect(mockPlayer._playerdata.building!.status.labor.value).toBe(80); // 100 - 20
    expect(mockPlayer._playerdata.building!.roomSlots.slot_5.level).toBe(2);
  });

  /* ===== 2026-08-09 基建修复验证 ===== */

  it("制造站生产随时间累积（sync 推进 processPoint → 产出，buff/时间不再脱钩）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 1 点/秒速率（2026-08-26 dc-fix：不再按容量×时间）：5400 秒累积 5400 → 产出 2 批
    mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_m1"] = asModel<PlayerBuildingManufacture>({
      buff: {},
      state: 1,
      formulaId: "1",
      remainSolutionCnt: 10,
      outputSolutionCnt: 0,
      processPoint: 0,
      capacity: 54,
      lastUpdateTime: 1234567890 - 5400,
      completeWorkTime: -1,
    });
    await manager.sync();
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_m1"];
    expect(room.outputSolutionCnt).toBe(2); // 5400/2700
    expect(room.remainSolutionCnt).toBe(8);
    expect(room.processPoint).toBe(0);
  });

  it("changeManufactureSolution 应从 0 开始累积而非立即满产", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_m1"] = asModel<PlayerBuildingManufacture>({
      buff: {}, state: 0, formulaId: "", remainSolutionCnt: 0,
      outputSolutionCnt: 0, processPoint: 0, capacity: 54, lastUpdateTime: 0,
    });
    await manager.changeManufactureSolution({ roomSlotId: "slot_m1", targetFormulaId: "1", solutionCount: 10 });
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_m1"];
    expect(room.remainSolutionCnt).toBe(10);
    expect(room.outputSolutionCnt).toBe(0);
    expect(room.state).toBe(1);
  });

  // Round 23 / B4：制造站单次排产份数上限（building_data.manufactInputCapacity = 99）
  it("changeManufactureSolution：份数超过 99 时按 manufactInputCapacity 钳制", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_m1"] = asModel<PlayerBuildingManufacture>({
      buff: {}, state: 0, formulaId: "", remainSolutionCnt: 0,
      outputSolutionCnt: 0, processPoint: 0, capacity: 54, lastUpdateTime: 0,
    });
    await manager.changeManufactureSolution({ roomSlotId: "slot_m1", targetFormulaId: "1", solutionCount: 999999 });
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_m1"];
    expect(room.remainSolutionCnt).toBe(99);
    // 小数份数取整（mock 的 update 会整体替换 building 子树，需重新取引用）
    await manager.changeManufactureSolution({ roomSlotId: "slot_m1", targetFormulaId: "1", solutionCount: 12.7 });
    const room2 = mockPlayer._playerdata.building!.rooms.MANUFACTURE["slot_m1"];
    expect(room2.remainSolutionCnt).toBe(12);
  });

  it("贸易站订单补充：stock 为空时 sync 补 2 单（delivery 3003 → gain 金币）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.rooms.TRADING["slot_t1"] = asModel<PlayerBuildingTrading>({
      buff: {}, state: 1, stock: [], lastUpdateTime: 0,
    });
    await manager.sync();
    const stock = mockPlayer._playerdata.building!.rooms.TRADING["slot_t1"].stock;
    expect(stock.length).toBe(2);
    for (const order of stock) {
      expect(order.delivery[0].id).toBe("3003");
      expect(order.gain.type).toBe("GOLD");
      expect(order.gain.count).toBe(order.delivery[0].count * 500);
    }
  });

  it("deliveryOrder 按客户端指定 instId 结算（不再总是队首）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.building!.rooms.TRADING["slot_t1"] = asModel<PlayerBuildingTrading>({
      buff: {}, state: 1,
      stock: [
        { instId: 1, delivery: [{ id: "3003", type: "MATERIAL", count: 1 }], type: "O_GOLD", gain: { id: "4001", type: "GOLD", count: 500 }, buff: [] },
        { instId: 2, delivery: [{ id: "3003", type: "MATERIAL", count: 2 }], type: "O_GOLD", gain: { id: "4001", type: "GOLD", count: 1000 }, buff: [] },
      ],
      lastUpdateTime: 0,
    });
    const goldBefore = mockPlayer._playerdata.status!.gold ?? 0;
    await manager.deliveryOrder({ slotId: "slot_t1", orderId: "2" });
    const stock = mockPlayer._playerdata.building!.rooms.TRADING["slot_t1"].stock;
    expect(stock.length).toBe(1); // 只剩 instId 1
    expect(stock[0].instId).toBe(1);
    expect(mockPlayer._playerdata.status!.gold).toBe(goldBefore + 1000); // 结算的是 instId 2
  });

  it("settleManufacture 非法 roomSlotId 不应抛错（不再 500）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await expect(
      manager.settleManufacture({ roomSlotId: "slot_nonexist" } as Parameters<BuildingManager["settleManufacture"]>[0]),
    ).resolves.not.toThrow();
  });
});

describe("训练室专精结算 / 批量换班（修复）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(async () => {
    // 本组测试验证真实训练室专精路径：禁用 config 的即时完成开发开关，保证走训练等待逻辑
    config.developer!.specializationTimeZero = false;
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, TRADING: {}, MANUFACTURE: {},
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {
            slot_13: {
              trainee: { charInstId: 377, state: 2, targetSkill: 2, processPoint: 100, speed: 1 },
              trainer: { charInstId: 210, state: 2 },
              lastUpdateTime: 1234567890 - 5400,
            },
          },
          PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      status: { uid: "1" },
      inventory: { "3303": 20 },
      troop: {
        chars: {
          "377": {
            instId: 377, charId: "char_1015_aglna2", level: 1,
            evolvePhase: 2, mainSkillLvl: 7,
            skills: [
              { skillId: "skchr_aglna2_1", unlock: 1, state: 0, specializeLevel: 0, completeUpgradeTime: -1 },
              { skillId: "skchr_aglna2_2", unlock: 1, state: 0, specializeLevel: 0, completeUpgradeTime: -1 },
              { skillId: "skchr_aglna2_3", unlock: 1, state: 0, specializeLevel: 2, completeUpgradeTime: -1 },
            ],
          },
        },
      },
      pushFlags: { hasGifts: 0, hasFriendRequest: 0, hasClues: 0, hasFreeLevelGP: 0, status: 0 },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("completeUpgradeSpecialization 空请求体应从训练室 trainee 结算（专精+1）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.completeUpgradeSpecialization({});
    const char = (mockPlayer._playerdata.troop).chars["377"];
    expect(char.skills[2].specializeLevel).toBe(3); // 2 → 3
    expect(char.skills[2].state).toBe(0);
    // 官方线格式 trainee 恒为对象（置 null 会让客户端读 trainee.charInstId 崩溃 → 存档破坏）
    const trainee = (mockPlayer._playerdata.building).rooms.TRAINING.slot_13.trainee;
    expect(trainee).not.toBeNull();
    expect(trainee.state).toBe(3); // WAITING 待下一次专精
    expect(trainee.targetSkill).toBe(-1);
    expect(trainee.charInstId).toBe(377); // 干员保留
  });

  it("completeUpgradeSpecialization 越界 targetSkill 应保留 trainee（不丢训练进度/不破坏存档）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // targetSkill=5 但干员 skills 只有 3 个 → 无法结算 → trainee 保留
    mockPlayer._playerdata.building.rooms.TRAINING.slot_13.trainee = asModel<PlayerBuildingTrainee>({
      charInstId: 377, state: 2, targetSkill: 5, processPoint: 100, speed: 1,
    });
    await manager.completeUpgradeSpecialization({});
    const trainee = (mockPlayer._playerdata.building).rooms.TRAINING.slot_13.trainee;
    expect(trainee).not.toBeNull(); // 训练进度保留
    const char = (mockPlayer._playerdata.troop).chars["377"];
    expect(char.skills[5]).toBeUndefined();
  });

  it("upgradeSpecialization 应把专精目标写入训练室 trainee（否则空 body 结算读不到）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.upgradeSpecialization({ charInstId: 377, targetSkill: 0 });
    const trainee = (mockPlayer._playerdata.building).rooms.TRAINING.slot_13.trainee;
    // 关键修复：旧实现只改 skill.state，不写 trainee → 完成时（body={}）读 targetSkill=-1 无法结算
    expect(trainee.charInstId).toBe(377);
    expect(trainee.targetSkill).toBe(0);
    expect(trainee.state).toBe(1); // TRAINING
  });

  it("升级→完成后 trainee 保留为 WAITING 对象（循环可用，不置 null）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.upgradeSpecialization({ charInstId: 377, targetSkill: 0 });
    // 训练时长门控：模拟训练完成（state=2 待领取）后结算
    mockPlayer._playerdata.building.rooms.TRAINING.slot_13.trainee.state = 2;
    await manager.completeUpgradeSpecialization({});
    const trainee = (mockPlayer._playerdata.building).rooms.TRAINING.slot_13.trainee;
    const char = (mockPlayer._playerdata.troop).chars["377"];
    expect(char.skills[0].specializeLevel).toBe(1); // 0 → 1
    expect(trainee).not.toBeNull();
    expect(trainee.state).toBe(3); // WAITING
    expect(trainee.targetSkill).toBe(-1);
    expect(trainee.charInstId).toBe(377);
  });

  it("batchChangeWorkChar 空请求体不 500（CS 无字段 body={}）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 不抛错即修复（空 body 不再 500）
    await manager.batchChangeWorkChar({});
  });

  afterEach(() => {
    // 恢复开发开关，避免污染共享 config 单例影响其他用例
    config.developer!.specializationTimeZero = true;
  });
});

describe("快速换班预设队列选择规则（B10：排除训练位/涣散 + 按心情比例）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  const MAX_AP = 8640000;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {
          slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [-1, -1, -1], completeConstructTime: -1 },
        },
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, TRADING: {}, CORRIDOR: {}, WORKSHOP: {},
          DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {},
          MANUFACTURE: { slot_5: { presetQueue: [] } },
          PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { inUse: false, selected: "bgm_default", state: {} },
      },
      event: { building: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi.fn<(recipe: MockUpdateRecipe) => Promise<void>>().mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  /** 写入干员心情与房间预设队列 */
  function setup(aps: Record<number, number>, queue: number[][], training?: number) {
    const chars: MockSeed<PlayerBuilding["chars"]> = {};
    for (const [id, ap] of Object.entries(aps)) {
      chars[id] = { charId: `char_${id}`, ap, changeScale: 0 };
    }
    Object.assign(mockPlayer._playerdata.building!.chars, chars);
    mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5.presetQueue = queue;
    if (training) {
      mockPlayer._playerdata.building!.rooms.TRAINING.slot_13 = asModel<PlayerBuildingTraining>({
        state: 1,
        trainee: { charInstId: training, state: 1, targetSkill: 0 },
        trainer: { charInstId: -1, state: 0 },
      });
    }
  }

  it("按心情比例而非人数：2 人满心情组胜过 3 人低心情组", () => {
    setup(
      { 1: MAX_AP, 2: MAX_AP, 3: 1000, 4: 1000, 5: 1000 },
      [[3, 4, 5], [1, 2]],
    );
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const picked = manager._pickHighestApPreset(mockPlayer._playerdata, "slot_5");
    expect(picked).toEqual([1, 2]);
  });

  it("排除训练位干员：含专精训练中干员的组跳过", () => {
    setup(
      { 1: MAX_AP, 2: MAX_AP, 3: 1000 },
      [[1, 2], [3]],
      /* training */ 1,
    );
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const picked = manager._pickHighestApPreset(mockPlayer._playerdata, "slot_5");
    expect(picked).toEqual([3]);
  });

  it("排除涣散干员（心情 0）：含涣散干员的组跳过", () => {
    setup({ 1: MAX_AP, 2: 0, 3: 1000 }, [[1, 2], [3]]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const picked = manager._pickHighestApPreset(mockPlayer._playerdata, "slot_5");
    expect(picked).toEqual([3]);
  });

  it("平手时取队列序号靠前的一组", () => {
    setup({ 1: MAX_AP, 2: MAX_AP }, [[1], [2]]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const picked = manager._pickHighestApPreset(mockPlayer._playerdata, "slot_5");
    expect(picked).toEqual([1]);
  });

  it("全部组都不可用（含训练位/涣散）时返回 null", () => {
    setup({ 1: 0, 2: 0 }, [[1], [2]]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    expect(manager._pickHighestApPreset(mockPlayer._playerdata, "slot_5")).toBeNull();
  });
});

describe("batchChangeWorkChar / batchRestChar pushMessage（对齐官服抓包 buildingBatchChangeWorkChar / buildingBatchRestChar）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(async () => {
    config.developer!.specializationTimeZero = false;
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {
          slot_5: { level: 2, state: 2, roomId: "TRADING", charInstIds: [1001, 1002, 1003], completeConstructTime: 0 },
        },
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, TRADING: {}, MANUFACTURE: {},
          CORRIDOR: {}, WORKSHOP: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
          TRAINING: {}, PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
      },
      status: { uid: "1" },
      troop: { chars: {} },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  it("batchChangeWorkChar 发生排班变化时下发 buildingBatchChangeWorkChar（num=变化的干员数）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchChangeWorkChar({
      roomSlotId: "slot_5",
      charInstIdList: [1004, 1005, 1006],
    });
    expect(mockPlayer._pushMessages).toEqual([
      { path: "buildingBatchChangeWorkChar", payload: { num: 3 } },
    ]);
  });

  it("batchChangeWorkChar 替换为相同排班（无变化）时不下发 pushMessage", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchChangeWorkChar({
      roomSlotId: "slot_5",
      charInstIdList: [1001, 1002, 1003],
    });
    expect(mockPlayer._pushMessages).toEqual([]);
  });

  it("batchRestChar 移除干员时下发 buildingBatchRestChar（num=休息干员数）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchRestChar({ charInstIdList: [1001, 1002] });
    expect(mockPlayer._pushMessages).toEqual([
      { path: "buildingBatchRestChar", payload: { num: 2 } },
    ]);
  });

  it("batchRestChar 空请求体且无可休息干员时不下发 pushMessage", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchRestChar({});
    expect(mockPlayer._pushMessages).toEqual([]);
  });

  afterEach(() => {
    config.developer!.specializationTimeZero = true;
  });
});

describe("BuildingManager 信用获取规则（PRTS）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      building: {
        status: { labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 100 }, workshop: { bonusActive: 0, bonus: {} } },
        chars: {},
        roomSlots: {},
        rooms: {
          CONTROL: {}, ELEVATOR: {}, POWER: {}, MANUFACTURE: {}, TRADING: {}, CORRIDOR: {}, WORKSHOP: {},
          DORMITORY: {
            slot_d1: asModel<DormitoryFixture>({ comfort: 5000, buff: {}, diySolution: {}, level: 5 }), // 10+⌊5000/125⌋=50（封顶）
            slot_d2: asModel<DormitoryFixture>({ comfort: 1000, buff: {}, diySolution: {}, level: 5 }), // 10+⌊1000/125⌋=18
          },
          MEETING: {
            room_001: {
              ownStock: [], receiveStock: [], board: {},
              socialReward: { daily: 0, search: 0 },
            },
          },
          HIRE: {}, TRAINING: {}, PRIVATE: {},
        },
        furniture: {}, diyPresetSolutions: {}, assist: [-1, -1, -1],
        solution: { furnitureTs: {} }, music: { selected: "bgm_default" },
      },
      status: { uid: "1", nickName: "A", nickNumber: "1", socialPoint: 0 },
      pushFlags: { hasGifts: 0, hasFriendRequest: 0, hasClues: 0, hasFreeLevelGP: 0, status: 0 },
      event: { building: 0 },
    });
    // 夹具占位：dailyReward/mustgetClue 的服务端实际形态见 MeetingRoomFixture（构造管理器前写入）
    const meetingRoom = mockPlayer._playerdata.building!.rooms.MEETING.room_001 as MeetingRoomFixture;
    meetingRoom.dailyReward = null;
    meetingRoom.mustgetClue = [];
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn()
      .mockImplementation(
        async (recipe: MockUpdateRecipe) => {
          const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({ friends: [], friendRequests: [], visited: [] });
    vi.spyOn(Date, "now").mockReturnValue(1234567890000);
  });

  /** 会客室进驻 1 名干员（B11：未进驻干员不发放每日线索） */
  function stationMeetingChar() {
    const b = mockPlayer._playerdata.building!;
    b.roomSlots.meeting_01 = asModel<PlayerBuildingRoomSlot>({
      level: 1, state: 2, roomId: "MEETING", charInstIds: [9001], completeConstructTime: -1,
    });
    b.chars["9001"] = asModel<PlayerBuildingChar>({
      charId: "char_meet", ap: 8640000, lastApAddTime: 0,
      roomSlotId: "meeting_01", index: 0, changeScale: 0, bubble: {},
    });
    mockPlayer._playerdata.troop = asModel<PlayerTroop>({
      chars: { "9001": { charId: "char_meet", level: 10, evolvePhase: 0 } },
      charGroup: {},
    });
  }

  it("宿舍氛围每日结算信用：Cd=10+⌊Ad/125⌋、每间 50 上限，写入昨日奖励（信用交易所领取）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.dailyRefresh();
    // 修复（2026-09-09，审计 §5.4-12）：宿舍氛围信用属 PRTS「每日结算的信用」——
    // 次日于**信用交易所**手动领取（social.yesterdayReward.comfortAmount），
    // 不再写入会客室 socialReward.daily（官服存档 MEETING.daily = 0 而 comfortAmount = 200）。
    // 两间宿舍：5000→50、1000→18，合计 68（<200 不上限）
    expect((mockPlayer._playerdata.building!.rooms.MEETING).room_001.socialReward.daily).toBe(0);
    // building 侧不再触碰 social 容器（写入由 SocialManager.dailyRefresh 负责）
    expect(mockPlayer._playerdata.social).toBeUndefined();
    // 会客室再无待领信用 → getMeetingroomReward 空发放
    const granted = await manager.getMeetingroomReward();
    expect(granted.rewards).toEqual([]);
    expect((mockPlayer._playerdata.status).socialPoint).toBe(0);
  });

  it("dormComfortCredit 全天上限 200（5 间满氛围宿舍封顶），由 social 侧写入昨日奖励", async () => {
    mockPlayer._playerdata.building!.rooms.DORMITORY = asModel<PlayerBuilding["rooms"]["DORMITORY"]>({
      slot_1: { comfort: 5000 }, slot_2: { comfort: 5000 }, slot_3: { comfort: 5000 },
      slot_4: { comfort: 5000 }, slot_5: { comfort: 5000 },
    });
    // 纯计算入口（building/public.ts 门面 → SocialManager.dailyRefresh 调用）
    const { settleDormComfortCredit } = await import("@game/modules/building/public");
    expect(settleDormComfortCredit(mockPlayer._playerdata)).toBe(200);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.dailyRefresh();
    // 会客室容器不再承接宿舍氛围信用
    expect((mockPlayer._playerdata.building!.rooms.MEETING).room_001.socialReward.daily).toBe(0);
  });

  it("getDailyClue 生成线索即时 +20 信用", async () => {
    stationMeetingChar();
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getDailyClue({});
    expect((mockPlayer._playerdata.status).socialPoint).toBe(20);
  });

  it("sendClue 传递线索即时 +20 信用", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING.room_001.ownStock = asModel<PlayerBuildingMeetingClue[]>([
      { id: "c1", type: "RHINE", uid: "1", inUse: 0 },
    ]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sendClue({ id: "c1", friendId: "2" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(20);
  });

  it("deleteOwnClue 回收自有库线索即时 +5 信用；删不存在不加", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MEETING.room_001 as MeetingRoom;
    room.ownStock = asModel<PlayerBuildingMeetingClue[]>([{ id: "c1", type: "RHINE", uid: "1", inUse: 0 }]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.deleteOwnClue({ id: "c1" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(5);
    // 删除不存在的线索不发放
    await manager.deleteOwnClue({ id: "c2" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(5);
  });

  it("receiveClueToStock 接收线索依次 +15/10/5，第 4 张起不获信用（每日计次）", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MEETING.room_001 as MeetingRoom;
    room.receiveStock = asModel<PlayerBuildingMeetingClue[]>([
      { id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" },
    ]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.receiveClueToStock({ clues: ["r1", "r2", "r3"] });
    // 15+10+5 = 30
    expect((mockPlayer._playerdata.status).socialPoint).toBe(30);
    const countBefore = (room).clueReceiveCount;
    // 第 4 张起不获信用
    await manager.receiveClueToStock({ clues: ["r4"] });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(30);
    expect((room).clueReceiveCount).toBe(countBefore);
  });

  it("visitBuilding 访问好友基建 → 访问方 +30，每日上限 10 次", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.visitBuilding({ friendId: "2" });
    await manager.visitBuilding({ friendId: "3" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(60);
    // 第 11 次（上限 10）后不再发放
    const st = mockPlayer._playerdata.status as StatusExt;
    st.visitCreditCount = 10;
    await manager.visitBuilding({ friendId: "4" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(60);
  });

  // ===== Round 24 / B6：线索信用补齐 =====


  it("visitBuilding：同一好友每日只计 1 次（原实现可反复访问同一好友刷满 10 次）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.visitBuilding({ friendId: "2" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(30);
    // 同日重复访问同一好友不再发放
    await manager.visitBuilding({ friendId: "2" });
    await manager.visitBuilding({ friendId: "2" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(30);
    // 换好友仍可计次
    await manager.visitBuilding({ friendId: "3" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(60);
    // 次日重置后可再次计次
    const st = mockPlayer._playerdata.status as StatusExt;
    st.visitCreditDay = -1;
    await manager.visitBuilding({ friendId: "2" });
    expect((mockPlayer._playerdata.status).socialPoint).toBe(90);
  });
});
