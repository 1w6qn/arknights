#!/usr/bin/env node
/**
 * MuMu 调试链路的 **Windows 侧 TCP 中继组**：一个进程 + 一个窗口起 4 条转发。
 *
 * 为什么必须放在 Windows 侧：MuMu 与 adb 都是 Windows 进程，WSL 访问不到 Windows 的
 * loopback；因此 WSL 侧的 python frida 客户端连的是「默认网关」（Windows 主机 IP）
 * 上的中继口，由本脚本转发回 Windows 本机/ WSL 私服：
 *
 *   27043 → 127.0.0.1:27042   x86_64 frida-server（adb forward 出来的设备端口）
 *   27098 → 127.0.0.1:27099   ARM64 frida-gadget（adb forward 出来的设备端口）
 *   8443  → <WSL IP>:8443     私服 HTTP
 *   8543  → <WSL IP>:8543     私服 HTTPS
 *
 * 用法（Windows）：
 *   node scripts/mumu-relay.mjs <WSL_IP>          # 前台运行，Ctrl+C 退出
 *   node scripts/mumu-relay.mjs <WSL_IP> --check  # 只探测：0=可用 / 1=需要启动 / 2=目标已变需重启
 *   node scripts/mumu-relay.mjs --status          # 打印探测明细（不落任何副作用）
 *
 * 环境变量（可选）：
 *   MUMU_RELAY_FRIDA_LISTEN / MUMU_RELAY_FRIDA_TARGET
 *   MUMU_RELAY_GADGET_LISTEN / MUMU_RELAY_GADGET_TARGET
 *   MUMU_RELAY_SERVER_PORT / MUMU_RELAY_TLS_PORT
 *   MUMU_TARGET_HOST（frida 两条的转发目标主机，缺省 127.0.0.1）
 *   MUMU_PROBE_HOST（--check/--status 探测哪台主机，缺省 127.0.0.1；从 WSL 侧探测时填网关 IP）
 *
 * 状态文件：tmp/mumu/relay.json（记录 pid/wslHost/端口，供 --check 判断"是不是我们起的、目标是否已变"）
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 中继状态文件（pid / 目标 WSL IP / 端口），tmp/ 已 gitignore */
export const STATE_FILE = path.join(ROOT, "tmp", "mumu", "relay.json");

/** 退出码语义：OK=已就绪可复用 / START=需要启动 / RESTART=我们起的但目标变了，需重启 */
export const CHECK_OK = 0;
export const CHECK_START = 1;
export const CHECK_RESTART = 2;

const USAGE = `用法: node scripts/mumu-relay.mjs <WSL_IP> [--check|--status]

  <WSL_IP>    WSL 的 IP（wsl hostname -I 的第一个地址），私服两条中继的转发目标
  --check     只探测，返回 0=可用 / 1=需要启动 / 2=目标已变需重启
  --status    打印探测明细（含每个端口是否在听）

环境变量可覆盖端口：MUMU_RELAY_FRIDA_LISTEN(27043) / MUMU_RELAY_FRIDA_TARGET(27042) /
MUMU_RELAY_GADGET_LISTEN(27098) / MUMU_RELAY_GADGET_TARGET(27099) /
MUMU_RELAY_SERVER_PORT(8443) / MUMU_RELAY_TLS_PORT(8543) / MUMU_TARGET_HOST(127.0.0.1) /
MUMU_PROBE_HOST(127.0.0.1，--check/--status 的探测目标主机)`;

/**
 * 组装中继计划（纯函数，便于 boot 脚本复用与单测）。
 * @param {string} wslHost WSL IP（私服两条的转发目标）
 * @param {Record<string,string|undefined>} [env] 环境变量表，缺省 process.env
 * @returns {{name:string,listen:number,host:string,port:number}[]}
 */
