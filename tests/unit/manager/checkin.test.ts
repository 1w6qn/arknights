import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlayerCheckIn } from "@excel/types-playerdata";

/**
 * 签到组窄视图（用例只读到窗口时间与奖励条目；真实 CheckinTable 表项还有
 * 更多必填字段，夹具与 `mockExcelWith` 语义一致地只声明被测分支会读到的行）
 */
interface CheckinGroupView {
  groupId: string;
  title: string;
  description: string;
  signStartTime: number;
  signEndTime: number;
  items: { itemId: string; itemType: string; count: number }[];
}

// excel 数据端口替身:提供 CheckInManager 依赖的最小数据
//
// 迁移说明(2026-09,excel 端口注入):管理者不再直连 `@excel/excel` 单例,
// 改经 `player.excel`(PlayerDataManager 注入的数据端口)取表——模块级
// vi.mock 因此失效,夹具改为显式注入到 mockPlayerData 的 excel 字段。
//
// 端口替身以 `mockExcel()`(空表 + 门面方法)为底,仅覆盖 CheckInManager 读到的
// CheckinTable;未覆盖的表与旧夹具一样取不到数据(mockExcelWith 语义见其 JSDoc)。
const excelMock = mockExcelWith({
  // 签到表:提供签到组、月卡订阅物品等
  CheckinTable: {
    groups: {
      group_001: {
        groupId: "group_001",
        title: "测试签到组",
        description: "测试用",
        signStartTime: 0,
        signEndTime: 9999999999,
        items: [
          { itemId: "item_001", itemType: "MATERIAL", count: 100 },
          { itemId: "item_002", itemType: "MATERIAL", count: 200 },
        ],
      },
      group_002: {
        groupId: "group_002",
        title: "二月签到组",
        description: "测试用",
        signStartTime: 0,
        signEndTime: 9999999999,
        items: [
          { itemId: "item_003", itemType: "MATERIAL", count: 300 },
        ],
      },
    } as Record<string, CheckinGroupView | null>,
    currentMonthlySubId: "sub_001",
    monthlySubItem: {
      sub_001: [
        {},
        {
          items: [
            { id: "sub_item_001", count: 1, type: "MATERIAL" },
          ],
        },
      ],
    },
  },
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

// Mock 时间工具:now 固定时间戳,checkBetween 控制签到组与月卡判断
vi.mock("@utils/time", () => ({
  now: () => 1234567890,
  checkBetween: (ts: number, start: number, end: number) =>
    ts >= start && ts <= end,
}));



import {
  asPlayerManager,
  mockExcelWith,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";
import { CheckInManager } from "@game/modules/checkin/checkin";

/**
 * CheckInManager 单元测试
 * 覆盖签到、每日刷新、每月刷新、月卡奖励等场景
 */
describe("CheckInManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      checkIn: {
        canCheckIn: 1,
        checkInGroupId: "group_001",
        checkInRewardIndex: 0,
        checkInHistory: [],
        newbiePackage: {
          open: false,
          groupId: "",
          finish: 0,
          stopSale: 0,
          checkInHistory: [],
        },
      },
      status: {
        nickName: "TestUser",
        nickNumber: "0",
        level: 1,
        exp: 0,
        socialPoint: 0,
        gachaTicket: 0,
        tenGachaTicket: 0,
        instantFinishTicket: 0,
        hggShard: 0,
        lggShard: 0,
        recruitLicense: 0,
        progress: 0,
        buyApRemainTimes: 0,
        apLimitUpFlag: 0,
        uid: "10000",
        flags: {},
        ap: 100,
        maxAp: 100,
        androidDiamond: 0,
        iosDiamond: 0,
        diamondShard: 0,
        gold: 9999,
        practiceTicket: 0,
        lastRefreshTs: 0,
        lastApAddTime: 0,
        registerTs: 0,
        lastOnlineTs: 0,
        serverName: "TestServer",
        avatarId: "",
        resume: "",
        birthday: { month: 1, day: 1 },
        friendNumLimit: 50,
        monthlySubscriptionStartTime: 0,
        monthlySubscriptionEndTime: 0,
        secretary: "",
        secretarySkinId: "",
        tipMonthlyCardExpireTs: 0,
        avatar: { type: "ICON", id: "avatar_001" },
        globalVoiceLan: "CN_MANDARIN",
        classicShard: 0,
        classicGachaTicket: 0,
        classicTenGachaTicket: 0,
      },
    });
    // 夹具覆盖 mainStageProgress=null 的缺省分支（模型声明 string，真实存档为字符串）；
    // 这里按含 null 的窄视图就地写回，运行期值与「写进种子」完全一致。
    const statusView = mockPlayer._playerdata.status as { mainStageProgress: string | null };
    statusView.mainStageProgress = null;
    // excel 数据端口替身注入(见文件头说明)
    mockPlayer.excel = excelMock;

    mockPlayer._trigger = mockTrigger;
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  describe("constructor", () => {
    it("应该正确初始化并注册 refresh:monthly 与 refresh:daily 事件", () => {
      const onSpy = vi.spyOn(mockTrigger, "on");
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
      expect(onSpy).toHaveBeenCalledWith(
        "refresh:monthly",
        expect.any(Function)
      );
      expect(onSpy).toHaveBeenCalledWith(
        "refresh:daily",
        expect.any(Function)
      );
    });
  });

  describe("dailyRefresh", () => {
    it("应该重置 canCheckIn 并递增 checkInRewardIndex", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);

      // 先设置为已签到状态,验证每日刷新会重置
      mockPlayer._playerdata.checkIn!.canCheckIn = 0;
      mockPlayer._playerdata.checkIn!.checkInRewardIndex = 5;

      await manager.dailyRefresh();

      expect(mockPlayer._playerdata.checkIn!.canCheckIn).toBe(1);
      expect(mockPlayer._playerdata.checkIn!.checkInRewardIndex).toBe(6);
    });

    it("dailyRefresh 应递增 showCount（累计签到天数）", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.checkIn!.canCheckIn = 0;
      mockPlayer._playerdata.checkIn!.showCount = 10;
      await manager.dailyRefresh();
      expect(mockPlayer._playerdata.checkIn!.showCount).toBe(11);
    });

    it("老档缺失 showCount 时按注册时长回填（不再重复 +1）", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.checkIn!.canCheckIn = 0;
      delete (mockPlayer._playerdata.checkIn as Partial<PlayerCheckIn>).showCount;
      mockPlayer._playerdata.status.registerTs = 1234567890 - 180 * 86400; // 180 天前注册
      await manager.dailyRefresh();
      expect(mockPlayer._playerdata.checkIn!.showCount).toBe(180);
    });

    it("每日重复触发 dailyRefresh（canCheckIn 已为 1）时不再重复递增", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.checkIn!.canCheckIn = 1;
      mockPlayer._playerdata.checkIn!.showCount = 10;
      await manager.dailyRefresh();
      expect(mockPlayer._playerdata.checkIn!.showCount).toBe(10);
    });
  });

  describe("monthlyRefresh", () => {
    it("应该重置签到历史与奖励索引,并匹配当前可用签到组", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);

      mockPlayer._playerdata.checkIn!.checkInHistory = [0, 0, 0];
      mockPlayer._playerdata.checkIn!.checkInRewardIndex = 15;

      await manager.monthlyRefresh();

      expect(mockPlayer._playerdata.checkIn!.checkInHistory).toEqual([]);
      expect(mockPlayer._playerdata.checkIn!.checkInRewardIndex).toBe(-1);
      // 当前时间在 group_001 的时间范围内
      expect(mockPlayer._playerdata.checkIn!.checkInGroupId).toBe("group_001");
    });

    it("groups 含 null 伪键时 monthlyRefresh 不应 500", async () => {
      // 数据表末尾字段名伪键（值 null）——修复前 Object.values 遍历到 null →
      // t.signStartTime 崩溃（2026-08-14 数据更新后所有生成表均带该伪键）
      // 注入的端口替身可直接改：不再需要动态 import 真实单例（端口注入的收益之一）
      const groups = excelMock.CheckinTable.groups;
      groups["groupId"] = null;
      groups["signStartTime"] = null;
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(manager.monthlyRefresh()).resolves.not.toThrow();
      // 仍能匹配到正常签到组
      expect(mockPlayer._playerdata.checkIn!.checkInGroupId).toBe("group_001");
    });
  });

  describe("checkIn", () => {
    it("当 canCheckIn 为 0 时应该返回 undefined 且不触发事件", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);

      mockPlayer._playerdata.checkIn!.canCheckIn = 0;
      const emitSpy = vi.spyOn(mockTrigger, "emit");

      const result = await manager.checkIn();

      expect(result).toBeUndefined();
      const itemsGetCalls = emitSpy.mock.calls.filter(
        (c) => c[0] === "items:get"
      );
      expect(itemsGetCalls.length).toBe(0);
    });

    it("当可签到且无月卡时应该返回签到奖励并将 canCheckIn 置 0", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);

      const result = await manager.checkIn();

      expect(result).toBeDefined();
      expect(result!.signInRewards).toEqual([
        { id: "item_001", count: 100, type: "MATERIAL" },
      ]);
      expect(result!.subscriptionRewards).toEqual([]);
      expect(mockPlayer._playerdata.checkIn!.canCheckIn).toBe(0);
      expect(mockPlayer._playerdata.checkIn!.checkInHistory).toContain(0);
      // 物品发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({
        id: "item_001",
        count: 100,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.handle).toHaveBeenCalledTimes(1);
    });

    it("当持有月卡时签到应额外返回订阅奖励", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);

      // 设置月卡有效期内
      mockPlayer._playerdata.status!.monthlySubscriptionStartTime = 0;
      mockPlayer._playerdata.status!.monthlySubscriptionEndTime = 9999999999;

      const result = await manager.checkIn();

      expect(result).toBeDefined();
      expect(result!.signInRewards).toEqual([
        { id: "item_001", count: 100, type: "MATERIAL" },
      ]);
      expect(result!.subscriptionRewards).toEqual([
        { id: "sub_item_001", count: 1, type: "MATERIAL" },
      ]);
      // items:get 发放已收敛到 player.gainItem 管道（订阅奖励在前，签到奖励在后）
      expect(mockPlayer.gainItem.add).toHaveBeenNthCalledWith(1, {
        id: "sub_item_001",
        count: 1,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.add).toHaveBeenNthCalledWith(2, {
        id: "item_001",
        count: 100,
        type: "MATERIAL",
      });
      expect(mockPlayer.gainItem.handle).toHaveBeenCalledTimes(1);
    });

    it("当 checkInRewardIndex 为 -1 时签到应重置为 0 后再发放奖励", async () => {
      const manager = new CheckInManager(asPlayerManager(mockPlayer), mockTrigger);

      mockPlayer._playerdata.checkIn!.checkInRewardIndex = -1;
      const result = await manager.checkIn();

      expect(result).toBeDefined();
      expect(mockPlayer._playerdata.checkIn!.checkInRewardIndex).toBe(0);
      // 应发放 index=0 的奖励
      expect(result!.signInRewards).toEqual([
        { id: "item_001", count: 100, type: "MATERIAL" },
      ]);
    });
  });
});
