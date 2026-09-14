/**
 * excel 数据端口守卫（棘轮 / Ratchet）
 *
 * 背景：模块层直连 `import excel from "@excel/excel"` 单例使游戏配置表不可注入——
 * 测试只能 vi.mock 模块（2026-09 实测 122 个测试文件打桩 @excel/excel），多数据目录
 * （分服）与热重载也无法替换数据源。解耦方向与端口契约见 app/game/kernel/excel-port.ts。
 *
 * 本守卫固化迁移成果，防止回潮（三条不变量）：
 *  1. `app/game` 下除 excel 数据层自身与组合根之外，不允许**新增**直连单例的文件；
 *  2. 既有文件的直连次数只允许下降（棘轮），上升即红灯；
 *  3. 端口与注入点必须存在（excel-port.ts / PlayerDataManager.excel），且端口先于组合子模块就位。
 *
 * 基线：excel-singleton-baseline.json（file → 默认导入次数）。迁移一个文件后应从基线移除该条目
 * （棘轮收紧），**不得**为了过测而放宽基线。检查器为纯函数，附负样本自证有效性。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP_ROOT = path.resolve(__dirname, "../../../app");
const GAME_ROOT = path.join(APP_ROOT, "game");
const BASELINE_FILE = path.join(__dirname, "excel-singleton-baseline.json");

/** 组合根：端口默认值绑定点，允许直连单例（唯一豁免） */
export const COMPOSITION_ROOT = "app/game/kernel/player-data-manager.ts";

/** excel 数据层自身：读写盘实现，豁免 */
export const EXCEL_LAYER_PREFIX = "app/game/excel/";

/**
 * 单例「默认导入」识别
 *
 * 只匹配带默认绑定的 import（`import excel from "@excel/excel"` / `import excel, { X } from ...`）；
 * `import type { ItemBundle } from "@excel/excel"` 与具名导入 `import { ItemBundle } from ...`
 * 属类型/符号依赖，不在守卫范围（数据表访问才是问题）。
 * @param line - 源码单行
 * @returns 是否为 excel 单例默认导入
 */
export function isSingletonDefaultImport(line: string): boolean {
  return /^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["'](?:@excel\/excel|(?:\.\.\/)+excel\/excel)["']/.test(
    line,
  );
}

/**
 * 棘轮比较：当前扫描结果 vs 基线
 * @param baseline - 基线（file → 次数）
 * @param current - 当前（file → 次数）
 * @returns 新增直连的文件、次数上升的文件、已迁移完成（应收紧基线）的文件
 */
export function diffBaseline(
  baseline: Record<string, number>,
  current: Record<string, number>,
): { added: string[]; grown: string[]; migrated: string[] } {
  const added = Object.keys(current).filter((f) => !(f in baseline)).sort();
  const grown = Object.keys(current)
    .filter((f) => f in baseline && current[f] > baseline[f])
    .map((f) => `${f}: ${baseline[f]} → ${current[f]}`)
    .sort();
  const migrated = Object.keys(baseline).filter((f) => !(f in current)).sort();
  return { added, grown, migrated };
}

/**
 * 递归枚举目录下全部 .ts 文件
 * @param dir - 目录绝对路径
 * @returns 文件绝对路径数组
 */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * 扫描 app/game 下的单例直连情况（惰性缓存）
 *
 * 全树约 365 个文件，单次扫描在本机（9p/drvfs）约 9 秒；此前 4 个用例各扫一遍 →
 * 单文件 37 秒。源码在单次测试运行内不会被改写，故一次结果在所有用例间共享。
 * @returns 仓库相对路径 → 默认导入次数
 */
let cachedScan: Record<string, number> | null = null;

export function scanSingletonImports(): Record<string, number> {
  if (cachedScan) return cachedScan;
  const counts: Record<string, number> = {};
  for (const file of collectTs(GAME_ROOT)) {
    const rel = path.relative(path.resolve(APP_ROOT, ".."), file).split(path.sep).join("/");
    if (rel.startsWith(EXCEL_LAYER_PREFIX)) continue;
    if (rel === COMPOSITION_ROOT) continue;
    const n = fs
      .readFileSync(file, "utf-8")
      .split(/\r?\n/)
      .filter((l) => isSingletonDefaultImport(l)).length;
    if (n > 0) counts[rel] = n;
  }
  cachedScan = counts;
  return counts;
}

