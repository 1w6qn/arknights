/**
 * 基建分区逻辑：常规商店（低级/高级/额外商品构建与购买）
 *
 * 由 ShopManager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { ShopManager } from "../logic";
import excel from "@excel/excel";
import { ItemBundle, ItemType } from "@excel/excel";
import { resolveEffectiveUpPerCharList } from "../../../kernel/util/gacha-up-list";
import { now } from "@utils/time";
import { logger } from "@utils/logger";
import { ClassicGoodList, HighGoodList, QCObject } from "@excel/excel";

  /**
   * 当前低级商店 ID（资质凭证区，按月刷新）
   *
   * 官服公式（参考 DoctoratePy shopGetLowGoodList）：ShopNumber = (年-2019)*12 + (月-5) + 1，
   * month 为 1-based。2026-08 → 88。修复：原公式 getMonth()(0-based)-5+(年-2019)*12 少 2，
   * 与官服/玩家存档（如 69=2025-01）不一致 → 客户端按 curShopId 计算刷新时间会偏差
   */
export function todayLowShopId(mgr: ShopManager) : string {
    const t = new Date();
    const monthNum =
      (t.getFullYear() - 2019) * 12 + (t.getMonth() + 1 - 5) + 1;
    return `lggShdShopnumber${monthNum}`;
}

  /**
   * 当前额外商店 ID（采购凭证区，按年刷新）
   *
   * 官服公式（参考 DoctoratePy shopGetExtraGoodList）：ShopId = xShdShopnumber<年-2021>。
   * 2026 → xShdShopnumber5；玩家旧数据 xShdShopnumber2（2023）→ 客户端刷新倒计时为负
   */
export function todayExtraShopId(mgr: ShopManager) : string {
    return `xShdShopnumber${new Date().getFullYear() - 2021}`;
}

  /**
   * 手动刷新额外商店（跨年更新 curShopId 并清空旧周期购买记录）
   */
export async function refreshExtraShop(mgr: ShopManager) : Promise<void> {
    await mgr._player.update(async (draft) => {
      const es = mgr._shopDraft(draft, "ES");
      es.curShopId = mgr.todayExtraShopId();
      es.info = [];
    });
}

  /**
   * 购买低级商店商品
   * @param args - 购买参数
   * @param args.goodId - 商品ID
   * @param args.count - 购买数量
   * @returns 获取的物品列表
   */
export async function buyLowGood(mgr: ShopManager, args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    const { goodId, count } = args;
    // 修复：负数 count → 价格/发放取反 → 免费刷货币；正整数校验
    mgr._assertBuyCount(count);
    const good = excel.ShopTable.lowGoodList.goodList.find(
      (g) => g.goodId === goodId,
    );
    // 防御：未知商品不 500（原 find! 断言 → undefined.item 崩溃）
    if (!good) return [];
    // 修复：余额不足拒绝（资质凭证 4005）
    mgr._assertAffordable("4005", good.price * count);
    // 修复：每日限购检查
    mgr._assertAvail("LS", goodId, count, good.availCount);
    const item = excel.makeItem(good.item.id, good.item.count * count);
    await mgr._player.update(async (draft) => {
      const ls = mgr._shopDraft(draft, "LS");
      const existingItem = ls.info.find((i) => i.id === goodId);
      if (existingItem) {
        existingItem.count += count;
      } else {
        ls.info.push({ id: goodId, count });
      }
    });
    await mgr._player.gainItem
      .add(excel.makeItem("4005", good.price * count))
      .use();
    await mgr._player.gainItem.add(item).handle();
    // 修复：BuyShopItem 任务事件从未 emit → 商店购买任务永不推进
    await mgr._trigger.emit("BuyShopItem", [{ type: "LS" as ItemType, socialPoint: 0 }]);
    return [item];
}

  /**
   * 购买高级商店商品
   * @param args - 购买参数
   * @param args.goodId - 商品ID
   * @param args.count - 购买数量
   * @returns 获取的物品列表
   */
