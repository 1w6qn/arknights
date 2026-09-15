#!/usr/bin/env node
/**
 * MuMu 一键启动的 **Windows 侧编排**（仓库根 `start-mumu.cmd` 的实际执行体）。
 *
 * 为什么编排放 Windows 侧：MuMu 模拟器、adb-server、中继进程都必须活在 Windows
 * （WSL 访问不到 Windows loopback，且 WSL 里的后台进程会随工具调用结束被清掉）。
 * 本脚本只做「需要 Windows 的四件事」，随后把 WSL 侧主体交给 scripts/mumu-start.sh：
 *
 *   1. MuMu：查 info，必要时 control launch，等 Android 起来
 *   2. adb ：start-server + connect <adb_host_ip>:<adb_port>，确认设备是 device 态
 *   3. 中继：scripts/mumu-relay.mjs 起独立窗口（4 条转发），已在跑且目标一致则复用
 *   4. 转交：wsl.exe -d <distro> bash -lc "cd <repo> && bash scripts/mumu-start.sh <参数>"
 *
 * 用法（Windows，或 WSL 里直接跑也行——非 win32 时自动改为本机 bash 调用）：
 *   node scripts/mumu-boot.mjs --dry-run             # 只自检并打印计划，不起任何进程
 *   node scripts/mumu-boot.mjs                       # 全链路（默认注入 600s）
 *   node scripts/mumu-boot.mjs --no-frida            # 只起基础设施（模拟器+私服+中继+adb）
 *   node scripts/mumu-boot.mjs --duration 120 --pubkey-mode ours
 *   node scripts/mumu-boot.mjs --no-emulator --no-relay
 *
 * 本脚本只认自己的开关（--dry-run/--no-emulator/--no-relay/--vm/--distro/--mumu-home/--help），
 * 其余参数原样透传给 scripts/mumu-start.sh（--duration/--no-frida/--no-server/--pubkey-mode/...）。
 *
 * 环境变量：MUMU_HOME / MUMU_VM_INDEX / MUMU_WSL_DISTRO / MUMU_WSL_IP / ADB
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelayPlan, checkRelay, killPid, probePlan, CHECK_OK, CHECK_RESTART } from "./mumu-relay.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const RELAY_SCRIPT = path.join(ROOT, "scripts", "mumu-relay.mjs");
const START_SCRIPT = path.join(ROOT, "scripts", "mumu-start.sh");

const USAGE = `用法: node scripts/mumu-boot.mjs [自己的开关] [透传给 mumu-start.sh 的参数]

自己的开关:
  --dry-run         只自检并打印计划（透传 --dry-run 给 WSL 侧，仍会调起 WSL 脚本）
  --no-emulator     不启动/不等待 MuMu 模拟器
  --no-relay        不动中继（假定已有）
  --vm <index>      MuMu 实例号，缺省 0（环境变量 MUMU_VM_INDEX）
  --distro <name>   WSL 发行版名，缺省 Ubuntu（环境变量 MUMU_WSL_DISTRO）
  --mumu-home <dir> MuMu 安装目录（环境变量 MUMU_HOME）

透传示例: --duration 120 / --no-frida / --no-restart / --pubkey-mode ours / --rebuild`;

const info = (msg) => console.log(`\u001b[36m[mumu]\u001b[0m ${msg}`);
const ok = (msg) => console.log(`\u001b[32m  ✔\u001b[0m ${msg}`);
const warn = (msg) => console.log(`\u001b[33m  !\u001b[0m ${msg}`);
const step = (tag, msg) => console.log(`\n\u001b[1m[${tag}]\u001b[0m ${msg}`);

/**
 * 执行外部命令并取回输出（不抛异常，失败返回空串）。
 * @param {string} cmd 可执行文件
 * @param {string[]} args 参数
 * @param {number} [timeout] 超时毫秒
 * @returns {string} stdout+stderr（已 trim）
 */
function run(cmd, args, timeout = 30000) {
  const result = spawnSync(cmd, args, { encoding: "utf-8", timeout, windowsHide: true });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

/**
 * 定位 MuMu 安装目录（含 shell/MuMuManager.exe）。
 * @param {string|undefined} override --mumu-home 或 MUMU_HOME
 * @returns {string|null} 安装目录，找不到返回 null
 */
function findMuMuHome(override) {
  const candidates = [
    override,
    process.env.MUMU_HOME,
    IS_WIN ? "D:\\Program Files\\YXArkNights-12.0" : "/mnt/d/Program Files/YXArkNights-12.0",
    IS_WIN ? "C:\\Program Files\\Netease\\MuMuPlayer-12.0" : "/mnt/c/Program Files/Netease/MuMuPlayer-12.0",
    IS_WIN ? "C:\\Program Files\\MuMuPlayer-12.0" : "/mnt/c/Program Files/MuMuPlayer-12.0",
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "shell", "MuMuManager.exe"))) return dir;
  }
  return null;
}

/**
 * 查询 MuMu 实例信息。
 * @param {string} manager MuMuManager.exe 路径
 * @param {number} vm 实例号
 * @returns {Record<string, unknown>|null} info JSON，失败返回 null
 */
