/**
 * APK 精简器：删掉用不上的内容后重签名（默认只做「多 ABI 去重」这类低风险删减）
 *
 * 典型场景：官方 APK 同时内置 `arm64-v8a` 与 `armeabi-v7a` 两套原生库（本包共 ~493 MB 未压缩 /
 * ~167 MB 压缩）。MuMu 12 与现行真机都是 `arm64-v8a`（MuMu 用 ARM 翻译跑 arm64），
 * `armeabi-v7a` 可整目录删除 —— 实测压缩后 **省 ~82 MB**。
 *
 * 保护名单（默认**绝不删**）：`AndroidManifest.xml`、`resources.arsc`、`classes*.dex`、
 * `META-INF/`、保留 ABI 的 `lib/<abi>/**`、`assets/bin/Data/**`（Unity 播放器数据）、
 * `assets/AB/Android/**`（游戏资源 + 清单/manifest）。想删资产类内容需显式 `--allow-risky`。
 *
 * 用法：
 *   pnpm run apk:slim -- --in <apk> --report                        # 只体检：各 ABI/分组占用 + 可删项
 *   pnpm run apk:slim -- --in <apk> --keep-abi arm64-v8a --out <apk> --sign
 *   pnpm run apk:slim -- --in <apk> --drop-prefix assets/mlkit_barcode_models/ --out <apk> --sign
 *   pnpm run apk:slim -- --in <apk> --drop assets/xx.bin --out <apk>
 */
import * as fs from "fs";
import * as path from "path";
import yauzl from "yauzl";
import { patchApk, inspectApk, verifyPatchedApk } from "./apk-patch";
import { signApk } from "./apk-sign";

/**
 * 「只留入口」预设：`assets/AB/Android/**` 下只保留**启动到登录/主界面**所需的组，
 * 其余内容组（立绘/战斗/皮肤/语音/场景/UI/共享引用等）走客户端热更按需下载。
 * 必备项另有兜底：`assets/bin/Data/**`（引擎数据）、`assets/AB/Android/*.idx` +
 * `hot_update_list.json`（清单/manifest，缺了客户端就不知道要下什么）、`anon/**`（含 Lua 引导 bundle）、
 * 根级 `[uc]*.ab`（着色器/口型同步）。
 */
const ENTRY_PRESET_KEEP_PREFIXES = [
  "assets/AB/Android/anon/",
  "assets/AB/Android/config/",
  "assets/AB/Android/charpack/",
  "assets/AB/Android/shaders/",
  "assets/AB/Android/building/",
  "assets/AB/Android/prefabs/",
  "assets/AB/Android/akvt/",
  "assets/AB/Android/cutin/",
  "assets/AB/Android/graphics/",
];
/** 预设下额外保留的精确条目（根级核心 bundle + 清单/manifest） */
const ENTRY_PRESET_KEEP_ENTRIES = [
  "assets/AB/Android/[uc]lipsync.ab",
  "assets/AB/Android/[uc]shaders.ab",
  "assets/AB/Android/[uc]uishaders.ab",
  "assets/AB/Android/hot_update_list.json",
  "assets/AB/Android/613696e0b7f401be75f635e43560cf93.idx",
  "assets/AB/Android/df176d96f660b5463c8c5257d04fb908.idx",
  "assets/AB/Android/empty",
];

/** 默认保留的 ABI */
const DEFAULT_KEEP_ABI = ["arm64-v8a"];
/** 永不删除的精确条目 */
const PROTECTED_ENTRIES = new Set(["AndroidManifest.xml", "resources.arsc"]);
/** 永不删除的前缀（默认；`--allow-risky` 时仅保留前四项） */
const PROTECTED_PREFIXES_ALWAYS = ["META-INF/", "classes"];
const PROTECTED_PREFIXES_SAFE = ["assets/bin/Data/", "assets/AB/", "res/"];

/** 单条条目信息 */
interface SlimEntry {
  /** 条目名 */
  name: string;
  /** 未压缩大小 */
  size: number;
  /** 压缩后大小 */
  compressed: number;
}

/** 体检结果 */
export interface SlimReport {
  /** 条目总数 */
  entryCount: number;
  /** 未压缩合计 */
  totalSize: number;
  /** 压缩后合计（≈APK 体积） */
  totalCompressed: number;
  /** 各 ABI 占用 */
  abis: { abi: string; count: number; size: number; compressed: number }[];
  /** 各组（顶层）占用 */
  groups: { group: string; count: number; size: number; compressed: number }[];
  /** 命中的可删条目（按规则） */
  dropped: SlimEntry[];
  /** 可删项压缩后合计（≈可省体积） */
  droppedCompressed: number;
}

