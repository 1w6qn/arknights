/**
 * 支付路由（完整支付流程 + 可配置真实/虚假支付）
 *
 * 支付流程：createOrder（创建订单，持久化 data/pay/orders.json）→
 * createOrderAlipay/Wechat（生成支付宝/微信支付参数）→ confirmOrderAlipay/Wechat（支付确认）→
 * confirmOrder（发货：CS_ 现金包 → 钻石（含首充双倍），GP_ 礼包 → 礼包物品）。
 * 订单状态机：created → paid → delivered（防重复发货；持久化 JSON，重启不丢）。
 *
 * 支付模式 config.pay.mode：
 * - "fake"（缺省）：虚假支付——confirmOrderAlipay/Wechat 直接标记 paid（模拟渠道确认），
 *   confirmOrder 立即发货，全程免费（私服测试用）
 * - "real"：真实支付——confirmOrderAlipay/Wechat 仅走客户端流程占位，须支付渠道异步回调
 *   /pay/notify（或管理端 `pay order <id> confirm` 手动确认）标记 paid 后，confirmOrder 才发货。
 *   支付宝/微信支付参数可配（config.pay.alipay.appId / wechat.mchId 等）。
 *
 * 请求/响应类型见 @game/modules/pay/pay（参考 CS 2.7.61 协议类 + DoctoratePy pay.py）。
 */
import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { ItemBundle } from "@excel/excel";
import { now } from "@utils/time";
import { readJsonSync } from "@utils/file";
import { logger } from "@utils/logger";
import config from "@core/config/index";
import { validateBody } from "@core/http/validate-body";
import {
  confirmOrderAlipaySchema,
  confirmOrderSchema,
  confirmOrderWechatSchema,
  createOrderAlipaySchema,
  createOrderSchema,
  createOrderWechatSchema,
  getUnconfirmedOrderListSchema,
  notifySchema,
} from "./pay.schema";
import {
  loadOrders,
  saveOrders,
  markPaid,
  deliverOrder,
} from "./pay-store";
import {
  PayGetUnconfirmedOrderListRequest,
  PayGetUnconfirmedOrderListResponse,
  PayCreateOrderRequest,
  PayCreateOrderResponse,
  PayCreateOrderAlipayRequest,
  PayCreateOrderAlipayResponse,
  PayCreateOrderWechatRequest,
  PayCreateOrderWechatResponse,
  PayConfirmOrderRequest,
  PayConfirmOrderResponse,
  PayConfirmOrderAlipayRequest,
  PayConfirmOrderAlipayResponse,
  PayConfirmOrderWechatRequest,
  PayConfirmOrderWechatResponse,
  PayNotifyRequest,
  PayNotifyResponse,
  PaySuccessResponse,
} from "./pay";

const router = Router();

/** 生成订单号（参考 DoctoratePy：日期时间 + 18 位随机数） */
function genOrderId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-T:.Z]/g, "")
    .slice(0, 14);
  let rand = "";
  for (let i = 0; i < 18; i++) rand += Math.floor(Math.random() * 10);
  return ts + rand;
}

/** 生成 n 位随机十六进制串（对齐抓包 extension 的 appCode/sign 形状） */
function randomHex(len: number): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

/** 生成 n 位随机数字串（对齐抓包 extension 的 uid 形状） */
function randomDigits(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 10);
  return out;
}

/** 支付模式（config.pay.mode，缺省 fake） */
function payMode(): "fake" | "real" {
  return config.pay?.mode === "real" ? "real" : "fake";
}

/**
 * 商品信息（AllProductList 按 store_id）
 *
 * 修复（2026-09-09）：补 productId/status 字段——下单与发货都需要校验
 * 「storeId ↔ goodId」一致性（原实现只按 storeId 取价，goodId 原样入库，
 * 可用 6 元商品的 storeId 搭配 168 元礼包的 goodId 下单）。
 * @param storeId - 商品位 id
 * @returns 金额（分）/名称/商品 id/上架状态；未命中 found=false
 */
