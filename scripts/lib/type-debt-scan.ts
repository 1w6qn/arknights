/**
 * 类型债扫描器（纯函数，零依赖）
 *
 * 统计源码中 TS 的模糊类型表述：裸关键字 `any` / `unknown` / `object`，
 * 以及 zod 逃生口 `z.any()` / `z.unknown()`。作为「类型债棘轮」的度量基础。被两处复用：
 *  - tests/unit/architecture/type-debt-ratchet.test.ts（守卫，CI 红灯）
 *  - scripts/type-debt.ts（CLI：报告 / 刷新基线）
 *
 * 关键点：注释、字符串、模板字面量与正则字面量必须先剥离，否则
 * `typeof x === "object"`、`/^(...|object|any)$/` 会被误计为类型债。
 */

/** 单个文件的模糊类型计数 */
export interface TypeDebtCounts {
  /** TS `any` 关键字出现次数 */
  any: number;
  /** TS `unknown` 关键字出现次数 */
  unknown: number;
  /** TS `object` 关键字出现次数 */
  object: number;
}

/** 受控关键字（顺序即报告顺序） */
export const DEBT_KEYS = ["any", "unknown", "object"] as const;

/**
 * 默认扫描目录（全范围）
 *
 * 覆盖业务代码（`app`）、运维脚本（`scripts`）、测试（`tests`）与 Frida hook（`hook`）：
 * `any` 债不因目录不同而合法，测试与脚本同样是仓库资产。守卫与 CLI 共用本常量，
 * 保证「守卫判定」与「基线刷新」口径永远一致。
 */
export const SCAN_DIRS = ["app", "scripts", "tests", "hook"] as const;

/** 默认扫描的单文件（仓库根入口，不在 SCAN_DIRS 内） */
export const SCAN_EXTRA_FILES = ["index.ts"] as const;

/** 受控关键字类型 */
export type DebtKey = (typeof DEBT_KEYS)[number];

/**
 * 判断某个符号能否位于正则字面量之前
 *
 * 用于把 `/^a|b$/` 与除法 `a / b` 区分开：只有 `(`、`,`、`=` 这类
 * 不可能出现在表达式末尾的字符，或 `return`/`typeof` 这类关键字之后，`/` 才开启正则。
 * @param prevChar - 上一个非空白源码字符（空串表示行首）
 * @param prevWord - 以该字符结尾的标识符（无则空串）
 * @returns 该位置的 `/` 是否起始一个正则字面量
 */
export function canStartRegex(prevChar: string, prevWord: string): boolean {
  if (prevChar === "") return true;
  if ("(,=:[!&|?{};+-*%~^<>".includes(prevChar)) return true;
  return [
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "case",
    "do",
    "else",
    "yield",
    "await",
  ].includes(prevWord);
}

/**
 * 剥离注释、字符串、模板字面量与正则字面量，仅保留可分析的代码骨架
 *
 * 被剥离片段以空格占位，避免相邻标识符粘连产生假匹配。
 * @param src - 源码全文
 * @returns 剥离后的代码文本
 */
export function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let prevChar = "";
  let prevWord = "";
  /** 记录上一个有意义字符，供正则判定使用 */
  const mark = (c: string): void => {
    if (/\s/.test(c)) return;
    if (/[A-Za-z0-9_$]/.test(c)) prevWord = /[A-Za-z0-9_$]/.test(prevChar) ? prevWord + c : c;
    else prevWord = "";
    prevChar = c;
  };
  while (i < n) {
    const c = src[i];
    // 行注释
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // 块注释
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 正则字面量
    if (c === "/" && canStartRegex(prevChar, prevWord)) {
      i++;
      let inClass = false;
      while (i < n) {
        const rc = src[i];
        if (rc === "\\") {
          i += 2;
          continue;
        }
        if (rc === "\n") break;
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) {
          i++;
          break;
        }
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      out += " ";
      continue;
    }
    // 字符串与模板字面量
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    out += c;
    mark(c);
    i++;
  }
  return out;
}

/**
 * 类型位置的裸关键字
 *
 * 两条排除规则：
 *  - `(?<![\w$.])`：排除成员访问（`z.object(...)` 等 API 调用不是类型债）；
 *  - `(?!\s*:)`：排除**对象字面量/接口成员的属性名**（`{ any: 0 }`、`{ object: 2 }`）。
 *    类型位置的 `any`/`unknown`/`object` 后面永远不是 `:`：`(a: any)` → `)`、
 *    `Record<string, any>` → `>`、`as any` → 语句结束、`{ [k: string]: any }` → `}`、
 *    `T extends any ? … : …` → `?`；而作为属性名时必然紧跟 `:`。
 * @param kw - 关键字（any / unknown / object）
 * @returns 全局正则
 */
function bareKeyword(kw: DebtKey): RegExp {
  return new RegExp(`(?<![\\w$.])${kw}\\b(?!\\s*:)`, "g");
}

