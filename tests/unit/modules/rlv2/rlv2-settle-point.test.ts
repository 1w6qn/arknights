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

// 官方 excel mock：rogue_4 difficulties（scoreFactor）+ items + relics
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
        rogue_4: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          difficulties: [
            { modeDifficulty: "NORMAL", grade: 0, scoreFactor: 1, name: "直面魂灵" },
            { modeDifficulty: "NORMAL", grade: 5, scoreFactor: 1.25, name: "直面魂灵" },
            { modeDifficulty: "MONTH_TEAM", grade: 0, scoreFactor: 0, name: "讲述者列表" },
          ],
          items: {},
          relics: {},
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
      },
      modules: { rogue_4: { fragment: null } },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: {},
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import type { EventMap } from "@game/kernel/events";
import type { PlayerRoguelikeV2, PlayerRoguelikeV2Zone } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 CurrentData.Game；缺省字段由 asModel 放宽为可空） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer(opts: { pointOwned?: number; zone?: number } = {}) {
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: {
        rogue_4: {
          buff: { pointOwned: opts.pointOwned ?? 0, pointCost: 0, unlocked: {}, score: 0 },
        },
      },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_4", mode: "NORMAL", modeGrade: 0, predefined: null, start: Date.now() / 1000 });
  return player;
}

/** 构造标准结算现场：2 层 + 5 步 + 3 普通战 + 1 精英 + 1 boss + 2 招募 + 4 物品 → raw=187 */
function setupSettleScene(player: PlayerDataManager, opts: { zone?: number; mode?: string; modeGrade?: number } = {}) {
  const rlv2 = player.rlv2;
  const zone = opts.zone ?? 2;
  rlv2.current.game!.mode = opts.mode ?? "NORMAL";
  rlv2.current.game!.modeGrade = opts.modeGrade ?? 0;
  rlv2._status.cursor.zone = zone;
  // 地图：zone 1（rest 等非战斗）+ zone 2（战斗节点）
  rlv2._map.zones = asModel<Record<string, PlayerRoguelikeV2Zone>>({
    1: { id: "zone_1", nodes: {
      "0": { type: 0, pos: { x: 0, y: 0 } }, "100": { type: 16, pos: { x: 1, y: 0 } }, // REST
    } },
    2: { id: "zone_2", nodes: {
      "0": { type: 0, pos: { x: 0, y: 0 } },
      "100": { type: 1, pos: { x: 1, y: 0 } }, "101": { type: 1, pos: { x: 1, y: 1 } }, "102": { type: 1, pos: { x: 1, y: 2 } }, // 普通×3
      "200": { type: 2, pos: { x: 2, y: 0 } }, // 精英×1
      "300": { type: 4, pos: { x: 3, y: 0 } }, // boss×1
    } },
  });
  // trace：7 步（zone1 的 REST + zone2 的 起点/普通×3/精英/boss）
  rlv2._status.trace = [
    { zone: 1, position: { x: 1, y: 0 } },
    { zone: 2, position: { x: 0, y: 0 } },
    { zone: 2, position: { x: 1, y: 0 } },
    { zone: 2, position: { x: 1, y: 1 } },
    { zone: 2, position: { x: 1, y: 2 } },
    { zone: 2, position: { x: 2, y: 0 } },
    { zone: 2, position: { x: 3, y: 0 } },
  ];
  // 招募：2 张已完成的券
  rlv2.inventory!._recruit.tickets = asModel<Record<string, PlayerRoguelikeV2.CurrentData.Recruit>>({
    t_0: { index: "t_0", state: 3, result: { charId: "char_001" } },
    t_1: { index: "t_1", state: 3, result: { charId: "char_002" } },
    t_2: { index: "t_2", state: 1, list: [] }, // 未完成
  });
  // 物品：4 个收藏品 + 1 个战术道具
  rlv2.inventory!._relic.relics = asModel<Record<string, PlayerRoguelikeV2.CurrentData.Relic>>({
    r_0: { id: "rogue_4_relic_a01", count: 1 },
    r_1: { id: "rogue_4_relic_a02", count: 1 },
    r_2: { id: "rogue_4_relic_a03", count: 1 },
    r_3: { id: "rogue_4_relic_a04", count: 1 },
  });
  rlv2.inventory!.exploreTool = { e_1: { id: "rogue_4_explore_tool_1", count: 1 } };
  rlv2._status.toEnding = "normal";
  rlv2._status.property.level = 1;
  rlv2._status.property.hp = { current: 10, max: 10 };
}

