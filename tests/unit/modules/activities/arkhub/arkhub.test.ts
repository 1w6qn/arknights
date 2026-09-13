/**
 * 奇象巡展（ARK_HUB）Phase 1 实现单测：活动播种、8 类任务模板、3 枚勋章模板、
 * arkhub 玩法事件入口（结算/每日物资/生物收录）。2026-08-17。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CharacterData, StageData } from "@excel/types_excel_gen";

/** 物品表窄视图行（门面 getItem 只取 name 回退；itemType 供用例断言原样保留） */
interface MockItemRow {
  itemType: string;
  name?: string;
}
import type { PlayerPerMedal } from "@excel/types-playerdata";
import { TypedEventEmitter } from "@game/kernel/events/runtime";

// ---- excel mock（ActivityTable.missionData 用官服真实形状的子集）----
vi.mock("@excel/excel", () => {
  return {
    default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

      ActivityTable: {
        basicInfo: {
          act1arkhub: {
            id: "act1arkhub", type: "ARK_HUB", name: "奇象巡展",
            startTime: 1786176000, endTime: 1788465599, rewardEndTime: 1788724799,
            templateShopId: "shop_act1arkhub",
            ungroupedMedalIds: ["medal_activity_1arkhub_01", "medal_activity_1arkhub_02"],
          },
        },
        missionGroup: [
          {
            id: "act1arkhub",
            missionIds: [
              "1arkhubActivity_1", "1arkhubActivity_2", "1arkhubActivity_3",
              "1arkhubActivity_4", "1arkhubActivity_7",
              "1arkhubActivity_9", "1arkhubActivity_12",
              "1arkhubActivity_15", "1arkhubActivity_16",
              "1arkhubActivity_17", "1arkhubActivity_20", "1arkhubActivity_22",
              "53sideActivity_1",
            ],
          },
        ],
        missionData: [
          { id: "1arkhubActivity_1", template: "ArkhubMissionCompleted", param: ["0", "act1arkhub", "capture_catch_guide_01", "1"] },
          { id: "1arkhubActivity_2", template: "ArkhubMissionCompleted", param: ["0", "act1arkhub", "capture_catch_guide_02", "1"] },
          { id: "1arkhubActivity_3", template: "ArkhubMissionCompleted", param: ["0", "act1arkhub", "arkdex_battle_guide", "1"] },
          { id: "1arkhubActivity_4", template: "ArkhubDailyMissionCompleted", param: ["0", "act1arkhub", "2026-08-08 16:00:00", "2026-09-04 03:59:59", "1"] },
          { id: "1arkhubActivity_7", template: "ArkhubDailyMissionCompleted", param: ["0", "act1arkhub", "2026-08-18 16:00:00", "2026-09-04 03:59:59", "1"] },
          { id: "1arkhubActivity_9", template: "ArkhubCreatureCollection", param: ["0", "act1arkhub", "3", "arkhubMissionCollection1"] },
          { id: "1arkhubActivity_12", template: "ArkhubCreatureCollection", param: ["0", "act1arkhub", "1", "arkhubMissionCollection2"] },
          { id: "1arkhubActivity_15", template: "ArkhubCreatureCaptured", param: ["0", "act1arkhub", "1", "2"] },
          { id: "1arkhubActivity_16", template: "ArkhubCreatureExchange", param: ["0", "act1arkhub", "1"] },
          { id: "1arkhubActivity_17", template: "ArkhubPassDexBattle", param: ["0", "act1arkhub", "5", "0"] },
          { id: "1arkhubActivity_20", template: "ArkhubPublishPixelArt", param: ["0", "act1arkhub", "1"] },
          { id: "1arkhubActivity_22", template: "ArkhubCollectPixelArt", param: ["0", "act1arkhub", "5"] },
          // 非 arkhub 模板（如 53side）——播种应保持原行为
          { id: "53sideActivity_1", template: "CollectMaterial", param: ["0", "act53side", "10", "0"] },
        ],
        activity: { aRK_HUB: {} },
      },
      MedalTable: {
        medalList: [
          { medalId: "medal_activity_1arkhub_01", medalName: "巡展印象奖章", template: "ActivityArkhubPixelCollect", unlockParam: ["act1arkhub", "0", "4"] },
          { medalId: "medal_activity_1arkhub_02", medalName: "巡展珍奇奖章", template: "ActivityArkhubCreatureCollect", unlockParam: ["act1arkhub", "arkhubMissionCollection1", "10"] },
          { medalId: "medal_activity_1arkhub_025", medalName: "巡展珍奇奖章", template: "ActivityArkhubAlterCollect", unlockParam: ["act1arkhub", "arkhubMissionCollection1", "10", "1"] },
        ],
        medalTypeData: {},
      },
      StageTable: { stages: {} as Record<string, StageData> },
      MissionTable: { missions: {}, missionGroups: {} },
      ItemTable: {
        items: { act1arkhub_token_seal: { itemType: "ACTIVITY_ITEM" } } as Record<string, MockItemRow>,
      },
      CharWordTable: {},
      GameDataConst: {},
      GachaTable: {},
      CharacterTable: {} as Record<string, CharacterData>,
      ShopClientTable: {},
    },
  };
});

