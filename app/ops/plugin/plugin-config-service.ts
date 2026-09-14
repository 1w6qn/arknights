/**
 * 插件配置服务：管理 Lua 插件的启用状态与选项取值，并持久化到 data/plugin/config.json。
 *
 * 该配置面向游戏内 Lua 插件系统（见 lua/plugin/），供 admin 端点与 Dashboard 使用。
 * 插件清单与 lua/plugin/PluginDefs.lua 保持一致（id/name/desc）；
 * 选项取值由客户端「选项面板」经 /plugin/option/... 推送，服务端只做标量合法性校验
 * （选项定义域在 lua/plugin/PluginOptions.lua，服务端不重复维护）。
 */
import { join } from "path";
import { mkdir } from "fs/promises";
import { exists, readJson, writeJson } from "@utils/file";
import { logger } from "@utils/logger";
import { loadPluginCatalog, type PluginCatalogEntry } from "./plugin-catalog";

/** 插件目录（相对项目根） */
const PLUGIN_DIR = join(__dirname, "..", "..", "..", "data", "plugin");
/** 配置文件路径 */
const PLUGIN_CONFIG_PATH = join(PLUGIN_DIR, "config.json");

/** 插件定义（与 lua/plugin/PluginDefs.lua 保持一致，由单一数据源解析） */
export type PluginDefinition = PluginCatalogEntry;

/** 插件选项取值（标量；与 lua/plugin/PluginOptions.lua 的取值域一致） */
export type PluginOptionValue = boolean | number | string;

/** 持久化配置结构 */
interface PluginConfig {
  enabled: Record<string, boolean>;
  options: Record<string, Record<string, PluginOptionValue>>;
}

/** 选项键约束：字母/下划线开头，≤32 字符（与 Lua 侧持久化键名一致） */
const OPTION_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
/** 单插件选项键数量上限（防脏配置无限膨胀） */
const OPTION_KEYS_LIMIT = 64;
/** 字符串选项值长度上限 */
const OPTION_STRING_LIMIT = 64;
/** 数值选项值绝对值上限 */
const OPTION_NUMBER_LIMIT = 1e9;

/**
 * 磁盘 JSON 反序列化后的值视图（递归联合）。
 * 刻意不用 `unknown`/`object`：本仓类型债棘轮对模糊类型逐文件只紧不松，
 * 而这份结构足以为校验函数提供静态收窄。
 */
type RawJsonValue =
  | boolean
  | number
  | string
  | null
  | undefined
  | RawJsonValue[]
  | { [key: string]: RawJsonValue };

/**
 * 判断是否为合法选项键。
 * @param key - 待判定键名
 * @returns 合法返回 true
 */
export function isValidOptionKey(key: string): boolean {
  return OPTION_KEY_RE.test(key);
}

/**
 * 判断是否为合法选项值（布尔 / 有限数值 / 短字符串，拒绝控制字符）。
 * @param value - 待判定值
 * @returns 合法返回 true
 */
export function isValidOptionValue(value: RawJsonValue): value is PluginOptionValue {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= OPTION_NUMBER_LIMIT;
  }
  if (typeof value === "string") {
    return value.length > 0 && value.length <= OPTION_STRING_LIMIT && !/[\u0000-\u001f]/.test(value);
  }
  return false;
}

/**
 * 清洗磁盘上的选项配置：丢弃非法键名 / 非法值 / 结构错误的条目。
 * @param raw - 原始 options 字段
 * @returns 清洗后的选项配置
 */
