import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ItemBundle } from "@excel/excel";

/** 本文件读到的 excel 行形状（只声明被测分支用到的字段） */
interface ExcelItemRowMock {
  name?: string;
}
interface ExcelCharRowMock {
  name?: string;
}
interface ExcelStageRowMock {
  stageType?: string;
}
/** mission_table 行视图（夹具只声明被测分支读到的字段） */
interface MissionRowMock {
  id?: string;
  type?: string;
  template?: string;
  templateType?: string;
  param?: string[];
  periodicalPoint?: number;
  preMissionIds?: string[] | null;
  missionGroup?: string;
  rewards?: { type: string; id: string; count: number }[] | null;
}
/** missionGroups / weeklyRewards 行视图 */
interface MissionGroupMock {
  missionIds?: string[];
  preMissionIds?: string[];
  rewards?: { type: string; id: string; count: number }[];
}
/** periodicalRewards 行视图 */
interface PeriodicalRewardMock {
  id?: string;
  groupId?: string;
  periodicalPointCost?: number;
  type?: string;
  rewards?: { type: string; id: string; count: number }[];
}
/** dailyMissionPeriodInfo 行视图 */
interface DailyMissionPeriodMock {
  startTime: number;
  endTime: number;
  periodList: { period: number[]; missionGroupId: string; rewardGroupId: string }[];
}
/** activity_table 行视图（本用例只写 missionData） */
interface ActivityTableMock {
  missionData: { id: string; rewards: { type: string; id: string; count: number }[] }[];
}

// excel 基座数据：vi.hoisted 保证 vi.mock 工厂提升后仍可引用（run 期与内联工厂等价）
const excelMock = vi.hoisted(() => {
  return {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

      MissionTable: {
        missions: {} as Record<string, MissionRowMock | null>,
        missionGroups: {} as Record<string, MissionGroupMock>,
        periodicalRewards: {} as Record<string, PeriodicalRewardMock | null>,
        weeklyRewards: {} as Record<string, MissionGroupMock>,
        soCharMissionGroupInfo: {} as Record<string, MissionGroupMock>,
        dailyMissionGroupInfo: {} as Record<string, MissionGroupMock>,
        dailyMissionPeriodInfo: [] as DailyMissionPeriodMock[],
        mainlineMissionEndImageDataList: [] as MissionRowMock[],
        crossAppShareMissions: {} as Record<string, MissionRowMock>,
        crossAppShareMissionConst: {} as Record<string, MissionRowMock>,
        guideMissionGroupInfo: {} as Record<string, MissionGroupMock>,
      },
      MedalTable: { medalList: [] as MissionRowMock[], medalTypeData: {} as Record<string, MissionRowMock> },
      StageTable: {
        stages: {
          // 供 CompleteDailyStage 模板测试用（LS-1=物资筹备 DAILY 关）
          "LS-1": { stageType: "DAILY" },
          "main_01-01": { stageType: "MAIN" },
        } as Record<string, ExcelStageRowMock>,
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
        storylineTags: {},
        storylineConst: {},
        cgGalleryDisplays: {},
        cgGalleryGroups: {},
        cgGalleryCgs: {},
        sixStarRuneData: {},
        sixStarMilestoneInfo: {},
      },
      GachaTable: {},
      GameDataConst: {},
      CharacterTable: {} as Record<string, ExcelCharRowMock>,
      ItemTable: { items: {} as Record<string, ExcelItemRowMock>, expItems: {} as Record<string, ExcelItemRowMock> },
      ShopClientTable: {},
      SkillDataBundle: {},
      ActivityTable: undefined as ActivityTableMock | undefined,
    };
});

vi.mock("@excel/excel", () => ({ default: excelMock }));

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

vi.mock("@utils/time", () => ({
  now: () => Math.floor(Date.now() / 1000),
  checkBetween: (ts: number, start: number, end: number) =>
    ts >= start && ts <= end,
}));


vi.mock("moment", () => ({
  default: () => ({
    diff: () => 0,
  }),
}));

import { asModel, asPlayerManager, mockPlayerData, type MockSeed } from "../../../helpers/mockPlayerData";
import { mockTypedEventEmitter } from "../../../helpers/mockEventBus";
import type { MissionPlayerData } from "@game/kernel/playerdata";
import { BattleLogger, BattleStats } from "@game/kernel/battle-model";
import type { EventMap } from "@game/kernel/events";
import {
  MissionManager,
  MissionProgress,
  MissionTemplates,
  type MissionInfo,
} from "@game/modules/mission/logic";

/** 模板注册表成员（MissionTemplateGroup 键可缺省，故先断言组存在） */
function tplOf<K extends keyof typeof MissionTemplates>(name: K, branch: string) {
  return MissionTemplates[name]![branch];
}

/**
 * 本文件用到的模板名（其余模板的载荷含类实例，不参与本视图的深可选放宽）
 */
type TestTemplateName =
  | "ActivityCoinGain"
  | "CompleteAnyMulStage"
  | "CompleteAnyStage"
  | "CompleteDailyStage"
  | "CompleteStageAct"
  | "CompleteStageAnyType"
  | "CompleteStageCondition"
  | "CompleteStageOrCampaign"
  | "CompleteStageSimpleAtLeastId"
  | "CompleteStageWithTechTree"
  | "CostGold"
  | "CostGoldPlus"
  | "EnemyKill"
  | "Rlv2SettleGame"
  | "Rlv2SettleGameTimes"
  | "StageWithCondition"
  | "StageWithEnemyKill"
  | "StartInfoShare"
  | "UpgradeChar";

/**
 * 战斗统计服务端真值视图
 *
 * 生成类型把 `BattleStats.packedRuneDataList` 声明为 `null`（服务端实为组件/遗物 id 字符串
 * 列表，见 templates/stage.ts 的 BattleStatsView）——此处与生产侧同源就地放宽该字段。
 */
type BattleStatsTestView = Omit<BattleStats, "packedRuneDataList"> & {
  packedRuneDataList?: string[] | null;
};

/** 事件载荷的服务端真值视图（仅放宽 battleData.stats 的已知类型不符字段） */
type PayloadView<P> = P extends { battleData?: BattleLogger }
  ? Omit<P, "battleData"> & {
      battleData?: Omit<BattleLogger, "stats"> & { stats?: BattleStatsTestView };
    }
  : P;

/**
 * 模板 update 的测试载荷视图
 *
 * 模板的 `update(mission, ...args: EventMap[T])` 在类型上要求完整事件载荷，而模板实现
 * 只读取其中部分字段，用例按最小载荷构造。此处把载荷放宽为**深可选**（字段名与字段类型
 * 仍参与检查），末尾额外允许一个被实现忽略的占位参数（历史夹具以 `{}` 占位）。
 */
type SeedUpdate<F> = F extends (mission: MissionInfo, ...args: infer A) => void
  ? (
      mission: MissionInfo,
      ...args: [
        ...{ [I in keyof A]: MockSeed<PayloadView<A[I]>> },
        payload?: Record<string, never>,
      ]
    ) => void
  : F;

/** 模板注册表更新视图（本文件用到的模板；运行期与真实注册表同一对象） */
type SeedTemplates = {
  [G in TestTemplateName]-?: {
    [B in string]: {
      init: (mission: MissionInfo) => void;
      update: SeedUpdate<NonNullable<(typeof MissionTemplates)[G]>[B]["update"]>;
    };
  };
};

