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
        rogue_4: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL", initialBandRelic: ["rogue_4_band_1", "rogue_4_band_2"] }],
          items: {},
          relics: { rogue_4_band_1: { id: "rogue_4_band_1", buffs: [] }, rogue_4_band_2: { id: "rogue_4_band_2", buffs: [] } },
          bandRef: {
            rogue_4_band_1: { itemId: "rogue_4_band_1", bandLevel: 0, normalBandId: "rogue_4_band_1" },
            rogue_4_band_2: { itemId: "rogue_4_band_2", bandLevel: 1, normalBandId: "rogue_4_band_1" },
          },
        },
        rogue_6: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL", initialBandRelic: ["rogue_6_band_1", "rogue_6_band_3"] }],
          items: {
            rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: "NONE" },
            rogue_6_population: { id: "rogue_6_population", type: "POPULATION", rarity: "NONE" },
            rogue_6_exp: { id: "rogue_6_exp", type: "EXP", rarity: "NONE" },
            rogue_6_hpmax: { id: "rogue_6_hpmax", type: "HPMAX", rarity: "NONE" },
          },
          relics: {
            rogue_6_band_1: { id: "rogue_6_band_1", buffs: [{ key: "immediate_reward", blackboard: [{ key: "id", valueStr: "rogue_6_hpmax" }, { key: "count", value: 2 }] }] },
            rogue_6_band_3: { id: "rogue_6_band_3", buffs: [] },
            // 襁褓生灵（开局礼物 init_gift 数据源）
            rogue_6_legacy_01: { id: "rogue_6_legacy_01", buffs: [{ key: "init_gift", blackboard: [{ key: "id", value: 0, valueStr: "rogue_6_gold" }, { key: "count", value: 5, valueStr: null }] }] },
            rogue_6_legacy_02: { id: "rogue_6_legacy_02", buffs: [{ key: "init_gift", blackboard: [{ key: "id", value: 0, valueStr: "rogue_6_population" }, { key: "count", value: 1, valueStr: null }] }] },
          },
          bandRef: {
            rogue_6_band_1: { itemId: "rogue_6_band_1", bandLevel: 0, normalBandId: "rogue_6_band_1" },
            rogue_6_band_3: { itemId: "rogue_6_band_3", bandLevel: 0, normalBandId: "rogue_6_band_3" },
          },
          choices: {
            choice_ro6_startbuff_1: { id: "choice_ro6_startbuff_1", displayData: { type: "NORMAL" }, description: "获得1件普通收藏品" },
            choice_ro6_startbuff_2: { id: "choice_ro6_startbuff_2", displayData: { type: "NORMAL", itemID: "rogue_6_gold" }, description: "获得<@ro6.get>8</>源石锭" },
          },
          detailConst: { playerLevelTable: { 2: { exp: 10, populationUp: 4 } } },
          recruitTickets: {},
        },
        rogue_3: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL", initRelic: {}, initRecruit: {} }],
          milestones: [
            { id: "bp_level_1", level: 1, tokenNum: 200, itemID: "4001", itemType: "GOLD", itemCount: 100 },
            { id: "bp_level_2", level: 2, tokenNum: 400, itemID: "30155", itemType: "MATERIAL", itemCount: 2 },
          ],
          taskData: {
            rogue_3_task_001: { taskId: "rogue_3_task_001", rewardSceneId: "scene_ro3_taskreward1_enter" },
          },
          choices: {
            choice_ro3_taskreward1_1: { id: "choice_ro3_taskreward1_1", nextSceneId: null },
            choice_ro3_taskreward1_2: { id: "choice_ro3_taskreward1_2", nextSceneId: null },
          },
          items: {
            rogue_3_gold: { id: "rogue_3_gold", type: "GOLD", rarity: "NONE" },
            rogue_3_relic_a01: { id: "rogue_3_relic_a01", type: "RELIC", rarity: "NORMAL", canSacrifice: true, value: 8 },
            rogue_3_relic_a02: { id: "rogue_3_relic_a02", type: "RELIC", rarity: "NORMAL", canSacrifice: true, value: 8 },
            rogue_3_relic_b01: { id: "rogue_3_relic_b01", type: "RELIC", rarity: "RARE", canSacrifice: true, value: 12 },
          },
          recruitTickets: {},
        },
        rogue_2: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL", initRelic: {}, initRecruit: {} }],
          items: { rogue_2_gold: { id: "rogue_2_gold", type: "GOLD", rarity: "NONE" } },
        },
        rogue_1: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL", initRelic: {}, initRecruit: {}, initialBandRelic: ["rogue_1_band_1", "rogue_1_band_2"] }],
          items: {
            rogue_1_gold: { id: "rogue_1_gold", type: "GOLD", rarity: "NONE" },
            rogue_1_hp: { id: "rogue_1_hp", type: "HP", rarity: "NONE" },
            rogue_1_squad_capacity: { id: "rogue_1_squad_capacity", type: "SQUAD_CAPACITY", rarity: "NONE" },
            rogue_1_exp: { id: "rogue_1_exp", type: "EXP", rarity: "NONE" },
          },
          detailConst: { playerLevelTable: { 2: { exp: 10, populationUp: 4 }, 3: { exp: 24, populationUp: 4 } } },
          relics: {
            rogue_1_band_1: { id: "rogue_1_band_1", buffs: [{ key: "level_life_point_add", blackboard: [{ key: "value", value: 4 }] }] },
            rogue_1_band_2: {
              id: "rogue_1_band_2",
              buffs: [
                { key: "immediate_reward", blackboard: [{ key: "id", valueStr: "rogue_1_squad_capacity" }, { key: "count", value: 2 }] },
                { key: "level_char_limit_add", blackboard: [{ key: "value", value: 2 }] },
              ],
            },
          },
          bandRef: {
            rogue_1_band_1: { itemId: "rogue_1_band_1", bandLevel: 0, normalBandId: "rogue_1_band_1" },
            rogue_1_band_2: { itemId: "rogue_1_band_2", bandLevel: 0, normalBandId: "rogue_1_band_2" },
          },
        },
      },
      modules: {
        rogue_3: {},
        rogue_1: {},
        rogue_2: {
          dice: {
            dice: { rogue_2_dice_1: { diceFaceCount: 6 } },
            diceEvents: {
              rogue_2_diceEve_1: { showType: "VIRTUE" },
              rogue_2_diceEve_2: { showType: "KEY" },
            },
          },
        },
        rogue_4: { moduleTypes: ["FRAGMENT", "DISASTER", "NODE_UPGRADE"] },
        rogue_6: {
          moduleTypes: ["GRID_ZONE", "WEATHER", "SCRAP"],
          weather: {
            mainWeatherData: { rogue_6_weather_1_a: { id: "rogue_6_weather_1_a", level: 1 } },
            subWeatherData: { rogue_6_subweather_1: { id: "rogue_6_subweather_1" } },
          },
          scrap: { scrapItemToType: {} },
        },
      },
      customizeData: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    GameDataConst: { maxLevel: [[], [], [], [], [], []] },
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { EventMap } from "@game/kernel/events";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type {
  PlayerRoguelikeV2,
  PlayerRoguelikeV2Zone,
  PlayerRoguelikePendingEvent,
} from "@game/modules/roguelike/rlv2-model";
import type { RoguelikePendingEvent } from "@game/modules/roguelike/events";
import { mockPlayerData, asModel, type MockSeed } from "../../../helpers";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/** 局外数据种子（`makePlayer` 形参）：生成模型的深可选视图 */
type OuterSeed = MockSeed<PlayerDataModel["rlv2"]["outer"][string]>;

