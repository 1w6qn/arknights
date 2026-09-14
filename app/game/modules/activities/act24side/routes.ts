/**
 * 活动路由：act24side（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { ItemBundle, ItemType } from "@excel/excel";
import excel, { OCC_PERCENT_NUMERIC } from "@excel/excel";
import { activityDictKey } from "../shared/unlockActivity";
import { activityDetailJson, asShape } from "../shared/activity-json";
import type { JsonObject } from "@excel/json-value";
import { logger } from "@utils/logger";
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

/**
 * act24side（落叶逐火 / 源石技艺炼金站）活动配置读取
 *
 * 修复（2026-09-09）：原实现把炼金素材分值表**硬编码为不存在的 `act50melding_1..6`**
 *（excel 实际为 `act24side_melding_1..6`，分值 2/3/5/10/20/200）→ 每次炼金 totalScore 恒 0、
 * `gachaTimes=0`，素材被扣却零产出。
 */
interface Act24Config {
  /** 素材 id → 炼金分值（meldingDict[*].meldingPrice） */
  meldingPrice: Record<string, number>;
  /** 炼金箱配置：gachaCost（每次消耗分值）/ gachaTimesLimit（单次上限） */
  box: Record<string, { gachaCost: number; gachaTimesLimit: number }>;
  /** 炼金箱奖池（meldingGachaBoxGoodDataMap[boxId]） */
  goods: Record<string, Act24Good[]>;
  /** 关卡掉落配置（meldingDropDict[stageId]） */
  drops: Record<string, { displayDetailRewards?: Act24DropEntry[] }>;
  /** 用餐配置（mealDataList） */
  meals: Record<string, { mealCost: number; mealRewardAP: number; mealRewardItemInfo?: ItemBundle }>;
  /** 用餐每日次数上限（constData.mealDayTimesLimit） */
  mealDayTimesLimit: number;
}

/** 炼金箱奖池条目 */
interface Act24Good {
  goodId: string;
  itemId: string;
  itemType: string;
  perCount: number;
  totalCount: number;
  gachaType?: string;
}

/** meldingDropDict 掉落条目（原始 excel 形状，occPercent 为字符串） */
interface Act24DropEntry {
  id: string;
  type: string;
  dropType: string | number;
  occPercent: string | number;
}

/** 掉落档位 → 概率（与 battle 掉落同表：0=必掉 / 1=75% / 2=40% / 3=15% / 4=3%） */
const ACT24_OCC_PROB = [1, 0.75, 0.4, 0.15, 0.03];

/** meldingDict 条目消费面（炼金素材分值） */
type Act24MeldingEntry = { meldingId?: string; meldingPrice?: number };

/** meldingGachaBoxDataList 条目消费面（炼金箱消耗/次数上限） */
type Act24BoxEntry = { gachaBoxId?: string; gachaCost?: number; gachaTimesLimit?: number };

/** TYPE_ACT24SIDE 活动详情消费面（excel activity 字典是未建模 JSON） */
type Act24DetailConfig = {
  meldingDict?: { [key: string]: Act24MeldingEntry };
  meldingGachaBoxDataList?: Act24BoxEntry[];
  meldingGachaBoxGoodDataMap?: { [boxId: string]: Act24Good[] };
  meldingDropDict?: Act24Config["drops"];
  mealDataList?: Act24Config["meals"];
  constData?: { mealDayTimesLimit?: number };
};

/**
 * 读取 act24side 活动配置（只读）
 * @param activityId - 活动 id（客户端传 act24side）
 * @returns 归一化后的配置
 */
function act24Config(activityId: string): Act24Config {
  const key = activityDictKey("TYPE_ACT24SIDE") ?? "tYPE_ACT24SIDE";
  const detail: JsonObject =
    activityDetailJson(excel.ActivityTable.activity, key, activityId) ??
    activityDetailJson(excel.ActivityTable.activity, key, "act24side") ??
    {};
  const view = asShape<Act24DetailConfig>(detail) ?? {};
  const meldingPrice: Record<string, number> = {};
  for (const m of Object.values(view.meldingDict ?? {})) {
    if (m?.meldingId) meldingPrice[m.meldingId] = Number(m.meldingPrice ?? 0);
  }
  const box: Act24Config["box"] = {};
  for (const b of Object.values(view.meldingGachaBoxDataList ?? [])) {
    if (b?.gachaBoxId) {
      box[b.gachaBoxId] = {
        gachaCost: Number(b.gachaCost ?? 0),
        gachaTimesLimit: Number(b.gachaTimesLimit ?? 0),
      };
    }
  }
  return {
    meldingPrice,
    box,
    goods: view.meldingGachaBoxGoodDataMap ?? {},
    drops: view.meldingDropDict ?? {},
    meals: view.mealDataList ?? {},
    mealDayTimesLimit: Number(view.constData?.mealDayTimesLimit ?? 1) || 1,
  };
}

