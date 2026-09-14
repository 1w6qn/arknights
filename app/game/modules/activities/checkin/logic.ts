/**
 * 活动路由：checkin（由 router/activity.ts 拆分而来，实现未改动）
 */
import { ItemTypeToString } from "../shared/shared";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { ItemBundle, ItemType } from "@excel/excel";
import excel from "@excel/excel";
import { now } from "@utils/time";
import { activityDictKey } from "../shared/unlockActivity";
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
  CheckinAllPlayerCheckinRequest,
  CheckinAllPlayerCheckinResponse,
  CheckinAllPlayerGetAllRewardRequest,
  CheckinAllPlayerGetAllRewardResponse,
  CheckinAllPlayerSyncRequest,
  CheckinAllPlayerSyncResponse,
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
  LoginOnlyGetRewardRequest,
  LoginOnlyGetRewardResponse,
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

import { PlayerDataManager } from "../../../kernel/player-data-manager";
import { activityDetailJson, asShape } from "../shared/activity-json";

/* ===== excel 活动详情消费面（未建模 JSON 的局部视图，仅读取官方表） ===== */

/** 表内奖励条目（与生成模型 ItemBundle 同形；活动详情是未建模 JSON） */
type TableItemBundle = { id: string; count: number; type: ItemType };

/** 签到日配置（checkInList[day]） */
type CheckinDailyConfig = { isDynItem?: boolean; itemList?: TableItemBundle[] };

/** CHECKIN_ONLY / CHECKIN_ALL_PLAYER 详情消费面 */
type CheckinDetailConfig = {
  checkInList?: { [day: string]: CheckinDailyConfig };
  dynCheckInData?: { dynItemDict?: { [opt: string]: TableItemBundle[] } };
};

/** CHECKIN_VS 详情消费面 */
type CheckinVsDetailConfig = {
  checkInDict?: { [day: string]: { rewardList?: TableItemBundle[] } };
};

/** SWITCH_ONLY 详情消费面 */
type SwitchDetailConfig = { rewards?: { [rewardId: string]: TableItemBundle[] } };

/** LOGIN_ONLY 详情消费面 */
type LoginDetailConfig = { itemList?: TableItemBundle[] };

/**
 * 读取活动详情并投影为调用方声明的消费面
 * @param typeEnum - 活动类型枚举名（经 activityDictKey 容错解析）
 * @param fallbackKey - 键未命中时的历史回退键（保持原行为）
 * @param actId - 活动 id
 * @returns 详情视图（未命中返回 undefined）
 */
function activityConfigView<T>(
  typeEnum: string,
  fallbackKey: string,
  actId: string,
): T | undefined {
  return asShape<T>(
    activityDetailJson(excel.ActivityTable.activity, activityDictKey(typeEnum) ?? fallbackKey, actId),
  );
}

/**
 * checkin 活动族业务逻辑（建议 11：族包五件套——router 仅路由注册，业务收敛于 logic）
 *
 * 由 router.ts 内联 handler 提取（实现未改动）：每个活动接口一个具名函数，
 * 输入 player + 请求体，返回响应对象（原 res.send 载荷）。
 */

export async function handleGetChainLogInReward(player: PlayerDataManager, body: GetChainLogInRewardRequest) {
  return ({
    reward: await player.openServer.getChainLogInReward(body),
    ...player.delta,
  } satisfies GetChainLogInRewardResponse);
}

export async function handleGetChainLogInFinalRewards(player: PlayerDataManager, body: GetChainLogInFinalRewardsRequest) {
  return ({
    reward: await player.openServer.getChainLogInFinalRewards(),
    ...player.delta,
  } satisfies GetChainLogInFinalRewardsResponse);
}

