/**
 * 基建分区逻辑：杂项（皮肤/现金/家具/券消耗/禁用检查与共通校验）
 *
 * 由 ShopManager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { ShopManager } from "../logic";
import excel from "@excel/excel";
import { ItemBundle, ItemType } from "@excel/excel";
import { ShopError } from "../errors";
import { ChooseGPItem, GPGoodList, LevelGPItem, MonthlySubItem, NormalGPItem, PeriodicityGroup, PeriodicityGPItem } from "@excel/excel";
import { BadRequestError } from "@core/http/errors";
import type { Draft } from "mutative";
import type {
  PlayerDataModel,
  PlayerGiftProgressData,
  PlayerGoodItemData,
  PlayerGoodProgressData,
  PlayerShop,
} from "../../../kernel/playerdata";

/** 商店类型键（PlayerShop 键集合，含服务端扩展的 LMTGS/GP） */
export type ShopKey = keyof PlayerShop;

/** 兜底初始化支持的键（GP 为嵌套礼包结构，不适用并集视图） */
export type ShopDraftKey = Exclude<ShopKey, "GP">;

/**
 * 商店子表兜底字段视图
 *
 * PlayerShop 各商店形状不一（如 SKIN 无 progressInfo、FURNI 无 charPurchase），
 * 而 {@link _shopDraft} 按并集逐字段补全；本视图描述该写入口径。
 * `info` 在非 GP 的商店类型上本就存在，故交叉 `PlayerShop[K]` 后仍是必填数组。
 */
export interface ShopProgressLike {
  curShopId?: string;
  info?: PlayerGoodItemData[];
  progressInfo?: { [key: string]: PlayerGoodProgressData };
  charPurchase?: { [key: string]: number };
  groupInfo?: { [key: string]: number };
}

  /**
   * 校验购买数量为正整数
   *
   * 修复：原各 buy* 方法对 count 无任何校验——负数 count 使价格/发放数量取反，
   * items:use 经 _useItem 取反后反向入账（免费刷信用/凭证/钻石等货币）
   * @param count - 购买数量
   */
export function _assertBuyCount(mgr: ShopManager, count: number) : void {
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      throw new BadRequestError(`非法购买数量: ${count}`);
    }
}

  /**
   * 读取物品当前持有量（货币/凭证统一入口，余额校验用）
   *
   * 4001 龙门币 / 4002 源石 / 4003 合成玉 / 4004 高级凭证 / 4005 资质凭证 /
   * socialPoint 信用 在 status；其余（4006/3401/EPGS_COIN/REP_COIN/LMTGS_COIN_*）在 inventory。
   * @param itemId - 物品 ID（socialPoint 表示信用）
   * @returns 当前持有量（未持有为 0）
   */
export function _held(mgr: ShopManager, itemId: string) : number {
    const st = mgr._player._playerdata.status;
    switch (itemId) {
      case "4001":
        return st.gold ?? 0;
      case "4002":
        return st.androidDiamond ?? 0;
      case "4003":
        return st.diamondShard ?? 0;
      case "4004":
        return st.hggShard ?? 0;
      case "4005":
        return st.lggShard ?? 0;
      case "socialPoint":
        return st.socialPoint ?? 0;
      default:
        return mgr._player._playerdata.inventory?.[itemId] ?? 0;
    }
}

  /**
   * 余额校验：不足抛 ShopError（路由层转 result:1，不扣费不发放）
   *
   * 修复：原各 buy* 方法直接 emit items:use 扣费——余额不足时 gainItem 把余额扣成
   * 负数但商品照常发放，等于免费刷货币；此处先校验、不足即拒绝且无副作用。
   * @param itemId - 货币物品 ID
   * @param count - 本次需扣总量
   */
export function _assertAffordable(mgr: ShopManager, itemId: string, count: number) : void {
    if (count <= 0) return;
    const have = mgr._held(itemId);
    if (have < count) {
      throw new ShopError(`货币不足: 需要 ${itemId}×${count}，持有 ${have}`);
    }
}

  /**
   * 读取 shop.<key>.info 中某商品已购数量
   * @param shopKey - 商店类型键（LS/HS/ES/...）
   * @param goodId - 商品 ID
   * @returns 已购数量
   */
