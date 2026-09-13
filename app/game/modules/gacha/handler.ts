/**
 * 抽卡路由模块
 * 
 * 处理抽卡和招募相关的 HTTP 请求，包括普通招募、高级抽卡、十连抽等功能。
 * 请求/响应类型见 @game/modules/gacha（参考 CS 2.7.61 协议类）。
 */

import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { GACHA_RULE_TYPE } from "./gacha";
import { setIn } from "@utils/json-path";
import { validateBody } from "@core/http/validate-body";
import {
  syncNormalGachaSchema,
  finishNormalGachaSchema,
  normalGachaSchema,
  boostNormalGachaSchema,
  cancelNormalGachaSchema,
  buyRecruitSlotSchema,
  refreshTagsSchema,
  getPoolDetailSchema,
  advancedGachaSchema,
  tenAdvancedGachaSchema,
  choosePoolUpSchema,
  getFreeCharSchema,
} from "./schemas";
import excel from "@excel/excel";
import type { ItemBundle } from "@excel/excel";
import {
  AdvancedGachaRequest,
  AdvancedGachaResponse,
  BoostNormalGachaRequest,
  BoostNormalGachaResponse,
  BuyRecruitSlotRequest,
  BuyRecruitSlotResponse,
  CancelNormalGachaRequest,
  CancelNormalGachaResponse,
  ChoosePoolUpRequest,
  ChoosePoolUpResponse,
  FinishNormalGachaRequest,
  FinishNormalGachaResponse,
  GetDetailGachaRequest,
  GetDetailGachaResponse,
  GetFreeCharRequest,
  GetFreeCharResponse,
  NormalGachaRequest,
  NormalGachaResponse,
  RefreshTagsGachaRequest,
  RefreshTagsGachaResponse,
  SyncNormalGachaRequest,
  SyncNormalGachaResponse,
  TenAdvancedGachaRequest,
  TenAdvancedGachaResponse,
} from "./models";

const router = Router();

/**
 * 同步普通招募状态
 * @route POST /gacha/syncNormalGacha
 * @returns 玩家增量数据
 */
router.post("/syncNormalGacha", validateBody(syncNormalGachaSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SyncNormalGachaRequest;
  await player.recruit.sync();
  res.send(player.delta satisfies SyncNormalGachaResponse);
});

/**
 * 完成普通招募
 * @route POST /gacha/finishNormalGacha
 * @param req.body - 招募参数
 * @returns 招募结果和玩家增量数据
 */
router.post("/finishNormalGacha", validateBody(finishNormalGachaSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as FinishNormalGachaRequest;
  res.send({
    // 修复：CS FinishNormalGachaResponse 要求 result: Int32——缺失时客户端提示异常
    result: 0,
    charGet: await player.recruit.finish(body),
    ...player.delta,
  } satisfies FinishNormalGachaResponse);
});

/**
 * 执行普通招募
 * @route POST /gacha/normalGacha
 * @param req.body - 招募参数
 * @returns 招募结果和玩家增量数据
 */
