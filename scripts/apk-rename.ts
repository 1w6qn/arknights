/**
 * APK 包名改写器（等长二进制替换，用于改包共存）
 *
 * 为什么是「等长替换」：AndroidManifest.xml 是二进制 AXML、resources.arsc 是资源表、classes*.dex 是
 * DEX —— 三者的字符串都以「字符串池 + 索引引用」组织。把包名整体换成**字节长度完全相同**的新名，
 * 池内长度字段、偏移、索引全部保持不变，因此无需反编译/回编译（apktool 全量重打包 1.9GB 包既慢又易
 * 引入资源重编码风险）。dex 另需按 DEX 规范重算头部 Adler-32 校验与 SHA-1 签名。
 *
 * 默认改写范围：`AndroidManifest.xml`、`resources.arsc`、`classes*.dex`、`assets/**` 文本配置；
 * **默认不动 `lib/*.so`**（ACE/TSS 反作弊库内含同名常量，改它反而可能触发其自校验；需要时用
 * `--include-native` 一并替换）。`META-INF/*` 由 `apk-patch` 统一抹除，无需处理。
 *
 * 用法：
 *   pnpm run apk:rename -- --scan --in <apk> [--from com.hypergryph.arknights]
 *   pnpm run apk:rename -- --in <apk> --to com.hypergryph.arkmumu12 --out <出包.apk> --sign
 *   pnpm run apk:rename -- --in <apk> --to <新名> --replace <zip条目>=<本地文件> --out <出包> --sign
 *   pnpm run apk:rename -- --in <apk> --to <新名> --include-native --out <出包>
 *
 * 注：`--to` 必须与 `--from` **字节等长**；24 字符候选示例：`com.hypergryph.arkmumu12`。
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import yauzl from "yauzl";
import { patchApk, verifyPatchedApk, inspectApk, type ApkReplacement } from "./apk-patch";
import { signApk } from "./apk-sign";

/** 默认原包名 */
const DEFAULT_FROM = "com.hypergryph.arknights";
/** 单个条目参与扫描/改写的体积上限（超过者只可能是 so/ab 大资产，默认跳过并提示） */
const SCAN_MAX_BYTES = 32 * 1024 * 1024;

/** 命中记录 */
export interface RenameHit {
  /** zip 条目名 */
  entry: string;
  /** 解压后大小 */
  size: number;
  /** ASCII 命中次数 */
  ascii: number;
  /** UTF-16LE 命中次数 */
  utf16: number;
}

/** 选项 */
export interface RenameOptions {
  /** 源 APK */
  inApk: string;
  /** 原包名 */
  from: string;
  /** 新包名（必须与 from 等长） */
  to: string;
  /** 是否连 `lib/*.so` 一起替换 */
  includeNative: boolean;
}

/**
 * 计算 Adler-32（DEX 头部校验用；zlib 只提供 CRC32，故自带实现）。
 * @param buf - 输入数据
 * @returns Adler-32 值（无符号 32 位）
 */
function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * 按 DEX 规范重算头部：signature = SHA-1(bytes[32..]) 写入 [12,32)，checksum = Adler-32(bytes[12..]) 写入 [8,12)。
 * @param dex - DEX 字节（就地修改）
 */
function fixDexHeader(dex: Buffer): void {
  if (dex.length < 32 || dex.subarray(0, 4).toString("latin1") !== "dex\n") return;
  crypto.createHash("sha1").update(dex.subarray(32)).digest().copy(dex, 12);
  dex.writeUInt32LE(adler32(dex.subarray(12)), 8);
}

/**
 * 替换 buffer 中所有 ASCII / UTF-16LE 形式的包名。
 * @param buf  - 输入字节（就地修改）
 * @param from - 原包名
 * @param to   - 新包名（等长）
 * @returns 替换次数
 */
function replaceInBuffer(buf: Buffer, from: string, to: string): number {
  let n = 0;
  for (const enc of ["ascii", "utf16le"] as const) {
    const pat = Buffer.from(from, enc);
    const rep = Buffer.from(to, enc);
    let i = buf.indexOf(pat);
    while (i >= 0) {
      rep.copy(buf, i);
      n++;
      i = buf.indexOf(pat, i + rep.length);
    }
  }
  return n;
}

/**
 * 扫描 APK 内包名出现位置（跳过 META-INF 与（可选的）lib/*.so）。
 * @param opts - 扫描选项
 * @returns 命中列表
 */
