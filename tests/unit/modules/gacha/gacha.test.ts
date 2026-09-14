import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@excel/excel", () => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

    GachaTable: {
      gachaPoolClient: [
        { gachaPoolId: "p_normal_1", gachaRuleType: "NORMAL" },
        { gachaPoolId: "p_double_1", gachaRuleType: "DOUBLE" },
        { gachaPoolId: "p_limited_1", gachaRuleType: "LIMITED", lMTGSID: "LMTGS_COIN_TEST" },
        // 无 lMTGSID 的限定池 → 凭证回退 "LMTGS_COIN"
        { gachaPoolId: "p_limited_2", gachaRuleType: "LIMITED" },
        // 中坚甄选自选池
        { gachaPoolId: "p_classic_1", gachaRuleType: "CLASSIC" },
        { gachaPoolId: "p_fesclassic_1", gachaRuleType: "FESCLASSIC" },
      ],
      // 新手池（新人特惠寻访）：gachaTimes = 21 次上限（官服数据实测
      // data/excel/gacha_table.json → newbeeGachaPoolClient[].gachaTimes）
      newbeeGachaPoolClient: [
        {
          gachaPoolId: "BOOT_0_1_1",
          gachaIndex: 0,
          gachaPoolName:
            "全部寻访必定获得至少1名5★以上干员和至少1名6★干员！",
          gachaPoolDetail: "",
          gachaPrice: 380,
          gachaTimes: 21,
          gachaOffset: "0.35",
        },
      ],
    },
    GachaDetailTable: {
      details: {
        p_normal_1: {
          upCharInfo: { perCharList: [] },
          availCharInfo: {
            perAvailList: [
              { rarityRank: 5, totalPercent: 2, charIdList: ["char_001"] },
              { rarityRank: 4, totalPercent: 50, charIdList: ["char_002"] },
              { rarityRank: 3, totalPercent: 48, charIdList: ["char_003"] },
            ],
          },
        },
        BOOT_0_1_1: {
          upCharInfo: { perCharList: [] },
          availCharInfo: {
            perAvailList: [
              { rarityRank: 5, totalPercent: 2, charIdList: ["char_b6"] },
              { rarityRank: 4, totalPercent: 8, charIdList: ["char_b5"] },
              { rarityRank: 3, totalPercent: 90, charIdList: ["char_b3"] },
            ],
          },
        },
        p_classic_1: {
          upCharInfo: {
            perCharList: [
              { rarityRank: 5, charIdList: ["char_upA"], percent: 0.25, count: 2 },
              { rarityRank: 4, charIdList: ["char_upB"], percent: 0.1667, count: 3 },
            ],
          },
          availCharInfo: {
            perAvailList: [
              { rarityRank: 5, totalPercent: 2, charIdList: ["char_c5a", "char_c5b", "char_c5c"] },
              { rarityRank: 4, totalPercent: 8, charIdList: ["char_c4a", "char_c4b", "char_c4c"] },
              { rarityRank: 3, totalPercent: 90, charIdList: ["char_c3a"] },
            ],
          },
        },
        // FESCLASSIC 池无静态 UP：自选取该池 UP 时按 35% 默认档
        p_fesclassic_1: {
          upCharInfo: { perCharList: [] },
          availCharInfo: {
            perAvailList: [
              { rarityRank: 5, totalPercent: 2, charIdList: ["char_f5a", "char_f5b"] },
            ],
          },
        },
      },
    },
    // 抽卡 UseItem/CombineTenTicket 消耗走 ItemTable 解析类型（余额校验依赖）
    ItemTable: {
      items: {
        "4005": { itemType: "LGG_SHD" },
      } as Record<string, { itemType: string; name?: string }>,
    },
    // 本文件未提供的表显式占位（缺键会让门面方法的 `this.XxxTable` 报 TS2339）
    CharacterTable: undefined as Record<string, { name?: string }> | undefined,
    StageTable: undefined as { stages: Record<string, { stageType?: string }> } | undefined,
  },
}));

vi.mock("@game/modules/account/account-manager", () => ({
  accountManager: {
    getBeforeNonHitCnt: vi.fn().mockResolvedValue(0),
    saveBeforeNonHitCnt: vi.fn().mockResolvedValue(undefined),
  },
}));