function productInfo(storeId: number): {
  amount: number;
  productName: string;
  productId: string;
  onSale: boolean;
  found: boolean;
} {
  try {
    const list = readJsonSync<{
      productList?: {
        store_id: number;
        price: number;
        name: string;
        product_id?: string;
        status?: number;
      }[];
    }>("./data/shop/AllProductList.json");
    const p = (list.productList ?? []).find(
      (x) => Number(x.store_id) === Number(storeId),
    );
    if (!p) {
      return {
        amount: 0,
        productName: "",
        productId: "",
        onSale: false,
        found: false,
      };
    }
    return {
      amount: p.price ?? 0,
      productName: p.name ?? "",
      productId: p.product_id ?? "",
      onSale: (p.status ?? 1) === 1,
      found: true,
    };
  } catch {
    return {
      amount: 0,
      productName: "",
      productId: "",
      onSale: false,
      found: false,
    };
  }
}

/**
 * 回调验签密钥（config.pay.notifySecret → 微信 apiKey → 支付宝 privateKey）
 */
function notifySecret(): string {
  return (
    (config.pay as { notifySecret?: string } | undefined)?.notifySecret ||
    config.pay?.wechat?.apiKey ||
    config.pay?.alipay?.privateKey ||
    ""
  );
}

/**
 * 校验渠道回调签名：hex(HMAC-SHA256(`${orderId}|${amount}`, secret))
 * @param sign - 渠道回传签名
 * @param orderId - 订单号
 * @param amount - 订单金额（分）
 * @returns 验签通过返回 true；未配置密钥或缺失签名返回 false
 */
function verifyNotifySign(
  sign: string,
  orderId: string,
  amount: number,
): boolean {
  const secret = notifySecret();
  if (!secret || !sign) return false;
  const expect = createHmac("sha256", secret)
    .update(`${orderId}|${amount}`)
    .digest("hex");
  const got = sign.trim().toLowerCase();
  if (got.length !== expect.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expect));
}

/**
 * 正在发货的订单号（进程内防并发双发货）
 *
 * 修复（2026-09-09）：原实现只检查持久化 status==="delivered"，同一订单的两个并发
 * confirmOrder 请求可同时通过检查 → 奖励发放两次。
 */
const deliveringOrders = new Set<string>();

/** 未确认订单列表（该 uid 未交付的订单 id） */
router.post("/getUnconfirmedOrderIdList", validateBody(getUnconfirmedOrderListSchema), async (req, res) => {
  const player = getPlayer();
  req.body as PayGetUnconfirmedOrderListRequest;
  const orders = loadOrders().filter(
    (o) => o.uid === player.uid && o.status !== "delivered",
  );
  res.send({
    orderIdList: orders.map((o) => o.orderId),
    ...player.delta,
  } satisfies PayGetUnconfirmedOrderListResponse);
});

/**
 * 创建订单（CS: PayCreateOrderRequest { storeId, goodId }）
 * 从 AllProductList.json 查商品生成订单（持久化，status=created），返回 extension JSON 字符串
 * （形状对齐抓包 tmp/pay_createOrder_res_1016.json）。
 */
