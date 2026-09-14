/**
 * 肉鸽V2模块（rlv2）统一导出
 *
 * 功能模块模块文件组织约定（见 AGENTS.md「文件命名」）：
 * - routes   路由处理（挂载于 /rlv2，见 app/game/routes.ts）
 * - logic    业务逻辑（RoguelikeV2Manager，含 8 子管理器 + 主题模块组合）
 * - trigger  事件订阅登记（订阅分散在子管理器构造期，见 rlv2-composition.ts）
 * - models   领域模型（协议请求/响应类型）
 * - rlv2.schema 请求体运行时校验（zod）
 */
export * from "./logic";
export * from "./trigger";
export * from "./models";
export * from "./rlv2.schema";