/**
 * 掷骰一组 act24side 掉落（occPercent 字符串 → 档位 → 概率）
 * @param entries - displayDetailRewards
 * @returns 命中的物品列表
 */
function rollAct24Drops(entries: Act24DropEntry[] | undefined): ItemBundle[] {
  const out: ItemBundle[] = [];
  for (const e of entries ?? []) {
    const tier =
      typeof e.occPercent === "number"
        ? e.occPercent
        : (OCC_PERCENT_NUMERIC[e.occPercent] ?? 4);
    const prob = ACT24_OCC_PROB[tier] ?? 0;
    if (prob <= 0) continue;
    if (prob < 1 && Math.random() >= prob) continue;
    out.push({ id: e.id, type: e.type as ItemType, count: 1 });
  }
  return out;
}
const router = Router();
router.post("/act24side/alchemy", validateBody(ReqSchema.act24sideAlchemySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as Act24sideAlchemyRequest;
  const { activityId, gachaBox } = body;
  const items = body.items ?? {};
  // 修复（2026-09-09）：分值表/消耗/上限/余值全部改为读活动配置——
  // 原实现硬编码不存在的 `act50melding_*`（恒 0 分）、两箱统一 `/100`（转换箱应为 40）、
  // 无 10 次上限、余值丢弃、`totalCount=0` 的 UNLIMITED 池被永久排除。
  const cfg = act24Config(activityId);
  const boxCfg = cfg.box[gachaBox] ?? { gachaCost: 0, gachaTimesLimit: 0 };
  const goodList = cfg.goods[gachaBox] ?? [];
  const rewards: ItemBundle[] = [];
  let valid = true;

  await player.update(async (draft) => {
    const act = draft.activity.TYPE_ACT24SIDE;
    if (!act) return;
    const entry = act[activityId] ?? (act[activityId] = {});
    if (!entry.alchemy) {
      entry.alchemy = { price: 0, item: {}, gacha: {} };
    }
    const alchemy = entry.alchemy;
    const itemsData = alchemy.item!;
    // 校验素材是否足够（不足则整单不消耗）
    for (const [key, count] of Object.entries(items)) {
      if ((itemsData[key] ?? 0) < Number(count)) {
        valid = false;
        return;
      }
    }
    let addScore = 0;
    for (const [key, count] of Object.entries(items)) {
      addScore += Number(count) * (cfg.meldingPrice[key] ?? 0);
    }
    for (const [key, count] of Object.entries(items)) {
      itemsData[key] -= Number(count);
    }
    const cost = boxCfg.gachaCost > 0 ? boxCfg.gachaCost : 1;
    const limit = boxCfg.gachaTimesLimit > 0 ? boxCfg.gachaTimesLimit : 10;
    const totalScore = Number(alchemy.price ?? 0) + addScore;
    const gachaTimes = Math.min(limit, Math.floor(totalScore / cost));
    // 未达一次炼金阈值的余值留存（官方 price 字段跨次继承）
    alchemy.price = totalScore - gachaTimes * cost;
    if (gachaTimes <= 0 || goodList.length === 0) return;
    const gachaMap = alchemy.gacha!;
    if (!gachaMap[gachaBox]) gachaMap[gachaBox] = {};
    const drawnMap = gachaMap[gachaBox];
    // 剩余可抽池：LIMITED 按 totalCount-已抽；UNLIMITED / totalCount=0 视为无限
    const available: Array<{ good: Act24Good; remaining: number }> = goodList
      .map((good) => {
        const unlimited =
          String(good.gachaType ?? "").toUpperCase() === "UNLIMITED" ||
          !good.totalCount;
        const remaining = unlimited
          ? Number.POSITIVE_INFINITY
          : good.totalCount - (drawnMap[good.goodId] ?? 0);
        return { good, remaining };
      })
      .filter((entry) => entry.remaining > 0);
    const drawResult: {
      [goodId: string]: {
        goodId: string;
        itemId: string;
        itemType: string;
        perCount: number;
        count: number;
      };
    } = {};
    for (let i = 0; i < gachaTimes && available.length > 0; i++) {
      const idx = Math.floor(Math.random() * available.length);
      const entry = available[idx];
      if (!drawResult[entry.good.goodId]) {
        drawResult[entry.good.goodId] = {
          goodId: entry.good.goodId,
          itemId: entry.good.itemId,
          itemType: entry.good.itemType,
          perCount: entry.good.perCount,
          count: 0,
        };
      }
      drawResult[entry.good.goodId].count += 1;
      if (Number.isFinite(entry.remaining)) {
        entry.remaining -= 1;
        if (entry.remaining <= 0) available.splice(idx, 1);
      }
    }
    for (const v of Object.values(drawResult)) {
      drawnMap[v.goodId] = (drawnMap[v.goodId] ?? 0) + v.count;
      rewards.push({
        id: v.itemId,
        type: v.itemType as ItemType,
        count: v.perCount * v.count,
      });
    }
  });

  if (rewards.length > 0) {
    for (const it of rewards) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send({
    ...player.delta,
    rewards: valid ? rewards : [],
  } satisfies Act24sideAlchemyResponse);
});

/**
 * 怪猎开始战斗
 * @route POST /activity/act24side/battleStart
 * CS: Act24sideBattleStartRequest : DefaultStartBattleRequest（标准开始战斗）+ activityId；
 * 复用标准战斗开始（battle.start）——狩猎关卡 AP 消耗按 StageTable 正常结算
 */

router.post("/act24side/battleStart", validateBody(ReqSchema.act24sideBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as Act24sideBattleStartRequest;
  res.send({
    ...(await player.battle.start(body)),
    ...player.delta,
  } satisfies Act24sideBattleStartResponse);
});

/**
 * 怪猎战斗结算
 * @route POST /activity/act24side/battleFinish
 * CS: Act24sideBattleFinishRequest : DefaultFinishBattleRequest + activityId；
 * 复用标准战斗结算 + 怪猎专属 meldingRewards 三字段（当前 excel 无怪猎掉落配置返回空）
 */

router.post("/act24side/battleFinish", validateBody(ReqSchema.act24sideBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as Act24sideBattleFinishRequest;
  // 缺参校验：battle data 缺失时返回业务错误
  if (body.data == null) {
    return res.send({ result: 1, ...player.delta });
  }
  // 修复（2026-09-09）：结算前取本场关卡 id（会话在 finish 后结束）与首通状态，
  // 用于按 meldingDropDict 发放炼金素材（原实现三字段恒空数组 → 打本→素材→炼金主循环断链）。
  const stageId = player.battle.getActiveBattle()?.stageId ?? "";
  const prevState =
    (player._playerdata.dungeon?.stages as Record<string, { state?: number }> | undefined)?.[
      stageId
    ]?.state ?? 0;
  const result = await player.battle.finish({
    data: body.data,
    battleData: body.battleData,
  });
  const cfg = act24Config(body.activityId ?? "act24side");
  // 常规掉落：按 meldingDropDict[stageId].displayDetailRewards 掷骰（首通为最高档）
  const meldingRewards = rollAct24Drops(
    cfg.drops[stageId]?.displayDetailRewards,
  );
  const firstMeldingRewards =
    prevState < 2 && meldingRewards.length > 0 ? [...meldingRewards] : [];
  const allRewards: ItemBundle[] = [...meldingRewards, ...firstMeldingRewards];
  // 用餐加成：当日首次通关额外获得 mealRewardItemInfo（meal.chance 标记已用）
  const mealMeldingRewards: ItemBundle[] = [];
  await player.update(async (draft) => {
    const act = draft.activity.TYPE_ACT24SIDE?.[body.activityId ?? "act24side"];
    const meal = act?.meal;
    if (!meal || meal.digested !== 1 || meal.chance === 1) return;
    const cfgItem = meal.id ? cfg.meals[meal.id]?.mealRewardItemInfo : undefined;
    if (!cfgItem) return;
    meal.chance = 1;
    mealMeldingRewards.push(cfgItem);
  });
  allRewards.push(...mealMeldingRewards);
  if (allRewards.length > 0) {
    for (const it of allRewards) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send({
    ...result,
    meldingRewards,
    firstMeldingRewards,
    mealMeldingRewards,
    ...player.delta,
  } satisfies Act24sideBattleFinishResponse);
});

/**
 * 怪猎进食
 * @route POST /activity/act24side/eat
 * 参考 ODPY act24eat：重置 meal 状态（digested=0/chance=0）并记录 meal id
 */

router.post("/act24side/eat", validateBody(ReqSchema.act24sideEatSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as Act24sideEatRequest;
  const activityId = body.activityId ?? "act24side";
  // 修复（2026-09-09）：用餐真实结算——按 mealDataList 扣龙门币（200）、加理智（20），
  // 并遵守 constData.mealDayTimesLimit（每日 1 次）；原实现只写 `meal` 状态，不扣币不加理智。
  const cfg = act24Config(activityId);
  const mealCfg = cfg.meals[body.meal];
  const today = new Date().toISOString().slice(0, 10);
  let apGain = 0;
  await player.update(async (draft) => {
    const act = draft.activity.TYPE_ACT24SIDE;
    if (!act) return;
    const entry = act[activityId] ?? (act[activityId] = {});
    const current = entry.meal;
    // 每日限次（mealDayTimesLimit，官服为 1）：当日已用餐则忽略请求
    if (current?.day === today && cfg.mealDayTimesLimit <= 1) return;
    const cost = mealCfg?.mealCost ?? 0;
    if (cost > 0 && (draft.status.gold ?? 0) < cost) {
      logger.warn("act24side", `龙门币不足（需 ${cost}），拒绝用餐 ${body.meal}`);
      return;
    }
    if (cost > 0) draft.status.gold -= cost;
    // digested=1：当日首次通关额外掉落待用；chance=0：尚未使用该加成
    entry.meal = { digested: 1, chance: 0, id: body.meal, day: today };
    apGain = mealCfg?.mealRewardAP ?? 0;
  });
  if (apGain > 0) {
    await player.gainItem
      .add({ id: "", type: "AP_GAMEPLAY" as ItemType, count: apGain })
      .handle();
  }
  res.send(player.delta satisfies Act24sideEatResponse);
});

/**
 * 怪猎设置工具
 * @route POST /activity/act24side/setTool
 * 参考 ODPY/OBS act24setTool：tools 列表内的工具置 2（激活），其余置 1（未激活）
 */

router.post("/act24side/setTool", validateBody(ReqSchema.act24sideSetToolSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as Act24sideSetToolRequest;
  await player.update(async (draft) => {
    const tool = draft.activity.TYPE_ACT24SIDE?.[body.activityId]?.tool;
    if (!tool) return;
    for (const key of Object.keys(tool)) {
      tool[key] = body.tools?.includes(key) ? 2 : 1;
    }
  });
  res.send(player.delta satisfies Act24sideSetToolResponse);
});

/**
 * 怪猎获取狩猎收集奖励
 * @route POST /activity/act24side/getHuntCollectRewards
 * CS: Act24sideGetHuntWikiRewardRequest {activityId}；私服简化返回空奖励
 */

router.post("/act24side/getHuntCollectRewards", validateBody(ReqSchema.act24sideGetHuntCollectRewardsSchema), async (req, res) => {
  const player = getPlayer();
  req.body as Act24sideGetHuntCollectRewardsRequest;
  res.send({
    rewards: [],
    ...player.delta,
  } satisfies Act24sideGetHuntCollectRewardsResponse);
});

/* ===== 生息演算（act25side，根路径 /act25side/*，参考 ODPY/OBS + CS 2.7.61）===== */
// 客户端路由为 /act25side/*（无 /activity 前缀），因此独立 rootRouter 导出，
// 在 app.ts 挂载到根路径（同 user.ts 的 rootRouter 模式）。

/**
 * 足球开始战斗
 * @route POST /activity/football/battleStart
 * CS: Act1FootballBattleStartRequest；参考 ODPY footballBattleStart 返回固定 battleId stub
 */
export default router;