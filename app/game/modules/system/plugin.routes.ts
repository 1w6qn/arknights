/**
 * 插件心跳（heartbeat）路由
 *
 * 客户端 Lua 插件系统引导成功后（各插件经 DefinedFix 管线加载，PluginManager 聚合），
 * 由 PluginHeartbeat 向此端点发送生效确认，
 * 服务端记录日志并在响应中回传插件目录、启用状态与选项取值——用于真机验证
 * 「插件是否真正加载」，并让客户端 best-effort 应用服务端状态
 * （见 lua/plugin/core/PluginHeartbeat.lua）。
 *
 * GET /plugin/heartbeat
 *  - 成功：200 { status: 0, pluginCount, enabled, catalog, options }
 *  - 记录 logger.info("PluginHeartbeat", ...) 供服务端日志确认
 *
 * GET /plugin/config/:id/:value
 *  - 客户端启停状态同步（路径编码：value=0 停用 / 1 启用），持久化到
 *    data/plugin/config.json（管理端与面板的启停状态经此收敛到同一配置源）。
 *
 * GET /plugin/option/:id/:key/:value
 *  - 客户端选项取值同步（路径编码：b1/b0 布尔、n<数字>、s<URL 编码字符串>），
 *    持久化到同一配置文件的 options 字段；服务端只校验标量合法性，
 *    选项定义域见 lua/plugin/core/PluginOptions.lua。
 */
import { Router } from "express";
import { logger } from "@utils/logger";
import { pluginConfigService, type PluginOptionValue } from "@plugin/index";
import { buildPluginLuaChunk } from "@plugin/lua-chunk-builder";

const router = Router();

/**
 * 解码客户端路径编码的选项值（与 PluginHeartbeat.lua 的 _EncodeOption 对应）。
 * @param raw - 路径段（b0/b1/n<数字>/s<字符串>）
 * @returns 解码后的选项值；编码非法返回 null
 */
function decodeOptionValue(raw: string): PluginOptionValue | null {
  if (raw === "b0") return false;
  if (raw === "b1") return true;
  if (raw.startsWith("n")) {
    const text = raw.slice(1);
    if (text.length === 0) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  if (raw.startsWith("s")) {
    const text = raw.slice(1);
    return text.length > 0 ? text : null;
  }
  return null;
}

/** 插件生效确认端点 */
router.get("/heartbeat", async (req, res) => {
  const list = await pluginConfigService.getAll();
  const options = await pluginConfigService.getAllOptions();
  const enabledCount = list.filter((p) => p.enabled).length;
  logger.info(
    "PluginHeartbeat",
    `客户端插件系统生效确认: 共 ${list.length} 个插件，启用 ${enabledCount} 个（${list
      .map((p) => `${p.id}=${p.enabled ? "ON" : "OFF"}`)
      .join(", ")}）`,
  );
  res.json({
    status: 0,
    result: 0,
    pluginCount: list.length,
    enabled: enabledCount,
    catalog: list.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })),
    options,
    serverTime: Date.now(),
  });
});

/**
 * 插件 Lua 源码下发端点。
 *
 * 场景：资产内只留一段几百字节的引导（装不下 ~60KB 插件源码），引导在运行时
 * `UISender.me:SendGet("/plugin/lua")` 取回本端点返回的自包含 chunk 再 `load()` 执行
 * ——于是插件系统完全由「资产内引导 + 私服下发」交付，无需 frida 注入 Lua。
 * 响应体是 JSON（游戏网络层自动解析成 table），chunk 在 `lua` 字段里。
 */
router.get("/lua", (req, res) => {
  try {
    const built = buildPluginLuaChunk();
    logger.info(
      "PluginLua",
      `下发插件 Lua chunk（${built.modules.length} 个模块，${built.lua.length}B，version=${built.version}）`,
    );
    res.json({ status: 0, result: 0, version: built.version, modules: built.modules, lua: built.lua });
  } catch (error) {
    logger.error("PluginLua", `插件 Lua chunk 构建失败: ${(error as Error).message}`);
    res.status(500).json({ status: 1, msg: "plugin lua build failed" });
  }
});

/** 客户端插件启停状态同步端点（路径编码，匹配 PluginHeartbeat.PushState） */
router.get("/config/:id/:value", async (req, res) => {
  const id = String(req.params.id ?? "");
  const value = String(req.params.value ?? "");
  if (!pluginConfigService.has(id)) {
    res.json({ status: 1, msg: `未知插件: ${id}` });
    return;
  }
  if (value !== "0" && value !== "1") {
    res.json({ status: 1, msg: "value 必须为 0 或 1" });
    return;
  }
  try {
    await pluginConfigService.setEnabled(id, value === "1");
  } catch (error) {
    // 典型场景：客户端试图关掉最后一个 UI 入口面板（被入口守卫拒绝）。
    // 返回业务失败而不是让它冒成 500：这是**预期内**的拒绝，客户端据此保持启用态。
    logger.warn(
      "PluginHeartbeat",
      `客户端插件状态同步被拒: ${id}=${value} → ${error instanceof Error ? error.message : String(error)}`,
    );
    res.json({ status: 1, result: -1, msg: error instanceof Error ? error.message : String(error) });
    return;
  }
  logger.info("PluginHeartbeat", `客户端插件状态同步: ${id}=${value === "1" ? "ON" : "OFF"}`);
  res.json({ status: 0, result: 0 });
});

/** 客户端插件选项同步端点（路径编码，匹配 PluginHeartbeat.PushOption） */
router.get("/option/:id/:key/:value", async (req, res) => {
  const id = String(req.params.id ?? "");
  const key = String(req.params.key ?? "");
  const raw = String(req.params.value ?? "");
  if (!pluginConfigService.has(id)) {
    res.json({ status: 1, msg: `未知插件: ${id}` });
    return;
  }
  const value = decodeOptionValue(raw);
  if (value === null) {
    res.json({ status: 1, msg: "value 编码非法（应为 b0/b1/n<数字>/s<字符串>）" });
    return;
  }
  try {
    await pluginConfigService.setOption(id, key, value);
  } catch (error) {
    res.json({ status: 1, msg: error instanceof Error ? error.message : String(error) });
    return;
  }
  logger.info("PluginHeartbeat", `客户端插件选项同步: ${id}.${key}=${String(value)}`);
  res.json({ status: 0, result: 0 });
});

export default router;
