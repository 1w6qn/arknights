import { describe, it, expect, vi, beforeEach } from "vitest";

// excel 数据端口替身:提供 RetroManager 依赖的最小数据
//
// 迁移说明(2026-09,excel 端口注入):管理者不再直连 `@excel/excel` 单例,
// 改经 `player.excel`(PlayerDataManager 注入的数据端口)取表——模块级
// vi.mock 因此失效,夹具改为显式注入到 mockPlayerData 的 excel 字段。
// 端口替身以 mockExcelWith 的空表底座（含门面方法）承载，只覆盖被测分支读到的表；
// 未覆盖的表与旧夹具一样读不到数据（语义见 mockExcelWith 的 JSDoc）。
const excelMock = mockExcelWith({
      // 怀旧活动表:提供追踪奖励列表
      RetroTable: {
        zoneToRetro: {},
        stageValidInfo: {},
        stages: null,
        retroActList: {},
        retroTrailList: {
          retro_001: {
            retroID: "retro_001",
            trailStartTime: 0,
            trailRewardList: [
              {
                trailRewardId: "trail_reward_001",
                starCount: 1,
                rewardItem: { id: "retro_item_001", count: 5, type: "MATERIAL" },
              },
              {
                trailRewardId: "trail_reward_002",
                starCount: 3,
                rewardItem: { id: "retro_item_002", count: 10, type: "MATERIAL" },
              },
            ],
            stageList: [],
            relatedChar: "char_001",
            relatedFullPotentialItemID: null,
            themeColor: "#FFFFFF",
            fullPotentialItemID: null,
          },
        },
        stageList: {},
        ruleData: { title: [], desc: [] },
        customData: {
          typeAct17Side: {},
          typeAct25Side: {},
          typeAct20Side: {},
          typeAct21Side: {},
        },
        // 修复（2026-09-09）：解锁费用改为读数据（retroUnlockCost）后，夹具须与真实数据
        // 对齐——data/excel/retro_table.json 实测 retroUnlockCost = 1（此前夹具写 0 只是
        // 因为旧实现写死 -= 1，与数据无关）。下面「消耗一个怀旧币」用例据此仍成立。
        initRetroCoin: 2,
        retroCoinPerWeek: 3,
        retroCoinMaxOfLevels: { "60": 3 },
        retroUnlockCost: 1,
        retroDetail: "",
        retroPreShowTime: 0,
      },
      // 活动表:提供通关奖励 retroData
      ActivityTable: {
        basicInfo: {},
        homeActConfig: {},
        zoneToActivity: {},
        actTimeTrackPoint: {},
        missionData: [],
        missionGroup: [],
        replicateMissions: {},
        activity: {
          MINISTORY: {
            act_001: {
              retroData: {
                rewards: [
                  {
                    id: "retro_001",
                    items: [
                      { id: "pass_item_001", count: 100, type: "MATERIAL" },
                      { id: "pass_item_002", count: 200, type: "MATERIAL" },
                    ],
                  },
                  {
                    id: "retro_002",
                    items: [
                      { id: "pass_item_003", count: 50, type: "MATERIAL" },
                    ],
                  },
                ],
              },
            },
            act_002: {},
          },
          DEFAULT: {},
          CHECKIN_ONLY: {},
        },
        extraData: { MAINLINE_BP: {} },
        activityItems: {},
        syncPoints: {},
        dynActs: {},
        stageRewardsData: {},
        actThemes: [],
        actFunData: {},
        carData: {},
        siracusaData: {},
        fireworkData: {},
        halfIdleData: {},
        kvSwitchData: {},
        dynEntrySwitchData: {},
        hiddenStageData: [],
        missionArchives: {},
        fifthAnnivExploreData: {},
        anniv7thData: {},
        autoChessData: {},
        stringRes: {},
        activityTraps: {},
        activityTrapMissions: {},
        trapRuneDataDict: {},
        activityTemplateMissionStyles: {},
        activityCrossDayTrackTypeDataDict: {},
        activityCrossDayTrackTypeMap: {},
        activityStoryReadTipsDatas: {},
      },
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

vi.mock("@utils/time", () => ({
  now: () => 1234567890,
}));



import type { PlayerRetro } from "@game/kernel/playerdata";
import {
  asPlayerManager,
  mockExcelWith,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";
import { RetroManager } from "@game/modules/retro/retro-manager";

/**
 * RetroManager 单元测试
 * 覆盖怀旧关卡解锁、追踪奖励领取、通关奖励领取等核心功能
 */
describe("RetroManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      retro: {
        coin: 10,
        supplement: 0,
        block: {
          retro_001: {
            locked: 1,
            open: 0,
          },
          retro_002: {
            locked: 1,
            open: 0,
          },
        },
        lst: 0,
        nst: 0,
        trail: {
          retro_001: {},
        },
        rewardPerm: [],
      },
    });
    // excel 数据端口替身注入(见文件头说明)
    mockPlayer.excel = excelMock;

    mockPlayer._trigger = mockTrigger;
    // 覆写替身默认 update：与 helper 实现等价（JSON 深拷贝 draft → recipe → 回写）
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  describe("constructor", () => {
    it("应该正确初始化 RetroManager 实例", () => {
      const manager = new RetroManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
    });
  });

  describe("unlockRetroBlock", () => {
    it("应该消耗一个怀旧币并解锁指定怀旧关卡块", async () => {
      const manager = new RetroManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // 初始 coin=10,retro_001 处于锁定状态
      expect(mockPlayer._playerdata.retro!.coin).toBe(10);
      expect(mockPlayer._playerdata.retro!.block["retro_001"].locked).toBe(1);
      expect(mockPlayer._playerdata.retro!.block["retro_001"].open).toBe(0);

      await manager.unlockRetroBlock({ retroId: "retro_001" });

      // 应消耗 1 个怀旧币
      expect(mockPlayer._playerdata.retro!.coin).toBe(9);
      // 应解锁并打开 retro_001
      expect(mockPlayer._playerdata.retro!.block["retro_001"].locked).toBe(0);
      expect(mockPlayer._playerdata.retro!.block["retro_001"].open).toBe(1);
    });

    it("应该只解锁指定的怀旧关卡块,不影响其他块", async () => {
      const manager = new RetroManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.unlockRetroBlock({ retroId: "retro_001" });

      // retro_002 应仍处于锁定状态
      expect(mockPlayer._playerdata.retro!.block["retro_002"].locked).toBe(1);
      expect(mockPlayer._playerdata.retro!.block["retro_002"].open).toBe(0);
    });
  });

  describe("getRetroTrailReward", () => {
    it("应该返回追踪奖励物品并标记该奖励为已领取", async () => {
      const manager = new RetroManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      const result = await manager.getRetroTrailReward({
        retroId: "retro_001",
        rewardId: "trail_reward_001",
      });

      // 应返回奖励物品
      expect(result).toEqual([
        { id: "retro_item_001", count: 5, type: "MATERIAL" },
      ]);
      // 应在 trail 中标记该奖励已领取
      expect(mockPlayer._playerdata.retro!.trail["retro_001"]).toEqual({
        trail_reward_001: 1,
      });
      // 奖励发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({
        id: "retro_item_001",
        count: 5,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
    });

    it("领取第二个追踪奖励时应保留已领取的第一个奖励标记", async () => {
      const manager = new RetroManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.getRetroTrailReward({
        retroId: "retro_001",
        rewardId: "trail_reward_001",
      });
      await manager.getRetroTrailReward({
        retroId: "retro_001",
        rewardId: "trail_reward_002",
      });

      expect(mockPlayer._playerdata.retro!.trail["retro_001"]).toEqual({
        trail_reward_001: 1,
        trail_reward_002: 1,
      });
    });

    it("trail 缺该 retro 条目/整体缺失时应惰性初始化而非 500", async () => {
      // 修复前：trail[retroId] 为 undefined 时直接写 trail[retroId][rewardId] → TypeError
      //（新 retro/旧存档——模板只预置已知 retro 条目）
      const manager = new RetroManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      // 场景一：trail 存在但缺 retro_001 条目
      mockPlayer._playerdata.retro!.trail = {};
      let result = await manager.getRetroTrailReward({
        retroId: "retro_001",
        rewardId: "trail_reward_001",
      });
      expect(result).toEqual([
        { id: "retro_item_001", count: 5, type: "MATERIAL" },
      ]);
      expect(mockPlayer._playerdata.retro!.trail["retro_001"]).toEqual({
        trail_reward_001: 1,
      });
      // 场景二：trail 整体缺失（更旧存档）——就地按可选视图删除该键（运行期即 delete）
      delete (mockPlayer._playerdata.retro as Partial<PlayerRetro>).trail;
      result = await manager.getRetroTrailReward({
        retroId: "retro_001",
        rewardId: "trail_reward_002",
      });
      expect(result).toEqual([
        { id: "retro_item_002", count: 10, type: "MATERIAL" },
      ]);
      expect(mockPlayer._playerdata.retro!.trail["retro_001"]).toEqual({
        trail_reward_002: 1,
      });
    });
  });

  describe("getRetroPassReward", () => {
    it("应该从匹配的活动 retroData 中找到对应 retroId 的通关奖励", async () => {
      const manager = new RetroManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      const result = await manager.getRetroPassReward({
        retroId: "retro_001",
        activityId: "act_001",
      });

      // retro_001 对应的通关奖励应包含 pass_item_001 与 pass_item_002
      expect(result).toEqual([
        { id: "pass_item_001", count: 100, type: "MATERIAL" },
        { id: "pass_item_002", count: 200, type: "MATERIAL" },
      ]);
      // 奖励发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({
        id: "pass_item_001",
        count: 100,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({
        id: "pass_item_002",
        count: 200,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
    });

    it("当匹配的 retroId 不存在时应返回空奖励数组", async () => {
      const manager = new RetroManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // retro_999 在 retroData.rewards 中不存在
      const result = await manager.getRetroPassReward({
        retroId: "retro_999",
        activityId: "act_001",
      });

      expect(result).toEqual([]);
    });
  });
});
