/**
 * 自动化桥请求契约（`/plugin/automation/*` 的驱动面）
 *
 * 注：客户端的 `poll` / `result` 两个端点是 GET + 路径编码（客户端只有 `SendGet` 可用），
 * 不需要 body 校验；这里只覆盖 **MCP/管理端** 用的 `POST /call`。
 */
import { z } from "zod";

/** 会话标识：与 `AutomationHub.isValidSessionId` 的口径保持一致（直接进 URL 路径） */
export const sessionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "会话标识只允许字母、数字、下划线与连字符");

/** 下发并等待一条自动化命令 */
export const automationCallSchema = z.object({
  /** 目标客户端会话（`automation_sessions` 工具可列出在线会话） */
  sid: sessionIdSchema,
  /** 命令名，如 `client.state` / `screenshot`（与 Lua 侧注册名一一对应） */
  name: z.string().min(1).max(64),
  /** 命令参数（原样透传给 Lua 处理器） */
  args: z.record(z.string(), z.json()).optional(),
  /** 超时毫秒（缺省 20s，上限 120s） */
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

/** `POST /call` 请求体 */
export type AutomationCallBody = z.infer<typeof automationCallSchema>;