export async function handleGetOpenServerCheckInReward(player: PlayerDataManager, body: GetOpenServerCheckInRewardRequest) {
  // 读类缺参校验：index 为必填，缺失时返回业务错误
  if (body.index == null) {
    return ({ result: 1, ...player.delta });
  }
  return ({
    reward: await player.openServer.getCheckInReward(body),
    ...player.delta,
  } satisfies GetOpenServerCheckInRewardResponse);
}

/**
 * 活动签到天数门槛（CHECKIN_ONLY / CHECKIN_ALL_PLAYER 共用）
 *
 * 修复（2026-09-09，§5.6-7）：原实现只看 `history[index] === 0`（已领取标记），既不校验
 * 「index 对应已签天数」也不读 `lastTs` —— 一次请求即可把全部 index 领完。
 * 官方口径：每日 1 次、index 对应自活动开始已过的天数。
 * 起始时间取 `ActivityTable.basicInfo[activityId].startTime`（缺失时不设天数门槛，容错放行）。
 * @param activityId - 活动 id
 * @param targetIndex - 目标档位
 * @param lastTs - 该活动上次签到时间戳（秒，0 = 从未签到）
 * @param nowTs - 当前时间（秒）
 * @returns 拒绝原因（null = 允许领取）
 */
function checkinDayGate(
  activityId: string,
  targetIndex: number,
  lastTs: number,
  nowTs: number,
): "index" | "today" | null {
  if (targetIndex < 0) return "index";
  const startTs = Number(excel.ActivityTable.basicInfo?.[activityId]?.startTime ?? 0);
  if (startTs > 0) {
    const dayIndex = Math.floor((nowTs - startTs) / 86400);
    if (targetIndex > dayIndex) return "index"; // 尚未签到到该天数
  }
  if (lastTs > 0 && Math.floor(lastTs / 86400) >= Math.floor(nowTs / 86400)) {
    return "today"; // 同一自然日只能签到一次
  }
  return null;
}

export async function handleGetActivityCheckInReward(player: PlayerDataManager, body: GetActivityCheckInRewardRequest) {
  // 缺参校验：activityId/index 为必填，缺失时返回业务错误
  if (body.activityId == null || body.index == null) {
    return ({ result: 1, ...player.delta });
  }
  const activityId = body.activityId;
  const targetIndex = body.index;
  const nowTs = now(); // @utils/time.now() 已是秒级时间戳（勿再 /1000）
  let already = false;
  let blocked = false;

  await player.update(async (draft) => {
    if (!draft.activity) {
      draft.activity = {};
    }
    if (!draft.activity.CHECKIN_ONLY) {
      draft.activity.CHECKIN_ONLY = {};
    }
    if (!draft.activity.CHECKIN_ONLY[activityId]) {
      draft.activity.CHECKIN_ONLY[activityId] = {
        lastTs: 0,
        history: [],
      };
    }
    const data = draft.activity.CHECKIN_ONLY[activityId];
    // 修复：已领取的 index 不再重复发奖（原实现恒置 0 → 可重复刷）
    if (data.history[targetIndex] === 0) {
      already = true;
      return;
    }
    // 修复（§5.6-7）：天数门槛 + 每日 1 次
    if (checkinDayGate(activityId, targetIndex, Number(data.lastTs ?? 0), nowTs)) {
      blocked = true;
      return;
    }
    data.history[targetIndex] = 0;
    data.lastTs = nowTs;
  });

  if (already || blocked) {
    return ({
      ...player.delta,
      items: [],
    } satisfies GetActivityCheckInRewardResponse);
  }

  // 从 excel 读取签到奖励（值一律从表读，不硬编码）
  // 修复：excel activity 字典键大小写随数据版本多变（cHECKIN_ONLY 旧坏键/checkinOnly 规范键）
  const checkinConfig = activityConfigView<CheckinDetailConfig>(
    "CHECKIN_ONLY",
    "cHECKIN_ONLY",
    activityId,
  );
  const daily = checkinConfig?.checkInList?.[String(targetIndex)];
  let rewards: ItemBundle[] = [];

  if (daily?.isDynItem && body.dynOpt) {
    // 动态签到日：奖励按 dynOpt 从 dynItemDict 读取（如 act43sign 月饼制作选项）
    rewards = checkinConfig?.dynCheckInData?.dynItemDict?.[body.dynOpt] ?? [];
  } else {
    rewards = daily?.itemList ?? [];
  }

  if (rewards.length > 0) {
    for (const reward of rewards) {
      player.gainItem.add({
        id: reward.id,
        count: reward.count,
        type: ItemTypeToString(reward.type) as ItemType,
      });
    }
    await player.gainItem.handle();
  }

  return ({
    ...player.delta,
    items: rewards,
  } satisfies GetActivityCheckInRewardResponse);
}