export function buildRelayPlan(wslHost, env = process.env) {
  const num = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const local = env.MUMU_TARGET_HOST || "127.0.0.1";
  const serverPort = num(env.MUMU_RELAY_SERVER_PORT, 8443);
  const tlsPort = num(env.MUMU_RELAY_TLS_PORT, 8543);
  return [
    {
      name: "frida-server",
      listen: num(env.MUMU_RELAY_FRIDA_LISTEN, 27043),
      host: local,
      port: num(env.MUMU_RELAY_FRIDA_TARGET, 27042),
    },
    {
      name: "gadget",
      listen: num(env.MUMU_RELAY_GADGET_LISTEN, 27098),
      host: local,
      port: num(env.MUMU_RELAY_GADGET_TARGET, 27099),
    },
    { name: "server", listen: serverPort, host: wslHost, port: serverPort },
    { name: "server-tls", listen: tlsPort, host: wslHost, port: tlsPort },
  ];
}

/**
 * 探测单个 TCP 端口是否可连（中继监听在 0.0.0.0，同机连 127.0.0.1 即可）。
 * @param {string} host 主机
 * @param {number} port 端口
 * @param {number} [timeout] 超时毫秒
 * @returns {Promise<boolean>} 是否连接成功
 */
export function probePort(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * 批量探测中继计划里每个 listen 端口。
 * @param {{name:string,listen:number}[]} plan 中继计划
 * @param {string} [probeHost] 探测目标主机（缺省 MUMU_PROBE_HOST 或 127.0.0.1）
 * @returns {Promise<{listening:string[],missing:string[]}>} 在听/缺失的项（形如 "name:port"）
 */
export async function probePlan(plan, probeHost = process.env.MUMU_PROBE_HOST || "127.0.0.1") {
  const results = await Promise.all(
    plan.map(async (entry) => ({ entry, ok: await probePort(probeHost, entry.listen) })),
  );
  const label = (entry) => `${entry.name}:${entry.listen}`;
  return {
    listening: results.filter((r) => r.ok).map((r) => label(r.entry)),
    missing: results.filter((r) => !r.ok).map((r) => label(r.entry)),
  };
}

/**
 * 读取中继状态文件。
 * @returns {{pid:number,wslHost:string,ports:number[],startedAt:string}|null} 状态对象，读不到返回 null
 */
export function readRelayState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 写入中继状态文件（目录自动创建）。
 * @param {{pid:number,wslHost:string,ports:number[],startedAt:string}} state 状态对象
 * @returns {void}
 */
export function writeRelayState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

/** 删除状态文件（进程正常退出时调用，让 --check 能识别"需要重起"）。 @returns {void} */
export function clearRelayState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* 不存在则忽略 */
  }
}

/**
 * 判断 pid 是否存活。
 * @param {number} pid 进程号
 * @returns {boolean} 存活与否
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 结束进程（Windows 用 taskkill /T /F，其余平台 SIGTERM）。
 * @param {number} pid 进程号
 * @returns {void}
 */
export function killPid(pid) {
  if (!isAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已退出则忽略 */
  }
}

/**
 * 判定中继当前状态：是否可复用 / 需启动 / 需重启。
 * @param {{name:string,listen:number}[]} plan 中继计划
 * @param {string|null} wslHost 期望的 WSL IP（null = 不校验目标）
 * @returns {Promise<{code:number,state:object|null,listening:string[],missing:string[],reason:string}>} 判定结果
 */
export async function checkRelay(plan, wslHost) {
  const state = readRelayState();
  const owned = state ? isAlive(state.pid) : false;
  const { listening, missing } = await probePlan(plan);
  const allUp = missing.length === 0;

  if (!allUp) {
    return {
      code: CHECK_START,
      state,
      listening,
      missing,
      reason: `端口未全部就绪（缺 ${missing.join(", ")}）`,
    };
  }
  if (state && owned && wslHost && state.wslHost !== wslHost) {
    return {
      code: CHECK_RESTART,
      state,
      listening,
      missing,
      reason: `目标是 ${state.wslHost}，期望 ${wslHost}（WSL 重启后 IP 会变）`,
    };
  }
  if (!state || !owned) {
    return {
      code: CHECK_OK,
      state,
      listening,
      missing,
      reason: "端口已就绪，但不是本脚本管理的进程（假定可用，不接管）",
    };
  }
  return { code: CHECK_OK, state, listening, missing, reason: `目标 ${state.wslHost}，pid=${state.pid}` };
}

