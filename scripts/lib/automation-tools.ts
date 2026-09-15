/**
 * MCP 自动化工具表（纯数据 + 渲染）
 *
 * 每个工具 = 「一条游戏内 Lua 命令」+「面向 Agent 的描述」+「结果渲染方式」。
 * 之所以把工具表独立成模块：
 *   - `scripts/mcp-automation-server.ts` 只做协议接线（McpServer/stdio），不夹带业务表；
 *   - 工具名 ↔ 命令名的映射可以被单测直接校验（防止改了 Lua 命令名而工具表没跟上）。
 *
 * 命令名与 `lua/plugin/plugins/AutomationPlugin.lua` 的 `handlers[...]` 一一对应。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isJsonObject, type JsonValue } from "@core/utils/json-value";
import type { AutomationCallResponse, AutomationClient } from "./automation-client";

/** 工具注解（与 MCP 的 ToolAnnotations 结构一致） */
export interface AutomationToolAnnotations {
  /** 只读：不改变游戏状态 */
  readOnlyHint?: boolean;
  /** 有破坏性：可能改变存档/场景/战斗状态 */
  destructiveHint?: boolean;
  /** 幂等：重复调用结果一致 */
  idempotentHint?: boolean;
  /** 与外部世界交互（真机/网络） */
  openWorldHint?: boolean;
}

/** 单个工具定义 */
export interface AutomationToolSpec {
  /** MCP 工具名（snake_case，Agent 直接看到的名字） */
  tool: string;
  /** 游戏内命令名（`域.动作`） */
  command: string;
  /** 一句话标题 */
  title: string;
  /** 给 Agent 的说明（写清「什么时候用」「参数怎么填」） */
  description: string;
  /** 除公共 `sid` 外的参数 schema */
  schema: Record<string, z.ZodType>;
  /** 注解 */
  annotations: AutomationToolAnnotations;
  /** 结果渲染方式：json = 序列化；image = 走 MCP image content */
  render: "json" | "image";
  /** 单次调用超时（毫秒，缺省 20s） */
  timeoutMs?: number;
}

/** MCP 工具返回（直接用 SDK 的 CallToolResult，避免自造结构在索引签名上不兼容） */
export type AutomationToolResult = CallToolResult;

/** 公共参数：目标会话 */
const sidParam = z
  .string()
  .min(1)
  .optional()
  .describe("目标客户端会话 id；缺省时用 DTS_AUTOMATION_SID，或自动选中唯一在线会话");

/**
 * 组装某个工具的完整入参 schema（公共 `sid` + 工具自有参数）。
 *
 * `automation_sessions` 是服务端本地工具（不经过客户端），因此没有 sid。
 * @param spec - 工具定义
 * @returns zod raw shape
 */
export function buildInputSchema(spec: AutomationToolSpec): Record<string, z.ZodType> {
  if (spec.command === "") {
    return { ...spec.schema };
  }
  return { sid: sidParam, ...spec.schema };
}

/**
 * 工具总表。
 *
 * 顺序即 `tools/list` 的展示顺序，按「先看状态 → 再做操作」编排，方便 Agent 顺着读。
 *
 * 先声明成 `AutomationToolSpec[]` 再 freeze：直接 `Object.freeze([...])` 会让 TS 把各元素
 * 的 `schema` 推断成「所有字面量的联合」（缺失键变成 `undefined`），从而过不了
 * `Record<string, z.ZodType>` 校验。
 */
