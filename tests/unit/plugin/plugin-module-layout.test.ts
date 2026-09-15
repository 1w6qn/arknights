/**
 * Lua 插件目录布局守卫（规范化模块化，2026-09-14）
 *
 * 固化三条不变量：
 *   1. 目录规范：lua/plugin/ 只允许根 PluginDefs.lua + core/ + ui/ + plugins/（各层扁平 .lua）；
 *   2. 路径可解析：PluginDefs 登记的 module 与源码内全部 require "Plugin/…" 都能落到真实文件；
 *   3. 单一数据源不漂移：服务端 FALLBACK_CATALOG 的 module 与 PluginDefs.lua 完全一致。
 *
 * 另有 basename 唯一性检查：客户端按 require 路径推导容器 key，同时登记 basename 别名
 * （`dyn/gamedata/[uc]lua/plugin/<basename>.bytes`），重名会导致模块互相覆盖。
 *
 * 本文件刻意为零 import 依赖（只读文件），避免为一个守卫拉起整张 app 模块图。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/** 仓库根（tests/unit/plugin → ../../..） */
const ROOT = join(__dirname, "..", "..", "..");
/** 插件源码根 */
const PLUGIN_ROOT = join(ROOT, "lua", "plugin");
/** 允许出现在根目录的文件（清单保留在根，服务端按固定路径解析） */
const ROOT_FILES = new Set(["PluginDefs.lua"]);
/** 允许的层目录 */
const LAYERS = ["core", "ui", "plugins"] as const;

interface LuaFile {
  /** 相对 lua/plugin 的 POSIX 路径（如 core/PluginManager.lua） */
  rel: string;
  /** 绝对路径 */
  full: string;
}

/** 递归收集 lua/plugin 下全部 .lua（含根） */
function collectLuaFiles(): LuaFile[] {
  const out: LuaFile[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".lua")) {
        out.push({ rel: relative(PLUGIN_ROOT, full).split(sep).join("/"), full });
      }
    }
  };
  walk(PLUGIN_ROOT);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/** require 路径 `Plugin/<rel>` → 源码相对路径 `<rel>.lua` */
function moduleToRel(mod: string): string | null {
  const prefix = "Plugin/";
  if (!mod.startsWith(prefix)) return null;
  return `${mod.slice(prefix.length)}.lua`;
}

const luaFiles = collectLuaFiles();
const relSet = new Set(luaFiles.map((f) => f.rel));

