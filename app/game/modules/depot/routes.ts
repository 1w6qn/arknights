/**
 * 仓库路由模块（薄壳）
 *
 * 处理仓库相关的 HTTP 请求，包括凭证详情获取、凭证使用等功能。
 * 支持的凭证类型包括：
 * - VOUCHER_PICK：干员兑换券（自选干员）
 * - VOUCHER_CGACHA：干员寻访凭证（干员抽卡）
 * - VOUCHER_MGACHA：材料补给凭证（材料抽卡）
 * - MATERIAL_ISSUE_VOUCHER：材料提货券（自选材料）
 * - OPTIONAL_VOUCHER_PICK：可选兑换券（芯片等自选）
 * - VOUCHER_FULL_POTENTIAL：满潜能道具（干员满潜能）
 *
 * 领域逻辑（凭证表加载/查询、持有量校验）在 ./voucher（voucherService），
 * 物品增减统一经 player.gainItem 管道（不再直发 items:* 事件）。
 */

import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "../../kernel/http/validate-body";
import {
  getVoucherDetailSchema,
  voucherGachaSchema,
  getCharGachaVoucherDetailSchema,
  getMaterialVoucherDetailSchema,
  useCharGachaVoucherSchema,
  useMaterialVoucherSchema,
  useFullPotentialItemSchema,
  useOptionVoucherSchema,
} from "./depot.schema";
import { ItemBundle, ItemType } from "@excel/excel";
import { randomChoice } from "@utils/random";
import { logger } from "@utils/logger";
import excel from "@excel/excel";
import { voucherService, hasVoucherStock } from "./voucher";
import {
  BoostPotentialRequest,
  BoostPotentialResponse,
  GetVoucherDetailRequest,
  GetVoucherDetailResponse,
  UseCharGachaVoucherRequest,
  UseCharGachaVoucherResponse,
  UseMaterialVoucherRequest,
  UseMaterialVoucherResponse,
  UseOptionalVoucherRequest,
  UseOptionalVoucherResponse,
  VoucherCharDetailRequest,
  VoucherCharDetailResponse,
  VoucherGachaDetailRequest,
  VoucherGachaDetailResponse,
  VoucherItemDetailRequest,
  VoucherItemDetailResponse,
} from "./depot";

/** 材料凭证池条目接口（对应 getMaterialVoucherDetail 响应中的 pool 结构） */
interface MaterialVoucherPoolEntry {
  /** 物品ID */
  itemId: string;
  /** 物品类型 */
  itemType: string;
  /** 物品数量 */
  itemNum: number;
  /** 分组ID */
  groupId: string;
  /** 排序序号 */
  sortId: number;
}

const router = Router();

/**
 * 获取凭证详情
 *
 * 根据物品ID查询凭证详情。优先从 voucher.json 加载干员兑换券数据，
 * 若未找到则从 item_table 的 voucherRelateList 反向构建材料凭证信息。
 * @route POST /depot/getVoucherDetail
 * @param req.body.itemId - 物品ID
 * @param (req.body as any).instId - 实例ID
 * @returns 凭证详情和玩家增量数据
 */
router.post("/getVoucherDetail", validateBody(getVoucherDetailSchema), async (req, res) => {
  const player = getPlayer();
  const { itemId } = req.body as GetVoucherDetailRequest;
  const voucherInfo = voucherService.getVoucher(itemId, player.excel);
  res.send({
    ...voucherInfo,
    ...player.delta,
  } satisfies GetVoucherDetailResponse);
});

/**
 * 凭证抽卡
 *
 * 使用凭证进行抽卡操作。当前为简化实现，返回玩家增量数据。
 * 完整实现需要根据凭证类型关联的卡池执行抽卡逻辑（参考 GachaManager）。
 * @route POST /depot/voucherGacha
 * @param req.body - 抽卡参数（含凭证物品ID等）
 * @returns 玩家增量数据
 */
router.post("/voucherGacha", validateBody(voucherGachaSchema), async (req, res) => {
  const player = getPlayer();
  req.body as VoucherGachaDetailRequest;
  // 简化实现：凭证抽卡逻辑较为复杂，需要根据凭证关联的卡池执行抽卡策略
  // 当前仅返回玩家增量数据，完整实现可参考 GachaManager.doAdvancedGacha
  res.send({
    ...player.delta,
  } satisfies VoucherGachaDetailResponse);
});