describe("rlv2 结算探索分数与魂灵书签", () => {
  it("标准结算（2 层/7 步/3 普通/1 精英/1 boss/2 招募/5 物品）×1 = 196 分", async () => {
    const player = makePlayer();
    setupSettleScene(player);
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_4.buff;
    expect(buff.score).toBe(196);
    expect(buff.pointOwned).toBe(196); // 1:1 书签
  });

  // Round 33：官方 outer[theme].record.history[] 与 collect.endBook 此前**从不写入**
  // —— 结局类勋章（Rlv2EndingCollect「达成 N 种结局」）无数据可依。
  // Round 35：Rlv2FinishBattleWithSpecChar「携带指定干员战斗胜利 N 次」——载荷须带
  // 本局参战干员与作战胜利数（nodeTypeCounts 的普通(1)+紧急(2)作战数）。
  it("结算派发 Rlv2FinishBattleWithSpecChar（含本局参战干员与作战胜利数）", async () => {
    const player = makePlayer();
    setupSettleScene(player);
    const emit = vi.spyOn(player._trigger, "emit");
    await player.rlv2.gameSettle();
    const call = emit.mock.calls.find(
      (c): c is ["Rlv2FinishBattleWithSpecChar", EventMap["Rlv2FinishBattleWithSpecChar"]] =>
        c[0] === "Rlv2FinishBattleWithSpecChar",
    )!;
    expect(call).toBeTruthy();
    const payload = call[1][0];
    expect(payload.theme).toBe("rogue_4");
    expect(payload.mode).toBe("NORMAL");
    expect(Array.isArray(payload.charIds)).toBe(true);
    // 现场：zone2 的 3 个普通作战(type 1) + 1 个紧急作战(type 2) = 4
    expect(payload.battleWinCount).toBe(4);
  });

  // Round 35 回归守卫：结算 update 会清空本局运行态（trace/map/troop），
  // 特勤干员任务事件必须使用**结算前快照**，否则 charIds/作战数恒为空/0。
  it("特勤干员结算事件携带结算前快照（入队干员与作战数不为空）", async () => {
    const player = makePlayer();
    setupSettleScene(player);
    player.rlv2._status.runResult = "success";
    player.rlv2.troop.chars = asModel<Record<string, PlayerRoguelikeV2.CurrentData.Char>>({ c1: { charId: "char_512_aprot" } });
    const emit = vi.spyOn(player._trigger, "emit");
    await player.rlv2.gameSettle();
    const elite = emit.mock.calls.find(
      (c): c is ["Rlv2EliteBattleWithChar", EventMap["Rlv2EliteBattleWithChar"]] =>
        c[0] === "Rlv2EliteBattleWithChar",
    )!;
    expect(elite).toBeTruthy();
    expect(elite[1][0].charIds).toEqual(["c1"]);
    expect(elite[1][0].eliteCount).toBe(1); // 现场 zone2 的 1 个紧急作战(type 2)
    const sp = emit.mock.calls.find(
      (c): c is ["Rlv2EndingWithCharPassSpBattle", EventMap["Rlv2EndingWithCharPassSpBattle"]] =>
        c[0] === "Rlv2EndingWithCharPassSpBattle",
    )!;
    expect(sp[1][0].spBattleCount).toBe(4); // 3 普通 + 1 紧急
    expect(sp[1][0].charIds).toEqual(["c1"]);
  });

  it("结算写入对局历史与结局图鉴（结局类勋章数据源）", async () => {
    const player = makePlayer();
    setupSettleScene(player);
    player.rlv2._status.runResult = "success";
    await player.rlv2.gameSettle();
    const outer = player._playerdata.rlv2.outer.rogue_4;
    expect(outer.record.history).toHaveLength(1);
    expect(outer.record.history[0]).toMatchObject({ ending: "normal", result: 1 });
    expect(outer.record.history[0].endTs).toBeGreaterThan(0);
    expect(outer.collect.endBook).toEqual({
      normal: { state: 2, progress: null },
    });
  });

  it("难度倍率生效：modeGrade 5 → scoreFactor 1.25 → floor(196×1.25)=245", async () => {
    const player = makePlayer();
    setupSettleScene(player, { modeGrade: 5 });
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_4.buff;
    expect(buff.score).toBe(245);
    expect(buff.pointOwned).toBe(245);
  });

  it("超过 7 层按 7 层档位（650）", async () => {
    const player = makePlayer();
    setupSettleScene(player, { zone: 9 });
    // 9 层 → 档位 650（其他项：7+30+20+30+4+25=116）
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_4.buff;
    expect(buff.score).toBe(650 + 116);
  });

  it("MONTH_TEAM 模式倍率为 0（不加分）", async () => {
    const player = makePlayer();
    setupSettleScene(player, { mode: "MONTH_TEAM" });
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_4.buff;
    expect(buff.score).toBe(0);
    expect(buff.pointOwned).toBe(0);
  });

  it("主题无 outer.buff（从未玩过）应自动创建不崩", async () => {
    const pd = mockPlayerData({
      pushFlags: { status: 123456 },
      rlv2: { outer: {}, current: {}, pinned: {} as string },
      medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
      mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
    });
    const player = new PlayerDataManager(pd._playerdata);
    player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_4", mode: "NORMAL", modeGrade: 0, predefined: null, start: Date.now() / 1000 });
    setupSettleScene(player);
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_4.buff;
    expect(buff).toBeDefined();
    expect(buff.score).toBe(196);
  });
});
