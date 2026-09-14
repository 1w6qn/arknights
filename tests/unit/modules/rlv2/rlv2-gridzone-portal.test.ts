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

// rogue_6 误入奇境（portal/隐藏层）+ 常规实托邦 + 行动力 测试
// 数据 mock：variationData（乌托邦效果表）、portal 场景/选项（scene_ro6_portal*）、
// SCRAP 模块（零件箱：初始 2 件 GOODS 加工品，供消耗）
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
          ro6_n_3_1: { id: "ro6_n_3_1" },
          ro6_n_5_1: { id: "ro6_n_5_1" },
        },
        init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
        items: {
          rogue_6_scrap_M_01: { id: "rogue_6_scrap_M_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_G_07: { id: "rogue_6_scrap_G_07", type: "SCRAP", rarity: "RARE" },
          rogue_6_ap: { id: "rogue_6_ap", type: "SPECIAL_ZONE_AP", rarity: "NONE" },
          rogue_6_start_1: { id: "rogue_6_start_1", type: "RELIC", rarity: "NORMAL" },
        },
        relics: {
          rogue_6_start_1: {
            id: "rogue_6_start_1",
            buffs: [
              { key: "zone_into_reward", blackboard: [{ key: "id", valueStr: "rogue_6_ap" }, { key: "count", value: 1 }, { key: "zone", valueStr: "zone_1" }] },
              { key: "zone_into_reward", blackboard: [{ key: "id", valueStr: "rogue_6_ap" }, { key: "count", value: 1 }, { key: "zone", valueStr: "zone_4" }] },
            ],
          },
        },
        variationData: {
          variation_1: { id: "variation_1", outerName: "“巨人摇篮”", type: "BAT" },
          variation_5: { id: "variation_5", outerName: "“全知者盲区”", type: "MAP" },
        },
        choiceScenes: {
          scene_ro6_portal1a_enter: { id: "scene_ro6_portal1a_enter", description: "红色的雾气钻入你的耳中" },
          scene_ro6_portal1a_1: { id: "scene_ro6_portal1a_1" },
          scene_ro6_portal1a_2: { id: "scene_ro6_portal1a_2" },
          scene_ro6_portal1a_3: { id: "scene_ro6_portal1a_3" },
        },
        choices: {
          choice_ro6_portal1a_1: { id: "choice_ro6_portal1a_1", nextSceneId: "scene_ro6_portal1a_1" },
          choice_ro6_portal1a_2: { id: "choice_ro6_portal1a_2", nextSceneId: "scene_ro6_portal1a_1" },
          choice_ro6_portal1a_3: { id: "choice_ro6_portal1a_3", nextSceneId: "scene_ro6_portal1a_1" },
          choice_ro6_portal1a_4: { id: "choice_ro6_portal1a_4", nextSceneId: null },
          choice_ro6_portal1a_5: { id: "choice_ro6_portal1a_5", nextSceneId: "scene_ro6_portal1a_2" },
          choice_ro6_portal1a_6: { id: "choice_ro6_portal1a_6", nextSceneId: "scene_ro6_portal1a_3" },
        },
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["GRID_ZONE", "SCRAP"],
        scrap: {
          // 官方 scrapTypeData：MOVE=加工品（可用于地图移动）、GOODS=自然物、PASSIVE=概念体。
          // 误入奇境"消耗零件箱里的 1件 加工品"消耗的是 MOVE 型 → 开局 s_1/s_2 用 MOVE 型。
          moduleConsts: { identifyScrapId: "rogue_6_scrap_M_01" },
          moveScrapData: {
            rogue_6_scrap_M_01: { scrapId: "rogue_6_scrap_M_01", sellPrice: 2 },
          },
          goodsScrapData: {
            rogue_6_scrap_G_07: { scrapId: "rogue_6_scrap_G_07", sellPrice: 2 },
          },
          scrapItemToType: {
            rogue_6_scrap_M_01: "MOVE",
            rogue_6_scrap_G_07: "GOODS",
            rogue_6_scrap_MOVE: "MOVE",
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
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import { mockPlayerData, asModel } from "../../../helpers";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer(modeGrade = 0) {
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
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade });
  return player;
}

/** Math.random 固定 0：模板取首个、portal key=3000、variation_1 */
async function withFixedRandom(fn: () => Promise<void> | void) {
  const spy = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

describe("rogue_6 行动力（逐层初始值）", () => {
  it("I..V 层初始行动力 5/6/7/8/8", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    for (const [zone, expectAp] of [
      [1, 5],
      [2, 6],
      [3, 7],
      [4, 8],
      [5, 8],
    ] as [number, number][]) {
      gz.generate([zone]);
      expect(gz.stepRemain, `zone ${zone} 行动力`).toBe(expectAp);
    }
  });

  it("步进消耗行动力（grid:step）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    gz.generate([1]);
    expect(gz.stepRemain).toBe(5);
    await player.rlv2._trigger.emit("rlv2:grid:step", []);
    expect(gz.stepRemain).toBe(4);
  });

  it("点亮【生命游戏】翅膀节点（rogue_6_outbuff_37）后 Ⅰ 层行动力 6", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    player.rlv2.outer.rogue_6.buff = asModel<PlayerRoguelikeV2.OuterData.Buff>({
      unlocked: { rogue_6_outbuff_37: 1 },
    });
    gz.generate([1]);
    expect(gz.stepRemain).toBe(6);
  });

  it("SPECIAL_ZONE_AP 物品获得 → 当前区域行动力 +N（安全的角落/休息选项）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    gz.generate([3]); // 行动力 7
    expect(gz.stepRemain).toBe(7);
    await player.rlv2._trigger.emit("rlv2:get:items", [
      [{ id: "rogue_6_ap", count: 2, sub: 0 }],
    ]);
    expect(gz.stepRemain).toBe(9);
  });

  it("襁褓天马（rogue_6_start_1，zone_into_reward）→ 进入对应区域时行动力 +1", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    // 获得襁褓天马（startbuff_7 选择 → relic.gain → zone_into_reward 进 buffs）
    await player.rlv2._trigger.emit("rlv2:relic:gain", [
      { id: "rogue_6_start_1", count: 1 },
    ]);
    // 进入 zone_1（匹配 zone_1，rlv2:zone:new → map.generate 发 1 行动力物品）→ stepRemain 5+1=6
    await player.rlv2._trigger.emit("rlv2:zone:new", [1]);
    await new Promise((r) => setTimeout(r, 0));
    expect(gz.stepRemain).toBe(6);
    // 进入 zone_2（无 zone_2 buff）→ 基础 6，不额外 +1
    await player.rlv2._trigger.emit("rlv2:zone:new", [2]);
    await new Promise((r) => setTimeout(r, 0));
    expect(gz.stepRemain).toBe(6);
  });
});

