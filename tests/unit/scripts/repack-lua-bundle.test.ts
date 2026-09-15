import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import os from "os";
import yauzl from "yauzl";
import { packLuaBundle } from "../../../scripts/pack-lua-bundle";
import { extractTextAssets, type AssetBundleMeta } from "../../../scripts/vendor/unityfs";
import { buildContainer, patchDefinedFix, repackBuiltinLua } from "../../../scripts/repack-lua-bundle";

const enc = new TextEncoder();
const dec = new TextDecoder();

const tempDirs: string[] = [];

async function makeTempDirs(): Promise<{ src: string; out: string }> {
  const src = await mkdtemp(join(os.tmpdir(), "lua-repack-src-"));
  const out = await mkdtemp(join(os.tmpdir(), "lua-repack-out-"));
  tempDirs.push(src, out);
  return { src, out };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

/** 构造与官方 DefinedFix.lua 结构一致的假清单 */
function fakeDefinedFix(): string {
  return [
    "local list = ",
    "{",
    '  "HotFixes/TestStubHotfixer",',
    '  "HotFixes/PCInputFontRegistryHotfixer",',
    "};",
    "return list;",
    "",
  ].join("\n");
}

/** 读回 .dat（zip），返回 { entryName, content } */
function readZip(path: string): Promise<{ entryName: string; content: Buffer }[]> {
  return new Promise((resolve, reject) => {
    const entries: { entryName: string; content: Buffer }[] = [];
    yauzl.open(path, { lazyEntries: true }, (err, zipFile) => {
      if (err) return reject(err);
      zipFile.on("entry", (entry) => {
        zipFile.openReadStream(entry, (err2, stream) => {
          if (err2) return reject(err2);
          const chunks: Buffer[] = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("end", () => {
            entries.push({ entryName: entry.fileName, content: Buffer.concat(chunks) });
            zipFile.readEntry();
          });
        });
      });
      zipFile.on("end", () => resolve(entries));
      zipFile.readEntry();
    });
  });
}

describe("repack-lua-bundle 内置 bundle 重打包（DefinedFix 引导）", () => {
  it("patchDefinedFix 注入单一引导 hotfixer（PluginBootHotfixer）到清单最前", () => {
    const patched = patchDefinedFix(fakeDefinedFix());
    // 工作化设计：只注入单一 PluginBootHotfixer（经游戏原生 HotfixProcesser.Do 驱动
    // PluginManager 初始化整个插件系统）；per-plugin 逐条 new+Init 在真机 2.7.61 会崩
    expect(patched).toContain('  "Plugin/core/PluginBootHotfixer",');
    expect(patched).toContain('"HotFixes/TestStubHotfixer",');
    expect(patched).toContain('"HotFixes/PCInputFontRegistryHotfixer"');
    // 引导类插件条目须在清单最前
    expect(patched.indexOf("Plugin/core/PluginBootHotfixer")).toBeLessThan(
      patched.indexOf("HotFixes/TestStubHotfixer"),
    );
  });

  it("patchDefinedFix 锚点缺失时抛错", () => {
    expect(() => patchDefinedFix("local x = 1\n")).toThrow(/未找到/);
  });

  it("patchDefinedFix 锚点大小写不敏感（Hotfixes/ 小写 x 也能命中）", () => {
    const lower = [
      "local list = {",
      '  "Hotfixes/TestStubHotfixer",',
      "};",
      "",
    ].join("\n");
    const patched = patchDefinedFix(lower);
    expect(patched).toContain('  "Plugin/core/PluginBootHotfixer",');
    expect(patched.indexOf("Plugin/core/PluginBootHotfixer")).toBeLessThan(
      patched.indexOf("Hotfixes/TestStubHotfixer"),
    );
  });

  it("patchDefinedFix 幂等：已注入的 bundle 不重复追加插件条目", () => {
    const once = patchDefinedFix(fakeDefinedFix());
    const twice = patchDefinedFix(once);
    expect(twice).toContain('  "Plugin/core/PluginBootHotfixer",');
    const bootCount = twice.split(/\r?\n/).filter((l) => l.trim() === '"Plugin/core/PluginBootHotfixer",').length;
    expect(bootCount).toBe(1);
    expect(twice).toContain('"HotFixes/TestStubHotfixer",');
  });

  it("buildContainer 按 require 路径派生分层插件资产 key，并补 basename 别名", () => {
    const merged = [
      { name: "gamedata/[uc]lua/Plugin/core/PluginManager.lua", script: enc.encode("-- m\n") },
      { name: "gamedata/[uc]lua/Plugin/PluginDefs.lua", script: enc.encode("-- d\n") },
    ];
    const meta: AssetBundleMeta = {
      name: "init/gamedata/[uc]lua.ab",
      container: [],
      tail: new Uint8Array(),
    };
    const container = buildContainer(merged, meta);
    // require "Plugin/core/PluginManager" → 带子目录的容器 key
    expect(container).toContainEqual({
      key: "dyn/gamedata/[uc]lua/plugin/core/pluginmanager.lua.bytes",
      assetIndex: 0,
    });
    // basename 别名（兼容 basename 归一化口径）
    expect(container).toContainEqual({
      key: "dyn/gamedata/[uc]lua/plugin/pluginmanager.lua.bytes",
      assetIndex: 0,
    });
    // 根清单 require "Plugin/PluginDefs"：主 key 与别名相同，只登记一次
    expect(container).toContainEqual({
      key: "dyn/gamedata/[uc]lua/plugin/plugindefs.lua.bytes",
      assetIndex: 1,
    });
    expect(
      container.filter((c) => c.assetIndex === 1).length,
      "主 key 与 basename 别名重合时不应重复登记",
    ).toBe(1);
  });

  it("buildContainer 对 Android 裸名插件资产补回 plugin/ 前缀", () => {
    const merged = [{ name: "core/PluginManager.lua", script: enc.encode("-- m\n") }];
    const meta: AssetBundleMeta = {
      name: "init/gamedata/[uc]lua.ab",
      container: [],
      tail: new Uint8Array(),
    };
    const container = buildContainer(merged, meta);
    expect(container).toContainEqual({
      key: "dyn/gamedata/[uc]lua/plugin/core/pluginmanager.lua.bytes",
      assetIndex: 0,
    });
  });

  it("端到端：重打包 → 覆盖 mod 含插件(Plugin 前缀) + 补丁后的 DefinedFix", async () => {
    const { src, out } = await makeTempDirs();

    // 假内置 bundle（含 DefinedFix.lua、普通 lua、以及模拟已重打包残留的旧插件资产）
    const builtinAssets = [
      { name: "gamedata/[uc]lua/Hotfixes/DefinedFix.lua", script: enc.encode(fakeDefinedFix()) },
      { name: "gamedata/[uc]lua/base/BaseModule.lua", script: enc.encode("-- base module\n") },
      { name: "gamedata/[uc]lua/Plugin/OldPlugin.lua", script: enc.encode("-- old\n") },
    ];
    const builtinBytes = packLuaBundle(builtinAssets);
    const builtinBin = join(src, "anon_7d91430e114d86fef7d3b3511151e12d.bin");
    await writeFile(builtinBin, Buffer.from(builtinBytes));

    // 假插件目录（模拟 lua/plugin/，每个插件作为独立 hotfixer 资产）
    const pluginDir = join(src, "plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "EnemyHpPlugin.lua"), enc.encode("-- hp\n"));
    await writeFile(join(pluginDir, "NetworkRedirectPlugin.lua"), enc.encode("-- redirect\n"));

    const result = await repackBuiltinLua(builtinBin, pluginDir, out);
    expect(result.dat.endsWith("anon_6edf14bbd79243eb61e288ff28e446c3.dat")).toBe(true);

    const entries = await readZip(result.dat);
    expect(entries.map((e) => e.entryName)).toEqual(["anon/6edf14bbd79243eb61e288ff28e446c3.bin"]);

    const list = extractTextAssets(new Uint8Array(entries[0].content));
    const names = list.map((a) => a.name);
    // 插件资产用 Plugin 大写前缀（与 require 路径一致）
    expect(names).toContain("gamedata/[uc]lua/Plugin/EnemyHpPlugin.lua");
    // 内置 bundle 中残留的旧插件资产被剔除（构建期由 lua/plugin/ 重新合并）
    expect(names).not.toContain("gamedata/[uc]lua/Plugin/OldPlugin.lua");
    // DefinedFix 注入单一 PluginBootHotfixer（引导整插件系统），不含逐条 per-plugin 条目
    const df = list.find((a) => a.name.toLowerCase().endsWith("definedfix.lua"))!;
    const dfText = dec.decode(df.script);
    expect(dfText).toContain('"Plugin/core/PluginBootHotfixer",');
    expect(dfText).toContain('"HotFixes/TestStubHotfixer",');
    expect(dfText).not.toContain('"Plugin/NetworkRedirectPlugin",');
    expect(dfText).not.toContain('"Plugin/EnemyHpPlugin",');
  });

  it("内置 bundle 无 DefinedFix 时抛错", async () => {
    const { src, out } = await makeTempDirs();
    const bytes = packLuaBundle([{ name: "gamedata/[uc]lua/x.lua", script: enc.encode("-- x\n") }]);
    const bin = join(src, "builtin.bin");
    await writeFile(bin, Buffer.from(bytes));
    const pluginDir = join(src, "plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "A.lua"), enc.encode("-- a\n"));
    await expect(repackBuiltinLua(bin, pluginDir, out)).rejects.toThrow(/DefinedFix/);
  });
});