/**
 * 活动路由：act1vhalfidle（由 router/activity.ts 拆分而来，实现未改动）
 */
import { miniBattleStart, miniBattleFinish } from "../shared/shared";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { now } from "@utils/time";
import { rarityToIndex } from "@utils/rarity";
import excel from "@excel/excel";
import {
  VHALFIDLE_ACT_ID,
  VHalfIdleConfig,
  VHalfIdleGachaPool,
  gachaCost,
  stageProductionRate,
  vhalfidleConfig,
  vhalfidleItemId,
} from "./config";
import {
  ActCheckinvsSignRequest,
  ActCheckinvsSignResponse,
  AutoConfirmMissionsRequest,
  AutoConfirmMissionsResponse,
  ChangeFestivalCharRequest,
  ChangeFestivalCharResponse,
  ConfirmActivityMissionGroupRequest,
  ConfirmActivityMissionGroupResponse,
  ConfirmActivityMissionListRequest,
  ConfirmActivityMissionListResponse,
  ConfirmActivityMissionRequest,
  ConfirmActivityMissionResponse,
  ExchangeActivityShopItemRequest,
  ExchangeActivityShopItemResponse,
  GetActivityCheckInRewardRequest,
  GetActivityCheckInRewardResponse,
  GetActivityCollectionRewardRequest,
  GetActivityCollectionRewardResponse,
  GetActivityShopInfoRequest,
  GetActivityShopInfoResponse,
  GetChainLogInFinalRewardsRequest,
  GetChainLogInFinalRewardsResponse,
  GetChainLogInRewardRequest,
  GetChainLogInRewardResponse,
  GetCheckInRewardRequest,
  GetCheckInRewardResponse,
  GetOpenServerCheckInRewardRequest,
  GetOpenServerCheckInRewardResponse,
  GetSwitchOnlyRewardRequest,
  GetSwitchOnlyRewardResponse,
  RecycleCharmsRequest,
  RecycleCharmsResponse,
  RewardAllMilestoneRequest,
  RewardAllMilestoneResponse,
  RewardMilestoneRequest,
  RewardMilestoneResponse,
  TryGetCharmFirstRewardRequest,
  TryGetCharmFirstRewardResponse,
  BossRushStartBattleRequest,
  BossRushStartBattleResponse,
  BossRushFinishBattleRequest,
  BossRushFinishBattleResponse,
  BossRushRelicSelectRequest,
  BossRushRelicSelectResponse,
  BossRushRelicUpgradeRequest,
  BossRushRelicUpgradeResponse,
  EnemyDuelBattleStartResponse,
  EnemyDuelCreateTeamRequest,
  EnemyDuelCreateTeamResponse,
  EnemyDuelJoinTeamRequest,
  EnemyDuelJoinTeamResponse,
  EnemyDuelMultiBattleFinishRequest,
  EnemyDuelMultiBattleFinishResponse,
  EnemyDuelMultiBattleStartRequest,
  EnemyDuelQueryMatchRequest,
  EnemyDuelQueryMatchResponse,
  EnemyDuelRankInfo,
  EnemyDuelSingleBattleFinishRequest,
  EnemyDuelSingleBattleFinishResponse,
  EnemyDuelSingleBattleStartRequest,
  EnemyDuelStartMatchRequest,
  EnemyDuelStartMatchResponse,
  Act24sideAlchemyRequest,
  Act24sideAlchemyResponse,
  Act24sideBattleFinishRequest,
  Act24sideBattleFinishResponse,
  Act24sideBattleStartRequest,
  Act24sideBattleStartResponse,
  Act24sideEatRequest,
  Act24sideEatResponse,
  Act24sideGetHuntCollectRewardsRequest,
  Act24sideGetHuntCollectRewardsResponse,
  Act24sideSetToolRequest,
  Act24sideSetToolResponse,
  Act25sideBattleFinishRequest,
  Act25sideBattleFinishResponse,
  Act25sideBattleStartRequest,
  Act25sideBattleStartResponse,
  Act25sideDailyRefreshRequest,
  Act25sideDailyRefreshResponse,
  Act25sideFinishInvestigationRequest,
  Act25sideFinishInvestigationResponse,
  Act25sideHarvestRequest,
  Act25sideHarvestResponse,
  Act25sideInvestigateRequest,
  Act25sideInvestigateResponse,
  Act29sideCommitMelodyRequest,
  Act29sideCommitMelodyResponse,
  Act29sideStartMajorInvestRequest,
  Act29sideStartMajorInvestResponse,
  Act29sideSyncthesizeRequest,
  Act29sideSyncthesizeResponse,
  Act36sideConfirmDexNavRewardRequest,
  Act36sideConfirmDexNavRewardResponse,
  FootballBattleFinishRequest,
  FootballBattleFinishResponse,
  FootballBattleStartRequest,
  FootballBattleStartResponse,
  TrainingGroundBattleFinishRequest,
  TrainingGroundBattleFinishResponse,
  TrainingGroundBattleStartRequest,
  TrainingGroundBattleStartResponse,
  Act13sideDailyMissionCommitRequest,
  Act13sideDailyMissionRandomRequest,
  Act1vhalfidleRequest,
  Act35sideBuyRequest,
  Act35sideCreateRequest,
  Act42sideGetDailyRewardsRequest,
  Act44sideNextStateRequest,
  Act44sideSelectChoiceRequest,
  Act44sideStartGameRequest,
  Act45sideConfirmRequest,
  Act46sideGameRequest,
  Act5d1BuyGoodsRequest,
  ActivityGetRewardRequest,
  ActivityMiniBattleFinishRequest,
  ActivityMiniBattleFinishResponse,
  ActivityMiniBattleStartRequest,
  ActivityMiniBattleStartResponse,
  ActivityStubItemsResponse,
  ActivityStubRequest,
  ActivityStubResponse,
} from "../shared/activity";
import { validateBody } from "@core/http/validate-body";

