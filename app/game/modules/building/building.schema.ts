/**
 * 基建（building）请求 zod schema
 *
 * 对应 protocol/building.ts 的 Request 类型（参考 CS 2.7.61 协议类），
 * 供 router/building.ts 经 validateBody 做运行时校验：缺失必填字段 /
 * 类型不符时返回 HTTP 4xx，避免非法 body 传入控制器抛 500。
 *
 * 约定：
 * - 必填字段用对应类型（z.string()/z.number()/z.boolean()/z.array(...)）；
 * - 服务端不读或兼容形态的可选字段标 .optional()；
 * - 客户端会发送但服务端不读取的复杂嵌套对象用 z.json()；
 * - 服务端未读取请求体的端点用空 schema z.object({})。
 */
import { z } from "zod";

/* ===== 同步与基础设置 ===== */

/** 同步基建数据（CS: BuildingSyncRequest，服务端未读取请求体） */
export const buildingSyncSchema = z.object({});

/** 切换基建背景音乐（CS: BuildingChangeBGMRequest { musicId }） */
export const changeBGMSchema = z.object({
  musicId: z.string(),
});

/** 设置私人宿舍归属（CS: BuildingPayloadSetPrivateDormOwnerRequest；服务端读 slotId/charInstId） */
export const setPrivateDormOwnerSchema = z.object({
  slotId: z.string(),
  charInstId: z.number(),
  // CS 字段名为 charInsId，服务端不读取，标为可选
  charInsId: z.number().optional(),
});

/** 设置基建助战干员（CS: BuildingSetAssistRequest { type, charInstId }） */
export const setBuildingAssistSchema = z.object({
  type: z.number(),
  charInstId: z.number(),
});

/* ===== 房间管理 ===== */

/** 建造房间（CS: BuildingBuildRoomRequest { roomSlotId, roomId }） */
export const buildRoomSchema = z.object({
  roomSlotId: z.string(),
  roomId: z.string(),
});

/** 升级房间等级（CS: BuildingUpgradeRoomRequest { roomSlotId, targetLevel }） */
export const upgradeRoomSchema = z.object({
  roomSlotId: z.string(),
  targetLevel: z.number(),
});

/** 完成房间升级（CS: BuildingUpgradeCompleteRoomRequest，服务端未读取请求体） */
export const completeUpgradeRoomSchema = z.object({});

/** 降级房间（CS: BuildingDegradeRoomRequest { roomSlotId }；targetLevel 服务端不读） */
export const degradeRoomSchema = z.object({
  roomSlotId: z.string(),
  targetLevel: z.number().optional(),
});

/**
 * 专精升级（CS: UpdateSpecializationRequest）
 * 服务端读 charInstId/targetSkill；skillIndex/reduceTimeBd 客户端发送但服务端不读，
 * 后者用 z.json().optional() 透传（形态不深检）
 */
export const upgradeSpecializationSchema = z.object({
  charInstId: z.number(),
  targetSkill: z.number(),
  skillIndex: z.number().optional(),
  reduceTimeBd: z.json().optional(),
});

/** 完成专精升级（CS: CompleteUpgradeSpecializationRequest，服务端读 charInstId/targetSkill） */
export const completeUpgradeSpecializationSchema = z.object({
  charInstId: z.number(),
  targetSkill: z.number(),
});

/** 升级自定义等级（服务端自定义，服务端未读取请求体） */
export const upgradeDiyLevelSchema = z.object({});

/* ===== 干员分配 ===== */

/** 分配干员到房间（CS: BuildingAssignCharRequest { roomSlotId, charInstIdList }） */
export const assignCharSchema = z.object({
  roomSlotId: z.string(),
  charInstIdList: z.array(z.number()),
});

/**
 * 批量更换工作干员（CS: BuildingBatchChangeWorkCharRequest）
 * 抓包实测：客户端"换班"按钮发空体 {} 期望预设队列轮换；字段全可选匹配 handler
 * 契约（roomSlotId 缺省走队列轮换逻辑）。
 */
export const batchChangeWorkCharSchema = z.object({
  roomSlotId: z.string().optional(),
  slotId: z.string().optional(),
  charInstIdList: z.array(z.number()).optional(),
  charInstIds: z.array(z.number()).optional(),
  list: z.array(z.number()).optional(),
});

