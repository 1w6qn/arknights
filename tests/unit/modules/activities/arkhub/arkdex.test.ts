/**
 * 奇象巡展 ARKDEX 寻迹玩法单测：属性克制/六维换算、扫描结算（成功/失败）、
 * 道具购买（扣券/库存/每日重置）与使用、交换、保护区解锁。2026-08-17。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEventEmitter } from "@game/kernel/events/runtime";
import type { EventMap } from "@game/kernel/events";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { ArkdexCreature } from "@excel/excel";
import {
  asPlayerManager,
  mockPlayerData,
  mockTypedEventEmitter,
  type MockPlayerDataManager,
} from "../../../../helpers";
import {
  ARKDEX_PROPS,
  arkdexDamageScale,
  arkdexSixStatsToCombat,
  arkhubScanSucceed,
  arkhubScanFail,
  arkhubBuyProp,
  arkhubUseProp,
  arkhubSetTrade,
  arkhubDoTrade,
  arkhubUnlockArea,
  ARKDEX_BAG_MAX,
  arkdexCreature,
  arkdexCreatures,
  arkdexAdvantageName,
  arkdexDamageScaleById,
  arkdexModeRules,
  arkdexEnemySquad,
  arkdexConst,
  arkdexTraits,
  arkdexTraitNames,
  arkdexCreaturesByHabitat,
  arkdexCreaturesByRarity,
  ARKDEX_CAPTURE_SCENES,
  arkdexCaptureAreaToHabitat,
  arkdexBuildEncounterPool,
  arkdexActiveLure,
  arkhubStartEncounter,
  arkhubEndScan,
  arkdexAlterOfMap,
  ARKDEX_MAX_ENCOUNTER,
} from "@game/modules/activities/arkhub/public";

/**
 * ARK_HUB act1arkhub 存档窄视图
 *
 * 用例夹具里这些键都会写入（`hubPlayer` 的默认值 + overrides），而生成类型把 ARK_HUB
 * 子形状声明为全可选；若直接用生成类型，30+ 处断言都要补 `!`。此处声明「夹具保证存在」
 * 的只读视图，仅在 `hubOf` 出口断言一次（视图可赋值给生成类型，属收窄断言，运行期零开销）。
 */
interface ArkHubView {
  coin: number;
  creatureCollected: number;
  activeCreatureCollected: number;
  alterCollected: number;
  dex: {
    [key: string]: { numId?: number; isAlter?: boolean; alterOf?: number; active?: boolean };
  };
  scanBag: { id: number; numId: number; isAlter?: boolean; alterOf?: number; fav?: boolean }[];
  scanSeq: number;
  props: { [key: string]: { count: number; uses: number } };
  propSoldToday: { date: string; sold: { [key: string]: number } };
  trade: { wantSpecies?: number | null; offerNumIds?: number[]; ts?: number };
  unlockedAreas: { [key: string]: number };
  arkdexState: { activeLure?: number; activeEncounter?: { id?: string } };
}

/**
 * 生物表测试视图
 *
 * app 侧 {@link ArkdexCreature} 刻意只声明服务端消费字段（无 hp/atk），而 `arkdex.json`
 * 的原始行带六维；本用例要验证「数据含六维」，故声明带六维的窄视图（视图可赋值给
 * `ArkdexCreature`，断言方向合法；读取的仍是同一对象）。
 */
interface ArkdexCreatureRow extends ArkdexCreature {
  hp: number;
  atk: number;
}

/**
 * 订阅 EventBus 事件并把「载荷元组」交给回调
 *
 * `EventBus.on` 的声明是「展开的载荷参数」，但实现遵循 Emittery 单参约定：监听器实际收到
 * 的是载荷元组本身（生产消费方 `app/game/modules/medal/medal.ts` 即按 `data[0]` 取载荷）。
 * 本助手把该约定显式化：调用点写 `([payload]) => …`，元组类型由 {@link EventMap} 精确给出。
 * @param bus - 事件总线
 * @param name - 事件名
 * @param handler - 接收载荷元组的回调
 */