export async function buyHighGood(mgr: ShopManager, args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    const { goodId, count } = args;
    // 修复：负数 count → 免费刷高级凭证；正整数校验
    mgr._assertBuyCount(count);
    const good =
      excel.ShopTable.highGoodList.goodList.find((g) => g.goodId === goodId) ??
      // 动态商品（根据当前标准池自动生成的干员区）
      mgr.buildHighCharGoods().find((g) => g.goodId === goodId) ??
      // 中坚甄选券（CLASSIC_FES_PICK_TIER_*/5，随中坚甄选池）
      mgr.buildFesPickGoods("HS").find((g) => g.goodId === goodId);
    // 防御：未知商品不 500
    if (!good) return [];
    let price = good.price;
    let item!: ItemBundle;
    if (!good?.progressGoodId) {
      // 修复：余额不足拒绝（高级凭证 4004）
      mgr._assertAffordable("4004", good.price * count);
      // 修复：限购检查
      mgr._assertAvail("HS", good.goodId, count, good.availCount);
    } else {
      // 进度商品：按档位定价，一次购买推进一档（count 按 1 档处理，费率一致）
      const progressGood =
        excel.ShopTable.highGoodList.progressGoodList[good.progressGoodId];
      const order =
        mgr._player._playerdata.shop?.HS?.progressInfo?.[
          good.progressGoodId
        ]?.order ?? 1;
      mgr._assertAffordable("4004", progressGood[order - 1]?.price ?? 0);
    }
    await mgr._player.update(async (draft) => {
      const hs = mgr._shopDraft(draft, "HS");
      if (!good?.progressGoodId) {
        item = { id: good.item.id, count: good.item.count * count, type: good.item.type as ItemType };
        const existingItem = hs.info.find((i) => i.id === good.goodId);
        if (existingItem) {
          existingItem.count += count;
        } else {
          hs.info.push(excel.makeItem(good.goodId, count));
        }
      } else {
        const progressGood =
          excel.ShopTable.highGoodList.progressGoodList[good.progressGoodId];
        let progressInfo = hs.progressInfo[good.progressGoodId];
        if (!progressInfo) {
          progressInfo = {
            order: 1,
            count: 0,
          };
        }
        price = progressGood[progressInfo.order - 1].price;
        item = progressGood[progressInfo.order - 1].item;
        // 修复：档位数取配置长度（原硬编码 5，进度档数变化时错乱）
        if (progressInfo.order < progressGood.length) {
          progressInfo.order += 1;
        } else {
          progressInfo.count += 1;
        }
        hs.progressInfo[good.progressGoodId] = progressInfo;
      }
    });
    await mgr._player.gainItem
      .add(excel.makeItem("4004", price * count))
      .use();
    // 修复：干员（CHAR）走 char:get 入账并返回带 instId（获得干员效果）；其余走 items:get
    const granted = await mgr._issueCharItem(item);
    // 修复：BuyShopItem 任务事件从未 emit → 商店购买任务永不推进
    await mgr._trigger.emit("BuyShopItem", [{ type: "HS" as ItemType, socialPoint: 0 }]);
    return [granted];
}

  /**
   * 购买额外商店商品
   * @param args - 购买参数
   * @param args.goodId - 商品ID
   * @param args.count - 购买数量
   * @returns 获取的物品列表
   */
export async function buyExtraGood(mgr: ShopManager, args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    const { goodId, count } = args;
    // 修复：负数 count → 免费刷黄票；正整数校验
    mgr._assertBuyCount(count);
    const good = excel.ShopTable.extraGoodList.goodList.find(
      (g) => g.goodId === goodId,
    );
    // 防御：未知商品不 500
    if (!good) return [];
    // 修复：余额不足拒绝（采购凭证 4006）
    mgr._assertAffordable("4006", good.price * count);
    // 修复：限购检查
    mgr._assertAvail("ES", goodId, count, good.availCount);
    const item = { id: good.item.id, count: good.item.count * count, type: good.item.type as ItemType };
    await mgr._player.update(async (draft) => {
      const es = mgr._shopDraft(draft, "ES");
      const existingItem = es.info.find((i) => i.id === goodId);
      if (existingItem) {
        existingItem.count += count;
      } else {
        es.info.push({ id: goodId, count });
      }
    });
    await mgr._player.gainItem
      .add(excel.makeItem("4006", good!.price * count))
      .use();
    // 修复：干员（CHAR）走 char:get 入账并返回带 instId 的效果，避免客户端显示"未知物品"
    const granted = await mgr._issueCharItem(item);
    // 修复：BuyShopItem 任务事件从未 emit → 商店购买任务永不推进
    await mgr._trigger.emit("BuyShopItem", [{ type: "ES" as ItemType, socialPoint: 0 }]);
    return [granted];
}

  /**
   * 当前标准寻访池（高级凭证区干员来源）
   *
   * 标准池 gachaRuleType === 0（JSON 数字 0）。优先当前活跃池（openTime<=now<=endTime），
   * 无活跃池时取最近结束的一期（数据版本落后时商店仍有内容）。
   * @returns 标准池配置，无则 null
   */