export function _boughtCount(mgr: ShopManager, shopKey: ShopDraftKey, goodId: string) : number {
    const shop = mgr._player._playerdata.shop?.[shopKey];
    const rec = (shop?.info ?? []).find((i) => i.id === goodId);
    return rec?.count ?? 0;
}

  /**
   * 限购校验：已购 + 本次 > availCount 时抛 ShopError
   *
   * 修复：原各 buy* 方法从不检查 availCount——每日/总量限购商品可无限购买。
   * 官服 availCount 用 -1 表示无限（本实现 <=0 视为不限）。
   * @param shopKey - 商店类型键
   * @param goodId - 商品 ID
   * @param count - 本次购买数量
   * @param availCount - 限购数量（<=0 不限）
   */
export function _assertAvail(mgr: ShopManager, shopKey: ShopDraftKey,
    goodId: string,
    count: number,
    availCount?: number,) : void {
    if (!availCount || availCount <= 0) return;
    const bought = mgr._boughtCount(shopKey, goodId);
    if (bought + count > availCount) {
      throw new ShopError(`商品 ${goodId} 已达限购（${availCount}）`);
    }
}

  /** 读取/初始化 shop.<key> 基础结构（官服迁移数据缺字段时不 500） */
  /**
   * 商店状态兜底（draft 内创建/补全商店对象）
   *
   * 修复：原实现 `draft.shop[key] ?? 默认值` 只对"商店不存在"生效——玩家数据里商店
   * 已存在但字段缺失（如官服迁移的 SKIN 无 info）时返回原对象，info 为 undefined →
   * `.info.find` 500。此处对已存在对象也逐字段补全（info/progressInfo 等保证类型）。
   */
export function _shopDraft<K extends ShopDraftKey>(
  mgr: ShopManager,
  draft: Draft<PlayerDataModel>,
  key: K,
) : PlayerShop[K] & ShopProgressLike {
    const view = draft as { shop?: PlayerShop };
    view.shop ??= {} as PlayerShop;
    const st = (view.shop[key] ??= {} as PlayerShop[K]) as PlayerShop[K] & ShopProgressLike;
    st.curShopId = st.curShopId ?? "";
    st.info = Array.isArray(st.info) ? st.info : [];
    st.progressInfo = st.progressInfo ?? {};
    st.charPurchase = st.charPurchase ?? {};
    st.groupInfo = st.groupInfo ?? {};
    return st;
}

  /**
   * 皮肤是否存在（皮肤表存在性防御）
   *
   * 修复：SkinGoodList.json 数据错位（如 char_254_vodfox_witch#2 漏写品牌分隔符 @）
   * 会下发皮肤表不存在的 skinId → 客户端预览图加载失败。购买/列表均按
   * excel.SkinTable.charSkins 校验，无效皮肤拒绝/过滤。
   * @param skinId - 皮肤 ID
   * @returns 皮肤表存在返回 true
   */
export function _skinExists(mgr: ShopManager, skinId: string) : boolean {
    return Boolean(excel.SkinTable?.charSkins?.[skinId]);
}

  /**
   * 购买皮肤商店商品
   * @param args - 购买参数
   * @param args.goodId - 商品ID
   */
