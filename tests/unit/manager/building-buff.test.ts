import { describe, it, expect, vi, beforeEach } from "vitest";

// Excel BuildingData 样本（真实结构：buffs 数值字段 efficiency + 描述富文本标签、
// chars.buffChar 条件激活、manufactData/dormData 相位）

/** excel mock 的行形状（本文件只读取 name） */
interface ExcelRowMock { name?: string }

/** excel.BuildingData.buffs 单行（生成类型） */
type ExcelBuffRow = Excel["BuildingData"]["buffs"][string];

/**
 * 技能行 mock 形状
 *
 * 引擎读取字段子集（{@link BuildingBuffLike}）叠加本文件用于筛选/展示的字段；
 * 行字面量经 `satisfies` 受本类型约束 → `roomType`/`buffCategory` 收窄为生成枚举字面量，
 * 可直接作为 `BuildingBuffLike` 传入引擎（无需 cast）。
 */
type BuffRowMock = BuildingBuffLike & Partial<Pick<ExcelBuffRow, "buffName" | "buffCategory">>;

const excelMock = vi.hoisted(() => ({
  default: {
    // —— 本文件不提供的表（占位，与「键不存在」在 ?. 读取下等价）——
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
      buffs: {
        // 输出型：efficiency 字段（百分比整数）
        "manu_prod_spd[000]": { buffId: "manu_prod_spd[000]", buffName: "标准化·α", roomType: "MANUFACTURE", buffCategory: "OUTPUT", efficiency: 15, targets: ["F_GOLD", "F_EXP", "F_DIAMOND"], description: "进驻制造站时，生产力<@cc.vup>+15%</>" },
        "manu_prod_spd[010]": { buffId: "manu_prod_spd[010]", buffName: "标准化·α", roomType: "MANUFACTURE", buffCategory: "OUTPUT", efficiency: 25, targets: ["F_GOLD", "F_EXP", "F_DIAMOND"], description: "进驻制造站时，生产力<@cc.vup>+25%</>" },
        "manu_formula_spd[100]": { buffId: "manu_formula_spd[100]", roomType: "MANUFACTURE", buffCategory: "OUTPUT", efficiency: 30, targets: ["F_GOLD"], description: "贵金属类配方生产力<@cc.vup>+30%</>" },
        "manu_formula_spd&cost[001]": { buffId: "manu_formula_spd&cost[001]", roomType: "MANUFACTURE", buffCategory: "OUTPUT", efficiency: 25, targets: ["F_GOLD"], description: "贵金属类配方生产力<@cc.vup>+25%</>，心情每小时消耗<@cc.vdown>+0.25</>" },
        // 输出型：无 efficiency → 描述 vup 带 % 按百分比；无 % 的计数/阈值不贡献
        "manu_prod_spd_bd[100]": { buffId: "manu_prod_spd_bd[100]", roomType: "MANUFACTURE", buffCategory: "OUTPUT", targets: ["F_GOLD", "F_EXP", "F_DIAMOND"], description: "每<@cc.vup>16</>个工程机器人生产力<@cc.vup>+4%</>" },
        "manu_constrLv[000]": { buffId: "manu_constrLv[000]", roomType: "MANUFACTURE", buffCategory: "OUTPUT", targets: [], description: "基建内每间设施每级<@cc.vup>+1</>个工程机器人" },
        // 控制中枢：efficiency=0 → 描述 vup（带 %）取百分比；同种效果取最高
        "control_prod_spd[000]": { buffId: "control_prod_spd[000]", buffName: "最高权限", roomType: "CONTROL", buffCategory: "FUNCTION", efficiency: 0, targets: [], description: "进驻控制中枢时，所有制造站生产力<@cc.vup>+2%</>（同种效果取最高）" },
        "control_prod_spd[1000]": { buffId: "control_prod_spd[1000]", buffName: "最高权限", roomType: "CONTROL", buffCategory: "FUNCTION", efficiency: 0, targets: [], description: "进驻控制中枢时，所有制造站生产力<@cc.vup>+4%</>（同种效果取最高）" },
        "control_tra_spd[000]": { buffId: "control_tra_spd[000]", roomType: "CONTROL", buffCategory: "FUNCTION", efficiency: 0, targets: [], description: "进驻控制中枢时，所有贸易站订单效率<@cc.vup>+7%</>（同种效果取最高）" },
        "control_dorm_rec[000]": { buffId: "control_dorm_rec[000]", roomType: "CONTROL", buffCategory: "FUNCTION", efficiency: 0, targets: [], description: "进驻控制中枢时，所有宿舍内干员心情每小时恢复<@cc.vup>+0.05</>（同种效果取最高）" },
        // 宿舍：无 efficiency → 描述 vup 原值（点/小时）
        "dorm_rec_all[010]": { buffId: "dorm_rec_all[010]", buffName: "鼓舞", roomType: "DORMITORY", buffCategory: "RECOVERY", efficiency: 0, targets: [], description: "进驻宿舍时，该宿舍内所有干员的心情每小时恢复<@cc.vup>+0.15</>（同种效果取最高）" },
        // 训练：efficiency 字段
        "train_spd_doubleProf[100]": { buffId: "train_spd_doubleProf[100]", roomType: "TRAINING", buffCategory: "FUNCTION", efficiency: 50, targets: [], description: "进驻训练室时，专精技能训练速度<@cc.vup>+50%</>" },
        "train_spd_doubleProf[110]": { buffId: "train_spd_doubleProf[110]", roomType: "TRAINING", buffCategory: "FUNCTION", efficiency: 60, targets: [], description: "进驻训练室时，专精技能训练速度<@cc.vup>+60%</>" },
        // 发电站心情消耗减免（vup 负值，消耗语境）
        "power_rec_spd&cost[000]": { buffId: "power_rec_spd&cost[000]", roomType: "POWER", buffCategory: "OUTPUT", efficiency: 0, targets: [], description: "进驻发电站时，心情每小时消耗<@cc.vup>-0.52</>" },
      } satisfies Record<string, BuffRowMock>,
      chars: {
        "char_001": { charId: "char_001", maxManpower: 8640000, buffChar: [{ buffData: [{ buffId: "manu_prod_spd[000]", cond: { level: 1 } }] }] },
        "char_002": {
          charId: "char_002", maxManpower: 8640000,
          buffChar: [{ buffData: [{ buffId: "manu_formula_spd[100]", cond: { level: 1 } }] }],
        },
        // 槽位多档技能：PHASE_2 解锁更高档
        "char_003": {
          charId: "char_003", maxManpower: 8640000,
          buffChar: [{ buffData: [
            { buffId: "manu_formula_spd&cost[001]", cond: { level: 1 } },
          ] }],
        },
        "char_bd": { charId: "char_bd", maxManpower: 8640000, buffChar: [{ buffData: [{ buffId: "manu_prod_spd_bd[100]", cond: { level: 1 } }] }, { buffData: [{ buffId: "manu_constrLv[000]", cond: { level: 1 } }] }] },
        "char_ctrl": { charId: "char_ctrl", maxManpower: 8640000, buffChar: [{ buffData: [{ buffId: "control_prod_spd[000]", cond: { level: 1 } }] }, { buffData: [{ buffId: "control_dorm_rec[000]", cond: { level: 1 } }] }] },
        "char_ctrl2": { charId: "char_ctrl2", maxManpower: 8640000, buffChar: [{ buffData: [{ buffId: "control_prod_spd[1000]", cond: { level: 1 } }] }] },
        "char_dorm": { charId: "char_dorm", maxManpower: 8640000, buffChar: [{ buffData: [{ buffId: "dorm_rec_all[010]", cond: { level: 1 } }] }] },
        "char_train": {
          charId: "char_train", maxManpower: 8640000,
          buffChar: [{ buffData: [
            { buffId: "train_spd_doubleProf[100]", cond: { level: 1 } },
            { buffId: "train_spd_doubleProf[110]", cond: { phase: "PHASE_2", level: 1 } },
          ] }],
        },
        "char_power": { charId: "char_power", maxManpower: 8640000, buffChar: [{ buffData: [{ buffId: "power_rec_spd&cost[000]", cond: { level: 1 } }] }] },
      },
      manufactData: { basicSpeedBuff: 0.01, phases: [{ speed: 1, outputCapacity: 24 }, { speed: 1, outputCapacity: 36 }, { speed: 1, outputCapacity: 54 }] },
      dormData: { phases: [{ manpowerRecover: 160 }, { manpowerRecover: 170 }, { manpowerRecover: 180 }, { manpowerRecover: 190 }, { manpowerRecover: 200 }] },
      manufactFormulas: {
        "4": { formulaId: "4", itemId: "3003", count: 1, costPoint: 4320, formulaType: "F_GOLD", costs: [] },
        "5": { formulaId: "5", itemId: "3213", count: 1, costPoint: 100, formulaType: "F_ASC", costs: [] },
      },
      rooms: {
        MANUFACTURE: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }, { buildCost: { items: [], time: 0, labor: 20 }, maxStationedNum: 2 }] },
        TRADING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
      },
      goldItems: { "3003": 500 },
      laborRecoverTime: 360,
    },
  },
}));
vi.mock("@excel/excel", () => excelMock);

