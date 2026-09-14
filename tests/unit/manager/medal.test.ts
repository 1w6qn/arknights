import { describe, it, expect, vi, beforeEach } from "vitest";

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
      StageTable: {
        stages: {} as Record<string, StageRowMock>,
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
      CharacterTable: {} as Record<string, CharRowMock>,
      ItemTable: { items: {} as Record<string, ItemRowMock>, expItems: {} },
      ShopClientTable: {},
      SkillDataBundle: {},
    },
  };
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

vi.mock("@utils/time", () => ({
  now: () => Math.floor(Date.now() / 1000),
  checkBetween: (ts: number, start: number, end: number) =>
    ts >= start && ts <= end,
}));


vi.mock("moment", () => ({
  default: () => ({ diff: () => 0 }),
}));

import { mockPlayerData, mockTypedEventEmitter, asPlayerManager, asModel } from "../../helpers";
import type { MockUpdateRecipe } from "../../helpers";
import type { Draft } from "mutative";
import type {
  PlayerDataModel,
  PlayerMedalCustomLayout,
  PlayerMedalCustomLayoutItem,
  PlayerPerMedal,
} from "@game/kernel/playerdata";
import type { PassStageStats } from "@game/kernel/events/medal";
import { MedalManager, MedalProgress } from "@game/modules/medal/medal";

/** excel mock 行形状（本文件用到的字段） */
interface ItemRowMock {
  name?: string;
}
/** 干员表行窄视图（mock 表只提供稀有度） */
interface CharRowMock {
  rarity?: string | number;
}
/** 关卡表行窄视图（mock 表为空，仅为索引签名占位） */
interface StageRowMock {
  stageId?: string;
}

/** 用例写入的勋章表行窄视图（只含被读到的字段） */
interface MedalRowMock {
  medalId: string;
  medalName?: string;
  template?: string | null;
  unlockParam?: string[];
  preMedalIdList?: string[];
  medalRewardGroup?: MedalRewardGroupMock[];
}
/** 勋章奖励组窄视图（itemList 元素类型与用例手写物品字面量兼容） */
interface MedalRewardGroupMock {
  groupId?: string;
  itemList?: { id?: string; count?: number; type?: string }[];
}

/** `@excel/excel` 模块替身窄视图（用例就地覆写 medal / character 表） */
interface MedalExcelMock {
  MedalTable: { medalList: MedalRowMock[] };
  CharacterTable: Record<string, CharRowMock>;
}

/**
 * 旧存档勋章视图（目标位为 null）
 *
 * 真实模型 `PlayerPerMedal.val` 声明为 `number[][]`，但 NaN 经 JSON 落盘会变成 null，
 * 旧存档的目标位可能为 null——用例据此验证「按重算目标回写」。
 */
interface LegacyMedalItem extends Omit<PlayerPerMedal, "val"> {
  val: (number | null)[][];
}

/**
 * 自定义布局夹具 → 真实模型类型（同一引用）
 *
 * 用例夹具的 `layout` 是字符串（"grid"/"list"），而真实模型
 * `PlayerMedalCustomLayout.layout` 是条目数组；此处只做类型适配，不改夹具与断言。
 * @param fixture - 用例局部布局夹具（字符串 layout + 可选 positions）
 * @returns 同一对象，类型视作真实布局
 */
function asCustomLayout(fixture: {
  layout: string | PlayerMedalCustomLayoutItem[];
  positions?: number[];
}): PlayerMedalCustomLayout {
  return fixture as PlayerMedalCustomLayout;
}

/**
 * 按模板名派发到 MedalProgress 的同名模板方法（与生产侧 MedalTemplateHandlers 同语义）
 *
 * 模板名由用例数据驱动，各模板方法签名统一为 `(args, mode)`。
 * @param progress - 勋章进度实例
 * @param template - 模板名（excel MedalTable 的 template 取值）
 * @param args - 模板载荷（init 模式不读）
 * @param mode - "init" | "update"
 */
function callTemplate(progress: MedalProgress, template: string, args: {}, mode: string): void {
  (progress[template as keyof MedalProgress] as (args: {}, mode?: string) => void)(args, mode);
}

