/**
 * 物品事件直发守卫（棘轮 / Ratchet）
 *
 * 背景：`AGENTS.md` 约定物品增减统一经 `player.gainItem.setTarget(...).use()/handle()`
 * 管道（`app/game/kernel/inventory-pipeline.ts`），不直发 `items:get`/`items:use` 事件。
 * 管道的价值在于把物品变更收敛到单一出口——未来加审计/限流/日志只需改一处。
 * 此前该约定**无任何守卫**（其余 9 个 architecture 守卫均未覆盖），
 * 实测 84 处直发散布 29 个文件，约定停留在文档里。
 *
 * 本守卫固化迁移成果，防止回潮（三条不变量）：
 *  1. 不允许**新增**直发 `items:*` 的文件；
 *  2. 既有文件的直发次数只允许下降（棘轮），上升即红灯；
 *  3. 已清零的文件必须从基线移除（收紧棘轮），基线不得残留已删除路径。
 *
 * 基线：inventory-pipeline-baseline.json（file → 直发次数）。
 * 迁移一个文件后应运行 `pnpm run items:direct -- --write` 收紧基线，
 * **不得**为了过测而放宽基线。检查器为纯函数（scripts/lib/items-pipeline-scan.ts，
 * 与 CLI 共用同一份判定逻辑），附负样本自证有效性。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  diffBaseline,
  isDirectItemEmit,
  scanDirectItemEmits,
  EXEMPT_FILES,
  type ItemsDirectBaseline,
} from "../../../scripts/lib/items-pipeline-scan";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const BASELINE_FILE = path.join(__dirname, "inventory-pipeline-baseline.json");

/** 读取棘轮基线 */
function readBaseline(): ItemsDirectBaseline {
  return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")) as ItemsDirectBaseline;
}

/**
 * 当前扫描结果（惰性缓存）
 *
 * `scanDirectItemEmits` 会遍历全仓（app/scripts/tests/hook + index.ts，约 785 个文件）逐个读盘，
 * 单次扫描在本机（9p/drvfs）约 10 秒。此前 4 个用例各扫一遍 → 单文件 54 秒，是全套件最慢的一项。
 * 源码在单次测试运行内不会被改写，故一次扫描结果在所有用例间共享（口径不变，只是不重复读盘）。
 */
let cachedScan: Record<string, number> | null = null;

/** 当前扫描结果（首次调用时扫描，后续复用） */
function currentScan(): Record<string, number> {
  return (cachedScan ??= scanDirectItemEmits(REPO_ROOT));
}

describe("物品事件直发守卫（棘轮：只减不增）", () => {
  it("负样本自证：识别真实调用，放行注释与无关代码", () => {
    // 违规样本（无论是否 await、单双引号、this/player/mgr 各种接收者）
    expect(isDirectItemEmit('await player._trigger.emit("items:get", [items]);')).toBe(true);
    expect(isDirectItemEmit(`await mgr._trigger.emit('items:use', [[cost]]);`)).toBe(true);
    expect(isDirectItemEmit('this._trigger.emit("items:get", [items]);')).toBe(true);
    expect(isDirectItemEmit('await this._trigger.emit("items:use", [bundle]);')).toBe(true);
    // 注释行不是调用点（JSDoc 示例 / 行内说明）
    expect(isDirectItemEmit(' * 用法示例：await player._trigger.emit("items:get", [items]);')).toBe(false);
    expect(isDirectItemEmit('// 修复：这里原本直发 _trigger.emit("items:get", [items])')).toBe(false);
    expect(isDirectItemEmit("/* _trigger.emit('items:get') */")).toBe(false);
    // 其他事件与无关代码不受限
    expect(isDirectItemEmit('await this._trigger.emit("char:get", [id]);')).toBe(false);
    expect(isDirectItemEmit('await this._trigger.emit("save", []);')).toBe(false);
    expect(isDirectItemEmit("const pipe = player.gainItem.add(item).handle();")).toBe(false);
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

  it("豁免文件必须存在且仅限管道本体与下游订阅者", () => {
    expect(EXEMPT_FILES).toEqual([
      "app/game/kernel/inventory-pipeline.ts", // 管道本体
      "app/game/kernel/inventory.ts", // items:get/use 的订阅者实现
    ]);
    for (const rel of EXEMPT_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `豁免文件不存在: ${rel}`).toBe(true);
    }
  });

  it("扫描器不得把豁免文件计入结果", () => {
    const current = currentScan();
    for (const rel of EXEMPT_FILES) {
      expect(current[rel], `豁免文件被计入扫描结果: ${rel}`).toBeUndefined();
    }
  });

  it("不得新增直发 items:get/use 的文件（棘轮：只减不增）", () => {
    const { added } = diffBaseline(readBaseline().counts, currentScan());
    expect(
      added,
      `新增物品事件直发（应改经 player.gainItem 管道）：\n  ${added.join("\n  ")}`,
    ).toEqual([]);
  });

  it("既有文件的直发次数不得上升", () => {
    const { grown } = diffBaseline(readBaseline().counts, currentScan());
    expect(grown, `物品事件直发次数上升：\n  ${grown.join("\n  ")}`).toEqual([]);
  });

  it("基线只记录真实存在的直发文件（基线自身不失真）", () => {
    const baseline = readBaseline();
    const current = currentScan();
    // 基线条目必须仍存在于仓库（防止基线留着已删除路径而失去约束力）
    const ghosts = Object.keys(baseline.counts).filter(
      (f) => !fs.existsSync(path.join(REPO_ROOT, f)),
    );
    expect(ghosts, `基线含已不存在的文件：\n  ${ghosts.join("\n  ")}`).toEqual([]);
    // 已完全迁移的文件应从基线移除（收紧棘轮，随迁移提交一并更新）
    const { migrated } = diffBaseline(baseline.counts, current);
    expect(
      migrated,
      `以下文件已无物品直发，请运行 pnpm run items:direct -- --write 收紧基线：\n  ${migrated.join("\n  ")}`,
    ).toEqual([]);
    // total 必须与逐项明细自洽（防手写基线失真）
    const sum = Object.values(baseline.counts).reduce((a, b) => a + b, 0);
    expect(baseline.total, `基线 total=${baseline.total} 与逐项和=${sum} 不自洽`).toBe(sum);
  });
});