/**
 * 批量休息干员（CS: BuildingBatchChangeRestCharRequest）
 * 抓包实测：客户端可能发空体 {}（handler 空列表时直接不改分配）；字段可选。
 */
export const batchRestCharSchema = z.object({
  charInstIdList: z.array(z.number()).optional(),
  charInstIds: z.array(z.number()).optional(),
  list: z.array(z.number()).optional(),
});

/** 获得信赖（CS: CharBuildIncIntimacyRequest { charInstId }） */
export const gainIntimacySchema = z.object({
  charInstId: z.number(),
});

/** 获得全部信赖（CS: BuildingGainAllIntimacyRequest，无字段） */
export const gainAllIntimacySchema = z.object({});

/** 获得助战信赖（CS: CharBuildIncAssistIntimacyRequest { charInstId }） */
export const gainAssistIntimacySchema = z.object({
  charInstId: z.number(),
});

/** 确认私人宿舍信赖（CS: BuildingPayloadConfirmPrivateDormIntimacyRequest { charInstId }） */
export const confirmPrivateDormIntimacySchema = z.object({
  charInstId: z.number(),
});

/** 清理房间槽位（CS: BuildingCleanRoomRequest { roomSlotId }） */
export const cleanRoomSlotSchema = z.object({
  roomSlotId: z.string(),
});

/* ===== 订单/生产 ===== */

/** 加速订单（CS: BuildingTradingLaborAccelRequest { slotId, orderId }；cost 服务端不读） */
export const accelerateOrderSchema = z.object({
  slotId: z.string(),
  orderId: z.number(),
  cost: z.number().optional(),
});

/** 加速方案（CS: BuildingManufactLaborAccelRequest { slotId }；cost 服务端不读） */
export const accelerateSolutionSchema = z.object({
  slotId: z.string(),
  cost: z.number().optional(),
});

/**
 * 完成订单（CS: BuildingTradingDeliveryRequest { slotId, orderId }）。
 * 修复（2026-08-26 dc-fix）：CS orderId 为 Int64（客户端发数字）——原 schema 强制
 * string 导致 400；兼容两种形态（manager 内按 String(instId) 匹配）。
 */
export const deliveryOrderSchema = z.object({
  slotId: z.string(),
  orderId: z.union([z.string(), z.number()]),
});

/** 批量完成订单（CS: BuildingDeliveryBatchOrderRequest { slotList }，均可选） */
export const deliveryBatchOrderSchema = z.object({
  slotList: z.array(z.string()).optional(),
});

/** 删除订单（CS: BuildingTradingDeleteOrderRequest { slotId, orderId }） */
export const deleteOrderSchema = z.object({
  slotId: z.string(),
  orderId: z.number(),
});

/** 制造站结算（CS: BuildingSettleManufactRequest { roomSlotIdList, supplement }，均可选） */
export const settleManufactureSchema = z.object({
  roomSlotIdList: z.array(z.string()).optional(),
  supplement: z.number().optional(),
});

/** 贸易站结算（CS: BuildingSettleSaleRequest；roomSlotIdList/slotId 兼容，均可选） */
export const settleSaleSchema = z.object({
  roomSlotIdList: z.array(z.string()).optional(),
  slotId: z.string().optional(),
});

/** 更换制造方案（CS: BuildingChangeManufactRequest { roomSlotId, targetFormulaId, solutionCount }） */
export const changeManufactureSolutionSchema = z.object({
  roomSlotId: z.string(),
  targetFormulaId: z.string(),
  solutionCount: z.number(),
});

/**
 * 更换贸易方案（CS: BuildingChangeShopRequest）
 * 兼容 slotId/solution（私服扩展形态）与 CS 形态，字段均可选
 */
export const changeSaleSolutionSchema = z.object({
  roomSlotId: z.string().optional(),
  stockIndex: z.number().optional(),
  targetFormulaId: z.string().optional(),
  solutionCount: z.number().optional(),
  slotId: z.string().optional(),
  solution: z
    .object({
      strategy: z.string(),
      stockLimit: z.number(),
    })
    .optional(),
});

/**
 * 更换自定义方案（CS: BuildingDIYChangeDIYSolutionRequest）
 *
 * solution 按 handler（building/logic/manufacture.ts#changeDiySolution）实际读取的字段收紧：
 * wallPaper/floor（家具 ID）与 carpet/other 的 `id` 用于求和房间舒适度；整份 solution 仍
 * 原样存入 diySolution，故 passthrough 保留未被读取的家具明细字段，避免剥字段丢存档数据
 */
