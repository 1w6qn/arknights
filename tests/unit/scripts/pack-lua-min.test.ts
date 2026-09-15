import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "fs/promises";
import { join } from "path";
import os from "os";
import JSZip from "jszip";
import { extractTextAssets } from "../../../scripts/vendor/unityfs";
import { bundleToModName } from "../../../scripts/repack-lua-bundle";
import { buildLuaMinPack } from "../../../scripts/pack-lua-min";

const enc = new TextEncoder();
const tempDirs: string[] = [];

async function makeDirs(): Promise<{ out: string; plugin: string; ref: string }> {
  const out = await mkdtemp(join(os.tmpdir(), "lua-min-out-"));
  const plugin = await mkdtemp(join(os.tmpdir(), "lua-min-plugin-"));
  const ref = await mkdtemp(join(os.tmpdir(), "lua-min-ref-"));
  tempDirs.push(out, plugin, ref);
  return { out, plugin, ref };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** 解 .dat 返回全部 Lua 资产名 */
async function readDatAssets(datPath: string): Promise<{ name: string; script: string }[]> {
  const zip = await JSZip.loadAsync(await readFile(datPath));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const unity = await zip.files[names[0]].async("uint8array");
  return extractTextAssets(new Uint8Array(unity)).map((a) => ({
    name: a.name,
    script: new TextDecoder().decode(a.script),
  }));
}

describe("pack-lua-min 最小 Lua 更新包", () => {
  it("只含补丁后 DefinedFix + 插件资产，哈希命名，DefinedFix 已注入插件条目", async () => {
    const { out, plugin, ref } = await makeDirs();

    // 参考目录：含 DefinedFix 与其它内置 lua（应被最小包过滤，仅取 DefinedFix）
    await mkdir(join(ref, "hotfixes"), { recursive: true });
    await mkdir(join(ref, "base"), { recursive: true });
    await writeFile(
      join(ref, "hotfixes", "DefinedFix.lua"),
      enc.encode('local list = {  "HotFixes/TestStubHotfixer", };\nreturn list;\n'),
    );
    await writeFile(join(ref, "base", "BaseModule.lua"), enc.encode("-- base module\n"));

    // 插件目录
    await writeFile(join(plugin, "EnemyHpPlugin.lua"), enc.encode("-- hp\n"));
    await writeFile(join(plugin, "NetworkRedirectPlugin.lua"), enc.encode("-- redirect\n"));

    const result = await buildLuaMinPack([ref], plugin, out);

    // 哈希命名（anon/<md5>.bin）
    expect(result.bundleName).toMatch(/^anon\/[0-9a-f]{32}\.bin$/);
    // dat 名必须与规范转换 bundleToModName 一致（对齐 app/ops/assets/asset.ts loadMods 的 download 查找语义）
    expect(result.datName).toBe(bundleToModName(result.bundleName));
    expect(result.pluginCount).toBe(2);
    expect(result.dat).toBe(join(out, result.datName));

    const assets = await readDatAssets(result.dat);
    const names = assets.map((a) => a.name.toLowerCase());
    // 含补丁 DefinedFix（gamedata/[uc]lua/hotfixes/definedfix.lua）+ 全部插件；不含内置 base/BaseModule.lua
    expect(names).toContain("gamedata/[uc]lua/hotfixes/definedfix.lua");
    expect(names.some((n) => n.endsWith("enemyhpplugin.lua"))).toBe(true);
    expect(names.some((n) => n.endsWith("networkredirectplugin.lua"))).toBe(true);
    expect(names.some((n) => n.includes("basemodule.lua"))).toBe(false);

    // DefinedFix 已注入插件引导 hotfixer 条目（Plugin/core/PluginBootHotfixer；插件资产已并入 bundle）
    const df = assets.find((a) => /definedfix\.lua$/i.test(a.name))!;
    expect(df.script.toLowerCase()).toContain("plugin/core/pluginboothotfixer");
  });

  it("参考目录缺失 DefinedFix 时报错", async () => {
    const { out, plugin, ref } = await makeDirs();
    await mkdir(join(ref, "base"), { recursive: true });
    await writeFile(join(ref, "base", "BaseModule.lua"), enc.encode("-- base\n"));
    await writeFile(join(plugin, "A.lua"), enc.encode("-- a\n"));

    await expect(buildLuaMinPack([ref], plugin, out)).rejects.toThrow(/DefinedFix/);
  });
});