describe("rogue_6 常规区域实托邦（variation）", () => {
  it("难度 <2 不生成实托邦", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer(1);
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([3]);
      const mapZone = player.rlv2._map.zones["1002"];
      expect(mapZone.variation).toEqual([]);
    });
  });

  it("难度 2+ 生成实托邦（random=0 < 0.25）", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer(2);
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([3]);
      const mapZone = player.rlv2._map.zones["1002"];
      expect(mapZone.variation.length).toBe(1);
      expect(mapZone.variation[0]).toMatch(/^variation_\d+$/);
    });
  });

  it("难度 12+ 同样生成（晚期档）", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer(12);
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([4]);
      const mapZone = player.rlv2._map.zones["1003"];
      expect(mapZone.variation.length).toBe(1);
    });
  });

  it("结局层（zone 6）不生成实托邦", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer(15);
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([6]);
      const mapZone = player.rlv2._map.zones["1005"];
      expect(mapZone.variation).toEqual([]);
    });
  });
});

describe("rogue_6 误入奇境（MIRAGE → 隐藏层）", () => {
  it("MIRAGE 节点进入生成 portal 场景（SCENE pending）", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([3]);
      // 在 zone 3 放一个 MIRAGE 节点并落点（改内部节点，非 toJSON 拷贝）
      const inner = gz.zones["zone_3"].nodes;
      const someId = Object.keys(inner)[0];
      inner[someId].content = { kind: 8192 };
      player.rlv2._status.cursor.zone = 3;
      player.rlv2._status.cursor.position = {
        x: Math.floor(Number(someId) / 100),
        y: Number(someId) % 100,
      };
      await player.rlv2.gridZoneMoveTo({ route: [someId] });
      const pending = player.rlv2._status.pending;
      expect(pending.length).toBeGreaterThan(0);
      expect(pending[0].type).toBe("SCENE");
      expect(pending[0].content.scene!.id).toMatch(/^scene_ro6_portal\d+[ab]?_enter$/);
      // 选项含消耗加工品进入/离开
      expect(Object.keys(pending[0].content.scene!.choices)).toContain("choice_ro6_portal1a_1");
      expect(Object.keys(pending[0].content.scene!.choices)).toContain("choice_ro6_portal1a_6");
    });
  });

  it("选择 _1（消耗 1 件加工品）→ 进入隐藏层：portal active、行动力=2、乌托邦 variation", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([3]);
      player.rlv2._status.cursor.zone = 3;
      player.rlv2._status.cursor.position = { x: 2, y: 1 };
      // 零件箱初始 2 件加工品（s_1/s_2）
      const scrap = player.rlv2._module.scrap;
      expect(Object.keys(scrap.inventory).length).toBe(2);

      await player.rlv2.selectChoice({ choice: "choice_ro6_portal1a_1" });

      // 消耗 1 件加工品
      expect(Object.keys(scrap.inventory).length).toBe(1);
      // portal 激活：隐藏层行动力 2、乌托邦效果 variation_1、返回点 zone 3 位置 201
      expect(gz.portal).toBeTruthy();
      expect(gz.stepRemain).toBe(2);
      expect(gz.portal!.variation).toBe("variation_1");
      expect(gz.portal!.returnZone).toBe(3);
      expect(gz.portal!.returnNode).toBe("201");
      // map.zones 有 portal 键（3000+）且带 variation
      const map = player.rlv2._map.zones;
      const pZone = map[gz.portal!.zoneKey];
      expect(pZone).toBeTruthy();
      expect(pZone.variation).toEqual(["variation_1"]);
      // 当前节点 = 隐藏层起点
      expect(player.rlv2._status.cursor.position).toEqual({ x: 3, y: 0 });
    });
  });

  it("选择 _5（无可用加工品）→ 节点结束（WAIT_MOVE，不进入隐藏层）", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([3]);
      player.rlv2._status.cursor.zone = 3;
      // 清空零件箱（无加工品）
      const scrap = player.rlv2._module.scrap;
      scrap.inventory = {};
      await player.rlv2.selectChoice({ choice: "choice_ro6_portal1a_5" });
      expect(gz.portal).toBeFalsy();
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
    });
  });

  it("行动力耗尽 → 返回进入时节点（zone/position 恢复）", async () => {
    await withFixedRandom(async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const gz = player.rlv2._module.gridZone;
      gz.generate([3]);
      player.rlv2._status.cursor.zone = 3;
      player.rlv2._status.cursor.position = { x: 2, y: 1 };
      await player.rlv2.selectChoice({ choice: "choice_ro6_portal1a_4" });
      expect(gz.portal).toBeTruthy();
      expect(gz.stepRemain).toBe(2);

      // 在隐藏层移动：第 1 步 2→1（仍在），第 2 步 1→0（行动力耗尽 → 返回）
      await player.rlv2._trigger.emit("rlv2:grid:step", []);
      expect(gz.portal).toBeTruthy();
      expect(gz.stepRemain).toBe(1);
      await player.rlv2._trigger.emit("rlv2:grid:step", []);
      // 返回：portal 清空、恢复 zone 3 / 位置 201、行动力恢复区域初始值 7
      expect(gz.portal).toBeFalsy();
      expect(player.rlv2._status.cursor.zone).toBe(3);
      expect(player.rlv2._status.cursor.position).toEqual({ x: 2, y: 1 });
      expect(gz.stepRemain).toBe(7);
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
      // portal zone 已从 map 移除
      expect(player.rlv2._map.zones["3000"]).toBeFalsy();
    });
  });
});
