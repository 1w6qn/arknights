/**
 * 主线战役V2路由模块
 *
 * 处理主线战役V2（campaignV2）相关的 HTTP 请求，包括战斗开始、战斗结束、扫荡、
 * 突破奖励和额外任务奖励等接口。
 *
 * 业务逻辑委托给 Manager 层（BattleManager 等）处理，路由层仅负责协议适配与响应封装。
 *
 * 参考实现：reference/opendoctoratepy-ex-public/server/campaignV2.py
 */

import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { ItemBundle } from "@excel/excel";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import {
  CampaignConfirmBreakRewardRequest,
  CampaignConfirmBreakRewardResponse,
  CampaignFinishBattleRequest,
  CampaignFinishBattleResponse,
  CampaignGetCommonMissionRewardRequest,
  CampaignGetCommonMissionRewardResponse,
  CampaignStartBattleRequest,
  CampaignStartBattleResponse,
  CampaignSweepRequest,
  CampaignSweepResponse,
} from "./campaignV2";
import { validateBody } from "@core/http/validate-body";
import excel from "@excel/excel";
import { now } from "@utils/time";
import { logger } from "@utils/logger";
import {
  campaignMaxKills,
  campaignWeeklyBudget,
  campaignsV2View,
  claimCampaignBreakRewards,
  claimCampaignMissionReward,
} from "./public";
import {
  campaignV2BattleFinishSchema,
  campaignV2BattleStartSchema,
  campaignV2BattleSweepSchema,
  campaignV2GetBreakRewardSchema,
  campaignV2GetExMissionRewardSchema,
} from "./campaignV2.schema";

const router = Router();

/**
 * 主线战役V2战斗开始
 *
 * 委托 BattleManager.start 处理战斗初始化逻辑（关卡状态、体力消耗、AP保护等），
 * 并合并 playerDataDelta 返回给客户端。
 *
 * @route POST /campaignV2/battleStart
 * @param req.body - CommonStartBattleRequest 结构，包含 stageId、squad 等字段
 * @returns battleId、战斗结果及玩家增量数据
 */
router.post("/campaignV2/battleStart", validateBody(campaignV2BattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CampaignStartBattleRequest;
  const battleResult = await player.battle.start(body);

  res.send({
    ...battleResult,
    ...player.delta,
  } satisfies CampaignStartBattleResponse);
});

/**
 * 主线战役V2战斗结束
 *
 * 委托 BattleManager.finish 处理战斗结算逻辑（关卡解锁、奖励掉落、经验/金币结算等），
 * 并合并 playerDataDelta 返回给客户端。
 *
 * @route POST /campaignV2/battleFinish
 * @param req.body - 包含 data（加密战斗数据）和 battleData 字段
 * @returns 战斗结算结果及玩家增量数据
 */
router.post("/campaignV2/battleFinish", validateBody(campaignV2BattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CampaignFinishBattleRequest;
  // 缺参校验：data/battleData 缺失时返回业务错误，避免 undefined 传入 battle.finish 抛 500
  if (body.data == null || body.battleData == null) {
    res.send({ result: 1, ...player.delta } satisfies CampaignFinishBattleResponse);
    return;
  }
  const finishResult = await player.battle.finish(body);

  res.send({
    ...finishResult,
    ...player.delta,
  } satisfies CampaignFinishBattleResponse);
});

/**
 * 主线战役V2扫荡
 *
 * 简化实现：返回固定的扫荡奖励结构。
 * 由于 Manager 层未提供 sweep 方法（且参考实现亦为静态返回），
 * 此处在路由层直接构造符合协议的响应，diamondMaterialRewards 返回固定钻石碎屑。
 *
 * @route POST /campaignV2/battleSweep
 * @returns 扫荡结果（奖励列表、解锁关卡、玩家增量数据等）
 */
router.post("/campaignV2/battleSweep", validateBody(campaignV2BattleSweepSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CampaignSweepRequest;
  const stageId = body?.stageId ?? "";
  const stage = stageId
    ? (excel.StageTable.stages as Record<string, { apCost?: number } | undefined>)[
        stageId
      ]
    : undefined;
  const maxKills = campaignMaxKills(
    campaignsV2View(player._playerdata).campaignsV2,
    stageId,
  );

  /** 空奖励响应（不消耗、不发奖） */
  const emptyResponse = () => {
    const { before, remaining } = campaignWeeklyBudget(
      campaignsV2View(player._playerdata),
      now(),
    );
    res.send({
      ...player.delta,
      result: 1,
      apFailReturn: 0,
      rewards: [],
      unlockStages: [],
      unusualRewards: [],
      additionalRewards: [],
      furnitureRewards: [],
      diamondMaterialRewards: [],
      currentFeeBefore: before,
      currentFeeAfter: before,
    } satisfies CampaignSweepResponse);
    // remaining 参与闭包计算（保持类型完整），此处无实际用途
    void remaining;
  };

  // 修复（2026-09-09，S6）：扫荡必须建立在「已通关该委托」之上——原实现无条件固定发
  // 1 合成玉、不扣理智与代理指挥卡，可脚本无限刷合成玉。
  if (!stage || maxKills <= 0) {
    logger.warn(
      "campaignV2",
      `battleSweep ${stageId} 无歼灭记录（maxKills=${maxKills}），拒绝结算`,
    );
    return emptyResponse();
  }
  // 代理指挥卡（EXTERMINATION_AGENT）为扫荡前提：缺失即拒绝（不消耗理智）
  if (!body?.itemId) {
    logger.warn("campaignV2", `battleSweep ${stageId} 未携带代理指挥卡，拒绝结算`);
    return emptyResponse();
  }
  await player.gainItem
    .add({
      id: body.itemId,
      count: 1,
      instId: body.instId,
    })
    .use();
  // 理智消耗（与直接作战一致）
  const apCost = stage.apCost ?? 0;
  if (apCost > 0) {
    await player.gainItem
      .add({ id: "", type: "AP_GAMEPLAY" as ItemBundle["type"], count: -apCost })
      .handle();
  }
  // 合成玉结算：按历史最高歼灭数，受本周上限（campaignTotalFee）封顶
  let currentFeeBefore = 0;
  let currentFeeAfter = 0;
  let gained = 0;
  await player.update(async (draft) => {
    const before = campaignWeeklyBudget(campaignsV2View(draft), now());
    const grant = Math.min(maxKills, before.remaining);
    currentFeeBefore = before.before;
    gained = grant;
    currentFeeAfter = before.before + grant;
    (draft as { campaignsV2?: { campaignCurrentFee?: number } }).campaignsV2!
      .campaignCurrentFee = currentFeeAfter;
  });
  const diamondRewards: ItemBundle[] =
    gained > 0
      ? [{ type: "DIAMOND_SHD" as ItemBundle["type"], id: "4003", count: gained }]
      : [];
  if (diamondRewards.length > 0) {
    for (const it of diamondRewards) player.gainItem.add(it);
    await player.gainItem.handle();
  }

  res.send({
    ...player.delta,
    result: 0,
    apFailReturn: 0,
    rewards: [],
    unlockStages: [],
    unusualRewards: [],
    additionalRewards: [],
    furnitureRewards: [],
    diamondMaterialRewards: diamondRewards,
    currentFeeBefore,
    currentFeeAfter,
  } satisfies CampaignSweepResponse);
});