export async function buySkinGood(mgr: ShopManager, args: { goodId: string }) : Promise<void> {
    const { goodId } = args;
    const good = excel.ShopTable.skinGoodList.goodList.find(
      (g) => g.goodId === goodId,
    );
    // 防御：未知商品不 500（原 find! 断言 → undefined.skinId 崩溃）
    if (!good) return;
    // 修复：皮肤表不存在（数据错位）拒绝——避免写入无效 characterSkins 条目导致预览图错误
    if (!mgr._skinExists(good.skinId)) {
      throw new ShopError(`皮肤 ${good.skinId} 不存在（数据错位）`);
    }
    // 修复：已拥有拒绝——皮肤经 CHAR_SKIN 入 characterSkins，重复购买应被服务端拒绝
    if (mgr._player._playerdata.skin?.characterSkins?.[good.skinId]) {
      throw new ShopError(`皮肤 ${good.skinId} 已拥有`);
    }
    // 修复：余额不足拒绝（至纯源石 4002）
    mgr._assertAffordable("4002", good.price);
    const item = { id: good.skinId, count: 1, type: "CHAR_SKIN" as ItemType };
    // 修复：记录购买（原不写 SKIN.info → 客户端购买状态永远可买）
    await mgr._player.update(async (draft) => {
      const skin = mgr._shopDraft(draft, "SKIN");
      const existing = skin.info.find((i) => i.id === good.goodId);
      if (existing) {
        existing.count += 1;
      } else {
        skin.info.push(excel.makeItem(good.goodId, 1));
      }
    });
    await mgr._player.gainItem
      .add({ id: "4002", type: "DIAMOND" as ItemType, count: good.price })
      .use();
    await mgr._player.gainItem.add(item).handle();
}

  /**
   * 购买现金商店商品
   *
   * 现金商店以钻石(androidDiamond/iosDiamond)作为货币，购买后记录购买次数。
   * 参考实现中现金商店为外部支付通道，此处简化为直接发放钻石并记录购买次数。
   * @param args - 购买参数
   * @param args.goodId - 商品ID
   * @returns 获取的物品列表
   */
export async function buyCashGood(mgr: ShopManager, args: { goodId: string }) : Promise<ItemBundle[]> {
    const { goodId } = args;
    // 修复：兼容 AllProductList 基础 id（CS_1）与 CashGoodList 版本化 id（CS_1_r1/r2/r3）——
    // 客户端 createOrder 传 product_id（可为基础或版本化），按前缀匹配避免发货落空
    const good =
      excel.ShopTable.cashGoodList.goodList.find((g) => g.goodId === goodId) ??
      excel.ShopTable.cashGoodList.goodList.find((g) =>
        g.goodId.startsWith(goodId + "_"),
      );
    // 防御：未知商品不 500
    if (!good) return [];
    // 现金商店物品为钻石充值，发放钻石，并依据 doubleCount 判断是否为首充翻倍
    const isDouble = await mgr._player.update(async (draft) => {
      const cash = mgr._shopDraft(draft, "CASH");
      const existingItem = cash.info.find((i) => i.id === goodId);
      if (existingItem) {
        existingItem.count += 1;
        return 0;
      } else {
        cash.info.push(excel.makeItem(goodId, 1));
        return good.doubleCount > 0 ? 1 : 0;
      }
    });
    const diamondCount = isDouble
      ? good.diamondNum * 2 + good.plusNum
      : good.diamondNum + good.plusNum;
    const item: ItemBundle = {
      id: "4002",
      type: "DIAMOND" as ItemType,
      count: diamondCount,
    };
    await mgr._player.gainItem.add(item).handle();
    return [item];
}

  /**
   * 购买家具商店商品
   * @param args - 购买参数
   * @param args.goodId - 商品ID
   * @param args.buyCount - 购买数量
   * @param args.costType - 消耗类型（COIN_FURN或DIAMOND）
   * @returns 获取的物品列表
   */
