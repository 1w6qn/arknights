/**
 * 情报屋（TYPE_ACT44SIDE）随关卡进度解锁回归测试
 *
 * 背景 bug：客户端情报屋入口 Status 计算要求 activity.TYPE_ACT44SIDE[actId]
 * 非空（官服在进度事件中创建 `{coin}` 级状态），缺失时恒为 LOCKED——即使
 * AT-TR-1 已通关。修复前服务端仅在窗口内/forceOpen 播种或玩法路由内自愈，
 * 窗口外推进关卡链（ST-1→TR-1）从不创建状态 → 入口无法随关卡进度解锁。
 *
 * 覆盖：
 * - syncAct44SideEntry 纯函数（前缀命中/setdefault/no-op/扫描模式）
 * - battle.finishStoryStage / battle.finish 胜利路径接线
 * - unlockActivity 播种后自愈（迁移存档场景）+ 过期活动有进度不修剪
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Draft } from "mutative";
import type { ItemBundle, ItemTable } from "@excel/excel";
import type { CharacterData } from "@excel/types_excel_gen";
import type { PlayerActivity } from "@excel/types-playerdata";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { UserConfig } from "@game/modules/account/account-manager";
import type { MockSeed } from "../../helpers";

vi.mock("@excel/excel", () => {
  return {
    default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

      MissionTable: {
        missions: {},
        missionGroups: {},
        periodicalRewards: {},
        weeklyRewards: {},
        soCharMissionGroupInfo: {},
        dailyMissionGroupInfo: {},
        dailyMissionPeriodInfo: [],
        mainlineMissionEndImageDataList: [],
        crossAppShareMissions: {},
        crossAppShareMissionConst: {},
        guideMissionGroupInfo: {},
      },
      MedalTable: { medalList: [], medalTypeData: {} },
      HandbookInfoTable: { handbookStageData: {} },
      ActivityTable: {
        basicInfo: {
          // 「墟」：窗口早已过期（2025-08），未 forceOpen——模拟用户真实环境
          act44side: {
            id: "act44side",
            type: "TYPE_ACT44SIDE",
            name: "墟",
            displayType: "SIDESTORY",
            startTime: 1754085600,
            endTime: 1755892799,
            rewardEndTime: 1755892799,
          },
          act_other: {
            id: "act_other",
            type: "TYPE_ACT",
            name: "无关活动",
            startTime: 1500000000,
            endTime: 1500000001,
            rewardEndTime: 1500000001,
          },
        },
        activity: {
          tYPE_ACT44SIDE: {
            act44side: { constData: { informantUnlockStageId: "act44side_tr01" } },
          },
        },
      },
      CharWordTable: { startTimeWithTypeDict: {} },
      StageTable: {
        stages: {
          "main_01-07": {
            stageId: "main_01-07",
            zoneId: "zone_01",
            apCost: 10,
            apFailReturn: 10,
            stageType: "MAIN",
            stageDropInfo: { displayDetailRewards: [] },
            unlockCondition: [],
          },
          "main_01-10": {
            stageId: "main_01-10",
            zoneId: "zone_01",
            apCost: 10,
            apFailReturn: 10,
            stageType: "MAIN",
            stageDropInfo: { displayDetailRewards: [] },
            unlockCondition: [{ stageId: "main_01-09", completeState: "PASS" }],
          },
          act44side_st01: {
            stageId: "act44side_st01",
            stageType: "ACTIVITY",
            stageDropInfo: { displayDetailRewards: [] },
            unlockCondition: [{ stageId: "main_01-10", completeState: "PASS" }],
          },
          act44side_tr01: {
            stageId: "act44side_tr01",
            stageType: "ACTIVITY",
            stageDropInfo: { displayDetailRewards: [] },
            unlockCondition: [{ stageId: "act44side_st01", completeState: "PASS" }],
          },
          act44side_01: {
            stageId: "act44side_01",
            stageType: "ACTIVITY",
            stageDropInfo: { displayDetailRewards: [] },
            unlockCondition: [{ stageId: "act44side_tr01", completeState: "PASS" }],
          },
        } as Record<string, StageView>,
        runeStageGroups: {},
        mapThemes: {},
        tileInfo: {},
        forceOpenTable: {},
        timelyStageDropInfo: {},
        overrideDropInfo: {},
        overrideUnlockInfo: {},
        timelyTable: {},
        stageValidInfo: {},
        stageFogInfo: {},
        stageStartConds: {},
        diffGroupTable: {},
        storyStageShowGroup: {},
        specialBattleFinishStageData: {},
        recordRewardData: {},
        apProtectZoneInfo: {},
        antiSpoilerDict: {},
        actCustomStageDatas: {},
        spNormalStageIdFor4StarList: [],
        storylines: {},
        storylineStorySets: {},
        storylineConst: {},
        cgGalleryDisplays: {},
        cgGalleryGroups: {},
        cgGalleryCgs: {},
        sixStarRuneData: {},
        sixStarMilestoneInfo: {},
      },
      GachaTable: {},
      GameDataConst: {},
      CharacterTable: {} as CharacterData,
      ItemTable: { items: {}, expItems: {} } as ItemTable,
      ShopClientTable: {},
      SkillDataBundle: {},
    },
  };
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

vi.mock("@game/modules/account/account-manager", () => {
  const mockAccountConfigs: Record<string, MockAccountBattleConfig> = {
    "10000": {
      battle: {
        infos: {
          "1": {
            stageId: "main_01-07",
            isPractice: false,
          },
        },
        replays: {},
      },
    },
  };
  return {
    accountManager: {
      configs: mockAccountConfigs,
      saveBattleInfo: vi.fn().mockImplementation(async (uid: string, battleId: string, info: MockBattleInfoView) => {
        if (!mockAccountConfigs[uid]) {
          mockAccountConfigs[uid] = { battle: { infos: {}, replays: {} } };
        }
        mockAccountConfigs[uid].battle.infos[battleId] = info;
      }),
      getBattleInfo: vi.fn().mockImplementation(async (uid: string, battleId: string) => {
        return mockAccountConfigs[uid]?.battle?.infos?.[battleId];
      }),
      getBattleReplay: vi.fn(),
      saveBattleReplay: vi.fn(),
      saveBattleRecord: vi.fn(),
      getBattleRecord: vi.fn(),
      listBattleRecords: vi.fn(async () => []),
    },
  };
});

vi.mock("@utils/crypt", () => ({
  decryptBattleData: vi.fn().mockResolvedValue({
    battleId: "1",
    battleData: {
      stats: { enemyList: {}, autoReplayCancelled: false },
    },
    completeState: 3,
  }),
}));


import config from "@core/config/index";
import { asPlayerManager, mockPlayerData } from "../../helpers";
import { BattleManager } from "@game/modules/battle/battle";
import { unlockActivity } from "@game/modules/activities/shared/unlockActivity";
import { syncAct44SideEntry } from "@game/modules/activities/act44side/informant";
import { accountManager } from "@game/modules/account/account-manager";

/** 关卡窄视图（工厂 StageTable.stages 只声明用例读到的窗口/解锁字段） */
interface StageView {
  stageId: string;
  stageType: string;
  unlockCondition: { stageId: string; completeState: string }[];
  zoneId?: string;
  apCost?: number;
  apFailReturn?: number;
  stageDropInfo?: { displayDetailRewards: ItemBundle[] };
}

