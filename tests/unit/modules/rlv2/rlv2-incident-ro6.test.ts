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

// ===== rogue_6（黑流树海）不期而遇完整事件引擎回归 =====
// 覆盖（对照 prts.wiki「沉沦者的黑流树海/事件一览」）：
// 1. 事件池：层数限制 / 非重复事件只出现一次 / 前置条件（normal3 ← normal1）
// 2. 资源事件：res1 希望 / res5 敲一次（扣金+随机藏品）
// 3. 剧情链：normal1 沉寂之屋（扣血+笼控器）→ normal2 黑诞（笼控器门槛 + 追猎战）
// 4. 战斗事件：bat1 思乡心切（子幕战斗选项 → ro6_t_1）
// 5. 随机分支：bat6 洞中宝（掏洞随机 + 多轮链）
// 6. 门槛选项：bat4_2 仅持有超过 50 源石锭出现
// 7. 三结局标记事件：chimera2 泪之聚落（需怦然信标，消耗全部源石锭得击坠“神明”）
// 8. 被歌颂的影子（normal4）多圈舞蹈链推进
//
// 选池确定性说明：createIncident 从过滤后的候选池按 Math.random 抽取；
// 可重复事件（res2/res3/res5/bat6）不受遭遇记录排除，故各用例按
// 「候选顺序 + 固定随机值」锁定目标事件（候选顺序 = event_choices.json 声明序）。
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
          ro6_n_4_1: { id: "ro6_n_4_1" },
          ro6_t_1: { id: "ro6_t_1", name: "陌生旅伴" },
          ro6_t_13: { id: "ro6_t_13", name: "“闹乐”" },
          ro6_t_14: { id: "ro6_t_14", name: "“纵怒”" },
          ro6_t_15: { id: "ro6_t_15", name: "“灭身”" },
        },
        items: {
          rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: 0 },
          rogue_6_hp: { id: "rogue_6_hp", type: "HP", rarity: 0 },
          rogue_6_hpmax: { id: "rogue_6_hpmax", type: "HPMAX", rarity: 0 },
          rogue_6_population: { id: "rogue_6_population", type: "POPULATION", rarity: 0 },
          rogue_6_ap: { id: "rogue_6_ap", type: "SPECIAL_ZONE_AP", rarity: 0 },
          rogue_6_shield: { id: "rogue_6_shield", type: "SHIELD", rarity: 0 },
          rogue_6_squad_capacity: { id: "rogue_6_squad_capacity", type: "SQUAD_CAPACITY", rarity: 0 },
          rogue_6_scrap_G_01: { id: "rogue_6_scrap_G_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_G_12: { id: "rogue_6_scrap_G_12", type: "SCRAP", rarity: "SUPER_RARE" },
          rogue_6_scrap_M_01: { id: "rogue_6_scrap_M_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_P_01: { id: "rogue_6_scrap_P_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_relic_a: { id: "rogue_6_relic_a", type: "RELIC", rarity: "NORMAL" },
          rogue_6_relic_b: { id: "rogue_6_relic_b", type: "RELIC", rarity: "RARE" },
          rogue_6_relic_cargo_12: { id: "rogue_6_relic_cargo_12", type: "RELIC", rarity: "NORMAL" },
          rogue_6_relic_cargo_13: { id: "rogue_6_relic_cargo_13", type: "RELIC", rarity: "SUPER_RARE" },
          rogue_6_relic_final_3: { id: "rogue_6_relic_final_3", type: "RELIC", rarity: "SUPER_RARE" },
          rogue_6_relic_final_4: { id: "rogue_6_relic_final_4", type: "RELIC", rarity: "SUPER_RARE" },
        },
        relics: {
          rogue_6_relic_a: { id: "rogue_6_relic_a", buffs: [] },
          rogue_6_relic_b: { id: "rogue_6_relic_b", buffs: [] },
          rogue_6_relic_cargo_12: { id: "rogue_6_relic_cargo_12", buffs: [] },
          rogue_6_relic_cargo_13: { id: "rogue_6_relic_cargo_13", buffs: [] },
          rogue_6_relic_final_3: { id: "rogue_6_relic_final_3", buffs: [] },
          rogue_6_relic_final_4: { id: "rogue_6_relic_final_4", buffs: [] },
        },
        choices: {
          choice_ro6_res1_1: {
            id: "choice_ro6_res1_1",
            type: "TRADE",
            description: "获得<@ro6.get>3</>希望",
            displayData: { itemID: "rogue_6_population" },
            nextSceneId: "scene_ro6_res1_1",
          },
          choice_ro6_res5_1: {
            id: "choice_ro6_res5_1",
            type: "TRADE",
            description: "消耗<@ro6.lose>4</>源石锭，获得<@ro6.get>1件</>随机收藏品",
            displayData: {},
            nextSceneId: "scene_ro6_res5_1",
          },
          choice_ro6_normal1_1: {
            id: "choice_ro6_normal1_1",
            type: "TRADE",
            description: "消耗<@ro6.lose>2</>目标生命值，获得<@ro6.get>笼控器</>",
            displayData: { type: "ITEM", itemID: "rogue_6_scrap_G_12" },
            nextSceneId: "scene_ro6_normal1_1",
          },
          choice_ro6_normal2_1: {
            id: "choice_ro6_normal2_1",
            type: "TRADE",
            description: "持有笼控器，获得收藏品<@ro6.get>猎印</>",
            displayData: { type: "ITEM", itemID: "rogue_6_relic_cargo_12" },
            nextSceneId: "scene_ro6_normal2_1",
          },
          choice_ro6_normal2_2: {
            id: "choice_ro6_normal2_2",
            type: "TRADE_PROB",
            description: "遭遇一场艰难的特殊作战",
            displayData: {},
            nextSceneId: null,
          },
          choice_ro6_normal2_3: {
            id: "choice_ro6_normal2_3",
            type: "TRADE",
            description: "消耗<@ro6.lose>3</>目标生命值（至少保留1目标生命值）",
            displayData: {},
            nextSceneId: "scene_ro6_normal2_2",
          },
          choice_ro6_normal4_1: {
            id: "choice_ro6_normal4_1",
            type: "NEXT_PROB",
            description: "消耗<@ro6.lose>1</>目标生命值",
            displayData: {},
            nextSceneId: "scene_ro6_normal4_1",
          },
          choice_ro6_normal4_2: {
            id: "choice_ro6_normal4_2",
            type: "NEXT",
            description: "多一事不如少一事",
            displayData: {},
            nextSceneId: "scene_ro6_normal4_2",
          },
          choice_ro6_normal4_3: {
            id: "choice_ro6_normal4_3",
            type: "TRADE",
            description: "获得<@ro6.get>4</>源石锭",
            displayData: { itemID: "rogue_6_gold" },
            nextSceneId: "scene_ro6_normal4_4",
          },
          choice_ro6_bat1_1: {
            id: "choice_ro6_bat1_1",
            type: "NEXT",
            description: "我也迷路了！管不了你！",
            displayData: {},
            nextSceneId: "scene_ro6_bat1_1",
          },
          choice_ro6_bat1_3: {
            id: "choice_ro6_bat1_3",
            type: "TRADE",
            description: "遭遇一场特殊的战斗",
            displayData: {},
            nextSceneId: null,
          },
          choice_ro6_bat4_2: {
            id: "choice_ro6_bat4_2",
            type: "NEXT",
            description: "遭遇一场艰难的战斗",
            displayData: {},
            nextSceneId: "scene_ro6_bat4_2",
          },
          choice_ro6_bat4_4: {
            id: "choice_ro6_bat4_4",
            type: "NEXT",
            description: "消耗一半的源石锭逃跑",
            displayData: {},
            nextSceneId: "scene_ro6_bat4_3",
          },
          choice_ro6_bat6_1: {
            id: "choice_ro6_bat6_1",
            type: "NEXT_PROB",
            description: "掏一下",
            displayData: {},
            nextSceneId: null,
          },
          choice_ro6_bat6_3: {
            id: "choice_ro6_bat6_3",
            type: "TRADE",
            description: "获得<@ro6.get>5</>源石锭",
            displayData: { itemID: "rogue_6_gold" },
            nextSceneId: "scene_ro6_bat6_6",
          },
          choice_ro6_chimera2_1: {
            id: "choice_ro6_chimera2_1",
            type: "TRADE",
            description: "消耗<@ro6.lose>全部</>源石锭，获得收藏品<@ro6.get>击坠“神明”</>",
            displayData: { type: "ITEM", itemID: "rogue_6_relic_final_4" },
            nextSceneId: "scene_ro6_chimera2_1",
          },
          choice_ro6_chimera2_2: {
            id: "choice_ro6_chimera2_2",
            type: "NEXT",
            description: "多一事不如少一事",
            displayData: {},
            nextSceneId: "scene_ro6_chimera2_2",
          },
        },
        choiceScenes: {},
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["GRID_ZONE", "SCRAP"],
        scrap: {
          moduleConsts: { identifyScrapId: "rogue_6_scrap_G_01" },
          scrapItemToType: {
            rogue_6_scrap_G_01: "GOODS",
            rogue_6_scrap_G_12: "GOODS",
            rogue_6_scrap_M_01: "MOVE",
            rogue_6_scrap_P_01: "PASSIVE",
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
import type {
  PlayerRoguelikePendingEvent,
  PlayerRoguelikeV2,
  PlayerRoguelikeV2Zone,
} from "@game/modules/roguelike/rlv2-model";
import { asModel, mockPlayerData } from "../../../helpers";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/**
 * rogue_6 事件配置增量段视图
 *
 * `RoguelikeV2Config.eventChoices` 仅建模各主题公共的 enter/choices 两键，本用例
 * 用到的 `incidents`（事件池与重复标记）是 data/rlv2/event_choices.json 的增量段
 * （生产侧 incident.ts 有同名视图）。真实类型可赋给本视图（本视图键全可选），
 * 故单点断言成立。
 */
interface Ro6EventChoicesFixture {
  incidents?: { [sceneId: string]: { repeat?: boolean } };
}

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
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme: "rogue_6",
    mode: "NORMAL",
    modeGrade: 0,
  });
  return player;
}