router.post("/createOrder", validateBody(createOrderSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PayCreateOrderRequest;
  const info = productInfo(body.storeId);
  // 修复（2026-09-09）：下单必须命中在售商品，且 storeId 与 goodId 必须一致——
  // 原实现只按 storeId 取价、goodId 原样入库，可「用 6 元商品的 storeId + 168 元礼包的
  // goodId」下单，页面按 6 元收款、发货按 168 元礼包发放。
  if (!info.found || !info.onSale || !body.goodId) {
    logger.warn(
      "pay",
      `createOrder 拒绝：storeId=${body.storeId} 不在售（found=${info.found} onSale=${info.onSale}）`,
    );
    return res.send({
      result: 1,
      orderId: "",
      extension: "",
      alertMinor: 0,
      ...player.delta,
    } satisfies PayCreateOrderResponse);
  }
  if (info.productId && info.productId !== body.goodId) {
    logger.warn(
      "pay",
      `createOrder 拒绝：storeId=${body.storeId} 对应 ${info.productId}，请求 goodId=${body.goodId}`,
    );
    return res.send({
      result: 1,
      orderId: "",
      extension: "",
      alertMinor: 0,
      ...player.delta,
    } satisfies PayCreateOrderResponse);
  }
  const { amount, productName } = info;
  const orderId = genOrderId();
  const orders = loadOrders();
  orders.push({
    orderId,
    uid: player.uid,
    storeId: body.storeId,
    goodId: body.goodId,
    amount,
    productName,
    status: "created",
    createdAt: now(),
  });
  saveOrders(orders);
  const extension = JSON.stringify({
    appCode: randomHex(16),
    amount,
    productName,
    extension: { appStoreProductId: body.goodId },
    uid: randomDigits(13),
    outOrderId: orderId,
    ts: now(),
    platform: 1,
    sign: randomHex(32),
  });
  res.send({
    result: 0,
    orderId,
    extension,
    alertMinor: 0,
    ...player.delta,
  } satisfies PayCreateOrderResponse);
});

/**
 * 创建支付宝订单（DoctoratePy 兼容：H5/扫码支付）
 * fake 模式返回占位参数；real 模式按 config.pay.alipay 生成（未配置则占位）
 */
router.post("/createOrderAlipay", validateBody(createOrderAlipaySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PayCreateOrderAlipayRequest;
  const order = loadOrders().find((o) => o.orderId === body.orderId);
  if (!order) {
    return res.send({
      result: 1,
      orderId: body.orderId,
      qs: "",
      prcie: 0,
      pagePay: null,
      returnUrl: "",
      ...player.delta,
    } satisfies PayCreateOrderAlipayResponse);
  }
  const alipay = config.pay?.alipay;
  const qs = new URLSearchParams({
    app_id: alipay?.appId || randomDigits(16),
    biz_content: JSON.stringify({
      body: order.productName,
      subject: "DoctorateTs",
      out_trade_no: order.orderId,
      timeout_express: "90m",
      total_amount: ((order.amount || 1) / 100).toFixed(2),
      product_code: "FAST_INSTANT_TRADE_PAY",
    }),
    charset: "utf-8",
    format: "JSON",
    method: "alipay.trade.page.pay",
    notify_url: alipay?.notifyUrl || "",
    return_url: "",
    timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    sign: randomHex(32),
  }).toString();
  res.send({
    result: 0,
    orderId: order.orderId,
    qs,
    prcie: order.amount,
    pagePay: null,
    returnUrl: "",
    ...player.delta,
  } satisfies PayCreateOrderAlipayResponse);
});

/**
 * 创建微信订单（DoctoratePy 兼容：H5/扫码支付）
 * fake 模式返回占位参数；real 模式按 config.pay.wechat 生成（未配置则占位）
 */
router.post("/createOrderWechat", validateBody(createOrderWechatSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PayCreateOrderWechatRequest;
  const order = loadOrders().find((o) => o.orderId === body.orderId);
  if (!order) {
    return res.send({
      orderId: body.orderId,
      price: 0,
      requestObj: null,
      ...player.delta,
    } satisfies PayCreateOrderWechatResponse);
  }
  const wechat = config.pay?.wechat;
  res.send({
    orderId: order.orderId,
    price: order.amount,
    requestObj: {
      appid: wechat?.appId || `wx${randomHex(16)}`,
      partnerid: wechat?.mchId || randomDigits(10),
      prepayid: `wx${randomHex(32)}`,
      package: "Sign=WXPay",
      noncestr: `${now()}${randomDigits(7)}`,
      timestamp: now(),
      sign: randomHex(32),
    },
    ...player.delta,
  } satisfies PayCreateOrderWechatResponse);
});