/**
 * 起一条中继；遇 EADDRINUSE 时先尝试结束状态文件里的旧进程再重试一次。
 * @param {{name:string,listen:number,host:string,port:number}} entry 中继项
 * @param {number} [attempt] 重试计数
 * @returns {Promise<net.Server|null>} 成功返回 server，失败返回 null
 */
function listenRelay(entry, attempt = 0) {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(entry.port, entry.host);
      client.pipe(upstream);
      upstream.pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    server.once("error", (err) => {
      if (err && err.code === "EADDRINUSE" && attempt === 0) {
        const state = readRelayState();
        if (state && state.pid !== process.pid && isAlive(state.pid)) {
          console.warn(`[relay] ${entry.listen} 已被 pid=${state.pid} 占用，先结束它再重试`);
          killPid(state.pid);
          server.close();
          setTimeout(() => {
            listenRelay(entry, 1).then(resolve);
          }, 500);
          return;
        }
      }
      console.error(`[relay] ${entry.name} 监听 0.0.0.0:${entry.listen} 失败：${err?.code || err?.message}`);
      resolve(null);
    });
    server.listen(entry.listen, "0.0.0.0", () => {
      console.log(`[relay] ${entry.name.padEnd(12)} 0.0.0.0:${entry.listen} → ${entry.host}:${entry.port}`);
      resolve(server);
    });
  });
}

/**
 * 退出清理：关闭全部监听并删除状态文件。
 * @param {net.Server[]} servers 已起的监听
 * @param {number} code 退出码
 * @returns {void}
 */
function shutdown(servers, code) {
  for (const server of servers) {
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
  }
  clearRelayState();
  process.exit(code);
}

/** 打印用法。 @returns {void} */
function usage() {
  console.log(USAGE);
}

/**
 * 入口。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const wslHost = positional[0] || process.env.MUMU_WSL_IP || null;
  if (wslHost && !/^\d{1,3}(\.\d{1,3}){3}$/.test(wslHost)) {
    console.error(`[relay] WSL IP 不合法：${wslHost}`);
    return 2;
  }
  const check = argv.includes("--check");
  const status = argv.includes("--status");
  if (!wslHost && !check && !status) {
    console.error("[relay] 需要给出 WSL IP（私服两条中继的转发目标）");
    usage();
    return 2;
  }

  const plan = buildRelayPlan(wslHost ?? "127.0.0.1");
  if (check || status) {
    const result = await checkRelay(plan, wslHost);
    if (status) {
      console.log(`[relay] 状态：${result.reason}`);
      for (const item of result.listening) console.log(`  up    ${item}`);
      for (const item of result.missing) console.log(`  DOWN  ${item}`);
    }
    if (check) {
      // --check 只给退出码，避免调用方解析输出
      return result.code;
    }
    return 0;
  }

  if (process.platform === "win32") process.title = "MuMu Relay";
  console.log(`[relay] 目标 WSL：${wslHost}`);
  const servers = [];
  const boundPorts = [];
  for (const entry of plan) {
    const server = await listenRelay(entry);
    if (server) {
      servers.push(server);
      boundPorts.push(entry.listen);
    }
  }
  if (servers.length === 0) {
    console.error("[relay] 没有任何中继监听成功");
    return 1;
  }
  writeRelayState({
    pid: process.pid,
    wslHost,
    ports: boundPorts,
    startedAt: new Date().toISOString(),
  });
  if (servers.length < plan.length) {
    console.error(`[relay] 仅 ${servers.length}/${plan.length} 条监听成功，其余端口被占用`);
  } else {
    console.log("[relay] 4 条中继就绪，Ctrl+C 退出");
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      console.log(`[relay] 收到 ${signal}，清理退出`);
      shutdown(servers, 0);
    });
  }
  return 0;
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