export async function handleActCheckinvssign(player: PlayerDataManager, body: ActCheckinvsSignRequest) {
  let rewards: ItemBundle[] = [];
  let claimed = false;

  await player.update(async (draft) => {
    const actId = body.actId;
    const tasteChoice = body.tasteChoice;
    if (!draft.activity) {
      draft.activity = {};
    }
    if (!draft.activity.CHECKIN_VS) {
      draft.activity.CHECKIN_VS = {};
    }
    const vsData = draft.activity.CHECKIN_VS;
    if (!vsData[actId]) {
      vsData[actId] = {
        sweetVote: 0,
        saltyVote: 0,
        canVote: true,
        todayVoteState: 0,
        voteRewardState: 0,
        signedCnt: 0,
        availSignCnt: 1,
        socialState: 2,
        actDay: 1,
      };
    }
    const actData = vsData[actId];
    // 修复：签到次数限制（availSignCnt 未校验 → 无限签到刷奖励）
    if ((actData.signedCnt ?? 0) >= (actData.availSignCnt ?? 1)) {
      claimed = true;
      return;
    }
    actData.signedCnt++;
    actData.canVote = false;
    if (tasteChoice === 1) {
      actData.sweetVote++;
    } else if (tasteChoice === 2) {
      actData.saltyVote++;
    }
    actData.todayVoteState = 2;
  });

  if (!claimed) {
    // 从 excel 读取当日签到奖励（按已签天数取 checkInDict[day]，值从表读不硬编码）
    const vsConfig = activityConfigView<CheckinVsDetailConfig>(
      "CHECKIN_VS",
      "cHECKIN_VS",
      body.actId,
    );
    const day = player._playerdata.activity?.CHECKIN_VS?.[body.actId]?.signedCnt ?? 1;
    const daily = vsConfig?.checkInDict?.[String(day)];
    rewards = daily?.rewardList ?? [];

    if (rewards.length > 0) {
      for (const reward of rewards) {
        player.gainItem.add({
          id: reward.id,
          count: reward.count,
          type: ItemTypeToString(reward.type) as ItemType,
        });
      }
      await player.gainItem.handle();
    }
  }

  return ({
    ...player.delta,
    items: rewards,
  } satisfies ActCheckinvsSignResponse);
}

export async function handleGetSwitchOnlyReward(player: PlayerDataManager, body: GetSwitchOnlyRewardRequest) {
  let rewards: ItemBundle[] = [];
  let claimed = false;

  await player.update(async (draft) => {
    const activityId = body.activityId;
    const rewardId = body.reward;
    if (!draft.activity) {
      draft.activity = {};
    }
    if (!draft.activity.SWITCH_ONLY) {
      draft.activity.SWITCH_ONLY = {};
    }
    const switchData = draft.activity.SWITCH_ONLY;
    if (!switchData[activityId]) {
      switchData[activityId] = {};
    }
    // 修复：已领取的奖励不再重复发（原实现只写标记不校验 → 可重复刷）
    if (switchData[activityId][rewardId] === 0) {
      claimed = true;
      return;
    }
    switchData[activityId][rewardId] = 0;
  });

  if (!claimed) {
    // 从 excel 读取开关奖励（值从表读不硬编码）
    const switchConfig = activityConfigView<SwitchDetailConfig>(
      "SWITCH_ONLY",
      "sWITCH_ONLY",
      body.activityId,
    );
    rewards = switchConfig?.rewards?.[body.reward] ?? [];

    if (rewards.length > 0) {
      for (const reward of rewards) {
        player.gainItem.add({
          id: reward.id,
          count: reward.count,
          type: ItemTypeToString(reward.type) as ItemType,
        });
      }
      await player.gainItem.handle();
    }
  }

  return ({
    ...player.delta,
    items: rewards,
  } satisfies GetSwitchOnlyRewardResponse);
}

