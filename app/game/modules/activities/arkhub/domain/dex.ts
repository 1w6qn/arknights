/**
 * 奇象巡展 ARKDEX 寻迹玩法（私服扩展，2026-08-17）
 *
 * 承载【奇象寻迹】的服务端状态与玩法函数：巡展道具（诱引剂/信息素）购买与使用、
 * 生物扫描成功/失败结算、数据库收录、扫描仪内存、数据集换、保护区解锁。
 *
 * 数据来源（2026-08-17 实锤：官方数据一直在服务器 excel 里）：
 * - `data/excel/activity_table.json → activity.arkHub.act1arkhub.moduleData.arkdexModule`
 *   含 37 种生物（creatureData）、3 属性克制（advantageTypeData/CounterMap，1.3/0.7）、
 *   10 种对决模式（modeData）、16 种道具（itemEffectData）、9 特质（traitData）、
 *   10 NPC（npcInfoData）、13 组对决策略（npcDuelStrategyData）、12 捕获区（captureAreaData）
 * - 已导出为 `data/arkhub/arkdex.json`（excel.ArkhubCreatureTable 懒加载读取）
 * - 道具价格逆向自官服 ARKDUEL 商店价格表（design-spec §28）；未在价格表的道具价格按同类推断并标注
 * - 六维换算为攻略明文（进攻×20≈攻击、守备×2≈防御、耐久×100≈HP、法抗×0.5、攻速=间隔倒数×10）
 */
import fs from "node:fs";
import { PlayerDataManager } from "../../../../kernel/player-data-manager";
import { ArkdexCreature, ItemBundle } from "@excel/excel";
import excel from "@excel/excel";
import { isJsonArray, isJsonObject, type JsonValue } from "@excel/json-value";
import { logger } from "@utils/logger";
import { ARKHUB_ACT_ID, arkhubCreatureCollected, ARKHUB_ERR } from "./state";
import type { ArkhubState } from "./state";

/** 扫描仪内存上限（ArkdexConstData.arkdexCreatureBagMaxNum） */
export const ARKDEX_BAG_MAX = 400;
/** 单次扫描最多遭遇个体数（攻略：10） */
export const ARKDEX_MAX_ENCOUNTER = 10;
/** 扫描成功奖励：巡展纪念章 ×15（攻略：扫描成功结算 15 券） */
export const ARKDEX_SCAN_REWARD: ItemBundle = {
  id: "act1arkhub_token_seal",
  count: 15,
  type: "ACTIVITY_ITEM",
};

/**
 * 巡展道具定义（itemNumId/名称/单价/类型/每日库存/定向目标）。
 * 名称与效果来自 arkdexModule.itemEffectData（16 种，2026-08-18 复核实锤）：
 * - 5004/5005/5006 珍奇度诱引剂（1★/2★/3★ 遭遇池）、5007-5011 特质诱引剂（trait_mask 定向）
 * - 5014/5015/5016 珍奇度信息素（1★/2★/3★ 直接引出）、5017-5021 特质信息素（trait_mask 定向）
 * 价格逆向自 ARKDUEL 商店价格表 §28（5004/5005/5006/5009/5010/5015/5021 确认），
 * 其余按同类推断（60）并标注。味道名（甜/辣/苦等）仅 §28 确认 3 种，其余为推断展示名。
 * 类型：lure=诱引剂（使用后遭遇目标条件生物）、pheromone=信息素（直接引出生物）。
 */
export interface ArkdexPropDef {
  itemNumId: number;
  name: string;
  price: number;
  /** 每日固定库存（稀有诱引剂 2，其余 5——对齐官服价格表 avail 字段） */
  dailyStock: number;
  type: "lure" | "pheromone";
  /** 定向珍奇度（1/2/3；itemEffectData activeDesc） */
  targetRarity?: number;
  /** 定向特质位掩码（itemEffectData blackboard trait_mask；0/空 = 不按特质定向） */
  targetTraitMask?: number;
  /** 道具效果描述（itemEffectData activeDesc 原文） */
  activeDesc?: string;
}

