/**
 * 肉鸽V2（集成战略）路由
 * 请求/响应类型见 ./models（参考 CS 2.7.61 协议类）
 *
 * 响应约定（2026-08-10 修复）：客户端需要完整 rlv2 子树（官方抓包确认
 * modified.rlv2 = { current, outer } 全量）。控制器子管理器（status/map/inventory/
 * troop/module）为内存态，不经 Immer 产生补丁 → 纯 player.delta 为空 modified，
 * 客户端收不到任何状态。rlv2Response 把控制器 toJSON 全量并入 modified.rlv2。
 */
import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";

const router = Router();

/**
 * 每请求开始时清空 pushMessage 收集器（控制器为玩家持久实例，_pushMessages 跨请求累积；
 * 此处统一在进入端点前复位，保证推送只随触发它的那次响应下发）
 */
router.use((_req, _res, next) => {
  const player = getPlayerOptional();
  player?.modules?.rlv2?.clearPushMessages();
  next();
});
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { RoguelikePushMessage } from "../../kernel/http/common";
import { isBlackstream } from "./theme-rules";
import {
  FinishBattleRewardRequest,
  FinishBattleRewardResponse,
  RL03ConfirmPredictRequest,
  RL03ConfirmPredictResponse,
  RL03UseTotemRequest,
  RL03UseTotemResponse,
  RL04LoseFragmentRequest,
  RL04LoseFragmentResponse,
  RL04UseInspirationRequest,
  RL04UseInspirationResponse,
  RoguelikeActivateTicketRequest,
  RoguelikeActivateTicketResponse,
  RoguelikeAlchemyRequest,
  RoguelikeAlchemyResponse,
  RoguelikeAlchemyRewardRequest,
  RoguelikeAlchemyRewardResponse,
  RoguelikeBankInvestRequest,
  RoguelikeBankInvestResponse,
  RoguelikeBankWithdrawRequest,
  RoguelikeBankWithdrawResponse,
  RoguelikeBattlePassBuyRewardRequest,
  RoguelikeBattlePassBuyRewardResponse,
  RoguelikeBattlePassGetRewardRequest,
  RoguelikeBattlePassGetRewardResponse,
  RoguelikeBuyGoodsRequest,
  RoguelikeBuyGoodsResponse,
  RoguelikeCloseTicketRequest,
  RoguelikeCloseTicketResponse,
  RoguelikeConfirmNodeMissionRequest,
  RoguelikeConfirmNodeMissionResponse,
  RoguelikeChangeCopperRequest,
  RoguelikeChangeCopperResponse,
  RoguelikeConfirmDrawCopperRequest,
  RoguelikeConfirmDrawCopperResponse,
  RoguelikeCopperRedrawRequest,
  RoguelikeCopperRedrawResponse,
  RoguelikeDiceChoiceRequest,
  RoguelikeDiceChoiceResponse,
  RoguelikeExpedReturnRequest,
  RoguelikeExpedReturnResponse,
  RoguelikeExpeditionRequest,
  RoguelikeExpeditionResponse,
  RoguelikeFinishBattleRequest,
  RoguelikeFinishBattleResponse,
  RoguelikeFinishEventRequest,
  RoguelikeFinishEventResponse,
  RoguelikeGameSettleRequest,
  RoguelikeGameSettleResponse,
  RoguelikeGetTicketAssistListRequest,
  RoguelikeGetTicketAssistListResponse,
  RoguelikeGildRequest,
  RoguelikeGildResponse,
  RoguelikeGiveUpNodeMissionRequest,
  RoguelikeGiveUpNodeMissionResponse,
  RoguelikeGridZoneEmptyStepRequest,
  RoguelikeGridZoneEmptyStepResponse,
  RoguelikeGridZoneMoveAndBattleStartRequest,
  RoguelikeGridZoneMoveAndBattleStartResponse,
  RoguelikeGridZoneMoveToRequest,
  RoguelikeGridZoneMoveToResponse,
  RoguelikeGridZoneReadStepZeroRequest,
  RoguelikeGridZoneReadStepZeroResponse,
  RoguelikeMoveToRequest,
  RoguelikeMoveToResponse,
  RoguelikePinTopicRequest,
  RoguelikePinTopicResponse,
  RoguelikeReadEndingChangeRequest,
  RoguelikeReadEndingChangeResponse,
  RoguelikeTopicRefreshMissionResponse,
  RoguelikeReadMissionTipRequest,
  RoguelikeReadMissionTipResponse,
  RoguelikeRecruitAssistCharRequest,
  RoguelikeRecruitAssistCharResponse,
  RoguelikeRecruitCharRequest,
  RoguelikeRecruitCharResponse,
  RoguelikeRollNodeRequest,
  RoguelikeRollNodeResponse,
  RoguelikeSacrificeRequest,
  RoguelikeSacrificeResponse,
  RoguelikeScrapChangeVehicleRequest,
  RoguelikeScrapChangeVehicleResponse,
  RoguelikeScrapLoseRequest,
  RoguelikeScrapLoseResponse,
  RoguelikeScrapRequest,
  RoguelikeScrapResponse,
  RoguelikeSelectChoiceRequest,
  RoguelikeSelectChoiceResponse,
  RoguelikeSelectInitialExploreToolRequest,
  RoguelikeSelectInitialExploreToolResponse,
  RoguelikeSelectInitialRecruitSetRequest,
  RoguelikeSelectInitialRecruitSetResponse,
  RoguelikeSelectInitialRelicRequest,
  RoguelikeSelectInitialRelicResponse,
  RoguelikeSelectRewardRequest,
  RoguelikeSelectRewardResponse,
  RoguelikeShopActionRequest,
  RoguelikeShopActionResponse,
  RoguelikeShopBattleRequest,
  RoguelikeShopBattleResponse,
  RoguelikeShopRefreshRequest,
  RoguelikeShopRefreshResponse,
  RoguelikeSpecialZoneLeaveRequest,
  RoguelikeSpecialZoneLeaveResponse,
  RoguelikeStashTicketRequest,
  RoguelikeStashTicketResponse,
  RoguelikeStashedTicketUseRequest,
  RoguelikeStashedTicketUseResponse,
  RoguelikeStepMoveToAndStartBattleRequest,
  RoguelikeStepMoveToAndStartBattleResponse,
  RoguelikeSetSeedRequest,
  RoguelikeSetSeedResponse,
  RoguelikeTopicCreateGameRequest,
  RoguelikeTopicCreateGameResponse,
  RoguelikeTopicGiveUpGameRequest,
  RoguelikeTopicGiveUpGameResponse,
  RoguelikeTraderReturnRequest,
  RoguelikeTraderReturnResponse,
  RoguelikeUnlockBuffRequest,
  RoguelikeUnlockBuffResponse,
  RoguelikeUpgradeNodeRequest,
  RoguelikeUpgradeNodeResponse,
  RoguelikeZoneRewardRequest,
  RoguelikeZoneRewardResponse,
  SetTroopCarryRequest,
  SetTroopCarryResponse,
} from "./models";
import * as ReqSchema from "./rlv2.schema";
import { rlv2Response, SEC } from "./response";
import { validateBody } from "@core/http/validate-body";
import { logger } from "@utils/logger";
import type { JsonValue } from "@excel/json-value";