describe("MedalManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;
  let mockExcelRef: MedalExcelMock;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockExcelRef = vi.mocked(await import("@excel/excel")).default;

    mockPlayer = mockPlayerData({
      medal: {
        medals: {
          "medal_test_001": {
            id: "medal_test_001",
            val: [[50, 100]],
            rts: -1,
            fts: 0,
            reward: "",
          },
          "medal_test_002": {
            id: "medal_test_002",
            val: [[100, 100]],
            rts: 1234567890,
            fts: 1234567890,
            reward: "rewarded",
          },
        },
        custom: {
          currentIndex: "0",
          customs: {},
        },
      },
    });

    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn<(recipe: MockUpdateRecipe) => Promise<void>>()
      .mockImplementation(
        async (recipe) => {
          const draft = JSON.parse(
            JSON.stringify(mockPlayer._playerdata)
          ) as Draft<PlayerDataModel>;
          const result = await recipe(draft);
          Object.assign(mockPlayer._playerdata, draft);
          return result;
        }
      );
  });

  describe("constructor", () => {
    it("应该正确初始化 MedalManager 实例", () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager.medals).toEqual({});
      expect(manager._playerdata).toBe(mockPlayer._playerdata);
      expect(manager.custom).toBeDefined();
    });

    it("应该注册 medal:complete 事件监听", () => {
      const onSpy = vi.spyOn(mockTrigger, "on");
      new MedalManager(asPlayerManager(mockPlayer), mockTrigger);
      expect(onSpy).toHaveBeenCalledWith(
        "medal:complete",
        expect.any(Function)
      );
    });
  });

  describe("init", () => {
    it("应该初始化勋章进度实例", async () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_test_001",
          template: "PlayerLevel",
          unlockParam: ["100"],
          medalRewardGroup: [],
        },
        {
          medalId: "medal_test_002",
          template: "PlayerLevel",
          unlockParam: ["100"],
          medalRewardGroup: [],
        },
      ];

      await manager.init();

      expect(Object.keys(manager.medals).length).toBe(2);
      expect(manager.medals["medal_test_001"]).toBeDefined();
      expect(manager.medals["medal_test_002"]).toBeDefined();
    });
  });

  describe("setCustomData", () => {
    it("应该设置自定义展示数据", () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const customData = { layout: "grid", positions: [0, 1, 2] };
      manager.setCustomData({ index: "1", data: asCustomLayout(customData) });

      expect(manager.custom.currentIndex).toBe("1");
      expect(manager.custom.customs["1"]).toEqual(customData);
    });

    it("应该覆盖已存在的自定义数据", () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      manager.setCustomData({ index: "0", data: asCustomLayout({ layout: "list" }) });
      expect(manager.custom.currentIndex).toBe("0");
      expect(manager.custom.customs["0"]).toEqual({ layout: "list" });
    });
  });

  describe("rewardMedal", () => {
    it("当勋章存在于 medals 中时应该设置 rts 并触发 items:get", async () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const medalItems = [{ type: "FURN", id: "furn_001", count: 1 }];
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_test_001",
          template: "PlayerLevel",
          unlockParam: ["100"],
          medalRewardGroup: [
            { groupId: "group_001", itemList: medalItems },
          ],
        },
      ];

      manager.medals["medal_test_001"] = new MedalProgress(
        {
          id: "medal_test_001",
          // 修复：奖励领取需勋章已完成（进度达标）——原测试 val [[50,100]] 未完成，
          // rewardMedal 修复后按完成态校验返回 []
          val: [[100, 100]],
          rts: -1,
          fts: 0,
          reward: "",
        },
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      // rewardMedal 已改 async（修复奖励发放与 delta 读取的竞态），须 await 取结果
      const result = await manager.rewardMedal({
        medalId: "medal_test_001",
        group: "group_001",
      });

      expect(result).toEqual(medalItems);
      // 物品发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      for (const it of medalItems) {
        expect(mockPlayer.gainItem.add).toHaveBeenCalledWith(it);
      }
      expect(mockPlayer.gainItem.handle).toHaveBeenCalledTimes(1);
      expect(manager.medals["medal_test_001"].rts).toBeGreaterThan(0);
    });

    it("当勋章不在 medals 中时应该从 playerdata 设置 rts", async () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const medalItems = [{ type: "DIAMOND", id: "4002", count: 1 }];
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_test_002",
          template: "PlayerLevel",
          unlockParam: ["100"],
          medalRewardGroup: [
            { groupId: "group_002", itemList: medalItems },
          ],
        },
      ];

      // 该勋章未领取（rts=-1）才允许发放奖励
      mockPlayer._playerdata.medal!.medals["medal_test_002"].rts = -1;
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      const result = await manager.rewardMedal({
        medalId: "medal_test_002",
        group: "group_002",
      });

      expect(result).toEqual(medalItems);
      // 物品发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      for (const it of medalItems) {
        expect(mockPlayer.gainItem.add).toHaveBeenCalledWith(it);
      }
      expect(mockPlayer.gainItem.handle).toHaveBeenCalledTimes(1);
      expect(
        mockPlayer._playerdata.medal!.medals["medal_test_002"].rts
      ).toBeGreaterThan(0);
    });

    it("勋章进度更新应经共享引用写入持久态（_playerdata.medal.medals[id].val）", async () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      await manager.init();
      // beforeEach 的 medal_test_001 带 val:[[50,100]]——MedalProgress.val 与该数组共享引用
      const progress = manager.medals["medal_test_001"];
      progress.param = ["50"];
      progress.PlayerLevel({ level: 30 }, "update");
      expect(progress.val[0][0]).toBe(30);
      // 原地更新即写回持久态（服务端落盘/读取依赖此共享引用机制）
      expect(
        manager["_playerdata"].medal.medals["medal_test_001"].val[0][0]
      ).toBe(30);
    });

    it("进度事件更新应显式写回持久态并标记脏（A1——不依赖共享引用隐式落盘）", async () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_test_001",
          template: "PlayerLevel",
          unlockParam: ["50"],
          medalRewardGroup: [],
        },
      ];
      const markDirtySpy = vi.spyOn(mockPlayer, "markDirty");
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      await manager.init();
      // 真实 TypedEventEmitter（Emittery）：emit 会调用 init() 订阅的进度处理函数
      await (mockTrigger).emit("PlayerLevel", [{ level: 30 }]);
      // 显式写回：持久态 val 同步（即使引用断链也会重链接）
      expect(
        manager["_playerdata"].medal.medals["medal_test_001"].val[0][0]
      ).toBe(30);
      // 显式标记脏：条件落盘不会漏掉 medal 进度更新
      expect(markDirtySpy).toHaveBeenCalled();
    });
  });

  describe("onMedalComplete", () => {
    it("当勋章有奖励组时应该触发 rewardMedal", async () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const rewardItems = [{ type: "FURN", id: "furn_test", count: 1 }];
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_test_001",
          template: "PlayerLevel",
          unlockParam: ["100"],
          medalRewardGroup: [
            { groupId: "default_group", itemList: rewardItems },
          ],
        },
      ];

      const rewardSpy = vi.spyOn(manager, "rewardMedal");
      await manager.onMedalComplete([{ medalId: "medal_test_001" }]);

      expect(rewardSpy).toHaveBeenCalledWith({
        medalId: "medal_test_001",
        group: "default_group",
      });
    });

    it("当勋章没有奖励组时不应该触发 rewardMedal", async () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_no_reward",
          template: "PlayerLevel",
          unlockParam: ["100"],
          medalRewardGroup: [],
        },
      ];

      const rewardSpy = vi.spyOn(manager, "rewardMedal");
      await manager.onMedalComplete([{ medalId: "medal_no_reward" }]);

      expect(rewardSpy).not.toHaveBeenCalled();
    });
  });

  describe("toJSON", () => {
    it("应该序列化勋章数据", () => {
      const manager = new MedalManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "test_medal",
          template: "",
          unlockParam: ["100"],
          medalRewardGroup: [],
        },
      ];

      manager.medals["test_medal"] = new MedalProgress(
        {
          id: "test_medal",
          val: [[100, 100]],
          rts: 123,
          fts: 456,
          reward: "done",
        },
        mockTrigger
      );

      const json = manager.toJSON();
      expect(json).toBeDefined();
      expect(json.medals).toBeDefined();
      expect(json.customs).toBeDefined();
    });
  });

  describe("MedalProgress", () => {
    it("应该正确构造 MedalProgress 实例", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "test_medal",
          template: "PlayerLevel",
          unlockParam: ["100"],
          medalRewardGroup: [],
        },
      ];

      const progress = new MedalProgress(
        {
          id: "test_medal",
          val: [[0, 100]],
          rts: 0,
          fts: 0,
          reward: "",
        },
        mockTrigger
      );

      expect(progress.id).toBe("test_medal");
      expect(progress.rts).toBe(0);
      expect(progress.fts).toBe(0);
    });

    it("当 fts 为 0 时应该调用 init", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_init",
          template: "",
          unlockParam: ["100"],
          medalRewardGroup: [],
        },
      ];

      const onSpy = vi.spyOn(mockTrigger, "on");
      const progress = new MedalProgress(
        {
          id: "medal_init",
          val: [[0, 100]],
          rts: 0,
          fts: 0,
          reward: "",
        },
        mockTrigger
      );

      expect(progress).toBeDefined();
    });

    it("PlayerLevel 模板应该正确初始化进度", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_level",
          template: "PlayerLevel",
          unlockParam: ["50"],
          medalRewardGroup: [],
        },
      ];

      const progress = new MedalProgress(
        {
          id: "medal_level",
          val: [[0, 50]],
          rts: 0,
          fts: 1,
          reward: "",
        },
        mockTrigger
      );

      expect(progress.val[0]).toEqual([0, 50]);
    });

    it("PlayerLevel 模板 update 应该更新进度值", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_level",
          template: "PlayerLevel",
          unlockParam: ["50"],
          medalRewardGroup: [],
        },
      ];

      const progress = new MedalProgress(
        {
          id: "medal_level",
          val: [[0, 50]],
          rts: 0,
          fts: 1,
          reward: "",
        },
        mockTrigger
      );

      progress.param = ["50"];
      progress.PlayerLevel({ level: 30 }, "update");
      expect(progress.val[0][0]).toBe(30);
    });

    it("toJSON 应该返回正确的序列化数据", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_json",
          template: "",
          unlockParam: ["100"],
          medalRewardGroup: [],
        },
      ];

      const progress = new MedalProgress(
        {
          id: "medal_json",
          val: [[75, 100]],
          rts: 1000,
          fts: 0,
          reward: "test",
        },
        mockTrigger
      );

      const json = progress.toJSON();
      expect(json.id).toBe("medal_json");
      expect(json.val).toEqual([[75, 100]]);
    });

    it("JoinGameDays 模板应计算注册天数", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_days",
          template: "JoinGameDays",
          unlockParam: ["30"],
          medalRewardGroup: [],
        },
      ];
      const progress = new MedalProgress(
        { id: "medal_days", val: [[0, 30]], fts: 0, rts: -1, reward: "" },
        mockTrigger
      );
      expect(progress.val[0][1]).toBe(30);
      progress.JoinGameDays({ registerTs: 100 }, "update");
      expect(progress.val[0][0]).toBeGreaterThanOrEqual(0);
    });

    it("CharNum 模板应记录干员数量", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_chnum",
          template: "CharNum",
          unlockParam: ["10"],
          medalRewardGroup: [],
        },
      ];
      const progress = new MedalProgress(
        { id: "medal_chnum", val: [[0, 10]], fts: 0, rts: -1, reward: "" },
        mockTrigger
      );
      progress.CharNum({ curCharInstId: 8 }, "update");
      // 修复：实际干员数 = curCharInstId - 1（instId 从 1 递增）——原实现多算 1
      expect(progress.val[0][0]).toBe(7);
    });

    it("RecruitCount 模板应累加招募次数", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_recruit",
          template: "RecruitCount",
          unlockParam: ["5"],
          medalRewardGroup: [],
        },
      ];
      const progress = new MedalProgress(
        { id: "medal_recruit", val: [[0, 5]], fts: 0, rts: -1, reward: "" },
        mockTrigger
      );
      progress.RecruitCount({}, "update");
      progress.RecruitCount({}, "update");
      expect(progress.val[0][0]).toBe(2);
    });

    it("GotChars 模板应累加获得干员数", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_got",
          template: "GotChars",
          unlockParam: ["3"],
          medalRewardGroup: [],
        },
      ];
      mockExcelRef.CharacterTable = { char_001: { rarity: 5 } };
      const progress = new MedalProgress(
        { id: "medal_got", val: [[0, 3]], fts: 0, rts: -1, reward: "" },
        mockTrigger
      );
      progress.GotChars({ char: { charId: "char_001" } }, "update");
      expect(progress.val[0][0]).toBe(1);
    });

    it("CharEvolveCount 模板应累加精一数量", () => {
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_evolve",
          template: "CharEvolveCount",
          unlockParam: ["1"],
          medalRewardGroup: [],
        },
      ];
      const progress = new MedalProgress(
        { id: "medal_evolve", val: [[0, 1]], fts: 0, rts: -1, reward: "" },
        mockTrigger
      );
      progress.CharEvolveCount({ char: { evolvePhase: 2 } }, "update");
      expect(progress.val[0][0]).toBe(1);
    });

    it("CharEvolvePhase 模板应按 unlockParam 的干员 id + 阶段判定（目标位修正）", () => {
      // 修复（2026-09-09，审计 §5.3）：真实数据 unlockParam = ["char_4195_radian","2"]，
      // 原实现取 parseInt(param[0]) 当目标 → parseInt("char_4195_radian") = NaN。
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_radian_evolve",
          template: "CharEvolvePhase",
          unlockParam: ["char_4195_radian", "2"],
          medalRewardGroup: [],
        },
      ];
      const progress = new MedalProgress(
        { id: "medal_radian_evolve", val: [[0, 0]], fts: 1, rts: -1, reward: "" },
        mockTrigger
      );
      progress.param = ["char_4195_radian", "2"];
      expect(progress._paramNum(1)).toBe(2);
      // 非目标干员不推进
      progress.CharEvolvePhase({ charId: "char_001", phase: 2 }, "update");
      expect(progress.val[0][0]).toBe(0);
      // 目标干员但阶段不足不推进
      progress.CharEvolvePhase({ charId: "char_4195_radian", phase: 1 }, "update");
      expect(progress.val[0][0]).toBe(0);
      // 目标干员达成精二 → 完成
      progress.CharEvolvePhase({ charId: "char_4195_radian", phase: 2 }, "update");
      expect(progress.val[0][0]).toBe(1);
    });

    it("CharSkillSpecCount 模板应按专精等级门槛计数", () => {
      // 真实数据 unlockParam = ["1","3"]（目标次数 1、专精等级门槛 3）
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_spec_01",
          template: "CharSkillSpecCount",
          unlockParam: ["1", "3"],
          medalRewardGroup: [],
        },
      ];
      const progress = new MedalProgress(
        { id: "medal_spec_01", val: [[0, 1]], fts: 1, rts: -1, reward: "" },
        mockTrigger
      );
      progress.param = ["1", "3"];
      // 专二不计数
      progress.CharSkillSpecCount({ targetLevel: 2 }, "update");
      expect(progress.val[0][0]).toBe(0);
      // 专三计数（+1/次）
      progress.CharSkillSpecCount({ targetLevel: 3 }, "update");
      expect(progress.val[0][0]).toBe(1);
      progress.CharSkillSpecCount({ targetLevel: 3 }, "update");
      expect(progress.val[0][0]).toBe(2);
    });

    it("PassTower 模板应累加通关次数", () => {
      // 修复（2026-09-09）：数据实参为保全派驻关卡 id（tower_n_XX），非数值次数——
      // 旧断言基于 `unlockParam: ["2"]` 的错误建模，此处改为按 stageId 计数。
      mockExcelRef.MedalTable.medalList = [
        {
          medalId: "medal_tower",
          template: "PassTower",
          unlockParam: ["tower_n_01", "0", "0"],
          medalRewardGroup: [],
        },
      ];
      const progress = new MedalProgress(
        { id: "medal_tower", val: [[0, 1]], fts: 1, rts: -1, reward: "" },
        mockTrigger
      );
      progress.param = ["tower_n_01", "0", "0"];
      progress.PassTower({ count: 1, stageId: "tower_n_01" }, "update");
      progress.PassTower({ count: 1, stageId: "tower_n_01" }, "update");
      expect(progress.val[0][0]).toBe(2);
    });
  });

