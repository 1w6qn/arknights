import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import {
  AccelerateOrderRequest,
  AccelerateOrderResponse,
  AccelerateSolutionRequest,
  AccelerateSolutionResponse,
  AddPresetQueueRequest,
  AddPresetQueueResponse,
  AssignCharRequest,
  AssignCharResponse,
  BatchChangeWorkCharRequest,
  BatchChangeWorkCharResponse,
  BatchRestCharRequest,
  BatchRestCharResponse,
  BuildRoomRequest,
  BuildRoomResponse,
  BuyLaborRequest,
  BuyLaborResponse,
  ChangeBGMRequest,
  ChangeBGMResponse,
  ChangeDiySolutionRequest,
  ChangeDiySolutionResponse,
  ChangeManufactureSolutionRequest,
  ChangeManufactureSolutionResponse,
  ChangePresetNameRequest,
  ChangePresetNameResponse,
  ChangeSaleSolutionRequest,
  ChangeSaleSolutionResponse,
  ChangeStrategyRequest,
  ChangeStrategyResponse,
  CleanRoomSlotRequest,
  CleanRoomSlotResponse,
  CompleteUpgradeRoomRequest,
  CompleteUpgradeRoomResponse,
  CompleteUpgradeSpecializationRequest,
  CompleteUpgradeSpecializationResponse,
  ConfirmMessageBoardRewardRequest,
  ConfirmMessageBoardRewardResponse,
  ConfirmPrivateDormIntimacyRequest,
  ConfirmPrivateDormIntimacyResponse,
  DegradeRoomRequest,
  DegradeRoomResponse,
  DeleteOrderRequest,
  DeleteOrderResponse,
  DeleteOwnClueRequest,
  DeleteOwnClueResponse,
  DeletePresetQueueRequest,
  DeletePresetQueueResponse,
  DeleteReceiveClueRequest,
  DeleteReceiveClueResponse,
  DeliveryBatchOrderRequest,
  DeliveryBatchOrderResponse,
  DeliveryOrderRequest,
  DeliveryOrderResponse,
  EditLockQueueRequest,
  EditLockQueueResponse,
  EditPresetQueueRequest,
  EditPresetQueueResponse,
  GainAllIntimacyRequest,
  GainAllIntimacyResponse,
  GainAssistIntimacyRequest,
  GainAssistIntimacyResponse,
  GainIntimacyRequest,
  GainIntimacyResponse,
  GetAssistReportRequest,
  GetAssistReportResponse,
  GetClueBoxRequest,
  GetClueBoxResponse,
  GetClueFriendListRequest,
  GetClueFriendListResponse,
  GetInfoShareRewardRequest,
  GetInfoShareRewardResponse,
  GetDailyClueRequest,
  GetDailyClueResponse,
  GetInfoShareVisitorsNumRequest,
  GetInfoShareVisitorsNumResponse,
  GetMessageBoardContentResponse,
  GetMeetingroomRewardRequest,
  GetMeetingroomRewardResponse,
  GetOthersMessageBoardContentRequest,
  GetOthersMessageBoardContentResponse,
  GetRecentVisitorsRequest,
  GetRecentVisitorsResponse,
  GetThumbnailUrlRequest,
  GetThumbnailUrlResponse,
  PutClueToTheBoardAutoRequest,
  PutClueToTheBoardAutoResponse,
  PutClueToTheBoardRequest,
  PutClueToTheBoardResponse,
  ReceiveClueToStockRequest,
  ReceiveClueToStockResponse,
  SaveDiyPresetSolutionRequest,
  SaveDiyPresetSolutionResponse,
  SendClueAutoRequest,
  SendClueAutoResponse,
  SendClueRequest,
  SendClueResponse,
  SendEmojiRequest,
  SendEmojiResponse,
  SetBuildingAssistRequest,
  SetBuildingAssistResponse,
  SetPrivateDormOwnerRequest,
  SetPrivateDormOwnerResponse,
  SettleManufactureRequest,
  SettleManufactureResponse,
  SettleSaleRequest,
  SettleSaleResponse,
  StartInfoShareRequest,
  StartInfoShareResponse,
  UpgradeDiyLevelRequest,
  UpgradeDiyLevelResponse,
  UpgradeRoomRequest,
  UpgradeRoomResponse,
  UpgradeSpecializationRequest,
  UpgradeSpecializationResponse,
  UseOnePresetQueueRequest,
  UseOnePresetQueueResponse,
  UsePresetQueueRequest,
  UsePresetQueueResponse,
  VisitBuildingRequest,
  VisitBuildingResponse,
  WorkshopDecompositionRequest,
  WorkshopDecompositionResponse,
  WorkshopSynthesisRequest,
  WorkshopSynthesisResponse,
  BuildingSyncRequest,
  BuildingSyncResponse,
  TakeClueFromBoardRequest,
  TakeClueFromBoardResponse,
} from "./models";
import * as B from "./schemas";
import { validateBody } from "@core/http/validate-body";