/**
 * 支付宝支付确认（DoctoratePy 兼容）
 * fake 模式：直接标记订单 paid（模拟支付渠道确认，免费成功）
 * real 模式：仅返回占位 status（支付状态由 /pay/notify 渠道回调或管理端确认）
 */
router.post("/confirmOrderAlipay", validateBody(confirmOrderAlipaySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PayConfirmOrderAlipayRequest;
  if (payMode() === "fake" && body.orderId) {
    markPaid(body.orderId);
  }
  res.send({
    status: 0,
    ...player.delta,
  } satisfies PayConfirmOrderAlipayResponse);
});

/**
 * 微信支付确认（DoctoratePy 兼容，同 confirmOrderAlipay）
 */
router.post("/confirmOrderWechat", validateBody(confirmOrderWechatSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PayConfirmOrderWechatRequest;
  if (payMode() === "fake" && body.orderId) {
    markPaid(body.orderId);
  }
  res.send({
    status: 0,
    ...player.delta,
  } satisfies PayConfirmOrderWechatResponse);
});

/**
 * 确认订单（CS: PayConfirmOrderRequest { orderId, enterTs }）
 *
 * 状态机：delivered → 已发货拒绝（防重复发货）；fake 模式 created/paid 均可发货；
 * real 模式仅 paid（支付渠道已确认）才发货，created → result:1 未支付。
 */
router.post("/confirmOrder", validateBody(confirmOrderSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as PayConfirmOrderRequest;
  const orders = loadOrders();
  const order = orders.find((o) => o.orderId === body.orderId);
  if (!order || order.uid !== player.uid) {
    return res.send({
      result: 1,
      goodId: "",
      receiveItems: { items: [], checkInItems: [] },
      ...player.delta,
    } satisfies PayConfirmOrderResponse);
  }
  // 防重复发货
  if (order.status === "delivered") {
    return res.send({
      result: 1,
      goodId: order.goodId,
      receiveItems: { items: [], checkInItems: [] },
      ...player.delta,
    } satisfies PayConfirmOrderResponse);
  }
  // real 模式：未支付拒绝
  if (payMode() === "real" && order.status !== "paid") {
    return res.send({
      result: 1,
      goodId: order.goodId,
      receiveItems: { items: [], checkInItems: [] },
      ...player.delta,
    } satisfies PayConfirmOrderResponse);
  }
  // 修复（2026-09-09）：发货前复核商品表——goodId 必须仍是同 storeId 的在售商品
  //（挡住历史/伪造订单：amount=0 或 goodId 与商品位不匹配的订单不予发货）
  const current = productInfo(order.storeId);
  if (!current.found || !current.onSale || current.productId !== order.goodId) {
    logger.warn(
      "pay",
      `订单 ${order.orderId} 发货拒绝：商品校验失败（storeId=${order.storeId} goodId=${order.goodId}）`,
    );
    return res.send({
      result: 1,
      goodId: order.goodId,
      receiveItems: { items: [], checkInItems: [] },
      ...player.delta,
    } satisfies PayConfirmOrderResponse);
  }
  // 修复（2026-09-09）：进程内并发双发货防护（持久化状态在两次并发请求间不可见）
  if (deliveringOrders.has(order.orderId)) {
    logger.warn("pay", `订单 ${order.orderId} 正在发货中，拒绝重复请求`);
    return res.send({
      result: 1,
      goodId: order.goodId,
      receiveItems: { items: [], checkInItems: [] },
      ...player.delta,
    } satisfies PayConfirmOrderResponse);
  }
  deliveringOrders.add(order.orderId);
  let items: ItemBundle[];
  try {
    items = await deliverOrder(player, order);
  } catch (e) {
    // 修复：发货异常（礼包限购/未知商品等 ShopError）不直接 500——否则客户端弹"服务异常"，
    // 回滚到未发货（订单保留，可重试）；此前部分发放已写入但响应失败，需重启才"到账"。
    logger.warn("pay", `订单 ${order.orderId} 发货失败：${(e as Error)?.message}`);
    return res.send({
      result: 1,
      goodId: order.goodId,
      receiveItems: { items: [], checkInItems: [] },
      ...player.delta,
    } satisfies PayConfirmOrderResponse);
  } finally {
    deliveringOrders.delete(order.orderId);
  }
  // GP_ 月卡等无发放配置 → 拒绝（订单保留，不误标已购）
  if (order.goodId.startsWith("GP_") && items.length === 0) {
    return res.send({
      result: 1,
      goodId: order.goodId,
      receiveItems: { items: [], checkInItems: [] },
      ...player.delta,
    } satisfies PayConfirmOrderResponse);
  }
  order.status = "delivered";
  order.deliveredAt = now();
  saveOrders(orders);
  res.send({
    result: 0,
    goodId: order.goodId,
    receiveItems: { items, checkInItems: [] },
    ...player.delta,
  } satisfies PayConfirmOrderResponse);
});

