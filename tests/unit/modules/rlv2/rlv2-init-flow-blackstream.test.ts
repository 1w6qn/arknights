import { describe, it, expect, vi, afterEach } from "vitest";
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

// ===== rogue_6（黑流树海）初始流程修正回归（对照 prts.wiki 开始探索节） =====
// 1. 行动奖励触发门槛：上一把「至少通过两层」（2 层通关记录即触发，兼容 3 层样本）
// 2. 行动奖励发放语义（官方 funcIconId）：
//    未编号物=NORMAL 藏品 / 巢寄生=RARE 藏品+零件箱-1 / 林间代步=加工品 / 空间租赁=-6金+零件箱+2
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
        items: {
          rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: 0 },
          rogue_6_max_weight: { id: "rogue_6_max_weight", type: "MAX_WEIGHT", rarity: 0 },
          rogue_6_scrap_M_01: { id: "rogue_6_scrap_M_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_M_02: { id: "rogue_6_scrap_M_02", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_relic_a: { id: "rogue_6_relic_a", type: "RELIC", rarity: "NORMAL" },
          rogue_6_relic_b: { id: "rogue_6_relic_b", type: "RELIC", rarity: "RARE" },
          rogue_6_relic_c: { id: "rogue_6_relic_c", type: "RELIC", rarity: "SUPER_RARE" },
        },
        relics: {
          rogue_6_relic_a: { id: "rogue_6_relic_a", buffs: [] },
          rogue_6_relic_b: { id: "rogue_6_relic_b", buffs: [] },
          rogue_6_relic_c: { id: "rogue_6_relic_c", buffs: [] },
        },
        choices: {
          choice_ro6_startbuff_1: {
            id: "choice_ro6_startbuff_1",
            description: "获得<@ro6.get>1件</>普通收藏品",
            displayData: { funcIconId: "initial_reward_relic", itemID: null },
          },
          choice_ro6_startbuff_2: {
            id: "choice_ro6_startbuff_2",
            description: "获得<@ro6.get>8</>源石锭",
            displayData: { funcIconId: "initial_reward_gold", itemID: "rogue_6_gold" },
          },
          choice_ro6_startbuff_3: {
            id: "choice_ro6_startbuff_3",
            description: "消耗<@ro6.lose>6</>源石锭，零件箱容量<@ro6.get>+2</>",
            displayData: { funcIconId: "initial_reward_max_weight", itemID: "rogue_6_max_weight" },
          },
          choice_ro6_startbuff_4: {
            id: "choice_ro6_startbuff_4",
            description: "消耗<@ro6.lose>2</>目标生命值上限，获得<@ro6.get>1件</>随机收藏品",
            displayData: { funcIconId: "initial_reward_unknown_pay_hp", itemID: null },
          },
          choice_ro6_startbuff_5: {
            id: "choice_ro6_startbuff_5",
            description: "获得<@ro6.get>1件</>加工品",
            displayData: { funcIconId: "initial_reward_scrap_move", itemID: null },
          },
          choice_ro6_startbuff_6: {
            id: "choice_ro6_startbuff_6",
            description: "零件箱容量<@ro6.lose>-1</>，获得<@ro6.get>1件</>稀有收藏品",
            displayData: { funcIconId: "initial_reward_unknown_pay_weight", itemID: null },
          },
        },
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["SCRAP"],
        scrap: {
          moduleConsts: { identifyScrapId: "rogue_6_scrap_M_01" },
          moveScrapData: {
            rogue_6_scrap_M_01: { scrapId: "rogue_6_scrap_M_01", sellPrice: 2 },
            rogue_6_scrap_M_02: { scrapId: "rogue_6_scrap_M_02", sellPrice: 2 },
          },
          scrapItemToType: {
            rogue_6_scrap_M_01: "MOVE",
            rogue_6_scrap_M_02: "MOVE",
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
import { RoguelikePendingEvent } from "@game/modules/roguelike/events";
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
    outer: { support: true },
  });
  return player;
}

