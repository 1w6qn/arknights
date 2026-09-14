import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BuildingManager 统一 deltaTime 推进 / 贸易站订单时间模型 / 技能描述解析器增强
 *
 * 覆盖 2026-08-19 增量：
 * - _advanceBuilding(draft, ts, tsFloat)：统一时间推进入口——所有子系统以
 *   elapsed = ts - lastUpdateTime 推进，时间基准可注入（无需 mock 时钟）
 * - 贸易站订单时间模型（_accrueTrading）：next.processPoint 按有效速度
 *   （存档 speed × (1 + 干员 trade buff + 控制中枢全局)）累积，达到 maxPoint
 *   逐笔生成订单；回写 room.buff={speed, limit}（官方线格式）
 * - 静态补单兜底：next.maxPoint>0（时间模型激活）的房间跳过，旧存档补满 stockLimit
 * - buff.ts 解析器增强：parseDescTags / parsePlainPercent / buffValueForTarget
 *   vdown·纯文本% 兜底 / parseMoodCostValue vdo 标签
 */

/** excel mock 行形状（本文件三张表均不提供，仅需占位让门面方法的 `this` 推断成立） */
interface ExcelRowMock { name?: string }

// Excel BuildingData 样本（buff 数值字段 + 描述富文本 + 生产/房间相位）
const excelMock = vi.hoisted(() => ({
  default: {
    // —— 本文件不提供的表（占位；与键缺失在 `?.` 读取下运行时等价）——
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
      buffs: {
        "manu_prod_spd[000]": {
          buffId: "manu_prod_spd[000]", roomType: "MANUFACTURE", efficiency: 15,
          targets: ["F_GOLD", "F_EXP", "F_DIAMOND"],
          description: "进驻制造站时，生产力<@cc.vup>+15%</>",
        },
        "trade_ord_spd[000]": {
          buffId: "trade_ord_spd[000]", roomType: "TRADING", efficiency: 20,
          targets: [], description: "进驻贸易站时，订单获取效率<@cc.vup>+20%</>",
        },
        "control_tra_spd[000]": {
          buffId: "control_tra_spd[000]", roomType: "CONTROL", efficiency: 0,
          targets: [],
          description: "进驻控制中枢时，所有贸易站订单效率<@cc.vup>+7%</>（同种效果取最高）",
        },
        "dorm_rec_all[010]": {
          buffId: "dorm_rec_all[010]", roomType: "DORMITORY", efficiency: 0,
          targets: [],
          description: "进驻宿舍时，该宿舍内所有干员的心情每小时恢复<@cc.vup>+0.15</>（同种效果取最高）",
        },
        "train_spd_doubleProf[100]": {
          buffId: "train_spd_doubleProf[100]", roomType: "TRAINING", efficiency: 50,
          targets: [], description: "进驻训练室时，专精技能训练速度<@cc.vup>+50%</>",
        },
      },
      chars: {
        "char_prod": { charId: "char_prod", buffChar: [{ buffData: [{ buffId: "manu_prod_spd[000]", cond: { level: 1 } }] }] },
        "char_trade": { charId: "char_trade", buffChar: [{ buffData: [{ buffId: "trade_ord_spd[000]", cond: { level: 1 } }] }] },
        "char_ctrl": { charId: "char_ctrl", buffChar: [{ buffData: [{ buffId: "control_tra_spd[000]", cond: { level: 1 } }] }] },
        "char_train": { charId: "char_train", buffChar: [{ buffData: [{ buffId: "train_spd_doubleProf[100]", cond: { level: 1 } }] }] },
      },
      manufactData: {
        phases: [
          { speed: 1, outputCapacity: 24 },
          { speed: 1, outputCapacity: 36 },
          { speed: 1, outputCapacity: 54 },
        ],
      },
      dormData: { phases: [{ manpowerRecover: 160 }, { manpowerRecover: 170 }] },
      manufactFormulas: {
        "4": { formulaId: "4", itemId: "3003", count: 1, costPoint: 4320, formulaType: "F_GOLD", costs: [] },
      },
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
  asModel,
  type MockPlayerDataSeed,
  type MockPlayerDataManager,
  type MockUpdateRecipe,
} from "../../helpers";
import {
  parseDescTags,
  parsePlainPercent,
  parseVupValue,
  parseMoodCostValue,
  buffValueForTarget,
} from "@game/modules/building/buff";
import { BuildingManager } from "@game/modules/building/logic";
import { goldOrderSeconds } from "@game/modules/building/trade-orders";
import type { TradingRoom } from "@game/modules/building/logic/ext-types";
import type {
  PlayerDataModel,
  PlayerBuildingChar,
  PlayerBuildingControl,
  PlayerBuildingDormitory,
  PlayerBuildingHire,
  PlayerBuildingMeeting,
  PlayerBuildingTrading,
  PlayerBuildingTraining,
  PlayerCharacter,
} from "@game/kernel/playerdata";
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

/** 基础 building 结构（制造站/贸易站/控制中枢/宿舍/训练室槽位） */
function baseBuilding(): MockPlayerDataSeed["building"] {
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

/** 深拷贝当前玩家 building 草稿（供 _advanceBuilding 直接注入 ts 验证 deltaTime） */
function draftOf(mockPlayer: MockPlayerDataManager): Draft<PlayerDataModel> {
  return JSON.parse(JSON.stringify(mockPlayer._playerdata)) as Draft<PlayerDataModel>;
}

/** 构造测试 manager 与基础玩家 */
function setup() {
  const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), {
    status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
    inventory: {},
    troop: { chars: {}, charGroup: {} },
  });
  const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
  return { mockPlayer, mockTrigger, manager };
}

describe("基建技能描述解析器增强（@game/modules/building/buff）", () => {
  it("parseDescTags 提取 vup/vdown/vdo 全部数值标签", () => {
    // 注意："+<@cc.vup>4%</>" 的加号在标签外 → 标签内数值 4 无符号
    expect(parseDescTags("每<@cc.vup>16</>个机器人+<@cc.vup>4%</>")).toEqual([
      { tag: "vup", value: 16, hasPct: false, signed: false },
      { tag: "vup", value: 4, hasPct: true, signed: false },
    ]);
    expect(parseDescTags("心情每小时消耗<@cc.vdown>+0.25</>")).toEqual([
      { tag: "vdown", value: 0.25, hasPct: false, signed: true },
    ]);
    expect(parseDescTags("每<@cc.vdo>10</>点<@cc.vup>+1%</>")).toEqual([
      { tag: "vdo", value: 10, hasPct: false, signed: false },
      { tag: "vup", value: 1, hasPct: true, signed: true },
    ]);
    expect(parseDescTags("无标签")).toEqual([]);
  });

  it("parsePlainPercent 提取纯文本百分数（无富文本标签的兜底）", () => {
    expect(parsePlainPercent("生产力+15%")).toBe(15);
    expect(parsePlainPercent("订单效率-20.5%")).toBe(-20.5);
    expect(parsePlainPercent("无百分比")).toBeNull();
  });

  it("parseVupValue 仍只认 vup 标签（向后兼容）", () => {
    expect(parseVupValue("生产力<@cc.vup>+30%</>")).toBe(30);
    expect(parseVupValue("消耗<@cc.vdown>+0.25</>")).toBeNull();
  });

  it("buffValueForTarget：vdown 带 % / 纯文本 % 兜底，计数类保持 0", () => {
    // vdown 带 % → 加成
    expect(buffValueForTarget({ description: "制造速度<@cc.vdown>+10%</>" })).toBeCloseTo(0.1);
    // 无标签 → 纯文本 % 兜底
    expect(buffValueForTarget({ description: "制造速度+15%" })).toBeCloseTo(0.15);
    // 计数/阈值（无 %、非宿舍）仍不贡献
    expect(buffValueForTarget({ description: "每<@cc.vup>16</>个机器人+1" })).toBe(0);
    // 既有 efficiency 优先
    expect(buffValueForTarget({ efficiency: 25, description: "生产力+15%" })).toBeCloseTo(0.25);
  });

  it("parseMoodCostValue 支持 vdo 标签的消耗语境", () => {
    expect(parseMoodCostValue("心情每小时消耗<@cc.vdo>0.25</>")).toBe(0.25);
    expect(parseMoodCostValue("无消耗语境")).toBeNull();
  });
});

describe("BuildingManager 统一 deltaTime 推进（_advanceBuilding 注入 ts）", () => {
  // deltaTime 语义：elapsed = ts - lastUpdateTime。lastUpdateTime=0 视为未初始化
  // （防御：旧存档不瞬间回满），测试统一用 lastUpdateTime=1000、ts=1000+delta。
  const LAST = 1000;
  const at = (delta: number) => LAST + delta;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("劳动力按 deltaTime 恢复（elapsed / laborRecoverTime，封顶 maxValue）", () => {
    const { manager, mockPlayer } = setup();
    const draft = draftOf(mockPlayer);
    draft.building.status.labor.lastUpdateTime = LAST;
    manager["_advanceBuilding"](draft, at(3600));
    // 3600s / 360 = 10 点 → 100 + 10
    expect(draft.building.status.labor.value).toBe(110);
    // 超上限封顶
    draft.building.status.labor.lastUpdateTime = at(3600);
    draft.building.status.labor.value = 220;
    manager["_advanceBuilding"](draft, at(3600 + 36000));
    expect(draft.building.status.labor.value).toBe(225);
  });

  it("制造站按 deltaTime 产出（1 点/秒速率 → costPoint 阈值，计划剩余钳制）", () => {
    const { manager, mockPlayer } = setup();
    const draft = draftOf(mockPlayer);
    draft.building.rooms.MANUFACTURE.slot_5.lastUpdateTime = LAST;
    // 1 点/秒（2026-08-26 dc-fix，不再按容量×时间）→ 43200s × 1 = 43200 → 43200/4320 = 10 批 → remain 10 钳制
    manager["_advanceBuilding"](draft, at(43200));
    const room = draft.building.rooms.MANUFACTURE.slot_5;
    expect(room.outputSolutionCnt).toBe(10);
    expect(room.remainSolutionCnt).toBe(0);
    // 进度按计划消耗后归零（processPoint -= produced × costPoint = 10×4320）
    expect(room.processPoint).toBe(0);
  });

  it("干员心情按 deltaTime 消耗/恢复（changeScale 档位 × elapsed）", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.roomSlots.slot_5.charInstIds = [101];
    mockPlayer._playerdata.building.chars["101"] = asModel<PlayerBuildingChar>({
      charId: "char_prod", ap: 8640000, lastApAddTime: LAST, roomSlotId: "slot_5", index: 0,
      changeScale: 0, bubble: {}, workTime: 0, privateRooms: [],
    });
    mockPlayer._playerdata.troop.chars["101"] = asModel<PlayerCharacter>({ charId: "char_prod", level: 1, evolvePhase: 0 });
    mockPlayer._playerdata.building.roomSlots.slot_28.charInstIds = [201];
    mockPlayer._playerdata.building.rooms.DORMITORY.slot_28 = asModel<PlayerBuildingDormitory>({ comfort: 0, buff: {} });
    mockPlayer._playerdata.building.chars["201"] = asModel<PlayerBuildingChar>({
      charId: "char_dorm", ap: 0, lastApAddTime: LAST, roomSlotId: "slot_28", index: 0,
      changeScale: 0, bubble: {}, workTime: 0, privateRooms: [],
    });
    mockPlayer._playerdata.troop.chars["201"] = asModel<PlayerCharacter>({ charId: "char_dorm", level: 1, evolvePhase: 0 });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3600));
    // 制造干员：基础 -55 AP/秒 → ap = 8640000 - 55×3600
    expect(draft.building.chars["101"].changeScale).toBe(-55);
    expect(draft.building.chars["101"].ap).toBe(8640000 - 55 * 3600);
    // 宿舍干员：恢复公式 (1.5+0.1×1级)=1.6 点/小时 × 100 = 160 AP/秒 → ap = 160×3600
    expect(draft.building.chars["201"].changeScale).toBe(160);
    expect(draft.building.chars["201"].ap).toBe(576000);
  });

  it("训练室按 deltaTime 推进 trainee.processPoint（教官 train buff 加成）", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.roomSlots.slot_13 = {
      level: 1, state: 2, roomId: "TRAINING", charInstIds: [401, 402], completeConstructTime: -1,
    };
    mockPlayer._playerdata.building.rooms.TRAINING.slot_13 = asModel<PlayerBuildingTraining>({
      state: 1,
      trainer: { charInstId: 401, state: 3 },
      trainee: { charInstId: 402, state: 1, processPoint: 0, speed: 1000, targetSkill: 0 }, // TRAINING=1（官方枚举）
      lastUpdateTime: LAST, completeWorkTime: -1,
    });
    mockPlayer._playerdata.troop.chars["401"] = asModel<PlayerCharacter>({ charId: "char_train", level: 1, evolvePhase: 0 });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3600));
    // 1000 × (1 + 0.55) × 3600（教官 0.5 + 协助位 0.05）
    expect(draft.building.rooms.TRAINING.slot_13.trainee.processPoint).toBe(1000 * 1.55 * 3600);
  });

  it("训练室 state=3（WAITING 等待）不推进——官方枚举语义", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.roomSlots.slot_13 = {
      level: 1, state: 2, roomId: "TRAINING", charInstIds: [401, 402], completeConstructTime: -1,
    };
    mockPlayer._playerdata.building.rooms.TRAINING.slot_13 = asModel<PlayerBuildingTraining>({
      state: 1,
      trainer: { charInstId: 401, state: 3 },
      trainee: { charInstId: 402, state: 3, processPoint: 500, speed: 1000, targetSkill: 0 },
      lastUpdateTime: LAST, completeWorkTime: -1,
    });
    mockPlayer._playerdata.troop.chars["401"] = asModel<PlayerCharacter>({ charId: "char_train", level: 1, evolvePhase: 0 });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3600));
    expect(draft.building.rooms.TRAINING.slot_13.trainee.processPoint).toBe(500);
  });

  it("会客室按 deltaTime 推进线索搜集进度（processPoint += elapsed × 有效速度）", () => {
    const { manager, mockPlayer } = setup();
    // B11（PRTS 会客室页）：「进驻干员后，干员将自动开始线索收集」——未进驻不搜集，
    // 故基线用例派驻 1 名 1★精0非涣散干员（非涣散 +5%）
    mockPlayer._playerdata.building.roomSlots.slot_36 = {
      level: 1, state: 2, roomId: "MEETING", charInstIds: [501], completeConstructTime: -1,
    };
    mockPlayer._playerdata.troop.chars["501"] = asModel<PlayerCharacter>({ charId: "char_meet", level: 1, evolvePhase: 0 });
    mockPlayer._playerdata.building.rooms.MEETING.slot_36 = asModel<PlayerBuildingMeeting>({
      state: 1, speed: 100, processPoint: 0, lastUpdateTime: LAST, completeWorkTime: -1,
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3600));
    const room = draft.building.rooms.MEETING.slot_36;
    // 官方全公式（2026-08-25）：Lv1 效率 107% + 非涣散 5% → speed = 100 × 1.12 = 112
    expect(room.speed).toBe(112);
    expect(room.processPoint).toBe(3600 * 112);
    // 时间戳推进到当前
    expect(room.lastUpdateTime).toBe(at(3600));
  });

  it("人力办公室按 deltaTime 推进人脉搜集进度（processPoint += elapsed × 有效速度）", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.roomSlots.slot_37 = {
      level: 1, state: 2, roomId: "HIRE", charInstIds: [], completeConstructTime: -1,
    };
    mockPlayer._playerdata.building.rooms.HIRE.slot_37 = asModel<PlayerBuildingHire>({
      state: 1, speed: 100, processPoint: 0, lastUpdateTime: LAST, completeWorkTime: -1,
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3600));
    const room = draft.building.rooms.HIRE.slot_37;
    // 基础 resSpeed=100 → 3600 × 100
    expect(room.speed).toBe(100);
    expect(room.processPoint).toBe(3600 * 100);
  });

  it("统一时间戳：无推进逻辑的房间（CONTROL）lastUpdateTime 也推进到当前", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.rooms.CONTROL.slot_34 = asModel<PlayerBuildingControl>({
      buff: {}, apCost: 0, lastUpdateTime: LAST, presetQueue: [],
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3600));
    // CONTROL 无 state 字段（常驻房间）→ 时间戳恒推进
    expect(draft.building.rooms.CONTROL.slot_34.lastUpdateTime).toBe(at(3600));
  });
});

