/**
 * 商店管理器类
 *
 * 负责处理商店购买相关的核心业务逻辑，包括低级商店、高级商店、皮肤商店、
 * 家具商店等多种类型商店的购买操作和刷新逻辑。
 */

import { ItemBundle } from "@excel/excel";
import type { Draft } from "mutative";
import type { PlayerDataModel, PlayerShop } from "../../kernel/playerdata";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { readJsonSync } from "@utils/file";
import { ChooseGPItem, ClassicGoodList, GPGoodList, HighGoodList, LevelGPItem, LMTGSGood, MonthlySubItem, NormalGPItem, PeriodicityGroup, PeriodicityGPItem, QCObject, REPGoodList, SocialGoodList, SocialShopData } from "@excel/excel";
import excel from "@excel/excel";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { registerShopTriggers } from "./trigger";

/**
 * 信用交易所物资条目（PRTS 采购中心「信用交易所」物资表的单个物资）
 *
 * 对应候选池中的一种可选物资：item 入账所需 id/count/type，
 * originPrice 为原价（信用），allow95/allow99 标记该物资是否可刷出 -95%/-99% 特价
 *（仅「龙门币×1800/基础作战记录」可 -95%，「龙门币×3600/初级作战记录」可 -99%）。
 */
export interface CreditShopMaterial {
  /** 物品 id（ItemTable itemId） */
  id: string;
  /** 单次购买数量 */
  count: number;
  /** 入账类型（ItemTable itemType） */
  type: string;
  /** 客户端展示名称 */
  name: string;
  /** 原价（信用） */
  originPrice: number;
  /** 是否可刷 -95% 特价 */
  allow95?: boolean;
  /** 是否可刷 -99% 特价 */
  allow99?: boolean;
}

/**
 * 信用交易所候选池条目（rows JSON 原始结构；name/type 由 item_table 运行时推导）
 */
export interface CreditShopRowEntry {
  /** 物品 id（ItemTable itemId） */
  id: string;
  /** 单次购买数量 */
  count: number;
  /** 原价（信用） */
  originPrice: number;
  /** 是否可刷 -95% 特价 */
  allow95?: boolean;
  /** 是否可刷 -99% 特价 */
  allow99?: boolean;
}

/**
 * 信用交易所候选池（7 行「并列随机抽取项」，data/shop/credit-shop-rows.json）
 *
 * PRTS：信用交易所物资每日只刷 10 个；候选物资按"同一行四个物品为并列随机抽取项"——
 * 每次从一行中随机取其一作为当日可能出现的一个物资。行内各物资原价（信用）见文档。
 */

import {
  dailyRefresh,
  todaySocialShopId,
  _creditContractPrice,
  buildSocialGoodList,
  _seededRng,
  _materialFromEntry,
  _creditDiscount,
  _buildSocialNormalGoods,
  buySocialGood,
  refreshSocialShop,
} from "./logic/social";
import {
  todayLowShopId,
  todayExtraShopId,
  refreshExtraShop,
  buyLowGood,
  buyHighGood,
  buyExtraGood,
  _currentStandardPool,
  _currentClassicPool,
  _currentFesClassicPool,
  _autoGoodsTime,
  _charName,
  _issueCharItem,
  buildHighCharGoods,
  buildClassicCharGoods,
  _pickTicketId,
  buildHighGoodList,
  buildClassicGoodList,
} from "./logic/low-high";
import {
  monthlyRefresh,
  buyEPGSGood,
  buyREPGood,
  buyClassicGood,
  buyLMTGSGood,
  currentLimitedPool,
  buildLMTGSGoodList,
  buildFesPickGoods,
  _buildFesPickGood,
  buildREPGoodList,
} from "./logic/fes";
import {
  _assertBuyCount,
  _held,
  _assertAffordable,
  _boughtCount,
  _assertAvail,
  _shopDraft,
  _skinExists,
  buySkinGood,
  buyCashGood,
  buyFurniGood,
  buyFurniGroup,
  buyGoodWithTicket,
  getCashGoodPurchaseResult,
  getVoucherSkinGoodList,
  useVoucherSkin,
  checkForbidden,
  type ShopDraftKey,
  type ShopProgressLike,
} from "./logic/misc";