/** mock 账号战斗信息（真实 UserConfig.battle 已不含 infos，回放/结算迁移至 battle_infos 表） */
interface MockBattleInfoView {
  stageId: string;
  isPractice?: boolean;
}

/** mock 注入的账号配置视图 */
interface MockAccountBattleConfig {
  battle: { infos: Record<string, MockBattleInfoView>; replays: Record<string, never> };
}

/**
 * `@excel/excel` 端口在本文件只读写 `ActivityTable.basicInfo` 的窗口字段
 * （窄视图：真实表项还有 displayOnHome 等十余个必填字段，用例不关心）。
 */
interface ActivityBasicInfoView {
  id: string;
  type: string;
  name: string;
  startTime: number;
  endTime: number;
  rewardEndTime: number;
  medalGroupId?: string;
}
interface ExcelActivityView {
  ActivityTable: { basicInfo: Record<string, ActivityBasicInfoView> };
}

/** mock 账号配置读取点（accountManager.configs 的真实类型不含 infos，故按交集视图读） */
function accountConfigs(): Record<string, UserConfig & MockAccountBattleConfig> {
  return accountManager.configs as Record<string, UserConfig & MockAccountBattleConfig>;
}

/** act44side 单活动存档条目（取自生成模型） */
type Act44Entry = NonNullable<PlayerActivity["TYPE_ACT44SIDE"]>[string];