/** giveUpGame 响应 current.record 视图（本路由下发 {brief} 摘要） */
interface GiveUpRecordView {
  brief?: JsonValue;
}

/**
 * 缺参校验辅助：必填字段缺失时返回业务错误（HTTP 200 + result≠0），
 * 避免 undefined 传入控制器抛 TypeError → 全局 500。响应结构同正常 rlv2。
 */
function rlv2MissingParam(player: PlayerDataManager) {
  return rlv2Response(player, { result: 1 }, SEC.ALL);
}

/** 放弃游戏（CS: RoguelikeTopicGiveUpGameRequest）——官方响应带 result:"ok"，
 *  current 节仅 [record, player]（2026-08-18 官服 giveUpGame 抓包校准） */
router.post("/giveUpGame", validateBody(ReqSchema.giveUpGameSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeTopicGiveUpGameRequest;
  await player.modules.rlv2.giveUpGame();
  const resp = rlv2Response(player, { result: "ok" }, SEC.GIVEUP);
  // 官服 giveUpGame 的 current.record 仅带 brief 摘要（完整 record 在 player.pending
  // 的 GAME_SETTLE.result.record 中）；原实现把完整 record 一并下发多余字段 → 客户端
  // 合并 current.record 时被污染。此处裁剪成 {brief} 对齐官服形状——存档
  // current.record.{brief,record} 保持不变，gameSettle 的 buildSettleResponse 不受影响。
  const cur = resp.playerDataDelta.modified.rlv2?.current;
  if (cur && typeof cur.record === "object" && cur.record !== null) {
    const record = cur.record as GiveUpRecordView;
    const brief = record.brief;
    cur.record = brief === undefined ? undefined : { brief };
  }
  res.send(
    resp satisfies RoguelikeTopicGiveUpGameResponse,
  );
});

/** 创建游戏（CS: RoguelikeTopicCreateGameRequest） */
router.post("/createGame", validateBody(ReqSchema.createGameSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeTopicCreateGameRequest;
  await player.modules.rlv2.createGame(body);
  res.send(rlv2Response(player, undefined, SEC.ALL, ["record", "monthTeam"], player.modules.rlv2.takePushMessages()) satisfies RoguelikeTopicCreateGameResponse);
});

