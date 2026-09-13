/**
 * arkhub（奇象巡展 / ARK_HUB）活动模块 public 出口
 *
 * 模块外（`app/server.ts`、`app/ops/**`、`scripts/**`、`tests/**`）只经此文件消费；
 * 子路径 import 由 `tests/unit/architecture/module-boundary.test.ts` 的 R6 守卫拦截。
 *
 * 门面分组（与目录分层一一对应）：
 *   domain  —— 玩法域（状态/计数器/事件、ARKDEX 寻迹、像素存储、像素格式）
 *   session —— 长连接会话协议栈（帧常量 → 线级编解码 → 契约 → 分发 → TCP 传输）
 *   capture —— capture 模式官服网关适配（30000 转发器 + 抓包帧解析）
 */
// ---------- domain：玩法域（HTTP 与网关共用） ----------
export * from "./domain/state";
export * from "./domain/dex";
export * from "./domain/pixel";
export * from "./domain/pixel-format";

// ---------- session：长连接会话协议栈 ----------
export * from "./session/messages";
export * from "./session/codec";
export * from "./session/contract";
export * from "./session/dispatch";
export * from "./session/server";
export * from "./session/bindings";

// ---------- capture：capture 模式官服网关适配 ----------
export * from "./capture/proxy";
export * from "./capture/protocol";