/**
 * 获取干员抽卡凭证详情
 *
 * 返回干员抽卡凭证（VOUCHER_CGACHA）的详细信息。
 * 复用 getVoucher 的查询逻辑，从 voucher.json 或 item_table 获取数据。
 * @route POST /depot/getCharGachaVoucherDetail
 * @param req.body.itemId - 物品ID
 * @param (req.body as any).instId - 实例ID
 * @returns 凭证详情和玩家增量数据
 */
router.post("/getCharGachaVoucherDetail", validateBody(getCharGachaVoucherDetailSchema), async (req, res) => {
  const player = getPlayer();
  const { itemId } = req.body as VoucherCharDetailRequest;
  const voucherInfo = voucherService.getVoucher(itemId, player.excel);
  res.send({
    ...voucherInfo,
    ...player.delta,
  } satisfies VoucherCharDetailResponse);
});

/**
 * 获取材料凭证详情
 *
 * 返回材料凭证（MATERIAL_ISSUE_VOUCHER / VOUCHER_MGACHA）的可选物品池。
 * 从 item_table 的 voucherRelateList 反向查找关联材料，构建池数据。
 * @route POST /depot/getMaterialVoucherDetail
 * @param req.body.itemId - 物品ID
 * @returns 材料凭证详情（含物品池）和玩家增量数据
 */
router.post("/getMaterialVoucherDetail", validateBody(getMaterialVoucherDetailSchema), async (req, res) => {
  const player = getPlayer();
  const { itemId } = req.body as VoucherItemDetailRequest;
  const relatedItems = voucherService.findRelatedItems(itemId, player.excel);
  const pool: MaterialVoucherPoolEntry[] = relatedItems.map((item, index) => ({
    itemId: item.itemId,
    itemType: item.itemType,
    itemNum: 1,
    groupId: "1",
    sortId: index + 1,
  }));
  res.send({
    info: {
      voucherId: itemId,
      pickNum: 1,
      startTime: -1,
      endTime: -1,
      picId: itemId,
      pool: pool,
    },
    ...player.delta,
  } satisfies VoucherItemDetailResponse);
});

/**
 * 使用干员抽卡凭证
 *
 * 消耗干员抽卡凭证（VOUCHER_CGACHA），执行干员获取操作。
 * 当前为简化实现：消耗凭证物品，返回增量数据。
 * 完整实现需要根据凭证关联的卡池执行抽卡逻辑并返回 GachaResult。
 * @route POST /depot/useCharGachaVoucher
 * @param req.body.itemId - 物品ID
 * @param (req.body as any).instId - 实例ID
 * @returns 结果状态和玩家增量数据
 */
router.post("/useCharGachaVoucher", validateBody(useCharGachaVoucherSchema), async (req, res) => {
  const player = getPlayer();
  const { itemId, instId } = req.body as UseCharGachaVoucherRequest;
  // 修复：原实现只扣凭证不发干员（凭证消耗但无结果——数据丢失）。
  // 有可发干员池（voucher.json itemList / voucherRelateList）时随机发一个；
  // 无池数据时不消耗凭证（避免白扣），保持可重试
  const voucherInfo = voucherService.getVoucher(itemId, player.excel);
  const pool =
    voucherInfo?.itemList?.filter((i) => i.type === "CHAR") ?? [];
  if (pool.length === 0) {
    logger.warn(
      "depot",
      `useCharGachaVoucher ${itemId} 无干员池数据，跳过消耗（防凭证白扣）`,
    );
    return res.send({ ...player.delta } satisfies UseCharGachaVoucherResponse);
  }
  // 修复（2026-09-09）：消耗前校验持有量（原实现实例缺失时消耗被跳过但仍发干员）
  if (!hasVoucherStock(player, itemId, instId, 1)) {
    logger.warn(
      "depot",
      `useCharGachaVoucher ${itemId}#${instId} 持有不足，拒绝发放`,
    );
    return res.send({ ...player.delta } satisfies UseCharGachaVoucherResponse);
  }
  // 消耗凭证物品（consumable 类型，需要 instId 定位具体实例）
  await player.gainItem
    .add({ id: itemId, count: 1, instId: Number(instId) })
    .use();
  // 发放随机干员（CHAR → char:get 入账）
  const chosen = randomChoice(pool);
  await player.gainItem.add(chosen).handle();
  res.send({
    ...player.delta,
  } satisfies UseCharGachaVoucherResponse);
});

