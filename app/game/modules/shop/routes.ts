import { ItemBundle } from "@excel/excel";
import type { ShopSkinItemViewModel } from "@excel/excel";
import { getIn } from "@utils/json-path";
import { isJsonObject, type JsonValue } from "@excel/json-value";
/**
 * 商店路由模块
 *
 * 处理商店相关的 HTTP 请求，包括商品列表查询和各类商店的购买操作。
 * 路由层保持轻薄，业务逻辑委托给 ShopManager / TroopManager 等 Manager 层处理。
 * 请求/响应类型见 ./models（参考 CS 2.7.61 协议类）。
 */

import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { ShopError } from "./errors";
import excel from "@excel/excel";
import config from "@core/config/index";
import {
  BuyCashGoodRequest,
  BuyCashGoodResponse,
  BuyClassicGoodRequest,
  BuyClassicGoodResponse,
  BuyEPGSGoodRequest,
  BuyEPGSGoodResponse,
  BuyExtraGoodRequest,
  BuyExtraGoodResponse,
  BuyFurniGoodRequest,
  BuyFurniGoodResponse,
  BuyFurniGroupRequest,
  BuyGoodWithTicketRequest,
  BuyGoodWithTicketResponse,
  BuyHighGoodRequest,
  BuyHighGoodResponse,
  BuyLMTGSGoodRequest,
  BuyLMTGSGoodResponse,
  BuyLowGoodRequest,
  BuyLowGoodResponse,
  BuyREPGoodRequest,
  BuyREPGoodResponse,
  BuySkinGoodRequest,
  BuySkinGoodResponse,
  BuySocialGoodRequest,
  BuySocialGoodResponse,
  CheckForbiddenRequest,
  CheckForbiddenResponse,
  DecomposeClassicPotentialItemRequest,
  DecomposeClassicPotentialItemResponse,
  DecomposePotentialItemRequest,
  DecomposePotentialItemResponse,
  GetCashGoodListRequest,
  GetCashGoodListResponse,
  GetCashGoodPurchaseResultRequest,
  GetCashGoodPurchaseResultResponse,
  GetClassicGoodListRequest,
  GetClassicGoodListResponse,
  GetEPGSGoodListRequest,
  GetEPGSGoodListResponse,
  GetExtraGoodListRequest,
  GetExtraGoodListResponse,
  GetFurniGoodListRequest,
  GetFurniGoodListResponse,
  GetGoodPurchaseStateRequest,
  GetGoodPurchaseStateResponse,
  GetGPGoodListRequest,
  GetGPGoodListResponse,
  GetHighGoodListRequest,
  GetHighGoodListResponse,
  GetLMTGSGoodListRequest,
  GetLMTGSGoodListResponse,
  GetLowGoodListRequest,
  GetLowGoodListResponse,
  GetREPGoodListRequest,
  GetREPGoodListResponse,
  GetSkinGoodListRequest,
  GetSkinGoodListResponse,
  GetSocialGoodListRequest,
  GetSocialGoodListResponse,
  GetVoucherSkinGoodListRequest,
  GetVoucherSkinGoodListResponse,
  UseVoucherSkinRequest,
  UseVoucherSkinResponse,
} from "./models";
import {
  buyCashGoodSchema,
  buyClassicGoodSchema,
  buyEPGSGoodSchema,
  buyExtraGoodSchema,
  buyFurniGoodSchema,
  buyFurniGroupSchema,
  buyGoodWithTicketSchema,
  buyGPGoodWithTicketSchema,
  buyHighGoodSchema,
  buyLMTGSGoodSchema,
  buyLowGoodSchema,
  buyREPGoodSchema,
  buySkinGoodSchema,
  buySocialGoodSchema,
  decomposeClassicPotentialItemSchema,
  decomposePotentialItemSchema,
  emptyRequestSchema,
  getGoodPurchaseStateSchema,
  useVoucherSkinSchema,
} from "./shop.schema";
import { validateBody } from "@core/http/validate-body";

const router = Router();

/**
 * 校验请求体必填字段是否缺失
 * @param body - 请求体
 * @param required - 必填字段名列表
 * @returns 缺失的字段名列表（空数组表示全部存在）
 */
function missingRequiredFields(
  body: unknown,
  required: string[],
): string[] {
  const b = (body ?? {}) as Record<string, unknown>;
  return required.filter((f) => b[f] === undefined);
}

/**
 * 分解潜能物品
 * @route POST /shop/decomposePotentialItem
 * @param req.body - 分解参数
 * @returns 分解获得的物品和玩家增量数据
 */
