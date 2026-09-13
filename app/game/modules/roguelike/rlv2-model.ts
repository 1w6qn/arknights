/**
 * 肉鸽V2 数据模型（**兼容垫片**）
 *
 * 2026-09-13：模型定义已上移 `@game/kernel/rlv2-model`——kernel 的事件契约
 * （`kernel/events/core.ts`、`kernel/events/rlv2.ts`）需要这些载荷类型，而 kernel
 * 不得反向依赖 modules（R2，见 tests/unit/architecture/module-boundary.test.ts）。
 *
 * 本文件仅为存量引用点（roguelike 内部 + 44 个测试 + ops/admin）保留原有 import 路径，
 * 内容全部 re-export；**新增代码请直接 import `@game/kernel/rlv2-model`**。
 */
export * from "../../kernel/rlv2-model";
