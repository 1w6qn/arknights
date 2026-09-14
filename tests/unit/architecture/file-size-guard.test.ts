/**
 * 文件规模守卫
 *
 * 防巨型文件回潮：modules 层 logic 文件与路由载体文件（`routes.ts` / `*.routes.ts`）单文件不超过 1500 行。
 * 拆分基准（2026-08-26）：mission 983 / building 900 / rlv2 1231 行。
 * 2026-09-14：命名统一后路由载体只剩 `routes.ts` 与 `*.routes.ts`（原 router.ts/handler.ts 已改名），
 * 守卫随之收敛——此前 `routes.ts` 不在命名面内，crisis/user/sandbox 等路由文件是盲区。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { collectFiles, readLines } from "../../helpers/fs-scan";

const APP_ROOT = path.join(__dirname, "../../../app");
const MAX_LINES = 1500;

describe("文件规模守卫", () => {
  it("modules 层 logic.ts 单文件不超过 1500 行", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(path.join(APP_ROOT, "game/modules"), ".ts")) {
      if (!file.endsWith("logic.ts")) continue;
      const count = readLines(file).length;
      if (count > MAX_LINES) {
        offenders.push(`${path.relative(APP_ROOT, file)}: ${count} 行（> ${MAX_LINES}）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("路由载体单文件不超过 1500 行（活动已按族拆分）", () => {
    const offenders: string[] = [];
    // `game/modules` 递归已覆盖 `game/modules/activities`，无需二次扫描（原实现扫两遍，
    // activities 下的文件被重复读盘；行数口径不变）。
    for (const file of collectFiles(path.join(APP_ROOT, "game/modules"), ".ts")) {
      if (!/(^|\/)routes\.ts$/.test(file) && !/\.routes\.ts$/.test(file)) continue;
      const count = readLines(file).length;
      if (count > MAX_LINES) {
        offenders.push(`${path.relative(APP_ROOT, file)}: ${count} 行（> ${MAX_LINES}）`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
