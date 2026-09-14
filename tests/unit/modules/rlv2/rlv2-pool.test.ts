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

// 官方 excel mock：rogue_1 items 含 RELIC（不同稀有度）+ 可献祭物品 + fragment 模块
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
          items: {
            rogue_1_relic_a01: { id: "rogue_1_relic_a01", type: "RELIC", rarity: "NORMAL", canSacrifice: true, value: 8 },
            rogue_1_relic_a02: { id: "rogue_1_relic_a02", type: "RELIC", rarity: "NORMAL", canSacrifice: true, value: 8 },
            rogue_1_relic_b01: { id: "rogue_1_relic_b01", type: "RELIC", rarity: "RARE", canSacrifice: true, value: 12 },
            rogue_1_relic_b02: { id: "rogue_1_relic_b02", type: "RELIC", rarity: "RARE", canSacrifice: true, value: 12 },
            rogue_1_relic_c01: { id: "rogue_1_relic_c01", type: "RELIC", rarity: "SUPER_RARE", canSacrifice: false, value: 16 },
            rogue_1_relic_d01: { id: "rogue_1_relic_d01", type: "RELIC", rarity: "BORN", canSacrifice: false, value: 4 },
            rogue_1_gold: { id: "rogue_1_gold", type: "GOLD", rarity: "NONE", canSacrifice: false },
            rogue_1_fragment_I_1: { id: "rogue_1_fragment_I_1", type: "FRAGMENT", rarity: "NONE", canSacrifice: false },
          },
          relics: {},
        },
      },
      modules: {
        rogue_1: {
          fragment: {
            fragmentData: {
              frag_i1: { id: "frag_i1", type: "INSPIRATION" },
              frag_w1: { id: "frag_w1", type: "WISH" },
              frag_d1: { id: "frag_d1", type: "IDEA" },
            },
          },
        },
      },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: {},
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import { RoguelikePoolManager } from "@game/modules/roguelike/pool";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePool() {
  const pd = mockPlayerData({
    rlv2: { outer: {}, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  // 夹具只声明被测分支读到的键，其余 game 字段由惰性分支承受
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_1", mode: "NORMAL", modeGrade: 0, predefined: null });
  return new RoguelikePoolManager(player.rlv2, player.rlv2._trigger);
}

describe("rlv2 藏品池（RoguelikePoolManager）", () => {
  let pool: RoguelikePoolManager;

  beforeEach(async () => {
    pool = makePool();
    await pool.create();
  });

  describe("create 分池", () => {
    it("应生成按稀有度分类的收藏品池", () => {
      const p = pool._pools;
      expect(p["pool_relic_normal"]).toEqual(["rogue_1_relic_a01", "rogue_1_relic_a02"]);
      expect(p["pool_relic_rare"]).toEqual(["rogue_1_relic_b01", "rogue_1_relic_b02"]);
      expect(p["pool_relic_super_rare"]).toEqual(["rogue_1_relic_c01"]);
      expect(p["pool_relic_all"]).toHaveLength(6);
    });

    it("应保留献祭与构想碎片池", () => {
      const p = pool._pools;
      expect(p["pool_sacrifice_n"]).toEqual(["rogue_1_relic_a01", "rogue_1_relic_a02"]);
      expect(p["pool_sacrifice_r"]).toEqual(["rogue_1_relic_b01", "rogue_1_relic_b02"]);
      expect(p["pool_fragment_3"]).toEqual(["frag_i1"]);
      expect(p["pool_fragment_4"]).toEqual(["frag_w1"]);
      expect(p["pool_fragment_5"]).toEqual(["frag_d1"]);
    });
  });

  describe("getRelic 随机抽取", () => {
    it("应返回池内收藏品 id", () => {
      const id = pool.getRelic("pool_relic_normal", []);
      expect(["rogue_1_relic_a01", "rogue_1_relic_a02"]).toContain(id);
    });

    it("应过滤已拥有的收藏品", () => {
      const id = pool.getRelic("pool_relic_normal", ["rogue_1_relic_a01"]);
      expect(id).toBe("rogue_1_relic_a02");
    });

    it("已拥有全部收藏品时应返回空串", () => {
      const id = pool.getRelic("pool_relic_normal", ["rogue_1_relic_a01", "rogue_1_relic_a02"]);
      expect(id).toBe("");
    });

    it("抽取不放回（同池不重复）", () => {
      const first = pool.getRelic("pool_relic_normal", [])!;
      const second = pool.getRelic("pool_relic_normal", [])!;
      expect(first).not.toBe(second);
    });

    it("不存在的池应返回空串", () => {
      expect(pool.getRelic("pool_unknown", [])).toBe("");
    });
  });
});
