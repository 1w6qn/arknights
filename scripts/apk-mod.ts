/**
 * 一键「获取最新 APK 并改造」编排器
 *
 * 把分散的三步串成一条命令：
 *   1. 定位本地已下载的最新官方 APK（`tmp/apk/<版本>/*.apk`，由 `pnpm run apk:lua` 落盘）；
 *   2. 扫描 APK 定位内置 Lua bundle（`assets/AB/Android/anon/<hash>.bin`），据此推出对应的
 *      注入版 mod 名（`mods/anon_<hash>.dat`，由 `pnpm run apk:lua` 产出）；
 *   3. zip 级回灌 + 结构自检 + 重签名，产出可安装的改造包。
 *
 * 用法：
 *   pnpm run apk:lua                     # 先：抓最新官方 APK → 注入插件引导 → mods/anon_<hash>.dat
 *   pnpm run apk:mod                     # 后：自动定位两者 → 回灌 → 重签 → tmp/apk-out/<名>-mod-signed.apk
 *   pnpm run apk:mod -- --apk <官方.apk> --mods <mods目录> --out <出包.apk> --no-sign
 */
import * as fs from "fs";
import * as path from "path";
import { findLuaBundleInApk } from "./apk-lua";
import { patchApk, verifyPatchedApk, inspectApk, type ApkReplacement } from "./apk-patch";
import { signApk } from "./apk-sign";

/** 仓库根目录 */
const ROOT = path.join(__dirname, "..");
/** APK 缓存目录（apk:lua 的落盘位置） */
const APK_DIR = path.join(ROOT, "tmp", "apk");
/** 默认 mods 目录 */
const DEFAULT_MODS_DIR = path.join(ROOT, "mods");
/** 默认产物目录 */
const DEFAULT_OUT_DIR = path.join(ROOT, "tmp", "apk-out");

/** CLI 参数 */
interface CliArgs {
  apk: string;
  mods: string;
  out: string;
  outDir: string;
  sign: boolean;
}

/**
 * 解析命令行参数。
 * @param argv - 参数（不含 node/脚本名）
 * @returns 解析结果
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { apk: "", mods: DEFAULT_MODS_DIR, out: "", outDir: DEFAULT_OUT_DIR, sign: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apk") args.apk = argv[++i] ?? "";
    else if (a === "--mods") args.mods = argv[++i] ?? "";
    else if (a === "--out") args.out = argv[++i] ?? "";
    else if (a === "--out-dir") args.outDir = argv[++i] ?? "";
    else if (a === "--no-sign") args.sign = false;
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: pnpm run apk:mod -- [--apk <官方.apk>] [--mods <mods目录>] [--out <出包.apk>]\n" +
          "            [--out-dir <产物目录>] [--no-sign]",
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * 在 tmp/apk 下按目录名（版本）与 mtime 选出最新的官方 APK。
 * @returns APK 路径（找不到返回空串）
 */
function locateLatestApk(): string {
  if (!fs.existsSync(APK_DIR)) return "";
  const found: { file: string; version: string; mtime: number }[] = [];
  for (const ver of fs.readdirSync(APK_DIR)) {
    const dir = path.join(APK_DIR, ver);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.apk$/i.test(f)) continue;
      const full = path.join(dir, f);
      found.push({ file: full, version: ver, mtime: fs.statSync(full).mtimeMs });
    }
  }
  if (found.length === 0) return "";
  found.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }) || a.mtime - b.mtime);
  return found[found.length - 1].file;
}

/**
 * 由内置 bundle 条目名推出注入版 mod 文件名（`anon/<hash>.bin` → `anon_<hash>.dat`）。
 * @param entryPath - APK 内条目路径
 * @returns mod 文件名
 */
function modNameForEntry(entryPath: string): string {
  const base = path.basename(entryPath).replace(/\.[^.]*$/, "");
  return `anon_${base}.dat`;
}

/** CLI 入口 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apk = args.apk ? path.resolve(args.apk) : locateLatestApk();
  if (!apk) {
    console.error("[apk:mod] 未找到官方 APK。请先执行 pnpm run apk:lua（会自动下载最新版），或用 --apk 指定");
    process.exit(1);
  }
  if (!fs.existsSync(apk)) {
    console.error(`[apk:mod] APK 不存在: ${apk}`);
    process.exit(1);
  }

  const info = inspectApk(apk);
  console.log(`[apk:mod] 源 APK: ${apk}（${(info.fileSize / 1e6).toFixed(1)} MB，${info.entryCount} 条）`);

  const found = await findLuaBundleInApk(apk);
  const modName = modNameForEntry(found.entryPath);
  const modFile = path.join(args.mods, modName);
  console.log(`[apk:mod] 内置 bundle: ${found.entryPath}\n[apk:mod] 期望注入版 mod: ${modFile}`);
  if (!fs.existsSync(modFile)) {
    console.error(
      `[apk:mod] 未找到注入版 mod（${modName}）。请先执行 pnpm run apk:lua 重建，或用 --mods 指定目录`,
    );
    process.exit(1);
  }

  const stem = path.basename(apk).replace(/\.apk$/i, "");
  const out = args.out ? path.resolve(args.out) : path.join(args.outDir, `${stem}-mod.apk`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const replacements: ApkReplacement[] = [{ entry: found.entryPath, file: modFile }];
  const report = patchApk({ inApk: apk, outApk: out, replacements, stripV1: true, dryRun: false });
  for (const r of report.replaced) {
    console.log(`[apk:mod] 回灌 ${r.entry}: ${r.oldSize} B → ${r.newSize} B`);
  }
  const problems = verifyPatchedApk(out, new Map(report.replaced.map((r) => [r.entry, r.newCrc])));
  if (problems.length) {
    console.error("[apk:mod] 自检失败：");
    for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[apk:mod] 改造包: ${out}（${(report.outSize / 1e6).toFixed(1)} MB，自检通过）`);

  if (!args.sign) {
    console.log("[apk:mod] 已跳过签名（--no-sign）；未签名 APK 无法直接安装");
    return;
  }
  const signed = signApk({
    inApk: out,
    outDir: args.outDir,
    outApk: path.join(args.outDir, `${stem}-mod-signed.apk`),
  });
  console.log("\n=================== 完成 ===================");
  console.log(`  源 APK:    ${apk}`);
  console.log(`  注入 mod:  ${modFile}`);
  console.log(`  改造包:    ${out}`);
  console.log(`  已签名包:  ${signed}`);
  console.log("===========================================");
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[apk:mod] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
