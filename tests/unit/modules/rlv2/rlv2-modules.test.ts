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
        rogue_6: {
          stages: {
            ro6_n_1_1: { id: "ro6_n_1_1" },
            ro6_n_1_2: { id: "ro6_n_1_2" },
            ro6_n_2_1: { id: "ro6_n_2_1" },
          },
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
        },
        rogue_5: {
          stages: {},
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          items: { rogue_5_gold: { id: "rogue_5_gold", type: "GOLD" } },
        },
      },
      modules: {
        rogue_6: {
          moduleTypes: ["GRID_ZONE", "WEATHER", "SCRAP"],
          weather: {
            mainWeatherData: {
              rogue_6_weather_1_a: { id: "rogue_6_weather_1_a", level: 1 },
              rogue_6_weather_1_b: { id: "rogue_6_weather_1_b", level: 2 },
              rogue_6_weather_1_c: { id: "rogue_6_weather_1_c", level: 3 },
              rogue_6_weather_2_a: { id: "rogue_6_weather_2_a", level: 1 },
            },
            subWeatherData: {
              rogue_6_subweather_1: { id: "rogue_6_subweather_1" },
            },
          },
          scrap: {
            scrapItemToType: {
              rogue_6_scrap_M_01: "MOVE",
              rogue_6_scrap_G_01: "GOODS",
            },
          },
        },
        rogue_5: {
          moduleTypes: ["COPPER", "WRATH", "SKY"],
          copper: {
            copperData: {
              rogue_5_copper_P_01: { id: "rogue_5_copper_P_01" },
              rogue_5_copper_R_01: { id: "rogue_5_copper_R_01" },
              rogue_5_copper_F_01: { id: "rogue_5_copper_F_01" },
            },
          },
        },
        rogue_3: {
          moduleTypes: ["CHAOS", "VISION", "TOTEMBUFF"],
        },
        rogue_2: {
          stages: {},
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
        },
      },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    GameDataConst: { maxLevel: [[], [], [], [], [], []] },
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import { BLACKSTREAM_CONSTRUCTIONS } from "@game/modules/roguelike/data/blackstream-data";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 CurrentData.Game；缺省字段由 asModel 放宽为可空） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer(theme: string) {
  const pd = mockPlayerData({
    rlv2: {
      outer: { [theme]: {} },
      current: {},
      pinned: {} as string,
    },
    inventory: {},
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme,
    mode: "NORMAL",
    modeGrade: 0,
  });
  return player;
}

/** 触发 module.create()（按主题 moduleTypes 实例化管理器；rlv2:module:init 异步重置后初始化开局状态） */
async function createModules(player: PlayerDataManager) {
  await player.rlv2._module.create();
  return player;
}