router.post("/decomposePotentialItem", validateBody(decomposePotentialItemSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as DecomposePotentialItemRequest;
  // 缺参校验：charInstIdList 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["charInstIdList"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  res.send({
    items: await player.troop.decomposePotentialItem(body),
    ...player.delta,
  } satisfies DecomposePotentialItemResponse);
});

/**
 * 分解经典潜能物品
 * @route POST /shop/decomposeClassicPotentialItem
 * @param req.body - 分解参数
 * @returns 分解获得的物品和玩家增量数据
 */
router.post("/decomposeClassicPotentialItem", validateBody(decomposeClassicPotentialItemSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as DecomposeClassicPotentialItemRequest;
  // 缺参校验：charInstIdList 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["charInstIdList"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  res.send({
    items: await player.troop.decomposeClassicPotentialItem(body),
    ...player.delta,
  } satisfies DecomposeClassicPotentialItemResponse);
});

/**
 * 获取商品购买状态
 *
 * 返回玩家在各商店的购买记录，客户端据此判断商品是否已购买、限购次数等。
 * 参考实现中此接口返回空对象，此处返回玩家 shop 状态中的所有购买记录。
 * @route POST /shop/getGoodPurchaseState
 * @returns 购买状态和玩家增量数据
 */
/**
 * 收集商店状态里的已购 goodId
 *
 * 兼容两种形状：常规商店 `{ info: [{id, count}] }` 与 GP 等嵌套商店
 * `{ subType: { info: [...] } }`。以 JSON 域收窄（shopType 为客户端动态键）。
 * @param node - 商店子节点（JSON 域）
 * @param out - 已购 goodId 集合（原地累加）
 */
function collectPurchased(node: JsonValue | undefined, out: Set<string>): void {
  if (node === undefined || !isJsonObject(node)) return;
  const info = node.info;
  if (Array.isArray(info)) {
    for (const item of info) {
      if (isJsonObject(item) && typeof item.id === "string") out.add(item.id);
    }
    return;
  }
  for (const sub of Object.values(node)) {
    if (!isJsonObject(sub)) continue;
    const subInfo = sub.info;
    if (!Array.isArray(subInfo)) continue;
    for (const item of subInfo) {
      if (isJsonObject(item) && typeof item.id === "string") out.add(item.id);
    }
  }
}

router.post("/getGoodPurchaseState", validateBody(getGoodPurchaseStateSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetGoodPurchaseStateRequest;
  // 修复：按客户端 goodIdMap 返回扁平 {goodId: 1|-1}（1=可购买/-1=已购买/限购），
  // 对齐 CS GetGoodPurchaseStateResponse { result: Dictionary<string, int> } 与抓包形状；
  // 原实现直接返回各商店原始 info 数组（41KB 且形状不符）
  const goodIdMap = body.goodIdMap ?? {};
  const shopState = player._playerdata.shop;
  const result: { [goodId: string]: number } = {};
  for (const [shopType, goodIds] of Object.entries(goodIdMap)) {
    if (!Array.isArray(goodIds) || goodIds.length === 0) continue;
    const purchased = new Set<string>();
    collectPurchased(getIn(shopState, [shopType]), purchased);
    for (const goodId of goodIds) {
      result[goodId] = purchased.has(goodId) ? -1 : 1;
    }
  }
  res.send({
    result,
    ...player.delta,
  } satisfies GetGoodPurchaseStateResponse);
});

/**
 * 获取低级商店商品列表
 * @route POST /shop/getLowGoodList
 * @returns 低级商店商品列表和玩家增量数据
 */
router.post("/getLowGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetLowGoodListRequest;
  // 修复：跨月刷新——玩家 LS.curShopId 停留在旧月份（迁移/未触发 monthlyRefresh）时，
  // 客户端按它计算刷新倒计时 → 剩余时间为负。进入商店时若不是当月立即重置
  const ls = player._playerdata.shop?.LS;
  if (ls && ls.curShopId !== player.modules.shop.todayLowShopId()) {
    await player.modules.shop.monthlyRefresh();
  }
  res.send({
    ...excel.ShopTable.lowGoodList,
    ...player.delta,
  } satisfies GetLowGoodListResponse);
});

/**
 * 获取高级商店商品列表（高级凭证区——干员区按当前标准池自动生成 + 静态材料区）
 * @route POST /shop/getHighGoodList
 * @returns 高级商店商品列表和玩家增量数据
 */
