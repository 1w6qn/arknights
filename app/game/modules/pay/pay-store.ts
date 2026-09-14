/**
 * 支付订单存储与状态操作（pay 路由与 admin 命令共用）
 *
 * 订单持久化 data/pay/orders.json（重启不丢）；状态机 created → paid → delivered。
 * 支付模式 config.pay.mode：
 * - fake（缺省）：虚假支付，confirmOrderAlipay/Wechat 直接 markPaid，confirmOrder 立即发货
 * - real：真实支付，须 /pay/notify 渠道回调或 admin `pay order <id> confirm` markPaid 后发货
 */
import fs from "node:fs";
import { ItemBundle } from "@excel/excel";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { now } from "@utils/time";
import { readJsonSync } from "@utils/file";

/** 订单文件（持久化，重启不丢） */
export const PAY_ORDERS_FILE = "./data/pay/orders.json";

/** 订单状态机：created（已创建）→ paid（已支付）→ delivered（已发货） */
export interface PayOrderRecord {
  orderId: string;
  uid: string;
  storeId: number;
  goodId: string;
  /** 金额（分） */
  amount: number;
  productName: string;
  status: "created" | "paid" | "delivered";
  createdAt: number;
  paidAt?: number;
  deliveredAt?: number;
}

/** 加载订单表（文件缺失返回空） */
export function loadOrders(): PayOrderRecord[] {
  try {
    const data = readJsonSync<PayOrderRecord[]>(PAY_ORDERS_FILE);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** 保存订单表（确保目录存在） */
export function saveOrders(orders: PayOrderRecord[]): void {
  fs.mkdirSync("./data/pay", { recursive: true });
  fs.writeFileSync(PAY_ORDERS_FILE, JSON.stringify(orders, null, 2), "utf8");
}

/**
 * 标记订单为已支付（支付渠道确认：fake 的 alipay/wechat confirm、real 的 notify 回调、admin 手动）
 * @param orderId - 订单号
 * @returns 更新后的订单（不存在或已发货返回 null）
 */
export function markPaid(orderId: string): PayOrderRecord | null {
  const orders = loadOrders();
  const order = orders.find((o) => o.orderId === orderId);
  if (!order || order.status === "delivered") return null;
  if (order.status !== "paid") {
    order.status = "paid";
    order.paidAt = now();
    saveOrders(orders);
  }
  return order;
}

/**
 * 订单发货（发放商品：CS_ 现金包 → 钻石，GP_ 礼包 → 礼包物品）
 * @param player - 玩家数据管理器
 * @param order - 订单
 * @returns 发放的物品列表（GP_ 月卡等无发放配置返回空）
 */
export async function deliverOrder(
  player: PlayerDataManager,
  order: PayOrderRecord,
): Promise<ItemBundle[]> {
  if (order.goodId.startsWith("CS_")) {
    // 现金包：buyCashGood（含首充双倍 + shop.CASH.info 计数）
    return await player.modules.shop.buyCashGood({ goodId: order.goodId });
  }
  if (order.goodId.startsWith("GP_")) {
    // 现金礼包：buyGoodWithTicket 按 goodId 解析发放（gM/Once/NpOne/Lv/gW/Ms）；
    // 月卡 GP_mCard 等无 items 配置 → 返回空（调用方拒绝，不误标已购）
    return await player.modules.shop.buyGoodWithTicket({
      ticketId: "",
      goodId: order.goodId,
    });
  }
  return [];
}