const TOOL_SPECS: AutomationToolSpec[] = [
  {
    tool: "game_ping",
    command: "client.ping",
    title: "连通性探测",
    description: "确认自动化桥在线并拿到会话 id（排查「命令超时」时先跑它）。",
    schema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "game_hello",
    command: "client.hello",
    title: "桥能力自述",
    description: "返回客户端版本、平台、场景、已注册的全部命令名与桥配置（判断某个工具是否可用）。",
    schema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "game_state",
    command: "client.state",
    title: "客户端状态总览",
    description:
      "返回当前场景、已激活的 UIPage、战斗状态、玩家存档摘要（等级/理智/龙门币/主线进度）与插件启停/报错。**断言首选**：能用它确认的事实（在哪一屏、在不在战斗、数值对不对）就别截图。",
    schema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "game_logs",
    command: "client.logs",
    title: "客户端日志尾",
    description: "读自动化桥的环形日志缓冲（最近若干条）+ 插件加载错误。排查「插件没生效」时用它。",
    schema: { limit: z.number().int().min(1).max(200).optional().describe("条数上限，缺省 50") },
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "plugin_list",
    command: "plugin.list",
    title: "插件清单与启停态",
    description: "列出全部插件的 id/名称/启停/加载错误。",
    schema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "plugin_set_enabled",
    command: "plugin.set_enabled",
    title: "启停插件",
    description:
      "在客户端内启用/停用某个插件（等价于点游戏内插件面板的开关）。注意：最后一个「游戏内 UI 入口」面板（plugin_panel / options_panel）不允许被关闭——关闭后游戏内再无入口，会被入口守卫拒绝并回报 applied=false。",
    schema: {
      id: z.string().min(1).describe("插件 id，如 enemy_hp / automation_bridge"),
      enabled: z.boolean().describe("true 启用，false 停用"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "plugin_set_option",
    command: "plugin.set_option",
    title: "修改插件选项",
    description: "写入插件选项取值（会做类型归一化并同步回服务端配置）。",
    schema: {
      id: z.string().min(1).describe("插件 id"),
      key: z.string().min(1).describe("选项键，如 font_size"),
      value: z
        .union([z.boolean(), z.number(), z.string()])
        .describe("取值（布尔/数值/字符串，按选项定义归一化）"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "plugin_reload",
    command: "plugin.reload",
    title: "重载插件",
    description: "先停后启某个插件，走完整 OnUnload/OnLoad（用于验证释放路径是否干净）。",
    schema: { id: z.string().min(1).describe("插件 id") },
    annotations: { destructiveHint: true },
    render: "json",
  },
  {
    tool: "client_http_get",
    command: "http.get",
    title: "客户端侧 GET 探针",
    description:
      "用**客户端自己的网络栈**（UISender）请求私服端点并回传响应体。这是端到端验证的核心手段：验证的是游戏真实走的那条链路，而不是外部 curl。",
    schema: {
      url: z.string().min(1).describe("路径，如 /config/prod/official/network_config"),
      param: z.string().optional().describe("查询串（可选，会拼成 url?param）"),
      max_bytes: z.number().int().min(256).max(200000).optional().describe("响应体保留上限，缺省 8192"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    render: "json",
  },
  {
    tool: "client_http_post",
    command: "http.post",
    title: "客户端侧 POST 探针",
    description: "用客户端网络栈发 POST（SendRequest + overrideUrl）。部分版本的 service code 门禁可能拒绝，失败时改用 client_http_get。",
    schema: {
      url: z.string().min(1).describe("完整路径"),
      body: z.record(z.string(), z.json()).optional().describe("JSON 请求体"),
      service_code: z.string().optional().describe("服务码（缺省 dts.automation）"),
      max_bytes: z.number().int().min(256).max(200000).optional().describe("响应体保留上限，缺省 8192"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    render: "json",
  },
  {
    tool: "ui_find",
    command: "ui.find",
    title: "查找 UI 对象",
    description:
      "按路径或名字找界面对象，返回路径/激活态/屏幕坐标/尺寸/文本/可用组件。**函数断言主力**：`activeInHierarchy=false` 就代表对象存在但被隐藏（面板已关闭），无需截图确认。",
    schema: {
      path: z.string().optional().describe("层级路径，如 UI/Main/LuaUIRoot/Panel（含未激活对象的逐段解析）"),
      name: z.string().optional().describe("对象名（含匹配，除非 exact=true）"),
      exact: z.boolean().optional().describe("name 是否精确匹配"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "ui_dump",
    command: "ui.dump",
    title: "导出界面层级",
    description:
      "把界面渲染成缩进文本树（含文本内容与 [inactive] 标记）。**只用于探索不熟悉的界面**——已知目标请用 ui_find/ui_check（dump 输出大且占上下文）；务必用 path/name 收窄子树并限制 depth。",
    schema: {
      path: z.string().optional().describe("子树根路径"),
      name: z.string().optional().describe("子树根对象名"),
      depth: z.number().int().min(1).max(12).optional().describe("递归深度，缺省 4"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "ui_find_text",
    command: "ui.find_text",
    title: "按文本查找控件",
    description:
      "在全部文本控件里按内容查找，返回对象路径。比硬编码层级路径更能扛版本改动，也比截图更能定位到具体对象。",
    schema: {
      text: z.string().min(1).describe("目标文本，如 开始行动"),
      contains: z.boolean().optional().describe("是否包含匹配（缺省 true）"),
      limit: z.number().int().min(1).max(50).optional().describe("返回条数上限，缺省 8"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "ui_check",
    command: "ui.check",
    title: "批量断言界面事实",
    description:
      "一次判定 N 项界面事实并逐项给出原因（对象在不在 / 是否激活 / 文本对不对）。" +
      "**验证界面状态的首选**：把「面板开了吗、标题对不对、按钮在不在」写成一组断言，一次往返拿结论，" +
      "而不是截图回来人眼看。也支持 expect_exists=false（要求对象不存在）与 expect_active=false（要求已隐藏）。",
    schema: {
      items: z
        .array(
          z.object({
            path: z.string().optional().describe("层级路径（含未激活对象的逐段解析）"),
            name: z.string().optional().describe("对象名（含匹配，除非 exact=true）"),
            exact: z.boolean().optional().describe("name 是否精确匹配"),
            expect_exists: z.boolean().optional().describe("期望对象存在（false = 期望不存在）"),
            expect_active: z.boolean().optional().describe("期望对象处于激活态（false = 期望已隐藏）"),
            expect_text: z.string().optional().describe("期望 UGUI 文本精确等于该值"),
            expect_text_contains: z.string().optional().describe("期望 UGUI 文本包含该子串"),
          }),
        )
        .min(1)
        .max(50)
        .describe("断言数组；每项按 path 或 name 定位"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "ui_click",
    command: "ui.click",
    title: "点击 UI 控件",
    description:
      "点击一个控件：按 path / text / name 任一方式定位。内部会自动向上找父节点上的 Button/Toggle 再触发，并回报实际用的触发方式。",
    schema: {
      path: z.string().optional().describe("层级路径"),
      text: z.string().optional().describe("按文本定位（含匹配）"),
      name: z.string().optional().describe("按对象名定位"),
      exact: z.boolean().optional().describe("name 是否精确匹配"),
      plain: z.boolean().optional().describe("跳过 Button 查找，直接派发 pointerClick"),
    },
    annotations: { destructiveHint: true },
    render: "json",
  },
  {
    tool: "ui_tap",
    command: "ui.tap",
    title: "屏幕坐标点击",
    description: "在屏幕像素坐标处模拟一次点击（射线命中栈顶对象）。用于自绘 UI 或没有 Button 组件的格子。",
    schema: {
      x: z.number().describe("屏幕 x（像素）"),
      y: z.number().describe("屏幕 y（像素）"),
    },
    annotations: { destructiveHint: true },
    render: "json",
  },
  {
    tool: "ui_set",
    command: "ui.set",
    title: "写 UI 控件值",
    description: "按语义写控件：Toggle 开关 / InputField 文本 / Slider 数值 / GameObject 激活态。kind 缺省 auto（先按控件语义，最后才退到 SetActive）。",
    schema: {
      path: z.string().optional().describe("层级路径"),
      name: z.string().optional().describe("对象名"),
      kind: z.enum(["auto", "toggle", "input", "slider", "active"]).optional().describe("写值方式"),
      value: z.union([z.boolean(), z.number(), z.string()]).describe("目标值"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "stage_enter",
    command: "stage.enter",
    title: "进入关卡",
    description:
      "在当前界面找到名字含 stage_id 的格子并点击，等待后按文本点击开始按钮（best-effort；返回每步实际点到的对象与触发方式）。",
    schema: {
      stage_id: z.string().min(1).describe("关卡 id，如 main_01-07"),
      start_text: z.string().optional().describe("开始按钮文本，缺省 开始行动"),
      auto_start: z.boolean().optional().describe("是否自动点开始（false 只选关）"),
      step_delay_ms: z.number().int().min(100).max(10000).optional().describe("选关到点开始之间的等待，缺省 800ms"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
    render: "json",
    timeoutMs: 30000,
  },
  {
    tool: "scene_current",
    command: "scene.current",
    title: "当前界面",
    description: "返回当前场景名与已激活的 UIPage 列表。",
    schema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "scene_list",
    command: "scene.list",
    title: "可用场景清单",
    description: "列出构建配置里的全部场景名（scene_load 的合法入参）。",
    schema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "scene_load",
    command: "scene.load",
    title: "加载场景",
    description:
      "直接 LoadScene 跳场景。绕过游戏正常流程，可能让 UI 处于不一致状态——优先用 ui_click/ui_tap 走正常路径。",
    schema: { name: z.string().min(1).describe("场景名（先用 scene_list 查）") },
    annotations: { destructiveHint: true, openWorldHint: true },
    render: "json",
    timeoutMs: 60000,
  },
  {
    tool: "battle_info",
    command: "battle.info",
    title: "战斗状态",
    description: "返回是否在战斗中、倍速档位、暂停状态与战斗时间。",
    schema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "battle_control",
    command: "battle.control",
    title: "战斗驱动",
    description: "暂停/继续/切换倍速/单帧步进（TAS）。不在战斗中会报错。",
    schema: {
      action: z.enum(["pause", "resume", "speed", "step"]).describe("动作"),
      level: z.enum(["SLOW_MOTION", "STANDARD", "FAST", "SUPER_FAST"]).optional().describe("action=speed 时的档位，缺省 SUPER_FAST"),
    },
    annotations: { destructiveHint: true },
    render: "json",
  },
  {
    tool: "game_screenshot",
    command: "screenshot",
    title: "截屏（最后手段）",
    description:
      "截取当前画面并作为图片返回。**只在程序读不到该事实时才用**（渲染/布局/贴图/像素级现象，例如「UI 到底有没有画出来」）。" +
      "一次调用要缩放 + JPEG 压缩 + 分片回传（几十个请求），返回的图片还占大量上下文；" +
      "能确认同一件事请优先用 game_state（在哪一屏/什么状态）、ui_find / ui_check（对象在不在、是否隐藏、文本对不对）、" +
      "ui_find_text（按文本定位）、client_http_get（以客户端身份验证服务端端点）、game_logs（客户端日志）。",
    schema: {
      width: z.number().int().min(160).max(1280).optional().describe("缩放宽度，缺省取插件选项（480）"),
      quality: z.number().int().min(20).max(95).optional().describe("JPEG 质量，缺省取插件选项（60）"),
      format: z.enum(["jpeg", "png"]).optional().describe("缺省 jpeg（png 体积大、回传慢）"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    render: "image",
    timeoutMs: 60000,
  },
  {
    tool: "client_eval",
    command: "client.eval",
    title: "执行 Lua",
    description:
      "在客户端 Lua 环境里执行任意代码并回传结果（逃生通道）。需要在插件选项里打开「允许执行 Lua」（allow_eval）。",
    schema: { code: z.string().min(1).describe("Lua 代码；返回值会被序列化回传") },
    annotations: { destructiveHint: true, openWorldHint: true },
    render: "json",
  },
  {
    tool: "game_wait",
    command: "wait",
    title: "等待",
    description: "在客户端侧等待指定毫秒（用于串联「操作 → 等动画 → 截图」这类多步流程）。",
    schema: { ms: z.number().int().min(0).max(60000).describe("等待毫秒") },
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
  {
    tool: "automation_sessions",
    command: "",
    title: "在线会话",
    description: "列出已连接私服的客户端会话（sid/最近轮询/积压命令数），用于确定要操作哪台设备。",
    schema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
    render: "json",
  },
];

/** 对外只读的工具总表 */
export const AUTOMATION_TOOL_SPECS: readonly AutomationToolSpec[] = Object.freeze(TOOL_SPECS);

/** 从 JSON 值里取一个字符串字段（不存在/类型不符返回 null） */
function pickString(source: JsonValue, key: string): string | null {
  if (!isJsonObject(source)) return null;
  const value = source[key];
  return typeof value === "string" ? value : null;
}

/** 从 JSON 值里取一个标量字段并转成展示文本（用于摘要，缺省 `?`） */
function scalarText(source: JsonValue, key: string): string {
  if (!isJsonObject(source)) return "?";
  const value = source[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "?";
}

/**
 * 把 base64url 转回 MCP 规范要求的标准 base64（MCP image content 用的是标准 alphabet）。
 * @param value - base64url 文本
 * @returns 标准 base64（无法解码时返回 null）
 */
function base64UrlToBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("base64");
  } catch {
    return null;
  }
}

/**
 * 渲染一条命令结果成 MCP 内容块。
 * @param spec - 工具定义
 * @param result - 命令结果
 * @returns MCP 工具返回
 */
export function renderToolResult(
  spec: AutomationToolSpec,
  result: AutomationCallResponse,
): AutomationToolResult {
  if (!result.ok) {
    const detail = result.error ?? "客户端未给出错误信息";
    return {
      content: [{ type: "text", text: `命令失败（${spec.command || spec.tool}）: ${detail}` }],
      isError: true,
    };
  }
  if (spec.render === "image") {
    const payload = result.result;
    const mimeType = pickString(payload, "mime") ?? "image/jpeg";
    const raw = pickString(payload, "base64");
    if (raw === null) {
      return {
        content: [{ type: "text", text: "截图命令返回成功，但结果里没有 base64 图像数据" }],
        isError: true,
      };
    }
    const data = base64UrlToBase64(raw);
    if (data === null) {
      return {
        content: [{ type: "text", text: "截图 base64 解码失败" }],
        isError: true,
      };
    }
    const summary = `截图 ${scalarText(payload, "width")}x${scalarText(payload, "height")}（原始 ${scalarText(
      payload,
      "sourceWidth",
    )}x${scalarText(payload, "sourceHeight")}），会话 ${result.sid}，客户端耗时 ${result.ms}ms`;
    return {
      content: [
        { type: "image", data, mimeType },
        { type: "text", text: summary },
      ],
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }],
  };
}

/**
 * 解析要操作的目标会话：
 *   1. 显式 `sid` 参数；
 *   2. 环境变量 `DTS_AUTOMATION_SID`；
 *   3. 恰好只有一个在线会话时自动选中。
 * 其余情况抛出可操作的错误信息（列出候选），避免 Agent 盲猜。
 * @param client - 私服客户端
 * @param explicit - 显式传入的 sid
 * @returns 会话 id
 */
export async function resolveSessionId(
  client: AutomationClient,
  explicit: string | undefined,
): Promise<string> {
  if (explicit !== undefined && explicit !== "") return explicit;
  const fromEnv = process.env.DTS_AUTOMATION_SID;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const { sessions } = await client.sessions();
  if (sessions.length === 1) return sessions[0].sid;
  if (sessions.length === 0) {
    throw new Error(
      "没有客户端连接自动化桥。请确认：① 私服已启动；② 客户端已启动且 automation_bridge 插件处于启用态；" +
        "③ 客户端能连上私服（游戏内「服务器」选项指向本地私服）。",
    );
  }
  const list = sessions.map((s) => `${s.sid}（${Math.round(s.idleMs / 1000)}s 前活跃）`).join("、");
  throw new Error(`有多个在线会话，请显式指定 sid。候选：${list}`);
}

/**
 * 执行一次工具调用（MCP 回调与服务端自检共用的唯一入口）。
 *
 * 把「解析会话 → 下发命令 → 渲染结果」收敛在一处，保证 CLI 自检与 MCP 调用
 * 走完全相同的路径（自检才有意义）。
 * @param client - 私服客户端
 * @param spec - 工具定义
 * @param raw - 工具入参（含公共 sid）
 * @returns MCP 工具返回
 */
export async function executeTool(
  client: AutomationClient,
  spec: AutomationToolSpec,
  raw: Record<string, JsonValue | undefined>,
): Promise<AutomationToolResult> {
  const sidRaw = raw.sid;
  const explicitSid = typeof sidRaw === "string" && sidRaw !== "" ? sidRaw : undefined;

  // 服务端本地工具：不需要客户端
  if (spec.command === "") {
    const response = await client.sessions();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: response.count,
              hub: response.hub,
              sessions: response.sessions,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const params: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "sid" || value === undefined) continue;
    params[key] = value;
  }

  let sid: string;
  try {
    sid = await resolveSessionId(client, explicitSid);
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }

  try {
    const result = await client.call(sid, spec.command, params, spec.timeoutMs);
    return renderToolResult(spec, result);
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}
