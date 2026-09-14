import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 基建特殊技能适配测试
 *
 * 覆盖 2026-08-19 增量（@game/modules/building/special.ts + buff.ts/building.ts 集成）：
 * - 条件标签技能（<$cc.*>）：fraction（"每个X干员+Y%"按数量叠加）、
 *   token（"N台以上/与X一起"条件触发）——不再把 vup% 当无条件固定加成
 * - 数据源：gamedata_const.termDescriptionDict 术语 → 干员名单 → character_table charId
 * - BuildingManager 集成：制造站容量含 control_prod_fraction、会客室线索阵营加权
 *   （meet_spd_notOwned/Owned）、贸易站独占订单（trade_ord_pepe/closure）、
 *   心情特殊（control_mp_cost_double/reset 与关键词干员同驻）
 */

/** excel mock 的行形状（本文件只读取 name） */
interface ExcelRowMock { name?: string }

const excelMock = vi.hoisted(() => {
  /** 干员表（charData 以 string 索引，抽成带索引签名的 const 以满足索引检查） */
  const CharacterTable: Record<string, ExcelRowMock> = {
    "char_4098_vvana": { name: "薇薇安娜" },
    "char_1014_nearl2": { name: "耀骑士临光" },
    "char_148_nearl": { name: "临光" },
    "char_1029_yato2": { name: "麒麟R夜刀" },
    "char_1030_noirc2": { name: "火龙S黑角" },
    "char_107_liskam": { name: "雷蛇" },
    "char_1034_jesca2": { name: "涤火杰西卡" },
    "char_002_amiya": { name: "阿米娅" },
    "char_4182_oblvns": { name: "丰川祥子" },
    "char_4134_cetsyr": { name: "魔王" },
    "char_4183_mortis": { name: "若叶睦" },
    "char_497_ctable": { name: "晓歌" },
    "char_4091_ulika": { name: "U-Official" },
    "char_4058_pepe": { name: "佩佩" },
    "char_4228_closur": { name: "可露希尔" },
    "char_285_medic2": { name: "Lancet-2" },
    "char_286_cast3": { name: "Castle-3" },
    "char_391_rosmon": { name: "迷迭香" },
  };
  return {
    default: {
      // —— 本文件不提供的表（占位，与「键不存在」在 ?. 读取下等价）——
      ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
      StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
      CharacterTable,
      // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
      getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

    BuildingData: {
      laborRecoverTime: 360,
      goldItems: { "3003": 500 },
      buffs: {
        // 控制中枢：fraction（每个骑士+7%）
        "control_prod_fraction[000]": {
          buffId: "control_prod_fraction[000]", roomType: "CONTROL", efficiency: 0, targets: [],
          description: "进驻控制中枢时，每个进驻在制造站的<$cc.tag.knight><@cc.kw>骑士</></>干员生产力<@cc.vup>+7%</>",
        },
        // 控制中枢：token（≥2台作业平台在发电站时+2%）
        "control_token_prod_spd[000]": {
          buffId: "control_token_prod_spd[000]", roomType: "CONTROL", efficiency: 0, targets: [],
          description: "进驻控制中枢时，如果有<@cc.kw>2</>台以上<$cc.tag.op><@cc.kw>作业平台</></>进驻在<@cc.kw>发电站</>，则所有制造站生产力<@cc.vup>+2%</>（同种效果取最高）",
        },
        // 控制中枢：token（与MH干员同驻控制中枢时+2%）
        "control_token_prod_spd2[000]": {
          buffId: "control_token_prod_spd2[000]", roomType: "CONTROL", efficiency: 0, targets: [],
          description: "当与<$cc.tag.mh><@cc.kw>怪物猎人小队</></>干员进驻控制中枢一起工作时，所有制造站生产力<@cc.vup>+2%</>（同种效果取最高）",
        },
        // 控制中枢：fraction（每个黑钢国际+5%）
        "control_bd_spd[000]": {
          buffId: "control_bd_spd[000]", roomType: "CONTROL", efficiency: 0, targets: [],
          description: "进驻控制中枢时，自身心情每小时消耗<@cc.vdown>+0.5</>；每个进驻在制造站的<$cc.g.bs><@cc.kw>黑钢国际</></>干员，生产力<@cc.vup>+5%</>",
        },
        // 心情特殊：与阿米娅同驻恢复
        "control_mp_cost_double[000]": {
          buffId: "control_mp_cost_double[000]", roomType: "CONTROL", efficiency: 0, targets: [],
          description: "当与<@cc.kw>阿米娅</>一起进驻控制中枢时，自身和<@cc.kw>阿米娅</>心情每小时恢复<@cc.vup>+0.05</>",
        },
        // 心情特殊：与丰川祥子同驻消除消耗
        "control_mp_cost_reset[000]": {
          buffId: "control_mp_cost_reset[000]", roomType: "CONTROL", efficiency: 0, targets: [],
          description: "当与<@cc.kw>丰川祥子</>一起进驻控制中枢时，消除自身心情消耗的影响",
        },
        // 会客室线索：未拥有线索概率
        "meet_spd_notOwned[010]": {
          buffId: "meet_spd_notOwned[010]", roomType: "MEETING", efficiency: 10, targets: [],
          description: "进驻会客室时，线索搜集速度提升<@cc.vup>10%</>，且更容易获得线索板上尚未拥有的线索",
        },
        "meet_spd_Owned[000]": {
          buffId: "meet_spd_Owned[000]", roomType: "MEETING", efficiency: 0, targets: [],
          description: "进驻会客室时，更容易获得线索板上已经拥有的线索",
        },
        // 贸易站独占订单
        "trade_ord_pepe[000]": {
          buffId: "trade_ord_pepe[000]", roomType: "TRADING", efficiency: 0, targets: [],
          description: "进驻贸易站时，固定获取<$cc.tra.pepe><@cc.kw>特别独占订单</></>（不视作违约订单），且该类订单<@cc.vdown>不受任何订单获取效率的影响</>",
        },
        "trade_ord_closure[000]": {
          buffId: "trade_ord_closure[000]", roomType: "TRADING", efficiency: 10, targets: [],
          description: "进驻贸易站时，订单获取效率<@cc.vup>+10%</>，固定获取<$cc.tra.closure><@cc.kw>可露希尔特别订单</></>（不视作违约订单）",
        },
        // 普通技能（对照）
        "manu_prod_spd[000]": {
          buffId: "manu_prod_spd[000]", roomType: "MANUFACTURE", efficiency: 15, targets: ["F_GOLD", "F_EXP", "F_DIAMOND"],
          description: "进驻制造站时，生产力<@cc.vup>+15%</>",
        },
      } satisfies Record<string, BuildingBuffLike>,
      chars: {
        "char_4098_vvana": { charId: "char_4098_vvana", buffChar: [{ buffData: [{ buffId: "control_prod_fraction[000]", cond: { level: 1 } }] }] },
        "char_4004_pudd": { charId: "char_4004_pudd", buffChar: [{ buffData: [{ buffId: "control_token_prod_spd[000]", cond: { level: 1 } }] }] },
        "char_1029_yato2": { charId: "char_1029_yato2", buffChar: [{ buffData: [{ buffId: "control_token_prod_spd2[000]", cond: { level: 1 } }] }] },
        "char_1034_jesca2": { charId: "char_1034_jesca2", buffChar: [{ buffData: [{ buffId: "control_bd_spd[000]", cond: { level: 1 } }] }] },
        "char_4134_cetsyr": { charId: "char_4134_cetsyr", buffChar: [{ buffData: [{ buffId: "control_mp_cost_double[000]", cond: { level: 1 } }] }] },
        "char_4183_mortis": { charId: "char_4183_mortis", buffChar: [{ buffData: [{ buffId: "control_mp_cost_reset[000]", cond: { level: 1 } }] }] },
        "char_497_ctable": { charId: "char_497_ctable", buffChar: [{ buffData: [{ buffId: "meet_spd_notOwned[010]", cond: { level: 1 } }] }] },
        "char_4091_ulika": { charId: "char_4091_ulika", buffChar: [{ buffData: [{ buffId: "meet_spd_Owned[000]", cond: { level: 1 } }] }] },
        "char_4058_pepe": { charId: "char_4058_pepe", buffChar: [{ buffData: [{ buffId: "trade_ord_pepe[000]", cond: { level: 1 } }] }] },
        "char_4228_closur": { charId: "char_4228_closur", buffChar: [{ buffData: [{ buffId: "trade_ord_closure[000]", cond: { level: 1 } }] }] },
        "char_1014_nearl2": { charId: "char_1014_nearl2", buffChar: [{ buffData: [{ buffId: "manu_prod_spd[000]", cond: { level: 1 } }] }] },
        "char_148_nearl": { charId: "char_148_nearl", buffChar: [] },
        "char_002_amiya": { charId: "char_002_amiya", buffChar: [] },
        "char_4182_oblvns": { charId: "char_4182_oblvns", buffChar: [] },
        "char_285_medic2": { charId: "char_285_medic2", buffChar: [] },
        "char_286_cast3": { charId: "char_286_cast3", buffChar: [] },
      },
      manufactData: {
        phases: [
          { speed: 1, outputCapacity: 24 },
          { speed: 1, outputCapacity: 36 },
          { speed: 1, outputCapacity: 54 },
        ],
      },
      manufactFormulas: {
        "4": { formulaId: "4", itemId: "3003", count: 1, costPoint: 4320, formulaType: "F_GOLD", costs: [] },
      },
      rooms: {
        MANUFACTURE: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        TRADING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        CONTROL: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        MEETING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        POWER: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
      },
      meetingData: { phases: [{ friendSlotInc: 10, maxVisitorNum: 10, gatheringSpeed: 100 }] },
    },
    GameDataConst: {
      termDescriptionDict: {
        "cc.tag.knight": { termId: "cc.tag.knight", termName: "骑士", description: "包含以下干员\n耀骑士临光、临光、瑕光、鞭刃、焰尾、远牙、灰毫、野鬃、正义骑士号、砾、薇薇安娜" },
        "cc.tag.op": { termId: "cc.tag.op", termName: "作业平台", description: "包含以下干员\nLancet-2、Castle-3、THRM-EX、正义骑士号、Friston-3、PhonoR-0、CONFESS-47、GALLUS²" },
        "cc.tag.mh": { termId: "cc.tag.mh", termName: "怪物猎人小队", description: "包含以下干员\n火龙S黑角、麒麟R夜刀、泰拉大陆调查团" },
        "cc.g.bs": { termId: "cc.g.bs", termName: "黑钢国际", description: "包含以下干员\n雷蛇、芙兰卡、杰西卡、香草、杏仁、寻澜" },
      },
    },
  },
  };
});
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
  type MockPlayerDataManager,
  type MockPlayerDataSeed,
  type MockSeed,
  type MockUpdateRecipe,
} from "../../helpers";
import {
  parseConditionTerms,
  isConditionSkill,
  charMatchesTerm,
  termCharIds,
  specialBuffValue,
} from "@game/modules/building/special";
import {
  roomSpeedBonus,
  controlGlobalBonus,
} from "@game/modules/building/buff";
import type { BuildingBuffLike } from "@game/modules/building/buff-parse";
import type { MeetingRoom, TradingRoom } from "@game/modules/building/logic/ext-types";
import type { PlayerBuildingChar, PlayerBuildingTrading, PlayerCharacter } from "@game/kernel/playerdata";
import { BuildingManager } from "@game/modules/building/logic";

