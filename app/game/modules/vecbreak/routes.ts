import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { now } from "@utils/time";
import type { Draft } from "mutative";
import type { PlayerDataModel } from "../../kernel/playerdata";
import type { PlayerSquad } from "../../kernel/model";
import {
  VecBreakV2ChangeBuffRequest,
  VecBreakV2ChangeBuffResponse,
  VecBreakV2DefenseStartBattleRequest,
  VecBreakV2FinishBattleRequest,
  VecBreakV2FinishBattleResponse,
  VecBreakV2OffenseStartBattleRequest,
  VecBreakV2SeasonRecordRequest,
  VecBreakV2SeasonRecordResponse,
  VecBreakV2SetDefendRequest,
  VecBreakV2SetDefendResponse,
  VecBreakV2StageInfo,
  VecBreakV2StartBattleResponse,
  VecBreakV2PlayerData,
} from "./vecbreak";
import { validateBody } from "../../kernel/http/validate-body";
import {
  currentVecBreakActivityId,
  vecBreakMilestoneGain,
  vecBreakOffenseStages,
  vecBreakStageIds,
} from "./vecbreak-config";
import {
  battleFinishSchema,
  battleStartSchema,
  changeBuffListSchema,
  defendBattleFinishSchema,
  defendBattleStartSchema,
  getSeasonRecordSchema,
  setDefendSchema,
} from "./vecbreak.schema";

const router = Router();

/** 驻防战斗上下文（defendBattleStart 记录 → defendBattleFinish 消费，参考 ODPY global battle_data） */
// 修复：模块级单例在多账号下互相串扰（A 开战 B 结算用错队伍）→ 按 uid 存储
const vecBreakBattleCtxs = new Map<
  string,
  { activityId: string; stageId: string; squad: PlayerSquad }
>();

/** 按需初始化 VEC_BREAK_V2 活动数据 */
function ensureVecBreakData(draft: Draft<PlayerDataModel>, activityId: string): VecBreakV2PlayerData {
  // 修复：draft.activity / VEC_BREAK_V2 缺失时可能为 undefined，先兜底再重读引用，
  // 避免赋值后本地变量仍为 undefined，导致 vb[activityId] 抛「reading 'undefined'」500。
  if (!draft.activity) draft.activity = {};
  if (!draft.activity.VEC_BREAK_V2) {
    draft.activity.VEC_BREAK_V2 = {};
  }
  const vb = draft.activity.VEC_BREAK_V2;
  if (!vb[activityId]) {
    vb[activityId] = {
      activatedBuff: [],
      defendStages: {},
      milestone: { point: 0, got: [] },
    };
  }
  return vb[activityId];
}

router.post("/vecBreakV2/getSeasonRecord", validateBody(getSeasonRecordSchema), async (req, res) => {
  const player = getPlayer();
  req.body as VecBreakV2SeasonRecordRequest;
  // 修复（2026-09-09）：原实现 ① 赛季 id 硬编码 act1break（当前为 act2break）；
  // ② 把 dungeon.stages 内所有 act1break_* 一律标 state=3（未通关的也显示为已通关）。
  // 现按当前赛季配置取关卡清单，并回报 dungeon 中的真实 state（缺省 0）。
  const activityId = currentVecBreakActivityId();
  const stages = player._playerdata.dungeon?.stages ?? {};
  const stageInfo: Record<string, VecBreakV2StageInfo> = {};
  for (const stageId of vecBreakStageIds(activityId)) {
    // CS: PlayerStageState 数值枚举（0=NONE … 3=COMPLETE），非字符串
    stageInfo[stageId] = { stageId, state: Number(stages[stageId]?.state ?? 0) };
  }
  const vb = player._playerdata.activity?.VEC_BREAK_V2?.[activityId];
  // 最佳记录 = 已通关的最高核心突破层（未通关任何层时回退首层）
  const offense = vecBreakOffenseStages(activityId);
  let bestStageId = offense[0]?.stageId ?? "";
  for (const s of offense) {
    if (Number(stages[s.stageId]?.state ?? 0) >= 3) bestStageId = s.stageId;
  }
  res.send({
    ...player.delta,
    seasons: {
      [activityId]: {
        bestRecord: {
          stageId: bestStageId,
          buff: vb?.activatedBuff ?? [],
          showTs: Number(vb?.bestShowTs ?? now()),
          squad: vb?.squads ?? [],
          assistChar: {},
        },
        stageInfo,
      },
    },
  } satisfies VecBreakV2SeasonRecordResponse);
});

