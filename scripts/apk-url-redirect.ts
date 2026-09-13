/**
 * APK 官服域名等长改写器（把客户端流量导到私服）
 *
 * 背景：MuMu 上的 ARM 翻译让 Frida 无法枚举 guest 模块（`libil2cpp.so`/`libunity.so`），
 * C# 级 hotfix 走不通；而客户端所有网络入口（`network_config`/`remote_config`/`launcher` 等）
 * 都是 `sharedassets1.assets.split*` 里 **Unity 序列化字符串表** 中的字面量。
 *
 * 做法：**等长替换**——`https://<host>`（8 字节 scheme）改成 `http://<host>x`（7 字节 scheme +
 * 主机名多 1 字符），整串字节数不变 ⇒ 字符串池长度前缀/偏移全部不变，无需重建 SerializedFile。
 * 设备侧再把 `*x.hypergryph.com` 写进 `/etc/hosts` → 127.0.0.1，并用 `adb reverse tcp:80 tcp:8443`
 * 把 80 端口转到私服 ⇒ 客户端天然走私服，服务端重写的 `hot_update_list.json`（含 mod 条目）
 * 与 `mods/*.dat` 才会生效。
 *
 * 用法：
 *   pnpm run apk:url-redirect -- --in <官方.apk> --out <出包.apk> [--sign]
 *   pnpm run apk:url-redirect -- --in <apk> --list                     # 只列出命中的域名与次数
 *   pnpm run apk:url-redirect -- --in <apk> --map a.com=ax.com ...      # 自定义映射（仍需等长）
 *   pnpm run apk:url-redirect -- --in <apk> --keep-scheme                # 只换主机名（长度仍须等长）
 */
import * as fs from "fs";
import * as path from "path";
import yauzl from "yauzl";
import { patchApk, inspectApk, verifyPatchedApk, type ApkReplacement } from "./apk-patch";
import { signApk } from "./apk-sign";

/** Unity 资源条目（URL 字面量所在的分片文件） */
const ASSET_ENTRY_RE = /^assets\/bin\/Data\/sharedassets\d*\.assets(\.split\d+)?$/i;

/** 默认改写映射：官方生产域名 → 等长（+1 字符）主机名（去掉 `https://` 的 1 字节后总长不变） */
const DEFAULT_HOST_MAP: { from: string; to: string }[] = [
  { from: "ak-conf.hypergryph.com", to: "ak-confx.hypergryph.com" },
  { from: "launcher.hypergryph.com", to: "launcherx.hypergryph.com" },
  { from: "game-config.hypergryph.com", to: "game-configx.hypergryph.com" },
  { from: "core-api-account-stable.hypergryph.net", to: "core-api-account-stablex.hypergryph.net" },
  { from: "ak-asset.hypergryph.com", to: "ak-assetx.hypergryph.com" },
  { from: "ak-webview.hypergryph.com", to: "ak-webviewx.hypergryph.com" },
  { from: "ak-gs-gf-audit.hypergryph.com", to: "ak-gs-gf-auditx.hypergryph.com" },
  { from: "ak.hycdn.cn", to: "akx.hycdn.cn" },
  { from: "ak.hypergryph.com", to: "akx.hypergryph.com" },
];

/** 命中统计 */
export interface UrlHit {
  /** zip 条目名 */
  entry: string;
  /** 原主机名 */
  from: string;
  /** 新主机名 */
  to: string;
  /** 替换次数（https 与 http 合计） */
  count: number;
}

/** 选项 */
export interface UrlRedirectOptions {
  /** 源 APK */
  inApk: string;
  /** 域名映射（必须等长：to.length === from.length + (https→http 时的 1)） */
  map: { from: string; to: string }[];
  /** 同时把 https 降级为 http（默认 true） */
  downgradeScheme: boolean;
}

/**
 * 计算一个 zip 条目内的改写（等长校验 + 计数）。
 * @param buf          - 条目内容
 * @param map          - 域名映射
 * @param downgrade    - 是否降级 scheme
 * @returns 命中统计（未命中返回空数组）
 */
