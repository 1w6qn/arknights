/**
 * MCP 工具表单测（含**与 Lua 命令名的漂移守卫**）
 *
 * 最容易悄悄失效的地方：改了 `AutomationPlugin.lua` 的 `handlers[...]` 名字，
 * 而 MCP 工具表还指向旧名字 —— 表现是「工具调用永远超时」，极难从日志看出来。
 * 这里直接把 Lua 源码里的 handler 名集合与工具表的 `command` 集合对齐。
 *
 * 另有渲染层用例（失败/图片/JSON）与会话解析用例（0 个/多个在线会话）。
 * 全程不连真实私服：`fetchImpl` 注入替身。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@core/utils/json-value";
import { AutomationClient } from "../../../scripts/lib/automation-client";
import {
  AUTOMATION_TOOL_SPECS,
  buildInputSchema,
  executeTool,
  renderToolResult,
  resolveSessionId,
  type AutomationToolSpec,
} from "../../../scripts/lib/automation-tools";

/** 仓库根（tests/unit/scripts → ../../..） */
const ROOT = join(__dirname, "..", "..", "..");

/** 一次被记录的 HTTP 调用 */
interface RecordedCall {
  url: string;
  body: Record<string, JsonValue> | undefined;
}

/**
 * 造一个走替身网络的客户端。
 * @param route - 按 URL 返回 JSON 响应体
 * @param recorded - 调用记录（可选，用于断言请求形状）
 * @returns 客户端
 */
