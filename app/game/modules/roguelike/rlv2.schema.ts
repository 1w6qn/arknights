/**
 * 肉鸽V2（集成战略）请求/响应 zod schema
 *
 * 参照反编译 CS（com.hypergryph.arknights_2.7.61.cs "Torappu"/"Torappu.UI.Roguelike"
 * 命名空间下 Roguelike/RL03/RL04 各 Request/Response 类）协议类字段定义，为
 * app/game/modules/roguelike/handler.ts 全部端点建立请求格式约束：缺失必填字段 / 类型不符时
 * 由 validateBody 中间件返回 HTTP 4xx，避免非法 body 传入控制器抛 500。
 *
 * 约定：
 * - z.json() 表示"键必须存在、值类型不深检"（如 battleData/squad 这类复杂嵌套对象，
 *   仅保证出现，避免对客户端完整结构误伤）。
 * - .optional() 表示服务端不读或抓包确认可不传的字段。
 * - 响应 schema 仅作类型断言用（rlv2Response 已保证结构），不参与运行时校验。
 */
import { z } from "zod";

/* ===== 坐标/节点位置（CS: RoguelikeNodePosition { x, y }） ===== */
const nodePositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/* ===== 请求 schema ===== */

/** 放弃游戏（CS: RoguelikeTopicGiveUpGameRequest，无字段） */
export const giveUpGameSchema = z.object({});

/** 创建游戏（CS: RoguelikeTopicCreateGameRequest） */
export const createGameSchema = z.object({
  theme: z.string(),
  mode: z.string(),
  modeGrade: z.number(),
  // 抓包/测试确认部分请求不携带 predefinedId（controller 按 undefined 处理），故可选
  predefinedId: z.string().nullable().optional(),
  // 修复：客户端在无关联活动时显式传 activityId:null 而非省略；仅 optional() 放行
  // undefined 不放行 null → 抓包实测被拦成 422，补 nullable()
  activityId: z.string().nullable().optional(),
});

/** 选择初始密文（CS: RoguelikeSelectInitialRelicRequest { select }） */
export const chooseInitialRelicSchema = z.object({
  select: z.string(),
});

/** 选择初始招募组（CS: RoguelikeSelectInitialRecruitSetRequest { select }） */
export const chooseInitialRecruitSetSchema = z.object({
  select: z.string(),
});

/** 选择初始探索工具（CS: RoguelikeSelectInitialExploreToolRequest { select }） */
export const chooseInitialExploreToolSchema = z.object({
  select: z.string(),
});

/** 激活招募票（CS: RoguelikeActivateTicketRequest { id }） */
export const activeRecruitTicketSchema = z.object({
  id: z.string(),
});

/** 招募干员（CS: RoguelikeRecruitCharRequest { ticketIndex, optionId }） */
export const recruitCharSchema = z.object({
  ticketIndex: z.string(),
  optionId: z.string(),
});

/** 获取招募票助战列表（CS: RoguelikeGetTicketAssistListRequest { ticketIndex, profession }） */
export const getTicketAssistListSchema = z.object({
  ticketIndex: z.string(),
  profession: z.string(),
});

/** 招募助战干员（CS: RoguelikeRecruitAssistCharRequest） */
export const recruitAssistCharSchema = z.object({
  ticketIndex: z.string(),
  profession: z.string(),
  assistUid: z.string(),
  assistCharId: z.string(),
});

/** 结束事件（CS: RoguelikeFinishEventRequest，无字段） */
export const finishEventSchema = z.object({});

/** 选择事件选项（CS: RoguelikeSelectChoiceRequest { choice }） */
export const selectChoiceSchema = z.object({
  choice: z.string(),
});

/** 移动（CS: RoguelikeMoveToRequest { to }） */
export const moveToSchema = z.object({
  to: nodePositionSchema,
});

/** 移动并开始战斗（服务端契约 { to, stageId, squad }） */
export const moveAndBattleStartSchema = z.object({
  to: nodePositionSchema,
  stageId: z.string(),
  squad: z.json(),
});

/** 战斗结算（CS: RoguelikeFinishBattleRequest : CommonFinishBattleRequest + battleLog） */
export const battleFinishSchema = z.object({
  data: z.string(),
  // battleData 为客户端完整战报对象，仅保证存在，不做深类型校验
  battleData: z.json(),
  battleLog: z.string(),
});

/** 选择战斗奖励（CS: RoguelikeSelectRewardRequest { index, sub }） */
export const chooseBattleRewardSchema = z.object({
  index: z.number(),
  sub: z.number(),
});

/** 完成战斗奖励（服务端自定义，无 CS 对应类） */
export const finishBattleRewardSchema = z.object({});