router.post("/getHighGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetHighGoodListRequest;
  res.send({
    ...player.modules.shop.buildHighGoodList(),
    ...player.delta,
  } satisfies GetHighGoodListResponse);
});

/**
 * 获取经典商店商品列表（通用凭证区——干员区按当前中坚池自动生成 + 静态 progress 商品）
 * @route POST /shop/getClassicGoodList
 * @returns 经典商店商品列表和玩家增量数据
 */
router.post("/getClassicGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetClassicGoodListRequest;
  res.send({
    ...player.modules.shop.buildClassicGoodList(),
    ...player.delta,
  } satisfies GetClassicGoodListResponse);
});

/**
 * 获取联合行动商店商品列表
 * @route POST /shop/getEPGSGoodList
 * @returns 联合行动商店商品列表和玩家增量数据
 */
router.post("/getEPGSGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetEPGSGoodListRequest;
  res.send({
    ...excel.ShopTable.EPGSGoodList,
    ...player.delta,
  } satisfies GetEPGSGoodListResponse);
});

/**
 * 获取限定商店商品列表
 * @route POST /shop/getLMTGSGoodList
 * @returns 限定商店商品列表和玩家增量数据
 */
router.post("/getLMTGSGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetLMTGSGoodListRequest;
  // 自动生成 + 静态合并：新限定池无需手动补 LMTGSGoodList.json
  const auto = player.modules.shop.buildLMTGSGoodList();
  const staticList = excel.ShopTable.LMTGSGoodList;
  // 修复：静态商品仅保留当期池（按池前缀过滤）——原返回全部池商品，非当期池
  // 商品用旧池代币无法购买；自动商品已按当期池代币生成（见 buildLMTGSGoodList）
  const poolId = player.modules.shop.currentLimitedPool()?.gachaPoolId;
  const staticGoods = poolId
    ? staticList.goodList.filter((g) => g.goodId.startsWith(poolId))
    : [];
  const autoIds = new Set(auto.map((g) => g.goodId));
  const goodList = [
    ...auto,
    ...staticGoods.filter((g) => !autoIds.has(g.goodId)),
  ];
  res.send({
    goodList,
    newFlag: [],
    ...player.delta,
  } satisfies GetLMTGSGoodListResponse);
});

/**
 * 获取额外商店商品列表
 * @route POST /shop/getExtraGoodList
 * @returns 额外商店商品列表和玩家增量数据
 */
router.post("/getExtraGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetExtraGoodListRequest;
  // 修复：跨年刷新——玩家 ES.curShopId 停留在旧年份（如 xShdShopnumber2=2023）时，
  // 客户端按它计算刷新倒计时 → 剩余时间为负。进入商店时若不是当年立即重置
  const es = player._playerdata.shop?.ES as { curShopId?: string } | undefined;
  if (es && es.curShopId !== player.modules.shop.todayExtraShopId()) {
    await player.modules.shop.refreshExtraShop();
  }
  res.send({
    ...excel.ShopTable.extraGoodList,
    ...player.delta,
  } satisfies GetExtraGoodListResponse);
});

/**
 * 获取声望商店商品列表
 * @route POST /shop/getREPGoodList
 * @returns 声望商店商品列表和玩家增量数据
 */
router.post("/getREPGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetREPGoodListRequest;
  res.send({
    // 修复：availCount 按已购数量抬升（剩余显示不为负，见 buildREPGoodList）
    ...player.modules.shop.buildREPGoodList(),
    ...player.delta,
  } satisfies GetREPGoodListResponse);
});

/**
 * 获取皮肤商店商品列表
 *
 * 修复：过滤皮肤表（excel.SkinTable.charSkins）不存在的 skinId——数据错位（如
 * char_254_vodfox_witch#2 漏写 @）会导致客户端预览图加载失败。
 * 配置 config.shop.skinSellAll=true 时，售卖全部可购买（isBuySkin）皮肤——在静态
 * SkinGoodList.json 之上补齐所有未收录皮肤（统一按源石 DIAMOND 定价，price 优先取
 * 静态同名商品，否则默认 18），静态列表中已有的价格/命名被保留，其余动态生成。
 * @route POST /shop/getSkinGoodList
 * @returns 皮肤商店商品列表和玩家增量数据
 */