/**
 * 使用材料凭证
 *
 * 消耗材料凭证（VOUCHER_MGACHA / MATERIAL_ISSUE_VOUCHER），
 * 从关联材料池中随机选取材料发放给玩家。
 * 材料池来源为 item_table 的 voucherRelateList 反向查找结果。
 * @route POST /depot/useMaterialVoucher
 * @param req.body.itemId - 物品ID
 * @param req.body.instId - 实例ID
 * @param req.body.count - 使用次数
 * @returns 获得物品列表和玩家增量数据
 */
router.post("/useMaterialVoucher", validateBody(useMaterialVoucherSchema), async (req, res) => {
  const player = getPlayer();
  const { itemId, instId, count } = req.body as UseMaterialVoucherRequest;
  const useCount = count ?? 1;
  // 修复（2026-09-09）：count 必须为正整数 —— 原实现 `count || 1` 直接透传负数，而
  // items:use 对负数走「反向入账」分支（inventory._useItem 的非 consumable 类型分支
  // emit items:get，count: -item.count），配合 canConsume 的 Math.abs 校验（凑够
  // abs(count) 即可通过）即可**凭空复制凭证**：持有 ≥5 张时传 count=-5 会净赚 5 张。
  if (!Number.isInteger(useCount) || useCount <= 0) {
    logger.warn(
      "depot",
      `useMaterialVoucher 非法 count=${count}（itemId=${itemId}），拒绝`,
    );
    return res.send({
      itemGet: [],
      ...player.delta,
    } satisfies UseMaterialVoucherResponse);
  }
  // 修复：材料池为空时不再消耗凭证（原实现先扣证后 findRelatedItems 可能为空 →
  // 凭证白扣无发放，数据丢失；与 useCharGachaVoucher 的防白扣守卫一致）
  const relatedItems = voucherService.findRelatedItems(itemId, player.excel);
  if (relatedItems.length === 0) {
    logger.warn(
      "depot",
      `useMaterialVoucher ${itemId} 无材料池数据，跳过消耗（防凭证白扣）`,
    );
    return res.send({
      itemGet: [],
      ...player.delta,
    } satisfies UseMaterialVoucherResponse);
  }
  // 修复（2026-09-09）：消耗前校验持有量（原实现实例缺失时消耗被跳过但仍发材料）
  if (!hasVoucherStock(player, itemId, instId, useCount)) {
    logger.warn(
      "depot",
      `useMaterialVoucher ${itemId}#${instId} 持有不足（需 ${useCount}），拒绝发放`,
    );
    return res.send({
      itemGet: [],
      ...player.delta,
    } satisfies UseMaterialVoucherResponse);
  }
  // 消耗凭证物品
  await player.gainItem
    .add({ id: itemId, count: useCount, instId: Number(instId) })
    .use();
  // 从关联材料池中随机选取材料
  const itemGet: ItemBundle[] = [];
  for (let i = 0; i < useCount; i++) {
    const chosen = randomChoice(relatedItems);
    itemGet.push({
      id: chosen.itemId,
      count: 1,
      type: chosen.itemType as ItemType,
    });
  }
  // 发放选中的材料到玩家背包
  for (const it of itemGet) player.gainItem.add(it);
  await player.gainItem.handle();
  // 注意：VOUCHER_MGACHA 类型（如 randomMaterial_10）的材料池数据
  // 未存储在 item_table 的 voucherRelateList 中，itemGet 可能为空。
  // 完整实现需要从额外数据源获取材料池定义。
  res.send({
    itemGet: itemGet,
    ...player.delta,
  } satisfies UseMaterialVoucherResponse);
});

/**
 * 使用满潜能物品
 *
 * 消耗满潜能道具（VOUCHER_FULL_POTENTIAL），将指定干员的潜能提升至满级。
 * 通过 CharManager.boostPotential 方法委托执行，目标潜能为角色最大潜能等级。
 * @route POST /depot/useFullPotentialItem
 * @param req.body.charInstId - 干员实例ID
 * @param req.body.itemId - 物品ID
 * @returns 结果状态和玩家增量数据
 */