// 可控时间
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
  type MockSeed,
  type MockUpdateRecipe,
} from "../../helpers";
import {
  phaseRank,
  parseVupValue,
  parseMoodCostValue,
  buffValue,
  buffGroupKey,
  getActiveCharBuffs,
  roomSpeedBonus,
  controlGlobalBonus,
  dormRecoveryBonus,
  charMoodCost,
} from "@game/modules/building/buff";
import type { BuildingBuffLike } from "@game/modules/building/buff-parse";
import type { RoomTimestamp } from "@game/modules/building/logic/ext-types";
import type {
  PlayerBuilding,
  PlayerBuildingChar,
  PlayerBuildingDormitory,
  PlayerBuildingMeeting,
  PlayerBuildingRoomSlot,
  PlayerBuildingTraining,
  PlayerCharacter,
} from "@game/kernel/playerdata";
import type { Excel } from "@excel/excel";
import { BuildingManager } from "@game/modules/building/logic";

/** 房间槽位夹具视图（服务端存档扩展字段如 `state` 以可选形式并入） */
type RoomSlotRecord<T> = Record<string, MockSeed<T> & RoomTimestamp>;

/**
 * 基建夹具视图
 *
 * 房间/槽位/干员字典提为必填以便增量写入；宿舍槽位另允许服务端扩展 `presetQueue`
 * （生成模型 `PlayerBuildingDormitory` 未声明该字段）。
 */
