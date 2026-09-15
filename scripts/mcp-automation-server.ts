#!/usr/bin/env node
/**
 * MCP 自动化服务器（stdio）
 *
 * 把游戏内的 Lua 自动化桥包装成一组 MCP 工具，让外部 Agent 能真实操作客户端并读回结果，
 * 用于私服的端到端验证（e2e）：
 *
 *     Agent ──MCP(stdio)──▶ 本进程 ──HTTP──▶ 私服 /plugin/automation/*
 *                                                      ▲ 轮询取命令 / 分片回传结果
 *                                                      │
 *                                            游戏内 Lua 自动化桥
 *
 * 用法：
 *   pnpm run mcp:automation                      # 作为 MCP server 跑在 stdio 上
 *   pnpm run mcp:automation -- --list-tools      # 打印工具清单（自检，不进 MCP 模式）
 *   pnpm run mcp:automation -- --call game_state # 直接调一次工具（不接 MCP 客户端，便于 e2e）
 *
 * 环境变量：
 *   DTS_SERVER_URL       私服基址（缺省 http://127.0.0.1:8443）
 *   DTS_AUTOMATION_SID   默认会话 id（多设备时免去每次传 sid）
 *
 * ★ stdio 传输纪律：stdout 是协议通道，**任何诊断信息都必须走 stderr**（console.error），
 *   否则会污染 JSON-RPC 流把客户端打挂。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JsonValue } from "@core/utils/json-value";
import { AutomationClient } from "./lib/automation-client";
import {
  AUTOMATION_TOOL_SPECS,
  buildInputSchema,
  executeTool,
  type AutomationToolSpec,
} from "./lib/automation-tools";

/** MCP server 标识 */
const SERVER_NAME = "doctorate-ts-automation";
/** 与工具表结构变更同步递增 */
const SERVER_VERSION = "1.0.0";

/** 默认私服基址（与 `data/config.json` 的 server 端口一致） */
const DEFAULT_BASE_URL = "http://127.0.0.1:8443";

/** 给 MCP 客户端的总说明：把「这套工具怎么用」讲清楚，减少 Agent 试错 */
const SERVER_INSTRUCTIONS = [
  "本服务器驱动一台**真实运行中的明日方舟客户端**（经私服中转），用于端到端验证。",
  "",
  "★ 验证原则：**优先用函数调用拿结构化事实，把截图当最后手段**。",
  "可结构化读取的事实（在哪一屏、在不在战斗、面板开着没、文本对不对、插件启停、服务端端点返回什么）",
  "一律用函数调用确认——它们精确、便宜、可复现；截图要缩放+JPEG+分片回传（几十个请求）且只能靠人看图，",
  "还占大量上下文。只有在**程序读不到的视觉事实**（渲染有没有出来、布局错位、贴图/像素级现象）上才截图。",
  "",
  "典型流程：① game_ping / game_state 确认在线与当前界面；② ui_find / ui_find_text 定位控件；",
  "③ ui_click / ui_tap 操作；④ ui_check 一次性断言多项结果（替代截图看着确认）；",
  "⑤ 需要以客户端身份验证服务端时用 client_http_get；⑥ 最后才考虑 game_screenshot。",
  "",
  "注意：命令在客户端**串行**执行，单条默认 20s 超时；超时通常是客户端掉线或当前界面没有目标对象。",
  "多设备时用 automation_sessions 选 sid，或设 DTS_AUTOMATION_SID。",
].join("\n");

/**
 * 建好带全部工具的 MCP server。
 * @param client - 私服客户端
 * @returns 未连接的 McpServer
 */
export function createAutomationServer(client: AutomationClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const spec of AUTOMATION_TOOL_SPECS) {
    registerSpec(server, client, spec);
  }
  return server;
}

/**
 * 注册单个工具（工具表是运行时数据，这里做类型收敛）。
 * @param server - MCP server
 * @param client - 私服客户端
 * @param spec - 工具定义
 */