const router = Router();

/**
 * 基建系统路由模块
 *
 * 提供基建系统的所有 HTTP 接口，包括房间管理、干员分配、订单生产、
 * 线索系统、预设队列以及其他基建相关功能。
 * 所有路由处理函数委托给 BuildingManager 进行业务处理。
 */

// ==================== 同步与基础设置 ====================

/** 同步基建数据 */
router.post("/sync", validateBody(B.buildingSyncSchema), async (req, res) => {
  const player = getPlayer();
  req.body as BuildingSyncRequest;
  const ts = await player.building.sync();
  const delta = player.delta;
  // 修复（高频无限 sync）：官方/DoctoratePy 的 /building/sync 响应
  // modified.building 是**完整 building 对象**（含 roomSlots/rooms/chars/status），
  // 客户端基建界面据此渲染各房间倒计时（completeWorkTime）并调度下一次 sync。
  // 本实现原为 mutative 增量 patch——制造站 remain=0 停摆后无 rooms 变更，
  // 响应 building 仅含 chars/status，缺 rooms → 客户端拿不到各房间 completeWorkTime
  // → 判定"状态未同步"→ 立即重试 → 无限请求。现强制注入完整 building 恒非空。
  const fullBuilding = player._playerdata.building;
  const d = delta.playerDataDelta;
  d.modified ??= {};
  d.modified.building = fullBuilding;
  res.send({
    ts,
    ...delta,
  } satisfies BuildingSyncResponse);
});

/** 切换基建背景音乐 */
router.post("/changeBGM", validateBody(B.changeBGMSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeBGMRequest;
  await player.building.changeBGM(body);
  res.send({
    ...player.delta,
  } satisfies ChangeBGMResponse);
});

/** 设置私人宿舍归属 */
router.post("/setPrivateDormOwner", validateBody(B.setPrivateDormOwnerSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetPrivateDormOwnerRequest;
  await player.building.setPrivateDormOwner(body);
  res.send({
    ...player.delta,
  } satisfies SetPrivateDormOwnerResponse);
});

/** 设置基建助战干员 */
router.post("/setBuildingAssist", validateBody(B.setBuildingAssistSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetBuildingAssistRequest;
  // 修复：缺 type/charInstId 必填参数时返回业务错误，而非 500
  if (typeof body?.type !== "number" || typeof body?.charInstId !== "number") {
    return res.send({ result: 1, ...player.delta });
  }
  await player.building.setBuildingAssist(body);
  res.send({
    ...player.delta,
  } satisfies SetBuildingAssistResponse);
});

// ==================== 房间管理 ====================

/** 建造房间 */
router.post("/buildRoom", async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuildRoomRequest;
  await player.building.buildRoom(body);
  res.send(player.delta satisfies BuildRoomResponse);
});

/** 升级房间等级 */
router.post("/upgradeRoom", validateBody(B.upgradeRoomSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UpgradeRoomRequest;
  await player.building.upgradeRoom(body);
  res.send(player.delta satisfies UpgradeRoomResponse);
});

/** 完成房间升级 */
router.post("/completeUpgradeRoom", validateBody(B.completeUpgradeRoomSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CompleteUpgradeRoomRequest;
  await player.building.completeUpgradeRoom();
  res.status(202).send(player.delta satisfies CompleteUpgradeRoomResponse);
});

/** 降级房间 */
router.post("/degradeRoom", validateBody(B.degradeRoomSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as DegradeRoomRequest;
  await player.building.degradeRoom(body);
  res.send(player.delta satisfies DegradeRoomResponse);
});