export const changeDiySolutionSchema = z.object({
  roomSlotId: z.string(),
  solution: z
    .object({
      wallPaper: z.string().optional(),
      floor: z.string().optional(),
      carpet: z.array(z.object({ id: z.string() }).passthrough()).optional(),
      other: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    })
    .passthrough(),
});

/**
 * 加工站合成（CS: BuildingWorkshopSynthesisRequest { formulaId, times }）。
 * 修复（2026-08-26 dc-fix）：CS 请求体无 roomSlotId 字段——原 schema 强制导致客户端请求 400；
 * 改可选（服务端按 formulaId 合成，无需房间定位）。
 */
export const workshopSynthesisSchema = z.object({
  roomSlotId: z.string().optional(),
  formulaId: z.string(),
  times: z.number(),
});

/** 加工站分解（CS: BuildingWorkshopDecompositionRequest；兼容形态，字段均可选） */
export const workshopDecompositionSchema = z.object({
  furniId: z.string().optional(),
  times: z.number().optional(),
  furnitureId: z.string().optional(),
  count: z.number().optional(),
});

/* ===== 线索系统 ===== */

/** 获取每日线索（CS: BuildingMeetingClueGetDailyClueRequest，无字段） */
export const getDailyClueSchema = z.object({});

/** 发送线索（CS: BuildingMeetingClueSendClueRequest { friendId }；clueId/id 兼容可选） */
export const sendClueSchema = z.object({
  friendId: z.string(),
  clueId: z.string().optional(),
  id: z.string().optional(),
});

/** 自动发送线索（CS: BuildingMeetingClueAutoSendClueRequest，无字段） */
export const sendClueAutoSchema = z.object({});

/** 接收线索到库存（CS: BuildingMeetingClueReceiveClueToStockRequest；clues/id 兼容可选） */
export const receiveClueToStockSchema = z.object({
  clues: z.array(z.string()).optional(),
  id: z.string().optional(),
});

/** 放置线索到留言板（CS: BuildingMeetingCluePutClueToTheBoardRequest；clueId/id 兼容可选） */
export const putClueToTheBoardSchema = z.object({
  clueId: z.string().optional(),
  id: z.string().optional(),
});

/** 自动放置线索到留言板（CS: BuildingMeetingClueAutoEquipCluesRequest，无字段） */
export const putClueToTheBoardAutoSchema = z.object({});

/** 删除自己持有的线索（CS: BuildingMeetingClueDeleteOwnClueRequest；clueId/id 兼容可选） */
export const deleteOwnClueSchema = z.object({
  clueId: z.string().optional(),
  id: z.string().optional(),
});

/** 删除接收到的线索（CS: BuildingMeetingClueDeleteReceiveClueRequest；clueId/id 兼容可选） */
export const deleteReceiveClueSchema = z.object({
  clueId: z.string().optional(),
  id: z.string().optional(),
});

/** 从留言板取回线索（CS: BuildingMeetingClueTakeClueFromBoardRequest { type }） */
export const takeClueFromBoardSchema = z.object({
  type: z.string(),
});

/** 获取线索盒（CS: BuildingMeetingClueUpdateWaitingClueRequest，无字段） */
export const getClueBoxSchema = z.object({});

/** 获取线索好友列表（CS: BuildingGetFriendSortListInfoRequest，无字段） */
export const getClueFriendListSchema = z.object({});

/** 获取会客室情报分享奖励（CS: BuildingMeetingClueReceiveInfoShareRewardRequest，无字段） */
export const getInfoShareRewardSchema = z.object({});

/** 获取会议室奖励（CS: BuildingMeetingClueGetMeetingRoomRewardRequest，服务端未读取请求体） */
export const getMeetingroomRewardSchema = z.object({});

/* ===== 预设队列 ===== */

/** 添加预设队列（CS: BuildingAddPresetQueueRequest；兼容形态，字段均可选） */
export const addPresetQueueSchema = z.object({
  slotId: z.string().optional(),
  roomSlotId: z.string().optional(),
  charInstIdList: z.array(z.number()).optional(),
  presetName: z.string().optional(),
});

/** 删除预设队列（CS: BuildingDeletePresetQueueRequest；字段均可选） */
export const deletePresetQueueSchema = z.object({
  slotId: z.string().optional(),
  index: z.number().optional(),
  roomSlotId: z.string().optional(),
});

