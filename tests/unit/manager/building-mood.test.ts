import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 基建心情通用机制（批次①，2026-08-25 全量对齐）
 *
 * 覆盖（机制来源 prts.wiki「罗德岛基建」）：
 * - mood.ts 纯函数：涣散判定 / 头数心情减免 / 暖机工时换算
 * - 注意力涣散（ap ≤ 0）技能失效：getActiveCharBuffs / roomSpeedBonus 不激活；
 *   宿舍恢复为休息语境不受影响
 * - 头数心情减免接线：制造/贸易 2人 +0.05、3人 +0.1 点/时（×100 = raw AP/秒）
 * - 暖机工时推进：在岗累积 / 离岗清零 / 换工位清零
 */

/** excel mock 的行形状（本文件只需 `name`，供 `itemName` 回退读取） */
interface ExcelRowMock { name?: string }

// Excel BuildingData 样本（制造/宿舍 buff + 相位）
const excelMock = vi.hoisted(() => ({
  default: {
    // —— 本文件不提供的表（占位；`?.` 读取下与「键不存在」运行时等价）——
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
      orderMaxPoint: 3000,
      laborRecoverTime: 360,
      goldItems: { "3003": 500 },
      gamedata_const: { termDescriptionDict: {} },
      buffs: {
        "manu_prod_spd[000]": {
          buffId: "manu_prod_spd[000]", roomType: "MANUFACTURE", efficiency: 15,
          targets: ["F_GOLD", "F_EXP", "F_DIAMOND"],
          description: "进驻制造站时，生产力<@cc.vup>+15%</>",
        },
        "dorm_rec_all[010]": {
          buffId: "dorm_rec_all[010]", roomType: "DORMITORY", efficiency: 0,
          targets: [],
          description: "进驻宿舍时，该宿舍内所有干员的心情每小时恢复<@cc.vup>+0.15</>（同种效果取最高）",
        },
      },
      chars: {
        "char_prod": { charId: "char_prod", buffChar: [{ buffData: [{ buffId: "manu_prod_spd[000]", cond: { level: 1 } }] }] },
        "char_dorm": { charId: "char_dorm", buffChar: [{ buffData: [{ buffId: "dorm_rec_all[010]", cond: { level: 1 } }] }] },
      },
      manufactData: {
        phases: [
          { speed: 1, outputCapacity: 24 },
          { speed: 1, outputCapacity: 36 },
          { speed: 1, outputCapacity: 54 },
        ],
      },
      dormData: { phases: [{ manpowerRecover: 160 }, { manpowerRecover: 170 }] },
      manufactFormulas: {},
      rooms: {
        MANUFACTURE: {
          phases: [
            { buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 },
            { buildCost: { items: [], time: 0, labor: 20 }, maxStationedNum: 2 },
            { buildCost: { items: [], time: 0, labor: 30 }, maxStationedNum: 3 },
          ],
        },
        TRADING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        CONTROL: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        DORMITORY: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        TRAINING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
      },
      meetingData: { phases: [{ friendSlotInc: 10, maxVisitorNum: 10, gatheringSpeed: 100 }] },
      hireData: { phases: [{ economizeRate: 0, resSpeed: 100, refreshTimes: 3 }] },
    },
  },
}));
vi.mock("@excel/excel", () => excelMock);

const timeMock = vi.hoisted(() => ({ now: 1234567890 }));
vi.mock("@utils/time", () => ({ now: () => timeMock.now }));

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

import {
  mockPlayerData,
  mockTypedEventEmitter,
  asPlayerManager,
  type MockPlayerDataManager,
  type MockPlayerDataSeed,
  type MockSeed,
  type MockUpdateRecipe,
} from "../../helpers";
import {
  isDispersedAp,
  headcountMoodRelief,
  warmupHoursOf,
  MAX_AP,
} from "@game/modules/building/mood";
import {
  getActiveCharBuffs,
  roomSpeedBonus,
  dormRecoveryBonus,
} from "@game/modules/building/buff";
import { BuildingManager } from "@game/modules/building/logic";
import type { CharWithWarmup } from "@game/modules/building/logic/ext-types";
import type { PlayerBuilding, PlayerBuildingChar, PlayerBuildingRoomSlot, PlayerDataModel } from "@game/kernel/playerdata";
import type { Draft } from "mutative";