/** 游戏结算（抓包 POST /rlv2/gameSettle，body {}；响应带 game/outer 结算数据） */
router.post("/gameSettle", validateBody(ReqSchema.gameSettleSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeGameSettleRequest;
  await player.modules.rlv2.gameSettle();
  res.send(
    // 官服 gameSettle rlv2.outer = 当前主题 7 键全量（record/bank/buff/bp/collect/mission/activity）——
    // 2026-08-18 抓包校准（非 createGame 的 {record,monthTeam} 精简）；
    // 推送一并随响应下发，避免残留到下一响应造成重复推送
    rlv2Response(player, player.modules.rlv2.buildSettleResponse(), SEC.ALL, [
      "record", "bank", "buff", "bp", "collect", "mission", "activity",
    ], player.modules.rlv2.takePushMessages()) satisfies RoguelikeGameSettleResponse,
  );
});

/** 选择初始密文（CS: RoguelikeSelectInitialRelicRequest） */
router.post("/chooseInitialRelic", validateBody(ReqSchema.chooseInitialRelicSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeSelectInitialRelicRequest;
  await player.modules.rlv2.chooseInitialRelic(body);
  res.send(
    rlv2Response(player, undefined, SEC.CORE, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeSelectInitialRelicResponse,
  );
});

/** 选择初始招募组（CS: RoguelikeSelectInitialRecruitSetRequest） */
router.post("/chooseInitialRecruitSet", validateBody(ReqSchema.chooseInitialRecruitSetSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeSelectInitialRecruitSetRequest;
  await player.modules.rlv2.chooseInitialRecruitSet(body);
  res.send(
    // 官服 chooseInitialRecruitSet current=[inventory,record,player]（无 buff）——2026-08-18 抓包校准
    rlv2Response(player, undefined, SEC.RECRUIT_SET) satisfies RoguelikeSelectInitialRecruitSetResponse,
  );
});

/** 选择初始探索工具（CS: RoguelikeSelectInitialExploreToolRequest） */
router.post("/chooseInitialExploreTool", validateBody(ReqSchema.chooseInitialExploreToolSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeSelectInitialExploreToolRequest;
  await player.modules.rlv2.chooseInitialExploreTool(body);
  res.send(
    rlv2Response(player) satisfies RoguelikeSelectInitialExploreToolResponse,
  );
});

/** 激活招募票（CS: RoguelikeActivateTicketRequest） */
router.post("/activeRecruitTicket", validateBody(ReqSchema.activeRecruitTicketSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeActivateTicketRequest;
  await player.modules.rlv2.activeRecruitTicket(body);
  // 官服 activeRecruitTicket current=[inventory,player]（无 record/buff）——2026-08-18 抓包校准
  res.send(rlv2Response(player, undefined, SEC.TICKET) satisfies RoguelikeActivateTicketResponse);
});

/** 招募干员（CS: RoguelikeRecruitCharRequest） */
router.post("/recruitChar", validateBody(ReqSchema.recruitCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeRecruitCharRequest;
  res.send(
    // 官服 recruitChar current=[inventory,troop,buff,player,module,record]（无 map/game）——2026-08-18 抓包校准
    rlv2Response(player, {
      chars: await player.modules.rlv2.recruitChar(body),
    }, SEC.RECRUIT_CHAR) satisfies RoguelikeRecruitCharResponse,
  );
});

/** 获取招募票助战列表（CS: RoguelikeGetTicketAssistListRequest） */
router.post("/getTicketAssistList", validateBody(ReqSchema.getTicketAssistListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeGetTicketAssistListRequest;
  await player.modules.rlv2.getTicketAssistList(body);
  res.send(
    rlv2Response(player) satisfies RoguelikeGetTicketAssistListResponse,
  );
});

/** 招募助战干员（CS: RoguelikeRecruitAssistCharRequest） */
router.post("/recruitAssistChar", validateBody(ReqSchema.recruitAssistCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeRecruitAssistCharRequest;
  await player.modules.rlv2.recruitAssistChar(body);
  res.send(rlv2Response(player) satisfies RoguelikeRecruitAssistCharResponse);
});

/** 结束事件（CS: RoguelikeFinishEventRequest） */
router.post("/finishEvent", validateBody(ReqSchema.finishEventSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeFinishEventRequest;
  // 修复：无进行中游戏（或游戏主题无效）时返回业务错误，避免状态机在空态下异常调用崩溃
  //（如冒烟空 body 探测触发 zone:new → 地图生成读取 undefined game.theme → details[undefined].stages → 500）
  const game = player.modules.rlv2.current?.game;
  if (!game || !game.theme) {
    res.send(rlv2MissingParam(player));
    return;
  }
  await player.modules.rlv2.finishEvent();
  // 官服 finishEvent 响应节动态：初始阶段（未进层）只发 CORE（player/inventory/record/buff）；
  // 消费完初始事件进入第一层（WAIT_MOVE，地图生成）追加 map/module（CORE_MAP_MODULE）。
  // 2026-08-18 官服抓包校准：finishEvent#1(INIT) current=[record,player,buff,inventory]；
  // finishEvent#2(进层) current=[record,player,module,map,buff,inventory]。
  const feState = player.modules.rlv2.current?.player?.state;
  const feSections = feState === "WAIT_MOVE" ? SEC.CORE_MAP_MODULE : SEC.CORE;
  res.send(rlv2Response(player, undefined, feSections, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeFinishEventResponse);
});

/**
 * 选择事件选项（CS: RoguelikeSelectChoiceRequest）
 * 控制器 selectChoice 已实现（buff/遗物/下一场景构建），此前漏接线
 */
router.post("/selectChoice", validateBody(ReqSchema.selectChoiceSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeSelectChoiceRequest;
  await player.modules.rlv2.selectChoice(body);
  // 官服 selectChoice 响应节 = CORE（player/inventory/record/buff）——2026-08-18 抓包校准
  res.send(rlv2Response(player, undefined, SEC.CORE, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeSelectChoiceResponse);
});

/** 移动（CS: RoguelikeMoveToRequest） */
router.post("/moveTo", validateBody(ReqSchema.moveToSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeMoveToRequest;
  await player.modules.rlv2.moveTo(body);
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeMoveToResponse);
});

/** 移动并开始战斗（CS: RoguelikeStepMoveToAndStartBattleRequest） */
router.post("/moveAndBattleStart", validateBody(ReqSchema.moveAndBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeStepMoveToAndStartBattleRequest;
  await player.modules.rlv2.moveAndBattleStart(body);
  res.send(
    rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeStepMoveToAndStartBattleResponse,
  );
});

/** 战斗结算（CS: RoguelikeFinishBattleRequest）——官服 current=[record,player,buff,inventory] */
router.post("/battleFinish", validateBody(ReqSchema.battleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeFinishBattleRequest;
  await player.modules.rlv2.battleFinish(body);
  // 战斗结束可能发放护盾/零件等（指挥分队升级/战斗掉落）——推送需随响应下发，
  // 否则客户端无获得提示（原实现漏传 takePushMessages）
  res.send(rlv2Response(player, undefined, SEC.CORE, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeFinishBattleResponse);
});

/** 选择战斗奖励（CS: RoguelikeSelectRewardRequest） */
router.post("/chooseBattleReward", validateBody(ReqSchema.chooseBattleRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeSelectRewardRequest;
  await player.modules.rlv2.chooseBattleReward(body);
  // 战斗奖励含零件组（黑流树海）：领取时 rlv2GotRandScrap 推送需随响应下发，
  // 否则获得加工品无提示（原实现漏传 takePushMessages）
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeSelectRewardResponse);
});

/** 完成战斗奖励（服务端自定义） */
router.post("/finishBattleReward", validateBody(ReqSchema.finishBattleRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as FinishBattleRewardRequest;
  await player.modules.rlv2.finishBattleReward(body);
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies FinishBattleRewardResponse);
});

/** 设置队伍携带（服务端自定义） */
router.post("/setTroopCarry", validateBody(ReqSchema.setTroopCarrySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetTroopCarryRequest;
  player.modules.rlv2.setTroopCarry(body);
  res.send(rlv2Response(player) satisfies SetTroopCarryResponse);
});

/** 丢失密文（CS: RL04LoseFragmentRequest） */
router.post("/loseFragment", validateBody(ReqSchema.loseFragmentSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RL04LoseFragmentRequest;
  player.modules.rlv2.loseFragment(body);
  res.send(rlv2Response(player) satisfies RL04LoseFragmentResponse);
});

/** 使用灵感（CS: RL04UseInspirationRequest） */
router.post("/useInspiration", validateBody(ReqSchema.useInspirationSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RL04UseInspirationRequest;
  player.modules.rlv2.useInspiration(body);
  res.send(rlv2Response(player) satisfies RL04UseInspirationResponse);
});

/** 置顶主题（CS: RoguelikePinTopicRequest） */
router.post("/setPinned", validateBody(ReqSchema.setPinnedSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikePinTopicRequest;
  player.modules.rlv2.setPinned(body);
  res.send(rlv2Response(player) satisfies RoguelikePinTopicResponse);
});

/** 刷新商店（CS: RoguelikeShopRefreshRequest） */
router.post("/refreshShop", validateBody(ReqSchema.refreshShopSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeShopRefreshRequest;
  await player.modules.rlv2.refreshShop();
  res.send(rlv2Response(player) satisfies RoguelikeShopRefreshResponse);
});

/** 离开商店（CS: RoguelikeShopActionRequest） */
router.post("/leaveShop", validateBody(ReqSchema.shopActionSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeShopActionRequest;
  await player.modules.rlv2.leaveShop();
  res.send(rlv2Response(player) satisfies RoguelikeShopActionResponse);
});

/** 商店购买（CS: RoguelikeShopActionRequest；控制器 buyGoods 已实现此前漏接线，同 selectChoice） */
router.post("/buyGoods", validateBody(ReqSchema.buyGoodsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeBuyGoodsRequest;
  await player.modules.rlv2.buyGoods({ select: body.select ?? 0 });
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeBuyGoodsResponse);
});

