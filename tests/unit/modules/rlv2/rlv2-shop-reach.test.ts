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

// 回归：商店节点抵达——商店判定不能只依赖 gridZone content.shop：
// 续局恢复/存档精简后 content 被剥除（kind/shop 丢失），须回退 map.zones
// 节点类型判定，否则诡意行商/秘境行商/应急助力抵达后不开商店。
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
        },
        items: {},
        relics: {},
        variationData: {},
        recruitTickets: {},
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
import { mockPlayerData, asModel } from "../../../helpers";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer(): PlayerDataManager {
  const pd = mockPlayerData({
    rlv2: {
      outer: { rogue_6: {} },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: {
      missions: { DAILY: {}, ACTIVITY: {} },
      missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} },
    },
  });
  const player = new PlayerDataManager(pd._playerdata);
  // 夹具只声明被测分支读到的键，其余 game 字段由惰性分支承受
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme: "rogue_6",
    mode: "NORMAL",
    modeGrade: 0,
  });
  return player;
}

describe("商店节点抵达（会话内 / 续局精简 / content 全空）", () => {
  it("三种形态均生成 BATTLE_SHOP 事件", async () => {
    await new Promise((r) => setTimeout(r, 0));
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2._module.create();
    const gz = rlv2._module.gridZone;
    // 反复生成直到出现商店节点（第 1 层 诡意行商 数量规则 [1,2] 必有）
    let shopId = "";
    for (let tries = 0; tries < 20 && !shopId; tries++) {
      gz.generate([1]);
      const nodes = gz.zones["zone_1"].nodes;
      for (const [id, n] of Object.entries(nodes)) {
        if (n.content?.shop) {
          shopId = id;
          break;
        }
      }
    }
    expect(shopId).not.toBe("");
    rlv2._status.cursor.zone = 1;
    rlv2._status.cursor.position = { x: 0, y: 1 };

    // 1. 会话内（content.shop + kind 完整）
    await rlv2.gridZoneMoveTo({ route: [shopId] });
    expect(rlv2._status.pending.map((e) => e.type)).toContain(
      "BATTLE_SHOP",
    );

    // 2. 续局精简形态（kind 被剥除，仅保留 shop）
    rlv2._status._pending._pending.length = 0;
    const node = gz.zones["zone_1"].nodes[shopId];
    node.content = { shop: node.content.shop };
    await rlv2.gridZoneMoveTo({ route: [shopId] });
    expect(rlv2._status.pending.map((e) => e.type)).toContain(
      "BATTLE_SHOP",
    );

    // 3. content 全空（kind/shop 均丢失）→ 回退 map.zones 节点类型判定
    rlv2._status._pending._pending.length = 0;
    node.content = {};
    await rlv2.gridZoneMoveTo({ route: [shopId] });
    expect(rlv2._status.pending.map((e) => e.type)).toContain(
      "BATTLE_SHOP",
    );
  });
});