import { PlayerDataManager } from "../../../kernel/player-data-manager";
import type { Draft } from "mutative";
import type {
  PlayerActivity,
  PlayerCharacter,
  PlayerDataModel,
} from "../../../kernel/playerdata";
import type { ServerPayload } from "@excel/json-value";
import {
  Act1vhalfidleCharUpgradeEliteResponse,
  Act1vhalfidleCharUpgradeLevelResponse,
  Act1vhalfidleCharUpgradeSkillResponse,
  Act1vhalfidleHarvestResponse,
  Act1vhalfidleRecruitNormalResponse,
} from "../shared/activity";

/** HALFIDLE_VERIFY1 存档原始形状（登记成员索引元素；字段全可选——ensureHalfIdleData 逐字段回填） */
type HalfIdleDataRaw = NonNullable<PlayerActivity["HALFIDLE_VERIFY1"]>[string];

/** HALFIDLE_VERIFY1 活动编队干员（官服 PlayerActivity_PlayerAct1VHalfIdleActivity_Act1VHalfIdleCharData） */
interface HalfIdleChar {
  instId: number;
  charId: string;
  level: number;
  /** 遗留字段（旧存档 skillLvl，升级技能读取时兜底） */
  skillLvl?: number;
  skillLvlWithSpec: number;
  evolvePhase: number;
  isAssist: number;
  defaultSkillId: string;
  defaultEquipId: string;
}

/**
 * HALFIDLE_VERIFY1 玩家存档（ensureHalfIdleData 回填后的完整形状）
 *
 * 与登记成员（全可选）的关系：本接口是「回填完成后」的视图，供消费侧免 `?.`；
 * 回填在 {@link ensureHalfIdleData} 内完成，边界处一次收窄。
 */
interface HalfIdleData {
  coin: number;
  globalBan: number;
  troop: {
    chars: { [instId: string]: HalfIdleChar };
    trap: string[];
    npc: string[];
    assist: ServerPayload[];
    extraAssist: number;
  };
  stage: {
    [stageId: string]: { rate: { [itemId: string]: number }; bossState: number };
  };
  settleInfo: {
    rate: { [itemId: string]: number };
    bossState: number;
    stageId: string;
    progress: number;
  };
  production: {
    rate: { [itemId: string]: number };
    product: { [itemId: string]: number };
    harvestTs: number;
    refreshTs: number;
  };
  recruit: {
    poolGain: { [poolId: string]: string[] };
    poolTimes: { [poolId: string]: number };
  };
  milestone: { point: number; got: string[] };
  inventory: { [itemId: string]: number };
  tech: { unlock: string[] };
}