/** 设置队伍携带（服务端自定义，RL04SetFragmentCharRequest { troopCarry }） */
export const setTroopCarrySchema = z.object({
  troopCarry: z.array(z.string()),
});

/** 丢失密文（CS: RL04LoseFragmentRequest { fragmentIndex }） */
export const loseFragmentSchema = z.object({
  fragmentIndex: z.string(),
});

/** 使用灵感（CS: RL04UseInspirationRequest { fragmentIndex }） */
export const useInspirationSchema = z.object({
  fragmentIndex: z.string(),
});

/** 置顶主题（CS: RoguelikePinTopicRequest { id }） */
export const setPinnedSchema = z.object({
  id: z.string(),
});

/** 刷新商店（CS: RoguelikeShopRefreshRequest，无字段） */
export const refreshShopSchema = z.object({});

/** 商店操作（CS: RoguelikeShopActionRequest { buy, recycle, leave }） */
export const shopActionSchema = z.object({
  buy: z.array(z.string()).optional(),
  recycle: z.array(z.string()).optional(),
  leave: z.number().optional(),
});

/** 使用图腾（CS: RL03UseTotemRequest { totemIndex[], nodeIndex[] }；服务端契约为二元组） */
export const useTotemSchema = z.object({
  totemIndex: z.array(z.string()),
  nodeIndex: z.array(z.string()),
});

/** 确认预言（CS: RL03ConfirmPredictRequest，无字段） */
export const confirmPredictSchema = z.object({});

/** 关闭招募票（CS: RoguelikeCloseTicketRequest { id }） */
export const closeRecruitTicketSchema = z.object({
  id: z.string(),
});

/** 读取结局变更（CS: RoguelikeReadEndingChangeRequest，无字段） */
export const readEndingChangeSchema = z.object({});

/** 月度任务刷新（服务端抓包 { theme, index }） */
export const refreshMissionSchema = z.object({
  theme: z.string().optional(),
  index: z.number().optional(),
});

/** 确认区域奖励（CS: RoguelikeZoneRewardRequest { itemType }） */
export const confirmZoneRewardSchema = z.object({
  itemType: z.string().optional(),
});

/** 确认商人返回（CS: RoguelikeTraderReturnRequest，无字段） */
export const confirmTraderReturnSchema = z.object({});

/** 离开特殊区域（CS: RoguelikeSpecialZoneLeaveRequest，无字段） */
export const specialZoneLeaveSchema = z.object({});

/** 战令领奖（抓包 { theme, rewards }） */
export const battlePassGetRewardSchema = z.object({
  theme: z.string(),
  rewards: z.array(z.string()).optional(),
});

/** 战令直购奖励（CS: RoguelikeTopicBattlePassPurchaseRequest { theme, reward, cost }） */
export const battlePassBuyRewardSchema = z.object({
  theme: z.string(),
  reward: z.string(),
  cost: z.number().int().nonnegative(),
});

/** 设置自定义种子（CS: RoguelikeTopicSetSeedRequest { theme, activityId, seed }） */
export const setSeedSchema = z.object({
  theme: z.string().optional(),
  activityId: z.string().optional(),
  seed: z.string(),
});

/** 解锁科技树节点（CS: RoguelikeTopicUnlockBuffRequest { theme, buff }） */
export const unlockBuffSchema = z.object({
  theme: z.string(),
  buff: z.string(),
});

/** 银行存钱（CS: RoguelikeBankInvestRequest，无字段） */
export const bankPutSchema = z.object({});

/** 银行取钱（CS: RoguelikeBankWithdrawRequest / UseItem { count }） */
export const bankWithdrawSchema = z.object({
  count: z.number().optional(),
});

/** 确认节点任务（CS: RoguelikeConfirmNodeMissionRequest，无字段） */
export const nodeMissionConfirmSchema = z.object({});

/** 放弃节点任务（CS: RoguelikeGiveUpNodeMissionRequest，无字段） */
export const nodeMissionGiveUpSchema = z.object({});

/** 关闭节点任务提示（CS: RoguelikeReadMissionTipRequest，无字段） */
export const nodeMissionCloseTipSchema = z.object({});

/** 远征选择（CS: RoguelikeExpeditionRequest { choice, leave }） */
export const expeditionChoiceSchema = z.object({
  choice: z.string().optional(),
  leave: z.number().optional(),
});

/** 确认远征返回（CS: RoguelikeExpedReturnRequest，无字段） */
export const confirmExpeditionReturnSchema = z.object({});

/** 骰子选择（CS: RoguelikeDiceChoiceRequest { choice }） */
export const diceChoiceSchema = z.object({
  choice: z.string().optional(),
});

/** 献祭选择（CS: RoguelikeSacrificeRequest { choice, leave }） */
export const sacrificeChoiceSchema = z.object({
  choice: z.string().optional(),
  leave: z.number().optional(),
});