/** 道具定义（target 字段自 itemEffectData 实锤；价格来源：§28 确认 / 推断标注） */
export const ARKDEX_PROPS: Record<number, ArkdexPropDef> = {
  5004: { itemNumId: 5004, name: "标准诱引剂", price: 40, dailyStock: 99, type: "lure", targetRarity: 1, activeDesc: "生效期间，会遭遇珍奇度为1的生物数据" },
  5005: { itemNumId: 5005, name: "专业诱引剂", price: 60, dailyStock: 99, type: "lure", targetRarity: 2, activeDesc: "生效期间，会遭遇珍奇度为2的生物数据" },
  5006: { itemNumId: 5006, name: "稀有诱引剂", price: 250, dailyStock: 2, type: "lure", targetRarity: 3, activeDesc: "生效期间，会遭遇珍奇度为3的生物数据" },
  5007: { itemNumId: 5007, name: "诱引剂·坚韧", price: 60, dailyStock: 5, type: "lure", targetTraitMask: 3, activeDesc: "生效期间，一定会遭遇焦虑不安或坚韧不屈的生物数据" },
  5008: { itemNumId: 5008, name: "诱引剂·应激", price: 60, dailyStock: 5, type: "lure", targetTraitMask: 12, activeDesc: "生效期间，一定会遭遇时常应激或小心谨慎的生物数据" },
  5009: { itemNumId: 5009, name: "甜味诱引剂", price: 60, dailyStock: 5, type: "lure", targetTraitMask: 48, activeDesc: "生效期间，一定会遭遇天生幸运或活力满满的生物数据" },
  5010: { itemNumId: 5010, name: "辣味诱引剂", price: 60, dailyStock: 5, type: "lure", targetTraitMask: 192, activeDesc: "生效期间，一定会遭遇暴躁易怒或难以捉摸的生物数据" },
  5011: { itemNumId: 5011, name: "诱引剂·记仇", price: 60, dailyStock: 5, type: "lure", targetTraitMask: 768, activeDesc: "生效期间，一定会遭遇分外记仇或狠毒异常的生物数据" },
  5014: { itemNumId: 5014, name: "标准信息素", price: 60, dailyStock: 5, type: "pheromone", targetRarity: 1, activeDesc: "随机引出一只珍奇度为1的生物数据" },
  5015: { itemNumId: 5015, name: "专业信息素", price: 60, dailyStock: 5, type: "pheromone", targetRarity: 2, activeDesc: "随机引出一只珍奇度为2的生物数据" },
  5016: { itemNumId: 5016, name: "稀有信息素", price: 60, dailyStock: 5, type: "pheromone", targetRarity: 3, activeDesc: "随机引出一只珍奇度为3的生物数据" },
  5017: { itemNumId: 5017, name: "信息素·坚韧", price: 60, dailyStock: 5, type: "pheromone", targetTraitMask: 3, activeDesc: "随机引出一只焦虑不安或坚韧不屈的生物数据" },
  5018: { itemNumId: 5018, name: "信息素·应激", price: 60, dailyStock: 5, type: "pheromone", targetTraitMask: 12, activeDesc: "随机引出一只时常应激或小心谨慎的生物数据" },
  5019: { itemNumId: 5019, name: "信息素·幸运", price: 60, dailyStock: 5, type: "pheromone", targetTraitMask: 48, activeDesc: "随机引出一只天生幸运或活力满满的生物数据" },
  5020: { itemNumId: 5020, name: "信息素·易怒", price: 60, dailyStock: 5, type: "pheromone", targetTraitMask: 192, activeDesc: "随机引出一只暴躁易怒或难以捉摸的生物数据" },
  5021: { itemNumId: 5021, name: "苦味信息素", price: 60, dailyStock: 5, type: "pheromone", targetTraitMask: 768, activeDesc: "随机引出一只分外记仇或狠毒异常的生物数据" },
};

/**
 * 属性克制数据（arkdexModule.advantageTypeData / advantageCounterMap 实锤）
 * 克制环：A(奇术)→B(本能)→C(百变)→A(奇术)；克制伤害 130%，被克 70%（damageScaleMap）。
 */
export const ARKDEX_ADVANTAGE_TYPES = ["奇术", "本能", "百变"] as const;
export type ArkdexAdvantageType = (typeof ARKDEX_ADVANTAGE_TYPES)[number];

/** 属性 id ↔ 中文名（advantageTypeData.name） */
export const ARKDEX_ADVANTAGE_ID_NAMES: Record<string, string> = {
  arkdex_advantage_A: "奇术",
  arkdex_advantage_B: "本能",
  arkdex_advantage_C: "百变",
};

/** 克制映射：攻击方属性 → 被克制的目标属性（advantageCounterMap 形状） */
export const ARKDEX_ADVANTAGE_COUNTER: Record<ArkdexAdvantageType, ArkdexAdvantageType> = {
  奇术: "本能",
  本能: "百变",
  百变: "奇术",
};

/** 伤害倍率：damageScaleMap 形状（克 1.3 / 被克 0.7 / 同级 1.0；中文属性名） */
export function arkdexDamageScale(attack: string, defend: string): number {
  if (ARKDEX_ADVANTAGE_COUNTER[attack as ArkdexAdvantageType] === defend) return 1.3;
  if (ARKDEX_ADVANTAGE_COUNTER[defend as ArkdexAdvantageType] === attack) return 0.7;
  return 1.0;
}

/** 伤害倍率（真实属性 id：arkdex_advantage_A/B/C；从 advantageTypeData.damageScaleMap 读） */
export function arkdexDamageScaleById(attackId: string, defendId: string): number {
  const types = excel.ArkhubCreatureTable?.advantageTypeData;
  const scale = types?.[attackId]?.damageScaleMap?.[defendId];
  if (typeof scale === "number") return scale;
  return 1.0;
}

/**
 * 六维 → 战斗数值换算（攻略明文；供 ARKDUEL 结算/客户端数据展示用）
 * 进攻性能×20≈攻击、守备性能×2≈防御、耐久性能×100≈最大生命、法术抗性×0.5≈法抗、
 * 进攻速率≈攻击间隔倒数的 10 倍、移动速度以 1.1 为基准。
 */
export function arkdexSixStatsToCombat(stats: {
  atk?: number; // 进攻性能
  def?: number; // 守备性能
  hp?: number; // 耐久性能
  mag?: number; // 法术抗性
  atkSpeed?: number; // 进攻速率
  moveSpeed?: number; // 移动速度
}): { attack: number; defense: number; maxHp: number; magicResist: number; attackInterval: number; moveSpeed: number } {
  const atk = stats.atk ?? 0;
  const def = stats.def ?? 0;
  const hp = stats.hp ?? 0;
  const mag = stats.mag ?? 0;
  const atkSpeed = stats.atkSpeed ?? 0;
  const moveSpeed = stats.moveSpeed ?? 0;
  return {
    attack: atk * 20,
    defense: def * 2,
    maxHp: hp * 100,
    magicResist: mag * 0.5,
    attackInterval: atkSpeed > 0 ? 10 / atkSpeed : 1,
    moveSpeed,
  };
}

/* ---------- arkdexModule 数据访问（excel.ArkhubCreatureTable = data/arkhub/arkdex.json） ---------- */

/** 生物数据（按 creatureNumId；不存在返回 undefined） */
export function arkdexCreature(numId: number): ArkdexCreature | undefined {
  return excel.ArkhubCreatureTable?.creatureData?.[String(numId)];
}

