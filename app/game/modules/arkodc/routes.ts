/**
 * arkodc（act53side「直到大地变成一颗酸橙」安洁莉娜的旅行小记，活动模式 ODC 小游戏）路由
 *
 * 对应客户端 com.hypergryph.arknights_2.7.61.cs 中
 * Torappu.UI.ArkOdc.ArkOdcBattleStartRequest/ArkOdcTaskSavePositionRequest/
 * ArkOdcTriggerActionRequest/ArkOdcTaskRestartRequest 系列类；
 * 路由参考 OBS misc_bp（/arkodc/* 根路径），状态逻辑参考 ODPY arkodc 类
 * （写入 user.arkodc.topics[topicId].position / rewards）。
 */
import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { ItemBundle } from "@excel/excel";
import excel from "@excel/excel";
import type { PlayerArkOdcTopic } from "@excel/types-playerdata";
import { decryptBattleData } from "@utils/crypt";
import type { BattleData } from "../../kernel/battle-model";
import { now } from "@utils/time";
import { PlayerDeltaResponse } from "../../kernel/http/common";
import { validateBody } from "@core/http/validate-body";
import {
  arkOdcBattleFinishSchema,
  arkOdcBattleStartSchema,
  arkOdcRestartSchema,
  arkOdcSavePositionSchema,
  arkOdcTriggerActionSchema,
} from "./arkodc.schema";
import { ensureArkOdcTopic } from "./guide";

const router = Router();

/** 当前 ODC 战斗 topic（battleStart 记录，battleFinish 消费；参考 ODPY global arkodc_topic） */
// 修复：模块级单例多账号串扰 → 按 uid 存储
const arkOdcTopics = new Map<string, string>();

/**
 * 应用 varSeqList 到 arkodc 主题状态（参考 ODPY：bool/end/removed 置 1，其余累加）
 */
function applyVarSeqList(
  arkodcTopic: PlayerArkOdcTopic,
  varSeqList: string[] | undefined,
  blackSet: Set<string> = new Set(["bool", "end", "removed"]),
  skipContain?: string[],
): void {
  if (!varSeqList?.length) return;
  for (const varSeq of varSeqList) {
    if (blackSet.has(varSeq)) continue;
    if (skipContain?.some((s) => varSeq.includes(s))) continue;
    if (["bool", "end", "removed"].some((s) => varSeq.includes(s))) {
      arkodcTopic.varSeqs[varSeq] = 1;
    } else {
      arkodcTopic.varSeqs[varSeq] = (arkodcTopic.varSeqs[varSeq] ?? 0) + 1;
    }
  }
}


/** ODC 开始战斗请求（CS: ArkOdcBattleStartRequest : DefaultStartBattleRequest） */
export interface ArkOdcBattleStartRequest {
  groupId: string;
  topicId: string;
  stageId?: string;
}

/** ODC 开始战斗响应（CS: ArkOdcBattleStartResponse : DefaultStartBattleResponse） */
export interface ArkOdcBattleStartResponse extends PlayerDeltaResponse {
  result: number;
  battleId: string;
  apFailReturn: number;
  isApProtect: number;
  inApProtectPeriod: boolean;
  notifyPowerScoreNotEnoughIfFailed: boolean;
}

/** ODC 战斗结算请求（CS: ArkOdcBattleFinishRequest : DefaultFinishBattleRequest） */
export interface ArkOdcBattleFinishRequest {
  data: string;
  battleData: { isCheat: string; completeTime: number };
  operationId?: string;
  actorId?: string;
}

/** ODC 战斗结算响应（CS: ArkOdcBattleFinishResponse : DefaultFinishBattleResponse） */
export interface ArkOdcBattleFinishResponse extends PlayerDeltaResponse {
  result?: number;
  apFailReturn?: number;
  expScale?: number;
  goldScale?: number;
  rewards?: ItemBundle[];
  firstRewards?: ItemBundle[];
  unlockStages?: string[];
  unusualRewards?: ItemBundle[];
  additionalRewards?: ItemBundle[];
  furnitureRewards?: ItemBundle[];
  alert?: unknown[];
  suggestFriend?: boolean;
  pryResult?: unknown[];
}

/** ODC 保存位置请求（CS: ArkOdcTaskSavePositionRequest） */
export interface ArkOdcSavePositionRequest {
  groupId?: string;
  topicId: string;
  x: number;
  y: number;
  z: number;
}