function hubPlayer(overrides: Partial<ArkHubView> = {}) {
  // 用例只观察事件载荷（Emittery 单参约定：监听器收到载荷元组本身，生产消费方见
  // app/game/modules/medal/medal.ts），不需要 EventBus 的优先级/中间件，故用
  // mockTypedEventEmitter()——其 on 签名即为「单参元组」，与运行期一致、无需 cast。
  const bus = mockTypedEventEmitter();
  const player = mockPlayerData({
    status: { uid: 1, nickName: "T", nickNumber: 0, level: 1, exp: 0 },
    tshop: { shop_act1arkhub: { coin: 500 } },
  });
  // 生成类型 PlayerActivity 把具名 ARK_HUB 成员与 `& { [typeKey: string]: ServerPayload }`
  // 兜底索引签名取交集，而 ARK_HUB 载荷含**对象数组**（scanBag），两层 ServerPayload 装不下，
  // 直接写进种子会被 TS2322 挡住；故夹具经 Object.assign 单点写入（无 cast/无关键字，
  // 运行期与「种子里直接给 activity」等价：同一对象、同一键值）。
  Object.assign(player._playerdata, {
    activity: {
      ARK_HUB: {
        act1arkhub: {
          coin: 500,
          dex: {},
          scanBag: [],
          scanSeq: 0,
          props: {},
          trade: { wantSpecies: null, offerNumIds: [] },
          unlockedAreas: {},
          ...overrides,
        },
      },
    },
  });
  player._trigger = bus;
  return player;
}

/**
 * 取 ARK_HUB act1arkhub 存档视图
 * @param player - mock 组合根
 * @returns 存档窄视图（见 {@link ArkHubView}）
 */
function hubOf(player: MockPlayerDataManager): ArkHubView {
  return player._playerdata.activity.ARK_HUB!.act1arkhub as ArkHubView;
}

describe("属性克制与六维换算", () => {
  it("克制环：奇术→本能→百变→奇术，克制 130%/被克 70%/同级 100%", () => {
    expect(arkdexDamageScale("奇术", "本能")).toBe(1.3);
    expect(arkdexDamageScale("本能", "百变")).toBe(1.3);
    expect(arkdexDamageScale("百变", "奇术")).toBe(1.3);
    expect(arkdexDamageScale("本能", "奇术")).toBe(0.7);
    expect(arkdexDamageScale("百变", "本能")).toBe(0.7);
    expect(arkdexDamageScale("奇术", "百变")).toBe(0.7);
    expect(arkdexDamageScale("奇术", "奇术")).toBe(1.0);
  });

  it("六维换算：进攻×20/守备×2/耐久×100/法抗×0.5/攻速=间隔倒数×10", () => {
    const c = arkdexSixStatsToCombat({ atk: 10, def: 5, hp: 8, mag: 20, atkSpeed: 5, moveSpeed: 1.1 });
    expect(c.attack).toBe(200);
    expect(c.defense).toBe(10);
    expect(c.maxHp).toBe(800);
    expect(c.magicResist).toBe(10);
    expect(c.attackInterval).toBeCloseTo(2); // 10/5
    expect(c.moveSpeed).toBe(1.1);
  });
});

/** ARK_HUB 活动 id（存档字典键，与 app 侧 ARKHUB_ACT_ID 一致） */
const ARKHUB_ACT_ID = "act1arkhub";

