/**
 * 插件目录解析器（单一数据源）
 *
 * 以 lua/plugin/PluginDefs.lua 为唯一来源，解析插件目录（id/name/desc/module），
 * 供 PluginConfigService 使用，消除服务端 PLUGIN_CATALOG 与 Lua 侧清单的双份硬编码漂移。
 *
 * 解析策略：按「条目块」提取，字段顺序无关、空白宽容，并先剔除 Lua 注释
 * （避免注释中的假条目被解析）。要求 id 与 module 存在，其余字段缺省回退。
 */
import * as fs from "fs";
import * as path from "path";
import { logger } from "@utils/logger";

/** 插件目录条目 */
export interface PluginCatalogEntry {
  id: string;
  name: string;
  desc: string;
  /** 客户端 require 路径（如 Plugin/plugins/EnemyHpPlugin） */
  module: string;
  /**
   * 是否为「游戏内 UI 入口」插件（PluginDefs 的 `ui_entry = true`）。
   *
   * 语义：这些插件提供**游戏内**的面板/浮动按钮，是玩家在游戏里启停插件的唯一途径。
   * 因此至少要保留一个启用（全关 = 游戏内再无入口，只能改配置文件或走服务端恢复），
   * 服务端与客户端两侧都有对应守卫。
   */
  uiEntry?: boolean;
}

/** 内置回退目录（解析失败时使用，保持与 lua/plugin/PluginDefs.lua 一致） */
export const FALLBACK_CATALOG: readonly PluginCatalogEntry[] = Object.freeze([
  { id: "enemy_hp", name: "敌人血量显示", desc: "在敌人血条旁显示具体血量数值", module: "Plugin/plugins/EnemyHpPlugin" },
  { id: "enemy_info", name: "敌人属性面板", desc: "战斗中长按并点击敌人查看属性与路线", module: "Plugin/plugins/EnemyInfoPlugin" },
  { id: "battle_assist", name: "战斗辅助", desc: "战斗时间轴 / 倍速 / TAS 暂停帧", module: "Plugin/plugins/BattleAssistPlugin" },
  { id: "plugin_panel", name: "插件管理面板", desc: "现代化插件启停管理面板", module: "Plugin/plugins/PanelPlugin", uiEntry: true },
  { id: "options_panel", name: "插件选项面板", desc: "游戏内调节各插件参数（开关/数值/枚举）并同步服务端", module: "Plugin/plugins/OptionsPanelPlugin", uiEntry: true },
  { id: "network_redirect", name: "网络重定向", desc: "把官服域名请求重定向到私服地址", module: "Plugin/plugins/NetworkRedirectPlugin" },
]);

/**
 * 剔除 Lua 注释（块注释 --[[...]] 与行注释 --...），避免注释中的假条目被解析。
 * PluginDefs 为纯数据表，字符串值不含 "--"，此简化处理安全。
 * @param content - PluginDefs.lua 源码文本
 * @returns 剔除注释后的文本
 */
function stripLuaComments(content: string): string {
  return content
    .replace(/--\[\[[\s\S]*?\]\]/g, " ")
    .replace(/--[^\r\n]*/g, " ");
}

/** 单个条目块：{ ... }（插件清单为扁平表，条目内不含嵌套花括号） */
const BLOCK_RE = /\{\s*((?:[^{}])*?)\s*\}/g;

/** 条目内字段：key = "value" 或 key = 'value'（顺序无关） */
const FIELD_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'])(.*?)\2/g;

/** 条目内布尔字段：key = true / false（如 `ui_entry = true`） */
const BOOL_FIELD_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(true|false)\b/g;

/**
 * 从 PluginDefs.lua 文本解析插件目录（字段顺序无关；id/module 缺失的条目跳过）。
 * @param content - PluginDefs.lua 源码文本
 * @returns 插件目录条目列表（按出现顺序）
 */
export function parsePluginDefs(content: string): PluginCatalogEntry[] {
  const out: PluginCatalogEntry[] = [];
  const clean = stripLuaComments(content);
  BLOCK_RE.lastIndex = 0;
  let bm: RegExpExecArray | null;
  while ((bm = BLOCK_RE.exec(clean)) !== null) {
    const block = bm[1];
    const fields: Record<string, string> = {};
    FIELD_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FIELD_RE.exec(block)) !== null) {
      // fm[1]=key, fm[2]=引号, fm[3]=值
      fields[fm[1]] = fm[3];
    }
    // 布尔字段单独扫：`ui_entry = true` 的右侧没有引号，上面那条正则抓不到
    let uiEntry: boolean | undefined;
    BOOL_FIELD_RE.lastIndex = 0;
    let boolMatch: RegExpExecArray | null;
    while ((boolMatch = BOOL_FIELD_RE.exec(block)) !== null) {
      if (boolMatch[1] === "ui_entry") {
        uiEntry = boolMatch[2] === "true";
      }
    }
    const id = fields.id;
    const module = fields.module;
    if (!id || !module) continue;
    const entry: PluginCatalogEntry = { id, name: fields.name || id, desc: fields.desc || "", module };
    if (uiEntry === true) {
      entry.uiEntry = true;
    }
    out.push(entry);
  }
  return out;
}

/**
 * 加载插件目录：读取 PluginDefs.lua 并解析。
 * 文件缺失或解析结果为空时回退内置目录，保证服务端不因目录异常而不可用。
 * @param luaPath - PluginDefs.lua 绝对路径（缺省 <项目根>/lua/plugin/PluginDefs.lua）
 * @returns 插件目录
 */
export function loadPluginCatalog(luaPath?: string): PluginCatalogEntry[] {
  const file = luaPath ?? path.join(__dirname, "..", "..", "..", "lua", "plugin", "PluginDefs.lua");
  try {
    if (fs.existsSync(file)) {
      const parsed = parsePluginDefs(fs.readFileSync(file, "utf-8"));
      if (parsed.length > 0) {
        return parsed;
      }
      logger.warn("Plugin", `PluginDefs.lua 解析结果为空（${file}），使用内置目录`);
    }
  } catch (error) {
    logger.warn("Plugin", `读取 PluginDefs.lua 失败（${file}），使用内置目录`, error);
  }
  return [...FALLBACK_CATALOG];
}
