/**
 * 集成战略（rlv2）分区逻辑：商店（诡意行商/杂货铺）商品生成、购买、刷新、离开
 *
 * 由 RoguelikeV2Manager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { RoguelikeV2Manager } from "./logic";
import excel from "@excel/excel";
import {
  ROGUE6_BATTLE_NODES,
  ROGUE6_SHOP_NODES,
  ROGUE6_NODE_SCENE_PREFIX,
  ROGUE6_END2_BOSS_STAGE,
  ROGUE6_END2_RELICS,
  ROGUE6_END3_RELIC,
  ROGUE6_BEAK_OUTBUFF,
  ROGUE6_NON_PORTABLE_SCRAPS,
  ROLL_NODE_TYPE_VALUES,
  isBlackstream,
} from "./theme-rules";
import { random } from "@utils/random";

/**
 * 商店商品条目（BATTLE_SHOP payload 的单件）
 *
 * `_retainDiscount` 为服务端折扣留存标记（客户端不识别；回收商品条目不带该键）。
 */
export interface ShopGoodsEntry {
  index: string;
  itemId: string;
  count: number;
  priceId: string;
  priceCount: number;
  origCost: number;
  displayPriceChg: boolean;
  _retainDiscount?: number;
}

/** 商店内容（BATTLE_SHOP 事件 payload；`_done` 为服务端私有标记，客户端不识别） */
export interface ShopContentPayload {
  bank: {
    open: boolean;
    canPut: boolean;
    canWithdraw: boolean;
    withdraw: number;
    cost: number;
    withdrawLimit: number;
  };
  id: string;
  goods: ShopGoodsEntry[];
  canBattle: boolean;
  hasBoss: boolean;
  refreshCnt: number;
  showRefresh: boolean;
  withdrawMethod: string;
  refreshMethod: string;
  _done: boolean;
  recycleGoods?: ShopGoodsEntry[];
  recycleCount?: number;
}

  /**
   * 生成商店商品（对照官方抓包 2026-08：票/碎片/战术道具/藏品混合，价格按类型+稀有度：
   * 招募票 4、临时票 8、碎片 4、战术道具 8、藏品 NORMAL 8 / RARE 12 / SUPER_RARE 16；
   * 约 25% 商品打折（displayPriceChg=true，价减半，官方抓包确认）。
   */
export function generateShopGoods(mgr: RoguelikeV2Manager, theme: string) : ShopGoodsEntry[] {
    const detail = excel.RoguelikeTopicTable.details[theme];
    const items = detail?.items || {};
    const priceId = `${theme}_gold`;

    const priceOf = (itemId: string): number => {
      const item = items[itemId];
      if (!item) return 4;
      if (item.type === "RECRUIT_TICKET") return itemId.includes("_temp_") ? 8 : 4;
      if (item.type === "UPGRADE_TICKET") return 6;
      if (item.type === "CUSTOM_TICKET") return 8;
      if (item.type === "FRAGMENT") return 4;
      if (item.type === "ACTIVE_TOOL") return 8;
      if (item.type === "RELIC") {
        if (item.rarity === "RARE") return 12;
        if (item.rarity === "SUPER_RARE") return 16;
        return 8;
      }
      return 8;
    };

    const shuffled = (arr: string[]) => [...arr].sort(() => random() - 0.5);

    // 藏品池过滤已拥有；按稀有度分层各抽 1 件再补齐到 4 件（避免全抽同档）
    const hasRelic = Object.values(mgr.inventory?.relic || {}).map((r) => r.id);
    const relicPool = Object.keys(items).filter(
      (id) =>
        items[id]?.type === "RELIC" &&
        !hasRelic.includes(id) &&
        // 二结局专属藏品（沙盘α/β）不走随机商店池——仅经线人事件/Ⅰ-Ⅲ 层行商专属渠道获得
        !["rogue_6_relic_final_1", "rogue_6_relic_final_2"].includes(id),
    );
    const tier = (id: string) =>
      items[id]?.rarity === "RARE" ? 1 : items[id]?.rarity === "SUPER_RARE" ? 2 : 0;
    const byTier: string[][] = [[], [], []];
    for (const id of relicPool) byTier[tier(id)].push(id);
    const relicPicks: string[] = [];
    for (const t of [0, 1, 2]) {
      const pool = shuffled(byTier[t]);
      if (pool.length > 0) relicPicks.push(pool[0]);
    }
    while (relicPicks.length < 4) {
      const rest = relicPool.filter((id) => !relicPicks.includes(id));
      if (rest.length === 0) break;
      relicPicks.push(shuffled(rest)[0]);
    }

    const ticketPool = Object.keys(detail?.recruitTickets || {}).filter(
      (id) =>
        !id.endsWith("_all") &&
        !id.includes("_5star") &&
        !id.includes("_quad_") &&
        !id.includes("_special"),
    );
    const fragmentPool = Object.keys(items).filter(
      (id) => items[id]?.type === "FRAGMENT",
    );
    const toolPool = Object.keys(items).filter(
      (id) => items[id]?.type === "ACTIVE_TOOL",
    );

    const goods: ShopGoodsEntry[] = [];
    let i = 0;
    const pushGood = (itemId: string) => {
      const orig = priceOf(itemId);
      const discount = random() < 0.25;
      const priceCount = discount ? Math.max(1, Math.round(orig * 0.5)) : orig;
      goods.push({
        index: `${i}`,
        itemId,
        count: 1,
        priceId,
        priceCount,
        origCost: orig,
        displayPriceChg: discount,
        _retainDiscount: discount ? priceCount / orig : 1,
      });
      i++;
    };

    const tPool = shuffled(ticketPool);
    if (tPool.length > 0) pushGood(tPool[0]);
    if (fragmentPool.length > 0) pushGood(shuffled(fragmentPool)[0]);
    if (toolPool.length > 0) pushGood(shuffled(toolPool)[0]);
    for (const id of relicPicks) pushGood(id);

    return goods;
}

  /**
   * 构建商店内容（battleShop，官方 pending BATTLE_SHOP 线格式）：
   * bank/id/goods/canBattle/hasBoss/refreshCnt/showRefresh/withdrawMethod/refreshMethod；
   * FRAGMENT 模块主题附 recycleGoods（碎片回收 1 金币/件，官方抓包确认）。
   */
