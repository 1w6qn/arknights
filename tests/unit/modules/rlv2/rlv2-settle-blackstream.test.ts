import { describe, it, expect, vi } from "vitest";
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

// 官方 excel mock：rogue_6 difficulties + customizeData.commonDevelopment（生命游戏科技树节点）
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
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          difficulties: [
            { modeDifficulty: "NORMAL", grade: 0, scoreFactor: 1, name: "保密等级" },
            { modeDifficulty: "NORMAL", grade: 3, scoreFactor: 1.15, name: "保密等级" },
            { modeDifficulty: "NORMAL", grade: 9, scoreFactor: 1.45, name: "保密等级" },
            { modeDifficulty: "MONTH_TEAM", grade: 0, scoreFactor: 0, name: "实践者列表" },
          ],
          items: {},
          relics: {},
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
      },
      // 生命游戏增益树：10 个 outbuff 生长节点（供解锁占比计算）
      customizeData: {
        rogue_6: {
          commonDevelopment: {
            developments: Object.fromEntries(
              Array.from({ length: 10 }, (_, i) => [
                `rogue_6_outbuff_${i + 1}`,
                { buffId: `rogue_6_outbuff_${i + 1}`, tokenCost: 1, frontNodeId: [i > 0 ? `rogue_6_outbuff_${i}` : null].filter(Boolean) },
              ]),
            ),
          },
        },
      },
      modules: { rogue_6: { fragment: null } },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: {},
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import type { MockSeed } from "../../../helpers";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { PlayerRoguelikeV2, PlayerRoguelikeV2Zone } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 CurrentData.Game；缺省字段由 asModel 放宽为可空） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/** 生成模型 outer[theme].buff 的种子视图 */
type BuffSeed = MockSeed<PlayerDataModel["rlv2"]["outer"][string]["buff"]>;

/**
 * 黑流树海 outer[theme].buff 种子/读取视图
 *
 * 服务端结算在 `outer[theme].buff` 上写入 `sourceStack`（跨局源流样本余数，见
 * app/game/modules/roguelike/settle.ts#gameSettle；内部模型
 * rlv2-model.ts#PlayerRoguelikeV2.OuterData.Buff 已声明），但生成模型
 * `PlayerRoguelikeV2_OuterData_Buff` 未声明该键。本用例需注入并断言该键，
 * 为不改运行期夹具数据，仅就地声明该键的种子/读取视图（真实种子类型可赋给本视图，
 * 故断言两侧仍可比较）。
 */
interface BuffFixture {
  pointOwned?: number;
  pointCost?: number;
  sourceStack?: number;
  unlocked?: { [key: string]: number };
  score?: number;
}

/**
 * 构造黑流树海结算玩家与现场。
 * 沿用既有结算场景：2 层 / 7 步 / 3 普通 / 1 精英 / 1 boss / 2 招募 / 5 物品 → 探索分数 = 196。
 */
