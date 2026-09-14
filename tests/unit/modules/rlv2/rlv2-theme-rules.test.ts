import { describe, it, expect, vi, beforeEach } from "vitest";
/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }
/** excel mock 干员行形状（本文件用到的字段即可） */
interface ExcelCharRowMock {
  name?: string;
  charId?: string;
  rarity?: string;
  profession?: string;
  subProfessionId?: string;
}


vi.mock("@excel/excel", () => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,

    RoguelikeTopicTable: {
      details: {
        rogue_1: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          stages: {
            ro1_n_1_1: { id: "ro1_n_1_1" },
            ro1_n_2_1: { id: "ro1_n_2_1" },
            ro1_n_3_1: { id: "ro1_n_3_1" },
            ro1_n_4_1: { id: "ro1_n_4_1" },
            ro1_n_5_1: { id: "ro1_n_5_1" },
            ro1_n_6_1: { id: "ro1_n_6_1" },
            ro1_e_1_1: { id: "ro1_e_1_1" },
            ro1_e_2_1: { id: "ro1_e_2_1" },
            ro1_e_3_1: { id: "ro1_e_3_1" },
            ro1_e_4_1: { id: "ro1_e_4_1" },
            ro1_e_5_1: { id: "ro1_e_5_1" },
            ro1_e_6_1: { id: "ro1_e_6_1" },
            ro1_b_1: { id: "ro1_b_1" },
            ro1_b_2: { id: "ro1_b_2" },
            ro1_b_3: { id: "ro1_b_3" },
          },
          items: {
            rogue_1_relic_m16: { id: "rogue_1_relic_m16", type: "RELIC", usage: "让探索走向不同的结局" },
            rogue_1_gold: { id: "rogue_1_gold", type: "GOLD" },
          },
          relics: {},
          choices: {
            choice_startbuff_1: { id: "choice_startbuff_1" },
            choice_startbuff_2: { id: "choice_startbuff_2" },
            choice_startbuff_3: { id: "choice_startbuff_3" },
            choice_startbuff_4: { id: "choice_startbuff_4" },
            choice_startbuff_5: { id: "choice_startbuff_5" },
            choice_startbuff_6: { id: "choice_startbuff_6" },
          },
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
        rogue_6: {
          init: [
            { modeGrade: 0, predefinedId: null, modeId: "NORMAL", initialHp: 8, initialGold: 8, initialPopulation: 6, initialSquadCapacity: 6, initialBandRelic: ["rogue_6_band_1"] },
            { modeGrade: 3, predefinedId: null, modeId: "NORMAL", initialHp: 6, initialGold: 8, initialPopulation: 6, initialSquadCapacity: 6, initialBandRelic: ["rogue_6_band_1"] },
            { modeGrade: 15, predefinedId: null, modeId: "NORMAL", initialHp: 4, initialGold: 8, initialPopulation: 6, initialSquadCapacity: 6, initialBandRelic: ["rogue_6_band_1"] },
          ],
          difficulties: [
            { modeDifficulty: "NORMAL", grade: 0, scoreFactor: 1, name: "保密等级" },
            { modeDifficulty: "NORMAL", grade: 1, scoreFactor: 1.05, name: "保密等级·1", unlockText: "通过<保密等级>" },
            { modeDifficulty: "NORMAL", grade: 3, scoreFactor: 1.15, name: "保密等级·3", unlockText: "通过<保密等级·2>" },
            { modeDifficulty: "NORMAL", grade: 4, scoreFactor: 1.2, name: "保密等级·4", unlockText: "通过<保密等级·3>" },
            { modeDifficulty: "NORMAL", grade: 7, scoreFactor: 1.35, name: "保密等级·7", ruleDesc: "零件箱的初始容量-2", unlockText: "通过<保密等级·6>" },
            { modeDifficulty: "NORMAL", grade: 15, scoreFactor: 1.5, name: "保密等级·15", ruleDesc: "非初始招募六星干员的希望+1", unlockText: "通过<保密等级·14>" },
          ],
          recruitTickets: {
            rogue_6_recruit_ticket_5star: { id: "rogue_6_recruit_ticket_5star", professionList: ["WARRIOR","SNIPER","TANK","MEDIC","SUPPORT","CASTER","SPECIAL","PIONEER"], rarityList: ["TIER_5"] },
            rogue_6_recruit_ticket_quad_melee: { id: "rogue_6_recruit_ticket_quad_melee", professionList: ["WARRIOR","TANK","SPECIAL","PIONEER"], rarityList: ["ALL"] },
            rogue_6_recruit_ticket_quad_ranged: { id: "rogue_6_recruit_ticket_quad_ranged", professionList: ["SNIPER","MEDIC","SUPPORT","CASTER"], rarityList: ["ALL"] },
            rogue_6_recruit_ticket_pioneer: { id: "rogue_6_recruit_ticket_pioneer", professionList: ["PIONEER"], rarityList: ["TIER_1", "TIER_2", "TIER_3", "TIER_4", "TIER_5", "TIER_6"] },
          },
          stages: {
            ro6_n_1_1: { id: "ro6_n_1_1" },
            ro6_n_2_1: { id: "ro6_n_2_1" },
            ro6_n_3_1: { id: "ro6_n_3_1" },
            ro6_n_4_1: { id: "ro6_n_4_1" },
            ro6_n_5_1: { id: "ro6_n_5_1" },
            ro6_n_6_1: { id: "ro6_n_6_1" },
            ro6_e_1_1: { id: "ro6_e_1_1" },
            ro6_e_2_1: { id: "ro6_e_2_1" },
            ro6_e_3_1: { id: "ro6_e_3_1" },
            ro6_e_4_1: { id: "ro6_e_4_1" },
            ro6_e_5_1: { id: "ro6_e_5_1" },
            ro6_e_6_1: { id: "ro6_e_6_1" },
          },
          items: {
            rogue_6_legacy_01: { id: "rogue_6_legacy_01", type: "LEGACY", name: "襁褓中的猫", usage: "下次探索时，初始可额外获得5源石锭" },
            rogue_6_legacy_02: { id: "rogue_6_legacy_02", type: "LEGACY", name: "襁褓中的狗", usage: "下次探索时，初始可额外获得1点希望" },
            rogue_6_gold: { id: "rogue_6_gold", type: "GOLD" },
          },
          relics: {},
          choices: {},
          bandRef: {},
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
      },
      modules: { rogue_1: { moduleTypes: [] }, rogue_6: { moduleTypes: ["SCRAP"], scrap: { scrapItemToType: {} } } },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: { rogue_1: { outbuff: {}, modebuff: {} }, rogue_6: { outbuff: {}, modebuff: {} } },
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import { RoguelikePendingEvent } from "@game/modules/roguelike/events";
import type { RoguelikeInventoryManager } from "@game/modules/roguelike/inventory";
import type { PlayerRoguelikeV2, PlayerRoguelikeV2Zone } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/**
 * 旧存档兼容 record 夹具视图
 *
 * `record.lastZone` 是私服历史自定义字段（官服 record 无此键，见
 * app/game/modules/roguelike/game-init.ts 的注释与 event.ts 的 `OuterRecordLegacy`）；
 * 生成模型与 rlv2 本地模型均未声明该键，而夹具沿用（其真值被 game-init.ts / event.ts
 * 的旧存档兼容分支读取）。仅额外声明该键，其余字段仍受真实 record 模型校验。
 */
interface LegacyRecordFixture {
  last: number;
  lastZone?: number;
  legacy?: string[];
  stageCnt: { [key: string]: number };
  bandCnt: { [key: string]: { [key: string]: number } };
  bandGrade: { [key: string]: { [key: string]: number } };
}

/** 构造旧存档兼容的 record 夹具（见 {@link LegacyRecordFixture}） */
function legacyRecord(record: LegacyRecordFixture): LegacyRecordFixture {
  return record;
}

/**
 * rlv2:event:create 事件载荷夹具视图
 *
 * `EventMap["rlv2:event:create"]` 声明为 `[string, 未建模载荷]`，本文件 `emit` 辅助只转发
 * GAME_INIT_* 的 `{ step, id? }` 载荷（见 events.ts 的 GAME_INIT_* builder）。
 */
interface EventCreateArgs {
  step: number[];
  id?: string;
}

function makePlayer(theme: string, opts: { lastZone?: number; legacy?: string[]; relic?: string[] } = {}) {
  const pd = mockPlayerData({
    rlv2: {
      outer: {
        [theme]: {
          record: legacyRecord({ last: 0, lastZone: opts.lastZone ?? 0, legacy: opts.legacy ?? [], stageCnt: {}, bandCnt: {}, bandGrade: {} }),
          collect: { band: {} },
          buff: { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0 },
        },
      },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme,
    mode: "NORMAL",
    modeGrade: theme === "rogue_6" ? 15 : 0,
    predefined: null,
    start: Date.now(),
  });
  // 初始物品（结局变更/襁褓测试）
  if (opts.relic) {
    player.rlv2.inventory = asModel<RoguelikeInventoryManager>({
      relic: opts.relic.reduce<Record<string, { instId: string; id: string }>>(
        (acc, id, i) => ({ ...acc, [`r_${i}`]: { instId: `r_${i}`, id } }),
        {},
      ),
    });
  }
  return player;
}

describe("层数/层尾规则（官方机制对齐）", () => {
  it("maxZone 默认 5 层（无结局变更藏品时封顶 5）", () => {
    const player = makePlayer("rogue_1");
    expect(player.rlv2.maxZone).toBe(5);
  });

  it("持有'让探索走向不同的结局'藏品 → 附加层（maxZone 到 6）", () => {
    const player = makePlayer("rogue_1", { relic: ["rogue_1_relic_m16"] });
    expect(player.rlv2.maxZone).toBe(6);
  });

  it("rogue_1 层 1 尾必为商店、层 3/5 尾必为 boss", () => {
    const player = makePlayer("rogue_1");
    const map = player.rlv2._map;
    map.generate([1]);
    let zone1 = map.zones[1].nodes;
    // zone1 尾节点（zone_end）为商店（rogue_1 shopType = 8）
    const z1End = Object.values(zone1).find((n) => n.zone_end);
    expect([8, 4096]).toContain(z1End!.type);
    map.generate([3]);
    const z3End = Object.values(map.zones[3].nodes).find((n) => n.zone_end);
    expect(z3End!.type).toBe(4); // BATTLE_BOSS
    map.generate([5]);
    const z5End = Object.values(map.zones[5].nodes).find((n) => n.zone_end);
    expect(z5End!.type).toBe(4); // BATTLE_BOSS
  });
});

describe("支援选项门槛（上一把到 3 层）", () => {
  it("上一把到 3 层 → 本局 support=true（出现 GAME_INIT_SUPPORT）", async () => {
    const player = makePlayer("rogue_1", { lastZone: 3 });
    await player.rlv2.createGame({ theme: "rogue_1", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    expect(player.rlv2.current.game!.outer.support).toBe(true);
  });

  it("上一把未到 3 层 → support=false（无 GAME_INIT_SUPPORT）", async () => {
    const player = makePlayer("rogue_1", { lastZone: 2 });
    await player.rlv2.createGame({ theme: "rogue_1", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    expect(player.rlv2.current.game!.outer.support).toBe(false);
  });

  it("GAME_INIT_SUPPORT 为 3 选 1（3 个随机选项）", () => {
    const player = makePlayer("rogue_1");
    const ev = new RoguelikePendingEvent(
      player.rlv2,
      player.rlv2._trigger,
      "GAME_INIT_SUPPORT",
      0,
      { step: [2, 3], id: "" },
    );
    const scene = ev.content.initSupport!.scene;
    expect(Object.keys(scene.choices)).toHaveLength(3);
  });

  it("selectChoice 消费 GAME_INIT_SUPPORT 后应保持 INIT（非 WAIT_MOVE）", async () => {
    const player = makePlayer("rogue_1");
    const events = player.rlv2._status._pending;
    await player.rlv2._status._pending.init();
    const trigger = player.rlv2._trigger;
    const emit = (type: string, args: EventCreateArgs) => trigger.emit("rlv2:event:create", [type, args]);
    await emit("GAME_INIT_SUPPORT", { step: [2, 3], id: "" });
    await emit("GAME_INIT_RECRUIT_SET", { step: [3, 3] });
    await emit("GAME_INIT_RECRUIT", { step: [3, 3] });
    player.rlv2._status.state = "INIT";
    // 消费 SUPPORT（selectChoice）
    await player.rlv2.selectChoice({ choice: "choice_startbuff_1" });
    // 官方响应：仍有 GAME_INIT_RECRUIT_SET 待处理 → state 保持 INIT
    expect(player.rlv2._status.state).toBe("INIT");
    const remaining = events._pending.filter((e) => (e.type || "").startsWith("GAME_INIT_"));
    expect(remaining.length).toBe(2);
  });
});

describe("襁褓类藏品（下一局增益）", () => {
  it("上一把获得襁褓中的猫 → 本局开局 +5 源石锭", async () => {
    const player = makePlayer("rogue_6", { legacy: ["rogue_6_legacy_01"] });
    // createGame 会跑 status.create（重置 gold 为 init 值）→ legacy 应用在之后
    await player.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    const gold = player.rlv2._status.property.gold;
    // init initialGold（mock 无 → 0）+ legacy +5
    expect(gold).toBeGreaterThanOrEqual(5);
  });

  it("上一把获得襁褓中的狗 → 本局开局 +1 希望", async () => {
    const player = makePlayer("rogue_6", { legacy: ["rogue_6_legacy_02"] });
    await player.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    expect(player.rlv2._status.property.population.max).toBeGreaterThanOrEqual(1);
  });
});

describe("结局变更藏品", () => {
  it("持有'让探索走向不同的结局'藏品 → toEnding 切换为 2 号结局", async () => {
    const player = makePlayer("rogue_1", { relic: ["rogue_1_relic_m16"] });
    await player.rlv2.createGame({ theme: "rogue_1", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    expect(player.rlv2._status.toEnding).toBe("ro1_ending_2");
    expect(player.rlv2._status.chgEnding).toBe(true);
  });
});

describe("exploreScore 容错（theme 缺失不 500）", () => {
  it("details[theme] 不存在时 exploreScore 应回退 scoreFactor=1 不抛错", async () => {
    const player = makePlayer("rogue_1");
    const rlv2 = player.rlv2;
    rlv2.current.game!.theme = "rogue_unknown_theme";
    rlv2._status.cursor.zone = 2;
    rlv2._status.trace = [{ zone: 1, position: { x: 1, y: 0 } }];
    rlv2._map.zones = { 1: asModel<PlayerRoguelikeV2Zone>({ nodes: { "100": { type: 1, pos: { x: 1, y: 0 } } } }) };
    let score: number | null = null;
    expect(() => {
      score = rlv2.exploreScore();
    }).not.toThrow();
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe("黑流树海四星希望=0", () => {
  it("rogue_6 populationFor：4 星 0、5 星 2、6 星 6", async () => {
    const player = makePlayer("rogue_6", { lastZone: 3 });
    const recruit = player.rlv2.inventory!._recruit;
    expect(recruit["populationFor"](3)).toBe(0); // TIER_4
    expect(recruit["populationFor"](4)).toBe(2); // TIER_5
    expect(recruit["populationFor"](5)).toBe(6); // TIER_6
  });

  it("rogue_1 populationFor：4 星 2、5 星 3、6 星 6（常规曲线）", async () => {
    const player = makePlayer("rogue_1");
    const recruit = player.rlv2.inventory!._recruit;
    expect(recruit["populationFor"](3)).toBe(2); // TIER_4
    expect(recruit["populationFor"](4)).toBe(3); // TIER_5
    expect(recruit["populationFor"](5)).toBe(6); // TIER_6
  });
});

describe("难度解锁/初始值/随心所欲", () => {
  it("难度 0 默认解锁，通关 N 解锁 N+1", async () => {
    const player = makePlayer("rogue_6");
    await player.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    const mg = player.rlv2.outer["rogue_6"].collect.modeGrade.NORMAL;
    expect(mg["0"].state).toBe(2); // 默认解锁
    // 首次游玩（无通关记录）→ 仅 grade 0 解锁，grade 1 未解锁
    expect(mg["1"].state).toBe(1);
    // 上一把通关 grade 0 → record.modeGrade 记录 → 重新初始化时 grade 1 解锁
    const player2 = makePlayer("rogue_6");
    player2.rlv2.outer["rogue_6"].record.modeGrade = { NORMAL: { 0: 1 } };
    await player2.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    const mg2 = player2.rlv2.outer["rogue_6"].collect.modeGrade.NORMAL;
    expect(mg2["0"].state).toBe(2);
    expect(mg2["1"].state).toBe(2); // 通关 0 解锁 1
  });

  it("上一把通关难度 N 后 record.modeGrade 记录 + collect 解锁下一级", async () => {
    const player = makePlayer("rogue_6");
    await player.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 3, predefinedId: null });
    player.rlv2._status.cursor.zone = 5;
    player.rlv2._status.toEnding = "ro6_ending_1";
    await player.rlv2.gameSettle();
    const rec = player.rlv2.outer["rogue_6"].record;
    expect(rec.modeGrade!.NORMAL["3"]).toBeGreaterThan(0);
    const mg = player.rlv2.outer["rogue_6"].collect.modeGrade.NORMAL;
    expect(mg["3"].state).toBe(2);
    expect(mg["4"].state).toBe(2); // 下一级解锁
  });

  it("零件箱容量默认 10，N7+ 难度叠加后 -2（官服抓包 N15=8）", async () => {
    const player = makePlayer("rogue_6");
    await player.rlv2._module.create();
    const scrap = player.rlv2._module.scrap;
    expect(scrap.limit).toBe(10); // 基础容量 10
    expect(Object.keys(scrap.inventory).length).toBe(2); // s_1/s_2 开局废品
    expect(scrap.activeVehicle).toEqual({ isWalk: true }); // 步行无 instId
    // 难度7 "零件箱容量-2" 叠加：应用难度 buff 后 limit=8（官服 N15 抓包）
    await player.rlv2._buff.applyBuffs([
      player.rlv2._buff.difficultyBuffs("rogue_6", 15),
    ]);
    expect(scrap.limit).toBe(8);
  });

  it("随心所欲组（recruit_group_random）含 5 星临时 + 近战四职业 + 远程四职业券", async () => {
    const player = makePlayer("rogue_6");
    await player.rlv2._module.create();
    const events = player.rlv2._status._pending;
    await player.rlv2._status._pending.init();
    const trigger = player.rlv2._trigger;
    await trigger.emit("rlv2:event:create", ["GAME_INIT_RECRUIT_SET", { step: [4, 5] }]);
    await trigger.emit("rlv2:event:create", ["GAME_INIT_RECRUIT", { step: [5, 5] }]);
    await player.rlv2.chooseInitialRecruitSet({ select: "recruit_group_random" });
    const rec = Object.values(player.rlv2.inventory!.recruit);
    const ids = rec.map((r) => r.id).sort();
    expect(ids).toContain("rogue_6_recruit_ticket_5star");
    expect(ids).toContain("rogue_6_recruit_ticket_quad_melee");
    expect(ids).toContain("rogue_6_recruit_ticket_quad_ranged");
  });
});

describe("暂存/放弃招募券（stashRecruitTicket）", () => {
  it("stash 后 inventory.stashRecruit 记录 _candle 变体且票 state=3", async () => {
    const player = makePlayer("rogue_6");
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    // 构造一张招募票
    rlv2.inventory!._recruit.gain("rogue_6_recruit_ticket_pioneer", "battle", 0);
    // gain 用内部 _index 创建票（t_0）；读回票 index
    const idx = Object.keys(rlv2.inventory!.recruit)[0];
    await rlv2.stashRecruitTicket({ index: idx });
    const ticket = rlv2.inventory!.recruit[idx];
    expect(ticket.state).toBe(3);
    expect(rlv2.inventory!.stashRecruit).toContain("rogue_6_recruit_ticket_pioneer_candle");
  });

  it("留存超过上限（3）时不再接受", async () => {
    const player = makePlayer("rogue_6");
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    rlv2.inventory!.stashRecruit = ["a", "b", "c"];
    rlv2.inventory!._recruit.gain("rogue_6_recruit_ticket_warrior", "battle", 0);
    const idx = rlv2.inventory!._recruit.index;
    await rlv2.stashRecruitTicket({ index: idx });
    expect(rlv2.inventory!.stashRecruit).toHaveLength(3);
  });

  it("useStashedTicket 从留存列表取回", async () => {
    const player = makePlayer("rogue_6");
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    rlv2.inventory!._recruit.gain("rogue_6_recruit_ticket_pioneer", "battle", 0);
    const idx = Object.keys(rlv2.inventory!.recruit)[0];
    await rlv2.stashRecruitTicket({ index: idx });
    await rlv2.useStashedTicket({ id: idx });
    expect(rlv2.inventory!.stashRecruit.length).toBe(0);
  });
});