/**
 * act1vhalfidle 活动族业务逻辑（建议 11：族包五件套——router 仅路由注册，业务收敛于 logic）
 *
 * 由 router.ts 内联 handler 提取（实现未改动）：每个活动接口一个具名函数，
 * 输入 player + 请求体，返回响应对象（原 res.send 载荷）。
 */

export async function handleAct1vhalfidlebattleStart(player: PlayerDataManager, body: ActivityMiniBattleStartRequest) {
  return (miniBattleStart(player));
}

/**
 * 半挂机关卡结算：登记该关卡的每小时产出并刷新产出速率
 *
 * 官服形状：`stage[stageId] = { rate, bossState }`、`settleInfo = { rate, bossState, stageId, progress }`，
 * `production.rate` 为已通关卡 rate 之和（客户端据此展示「每小时产出」）。
 * 原实现 battleFinish 为纯 stub，从不写 stage/settleInfo/rate → 产出玩法与 harvest 恒空。
 */
export async function handleAct1vhalfidlebattleFinish(player: PlayerDataManager, body: ActivityMiniBattleFinishRequest) {
  const cfg = vhalfidleConfig();
  const activityId = String(body?.activityId ?? VHALFIDLE_ACT_ID);
  const stageId = String(body?.stageId ?? "");
  if (!cfg || !stageId || !cfg.stageProductionData?.[stageId]) {
    return (miniBattleFinish(player, body));
  }
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, activityId);
    // 先按旧速率结算到此刻，再换速，避免改速当刻的产出被新速率吞掉
    accrueHalfIdleProducts(data, cfg);
    const rate = stageProductionRate(cfg, stageId);
    const prev = data.stage[stageId];
    data.stage[stageId] = { rate, bossState: Number(prev?.bossState ?? 0) };
    data.settleInfo = {
      rate,
      bossState: data.stage[stageId].bossState,
      stageId,
      progress: 1,
    };
    syncProductionRate(data);
  });
  return (player.delta satisfies ActivityMiniBattleFinishResponse);
}

export async function handleAct1vhalfidlerefreshProduct(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  const cfg = vhalfidleConfig();
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    accrueHalfIdleProducts(data, cfg);
  });
  return (player.delta satisfies ActivityStubResponse);
}

export async function handleAct1vhalfidleharvest(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  const cfg = vhalfidleConfig();
  let milestoneAdd = 0;
  const items: { itemId: string; count: number }[] = [];
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    // 先按当前速率补算到此刻，再收取（原实现只在 refreshProduct 累积 → 直接 harvest 恒为空）
    accrueHalfIdleProducts(data, cfg);
    const production = data.production;
    const products: Record<string, number> = production.product ?? {};
    for (const [key, raw] of Object.entries(products)) {
      // 产出按秒累计（可为小数），收取时取整、余数留池
      const count = Math.floor(Number(raw));
      if (!(count > 0)) continue;
      products[key] = Number(raw) - count;
      if (key === (cfg?.milestoneId ?? "act1vhalfidle_token_point")) {
        milestoneAdd += count;
      }
      data.inventory[key] = (data.inventory[key] ?? 0) + count;
      items.push({ itemId: vhalfidleItemId(key), count });
    }
    if (milestoneAdd > 0) {
      data.milestone.point = Number(data.milestone.point ?? 0) + milestoneAdd;
    }
    production.harvestTs = now();
    production.refreshTs = now();
  });
  return ({
    milestoneAdd,
    items,
    ...player.delta,
  } satisfies Act1vhalfidleHarvestResponse);
}

