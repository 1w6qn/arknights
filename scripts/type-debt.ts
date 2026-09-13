/**
 * 类型债 CLI
 *
 * 用法：
 *   pnpm run type:debt                        报告总量 + Top 违规文件
 *   pnpm run type:debt -- --write             刷新 type-debt-baseline.json（棘轮只紧不松）
 *   pnpm run type:debt -- --write --expand-scope  扫描范围扩容时刷新基线（见下）
 *   pnpm run type:debt -- --write-escapes     刷新 type-escape-baseline.json（as unknown as 棘轮）
 *   pnpm run type:debt -- --write-suppressions 刷新 type-suppression-baseline.json（@ts-* 指令棘轮）
 *   pnpm run type:debt -- --top 50            自定义报告条数
 *
 * `--write` 默认拒绝让任一文件计数或总量上升，必须先真正修掉类型债；
 * 确需例外时用 `--force`（会在输出中显式警告，便于评审发现）。
 *
 * `--write-escapes` 与 `--write-suppressions` 是**独立的**两条逃生通道棘轮：
 *  - `as unknown as`：先抹类型再断言，绕开一切检查（模糊类型计数无法把它与边界上的
 *    正确 `unknown` 区分，口径见 {@link countEscapeCasts}）；
 *  - `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck`：把错误「合法化」，**完全不进任何
 *    关键字指标**（口径见 {@link countTsSuppressions}）。
 *
 * `--expand-scope` 是**范围扩容专用**通道：当 {@link SCAN_DIRS} 新增扫描目录
 * （如把 tests / scripts 纳入口径）时，新增文件与总量必然上升，普通 `--write`
 * 会拒绝。该开关只放行「基线中不存在的新文件」带来的上升，**既有文件计数上升
 * 依旧拒绝**——棘轮对已纳入范围的文件始终只紧不松。
 *
 * 扫描口径与 tests/unit/architecture/type-debt-ratchet.test.ts 完全一致
 * （共用 scripts/lib/type-debt-scan.ts）。
 */
import * as fs from "fs";
import * as path from "path";
import {
  buildBaseline,
  buildEscapeBaseline,
  buildSuppressionBaseline,
  scanTypeMetrics,
  totalOf,
  type EscapeBaseline,
  type SuppressionBaseline,
  type TypeDebtBaseline,
  type TypeDebtCounts,
} from "./lib/type-debt-scan";

const REPO_ROOT = path.resolve(__dirname, "..");
const BASELINE_FILE = path.join(
  REPO_ROOT,
  "tests/unit/architecture/type-debt-baseline.json",
);
/** 逃逸点（`as unknown as`）基线 */
const ESCAPE_BASELINE_FILE = path.join(
  REPO_ROOT,
  "tests/unit/architecture/type-escape-baseline.json",
);
/** suppression 指令（`@ts-*`）基线 */
const SUPPRESSION_BASELINE_FILE = path.join(
  REPO_ROOT,
  "tests/unit/architecture/type-suppression-baseline.json",
);
const args = process.argv.slice(2);
const topIndex = args.indexOf("--top");
const TOP_N = topIndex >= 0 ? Number(args[topIndex + 1]) || 25 : 25;

/**
 * 读取既有基线（不存在则返回 null）
 * @returns 基线文档或 null
 */
function readBaseline(): TypeDebtBaseline | null {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")) as TypeDebtBaseline;
}

/** 格式化计数为紧凑字符串 */
function fmt(c: TypeDebtCounts): string {
  return `any=${c.any} unknown=${c.unknown} object=${c.object}`;
}

/**
 * 计算违规项：新增文件与计数上升的文件
 * @param baseline - 基线
 * @param current - 当前扫描
 * @returns 新增文件列表与上升描述列表
 */
function violations(
  baseline: TypeDebtBaseline,
  current: Record<string, TypeDebtCounts>,
): { added: string[]; grown: string[] } {
  const added = Object.keys(current).filter((f) => !(f in baseline.counts));
  const grown: string[] = [];
  for (const [file, counts] of Object.entries(current)) {
    const base = baseline.counts[file];
    if (!base) continue;
    for (const key of ["any", "unknown", "object"] as const) {
      if (counts[key] > base[key]) grown.push(`${file}: ${key} ${base[key]} → ${counts[key]}`);
    }
  }
  return { added: added.sort(), grown: grown.sort() };
}

