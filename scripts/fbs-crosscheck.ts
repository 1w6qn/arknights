/**
 * 交叉校验：本地 FBO schema ⇄ OpenArknightsFBS 参考定义
 *
 * 背景：`scripts/vendor/fbs-schemas/*.json` 由 CS 反编译源派生（`scripts/cs2schema.ts`），
 * 但那条链路**只重写已存在的键 + 补 KV 表**，从不新增 `clz_` 表；社区仓库 OpenArknightsFBS
 * 的 `*.fbs` 则是从游戏内部结构逐字段解析出来的独立来源。两边互相比对可以发现：
 *   - FBS 有而本地没有的表 → 本地解到该字段时 `fbo.ts#tableToJson` 返回 `{}`（静默丢数据）
 *   - 字段序（= FBO vtable slot 序）不一致 → 解码错位
 *   - 字段类型宽度不一致（int32 vs ubyte 等）→ 读多读少字节
 *   - 本地引用了未定义的表（悬空引用）
 *
 * 用法:
 *   pnpm run schema:crosscheck                                  # 终端摘要
 *   pnpm run schema:crosscheck -- --md docs/fbs-crosscheck.md   # 同时落盘 Markdown 报告
 *   pnpm run schema:crosscheck -- --json tmp/crosscheck.json    # 机器可读全量结果
 *   pnpm run schema:crosscheck -- --table item_table            # 只看某张表
 *   pnpm run schema:crosscheck -- --strict                      # 有硬漂移时非 0 退出
 *   pnpm run schema:crosscheck -- --fbs-zip reference/obs/OpenBachelorM-master.zip --fbs-version 2.7.61
 *                                                               # 从 obs 参考包 zip 现抽历史版本 FBS 再比对
 *
 * 输入目录均可覆盖：`--fbs <dir>` / `--schema <dir>`。`reference/` 被 gitignore，
 * 参考副本缺失时本工具跳过并提示，不报错。
 *
 * 历史基线：`reference/obs/OpenBachelorM-master.zip` 内 `fbs/<版本>/*.fbs` 保留了
 * 2.0.01→2.7.61 共 38 个版本的 FBS（与 `reference/OpenArknightsFBS-main` 同一上游）。
 * 其中 2.7.61 是 `clz_Torappu_ItemData.reslockStatus/canReslock` 在 2.7.71 插入前的基线，
 * 用作「中间插入 → 其后 slot 全体位移」的回归数据源；详见
 * `docs/fbs-schema-repair-2026-09-12.md` 的「obs 历史 FBS 基线」一节。
 */
import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";

const ROOT = path.join(__dirname, "..");
const DEFAULT_FBS_DIR = path.join(ROOT, "reference", "OpenArknightsFBS-main", "FBS");
const DEFAULT_SCHEMA_DIR = path.join(ROOT, "scripts", "vendor", "fbs-schemas");

const argv = process.argv.slice(2);
/** 读取 `--name value` 形式的参数 */
function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
/** 读取开关型参数 */
function flag(name: string): boolean {
  return argv.includes(name);
}

const FBS_DIR_OPT = opt("--fbs");
let FBS_DIR = FBS_DIR_OPT ?? DEFAULT_FBS_DIR;
const SCHEMA_DIR = opt("--schema") ?? DEFAULT_SCHEMA_DIR;
const FBS_ZIP = opt("--fbs-zip");
const FBS_VERSION = opt("--fbs-version");
const TABLE_FILTER = opt("--table");
const SAMPLES = Number(opt("--samples") ?? 5);
const STRICT = flag("--strict");
const JSON_OUT = opt("--json");
const MD_OUT = opt("--md");

/** 单张表的字段（FBS 侧无 slot；本地 schema 侧 slot = 4 + 2×字段序） */
interface Field {
  name: string;
  type: string;
  slot?: number;
}
/** 一个 schema 文件的解析结果 */
interface FileSchema {
  /** 根表名 */
  root: string | null;
  /** 表名 → 字段列表（保序） */
  tables: Map<string, Field[]>;
  /** 枚举名（含 `enum__` 前缀）→ 基类型（int / ubyte） */
  enumBases: Map<string, string>;
}

/** 规范化上下文：枚举基类型表 + 当前侧（两侧 `enum` 写法不同）+ 是否擦除枚举名 */
interface Ctx {
  enumBases: Map<string, string>;
  /** 表名匹配时擦除枚举名/宽度（本地拿不到枚举名，只能按「枚举」等价匹配） */
  eraseEnum: boolean;
}

/** FlatBuffers 标量 → 宽度类别（同类别视为等价；`enum` 在解码器中按 i32 读取） */
const SCALAR_WIDTH: Record<string, string> = {
  string: "str",
  bool: "bool",
  int: "32",
  int8: "8",
  int16: "16",
  int32: "32",
  uint: "32",
  uint8: "8",
  uint16: "16",
  uint32: "32",
  byte: "8",
  sbyte: "8",
  ubyte: "8",
  short: "16",
  ushort: "16",
  long: "64",
  int64: "64",
  ulong: "64",
  uint64: "64",
  float: "f32",
  float32: "f32",
  double: "f64",
  float64: "f64",
};