function rewriteEntry(buf: Buffer, map: { from: string; to: string }[], downgrade: boolean): { hits: UrlHit[]; out: Buffer } {
  const hits: UrlHit[] = [];
  let out = buf;
  for (const m of map) {
    const delta = downgrade ? 1 : 0;
    if (m.to.length !== m.from.length + delta) {
      throw new Error(
        `映射不等长：${m.from}(${m.from.length}) → ${m.to}(${m.to.length})，` +
          `降级 scheme 时要求 to 比 from 长 1 个字符`,
      );
    }
    for (const scheme of downgrade ? (["https"] as const) : (["https", "http"] as const)) {
      const fromStr = `${scheme}://${m.from}`;
      const toStr = `${downgrade ? "http" : scheme}://${m.to}`;
      if (fromStr.length !== toStr.length) continue;
      let count = 0;
      let idx = out.indexOf(Buffer.from(fromStr, "latin1"));
      if (idx < 0) continue;
      const next = Buffer.from(out);
      while (idx >= 0) {
        Buffer.from(toStr, "latin1").copy(next, idx);
        count++;
        idx = next.indexOf(Buffer.from(fromStr, "latin1"), idx + toStr.length);
      }
      out = next;
      hits.push({ entry: "", from: `${scheme}://${m.from}`, to: toStr, count });
    }
  }
  return { hits, out };
}

/**
 * 扫描 APK 内 Unity 资源条目，计算 URL 改写替换集。
 * @param opts - 选项
 * @returns 替换集与命中统计
 */
export function buildUrlReplacements(opts: UrlRedirectOptions): Promise<{ replacements: ApkReplacement[]; hits: UrlHit[] }> {
  const replacements: ApkReplacement[] = [];
  const allHits: UrlHit[] = [];
  return new Promise((resolve, reject) => {
    yauzl.open(opts.inApk, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(new Error(`APK 打开失败: ${err?.message ?? "unknown"}`));
      zf.on("entry", (e) => {
        if (!ASSET_ENTRY_RE.test(e.fileName)) return zf.readEntry();
        zf.openReadStream(e, (openErr, rs) => {
          if (openErr || !rs) return zf.readEntry();
          const chunks: Buffer[] = [];
          rs.on("data", (c: Buffer) => chunks.push(c));
          rs.on("error", reject);
          rs.on("end", () => {
            const buf = Buffer.concat(chunks);
            let result: { hits: UrlHit[]; out: Buffer };
            try {
              result = rewriteEntry(buf, opts.map, opts.downgradeScheme);
            } catch (x) {
              return reject(x instanceof Error ? x : new Error(String(x)));
            }
            if (result.hits.length > 0) {
              for (const h of result.hits) allHits.push({ ...h, entry: e.fileName });
              replacements.push({ entry: e.fileName, data: result.out });
              console.log(
                `[apk-url] ${e.fileName}: ${result.hits.map((h) => `${h.from}→${h.to}×${h.count}`).join(", ")}`,
              );
            }
            zf.readEntry();
          });
        });
      });
      zf.on("end", () => resolve({ replacements, hits: allHits }));
      zf.on("error", (e) => reject(new Error(`APK 扫描失败: ${e.message}`)));
      zf.readEntry();
    });
  });
}