export function scanPackageName(opts: RenameOptions): Promise<RenameHit[]> {
  const pats = [Buffer.from(opts.from, "ascii"), Buffer.from(opts.from, "utf16le")];
  const hits: RenameHit[] = [];
  return new Promise((resolve, reject) => {
    yauzl.open(opts.inApk, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(new Error(`APK 打开失败: ${err?.message ?? "unknown"}`));
      zf.on("entry", (e) => {
        if (
          /\/$/.test(e.fileName) ||
          /^META-INF\//i.test(e.fileName) ||
          (!opts.includeNative && /^lib\/.+\.so$/i.test(e.fileName)) ||
          e.uncompressedSize > SCAN_MAX_BYTES
        ) {
          return zf.readEntry();
        }
        zf.openReadStream(e, (openErr, rs) => {
          if (openErr || !rs) return zf.readEntry();
          const chunks: Buffer[] = [];
          rs.on("data", (c: Buffer) => chunks.push(c));
          rs.on("error", reject);
          rs.on("end", () => {
            const buf = Buffer.concat(chunks);
            let ascii = 0;
            let utf16 = 0;
            for (const p of [pats[0]]) {
              let i = buf.indexOf(p);
              while (i >= 0) {
                ascii++;
                i = buf.indexOf(p, i + 1);
              }
            }
            let j = buf.indexOf(pats[1]);
            while (j >= 0) {
              utf16++;
              j = buf.indexOf(pats[1], j + 1);
            }
            if (ascii > 0 || utf16 > 0) hits.push({ entry: e.fileName, size: buf.length, ascii, utf16 });
            zf.readEntry();
          });
        });
      });
      zf.on("end", () => resolve(hits));
      zf.on("error", (e) => reject(new Error(`APK 扫描失败: ${e.message}`)));
      zf.readEntry();
    });
  });
}

/**
 * 构造包名改写的替换集（含 dex 头部修正）。
 * @param opts - 改名选项
 * @returns 替换集与命中统计
 */
export async function buildRenameReplacements(
  opts: RenameOptions,
): Promise<{ replacements: ApkReplacement[]; hits: RenameHit[] }> {
  const pats = [Buffer.from(opts.from, "ascii"), Buffer.from(opts.from, "utf16le")];
  const replacements: ApkReplacement[] = [];
  const hits: RenameHit[] = [];
  await new Promise<void>((resolve, reject) => {
    yauzl.open(opts.inApk, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(new Error(`APK 打开失败: ${err?.message ?? "unknown"}`));
      zf.on("entry", (e) => {
        if (
          /\/$/.test(e.fileName) ||
          /^META-INF\//i.test(e.fileName) ||
          (!opts.includeNative && /^lib\/.+\.so$/i.test(e.fileName)) ||
          e.uncompressedSize > SCAN_MAX_BYTES
        ) {
          return zf.readEntry();
        }
        zf.openReadStream(e, (openErr, rs) => {
          if (openErr || !rs) return zf.readEntry();
          const chunks: Buffer[] = [];
          rs.on("data", (c: Buffer) => chunks.push(c));
          rs.on("error", reject);
          rs.on("end", () => {
            const buf = Buffer.concat(chunks);
            const stat = { entry: e.fileName, size: buf.length, ascii: 0, utf16: 0 };
            let i = buf.indexOf(pats[0]);
            while (i >= 0) {
              stat.ascii++;
              i = buf.indexOf(pats[0], i + 1);
            }
            let j = buf.indexOf(pats[1]);
            while (j >= 0) {
              stat.utf16++;
              j = buf.indexOf(pats[1], j + 1);
            }
            if (stat.ascii > 0 || stat.utf16 > 0) {
              const n = replaceInBuffer(buf, opts.from, opts.to);
              if (/\.dex$/i.test(e.fileName)) fixDexHeader(buf);
              hits.push(stat);
              replacements.push({ entry: e.fileName, data: buf });
              console.log(
                `[apk-rename] ${e.fileName}: ${stat.ascii} ascii / ${stat.utf16} utf16 → 替换 ${n} 处` +
                  `${/\.dex$/i.test(e.fileName) ? "（已重算 dex 头校验）" : ""}`,
              );
            }
            zf.readEntry();
          });
        });
      });
      zf.on("end", () => resolve());
      zf.on("error", (e) => reject(new Error(`APK 扫描失败: ${e.message}`)));
      zf.readEntry();
    });
  });
  return { replacements, hits };
}