// @utils/time 不 mock——真实 userTimestamp 支持冻结时间（config.developer.timestamp ≤ now 时返回冻结值），
// 与 activity-unlock.test.ts 同款做法：测试通过设置 config.developer 控制播种/门控时间。

import config from "@core/config/index";
import {
  asPlayerManager,
  mockPlayerData,
  mockTypedEventEmitter,
  type MockPlayerDataManager,
} from "../../../../helpers";
import { unlockActivity } from "@game/modules/activities/shared/unlockActivity";
import { MissionProgress } from "@game/modules/mission/logic";
import { MedalProgress } from "@game/modules/medal/medal";
import {
  arkhubOnDuelSettle,
  arkhubOnDailySupply,
  arkhubCreatureCollected,
  arkhubCreatureCaptured,
  arkhubCreatureExchange,
  arkhubPixelCollected,
  ARKHUB_ACT_ID,
  arkhubCompletedGuideFlags,
  arkhubProgressiveGuideFlags,
  arkhubResolveGuideFlags,
  arkhubAdvanceGuide,
  ARKHUB_GUIDE_ACTOR_FLAGS,
  arkhubSetStateMask,
  arkhubRecordSettledDuel,
  arkhubReadGatewayState,
  arkhubIsRewardClaimed,
  arkhubMarkRewardClaimed,
} from "@game/modules/activities/arkhub/public";
import { arkhubBuyProp, arkhubUseProp } from "@game/modules/activities/arkhub/public";

/** 冻结时间（2026-08-15 12:00 +8：活动窗口内、8/18 更新前） */
const FROZEN_TS = 1786766400;
const original = config.developer;

afterEach(() => {
  config.developer = original;
  vi.clearAllMocks();
});

/**
 * 取 ARK_HUB act1arkhub 存档视图
 *
 * 生成类型把 ARK_HUB 子形状声明为全可选，用例夹具保证这些键已写入，故出口断言一次窄视图
 * （视图可赋值给生成类型，属收窄断言，运行期零开销）；避免 30+ 处 `!`。
 * @param player - mock 组合根
 * @returns 存档窄视图（见 {@link ArkHubView}）
 */
function hubOf(player: MockPlayerDataManager): ArkHubView {
  return player._playerdata.activity.ARK_HUB![ARKHUB_ACT_ID] as ArkHubView;
}

describe("unlockActivity 奇象巡展播种", () => {
  function mockPlayer() {
    const reloadActivity = vi.fn().mockResolvedValue(undefined);
    const player = mockPlayerData({
      status: { uid: 1, nickName: "T", nickNumber: 0, level: 1, exp: 0 },
      mission: { missions: { ACTIVITY: {} } },
      medal: { medals: {}, custom: { currentIndex: "", customs: {} } },
      dungeon: { stages: {} },
      arkodc: { topics: {} },
    });
    Object.assign(player._playerdata, { activity: { ARK_HUB: {} } });
    // 组合根 mission 子模块只用到 reloadActivity（unlockActivity 播种后重建监听器）
    Object.assign(player, { mission: { reloadActivity } });
    return { player, reloadActivity };
  }

  it("播种 8 类模板真实进度：引导完成、收集/对战/像素 0/N、非 arkhub 保持原行为", async () => {
    config.developer = { timestamp: FROZEN_TS };
    const { player, reloadActivity } = mockPlayer();
    await unlockActivity(asPlayerManager(player));

    const am = player._playerdata.mission.missions.ACTIVITY;
    // 引导任务：播种即完成（本服引导为完成态）
    expect(am["1arkhubActivity_1"]).toEqual({ state: 2, progress: [{ value: 1, target: 1 }] });
    expect(am["1arkhubActivity_3"]).toEqual({ state: 2, progress: [{ value: 1, target: 1 }] });
    // 每日物资：0/N
    expect(am["1arkhubActivity_4"]).toEqual({ state: 2, progress: [{ value: 0, target: 1 }] });
    // 收集生物/拟合/像素：0/N
    expect(am["1arkhubActivity_9"]).toEqual({ state: 2, progress: [{ value: 0, target: 3 }] });
    expect(am["1arkhubActivity_17"]).toEqual({ state: 2, progress: [{ value: 0, target: 5 }] });
    expect(am["1arkhubActivity_22"]).toEqual({ state: 2, progress: [{ value: 0, target: 5 }] });
    // 非 arkhub 任务：保持原"全可领"行为
    expect(am["53sideActivity_1"]).toEqual({ state: 2, progress: [{ value: 1, target: 1 }] });
    // 播种后重建任务监听器
    expect(reloadActivity).toHaveBeenCalled();
  });

  it("8/18 更新后任务（param 起点在未来）播种为锁定态 state:0", async () => {
    config.developer = { timestamp: FROZEN_TS };
    const { player } = mockPlayer();
    await unlockActivity(asPlayerManager(player));
    const am = player._playerdata.mission.missions.ACTIVITY;
    expect(am["1arkhubActivity_7"]).toEqual({ state: 0, progress: [{ value: 0, target: 1 }] });
  });

  it("播种 ARK_HUB 状态扩展计数器 + ungroupedMedalIds 两枚勋章（025 镀层不播种）", async () => {
    config.developer = { timestamp: FROZEN_TS };
    const { player } = mockPlayer();
    await unlockActivity(asPlayerManager(player));

    const hub = hubOf(player);
    expect(hub.duelCount).toBe(0);
    expect(hub.dailySupplyDays).toBe(0);
    expect(hub.creatureCollected).toBe(0);
    expect(hub.activeCreatureCollected).toBe(0);
    expect(hub.alterCollected).toBe(0);
    expect(hub.pixelCollected).toBe(0);
    expect(hub.pixelPublished).toBe(0);

    const medals = player._playerdata.medal.medals;
    expect(medals["medal_activity_1arkhub_01"]).toEqual({ id: "medal_activity_1arkhub_01", val: [[0, 4]], fts: 0, rts: -1 });
    expect(medals["medal_activity_1arkhub_02"]).toEqual({ id: "medal_activity_1arkhub_02", val: [[0, 10]], fts: 0, rts: -1 });
    expect(medals["medal_activity_1arkhub_025"]).toBeUndefined();
  });

  it("已播种任务不覆盖（存量存档保持不动）", async () => {
    config.developer = { timestamp: FROZEN_TS };
    const { player } = mockPlayer();
    // 存量存档条目含服务端自建键 confirmed（生成类型未声明）：先落到变量再赋值，
    // 避免对象字面量的超额属性检查（运行期值一字未改）。
    const existingMission = { state: 3, progress: [{ value: 3, target: 3 }], confirmed: 1 };
    player._playerdata.mission.missions.ACTIVITY["1arkhubActivity_9"] = existingMission;
    await unlockActivity(asPlayerManager(player));
    const am = player._playerdata.mission.missions.ACTIVITY;
    expect(am["1arkhubActivity_9"]).toEqual({ state: 3, progress: [{ value: 3, target: 3 }], confirmed: 1 });
  });
});

