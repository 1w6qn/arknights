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

// rogue_6 P2：襁褓生灵接入行动奖励（羽蛇 +1 选项 / 三头犬 +1 选择次数）
// + 难度 0 失败补偿（下次开局特勤任务影像）
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
        stages: { ro6_n_1_1: { id: "ro6_n_1_1" }, ro6_n_3_1: { id: "ro6_n_3_1" }, ro6_n_5_1: { id: "ro6_n_5_1" } },
        init: [
          { modeGrade: 0, predefinedId: null, modeId: "NORMAL", initialHp: 8, initialGold: 8, initialPopulation: 6, initialSquadCapacity: 6, initialBandRelic: [], initialRecruitGroup: [] },
        ],
        bandRef: {},
        difficulties: [{ modeDifficulty: "NORMAL", grade: 0, scoreFactor: 1 }],
        items: {
          rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: "NONE" },
          rogue_6_population: { id: "rogue_6_population", type: "POPULATION", rarity: "NONE" },
          rogue_6_relic_fight_29: { id: "rogue_6_relic_fight_29", type: "RELIC", rarity: "RARE" },
          rogue_6_start_1: { id: "rogue_6_start_1", type: "RELIC", rarity: "NORMAL" },
        },
        relics: {
          rogue_6_relic_fight_29: { id: "rogue_6_relic_fight_29", buffs: [] },
          rogue_6_start_1: { id: "rogue_6_start_1", buffs: [] },
          // 襁褓生灵（数据驱动：init_gift / init_support_multi_chance / force_add_choice）
          rogue_6_legacy_01: { id: "rogue_6_legacy_01", buffs: [{ key: "init_gift", blackboard: [{ key: "id", value: 0, valueStr: "rogue_6_gold" }, { key: "count", value: 5, valueStr: null }] }] },
          rogue_6_legacy_02: { id: "rogue_6_legacy_02", buffs: [{ key: "init_gift", blackboard: [{ key: "id", value: 0, valueStr: "rogue_6_population" }, { key: "count", value: 1, valueStr: null }] }] },
          rogue_6_legacy_03: { id: "rogue_6_legacy_03", buffs: [{ key: "init_support_multi_chance", blackboard: [{ key: "add", value: 1, valueStr: null }] }] },
          rogue_6_legacy_04: { id: "rogue_6_legacy_04", buffs: [{ key: "force_add_choice", blackboard: [{ key: "choice_id", value: 0, valueStr: "choice_ro6_startbuff_7" }, { key: "scene_ids", value: 0, valueStr: "scene_ro6_startbuff_enter" }] }] },
        },
        choices: {
          choice_ro6_startbuff_1: { id: "choice_ro6_startbuff_1" },
          choice_ro6_startbuff_2: { id: "choice_ro6_startbuff_2" },
          choice_ro6_startbuff_3: { id: "choice_ro6_startbuff_3" },
          choice_ro6_startbuff_4: { id: "choice_ro6_startbuff_4" },
          choice_ro6_startbuff_5: { id: "choice_ro6_startbuff_5" },
          choice_ro6_startbuff_6: { id: "choice_ro6_startbuff_6" },
          choice_ro6_startbuff_7: { id: "choice_ro6_startbuff_7" },
          choice_ro6_startbuff_8: { id: "choice_ro6_startbuff_8" },
          choice_ro6_startbuff_9: { id: "choice_ro6_startbuff_9" },
        },
      },
    },
    modules: {
      rogue_6: { moduleTypes: ["GRID_ZONE", "SCRAP"], scrap: { scrapItemToType: {} } },
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
import type { RoguelikeV2Manager } from "@game/modules/roguelike/logic";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/**
 * `rlv2:create` 发射窄视图
 *
 * 事件契约（@game/kernel/events/rlv2.ts）把 `rlv2:create` 载荷声明为 `[]`，
 * 而本文件沿用历史写法传 `[player.rlv2]`；全部监听方
 * （events/buff/inventory/map/module/pool/status/troop 的 `create`）均不读参数，
 * 生产侧 game-init.ts 亦以 `[]` 发射，故运行期两种载荷等价。
 * 为不改动本用例的发射实参，仅就地声明该次发射的窄视图。
 */
interface CreateTriggerView {
  emit(event: "rlv2:create", data: [RoguelikeV2Manager]): Promise<void>;
}

function makePlayer(modeGrade = 0, support = false) {
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
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme: "rogue_6",
    mode: "NORMAL",
    modeGrade,
    outer: { support },
  });
  return player;
}

