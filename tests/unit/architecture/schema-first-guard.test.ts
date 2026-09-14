/**
 * 契约先行守卫（schema-first）
 *
 * 强制「新路由先落 contract」：modules 各模块与 activities 各族的路由文件下所有 POST 路由
 * 必须经 validateBody 校验（契约层 modules/<模块>/*.schema.ts 定义请求形状）。
 * GET 路由（无 body）豁免；multipart 上传端点（无 JSON body）豁免。
 *
 * 2026-09-14 命名统一：路由载体只剩 `routes.ts` / `*.routes.ts`（原 `handler.ts`
 * 与 `router.ts` 已改名），因此 building/gacha 等文件**自动进入扫描面**——它们此前
 * 因命名不在册而长期逃过校验，本次一并补齐 validateBody。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { collectFiles, readLines } from "../../helpers/fs-scan";

const APP_ROOT = path.join(__dirname, "../../../app");

describe("契约先行守卫", () => {
  it("router 层 POST 路由必须经 validateBody 校验（契约先行）", () => {
    const offenders: string[] = [];
    // 路由面 = 各模块 `routes.ts` / 次路由 `<域>.routes.ts` / activities 族（整目录）。
    const ROUTER_FACE = /(?:^|[\\/])routes\.ts$|(?:^|[\\/])[\w-]+\.routes\.ts$/;
    const MODULES_DIR = path.join(APP_ROOT, "game/modules");
    const ACTIVITIES_DIR = path.join(MODULES_DIR, "activities");
    // 原实现先扫一遍 modules 取 routes 面、再整扫一遍 activities（activities 是 modules 的子目录，
    // 等于把活动族文件读两遍）。这里单次遍历取两者并集，读盘走 fs-scan 缓存，判定范围不变。
    const files = collectFiles(MODULES_DIR, ".ts").filter(
      (f) => ROUTER_FACE.test(f) || f.startsWith(ACTIVITIES_DIR + path.sep),
    );
    for (const file of files) {
      const lines = readLines(file);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/\.(post|put|patch)\(/);
        if (!m) continue;
        // 路由注册行须在同一行或后续 6 行内出现 validateBody（多行签名/中间件场景）
        const window = lines.slice(i, i + 6).join(" ");
        // multipart 上传端点（像素画/杂志编队）无 JSON body，豁免
        if (/parseMultipartForm|multipart\/form-data|pixelData|saveDiyMagazine/.test(window)) continue;
        if (!/validateBody/.test(window)) {
          offenders.push(`${path.relative(APP_ROOT, file)}:${i + 1} 缺少 validateBody`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