/** 商店操作（CS: RoguelikeShopActionRequest）：buy 数组 → buyGoods；否则离开商店 */
router.post("/shopAction", validateBody(ReqSchema.shopActionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeShopActionRequest;
  if (body.buy && body.buy.length > 0) {
    await player.modules.rlv2.buyGoods({ select: parseInt(body.buy[0], 10) || 0 });
  } else {
    await player.modules.rlv2.leaveShop();
  }
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeShopActionResponse);
});

/** 使用图腾（CS: RL03UseTotemRequest） */
router.post("/useTotem", validateBody(ReqSchema.useTotemSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RL03UseTotemRequest;
  await player.modules.rlv2.useTotem(body);
  res.send(rlv2Response(player) satisfies RL03UseTotemResponse);
});

/** 确认预言（CS: RL03ConfirmPredictRequest） */
router.post("/confirmPredict", validateBody(ReqSchema.confirmPredictSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RL03ConfirmPredictRequest;
  await player.modules.rlv2.confirmPredict();
  res.send(rlv2Response(player) satisfies RL03ConfirmPredictResponse);
});

/** 关闭招募票（CS: RoguelikeCloseTicketRequest） */
router.post("/closeRecruitTicket", validateBody(ReqSchema.closeRecruitTicketSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeCloseTicketRequest;
  await player.modules.rlv2.closeRecruitTicket(body);
  res.send(rlv2Response(player) satisfies RoguelikeCloseTicketResponse);
});