/**
 * 解锁科技树节点
 *
 * 修复：原实现无消耗、无前置校验（techTreeData[node].tokenCost 从未扣除、prevNodeId 从未校验）。
 * 现按配置扣 `strategy_point`（constData.techCostItemId）、要求 prevNodeId 全部已解锁，
 * 库存不足或前置未满足时返回 result=1 且不落库。
 */
export async function handleAct1vhalfidleunlockTech(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  const cfg = vhalfidleConfig();
  const techId = String(body.techId ?? "");
  const node = cfg?.techTreeData?.[techId];
  if (!cfg || !node) return ({ result: 1, ...player.delta });
  let ok = true;
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    if (data.tech.unlock.includes(techId)) {
      ok = false;
      return;
    }
    const prev = node.prevNodeId ?? [];
    if (prev.some((id) => !data.tech.unlock.includes(id))) {
      ok = false;
      return;
    }
    const costItem = cfg.techCostItemId;
    const cost = Number(node.tokenCost ?? 0);
    if (cost > 0 && Number(data.inventory[costItem] ?? 0) < cost) {
      ok = false;
      return;
    }
    if (cost > 0) data.inventory[costItem] = Number(data.inventory[costItem] ?? 0) - cost;
    data.tech.unlock.push(techId);
  });
  if (!ok) return ({ result: 1, ...player.delta });
  return (player.delta satisfies ActivityStubResponse);
}

/**
 * 随机/专项/机动密令任命
 *
 * 修复（对照 excel gachaPoolData）：
 * 1. 消耗真实道具——卡池 itemId（gacha_normal / gacha_newplayer / gacha_pacN）按 consumeData 分档扣除，
 *    原实现完全不扣道具（白嫖全池）；
 * 2. 机动密令池一次只任命 1 名（每档 consume 1），原实现把整池干员一次全给；
 * 3. 随机池范围按 poolTypeData 口径：排除 1/2 星、专项任命与机动密令已含干员、未持有的联动干员；
 *    原实现从玩家自己的干员列表里随机（池定义错误）。
 */
export async function handleAct1vhalfidlerecruitNormal(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  const cfg = vhalfidleConfig();
  const poolId = String(body.poolId ?? "normalGachaPool");
  const pool = cfg?.gachaPoolData?.[poolId];
  if (!cfg || !pool) return ({ result: 1, ...player.delta });
  const requested = Math.floor(Number(body.count ?? 1));
  const count = Math.max(1, Math.min(10, Number.isFinite(requested) && requested > 0 ? requested : 1));
  const chooseCharId = String(body.charId ?? "");
  let ticketCount = 0;
  let ok = true;
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    const recruit = data.recruit;
    const used = Number(recruit.poolTimes[poolId] ?? 0);
    const cost = gachaCost(pool, used, count);
    const stock = Number(data.inventory[pool.itemId] ?? 0);
    ticketCount = stock;
    if (stock < cost) {
      ok = false;
      return;
    }
    data.inventory[pool.itemId] = stock - cost;
    recruit.poolTimes[poolId] = used + count;
    const targets = resolveRecruitTargets(cfg, pool, draft, recruit, count, chooseCharId);
    const gained: string[] = [];
    for (const charId of targets) {
      if (addHalfIdleChar(draft, data, charId)) gained.push(charId);
    }
    if (gained.length) {
      if (!recruit.poolGain[poolId]) recruit.poolGain[poolId] = [];
      recruit.poolGain[poolId].push(...gained);
    }
    ticketCount = Number(data.inventory[pool.itemId] ?? 0);
  });
  if (!ok) return ({ result: 1, ...player.delta });
  // CS: Act1VHalfIdleRecruitNormalResponse { ticketCount }
  return ({
    ticketCount,
    ...player.delta,
  } satisfies Act1vhalfidleRecruitNormalResponse);
}

/**
 * 特约任命（GACHA_DIRECT）：指定任命 1 名干员
 *
 * 修复：原实现无消耗、只能任命玩家自有的干员、也不区分卡池。现按 gachaPoolData 中
 * 含该 charId 的卡池扣道具（特约邀请函 gacha_direct，消耗随次数递增 100/150/150/200），
 * 未持有干员按 charMaxRankData 建档（初始等级 1 / PHASE_0）。
 */
