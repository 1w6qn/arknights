/**
 * account 模块对外出口（public.ts）
 *
 * 跨模块引用约定（AGENTS.md「落位规则」）：模块间只允许 import 对方 public.ts 或走事件总线。
 * 本文件为账号/社交存储单例的门面——activities/bossRush 等读取玩家账号数据时经此引用。
 */
export { accountManager } from "./account-manager";