const seedTemplates = MissionTemplates as SeedTemplates;

/** 写入夹具用 mission 子树（深可选视图；字段名与类型仍受真实模型约束） */
function missionSeed(seed: MockSeed<MissionPlayerData>): MissionPlayerData {
  return asModel<MissionPlayerData>(seed);
}

/** 写入夹具用 mission.missions 分组（深可选视图；`progress` 由被测实现惰性补） */
function missionGroupSeed(
  seed: MockSeed<MissionPlayerData["missions"][string]>,
): MissionPlayerData["missions"][string] {
  return asModel<MissionPlayerData["missions"][string]>(seed);
}

describe("MissionManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      mission: {
        missions: {
          DAILY: {
            "daily_test_001": {
              state: 0,
              progress: [{ value: 0, target: 1 }],
            },
          },
          WEEKLY: {},
          ACTIVITY: {},
          OPENSERVER: {},
        },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 0,
          rewards: { DAILY: {}, WEEKLY: {} },
        },
        missionGroups: {},
      },
    });

    mockPlayer._trigger = mockTrigger;
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  describe("ACTIVITY 任务进度从存档继承", () => {
    it("init 不应清空已有存档的 ACTIVITY 任务（奇象巡展进度继承）", async () => {
      // 模拟从磁盘加载的存档：ACTIVITY 组含已推进的任务（如 1arkhubActivity_5）
      mockPlayer._playerdata.mission = missionSeed({
        missions: {
          ACTIVITY: {
            "1arkhubActivity_5": {
              state: 2,
              progress: [{ value: 5, target: 5 }],
            },
          },
        },
        missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} },
        missionGroups: {},
      });
      const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
      await manager.init();
      const act = mockPlayer._playerdata.mission.missions["ACTIVITY"];
      // 修复前：init 无条件 ACTIVITY={} 清空 → 后续播种重建为初始态，进度丢失。
      // 修复后：仅在缺失时补空，保留已有条目与进度，供播种/reloadActivity 继承。
      expect(act["1arkhubActivity_5"]).toBeDefined();
      expect(act["1arkhubActivity_5"].progress[0].value).toBe(5);
    });
  });

  describe("weeklyRefresh 播种每周任务", () => {
    it("weeklyRefresh 应播种并重置存档 WEEKLY 任务（链头 state=2、其余 state=1、进度清零）", async () => {
      // 构造两个 WEEKLY 任务：weekly_701 无前置（链头）、weekly_test_001 有前置（链中）
      excelMock.MissionTable.missions["weekly_701"] = {
        id: "weekly_701", type: "WEEKLY", periodicalPoint: 100,
        template: "CompleteStageAnyType", param: ["0", "1", "2"],
      };
      excelMock.MissionTable.missions["weekly_test_001"] = {
        id: "weekly_test_001", type: "WEEKLY", periodicalPoint: 20,
        template: "CompleteStageAnyType", param: ["0", "1", "2"],
        // 链头判定改为按 preMissionIds 动态判定（修复硬编码白名单失效）
        preMissionIds: ["weekly_701"],
      };
      // 预置上周完成态 + 已领周奖励（修复前 weeklyRefresh 不清 → 客户端仍显示完成态）
      mockPlayer._playerdata.mission = missionSeed({
        missions: {
          DAILY: {},
          WEEKLY: {
            "weekly_701": { state: 3, progress: [{ value: 1, target: 1 }] },
          },
          ACTIVITY: {},
          OPENSERVER: {},
        },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 50,
          rewards: { DAILY: {}, WEEKLY: { wr_1: 1 } },
        },
        missionGroups: {},
      });
      const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
      await manager.weeklyRefresh();
      const wk = mockPlayer._playerdata.mission.missions["WEEKLY"];
      // 播种：存档补齐所有 WEEKLY 任务（修复前仅内存重建，存档无 weekly_test_001）
      expect(wk["weekly_701"]).toBeDefined();
      expect(wk["weekly_test_001"]).toBeDefined();
      // 链头可见（state=2）、普通链中隐藏（state=1）、进度重置为 0
      expect(wk["weekly_701"].state).toBe(2);
      expect(wk["weekly_test_001"].state).toBe(1);
      expect(wk["weekly_701"].progress).toEqual([{ value: 0, target: 1 }]);
      // 周点数与已领奖励重置
      expect(mockPlayer._playerdata.mission.missionRewards.weeklyPoint).toBe(0);
      expect(
        mockPlayer._playerdata.mission.missionRewards.rewards["WEEKLY"],
      ).toEqual({});
    });
  });

  describe("dailyRefresh 播种日常任务", () => {    it("播种的日常任务 progress 应为非空且 target 真实（修复前为空数组）", async () => {
      // 构造一个覆盖当前日期的周期，使 dailyMissionPeriod 可用
      const period = {
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
        periodList: [
          {
            period: [1, 2, 3, 4, 5, 6, 7], // 覆盖周一~周日
            missionGroupId: "daily_g_seed",
            rewardGroupId: "reward_g_seed",
          },
        ],
      };
      excelMock.MissionTable.dailyMissionPeriodInfo = [period];
      excelMock.MissionTable.missionGroups["daily_g_seed"] = {
        missionIds: ["daily_seed_c", "daily_seed_g"],
      };
      // 两个真实模板任务：CompleteStageAnyType target=param[1]=3，EnemyKillInAnyStage target=param[1]=100
      excelMock.MissionTable.missions["daily_seed_c"] = {
        id: "daily_seed_c", type: "DAILY", periodicalPoint: 1,
        template: "CompleteStageAnyType", param: ["0", "3", "2"],
      };
      excelMock.MissionTable.missions["daily_seed_g"] = {
        id: "daily_seed_g", type: "DAILY", periodicalPoint: 1,
        template: "EnemyKillInAnyStage", param: ["0", "100"],
      };

      const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
      await manager.dailyRefresh();

      const da = mockPlayer._playerdata.mission.missions["DAILY"];
      expect(da["daily_seed_c"]).toBeDefined();
      // 修复前：progress 为空数组 [] → 日常任务进度被置空。
      // 修复后：播种即写入 [{value:0,target}]，target 由模板推导而非兜底 1。
      expect(da["daily_seed_c"].progress).toEqual([{ value: 0, target: 3 }]);
      expect(da["daily_seed_g"].progress).toEqual([{ value: 0, target: 100 }]);
      expect(da["daily_seed_c"].progress.length).toBeGreaterThan(0);
    });

    it("播种时链头任务 state=2（可见）、链中任务 state=1（隐藏，修复前全部 state=1）", async () => {
      // 构造覆盖当前日期的周期，使 dailyMissionPeriod 可用
      const period = {
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
        periodList: [
          {
            period: [1, 2, 3, 4, 5, 6, 7],
            missionGroupId: "daily_g_seed_state",
            rewardGroupId: "reward_g_seed_state",
          },
        ],
      };
      excelMock.MissionTable.dailyMissionPeriodInfo = [period];
      // 组内混入链头（daily_5801 无前置）与链中任务（daily_5802 有前置）
      excelMock.MissionTable.missionGroups["daily_g_seed_state"] = {
        missionIds: ["daily_5801", "daily_5802"],
      };
      excelMock.MissionTable.missions["daily_5801"] = {
        id: "daily_5801", type: "DAILY", periodicalPoint: 1,
        template: "CompleteStageAnyType", param: ["0", "1", "2"],
      };
      excelMock.MissionTable.missions["daily_5802"] = {
        id: "daily_5802", type: "DAILY", periodicalPoint: 1,
        template: "CompleteStageAnyType", param: ["0", "1", "2"],
        preMissionIds: ["daily_5801"],
      };

      const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
      await manager.dailyRefresh();

      const da = mockPlayer._playerdata.mission.missions["DAILY"];
      // 修复前：两者播种均 state=1 → 客户端任务列表只显示 state>=2（IN_EFFECT/
      // CONFIRMED/FINISHED）的任务，未完成且进度为 0 的链头任务不显示。
      // 修复后：链头 daily_5801 可见（state=2），链中 daily_5802 隐藏（state=1）。
      expect(da["daily_5801"].state).toBe(2);
      expect(da["daily_5802"].state).toBe(1);
      // 链头任务进度仍为 0 但处于可见态（未完成也显示在列表中）
      expect(da["daily_5801"].progress).toEqual([{ value: 0, target: 1 }]);
    });
  });

  describe("多任务奖励组并存兑换", () => {
    it("rewards.DAILY 含多个组时，confirm 只兑换当前周期组（修复前跨组发放）", async () => {
      // 构造当前周期（周日需包含，用全 weekday period 覆盖）与两组周期奖励
      excelMock.MissionTable.dailyMissionPeriodInfo = [{
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
        periodList: [{ period: [1, 2, 3, 4, 5, 6, 7], missionGroupId: "daily_g_mg", rewardGroupId: "reward_daily_g_cur" }],
      }];
      excelMock.MissionTable.missionGroups["daily_g_mg"] = { missionIds: ["daily_mg"] };
      excelMock.MissionTable.missions["daily_mg"] = {
        id: "daily_mg", type: "DAILY", periodicalPoint: 4,
        template: "CompleteStageAnyType", param: ["0", "1", "2"],
      };
      // 当前组奖励：GOLD；历史组奖励：DIAMOND（不应被当前任务点兑换）
      excelMock.MissionTable.periodicalRewards["r_cur"] = {
        id: "r_cur", groupId: "reward_daily_g_cur", periodicalPointCost: 2, type: "DAILY",
        rewards: [{ type: "GOLD", id: "4001", count: 500 }],
      };
      excelMock.MissionTable.periodicalRewards["r_hist"] = {
        id: "r_hist", groupId: "reward_daily_g_hist", periodicalPointCost: 2, type: "DAILY",
        rewards: [{ type: "DIAMOND_SHD", id: "4003", count: 100 }],
      };

      mockPlayer._playerdata.mission = missionSeed({
        missions: { DAILY: { "daily_mg": { state: 3, progress: [{ value: 1, target: 1 }] } } },
        missionRewards: {
          dailyPoint: 0, weeklyPoint: 0,
          rewards: { DAILY: { r_cur: 0, r_hist: 0 }, WEEKLY: {} },
        },
        missionGroups: {},
      });
      const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
      const items = await manager.confirmMission({ missionId: "daily_mg" });
      // 只应兑换当前组（reward_daily_g_cur）：GOLD 4001；历史组 r_hist 的 DIAMOND_SHD 不应出现
      expect(items).toContainEqual({ type: "GOLD", id: "4001", count: 500 });
      const diamond = items.filter((i) => i.id === "4003");
      expect(diamond.length).toBe(0);
      // 已领取标记只置当前组，历史组仍 0（未误发）
      expect(mockPlayer._playerdata.mission.missionRewards.rewards.DAILY.r_cur).toBe(1);
      expect(mockPlayer._playerdata.mission.missionRewards.rewards.DAILY.r_hist).toBe(0);
    });
  });

  describe("constructor", () => {
    it("应该正确初始化 MissionManager 实例", () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager.missions).toEqual({});
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
    });

    it("应注册 daily 和 weekly 刷新事件监听", () => {
      const onSpy = vi.spyOn(mockTrigger, "on");
      new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
      expect(onSpy).toHaveBeenCalledWith(
        "refresh:weekly",
        expect.any(Function)
      );
      expect(onSpy).toHaveBeenCalledWith(
        "refresh:daily",
        expect.any(Function)
      );
    });
  });

  describe("getMissionById", () => {
    it("当任务存在时应该返回 MissionProgress", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const testProgress = new MissionProgress(
        "daily_test_001",
        "DAILY",
        asPlayerManager(mockPlayer)
      );
      testProgress.progress = [{ value: 5, target: 10 }];
      testProgress.state = 2;
      manager.missions["DAILY"] = [testProgress];

      excelMock.MissionTable.missions["daily_test_001"] = {
        id: "daily_test_001",
        type: "DAILY",
      };

      const result = await manager.getMissionById("daily_test_001");
      expect(result).toBeDefined();
      expect(result!.missionId).toBe("daily_test_001");
    });

    it("当任务不存在时应该返回 undefined", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      manager.missions["DAILY"] = [];

      excelMock.MissionTable.missions["nonexistent"] = {
        id: "nonexistent",
        type: "DAILY",
      };

      const result = await manager.getMissionById("nonexistent");
      expect(result).toBeUndefined();
    });

    it("任务不在数据表（版本错位/下架）时返回 undefined 而非 500", async () => {
      // 修复前：excel.MissionTable.missions[missionId].type 解引用 undefined → TypeError
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      manager.missions["DAILY"] = [];
      // 不写入 excelMock.MissionTable.missions —— 模拟数据表缺失
      const result = await manager.getMissionById("removed_mission_1");
      expect(result).toBeUndefined();
    });
  });

  describe("confirmMission", () => {
    it("应该确认每日任务并触发 items:get 事件", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      excelMock.MissionTable.missions["daily_test_001"] = {
        id: "daily_test_001",
        type: "DAILY",
        periodicalPoint: 10,
      };

      const testProgress = new MissionProgress(
        "daily_test_001",
        "DAILY",
        asPlayerManager(mockPlayer)
      );
      testProgress.progress = [{ value: 1, target: 1 }];
      testProgress.state = 3;
      manager.missions["DAILY"] = [testProgress];

      mockPlayer._playerdata.mission = missionSeed({
        missions: {
          DAILY: {
            "daily_test_001": {
              state: 3,
              progress: [{ value: 1, target: 1 }],
            },
          },
        },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 0,
          rewards: { DAILY: {}, WEEKLY: {} },
        },
        missionGroups: {},
      });

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      const result = await manager.confirmMission({
        missionId: "daily_test_001",
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      // 物品发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
    });

    it("应该确认每周任务", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      excelMock.MissionTable.missions["weekly_test_001"] = {
        id: "weekly_test_001",
        type: "WEEKLY",
        periodicalPoint: 20,
      };

      const testProgress = new MissionProgress(
        "weekly_test_001",
        "WEEKLY",
        asPlayerManager(mockPlayer)
      );
      testProgress.progress = [{ value: 1, target: 1 }];
      testProgress.state = 3;
      manager.missions["WEEKLY"] = [testProgress];

      mockPlayer._playerdata.mission = missionSeed({
        missions: {
          WEEKLY: {
            "weekly_test_001": {
              state: 3,
              progress: [{ value: 1, target: 1 }],
            },
          },
        },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 0,
          rewards: { DAILY: {}, WEEKLY: {} },
        },
        missionGroups: {},
      });

      const result = await manager.confirmMission({
        missionId: "weekly_test_001",
      });
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it("活动任务确认后不能再次确认刷奖励（confirmed 标记持久化）", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const rewardGold = { type: "MATERIAL", id: "GOLD", count: 100 };
      excelMock.ActivityTable = {
        missionData: [{ id: "act_repeat_001", rewards: [rewardGold] }],
      };
      mockPlayer._playerdata.mission.missions["ACTIVITY"] = {
        act_repeat_001: { state: 2, progress: [{ value: 1, target: 1 }] },
      };
      const emitSpy = vi.spyOn(mockTrigger, "emit");

      // 第一次确认：发放奖励并置持久化 confirmed 标记
      const first = await manager.confirmMission({
        missionId: "act_repeat_001",
      });
      expect(first).toEqual([rewardGold]);
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith(rewardGold);

      // 再次确认：已领取 → 返回空奖励，不再发放/触发 items:get
      mockPlayer.gainItem.add.mockClear();
      const second = await manager.confirmMission({
        missionId: "act_repeat_001",
      });
      expect(second).toEqual([]);
      expect(mockPlayer.gainItem.add).not.toHaveBeenCalled();
    });
  });

  describe("confirmMissionGroup", () => {
    it("当有奖励时应该触发 items:get", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const testRewards = [{ type: "MATERIAL", id: "mat_001", count: 1 }];
      excelMock.MissionTable.missionGroups["group_001"] = {
        rewards: testRewards,
        missionIds: ["m_done_1"],
      };

      mockPlayer._playerdata.mission = missionSeed({
        // 组奖励需组内任务全部完成（state=3）
        missions: {
          DAILY: { m_done_1: { state: 3 } },
          WEEKLY: {},
          ACTIVITY: {},
          OPENSERVER: {},
        },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 0,
          rewards: { DAILY: {}, WEEKLY: {} },
        },
        missionGroups: {},
      });

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await manager.confirmMissionGroup({ missionGroupId: "group_001" });

      // 物品发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      for (const r of testRewards) {
        expect(mockPlayer.gainItem.add).toHaveBeenCalledWith(r);
      }
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
    });

    it("当奖励为 undefined 时不应该触发 items:get", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      excelMock.MissionTable.missionGroups["group_empty"] = {
        rewards: undefined,
      };

      mockPlayer._playerdata.mission = missionSeed({
        missions: { DAILY: {}, WEEKLY: {}, ACTIVITY: {}, OPENSERVER: {} },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 0,
          rewards: { DAILY: {}, WEEKLY: {} },
        },
        missionGroups: {},
      });

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await manager.confirmMissionGroup({ missionGroupId: "group_empty" });

      // 无奖励 → 管道无任何入队/执行
      expect(mockPlayer.gainItem.add).not.toHaveBeenCalled();
      expect(mockPlayer.gainItem.handle).not.toHaveBeenCalled();
    });

    it("组内任务未全部完成时不应发放组奖励（防凭空领取）", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const testRewards = [{ type: "CHAR", id: "char_102_texas", count: 1 }];
      excelMock.MissionTable.missionGroups["group_incomplete"] = {
        rewards: testRewards,
        missionIds: ["m_done_1", "m_running_2"],
      };

      mockPlayer._playerdata.mission = missionSeed({
        missions: {
          DAILY: { m_done_1: { state: 3 }, m_running_2: { state: 2 } },
          WEEKLY: {},
          ACTIVITY: {},
          OPENSERVER: {},
        },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 0,
          rewards: { DAILY: {}, WEEKLY: {} },
        },
        missionGroups: {},
      });

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await manager.confirmMissionGroup({ missionGroupId: "group_incomplete" });

      // 不发奖励，也不标记已领取
      expect(
        emitSpy.mock.calls.filter((call) => call[0] === "items:get").length
      ).toBe(0);
      expect(mockPlayer._playerdata.mission.missionGroups["group_incomplete"]).toBeUndefined();
    });
  });

  describe("autoConfirmMissions", () => {
    it("应该自动确认所有已完成的任务", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      excelMock.MissionTable.missions["daily_auto_001"] = {
        id: "daily_auto_001",
        type: "DAILY",
        periodicalPoint: 5,
      };

      const completedMission = new MissionProgress(
        "daily_auto_001",
        "DAILY",
        asPlayerManager(mockPlayer)
      );
      completedMission.progress = [{ value: 10, target: 10 }];
      completedMission.state = 2;

      const incompleteMission = new MissionProgress(
        "daily_auto_002",
        "DAILY",
        asPlayerManager(mockPlayer)
      );
      incompleteMission.progress = [{ value: 5, target: 10 }];
      incompleteMission.state = 2;

      manager.missions["DAILY"] = [completedMission, incompleteMission];

      mockPlayer._playerdata.mission = missionSeed({
        missions: {
          DAILY: {
            "daily_auto_001": {
              state: 2,
              progress: [{ value: 10, target: 10 }],
            },
            "daily_auto_002": {
              state: 2,
              progress: [{ value: 5, target: 10 }],
            },
          },
        },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 0,
          rewards: { DAILY: {}, WEEKLY: {} },
        },
        missionGroups: {},
      });

      const result = await manager.autoConfirmMissions({ type: "DAILY" });
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it("应合并相同 id 物品（修复：autoConfirm 多个奖励含重复物品时响应拆条，客户端提示计数错乱）", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // 两个 DAILY 任务，各自兑换出的周期奖励都含 GOLD 4001
      // 构造当前周期组，使 r_merge_1/r_merge_2 归属当前组可被兑换
      excelMock.MissionTable.dailyMissionPeriodInfo = [{
        startTime: 0,
        endTime: Number.MAX_SAFE_INTEGER,
        periodList: [{ period: [1, 2, 3, 4, 5, 6, 7], missionGroupId: "g", rewardGroupId: "reward_daily_g_merge" }],
      }];
      excelMock.MissionTable.missions["daily_m1"] = {
        id: "daily_m1",
        type: "DAILY",
        periodicalPoint: 2,
      };
      excelMock.MissionTable.missions["daily_m2"] = {
        id: "daily_m2",
        type: "DAILY",
        periodicalPoint: 3,
      };
      excelMock.MissionTable.periodicalRewards["r_merge_1"] = {
        id: "r_merge_1",
        type: "DAILY",
        groupId: "reward_daily_g_merge",
        periodicalPointCost: 2,
        rewards: [{ type: "GOLD", id: "4001", count: 500 }],
      };
      excelMock.MissionTable.periodicalRewards["r_merge_2"] = {
        id: "r_merge_2",
        type: "DAILY",
        groupId: "reward_daily_g_merge",
        periodicalPointCost: 3,
        rewards: [{ type: "GOLD", id: "4001", count: 1000 }],
      };

      mockPlayer._playerdata.mission = missionSeed({
        missions: {
          DAILY: {
            "daily_m1": { state: 2, progress: [{ value: 1, target: 1 }] },
            "daily_m2": { state: 2, progress: [{ value: 1, target: 1 }] },
          },
        },
        missionRewards: {
          dailyPoint: 0,
          weeklyPoint: 0,
          rewards: { DAILY: { r_merge_1: 0, r_merge_2: 0 }, WEEKLY: {} },
        },
        missionGroups: {},
      });

      const result = await manager.autoConfirmMissions({ type: "DAILY" });
      // 未合并前应为 [{GOLD,500},{GOLD,1000}] 两条 → 现应合并为一条 count 1500
      expect(result).toEqual([{ type: "GOLD", id: "4001", count: 1500 }]);
    });

    it("mergeItemBundles 应合并同 id 不同 type 之外，保留首次顺序", () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const merged = manager.mergeItemBundles([
        { type: "GOLD", id: "4001", count: 100 },
        { type: "CARD_EXP", id: "2001", count: 3 },
        { type: "GOLD", id: "4001", count: 50 },
        // 边界载荷：type=null 与 "GOLD" 不同键（生产按 `${type}|${id}` 分组，
        // 生成类型把 type 声明为必填的 ItemType，故此处按 ItemBundle 收口）
        { type: null, id: "4001", count: 10 },
      ] as ItemBundle[]);
      expect(merged).toEqual([
        { type: "GOLD", id: "4001", count: 150 },
        { type: "CARD_EXP", id: "2001", count: 3 },
        { type: null, id: "4001", count: 10 },
      ]);
    });
  });

  describe("exchangeMissionRewards", () => {
    it("应该兑换任务奖励并经物品管道发放", async () => {
      const manager = new MissionManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const rewards = [{ type: "MATERIAL", id: "mat_test", count: 5 }];
      excelMock.MissionTable.periodicalRewards["reward_exchange"] = {
        id: "reward_exchange",
        rewards,
      };

      const result = await manager.exchangeMissionRewards({
        targetRewardsId: "reward_exchange",
      });

      expect(result).toEqual(rewards);
      // 物品发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      for (const r of rewards) {
        expect(mockPlayer.gainItem.add).toHaveBeenCalledWith(r);
      }
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
    });
  });

  describe("MissionProgress", () => {
    it("应该正确构造 MissionProgress 实例", () => {
      const progress = new MissionProgress(
        "test_mission",
        "DAILY",
        asPlayerManager(mockPlayer)
      );
      expect(progress.missionId).toBe("test_mission");
      expect(progress.type).toBe("DAILY");
      expect(progress.value).toBe(0);
      expect(progress.state).toBe(0);
      expect(progress.confirmed).toBe(false);
      expect(progress.progress).toEqual([]);
    });

    it("getState 当没有进度时应该返回 0", async () => {
      const progress = new MissionProgress(
        "test_mission",
        "DAILY",
        asPlayerManager(mockPlayer)
      );
      progress.progress = [];
      try {
        const state = await progress.getState();
        expect(state).toBeDefined();
      } catch (e) {
        expect(e).toBeDefined();
      }
    });

    it("getState 当完成且已确认时应该返回 3", async () => {
      const progress = new MissionProgress(
        "test_mission",
        "DAILY",
        asPlayerManager(mockPlayer)
      );
      progress.progress = [{ value: 10, target: 10 }];
      progress.confirmed = true;
      const state = await progress.getState();
      expect(state).toBe(3);
    });

    it("getState 当有进度但未确认时应该返回 2", async () => {
      const progress = new MissionProgress(
        "test_mission",
        "DAILY",
        asPlayerManager(mockPlayer)
      );
      progress.progress = [{ value: 5, target: 10 }];

      excelMock.MissionTable.missions["test_mission"] = {
        id: "test_mission",
        type: "DAILY",
      };

      const state = await progress.getState();
      expect(state).toBe(2);
    });
  });
});