describe("扫描结算", () => {
  it("扫描成功：发 15 券 + 币同步 + 数据库收录 + 扫描仪入袋 + 计数事件", async () => {
    const player = hubPlayer();
    const seen: string[] = [];
    const bus = player._trigger as TypedEventEmitter;
    bus.on("ArkhubCreatureCollection", ([payload]) => {
      seen.push(`m:${payload.collectionKey}:${payload.count}`);
    });
    bus.on("ActivityArkhubAlterCollect", ([payload]) => {
      seen.push(`alter:${payload.alterCount}`);
    });

    const ok = await arkhubScanSucceed(asPlayerManager(player), {
      creatureNumIds: [5001, 5002, 5001, 5003],
      alterOf: { 5003: 5001 },
      active: { 5002: true },
    });
    expect(ok).toBe(true);

    const hub = hubOf(player);
    expect(hub.coin).toBe(515);
    expect(player._playerdata.tshop.shop_act1arkhub.coin).toBe(515);
    // dex：3 种（5001/5002/5003），5003 为亚种，5002 活动频繁
    expect(Object.keys(hub.dex)).toHaveLength(3);
    expect(hub.dex["5003"].isAlter).toBe(true);
    expect(hub.dex["5003"].alterOf).toBe(5001);
    expect(hub.dex["5002"].active).toBe(true);
    // 扫描仪：4 个体（重复种类也入袋）
    expect(hub.scanBag).toHaveLength(4);
    expect(hub.scanSeq).toBe(4);
    expect(hub.scanBag[0].fav).toBe(false);
    // 计数：种类 3、活动频繁 1、亚种 1
    expect(hub.creatureCollected).toBe(3);
    expect(hub.activeCreatureCollected).toBe(1);
    expect(hub.alterCollected).toBe(1);
    // 事件：collection1=3、collection2=1（活动频繁）、镀层 alter=1
    expect(seen).toContain("m:arkhubMissionCollection1:3");
    expect(seen).toContain("m:arkhubMissionCollection2:1");
    expect(seen).toContain("alter:1");
  });

  it("扫描失败：无任何奖励与收录", async () => {
    const player = hubPlayer();
    const ok = await arkhubScanSucceed(asPlayerManager(player), { creatureNumIds: [] });
    expect(ok).toBe(false);
    const hub = hubOf(player);
    expect(hub.coin).toBe(500);
    expect(Object.keys(hub.dex)).toHaveLength(0);
    expect(hub.scanBag).toHaveLength(0);
    await arkhubScanFail(asPlayerManager(player)); // 占位函数不抛
  });

  it("扫描仪内存上限 400：满员后不再入袋", async () => {
    const player = hubPlayer({ scanBag: Array.from({ length: ARKDEX_BAG_MAX }, (_, i) => ({ id: i + 1, numId: 5000 })), scanSeq: ARKDEX_BAG_MAX });
    await arkhubScanSucceed(asPlayerManager(player), { creatureNumIds: [5001, 5002] });
    const hub = hubOf(player);
    expect(hub.scanBag).toHaveLength(ARKDEX_BAG_MAX);
    expect(hub.scanSeq).toBe(ARKDEX_BAG_MAX);
  });
});

describe("巡展道具", () => {
  it("购买：扣券 + 道具箱 +生效次数；券不足失败（官方错误码 601）", async () => {
    const player = hubPlayer({ coin: 100 });
    const ok = await arkhubBuyProp(asPlayerManager(player), 5004, 2); // 标准诱引剂 40×2
    expect(ok).toEqual({ ok: true, code: 100 });
    const hub = hubOf(player);
    expect(hub.coin).toBe(20);
    expect(hub.props["5004"]).toEqual({ count: 2, uses: 2 });

    // 券不足（只剩 20，专业 60）→ ITEM_NOT_ENOUGH 601
    const ok2 = await arkhubBuyProp(asPlayerManager(player), 5005);
    expect(ok2).toEqual({ ok: false, code: 601 });
    expect(hubOf(player).coin).toBe(20);
    // 未知道具 → ITEM_ID_INVALID 602
    expect(await arkhubBuyProp(asPlayerManager(player), 9999)).toEqual({ ok: false, code: 602 });
  });

  it("购买：每日库存限购（稀有诱引剂 2），跨日重置；售罄错误码 605", async () => {
    const player = hubPlayer({ coin: 10000 });
    expect(await arkhubBuyProp(asPlayerManager(player), 5006, 2)).toEqual({ ok: true, code: 100 }); // 稀有 250×2 库存 2
    // 库存售罄 → SHOP_ITEM_NOT_ENOUGH 605
    expect(await arkhubBuyProp(asPlayerManager(player), 5006)).toEqual({ ok: false, code: 605 });
    // 模拟跨日：直接改 propSoldToday 日期
    const playerManager = asPlayerManager(player);
    await playerManager.update(async (draft) => {
      draft.activity.ARK_HUB![ARKHUB_ACT_ID].propSoldToday = {
        date: "Sun Aug 16 2026",
        sold: {},
      };
    });
    expect(await arkhubBuyProp(asPlayerManager(player), 5006)).toEqual({ ok: true, code: 100 });
  });

  it("使用：消耗 1 次生效次数；次数耗尽/未知道具回官方错误码 603/602", async () => {
    const player = hubPlayer({ props: { "5004": { count: 1, uses: 1 } } });
    expect(await arkhubUseProp(asPlayerManager(player), 5004)).toEqual({ ok: true, code: 100 });
    expect(hubOf(player).props["5004"].uses).toBe(0);
    // 生效次数耗尽 → ITEM_CAN_NOT_USE 603
    expect(await arkhubUseProp(asPlayerManager(player), 5004)).toEqual({ ok: false, code: 603 });
    // 未知道具 → ITEM_ID_INVALID 602
    expect(await arkhubUseProp(asPlayerManager(player), 9999)).toEqual({ ok: false, code: 602 });
  });
});

