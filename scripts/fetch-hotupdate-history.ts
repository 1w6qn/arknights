/**
 * 历史 Android 热更清单（hot_update_list.json）批量抓取器
 *
 * 版本来源：ArknightsGameData（Kengxxiao/ArknightsGameData）的提交历史。
 * 其提交信息形如 `[CN UPDATE] Client:2.7.71 Data:26-09-09-07-16-57_d4e461`，
 * 其中 `Data:` 字段即**该服 Android 客户端的 resVersion**——已与官方
 * `/config/prod/official/Android/version` 返回的当前 resVersion 交叉验证一致
 * （Windows 平台另有一份 resVersion，本脚本不处理，见 reference/hotupdate/ 既有快照）。
 *
 * 清单下载：`<CDN>/assetbundle/official/Android/assets/<resVersion>/hot_update_list.json`。
 * 实测（2026-09）：国服 ak.hycdn.cn 覆盖绝大多数版本，但**并非全量**——2019-12 ~ 2020-08
 * 的早期版本基本已被 CDN 清理，2021 以后亦有零星构建缺失（如 21-11-17、21-11-30、24-01-09），
 * 这些一律记为 missing 并留在 index.json 里可追溯；台服 ak-tw.hg-cdn.com 历史版本亦在；
 * 日/英/韩三服 CDN 在本机网络不可达（连接失败，记为 error）。
 *
 * 落盘布局：`<out>/<REGION>/hot_update_list_<resVersion>.json`（按服分子目录，避免不同服
 * 的同名版本互相覆盖），并在 `<out>/index.json` 记录每条的提交、客户端版本、字节数、
 * sha256、清单内 versionId 与 abInfos 条数，供后续时间线分析复用。
 * index.json 是**累积清单**：本轮未抓取的服/版本沿用上一轮条目（便于分服增量补抓），
 * 但每轮都会对本次抓取范围内的条目重新校验本地文件与状态。
 *
 * 用法：
 *   pnpm run fetch:hotupdate-history                                  # 国服全量（缺省）
 *   pnpm run fetch:hotupdate-history -- --region CN,TC                # 指定服
 *   pnpm run fetch:hotupdate-history -- --all-regions                 # 五服全量
 *   pnpm run fetch:hotupdate-history -- --dry-run                     # 只列版本，不下载
 *   pnpm run fetch:hotupdate-history -- --verify                      # 校验已落盘清单与 index.json
 *   pnpm run fetch:hotupdate-history -- --concurrency 8 --out <目录>
 *   pnpm run fetch:hotupdate-history -- --passes 5 --delay 200          # 缺失条目多轮补抓
 *   pnpm run fetch:hotupdate-history -- --cdn CN=https://<自定义host>/assetbundle/official/Android
 *
 * 幂等：已存在且体积一致的清单跳过（--force 重下）；中断后重跑自动续传。
 */
import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");

/** 支持的数据服（对应提交信息里的 `[<REGION> UPDATE]` 前缀） */
type Region = "CN" | "JP" | "EN" | "KR" | "TC";

/** 全部受支持服的遍历顺序 */
const ALL_REGIONS: Region[] = ["CN", "JP", "EN", "KR", "TC"];

/** 各服官方 Android 资源根目录（必须含 `/assets`；可用 --cdn <REGION>=<url> 覆盖） */
const REGION_CDN: Record<Region, string> = {
  CN: "https://ak.hycdn.cn/assetbundle/official/Android/assets",
  JP: "https://ak-jp.hg-cdn.com/assetbundle/official/Android/assets",
  EN: "https://ak-gp.hg-cdn.com/assetbundle/official/Android/assets",
  KR: "https://ak-kr.hg-cdn.com/assetbundle/official/Android/assets",
  TC: "https://ak-tw.hg-cdn.com/assetbundle/official/Android/assets",
};

/** 提交历史中的一条更新记录 */
interface HistoryRecord {
  region: Region;
  clientVersion: string;
  resVersion: string;
  commit: string;
  date: string;
}