/**
 * zod 逃生口：`z.any()` / `z.unknown()` 是「接受任意值」的 schema，
 * 与类型关键字属同一类模糊表述，必须计入（`z.object({...})` 是精确 schema，不计）。
 * @param kw - 关键字（any / unknown）
 * @returns 全局正则
 */
function zodEscape(kw: DebtKey): RegExp {
  return new RegExp(`\\bz\\s*\\.\\s*${kw}\\s*\\(`, "g");
}

/**
 * 统计一段源码中的模糊类型表述
 *
 * 口径（与 docs/type-system-audit.md §2 一致）：
 *  - 裸 `any`/`unknown`/`object` 关键字（类型位置）：`(?<![\w$.])` 排除成员访问，
 *    因此 `z.object({...})` 不计——它是精确的 zod schema，不是模糊类型；
 *    `(?!\s*:)` 排除属性名（`{ any: 0 }` 的键名不是类型债，见 {@link bareKeyword}）。
 *  - zod 逃生口 `z.any()`/`z.unknown()`：计入对应关键字；`z.object()` 不计。
 * @param src - 源码全文（未经剥离）
 * @returns 三个受控关键字的出现次数
 */
export function countVagueTypes(src: string): TypeDebtCounts {
  const code = stripCommentsAndStrings(src);
  const count = (re: RegExp): number => (code.match(re) || []).length;
  // 局部变量刻意避开 `any` / `unknown` / `object` 三个标识符：它们本身不是类型位置，
  // 但 `const any = …`、`{ any, unknown, object }`（简写属性）会被 {@link bareKeyword}
  // 误计（属性名排除规则只认 `key:` 形式）。改用 cntXxx + 显式属性名，扫描器自计归零，
  // 公开键名（TypeDebtCounts）保持不变。
  const cntObject = count(bareKeyword("object"));
  const cntAny = count(bareKeyword("any")) + count(zodEscape("any"));
  const cntUnknown = count(bareKeyword("unknown")) + count(zodEscape("unknown"));
  return { any: cntAny, unknown: cntUnknown, object: cntObject };
}

/**
 * 递归枚举目录下全部 .ts 文件
 * @param dir - 目录绝对路径
 * @returns 文件绝对路径数组（目录不存在时为空）
 */
