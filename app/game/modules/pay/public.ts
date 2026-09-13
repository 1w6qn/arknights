/**
 * pay 模块对外出口（public.ts）
 *
 * 跨模块引用约定（AGENTS.md「落位规则」）：模块间只允许 import 对方 public.ts 或走事件总线。
 * 本文件是 `kernel/util/purchase-record` 的 pay 侧门面——activities/milestone 等需要记录
 * 「活动礼包购买」时经此引用，避免直接触达模块内部文件（守卫 R3，见
 * tests/unit/architecture/module-boundary.test.ts）。实现已于 2026-09-13 上移 kernel：
 * crisis/shop 两处跨模块消费改直连 kernel，本文件保留供模块门面语义使用。
 */
export { recordPurchase } from "../../kernel/util/purchase-record";