/** 热更清单中本脚本关心的字段（其余字段原样落盘，不做裁剪） */
interface HotUpdateListShape {
  versionId?: string;
  abInfos?: { name?: string }[];
}

/** index.json 中的一条记录 */
interface IndexEntry {
  region: Region;
  resVersion: string;
  clientVersion: string;
  commit: string;
  date: string;
  /** 相对 <out> 的文件路径；无文件时为空串 */
  file: string;
  bytes: number;
  sha256: string;
  versionId: string;
  abInfoCount: number;
  status: "ok" | "cached" | "missing" | "error";
  httpStatus: number;
  note: string;
}

/** 落盘索引（溯源 + 断点续传依据） */
interface IndexFile {
  generatedAt: string;
  platform: "Android";
  repo: string;
  repoCommit: string;
  historyCounts: Record<string, number>;
  summary: Record<string, Record<string, number>>;
  entries: IndexEntry[];
}

/** CLI 选项 */
interface Options {
  repo: string;
  out: string;
  regions: Region[];
  concurrency: number;
  retries: number;
  passes: number;
  delayMs: number;
  timeoutMs: number;
  passWaitSec: number;
  dryRun: boolean;
  verify: boolean;
  force: boolean;
  cdn: Partial<Record<Region, string>>;
}

/**
 * 睡眠指定毫秒。
 *
 * @param ms - 毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断字符串是否为受支持的服标识。
 *
 * @param v - 待判定字符串
 * @returns 是受支持服时为 true（类型收窄为 Region）
 */
function isRegion(v: string): v is Region {
  return (ALL_REGIONS as string[]).includes(v);
}

/**
 * 解析命令行参数。
 *
 * @param argv - `process.argv.slice(2)`
 * @returns 归一化后的选项
 */
function parseArgs(argv: string[]): Options {
  const opts: Options = {
    repo: path.join(ROOT, "reference/ArknightsGameData"),
    out: path.join(ROOT, "reference/hotupdate/android"),
    regions: ["CN"],
    concurrency: 6,
    retries: 2,
    passes: 3,
    delayMs: 0,
    timeoutMs: 60_000,
    passWaitSec: 30,
    dryRun: false,
    verify: false,
    force: false,
    cdn: {},
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
      case "--repo":
        opts.repo = path.resolve(next());
        break;
      case "--out":
        opts.out = path.resolve(next());
        break;
      case "--region":
        opts.regions = next()
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s.length > 0)
          .map((s) => {
            if (!isRegion(s)) throw new Error(`未知服：${s}（可选 ${ALL_REGIONS.join("/")}）`);
            return s;
          });
        break;
      case "--all-regions":
        opts.regions = [...ALL_REGIONS];
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, Number.parseInt(next(), 10) || 1);
        break;
      case "--retries":
        opts.retries = Math.max(0, Number.parseInt(next(), 10) || 0);
        break;
      case "--passes":
        opts.passes = Math.max(1, Number.parseInt(next(), 10) || 1);
        break;
      case "--delay":
        opts.delayMs = Math.max(0, Number.parseInt(next(), 10) || 0);
        break;
      case "--timeout":
        opts.timeoutMs = Math.max(1000, Number.parseInt(next(), 10) || 60_000);
        break;
      case "--pass-wait":
        opts.passWaitSec = Math.max(0, Number.parseInt(next(), 10) || 0);
        break;
      case "--cdn": {
        const raw = next();
        const eq = raw.indexOf("=");
        if (eq <= 0) throw new Error(`--cdn 需要 <REGION>=<url> 形式，收到 ${raw}`);
        const region = raw.slice(0, eq).trim().toUpperCase();
        if (!isRegion(region)) throw new Error(`--cdn 未知服：${region}`);
        opts.cdn[region] = raw.slice(eq + 1).trim().replace(/\/+$/, "");
        break;
      }
      case "--force":
        opts.force = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--verify":
        opts.verify = true;
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
  return opts;
}

