/**
 * 活动拆分共用辅助（由 router/activity.ts 拆分而来，实现未改动）
 *
 * 多活动族共用的模块级函数集中于此，各族 router 按需导入。
 */
import { PlayerDataManager } from "../../../kernel/player-data-manager";
import { ItemBundle, ItemType } from "@excel/excel";
import excel from "@excel/excel";
import { logger } from "@utils/logger";
import config from "@core/config/index";
import { arkhubSyncMissionCoin } from "../arkhub/public";
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
} from "./activity";

export function miniBattleStart(player: PlayerDataManager) {
  return {
    result: 0,
    battleId: "abcdefgh-1234-5678-a1b2c3d4e5f6",
    apFailReturn: 0,
    isApProtect: 0,
    inApProtectPeriod: false,
    notifyPowerScoreNotEnoughIfFailed: false,
    ...player.delta,
  } satisfies ActivityMiniBattleStartResponse;
}

export function miniBattleFinish(player: PlayerDataManager, body: ActivityMiniBattleFinishRequest) {
  reqBodyRef(body);
  return player.delta satisfies ActivityMiniBattleFinishResponse;
}

export function reqBodyRef(_body: ActivityMiniBattleFinishRequest): void {
  /* 无操作：stub 路由不读取请求体 */
}

/**
 * 确认单个活动任务并返回奖励（confirmActivityMission / confirmActivityMissionList 共用核心）
 *
 * 按 MissionTable 归属分流：在 MissionTable 中的任务交 mission manager（其内部自行入账）；
 * 否则走 ActivityTable.missionData 兜底——标记 state=3、转换奖励类型，并同步枢纽任务
 * 的 token_seal → ARK_HUB.coin / tshop.shop_act1arkhub.coin（官服形状，与 mission manager
 * 的 _confirmActivityTableMission 一致）。兜底奖励经 items:get 入账。
 *
 * @param tolerateFailure - true 时 confirmMission 抛错降级为 warn 并跳过（列表版用）
 */
export async function confirmOneActivityMission(
  player: PlayerDataManager,
  missionId: string,
  opts: { tolerateFailure?: boolean } = {},
): Promise<ItemBundle[]> {
  const rewards: ItemBundle[] = [];
  if (excel.MissionTable.missions[missionId]) {
    try {
      const items = await player.mission.confirmMission({ missionId });
      rewards.push(...items);
    } catch (e) {
      if (!opts.tolerateFailure) throw e;
      logger.warn("activity", `confirmMission ${missionId} 失败，跳过`);
    }
    return rewards;
  }
  // 兜底逻辑：从 ActivityTable.missionData 中查找任务奖励
  const missionInfo = excel.ActivityTable.missionData.find(
    (m) => m.id === missionId,
  );
  if (!missionInfo) return rewards;
  for (const reward of missionInfo.rewards) {
    rewards.push({
      id: reward.id,
      count: reward.count,
      type: ItemTypeToString(reward.type) as ItemType,
    });
  }
  await player.update(async (draft) => {
    const activityMissions = draft.mission.missions["ACTIVITY"];
    if (activityMissions && activityMissions[missionId]) {
      activityMissions[missionId].state = 3;
    }
    // 枢纽任务奖励 → ARK_HUB.coin / tshop.shop_act1arkhub.coin 同步（官服形状，
    // 与 mission manager 的 _confirmActivityTableMission 统一走 arkhub 模块实现）
    arkhubSyncMissionCoin(draft, missionInfo.rewards);
  });
  for (const it of rewards) player.gainItem.add(it);
  await player.gainItem.handle();
  return rewards;
}

/**
 * 遍历指定分组下 state==2 且进度已满的活动任务：置 state=3 并收集 ActivityTable 奖励
 * （autoConfirmMissions 的 ACTIVITY 直通分支与 catch 兜底分支共用此循环——两段此前逐字重复）
 */
export async function autoConfirmActivityMissionsIn(
  player: PlayerDataManager,
  group: string,
): Promise<ItemBundle[]> {
  const rewards: ItemBundle[] = [];
  await player.update(async (draft) => {
    const missions = draft.mission.missions[group];
    if (!missions) return;
    for (const [missionId, missionState] of Object.entries(missions)) {
      const isCompleted =
        missionState.state === 2 &&
        missionState.progress.length > 0 &&
        missionState.progress[0].target != null &&
        missionState.progress[0].value >= missionState.progress[0].target;
      if (!isCompleted) continue;
      missionState.state = 3;
      // 查找任务奖励
      const missionInfo = excel.ActivityTable.missionData.find(
        (m) => m.id === missionId,
      );
      if (missionInfo) {
        for (const reward of missionInfo.rewards) {
          rewards.push({
            id: reward.id,
            count: reward.count,
            type: ItemTypeToString(reward.type) as ItemType,
          });
        }
      }
    }
  });
  return rewards;
}