/** 全部生物列表 */
export function arkdexCreatures(): ArkdexCreature[] {
  return Object.values(excel.ArkhubCreatureTable?.creatureData ?? {});
}

/** 生物属性中文名（advantageType id → 奇术/本能/百变；未知返回原 id） */
export function arkdexAdvantageName(numId: number): string {
  const c = arkdexCreature(numId);
  const advantageType = c?.advantageType ?? "";
  return ARKDEX_ADVANTAGE_ID_NAMES[advantageType] ?? c?.advantageType ?? "";
}

/**
 * 对决模式规则（modeData：快速 singleRound / 常规 BO3 / 多人 4Player）
 * @returns numPlayers（参战人数）、rounds（轮数）、npcCount（NPC 敌数）、isMatching（全服匹配）
 */
export function arkdexModeRules(modeId: string): {
  numPlayers: number;
  rounds: number;
  npcCount: number;
  isMatching: boolean;
  isMultiplayer: boolean;
} {
  const m = excel.ArkhubCreatureTable?.modeData?.[modeId];
  return {
    numPlayers: m?.numMax ?? 2,
    rounds: m?.maxRoundNumber ?? 1,
    npcCount: m?.battleNpcCount ?? 0,
    isMatching: !!m?.isMatching,
    isMultiplayer: !!m?.isMultiplayer,
  };
}

/**
 * NPC 对决策略敌队（npcDuelStrategyData[strategyGroupId].creatureData）
 * 解码怪癖（活动表 FlatBuffers→JSON）：
 * - 简单组（strategy_group_intro/npc2-6）包装为 `{ groupId: {真数据}, 伪键: null }`
 * - 策略池组（strategy_group_1-5/pve/npc7）为 `{ groupId: { strategyId: {真数据}, ... }, 伪键: null }`，
 *   含多个策略变体（tileStrategy/cardStrategy/creatureData/weight）——深度查找首个 creatureData。
 * @returns [{creatureNumId, traitMask}]；未知策略组返回空数组
 */
export function arkdexEnemySquad(strategyGroupId: string): Array<{ creatureNumId: number; traitMask: number }> {
  const group = excel.ArkhubCreatureTable?.npcDuelStrategyData?.[strategyGroupId];
  if (!group) return [];
  return toEnemySquad(findCreatureDataDeep(group));
}