export async function handleAct1vhalfidlerecruitDirect(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  const cfg = vhalfidleConfig();
  const charId = String(body.charId ?? "");
  const pool = pickDirectPool(cfg, charId);
  if (!cfg || !pool || !charId) return ({ result: 1, ...player.delta });
  let ok = true;
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    const recruit = data.recruit;
    const used = Number(recruit.poolTimes[pool.poolId] ?? 0);
    const cost = gachaCost(pool, used, 1);
    const stock = Number(data.inventory[pool.itemId] ?? 0);
    if (stock < cost) {
      ok = false;
      return;
    }
    data.inventory[pool.itemId] = stock - cost;
    recruit.poolTimes[pool.poolId] = used + 1;
    if (addHalfIdleChar(draft, data, charId)) {
      if (!recruit.poolGain[pool.poolId]) recruit.poolGain[pool.poolId] = [];
      recruit.poolGain[pool.poolId].push(charId);
    }
  });
  if (!ok) return ({ result: 1, ...player.delta });
  return (player.delta satisfies ActivityStubResponse);
}

export async function handleAct1vhalfidleupgradeChar(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  let charId = "";
  let currentLvl = 0;
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    const actChar = data.troop.chars[String(body.charInstId ?? "")];
    if (!actChar) return;
    charId = actChar.charId;
    if (body.level) actChar.level = body.level;
    currentLvl = actChar.level;
  });
  // CS: Act1VHalfIdleCharUpgradeLevelResponse { charId, currentLvl }
  return ({ charId, currentLvl, ...player.delta } satisfies Act1vhalfidleCharUpgradeLevelResponse);
}

export async function handleAct1vhalfidleupgradeSkill(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  let charId = "";
  let currentLvl = 0;
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    const actChar = data.troop.chars[String(body.charInstId ?? "")];
    if (!actChar) return;
    charId = actChar.charId;
    // 官服字段为 skillLvlWithSpec（types-playerdata Act1VHalfIdleCharData）
    if (body.skillLvl) actChar.skillLvlWithSpec = body.skillLvl;
    currentLvl = actChar.skillLvlWithSpec ?? actChar.skillLvl ?? 0;
  });
  // CS: Act1VHalfIdleCharUpgradeSkillResponse { charId, currentLvl }
  return ({ charId, currentLvl, ...player.delta } satisfies Act1vhalfidleCharUpgradeSkillResponse);
}

export async function handleAct1vhalfidleevolveChar(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  let charId = "";
  let currentEvolvePhase = 0;
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    const actChar = data.troop.chars[String(body.charInstId ?? "")];
    if (!actChar) return;
    charId = actChar.charId;
    if (body.evolvePhase != null) {
      actChar.evolvePhase = body.evolvePhase;
      const cap = halfIdleRankCap(actChar);
      actChar.skillLvlWithSpec = cap.maxSkillRank;
      if (actChar.level > cap.maxLevel) actChar.level = cap.maxLevel;
    }
    currentEvolvePhase = actChar.evolvePhase;
  });
  // CS: Act1VHalfIdleCharUpgradeEliteResponse { charId, currentEvolvePhase, item }
  return ({ charId, currentEvolvePhase, item: null, ...player.delta } satisfies Act1vhalfidleCharUpgradeEliteResponse);
}

export async function handleAct1vhalfidlereplaceRate(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  return (player.delta satisfies ActivityStubResponse);
}

export async function handleAct1vhalfidlesetAssistChar(player: PlayerDataManager, body: Act1vhalfidleRequest) {
  if (!body.activityId) return ({ result: 1, ...player.delta });
  await player.update(async (draft) => {
    const data = ensureHalfIdleData(draft, body.activityId!);
    const actChar = data.troop.chars[String(body.charInstId ?? "")];
    if (actChar) actChar.isAssist = 1;
  });
  return (player.delta satisfies ActivityStubResponse);
}

// ===== 顶层辅助函数 =====