describe("MissionTemplates 核心模板", () => {
  function makeMission(param: string[], value = 0): MissionInfo {
    return { value, param, progress: [] };
  }

  it("CompleteStageAnyType 通关状态达标应推进进度", () => {
    const mission = makeMission(["0", "1", "2"]);
    tplOf("CompleteStageAnyType", "0").init(mission);
    expect(mission.progress[0]).toEqual({ value: 0, target: 1 });
    seedTemplates.CompleteStageAnyType["0"].update(mission, { completeState: 3 });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteStageAnyType 通关状态不足不应推进", () => {
    const mission = makeMission(["0", "1", "2"]);
    tplOf("CompleteStageAnyType", "0").init(mission);
    seedTemplates.CompleteStageAnyType["0"].update(mission, { completeState: 1 });
    expect(mission.progress[0].value).toBe(0);
  });

  it("StageWithEnemyKill 应累计击杀数", () => {
    const mission = makeMission(["1", "10"]);
    tplOf("StageWithEnemyKill", "1").init(mission);
    expect(mission.progress[0].target).toBe(10);
    seedTemplates.StageWithEnemyKill["1"].update(mission, { completeState: 3, killCnt: 5 });
    expect(mission.progress[0].value).toBe(5);
  });

  it("StageWithEnemyKill 未通关不应累计击杀", () => {
    const mission = makeMission(["1", "10"]);
    tplOf("StageWithEnemyKill", "1").init(mission);
    seedTemplates.StageWithEnemyKill["1"].update(mission, { completeState: 1, killCnt: 5 });
    expect(mission.progress[0].value).toBe(0);
  });

  it("Rlv2SettleGame 指定主题结算应推进（修复：原 update 空实现且无 emit）", () => {
    const mission = makeMission(["0", "1", "rogue_5"]);
    tplOf("Rlv2SettleGame", "0").init(mission);
    expect(mission.progress[0].target).toBe(1);
    // 主题不匹配不推进
    seedTemplates.Rlv2SettleGame["0"].update(mission, {
      data: { current: { game: { theme: "rogue_6" } } },
    });
    expect(mission.progress[0].value).toBe(0);
    // 匹配主题推进
    seedTemplates.Rlv2SettleGame["0"].update(mission, {
      data: { current: { game: { theme: "rogue_5" } } },
    });
    expect(mission.progress[0].value).toBe(1);
  });

  it("Rlv2SettleGameTimes 任意主题结算应推进", () => {
    const mission = makeMission(["0", "1"]);
    tplOf("Rlv2SettleGameTimes", "0").init(mission);
    seedTemplates.Rlv2SettleGameTimes["0"].update(mission, {});
    expect(mission.progress[0].value).toBe(1);
  });

  it("UpgradeChar 应累加干员升级次数", () => {
    const mission = makeMission(["0", "5"]);
    tplOf("UpgradeChar", "0").init(mission);
    expect(mission.progress[0].target).toBe(5);
    seedTemplates.UpgradeChar["0"].update(mission, {});
    seedTemplates.UpgradeChar["0"].update(mission, {});
    expect(mission.progress[0].value).toBe(2);
  });

  it("CompleteAnyStage 指定关卡通关应推进", () => {
    const mission = makeMission(["0", "main_01-07", "2"]);
    tplOf("CompleteAnyStage", "0").init(mission);
    expect(mission.progress[0].target).toBe(1);
    seedTemplates.CompleteAnyStage["0"].update(mission, { completeState: 3, stageId: "main_01-07" });
    expect(mission.progress[0].value).toBe(1);
    // 非指定关卡不推进
    seedTemplates.CompleteAnyStage["0"].update(mission, { completeState: 3, stageId: "main_02-07" });
    expect(mission.progress[0].value).toBe(1);
  });
});