export function _currentStandardPool(mgr: ShopManager) : (typeof excel.GachaTable.gachaPoolClient)[number] | null {
    const ts = now();
    const pools = excel.GachaTable.gachaPoolClient
      .filter((p) => Number(p.gachaRuleType) === 0)
      .sort((a, b) => b.openTime - a.openTime);
    if (!pools.length) return null;
    return (
      pools.find((p) => p.openTime <= ts && ts <= p.endTime) ??
      pools[0]
    );
}

  /**
   * 当前中坚池（CLASSIC 通用凭证区干员来源）
   *
   * 中坚规则：CLASSIC / CLASSIC_DOUBLE / CLASSIC_ATTAIN / FESCLASSIC / FESCLASSIC 变体。
   * @returns 中坚池配置，无则 null
   */
export function _currentClassicPool(mgr: ShopManager) : (typeof excel.GachaTable.gachaPoolClient)[number] | null {
    const ts = now();
    const pools = excel.GachaTable.gachaPoolClient
      .filter((p) => /^(CLASSIC|FESCLASSIC)/.test(String(p.gachaRuleType)))
      .sort((a, b) => b.openTime - a.openTime);
    if (!pools.length) return null;
    return (
      pools.find((p) => p.openTime <= ts && ts <= p.endTime) ??
      pools[0]
    );
}

  /**
   * 当前中坚甄选池（FESCLASSIC 二次元自选卡池；甄选券商品关联的池）
   *
   * 不混入 CLASSIC 常规中坚池：甄选券只对应 FESCLASSIC（中坚甄选）池。优先当前活跃
   *（openTime<=now<=endTime），无活跃池时回退最近开启的一期（数据版本落后时仍有内容）。
   * @returns 中坚甄选池配置，无则 null
   */
export function _currentFesClassicPool(mgr: ShopManager) : (typeof excel.GachaTable.gachaPoolClient)[number] | null {
    const ts = now();
    const pools = excel.GachaTable.gachaPoolClient
      .filter((p) => String(p.gachaRuleType) === "FESCLASSIC")
      .sort((a, b) => b.openTime - a.openTime);
    if (!pools.length) return null;
    return pools.find((p) => p.openTime <= ts && ts <= p.endTime) ?? pools[0];
}

  /**
   * 归一化自动生成商品的可见时间窗口（goodStartTime/goodEndTime）
   *
   * 修复：数据版本处于卡池空窗期（已无活跃池）时，_currentStandardPool/_currentClassicPool
   * 会回退到最近一期已结束的池，其 endTime 已过期。若直接把 pool.endTime 作为商品
   * goodEndTime，客户端会按它判定商品过期而下架/禁用该商品。
   * 此处当池已结束时，把 goodEndTime 顺延为"持续开放"（脚本化未来 +90 天），保证商店在
   * 空窗期仍可正常购买；池活跃时原样返回。
   * @param pool - 关联卡池
   * @returns 商品可见时间窗口
   */
export function _autoGoodsTime(mgr: ShopManager, pool: {
    openTime: number;
    endTime: number;
  }) : { goodStartTime: number; goodEndTime: number } {
    const goodStartTime = pool.openTime;
    let goodEndTime = pool.endTime;
    // 池已结束（卡池空窗期）：商品持续开放，避免客户端按 goodEndTime 判过期
    if (pool.endTime < now()) {
      goodEndTime = now() + 90 * 86400;
    }
    return { goodStartTime, goodEndTime };
}

  /** 干员展示名（CHAR 表缺失时回退 charId） */
