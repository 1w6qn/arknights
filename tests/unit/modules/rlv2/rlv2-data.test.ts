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

// 官方 excel mock：提供 rogue_1 的 choices/stages/gameConst/items 元数据
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
        rogue_1: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          choices: {
            choice_leave: { id: "choice_leave", type: "LEAVE", nextSceneId: null },
            // 非战斗：交易选择（带下一场景）
            choice_trade1_1: { id: "choice_trade1_1", type: "TRADE", nextSceneId: "scene_trade1_1" },
            // 战斗选择：event_choices 中 choices 为字符串（关卡 id 关键词）
            choice_bat1_3: { id: "choice_bat1_3", type: "BATTLE", nextSceneId: null },
          },
          stages: {
            ro1_n_1_1: { id: "ro1_n_1_1" },
            ro1_n_1_2: { id: "ro1_n_1_2" },
          },
          gameConst: { unlockRouteItemId: null, unlockRouteItemCount: 0 },
          items: { rogue_1_gold: { type: "gold" } },
          relics: {},
        },
      },
      modules: {},
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: {},
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import excel from "@excel/excel";
import type {
  PlayerRoguelikePendingEvent,
  PlayerRoguelikeV2,
  PlayerRoguelikeV2Zone,
} from "@game/modules/roguelike/rlv2-model";
import type { RoguelikePendingEvent } from "@game/modules/roguelike/events";

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/** 夹具 pending 事件视图（本文件只构造 SCENE 事件，scene 用真实 Content 形状） */
interface PendingEventFixture {
  type: string;
  content: { scene?: PlayerRoguelikePendingEvent.SceneContent };
}

function makePlayer() {
  const pd = mockPlayerData({
    rlv2: { outer: {}, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  return new PlayerDataManager(pd._playerdata);
}

describe("rlv2 不期而遇数据接入", () => {
  let player: PlayerDataManager;

  beforeEach(() => {
    player = makePlayer();
    player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_1", mode: "NORMAL", modeGrade: 0, predefined: null });
  });

  /** 向状态机注入 pending 事件 */
  function pushPending(event: PendingEventFixture) {
    player.rlv2._status._pending._pending.push(event as RoguelikePendingEvent);
  }

  describe("event_choices.json 数据文件", () => {
    it("应存在且含 5 主题 enter/choices 结构", () => {
      const data = require("../../../../data/rlv2/event_choices.json");
      const themes = Object.keys(data);
      expect(themes.length).toBeGreaterThanOrEqual(5);
      for (const th of ["rogue_1", "rogue_2", "rogue_3", "rogue_4", "rogue_5"]) {
        expect(data[th]).toBeDefined();
        expect(data[th].enter).toBeDefined();
        expect(data[th].choices).toBeDefined();
      }
      // 抽查 rogue_1 交易选择带 lose/get 效果
      const trade = data.rogue_1.choices.choice_trade1_1;
      expect(trade).toBeDefined();
      expect(trade.lose).toEqual({ hp: { current: 2 } });
      expect(trade.get).toEqual({ gold: 8 });
    });

    it("RoguelikeV2Config 应加载 eventChoices", () => {
      const eventChoices = player.rlv2._data.eventChoices;
      expect(eventChoices).toBeDefined();
      expect(Object.keys(eventChoices)).toContain("rogue_1");
    });
  });

  describe("selectChoice 效果应用", () => {
    it("应应用 get/lose 效果（gold +8、hp.current -2）", async () => {
      pushPending({ type: "SCENE", content: { scene: { id: "scene_trade1_1", choices: {}, choiceAdditional: {} } } });
      player.rlv2._status.state = "IN_SCENE";
      // 初始属性
      player.rlv2._status.property.gold = 5;
      player.rlv2._status.property.hp = { current: 10, max: 10 };

      await player.rlv2.selectChoice({ choice: "choice_trade1_1" });

      expect(player.rlv2._status.property.gold).toBe(13);
      expect(player.rlv2._status.property.hp.current).toBe(8);
    });

    it("非战斗选择应生成下一场景 SCENE 事件（选项来自 event_choices）", async () => {
      pushPending({ type: "SCENE", content: { scene: { id: "scene_trade1_1", choices: {}, choiceAdditional: {} } } });
      await player.rlv2.selectChoice({ choice: "choice_trade1_1" });

      const pending = player.rlv2._status.pending;
      expect(pending.length).toBeGreaterThan(0);
      const sceneEvent = pending.find((e) => e.type === "SCENE");
      expect(sceneEvent).toBeDefined();
      expect(sceneEvent!.content.scene!.id).toBe("scene_trade1_1");
      // 下一场景选项来自真实 event_choices：choice_trade1_1.choices = ["choice_leave"]
      expect(Object.keys(sceneEvent!.content.scene!.choices)).toEqual(["choice_leave"]);
    });

    it("战斗选择（choices 为字符串）应生成 BATTLE 事件并设置节点关卡", async () => {
      // choice_bat1_3 的 event_choices.choices 为 "ro1_n_1_"（关卡关键词）
      pushPending({ type: "SCENE", content: { scene: { id: "scene_bat1_enter", choices: {}, choiceAdditional: {} } } });
      player.rlv2._status.cursor.zone = 1;
      player.rlv2._status.cursor.position = { x: 1, y: 0 };
      player.rlv2._map.zones[1] = asModel<PlayerRoguelikeV2Zone>({
        nodes: { "100": { pos: { x: 1, y: 0 }, next: [], type: 1 } },
      });

      await player.rlv2.selectChoice({ choice: "choice_bat1_3" });

      const pending = player.rlv2._status.pending;
      const battleEvent = pending.find((e) => e.type === "BATTLE");
      expect(battleEvent).toBeDefined();
      expect(["ro1_n_1_1", "ro1_n_1_2"]).toContain(
        player.rlv2._map.zones[1].nodes["100"].stage
      );
    });
  });

  describe("moveTo 不期而遇节点", () => {
    it("移动到 INCIDENT 节点应生成 SCENE 事件", async () => {
      // 构造 zone_1 地图：起点 000 与 INCIDENT 节点 100
      player.rlv2._map.zones[1] = asModel<PlayerRoguelikeV2Zone>({
        nodes: {
          "0": { index: "0", pos: { x: 0, y: 0 }, next: [{ x: 1, y: 0 }], type: 1 },
          "100": { index: "100", pos: { x: 1, y: 0 }, next: [], type: 32 }, // INCIDENT
        },
      });
      player.rlv2._status.cursor.zone = 1;
      player.rlv2._status.cursor.position = { x: 0, y: 0 };

      await player.rlv2.moveTo({ to: { x: 1, y: 0 } });

      const pending = player.rlv2._status.pending;
      expect(pending.length).toBeGreaterThan(0);
      const sceneEvent = pending.find((e) => e.type === "SCENE");
      expect(sceneEvent).toBeDefined();
      // 场景 id 应来自 event_choices rogue_1.enter 的场景池
      const enterScenes = Object.keys(player.rlv2._data.eventChoices.rogue_1.enter);
      expect(enterScenes).toContain(sceneEvent!.content.scene!.id);
      // 选项应非空
      expect(Object.keys(sceneEvent!.content.scene!.choices).length).toBeGreaterThan(0);
    });
  });
});