/** 编辑预设队列（CS: BuildingEditPresetQueueRequest；字段均可选） */
export const editPresetQueueSchema = z.object({
  slotId: z.string().optional(),
  index: z.number().optional(),
  queue: z.array(z.number()).optional(),
  roomSlotId: z.string().optional(),
  charInstIdList: z.array(z.number()).optional(),
});

/** 使用预设队列（CS: BuildingUsePresetQueueRequest；字段均可选） */
export const usePresetQueueSchema = z.object({
  slotId: z.string().optional(),
  index: z.number().optional(),
  roomSlotId: z.string().optional(),
});

/** 使用单个预设队列（私服扩展；字段均可选） */
export const useOnePresetQueueSchema = z.object({
  slotId: z.string().optional(),
  roomSlotId: z.string().optional(),
});

/** 修改预设名称（CS: BuildingDIYRenamePresetSolutionRequest；兼容形态，字段均可选） */
export const changePresetNameSchema = z.object({
  solutionId: z.number().optional(),
  name: z.string().optional(),
  slotId: z.string().optional(),
  roomSlotId: z.string().optional(),
  presetName: z.string().optional(),
});

/**
 * 保存自定义预设方案（CS: BuildingDIYSavePresetSolutionRequest）
 * solution 服务端不读内层字段（整体存入 diyPresetSolutions[presetName]），用 z.json() 透传
 */
export const saveDiyPresetSolutionSchema = z.object({
  solutionId: z.number().optional(),
  roomType: z.string().optional(),
  name: z.string().optional(),
  thumbnail: z.string().optional(),
  presetName: z.string(),
  solution: z.json(),
});

/**
 * 编辑锁定队列（CS: BuildingSaveDormLockRequest）
 * lockPos 字典服务端不读（只读 roomSlotId/locked），用 z.json().optional() 透传
 */
export const editLockQueueSchema = z.object({
  lockPos: z.json().optional(),
  roomSlotId: z.string(),
  locked: z.boolean(),
});

/* ===== 其他功能 ===== */

/** 更改贸易站策略（CS: BuildingTradingChangeStrategyRequest { slotId, strategy }） */
export const changeStrategySchema = z.object({
  slotId: z.string(),
  strategy: z.string(),
});

/** 购买劳动力（CS: BuildingBuyLaborRequest { buyCount }；costAp/ts 服务端不读） */
export const buyLaborSchema = z.object({
  buyCount: z.number(),
  costAp: z.number().optional(),
  ts: z.number().optional(),
});

/** 确认留言板奖励（CS: BuildingPayloadConfirmMessageBoardRewardRequest，服务端未读取请求体） */
export const confirmMessageBoardRewardSchema = z.object({});

/** 获取协助报告（CS: BuildingAssistReportRequest，无字段） */
export const getAssistReportSchema = z.object({});

/** 获取信息共享访客数（CS: BuildingMeetingClueGetInfoShareVisitorsRequest，无字段） */
export const getInfoShareVisitorsNumSchema = z.object({});

/** 获取最近访客（CS: BuildingGetRecentVisitorsRequest，无字段） */
export const getRecentVisitorsSchema = z.object({});

/** 获取他人留言板内容（CS: BuildingPayloadGetOthersMessageBoardContentRequest；uid/friendId 兼容可选） */
export const getOthersMessageBoardContentSchema = z.object({
  uid: z.string().optional(),
  friendId: z.string().optional(),
});

/** 获取缩略图 URL（CS: BuildingDIYGetPresetThumbnailUrlRequest { solutionId }） */
export const getThumbnailUrlSchema = z.object({
  solutionId: z.array(z.number()),
});

/** 发送表情（CS: BuildingSendEmojiRequest { friendId, emoji }） */
export const sendEmojiSchema = z.object({
  friendId: z.string(),
  emoji: z.string(),
});

/** 开始信息共享（CS: BuildingMeetingClueStartInfoShareRequest，无字段） */
export const startInfoShareSchema = z.object({});

/** 访问基建（CS: VisitBuildingRequest { friendId }） */
export const visitBuildingSchema = z.object({
  friendId: z.string(),
});
/** 查看他人留言板（CS: BuildingPayloadGetMessageBoardContentRequest { uid?, friendId? }） */
export const getMessageBoardContentSchema = z.object({
  uid: z.string().optional(),
  friendId: z.string().optional(),
});
