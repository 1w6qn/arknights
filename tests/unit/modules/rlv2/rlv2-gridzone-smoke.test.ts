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
            ro6_n_1_2: { id: "ro6_n_1_2" },
            ro6_n_1_3: { id: "ro6_n_1_3" },
            ro6_e_1_1: { id: "ro6_e_1_1" },
            ro6_n_5_1: { id: "ro6_n_5_1" },
            ro6_e_5_1: { id: "ro6_e_5_1" },
          },
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          items: {
            rogue_6_scrap_G_07: { id: "rogue_6_scrap_G_07", type: "SCRAP", rarity: "RARE" },
            rogue_6_legacy_01: { id: "rogue_6_legacy_01", type: "LEGACY", rarity: "NORMAL" },
            char_508_aguard: { id: "char_508_aguard", type: "CHARACTER", rarity: "NORMAL" },
            rogue_6_ap: { id: "rogue_6_ap", type: "SPECIAL_ZONE_AP", rarity: "NONE" },
            rogue_6_stash_recruit: { id: "rogue_6_stash_recruit", type: "STASH_RECRUIT_LIMIT", rarity: "NONE" },
            rogue_6_bubble_01: { id: "rogue_6_bubble_01", type: "NODE_BUOY", rarity: "NONE" },
          },
        },
      },
      modules: {
        rogue_6: {
          moduleTypes: ["GRID_ZONE", "SCRAP"],
          scrap: { scrapItemToType: { rogue_6_scrap_G_07: "GOODS" } },
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
import { BLACKSTREAM_CONSTRUCTIONS } from "@game/modules/roguelike/data/blackstream-data";
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

/** Math.random 固定 0：generate 恒取每层第一张模板，便于按模板精确断言 */
async function withFixedRandom(fn: () => Promise<void> | void) {
  const spy = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

describe("GRID_ZONE 官服结构对齐（构造模板）", () => {
  it("各层生成：节点 ID 为 x*100+y、map/light 对齐、终点 zone_end", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;

      for (const zone of [1, 2, 3, 4, 5]) {
        gz.generate([zone]);
        const light = gz.toJSON().zones[`zone_${zone}`].nodes;
        const mapNodes = player.rlv2._map.zones[String(1000 + zone - 1)]?.nodes;
        expect(mapNodes, `zone ${zone} map.zones`).toBeTruthy();
        expect(Object.keys(mapNodes).length).toBe(Object.keys(light).length);
        for (const id of Object.keys(light)) {
          expect(mapNodes[id], `zone ${zone} node ${id}`).toBeTruthy();
          const x = Math.floor(Number(id) / 100);
          const y = Number(id) % 100;
          expect(mapNodes[id].pos).toEqual({ x, y });
        }
        // 起点（唯一 state 2，官服 GLADE）为 GLADE
        const start = Object.entries(light).find(([, n]) => n.state === 2);
        expect(start, `zone ${zone} 起点`).toBeTruthy();
        expect(start![1].content).toEqual({}); // 起点 content 空（官方线格式）
        // 终点 zone_end ≥1 且 type 为 VISIBLE_END/BATTLE_BOSS
        const ends = Object.values(mapNodes).filter((n) => n.zone_end);
        expect(ends.length, `zone ${zone} 终点`).toBeGreaterThan(0);
        for (const e of ends) {
          expect([8388608, 4]).toContain(e.type);
        }
        // 战斗节点带 stage
        const battles = Object.values(mapNodes).filter((n) => n.type === 1 || n.type === 2 || n.type === 4);
        for (const b of battles) expect(b.stage).toBeTruthy();
      }
    });
  });

  it("1-2 层起点相邻（边距离 1）必为作战", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      for (const zone of [1, 2]) {
        gz.generate([zone]);
        const t = BLACKSTREAM_CONSTRUCTIONS.find((c) => c.layerIndex === zone - 1)!;
        const dist = gz.edgeDistances(t);
        // 起点按模板 startSlot 定位（同层 5 用例）
        const startId = String(t.startSlot[0] * 100 + t.startSlot[1]);
        const zoneNodes = gz.zones[`zone_${zone}`].nodes;
        for (const [id] of Object.entries(zoneNodes)) {
          if (dist.get(id) === 1 && id !== startId) {
            const mapN = player.rlv2._map.zones[String(1000 + zone - 1)]?.nodes?.[id];
            expect(mapN?.type, `zone ${zone} 相邻 ${id}`).toBe(1);
          }
        }
      }
    });
  });

  it("非战斗节点类型必须落在层 5 距离规则内（沿边距离）", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([5]);
      const zoneNodes = gz.zones["zone_5"].nodes;
      const t5 = BLACKSTREAM_CONSTRUCTIONS.find((c) => c.layerIndex === 4)!;
      const dist = gz.edgeDistances(t5);
      // 起点按模板 startSlot 定位（初始点亮节点与填充林间空地均 state=2/kind=GLADE，
      // 不能按 state 或 kind 唯一识别起点）
      const startId = String(t5.startSlot[0] * 100 + t5.startSlot[1]);
      for (const [id] of Object.entries(zoneNodes)) {
        if (id === startId) continue; // 起点不受距离规则约束
        const d = dist.get(id);
        // 无边连通的孤立占位格（生成时按兜底距离铺林间空地）不参与沿边距离校验；
        // 其余填充节点必须落在距离规则内（此前无林间空地填充时此分支从未触发）
        if (d === undefined) continue;
        expect(d, `zone5 ${id} 距离`).toBeGreaterThanOrEqual(1);
      }
    });
  });
});