router.post("/useFullPotentialItem", validateBody(useFullPotentialItemSchema), async (req, res) => {
  const player = getPlayer();
  const { charInstId, itemId } = req.body as BoostPotentialRequest;
  // 获取干员信息以计算最大潜能等级
  const char = player._playerdata.troop.chars[charInstId];
  // 修复：干员不存在/损坏存档不 500
  if (!char) {
    return res.send({ result: 1, ...player.delta } satisfies BoostPotentialResponse);
  }
  const charInfo = excel.charData(char.charId);
  // maxPotentialLevel 通常为 6（潜能等级 1-6），potentialRank 为 0-5
  const maxPotentialRank = (charInfo?.maxPotentialLevel ?? 5) - 1;
  // 委托 CharManager 执行潜能提升（内部包含物品消耗逻辑）
  await player.char.boostPotential({
    charInstId: charInstId,
    itemId: itemId,
    targetRank: maxPotentialRank,
  });
  // 修复：成功应为 result:0（原恒返回 1 → 客户端显示失败）
  res.send({
    result: 0,
    ...player.delta,
  } satisfies BoostPotentialResponse);
});

/**
 * 使用选项凭证
 *
 * 消耗选项凭证（OPTIONAL_VOUCHER_PICK / MATERIAL_ISSUE_VOUCHER），
 * 根据玩家选择的物品列表发放对应奖励。
 * @route POST /depot/useOptionVoucher
 * @param req.body.itemId - 物品ID
 * @param (req.body as any).instId - 实例ID
 * @param req.body.choices - 选择的物品列表
 * @param req.body.voucherCount - 凭证消耗数量
 * @returns 获得物品列表和玩家增量数据
 */
router.post("/useOptionVoucher", validateBody(useOptionVoucherSchema), async (req, res) => {
  const player = getPlayer();
  const { itemId, instId, choices, voucherCount } = req.body as UseOptionalVoucherRequest;
  const consumeCount = voucherCount || 1;
  // 修复：choices 为客户端直接传参——原实现不校验直接 items:get 发放任意物品
  //（可自选券刷任意道具/负数数量）；校验：数量为正整数，且（凭证可选列表可用时）
  // 每个选择项必须在凭证 itemList 内
  if (
    !Array.isArray(choices) ||
    choices.some(
      (c) =>
        !c ||
        typeof c.id !== "string" ||
        typeof c.count !== "number" ||
        !Number.isInteger(c.count) ||
        c.count <= 0,
    )
  ) {
    logger.warn("depot", `useOptionVoucher ${itemId} 非法 choices，拒绝发放`);
    return res.send({
      itemGet: [],
      ...player.delta,
    } satisfies UseOptionalVoucherResponse);
  }
  const voucherInfo = voucherService.getVoucher(itemId, player.excel);
  // 修复（2026-09-09）：凭证数据缺失时白名单校验整段被跳过 → 任意 itemId 均可发任意
  // 物品（含源石）。凭证必须存在于凭证表且带可选项列表，否则拒绝。
  if (!voucherInfo) {
    logger.warn("depot", `useOptionVoucher ${itemId} 不在凭证表，拒绝发放`);
    return res.send({
      itemGet: [],
      ...player.delta,
    } satisfies UseOptionalVoucherResponse);
  }
  const allowedIds = new Set((voucherInfo?.itemList ?? []).map((i) => i.id));
  if (allowedIds.size > 0) {
    const bad = choices.filter((c) => !allowedIds.has(c.id));
    if (bad.length > 0) {
      logger.warn("depot", `useOptionVoucher ${itemId} choices 含不在凭证列表的物品，拒绝发放`);
      return res.send({
        itemGet: [],
        ...player.delta,
      } satisfies UseOptionalVoucherResponse);
    }
  }
  // 修复（2026-09-09）：消耗前校验持有量——原实现凭证实例不存在时消耗被静默跳过但仍发放
  if (!hasVoucherStock(player, itemId, instId, consumeCount)) {
    logger.warn(
      "depot",
      `useOptionVoucher ${itemId}#${instId} 持有不足（需 ${consumeCount}），拒绝发放`,
    );
    return res.send({
      itemGet: [],
      ...player.delta,
    } satisfies UseOptionalVoucherResponse);
  }
  // 消耗凭证物品
  await player.gainItem
    .add({ id: itemId, count: consumeCount, instId: Number(instId) })
    .use();
  // 发放玩家选择的物品（itemGet 即客户端提交的 choices 原样回显，见 UseOptionalVoucherResponse）
  const itemGet = choices;
  for (const it of itemGet) player.gainItem.add(it);
  await player.gainItem.handle();
  res.send({
    itemGet: itemGet,
    ...player.delta,
  } satisfies UseOptionalVoucherResponse);
});

export default router;