/** 深度优先查找对象树中第一个 JSON 数组（兼容多层解码包装） */
function findCreatureDataDeep(node: JsonValue): JsonValue[] | undefined {
  if (isJsonArray(node)) return node;
  if (isJsonObject(node)) {
    for (const v of Object.values(node)) {
      if (typeof v === "object" && v !== null) {
        const found = findCreatureDataDeep(v);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/**
 * 把深层查找到的 JSON 数组收窄为敌队列表
 *
 * 官方数据每项形如 `{ creatureNumId, traitMask }`；形状不符的项丢弃
 * （traitMask 非数值按 0）。
 */
function toEnemySquad(data: JsonValue[] | undefined): Array<{ creatureNumId: number; traitMask: number }> {
  if (!data) return [];
  const out: Array<{ creatureNumId: number; traitMask: number }> = [];
  for (const entry of data) {
    if (!isJsonObject(entry)) continue;
    const numId = entry.creatureNumId;
    if (typeof numId !== "number") continue;
    const mask = entry.traitMask;
    out.push({ creatureNumId: numId, traitMask: typeof mask === "number" ? mask : 0 });
  }
  return out;
}

/** ARKDEX 常量（dexConstData，如 bag 上限/队伍大小/稀有度上限） */
export function arkdexConst(key: string): number {
  const v = excel.ArkhubCreatureTable?.dexConstData?.[key];
  return typeof v === "number" ? v : 0;
}

/**
 * 特质数据（traitData；key 1-9 对应 trait_2..trait_10，trait_1"焦虑不安"数据缺失但存在于
 * 道具 trait_mask 位 0）。traitMask 字段为展示序号（1-9），非位掩码——道具定向用位掩码
 * （5007=3=位0|位1=焦虑不安|坚韧不屈）。
 * @returns [{traitId, name, description, traitMask}] 按 key 排序
 */
export function arkdexTraits(): Array<{ traitId: string; name: string; description: string; traitMask: number }> {
  const td = excel.ArkhubCreatureTable?.traitData ?? {};
  return Object.values(td).map((v) => ({
    traitId: v.traitId ?? "",
    name: v.name ?? "",
    description: v.description ?? "",
    traitMask: v.traitMask ?? 0,
  }));
}

/** 位掩码 → 特质名列表（道具定向 targetTraitMask 解析；位 0=焦虑不安，位 n=traitData[n]） */
export function arkdexTraitNames(mask: number): string[] {
  if (!mask) return [];
  const names: string[] = [];
  if (mask & 1) names.push("焦虑不安");
  const traits = arkdexTraits();
  for (let bit = 1; bit <= 9; bit++) {
    if (mask & (1 << bit)) {
      names.push(traits[bit - 1]?.name ?? `特质${bit + 1}`);
    }
  }
  return names;
}

/** 栖息地（obtainApproach 取值；普通栖息地开放 1-2★，保护区可出 3★） */
export const ARKDEX_HABITATS = ["密林外沿", "晦光林地", "奇生保护区"] as const;
export type ArkdexHabitat = (typeof ARKDEX_HABITATS)[number];

/** 按栖息地筛选生物（obtainApproach 形如"生息于密林外沿"，前缀匹配；供扫描遭遇按区域选生物池） */
export function arkdexCreaturesByHabitat(habitat: string): ArkdexCreature[] {
  return arkdexCreatures().filter((c) => (c?.obtainApproach ?? "").includes(habitat));
}

/** 按珍奇度筛选生物（普通栖息地 1-2★；保护区含 3★） */
export function arkdexCreaturesByRarity(rarity: number): ArkdexCreature[] {
  return arkdexCreatures().filter((c) => c?.rarity === rarity);
}

/** 读 ARK_HUB 状态（update 配方外只读） */
function hub(player: PlayerDataManager): ArkhubState | undefined {
  return player._playerdata.activity?.ARK_HUB?.[ARKHUB_ACT_ID];
}

/** 发放 token_seal（入背包 + coin/tshop 同步，复用 arkhub.ts 内部形状） */
async function grantSeal(player: PlayerDataManager, reward: ItemBundle): Promise<void> {
  await player.update(async (draft) => {
    const h = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (h) h.coin = (h.coin ?? 0) + reward.count;
    const shop = draft.tshop?.["shop_act1arkhub"];
    if (shop) shop.coin = (shop.coin ?? 0) + reward.count;
  });
  await player.gainItem.add(reward).handle();
}

/**
 * 数据库收录辅助：按 dex 重新计算种类/活动频繁/亚种计数并发射任务+勋章事件。
 * dex 形状：{ [speciesKey]: { numId, isAlter, active? } }——isAlter 标记亚种记录
 * （亚种种类与本体是不同记录，镀层按亚种记录数计），active 标记"活动频繁"生物
 * （任务 12-14 的 arkhubMissionCollection2）。
 */
export async function arkhubDexRecount(player: PlayerDataManager): Promise<void> {
  const d = hub(player)?.dex ?? {};
  const entries = Object.values(d) as Array<{ isAlter?: boolean; active?: boolean }>;
  const count = entries.length;
  const alterCount = entries.filter((e) => e.isAlter).length;
  const activeCount = entries.filter((e) => e.active).length;
  await player.update(async (draft) => {
    const h = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!h) return;
    h.creatureCollected = count;
    h.activeCreatureCollected = activeCount;
    h.alterCollected = alterCount;
  });
  await arkhubCreatureCollected(player, { count, activeCount, alterCount });
}

/**
 * 扫描成功结算（攻略：扫描至少 1 个生物即成功，结算 15 券 + 个体数据入库）
 * @param creatureNumIds - 本次扫描捕获的生物种类 id 列表（去重由调用方保证）
 * @param alterOf - 亚种映射（{ [creatureNumId]: 本体种类 id }，非亚种不传）
 * @param active - 活动频繁标记（{ [creatureNumId]: boolean }）
 * @returns 是否成功（空列表 = 扫描失败）
 */
export async function arkhubScanSucceed(
  player: PlayerDataManager,
  args: {
    creatureNumIds: number[];
    alterOf?: Record<number, number>;
    active?: Record<number, boolean>;
  },
): Promise<boolean> {
  const { creatureNumIds } = args;
  if (!creatureNumIds || creatureNumIds.length === 0) {
    logger.info("arkdex", "扫描失败（未捕获任何生物）——无结算奖励");
    return false;
  }
  await grantSeal(player, ARKDEX_SCAN_REWARD);
  await player.update(async (draft) => {
    const h = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!h) return;
    h.dex = h.dex ?? {};
    h.scanBag = h.scanBag ?? [];
    h.scanSeq = h.scanSeq ?? 0;
    for (const numId of creatureNumIds.slice(0, ARKDEX_MAX_ENCOUNTER)) {
      const key = String(numId);
      if (!h.dex[key]) {
        h.dex[key] = {
          numId,
          isAlter: !!args.alterOf?.[numId],
          ...(args.alterOf?.[numId] ? { alterOf: args.alterOf[numId] } : {}),
          ...(args.active?.[numId] ? { active: true } : {}),
        };
      }
      if (h.scanBag.length >= ARKDEX_BAG_MAX) break; // 内存满：不再入袋
      h.scanSeq += 1;
      h.scanBag.push({
        id: h.scanSeq,
        numId,
        isAlter: !!args.alterOf?.[numId],
        ...(args.alterOf?.[numId] ? { alterOf: args.alterOf[numId] } : {}),
        fav: false,
        sourceUid: draft.status?.uid ?? "",
      });
    }
  });
  await arkhubDexRecount(player);
  logger.info("arkdex", `扫描成功: ${creatureNumIds.length} 只入库，+15 券`);
  return true;
}

/** 扫描失败（什么都不获得；事件占位——任务无失败计数） */
export async function arkhubScanFail(_player: PlayerDataManager): Promise<void> {
  // 攻略：扫描失败结算时什么都不会获得（无券、无个体数据）
}

/**
 * 信息素诱引生物扫描（任务 15 ArkhubCreatureCaptured）
 * 攻略：信息素引出的生物广播给区域内所有游客，每位游客最多扫 1 次；
 * 私服单机简化：调用即视为完成一次信息素扫描。
 */
export async function arkhubPheromoneScan(player: PlayerDataManager): Promise<void> {
  await player._trigger.emit("ArkhubCreatureCaptured", [{ activityId: ARKHUB_ACT_ID }]);
}

/**
 * 购买巡展道具（ARKDUEL 商店；扣 coin → 道具箱 +生效次数）
 * 攻略：所有工作人员共享库存、每日刷新；诱引剂/信息素使用后消耗生效次数，
 * 离开会场不清除。
 * @param count - 购买数量（缺省 1）
 * @returns { ok, code }——code 为 ActArkhubErrorCode 官方错误码（券不足 601 /
 * 库存不足 605 / 未知道具 602），客户端据此弹对应文案提示（反编译消费链路实锤）。
 */
export async function arkhubBuyProp(
  player: PlayerDataManager,
  itemNumId: number,
  count: number = 1,
): Promise<{ ok: boolean; code: number }> {
  const def = ARKDEX_PROPS[itemNumId];
  if (!def || count < 1) return { ok: false, code: ARKHUB_ERR.ITEM_ID_INVALID };
  const totalPrice = def.price * count;
  const h = hub(player);
  if ((h?.coin ?? 0) < totalPrice) return { ok: false, code: ARKHUB_ERR.ITEM_NOT_ENOUGH };
  // 库存限购（按自然日，跨日重置——简化：每日首购清零记录）
  const today = new Date().toDateString();
  let ok = false;
  let stockShort = false;
  await player.update(async (draft) => {
    const hh = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hh) return;
    const stockKey = `${itemNumId}`;
    // 每日售出记录：跨日重置（sold 与 hh.propSoldToday 始终指向同一对象）
    let sold = hh.propSoldToday;
    if (sold?.date !== today) {
      sold = hh.propSoldToday = { date: today, sold: {} };
    }
    const soldCount = sold.sold?.[stockKey] ?? 0;
    if (soldCount + count > def.dailyStock) {
      stockShort = true; // 库存不足（共享库存每日刷新，官码 SHOP_ITEM_NOT_ENOUGH）
      return;
    }
    hh.coin = (hh.coin ?? 0) - totalPrice;
    const shop = draft.tshop?.["shop_act1arkhub"];
    if (shop) shop.coin = Math.max(0, (shop.coin ?? 0) - totalPrice);
    hh.props = hh.props ?? {};
    const p = (hh.props[stockKey] = hh.props[stockKey] ?? { count: 0, uses: 0 });
    p.count += count;
    p.uses += count; // 诱引剂/信息素：每次使用消耗 1 次生效次数
    sold.sold[stockKey] = soldCount + count;
    ok = true;
  });
  if (ok) {
    logger.info("arkdex", `购买道具 ${def.name}×${count}（单价 ${def.price}）`);
    return { ok: true, code: ARKHUB_ERR.OK };
  }
  return { ok: false, code: stockShort ? ARKHUB_ERR.SHOP_ITEM_NOT_ENOUGH : ARKHUB_ERR.ITEM_NOT_ENOUGH };
}

/**
 * 使用巡展道具（消耗 1 次生效次数 + 记录为生效道具）
 *
 * 道具箱点击"使用"= 激活一次：消耗 1 次生效次数，并把该道具记为当前生效道具
 * （草丛遭遇/信息素引出按此定向遭遇池——珍奇度诱引剂强制该稀有度、信息素强制引出）。
 * 扫描结算时每完成一次扫描再消耗 1 次（arkhubEndScan 复用本函数；攻略"每完成一次
 * 扫描消耗一次生效次数"）。
 *
 * @returns { ok, code }——code 为官方错误码（未知道具 602 / 未持有或生效次数耗尽 603；
 * 扣减在 update 内完成），客户端据此弹对应文案提示。
 */
export async function arkhubUseProp(
  player: PlayerDataManager,
  itemNumId: number,
): Promise<{ ok: boolean; code: number }> {
  const def = ARKDEX_PROPS[itemNumId];
  if (!def) return { ok: false, code: ARKHUB_ERR.ITEM_ID_INVALID };
  const key = String(itemNumId);
  let ok = false;
  await player.update(async (draft) => {
    const hh = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    const p = hh?.props?.[key];
    if (!p || (p.uses ?? 0) < 1) return;
    p.uses -= 1;
    // 记录生效道具（草丛遭遇/信息素引出按此定向遭遇池）
    hh.arkdexState = hh.arkdexState ?? {};
    hh.arkdexState.activeLure = itemNumId;
    ok = true;
  });
  if (ok) {
    logger.info("arkdex", `使用道具 ${def.name}（剩余生效次数 ${hub(player)?.props?.[key]?.uses ?? 0}）`);
    return { ok: true, code: ARKHUB_ERR.OK };
  }
  return { ok: false, code: ARKHUB_ERR.ITEM_CAN_NOT_USE };
}

/**
 * 设置交换需求（数据仪-交换站；攻略：只能指定想要的生物种类、同时 1 条）
 * @param wantSpecies - 想要的生物种类 id（null = 清除需求）
 * @param offerNumIds - 准备交换出去的生物个体种类列表（个体 unique_id）
 */
export async function arkhubSetTrade(
  player: PlayerDataManager,
  wantSpecies: number | null,
  offerNumIds: number[] = [],
): Promise<void> {
  await player.update(async (draft) => {
    const h = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!h) return;
    h.trade = {
      wantSpecies: wantSpecies === null ? null : Number(wantSpecies),
      offerNumIds: offerNumIds ?? [],
      ts: Date.now(), // 挂单时间（CreatureExchangeRequest.request_time 数据源）
    };
  });
}