router.post("/getSkinGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetSkinGoodListRequest;
  const charSkins = excel.SkinTable?.charSkins ?? {};
  let goodList = excel.ShopTable.skinGoodList.goodList;
  // 皮肤售卖所有皮肤：动态补齐所有 isBuySkin 皮肤（静态皮肤优先保留价格/命名）
  if (config.shop?.skinSellAll) {
    const staticBySkin = new Map(
      goodList
        .filter((g) => charSkins[g.skinId])
        .map((g): [string, ShopSkinItemViewModel] => [g.skinId, g]),
    );
    const auto: ShopSkinItemViewModel[] = [];
    for (const skin of Object.values(charSkins)) {
      if (!skin || !skin.isBuySkin) continue; // 默认/活动皮肤不售卖
      const s = staticBySkin.get(skin.skinId);
      const name =
        s?.skinName ?? skin.displaySkin?.skinName ?? skin.skinId;
      // 静态已收录的取原价/原价/折扣，未收录默认 18 源石
      auto.push({
        charId: skin.charId,
        skinName: name,
        discount: s?.discount ?? 0,
        skinId: skin.skinId,
        goodId: `SS_${skin.skinId}`,
        originPrice: s?.originPrice ?? 18,
        endDateTime: -1,
        desc1: null,
        desc2: null,
        startDateTime: -1,
        price: s?.price ?? 18,
        slotId: 0,
        currencyUnit: "DIAMOND",
        isRedeem: s?.isRedeem ?? false,
      });
    }
    goodList = auto;
  }
  // 修复：slotId 重排——SkinGoodList.json 由多期数据拼接，12 组皮肤共用同一 slotId
  // （客户端时装商店按 slotId 渲染格子，冲突导致点 A 显示 B / 预览错乱）。
  // 过滤皮肤表不存在的 skinId（数据错位防御）后按原顺序重排唯一 slotId
  goodList = goodList
    .filter((g) => Boolean(charSkins[g.skinId]))
    .map((g, i) => ({ ...g, slotId: i + 1 }));
  res.send({
    ...excel.ShopTable.skinGoodList,
    goodList,
    ...player.delta,
  } satisfies GetSkinGoodListResponse);
});

/**
 * 获取现金商店商品列表
 * @route POST /shop/getCashGoodList
 * @returns 现金商店商品列表和玩家增量数据
 */
router.post("/getCashGoodList", validateBody(emptyRequestSchema), (req, res) => {
  const player = getPlayer();
  req.body as GetCashGoodListRequest;
  res.send({
    ...excel.ShopTable.cashGoodList,
    ...player.delta,
  } satisfies GetCashGoodListResponse);
});

/**
 * 获取信用商店商品列表
 * @route POST /shop/getGPGoodList
 * @returns 信用商店商品列表和玩家增量数据
 */
router.post("/getGPGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetGPGoodListRequest;
  res.send({
    ...excel.ShopTable.GPGoodList,
    ...player.delta,
  } satisfies GetGPGoodListResponse);
});

/**
 * 获取社交商店商品列表
 * @route POST /shop/getSocialGoodList
 * @returns 社交商店商品列表和玩家增量数据
 */
router.post("/getSocialGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetSocialGoodListRequest;
  // 修复：跨天刷新——玩家 shop.SOCIAL.curShopId 停留在旧日期（迁移/未触发 dailyRefresh）
  // 时，客户端按它计算刷新倒计时 → 剩余时间为负。进入商店时若 curShopId 不是当天，
  // 立即重置为当天并清空当日购买记录（干员信物进度 charPurchase 保留）
  const social = player._playerdata.shop?.SOCIAL as
    | { curShopId?: string }
    | undefined;
  if (social && social.curShopId !== player.modules.shop.todaySocialShopId()) {
    await player.modules.shop.refreshSocialShop();
  }
  // 信用商店：按当天日期自动生成（goodId = SOCIAL<YYYYMMDD>_...）
  res.send({
    ...player.modules.shop.buildSocialGoodList(),
    ...player.delta,
  } satisfies GetSocialGoodListResponse);
});

/** 购买信用商店商品（信用 = status.socialPoint） */
router.post("/buySocialGood", validateBody(buySocialGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuySocialGoodRequest;
  // 缺参校验：goodId/count 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "count"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buySocialGood(body),
      ...player.delta,
    } satisfies BuySocialGoodResponse);
  } catch (e) {
    // 余额不足/超限购 → result:1 业务错误而非 500
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuySocialGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 获取家具商店商品列表
 * @route POST /shop/getFurniGoodList
 * @returns 家具商店商品列表和玩家增量数据
 */
router.post("/getFurniGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetFurniGoodListRequest;
  res.send({
    ...excel.ShopTable.furniGoodList,
    ...player.delta,
  } satisfies GetFurniGoodListResponse);
});

