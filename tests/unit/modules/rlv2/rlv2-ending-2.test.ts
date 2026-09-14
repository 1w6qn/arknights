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

// rogue_6 二结局·维度重构：线人（bomb1）→ 沙盘α；沙盘β 商店；V 层命运所指
// （好奇心与死 end1 / 窥视箱中 end2）→ 混沌源阶理论（ro6_b_5）→ ending_2
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
        stages: {
          ro6_n_1_1: { id: "ro6_n_1_1" },
          ro6_n_3_1: { id: "ro6_n_3_1" },
          ro6_n_5_1: { id: "ro6_n_5_1" },
          ro6_b_5: { id: "ro6_b_5", name: "混沌源阶理论" },
        },
        init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
        items: {
          rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: "NONE" },
          rogue_6_relic_final_1: { id: "rogue_6_relic_final_1", type: "RELIC", rarity: "SUPER_RARE" },
          rogue_6_relic_final_2: { id: "rogue_6_relic_final_2", type: "RELIC", rarity: "SUPER_RARE" },
          rogue_6_scrap_G_01: { id: "rogue_6_scrap_G_01", type: "SCRAP", rarity: "NORMAL" },
        },
        relics: {
          rogue_6_relic_final_1: { id: "rogue_6_relic_final_1", buffs: [] },
          rogue_6_relic_final_2: { id: "rogue_6_relic_final_2", buffs: [] },
        },
        choices: {
          choice_ro6_bomb1_1: { id: "choice_ro6_bomb1_1", nextSceneId: "scene_ro6_bomb1_1" },
          choice_ro6_bomb1_2: { id: "choice_ro6_bomb1_2", nextSceneId: "scene_ro6_bomb1_2" },
          choice_ro6_bomb1_3: { id: "choice_ro6_bomb1_3", nextSceneId: "scene_ro6_bomb1_3" },
          choice_ro6_end1_1: { id: "choice_ro6_end1_1", nextSceneId: "scene_ro6_end1_1" },
          choice_ro6_end1_2: { id: "choice_ro6_end1_2", nextSceneId: "scene_ro6_end1_2" },
          choice_ro6_end2_1: { id: "choice_ro6_end2_1", nextSceneId: "scene_ro6_end2_2" },
          choice_ro6_end2_2: { id: "choice_ro6_end2_2", nextSceneId: "scene_ro6_end2_1" },
          choice_ro6_end2_3: { id: "choice_ro6_end2_3", nextSceneId: null },
          choice_ro6_end2_4: { id: "choice_ro6_end2_4", nextSceneId: "scene_ro6_end2_2" },
        },
        choiceScenes: {
          scene_ro6_bomb1_enter: { id: "scene_ro6_bomb1_enter", title: "线人与线索" },
          scene_ro6_end1_enter: { id: "scene_ro6_end1_enter", title: "好奇心与死" },
          scene_ro6_end2_enter: { id: "scene_ro6_end2_enter", title: "窥视箱中" },
          scene_ro6_end2_2: { id: "scene_ro6_end2_2", title: "窥视箱中" },
        },
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["GRID_ZONE", "SCRAP"],
        scrap: {
          scrapItemToType: {
            rogue_6_scrap_G_01: "GOODS",
          },
        },
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

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer() {
  const pd = mockPlayerData({
    rlv2: {
      outer: { rogue_6: {} },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0 });
  return player;
}

async function withRandom(v: number, fn: () => Promise<void> | void) {
  const spy = vi.spyOn(Math, "random").mockReturnValue(v);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

function holdRelic(player: PlayerDataManager, id: string) {
  player.rlv2.inventory!._relic.relics = {
    ...player.rlv2.inventory!._relic.relics,
    [`r_${Object.keys(player.rlv2.inventory!._relic.relics).length}`]: {
      index: `r_${Object.keys(player.rlv2.inventory!._relic.relics).length}`,
      id,
      count: 1,
      ts: 0,
    },
  };
}

describe("rogue_6 二结局·维度重构（线人 → 沙盘 → 命运所指 → 混沌源阶理论）", () => {
  it("线人事件（bomb1，Ⅱ-Ⅳ 层概率触发）→ 选'获得沙盘α' → 沙盘α 入库", async () => {
    await withRandom(0, async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      player.rlv2._status.cursor.zone = 3;
      player.rlv2._status.cursor.position = { x: 2, y: 1 };
      await player.rlv2.createIncidentScene();
      const pending = player.rlv2._status.pending;
      expect(pending.length).toBeGreaterThan(0);
      expect(pending[0].content.scene!.id).toBe("scene_ro6_bomb1_enter");
      // 选"获得沙盘α"（choice_ro6_bomb1_1）
      await player.rlv2.selectChoice({ choice: "choice_ro6_bomb1_1" });
      const relics = Object.values(player.rlv2.inventory!.relic).map(
        (r) => r.id,
      );
      expect(relics).toContain("rogue_6_relic_final_1");
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
    });
  });

  it("Ⅰ-Ⅲ 层行商出售沙盘β（1 源石锭）；持有后不再出现", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    player.rlv2._status.cursor.zone = 2; // Ⅱ 层
    const content = player.rlv2.buildShopContent("rogue_6");
    const goods = content.goods;
    const beta = goods.find((g) => g.itemId === "rogue_6_relic_final_2");
    expect(beta).toBeTruthy();
    expect(beta!.priceCount).toBe(1);
    // 持有后不再上架
    holdRelic(player, "rogue_6_relic_final_2");
    const content2 = player.rlv2.buildShopContent("rogue_6");
    expect(
      content2.goods.find((g) => g.itemId === "rogue_6_relic_final_2"),
    ).toBeFalsy();
  });

  it("命运所指：持有双沙盘 → 窥视箱中（end2_enter）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    holdRelic(player, "rogue_6_relic_final_1");
    holdRelic(player, "rogue_6_relic_final_2");
    await withRandom(0.9, async () => {
      await player.rlv2.createFateScene();
    });
    const pending = player.rlv2._status.pending;
    expect(pending[0].content.scene!.id).toBe("scene_ro6_end2_enter");
    expect(Object.keys(pending[0].content.scene!.choices)).toContain(
      "choice_ro6_end2_1",
    );
  });

  it("命运所指：无沙盘 → 随机（0.9 → 好奇心与死 end1_enter）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    await withRandom(0.9, async () => {
      await player.rlv2.createFateScene();
    });
    const pending = player.rlv2._status.pending;
    expect(pending[0].content.scene!.id).toBe("scene_ro6_end1_enter");
  });

  it("窥视箱中链路：找到声音位置 → 决战场景 → 混沌源阶理论（ro6_b_5）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    // 放一个节点在地图上（当前节点）
    const map = player.rlv2._map;
    map.zones["1004"] = {
      id: "zone_5",
      index: 1004,
      nodes: {
        "301": {
          index: "301",
          pos: { x: 3, y: 1 },
          next: [],
          type: 32,
        },
      },
      variation: [],
    };
    player.rlv2._status.cursor.zone = 5;
    player.rlv2._status.cursor.position = { x: 3, y: 1 };
    // 选"找到传出声音的位置"（end2_1）→ end2_2 场景（决战选项）
    await player.rlv2.selectChoice({ choice: "choice_ro6_end2_1" });
    const pending = player.rlv2._status.pending;
    expect(pending[0].content.scene!.id).toBe("scene_ro6_end2_2");
    expect(Object.keys(pending[0].content.scene!.choices)).toContain(
      "choice_ro6_end2_3",
    );
    // 选"与当前区域首领的决战"（end2_3）→ BATTLE 事件 + 节点变 ro6_b_5
    await player.rlv2.selectChoice({ choice: "choice_ro6_end2_3" });
    expect(player.rlv2._status.pending[0].type).toBe("BATTLE");
    const node = map.zones["1004"].nodes["301"];
    expect(node.stage).toBe("ro6_b_5");
    expect(node.type).toBe(4);
    expect(node.zone_end).toBe(true);
  });

  it("好奇心与死：消耗 50 源石锭标记（end1_1）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    player.rlv2._status.property.gold = 100;
    await player.rlv2.selectChoice({ choice: "choice_ro6_end1_1" });
    expect(player.rlv2._status.property.gold).toBe(50);
    expect(player.rlv2._status.state).toBe("WAIT_MOVE");
  });

  it("持有沙盘α（不持怦然信标）通过第Ⅴ层 → ending_2", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    holdRelic(player, "rogue_6_relic_final_1");
    const map = player.rlv2._map;
    map.zones["1004"] = {
      id: "zone_5",
      index: 1004,
      nodes: {
        "501": {
          index: "501",
          pos: { x: 5, y: 1 },
          next: [],
          type: 16,
          zone_end: true,
        },
      },
      variation: [],
    };
    player.rlv2._status.cursor.zone = 5;
    player.rlv2._status.cursor.position = { x: 5, y: 1 };
    await player.rlv2.checkZoneEnd();
    expect(player.rlv2._status.toEnding).toBe("ro6_ending_2");
    expect(player.rlv2._status.runResult).toBe("success");
  });
});