/** 类型表达式中「新类型起点」的前缀：扫描原子名时在这些前缀前断开 */
const BOUNDARY = ["dict__", "list_dict__", "kvp__", "list_", "enum__", "vec:", "clz_", "hg__"];

/** 标量 token 按长度降序排列，保证 `int8` 不被 `int` 抢先匹配 */
const SCALAR_RE = new RegExp(`^(${Object.keys(SCALAR_WIDTH).sort((a, b) => b.length - a.length).join("|")})(?=__|$)`);

/**
 * 去掉 `//` 行注释（FBS 里没有块注释）
 * @param text - 原始文件内容
 */
function stripComments(text: string): string {
  return text.replace(/\/\/[^\n]*/g, "");
}

/**
 * 大括号配对，返回 `{` 的下标与其匹配 `}` 的下标
 * @param text - 文本
 * @param openIdx - `{` 的下标
 */
function matchBrace(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/**
 * 解析一个 `.fbs` 文件
 * @param text - 文件内容
 */
function parseFbs(text: string): FileSchema {
  const src = stripComments(text);
  const tables = new Map<string, Field[]>();
  const enumBases = new Map<string, string>();
  const declRe = /^(enum|table)\s+(\S+)\s*(?::\s*(\S+))?\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src)) !== null) {
    const kind = m[1];
    const name = m[2];
    const base = m[3];
    const body = src.slice(m.index + m[0].length, matchBrace(src, m.index + m[0].length - 1));
    if (kind === "enum") {
      enumBases.set(name, base ?? "int");
      continue;
    }
    const fields: Field[] = [];
    const fieldRe = /(\w+)\s*:\s*([^;]+);/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(body)) !== null) {
      // 去掉 (key)/(required) 之类的字段属性
      fields.push({ name: f[1], type: f[2].replace(/\(.*?\)/g, "").trim() });
    }
    tables.set(name, fields);
  }
  const rootM = /^root_type\s+(\S+)\s*;/m.exec(src);
  return { root: rootM ? rootM[1] : null, tables, enumBases };
}

/**
 * 解析一个本地 schema JSON
 * @param file - JSON 文件路径
 */
function parseLocal(file: string): FileSchema {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    root: string;
    tables: Record<string, { name: string; type: string; slot: number }[]>;
  };
  const tables = new Map<string, Field[]>();
  for (const [name, fields] of Object.entries(raw.tables)) {
    tables.set(name, fields.map((f) => ({ name: f.name, type: f.type, slot: f.slot })));
  }
  return { root: raw.root, tables, enumBases: new Map() };
}

/**
 * 原子类型 token → 宽度类别
 * @param token - `string` / `int` / `enum__Torappu_X` / `clz_Torappu_X` 等
 * @param ctx - 规范化上下文
 */
function canonAtomic(token: string, ctx: Ctx): string {
  if (token === "enum" || token.startsWith("enum__")) {
    if (ctx.eraseEnum) return "enum";
    if (token === "enum") return "32"; // 本地 token：fbo.ts 按 i32 读取
    const base = ctx.enumBases.get(token) ?? "int";
    return SCALAR_WIDTH[base] ?? "32";
  }
  // cs2schema 对无法解析的泛型实例化会落成字面量 "unknown"（解码时该字段恒为 null）
  if (token === "unknown" || token === "") return "unknown";
  if (SCALAR_WIDTH[token]) return SCALAR_WIDTH[token];
  return `ref:${token}`;
}

/** 裸 `enum` 后跟的类型起点（用于区分本地 `dict__enum__string` 与 `enum__Torappu_X`） */
const VALUE_START = ["clz_", "hg__", "list_", "dict__", "list_dict__", "kvp__", "vec:"];

/**
 * 判断 `enum__` 之后的名字是「枚举名」还是「下一个类型起点」
 *
 * 本地 schema 两种写法都存在：`dict__enum__string`（值是 string）与
 * `dict__enum__Torappu_RarityRank`（值是枚举）。前者下标后的片段是标量/容器前缀。
 * @param cand - `enum__` 之后的第一个 `__` 之前的片段
 */
function isTypeStart(cand: string): boolean {
  return Boolean(SCALAR_WIDTH[cand]) || cand === "enum" || VALUE_START.some((p) => cand.startsWith(p));
}

/**
 * 在原子名中找到下一个类型分隔符 `__`（其后紧跟容器/类名前缀处），返回分隔符下标
 * @param s - 待扫描文本
 */
function findBoundary(s: string): number {
  let i = s.indexOf("__");
  while (i >= 0) {
    const rest = s.slice(i + 2);
    if (BOUNDARY.some((p) => rest.startsWith(p))) return i;
    i = s.indexOf("__", i + 2);
  }
  return s.length;
}

/**
 * 递归消费一个类型表达式，返回规范化形式与剩余文本
 *
 * 关键等价关系（两边写法不同但语义相同）：
 *   FBS `dict__K__V`（表引用）         ⇔ 本地 `vec:dict__K__V`
 *   FBS `dict__K__list_X`              ⇔ 本地 `dict__K__vec:X`
 *   FBS `[T]`                          ⇔ 本地 `vec:T`
 *   FBS `enum__Name`（基类型 int/ubyte）⇔ 本地裸 `enum`（解码器按 i32 读）
 * @param s - 类型表达式
 * @param ctx - 规范化上下文
 */
