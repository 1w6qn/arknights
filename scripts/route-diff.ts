/**
 * OBS ⇄ DoctorateTs 路由差集（**挂载感知**，静态近似）
 *
 * 背景：`api.md` 的「OBS 移植端点」清单最早由一个删掉的 `scripts/_diff-routes.py` 生成，
 * 它把挂载前缀**硬编码**在脚本里，模块前缀一变（或新模块用 `app/server.ts` 挂载）就产生
 * 假阴性——「OBS 有、本仓也有，只是工具没找到」。本工具改为从**当前源码**推导挂载关系：
 *
 *  1. OBS 侧：读参考包 `reference/obs/OpenBachelorS-master.zip` 的 `bp/*.py`（FastAPI），
 *     收集 `@router.<method>("/path")`；OBS 的路径是**绝对路径**（`include_router` 不带
 *     `url_prefix`），无需再拼前缀。
 *  2. 本仓侧：`app/game/routes.ts` 的声明式路由表（prefix → 模块 + exportName）与
 *     `app/server.ts` 的 `app.use("<prefix>", ...)`（含 `await import(...)).default`）共同构成挂载点；
 *     再按「接收者变量」（`router` / `rootRouter`）递归展开模块内的 `router.use(child)` 嵌套。
 *  3. 归一化两侧路径参数（`{x}` → `:x`）后按 (路径, 方法) 比对，输出 OBS 未被覆盖的端点，
 *     并对每条缺口给出「同名末段」的本仓路径作为挂载错位提示。
 *
 * 用法:
 *   pnpm run routes:diff
 *   pnpm run routes:diff -- --obs-zip reference/obs/OpenBachelorS-master.zip
 *   pnpm run routes:diff -- --json tmp/obs-routes-diff.json
 */
import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";

const ROOT = path.join(__dirname, "..");
const DEFAULT_OBS_ZIP = path.join("reference", "obs", "OpenBachelorS-master.zip");
const ROUTES_TABLE = path.join(ROOT, "app", "game", "routes.ts");
const SERVER_FILE = path.join(ROOT, "app", "server.ts");

const argv = process.argv.slice(2);
/** 读取 `--name value` 形式的参数 */
function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const OBS_ZIP = opt("--obs-zip") ?? DEFAULT_OBS_ZIP;
const JSON_OUT = opt("--json");

/** `@alias` → 仓库内目录（与 tsconfig paths 一致） */
const ALIASES: Record<string, string> = {
  "@game": "app/game",
  "@core": "app/core",
  "@excel": "app/game/excel",
  "@utils": "app/core/utils",
  "@ops": "app/ops",
  "@asset": "app/ops/assets",
  "@plugin": "app/ops/plugin",
  "@capture": "app/ops/capture",
  "@logs": "app/core/logs",
};

/** 解析后的路由条目 */
interface RouteHit {
  /** 完整路径（已含挂载前缀） */
  path: string;
  /** 大写 HTTP 方法；`ALL` 表示 router.all */
  methods: string[];
  /** 来源文件（仓库相对路径，便于人工核对） */
  source: string;
}

/** 文件内的引用关系 */
interface FileRefs {
  /** 标识符 → (文件绝对路径, 导出名) */
  imports: Map<string, { file: string; exportName: string }>;
  /** 本文件内 `const X = Router()` 的 X */
  localRouters: Set<string>;
  /** `export default X;` 的 X */
  defaultIdent: string | null;
  /** 导出名 → 本文件内的标识符（`export const Y = router` / `export { router as Y }`） */
  exportedIdents: Map<string, string>;
}

/** 文件缓存：文本与引用关系 */
const fileCache = new Map<string, { text: string; refs: FileRefs }>();