/** CLI 参数 */
interface CliArgs {
  inApk: string;
  outApk: string;
  from: string;
  to: string;
  includeNative: boolean;
  scan: boolean;
  sign: boolean;
  outDir: string;
  replace: string[];
  add: string[];
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
    from: DEFAULT_FROM,
    to: "",
    includeNative: false,
    scan: false,
    sign: false,
    outDir: path.join(__dirname, "..", "tmp", "apk-out"),
    replace: [],
    add: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.inApk = argv[++i] ?? "";
    else if (a === "--out") args.outApk = argv[++i] ?? "";
    else if (a === "--from") args.from = argv[++i] ?? args.from;
    else if (a === "--to") args.to = argv[++i] ?? "";
    else if (a === "--include-native") args.includeNative = true;
    else if (a === "--scan") args.scan = true;
    else if (a === "--sign") args.sign = true;
    else if (a === "--out-dir") args.outDir = argv[++i] ?? args.outDir;
    else if (a === "--replace") args.replace.push(argv[++i] ?? "");
    else if (a === "--add") args.add.push(argv[++i] ?? "");
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: pnpm run apk:rename -- --in <apk> [--scan] [--from <旧包名>] --to <新包名> [--include-native]\n" +
          "            [--replace <zip条目>=<本地文件>]... [--add <zip条目>=<本地文件>]...\n" +
          "            [--out <出包.apk>] [--out-dir <签名输出目录>] [--sign]",
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
    console.error(`[apk-rename] --in 必须是存在的 APK：${args.inApk || "(空)"}`);
    process.exit(1);
  }

  if (args.scan) {
    const hits = await scanPackageName({ inApk: args.inApk, from: args.from, to: args.from, includeNative: args.includeNative });
    console.log(`[apk-rename] 包名 "${args.from}" 命中 ${hits.length} 个条目：`);
    for (const h of hits) {
      console.log(`  ${String(h.ascii).padStart(3)} ascii / ${String(h.utf16).padStart(3)} utf16  ${(h.size / 1e6).toFixed(2)} MB  ${h.entry}`);
    }
    console.log("[apk-rename] 提示：默认不替换 lib/*.so（ACE/TSS 反作弊库），需一并替换加 --include-native");
    return;
  }

  if (!args.to) {
    console.error("[apk-rename] 需要 --to <新包名>（或 --scan 只查看）");
    process.exit(1);
  }
  const fromLen = Buffer.byteLength(args.from, "utf8");
  const toLen = Buffer.byteLength(args.to, "utf8");
  if (fromLen !== toLen) {
    console.error(
      `[apk-rename] 新旧包名必须等长（等长替换才能免反编译）："${args.from}"=${fromLen} 字节，"${args.to}"=${toLen} 字节。` +
        `\n            24 字节候选示例：com.hypergryph.arkmumu12`,
    );
    process.exit(1);
  }

  const info = inspectApk(args.inApk);
  console.log(`[apk-rename] 源: ${args.inApk}（${(info.fileSize / 1e6).toFixed(1)} MB，${info.entryCount} 条）`);
  const { replacements, hits } = await buildRenameReplacements({
    inApk: args.inApk,
    from: args.from,
    to: args.to,
    includeNative: args.includeNative,
  });
  if (replacements.length === 0) {
    console.error(`[apk-rename] 未找到包名 "${args.from}"，无须改写`);
    process.exit(1);
  }
  console.log(`[apk-rename] 改写 ${replacements.length} 个条目（命中 ${hits.length}）`);

  for (const raw of args.replace) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      console.error(`[apk-rename] --replace 格式应为 <zip条目>=<本地文件>，收到: ${raw}`);
      process.exit(1);
    }
    replacements.push({ entry: raw.slice(0, eq), file: raw.slice(eq + 1) });
  }

  const additions: ApkReplacement[] = [];
  for (const raw of args.add) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      console.error(`[apk-rename] --add 格式应为 <zip条目>=<本地文件>，收到: ${raw}`);
      process.exit(1);
    }
    additions.push({ entry: raw.slice(0, eq), file: raw.slice(eq + 1) });
  }

  const out = args.outApk || path.join(args.outDir, `${path.basename(args.inApk).replace(/\.apk$/i, "")}-renamed.apk`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const t0 = Date.now();
  const report = patchApk({
    inApk: args.inApk,
    outApk: out,
    replacements,
    additions,
    stripV1: true,
    dryRun: false,
  });
  console.log(
    `[apk-rename] 写出 ${out}（${(report.outSize / 1e6).toFixed(1)} MB，替换 ${report.replaced.length} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );
  const problems = verifyPatchedApk(out, new Map(report.replaced.map((r) => [r.entry, r.newCrc])));
  if (problems.length) {
    console.error("[apk-rename] 自检失败：");
    for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
    process.exit(1);
  }

  // 反查：输出包里旧包名应已清零（native 未替换时除外）
  const left = await scanPackageName({ inApk: out, from: args.from, to: args.from, includeNative: args.includeNative });
  if (left.length > 0) {
    console.error("[apk-rename] 仍有旧包名残留：");
    for (const h of left) console.error(`  - ${h.entry}（${h.ascii} ascii / ${h.utf16} utf16）`);
    process.exit(1);
  }
  console.log(
    `[apk-rename] 自检通过：旧包名已清零${args.includeNative ? "（含 native）" : "（lib/*.so 按默认保留）"}，新包名 ${args.to}`,
  );

  if (args.sign) {
    const stem = path.basename(out).replace(/\.apk$/i, "");
    const signed = signApk({
      inApk: out,
      outDir: args.outDir,
      outApk: path.join(args.outDir, `${stem}-signed.apk`),
    });
    console.log(`[apk-rename] 已签名: ${signed}`);
  } else {
    console.log("[apk-rename] 提示：加 --sign 可自动重签，否则用 apk:sign 手动重签");
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[apk-rename] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