function takeType(s: string, ctx: Ctx): { canon: string; rest: string } {
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    const inner = takeType(s.slice(1, close), ctx);
    return { canon: `vec(${inner.canon})`, rest: s.slice(close + 1) };
  }
  if (s.startsWith("list_dict__") || s.startsWith("dict__")) {
    // FBS：`dict__K__V` 是键值对表；字段写成 `[dict__K__V]`（表的向量）。
    // 本地：字段写成 `vec:dict__K__V`，嵌套字典值写成 `list_dict__K__V`。
    const isList = s.startsWith("list_dict__");
    const len = isList ? "list_dict__".length : "dict__".length;
    const k = takeType(s.slice(len), ctx);
    const v = takeType(k.rest, ctx);
    const inner = `map(${k.canon},${v.canon})`;
    return { canon: isList ? `vec(${inner})` : inner, rest: v.rest };
  }
  if (s.startsWith("kvp__")) {
    const k = takeType(s.slice("kvp__".length), ctx);
    const v = takeType(k.rest, ctx);
    return { canon: `kvp(${k.canon},${v.canon})`, rest: v.rest };
  }
  if (s.startsWith("vec:") || s.startsWith("list_")) {
    const len = s.startsWith("vec:") ? 4 : "list_".length;
    const inner = takeType(s.slice(len), ctx);
    return { canon: `vec(${inner.canon})`, rest: inner.rest };
  }
  // enum 写法：本地裸 `enum` 与 `enum__Name` 并存，FBS 只有 `enum__Name`
  if (s.startsWith("enum__")) {
    const body = s.slice("enum__".length);
    const stop = body.indexOf("__");
    const cand = stop >= 0 ? body.slice(0, stop) : body;
    if (!isTypeStart(cand)) {
      const rest = stop >= 0 ? body.slice(stop).replace(/^__/, "") : "";
      return { canon: canonAtomic(`enum__${cand}`, ctx), rest };
    }
  }
  if (/^enum(?=__|$)/.test(s)) {
    return { canon: canonAtomic("enum", ctx), rest: s.slice(4).replace(/^__/, "") };
  }
  const sc = SCALAR_RE.exec(s);
  if (sc) return { canon: SCALAR_WIDTH[sc[1]], rest: s.slice(sc[1].length).replace(/^__/, "") };
  const end = findBoundary(s);
  return { canon: canonAtomic(s.slice(0, end), ctx), rest: s.slice(end).replace(/^__/, "") };
}

/**
 * 类型表达式 → 规范化字符串
 * @param expr - 类型表达式
 * @param ctx - 规范化上下文
 */
function canonType(expr: string, ctx: Ctx): string {
  const { canon, rest } = takeType(expr.trim(), ctx);
  return rest.trim() ? `${canon}+${rest.trim()}` : canon;
}

/** 表名 → 规范化结构签名（用于跨命名约定匹配，如 `list_X` ⇄ `vec:X`） */
function canonTableName(name: string, ctx: Ctx): string {
  return canonType(name, ctx);
}

/** 从规范化类型里抽出所有表引用 */
function extractRefs(canon: string): string[] {
  return canon.match(/ref:[A-Za-z0-9_]+/g) ?? [];
}

/** 本地历史合成字段判定：`AsNumpy`（excel-convert 丢弃、解码器读作 null），对齐时剔除 */
function isSynthetic(f: Field): boolean {
  return f.name.endsWith("AsNumpy") && f.type === "unknown";
}

/** 单张表的比对结论 */
type DiffKind = "ok" | "type" | "order" | "rename" | "missing" | "extra" | "mixed";
/** 单张表的比对明细 */
interface TableDiff {
  /** 所属 schema 文件（base 名，无扩展名） */
  file: string;
  key: string;
  fbsName: string;
  localName: string;
  kind: DiffKind;
  fbsCount: number;
  localCount: number;
  /** 同槽位改名（官方重构字段名，FBO 布局不变） */
  renames: { fbs: string; local: string }[];
  /** FBS 有、本地无的字段名（本地解不出该字段） */
  missing: string[];
  /** 本地有、FBS 无的字段名（CS 新增字段；已排除 AsNumpy 合成字段） */
  extra: string[];
  typeDiffs: { field: string; fbs: string; local: string }[];
}

/** 结果汇总结构（同时用于 stdout / JSON / Markdown） */
interface Report {
  generatedAt: string;
  fbsDir: string;
  schemaDir: string;
  filesCompared: number;
  fbsOnlyFiles: string[];
  localOnlyFiles: string[];
  rootMismatch: { file: string; fbs: string | null; local: string | null }[];
  fbsTableCount: number;
  localTableCount: number;
  fbsOnlyTables: { file: string; name: string; fields: number }[];
  /** FBS 独有的「纯向量包装表」`list_X { values: [X]; }`：本地内联写 `vec:X`，非真实缺口 */
  fbsOnlyWrappers: { file: string; name: string; fields: number }[];
  localOnlyTables: { file: string; name: string; fields: number }[];
  tableDiffs: TableDiff[];
  danglingFbs: { file: string; table: string; field: string; type: string; missing: string }[];
  danglingLocal: { file: string; table: string; field: string; type: string; missing: string }[];
  /** 本地字段类型 token 为字面量 `unknown`（CS 泛型实例化未解析，解码恒为 null） */
  unknownLocal: { file: string; table: string; field: string; type: string }[];
  /** 本地 slot 与字段序不自洽（slot ≠ 4 + 2×index） */
  slotAnomalies: { file: string; table: string; field: string; slot: number; expected: number }[];
  enumUndefined: { file: string; name: string; usedBy: string }[];
  enumBaseWidths: { file: string; name: string; base: string }[];
}