/** 读取结局变更（CS: RoguelikeReadEndingChangeRequest） */
router.post("/readEndingChange", validateBody(ReqSchema.readEndingChangeSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeReadEndingChangeRequest;
  await player.modules.rlv2.readEndingChange();
  // readEndingChange 自身会推 rlv2ChangeEnding：随本响应下发，避免残留重复
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeReadEndingChangeResponse);
});

/** 月度任务刷新（CS: RoguelikeTopicRefreshMissionRequest { theme, index }） */
router.post("/normal/refreshMission", validateBody(ReqSchema.refreshMissionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as { theme?: string; index?: number };
  await player.modules.rlv2.refreshMission(body);
  res.send(rlv2Response(player) satisfies RoguelikeTopicRefreshMissionResponse);
});

/** 确认区域奖励（CS: RoguelikeZoneRewardRequest { itemType }） */
router.post("/confirmZoneReward", validateBody(ReqSchema.confirmZoneRewardSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeZoneRewardRequest;
  await player.modules.rlv2.confirmZoneReward();
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeZoneRewardResponse);
});

/** 确认商人返回（CS: RoguelikeTraderReturnRequest） */
router.post("/confirmTraderReturn", validateBody(ReqSchema.confirmTraderReturnSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeTraderReturnRequest;
  await player.modules.rlv2.confirmTraderReturn();
  res.send(rlv2Response(player) satisfies RoguelikeTraderReturnResponse);
});

/** 离开特殊区域（CS: RoguelikeSpecialZoneLeaveRequest） */
router.post("/specialZone/leave", validateBody(ReqSchema.specialZoneLeaveSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeSpecialZoneLeaveRequest;
  await player.modules.rlv2.specialZoneLeave();
  res.send(rlv2Response(player) satisfies RoguelikeSpecialZoneLeaveResponse);
});

/** 战令领奖（抓包 { theme, rewards }） */
router.post("/battlePass/getReward", validateBody(ReqSchema.battlePassGetRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeBattlePassGetRewardRequest;
  const { items } = await player.modules.rlv2.battlePassGetReward(
    body.theme,
    body.rewards,
  );
  res.send(
    rlv2Response(player, { items }) satisfies RoguelikeBattlePassGetRewardResponse,
  );
});

