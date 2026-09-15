/**
 * 自动化桥离线模拟客户端（无游戏也能验证整条链路）
 *
 * 作用：扮演 `lua/plugin/core/AutomationBridge.lua` 的**传输层**——按同一份线协议
 * 轮询命令、执行、把结果按 base64url 分片回传。于是「MCP server ↔ 私服 ↔ 客户端」
 * 这条链在没有真机/游戏的情况下也能端到端验证（也解释了协议为什么长这样）。
 *
 * 用法：
 *   pnpm run start:quick                       # 另开一个终端起私服
 *   pnpm run automation:sim                    # 本脚本（默认 sid=sim_linux、每 200ms 轮询）
 *   pnpm run mcp:automation -- --call game_state
 *
 * 参数（环境变量）：
 *   DTS_SERVER_URL   私服基址（缺省 http://127.0.0.1:8443）
 *   DTS_SIM_SID      会话标识（缺省 sim_<平台>_<随机>，需匹配 ^[A-Za-z0-9_-]{1,64}$）
 *
 * 注意：本脚本只是**协议陪练**，不代表游戏内真实能力——真机行为以
 * `lua/plugin/plugins/AutomationPlugin.lua` 为准。
 */
import type { JsonValue } from "@core/utils/json-value";

/** 私服基址 */
const BASE = (process.env.DTS_SERVER_URL ?? "http://127.0.0.1:8443").replace(/\/+$/, "");
/** 会话标识（只用 URL 安全字符：与服务端 sid 约束一致） */
const SID = process.env.DTS_SIM_SID ?? `sim_${process.platform}_${Date.now().toString(36)}`;
/** 与 Lua 侧 `AutomationBridge._MAX_CHUNK` 保持一致 */
const CHUNK_SIZE = 1800;
/** 一次 poll 之后的最小间隔 */
const POLL_FLOOR_MS = 100;

/** 假命令执行：与 `AutomationPlugin.lua` 的 handlers 语义对应（仅覆盖常用几条） */
function handleCommand(name: string, args: JsonValue): JsonValue | null {
  const argObject = args !== null && typeof args === "object" && !Array.isArray(args) ? args : {};
  switch (name) {
    case "client.ping":
      return { pong: true, sid: SID, sim: true, t: Date.now() };
    case "client.hello":
      return { protocol: 1, sid: SID, sim: true, handlers: ["client.ping", "client.state", "screenshot"] };
    case "client.state":
      return {
        scene: "main",
        pages: ["MainMenuPage"],
        battle: { active: false },
        player: { level: 120, ap: 135, gold: 9999999 },
        sim: true,
      };
    case "plugin.list":
      return { count: 1, enabled: 1, items: [{ id: "automation_bridge", enabled: true, error: null }] };
    case "http.get":
      return { url: String(argObject.url ?? ""), bytes: 15, body: '{"sim":true}', json: { sim: true } };
    case "ui.find":
      // 故意返回 activeInHierarchy=false：演示「面板已隐藏」是可断言的，不必截图
      return {
        found: true,
        path: String(argObject.path ?? argObject.name ?? "UI/Main/LuaUIRoot/OptionsPanel(Clone)"),
        activeInHierarchy: false,
        text: "插件选项",
        sim: true,
      };
    case "ui.check":
      return {
        pass: true,
        total: 1,
        failedCount: 0,
        failed: [],
        results: [
          { query: "sim", found: true, activeInHierarchy: false, text: "插件选项", ok: true, reason: null },
        ],
        sim: true,
      };
    case "screenshot":
      // 故意造大数据，逼出多分片路径（9000 字符 base64 ⇒ 5 片）
      return { mime: "image/jpeg", width: 8, height: 8, base64: "A".repeat(9000), sim: true };
    default:
      return null;
  }
}

/**
 * 把结果信封按 base64url 分片回传（与 Lua 侧 `_SendResult` 完全同形）。
 * @param cmdId - 命令标识
 * @param envelope - 结果信封
 */
async function sendResult(cmdId: string, envelope: Record<string, JsonValue>): Promise<void> {
  const base64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const total = Math.max(1, Math.ceil(base64.length / CHUNK_SIZE));
  for (let seq = 1; seq <= total; seq += 1) {
    const chunk = base64.slice((seq - 1) * CHUNK_SIZE, seq * CHUNK_SIZE);
    const url = `${BASE}/plugin/automation/result/${SID}/${cmdId}/${seq}/${total}/${chunk}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`结果分片上传失败 HTTP ${response.status}`);
    }
  }
}

/** 轮询循环 */
async function main(): Promise<void> {
  process.stderr.write(`[automation-sim] sid=${SID} 私服=${BASE}（Ctrl+C 退出）\n`);
  let first = true;
  let running = true;
  const seen: string[] = [];
  process.on("SIGINT", () => {
    running = false;
    process.stderr.write(`\n[automation-sim] 收到过的命令: ${seen.join(", ") || "（无）"}\n`);
    process.exit(0);
  });

  while (running) {
    try {
      const response = await fetch(`${BASE}/plugin/automation/poll/${SID}/${first ? "1" : "0"}`);
      first = false;
      const body = (await response.json()) as { commands?: { id: string; name: string; args: JsonValue }[]; nextPollMs?: number };
      const commands = body.commands ?? [];
      for (const command of commands) {
        seen.push(command.name);
        process.stderr.write(`[automation-sim] 执行 ${command.name}\n`);
        const result = handleCommand(command.name, command.args);
        const envelope: Record<string, JsonValue> =
          result === null
            ? { id: command.id, sid: SID, protocol: 1, ok: false, ms: 1, error: `模拟客户端未实现: ${command.name}` }
            : { id: command.id, sid: SID, protocol: 1, ok: true, ms: 2, result };
        await sendResult(command.id, envelope);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(body.nextPollMs ?? 200, POLL_FLOOR_MS)));
    } catch (error) {
      process.stderr.write(
        `[automation-sim] 轮询异常: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `[automation-sim] 退出: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