/**
 * 比对单张表
 * @param fbsName - FBS 侧表名
 * @param localName - 本地表名
 * @param fbsFields - FBS 字段
 * @param localFields - 本地字段
 * @param ctxF - FBS 规范化上下文
 * @param ctxL - 本地规范化上下文
 */
function diffTable(
  fileOf: string,
  fbsName: string,
  localName: string,
  fbsFields: Field[],
  localFields: Field[],
  ctxF: Ctx,
  ctxL: Ctx,
): TableDiff {
  const fbsF = fbsFields.map((f) => ({ name: f.name.toLowerCase(), type: canonType(f.type, ctxF) }));
  // AsNumpy 是本地历史合成字段（excel-convert 直接丢弃、解码器读作 null），
  // 会挤占数组下标并制造假「改名」，对齐前先剔除。
  const locF = localFields
    .filter((f) => !isSynthetic(f))
    .map((f) => ({ name: f.name.toLowerCase(), type: canonType(f.type, ctxL) }));
  const fbsNames = new Set(fbsF.map((f) => f.name));
  const locNames = new Set(locF.map((f) => f.name));
  const extra = [...locNames].filter((n) => !fbsNames.has(n)); // 本地多出来的字段
  const missing = [...fbsNames].filter((n) => !locNames.has(n)); // 本地缺的字段
  const typeDiffs: { field: string; fbs: string; local: string }[] = [];
  const renames: { fbs: string; local: string }[] = [];
  for (let i = 0; i < Math.min(fbsF.length, locF.length); i++) {
    if (fbsF[i].name !== locF[i].name) {
      renames.push({ fbs: fbsF[i].name, local: locF[i].name });
      continue;
    }
    if (fbsF[i].type !== locF[i].type) {
      typeDiffs.push({ field: fbsF[i].name, fbs: fbsF[i].type, local: locF[i].type });
    }
  }
  // 同槽位 1:1 改名：字段数相同且两侧独有名数量相等（此时 FBO 布局不受影响）
  const renameOnly =
    fbsF.length === locF.length && missing.length === extra.length && missing.length === renames.length && renames.length > 0;
  let kind: DiffKind = "ok";
  if (missing.length === 0 && extra.length === 0) {
    if (renames.length > 0) kind = "order";
    else if (typeDiffs.length) kind = "type";
  } else if (renameOnly) kind = "rename";
  else if (fbsF.length > locF.length) kind = "missing";
  else if (fbsF.length < locF.length) kind = "extra";
  else kind = "mixed";
  return {
    file: fileOf,
    key: canonTableName(fbsName, { ...ctxF, eraseEnum: true }),
    fbsName,
    localName,
    kind,
    fbsCount: fbsF.length,
    localCount: locF.length,
    renames,
    missing,
    extra,
    typeDiffs,
  };
}

/**
 * 从参考包 zip 中抽出指定版本的历史 FBS 到 `tmp/obs-fbs/<版本>/`
 *
 * zip 内路径约定 `<repo>-master/fbs/<版本>/*.fbs`（`reference/obs/OpenBachelorM-master.zip`）。
 * `tmp/` 被 gitignore，抽出结果是一次性产物；每次调用覆盖同名文件。
 *
 * @param zipRel  参考包路径（相对仓库根，或绝对路径）
 * @param version 客户端版本号，如 `2.7.61`
 * @returns 抽出目录的绝对路径；参考包缺失或该版本不存在时返回 `null`（按既有约定跳过而非报错）
 */
async function extractFbsFromZip(zipRel: string, version: string): Promise<string | null> {
  const zipPath = path.isAbsolute(zipRel) ? zipRel : path.join(ROOT, zipRel);
  if (!fs.existsSync(zipPath)) {
    console.log(`[SKIP] 参考包不存在：${zipRel}`);
    console.log("       历史 FBS 基线需要 reference/obs/OpenBachelorM-master.zip（gitignore 目录）。");
    return null;
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const outDir = path.join(ROOT, "tmp", "obs-fbs", version);
  const marker = `/fbs/${version}/`;
  let count = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !name.includes(marker) || !name.endsWith(".fbs")) continue;
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, path.basename(name)), await entry.async("nodebuffer"));
    count += 1;
  }
  if (count === 0) {
    console.log(`[SKIP] 参考包 ${zipRel} 中未找到 fbs/${version}/*.fbs`);
    return null;
  }
  console.log(`[INFO] 已从 ${zipRel} 抽出 ${count} 个 .fbs → ${path.relative(ROOT, outDir)}`);
  return outDir;
}