/**
 * 发起/完成一次生物数据交换（任务 16 ArkhubCreatureExchange）
 * 私服单机简化：调用即视为发起 1 次交换（来源游客留空，交换站仅 1 条需求）。
 */
export async function arkhubDoTrade(player: PlayerDataManager): Promise<void> {
  await player._trigger.emit("ArkhubCreatureExchange", [{ activityId: ARKHUB_ACT_ID }]);
}

/**
 * 当日货架生成（攻略 + 08-16/08-18/08-23 三日官服样本实锤轮换）：固定 5004/5005/5006 +
 * 味道诱引剂（5007-5011）随机 2 + 信息素（5014-5021）随机 2。确定性按日种子：
 * 同日多次调用结果一致，价格表与购买校验无需持久化即保持一致（落盘另见
 * arkhubPersistShopToday）。
 */
const DUEL_SHOP_FIXED = [5004, 5005, 5006];
const DUEL_SHOP_FLAVOR_POOL = [5007, 5008, 5009, 5010, 5011];
const DUEL_SHOP_PHEROMONE_POOL = [5014, 5015, 5016, 5017, 5018, 5019, 5020, 5021];

/** 确定性伪随机（LCG，仅用于每日货架抽取——非密码学用途） */
function seededNext(seed: { s: number }): number {
  seed.s = (Math.imul(seed.s, 1664525) + 1013904223) >>> 0;
  return seed.s / 0x100000000;
}