/**
 * 待处理事件入队夹具视图
 *
 * `_pending._pending` 的元素是 `RoguelikePendingEvent` class（用例历史写法直接 push 字面量：
 * 队列只按 `type`/`content` 读取）。生成模型 `Content` 的子树多为必填，而夹具只声明被测分支
 * 会读到的键，故入参按深可选视图表达，并在入队处做一次单向断言（不改夹具数据）。
 */
interface PendingEventFixture {
  type: string;
  content?: MockSeed<PlayerRoguelikePendingEvent.Content>;
}

/** 按 {@link PendingEventFixture} 的说明入队一个夹具事件 */
function pushPendingEvent(queue: RoguelikePendingEvent[], event: PendingEventFixture): void {
  queue.push(event as RoguelikePendingEvent);
}

/** rlv2:event:create 的 SCENE 载荷视图（emit 第二参数，见 events.ts 的事件构造器） */
interface SceneEventPayload {
  scene: { id: string; choices: { [key: string]: number } };
}

/** rlv2:event:create 的 BATTLE 载荷视图（本用例只读 state） */
interface BattleEventPayload {
  state: number;
}

/**
 * 结算 brief 读取视图
 *
 * GAME_SETTLE 载荷的 brief 由 settle.ts#buildSettlement 构造，含生成模型
 * `PlayerRoguelikePendingEvent.EndingBrief` 未声明的键（over / endProperty，见该文件的
 * brief 字面量）。本用例只读取这些字段，故就地声明读取视图，不改夹具数据。
 */