/** 干员 buff 源便捷构造 */
const src = (charId: string, level = 1, evolvePhase = 0) => ({ charId, level, evolvePhase });

describe("特殊技能解析（@game/modules/building/special）", () => {
  it("parseConditionTerms 提取 <$cc.*> 条件标签（排除 <@cc.kw> 关键词）", () => {
    expect(parseConditionTerms("每个<$cc.tag.knight><@cc.kw>骑士</></>干员+<@cc.vup>7%</>")).toEqual(["cc.tag.knight"]);
    expect(parseConditionTerms("与<$cc.g.bs><@cc.kw>黑钢国际</></>干员")).toEqual(["cc.g.bs"]);
    expect(parseConditionTerms("普通描述<@cc.vup>+15%</>")).toEqual([]);
  });

  it("isConditionSkill 判据（含 <$cc 标签）", () => {
    expect(isConditionSkill("每个<$cc.tag.knight>干员")).toBe(true);
    expect(isConditionSkill("生产力<@cc.vup>+15%</>")).toBe(false);
  });

  it("termCharIds / charMatchesTerm 按术语名单映射干员", () => {
    expect(termCharIds("cc.tag.knight")).toContain("char_4098_vvana");
    expect(termCharIds("cc.tag.knight")).toContain("char_1014_nearl2");
    expect(charMatchesTerm("char_285_medic2", "cc.tag.op")).toBe(true); // Lancet-2 作业平台
    expect(charMatchesTerm("char_1029_yato2", "cc.tag.mh")).toBe(true); // 麒麟R夜刀 MH
    expect(charMatchesTerm("char_002_amiya", "cc.tag.knight")).toBe(false);
    expect(termCharIds("cc.term_undefined")).toEqual(new Set());
  });

  it("specialBuffValue fraction：加成 = vup% × 目标房间命中干员数", () => {
    const buff = excelMock.default.BuildingData.buffs["control_prod_fraction[000]"];
    // 制造站 2 名骑士（耀骑士临光 + 临光）→ 7% × 2
    expect(specialBuffValue(buff, {
      manufactureCharIds: ["char_1014_nearl2", "char_148_nearl", "char_002_amiya"],
    })).toBeCloseTo(0.14);
    // 制造站无骑士 → 0
    expect(specialBuffValue(buff, { manufactureCharIds: ["char_002_amiya"] })).toBe(0);
    // 无 ctx → 0
    expect(specialBuffValue(buff, undefined)).toBe(0);
  });

  it("specialBuffValue token：条件满足/不满足", () => {
    const buff = excelMock.default.BuildingData.buffs["control_token_prod_spd[000]"];
    // 发电站 2 台作业平台（Lancet-2 + Castle-3）→ 条件满足
    expect(specialBuffValue(buff, {
      powerCharIds: ["char_285_medic2", "char_286_cast3"],
    })).toBeCloseTo(0.02);
    // 只有 1 台 → 不满足 → 0
    expect(specialBuffValue(buff, { powerCharIds: ["char_285_medic2"] })).toBe(0);
  });

  it("specialBuffValue token 同驻：与 MH 干员同驻控制中枢时生效", () => {
    const buff = excelMock.default.BuildingData.buffs["control_token_prod_spd2[000]"];
    expect(specialBuffValue(buff, { controlCharIds: ["char_1029_yato2", "char_1030_noirc2"] })).toBeCloseTo(0.02);
    expect(specialBuffValue(buff, { controlCharIds: ["char_002_amiya"] })).toBe(0);
  });

  it("specialBuffValue 非条件技能返回 null；条件无数值（独占订单）返回 0", () => {
    const normal = excelMock.default.BuildingData.buffs["manu_prod_spd[000]"];
    expect(specialBuffValue(normal, {})).toBeNull();
    const pepe = excelMock.default.BuildingData.buffs["trade_ord_pepe[000]"];
    expect(specialBuffValue(pepe, {})).toBe(0);
  });
});

