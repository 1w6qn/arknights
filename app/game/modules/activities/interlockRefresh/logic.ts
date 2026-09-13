/**
 * 活动路由：interlockRefresh（由 router/activity.ts 拆分而来，实现未改动）
 *
 * 2026-09-13 清理：删除本文件末尾 148 行与 `../shared/shared` 重复且**无调用方**的
 * 私有副本（confirmOneActivityMission / autoConfirmActivityMissionsIn / collectRawBody /
 * arkhubFullHost / ItemTypeToString）及随之失效的 120+ 个协议类型 import。
 * 需要这些能力时统一从 `../shared/shared` 取（该处为活动族共享实现）。
 */
import {
  ActivityStubRequest,
  ActivityStubResponse,
} from "../shared/activity";
import { PlayerDataManager } from "../../../kernel/PlayerDataManager";

/**
 * interlockRefresh 活动族业务逻辑（建议 11：族包五件套——router 仅路由注册，业务收敛于 logic）
 *
 * 由 router.ts 内联 handler 提取（实现未改动）：每个活动接口一个具名函数，
 * 输入 player + 请求体，返回响应对象（原 res.send 载荷）。
 */

export async function handleInterlockrefreshSquad(player: PlayerDataManager, body: ActivityStubRequest) {
  return (player.delta satisfies ActivityStubResponse);
}