describe("Medal 核心修复", () => {
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;
  let mockExcelRef: MedalExcelMock;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockExcelRef = vi.mocked(await import("@excel/excel")).default;
    mockExcelRef.MedalTable.medalList = [
      {
        medalId: "medal_lv_1",
        template: "PlayerLevel",
        unlockParam: ["50"],
        medalRewardGroup: [
          { groupId: "g1", itemList: [{ id: "furn_1", count: 1, type: "FURN" }] },
        ],
      },
      {
        medalId: "medal_lv_2",
        template: "PlayerLevel",
        unlockParam: ["100"],
        medalRewardGroup: [],
      },
      {
        medalId: "medal_broken",
        template: "PlayerLevel",
        unlockParam: ["1"],
        medalRewardGroup: [],
      },
    ];
  });

  it("fts 非 0 但进度未满的勋章应注册进度监听", () => {
    const onSpy = vi.spyOn(mockTrigger, "on");
    new MedalProgress(
      { id: "medal_lv_1", val: [[30, 50]], fts: 1000, rts: -1, reward: "" },
      mockTrigger,
    );
    expect(onSpy).toHaveBeenCalledWith("PlayerLevel", expect.any(Function));
  });

  it("进度已满的勋章不应注册监听", () => {
    const onSpy = vi.spyOn(mockTrigger, "on");
    new MedalProgress(
      { id: "medal_lv_1", val: [[50, 50]], fts: 1000, rts: -1, reward: "" },
      mockTrigger,
    );
    expect(onSpy).not.toHaveBeenCalled();
  });

  it("val 缺失的勋章（旧数据）构造不应崩溃且回填持久态（共享引用防断链）", () => {
    const onSpy = vi.spyOn(mockTrigger, "on");
    const item = asModel<PlayerPerMedal>({ id: "medal_broken", fts: 0, rts: -1, reward: "" });
    const progress = new MedalProgress(item, mockTrigger);
    // init 在共享引用上构建进度结构 [0, unlockParam]（unlockParam ["1"]）并回填 item.val
    expect(progress.val[0][0]).toBe(0);
    expect(progress.val[0][1]).toBe(1);
    // 回填到持久态并共享同一引用——进度原地更新不再断链
    expect(item.val).toBe(progress.val);
    progress.PlayerLevel({ level: 5 }, "update");
    expect(item.val[0][0]).toBe(5);
    expect(onSpy).toHaveBeenCalled();
  });

  it("val 缺失但有模板：init 构建的结构回填持久态（进度可持久化）", () => {
    mockExcelRef.MedalTable.medalList = [
      { medalId: "medal_a", template: "PlayerLevel", unlockParam: ["10"], medalRewardGroup: [] },
    ];
    const item = asModel<PlayerPerMedal>({ id: "medal_a", fts: 0, rts: -1, reward: "" });
    const progress = new MedalProgress(item, mockTrigger);
    // init 在共享引用上构建 [0, target] 并回填 item.val
    expect(item.val).toBe(progress.val);
    expect(progress.val[0][0]).toBe(0);
    expect(progress.val[0][1]).toBe(10);
    // 更新进度 → 原地写共享引用 → 直接落入持久态
    progress.PlayerLevel({ level: 5 }, "update");
    expect(item.val[0][0]).toBe(5);
  });

  it("rewardMedal 已领取（rts != -1）不应重复发放", async () => {
    const pd = mockPlayerData({
      medal: {
        medals: {
          medal_lv_1: {
            id: "medal_lv_1",
            val: [[50, 50]],
            rts: 1234567890,
            fts: 1000,
            reward: "",
          },
        },
        custom: { currentIndex: "0", customs: {} },
      },
    });
    pd._trigger = mockTrigger;
    const manager = new MedalManager(asPlayerManager(pd), mockTrigger);
    await manager.init();
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    const items = await manager.rewardMedal({ medalId: "medal_lv_1", group: "g1" });
    expect(items).toEqual([]);
    expect(emitSpy).not.toHaveBeenCalledWith("items:get", expect.any(Array));
  });

  it("rewardMedal 领取后 rts 应持久化到 playerdata", async () => {
    const pd = mockPlayerData({
      medal: {
        medals: {
          medal_lv_1: {
            id: "medal_lv_1",
            val: [[50, 50]],
            rts: -1,
            fts: 1000,
            reward: "",
          },
        },
        custom: { currentIndex: "0", customs: {} },
      },
    });
    pd._trigger = mockTrigger;
    const manager = new MedalManager(asPlayerManager(pd), mockTrigger);
    await manager.init();
    await manager.rewardMedal({ medalId: "medal_lv_1", group: "g1" });
    expect(pd._playerdata.medal.medals["medal_lv_1"].rts).not.toBe(-1);
  });
});