describe("奇象巡展任务模板（MissionProgress + 真实 EventBus）", () => {
  function missionFixture(missionId: string) {
    // 用例直接 emit 事件驱动 MissionProgress 的真实监听器：Emittery 单参约定（载荷元组）
    // 与生产 player._trigger 的类型一致（EventBus 的覆盖签名反而与 emit 调用形态不符）。
    const bus = mockTypedEventEmitter();
    const player = mockPlayerData({
      status: { uid: 1 },
      mission: { missions: { ACTIVITY: { [missionId]: { state: 2, progress: [] } } } },
    });
    Object.assign(player._playerdata, { activity: { ARK_HUB: { act1arkhub: {} } } });
    player._trigger = bus;
    const mission = new MissionProgress(missionId, "ACTIVITY", asPlayerManager(player));
    return { player, bus, mission };
  }

  it("ArkhubCreatureCollection：collectionKey 匹配时取 max，不匹配不推进", async () => {
    const { player, bus, mission } = missionFixture("1arkhubActivity_9");
    await mission.init();
    expect(mission.valid).toBe(true);
    expect(mission.progress[0]).toEqual({ value: 0, target: 3 });
    await bus.emit("ArkhubCreatureCollection", [
      { activityId: ARKHUB_ACT_ID, count: 2, collectionKey: "arkhubMissionCollection1" },
    ]);
    expect(mission.progress[0].value).toBe(2);
    // collectionKey 不匹配（活动频繁）不推进
    await bus.emit("ArkhubCreatureCollection", [
      { activityId: ARKHUB_ACT_ID, count: 5, collectionKey: "arkhubMissionCollection2" },
    ]);
    expect(mission.progress[0].value).toBe(2);
    // 达到 target → state 3
    await bus.emit("ArkhubCreatureCollection", [
      { activityId: ARKHUB_ACT_ID, count: 3, collectionKey: "arkhubMissionCollection1" },
    ]);
    expect(mission.progress[0].value).toBe(3);
    expect(player._playerdata.mission.missions.ACTIVITY["1arkhubActivity_9"].state).toBe(3);
  });

  it("ArkhubPassDexBattle：累计对战次数取 max", async () => {
    const { player, bus, mission } = missionFixture("1arkhubActivity_17");
    await mission.init();
    await bus.emit("ArkhubPassDexBattle", [{ activityId: ARKHUB_ACT_ID, count: 5 }]);
    expect(mission.progress[0].value).toBe(5);
    expect(player._playerdata.mission.missions.ACTIVITY["1arkhubActivity_17"].state).toBe(3);
  });

  it("ArkhubCreatureCaptured / ArkhubCreatureExchange：事件每次触发 +1", async () => {
    const { player, bus, mission } = missionFixture("1arkhubActivity_15");
    await mission.init();
    await bus.emit("ArkhubCreatureCaptured", [{ activityId: ARKHUB_ACT_ID }]);
    expect(mission.progress[0].value).toBe(1);
    expect(player._playerdata.mission.missions.ACTIVITY["1arkhubActivity_15"].state).toBe(3);

    const exch = missionFixture("1arkhubActivity_16");
    await exch.mission.init();
    await exch.bus.emit("ArkhubCreatureExchange", [{ activityId: ARKHUB_ACT_ID }]);
    expect(exch.mission.progress[0].value).toBe(1);
  });

  it("ArkhubDailyMissionCompleted：窗口内推进，8/18 任务在窗口起点前不推进", async () => {
    config.developer = { timestamp: FROZEN_TS };
    // 任务 4（窗口 08-08 起）：推进
    const m4 = missionFixture("1arkhubActivity_4");
    await m4.mission.init();
    await m4.bus.emit("ArkhubDailyMissionCompleted", [{ activityId: ARKHUB_ACT_ID, days: 1 }]);
    expect(m4.mission.progress[0].value).toBe(1);
    // 任务 7（窗口 08-18 起，当前 08-15）：不推进
    const m7 = missionFixture("1arkhubActivity_7");
    await m7.mission.init();
    await m7.bus.emit("ArkhubDailyMissionCompleted", [{ activityId: ARKHUB_ACT_ID, days: 3 }]);
    expect(m7.mission.progress[0].value).toBe(0);
  });

  it("ArkhubPublishPixelArt / ArkhubCollectPixelArt：取 max", async () => {
    const p = missionFixture("1arkhubActivity_20");
    await p.mission.init();
    await p.bus.emit("ArkhubPublishPixelArt", [{ activityId: ARKHUB_ACT_ID, count: 1 }]);
    expect(p.mission.progress[0].value).toBe(1);

    const c = missionFixture("1arkhubActivity_22");
    await c.mission.init();
    await c.bus.emit("ArkhubCollectPixelArt", [{ activityId: ARKHUB_ACT_ID, count: 5 }]);
    expect(c.mission.progress[0].value).toBe(5);
  });
});

