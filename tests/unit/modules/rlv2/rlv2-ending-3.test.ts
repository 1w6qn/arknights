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

// rogue_6 三结局·纠缠调和：先行一步送干员 → 下一层返回 +2 希望 + 怦然信标
// → 持有怦然信标通过第Ⅴ层 → 第Ⅵ层（源流交汇处）→ ending_3
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
          ro6_n_6_1: { id: "ro6_n_6_1" },
        },
        init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
        items: {
          rogue_6_population: { id: "rogue_6_population", type: "POPULATION", rarity: "NONE" },
          rogue_6_relic_final_3: { id: "rogue_6_relic_final_3", type: "RELIC", rarity: "SUPER_RARE" },
        },
        relics: {
          rogue_6_relic_final_3: { id: "rogue_6_relic_final_3", buffs: [] },
        },
        choices: {
          choice_ro6_scout_1: { id: "choice_ro6_scout_1", nextSceneId: "scene_ro6_scout_2" },
          choice_ro6_scout_3: { id: "choice_ro6_scout_3", nextSceneId: "scene_ro6_scout_3" },
          choice_ro6_scout_4: { id: "choice_ro6_scout_4", nextSceneId: null },
        },
        choiceScenes: {
          scene_ro6_scout_2: { id: "scene_ro6_scout_2" },
          scene_ro6_scout_3: { id: "scene_ro6_scout_3" },
        },
        gameConst: { expedEndingRelic: "rogue_6_relic_final_3" },
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

/** 在 map.zones 放一个 zone_end 节点，cursor 指向它（checkZoneEnd 前置条件） */
function placeZoneEnd(player: PlayerDataManager, zone: number, key: string, x: number, y: number) {
  const map = player.rlv2._map;
  map.zones[key] = {
    id: `zone_${zone}`,
    index: Number(key),
    nodes: {
      [String(x * 100 + y)]: {
        index: String(x * 100 + y),
        pos: { x, y },
        next: [],
        type: 16,
        zone_end: true,
      },
    },
    variation: [],
  };
  player.rlv2._status.cursor.zone = zone;
  player.rlv2._status.cursor.position = { x, y };
}

describe("rogue_6 三结局·纠缠调和（先行一步 → 怦然信标 → 第Ⅵ层）", () => {
  it("先行一步选'派一名同伴进入/探索'→ 标记三结局远征", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    // scout_1：派一名同伴进入
    await player.rlv2.selectChoice({ choice: "choice_ro6_scout_1" });
    expect(player.rlv2.troop.expeditionDetails.ending).toBe(true);
    // scout_4：离开 → 不标记
    const player2 = makePlayer();
    await player2.rlv2._module.create();
    await player2.rlv2.selectChoice({ choice: "choice_ro6_scout_4" });
    expect(player2.rlv2.troop.expeditionDetails.ending).toBeUndefined();
  });

  it("expeditionChoice 派出干员 → 进入下一区域时返回 2 希望 + 怦然信标", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    // 标记三结局远征 + 派出干员
    await player.rlv2.selectChoice({ choice: "choice_ro6_scout_1" });
    await player.rlv2.expeditionChoice({ choice: "8" });
    expect(player.rlv2.troop.expedition).toEqual(["8"]);
    // 到达 zone 2 终点 → checkZoneEnd 推进 zone 3 → 干员返回
    gz.generate([2]);
    // 2 希望（population.max +2）
    const beforePop = player.rlv2._status.property.population.max;
    placeZoneEnd(player, 2, "1001", 3, 1);
    await player.rlv2.checkZoneEnd();
    const relics = Object.values(player.rlv2.inventory!.relic).map(
      (r) => r.id,
    );
    expect(relics).toContain("rogue_6_relic_final_3");
    expect(player.rlv2._status.property.population.max).toBe(
      beforePop + 2,
    );
    // 远征清空、标记清除、推进 zone 3
    expect(player.rlv2.troop.expedition).toEqual([]);
    expect(player.rlv2.troop.expeditionDetails.ending).toBeUndefined();
    expect(player.rlv2._status.cursor.zone).toBe(3);
  });

  it("持有怦然信标 → maxZone 允许第Ⅵ层（6）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    // 无怦然信标 → 5
    expect(player.rlv2.maxZone).toBe(5);
    // 持有怦然信标 → 6
    player.rlv2.inventory!._relic.relics = {
      r_0: { index: "r_0", id: "rogue_6_relic_final_3", count: 1, ts: 0 },
    };
    expect(player.rlv2.maxZone).toBe(6);
  });

  it("持有怦然信标通过第Ⅵ层 → toEnding = ro6_ending_3", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    // 持有怦然信标 + 已到 zone 6（VI 层）
    player.rlv2.inventory!._relic.relics = {
      r_0: { index: "r_0", id: "rogue_6_relic_final_3", count: 1, ts: 0 },
    };
    gz.generate([6]);
    placeZoneEnd(player, 6, "1005", 3, 2);
    await player.rlv2.checkZoneEnd();
    expect(player.rlv2._status.toEnding).toBe("ro6_ending_3");
    expect(player.rlv2._status.runResult).toBe("success");
  });

  it("第Ⅵ层（源流交汇处）生成：终点险路恶敌 + 起点右侧命运所指（调谐仪式入口）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    gz.generate([6]);
    const light = gz.toJSON().zones["zone_6"].nodes;
    const mapNodes = player.rlv2._map.zones["1005"]?.nodes || {};
    // 终点（zone_end）为险路恶敌 BATTLE_BOSS
    const ends = Object.values(mapNodes).filter((n) => n.zone_end);
    expect(ends.length).toBeGreaterThan(0);
    for (const e of ends) expect(e.type).toBe(4);
    // 命运所指（32768）存在于地图（调谐仪式入口）
    const fates = Object.values(mapNodes).filter((n) => n.type === 32768);
    expect(fates.length).toBeGreaterThan(0);
    // 行动力 5（VI 层）
    expect(gz.stepRemain).toBe(5);
    expect(light).toBeTruthy();
  });
});