/** CLI 参数 */
interface CliArgs {
  inApk: string;
  outApk: string;
  map: { from: string; to: string }[];
  downgradeScheme: boolean;
  list: boolean;
  sign: boolean;
  outDir: string;
  add: string[];
  replace: string[];
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
    map: DEFAULT_HOST_MAP,
    downgradeScheme: true,
    list: false,
    sign: false,
    outDir: path.join(__dirname, "..", "tmp", "apk-out"),
    add: [],
    replace: [],
  };
  const custom: { from: string; to: string }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.inApk = argv[++i] ?? "";
    else if (a === "--out") args.outApk = argv[++i] ?? "";
    else if (a === "--out-dir") args.outDir = argv[++i] ?? args.outDir;
    else if (a === "--map") {
      const raw = argv[++i] ?? "";
      const eq = raw.indexOf("=");
      if (eq <= 0) {
        console.error(`[apk-url] --map 格式应为 <原主机>=<新主机>，收到: ${raw}`);
        process.exit(1);
      }
      custom.push({ from: raw.slice(0, eq), to: raw.slice(eq + 1) });
    } else if (a === "--keep-scheme") args.downgradeScheme = false;
    else if (a === "--list") args.list = true;
    else if (a === "--sign") args.sign = true;
    else if (a === "--add") args.add.push(argv[++i] ?? "");
    else if (a === "--replace") args.replace.push(argv[++i] ?? "");
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: pnpm run apk:url-redirect -- --in <apk> [--list] [--map <原主机>=<新主机>]... [--keep-scheme]\n" +
          "            [--add <zip条目>=<本地文件>]... [--replace <zip条目>=<本地文件>]...\n" +
          "            [--out <出包.apk>] [--out-dir <签名输出目录>] [--sign]",
      );
      process.exit(0);
    }
  }
  if (custom.length > 0) args.map = custom;
  return args;
}

/** CLI 入口 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inApk || !fs.existsSync(args.inApk)) {
    console.error(`[apk-url] --in 必须是存在的 APK：${args.inApk || "(空)"}`);
    process.exit(1);
  }
  console.log(`[apk-url] 映射 ${args.map.length} 条（scheme ${args.downgradeScheme ? "https→http" : "保持"}）`);
  const info = inspectApk(args.inApk);
  console.log(`[apk-url] 源: ${args.inApk}（${(info.fileSize / 1e6).toFixed(1)} MB，${info.entryCount} 条）`);

  const { replacements, hits } = await buildUrlReplacements({
    inApk: args.inApk,
    map: args.map,
    downgradeScheme: args.downgradeScheme,
  });
  if (args.list) {
    console.log(`[apk-url] 命中 ${hits.length} 处：`);
    for (const h of hits) console.log(`  ${h.entry}  ${h.from} → ${h.to} ×${h.count}`);
    return;
  }
  if (replacements.length === 0) {
    console.error("[apk-url] 未命中任何域名，未做改动");
    process.exit(1);
  }

  for (const raw of [...args.replace, ...args.add]) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      console.error(`[apk-url] 条目参数格式应为 <zip条目>=<本地文件>，收到: ${raw}`);
      process.exit(1);
    }
  }
  const additions: ApkReplacement[] = args.add.map((raw) => {
    const eq = raw.indexOf("=");
    return { entry: raw.slice(0, eq), file: raw.slice(eq + 1) };
  });
  for (const raw of args.replace) {
    const eq = raw.indexOf("=");
    replacements.push({ entry: raw.slice(0, eq), file: raw.slice(eq + 1) });
  }

  const stem = path.basename(args.inApk).replace(/\.apk$/i, "");
  const out = args.outApk || path.join(args.outDir, `${stem}-urlredirect.apk`);
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
    `[apk-url] 写出 ${out}（${(report.outSize / 1e6).toFixed(1)} MB，替换 ${report.replaced.length} 条，新增 ${report.added.length} 条，${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );
  const problems = verifyPatchedApk(out, new Map([...report.replaced, ...report.added].map((r) => [r.entry, r.newCrc])));
  if (problems.length) {
    console.error("[apk-url] 自检失败：");
    for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[apk-url] 自检通过；设备侧还需 hosts + adb reverse（见 docs/apk-mod-2771-2026-09-13.md §8.7）");

  if (args.sign) {
    const signed = signApk({ inApk: out, outDir: args.outDir, outApk: path.join(args.outDir, `${stem}-urlredirect-signed.apk`) });
    console.log(`[apk-url] 已签名: ${signed}`);
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[apk-url] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
