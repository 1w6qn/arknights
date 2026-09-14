import { describe, it, expect, vi } from "vitest";
/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }
/** excel mock 干员行形状（本文件用到的字段即可） */
interface ExcelCharRowMock {
  name?: string;
  charId?: string;
  rarity?: string;
  profession?: string;
  subProfessionId?: string;
}

// rogue_6 分队专属逻辑：本源研修（本源系希望-2）、多边贸易（零件箱容量+2/+4）、
// 开拓者（进区获加工品）、zone_into_reward 无区域限定不崩
const excelMock = vi.hoisted(() => ({
  // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
  getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
  itemName(id: string): string { return this.getItem(id)?.name ?? id; },
  makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
  charData(charId: string) { return this.CharacterTable?.[charId]; },
  stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
  ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
  StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
  RoguelikeTopicTable: {
    details: {
      rogue_6: {
        stages: { ro6_n_1_1: { id: "ro6_n_1_1" }, ro6_n_3_1: { id: "ro6_n_3_1" } },
        init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL", initialHp: 8, initialGold: 8, initialPopulation: 6, initialSquadCapacity: 6, initialBandRelic: [], initialRecruitGroup: [] }],
        items: {
          rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: "NONE" },
          rogue_6_max_weight: { id: "rogue_6_max_weight", type: "MAX_WEIGHT", rarity: "NONE" },
          rogue_6_scrap_G_01: { id: "rogue_6_scrap_G_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_G_02: { id: "rogue_6_scrap_G_02", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_G_08: { id: "rogue_6_scrap_G_08", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_P_01: { id: "rogue_6_scrap_P_01", type: "SCRAP", rarity: "RARE" },
          rogue_6_relic_cargo_4: { id: "rogue_6_relic_cargo_4", type: "RELIC", rarity: "RARE" },
          rogue_6_relic_cargo_7: { id: "rogue_6_relic_cargo_7", type: "RELIC", rarity: "NORMAL" },
          rogue_6_relic_cargo_8: { id: "rogue_6_relic_cargo_8", type: "RELIC", rarity: "NORMAL" },
          rogue_6_relic_legacy_50: { id: "rogue_6_relic_legacy_50", type: "RELIC", rarity: "RARE" },
          rogue_6_relic_fight_1: { id: "rogue_6_relic_fight_1", type: "RELIC", rarity: "SUPER_RARE" },
          rogue_6_start_6: { id: "rogue_6_start_6", type: "RELIC", rarity: "NORMAL" },
        },
        relics: {
          rogue_6_start_6: {
            id: "rogue_6_start_6",
            buffs: [
              { key: "zone_into_reward", blackboard: [{ key: "id", valueStr: "pool_treasure" }, { key: "count", value: 3 }, { key: "zone", valueStr: "zone_3" }] },
            ],
          },
          rogue_6_relic_cargo_4: { id: "rogue_6_relic_cargo_4", buffs: [] },
          rogue_6_relic_legacy_50: { id: "rogue_6_relic_legacy_50", buffs: [] },
          rogue_6_relic_fight_1: { id: "rogue_6_relic_fight_1", buffs: [] },
          rogue_6_band_14: { id: "rogue_6_band_14", buffs: [{ key: "recruit_cost_sub_profession", blackboard: [{ key: "rarity", valueStr: "TIER_4,TIER_5,TIER_6" }, { key: "sub_profession", valueStr: "primcaster,primprotector,primguard,ritualist" }, { key: "delta", value: -2 }] }] },
          rogue_6_band_19: { id: "rogue_6_band_19", buffs: [{ key: "immediate_reward", blackboard: [{ key: "id", valueStr: "rogue_6_max_weight" }, { key: "count", value: 2 }] }, { key: "shop_recycle_reward", blackboard: [{ key: "id", valueStr: "rogue_6_gold" }, { key: "count", value: 8 }, { key: "sell_count", value: 3 }, { key: "limit", value: 1 }] }] },
          rogue_6_band_20: { id: "rogue_6_band_20", buffs: [{ key: "shop_recycle_reward", blackboard: [{ key: "id", valueStr: "rogue_6_gold" }, { key: "count", value: 8 }, { key: "sell_count", value: 3 }, { key: "limit", value: 1 }] }] },
          rogue_6_band_17: { id: "rogue_6_band_17", buffs: [{ key: "zone_into_reward", blackboard: [{ key: "id", valueStr: "pool_scrap_6" }, { key: "count", value: 1 }] }] },
        },
        recruitTickets: {
          rogue_6_recruit_ticket_caster: { id: "rogue_6_recruit_ticket_caster", professionList: ["CASTER"], rarityList: ["TIER_5"] },
        },
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["GRID_ZONE", "SCRAP"],
        scrap: { scrapItemToType: { rogue_6_scrap_G_01: "GOODS", rogue_6_scrap_G_02: "GOODS", rogue_6_scrap_G_08: "GOODS", rogue_6_scrap_P_01: "PASSIVE" } },
      },
    },
    consts: {},
  },
  CharacterTable: {
    char_499_kaitou: { charId: "char_499_kaitou", name: "本源术师A", rarity: "TIER_5", profession: "CASTER", subProfessionId: "primcaster" },
    char_002_amiya: { charId: "char_002_amiya", name: "普通术师", rarity: "TIER_5", profession: "CASTER", subProfessionId: "corecaster" },
  } as Record<string, ExcelCharRowMock>,
  GameDataConst: { maxLevel: [[], [], [], [], [], []] },
}));