function registerSpec(server: McpServer, client: AutomationClient, spec: AutomationToolSpec): void {
  server.registerTool(
    spec.tool,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: buildInputSchema(spec),
      annotations: spec.annotations,
    },
    async (args) => executeTool(client, spec, args as Record<string, JsonValue | undefined>),
  );
}

/**
 * 打印工具清单（`--list-tools` 自检用；此时不在 MCP 模式，stdout 可自由使用）。
 * @param specs - 工具表
 */
function printTools(specs: readonly AutomationToolSpec[]): void {
  for (const spec of specs) {
    const params = Object.keys(buildInputSchema(spec)).join(", ") || "（无参数）";
    process.stdout.write(`${spec.tool.padEnd(22)} → ${spec.command || "（服务端本地）"}\n`);
    process.stdout.write(`  ${spec.title}｜参数: ${params}\n`);
  }
  process.stdout.write(`共 ${specs.length} 个工具\n`);
}

/**
 * 解析命令行参数（只认少数几个，避免引第三方 CLI 依赖）。
 * @param argv - process.argv.slice(2)
 * @returns 解析结果
 */
function parseArgs(argv: string[]): { baseUrl: string; listTools: boolean; call: string | null; callArgs: string } {
  let baseUrl = process.env.DTS_SERVER_URL ?? DEFAULT_BASE_URL;
  let listTools = false;
  let call: string | null = null;
  let callArgs = "{}";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list-tools") {
      listTools = true;
    } else if (arg === "--base-url" && argv[i + 1] !== undefined) {
      baseUrl = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--call" && argv[i + 1] !== undefined) {
      call = argv[i + 1];
      i += 1;
    } else if (arg === "--args" && argv[i + 1] !== undefined) {
      callArgs = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "用法: tsx scripts/mcp-automation-server.ts [选项]",
          "  --list-tools        打印工具清单并退出",
          "  --call <tool>       直接调用一次工具（非 MCP 模式），结果打到 stdout",
          "  --args <json>       配合 --call 传参数，如 '{\"stage_id\":\"main_01-07\"}'",
          "  --base-url <url>    私服基址，缺省 DTS_SERVER_URL 或 http://127.0.0.1:8443",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return { baseUrl, listTools, call, callArgs };
}

/**
 * 入口。
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = new AutomationClient({ baseUrl: options.baseUrl });

  if (options.listTools) {
    printTools(AUTOMATION_TOOL_SPECS);
    return;
  }

  if (options.call !== null) {
    const spec = AUTOMATION_TOOL_SPECS.find((item) => item.tool === options.call);
    if (spec === undefined) {
      process.stderr.write(`未知工具: ${options.call}（用 --list-tools 看清单）\n`);
      process.exitCode = 2;
      return;
    }
    let parsed: Record<string, JsonValue | undefined>;
    try {
      parsed = JSON.parse(options.callArgs) as Record<string, JsonValue | undefined>;
    } catch (error) {
      process.stderr.write(
        `--args 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
      return;
    }
    const result = await executeTool(client, spec, parsed);
    for (const block of result.content) {
      if (block.type === "text") {
        process.stdout.write(`${block.text}\n`);
      } else if (block.type === "image") {
        // 图片块在 CLI 模式下不做解码渲染，只报体积（避免把二进制糊到终端）
        process.stdout.write(`[image ${block.mimeType} ${block.data.length} chars base64]\n`);
      } else {
        process.stdout.write(`[${block.type} 内容块]\n`);
      }
    }
    if (result.isError === true) {
      process.exitCode = 1;
    }
    return;
  }

  const server = createAutomationServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[${SERVER_NAME}] 已连接 stdio；私服 ${options.baseUrl}；工具 ${AUTOMATION_TOOL_SPECS.length} 个\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `[mcp-automation] 启动失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