/**
 * 用例 draft：真实 draft 交集上把 TYPE_ACT44SIDE 声明为必填（入口函数 setdefault 自愈），
 * 并把 dungeon.stages 换成深可选视图，以便只写被测分支会读到的关卡字段。
 */
type Act44Draft = Draft<PlayerDataModel> & {
  activity: { TYPE_ACT44SIDE: { [actId: string]: Act44Entry } };
  dungeon: {
    stages: { [stageId: string]: MockSeed<Draft<PlayerDataModel>["dungeon"]["stages"][string]> };
  };
};

/**
 * 构造最小 draft（与旧 `const draft: any = {...}` 运行期等价）；
 * 断言两侧仍受真实模型约束，仅「必填」被放宽。
 */
function newDraft(): Act44Draft {
  return { activity: {}, dungeon: { stages: {} } } as Act44Draft;
}

/** 构造一个已解锁/已通关的关卡条目 */
function stageEntry(state: number) {
  return {
    stageId: "",
    practiceTimes: 0,
    completeTimes: state >= 2 ? 1 : 0,
    startTimes: state >= 2 ? 1 : 0,
    state,
    hasBattleReplay: 0,
    noCostCnt: 1,
  };
}

describe("syncAct44SideEntry（按关卡进度自愈情报屋状态）", () => {
  it("命中活动 id 前缀的关卡时创建默认状态（官服形状）", () => {
    const draft = newDraft();
    syncAct44SideEntry(draft, "act44side_tr01");
    const state = draft.activity.TYPE_ACT44SIDE.act44side;
    expect(state).toBeDefined();
    expect(state.coin).toBe(0);
    expect(state.milestone).toEqual({ point: 0, got: [] });
    expect(state.businessDay).toBe(1);
    expect(state.game).toBeNull();
    expect(state.outerOpen).toBe(true);
  });

  it("已有条目时 setdefault 不覆盖玩家数据", () => {
    const draft = newDraft();
    draft.activity.TYPE_ACT44SIDE = { act44side: { coin: 5 } };
    syncAct44SideEntry(draft, "act44side_tr01");
    expect(draft.activity.TYPE_ACT44SIDE.act44side.coin).toBe(5);
  });

  it("非 TYPE_ACT44SIDE 活动关卡为 no-op", () => {
    const draft = newDraft();
    syncAct44SideEntry(draft, "main_01-07");
    expect(draft.activity.TYPE_ACT44SIDE).toBeUndefined();
  });

  it("复刻活动关卡（act<NN>sre_*）触发情报屋状态自愈（键 act44sre，修复前恒 LOCKED）", () => {
    // live 客户端 activityId=act44sre（抓包 tmp/act44side-captures.json 实证），
    // excel basicInfo 仅收录 act44side——原实现只匹配 act44side_ 前缀，复刻玩家
    // 通关 act44sre_tr01 后 TYPE_ACT44SIDE["act44sre"] 缺失 → 小游戏入口不解锁。
    const draft = newDraft();
    syncAct44SideEntry(draft, "act44sre_tr01");
    const state = draft.activity.TYPE_ACT44SIDE.act44sre;
    expect(state).toBeDefined();
    expect(state.coin).toBe(0);
    expect(state.businessDay).toBe(1);
    expect(state.game).toBeNull();
  });

  it("复刻活动关卡在缺省 stageId 扫描模式下同样自愈", () => {
    const draft = newDraft();
    draft.dungeon.stages.act44sre_tr01 = { ...stageEntry(3), stageId: "act44sre_tr01" };
    syncAct44SideEntry(draft);
    expect(draft.activity.TYPE_ACT44SIDE.act44sre).toBeDefined();
  });

  it("缺省 stageId 时扫描 dungeon.stages 全部键（播种后自愈迁移存档）", () => {
    const draft = newDraft();
    draft.dungeon.stages.act44side_tr01 = { ...stageEntry(3), stageId: "act44side_tr01" };
    syncAct44SideEntry(draft);
    expect(draft.activity.TYPE_ACT44SIDE.act44side).toBeDefined();
  });

  it("basicInfo 无 TYPE_ACT44SIDE 活动时安全跳过", async () => {
    const excelRef: ExcelActivityView = (await import("@excel/excel")).default;
    const saved = excelRef.ActivityTable.basicInfo;
    excelRef.ActivityTable.basicInfo = { act_other: saved.act_other };
    try {
      const draft = newDraft();
      draft.dungeon.stages.act44side_tr01 = stageEntry(3);
      syncAct44SideEntry(draft);
      expect(draft.activity.TYPE_ACT44SIDE).toBeUndefined();
    } finally {
      excelRef.ActivityTable.basicInfo = saved;
    }
  });
});