/** 构造 GAME_INIT_SUPPORT pending 事件并入队（与官方初始流程同序） */
function pushSupport(player: PlayerDataManager): void {
  const ev = new RoguelikePendingEvent(
    player.rlv2,
    player.rlv2._trigger,
    "GAME_INIT_SUPPORT",
    0,
    { step: [1, 3] },
  );
  player.rlv2._status._pending._pending.push(ev);
}

function relicsOf(player: PlayerDataManager): string[] {
  return Object.values(player.rlv2.inventory!.relic).map((r) => r.id);
}

afterEach(() => vi.restoreAllMocks());

describe("行动奖励触发门槛（prts.wiki「至少通过两层」）", () => {
  it("2 层通关记录即触发；无记录不触发；3 层样本兼容", () => {
    const player = makePlayer();
    const f = player.rlv2.hasReachedZone3.bind(player.rlv2);
    expect(f({ ro6_n_2_1: 1 })).toBe(true);
    expect(f({ ro6_e_2_3: 1 })).toBe(true);
    expect(f({ ro6_n_3_1: 1 })).toBe(true); // 抓包样本形态兼容
    expect(f({ ro6_n_1_1: 1 })).toBe(false);
    expect(f({})).toBe(false);
    expect(f(undefined)).toBe(false);
  });
});

describe("行动奖励发放（官方语义）", () => {
  it("空间租赁：-6 源石锭 + 零件箱容量 +2（带符号 get 标签）", async () => {
    const player = makePlayer();
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2._module.create();
    await player.rlv2._pool.create();
    player.rlv2._status.property.gold = 8;
    const limitBefore = player.rlv2._module.scrap.limit;
    pushSupport(player);
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2.selectChoice({ choice: "choice_ro6_startbuff_3" });
    expect(player.rlv2._status.property.gold).toBe(2);
    expect(player.rlv2._module.scrap.limit).toBe(limitBefore + 2);
  });

  it("未编号物：获得 NORMAL 稀有度藏品（非全量池）", async () => {
    const player = makePlayer();
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2._module.create();
    await player.rlv2._pool.create();
    vi.spyOn(Math, "random").mockReturnValue(0);
    pushSupport(player);
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2.selectChoice({ choice: "choice_ro6_startbuff_1" });
    expect(relicsOf(player)).toEqual(["rogue_6_relic_a"]);
  });

  it("巢寄生：零件箱容量 -1 + 获得 RARE 稀有度藏品", async () => {
    const player = makePlayer();
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2._module.create();
    await player.rlv2._pool.create();
    const limitBefore = player.rlv2._module.scrap.limit;
    vi.spyOn(Math, "random").mockReturnValue(0);
    pushSupport(player);
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2.selectChoice({ choice: "choice_ro6_startbuff_6" });
    expect(player.rlv2._module.scrap.limit).toBe(limitBefore - 1);
    expect(relicsOf(player)).toEqual(["rogue_6_relic_b"]);
  });

  it("林间代步：获得 1 件加工品（MOVE 型零件入零件箱）", async () => {
    const player = makePlayer();
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2._module.create();
    await player.rlv2._pool.create();
    vi.spyOn(Math, "random").mockReturnValue(0);
    pushSupport(player);
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2.selectChoice({ choice: "choice_ro6_startbuff_5" });
    const ids = Object.values(player.rlv2._module.scrap.inventory).map(
      (it) => it.id,
    );
    // 开局自带 2 件 G_01（seedInitial）+ 1 件 MOVE 加工品
    expect(ids.some((id: string) => id.startsWith("rogue_6_scrap_M_"))).toBe(true);
  });

  it("退行补偿：-2 生命上限 + 全量池随机藏品", async () => {
    const player = makePlayer();
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2._module.create();
    await player.rlv2._pool.create();
    player.rlv2._status.property.hp = { current: 8, max: 8 };
    vi.spyOn(Math, "random").mockReturnValue(0);
    pushSupport(player);
    await new Promise((r) => setTimeout(r, 0));
    await player.rlv2.selectChoice({ choice: "choice_ro6_startbuff_4" });
    expect(player.rlv2._status.property.hp.max).toBe(6);
    expect(relicsOf(player).length).toBe(1);
  });
});