interface SettleBriefView {
  over?: boolean;
  band?: string;
  endZoneId?: string;
  endProperty?: {
    hp: number;
    gold: number;
    populationCost: number;
    populationMax: number;
    san: number;
  };
}

/** 结算 record 读取视图（cntArrivedNode 见 settle.ts 的 record 字面量，生成模型未声明） */
interface SettleRecordView {
  cntArrivedNode?: number;
}

function makePlayer(outer: OuterSeed = {}) {
  const pd = mockPlayerData({
    rlv2: {
      outer: { rogue_3: outer },
      current: {},
      pinned: {} as string,
    },
    inventory: {},
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  return new PlayerDataManager(pd._playerdata);
}

describe("rlv2 完整机制（2026-08-10 补全）", () => {
  let player: PlayerDataManager;

  beforeEach(() => {
    player = makePlayer({
      bank: { show: true, current: 10, record: 10, reward: {}, totalPut: 10 },
      bp: { point: 500, reward: {} },
      buff: { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0 },
    });
    // 模拟进行中的游戏
    player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_3", mode: "NORMAL", modeGrade: 0 });
  });

  describe("battlePassGetReward（战令领奖）", () => {
    it("应发放里程碑物品并标记已领", async () => {
      const emitSpy = vi.spyOn(player._trigger, "emit");
      const ret = await player.rlv2.battlePassGetReward("rogue_3", ["bp_level_1", "bp_level_2"]);
      expect(ret.items).toEqual([
        { type: "GOLD", id: "4001", count: 100 },
        { type: "MATERIAL", id: "30155", count: 2 },
      ]);
      expect(player._playerdata.rlv2.outer.rogue_3.bp.reward.bp_level_1).toBe(1);
      expect(player._playerdata.rlv2.outer.rogue_3.bp.reward.bp_level_2).toBe(1);
      const itemsGet = emitSpy.mock.calls.filter(
        (c): c is ["items:get", EventMap["items:get"]] => c[0] === "items:get",
      );
      expect(itemsGet).toHaveLength(1);
    });

    it("重复领取应跳过（已领标记）", async () => {
      player.rlv2.outer.rogue_3.bp.reward.bp_level_1 = 1;
      const ret = await player.rlv2.battlePassGetReward("rogue_3", ["bp_level_1"]);
      expect(ret.items).toEqual([]);
    });
  });

  describe("bankPut / bankWithdraw（银行）", () => {
    it("bankPut 应扣 1 金币并增加 current/totalPut 刷新 record", async () => {
      // 修复：存钱需有 1 金币余额（原实现免费存 → 循环刷金币）
      player.rlv2._status.property.gold = 10;
      const goldBefore = player.rlv2._status.property.gold;
      await player.rlv2.bankPut();
      const bank = player._playerdata.rlv2.outer.rogue_3.bank;
      expect(bank.current).toBe(11);
      expect(bank.totalPut).toBe(11);
      expect(bank.record).toBe(11);
      // 修复：存钱扣 1 金币（原实现免费存 → put/withdraw 循环刷金币）
      expect(player.rlv2._status.property.gold).toBe(goldBefore - 1);
      expect(player.rlv2._status.status.bankPut).toBe(1);
    });

    it("bankPut 金币不足应拒绝（不增不扣）", async () => {
      player.rlv2._status.property.gold = 0;
      await player.rlv2.bankPut();
      const bank = player._playerdata.rlv2.outer.rogue_3.bank;
      expect(bank.current).toBe(10);
      expect(player.rlv2._status.property.gold).toBe(0);
    });

    it("bankWithdraw 应减少 current 并增加金币", async () => {
      const goldBefore = player.rlv2._status.property.gold;
      await player.rlv2.bankWithdraw({ count: 4 });
      expect(player._playerdata.rlv2.outer.rogue_3.bank.current).toBe(6);
      expect(player.rlv2._status.property.gold).toBe(goldBefore + 4);
    });

    it("bankWithdraw 超额应钳制到 bank.current", async () => {
      await player.rlv2.bankWithdraw({ count: 999 });
      expect(player._playerdata.rlv2.outer.rogue_3.bank.current).toBe(0);
    });
  });

  describe("nodeMission（节点任务）", () => {
    it("confirm 应置 state=2 并生成任务奖励 SCENE", async () => {
      player.rlv2._status.nodeMission = {
        id: "rogue_3_task_001",
        state: 1,
        tip: true,
        progress: [2, 4],
      };
      const emitSpy = vi.spyOn(player._trigger, "emit");
      await player.rlv2.nodeMissionConfirm();
      expect(player.rlv2._status.nodeMission.state).toBe(2);
      const sceneCalls = emitSpy.mock.calls.filter(
        (c): c is ["rlv2:event:create", EventMap["rlv2:event:create"]] =>
          c[0] === "rlv2:event:create" && c[1][0] === "SCENE",
      );
      expect(sceneCalls).toHaveLength(1);
      const scene = sceneCalls[0][1][1] as SceneEventPayload;
      expect(scene.scene.id).toBe("scene_ro3_taskreward1_enter");
      expect(scene.scene.choices).toHaveProperty("choice_ro3_taskreward1_1");
      expect(player.rlv2._status.state).toBe("PENDING");
    });

    it("giveUp 应置 state=3 并回到 WAIT_MOVE", async () => {
      player.rlv2._status.nodeMission = { id: "t1", state: 1, tip: true, progress: [] };
      await player.rlv2.nodeMissionGiveUp();
      expect(player.rlv2._status.nodeMission.state).toBe(3);
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
    });

    it("closeTip 应置 tip=false", async () => {
      player.rlv2._status.nodeMission = { id: "t1", state: 1, tip: true, progress: [] };
      await player.rlv2.nodeMissionCloseTip();
      expect(player.rlv2._status.nodeMission.tip).toBe(false);
    });
  });

  describe("readEndingChange / confirmZoneReward / confirmTraderReturn", () => {
    it("readEndingChange 应清 chgEnding 并回到 WAIT_MOVE", async () => {
      player.rlv2._status.chgEnding = true;
      await player.rlv2.readEndingChange();
      expect(player.rlv2._status.chgEnding).toBe(false);
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
    });

    it("confirmZoneReward 应发放 zoneReward 物品并清空", async () => {
      player.rlv2._status.zoneReward = {
        z0: { id: "rogue_3_gold", count: 5, instId: "" },
      };
      const emitSpy = vi.spyOn(player._trigger, "emit");
      await player.rlv2.confirmZoneReward();
      const getItems = emitSpy.mock.calls.filter(
        (c): c is ["rlv2:get:items", EventMap["rlv2:get:items"]] => c[0] === "rlv2:get:items",
      );
      expect(getItems).toHaveLength(1);
      expect(getItems[0][1][0][0]).toEqual({ id: "rogue_3_gold", count: 5 });
      expect(player.rlv2._status.zoneReward).toBeUndefined();
    });

    it("confirmTraderReturn 应发放 traderReturn 物品并清空", async () => {
      player.rlv2._status.traderReturn = {
        t0: { id: "rogue_3_gold", count: 3, instId: "" },
      };
      await player.rlv2.confirmTraderReturn();
      expect(player.rlv2._status.traderReturn).toBeUndefined();
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
    });
  });

  describe("expeditionChoice / assist / shopBattle", () => {
    it("expeditionChoice 应写入 troop.expedition", async () => {
      player.rlv2.troop.expedition = [];
      const ret = await player.rlv2.expeditionChoice({ choice: "7,8", leave: 0 });
      expect(ret.result).toBe(1);
      expect(player.rlv2.troop.expedition).toEqual(["7", "8"]);
    });

    it("getTicketAssistList 应关闭助战标记", async () => {
      player.rlv2.inventory!.recruit["t_0"] = asModel<PlayerRoguelikeV2.CurrentData.Recruit>({
        index: "t_0",
        id: "rogue_3_recruit_ticket_pioneer",
        state: 1,
        list: [],
        result: null,
        ts: 0,
        from: "initial",
        mustExtra: 0,
        needAssist: true,
      });
      await player.rlv2.getTicketAssistList({ ticketIndex: "t_0", profession: "PIONEER" });
      expect(player.rlv2.inventory!.recruit["t_0"].needAssist).toBe(false);
    });

    it("shopBattleStart 应生成 BATTLE 事件", async () => {
      const emitSpy = vi.spyOn(player._trigger, "emit");
      await player.rlv2.shopBattleStart();
      const battleCalls = emitSpy.mock.calls.filter(
        (c): c is ["rlv2:event:create", EventMap["rlv2:event:create"]] =>
          c[0] === "rlv2:event:create" && c[1][0] === "BATTLE",
      );
      expect(battleCalls).toHaveLength(1);
      expect((battleCalls[0][1][1] as BattleEventPayload).state).toBe(0);
    });
  });

  describe("rerollNode / upgradeNode / stash / exploreTool", () => {
    it("rerollNode 应消费刷新次数并重掷节点类型", async () => {
      player.rlv2._status.cursor = { zone: 1, position: null };
      player.rlv2._map.zones = asModel<{ [key: string]: PlayerRoguelikeV2Zone }>({
        1: { id: "zone_1", nodes: { "200": { index: "200", pos: { x: 2, y: 0 }, type: 1, refresh: { usedCount: 0, count: 1, cost: 1 } } } },
      });
      await player.rlv2.rerollNode({ nodeIndex: "200" });
      const node = player.rlv2._map.zones[1].nodes["200"];
      expect(node.refresh!.usedCount).toBe(1);
      expect(node.type).toBeGreaterThanOrEqual(1);
    });

    it("upgradeNode 应转发到 nodeUpgrade 模块", async () => {
      const emitSpy = vi.spyOn(player._trigger, "emit");
      await player.rlv2.upgradeNode({ nodeType: "REST" });
      const calls = emitSpy.mock.calls.filter(
        (c): c is ["rlv2:node:upgrade", EventMap["rlv2:node:upgrade"]] => c[0] === "rlv2:node:upgrade",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual(["REST"]);
    });

    it("stashRecruitTicket 应关闭票（state=3）", async () => {
      player.rlv2.inventory!.recruit["t_0"] = asModel<PlayerRoguelikeV2.CurrentData.Recruit>({
        index: "t_0", id: "t1", state: 1, list: [{}], result: null, ts: 0, from: "battle", mustExtra: 0, needAssist: false,
      });
      await player.rlv2.stashRecruitTicket({ index: "t_0" });
      expect(player.rlv2.inventory!.recruit["t_0"].state).toBe(3);
      expect(player.rlv2.inventory!.recruit["t_0"].list).toHaveLength(0);
    });
  });
});

/** 等待构造期 rlv2:init（未 await）完成，避免异步重置状态 */
async function readyPlayer(theme: string) {
  const player = makePlayer();
  player.rlv2.current.game = asModel<Rlv2Game>({ theme, mode: "NORMAL", modeGrade: 0 });
  await new Promise((r) => setTimeout(r, 0));
  await player.rlv2._pool.create();
  return player;
}

describe("真实机制补全（2026-08-10 第二轮）", () => {
  describe("diceChoice 真实 DICE 结算", () => {
    it("LEAVE 应发放奖励并消费 DICE 事件", async () => {
      const player = await readyPlayer("rogue_2");
      // 注入 DICE pending 事件
      pushPendingEvent(player.rlv2._status._pending._pending, {
        type: "DICE",
        content: { dice: { result: { diceEventId: "rogue_2_diceEve_1", diceRoll: 3 }, rerollCount: 0 } },
      });
      const emitSpy = vi.spyOn(player._trigger, "emit");
      const ret = await player.rlv2.diceChoice({ choice: "LEAVE" });
      expect(ret.result).toBe(1);
      expect(player.rlv2._status.pending.length).toBe(0);
      const items = emitSpy.mock.calls.filter(
        (c): c is ["rlv2:get:items", EventMap["rlv2:get:items"]] => c[0] === "rlv2:get:items",
      );
      expect(items.length).toBeGreaterThan(0);
    });

    it("REROLL 应重新生成骰子结果并保留 DICE 事件", async () => {
      const player = await readyPlayer("rogue_2");
      pushPendingEvent(player.rlv2._status._pending._pending, {
        type: "DICE",
        content: { dice: { result: { diceEventId: "", diceRoll: 1 }, rerollCount: 0 } },
      });
      await player.rlv2.diceChoice({ choice: "REROLL" });
      expect(player.rlv2._status.pending.length).toBe(1);
      const dice = player.rlv2._status.pending[0].content.dice!;
      expect(dice.rerollCount).toBe(1);
      expect(dice.result.diceEventId).not.toBe("");
    });
  });

  describe("sacrificeChoice 真实献祭", () => {
    it("应发放献祭回报并关闭事件", async () => {
      const player = await readyPlayer("rogue_3");
      pushPendingEvent(player.rlv2._status._pending._pending, {
        type: "SACRIFICE",
        content: { sacrifice: { type: 0 } },
      });
      const emitSpy = vi.spyOn(player._trigger, "emit");
      await player.rlv2.sacrificeChoice({ choice: "1", leave: 0 });
      expect(player.rlv2._status.pending.length).toBe(0);
      const relicGain = emitSpy.mock.calls.filter(
        (c): c is ["rlv2:relic:gain", EventMap["rlv2:relic:gain"]] => c[0] === "rlv2:relic:gain",
      );
      // 池空时回退金币
      expect(
        relicGain.length +
          emitSpy.mock.calls.filter(
            (c): c is ["rlv2:get:items", EventMap["rlv2:get:items"]] => c[0] === "rlv2:get:items",
          ).length,
      ).toBeGreaterThan(0);
    });

    it("leave 应直接关闭事件", async () => {
      const player = await readyPlayer("rogue_3");
      pushPendingEvent(player.rlv2._status._pending._pending, { type: "SACRIFICE", content: {} });
      await player.rlv2.sacrificeChoice({ choice: "", leave: 1 });
      expect(player.rlv2._status.pending.length).toBe(0);
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
    });
  });

  describe("zoneReward / traderReturn 实际填充", () => {
    it("checkZoneEnd 推进层数时应填充 zoneReward", async () => {
      const player = await readyPlayer("rogue_3");
      player.rlv2._status.cursor.zone = 1;
      player.rlv2._status.cursor.position = { x: 3, y: 0 };
      player.rlv2._map.zones[1] = asModel<PlayerRoguelikeV2Zone>({ nodes: { "300": { zone_end: true } } });
      await player.rlv2.checkZoneEnd();
      expect(player.rlv2._status.zoneReward).toBeTruthy();
    });

    it("leaveShop 应填充 traderReturn", async () => {
      const player = await readyPlayer("rogue_3");
      await player.rlv2.leaveShop();
      expect(player.rlv2._status.traderReturn).toBeTruthy();
    });
  });
});

describe("分队机制（2026-08-11）", () => {
  it("chooseInitialRelic 应应用分队生命加成（level_life_point_add）", async () => {
    const player = await readyPlayer("rogue_1");
    // 注入 GAME_INIT_RELIC 事件
    pushPendingEvent(player.rlv2._status._pending._pending, {
      type: "GAME_INIT_RELIC",
      content: { initRelic: { items: { "0": { id: "rogue_1_band_1", count: 1 } } } },
    });
    player.rlv2._status.property.hp = { current: 4, max: 4 };
    await player.rlv2.chooseInitialRelic({ select: "0" });
    expect(player.rlv2._status.property.hp.max).toBe(8);
    expect(player.rlv2._status.property.hp.current).toBe(8);
  });

  it("chooseInitialRelic 分队 level_char_limit_add（可部署人数）不作用于希望上限 population.max", async () => {
    const player = await readyPlayer("rogue_1");
    pushPendingEvent(player.rlv2._status._pending._pending, {
      type: "GAME_INIT_RELIC",
      content: { initRelic: { items: { "0": { id: "rogue_1_band_2", count: 1 } } } },
    });
    player.rlv2._status.property.population.max = 6;
    await player.rlv2.chooseInitialRelic({ select: "0" });
    // 2026-08-18 对齐官服：level_char_limit_add（可部署人数）是战斗内上限，
    // 开局 population.max（希望上限）不受影响（8-11 官服 createGame popMax=6=init）
    expect(player.rlv2._status.property.population.max).toBe(6);
  });

  it("ensureOuterTheme 应初始化 collect.band 分队解锁状态", async () => {
    const player = await readyPlayer("rogue_1");
    // 新主题 outer 无 collect（该主题 outer 子对象此时尚未创建，`?.` 令 delete 成为 no-op）→ createGame 路径初始化
    delete (player.rlv2.outer.rogue_1 as Partial<PlayerRoguelikeV2.OuterData> | undefined)?.collect;
    player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_1", mode: "NORMAL", modeGrade: 0 });
    await player.rlv2.createGame({ theme: "rogue_1", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    const collect = player.rlv2.outer.rogue_1.collect;
    expect(collect.band).toBeTruthy();
    expect(Object.keys(collect.band).length).toBeGreaterThan(0);
    // 开局可选分队应已解锁
    expect(Object.values(collect.band).every((b) => b.state === 1)).toBe(true);
  });
});

describe("结算（GAME_SETTLE）与藏品（2026-08-11）", () => {
  it("giveUpGame 应生成 GAME_SETTLE 结算事件", async () => {
    const player = await readyPlayer("rogue_1");
    player.rlv2._status.state = "PENDING";
    player.rlv2._status.cursor.zone = 1;
    player.rlv2._bandId = "rogue_1_band_1";
    await player.rlv2.giveUpGame();
    const pend = player.rlv2._status.pending;
    const settle = pend.find((e) => e.type === "GAME_SETTLE");
    expect(settle).toBeDefined();
    const content = settle!.content;
    expect(content.success).toBe(0);
    const brief = content.result!.brief as SettleBriefView;
    expect(brief.over).toBe(true);
    expect(brief.band).toBe("rogue_1_band_1");
    expect(brief.endZoneId).toBe("zone_1");
    expect(brief.endProperty).toBeDefined();
    expect((content.result!.record as SettleRecordView).cntArrivedNode).toBeDefined();
  });

  it("藏品库存应以 index（r_N）为键", async () => {
    const player = await readyPlayer("rogue_1");
    pushPendingEvent(player.rlv2._status._pending._pending, {
      type: "GAME_INIT_RELIC",
      content: { initRelic: { items: { "0": { id: "rogue_1_band_1", count: 1 } } } },
    });
    await player.rlv2.chooseInitialRelic({ select: "0" });
    const relic = player.rlv2.inventory!.relic;
    const keys = Object.keys(relic);
    expect(keys[0]).toMatch(/^r_\d+$/);
    expect(relic[keys[0]].id).toBe("rogue_1_band_1");
    expect(relic[keys[0]].index).toBe(keys[0]);
  });
});

describe("指挥等级/经验（2026-08-11 文档对齐）", () => {
  it("战斗经验结算应升级并正确提升属性（无 NaN）", async () => {
    const player = await readyPlayer("rogue_1");
    player.rlv2._status.property.exp = 0;
    player.rlv2._status.property.level = 1;
    player.rlv2._status.property.capacity = 6;
    player.rlv2._status.property.population.max = 6;
    player.rlv2._status.property.hp = { current: 10, max: 10 };
    // 发 15 exp → 升到 2 级（需求 10，剩 5）
    await player.rlv2._trigger.emit("rlv2:get:items", [
      [{ id: "rogue_1_exp", count: 15 }],
    ]);
    const p = player.rlv2._status.property;
    expect(p.level).toBe(2);
    expect(p.exp).toBe(5);
    // 2 级效果：希望+4（populationUp）→ population.max 10；数量+0（squadCapacityUp 缺省）
    expect(p.population.max).toBe(10);
    expect(p.capacity).toBe(6);
    // rogue_1 无 maxHpUp → HP 不 NaN
    expect(Number.isNaN(p.hp.max)).toBe(false);
    expect(Number.isNaN(p.hp.current)).toBe(false);
  });

  it("finishBattleReward 不再重复发放经验（经验已在 battleFinish 即时入账，对齐官服）", async () => {
    const player = await readyPlayer("rogue_1");
    player.rlv2._status.property.exp = 0;
    player.rlv2._status.property.level = 1;
    // 注入 BATTLE_REWARD 事件（含 earn.exp 10）
    pushPendingEvent(player.rlv2._status._pending._pending, {
      type: "BATTLE_REWARD",
      content: { battleReward: { rewards: [], earn: { exp: 10, hp: 0 }, show: "1", state: 0, isPerfect: 0 } },
    });
    await player.rlv2.finishBattleReward({});
    // exp 已在 battleFinish 入账；finishBattleReward 不再二次发放（避免双重升级）
    expect(player.rlv2._status.property.level).toBe(1);
    expect(player.rlv2._status.property.exp).toBe(0);
    expect(player.rlv2._status.pending.length).toBe(0);
  });
});

describe("rogue_6 开局礼物/分队隐藏/选项效果（2026-08-11）", () => {
  it("rogue_6 createGame 应包含 GAME_INIT_GIFT 且 finishEvent 发放礼物（init_gift 数据驱动）", async () => {
    const player = await readyPlayer("rogue_6");
    // 上一把持有襁褓猫+狗 → 开局礼物 = 金+5 / 希望+1（非固定金+10/人口+1）
    player.rlv2.outer.rogue_6 = asModel<PlayerRoguelikeV2.OuterData>({
      record: { legacy: ["rogue_6_legacy_01", "rogue_6_legacy_02"] },
      collect: { band: {} },
      buff: { unlocked: {}, score: 0 },
    });
    await player.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    const pend = player.rlv2._status.pending;
    const gift = pend.find((e) => e.type === "GAME_INIT_GIFT");
    expect(gift).toBeDefined();
    expect(gift!.content.initGift!.items).toEqual([
      { id: "rogue_6_gold", count: 5 },
      { id: "rogue_6_population", count: 1 },
    ]);
    // 先消费 RELIC（chooseInitialRelic），再 finishEvent 应发放礼物（金 +5 / 人口 +1）
    await player.rlv2.chooseInitialRelic({ select: "0" });
    player.rlv2._status.property.gold = 8;
    player.rlv2._status.property.population.max = 6;
    await player.rlv2.finishEvent();
    expect(player.rlv2._status.property.gold).toBe(13);
    expect(player.rlv2._status.property.population.max).toBe(7);
    expect(player.rlv2._status.pending.find((e) => e.type === "GAME_INIT_GIFT")).toBeUndefined();
  });

  it("collect.band 升级变体应 state 0 隐藏（bandLevel > 0）", async () => {
    const player = await readyPlayer("rogue_4");
    player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_4", mode: "NORMAL", modeGrade: 0 });
    player.rlv2.ensureOuterTheme("rogue_4");
    const band = player.rlv2.outer.rogue_4.collect.band;
    // band_1 是基础（level 0），band_2 是 band_1 的 level 1 变体
    expect(band["rogue_4_band_1"].state).toBe(1);
    expect(band["rogue_4_band_2"].state).toBe(0);
  });

  it("selectChoice startbuff 应读取 displayData.itemID（PascalCase）", async () => {
    const player = await readyPlayer("rogue_6");
    await player.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    player.rlv2._status.pending.splice(0);
    pushPendingEvent(player.rlv2._status._pending._pending, {
      type: "GAME_INIT_SUPPORT",
      content: { initSupport: { step: [2, 5], scene: { id: "scene_ro6_startbuff_enter", choices: {} } } },
    });
    player.rlv2._status.property.gold = 0;
    await player.rlv2.selectChoice({ choice: "choice_ro6_startbuff_2" });
    expect(player.rlv2._status.property.gold).toBe(8);
  });
});
