import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { validateBody } from "@core/http/validate-body";
import {
  squadFormationSchema,
  changeSquadNameSchema,
  getAssistListSchema,
  battleStartSchema,
  battleFinishSchema,
  getBattleReplaySchema,
  saveBattleReplaySchema,
  battleContinueSchema,
  finishStoryStageSchema,
  editStageSixStarTagSchema,
  getCowLevelRewardSchema,
  getMainlineRecordRewardsSchema,
  getMainlineCacheSchema,
  unlockStageFogSchema,
  unlockHideStageSchema,
  confirmSixStarRewardSchema,
} from "./quest.schema";
import { ItemBundle } from "@excel/excel";
import {
  BattleContinueRequest,
  BattleContinueResponse,
  ChangeSquadNameRequest,
  ChangeSquadNameResponse,
  EditStageSixStarTagRequest,
  EditStageSixStarTagResponse,
  FinishStoryStageRequest,
  FinishStoryStageResponse,
  GetAssistListRequest,
  GetAssistListResponse,
  GetBattleReplayRequest,
  GetBattleReplayResponse,
  QuestBattleFinishRequest,
  QuestBattleFinishResponse,
  QuestBattleStartResponse,
  SaveBattleReplayRequest,
  SaveBattleReplayResponse,
  SquadFormationRequest,
  SquadFormationResponse,
  GetCowLevelRewardRequest,
  GetCowLevelRewardResponse,
  GetMainlineCacheRequest,
  GetMainlineCacheResponse,
  GetMainlineRecordRewardsRequest,
  GetMainlineRecordRewardsResponse,
  UnlockHideStageRequest,
  UnlockHideStageResponse,
  UnlockStageFogRequest,
  UnlockStageFogResponse,
} from "./quest";
import { CommonStartBattleRequest } from "../../kernel/battle-model";

/**
 *    SQUAD_FORMATION = "/quest/squadFormation";
 *    SQUAD_RENAME = "/quest/changeSquadName";
 *    SQUAD_GET_ASSIST_LIST = "/quest/getAssistList";
 *    DEFAULT_BATTLE_START = "/quest/battleStart";
 *    DEFAULT_BATTLE_FINISH = "/quest/battleFinish";
 *    DEFAULT_BATTLE_CONTINUE = "/quest/battleContinue";
 *    SAVE_BATTLE_REPLAY = "/quest/saveBattleReplay";
 *    LOAD_BATTLE_REPLAY = "/quest/getBattleReplay";
 *    FINISH_STORY_STAGE = "/quest/finishStoryStage";
 *    UNLOCK_STAGE_FOG = "/quest/unlockStageFog";
 *    UNLOCK_HIDDEN_STAGE = "/quest/unlockHideStage";
 *    GET_SPECIAL_STAGE_REWARD = "/quest/getCowLevelReward";
 *    GET_ZONE_RECORD_REWARD = "/quest/getMainlineRecordRewards";
 *    GET_MAINLINE_CACHE = "/quest/getMainlineCache";
 *    **/
const router = Router();
router.post("/squadFormation", validateBody(squadFormationSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SquadFormationRequest;
  // 缺参校验：squadId/slots 缺失时返回业务错误，避免 manager 内 undefined 崩溃 → 500
  if (body.squadId == null || !Array.isArray(body.slots)) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.troop.squadFormation(body);
  res.send(player.delta satisfies SquadFormationResponse);
});
router.post("/changeSquadName", validateBody(changeSquadNameSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeSquadNameRequest;
  // 缺参校验：squadId/name 缺失时返回业务错误
  if (body.squadId == null || typeof body.name !== "string") {
    return res.send({ result: 1, ...player.delta });
  }
  await player.troop.changeSquadName(body);
  res.send(player.delta satisfies ChangeSquadNameResponse);
});
router.post("/changeSquadName2", validateBody(changeSquadNameSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeSquadNameRequest;
  // 缺参校验：squadId/name 缺失时返回业务错误
  if (body.squadId == null || typeof body.name !== "string") {
    return res.send({ result: 1, ...player.delta });
  }
  await player.troop.changeSquadName(body);
  res.send(player.delta satisfies ChangeSquadNameResponse);
});
router.post("/getAssistList", validateBody(getAssistListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetAssistListRequest;
  res.send({
    list: await player.social.getAssistList(body),
    ...player.delta,
  } satisfies GetAssistListResponse);
});
router.post("/battleStart", validateBody(battleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CommonStartBattleRequest;
  res.send({
    ...(await player.battle.start(body)),
    ...player.delta,
  } satisfies QuestBattleStartResponse);
});
router.post("/battleFinish", validateBody(battleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as QuestBattleFinishRequest;
  // 缺参校验：battle data 缺失时返回业务错误，避免 decryptBattleData 抛 TypeError → 500
  if (body.data == null) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send({
    ...(await player.battle.finish(body)),
    ...player.delta,
  } satisfies QuestBattleFinishResponse);
});
router.post("/getBattleReplay", validateBody(getBattleReplaySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetBattleReplayRequest;
  // 读类缺参校验：stageId 为必填，缺失时返回业务错误
  if (body.stageId == null) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send({
    battleReplay:await player.battle.loadReplay(body),
    ...player.delta,
  } satisfies GetBattleReplayResponse);
});
router.post("/saveBattleReplay", validateBody(saveBattleReplaySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SaveBattleReplayRequest;
  // 缺参校验：battleId/battleReplay 缺失时返回业务错误
  if (body.battleId == null || body.battleReplay == null) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.battle.saveReplay(body);
  res.send(player.delta satisfies SaveBattleReplayResponse);
});
router.post("/battleContinue", validateBody(battleContinueSchema), async (req, res) => {
  // 继续战斗：参考 OBS bp_quest.battleContinue，仅返回固定 stub（战斗数据由 battleFinish 结算）
  const player = getPlayer();
  req.body as BattleContinueRequest;
  res.send({
    result: 1,
    battleId: "00000000-0000-0000-0000-000000000000",
    apFailReturn: 0,
    ...player.delta,
  } satisfies BattleContinueResponse);
});
router.post("/finishStoryStage", validateBody(finishStoryStageSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as FinishStoryStageRequest;
  // 缺参校验：stageId 缺失时返回业务错误，避免 manager 内 undefined 崩溃 → 500
  if (body.stageId == null) {
    return res.send({ result: 1, ...player.delta });
  }
  res.send({
    ...(await player.battle.finishStoryStage(body)),
    ...player.delta,
  } satisfies FinishStoryStageResponse);
});
router.post("/editStageSixStarTag", validateBody(editStageSixStarTagSchema), async (req, res) => {
  const player = getPlayer();
  const { stageId, selected } = req.body as EditStageSixStarTagRequest;
  await player.update(async (draft) => {
    const d = draft;
    // 修复：存档 sixStar 为 null（模板如此）且从未初始化 → 原实现直接 .stages 崩溃 500
    if (!d.dungeon.sixStar) {
      d.dungeon.sixStar = { stages: {}, groups: {} };
    }
    if (!d.dungeon.sixStar.stages[stageId]) {
      d.dungeon.sixStar.stages[stageId] = { tagFinish: 0, tagSelected: [] };
    }
    d.dungeon.sixStar.stages[stageId].tagSelected = selected;
  });
  res.send(player.delta satisfies EditStageSixStarTagResponse);
});