/**
 * 购买低级商店商品
 * @route POST /shop/buyLowGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
router.post("/buyLowGood", validateBody(buyLowGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyLowGoodRequest;
  // 缺参校验：goodId/count 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "count"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyLowGood(body),
      ...player.delta,
    } satisfies BuyLowGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyLowGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买高级商店商品
 * @route POST /shop/buyHighGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
router.post("/buyHighGood", validateBody(buyHighGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyHighGoodRequest;
  // 缺参校验：goodId/count 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "count"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyHighGood(body),
      ...player.delta,
    } satisfies BuyHighGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyHighGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买额外商店商品
 * @route POST /shop/buyExtraGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
router.post("/buyExtraGood", validateBody(buyExtraGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyExtraGoodRequest;
  // 缺参校验：goodId/count 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "count"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyExtraGood(body),
      ...player.delta,
    } satisfies BuyExtraGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyExtraGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买现金商店商品
 *
 * 现金商店以钻石为货币，购买后记录次数并支持首充翻倍。
 * @route POST /shop/buyCashGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
router.post("/buyCashGood", validateBody(buyCashGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyCashGoodRequest;
  // 缺参校验：goodId 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyCashGood(body),
      ...player.delta,
    } satisfies BuyCashGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyCashGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买联合行动商店商品
 * @route POST /shop/buyEPGSGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
router.post("/buyEPGSGood", validateBody(buyEPGSGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyEPGSGoodRequest;
  // 缺参校验：goodId/count 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "count"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyEPGSGood(body),
      ...player.delta,
    } satisfies BuyEPGSGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyEPGSGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买声望商店商品
 * @route POST /shop/buyREPGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
router.post("/buyREPGood", validateBody(buyREPGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyREPGoodRequest;
  // 缺参校验：goodId/count 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "count"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyREPGood(body),
      ...player.delta,
    } satisfies BuyREPGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyREPGoodResponse);
      return;
    }
    throw e;
  }
});
/** 购买声望商店商品（门票版；客户端路由 /shop/buyREPGoodWithTicket，复用 buyREPGood 逻辑） */
router.post("/buyREPGoodWithTicket", validateBody(buyREPGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyREPGoodRequest;
  // 缺参校验：goodId/count 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "count"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyREPGood(body),
      ...player.delta,
    } satisfies BuyREPGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyREPGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买经典商店商品
 * @route POST /shop/buyClassicGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
router.post("/buyClassicGood", validateBody(buyClassicGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyClassicGoodRequest;
  // 缺参校验：goodId/count 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "count"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyClassicGood(body),
      ...player.delta,
    } satisfies BuyClassicGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyClassicGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买限定商店商品
 * @route POST /shop/buyLMTGSGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
router.post("/buyLMTGSGood", validateBody(buyLMTGSGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyLMTGSGoodRequest;
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyLMTGSGood(body),
      ...player.delta,
    } satisfies BuyLMTGSGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyLMTGSGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买家具商店商品
 * @route POST /shop/buyFurniGood
 * @param req.body - 购买参数
 * @returns 购买结果和玩家增量数据
 */
/** 购买家具组（客户端 body: {groupId, goods: [{id,count}]}——整组购买） */
router.post("/buyFurniGroup", validateBody(buyFurniGroupSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyFurniGroupRequest;
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyFurniGroup(body),
      ...player.delta,
    } satisfies BuyFurniGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyFurniGoodResponse);
      return;
    }
    throw e;
  }
});

