/**
 * APK `assets/` 体检报告（清单 / 分组占用 / 魔数分类）
 *
 * 用途：搞清楚一个官方 APK 的 assets 里都是些什么、各占多大，为改包/精简提供依据
 * （结论记录见 `docs/apk-assets-analysis-2026-09-13.md`）。
 *
 * 用法：
 *   pnpm run apk:assets                      # 默认体检 assets 全部（分组 + 扩展名 + 根级文件）
 *   pnpm run apk:assets -- --in <apk> --top 20
 *   pnpm run apk:assets -- --filter "^assets/bin/Data/" [--list]   # 指定前缀 + 逐条列出（含魔数分类）
 *   pnpm run apk:assets -- --filter "^assets/AB/" --depth 3
 */
import * as fs from "fs";
import * as path from "path";
import yauzl from "yauzl";

/** 仓库根目录 */
const ROOT = path.join(__dirname, "..");

/** 条目信息 */
interface EntryInfo {
  /** zip 条目名 */
  name: string;
  /** 未压缩大小 */
  size: number;
  /** 压缩后大小 */
  compressed: number;
}

/** CLI 参数 */
interface CliArgs {
  inApk: string;
  filter: string;
  depth: number;
  top: number;
  list: boolean;
}

/**
 * 解析命令行参数。
 * @param argv - 参数（不含 node/脚本名）
 * @returns 解析结果
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inApk: "",
    filter: "^assets/",
    depth: 2,
    top: 12,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.inApk = argv[++i] ?? "";
    else if (a === "--filter") args.filter = argv[++i] ?? args.filter;
    else if (a === "--depth") args.depth = Number(argv[++i] ?? args.depth);
    else if (a === "--top") args.top = Number(argv[++i] ?? args.top);
    else if (a === "--list") args.list = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: pnpm run apk:assets -- [--in <apk>] [--filter <正则>] [--depth N] [--top N] [--list]",
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * 列出 APK 内匹配的条目。
 * @param apkPath - APK 路径
 * @param filter  - 条目名正则
 * @returns 条目列表
 */
function listEntries(apkPath: string, filter: RegExp): Promise<EntryInfo[]> {
  return new Promise((resolve, reject) => {
    const out: EntryInfo[] = [];
    yauzl.open(apkPath, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(new Error(`APK 打开失败: ${err?.message ?? "unknown"}`));
      zf.on("entry", (e) => {
        if (!/\/$/.test(e.fileName) && filter.test(e.fileName)) {
          out.push({ name: e.fileName, size: e.uncompressedSize, compressed: e.compressedSize });
        }
        zf.readEntry();
      });
      zf.on("end", () => resolve(out));
      zf.on("error", (e) => reject(new Error(`APK 扫描失败: ${e.message}`)));
      zf.readEntry();
    });
  });
}

/**
 * 读取条目前 N 字节（用于魔数判别）。
 * @param zf - zip 句柄
 * @param e  - 条目
 * @param n  - 字节数
 * @returns 头部字节（失败返回空）
 */
function headBytes(zf: yauzl.ZipFile, e: yauzl.Entry, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    zf.openReadStream(e, (err, rs) => {
      if (err || !rs) return resolve(Buffer.alloc(0));
      const chunks: Buffer[] = [];
      let total = 0;
      const done = (): void => resolve(Buffer.concat(chunks).subarray(0, n));
      rs.on("data", (c: Buffer) => {
        chunks.push(c);
        total += c.length;
        if (total >= n) rs.destroy();
      });
      rs.on("close", done);
      rs.on("end", done);
      rs.on("error", () => resolve(Buffer.alloc(0)));
    });
  });
}

/**
 * 按魔数给出文件格式判读。
 * @param b - 头部字节
 * @returns 格式描述
 */
export function classifyMagic(b: Buffer): string {
  const s = b.toString("latin1");
  if (s.startsWith("UnityFS")) return "UnityFS(AssetBundle)";
  if (s.startsWith("UnityWeb")) return "UnityWeb(压缩 bundle)";
  if (s.startsWith("UnityRaw")) return "UnityRaw";
  if (b.length >= 12 && b.readUInt32BE(0) === 0 && b.readUInt32BE(8) > 0) return "SerializedFile(裸 Unity 序列化)";
  if (s.startsWith("PK\x03\x04")) return "zip";
  if (s.startsWith("{") || s.startsWith("[")) return "JSON 文本";
  if (s.startsWith("-----BEGIN")) return "PEM 证书/密钥";
  if (s.startsWith("<!DOCTYPE") || s.startsWith("<html")) return "HTML";
  if (s.startsWith("dex\n")) return "DEX";
  if (b.subarray(0, 4).toString("hex") === "89504e47") return "PNG";
  if (b.subarray(0, 4).toString("hex") === "47494638") return "GIF";
  if (b.subarray(0, 4).toString("hex") === "00010000") return "TTF";
  if (b.subarray(0, 4).toString("hex") === "54464c33") return "TFLite";
  if (b.subarray(0, 2).toString("hex") === "1f8b") return "gzip";
  if (b.subarray(0, 6).toString("hex") === "007f547f537f43") return "TSS 加密配置";
  return "其它(分片/二进制)";
}