export async function buyFurniGood(mgr: ShopManager, args: {
    goodId: string;
    buyCount: number;
    costType: string;
  }) : Promise<ItemBundle[]> {
    const { goodId, buyCount, costType } = args;
    const good = excel.ShopTable.furniGoodList.goods.find(
      (g) => g.goodId === goodId,
    );
    // 防御：未知商品不 500（数据版本错位）
    if (!good) return [];
    // 修复：负数 buyCount → 价格取反经 items:use 反向入账（免费刷家具/钻石）；正整数校验
    mgr._assertBuyCount(buyCount);
    // 修复：费用币种解析不再依赖 costType 严格等于 "COIN_FURN"。
    // 当前 FurniGoodList 数据 priceDia 全为 0（无源石价），非 "COIN_FURN" 的 costType
    // （如客户端传数值枚举）会被旧实现误判为源石分支 → 扣 priceDia(=0) → 家具免费、
    // 与客户端显示的家具币消耗不符。改为：有源石价且非家具币时才走源石，否则一律家具币。
    const isCoin = costType === "COIN_FURN" || !(good.priceDia > 0);
    const pay = isCoin ? good.priceCoin : good.priceDia;
    mgr._assertAffordable(isCoin ? "3401" : "4002", pay * buyCount);
    // 修复：限购检查（FurniGood.count 总可购数）
    mgr._assertAvail("FURNI", goodId, buyCount, good.count);
    if (isCoin) {
      await mgr._player.gainItem
        .add(excel.makeItem("3401", good.priceCoin * buyCount))
        .use();
    } else {
      // 修复：DIAMOND 分支 id 补全（原 id 为空串，仅靠 type 分支扣减）
      await mgr._player.gainItem
        .add({ id: "4002", type: "DIAMOND" as ItemType, count: good.priceDia * buyCount })
        .use();
    }
    await mgr._player.update(async (draft) => {
      const furni = mgr._shopDraft(draft, "FURNI");
      const existingItem = furni.info.find((i) => i.id === goodId);
      if (existingItem) {
        existingItem.count += buyCount;
      } else {
        furni.info.push(excel.makeItem(goodId, buyCount));
      }
    });
    const item = { id: good.furniId, type: "FURN" as ItemType, count: buyCount };
    await mgr._player.gainItem.add(item).handle();
    return [item];
}

  /**
   * 购买家具组（客户端 body: { groupId, goods: [{id, count}] }——整组购买）
   *
   * 修复：原 buyFurniGroup 路由把组请求体透传给 buyFurniGood（单商品逻辑）→
   * goodId 解构不到 → 500。此处逐个结算组内家具：扣家具币 priceCoin、发放 FURN、
   * 记录 shop.FURNI.info；未知商品（数据版本错位）跳过不 500。
   * @param args - 购买参数
   * @returns 发放的家具物品列表
   */
export async function buyFurniGroup(mgr: ShopManager, args: {
    groupId?: string;
    goods?: { id: string; count: number }[];
  }) : Promise<ItemBundle[]> {
    const items: ItemBundle[] = [];
    for (const g of args.goods ?? []) {
      const good = excel.ShopTable.furniGoodList.goods.find(
        (x) => x.goodId === g.id,
      );
      if (!good) continue; // 未知家具（数据版本错位）跳过
      const count = g.count ?? 1;
      // 修复：负数 count → 价格取反 → 免费刷家具币；正整数校验
      mgr._assertBuyCount(count);
      // 修复：余额不足的家具跳过（不扣不发，不影响组内其余结算）
      if (mgr._held("3401") < (good.priceCoin ?? 0) * count) continue;
      // 修复：限购检查
      mgr._assertAvail("FURNI", g.id, count, good.count);
      await mgr._player.gainItem
        .add(excel.makeItem("3401", (good.priceCoin ?? 0) * count))
        .use();
      await mgr._player.update(async (draft) => {
        const furni = mgr._shopDraft(draft, "FURNI");
        const existing = furni.info.find((i) => i.id === g.id);
        if (existing) {
          existing.count += count;
        } else {
          furni.info.push({ id: g.id, count });
        }
      });
      items.push({ id: good.furniId, type: "FURN" as ItemType, count });
    }
    for (const it of items) mgr._player.gainItem.add(it);
    await mgr._player.gainItem.handle();
    return items;
}

  /**
   * 使用凭证购买礼包商店商品
   *
   * 对应参考实现中的 buyShopGoodWithTicket，根据 goodId 解析礼包分类，
   * 找到对应礼包配置后发放其中的所有物品。
   * goodId 格式约定为 `GP_<goodType>_<序列>`，例如 `GP_Once_xxx`、`GP_NpOne_xxx`、`GP_gM_xxx`。
   * - goodType=gM：月度礼包，位于 GPGoodList.monthlyGroup.packages
   * - goodType=Once：一次性礼包，位于 GPGoodList.oneTimeGP
   * - goodType=NpOne：选择礼包，位于 GPGoodList.chooseGroup
   * 凭证(ticket)的扣减由调用方在路由层之上处理，本方法只负责发放物品。
   * @param args - 购买参数
   * @param args.ticketId - 凭证ID
   * @param args.goodId - 商品ID
   * @returns 获取的物品列表
   */