describe("奇象巡展勋章模板（MedalProgress + 真实 EventBus）", () => {
  function medalFixture(medalId: string) {
    const bus = mockTypedEventEmitter();
    const markDirty = vi.fn();
    // item.val 取播种形状 [[0, target]]——构造函数绑定存档数组并自动 init 注册监听
    // （with-val 分支：init 构建的 scratch 被丢弃，val 以 item.val 为准）
    const target = medalId === "medal_activity_1arkhub_01" ? 4 : 10;
    const item = {
      id: medalId,
      val: [[0, target]],
      rts: -1,
      fts: 0,
      reward: "",
    };
    const medal = new MedalProgress(item as PlayerPerMedal, bus, markDirty);
    return { bus, medal, item, markDirty };
  }

  it("ActivityArkhubPixelCollect：收集画像数取 max（target=param[2]=4）", async () => {
    const { bus, medal, markDirty } = medalFixture("medal_activity_1arkhub_01");
    expect(medal.val[0]).toEqual([0, 4]);
    await bus.emit("ActivityArkhubPixelCollect", [{ activityId: ARKHUB_ACT_ID, count: 2 }]);
    expect(medal.val[0][0]).toBe(2);
    await bus.emit("ActivityArkhubPixelCollect", [{ activityId: ARKHUB_ACT_ID, count: 4 }]);
    expect(medal.val[0][0]).toBe(4);
    expect(medal.fts).toBeGreaterThan(0);
    expect(markDirty).toHaveBeenCalled();
  });

  it("ActivityArkhubCreatureCollect：收录 10 种达标", async () => {
    const { bus, medal } = medalFixture("medal_activity_1arkhub_02");
    expect(medal.val[0]).toEqual([0, 10]);
    await bus.emit("ActivityArkhubCreatureCollect", [
      { activityId: ARKHUB_ACT_ID, count: 10, collectionKey: "arkhubMissionCollection1" },
    ]);
    expect(medal.val[0][0]).toBe(10);
  });

  it("ActivityArkhubAlterCollect：10 种 + 至少 1 亚种（镀层双条件）", async () => {
    const { bus, medal } = medalFixture("medal_activity_1arkhub_025");
    expect(medal.val[0]).toEqual([0, 10]);
    // 10 种但无亚种：进度锁 0（有亚种才积累）
    await bus.emit("ActivityArkhubAlterCollect", [{ activityId: ARKHUB_ACT_ID, count: 10, alterCount: 0 }]);
    expect(medal.val[0][0]).toBe(0);
    // 9 种 + 1 亚种：积累 9，但未达 10 不完成
    await bus.emit("ActivityArkhubAlterCollect", [{ activityId: ARKHUB_ACT_ID, count: 9, alterCount: 1 }]);
    expect(medal.val[0][0]).toBe(9);
    expect(medal.fts).toBe(0);
    // 10 种 + 1 亚种：达标完成
    await bus.emit("ActivityArkhubAlterCollect", [{ activityId: ARKHUB_ACT_ID, count: 10, alterCount: 1 }]);
    expect(medal.val[0][0]).toBe(10);
    expect(medal.fts).toBeGreaterThan(0);
  });
});