/** 专精升级（简化实现） */
router.post("/upgradeSpecialization", validateBody(B.upgradeSpecializationSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UpgradeSpecializationRequest;
  await player.building.upgradeSpecialization(body);
  res.send(player.delta satisfies UpgradeSpecializationResponse);
});

/** 完成专精升级（简化实现） */
router.post("/completeUpgradeSpecialization", validateBody(B.completeUpgradeSpecializationSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CompleteUpgradeSpecializationRequest;
  await player.building.completeUpgradeSpecialization(body);
  res.send(player.delta satisfies CompleteUpgradeSpecializationResponse);
});

/** 升级自定义等级（简化实现） */
router.post("/upgradeDiyLevel", validateBody(B.upgradeDiyLevelSchema), async (req, res) => {
  const player = getPlayer();
  req.body as UpgradeDiyLevelRequest;
  await player.building.upgradeDiyLevel();
  res.status(202).send(player.delta satisfies UpgradeDiyLevelResponse);
});

// ==================== 干员分配 ====================

/** 分配干员到房间 */
router.post("/assignChar", validateBody(B.assignCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AssignCharRequest;
  // 修复：缺 roomSlotId/charInstIdList 必填参数时返回业务错误，而非 500
  if (typeof body?.roomSlotId !== "string" || !Array.isArray(body?.charInstIdList)) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.building.assignChar(body);
  res.send(player.delta satisfies AssignCharResponse);
});

/** 批量更换工作干员（简化实现） */
router.post("/batchChangeWorkChar", validateBody(B.batchChangeWorkCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BatchChangeWorkCharRequest;
  await player.building.batchChangeWorkChar(body);
  res.status(202).send(player.delta satisfies BatchChangeWorkCharResponse);
});

/** 批量休息干员（简化实现） */
router.post("/batchRestChar", validateBody(B.batchRestCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BatchRestCharRequest;
  await player.building.batchRestChar(body);
  res.send(player.delta satisfies BatchRestCharResponse);
});

/** 获得信赖（简化实现） */
router.post("/gainIntimacy", validateBody(B.gainIntimacySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GainIntimacyRequest;
  await player.building.gainIntimacy(body);
  res.status(202).send(player.delta satisfies GainIntimacyResponse);
});

/** 获得全部信赖（简化实现） */
router.post("/gainAllIntimacy", async (req, res) => {
  const player = getPlayer();
  const body = req.body as GainAllIntimacyRequest;
  // 修复：响应含 normal/assist 计数（CS BuildingGainAllIntimacyResponse）
  const { normal, assist } = await player.building.gainAllIntimacy(body);
  res.status(202).send({
    normal,
    assist,
    ...player.delta,
  } satisfies GainAllIntimacyResponse);
});

/** 获得助战信赖（简化实现） */
router.post("/gainAssistIntimacy", validateBody(B.gainAssistIntimacySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GainAssistIntimacyRequest;
  await player.building.gainAssistIntimacy(body);
  res.status(202).send(player.delta satisfies GainAssistIntimacyResponse);
});

/** 确认私人宿舍信赖 */
router.post("/confirmPrivateDormIntimacy", async (req, res) => {
  const player = getPlayer();
  const body = req.body as ConfirmPrivateDormIntimacyRequest;
  await player.building.confirmPrivateDormIntimacy(body);
  res.send(player.delta satisfies ConfirmPrivateDormIntimacyResponse);
});

// ==================== 订单/生产 ====================

/** 加速订单（简化实现） */
router.post("/accelerateOrder", validateBody(B.accelerateOrderSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AccelerateOrderRequest;
  await player.building.accelerateOrder(body);
  res.status(202).send(player.delta satisfies AccelerateOrderResponse);
});

/** 加速方案（简化实现） */
router.post("/accelerateSolution", async (req, res) => {
  const player = getPlayer();
  const body = req.body as AccelerateSolutionRequest;
  await player.building.accelerateSolution(body);
  res.status(202).send(player.delta satisfies AccelerateSolutionResponse);
});

/** 完成订单（贸易站交付） */
router.post("/deliveryOrder", validateBody(B.deliveryOrderSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as DeliveryOrderRequest;
  await player.building.deliveryOrder(body);
  res.send(player.delta satisfies DeliveryOrderResponse);
});