/** 战令领奖（客户端路径 /rlv2/battlePass_getReward，下划线风格——官方抓包确认） */
router.post("/battlePass_getReward", validateBody(ReqSchema.battlePassGetRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeBattlePassGetRewardRequest;
  const { items } = await player.modules.rlv2.battlePassGetReward(
    body.theme,
    body.rewards,
  );
  res.send(
    rlv2Response(player, { items }) satisfies RoguelikeBattlePassGetRewardResponse,
  );
});

/** 战令直购奖励（CS: RoguelikeTopicBattlePassPurchaseRequest { theme, reward, cost }） */
router.post("/battlePass/buyReward", validateBody(ReqSchema.battlePassBuyRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeBattlePassBuyRewardRequest;
  const { items } = await player.modules.rlv2.battlePassBuyReward(
    body.theme,
    body.reward,
    body.cost,
  );
  res.send(
    rlv2Response(player, { items }) satisfies RoguelikeBattlePassBuyRewardResponse,
  );
});

/** 设置自定义种子（CS: RoguelikeTopicSetSeedRequest { theme, activityId, seed }） */
router.post("/setSeed", validateBody(ReqSchema.setSeedSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeSetSeedRequest;
  const { result } = await player.modules.rlv2.setSeed({ seed: body.seed });
  res.send(rlv2Response(player, { result }) satisfies RoguelikeSetSeedResponse);
});

/** 解锁科技树节点（CS: RoguelikeTopicUnlockBuffRequest { theme, buff }） */
router.post("/normal/unlockBuff", validateBody(ReqSchema.unlockBuffSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeUnlockBuffRequest;
  const { success, reason } = await player.modules.rlv2.unlockBuff(body.theme, body.buff);
  // 解锁失败（前置未解锁/点数不足等）不改数据：仅回增量，reason 记日志便于排障
  if (!success && reason) {
    logger.info("rlv2", `normal/unlockBuff 未生效：${body.buff}（${reason}）`);
  }
  res.send(rlv2Response(player) satisfies RoguelikeUnlockBuffResponse);
});

/** 更换铜钱（CS: RoguelikeChangeCopperRequest { index }） */
router.post("/copper/change", validateBody(ReqSchema.copperChangeSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeChangeCopperRequest;
  await player.modules.rlv2.copperChange(body);
  res.send(rlv2Response(player) satisfies RoguelikeChangeCopperResponse);
});

/** 确认抽铜钱（CS: RoguelikeConfirmDrawCopperRequest，无字段） */
router.post("/copper/confirmDraw", validateBody(ReqSchema.copperConfirmDrawSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeConfirmDrawCopperRequest;
  await player.modules.rlv2.copperConfirmDraw();
  res.send(rlv2Response(player) satisfies RoguelikeConfirmDrawCopperResponse);
});

/** 银行存钱（CS: RoguelikeBankInvestRequest） */
router.post("/bankPut", validateBody(ReqSchema.bankPutSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeBankInvestRequest;
  await player.modules.rlv2.bankPut();
  res.send(rlv2Response(player) satisfies RoguelikeBankInvestResponse);
});

/** 银行取钱（CS: RoguelikeBankWithdrawRequest { count }） */
router.post("/bankWithdraw", validateBody(ReqSchema.bankWithdrawSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeBankWithdrawRequest;
  await player.modules.rlv2.bankWithdraw(body);
  res.send(rlv2Response(player) satisfies RoguelikeBankWithdrawResponse);
});

/** 确认节点任务（CS: RoguelikeConfirmNodeMissionRequest） */
router.post("/nodeMission/confirm", validateBody(ReqSchema.nodeMissionConfirmSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeConfirmNodeMissionRequest;
  await player.modules.rlv2.nodeMissionConfirm();
  res.send(rlv2Response(player) satisfies RoguelikeConfirmNodeMissionResponse);
});

/** 放弃节点任务（CS: RoguelikeGiveUpNodeMissionRequest） */
router.post("/nodeMission/giveUp", validateBody(ReqSchema.nodeMissionGiveUpSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeGiveUpNodeMissionRequest;
  await player.modules.rlv2.nodeMissionGiveUp();
  res.send(rlv2Response(player) satisfies RoguelikeGiveUpNodeMissionResponse);
});

/** 关闭节点任务提示（CS: RoguelikeReadMissionTipRequest） */
router.post("/nodeMission/closeTip", validateBody(ReqSchema.nodeMissionCloseTipSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeReadMissionTipRequest;
  await player.modules.rlv2.nodeMissionCloseTip();
  res.send(rlv2Response(player) satisfies RoguelikeReadMissionTipResponse);
});

/**
 * 节点任务（客户端路径 /rlv2/nodeMission_confirm|giveUp|closeTip，下划线风格——
 * 官方抓包确认；斜杠路径保留兼容）
 */
