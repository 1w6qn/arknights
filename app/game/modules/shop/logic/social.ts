/**
 * 基建分区逻辑：社交商店（信用商店商品生成/折扣/购买/每日刷新）
 *
 * 由 ShopManager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { ShopManager } from "../logic";
import type { CreditShopMaterial, CreditShopRowEntry } from "../logic";
import excel from "@excel/excel";
import { ItemBundle } from "@excel/excel";
import { logger } from "@utils/logger";
import { recordPurchase } from "../../../kernel/util/purchase-record";
import { SocialGoodList, SocialShopData } from "@excel/excel";
import { random } from "@utils/random";

  /**
   * 每日刷新处理：重置低级商店每日限购记录
   */
export async function dailyRefresh(mgr: ShopManager) {
    await mgr._player.update(async (draft) => {
      // 修复（2026-09-09）：资质凭证区（LS）**不是**每日重置的商店——旧实现每天清
      // `LS.info`（购买记录），与官服「每月 1 日 04:00 重置」不符；月度重置保留在
      // monthlyRefresh（logic/fes.ts）。此处仅保留信用商店（SOCIAL）的每日刷新。
      // 信用商店按当天日期重置（curShopId 对齐 buildSocialGoodList 的 goodId 前缀）
      if (draft.shop.SOCIAL) {
        draft.shop.SOCIAL.curShopId = mgr.todaySocialShopId();
        draft.shop.SOCIAL.info = [];
      }
    });
}

  /** 当天信用商店 ID（SOCIAL<YYYYMMDD>，与 buildSocialGoodList 的 goodId 前缀一致） */
