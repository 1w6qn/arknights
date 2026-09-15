/**
 * 自动化会话中心单测（命令队列 + 结果分片重组 + 超时）
 *
 * 固化三条容易悄悄失效的不变量：
 *   1. 命令只下发一次：`poll` 摘走后再次 `poll` 不会重复给（重复 = 客户端执行两遍）；
 *   2. 结果分片**乱序**到达也能正确重组（客户端串行发送，但服务端不能假设到达顺序）；
 *   3. 超时后该命令从待执行队列摘除（否则客户端上线会执行一条无人等待的「幽灵命令」）。
 *
 * 本文件分两段：
 *   A. hub 纯状态单测（零网络）；
 *   B. 路由级集成测试：真起一个 express（只挂 automation 路由）+ 真发 HTTP，
 *      把「MCP 侧 call → 客户端 poll → 分片回传 → 等待者被唤醒」整条链跑通
 *      （客户端用 fetch 手工模拟，语义与 Lua 桥一致）。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AutomationHub, automationHub } from "@ops/automation";
import type { JsonValue } from "@core/utils/json-value";
import { AutomationClient } from "../../../scripts/lib/automation-client";
import automationRouter from "@ops/automation/automation.routes";

/** 单个分片字符数（与 Lua 侧 `AutomationBridge._MAX_CHUNK` 一致，用于构造真实分片形状） */
const CHUNK_SIZE = 1800;

/**
 * 把结果信封编成客户端会发出的 base64url 分片序列。
 * @param envelope - 结果信封
 * @returns 分片数组（顺序即 seq）
 */
function encodeChunks(envelope: Record<string, JsonValue>): string[] {
  const base64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    chunks.push(base64.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/** 构造一个足够大的结果，保证被切成多片 */
function bigResult(marker: string): JsonValue {
  return { marker, filler: "x".repeat(5000) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AutomationHub 命令队列", () => {
  it("poll 取走命令且不重复下发", () => {
    const hub = new AutomationHub();
    const pending = hub.call("sid-a", "client.ping", {}, 5000);
    // 命令在下发前不可重复取
    const first = hub.poll("sid-a", true);
    expect(first.commands).toHaveLength(1);
    expect(first.commands[0].name).toBe("client.ping");
    expect(hub.poll("sid-a", true).commands).toHaveLength(0);
    // 收尾，避免悬挂的等待者
    const chunks = encodeChunks({ ok: true, ms: 1, result: null });
    hub.pushResultChunk("sid-a", first.commands[0].id, 1, chunks.length, chunks[0]);
    return pending;
  });

  it("一次 poll 最多下发 MAX_COMMANDS_PER_POLL 条并提示续取", async () => {
    const hub = new AutomationHub();
    const names = ["client.ping", "client.hello", "client.state", "client.logs", "plugin.list"];
    const calls = names.map((name) => hub.call("sid-b", name, {}, 5000));
    /** 把一条已下发的命令立刻结算掉，避免用例挂在 5s 超时上 */
    const settle = (cmdId: string): void => {
      const chunks = encodeChunks({ id: cmdId, sid: "sid-b", ok: true, ms: 1, result: null });
      hub.pushResultChunk("sid-b", cmdId, 1, chunks.length, chunks[0]);
    };

    const batch = hub.poll("sid-b", true);
    expect(batch.commands).toHaveLength(4);
    // 还有 1 条积压：要求客户端立刻续取而不是等空闲间隔
    expect(batch.nextPollMs).toBe(100);
    batch.commands.forEach((command) => settle(command.id));

    const rest = hub.poll("sid-b", false);
    expect(rest.commands).toHaveLength(1);
    expect(rest.nextPollMs).toBeUndefined();
    settle(rest.commands[0].id);

    await expect(Promise.all(calls)).resolves.toHaveLength(5);
  });

  it("结果分片乱序到达仍能重组并唤醒等待者", async () => {
    const hub = new AutomationHub();
    const pending = hub.call("sid-c", "screenshot", {}, 5000);
    const command = hub.poll("sid-c", true).commands[0];
    const chunks = encodeChunks({
      id: command.id,
      sid: "sid-c",
      ok: true,
      ms: 42,
      result: bigResult("shot"),
    });
    expect(chunks.length).toBeGreaterThan(2);

    // 故意从后往前推：最后一片必须等其余片到齐才结算
    for (let i = chunks.length - 1; i > 0; i -= 1) {
      const done = hub.pushResultChunk("sid-c", command.id, i + 1, chunks.length, chunks[i]);
      expect(done, `只有收齐全部 ${chunks.length} 片才算完成`).toBe(false);
    }
    expect(hub.pushResultChunk("sid-c", command.id, 1, chunks.length, chunks[0])).toBe(true);

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.ms).toBe(42);
    expect(result.roundTripMs).toBeGreaterThanOrEqual(0);
    const payload = result.result;
    expect(payload !== null && typeof payload === "object" && !Array.isArray(payload)).toBe(true);
  });

  it("重复分片只计一次（网络层重试不该让结果永远凑不齐）", () => {
    const hub = new AutomationHub();
    const pending = hub.call("sid-d", "client.ping", {}, 5000);
    const command = hub.poll("sid-d", true).commands[0];
    const chunks = encodeChunks({ id: command.id, sid: "sid-d", ok: true, ms: 1, result: "ok" });
    expect(chunks).toHaveLength(1);
    // 首片到达即结算；随后网络层重发的同一片不应改变结论
    expect(hub.pushResultChunk("sid-d", command.id, 1, 1, chunks[0])).toBe(true);
    expect(hub.pushResultChunk("sid-d", command.id, 1, 1, chunks[0])).toBe(true);
    return pending;
  });

  it("超时返回 ok=false 且把命令从队列摘除（不留幽灵命令）", async () => {
    vi.useFakeTimers();
    const hub = new AutomationHub();
    const pending = hub.call("sid-e", "screenshot", {}, 3000);
    expect(hub.poll("sid-e", true).commands).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3001);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("命令超时");
    // 客户端此刻才上线：不该再收到那条早已无人等待的命令
    expect(hub.poll("sid-e", false).commands).toHaveLength(0);
  });

  it("非法会话标识被拒（sid 会直接进 URL 路径）", () => {
    const hub = new AutomationHub();
    expect(hub.isValidSessionId("mumu_Android_1a2b3c")).toBe(true);
    expect(hub.isValidSessionId("bad/id")).toBe(false);
    expect(hub.isValidSessionId("")).toBe(false);
    expect(hub.isValidSessionId("x".repeat(65))).toBe(false);
  });

  it("listSessions 反映在线/积压/在途", () => {
    const hub = new AutomationHub();
    void hub.call("sid-f", "client.ping", {}, 5000);
    hub.poll("sid-f", true);
    void hub.call("sid-f", "client.state", {}, 5000);
    const sessions = hub.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sid).toBe("sid-f");
    expect(sessions[0].pollCount).toBe(1);
    expect(sessions[0].pending).toBe(1);
    expect(sessions[0].inflight).toBe(1);
    expect(sessions[0].lastCommandName).toBe("client.state");
    expect(hub.stats()).toMatchObject({ sessions: 1, waiters: 2 });
    hub.reset();
  });
});