router.post("/normalGacha", validateBody(normalGachaSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as NormalGachaRequest;
  // 修复：缺 slotId/tagList/duration 必填参数时返回业务错误，而非 500
  if (
    typeof body?.slotId !== "number" ||
    !Array.isArray(body?.tagList) ||
    typeof body?.duration !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.recruit.normalGacha(body);
  // 参考 CS NormalGachaResponse（无 charGet 字段）与官方抓包：仅返回增量数据
  res.send(player.delta satisfies NormalGachaResponse);
});

/**
 * 加速普通招募
 * @route POST /gacha/boostNormalGacha
 * @param req.body - 加速参数
 * @returns 加速结果和玩家增量数据
 */
router.post("/boostNormalGacha", validateBody(boostNormalGachaSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BoostNormalGachaRequest;
  await player.recruit.boost(body);
  res.send({
    result: 0,
    ...player.delta,
  } satisfies BoostNormalGachaResponse);
});

/**
 * 取消普通招募
 * @route POST /gacha/cancelNormalGacha
 * @param req.body - 取消参数
 * @returns 玩家增量数据
 */
router.post("/cancelNormalGacha", validateBody(cancelNormalGachaSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CancelNormalGachaRequest;
  await player.recruit.cancel(body);
  // 修复：CS CancelNormalGachaResponse 要求 result: Int32——缺失时客户端提示异常
  res.send({
    result: 0,
    ...player.delta,
  } satisfies CancelNormalGachaResponse);
});

/**
 * 购买招募槽位
 * @route POST /gacha/buyRecruitSlot
 * @param req.body - 购买参数
 * @returns 玩家增量数据
 */
router.post("/buyRecruitSlot", validateBody(buyRecruitSlotSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BuyRecruitSlotRequest;
  await player.recruit.buyRecruitSlot(body);
  res.send(player.delta satisfies BuyRecruitSlotResponse);
});

/**
 * 刷新招募标签
 * @route POST /gacha/refreshTags
 * @param req.body - 刷新参数
 * @returns 玩家增量数据
 */
router.post("/refreshTags", validateBody(refreshTagsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RefreshTagsGachaRequest;
  await player.recruit.refreshTags(body);
  res.send(player.delta satisfies RefreshTagsGachaResponse);
});

/**
 * 获取抽卡池详情
 * @route POST /gacha/getPoolDetail
 * @param req.body - 抽卡池参数
 * @returns 抽卡池详情和玩家增量数据
 */
router.post("/getPoolDetail", validateBody(getPoolDetailSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetDetailGachaRequest;
  res.send({
    detailInfo: await player.modules.gacha.getPoolDetail(body),
    gachaObjGroupType: 0,
    ...player.delta,
  } satisfies GetDetailGachaResponse);
});

/**
 * 执行高级抽卡（单抽）
 * @route POST /gacha/advancedGacha
 * @param req.body - 抽卡参数
 * @returns 抽卡结果和玩家增量数据
 */
router.post("/advancedGacha", validateBody(advancedGachaSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AdvancedGachaRequest;
  res.send({
    result: 0,
    charGet: await player.modules.gacha.advancedGacha(body),
    ...player.delta,
  } satisfies AdvancedGachaResponse);
});

/**
 * 执行高级抽卡（十连）
 * @route POST /gacha/tenAdvancedGacha
 * @param req.body - 抽卡参数
 * @returns 十连抽卡结果列表和玩家增量数据
 */
router.post("/tenAdvancedGacha", validateBody(tenAdvancedGachaSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as TenAdvancedGachaRequest;
  res.send({
    result: 0,
    // CombineGachaItem（type 可选）与 ItemBundle 结构相容（后者可赋给前者），此处按管理器契约下钻，
    // 透传原始 item 对象（保留 passthrough 字段，如消耗品 instId）
    gachaResultList: await player.modules.gacha.tenAdvancedGacha({
      poolId: body.poolId,
      useTkt: body.useTkt,
      itemList: body.itemList as ItemBundle[],
    }),
    ...player.delta,
  } satisfies TenAdvancedGachaResponse);
});

/**
 * 选择高级抽卡 UP 角色
 * @route POST /gacha/choosePoolUp
 * @param req.body - { poolId, chooseChar }
 * @returns result 和玩家增量数据
 */
router.post("/choosePoolUp", validateBody(choosePoolUpSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChoosePoolUpRequest;
  const { poolId, chooseChar } = body;
  // 修复：缺 poolId/chooseChar 必填参数时返回业务错误，而非 500
  if (typeof poolId !== "string" || !chooseChar) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.update(async (draft) => {
    // 参考 OBS bp_gacha.gacha_choosePoolUp：gacha[gachaType][poolId].upChar = chooseChar
    const pool = excel.GachaTable.gachaPoolClient.find((p) => p.gachaPoolId === poolId);
    const gachaType = pool ? GACHA_RULE_TYPE[pool.gachaRuleType] ?? "single" : "single";
    // 修复：首次选择 UP 时 gacha / gacha[gachaType] / gacha[gachaType][poolId] 层级缺失，
    // 直接赋值会报 Cannot set properties of undefined(upChar)；须逐层初始化（与 AdminService.setPlayerPoolUp 一致）。
    // gacha 按规则类型动态建键（生成模型只列已知池类型）→ json-path 逐层补建后写入。
    setIn(draft.gacha, [gachaType, poolId, "upChar"], chooseChar);
  });
  res.send({ result: 0, ...player.delta } satisfies ChoosePoolUpResponse);
});

/**
 * 获取免费干员
 * @route POST /gacha/getFreeChar
 * @param req.body - 抽卡参数
 * @returns result 和玩家增量数据
 */
router.post("/getFreeChar", validateBody(getFreeCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetFreeCharRequest;
  // 修复（2026-09-09）：原实现为空桩（恒 result 0、不发干员）—— 限定寻访累计 300 抽的
  // 当期 UP 六星赠送永远拿不到。现由 GachaManager 按 gacha.limit[poolId].poolCnt 判定并发放。
  if (!body.poolId) return res.send({ result: 1, ...player.delta });
  const claimed = await player.gacha.claimLimitFreeChar({ poolId: body.poolId });
  if (!claimed) return res.send({ result: 1, ...player.delta });
  res.send({ result: 0, ...player.delta } satisfies GetFreeCharResponse);
});

/** 抽卡会话状态（客户端 POST /gacha 裸路径；返回空增量 stub） */
router.post("/", async (req, res) => {
  const player = getPlayer();
  res.send(player.delta satisfies { playerDataDelta: unknown });
});

export default router;