/** 选项 */
export interface SlimOptions {
  /** 源 APK */
  inApk: string;
  /** 保留的 ABI 列表 */
  keepAbis: string[];
  /** 精确删除条目 */
  drop: string[];
  /** 前缀删除 */
  dropPrefixes: string[];
  /** 允许删除保护名单内的资产类内容（危险） */
  allowRisky: boolean;
  /** 「只留入口」预设：assets/AB 下只保留启动必需组 */
  entryPreset: boolean;
}

/**
 * 扫描 APK 并计算体检结果（不落盘）。
 * @param opts - 选项
 * @returns 体检结果（含将删除的条目）
 */
export function scanForSlim(opts: SlimOptions): Promise<SlimReport> {
  return new Promise((resolve, reject) => {
    const abi = new Map<string, { count: number; size: number; compressed: number }>();
    const groups = new Map<string, { count: number; size: number; compressed: number }>();
    const dropped: SlimEntry[] = [];
    let entryCount = 0;
    let totalSize = 0;
    let totalCompressed = 0;

    const alwaysProtected = (name: string): boolean =>
      PROTECTED_ENTRIES.has(name) ||
      PROTECTED_PREFIXES_ALWAYS.some((p) => (p === "classes" ? /^classes\d*\.dex$/.test(name) : name.startsWith(p))) ||
      opts.keepAbis.some((a) => name.startsWith(`lib/${a}/`));

    const safeProtected = (name: string): boolean =>
      PROTECTED_PREFIXES_SAFE.some((p) => name.startsWith(p));

    yauzl.open(opts.inApk, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(new Error(`APK 打开失败: ${err?.message ?? "unknown"}`));
      zf.on("entry", (e) => {
        if (/\/$/.test(e.fileName)) return zf.readEntry();
        entryCount++;
        totalSize += e.uncompressedSize;
        totalCompressed += e.compressedSize;

        const abiKey = /^lib\/([^/]+)\//.exec(e.fileName)?.[1];
        if (abiKey) {
          const cur = abi.get(abiKey) ?? { count: 0, size: 0, compressed: 0 };
          cur.count++;
          cur.size += e.uncompressedSize;
          cur.compressed += e.compressedSize;
          abi.set(abiKey, cur);
        }
        const groupKey = e.fileName.startsWith("lib/")
          ? `lib/${abiKey}`
          : e.fileName.split("/")[0];
        const g = groups.get(groupKey) ?? { count: 0, size: 0, compressed: 0 };
        g.count++;
        g.size += e.uncompressedSize;
        g.compressed += e.compressedSize;
        groups.set(groupKey, g);

        // 删除规则
        const byAbi = abiKey !== undefined && !opts.keepAbis.includes(abiKey);
        const byPrefix = opts.dropPrefixes.some((p) => e.fileName.startsWith(p));
        const byName = opts.drop.includes(e.fileName);
        // 「只留入口」预设：assets/AB/Android 下不在保留清单内的一律删（清单/manifest/anon 等已列入保留）
        const inAbTree = e.fileName.startsWith("assets/AB/Android/");
        const presetDrop =
          opts.entryPreset &&
          inAbTree &&
          !ENTRY_PRESET_KEEP_PREFIXES.some((p) => e.fileName.startsWith(p)) &&
          !ENTRY_PRESET_KEEP_ENTRIES.includes(e.fileName);
        if (byAbi || byPrefix || byName || presetDrop) {
          if (alwaysProtected(e.fileName)) {
            reject(
              new Error(
                `拒绝删除受保护条目：${e.fileName}（AndroidManifest/resources.arsc/classes*.dex/META-INF/保留 ABI 的 lib）`,
              ),
            );
            return;
          }
          if (!opts.allowRisky && !presetDrop && safeProtected(e.fileName)) {
            reject(
              new Error(
                `拒绝删除受保护资产：${e.fileName}（assets/bin/Data、assets/AB、res 默认受保护；确需删除请加 --allow-risky）`,
              ),
            );
            return;
          }
          dropped.push({ name: e.fileName, size: e.uncompressedSize, compressed: e.compressedSize });
        }
        zf.readEntry();
      });
      zf.on("end", () =>
        resolve({
          entryCount,
          totalSize,
          totalCompressed,
          abis: [...abi].map(([a, v]) => ({ abi: a, ...v })).sort((x, y) => y.size - x.size),
          groups: [...groups].map(([g, v]) => ({ group: g, ...v })).sort((x, y) => y.size - x.size),
          dropped,
          droppedCompressed: dropped.reduce((n, d) => n + d.compressed, 0),
        }),
      );
      zf.on("error", (e) => reject(new Error(`APK 扫描失败: ${e.message}`)));
      zf.readEntry();
    });
  });
}

/** CLI 参数 */
interface CliArgs extends SlimOptions {
  outApk: string;
  sign: boolean;
  outDir: string;
  report: boolean;
}