/** ODC 保存位置响应（CS: ArkOdcTaskSavePositionResponse） */
export type ArkOdcSavePositionResponse = PlayerDeltaResponse;

/** ODC 触发互动请求（CS: ArkOdcTriggerActionRequest） */
export interface ArkOdcTriggerActionRequest {
  groupId?: string;
  topicId?: string;
  operationId?: string;
  actorId?: string;
  avgId?: string | null;
  awardId?: string | null;
}

/** ODC 触发互动响应（CS: ArkOdcTriggerActionResponse { items }） */
export interface ArkOdcTriggerActionResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}

/** ODC 重启任务请求（CS: ArkOdcTaskRestartRequest） */
export interface ArkOdcRestartRequest {
  groupId?: string;
  topicId?: string;
}

/** ODC 重启任务响应（CS: ArkOdcTaskRestartResponse） */
export type ArkOdcRestartResponse = PlayerDeltaResponse;

/** ODC 开始战斗（CS: ArkOdcBattleStartRequest；参考 OBS 固定 battleId stub） */
router.post("/battleStart", validateBody(arkOdcBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ArkOdcBattleStartRequest;
  // 参考 ODPY：记录 topic 供 battleFinish 使用
  if (body.topicId) arkOdcTopics.set(player.uid, body.topicId);
  res.send({
    result: 0,
    battleId: "00000000-0000-0000-0000-000000000000",
    apFailReturn: 0,
    isApProtect: 0,
    inApProtectPeriod: false,
    notifyPowerScoreNotEnoughIfFailed: false,
    ...player.delta,
  } satisfies ArkOdcBattleStartResponse);
});

/**
 * ODC 战斗结算（CS: ArkOdcBattleFinishRequest；参考 ODPY arkodcBattleFinish）
 * 解密战斗数据判定是否完成（q001_logic_after_bat_p1 需非中断/非放弃；
 * 其余按 completeState 2/3 为完成）——完成后按 actorData.actorShowCondition 推进 varSeqs
 */
router.post("/battleFinish", validateBody(arkOdcBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ArkOdcBattleFinishRequest;
  const { operationId, actorId } = body;
  const emptyResult = {
    result: 0,
    apFailReturn: 0,
    expScale: 1.2,
    goldScale: 1.2,
    rewards: [],
    firstRewards: [],
    unlockStages: [],
    unusualRewards: [],
    additionalRewards: [],
    furnitureRewards: [],
    alert: [],
    suggestFriend: false,
    pryResult: [],
    wave: 0,
    milestoneBefore: 0,
    milestoneAdd: 0,
    isMileStoneMax: false,
    tokenAdd: 0,
    isTokenMax: false,
    items: [],
  };

  let complete = false;
  try {
    const battleData = await decryptBattleData<BattleData>(
      body.data,
      player._playerdata.pushFlags.status,
    );
    if (actorId === "q001_logic_after_bat_p1") {
      complete = !battleData.interrupt && !battleData.giveUp;
    } else {
      complete = battleData.completeState === 2 || battleData.completeState === 3;
    }
  } catch {
    complete = false;
  }
  if (!complete) {
    // 清理残留 topic，避免后续无 battleStart 的 battleFinish 沿用错误 topic
    arkOdcTopics.delete(player.uid);
    return res.send({
      ...emptyResult,
      ...player.delta,
    } satisfies ArkOdcBattleFinishResponse);
  }

  // 完成后推进 actorData.actorShowCondition 的 varSeqs
  const topicId = arkOdcTopics.get(player.uid) ?? "";
  const arkvent = excel.ArkventTable;
  const actorData = arkvent?.arkventDataMap?.[topicId]?.taskData?.actorData?.[actorId!];
  // 提到局部常量：属性收窄不进入闭包（旧实现靠 any 绕过）
  const showConditions = actorData?.actorShowCondition;
  if (showConditions) {
    await player.update(async (draft) => {
      const arkTopic = ensureArkOdcTopic(draft, topicId);
      for (const condition of showConditions) {
        applyVarSeqList(arkTopic, condition.varSeqList);
      }
    });
  }
  arkOdcTopics.delete(player.uid);

  res.send({
    ...emptyResult,
    ...player.delta,
  } satisfies ArkOdcBattleFinishResponse);
});