export function _charName(mgr: ShopManager, charId: string) : string {
    return excel.CharacterTable?.[charId]?.name ?? charId;
}

  /**
   * 发放单件商品并返回供客户端展示（"获得干员"效果）
   *
   * 干员（CHAR）走 char:get 管线入账（获得 charInstId/潜能/凭证），并返回携带 instId
   *（干员实例 id）的 CHAR 条目——客户端据此弹出"获得干员"弹窗；其余类型走 items:get。
   * 修复：原实现一律 items:get [[item]]，CHAR 商品有些丢失 type（干员不入账），且返回不含
   * instId → 客户端购买干员无获得效果。
   * @param item - 待发放的商品（ID/数量/类型）
   * @returns 返回客户端的条目（CHAR 附带 instId）
   */
export async function _issueCharItem(mgr: ShopManager, item: ItemBundle) : Promise<ItemBundle & { instId?: number }> {
    if (item.type === "CHAR" && item.id) {
      let charInstId = 0;
      await mgr._trigger.emit("char:get", [
        item.id,
        { from: "SHOP" },
        (res) => {
          charInstId = res?.charInstId ?? 0;
        },
      ]);
      return { ...item, instId: charInstId };
    }
    await mgr._player.gainItem.add(item).handle();
    return item;
}

  /**
   * 根据当前标准池自动生成高级凭证区（HS）干员商品
   *
   * 官服规则：高级凭证区干员随轮换卡池刷新——当期标准池 6★ 180 黄票 / 5★ 45 黄票
   *（萌娘百科：指定六星干员凭证 180、指定五星干员凭证 45）。
   * 标准池无结构化 upCharInfo，取 availCharInfo.perAvailList 中 6★(rarityRank 5)/5★(rarityRank 4)
   * 全部干员（当期标准池可获得的 6★/5★），goodId = `HS_${poolId}_${seq}` 稳定。
   * 与静态 HighGoodList.json 合并（静态保留材料区/progress 商品，按 goodId 去重、自动优先）。
   * @returns 自动生成的 HS 干员商品
   */
export function buildHighCharGoods(mgr: ShopManager) : QCObject[] {
    if (mgr._autoHighGoods) return mgr._autoHighGoods;
    const pool = mgr._currentStandardPool();
    const goods: QCObject[] = [];
    if (pool) {
      const { goodStartTime, goodEndTime } = mgr._autoGoodsTime(pool);
      const detail = excel.GachaDetailTable.details[pool.gachaPoolId];
      let seq = 0;
      for (const avail of detail?.availCharInfo?.perAvailList ?? []) {
        const price =
          avail.rarityRank === 5 ? 180 : avail.rarityRank === 4 ? 45 : 0;
        if (!price) continue;
        for (const charId of avail.charIdList) {
          goods.push({
            goodId: `HS_${pool.gachaPoolId}_${++seq}`,
            displayName: mgr._charName(charId),
            priority: 1,
            number: seq,
            goodType: "NORMAL",
            item: { id: charId, count: 1, type: "CHAR" as ItemType },
            progressGoodId: "",
            price,
            originPrice: price,
            discount: 0,
            availCount: 1,
            slotId: 0,
            groupId: "",
            goodStartTime,
            goodEndTime,
          } as QCObject);
        }
      }
    }
    mgr._autoHighGoods = goods;
    return goods;
}

  /**
   * 根据当前中坚池自动生成通用凭证区（CLASSIC）干员商品
   *
   * 官服规则：通用凭证区干员随中坚卡池刷新——中坚池 UP 6★ 2000 / 5★ 500（蓝票；
   * 2025-05 起 1800/450，此处沿用静态数据 2000/500 与 buyClassicGood 扣费一致）。
   * 中坚池有结构化 upCharInfo.perCharList，直接取 UP 干员。
   * @returns 自动生成的 CLASSIC 干员商品
   */