/** 批量完成订单 */
router.post("/deliveryBatchOrder", async (req, res) => {
  const player = getPlayer();
  const body = req.body as DeliveryBatchOrderRequest;
  // 修复：官方字段为 slotList（结算每个贸易站全部库存订单），响应 delivered 对齐 CS
  const delivered = await player.building.deliveryBatchOrder(body);
  res.send({
    delivered,
    ...player.delta,
  } satisfies DeliveryBatchOrderResponse);
});

/** 删除订单（简化实现） */
router.post("/deleteOrder", async (req, res) => {
  const player = getPlayer();
  const body = req.body as DeleteOrderRequest;
  await player.building.deleteOrder(body);
  res.status(202).send(player.delta satisfies DeleteOrderResponse);
});

/** 制造站结算 */
router.post("/settleManufacture", validateBody(B.settleManufactureSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SettleManufactureRequest;
  // 修复：响应含 supplement（结算房间数，CS BuildingSettleManufactResponse）
  const supplement = await player.building.settleManufacture(body);
  res.send({
    supplement,
    ...player.delta,
  } satisfies SettleManufactureResponse);
});

/** 贸易站结算（简化实现） */
router.post("/settleSale", async (req, res) => {
  const player = getPlayer();
  const body = req.body as SettleSaleRequest;
  await player.building.settleSale(body);
  res.status(202).send(player.delta satisfies SettleSaleResponse);
});

/** 更换制造方案（收获后一键补货入口） */
router.post("/changeManufactureSolution", async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeManufactureSolutionRequest;
  const { change } = await player.building.changeManufactureSolution(body);
  res.send({
    change,
    ...player.delta,
  } satisfies ChangeManufactureSolutionResponse);
});

/** 更换贸易方案（简化实现） */
router.post("/changeSaleSolution", validateBody(B.changeSaleSolutionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeSaleSolutionRequest;
  await player.building.changeSaleSolution(body);
  res.status(202).send(player.delta satisfies ChangeSaleSolutionResponse);
});

/** 更换自定义方案 */
router.post("/changeDiySolution", async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeDiySolutionRequest;
  await player.building.changeDiySolution(body);
  res.send(player.delta satisfies ChangeDiySolutionResponse);
});

/** 加工站合成 */
router.post("/workshopSynthesis", validateBody(B.workshopSynthesisSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as WorkshopSynthesisRequest;
  const result = await player.building.workshopSynthesis(body);
  res.send({
    results: result,
    ...player.delta,
  } satisfies WorkshopSynthesisResponse);
});

/** 加工站分解（简化实现） */
router.post("/workshopDecomposition", validateBody(B.workshopDecompositionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as WorkshopDecompositionRequest;
  await player.building.workshopDecomposition(body);
  res.status(202).send(player.delta satisfies WorkshopDecompositionResponse);
});

// ==================== 线索系统 ====================

/** 获取每日线索（简化实现） */
router.post("/getDailyClue", validateBody(B.getDailyClueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetDailyClueRequest;
  await player.building.getDailyClue(body);
  res.status(202).send(player.delta satisfies GetDailyClueResponse);
});

/** 发送线索（简化实现） */
router.post("/sendClue", validateBody(B.sendClueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SendClueRequest;
  await player.building.sendClue(body);
  res.status(202).send(player.delta satisfies SendClueResponse);
});

/** 自动发送线索（简化实现） */
router.post("/sendClueAuto", validateBody(B.sendClueAutoSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SendClueAutoRequest;
  await player.building.sendClueAuto(body);
  res.status(202).send(player.delta satisfies SendClueAutoResponse);
});

/** 接收线索到库存（简化实现） */
router.post("/receiveClueToStock", async (req, res) => {
  const player = getPlayer();
  const body = req.body as ReceiveClueToStockRequest;
  await player.building.receiveClueToStock(body);
  res.status(202).send(player.delta satisfies ReceiveClueToStockResponse);
});

/** 放置线索到留言板（简化实现） */
router.post("/putClueToTheBoard", validateBody(B.putClueToTheBoardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PutClueToTheBoardRequest;
  await player.building.putClueToTheBoard(body);
  res.status(202).send(player.delta satisfies PutClueToTheBoardResponse);
});