describe("battle 结算接线（通关即自愈）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof import("../../helpers").mockTypedEventEmitter>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const { mockTypedEventEmitter } = await import("../../helpers");
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      activity: {},
      dungeon: {
        stages: {
          // 迁移存档形态：主线已推进、活动链已解锁但从未触发玩法路由
          "main_01-10": { ...stageEntry(3), stageId: "main_01-10" },
          "main_01-07": { ...stageEntry(0), stageId: "main_01-07" },
          act44side_st01: { ...stageEntry(0), stageId: "act44side_st01" },
          act44side_tr01: { ...stageEntry(0), stageId: "act44side_tr01" },
        },
      },
      troop: { chars: {}, addon: {} },
      dexNav: { enemy: { stage: {} }, character: {} },
      recruit: { normal: {} },
      status: { mainStageProgress: "", uid: "10000" },
      pushFlags: {},
      inventory: {},
    });
    // 夹具把 recruit.normal.slots 写成空数组、pushFlags.status 写成空对象，
    // 与模型声明（字典 / number）不同但都是空值；按「真实类型 ∪ 夹具值」的窄视图就地写回，
    // 运行期值与写进种子完全一致（避免改断言/改行为）。
    const recruitView = mockPlayer._playerdata.recruit.normal as {
      slots: PlayerDataModel["recruit"]["normal"]["slots"] | [];
    };
    recruitView.slots = [];
    const pushFlagsView = mockPlayer._playerdata.pushFlags as { status: number | Record<string, never> };
    pushFlagsView.status = {};
  });

  it("finishStoryStage 通关 act44side_st01 后创建 TYPE_ACT44SIDE 状态并解锁 tr01", async () => {
    const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.finishStoryStage({ stageId: "act44side_st01" });

    // 官服语义状态已存在 → 客户端入口 Status 可随 tr01 通关翻转为 UNLOCK
    const state = mockPlayer._playerdata.activity?.TYPE_ACT44SIDE?.act44side;
    expect(state).toBeDefined();
    expect(state!.game).toBeNull();
    // 原有关卡链推进不受影响
    expect(mockPlayer._playerdata.dungeon!.stages!.act44side_tr01).toBeDefined();
  });

  it("finish 胜利通关 act44side_tr01 后创建 TYPE_ACT44SIDE 状态并解锁 act44side_01", async () => {
    accountConfigs()["10000"].battle.infos["1"].stageId = "act44side_tr01";
    const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.finish({
      data: "encrypted_battle_data",
      battleData: { isCheat: "0", completeTime: 100 },
    });

    const state = mockPlayer._playerdata.activity?.TYPE_ACT44SIDE?.act44side;
    expect(state).toBeDefined();
    // 胜利后关卡链继续推进
    expect(mockPlayer._playerdata.dungeon!.stages!.act44side_01).toBeDefined();
    expect(mockPlayer._playerdata.dungeon!.stages!.act44side_tr01.state).toBe(3);
  });

  it("胜利通关无关关卡（main_01-07）不创建情报屋状态", async () => {
    // 前一用例可能改写过 battleId→stageId 映射，显式归位
    accountConfigs()["10000"].battle.infos["1"].stageId = "main_01-07";
    const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.finish({
      data: "encrypted_battle_data",
      battleData: { isCheat: "0", completeTime: 100 },
    });
    expect(mockPlayer._playerdata.activity?.TYPE_ACT44SIDE).toBeUndefined();
  });
});