/**
 * 登录奖励领取（LOGIN_ONLY，excel `activity.loginOnly[actId].itemList`）
 * 协议：CS LoginOnlyService.GET_REWARD "/activity/loginOnly/getReward"；
 * 官服抓包 R-1707618442119.734-4504：响应 `{ reward: [...], playerDataDelta }`，
 * delta 写 `activity.LOGIN_ONLY[actId].reward = 0`（0=已领）。
 */
export async function handleLoginOnlyGetReward(player: PlayerDataManager, body: LoginOnlyGetRewardRequest) {
  const activityId = body.activityId;
  if (activityId == null) {
    return ({ result: 1, ...player.delta });
  }

  let already = false;
  await player.update(async (draft) => {
    if (!draft.activity) {
      draft.activity = {};
    }
    if (!draft.activity.LOGIN_ONLY) {
      draft.activity.LOGIN_ONLY = {};
    }
    const data = draft.activity.LOGIN_ONLY;
    if (!data[activityId]) {
      data[activityId] = { reward: 1 };
    }
    if (data[activityId].reward === 0) {
      already = true;
      return;
    }
    data[activityId].reward = 0;
  });

  if (already) {
    return ({
      ...player.delta,
      reward: [],
    } satisfies LoginOnlyGetRewardResponse);
  }

  // 从 excel 读取登录奖励（值从表读不硬编码）
  const loginConfig = activityConfigView<LoginDetailConfig>(
    "LOGIN_ONLY",
    "lOGIN_ONLY",
    activityId,
  );
  const rewards: ItemBundle[] = loginConfig?.itemList ?? [];

  if (rewards.length > 0) {
    for (const reward of rewards) {
      player.gainItem.add({
        id: reward.id,
        count: reward.count,
        type: ItemTypeToString(reward.type) as ItemType,
      });
    }
    await player.gainItem.handle();
  }

  return ({
    ...player.delta,
    reward: rewards,
  } satisfies LoginOnlyGetRewardResponse);
}

/**
 * 全服签到活动签到（CHECKIN_ALL_PLAYER，excel `activity.checkinAllPlayer[actId].checkInList`）
 * 协议：CS CheckinAllPlayerServiceCode.CHECKIN "/activity/checkinAllPlayer/getActivityCheckInReward"
 */
