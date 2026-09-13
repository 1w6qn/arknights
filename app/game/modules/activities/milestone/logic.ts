/**
 * 活动路由：milestone（由 router/activity.ts 拆分而来，实现未改动）
 */
import { confirmOneActivityMission, autoConfirmActivityMissionsIn, ItemTypeToString } from "../shared/shared";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { ItemBundle, ItemType } from "@excel/excel";
import excel from "@excel/excel";
import { logger } from "@utils/logger";
import { activityDictKey } from "../shared/unlockActivity";
import { recordPurchase } from "../../pay/public";
import {
  informantNextState,
  informantSelectChoice,
  informantStartGame,
  informantUseInsight,
  resolveAct44Data,
} from "../act44side/public";
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

import { PlayerDataManager } from "../../../kernel/PlayerDataManager";
import type { PlayerTemplateShop } from "../../../kernel/playerdata";
import { activityDetailJson, asShape } from "../shared/activity-json";

/** 里程碑配置条目（点数型 mileStoneList / 代币型 milestoneList 的并集消费面） */
type MilestoneConfigJson = {
  mileStoneId?: string;
  milestoneId?: string;
  needPointCnt?: number;
  tokenNum?: number;
  rewardItem?: ItemBundle;
  reward?: ItemBundle;
};

/**
 * 活动里程碑配置（跨活动类型统一形状）
 */
export interface MilestoneConfigEntry {
  /** 里程碑 id（点数型 mileStoneId / 代币型 milestoneId） */
  id: string;
  /** 达标阈值（点数型 needPointCnt / 代币型 tokenNum） */
  need: number;
  /** 奖励物品（rewardItem / reward） */
  reward?: ItemBundle;
}

/**
 * 从 excel ActivityTable 查某活动的里程碑配置
 *
 * 修复（2026-09-09）：活动里程碑「领取」原实现只写领取标记、**零发放**——BOSS_RUSH 分支与
 * 通用分支都不查配置表（只有 act44side 分支发了奖）。此处按活动 id 在 activity 字典
 *（键为首字母小写，如 bossRush/enemyDuel/typeAct44Side）中定位详情，
 * 兼容点数型 `mileStoneList`（needPointCnt + rewardItem）与代币型 `milestoneList`（tokenNum + reward）。
 * @param activityId - 活动 id（如 act6bossrush / act44side）
 * @returns 里程碑配置列表（无配置返回空数组）
 */
export function resolveMilestoneList(activityId: string): MilestoneConfigEntry[] {
  const activity = excel.ActivityTable.activity;
  for (const typeKey of Object.keys(activity)) {
    const detail = asShape<{
      mileStoneList?: MilestoneConfigJson[];
      milestoneList?: MilestoneConfigJson[];
    }>(activityDetailJson(excel.ActivityTable.activity, typeKey, activityId));
    if (!detail) continue;
    const list = detail.mileStoneList ?? detail.milestoneList;
    if (!Array.isArray(list)) continue;
    return list.map((m) => ({
      id: String(m?.mileStoneId ?? m?.milestoneId ?? ""),
      need: Number(m?.needPointCnt ?? m?.tokenNum ?? 0),
      reward: m?.rewardItem ?? m?.reward,
    }));
  }
  return [];
}

/**
 * 里程碑配置查询 + act44side 版本偏移兜底
 *
 * live 客户端发 `act44sre` 而 excel 键为 `act44side`，精确匹配失败时回退旧解析器。
 * @param activityId - 活动 id
 * @returns 里程碑配置列表
 */
function resolveMilestoneConfigs(activityId: string): MilestoneConfigEntry[] {
  const direct = resolveMilestoneList(activityId);
  if (direct.length > 0) return direct;
  const act44 = resolveAct44Data(activityId)?.mileStoneList;
  if (Array.isArray(act44)) {
    return act44.map((m) => ({
      id: String(m?.mileStoneId ?? ""),
      need: Number(m?.needPointCnt ?? 0),
      reward: m?.rewardItem,
    }));
  }
  return [];
}

/**
 * 在 activity 存档中定位某活动的里程碑状态
 *
 * BOSS_RUSH / ENEMY_DUEL / ACT44SIDE 的玩家结构同形（`{ point, got }`），
 * 故跨活动类型扫描 `activity[type][activityId].milestone`。
 * @param draft - mutative 可写草稿
 * @param activityId - 活动 id
 * @returns 里程碑状态（无则 undefined）
 */