export function buildClassicCharGoods(mgr: ShopManager) : QCObject[] {
    if (mgr._autoClassicGoods) return mgr._autoClassicGoods;
    const pool = mgr._currentClassicPool();
    const goods: QCObject[] = [];
    if (pool) {
      const { goodStartTime, goodEndTime } = mgr._autoGoodsTime(pool);
      const detail = excel.GachaDetailTable.details[pool.gachaPoolId];
      let seq = 0;
      // 自选卡池（FESCLASSIC 中坚甄选）：干员区反映玩家 choosePoolUp 自选 UP，
      // 未自选/常规 CLASSIC 池时 resolveEffectiveUpPerCharList 原样返回静态 upCharInfo，
      // 行为不变（详见 GachaManager.effectiveUpPerCharList 的纯函数版）。
      const perCharList =
        resolveEffectiveUpPerCharList(
          excel.GachaDetailTable,
          excel.GachaTable.gachaPoolClient,
          mgr._player._playerdata.gacha,
          pool.gachaPoolId,
        ) ??
        detail?.upCharInfo?.perCharList ??
        [];
      for (const c of perCharList) {
        const price = c.rarityRank === 5 ? 2000 : c.rarityRank === 4 ? 500 : 0;
        if (!price) continue;
        for (const charId of c.charIdList) {
          goods.push({
            goodId: `KS_${pool.gachaPoolId}_${++seq}`,
            displayName: mgr._charName(charId),
            priority: 1,
            number: seq,
            goodType: "NORMAL",
            item: { id: charId, count: 1, type: "CHAR" as ItemType },
            progressGoodId: "",
            price,
            originPrice: price,
            discount: 0,
            availCount: 1,
            slotId: 0,
            groupId: "",
            goodStartTime,
            goodEndTime,
          } as QCObject);
        }
      }
    }
    mgr._autoClassicGoods = goods;
    return goods;
}

  /**
   * 解析中坚甄选券的物品 id
   *
   * 官服规则：券 id = `classic_fes_pick_tier_{稀有度}_{池序号}01`（如池 FESCLASSIC_76_0_2
   * → classic_fes_pick_tier_6_7601）。当前 excel 数据的 item_table 可能未收录当期池的券（版本
   * 落后），此时回退到已收录的同稀有度券 id（取后缀最大者），保证物品可被客户端正常解析；
   * 全无收录时仍按官服规则生成 id 并记 WARN 供补数据。
   * @param tier - 稀有度档（6=六星 / 5=五星）
   * @param poolId - 中坚甄选池 id（形如 FESCLASSIC_76_0_2）
   * @returns 可发放的券物品 id
   */
export function _pickTicketId(mgr: ShopManager, tier: number, poolId: string) : string {
    // 池序号：取池 id 中版本号首段（FESCLASSIC_76_0_2 → 76）
    const seqMatch = /^FESCLASSIC_(\d+)/.exec(poolId);
    const seq = seqMatch ? seqMatch[1] : "00";
    const byRule = `classic_fes_pick_tier_${tier}_${seq}01`;
    const items = excel.ItemTable?.items ?? {};
    if (items[byRule]) return byRule;
    // 回退：取已收录同稀有度券中后缀最大者（越接近当期数据越新）
    const existing = Object.keys(items).filter((k) =>
      k.startsWith(`classic_fes_pick_tier_${tier}_`),
    );
    if (existing.length) {
      return existing.sort((a, b) =>
        Number(b.split("_").pop() ?? 0) - Number(a.split("_").pop() ?? 0),
      )[0];
    }
    logger.warn("shop", `中坚甄选券 ${byRule} 未收录于 item_table，按规则生成`);
    return byRule;
}

  /**
   * 高级凭证区完整商品列表（动态干员 + 静态材料区合并）
   * @returns 合并后的 HighGoodList
   */
export function buildHighGoodList(mgr: ShopManager) : HighGoodList {
    const staticList = excel.ShopTable.highGoodList;
    const auto = mgr.buildHighCharGoods();
    const fesPick = mgr.buildFesPickGoods("HS");
    const autoIds = new Set([...auto, ...fesPick].map((g) => g.goodId));
    return {
      ...staticList,
      goodList: [
        ...auto,
        ...fesPick,
        ...staticList.goodList.filter((g) => !autoIds.has(g.goodId)),
      ],
    };
}

  /**
   * 通用凭证区完整商品列表（动态干员 + 静态 progress 商品合并）
   * @returns 合并后的 ClassicGoodList
   */
export function buildClassicGoodList(mgr: ShopManager) : ClassicGoodList {
    const staticList = excel.ShopTable.classicGoodList;
    const auto = mgr.buildClassicCharGoods();
    const fesPick = mgr.buildFesPickGoods("KS");
    const autoIds = new Set([...auto, ...fesPick].map((g) => g.goodId));
    return {
      ...staticList,
      goodList: [
        ...auto,
        ...fesPick,
        ...staticList.goodList.filter((g) => !autoIds.has(g.goodId)),
      ],
    };
}