/**
 * ODC 保存位置（CS: ArkOdcTaskSavePositionRequest）
 * 参考 ODPY arkodc.savePosition：写入 arkodc.topics[topicId].position
 */
router.post("/savePosition", validateBody(arkOdcSavePositionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ArkOdcSavePositionRequest;
  // 修复：缺失 topicId 时返回业务错误而非写入 topics["undefined"]
  if (isInvalidTopicId(body.topicId)) {
    return res.send(player.delta satisfies ArkOdcSavePositionResponse);
  }
  await player.update(async (draft) => {
    const arkTopic = ensureArkOdcTopic(draft, body.topicId);
    arkTopic.position = { x: body.x, y: body.y, z: body.z };
  });
  res.send(player.delta satisfies ArkOdcSavePositionResponse);
});

/**
 * 校验 ODC 主题 id（缺失/空串时返回业务错误）
 *
 * 修复：路由曾对缺失 topicId 直接 ensureArkOdcTopic(undefined) → 存档写入
 * arkodc.topics["undefined"]（JSON 键 "undefined"），新账号从模板继承残留。
 * 客户端正常必带 topicId；缺失时返回业务错误而非写脏数据。
 */
function isInvalidTopicId(topicId: string | undefined | null): boolean {
  return typeof topicId !== "string" || topicId === "";
}

/**
 * ODC 触发互动（CS: ArkOdcTriggerActionRequest）
 * 参考 ODPY arkodc.triggerInteraction：awardId 存在且无 avgId 时标记
 * topics[topicId].rewards[awardId]=1；奖励返回空（参考 OBS）
 */