export async function handleCheckinAllPlayerCheckin(
  player: PlayerDataManager,
  body: CheckinAllPlayerCheckinRequest,
) {
  const activityId = body.activityId;
  const targetIndex = body.index;
  if (activityId == null || targetIndex == null) {
    return ({ result: 1, ...player.delta });
  }

  const nowTs = now(); // @utils/time.now() 已是秒级时间戳（勿再 /1000）
  let already = false;
  let blocked = false;
  await player.update(async (draft) => {
    if (!draft.activity) {
      draft.activity = {};
    }
    if (!draft.activity.CHECKIN_ALL_PLAYER) {
      draft.activity.CHECKIN_ALL_PLAYER = {};
    }
    if (!draft.activity.CHECKIN_ALL_PLAYER[activityId]) {
      draft.activity.CHECKIN_ALL_PLAYER[activityId] = {
        lastTs: 0,
        history: [],
      };
    }
    const data = draft.activity.CHECKIN_ALL_PLAYER[activityId];
    if (data.history[targetIndex] === 0) {
      already = true;
      return;
    }
    // 修复（§5.6-7）：天数门槛 + 每日 1 次（与 CHECKIN_ONLY 同口径）
    if (checkinDayGate(activityId, targetIndex, Number(data.lastTs ?? 0), nowTs)) {
      blocked = true;
      return;
    }
    data.history[targetIndex] = 0;
    data.lastTs = nowTs;
  });

  if (already || blocked) {
    return ({
      ...player.delta,
      items: [],
    } satisfies CheckinAllPlayerCheckinResponse);
  }

  const config = activityConfigView<CheckinDetailConfig>(
    "CHECKIN_ALL_PLAYER",
    "cHECKIN_ALL_PLAYER",
    activityId,
  );
  const daily = config?.checkInList?.[String(targetIndex)];
  const rewards: ItemBundle[] = daily?.itemList ?? [];

  if (rewards.length > 0) {
    for (const reward of rewards) {
      player.gainItem.add({
        id: reward.id,
        count: reward.count,
        type: ItemTypeToString(reward.type) as ItemType,
      });
    }
    await player.gainItem.handle();
  }

  return ({
    ...player.delta,
    items: rewards,
  } satisfies CheckinAllPlayerCheckinResponse);
}

/**
 * 全服签到活动行为数据同步（SYNC_DATA）
 * 行为进度（pubBhvs/personalBhvs）依赖战斗/助战统计，第一档仅空增量返回；
 * TODO：行为进度事件化后按 excel AllPlayerCheckinData.pubBhvs 填充。
 */
export async function handleCheckinAllPlayerSync(
  player: PlayerDataManager,
  body: CheckinAllPlayerSyncRequest,
) {
  return (player.delta satisfies CheckinAllPlayerSyncResponse);
}

/**
 * 全服签到活动行为奖励领取（GET_ALL_REWARD）
 * 行为奖励需行为进度统计支撑，第一档仅空增量返回；
 * TODO：行为进度事件化后按 excel pubBhvs.rewards 发放。
 */
export async function handleCheckinAllPlayerGetAllReward(
  player: PlayerDataManager,
  body: CheckinAllPlayerGetAllRewardRequest,
) {
  return ({
    ...player.delta,
    items: [],
  } satisfies CheckinAllPlayerGetAllRewardResponse);
}

export async function handleGetCheckInReward(player: PlayerDataManager, body: GetCheckInRewardRequest) {
   const activityId = body.activityId;
  // 缺参校验：activityId 为必填，缺失时返回业务错误（避免 activityId.endsWith 抛 TypeError → 500）
  if (activityId == null) {
    return ({ result: 1, ...player.delta });
  }
  if (activityId.endsWith("access")) {
    // TODO：本地 excel 无 CHECKIN_ACCESS 活动配置（activity_table.json 仅 basicInfo），
    // 奖励暂按官服抓包 R-1714621119603.1292-4500（act1access：DIAMOND_SHD 200 + ap_supply_lt_80）
    // 固定发放；待数据源补全后改为从 excel 读取。
    const REWARDS: ItemBundle[] = [
      { type: "AP_SUPPLY" as ItemType, id: "ap_supply_lt_80", count: 1 },
      { type: "DIAMOND_SHD" as ItemType, id: "4003", count: 200 },
    ];
    let already = false;
    await player.update(async (draft) => {
      // CHECKIN_ACCESS 键由活动解锁播种（basicInfo 可能无该活动）：保持原语义不在此建键，
      // 缺键时与原 `as any` 直取行为一致（同样抛错）。
      const access = draft.activity.CHECKIN_ACCESS!;
      if (!access[activityId]) {
        access[activityId] = {
          rewardsCount: 0,
          currentStatus: 0,
          lastTs: 0,
        };
      }
      const data = access[activityId];
      // 修复：每日限领一次（原实现 rewardsCount 无限累加、无任何限制）
      const dayKey = Math.floor(Date.now() / 86400000);
      if (Math.floor((data.lastTs || 0) / 86400000) === dayKey) {
        already = true;
        return;
      }
      data.rewardsCount++;
      data.lastTs = Math.floor(Date.now() / 1000);
    });
    // 修复：奖励入账（原实现只回显 items 从不发放 → 领了但没到账；统一走 gainItem 管道）
    if (!already) {
      for (const reward of REWARDS) {
        player.gainItem.add(reward);
      }
      await player.gainItem.handle();
    }
    return ({
      ...player.delta,
      items: already ? [] : REWARDS,
    } satisfies GetCheckInRewardResponse);
  } else if (activityId.endsWith("blessing")) {
    await player.update(async (draft) => {
      const blessData = draft.activity.BLESS_ONLY!;
      if (!blessData[activityId]) {
        blessData[activityId] = {};
      }
    });
     return ({
      ...player.delta,
      items: [],
    } satisfies GetCheckInRewardResponse);
  } else {
    return ({
      ...player.delta,
      items: [],
    } satisfies GetCheckInRewardResponse);
  }
}

