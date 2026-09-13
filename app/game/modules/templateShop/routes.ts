/**
 * 模板商店路由模块（奇象巡展/方舟枢纽商店）
 *
 * 处理模板商店相关的 HTTP 请求，包括商品列表查询和购买操作。
 * 商品配置来自 data/shop/templateShop.json（参考 ODPY 数据源，33 家商店含
 * sandbox_1/2、shop_act53side 等）；请求/响应类型见
 * @game/modules/templateShop/templateShop（参考 CS 2.7.61 协议类）。
 *
 * 2026-08-16 官服抓包对齐（tmp/capture/records/R-1786877194008-0087/0088）：
 * - getGoodList 响应含 allPriceDict（[{startTime, maxPrice}]，maxPrice=购全店总额）
 * - buyGood 更新 playerdata.tshop.{shopId}.{coin, info:[{id,count}], progressInfo}（官服形状，
 *   原实现写自创 (draft).templateShop 字段客户端不读）；CHAR_SKIN 商品走 items:get 入 skin
 * - 枢纽店（shop_act1arkhub）货币 = activity.ARK_HUB.act1arkhub.coin（与 tshop 币同步）；
 *   act53side 店货币 = activity.TYPE_ACT53SIDE.act53side.actCoin（与 tshop 币同步）
 */

import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { validateBody } from "@core/http/validate-body";
import {
  templateGetGoodListSchema,
  templateBuyGoodSchema,
} from "./templateShop.schema";
import { readJsonSync } from "@utils/file";
import { ItemBundle, ItemType } from "@excel/excel";
import type { Draft } from "mutative";
import type { PlayerDataModel, PlayerTemplateShop } from "../../kernel/playerdata";
import { asShape } from "../activities/shared/activity-json";
import { ARKHUB_SHOP_ID, arkhubCoinRef } from "../activities/arkhub/public";
import {
  TemplateBuyGoodRequest,
  TemplateBuyGoodResponse,
  TemplateGetGoodListRequest,
  TemplateGetGoodListResponse,
} from "./templateShop";

const router = Router();

/** 模板商店物品（data/shop/templateShop.json 的 item / progressGoods[].item） */
interface TemplateShopGoodItem {
  id: string;
  count: number;
  type: ItemType;
}

/** 模板商店商品（NORMAL 直接发 item；PROGRESS 的 item 为 null，按档位发放） */
interface TemplateShopGood {
  goodId: string;
  goodType: string;
  item: TemplateShopGoodItem | null;
  progressGoodId: string | null;
  price: number;
  availCount: number;
}

/** PROGRESS 商品档位（progressGoods[progressGoodId][i]） */
interface TemplateShopProgressTier {
  order: number;
  price: number;
  item: TemplateShopGoodItem | null;
}

/** 模板商店分组 */
interface TemplateShopGroup {
  shopGood: { [goodId: string]: TemplateShopGood };
  /**
   * 档位表（键为 progressGoodId）。
   * 注：现网 `shop_act42sre` 的 progressGoods 是单条目包装对象且键为 "0"（商品引用的
   * progressGoodId 为 "char_rmixer_progress"）→ 该商品恒取不到档位、购买恒被拒绝
   * （配置数据问题：键名不符，非本文件代码缺陷）。
   */
  progressGoods?: { [progressGoodId: string]: TemplateShopProgressTier[] };
}

/** 模板商店条目（data/shop/templateShop.json[shopId]） */
interface TemplateShopEntry {
  shopId: string;
  price: { id: string; count: number; type: string };
  startTime?: number;
  shopGroup: { [groupId: string]: TemplateShopGroup };
}

/** 模板商店配置（启动时读一次） */
const templateShopData = readJsonSync<{ [shopId: string]: TemplateShopEntry }>(
  "./data/shop/templateShop.json",
);

/**
 * 计算购全店一次的货币总额（NORMAL 商品按 price；PROGRESS 商品按全部档位价之和——
 * 每档一次购买，全部档位都买完才算购齐）
 * @param shop - 商店配置
 * @returns 所需货币总额
 */
function shopPurchasePower(shop: TemplateShopEntry): number {
  let total = 0;
  for (const group of Object.values(shop?.shopGroup ?? {})) {
    for (const good of Object.values(group?.shopGood ?? {})) {
      total += good?.price ?? 0;
      if (good?.goodType === "PROGRESS" && good?.progressGoodId) {
        for (const tier of group?.progressGoods?.[good.progressGoodId] ?? []) {
          total += tier?.price ?? 0;
        }
      }
    }
  }
  return total;
}

/**
 * 商店货币引用（活动币计数——枢纽店/主活动店与 activity 状态同步，其余走 tshop.coin）
 *
 * 官服形状：shop_act1arkhub 币 = activity.ARK_HUB.act1arkhub.coin；
 * shop_act53side 币 = activity.TYPE_ACT53SIDE.act53side.actCoin；
 * 均与 playerdata.tshop.{shopId}.coin 镜像同步。buyGood 扣币、getGoodList 补足
 * 都走这里，保证客户端显示的商店币与活动页币一致。
 * @returns 硬币读写引用（draft 内使用）；无法确定返回 null
 */