export async function buyGoodWithTicket(mgr: ShopManager, args: {
    ticketId: string;
    goodId: string;
  }) : Promise<ItemBundle[]> {
    const { goodId } = args;
    const parts = goodId.split("_");
    // 解析 goodId 中的 goodType 部分，格式为 `GP_<goodType>_<序列>`
    const goodType = parts[1];
    const gpList: GPGoodList = excel.ShopTable.GPGoodList;
    let configItems: ItemBundle[] = [];
    let availCount = 0;

    if (goodType === "gM") {
      // 月度礼包：monthlyGroup.packages 是字典，直接按 goodId 取
      const group: PeriodicityGroup = gpList.monthlyGroup;
      const pkg: PeriodicityGPItem | undefined = group?.packages?.[goodId];
      if (pkg) {
        configItems = pkg.items;
        availCount = pkg.availCount;
      }
    } else if (goodType === "Once") {
      // 一次性礼包：oneTimeGP 是数组，需遍历查找
      // 修复：数据字段可能为 null → 防御不 500
      const found = (gpList.oneTimeGP ?? []).find((g) => g.goodId === goodId);
      if (found) {
        configItems = (found as NormalGPItem).items;
        availCount = found.availCount;
      }
    } else if (goodType === "NpOne") {
      // 选择礼包：chooseGroup 是数组，需遍历查找
      const found = (gpList.chooseGroup ?? []).find((g) => g.goodId === goodId);
      if (found) {
        configItems = (found as ChooseGPItem).items;
        availCount = found.availCount;
      }
    } else if (goodType === "Lv") {
      // 等级礼包：levelGP 是数组
      const found = (gpList.levelGP ?? []).find((g) => g.goodId === goodId);
      if (found) {
        configItems = (found as LevelGPItem).items;
        availCount = found.availCount;
      }
    } else if (goodType === "gW") {
      // 周度礼包：weeklyGroup.packages 是字典
      // 修复：数据 goodId = GP_gW_*（原匹配 "Wk" 永不命中 → 周礼包不发放）
      const group: PeriodicityGroup = gpList.weeklyGroup;
      const pkg: PeriodicityGPItem | undefined = group?.packages?.[goodId];
      if (pkg) {
        configItems = pkg.items;
        availCount = pkg.availCount;
      }
    } else if (goodType === "Ms") {
      // 月卡礼包：monthlySub 是数组
      const found = (gpList.monthlySub ?? []).find((g) => g.goodId === goodId);
      if (found) {
        configItems = (found as MonthlySubItem).items;
        availCount = found.availCount;
      }
    }

    // 发放礼包内的所有物品
    if (configItems.length > 0) {
      // 礼包分档键（服务端 GP.monthlySub 为扩展分档，见 playerdata-server-adapt）
      const sub =
        goodType === "Once"
          ? "oneTime"
          : goodType === "Lv"
            ? "level"
            : goodType === "gW"
              ? "weekly"
              : goodType === "gM"
                ? "monthly"
                : goodType === "NpOne"
                  ? "choose"
                  : "monthlySub";
      // 修复：限购检查（一次性/月卡等礼包 shop.GP.<type>.info 记录）
      if (availCount > 0) {
        const gpInfo = mgr._player._playerdata.shop?.GP?.[sub]?.info ?? [];
        const bought = gpInfo.find((i) => i.id === goodId)?.count ?? 0;
        if (bought + 1 > availCount) {
          throw new ShopError(`礼包 ${goodId} 已达限购（${availCount}）`);
        }
        await mgr._player.update(async (draft) => {
          draft.shop.GP ??= {} as PlayerGiftProgressData;
          draft.shop.GP[sub] ??= { info: [], valid: [], curGroupId: "" };
          const rec = draft.shop.GP[sub].info.find((i) => i.id === goodId);
          if (rec) {
            rec.count += 1;
          } else {
            draft.shop.GP[sub].info.push(excel.makeItem(goodId, 1));
          }
        });
      }
      // 修复：逐件发放——干员（CHAR）走 char:get 入账并带 instId（客户端"获得干员"效果），
      // 其余走 items:get。原实现一次性 items:get [configItems]，CHAR 无 instId → pay/其他
      // 发放干员的礼包客户端无获得效果（甚至解析异常）。
      const granted: ItemBundle[] = [];
      for (const ci of configItems) {
        granted.push(await mgr._issueCharItem(ci));
      }
      return granted;
    }
    return configItems;
}

  /**
   * 获取现金商品购买结果
   *
   * 参考实现中此接口为占位（返回 202），用于外部支付通道回调后的查询。
   * 此处简化实现：返回玩家当前 shop.CASH 的购买记录作为结果。
   * @returns 购买记录信息
   */