export async function handleChangeFestivalChar(player: PlayerDataManager, body: ChangeFestivalCharRequest) {
  // 缺参校验：activityId/index/newChar 缺失时返回业务错误
  if (body.activityId == null || body.index == null || body.newChar == null) {
    return ({ result: 1, ...player.delta });
  }
   await player.update(async (draft) => {
    const blessData = draft.activity.BLESS_ONLY!;
    if (!blessData[body.activityId]) {
      blessData[body.activityId] = { festivalHistory: [], history: [] };
    }
    const activityData = blessData[body.activityId];
    if (!activityData.festivalHistory) {
      activityData.festivalHistory = [];
    }
    if (!activityData.festivalHistory[body.index]) {
      activityData.festivalHistory[body.index] = { charId: body.newChar, state: 1 };
    } else {
      activityData.festivalHistory[body.index].charId = body.newChar;
    }
  });
   return (player.delta satisfies ChangeFestivalCharResponse);
}

export async function handleActBlessOnlygetCheckInReward(player: PlayerDataManager, body: ActivityStubRequest) {
  // TODO：本地 excel 无 BLESS_ONLY 活动配置（activity_table.json 仅 basicInfo/homeActConfig/dynActs，
  // 无 blessData 奖励表），无法从表推导奖励；官服抓包 act1blessing 为 DIAMOND_SHD 500（R-1708390915174.524-0096），
  // 待数据源补全后按 excel 实现，当前返回空增量。
  return ({
    items: [],
    ...player.delta,
  } satisfies ActivityStubItemsResponse);
}

export async function handleActBlessOnlychangeFestivalChar(player: PlayerDataManager, body: ActivityStubRequest) {
  return (player.delta satisfies ActivityStubResponse);
}

export async function handleActCheckinAccessgetCheckInReward(player: PlayerDataManager, body: ActivityStubRequest) {
  // TODO：本地 excel 无 CHECKIN_ACCESS 活动配置（activity_table.json 仅 basicInfo/homeActConfig/dynActs，
  // 无 checkinAccessData 奖励表），无法从表推导奖励；官服抓包 act1access 为 DIAMOND_SHD 200 +
  // ap_supply_lt_80（R-1714621119603.1292-4500），待数据源补全后按 excel 实现，当前返回空增量。
  return ({
    items: [],
    ...player.delta,
  } satisfies ActivityStubItemsResponse);
}

export async function handleYear5GeneralgetInfReward(player: PlayerDataManager, body: ActivityGetRewardRequest) {
  return ({
    items: [],
    ...player.delta,
  } satisfies ActivityStubItemsResponse);
}