/**
 * 取（必要时创建）act1vhalfidle 活动状态
 *
 * 字段形状对齐官服 PlayerActivity_PlayerAct1VHalfIdleActivity：
 * coin / troop{chars,trap,npc,assist,extraAssist} / stage / settleInfo / production /
 * recruit{poolGain,poolTimes} / milestone{point,got} / inventory / tech{unlock} / globalBan。
 * 原实现缺少 coin/stage/settleInfo/milestone/globalBan，且 troop 用错字段名 char（官服为 chars）、
 * recruit 缺 poolGain —— 客户端读不到任命结果与科技/里程碑进度。
 */
function ensureHalfIdleData(
  draft: Draft<PlayerDataModel>,
  activityId: string,
): HalfIdleData {
  // 修复：draft.activity / HALFIDLE_VERIFY1 缺失时可能为 undefined，先兜底再重读引用，
  // 避免赋值后本地变量仍为 undefined，导致 hf[activityId] 抛「reading 'undefined'」500。
  if (!draft.activity) draft.activity = {};
  if (!draft.activity.HALFIDLE_VERIFY1) {
    draft.activity.HALFIDLE_VERIFY1 = {};
  }
  const hf = draft.activity.HALFIDLE_VERIFY1;
  if (!hf[activityId]) hf[activityId] = {};
  const data = hf[activityId];
  // 逐字段回填：旧版本存档（原实现只建了 production/inventory/tech/troop.char/recruit.poolTimes）
  // 缺 stage/settleInfo/milestone/coin/globalBan/poolGain，直接下标会 500
  if (!data.coin && data.coin !== 0) data.coin = 0;
  if (!data.globalBan && data.globalBan !== 0) data.globalBan = 0;
  if (!data.troop) data.troop = {};
  if (!data.troop.chars) data.troop.chars = {};
  if (!Array.isArray(data.troop.trap)) data.troop.trap = [];
  if (!Array.isArray(data.troop.npc)) data.troop.npc = [];
  if (!Array.isArray(data.troop.assist)) data.troop.assist = [];
  if (data.troop.extraAssist == null) data.troop.extraAssist = 0;
  if (!data.stage) data.stage = {};
  if (!data.settleInfo) {
    data.settleInfo = { rate: {}, bossState: 0, stageId: "", progress: 0 };
  }
  if (!data.production) {
    data.production = { rate: {}, product: {}, harvestTs: now(), refreshTs: now() };
  }
  if (!data.production.rate) data.production.rate = {};
  if (!data.production.product) data.production.product = {};
  if (data.production.harvestTs == null) data.production.harvestTs = now();
  if (data.production.refreshTs == null) data.production.refreshTs = data.production.harvestTs;
  if (!data.recruit) data.recruit = {};
  if (!data.recruit.poolGain) data.recruit.poolGain = {};
  if (!data.recruit.poolTimes) data.recruit.poolTimes = {};
  if (!data.milestone) data.milestone = { point: 0, got: [] };
  if (data.milestone.point == null) data.milestone.point = 0;
  if (!Array.isArray(data.milestone.got)) data.milestone.got = [];
  if (!data.inventory) data.inventory = {};
  if (!data.tech) data.tech = {};
  if (!Array.isArray(data.tech.unlock)) data.tech.unlock = [];
  // 回填完成后按完整形状收窄（登记成员全可选，消费侧免 ?.）
  return data as HalfIdleData;
}

/**
 * 按已通关关卡的产出表重算 production.rate（各关卡同名物品相加）
 * @param data - 活动状态
 */
function syncProductionRate(data: HalfIdleData): void {
  const rate: Record<string, number> = {};
  const stages: HalfIdleData["stage"] = data.stage ?? {};
  for (const info of Object.values(stages)) {
    const itemRate: Record<string, number> = info?.rate ?? {};
    for (const [item, v] of Object.entries(itemRate)) {
      rate[item] = Number(rate[item] ?? 0) + Number(v ?? 0);
    }
  }
  data.production.rate = rate;
}

/**
 * 按 production.rate 结算离线产出
 *
 * efficiencyMax 为每小时产出（全关卡同名物品之和恰等于 productMaxEfficiencyDict，故后者是总量上限）；
 * 单次结算时长按 constData.efficiencyDurationMax（48h）截断，产出量按物品上限封顶。
 * @param data - 活动状态
 * @param cfg - 活动配置（缺失时按无上限结算，兼容旧存档）
 */