describe("自动化路由（HTTP 形状 + 全链路）", () => {
  let server: Server;
  let base: string;
  let client: AutomationClient;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/plugin/automation", automationRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new AutomationClient({ baseUrl: base });
  });

  afterAll(async () => {
    automationHub.reset();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  /** 轮询直到出现命令（客户端视角），带超时保护 */
  async function pollForCommand(sid: string): Promise<{ id: string; name: string }> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/plugin/automation/poll/${sid}/1`);
      const body = (await response.json()) as { commands?: { id: string; name: string }[] };
      const command = body.commands?.[0];
      if (command !== undefined) return command;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("等待客户端命令超时");
  }

  it("MCP 侧 call 与客户端 poll/result 走完整回环", async () => {
    const pending = client.call("http-sid", "client.ping", {});
    const command = await pollForCommand("http-sid");
    expect(command.name).toBe("client.ping");

    const chunks = encodeChunks({
      id: command.id,
      sid: "http-sid",
      ok: true,
      ms: 7,
      result: { pong: true },
    });
    for (let i = 0; i < chunks.length; i += 1) {
      const url = `${base}/plugin/automation/result/http-sid/${command.id}/${i + 1}/${chunks.length}/${chunks[i]}`;
      const response = await fetch(url);
      const body = (await response.json()) as { status: number; done: number };
      expect(body.status).toBe(0);
      expect(body.done).toBe(i === chunks.length - 1 ? 1 : 0);
    }

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.sid).toBe("http-sid");
    expect(result.result).toEqual({ pong: true });
  });

  it("sessions 端点在客户端上线后列出会话", async () => {
    const pending = client.call("http-sid-2", "plugin.list", {});
    const command = await pollForCommand("http-sid-2");
    const listed = await client.sessions();
    expect(listed.sessions.map((item) => item.sid)).toContain("http-sid-2");
    // 收尾：把这条命令结算掉，避免留下悬挂的等待者
    const chunks = encodeChunks({ id: command.id, sid: "http-sid-2", ok: true, ms: 1, result: [] });
    await fetch(`${base}/plugin/automation/result/http-sid-2/${command.id}/1/1/${chunks[0]}`);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("非法请求被拦下（sid 字符集 / 分片序号 / 缺必填参数）", async () => {
    const badSid = await fetch(`${base}/plugin/automation/poll/bad%2Fid/1`);
    expect((await badSid.json()) as { status: number }).toMatchObject({ status: 1 });

    const badSeq = await fetch(`${base}/plugin/automation/result/http-x/c1/0/1/AAAA`);
    expect((await badSeq.json()) as { status: number }).toMatchObject({ status: 1 });

    const badBody = await fetch(`${base}/plugin/automation/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: "http-x" }),
    });
    expect(badBody.status).toBe(422);
    expect((await badBody.json()) as { result: number }).toMatchObject({ result: -1 });
  });

  it("超时命令返回 ok=false（HTTP 仍是 200，超时是业务结果）", async () => {
    const result = await client.call("http-timeout", "client.ping", {}, 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("命令超时");
    automationHub.reset();
  });
});