function makeClient(
  route: (url: string) => JsonValue,
  recorded: RecordedCall[] = [],
): AutomationClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const rawBody = init?.body;
    recorded.push({
      url,
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as Record<string, JsonValue>) : undefined,
    });
    return new Response(JSON.stringify(route(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new AutomationClient({ baseUrl: "http://test.local", fetchImpl });
}

/** 取某个工具定义（不存在则抛错，让用例失败得直白） */
function specOf(tool: string): AutomationToolSpec {
  const spec = AUTOMATION_TOOL_SPECS.find((item) => item.tool === tool);
  if (spec === undefined) throw new Error(`工具表里没有 ${tool}`);
  return spec;
}

describe("工具表与 Lua 命令名一致性", () => {
  it("每个 MCP 工具的 command 都在 AutomationPlugin.lua 里注册过", () => {
    const lua = readFileSync(join(ROOT, "lua", "plugin", "plugins", "AutomationPlugin.lua"), "utf-8");
    const registered = [...lua.matchAll(/handlers\["([^"]+)"\]\s*=/g)].map((match) => match[1]).sort();
    const declared = AUTOMATION_TOOL_SPECS.map((spec) => spec.command)
      .filter((command) => command !== "")
      .sort();
    expect(declared, "工具表的命令集合必须与 Lua handlers 完全一致").toEqual(registered);
  });

  it("工具名与命令名都不重复", () => {
    const tools = AUTOMATION_TOOL_SPECS.map((spec) => spec.tool);
    expect(new Set(tools).size).toBe(tools.length);
    const commands = AUTOMATION_TOOL_SPECS.map((spec) => spec.command).filter((c) => c !== "");
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("每个工具都有标题与面向 Agent 的说明", () => {
    for (const spec of AUTOMATION_TOOL_SPECS) {
      expect(spec.title.length, `${spec.tool} 缺标题`).toBeGreaterThan(0);
      expect(spec.description.length, `${spec.tool} 说明过短`).toBeGreaterThan(10);
    }
  });

  it("客户端工具带公共 sid 参数，服务端本地工具不带", () => {
    expect(Object.keys(buildInputSchema(specOf("game_state")))).toContain("sid");
    expect(Object.keys(buildInputSchema(specOf("automation_sessions")))).not.toContain("sid");
  });
});

describe("结果渲染", () => {
  it("失败结果转成 isError 文本", () => {
    const rendered = renderToolResult(specOf("game_state"), {
      status: 0,
      id: "c1",
      sid: "s1",
      ok: false,
      ms: 0,
      result: null,
      error: "命令超时（20000ms）",
      roundTripMs: 20000,
    });
    expect(rendered.isError).toBe(true);
    expect(rendered.content[0].type).toBe("text");
    expect(rendered.content[0].type === "text" ? rendered.content[0].text : "").toContain("命令超时");
  });

  it("截图结果转成标准 base64 的 image 内容块", () => {
    const payload = { mime: "image/jpeg", width: 480, height: 270, base64: "aGVsbG8" };
    const rendered = renderToolResult(specOf("game_screenshot"), {
      status: 0,
      id: "c2",
      sid: "s1",
      ok: true,
      ms: 33,
      result: payload,
      error: null,
      roundTripMs: 40,
    });
    const image = rendered.content[0];
    expect(image.type).toBe("image");
    if (image.type !== "image") throw new Error("首块应为图片");
    // MCP 要标准 base64（Lua 侧发的是 base64url），这里解码回原文验证
    expect(Buffer.from(image.data, "base64").toString("utf8")).toBe("hello");
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("普通结果序列化成 JSON 文本", () => {
    const rendered = renderToolResult(specOf("game_ping"), {
      status: 0,
      id: "c3",
      sid: "s1",
      ok: true,
      ms: 1,
      result: { pong: true },
      error: null,
      roundTripMs: 2,
    });
    expect(rendered.isError).toBeUndefined();
    expect(rendered.content[0].type === "text" ? rendered.content[0].text : "").toContain('"pong": true');
  });
});

describe("工具执行与会话解析", () => {
  it("client_http_get 把参数原样透传给 http.get", async () => {
    const recorded: RecordedCall[] = [];
    const client = makeClient((url): JsonValue => {
      if (url.endsWith("/sessions")) {
        return { status: 0, count: 1, sessions: [{ sid: "dev", idleMs: 5 }], hub: {} };
      }
      return { status: 0, id: "c9", sid: "dev", ok: true, ms: 3, result: { body: "{}" }, error: null, roundTripMs: 4 };
    }, recorded);

    const result = await executeTool(client, specOf("client_http_get"), {
      url: "/config/prod/official/network_config",
      max_bytes: 2048,
    });
    expect(result.isError).toBeUndefined();
    const call = recorded.find((item) => item.url.endsWith("/call"));
    expect(call).toBeDefined();
    expect(call?.body?.name).toBe("http.get");
    expect(call?.body?.sid).toBe("dev");
    expect(call?.body?.args).toEqual({ url: "/config/prod/official/network_config", max_bytes: 2048 });
  });

  it("automation_sessions 不走客户端，直接渲染会话列表", async () => {
    const client = makeClient(() => ({
      status: 0,
      count: 1,
      sessions: [{ sid: "mumu", idleMs: 1200, pollCount: 7 }],
      hub: { sessions: 1, waiters: 0, partials: 0 },
    }));
    const result = await executeTool(client, specOf("automation_sessions"), {});
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("mumu");
    expect(text).toContain("pollCount");
  });

  it("没有在线会话时给出可操作的排查提示", async () => {
    const client = makeClient(() => ({ status: 0, count: 0, sessions: [], hub: {} }));
    await expect(resolveSessionId(client, undefined)).rejects.toThrow(/没有客户端连接自动化桥/);
    const result = await executeTool(client, specOf("game_ping"), {});
    expect(result.isError).toBe(true);
  });

  it("多个在线会话时要求显式指定 sid 并列出候选", async () => {
    const client = makeClient(() => ({
      status: 0,
      count: 2,
      sessions: [
        { sid: "dev-a", idleMs: 100 },
        { sid: "dev-b", idleMs: 900 },
      ],
      hub: {},
    }));
    await expect(resolveSessionId(client, undefined)).rejects.toThrow(/dev-a.*dev-b/);
    await expect(resolveSessionId(client, "dev-b")).resolves.toBe("dev-b");
  });
});