function accrueHalfIdleProducts(data: HalfIdleData, cfg?: VHalfIdleConfig): void {
  const production = data.production;
  const t = now();
  const last = Number(production.refreshTs ?? production.harvestTs ?? t);
  production.refreshTs = t;
  const window = cfg?.efficiencyDurationMax ?? 172800;
  const dt = Math.min(Math.max(0, t - last), window);
  if (dt <= 0) return;
  const hours = dt / 3600;
  const caps: Record<string, number> = cfg?.productMaxEfficiencyDict ?? {};
  const activeRate: Record<string, number> = production.rate ?? {};
  for (const [item, rawRate] of Object.entries(activeRate)) {
    const perHour = Number(rawRate ?? 0);
    if (!(perHour > 0)) continue;
    const cap = Number(caps[item] ?? 0);
    const next = Number(production.product[item] ?? 0) + perHour * hours;
    production.product[item] = cap > 0 ? Math.min(cap, next) : next;
  }
}

/**
 * 解析本次任命的干员列表
 *
 * 机动密令（GACHA_PAC）：一次任命在池内指定 1 名（techTreeData 说明「使用后可直接任命<4 名>」），
 * 客户端给了 charId 就用它，否则按 charData 顺序取尚未获得的第一名；
 * 专项任命（GACHA_NEWPLAYER）：池内 charData 随机；
 * 随机任命（GACHA_NORMAL）：池内 charData 为空，范围按 poolTypeData 口径从 gachaCharData 反推。
 * @param cfg - 活动配置
 * @param pool - 卡池
 * @param draft - 存档草稿（读玩家自有干员）
 * @param recruit - 活动任命状态（读 poolGain）
 * @param count - 本次任命次数
 * @param chooseCharId - 客户端指定的干员 id（可为空）
 * @returns 应任命的干员 id 列表
 */
function resolveRecruitTargets(
  cfg: VHalfIdleConfig,
  pool: VHalfIdleGachaPool,
  draft: Draft<PlayerDataModel>,
  recruit: HalfIdleData["recruit"],
  count: number,
  chooseCharId: string,
): string[] {
  const type = String(pool.poolType ?? "").toUpperCase();
  if (type === "GACHA_PAC") {
    const gained = new Set<string>(recruit.poolGain?.[pool.poolId] ?? []);
    const out: string[] = [];
    if (chooseCharId && (pool.charData ?? []).includes(chooseCharId)) out.push(chooseCharId);
    for (const id of pool.charData ?? []) {
      if (out.length >= count) break;
      if (gained.has(id) || out.includes(id)) continue;
      out.push(id);
    }
    return out;
  }
  if (type === "GACHA_NEWPLAYER") return pickRandom(pool.charData ?? [], count);
  // GACHA_NORMAL：排除专项任命/机动密令已含干员、未持有的联动干员、1~2 星
  const ownedChars: Record<string, PlayerCharacter> = draft.troop.chars ?? {};
  const owned = new Set(
    Object.values(ownedChars).map((c) => String(c.charId)),
  );
  const reserved = new Set<string>();
  for (const p of Object.values(cfg.gachaPoolData ?? {})) {
    if (p.poolId === pool.poolId) continue;
    if (String(p.poolType ?? "").toUpperCase() === "GACHA_DIRECT") continue;
    for (const id of p.charData ?? []) reserved.add(id);
  }
  const candidates = Object.keys(cfg.gachaCharData ?? {}).filter((id) => {
    if (reserved.has(id)) return false;
    if (cfg.gachaCharData[id]?.isLinkageChar && !owned.has(id)) return false;
    return rarityToIndex(excel.charData(id)?.rarity) >= 2;
  });
  return pickRandom(candidates, count);
}

/**
 * 从候选列表中随机取 count 名（候选为空时返回空数组）
 * @param candidates - 候选干员 id
 * @param count - 次数
 * @returns 抽中的干员 id 列表
 */
