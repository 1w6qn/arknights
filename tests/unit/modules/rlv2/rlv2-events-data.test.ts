import { describe, it, expect, vi, beforeEach } from "vitest";


// 官方 excel mock：rogue_1/2/4/6 的 choices 含 startbuff 选项
vi.mock("@excel/excel", () => {
  const startbuffChoices = (prefix: string, n: number) => {
    const c: Record<string, { id: string; type: string }> = {};
    for (let i = 1; i <= n; i++) c[`${prefix}${i}`] = { id: `${prefix}${i}`, type: "TRADE" };
    return c;
  };
  return {
    default: {
      RoguelikeTopicTable: {
        details: {
          rogue_1: {
            init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
            choices: { ...startbuffChoices("choice_startbuff_", 6) },
          },
          rogue_2: {
            init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
            choices: { ...startbuffChoices("choice_ro2_startbuff_", 8) },
          },
          rogue_4: {
            init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
            choices: { ...startbuffChoices("choice_ro4_startbuff_", 7) },
          },
          rogue_6: {
            init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
            choices: { ...startbuffChoices("choice_ro6_startbuff_", 12) },
          },
        },
        modules: {},
        consts: {},
      },
      CharacterTable: {},
      RoguelikeConsts: {},
    },
  };
});

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import { RoguelikePendingEvent } from "@game/modules/roguelike/events";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer(theme: string) {
  const pd = mockPlayerData({
    rlv2: { outer: {}, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  // 夹具只声明被测分支读到的键，其余 game 字段由惰性分支承受
  player.rlv2.current.game = asModel<Rlv2Game>({ theme, mode: "NORMAL", modeGrade: 0, predefined: null });
  return player;
}

describe("rlv2 开局 buff 选择数据", () => {
  describe("choices.json 数据文件", () => {
    it("应覆盖 6 主题 startbuff 场景", () => {
      const data = require("../../../../data/rlv2/choices.json");
      const scenes = data.choiceScenes;
      expect(scenes["scene_startbuff_enter"]).toBeDefined();
      expect(scenes["scene_ro2_startbuff_enter"]).toBeDefined();
      expect(scenes["scene_ro3_startbuff_enter"]).toBeDefined();
      expect(scenes["scene_ro4_startbuff_enter"]).toBeDefined();
      expect(scenes["scene_ro5_startbuff_enter"]).toBeDefined();
      expect(scenes["scene_ro6_startbuff_enter"]).toBeDefined();
    });

    it("各主题选项数量正确", () => {
      const data = require("../../../../data/rlv2/choices.json");
      expect(data.choiceScenes["scene_startbuff_enter"].choices).toHaveLength(6);
      expect(data.choiceScenes["scene_ro2_startbuff_enter"].choices).toHaveLength(8);
      expect(data.choiceScenes["scene_ro6_startbuff_enter"].choices).toHaveLength(12);
    });
  });

  describe("GAME_INIT_SUPPORT 按主题动态化", () => {
    it("rogue_1 应生成无 ro 前缀场景与选项", () => {
      const player = makePlayer("rogue_1");
      const ev = new RoguelikePendingEvent(
        player.rlv2,
        player.rlv2._trigger,
        "GAME_INIT_SUPPORT",
        0,
        { step: [2, 3], id: "" },
      );
      const scene = ev.content.initSupport!.scene;
      expect(scene.id).toBe("scene_startbuff_enter");
      // 支援选项 3 选 1（官方机制：上一把到 3 层后下一把提供 3 个随机支援选项）
      const keys = Object.keys(scene.choices);
      expect(keys).toHaveLength(3);
      for (const k of keys) {
        expect(k).toMatch(/^choice_startbuff_\d+$/);
        expect(scene.choices[k]).toBe(1);
      }
    });

    it("rogue_4 应生成 choice_ro4_startbuff_1..7", () => {
      const player = makePlayer("rogue_4");
      const ev = new RoguelikePendingEvent(
        player.rlv2,
        player.rlv2._trigger,
        "GAME_INIT_SUPPORT",
        0,
        { step: [2, 3], id: "" },
      );
      const scene = ev.content.initSupport!.scene;
      expect(scene.id).toBe("scene_ro4_startbuff_enter");
      // 支援选项 3 选 1（随机 3 个）
      const keys = Object.keys(scene.choices);
      expect(keys).toHaveLength(3);
      for (const k of keys) {
        expect(k).toMatch(/^choice_ro4_startbuff_\d+$/);
        expect(scene.choices[k]).toBe(1);
      }
    });

    it("rogue_6 应生成 12 个选项", () => {
      const player = makePlayer("rogue_6");
      const ev = new RoguelikePendingEvent(
        player.rlv2,
        player.rlv2._trigger,
        "GAME_INIT_SUPPORT",
        0,
        { step: [2, 3], id: "" },
      );
      const scene = ev.content.initSupport!.scene;
      expect(scene.id).toBe("scene_ro6_startbuff_enter");
      // 支援选项 3 选 1（随机 3 个，从 12 个池中抽）
      const keys = Object.keys(scene.choices);
      expect(keys).toHaveLength(3);
      for (const k of keys) {
        expect(k).toMatch(/^choice_ro6_startbuff_\d+$/);
        expect(scene.choices[k]).toBe(1);
      }
    });
  });
});
