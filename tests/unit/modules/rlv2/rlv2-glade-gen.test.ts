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

// 回归：黑流树海网格生成——林间空地填充格按数量规则生成（修复：生成数据中
// 「林间空地」规则 nodeType 为 null，距离/数量规则解析跳过 → 填充格永无林间空地）
const excelMock = vi.hoisted(() => ({
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
        stages: {
          ro6_n_1_1: { id: "ro6_n_1_1" },
          ro6_n_2_1: { id: "ro6_n_2_1" },
          ro6_n_3_1: { id: "ro6_n_3_1" },
          ro6_n_4_1: { id: "ro6_n_4_1" },
          ro6_n_5_1: { id: "ro6_n_5_1" },
          ro6_e_3_1: { id: "ro6_e_3_1" },
          ro6_b_3: { id: "ro6_b_3" },
          ro6_b_5: { id: "ro6_b_5" },
        },
        items: {},
        relics: {},
        variationData: {},
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["GRID_ZONE", "SCRAP"],
        scrap: { scrapItemToType: {} },
      },
    },
    consts: {},
  },
  CharacterTable: {} as Record<string, ExcelCharRowMock>,
  GameDataConst: { maxLevel: [[], [], [], [], [], []] },
}));

vi.mock("@excel/excel", () => ({ default: excelMock }));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import { mockPlayerData, asModel, type MockSeed } from "../../../helpers";

/**
 * rlv2 夹具宽视图
 *
 * `PlayerRoguelikeV2.pinned` 真实模型声明为 `string`（肉鸽置顶主题 id），而本用例沿用
 * 历史夹具值 `{}`（该占位的真值性由被测实现的惰性分支读取，改值即改运行期夹具数据，
 * 规则禁止）。故仅就地对该字段做单向断言（`string` 可赋给 `{}`，断言两侧仍可比较），
 * 其余种子仍受 `MockPlayerDataSeed` 的字段校验。
 */
const looseRlv2: MockSeed<PlayerDataModel["rlv2"]> = {
  outer: { rogue_6: {} },
  current: {},
  pinned: {} as string,
};

/** 开局 game 夹具类型（真实模型 `PlayerRoguelikeV2.CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

const GLADE = 268435456;

/** 构造已开局（rogue_6 / NORMAL）的玩家 */
function makePlayer(): PlayerDataManager {
  const pd = mockPlayerData({
    rlv2: looseRlv2,
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: {
      missions: { DAILY: {}, ACTIVITY: {} },
      missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} },
    },
  });
  const player = new PlayerDataManager(pd._playerdata);
  // 夹具只声明被测分支读到的三键，其余 game 字段由惰性分支承受
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme: "rogue_6",
    mode: "NORMAL",
    modeGrade: 0,
  });
  return player;
}

describe("黑流树海网格生成：林间空地填充", () => {
  it("Ⅲ/Ⅴ 层生成填充林间空地（数量规则下限 ≥5/≥10，断言至少出现）", async () => {
    await new Promise((r) => setTimeout(r, 0));
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2._module.create();
    const gz = rlv2._module.gridZone;
    for (const zone of [3, 5]) {
      gz.generate([zone]);
      const nodes = Object.values(gz.zones[`zone_${zone}`].nodes);
      const glades = nodes.filter((n) => n.content?.kind === GLADE);
      // 起点占 1 个 GLADE；填充林间空地必须 ≥1（修复前填充为 0，仅起点）
      expect(glades.length, `zone ${zone} 林间空地上限`).toBeGreaterThan(1);
    }
  });

  it("多轮生成：林间空地数量受数量规则上限约束（Ⅰ 层 ≤3+起点）", async () => {
    await new Promise((r) => setTimeout(r, 0));
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2._module.create();
    const gz = rlv2._module.gridZone;
    for (let i = 0; i < 5; i++) {
      gz.generate([1]);
      const nodes = Object.values(gz.zones["zone_1"].nodes);
      const glades = nodes.filter((n) => n.content?.kind === GLADE).length;
      // Ⅰ 层数量规则 [0,3] + 起点 1
      expect(glades).toBeLessThanOrEqual(4);
    }
  });
});
