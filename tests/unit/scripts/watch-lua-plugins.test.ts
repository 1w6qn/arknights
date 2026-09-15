import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access } from "fs/promises";
import { join } from "path";
import os from "os";
import { extractTextAssets } from "../../../scripts/vendor/unityfs";
import { rebuildOnce } from "../../../scripts/watch-lua-plugins";

const enc = new TextEncoder();

const tempDirs: string[] = [];

async function makeTempDirs(): Promise<{ ref: string; plugin: string; out: string }> {
  const ref = await mkdtemp(join(os.tmpdir(), "lua-watch-ref-"));
  const plugin = await mkdtemp(join(os.tmpdir(), "lua-watch-plugin-"));
  const out = await mkdtemp(join(os.tmpdir(), "lua-watch-out-"));
  tempDirs.push(ref, plugin, out);
  return { ref, plugin, out };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

/** 写一个含 DefinedFix.lua 的假内置参考目录（明文 Lua，供 --from-ref 重建） */
async function writeRefLua(ref: string): Promise<void> {
  const definedFix = [
    "local list = {",
    '  "HotFixes/TestStubHotfixer",',
    "};",
    "return list;",
    "",
  ].join("\n");
  await writeFile(join(ref, "entry.lua"), enc.encode("-- entry\n"));
  await mkdir(join(ref, "hotfixes"), { recursive: true });
  await writeFile(join(ref, "hotfixes", "definedfix.lua"), enc.encode(definedFix));
}

describe("watch-lua-plugins 插件热重载", () => {
  it("rebuildOnce 重打包内置 bundle 并删除平台 mods 缓存", async () => {
    const { ref, plugin, out } = await makeTempDirs();
    await writeRefLua(ref);

    // 假插件目录
    await writeFile(join(plugin, "EnemyHpPlugin.lua"), enc.encode("-- hp\n"));

    // 预置平台 mods 缓存（模拟服务端已缓存旧指纹：mods.Android.json / mods.Windows.json，
    // 兼容历史 mods.json）
    const caches = [
      join(out, "mods.json"),
      join(out, "mods.Android.json"),
      join(out, "mods.Windows.json"),
    ];
    for (const c of caches) {
      await writeFile(c, enc.encode('{"file":{}}'));
    }

    const result = await rebuildOnce(ref, plugin, out, caches);

    // 重打包产物存在且含插件 + DefinedFix
    expect(result.assetCount).toBeGreaterThan(0);
    const datPath = result.dat;
    expect(datPath.endsWith("anon_6edf14bbd79243eb61e288ff28e446c3.dat")).toBe(true);
    await expect(access(datPath)).resolves.toBeUndefined();

    // 平台 mods 缓存均被删除
    for (const c of caches) {
      await expect(access(c)).rejects.toThrow();
    }
  });

  it("mods 缓存不存在时重打包不报错", async () => {
    const { ref, plugin, out } = await makeTempDirs();
    await writeRefLua(ref);
    await writeFile(join(plugin, "A.lua"), enc.encode("-- a\n"));

    const result = await rebuildOnce(ref, plugin, out, []);
    expect(result.assetCount).toBeGreaterThan(0);
  });

  it("重打包产物可解包回插件与补丁后的 DefinedFix", async () => {
    const { ref, plugin, out } = await makeTempDirs();
    await writeRefLua(ref);
    await writeFile(join(plugin, "NetworkRedirectPlugin.lua"), enc.encode("-- redirect\n"));

    const { bundle } = await rebuildOnce(ref, plugin, out, []);
    const assets = extractTextAssets(bundle);
    const names = assets.map((a) => a.name.toLowerCase());
    // 插件资产已并入
    expect(names).toContain("gamedata/[uc]lua/plugin/networkredirectplugin.lua");
    // DefinedFix 已注入该插件 hotfixer 条目
    const df = assets.find((a) => a.name.toLowerCase().endsWith("definedfix.lua"))!;
    const txt = new TextDecoder().decode(df.script);
    expect(txt).toContain('"Plugin/core/PluginBootHotfixer",');
  });
});