/** 打印报告 */
function report(): void {
  const { counts: current, escapes, suppressions } = scanTypeMetrics(REPO_ROOT);
  const totals = totalOf(current);
  const baseline = readBaseline();

  console.log(`扫描文件数（含模糊类型）: ${Object.keys(current).length}`);
  console.log(`合计: ${fmt(totals)}`);
  const escapeBaseline = readEscapeBaseline();
  const escapeTotal = Object.values(escapes).reduce((a, b) => a + b, 0);
  console.log(
    `逃逸点（as unknown as）: ${escapeTotal}` +
      (escapeBaseline ? `  基线: ${escapeBaseline.total}` : `  （无基线，--write-escapes 建立）`),
  );
  const suppressionBaseline = readSuppressionBaseline();
  const suppressionTotal = Object.values(suppressions).reduce((a, b) => a + b, 0);
  console.log(
    `suppression（@ts-*）: ${suppressionTotal}` +
      (suppressionBaseline
        ? `  基线: ${suppressionBaseline.total}`
        : `  （无基线，--write-suppressions 建立）`),
  );
  if (baseline) {
    const before = baseline.totals;
    console.log(
      `基线: ${fmt(before)}   delta: any ${totals.any - before.any}, unknown ${
        totals.unknown - before.unknown
      }, object ${totals.object - before.object}`,
    );
    const { added, grown } = violations(baseline, current);
    if (added.length) console.log(`\n新增违规文件 (${added.length}):\n  ${added.join("\n  ")}`);
    if (grown.length) console.log(`\n计数上升 (${grown.length}):\n  ${grown.join("\n  ")}`);
    const cleared = Object.keys(baseline.counts)
      .filter((f) => !(f in current))
      .sort();
    if (cleared.length)
      console.log(`\n已清零（应从基线移除）(${cleared.length}):\n  ${cleared.join("\n  ")}`);
  }

  const worst = Object.entries(current)
    .map(([file, c]) => ({ file, c, score: c.any * 3 + c.unknown + c.object * 2 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);
  console.log(`\nTop ${worst.length} 违规文件（权重 any×3 / unknown×1 / object×2）:`);
  for (const w of worst) console.log(`  ${String(w.score).padStart(4)}  ${w.file}  (${fmt(w.c)})`);
}

/** 刷新基线（棘轮只紧不松；`--expand-scope` 放行范围扩容） */
function write(): void {
  const current = scanTypeMetrics(REPO_ROOT).counts;
  const baseline = readBaseline();
  const force = args.includes("--force");
  const expandScope = args.includes("--expand-scope");
  if (baseline && !force) {
    const { added, grown } = violations(baseline, current);
    const totals = totalOf(current);
    const totalGrown =
      totals.any > baseline.totals.any ||
      totals.unknown > baseline.totals.unknown ||
      totals.object > baseline.totals.object;
    // --expand-scope 只放行「新文件 + 总量上升」，既有文件上升仍拒绝
    const blocked = expandScope
      ? grown.length > 0
      : added.length > 0 || grown.length > 0 || totalGrown;
    if (blocked) {
      console.error(
        expandScope
          ? "拒绝写入：--expand-scope 仅放行新增文件，既有文件计数不得上升。"
          : "拒绝写入：棘轮只允许收紧，检测到类型债上升。",
      );
      if (added.length) console.error(`  新增文件:\n    ${added.join("\n    ")}`);
      if (grown.length) console.error(`  计数上升:\n    ${grown.join("\n    ")}`);
      if (totalGrown && !expandScope)
        console.error(`  总量上升: ${fmt(baseline.totals)} → ${fmt(totals)}`);
      process.exit(1);
    }
    if (expandScope) {
      console.log(
        `ℹ️  --expand-scope：扫描范围扩容，纳入新增文件 ${added.length} 个；` +
          `总量 ${fmt(baseline.totals)} → ${fmt(totals)}（既有文件均未上升）`,
      );
    }
  } else if (baseline && force) {
    console.warn("⚠️  --force：允许类型债上升写入基线，请在评审中说明原因。");
  }
  const doc = buildBaseline(current);
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  console.log(`已写入 ${path.relative(REPO_ROOT, BASELINE_FILE)}：${fmt(doc.totals)}`);
}

/**
 * 读取既有逃逸点基线（不存在则返回 null）
 * @returns 逃逸点基线文档或 null
 */
function readEscapeBaseline(): EscapeBaseline | null {
  if (!fs.existsSync(ESCAPE_BASELINE_FILE)) return null;
  return JSON.parse(fs.readFileSync(ESCAPE_BASELINE_FILE, "utf-8")) as EscapeBaseline;
}

/**
 * 计算逃逸点违规项：新增文件与计数上升的文件
 * @param baseline - 逃逸点基线
 * @param current - 当前逐文件 `as unknown as` 计数
 * @returns 新增文件列表与上升描述列表
 */
function escapeViolations(
  baseline: EscapeBaseline,
  current: Record<string, number>,
): { added: string[]; grown: string[] } {
  const added = Object.keys(current).filter((f) => !(f in baseline.counts));
  const grown: string[] = [];
  for (const [file, n] of Object.entries(current)) {
    const base = baseline.counts[file];
    if (base === undefined) continue;
    if (n > base) grown.push(`${file}: ${base} → ${n}`);
  }
  return { added: added.sort(), grown: grown.sort() };
}

/**
 * 刷新逃逸点基线（棘轮只紧不松）
 *
 * `as unknown as` 是「先抹掉类型再断言」，绕开一切类型检查；模糊类型计数无法把它与
 * 边界上的正确 `unknown` 区分开，故单列一条逐文件棘轮。基准文件：
 * `tests/unit/architecture/type-escape-baseline.json`。
 */
function writeEscapes(): void {
  const { escapes } = scanTypeMetrics(REPO_ROOT);
  const baseline = readEscapeBaseline();
  if (baseline) {
    const { added, grown } = escapeViolations(baseline, escapes);
    const total = Object.values(escapes).reduce((a, b) => a + b, 0);
    if (added.length || grown.length || total > baseline.total) {
      console.error("拒绝写入：逃逸点棘轮只允许收紧（as unknown as 不得新增或上升）。");
      if (added.length) console.error(`  新增文件:\n    ${added.join("\n    ")}`);
      if (grown.length) console.error(`  计数上升:\n    ${grown.join("\n    ")}`);
      if (total > baseline.total) console.error(`  总量上升: ${baseline.total} → ${total}`);
      process.exit(1);
    }
  }
  const doc = buildEscapeBaseline(escapes);
  fs.writeFileSync(ESCAPE_BASELINE_FILE, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  console.log(
    `已写入 ${path.relative(REPO_ROOT, ESCAPE_BASELINE_FILE)}：as unknown as × ${doc.total}`,
  );
}

/**
 * 读取既有 suppression 基线（不存在则返回 null）
 * @returns suppression 基线文档或 null
 */
function readSuppressionBaseline(): SuppressionBaseline | null {
  if (!fs.existsSync(SUPPRESSION_BASELINE_FILE)) return null;
  return JSON.parse(fs.readFileSync(SUPPRESSION_BASELINE_FILE, "utf-8")) as SuppressionBaseline;
}

/**
 * 刷新 suppression 基线（棘轮只紧不松）
 *
 * `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` 把编译错误「合法化」，且**不进任何
 * 关键字指标**（此前完全无守卫）。基准文件：`tests/unit/architecture/type-suppression-baseline.json`。
 * 合法豁免（Emittery 复杂泛型、含私有字段的类替身）保留在基线里，任何新增都红灯。
 */
function writeSuppressions(): void {
  const { suppressions } = scanTypeMetrics(REPO_ROOT);
  const baseline = readSuppressionBaseline();
  if (baseline) {
    const { added, grown } = escapeViolations(baseline, suppressions);
    const total = Object.values(suppressions).reduce((a, b) => a + b, 0);
    if (added.length || grown.length || total > baseline.total) {
      console.error("拒绝写入：suppression 棘轮只允许收紧（@ts-* 指令不得新增或上升）。");
      if (added.length) console.error(`  新增文件:\n    ${added.join("\n    ")}`);
      if (grown.length) console.error(`  计数上升:\n    ${grown.join("\n    ")}`);
      if (total > baseline.total) console.error(`  总量上升: ${baseline.total} → ${total}`);
      process.exit(1);
    }
  }
  const doc = buildSuppressionBaseline(suppressions);
  fs.writeFileSync(SUPPRESSION_BASELINE_FILE, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  console.log(
    `已写入 ${path.relative(REPO_ROOT, SUPPRESSION_BASELINE_FILE)}：@ts-* × ${doc.total}`,
  );
}

if (args.includes("--write")) write();
else if (args.includes("--write-escapes")) writeEscapes();
else if (args.includes("--write-suppressions")) writeSuppressions();
else report();
