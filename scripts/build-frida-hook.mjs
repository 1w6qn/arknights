#!/usr/bin/env node
/**
 * 打包 hook/ 下的 Frida 脚本。
 *
 * 为什么需要打包：`hook/il2cpp-unity-logs.ts` 依赖 `frida-il2cpp-bridge`（TS/ESM 源码），
 * `hook/inject-gadget.ts` 依赖 `frida-java-bridge`，两者都要 bundle 成单文件才能被 Frida 加载。
 *
 * 用法：
 *   node scripts/build-frida-hook.mjs                # 打包默认入口
 *   node scripts/build-frida-hook.mjs il2cpp-unity-logs
 *   node scripts/build-frida-hook.mjs --no-minify
 *
 * 依赖解析顺序（esbuild 与可选依赖）：
 *   1) 仓库根 node_modules（esbuild）
 *   2) tmp/npm-tools/node_modules（本仓调试时用的临时工具链）
 * 缺 esbuild 时的安装提示见下方 INSTALL_HINT。
 */
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOOK_DIR = path.join(ROOT, "hook");
const OUT_DIR = path.join(HOOK_DIR, "build");
const TOOLS = path.join(ROOT, "tmp", "npm-tools");
const NODE_PATHS = path.join(TOOLS, "node_modules");

const DEFAULT_ENTRIES = ["il2cpp-unity-logs", "inject-gadget"];

const INSTALL_HINT = [
  "缺少 esbuild。任选一种：",
  "  pnpm add -D esbuild",
  "  # 或本仓调试用的临时工具链：",
  "  mkdir -p tmp/npm-tools && cd tmp/npm-tools && npm i --no-audit --no-fund --ignore-scripts esbuild frida-java-bridge",
].join("\n");

/**
 * 找一个可用的 esbuild 可执行文件。
 * @returns {string} esbuild 路径
 */
function resolveEsbuild() {
  const candidates = [
    path.join(ROOT, "node_modules", ".bin", "esbuild"),
    path.join(NODE_PATHS, ".bin", "esbuild"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  console.error(INSTALL_HINT);
  process.exit(1);
}

/**
 * 打包一个入口。
 * @param {string} esbuild esbuild 可执行文件
 * @param {string} name 入口名（hook/<name>.ts）
 * @param {boolean} minify 是否压缩
 */
function build(esbuild, name, minify) {
  const entry = path.join(HOOK_DIR, `${name}.ts`);
  if (!existsSync(entry)) {
    console.error(`找不到入口：${entry}`);
    process.exit(1);
  }
  const outfile = path.join(OUT_DIR, `${name}.js`);
  const args = [
    entry,
    "--bundle",
    "--format=iife",
    "--platform=neutral",
    `--outfile=${outfile}`,
    // frida-java-bridge 会 import Node 的 "buffer"，Frida 运行时没有，用垫片顶上
    `--alias:buffer=${path.join(HOOK_DIR, "shims", "buffer.js")}`,
  ];
  if (minify) args.push("--minify");
  // esbuild 用 NODE_PATH（而不是 --node-paths）扩展依赖解析目录，
  // 这样 hook/ 里的源码可以解析到 tmp/npm-tools 下临时安装的 frida-java-bridge。
  const result = spawnSync(esbuild, args, {
    stdio: "inherit",
    cwd: ROOT,
    env: { ...process.env, NODE_PATH: NODE_PATHS },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`built ${path.relative(ROOT, outfile)}`);
}

const argv = process.argv.slice(2);
const minify = !argv.includes("--no-minify");
const names = argv.filter((arg) => !arg.startsWith("--"));

mkdirSync(OUT_DIR, { recursive: true });
const esbuild = resolveEsbuild();
for (const name of names.length > 0 ? names : DEFAULT_ENTRIES) {
  build(esbuild, name, minify);
}