/** 构造一个 GAME_INIT_SUPPORT pending 事件并返回其选项列表 */
function supportChoices(player: PlayerDataManager): string[] {
  const ev = new RoguelikePendingEvent(
    player.rlv2,
    player.rlv2._trigger,
    "GAME_INIT_SUPPORT",
    0,
    { step: [1, 3] },
  );
  return Object.keys(ev.content.initSupport!.scene.choices);
}

describe("rogue_6 襁褓生灵 → 行动奖励选项/选择次数", () => {
  it("无襁褓：基础 6 选项随机 3 个", async () => {
    const player = makePlayer();
    const choices = supportChoices(player);
    expect(choices.length).toBe(3);
    for (const c of choices) {
      const n = parseInt(c.replace(/^.*startbuff_/, ""), 10);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
    }
  });

  it("襁褓羽蛇（legacy_04：支援选项+1）→ 追加 1 个襁褓选项（startbuff_7..12）", async () => {
    const player = makePlayer();
    player.rlv2.outer.rogue_6.record = asModel<PlayerRoguelikeV2.OuterData.Record>({
      legacy: ["rogue_6_legacy_04"],
    });
    const choices = supportChoices(player);
    expect(choices.length).toBe(4);
    const extra = choices.find(
      (c) => parseInt(c.replace(/^.*startbuff_/, ""), 10) >= 7,
    );
    expect(extra).toBeTruthy();
  });

  it("襁褓三头犬（legacy_03：选择次数+1）→ 生成 2 个 GAME_INIT_SUPPORT 事件", async () => {
    const player = makePlayer(0, true); // 有行动奖励阶段（上一把到 3 层）
    player.rlv2.outer.rogue_6.record = asModel<PlayerRoguelikeV2.OuterData.Record>({
      legacy: ["rogue_6_legacy_03"],
    });
    await player.rlv2._module.create();
    await (player.rlv2._trigger as CreateTriggerView).emit("rlv2:create", [player.rlv2]);
    const pending = player.rlv2._status.pending;
    const supports = pending.filter((e) => e.type === "GAME_INIT_SUPPORT");
    expect(supports.length).toBe(2);
  });

  it("无三头犬：仅 1 个 GAME_INIT_SUPPORT 事件", async () => {
    const player = makePlayer(0, true);
    await player.rlv2._module.create();
    await (player.rlv2._trigger as CreateTriggerView).emit("rlv2:create", [player.rlv2]);
    const pending = player.rlv2._status.pending;
    expect(
      pending.filter((e) => e.type === "GAME_INIT_SUPPORT").length,
    ).toBe(1);
  });

  it("无行动奖励阶段（上一把未到 3 层）→ 无 GAME_INIT_SUPPORT", async () => {
    const player = makePlayer(0, false);
    await player.rlv2._module.create();
    await (player.rlv2._trigger as CreateTriggerView).emit("rlv2:create", [player.rlv2]);
    const pending = player.rlv2._status.pending;
    expect(
      pending.filter((e) => e.type === "GAME_INIT_SUPPORT").length,
    ).toBe(0);
  });
});

describe("rogue_6 难度 0 失败补偿（特勤任务影像）", () => {
  it("难度 ≤3 失败 → record.legacy 记录特勤任务影像（下次开局发放）", async () => {
    const player = makePlayer(0);
    await player.rlv2._module.create();
    player.rlv2._status.runResult = "giveup";
    player.rlv2._status.cursor.zone = 3;
    await player.rlv2.gameSettle();
    const legacy = player.rlv2.outer.rogue_6.record.legacy;
    expect(legacy).toContain("rogue_6_relic_fight_29");
  });

  it("难度 4+ 失败 → 不再记录特勤任务影像", async () => {
    const player = makePlayer(4);
    await player.rlv2._module.create();
    player.rlv2._status.runResult = "giveup";
    player.rlv2._status.cursor.zone = 3;
    await player.rlv2.gameSettle();
    const legacy = player.rlv2.outer.rogue_6.record.legacy || [];
    expect(legacy).not.toContain("rogue_6_relic_fight_29");
  });

  it("createGame：record.legacy 含特勤任务影像 → 开局获得该收藏品", async () => {
    const player = makePlayer(0);
    player.rlv2.outer.rogue_6.record = asModel<PlayerRoguelikeV2.OuterData.Record>({
      legacy: ["rogue_6_relic_fight_29"],
    });
    await player.rlv2.createGame({
      theme: "rogue_6",
      mode: "NORMAL",
      modeGrade: 0,
      predefinedId: null,
    });
    const relics = Object.values(player.rlv2.inventory!.relic).map(
      (r) => r.id,
    );
    expect(relics).toContain("rogue_6_relic_fight_29");
  });
});