describe("MissionTemplates 通用活动战斗模板（DoctoratePy 移植）", () => {
  function makeMission(param: string[], value = 0): MissionInfo {
    return { value, param, progress: [] };
  }

  it("StageWithCondition type0 指定关卡累计杀敌", () => {
    const mission = makeMission(["0", "act17side_01^act17side_02", "enemy_1160_hvyslr", "6"]);
    tplOf("StageWithCondition", "0").init(mission);
    expect(mission.progress[0].target).toBe(6);
    seedTemplates.StageWithCondition["0"].update(mission, {
      completeState: 3, stageId: "act17side_02",
      battleData: { stats: { enemyStats: [{ Key: { enemyId: "enemy_1160_hvyslr", counterType: "HP_ZERO" }, Value: 4 }] } },
    });
    expect(mission.progress[0].value).toBe(4);
    // 非指定关卡不推进
    seedTemplates.StageWithCondition["0"].update(mission, {
      completeState: 3, stageId: "act17side_03",
      battleData: { stats: { enemyStats: [{ Key: { enemyId: "enemy_1160_hvyslr", counterType: "HP_ZERO" }, Value: 4 }] } },
    });
    expect(mission.progress[0].value).toBe(4);
  });

  it("StageWithCondition type1 指定关卡累计施放技能", () => {
    const mission = makeMission(["1", "act17side_01", "3"]);
    tplOf("StageWithCondition", "1").init(mission);
    expect(mission.progress[0].target).toBe(3);
    seedTemplates.StageWithCondition["1"].update(mission, {
      completeState: 3, stageId: "act17side_01",
      battleData: { stats: { skillTrigStats: [{ Key: { skillId: "s1" }, Value: 2 }, { Key: { skillId: "s2" }, Value: 2 }] } },
    });
    expect(mission.progress[0].value).toBe(4);
  });

  it("StageWithCondition type2 指定关卡累计部署", () => {
    const mission = makeMission(["2", "act17side_01", "5"]);
    tplOf("StageWithCondition", "2").init(mission);
    seedTemplates.StageWithCondition["2"].update(mission, {
      completeState: 3, stageId: "act17side_01",
      battleData: { stats: { charStats: [{ Key: { charId: "c1", counterType: "SPAWN" }, Value: 3 }, { Key: { charId: "c2", counterType: "SPAWN" }, Value: 2 }] } },
    });
    expect(mission.progress[0].value).toBe(5);
  });

  it("EnemyKill 指定活动关卡累计击杀", () => {
    const mission = makeMission(["0", "act13d5_01^act13d5_02", "200"]);
    tplOf("EnemyKill", "0").init(mission);
    expect(mission.progress[0].target).toBe(200);
    seedTemplates.EnemyKill["0"].update(mission, { completeState: 3, stageId: "act13d5_02", killCnt: 30 });
    expect(mission.progress[0].value).toBe(30);
  });

  it("CompleteStageOrCampaign 任意关卡通关累计", () => {
    const mission = makeMission(["0", "40"]);
    tplOf("CompleteStageOrCampaign", "0").init(mission);
    expect(mission.progress[0].target).toBe(40);
    seedTemplates.CompleteStageOrCampaign["0"].update(mission, { completeState: 2, stageId: "main_01-01" });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteDailyStage 仅 DAILY 关卡计入", () => {
    const mission = makeMission(["1", "MATERIAL", "8"]);
    tplOf("CompleteDailyStage", "1").init(mission);
    expect(mission.progress[0].target).toBe(8);
    seedTemplates.CompleteDailyStage["1"].update(mission, { completeState: 3, stageId: "LS-1" });
    expect(mission.progress[0].value).toBe(1);
    // MAIN 关卡不计入
    seedTemplates.CompleteDailyStage["1"].update(mission, { completeState: 3, stageId: "main_01-01" });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteAnyMulStage 多维合作指定关推进", () => {
    const mission = makeMission(["0", "act17d1_02_a", "3"]);
    tplOf("CompleteAnyMulStage", "0").init(mission);
    seedTemplates.CompleteAnyMulStage["0"].update(mission, { completeState: 3, stageId: "act17d1_02_a" });
    expect(mission.progress[0].value).toBe(1);
    // 星级不足不推进
    seedTemplates.CompleteAnyMulStage["0"].update(mission, { completeState: 2, stageId: "act17d1_02_a" });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteStageCondition type0 技能列表达标", () => {
    const mission = makeMission(["0", "2", "act1bossrush_tm02", "skchr_shotst_2^skchr_estell_2", "20"]);
    tplOf("CompleteStageCondition", "0").init(mission);
    seedTemplates.CompleteStageCondition["0"].update(mission, {
      completeState: 3, stageId: "act1bossrush_tm02",
      battleData: { stats: { skillTrigStats: [{ Key: { skillId: "skchr_shotst_2" }, Value: 12 }, { Key: { skillId: "skchr_estell_2" }, Value: 12 }] } },
    });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteStageCondition type8 击杀指定敌人", () => {
    const mission = makeMission(["8", "3", "act21side_09", "enemy_1284_sgprst", "killed", "1"]);
    tplOf("CompleteStageCondition", "8").init(mission);
    seedTemplates.CompleteStageCondition["8"].update(mission, {
      completeState: 3, stageId: "act21side_09",
      battleData: { stats: { extraBattleInfo: { "enemy_1284_sgprst,killed": 1 } } },
    });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteStageCondition type12 指定干员不阵亡才推进", () => {
    const mission = makeMission(["12", "3", "act13side_06", "char_496_wild^char_420_flamtl"]);
    tplOf("CompleteStageCondition", "12").init(mission);
    seedTemplates.CompleteStageCondition["12"].update(mission, {
      completeState: 3, stageId: "act13side_06",
      battleData: { stats: { charStats: [{ Key: { charId: "char_420_flamtl", counterType: "SPAWN" }, Value: 1 }] } },
    });
    expect(mission.progress[0].value).toBe(1);
    // 任一指定干员阵亡则不推进
    seedTemplates.CompleteStageCondition["12"].update(mission, {
      completeState: 3, stageId: "act13side_06",
      battleData: { stats: { charStats: [{ Key: { charId: "char_420_flamtl", counterType: "DEAD" }, Value: 1 }] } },
    });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteStageSimpleAtLeastId extraBattleInfo 命中达标", () => {
    const mission = makeMission(["0", "3", "act20side_06", "enemy_1265_durcar", "born", "10"]);
    tplOf("CompleteStageSimpleAtLeastId", "0").init(mission);
    seedTemplates.CompleteStageSimpleAtLeastId["0"].update(mission, {
      completeState: 3, stageId: "act20side_06",
      battleData: { stats: { extraBattleInfo: { "enemy_1265_durcar,born": 12 } } },
    });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteStageWithTechTree 组件不超上限才推进", () => {
    const mission = makeMission(["0", "3", "act17side_ex07", "tech_1;tech_2;tech_3;tech_4;tech_5", "3"]);
    tplOf("CompleteStageWithTechTree", "0").init(mission);
    seedTemplates.CompleteStageWithTechTree["0"].update(mission, {
      completeState: 3, stageId: "act17side_ex07",
      battleData: { stats: { packedRuneDataList: ["tech_1", "tech_2"] } },
    });
    expect(mission.progress[0].value).toBe(1);
    // 超上限不推进
    const over = makeMission(["0", "3", "act17side_ex07", "tech_1;tech_2;tech_3;tech_4;tech_5", "3"]);
    tplOf("CompleteStageWithTechTree", "0").init(over);
    seedTemplates.CompleteStageWithTechTree["0"].update(over, {
      completeState: 3, stageId: "act17side_ex07",
      battleData: { stats: { packedRuneDataList: ["tech_1", "tech_2", "tech_3", "tech_4", "tech_5"] } },
    });
    expect(over.progress[0].value).toBe(0);
  });

  it("CompleteStageAct type1 指定单关通关", () => {
    const mission = makeMission(["1", "act50side_03", "1", "2"]);
    tplOf("CompleteStageAct", "1").init(mission);
    expect(mission.progress[0].target).toBe(1);
    seedTemplates.CompleteStageAct["1"].update(mission, { completeState: 3, stageId: "act50side_03" });
    expect(mission.progress[0].value).toBe(1);
    // 星级不足不推进
    seedTemplates.CompleteStageAct["1"].update(mission, { completeState: 1, stageId: "act50side_03" });
    expect(mission.progress[0].value).toBe(1);
    // 非该单关不推进
    seedTemplates.CompleteStageAct["1"].update(mission, { completeState: 3, stageId: "act50side_04" });
    expect(mission.progress[0].value).toBe(1);
  });

  it("StartInfoShare type1 线索分享推进", () => {
    const mission = makeMission(["1", "3"]);
    tplOf("StartInfoShare", "1").init(mission);
    expect(mission.progress[0].target).toBe(3);
    seedTemplates.StartInfoShare["1"].update(mission, {});
    seedTemplates.StartInfoShare["1"].update(mission, {});
    expect(mission.progress[0].value).toBe(2);
  });

  it("ActivityCoinGain 累计活动币（按 itemId 过滤）", () => {
    const mission = makeMission(["0", "act17side", "500", "act17side_token_compass"]);
    tplOf("ActivityCoinGain", "0").init(mission);
    expect(mission.progress[0].target).toBe(500);
    seedTemplates.ActivityCoinGain["0"].update(mission, { itemId: "act17side_token_compass", count: 300 });
    expect(mission.progress[0].value).toBe(300);
    // 非活动币物品不推进
    seedTemplates.ActivityCoinGain["0"].update(mission, { itemId: "30012", count: 900 });
    expect(mission.progress[0].value).toBe(300);
  });

  it("CostGold 累计消耗龙门币", () => {
    const mission = makeMission(["0", "150000"]);
    tplOf("CostGold", "0").init(mission);
    expect(mission.progress[0].target).toBe(150000);
    seedTemplates.CostGold["0"].update(mission, { goldCost: 3000 });
    seedTemplates.CostGold["0"].update(mission, { goldCost: 2000 });
    expect(mission.progress[0].value).toBe(5000);
  });

  it("CostGoldPlus 累计升级晋升耗币", () => {
    const mission = makeMission(["0", "60000"]);
    tplOf("CostGoldPlus", "0").init(mission);
    expect(mission.progress[0].target).toBe(60000);
    seedTemplates.CostGoldPlus["0"].update(mission, { goldCostPlus: 1200 });
    expect(mission.progress[0].value).toBe(1200);
  });

  it("StageWithCondition type3 载具骑乘累计", () => {
    const mission = makeMission(["3", "act50side_01^act50side_02", "trap_284_ctlzog", "ride", "3"]);
    tplOf("StageWithCondition", "3").init(mission);
    expect(mission.progress[0].target).toBe(3);
    seedTemplates.StageWithCondition["3"].update(mission, {
      completeState: 3, stageId: "act50side_01",
      battleData: { stats: { extraBattleInfo: { "trap_284_ctlzog,ride": 2 } } },
    });
    expect(mission.progress[0].value).toBe(2);
  });

  it("StageWithCondition type4 特殊计数（如 flashstun）累计", () => {
    const mission = makeMission(["4", "act24side_01", "flashstun", "10"]);
    tplOf("StageWithCondition", "4").init(mission);
    expect(mission.progress[0].target).toBe(10);
    seedTemplates.StageWithCondition["4"].update(mission, {
      completeState: 3, stageId: "act24side_01",
      battleData: { stats: { extraBattleInfo: { "flashstun,use": 6 } } },
    });
    expect(mission.progress[0].value).toBe(6);
  });

  it("CompleteStageCondition type5 场上干员数不超上限", () => {
    const mission = makeMission(["5", "3", "act11d0_08", "6"]);
    tplOf("CompleteStageCondition", "5").init(mission);
    seedTemplates.CompleteStageCondition["5"].update(mission, {
      completeState: 3, stageId: "act11d0_08",
      battleData: { stats: { charList: { a: 1, b: 2 } } },
    });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteStageCondition type6 装置使用不超上限", () => {
    const mission = makeMission(["6", "3", "act11d0_06", "trap_014_tower", "0"]);
    tplOf("CompleteStageCondition", "6").init(mission);
    // 超上限不推进
    seedTemplates.CompleteStageCondition["6"].update(mission, {
      completeState: 3, stageId: "act11d0_06",
      battleData: { stats: { extraBattleInfo: { "trap_014_tower,use": 2 } } },
    });
    expect(mission.progress[0].value).toBe(0);
    // 未使用则推进
    seedTemplates.CompleteStageCondition["6"].update(mission, {
      completeState: 3, stageId: "act11d0_06",
      battleData: { stats: { extraBattleInfo: { "trap_014_tower,use": 0 } } },
    });
    expect(mission.progress[0].value).toBe(1);
  });

  it("CompleteStageCondition type13 部署非助战指定干员推进（助战不推进）", () => {
    const mission = makeMission(["13", "3", "act21side_s04", "char_427_vigil", "1"]);
    tplOf("CompleteStageCondition", "13").init(mission);
    seedTemplates.CompleteStageCondition["13"].update(mission, {
      completeState: 3, stageId: "act21side_s04",
      battleData: { stats: { charStats: [{ Key: { charId: "char_427_vigil", counterType: "SPAWN" }, Value: 1 }], idList: [] } },
    });
    expect(mission.progress[0].value).toBe(1);
    // 若在 idList（助战）则不推进
    const m2 = makeMission(["13", "3", "act21side_s04", "char_427_vigil", "1"]);
    tplOf("CompleteStageCondition", "13").init(m2);
    seedTemplates.CompleteStageCondition["13"].update(m2, {
      completeState: 3, stageId: "act21side_s04",
      battleData: { stats: { charStats: [{ Key: { charId: "char_427_vigil", counterType: "SPAWN" }, Value: 1 }], // 生成类型把 stats.idList 声明为 object[]，服务端实为 charId 字符串列表
          // （见 templates/stage.ts 的 isStringArray 收窄），故就地收口该边界值
          idList: ["char_427_vigil"] as never } },
    });
    expect(m2.progress[0].value).toBe(0);
  });
});

