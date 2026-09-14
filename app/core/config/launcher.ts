/**
 * 启动器（Launcher）路由
 *
 * 提供游戏启动器的版本检查接口：客户端启动器请求 /api/game/get_latest
 * 检查是否需要下载更新包。私服返回 action:0 + 空包（无需更新），
 * 客户端直接启动游戏客户端（client_version 指向本地配置的游戏版本）。
 *
 * 响应结构参考官服抓包（2026-08-07，ak-hg 启动器 get_latest 响应）。
 */
import { Router } from "express";
import config from "./index";

const router = Router();

/**
 * 启动器版本检查
 *
 * 官方响应语义：
 * - action: 0 = 无动作（不需要下载更新）
 * - pkg.packs: [] = 空更新包
 * - state: 0 = 正常
 * - client_version: 游戏客户端版本（私服返回 config.version.clientVersion，启动器据此拉起游戏）
 *
 * @route GET /api/game/get_latest
 * @param version - 启动器自身版本（如 76.0.0）
 * @returns 启动器更新信息
 */
router.get("/get_latest", async (req, res) => {
  const launcherVersion = String(req.query.version ?? "76.0.0");
  const subChannel = String(req.query.sub_channel ?? "1");
  res.send({
    action: 0,
    version: launcherVersion,
    request_version: launcherVersion,
    pkg: {
      packs: [],
      total_size: "0",
      file_path: "",
      url: "",
      md5: "",
      package_size: "0",
      file_id: "0",
      sub_channel: subChannel,
      game_files_md5: "86f10402f2abeb283624ae90f4a0063a",
    },
    patch: null,
    state: 0,
    launcher_action: 0,
    pre_patch: null,
    client_version: config.version.clientVersion,
  });
});


/**
 * 游戏版本信息（HGGameUpdateSDK.GetLatestGame 调用，game 侧热更门禁）。
 *
 * ⚠️ 不可返回 `{}`：客户端会解析出空 version + action=3，随后**静默卡死**——
 * network_config / version / hot_update_list 一概不再请求（实测 2026-09-14：私服返回 `{}`
 * 后客户端 140s 无任何请求，本地 Bundles/hot_update_list.json 与 persistent_res_list.json
 * 完全未更新；同一客户端在门禁放行的那一轮才会走到热更）。
 *
 * 官方响应（game 侧抓包，2026-09-13）：`version` 回显请求里的 version（游戏包版本，如 77.0.0），
 * code/updateType/state 全 0 表示"无更新、状态正常"。
 *
 * @route GET /api/game/get_latest_game_info
 * @param version - 游戏包版本（客户端带上来的 version，如 77.0.0）
 * @returns 游戏版本信息（code/version/updateType/state）
 */
router.get("/get_latest_game_info", async (req, res) => {
  res.send({
    code: 0,
    version: String(req.query.version ?? ""),
    updateType: 0,
    updateInfo: "",
    state: 0,
  });
});

/** 其余 /api/game/<subpath>（ODPY 对齐 catch-all，stub） */
router.get("*splat", async (_req, res) => {
  res.send({});
});

export default router;
