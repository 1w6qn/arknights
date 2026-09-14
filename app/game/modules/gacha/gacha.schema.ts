/**
 * 抽卡/招募请求体 zod schema
 *
 * 参照反编译 CS（com.hypergryph.arknights_2.7.61.cs "Torappu" 命名空间下
 * CancelNormalGachaRequest / NormalGachaRequest / AdvancedGachaRequest 等 Request
 * 类）协议类字段定义，为 app/game/modules/gacha/handler.ts 全部端点建立请求格式约束：
 * 缺失必填字段 / 类型不符时由 validateBody 中间件返回 HTTP 4xx，避免非法 body 传入
 * 控制器抛 500。
 *
 * 约定：
 * - handler 只读其中少数字段的（itemList/chooseChar）按被读字段收紧结构。
 * - .optional() 表示服务端不读或抓包确认可不传的字段。
 * - useTkt 对应 CS 数值枚举 GachaType（number 值），故使用 z.number()。
 */
import { z } from "zod";

/** 同步普通招募状态请求（CS: SyncNormalGachaRequest，无字段） */
export const syncNormalGachaSchema = z.object({});

/** 完成普通招募请求（CS: FinishNormalGachaRequest { slotId }） */
export const finishNormalGachaSchema = z.object({
  slotId: z.number(),
});

/** 执行普通招募请求（CS: NormalGachaRequest { slotId, tagList, specialTagId, duration }） */
export const normalGachaSchema = z.object({
  slotId: z.number(),
  tagList: z.array(z.number()),
  specialTagId: z.number(),
  duration: z.number(),
});

/** 加速普通招募请求（CS: BoostNormalGachaRequest { slotId, buy }） */
export const boostNormalGachaSchema = z.object({
  slotId: z.number(),
  buy: z.number(),
});

/** 取消普通招募请求（CS: CancelNormalGachaRequest { slotId, tagList }） */
export const cancelNormalGachaSchema = z.object({
  slotId: z.number().optional(),
  // 客户端也可能按标签取消（handler 原样转发给 recruit.cancel，tagList 存在即可）
  tagList: z.array(z.number()).optional(),
});

/** 购买招募槽位请求（CS: BuyRecruitSlotRequest { slotId }） */
export const buyRecruitSlotSchema = z.object({
  slotId: z.number(),
});

/** 刷新招募标签请求（CS: RefreshTagsGachaRequest { slotId }） */
export const refreshTagsSchema = z.object({
  slotId: z.number(),
});

/** 获取卡池详情请求（CS: GetDetailGachaRequest { poolId, gachaObjGroupType? }） */
export const getPoolDetailSchema = z.object({
  poolId: z.string(),
  // gachaObjGroupType 可省略，服务端按 0 处理
  gachaObjGroupType: z.number().optional(),
});

/** 高级抽卡（单抽）请求（CS: AdvancedGachaRequest { poolId, useTkt, itemId }） */
export const advancedGachaSchema = z.object({
  poolId: z.string(),
  // useTkt 为数值枚举 GachaType（CS Int32 序列化），用 number 校验
  useTkt: z.number(),
  // itemId 可为空字符串或 null
  itemId: z.string().nullable(),
});

/** 高级抽卡（十连）请求（CS: TenAdvancedGachaRequest { poolId, useTkt, itemList }） */
export const tenAdvancedGachaSchema = z.object({
  poolId: z.string(),
  useTkt: z.number(),
  // itemList 为 CombineGachaItem[]（{ id, count }）——gacha/logic.ts 按 useTkt 将整段并入
  // 消耗列表（gainItem 管道读 id/count），故按被读字段收紧；passthrough 保留 type 等附加字段
  itemList: z.array(
    z.object({
      id: z.string(),
      count: z.number(),
    }).passthrough(),
  ),
});

/** 选择 UP 角色请求（CS: ChoosePoolUpRequest { poolId, chooseChar }） */
export const choosePoolUpSchema = z.object({
  poolId: z.string(),
  // chooseChar 由 handler 原样存入 gacha[type][poolId].upChar（不读内层字段）：
  // 协议为 { 稀有度: 干员ID[] } 字典，但 OBS/线上另有「直接给 charId 字符串」的形态
  // （router 测试固化；gacha-up-list.ts 亦显式守卫 !upChar||typeof!=="object" 才按字典合并）。
  // 故用 z.json() 透传，收紧成 record 会把该形态 422 掉。
  chooseChar: z.json(),
});

/** 获取免费干员请求（CS: GetFreeCharRequest { poolId }） */
export const getFreeCharSchema = z.object({
  poolId: z.string(),
});
/** 抽卡会话状态（客户端 POST /gacha 裸路径；服务端未读取请求体） */
export const gachaSessionStateSchema = z.object({});