import { asPlayerManager, mockPlayerData, mockTypedEventEmitter, asModel, type MockSeed } from "../../../helpers";
import type { PlayerGacha } from "@game/kernel/playerdata";
import { GainItemPipeline } from "@game/kernel/inventory-pipeline";
import { GachaManager } from "@game/modules/gacha/logic";
import { setRandSource, resetRandSource } from "@utils/random";
import { GachaType } from "@game/modules/gacha/gacha";
import { accountManager } from "@game/modules/account/account-manager";
import excelData from "@excel/excel";

/**
 * 玩家 gacha 存档视图
 *
 * `GACHA_RULE_TYPE.CLASSIC` 指向子结构 `classic`（中坚甄选自选 UP 落盘处），
 * 而生成类型 `PlayerGacha` 未声明该键（服务端自建子结构）——此处就地声明，
 * 其余键仍受真实模型约束。
 */
type PlayerGachaView = PlayerGacha & {
  classic?: Record<string, { upChar: Record<string, string[]> }>;
};

/** 写入夹具用 gacha 子树（深可选视图；字段名与类型仍受真实模型约束） */
function gachaSeed(seed: MockSeed<PlayerGachaView>): PlayerGacha {
  return asModel<PlayerGachaView>(seed);
}

/** accountManager 模块 mock 的 saveBeforeNonHitCnt（vi.fn()，调用历史跨测试保留需手动 clear） */
const saveSpy = vi.mocked(accountManager.saveBeforeNonHitCnt);

