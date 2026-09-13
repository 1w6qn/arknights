/**
 * 未校验 JSON 值类型（严格 JSON 域）——`@excel/json-value` 出口
 *
 * 规范定义已移到 `app/core/utils/json-value.ts`（core 的 I/O 工具同样需要这些类型，
 * 而架构守卫 R1 禁止 core → game 依赖）。本文件只做 re-export：
 * 生成类型的相对 import（`./json-value`）与业务代码的 `@excel/json-value` 全部不变。
 *
 * 语义与用法见 {@link import("@core/utils/json-value")}。
 */
export * from "@core/utils/json-value";