describe("MissionManager 刷新", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    excelMock.MissionTable.dailyMissionPeriodInfo = [
      {
        startTime: 0,
        endTime: 9999999999,
        periodList: [
          { period: [1, 2, 3, 4, 5, 6, 7], missionGroupId: "daily_group", rewardGroupId: "daily_reward" },
        ],
      },
    ];
    excelMock.MissionTable.missionGroups = {
      daily_group: { missionIds: ["daily_r1"] },
    };
    excelMock.MissionTable.missions = {
      daily_r1: { id: "daily_r1", type: "DAILY", template: "CompleteStageAnyType", param: ["0", "1", "2"] },
      weekly_r1: { id: "weekly_r1", type: "WEEKLY", template: "CompleteStageAnyType", param: ["0", "1", "2"] },
    };
    excelMock.MissionTable.periodicalRewards = {
      r1: { id: "r1", groupId: "daily_reward", periodicalPointCost: 10, rewards: [{ id: "4001", type: "GOLD", count: 100 }] },
    };

    mockPlayer = mockPlayerData({
      mission: {
        missions: {
          DAILY: { daily_r1: { state: 1, progress: [{ value: 0, target: 1 }] } },
          // weeklyRefresh 重建时需数据中存在对应任务（修复后 init 校验数据缺失标记无效跳过）
          WEEKLY: { weekly_r1: { state: 1, progress: [{ value: 0, target: 1 }] } },
          ACTIVITY: {},
          OPENSERVER: {},
        },
        missionRewards: {
          dailyPoint: 100,
          weeklyPoint: 50,
          rewards: { DAILY: {}, WEEKLY: {} },
        },
        missionGroups: {},
      },
    });
    mockPlayer._trigger = mockTrigger;
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  it("dailyRefresh 应重置每日点数并加载每日任务", async () => {
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.dailyRefresh();
    expect(mockPlayer._playerdata.mission!.missionRewards.dailyPoint).toBe(0);
    expect(mockPlayer._playerdata.mission!.missionRewards.rewards["DAILY"]).toEqual({ r1: 0 });
    expect(manager.missions["DAILY"]).toHaveLength(1);
    expect(manager.missions["DAILY"][0].missionId).toBe("daily_r1");
  });

  it("跨天周期组相同时 dailyRefresh 也应重置日常任务进度（state/progress）", async () => {
    // 修复前：跨天时若当前组与昨日相同（如周内连续工作日同组），已存在的 daily_r1
    // 条目仅「缺失才补新」，旧进度（已完成 target）残留 → 客户端显示昨日已完成任务
    // 却无法重新接取 → 「每日更新不刷新日常任务进度」。
    mockPlayer._playerdata.mission!.missions.DAILY["daily_r1"] = {
      state: 3,
      progress: [{ value: 1, target: 1 }],
    };
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.dailyRefresh();
    // state 重置为可接取（daily_r1 无前置 → 链头 → 2），progress 由模板 init 重建并归零；
    // 关键是不得残留昨日完成态(3)
    const reset = mockPlayer._playerdata.mission!.missions.DAILY["daily_r1"];
    expect(reset.state).toBe(2);
    expect(reset.progress[0]).toMatchObject({ value: 0, target: 1 });
  });

  it("weeklyRefresh 应重置每周点数并加载每周任务", async () => {
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.weeklyRefresh();
    expect(mockPlayer._playerdata.mission!.missionRewards.weeklyPoint).toBe(0);
    expect(manager.missions["WEEKLY"]).toHaveLength(1);
    expect(manager.missions["WEEKLY"][0].missionId).toBe("weekly_r1");
  });

  it("init 数据表缺失的任务应跳过（不进入内存列表，不 ERROR）", async () => {
    // 旧版本存档任务（t_old_*）在新数据中缺失——版本更新后常见
    excelMock.MissionTable.missions = {};
    mockPlayer._playerdata.mission!.missions = {
      MAIN: {
        t_old_1: { state: 0, progress: [{ value: 0, target: 1 }] },
        t_old_2: { state: 0, progress: [{ value: 0, target: 1 }] },
      },
    };
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    await manager.init();
    expect(manager.missions["MAIN"]).toEqual([]);
  });

  it("periodicalRewards 含 null 伪键时 dailyRefresh 不应 500", async () => {
    // 数据表末尾字段名伪键（值 null 的转换产物：groupId/id/type/...）——
    // 修复前 Object.values 遍历到 null → reward.groupId 崩溃（2026-08-14 线上 500）
    excelMock.MissionTable.periodicalRewards["groupId"] = null;
    excelMock.MissionTable.periodicalRewards["id"] = null;
    excelMock.MissionTable.periodicalRewards["type"] = null;
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    await expect(manager.dailyRefresh()).resolves.not.toThrow();
    expect(manager.missions["DAILY"]).toHaveLength(1);
  });

  it("missions 含 null 伪键时 weeklyRefresh 不应 500", async () => {
    excelMock.MissionTable.missions["id"] = null;
    excelMock.MissionTable.missions["type"] = null;
    excelMock.MissionTable.missions["template"] = null;
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    await expect(manager.weeklyRefresh()).resolves.not.toThrow();
    expect(manager.missions["WEEKLY"]).toHaveLength(1);
  });
});