router.post("/vecBreakV2/changeBuffList", validateBody(changeBuffListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as VecBreakV2ChangeBuffRequest;
  if (!body.activityId) return res.send({ result: 1, ...player.delta });
  // 参考 ODPY：写入 activity.VEC_BREAK_V2[activityId].activatedBuff
  await player.update(async (draft) => {
    const data = ensureVecBreakData(draft, body.activityId);
    if (Array.isArray(body.buffList)) data.activatedBuff = body.buffList;
  });
  res.send(player.delta satisfies VecBreakV2ChangeBuffResponse);
});

router.post("/vecBreakV2/defendBattleStart", validateBody(defendBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as VecBreakV2DefenseStartBattleRequest;
  // 参考 ODPY：记录战斗上下文并复用标准战斗开始
  vecBreakBattleCtxs.set(player.uid, {
    activityId: body.activityId,
    stageId: body.stageId,
    squad: body.squad,
  });
  const start = await player.battle.start({
    stageId: body.stageId,
    squad: body.squad,
    usePracticeTicket: 0,
    assistFriend: null,
    isRetro: 0,
    pray: 0,
    battleType: 0,
    continuous: { battleTimes: 1 },
    isReplay: 0,
    startTs: 0,
  });
  res.send({
    ...start,
    ...player.delta,
  } satisfies VecBreakV2StartBattleResponse);
});

/**
 * 特别战线（驻防）战斗结算
 *
 * 修复（2026-09-09）：原实现把 `recvTimeLimited`/`recvNormal` 一律置 `true`（且用布尔而非协议数值）
 * 却**不发任何点数**（msBefore === msAfter）——里程碑永不推进、限时奖励标记与实际发放不符。
 * 现按 `stageRewardDict[stageId]`：首通发 `completeRewardCnt`、重复发 `normalRewardCnt`，
 * 限时奖励 `limitReward` 仅在 `[startTs, endTs]` 窗口内且未领过时发放并置 `recvTimeLimited=1`。
 * @route POST /vecBreakV2/defendBattleFinish
 * @returns 结算响应（真实 msBefore/msAfter）+ 玩家增量
 */
router.post("/vecBreakV2/defendBattleFinish", validateBody(defendBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  req.body as VecBreakV2FinishBattleRequest;
  const ctx = vecBreakBattleCtxs.get(player.uid);
  let msBefore = 0;
  let msAfter = 0;
  if (ctx && ctx.activityId && ctx.stageId) {
    await player.update(async (draft) => {
      const data = ensureVecBreakData(draft, ctx.activityId);
      msBefore = Number(data.milestone?.point ?? 0);
      const defend = data.defendStages[ctx.stageId];
      const firstClear = !defend;
      if (firstClear) {
        data.defendStages[ctx.stageId] = {
          stageId: ctx.stageId,
          defendSquad: (ctx.squad?.slots ?? []).map((s) => ({
            charInstId: s?.charInstId,
            currentTmpl: null,
          })),
          recvTimeLimited: 0,
          recvNormal: 0,
        };
        if (!data.activatedBuff.includes(ctx.stageId)) {
          data.activatedBuff.push(ctx.stageId);
        }
      }
      const rec = data.defendStages[ctx.stageId];
      const gain = vecBreakMilestoneGain(
        ctx.activityId,
        ctx.stageId,
        firstClear,
        now(),
        Number(rec.recvTimeLimited ?? 0) === 1,
      );
      // recvNormal = 「非限时奖励已领取」——特别战线各关 normalRewardCnt 为 0，其普通奖励即 completeRewardCnt；
      // recvTimeLimited 仅在限时窗口内实际发放时置 1
      if (gain.point > 0) rec.recvNormal = 1;
      if (gain.timeLimited) rec.recvTimeLimited = 1;
      data.milestone.point = msBefore + gain.point;
      msAfter = Number(data.milestone.point ?? 0);
    });
    vecBreakBattleCtxs.delete(player.uid);
  }
  const finishBody = {
    result: 0,
    apFailReturn: 0,
    goldScale: 0,
    expScale: 0,
    suggestFriend: false,
    msBefore,
    msAfter,
    finTs: now(),
    ...player.delta,
  };
  res.send(finishBody satisfies VecBreakV2FinishBattleResponse);
});

