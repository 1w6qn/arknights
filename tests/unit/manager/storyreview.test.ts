import { describe, it, expect, vi, beforeEach } from "vitest";

// excel 数据端口替身:提供 StoryreviewManager 依赖的最小数据
//
// 迁移说明(2026-09,excel 端口注入):管理者不再直连 `@excel/excel` 单例,
// 改经 `player.excel`(PlayerDataManager 注入的数据端口)取表——模块级
// vi.mock 因此失效,夹具改为显式注入到 mockPlayerData 的 excel 字段。
// 端口替身以 mockExcelWith 的空表底座（含门面方法）承载，只覆盖被测分支读到的表；
// 未覆盖的表与旧夹具一样读不到数据（语义见 mockExcelWith 的 JSDoc）。
const excelMock = mockExcelWith({
      // 故事回顾表:提供分组奖励
      StoryReviewTable: {
        act_group_001: {
          id: "act_group_001",
          name: "测试故事组1",
          entryType: "ACTIVITY",
          actType: "ACTIVITY",
          startTime: 0,
          endTime: 0,
          startShowTime: 0,
          endShowTime: 0,
          remakeStartTime: 0,
          remakeEndTime: 0,
          storyEntryPicId: null,
          storyPicId: null,
          storyMainColor: null,
          customType: 0,
          storyCompleteMedalId: null,
          rewards: [
            { id: "reward_item_001", count: 5, type: "MATERIAL" },
            { id: "reward_item_002", count: 10, type: "MATERIAL" },
          ],
          infoUnlockDatas: [],
        },
      },
      // 故事回顾元数据表:提供迷你活动试用数据
      StoryReviewMetaTable: {
        miniActTrialData: {
          preShowDays: 0,
          ruleDataList: [],
          miniActTrialDataMap: {
            act_group_001: {
              actId: "act_group_001",
              rewardStartTime: 0,
              themeColor: "#FFFFFF",
              rewardList: [
                {
                  trialRewardId: "trial_001",
                  orderId: 1,
                  actId: "act_group_001",
                  targetStoryCount: 1,
                  item: { id: "trial_item_001", count: 3, type: "MATERIAL" },
                },
                {
                  trialRewardId: "trial_002",
                  orderId: 2,
                  actId: "act_group_001",
                  targetStoryCount: 2,
                  item: { id: "trial_item_002", count: 6, type: "MATERIAL" },
                },
              ],
            },
          },
        },
        actArchiveResData: {
          pics: {},
          audios: {},
          avgs: {},
          stories: {},
          news: {},
          landmarks: {},
          logs: {},
          challengeBooks: {},
        },
        actArchiveData: {
          components: {},
        },
      },
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

// Mock 时间工具,返回固定时间戳便于断言
vi.mock("@utils/time", () => ({
  now: () => 1234567890,
}));



import {
  asPlayerManager,
  mockExcelWith,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";
import { StoryreviewManager } from "@game/modules/storyreview/storyreview-manager";

/**
 * StoryreviewManager 单元测试
 * 覆盖故事解锁、阅读、组奖励领取、加速已知标记、追踪奖励领取等核心功能
 */
describe("StoryreviewManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      storyreview: {
        groups: {
          act_group_001: {
            rts: 0,
            stories: [
              { id: "act_group_001", uts: 100, rc: 0 },
            ],
            trailRewards: [],
          },
        },
        tags: {
          knownStoryAcceleration: 0,
        },
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
    it("应该正确初始化 StoryreviewManager 实例", () => {
      const manager = new StoryreviewManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
    });
  });

  describe("unlockStoryByCoin", () => {
    it("应该在指定故事组中追加新故事并触发 items:use 事件", async () => {
      const manager = new StoryreviewManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await manager.unlockStoryByCoin({ storyId: "act_group_001_level_st99" });

      const stories =
        mockPlayer._playerdata.storyreview!.groups["act_group_001"].stories;
      // 原有 1 个故事,新增 1 个,共 2 个
      expect(stories.length).toBe(2);
      // 新增的故事应包含 id、uts、rc 三个字段
      const newStory = stories[1];
      expect(newStory.id).toBe("act_group_001_level_st99");
      expect(newStory.uts).toBe(1234567890);
      expect(newStory.rc).toBe(0);
      // 消耗 STORY_REVIEW_COIN 已收敛到 player.gainItem 管道（不再直发 items:use）
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({
        id: "STORY_REVIEW_COIN",
        count: 1,
      });
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
    });
  });

  describe("readStory", () => {
    it("应该将指定故事的阅读次数 rc 自增 1", async () => {
      const manager = new StoryreviewManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // 初始 rc 为 0
      const beforeRc =
        mockPlayer._playerdata.storyreview!.groups["act_group_001"]
          .stories[0].rc;
      expect(beforeRc).toBe(0);

      await manager.readStory({ storyId: "act_group_001" });

      const afterRc =
        mockPlayer._playerdata.storyreview!.groups["act_group_001"]
          .stories[0].rc;
      expect(afterRc).toBe(1);
    });

    it("多次调用 readStory 应该累计增加阅读次数", async () => {
      const manager = new StoryreviewManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.readStory({ storyId: "act_group_001" });
      await manager.readStory({ storyId: "act_group_001" });
      await manager.readStory({ storyId: "act_group_001" });

      const afterRc =
        mockPlayer._playerdata.storyreview!.groups["act_group_001"]
          .stories[0].rc;
      expect(afterRc).toBe(3);
    });
  });

  describe("rewardGroup", () => {
    it("应该记录领取时间戳并返回奖励物品列表", async () => {
      const manager = new StoryreviewManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      const result = await manager.rewardGroup({ groupId: "act_group_001" });

      // 应记录领取时间戳
      expect(
        mockPlayer._playerdata.storyreview!.groups["act_group_001"].rts
      ).toBe(1234567890);
      // 应返回 excel 中配置的奖励列表
      expect(result).toEqual([
        { id: "reward_item_001", count: 5, type: "MATERIAL" },
        { id: "reward_item_002", count: 10, type: "MATERIAL" },
      ]);
      // 奖励发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({
        id: "reward_item_001",
        count: 5,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({
        id: "reward_item_002",
        count: 10,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
    });
  });

  describe("markStoryAcceKnown", () => {
    it("应该将 knownStoryAcceleration 标记置为 1", async () => {
      const manager = new StoryreviewManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // 初始为 0
      expect(
        mockPlayer._playerdata.storyreview!.tags.knownStoryAcceleration
      ).toBe(0);

      await manager.markStoryAcceKnown();

      expect(
        mockPlayer._playerdata.storyreview!.tags.knownStoryAcceleration
      ).toBe(1);
    });
  });

  describe("trailReward", () => {
    it("应该根据 rewardIdList 过滤并返回对应的奖励物品", async () => {
      const manager = new StoryreviewManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      // 只领取 trial_001 这一个奖励
      const result = await manager.trailReward({
        groupId: "act_group_001",
        rewardIdList: ["trial_001"],
      });

      // 应返回 trial_001 对应的 item
      expect(result).toEqual([
        { id: "trial_item_001", count: 3, type: "MATERIAL" },
      ]);
      // 奖励发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({
        id: "trial_item_001",
        count: 3,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
      // 应将 rewardIdList 追加到 trailRewards
      expect(
        mockPlayer._playerdata.storyreview!.groups["act_group_001"]
          .trailRewards
      ).toEqual(["trial_001"]);
    });

    it("当领取多个奖励时应返回所有匹配项并记录到 trailRewards", async () => {
      const manager = new StoryreviewManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.trailReward({
        groupId: "act_group_001",
        rewardIdList: ["trial_001", "trial_002"],
      });

      expect(result).toEqual([
        { id: "trial_item_001", count: 3, type: "MATERIAL" },
        { id: "trial_item_002", count: 6, type: "MATERIAL" },
      ]);
      expect(
        mockPlayer._playerdata.storyreview!.groups["act_group_001"]
          .trailRewards
      ).toEqual(["trial_001", "trial_002"]);
    });
  });
});