/** 构造带指定 building 的 mock 玩家（update 深拷贝 → recipe → 回写） */
function makePlayer(
  building: MockPlayerDataSeed["building"],
  extra: Omit<MockPlayerDataSeed, "building"> = {},
) {
  const mockPlayer = mockPlayerData({
    building,
    event: { building: 0 },
    pushFlags: { hasGifts: 0, hasFriendRequest: 0, hasClues: 0, hasFreeLevelGP: 0, status: 0 },
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

/**
 * 本文件构造的 building 夹具视图
 *
 * `chars`/`roomSlots` 需在用例中增量写入，故声明为必填的索引字典；
 * 其余顶层字段与 {@link MockPlayerDataSeed} 的 building 子树同形（深可选）。
 */
type BuildingFixture = MockSeed<Omit<PlayerBuilding, "rooms" | "chars" | "roomSlots">> & {
  /** 干员心情条目（键为 instId 字符串） */
  chars: Record<string, MockSeed<PlayerBuildingChar>>;
  /** 房间槽位（键为 slotId） */
  roomSlots: Record<string, MockSeed<PlayerBuildingRoomSlot>>;
  /** 各类型房间的房间对象 */
  rooms: MockSeed<PlayerBuilding["rooms"]>;
};

/** 基础 building 结构（制造站/贸易站/控制中枢/宿舍/训练室槽位） */
function baseBuilding(): BuildingFixture {
  return {
    status: {
      labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 225 },
      workshop: { bonusActive: 0, bonus: {} },
    },
    chars: {},
    roomSlots: {
      slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [], completeConstructTime: -1 },
      slot_6: { level: 1, state: 2, roomId: "TRADING", charInstIds: [], completeConstructTime: -1 },
      slot_34: { level: 1, state: 2, roomId: "CONTROL", charInstIds: [], completeConstructTime: -1 },
      slot_28: { level: 1, state: 2, roomId: "DORMITORY", charInstIds: [], completeConstructTime: -1 },
      slot_13: { level: 1, state: 2, roomId: "TRAINING", charInstIds: [], completeConstructTime: -1 },
    },
    rooms: {
      CONTROL: {},
      ELEVATOR: {},
      POWER: {},
      MANUFACTURE: {
        slot_5: {
          state: 1, formulaId: "4", remainSolutionCnt: 10, outputSolutionCnt: 0,
          processPoint: 0, lastUpdateTime: 0, completeWorkTime: -1, capacity: 0,
        },
      },
      TRADING: {},
      CORRIDOR: {},
      WORKSHOP: {},
      DORMITORY: {},
      MEETING: {},
      HIRE: {},
      TRAINING: {},
      PRIVATE: {},
    },
    furniture: {},
    diyPresetSolutions: {},
    assist: [-1, -1, -1],
    solution: { furnitureTs: {} },
    music: { inUse: false, selected: "bgm_default", state: {} },
  };
}

function draftOf(mockPlayer: MockPlayerDataManager): Draft<PlayerDataModel> {
  return JSON.parse(JSON.stringify(mockPlayer._playerdata)) as Draft<PlayerDataModel>;
}

/**
 * 读取带暖机扩展字段的干员条目
 *
 * `warmupSec`/`warmupSlot` 为服务端自建字段（生成模型没有，见 logic/ext-types#CharWithWarmup）。
 */
function charExt(draft: Draft<PlayerDataModel>, instId: string): CharWithWarmup {
  return draft.building.chars[instId] as CharWithWarmup;
}

function setup(building: BuildingFixture = baseBuilding()) {
  const { mockPlayer, mockTrigger } = makePlayer(building, {
    status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
    inventory: {},
    troop: { chars: {}, charGroup: {} },
  });
  const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
  return { mockPlayer, mockTrigger, manager };
}

/** building.chars 干员条目（心情满/指定值） */
function bchar(charId: string, ap: number = MAX_AP): MockSeed<PlayerBuildingChar> {
  return {
    charId, ap, lastApAddTime: 0, roomSlotId: "", index: -1, changeScale: 0,
    bubble: { normal: { add: -1, ts: 0 }, assist: { add: -1, ts: 0 }, private: { add: -1, ts: 0 } },
  };
}

describe("mood.ts 纯函数（涣散/头数减免/暖机换算）", () => {
  it("isDispersedAp：ap ≤ 0 涣散；缺失视为满心情", () => {
    expect(isDispersedAp(0)).toBe(true);
    expect(isDispersedAp(-5)).toBe(true);
    expect(isDispersedAp(1)).toBe(false);
    expect(isDispersedAp(MAX_AP)).toBe(false);
    expect(isDispersedAp(undefined)).toBe(false);
    expect(isDispersedAp(null)).toBe(false);
  });

  it("headcountMoodRelief：2人 0.05、3人及以上 0.1（点/时）", () => {
    expect(headcountMoodRelief(1)).toBe(0);
    expect(headcountMoodRelief(2)).toBeCloseTo(0.05);
    expect(headcountMoodRelief(3)).toBeCloseTo(0.1);
    expect(headcountMoodRelief(5)).toBeCloseTo(0.1);
  });

  it("warmupHoursOf：秒→小时换算，缺失/负数按 0", () => {
    expect(warmupHoursOf(undefined)).toBe(0);
    expect(warmupHoursOf(null)).toBe(0);
    expect(warmupHoursOf(-10)).toBe(0);
    expect(warmupHoursOf(7200)).toBe(2);
    expect(warmupHoursOf(10800)).toBe(3);
  });
});

describe("注意力涣散技能失效（buff.ts 集成）", () => {
  it("涣散干员不激活任何 buff（roomSpeedBonus 无贡献）", () => {
    const dispersed = { charId: "char_prod", level: 10, evolvePhase: 0, ap: 0 };
    expect(getActiveCharBuffs(dispersed, "MANUFACTURE")).toEqual([]);
    expect(roomSpeedBonus([dispersed], "MANUFACTURE", ["F_GOLD"])).toBe(0);
  });

  it("正常心情干员照常激活（+15%）", () => {
    const normal = { charId: "char_prod", level: 10, evolvePhase: 0, ap: MAX_AP };
    expect(getActiveCharBuffs(normal, "MANUFACTURE")).toHaveLength(1);
    expect(roomSpeedBonus([normal], "MANUFACTURE", ["F_GOLD"])).toBeCloseTo(0.15);
  });

  it("ap 缺失（旧数据）视为满心情，不影响既有行为", () => {
    const legacy = { charId: "char_prod", level: 10, evolvePhase: 0 };
    expect(roomSpeedBonus([legacy], "MANUFACTURE", ["F_GOLD"])).toBeCloseTo(0.15);
  });

  it("宿舍恢复为休息语境：涣散干员的宿舍技能仍生效", () => {
    const dispersed = { charId: "char_dorm", level: 10, evolvePhase: 0, ap: 0 };
    expect(dormRecoveryBonus([dispersed])).toBeCloseTo(0.15);
  });
});

describe("BuildingManager 头数心情减免（_recomputeCharScales）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function withManufactChars(n: number): BuildingFixture {
    const b = baseBuilding();
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      ids.push(i);
      b.chars[String(i)] = bchar("char_prod");
    }
    b.roomSlots.slot_5.charInstIds = ids;
    return b;
  }

  it("制造站 1 人无减免（基础 -55）", () => {
    const { manager, mockPlayer } = setup(withManufactChars(1));
    const draft = draftOf(mockPlayer);
    manager["_recomputeCharScales"](draft);
    expect(draft.building.chars["1"].changeScale).toBe(-55);
  });

  it("制造站 2 人减免 0.05 点/时（-55 + 5 = -50）", () => {
    const { manager, mockPlayer } = setup(withManufactChars(2));
    const draft = draftOf(mockPlayer);
    manager["_recomputeCharScales"](draft);
    expect(draft.building.chars["1"].changeScale).toBe(-50);
    expect(draft.building.chars["2"].changeScale).toBe(-50);
  });

  it("制造站 3 人减免 0.1 点/时（-55 + 10 = -45）", () => {
    const { manager, mockPlayer } = setup(withManufactChars(3));
    const draft = draftOf(mockPlayer);
    manager["_recomputeCharScales"](draft);
    for (const k of ["1", "2", "3"]) {
      expect(draft.building.chars[k].changeScale).toBe(-45);
    }
  });

  it("非制造/贸易房间无头数减免（会客室基础 -65 不变）", () => {
    const b = baseBuilding();
    b.chars["1"] = bchar("char_prod");
    b.roomSlots.slot_34.roomId = "MEETING";
    b.roomSlots.slot_34.charInstIds = [1];
    const { manager, mockPlayer } = setup(b);
    const draft = draftOf(mockPlayer);
    manager["_recomputeCharScales"](draft);
    expect(draft.building.chars["1"].changeScale).toBe(-65);
  });
});

