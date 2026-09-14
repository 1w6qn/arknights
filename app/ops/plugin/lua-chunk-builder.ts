/**
 * Lua 插件源码打包器：把 `lua/plugin/*.lua` 打成一个**自包含 Lua chunk**。
 *
 * 为什么需要它：内置 Lua bundle 里最大的 TextAsset 明文只有约 33KB，而插件源码合计约 60KB
 * ——一个资产装不下。于是改成「引导很小、源码走网络」：
 *   APK/资产内只留一段几百字节的引导 → 运行时 `UISender.me:SendGet("/plugin/lua")`
 *   取回本模块生成的 chunk → `load()` 执行。
 *
 * chunk 的结构与 frida 侧注入 payload 一致（`hook/il2cpp-client-redirect.ts#buildLuaPayload`）：
 *   1) 内联全部模块源码（键 = Lua 的 require 路径，如 `Plugin/PluginDefs`）；
 *   2) 装一个只认 `Plugin/*` 的 searcher；
 *   3) 按插件自己的引导顺序 require（`_G.PluginDefs` → `PluginManager` → `PluginEntry` → `PluginHeartbeat`）；
 *   4) `PluginEntry.init()` + `PluginHeartbeat.ScheduleAuto()`，并返回自检结论字符串
 *      （`DTS_PLUGIN_OK <各插件>=1 …`），便于调用方写日志/落盘核对。
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** 插件源码目录（仓库根 `lua/plugin`）。 */
function pluginDir(): string {
  return path.join(__dirname, "..", "..", "..", "lua", "plugin");
}

/**
 * 读插件模块源码表。
 * @returns 顺序稳定的 `require 路径 → 源码` 映射
 */
function readModules(): { name: string; source: string }[] {
  const dir = pluginDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".lua"))
    .sort();
  return files.map((f) => ({
    name: `Plugin/${f.slice(0, -".lua".length)}`,
    source: fs.readFileSync(path.join(dir, f), "utf-8"),
  }));
}

/**
 * 选一个在全部源码里都不出现的长括号分隔级别（`[===…[` / `]===…]`）。
 * @param sources - 模块源码
 * @returns 级别（等号个数）
 */
function pickLevel(sources: string[]): number {
  for (let level = 1; level <= 12; level += 1) {
    const close = `]${"=".repeat(level)}]`;
    if (!sources.some((s) => s.includes(close))) return level;
  }
  throw new Error("插件源码里出现了 12 级长括号闭合串，无法安全内联");
}

/** 打包结果 */
export interface PluginLuaChunk {
  /** 可直接 `load()` 的 Lua chunk 源码 */
  lua: string;
  /** 内含模块名 */
  modules: string[];
  /** 内容指纹（模块名 + 源码 md5，用于日志/缓存校验） */
  version: string;
}

/**
 * 生成自包含插件 chunk。
 * @returns chunk 源码 + 模块清单 + 指纹
 */
export function buildPluginLuaChunk(): PluginLuaChunk {
  const modules = readModules();
  if (modules.length === 0) throw new Error(`插件目录为空：${pluginDir()}`);
  const level = pickLevel(modules.map((m) => m.source));
  const open = `[${"=".repeat(level)}[`;
  const close = `]${"=".repeat(level)}]`;
  const lines: string[] = [
    "-- DoctorateTs Lua 插件系统（服务端下发，canonical 见 app/ops/plugin/lua-chunk-builder.ts）",
    "local SRC = {",
  ];
  for (const m of modules) {
    lines.push(`  [${JSON.stringify(m.name)}] = ${open}${m.source}${close},`);
  }
  lines.push(
    "}",
    "local searchers = package.searchers or package.loaders",
    "local function dts_searcher(name)",
    "  local code = SRC[name]",
    '  if code == nil then return "\\n\\tno DoctorateTs module \'" .. name .. "\'" end',
    '  local chunk, err = load(code, "@" .. name)',
    '  if chunk == nil then return "\\n\\tDoctorateTs module \'" .. name .. "\' load error: " .. tostring(err) end',
    "  return chunk",
    "end",
    "table.insert(searchers, 1, dts_searcher)",
    "local ok, err = xpcall(function()",
    '  _G.PluginDefs = require "Plugin/PluginDefs"',
    '  _G.PluginManager = require "Plugin/PluginManager"',
    '  _G.PluginEntry = require "Plugin/PluginEntry"',
    '  _G.PluginHeartbeat = require "Plugin/PluginHeartbeat"',
    "  PluginEntry.init()",
    "  PluginHeartbeat.ScheduleAuto()",
    "end, debug.traceback)",
    'local detail = ""',
    "if ok then",
    "  local parts = {}",
    "  for _, def in ipairs(PluginDefs) do",
    '    parts[#parts + 1] = def.id .. (PluginManager.me:GetPlugin(def.id) ~= nil and "=1" or "=0")',
    "  end",
    '  detail = " " .. table.concat(parts, " ")',
    "end",
    'local out = ok and ("DTS_PLUGIN_OK" .. detail) or ("DTS_PLUGIN_ERR: " .. tostring(err))',
    "xpcall(function()",
    '  local p = CS.UnityEngine.Application.persistentDataPath .. "/plugin_lua_trace.txt"',
    '  CS.Torappu.FileUtil.WriteToFile("[DTS-http] " .. out, p, true)',
    "end, function() end)",
    "return out",
  );
  const version = crypto
    .createHash("md5")
    .update(modules.map((m) => `${m.name}:${m.source}`).join("\n"))
    .digest("hex")
    .slice(0, 12);
  return { lua: lines.join("\n"), modules: modules.map((m) => m.name), version };
}
