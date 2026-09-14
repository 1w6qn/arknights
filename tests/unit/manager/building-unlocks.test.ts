import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 基建配方解锁 + 专精系统（批次②：2026-08-25 全量对齐）
 *
 * 覆盖（机制来自 prts.wiki 制造站/加工站/训练室页 + excel）：
 * - unlocks.ts 纯函数：requireRooms（曾达等级 + 房间数）/ requireStages（关卡星级）
 * - 曾达等级追踪：upgradeRoom/buildRoom 记录 maxLevelReached（降级不回退）
 * - changeManufactureSolution / workshopSynthesis 配方解锁门控
 * - changeSaleSolution 开采协力（O_DIAMOND）等级门控
 * - 专精：精2/技能7级/材料消耗/训练时长阈值（maxPoint）/待领取门控/训练锁
 */

/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }

/** 干员表 mock 行形状（专精配置读取） */
interface CharRowMock {
  skills?: {
    levelUpCostCond: { lvlUpTime: number; levelUpCost: { id: string; count: number; type: string }[] }[];
  }[];
}

// Excel 样本：制造配方（曾达等级条件）、加工配方（关卡星条件）、专精配置
const excelMock = vi.hoisted(() => ({
  default: {
    // —— 本文件不提供的表（占位，保持门面方法的 `this.XxxTable` 读取路径）——
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
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
      tradingStrategyUnlockLevel: 3,
      manufactFormulas: {
        "1": { formulaId: "1", itemId: "2001", count: 1, costPoint: 2700, formulaType: "F_EXP", costs: [], requireRooms: [{ roomId: "MANUFACTURE", roomLevel: 1, roomCount: 1 }], requireStages: [] },
        "3": { formulaId: "3", itemId: "2003", count: 1, costPoint: 10800, formulaType: "F_EXP", costs: [], requireRooms: [{ roomId: "MANUFACTURE", roomLevel: 3, roomCount: 1 }], requireStages: [] },
      },
      workshopFormulas: {
        "4": {
          formulaId: "4", itemId: "3131", count: 1, goldCost: 0, apCost: 0,
          formulaType: "F_BUILDING", costs: [{ id: "3112", count: 2, type: "MATERIAL" }],
          requireRooms: [{ roomId: "WORKSHOP", roomLevel: 1, roomCount: 1 }],
          requireStages: [{ stageId: "wk_armor_3", rank: 2 }],
        },
      },
      manufactData: { phases: [{ speed: 1, outputCapacity: 24 }, { speed: 1, outputCapacity: 36 }, { speed: 1, outputCapacity: 54 }] },
      rooms: {
        MANUFACTURE: {
          phases: [
            { buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 1, electricity: 0 },
            { buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 2, electricity: 0 },
            { buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 3, electricity: 0 },
          ],
        },
        TRADING: { phases: [{ buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 1, electricity: 0 }] },
        WORKSHOP: { phases: [{ buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 1, electricity: 0 }] },
        CONTROL: { phases: [{ buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 1, electricity: 0 }] },
        TRAINING: { phases: [{ buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 1 }, { buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 1 }, { buildCost: { items: [], time: 0, labor: 0 }, maxStationedNum: 1 }] },
      },
    },
    CharacterTable: {
      char_spec: {
        skills: [{
          levelUpCostCond: [
            { lvlUpTime: 28800, levelUpCost: [{ id: "3303", count: 5, type: "MATERIAL" }] },
            { lvlUpTime: 57600, levelUpCost: [{ id: "3303", count: 6, type: "MATERIAL" }] },
            { lvlUpTime: 86400, levelUpCost: [{ id: "3303", count: 10, type: "MATERIAL" }] },
          ],
        }],
      },
    } as Record<string, CharRowMock>,
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
import type { Draft } from "mutative";
import type {
  PlayerBuilding,
  PlayerBuildingWorkshop,
  PlayerCharacter,
  PlayerDataModel,
} from "@game/kernel/playerdata";
import type { BuildingWithExt, RoomTimestamp, TraineeWithMaxPoint } from "@game/modules/building/logic/ext-types";
import config from "@core/config/index";
import { isFormulaUnlocked, isDiamondStrategyUnlocked } from "@game/modules/building/unlocks";
import type { FormulaUnlockSpec } from "@game/modules/building/unlocks";
import { getSpecCond, SPEC_ASSIST_BASE_BONUS } from "@game/modules/building/mastery";
import { BuildingManager } from "@game/modules/building/logic";

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

function makePlayer(
  building: BuildingFixture,
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

function baseBuilding(): BuildingFixture {
  return {
    status: {
      labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 1000, maxValue: 225 },
      workshop: { bonusActive: 0, bonus: {} },
    },
    chars: {},
    roomSlots: {
      slot_5: { level: 1, state: 2, roomId: "MANUFACTURE", charInstIds: [], completeConstructTime: -1 },
      slot_6: { level: 2, state: 2, roomId: "TRADING", charInstIds: [], completeConstructTime: -1 },
      slot_32: { level: 1, state: 2, roomId: "WORKSHOP", charInstIds: [], completeConstructTime: -1 },
      slot_13: { level: 3, state: 2, roomId: "TRAINING", charInstIds: [], completeConstructTime: -1 },
    },
    rooms: {
      CONTROL: {}, ELEVATOR: {}, POWER: {},
      MANUFACTURE: {
        slot_5: {
          state: 1, formulaId: "1", remainSolutionCnt: 0, outputSolutionCnt: 0,
          processPoint: 0, lastUpdateTime: 1000, completeWorkTime: -1, capacity: 0,
        },
      },
      TRADING: { slot_6: { state: 1, strategy: "O_GOLD", stock: [], lastUpdateTime: 1000 } },
      WORKSHOP: { slot_32: { state: 2 } },
      CORRIDOR: {}, DORMITORY: {}, MEETING: {}, HIRE: {},
      TRAINING: {
        slot_13: {
          trainee: { charInstId: -1, state: 0, targetSkill: -1, processPoint: 0, speed: 1 },
          trainer: { charInstId: -1, state: 0 },
          lastUpdateTime: 1000,
        },
      },
      PRIVATE: {},
    },
    furniture: {},
    diyPresetSolutions: {},
    assist: [-1, -1, -1],
    solution: { furnitureTs: {} },
    music: { inUse: false, selected: "bgm_default", state: {} },
  };
}

function setup(extra: Omit<MockPlayerDataSeed, "building"> = {}) {
  const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), {
    status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
    inventory: { "3112": 10, "3303": 5 },
    troop: { chars: {}, charGroup: {} },
    dungeon: { stages: {} },
    ...extra,
  });
  const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
  return { mockPlayer, mockTrigger, manager };
}

describe("unlocks.ts 纯函数（配方/策略解锁）", () => {
  const ctx = {
    maxLevelReached: { MANUFACTURE: 3, WORKSHOP: 1 },
    roomCountByType: { MANUFACTURE: 1, WORKSHOP: 1 },
    stageState: { wk_armor_3: 3 },
  };

  it("requireRooms：曾达等级与房间数均满足时 解锁", () => {
    // 显式空 requireStages：生成类型两键必填，与实现 `?? []` 的缺省语义等价
    const f: FormulaUnlockSpec = { requireRooms: [{ roomId: "MANUFACTURE", roomLevel: 3, roomCount: 1 }], requireStages: [] };
    expect(isFormulaUnlocked(f, ctx)).toBe(true);
  });

  it("requireRooms：曾达等级不足/房间数不足时 锁定", () => {
    const f: FormulaUnlockSpec = { requireRooms: [{ roomId: "MANUFACTURE", roomLevel: 3, roomCount: 2 }], requireStages: [] };
    expect(isFormulaUnlocked(f, ctx)).toBe(false); // 房间数 1 < 2
    const f2: FormulaUnlockSpec = { requireRooms: [{ roomId: "TRADING", roomLevel: 1, roomCount: 1 }], requireStages: [] };
    expect(isFormulaUnlocked(f2, ctx)).toBe(false); // 从未建造贸易站
  });

  it("requireStages：关卡星满足时 解锁；不足时 锁定", () => {
    const f: FormulaUnlockSpec = { requireRooms: [{ roomId: "WORKSHOP", roomLevel: 1, roomCount: 1 }], requireStages: [{ stageId: "wk_armor_3", rank: 2 }] };
    expect(isFormulaUnlocked(f, ctx)).toBe(true);
    expect(isFormulaUnlocked(f, { ...ctx, stageState: { wk_armor_3: 1 } })).toBe(false);
    expect(isFormulaUnlocked(f, { ...ctx, stageState: {} })).toBe(false);
  });

  it("无条件配方视为解锁；配方缺失视为锁定", () => {
    // 无条件配方 = 两条件皆空（实现按 `?? []` 处理缺省键，二者等价）
    const unconditional: FormulaUnlockSpec = { requireRooms: [], requireStages: [] };
    expect(isFormulaUnlocked(unconditional, ctx)).toBe(true);
    expect(isFormulaUnlocked(null, ctx)).toBe(false);
  });

  it("开采协力策略：站级 达 tradingStrategyUnlockLevel 时解锁", () => {
    expect(isDiamondStrategyUnlocked(2)).toBe(false);
    expect(isDiamondStrategyUnlocked(3)).toBe(true);
  });
});

describe("mastery.ts 纯函数（专精配置）", () => {
  it("getSpecCond 读取 lvlUpTime/levelUpCost（M1/M2/M3 档位）", () => {
    const c1 = getSpecCond("char_spec", 0, 1)!;
    expect(c1.lvlUpTime).toBe(28800);
    expect(c1.costs).toEqual([{ id: "3303", count: 5, type: "MATERIAL" }]);
    expect(getSpecCond("char_spec", 0, 3)!.lvlUpTime).toBe(86400);
    expect(getSpecCond("char_spec", 0, 4)).toBeNull(); // 超出专精上限
    expect(getSpecCond("char_missing", 0, 1)).toBeNull();
  });

  it("协助位基础加速常量为 5%", () => {
    expect(SPEC_ASSIST_BASE_BONUS).toBeCloseTo(0.05);
  });
});

describe("BuildingManager 配方解锁门控", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("changeManufactureSolution：未达曾达等级的配方拒绝（不切换、不结算）", async () => {
    const { manager, mockPlayer } = setup();
    // 配方 3 需制造站曾达 3 级——存档无 maxLevelReached 记录且站级 1 时
    await manager.changeManufactureSolution({ roomSlotId: "slot_5", targetFormulaId: "3", solutionCount: 10 });
    expect(mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.formulaId).toBe("1");
    expect(mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.remainSolutionCnt).toBe(0);
  });

  it("upgradeRoom 记录曾达等级后 高级配方解锁（降级不回退）_touchMaxLevel 保证", async () => {
    const { manager, mockPlayer } = setup();
    await manager.upgradeRoom({ roomSlotId: "slot_5", targetLevel: 3 });
    expect((mockPlayer._playerdata.building as BuildingWithExt).maxLevelReached!.MANUFACTURE).toBe(3);
    await manager.changeManufactureSolution({ roomSlotId: "slot_5", targetFormulaId: "3", solutionCount: 10 });
    expect(mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.formulaId).toBe("3");
    expect(mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.remainSolutionCnt).toBe(10);
  });

  it("workshopSynthesis：requireStages 未通关拒绝；通关后正常合成", async () => {
    const { manager, mockPlayer } = setup();
    // 未通关 wk_armor_3 时 拒绝（材料不扣）
    await manager.workshopSynthesis({ roomSlotId: "slot_32", times: 1, formulaId: "4" });
    expect(mockPlayer._playerdata.inventory!["3112"]).toBe(10);
    // 二星通关时 放行（直接控制解锁上下文，隔离 excel/dungeon 环境噪声）
    vi.spyOn(manager, "_unlockCtx").mockReturnValue({
      maxLevelReached: { WORKSHOP: 1 },
      roomCountByType: { WORKSHOP: 1 },
      stageState: { wk_armor_3: 2 },
    });
    const result = await manager.workshopSynthesis({ roomSlotId: "slot_32", times: 1, formulaId: "4" });
    expect(result).toEqual({ type: "MATERIAL", id: "3131", count: 1 });
    expect(mockPlayer._playerdata.inventory!["3112"]).toBe(8);
  });

  it("changeSaleSolution：开采协力需贸易站 3 级（2 级忽略策略，3 级生效）", async () => {
    const { manager, mockPlayer } = setup();
    await manager.changeSaleSolution({ slotId: "slot_6", targetFormulaId: "O_DIAMOND", solutionCount: 8 });
    const room = mockPlayer._playerdata.building.rooms.TRADING.slot_6;
    expect(room.strategy).toBe("O_GOLD"); // 站级 2 时 策略被拒
    expect(room.stockLimit).toBe(8); // 库存上限正常生效
    mockPlayer._playerdata.building.roomSlots.slot_6.level = 3;
    await manager.changeSaleSolution({ slotId: "slot_6", targetFormulaId: "O_DIAMOND" });
    expect(mockPlayer._playerdata.building.rooms.TRADING.slot_6.strategy).toBe("O_DIAMOND");
  });
});