function shopCoinRefs(
  draft: Draft<PlayerDataModel>,
  shopId: string,
): { coin: number; set: (v: number) => void } | null {
  // 枢纽店币 = activity.ARK_HUB.act1arkhub.coin（形状知识收敛在 arkhub 模块）
  if (shopId === ARKHUB_SHOP_ID) return arkhubCoinRef(draft);
  if (shopId === "shop_act53side") {
    // TYPE_ACT53SIDE 未具名登记（走 PlayerActivity 兜底索引签名的 ServerPayload 两层），
    // 第三层 actCoin 需显式收窄为存档形状。
    const act = asShape<{ actCoin?: number }>(draft.activity?.TYPE_ACT53SIDE?.act53side);
    return act ? { coin: act.actCoin ?? 0, set: (v: number) => (act.actCoin = v) } : null;
  }
  return null;
}

/** 读取/创建 tshop 商店状态（playerdata.tshop.{shopId}.{coin, info, progressInfo}） */
function ensureShopState(draft: Draft<PlayerDataModel>, shopId: string): PlayerTemplateShop {
  draft.tshop = draft.tshop ?? {};
  const st = (draft.tshop[shopId] = draft.tshop[shopId] ?? {
    coin: 0,
    info: [],
    progressInfo: {},
  });
  if (typeof st.coin !== "number") st.coin = 0;
  if (!Array.isArray(st.info)) st.info = [];
  if (!st.progressInfo || typeof st.progressInfo !== "object") st.progressInfo = {};
  return st;
}

/**
 * 获取商品列表
 * @route POST /templateShop/getGoodList
 * @param req.body.shopId - 商店ID
 * @returns 商品数据（含 allPriceDict）、下次同步时间和玩家增量数据
 *
 * 修复：原实现返回空 data（商店打不开）；现按 ODPY 读取
 * templateShop.json[shopId] 返回完整商店配置；并自动补足商店货币
 *（私服便利——活动代币无获取途径）。2026-08-16 对齐官服响应补 allPriceDict。
 */
router.post("/getGoodList", validateBody(templateGetGoodListSchema), async (req, res) => {
  const player = getPlayer();
  const { shopId } = req.body as TemplateGetGoodListRequest;
  const data = templateShopData?.[shopId];
  // 私服便利：货币不足购全店时补足（保持玩家已有余额；只补差）——写活动币/tshop 币
  // 而非库存物品（客户端商店币显示取自 tshop.coin）。
  // 修复：先读实时余额，只有确实不足才 update（原每次请求都写库并触发 save）
  if (data?.price?.id) {
    const total = shopPurchasePower(data);
    const coinRef = shopCoinRefs(player._playerdata, shopId);
    const st = (player._playerdata.tshop ?? {})[shopId];
    const need =
      coinRef?.coin !== undefined
        ? Math.max(coinRef.coin ?? 0, st?.coin ?? 0) < total
        : (st?.coin ?? 0) < total;
    if (need) {
      await player.update(async (draft) => {
        const ref = shopCoinRefs(draft, shopId);
        const s = ensureShopState(draft, shopId);
        if (ref) {
          if (ref.coin < total) ref.set(total);
          if (s.coin < total) s.coin = total;
        } else if (s.coin < total) {
          s.coin = total;
        }
      });
    }
  }
  const allPriceDict = data?.startTime
    ? [{ startTime: data.startTime, maxPrice: shopPurchasePower(data) }]
    : [];
  res.send({
    data: { ...(data ?? {}), allPriceDict },
    nextSyncTime: -1,
    ...player.delta,
  } satisfies TemplateGetGoodListResponse);
});

/**
 * 购买商品
 * @route POST /templateShop/buyGood
 * @param req.body - CS: TemplateBuyGoodRequest { shopId, goodId, count }
 * @returns 购买结果 itemList 和玩家增量数据
 *
 * 修复：原实现回显请求体（客户端拿不到 itemList/增量）；现按商店配置校验并发放
 * 商品（扣货币 → 发物品 → 记录购买次数）。PROGRESS 商品按 progressGoods 档位
 * 取价格与发放物（good.item 为 null、price 为 0——旧实现会错误发放 MATERIAL 占位）。
 * 2026-08-16 对齐官服（buyGood 抓包）：购买记录写 playerdata.tshop.{shopId}.info
 *（{id, count}），扣币写活动币/tshop.coin，响应增量含 tshop 状态。
 */
