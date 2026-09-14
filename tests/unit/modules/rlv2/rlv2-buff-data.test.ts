import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRoguelikeConsts } from "@game/excel/roguelike_consts_gen";
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


// 官方 excel mock：提供 RoguelikeConsts（由官方表派生，替代 data/rlv2.json）
// 与 RoguelikeTopicTable.details（fallback）
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
        rogue_3: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          recruitGrps: { recruit_group_1: ["ro3_ticket_a", "ro3_ticket_b"] },
          recruitTickets: {
            rogue_3_recruit_ticket_pioneer: {},
            rogue_3_recruit_ticket_warrior: {},
            rogue_3_recruit_ticket_tank: {},
            rogue_3_recruit_ticket_sniper: {},
            rogue_3_recruit_ticket_caster: {},
            rogue_3_recruit_ticket_support: {},
            rogue_3_recruit_ticket_medic: {},
            rogue_3_recruit_ticket_special: {},
            rogue_3_recruit_ticket_pioneer_sp: {},
            rogue_3_recruit_ticket_all: {},
          },
        },
      },
      modules: { rogue_3: {} },
      consts: {},
    },
    // 模拟派生 RoguelikeConsts：只有 rogue_3 有 recruitGrps，modebuff 缺失（验证容错）
    RoguelikeConsts: {
      rogue_3: { outbuff: {}, modebuff: {}, recruitGrps: { recruit_group_1: ["ro3_ticket_a"] } },
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { EventMap } from "@game/kernel/events";
import type { RoguelikeInventoryManager } from "@game/modules/roguelike/inventory";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { RoguelikePendingEvent } from "@game/modules/roguelike/events";
import { mockPlayerData, asModel, type MockSeed } from "../../../helpers";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/**
 * 待处理事件入队夹具视图
 *
 * `_pending._pending` 的元素是 `RoguelikePendingEvent` class（用例历史写法直接 push 字面量，
 * 与构造器产出的对象在队列语义上等价：只按 `type`/`content` 读取）。生成模型
 * `InitRecruitSetContent.option` 声明为 `string[]`（写入侧 events.ts 写数组），而本用例沿用
 * 历史夹具值字符串；该字段在 `chooseInitialRecruitSet` 中不被读取（只消费 `{ select }` 参数，
 * 见 game-init.ts）。为不改夹具数据，此处按读取侧声明视图，并做一次单向断言入队。
 */
interface PendingEventFixture {
  type: string;
  content: {
    initRecruitSet?: { option?: string | string[] };
    initRecruit?: { tickets?: string[]; showChar?: never[]; team?: string | null };
  };
}

/** 按 {@link PendingEventFixture} 的说明入队一个夹具事件 */
function pushPendingEvent(queue: RoguelikePendingEvent[], event: PendingEventFixture): void {
  queue.push(event as RoguelikePendingEvent);
}

/** 构造玩家：`outer` 为局外数据夹具（深可选视图，字段名/类型仍受真实模型约束） */
function makePlayer(outer: MockSeed<PlayerDataModel["rlv2"]["outer"]> = {}) {
  const pd = mockPlayerData({
    rlv2: {
      outer,
      current: { game: { theme: "rogue_3", modeGrade: 0 } },
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  return new PlayerDataManager(pd._playerdata);
}

describe("rlv2 局外buff/难度buff/招募组数据", () => {
  let player: PlayerDataManager;

  beforeEach(() => {
    player = makePlayer({ rogue_3: { buff: { unlocked: {} } } });
    // RoguelikeV2Manager 构造会重置 current.game，需在此重设主题
    player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_3", mode: "NORMAL", modeGrade: 0, predefined: null });
  });

  describe("派生 RoguelikeConsts（官方 excel 取代 data/rlv2.json）", () => {
    it("应覆盖全部 6 主题且 recruitGrps 非空", () => {
      const data = buildRoguelikeConsts(require("../../../../data/excel/roguelike_topic_table.json"));
      const themes = Object.keys(data);
      expect(themes.sort()).toEqual(["rogue_1", "rogue_2", "rogue_3", "rogue_4", "rogue_5", "rogue_6"]);
      for (const th of themes) {
        expect(Object.keys(data[th].recruitGrps).length).toBeGreaterThan(0);
      }
    });

    it("各主题 outbuff 数量应与增益树节点一致", () => {
      const data = buildRoguelikeConsts(require("../../../../data/excel/roguelike_topic_table.json"));
      expect(Object.keys(data.rogue_1.outbuff).length).toBeGreaterThanOrEqual(45);
      expect(Object.keys(data.rogue_2.outbuff).length).toBeGreaterThanOrEqual(58);
      expect(Object.keys(data.rogue_3.outbuff).length).toBeGreaterThanOrEqual(43);
      expect(Object.keys(data.rogue_4.outbuff).length).toBeGreaterThanOrEqual(63);
      expect(Object.keys(data.rogue_5.outbuff).length).toBeGreaterThanOrEqual(57);
      expect(Object.keys(data.rogue_6.outbuff).length).toBeGreaterThanOrEqual(50);
    });

    it("rogue_2/3 应有 0-15 难度 modebuff", () => {
      const data = buildRoguelikeConsts(require("../../../../data/excel/roguelike_topic_table.json"));
      for (const th of ["rogue_2", "rogue_3"]) {
        const grades = Object.keys(data[th].modebuff);
        expect(grades).toContain("0");
        expect(grades).toContain("15");
      }
      // rogue_2 难度 1 有实际 buff（rogue_2_ep_damage_scale）
      expect(data.rogue_2.modebuff["1"].length).toBeGreaterThan(0);
    });

    it("rogue_1 outbuff 应为标准 RoguelikeBuff 格式", () => {
      const data = buildRoguelikeConsts(require("../../../../data/excel/roguelike_topic_table.json"));
      const b = data.rogue_1.outbuff.outbuff_1;
      expect(Array.isArray(b)).toBe(true);
      expect(b[0]).toHaveProperty("key");
      expect(b[0]).toHaveProperty("blackboard");
    });
  });

  describe("buff.create 容错", () => {
    it("modebuff 缺失时不崩（modebuff[modeGrade] 为 undefined 时跳过）", async () => {
      // mock 的 RoguelikeConsts.rogue_3.modebuff = {} → create 不崩
      await expect(player.rlv2._buff.create()).resolves.not.toThrow();
    });

    it("outer 无该主题数据（从未玩过）时不崩", async () => {
      // outer 为空（makePlayer 默认），create 遍历 unlocked 为空对象
      const emptyPlayer = makePlayer({});
      emptyPlayer.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_3", mode: "NORMAL", modeGrade: 0, predefined: null });
      await expect(emptyPlayer.rlv2._buff.create()).resolves.not.toThrow();
    });
  });

  describe("chooseInitialRecruitSet 招募组", () => {
    it("应从官方 recruitTickets 发放 3 张标准职业招募票", async () => {
      const emitSpy = vi.spyOn(player.rlv2._trigger, "emit");
      // 注入 GAME_INIT_RECRUIT 事件（chooseInitialRecruitSet 需要找到它）
      pushPendingEvent(player.rlv2._status._pending._pending, {
        type: "GAME_INIT_RECRUIT_SET",
        content: { initRecruitSet: { option: "recruit_group_1" } },
      });
      pushPendingEvent(player.rlv2._status._pending._pending, {
        type: "GAME_INIT_RECRUIT",
        content: { initRecruit: { tickets: [], showChar: [], team: null } },
      });
      player.rlv2.inventory = asModel<RoguelikeInventoryManager>({ recruit: {} });
      await player.rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
      const recruitGainCalls = emitSpy.mock.calls.filter(
        (c): c is ["rlv2:recruit:gain", EventMap["rlv2:recruit:gain"]] => c[0] === "rlv2:recruit:gain",
      );
      // 先手必胜组（recruit_group_1）→ 先锋、狙击、特种券各一张（官方组合映射）
      expect(recruitGainCalls.length).toBe(3);
      const ticketIds = recruitGainCalls.map((c) => c[1][0]).sort();
      expect(ticketIds).toEqual([
        "rogue_3_recruit_ticket_pioneer",
        "rogue_3_recruit_ticket_sniper",
        "rogue_3_recruit_ticket_special",
      ].sort());
      for (const c of recruitGainCalls) expect(c[1][1]).toBe("initial");
    });

    it("recruit_group_random 应发放 3 张随机标准职业票", async () => {
      const emitSpy = vi.spyOn(player.rlv2._trigger, "emit");
      pushPendingEvent(player.rlv2._status._pending._pending, {
        type: "GAME_INIT_RECRUIT_SET",
        content: { initRecruitSet: { option: "recruit_group_random" } },
      });
      pushPendingEvent(player.rlv2._status._pending._pending, {
        type: "GAME_INIT_RECRUIT",
        content: { initRecruit: { tickets: [], showChar: [], team: null } },
      });
      player.rlv2.inventory = asModel<RoguelikeInventoryManager>({ recruit: {} });
      await player.rlv2.chooseInitialRecruitSet({ select: "recruit_group_random" });
      const recruitGainCalls = emitSpy.mock.calls.filter(
        (c): c is ["rlv2:recruit:gain", EventMap["rlv2:recruit:gain"]] => c[0] === "rlv2:recruit:gain",
      );
      expect(recruitGainCalls.length).toBe(3);
      for (const c of recruitGainCalls) {
        expect(c[1][0]).toMatch(/^rogue_3_recruit_ticket_(pioneer|warrior|tank|sniper|caster|support|medic|special)$/);
      }
    });
  });
});