describe("BuildingManager 贸易站订单时间模型（_accrueTrading）", () => {
  const LAST = 1000;
  const at = (delta: number) => LAST + delta;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("next.processPoint 随时间累积，达到 maxPoint 逐笔生成订单", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 5, strategy: "O_GOLD", lastUpdateTime: LAST,
      // Round 25/B9：订单时长改用官服档位（Lv1 站 → 2 赤金 8640s = 2:24）；
      // 生成订单后 maxPoint 会按实际赤金数改写，故此处与 8640 对齐
      next: { order: -1, processPoint: 0, speed: 1, maxPoint: 8640 },
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(8640)); // 8640s × 1 = 8640 → 满阈值 → 1 单
    let room = draft.building.rooms.TRADING.slot_6;
    expect(room.stock).toHaveLength(1);
    expect(room.next.order).toBe(0);
    expect(room.next.processPoint).toBe(0);
    manager["_advanceBuilding"](draft, at(17280)); // 又 8640s → 第 2 单
    room = draft.building.rooms.TRADING.slot_6;
    expect(room.stock).toHaveLength(2);
    expect(room.stock[1].instId).toBe(1);
  });

  // Round 25 / B9：订单整周期按赤金数取档（官服存档实证：同为 Lv3 的两站 maxPoint = 12600 / 8640）
  it("goldOrderSeconds：2/3/4 赤金 = 8640/12600/16560（2:24 / 3:30 / 4:36）", () => {
    expect(goldOrderSeconds(2)).toBe(8640);
    expect(goldOrderSeconds(3)).toBe(12600);
    expect(goldOrderSeconds(4)).toBe(16560);
    expect(goldOrderSeconds(9)).toBe(12600); // 未知档回退 3 赤金档
  });

  it("生成订单后按赤金数改写 next.maxPoint 并记录 _lastOrderSpanSec", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 5, strategy: "O_GOLD", lastUpdateTime: LAST,
      next: { order: -1, processPoint: 0, speed: 1, maxPoint: 8640 },
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(8640));
    const room = draft.building.rooms.TRADING.slot_6;
    const gold = room.stock[0].delivery[0].count;
    expect(gold).toBe(2); // Lv1 站基础分布 100% 2 赤金
    expect(room.next.maxPoint).toBe(goldOrderSeconds(gold));
    expect((room as TradingRoom)._lastOrderSpanSec).toBe(goldOrderSeconds(gold));
    // 收益仍为 交付赤金 × 汇率（500/赤金）
    expect(room.stock[0].gain).toEqual({ id: "4001", type: "GOLD", count: gold * 500 });
  });

  it("订单效率受进驻干员 trade buff + 控制中枢全局加成（有效速度回写）", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.roomSlots.slot_6.charInstIds = [701];
    mockPlayer._playerdata.building.roomSlots.slot_34.charInstIds = [801];
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 5, strategy: "O_GOLD", lastUpdateTime: LAST,
      next: { order: -1, processPoint: 0, speed: 1, maxPoint: 3000 },
    });
    mockPlayer._playerdata.troop.chars["701"] = asModel<PlayerCharacter>({ charId: "char_trade", level: 1, evolvePhase: 0 });
    mockPlayer._playerdata.troop.chars["801"] = asModel<PlayerCharacter>({ charId: "char_ctrl", level: 1, evolvePhase: 0 });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3000));
    const room = draft.building.rooms.TRADING.slot_6;
    // buff.speed = 0.2（trade_ord_spd）+ 0.07（control_tra_spd）= 0.27；limit = stockLimit
    expect(room.buff.speed).toBeCloseTo(0.27);
    expect(room.buff.limit).toBe(5);
    // 有效速度 1.27 → 3000s × 1.27 = 3810 → 1 单 + 810 进度
    expect(room.stock).toHaveLength(1);
    expect(room.next.processPoint).toBeCloseTo(810);
    expect(room.next.speed).toBeCloseTo(1.27);
  });

  it("时间模型激活（next.maxPoint>0）的房间不被静态补单覆盖", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 5, strategy: "O_GOLD", lastUpdateTime: LAST,
      next: { order: -1, processPoint: 0, speed: 1, maxPoint: 3000 },
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(100)); // 未达阈值 → 无订单
    expect(draft.building.rooms.TRADING.slot_6.stock).toHaveLength(0); // 不被补满
  });

  it("旧存档无 next：静态补单兜底（按 stockLimit 补满，不受时间模型影响）", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 5, strategy: "O_GOLD", lastUpdateTime: LAST,
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3000));
    const room = draft.building.rooms.TRADING.slot_6;
    expect(room.stock).toHaveLength(5);
    // 不产生 next（不污染存档语义）
    expect(room.next).toBeUndefined();
    // buff.speed 仍回写（0 加成）
    expect(room.buff.speed).toBe(0);
  });

  it("库存满时即使达到阈值也不再生成（尊重 stockLimit）", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 1, strategy: "O_GOLD", lastUpdateTime: LAST,
      next: { order: -1, processPoint: 0, speed: 1, maxPoint: 3000 },
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3000));
    expect(draft.building.rooms.TRADING.slot_6.stock).toHaveLength(1);
    manager["_advanceBuilding"](draft, at(6000));
    expect(draft.building.rooms.TRADING.slot_6.stock).toHaveLength(1); // 上限 1，不再生成
  });

  it("fix(八一八交付刷单)：交付清空后立即 sync 不补满，须等待补单节流才逐笔补", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 5, strategy: "O_GOLD", lastUpdateTime: LAST,
    });
    const draft = draftOf(mockPlayer);
    // 首次 sync：守卫初始化补满到 stockLimit
    manager["_advanceBuilding"](draft, at(0));
    let room = draft.building.rooms.TRADING.slot_6;
    expect(room.stock).toHaveLength(5);
    // 模拟 deliveryBatchOrder 交付：清空全部库存
    room.stock = [];
    // 紧接着 sync（间隔 < 该房间上一笔订单整周期）→ 不得立即补满（防反复领取刷单）。
    // Round 25/B9：节流间隔由固定 3600s 改为订单实际时长（2 赤金 = 8640s），
    // 与官服订单周期一致（原 3600s 会使旧存档补单快 2.4~4.6 倍）。
    manager["_advanceBuilding"](draft, at(100));
    room = draft.building.rooms.TRADING.slot_6;
    expect(room.stock).toHaveLength(0);
    manager["_advanceBuilding"](draft, at(4000));
    room = draft.building.rooms.TRADING.slot_6;
    expect(room.stock).toHaveLength(0); // 仍未到订单整周期
    // 超过订单整周期后再次 sync → 只补 1 单（随时间逐笔）
    manager["_advanceBuilding"](draft, at(9000));
    room = draft.building.rooms.TRADING.slot_6;
    expect(room.stock).toHaveLength(1);
  });

  it("fix(信赖时间结算)：在岗干员信赖随时间累计（basicFavorPerDay/24 每小时），未进驻不结算", () => {
    const { manager, mockPlayer } = setup();
    // 在岗干员：进驻贸易站 slot_6
    mockPlayer._playerdata.building.roomSlots.slot_6 = {
      level: 3, state: 2, roomId: "TRADING", charInstIds: [5], completeConstructTime: -1,
    };
    mockPlayer._playerdata.building.chars["5"] = asModel<PlayerBuildingChar>({ charId: "char_5", ap: 5000, lastApAddTime: LAST });
    mockPlayer._playerdata.troop.chars["5"] = asModel<PlayerCharacter>({ charId: "char_5", favorPoint: 100 });
    mockPlayer._playerdata.troop.charGroup["char_5"] = { favorPoint: 100 };
    const draft = draftOf(mockPlayer);
    // 首次 sync：建立 lastFavorAddTime 基准（不结算）
    manager["_advanceBuilding"](draft, at(0));
    expect(draft.troop.chars["5"].favorPoint).toBe(100);
    // 1 小时后：信赖 += 720/24 = 30（每小时 30 点）
    manager["_advanceBuilding"](draft, at(3600));
    expect(draft.troop.chars["5"].favorPoint).toBeCloseTo(130);
    expect(draft.troop.charGroup["char_5"].favorPoint).toBeCloseTo(130);
    // 未进驻干员（chars 有记录但不在岗）不结算
    mockPlayer._playerdata.building.chars["99"] = asModel<PlayerBuildingChar>({ charId: "char_99", ap: 5000, lastApAddTime: LAST });
    mockPlayer._playerdata.troop.chars["99"] = asModel<PlayerCharacter>({ charId: "char_99", favorPoint: 50 });
    mockPlayer._playerdata.troop.charGroup["char_99"] = { favorPoint: 50 };
    const draft2 = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft2, at(3600));
    expect(draft2.troop.chars["99"].favorPoint).toBe(50);
  });

  it("fix(八一八交付刷单)：补单节流不污染时间模型房间（next.maxPoint>0 仍走 _accrueTrading）", () => {
    const { manager, mockPlayer } = setup();
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 5, strategy: "O_GOLD", lastUpdateTime: LAST,
      next: { order: -1, processPoint: 0, speed: 1, maxPoint: 3000 },
    });
    const draft = draftOf(mockPlayer);
    manager["_advanceBuilding"](draft, at(3000)); // 满阈值 → 1 单（时间模型）
    expect(draft.building.rooms.TRADING.slot_6.stock).toHaveLength(1);
    expect((draft.building.rooms.TRADING.slot_6 as TradingRoom)._lastOrderFillTs).toBeUndefined();
  });
});