router.post("/nodeMission_confirm", validateBody(ReqSchema.nodeMissionConfirmSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeConfirmNodeMissionRequest;
  await player.modules.rlv2.nodeMissionConfirm();
  res.send(rlv2Response(player) satisfies RoguelikeConfirmNodeMissionResponse);
});

router.post("/nodeMission_giveUp", validateBody(ReqSchema.nodeMissionGiveUpSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeGiveUpNodeMissionRequest;
  await player.modules.rlv2.nodeMissionGiveUp();
  res.send(rlv2Response(player) satisfies RoguelikeGiveUpNodeMissionResponse);
});

router.post("/nodeMission_closeTip", validateBody(ReqSchema.nodeMissionCloseTipSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeReadMissionTipRequest;
  await player.modules.rlv2.nodeMissionCloseTip();
  res.send(rlv2Response(player) satisfies RoguelikeReadMissionTipResponse);
});

/** 远征选择（CS: RoguelikeExpeditionRequest { choice, leave }） */
router.post("/expeditionChoice", validateBody(ReqSchema.expeditionChoiceSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeExpeditionRequest;
  const ret = await player.modules.rlv2.expeditionChoice(body);
  res.send(rlv2Response(player, ret) satisfies RoguelikeExpeditionResponse);
});

/** 确认远征返回（CS: RoguelikeExpedReturnRequest） */
router.post("/game/confirmExpeditonReturn", validateBody(ReqSchema.confirmExpeditionReturnSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeExpedReturnRequest;
  await player.modules.rlv2.confirmExpeditonReturn();
  res.send(rlv2Response(player) satisfies RoguelikeExpedReturnResponse);
});

/** 骰子选择（CS: RoguelikeDiceChoiceRequest） */
router.post("/diceChoice", validateBody(ReqSchema.diceChoiceSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeDiceChoiceRequest;
  const ret = await player.modules.rlv2.diceChoice(body);
  res.send(rlv2Response(player, ret) satisfies RoguelikeDiceChoiceResponse);
});

/** 献祭选择（CS: RoguelikeSacrificeRequest { choice, leave }） */
router.post("/sacrificeChoice", validateBody(ReqSchema.sacrificeChoiceSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeSacrificeRequest;
  await player.modules.rlv2.sacrificeChoice(body);
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeSacrificeResponse);
});

/** 铜币镀金（CS: RoguelikeGildRequest { choice, leave }） */
router.post("/copper/gild", validateBody(ReqSchema.gildSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeGildRequest;
  await player.modules.rlv2.copperGild(body);
  res.send(rlv2Response(player) satisfies RoguelikeGildResponse);
});

/** 铜币重抽（COPPER 模块） */
router.post("/copper/redraw", validateBody(ReqSchema.copperRedrawSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeCopperRedrawRequest;
  const ret = await player.modules.rlv2.copperRedraw();
  res.send(rlv2Response(player, ret) satisfies RoguelikeCopperRedrawResponse);
});

/** 商店战斗开始（CS: RoguelikeShopBattleRequest） */
router.post("/shopBattleStart", validateBody(ReqSchema.shopBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeShopBattleRequest;
  await player.modules.rlv2.shopBattleStart();
  res.send(rlv2Response(player) satisfies RoguelikeShopBattleResponse);
});

/** 重掷节点（CS: RoguelikeRollNodeRequest { nodeIndex }） */
router.post("/rerollNode", validateBody(ReqSchema.rollNodeSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeRollNodeRequest;
  await player.modules.rlv2.rerollNode(body);
  res.send(rlv2Response(player) satisfies RoguelikeRollNodeResponse);
});

/** 升级节点（CS: RoguelikeUpgradeNodeRequest { nodeType }） */
router.post("/upgradeNode", validateBody(ReqSchema.upgradeNodeSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeUpgradeNodeRequest;
  await player.modules.rlv2.upgradeNode(body);
  res.send(rlv2Response(player) satisfies RoguelikeUpgradeNodeResponse);
});

/** 暂存招募票（CS: RoguelikeStashTicketRequest { index }） */
router.post("/stashRecruitTicket", validateBody(ReqSchema.stashRecruitTicketSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeStashTicketRequest;
  await player.modules.rlv2.stashRecruitTicket(body);
  res.send(rlv2Response(player) satisfies RoguelikeStashTicketResponse);
});

/** 使用暂存票（CS: RoguelikeStashedTicketUseRequest { id }） */
router.post("/useStashedTicket", validateBody(ReqSchema.useStashedTicketSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeStashedTicketUseRequest;
  await player.modules.rlv2.useStashedTicket(body);
  res.send(rlv2Response(player) satisfies RoguelikeStashedTicketUseResponse);
});

