/**
 * 插件心跳（heartbeat）路由
 *
 * 客户端 Lua 插件系统引导成功后（各插件经 DefinedFix 管线加载，PluginManager 聚合），
 * 由 PluginHeartbeat 向此端点发送生效确认，
 * 服务端记录日志并在响应中回传插件目录与启用状态——用于真机验证「插件是否真正加载」，
 * 并让客户端 best-effort 应用服务端启停状态（见 lua/plugin/PluginHeartbeat.lua）。
 *
 * GET /plugin/heartbeat
 *  - 成功：200 { status: 0, pluginCount, enabled, catalog }
 *  - 记录 logger.info("PluginHeartbeat", ...) 供服务端日志确认
 *
 * GET /plugin/config/:id/:value
 *  - 客户端启停状态同步（路径编码：value=0 停用 / 1 启用），持久化到
 *    data/plugin/config.json（管理端与面板的启停状态经此收敛到同一配置源）。
 */
import { Router } from "express";
import { logger } from "@utils/logger";
import { pluginConfigService } from "@plugin/index";

const router = Router();

/** 插件生效确认端点 */
router.get("/heartbeat", async (req, res) => {
  const list = await pluginConfigService.getAll();
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
    serverTime: Date.now(),
  });
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
  await pluginConfigService.setEnabled(id, value === "1");
  logger.info("PluginHeartbeat", `客户端插件状态同步: ${id}=${value === "1" ? "ON" : "OFF"}`);
  res.json({ status: 0, result: 0 });
});

export default router;