/**
 * ARK_HUB act1arkhub 存档窄视图
 *
 * 用例夹具里这些键都会写入，而生成类型把 ARK_HUB 子形状声明为全可选且与
 * `& { [typeKey: string]: ServerPayload }` 兜底索引签名取交集（载荷含对象数组时
 * 直接写进种子会被 TS2322 挡住）。此处声明「夹具保证存在」的只读视图。
 */
interface ArkHubView {
  coin: number;
  duelCount: number;
  dailySupplyDays: number;
  creatureCollected: number;
  activeCreatureCollected: number;
  alterCollected: number;
  pixelCollected: number;
  pixelPublished: number;
  props: { [key: string]: { count: number; uses: number } };
  stateMask: number;
  settledDuels: string[];
  claimedRewards: { [key: string]: number };
  guideFlags: { [key: string]: number | undefined };
  arkdexState: {
    activeLure?: number;
    activeEncounter?: { creatures?: { numId?: number }[]; lureNumId?: number };
  };
}

describe("arkhub 玩法事件入口（arkhub.ts）", () => {
  function hubPlayer(overrides: Partial<ArkHubView> = {}) {
    const bus = mockTypedEventEmitter();
    const player = mockPlayerData({
      status: { uid: 1, nickName: "T", nickNumber: 0, level: 1, exp: 0 },
      tshop: { shop_act1arkhub: { coin: 0 } },
    });
    // ARK_HUB 载荷含对象数组，生成类型的兜底索引签名（两层 ServerPayload）装不下，
    // 故夹具经 Object.assign 单点写入（无 cast/无关键字，运行期与写进种子等价）。
    Object.assign(player._playerdata, {
      activity: { ARK_HUB: { act1arkhub: { coin: 0, ...overrides } } },
    });
    player._trigger = bus;
    return player;
  }

  it("arkhubOnDuelSettle：对战计数 +1、发 15 券、币同步、发任务事件", async () => {
    const player = hubPlayer();
    const seen: { activityId: string; count: number }[] = [];
    const bus = player._trigger as TypedEventEmitter;
    bus.on("ArkhubPassDexBattle", ([payload]) => {
      seen.push(payload);
    });
    await arkhubOnDuelSettle(asPlayerManager(player));

    const hub = hubOf(player);
    expect(hub.duelCount).toBe(1);
    expect(hub.coin).toBe(15);
    expect(player._playerdata.tshop.shop_act1arkhub.coin).toBe(15);
    expect(seen).toEqual([{ activityId: ARKHUB_ACT_ID, count: 1 }]);
    // 二次结算累计（update 会整体替换 activity 引用，需重新读取）
    await arkhubOnDuelSettle(asPlayerManager(player));
    const hub2 = hubOf(player);
    expect(hub2.duelCount).toBe(2);
    expect(hub2.coin).toBe(30);
  });

  it("arkhubOnDuelSettle(win=false)：败局发 7 券（官方：负 7），对战计数照常", async () => {
    const player = hubPlayer();
    await arkhubOnDuelSettle(asPlayerManager(player), false);

    const hub = hubOf(player);
    expect(hub.duelCount).toBe(1);
    expect(hub.coin).toBe(7);
    expect(player._playerdata.tshop.shop_act1arkhub.coin).toBe(7);
  });

  it("arkhubBuyProp：券不足拒绝购买（不扣券不入道具箱，错码 601）；券足时扣券+道具箱+生效次数", async () => {
    // 券不足：5004 标准诱引剂 40 券，持有 0 → 拒绝（网关据此回错误码）
    const poor = hubPlayer();
    expect(await arkhubBuyProp(asPlayerManager(poor), 5004, 1)).toEqual({ ok: false, code: 601 });
    const poorHub = hubOf(poor);
    expect(poorHub.coin).toBe(0);
    expect(poorHub.props).toBeUndefined();
    // 券足：持有 100 → 扣 40，道具箱 +1 且生效次数 +1（使用后消耗）
    const rich = hubPlayer({ coin: 100 });
    expect(await arkhubBuyProp(asPlayerManager(rich), 5004, 1)).toEqual({ ok: true, code: 100 });
    const richHub = hubOf(rich);
    expect(richHub.coin).toBe(60);
    expect(richHub.props["5004"]).toEqual({ count: 1, uses: 1 });
    // 使用一次后生效次数耗尽 → 再次使用被拒（错码 603）
    expect(await arkhubUseProp(asPlayerManager(rich), 5004)).toEqual({ ok: true, code: 100 });
    expect(await arkhubUseProp(asPlayerManager(rich), 5004)).toEqual({ ok: false, code: 603 });
  });

  it("网关状态持久化：状态掩码/对局去重键落盘 + 读取还原（含捕捉会话）", async () => {
    const player = hubPlayer();
    // 掩码落盘（官服 PlayerReconnectData.f1 同语义）
    await arkhubSetStateMask(asPlayerManager(player), 0x800);
    expect(hubOf(player).stateMask).toBe(0x800);
    // 去重键：幂等 + 忽略 unknown，环形保留
    await arkhubRecordSettledDuel(asPlayerManager(player), "b1");
    await arkhubRecordSettledDuel(asPlayerManager(player), "b1"); // 重复不追加
    await arkhubRecordSettledDuel(asPlayerManager(player), "unknown"); // 忽略
    await arkhubRecordSettledDuel(asPlayerManager(player), "b2");
    expect(hubOf(player).settledDuels).toEqual(["b1", "b2"]);
    // 捕捉会话（已落盘的 activeEncounter → 读取还原为 numId 列表）
    const playerManager = asPlayerManager(player);
    await playerManager.update(async (draft) => {
      draft.activity.ARK_HUB![ARKHUB_ACT_ID].arkdexState = {
        activeEncounter: { creatures: [{ numId: 19001 }, { numId: 19002 }], lureNumId: 5004 },
      };
    });
    const s = arkhubReadGatewayState(asPlayerManager(player));
    expect(s.stateMask).toBe(0x800);
    expect(s.settledDuels).toEqual(["b1", "b2"]);
    expect(s.encounter).toEqual({ creatures: [19001, 19002], lureNumId: 5004 });
  });

  it("交互领奖一次性记录：首次未领/标记后已领（防每次进入重复领奖）", async () => {
    const player = hubPlayer();
    expect(arkhubIsRewardClaimed(asPlayerManager(player), "arkhub_main_shiane_02b")).toBe(false);
    await arkhubMarkRewardClaimed(asPlayerManager(player), "arkhub_main_shiane_02b");
    expect(arkhubIsRewardClaimed(asPlayerManager(player), "arkhub_main_shiane_02b")).toBe(true);
    // 每日键与一次性键互不影响（同一演员不同自然日键可再领）
    expect(arkhubIsRewardClaimed(asPlayerManager(player), "arkhub_main_daily_task_02a:Wed")).toBe(false);
    expect(hubOf(player).claimedRewards["arkhub_main_shiane_02b"]).toBeGreaterThan(0);
  });

  it("arkhubOnDailySupply：每日限 1 次、累计天数 +1、发 100 券", async () => {
    const player = hubPlayer();
    const seen: { activityId: string; days: number }[] = [];
    const bus = player._trigger as TypedEventEmitter;
    bus.on("ArkhubDailyMissionCompleted", ([payload]) => {
      seen.push(payload);
    });
    await arkhubOnDailySupply(asPlayerManager(player));
    await arkhubOnDailySupply(asPlayerManager(player)); // 同日第二次 → 跳过

    const hub = hubOf(player);
    expect(hub.dailySupplyDays).toBe(1);
    expect(hub.coin).toBe(100);
    expect(seen).toEqual([{ activityId: ARKHUB_ACT_ID, days: 1 }]);
  });

  it("arkhubCreatureCollected：计数落状态 + 双 collectionKey 事件 + 勋章事件", async () => {
    const player = hubPlayer();
    const seen: string[] = [];
    const bus = player._trigger as TypedEventEmitter;
    bus.on("ArkhubCreatureCollection", ([payload]) => {
      seen.push(`m:${payload.collectionKey}:${payload.count}`);
    });
    bus.on("ActivityArkhubCreatureCollect", () => {
      seen.push("medal02");
    });
    bus.on("ActivityArkhubAlterCollect", () => {
      seen.push("medal025");
    });

    await arkhubCreatureCollected(asPlayerManager(player), { count: 3, activeCount: 1, alterCount: 1 });
    const hub = hubOf(player);
    expect(hub.creatureCollected).toBe(3);
    expect(hub.activeCreatureCollected).toBe(1);
    expect(hub.alterCollected).toBe(1);
    expect(seen).toContain("m:arkhubMissionCollection1:3");
    expect(seen).toContain("m:arkhubMissionCollection2:1");
    expect(seen).toContain("medal02");
    expect(seen).toContain("medal025");
  });

  it("arkhubCreatureCaptured / Exchange / PixelCollected 事件发射", async () => {
    const player = hubPlayer();
    const seen: string[] = [];
    const bus = player._trigger as TypedEventEmitter;
    bus.on("ArkhubCreatureCaptured", () => {
      seen.push("captured");
    });
    bus.on("ArkhubCreatureExchange", () => {
      seen.push("exchange");
    });
    bus.on("ArkhubCollectPixelArt", ([payload]) => {
      seen.push(`pixel:${payload.count}`);
    });
    bus.on("ActivityArkhubPixelCollect", () => {
      seen.push("medal01");
    });

    await arkhubCreatureCaptured(asPlayerManager(player));
    await arkhubCreatureExchange(asPlayerManager(player));
    await arkhubPixelCollected(asPlayerManager(player), 4);
    expect(hubOf(player).pixelCollected).toBe(4);
    expect(seen).toEqual(["captured", "exchange", "pixel:4", "medal01"]);
  });
});

