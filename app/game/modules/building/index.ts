/**
 * 基建模块（building）统一导出
 *
 * 功能模块模块文件组织约定（见 AGENTS.md「文件命名」）：
 * - routes   路由处理（挂载于 /building，见 app/game/routes.ts）
 * - logic    业务逻辑（BuildingManager）
 * - trigger  事件订阅登记（refresh:daily / char:init 在构造器内联订阅，占位）
 * - models   领域模型（协议请求/响应类型）
 * - building.schema 请求体运行时校验（zod）
 */
export * from "./logic";
export * from "./trigger";
export * from "./models";
export * from "./building.schema";
