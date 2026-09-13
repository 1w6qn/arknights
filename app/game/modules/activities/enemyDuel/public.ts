/**
 * 怪猎对决（enemyDuel）对外出口
 *
 * 模块外只经此文件消费（见 AGENTS「模块间只允许 import 对方 public.ts」）。
 * 目前唯一出口是实时会话服：`app/server.ts` 私服模式启动它，HTTP 路由回报其地址。
 */
export {
  startEnemyDuelSessionServer,
  getEnemyDuelSessionPort,
  getEnemyDuelSessionAddress,
  isEnemyDuelSessionActive,
  resetEnemyDuelSessionState,
} from "./session/server";
export type { EnemyDuelSessionServerOptions } from "./session/server";
