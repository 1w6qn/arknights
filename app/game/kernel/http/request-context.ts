/**
 * 玩家请求上下文（Player Request Context）
 *
 * 将 router 对玩家管理器的访问从「散落在每个 router 里的
 * `httpContext.get<PlayerDataManager>("playerData")`」收敛为单一、类型化入口，
 * 消除魔数字符串与对具体实现类的强 cast（集中到此处）。
 *
 * 目的：router 层只依赖 `PlayerFacade` 门面与 `getPlayer()` 助手，
 * 后续若需将门面下沉为接口或替换上下文存储，仅需改本文件一处。
 */
import httpContext from "express-http-context2";
import type { PlayerDataManager } from "../player-data-manager";

/** 上下文存储键（魔数字符串收拢于此） */
const PLAYER_KEY = "playerData";

/**
 * 门面门面类型
 *
 * 当前原样映射到 PlayerDataManager（组合根）。接口化受限：router 层仍有直接访问
 * `player._trigger.emit(...)`（其他领域事件）与 `player._playerdata.*`（读快照）的
 * 既有调用点，显式接口会破坏这些调用点。注意：物品增减**不再**属于合法直发——
 * items:get/items:use 已全部收敛到 player.gainItem 管道（棘轮守卫见
 * tests/unit/architecture/inventory-pipeline-ratchet.test.ts）。子模块访问已收敛为
 * `player.modules.xxx`（见 PlayerDataManager.modules 聚合），新代码优先经此访问。
 */
export type PlayerFacade = PlayerDataManager;

/**
 * 写入当前请求的玩家门面
 * @param player - 玩家数据管理器实例（由认证/拉取阶段显式注入）
 */
export function setPlayer(player: PlayerDataManager): void {
  httpContext.set(PLAYER_KEY, player);
}

/**
 * 读取当前请求的玩家门面（认证中间件保证存在）
 * @returns 当前请求的玩家门面
 */
export function getPlayer(): PlayerFacade {
  return httpContext.get<PlayerFacade>(PLAYER_KEY)!;
}

/**
 * 读取当前请求的玩家门面（可空版本，供需要显式判空的场景）
 * @returns 当前请求的玩家门面，未注入时为 undefined
 */
export function getPlayerOptional(): PlayerFacade | undefined {
  return httpContext.get<PlayerFacade>(PLAYER_KEY);
}