async function setupGame(player: PlayerDataManager, zone: number) {
  await player.rlv2._module.create();
  await player.rlv2._pool.create();
  player.rlv2._status.cursor.zone = zone;
  player.rlv2._status.cursor.position = { x: 2, y: 1 };
  // 黑流树海常规层地图键为 1000+（与 grid_zone 对齐），供战斗节点 stage 标记
  player.rlv2._map.zones = asModel<{ [key: string]: PlayerRoguelikeV2Zone }>({
    [String(1000 + zone - 1)]: { nodes: { 201: { type: 32 } } },
  });
  // 初始状态：8 金 / 8 生命（常规行动官方初始）
  player.rlv2._status.property.gold = 8;
  player.rlv2._status.property.hp = { current: 8, max: 8 };
}

/**
 * 把事件池里除 target 外的非重复事件全部标记为已遭遇。
 * 可重复事件（res2/res3/res5/bat6）不受排除，调用方需按候选顺序配合固定随机值。
 */
function forceIncident(player: PlayerDataManager, target: string) {
  const data = player.rlv2._data.eventChoices
    .rogue_6 as Ro6EventChoicesFixture;
  const incidents = data.incidents!;
  const game = player.rlv2.current.game!;
  game.incidentSeen = Object.keys(incidents).filter(
    (id) => id !== target && !incidents[id].repeat,
  );
}

