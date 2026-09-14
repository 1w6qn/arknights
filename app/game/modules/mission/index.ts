/**
 * 任务模块（mission）统一导出
 *
 * 功能模块模块文件组织约定（见 AGENTS.md「文件命名」）：
 * - routes   路由处理（挂载于 /mission，见 app/game/routes.ts）
 * - logic    业务逻辑（MissionManager）
 * - trigger  事件订阅登记
 * - models   领域模型（协议请求/响应类型 + 事件映射）
 * - mission.schema 请求体运行时校验（zod）
 */
export * from "./logic";
export * from "./trigger";
export * from "./models";
export * from "./mission.schema";
