/**
 * 自动化桥模块出口。
 *
 * 只导出会话中心与协议常量，供 `app/ops/automation/automation.routes.ts`（客户端 HTTP 面，组合根挂载于 /plugin/automation）
 * 与 `scripts/mcp-automation-server.ts`（MCP 面）共同使用。
 */
export {
  AutomationHub,
  automationHub,
  PROTOCOL_VERSION,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_COMMANDS_PER_POLL,
  type AutomationCommand,
  type AutomationPollResponse,
  type AutomationResult,
  type AutomationSessionSnapshot,
} from "./automation-hub";

/** JSON 值类型统一复用 core 的规范定义（不在本模块重复声明） */
export type { JsonValue } from "@core/utils/json-value";
