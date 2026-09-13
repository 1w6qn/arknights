/**
 * 仓库（凭证）协议类型
 *
 * 对应客户端 com.hypergryph.arknights_2.7.61.cs 中 Torappu 命名空间的
 * GetVoucherDetailRequest / UseMaterialVoucherRequest / BoostPotentialRequest 等
 * Request/Response 类；字段以 CS 类为准，服务端未返回的协议字段标为可选。
 */
import { ItemBundle } from "@excel/excel";
import type { ServerPayloadLeaf } from "@excel/json-value";
import { GachaResult } from "../../kernel/model";
import { PlayerDeltaResponse } from "../../kernel/http/common";

/** 获取凭证详情请求（CS: GetVoucherDetailRequest） */
export interface GetVoucherDetailRequest {
  instId: string;
  itemId: string;
}

/**
 * 凭证详情扁平字段
 * 服务端 VoucherDataManager.getVoucher 可能返回 null，展开后字段可缺失，故均可选
 */
export interface VoucherDetailData {
  /** CS: OptionalVoucherType 枚举，服务端返回字符串（如 MATERIAL_VOUCHER） */
  voucherType?: string;
  pickNum?: number;
  voucherBgDec?: string | null;
  /** 附加数据字典（服务端自定义；与 voucher.ts 的同名字段同形） */
  extraDataDic?: Record<string, ServerPayloadLeaf>;
  itemList?: ItemBundle[];
  validTimeInfo?: { startTs: number; endTs: number };
}

/**
 * 获取凭证详情响应（CS: GetVoucherDetailResponse）
 * CS 字段含 voucherDescDetail，服务端未返回
 */
export interface GetVoucherDetailResponse extends PlayerDeltaResponse, VoucherDetailData {
  voucherDescDetail?: string;
}

/** 凭证抽卡请求（CS: VoucherGachaDetailRequest；服务端未读取请求体） */
export interface VoucherGachaDetailRequest {
  instId: string;
  itemId: string;
  charId: string;
}

/**
 * 凭证抽卡响应（CS: VoucherGachaDetailResponse；服务端省略 items）
 * CS 的 items 为 List<ItemGet>
 */
export interface VoucherGachaDetailResponse extends PlayerDeltaResponse {
  items?: ItemGet[];
}

/** 道具获得项（CS: ItemGet 结构，charGet 在无干员时省略） */
export interface ItemGet {
  type: string;
  id: string;
  charGet?: GachaResult;
  count: number;
}

/** 获取干员抽卡凭证详情请求（CS: VoucherCharDetailRequest） */
export interface VoucherCharDetailRequest {
  itemId: string;
}

/**
 * 获取干员抽卡凭证详情响应（CS: VoucherCharDetailResponse）
 * CS 将数据嵌套在 info（CharGachaVoucherData）下，服务端扁平展开，以服务端为准
 */
export interface VoucherCharDetailResponse extends PlayerDeltaResponse, VoucherDetailData {}

/** 获取材料凭证详情请求（CS: VoucherItemDetailRequest） */
export interface VoucherItemDetailRequest {
  itemId: string;
}

/** 材料凭证池条目（CS: ItemVoucherPool；服务端未返回 weight） */
export interface ItemVoucherPool {
  itemId: string;
  /** CS: ItemType 枚举，服务端返回字符串（如 MATERIAL） */
  itemType: string;
  itemNum: number;
  weight?: number;
  groupId: string;
  sortId: number;
}

/** 材料凭证数据（CS: ItemVoucherData） */
export interface ItemVoucherData {
  voucherId: string;
  pickNum: number;
  picId: string;
  startTime: number;
  endTime: number;
  pool: ItemVoucherPool[];
}

/** 获取材料凭证详情响应（CS: VoucherItemDetailResponse） */
export interface VoucherItemDetailResponse extends PlayerDeltaResponse {
  info: ItemVoucherData;
}

/** 使用干员抽卡凭证请求（CS: useCharGachaVoucherRequest，注意 CS 类名小写开头） */
export interface UseCharGachaVoucherRequest {
  instId: string;
  itemId: string;
}

/**
 * 使用干员抽卡凭证响应（CS: useCharGachaVoucherResponse）
 * CS 的 charGet 为 List<GachaResult>，服务端未返回
 */
export interface UseCharGachaVoucherResponse extends PlayerDeltaResponse {
  charGet?: GachaResult[];
}

/** 使用材料凭证请求（CS: UseMaterialVoucherRequest） */
export interface UseMaterialVoucherRequest {
  instId: string;
  itemId: string;
  count: number;
}

/**
 * 使用材料凭证响应（CS: UseMaterialVoucherResponse）
 * CS 的 itemGet 为 List<ItemGet>，服务端契约使用 ItemBundle[]
 */
export interface UseMaterialVoucherResponse extends PlayerDeltaResponse {
  itemGet: ItemBundle[];
}

/**
 * 使用满潜能物品请求（CS: BoostPotentialRequest）
 * CS 的 targetRank 由服务端自行计算，请求体未读取
 */
export interface BoostPotentialRequest {
  charInstId: number;
  itemId: string;
  targetRank?: number;
}

/**
 * 使用满潜能物品响应（CS: BoostPotentialResponse）
 * CS 字段为 resultOneSuc，服务端返回 result
 */
export interface BoostPotentialResponse extends PlayerDeltaResponse {
  result: number;
}

/** 选项兑换条目（CS: OptionalChoiceItem） */
export interface OptionalChoiceItem {
  id: string;
  count: number;
}

/** 使用选项凭证请求（CS: UseOptionalVoucherRequest） */
export interface UseOptionalVoucherRequest {
  instId: string;
  itemId: string;
  choices: OptionalChoiceItem[];
  voucherCount: number;
}

/**
 * 使用选项凭证响应（CS: UseOptionalVoucherResponse）
 *
 * `itemGet` **原样回显**客户端提交的 `choices`（`OptionalChoiceItem { id, count }`），
 * 服务端不额外补 `type`（客户端按 item_table 推导）——此前声明为 `ItemBundle[]`
 * （`type` 必填）与实际报文不符，逼出 `choices as unknown as ItemBundle[]`。
 */
export interface UseOptionalVoucherResponse extends PlayerDeltaResponse {
  itemGet: OptionalChoiceItem[];
}