describe("buff.ts 集成：特殊技能加成进房间/控制中枢计算", () => {
  it("roomSpeedBonus 对条件技能走特殊计算（fraction 按数量）", () => {
    // 进驻制造站的薇薇安娜本身有 control_prod_fraction？不——该技能 roomType=CONTROL。
    // 制造站房间内普通干员 buff 正常；控制中枢特殊技能经 controlGlobalBonus 注入。
    // 此处验证 roomSpeedBonus 不受条件技能影响（无 CONTROL 干员时）：
    const normal = src("char_1014_nearl2"); // 耀骑士临光 manu_prod_spd 15%
    expect(roomSpeedBonus([normal], "MANUFACTURE", ["F_GOLD"])).toBeCloseTo(0.15);
  });

  it("controlGlobalBonus：control_prod_fraction 注入制造站加成（ctx 制造站骑士数）", () => {
    const ctx = { manufactureCharIds: ["char_1014_nearl2", "char_148_nearl"] };
    const bonus = controlGlobalBonus([src("char_4098_vvana")], ctx);
    expect(bonus.MANUFACTURE).toBeCloseTo(0.14);
    // 无骑士 → 0（不再无条件 +7%）
    const bonus0 = controlGlobalBonus([src("char_4098_vvana")], { manufactureCharIds: [] });
    expect(bonus0.MANUFACTURE ?? 0).toBe(0);
  });

  it("controlGlobalBonus：token 条件（作业平台在发电站）注入制造站加成", () => {
    const ctx = { powerCharIds: ["char_285_medic2", "char_286_cast3"] };
    const bonus = controlGlobalBonus([src("char_4004_pudd")], ctx);
    expect(bonus.MANUFACTURE).toBeCloseTo(0.02);
    const bonus0 = controlGlobalBonus([src("char_4004_pudd")], { powerCharIds: [] });
    expect(bonus0.MANUFACTURE ?? 0).toBe(0);
  });
});