/** 从池中按种子确定性抽 n 个（同种子结果稳定） */
function seededPick(pool: number[], n: number, seed: { s: number }): number[] {
  const rest = [...pool];
  const out: number[] = [];
  while (out.length < n && rest.length > 0) {
    out.push(rest.splice(Math.floor(seededNext(seed) * rest.length), 1)[0]);
  }
  return out;
}

/** 当日货架道具 numId（7 件：固定 3 + 味道 2 + 信息素 2，按自然日确定性） */
export function arkhubDailyShopIds(): number[] {
  const dateKey = new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (const ch of dateKey) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  const seed = { s: hash || 1 };
  return [
    ...DUEL_SHOP_FIXED,
    ...seededPick(DUEL_SHOP_FLAVOR_POOL, 2, seed),
    ...seededPick(DUEL_SHOP_PHEROMONE_POOL, 2, seed),
  ];
}

/**
 * 当日货架落盘（hub.shopToday={date, ids}）：保证商店价格表与购买校验读同一份货架。
 * 生成规则为按日确定性种子（网关侧同算法），落盘值与生成值一致；跨日后网关侧重新生成并覆盖。
 * @param ids - 当日货架道具 numId（7 件：固定 3 + 味道 2 + 信息素 2）
 */
export async function arkhubPersistShopToday(
  player: PlayerDataManager,
  ids: number[],
): Promise<void> {
  const dateKey = new Date().toISOString().slice(0, 10);
  await player.update(async (draft) => {
    const h = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!h) return;
    h.shopToday = { date: dateKey, ids: ids.map(Number) };
  });
}

/** 同步读当日货架（仅当落盘日期=今日时返回；否则 undefined，调用方回确定性生成） */
export function arkhubShopTodayIds(player: PlayerDataManager): number[] | undefined {
  const h = hub(player);
  const st = h?.shopToday;
  if (st?.date === new Date().toISOString().slice(0, 10) && Array.isArray(st.ids)) {
    return st.ids.map(Number);
  }
  return undefined;
}

/**
 * 保护区解锁（攻略：与守门人的奇象拟合对战中获胜开放，含珍奇度 3 个体）
 * @param areaId - 保护区 area id（captureAreaData 键；私服用 CAPTURE 场景序数 1/2/3）
 */
export async function arkhubUnlockArea(
  player: PlayerDataManager,
  areaId: number | string,
): Promise<void> {
  await player.update(async (draft) => {
    const h = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!h) return;
    h.unlockedAreas = h.unlockedAreas ?? {};
    h.unlockedAreas[String(areaId)] = 1;
  });
  logger.info("arkdex", `保护区解锁: area=${areaId}`);
}

/* ============ 草丛遭遇机制（ARKDEX 遭遇生成 + 扫描会话，2026-08-19） ============
 *
 * 草丛遭遇 = 在捕抓区栖息地走动的随机遭遇 + 扫描（作战式）结算。
 * 服务端职责（攻略对齐）：
 * - 遭遇生成：按栖息地物种池 + 珍奇度门控（普通区域仅 1-2★ / 保护区解锁含 3★）+
 *   生效道具定向（珍奇度诱引剂强制稀有度、信息素强制引出）+ 活动频繁加成，
 *   随机 1-10 只（ARKDEX_MAX_ENCOUNTER），3★ 加权降频"有概率出现"
 * - 群集/单种预览：群集 = 本次遭遇个体种类不一（含亚种，无法确认具体种类）；
 *   单种 = 本次遭遇个体都是该种；预览附带"暂未收录"（collected=false）标记
 * - 扫描结算：扫描成功 15 券 + 个体数据入库（arkhubScanSucceed），失败无奖励；
 *   诱引剂每完成一次扫描消耗 1 次生效次数（复用 arkhubUseProp）
 *
 * 传输层（2026-08-27 实锤接线）：官方帧 subID 已由抓包 + 反编译双重确认——
 * StartCaptureReq(b7c267d7) / EndCaptureReq(b7c204e8) / EncounterCreatureNotify(b7c20f13)，
 * 经本地网关（gateway/handlers/play.ts）接 index.ts 回调：onScanStart 同步返回遭遇、
 * onScanSettle 结算；帧形状差异表见 docs/arkhub-gateway-protocol.md §12。
 */

/** 捕抓区 CAPTURE 场景 map_id → 栖息地（sceneTypeMap：CAPTURE 1/2/3 = 三栖息地） */
export const ARKDEX_CAPTURE_SCENES: Record<number, ArkdexHabitat> = {
  [-820616879]: "密林外沿", // CAPTURE 1
  [-820813487]: "晦光林地", // CAPTURE 2
  [-820747951]: "奇生保护区", // CAPTURE 3
};

/** 保护区栖息地（攻略：守门人拟合胜利开放，可遇珍奇度 3 个体；解锁按捕获区 id 判定） */
export const ARKDEX_PROTECTED_HABITAT: ArkdexHabitat = "奇生保护区";

/** 遭遇个体（扫描会话中的一只生物） */
export interface ArkdexEncounterCreature {
  /** 生物种类 id（creatureNumId） */
  numId: number;
  /** 生物名（群集预览对客户端隐藏具体种类，服务端留存用于结算） */
  name: string;
  /** 珍奇度 1-3★ */
  rarity: number;
  /** 亚种个体（creatureData.alterNumId > 0） */
  isAlter: boolean;
  /** 活动频繁（upWeightTagIsShow / dex.active，任务 12-14） */
  active: boolean;
  /** 已收录数据库（预览"暂未收录"标记用） */
  collected: boolean;
}

