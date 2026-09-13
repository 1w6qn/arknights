/**
 * 活动资源回填（历史热更清单 → 当前版本资源目录）
 *
 * 背景：官方会从当前版本的 hot_update_list 里移除已下线活动/赛季的 bundle（如卫戍协议
 * `act1autochess` / `act1vautochess` / `act2autochess` 的场景、UI、音乐），但私服切到这些
 * 活动时客户端仍会按 AB 名请求它们——当前版本 CDN 上这些文件已 404，只能从**历史 resVersion**
 * 取。`app/ops/assets/asset-backfill.ts` 已实现「按需补全」（请求失败时探测历史版本），
 * 本脚本是它的**离线预取**版本：直接从已抓取的历史热更清单里查出每个 bundle 存在于哪些
 * resVersion，挑最新的一版下载并落盘到
 *   `assets/<当前官方版本>/redirect/<扁平下载名>.dat`
 * ——该目录正是 asset.ts 的「官方版本目录」（mod 签名版本与直连版本共享命中），
 * 落盘后私服即可离线直出，无需再走 CDN 探测。
 *
 * 数据来源：`reference/hotupdate/android/` 下的历史清单（见 scripts/fetch-hotupdate-history.ts）。
 *
 * 用法：
 *   pnpm run backfill:activity-assets                                  # 卫戍协议（Android 当前版本）
 *   pnpm run backfill:activity-assets -- --dry-run                     # 只列将抓取的 bundle
 *   pnpm run backfill:activity-assets -- --pattern "autochess|crisis"  # 自定义 bundle 名正则
 *   pnpm run backfill:activity-assets -- --platform Windows --lists reference/hotupdate/windows
 *   pnpm run backfill:activity-assets -- --include-present --force     # 连当前清单已有的也重下
 *
 * 幂等：目标文件已存在且体积与清单 totalSize 一致则跳过（--force 重下）；
 * 同一 bundle 若最新版本已从 CDN 清理，自动向更旧版本回退。
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "..");
/** 资源根目录（对齐 asset.ts ASSETS_DIR） */
const ASSETS_DIR = join(ROOT, "assets");
/** 默认历史清单目录（Android） */
const DEFAULT_LISTS = join(ROOT, "reference/hotupdate/android");
/** 默认 bundle 名筛选（卫戍协议：act1autochess / act1vautochess / act2autochess / ui/autochess / map_autochess） */
const DEFAULT_PATTERN = "autochess";

/** 平台 */
type Platform = "Android" | "Windows";

/** 各服官方 CDN 根（不含 /<platform>/assets 前缀） */
const REGION_CDN: Record<string, string> = {
  CN: "https://ak.hycdn.cn/assetbundle/official",
  TC: "https://ak-tw.hg-cdn.com/assetbundle/official",
  JP: "https://ak-jp.hg-cdn.com/assetbundle/official",
  EN: "https://ak-gp.hg-cdn.com/assetbundle/official",
  KR: "https://ak-kr.hg-cdn.com/assetbundle/official",
};

/** CDN 常量（对齐 asset.ts） */
const CDN_TIMEOUT = 30_000;
const DOWNLOAD_CONCURRENCY = 4;
const DOWNLOAD_RETRIES = 2;

/** 热更清单中本脚本用到的字段 */
interface AbInfo {
  name: string;
  hash?: string;
  md5?: string;
  totalSize?: number;
  cid?: number;
}

/** 热更清单 */
interface HotUpdateList {
  versionId?: string;
  abInfos?: AbInfo[];
}

/** 某个 bundle 在某个版本的出现记录 */
interface SourceEntry {
  region: string;
  resVersion: string;
  flatName: string;
  totalSize: number;
}

/** CLI 选项 */
interface Options {
  pattern: string;
  platform: Platform;
  version: string;
  lists: string;
  regions: string[];
  dryRun: boolean;
  includePresent: boolean;
  force: boolean;
  report: string;
  concurrency: number;
}

/** 单条处理结果 */
interface Result {
  name: string;
  flatName: string;
  sourceVersion: string;
  bytes: number;
  status: "ok" | "exists" | "missing" | "failed";
  note: string;
}