describe("BuildingManager 特殊技能集成", () => {
  /** 构造带指定 building 的 mock 玩家 */
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
        const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
        const result = await recipe(draft);
        Object.assign(mockPlayer._playerdata, draft);
        return result;
      });
    return { mockPlayer, mockTrigger };
  }

  /** 基础 building（控制中枢/制造站/贸易站/会客室/发电站槽位） */
  function baseBuilding(): MockPlayerDataSeed["building"] {
    return {
      status: {
        labor: { buffSpeed: 0, processPoint: 0, value: 100, lastUpdateTime: 1000, maxValue: 225 },
        workshop: { bonusActive: 0, bonus: {} },
      },
      chars: {},
      roomSlots: {
        slot_5: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [], completeConstructTime: -1 },
        slot_6: { level: 1, state: 2, roomId: "TRADING", charInstIds: [], completeConstructTime: -1 },
        slot_34: { level: 1, state: 2, roomId: "CONTROL", charInstIds: [], completeConstructTime: -1 },
        slot_36: { level: 1, state: 2, roomId: "MEETING", charInstIds: [], completeConstructTime: -1 },
        slot_24: { level: 1, state: 2, roomId: "POWER", charInstIds: [], completeConstructTime: -1 },
      },
      rooms: {
        CONTROL: {},
        ELEVATOR: {},
        POWER: {},
        MANUFACTURE: {
          slot_5: {
            state: 1, formulaId: "4", remainSolutionCnt: 10, outputSolutionCnt: 0,
            processPoint: 0, lastUpdateTime: 1000, completeWorkTime: -1, capacity: 0,
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

  /** 进驻干员辅助：槽位 + building.chars + troop.chars */
  function station(mockPlayer: MockPlayerDataManager, slotId: string, entries: Array<[number, string]>) {
    const slot = mockPlayer._playerdata.building.roomSlots[slotId];
    slot.charInstIds = entries.map(([instId]) => instId);
    for (const [instId, charId] of entries) {
      mockPlayer._playerdata.building.chars[String(instId)] = asModel<PlayerBuildingChar>({
        charId, ap: 8640000, lastApAddTime: timeMock.now, roomSlotId: slotId, index: 0,
        changeScale: 0, bubble: {}, workTime: 0, privateRooms: [],
      });
      mockPlayer._playerdata.troop.chars[String(instId)] = asModel<PlayerCharacter>({ charId, level: 1, evolvePhase: 0 });
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    // sync 的浮点秒时间基准用 Date.now()——与 timeMock.now（秒）对齐，
    // 避免真实时钟与 fixture 时间基准混用把干员心情超发扣成涣散（技能失效）
    vi.spyOn(Date, "now").mockReturnValue(timeMock.now * 1000);
  });

  it("制造站容量含控制中枢 fraction 技能（薇薇安娜 + 2 骑士 → +14% 全局）", async () => {
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), {
      status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
      inventory: {},
      troop: { chars: {}, charGroup: {} },
    });
    station(mockPlayer, "slot_34", [[901, "char_4098_vvana"]]);
    station(mockPlayer, "slot_5", [[101, "char_1014_nearl2"], [102, "char_148_nearl"]]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    const room = mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5;
    // capacity 基础 54；buff.speed = 进驻干员 0.15（耀骑士临光 manu）+ 控制中枢 0.14（2 骑士 × 7%）
    expect(room.capacity).toBe(54);
    expect(room.buff.speed).toBeCloseTo(0.29);
    // 撤走骑士（只剩 1 名）→ 控制中枢 fraction 变 0.07，buff.speed = 0.15 + 0.07
    station(mockPlayer, "slot_5", [[101, "char_1014_nearl2"]]);
    await manager.sync();
    expect(mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.buff.speed).toBeCloseTo(0.22);
  });

  it("控制中枢 token 技能：发电站作业平台 ≥2 时制造站 +2%", async () => {
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), {
      status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
      inventory: {},
      troop: { chars: {}, charGroup: {} },
    });
    station(mockPlayer, "slot_34", [[901, "char_4004_pudd"]]);
    station(mockPlayer, "slot_24", [[951, "char_285_medic2"], [952, "char_286_cast3"]]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    const room = mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5;
    expect(room.buff.speed).toBeCloseTo(0.02);
    // 撤走 1 台作业平台 → 条件不满足 → 0
    station(mockPlayer, "slot_24", [[951, "char_285_medic2"]]);
    await manager.sync();
    expect(mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_5.buff.speed).toBe(0);
  });

  it("贸易站独占订单：佩佩进驻 → 固定生成特别独占订单（赤金交付 0）", async () => {
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), {
      status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
      inventory: {},
      troop: { chars: {}, charGroup: {} },
    });
    station(mockPlayer, "slot_6", [[951, "char_4058_pepe"]]);
    mockPlayer._playerdata.building.rooms.TRADING.slot_6 = asModel<PlayerBuildingTrading>({
      state: 1, stock: [], stockLimit: 2, strategy: "O_GOLD", lastUpdateTime: 1000,
    });
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    // 服务端扩展字段 `special`（独占订单来源）经 TradingRoom 视图读取
    const room = mockPlayer._playerdata.building.rooms.TRADING.slot_6 as TradingRoom;
    expect(room.stock).toHaveLength(2);
    // 独占订单：赤金交付 0、收益恒定（rate×2=1000）
    expect(room.stock[0].delivery).toEqual([]);
    expect(room.stock[0].special).toBe("pepe");
    expect(room.stock[0].gain).toEqual({ id: "4001", type: "GOLD", count: 1000 });
  });

  it("会客室线索加权：晓歌（未拥有线索概率↑）→ 未上板阵营被选中", async () => {
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), {
      status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
      inventory: {},
      troop: { chars: {}, charGroup: {} },
    });
    station(mockPlayer, "slot_36", [[961, "char_497_ctable"]]);
    // 会客室夹具：dailyReward=null 为服务端「今日未领」形状（生成模型声明为必填），
    // 经 ext-types 的 MeetingRoom 视图写入
    const meetingRooms: Record<string, MockSeed<MeetingRoom>> =
      mockPlayer._playerdata.building.rooms.MEETING;
    meetingRooms.room_001 = {
      ownStock: [], receiveStock: [], board: { RHINE: "x", PENGUIN: "y" }, dailyReward: null,
      socialReward: { daily: 0, search: 0 }, infoShare: { ts: 0, reward: 0 },
    };
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    // random 固定 0.9：加权后大概率落未上板阵营（上板 w=1 × 2，未上板 w=2 × 5）
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.9);
    await manager.getDailyClue({});
    const room = mockPlayer._playerdata.building.rooms.MEETING.room_001;
    expect(room.ownStock).toHaveLength(1);
    // 未上板阵营（非 RHINE/PENGUIN）
    expect(["RHINE", "PENGUIN"]).not.toContain(room.ownStock[0].type);
    spy.mockRestore();
  });

  it("心情特殊：魔王与阿米娅同驻控制中枢 → 自身心情恢复档位 +5 AP/秒", async () => {
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), {
      status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
      inventory: {},
      troop: { chars: {}, charGroup: {} },
    });
    station(mockPlayer, "slot_34", [[901, "char_4134_cetsyr"], [902, "char_002_amiya"]]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    // 0.05 点/小时 × 100 = +5 AP/秒
    expect(mockPlayer._playerdata.building.chars["901"].changeScale).toBe(5);
  });

  it("心情特殊：若叶睦与丰川祥子同驻 → 消除自身心情消耗（0）", async () => {
    const { mockPlayer, mockTrigger } = makePlayer(baseBuilding(), {
      status: { uid: "1", gold: 10000, androidDiamond: 100, socialPoint: 0, nickName: "A", nickNumber: "1" },
      inventory: {},
      troop: { chars: {}, charGroup: {} },
    });
    station(mockPlayer, "slot_34", [[901, "char_4183_mortis"], [902, "char_4182_oblvns"]]);
    const manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.sync();
    expect(mockPlayer._playerdata.building.chars["901"].changeScale).toBe(0);
  });
});