/** --help 输出 */
const USAGE = [
  "用法: pnpm run fetch:hotupdate-history -- [选项]",
  "  --region <CN,TC>       要抓取的服（缺省 CN）",
  "  --all-regions          五服全量（CN/JP/EN/KR/TC）",
  "  --repo <目录>          ArknightsGameData 克隆（缺省 reference/ArknightsGameData）",
  "  --out <目录>           输出根目录（缺省 reference/hotupdate/android）",
  "  --concurrency <n>      并发下载数（缺省 6）",
  "  --retries <n>          单条网络失败重试次数（缺省 2；404 视为最终缺失，不重试）",
  "  --passes <n>           轮数（缺省 3）：每轮只补抓上轮仍缺失的条目",
  "  --pass-wait <秒>       轮与轮之间的等待（缺省 30）",
  "  --delay <ms>           每条请求前的基础延迟（缺省 0）",
  "  --timeout <ms>         单条请求超时（缺省 60000）",
  "  --cdn <REGION>=<url>   覆盖某服 CDN 根（可重复）",
  "  --force                忽略本地已有文件，全部重下",
  "  --verify               只校验本地清单与 index.json（存在性/体积/sha256/versionId），不联网",
  "  --dry-run              只列版本与数量，不下载",
].join("\n");

/**
 * 读取 git 提交历史并抽取各服的 Android resVersion（同一版本保留最早一次提交）。
 *
 * @param repo - ArknightsGameData 克隆目录
 * @param regions - 需要抽取的服
 * @returns 按时间正序（旧 → 新）去重后的记录
 */