/** 炼金（fragment 模块；抓包 { leave }） */
router.post("/alchemy", validateBody(ReqSchema.alchemySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeAlchemyRequest;
  await player.modules.rlv2.alchemy(body);
  res.send(rlv2Response(player) satisfies RoguelikeAlchemyResponse);
});

/** 炼金奖励（抓包 { index }） */
router.post("/alchemyReward", validateBody(ReqSchema.alchemyRewardSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeAlchemyRewardRequest;
  await player.modules.rlv2.alchemyReward({ index: 0 });
  res.send(rlv2Response(player) satisfies RoguelikeAlchemyRewardResponse);
});

/** 废品操作（rogue_6 SCRAP 模块） */
router.post("/scrap", validateBody(ReqSchema.scrapSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeScrapRequest;
  await player.modules.rlv2.scrap();
  // 丢弃载具会推 rlv2ScrapBreak：不随本响应下发则残留到下一响应重复出现
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeScrapResponse);
});

/** 废品换乘（rogue_6 SCRAP MOVE 型；客户端 body { scrapInstId, toWalk }） */
router.post("/scrap/changeVehicle", validateBody(ReqSchema.scrapChangeVehicleSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeScrapChangeVehicleRequest;
  await player.modules.rlv2.scrapChangeVehicle(body);
  res.send(
    rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeScrapChangeVehicleResponse,
  );
});

/** 丢弃废品（rogue_6 SCRAP 模块；客户端 body { instId }） */
router.post("/scrap/loseScrap", validateBody(ReqSchema.scrapLoseSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeScrapLoseRequest;
  await player.modules.rlv2.loseScrap(body);
  res.send(rlv2Response(player, undefined, undefined, undefined, player.modules.rlv2.takePushMessages()) satisfies RoguelikeScrapLoseResponse);
});

/** 废品鉴定（rogue_6 SCRAP 模块；抓包 body { count }，响应顶层 { scrap, legacy }） */
router.post("/scrap/identify", validateBody(ReqSchema.scrapIdentifySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as { count?: number };
  const ret = await player.modules.rlv2.scrapIdentify({ count: body?.count });
  res.send(
    rlv2Response(player, {
      scrap: ret.scrap,
      legacy: ret.legacy,
    }),
  );
});

/* ===== rogue_6 GRID_ZONE 网格区域 ===== */

/** 网格区域移动（抓包 { route: [nodeIndex] }）——官服 current=CORE_MAP_MODULE */
router.post("/gridZone/moveTo", validateBody(ReqSchema.gridZoneMoveToSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeGridZoneMoveToRequest;
  await player.modules.rlv2.gridZoneMoveTo(body);
  res.send(
    // 节点到达推送（rlv2NodeArrive/rlv2NodeChange）随响应下发——原实现漏传
    // takePushMessages，而黑流树海的移动全走本路由 → 推送永不到达客户端
    rlv2Response(
      player,
      undefined,
      SEC.CORE_MAP_MODULE,
      undefined,
      player.modules.rlv2.takePushMessages(),
    ) satisfies RoguelikeGridZoneMoveToResponse,
  );
});

/** 网格区域移动并开始战斗（抓包 { route, stageId, squad }）——官服 current=CORE_MAP_MODULE + outer */
router.post("/gridZone/moveAndBattleStart", validateBody(ReqSchema.gridZoneMoveAndBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RoguelikeGridZoneMoveAndBattleStartRequest;
  await player.modules.rlv2.gridZoneMoveAndBattleStart(body);
  res.send(
    // 官服 gridZone/moveAndBattleStart rlv2.outer = {record}——2026-08-18 抓包校准
    rlv2Response(
      player,
      undefined,
      SEC.CORE_MAP_MODULE,
      ["record"],
      player.modules.rlv2.takePushMessages(),
    ) satisfies RoguelikeGridZoneMoveAndBattleStartResponse,
  );
});

/** 网格区域空步（GRID_ZONE 节点消耗） */
router.post("/gridZone/emptyStep", validateBody(ReqSchema.gridZoneEmptyStepSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeGridZoneEmptyStepRequest;
  await player.modules.rlv2.gridZoneEmptyStep();
  res.send(rlv2Response(player) satisfies RoguelikeGridZoneEmptyStepResponse);
});

/** 网格区域读取第 0 步（GRID_ZONE 模块） */
router.post("/gridZone/readStepZero", validateBody(ReqSchema.gridZoneReadStepZeroSchema), async (req, res) => {
  const player = getPlayer();
  req.body as RoguelikeGridZoneReadStepZeroRequest;
  await player.modules.rlv2.gridZoneReadStepZero();
  res.send(
    rlv2Response(player) satisfies RoguelikeGridZoneReadStepZeroResponse,
  );
});

export default router;
