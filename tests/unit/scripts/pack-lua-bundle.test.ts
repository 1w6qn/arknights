/**
 * pack-lua-bundle 重打包器单测：打包 → 现有解包器回读，验证往返一致。
 */
import { describe, expect, it } from "vitest";
import {
  buildSerializedFile,
  buildUnityFS,
  packLuaBundle,
  buildDat,
  type LuaAsset,
} from "../../../scripts/pack-lua-bundle";
import { extractBundleWithMeta, extractTextAsset, unityFsToSerializedFile } from "../../../scripts/vendor/unityfs";
import { buildInlinePluginPrelude } from "../../../scripts/repack-lua-bundle";
import JSZip from "jszip";
import { join } from "path";

/** 构造受控 Lua 资产列表 */
function sampleAssets(): LuaAsset[] {
  return [
    { name: "gamedata/[uc]lua/entry.lua", script: Buffer.from("EntryTable = {}\n") },
    { name: "gamedata/[uc]lua/GlobalConfig.lua", script: Buffer.from("GlobalConfig = { CUR_FUNC_VER = \"V075\" }\n") },
    { name: "gamedata/[uc]lua/feature/TestHotfixer.lua", script: Buffer.from("local M = {}\nreturn M\n") },
  ];
}

describe("pack-lua-bundle 重打包器", () => {
  it("单 asset：SerializedFile → UnityFS → 解包回读一致", () => {
    const asset = { name: "gamedata/[uc]lua/entry.lua", script: Buffer.from("EntryTable = {}\n") };
    const sf = buildSerializedFile([asset]);
    const uf = buildUnityFS(sf);
    // UnityFS 头可识别
    expect(Buffer.from(uf.subarray(0, 8)).toString("utf8")).toContain("UnityFS");
    // 解包回读
    const ta = extractTextAsset(uf);
    expect(ta).not.toBeNull();
    expect(ta!.name).toBe(asset.name);
    expect(Buffer.from(ta!.script)).toEqual(asset.script);
  });

  it("多 asset：packLuaBundle 整体可被解包器解析（非 null）", () => {
    const uf = packLuaBundle(sampleAssets());
    const ta = extractTextAsset(uf);
    expect(ta).not.toBeNull();
  });

  it("buildDat 产出官方 .dat（zip 单条目，条目名=bundle 路径）", async () => {
    const assets = sampleAssets();
    const uf = packLuaBundle(assets);
    const bundlePath = "anon/7d91430e114d86fef7d3b3511151e12d.bin";
    const dat = await buildDat(uf, bundlePath);
    // .dat 是 zip，可被 JSZip 解出单条目
    const zip = await JSZip.loadAsync(Buffer.from(dat));
    const entries = Object.keys(zip.files);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(bundlePath);
    // 条目内为可解析的 UnityFS
    const inner = await zip.files[bundlePath].async("uint8array");
    const ta = extractTextAsset(inner);
    expect(ta).not.toBeNull();
  });

  it("空资产列表抛错", () => {
    expect(() => buildSerializedFile([])).toThrow("至少需要 1 条 Lua 资产");
  });

  it("带容器打包：AssetBundle(142) 容器可被回读，pathId 与资产一一对应", () => {
    const assets = sampleAssets();
    const uf = packLuaBundle(assets, {
      container: [
        { key: "dyn/gamedata/[uc]lua/entry.lua.bytes", assetIndex: 0 },
        { key: "dyn/gamedata/[uc]lua/globalconfig.lua.bytes", assetIndex: 1 },
      ],
      assetBundleName: "init/gamedata/[uc]lua.ab",
      tail: Buffer.from([1, 2, 3, 4]),
    });
    const { assets: read, assetBundle } = extractBundleWithMeta(uf);
    expect(read.map((a) => a.name)).toEqual(assets.map((a) => a.name));
    expect(assetBundle).not.toBeNull();
    expect(assetBundle!.name).toBe("init/gamedata/[uc]lua.ab");
    expect(assetBundle!.container.map((c) => c.key)).toEqual([
      "dyn/gamedata/[uc]lua/entry.lua.bytes",
      "dyn/gamedata/[uc]lua/globalconfig.lua.bytes",
    ]);
    // 容器条目 pathId = 资产下标 + 1
    expect(assetBundle!.container.map((c) => Number(c.pathId))).toEqual([1, 2]);
    expect(Buffer.from(assetBundle!.tail).equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
  });

  it("保留官方 pathId（64 位精度不丢）与 AssetBundle pathId", () => {
    const assets = sampleAssets();
    const bigId = 9329830945413132187n; // > 2^53，转 Number 会丢精度
    const uf = packLuaBundle(assets, {
      container: [{ key: "dyn/gamedata/[uc]lua/entry.lua.bytes", assetIndex: 0 }],
      pathIds: [bigId, 0n, 0n],
      assetBundlePathId: 1n,
    });
    const { assetBundle, assetPathIds, assetBundlePathId } = extractBundleWithMeta(uf);
    expect(assetPathIds[0]).toBe(bigId);
    expect(assetBundlePathId).toBe(1n);
    expect(assetBundle!.container[0].pathId).toBe(bigId);
    // 自动分配的 pathId 不得与 AssetBundle 对象撞号
    expect(assetPathIds.slice(1).every((v) => v !== 1n)).toBe(true);
  });

  it("对象数据起点 8 字节对齐（官方 bundle 实测规则；不对齐 Unity 读资产会崩）", () => {
    const assets = sampleAssets();
    const uf = packLuaBundle(assets, {
      container: assets.map((a, i) => ({ key: `dyn/gamedata/[uc]lua/x${i}.lua.bytes`, assetIndex: i })),
    });
    const sf = unityFsToSerializedFile(uf);
    // 头：dataOffset 在扩展头（offset 32）i64 大端
    const u32be = (o: number) => ((sf[o] << 24) | (sf[o + 1] << 16) | (sf[o + 2] << 8) | sf[o + 3]) >>> 0;
    const dataOffset = u32be(32) * 4294967296 + u32be(36);
    const i32le = (o: number) => sf[o] | (sf[o + 1] << 8) | (sf[o + 2] << 16) | (sf[o + 3] << 24);
    const i64le = (o: number) => {
      const lo = BigInt((sf[o] | (sf[o + 1] << 8) | (sf[o + 2] << 16) | (sf[o + 3] << 24)) >>> 0);
      const hi = BigInt((sf[o + 4] | (sf[o + 5] << 8) | (sf[o + 6] << 16) | (sf[o + 7] << 24)) >>> 0);
      return Number((hi << 32n) | lo);
    };
    // 定位 objectCount：跳过头(48) + unityVersion cstr + targetPlatform(4) + enableTypeTree(1) + typeCount(4) + 类型条目
    let o = 48;
    while (sf[o] !== 0) o++;
    o += 1 + 4 + 1;
    const typeCount = i32le(o);
    o += 4;
    const enableTypeTree = sf[o - 1] !== 0;
    for (let i = 0; i < typeCount; i++) {
      o += 4 + 1 + 2 + 16;
      if (enableTypeTree) {
        const n = i32le(o);
        o += 4;
        const sb = i32le(o);
        o += 4 + 32 * n + sb;
      }
      const dep = i32le(o);
      o += 4 + 4 * dep;
    }
    const objectCount = i32le(o);
    o += 4;
    while (o % 4 !== 0) o++;
    const starts: number[] = [];
    for (let i = 0; i < objectCount; i++) {
      o += 8;
      starts.push(i64le(o) + dataOffset);
      o += 8 + 4 + 4;
    }
    expect(starts.every((v) => v % 8 === 0)).toBe(true);
  });

  it("插件内联 prelude：注册 package.preload 与落盘埋点（绕过资产查找）", () => {
    const pluginDir = join(__dirname, "..", "..", "..", "lua", "plugin");
    const prelude = buildInlinePluginPrelude(pluginDir);
    // 关键模块按 require 路径注册（引擎 HotfixProcesser 用 Lua require 加载）
    expect(prelude).toContain('package.preload["Plugin/core/PluginBootHotfixer"]');
    expect(prelude).toContain('package.preload["Plugin/plugins/NetworkRedirectPlugin"]');
    expect(prelude).toContain('package.preload["Plugin/core/BasePlugin"]');
    expect(prelude).toContain('package.preload["Plugin/PluginDefs"]');
    // 埋点与引导包装
    expect(prelude).toContain("plugin_boot_trace.txt");
    expect(prelude).toContain("PluginBootHotfixer required");
  });

  it("不带容器打包（旧行为）：无 AssetBundle 对象", () => {
    const { assetBundle } = extractBundleWithMeta(packLuaBundle(sampleAssets()));
    expect(assetBundle).toBeNull();
  });
});