export function buildShopContent(mgr: RoguelikeV2Manager, theme: string) : ShopContentPayload {
    const detail = excel.RoguelikeTopicTable.details[theme];
    const zone = mgr._status.cursor.zone;
    // 官服商店 id 用层号（cursor.zone 1000 起为网格区域索引——减 999 还原层号）
    const layer = zone > 999 ? zone - 999 : zone;
    const goods = mgr.generateShopGoods(theme);
    // 二结局·维度重构：沙盘β 大概率在 Ⅰ-Ⅲ 层诡意行商以 1 源石锭出售（未持有才出现）
    if (theme === "rogue_6" && layer >= 1 && layer <= 3) {
      const hasRelic = Object.values(mgr.inventory?.relic || {}).map((r) => r.id);
      if (!hasRelic.includes("rogue_6_relic_final_2")) {
        goods.push({
          index: String(goods.length),
          itemId: "rogue_6_relic_final_2",
          count: 1,
          priceId: `${theme}_gold`,
          priceCount: 1,
          origCost: 1,
          displayPriceChg: false,
          _retainDiscount: 1,
        });
      }
    }
    const content: ShopContentPayload = {
      bank: {
        open: true,
        canPut: true,
        canWithdraw: true,
        withdraw: 0,
        cost: 1,
        withdrawLimit: 20,
      },
      id: `zone_${layer}_shop`,
      goods,
      canBattle: true,
      hasBoss: true,
      refreshCnt: 2,
      showRefresh: true,
      withdrawMethod: "fee_add",
      refreshMethod: "direct",
      _done: false,
    };
    const fragments = Object.keys(detail?.items || {}).filter(
      (id) => detail.items[id]?.type === "FRAGMENT",
    );
    if (fragments.length > 0) {
      content.recycleGoods = fragments.slice(0, 6).map((id, idx) => ({
        index: `f_${idx + 1}`,
        itemId: id,
        count: 1,
        priceId: `${theme}_gold`,
        priceCount: 1,
        origCost: 1,
        displayPriceChg: false,
      }));
      content.recycleCount = content.recycleGoods.length;
    }
    return content;
}