describe("BuildingManager 暖机工时推进（_accrueWarmup）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function withWorkChar(): BuildingFixture {
    const b = baseBuilding();
    b.chars["1"] = bchar("char_prod");
    b.roomSlots.slot_5.charInstIds = [1];
    return b;
  }

  it("工作区在岗按 deltaTime 累积（注入 ts）", () => {
    const { manager, mockPlayer } = setup(withWorkChar());
    const draft = draftOf(mockPlayer);
    manager["_accrueWarmup"](draft, 1000); // 首次建立时间基准
    manager["_accrueWarmup"](draft, 1000 + 3600);
    expect(charExt(draft, "1").warmupSec).toBe(3600);
    expect(warmupHoursOf(charExt(draft, "1").warmupSec)).toBe(1);
    // 连续累积
    manager["_accrueWarmup"](draft, 1000 + 3600 + 7200);
    expect(charExt(draft, "1").warmupSec).toBe(10800);
  });

  it("离岗（进驻宿舍）累积清零", () => {
    const { manager, mockPlayer } = setup(withWorkChar());
    const draft = draftOf(mockPlayer);
    manager["_accrueWarmup"](draft, 1000);
    manager["_accrueWarmup"](draft, 4600);
    expect(charExt(draft, "1").warmupSec).toBe(3600);
    // 撤出工作区 → 宿舍
    draft.building.roomSlots.slot_5.charInstIds = [];
    draft.building.roomSlots.slot_28.charInstIds = [1];
    manager["_accrueWarmup"](draft, 8200);
    expect(charExt(draft, "1").warmupSec).toBe(0);
  });

  it("换工位（不同房间槽位）累积清零后重新起算", () => {
    const b = withWorkChar();
    // 第二制造站槽位
    b.roomSlots.slot_7 = { level: 1, state: 2, roomId: "MANUFACTURE", charInstIds: [], completeConstructTime: -1 };
    const { manager, mockPlayer } = setup(b);
    const draft = draftOf(mockPlayer);
    manager["_accrueWarmup"](draft, 1000);
    manager["_accrueWarmup"](draft, 4600);
    expect(charExt(draft, "1").warmupSec).toBe(3600);
    // 换到 slot_7
    draft.building.roomSlots.slot_5.charInstIds = [];
    draft.building.roomSlots.slot_7.charInstIds = [1];
    manager["_accrueWarmup"](draft, 8200); // 换岗当次清零
    expect(charExt(draft, "1").warmupSec).toBe(0);
    manager["_accrueWarmup"](draft, 8200 + 1800);
    expect(charExt(draft, "1").warmupSec).toBe(1800);
  });

  it("同房间重复推进不重置（槽位不变持续累积）", () => {
    const { manager, mockPlayer } = setup(withWorkChar());
    const draft = draftOf(mockPlayer);
    manager["_accrueWarmup"](draft, 1000);
    manager["_accrueWarmup"](draft, 2000);
    manager["_accrueWarmup"](draft, 3000);
    expect(charExt(draft, "1").warmupSec).toBe(2000);
    expect(charExt(draft, "1").warmupSlot).toBe("slot_5");
  });
});