router.post("/buyGood", validateBody(templateBuyGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as TemplateBuyGoodRequest;
  const { shopId, goodId, count = 1 } = body;
  // 修复：缺参/非法 count 校验（原负数 count → 货币反向入账刷币）
  if (
    !shopId ||
    !goodId ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count <= 0
  ) {
    res.send({ result: 1, itemList: [], ...player.delta } satisfies TemplateBuyGoodResponse);
    return;
  }
  const shop = templateShopData?.[shopId];

  // 在全部 shopGroup 中查找商品及其所在 group（PROGRESS 商品按 group.progressGoods 档位发放）
  let good: TemplateShopGood | undefined;
  let group: TemplateShopGroup | undefined;
  if (shop) {
    for (const g of Object.values(shop.shopGroup ?? {})) {
      if (g?.shopGood?.[goodId]) {
        good = g.shopGood[goodId];
        group = g;
        break;
      }
    }
  }

  const items: ItemBundle[] = [];
  if (good) {
    /** 本次扣币总额（recipe 内计算，块级承接——event ActivityCoinCost 用） */
    let costSpent = 0;
    /** PROGRESS 商品逐档发放的物品（非空时取代单一 grant 的 count 倍发放） */
    let boughtTierItems: TemplateShopGoodItem[] = [];
    // 修复：限购/余额不足拒绝——update 透传 recipe 返回值标记失败，响应 result:1
    const rejected = await player.update(async (draft): Promise<boolean> => {
      const st = ensureShopState(draft, shopId);
      const coinRef = shopCoinRefs(draft, shopId);
      // 购买记录（官方 tshop.info）
      const boughtRec = st.info.find((r) => r.id === goodId);
      const bought = boughtRec?.count ?? 0;
      // 限购检查（availCount：仅 >0 限购——0/-1/缺省视为无限可购。
      // 修复：原 `good.availCount && ...` 会把 availCount=-1 的无限池商品判为恒超限拒绝购买）
      if (good.availCount > 0 && bought + count > good.availCount) {
        return true;
      }
      // PROGRESS 商品：价格与发放物按档位（progressGoods[progressGoodId][bought]）
      let price = good.price ?? 0;
      let grantCount = count;
      const grant = good.item;
      if (good.goodType === "PROGRESS" && good.progressGoodId) {
        // 修复（2026-09-09）：原实现只取**单档**价再 ×count —— 一次买 N 件时把第 1 档价格
        // 复制了 N 份、却只推进 1 档（后续更贵档位被跳过），即「跨档按单档价 ×count」。
        // 现按官方语义逐档计价：第 i 件取 `tiers[bought + i]` 的价格与物品，任一档缺失即整单拒绝。
        const tiers = group?.progressGoods?.[good.progressGoodId] ?? [];
        let totalPrice = 0;
        const tierItems: TemplateShopGoodItem[] = [];
        for (let i = 0; i < count; i++) {
          const tier = tiers[bought + i];
          if (!tier) return true; // 超出可得档位 → 整单拒绝
          totalPrice += tier.price ?? 0;
          if (tier.item) tierItems.push(tier.item);
        }
        price = totalPrice;
        grantCount = 1; // 逐档物品已在 tierItems 中，不再按 count 倍数发放
        // 写入 progressInfo（客户端据此显示阶段性物品的当前档位）。order 存下一次将购的
        // 档位序号（1 起，对齐 HS/CLASSIC 进度商品形状）；全部档位购完后 count 累计超出次数。
        const prog = st.progressInfo[good.progressGoodId] ?? { order: 1, count: 0 };
        for (let i = 0; i < count; i++) {
          if (prog.order < tiers.length) prog.order += 1;
          else prog.count += 1;
        }
        st.progressInfo[good.progressGoodId] = prog;
        boughtTierItems = tierItems;
      }
      // 扣货币（活动币引用优先，其余走 tshop.coin；不足则不发放）
      const have = coinRef ? coinRef.coin : st.coin;
      if (have < price * grantCount) return true;
      const remain = have - price * grantCount;
      costSpent = price * grantCount;
      if (coinRef) coinRef.set(remain);
      st.coin = remain;
      // 记录购买
      if (boughtRec) {
        boughtRec.count = bought + count;
      } else {
        st.info.push({ id: goodId, count: bought + count });
      }
      // 发放商品（CHAR_SKIN 等经 items:get 正确入账）
      if (boughtTierItems.length > 0) {
        // PROGRESS：逐档物品各发一份
        for (const it of boughtTierItems) {
          items.push({
            id: it.id ?? goodId,
            type: it.type ?? "MATERIAL",
            count: it.count ?? 1,
          });
        }
      } else if (grant) {
        items.push({
          id: grant.id ?? goodId,
          type: grant.type ?? "MATERIAL",
          count: (grant.count ?? 1) * count,
        });
      }
      return false;
    });
    if (rejected) {
      res.send({ result: 1, itemList: [], ...player.delta } satisfies TemplateBuyGoodResponse);
      return;
    }
    // 活动代币消耗勋章（ActivityCoinCost）—— 扣币成功后累计花费（模板按 activity
    // id 匹配 shopId，如 shop_act53side 含 "act53side"）；私服商店自动补足货币，
    // 购买即真实消耗
    await player._trigger.emit("ActivityCoinCost", [
      { coinType: shopId, cost: costSpent },
    ]);
  } else {
    // 修复：未知商品/商店 → 业务错误而非静默空结果
    res.send({ result: 1, itemList: [], ...player.delta } satisfies TemplateBuyGoodResponse);
    return;
  }

  // 物品经 items:get 发放（干员走 char 入账，皮肤走 skin，其余走 inventory）
  if (items.length > 0) {
    for (const it of items) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send({
    itemList: items,
    ...player.delta,
  } satisfies TemplateBuyGoodResponse);
});

export default router;