describe("数据集换与保护区", () => {
  it("设置交换需求：同时 1 条、可清除", async () => {
    const player = hubPlayer();
    await arkhubSetTrade(asPlayerManager(player), 5001, [5002, 5003]);
    const trade = hubOf(player).trade;
    expect(trade.wantSpecies).toBe(5001);
    expect(trade.offerNumIds).toEqual([5002, 5003]);
    expect(trade.ts).toBeGreaterThan(0); // 挂单时间（GetAll requests 回填的 request_time 数据源）
    await arkhubSetTrade(asPlayerManager(player), null);
    expect(hubOf(player).trade.wantSpecies).toBeNull();
    expect(hubOf(player).trade.offerNumIds).toEqual([]);
  });

  it("发起交换：发 ArkhubCreatureExchange 事件（任务 16）", async () => {
    const player = hubPlayer();
    const seen: string[] = [];
    const bus = player._trigger as TypedEventEmitter;
    bus.on("ArkhubCreatureExchange", ([payload]) => {
      seen.push(payload.activityId);
    });
    await arkhubDoTrade(asPlayerManager(player));
    expect(seen).toEqual(["act1arkhub"]);
  });

  it("保护区解锁：unlockedAreas 标记", async () => {
    const player = hubPlayer();
    await arkhubUnlockArea(asPlayerManager(player), 1);
    expect(hubOf(player).unlockedAreas["1"]).toBe(1);
  });

  it("道具表完整性：16 种道具含价格/类型/定向目标（itemEffectData 实锤）", () => {
    expect(Object.keys(ARKDEX_PROPS)).toHaveLength(16);
    expect(ARKDEX_PROPS[5004]).toMatchObject({ price: 40, type: "lure", targetRarity: 1 });
    expect(ARKDEX_PROPS[5005]).toMatchObject({ type: "lure", targetRarity: 2 });
    expect(ARKDEX_PROPS[5006]).toMatchObject({ price: 250, type: "lure", targetRarity: 3, dailyStock: 2 });
    expect(ARKDEX_PROPS[5014]).toMatchObject({ type: "pheromone", targetRarity: 1 });
    expect(ARKDEX_PROPS[5015]).toMatchObject({ price: 60, type: "pheromone", targetRarity: 2 });
    expect(ARKDEX_PROPS[5016]).toMatchObject({ type: "pheromone", targetRarity: 3 });
    // trait_mask 位掩码（5007=3=焦虑不安|坚韧不屈 … 5011=768=分外记仇|狠毒异常）
    expect(ARKDEX_PROPS[5007].targetTraitMask).toBe(3);
    expect(ARKDEX_PROPS[5008].targetTraitMask).toBe(12);
    expect(ARKDEX_PROPS[5009].targetTraitMask).toBe(48);
    expect(ARKDEX_PROPS[5010].targetTraitMask).toBe(192);
    expect(ARKDEX_PROPS[5011].targetTraitMask).toBe(768);
    expect(ARKDEX_PROPS[5017].targetTraitMask).toBe(3);
    expect(ARKDEX_PROPS[5021].targetTraitMask).toBe(768);
    expect(ARKDEX_PROPS[5004].activeDesc).toContain("珍奇度为1");
  });
});

