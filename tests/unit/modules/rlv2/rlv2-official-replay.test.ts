import { describe, it, expect, vi, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
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


// ===== 官服抓包回放验证（2026-08-11 rogue_6 完整对局）=====
// 用官服请求序列驱动当前控制器，逐请求比对响应关键结构（state/pending 事件链/键格式）。
// 目标：验证当前逻辑与官服线格式一致（客户端不崩溃、不卡流程）。

// 官方 excel 完整 mock（rogue_6 全结构）
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
        rogue_6: {
          init: [
            { modeGrade: 0, predefinedId: null, modeId: "NORMAL", initialHp: 8, initialGold: 8, initialPopulation: 6, initialSquadCapacity: 6, initialBandRelic: ["rogue_6_band_1","rogue_6_band_2","rogue_6_band_3","rogue_6_band_4","rogue_6_band_5"], initialRecruitGroup: ["recruit_group_1","recruit_group_2","recruit_group_3","recruit_group_4","recruit_group_5","recruit_group_random"] },
            { modeGrade: 15, predefinedId: null, modeId: "NORMAL", initialHp: 4, initialGold: 8, initialPopulation: 6, initialSquadCapacity: 6, initialBandRelic: ["rogue_6_band_1","rogue_6_band_2","rogue_6_band_3","rogue_6_band_4","rogue_6_band_5"], initialRecruitGroup: ["recruit_group_1","recruit_group_2","recruit_group_3","recruit_group_4","recruit_group_5","recruit_group_random"] },
          ],
          difficulties: [
            { modeDifficulty: "NORMAL", grade: 0, scoreFactor: 1 },
            { modeDifficulty: "NORMAL", grade: 15, scoreFactor: 1.5 },
          ],
          stages: {
            ro6_n_1_1: { id: "ro6_n_1_1" }, ro6_n_1_2: { id: "ro6_n_1_2" },
            ro6_n_1_3: { id: "ro6_n_1_3" }, ro6_n_1_4: { id: "ro6_n_1_4" },
            ro6_e_1_1: { id: "ro6_e_1_1" },
            ro6_n_2_1: { id: "ro6_n_2_1" },
            ro6_n_3_1: { id: "ro6_n_3_1" },
            ro6_n_4_1: { id: "ro6_n_4_1" },
            ro6_n_5_1: { id: "ro6_n_5_1" },
            ro6_b_1: { id: "ro6_b_1" },
          },
          recruitTickets: {
            rogue_6_recruit_ticket_pioneer: { id: "rogue_6_recruit_ticket_pioneer", professionList: ["PIONEER"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_warrior: { id: "rogue_6_recruit_ticket_warrior", professionList: ["WARRIOR"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_tank: { id: "rogue_6_recruit_ticket_tank", professionList: ["TANK"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_sniper: { id: "rogue_6_recruit_ticket_sniper", professionList: ["SNIPER"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_caster: { id: "rogue_6_recruit_ticket_caster", professionList: ["CASTER"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_support: { id: "rogue_6_recruit_ticket_support", professionList: ["SUPPORT"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_medic: { id: "rogue_6_recruit_ticket_medic", professionList: ["MEDIC"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_special: { id: "rogue_6_recruit_ticket_special", professionList: ["SPECIAL"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_5star: { id: "rogue_6_recruit_ticket_5star", professionList: ["WARRIOR","SNIPER","TANK","MEDIC","SUPPORT","CASTER","SPECIAL","PIONEER"], rarityList: ["TIER_5"] },
            rogue_6_recruit_ticket_quad_melee: { id: "rogue_6_recruit_ticket_quad_melee", professionList: ["WARRIOR","TANK","SPECIAL","PIONEER"], rarityList: ["ALL"] },
            rogue_6_recruit_ticket_quad_ranged: { id: "rogue_6_recruit_ticket_quad_ranged", professionList: ["SNIPER","MEDIC","SUPPORT","CASTER"], rarityList: ["ALL"] },
          },
          recruitGrps: {
            recruit_group_1: { id: "recruit_group_1", name: "先手必胜" },
            recruit_group_2: { id: "recruit_group_2", name: "稳扎稳打" },
            recruit_group_3: { id: "recruit_group_3", name: "取长补短" },
            recruit_group_4: { id: "recruit_group_4", name: "灵活部署" },
            recruit_group_5: { id: "recruit_group_5", name: "坚不可摧" },
            recruit_group_random: { id: "recruit_group_random", name: "随心所欲" },
          },
          items: {
            rogue_6_gold: { id: "rogue_6_gold", type: "GOLD" },
            rogue_6_band_1: { id: "rogue_6_band_1", type: "BAND" },
          },
          relics: {
            rogue_6_band_1: { id: "rogue_6_band_1", buffs: [] },
            rogue_6_band_2: { id: "rogue_6_band_2", buffs: [] },
            // 襁褓生灵（开局礼物 GAME_INIT_GIFT 数据源：抓包该局 金+10/人口+1 = 2 猫 + 狗）
            rogue_6_legacy_01: { id: "rogue_6_legacy_01", buffs: [{ key: "init_gift", blackboard: [{ key: "id", value: 0, valueStr: "rogue_6_gold" }, { key: "count", value: 5, valueStr: null }] }] },
            rogue_6_legacy_01_1: { id: "rogue_6_legacy_01_1", buffs: [{ key: "init_gift", blackboard: [{ key: "id", value: 0, valueStr: "rogue_6_gold" }, { key: "count", value: 5, valueStr: null }] }] },
            rogue_6_legacy_02: { id: "rogue_6_legacy_02", buffs: [{ key: "init_gift", blackboard: [{ key: "id", value: 0, valueStr: "rogue_6_population" }, { key: "count", value: 1, valueStr: null }] }] },
          },
          bandRef: {},
          choices: {
            choice_ro6_startbuff_1: { id: "choice_ro6_startbuff_1", nextSceneId: null },
            choice_ro6_startbuff_2: { id: "choice_ro6_startbuff_2", nextSceneId: null },
            choice_ro6_startbuff_3: { id: "choice_ro6_startbuff_3", nextSceneId: null },
            choice_ro6_startbuff_4: { id: "choice_ro6_startbuff_4", nextSceneId: null },
            choice_ro6_startbuff_5: { id: "choice_ro6_startbuff_5", nextSceneId: null },
            choice_ro6_startbuff_6: { id: "choice_ro6_startbuff_6", nextSceneId: null },
            choice_leave: { id: "choice_leave", nextSceneId: null, type: "LEAVE" },
          },
          detailConst: { playerLevelTable: { 2: { exp: 10 }, 3: { exp: 20 } } },
        },
      },
      modules: {
        rogue_6: {
          moduleTypes: ["GRID_ZONE", "WEATHER", "SCRAP"],
          scrap: { scrapItemToType: { rogue_6_scrap_G_01: "GOODS", rogue_6_scrap_M_01: "MOVE" } },
        },
      },
      consts: {},
    },
    CharacterTable: {
      char_1012_skadi: { charId: "char_1012_skadi", rarity: "TIER_6", profession: "PIONEER" },
      char_1024_swire: { charId: "char_1024_swire", rarity: "TIER_5", profession: "PIONEER" },
      char_1039_thorn2: { charId: "char_1039_thorn2", rarity: "TIER_6", profession: "SNIPER" },
      char_1063_vigil: { charId: "char_1063_vigil", rarity: "TIER_5", profession: "SPECIAL" },
      char_1001_amiya2: { charId: "char_1001_amiya2", rarity: "TIER_5", profession: "CASTER" },
    } as Record<string, ExcelCharRowMock>,
    GameDataConst: { maxLevel: [[], [], [], [], [], []] },
  },
}));

vi.mock("@utils/crypt", () => ({
  decryptBattleData: vi.fn().mockResolvedValue({ completeState: 2, finalHp: 8, isPerfect: 1 }),
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import type { RoguelikeV2Manager } from "@game/modules/roguelike/logic";
import type { BattleData } from "@game/kernel/battle-model";
import type { JsonValue } from "@excel/json-value";

// 官服抓包 fixtures（tests/fixtures/rlv2-official/，从统一抓包存储提取归档——不依赖运行时 tmp/）
const CAPTURE_ROOT = path.resolve(__dirname, "../../../fixtures/rlv2-official");

/**
 * rlv2 快照读取视图
 *
 * 官服抓包与 `toJSON()` 快照都是未建模 JSON；本文件只读
 * `current.player.{state,pending[].type}`、`current.module.gridZone.zones`、
 * `current.map.zones` 四处键，故按此声明窄视图（值仍为 {@link JsonValue}）。
 */
interface Rlv2SnapshotView {
  player?: { state?: string; pending?: { type: string }[] };
  module?: { gridZone?: { zones?: { [key: string]: JsonValue } } };
  map?: { zones?: { [key: string]: JsonValue } };
}
/** 抓包响应读取视图（只读 modified.rlv2.current） */
interface CaptureResponseView {
  playerDataDelta?: { modified?: { rlv2?: { current?: Rlv2SnapshotView } } };
}

/** 最终响应快照读取视图（只读用例断言的序列化键） */
interface FinalSnapshotView {
  current: {
    module: {
      gridZone: {
        zones: { [key: string]: { nodes: { [key: string]: { show?: boolean; content?: JsonValue } } } };
        needConfirmStepZero?: boolean;
      };
      scrap: { activeVehicle: { isWalk?: boolean } };
    };
    map: { zones: { [key: string]: JsonValue } };
  };
}

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/** rlv2 外局存档夹具（`record.lastZone` 为服务端兼容旧字段，模型未声明；不加注解以保留该键） */
const OUTER_SEED = {
  rogue_6: {
    record: { last: 0, lastZone: 3, legacy: ["rogue_6_legacy_01", "rogue_6_legacy_01_1", "rogue_6_legacy_02"], stageCnt: {}, bandCnt: {}, bandGrade: {} },
    collect: { band: {} },
    buff: { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0 },
  },
};

function readReq(route: string, ts: string) {
  const f = path.join(CAPTURE_ROOT, route, `${ts}.json`);
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  return d.body;
}

function readRes(route: string, ts: string) {
  const f = path.join(CAPTURE_ROOT, route, `${ts}.json`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

function makePlayer() {
  // 官服抓包 createGame 含 GAME_INIT_SUPPORT（上一把到达 3 层触发支援选项）
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: OUTER_SEED,
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
    troop: {
      chars: {
        1: { charId: "char_1012_skadi" },
        2: { charId: "char_1024_swire" },
        3: { charId: "char_1039_thorn2" },
        4: { charId: "char_1063_vigil" },
        5: { charId: "char_1001_amiya2" },
      },
    },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefined: null });
  return player;
}

/** 官服响应关键字段提取（用于比对） */
function officialKey(res: CaptureResponseView) {
  const r = res.playerDataDelta?.modified?.rlv2;
  return {
    state: r?.current?.player?.state,
    pendingTypes: (r?.current?.player?.pending || []).map((e) => e.type),
    gridZoneKeys: Object.keys(r?.current?.module?.gridZone?.zones || {}),
    mapZoneKeys: Object.keys(r?.current?.map?.zones || {}),
  };
}

/** 当前逻辑响应关键字段 */
function ourKey(rlv2: RoguelikeV2Manager) {
  const json = JSON.parse(JSON.stringify(rlv2.toJSON())) as { current: Rlv2SnapshotView };
  return {
    state: json.current.player?.state,
    pendingTypes: (json.current.player?.pending || []).map((e) => e.type),
    gridZoneKeys: Object.keys(json.current.module?.gridZone?.zones || {}),
    mapZoneKeys: Object.keys(json.current.map?.zones || {}),
  };
}

describe("官服抓包回放验证（2026-08-11 rogue_6 完整对局）", () => {
  it("createGame → chooseInitialRelic → finishEvent(GIFT) → selectChoice 的 state/pending 链与官服一致", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    // 官方初始事件链由 rlv2:create 生成（relic/gift/support/recruit_set/recruit）
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    // 官方 createGame 响应：state INIT，pending = [RELIC, GIFT, SUPPORT, RECRUIT_SET, RECRUIT]
    const offCreate = officialKey(readRes("createGame", "2026-08-11T07-45-24-344Z"));
    expect(offCreate.state).toBe("INIT");
    expect(offCreate.pendingTypes).toContain("GAME_INIT_RELIC");
    expect(offCreate.pendingTypes).toContain("GAME_INIT_RECRUIT");
    const ourCreate = ourKey(rlv2);
    expect(ourCreate.state).toBe("INIT");
    expect(ourCreate.pendingTypes).toContain("GAME_INIT_RELIC");
    expect(ourCreate.pendingTypes).toContain("GAME_INIT_GIFT");
    expect(ourCreate.pendingTypes).toContain("GAME_INIT_RECRUIT");
    // 官服初始事件顺序：RELIC → GIFT → SUPPORT → RECRUIT_SET → RECRUIT
    expect(ourCreate.pendingTypes).toEqual(offCreate.pendingTypes);

    // chooseInitialRelic（官服 body select 值）
    await rlv2.chooseInitialRelic({ select: "0" });
    const ourRelic = ourKey(rlv2);
    expect(ourRelic.state).toBe("INIT");
    expect(ourRelic.pendingTypes[0]).toBe("GAME_INIT_GIFT");

    // finishEvent 消费 GIFT
    await rlv2.finishEvent();
    const ourGift = ourKey(rlv2);
    expect(ourGift.state).toBe("INIT");
    expect(ourGift.pendingTypes[0]).toMatch(/GAME_INIT_(SUPPORT|RECRUIT_SET)/);

    // selectChoice 消费 SUPPORT（若有）→ 保持 INIT
    if (ourGift.pendingTypes[0]?.startsWith("GAME_INIT_SUPPORT")) {
      await rlv2.selectChoice({ choice: "choice_ro6_startbuff_1" });
      const ourSup = ourKey(rlv2);
      expect(ourSup.state).toBe("INIT");
      expect(ourSup.pendingTypes[0]).toBe("GAME_INIT_RECRUIT_SET");
    }
  });

  it("chooseInitialRecruitSet 后 RECRUIT_SET 消费、RECRUIT 待处理", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.finishEvent(); // GIFT
    const gz = ourKey(rlv2);
    if (gz.pendingTypes[0]?.startsWith("GAME_INIT_SUPPORT")) {
      await rlv2.selectChoice({ choice: "choice_ro6_startbuff_1" });
    }
    // 官服 chooseInitialRecruitSet 响应：RECRUIT_SET 消费，GAME_INIT_RECRUIT 待处理
    const offRecruitSet = officialKey(readRes("chooseInitialRecruitSet", "2026-08-11T07-46-12-074Z"));
    expect(offRecruitSet.pendingTypes).toContain("GAME_INIT_RECRUIT");
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const ourRS = ourKey(rlv2);
    expect(ourRS.pendingTypes).toContain("GAME_INIT_RECRUIT");
    expect(ourRS.pendingTypes).not.toContain("GAME_INIT_RECRUIT_SET");
    // 官服 RECRUIT_SET 消费后 GAME_INIT_RECRUIT 的 tickets 填充（3 张）
    const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    expect(recruitEvt!.content.initRecruit!.tickets.length).toBe(3);
  });

  it("activeRecruitTicket 生成 RECRUIT 事件 + finishEvent 消费 RECRUIT 进入 WAIT_MOVE", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.finishEvent();
    const gz = ourKey(rlv2);
    if (gz.pendingTypes[0]?.startsWith("GAME_INIT_SUPPORT")) {
      await rlv2.selectChoice({ choice: "choice_ro6_startbuff_1" });
    }
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const tickets = [...recruitEvt!.content.initRecruit!.tickets];
    // 官服 activeRecruitTicket 响应：RECRUIT 事件 + 候选 list
    const offActive = officialKey(readRes("activeRecruitTicket", "2026-08-11T07-46-13-391Z"));
    expect(offActive.pendingTypes).toContain("RECRUIT");
    const t0 = tickets[0];
    await rlv2.activeRecruitTicket({ id: t0 });
    const ourActive = ourKey(rlv2);
    expect(ourActive.pendingTypes).toContain("RECRUIT");
    const ticket = rlv2.inventory!.recruit[t0];
    expect(ticket.list.length).toBeGreaterThan(0);
    // 招募第一张
    await rlv2.recruitChar({ ticketIndex: t0, optionId: String(ticket.list[0].instId) });
    // 官服 finishEvent（招募完成）→ WAIT_MOVE + 地图生成
    const offFinish = officialKey(readRes("finishEvent", "2026-08-11T07-46-24-944Z"));
    expect(offFinish.state).toBe("WAIT_MOVE");
    expect(offFinish.gridZoneKeys).toContain("zone_1");
    expect(offFinish.mapZoneKeys).toContain("1000");
    await rlv2.finishEvent();
    const ourFinish = ourKey(rlv2);
    expect(ourFinish.state).toBe("WAIT_MOVE");
    expect(ourFinish.gridZoneKeys).toContain("zone_1");
    expect(ourFinish.mapZoneKeys).toContain("1000");
  });

  it("最终响应序列化：布尔字段 + 无 kind + 键格式全对齐", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.finishEvent();
    const gz = ourKey(rlv2);
    if (gz.pendingTypes[0]?.startsWith("GAME_INIT_SUPPORT")) {
      await rlv2.selectChoice({ choice: "choice_ro6_startbuff_1" });
    }
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const tickets = [...recruitEvt!.content.initRecruit!.tickets];
    for (const t of tickets) {
      await rlv2.activeRecruitTicket({ id: t });
      const ticket = rlv2.inventory!.recruit[t];
      if (ticket?.list?.length) {
        await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
      }
    }
    await rlv2.finishEvent();
    const json = JSON.parse(JSON.stringify(rlv2.toJSON())) as FinalSnapshotView;
    // gridZone 节点：show 布尔、content 无 kind
    const gzNodes = Object.values(json.current.module.gridZone.zones.zone_1.nodes);
    for (const n of gzNodes) {
      expect(typeof n.show).toBe("boolean");
      expect(n.content).not.toHaveProperty("kind");
    }
    // scrap isWalk 布尔
    expect(typeof json.current.module.scrap.activeVehicle.isWalk).toBe("boolean");
    // map.zones 键 1000+
    expect(Object.keys(json.current.map.zones)).toContain("1000");
    // needConfirmStepZero 布尔
    expect(typeof json.current.module.gridZone.needConfirmStepZero).toBe("boolean");
  });
});

describe("官服回放扩展：战斗/暂存/结算", () => {
  it("battleFinish 胜利生成 BATTLE_REWARD（含零件奖励组）+ finishBattleReward 后 WAIT_MOVE", async () => {
    // 固定 Math.random：废品/收藏品掉落概率稳定（避免跨文件 random 抖动）
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.1);
    try {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    // 走完开局（进入第一层）
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.finishEvent();
    const gz = ourKey(rlv2);
    if (gz.pendingTypes[0]?.startsWith("GAME_INIT_SUPPORT")) {
      await rlv2.selectChoice({ choice: "choice_ro6_startbuff_1" });
    }
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const tickets = [...recruitEvt!.content.initRecruit!.tickets];
    for (const t of tickets) {
      await rlv2.activeRecruitTicket({ id: t });
      const ticket = rlv2.inventory!.recruit[t];
      if (ticket?.list?.length) {
        await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
      }
    }
    await rlv2.finishEvent(); // WAIT_MOVE + 地图
    // 官服 battleFinish 胜利响应：BATTLE_REWARD 事件 + earn
    const offBattle = officialKey(readRes("battleFinish", "2026-08-11T07-48-18-678Z"));
    expect(offBattle.pendingTypes).toContain("BATTLE_REWARD");
    // 战斗开始（battleStart 创建 BATTLE 事件，走 rlv2:battle:start）
    const battleEvt = rlv2._status.pending.find((e) => e.type === "BATTLE");
    if (!battleEvt) {
      await rlv2._trigger.emit("rlv2:event:create", ["BATTLE", { state: 1, chestCnt: 2, goldTrapCnt: 1, boxInfo: {}, tmpChar: [] }]);
    }
    rlv2._status.property.hp = { current: 10, max: 10 };
    // finalHp/isPerfect 为生产侧合并视图字段（Rlv2BattleReport），模型 BattleData 未声明；
    // 经变量传入避免字面量多余属性检查，值原样保留。
    const report = { completeState: 2, finalHp: 8, isPerfect: 1 };
    await rlv2._battle.finish([{
      battleLog: "",
      data: "encrypted",
      battleData: asModel<BattleData>(report),
    }]);
    const ourBattle = ourKey(rlv2);
    expect(ourBattle.pendingTypes).toContain("BATTLE_REWARD");
    // 黑流树海战斗奖励含零件组（官服 battleFinish 含 scrap_P_01/02）
    const rewardEvent = rlv2._status.pending.find((e) => e.type === "BATTLE_REWARD");
    const rewardGroups = rewardEvent!.content.battleReward!.rewards;
    const hasScrap = rewardGroups.some((g) =>
      g.items.some((it) => String(it.id).includes("scrap")),
    );
    expect(hasScrap).toBe(true);
    } finally {
      rand.mockRestore();
    }
  });

  it("stashRecruitTicket 与官服一致：stashRecruit 记录 + 上限 3", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    // 构造一张票
    rlv2.inventory!._recruit.gain("rogue_6_recruit_ticket_pioneer", "battle", 0);
    const idx = Object.keys(rlv2.inventory!.recruit)[0];
    await rlv2.stashRecruitTicket({ index: idx });
    const offStash = JSON.parse(fs.readFileSync(path.join(CAPTURE_ROOT, "stashRecruitTicket/2026-08-11T07-50-50-630Z.json"), "utf8"));
    const s = JSON.stringify(offStash);
    expect(s).toContain("stashRecruit");
    expect(s).toContain("stashRecruitLimit");
    // 我们的 inventory 输出含 stashRecruit/stashRecruitLimit
    const inv = JSON.parse(JSON.stringify(rlv2.inventory!.toJSON()));
    expect(Array.isArray(inv.stashRecruit)).toBe(true);
    expect(inv.stashRecruitLimit).toBe(3);
  });

  it("gameSettle 响应含 game/outer 结构（与官服一致）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    rlv2._status.cursor.zone = 5;
    rlv2._status.toEnding = "ro6_ending_1";
    await rlv2.gameSettle();
    const resp = JSON.parse(JSON.stringify(rlv2.buildSettleResponse()));
    expect(resp.game.brief).toBeTruthy();
    expect(resp.game.record).toBeTruthy();
    expect(resp.game.score).toBeTruthy();
    expect(resp.outer.mission).toBeTruthy();
    expect(resp.outer.relicBp).toBeTruthy();
  });
});