export async function buyGoods(mgr: RoguelikeV2Manager, args: { select: number }) : Promise<void> {
    const { select } = args;
    // 兼容 BATTLE_SHOP（官方，content.battleShop）与旧格式 SHOP（content.shop）
    const shopEvent = mgr._status.pending.find(
      (e) => e.type === "BATTLE_SHOP" || e.type === "SHOP",
    );
    if (!shopEvent) return;
    const shop = shopEvent.content.battleShop ?? shopEvent.content.shop;
    if (!shop) return;

    const goods = shop.goods || [];
    const selectedGood = goods[select];
    if (!selectedGood || selectedGood.count <= 0) return;

    const priceCount = selectedGood.priceCount || 0;
    if (priceCount > 0 && mgr._status.property.gold < priceCount) {
      return;
    }

    if (priceCount > 0) {
      mgr._status.property.gold -= priceCount;
    }

    const itemId = selectedGood.itemId;
    if (itemId.includes("_recruit_ticket_")) {
      mgr._trigger.emit("rlv2:recruit:gain", [itemId, "shop", 0]);
      const tickets = Object.values(mgr.inventory!.recruit);
      const ticketIndex = tickets[tickets.length - 1]?.index;
      if (ticketIndex) {
        mgr._trigger.emit("rlv2:recruit:active", [ticketIndex]);
        // 参数键名与 events.ts RECRUIT 构造一致（tickets）——原传 {ticket} 导致 undefined
        mgr._trigger.emit("rlv2:event:create", ["RECRUIT", { tickets: ticketIndex }]);
      }
    } else if (itemId.includes("_relic_")) {
      mgr._trigger.emit("rlv2:relic:gain", [{ id: itemId, count: 1 }]);
    } else if (
      itemId.includes("_active_tool_") ||
      itemId.includes("_explore_tool_")
    ) {
      mgr._trigger.emit("rlv2:get:items", [[{ id: itemId, count: 1 }]]);
    } else {
      // 碎片/其他物品：通用发放（inventory.getItem 按类型分发）
      mgr._trigger.emit("rlv2:get:items", [[{ id: itemId, count: 1 }]]);
    }

    // 官方：售出商品保留在列表但 count 置 0（已售罄标记，非移除）
    selectedGood.count = 0;
}

  /** 商店刷新：重生成当前商店商品并扣除刷新次数 */
export async function refreshShop(mgr: RoguelikeV2Manager) : Promise<void> {
    const shopEvent = mgr._status.pending.find(
      (e) => e.type === "BATTLE_SHOP" || e.type === "SHOP",
    );
    if (!shopEvent) return;
    const shop = shopEvent.content.battleShop ?? shopEvent.content.shop;
    if (!shop || (shop.refreshCnt ?? 0) <= 0) return;
    shop.goods = mgr.generateShopGoods(mgr.current.game!.theme);
    shop.refreshCnt -= 1;
}

  /** 离开商店：填充 traderReturn（商人返回礼物，confirmTraderReturn 发放）并清空 pending */
export async function leaveShop(mgr: RoguelikeV2Manager) : Promise<void> {
    // 商人返回：离开商店时填充（部分主题/商店类型有商人礼物）
    if (!mgr._status.traderReturn) {
      const theme = mgr.current.game!.theme;
      const hasRelic = Object.values(mgr.inventory!.relic || {}).map((r) => r.id);
      const rewardId = mgr._pool.getRelic("pool_relic_all", hasRelic);
      if (rewardId) {
        mgr._status.traderReturn = {
          t0: { id: rewardId, count: 1, instId: "" },
        };
      }
    }
    mgr._status._pending._pending.length = 0;
    await mgr.checkZoneEnd();
    mgr._status.state = "WAIT_MOVE";
}

  /** 商店战斗开始（CS: RoguelikeShopBattleRequest）：生成 BATTLE 事件（state 0 + addExcludeList） */
export async function shopBattleStart(mgr: RoguelikeV2Manager) : Promise<void> {
    const theme = mgr.current.game!.theme;
    const exclude: string[] = [];
    const tickets = excel.RoguelikeTopicTable.details[theme]?.recruitTickets || {};
    for (const [id] of Object.entries(tickets)) {
      if (id.includes("_special") || id.includes("_sniper")) {
        exclude.push(id);
      }
    }
    const relics = mgr.inventory!.relic || {};
    for (const relic of Object.values(relics)) {
      if ((relic.id || "").includes("grace")) exclude.push(relic.id);
    }
    mgr._trigger.emit("rlv2:event:create", [
      "BATTLE",
      { state: 0, addExcludeList: exclude },
    ]);
    mgr._status.state = "PENDING";
}

  /** 当前节点是否为行商节点（诡意行商 / 秘境行商 / 应急助力，官方 subName=商店） */
export function isInShopNode(mgr: RoguelikeV2Manager) : boolean {
    const pos = mgr._status.cursor.position;
    if (!pos) return false;
    const node = mgr._map.zones[mgr.zoneKey(mgr._status.cursor.zone)]?.nodes[
      pos.x * 100 + pos.y
    ];
    return typeof node?.type === "number" && ROGUE6_SHOP_NODES.includes(node.type);
}