function sanitizeOptions(raw: RawJsonValue): Record<string, Record<string, PluginOptionValue>> {
  const out: Record<string, Record<string, PluginOptionValue>> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, values] of Object.entries(raw)) {
    if (values === null || typeof values !== "object" || Array.isArray(values)) continue;
    const entry: Record<string, PluginOptionValue> = {};
    for (const [key, value] of Object.entries(values)) {
      if (Object.keys(entry).length >= OPTION_KEYS_LIMIT) break;
      if (!isValidOptionKey(key) || !isValidOptionValue(value)) continue;
      entry[key] = value;
    }
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

/**
 * 插件配置服务单例。
 * 负责读写插件启用状态，读写异常时回退全启用默认值，保证不阻断管理接口。
 * 插件目录来自 lua/plugin/PluginDefs.lua（单一数据源），见 ./plugin-catalog。
 */
export class PluginConfigService {
  private readonly configPath: string;
  private cache: PluginConfig | null = null;
  /** 插件目录（懒加载） */
  private catalog: PluginDefinition[] | null = null;

  /**
   * 构造服务实例。
   * @param configPath - 配置文件路径（默认 data/plugin/config.json，测试可注入临时路径）
   */
  constructor(configPath: string = PLUGIN_CONFIG_PATH) {
    this.configPath = configPath;
  }

  /**
   * 返回插件目录（懒加载，解析失败回退内置目录）。
   * @returns 插件目录条目
   */
  private getCatalog(): PluginDefinition[] {
    if (this.catalog === null) {
      this.catalog = loadPluginCatalog();
    }
    return this.catalog;
  }

  /**
   * 清空内存缓存（供测试重置或配置热更新后重建）。
   */
  reset(): void {
    this.cache = null;
    this.catalog = null;
  }

  /**
   * 读取并缓存配置；文件不存在或损坏时回退全启用默认值。
   * @returns 配置对象
   */
  private async load(): Promise<PluginConfig> {
    if (this.cache) return this.cache;
    const defaults: PluginConfig = { enabled: {}, options: {} };
    for (const def of this.getCatalog()) {
      defaults.enabled[def.id] = true;
    }
    try {
      if (await exists(this.configPath)) {
        const raw = await readJson<Partial<PluginConfig>>(this.configPath);
        if (raw && raw.enabled && typeof raw.enabled === "object") {
          for (const def of this.getCatalog()) {
            if (typeof raw.enabled[def.id] === "boolean") {
              defaults.enabled[def.id] = raw.enabled[def.id];
            }
          }
        }
        if (raw && raw.options) {
          defaults.options = sanitizeOptions(raw.options);
        }
      }
    } catch (error) {
      logger.warn("Plugin", "读取插件配置失败，回退默认", error);
    }
    this.cache = defaults;
    return defaults;
  }

  /**
   * 原子写入配置到磁盘（先建目录再写）。
   * @param config - 待持久化的配置
   */
  private async persist(config: PluginConfig): Promise<void> {
    await mkdir(join(this.configPath, ".."), { recursive: true });
    await writeJson(this.configPath, config);
    this.cache = config;
  }

  /**
   * 返回全部插件定义及启用状态（保持目录顺序）。
   * @returns 插件列表（含 enabled）
   */
  async getAll(): Promise<(PluginDefinition & { enabled: boolean })[]> {
    const config = await this.load();
    return this.getCatalog().map((def) => ({
      ...def,
      enabled: config.enabled[def.id] === true,
    }));
  }

  /**
   * 查询插件是否启用；未配置（含目录外的未知 id）返回 false。
   * @param id - 插件标识
   * @returns 是否启用
   */
  async isEnabled(id: string): Promise<boolean> {
    const config = await this.load();
    return config.enabled[id] === true;
  }

  /**
   * 查询插件是否存在于目录。
   * @param id - 插件标识
   * @returns 存在返回 true
   */
  has(id: string): boolean {
    return this.getCatalog().some((def) => def.id === id);
  }

  /**
   * 设置插件启用状态并持久化（幂等）。
   * @param id    - 插件标识
   * @param value - true 启用 / false 停用
   * @returns 更新后的启用状态
   * @throws 插件 id 不存在时抛错
   */
  async setEnabled(id: string, value: boolean): Promise<boolean> {
    if (!this.has(id)) {
      throw new Error(`未知插件: ${id}`);
    }
    const config = await this.load();
    config.enabled[id] = value;
    await this.persist(config);
    return value;
  }

  /**
   * 返回全部插件的选项取值（含目录外的历史残留，便于排查）。
   * @returns 选项取值（插件 id → 选项键 → 值）
   */
  async getAllOptions(): Promise<Record<string, Record<string, PluginOptionValue>>> {
    const config = await this.load();
    return config.options;
  }

  /**
   * 返回指定插件的选项取值；无记录返回空对象。
   * @param id - 插件标识
   * @returns 选项取值（选项键 → 值）
   */
  async getOptions(id: string): Promise<Record<string, PluginOptionValue>> {
    const config = await this.load();
    return config.options[id] ?? {};
  }

  /**
   * 写入插件选项值并持久化（幂等）。
   * @param id    - 插件标识
   * @param key   - 选项键
   * @param value - 选项值（布尔 / 有限数值 / 短字符串）
   * @returns 写入的值
   * @throws 插件不存在 / 键名非法 / 值非法 / 单插件选项数量超限时抛错
   */
  async setOption(id: string, key: string, value: PluginOptionValue): Promise<PluginOptionValue> {
    if (!this.has(id)) {
      throw new Error(`未知插件: ${id}`);
    }
    if (!isValidOptionKey(key)) {
      throw new Error(`非法选项键: ${key}`);
    }
    if (!isValidOptionValue(value)) {
      throw new Error(`非法选项值: ${key}`);
    }
    const config = await this.load();
    const entry = config.options[id] ?? {};
    if (entry[key] === undefined && Object.keys(entry).length >= OPTION_KEYS_LIMIT) {
      throw new Error(`选项数量超限: ${id}`);
    }
    entry[key] = value;
    config.options[id] = entry;
    await this.persist(config);
    return value;
  }
}

/** 单例实例 */
export const pluginConfigService = new PluginConfigService();

/** 供测试重置缓存 */
export function __resetPluginConfigService(): void {
  pluginConfigService.reset();
}