function readHistory(repo: string, regions: Region[]): HistoryRecord[] {
  if (!fs.existsSync(path.join(repo, ".git"))) {
    throw new Error(`不是 git 仓库：${repo}（先用 git clone https://github.com/Kengxxiao/ArknightsGameData.git 拉取）`);
  }
  // safe.directory=* 规避 WSL 下的 dubious ownership 拦截（仓库由 Windows 侧检出）
  const raw = execFileSync(
    "git",
    ["-c", "safe.directory=*", "log", "--all", "--date=short", "--pretty=%H%x1f%ad%x1f%s"],
    { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const wanted = new Set<string>(regions);
  const seen = new Set<string>();
  const ordered: HistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const [commit, date, subject] = line.split("\u001f");
    const regionMatch = /^\[([A-Z]+) UPDATE\]/.exec(subject ?? "");
    if (!regionMatch) continue;
    const region = regionMatch[1];
    if (!wanted.has(region) || !isRegion(region)) continue;
    const client = /Client:(\S+)/.exec(subject);
    const data = /Data:(\S+)/.exec(subject);
    if (!client || !data) continue;
    const key = `${region}:${data[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push({
      region,
      clientVersion: client[1],
      resVersion: data[1],
      commit,
      date,
    });
  }
  // git log 为新 → 旧；反转为旧 → 新，便于按版本演进顺序观察进度
  return ordered.reverse();
}

/**
 * 统计各服历史版本数（不限于本次抓取范围，供 index 溯源）。
 *
 * @param repo - ArknightsGameData 克隆目录
 * @returns 服 → 唯一 resVersion 数
 */
function historyCounts(repo: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const region of ALL_REGIONS) {
    counts[region] = readHistory(repo, [region]).length;
  }
  return counts;
}

/**
 * 取仓库当前 HEAD（写进 index，标明数据快照点）。
 *
 * @param repo - ArknightsGameData 克隆目录
 * @returns HEAD sha
 */
function repoHead(repo: string): string {
  return execFileSync("git", ["-c", "safe.directory=*", "rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}

/**
 * 计算缓冲区 sha256。
 *
 * @param buf - 待哈希数据
 * @returns 十六进制摘要
 */
function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * 从清单文本提取 versionId 与 abInfos 条数（解析失败时返回空值）。
 *
 * @param text - 清单 JSON 文本
 * @returns `{ versionId, abInfoCount }`
 */
function inspectList(text: string): { versionId: string; abInfoCount: number } {
  const parsed: HotUpdateListShape = JSON.parse(text);
  return {
    versionId: parsed.versionId ?? "",
    abInfoCount: parsed.abInfos?.length ?? 0,
  };
}

/**
 * 有界并发池：按输入顺序把 items 交给 worker，最多 limit 个在飞。
 *
 * @param items - 待处理条目
 * @param limit - 并发上限
 * @param worker - 单条处理函数
 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  const runners: Promise<void>[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    runners.push(
      (async () => {
        for (;;) {
          const idx = cursor++;
          if (idx >= items.length) return;
          await worker(items[idx], idx);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

/**
 * 带超时的 GET（undici 在 CDN 慢回源时会长时间挂起）。
 *
 * @param url - 目标 URL
 * @param timeoutMs - 超时毫秒数
 * @returns 响应（超时抛错，由调用方捕获后记为网络失败）
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { "User-Agent": "BestHTTP" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取单条清单（httpStatus 为 0 表示网络层失败）。
 *
 * @param url - 清单 URL
 * @param timeoutMs - 单条请求超时
 * @returns 状态码与响应体（非 200 时 body 为 null）
 */
async function download(url: string, timeoutMs: number): Promise<{ httpStatus: number; body: Buffer | null }> {
  try {
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) return { httpStatus: res.status, body: null };
    return { httpStatus: res.status, body: Buffer.from(await res.arrayBuffer()) };
  } catch {
    return { httpStatus: 0, body: null };
  }
}

/**
 * 处理单条版本：命中本地缓存则复用，否则下载并落盘。
 *
 * @param rec - 历史记录
 * @param opts - CLI 选项
 * @param cdnBase - 该服 CDN 根
 * @param previous - 上一轮 index 的同名条目（用于复用 sha256）
 * @param progress - 进度前缀（如 `[12/381]`）
 * @returns 索引条目
 */
async function fetchOne(
  rec: HistoryRecord,
  opts: Options,
  cdnBase: string,
  previous: Map<string, IndexEntry>,
  progress: string,
): Promise<IndexEntry> {
  const relFile = path.join(rec.region, `hot_update_list_${rec.resVersion}.json`);
  const absFile = path.join(opts.out, relFile);
  const base: IndexEntry = {
    region: rec.region,
    resVersion: rec.resVersion,
    clientVersion: rec.clientVersion,
    commit: rec.commit,
    date: rec.date,
    file: "",
    bytes: 0,
    sha256: "",
    versionId: "",
    abInfoCount: 0,
    status: "error",
    httpStatus: 0,
    note: "",
  };

  if (!opts.force && fs.existsSync(absFile)) {
    const bytes = fs.statSync(absFile).size;
    const prev = previous.get(`${rec.region}:${rec.resVersion}`);
    if (bytes > 1000) {
      if (prev && prev.sha256.length > 0 && prev.bytes === bytes) {
        console.log(`${progress} cached  ${rec.resVersion} (${(bytes / 1048576).toFixed(2)} MB)`);
        return { ...prev, status: "cached", file: relFile };
      }
      const buf = fs.readFileSync(absFile);
      const info = inspectList(buf.toString("utf8"));
      console.log(`${progress} cached* ${rec.resVersion} (${(bytes / 1048576).toFixed(2)} MB)`);
      return { ...base, file: relFile, bytes, sha256: sha256(buf), ...info, status: "cached", httpStatus: 200 };
    }
  }

  const url = `${cdnBase}/${rec.resVersion}/hot_update_list.json`;
  let last: { httpStatus: number; body: Buffer | null } = { httpStatus: 0, body: null };
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (opts.delayMs > 0 && attempt === 0) await sleep(opts.delayMs);
    last = await download(url, opts.timeoutMs);
    if (last.body !== null) break;
    // 4xx 是确定的「该版本已不在 CDN」，无需重试；网络层失败（0）与 5xx 才退避重试
    if (last.httpStatus >= 400 && last.httpStatus < 500) break;
    if (attempt < opts.retries) await sleep(600 * 2 ** attempt);
  }

  if (last.body === null) {
    const missing = last.httpStatus === 404;
    console.log(`${progress} ${missing ? "MISSING" : "ERROR  "} ${rec.resVersion} (http ${last.httpStatus})`);
    return {
      ...base,
      status: missing ? "missing" : "error",
      httpStatus: last.httpStatus,
      note: missing ? "该版本已不在 CDN（各轮尝试均 404）" : "网络失败或非 404 错误",
    };
  }

  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(absFile, last.body);
  let info = { versionId: "", abInfoCount: 0 };
  let note = "";
  try {
    info = inspectList(last.body.toString("utf8"));
    if (info.versionId.length > 0 && info.versionId !== rec.resVersion) {
      note = `versionId 与 resVersion 不一致：${info.versionId}`;
    }
  } catch (e) {
    note = `JSON 解析失败：${(e as Error).message}`;
  }
  console.log(`${progress} ok      ${rec.resVersion} (${(last.body.length / 1048576).toFixed(2)} MB, ${info.abInfoCount} abInfos)`);
  return {
    ...base,
    file: relFile,
    bytes: last.body.length,
    sha256: sha256(last.body),
    versionId: info.versionId,
    abInfoCount: info.abInfoCount,
    status: "ok",
    httpStatus: last.httpStatus,
    note,
  };
}

/**
 * 校验模式：只核对本地清单与 index.json（存在性 / 体积 / sha256 / versionId），不联网。
 *
 * @param out - 输出根目录
 * @returns 问题条数（0 表示全部一致）
 */
function verifyIndex(out: string): number {
  const indexPath = path.join(out, "index.json");
  if (!fs.existsSync(indexPath)) {
    console.error(`找不到 ${indexPath}，请先运行抓取。`);
    return 1;
  }
  const index: IndexFile = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const problems: string[] = [];
  let checked = 0;
  let bytes = 0;
  let abInfos = 0;
  for (const entry of index.entries) {
    if (entry.status !== "ok" && entry.status !== "cached") continue;
    const abs = path.join(out, entry.file);
    if (!fs.existsSync(abs)) {
      problems.push(`${entry.region}/${entry.resVersion}: 文件缺失（${entry.file}）`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    checked++;
    bytes += buf.length;
    abInfos += entry.abInfoCount;
    if (buf.length !== entry.bytes) problems.push(`${entry.region}/${entry.resVersion}: 体积 ${buf.length} ≠ index ${entry.bytes}`);
    const digest = sha256(buf);
    if (entry.sha256.length > 0 && digest !== entry.sha256) problems.push(`${entry.region}/${entry.resVersion}: sha256 不一致`);
    try {
      const info = inspectList(buf.toString("utf8"));
      if (info.versionId !== entry.resVersion) problems.push(`${entry.region}/${entry.resVersion}: 清单 versionId=${info.versionId}`);
      if (info.abInfoCount !== entry.abInfoCount) problems.push(`${entry.region}/${entry.resVersion}: abInfos ${info.abInfoCount} ≠ index ${entry.abInfoCount}`);
    } catch (e) {
      problems.push(`${entry.region}/${entry.resVersion}: JSON 解析失败（${(e as Error).message}）`);
    }
  }
  console.log(
    `校验完成：index 共 ${index.entries.length} 条，其中落盘 ${checked} 条 / ${(bytes / 1048576).toFixed(1)} MiB / ${abInfos} abInfos`,
  );
  const missing = index.entries.filter((e) => e.status === "missing").length;
  const errors = index.entries.filter((e) => e.status === "error").length;
  console.log(`      索引内 missing=${missing} error=${errors}`);
  if (problems.length > 0) {
    console.error(`发现 ${problems.length} 处问题：`);
    for (const p of problems.slice(0, 30)) console.error(`  - ${p}`);
    return problems.length;
  }
  console.log("      全部一致 ✅");
  return 0;
}

/**
 * 主流程。
 */
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.verify) {
    const problems = verifyIndex(opts.out);
    if (problems > 0) process.exitCode = 1;
    return;
  }
  console.log(`[1/4] 读取提交历史：${opts.repo}`);
  const counts = historyCounts(opts.repo);
  const records = readHistory(opts.repo, opts.regions);
  console.log(
    `      历史唯一 android resVersion：${ALL_REGIONS.map((r) => `${r}=${counts[r] ?? 0}`).join(" ")}` +
      `（本次抓取 ${opts.regions.join("/")}，共 ${records.length} 条）`,
  );

  if (opts.dryRun) {
    for (const rec of records) {
      console.log(`  ${rec.region} ${rec.date} ${rec.resVersion} (client ${rec.clientVersion})`);
    }
    console.log(`dry-run 结束：共 ${records.length} 条待下载。`);
    return;
  }

  const indexPath = path.join(opts.out, "index.json");
  const previous = new Map<string, IndexEntry>();
  if (fs.existsSync(indexPath)) {
    const old: IndexFile = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    for (const entry of old.entries ?? []) previous.set(`${entry.region}:${entry.resVersion}`, entry);
    console.log(`      复用上一轮 index.json：${previous.size} 条`);
  }

  console.log(
    `[2/4] 下载清单（并发 ${opts.concurrency}，单条重试 ${opts.retries}，补抓轮数 ${opts.passes}）→ ${opts.out}`,
  );
  const byKey = new Map<string, IndexEntry>(previous);
  let pending = records;
  for (let pass = 1; pass <= opts.passes && pending.length > 0; pass++) {
    if (pass > 1) {
      console.log(`      第 ${pass} 轮补抓：${pending.length} 条（上一轮 404/网络失败），先等 ${opts.passWaitSec}s 让 CDN 回源填充`);
      await sleep(opts.passWaitSec * 1000);
    }
    const totals = pending.length;
    const round = `${pass}/${opts.passes}`;
    await runPool(pending, opts.concurrency, async (rec, idx) => {
      const cdnBase = opts.cdn[rec.region] ?? REGION_CDN[rec.region];
      const progress = `[第${round}轮 ${String(idx + 1).padStart(String(totals).length, " ")}/${totals}]`;
      const entry = await fetchOne(rec, opts, cdnBase, previous, progress);
      byKey.set(`${entry.region}:${entry.resVersion}`, entry);
    });
    pending = pending.filter((rec) => {
      const entry = byKey.get(`${rec.region}:${rec.resVersion}`);
      return entry === undefined || entry.status === "missing" || entry.status === "error";
    });
  }

  const entries = [...byKey.values()].sort((a, b) =>
    a.region === b.region ? a.resVersion.localeCompare(b.resVersion) : a.region.localeCompare(b.region),
  );

  console.log("[3/4] 汇总");
  const summary: Record<string, Record<string, number>> = {};
  for (const entry of entries) {
    const bucket = (summary[entry.region] ??= { ok: 0, cached: 0, missing: 0, error: 0, bytes: 0 });
    bucket[entry.status] = (bucket[entry.status] ?? 0) + 1;
    bucket.bytes += entry.bytes;
  }
  for (const [region, s] of Object.entries(summary)) {
    console.log(
      `      ${region}: ok=${s.ok} cached=${s.cached} missing=${s.missing} error=${s.error}` +
        ` 合计 ${(s.bytes / 1048576).toFixed(1)} MB`,
    );
  }

  const index: IndexFile = {
    generatedAt: new Date().toISOString(),
    platform: "Android",
    repo: opts.repo,
    repoCommit: repoHead(opts.repo),
    historyCounts: counts,
    summary,
    entries,
  };
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`[4/4] 索引已写入 ${indexPath}（${entries.length} 条）`);

  const failed = entries.filter((e) => e.status === "missing" || e.status === "error");
  if (failed.length > 0) {
    console.log(`注意：${failed.length} 条未取得（missing=${failed.filter((e) => e.status === "missing").length}，` +
      `error=${failed.filter((e) => e.status === "error").length}），详见 index.json`);
  }
}

main().catch((e: Error) => {
  console.error(`[fetch-hotupdate-history] 失败：${e.message}`);
  process.exitCode = 1;
});