export function collectRawBody(req: import("express").Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 方舟枢纽对外完整地址（config.Host + PORT 补全）
 * config.Host 通常无端口（如 "http://127.0.0.1"），而私服实际监听 config.PORT——
 * getPixelArt 返回的像素下载 url 必须带端口，否则客户端按默认 80 端口下载 → 失败"数据异常"。
 * Host 已含端口（如自定义 "http://192.168.1.5:9000"）时不重复补。
 */
export function arkhubFullHost(): string {
  const host = String(config.Host).replace(/\/$/, "");
  const authority = host.replace(/^https?:\/\//, "");
  return /:\d+$/.test(authority) ? host : `${host}:${config.PORT}`;
}

/**
 * 将 ItemType 枚举值转换为字符串类型标识
 * @param itemType - ItemType 枚举值
 * @returns 对应的字符串类型标识
 *
 * 用于将配置表中的数字类型枚举转换为 inventory manager 可识别的字符串类型。
 */
export function ItemTypeToString(itemType: number | string): string {
  const key = typeof itemType === "string" ? parseInt(itemType, 10) : itemType;
  if (isNaN(key)) return String(itemType);
  const itemTypeMap: { [key: number]: string } = {
    0: "NONE",
    1: "CHAR",
    2: "CARD_EXP",
    3: "MATERIAL",
    4: "GOLD",
    5: "EXP_PLAYER",
    6: "TKT_TRY",
    7: "TKT_RECRUIT",
    8: "TKT_INST_FIN",
    9: "TKT_GACHA",
    10: "DIAMOND",
    11: "DIAMOND_SHD",
    12: "LGG_SHD",
    13: "HGG_SHD",
    14: "FURN",
    15: "ACTIVITY_COIN",
    16: "AP_GAMEPLAY",
    17: "AP_BASE",
    18: "SOCIAL_PT",
    19: "CHAR_SKIN",
    20: "TKT_GACHA_10",
    21: "AP_ITEM",
    22: "AP_SUPPLY",
    23: "RENAMING_CARD",
    24: "RENAMING_CARD_2",
    25: "ET_STAGE",
    26: "ACTIVITY_ITEM",
    27: "VOUCHER_PICK",
    28: "VOUCHER_CGACHA",
    29: "VOUCHER_MGACHA",
    30: "CRS_SHOP_COIN",
    31: "CRS_RUNE_COIN",
    32: "LMTGS_COIN",
    33: "EPGS_COIN",
    34: "LIMITED_TKT_GACHA_10",
    35: "LIMITED_FREE_GACHA",
    36: "REP_COIN",
    37: "ROGUELIKE",
    38: "LINKAGE_TKT_GACHA_10",
    39: "VOUCHER_ELITE_II_4",
    40: "VOUCHER_ELITE_II_5",
    41: "VOUCHER_ELITE_II_6",
    42: "VOUCHER_SKIN",
    43: "RETRO_COIN",
    44: "PLAYER_AVATAR",
    45: "UNI_COLLECTION",
    46: "VOUCHER_FULL_POTENTIAL",
    47: "RL_COIN",
    48: "RETURN_CREDIT",
    49: "MEDAL",
    50: "CHARM",
    51: "HOME_BACKGROUND",
    52: "EXTERMINATION_AGENT",
    53: "OPTIONAL_VOUCHER_PICK",
    54: "ACT_CART_COMPONENT",
    55: "VOUCHER_LEVELMAX_6",
    56: "VOUCHER_LEVELMAX_5",
    57: "VOUCHER_LEVELMAX_4",
    58: "VOUCHER_SKILL_SPECIALLEVELMAX_6",
    59: "VOUCHER_SKILL_SPECIALLEVELMAX_5",
    60: "VOUCHER_SKILL_SPECIALLEVELMAX_4",
    61: "ACTIVITY_POTENTIAL",
    62: "ITEM_PACK",
    63: "SANDBOX",
    64: "FAVOR_ADD_ITEM",
    65: "CLASSIC_SHD",
    66: "CLASSIC_TKT_GACHA",
    67: "CLASSIC_TKT_GACHA_10",
    68: "LIMITED_BUFF",
    69: "CLASSIC_FES_PICK_TIER_5",
    70: "CLASSIC_FES_PICK_TIER_6",
    71: "RETURN_PROGRESS",
    72: "NEW_PROGRESS",
    73: "MCARD_VOUCHER",
    74: "MATERIAL_ISSUE_VOUCHER",
    75: "CRS_SHOP_COIN_V2",
    76: "HOME_THEME",
    77: "SANDBOX_PERM",
    78: "SANDBOX_TOKEN",
    79: "TEMPLATE_TRAP",
    80: "NAME_CARD_SKIN",
    81: "EXCLUSIVE_TKT_GACHA",
    82: "EXCLUSIVE_TKT_GACHA_10",
  };
  return itemTypeMap[key] || "MATERIAL";
}