router.post("/vecBreakV2/setDefend", validateBody(setDefendSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as VecBreakV2SetDefendRequest;
  if (!body.activityId) return res.send({ result: 1, ...player.delta });
  // 参考 ODPY：写入 defendStages[stageId].defendSquad
  await player.update(async (draft) => {
    const data = ensureVecBreakData(draft, body.activityId);
    if (!data.defendStages[body.stageId]) {
      data.defendStages[body.stageId] = { stageId: body.stageId, defendSquad: [], recvTimeLimited: false, recvNormal: false };
    }
    data.defendStages[body.stageId].defendSquad = body.squadSlots;
  });
  res.send(player.delta satisfies VecBreakV2SetDefendResponse);
});

/**
 * 核心突破开始战斗
 *
 * 修复（2026-09-09）：原实现返回**固定 battleId** ``abcdefgh-…`` 且不落任何战斗会话
 * （客户端拿到的 battleId 与真实开局无关，battleFinish 也无从取关卡）。
 * 现复用标准 battle.start（活动关卡 apCost=0，不耗理智）并由 battleInfo 落库。
 * @route POST /vecBreakV2/battleStart
 * @returns 标准开局响应 + 玩家增量
 */
router.post("/vecBreakV2/battleStart", validateBody(battleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as VecBreakV2OffenseStartBattleRequest;
  vecBreakBattleCtxs.set(player.uid, {
    activityId: body.activityId || currentVecBreakActivityId(),
    stageId: body.stageId,
    squad: body.squad,
  });
  const start = await player.battle.start({
    stageId: body.stageId,
    squad: body.squad,
    usePracticeTicket: 0,
    assistFriend: body.assistFriend ?? null,
    isRetro: 0,
    pray: 0,
    battleType: 0,
    continuous: { battleTimes: 1 },
    isReplay: 0,
    startTs: 0,
  });
  res.send({
    ...start,
    ...player.delta,
  } satisfies VecBreakV2StartBattleResponse);
});

/**
 * 核心突破战斗结算
 *
 * 修复（2026-09-09）：原实现是纯桩——不结算战斗、不写 `dungeon.stages[stageId].state`、
 * 不发里程碑点数（`milestone.point` 恒 0），12 层链与里程碑均无法推进。
 * 现复用标准 battle.finish，并按 `stageRewardDict` 发放点数（首通 completeRewardCnt / 重复 normalRewardCnt）。
 * @route POST /vecBreakV2/battleFinish
 * @returns 标准结算响应（含真实 msBefore/msAfter）+ 玩家增量
 */
router.post("/vecBreakV2/battleFinish", validateBody(battleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as VecBreakV2FinishBattleRequest;
  if (body.data == null) return res.send({ result: 1, ...player.delta });
  const ctx = vecBreakBattleCtxs.get(player.uid);
  const stageId = ctx?.stageId ?? player.battle.getActiveBattle()?.stageId ?? "";
  const activityId = ctx?.activityId || currentVecBreakActivityId();
  const prevState =
    (player._playerdata.dungeon?.stages as Record<string, { state?: number }> | undefined)?.[
      stageId
    ]?.state ?? 0;
  const result = await player.battle.finish({
    data: body.data,
    battleData: body.battleData,
  });
  let msBefore = 0;
  let msAfter = 0;
  await player.update(async (draft) => {
    const data = ensureVecBreakData(draft, activityId);
    msBefore = Number(data.milestone?.point ?? 0);
    const gain = vecBreakMilestoneGain(
      activityId,
      stageId,
      prevState < 2,
      now(),
      false,
    );
    if (gain.point > 0) {
      data.milestone.point = msBefore + gain.point;
      data.bestShowTs = now();
    }
    msAfter = Number(data.milestone.point ?? 0);
  });
  vecBreakBattleCtxs.delete(player.uid);
  res.send({
    // battle.finish 声明了 BattleFinishResponse 骨架（battle.ts）——直接展开：
    // 原先在其前面写死的 apFailReturn/goldScale/expScale/suggestFriend 会被展开覆盖（死代码）
    ...result,
    msBefore,
    msAfter,
    finTs: now(),
    ...player.delta,
  } satisfies VecBreakV2FinishBattleResponse);
});

export default router;