type BuildingFixture = MockSeed<Omit<PlayerBuilding, "rooms" | "roomSlots" | "chars">> & {
  roomSlots: RoomSlotRecord<PlayerBuildingRoomSlot>;
  chars: RoomSlotRecord<PlayerBuildingChar>;
  rooms: Omit<{
    [K in keyof PlayerBuilding["rooms"]]: RoomSlotRecord<PlayerBuilding["rooms"][K][string]>;
  }, "DORMITORY"> & {
    DORMITORY: Record<string, MockSeed<PlayerBuildingDormitory> & RoomTimestamp & { presetQueue?: number[][] }>;
  };
};

/** 便捷构造干员 buff 源 */
const src = (charId: string, level = 1, evolvePhase = 0) => ({ charId, level, evolvePhase });

describe("基建 buff 引擎（@game/modules/building/buff）", () => {
  it("phaseRank 解析 PHASE_N", () => {
    expect(phaseRank("PHASE_2")).toBe(2);
    expect(phaseRank("PHASE_0")).toBe(0);
    expect(phaseRank(undefined)).toBe(0);
    expect(phaseRank(2)).toBe(2);
  });

  it("parseVupValue / parseMoodCostValue 提取富文本数值", () => {
    expect(parseVupValue("生产力<@cc.vup>+30%</>")).toBe(30);
    expect(parseVupValue("恢复<@cc.vup>+0.15</>")).toBe(0.15);
    expect(parseVupValue("无标签")).toBeNull();
    expect(parseMoodCostValue("生产力<@cc.vup>+25%</>，心情每小时消耗<@cc.vdown>+0.25</>")).toBe(0.25);
    expect(parseMoodCostValue("订单效率<@cc.vup>+30%</>，心情每小时消耗<@cc.vup>-0.25</>")).toBe(-0.25);
    expect(parseMoodCostValue("无消耗语境")).toBeNull();
  });

  it("buffValue：efficiency>0 用 efficiency/100", () => {
    expect(buffValue(excelMock.default.BuildingData.buffs["manu_prod_spd[000]"])).toBeCloseTo(0.15);
    expect(buffValue(excelMock.default.BuildingData.buffs["manu_formula_spd[100]"])).toBeCloseTo(0.3);
  });

  it("buffValue：无 efficiency 时按描述 vup（带 % /100；宿舍原值；计数类 0）", () => {
    const b = excelMock.default.BuildingData.buffs;
    expect(buffValue(b["manu_prod_spd_bd[100]"])).toBeCloseTo(0.04); // 带 % → 4%
    expect(buffValue(b["dorm_rec_all[010]"])).toBeCloseTo(0.15); // 宿舍无 % → 原值
    expect(buffValue(b["manu_constrLv[000]"])).toBe(0); // 计数无 % → 不贡献
    expect(buffValue(b["control_prod_spd[000]"])).toBeCloseTo(0.02); // 控制带 %
  });

  it("buffGroupKey 去掉 [] 后缀分组", () => {
    expect(buffGroupKey("control_prod_spd[000]")).toBe("control_prod_spd");
    expect(buffGroupKey("control_prod_spd[1000]")).toBe("control_prod_spd");
    expect(buffGroupKey("dorm_rec_all[010]")).toBe("dorm_rec_all");
  });

  it("getActiveCharBuffs：level/phase 条件 + roomType 匹配", () => {
    // char_003 的 manu_formula_spd&cost[001] 无 phase 条件 → 精英 0 也激活
    expect(getActiveCharBuffs(src("char_003", 1, 0), "MANUFACTURE").length).toBe(1);
    // char_train 的 [110] 需要 PHASE_2：精英 1 只激活 [100]
    const b1 = getActiveCharBuffs(src("char_train", 1, 1), "TRAINING");
    expect(b1.length).toBe(1);
    expect(b1[0].buffId).toBe("train_spd_doubleProf[100]");
    // 精英 2 → 两档都激活（roomSpeedBonus 内同组取最高）
    expect(getActiveCharBuffs(src("char_train", 1, 2), "TRAINING").length).toBe(2);
    // roomType 不匹配不激活
    expect(getActiveCharBuffs(src("char_001", 1, 0), "TRADING").length).toBe(0);
  });

  it("roomSpeedBonus：跨干员累加 + targets 过滤 + 同组取最高", () => {
    // char_001（+15% 通用）+ char_002（+30% 仅 F_GOLD）→ 制造 F_GOLD 配方
    expect(roomSpeedBonus([src("char_001"), src("char_002")], "MANUFACTURE", ["F_GOLD"])).toBeCloseTo(0.45);
    // F_ASC 配方：通用 buff targets 不含 F_ASC → 不贡献
    expect(roomSpeedBonus([src("char_001"), src("char_002")], "MANUFACTURE", ["F_ASC"])).toBeCloseTo(0);
    // char_bd：manu_prod_spd_bd（+4% 带%）+ manu_constrLv（计数 0）
    expect(roomSpeedBonus([src("char_bd")], "MANUFACTURE", ["F_GOLD"])).toBeCloseTo(0.04);
    // 同技能多档（train [100]=50% + [110]=60%）→ 取最高 60%
    expect(roomSpeedBonus([src("char_train", 1, 2)], "TRAINING", [])).toBeCloseTo(0.6);
  });

  it("controlGlobalBonus：前缀映射 + 同种效果取最高", () => {
    const bonus = controlGlobalBonus([src("char_ctrl"), src("char_ctrl2")]);
    // control_prod_spd[000](+2%) 与 [1000](+4%) 同组 → 取最高 4%
    expect(bonus.MANUFACTURE).toBeCloseTo(0.04);
    expect(bonus.DORMITORY).toBeCloseTo(0.05);
    expect(bonus.TRADING).toBeUndefined();
  });

  it("dormRecoveryBonus：宿舍 buff 同组取最高", () => {
    expect(dormRecoveryBonus([src("char_dorm")])).toBeCloseTo(0.15);
    expect(dormRecoveryBonus([src("char_dorm"), src("char_dorm")])).toBeCloseTo(0.15);
  });

  it("charMoodCost：消耗语境 vdown/vup 值 ×100（vdown +0.25→+25 消耗、vup -0.25/-0.52→减免）", () => {
    expect(charMoodCost(src("char_003", 1, 2), "MANUFACTURE")).toBe(25);
    expect(charMoodCost(src("char_power", 1, 0), "POWER")).toBe(-52);
    expect(charMoodCost(src("char_001", 1, 0), "MANUFACTURE")).toBe(0);
  });
});