function findMilestoneState(
  draft: { activity?: Record<string, Record<string, unknown> | undefined> },
  activityId: string,
): { point?: number; got?: string[] } | undefined {
  const act = draft.activity;
  if (!act || !activityId) return undefined;
  for (const typeKey of Object.keys(act)) {
    const entry = act[typeKey]?.[activityId] as
      | { milestone?: { point?: number; got?: string[] } }
      | undefined;
    if (entry?.milestone && typeof entry.milestone === "object") {
      return entry.milestone;
    }
  }
  return undefined;
}

/**
 * milestone 活动族业务逻辑（建议 11：族包五件套——router 仅路由注册，业务收敛于 logic）
 *
 * 由 router.ts 内联 handler 提取（实现未改动）：每个活动接口一个具名函数，
 * 输入 player + 请求体，返回响应对象（原 res.send 载荷）。
 */

export async function handleRewardMilestone(player: PlayerDataManager, body: RewardMilestoneRequest) {
  const rewards: ItemBundle[] = [];
  await player.update(async (draft) => {
    const milestoneId = body.milestoneId;
    // 修复（2026-09-09）：里程碑领奖统一走「配置表 + 标准 milestone 状态」路径——
    // BOSS_RUSH / ENEMY_DUEL / ACT44SIDE 的玩家结构同形（`{ point, got }`）。
    // 原实现：BOSS_RUSH 分支只写 got、通用分支只写 MILESTONE_ONLY 标记，**两者都不发奖**
    // → 所有活动里程碑「显示已领取但零收益」。
    const state = findMilestoneState(
      draft as { activity?: Record<string, Record<string, unknown> | undefined> },
      body.activityId,
    );
    if (state && milestoneId) {
      if (!Array.isArray(state.got)) state.got = [];
      if (state.got.includes(milestoneId)) return; // 已领取
      const cfg = resolveMilestoneConfigs(body.activityId).find(
        (m) => m.id === milestoneId,
      );
      if (!cfg) {
        logger.warn(
          "milestone",
          `${body.activityId} 里程碑 ${milestoneId} 无配置，拒绝领取`,
        );
        return;
      }
      if ((state.point ?? 0) < cfg.need) {
        logger.warn(
          "milestone",
          `${body.activityId} 里程碑 ${milestoneId} 未达标（point=${state.point} < ${cfg.need}）`,
        );
        return;
      }
      state.got.push(milestoneId);
      if (cfg.reward) rewards.push(cfg.reward);
      return;
    }
    // 兜底：无标准 milestone 结构时沿用 MILESTONE_ONLY 标记（无配置可发，不发奖）
    const store = (draft.activity.MILESTONE_ONLY ??= {});
    if (!store[body.activityId]) store[body.activityId] = {};
    if (milestoneId) store[body.activityId][milestoneId] = 0;
  });
  // 奖励入账（与既有领奖路由一致：经物品管道落库存）
  if (rewards.length > 0) {
    for (const it of rewards) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  return {
    ...player.delta,
    item: rewards,
  } satisfies RewardMilestoneResponse;
}


export async function handleRewardAllMilestone(player: PlayerDataManager, body: RewardAllMilestoneRequest) {
  const rewards: ItemBundle[] = [];
  await player.update(async (draft) => {
    // 修复（2026-09-09）：批量领取按配置表枚举「已达标且未领」的里程碑并逐个发奖——
    // 原实现 BOSS_RUSH 直接 return（空操作）、通用分支只把已有键标 0（不发奖）。
    const state = findMilestoneState(
      draft as { activity?: Record<string, Record<string, unknown> | undefined> },
      body.activityId,
    );
    if (state) {
      if (!Array.isArray(state.got)) state.got = [];
      for (const cfg of resolveMilestoneConfigs(body.activityId)) {
        if (!cfg.id || state.got.includes(cfg.id)) continue;
        if ((state.point ?? 0) < cfg.need) continue;
        state.got.push(cfg.id);
        if (cfg.reward) rewards.push(cfg.reward);
      }
      return;
    }
    const store = (draft.activity.MILESTONE_ONLY ??= {});
    if (!store[body.activityId]) store[body.activityId] = {};
    for (const milestoneId of Object.keys(store[body.activityId])) {
      store[body.activityId][milestoneId] = 0;
    }
  });
  if (rewards.length > 0) {
    for (const it of rewards) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  return {
    ...player.delta,
    item: rewards,
  } satisfies RewardAllMilestoneResponse;
}

export async function handleConfirmActivityMission(player: PlayerDataManager, body: ConfirmActivityMissionRequest) {
  const rewards = await confirmOneActivityMission(player, body.missionId);
   return {
    ...player.delta,
    items: rewards,
  } satisfies ConfirmActivityMissionResponse;
}

export async function handleConfirmActivityMissionList(player: PlayerDataManager, body: ConfirmActivityMissionListRequest) {
  const allRewards: ItemBundle[] = [];
   // 与单条版共用 confirmOneActivityMission（此前列表版为复制体，漏做了
  // act1arkhub_token_seal → ARK_HUB.coin/tshop.coin 同步，行为已分叉——现统一）
  for (const missionId of body.missionIdList || []) {
    allRewards.push(
      ...(await confirmOneActivityMission(player, missionId, {
        tolerateFailure: true,
      })),
    );
  }
   return {
    ...player.delta,
    items: allRewards,
  } satisfies ConfirmActivityMissionListResponse;
}

export async function handleConfirmActivityMissionGroup(player: PlayerDataManager, body: ConfirmActivityMissionGroupRequest) {
  let rewards: ItemBundle[] = [];
   // 修复：同 confirmActivityMission——按 MissionTable.missionGroups 归属分流，
  // 避免原 try/catch 依赖 confirmMissionGroup 抛错触发兜底（其已改为未知组静默返回）
  if (excel.MissionTable.missionGroups[body.missionGroupId]) {
    try {
      await player.mission.confirmMissionGroup({
        missionGroupId: body.missionGroupId,
      });
    } catch {
      logger.warn(
        "activity",
        `confirmMissionGroup ${body.missionGroupId} 失败，跳过`,
      );
    }
  } else {
    // 兜底逻辑：从 ActivityTable.missionGroup 中查找组奖励
    const groupInfo = excel.ActivityTable.missionGroup.find(
      (g) => g.id === body.missionGroupId,
    );
    if (groupInfo && groupInfo.rewards) {
      rewards = groupInfo.rewards.map((r) => ({
        id: r.id,
        count: r.count,
        type: ItemTypeToString(r.type) as ItemType,
      }));
      for (const it of rewards) player.gainItem.add(it);
      await player.gainItem.handle();
    }
    await player.update(async (draft) => {
      draft.mission.missionGroups[body.missionGroupId] = 1;
    });
  }
   return {
    ...player.delta,
    items: rewards,
  } satisfies ConfirmActivityMissionGroupResponse;
}

export async function handleAutoConfirmMissions(player: PlayerDataManager, body: AutoConfirmMissionsRequest) {
  const allRewards: ItemBundle[] = [];
   // 活动任务（ACTIVITY）：MissionManager 不跟踪运行时播种的活动任务（无 MissionProgress
  // 实例），且 confirmMission 对 state==2 的任务不发放 → 原 try 路径返回空且不抛错，
  // catch 兜底死代码 → 活动任务自动领取失效；ACTIVITY 类型直接走手动遍历
  if (body.type === "ACTIVITY") {
    allRewards.push(...(await autoConfirmActivityMissionsIn(player, "ACTIVITY")));
    if (allRewards.length > 0) {
      for (const it of allRewards) player.gainItem.add(it);
      await player.gainItem.handle();
    }
  } else {
    try {
      const items = await player.mission.autoConfirmMissions({
        type: body.type as ItemType,
      });
      allRewards.push(...items);
    } catch {
      // 兜底逻辑：直接遍历玩家数据中的任务
      allRewards.push(
        ...(await autoConfirmActivityMissionsIn(player, body.type)),
      );
      if (allRewards.length > 0) {
        for (const it of allRewards) player.gainItem.add(it);
        await player.gainItem.handle();
      }
    }
  }
   return {
    ...player.delta,
    items: allRewards,
  } satisfies AutoConfirmMissionsResponse;
}

export async function handleExchangeActivityShopItem(player: PlayerDataManager, body: ExchangeActivityShopItemRequest) {
  const count = body.count ?? 1;
  // 修复（2026-09-09）：count 必须为正整数。原实现 `body.count || 1` 直接透传负数 →
  // recordPurchase 的 `existing.count += count` 会把已购数量**减回去**（负数还会让
  // 「已购 count」变负），从而绕过活动商店的限购判定再买一轮。
  if (!Number.isInteger(count) || count <= 0) {
    logger.warn(
      "milestone",
      `exchangeActivityShopItem 非法 count=${body.count}（shop=${body.shopId} good=${body.goodId}），拒绝`,
    );
    return {
      ...player.delta,
      items: [],
    } satisfies ExchangeActivityShopItemResponse;
  }
  let rewardItem: ItemBundle | null = null;
   await player.update(async (draft) => {
    // 初始化模板商店数据（如果不存在）
    if (!draft.tshop[body.shopId]) {
      draft.tshop[body.shopId] = {
        coin: 0,
        info: [],
        progressInfo: {},
      };
    }
    const shop = draft.tshop[body.shopId];
    // 记录购买（与 shop.SOCIAL.info / crisis.shop.info 同一「存在累加否则追加」语义，
    // 共享实现见 @game/kernel/util/purchase-record）
    recordPurchase(shop.info, body.goodId, count);
  });
   if (rewardItem) {
    await player.gainItem.add(rewardItem).handle();
  }
   return {
    ...player.delta,
    items: rewardItem ? [rewardItem] : [],
  } satisfies ExchangeActivityShopItemResponse;
}

export async function handleGetActivityCollectionReward(player: PlayerDataManager, body: GetActivityCollectionRewardRequest) {
  const rewards: ItemBundle[] = [];
  let claimed = false;
   await player.update(async (draft) => {
    if (!draft.activity.COLLECTION) {
      draft.activity.COLLECTION = {};
    }
    const collectionData = draft.activity.COLLECTION;
    if (!collectionData[body.activityId]) {
      collectionData[body.activityId] = {};
    }
    // 修复：已领取过的收集奖励不再发放（原实现写标记但从不读 → 可重复领）
    if (body.collectionId != null && collectionData[body.activityId][body.collectionId] !== undefined) {
      claimed = true;
      return;
    }
    // 从配置表查找收集奖励
    // 修复：excel activity 字典键大小写随数据版本多变（cOLLECTION 旧坏键/collection 规范键）
    // ——动态查键，不再依赖固定大小写
    const collectionKey = activityDictKey("COLLECTION") ?? "cOLLECTION";
    const collectionConfig = asShape<{
      collections?: { id: string; itemId: string; itemCnt: number }[];
    }>(activityDetailJson(excel.ActivityTable.activity, collectionKey, body.activityId));
    if (
      collectionConfig &&
      collectionConfig.collections &&
      body.collectionId != null
    ) {
      const collectionInfo = collectionConfig.collections.find(
        (c) => c.id === String(body.collectionId),
      );
      if (collectionInfo) {
        // 配置仅给 itemId/itemCnt（无 itemType）——保持原行为，按 ItemBundle 形状入队
        const rewardItem = asShape<ItemBundle>({
          id: collectionInfo.itemId,
          count: collectionInfo.itemCnt,
        });
        if (rewardItem) rewards.push(rewardItem);
      }
    }
    // 标记收集项为已领取（0 表示已领取）
    if (body.collectionId != null) {
      collectionData[body.activityId][body.collectionId] = 0;
    }
  });
   if (!claimed && rewards.length > 0) {
    for (const it of rewards) player.gainItem.add(it);
    await player.gainItem.handle();
  }
   return {
    ...player.delta,
    item: rewards,
  } satisfies GetActivityCollectionRewardResponse;
}

export async function handleGetActivityShopInfo(player: PlayerDataManager, body: GetActivityShopInfoRequest) {
  const tshop: { [key: string]: PlayerTemplateShop } = player._playerdata.tshop || {};
  const shopInfo = tshop[body.shopId] || { coin: 0, info: [], progressInfo: {} };
   return {
    ...player.delta,
    shopInfo,
  } satisfies GetActivityShopInfoResponse;
}