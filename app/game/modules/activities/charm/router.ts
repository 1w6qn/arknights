/**
 * 活动路由：charm（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import { ItemBundle } from "@excel/excel";
import excel from "@excel/excel";
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

const router = Router();
router.post("/recycleCharms", validateBody(ReqSchema.recycleCharmsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RecycleCharmsRequest;
  const charmIds = body.charmIds || [];
  let recycleNum = 0;

  await player.update(async (draft) => {
    const charms = draft.charm.charms;
    for (const charmId of charmIds) {
      if (charms[charmId] && charms[charmId] > 0) {
        charms[charmId] -= 1;
        recycleNum += 1;
        // 查找信物配置获取回收价格
        const charmInfo = excel.CharmTable.charmList.find((c) => c.id === charmId);
        // 修复（2026-09-09，两处）：
        // 1. **龙门币写错容器**：id 4001 / itemType GOLD 的龙门币余额在 @@status.gold@@，
        //    不在 @@inventory@@ —— 原实现写 @@draft.inventory["4001"]@@ 玩家一分钱拿不到，
        //    存档里反而多出一个幽灵 inventory 键（客户端与后续逻辑读 status.gold）。
        // 2. **返还额数据驱动**：@@CharmTable.charmList[].price@@（如 level_cost_1 = 15），
        //    原实现硬编码「1 个硬币」。
        const refund = Number(charmInfo?.price ?? 0);
        if (refund > 0) {
          draft.status.gold = (draft.status.gold ?? 0) + refund;
        }
      }
    }
  });

  res.send({
    ...player.delta,
    result: 0,
    recycleNum,
  } satisfies RecycleCharmsResponse);
});

/**
 * 尝试获取信物首通奖励
 * @route POST /activity/tryGetCharmFirstReward
 * @param req.body.charmId - 信物ID
 * @returns 玩家增量、是否首通标志和奖励列表
 *
 * 简化实现：检查信物是否已领取首通奖励，未领取则发放奖励并标记。
 */

router.post("/tryGetCharmFirstReward", validateBody(ReqSchema.tryGetCharmFirstRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as TryGetCharmFirstRewardRequest;
  let isFirst = false;
  const rewards: ItemBundle[] = [];

  await player.update(async (draft) => {
    // 在 charm 数据中新增 firstReward 字段记录首通领取状态
    const charmStatus = draft.charm;
    if (!charmStatus.firstReward) {
      charmStatus.firstReward = {};
    }
    if (!charmStatus.firstReward[body.charmId]) {
      isFirst = true;
      charmStatus.firstReward[body.charmId] = 1;
      // 查找信物配置获取首通奖励（简化：发放 1 个该信物作为首通奖励）
      const charmInfo = excel.CharmTable.charmList.find((c) => c.id === body.charmId);
      if (charmInfo) {
        rewards.push({ id: body.charmId, count: 1, type: "CHARM" });
      }
    }
  });

  if (rewards.length > 0) {
    for (const it of rewards) player.gainItem.add(it);
    await player.gainItem.handle();
  }

  res.send({
    ...player.delta,
    isFirst,
    reward: rewards,
  } satisfies TryGetCharmFirstRewardResponse);
});

/* ===== 尖灭测试（bossRush，委托 BossRushManager，参考 DoctoratePy activity.py / OBS misc_bp）===== */

/**
 * 尖灭测试开始战斗
 * @route POST /activity/bossRush/battleStart
 * @param req.body - CS: BossRushStartBattleRequest（activityId/stageId/teamId/ownSlots/assistFriend）
 * @returns 战斗开始信息（同 quest battleStart 形状）
 *
 * 校验（关卡归属/编队）与标准战斗开始均在 BossRushManager.battleStart 内完成；
 * 尖灭关卡 apCost=0 不耗理智，battleInfo 由 battle.start 落库供 battleFinish 结算读取。
 */
export default router;