export async function getCashGoodPurchaseResult(mgr: ShopManager) : Promise<{
    info: { id: string; count: number }[];
  }> {
    return {
      // 修复：兜底 CASH 缺失（官服迁移数据 shop 可能为空对象 → 原直接访问 .info 500）
      info: mgr._player._playerdata.shop.CASH?.info ?? [],
    };
}

  /**
   * 获取凭证皮肤商品列表
   *
   * 凭证皮肤指通过特殊凭证兑换的皮肤，列表来源于 SkinTable 中的相关配置。
   * 参考实现中此接口为占位（返回 202）。此处基于皮肤商店列表筛选可用项返回。
   * @returns 凭证皮肤商品列表
   */
export function getVoucherSkinGoodList(mgr: ShopManager) : { goodList: unknown[] } {
    // 简化实现：返回皮肤商店中标记为可兑换(isRedeem)的皮肤
    // 修复：过滤皮肤表不存在的条目（数据错位 → 客户端预览图加载失败）
    const voucherGoods = excel.ShopTable.skinGoodList.goodList.filter(
      (g) => g.isRedeem && mgr._skinExists(g.skinId),
    );
    return { goodList: voucherGoods };
}

  /**
   * 使用凭证兑换皮肤
   *
   * 参考实现中此接口为占位（返回 202）。此处实现：扣减凭证物品并发放对应皮肤。
   * @param args - 兑换参数
   * @param args.goodId - 商品ID（对应 skinGoodList 中的 goodId）
   */
export async function useVoucherSkin(mgr: ShopManager, args: { goodId: string }) : Promise<void> {
    const { goodId } = args;
    const good = excel.ShopTable.skinGoodList.goodList.find(
      (g) => g.goodId === goodId,
    );
    if (!good) {
      return;
    }
    // 修复：皮肤表不存在（数据错位）拒绝——避免写入无效 characterSkins 条目
    if (!mgr._skinExists(good.skinId)) {
      return;
    }
    // 修复：凭证核销——凭证皮肤商品 currencyUnit 即凭证物品 id（DIAMOND 除外；
    // 当前 SkinGoodList.json 无 isRedeem 商品，此路径有配置时不再无限免费兑换）
    if (good.isRedeem && good.currencyUnit && good.currencyUnit !== "DIAMOND") {
      await mgr._player.gainItem
        .add(excel.makeItem(good.currencyUnit, 1))
        .use();
    }
    // 发放皮肤物品
    const item: ItemBundle = {
      id: good.skinId,
      count: 1,
      type: "CHAR_SKIN" as ItemType,
    };
    await mgr._player.update(async (draft) => {
      // 修复：兑换记录写入 SKIN 商店而非信用商店（原写 SOCIAL.info 污染信用记录）
      const skin = mgr._shopDraft(draft, "SKIN");
      const existingItem = skin.info.find((i) => i.id === goodId);
      if (existingItem) {
        existingItem.count += 1;
      } else {
        skin.info.push(excel.makeItem(goodId, 1));
      }
    });
    await mgr._player.gainItem.add(item).handle();
}

  /**
   * 检查商店禁止状态
   *
   * 参考实现中此接口为占位（返回 202）。此处简化实现：永远返回未禁止状态。
   * 用于客户端校验玩家是否被限制购买，正常游戏状态下应始终为允许。
   * @returns 禁止状态信息
   */
export function checkForbidden(mgr: ShopManager) : { forbidden: boolean; reason: string } {
    return {
      forbidden: false,
      reason: "",
    };
}