/** 获取特殊关卡（牛关）奖励（CS: SpecialStoryStageRewardRequest；标记已领取，奖励空） */
router.post("/getCowLevelReward", validateBody(getCowLevelRewardSchema), async (req, res) => {
  const player = getPlayer();
  const { stageId } = req.body as GetCowLevelRewardRequest;
  const rewards: ItemBundle[] = [];
  await player.update(async (draft) => {
    const cowLevel = draft.dungeon.cowLevel[stageId];
    if (cowLevel) {
      // 标记奖励已领取（val 置 false 表示已领，参考官服结构）
      if (Array.isArray(cowLevel.val)) {
        cowLevel.val = cowLevel.val.map(() => false);
      }
    }
  });
  res.send({
    rewards,
    ...player.delta,
  } satisfies GetCowLevelRewardResponse);
});

/** 获取主线记录奖励（CS: ZoneRecordRewardRequest { stageId[] }；私服返回空） */
router.post("/getMainlineRecordRewards", validateBody(getMainlineRecordRewardsSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetMainlineRecordRewardsRequest;
  res.send({
    items: [],
    ...player.delta,
  } satisfies GetMainlineRecordRewardsResponse);
});

/** 获取主线缓存（CS: GetMainlineCacheRequest；私服返回空） */
router.post("/getMainlineCache", validateBody(getMainlineCacheSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetMainlineCacheRequest;
  res.send({
    items: [],
    ...player.delta,
  } satisfies GetMainlineCacheResponse);
});

/** 解锁关卡迷雾（CS: UnlockStageFogResponse；仅返回增量） */
router.post("/unlockStageFog", validateBody(unlockStageFogSchema), async (req, res) => {
  const player = getPlayer();
  req.body as UnlockStageFogRequest;
  res.send(player.delta satisfies UnlockStageFogResponse);
});

/** 解锁隐藏关卡（写 dungeon.hideStages[stageId].unlock） */
router.post("/unlockHideStage", validateBody(unlockHideStageSchema), async (req, res) => {
  const player = getPlayer();
  const { stageId } = req.body as UnlockHideStageRequest;
  await player.update(async (draft) => {
    const hideStages = draft.dungeon.hideStages;
    if (!hideStages[stageId]) {
      hideStages[stageId] = { unlock: 1 };
    } else {
      hideStages[stageId].unlock = 1;
    }
  });
  res.send(player.delta satisfies UnlockHideStageResponse);
});

/**
 * 确认六星奖励（CS: ConfirmSixStarRewardRequest { groupId, rewardIds }）
 * 私服记录领取状态，返回空增量
 */
router.post("/confirmSixStarReward", validateBody(confirmSixStarRewardSchema), async (req, res) => {
  const player = getPlayer();
  const { groupId, rewardIds = [] } = req.body as {
    groupId?: string;
    rewardIds?: string[];
  };
  await player.update(async (draft) => {
    const troop = draft.troop;
    troop.sixStarReward = troop.sixStarReward ?? {};
    const g = (troop.sixStarReward[groupId ?? ""] = troop.sixStarReward[groupId ?? ""] ?? {});
    for (const id of rewardIds) g[id] = 1;
  });
  res.send(player.delta);
});

export default router;