describe("arkdexModule 数据访问（data/arkhub/arkdex.json 实锤数据）", () => {
  it("生物数据：37 种，含名称/珍奇度/属性/六维/亚种关联", () => {
    const creatures = arkdexCreatures();
    expect(creatures.length).toBe(37);
    const c1 = arkdexCreature(19001) as ArkdexCreatureRow;
    expect(c1.name).toBe("星术绒绒");
    expect(c1.rarity).toBe(3);
    expect(c1.advantageType).toBe("arkdex_advantage_A");
    expect(c1.alterNumId).toBe(19002); // 19002 是 19001 的亚种
    expect(c1.hp).toBeGreaterThan(0);
    expect(c1.atk).toBeGreaterThan(0);
    expect(arkdexCreature(99999)).toBeUndefined();
  });

  it("属性克制：id 映射 + damageScaleMap（克 1.3 / 被克 0.7）", () => {
    expect(arkdexAdvantageName(19001)).toBe("奇术");
    expect(arkdexDamageScaleById("arkdex_advantage_A", "arkdex_advantage_B")).toBe(1.3);
    expect(arkdexDamageScaleById("arkdex_advantage_B", "arkdex_advantage_C")).toBe(1.3);
    expect(arkdexDamageScaleById("arkdex_advantage_C", "arkdex_advantage_A")).toBe(1.3);
    expect(arkdexDamageScaleById("arkdex_advantage_B", "arkdex_advantage_A")).toBe(0.7);
    expect(arkdexDamageScaleById("arkdex_advantage_A", "arkdex_advantage_A")).toBe(1.0);
  });

  it("对决模式规则：快速 2人1轮 / 常规 2人3轮 / 多人 4人1轮", () => {
    const solo = arkdexModeRules("arkdex_singleRound_Solo");
    expect(solo.numPlayers).toBe(2);
    expect(solo.rounds).toBe(1);
    expect(solo.npcCount).toBe(1);
    const bo3 = arkdexModeRules("arkdex_BO3_Solo");
    expect(bo3.rounds).toBe(3);
    const m4 = arkdexModeRules("arkdex_4Player_Solo");
    expect(m4.numPlayers).toBe(4);
    expect(m4.npcCount).toBe(3);
    const match = arkdexModeRules("arkdex_singleRound_Match");
    expect(match.isMatching).toBe(true);
  });

  it("NPC 对决策略敌队：strategy_group_intro = 19005×2 + 19003（苍苔策略组）", () => {
    const squad = arkdexEnemySquad("strategy_group_intro");
    expect(squad.length).toBeGreaterThanOrEqual(3);
    expect(squad[0].creatureNumId).toBe(19005);
    expect(squad.every((e) => e.traitMask > 0)).toBe(true);
    expect(arkdexEnemySquad("no_such_group")).toEqual([]);
  });

  it("ARKDEX 常量：bag 上限 400 / 队伍 3 只 / 稀有度上限 7", () => {
    expect(arkdexConst("arkdexCreatureBagMaxNum")).toBe(400);
    expect(arkdexConst("teamSize")).toBe(3);
    expect(arkdexConst("maxTeamRarityCount")).toBe(7);
  });
});

describe("arkdexModule 活动细节补全（2026-08-18 实锤）", () => {
  it("特质：9 种（traitData），位掩码解析含缺失的焦虑不安（位 0）", () => {
    const traits = arkdexTraits();
    expect(traits).toHaveLength(9);
    expect(traits[0].name).toBe("坚韧不屈");
    expect(traits[0].traitMask).toBe(1);
    expect(traits[8].name).toBe("狠毒异常");
    // 5007 mask=3 = 位0(焦虑不安) + 位1(坚韧不屈)
    expect(arkdexTraitNames(3)).toEqual(["焦虑不安", "坚韧不屈"]);
    // 5010 mask=192 = 位6(暴躁易怒) + 位7(难以捉摸)
    expect(arkdexTraitNames(192)).toEqual(["暴躁易怒", "难以捉摸"]);
    expect(arkdexTraitNames(0)).toEqual([]);
  });

  it("栖息地：3 区按 obtainApproach 分组（密林外沿/晦光林地/奇生保护区）", () => {
    const forest = arkdexCreaturesByHabitat("密林外沿");
    const dark = arkdexCreaturesByHabitat("晦光林地");
    const reserve = arkdexCreaturesByHabitat("奇生保护区");
    expect(forest.length).toBe(12);
    expect(dark.length).toBe(12);
    expect(reserve.length).toBe(13);
    // 三个区域都是"生息于"前缀（obtainApproach）；3★ 生物分布在所有区域
    // （普通区域遭遇限制 1-2★ 是玩法规则，非数据分组——3★ 只在保护区/概率出）
    expect(forest.some((c) => c.rarity === 3)).toBe(true);
    expect(reserve.some((c) => c.rarity === 3)).toBe(true);
    expect(arkdexCreaturesByRarity(3).length).toBe(15);
  });

  it("深层策略组：strategy_group_pve 9 变体 + strategy_group_npc2 敌队（深度查找）", () => {
    const pve = arkdexEnemySquad("strategy_group_pve");
    expect(pve.length).toBeGreaterThanOrEqual(3);
    expect(pve[0].creatureNumId).toBe(19059);
    const npc2 = arkdexEnemySquad("strategy_group_npc2");
    expect(npc2.map((e) => e.creatureNumId)).toEqual([19055, 19056, 19007]);
    // 未知组返回空
    expect(arkdexEnemySquad("no_such_group")).toEqual([]);
  });

  it("NPC 与策略组：苍苔引导战 intro、工作人员 pve、奇象收集师 npc7", () => {
    const intro = arkdexEnemySquad("strategy_group_intro");
    expect(intro.map((e) => e.creatureNumId)).toEqual([19005, 19005, 19003]);
    const npc7 = arkdexEnemySquad("strategy_group_npc7");
    expect(npc7.length).toBeGreaterThanOrEqual(1);
  });

  it("模式规则含野外变体：BO3_Solo_wild（守门人/8/18 野外对决）", () => {
    const wild = arkdexModeRules("arkdex_BO3_Solo_wild");
    expect(wild.rounds).toBe(3);
    expect(wild.numPlayers).toBe(2);
    expect(wild.isMatching).toBe(false);
    // 快速对决 characterLimit=2 一只轮 1 轮
    expect(arkdexModeRules("arkdex_singleRound_Solo")).toMatchObject({ rounds: 1, numPlayers: 2 });
    expect(arkdexModeRules("arkdex_4Player_Solo")).toMatchObject({ rounds: 1, numPlayers: 4, npcCount: 3 });
  });
});