/**
 * bundle 名 → 客户端扁平下载名（对齐 asset.ts loadMods 规则：`/`→`_`、`#`→`__`、去扩展名、补 `.dat`）。
 *
 * @param name - 官方 bundle 名
 * @returns 扁平下载名
 */
function flattenBundleName(name: string): string {
  return name.replace(/\//g, "_").replace(/#/g, "__").split(".")[0] + ".dat";
}

/**
 * 读取 data/config.json 里的版本号（避免引入 app 的 config 单例，脚本可独立运行）。
 *
 * @param platform - 平台
 * @returns 该平台当前官方 resVersion
 */
async function configVersion(platform: Platform): Promise<string> {
  const cfg: { version?: { resVersion?: string; windows?: { resVersion?: string } } } = JSON.parse(
    await readFile(join(ROOT, "data/config.json"), "utf8"),
  );
  const v = platform === "Windows" ? cfg.version?.windows?.resVersion : cfg.version?.resVersion;
  if (!v) throw new Error(`data/config.json 缺少 version.${platform === "Windows" ? "windows." : ""}resVersion`);
  return v;
}

/**
 * 解析命令行参数。
 *
 * @param argv - `process.argv.slice(2)`
 * @returns 归一化选项
 */
async function parseArgs(argv: string[]): Promise<Options> {
  const opts: Options = {
    pattern: DEFAULT_PATTERN,
    platform: "Android",
    version: "",
    lists: DEFAULT_LISTS,
    regions: ["CN"],
    dryRun: false,
    includePresent: false,
    force: false,
    report: "",
    concurrency: DOWNLOAD_CONCURRENCY,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    /** 取下一个参数值，缺失即报错 */
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} 缺少参数`);
      return v;
    };
    switch (arg) {
      case "--pattern":
        opts.pattern = next();
        break;
      case "--platform": {
        const p = next();
        if (p !== "Android" && p !== "Windows") throw new Error(`未知平台：${p}`);
        opts.platform = p;
        break;
      }
      case "--version":
        opts.version = next();
        break;
      case "--lists":
        opts.lists = resolve(next());
        break;
      case "--region":
        opts.regions = next()
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length > 0);
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, Number.parseInt(next(), 10) || 1);
        break;
      case "--report":
        opts.report = resolve(next());
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--include-present":
        opts.includePresent = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`未知参数：${arg}`);
    }
  }
  if (!opts.version) opts.version = await configVersion(opts.platform);
  return opts;
}

/** --help 输出 */
const USAGE = [
  "用法: pnpm run backfill:activity-assets -- [选项]",
  `  --pattern <正则>       bundle 名筛选（缺省 ${DEFAULT_PATTERN}，忽略大小写）`,
  "  --platform <平台>      Android（缺省）/ Windows",
  "  --version <resVersion> 目标版本目录（缺省取 data/config.json 当前官方版本）",
  "  --lists <目录>         历史热更清单目录（缺省 reference/hotupdate/android）",
  "  --region <CN,TC>       参与筛选/下载的服（缺省 CN）",
  "  --concurrency <n>      下载并发（缺省 4）",
  "  --include-present      当前版本清单里已有的 bundle 也一并抓取",
  "  --force                目标文件已存在也重下",
  "  --report <文件>        把结果写成 JSON 报告",
  "  --dry-run              只列将抓取的 bundle，不下载",
].join("\n");

/**
 * 扫描历史清单目录，收集匹配的 bundle 及其出现过的版本。
 *
 * @param listsRoot - 历史清单根目录（其下按服分子目录）
 * @param regions - 参与扫描的服
 * @param pattern - bundle 名筛选正则（忽略大小写）
 * @returns name → 版本 → 来源记录
 */
async function collectSources(
  listsRoot: string,
  regions: string[],
  pattern: RegExp,
): Promise<Map<string, SourceEntry[]>> {
  const out = new Map<string, SourceEntry[]>();
  for (const region of regions) {
    const dir = join(listsRoot, region);
    if (!existsSync(dir)) {
      console.warn(`[warn] 清单目录不存在，跳过：${dir}`);
      continue;
    }
    const files = (await readdir(dir)).filter((f) => /^hot_update_list_.+\.json$/.test(f));
    for (const file of files) {
      const list: HotUpdateList = JSON.parse(await readFile(join(dir, file), "utf8"));
      const resVersion = list.versionId ?? file.replace(/^hot_update_list_/, "").replace(/\.json$/, "");
      for (const ab of list.abInfos ?? []) {
        if (!pattern.test(ab.name)) continue;
        const entries = out.get(ab.name) ?? [];
        entries.push({
          region,
          resVersion,
          flatName: flattenBundleName(ab.name),
          totalSize: ab.totalSize ?? 0,
        });
        out.set(ab.name, entries);
      }
    }
  }
  // 版本号倒序 = 新版优先（对齐 asset-backfill 的「新→旧」探测）
  for (const entries of out.values()) entries.sort((a, b) => b.resVersion.localeCompare(a.resVersion));
  return out;
}

/**
 * 读取目标版本清单里的 bundle 名集合（本地无快照时从 CDN 兜底拉取）。
 *
 * @param listsRoot - 历史清单根目录
 * @param regions - 服列表
 * @param platform - 平台
 * @param version - 目标版本
 * @returns 已在当前版本清单中的 bundle 名集合
 */
async function currentNames(
  listsRoot: string,
  regions: string[],
  platform: Platform,
  version: string,
): Promise<Set<string>> {
  for (const region of regions) {
    const local = join(listsRoot, region, `hot_update_list_${version}.json`);
    if (existsSync(local)) {
      const list: HotUpdateList = JSON.parse(await readFile(local, "utf8"));
      return new Set((list.abInfos ?? []).map((a) => a.name));
    }
  }
  const region = regions[0] ?? "CN";
  const base = REGION_CDN[region];
  if (!base) throw new Error(`未知服：${region}`);
  const url = `${base}/${platform}/assets/${version}/hot_update_list.json`;
  console.log(`本地无 ${version} 的清单快照，从 CDN 拉取：${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "BestHTTP" } });
  if (!res.ok) throw new Error(`拉取当前版本清单失败：HTTP ${res.status}`);
  const list: HotUpdateList = JSON.parse(await res.text());
  return new Set((list.abInfos ?? []).map((a) => a.name));
}