/**
 * 逐条列出并给出魔数分类。
 * @param apkPath - APK 路径
 * @param filter  - 条目名正则
 * @returns 带分类的条目列表
 */
async function listWithMagic(apkPath: string, filter: RegExp): Promise<{ name: string; size: number; kind: string }[]> {
  const out: { name: string; size: number; kind: string }[] = [];
  await new Promise<void>((resolve, reject) => {
    yauzl.open(apkPath, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(new Error(`APK 打开失败: ${err?.message ?? "unknown"}`));
      zf.on("entry", async (e) => {
        if (/\/$/.test(e.fileName) || !filter.test(e.fileName)) return zf.readEntry();
        const b = await headBytes(zf, e, 16);
        out.push({ name: e.fileName, size: e.uncompressedSize, kind: classifyMagic(b) });
        zf.readEntry();
      });
      zf.on("end", () => resolve());
      zf.on("error", (e) => reject(new Error(`APK 扫描失败: ${e.message}`)));
      zf.readEntry();
    });
  });
  return out;
}

/**
 * 按路径前 N 段聚合。
 * @param entries - 条目列表
 * @param depth   - 段数
 * @returns 分组（按未压缩大小降序）
 */
function groupBy(entries: EntryInfo[], depth: number): { key: string; n: number; size: number; compressed: number }[] {
  const m = new Map<string, { n: number; size: number; compressed: number }>();
  for (const e of entries) {
    const key = e.name.split("/").slice(0, depth).join("/");
    const cur = m.get(key) ?? { n: 0, size: 0, compressed: 0 };
    cur.n++;
    cur.size += e.size;
    cur.compressed += e.compressed;
    m.set(key, cur);
  }
  return [...m]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.size - a.size);
}

/** CLI 入口 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apk = args.inApk
    ? path.resolve(args.inApk)
    : path.join(ROOT, "tmp", "apk", "2.7.71", "arknights-hg-2771.apk");
  if (!fs.existsSync(apk)) {
    console.error(`[apk-assets] APK 不存在：${apk}（可用 --in 指定）`);
    process.exit(1);
  }
  const filter = new RegExp(args.filter);
  console.log(`[apk-assets] ${apk}\n  过滤：${args.filter}`);

  const entries = await listEntries(apk, filter);
  const totalSize = entries.reduce((n, e) => n + e.size, 0);
  const totalCompressed = entries.reduce((n, e) => n + e.compressed, 0);
  console.log(
    `  命中 ${entries.length} 条，未压缩 ${(totalSize / 1e6).toFixed(1)} MB，压缩后 ${(totalCompressed / 1e6).toFixed(1)} MB（zip 内实际占用）`,
  );

  console.log(`\n== 前 ${args.depth} 段分组（top ${args.top}）==`);
  for (const g of groupBy(entries, args.depth).slice(0, args.top)) {
    console.log(
      `  ${g.key.padEnd(34)} ${String(g.n).padStart(5)} 条 未压缩 ${(g.size / 1e6).toFixed(1).padStart(8)} MB  压缩后 ${(g.compressed / 1e6).toFixed(1).padStart(8)} MB`,
    );
  }

  const ext = new Map<string, { n: number; size: number }>();
  for (const e of entries) {
    const x = (/\.[^./]+$/.exec(e.name) ?? ["(无扩展名)"])[0].toLowerCase();
    const cur = ext.get(x) ?? { n: 0, size: 0 };
    cur.n++;
    cur.size += e.size;
    ext.set(x, cur);
  }
  console.log("\n== 扩展名（top 12）==");
  for (const [k, v] of [...ext].sort((a, b) => b[1].size - a[1].size).slice(0, 12)) {
    console.log(`  ${k.padEnd(16)} ${String(v.n).padStart(5)} 条 ${(v.size / 1e6).toFixed(1).padStart(8)} MB`);
  }

  if (args.list) {
    console.log("\n== 逐条（含魔数分类）==");
    const rows = await listWithMagic(apk, filter);
    for (const r of rows) {
      console.log(`  ${(r.size / 1024).toFixed(1).padStart(10)} KB  ${r.kind.padEnd(26)} ${r.name}`);
    }
    const byKind = new Map<string, { n: number; size: number }>();
    for (const r of rows) {
      const cur = byKind.get(r.kind) ?? { n: 0, size: 0 };
      cur.n++;
      cur.size += r.size;
      byKind.set(r.kind, cur);
    }
    console.log("\n== 魔数分类汇总 ==");
    for (const [k, v] of [...byKind].sort((a, b) => b[1].size - a[1].size)) {
      console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(5)} 条 ${(v.size / 1e6).toFixed(1).padStart(8)} MB`);
    }
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[apk-assets] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