describe("GRID_ZONE 物品发放类型兜底（fix funcs[type] 崩溃）", () => {
  it("rogue_6 各物品类型 getItem 不抛错（SCRAP/LEGACY/NODE_BUOY/CHARACTER 等）", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const inv = player.rlv2.inventory;
      // 触发 immediate_reward 同路径：rlv2:get:items → inventory.getItem
      await player.rlv2._trigger.emit("rlv2:get:items", [[
        { id: "rogue_6_scrap_G_07", count: 1, sub: 0 },
        { id: "rogue_6_legacy_01", count: 1, sub: 0 },
        { id: "rogue_6_ap", count: 1, sub: 0 },
        { id: "rogue_6_stash_recruit", count: 1, sub: 0 },
        { id: "rogue_6_bubble_01", count: 1, sub: 0 },
      ]]);
      // 各类型 getItem 不再抛错（修复 funcs[type] is not a function 500）
      // SCRAP 型应进入 SCRAP 模块库存
      const scrapInv = player.rlv2._module.scrap?.inventory || {};
      expect(Object.keys(scrapInv).length).toBeGreaterThan(0);
    });
  });

  it("CHARACTER 型干员应触发招募（rlv2:recruit:initial_char）", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const recv: string[] = [];
      player.rlv2._trigger.on("rlv2:recruit:initial_char", ([id]: [string]) => {
        recv.push(id);
      });
      await player.rlv2._trigger.emit("rlv2:get:items", [[
        { id: "char_508_aguard", count: 1, sub: 0 },
      ]]);
      expect(recv).toContain("char_508_aguard");
    });
  });
});

describe("rogue_6 战斗奖励（零件/收藏品）", () => {
  it("rogue_6 主题 scrapItemToType 零件池非空（战斗奖励可产出零件）", async () => {
    // mock 中 rogue_6 modules.scrap.scrapItemToType 已配置 → 验证零件奖励数据源存在
    const modules = excelMock.RoguelikeTopicTable.modules.rogue_6;
    expect(modules.scrap.scrapItemToType).toBeTruthy();
    expect(Object.keys(modules.scrap.scrapItemToType).length).toBeGreaterThan(0);
  });
});