describe("arkhub 渐进引导/剧情推进（GuideFlags，2026-08-19）", () => {
  function guidePlayer(guideFlags?: Record<string, number>) {
    const bus = mockTypedEventEmitter();
    const player = mockPlayerData({
      status: { uid: 1, nickName: "T", nickNumber: 0, level: 1, exp: 0 },
      mission: { missions: {} },
    });
    Object.assign(player._playerdata, {
      activity: {
        ARK_HUB: { act1arkhub: { coin: 0, ...(guideFlags ? { guideFlags } : {}) } },
      },
    });
    player._trigger = bus;
    return { player, bus };
  }

  it("渐进初始态：关键引导 flag=0，非引导/防卡 flag 保持完成态", () => {
    const complete = arkhubCompletedGuideFlags();
    expect(complete.capture_catch_guide_02).toBe(2);
    expect(complete.arkdex_battle_guide).toBe(2);
    expect(complete.arkhub_login).toBe(1);

    const prog = arkhubProgressiveGuideFlags();
    // 渐进 = 完成态 + 引导类置 0
    expect(prog.arkhub_login).toBe(0);
    expect(prog.terminal_guide).toBe(0);
    expect(prog.capture_catch_guide_02).toBe(0);
    expect(prog.arkdex_battle_guide).toBe(0);
    expect(prog.pixel_unlock).toBe(0);
    expect(prog.pixel_unlock_system).toBe(0);
    // 防卡/未知 actor 项保持完成态
    expect(prog.capture_catch_guide_01).toBe(2);
    expect(prog.area_1_block).toBe(1);
    expect(prog.area_2_guard).toBe(1);
  });

  it("resolveGuideFlags：持久化优先（合并完成态兜底）/ 无持久化回退 progressive 或完成态", () => {
    // 无持久化：progressive=false → 完成态
    const p1 = guidePlayer();
    expect(arkhubResolveGuideFlags(asPlayerManager(p1.player))).toEqual(arkhubCompletedGuideFlags());
    // 无持久化：progressive=true → 渐进初始态
    expect(arkhubResolveGuideFlags(asPlayerManager(p1.player), true)).toEqual(arkhubProgressiveGuideFlags());
    // 有持久化：部分 flag → 合并完成态兜底
    const p2 = guidePlayer({ arkdex_battle_guide: 2 });
    const merged = arkhubResolveGuideFlags(asPlayerManager(p2.player), true);
    expect(merged.arkdex_battle_guide).toBe(2);
    expect(merged.capture_catch_guide_02).toBe(0); // 未持久化项走渐进初始态
    expect(merged.area_1_block).toBe(1);
  });

  it("推进 mmkabi_01b：捕抓引导完成 + 设施解锁 + ArkhubMissionCompleted(任务2 flag)", async () => {
    const { player, bus } = guidePlayer();
    const seen: { activityId: string; flag: string }[] = [];
    bus.on("ArkhubMissionCompleted", ([payload]) => {
      seen.push(payload);
    });
    await arkhubAdvanceGuide(asPlayerManager(player), "arkhub_capture1_mmkabi_01b");
    const hub = hubOf(player);
    expect(hub.guideFlags.capture_catch_guide_02).toBe(2);
    expect(hub.guideFlags.pixel_unlock).toBe(1);
    expect(hub.guideFlags.pixel_unlock_system).toBe(1);
    // 事件 flag 列表（任务 2 模板监听 param[2]===flag）
    expect(seen.map((e) => e.flag).sort()).toEqual(["capture_catch_guide_02", "pixel_unlock", "pixel_unlock_system"]);
    // 幂等：重复调用不重复计数/事件
    seen.length = 0;
    await arkhubAdvanceGuide(asPlayerManager(player), "arkhub_capture1_mmkabi_01b");
    expect(seen).toEqual([]);
    expect(hub.guideFlags.capture_catch_guide_02).toBe(2);
  });

  it("推进 bryota_01c：对决引导完成（任务3 flag）", async () => {
    const { player, bus } = guidePlayer();
    const seen: { activityId: string; flag: string }[] = [];
    bus.on("ArkhubMissionCompleted", ([payload]) => {
      seen.push(payload);
    });
    await arkhubAdvanceGuide(asPlayerManager(player), "arkhub_main_bryota_01c");
    const hub = hubOf(player);
    expect(hub.guideFlags.arkdex_battle_guide).toBe(2);
    expect(seen.map((e) => e.flag)).toEqual(["arkdex_battle_guide"]);
  });

  it("未知 actor no-op（不落状态不发射事件）", async () => {
    const { player, bus } = guidePlayer();
    const seen: { activityId: string; flag: string }[] = [];
    bus.on("ArkhubMissionCompleted", ([payload]) => {
      seen.push(payload);
    });
    await arkhubAdvanceGuide(asPlayerManager(player), "arkhub_main_daily_task_02a");
    const hub = hubOf(player);
    expect(hub.guideFlags).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("引导 actor 映射表：mmkabi 推进 3 flag（含设施解锁），bryota 推进对决引导", () => {
    expect(ARKHUB_GUIDE_ACTOR_FLAGS.arkhub_capture1_mmkabi_01b).toEqual({
      capture_catch_guide_02: 2,
      pixel_unlock: 1,
      pixel_unlock_system: 1,
    });
    expect(ARKHUB_GUIDE_ACTOR_FLAGS.arkhub_main_bryota_01c).toEqual({ arkdex_battle_guide: 2 });
  });
});

describe("unlockActivity 播种 × 渐进引导开关（config.arkhub.guideProgressive）", () => {
  function mockPlayer2() {
    const reloadActivity = vi.fn().mockResolvedValue(undefined);
    const player = mockPlayerData({
      status: { uid: 1, nickName: "T", nickNumber: 0, level: 1, exp: 0 },
      mission: { missions: { ACTIVITY: {} } },
      medal: { medals: {}, custom: { currentIndex: "", customs: {} } },
      dungeon: { stages: {} },
      arkodc: { topics: {} },
    });
    Object.assign(player._playerdata, { activity: { ARK_HUB: {} } });
    Object.assign(player, { mission: { reloadActivity } });
    return { player };
  }

  it("guideProgressive=true：任务 2/3 播种进行中（0/1），任务 1 保持完成态", async () => {
    config.developer = { timestamp: FROZEN_TS };
    config.arkhub = { guideProgressive: true };
    const { player } = mockPlayer2();
    await unlockActivity(asPlayerManager(player));
    const am = player._playerdata.mission.missions.ACTIVITY;
    // 任务 2（捕抓引导 capture_catch_guide_02）：进行中 0/1
    expect(am["1arkhubActivity_2"]).toEqual({ state: 2, progress: [{ value: 0, target: 1 }] });
    // 任务 3（对决引导 arkdex_battle_guide）：进行中 0/1
    expect(am["1arkhubActivity_3"]).toEqual({ state: 2, progress: [{ value: 0, target: 1 }] });
    // 任务 1（夏妮 capture_catch_guide_01）：保持完成态（actor 未确认）
    expect(am["1arkhubActivity_1"]).toEqual({ state: 2, progress: [{ value: 1, target: 1 }] });
  });

  it("guideProgressive=false（默认）：引导任务全部播种完成态（回归）", async () => {
    config.developer = { timestamp: FROZEN_TS };
    config.arkhub = { guideProgressive: false };
    const { player } = mockPlayer2();
    await unlockActivity(asPlayerManager(player));
    const am = player._playerdata.mission.missions.ACTIVITY;
    expect(am["1arkhubActivity_1"]).toEqual({ state: 2, progress: [{ value: 1, target: 1 }] });
    expect(am["1arkhubActivity_2"]).toEqual({ state: 2, progress: [{ value: 1, target: 1 }] });
    expect(am["1arkhubActivity_3"]).toEqual({ state: 2, progress: [{ value: 1, target: 1 }] });
  });
});

describe("public 门面导出面（模块外唯一入口）", () => {
  it("domain / session / capture 三组关键符号均可从 public 取得（防门面腐化）", async () => {
    const facade = await import("@game/modules/activities/arkhub/public");
    // domain：玩法域
    for (const name of [
      "ARKHUB_ACT_ID",
      "ARKHUB_ERR",
      "ARKHUB_SHOP_ID",
      "arkhubOnDuelSettle",
      "arkhubBuyProp",
      "arkhubSyncMissionCoin",
      "arkhubCoinRef",
      "savePixel",
      "validatePixelData",
      "PIXEL_DATA_LEN",
    ]) {
      expect(facade, `缺 domain 导出 ${name}`).toHaveProperty(name);
    }
    // session：长连接会话协议栈
    for (const name of [
      "startArkhubSessionServer",
      "createArkhubSessionBindings",
      "ArkhubSessionFrameRouter",
      "GW_CODE_OK",
      "GW_USER_LOGIN_REQ",
      "buildFrame",
      "ProtoReader",
      "GW_SCENE_PREFIX",
    ]) {
      expect(facade, `缺 session 导出 ${name}`).toHaveProperty(name);
    }
    // capture：抓包模式官服网关适配
    for (const name of [
      "startArkhubGatewayProxy",
      "setGatewayRecordSink",
      "adaptArkhubEnterHallResponse",
      "isArkhubEnterHall",
      "parseGatewayStream",
      "OFFICIAL_ARKHUB_GATEWAY_PORT",
    ]) {
      expect(facade, `缺 capture 导出 ${name}`).toHaveProperty(name);
    }
    // 类型导出面（运行期无实体，由编译期校验；此处用元组实例化确保类型仍在门面上）
    const facadeTypes: [
      import("@game/modules/activities/arkhub/public").ArkhubSessionServerOptions,
      import("@game/modules/activities/arkhub/public").ArkhubSessionFrame,
      import("@game/modules/activities/arkhub/public").PixelInput,
    ] | null = null;
    expect(facadeTypes).toBeNull();
  });
});