/** 把 import 说明符解析为绝对文件路径；无法解析（裸模块）返回 null */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string | null = null;
  if (spec.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    for (const alias of Object.keys(ALIASES)) {
      if (spec === alias || spec.startsWith(`${alias}/`)) {
        base = path.join(ROOT, ALIASES[alias], spec.slice(alias.length + 1));
        break;
      }
    }
  }
  if (!base) return null;
  for (const cand of [`${base}.ts`, path.join(base, "index.ts"), base]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** 解析一个 TS 文件的 import/export 引用关系（带缓存） */
function loadFile(file: string): { text: string; refs: FileRefs } {
  const cached = fileCache.get(file);
  if (cached) return cached;
  const text = fs.readFileSync(file, "utf-8");
  const imports = new Map<string, { file: string; exportName: string }>();
  const localRouters = new Set<string>();
  const exportedIdents = new Map<string, string>();
  let defaultIdent: string | null = null;

  // import <clause> from "spec";
  const importRe = /import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text)) !== null) {
    const target = resolveSpec(m[2], file);
    if (!target) continue;
    const clause = m[1].trim();
    const braceIdx = clause.indexOf("{");
    const head = (braceIdx >= 0 ? clause.slice(0, braceIdx) : clause).trim();
    // 默认导入名（clause 形如 `X, { a as b }` 或 `X`）
    const defName = head.replace(/,$/, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(defName)) imports.set(defName, { file: target, exportName: "default" });
    if (braceIdx >= 0) {
      const inner = clause.slice(braceIdx + 1, clause.lastIndexOf("}"));
      for (const part of inner.split(",")) {
        const seg = part.trim();
        if (!seg) continue;
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(seg);
        if (asMatch) imports.set(asMatch[2], { file: target, exportName: asMatch[1] });
        else if (/^[A-Za-z_$][\w$]*$/.test(seg)) imports.set(seg, { file: target, exportName: seg });
      }
    }
  }
  // export { a as b } from "spec";
  const reexportRe = /export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  while ((m = reexportRe.exec(text)) !== null) {
    const target = resolveSpec(m[2], file);
    if (!target) continue;
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(seg);
      if (asMatch) imports.set(asMatch[2], { file: target, exportName: asMatch[1] });
      else if (/^[A-Za-z_$][\w$]*$/.test(seg)) imports.set(seg, { file: target, exportName: seg });
    }
  }
  const defRe = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/g;
  while ((m = defRe.exec(text)) !== null) defaultIdent = m[1];
  const localRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\.)?Router\(\)/g;
  while ((m = localRe.exec(text)) !== null) localRouters.add(m[1]);
  // `export const Y = X;` 与 `export { X as Y };`：导出名 → 本地标识符
  const exportConstRe = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g;
  while ((m = exportConstRe.exec(text)) !== null) exportedIdents.set(m[1], m[2]);
  const exportListRe = /export\s*\{([^}]*)\}\s*;/g;
  while ((m = exportListRe.exec(text)) !== null) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(seg);
      if (asMatch) exportedIdents.set(asMatch[2], asMatch[1]);
      else if (/^[A-Za-z_$][\w$]*$/.test(seg)) exportedIdents.set(seg, seg);
    }
  }

  const entry = { text, refs: { imports, localRouters, defaultIdent, exportedIdents } };
  fileCache.set(file, entry);
  return entry;
}

/** 求某文件对外的某个导出名在文件内对应的 router 变量名 */
function receiverFor(file: string, exportName: string): string {
  const { refs } = loadFile(file);
  if (exportName === "default") return refs.defaultIdent ?? "router";
  return refs.exportedIdents.get(exportName) ?? exportName;
}

/**
 * 从 `(` 之后取第一个字符串字面量参数，跳过空白与注释（支持跨行、带注释的 `router.get(` 调用）
 * @returns 字面量内容；第一个 token 不是字符串（变量/模板）时返回 `null`
 */
function firstStringArg(text: string, from: number): string | null {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = text.indexOf(c, i + 1);
      return end < 0 ? null : text.slice(i + 1, end);
    }
    return null;
  }
  return null;
}

/**
 * 收集某文件上某个 router 变量注册的路由（含 `use(child)` 递归）
 *
 * @param file     文件绝对路径
 * @param receiver router 变量名（`router` / `rootRouter` / 局部 router）
 * @param prefix   已累积的前缀（含挂载前缀）
 * @param out      结果数组
 * @param seen     递归去重键
 */
