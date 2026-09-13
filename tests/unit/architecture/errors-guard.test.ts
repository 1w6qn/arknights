/**
 * 统一业务异常守卫（建议 13）
 *
 * domain 层业务校验失败必须抛 GameError 子类（BadRequestError 等，携带业务文案与
 * 状态码），由 gameErrorHandler 统一映射 JSON 响应；禁止裸 throw new Error
 * （语义未知 → 一律 500 INTERNAL_ERROR，客户端无法区分可修正的错误）。
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { collectFiles, readLines, readSource } from "../../helpers/fs-scan";

const APP_ROOT = path.resolve(__dirname, "../../..");
const MODULES_DIR = path.join(APP_ROOT, "app", "game", "modules");
const KERNEL_DIR = path.join(APP_ROOT, "app", "game", "kernel");

describe("统一业务异常体系（errors-guard）", () => {
  it("业务模块内禁止裸 throw new Error（应抛 GameError 子类）", () => {
    const offenders: string[] = [];
    for (const file of [...collectFiles(MODULES_DIR, ".ts"), ...collectFiles(KERNEL_DIR, ".ts")]) {
      const lines = readLines(file);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (l.startsWith("//") || l.startsWith("*")) continue;
        if (/throw new Error\b/.test(l)) {
          offenders.push(`${path.relative(APP_ROOT, file)}:${i + 1} 裸 throw new Error（应抛 BadRequestError/InternalError 等 GameError 子类）`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("GameError 子类语义正确（状态码/错误码/文案）", () => {
    // 类型层面保证：业务层引用的错误类从 @core/http/errors 导出
    // （2026-09-13 由 app/game/kernel/http/errors.ts 下沉 app/core/http/errors.ts）
    const errorsFile = readSource(path.join(APP_ROOT, "app", "core", "http", "errors.ts"));
    for (const cls of ["GameError", "BadRequestError", "ForbiddenError", "NotFoundError", "InternalError", "isGameError"]) {
      expect(errorsFile).toContain(`export class ${cls}`.replace("export class isGameError", "export function isGameError"));
    }
  });
});
