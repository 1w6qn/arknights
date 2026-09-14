/**
 * 任务（mission）请求 zod schema
 *
 * 对应 protocol/mission.ts 的 Request 类型（参考 CS 2.7.61 协议类），
 * 供 router/mission.ts 经 validateBody 做运行时校验：缺失必填字段 /
 * 类型不符时返回 HTTP 4xx，避免非法 body 传入控制器抛 500。
 */
import { z } from "zod";

/** 确认单个任务请求（CS: ConfirmMissionRequest { missionId }） */
export const confirmMissionSchema = z.object({
  missionId: z.string(),
});

/** 确认任务组请求（CS: ConfirmMissionGroupRequest { missionGroupId }） */
export const confirmMissionGroupSchema = z.object({
  missionGroupId: z.string(),
});

/** 自动确认任务请求（CS: AutoConfirmMissionsRequest { type }） */
export const autoConfirmMissionsSchema = z.object({
  type: z.string(),
});

/** 兑换任务奖励请求（CS: ExchangeMissionRewardsRequest { targetRewardsId }） */
export const exchangeMissionRewardsSchema = z.object({
  targetRewardsId: z.string(),
});

/** 批量确认任务请求（CS: ConfirmMissionListRequest { missionIds }） */
export const confirmMissionListSchema = z.object({
  missionIds: z.array(z.string()),
});

/**
 * 批量确认多任务组请求（CS 无直接对应类；官服抓包客户端传 missionIds，
 * 兼容 missionGroupIds——两者均为可选）
 */
export const confirmMultiGroupMissionListSchema = z.object({
  missionIds: z.array(z.string()).optional(),
  missionGroupIds: z.array(z.string()).optional(),
});