/** 一次草丛遭遇（服务端生成的遭遇 = 扫描会话） */
export interface ArkdexEncounter {
  /** 遭遇 id（扫描会话标识） */
  id: string;
  /** 捕获区 id（scene map_id 或 captureAreaData 子区 id） */
  areaId: number | string;
  /** 栖息地 */
  habitat: ArkdexHabitat;
  /** 保护区（守门人解锁，遭遇池含 3★） */
  isProtected: boolean;
  /** 群集（预览不显示具体种类）还是单种 */
  cluster: boolean;
  /** 生效道具（诱引剂/信息素，定向了本次遭遇池） */
  lureNumId?: number;
  /** 实际遭遇个体（1-10） */
  creatures: ArkdexEncounterCreature[];
}

/**
 * 捕获区/场景 → 栖息地
 * scene map_id 直映射（CAPTURE 1/2/3）；captureAreaData 子区 id（12 个）按哈希
 * 稳定分组到 3 栖息地（官方无区域→栖息地映射，私服按此确定性分组）。
 */
export function arkdexCaptureAreaToHabitat(areaIdOrMapId: number | string): ArkdexHabitat {
  const key = Number(areaIdOrMapId);
  const direct = ARKDEX_CAPTURE_SCENES[key];
  if (direct) return direct;
  const idx = Math.abs(key) % ARKDEX_HABITATS.length;
  return ARKDEX_HABITATS[idx];
}

/**
 * 按栖息地构建遭遇物种池（普通区域仅 1-2★；保护区解锁后含 3★——攻略明文）
 */
export function arkdexBuildEncounterPool(habitat: ArkdexHabitat, isProtected: boolean): ArkdexCreature[] {
  return arkdexCreaturesByHabitat(habitat).filter(
    (c) => isProtected || (c?.rarity ?? 0) <= 2,
  );
}

/** 当前生效道具（最近使用且仍有生效次数的 lure/pheromone；无则 undefined） */
export function arkdexActiveLure(player: PlayerDataManager): number | undefined {
  const h = hub(player);
  const active = h?.arkdexState?.activeLure;
  if (active == null) return undefined;
  const p = h?.props?.[String(active)];
  if (!p || (p.uses ?? 0) < 1) return undefined;
  return active;
}

/** 加权随机选 count 个生物（3★ 权重 0.3 实现保护区"有概率出现"） */
function pickWeighted(pool: ArkdexCreature[], count: number): ArkdexCreature[] {
  const remaining = [...pool];
  const picked: ArkdexCreature[] = [];
  for (let n = 0; n < count && remaining.length > 0; n++) {
    const weights = remaining.map((c) => ((c?.rarity ?? 1) >= 3 ? 0.3 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < remaining.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        chosen = i;
        break;
      }
    }
    picked.push(remaining[chosen]);
    remaining.splice(chosen, 1);
  }
  return picked;
}

/**
 * 生成一次草丛遭遇（开启扫描会话）
 *
 * 遭遇个体随机 1-10（ARKDEX_MAX_ENCOUNTER），按栖息地 + 珍奇度门控 + 生效道具定向；
 * 群集 = 多种类（含亚种），单种 = 同类。遭遇写入 ARK_HUB.arkdexState.activeEncounter
 * （幂等覆盖），作为扫描会话待结束结算。
 *
 * @param areaIdOrMapId - 捕获区 id（scene map_id 或 captureAreaData 子区 id）
 * @param opts - lureNumId 强制指定生效道具（缺省取当前生效道具）；
 *               forceNumIds 显式指定遭遇个体（供单测/信息素强制引出）
 * @returns 遭遇记录（含实际个体；已持久化为当前扫描会话）
 */
export async function arkhubStartEncounter(
  player: PlayerDataManager,
  areaIdOrMapId: number | string,
  opts: { lureNumId?: number; forceNumIds?: number[] } = {},
): Promise<ArkdexEncounter> {
  const habitat = arkdexCaptureAreaToHabitat(areaIdOrMapId);
  const h = hub(player);
  const isProtected = !!h?.unlockedAreas?.[String(areaIdOrMapId)];
  const lureNumId = opts.lureNumId ?? arkdexActiveLure(player);
  const def = lureNumId ? ARKDEX_PROPS[lureNumId] : undefined;

  let pool: ArkdexCreature[];
  if (opts.forceNumIds && opts.forceNumIds.length > 0) {
    pool = opts.forceNumIds
      .map((id) => arkdexCreature(id))
      .filter((c): c is ArkdexCreature => c !== undefined);
  } else {
    pool = arkdexBuildEncounterPool(habitat, isProtected);
    // 珍奇度诱引剂/信息素：定向遭遇池到目标稀有度
    const targetRarity = def?.targetRarity;
    if (targetRarity) pool = pool.filter((c) => c.rarity === targetRarity);
    // 特质定向（targetTraitMask）：生物数据无 trait 字段，无法过滤——保持池不变（记录道具）
    if (pool.length === 0) pool = arkdexBuildEncounterPool(habitat, isProtected);
  }

  const count = Math.min(
    ARKDEX_MAX_ENCOUNTER,
    Math.max(1, Math.floor(Math.random() * ARKDEX_MAX_ENCOUNTER) + 1),
  );
  const picked = pickWeighted(pool, count);
  const dex = h?.dex ?? {};
  const creatures: ArkdexEncounterCreature[] = picked.map((c) => ({
    numId: c.creatureNumId,
    name: c.name,
    rarity: c.rarity,
    isAlter: arkdexIsAlter(c.creatureNumId),
    active: !!c.upWeightTagIsShow,
    collected: !!dex[String(c.creatureNumId)],
  }));
  const species = new Set(creatures.map((c) => c.numId));
  const encounter: ArkdexEncounter = {
    id: `enc_${Date.now()}_${Math.floor(Math.random() * 0xffffff).toString(16)}`,
    areaId: areaIdOrMapId,
    habitat,
    isProtected,
    cluster: species.size > 1 || creatures.some((c) => c.isAlter),
    ...(lureNumId ? { lureNumId } : {}),
    creatures,
  };
  await arkhubRecordEncounter(player, encounter);
  return encounter;
}

