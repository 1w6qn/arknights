import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 基建时间戳更新修复——基于存档 2222 真实结构冒烟验证（2026-08-19）
 *
 * 背景：2222 存档（8-18 备份）基建存在"时间未更新"问题——
 * - TRAINING trainee.state=1（TRAINING）但 _accrueTraining 旧实现 `state !== 3`
 *   （WAITING=3）→ 训练进度从不推进（空弦 processPoint 停摆 86379.75）
 * - MEETING/HIRE 的 processPoint（线索/人脉搜集进度）无任何时间推进逻辑
 * - CONTROL/MEETING/HIRE/TRADING lastUpdateTime 停在 8-13（6 天前）
 *
 * 修复：
 * - _accrueTraining 改为 trainee.state === 1（TRAINING，官方 PlayerBuildingTraineeState）
 * - 新增 _accrueMeeting/_accrueHire：processPoint += elapsed × 有效速度
 *   （gatheringSpeed/resSpeed × (1 + meet / hire buff)），回写 room.speed
 * - 新增 _touchActiveRooms：统一推进所有工作时间房间（state=1）及常驻房间
 *   （CONTROL 无 state 字段）的 lastUpdateTime ← ts
 */

/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string; rarity?: string }

// Excel BuildingData 精简样本（相位/配方/技能）
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
      laborRecoverTime: 360,
      goldItems: { "3003": 500 },
      buffs: {
        "meet_spd_notOwned[010]": {
          buffId: "meet_spd_notOwned[010]", roomType: "MEETING", efficiency: 10, targets: [],
          description: "进驻会客室时，线索搜集速度提升<@cc.vup>10%</>，且更容易获得线索板上尚未拥有的线索",
        },
        "meet_spd[010]": {
          buffId: "meet_spd[010]", roomType: "MEETING", efficiency: 20, targets: [],
          description: "进驻会客室时，线索搜集速度提升<@cc.vup>20%</>",
        },
        "hire_spd[020]": {
          buffId: "hire_spd[020]", roomType: "HIRE", efficiency: 20, targets: [],
          description: "进驻人力办公室时，人脉资源的联络速度提升<@cc.vup>20%</>",
        },
        "train_spd_doubleProf[100]": {
          buffId: "train_spd_doubleProf[100]", roomType: "TRAINING", efficiency: 50, targets: [],
          description: "进驻训练室时，专精技能训练速度<@cc.vup>+50%</>",
        },
        "manu_prod_spd[000]": {
          buffId: "manu_prod_spd[000]", roomType: "MANUFACTURE", efficiency: 15, targets: ["F_GOLD", "F_EXP", "F_DIAMOND"],
          description: "进驻制造站时，生产力<@cc.vup>+15%</>",
        },
        "trade_ord_spd[000]": {
          buffId: "trade_ord_spd[000]", roomType: "TRADING", efficiency: 20, targets: [],
          description: "进驻贸易站时，订单获取效率<@cc.vup>+20%</>",
        },
      },
      chars: {
        "char_497_ctable": { charId: "char_497_ctable", buffChar: [{ buffData: [{ buffId: "meet_spd_notOwned[010]", cond: { level: 1 } }] }] },
        "char_4087_ines": { charId: "char_4087_ines", buffChar: [{ buffData: [{ buffId: "meet_spd[010]", cond: { level: 1 } }] }] },
        "char_180_amgoat": { charId: "char_180_amgoat", buffChar: [{ buffData: [{ buffId: "hire_spd[020]", cond: { level: 1 } }] }] },
        "char_113_cqbw": { charId: "char_113_cqbw", buffChar: [{ buffData: [{ buffId: "train_spd_doubleProf[100]", cond: { level: 1 } }] }] },
        "char_332_archet": { charId: "char_332_archet", buffChar: [] },
      },
      manufactData: { phases: [{ speed: 1, outputCapacity: 24 }, { speed: 1, outputCapacity: 36 }, { speed: 1, outputCapacity: 54 }] },
      meetingData: { phases: [
        { friendSlotInc: 10, maxVisitorNum: 10, gatheringSpeed: 100 },
        { friendSlotInc: 20, maxVisitorNum: 10, gatheringSpeed: 100 },
        { friendSlotInc: 35, maxVisitorNum: 10, gatheringSpeed: 100 },
      ] },
      hireData: { phases: [
        { economizeRate: 0, resSpeed: 100, refreshTimes: 3 },
        { economizeRate: 0, resSpeed: 100, refreshTimes: 3 },
        { economizeRate: 0, resSpeed: 100, refreshTimes: 3 },
      ] },
      manufactFormulas: {
        "4": { formulaId: "4", itemId: "3003", count: 1, costPoint: 4320, formulaType: "F_GOLD", costs: [] },
      },
      rooms: {
        MANUFACTURE: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        TRADING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        CONTROL: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        MEETING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        HIRE: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
        TRAINING: { phases: [{ buildCost: { items: [], time: 0, labor: 10 }, maxStationedNum: 1 }] },
      },
    },
    CharacterTable: {
      char_497_ctable: { rarity: "TIER_5" },
      char_4087_ines: { rarity: "TIER_6" },
    } as Record<string, ExcelRowMock>,
  },
}));
vi.mock("@excel/excel", () => excelMock);

