import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile, access } from "fs/promises";
import { join } from "path";
import os from "os";
import JSZip from "jszip";
import { packLuaBundle } from "../../../scripts/pack-lua-bundle";
import { extractTextAssets } from "../../../scripts/vendor/unityfs";
import {
  ensureLuaModBuilt,
  ensureLuaMinModBuilt,
  isLuaModStale,
  BUILTIN_LUA_MOD_NAME,
} from "@plugin/lua-mod-builder";

const enc = new TextEncoder();
const dec = new TextDecoder();

const tempDirs: string[] = [];

async function makeDirs(): Promise<{ mods: string; plugin: string; ref: string }> {
  const mods = await mkdtemp(join(os.tmpdir(), "lua-mod-mods-"));
  const plugin = await mkdtemp(join(os.tmpdir(), "lua-mod-plugin-"));
  const ref = await mkdtemp(join(os.tmpdir(), "lua-mod-ref-"));
  tempDirs.push(mods, plugin, ref);
  return { mods, plugin, ref };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

/** 与官方 DefinedFix.lua 结构一致的假清单（已注入插件 hotfixer 条目） */
function injectedDefinedFix(): string {
  return [
    "local list = {",
    '  "Plugin/NetworkRedirectPlugin",',
    '  "HotFixes/TestStubHotfixer",',
    "};",
    "return list;",
    "",
  ].join("\n");
}

/** 构造假内置 bundle 并写为覆盖 mod .dat（zip 单条目） */
async function writeBuiltinDat(
  modsDir: string,
  assets: { name: string; script: Uint8Array }[],
): Promise<string> {
  const zip = new JSZip();
  zip.file("anon/7d91430e114d86fef7d3b3511151e12d.bin", Buffer.from(packLuaBundle(assets)), {
    createFolders: false,
  });
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const dat = join(modsDir, BUILTIN_LUA_MOD_NAME);
  await writeFile(dat, buf);
  return dat;
}

/** 解 .dat 并返回全部 Lua 资产 */
async function readModAssets(datPath: string): Promise<{ name: string; script: Uint8Array }[]> {
  const zip = await JSZip.loadAsync(await readFile(datPath));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const unity = await zip.files[names[0]].async("uint8array");
  return extractTextAssets(new Uint8Array(unity));
}

describe("lua-mod-builder 启动自动构建", () => {
  it("无数据源（无参考目录且无现有 mod）时跳过，不抛错", async () => {
    const { mods, plugin, ref } = await makeDirs();
    const result = await ensureLuaModBuilt({ modsDir: mods, pluginDir: plugin, refDir: ref });
    expect(result.built).toBe(false);
    expect(result.reason).toBe("no-source");
    expect(result.dat).toBeNull();
  });

  it("产物为最新时跳过（up-to-date）", async () => {
    const { mods, plugin, ref } = await makeDirs();
    // 先写插件，再写 dat（dat 更新 → 未过期）
    await writeFile(join(plugin, "A.lua"), enc.encode("-- a\n"));
    const dat = await writeBuiltinDat(mods, [
      { name: "gamedata/[uc]lua/Hotfixes/DefinedFix.lua", script: enc.encode('local list = { "HotFixes/A" };\n') },
    ]);

    expect(isLuaModStale(dat, plugin)).toBe(false);
    const result = await ensureLuaModBuilt({ modsDir: mods, pluginDir: plugin, refDir: ref });
    expect(result.built).toBe(false);
    expect(result.reason).toBe("up-to-date");
  });

  it("插件新于产物时自动重打包（self-repack）：合并新插件、剔除旧插件、注入单条目", async () => {
    const { mods, plugin, ref } = await makeDirs();
    // 现有 mod：官方 lua + 旧插件资产 + 已注入引导条目
    const dat = await writeBuiltinDat(mods, [
      { name: "gamedata/[uc]lua/Hotfixes/DefinedFix.lua", script: enc.encode(injectedDefinedFix()) },
      { name: "gamedata/[uc]lua/base/BaseModule.lua", script: enc.encode("-- base\n") },
      { name: "gamedata/[uc]lua/Plugin/Old.lua", script: enc.encode("-- old\n") },
    ]);
    // 把 dat 时间戳拨回过去，模拟插件源码更新
    await utimes(dat, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await writeFile(join(plugin, "NetworkRedirectPlugin.lua"), enc.encode("-- redirect\n"));
    await writeFile(join(plugin, "NewPlugin.lua"), enc.encode("-- new\n"));

    const result = await ensureLuaModBuilt({ modsDir: mods, pluginDir: plugin, refDir: ref });
    expect(result.built).toBe(true);
    expect(result.reason).toBe("self-repack");

    const assets = await readModAssets(result.dat!);
    const names = assets.map((a) => a.name);
    expect(names).toContain("gamedata/[uc]lua/Plugin/NewPlugin.lua");
    expect(names).toContain("gamedata/[uc]lua/Plugin/NetworkRedirectPlugin.lua");
    expect(names).not.toContain("gamedata/[uc]lua/Plugin/Old.lua");
    const df = assets.find((a) => a.name.toLowerCase().endsWith("definedfix.lua"))!;
    const bootCount = dec
      .decode(df.script)
      .split(/\r?\n/)
      .filter((l) => l.trim() === '"Plugin/NetworkRedirectPlugin",').length;
    expect(bootCount).toBe(1);
  });

  it("存在参考目录时优先 from-ref 构建；参考目录更新后再次构建，未变更时跳过", async () => {
    const { mods, plugin, ref } = await makeDirs();
    // 假官方明文参考目录
    await writeFile(join(ref, "entry.lua"), enc.encode("-- entry\n"));
    await mkdir(join(ref, "hotfixes"), { recursive: true });
    await writeFile(join(ref, "hotfixes", "definedfix.lua"), enc.encode('local list = { "HotFixes/A" };\n'));
    await writeFile(join(plugin, "EnemyHpPlugin.lua"), enc.encode("-- hp\n"));

    // 首次：无现有 dat → from-ref 构建
    const r1 = await ensureLuaModBuilt({ modsDir: mods, pluginDir: plugin, refDir: ref });
    expect(r1.built).toBe(true);
    expect(r1.reason).toBe("from-ref");
    const assets1 = await readModAssets(r1.dat!);
    expect(assets1.map((a) => a.name)).toContain("gamedata/[uc]lua/Plugin/EnemyHpPlugin.lua");

    // 未变更：跳过
    const r2 = await ensureLuaModBuilt({ modsDir: mods, pluginDir: plugin, refDir: ref });
    expect(r2.built).toBe(false);
    expect(r2.reason).toBe("up-to-date");

    // 参考目录更新（重新 extract 新客户端 bundle 的模拟）→ 再次 from-ref 构建
    // 先拨旧 dat 时间戳：本机 /tmp 上同毫秒内写入的 mtime 可能完全相同（实测 delta=0ms），
    // 否则「参考目录更新」会被过期检测误判为未变更（与本文件其它用例同款做法）
    await utimes(r1.dat!, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await writeFile(join(ref, "new.lua"), enc.encode("-- new\n"));
    const r3 = await ensureLuaModBuilt({ modsDir: mods, pluginDir: plugin, refDir: ref });
    expect(r3.built).toBe(true);
    expect(r3.reason).toBe("from-ref");
    const assets3 = await readModAssets(r3.dat!);
    expect(assets3.map((a) => a.name)).toContain("gamedata/[uc]lua/new.lua");
  });

  it("现有 mod 损坏时构建失败仅记日志，不抛错且保留原文件", async () => {
    const { mods, plugin, ref } = await makeDirs();
    const dat = join(mods, BUILTIN_LUA_MOD_NAME);
    await writeFile(dat, Buffer.from("not a zip"));
    // 拨旧 dat 时间戳，保证插件源码（新写入）判定为过期，触发构建
    await utimes(dat, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await writeFile(join(plugin, "A.lua"), enc.encode("-- a\n"));

    const result = await ensureLuaModBuilt({ modsDir: mods, pluginDir: plugin, refDir: ref });
    expect(result.built).toBe(false);
    expect(result.reason).toMatch(/^error:/);
    expect(result.dat).toBe(dat); // 原文件保留
  });

  it("ensureLuaMinModBuilt 只生成最小包，并清理整包残留 anon", async () => {
    const { mods, plugin, ref } = await makeDirs();
    await writeFile(join(plugin, "EnemyHpPlugin.lua"), enc.encode("-- hp\n"));
    await writeFile(join(plugin, "NetworkRedirectPlugin.lua"), enc.encode("-- redirect\n"));
    // 预置整包残留（anon_<32hex>.dat）与占位
    await writeFile(join(mods, BUILTIN_LUA_MOD_NAME), "stale-full");
    await writeFile(join(mods, ".placeholder"), "");

    const result = await ensureLuaMinModBuilt(mods);

    // 构建成功且只留一个新产物（哈希命名，非整包名）
    expect(result.built).toBe(true);
    expect(result.dat).toBeTruthy();
    const datName = result.dat!.split(/[\\/]/).pop()!;
    expect(datName).toMatch(/anon_[0-9a-f]{32}\.dat$/);
    expect(datName).not.toBe(BUILTIN_LUA_MOD_NAME);
    // 整包残留被清理，占位保留
    await expect(access(join(mods, BUILTIN_LUA_MOD_NAME))).rejects.toThrow();
  });
});