export function todaySocialShopId(mgr: ShopManager) : string {
    const t = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `SOCIAL${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
}

  /**
   * 自动生成当天信用商店商品（信用商店 = 社交商店，客户端 /shop/getSocialGoodList）
   *
   * 修复：socialGoodList 构造期置空从未加载 → 信用商店空列表。基座数据在构造期异步
   * 载入 data/shop/SocialGoodList.json，此处把 goodId 日期前缀重定为当天
   * （SOCIAL<YYYYMMDD>_T<N>_<type>_<M>_<slot>，与玩家 shop.SOCIAL.info 记录对齐）。
   *
   * @returns 当天信用商店商品列表
   */
  /**
   * 干员合同价格（信用交易所干员合同无折扣，按累计信用消费档位定价，PRTS 数据）
   * @param unlockNum - 解锁所需累计消费
   * @returns 合同价格
   */
export function _creditContractPrice(mgr: ShopManager, unlockNum: number) : number {
    const tiers: [number, number][] = [
      [0, 100],
      [200, 120],
      [500, 140],
      [1000, 160],
      [1500, 160],
      [2000, 180],
      [3000, 200],
      [4000, 200],
      [5000, 240],
      [6000, 240],
      [7000, 240],
      [8500, 240],
      [10000, 300],
    ];
    let price = 300;
    for (const [num, p] of tiers) {
      if (unlockNum >= num) price = p;
    }
    return price;
}

  /**
   * 生成当天信用商店商品（信用交易所）
   *
   * 官服规则（PRTS）：每日 10 个商品；干员合同解锁后占第 1 栏位（1 干员 + 9 随机商品），
   * 干员信物换满（6 个）后不再占位（10 个随机商品）。
   * 修复：
   * - 干员合同只生成 1 个"当前干员"（creditUnlockGroup 顺序上第一个未满 6 信物的干员；
   *   全部满潜 → 无干员合同 → 10 个常规商品）——原实现把全部已购干员都生成合同（3 个），
   *   客户端干员区渲染异常/点击无效
   * - 干员购买上限固定 6（availCount = 6 - 已购，不依赖配置档位数）
   * - 常规商品：有干员时按当天日期种子随机取 9 个，无干员时 10 个
   * - creditGroup：玩家已购干员所在组（有 creditGroup2 干员 → creditGroup2）
   * - costSocialPoint：累计信用消费（玩家存档动态字段优先，否则按已购信物档位推导）
   * - charPurchase：玩家实际购买记录（与静态基座合并，玩家优先）
   *
   * @returns 信用商店商品列表 + 干员解锁进度数据
   */
export function buildSocialGoodList(mgr: ShopManager) : SocialGoodList & {
    costSocialPoint: number;
    creditGroup: string;
  } {
    const base = mgr.socialGoodList;
    const prefix = mgr.todaySocialShopId();
    // 干员合同：玩家已购信物（静态基座合并 + 玩家实际，玩家优先）
    const playerSocial = mgr._player._playerdata.shop?.SOCIAL;
    const charPurchase: { [k: string]: number } = {
      ...(base?.charPurchase ?? {}),
      ...(playerSocial?.charPurchase ?? {}),
    };
    // 信用干员解锁配置（客户端 shop_client_table creditUnlockGroup）
    const unlockGroups = excel.ShopClientTable?.creditUnlockGroup ?? {};
    let creditGroup = "creditGroup1";
    let costSocialPoint = 0;
    // 按已购信物推导累计消费与所在组
    for (const [groupId, g] of Object.entries(unlockGroups)) {
      const entries = g?.charDict ?? [];
      for (const e of entries) {
        const bought = charPurchase[e.charId] ?? 0;
        if (!bought) continue;
        if (groupId === "creditGroup2") creditGroup = "creditGroup2";
        const my = entries.filter((x) => x.charId === e.charId);
        const tier = my[Math.min(bought, my.length) - 1];
        if (tier?.unlockNum) {
          costSocialPoint = Math.max(costSocialPoint, tier.unlockNum);
        }
      }
    }
    // 当前干员 = 组顺序上第一个未满 6 信的干员（上限固定 6；全满 → null）
    let currentChar: { charId: string; bought: number; unlockNum: number } | null = null;
    for (const [groupId, g] of Object.entries(unlockGroups)) {
      const entries = g?.charDict ?? [];
      const seen = new Set<string>();
      for (const e of entries) {
        if (seen.has(e.charId)) continue;
        seen.add(e.charId);
        const bought = charPurchase[e.charId] ?? 0;
        if (bought < 6) {
          const my = entries.filter((x) => x.charId === e.charId);
          const tier = my[Math.min(bought, my.length) - 1];
          currentChar = { charId: e.charId, bought, unlockNum: tier?.unlockNum ?? 0 };
          break;
        }
      }
      if (currentChar) break;
    }
    // 常规物资（每日从候选池按当天种子生成 count 个带折扣商品；跨日轮换、同日稳定）
    const goodList: SocialShopData[] = [];
    // 干员合同存在时占第 1 栏位 → 剩余 9 个随机物资；干员换完后 10 个随机物资
    const normal = mgr._buildSocialNormalGoods(currentChar ? 9 : 10, prefix);
    if (currentChar) {
      const price = mgr._creditContractPrice(currentChar.unlockNum);
      const contract: SocialShopData = {
        goodId: `${prefix}_T1_${currentChar.charId}`,
        displayName: mgr._charName(currentChar.charId),
        item: { id: currentChar.charId, count: 1, type: "CHAR" },
        price,
        availCount: Math.max(0, 6 - currentChar.bought),
        slotItem: {
          price,
          displayName: mgr._charName(currentChar.charId),
          item: { id: currentChar.charId, count: 1, type: "CHAR" },
        },
        discount: 0,
        originPrice: price,
      };
      goodList.push(contract); // 干员合同占第 1 栏位
      goodList.push(...normal);
    } else {
      goodList.push(...normal); // 干员已换完 → 10 个常规物资
    }
    // 玩家存档累计消费优先（buySocialGood 实时累计，动态字段）
    const savedCost = playerSocial?.costSocialPoint;
    if (typeof savedCost === "number" && savedCost > 0) {
      costSocialPoint = Math.max(costSocialPoint, savedCost);
    }
    return { goodList, charPurchase, costSocialPoint, creditGroup };
}

  /**
   * 基于种子串的确定性伪随机数生成器（线性同余，同日稳定 / 跨日轮换）
   *
   * 信用交易所物资抽选/折扣需要"同一天多次请求返回一致、次日自然变化"的随机源，
   * 不能直接用 random。以当天的日期前缀（SOCIAL<YYYYMMDD>）作种子。
   * @param seed - 随机种子串（当天日期前缀）
   * @returns 每次调用返回 [0,1) 的确定性随机函数
   */
export function _seededRng(mgr: ShopManager, seed: string) : () => number {
    let s = 0;
    for (let i = 0; i < seed.length; i++) {
      s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    }
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
}

  /**
   * 候选池条目 → 信用交易所物资（name/type 由 item_table 推导）
   *
   * 修复：候选池原硬编码 name/type（与 item_table 重复）——现按 id 查询
   * ItemTable 推导，缺失时告警并以 id 兜底名称（不跳过，避免候选池缩水）。
   * @param entry - rows JSON 条目
   * @returns 完整物资（含推导的 name/type）
   */
export function _materialFromEntry(mgr: ShopManager, entry: CreditShopRowEntry) : CreditShopMaterial {
    const item = excel.ItemTable?.items?.[entry.id];
    if (!item?.name) {
      logger.warn("shop", `信用交易所候选池条目 ${entry.id} 不在 item_table，按 id 兜底`);
    }
    return {
      id: entry.id,
      count: entry.count,
      type: item?.itemType ?? "MATERIAL",
      name: item?.name ?? entry.id,
      originPrice: entry.originPrice,
      ...(entry.allow95 ? { allow95: true } : {}),
      ...(entry.allow99 ? { allow99: true } : {}),
    };
}

  /**
   * 决定单个信用交易所物资的折扣力度（对应 PRTS 折扣规则）
   *
   * 主档为 -50%/-75%；低概率（约 10%）出现 -95%/-99% 特价，且仅限允许特价的物资
   *（-95% 仅龙门币×1800/基础作战记录，-99% 仅龙门币×3600/初级作战记录）。
   * @param rand - 确定性随机函数
   * @param m - 候选物资
   * @returns 折扣力度（0 表示无折扣；0.5/0.75 普通档，0.95/0.99 特价档）
   */
export function _creditDiscount(mgr: ShopManager, rand: () => number, m: CreditShopMaterial) : number {
    const r = rand();
    if (m.allow99 && r < 0.03) return 0.99;
    if (m.allow95 && r < 0.06) return 0.95;
    if (r < 0.45) return 0.5;
    return 0.75;
}

  /**
   * 生成当天信用交易所随机物资商品（对应 PRTS 信用交易所机制）
   *
   * 候选池为 7 行「并列随机抽取项」，每日生成 count 个：每次从随机一行内随机取一个物资
   *（同一天内可命中同一行不同物资）。其中前 3~7 个（不超过 count）为打折商品——折扣高的
   * 排列在前，同档次（-75% 及以上）之间顺序不定。同日用当天日期种子稳定，次日自然轮换。
   * @param count - 需生成的物资数量（有干员合同 9，否则 10）
   * @param prefix - 当天日期前缀（SOCIAL<YYYYMMDD>）
   * @returns 按折扣从高到低排列的物资商品
   */
export function _buildSocialNormalGoods(mgr: ShopManager, count: number,
    prefix: string,) : SocialShopData[] {
    const rand = mgr._seededRng(prefix);
    // 1) 抽 count 个物资：每行随机取一个代表（有放回，允许命中同一行不同物资）
    const picked: { m: CreditShopMaterial; discount: number }[] = [];
    for (let i = 0; i < count; i++) {
      const row = mgr._creditRows[Math.floor(rand() * mgr._creditRows.length)];
      picked.push({
        m: mgr._materialFromEntry(row[Math.floor(rand() * row.length)]),
        discount: 0,
      });
    }
    // 2) 决定打折商品数（3~7，不超过 count）并为其分配折扣
    const kDisc = Math.min(count, 3 + Math.floor(rand() * 5));
    const indices = Array.from({ length: count }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const discounted = new Set(indices.slice(0, kDisc));
    // 特价（-95%/-99%）多于 1 个时，仅保留 1 个，其余降为普通档（PRTS：多特价倾向减少打折数）
    let special = 0;
    for (const idx of discounted) {
      const d = mgr._creditDiscount(rand, picked[idx].m);
      picked[idx].discount = d >= 0.9 ? (special++ === 0 ? d : 0.75) : d;
    }
    // 3) 转成协议商品，折扣高优先排前（同折扣保持生成序）
    return picked
      .map((p, idx): [SocialShopData, number, number] => [
        {
          goodId: `${prefix}_T2_goods_${idx + 1}_${idx + 1}`,
          displayName: p.m.name,
          originPrice: p.m.originPrice,
          price: Math.round(p.m.originPrice * (1 - p.discount)),
          discount: p.discount,
          // 修复（2026-08-25）：availCount 原为 -1（不限购）→ 官服 getSocialGoodList
          // 抓包（R-1787479734940-0470 等 4 条）显示信用交易所每个常规商品每日限购
          // 1 次（availCount=1），客户端剩余数量 RemainCount = availCount - 已购，
          // -1 被渲染为"无限"。现按官服改为每日限购 1 次。
          availCount: 1, // 每日限购 1 次（与官服一致）
          item: { id: p.m.id, count: p.m.count, type: p.m.type },
        } as SocialShopData,
        p.discount,
        idx,
      ])
      .sort((a, b) => b[1] - a[1] || a[2] - b[2])
      .map(([g]) => g);
}

  /**
   * 购买信用商店商品（信用 = status.socialPoint）
   * @param args - 购买参数
   * @param args.goodId - 商品ID
   * @param args.count - 购买数量
   * @returns 获取的物品列表
   */
export async function buySocialGood(mgr: ShopManager, args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    const { goodId, count } = args;
    // 修复：负数 count → 信用币反向入账（免费刷信用）；正整数校验
    mgr._assertBuyCount(count);
    const good = mgr.buildSocialGoodList().goodList.find(
      (g) => g.goodId === goodId,
    );
    // 防御：未知商品不 500
    if (!good) return [];
    const price = (good.price ?? 0) * count;
    // 修复：余额不足拒绝（原直接 socialPoint -= price → 信用扣成负数仍发货）
    mgr._assertAffordable("socialPoint", price);
    // 修复：信用商店商品每日限购（availCount）
    mgr._assertAvail("SOCIAL", goodId, count, good.availCount);
    await mgr._player.update(async (draft) => {
      // 扣信用（socialPoint）
      draft.status.socialPoint = (draft.status.socialPoint ?? 0) - price;
      // 记录购买（对齐官服 shop.SOCIAL.info [{id, count}]）
      if (!draft.shop.SOCIAL) {
        draft.shop.SOCIAL = {
          curShopId: "",
          info: [],
          charPurchase: {},
        };
      }
      const social = draft.shop.SOCIAL;
      social.curShopId = mgr.todaySocialShopId();
      // 修复：累计信用消费（响应 costSocialPoint 数据源——干员解锁进度按累计消费判断）
      social.costSocialPoint = (social.costSocialPoint ?? 0) + price;      // 修复：干员合同购买 → 更新 charPurchase（信物计数，客户端干员进度）
      if (good.item.type === "CHAR") {
        social.charPurchase = social.charPurchase ?? {};
        social.charPurchase[good.item.id] =
          (social.charPurchase[good.item.id] ?? 0) + count;
      }
      const info = social.info ?? [];
      recordPurchase(info, goodId, count);
    });
    // 带 type 发放（干员合同 CHAR → char:get 入账并返回 instId；其余 TKT/材料走 items:get）
    const item: ItemBundle = {
      id: good.item.id,
      count: good.item.count * count,
      type: good.item.type,
    };
    const granted = await mgr._issueCharItem(item);
    // 修复（2026-09-09，审计 §6.2-17 后半）：信用交易所购买**从不 emit BuyShopItem**
    // —— LS/HS/ES（low-high.ts）与 CLASSIC（fes.ts）都有，唯独 SOCIAL 漏了。
    // 任务模板 BuyShopItem 的分支 1 正是「在信用商店中购买任意商品 1 次」
    // （args.type == "SOCIAL" → +1），当前数据表 27 条任务用该分支
    // （guide_33 + daily_4816/4916/…/5716，每个每日任务组各一条）→ 这些任务此前永不完成。
    // 分支 3 按 args.socialPoint 累计信用消费额，故一并携带本次实付价格。
    await mgr._trigger.emit("BuyShopItem", [
      { type: "SOCIAL", socialPoint: price },
    ]);
    return [granted];
}

  /**
   * 手动刷新信用交易所（服务器指令入口）
   *
   * 自动刷新已由 dailyRefresh（每天 04:00 refresh:daily 事件）承担；此方法供管理端
   * 指令手动触发——重置**低级商店（LS）与信用商店（SOCIAL）**购买记录并更新信用商店 shopId。
   * 注（2026-09-09）：LS 的自动重置已移出 dailyRefresh（官服为月度重置），
   * 但管理端手动刷新仍按原语义同时清空两者。
   */
export async function refreshSocialShop(mgr: ShopManager) : Promise<void> {
    await mgr.dailyRefresh();
    await mgr._player.update(async (draft) => {
      const ls = mgr._shopDraft(draft, "LS");
      ls.info = [];
    });
}