function mumuInfo(manager, vm) {
  const out = run(manager, ["info", "-v", String(vm)], 30000);
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 等 MuMu Android 起好。
 * @param {string} manager MuMuManager.exe 路径
 * @param {number} vm 实例号
 * @param {number} timeoutSec 超时秒数
 * @returns {boolean} 是否就绪
 */
function waitAndroid(manager, vm, timeoutSec = 180) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const infoJson = mumuInfo(manager, vm);
    if (infoJson && infoJson.is_android_started && infoJson.player_state === "start_finished") return true;
    spawnSync(IS_WIN ? "timeout" : "sleep", IS_WIN ? ["/t", "3", "/nobreak"] : ["3"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
  return false;
}

/**
 * 把 Windows 路径转成 WSL 路径（仅用于非 win32 下的兜底；win32 下走 wslpath）。
 * @param {string} winPath Windows 路径
 * @returns {string} WSL 路径
 */
function winPathToWsl(winPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!match) return winPath.replace(/\\/g, "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/**
 * POSIX shell 单引号转义。
 * @param {string} value 原始字符串
 * @returns {string} 可安全放进单引号的字符串
 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 组装 WSL 侧命令行。
 * @param {string} repoWsl WSL 里的仓库路径
 * @param {string[]} forwarded 透传参数
 * @returns {string} bash -lc 的命令体
 */
function buildBashCommand(repoWsl, forwarded) {
  const args = forwarded.map(shQuote).join(" ");
  return `cd ${shQuote(repoWsl)} && exec bash scripts/mumu-start.sh ${args}`.trim();
}

/**
 * 起一个独立的中继窗口并等端口就绪。
 * @param {string} wslHost WSL IP
 * @param {{name:string,listen:number}[]} plan 中继计划
 * @returns {Promise<boolean>} 4 条是否全部就绪
 */
async function startRelay(wslHost, plan) {
  info(`启动中继窗口：node scripts/mumu-relay.mjs ${wslHost}`);
  const child = spawn(process.execPath, [RELAY_SCRIPT, wslHost], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  const deadline = Date.now() + 15000;
  let probe = await probePlan(plan);
  while (probe.missing.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    probe = await probePlan(plan);
  }
  if (probe.missing.length === 0) {
    ok("中继 4 条全部就绪");
    return true;
  }
  warn(`中继仍未就绪：${probe.missing.join(", ")}（看中继窗口报错；WSL 侧会再自检）`);
  return false;
}

/**
 * 入口。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const own = new Set(["--dry-run", "--no-emulator", "--no-relay"]);
  const valueFlags = new Set(["--vm", "--distro", "--mumu-home"]);
  const dryRun = argv.includes("--dry-run");
  const noEmulator = argv.includes("--no-emulator");
  const noRelay = argv.includes("--no-relay");
  const getValue = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const vm = Number(getValue("--vm", process.env.MUMU_VM_INDEX || "0"));
  const distro = getValue("--distro", process.env.MUMU_WSL_DISTRO || "Ubuntu");
  const mumuHomeArg = getValue("--mumu-home", undefined);

  // 透传参数：原样交给 mumu-start.sh（--dry-run 也要带上）
  const forwarded = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // pnpm 会把分隔符 `--` 一起传下来；它对 WSL 侧主体没有意义，丢掉
    if (arg === "--") continue;
    if (own.has(arg)) continue;
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    forwarded.push(arg);
  }
  // 本脚本的 --dry-run 同时也是 WSL 侧主体的开关，必须一起透传
  if (dryRun && !forwarded.includes("--dry-run")) forwarded.push("--dry-run");

  console.log("\u001b[1m=== MuMu 一键启动（DoctorateTs）===\u001b[0m");
  info(`仓库：${ROOT}`);
  info(`平台：${process.platform}   WSL 发行版：${distro}   MuMu 实例：${vm}`);
  if (dryRun) warn("dry-run：只自检并打印计划，不启动模拟器/中继");

  // ------------------------------------------------------------ 1) MuMu
  step("1/4", "MuMu 模拟器");
  const mumuHome = findMuMuHome(mumuHomeArg);
  let adbSerial = null;
  if (!mumuHome) {
    warn("找不到 MuMu 安装目录（可设 MUMU_HOME 或 --mumu-home），跳过模拟器检查");
  } else {
    const manager = path.join(mumuHome, "shell", "MuMuManager.exe");
    ok(`MuMu：${mumuHome}`);
    const infoJson = mumuInfo(manager, vm);
    if (!infoJson) {
      warn("MuMuManager info 读不到（模拟器可能没装/未授权），跳过模拟器检查");
    } else {
      const started = Boolean(infoJson.is_android_started) && infoJson.player_state === "start_finished";
      if (started) {
        ok(`Android 已在运行（${infoJson.name || "vm" + vm}，adb ${infoJson.adb_host_ip}:${infoJson.adb_port}）`);
      } else if (noEmulator) {
        warn("Android 未就绪，但按 --no-emulator 跳过");
      } else if (dryRun) {
        warn("dry-run：Android 未就绪（正式运行会 control launch 并等待）");
      } else {
        info(`启动 MuMu 实例 ${vm}：MuMuManager control -v ${vm} launch`);
        run(manager, ["control", "-v", String(vm), "launch"], 60000);
        if (!waitAndroid(manager, vm)) {
          console.error("  ✘ MuMu Android 180s 内未就绪");
          return 1;
        }
        ok("Android 已就绪");
      }
      if (infoJson.adb_host_ip && infoJson.adb_port) adbSerial = `${infoJson.adb_host_ip}:${infoJson.adb_port}`;
    }
  }

  // ------------------------------------------------------------ 2) adb
  step("2/4", "adb 设备");
  const adbExe =
    process.env.ADB ||
    (mumuHome ? path.join(mumuHome, "shell", "adb.exe") : null) ||
    (IS_WIN ? "adb.exe" : "adb");
  const adbDevices = () =>
    run(adbExe, ["devices"], 20000)
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2 && parts[1] === "device")
      .map((parts) => parts[0]);
  if (dryRun) {
    warn(`dry-run：adb=${adbExe}，正式运行会 start-server${adbSerial ? ` + connect ${adbSerial}` : ""}`);
  } else {
    run(adbExe, ["start-server"], 30000);
    let devices = adbDevices();
    if (devices.length === 0 && adbSerial) {
      run(adbExe, ["connect", adbSerial], 20000);
      devices = adbDevices();
    }
    if (devices.length === 0) {
      console.error("  ✘ 没有 device 态的 adb 设备（模拟器没起 / adb 端口变了）");
      return 1;
    }
    ok(`设备：${devices.join(", ")}`);
  }

  // ------------------------------------------------------------ 3) WSL 侧路径与 IP
  step("3/4", "中继与 WSL 目标");
  let wslHost = process.env.MUMU_WSL_IP || "";
  let repoWsl = process.env.MUMU_REPO_WSL || "";
  if (IS_WIN) {
    if (!wslHost) {
      const ips = run("wsl.exe", ["-d", distro, "hostname", "-I"], 30000).split(/\s+/).filter(Boolean);
      wslHost = ips[0] || "";
    }
    if (!repoWsl) {
      const converted = run("wsl.exe", ["-d", distro, "wslpath", "-a", "-u", ROOT], 30000);
      repoWsl = converted && !converted.includes("wslpath") ? converted : winPathToWsl(ROOT);
    }
  } else {
    if (!wslHost) {
      const route = run("ip", ["route"], 10000);
      wslHost = /^default via (\S+)/m.exec(route)?.[1] || "127.0.0.1";
    }
    repoWsl = ROOT;
    // 非 win32（在 WSL 里跑）时中继在 Windows 侧，探测目标换成网关
    process.env.MUMU_PROBE_HOST = process.env.MUMU_PROBE_HOST || wslHost;
  }
  if (!wslHost) {
    console.error("  ✘ 取不到 WSL IP（wsl.exe hostname -I 失败）；可设 MUMU_WSL_IP 兜底");
    return 1;
  }
  info(`WSL IP：${wslHost}   仓库（WSL 路径）：${repoWsl}`);

  const plan = buildRelayPlan(wslHost);
  const check = await checkRelay(plan, wslHost);
  if (noRelay) {
    warn("按 --no-relay 跳过中继处理");
  } else if (dryRun) {
    warn(`dry-run：中继现状「${check.reason}」——正式运行会起 scripts/mumu-relay.mjs ${wslHost}`);
  } else if (check.code === CHECK_OK) {
    ok(`中继已就绪（${check.reason}）`);
  } else if (check.code === CHECK_RESTART) {
    if (check.state) {
      warn(`WSL IP 变了（${check.state.wslHost} → ${wslHost}），重启中继 pid=${check.state.pid}`);
      killPid(check.state.pid);
    }
    await startRelay(wslHost, plan);
  } else {
    // 缺端口就起：中继自身逐口容错（被非托管进程占用的口只告警，其余照常转发）
    if (check.listening.length > 0) {
      warn(`已有端口在听：${check.listening.join(", ")}；为缺失的 ${check.missing.join(", ")} 起中继`);
    }
    await startRelay(wslHost, plan);
  }

  // ------------------------------------------------------------ 4) 转交 WSL 侧主体
  step("4/4", "转交 WSL 侧主体（scripts/mumu-start.sh）");
  const bashCmd = buildBashCommand(repoWsl, forwarded);
  if (IS_WIN) {
    info(`wsl.exe -d ${distro} bash -lc ${shQuote(bashCmd)}`);
    const result = spawnSync("wsl.exe", ["-d", distro, "bash", "-lc", bashCmd], {
      stdio: "inherit",
      cwd: ROOT,
    });
    return result.status ?? 1;
  }
  info(`bash -lc ${shQuote(bashCmd)}`);
  const result = spawnSync("bash", ["-lc", bashCmd], { stdio: "inherit", cwd: ROOT });
  return result.status ?? 1;
}

main().then((code) => {
  if (code !== 0) {
    console.log(`\n\u001b[31m[mumu]\u001b[0m 退出码 ${code}`);
    process.exitCode = code;
  }
});