/** 铜币镀金（CS: RoguelikeGildRequest { choice, leave }） */
export const gildSchema = z.object({
  choice: z.string().optional(),
  leave: z.number().optional(),
});

/** 铜币重抽（COPPER 模块，无字段） */
export const copperRedrawSchema = z.object({});

/** 更换铜钱（CS: RoguelikeChangeCopperRequest { index }） */
export const copperChangeSchema = z.object({
  index: z.string().optional(),
});

/** 确认抽铜钱（CS: RoguelikeConfirmDrawCopperRequest，无字段） */
export const copperConfirmDrawSchema = z.object({});

/** 商店战斗开始（CS: RoguelikeShopBattleRequest，无字段） */
export const shopBattleStartSchema = z.object({});

/** 重掷节点（CS: RoguelikeRollNodeRequest { nodeIndex }） */
export const rollNodeSchema = z.object({
  nodeIndex: z.string(),
});

/** 升级节点（CS: RoguelikeUpgradeNodeRequest { nodeType }） */
export const upgradeNodeSchema = z.object({
  nodeType: z.string(),
});

/** 暂存招募票（CS: RoguelikeStashTicketRequest { index }） */
export const stashRecruitTicketSchema = z.object({
  index: z.string(),
});

/** 使用暂存票（CS: RoguelikeStashedTicketUseRequest { id }） */
export const useStashedTicketSchema = z.object({
  id: z.string(),
});

/** 炼金（RL04StartAlchemyRequest { fragmentIndex[], leave }，抓包 { leave }） */
export const alchemySchema = z.object({
  leave: z.number().optional(),
  index: z.array(z.string()).optional(),
});

/** 炼金奖励（CS: RL04ClaimAlchemyRewardRequest { index }） */
export const alchemyRewardSchema = z.object({
  index: z.number().optional(),
});

/** 废品操作（rogue_6 SCRAP 模块，抓包派生） */
export const scrapSchema = z.object({
  action: z.string().optional(),
  scrapId: z.string().optional(),
});

/** 废品换乘（抓包 { scrapInstId, toWalk }） */
export const scrapChangeVehicleSchema = z.object({
  scrapId: z.string().optional(),
  scrapInstId: z.string().optional(),
  toWalk: z.number().optional(),
});

/** 丢弃废品（抓包 { instId }） */
export const scrapLoseSchema = z.object({
  instId: z.string(),
});

/** 废品鉴定（抓包 { count }；响应顶层 { scrap, legacy }） */
export const scrapIdentifySchema = z.object({
  count: z.number().optional(),
});

/** 网格区域移动（抓包 { route }）——原 router 校验 route 非空 */
export const gridZoneMoveToSchema = z.object({
  route: z.array(z.string()).min(1),
});

/** 网格区域移动并战斗（抓包 { route, stageId, squad }）——原 router 校验 route 非空 */
export const gridZoneMoveAndBattleStartSchema = z.object({
  route: z.array(z.string()).min(1),
  stageId: z.string(),
  squad: z.json(),
});

/** 网格区域空步（GRID_ZONE 模块，无字段） */
export const gridZoneEmptyStepSchema = z.object({});

/** 网格区域读取第 0 步（GRID_ZONE 模块，无字段） */
export const gridZoneReadStepZeroSchema = z.object({});

/** 游戏结算（抓包 body {}，无必填字段） */
export const gameSettleSchema = z.object({});

/** 商店购买（服务端自定义 { select?, action?, goodsId? }；controller 仅读 select） */
export const buyGoodsSchema = z.object({
  select: z.number().optional(),
  action: z.string().optional(),
  goodsId: z.string().optional(),
});

/* ===== 响应 schema（骨架级，供运行时校验） ===== */

/**
 * 肉鸽统一响应基础骨架（CS: PlayerDeltaResponse）
 *
 * 仅校验「结构骨架」而非叶级内容：
 * - `playerDataDelta.modified.rlv2.current` 必须是对象（客户端合并依赖该键）；
 * - `modified`/`deleted` 允许额外键（各端点 sections/outer/extra 不同，
 *   createGame/gameSettle 等超大响应不做深解析，避免性能损耗与误报）。
 *
 * 失败由 rlv2Response 经 logger.warn 记录（不阻断响应，仅暴露结构回归）。
 */
export const playerDeltaResponseSchema = z.object({
  playerDataDelta: z.object({
    modified: z
      .object({
        // rlv2 子树为可选对象：部分端点（如极少业务错误）可能不带，骨架校验不强制
        rlv2: z
          .object({
            current: z.record(z.string(), z.unknown()),
          })
          .partial()
          .optional(),
      })
      .passthrough(),
    deleted: z.record(z.string(), z.unknown()).optional(),
  }),
}).passthrough();