export class ShopManager {
  _creditRows: CreditShopRowEntry[][] = [];

  /** 社交商店商品列表基座缓存（构造期同步加载；测试可注入） */
  socialGoodList: SocialGoodList = { goodList: [], charPurchase: {} };

  _player: PlayerDataManager;

  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    // 事件订阅抽至 trigger.ts（注册顺序 daily → monthly 不变，即派发顺序）
    registerShopTriggers(_trigger, this);
    // 信用商店商品基座（静态配置；buildSocialGoodList 按当天日期重新生成）。
    // 修复：同步读取——原异步 readJson 与首次 getSocialGoodList 请求竞态，
    // 启动后首请求拿到空基座 → 信用商店缺常规商品
    try {
      this.socialGoodList = readJsonSync<SocialGoodList>(
        "./data/shop/SocialGoodList.json",
      );
    } catch {
      this.socialGoodList = { goodList: [], charPurchase: {} };
    }
    // 信用交易所候选池（7 行「并列随机抽取项」；name/type 由 item_table 推导）。
    // 修复：同步读取——原异步 readJson 与首次 getSocialGoodList 请求竞态（同 socialGoodList）
    try {
      const cfg = readJsonSync<{ rows: CreditShopRowEntry[][] }>(
        "./data/shop/credit-shop-rows.json",
      );
      this._creditRows = cfg.rows ?? [];
    } catch {
      this._creditRows = [];
    }
  }

  _autoLMTGSGoods: LMTGSGood[] | null = null;

  _autoHighGoods: QCObject[] | null = null;

  _autoClassicGoods: QCObject[] | null = null;

  _autoFesPickGoods: { HS: QCObject[]; KS: QCObject[] } | null = null;

  /** 委派至 {@link dailyRefresh}（logic/social.ts） */
  async dailyRefresh() {
    return dailyRefresh(this);
  }

  /** 委派至 {@link todaySocialShopId}（logic/social.ts） */
  todaySocialShopId() : string {
    return todaySocialShopId(this);
  }

  /** 委派至 {@link _creditContractPrice}（logic/social.ts） */
  _creditContractPrice(unlockNum: number) : number {
    return _creditContractPrice(this, unlockNum);
  }

  /** 委派至 {@link buildSocialGoodList}（logic/social.ts） */
  buildSocialGoodList() : SocialGoodList & {
    costSocialPoint: number;
    creditGroup: string;
  } {
    return buildSocialGoodList(this);
  }

  /** 委派至 {@link _seededRng}（logic/social.ts） */
  _seededRng(seed: string) : () => number {
    return _seededRng(this, seed);
  }

  /** 委派至 {@link _materialFromEntry}（logic/social.ts） */
  _materialFromEntry(entry: CreditShopRowEntry) : CreditShopMaterial {
    return _materialFromEntry(this, entry);
  }

  /** 委派至 {@link _creditDiscount}（logic/social.ts） */
  _creditDiscount(rand: () => number, m: CreditShopMaterial) : number {
    return _creditDiscount(this, rand, m);
  }

  /** 委派至 {@link _buildSocialNormalGoods}（logic/social.ts） */
  _buildSocialNormalGoods(count: number,
    prefix: string,) : SocialShopData[] {
    return _buildSocialNormalGoods(this, count, prefix);
  }

  /** 委派至 {@link buySocialGood}（logic/social.ts） */
  async buySocialGood(args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    return buySocialGood(this, args);
  }

  /** 委派至 {@link refreshSocialShop}（logic/social.ts） */
  async refreshSocialShop() : Promise<void> {
    return refreshSocialShop(this);
  }

  /** 委派至 {@link todayLowShopId}（logic/low-high.ts） */
  todayLowShopId() : string {
    return todayLowShopId(this);
  }

  /** 委派至 {@link todayExtraShopId}（logic/low-high.ts） */
  todayExtraShopId() : string {
    return todayExtraShopId(this);
  }

  /** 委派至 {@link refreshExtraShop}（logic/low-high.ts） */
  async refreshExtraShop() : Promise<void> {
    return refreshExtraShop(this);
  }

  /** 委派至 {@link buyLowGood}（logic/low-high.ts） */
  async buyLowGood(args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    return buyLowGood(this, args);
  }

  /** 委派至 {@link buyHighGood}（logic/low-high.ts） */
  async buyHighGood(args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    return buyHighGood(this, args);
  }

  /** 委派至 {@link buyExtraGood}（logic/low-high.ts） */
  async buyExtraGood(args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    return buyExtraGood(this, args);
  }

  /** 委派至 {@link _currentStandardPool}（logic/low-high.ts） */
  _currentStandardPool() : (typeof excel.GachaTable.gachaPoolClient)[number] | null {
    return _currentStandardPool(this);
  }

  /** 委派至 {@link _currentClassicPool}（logic/low-high.ts） */
  _currentClassicPool() : (typeof excel.GachaTable.gachaPoolClient)[number] | null {
    return _currentClassicPool(this);
  }

  /** 委派至 {@link _currentFesClassicPool}（logic/low-high.ts） */
  _currentFesClassicPool() : (typeof excel.GachaTable.gachaPoolClient)[number] | null {
    return _currentFesClassicPool(this);
  }

  /** 委派至 {@link _autoGoodsTime}（logic/low-high.ts） */
  _autoGoodsTime(pool: {
    openTime: number;
    endTime: number;
  }) : { goodStartTime: number; goodEndTime: number } {
    return _autoGoodsTime(this, pool);
  }

  /** 委派至 {@link _charName}（logic/low-high.ts） */
  _charName(charId: string) : string {
    return _charName(this, charId);
  }

  /** 委派至 {@link _issueCharItem}（logic/low-high.ts） */
  async _issueCharItem(item: ItemBundle) : Promise<ItemBundle & { instId?: number }> {
    return _issueCharItem(this, item);
  }

  /** 委派至 {@link buildHighCharGoods}（logic/low-high.ts） */
  buildHighCharGoods() : QCObject[] {
    return buildHighCharGoods(this);
  }

  /** 委派至 {@link buildClassicCharGoods}（logic/low-high.ts） */
  buildClassicCharGoods() : QCObject[] {
    return buildClassicCharGoods(this);
  }

  /** 委派至 {@link _pickTicketId}（logic/low-high.ts） */
  _pickTicketId(tier: number, poolId: string) : string {
    return _pickTicketId(this, tier, poolId);
  }

  /** 委派至 {@link buildHighGoodList}（logic/low-high.ts） */
  buildHighGoodList() : HighGoodList {
    return buildHighGoodList(this);
  }

  /** 委派至 {@link buildClassicGoodList}（logic/low-high.ts） */
  buildClassicGoodList() : ClassicGoodList {
    return buildClassicGoodList(this);
  }

  /** 委派至 {@link monthlyRefresh}（logic/fes.ts） */
  async monthlyRefresh() {
    return monthlyRefresh(this);
  }

  /** 委派至 {@link buyEPGSGood}（logic/fes.ts） */
  async buyEPGSGood(args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    return buyEPGSGood(this, args);
  }

  /** 委派至 {@link buyREPGood}（logic/fes.ts） */
  async buyREPGood(args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    return buyREPGood(this, args);
  }

  /** 委派至 {@link buyClassicGood}（logic/fes.ts） */
  async buyClassicGood(args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    return buyClassicGood(this, args);
  }

  /** 委派至 {@link buyLMTGSGood}（logic/fes.ts） */
  async buyLMTGSGood(args: {
    goodId: string;
    count: number;
  }) : Promise<ItemBundle[]> {
    return buyLMTGSGood(this, args);
  }

  /** 委派至 {@link currentLimitedPool}（logic/fes.ts） */
  currentLimitedPool() : (typeof excel.GachaTable.gachaPoolClient)[number] | null {
    return currentLimitedPool(this);
  }

  /** 委派至 {@link buildLMTGSGoodList}（logic/fes.ts） */
  buildLMTGSGoodList() : LMTGSGood[] {
    return buildLMTGSGoodList(this);
  }

  /** 委派至 {@link buildFesPickGoods}（logic/fes.ts） */
  buildFesPickGoods(prefix: "HS" | "KS") : QCObject[] {
    return buildFesPickGoods(this, prefix);
  }

  /** 委派至 {@link _buildFesPickGood}（logic/fes.ts） */
  _buildFesPickGood(prefix: "HS" | "KS",
    tier: string,
    ticketId: string,
    pool: (typeof excel.GachaTable.gachaPoolClient)[number],
    price: number,
    itemType: string,) : QCObject {
    return _buildFesPickGood(this, prefix, tier, ticketId, pool, price, itemType);
  }

  /** 委派至 {@link buildREPGoodList}（logic/fes.ts） */
  buildREPGoodList() : REPGoodList {
    return buildREPGoodList(this);
  }

  /** 委派至 {@link _assertBuyCount}（logic/misc.ts） */
  _assertBuyCount(count: number) : void {
    return _assertBuyCount(this, count);
  }

  /** 委派至 {@link _held}（logic/misc.ts） */
  _held(itemId: string) : number {
    return _held(this, itemId);
  }

  /** 委派至 {@link _assertAffordable}（logic/misc.ts） */
  _assertAffordable(itemId: string, count: number) : void {
    return _assertAffordable(this, itemId, count);
  }

  /** 委派至 {@link _boughtCount}（logic/misc.ts） */
  _boughtCount(shopKey: ShopDraftKey, goodId: string) : number {
    return _boughtCount(this, shopKey, goodId);
  }

  /** 委派至 {@link _assertAvail}（logic/misc.ts） */
  _assertAvail(shopKey: ShopDraftKey,
    goodId: string,
    count: number,
    availCount?: number,) : void {
    return _assertAvail(this, shopKey, goodId, count, availCount);
  }

  /** 委派至 {@link _shopDraft}（logic/misc.ts） */
  _shopDraft<K extends ShopDraftKey>(draft: Draft<PlayerDataModel>, key: K) : PlayerShop[K] & ShopProgressLike {
    return _shopDraft(this, draft, key);
  }

  /** 委派至 {@link _skinExists}（logic/misc.ts） */
  _skinExists(skinId: string) : boolean {
    return _skinExists(this, skinId);
  }

  /** 委派至 {@link buySkinGood}（logic/misc.ts） */
  async buySkinGood(args: { goodId: string }) : Promise<void> {
    return buySkinGood(this, args);
  }

  /** 委派至 {@link buyCashGood}（logic/misc.ts） */
  async buyCashGood(args: { goodId: string }) : Promise<ItemBundle[]> {
    return buyCashGood(this, args);
  }

  /** 委派至 {@link buyFurniGood}（logic/misc.ts） */
  async buyFurniGood(args: {
    goodId: string;
    buyCount: number;
    costType: string;
  }) : Promise<ItemBundle[]> {
    return buyFurniGood(this, args);
  }

  /** 委派至 {@link buyFurniGroup}（logic/misc.ts） */
  async buyFurniGroup(args: {
    groupId?: string;
    goods?: { id: string; count: number }[];
  }) : Promise<ItemBundle[]> {
    return buyFurniGroup(this, args);
  }

  /** 委派至 {@link buyGoodWithTicket}（logic/misc.ts） */
  async buyGoodWithTicket(args: {
    ticketId: string;
    goodId: string;
  }) : Promise<ItemBundle[]> {
    return buyGoodWithTicket(this, args);
  }

  /** 委派至 {@link getCashGoodPurchaseResult}（logic/misc.ts） */
  async getCashGoodPurchaseResult() : Promise<{
    info: { id: string; count: number }[];
  }> {
    return getCashGoodPurchaseResult(this);
  }

  /** 委派至 {@link getVoucherSkinGoodList}（logic/misc.ts） */
  getVoucherSkinGoodList() : { goodList: unknown[] } {
    return getVoucherSkinGoodList(this);
  }

  /** 委派至 {@link useVoucherSkin}（logic/misc.ts） */
  async useVoucherSkin(args: { goodId: string }) : Promise<void> {
    return useVoucherSkin(this, args);
  }

  /** 委派至 {@link checkForbidden}（logic/misc.ts） */
  checkForbidden() : { forbidden: boolean; reason: string } {
    return checkForbidden(this);
  }
}