describe("Lua 插件目录布局守卫", () => {
  it("根目录只允许 PluginDefs.lua，层目录只有 core/ + ui/ + plugins/", () => {
    const rootEntries = readdirSync(PLUGIN_ROOT, { withFileTypes: true });
    const strayFiles: string[] = [];
    const dirs: string[] = [];
    for (const e of rootEntries) {
      if (e.isDirectory()) dirs.push(e.name);
      else if (!ROOT_FILES.has(e.name)) strayFiles.push(e.name);
    }
    expect(strayFiles, `根目录出现未归类文件（应移入 core/ ui/ plugins/）`).toEqual([]);
    expect(dirs.sort()).toEqual([...LAYERS].sort());
  });

  it("每个层目录只含扁平 .lua（不允许再嵌套子目录）", () => {
    for (const layer of LAYERS) {
      const dir = join(PLUGIN_ROOT, layer);
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        expect(e.isFile(), `${layer}/${e.name} 不是文件`).toBe(true);
        expect(e.name.endsWith(".lua"), `${layer}/${e.name} 不是 .lua`).toBe(true);
        expect(statSync(join(dir, e.name)).isFile()).toBe(true);
      }
    }
  });

  it("PluginDefs 登记的 module 全部指向 plugins/ 下的真实文件", () => {
    const src = readFileSync(join(PLUGIN_ROOT, "PluginDefs.lua"), "utf-8");
    const mods = [...src.matchAll(/module\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(mods.length).toBeGreaterThan(0);
    for (const mod of mods) {
      const rel = moduleToRel(mod);
      expect(rel, `module ${mod} 前缀必须是 Plugin/`).not.toBeNull();
      expect(relSet.has(rel as string), `module ${mod} 对应文件不存在`).toBe(true);
      expect(
        (rel as string).startsWith("plugins/"),
        `业务插件 ${mod} 必须放在 plugins/ 层`,
      ).toBe(true);
    }
  });

  it("源码内全部 require(\"Plugin/…\") 都能解析到真实文件", () => {
    const missing: string[] = [];
    for (const f of luaFiles) {
      const src = readFileSync(f.full, "utf-8");
      for (const m of src.matchAll(/require\s*\(?\s*["']([^"']+)["']/g)) {
        const dep = m[1].trim();
        if (!dep.startsWith("Plugin/")) continue;
        if (dep === "Plugin/PluginDefs") continue; // 清单本身
        const rel = moduleToRel(dep);
        if (rel === null || !relSet.has(rel)) missing.push(`${f.rel} -> require ${dep}`);
      }
    }
    expect(missing, `存在无法解析的 require：\n${missing.join("\n")}`).toEqual([]);
  });

  it("basename 全局唯一（客户端按 basename 归一化寻址）", () => {
    const byBase = new Map<string, string[]>();
    for (const f of luaFiles) {
      const base = f.rel.split("/").pop() as string;
      byBase.set(base, [...(byBase.get(base) ?? []), f.rel]);
    }
    const dup = [...byBase.entries()].filter(([, list]) => list.length > 1);
    expect(dup, `basename 冲突：${JSON.stringify(dup)}`).toEqual([]);
  });

  it("服务端 FALLBACK_CATALOG 的 module 与 PluginDefs.lua 完全一致（禁双份硬编码漂移）", () => {
    const defsSrc = readFileSync(join(PLUGIN_ROOT, "PluginDefs.lua"), "utf-8");
    const defsMods = [...defsSrc.matchAll(/module\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const catalogSrc = readFileSync(join(ROOT, "app", "ops", "plugin", "plugin-catalog.ts"), "utf-8");
    const fallbackBlock = catalogSrc.match(/FALLBACK_CATALOG[\s\S]*?\]\);/);
    expect(fallbackBlock, "未找到 FALLBACK_CATALOG 定义").not.toBeNull();
    const fallbackMods = [...(fallbackBlock?.[0] ?? "").matchAll(/module:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(fallbackMods).toEqual(defsMods);
  });

  it("PluginOptions 的条目 id 全部登记在 PluginDefs（禁孤儿选项页）", () => {
    const defsSrc = readFileSync(join(PLUGIN_ROOT, "PluginDefs.lua"), "utf-8");
    const defsIds = [...defsSrc.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const optionSrc = readFileSync(join(PLUGIN_ROOT, "core", "PluginOptions.lua"), "utf-8");
    // Defs 条目形如 `id = "…",` 后跟 `options = {`；文件内不存在其它 id 字符串字面量
    const orphan = [...optionSrc.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)]
      .map((m) => m[1])
      .filter((id) => !defsIds.includes(id));
    expect(orphan, `PluginOptions 里存在未登记的插件选项：${orphan.join(", ")}`).toEqual([]);
  });

  it("UI 入口守卫存在且接线正确（面板被隐藏后必须还能调出来）", () => {
    // 背景（2026-09-15 真实故障）：plugin_panel 与 options_panel 都被停用后，
    // 游戏内再无任何入口能重新打开它们（浮窗按钮随插件卸载销毁）。
    // 这条用例守的不是「某个字符串还在」，而是三处**结构性事实**：
    //   ① PluginDefs 有入口标记；② 管理器实现了裁决；③ 停用路径真的过这道裁决 + 启动自愈。
    const defsSrc = readFileSync(join(PLUGIN_ROOT, "PluginDefs.lua"), "utf-8");
    const uiEntries = [...defsSrc.matchAll(/\bid\s*=\s*["']([^"']+)["'][\s\S]{0,200}?ui_entry\s*=\s*true/g)].map(
      (m) => m[1],
    );
    expect(uiEntries.length, "PluginDefs 里没有任何 ui_entry 入口标记").toBeGreaterThan(0);

    const managerSrc = readFileSync(join(PLUGIN_ROOT, "core", "PluginManager.lua"), "utf-8");
    expect(managerSrc, "缺少 CanDisable 裁决函数").toMatch(/function PluginManager:CanDisable\(/);

    // 取出 SetEnabled 的函数体（到下一个顶层 function 定义为止），确认它调用了裁决
    const setEnabledBody = managerSrc.match(/function PluginManager:SetEnabled\([\s\S]*?\nend\n/);
    expect(setEnabledBody, "未找到 SetEnabled 实现").not.toBeNull();
    expect(setEnabledBody?.[0], "SetEnabled 未经过入口守卫").toContain("CanDisable");

    // 启动自愈：Init 必须调用 _EnsureUiEntry（否则「配置里入口全关」的死锁要等玩家手改文件）
    const initBody = managerSrc.match(/function PluginManager:Init\([\s\S]*?\n  self:_EnsureUiEntry\(\)/);
    expect(initBody, "Init 未做入口自愈（_EnsureUiEntry）").not.toBeNull();
  });

  it("服务器切换预设与选项 choices 逐项一致（value 契约）", () => {
    const pluginSrc = readFileSync(join(PLUGIN_ROOT, "plugins", "NetworkRedirectPlugin.lua"), "utf-8");
    const presetBlock = pluginSrc.match(/SERVER_PRESETS\s*=\s*\{([\s\S]*?)\n\}/);
    expect(presetBlock, "未找到 SERVER_PRESETS 定义").not.toBeNull();
    const presetValues = [...(presetBlock?.[1] ?? "").matchAll(/value\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(presetValues.length).toBeGreaterThan(0);

    const optionSrc = readFileSync(join(PLUGIN_ROOT, "core", "PluginOptions.lua"), "utf-8");
    const start = optionSrc.indexOf('id = "network_redirect"');
    expect(start, "PluginOptions 缺少 network_redirect 条目").toBeGreaterThanOrEqual(0);
    const tail = optionSrc.slice(start);
    const next = tail.indexOf('id = "', 1);
    const choiceBlock = next >= 0 ? tail.slice(0, next) : tail;
    const choiceValues = [...choiceBlock.matchAll(/value\s*=\s*"([^"]+)"/g)].map((m) => m[1]);

    expect(choiceValues).toEqual(presetValues);
  });
});
