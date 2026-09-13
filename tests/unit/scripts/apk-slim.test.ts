/**
 * apk-slim 单测：ABI 去重 + 「只留入口」预设的保留/删除判定 + 保护名单拒绝。
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import os from "os";
import JSZip from "jszip";
import { scanForSlim } from "../../../scripts/apk-slim";

/** 临时目录（afterEach 清理） */
const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 造一个含 assets/AB 内容组、双 ABI、dex 的最小 APK。
 * @returns fixture 路径
 */
async function buildFixture(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "apk-slim-"));
  tmpDirs.push(dir);
  const zip = new JSZip();
  zip.file("AndroidManifest.xml", "<manifest/>");
  zip.file("classes.dex", Buffer.from("dex"));
  zip.file("lib/arm64-v8a/libil2cpp.so", Buffer.alloc(1024, 1));
  zip.file("lib/armeabi-v7a/libil2cpp.so", Buffer.alloc(1024, 2));
  zip.file("assets/bin/Data/globalgamemanagers", Buffer.alloc(512, 3));
  zip.file("assets/AB/Android/hot_update_list.json", "{\"abInfos\":[]}");
  zip.file("assets/AB/Android/df176d96f660b5463c8c5257d04fb908.idx", Buffer.alloc(64, 4));
  zip.file("assets/AB/Android/anon/3ea52f7d41a320d200aa7e61735f0819.bin", Buffer.alloc(128, 5));
  zip.file("assets/AB/Android/arts/big.ab", Buffer.alloc(4096, 6));
  zip.file("assets/AB/Android/audio/voice.ab", Buffer.alloc(2048, 7));
  zip.file("assets/AB/Android/charpack/small.ab", Buffer.alloc(32, 8));
  const apk = join(dir, "fixture.apk");
  await writeFile(apk, await zip.generateAsync({ type: "nodebuffer" }));
  return apk;
}

describe("apk-slim", () => {
  it("默认按 keep-abi 删除其它 ABI，保留 dex/manifest", async () => {
    const apk = await buildFixture();
    const report = await scanForSlim({
      inApk: apk,
      keepAbis: ["arm64-v8a"],
      drop: [],
      dropPrefixes: [],
      allowRisky: false,
      entryPreset: false,
    });
    expect(report.dropped.map((d) => d.name)).toEqual(["lib/armeabi-v7a/libil2cpp.so"]);
    expect(report.abis.map((a) => a.abi).sort()).toEqual(["arm64-v8a", "armeabi-v7a"]);
  });

  it("「只留入口」预设：AB 下只保留 anon/清单/核心小目录，内容组删除", async () => {
    const apk = await buildFixture();
    const report = await scanForSlim({
      inApk: apk,
      keepAbis: ["arm64-v8a"],
      drop: [],
      dropPrefixes: [],
      allowRisky: false,
      entryPreset: true,
    });
    const dropped = report.dropped.map((d) => d.name).sort();
    expect(dropped).toEqual(["assets/AB/Android/arts/big.ab", "assets/AB/Android/audio/voice.ab", "lib/armeabi-v7a/libil2cpp.so"]);
    // 必备项不在删除列表里
    for (const keep of [
      "AndroidManifest.xml",
      "classes.dex",
      "assets/bin/Data/globalgamemanagers",
      "assets/AB/Android/hot_update_list.json",
      "assets/AB/Android/df176d96f660b5463c8c5257d04fb908.idx",
      "assets/AB/Android/anon/3ea52f7d41a320d200aa7e61735f0819.bin",
      "assets/AB/Android/charpack/small.ab",
      "lib/arm64-v8a/libil2cpp.so",
    ]) {
      expect(dropped).not.toContain(keep);
    }
  });

  it("拒绝删除受保护条目（classes.dex / 保留 ABI 的 lib / META-INF）", async () => {
    const apk = await buildFixture();
    await expect(
      scanForSlim({
        inApk: apk,
        keepAbis: ["arm64-v8a"],
        drop: ["classes.dex"],
        dropPrefixes: [],
        allowRisky: true,
        entryPreset: false,
      }),
    ).rejects.toThrow(/受保护条目/);
  });

  it("assets/bin/Data 属资产保护名单：未开 --allow-risky 时拒绝删除", async () => {
    const apk = await buildFixture();
    await expect(
      scanForSlim({
        inApk: apk,
        keepAbis: ["arm64-v8a"],
        drop: ["assets/bin/Data/globalgamemanagers"],
        dropPrefixes: [],
        allowRisky: false,
        entryPreset: false,
      }),
    ).rejects.toThrow(/受保护资产/);
  });
});
