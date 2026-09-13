import { describe, it, expect, vi, beforeEach } from "vitest";

const timeMock = vi.hoisted(() => ({ now: 1700000000 }));
vi.mock("@utils/time", () => ({ now: () => timeMock.now }));

vi.mock("@excel/excel", () => ({
  default: {
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

    GachaTable: {
      gachaPoolClient: [
        { gachaPoolId: "p_normal_1", gachaRuleType: "NORMAL" },
        { gachaPoolId: "p_limited_1", gachaRuleType: "LIMITED", lMTGSID: "LMTGS_COIN_TEST" },
        { gachaPoolId: "p_limited_2", gachaRuleType: "LIMITED" },
        { gachaPoolId: "p_single_1", gachaRuleType: "SINGLE" },
      ],
      // 限定池每日免费寻访（freeCount = 1/日，活动期内有效）
      freeGacha: [
        { poolId: "p_limited_1", openTime: 1699000000, endTime: 1710000000, freeCount: 1 },
      ],
    },
    GachaDetailTable: {
      details: {
        p_normal_1: {
          upCharInfo: { perCharList: [] },
          availCharInfo: {
            perAvailList: [
              { rarityRank: 5, totalPercent: 2, charIdList: ["char_n5"] },
              { rarityRank: 3, totalPercent: 98, charIdList: ["char_n3"] },
            ],
          },
        },
        p_limited_1: {
          upCharInfo: {
            perCharList: [
              { rarityRank: 5, charIdList: ["char_lim6a", "char_lim6b"], percent: 0.35, count: 2 },
            ],
          },
          availCharInfo: {
            perAvailList: [
              { rarityRank: 5, totalPercent: 2, charIdList: ["char_l5"] },
              { rarityRank: 3, totalPercent: 98, charIdList: ["char_l3"] },
            ],
          },
        },
        p_limited_2: {
          upCharInfo: { perCharList: [] },
          availCharInfo: {
            perAvailList: [{ rarityRank: 3, totalPercent: 100, charIdList: ["char_x3"] }],
          },
        },
        p_single_1: {
          upCharInfo: {
            perCharList: [{ rarityRank: 5, charIdList: ["char_up1", "char_up2"], percent: 0.35, count: 2 }],
          },
          availCharInfo: {
            perAvailList: [
              { rarityRank: 5, totalPercent: 2, charIdList: ["char_s5"] },
              { rarityRank: 3, totalPercent: 98, charIdList: ["char_s3"] },
            ],
          },
        },
      },
    },
    ItemTable: { items: {} as Record<string, { itemType?: string; name?: string }> },
    // 本文件未提供的表显式占位（缺键会让门面方法的 `this.XxxTable` 报 TS2339）
    CharacterTable: undefined as Record<string, { name?: string }> | undefined,
    StageTable: undefined as { stages: Record<string, { stageType?: string }> } | undefined,
  },
}));

vi.mock("@game/modules/account/AccountManager", () => ({
  accountManager: {
    getBeforeNonHitCnt: vi.fn().mockResolvedValue(0),
    saveBeforeNonHitCnt: vi.fn().mockResolvedValue(undefined),
  },
}));

import { asModel, asPlayerManager, mockPlayerData, mockTypedEventEmitter } from "../../../helpers";
import type { Draft } from "mutative";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import { GainItemPipeline } from "@game/kernel/inventory-pipeline";
import { GachaManager } from "@game/modules/gacha/logic";
import { setRandSource, resetRandSource } from "@utils/random";
import { GachaType } from "@game/modules/gacha/gacha";
import { accountManager } from "@game/modules/account/AccountManager";
import { freeCountFor, refreshLimitFree } from "@game/modules/gacha/limit-gacha";

/**
 * 限定池账本视图
 *
 * `freeDay` 是服务端扩展的日序字段（生成类型 PlayerGacha_PlayerFreeLimitGacha 未声明，
 * 见 limit-gacha.ts 的 LimitGachaView）——此处就地声明，其余字段仍受真实模型约束。
 */
type LimitRecordView = PlayerDataModel["gacha"]["limit"][string] & { freeDay?: number };

const saveSpy = vi.mocked(accountManager.saveBeforeNonHitCnt);