async function withRandom(v: number, fn: () => Promise<void> | void) {
  const spy = vi.spyOn(Math, "random").mockReturnValue(v);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

function pendingScene(player: PlayerDataManager): PlayerRoguelikePendingEvent.SceneContent {
  const p = player.rlv2._status.pending;
  expect(p.length).toBeGreaterThan(0);
  expect(p[0].type).toBe("SCENE");
  return p[0].content.scene!;
}

function relicsOf(player: PlayerDataManager): string[] {
  return Object.values(player.rlv2.inventory!.relic).map((r) => r.id);
}

function scrapIds(player: PlayerDataManager): string[] {
  return Object.values(player.rlv2._module.scrap.inventory).map(
    (it) => it.id,
  );
}

describe("rogue_6 不期而遇·事件池", () => {
  it("Ⅰ 层抽中 Ⅰ 层事件（res1）；遭遇后记入 seen", async () => {
    const player = makePlayer();
    await setupGame(player, 1);
    // 候选（zone1，非重复仅余 res1）：[res1, res2, res5] → random=0 必中 res1
    forceIncident(player, "scene_ro6_res1_enter");
    await withRandom(0, async () => {
      expect(await player.rlv2.createIncidentScene()).toBe(true);
    });
    expect(pendingScene(player).id).toBe("scene_ro6_res1_enter");
    expect(Object.keys(pendingScene(player).choices)).toEqual([
      "choice_ro6_res1_1",
      "choice_ro6_res1_2",
    ]);
    expect(player.rlv2.current.game!.incidentSeen).toContain(
      "scene_ro6_res1_enter",
    );
  });

  it("chimera2（泪之聚落）仅在持有怦然信标时进入池", async () => {
    const player = makePlayer();
    await setupGame(player, 3);
    forceIncident(player, "scene_ro6_chimera2_enter");
    // 无怦然信标：chimera2 被 requireRelic 过滤 → 抽中的是可重复事件而非泪之聚落
    await withRandom(0.99, async () => {
      expect(await player.rlv2.createIncidentScene()).toBe(true);
    });
    expect(pendingScene(player).id).not.toBe("scene_ro6_chimera2_enter");
    // 持有怦然信标：候选 [res3, res5, bat6, chimera2] → random=0.99 必中末位
    const player2 = makePlayer();
    await setupGame(player2, 3);
    forceIncident(player2, "scene_ro6_chimera2_enter");
    player2.rlv2.inventory!._relic.relics["r_0"] = {
      index: "r_0",
      id: "rogue_6_relic_final_3",
      count: 1,
      ts: 0,
    };
    await withRandom(0.99, async () => {
      expect(await player2.rlv2.createIncidentScene()).toBe(true);
    });
    expect(pendingScene(player2).id).toBe("scene_ro6_chimera2_enter");
  });

  it("呼吸的红苔（normal3）仅在遭遇过沉寂之屋（normal1）后出现", async () => {
    const player = makePlayer();
    await setupGame(player, 2);
    forceIncident(player, "scene_ro6_normal3_enter");
    // forceIncident 把其余非重复事件（含前置 normal1）全部标记已遭遇；
    // 负向验证需把 normal1 从记录中移除 → normal3 被 requireScene 过滤，
    // 候选仅剩 [res2, res3, res5]，random=0.99 → idx2=res5
    const game = player.rlv2.current.game!;
    game.incidentSeen = game.incidentSeen!.filter(
      (s) => s !== "scene_ro6_normal1_enter",
    );
    await withRandom(0.99, async () => {
      expect(await player.rlv2.createIncidentScene()).toBe(true);
    });
    expect(pendingScene(player).id).not.toBe("scene_ro6_normal3_enter");
    // 记录 normal1 后：候选 [res2, res3, res5, normal3]（bat1 等非重复已排除，
    // normal3 在声明序中位于 res5 之后）→ random=0.99 必中末位
    const player2 = makePlayer();
    await setupGame(player2, 2);
    forceIncident(player2, "scene_ro6_normal3_enter");
    const game2 = player2.rlv2.current.game!;
    game2.incidentSeen!.push("scene_ro6_normal1_enter");
    await withRandom(0.99, async () => {
      expect(await player2.rlv2.createIncidentScene()).toBe(true);
    });
    expect(pendingScene(player2).id).toBe("scene_ro6_normal3_enter");
  });
});

describe("rogue_6 不期而遇·资源/剧情事件结算", () => {
  it("桑尼的邀请：帮它梳理绒毛 → +3 希望 → 子幕 → 离开", async () => {
    const player = makePlayer();
    await setupGame(player, 1);
    forceIncident(player, "scene_ro6_res1_enter");
    await withRandom(0, async () => {
      await player.rlv2.createIncidentScene();
    });
    const popBefore = player.rlv2._status.property.population.max;
    await player.rlv2.selectChoice({ choice: "choice_ro6_res1_1" });
    expect(player.rlv2._status.property.population.max).toBe(popBefore + 3);
    const scene = pendingScene(player);
    expect(scene.id).toBe("scene_ro6_res1_1");
    expect(Object.keys(scene.choices)).toEqual(["choice_leave"]);
    await player.rlv2.selectChoice({ choice: "choice_leave" });
    expect(player.rlv2._status.state).toBe("WAIT_MOVE");
  });

  it("敲动杠杆：敲一次 → 扣 4 源石锭 + 随机 1 件收藏品", async () => {
    const player = makePlayer();
    await setupGame(player, 1);
    // 候选 [res2, res5] → random=0.6 必中 res5
    forceIncident(player, "scene_ro6_res5_enter");
    await withRandom(0.6, async () => {
      await player.rlv2.createIncidentScene();
    });
    await withRandom(0, async () => {
      await player.rlv2.selectChoice({ choice: "choice_ro6_res5_1" });
    });
    expect(player.rlv2._status.property.gold).toBe(4);
    expect(relicsOf(player).length).toBe(1);
  });

  it("沉寂之屋：清理藤蔓 → 扣 2 目标生命值 + 笼控器入零件箱，并记录前置", async () => {
    const player = makePlayer();
    await setupGame(player, 1);
    // 候选 [res2, res5, normal1] → random=0.99 必中末位
    forceIncident(player, "scene_ro6_normal1_enter");
    await withRandom(0.99, async () => {
      await player.rlv2.createIncidentScene();
    });
    await player.rlv2.selectChoice({ choice: "choice_ro6_normal1_1" });
    expect(player.rlv2._status.property.hp.current).toBe(6);
    expect(scrapIds(player)).toContain("rogue_6_scrap_G_12");
    expect(player.rlv2.current.game!.incidentSeen).toContain(
      "scene_ro6_normal1_enter",
    );
  });

  it("黑诞：未持有笼控器时'掏出笼控器'选项不出现；战斗选项进入追猎战", async () => {
    const player = makePlayer();
    await setupGame(player, 3);
    // 候选 [res3, res5, bat6, normal2] → random=0.99 必中末位
    forceIncident(player, "scene_ro6_normal2_enter");
    await withRandom(0.99, async () => {
      await player.rlv2.createIncidentScene();
    });
    expect(Object.keys(pendingScene(player).choices)).not.toContain(
      "choice_ro6_normal2_1",
    );
    // 战斗到底 → 追猎可遭遇关卡（闹乐/纵怒/灭身）之一
    await withRandom(0, async () => {
      await player.rlv2.selectChoice({ choice: "choice_ro6_normal2_2" });
    });
    const p = player.rlv2._status.pending;
    expect(p[0].type).toBe("BATTLE");
    expect(player.rlv2._map.zones["1002"].nodes[201].stage).toBe("ro6_t_13");
  });

  it("泪之聚落：倾囊资助 → 源石锭清零 + 获得击坠“神明”", async () => {
    const player = makePlayer();
    await setupGame(player, 3);
    player.rlv2._status.property.gold = 66;
    player.rlv2.inventory!._relic.relics["r_0"] = {
      index: "r_0",
      id: "rogue_6_relic_final_3",
      count: 1,
      ts: 0,
    };
    // 候选 [res3, res5, bat6, chimera2] → random=0.99 必中末位
    forceIncident(player, "scene_ro6_chimera2_enter");
    await withRandom(0.99, async () => {
      await player.rlv2.createIncidentScene();
    });
    await player.rlv2.selectChoice({ choice: "choice_ro6_chimera2_1" });
    expect(player.rlv2._status.property.gold).toBe(0);
    expect(relicsOf(player)).toContain("rogue_6_relic_final_4");
  });
});

describe("rogue_6 不期而遇·战斗/随机链", () => {
  it("思乡心切：赶跑它 → 子幕'强行驱赶' → 战斗（ro6_t_1 陌生旅伴）", async () => {
    const player = makePlayer();
    await setupGame(player, 1);
    // 候选 [res2, res5, bat1] → random=0.99 必中末位
    forceIncident(player, "scene_ro6_bat1_enter");
    await withRandom(0.99, async () => {
      await player.rlv2.createIncidentScene();
    });
    await player.rlv2.selectChoice({ choice: "choice_ro6_bat1_1" });
    const scene = pendingScene(player);
    expect(scene.id).toBe("scene_ro6_bat1_1");
    expect(Object.keys(scene.choices)).toEqual(["choice_ro6_bat1_3"]);
    await player.rlv2.selectChoice({ choice: "choice_ro6_bat1_3" });
    expect(player.rlv2._status.pending[0].type).toBe("BATTLE");
    expect(player.rlv2._map.zones["1000"].nodes[201].stage).toBe("ro6_t_1");
  });

  it("传奇团伙：源石锭 ≤50 时'扎穿货车车胎'不出现，>50 时出现；求饶扣一半源石锭", async () => {
    const player = makePlayer();
    await setupGame(player, 4);
    player.rlv2._status.property.gold = 50;
    // 候选 [res3, res5, bat6, bat4] → random=0.99 必中末位
    forceIncident(player, "scene_ro6_bat4_enter");
    await withRandom(0.99, async () => {
      await player.rlv2.createIncidentScene();
    });
    expect(Object.keys(pendingScene(player).choices)).not.toContain(
      "choice_ro6_bat4_2",
    );
    await player.rlv2.selectChoice({ choice: "choice_ro6_bat4_4" });
    expect(player.rlv2._status.property.gold).toBe(25);
    // 金币充足时车胎选项出现
    const player2 = makePlayer();
    await setupGame(player2, 4);
    player2.rlv2._status.property.gold = 51;
    forceIncident(player2, "scene_ro6_bat4_enter");
    // 候选（声明序）[res3, res5, bat4, bat6] → random=0.6 命中 idx2=bat4
    await withRandom(0.6, async () => {
      await player2.rlv2.createIncidentScene();
    });
    expect(Object.keys(pendingScene(player2).choices)).toContain(
      "choice_ro6_bat4_2",
    );
  });

  it("洞中宝：掏一下 → 随机一幕；乌鸦的宝贝 → +5 金 → 呼噜噜续掏幕", async () => {
    const player = makePlayer();
    await setupGame(player, 3);
    // 候选 [res3, res5, bat6] → random=0.99 必中末位
    forceIncident(player, "scene_ro6_bat6_enter");
    await withRandom(0.99, async () => {
      await player.rlv2.createIncidentScene();
    });
    // 掏一下：随机分支第一个场景（乌鸦的宝贝）
    await withRandom(0, async () => {
      await player.rlv2.selectChoice({ choice: "choice_ro6_bat6_1" });
    });
    expect(pendingScene(player).id).toBe("scene_ro6_bat6_2");
    const goldBefore = player.rlv2._status.property.gold;
    await player.rlv2.selectChoice({ choice: "choice_ro6_bat6_3" });
    expect(player.rlv2._status.property.gold).toBe(goldBefore + 5);
    const scene = pendingScene(player);
    expect(scene.id).toBe("scene_ro6_bat6_6");
    expect(Object.keys(scene.choices)).toEqual([
      "choice_ro6_bat6_7",
      "choice_ro6_bat6_8",
    ]);
  });

  it("被歌颂的影子：加入 → 第一圈奖励幕 → 收下 4 源石锭 → 第二圈邀请幕", async () => {
    const player = makePlayer();
    await setupGame(player, 2);
    // 候选 [res2, res3, res5, normal4] → random=0.99 必中末位
    forceIncident(player, "scene_ro6_normal4_enter");
    await withRandom(0.99, async () => {
      await player.rlv2.createIncidentScene();
    });
    const hpBefore = player.rlv2._status.property.hp.current;
    await player.rlv2.selectChoice({ choice: "choice_ro6_normal4_1" });
    expect(player.rlv2._status.property.hp.current).toBe(hpBefore - 1);
    expect(pendingScene(player).id).toBe("scene_ro6_normal4_1");
    const goldBefore = player.rlv2._status.property.gold;
    await player.rlv2.selectChoice({ choice: "choice_ro6_normal4_3" });
    expect(player.rlv2._status.property.gold).toBe(goldBefore + 4);
    const scene = pendingScene(player);
    expect(scene.id).toBe("scene_ro6_normal4_4");
    expect(Object.keys(scene.choices)).toEqual([
      "choice_ro6_normal4_5",
      "choice_ro6_normal4_8",
    ]);
  });
});