describe("rlv2 主题模块管理器（2026-08-10）", () => {
  describe("GRID_ZONE（rogue_6）", () => {
    it("generate 应生成网格节点并设置 stepRemain", async () => {
      const player = await createModules(makePlayer("rogue_6"));
      const gz = player.rlv2._module.gridZone;
      expect(gz).toBeTruthy();
      gz.generate([1]);
      const json = gz.toJSON();
      expect(json.stepRemain).toBe(5); // Ⅰ 层初始行动力 5（官方逐层 5/6/7/8/8）
      expect(json.needConfirmStepZero).toBe(true);
      expect(Object.keys(json.zones["zone_1"].nodes).length).toBeGreaterThan(0);
      // 战斗节点信息在 map.zones（gridZone content 为空，stage 由 map.zones 提供）
      const mapNodes = player.rlv2._map.zones["1000"]?.nodes || {};
      expect(Object.values(mapNodes).some((n) => n.type === 1 && n.stage)).toBe(true);
    });

    it("moveTo 应标记节点已访问并开放相邻节点", async () => {
      const player = await createModules(makePlayer("rogue_6"));
      const gz = player.rlv2._module.gridZone;
      gz.generate([1]);
      player.rlv2._status.cursor.zone = 1;
      const nodeId = "100";
      const node = gz.moveTo([nodeId]);
      expect(node).toBeTruthy();
      expect(node!.state).toBe(2);
      expect(gz.toJSON().zones["zone_1"].nodes[nodeId].state).toBe(2);
    });

    it("generate 应按构造模板放置节点且距离规则生效（黑流树海）", async () => {
      // 固定 Math.random=0：generate 取第一张 L1 模板（floor-1-single-exit，startSlot [1,1]）
      const rand = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        const player = await createModules(makePlayer("rogue_6"));
        const gz = player.rlv2._module.gridZone;
        gz.generate([1]);
        const nodes = gz.toJSON().zones["zone_1"].nodes;
        // 起点 = 模板 startSlot（官服 ID = x*100+y）→ [1,1] = "101"，为林间空地且可见可访问
        // 官方 gridZone content 无 kind（节点类型在 map.zones.type）；起点为空 content
        expect(nodes["101"].content).toEqual({}); // GLADE 起点无 content
        expect(nodes["101"].state).toBe(2); // 官服 GLADE 节点 state=2
        expect(nodes["101"].show).toBe(true);
        // 起点相邻格（沿模板 edges 距离 1）一二层必为作战（官服 is={0:"combat",1:"combat"}）
        const template = BLACKSTREAM_CONSTRUCTIONS.find((c) => c.layerIndex === 0)!;
        const dist = gz.edgeDistances(template);
        for (const [id] of Object.entries(nodes)) {
          if (dist.get(id) === 1 && id !== "101") {
            const mapN = player.rlv2._map.zones["1000"]?.nodes?.[id];
            expect(mapN?.type, `起点相邻节点 ${id} 应为作战`).toBe(1);
          }
        }
        // 地图节点数 > 0、存在战斗节点
        expect(Object.keys(nodes).length).toBeGreaterThan(5);
        const mapNodes2 = player.rlv2._map.zones["1000"]?.nodes || {};
        const battleNode = Object.values(mapNodes2).find((n) => n.type === 1);
        expect(battleNode).toBeTruthy();
        // 同步 map.zones：与 module.gridZone 节点 ID 一致
        const mapNodes = player.rlv2._map.zones["1000"]?.nodes;
        expect(mapNodes).toBeTruthy();
        expect(Object.keys(mapNodes).length).toBe(Object.keys(nodes).length);
      } finally {
        rand.mockRestore();
      }
    });

    it("step 应消耗行动力（Ⅰ 层初始行动力 5）", async () => {
      const player = await createModules(makePlayer("rogue_6"));
      const gz = player.rlv2._module.gridZone;
      gz.generate([1]);
      expect(gz.toJSON().stepRemain).toBe(5);
      gz.step();
      expect(gz.toJSON().stepRemain).toBe(4);
    });
  });

  describe("WEATHER（rogue_6）", () => {
    it("onZoneNew 后 weather 保持为空（按官服对齐：不下发随机天气）", async () => {
      const player = await createModules(makePlayer("rogue_6"));
      const w = player.rlv2._module.weather;
      w.onZoneNew([1]);
      const json = w.toJSON();
      expect(json.currentMain).toBe("");
      expect(json.currentSub).toBe("");
      expect(json.weatherStep).toBe(0);
    });
  });

  describe("SCRAP（rogue_6）", () => {
    it("gain MOVE 型废品应自动装备为载具（开局自带 s_1/s_2）", async () => {
      const player = await createModules(makePlayer("rogue_6"));
      const s = player.rlv2._module.scrap;
      // 官服开局 2 件初始废品（s_1/s_2 = G_01）
      expect(Object.keys(s.inventory)).toHaveLength(2);
      s.gain(["rogue_6_scrap_M_01"]);
      const json = s.toJSON();
      expect(Object.keys(json.inventory)).toHaveLength(3); // 2 初始 + 1 MOVE
      expect(json.activeVehicle.isWalk).toBe(false);
      expect(json.activeVehicle.instId).toMatch(/^s_\d+$/);
    });

    it("changeVehicle 空串应切回步行", async () => {
      const player = await createModules(makePlayer("rogue_6"));
      const s = player.rlv2._module.scrap;
      s.gain(["rogue_6_scrap_M_01"]);
      s.changeVehicle("");
      expect(s.toJSON().activeVehicle.isWalk).toBe(true);
    });
  });

  describe("COPPER（rogue_5）", () => {
    it("drawInitial 应抽 3 枚铜币入袋", async () => {
      const player = await createModules(makePlayer("rogue_5"));
      const c = player.rlv2._module.copper;
      const json = c.toJSON();
      expect(Object.keys(json.bag)).toHaveLength(3);
      for (const item of Object.values(json.bag)) {
        expect(item.isDrawn).toBe(1);
      }
    });

    it("gild 应升级铜币层数", async () => {
      const player = await createModules(makePlayer("rogue_5"));
      const c = player.rlv2._module.copper;
      const key = Object.keys(c.toJSON().bag)[0];
      c.gild(key);
      expect(c.toJSON().bag[key].layer).toBe(1);
    });

    it("redraw 应重新抽牌", async () => {
      const player = await createModules(makePlayer("rogue_5"));
      const c = player.rlv2._module.copper;
      // 修复：redraw 需金币余额（原实现不校验直接扣成负数）
      player.rlv2._status.property.gold = 100;
      const ret = c.redraw();
      expect(ret.copper).toHaveLength(3);
    });
  });

  describe("SANCHECK / DICE（rogue_2）", () => {
    it("module.toJSON 应输出 san/dice 状态", async () => {
      const player = await createModules(makePlayer("rogue_2"));
      // 手动创建模块管理器（create 需完整 excel）
      const moduleJson = player.rlv2._module.toJSON();
      // 无管理器时由主题兜底输出
      expect(moduleJson.san).toEqual({ sanity: 100 });
      expect(moduleJson.dice).toEqual({ id: "", count: 1 });
    });
  });
});

describe("CHAOS / VISION（rogue_3）", () => {
  it("gainChaos 应累积坍缩值并在达到上限时升层挂坍缩", async () => {
    const player = await createModules(makePlayer("rogue_3"));
    const c = player.rlv2._module.chaos;
    expect(c).toBeTruthy();
    // 累积到上限（4）触发升层
    c.gainChaos(4);
    const json = c.toJSON();
    expect(json.level).toBe(1);
    expect(json.value).toBe(0);
    expect(json.deltaChaos.afterLevel).toBe(1);
  });

  it("vision 应输出 value/isMax", async () => {
    const player = await createModules(makePlayer("rogue_3"));
    const v = player.rlv2._module.vision;
    expect(v).toBeTruthy();
    expect(v.toJSON()).toEqual({ value: 0, isMax: 0 });
  });
});

describe("WRATH / SKY（rogue_5）", () => {
  it("wrath gain 应收集怒气", async () => {
    const player = await createModules(makePlayer("rogue_5"));
    const w = player.rlv2._module.wrath;
    expect(w).toBeTruthy();
    w.gain(["rogue_5_wrath_1"]);
    expect(w.toJSON().wraths).toEqual(["rogue_5_wrath_1"]);
    expect(w.toJSON().newWrath).toBe(0);
  });

  it("sky 应输出 zones", async () => {
    const player = await createModules(makePlayer("rogue_5"));
    const s = player.rlv2._module.sky;
    expect(s).toBeTruthy();
    expect(s.toJSON()).toEqual({ zones: {} });
  });
});