/**
 * 支付渠道异步回调（real 模式核心——支付宝/微信 notify_url 指向此端点）
 * body 支持 out_trade_no 或 orderId；标记订单 paid。
 * 真实渠道接入时在此处验签（config.pay.alipay.privateKey / wechat.apiKey）。
 */
router.post("/notify", validateBody(notifySchema), async (req, res) => {
  const body = (req.body ?? {}) as PayNotifyRequest & {
    sign?: string;
    total_amount?: string | number;
  };
  const orderId = body.orderId || body.out_trade_no || "";
  const order = orderId
    ? (loadOrders().find((o) => o.orderId === orderId) ?? null)
    : null;
  if (!order) {
    logger.warn("pay", `notify 拒绝：订单不存在（${orderId}）`);
    return res.send({ result: 1, errMsg: "order not found" } satisfies PayNotifyResponse);
  }
  // 修复（2026-09-09）：金额校验——渠道回传 total_amount（元）必须与订单金额一致，
  // 原实现完全不看金额，可对任意订单回调「已支付」。
  if (body.total_amount != null) {
    const cents = Math.round(Number(body.total_amount) * 100);
    if (!Number.isFinite(cents) || cents !== order.amount) {
      logger.warn(
        "pay",
        `notify 拒绝：金额不符（order=${order.amount} notify=${body.total_amount}）`,
      );
      return res.send({ result: 1, errMsg: "amount mismatch" } satisfies PayNotifyResponse);
    }
  }
  // 修复（2026-09-09）：real 模式必须验签（config.pay.notifySecret / wechat.apiKey /
  // alipay.privateKey）；未配置密钥或签名不匹配一律拒绝。fake 模式（私服默认）保持可用。
  if (payMode() === "real" && !verifyNotifySign(String(body.sign ?? ""), orderId, order.amount)) {
    logger.warn("pay", `notify 拒绝：验签失败（${orderId}）`);
    return res.send({ result: 1, errMsg: "invalid sign" } satisfies PayNotifyResponse);
  }
  const ok = markPaid(orderId) !== null;
  // 支付宝 notify 期望纯文本 "success"；此处统一 JSON（私服内部使用）
  res.send({
    result: ok ? 0 : 1,
    ...(ok ? {} : { errMsg: "order not found" }),
  } satisfies PayNotifyResponse);
});

/** 支付成功页（DoctoratePy paySuccess 兼容；H5 支付跳转返回） */
router.get("/success", async (_req, res) => {
  res.send({
    status: 0,
    message: "DoctorateTs",
  } satisfies PaySuccessResponse);
});

export default router;