/** 自动放置线索到留言板（简化实现） */
router.post("/putClueToTheBoardAuto", validateBody(B.putClueToTheBoardAutoSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PutClueToTheBoardAutoRequest;
  await player.building.putClueToTheBoardAuto(body);
  res.status(202).send(player.delta satisfies PutClueToTheBoardAutoResponse);
});

/** 删除自己持有的线索（简化实现） */
router.post("/deleteOwnClue", validateBody(B.deleteOwnClueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as DeleteOwnClueRequest;
  await player.building.deleteOwnClue(body);
  res.status(202).send(player.delta satisfies DeleteOwnClueResponse);
});

/** 删除接收到的线索（简化实现） */
router.post("/deleteReceiveClue", validateBody(B.deleteReceiveClueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as DeleteReceiveClueRequest;
  await player.building.deleteReceiveClue(body);
  res.status(202).send(player.delta satisfies DeleteReceiveClueResponse);
});

/** 获取线索盒 */
router.post("/getClueBox", validateBody(B.getClueBoxSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetClueBoxRequest;
  const result = await player.building.getClueBox();
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetClueBoxResponse);
});

/** 获取线索好友列表 */
router.post("/getClueFriendList", validateBody(B.getClueFriendListSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetClueFriendListRequest;
  const result = await player.building.getClueFriendList();
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetClueFriendListResponse);
});

/** 获取会客室情报分享奖励（访客列表） */
router.post("/getInfoShareReward", async (req, res) => {
  const player = getPlayer();
  req.body as GetInfoShareRewardRequest;
  const result = await player.building.getInfoShareReward();
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetInfoShareRewardResponse);
});

/** 获取会议室奖励 */
router.post("/getMeetingroomReward", validateBody(B.getMeetingroomRewardSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetMeetingroomRewardRequest;
  const result = await player.building.getMeetingroomReward();
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetMeetingroomRewardResponse);
});

// ==================== 预设队列 ====================

/** 添加预设队列（简化实现） */
router.post("/addPresetQueue", validateBody(B.addPresetQueueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AddPresetQueueRequest;
  await player.building.addPresetQueue(body);
  res.send(player.delta satisfies AddPresetQueueResponse);
});

/** 删除预设队列（简化实现） */
router.post("/deletePresetQueue", validateBody(B.deletePresetQueueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as DeletePresetQueueRequest;
  await player.building.deletePresetQueue(body);
  res.send(player.delta satisfies DeletePresetQueueResponse);
});

/** 编辑预设队列（简化实现） */
router.post("/editPresetQueue", validateBody(B.editPresetQueueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EditPresetQueueRequest;
  await player.building.editPresetQueue(body);
  res.send(player.delta satisfies EditPresetQueueResponse);
});

/** 使用预设队列（简化实现） */
router.post("/usePresetQueue", validateBody(B.usePresetQueueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UsePresetQueueRequest;
  await player.building.usePresetQueue(body);
  res.send(player.delta satisfies UsePresetQueueResponse);
});

/** 使用单个预设队列（简化实现） */
router.post("/useOnePresetQueue", validateBody(B.useOnePresetQueueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UseOnePresetQueueRequest;
  await player.building.useOnePresetQueue(body);
  res.status(202).send(player.delta satisfies UseOnePresetQueueResponse);
});

/** 修改预设名称（简化实现） */
router.post("/changePresetName", validateBody(B.changePresetNameSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangePresetNameRequest;
  await player.building.changePresetName(body);
  res.status(202).send(player.delta satisfies ChangePresetNameResponse);
});

/** 保存自定义预设方案（简化实现） */
router.post("/saveDiyPresetSolution", async (req, res) => {
  const player = getPlayer();
  const body = req.body as SaveDiyPresetSolutionRequest;
  await player.building.saveDiyPresetSolution(body);
  res.status(202).send(player.delta satisfies SaveDiyPresetSolutionResponse);
});

/** 编辑锁定队列（简化实现） */
router.post("/editLockQueue", validateBody(B.editLockQueueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EditLockQueueRequest;
  await player.building.editLockQueue(body);
  res.send(player.delta satisfies EditLockQueueResponse);
});

// ==================== 其他功能 ====================

/** 更改贸易站策略 */
router.post("/changeStrategy", validateBody(B.changeStrategySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeStrategyRequest;
  await player.building.changeStrategy(body);
  res.send(player.delta satisfies ChangeStrategyResponse);
});