function collectFrom(
  file: string,
  receiver: string,
  prefix: string,
  out: RouteHit[],
  seen: Set<string>,
): void {
  const key = `${file}|${receiver}|${prefix}`;
  if (seen.has(key)) return;
  seen.add(key);
  const { text, refs } = loadFile(file);
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const routeCallRe = new RegExp(`\\b${receiver}\\.(get|post|put|delete|patch|all)\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = routeCallRe.exec(text)) !== null) {
    const routePath = firstStringArg(text, m.index + m[0].length);
    if (routePath === null) continue;
    out.push({ path: joinPath(prefix, routePath), methods: [m[1].toUpperCase()], source: rel });
  }
  // `for (const p of ["/a", "/b"]) { router.all(p, ...) }`：路径放数组循环注册时正则看不到字面量，
  // 这里显式展开（misc-alignment 的 EN/YoStar stub、gate 平台枚举都用这种写法）
  const loopRe = /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[([\s\S]*?)\]\s*\)/g;
  while ((m = loopRe.exec(text)) !== null) {
    const varName = m[1];
    const used = new RegExp(`\\b${receiver}\\.(get|post|put|delete|patch|all)\\(\\s*${varName}\\b`).exec(text);
    if (!used) continue;
    for (const lit of m[2].match(/["'`]([^"'`]+)["'`]/g) ?? []) {
      out.push({ path: joinPath(prefix, lit.slice(1, -1)), methods: [used[1].toUpperCase()], source: rel });
    }
  }
  const useRe = new RegExp(
    `\\b${receiver}\\.use\\(\\s*(?:["'\`]([^"'\`]+)["'\`]\\s*,\\s*)?([A-Za-z_$][\\w$]*)`,
    "g",
  );
  while ((m = useRe.exec(text)) !== null) {
    const sub = m[1] ?? "";
    const ident = m[2];
    const childPrefix = joinPath(prefix, sub);
    if (refs.localRouters.has(ident)) {
      collectFrom(file, ident, childPrefix, out, seen);
    } else {
      const imp = refs.imports.get(ident);
      if (!imp) continue;
      const childReceiver = receiverFor(imp.file, imp.exportName);
      collectFrom(imp.file, childReceiver, childPrefix, out, seen);
    }
  }
}

/** 拼接挂载前缀与路由路径（去除重复斜杠） */
function joinPath(prefix: string, sub: string): string {
  if (!prefix || prefix === "/") return sub.startsWith("/") ? sub : `/${sub}`;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return sub.startsWith("/") ? `${p}${sub}` : `${p}/${sub}`;
}

/** 归一化路径：`{x}` → `:x`，去掉尾斜杠 */
function normalize(p: string): string {
  const s = p.replace(/\{([^}]+)\}/g, ":$1").replace(/\/+$/, "");
  return s === "" ? "/" : s;
}