/**
 * 获取主线战役V2突破奖励
 *
 * 修复（2026-09-09，S6）：突破奖励真实发放——原实现只回 delta（空增量）、rewardStatus
 * 永不写入，导致剿灭蚀刻章（CampaignsComplete）与任务「获得任意一个剿灭作战的全部进度奖励」
 *（guide_60，CompleteBreakReward）双双卡死。
 *
 * @route POST /campaignV2/getBreakReward
 * @returns items（本次领取的奖励）与 feeAdd（计入本周进度的额外合成玉）+ 玩家增量
 */
router.post("/campaignV2/getBreakReward", validateBody(campaignV2GetBreakRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CampaignConfirmBreakRewardRequest;
  const stageId = body?.stageId ?? "";
  const indexList = Array.isArray(body?.indexList) ? body.indexList : [];
  const ladders =
    (excel.CampaignTable as {
      campaigns?: Record<
        string,
        {
          breakLadders?: {
            killCnt: number;
            breakFeeAdd?: number;
            // 与 accrue.ts#BreakLadder.rewards 同源：形状即物品条目（type 为类型枚举字符串）
            rewards?: ItemBundle[];
          }[];
        }
      >;
    }).campaigns?.[stageId]?.breakLadders ?? [];
  let items: ItemBundle[] = [];
  let feeAdd = 0;
  let allClaimed = false;
  await player.update(async (draft) => {
    const result = claimCampaignBreakRewards(
      campaignsV2View(draft),
      stageId,
      indexList,
      ladders,
      now(),
    );
    items = result.items;
    feeAdd = result.feeGain;
    allClaimed = result.allClaimed;
  });
  if (items.length > 0) {
    for (const it of items) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  if (feeAdd > 0) {
    await player.gainItem
      .add({ type: "DIAMOND_SHD" as ItemBundle["type"], id: "4003", count: feeAdd })
      .handle();
  }
  if (allClaimed) {
    // 「获得全部进度奖励」任务（guide_60）与剿灭蚀刻章
    await player._trigger.emit("CompleteBreakReward", []);
    await player._trigger.emit("CampaignsComplete", [
      campaignsV2View(player._playerdata).campaignsV2 ?? {},
    ]);
  }
  res.send({
    ...player.delta,
    feeAdd,
    items,
  } satisfies CampaignConfirmBreakRewardResponse);
});

/**
 * 获取主线战役V2额外任务奖励
 *
 * 修复（2026-09-09，S6）：委托任务奖励真实发放——原实现恒返回空 delta，
 * `campaignsV2.missions` 永不写入（客户端任务列表恒未完成）。
 * 任务达标由 battleFinish 的 CAMPAIGN 分支刷新（0 → 1 待领），此处领取后置 2。
 *
 * @route POST /campaignV2/getExMissionReward
 * @returns feeAdd（计入本周进度的合成玉）+ 玩家增量
 */
router.post("/campaignV2/getExMissionReward", validateBody(campaignV2GetExMissionRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CampaignGetCommonMissionRewardRequest;
  const missionId = body?.id ?? "";
  const missionCfg =
    (excel.CampaignTable as {
      campaignMissions?: Record<
        string,
        { id: string; param?: string[]; breakFeeAdd?: number }
      >;
    }).campaignMissions ?? {};
  let feeAdd = 0;
  let ok = false;
  await player.update(async (draft) => {
    const result = claimCampaignMissionReward(
      campaignsV2View(draft),
      missionId,
      missionCfg,
      now(),
    );
    ok = result.ok;
    feeAdd = result.feeGain;
  });
  if (!ok) {
    logger.warn("campaignV2", `getExMissionReward ${missionId} 不可领（未达标或已领取）`);
  }
  if (feeAdd > 0) {
    await player.gainItem
      .add({ type: "DIAMOND_SHD" as ItemBundle["type"], id: "4003", count: feeAdd })
      .handle();
  }
  res.send({
    ...player.delta,
    feeAdd,
  } satisfies CampaignGetCommonMissionRewardResponse & { feeAdd: number });
});

export default router;
