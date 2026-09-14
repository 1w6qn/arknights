/**
 * 商店（Shop）请求 zod schema
 *
 * 对应 protocol/shop.ts 的 Request 类型（参考 CS 2.7.61 协议类），
 * 供 router/shop.ts 经 validateBody 做运行时校验。
 */
import { z } from "zod";

/** 分解潜能物品请求（CS: DecomposePotentialItemRequest { charInstIdList }） */
export const decomposePotentialItemSchema = z.object({
  charInstIdList: z.array(z.string()),
});

/** 分解经典潜能物品请求（CS: DecomposeClassicPotentialItemRequest { charInstIdList }） */
export const decomposeClassicPotentialItemSchema = z.object({
  charInstIdList: z.array(z.string()),
});

/** 获取商品购买状态请求（CS: GetGoodPurchaseStateRequest { goodIdMap }） */
export const getGoodPurchaseStateSchema = z.object({
  goodIdMap: z.record(z.string(), z.array(z.string())).optional(),
});

/** 空请求体（商品列表类端点，服务端不读取 body） */
export const emptyRequestSchema = z.object({});

/** 购买低级商店商品请求（CS: BuyLowGoodRequest { goodId, count }） */
export const buyLowGoodSchema = z.object({
  goodId: z.string(),
  count: z.number(),
});

/** 购买高级商店商品请求（CS: BuyHighGoodRequest { goodId, count }） */
export const buyHighGoodSchema = z.object({
  goodId: z.string(),
  count: z.number(),
});

/** 购买额外商店商品请求（CS: BuyExtraGoodRequest { goodId, count }） */
export const buyExtraGoodSchema = z.object({
  goodId: z.string(),
  count: z.number(),
});

/** 购买现金商店商品请求（CS: BuyCashGoodRequest { goodId }） */
export const buyCashGoodSchema = z.object({
  goodId: z.string(),
});

/** 购买联合行动商店商品请求（CS: BuyEPGSGoodRequest { goodId, count }） */
export const buyEPGSGoodSchema = z.object({
  goodId: z.string(),
  count: z.number(),
});

/** 购买声望商店商品请求（CS: BuyREPGoodRequest { goodId, count }） */
export const buyREPGoodSchema = z.object({
  goodId: z.string(),
  count: z.number(),
});

/** 购买经典商店商品请求（CS: BuyClassicGoodRequest { goodId, count }） */
export const buyClassicGoodSchema = z.object({
  goodId: z.string(),
  count: z.number(),
});

/** 购买限定商店商品请求（CS: BuyLMTGSGoodRequest { goodId, count }） */
export const buyLMTGSGoodSchema = z.object({
  goodId: z.string(),
  count: z.number(),
});

/** 购买家具商店商品请求（CS: BuildingBuyFurnitureGoodRequest { goodId, buyCount, costType }） */
export const buyFurniGoodSchema = z.object({
  goodId: z.string(),
  buyCount: z.number(),
  costType: z.string(),
});

/** 购买家具组请求（客户端整组购买 { groupId, goods: [{id, count}] }） */
export const buyFurniGroupSchema = z.object({
  groupId: z.string().optional(),
  goods: z.array(z.object({ id: z.string(), count: z.number() })).optional(),
});

/** 购买皮肤商店商品请求（CS: BuySkinGoodRequest { goodId, isSpecial, enterTs }） */
export const buySkinGoodSchema = z.object({
  goodId: z.string(),
  isSpecial: z.number().optional(),
  enterTs: z.number().optional(),
});

/** 使用凭证购买礼包请求（CS: BuyGpGoodWithTicketRequest { goodId, ticketId }） */
export const buyGoodWithTicketSchema = z.object({
  goodId: z.string(),
  ticketId: z.string(),
});

/** 购买信用商店商品请求（CS: BuySocialGoodRequest { goodId, count }） */
export const buySocialGoodSchema = z.object({
  goodId: z.string(),
  count: z.number(),
});

/** 使用凭证兑换皮肤请求（服务端自定义 { goodId }） */
export const useVoucherSkinSchema = z.object({
  goodId: z.string(),
});

/** 用票券购买 GP 商品（服务端仅读 goodsId，可选） */
export const buyGPGoodWithTicketSchema = z.object({
  goodsId: z.string().optional(),
});