router.post("/triggerInteraction", validateBody(arkOdcTriggerActionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ArkOdcTriggerActionRequest;
  const { topicId, awardId, avgId, actorId } = body;
  if (isInvalidTopicId(topicId)) {
    return res.send({ items: [], ...player.delta } satisfies ArkOdcTriggerActionResponse);
  }
  const arkvent = excel.ArkventTable;
  let items: ItemBundle[] = [];

  await player.update(async (draft) => {
    const arkTopic = ensureArkOdcTopic(draft, topicId!);
    // 宝箱部分（awardId 存在且无 avgId，参考 ODPY）
    if (awardId && !avgId) {
      arkTopic.rewards[awardId] = 1;
      const rewardGroup = arkvent?.odcDataMap?.[topicId!]?.rewardGroups?.[awardId];
      if (rewardGroup) items = rewardGroup;
      // awardId 形如 ..._q001/_q002/_q003（任务奖励）→ 触发关联 actor 的 varSeqs 推进；
      // 宝箱奖励（..._tre_a 等）不匹配
      if (/_q\d+$/.test(awardId)) {
        const actorDataMap = arkvent?.arkventDataMap?.[topicId!]?.taskData?.actorData ?? {};
        for (const currentTaskData of Object.values(actorDataMap)) {
          const triggerOps = currentTaskData?.actorTriggerOperations ?? {};
          let found = false;
          for (const opsList of Object.values(triggerOps)) {
            if (!Array.isArray(opsList)) continue;
            for (const operation of opsList) {
              const awardIdValue = operation?.operationParams?.awardId ?? "";
              if (String(awardIdValue).startsWith(String(awardId))) {
                found = true;
                break;
              }
            }
            if (found) break;
          }
          if (found) {
            const showCond = currentTaskData?.actorShowCondition?.[1]?.varSeqList;
            if (Array.isArray(showCond)) {
              for (const varSeq of showCond) {
                const varSeqInt = (arkTopic.varSeqs[varSeq] ?? 0) + 1;
                arkTopic.varSeqs[varSeq] = varSeqInt;
                if (String(varSeq).endsWith("_banner_showed")) {
                  const varSeq1 = String(varSeq).slice(0, 4) + "_end";
                  arkTopic.varSeqs[varSeq1] = 1;
                }
              }
            }
            break;
          }
        }
      }
    } else if (avgId && !awardId && actorId) {
      // 任务部分（参考 ODPY：actorShowCondition varSeqList 推进，黑名单过滤）
      const blackSet = new Set(["act53side", "end", "banner_showed", "_unlocked"]);
      const actorData = arkvent?.arkventDataMap?.[topicId!]?.taskData?.actorData?.[actorId];
      if (!actorData) return;
      if (
        ["worker_a_", "worker_b_", "worker_c_"].some((s) => String(avgId).includes(s)) ||
        ["_a", "_b", "_c"].some((s) => String(avgId).endsWith(s)) ||
        ["_bat", "_pros_prog_5", "_fighting", "_open", "_jxt"].some((s) =>
          String(avgId).endsWith(s),
        ) ||
        ["q003_ia_right", "q003_ia_up"].some((s) => String(actorId).startsWith(s))
      ) {
        blackSet.add("_prog");
      }
      if (["zone_unlock", "global_unlock"].some((s) => String(actorId).startsWith(s))) {
        blackSet.delete("end");
        blackSet.delete("_unlocked");
      }
      const varSeqSet = new Set<string>();
      for (const condition of actorData.actorShowCondition ?? []) {
        for (const varSeq of condition.varSeqList ?? []) {
          if ([...blackSet].some((s) => String(varSeq).includes(s))) continue;
          varSeqSet.add(varSeq);
        }
      }
      const avgIdStr = String(avgId);
      if (avgIdStr.endsWith("intro")) {
        for (const v of [...varSeqSet]) {
          if (v.includes("talked") || v.includes("removed")) varSeqSet.delete(v);
        }
      }
      for (const varSeq of varSeqSet) {
        if (["bool", "end", "removed"].some((s) => varSeq.includes(s))) {
          arkTopic.varSeqs[varSeq] = 1;
        } else {
          arkTopic.varSeqs[varSeq] = (arkTopic.varSeqs[varSeq] ?? 0) + 1;
        }
      }
      if (actorId === "q003_trademan_open_p1") {
        arkTopic.varSeqs["q003_prog"] = (arkTopic.varSeqs["q003_prog"] ?? 0) + 1;
        arkTopic.varSeqs["q003_gpm_a_talk_done"] = 1;
        arkTopic.varSeqs["q003_gpm_b_talk_done"] = 1;
      }
    }
  });

  // act53side 任务/勋章进度同步：收集奖励后按当前存档快照发射 ArkodcRewardGroupAtLeast
  //（任务 1..9）与 ArkodcVarSeqAtLeast（勋章 bool_all_unlocked）——进度值 = 已收集
  // 奖励/变量命中数量，事件驱动模板据此推进。
  const latestTopic = player._playerdata.arkodc?.topics?.[topicId!];
  if (latestTopic) {
    await player._trigger.emit("ArkodcRewardGroupAtLeast", [
      { activityId: topicId!, rewards: latestTopic.rewards ?? {} },
    ]);
    await player._trigger.emit("ArkodcVarSeqAtLeast", [
      { activityId: topicId!, varSeqs: latestTopic.varSeqs ?? {} },
    ]);
  }

  // 宝箱奖励真实发放（响应 items 仅客户端展示用，物品进背包经 items:get）
  if (items.length > 0) {
    for (const it of items) player.gainItem.add(it);
    await player.gainItem.handle();
  }

  res.send({
    items,
    ...player.delta,
  } satisfies ArkOdcTriggerActionResponse);
});

/**
 * ODC 重启任务（CS: ArkOdcTaskRestartRequest；参考 ODPY arkodcRestart）
 * 重置主题 varSeqs（deleted delta 下发被删 key 列表）+ position 置空
 */
router.post("/restart", validateBody(arkOdcRestartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ArkOdcRestartRequest;
  // 修复：缺失 topicId 时返回业务错误而非写入 topics["undefined"]
  if (isInvalidTopicId(body.topicId)) {
    return res.send({
      playerDataDelta: { modified: {}, deleted: {} },
    } satisfies ArkOdcRestartResponse);
  }
  let deletedKeys: string[] = [];
  await player.update(async (draft) => {
    const arkTopic = ensureArkOdcTopic(draft, body.topicId!);
    deletedKeys = Object.keys(arkTopic.varSeqs ?? {});
    arkTopic.varSeqs = {};
    arkTopic.position = null;
  });
  // 触发落盘并清空 _changes，避免残留补丁污染下一个请求的 delta（delta getter 内部会 emit "save"）
  void player.delta;
  res.send({
    playerDataDelta: {
      modified: {
        arkodc: { topics: { [body.topicId!]: { varSeqs: {}, position: null } } },
      },
      deleted: {
        arkodc: { topics: { [body.topicId!]: { varSeqs: deletedKeys } } },
      },
    },
  } satisfies ArkOdcRestartResponse);
});

export default router;