describe("BuildingManager 专精系统（材料/时长/门控/训练锁）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // 禁用即时完成开发开关，保证走真实训练等待逻辑（同 building.test.ts 约定）
    config.developer!.specializationTimeZero = false;
  });

  afterEach(() => {
    config.developer!.specializationTimeZero = true;
  });

/** 满足专精门控的干员：精英2 + 技能7级 */
  function specChar(extra: MockSeed<PlayerCharacter> = {}) {
    return {
      charId: "char_spec", level: 80, evolvePhase: 2, mainSkillLvl: 7,
      skills: [{ skillId: "sk1", unlock: 1, state: 0, specializeLevel: 0, completeUpgradeTime: -1 }],
      ...extra,
    };
  }

  it("门控：非精英2 / 技能未满级时 拒绝（不扣材料）", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar({ evolvePhase: 1 }) }, charGroup: {} },
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].state).toBe(0);
    expect(mockPlayer._playerdata.inventory!["3303"]).toBe(5);

    const r2 = setup({
      troop: { chars: { "501": specChar({ mainSkillLvl: 6 }) }, charGroup: {} },
    });
    await r2.manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(r2.mockPlayer._playerdata.troop.chars["501"].skills[0].state).toBe(0);
  });

  it("材料不足时 拒绝（不开始训练）", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar() }, charGroup: {} },
      inventory: { "3112": 10, "3303": 4 }, // 需 5 个 3303
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].state).toBe(0);
  });

  it("正常路径：扣材料 + trainee 记录 maxPoint（lvlUpTime 后 完成时刻", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar() }, charGroup: {} },
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(mockPlayer._playerdata.inventory!["3303"]).toBe(0); // 5 - 5
    const skill = mockPlayer._playerdata.troop.chars["501"].skills[0];
    expect(skill.state).toBe(1);
    expect(skill.completeUpgradeTime).toBe(timeMock.now + 28800);
    const trainee = mockPlayer._playerdata.building.rooms.TRAINING.slot_13.trainee as TraineeWithMaxPoint;
    expect(trainee.charInstId).toBe(501);
    expect(trainee.state).toBe(1);
    expect(trainee.maxPoint).toBe(28800);
  });

  it("训练锁：训练中（state=1）干员拒绝派往其他房间", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar() }, charGroup: {} },
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    await manager.assignChar({ roomSlotId: "slot_5", charInstIdList: [501] });
    // 拒绝：制造站未进驻该干员
    expect(mockPlayer._playerdata.building.roomSlots.slot_5.charInstIds).toEqual([]);
  });

  it("训练时长到达后 待领取（state=2）；未到不可结算，到达后专精+1", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar() }, charGroup: {} },
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    // 未到时长：结算被拒
    await manager.completeUpgradeSpecialization({});
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].specializeLevel).toBe(0);
    // 推进超过 8h（无教官/协助时 速度 1）
    const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
    draft.building.rooms.TRAINING.slot_13.lastUpdateTime = timeMock.now;
    manager["_accrueTraining"](draft, timeMock.now + 28800);
    expect(draft.building.rooms.TRAINING.slot_13.trainee.state).toBe(2); // OUTOFDATE 待领取
    expect(draft.building.rooms.TRAINING.slot_13.trainee.processPoint).toBe(28800);
    // 应用进度后结算 → 专精 +1
    Object.assign(mockPlayer._playerdata, { building: draft.building });
    await manager.completeUpgradeSpecialization({});
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].specializeLevel).toBe(1);
  });
});