function makeBlackstreamPlayer(opts: { sourceStack?: number; pointOwned?: number; unlocked?: string[]; zone?: number; modeGrade?: number } = {}) {
  const buffSeed: BuffFixture = {
    pointOwned: opts.pointOwned ?? 0,
    pointCost: 0,
    sourceStack: opts.sourceStack ?? 0,
    unlocked: Object.fromEntries((opts.unlocked ?? []).map((u) => [u, 1])),
    score: 0,
  };
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: {
        rogue_6: {
          buff: buffSeed as BuffSeed,
        },
      },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  const rlv2 = player.rlv2;
  rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade: opts.modeGrade ?? 0, predefined: null, start: Date.now() / 1000 });
  rlv2.current.record = { brief: {}, record: {} };
  rlv2._status.cursor.zone = opts.zone ?? 2;
  rlv2._map.zones = asModel<Record<string, PlayerRoguelikeV2Zone>>({
    1: { id: "zone_1", nodes: { "0": { type: 0, pos: { x: 0, y: 0 } }, "100": { type: 16, pos: { x: 1, y: 0 } } } },
    2: { id: "zone_2", nodes: {
      "0": { type: 0, pos: { x: 0, y: 0 } },
      "100": { type: 1, pos: { x: 1, y: 0 } }, "101": { type: 1, pos: { x: 1, y: 1 } }, "102": { type: 1, pos: { x: 1, y: 2 } },
      "200": { type: 2, pos: { x: 2, y: 0 } },
      "300": { type: 4, pos: { x: 3, y: 0 } },
    } },
  });
  rlv2._status.trace = [
    { zone: 1, position: { x: 1, y: 0 } },
    { zone: 2, position: { x: 0, y: 0 } },
    { zone: 2, position: { x: 1, y: 0 } },
    { zone: 2, position: { x: 1, y: 1 } },
    { zone: 2, position: { x: 1, y: 2 } },
    { zone: 2, position: { x: 2, y: 0 } },
    { zone: 2, position: { x: 3, y: 0 } },
  ];
  rlv2.inventory!._recruit.tickets = asModel<Record<string, PlayerRoguelikeV2.CurrentData.Recruit>>({
    t_0: { index: "t_0", state: 3, result: { charId: "char_001" } },
    t_1: { index: "t_1", state: 3, result: { charId: "char_002" } },
  });
  rlv2.inventory!._relic.relics = asModel<Record<string, PlayerRoguelikeV2.CurrentData.Relic>>({
    r_0: { id: "rogue_6_relic_a01", count: 1 },
    r_1: { id: "rogue_6_relic_a02", count: 1 },
    r_2: { id: "rogue_6_relic_a03", count: 1 },
    r_3: { id: "rogue_6_relic_a04", count: 1 },
  });
  rlv2.inventory!.exploreTool = { e_1: { id: "rogue_6_explore_tool_1", count: 1 } };
  rlv2._status.toEnding = "normal";
  rlv2._status.property.level = 1;
  rlv2._status.property.hp = { current: 10, max: 10 };
  return player;
}

