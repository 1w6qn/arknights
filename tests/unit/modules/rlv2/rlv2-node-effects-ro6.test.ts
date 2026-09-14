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

// ===== rogue_6（黑流树海）非战斗节点完整效果回归 =====
// 对照 prts.wiki「沉沦者的黑流树海」事件节点节：
// 1. 安全的角落：6 选项随机出 3；效果发放（生命上限等）；子幕"离开"收尾
// 2. 得偿所愿：免费收藏品；撬桶消耗 4 源石锭换更高稀有度陈列；推轮子需四叶草化石
// 3. 失与得：藏品交换；持怦然信标进入"复原文明"差分（耗 2 随机自然物 → 焚毁"文明"）
// 4. 险路尽头：+1 加工品 + 全部行动力转希望 → 进区；召集同伴（留存券）
// 5. 险路小径：+1 珍贵加工品 + 保留行动力进区（三重身差分）
// 6. 先行一步：休息 +2 希望；远征标记（三结局）保持
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
          ro6_n_2_1: { id: "ro6_n_2_1" },
          ro6_n_3_1: { id: "ro6_n_3_1" },
        },
        init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
        items: {
          rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: 0 },
          rogue_6_hp: { id: "rogue_6_hp", type: "HP", rarity: 0 },
          rogue_6_hpmax: { id: "rogue_6_hpmax", type: "HPMAX", rarity: 0 },
          rogue_6_population: { id: "rogue_6_population", type: "POPULATION", rarity: 0 },
          rogue_6_ap: { id: "rogue_6_ap", type: "SPECIAL_ZONE_AP", rarity: 0 },
          rogue_6_squad_capacity: { id: "rogue_6_squad_capacity", type: "SQUAD_CAPACITY", rarity: 0 },
          rogue_6_max_weight: { id: "rogue_6_max_weight", type: "MAX_WEIGHT", rarity: 0 },
          rogue_6_scrap_M_01: { id: "rogue_6_scrap_M_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_G_01: { id: "rogue_6_scrap_G_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_G_02: { id: "rogue_6_scrap_G_02", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_relic_a: { id: "rogue_6_relic_a", type: "RELIC", rarity: "NORMAL", canSacrifice: true, value: 8 },
          rogue_6_relic_b: { id: "rogue_6_relic_b", type: "RELIC", rarity: "RARE", canSacrifice: true, value: 12 },
          rogue_6_relic_c: { id: "rogue_6_relic_c", type: "RELIC", rarity: "SUPER_RARE" },
          rogue_6_relic_final_3: { id: "rogue_6_relic_final_3", type: "RELIC", rarity: "SUPER_RARE" },
          rogue_6_relic_final_6: { id: "rogue_6_relic_final_6", type: "RELIC", rarity: "SUPER_RARE" },
          rogue_6_relic_legacy_113: { id: "rogue_6_relic_legacy_113", type: "RELIC", rarity: "NORMAL" },
        },
        relics: {
          rogue_6_relic_a: { id: "rogue_6_relic_a", buffs: [] },
          rogue_6_relic_b: { id: "rogue_6_relic_b", buffs: [] },
          rogue_6_relic_c: { id: "rogue_6_relic_c", buffs: [] },
          rogue_6_relic_final_3: { id: "rogue_6_relic_final_3", buffs: [] },
          rogue_6_relic_final_6: { id: "rogue_6_relic_final_6", buffs: [] },
          rogue_6_relic_legacy_113: { id: "rogue_6_relic_legacy_113", buffs: [] },
        },
        choices: {
          choice_ro6_rest_1: {
            id: "choice_ro6_rest_1",
            type: "TRADE",
            description: "获得<@ro6.get>3</>目标生命值上限",
            displayData: { itemID: "rogue_6_hpmax" },
            nextSceneId: "scene_ro6_rest_1",
          },
          choice_ro6_rest_2: {
            id: "choice_ro6_rest_2",
            type: "TRADE",
            description: "可携带干员<@ro6.get>+1</>",
            displayData: { itemID: "rogue_6_squad_capacity" },
            nextSceneId: "scene_ro6_rest_2",
          },
          choice_ro6_rest_3: {
            id: "choice_ro6_rest_3",
            type: "TRADE",
            description: "获得<@ro6.get>3</>希望",
            displayData: { itemID: "rogue_6_population" },
            nextSceneId: "scene_ro6_rest_3",
          },
          choice_ro6_rest_4: {
            id: "choice_ro6_rest_4",
            type: "TRADE",
            description: "获得高级物资配给券",
            displayData: { itemID: "rogue_6_upgrade_ticket_all" },
            nextSceneId: "scene_ro6_rest_4",
          },
          choice_ro6_rest_5: {
            id: "choice_ro6_rest_5",
            type: "TRADE",
            description: "获得<@ro6.get>2</>行动力",
            displayData: { itemID: "rogue_6_ap" },
            nextSceneId: "scene_ro6_rest_5",
          },
          choice_ro6_rest_6: {
            id: "choice_ro6_rest_6",
            type: "TRADE",
            description: "零件箱容量<@ro6.get>+1</>",
            displayData: { itemID: "rogue_6_max_weight" },
            nextSceneId: "scene_ro6_rest_6",
          },
          choice_ro6_wish_1: { id: "choice_ro6_wish_1", type: "TRADE_PROB_SHOW", description: "获得1件收藏品", displayData: {}, nextSceneId: "scene_ro6_wish_1" },
          choice_ro6_wish_2: { id: "choice_ro6_wish_2", type: "TRADE_PROB_SHOW", description: "获得1件收藏品", displayData: {}, nextSceneId: "scene_ro6_wish_1" },
          choice_ro6_wish_3: { id: "choice_ro6_wish_3", type: "TRADE", description: "消耗<@ro6.lose>4</>源石锭，换一批更高级的收藏品", displayData: {}, nextSceneId: "scene_ro6_wish_2" },
          choice_ro6_wish_4: { id: "choice_ro6_wish_4", type: "TRADE_PROB_SHOW", description: "获得1件收藏品", displayData: {}, nextSceneId: "scene_ro6_wish_1" },
          choice_ro6_wish_5: { id: "choice_ro6_wish_5", type: "TRADE_PROB_SHOW", description: "获得1件收藏品", displayData: {}, nextSceneId: "scene_ro6_wish_1" },
          choice_ro6_wish_6: { id: "choice_ro6_wish_6", type: "TRADE_PROB_SHOW", description: "持有四叶草化石，获得1件收藏品", displayData: {}, nextSceneId: "scene_ro6_wish_1" },
          choice_ro6_sacrifice1_1: { id: "choice_ro6_sacrifice1_1", type: "SACRIFICE", description: "拿出珍藏赞助研究", displayData: {}, nextSceneId: null },
          choice_ro6_sacrifice1_5: { id: "choice_ro6_sacrifice1_5", type: "NEXT", description: "多一事不如少一事", displayData: {}, nextSceneId: "scene_ro6_sacrifice1_5" },
          choice_ro6_sacrifice1_6: { id: "choice_ro6_sacrifice1_6", type: "SACRIFICE", description: "看看还能有什么把戏", displayData: {}, nextSceneId: null },
          choice_ro6_sacrifice1_10: { id: "choice_ro6_sacrifice1_10", type: "NEXT", description: "见好就收", displayData: {}, nextSceneId: "scene_ro6_sacrifice1_10" },
          choice_ro6_sacrifice1_11: { id: "choice_ro6_sacrifice1_11", type: "SACRIFICE", description: "拿出工具赞助研究", displayData: {}, nextSceneId: null },
          choice_ro6_sacrifice2_1: { id: "choice_ro6_sacrifice2_1", type: "SACRIFICE", description: "拿出珍藏赞助研究", displayData: {}, nextSceneId: null },
          choice_ro6_sacrifice2_5: { id: "choice_ro6_sacrifice2_5", type: "NEXT", description: "多一事不如少一事", displayData: {}, nextSceneId: "scene_ro6_sacrifice2_5" },
          choice_ro6_sacrifice2_11: { id: "choice_ro6_sacrifice2_11", type: "SACRIFICE", description: "拿出工具赞助研究", displayData: {}, nextSceneId: null },
          choice_ro6_sacrifice2_20: { id: "choice_ro6_sacrifice2_20", type: "NEXT", description: "消耗随机2件自然物，帮助它复原“文明”", displayData: {}, nextSceneId: "scene_ro6_sacrifice2_20" },
          choice_ro6_sacrifice2_21: { id: "choice_ro6_sacrifice2_21", type: "TRADE", description: "获得收藏品焚毁“文明”", displayData: { itemID: "rogue_6_relic_final_6" }, nextSceneId: "scene_ro6_sacrifice2_21" },
          choice_ro6_final1_1: { id: "choice_ro6_final1_1", type: "TRADE", description: "获得1件加工品，消耗全部行动力，转化为等量希望，进入下一区域", displayData: {}, nextSceneId: "scene_ro6_final1_3" },
          choice_ro6_final1_2: { id: "choice_ro6_final1_2", type: "USE_STASHED_TICKET", description: "使用留存的券招募干员", displayData: {}, nextSceneId: "scene_ro6_final1_1" },
          choice_ro6_final1_3: { id: "choice_ro6_final1_3", type: "ZONE_END", description: "将多余行动力转换为等量希望", displayData: {}, nextSceneId: null },
          choice_ro6_final1_4: { id: "choice_ro6_final1_4", type: "NEXT", description: "现在不宜探索它的奥秘", displayData: {}, nextSceneId: "scene_ro6_final1_2" },
          choice_ro6_evacuate_1: { id: "choice_ro6_evacuate_1", type: "TRADE", description: "获得1件珍贵的加工品，保留目前行动力，直接进入下一区域", displayData: {}, nextSceneId: "scene_ro6_evacuate_1" },
          choice_ro6_evacuate_2: { id: "choice_ro6_evacuate_2", type: "NEXT", description: "多一事不如少一事", displayData: {}, nextSceneId: "scene_ro6_evacuate_2" },
          choice_ro6_evacuate_4: { id: "choice_ro6_evacuate_4", type: "ZONE_END", description: "保留行动力，进入下一区域", displayData: {}, nextSceneId: null },
          choice_ro6_scout_1: { id: "choice_ro6_scout_1", type: "EXPEDITION", description: "派一名同伴进入", displayData: {}, nextSceneId: "scene_ro6_scout_2" },
          choice_ro6_scout_2: { id: "choice_ro6_scout_2", type: "TRADE", description: "获得<@ro6.get>2</>希望，在此处养精蓄锐", displayData: { itemID: "rogue_6_population" }, nextSceneId: "scene_ro6_scout_1" },
          choice_ro6_scout_3: { id: "choice_ro6_scout_3", type: "EXPEDITION", description: "派一名同伴探索", displayData: {}, nextSceneId: "scene_ro6_scout_3" },
        },
        choiceScenes: {},
        gameConst: { expedEndingRelic: "rogue_6_relic_final_3" },
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["GRID_ZONE", "SCRAP"],
        scrap: {
          moduleConsts: { identifyScrapId: "rogue_6_scrap_G_01" },
          moveScrapData: { rogue_6_scrap_M_01: { scrapId: "rogue_6_scrap_M_01", sellPrice: 2 } },
          goodsScrapData: {
            rogue_6_scrap_G_01: { scrapId: "rogue_6_scrap_G_01", sellPrice: 2 },
            rogue_6_scrap_G_02: { scrapId: "rogue_6_scrap_G_02", sellPrice: 3 },
          },
          scrapItemToType: {
            rogue_6_scrap_M_01: "MOVE",
            rogue_6_scrap_G_01: "GOODS",
            rogue_6_scrap_G_02: "GOODS",
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
 * 外部增益夹具视图
 *
 * 真实 `OuterData.Buff.unlocked` 声明为 `{ [key: string]: number }`（解锁位图），
 * 生产侧只做真值判断（buff.ts `unlocked[id]`）；本用例沿用历史布尔夹具值，
 * 为不改夹具数据，仅就地声明该键的读取视图（真实类型可赋给本视图，故单点断言成立）。
 */
interface OuterBuffFixture {
  unlocked: { [key: string]: number | boolean };
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
  // 常规层地图键 1000+；节点无 zone_end（险路小径为中途捷径，出口推进需引擎补标）
  player.rlv2._map.zones = asModel<{ [key: string]: PlayerRoguelikeV2Zone }>({
    [String(1000 + zone - 1)]: { nodes: { 201: { type: 32 } } },
  });
  player.rlv2._status.property.gold = 8;
  player.rlv2._status.property.hp = { current: 8, max: 8 };
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

describe("rogue_6 非战斗节点·安全的角落 / 得偿所愿", () => {
  it("安全的角落：6 选项随机出 3；坐下休息 +3 生命上限；子幕仅'离开'", async () => {
    const player = makePlayer();
    await setupGame(player, 2);
    expect(await player.rlv2._incident.createNodeScene(16)).toBe(true);
    const scene = pendingScene(player);
    expect(scene.id).toBe("scene_ro6_rest_enter");
    const keys = Object.keys(scene.choices);
    expect(keys.length).toBe(3);
    for (const k of keys) expect(k).toMatch(/^choice_ro6_rest_[1-6]$/);
    // 强制进 rest_1 子幕结算（直接调引擎避开随机）
    await player.rlv2.selectChoice({ choice: "choice_ro6_rest_1" });
    expect(player.rlv2._status.property.hp.max).toBe(11);
    expect(player.rlv2._status.property.hp.current).toBe(11);
    expect(pendingScene(player).id).toBe("scene_ro6_rest_1");
    expect(Object.keys(pendingScene(player).choices)).toEqual(["choice_leave"]);
    await player.rlv2.selectChoice({ choice: "choice_leave" });
    expect(player.rlv2._status.state).toBe("WAIT_MOVE");
  });

  it("得偿所愿：搬桶得收藏品；撬桶扣 4 金换更高稀有度陈列；推轮子需四叶草化石", async () => {
    const player = makePlayer();
    await setupGame(player, 2);
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(await player.rlv2._incident.createNodeScene(512)).toBe(true);
    vi.restoreAllMocks();
    const scene = pendingScene(player);
    expect(scene.id).toBe("scene_ro6_wish_enter");
    // 无四叶草化石 → 推轮子选项被门槛过滤
    expect(Object.keys(scene.choices)).toEqual([
      "choice_ro6_wish_1",
      "choice_ro6_wish_2",
      "choice_ro6_wish_3",
    ]);
    // 撬开木桶：扣 4 金 → 刷新陈列幕（选项仍无四叶草项）
    await player.rlv2.selectChoice({ choice: "choice_ro6_wish_3" });
    expect(player.rlv2._status.property.gold).toBe(4);
    const s2 = pendingScene(player);
    expect(s2.id).toBe("scene_ro6_wish_2");
    expect(Object.keys(s2.choices)).toEqual([
      "choice_ro6_wish_4",
      "choice_ro6_wish_5",
    ]);
    // 搬桶 → 收藏品入袋（路标档案馆更高级池：四叶草化石为 mock 登记成员）→ 结束幕
    vi.spyOn(Math, "random").mockReturnValue(0);
    await player.rlv2.selectChoice({ choice: "choice_ro6_wish_4" });
    vi.restoreAllMocks();
    expect(relicsOf(player).length).toBe(1);
    expect(pendingScene(player).id).toBe("scene_ro6_wish_1");
  });
});

describe("rogue_6 非战斗节点·失与得（回滚文明）", () => {
  it("无声带/手掌：无零件交换选项、无二次交换；藏品交换成立", async () => {
    const player = makePlayer();
    await setupGame(player, 3);
    // 持有 1 件可献祭藏品（value 8）
    player.rlv2.inventory!._relic.relics = {
      r_0: { index: "r_0", id: "rogue_6_relic_a", count: 1, ts: 0 },
    };
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(await player.rlv2._incident.createNodeScene(1024)).toBe(true);
    vi.restoreAllMocks();
    expect(pendingScene(player).id).toBe("scene_ro6_sacrifice1_enter");
    // 声带未点亮 → 复原零件（sacrifice1_11）不出现
    expect(Object.keys(pendingScene(player).choices)).toEqual([
      "choice_ro6_sacrifice1_1",
      "choice_ro6_sacrifice1_5",
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0);
    await player.rlv2.selectChoice({ choice: "choice_ro6_sacrifice1_1" });
    vi.restoreAllMocks();
    // 原藏品被献祭、回报新藏品（官方允许抽回原藏品，仅验证交换成立）
    const after = relicsOf(player);
    expect(after.length).toBe(1);
    // 手掌未点亮 → 二次交换（继续赞助）不出现，仅剩到此为止
    expect(Object.keys(pendingScene(player).choices)).toEqual([
      "choice_ro6_sacrifice1_10",
    ]);
  });

  it("点亮声带/手掌：零件交换选项与二次交换解锁，零件同稀有度交换", async () => {
    const player = makePlayer();
    await setupGame(player, 3);
    player.rlv2.inventory!._relic.relics = {
      r_0: { index: "r_0", id: "rogue_6_relic_a", count: 1, ts: 0 },
    };
    // 生命游戏：声带（零件交换） + 手掌（交换次数+1）
    const buffFixture: OuterBuffFixture = {
      unlocked: { rogue_6_outbuff_8: true, rogue_6_outbuff_32: true },
    };
    player.rlv2.outer.rogue_6.buff = buffFixture as PlayerRoguelikeV2.OuterData["buff"];
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(await player.rlv2._incident.createNodeScene(1024)).toBe(true);
    vi.restoreAllMocks();
    expect(Object.keys(pendingScene(player).choices)).toContain(
      "choice_ro6_sacrifice1_11",
    );
    // 零件交换：开局 2 件自然物 → 耗 1 得 1（同稀有度）
    const scrapBefore = scrapIds(player).length;
    vi.spyOn(Math, "random").mockReturnValue(0);
    await player.rlv2.selectChoice({ choice: "choice_ro6_sacrifice1_11" });
    vi.restoreAllMocks();
    expect(scrapIds(player).length).toBe(scrapBefore);
    // 手掌点亮 → 二次交换选项出现（继续赞助 + 到此为止）
    expect(Object.keys(pendingScene(player).choices)).toEqual([
      "choice_ro6_sacrifice1_14",
      "choice_ro6_sacrifice1_17",
    ]);
  });

  it("持怦然信标：复原“文明”差分（耗 2 随机自然物 → 焚毁“文明”）", async () => {
    const player = makePlayer();
    await setupGame(player, 3);
    player.rlv2.inventory!._relic.relics = {
      r_0: { index: "r_0", id: "rogue_6_relic_final_3", count: 1, ts: 0 },
    };
    // 零件箱补 2 件自然物（开局自带 2 件 G_01）
    expect(scrapIds(player).filter((s) => s === "rogue_6_scrap_G_01").length).toBe(2);
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(await player.rlv2._incident.createNodeScene(1024)).toBe(true);
    vi.restoreAllMocks();
    const scene = pendingScene(player);
    expect(scene.id).toBe("scene_ro6_sacrifice2_enter");
    expect(Object.keys(scene.choices)).toContain("choice_ro6_sacrifice2_20");
    // 复原“文明”：消耗 2 件自然物
    await player.rlv2.selectChoice({ choice: "choice_ro6_sacrifice2_20" });
    expect(scrapIds(player).filter((s) => s === "rogue_6_scrap_G_01").length).toBe(0);
    expect(Object.keys(pendingScene(player).choices)).toEqual([
      "choice_ro6_sacrifice2_21",
    ]);
    // 等待结果 → 获得焚毁“文明”（三结局削弱藏品）
    await player.rlv2.selectChoice({ choice: "choice_ro6_sacrifice2_21" });
    expect(relicsOf(player)).toContain("rogue_6_relic_final_6");
  });
});

describe("rogue_6 非战斗节点·区域出口（险路尽头 / 险路小径）", () => {
  it("险路尽头：说服同伴 → +1 加工品 + 行动力全转希望 → 进入下一区域", async () => {
    const player = makePlayer();
    await setupGame(player, 1);
    player.rlv2._module.gridZone.stepRemain = 7;
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(await player.rlv2._incident.createNodeScene(8388608)).toBe(true);
    vi.restoreAllMocks();
    expect(pendingScene(player).id).toBe("scene_ro6_final1_enter");
    const popBefore = player.rlv2._status.property.population.max;
    vi.spyOn(Math, "random").mockReturnValue(0);
    await player.rlv2.selectChoice({ choice: "choice_ro6_final1_1" });
    vi.restoreAllMocks();
    // +1 加工品（MOVE 型零件）+ 7 行动力 → 7 希望
    expect(scrapIds(player)).toContain("rogue_6_scrap_M_01");
    expect(player.rlv2._status.property.population.max).toBe(popBefore + 7);
    expect(player.rlv2._module.gridZone.stepRemain).toBe(0);
    // 进区幕 → 进入下一区域（zone 1 → 2）
    expect(pendingScene(player).id).toBe("scene_ro6_final1_3");
    vi.spyOn(Math, "random").mockReturnValue(0);
    await player.rlv2.selectChoice({ choice: "choice_ro6_final1_3" });
    vi.restoreAllMocks();
    expect(player.rlv2._status.cursor.zone).toBe(2);
    expect(player.rlv2._status.state).toBe("WAIT_MOVE");
  });

  it("险路小径：接受提议 → +1 珍贵加工品（保留行动力）→ 离开进区", async () => {
    const player = makePlayer();
    await setupGame(player, 2);
    player.rlv2._module.gridZone.stepRemain = 5;
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(await player.rlv2._incident.createNodeScene(16777216)).toBe(true);
    vi.restoreAllMocks();
    const scene = pendingScene(player);
    expect(scene.id).toMatch(/^scene_ro6_evacuate[23]?_enter$/);
    // 接受提议：随机加工品入箱，行动力保留
    vi.spyOn(Math, "random").mockReturnValue(0);
    await player.rlv2.selectChoice({ choice: "choice_ro6_evacuate_1" });
    vi.restoreAllMocks();
    expect(scrapIds(player)).toContain("rogue_6_scrap_M_01");
    expect(player.rlv2._module.gridZone.stepRemain).toBe(5);
    // 出口选项（保留行动力进入下一区域）
    expect(Object.keys(pendingScene(player).choices)).toEqual([
      "choice_ro6_evacuate_4",
    ]);
    vi.spyOn(Math, "random").mockReturnValue(0);
    await player.rlv2.selectChoice({ choice: "choice_ro6_evacuate_4" });
    vi.restoreAllMocks();
    expect(player.rlv2._status.cursor.zone).toBe(3);
  });
});

describe("rogue_6 非战斗节点·先行一步（引擎接管）", () => {
  it("休息 → +2 希望；派同伴探索 → 三结局远征标记", async () => {
    const player = makePlayer();
    await setupGame(player, 2);
    const popBefore = player.rlv2._status.property.population.max;
    await player.rlv2.selectChoice({ choice: "choice_ro6_scout_2" });
    expect(player.rlv2._status.property.population.max).toBe(popBefore + 2);
    expect(pendingScene(player).id).toBe("scene_ro6_scout_1");
    expect(Object.keys(pendingScene(player).choices)).toEqual(["choice_leave"]);
    await player.rlv2.selectChoice({ choice: "choice_ro6_scout_3" });
    expect(player.rlv2.troop.expeditionDetails.ending).toBe(true);
  });
});
