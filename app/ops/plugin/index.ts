/**
 * 插件服务模块出口。
 * 统一导出 PluginConfigService、单例与插件目录解析，供 admin 路由等使用；
 * 另导出 Unity 日志回传存储（客户端日志回流，见 plugin-log-store.ts）。
 */
export {
  PluginConfigService,
  pluginConfigService,
  __resetPluginConfigService,
  isValidOptionKey,
  isValidOptionValue,
  type PluginDefinition,
  type PluginOptionValue,
} from "./plugin-config-service";
export { loadPluginCatalog, parsePluginDefs, FALLBACK_CATALOG, type PluginCatalogEntry } from "./plugin-catalog";
export {
  PluginLogStore,
  pluginLogStore,
  PLUGIN_LOG_DIR,
  type UnityLogRecord,
  type UnityLogSessionInfo,
  type UnityLogQuery,
  type UnityLogStats,
} from "./plugin-log-store";
export {
  ensureLuaModBuilt,
  ensureLuaMinModBuilt,
  isLuaModStale,
  BUILTIN_LUA_MOD_NAME,
  type LuaModBuildResult,
  type LuaModBuildOptions,
} from "./lua-mod-builder";