describe("dailyMissionPeriod 星期映射（修复：getDay()+1 错位）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    // 配置表周期编号 1=周一 .. 7=周日
    excelMock.MissionTable.dailyMissionPeriodInfo = [
      {
        startTime: 0,
        endTime: 9999999999,
        periodList: [
          {
            period: [1, 2, 3, 4, 5],
            missionGroupId: "weekday_group",
            rewardGroupId: "weekday_reward",
          },
          {
            period: [6, 7],
            missionGroupId: "weekend_group",
            rewardGroupId: "weekend_reward",
          },
        ],
      },
    ];
    mockPlayer = mockPlayerData({ mission: {} });
    mockPlayer._trigger = mockTrigger;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setDate = (y: number, m: number, d: number) =>
    vi.setSystemTime(new Date(y, m - 1, d, 12, 0, 0));

  it("周一(1)应匹配工作日组", async () => {
    setDate(2024, 1, 1); // 2024-01-01 周一
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    expect(manager.dailyMissionPeriod).toBe("weekday_group");
    expect(manager.dailyMissionRewardPeriod).toBe("weekday_reward");
  });

  it("周五(5)应匹配工作日组（修复前 getDay()+1=6 错配周末组）", async () => {
    setDate(2024, 1, 5); // 2024-01-05 周五
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    expect(manager.dailyMissionPeriod).toBe("weekday_group");
    expect(manager.dailyMissionRewardPeriod).toBe("weekday_reward");
  });

  it("周日(0)应匹配周末组（修复前 getDay()+1=1 错配工作日组）", async () => {
    setDate(2024, 1, 7); // 2024-01-07 周日
    const manager = new MissionManager(asPlayerManager(mockPlayer), mockTrigger);
    expect(manager.dailyMissionPeriod).toBe("weekend_group");
    expect(manager.dailyMissionRewardPeriod).toBe("weekend_reward");
  });
});