/**
 * 下载单个 bundle（失败自动向更旧版本回退）。
 *
 * @param entry - 来源候选（新版在前）
 * @param platform - 平台
 * @returns 命中的来源与响应体；全部失败返回 null
 */
async function downloadBundle(
  entry: SourceEntry[],
  platform: Platform,
): Promise<{ src: SourceEntry; body: Buffer } | null> {
  for (const src of entry) {
    const base = REGION_CDN[src.region];
    if (!base) continue;
    const url = `${base}/${platform}/assets/${src.resVersion}/${src.flatName}`;
    for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "BestHTTP" },
          signal: AbortSignal.timeout(CDN_TIMEOUT),
        });
        if (res.status === 404) break; // 该版本已清理，换更旧版本
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { src, body: Buffer.from(await res.arrayBuffer()) };
      } catch (e) {
        if (attempt === DOWNLOAD_RETRIES) {
          console.warn(`[warn] 下载失败 ${src.region}/${src.resVersion}/${src.flatName}: ${(e as Error).message}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  return null;
}

/**
 * 有界并发池。
 *
 * @param items - 待处理条目
 * @param limit - 并发上限
 * @param worker - 单条处理函数
 */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= items.length) return;
        await worker(items[idx]);
      }
    }),
  );
}

/**
 * 主流程。
 */
async function main(): Promise<void> {
  const opts = await parseArgs(process.argv.slice(2));
  const pattern = new RegExp(opts.pattern, "i");
  const targetDir = join(ASSETS_DIR, opts.version, "redirect");
  console.log(`[1/4] 扫描历史清单 ${opts.lists}（服 ${opts.regions.join("/")}，pattern=/${opts.pattern}/i）`);
  const sources = await collectSources(opts.lists, opts.regions, pattern);
  const present = await currentNames(opts.lists, opts.regions, opts.platform, opts.version);
  console.log(
    `      历史出现过的匹配 bundle：${sources.size} 个；当前版本（${opts.platform} ${opts.version}）清单已有 ` +
      `${[...sources.keys()].filter((n) => present.has(n)).length} 个`,
  );

  const targets = [...sources.entries()]
    .filter(([name]) => opts.includePresent || !present.has(name))
    .map(([name, entries]) => ({ name, entries }));
  const totalBytes = targets.reduce((sum, t) => sum + t.entries[0].totalSize, 0);
  console.log(
    `[2/4] 待抓取 ${targets.length} 个 bundle（约 ${(totalBytes / 1048576).toFixed(1)} MiB）→ ${targetDir}`,
  );

  if (opts.dryRun) {
    for (const t of targets) {
      console.log(
        `  ${(t.entries[0].totalSize / 1048576).toFixed(2).padStart(7)} MB  ${t.name}  (最新来源 ${t.entries[0].resVersion})`,
      );
    }
    console.log("dry-run 结束。");
    return;
  }

  await mkdir(targetDir, { recursive: true });
  const results: Result[] = [];
  await runPool(targets, opts.concurrency, async (t) => {
    const newest = t.entries[0];
    const dest = join(targetDir, newest.flatName);
    if (!opts.force && existsSync(dest)) {
      const size = (await stat(dest)).size;
      if (size === newest.totalSize && size > 0) {
        results.push({
          name: t.name,
          flatName: newest.flatName,
          sourceVersion: newest.resVersion,
          bytes: size,
          status: "exists",
          note: "体积一致，跳过",
        });
        console.log(`  skip    ${t.name}`);
        return;
      }
    }
    const got = await downloadBundle(t.entries, opts.platform);
    if (!got) {
      results.push({
        name: t.name,
        flatName: newest.flatName,
        sourceVersion: "",
        bytes: 0,
        status: "missing",
        note: "全部候选版本均不可下载",
      });
      console.log(`  MISSING ${t.name}`);
      return;
    }
    const sizeOk = got.body.length === got.src.totalSize;
    const tmp = `${dest}.part`;
    await writeFile(tmp, got.body);
    await rename(tmp, dest);
    results.push({
      name: t.name,
      flatName: got.src.flatName,
      sourceVersion: got.src.resVersion,
      bytes: got.body.length,
      status: sizeOk ? "ok" : "failed",
      note: sizeOk ? "" : `体积 ${got.body.length} ≠ 清单 totalSize ${got.src.totalSize}`,
    });
    console.log(
      `  ${sizeOk ? "ok     " : "SIZE!  "} ${t.name} ← ${got.src.resVersion} (${(got.body.length / 1048576).toFixed(2)} MB)`,
    );
  });

  const summary = { ok: 0, exists: 0, missing: 0, failed: 0, bytes: 0 };
  for (const r of results) {
    summary[r.status] += 1;
    summary.bytes += r.bytes;
  }
  console.log(
    `[3/4] 完成：新增 ${summary.ok} / 已存在 ${summary.exists} / 缺失 ${summary.missing} / 体积异常 ${summary.failed}` +
      `，共落盘 ${(summary.bytes / 1048576).toFixed(1)} MiB → ${targetDir}`,
  );
  const bad = results.filter((r) => r.status === "missing" || r.status === "failed");
  if (bad.length > 0) {
    console.log(`      以下 ${bad.length} 项需人工确认：`);
    for (const r of bad) console.log(`        - ${r.name}：${r.note}`);
  }
  if (opts.report) {
    const payload = {
      generatedAt: new Date().toISOString(),
      pattern: opts.pattern,
      platform: opts.platform,
      version: opts.version,
      targetDir,
      summary,
      results: results.sort((a, b) => a.name.localeCompare(b.name)),
    };
    await mkdir(resolve(opts.report, ".."), { recursive: true });
    await writeFile(opts.report, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`[4/4] 报告已写入 ${opts.report}`);
  } else {
    console.log("[4/4] 未指定 --report，跳过报告落盘");
  }
}

main().catch((e: Error) => {
  console.error(`[backfill-activity-assets] 失败：${e.message}`);
  process.exitCode = 1;
});