function pickRandom(candidates: string[], count: number): string[] {
  const out: string[] = [];
  if (!candidates.length) return out;
  for (let i = 0; i < count; i++) {
    out.push(candidates[Math.floor(Math.random() * candidates.length)]);
  }
  return out;
}

/**
 * 定位含该干员的直接任命卡池（特约任命 GACHA_DIRECT，缺省回退任一含该干员的池）
 * @param cfg - 活动配置
 * @param charId - 目标干员
 * @returns 命中的卡池（无则 undefined）
 */
function pickDirectPool(cfg: VHalfIdleConfig | undefined, charId: string): VHalfIdleGachaPool | undefined {
  if (!cfg || !charId) return undefined;
  const pools = Object.values(cfg.gachaPoolData ?? {});
  const direct = pools.find(
    (p) =>
      String(p.poolType ?? "").toUpperCase() === "GACHA_DIRECT" &&
      (p.charData ?? []).includes(charId),
  );
  if (direct) return direct;
  return pools.find((p) => (p.charData ?? []).includes(charId));
}

/**
 * 取活动干员在当前精英阶段的等级/技能上限（charMaxRankData）
 * @param actChar - 活动干员
 * @returns 上限（无配置时按 90 级 / 10 技能兜底）
 */
function halfIdleRankCap(actChar: {
  charId?: string;
  evolvePhase?: number;
}): { maxLevel: number; maxSkillRank: number } {
  const cfg = vhalfidleConfig();
  const rarity = excel.charData(String(actChar?.charId ?? ""))?.rarity;
  const tier = "TIER_" + (rarityToIndex(rarity) + 1);
  const row = cfg?.charMaxRankData?.[tier]?.maxRankData?.["PHASE_" + Number(actChar?.evolvePhase ?? 0)];
  return {
    maxLevel: Number(row?.maxLevel ?? 90),
    maxSkillRank: Number(row?.maxSkillRank ?? 10),
  };
}

/**
 * 把干员加入活动编队（已在编队中则跳过）
 *
 * 自有干员沿用其等级/精英化；未持有干员（专项任命/机动密令允许）按官服默认建档（1 级、PHASE_0）。
 * @param draft - 存档草稿
 * @param data - 活动状态
 * @param charId - 干员 id
 * @returns 是否新增成功
 */
function addHalfIdleChar(
  draft: Draft<PlayerDataModel>,
  data: HalfIdleData,
  charId: string,
): boolean {
  if (!charId || !excel.charData(charId)) return false;
  const chars = data.troop.chars;
  if (Object.values(chars).some((c) => c?.charId === charId)) return false;
  const rosterTable: Record<string, PlayerCharacter> = draft.troop.chars ?? {};
  const roster = Object.values(rosterTable);
  const owned = roster.find((c) => c?.charId === charId);
  const instId = Number(owned?.instId ?? nextHalfIdleInstId(draft, chars));
  const evolvePhase = Number(owned?.evolvePhase ?? 0);
  const cap = halfIdleRankCap({ charId, evolvePhase });
  chars[String(instId)] = {
    instId,
    charId,
    level: Math.min(Number(owned?.level ?? 1), cap.maxLevel),
    skillLvlWithSpec: cap.maxSkillRank,
    evolvePhase,
    isAssist: 0,
    defaultSkillId: "",
    defaultEquipId: String(owned?.currentEquip ?? ""),
  };
  return true;
}

/**
 * 生成活动编队内的下一个 instId（避开活动编队与玩家自有干员的 instId）
 * @param draft - 存档草稿
 * @param chars - 活动编队干员表
 * @returns 未占用的 instId
 */
function nextHalfIdleInstId(
  draft: Draft<PlayerDataModel>,
  chars: { [instId: string]: { instId?: number } },
): number {
  let max = 0;
  for (const key of Object.keys(chars)) max = Math.max(max, Number(key) || 0);
  const rosterTable: Record<string, PlayerCharacter> = draft.troop.chars ?? {};
  for (const c of Object.values(rosterTable)) {
    max = Math.max(max, Number(c?.instId) || 0);
  }
  return max + 1;
}

