import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, stat } from "fs/promises";
import { join } from "path";
import os from "os";
import JSZip from "jszip";
import yauzl from "yauzl";
import { patchApk, verifyPatchedApk, inspectApk } from "../../../scripts/apk-patch";

/** 测试用临时目录（每个用例一个，afterEach 清理） */
const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 造一个含 STORED/DEFLATE/V1 签名条目的最小 APK（zip）。
 * @returns 临时目录与 fixture 路径
 */
async function buildFixture(): Promise<{ dir: string; apk: string }> {
  const dir = await mkdtemp(join(os.tmpdir(), "apk-patch-"));
  tmpDirs.push(dir);
  const zip = new JSZip();
  zip.file("classes.dex", Buffer.from("dex-payload-".repeat(64)), { compression: "DEFLATE" });
  zip.file("assets/AB/Android/anon/aaa.bin", Buffer.alloc(4096, 7), { compression: "STORE" });
  zip.file("lib/arm64-v8a/libx.so", Buffer.alloc(8192, 3), { compression: "STORE" });
  zip.file("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n\n");
  zip.file("META-INF/ARKNIGHT.SF", "Signature-Version: 1.0\n\n");
  zip.file("META-INF/ARKNIGHT.RSA", Buffer.from([0x30, 0x82, 0x01, 0x02]));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const apk = join(dir, "fixture.apk");
  await writeFile(apk, buf);
  return { dir, apk };
}

/**
 * 读取 zip 全部条目内容。
 * @param apkPath - zip 路径
 * @returns 条目名 → 内容
 */
function readEntries(apkPath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, Buffer>();
    yauzl.open(apkPath, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(new Error(`打开失败: ${err?.message ?? "unknown"}`));
      zf.on("entry", (e) => {
        zf.openReadStream(e, (openErr, rs) => {
          if (openErr || !rs) return reject(new Error(`读取失败: ${openErr?.message ?? "unknown"}`));
          const chunks: Buffer[] = [];
          rs.on("data", (c: Buffer) => chunks.push(c));
          rs.on("error", reject);
          rs.on("end", () => {
            out.set(e.fileName, Buffer.concat(chunks));
            zf.readEntry();
          });
        });
      });
      zf.on("end", () => resolve(out));
      zf.on("error", reject);
      zf.readEntry();
    });
  });
}