describe("训练室专精：即时完成分支（specializationTimeZero=true，data/config.json 默认）", () => {
  // 修复回归：该分支此前跳过全部门控与扣费（直接 specializeLevel += 1），
  // 默认配置下可白嫖专精、无视精二/技能 7 级、且能无限超过专三。
  beforeEach(() => {
    vi.restoreAllMocks();
    config.developer!.specializationTimeZero = true;
  });

  afterEach(() => {
    config.developer!.specializationTimeZero = false;
  });

  /** 满足专精门控的干员：精英2 + 技能 7 级 + 技能已解锁 */
  function specChar(extra: MockSeed<PlayerCharacter> = {}) {
    return {
      charId: "char_spec", level: 80, evolvePhase: 2, mainSkillLvl: 7,
      skills: [{ skillId: "sk1", unlock: 1, state: 0, specializeLevel: 0, completeUpgradeTime: -1 }],
      ...extra,
    };
  }

  it("门控：非精英2 时拒绝（不扣材料、不涨专精）", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar({ evolvePhase: 1 }) }, charGroup: {} },
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].specializeLevel).toBe(0);
    expect(mockPlayer._playerdata.inventory!["3303"]).toBe(5);
  });

  it("门控：技能 7 级以下时拒绝", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar({ mainSkillLvl: 6 }) }, charGroup: {} },
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].specializeLevel).toBe(0);
    expect(mockPlayer._playerdata.inventory!["3303"]).toBe(5);
  });

  it("门控：技能未解锁（unlock=0）时拒绝", async () => {
    const { manager, mockPlayer } = setup({
      troop: {
        chars: { "501": specChar({ skills: [{ skillId: "sk1", unlock: 0, state: 0, specializeLevel: 0, completeUpgradeTime: -1 }] }) },
        charGroup: {},
      },
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].specializeLevel).toBe(0);
  });

  it("门控：材料不足时拒绝", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar() }, charGroup: {} },
      inventory: { "3112": 10, "3303": 4 }, // M1 需 5 个 3303
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].specializeLevel).toBe(0);
    expect(mockPlayer._playerdata.inventory!["3303"]).toBe(4);
  });

  it("正常路径：扣材料 + 立即到 M1（不等待）+ 发 UpgradeSpecialization + trainee 复位", async () => {
    const { manager, mockPlayer, mockTrigger } = setup({
      troop: { chars: { "501": specChar() }, charGroup: {} },
    });
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    const skill = mockPlayer._playerdata.troop.chars["501"].skills[0];
    expect(skill.specializeLevel).toBe(1); // 即时完成，不是 state=1 等待
    expect(skill.state).toBe(0);
    expect(skill.completeUpgradeTime).toBe(-1);
    expect(mockPlayer._playerdata.inventory!["3303"]).toBe(0); // 扣满 5
    const trainee = mockPlayer._playerdata.building.rooms.TRAINING.slot_13.trainee;
    expect(trainee.state).toBe(3); // WAITING
    expect(trainee.targetSkill).toBe(-1);
    expect(emitSpy).toHaveBeenCalledWith("UpgradeSpecialization", [{ targetLevel: 1 }]);
  });

  it("逐级消耗：M1→M2→M3 各扣对应材料，超过 M3 拒绝（不会无限增长）", async () => {
    const { manager, mockPlayer } = setup({
      troop: { chars: { "501": specChar() }, charGroup: {} },
      inventory: { "3303": 21 }, // 5 + 6 + 10
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    const skill = mockPlayer._playerdata.troop.chars["501"].skills[0];
    expect(skill.specializeLevel).toBe(3);
    expect(mockPlayer._playerdata.inventory!["3303"]).toBe(0);
    // 第四次：已达专三上限，拒绝且不再扣材料
    const { manager: m2, mockPlayer: p2 } = setup({
      troop: { chars: { "501": specChar({ skills: [{ skillId: "sk1", unlock: 1, state: 0, specializeLevel: 3, completeUpgradeTime: -1 }] }) }, charGroup: {} },
    });
    await m2.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    expect(p2._playerdata.troop.chars["501"].skills[0].specializeLevel).toBe(3);
    expect(p2._playerdata.inventory!["3303"]).toBe(5);
  });

  it("训练中（state=1）的存档切到即时配置：直接结算且不重复扣材料", async () => {
    const { manager, mockPlayer } = setup({
      troop: {
        chars: {
          "501": specChar({
            skills: [{ skillId: "sk1", unlock: 1, state: 1, specializeLevel: 0, completeUpgradeTime: timeMock.now + 28800 }],
          }),
        },
        charGroup: {},
      },
      inventory: { "3303": 0 }, // 材料已在训练发起时扣光
    });
    await manager.upgradeSpecialization({ charInstId: 501, targetSkill: 0 });
    const skill = mockPlayer._playerdata.troop.chars["501"].skills[0];
    expect(skill.specializeLevel).toBe(1);
    expect(skill.state).toBe(0);
    expect(mockPlayer._playerdata.inventory!["3303"]).toBe(0); // 未再扣（仍是 0，不会变负）
  });

  it("结算上限：已 M3 时 completeUpgradeSpecialization 不再 +1", async () => {
    const { manager, mockPlayer } = setup({
      troop: {
        chars: { "501": specChar({ skills: [{ skillId: "sk1", unlock: 1, state: 0, specializeLevel: 3, completeUpgradeTime: -1 }] }) },
        charGroup: {},
      },
    });
    const rooms = mockPlayer._playerdata.building.rooms.TRAINING;
    rooms.slot_13.trainee = { charInstId: 501, state: 2, targetSkill: 0, processPoint: 28800, speed: 1 };
    await manager.completeUpgradeSpecialization({});
    expect(mockPlayer._playerdata.troop.chars["501"].skills[0].specializeLevel).toBe(3);
  });
});