vi.mock("@excel/excel", () => ({ default: excelMock }));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";

/**
 * 干员入队夹具视图
 *
 * 用例沿用历史夹具里的 `rarity`（星级）键，而生成模型 `troop.chars` 的元素未声明该键
 * （星级由 excel 的 `charData(charId).rarity` 提供，见本源研修分支，本键不被读取）。
 * 为不改夹具数据，仅就地声明该键的视图后单向断言入种子。
 */
interface TroopCharFixture {
  charId?: string;
  instId?: number;
  rarity?: string;
}

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer() {
  const pd = mockPlayerData({
    rlv2: {
      outer: { rogue_6: {} },
      current: {},
      pinned: {} as string,
    },
    troop: {
      chars: {
        "1": { charId: "char_499_kaitou", instId: 1, rarity: "TIER_5" } as TroopCharFixture,
        "2": { charId: "char_002_amiya", instId: 2, rarity: "TIER_5" } as TroopCharFixture,
      },
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  // 夹具只声明被测分支读到的键，其余 game 字段由惰性分支承受
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme: "rogue_6",
    mode: "NORMAL",
    modeGrade: 0,
    outer: { support: false },
  });
  return player;
}

async function withRandom(v: number, fn: () => Promise<void> | void) {
  const spy = vi.spyOn(Math, "random").mockReturnValue(v);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

function holdRelic(player: PlayerDataManager, id: string) {
  const relicMgr = player.rlv2.inventory!._relic;
  const relics = relicMgr.relics;
  relicMgr.relics = {
    ...relics,
    [`r_${Object.keys(relics).length}`]: {
      index: `r_${Object.keys(relics).length}`,
      id,
      count: 1,
      ts: 0,
    },
  };
}

describe("rogue_6 分队专属逻辑", () => {
  it("本源研修（recruit_cost_sub_profession）：本源系干员希望-2，非本源系不变", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    // 玩家主队伍含本源术师（kaitou）与普通术师（amiya）——已由 mockPlayerData 初始化
    // 应用本源研修分队 buff（relic.gain band_14 会走 applyBuffs → _buffs）
    await player.rlv2._trigger.emit("rlv2:relic:gain", [
      { id: "rogue_6_band_14", count: 1 },
    ]);
    // 激活术师招募券 → 检查候选希望消耗
    await player.rlv2._trigger.emit("rlv2:recruit:gain", [
      "rogue_6_recruit_ticket_caster",
      "initial",
      0,
    ]);
    const tickets = player.rlv2.inventory!.recruit;
    const ticket = Object.values(tickets)[0];
    await player.rlv2._trigger.emit("rlv2:recruit:active", [
      ticket.index,
    ]);
    const list = ticket.list;
    const kaitou = list.find((c) => c.charId === "char_499_kaitou");
    const amiya = list.find((c) => c.charId === "char_002_amiya");
    expect(kaitou).toBeTruthy();
    expect(amiya).toBeTruthy();
    // 本源系（primcaster）：5 星基础 2 希望 - 2 = 0；普通术师（corecaster）：仍 2
    expect(kaitou!.population).toBe(0);
    expect(amiya!.population).toBe(2);
  });

  it("多边贸易（MAX_WEIGHT）：零件箱容量 +2", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const scrap = player.rlv2._module.scrap;
    const before = scrap.limit;
    await player.rlv2._trigger.emit("rlv2:get:items", [
      [{ id: "rogue_6_max_weight", count: 2, sub: 0 }],
    ]);
    expect(scrap.limit).toBe(before + 2);
  });

  it("开拓者（zone_into_reward pool_scrap_6）：进入新区域获得 1 件加工品（零件箱+1）", async () => {
    await withRandom(0, async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      await player.rlv2._pool.create(); // 建加工品池（真机 createGame 会触发）
      // spy pool.get：官方池成员（M_01 等 18 件）未在 mock excel 中定义，固定返回 mock 内零件
      const pool = player.rlv2._pool;
      const getSpy = vi.spyOn(pool, "get").mockReturnValue({
        id: "rogue_6_scrap_G_01",
        count: 1,
      });
      // 应用开拓者分队 buff（zone_into_reward 无区域限定）
      await player.rlv2._trigger.emit("rlv2:relic:gain", [
        { id: "rogue_6_band_17", count: 1 },
      ]);
      const scrap = player.rlv2._module.scrap;
      const before = Object.keys(scrap.inventory).length;
      // 生成区域 → zone_into_reward 触发（blackboard 无区域限定 → 不崩且发放）
      await player.rlv2._trigger.emit("rlv2:zone:new", [1]);
      await new Promise((r) => setTimeout(r, 0)); // 等 get:items 微任务链
      expect(getSpy).toHaveBeenCalledWith("pool_scrap_6", false);
      expect(Object.keys(scrap.inventory).length).toBe(before + 1);
      getSpy.mockRestore();
    });
  });

  it("zone_into_reward 无 blackboard[2]（区域限定）时 generate 不抛错", async () => {
    await withRandom(0, async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      await player.rlv2._trigger.emit("rlv2:relic:gain", [
        { id: "rogue_6_band_17", count: 1 },
      ]);
      const gz = player.rlv2._module.gridZone;
      await expect(
        (async () => {
          gz.generate([2]);
        })(),
      ).resolves.toBeUndefined();
    });
  });

  it("pool_scrap_3/6 池已建（官方加权池：12/18 件 + 概率权重表）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    await player.rlv2._pool.create();
    const pool = player.rlv2._pool;
    expect(pool._pools["pool_scrap_6"].length).toBe(18);
    expect(pool._pools["pool_scrap_3"].length).toBe(12);
    // 加权表存在（官方出现概率）
    expect(pool._poolWeights["pool_scrap_3"]["rogue_6_scrap_M_01"]).toBe(21.64);
    expect(pool._poolWeights["pool_scrap_6"]["rogue_6_scrap_P_01"]).toBe(10.02);
  });

  it("pool_scrap_3 加权抽取：random 0 → 权重首个（报废轮子 21.64%），random≈1 → 末位（简易遥控器 0.10%）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    await player.rlv2._pool.create();
    const pool = player.rlv2._pool;
    // random=0：加权命中首个成员（报废轮子 M_01）
    const spy0 = vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pool.get("pool_scrap_3").id).toBe("rogue_6_scrap_M_01");
    spy0.mockRestore();
    // random≈1（0.9999）：累加权重直至末尾（"简易遥控器" M_12，权重 0.10%）
    const spy1 = vi.spyOn(Math, "random").mockReturnValue(0.9999);
    expect(pool.get("pool_scrap_3").id).toBe("rogue_6_scrap_M_12");
    spy1.mockRestore();
  });

  it("官方池（路标档案馆 pools/rogue_6 精确成员）：珍宝池/小礼物/零件池 7-9/额外掉落/Boss", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    await player.rlv2._pool.create();
    const pools = player.rlv2._pool._pools;
    // pool_treasure：官方 36 件珍宝藏品（legacy 系，含 NORMAL 囊中骨/林中小手——页面数据如此）
    expect(pools["pool_treasure"].length).toBe(36);
    expect(pools["pool_treasure"]).toContain("rogue_6_relic_legacy_2"); // 香草沙士汽水
    expect(pools["pool_treasure"]).toContain("rogue_6_relic_cargo_7"); // 囊中骨（官方珍宝池含）
    // pool_small_gift：官方 3 件小礼物（制式防暴用具/异铁小圆盾/悬丝傀儡）
    expect(pools["pool_small_gift"]).toEqual([
      "rogue_6_relic_legacy_8",
      "rogue_6_relic_legacy_12",
      "rogue_6_relic_legacy_114",
    ]);
    // pool_scrap_7/8/9：多成员零件池（板藤/恋家果/光彩松露；报废轮子等 6 件；血蕈等 6 件）
    expect(pools["pool_scrap_7"]).toEqual([
      "rogue_6_scrap_G_09",
      "rogue_6_scrap_G_10",
      "rogue_6_scrap_G_11",
    ]);
    expect(pools["pool_scrap_8"].length).toBe(6);
    expect(pools["pool_scrap_9"]).toContain("rogue_6_scrap_G_02"); // 血蕈
    // drop_extra_pool（76 件，地质调查分队额外掉落）/ pool_boss（36 件）：
    // 路标档案馆原始数据全量（2026-08-25 重抓 /data/archives/blackstream.json）
    expect(pools["drop_extra_pool"].length).toBe(76);
    expect(pools["drop_extra_pool"]).toContain("rogue_6_relic_legacy_2");
    expect(pools["pool_boss"].length).toBe(36);
    expect(pools["pool_boss"]).toContain("rogue_6_relic_legacy_4"); // 迷梦香精
  });

  it("多边贸易（shop_recycle_reward）：同一行商节点卖出 3 件零件 → +8 源石锭（限 1 次）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    await player.rlv2._trigger.emit("rlv2:relic:gain", [
      { id: "rogue_6_band_19", count: 1 },
    ]);
    // 当前节点设为行商（诡意行商 4096）
    const map = player.rlv2._map;
    map.zones["1002"] = {
      id: "zone_3",
      index: 1002,
      nodes: {
        "201": { index: "201", pos: { x: 2, y: 1 }, next: [], type: 4096 },
      },
      variation: [],
    };
    player.rlv2._status.cursor.zone = 3;
    player.rlv2._status.cursor.position = { x: 2, y: 1 };
    // 零件箱放 4 件零件（非载具）
    const scrap = player.rlv2._module.scrap;
    for (let i = 3; i <= 6; i++) {
      scrap.inventory[`s_${i}`] = {
        instId: `s_${i}`,
        id: "rogue_6_scrap_G_01",
        value: 1,
        useCnt: 0,
        ts: 0,
      };
    }
    const goldBefore = player.rlv2._status.property.gold;
    // 卖出 3 件 → 第 3 件触发 +8
    await player.rlv2.loseScrap({ instId: "s_3" });
    await player.rlv2.loseScrap({ instId: "s_4" });
    expect(player.rlv2._status.property.gold).toBe(goldBefore);
    await player.rlv2.loseScrap({ instId: "s_5" });
    expect(player.rlv2._status.property.gold).toBe(goldBefore + 8);
    // 第 4 件不再触发（限 1 次）
    await player.rlv2.loseScrap({ instId: "s_6" });
    expect(player.rlv2._status.property.gold).toBe(goldBefore + 8);
  });

  it("多边贸易升级（band_20）：进入行商节点获得 1 个<枯苔藓球>", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    holdRelic(player, "rogue_6_band_20");
    // 放一个行商节点并移动进入
    const gz = player.rlv2._module.gridZone;
    gz.generate([2]);
    player.rlv2._status.cursor.zone = 2;
    const gz3 = gz.zones["zone_2"];
    const someId = Object.keys(gz3.nodes)[0];
    gz3.nodes[someId].content = { shop: { goods: [] }, kind: 4096 };
    const scrap = player.rlv2._module.scrap;
    const before = Object.keys(scrap.inventory).length;
    await player.rlv2.gridZoneMoveTo({ route: [someId] });
    await new Promise((r) => setTimeout(r, 0));
    const ids = Object.values(scrap.inventory).map((i) => i.id);
    expect(ids).toContain("rogue_6_scrap_G_08");
    expect(Object.keys(scrap.inventory).length).toBe(before + 1);
  });

  it("startbuff_12（进入血色空脉 zone_3 获得 3 个随机收藏品）：zone_into_reward 按 valueStr 区域匹配发 pool_treasure", async () => {
    await withRandom(0, async () => {
      const player = makePlayer();
      await player.rlv2._module.create();
      await player.rlv2._pool.create();
      // spy pool.get：固定返回 mock 内存在的零件，隔离官方成员（36 件未在 mock 中定义）
      const pool = player.rlv2._pool;
      const getSpy = vi.spyOn(pool, "get").mockReturnValue({
        id: "rogue_6_scrap_G_01",
        count: 1,
      });
      // 获得襁褓巨龙（start_6，zone_into_reward pool_treasure ×3 zone_3）
      await player.rlv2._trigger.emit("rlv2:relic:gain", [
        { id: "rogue_6_start_6", count: 1 },
      ]);
      const scrap = player.rlv2._module.scrap;
      const scrapBefore = Object.keys(scrap.inventory).length;
      // 进入 zone_3（匹配 valueStr "zone_3"，zone:new → map.generate 发 pool_treasure ×3）
      await player.rlv2._trigger.emit("rlv2:zone:new", [3]);
      await new Promise((r) => setTimeout(r, 0));
      // POOL 分支按 count=3 循环抽取发放 → 3 件零件入库
      expect(getSpy).toHaveBeenCalledTimes(3);
      expect(getSpy).toHaveBeenCalledWith("pool_treasure", false);
      expect(Object.keys(scrap.inventory).length).toBe(scrapBefore + 3);
      // 进入 zone_2（不匹配 zone_3）→ 无奖励
      await player.rlv2._trigger.emit("rlv2:zone:new", [2]);
      await new Promise((r) => setTimeout(r, 0));
      expect(getSpy).toHaveBeenCalledTimes(3);
      getSpy.mockRestore();
    });
  });
});
