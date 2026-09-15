/**
 * 签名产物挑选守卫（`scripts/apk-sign.ts#findSignedArtifact`）
 *
 * 复现并固化 2026-09-14 实测到的坑：uber-apk-signer 会**去掉输入名末尾的 `-unsigned`**
 * （`X-unsigned.apk` → `X-debugSigned.apk`），中间还会落一个 `X-aligned.apk`（只对齐、未签名）。
 * 旧实现按「输入名去 .apk」做前缀匹配，匹配不到真产物，反而把输入自身/对齐中间产物改名成交付物
 * （`pnpm run apk:dex-mtp -- --sign` 出过 `*-signed.apk` 实为未签名包）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findSignedArtifact } from "../../../scripts/apk-sign";

/** 测试用临时目录 */
let dir = "";

/** 造一个占位 APK 文件并设定 mtime */
function touch(name: string, mtimeMs: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "placeholder");
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

describe("findSignedArtifact：只认签名产物", () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "apk-sign-pick-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("输入 -unsigned.apk 时，跳过对齐中间产物与输入自身，挑出 -debugSigned.apk", () => {
    const startedAt = 1_000_000;
    const input = touch("x-unsigned.apk", startedAt - 5_000);
    touch("x-aligned.apk", startedAt + 9_000); // 未签名中间产物，且时间更新
    const signed = touch("x-debugSigned.apk", startedAt + 10_000);
    expect(findSignedArtifact(dir, input, startedAt)).toBe(signed);
  });

  it("自定义 keystore 的 -signed.apk 命名同样命中", () => {
    const startedAt = 2_000_000;
    const input = touch("y.apk", startedAt);
    const signed = touch("y-signed.apk", startedAt + 1);
    expect(findSignedArtifact(dir, input, startedAt)).toBe(signed);
  });

  it("忽略本次开始之前的历史签名产物；没有本次产物则抛错", () => {
    const startedAt = 3_000_000;
    const input = touch("z-unsigned.apk", startedAt);
    touch("z-debugSigned.apk", startedAt - 60_000); // 上一轮的产物
    expect(() => findSignedArtifact(dir, input, startedAt)).toThrow(/签名产物/);
    const fresh = touch("z-debugSigned.apk", startedAt + 2); // 本轮产物（mtime 刷新）
    expect(findSignedArtifact(dir, input, startedAt)).toBe(fresh);
  });

  it("多个候选取最新", () => {
    const startedAt = 4_000_000;
    const input = touch("w-unsigned.apk", startedAt);
    touch("w-debugSigned.apk", startedAt + 1_000);
    const newest = touch("w-aligned-debugSigned.apk", startedAt + 2_000);
    expect(findSignedArtifact(dir, input, startedAt)).toBe(newest);
  });
});
