/**
 * 商店购买记录更新（单点实现）
 *
 * 「info 数组中已存在该商品则累加 count，否则 push 新记录」模式此前在
 * controller/shop（信用商店）、router/crisis（危机合约 V1 buyGoods / V2 buyGood）、
 * router/activity（exchangeActivityShopItem 活动商店兑换）四处复制——收敛为本函数。
 */

/** 购买记录条目（shop.SOCIAL.info / crisis.shop.info / tshop.*.info 的通用形状） */
export interface PurchaseRecord {
  id: string;
  count: number;
}

/**
 * 记录一次购买：已存在记录则累加数量，否则追加新条目（直接变异传入数组）。
 *
 * 注意：调用方是否同时扣除货币由各自业务决定（crisis 两处为简化实现不扣款，
 * 见 docs/重复实现审查-整合清单.md §一.6）。
 */
export function recordPurchase(
  info: PurchaseRecord[],
  goodId: string,
  count: number,
): void {
  const existing = info.find((i) => i.id === goodId);
  if (existing) {
    existing.count += count;
  } else {
    info.push({ id: goodId, count });
  }
}