describe("BuildingManager 干员技能（buff）集成", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    timeMock.now = 1234567890;
    // _accrueCharAp 用 Date.now()（毫秒级 elapsed）→ 与 timeMock.now（秒）对齐
    vi.spyOn(Date, "now").mockReturnValue(timeMock.now * 1000);

    const building: BuildingFixture = {
        status: {
          labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 0, maxValue: 100 },
          workshop: { bonusActive: 0, bonus: {} },
        },
        chars: {
          "101": { charId: "char_001", lastApAddTime: timeMock.now - 3600, ap: 8640000, roomSlotId: "", index: -1, changeScale: 0, bubble: {}, workTime: 0, privateRooms: [] },
          "102": { charId: "char_003", lastApAddTime: timeMock.now - 3600, ap: 8640000, roomSlotId: "", index: -1, changeScale: 0, bubble: {}, workTime: 0, privateRooms: [] },
          "201": { charId: "char_dorm", lastApAddTime: timeMock.now - 3600, ap: 0, roomSlotId: "", index: -1, changeScale: 0, bubble: {}, workTime: 0, privateRooms: [] },
          "301": { charId: "char_ctrl", lastApAddTime: timeMock.now - 3600, ap: 8640000, roomSlotId: "", index: -1, changeScale: 0, bubble: {}, workTime: 0, privateRooms: [] },
        },
        roomSlots: {
          slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [101, 102], completeConstructTime: 0 },
          slot_34: { level: 5, state: 2, roomId: "CONTROL", charInstIds: [301], completeConstructTime: 0 },
          slot_28: { level: 5, state: 2, roomId: "DORMITORY", charInstIds: [201], completeConstructTime: 0 },
        },
        rooms: {
          CONTROL: {},
          ELEVATOR: {},
          POWER: {},
          MANUFACTURE: {
            slot_5: {
              state: 1,
              formulaId: "4",
              remainSolutionCnt: 73,
              outputSolutionCnt: 0,
              lastUpdateTime: timeMock.now - 3600,
              completeWorkTime: -1,
              capacity: 0,
            },
          },
          TRADING: {},
          CORRIDOR: {},
          WORKSHOP: {},
          DORMITORY: { slot_28: { comfort: 5000, buff: {}, presetQueue: [] } },
          MEETING: {},
          HIRE: {},
          TRAINING: {},
          PRIVATE: {},
        },
        furniture: {},
        diyPresetSolutions: {},
        assist: [-1, -1, -1],
        solution: { furnitureTs: {} },
        music: { selected: "bgm_default" },
    };
    mockPlayer = mockPlayerData({
      building,
      troop: {
        chars: {
          "101": { charId: "char_001", level: 1, evolvePhase: 0 },
          "102": { charId: "char_003", level: 1, evolvePhase: 2 },
          "201": { charId: "char_dorm", level: 1, evolvePhase: 0 },
          "301": { charId: "char_ctrl", level: 1, evolvePhase: 0 },
        },
      },
      inventory: {},
      event: { building: 0 },
    });

    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn<(recipe: MockUpdateRecipe) => Promise<void>>()
      .mockImplementation(async (recipe) => {
        const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
        const result = await recipe(draft);
        Object.assign(mockPlayer._playerdata, draft);
        return result;
      });
  });

  it("sync：制造站容量 = 基础 × (1 + 干员技能 + 控制中枢全局)，产出随时间累积", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    // 官方约定：room.capacity 为基础（3 级 54），buff.speed = 加成系数
    // 0.15[char_001] + 0.25[char_003 F_GOLD] + 0.02[控制中枢] + 0.02[2 名在岗干员 × 1%
    // （manufactData.basicSpeedBuff，Round 21/B2 修复后计入）
    expect(room.capacity).toBe(54);
    expect(room.buff.speed).toBeCloseTo(0.44);
    // 1 点/秒速率（2026-08-26 dc-fix）→ 1 小时 × 1.44 = 5184 processPoint → 1 批（costPoint 4320）
    expect(room.outputSolutionCnt).toBe(1);
    expect(room.remainSolutionCnt).toBe(73 - 1);
    expect(room.processPoint).toBe(5184 - 4320);
  });

  it("sync：工作干员心情档位 = 基础消耗 - 技能附加（vdown），换班后立即重算", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    const chars = mockPlayer._playerdata.building!.chars;
    // char_001 无技能附加：基础 -55 + 2 人头数减免 0.05 点/时（+5）→ -50（官方头数减免，2026-08-25）
    expect(chars["101"].changeScale).toBe(-50);
    // char_003 带 manu_formula_spd&cost vdown=+0.25（PHASE_2 激活，×100）→ -55-25+5 = -75
    expect(chars["102"].changeScale).toBe(-75);
    // 控制中枢干员不消耗
    expect(chars["301"].changeScale).toBe(0);
    // 修复：sync 现在也推进心情累积（官方行为——每次 sync 下发 chars 增量，
    // delta 恒非空，否则客户端空响应重试紧循环）；工作干员按 changeScale 消耗
    expect(chars["101"].ap).toBe(8640000 - 50 * 3600);
  });

  it("sync：宿舍恢复 = (基础 + 舒适度 + 宿舍 buff + 控制中枢 dorm 全局) × 100", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    const ch = mockPlayer._playerdata.building!.chars["201"];
    // (200/160 基础 + 5000/1000×0.55 舒适 + 0.15 dorm_rec + 0.05 control_dorm_rec) × 100
    expect(ch.changeScale).toBe(Math.round((1.25 + 2.75 + 0.15 + 0.05) * 100));
    // 修复：sync 推进心情累积（同官方）——宿舍干员按恢复档位累积
    expect(ch.ap).toBe(Math.round((1.25 + 2.75 + 0.15 + 0.05) * 100) * 3600);
  });

  it("batchRestChar 后心情档位立即恢复空闲（0）", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchRestChar({ charInstIdList: [101, 102] });
    const chars = mockPlayer._playerdata.building!.chars;
    expect(chars["101"].changeScale).toBe(0);
    expect(chars["102"].changeScale).toBe(0);
  });

  it("训练室：教官 train_* buff 加速 trainee 进度", async () => {
    mockPlayer._playerdata.building!.rooms.TRAINING["slot_13"] = asModel<PlayerBuildingTraining>({
      state: 1,
      trainer: { charInstId: 401, state: 3 },
      trainee: { charInstId: 402, state: 1, processPoint: 0, speed: 1000, targetSkill: 0 }, // TRAINING=1（官方枚举）
      lastUpdateTime: timeMock.now - 3600,
      completeWorkTime: -1,
    });
    mockPlayer._playerdata.building!.roomSlots["slot_13"] = {
      level: 3, state: 2, roomId: "TRAINING", charInstIds: [401, 402], completeConstructTime: 0,
    };
    mockPlayer._playerdata.troop!.chars["401"] = asModel<PlayerCharacter>({ charId: "char_train", level: 1, evolvePhase: 2 });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    const trainee = mockPlayer._playerdata.building!.rooms.TRAINING["slot_13"].trainee;
    // 1000 × (1 + 0.65) × 3600（教官 0.5 + 协助位 0.05 + 训练室等级 0.1）
    expect(trainee.processPoint).toBe(1000 * 1.65 * 3600);
  });

  it("制造 F_ASC 配方：普通生产力 buff 不生效（targets 过滤），控制中枢全局仍生效", async () => {
    mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5.formulaId = "5";
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    // 进驻干员 buff targets 均不含 F_ASC → 不贡献；控制中枢 control_prod_spd 无 targets → 全局生效
    // 另计 2 名在岗干员的基础效率 2%（manufactData.basicSpeedBuff）
    expect(room.capacity).toBe(54);
    expect(room.buff.speed).toBeCloseTo(0.04);
  });

  it("sync：计划耗尽（remain=0）后不再产出——修复制造站赤金无上限累积", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    room.remainSolutionCnt = 0;
    room.outputSolutionCnt = 50;
    room.processPoint = 100;
    room.lastUpdateTime = timeMock.now - 7200; // 距上次同步 2 小时
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    // remain=0 → 停止生产：产出与进度都不再累积（原实现跳过钳制 → 每 50s +1 无上限）
    expect(room.outputSolutionCnt).toBe(50);
    expect(room.remainSolutionCnt).toBe(0);
    expect(room.processPoint).toBe(100);
  });

  it("settleManufacture：计划完成的房间结算后停止（state=0、清空配方）", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    room.remainSolutionCnt = 0;
    room.outputSolutionCnt = 99;
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"] });
    expect(mockPlayer._playerdata.inventory!["3003"]).toBe(99);
    // update 替换 building 对象 → 重新读取结算后的房间
    const settled = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    expect(settled.state).toBe(0);
    expect(settled.formulaId).toBe("");
  });

  it("settleManufacture：免费配方带 supplement 计划耗尽后自动补货（继续保持生产）", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    room.remainSolutionCnt = 0; // 免费生产（F_GOLD，costs 为空）计划已耗尽
    room.outputSolutionCnt = 99;
    room.formulaId = "4";
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"], supplement: 1 });
    expect(mockPlayer._playerdata.inventory!["3003"]).toBe(99);
    const restocked = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    // 自动补货：配方保留、计划回填为刚收获量、继续生产而不停止
    expect(restocked.state).toBe(1);
    expect(restocked.formulaId).toBe("4");
    expect(restocked.remainSolutionCnt).toBe(99);
    expect(restocked.outputSolutionCnt).toBe(0);
    expect(restocked.processPoint).toBe(0);
  });

  it("settleManufacture：无材料成本以外的配方带 supplement 不自动补货（停止清空）", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    room.remainSolutionCnt = 0;
    room.outputSolutionCnt = 99;
    room.formulaId = "999"; // 配方不存在 → 不视为免费生产 → 不自动补货
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"], supplement: 1 });
    const stopped = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    expect(stopped.state).toBe(0);
    expect(stopped.formulaId).toBe("");
  });

  it("getMeetingroomReward：发放 socialPoint 并清零 socialReward（一次性，修复无限信用点）", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING["meeting_001"] = asModel<PlayerBuildingMeeting>({
      socialReward: { daily: 10, search: 30 },
      infoShare: { ts: 0, reward: 0 },
      ownStock: [], receiveStock: [], board: {},
      lastUpdateTime: 0,
    });
    mockPlayer._playerdata.status = { ...mockPlayer._playerdata.status, socialPoint: 100 };
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const res = await manager.getMeetingroomReward();
    // 官方格式：SOCIAL_PT ItemBundle；领取后 socialReward 归零 → 再次领取为空
    expect(res.rewards).toEqual([{ id: "SOCIAL_PT", type: "SOCIAL_PT", count: 40 }]);
    expect(mockPlayer._playerdata.status.socialPoint).toBe(140);
    const room2 = mockPlayer._playerdata.building!.rooms.MEETING.meeting_001;
    expect(room2.socialReward).toEqual({ daily: 0, search: 0 });
    const res2 = await manager.getMeetingroomReward();
    expect(res2.rewards).toEqual([]);
  });

  it("startInfoShare：记录会话开始时间 infoShare.ts（访客不再重复计信用）", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING["meeting_001"] = asModel<PlayerBuildingMeeting>({
      socialReward: { daily: 0, search: 0 },
      infoShare: { ts: 123, reward: 0 },
      ownStock: [], receiveStock: [], board: {},
      lastUpdateTime: 0,
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.startInfoShare({});
    const room2 = mockPlayer._playerdata.building!.rooms.MEETING.meeting_001;
    expect(room2.infoShare.ts).toBe(timeMock.now);
    expect(room2.infoShare.reward).toBe(0);
  });

  it("getInfoShareReward：按 changeScale 推进会客室干员体力（会话增量，避免空 delta 死循环）", async () => {
    // accountManager 返回空好友 → list 为空；chars 体力按档位随时间累积
    const { accountManager } = await import("@game/modules/account/account-manager");
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({ friends: [], friendRequests: [], visited: [] });
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockResolvedValue(
      asModel<Awaited<ReturnType<typeof accountManager.getPlayerFriendInfo>>>({}),
    );
    const chars = mockPlayer._playerdata.building!.chars;
    chars["201"].changeScale = 100; // 会客室恢复档位
    chars["201"].lastApAddTime = timeMock.now - 100;
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    const res = await manager.getInfoShareReward();
    expect(res.list).toEqual([]);
    // update 替换 building 对象 → 重新读取
    const ch = mockPlayer._playerdata.building!.chars["201"];
    expect(ch.ap).toBe(100 * 100);
    expect(ch.lastApAddTime).toBe(timeMock.now);
  });

  it("getInfoShareReward：同步推进 infoShare 字段（会话 ts 更新 + reward 待领取指示）", async () => {
    const { accountManager } = await import("@game/modules/account/account-manager");
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({ friends: [], friendRequests: [], visited: [] });
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockResolvedValue(
      asModel<Awaited<ReturnType<typeof accountManager.getPlayerFriendInfo>>>({}),
    );
    mockPlayer._playerdata.building!.rooms.MEETING["meeting_001"] = asModel<PlayerBuildingMeeting>({
      infoShare: { ts: 100, reward: 0 },
      socialReward: { daily: 0, search: 40 }, // 有未领取信用 → reward 指示 1
      ownStock: [], receiveStock: [], board: {},
      lastUpdateTime: 0,
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.getInfoShareReward();
    const room = mockPlayer._playerdata.building!.rooms.MEETING.meeting_001;
    expect(room.infoShare.ts).toBe(timeMock.now);
    expect(room.infoShare.reward).toBe(1); // 有待领取信用
    // 领取后归 0
    await manager.getMeetingroomReward();
    expect(mockPlayer._playerdata.building!.rooms.MEETING.meeting_001.infoShare.reward).toBe(0);
  });

  it("sync：刷新 infoShare.reward 待领取指示（有未领取信用 → 1）", async () => {
    mockPlayer._playerdata.building!.rooms.MEETING["meeting_001"] = asModel<PlayerBuildingMeeting>({
      infoShare: { ts: 100, reward: 0 },
      socialReward: { daily: 0, search: 40 },
      ownStock: [], receiveStock: [], board: {},
      lastUpdateTime: 0,
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    const room = mockPlayer._playerdata.building!.rooms.MEETING.meeting_001;
    expect(room.infoShare.reward).toBe(1);
  });

  it("一键补货：收获耗尽计划后 changeManufactureSolution 重启同配方（返回 change:false 对齐官方）", async () => {
    const room = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    room.state = 1;
    room.formulaId = "4";
    room.remainSolutionCnt = 0; // 计划已耗尽
    room.outputSolutionCnt = 99;
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 收获
    await manager.settleManufacture({ roomSlotIdList: ["slot_5"] });
    const afterHarvest = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    expect(afterHarvest.state).toBe(0);
    expect(afterHarvest.formulaId).toBe("");
    // 一键补货：同配方 + 补满数量
    const res = await manager.changeManufactureSolution({
      roomSlotId: "slot_5",
      targetFormulaId: "4",
      solutionCount: 99,
    });
    expect(res).toEqual({ change: false });
    const restocked = mockPlayer._playerdata.building!.rooms.MANUFACTURE.slot_5;
    expect(restocked.state).toBe(1);
    expect(restocked.formulaId).toBe("4");
    expect(restocked.remainSolutionCnt).toBe(99);
    expect(restocked.outputSolutionCnt).toBe(0);
    expect(restocked.processPoint).toBe(0);
    expect(restocked.lastUpdateTime).toBe(timeMock.now);
  });

  it("batchChangeWorkChar：兼容字段名变体（slotId/charInstIds）并立即生效；空请求体不改分配", async () => {
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // 字段名变体（客户端可能的批量换班请求形状）
    await manager.batchChangeWorkChar({ slotId: "slot_5", charInstIds: [11, 12] });
    const slot = mockPlayer._playerdata.building!.roomSlots.slot_5;
    expect(slot.charInstIds).toEqual([11, 12]);
    // 空请求体（官方无字段）→ 不改分配
    await manager.batchChangeWorkChar({});
    expect(slot.charInstIds).toEqual([11, 12]);
  });

  it("batchRestChar：兼容 charInstIds/list 字段名变体", async () => {
    mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds = [11, 12, 13];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.batchRestChar({ charInstIds: [12, 13] });
    const slot = mockPlayer._playerdata.building!.roomSlots.slot_5;
    expect(slot.charInstIds).toEqual([11, -1, -1]);
  });

  it("cleanRoomSlot：清空房间全部干员（置为 -1）", async () => {
    mockPlayer._playerdata.building!.roomSlots.slot_5.charInstIds = [11, 12, 13];
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.cleanRoomSlot({ roomSlotId: "slot_5" });
    const slot = mockPlayer._playerdata.building!.roomSlots.slot_5;
    expect(slot.charInstIds).toEqual([-1, -1, -1]);
  });
});