describe("限定寻访：免费次数 / 300 抽赠送 / 保底按池隔离", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    saveSpy.mockClear();
    timeMock.now = 1700000000; // p_limited_1 免费窗口内
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      gacha: { normal: {}, single: {}, limit: {} },
      status: { diamondShard: 100000 },
    });
    mockPlayer._trigger = mockTrigger;
    // 覆写为真实物品管道实例：免费寻访等经 items:use 事件（替身面不发射事件）；
    // helpers 的 gainItem 写入面接受真实 GainItemPipeline（读侧仍是 Mock 面）。
    mockPlayer.gainItem = new GainItemPipeline(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  /** 构造 GachaManager（mock 玩家） */
  function makeManager() {
    return new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
  }

  it("freeCountFor：窗口内取 freeCount，窗口外为 0", () => {
    expect(freeCountFor("p_limited_1", 1700000000)).toBe(1);
    expect(freeCountFor("p_limited_1", 1600000000)).toBe(0);
    expect(freeCountFor("p_normal_1", 1700000000)).toBe(0);
  });

  it("refreshLimitFree：按日重置 leastFree（同一天不重复重置）", () => {
    const draft = asModel<Draft<PlayerDataModel>>({ gacha: { limit: {} } });
    refreshLimitFree(draft, "p_limited_1", 1700000000);
    expect(draft.gacha.limit.p_limited_1.leastFree).toBe(1);
    // 当日已抽完 → 同一天不再补
    draft.gacha.limit.p_limited_1.leastFree = 0;
    refreshLimitFree(draft, "p_limited_1", 1700000100);
    expect(draft.gacha.limit.p_limited_1.leastFree).toBe(0);
    // 次日后恢复
    refreshLimitFree(draft, "p_limited_1", 1700000000 + 86400);
    expect(draft.gacha.limit.p_limited_1.leastFree).toBe(1);
  });

  it("免费抽：leastFree 为 0 时拒绝（修复前恒放行 → 无限免费抽）", async () => {
    const mgr = makeManager();
    mockPlayer._playerdata.gacha.limit.p_limited_1 = asModel<LimitRecordView>({
      leastFree: 0, poolCnt: 0, recruitedFreeChar: false, freeDay: Math.floor(1700000000 / 86400),
    });
    await expect(
      mgr.advancedGacha({ poolId: "p_limited_1", useTkt: GachaType.LimitSingle, itemId: null }),
    ).rejects.toThrow(/资源不足/);
  });

  it("免费抽：有次数时放行并扣减 leastFree，同时累计 poolCnt", async () => {
    setRandSource(() => 0.99); // 恒定非六星分支
    try {
      const mgr = makeManager();
      await mgr.advancedGacha({ poolId: "p_limited_1", useTkt: GachaType.LimitSingle, itemId: null });
      const rec = mockPlayer._playerdata.gacha.limit.p_limited_1;
      expect(rec.leastFree).toBe(0);
      expect(rec.poolCnt).toBe(1);
    } finally {
      resetRandSource();
    }
  });

  it("getFreeChar：未满 300 抽拒绝；满 300 抽发放当期首个 UP 六星且只发一次", async () => {
    const mgr = makeManager();
    mockPlayer._playerdata.gacha.limit.p_limited_1 = {
      leastFree: 0, poolCnt: 299, recruitedFreeChar: false,
    };
    expect(await mgr.claimLimitFreeChar({ poolId: "p_limited_1" })).toBeNull();
    mockPlayer._playerdata.gacha.limit.p_limited_1.poolCnt = 300;
    const first = await mgr.claimLimitFreeChar({ poolId: "p_limited_1" });
    expect(first).not.toBeNull();
    expect(mockPlayer._playerdata.gacha.limit.p_limited_1.recruitedFreeChar).toBe(true);
    // 已领取 → 再领为 null
    expect(await mgr.claimLimitFreeChar({ poolId: "p_limited_1" })).toBeNull();
  });

  it("getFreeChar：非限定池拒绝", async () => {
    const mgr = makeManager();
    expect(await mgr.claimLimitFreeChar({ poolId: "p_normal_1" })).toBeNull();
  });

  it("保底计数按池隔离：LIMITED 用 poolId，NORMAL 用规则类型", async () => {
    setRandSource(() => 0.99);
    try {
      const mgr = makeManager();
      await mgr.doAdvancedGacha({ poolId: "p_limited_1", useTkt: 0, itemId: null });
      await mgr.doAdvancedGacha({ poolId: "p_normal_1", useTkt: 0, itemId: null });
      const keys = saveSpy.mock.calls.map((c) => c[1]);
      expect(keys).toContain("p_limited_1");
      expect(keys).toContain("NORMAL");
      expect(keys).not.toContain("LIMITED");
    } finally {
      resetRandSource();
    }
  });

  it("定选（SINGLE）：第 150 抽强塞首个 UP 且六星保底计数清零", async () => {
    setRandSource(() => 0.99); // 摇出非六星
    try {
      const mgr = makeManager();
      mockPlayer._playerdata.gacha.single.p_single_1 = {
        singleEnsureCnt: 149, singleEnsureUse: false, singleEnsureChar: "char_up1",
      };
      const out = await mgr.doAdvancedGacha({ poolId: "p_single_1", useTkt: 0, itemId: null });
      // ensure 命中 → rank 视为 5，保底计数清零
      expect(out.logInfo.beforeNonHitCnt).toBe(0);
      expect(mockPlayer._playerdata.gacha.single.p_single_1.singleEnsureCnt).toBe(0);
    } finally {
      resetRandSource();
    }
  });
});
