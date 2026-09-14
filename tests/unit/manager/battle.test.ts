import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  CharacterData,
  ItemType,
  OccPer,
  StageDropType,
} from "@excel/types_excel_gen";
import type {
  PlayerCharacter,
  PlayerHandBookAddon,
  PlayerPushFlags,
} from "@excel/types-playerdata";
import type { BattleData, CommonStartBattleRequest } from "@game/kernel/battle-model";
import type { BattleInfo, BattleRecord } from "@game/kernel/battle-info-store";
import type { EventMap } from "@game/kernel/events";

/** 物品表行窄视图（门面 getItem/itemName 只读 itemType/rarity/name） */
interface MockItemRow {
  itemType: string;
  rarity: number;
  name?: string;
}

/**
 * 掉落明细行窄视图
 *
 * 用例夹具沿用 `@excel/excel#DisplayDetailRewards` 的数值 occPercent/dropType（与 `dropReward`
 * 入参同源），生成类型 `StageData_DisplayDetailRewards` 用的是字符串枚举，故取二者联合。
 */
interface MockDropReward {
  occPercent: OccPer | number;
  type: ItemType | string;
  id: string;
  dropType: StageDropType | number;
}

/** 关卡表行窄视图（用例只写被测分支读到的字段，其余由被测实现的缺省分支承受） */
interface MockStageRow {
  stageId?: string;
  zoneId?: string;
  apCost?: number;
  dangerLevel?: string;
  apFailReturn?: number;
  expGain?: number;
  goldGain?: number;
  stageType?: string;
  practiceTicketCost?: number;
  passFavor?: number;
  completeFavor?: number;
  stageDropInfo?: { displayDetailRewards: MockDropReward[] };
  unlockCondition?: { stageId: string; completeState?: string }[];
}

/** 开局条件窄视图（生产 StageStartCond 声明 requireChars/excludeAssists/isNotPass） */
interface MockStageStartCond {
  requireChars?: { charId: string; evolvePhase?: string }[];
}

/**
 * mock excel 单例在用例中的窄视图
 *
 * 用例只读写 `StageTable.stages` 与 `StageTable.stageStartConds`，且关卡行是夹具窄视图
 * （部分字段 + 数值掉落枚举）——与被测实现读到的键一致，运行期值不变。
 */
interface MockExcelRef {
  StageTable: {
    stages: Record<string, MockStageRow | null>;
    stageStartConds?: Record<string, MockStageStartCond>;
  };
}

/** 招募位夹具窄视图（用例沿用数组下标；生产模型 slots 为字典，运行期读取等价） */
interface MockRecruitView {
  normal: {
    slots: { state: number }[] | Record<string, { state?: number }>;
  };
}

/** pushFlags 夹具窄视图（用例以对象/字符串表示锚点；生产 PlayerPushFlags.status 声明为 number） */
type MockPushFlags = Omit<PlayerPushFlags, "status"> & {
  status: number | string | Record<string, never>;
};

/** 账号战斗信息行窄视图（夹具沿用布尔 isPractice；生产 BattleInfo 声明为 number） */
type MockBattleInfo = Omit<BattleInfo, "isPractice"> & {
  isPractice: number | boolean;
};

/** AccountManager mock 的内存账号配置（只声明用例读写的字段） */
interface MockAccountState {
  configs: Record<
    string,
    {
      battle: {
        infos: Record<string, MockBattleInfo>;
        replays: Record<string, string>;
      };
      battleRecords?: BattleRecord[];
    }
  >;
}

/** 解密 mock 返回值的用例窄视图（生产解密返回完整 BattleData；用例只声明被测分支读到的字段） */
interface MockBattleStatsView {
  enemyList?: Record<string, number[][]>;
  autoReplayCancelled?: boolean | number;
  beginTs?: number;
  endTs?: number;
  checkKilledCnt?: number;
  totalDamage?: number;
}

/** 解密 mock 返回值窄视图（含完整 BattleData 中用例断言到的最小子集） */
interface MockDecryptResult {
  battleId: string;
  battleData: { stats: MockBattleStatsView };
  completeState: number;
  killCnt?: number;
}

/**
 * 用例的 battleStart 载荷窄视图
 *
 * 生产 `CommonStartBattleRequest` 的其余字段由客户端必填，而被测 `start` 只解构
 * `stageId/usePracticeTicket/squad/isReplay/assistFriend`；用例夹具按需传子集，
 * 并沿用布尔 `usePracticeTicket` 与最小助战视图。
 */
interface MockStartArgs {
  stageId: string;
  usePracticeTicket: boolean | number;
  squad: { slots: ({ charInstId: number } | null)[] };
  isReplay?: number;
  assistFriend?: {
    uid: string;
    nickName: string;
    assistChar: { charId: string; level?: number }[];
    assistSlotIndex: number;
  } | null;
}