describe("草丛遭遇机制（2026-08-19）", () => {
  /** 密林外沿 CAPTURE 1 场景 map_id（sceneTypeMap） */
  const CAPTURE1 = -820616879;
  /** 密林外沿 12 种生物全部为非 3★（普通栖息地池 1-2★） */
  it("区域→栖息地：CAPTURE 场景直映射，captureAreaData 子区稳定分组", () => {
    expect(ARKDEX_CAPTURE_SCENES[CAPTURE1]).toBe("密林外沿");
    expect(arkdexCaptureAreaToHabitat(CAPTURE1)).toBe("密林外沿");
    expect(arkdexCaptureAreaToHabitat(-820813487)).toBe("晦光林地");
    expect(arkdexCaptureAreaToHabitat(-820747951)).toBe("奇生保护区");
    // captureAreaData 子区 id（-1773187348 等）→ 稳定落入 3 个栖息地之一
    const habitats = [-1773187337, -1773187338, -1773187339, -1773187348].map((id) =>
      arkdexCaptureAreaToHabitat(id),
    );
    expect(habitats.every((h) => ["密林外沿", "晦光林地", "奇生保护区"].includes(h))).toBe(true);
    // 同一 id 结果确定（无随机）
    expect(arkdexCaptureAreaToHabitat(-1773187337)).toBe(arkdexCaptureAreaToHabitat(-1773187337));
  });

  it("遭遇物种池：普通区域仅 1-2★，保护区（解锁）含 3★", () => {
    const normal = arkdexBuildEncounterPool("密林外沿", false);
    expect(normal.length).toBeGreaterThan(0);
    expect(normal.every((c) => (c.rarity ?? 0) <= 2)).toBe(true);
    const protectedPool = arkdexBuildEncounterPool("密林外沿", true);
    expect(protectedPool.length).toBeGreaterThan(normal.length);
    expect(protectedPool.some((c) => c.rarity === 3)).toBe(true);
  });

  it("生成遭遇：个体 1-10、来自栖息地池、群集/单种与暂未收录标记", async () => {
    const player = hubPlayer();
    const enc = await arkhubStartEncounter(asPlayerManager(player), CAPTURE1);
    expect(enc.habitat).toBe("密林外沿");
    expect(enc.areaId).toBe(CAPTURE1);
    expect(enc.isProtected).toBe(false);
    expect(enc.creatures.length).toBeGreaterThanOrEqual(1);
    expect(enc.creatures.length).toBeLessThanOrEqual(ARKDEX_MAX_ENCOUNTER);
    // 普通区域不会出现 3★
    expect(enc.creatures.every((c) => c.rarity <= 2)).toBe(true);
    // 全部来自密林外沿栖息地
    const habitatIds = new Set(arkdexCreaturesByHabitat("密林外沿").map((c) => c.creatureNumId));
    expect(enc.creatures.every((c) => habitatIds.has(c.numId))).toBe(true);
    // 初始 dex 为空 → 全部"暂未收录"
    expect(enc.creatures.every((c) => c.collected === false)).toBe(true);
    // 会话已持久化
    expect(hubOf(player).arkdexState.activeEncounter!.id).toBe(enc.id);
    // 群集标记为布尔（多种类 = 群集，见 forceNumIds 单种用例）
    expect(typeof enc.cluster).toBe("boolean");
  });

  it("保护区（守门人解锁）遭遇可出 3★；珍奇度诱引剂定向稀有度", async () => {
    const player = hubPlayer();
    await arkhubUnlockArea(asPlayerManager(player), CAPTURE1);
    const enc = await arkhubStartEncounter(asPlayerManager(player), CAPTURE1);
    expect(enc.isProtected).toBe(true);
    // 保护区池含 3★（随机可能抽不到，但池子允许）
    expect(enc.creatures.every((c) => c.rarity <= 2 || c.rarity === 3)).toBe(true);
    // 稀有诱引剂 5006（targetRarity=3）：遭遇池强制 3★
    const lureEnc = await arkhubStartEncounter(asPlayerManager(player), CAPTURE1, { lureNumId: 5006 });
    expect(lureEnc.lureNumId).toBe(5006);
    expect(lureEnc.creatures.every((c) => c.rarity === 3)).toBe(true);
  });

  it("显式指定个体（forceNumIds）：信息素强制引出单种生物", async () => {
    const player = hubPlayer();
    const enc = await arkhubStartEncounter(asPlayerManager(player), CAPTURE1, {
      forceNumIds: [19005],
    });
    expect(enc.creatures).toHaveLength(1);
    expect(enc.creatures[0].numId).toBe(19005);
    expect(enc.cluster).toBe(false); // 单种非群集
  });

  it("生效道具：使用后记录 activeLure，生效次数耗尽失效", async () => {
    const player = hubPlayer({ props: { "5004": { count: 1, uses: 1 } } });
    expect(arkdexActiveLure(asPlayerManager(player))).toBeUndefined();
    expect((await arkhubUseProp(asPlayerManager(player), 5004)).ok).toBe(true);
    expect(hubOf(player).arkdexState.activeLure).toBe(5004);
    // uses=0 → 不再生效
    expect(arkdexActiveLure(asPlayerManager(player))).toBeUndefined();
  });

  it("扫描结算成功：发 15 券 + 收录 + 会话清除 + 诱引剂消耗 1 次", async () => {
    const player = hubPlayer({ props: { "5004": { count: 2, uses: 2 } } });
    // 使用诱引剂（uses 2→1）→ 遭遇被定向
    await arkhubUseProp(asPlayerManager(player), 5004);
    const enc = await arkhubStartEncounter(asPlayerManager(player), CAPTURE1);
    expect(enc.lureNumId).toBe(5004);
    expect(hubOf(player).props["5004"].uses).toBe(1);
    // 结算：捕获 19005（密林外沿 1★）
    const result = await arkhubEndScan(asPlayerManager(player), [19005]);
    expect(result.success).toBe(true);
    expect(result.encounter?.id).toBe(enc.id);
    const hub = hubOf(player);
    // 15 券（500 + 15）
    expect(hub.coin).toBe(515);
    // dex 收录 + 扫描仪入袋
    expect(hub.dex["19005"]).toBeDefined();
    expect(hub.scanBag).toHaveLength(1);
    // 诱引剂再消耗 1 次（攻略"每完成一次扫描消耗一次"）uses 1→0
    expect(hub.props["5004"].uses).toBe(0);
    // 会话已清除
    expect(hub.arkdexState.activeEncounter).toBeUndefined();
  });

  it("扫描结算失败：未捕获任何生物 → 无奖励；亚种映射正确", async () => {
    const player = hubPlayer();
    await arkhubStartEncounter(asPlayerManager(player), CAPTURE1);
    const fail = await arkhubEndScan(asPlayerManager(player), []);
    expect(fail.success).toBe(false);
    const hub = hubOf(player);
    expect(hub.coin).toBe(500);
    expect(Object.keys(hub.dex)).toHaveLength(0);
    expect(hub.arkdexState.activeEncounter).toBeUndefined();
    // 亚种映射：19002 是 19001 的亚种（alterNumId）
    expect(arkdexAlterOfMap([19001])).toEqual({});
    expect(arkdexAlterOfMap([19002])).toEqual({ 19002: 19001 });
  });
});
