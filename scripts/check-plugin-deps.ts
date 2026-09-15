import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";
import { extractTextAssets } from "./vendor/unityfs";

// 校验插件模块 require 依赖图：所有 require "Plugin/xxx" 路径都能在 bundle 资产中解析到对应 asset。
// 可指定 dat 路径（默认取当前插件 bundle）。
export async function main(argv: string[] = []): Promise<void> {
  const datPath = path.resolve(argv[0] ?? path.join(__dirname, "..", "mods", "anon_6edf14bbd79243eb61e288ff28e446c3.dat"));
  const zip = await JSZip.loadAsync(fs.readFileSync(datPath));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const unity = await zip.files[names[0]].async("uint8array");
  const assets = extractTextAssets(new Uint8Array(unity));

  // 资产名集合（标准化：小写；同时收「全相对路径」与「裸 basename」两份）。
  // 为什么不只看全路径：客户端 require 按 basename 归一化匹配（容器 key =
  // dyn/gamedata/[uc]lua/plugin/<basename>.bytes），分层目录 core/ ui/ plugins/ 不参与寻址；
  // Android 裸名布局的资产名更是直接不含 gamedata/[uc]lua/ 前缀。
  const assetNames = new Set<string>();
  for (const a of assets) {
    const lower = a.name.toLowerCase();
    const rel = lower.startsWith("gamedata/[uc]lua/")
      ? lower.slice("gamedata/[uc]lua/".length)
      : lower;
    const base = rel.split("/").pop() ?? rel;
    for (const n of [rel, base, base.replace(/\.lua$/, "")]) assetNames.add(n);
  }

  // 收集所有插件 Lua 源码中的 require "X" 调用
  let pluginAssets = assets.filter((a) => a.name.toLowerCase().includes("/plugin/"));
  // Android 裸名布局：插件资产名不含 /plugin/（裸 basename 或 core/ui/plugins/ 子路径），
  // 此时退化为扫描全部 .lua 资产——只校验 require "Plugin/…"，对官方模块无副作用。
  if (pluginAssets.length === 0) {
    pluginAssets = assets.filter((a) => a.name.toLowerCase().endsWith(".lua"));
  }
  const missing: string[] = [];
  // require 解析辅助：xLua 自动补 .lua 后缀、大小写不敏感（官方 require "Hotfixes/DefinedFix"
  // 匹配 hotfixes/definedfix.lua），且按 basename 归一化（`Plugin/core/X` ↔ `plugin/core/x.lua` /
  // 裸名 `x.lua` 均可命中）。
  const resolve = (dep: string): boolean => {
    const d = dep.toLowerCase();
    const base = (d.split("/").pop() ?? d).replace(/\.lua$/, "");
    return (
      assetNames.has(d) ||
      assetNames.has(`${d}.lua`) ||
      assetNames.has(base) ||
      assetNames.has(`${base}.lua`)
    );
  };
  for (const a of pluginAssets) {
    const src = new TextDecoder().decode(a.script);
    const re = /require\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const dep = m[1].trim();
      if (!dep.startsWith("Plugin/") && !dep.toLowerCase().startsWith("plugin/")) continue;
      if (!resolve(dep)) missing.push(`${a.name} -> require ${m[1]}`);
    }
  }

  console.log("bundle 资产数:", assets.length);
  console.log("插件资产数:", pluginAssets.length);
  if (missing.length === 0) {
    console.log("✓ 所有 Plugin require 依赖均能解析到 bundle 资产");
  } else {
    console.log("✗ 以下 require 无法解析:");
    for (const m of missing) console.log("  " + m);
  }
}

// 直连执行入口（被 admin-cli tools 导入时不自动运行）
if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}