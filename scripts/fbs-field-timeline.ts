/**
 * FBS 字段时间线：回答「某个字段是哪个客户端版本冒出来的」
 *
 * 数据源是参考包 `reference/obs/OpenBachelorM-master.zip` 内 `fbs/<版本>/*.fbs`
 * （2.0.01→2.7.61 共 38 版，与 `reference/OpenArknightsFBS-main` 同一上游）；
 * 也可用 `--fbs-dir` 指向已抽出的目录（`pnpm run schema:crosscheck --fbs-zip ...` 会抽到 tmp/obs-fbs/<版本>/）。
 *
 * 用途：`cs2schema.ts` 的 slot 位移判定依赖「CS 字段序 = FBO vtable slot 序」，
 * 当某个字段在某版本被**插到中部**时，其后全部 slot 位移（活样本：
 * `clz_Torappu_ItemData.reslockStatus/canReslock` 在 2.7.71 插在 hideInItemGet 与 classifyType 之间）。
 * 用本工具可在**不反编译**的前提下先看历史版本里该字段是否存在、位于何处。
 *
 * 用法:
 *   pnpm run schema:timeline -- --table item_table --struct clz_Torappu_ItemData
 *   pnpm run schema:timeline -- --table item_table --struct clz_Torappu_ItemData --versions 2.6.91,2.7.61
 *   pnpm run schema:timeline -- --fbs-dir tmp/obs-fbs/2.7.61 --table item_table --struct clz_Torappu_ItemData
 *   省略 --struct 时自动读 `root_type`（`.fbs` 的根表）
 */
import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";

const ROOT = path.join(__dirname, "..");
const DEFAULT_ZIP = path.join("reference", "obs", "OpenBachelorM-master.zip");

const argv = process.argv.slice(2);
/** 读取 `--name value` 形式的参数 */
function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const FBS_ZIP = opt("--fbs-zip") ?? (opt("--fbs-dir") ? undefined : DEFAULT_ZIP);
const FBS_DIR = opt("--fbs-dir");
const TABLE = opt("--table");
const STRUCT = opt("--struct");
const VERSIONS = opt("--versions")
  ?.split(",")
  .map((v) => v.trim())
  .filter((v) => v.length > 0);

/** 转义正则元字符 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 取 `table <name> { ... }` 的块体（表体不嵌套，故按「行首单独的 }」收尾即可）
 * @param text  `.fbs` 全文
 * @param name  结构名（`clz_Torappu_*`）
 * @returns 块体文本；未找到返回 `null`
 */
function extractBlock(text: string, name: string): string | null {
  const re = new RegExp(`^(?:table|struct)\\s+${escapeRe(name)}\\s*\\{`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const body: string[] = [];
  for (const line of text.slice(m.index + m[0].length).split("\n")) {
    if (line.trim() === "}") break;
    body.push(line);
  }
  return body.join("\n");
}

/** 表体内的字段名（保序）；`enum`/`union` 无冒号字段故不会误收 */
function blockFields(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 取 `.fbs` 的根表名（`root_type clz_X;`） */
function rootType(text: string): string | null {
  const m = /^root_type\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/m.exec(text);
  return m ? m[1] : null;
}

/** 一个版本 + 该表全文 */
interface VersionFile {
  version: string;
  text: string;
}

/**
 * 从参考包 zip 读某张表在各版本的文件
 * @param zipRel  zip 路径（相对仓库根）
 * @param table   表文件名（不含 `.fbs`），如 `item_table`
 */
async function loadFromZip(zipRel: string, table: string): Promise<VersionFile[]> {
  const zipPath = path.isAbsolute(zipRel) ? zipRel : path.join(ROOT, zipRel);
  if (!fs.existsSync(zipPath)) {
    console.log(`[SKIP] 参考包不存在：${zipRel}`);
    return [];
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const re = new RegExp(`/fbs/([^/]+)/${escapeRe(table)}\\.fbs$`);
  const found: { version: string; name: string }[] = [];
  for (const name of Object.keys(zip.files)) {
    const m = re.exec(name);
    if (m) found.push({ version: m[1], name });
  }
  found.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  const out: VersionFile[] = [];
  for (const f of found) {
    const entry = zip.file(f.name);
    if (!entry) continue;
    out.push({ version: f.version, text: await entry.async("string") });
  }
  return out;
}

/** 从已抽出的目录（内含 `<版本>/*.fbs`）读某张表各版本文件 */
function loadFromDir(dir: string, table: string): VersionFile[] {
  if (!fs.existsSync(dir)) {
    console.log(`[SKIP] 目录不存在：${dir}`);
    return [];
  }
  const out: VersionFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, `${table}.fbs`);
    if (fs.existsSync(file)) out.push({ version: entry.name, text: fs.readFileSync(file, "utf-8") });
  }
  out.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return out;
}

/**
 * 主流程：逐版本打印字段数与相对上一版的增删
 * @returns 退出码（0 正常，1 参数/数据缺失）
 */
async function main(): Promise<number> {
  if (!TABLE) {
    console.log("用法: pnpm run schema:timeline -- --table <表名> [--struct <结构名>] [--versions a,b] [--fbs-dir <dir>]");
    return 1;
  }
  const files = FBS_DIR ? loadFromDir(FBS_DIR, TABLE) : await loadFromZip(FBS_ZIP ?? DEFAULT_ZIP, TABLE);
  if (files.length === 0) {
    console.log(`[SKIP] 未找到 ${TABLE}.fbs 的任何版本`);
    return 1;
  }
  const picked = VERSIONS ? files.filter((f) => VERSIONS.includes(f.version)) : files;
  if (picked.length === 0) {
    console.log(`[SKIP] 指定版本均不存在：${VERSIONS?.join(", ")}`);
    return 1;
  }

  const struct = STRUCT ?? rootType(picked[picked.length - 1].text);
  if (!struct) {
    console.log("[SKIP] 未指定 --struct 且文件内无 root_type");
    return 1;
  }

  console.log(`表 ${TABLE}.fbs / 结构 ${struct}（共 ${picked.length} 个版本）`);
  console.log("");
  let prev: string[] | null = null;
  for (const f of picked) {
    const body = extractBlock(f.text, struct);
    if (body === null) {
      console.log(`  ${f.version.padEnd(8)}  (结构不存在)`);
      prev = null;
      continue;
    }
    const fields = blockFields(body);
    let delta = "";
    const previous = prev;
    if (previous) {
      const added = fields.filter((x) => !previous.includes(x));
      const removed = previous.filter((x) => !fields.includes(x));
      const parts: string[] = [];
      if (added.length) parts.push(`+${added.join(",")}`);
      if (removed.length) parts.push(`-${removed.join(",")}`);
      if (parts.length) delta = `  ${parts.join(" ")}`;
    }
    console.log(`  ${f.version.padEnd(8)} ${String(fields.length).padStart(3)} 字段${delta}`);
    prev = fields;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: Error) => {
    console.error(err);
    process.exitCode = 1;
  });