describe("MedalManager 集齐章结算", () => {
  it("前置章全部达成才点亮（未全不点亮）", async () => {
    const ref: MedalExcelMock = vi.mocked(await import("@excel/excel")).default;
    ref.MedalTable.medalList = [
      { medalId: "G", medalName: "集章", template: null, preMedalIdList: ["P1", "P2"], medalRewardGroup: [] },
      { medalId: "P1", template: "PassStageSome", preMedalIdList: [], medalRewardGroup: [] },
      { medalId: "P2", template: "PassStageSome", preMedalIdList: [], medalRewardGroup: [] },
    ];
    const player = mockPlayerData({
      medal: {
        medals: {
          G: { id: "G", val: [[]], fts: 0, rts: -1 },
          P1: { id: "P1", val: [[0, 1]], fts: 100, rts: -1 },
          P2: { id: "P2", val: [[0, 1]], fts: 0, rts: -1 },
        },
        custom: { currentIndex: "", customs: {} },
      },
    });
    const mgr = new MedalManager(asPlayerManager(player), mockTypedEventEmitter());
    mgr.medals = {};
    // P2 未完成（fts=0 且 val 未满）→ 集章不点亮
    await mgr["_settleCollectionMedals"]();
    expect(player._playerdata.medal.medals["G"].fts).toBe(0);
    // P2 进度填满 → 全部前置达成 → 集章点亮（fts>0）
    player._playerdata.medal.medals["P2"].val = [[1, 1]];
    await mgr["_settleCollectionMedals"]();
    expect(player._playerdata.medal.medals["G"].fts).toBeGreaterThan(0);
  });
});

