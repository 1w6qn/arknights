/**
 * 任务路由（mission 模块 handler）
 * 请求/响应类型见 ./models（参考 CS 2.7.61 协议类）
 */
import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { validateBody } from "@core/http/validate-body";
import {
  confirmMissionSchema,
  confirmMissionGroupSchema,
  autoConfirmMissionsSchema,
  exchangeMissionRewardsSchema,
  confirmMissionListSchema,
  confirmMultiGroupMissionListSchema,
} from "./schemas";
import { ItemBundle } from "@excel/excel";
import {
  AutoConfirmMissionsRequest,
  AutoConfirmMissionsResponse,
  ConfirmMissionGroupRequest,
  ConfirmMissionGroupResponse,
  ConfirmMissionRequest,
  ConfirmMissionResponse,
  ConfirmMissionListRequest,
  ConfirmMissionListResponse,
  ConfirmMultiGroupMissionListRequest,
  ConfirmMultiGroupMissionListResponse,
  ExchangeMissionRewardsRequest,
  ExchangeMissionRewardsResponse,
} from "./models";

const router = Router();

/** 确认单个任务（CS: ConfirmMissionRequest） */
router.post("/confirmMission", validateBody(confirmMissionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ConfirmMissionRequest;
  res.send({
    items: await player.mission.confirmMission(body),
    ...player.delta,
  } satisfies ConfirmMissionResponse);
});

/** 确认任务组（CS: ConfirmMissionGroupRequest） */
router.post("/confirmMissionGroup", validateBody(confirmMissionGroupSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ConfirmMissionGroupRequest;
  await player.mission.confirmMissionGroup(body);
  res.send(player.delta satisfies ConfirmMissionGroupResponse);
});

/** 自动确认任务（CS: AutoConfirmMissionsRequest） */
router.post("/autoConfirmMissions", validateBody(autoConfirmMissionsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AutoConfirmMissionsRequest;
  res.send({
    items: await player.mission.autoConfirmMissions(body),
    ...player.delta,
  } satisfies AutoConfirmMissionsResponse);
});

/** 兑换任务奖励（CS: ExchangeMissionRewardsRequest） */
router.post("/exchangeMissionRewards", validateBody(exchangeMissionRewardsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ExchangeMissionRewardsRequest;
  await player.mission.exchangeMissionRewards(body);
  res.send({ ...player.delta } satisfies ExchangeMissionRewardsResponse);
});

/** 批量确认任务（CS: ConfirmMissionListRequest { missionIds }；逐条领取聚合奖励） */
router.post("/confirmMissionList", validateBody(confirmMissionListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ConfirmMissionListRequest;
  const items: ItemBundle[] = [];
  for (const missionId of body.missionIds ?? []) {
    try {
      items.push(...(await player.mission.confirmMission({ missionId })));
    } catch {
      // 单条失败不中断整批（任务未达成等）
    }
  }
  res.send({
    items: player.mission.mergeItemBundles(items),
    ...player.delta,
  } satisfies ConfirmMissionListResponse);
});

/** 批量确认多任务组（客户端字段 missionGroupIds；逐组领取） */
router.post("/confirmMultiGroupMissionList", validateBody(confirmMultiGroupMissionListSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ConfirmMultiGroupMissionListRequest;
  const items: ItemBundle[] = [];
  // 官服抓包（R-1786877191677-0085）：客户端实际传 missionIds（任务 ID 列表）——
  // 原实现只读 missionGroupIds → 批量领取空转；两个字段都处理
  for (const missionId of body.missionIds ?? []) {
    try {
      items.push(...(await player.mission.confirmMission({ missionId })));
    } catch {
      // 单条失败不中断整批（任务未达成等）
    }
  }
  for (const missionGroupId of body.missionGroupIds ?? []) {
    try {
      await player.mission.confirmMissionGroup({ missionGroupId });
    } catch {
      // 单组失败不中断
    }
  }
  res.send({
    items: player.mission.mergeItemBundles(items),
    ...player.delta,
  } satisfies ConfirmMultiGroupMissionListResponse);
});

export default router;