/** 读取棘轮基线 */
function readBaseline(): Record<string, number> {
  const doc = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")) as {
    counts: Record<string, number>;
  };
  return doc.counts;
}

describe("excel 数据端口守卫（单例直连棘轮）", () => {
  it("负样本自证：识别默认导入，放行类型/具名导入", () => {
    // 违规样本
    expect(isSingletonDefaultImport('import excel from "@excel/excel";')).toBe(true);
    expect(isSingletonDefaultImport('import excel, { ItemBundle } from "@excel/excel";')).toBe(true);
    expect(isSingletonDefaultImport('import excel from "../../excel/excel";')).toBe(true);
    // 合法样本（类型依赖与具名符号不受限）
    expect(isSingletonDefaultImport('import type { ItemBundle } from "@excel/excel";')).toBe(false);
    expect(isSingletonDefaultImport('import { ItemBundle } from "@excel/excel";')).toBe(false);
    expect(isSingletonDefaultImport('import type { ExcelData } from "./excel-port";')).toBe(false);
    expect(isSingletonDefaultImport('import excelData from "@excel/other";')).toBe(false);
  });

  it("负样本自证：棘轮能识别新增、上升与已迁移", () => {
    const baseline = { "a.ts": 1, "b.ts": 2 };
    const d = diffBaseline(baseline, { "b.ts": 3, "c.ts": 1 });
    expect(d.added).toEqual(["c.ts"]);
    expect(d.grown).toEqual(["b.ts: 2 → 3"]);
    expect(d.migrated).toEqual(["a.ts"]);
    // 无变化时不产生任何差异
    expect(diffBaseline(baseline, baseline)).toEqual({ added: [], grown: [], migrated: [] });
  });

  it("端口与注入点存在：kernel/excel-port.ts + PlayerDataManager.excel", () => {
    const portFile = path.join(APP_ROOT, "game", "kernel", "excel-port.ts");
    expect(fs.existsSync(portFile)).toBe(true);
    const portSrc = fs.readFileSync(portFile, "utf-8");
    // 端口必须导出 ExcelData，且刻意不含生命周期方法（init/resetLazyTables 属组合根职责）
    expect(portSrc).toMatch(/export type ExcelData = Pick<Excel,/);

    const pdmSrc = fs.readFileSync(
      path.join(APP_ROOT, "game", "kernel", "player-data-manager.ts"),
      "utf-8",
    );
    expect(pdmSrc).toMatch(/get excel\(\): ExcelData/);
    expect(pdmSrc).toMatch(/this\._excel = deps\?\.excel \?\? excel;/);
    // 端口须在组合子模块之前就位（子模块构造期即可经 player.excel 取表）
    const lines = pdmSrc.split(/\r?\n/);
    const excelLine = lines.findIndex((l) => l.includes("this._excel = deps?.excel ?? excel;"));
    const composeLine = lines.findIndex((l) => l.includes("composePlayerChildModules(this, this._trigger)"));
    expect(excelLine).toBeGreaterThan(-1);
    expect(composeLine).toBeGreaterThan(excelLine);
  });

  it("不得新增直连 @excel/excel 单例的文件（棘轮：只减不增）", () => {
    const { added } = diffBaseline(readBaseline(), scanSingletonImports());
    expect(added, `新增单例直连（应改经 player.excel 端口）：\n  ${added.join("\n  ")}`).toEqual([]);
  });

  it("既有文件的直连次数不得上升", () => {
    const { grown } = diffBaseline(readBaseline(), scanSingletonImports());
    expect(grown, `单例直连次数上升：\n  ${grown.join("\n  ")}`).toEqual([]);
  });

  it("基线只记录真实存在的直连文件（基线自身不失真）", () => {
    const baseline = readBaseline();
    const current = scanSingletonImports();
    // 基线条目必须仍存在于仓库（防止基线留着已删除路径而失去约束力）
    const ghosts = Object.keys(baseline).filter(
      (f) => !fs.existsSync(path.resolve(APP_ROOT, "..", f)),
    );
    expect(ghosts, `基线含已不存在的文件：\n  ${ghosts.join("\n  ")}`).toEqual([]);
    // 已完全迁移的文件应从基线移除（收紧棘轮，随迁移提交一并更新）
    const { migrated } = diffBaseline(baseline, current);
    expect(
      migrated,
      `以下文件已无单例直连，请从 excel-singleton-baseline.json 移除：\n  ${migrated.join("\n  ")}`,
    ).toEqual([]);
  });
});