/** 购买劳动力（简化实现） */
router.post("/buyLabor", validateBody(B.buyLaborSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyLaborRequest;
  await player.building.buyLabor(body);
  res.status(202).send(player.delta satisfies BuyLaborResponse);
});

/** 清理房间槽位（官方路由名：BuildingCleanRoomRequest → /cleanRoom） */
router.post("/cleanRoom", validateBody(B.cleanRoomSlotSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CleanRoomSlotRequest;
  await player.building.cleanRoomSlot(body);
  res.send(player.delta satisfies CleanRoomSlotResponse);
});

/** 清理房间槽位（兼容旧路由名） */
router.post("/cleanRoomSlot", validateBody(B.cleanRoomSlotSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CleanRoomSlotRequest;
  await player.building.cleanRoomSlot(body);
  res.send(player.delta satisfies CleanRoomSlotResponse);
});

/** 从留言板取回线索（官方路由名：BuildingMeetingClueTakeClueFromBoardRequest → /takeClueFromBoard） */
router.post("/takeClueFromBoard", async (req, res) => {
  const player = getPlayer();
  const body = req.body as TakeClueFromBoardRequest;
  await player.building.takeClueFromBoard(body);
  res.send(player.delta satisfies TakeClueFromBoardResponse);
});

/** 确认留言板奖励（会客室留言板：领取上周社交点 → reward 返回 SOCIAL_PT） */
router.post("/confirmMessageBoardReward", validateBody(B.confirmMessageBoardRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ConfirmMessageBoardRewardRequest;
  const reward = await player.building.confirmMessageBoardReward(body);
  res.send({
    reward,
    ...player.delta,
  } satisfies ConfirmMessageBoardRewardResponse);
});

/** 获取协助报告 */
router.post("/getAssistReport", validateBody(B.getAssistReportSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetAssistReportRequest;
  const result = await player.building.getAssistReport();
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetAssistReportResponse);
});

/** 获取信息共享访客数 */
router.post("/getInfoShareVisitorsNum", validateBody(B.getInfoShareVisitorsNumSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetInfoShareVisitorsNumRequest;
  const result = await player.building.getInfoShareVisitorsNum();
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetInfoShareVisitorsNumResponse);
});

/** 获取最近访客 */
router.post("/getRecentVisitors", validateBody(B.getRecentVisitorsSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetRecentVisitorsRequest;
  const result = await player.building.getRecentVisitors();
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetRecentVisitorsResponse);
});

/** 获取留言板内容（会客室留言板；CS BuildingPayloadGetMessageBoardContentResponse） */
router.post("/getMessageBoardContent", async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetOthersMessageBoardContentRequest;
  const result = await player.building.getMessageBoardContent(body);
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetMessageBoardContentResponse);
});

router.post("/getOthersMessageBoardContent", validateBody(B.getOthersMessageBoardContentSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetOthersMessageBoardContentRequest;
  // 修复：原实现丢弃返回值（客户端访问好友留言板空白）——现合并对方留言板内容
  const result = await player.building.getOthersMessageBoardContent(body);
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetOthersMessageBoardContentResponse);
});

/** 获取缩略图 URL（简化实现：私服无云端缩略图，返回空列表） */
router.post("/getThumbnailUrl", async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetThumbnailUrlRequest;
  const result = await player.building.getThumbnailUrl(body);
  res.send({
    ...result,
    ...player.delta,
  } satisfies GetThumbnailUrlResponse);
});

/** 发送表情（简化实现） */
router.post("/sendEmoji", async (req, res) => {
  const player = getPlayer();
  const body = req.body as SendEmojiRequest;
  await player.building.sendEmoji(body);
  res.status(202).send(player.delta satisfies SendEmojiResponse);
});

/** 开始信息共享（简化实现） */
router.post("/startInfoShare", validateBody(B.startInfoShareSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as StartInfoShareRequest;
  await player.building.startInfoShare(body);
  res.status(202).send(player.delta satisfies StartInfoShareResponse);
});

/** 访问基建（简化实现） */
router.post("/visitBuilding", validateBody(B.visitBuildingSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as VisitBuildingRequest;
  await player.building.visitBuilding(body);
  res.status(202).send(player.delta satisfies VisitBuildingResponse);
});

export default router;