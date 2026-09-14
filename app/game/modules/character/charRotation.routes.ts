/**
 * 干员轮换路由模块
 * 
 * 处理干员轮换预设管理相关的 HTTP 请求，包括设置当前轮换、创建/删除/更新预设等功能。
 */

import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import {
  createPresetSchema,
  deletePresetSchema,
  setCurrentSchema,
  updatePresetSchema,
} from "./charRotation.schema";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import {
  CharRotationCreatePresetRequest,
  CharRotationCreatePresetResponse,
  CharRotationDeletePresetRequest,
  CharRotationDeletePresetResponse,
  CharRotationSetCurrentPresetRequest,
  CharRotationSetCurrentPresetResponse,
  CharRotationUpdatePresetRequest,
  CharRotationUpdatePresetResponse,
} from "./charRotation";

const router = Router();

/**
 * 设置当前轮换配置
 * @route POST /charRotation/setCurrent
 * @param req.body.instId - 预设实例ID
 * @returns 玩家增量数据和推送消息
 */
router.post("/setCurrent", validateBody(setCurrentSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CharRotationSetCurrentPresetRequest;
  await player.charRotation.setCurrent(body);
  res.send(player.delta satisfies CharRotationSetCurrentPresetResponse);
});

/**
 * 创建轮换预设
 * @route POST /charRotation/createPreset
 * @returns 玩家增量数据、推送消息和新建预设的实例ID（instId）
 *
 * 修复（2026-09-13，去重定案）：原实现丢弃 `createPreset()` 的返回值，
 * 响应缺 instId；而 CS `CharRotationCreatePresetResponse` 明确声明 `instId` 字段
 * （客户端 `_OnBtnCreatePresetClick` 回调据此选中新预设），
 * `CharRotationManager#createPreset` 亦有单测断言其返回 instId。
 */
router.post("/createPreset", validateBody(createPresetSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CharRotationCreatePresetRequest;
  res.send({
    instId: await player.charRotation.createPreset(),
    ...player.delta,
  } satisfies CharRotationCreatePresetResponse);
});

/**
 * 删除轮换预设
 * @route POST /charRotation/deletePreset
 * @param req.body.instId - 预设实例ID
 * @returns 玩家增量数据和推送消息
 */
router.post("/deletePreset", validateBody(deletePresetSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CharRotationDeletePresetRequest;
  await player.charRotation.deletePreset(body);
  res.send(player.delta satisfies CharRotationDeletePresetResponse);
});

/**
 * 更新轮换预设
 * @route POST /charRotation/updatePreset
 * @param req.body.instId - 预设实例ID
 * @param req.body.data - 更新数据
 * @returns 更新结果、玩家增量数据和推送消息
 */
router.post("/updatePreset", validateBody(updatePresetSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CharRotationUpdatePresetRequest;
  await player.charRotation.updatePreset(body);
  res.send(player.delta satisfies CharRotationUpdatePresetResponse);
});

export default router;