vi.mock("@excel/excel", () => {
  /** 物品表（带索引签名；门面 getItem/itemName 读 itemType/rarity/name） */
  const itemTable: {
    items: Record<string, MockItemRow>;
    expItems: Record<string, { gainExp: number }>;
  } = {
    items: {
      "mat_001": { itemType: "MATERIAL", rarity: 1 },
    },
    expItems: {},
  };
  /** 干员表（本例为空：门面 charData 恒取不到） */
  const characterTable: Record<string, CharacterData> = {};
  /** 关卡表（夹具窄视图：只写被测分支读到的字段） */
  const stages: Record<string, MockStageRow | null> = {
    "main_01-07": {
      stageId: "main_01-07",
      zoneId: "zone_01",
      apCost: 10,
      dangerLevel: "精英1",
      apFailReturn: 10,
      expGain: 200,
      goldGain: 300,
      stageType: "MAIN",
      stageDropInfo: { displayDetailRewards: [] },
      unlockCondition: [],
    },
  };
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
      HandbookInfoTable: {
        handbookStageData: {
          char_4116_blkkgt: {
            charID: "char_4116_blkkgt",
            stageId: "mem_blkkgt_1",
            levelId: "Obt/Memory/level_memory_blkkgt_1",
            zoneId: "storyMission",
            code: "mem_blkkgt_1",
            name: "路在脚下",
            loadingPicId: "loading_BI",
            description: "",
            unlockParam: [],
            rewardItem: [
              { type: "DIAMOND_SHD", id: "4003", count: 200 },
            ],
            stageGetTime: 0,
          },
        },
      },
      StageTable: {
        stages,
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
      CharacterTable: characterTable,
      ItemTable: itemTable,
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


vi.mock("@utils/crypt", () => ({
  decryptBattleData: vi.fn().mockResolvedValue({
    battleId: "1",
    battleData: {
      stats: { enemyList: {}, autoReplayCancelled: false },
    },
    completeState: 3,
  }),
}));

// 账号战斗信息表提升为 hoisted，便于用例间重置「已结算」标记
// （修复后 battleFinish 幂等：同一 battleId 结算过即拒绝，测试需按用例复位）
const accountState = vi.hoisted((): MockAccountState => ({
  configs: {
    "10000": {
      battle: {
        infos: {
          "1": { stageId: "main_01-07", isPractice: false },
        },
        replays: {
          "main_01-07": "replay_data",
        },
      },
    },
  },
}));

vi.mock("@game/modules/account/account-manager", () => {
  const mockAccountConfigs = accountState.configs;

  return {
    accountManager: {
      configs: mockAccountConfigs,
      saveBattleInfo: vi.fn().mockImplementation(async (uid: string, battleId: string, info: BattleInfo) => {
        if (!mockAccountConfigs[uid]) {
          mockAccountConfigs[uid] = { battle: { infos: {}, replays: {} } };
        }
        mockAccountConfigs[uid].battle.infos[battleId] = info;
      }),
      getBattleInfo: vi.fn().mockImplementation(async (uid: string, battleId: string) => {
        return mockAccountConfigs[uid]?.battle?.infos?.[battleId];
      }),
      getBattleReplay: vi.fn().mockImplementation(async (uid: string, stageId: string) => {
        return mockAccountConfigs[uid]?.battle?.replays?.[stageId] || "";
      }),
      saveBattleReplay: vi.fn().mockImplementation(async (uid: string, stageId: string, replay: string) => {
        if (!mockAccountConfigs[uid]) {
          mockAccountConfigs[uid] = { battle: { infos: {}, replays: {} } };
        }
        mockAccountConfigs[uid].battle.replays[stageId] = replay;
      }),
      // 战斗结束记录留存（battle_records 表）——mock 存内存数组
      saveBattleRecord: vi.fn().mockImplementation(async (record: BattleRecord) => {
        if (!mockAccountConfigs[record.uid]) {
          mockAccountConfigs[record.uid] = { battle: { infos: {}, replays: {} } };
        }
        if (!mockAccountConfigs[record.uid].battleRecords) {
          mockAccountConfigs[record.uid].battleRecords = [];
        }
        mockAccountConfigs[record.uid].battleRecords!.push(record);
      }),
      getBattleRecord: vi.fn().mockImplementation(async (uid: string, battleId: string) => {
        return mockAccountConfigs[uid]?.battleRecords?.find(
          (r) => r.battleId === battleId,
        );
      }),
      listBattleRecords: vi.fn().mockImplementation(async (uid: string) => {
        return mockAccountConfigs[uid]?.battleRecords ?? [];
      }),
    },
  };
});

import {
  asModel,
  asPlayerManager,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";
import { BattleManager } from "@game/modules/battle/battle";
import { decryptBattleData } from "@utils/crypt";

/**
 * 解密 mock 返回值的用例入口
 *
 * 生产 `decryptBattleData` 返回完整 `BattleData`（由真实解密产生），用例只声明被测分支
 * 读到的字段并以布尔 `autoReplayCancelled` 表达；此处单点断言回生产类型，运行期值一字不改。
 * @param result - 用例的解密返回值窄视图
 */
function mockDecrypt(result: MockDecryptResult): void {
  vi.mocked(decryptBattleData).mockResolvedValue(result as BattleData);
}

/**
 * 以用例窄视图调用 `BattleManager.start`
 *
 * 生产 `CommonStartBattleRequest` 的其余字段由客户端必填，被测 `start` 只解构
 * `stageId/usePracticeTicket/squad/isReplay/assistFriend`；用例按需传子集并沿用布尔
 * `usePracticeTicket`。运行期调用与直接 `manager.start(args)` 完全一致。
 * @param manager - 被测管理器
 * @param args - 用例载荷窄视图
 * @returns start 的返回值
 */
function startBattle(manager: BattleManager, args: MockStartArgs) {
  return manager.start(args as CommonStartBattleRequest);
}

describe("BattleManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;
  let mockExcelRef: MockExcelRef;

  beforeEach(async () => {
    vi.restoreAllMocks();
    // 用例隔离：重置账号战斗信息表（含结算幂等标记 settled）与解密 mock 默认实现——
    // 部分用例会把 decryptBattleData 永久改写成 start 生成的 battleId，泄漏到后续用例。
    accountState.configs["10000"].battle.infos = {
      "1": { stageId: "main_01-07", isPractice: false },
    };
    mockDecrypt({
      battleId: "1",
      battleData: { stats: { enemyList: {}, autoReplayCancelled: false } },
      completeState: 3,
    });
    mockTrigger = mockTypedEventEmitter();
    mockExcelRef = vi.mocked((await import("@excel/excel")).default);

    mockPlayer = mockPlayerData({
      dungeon: {
        stages: {
          "main_01-07": {
            stageId: "main_01-07",
            state: 0,
            completeTimes: 0,
            startTimes: 0,
            practiceTimes: 0,
            hasBattleReplay: 0,
            noCostCnt: 0,
          },
        },
      },
      troop: {
        chars: {
          1001: {
            level: 50,
            evolvePhase: 1,
          },
        },
        addon: {},
      },
      dexNav: { enemy: { stage: {} }, character: {} },
      recruit: {},
      status: { 
        mainStageProgress: "",
        uid: "10000",
        gold: 9999,
        ap: 100,
        maxAp: 100,
      },
      pushFlags: {},
      skin: {
        characterSkins: {},
        skinTs: {},
      },
      building: {
        furniture: {},
        solution: { furnitureTs: {} },
      },
      avatar: { avatar_icon: {} },
      nameCardStyle: {
        skin: {
          state: {},
        },
      },
      inventory: {},
      consumable: {},
    });

    // 锚点夹具：用例以对象/字符串表示 pushFlags.status（生产声明 number，运行期沿用夹具值）
    (mockPlayer._playerdata.pushFlags as MockPushFlags).status = {};
    // 招募位夹具：用例沿用数组（生产模型 slots 为字典，运行期读取等价）
    (mockPlayer._playerdata.recruit as MockRecruitView).normal = {
      slots: [{ state: 0 }, { state: 0 }],
    };

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
    it("应该正确初始化 BattleManager 实例", () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
    });

    it("应该注册 battle:start 和 battle:finish 事件监听", () => {
      const onSpy = vi.spyOn(mockTrigger, "on");
      new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      expect(onSpy).toHaveBeenCalledWith(
        "battle:start",
        expect.any(Function)
      );
      expect(onSpy).toHaveBeenCalledWith(
        "battle:finish",
        expect.any(Function)
      );
    });
  });

  describe("start", () => {
    it("应该成功开始战斗并返回正确结构", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const squad = {
        slots: [
          { charInstId: 1001 },
          null,
        ],
      };

      const result = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });

      expect(result).toBeDefined();
      expect(result.battleId).toBeDefined();
      expect(result.result).toBe(0);
      expect(result.apFailReturn).toBeDefined();
    });

    it("开战应预扣理智（修复：原实现只在 finish 扣，可不结算白嫖）", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      mockPlayer._playerdata.status!.ap = 100;
      const squad = { slots: [{ charInstId: 1001 }, null] };
      const result = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });
      expect(result.result).toBe(0);
      // main_01-07 apCost=10
      expect(mockPlayer._playerdata.status!.ap).toBe(90);
    });

    it("理智不足时应拒绝开战且不产生会话/战斗信息", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      mockPlayer._playerdata.status!.ap = 5; // < apCost 10
      const squad = { slots: [{ charInstId: 1001 }, null] };
      const result = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });
      expect(result.result).toBe(1);
      expect(result.battleId).toBe("");
      expect(mockPlayer._playerdata.status!.ap).toBe(5); // 未扣
      const { accountManager } = await import("@game/modules/account/account-manager");
      const before = vi.mocked(accountManager.saveBattleInfo).mock.calls.length;
      // 再试一次：仍拒绝且不新增 saveBattleInfo 调用（不产生战斗信息）
      await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });
      expect(vi.mocked(accountManager.saveBattleInfo).mock.calls.length).toBe(before);
      expect(manager.getActiveBattle()).toBeUndefined();
    });

    it("演习应按 stage.practiceTicketCost 扣券（突袭为 3），不足则拒绝", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      mockExcelRef.StageTable.stages["main_01-07"]!.practiceTicketCost = 3;
      mockPlayer._playerdata.status!.practiceTicket = 5;
      const squad = { slots: [null, null] };
      const ok = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: true,
        squad,
      });
      expect(ok.result).toBe(0);
      expect(mockPlayer._playerdata.status!.practiceTicket).toBe(2); // 5 - 3
      expect(mockPlayer._playerdata.status!.ap).toBe(100); // 演习不扣理智

      mockPlayer._playerdata.status!.practiceTicket = 1; // 不足 3
      const denied = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: true,
        squad,
      });
      expect(denied.result).toBe(1);
      expect(mockPlayer._playerdata.status!.practiceTicket).toBe(1);
    });

    // Round 45（§5.1-8 后半）：0 理智关（practiceTicketCost 为 0/-1）不应扣演习券 ——
    // 官方数据实测：3522 关中 practiceTicketCost ∈ {0,-1} 的 1057 关 apCost 全部为 0，
    // 原实现 Math.max(1, cost) 会白扣 1 张。
    it("演习：practiceTicketCost=0 的关卡不扣券（原实现白扣 1 张）", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      mockExcelRef.StageTable.stages["main_01-07"]!.practiceTicketCost = 0;
      mockPlayer._playerdata.status!.practiceTicket = 5;
      const ok = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: true,
        squad: { slots: [null, null] },
      });
      expect(ok.result).toBe(0);
      expect(mockPlayer._playerdata.status!.practiceTicket).toBe(5); // 不扣
    });

    it("演习：practiceTicketCost=-1（不可演习型 0 理智关）同样不扣券且不因余额为 0 被拒", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      mockExcelRef.StageTable.stages["main_01-07"]!.practiceTicketCost = -1;
      mockPlayer._playerdata.status!.practiceTicket = 0;
      const ok = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: true,
        squad: { slots: [null, null] },
      });
      expect(ok.result).toBe(0);
      expect(mockPlayer._playerdata.status!.practiceTicket).toBe(0);
    });

    it("开局条件（stageStartConds）不满足应拒绝开战", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      mockExcelRef.StageTable.stageStartConds = {
        "main_01-07": {
          requireChars: [{ charId: "char_002_amiya", evolvePhase: "PHASE_2" }],
        },
      };
      const squad = { slots: [{ charInstId: 1001 }, null] }; // 非阿米娅
      const denied = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });
      expect(denied.result).toBe(1);

      // 编入精英 2 的阿米娅后放行
      mockPlayer._playerdata.troop!.chars[2001] = asModel<PlayerCharacter>({
        charId: "char_002_amiya",
        level: 80,
        evolvePhase: 2,
      });
      const allowed = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad: { slots: [{ charInstId: 2001 }, null] },
      });
      expect(allowed.result).toBe(0);
      delete mockExcelRef.StageTable.stageStartConds;
    });

    it("当使用练习券时应该设置 isApProtect 为 0", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const squad = { slots: [null, null] };

      const result = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: true,
        squad,
      });

      expect(result.isApProtect).toBe(0);
    });

    it("当关卡首次进入时应该初始化关卡数据", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockPlayer._playerdata.dungeon!.stages = {
        "main_01-07": {
          stageId: "main_01-07",
          state: 0,
          completeTimes: 0,
          startTimes: 0,
          practiceTimes: 0,
          hasBattleReplay: 0,
          noCostCnt: 0,
        },
      };

      const squad = { slots: [null, null] };

      await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });

      expect(
        mockPlayer._playerdata.dungeon!.stages["main_01-07"]
      ).toBeDefined();
    });

    it("两次 start 应生成不同的 battleId", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const squad = { slots: [null, null] };
      const r1 = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });
      const r2 = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });

      expect(r1.battleId).toBeDefined();
      expect(r1.battleId).not.toBe(r2.battleId);
    });
  });

  describe("finish", () => {
    it("应该完成战斗并触发 items:get 事件", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result).toBeDefined();
      // 物品发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
    });

    it("completeState 为 3 时应该设置 goldScale 和 expScale 为 1.2", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result.goldScale).toBe(1.2);
      expect(result.expScale).toBe(1.2);
    });

    it("应该触发 CompleteStageAnyType 和 CompleteStage 事件", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(emitSpy).toHaveBeenCalledWith(
        "CompleteStageAnyType",
        expect.any(Object)
      );
      expect(emitSpy).toHaveBeenCalledWith(
        "CompleteStage",
        expect.any(Object)
      );
    });

    it("finish 用 battleStart 快照的 loginTime 解密（而非当前 pushFlags.status）", async () => {
      // 模拟：battleStart 时 pushFlags.status=锚点A；随后 syncData 把它推进为锚点B。
      // finish 必须用锚点A（客户端实际加密用值）解密，避免 key 漂移 bad decrypt。
      (mockPlayer._playerdata.pushFlags as MockPushFlags).status = "anchorA";
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const squad = { slots: [{ charInstId: 1001 }, null] };

      const started = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });

      // battleStart 后 syncData 推进锚点
      (mockPlayer._playerdata.pushFlags as MockPushFlags).status = "anchorB";

      mockDecrypt({
        battleId: started.battleId,
        battleData: { stats: { enemyList: {}, autoReplayCancelled: false } },
        completeState: 3,
      });

      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      // 解密必须用 battleStart 快照的锚点A，而非推进后的 anchorB
      expect(decryptBattleData).toHaveBeenCalledWith(
        "encrypted_battle_data",
        "anchorA",
      );
    });
  });

  describe("battleId 随机生成与战斗记录留存", () => {
    it("battleStart 生成随机 battleId（UUID v4），并登记进行中会话", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const r1 = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad: { slots: [] },
      });
      const r2 = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad: { slots: [] },
      });
      // 两次 start 的 battleId 互不相同且为 UUID v4 格式
      expect(r1.battleId).not.toBe(r2.battleId);
      expect(r1.battleId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      // 存在进行中的战斗会话（尚未结算）
      expect(manager.getActiveBattle()).toBeDefined();
    });

    it("finish 结算后把完整战斗记录写入留存库（供未来分析）并结束会话", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const started = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad: { slots: [{ charInstId: 2001 }, null] },
      });

      // 结算接口解密结果回填 start 生成的 battleId（真实客户端如此），否则记录用默认 "1"
      mockDecrypt({
        battleId: started.battleId,
        battleData: {
          stats: {
            enemyList: {},
            autoReplayCancelled: false,
            beginTs: 1700000000,
            endTs: 1700000040,
            checkKilledCnt: 12,
            totalDamage: 12345,
          },
        },
        completeState: 3,
        killCnt: 12,
      });

      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      const { accountManager } = await import("@game/modules/account/account-manager");
      const calls = vi.mocked(accountManager.saveBattleRecord).mock.calls;
      const saved = calls[calls.length - 1][0];
      expect(saved.battleId).toBe(started.battleId);
      expect(saved.stageId).toBe("main_01-07");
      expect(saved.source).toBe("quest");
      expect(saved.completeState).toBe(3);
      expect(saved.killCnt).toBe(12);
      expect(saved.totalDamage).toBe(12345);
      expect(saved.squadInstIds).toEqual([2001]);
      expect(saved.uid).toBe(mockPlayer.uid);
      // 结算后失效进行中会话
      expect(manager.getActiveBattle()).toBeUndefined();
    });
  });

  describe("loadReplay", () => {
    it("应该加载战斗回放数据", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.loadReplay({
        stageId: "main_01-07",
      });

      expect(result).toBe("replay_data");
    });
  });

  describe("saveReplay", () => {
    it("应该保存战斗回放数据", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.saveReplay({
        battleId: "1",
        battleReplay: "new_replay_data",
      });

      expect(result).toBeUndefined();
    });
  });

  describe("dropReward", () => {
    it("应该返回正确结构的奖励数组", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const rewards = [
        {
          occPercent: 0,
          dropType: 0,
          id: "mat_001",
          type: "MATERIAL",
        },
      ];

      const result = await manager.dropReward(
        rewards,
        3,
        "main_01-07"
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(4);
    });

    it("持续零产出时不应无限递归（防栈溢出）", async () => {
      const randomUtils = await import("@utils/random");
      // 所有概率掉落都不命中 → 每轮零产出 → 触发重试路径
      vi.spyOn(randomUtils, "randomChoices").mockReturnValue([0]);
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.dropReward(
        [
          { occPercent: 4, dropType: 2, id: "mat_001", type: "MATERIAL" },
        ],
        3,
        "main_01-07"
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(4);
    });

    it("ALWAYS+NORMAL 必掉材料应产出到 rewards", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.dropReward(
        [
          { occPercent: 0, dropType: 2, id: "mat_001", type: "MATERIAL" },
        ],
        3,
        "main_01-07"
      );

      // result[3] = rewards
      expect(result[3].some((r) => r.id === "mat_001")).toBe(true);
    });
  });

  describe("finishStoryStage", () => {
    it("应该完成关卡并解锁后续关卡", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockExcelRef.StageTable.stages["main_01-08"] = {
        stageId: "main_01-08",
        // 真实数据 unlockCondition[].completeState 为字符串枚举（"PASS"/"COMPLETE"）
        unlockCondition: [{ stageId: "main_01-07", completeState: "COMPLETE" }],
      };

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      const result = await manager.finishStoryStage({
        stageId: "main_01-07",
      });

      expect(result).toBeDefined();
      expect(result.unlockStages).toBeDefined();
      // 物品发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
    });

    it("stages 含 null 伪键时 finishStoryStage / finish 不应 500", async () => {
      // 数据表末尾字段名伪键（值 null）——修复前 unlock 循环遍历到 null →
      // stage.unlockCondition 崩溃（2026-08-14 数据更新后所有生成表均带该伪键）
      mockExcelRef.StageTable.stages["stageType"] = null;
      mockExcelRef.StageTable.stages["unlockCondition"] = null;
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await expect(
        manager.finishStoryStage({ stageId: "main_01-07" }),
      ).resolves.not.toThrow();

      // finish 胜利路径（state=1 触发解锁扫描）
      mockPlayer._playerdata.dungeon!.stages["main_01-07"].state = 1;
      await expect(
        manager.finish({
          data: "encrypted_battle_data",
          battleData: { isCheat: "0", completeTime: 100 },
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("finish 后处理", () => {
    beforeEach(() => {
      // 复位结算幂等标记（同 battleId 在本组用例间复用）
      delete accountState.configs["10000"].battle.infos["1"].settled;
      mockExcelRef.StageTable.stages["main_01-07"]!.stageDropInfo!.displayDetailRewards =
        [];
      delete mockExcelRef.StageTable.stages["main_01-08"];
    });

    it("胜利时应返回真实结算清单并累加 completeTimes", async () => {
      mockExcelRef.StageTable.stages[
        "main_01-07"
      ]!.stageDropInfo!.displayDetailRewards = [
        { occPercent: 0, dropType: 3, id: "mat_001", type: "MATERIAL" },
      ];
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result.rewards).toBeDefined();
      expect(result.unusualRewards).toBeDefined();
      expect(result.additionalRewards).toBeDefined();
      expect(result.furnitureRewards).toBeDefined();
      expect(result.firstRewards).toBeDefined();
      expect(result.unlockStages).toBeDefined();
      expect(
        mockPlayer._playerdata.dungeon!.stages["main_01-07"].completeTimes
      ).toBe(1);
    });

    it("同一 battleId 重复结算应被拒绝（幂等，修复前可重放刷奖励）", async () => {
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const first = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });
      expect(first.result).toBe(0);
      expect(
        mockPlayer._playerdata.dungeon!.stages["main_01-07"].completeTimes
      ).toBe(1);

      const second = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });
      expect(second.result).toBe(1);
      expect(second.rewards).toEqual([]);
      // 通关次数不再累加（原实现可无限重复结算）
      expect(
        mockPlayer._playerdata.dungeon!.stages["main_01-07"].completeTimes
      ).toBe(1);
    });

    it("首次通关（state=0 → completeState=3）应返回 firstRewards", async () => {
      mockExcelRef.StageTable.stages[
        "main_01-07"
      ]!.stageDropInfo!.displayDetailRewards = [
        { occPercent: 0, dropType: 1, id: "mat_001", type: "MATERIAL" },
      ];
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result.firstRewards!.length).toBeGreaterThan(0);
    });

    it("胜利时应返回解锁关卡列表", async () => {
      mockPlayer._playerdata.dungeon!.stages["main_01-07"].state = 1;
      mockExcelRef.StageTable.stages["main_01-08"] = {
        stageId: "main_01-08",
        stageType: "MAIN",
        // 真实数据 unlockCondition[].completeState 为字符串枚举（"PASS"/"COMPLETE"）
        unlockCondition: [{ stageId: "main_01-07", completeState: "COMPLETE" }],
      };
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result.unlockStages).toContain("main_01-08");
    });

    it("首通（state=0 → completeState=3）胜利也应解锁后续关卡（原 state==1 前置断裂修复）", async () => {
      // 修复：原 `playerStage.state == 1` 前置——state=1 仅在失败后置位，首通跳过
      // 解锁链 → 活动关卡链断裂（如 act53side_01 首通后 tr01 不解锁）
      mockPlayer._playerdata.dungeon!.stages["main_01-07"].state = 0;
      mockExcelRef.StageTable.stages["main_01-08"] = {
        stageId: "main_01-08",
        stageType: "MAIN",
        unlockCondition: [{ stageId: "main_01-07", completeState: "COMPLETE" }],
      };
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result.unlockStages).toContain("main_01-08");
      // 响应含 result 字段（官服形状；修复前 undefined）
      expect(result.result).toBe(0);
    });

    it("胜利时不应覆盖已解锁/已通关的后续关卡（in Object.keys 数组 bug 修复）", async () => {
      // 场景：main_01-08 已解锁且已通关（state=3, completeTimes=5），再通关
      // main_01-07（state=1）触发全表解锁扫描——修复前
      // `item in Object.keys(draft.dungeon.stages)` 对数组用 in 恒 false →
      // main_01-08 被整体覆盖为 state:0/completeTimes:0（重新变锁定、通关次数清零）
      mockPlayer._playerdata.dungeon!.stages["main_01-07"].state = 1;
      mockPlayer._playerdata.dungeon!.stages["main_01-08"] = {
        stageId: "main_01-08",
        state: 3,
        completeTimes: 5,
        startTimes: 2,
        practiceTimes: 0,
        hasBattleReplay: 0,
        noCostCnt: 0,
      };
      mockExcelRef.StageTable.stages["main_01-08"] = {
        stageId: "main_01-08",
        stageType: "MAIN",
        unlockCondition: [{ stageId: "main_01-07", completeState: "COMPLETE" }],
      };
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      const kept = mockPlayer._playerdata.dungeon!.stages["main_01-08"];
      expect(kept.state).toBe(3);
      expect(kept.completeTimes).toBe(5);
      expect(kept.startTimes).toBe(2);
    });

    it("胜利时应给出战干员增加信赖", async () => {
      mockPlayer._playerdata.troop!.chars["1001"].favorPoint = 0;
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const squad = { slots: [{ charInstId: 1001 }, null] };

      const started = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });
      // 让 finish 使用 start 生成的 battleId 查找 battleInfo（含 squad）
      mockDecrypt({
        battleId: started.battleId,
        battleData: {
          stats: { enemyList: {}, autoReplayCancelled: false },
        },
        completeState: 3,
      });
      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      // 修复（2026-09-09）：信赖按关卡数据发放（completeFavor=apCost=10），不再恒 +1
      expect(
        mockPlayer._playerdata.troop!.chars["1001"].favorPoint
      ).toBe(10);
    });

    it("信赖应按 passFavor/completeFavor 发放（2 星用 passFavor）", async () => {
      mockPlayer._playerdata.troop!.chars["1001"].favorPoint = 0;
      mockExcelRef.StageTable.stages["main_01-07"]!.passFavor = 9;
      mockExcelRef.StageTable.stages["main_01-07"]!.completeFavor = 10;
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const squad = { slots: [{ charInstId: 1001 }, null] };
      const started = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });
      mockDecrypt({
        battleId: started.battleId,
        battleData: { stats: { enemyList: {}, autoReplayCancelled: false } },
        completeState: 2, // 二星 → passFavor
      });
      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });
      expect(
        mockPlayer._playerdata.troop!.chars["1001"].favorPoint
      ).toBe(9);
    });

    it("0 理智关卡不应发放信赖（passFavor=0）", async () => {
      mockPlayer._playerdata.troop!.chars["1001"].favorPoint = 0;
      mockExcelRef.StageTable.stages["main_01-07"]!.passFavor = 0;
      mockExcelRef.StageTable.stages["main_01-07"]!.completeFavor = 0;
      mockExcelRef.StageTable.stages["main_01-07"]!.apCost = 0;
      const manager = new BattleManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const squad = { slots: [{ charInstId: 1001 }, null] };
      const started = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
      });
      mockDecrypt({
        battleId: started.battleId,
        battleData: { stats: { enemyList: {}, autoReplayCancelled: false } },
        completeState: 3,
      });
      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });
      expect(
        mockPlayer._playerdata.troop!.chars["1001"].favorPoint
      ).toBe(0);
    });
  });

  describe("代理指挥任务事件（StageWithReplay / TakeOverReplay）", () => {
    async function finishWithReplay(opts: {
      isReplay?: number;
      autoReplayCancelled?: boolean;
    }) {
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      const squad = { slots: [{ charInstId: 1001 }, null] };
      const started = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
        isReplay: opts.isReplay ?? 0,
      });
      mockDecrypt({
        battleId: started.battleId,
        battleData: {
          stats: {
            enemyList: {},
            autoReplayCancelled: !!opts.autoReplayCancelled,
          },
        },
        completeState: 3,
      });
      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });
      return manager;
    }

    it("代理开局通关应 emit StageWithReplay", async () => {
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await finishWithReplay({ isReplay: 1 });
      expect(emitSpy).toHaveBeenCalledWith("StageWithReplay", [{ isReplay: 1 }]);
    });

    it("非代理开局不应 emit StageWithReplay", async () => {
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await finishWithReplay({ isReplay: 0 });
      expect(emitSpy).not.toHaveBeenCalledWith("StageWithReplay", expect.anything());
    });

    it("战斗内接管代理应 emit TakeOverReplay", async () => {
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await finishWithReplay({ isReplay: 1, autoReplayCancelled: true });
      const call = emitSpy.mock.calls.find((c) => c[0] === "TakeOverReplay");
      expect(call).toBeTruthy();
      // spy 的调用记录在 Parameters 下收敛为全部事件的联合，按事件名窄化到载荷契约（EventMap）
      const payload = call?.[1] as EventMap["TakeOverReplay"] | undefined;
      expect(payload![0].battleData.stats.autoReplayCancelled).toBe(true);
    });
  });

  describe("助战信用（每日结算，次日信用交易所领取）", () => {
    /** 与既有 harness 同款：start（带助战）→ finish 完整结算 */
    async function finishWithAssist() {
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      const squad = { slots: [{ charInstId: 1001 }, null] };
      const started = await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad,
        assistFriend: {
          uid: "2",
          nickName: "好友",
          assistChar: [{ charId: "char_002", level: 50 }],
          assistSlotIndex: 0,
        },
      });
      mockDecrypt({
        battleId: started.battleId,
        battleData: { stats: { enemyList: {}, autoReplayCancelled: false } },
        completeState: 3,
      });
      await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });
      return manager;
    }

    it("使用助战通关应累积 30 信用到昨日奖励（不再立即入账 socialPoint）", async () => {
      const before = mockPlayer._playerdata.status?.socialPoint ?? 0;
      await finishWithAssist();
      // 修复（2026-09-09，审计 §5.4-12）：PRTS「每日结算的信用」——使用支援单位 +30，
      // 次日于信用交易所手动领取；原实现直接 status.socialPoint += 30（与官方口径不符）
      expect(
        mockPlayer._playerdata.social.yesterdayReward.assistAmount,
      ).toBe(30);
      // 未立即入账
      expect(mockPlayer._playerdata.status.socialPoint ?? 0).toBe(before);
      // 当日重复通关不再重复累积
      await finishWithAssist();
      expect(
        mockPlayer._playerdata.social.yesterdayReward.assistAmount,
      ).toBe(30);
    });
  });

  describe("start 保存助战好友信息", () => {
    async function lastSavedBattleInfo() {
      const { accountManager } = await import("@game/modules/account/account-manager");
      const calls = vi.mocked(accountManager.saveBattleInfo).mock.calls;
      return calls[calls.length - 1][2];
    }

    it("应保存 assistFriend 到 battleInfo", async () => {
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      const assistFriend = {
        uid: "2",
        nickName: "好友",
        assistChar: [{ charId: "char_002", level: 50 }],
        assistSlotIndex: 1,
      };
      await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad: { slots: [] },
        assistFriend,
      });
      expect((await lastSavedBattleInfo()).assistFriend).toEqual(assistFriend);
    });

    it("无助战时不保存 assistFriend", async () => {
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      await startBattle(manager, {
        stageId: "main_01-07",
        usePracticeTicket: false,
        squad: { slots: [] },
        assistFriend: null,
      });
      expect((await lastSavedBattleInfo()).assistFriend).toBeUndefined();
    });
  });

  describe("未知关卡守卫（2026-08-09 修复）", () => {
    it("battleStart 未知关卡应返回最小 battleId 而非 500", async () => {
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      const result = await startBattle(manager, {
        stageId: "act1arkhub_01",
        usePracticeTicket: false,
        squad: { slots: [] },
      });
      expect(result).toBeDefined();
      expect(result.result).toBe(0);
      expect(result.battleId).toBeDefined();
      expect(result.apFailReturn).toBe(0);
    });
  });

  describe("悖论模拟关卡解析（2026-08-22 修复）", () => {
    it("battleStart 应识别悖论模拟关卡（mem_ 前缀，handbookStageData 收录）", async () => {
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      const result = await startBattle(manager, {
        stageId: "mem_blkkgt_1",
        usePracticeTicket: false,
        squad: { slots: [] },
      });
      // 不再走「未知关卡」兜底：应正常计入 stage 进度（startTimes+1）与 battleId
      expect(result).toBeDefined();
      expect(result.result).toBe(0);
      expect(result.battleId).toBeDefined();
      // 悖论模拟零体力：无体力保护返还，且不被视为 noCostCnt（apCost=0 不触发）
      expect(result.apFailReturn).toBe(0);
      expect(result.isApProtect).toBe(0);
      // start 已播种该关卡到存档（此前走「未知关卡」兜底不播种）
      expect(mockPlayer._playerdata.dungeon.stages["mem_blkkgt_1"]).toBeDefined();
    });

    it("胜利结算应发放 handbook rewardItem 并写入 addon.stage 密录进度", async () => {
      // 播种悖论模拟关卡（首通：state=0）
      mockPlayer._playerdata.dungeon!.stages["mem_blkkgt_1"] = {
        stageId: "mem_blkkgt_1",
        state: 0,
        completeTimes: 0,
        startTimes: 1,
        practiceTimes: 0,
        hasBattleReplay: 0,
        noCostCnt: 0,
      };
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      // start 生成随机 battleId 并登记会话/落 battleInfo（悖论模拟真实战斗，非演习）
      const started = await startBattle(manager, {
        stageId: "mem_blkkgt_1",
        usePracticeTicket: false,
        squad: { slots: [{ charInstId: 1001 }] },
      });
      // 结算接口解密回填 start 生成的 battleId + 完成状态 3
      mockDecrypt({
        battleId: started.battleId,
        battleData: { stats: {} },
        completeState: 3,
      });

      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      // 首通奖励：handbook rewardItem（DIAMOND_SHD 4003）落入 firstRewards
      expect(result.result).toBe(0);
      expect(result.firstRewards).toEqual([
        { type: "DIAMOND_SHD", id: "4003", count: 200 },
      ]);
      // 密录进度已写入 troop.addon.<charID>.stage.<stageId>
      const stage = mockPlayer._playerdata.troop!.addon!["char_4116_blkkgt"]!.stage[
        "mem_blkkgt_1"
      ];
      expect(stage).toBeDefined();
      expect(stage.completeTimes).toBe(1);
      expect(stage.state).toBe(3);
      expect(stage.startTimes).toBe(1);
      expect(stage.fts).toBeDefined();
      // 通关次数累计（not 练习，startTimes 已 +1）
      expect(mockPlayer._playerdata.dungeon!.stages["mem_blkkgt_1"].state).toBe(3);
    });

    it("重复挑战（已通关）不再重复发放 rewardItem，仅累计完成次数", async () => {
      // 已通关：state=3 + 既有 addon.stage 记录
      mockPlayer._playerdata.dungeon!.stages["mem_blkkgt_1"] = {
        stageId: "mem_blkkgt_1",
        state: 3,
        completeTimes: 1,
        startTimes: 2,
        practiceTimes: 0,
        hasBattleReplay: 0,
        noCostCnt: 0,
      };
      mockPlayer._playerdata.troop!.addon!["char_4116_blkkgt"] = asModel<PlayerHandBookAddon>({
        stage: {
          "mem_blkkgt_1": {
            fts: 1624284657,
            rts: 1624284657,
            startTimes: 2,
            completeTimes: 1,
            state: 3,
            startTime: 2,
          },
        },
      });
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      const started = await startBattle(manager, {
        stageId: "mem_blkkgt_1",
        usePracticeTicket: false,
        squad: { slots: [] },
      });
      mockDecrypt({
        battleId: started.battleId,
        battleData: { stats: {} },
        completeState: 3,
      });

      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      // 非首通：firstRewards 为空，不重复发合成玉
      expect(result.firstRewards!.length).toBe(0);
      // addon 密录完成次数累计 +1，fts 沿用既有
      const stage = mockPlayer._playerdata.troop!.addon!["char_4116_blkkgt"]!.stage[
        "mem_blkkgt_1"
      ];
      expect(stage.completeTimes).toBe(2);
      expect(stage.fts).toBe(1624284657);
      expect(mockPlayer._playerdata.dungeon!.stages["mem_blkkgt_1"].completeTimes).toBe(2);
    });

    it("悖论模拟同步结算不触碰标准关卡解锁链（mem_ 不在 StageTable 不崩溃）", async () => {
      // 预置一个无前置条件关卡（解锁链会遍历，但 mem_ 结算不推进 mainStageProgress）
      mockExcelRef.StageTable.stages["tr_01"] = {
        stageId: "tr_01",
        stageType: "MAIN",
        unlockCondition: [],
      };
      mockPlayer._playerdata.dungeon!.stages["mem_blkkgt_1"] = {
        stageId: "mem_blkkgt_1",
        state: 0,
        completeTimes: 0,
        startTimes: 1,
        practiceTimes: 0,
        hasBattleReplay: 0,
        noCostCnt: 0,
      };
      const manager = new BattleManager(asPlayerManager(mockPlayer), mockTrigger);
      const started = await startBattle(manager, {
        stageId: "mem_blkkgt_1",
        usePracticeTicket: false,
        squad: { slots: [] },
      });
      mockDecrypt({
        battleId: started.battleId,
        battleData: { stats: {} },
        completeState: 3,
      });

      const result = await manager.finish({
        data: "encrypted_battle_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      // 不崩溃、正常返回 result:0
      expect(result.result).toBe(0);
      expect(mockPlayer._playerdata.status?.mainStageProgress).toBe("");
    });
  });
});