/** 路径分段（统一小写——Express 路由默认大小写不敏感） */
function segments(p: string): string[] {
  return normalize(p)
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

/** 该段是否为通配（`:x` 或 `*x`） */
function isWild(seg: string): boolean {
  return seg.startsWith(":") || seg.startsWith("*");
}

/**
 * 路径模式匹配：模式段里的 `:x` / `*x` 匹配一段；末尾 `*x` 匹配剩余全部
 * （两侧都允许含通配，OBS 的 `{}` 已归一为 `:x`）
 */
function pathMatches(pattern: string[], obs: string[]): boolean {
  let i = 0;
  let j = 0;
  while (i < pattern.length && j < obs.length) {
    const p = pattern[i];
    if (p.startsWith("*") && i === pattern.length - 1) return true;
    if (!isWild(p) && !isWild(obs[j]) && p !== obs[j]) return false;
    i += 1;
    j += 1;
  }
  if (i === pattern.length && j === obs.length) return true;
  return i === pattern.length - 1 && pattern[i].startsWith("*");
}

/**
 * URL 重写别名：与 `app/game/routes.ts` 里的 rewrite 函数一一对应。
 * 挂载带 rewrite 时，客户端看到的外部路径 ≠ 内部 router 路径，故须在此显式换算；
 * **新增 rewrite 函数时必须在此登记**，否则该挂载下的路径会被算成缺口（假阳性）。
 */
const REWRITE_PREFIX_MAP: Record<string, { from: string; to: string }[]> = {
  // crisisV2Rewrite：req.url 前置 /v2（/crisisV2/battleStart → /v2/battleStart）
  crisisV2Rewrite: [{ from: "/v2", to: "" }],
  // sandboxPermRewrite：/sandboxV2|V3/* ↔ /v2|/v3/*
  sandboxPermRewrite: [
    { from: "/v2", to: "/sandboxV2" },
    { from: "/v3", to: "/sandboxV3" },
  ],
};

/** 按 rewrite 表把一个内部路由路径换算成外部路径；无匹配返回 null */
function applyRewrite(prefix: string, fullPath: string, rewrite: string): string | null {
  const mapping = REWRITE_PREFIX_MAP[rewrite];
  if (!mapping) return null;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const rel = fullPath.slice(p.length);
  for (const { from, to } of mapping) {
    if (rel === from || rel.startsWith(`${from}/`)) return `${p}${to}${rel.slice(from.length)}`;
  }
  return null;
}

/** 收集 `const X: Record<string, string> = { "K": "V", ... }` 的键（server.ts 的旧路径别名表） */
function collectAliasKeys(text: string, constName: string): string[] {
  const re = new RegExp(`const\\s+${constName}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`);
  const m = re.exec(text);
  if (!m) return [];
  const keys: string[] = [];
  for (const pair of m[1].matchAll(/["']([^"']+)["']\s*:/g)) keys.push(pair[1]);
  return keys;
}

/** 本仓全部路由（挂载感知） */
function collectDtsRoutes(): RouteHit[] {
  const out: RouteHit[] = [];
  const seen = new Set<string>();

  // 1) app/game/routes.ts 声明式路由表
  const tableText = fs.readFileSync(ROUTES_TABLE, "utf-8");
  const entryRe =
    /\{\s*prefix:\s*"([^"]*)"\s*,\s*module:\s*"([^"]*)"\s*(?:,\s*exportName:\s*"([^"]*)")?\s*(?:,\s*rewrite:\s*([A-Za-z_$][\w$]*))?/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(tableText)) !== null) {
    const prefix = m[1];
    const modSpec = m[2];
    const exportName = m[3] ?? "default";
    const rewrite = m[4];
    const file = resolveSpec(modSpec, ROUTES_TABLE);
    if (!file) continue;
    const receiver = receiverFor(file, exportName);
    const start = out.length;
    collectFrom(file, receiver, prefix, out, seen);
    if (rewrite) {
      // 带 rewrite 的挂载：把内部路径换算成客户端实际调用的外部路径（两种形式都保留）
      for (const hit of out.slice(start)) {
        const external = applyRewrite(prefix, hit.path, rewrite);
        if (external) out.push({ path: external, methods: hit.methods, source: hit.source });
      }
    }
  }

  // 2) app/server.ts 的 app.use("<prefix>", <target>)
  const serverText = fs.readFileSync(SERVER_FILE, "utf-8");
  const serverRefs = loadFile(SERVER_FILE).refs;
  const useLineRe = /app\.use\(\s*"([^"]+)"\s*,\s*(.+)$/gm;
  while ((m = useLineRe.exec(serverText)) !== null) {
    const prefix = m[1];
    const tail = m[2].trim();
    const dyn = /import\(\s*["']([^"']+)["']\s*\)/.exec(tail);
    let file: string | null = null;
    let exportName = "default";
    if (dyn) {
      file = resolveSpec(dyn[1], SERVER_FILE);
    } else {
      const ident = /^([A-Za-z_$][\w$]*)/.exec(tail);
      if (!ident) continue; // 形如 (req, res, next) => ... 的中间件，跳过
      const imp = serverRefs.imports.get(ident[1]);
      if (imp) {
        file = imp.file;
        exportName = imp.exportName;
      }
    }
    if (!file) continue;
    // `game`（@game/app）本身是「路由表挂在 /」，其子路由自带前缀，故不再叠加
    if (file === path.join(ROOT, "app", "game", "app.ts")) {
      const gamePrefix = prefix === "/" ? "" : prefix;
      const gameSeen = new Set<string>();
      const entriesText = fs.readFileSync(ROUTES_TABLE, "utf-8");
      const re = /\{\s*prefix:\s*"([^"]*)"\s*,\s*module:\s*"([^"]*)"\s*(?:,\s*exportName:\s*"([^"]*)")?/g;
      let e: RegExpExecArray | null;
      while ((e = re.exec(entriesText)) !== null) {
        const subFile = resolveSpec(e[2], ROUTES_TABLE);
        if (!subFile) continue;
        const subExport = e[3] ?? "default";
        const receiver = receiverFor(subFile, subExport);
        collectFrom(subFile, receiver, joinPath(gamePrefix, e[1]), out, gameSeen);
      }
      continue;
    }
    const receiver = receiverFor(file, exportName);
    collectFrom(file, receiver, prefix, out, seen);
  }

  // 3) server.ts 的旧路径别名表（OLD_AUTH_ALIASES）：键即客户端可用路径，方法不限
  for (const key of collectAliasKeys(serverText, "OLD_AUTH_ALIASES")) {
    out.push({ path: key, methods: ["ALL"], source: "app/server.ts#OLD_AUTH_ALIASES" });
  }
  return out;
}