/** 主流程：解析两侧、逐表比对、产出报告 */
async function main(): Promise<void> {
  // obs 历史 FBS 以 zip 形式随参考包保留，需要时现抽到 tmp/obs-fbs/<版本>/
  if (FBS_ZIP && FBS_VERSION) {
    const extracted = await extractFbsFromZip(FBS_ZIP, FBS_VERSION);
    if (!extracted) return;
    FBS_DIR = extracted;
  }
  if (!fs.existsSync(FBS_DIR)) {
    console.log(`[SKIP] 参考副本不存在：${path.relative(ROOT, FBS_DIR)}`);
    console.log("       这是 gitignore 目录，需要本地放一份 OpenArknightsFBS（或 --fbs 指定路径）。");
    return;
  }
  const fbsFiles = fs.readdirSync(FBS_DIR).filter((f) => f.endsWith(".fbs")).sort();
  const localFiles = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json")).sort();
  const localBases = new Set(localFiles.map((f) => f.replace(/\.json$/, "")));
  const fbsBases = new Set(fbsFiles.map((f) => f.replace(/\.fbs$/, "")));

  const report: Report = {
    generatedAt: new Date().toISOString(),
    fbsDir: path.relative(ROOT, FBS_DIR),
    schemaDir: path.relative(ROOT, SCHEMA_DIR),
    filesCompared: 0,
    fbsOnlyFiles: [...fbsBases].filter((b) => !localBases.has(b)).sort(),
    localOnlyFiles: [...localBases].filter((b) => !fbsBases.has(b)).sort(),
    rootMismatch: [],
    fbsTableCount: 0,
    localTableCount: 0,
    fbsOnlyTables: [],
    fbsOnlyWrappers: [],
    localOnlyTables: [],
    tableDiffs: [],
    danglingFbs: [],
    danglingLocal: [],
    unknownLocal: [],
    slotAnomalies: [],
    enumUndefined: [],
    enumBaseWidths: [],
  };

  const shared = [...fbsBases].filter((b) => localBases.has(b) && (!TABLE_FILTER || b === TABLE_FILTER)).sort();

  for (const base of shared) {
    const fbs = parseFbs(fs.readFileSync(path.join(FBS_DIR, `${base}.fbs`), "utf-8"));
    const local = parseLocal(path.join(SCHEMA_DIR, `${base}.json`));
    const ctxF: Ctx = { enumBases: fbs.enumBases, eraseEnum: false };
    const ctxL: Ctx = { enumBases: new Map(), eraseEnum: false };
    const keyF: Ctx = { enumBases: fbs.enumBases, eraseEnum: true };
    const keyL: Ctx = { enumBases: new Map(), eraseEnum: true };
    report.filesCompared++;
    report.fbsTableCount += fbs.tables.size;
    report.localTableCount += local.tables.size;

    if (fbs.root !== local.root) {
      report.rootMismatch.push({ file: base, fbs: fbs.root, local: local.root });
    }
    for (const [name, base0] of fbs.enumBases) {
      if (base0 !== "int") report.enumBaseWidths.push({ file: base, name, base: base0 });
    }

    // 表匹配：先按结构签名分组（同签名取首个）
    const fbsByKey = new Map<string, { name: string; fields: Field[] }>();
    for (const [name, fields] of fbs.tables) {
      const k = canonTableName(name, keyF);
      if (!fbsByKey.has(k)) fbsByKey.set(k, { name, fields });
    }
    const localByKey = new Map<string, { name: string; fields: Field[] }>();
    for (const [name, fields] of local.tables) {
      const k = canonTableName(name, keyL);
      if (!localByKey.has(k)) localByKey.set(k, { name, fields });
    }
    for (const [k, fv] of fbsByKey) {
      if (localByKey.has(k)) continue;
      const entry = { file: base, name: fv.name, fields: fv.fields.length };
      // `list_X { values: [X]; }` 是 FBS 的向量包装表；本地把向量内联成 `vec:X`，
      // 表名只出现在 KV 表名里，不是缺失的解码表。
      const isWrapper =
        fv.name.startsWith("list_") &&
        fv.fields.length === 1 &&
        fv.fields[0].name.toLowerCase() === "values" &&
        fv.fields[0].type.startsWith("[");
      if (isWrapper) report.fbsOnlyWrappers.push(entry);
      else report.fbsOnlyTables.push(entry);
    }
    for (const [k, lv] of localByKey) {
      if (!fbsByKey.has(k)) report.localOnlyTables.push({ file: base, name: lv.name, fields: lv.fields.length });
    }
    for (const [k, fv] of fbsByKey) {
      const lv = localByKey.get(k);
      if (!lv) continue;
      const d = diffTable(base, fv.name, lv.name, fv.fields, lv.fields, ctxF, ctxL);
      if (d.kind !== "ok") report.tableDiffs.push(d);
    }

    // 悬空引用：字段引用了本文件未定义的表
    // 「已定义」只认表名本身就是该引用（`clz_X` / `hg__internal_X`）；
    // `dict__string__clz_X` 这类 KV 表名提到 X 不算定义，否则会掩盖真实悬空。
    const definedF = new Set<string>();
    for (const n of fbs.tables.keys()) {
      const c = canonTableName(n, keyF);
      if (c.startsWith("ref:")) definedF.add(c.slice(4));
    }
    const definedL = new Set<string>();
    for (const n of local.tables.keys()) {
      const c = canonTableName(n, keyL);
      if (c.startsWith("ref:")) definedL.add(c.slice(4));
    }
    for (const [tname, fields] of fbs.tables) {
      for (const f of fields) {
        for (const r of extractRefs(canonType(f.type, ctxF))) {
          const nm = r.slice(4);
          if (!definedF.has(nm)) report.danglingFbs.push({ file: base, table: tname, field: f.name, type: f.type, missing: nm });
        }
      }
    }
    for (const [tname, fields] of local.tables) {
      for (const f of fields) {
        const c = canonType(f.type, ctxL);
        if (c === "unknown" || c.includes("unknown")) {
          report.unknownLocal.push({ file: base, table: tname, field: f.name, type: f.type });
          continue;
        }
        for (const r of extractRefs(c)) {
          const nm = r.slice(4);
          if (!definedL.has(nm)) report.danglingLocal.push({ file: base, table: tname, field: f.name, type: f.type, missing: nm });
        }
      }
      // slot 期望值按「有效字段」（剔除 AsNumpy 合成字段）序号计算
      let effIdx = 0;
      for (const f of fields) {
        if (isSynthetic(f)) continue;
        if (f.slot !== 4 + 2 * effIdx) {
          report.slotAnomalies.push({ file: base, table: tname, field: f.name, slot: f.slot ?? -1, expected: 4 + 2 * effIdx });
        }
        effIdx++;
      }
    }
    // 枚举引用但未定义
    for (const [tname, fields] of fbs.tables) {
      for (const f of fields) {
        for (const em of f.type.match(/enum__[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?(?=__|$)/g) ?? []) {
          if (!fbs.enumBases.has(em)) report.enumUndefined.push({ file: base, name: em, usedBy: `${tname}.${f.name}` });
        }
      }
    }
  }

  printSummary(report);
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`\n已写出 JSON: ${JSON_OUT}`);
  }
  if (MD_OUT) {
    fs.mkdirSync(path.dirname(MD_OUT), { recursive: true });
    fs.writeFileSync(MD_OUT, renderMarkdown(report));
    console.log(`已写出 Markdown: ${MD_OUT}`);
  }
  if (STRICT) {
    // 硬漂移 = 会让数据静默消失或解码错位的三类：本地缺表、本地缺字段、本地悬空引用
    const hard =
      report.fbsOnlyTables.length +
      report.tableDiffs.filter((d) => d.kind === "missing" || d.kind === "mixed" || d.kind === "order").length +
      report.danglingLocal.length;
    if (hard > 0) process.exitCode = 1;
  }
}