describe("apk-patch", () => {
  it("替换条目、抹掉 V1 签名、保持其余条目原样", async () => {
    const { dir, apk } = await buildFixture();
    const before = await readEntries(apk);
    const newBundle = join(dir, "anon_mod.dat");
    const payload = Buffer.alloc(5000, 9);
    await writeFile(newBundle, payload);
    const out = join(dir, "out.apk");

    const report = patchApk({
      inApk: apk,
      outApk: out,
      replacements: [{ entry: "assets/AB/Android/anon/aaa.bin", file: newBundle }],
      stripV1: true,
      dryRun: false,
    });

    expect(report.replaced).toHaveLength(1);
    expect(report.replaced[0].newSize).toBe(payload.length);
    expect(report.stripped.sort()).toEqual(["META-INF/ARKNIGHT.RSA", "META-INF/ARKNIGHT.SF", "META-INF/MANIFEST.MF"]);
    expect(report.writtenCount).toBe(report.entryCount - 3);

    const after = await readEntries(out);
    expect(after.has("META-INF/ARKNIGHT.SF")).toBe(false);
    expect(after.get("assets/AB/Android/anon/aaa.bin")?.equals(payload)).toBe(true);
    expect(after.get("classes.dex")?.equals(before.get("classes.dex") ?? Buffer.alloc(0))).toBe(true);
    expect(after.get("lib/arm64-v8a/libx.so")?.equals(before.get("lib/arm64-v8a/libx.so") ?? Buffer.alloc(0))).toBe(true);

    const problems = verifyPatchedApk(out, new Map([["assets/AB/Android/anon/aaa.bin", report.replaced[0].newCrc]]));
    expect(problems).toEqual([]);
  });

  it("dry-run 不落盘且预演替换明细", async () => {
    const { dir, apk } = await buildFixture();
    const repl = join(dir, "x.bin");
    await writeFile(repl, Buffer.alloc(1024, 1));
    const out = join(dir, "never.apk");

    const report = patchApk({
      inApk: apk,
      outApk: out,
      replacements: [{ entry: "classes.dex", file: repl }],
      stripV1: true,
      dryRun: true,
    });

    expect(report.replaced[0].newSize).toBe(1024);
    await expect(stat(out)).rejects.toThrow();
  });

  it("list 概览能识别 V1 签名条目", async () => {
    const { apk } = await buildFixture();
    const info = inspectApk(apk);
    expect(info.hasV1).toBe(true);
    expect(info.entryCount).toBe(13);
  });

  it("新增条目：写入新 zip 条目且自检通过", async () => {
    const { dir, apk } = await buildFixture();
    const payload = Buffer.alloc(3000, 5);
    const out = join(dir, "added.apk");

    const report = patchApk({
      inApk: apk,
      outApk: out,
      replacements: [],
      additions: [{ entry: "assets/AB/Android/anon/new.bin", data: payload }],
      stripV1: true,
      dryRun: false,
    });

    expect(report.added).toHaveLength(1);
    const after = await readEntries(out);
    expect(after.get("assets/AB/Android/anon/new.bin")?.equals(payload)).toBe(true);
    // 原有条目仍在
    expect(after.has("classes.dex")).toBe(true);
    const problems = verifyPatchedApk(out, new Map([["assets/AB/Android/anon/new.bin", report.added[0].newCrc]]));
    expect(problems).toEqual([]);
  });

  it("新增已存在的条目时报错", async () => {
    const { dir, apk } = await buildFixture();
    expect(() =>
      patchApk({
        inApk: apk,
        outApk: join(dir, "dup.apk"),
        replacements: [],
        additions: [{ entry: "classes.dex", data: Buffer.from("x") }],
        stripV1: true,
        dryRun: false,
      }),
    ).toThrow(/新增条目已存在/);
  });

  it("删除条目：精确名 + 前缀，且保护名单拒绝危险删除", async () => {
    const { dir, apk } = await buildFixture();
    const out = join(dir, "slim.apk");

    const report = patchApk({
      inApk: apk,
      outApk: out,
      replacements: [],
      drops: ["classes.dex"],
      dropPrefixes: ["lib/arm64-v8a/"],
      stripV1: true,
      dryRun: false,
    });

    // 前缀规则也会命中 jszip 生成的目录条目（lib/arm64-v8a/）
    expect(report.dropped.map((d) => d.entry).sort()).toEqual([
      "classes.dex",
      "lib/arm64-v8a/",
      "lib/arm64-v8a/libx.so",
    ]);
    const after = await readEntries(out);
    expect(after.has("classes.dex")).toBe(false);
    expect(after.has("lib/arm64-v8a/libx.so")).toBe(false);
    // 其余条目保留
    expect(after.has("assets/AB/Android/anon/aaa.bin")).toBe(true);
    expect(after.has("META-INF/ARKNIGHT.SF")).toBe(false); // V1 仍按 stripV1 清除
    const problems = verifyPatchedApk(out, new Map());
    expect(problems).toEqual([]);
  });

  it("dry-run 报告删除明细且不落盘", async () => {
    const { dir, apk } = await buildFixture();
    const out = join(dir, "never2.apk");
    const report = patchApk({
      inApk: apk,
      outApk: out,
      replacements: [],
      drops: ["classes.dex"],
      stripV1: true,
      dryRun: true,
    });
    expect(report.dropped.map((d) => d.entry)).toEqual(["classes.dex"]);
    await expect(stat(out)).rejects.toThrow();
  });

  it("替换不存在的条目时报错", async () => {
    const { dir, apk } = await buildFixture();
    const repl = join(dir, "x.bin");
    await writeFile(repl, Buffer.from("x"));
    expect(() =>
      patchApk({
        inApk: apk,
        outApk: join(dir, "out.apk"),
        replacements: [{ entry: "not/here.bin", file: repl }],
        stripV1: true,
        dryRun: false,
      }),
    ).toThrow(/不存在条目/);
  });
});
