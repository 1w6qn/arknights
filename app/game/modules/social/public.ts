/**
 * social 模块对外出口（public.ts）
 *
 * 跨模块引用约定（AGENTS.md「落位规则」）：模块间只允许 import 对方 public.ts 或走事件总线。
 *
 * `SocialService`（好友/申请/访问的 social.db 存储服务）被 account 模块的
 * `AccountManager` 持有并委托——此前直连模块内部文件 `../social/SocialService`，
 * 命中守卫 R3（tests/unit/architecture/module-boundary.test.ts）。2026-09-13 增设本门面，
 * 跨模块消费统一经此引用。
 *
 * 注：好友/名片数据形状（`FriendDataWithNameCard` 等）已上移 `@game/kernel/social-model`，
 * 跨模块**类型**引用不再需要本门面。
 */
export { SocialService } from "./SocialService";