describe("rlv2 黑流树海结算：源流样本 + 演化算子", () => {
  it("效率 1:1（未解锁生命游戏节点，难度 0）：源流得分=探索分数，未满 200 存入 sourceStack、不发算子", async () => {
    const player = makeBlackstreamPlayer();
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_6.buff as BuffFixture;
    expect(buff.score).toBe(196); // 源流得分累计 = 探索分数
    expect(buff.sourceStack).toBe(196); // 余数保留跨局
    expect(buff.pointOwned).toBe(0); // 未满 200，无演化算子
  });

  it("跨局累加：源流堆栈前次 196 + 本次 196 = 392 → 发放 1 点算子，余数 192 保留", async () => {
    const player = makeBlackstreamPlayer({ sourceStack: 196 });
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_6.buff as BuffFixture;
    expect(buff.pointOwned).toBe(1);
    expect(buff.sourceStack).toBe(192); // 392 % 200
    expect(buff.score).toBe(196);
  });

  it("难度等级 9（scoreFactor1.45 + 三档效率 bump）：探索分数=floor(196×1.45)=284（不放大），演化算子池=floor(284×1.06)=301", async () => {
    const player = makeBlackstreamPlayer({ modeGrade: 9 });
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_6.buff as BuffFixture;
    expect(buff.score).toBe(284); // 探索分数：仅按难度，不放大
    expect(buff.pointOwned).toBe(1); // 源流得分 301 ≥ 200 → 1 算子
    expect(buff.sourceStack).toBe(101); // 301 % 200
  });

  it("生命游戏节点按已解锁占比 +10%：5/10 解锁 → 效率 1.05，源流得分=floor(196×1.05)=205", async () => {
    const player = makeBlackstreamPlayer({ unlocked: ["rogue_6_outbuff_1","rogue_6_outbuff_2","rogue_6_outbuff_3","rogue_6_outbuff_4","rogue_6_outbuff_5"] });
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_6.buff as BuffFixture;
    expect(buff.score).toBe(196); // 探索分数不放大
    expect(buff.pointOwned).toBe(1); // 源流得分 205 ≥ 200
  });

  it("生命游戏节点全部解锁：不再发放演化算子（分数按 1:1 计入科技树点数）", async () => {
    const unlocked = Array.from({ length: 10 }, (_, i) => `rogue_6_outbuff_${i + 1}`);
    const player = makeBlackstreamPlayer({ unlocked });
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_6.buff as BuffFixture;
    expect(buff.pointOwned).toBe(196); // 无算子，直接+探索分数
    expect(buff.sourceStack).toBe(0); // 不再累加源流堆栈
  });

  it("MONTH_TEAM 模式倍率为 0：源流得分 0，不发放算子", async () => {
    const player = makeBlackstreamPlayer();
    player.rlv2.current.game!.mode = "MONTH_TEAM";
    await player.rlv2.gameSettle();
    const buff = player._playerdata.rlv2.outer.rogue_6.buff as BuffFixture;
    expect(buff.score).toBe(0);
    expect(buff.pointOwned).toBe(0);
    expect(buff.sourceStack).toBe(0);
  });

  it("buildSettleResponse dorothinights 对齐：grade 9 score=探索分数(284)、scoreFactor=难度(1.45)、buff=1.06、bp.cnt=301、明细齐", async () => {
    const player = makeBlackstreamPlayer({ modeGrade: 9 });
    const resp = player.rlv2.buildSettleResponse();
    // score = floor(raw × 难度倍率) 单次放大；difficulty.grade9 scoreFactor=1.45 → floor(196×1.45)=284
    expect(resp.game.score.scoreFactor).toBe(1.45);
    expect(resp.game.score.score).toBe(284);
    // buff = 1 + extra_grow_point（生命游戏 0 + 难度3档各+2% → 1.06）；bp.cnt = floor(284×1.06)=301
    expect(resp.game.score.buff).toBeCloseTo(1.06);
    expect(resp.game.score.bp).toEqual({ cnt: 301, from: 55000, to: 55000 });
    expect(resp.game.score.gpChange).toEqual([100, 100]);
    expect(resp.game.score.accumulation).toEqual([20000, 20000]);
    // score.detail：dorothinights 线格式 [count, score] 结对，7 项求和 = raw = 196
    const detail = resp.game.score.detail;
    expect(detail).toEqual([
      [2, 80], // 通过层数（档位）
      [7, 7], // 通过步数 ×1
      [3, 30], // 普通战斗 ×10
      [1, 20], // 精英战斗 ×20
      [1, 30], // 领袖战斗 ×30
      [5, 25], // 获得物品 ×5
      [2, 4], // 招募干员 ×2
    ]);
    expect(detail.reduce((s: number, r: number[]) => s + r[1], 0)).toBe(196);
    // 非黑流树海主题：buff=1、bp.cnt=score、factor=难度(无则1)、score=raw
    const rogue4Buff: BuffFixture = { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0, sourceStack: 0 };
    const pd = mockPlayerData({
      pushFlags: { status: 123456 },
      rlv2: {
        outer: { rogue_4: { buff: rogue4Buff as BuffSeed } },
        current: {}, pinned: {} as string,
      },
      medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
      mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
    });
    const p2 = new PlayerDataManager(pd._playerdata);
    p2.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_4", mode: "NORMAL", modeGrade: 0, predefined: null, start: Date.now() / 1000 });
    p2.rlv2.current.record = { brief: {}, record: {} };
    const r2 = p2.rlv2;
    r2._status.cursor.zone = 2;
    r2._status.trace = [{ zone: 2, position: { x: 3, y: 0 } }];
    r2._map.zones = asModel<Record<string, PlayerRoguelikeV2Zone>>({ 2: { nodes: {} } });
    const resp2 = r2.buildSettleResponse();
    expect(resp2.game.score.scoreFactor).toBe(1);
    expect(resp2.game.score.score).toBeGreaterThan(0);
  });
});