/** 终端摘要 */
function printSummary(r: Report): void {
  const order = r.tableDiffs.filter((d) => d.kind === "order");
  const typeOnly = r.tableDiffs.filter((d) => d.kind === "type");
  const rename = r.tableDiffs.filter((d) => d.kind === "rename");
  const missing = r.tableDiffs.filter((d) => d.kind === "missing" || d.kind === "mixed");
  const extra = r.tableDiffs.filter((d) => d.kind === "extra");
  console.log(`比对 ${r.filesCompared} 组 schema（FBS ${r.fbsTableCount} 表 / 本地 ${r.localTableCount} 表）`);
  console.log(
    `表集合: FBS 独有 ${r.fbsOnlyTables.length}（另有 ${r.fbsOnlyWrappers.length} 张 list_ 向量包装表，本地内联为 vec:，非缺口） / 本地独有 ${r.localOnlyTables.length}`,
  );
  console.log(`表内字段: 本地缺字段 ${missing.length} 表；同槽位改名 ${rename.length} 表；本地多字段 ${extra.length} 表；序不一致 ${order.length} 表；类型宽度不一致 ${typeOnly.length} 表`);
  console.log(`悬空引用: 本地 ${r.danglingLocal.length} 处 / FBS ${r.danglingFbs.length} 处`);
  console.log(`本地未解析类型 token(unknown): ${r.unknownLocal.length} 处`);
  console.log(`slot 自洽性异常: ${r.slotAnomalies.length} 处；root 不一致: ${r.rootMismatch.length} 处`);
  if (r.fbsOnlyTables.length) {
    console.log("\n=== FBS 有、本地缺失的表（引到时解码为 {}）===");
    for (const t of r.fbsOnlyTables.slice(0, 20)) console.log(`  ${t.file.padEnd(24)} ${t.name} (${t.fields} 字段)`);
    if (r.fbsOnlyTables.length > 20) console.log(`  … 其余 ${r.fbsOnlyTables.length - 20} 张见 JSON/Markdown 报告`);
  }
  if (r.danglingLocal.length) {
    console.log("\n=== 本地悬空引用（前 10）===");
    for (const d of r.danglingLocal.slice(0, 10)) console.log(`  ${d.file} ${d.table}.${d.field} → ${d.missing}`);
  }
  if (missing.length) {
    console.log("\n=== 本地缺字段的表（FBS 有、本地解不出；前 10）===");
    for (const d of missing.slice(0, 10)) {
      console.log(`  ${d.fbsName}  FBS ${d.fbsCount} vs 本地 ${d.localCount}；缺: ${d.missing.slice(0, 5).join(", ")}`);
    }
  }
  if (rename.length) {
    console.log("\n=== 同槽位改名（FBO 布局不变；前 10）===");
    for (const d of rename.slice(0, 10)) {
      console.log(`  ${d.fbsName}: ${d.renames.slice(0, 3).map((x) => `${x.fbs}→${x.local}`).join(", ")}`);
    }
  }
  if (order.length) {
    console.log("\n=== 字段序不一致（前 10）===");
    for (const d of order.slice(0, 10)) console.log(`  ${d.fbsName}  FBS ${d.fbsCount} 字段 vs 本地 ${d.localCount} 字段`);
  }
  if (typeOnly.length) {
    console.log("\n=== 类型宽度差异（前 10）===");
    for (const d of typeOnly.slice(0, 10)) {
      const t = d.typeDiffs[0];
      console.log(`  ${d.fbsName}.${t.field}: FBS ${t.fbs} vs 本地 ${t.local}`);
    }
  }
}