export function collectTsFiles(dir: string): string[] {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectTsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * 扫描指定根目录的模糊类型分布
 * @param rootDir - 仓库根绝对路径（结果键为该根的相对 POSIX 路径）
 * @param dirs - 相对根目录的扫描目录，默认 {@link SCAN_DIRS}（app/scripts/tests/hook）
 * @param extraFiles - 相对根目录的额外单文件，默认 {@link SCAN_EXTRA_FILES}（index.ts）
 * @returns 相对路径 → 计数，仅保留计数非零的文件
 */
export function scanTypeDebt(
  rootDir: string,
  dirs: readonly string[] = SCAN_DIRS,
  extraFiles: readonly string[] = SCAN_EXTRA_FILES,
): Record<string, TypeDebtCounts> {
  return scanTypeMetrics(rootDir, dirs, extraFiles).counts;
}

/** `as unknown as` 逃逸断言模式（先抹掉类型再断言，绕过一切类型检查） */
const ESCAPE_CAST_RE = /\bas\s+unknown\s+as\b/g;

/**
 * 统计一段源码里的 `as unknown as` 逃逸点
 *
 * 与 `unknown` 关键字口径互补：后者同时覆盖「边界上的正确 `unknown`」（`catch`、未校验
 * 外部 JSON），无法区分健康用法与「先抹类型再断言」的逃生口。本函数只数后者。注释、
 * 字符串与正则中的同名字样按 {@link stripCommentsAndStrings} 剥离，不计入。
 * @param src - 源码全文（未经剥离）
 * @returns `as unknown as` 出现次数
 */
export function countEscapeCasts(src: string): number {
  return (stripCommentsAndStrings(src).match(ESCAPE_CAST_RE) || []).length;
}

/**
 * TS suppression 指令模式：**注释行开头**的 `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck`
 *
 * 只认 `//` 行注释开头的指令——JSDoc/块注释里的「提及」（如 `* 实现体一次 @ts-expect-error`）
 * 与字符串里的同名字样不计入，避免把文档说明当成 suppression。
 */
const TS_SUPPRESSION_RE = /^[ \t]*\/\/[ \t]*@ts-(expect-error|ignore|nocheck)\b/gm;

/**
 * 统计一段源码里的 TS suppression 指令数
 *
 * 这是与 `any`/`as unknown as` 并列的第三条逃生通道：`@ts-expect-error` 让错误「合法化」，
 * 且**完全不进任何现有指标**（关键字扫描看不到它）。有的确属必要的硬边界
 * （Emittery 复杂泛型、含私有字段的类替身），但必须有棘轮，否则新增无人发现。
 * @param src - 源码全文（未经剥离）
 * @returns suppression 指令行数
 */
export function countTsSuppressions(src: string): number {
  return (src.match(TS_SUPPRESSION_RE) || []).length;
}

/**
 * 一次遍历同时得到「模糊类型计数」「逃逸点计数」与「suppression 计数」
 *
 * 本仓在 WSL 的 9p/drvfs（`/mnt/d`）上单次 `fs.readFileSync` 约 36ms/文件，
 * 全仓扫描的耗时由读盘次数决定——所有指标必须在同一次读盘内算完，
 * 否则守卫每多一个指标就多一次全仓扫描（实测每遍 15~20s）。
 * @param rootDir - 仓库根绝对路径（结果键为该根的相对 POSIX 路径）
 * @param dirs - 相对根目录的扫描目录，默认 {@link SCAN_DIRS}
 * @param extraFiles - 相对根目录的额外单文件，默认 {@link SCAN_EXTRA_FILES}
 * @returns `counts`（模糊类型，仅非零文件）、`escapes`（`as unknown as`，仅非零文件）、
 *   `suppressions`（`@ts-*` 指令，仅非零文件）
 */
export function scanTypeMetrics(
  rootDir: string,
  dirs: readonly string[] = SCAN_DIRS,
  extraFiles: readonly string[] = SCAN_EXTRA_FILES,
): {
  counts: Record<string, TypeDebtCounts>;
  escapes: Record<string, number>;
  suppressions: Record<string, number>;
} {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const counts: Record<string, TypeDebtCounts> = {};
  const escapes: Record<string, number> = {};
  const suppressions: Record<string, number> = {};
  const files = [
    ...dirs.flatMap((d) => collectTsFiles(path.join(rootDir, d))),
    ...extraFiles.map((f) => path.join(rootDir, f)).filter((f) => fs.existsSync(f)),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf-8");
    const rel = path.relative(rootDir, file).split(path.sep).join("/");
    const c = countVagueTypes(src);
    if (c.any + c.unknown + c.object > 0) counts[rel] = c;
    const n = countEscapeCasts(src);
    if (n > 0) escapes[rel] = n;
    const s = countTsSuppressions(src);
    if (s > 0) suppressions[rel] = s;
  }
  return { counts, escapes, suppressions };
}

/** 逃逸点基线文档 */
export interface EscapeBaseline {
  /** 全仓合计 */
  total: number;
  /** 相对路径 → `as unknown as` 计数（按路径排序） */
  counts: Record<string, number>;
}

/**
 * 构造逃逸点基线（键按路径排序，保证可复现的 diff）
 * @param escapes - 逐文件逃逸点计数
 * @returns 基线文档
 */
export function buildEscapeBaseline(escapes: Record<string, number>): EscapeBaseline {
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(escapes).sort()) sorted[k] = escapes[k];
  return {
    total: Object.values(escapes).reduce((a, b) => a + b, 0),
    counts: sorted,
  };
}

/** suppression 指令基线文档（结构同 {@link EscapeBaseline}） */
export type SuppressionBaseline = EscapeBaseline;

/**
 * 构造 suppression 基线（键按路径排序，保证可复现的 diff）
 * @param suppressions - 逐文件 `@ts-*` 指令计数
 * @returns 基线文档
 */
export function buildSuppressionBaseline(
  suppressions: Record<string, number>,
): SuppressionBaseline {
  return buildEscapeBaseline(suppressions);
}

/**
 * 汇总逐文件计数
 * @param counts - 逐文件明细
 * @returns 三项合计
 */
export function totalOf(counts: Record<string, TypeDebtCounts>): TypeDebtCounts {
  const total: TypeDebtCounts = { any: 0, unknown: 0, object: 0 };
  for (const c of Object.values(counts)) {
    total.any += c.any;
    total.unknown += c.unknown;
    total.object += c.object;
  }
  return total;
}

/**
 * 比较两个计数，返回上升的字段说明
 * @param before - 基线计数
 * @param after - 当前计数
 * @returns 上升字段的 `key: before → after` 描述（无上升则空数组）
 */
export function grownFields(before: TypeDebtCounts, after: TypeDebtCounts): string[] {
  const out: string[] = [];
  for (const key of DEBT_KEYS) {
    if (after[key] > before[key]) out.push(`${key}: ${before[key]} → ${after[key]}`);
  }
  return out;
}

/** 基线文件结构 */
export interface TypeDebtBaseline {
  /** 全部文件合计 */
  totals: TypeDebtCounts;
  /** 相对路径 → 计数（按路径排序） */
  counts: Record<string, TypeDebtCounts>;
}

/**
 * 构造基线文档（键按路径排序，保证可复现的 diff）
 * @param counts - 逐文件明细
 * @returns 基线文档
 */
export function buildBaseline(counts: Record<string, TypeDebtCounts>): TypeDebtBaseline {
  const sorted: Record<string, TypeDebtCounts> = {};
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k];
  return { totals: totalOf(counts), counts: sorted };
}
