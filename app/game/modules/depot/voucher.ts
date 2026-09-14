/**
 * 凭证领域服务（Depot Voucher Service）
 *
 * 从 routes.ts 下沉的业务逻辑：凭证表加载/查询 + 持有量校验。
 * 路由层只保留 validateBody + 取参 + 调用本服务 + res.send(player.delta)。
 *
 * 数据来源（两种，按优先级）：
 * 1. `data/depot/voucher.json`：干员兑换券（VOUCHER_PICK）的可选干员列表；
 * 2. item_table 的 voucherRelateList：反向查找材料凭证关联的物品列表。
 *
 * excel 访问口径：经 `player.excel` 数据端口注入（消费方驱动），不直连
 * `@excel/excel` 单例——与 excel-singleton-ratchet 守卫一致。
 *
 * 缓存说明：凭证表为**只读**启动期数据（加载后从不改写），因此模块级单实例的
 * 惰性缓存无跨请求/跨测试串味风险——它不承载任何可变业务状态（区别于旧的
 * `static _voucherTable` 静态可变字段：无访问控制、可被任意路径改写）。
 */
import { ItemBundle, ItemType } from "@excel/excel";
import { readJsonSync } from "@utils/file";
import type { ExcelData } from "../../kernel/excel-port";
import type { PlayerDataManager } from "../../kernel/player-data-manager";

/** 凭证信息（对应 voucher.json 中的数据结构） */
export interface VoucherInfo {
  /** 凭证类型（如 CHAR_VOUCHER、MATERIAL_VOUCHER） */
  voucherType: string;
  /** 可选择数量 */
  pickNum: number;
  /** 凭证背景描述 */
  voucherBgDec: string | null;
  /** 额外数据字典（官方原始 JSON 透传，响应中仅展开不做结构化访问） */
  extraDataDic: Record<string, string | number | boolean | null>;
  /** 可选物品列表 */
  itemList: ItemBundle[];
  /** 有效时间信息 */
  validTimeInfo: { startTs: number; endTs: number };
}

/** item_table.voucherRelateList 反查得到的关联物品 */
export interface RelatedVoucherItem {
  itemId: string;
  itemType: string;
  sortId: number;
}

export class VoucherService {
  /** 凭证表缓存（voucher.json；只读，首次访问后不再改写） */
  private _table: { readonly [key: string]: VoucherInfo } | null = null;

  /** 惰性加载凭证表 */
  private loadTable(): { readonly [key: string]: VoucherInfo } {
    if (this._table === null) {
      this._table = readJsonSync<{
        [key: string]: VoucherInfo;
      }>("./data/depot/voucher.json");
    }
    return this._table;
  }

  /**
   * 根据物品 ID 获取凭证信息
   *
   * 优先从 voucher.json 查找（干员兑换券），
   * 若未找到则尝试从 item_table 的 voucherRelateList 反向构建材料凭证信息。
   * @param itemId - 物品 ID
   * @param excelData - excel 数据端口（调用方经 `player.excel` 传入）
   * @returns 凭证信息，不存在则返回 null
   */
  getVoucher(itemId: string, excelData: ExcelData): VoucherInfo | null {
    const table = this.loadTable();
    if (itemId in table) {
      return table[itemId];
    }
    // 尝试从 item_table 的 voucherRelateList 反向查找关联物品
    const relatedItems = this.findRelatedItems(itemId, excelData);
    if (relatedItems.length > 0) {
      return {
        voucherType: "MATERIAL_VOUCHER",
        pickNum: 1,
        voucherBgDec: null,
        extraDataDic: {},
        itemList: relatedItems.map((item) => ({
          id: item.itemId,
          count: 1,
          type: item.itemType as ItemType,
        })),
        validTimeInfo: { startTs: -1, endTs: -1 },
      };
    }
    return null;
  }

  /**
   * 从 item_table 反向查找与指定凭证关联的物品列表
   *
   * 遍历 item_table 中所有物品的 voucherRelateList 字段，
   * 找到关联到指定凭证 ID 的物品，按 sortId 排序返回。
   * @param voucherId - 凭证 ID
   * @param excelData - excel 数据端口（调用方经 `player.excel` 传入）
   * @returns 关联物品列表（包含 itemId、itemType、sortId）
   */
  findRelatedItems(voucherId: string, excelData: ExcelData): RelatedVoucherItem[] {
    const result: RelatedVoucherItem[] = [];
    const items = excelData.ItemTable.items;
    for (const itemId in items) {
      const item = items[itemId];
      if (item.voucherRelateList) {
        for (const relate of item.voucherRelateList) {
          if (relate.voucherId === voucherId) {
            result.push({
              itemId: itemId,
              itemType: relate.voucherItemType,
              sortId: item.sortId,
            });
          }
        }
      }
    }
    return result.sort((a, b) => a.sortId - b.sortId);
  }
}

/** 模块级只读服务实例（路由层共享；见类注释的缓存安全性说明） */
export const voucherService = new VoucherService();

/**
 * 校验凭证持有量（consumable 实例）
 *
 * 修复（2026-09-09）：原实现不校验持有量——凭证实例不存在或数量不足时，
 * `items:use` 的消耗分支只 warn 跳过，随后仍照常发放奖励（可零成本刷任意凭证奖励）。
 * @param player - 玩家管理器
 * @param itemId - 凭证物品 id
 * @param instId - consumable 实例 id（客户端传入，数字或数字字符串）
 * @param count - 本次需要的数量
 * @returns 是否持有足量
 */
export function hasVoucherStock(
  player: PlayerDataManager,
  itemId: string,
  instId: number | string,
  count: number,
): boolean {
  const entry = player._playerdata.consumable?.[itemId]?.[Number(instId)];
  return !!entry && (entry.count ?? 0) >= count;
}