describe("GachaManager 抽卡扣费 costs 构造", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    saveSpy.mockClear();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      gacha: {
        normal: {},
        single: {},
        newbee: undefined,
      },
      // 新手池（BOOT）单抽 380 合成玉 —— 次数门槛用例需余额充足
      status: { diamondShard: 100000, androidDiamond: 0 },
    });
    mockPlayer._trigger = mockTrigger;
    // 统一物品管道（建议 4）：扣费走管道 use()，与 items:use 直发等价。
    // 覆写为真实管道实例：抽卡扣费/发放经 items:use / items:get 事件（替身面不发射事件）；
    // helpers 的 gainItem 写入面接受真实 GainItemPipeline（读侧仍是 Mock 面，供调用记录断言）。
    mockPlayer.gainItem = new GainItemPipeline(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  it("Diamond 单抽应只扣 600 合成玉（id=4003 带 type，且无 fallthrough）", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    // 阻断后续抽卡流程，只验证 costs 构造
    vi.spyOn(controller, "doAdvancedGacha").mockResolvedValue({
      charInstId: 1,
      charId: "char_001",
      isNew: 0,
      itemGet: [],
      logInfo: { beforeNonHitCnt: 0 },
    });
    await controller.advancedGacha({ poolId: "p_normal_1", useTkt: GachaType.Diamond, itemId: "" });
    expect(emitSpy).toHaveBeenCalledWith("items:use", [
      [{ id: "4003", type: "DIAMOND_SHD", count: 600 }],
    ]);
  });

  it("SingleTicket 单抽应只扣 1 张寻访凭证（无 fallthrough）", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    vi.spyOn(controller, "doAdvancedGacha").mockResolvedValue({
      charInstId: 1,
      charId: "char_001",
      isNew: 0,
      itemGet: [],
      logInfo: { beforeNonHitCnt: 0 },
    });
    await controller.advancedGacha({ poolId: "p_normal_1", useTkt: GachaType.SingleTicket, itemId: "" });
    expect(emitSpy).toHaveBeenCalledWith("items:use", [
      [{ id: "TKT_GACHA", type: "TKT_GACHA", count: 1 }],
    ]);
  });

  it("UseItem 单抽应扣客户端指定物品", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    vi.spyOn(controller, "doAdvancedGacha").mockResolvedValue({
      charInstId: 1,
      charId: "char_001",
      isNew: 0,
      itemGet: [],
      logInfo: { beforeNonHitCnt: 0 },
    });
    await controller.advancedGacha({ poolId: "p_normal_1", useTkt: GachaType.UseItem, itemId: "4005" });
    expect(emitSpy).toHaveBeenCalledWith("items:use", [[{ id: "4005", count: 1 }]]);
  });

  it("合成玉（DIAMOND_SHD）单抽余额按 diamondShard 校验，不误用源石 androidDiamond", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    vi.spyOn(controller, "doAdvancedGacha").mockResolvedValue({
      charInstId: 1,
      charId: "char_001",
      isNew: 0,
      itemGet: [],
      logInfo: { beforeNonHitCnt: 0 },
    });
    const st = mockPlayer._playerdata.status;
    // 合成玉充足（1000 ≥ 600）、源石为 0 —— 修复前按 androidDiamond 判档会误拒
    st.diamondShard = 1000;
    st.androidDiamond = 0;
    await expect(
      controller.advancedGacha({ poolId: "p_normal_1", useTkt: GachaType.Diamond, itemId: "" }),
    ).resolves.toBeDefined();

    // 反例：合成玉不足（0）、源石充足（9999）—— 必须拒绝（合成玉消费≠源石）
    st.diamondShard = 0;
    st.androidDiamond = 9999;
    await expect(
      controller.advancedGacha({ poolId: "p_normal_1", useTkt: GachaType.Diamond, itemId: "" }),
    ).rejects.toThrow("资源不足");
  });

  it("BOOT 池 Diamond 单抽应扣 380 合成玉", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    vi.spyOn(controller, "doAdvancedGacha").mockResolvedValue({
      charInstId: 1,
      charId: "char_001",
      isNew: 0,
      itemGet: [],
      logInfo: { beforeNonHitCnt: 0 },
    });
    await controller.advancedGacha({ poolId: "BOOT_1", useTkt: GachaType.Diamond, itemId: "" });
    expect(emitSpy).toHaveBeenCalledWith("items:use", [
      [{ id: "4003", type: "DIAMOND_SHD", count: 380 }],
    ]);
  });

  it("Diamond 十连应只扣 6000 合成玉", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    controller["_pullOnce"] = vi.fn<typeof controller["_pullOnce"]>().mockResolvedValue({
      charId: "char_001",
      beforeNonHitCnt: 1,
      extras: { from: "NORMAL" },
    });
    await controller.tenAdvancedGacha({ poolId: "p_normal_1", useTkt: GachaType.Diamond, itemList: [] });
    expect(emitSpy).toHaveBeenCalledWith("items:use", [
      [{ id: "4003", type: "DIAMOND_SHD", count: 6000 }],
    ]);
  });

  // Round 43：新手池（BOOT_*）官服规则 —— newbeeGachaPoolClient.gachaTimes = 21 次上限，
  // 池名即规则原文「全部寻访必定获得至少1名5★以上干员和至少1名6★干员！」
  // → 第 21 抽（最后一抽）强制六星；次数账本写 gacha.newbee（官方 {openFlag,cnt,poolId}）。
  it("新手池：第 21 抽强制六星并把池置为关闭", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.gacha.newbee = {
      openFlag: 1,
      cnt: 20,
      poolId: "BOOT_0_1_1",
    };
    const handleSpy = vi
      .spyOn(controller, "_handleGacha")
      .mockResolvedValue({ charId: "char_b6", rank: 5 });
    await controller["_pullOnce"]({
      poolId: "BOOT_0_1_1",
      beforeNonHitCnt: 0,
    });
    expect(handleSpy).toHaveBeenCalledWith(
      "BOOT_0_1_1",
      expect.objectContaining({ forceRank: 5 }),
    );
    expect(mockPlayer._playerdata.gacha.newbee).toEqual({
      openFlag: 0,
      cnt: 21,
      poolId: "BOOT_0_1_1",
    });
  });

  it("新手池：未到第 21 抽不强制六星（正常摇号）", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.gacha.newbee = {
      openFlag: 1,
      cnt: 3,
      poolId: "BOOT_0_1_1",
    };
    const handleSpy = vi
      .spyOn(controller, "_handleGacha")
      .mockResolvedValue({ charId: "char_b3", rank: 3 });
    await controller["_pullOnce"]({
      poolId: "BOOT_0_1_1",
      beforeNonHitCnt: 0,
    });
    expect(handleSpy).toHaveBeenCalledWith(
      "BOOT_0_1_1",
      expect.objectContaining({ forceRank: undefined }),
    );
    expect(mockPlayer._playerdata.gacha.newbee.cnt).toBe(4);
  });

  it("新手池：次数用尽（21/21）时单抽被拒绝", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.gacha.newbee = {
      openFlag: 0,
      cnt: 21,
      poolId: "BOOT_0_1_1",
    };
    await expect(
      controller.advancedGacha({
        poolId: "BOOT_0_1_1",
        useTkt: GachaType.Diamond,
        itemId: "",
      }),
    ).rejects.toThrow(/新手寻访次数不足/);
  });

  it("新手池：剩余不足 10 次时十连被拒绝（15+10>21）", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    mockPlayer._playerdata.gacha.newbee = {
      openFlag: 1,
      cnt: 15,
      poolId: "BOOT_0_1_1",
    };
    await expect(
      controller.tenAdvancedGacha({
        poolId: "BOOT_0_1_1",
        useTkt: GachaType.Diamond,
        itemList: [],
      }),
    ).rejects.toThrow(/新手寻访次数不足/);
  });

  it("CombineTenTicket 十连应消耗客户端 itemList 且不叠加其他费用", async () => {
    const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    controller["_pullOnce"] = vi.fn<typeof controller["_pullOnce"]>().mockResolvedValue({
      charId: "char_001",
      beforeNonHitCnt: 1,
      extras: { from: "NORMAL" },
    });
    await controller.tenAdvancedGacha({
      poolId: "p_normal_1",
      useTkt: GachaType.CombineTenTicket,
      // 无 type 的物品：与 excel.makeItem(id, count) 同形（库存层按 item_table 推导），
      itemList: [excelData.makeItem("4005", 10)],
    });
    expect(emitSpy).toHaveBeenCalledWith("items:use", [[{ id: "4005", count: 10 }]]);
  });

  describe("保底计数批量落盘（2026-08-10 速度优化）", () => {
    it("十连应只调用 saveBeforeNonHitCnt 一次（原每抽一次 SQLite 全表重写）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      controller["_pullOnce"] = vi
        .fn<typeof controller["_pullOnce"]>()
        .mockImplementation(async ({ beforeNonHitCnt }) => ({
          charId: "char_001",
          beforeNonHitCnt: beforeNonHitCnt + 1,
          extras: { from: "NORMAL" },
        }));
      await controller.tenAdvancedGacha({
        poolId: "p_normal_1",
        useTkt: GachaType.Diamond,
        itemList: [],
      });
      expect(saveSpy).toHaveBeenCalledTimes(1);
      // 10 抽全部未中六星 → 最终计数 = 10
      expect(saveSpy).toHaveBeenCalledWith(10000, "NORMAL", 10);
    });

    it("单抽 doAdvancedGacha 仍按次落盘且计数 +1", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // 强制稀有度 4（非六星）→ 保底计数 +1
      vi.spyOn(controller, "_getRarityRank").mockResolvedValue(4);
      await controller.doAdvancedGacha({ poolId: "p_normal_1", useTkt: 0, itemId: "" });
      expect(saveSpy).toHaveBeenCalledWith(10000, "NORMAL", 1);
    });

    it("六星命中（rank 5）应重置保底计数为 0（修复 rank 恒 0 死值）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      vi.spyOn(controller, "_getRarityRank").mockResolvedValue(5);
      await controller.doAdvancedGacha({ poolId: "p_normal_1", useTkt: 0, itemId: "" });
      expect(saveSpy).toHaveBeenCalledWith(10000, "NORMAL", 0);
    });

    it("十连中途中六星应重置计数后继续累积（rank 4,4,5 后清零，7 次未中 → 7）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      const ranks = [4, 4, 5, 4, 4, 4, 4, 4, 4, 4];
      vi.spyOn(controller, "_getRarityRank").mockImplementation(
        () => Promise.resolve(ranks.shift()!),
      );
      await controller.tenAdvancedGacha({
        poolId: "p_normal_1",
        useTkt: GachaType.Diamond,
        itemList: [],
      });
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith(10000, "NORMAL", 7);
    });
  });

  describe("五星保底：一次性事件（2026-08-19 修复：原 cnt 少一 → 前 10 抽可能无五星）", () => {
    it("前 10 抽若无五星，第 10 抽强制五星；此后不再触发（一次性）且计数器不回绕", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // 屏蔽六星（totalPercent 置 0）——否则 per6 恒命中六星，保底分支不可达
      excelData.GachaDetailTable.details["p_normal_1"].availCharInfo.perAvailList[0].totalPercent = 0;
      // 初始化保底：累计抽数从 0 开始（cnt 只增不减，不回绕）
      await mockPlayer.update((draft) => {
        draft.gacha.normal["p_normal_1"] = { cnt: 0, maxCnt: 10, rarity: 4, avail: true };
      });
      // 六星判定 Math.random<=per6(0) 恒不命中；randomChoices 加权恒取最末 rank 3
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.9);
      const ranks: number[] = [];
      for (let i = 0; i < 10; i++) {
        ranks.push(await controller._getRarityRank("p_normal_1", { beforeNonHitCnt: 0 }));
      }
      // 前 9 抽全为低稀有度（<4，非五星），第 10 抽触发一次性保底强制 4（五星）
      expect(ranks.slice(0, 9).every((r) => r < 4)).toBe(true);
      expect(ranks[9]).toBe(4);
      // 计数器只增不减（禁止回绕）：10 抽后 cnt=10
      expect(mockPlayer._playerdata.gacha!.normal["p_normal_1"].cnt).toBe(10);
      // 一次性事件：第 11、第 20 抽（cnt 不再等于 maxCnt）均不再强制五星
      for (let i = 0; i < 10; i++) {
        expect(await controller._getRarityRank("p_normal_1", { beforeNonHitCnt: 0 })).toBe(3);
      }
      expect(mockPlayer._playerdata.gacha!.normal["p_normal_1"].cnt).toBe(20);
      rnd.mockRestore();
    });
  });

  describe("缺详情卡池回退（2026-08-09 修复）", () => {
    it("_poolDetail 对 gacha_detail_table 缺失的卡池应回退而非抛错", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // p_normal_1 在表内直接返回；LIMITED_76_0_1 缺失 → 回退（不抛错）
      expect(controller["_poolDetail"]("p_normal_1")).toBeDefined();
      const fallback = controller["_poolDetail"]("LIMITED_76_0_1");
      expect(fallback).toBeDefined();
      expect(fallback.availCharInfo).toBeDefined();
    });

    it("doAdvancedGacha 对缺失详情卡池应正常返回（不 500）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // char:get 事件 emit 会调用 mockTrigger.emit（测试环境无订阅），
      // 只验证不抛错——真实行为由实机冒烟覆盖
      await expect(
        controller.doAdvancedGacha({ poolId: "LIMITED_76_0_1", useTkt: 0, itemId: "" }),
      ).resolves.toBeDefined();
    });
  });

  describe("ruleType 缺失处理（2026-08-09 修复）", () => {
    it("DOUBLE/CLASSIC_DOUBLE/BACKFLOW/SPECIAL 池应走通用 _handleGacha 不 500", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // p_double_1 是 DOUBLE ruleType（此前 funcs 缺该键 → 500）
      await expect(
        controller.doAdvancedGacha({ poolId: "p_double_1", useTkt: 0, itemId: "" }),
      ).resolves.toBeDefined();
    });
  });

  describe("LIMITED 池 extraItem 接线（2026-08-10 修复：原 extras 死代码）", () => {
    it("LIMITED 池应透传 { from: LIMITED, extraItem: LMTGS 凭证 } 到 char:get", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await controller.doAdvancedGacha({ poolId: "p_limited_1", useTkt: 0, itemId: "" });
      // emit 调用形如 emit("char:get", [charId, extras, callback])——extras 含 from/extraItem
      const charGetCall = emitSpy.mock.calls.find((c) => c[0] === "char:get");
      expect(charGetCall).toBeDefined();
      // 修复：extraItem 带 type=LMTGS_COIN（消费型入账 consumable）——旧实现缺 type
      // + LMTGSID 缺失时空 id → gainItem 查 ItemTable[""] 警告跳过（凭证从未入账）
      expect(charGetCall![1][1]).toEqual({
        from: "LIMITED",
        extraItem: { id: "LMTGS_COIN_TEST", count: 1, type: "LMTGS_COIN" },
      });
    });

    it("LIMITED 池缺 LMTGSID 时应回退 LMTGS_COIN 凭证（不再空 id 警告跳过）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      // p_limited_2 无 LMTGSID → 回退 "LMTGS_COIN"
      await controller.doAdvancedGacha({ poolId: "p_limited_2", useTkt: 0, itemId: "" });
      const charGetCall = emitSpy.mock.calls.find((c) => c[0] === "char:get");
      expect(charGetCall![1][1]).toEqual({
        from: "LIMITED",
        extraItem: { id: "LMTGS_COIN", count: 1, type: "LMTGS_COIN" },
      });
    });

    it("普通池不携带 extraItem", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await controller.doAdvancedGacha({ poolId: "p_normal_1", useTkt: 0, itemId: "" });
      const charGetCall = emitSpy.mock.calls.find((c) => c[0] === "char:get");
      expect(charGetCall![1][1]).toEqual({ from: "NORMAL" });
    });
  });

  describe("中坚甄选自选卡池（self-select upChar 生效）", () => {
    it("GACHA_RULE_TYPE 应将 CLASSIC/FESCLASSIC 映射到对应存储键，不回落 single", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // CLASSIC → classic，FESCLASSIC → fesClassic（此前都误回落 single）
      expect(controller["_selfSelectedUpForRank"]("p_classic_1", 5)).toEqual([]);
      expect(controller["_selfSelectedUpForRank"]("p_fesclassic_1", 5)).toEqual([]);
    });

    it("玩家已选该稀有度 UP（字典形态）时，_getRandomChar 应从自选列表中出", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // 模拟 choosePoolUp 已写入：gacha[classic][poolId].upChar = { 5: [...], 4: [...] }
      mockPlayer._playerdata.gacha = gachaSeed({
        classic: {
          p_classic_1: { upChar: { "5": ["char_c5b"], "4": ["char_c4c"] } },
        },
      });
      // 命中概率槽（Math.random < 0.25*2=0.5）→ 从自选 [char_c5b] 出
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.1);
      const charId = await controller._getRandomChar("p_classic_1", 5, {});
      expect(charId).toBe("char_c5b");
      rnd.mockRestore();
    });

    it("自选应替换静态 UP 的出率档：命中槽位出玩家所选而非详情静态 char_upA", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.gacha = gachaSeed({
        classic: {
          p_classic_1: { upChar: { "5": ["char_c5b"] } },
        },
      });
      // 静态 upCharInfo 六星是 char_upA；自选后应出 char_c5b
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.1);
      const charId = await controller._getRandomChar("p_classic_1", 5, {});
      expect(charId).toBe("char_c5b");
      rnd.mockRestore();
    });

    it("无静态 UP 的自选池（FESCLASSIC）也按 35% 默认档出玩家所选", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.gacha = gachaSeed({
        fesClassic: {
          p_fesclassic_1: { upChar: { "5": ["char_f5a"] } },
        },
      });
      // 独占语义：FESCLASSIC 静态 UP 为空，自选即该稀有度唯一候选 → 出自选 char_f5a
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.1);
      const charId = await controller._getRandomChar("p_fesclassic_1", 5, {});
      expect(charId).toBe("char_f5a");
      rnd.mockRestore();
    });

    // Round 44（审计 §5.2-10）：自选池语义改为**独占** —— 玩家为该稀有度自选后，
    // 该稀有度候选即为所选干员（官服「仅会出现所选干员」；FESCLASSIC 详情静态 UP 为空、
    // 候选全集在 perAvailList，选择是唯一区分手段）。原实现把自选仅当 UP 档
    // （percent / 0.35），未命中槽位时仍从全池补位 → 歪出未选干员。
    it("自选后该稀有度候选即为所选（不再从全池补位出未选干员）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.gacha = gachaSeed({
        classic: {
          p_classic_1: { upChar: { "5": ["char_c5b"] } },
        },
      });
      // rr=0.9：旧实现下「未命中 0.5 槽 → 从候选池排除自选后取 char_c5a」，
      // 新语义下恒为所选 char_c5b
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.9);
      const charId = await controller._getRandomChar("p_classic_1", 5, {});
      expect(charId).toBe("char_c5b");
      rnd.mockRestore();
    });

    it("自选只覆盖所选稀有度：未自选的稀有度仍走详情表候选", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.gacha = gachaSeed({
        classic: {
          p_classic_1: { upChar: { "5": ["char_c5b"] } },
        },
      });
      // rank=4（5★）未自选 → 仍从详情候选 char_c4a/b/c 中取
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.99);
      const charId = await controller._getRandomChar("p_classic_1", 4, {});
      expect(["char_c4a", "char_c4b", "char_c4c"]).toContain(charId);
      rnd.mockRestore();
    });

    it("玩家未自选时维持原静态 UP 逻辑（出静态 UP char_upA）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.1);
      const charId = await controller._getRandomChar("p_classic_1", 5, {});
      expect(charId).toBe("char_upA");
      rnd.mockRestore();
    });

    it("effectiveUpPerCharList 用玩家自选覆盖静态 UP（按稀有度）", () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // 模拟 choosePoolUp 已写入：gacha[classic][poolId].upChar = { 5:[...], 4:[...] }
      mockPlayer._playerdata.gacha = gachaSeed({
        classic: {
          p_classic_1: { upChar: { "5": ["char_c5b"], "4": ["char_c4c"] } },
        },
      });
      const per = controller.effectiveUpPerCharList("p_classic_1");
      expect(per.find((c) => c.rarityRank === 5)).toMatchObject({
        rarityRank: 5,
        charIdList: ["char_c5b"],
        count: 1,
      });
      expect(per.find((c) => c.rarityRank === 4)?.charIdList).toEqual(["char_c4c"]);
    });

    it("getPoolDetail 返回的 detailInfo 应含玩家自选 UP（客户端据此生成所选卡池）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.gacha = gachaSeed({
        classic: {
          p_classic_1: { upChar: { "5": ["char_c5b"], "4": ["char_c4c"] } },
        },
      });
      const detail = await controller.getPoolDetail({ poolId: "p_classic_1" });
      // 静态 UP char_upA → 自选 char_c5b
      expect(detail.upCharInfo?.perCharList.find((c) => c.rarityRank === 5)?.charIdList).toEqual([
        "char_c5b",
      ]);
      expect(detail.upCharInfo?.perCharList.find((c) => c.rarityRank === 4)?.charIdList).toEqual([
        "char_c4c",
      ]);
    });

    it("FESCLASSIC 无静态 UP 时自选按 35% 默认档注入 perCharList", () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.gacha = gachaSeed({
        fesClassic: {
          p_fesclassic_1: { upChar: { "5": ["char_f5a"] } },
        },
      });
      const per = controller.effectiveUpPerCharList("p_fesclassic_1");
      expect(per).toHaveLength(1);
      expect(per[0]).toMatchObject({
        rarityRank: 5,
        charIdList: ["char_f5a"],
        percent: 0.35,
        count: 1,
      });
    });
  });

  describe("CLASSIC 自选池保底联动", () => {
    it("CLASSIC 池单抽未中六星（rank 4）应按 ruleType=CLASSIC 累计 +1", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      vi.spyOn(controller, "_getRarityRank").mockResolvedValue(4);
      await controller.doAdvancedGacha({ poolId: "p_classic_1", useTkt: 0, itemId: "" });
      // 保底计数按 ruleType 分组落盘（中坚甄选与 NORMAL 独立，不互相干扰）
      expect(saveSpy).toHaveBeenCalledWith(10000, "CLASSIC", 1);
    });

    it("CLASSIC 池单抽中六星（rank 5）应按 ruleType=CLASSIC 重置为 0", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      vi.spyOn(controller, "_getRarityRank").mockResolvedValue(5);
      await controller.doAdvancedGacha({ poolId: "p_classic_1", useTkt: 0, itemId: "" });
      expect(saveSpy).toHaveBeenCalledWith(10000, "CLASSIC", 0);
    });

    it("CLASSIC 池十连统一落盘：全未中六星时 saveBeforeNonHitCnt 只调一次且计数为 10", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // 强制 10 抽全为 5 星（rank 4，非六星）→ 保底计数从 0 累积到 10
      vi.spyOn(controller, "_getRarityRank").mockResolvedValue(4);
      await controller.tenAdvancedGacha({
        poolId: "p_classic_1",
        useTkt: GachaType.ClassicTenTicket,
        itemList: [],
      });
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith(10000, "CLASSIC", 10);
    });

    it("CLASSIC 池十连中途中六星应重置后继续累积（4,4,5 后 → 7）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      const ranks = [4, 4, 5, 4, 4, 4, 4, 4, 4, 4];
      vi.spyOn(controller, "_getRarityRank").mockImplementation(
        () => Promise.resolve(ranks.shift()!),
      );
      await controller.tenAdvancedGacha({
        poolId: "p_classic_1",
        useTkt: GachaType.ClassicTenTicket,
        itemList: [],
      });
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith(10000, "CLASSIC", 7);
    });

    it("CLASSIC 池五星保底：前 10 抽若无五星，第 10 抽强制五星（一次性），自选池共用 normal 保底结构", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // 屏蔽六星（totalPercent 置 0）→ per6 恒不命中
      excelData.GachaDetailTable.details["p_classic_1"].availCharInfo.perAvailList[0].totalPercent = 0;
      await mockPlayer.update((draft) => {
        draft.gacha.normal["p_classic_1"] = { cnt: 0, maxCnt: 10, rarity: 4, avail: true };
      });
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.9);
      const ranks: number[] = [];
      for (let i = 0; i < 10; i++) {
        ranks.push(await controller._getRarityRank("p_classic_1", { beforeNonHitCnt: 0 }));
      }
      // 前 9 抽低稀有度，第 10 抽触发一次性保底强制 4（五星）
      expect(ranks.slice(0, 9).every((r) => r < 4)).toBe(true);
      expect(ranks[9]).toBe(4);
      expect(mockPlayer._playerdata.gacha!.normal["p_classic_1"].cnt).toBe(10);
      // 一次性事件：此后不再强制五星
      expect(await controller._getRarityRank("p_classic_1", { beforeNonHitCnt: 0 })).toBe(3);
      rnd.mockRestore();
    });

    it("触发五星保底（rank>=4 的五星）后应关闭 avail，客户端不再显示保底提示", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // 屏蔽六星权重 → 加权只会带 rank4（五星）/rank3，第 10 抽触发保底强制升 rank4
      excelData.GachaDetailTable.details["p_classic_1"].availCharInfo.perAvailList[0].totalPercent = 0;
      await mockPlayer.update((draft) => {
        draft.gacha.normal["p_classic_1"] = { cnt: 9, maxCnt: 10, rarity: 4, avail: true };
      });
      // 第 10 抽触发一次性五星保底 → rank=4；修复前 avail 残留 true
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.9);
      const rank = await controller._getRarityRank("p_classic_1", { beforeNonHitCnt: 0 });
      expect(rank).toBe(4);
      expect(mockPlayer._playerdata.gacha!.normal["p_classic_1"].avail).toBe(false);
      rnd.mockRestore();
    });

    it("未到五星前（rank<4）不应关闭 avail，保底提示保留", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // 屏蔽六星与四星权重 → 加权必落 rank3（<4），且不在保底点
      excelData.GachaDetailTable.details["p_classic_1"].availCharInfo.perAvailList[0].totalPercent = 0;
      excelData.GachaDetailTable.details["p_classic_1"].availCharInfo.perAvailList[1].totalPercent = 0;
      await mockPlayer.update((draft) => {
        draft.gacha.normal["p_classic_1"] = { cnt: 2, maxCnt: 10, rarity: 4, avail: true };
      });
      const rnd = vi.spyOn(Math, "random").mockReturnValue(0.9);
      const rank = await controller._getRarityRank("p_classic_1", { beforeNonHitCnt: 0 });
      expect(rank).toBe(3);
      expect(mockPlayer._playerdata.gacha!.normal["p_classic_1"].avail).toBe(true);
      rnd.mockRestore();
    });

    it("CLASSIC 池六星保底硬化：beforeNonHitCnt≥50 时按 50 抽后每抽 +2% 六星（软保底）", async () => {
      const controller = new GachaManager(asPlayerManager(mockPlayer), mockTrigger);
      // beforeNonHitCnt=99 → per6 修正 0.98+，rand 注入 0 恒命中 → 必出六星（确定性，避免 2% 概率波动）
      setRandSource(() => 0);
      try {
        const rank = await controller._getRarityRank("p_classic_1", { beforeNonHitCnt: 99 });
        expect(rank).toBe(5);
      } finally {
        resetRandSource();
      }
    });
  });
});