router.post("/buyFurniGood", validateBody(buyFurniGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyFurniGoodRequest;
  try {
    res.send({
      result: 0,
      items: await player.modules.shop.buyFurniGood(body),
      ...player.delta,
    } satisfies BuyFurniGoodResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyFurniGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 购买皮肤商店商品
 * @route POST /shop/buySkinGood
 * @param req.body - 购买参数
 * @returns 玩家增量数据
 */
router.post("/buySkinGood", validateBody(buySkinGoodSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuySkinGoodRequest;
  // 缺参校验：goodId 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    await player.modules.shop.buySkinGood(body);
    res.send({ ...player.delta } satisfies BuySkinGoodResponse);
  } catch (e) {
    // 已拥有/源石不足 → result:1 业务错误而非 500
    if (e instanceof ShopError) {
      res.send({ result: 1, ...player.delta } satisfies BuySkinGoodResponse);
      return;
    }
    throw e;
  }
});

/**
 * 使用凭证购买礼包商店商品
 *
 * 对应参考实现中的 buyShopGoodWithTicket，使用凭证兑换礼包。
 * goodId 格式约定为 `GP_<goodType>_<序列>`，详见 ShopManager.buyGoodWithTicket。
 * @route POST /shop/buyGoodWithTicket
 * @param req.body.ticketId - 凭证ID
 * @param req.body.goodId - 商品ID
 * @returns 购买结果（含获得的物品列表）和玩家增量数据
 */
router.post("/buyGoodWithTicket", validateBody(buyGoodWithTicketSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyGoodWithTicketRequest;
  // 缺参校验：goodId/ticketId 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId", "ticketId"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    // 修复：凭证核销——原实现从不扣 ticketId，1 张票可无限兑换礼包。
    // ticketId 为凭证物品 id（如 VOUCHER_ONCE_*）；非 ItemTable 物品时 items:use
    // WARN 跳过不 500，避免客户端乱传导致崩溃。
    if (body.ticketId) {
      await player.gainItem.add(excel.makeItem(body.ticketId, 1)).use();
    }
    res.send({
      result: 0,
      items: await player.modules.shop.buyGoodWithTicket(body),
      ...player.delta,
    } satisfies BuyGoodWithTicketResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, items: [], ...player.delta } satisfies BuyGoodWithTicketResponse);
      return;
    }
    throw e;
  }
});

/**
 * 获取现金商品购买结果
 *
 * 用于外部支付通道回调后的查询。参考实现中为占位（返回 202）。
 * 此处返回玩家当前 shop.CASH 的购买记录。
 * @route POST /shop/getCashGoodPurchaseResult
 * @returns 购买结果和玩家增量数据
 */
router.post("/getCashGoodPurchaseResult", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetCashGoodPurchaseResultRequest;
  res.send({
    result: await player.modules.shop.getCashGoodPurchaseResult(),
    ...player.delta,
  } satisfies GetCashGoodPurchaseResultResponse);
});

/**
 * 获取凭证皮肤商品列表
 *
 * 凭证皮肤指通过特殊凭证兑换的皮肤。参考实现中为占位（返回 202）。
 * 此处基于皮肤商店列表筛选可兑换项返回。
 * @route POST /shop/getVoucherSkinGoodList
 * @returns 凭证皮肤商品列表和玩家增量数据
 */
router.post("/getVoucherSkinGoodList", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetVoucherSkinGoodListRequest;
  res.send({
    ...player.modules.shop.getVoucherSkinGoodList(),
    ...player.delta,
  } satisfies GetVoucherSkinGoodListResponse);
});

/**
 * 使用凭证兑换皮肤
 *
 * 参考实现中为占位（返回 202）。此处实现：发放对应皮肤并记录购买。
 * @route POST /shop/useVoucherSkin
 * @param req.body.goodId - 商品ID
 * @returns 玩家增量数据
 */
router.post("/useVoucherSkin", validateBody(useVoucherSkinSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UseVoucherSkinRequest;
  // 缺参校验：goodId 缺失时返回业务错误而非 500
  if (missingRequiredFields(body, ["goodId"]).length) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  try {
    await player.modules.shop.useVoucherSkin(body);
    res.send({ ...player.delta } satisfies UseVoucherSkinResponse);
  } catch (e) {
    if (e instanceof ShopError) {
      res.send({ result: 1, ...player.delta } satisfies UseVoucherSkinResponse);
      return;
    }
    throw e;
  }
});

/**
 * 检查商店禁止状态
 *
 * 用于客户端校验玩家是否被限制购买。参考实现中为占位（返回 202）。
 * 此处简化实现：永远返回未禁止状态。
 * @route POST /shop/checkForbidden
 * @returns 禁止状态和玩家增量数据
 */
router.post("/checkForbidden", validateBody(emptyRequestSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CheckForbiddenRequest;
  res.send({
    ...player.modules.shop.checkForbidden(),
    ...player.delta,
  } satisfies CheckForbiddenResponse);
});

/**
 * 用票券购买 GP 商品（CS: ShopDetailGPState——/shop/buyGPGoodWithTicket）
 * 私服返回空增量（GP 票券购买暂不核销）
 */
router.post("/buyGPGoodWithTicket", validateBody(buyGPGoodWithTicketSchema), async (req, res) => {
  const player = getPlayer();
  req.body as { goodsId?: string };
  res.send(player.delta);
});

export default router;