// 时间基准：2222 存档 lastUpdateTime 统一为 BASE（8-13），now = BASE + 1 天
const timeMock = vi.hoisted(() => ({ now: 1786589894 }));
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
  PlayerBuildingMeeting,
  PlayerBuildingWorkshop,
  PlayerDataModel,
} from "@game/kernel/playerdata";
import type { MeetingRoom, RoomTimestamp } from "@game/modules/building/logic/ext-types";
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

/**
 * 会客室槽位夹具视图
 *
 * 生成模型两处与 2222 存档实态不符：
 * - `dailyReward` 声明为必填线索对象，服务端以 `null` 表示「今日免费线索未领」
 *   （见 `logic/ext-types.ts` 偏差清单 1）；
 * - `mustgetClue`/`startApCounter` 声明为 `number`，真实存档分别是数组与计数字典
 *   （生产侧不读这两键，仅为夹具保真）。
 *
 * 故按 {@link MeetingRoom} 视图收窄后装入，再适配回种子视图（字段名/字段类型仍受
 * 真实模型约束，仅放宽必填、`dailyReward` 的 null 与上述两键的历史形状）。
 */
type MeetingSlotFixture = MockSeed<Omit<MeetingRoom, "mustgetClue" | "startApCounter">> & {
  mustgetClue?: number[];
  startApCounter?: Record<string, number>;
};

/**
 * 把会客室槽位夹具适配为种子视图。
 * @param seed - 会客室槽位的深可选夹具
 * @returns 同一对象，视作生成模型的会客室槽位种子
 */
function meetingSlot(seed: MeetingSlotFixture): MockSeed<PlayerBuildingMeeting> {
  return seed as MockSeed<PlayerBuildingMeeting>;
}