/** 从 OBS zip 收集 `@router.<method>("/path")` */
async function collectObsRoutes(zipRel: string): Promise<{ path: string; methods: string[]; file: string }[]> {
  const zipPath = path.isAbsolute(zipRel) ? zipRel : path.join(ROOT, zipRel);
  if (!fs.existsSync(zipPath)) {
    console.log(`[SKIP] OBS 参考包不存在：${zipRel}`);
    return [];
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const out: { path: string; methods: string[]; file: string }[] = [];
  const routeRe = /@(\w+)\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g;
  for (const name of Object.keys(zip.files).sort()) {
    if (!/\/bp\/[^/]+\.py$/.test(name)) continue;
    const entry = zip.file(name);
    if (!entry) continue;
    const text = await entry.async("string");
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(text)) !== null) {
      out.push({ path: normalize(m[3]), methods: [m[2].toUpperCase()], file: name.split("/").slice(-2).join("/") });
    }
  }
  return out;
}

/** 主流程 */
async function main(): Promise<number> {
  const obs = await collectObsRoutes(OBS_ZIP);
  if (obs.length === 0) return 1;
  const dts = collectDtsRoutes();

  /** 本仓路由模式（含通配） */
  const patterns = dts.map((hit) => ({ path: hit.path, segs: segments(hit.path), methods: new Set(hit.methods) }));

  const missing: { path: string; methods: string[]; file: string; near: string[] }[] = [];
  const obsSeen = new Set<string>();
  for (const o of obs) {
    const dedupKey = `${o.path}|${o.methods.join(",")}`;
    if (obsSeen.has(dedupKey)) continue;
    obsSeen.add(dedupKey);
    const obsSegs = segments(o.path);
    const matched = patterns.filter((p) => pathMatches(p.segs, obsSegs));
    const absent = o.methods.filter((meth) => !matched.some((p) => p.methods.has(meth) || p.methods.has("ALL")));
    if (absent.length > 0) {
      const lastSeg = obsSegs[obsSegs.length - 1] ?? "";
      const near = [...new Set(patterns.filter((p) => (p.segs[p.segs.length - 1] ?? "") === lastSeg).map((p) => p.path))].slice(0, 3);
      missing.push({ path: o.path, methods: absent, file: o.file, near });
    }
  }

  const uniqueObs = new Set(obs.map((o) => o.path));
  console.log(`OBS 路由 ${obs.length} 条（去重 ${uniqueObs.size} 条路径） / 本仓路由 ${dts.length} 条（去重 ${patterns.length} 条）`);
  console.log(`未完全覆盖：${missing.length} 条路径`);
  console.log("");
  let currentFile = "";
  for (const mm of missing) {
    if (mm.file !== currentFile) {
      currentFile = mm.file;
      console.log(`== ${currentFile} ==`);
    }
    const near = mm.near.length ? `   [本仓同名末段: ${mm.near.join(" , ")}]` : "";
    console.log(`  ${mm.methods.join("/").padEnd(10)} ${mm.path}${near}`);
  }
  if (JSON_OUT) {
    const outPath = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(ROOT, JSON_OUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const dtsPaths: Record<string, string[]> = {};
    for (const p of patterns) dtsPaths[p.path] = [...p.methods];
    fs.writeFileSync(
      outPath,
      JSON.stringify({ obsTotal: obs.length, dtsTotal: patterns.length, missing, dtsPaths }, null, 2),
      "utf-8",
    );
    console.log(`\n[JSON] ${JSON_OUT}`);
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