describe("S1 勋章事件补齐（2026-09-09 修复）", () => {
  it("PassTower：按保全派驻关卡 id 判定通关（原 parseInt(param[0]) 恒 NaN）", () => {
    const p = new MedalProgress(
      asModel<PlayerPerMedal>({ id: "medal_tower_complete_01", fts: 1, rts: -1 }),
      mockTypedEventEmitter(),
    );
    p.param = ["tower_n_01", "0", "0"];
    p.PassTower({}, "init");
    expect(p.val[0][1]).toBe(1); // 目标恒为 1（通关即完成）
    p.PassTower({ stageId: "tower_n_02" }, "update");
    expect(p.val[0][0]).toBe(0); // 非目标副本不推进
    p.PassTower({ stageId: "tower_n_01", count: 1, isHard: false }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("PassTower：困难章需 isHard", () => {
    const p = new MedalProgress(
      asModel<PlayerPerMedal>({ id: "medal_tower_complete_05_hard", fts: 1, rts: -1 }),
      mockTypedEventEmitter(),
    );
    p.param = ["tower_n_05", "0", "1"];
    p.PassTower({}, "init");
    p.PassTower({ stageId: "tower_n_05", isHard: false }, "update");
    expect(p.val[0][0]).toBe(0);
    p.PassTower({ stageId: "tower_n_05", isHard: true }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("GotItemBeforeTime：按物品 id + 截止时间判定（原为注册天数占位）", () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    const p = new MedalProgress(
      asModel<PlayerPerMedal>({ id: "medal_skin_1", fts: 1, rts: -1 }),
      mockTypedEventEmitter(),
    );
    p.param = ["1", "char_264_f12yin@marthe#13", String(future)];
    p.GotItemBeforeTime({}, "init");
    expect(p.val[0][1]).toBe(1);
    p.GotItemBeforeTime({ itemId: "other_skin" }, "update");
    expect(p.val[0][0]).toBe(0);
    p.GotItemBeforeTime({ itemId: "char_264_f12yin@marthe#13" }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("GotItemBeforeTime：超过截止时间不再推进", () => {
    const past = Math.floor(Date.now() / 1000) - 86400;
    const p = new MedalProgress(
      asModel<PlayerPerMedal>({ id: "medal_skin_2", fts: 1, rts: -1 }),
      mockTypedEventEmitter(),
    );
    p.param = ["1", "skin_x", String(past)];
    p.GotItemBeforeTime({}, "init");
    p.GotItemBeforeTime({ itemId: "skin_x" }, "update");
    expect(p.val[0][0]).toBe(0);
  });

  it("CampaignsComplete：击杀 400 且无未领突破奖励才完成", () => {
    const p = new MedalProgress(
      asModel<PlayerPerMedal>({ id: "medal_camp_permanent_01", fts: 1, rts: -1 }),
      mockTypedEventEmitter(),
    );
    p.param = ["camp_01"];
    p.CampaignsComplete({}, "init");
    expect(p.val[0][1]).toBe(1);
    p.CampaignsComplete(
      { instances: { camp_01: { maxKills: 399, rewardStatus: [] } } },
      "update",
    );
    expect(p.val[0][0]).toBe(0);
    p.CampaignsComplete(
      { instances: { camp_01: { maxKills: 400, rewardStatus: [0, 1] } } },
      "update",
    );
    expect(p.val[0][0]).toBe(0); // 有未领突破奖励
    p.CampaignsComplete(
      { instances: { camp_01: { maxKills: 400, rewardStatus: [1, 1] } } },
      "update",
    );
    expect(p.val[0][0]).toBe(1);
  });
});

describe("S1 战斗统计勋章（2026-09-09 修复：模板占位/事件缺失）", () => {
  function makeP(id: string, param: string[]) {
    const p = new MedalProgress(
      asModel<PlayerPerMedal>({ id, fts: 1, rts: -1 }),
      mockTypedEventEmitter(),
    );
    p.param = param;
    return p;
  }
  const stats = (over: Partial<PassStageStats> = {}): PassStageStats => ({
    stageId: "act47side_06",
    completeState: 3,
    enemyStats: [],
    extraBattleInfo: {},
    ...over,
  });

  it("PassStageWithSimpleCountLess：通关且计数器未触发才推进", () => {
    const p = makeP("m1", ["3", "act47side_06", "enemy_x", "FALLDOWN", "2"]);
    p.PassStageWithSimpleCountLess(asModel<PassStageStats>({}), "init");
    expect(p.val[0][1]).toBe(2);
    p.PassStageWithSimpleCountLess(
      stats({
        enemyStats: [{ Key: { enemyId: "enemy_x", counterType: "FALLDOWN" }, Value: 1 }],
      }),
      "update",
    );
    expect(p.val[0][0]).toBe(0); // 已触发 → 不算
    p.PassStageWithSimpleCountLess(stats(), "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("PassStageKilled：通关且击杀达标才推进", () => {
    const p = makeP("m2", ["3", "act42side_08", "enemy_10091_hlsttu_3", "1"]);
    p.PassStageKilled(asModel<PassStageStats>({}), "init");
    p.PassStageKilled(stats({ stageId: "act99_01" }), "update");
    expect(p.val[0][0]).toBe(0); // 关卡不符
    p.PassStageKilled(
      stats({
        stageId: "act42side_08",
        enemyStats: [
          { Key: { enemyId: "enemy_10091_hlsttu_3", counterType: "KILL" }, Value: 2 },
        ],
      }),
      "update",
    );
    expect(p.val[0][0]).toBe(1);
  });

  it("PassStageKilledLess：未击杀（不超阈值）才推进", () => {
    const p = makeP("m3", ["3", "act19side_ex07", "enemy_1257_lydrty", "0"]);
    p.PassStageKilledLess(asModel<PassStageStats>({}), "init");
    p.PassStageKilledLess(
      stats({
        stageId: "act19side_ex07",
        enemyStats: [
          { Key: { enemyId: "enemy_1257_lydrty", counterType: "KILL" }, Value: 1 },
        ],
      }),
      "update",
    );
    expect(p.val[0][0]).toBe(0);
    p.PassStageKilledLess(stats({ stageId: "act19side_ex07" }), "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("PassStageKilledTotal：按关卡组累计击杀数", () => {
    const p = makeP("m4", [
      "2",
      "act43side_01;act43side_02",
      "trap_248_crprop",
      "30",
    ]);
    p.PassStageKilledTotal(asModel<PassStageStats>({}), "init");
    expect(p.val[0][1]).toBe(30);
    p.PassStageKilledTotal(
      stats({
        stageId: "act43side_01",
        completeState: 3,
        enemyStats: [
          { Key: { enemyId: "trap_248_crprop", counterType: "KILL" }, Value: 12 },
        ],
      }),
      "update",
    );
    expect(p.val[0][0]).toBe(12);
    p.PassStageKilledTotal(
      stats({
        stageId: "act43side_09", // 不在组内
        enemyStats: [
          { Key: { enemyId: "trap_248_crprop", counterType: "KILL" }, Value: 50 },
        ],
      }),
      "update",
    );
    expect(p.val[0][0]).toBe(12);
  });

  it("PassStageWithSimpleTokenCountMore/Less：按 extraBattleInfo token 判定", () => {
    const more = makeP("m5", ["3", "act48side_ex01", "pirene_hp_full", "10"]);
    more.PassStageWithSimpleTokenCountMore(asModel<PassStageStats>({}), "init");
    expect(more.val[0][1]).toBe(10);
    more.PassStageWithSimpleTokenCountMore(
      stats({ stageId: "act48side_ex01" }),
      "update",
    );
    expect(more.val[0][0]).toBe(0); // token 缺失
    more.PassStageWithSimpleTokenCountMore(
      stats({
        stageId: "act48side_ex01",
        extraBattleInfo: { pirene_hp_full: "1" },
      }),
      "update",
    );
    expect(more.val[0][0]).toBe(1);

    const less = makeP("m6", ["3", "act47side_06", "killed_by_nstree", "21"]);
    less.PassStageWithSimpleTokenCountLess(asModel<PassStageStats>({}), "init");
    less.PassStageWithSimpleTokenCountLess(
      stats({ extraBattleInfo: { killed_by_nstree: 3 } }),
      "update",
    );
    expect(less.val[0][0]).toBe(0); // 已触发
    less.PassStageWithSimpleTokenCountLess(stats(), "update");
    expect(less.val[0][0]).toBe(1);
  });
});

describe("MedalManager 危机合约章（事件驱动 + unlockParam 参数位修复）", () => {
  /** 构造进度对象（param 由用例按官方 unlockParam 赋值） */
  function mk(id: string) {
    const item = asModel<PlayerPerMedal>({ id, fts: 1, rts: -1 });
    return new MedalProgress(item, mockTypedEventEmitter());
  }

  // 修复（2026-09-09）：危机合约 / 重构符文系列的 unlockParam[0] 是**赛季 id**
  // （rune_season_12_1 / crisis_v2_season_5_1 …），数值目标排在其后的关卡/词条/任务
  // 清单之后再一位。原实现这些模板一律 parseInt(this.param[0]) → NaN →
  // `0 >= NaN` 恒 false → 监听器虽注册却永不可能达成（约 100 枚危机章 + 16 枚重构符文章）。
  it("CrisisStageScoreSome：目标恒为 1，危机等级达 unlockParam[3] 门槛才点亮（按赛季+关卡门控）", () => {
    const p = mk("c1");
    // 官服存档实证：medal_activity_11d5_02 param=[...,"level_rune_04-01","1","8"] → val [[1,1]]；
    // medal_activity_10d0_03 param=[...,"1","16"] → val [[0,1]]（目标恒为 1）
    p.param = ["rune_season_2_1", "level_rune_04-01", "1", "8"];
    p.CrisisStageScoreSome({}, "init");
    expect(p.val[0][1]).toBe(1); // 修复前为 NaN
    // 其它赛季 / 其它关卡均不计入
    p.CrisisStageScoreSome({ seasonId: "rune_season_1_1", stageId: "level_rune_04-01", score: 99 }, "update");
    p.CrisisStageScoreSome({ seasonId: "rune_season_2_1", stageId: "level_rune_99-01", score: 99 }, "update");
    expect(p.val[0][0]).toBe(0);
    // 门槛未达（< 8）不计入
    p.CrisisStageScoreSome({ seasonId: "rune_season_2_1", stageId: "level_rune_04-01", score: 7 }, "update");
    expect(p.val[0][0]).toBe(0);
    // 达标 → 按 param[2] 写入进度（S 评价档 = 1）
    p.CrisisStageScoreSome({ seasonId: "rune_season_2_1", stageId: "level_rune_04-01", score: 8 }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("CrisisStageScoreSome：unlockParam[1] 为分号关卡列表时任一命中即可", () => {
    const p = mk("c1b");
    p.param = ["rune_season_1_1", "level_rune_03-02;level_rune_01-03", "1", "8"];
    p.CrisisStageScoreSome({}, "init");
    p.CrisisStageScoreSome({ seasonId: "rune_season_1_1", stageId: "level_rune_05-01", score: 20 }, "update");
    expect(p.val[0][0]).toBe(0);
    p.CrisisStageScoreSome({ seasonId: "rune_season_1_1", stageId: "level_rune_01-03", score: 20 }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  // Round 32：主题/活动类模板的 unlockParam[0] 是主题 id（rogue_4 / act13sre …），
  // 目标位在其后 —— 原实现一律 parseInt(param[0]) → NaN → 该类勋章永不可得。
  // 目标位由官服存档 val[0][1] 反推（21 个模板 / 79 枚）。
  it("Rlv2PassNode：目标取 unlockParam[1]，按主题门控", () => {
    const p = mk("r10");
    p.param = ["rogue_4", "200"];
    p.Rlv2PassNode({}, "init");
    expect(p.val[0][1]).toBe(200); // 修复前为 NaN
    p.Rlv2PassNode({ theme: "rogue_5" }, "update");
    expect(p.val[0][0]).toBe(0); // 其它主题不计
    p.Rlv2PassNode({ theme: "rogue_4" }, "update");
    p.Rlv2PassNode({ theme: "rogue_4" }, "update");
    expect(p.val[0][0]).toBe(2);
  });

  it("Rlv2PassZone：目标取 unlockParam[2]，按主题 + zoneId 门控", () => {
    const p = mk("r11");
    p.param = ["rogue_6", "zone_3", "20"];
    p.Rlv2PassZone({}, "init");
    expect(p.val[0][1]).toBe(20);
    p.Rlv2PassZone({ theme: "rogue_4", zoneId: "zone_3" }, "update");
    p.Rlv2PassZone({ theme: "rogue_6", zoneId: "zone_1" }, "update");
    expect(p.val[0][0]).toBe(0);
    p.Rlv2PassZone({ theme: "rogue_6", zoneId: "zone_3" }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("Rlv2Recruit：目标取 unlockParam[1]，按主题门控", () => {
    const p = mk("r12");
    p.param = ["rogue_6", "40"];
    p.Rlv2Recruit({}, "init");
    expect(p.val[0][1]).toBe(40);
    p.Rlv2Recruit({ theme: "rogue_4" }, "update");
    expect(p.val[0][0]).toBe(0);
    p.Rlv2Recruit({ theme: "rogue_6" }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("Rlv2FinishBattleWithSpecChar：目标取 unlockParam[3]，仅携带指定干员（含变体）时按胜利数累加", () => {
    const p = mk("r17");
    // 官服 medal_rogue_1_11：基础/进阶两种形态，携带任一即算
    p.param = ["rogue_1", "char_512_aprot", "char_4025_aprot2", "10"];
    p.Rlv2FinishBattleWithSpecChar({}, "init");
    expect(p.val[0][1]).toBe(10); // 修复前为 NaN
    p.Rlv2FinishBattleWithSpecChar(
      { theme: "rogue_1", charIds: ["char_001"], battleWinCount: 5 },
      "update",
    );
    expect(p.val[0][0]).toBe(0); // 未携带 → 不计
    p.Rlv2FinishBattleWithSpecChar(
      { theme: "rogue_4", charIds: ["char_512_aprot"], battleWinCount: 5 },
      "update",
    );
    expect(p.val[0][0]).toBe(0); // 其它主题不计
    p.Rlv2FinishBattleWithSpecChar(
      { theme: "rogue_1", charIds: ["char_001", "char_4025_aprot2"], battleWinCount: 3 },
      "update",
    );
    expect(p.val[0][0]).toBe(3); // 携带进阶形态亦算
    p.Rlv2FinishBattleWithSpecChar(
      { theme: "rogue_1", charIds: ["char_512_aprot"], battleWinCount: 4 },
      "update",
    );
    expect(p.val[0][0]).toBe(7); // 跨局累加
  });

  it("Rlv2BpLevel：目标取 unlockParam[1]，载荷为当前等级，按主题门控且不回退", () => {
    const p = mk("r16");
    p.param = ["rogue_6", "65"];
    p.Rlv2BpLevel({}, "init");
    expect(p.val[0][1]).toBe(65); // 修复前为 NaN
    p.Rlv2BpLevel({ theme: "rogue_4", level: 9 }, "update");
    expect(p.val[0][0]).toBe(0); // 其它主题不计
    p.Rlv2BpLevel({ theme: "rogue_6", level: 12 }, "update");
    expect(p.val[0][0]).toBe(12);
    p.Rlv2BpLevel({ theme: "rogue_6", level: 5 }, "update");
    expect(p.val[0][0]).toBe(12); // 等级不回退
    p.Rlv2BpLevel({ theme: "rogue_6", level: 65 }, "update");
    expect(p.val[0][0]).toBe(65);
  });

  it("Rlv2EndingCollect：载荷为已达成结局种数（取 max，幂等）且按主题门控", () => {
    const p = mk("r15");
    p.param = ["rogue_6", "2"];
    p.Rlv2EndingCollect({}, "init");
    expect(p.val[0][1]).toBe(2); // 修复前为 NaN
    p.Rlv2EndingCollect({ theme: "rogue_4", count: 9 }, "update");
    expect(p.val[0][0]).toBe(0);
    p.Rlv2EndingCollect({ theme: "rogue_6", count: 1 }, "update");
    expect(p.val[0][0]).toBe(1);
    p.Rlv2EndingCollect({ theme: "rogue_6", count: 1 }, "update");
    expect(p.val[0][0]).toBe(1); // 幂等（原实现逐条 +1）
    p.Rlv2EndingCollect({ theme: "rogue_6", count: 3 }, "update");
    expect(p.val[0][0]).toBe(3);
  });

  it("Rlv2CollectRelic / Rlv2UnlockBand：载荷为累计数，取 max（幂等）且按主题门控", () => {
    const a = mk("r13");
    a.param = ["rogue_6", "100"];
    a.Rlv2CollectRelic({}, "init");
    expect(a.val[0][1]).toBe(100);
    a.Rlv2CollectRelic({ theme: "rogue_4", count: 99 }, "update");
    expect(a.val[0][0]).toBe(0); // 其它主题不计
    a.Rlv2CollectRelic({ theme: "rogue_6", count: 40 }, "update");
    expect(a.val[0][0]).toBe(40);
    a.Rlv2CollectRelic({ theme: "rogue_6", count: 40 }, "update");
    expect(a.val[0][0]).toBe(40); // 幂等（原实现会累加）
    a.Rlv2CollectRelic({ theme: "rogue_6", count: 100 }, "update");
    expect(a.val[0][0]).toBe(100);

    const b = mk("r14");
    b.param = ["rogue_3", "4"];
    b.Rlv2UnlockBand({}, "init");
    expect(b.val[0][1]).toBe(4);
    b.Rlv2UnlockBand({ theme: "rogue_3", count: 2 }, "update");
    expect(b.val[0][0]).toBe(2);
    b.Rlv2UnlockBand({ theme: "rogue_6", count: 4 }, "update");
    expect(b.val[0][0]).toBe(2);
  });

  it("生息演算（Sbv2）目标位：12 枚按官服存档真值（含 3 枚「条件达成标志」）", () => {
    // 官服存档 val[0][1] 逐条核对；FinishQuest/PlaceBuilding/PassRiftLevel 的
    // unlockParam[1] 是**条件 id**（任务/建筑/难度），目标恒为 1。
    const cases: [string, string[], number][] = [
      ["Sbv2UpgradeBase", ["sandbox_1", "2"], 2],
      ["Sbv2FinishQuest", ["sandbox_1", "mainline3c"], 1],
      ["Sbv2BattleFinishWithChar", ["sandbox_1", "char_4023_rfalcn", "10"], 10],
      ["Sbv2UnlockCook", ["sandbox_1", "20"], 20],
      ["Sbv2PlaceBuilding", ["sandbox_1", "sandbox_1_building_31"], 1],
      ["Sbv2PassRiftLevel", ["sandbox_1", "difficulty_3"], 1],
      ["Sbv2PassRiftCount", ["sandbox_1", "3"], 3],
      ["Sbv2CatchAnimal", ["sandbox_1", "1", "sandbox_1_animal_17;sandbox_1_animal_7"], 1],
      ["Sbv2UnlockTech", ["sandbox_1", "54"], 54],
      ["Sbv2SurviveDays", ["sandbox_1", "challenge", "6"], 6],
      ["Sbv2KillBoss", ["sandbox_1", "3"], 3],
      ["Sbv2KillBoss", ["sandbox_1", "6"], 6],
    ];
    for (const [tpl, params, want] of cases) {
      const p = mk("s_" + tpl + "_" + want);
      p.param = params;
      callTemplate(p, tpl, {}, "init");
      expect(p.val[0][1], tpl + JSON.stringify(params)).toBe(want);
      expect(Number.isFinite(p.val[0][1]), tpl).toBe(true);
    }
  });

  it("主题/活动类模板目标位批量修复：21 个模板均取到真实数值目标", () => {
    // 每条为「模板名 + 官服 unlockParam + 官服存档 val[0][1]（真值）」
    const cases: [string, string[], number][] = [
      ["Rlv2EndingCollect", ["rogue_6", "2"], 2],
      ["Rlv2Recruit", ["rogue_6", "40"], 40],
      ["Rlv2CollectRelic", ["rogue_6", "100"], 100],
      ["Rlv2GetTeamReward", ["rogue_6", "3"], 3],
      ["Rlv2BpLevel", ["rogue_6", "65"], 65],
      ["Rlv2UnlockBand", ["rogue_3", "4"], 4],
      ["Rlv2FinishBattleWithSpecChar", ["rogue_4", "char_4151_tinman", "char_4151_tinman", "10"], 10],
      ["PassStageWithBossRush", ["2", "act6bossrush_ex04", "1"], 1],
      ["ActivityAutoChessPassGame", ["act2autochess", "1", "mode_multi_normal"], 1],
      ["ActivityReachPrestigeLevel", ["act13sre", "1", "S"], 1],
      ["ActivitySandboxCreateItem", ["act1sandbox", "60", "FOOD"], 60],
      ["Act42D0FinishChallenge", ["act42d0", "3"], 3],
      ["Act29SideSyncthesizeMelody", ["act29sre", "10"], 10],
      ["Sbv2KillBoss", ["sandbox_1", "3"], 3],
      ["Act35SideFinishCarving", ["act35sre", "2"], 2],
      ["Act38SideCompletePuzzle", ["act38sre", "2"], 2],
      ["PassStoryStageSome", ["act25side_st04", "1"], 1],
      ["GainCarAccessories", ["durcar_gear_a_1_1;durcar_gear_a_1_2", "20"], 20],
      ["ActMultiplayVerify2PassStageWithScore", ["act2vmulti", "act2vmulti-01", "1", "3"], 1],
    ];
    for (const [tpl, params, want] of cases) {
      const p = mk("t_" + tpl);
      p.param = params;
      callTemplate(p, tpl, {}, "init");
      expect(p.val[0][1], tpl).toBe(want);
      expect(Number.isFinite(p.val[0][1]), tpl).toBe(true);
    }
  });

  it("存档目标位为 null（旧实现 NaN 落盘）时按重算目标回写", () => {
    const item: LegacyMedalItem = { id: "c10", fts: -1, rts: -1, val: [[0, null]] };
    const prev = mockExcelRef.MedalTable.medalList;
    mockExcelRef.MedalTable.medalList = [
      {
        medalId: "c10",
        template: "CrisisStageScoreSome",
        unlockParam: ["rune_season_12_1", "level_rune_14-01", "1", "8"],
      },
    ];
    const markDirty = vi.fn();
    const p = new MedalProgress(item as PlayerPerMedal, mockTypedEventEmitter(), markDirty);
    // NaN 经 JSON 落盘为 null → 回写为真实目标（否则客户端进度条无目标、
    // 且 rewardMedal/集齐章的完成判定 val[0][1] != null 永假）
    expect(item.val[0][1]).toBe(1);
    expect(p.val[0][1]).toBe(1);
    expect(markDirty).toHaveBeenCalled();
    mockExcelRef.MedalTable.medalList = prev;
  });

  it("CrisisTaskSome：目标取 unlockParam[2]，仅统计清单内任务", () => {
    const p = mk("c2");
    p.param = ["rune_season_12_1", "normalTask_1;normalTask_2;normalTask_3", "3"];
    p.CrisisTaskSome({}, "init");
    expect(p.val[0][1]).toBe(3);
    p.CrisisTaskSome({ seasonId: "rune_season_12_1", taskId: "normalTask_9" }, "update");
    expect(p.val[0][0]).toBe(0); // 清单外任务不计
    p.CrisisTaskSome({ seasonId: "rune_season_12_1", taskId: "normalTask_1" }, "update");
    p.CrisisTaskSome({ seasonId: "rune_season_11_1", taskId: "normalTask_2" }, "update");
    p.CrisisTaskSome({ seasonId: "rune_season_12_1", taskId: "normalTask_2" }, "update");
    p.CrisisTaskSome({ seasonId: "rune_season_12_1", taskId: "normalTask_3" }, "update");
    expect(p.val[0][0]).toBe(3);
  });

  it("CrisisUnlockPermRuneSome：目标取 unlockParam[2]，仅统计清单内 3 级词条", () => {
    const p = mk("c3");
    p.param = ["rune_season_12_1", "enemy_reid_3;char_atk_3", "4"];
    p.CrisisUnlockPermRuneSome({}, "init");
    expect(p.val[0][1]).toBe(4);
    p.CrisisUnlockPermRuneSome({ seasonId: "rune_season_12_1", runeId: "enemy_hp_3" }, "update");
    expect(p.val[0][0]).toBe(0);
    p.CrisisUnlockPermRuneSome({ seasonId: "rune_season_12_1", runeId: "enemy_reid_3" }, "update");
    p.CrisisUnlockPermRuneSome({ seasonId: "rune_season_12_1", runeId: "char_atk_3" }, "update");
    expect(p.val[0][0]).toBe(2);
  });

  it("CrisisV2DimScoreSome：目标恒为 1，任意维度达 unlockParam[3] 门槛（按赛季+地图门控）", () => {
    const p = mk("c4");
    p.param = ["crisis_v2_season_5_1", "crisis_v2_05-01", "0;1;2;3;4;5", "100"];
    p.CrisisV2DimScoreSome({}, "init");
    expect(p.val[0][1]).toBe(1); // 官服存档 _09 val [[1,1]]
    p.CrisisV2DimScoreSome({ seasonId: "crisis_v2_season_5_1", mapId: "crisis_v2_05-03", score: 999 }, "update");
    expect(p.val[0][0]).toBe(0); // 非主测试地不计
    p.CrisisV2DimScoreSome({ seasonId: "crisis_v2_season_5_1", mapId: "crisis_v2_05-01", score: 99 }, "update");
    expect(p.val[0][0]).toBe(0); // 未达门槛
    p.CrisisV2DimScoreSome({ seasonId: "crisis_v2_season_5_1", mapId: "crisis_v2_05-01", score: 100 }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("CrisisV2DimScoreTotal：目标恒为 1，单局各维之和达 unlockParam[3] 门槛", () => {
    const p = mk("c5");
    p.param = ["crisis_v2_season_5_1", "level_crisis_v2_05-01", "0;1;2;3;4;5", "300"];
    p.CrisisV2DimScoreTotal({}, "init");
    expect(p.val[0][1]).toBe(1); // 官服存档 300/600/620 三档 val 均为 [[1,1]]
    // unlockParam[1] 带 level_ 前缀，事件 mapId 无前缀 → 归一化后匹配
    p.CrisisV2DimScoreTotal({ seasonId: "crisis_v2_season_5_1", mapId: "crisis_v2_05-01", score: 299 }, "update");
    expect(p.val[0][0]).toBe(0);
    p.CrisisV2DimScoreTotal({ seasonId: "crisis_v2_season_5_1", mapId: "crisis_v2_05-01", score: 320 }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("CrisisV2NodeSome：目标取 unlockParam[2]，载荷为已完成节点**全集**，取交集计数并幂等", () => {
    const p = mk("c6");
    p.param = [
      "crisis_v2_season_5_1",
      "crisis_v2_05-01^pack_1;crisis_v2_05-01^pack_2",
      "2",
    ];
    p.CrisisV2NodeSome({}, "init");
    expect(p.val[0][1]).toBe(2);
    // 清单外节点不计
    p.CrisisV2NodeSome(
      { seasonId: "crisis_v2_season_5_1", nodeIds: ["crisis_v2_05-01^pack_3"] },
      "update",
    );
    expect(p.val[0][0]).toBe(0);
    // 其它赛季不计
    p.CrisisV2NodeSome(
      { seasonId: "crisis_v2_season_4_1", nodeIds: ["crisis_v2_05-01^pack_1"] },
      "update",
    );
    expect(p.val[0][0]).toBe(0);
    // 全集载荷 → 交集计数
    p.CrisisV2NodeSome(
      {
        seasonId: "crisis_v2_season_5_1",
        nodeIds: ["crisis_v2_05-01^pack_1", "crisis_v2_05-01^pack_3"],
      },
      "update",
    );
    expect(p.val[0][0]).toBe(1);
    // 幂等：重复派发同一全集不会多计（原实现逐次 +1 会刷到 2）
    p.CrisisV2NodeSome(
      {
        seasonId: "crisis_v2_season_5_1",
        nodeIds: ["crisis_v2_05-01^pack_1", "crisis_v2_05-01^pack_3"],
      },
      "update",
    );
    expect(p.val[0][0]).toBe(1);
    p.CrisisV2NodeSome(
      {
        seasonId: "crisis_v2_season_5_1",
        nodeIds: ["crisis_v2_05-01^pack_1", "crisis_v2_05-01^pack_2"],
      },
      "update",
    );
    expect(p.val[0][0]).toBe(2);
  });

  it("CrisisV2UseAssist：目标取 unlockParam[1]，逐次累加", () => {
    const p = mk("c7");
    p.param = ["crisis_v2_season_5_1", "5"];
    p.CrisisV2UseAssist({}, "init");
    expect(p.val[0][1]).toBe(5);
    p.CrisisV2UseAssist({ seasonId: "crisis_v2_season_5_1", used: 1 }, "update");
    p.CrisisV2UseAssist({ seasonId: "crisis_v2_season_4_1", used: 1 }, "update");
    expect(p.val[0][0]).toBe(1);
  });

  it("CrisisStageScoreBeforeTime：目标恒为 1，达 18 危机等级且未过截止时间才点亮", () => {
    const p = mk("c8");
    // 黄铁行动：18 危机等级 + 2020-06-09 前完成（截止时间早已过去）
    p.param = ["rune_season_1_1", "level_rune_03-01", "18", "1591646399"];
    p.CrisisStageScoreBeforeTime({}, "init");
    expect(p.val[0][1]).toBe(1); // 官服存档 val [[0,1]]
    p.CrisisStageScoreBeforeTime(
      { seasonId: "rune_season_1_1", stageId: "level_rune_03-01", score: 20 },
      "update",
    );
    expect(p.val[0][0]).toBe(0); // 窗口已关闭 → 不可得（官服本就限时）
    // 窗口未过时同样只认「达 18 级」
    const q = mk("c8b");
    q.param = ["rune_season_1_1", "level_rune_03-01", "18", String(9_999_999_999)];
    q.CrisisStageScoreBeforeTime({}, "init");
    q.CrisisStageScoreBeforeTime(
      { seasonId: "rune_season_1_1", stageId: "level_rune_03-01", score: 17 },
      "update",
    );
    expect(q.val[0][0]).toBe(0);
    q.CrisisStageScoreBeforeTime(
      { seasonId: "rune_season_1_1", stageId: "level_rune_03-01", score: 18 },
      "update",
    );
    expect(q.val[0][0]).toBe(1);
  });

  it("RecalRuneStageScoreSome：目标恒为 1，评分达 unlockParam[2] 门槛（按赛季+关卡门控）", () => {
    const p = mk("c9");
    p.param = ["recalRune_season_2", "level_recalrune_02-01", "8"];
    p.RecalRuneStageScoreSome({}, "init");
    expect(p.val[0][1]).toBe(1);
    p.RecalRuneStageScoreSome(
      { seasonId: "recalRune_season_2", stageId: "level_recalrune_02-02", score: 9 },
      "update",
    );
    expect(p.val[0][0]).toBe(0); // 非该关卡
    p.RecalRuneStageScoreSome(
      { seasonId: "recalRune_season_2", stageId: "level_recalrune_02-01", score: 7 },
      "update",
    );
    expect(p.val[0][0]).toBe(0); // 未达 8 分
    p.RecalRuneStageScoreSome(
      { seasonId: "recalRune_season_2", stageId: "level_recalrune_02-01", score: 9 },
      "update",
    );
    expect(p.val[0][0]).toBe(1);
  });
});
});