/** 记录当前遭遇（扫描会话），幂等覆盖 */
export async function arkhubRecordEncounter(
  player: PlayerDataManager,
  encounter: ArkdexEncounter,
): Promise<void> {
  await player.update(async (draft) => {
    const hh = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hh) return;
    hh.arkdexState = hh.arkdexState ?? {};
    hh.arkdexState.activeEncounter = encounter;
  });
}

/**
 * 亚种判定：该物种是否为亚种（某基种的 alterNumId 指向的 `_2` 变体，如 19002 奥术绒绒）
 * 数据语义：基种（19001 星术绒绒）alterNumId=19002 → 其亚种是 19002；亚种自身 alterNumId=0。
 */
export function arkdexIsAlter(numId: number): boolean {
  return arkdexCreatures().some((c) => c?.alterNumId === numId);
}

/** 亚种 → 本体种类 id（该物种被谁引为亚种；非亚种返回 undefined） */
export function arkdexAlterBase(numId: number): number | undefined {
  const c = arkdexCreatures().find((x) => x?.alterNumId === numId);
  return c?.creatureNumId;
}

/**
 * 亚种映射：{ [numId]: 本体种类 id }（仅收录亚种本身；基种不映射）
 * 如 [19002] → { 19002: 19001 }（奥术绒绒 是 星术绒绒 的亚种）；[19001] → {}。
 */
export function arkdexAlterOfMap(numIds: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const id of numIds) {
    const base = arkdexAlterBase(id);
    if (base) out[id] = base;
  }
  return out;
}

/**
 * 活动频繁（upWeightTagIsShow）私服降级覆盖表（data/arkhub/active-weights.json）。
 * 官方语义为网关服务端动态下发——本地 excel 全 false、现存抓包无样本，无法还原；
 * 私服用本地确定性标记供任务 12-14（收集 N 种活动频繁生物）可推进（懒加载 + 缓存）。
 */
let activeOverrideCache: Set<number> | undefined;
function arkdexActiveOverride(): Set<number> {
  if (activeOverrideCache) return activeOverrideCache;
  let ids: number[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync("./data/arkhub/active-weights.json", "utf8"));
    ids = Array.isArray(raw?.activeNumIds) ? raw.activeNumIds.map(Number) : [];
  } catch (e) {
    logger.debug("arkdex", `活动频繁覆盖表读取失败（降级为空）: ${(e as Error).message}`);
  }
  activeOverrideCache = new Set(ids.filter((n: number) => Number.isFinite(n)));
  return activeOverrideCache;
}

/**
 * 活动频繁映射：{ [numId]: true }（creatureData.upWeightTagIsShow 优先；本地全 false 时
 * 回落私服降级覆盖表 active-weights.json——官服语义未确认，见文件内注释）。
 */
export function arkdexActiveMap(numIds: number[]): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  const override = arkdexActiveOverride();
  for (const id of numIds) {
    const c = arkdexCreature(id);
    if (c?.upWeightTagIsShow || override.has(id)) out[id] = true;
  }
  return out;
}

/**
 * 结束扫描（扫描结算）
 *
 * 攻略：扫描至少 1 个生物即成功——结算 15 券 + 个体数据入库（arkhubScanSucceed）；
 * 未扫描到任何生物视为失败，什么都不获得（arkhubScanFail）。
 * 本次遭遇被诱引剂/信息素定向时，结算消耗 1 次生效次数（攻略"每完成一次扫描
 * 消耗一次"）；扫描会话结束后清除（遭遇为一次性）。
 *
 * @param capturedNumIds - 本次扫描捕获的生物种类 id 列表（空 = 失败）
 * @returns { success, encounter }——是否成功 + 本次遭遇（供前端展示）
 */
export async function arkhubEndScan(
  player: PlayerDataManager,
  capturedNumIds: number[],
): Promise<{ success: boolean; encounter?: ArkdexEncounter }> {
  const h = hub(player);
  // 玩家存档里的 arkdexState 是未建模 JSON 槽位（ServerPayload 域）——写入方
  // arkhubRecordEncounter 存的是 ArkdexEncounter，读回时按该形状收窄。
  const enc = h?.arkdexState?.activeEncounter as ArkdexEncounter | undefined;
  const ids = Array.isArray(capturedNumIds)
    ? capturedNumIds.map(Number).filter((n) => Number.isFinite(n))
    : [];
  // 诱引剂消耗：本次遭遇被道具定向 → 完成一次扫描消耗 1 次生效次数
  if (enc?.lureNumId) {
    await arkhubUseProp(player, enc.lureNumId);
  }
  // 清除扫描会话（遭遇为一次性）
  await player.update(async (draft) => {
    const hh = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (hh?.arkdexState) delete hh.arkdexState.activeEncounter;
  });
  if (ids.length === 0) {
    await arkhubScanFail(player);
    return { success: false, ...(enc ? { encounter: enc } : {}) };
  }
  const ok = await arkhubScanSucceed(player, {
    creatureNumIds: ids,
    alterOf: arkdexAlterOfMap(ids),
    active: arkdexActiveMap(ids),
  });
  return { success: ok, ...(enc ? { encounter: enc } : {}) };
}