/** 基于 2222 真实结构构造 building（裁剪到相关房间） */
function archiveBuilding(): BuildingFixture {
  const BASE = 1786589894; // 2222 存档中 CONTROL/TRADING/MEETING/HIRE 的 lastUpdateTime
  return {
    status: {
      labor: { buffSpeed: 0, processPoint: 0, value: 225, lastUpdateTime: BASE, maxValue: 225 },
      workshop: { bonusActive: 0, bonus: {} },
    },
    chars: {
      // 2222 真实进驻干员
      "197": { charId: "char_497_ctable", ap: 8640000, lastApAddTime: BASE, roomSlotId: "slot_36", index: 0, changeScale: -65, bubble: {}, workTime: 0, privateRooms: [] },
      "253": { charId: "char_4087_ines", ap: 8640000, lastApAddTime: BASE, roomSlotId: "slot_36", index: 1, changeScale: -65, bubble: {}, workTime: 0, privateRooms: [] },
      "79": { charId: "char_180_amgoat", ap: 8640000, lastApAddTime: BASE, roomSlotId: "slot_23", index: 0, changeScale: -65, bubble: {}, workTime: 0, privateRooms: [] },
      "13": { charId: "char_113_cqbw", ap: 8640000, lastApAddTime: BASE, roomSlotId: "slot_13", index: 0, changeScale: 0, bubble: {}, workTime: 0, privateRooms: [] },
      "204": { charId: "char_332_archet", ap: 8640000, lastApAddTime: BASE, roomSlotId: "slot_13", index: 1, changeScale: 0, bubble: {}, workTime: 0, privateRooms: [] },
    },
    roomSlots: {
      slot_36: { level: 3, state: 2, roomId: "MEETING", charInstIds: [197, 253], completeConstructTime: 1608421806 },
      slot_23: { level: 3, state: 2, roomId: "HIRE", charInstIds: [79], completeConstructTime: 1613094383 },
      slot_13: { level: 3, state: 2, roomId: "TRAINING", charInstIds: [13, 204], completeConstructTime: 1603530552 },
      slot_34: { level: 5, state: 2, roomId: "CONTROL", charInstIds: [], completeConstructTime: 1604100983 },
      slot_25: { level: 3, state: 2, roomId: "MANUFACTURE", charInstIds: [], completeConstructTime: 1590905259 },
      slot_24: { level: 3, state: 2, roomId: "TRADING", charInstIds: [], completeConstructTime: 1593996946 },
    },
    rooms: {
      CONTROL: {
        slot_34: { buff: {}, apCost: 0, lastUpdateTime: BASE, presetQueue: [] },
      },
      ELEVATOR: {},
      POWER: {},
      MANUFACTURE: {
        slot_25: {
          buff: {}, state: 1, formulaId: "4", remainSolutionCnt: 73, outputSolutionCnt: 26,
          lastUpdateTime: BASE, saveTime: 0, tailTime: 0, apCost: 0,
          completeWorkTime: -1, capacity: 54, processPoint: 25688881.36,
        },
      },
      TRADING: {
        slot_24: {
          buff: {}, state: 1, lastUpdateTime: BASE, strategy: "O_GOLD", stockLimit: 10, apCost: 0,
          stock: [], next: { order: 45093, processPoint: 5952.16, maxPoint: 8640, speed: 1.07 },
          completeWorkTime: -1, display: {},
        },
      },
      CORRIDOR: {},
      WORKSHOP: {},
      DORMITORY: {},
      MEETING: {
        slot_36: meetingSlot({
          buff: { weight: {} }, state: 1, speed: 227, processPoint: 5403813,
          ownStock: [], receiveStock: [], board: {}, dailyReward: null,
          socialReward: { daily: 0, search: 0 }, infoShare: { ts: 0, reward: 0 },
          lastUpdateTime: BASE, completeWorkTime: -1, mustgetClue: [], startApCounter: {},
        }),
      },
      HIRE: {
        slot_23: {
          buff: {}, state: 1, refreshCount: 1, lastUpdateTime: BASE,
          processPoint: 3572960, speed: 160, completeWorkTime: -1,
        },
      },
      TRAINING: {
        slot_13: {
          buff: { speed: 0.35 }, state: 1, lastUpdateTime: BASE,
          trainee: { charInstId: 204, state: 1, targetSkill: 0, processPoint: 86379.75, speed: 2 },
          trainer: { charInstId: 13, state: 1 },
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

describe("2222 存档基建时间戳更新修复", () => {
  let mockPlayer: MockPlayerDataManager;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;
  let manager: BuildingManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    timeMock.now = 1786589894 + 86400; // 1 天后的当前时间
    mockPlayer = mockPlayerData({
      building: archiveBuilding(),
      event: { building: 0 },
      pushFlags: { hasGifts: 0, hasFriendRequest: 0, hasClues: 0, hasFreeLevelGP: 0, status: 0 },
      status: { uid: "2222", gold: 100000, androidDiamond: 100, socialPoint: 50, nickName: "A", nickNumber: "1" },
      inventory: { "3003": 100 },
      troop: {
        chars: {
          "197": { charId: "char_497_ctable", level: 1, evolvePhase: 0 },
          "253": { charId: "char_4087_ines", level: 1, evolvePhase: 0 },
          "79": { charId: "char_180_amgoat", level: 1, evolvePhase: 0 },
          "13": { charId: "char_113_cqbw", level: 1, evolvePhase: 0 },
          "204": { charId: "char_332_archet", level: 1, evolvePhase: 0 },
        },
        charGroup: {},
      },
    });
    mockTrigger = mockTypedEventEmitter();
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn<(recipe: MockUpdateRecipe) => Promise<void>>()
      .mockImplementation(async (recipe) => {
        const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata)) as Draft<PlayerDataModel>;
        const result = await recipe(draft);
        Object.assign(mockPlayer._playerdata, draft);
        return result;
      });
    manager = new BuildingManager(asPlayerManager(mockPlayer), mockTrigger);
  });

  it("统一时间戳：CONTROL/MEETING/HIRE/TRAINING/TRADING lastUpdateTime 全部推进到当前", async () => {
    await manager.sync();
    const b = mockPlayer._playerdata.building;
    const now = timeMock.now;
    // 修复前：这些房间 lastUpdateTime 停在 BASE（6 天前）
    expect(b.rooms.CONTROL.slot_34.lastUpdateTime).toBe(now);
    expect(b.rooms.MEETING.slot_36.lastUpdateTime).toBe(now);
    expect(b.rooms.HIRE.slot_23.lastUpdateTime).toBe(now);
    expect(b.rooms.TRAINING.slot_13.lastUpdateTime).toBe(now);
    expect(b.rooms.TRADING.slot_24.lastUpdateTime).toBe(now);
    expect(b.rooms.MANUFACTURE.slot_25.lastUpdateTime).toBe(now);
  });

  it("训练室：空弦（state=1 TRAINING）进度随时间推进（修复前停摆）", async () => {
    await manager.sync();
    const trainee = mockPlayer._playerdata.building.rooms.TRAINING.slot_13.trainee;
    // 修复前：processPoint 停在 86379.75；修复后：+86400 × 2 × (1 + 0.55 W 教官 buff)
    expect(trainee.processPoint).toBe(86379.75 + 86400 * 2 * 1.55);
  });

  it("会客室：线索搜集进度推进 + 有效速度按干员 buff 重算", async () => {
    await manager.sync();
    const room = mockPlayer._playerdata.building.rooms.MEETING.slot_36;
    // 官方全公式（2026-08-25 对齐）：Lv3 111% + 晓歌 5★+4% + 伊内丝 6★+5% + 非涣散 5%×2 + 技能 30% → speed = 100 × 1.60 = 160
    expect(room.speed).toBe(160);
    // 修复前停在 5403813；修复后：+86400 × 160，达阈值产出线索
    expect(room.ownStock).toHaveLength(2);
  });

  it("人力办公室：人脉搜集进度推进 + 有效速度按干员 buff 重算", async () => {
    await manager.sync();
    const room = mockPlayer._playerdata.building.rooms.HIRE.slot_23;
    // 艾雅法拉 hire_spd 20% → speed = 100 × 1.2 = 120
    expect(room.speed).toBe(120);
    // 修复前停在 3572960；修复后：+86400 × 120
    expect(room.processPoint).toBe(3572960 + 86400 * 120);
  });

  it("制造站：产出随时间继续累积（lastUpdateTime 推进后不重复计算）", async () => {
    await manager.sync();
    const room = mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_25;
    // 1 天 × 54 容量 → 4665600 进度 → 产出 1079 批（剩余 73 钳制）
    expect(room.outputSolutionCnt).toBe(26 + 73);
    expect(room.remainSolutionCnt).toBe(0);
    // 二次 sync 不重复产出（lastUpdateTime 已推进）
    await manager.sync();
    expect(mockPlayer._playerdata.building.rooms.MANUFACTURE.slot_25.outputSolutionCnt).toBe(99);
  });

  it("贸易站：next.processPoint 随时间推进并生成订单（lastUpdateTime 同步更新）", async () => {
    await manager.sync();
    const room = mockPlayer._playerdata.building.rooms.TRADING.slot_24;
    // 1 天 × 1.07 ≈ 92448 点 → 按订单整周期逐笔生成（受 stockLimit=10 上限封顶）。
    // Round 25/B9：单笔周期改为按赤金数取档（2/3/4 金 = 8640/12600/16560），
    // 故一天内生成的笔数随抽取结果浮动（Lv3 期望周期 ≈12204s → 约 6~10 笔），
    // 不再恒为 10 笔；此处断言区间与上限，并校验周期被写回。
    const produced = room.next.order - 45093;
    expect(produced).toBeGreaterThanOrEqual(1);
    expect(produced).toBeLessThanOrEqual(10);
    expect([8640, 12600, 16560]).toContain(room.next.maxPoint);
    expect(room.next.speed).toBeCloseTo(1.0);
  });
});