/**
 * 解析命令行参数。
 * @param argv - 参数（不含 node/脚本名）
 * @returns 解析结果
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inApk: "",
    outApk: "",
    keepAbis: [...DEFAULT_KEEP_ABI],
    drop: [],
    dropPrefixes: [],
    allowRisky: false,
    entryPreset: false,
    sign: false,
    outDir: path.join(__dirname, "..", "tmp", "apk-out"),
    report: false,
  };
  let keepAbiSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.inApk = argv[++i] ?? "";
    else if (a === "--out") args.outApk = argv[++i] ?? "";
    else if (a === "--keep-abi") {
      if (!keepAbiSet) {
        args.keepAbis = [];
        keepAbiSet = true;
      }
      args.keepAbis.push(argv[++i] ?? "");
    } else if (a === "--drop") args.drop.push(argv[++i] ?? "");
    else if (a === "--drop-prefix") args.dropPrefixes.push(argv[++i] ?? "");
    else if (a === "--allow-risky") args.allowRisky = true;
    else if (a === "--preset") args.entryPreset = (argv[++i] ?? "") === "entry";
    else if (a === "--sign") args.sign = true;
    else if (a === "--out-dir") args.outDir = argv[++i] ?? args.outDir;
    else if (a === "--report") args.report = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: pnpm run apk:slim -- --in <apk> [--report]\n" +
          "            [--keep-abi arm64-v8a]... [--preset entry] [--drop <zip条目>]... [--drop-prefix <前缀>]... [--allow-risky]\n" +
          "            [--out <出包.apk>] [--out-dir <目录>] [--sign]",
      );
      process.exit(0);
    }
  }
  return args;
}

/** CLI 入口 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inApk || !fs.existsSync(args.inApk)) {
    console.error(`[apk-slim] --in 必须是存在的 APK：${args.inApk || "(空)"}`);
    process.exit(1);
  }
  const info = inspectApk(args.inApk);
  console.log(
    `[apk-slim] 源: ${args.inApk}（${(info.fileSize / 1e6).toFixed(1)} MB，${info.entryCount} 条）`,
  );

  const report = await scanForSlim(args);
  if (args.entryPreset) {
    console.log("  [预设] entry —— assets/AB/Android 下仅保留启动必需组（清单/manifest/anon/核心 ab + 若干小目录）");
  }
  console.log(`  未压缩合计 ${(report.totalSize / 1e6).toFixed(1)} MB，压缩后 ${(report.totalCompressed / 1e6).toFixed(1)} MB`);
  console.log("  各 ABI：");
  for (const a of report.abis) {
    console.log(
      `    ${a.abi.padEnd(14)} ${String(a.count).padStart(3)} 条  未压缩 ${(a.size / 1e6).toFixed(1).padStart(7)} MB  压缩后 ${(a.compressed / 1e6).toFixed(1).padStart(7)} MB` +
        (args.keepAbis.includes(a.abi) ? "  ← 保留" : "  ← 删除"),
    );
  }
  console.log("  顶层分组（压缩后前 8）：");
  for (const g of report.groups.slice(0, 8)) {
    console.log(`    ${g.group.padEnd(16)} ${String(g.count).padStart(5)} 条  未压缩 ${(g.size / 1e6).toFixed(1).padStart(7)} MB  压缩后 ${(g.compressed / 1e6).toFixed(1).padStart(7)} MB`);
  }
  console.log(
    `  拟删除 ${report.dropped.length} 条 → 预计省 **${(report.droppedCompressed / 1e6).toFixed(1)} MB**（压缩后）`,
  );
  if (args.report) return;
  if (report.dropped.length === 0) {
    console.error("[apk-slim] 没有命中任何删除规则（可用 --keep-abi/--drop/--drop-prefix 指定）");
    process.exit(1);
  }

  const stem = path.basename(args.inApk).replace(/\.apk$/i, "");
  const out = args.outApk || path.join(args.outDir, `${stem}-slim.apk`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const t0 = Date.now();
  const patch = patchApk({
    inApk: args.inApk,
    outApk: out,
    replacements: [],
    drops: report.dropped.map((d) => d.name),
    stripV1: true,
    dryRun: false,
  });
  console.log(
    `[apk-slim] 写出 ${out}（${(patch.outSize / 1e6).toFixed(1)} MB，删除 ${patch.dropped.length} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );
  const problems = verifyPatchedApk(out, new Map());
  if (problems.length) {
    console.error("[apk-slim] 自检失败：");
    for (const p of problems.slice(0, 10)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[apk-slim] 自检通过（条目 CRC/布局/对齐）");
  if (args.sign) {
    // 以「实际输出文件名」为基准命名签名产物（--out 与默认名不一致时避免歧义）
    const outStem = path.basename(out).replace(/\.apk$/i, "");
    const signed = signApk({
      inApk: out,
      outDir: args.outDir,
      outApk: path.join(args.outDir, `${outStem}-signed.apk`),
    });
    console.log(`[apk-slim] 已签名: ${signed}`);
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[apk-slim] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
