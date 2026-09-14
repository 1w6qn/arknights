/**
 * 插件配置服务：管理 Lua 插件的启用状态，并持久化到 data/plugin/config.json。
 *
 * 该配置面向游戏内 Lua 插件系统（见 lua/plugin/），供 admin 端点与 Dashboard 使用。
 * 插件清单与 lua/plugin/PluginDefs.lua 保持一致（id/name/desc）。
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

/** 持久化配置结构 */
interface PluginConfig {
  enabled: Record<string, boolean>;
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
    const defaults: PluginConfig = { enabled: {} };
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
}

/** 单例实例 */
export const pluginConfigService = new PluginConfigService();

/** 供测试重置缓存 */
export function __resetPluginConfigService(): void {
  pluginConfigService.reset();
}