/** 渲染 Markdown 报告 */
function renderMarkdown(r: Report): string {
  const L: string[] = [];
  const order = r.tableDiffs.filter((d) => d.kind === "order");
  const typeOnly = r.tableDiffs.filter((d) => d.kind === "type");
  const rename = r.tableDiffs.filter((d) => d.kind === "rename");
  const missing = r.tableDiffs.filter((d) => d.kind === "missing" || d.kind === "mixed");
  const extra = r.tableDiffs.filter((d) => d.kind === "extra");
  L.push(`# FBO schema 交叉校验报告：本地 vs OpenArknightsFBS`);
  L.push("");
  L.push(`- 生成时间：${r.generatedAt}`);
  L.push(`- 参考侧：\`${r.fbsDir}\`（OpenArknightsFBS，社区从游戏结构解析）`);
  L.push(`- 本地侧：\`${r.schemaDir}\`（由 CS 反编译派生）`);
  L.push(`- 比对范围：${r.filesCompared} 组同名 schema 文件；FBS ${r.fbsTableCount} 表 / 本地 ${r.localTableCount} 表`);
  L.push("");
  L.push(`## 摘要`);
  L.push("");
  L.push(`| 检查项 | 结果 |`);
  L.push(`| --- | --- |`);
  L.push(`| FBS 独有表（本地缺失 → 解码为 \`{}\`） | ${r.fbsOnlyTables.length} |`);
  L.push(`| FBS 独有 \`list_X\` 向量包装表（本地内联 \`vec:X\`，非缺口） | ${r.fbsOnlyWrappers.length} |`);
  L.push(`| 本地独有表 | ${r.localOnlyTables.length} |`);
  L.push(`| 表内字段缺失（本地解不出） | ${missing.length} 表 |`);
  L.push(`| 同槽位改名（布局不变） | ${rename.length} 表 |`);
  L.push(`| 本地多出字段 | ${extra.length} 表 |`);
  L.push(`| 字段序（slot 布局）不一致 | ${order.length} 表 |`);
  L.push(`| 类型宽度不一致 | ${typeOnly.length} 表 |`);
  L.push(`| 本地悬空引用 | ${r.danglingLocal.length} 处 |`);
  L.push(`| 本地未解析类型 token（\`unknown\`） | ${r.unknownLocal.length} 处 |`);
  L.push(`| FBS 悬空引用 | ${r.danglingFbs.length} 处 |`);
  L.push(`| 本地 slot 与字段序不自洽 | ${r.slotAnomalies.length} 处 |`);
  L.push(`| root_type 不一致 | ${r.rootMismatch.length} 处 |`);
  L.push(`| FBS 枚举引用未定义 | ${r.enumUndefined.length} 处 |`);
  L.push(`| 非 int 基类型枚举（宽度风险） | ${r.enumBaseWidths.length} 个 |`);
  L.push("");

  const table = (rows: string[], header: string[]) => {
    L.push(`| ${header.join(" | ")} |`);
    L.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of rows) L.push(`| ${row} |`);
    L.push("");
  };

  L.push(`## 1. FBS 有、本地缺失的表`);
  L.push("");
  L.push(`本地 schema 没有这些表定义，而 FBS 有 → 字段引用它们时 \`scripts/vendor/fbo.ts#tableToJson\` 返回 \`{}\`，数据静默丢失。`);
  L.push("");
  if (r.fbsOnlyTables.length) {
    table(
      r.fbsOnlyTables.map((t) => `${t.file} | \`${t.name}\` | ${t.fields}`),
      ["schema 文件", "表名", "FBS 字段数"],
    );
  } else L.push("（无）\n");

  L.push(`## 2. 本地独有表`);
  L.push("");
  if (r.localOnlyTables.length) {
    table(
      r.localOnlyTables.map((t) => `${t.file} | \`${t.name}\` | ${t.fields}`),
      ["schema 文件", "表名", "本地字段数"],
    );
  } else L.push("（无）\n");

  L.push(`## 3. 表内字段差异`);
  L.push("");
  L.push(`按表字段（已剔除本地 \`*AsNumpy\` 历史合成字段）逐位置对齐后分类。`);
  L.push("");
  L.push(`### 3.1 本地缺字段（FBS 有、本地解不出 → 数据静默丢失）`);
  L.push("");
  if (missing.length) {
    table(
      missing.map(
        (d) => `${d.file} | \`${d.fbsName}\` | ${d.fbsCount} | ${d.localCount} | ${d.missing.slice(0, 6).join(", ") || "-"}`,
      ),
      ["schema 文件", "表", "FBS 字段", "本地字段", "本地缺失字段（前 6）"],
    );
  } else L.push("（无）\n");
  L.push(`### 3.2 字段名差异（同槽位 1:1，FBO 布局不变）`);
  L.push("");
  L.push(`成因两类：官方重构改名（如 \`levelUpCostCond → specializeLevelUpData\`），以及命名风格差异（FBS snake_case vs 本地 PascalCase、\`def → def_\` 之类的转义）。二者都不影响解码，但下游按名取值需对齐。`);
  L.push("");
  if (rename.length) {
    table(
      rename.map((d) => `${d.file} | \`${d.fbsName}\` | ${d.renames.slice(0, 6).map((x) => `${x.fbs} → ${x.local}`).join("; ")}`),
      ["schema 文件", "表", "字段名对照（FBS → 本地）"],
    );
  } else L.push("（无）\n");
  L.push(`### 3.3 本地多出字段（CS 新增，本地已跟上）`);
  L.push("");
  if (extra.length) {
    table(
      extra.map((d) => `${d.file} | \`${d.fbsName}\` | ${d.fbsCount} | ${d.localCount} | ${d.extra.slice(0, 6).join(", ") || "-"}`),
      ["schema 文件", "表", "FBS 字段", "本地字段", "本地多出（前 6）"],
    );
  } else L.push("（无）\n");
  L.push(`### 3.4 字段序不一致（同名字段换位，会解码错位）`);
  L.push("");
  if (order.length) {
    table(
      order.map((d) => `${d.file} | \`${d.fbsName}\` | FBS ${d.fbsCount} | 本地 ${d.localCount}`),
      ["schema 文件", "表", "FBS 字段", "本地字段"],
    );
  } else L.push("（无）\n");

  L.push(`## 4. 类型宽度不一致`);
  L.push("");
  if (typeOnly.length) {
    table(
      typeOnly.map((d) => `\`${d.fbsName}\` | ${d.typeDiffs.map((t) => `${t.field}: ${t.fbs}→${t.local}`).join("; ")}`),
      ["表", "字段（FBS→本地）"],
    );
  } else L.push("（无）\n");

  L.push(`## 5. 悬空引用`);
  L.push("");
  L.push(`### 5.1 本地（字段类型指向本文件未定义的表）`);
  L.push("");
  if (r.danglingLocal.length) {
    table(
      r.danglingLocal.map((d) => `${d.file} | \`${d.table}\` | ${d.field} | \`${d.missing}\``),
      ["schema 文件", "所在表", "字段", "缺失表"],
    );
  } else L.push("（无）\n");
  L.push(`### 5.2 FBS 侧`);
  L.push("");
  if (r.danglingFbs.length) {
    table(
      r.danglingFbs.map((d) => `${d.file} | \`${d.table}\` | ${d.field} | \`${d.missing}\``),
      ["schema 文件", "所在表", "字段", "缺失表"],
    );
  } else L.push("（无，FBS 自洽）\n");
  L.push(`### 5.3 本地未解析类型 token（\`unknown\`）`);
  L.push("");
  L.push(`\`cs2schema.ts\` 无法映射的泛型实例化会写成字面量 \`unknown\`，\`fbo.ts#readFieldValue\` 对它返回 \`null\`。`);
  L.push("");
  if (r.unknownLocal.length) {
    table(
      r.unknownLocal.map((d) => `${d.file} | \`${d.table}\` | ${d.field} | \`${d.type}\``),
      ["schema 文件", "所在表", "字段", "类型 token"],
    );
  } else L.push("（无）\n");

  L.push(`## 6. 其它`);
  L.push("");
  if (r.rootMismatch.length) {
    L.push(`### root_type 不一致`);
    L.push("");
    table(
      r.rootMismatch.map((d) => `${d.file} | ${d.fbs} | ${d.local}`),
      ["文件", "FBS", "本地"],
    );
  }
  if (r.enumBaseWidths.length) {
    L.push(`### 非 int 基类型枚举（本地 \`enum\` 按 i32 读取，存在读宽不匹配）`);
    L.push("");
    table(
      r.enumBaseWidths.map((d) => `${d.file} | \`${d.name}\` | ${d.base}`),
      ["文件", "枚举", "基类型"],
    );
  }
  if (r.enumUndefined.length) {
    L.push(`### FBS 枚举引用未定义`);
    L.push("");
    table(
      r.enumUndefined.map((d) => `${d.file} | \`${d.name}\` | ${d.usedBy}`),
      ["文件", "枚举", "使用处"],
    );
  }
  if (r.slotAnomalies.length) {
    L.push(`### 本地 slot 与字段序不自洽`);
    L.push("");
    table(
      r.slotAnomalies.map((d) => `${d.file} | \`${d.table}\` | ${d.field} | ${d.slot} | ${d.expected}`),
      ["文件", "表", "字段", "实际 slot", "期望 slot"],
    );
  }
  return L.join("\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