describe("unlockActivity 联动（过期活动自愈与修剪豁免）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  const originalDeveloper = config.developer;
  const originalActivities = config.activities;

  afterEach(() => {
    config.developer = originalDeveloper;
    config.activities = originalActivities;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    config.developer = { timestamp: -1 }; // 真实时间模式（用户当前配置）
    config.activities = { ...(config.activities ?? {}), forceOpen: [] };
  });

  it("迁移存档：关卡链已推进（tr01 通关）而活动状态缺失 → 登录播种自愈且不被修剪", async () => {
    mockPlayer = mockPlayerData({
      activity: {},
      mission: { missions: { ACTIVITY: {} } },
      dungeon: {
        stages: {
          "main_01-09": { ...stageEntry(3), stageId: "main_01-09" },
          "main_01-10": { ...stageEntry(3), stageId: "main_01-10" },
          act44side_st01: { ...stageEntry(3), stageId: "act44side_st01" },
          act44side_tr01: { ...stageEntry(3), stageId: "act44side_tr01" },
        },
      },
    });

    await unlockActivity(asPlayerManager(mockPlayer));

    // 自愈创建（act44side 窗口已过期、未强制开启——旧逻辑下永远缺失）
    const state = mockPlayer._playerdata.activity?.TYPE_ACT44SIDE?.act44side;
    expect(state).toBeDefined();
    expect(state!.milestone).toEqual({ point: 0, got: [] });
    // 可达关卡照常播种；已通关进度保持
    expect(mockPlayer._playerdata.dungeon!.stages!.act44side_st01).toBeDefined();
    expect(mockPlayer._playerdata.dungeon!.stages!.act44side_01).toBeDefined();
    expect(mockPlayer._playerdata.dungeon!.stages!.act44side_tr01.state).toBe(3);

    // 二次登录：修剪阶段因「存在关卡进度」豁免，状态不再被清空
    await unlockActivity(asPlayerManager(mockPlayer));
    expect(mockPlayer._playerdata.activity?.TYPE_ACT44SIDE?.act44side).toBeDefined();
  });

  it("从未接触该活动的玩家不被塞入状态（fresh 存档无 act44side 关卡）", async () => {
    mockPlayer = mockPlayerData({
      activity: {},
      mission: { missions: { ACTIVITY: {} } },
      dungeon: { stages: {} },
    });
    await unlockActivity(asPlayerManager(mockPlayer));
    expect(mockPlayer._playerdata.activity?.TYPE_ACT44SIDE).toBeUndefined();
  });
});
