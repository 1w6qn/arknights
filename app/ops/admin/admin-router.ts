/**
 * 管理 REST API 路由
 *
 * API 前缀 /admin/api，需通过 adminAuth 认证。
 * Dashboard 页面 /admin/dashboard 免认证（登录在页面内完成）。
 */
import { Router, Request, Response } from "express";
import path from "path";
import { adminService } from "./admin-service";
import { adminAuth } from "./admin-auth";
import { ADMIN_ENDPOINTS } from "./api-spec";
import { buildOpenApi } from "./openapi";
import config from "../../core/config";
import { captureManager } from "@capture/capture-manager";
import { logService } from "@logs/log-service";
import { assetRegistry } from "@asset/asset-service";
import { createSse, sseSend } from "@utils/sse";
import { pluginConfigService } from "@plugin/index";
import { validateBody } from "@core/http/validate-body";
import { isOfficialAction } from "./official-ops";
import {
  arkhubImportPetsSchema,
  backfillAssetsSchema,
  buildingAdvanceSchema,
  buildingMaxSchema,
  captureClearSchema,
  charModuleSchema,
  cliExecSchema,
  createBackupSchema,
  createCaptureSessionSchema,
  createUserSchema,
  deleteCaptureRecordSchema,
  deleteCaptureSessionSchema,
  deleteMailSchema,
  deletePixelArtSchema,
  deleteUserSchema,
  disablePluginSchema,
  doCheckInSchema,
  emptyObjectSchema,
  enablePluginSchema,
  exportUserSchema,
  gameProxySchema,
  grantAllItemsSchema,
  grantCharSchema,
  grantItemSchema,
  grantSkinSchema,
  importUserSchema,
  listPixelArtSchema,
  logClearSchema,
  maxAllCharsSchema,
  maxOutAccountSchema,
  migrateOfficialSchema,
  officialActionSchema,
  officialCallSchema,
  pushMessageSchema,
  refreshUserSchema,
  repairCharsSchema,
  resetCheckInSchema,
  restoreSchema,
  rogueSimAutoSchema,
  rogueSimStepSchema,
  rogueModifySchema,
  saveUserSchema,
  sendMailAllSchema,
  sendMailSchema,
  setCharAttrsSchema,
  setPlayerPitySchema,
  setPlayerPoolUpSchema,
  stopCaptureSessionSchema,
  switchActivitySchema,
  syncGachaPoolSchema,
  unlockAllStagesSchema,
  unlockStageSchema,
  uploadPixelArtSchema,
  setUserDisabledSchema,
} from "./admin.schema";

const router = Router();

/** Express 查询参数值（叶子/数组/嵌套对象；缺省 undefined） */
type QueryParam = Request["query"][string];

/** 查询参数 → 字符串（缺省/空串 → undefined） */
function queryStr(v: QueryParam): string | undefined {
  return v === undefined || v === "" ? undefined : String(v);
}

/** 查询参数 → 有限数字（缺省/空串/非有限数 → undefined） */
function queryNum(v: QueryParam): number | undefined {
  const n = v === undefined || v === "" ? undefined : Number(v);
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

/** Dashboard 静态页面（免认证，页面内输入令牌后访问 API） */
router.get(["/", "/dashboard"], (_req: Request, res: Response) => {
  // 单文件页面无版本号：禁止缓存，避免浏览器拿到旧版（新增功能不生效）
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  // 用 process.cwd() 而非 __dirname，兼容 ts-node 与 tsc build 产物
  res.sendFile(path.join(process.cwd(), "app", "ops", "admin", "dashboard", "index.html"));
});

/** PWA manifest / 图标（可安装到主屏幕） */
router.get("/manifest.webmanifest", (_req: Request, res: Response) => {
  res.set("Content-Type", "application/manifest+json");
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(process.cwd(), "app", "ops", "admin", "dashboard", "manifest.webmanifest"));
});
router.get("/icon.svg", (_req: Request, res: Response) => {
  res.set("Content-Type", "image/svg+xml");
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(process.cwd(), "app", "ops", "admin", "dashboard", "icon.svg"));
});

/** API 全部需要认证 */
router.use("/api", adminAuth);

/** 服务器状态 */
router.get("/api/status", async (_req: Request, res: Response) => {
  res.json(await adminService.status());
});

/** 用户列表（支持 ?filter= 按 uid/昵称/手机号过滤） */
router.get("/api/users", async (req: Request, res: Response) => {
  const q = (req.query ?? {}) as { filter?: string };
  res.json(await adminService.listUsers(String(q.filter ?? "")));
});

/** 用户详情 */
router.get("/api/users/:uid", async (req: Request, res: Response) => {
  const info = await adminService.getUserInfo(String(req.params.uid));
  if (!info) {
    res.status(404).json({ error: `用户不存在: ${req.params.uid}` });
    return;
  }
  res.json(info);
});

/** 创建用户 */
router.post("/api/users", validateBody(createUserSchema, 400), async (req: Request, res: Response) => {
  try {
    const { phone, password } = req.body ?? {};
    const uid = await adminService.createUser(String(phone), String(password));
    await adminService.reloadUser(uid);
    res.status(201).json({ uid });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 禁用/启用用户（real 模式生效：禁用后登录/鉴权被拦截） */
router.post(
  "/api/users/:uid/disabled",
  validateBody(setUserDisabledSchema, 400),
  async (req: Request, res: Response) => {
    try {
      const { disabled } = req.body ?? {};
      res.json(await adminService.setUserDisabled(String(req.params.uid), Boolean(disabled)));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

/** 删除用户（危险操作，须传 confirmWord="DELETE" 确认） */
router.delete(
  "/api/users/:uid",
  validateBody(deleteUserSchema, 400),
  async (req: Request, res: Response) => {
    try {
      const { confirmWord } = req.body ?? {};
      const result = await adminService.deleteUser(String(req.params.uid), String(confirmWord));
      res.json({ ok: true, uid: result.uid });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

/** 发放物品 */
router.post("/api/users/:uid/grant", validateBody(grantItemSchema, 400), async (req: Request, res: Response) => {
  try {
    const { itemId, count } = req.body ?? {};
    await adminService.grantItem(
      String(req.params.uid),
      String(itemId),
      Number(count),
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 发放干员 */
router.post("/api/users/:uid/grantchar", validateBody(grantCharSchema, 400), async (req: Request, res: Response) => {
  try {
    const { charId } = req.body ?? {};
    const result = await adminService.grantChar(String(req.params.uid), String(charId));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 解锁皮肤 */
router.post("/api/users/:uid/grantskin", validateBody(grantSkinSchema, 400), async (req: Request, res: Response) => {
  try {
    const { skinId } = req.body ?? {};
    await adminService.grantSkin(String(req.params.uid), String(skinId));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 干员列表 */
router.get("/api/users/:uid/chars", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.listChars(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 单个干员详情 */
router.get("/api/users/:uid/chars/:instId", async (req: Request, res: Response) => {
  try {
    const detail = await adminService.getCharDetail(
      String(req.params.uid),
      Number(req.params.instId),
    );
    if (!detail) {
      res.status(404).json({ error: `干员不存在: ${req.params.instId}` });
      return;
    }
    res.json(detail);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 干员模组操作：unlock / upgrade / set（body: { equipId, templateId?, targetLevel? }） */
router.post(
  "/api/users/:uid/chars/:instId/module/:action",
  validateBody(charModuleSchema, 400),
  async (req: Request, res: Response) => {
    try {
      const action = String(req.params.action) as "unlock" | "upgrade" | "set";
      const result = await adminService.operateCharModule(
        String(req.params.uid),
        Number(req.params.instId),
        action,
        req.body ?? {},
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

/** 商店数据汇总（只读） */
router.get("/api/users/:uid/shop", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.getShopSummary(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 玩家签到状态（只读） */
router.get("/api/users/:uid/checkin", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.getCheckInState(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 重置签到 */
router.post("/api/users/:uid/checkin/reset", validateBody(resetCheckInSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.resetCheckIn(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 发放推送信息（设置玩家 pushFlags——红点/通知；body 传 hasGifts/hasFriendRequest/hasClues/hasFreeLevelGP，0=清除） */
router.post("/api/users/:uid/push", validateBody(pushMessageSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.pushMessage(String(req.params.uid), req.body ?? {}));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 代签（领取当前档位奖励） */
router.post("/api/users/:uid/checkin/do", validateBody(doCheckInSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.doCheckIn(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 修改干员属性 */
router.post("/api/users/:uid/chars", validateBody(setCharAttrsSchema, 400), async (req: Request, res: Response) => {
  try {
    const { instId, ...attrs } = req.body ?? {};
    const result = await adminService.setCharAttrs(
      String(req.params.uid),
      Number(instId),
      attrs,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 一键满配 */
router.post("/api/users/:uid/maxout", validateBody(maxOutAccountSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.maxOutAccount(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 基建满级 */
router.post("/api/users/:uid/building-max", validateBody(buildingMaxSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.buildingMax(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 基建加速（手动快进指定秒数并结算产出） */
router.post("/api/users/:uid/building-advance", validateBody(buildingAdvanceSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.buildingAdvance(String(req.params.uid), req.body.seconds));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 创建备份 */
router.post("/api/users/:uid/backup", validateBody(createBackupSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.backup(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 备份列表 */
router.get("/api/users/:uid/backups", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.listBackups(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 从备份恢复 */
router.post("/api/users/:uid/restore", validateBody(restoreSchema, 400), async (req: Request, res: Response) => {
  try {
    const { backup } = req.body ?? {};
    await adminService.restore(String(req.params.uid), String(backup));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 原始玩家数据（完整 JSON） */
router.get("/api/users/:uid/raw", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.getRawJson(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 用户邮件列表 */
router.get("/api/users/:uid/mails", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.listMails(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 删除单封邮件 */
router.delete(
  "/api/users/:uid/mails/:mailId",
  validateBody(deleteMailSchema, 400),
  async (req: Request, res: Response) => {
    try {
      const ok = await adminService.deleteMail(
        String(req.params.uid),
        Number(req.params.mailId),
      );
      if (!ok) {
        res.status(404).json({ error: `邮件不存在: ${req.params.mailId}` });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

/** 发送邮件 */
router.post("/api/mail", validateBody(sendMailSchema, 400), async (req: Request, res: Response) => {
  try {
    const { uid, subject, content, items } = req.body ?? {};
    const mail = await adminService.sendMail(String(uid), {
      subject: String(subject),
      content: String(content ?? ""),
      items: Array.isArray(items) ? items : [],
    });
    res.status(201).json({ mailId: mail.mailId });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 群发邮件（全部用户） */
router.post("/api/mail/all", validateBody(sendMailAllSchema, 400), async (req: Request, res: Response) => {
  try {
    const { subject, content, items } = req.body ?? {};
    const result = await adminService.sendMailAll({
      subject: String(subject),
      content: String(content ?? ""),
      items: Array.isArray(items) ? items : [],
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 每日/每周刷新 */
router.post("/api/users/:uid/refresh", validateBody(refreshUserSchema, 400), async (req: Request, res: Response) => {
  try {
    await adminService.refreshUser(String(req.params.uid));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 立即保存 */
router.post("/api/users/:uid/save", validateBody(saveUserSchema, 400), async (req: Request, res: Response) => {
  try {
    await adminService.saveUser(String(req.params.uid));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 统计聚合 */
router.get("/api/stats", async (_req: Request, res: Response) => {
  res.json(await adminService.stats());
});

/** 审计日志 */
router.get("/api/logs", async (req: Request, res: Response) => {
  const q = (req.query ?? {}) as { limit?: string };
  const limit = Number(q.limit ?? 50);
  res.json(await adminService.logs(Number.isFinite(limit) ? limit : 50));
});

/** 常用物品别名（前端提示用） */
router.get("/api/common-items", (_req: Request, res: Response) => {
  res.json(adminService.getCommonItems());
});

/** 邮件模板列表 */
router.get("/api/mail-templates", (_req: Request, res: Response) => {
  res.json(adminService.getMailTemplates());
});

/** 当前官服操作后端（自定义后端配置摘要） */
router.get("/api/official/backend", (_req: Request, res: Response) => {
  res.json(adminService.getOfficialBackend());
});

/** 地图可视化数据（dashboard「地图」tab：MAPVIZ_DATA 主题关卡池 + rogue_6 gridzone 构造数据） */
router.get("/api/mapviz-data", async (_req: Request, res: Response) => {
  const data = await adminService.getMapvizData();
  if (!data) {
    res.status(404).json({ error: "地图数据缺失（data/mapviz/game-data.js 未生成或格式异常，运行 pnpm exec tsx scripts/generate-mapviz-data.ts 生成）" });
    return;
  }
  res.json(data);
});

/** 肉鸽流程模拟：自动一键跑完整流程（不含战斗） */
router.post("/api/rogue/sim-auto", validateBody(rogueSimAutoSchema, 400), async (req: Request, res: Response) => {
  try {
    const { uid, theme, maxZone } = req.body ?? {};
    const result = await adminService.rogueSimAuto(String(uid), String(theme), maxZone ? Number(maxZone) : undefined);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 肉鸽流程分步模拟：单步执行（白名单 action） */
router.post("/api/rogue/sim-step", validateBody(rogueSimStepSchema, 400), async (req: Request, res: Response) => {
  try {
    const { uid, action, body } = req.body ?? {};
    const result = await adminService.rogueSimStep(String(uid), String(action), body ?? {});
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 肉鸽流程当前状态快照（分步模式初始/刷新） */
router.get("/api/rogue/state", async (req: Request, res: Response) => {
  try {
    const q = (req.query ?? {}) as { uid?: string };
    const state = await adminService.rogueSimState(String(q.uid ?? "1"));
    res.json(state);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 上帝视角：按 JSON 路径实时修改 rlv2 current 状态（set/del/inc），返回最新快照 */
router.post("/api/rogue/modify", validateBody(rogueModifySchema, 400), async (req: Request, res: Response) => {
  try {
    const { uid, ops } = req.body ?? {};
    const result = await adminService.rogueModifyState(String(uid), ops ?? []);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, state: result.state });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 活动列表 + 开关状态（activity 切换，参考 DoctoratePy developer.timestamp） */
router.get("/api/activity/list", async (_req: Request, res: Response) => {
  try {
    res.json(await adminService.listActivities());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 切换活动（自定义活动切换：时间冻结 + 强制开启 + 合约赛季选择；兼容仅传 timestamp） */
router.post("/api/activity/switch", validateBody(switchActivitySchema, 400), async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      timestamp?: number;
      forceOpen?: string[] | string;
      crisisV1?: string;
      crisisV2?: string;
    };
    // 兼容旧调用（仅 timestamp）与 Dashboard 新表单（JSON 数组或逗号分隔串）
    const forceOpen = Array.isArray(body.forceOpen)
      ? body.forceOpen
      : typeof body.forceOpen === "string" && body.forceOpen.trim()
        ? body.forceOpen.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
    const result = await adminService.switchActivity({
      timestamp: body.timestamp,
      forceOpen,
      crisisV1: body.crisisV1,
      crisisV2: body.crisisV2,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 启动资产补全后台任务（target=all|活动id|危机赛季id） */
router.post("/api/asset/backfill", validateBody(backfillAssetsSchema, 400), async (req: Request, res: Response) => {
  try {
    const { target, platform } = (req.body ?? {}) as { target?: string; platform?: string };
    if (!target) {
      res.status(400).json({ error: "缺少 target（all | 活动id | 危机赛季id）" });
      return;
    }
    const task = await adminService.backfillAssets(String(target), String(platform ?? "Android"));
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 查询资产补全任务状态 */
router.get("/api/asset/backfill/:id", async (req: Request, res: Response) => {
  try {
    const task = adminService.getBackfillTaskStatus(String(req.params.id));
    if (!task) {
      res.status(404).json({ error: `任务不存在: ${req.params.id}` });
      return;
    }
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 最近资产补全任务列表 */
router.get("/api/asset/backfill", async (_req: Request, res: Response) => {
  try {
    res.json(adminService.listAssetBackfillTasks());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** CLI 集成：服务器内执行 CLI 命令（复用 admin-cli dispatch，输出捕获返回） */
router.post("/api/cli/exec", validateBody(cliExecSchema, 400), async (req: Request, res: Response) => {
  try {
    const { command } = req.body ?? {};
    const { cliExec } = await import("./cli-exec");
    const result = await cliExec(String(command ?? ""));
    if (!result.ok) {
      res.status(400).json({ ok: false, output: result.output, error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 管理 API 端点规范（Dashboard「接口」控制台数据源） */
router.get("/api/spec", (_req: Request, res: Response) => {
  res.json({ endpoints: ADMIN_ENDPOINTS });
});

/** 游戏协议代理（带玩家 secret 调用游戏端点） */
router.post("/api/game-proxy", validateBody(gameProxySchema, 400), async (req: Request, res: Response) => {
  try {
    const { uid, path: gamePath, method, body } = req.body ?? {};
    const result = await adminService.gameProxy(
      String(uid),
      String(gamePath),
      (String(method ?? "GET").toUpperCase() as "GET" | "POST" | "DELETE"),
      body,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 卡池清单 */
router.get("/api/pools", (_req: Request, res: Response) => {
  res.json(adminService.listPools());
});

/** 卡池详情（UP/可用干员 + 概率） */
router.get("/api/pools/:poolId", (req: Request, res: Response) => {
  const detail = adminService.poolDetail(String(req.params.poolId));
  if (!detail) {
    res.status(404).json({ error: `卡池不存在: ${req.params.poolId}` });
    return;
  }
  res.json(detail);
});

/** 玩家卡池状态（UP 选择 + 保底计数） */
router.get("/api/users/:uid/pools/:poolId", async (req: Request, res: Response) => {
  try {
    res.json(
      await adminService.getPlayerPoolState(
        String(req.params.uid),
        String(req.params.poolId),
      ),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 设置玩家卡池 UP 选择（charIds 空数组清除） */
router.post("/api/users/:uid/pools/:poolId/up", validateBody(setPlayerPoolUpSchema, 400), async (req: Request, res: Response) => {
  try {
    const { charIds } = req.body ?? {};
    res.json(
      await adminService.setPlayerPoolUp(
        String(req.params.uid),
        String(req.params.poolId),
        Array.isArray(charIds) ? charIds : [],
      ),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 设置玩家保底计数 */
router.post("/api/users/:uid/pity", validateBody(setPlayerPitySchema, 400), async (req: Request, res: Response) => {
  try {
    const { ruleType, count } = req.body ?? {};
    res.json(
      await adminService.setPlayerPity(
        String(req.params.uid),
        String(ruleType),
        Number(count),
      ),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 官服账号迁移（联网拉取官服数据 → 注册私服账号） */
router.post("/api/official/migrate", validateBody(migrateOfficialSchema, 400), async (req: Request, res: Response) => {
  try {
    const { accounts, templateUid } = req.body ?? {};
    const results = await adminService.migrateOfficial(
      String(accounts ?? ""),
      String(templateUid ?? "1"),
    );
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 官服枢纽宠物还原（旧存档/官服账号导入后继承宠物；源为官服网关抓包户籍） */
router.post(
  "/api/official/arkhub-import-pets",
  validateBody(arkhubImportPetsSchema, 400),
  async (req: Request, res: Response) => {
    try {
      const { uid, rid, officialUid } = req.body ?? {};
      const result = await adminService.importArkhubPets(
        String(uid),
        rid ? String(rid) : undefined,
        officialUid ? String(officialUid) : undefined,
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

/** 官服操作（登录官服执行签到/邮件等；无状态会话即用即弃） */
router.post("/api/official/action", validateBody(officialActionSchema, 400), async (req: Request, res: Response) => {
  try {
    const { phone, pwd, action } = req.body ?? {};
    const act = String(action);
    if (!isOfficialAction(act)) {
      throw new Error(`未知官服操作: ${act}`);
    }
    const result = await adminService.officialAction(
      String(phone),
      String(pwd),
      act,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 官服通用 API 调用（登录后调用任意官方 cgi） */
router.post("/api/official/call", validateBody(officialCallSchema, 400), async (req: Request, res: Response) => {
  try {
    const { phone, pwd, cgi, body } = req.body ?? {};
    const result = await adminService.officialCall(
      String(phone),
      String(pwd),
      String(cgi),
      body,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 从官服同步卡池详情 */
router.post("/api/official/sync-gacha", validateBody(syncGachaPoolSchema, 400), async (req: Request, res: Response) => {
  try {
    const { phone, pwd, poolIds, refresh } = req.body ?? {};
    const result = await adminService.syncGachaPools(
      String(phone),
      String(pwd),
      Array.isArray(poolIds) ? poolIds : undefined,
      { refresh: refresh === true },
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 像素画上传官服 arkhub（24×24 RGB → savePixelArt 完整流程：网关 token → multipart 上传 → 保存确认） */
router.post("/api/pixel/upload-official", validateBody(uploadPixelArtSchema, 400), async (req: Request, res: Response) => {
  try {
    const { phone, pwd, pixelData } = req.body ?? {};
    const result = await adminService.uploadPixelArt(String(phone), String(pwd), pixelData);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 批量上传像素画到官服 arkhub（大图拆分为多张 24×24 逐张上传，逐张返回结果） */
router.post("/api/pixel/upload-batch", async (req: Request, res: Response) => {
  try {
    const { phone, pwd, pixelDataList } = req.body ?? {};
    const result = await adminService.uploadPixelArtBatch(
      String(phone),
      String(pwd),
      Array.isArray(pixelDataList) ? pixelDataList : [],
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 读取官服已上传像素画（HTTP getPixelArt + OSS .dat 下载解析，返回缩略像素数组） */
router.post("/api/pixel/list-official", validateBody(listPixelArtSchema, 400), async (req: Request, res: Response) => {
  try {
    const { phone, pwd, pixelArtIds } = req.body ?? {};
    const result = await adminService.getPixelArtList(
      String(phone),
      String(pwd),
      Array.isArray(pixelArtIds) ? pixelArtIds : undefined,
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 撤销（删除）官服已上传像素画（网关 DeletePixelArtReq） */
router.post("/api/pixel/delete-official", validateBody(deletePixelArtSchema, 400), async (req: Request, res: Response) => {
  try {
    const { phone, pwd, pixelArtIds } = req.body ?? {};
    const result = await adminService.deletePixelArt(
      String(phone),
      String(pwd),
      Array.isArray(pixelArtIds) ? pixelArtIds : [],
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 批量发放全部物品 */
router.post("/api/users/:uid/grant-all", validateBody(grantAllItemsSchema, 400), async (req: Request, res: Response) => {
  try {
    const { count } = req.body ?? {};
    res.json(
      await adminService.grantAllItems(String(req.params.uid), Number(count ?? 999)),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 批量拉满全部已有干员 */
router.post("/api/users/:uid/maxchars", validateBody(maxAllCharsSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.maxAllChars(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 修复干员结构（补齐 voiceLan/starMark/equip/skills/阿米娅 tmpl） */
router.post("/api/users/:uid/repair-chars", validateBody(repairCharsSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.repairChars(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 玩家推图进度（只读） */
router.get("/api/users/:uid/stages", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.listStages(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 解锁指定关卡 */
router.post("/api/users/:uid/stages/unlock", validateBody(unlockStageSchema, 400), async (req: Request, res: Response) => {
  try {
    const { stageId } = req.body ?? {};
    res.json(
      await adminService.unlockStage(String(req.params.uid), String(stageId)),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 推图全解锁 */
router.post("/api/users/:uid/stages/unlock-all", validateBody(unlockAllStagesSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await adminService.unlockAllStages(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 物品搜索（按 ID/中文名过滤 ItemTable） */
router.get("/api/items", (req: Request, res: Response) => {
  const q = (req.query ?? {}) as { q?: string; limit?: string };
  res.json(
    adminService.searchItems(String(q.q ?? ""), Number(q.limit ?? 50)),
  );
});

/** 任务进度统计（只读） */
router.get("/api/users/:uid/missions", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.listMissionStats(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 勋章进度（只读） */
router.get("/api/users/:uid/medals", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.listMedals(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 导出用户存档 */
router.post("/api/users/:uid/export", validateBody(exportUserSchema, 400), async (req: Request, res: Response) => {
  try {
    const { path: targetPath } = req.body ?? {};
    res.json(
      await adminService.exportUser(String(req.params.uid), targetPath ? String(targetPath) : undefined),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 导入存档（替换指定 uid；uid 缺省取文件内 status.uid） */
router.post("/api/import", validateBody(importUserSchema, 400), async (req: Request, res: Response) => {
  try {
    const { filePath, uid } = req.body ?? {};
    res.json(await adminService.importUser(String(filePath), uid ? String(uid) : undefined));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 数据完整性校验 */
router.get("/api/check", async (_req: Request, res: Response) => {
  res.json(await adminService.checkData());
});

/** 存档文件级校验（磁盘全部，含未加载用户） */
router.get("/api/check-files", async (_req: Request, res: Response) => {
  res.json(await adminService.checkDataFiles());
});

/** 活动数据摘要（只读） */
router.get("/api/users/:uid/activity", async (req: Request, res: Response) => {
  try {
    res.json(await adminService.getActivitySummary(String(req.params.uid)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** OpenAPI 3.0 规范（管理 API） */
router.get("/api/openapi.json", (_req: Request, res: Response) => {
  res.json(buildOpenApi());
});

/* ==================== 统一抓包管理（/admin/api/capture/*） ==================== */

/** 抓包会话列表（含记录数；最新在前） */
router.get("/api/capture/sessions", async (_req: Request, res: Response) => {
  res.json(await captureManager.listSessions());
});

/** 新建抓包会话（body: { name, source?, note? }） */
router.post("/api/capture/sessions", validateBody(createCaptureSessionSchema, 400), async (req: Request, res: Response) => {
  try {
    const { name, source, note } = req.body ?? {};
    const s = await captureManager.startSession(
      String(name ?? "未命名会话"),
      (String(source ?? "private") as "private"),
      String(note ?? ""),
    );
    res.status(201).json(s);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 停止抓包会话 */
router.post("/api/capture/sessions/:id/stop", validateBody(stopCaptureSessionSchema, 400), async (req: Request, res: Response) => {
  const ok = await captureManager.stopSession(String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: `会话不存在: ${req.params.id}` });
    return;
  }
  res.json({ ok: true });
});

/** 删除抓包会话（级联删除其全部记录与 body 目录） */
router.delete("/api/capture/sessions/:id", validateBody(deleteCaptureSessionSchema, 400), async (req: Request, res: Response) => {
  const deleted = await captureManager.deleteSession(String(req.params.id));
  res.json({ deleted });
});

/** 抓包记录列表（过滤：sessionId/source/method/path/module/endpoint/status/direction/from/to/q + 分页） */
router.get("/api/capture/records", async (req: Request, res: Response) => {
  try {
    const q = req.query ?? {};
    res.json(
      await captureManager.query({
        sessionId: queryStr(q.sessionId),
        source: queryStr(q.source),
        method: queryStr(q.method),
        path: queryStr(q.path),
        module: queryStr(q.module),
        endpoint: queryStr(q.endpoint),
        direction: queryStr(q.direction),
        status: queryNum(q.status),
        from: queryNum(q.from),
        to: queryNum(q.to),
        q: queryStr(q.q),
        limit: queryNum(q.limit),
        offset: queryNum(q.offset),
      }),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 抓包记录详情（含请求/响应头与 body 内容） */
router.get("/api/capture/records/:id", async (req: Request, res: Response) => {
  const detail = await captureManager.getRecordDetail(String(req.params.id));
  if (!detail) {
    res.status(404).json({ error: `记录不存在: ${req.params.id}` });
    return;
  }
  res.json(detail);
});

/** 删除单条抓包记录 */
router.delete("/api/capture/records/:id", validateBody(deleteCaptureRecordSchema, 400), async (req: Request, res: Response) => {
  const ok = await captureManager.deleteRecord(String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: `记录不存在: ${req.params.id}` });
    return;
  }
  res.json({ ok: true });
});

/** 清空全部抓包（confirmWord="CLEAR" 确认） */
router.post("/api/capture/clear", validateBody(captureClearSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await captureManager.clearAll(String((req.body ?? {}).confirmWord ?? "")));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 抓包统计（来源/状态码/按天） */
router.get("/api/capture/stats", async (_req: Request, res: Response) => {
  res.json(await captureManager.stats());
});

/** 导出会话 zip 下载 */
router.get("/api/capture/sessions/:id/export", async (req: Request, res: Response) => {
  try {
    const out = await captureManager.exportSession(String(req.params.id));
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${path.basename(out.path)}"`);
    res.sendFile(path.resolve(out.path));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 导出单条记录 zip 下载 */
router.get("/api/capture/records/:id/export", async (req: Request, res: Response) => {
  try {
    const out = await captureManager.exportRecord(String(req.params.id));
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${path.basename(out.path)}"`);
    res.sendFile(path.resolve(out.path));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 抓包实时流（SSE：?token= 认证；回填最近 50 条后直播新记录） */
router.get("/api/capture/stream", (req: Request, res: Response) => {
  createSse(req, res);
  void captureManager
    .query({ limit: 50 })
    .then(({ items }) => {
      for (const r of items) sseSend(res, "record", { type: "backfill", record: r });
    })
    .catch(() => undefined);
  const unsub = captureManager.subscribe((r) => sseSend(res, "record", { type: "live", record: r }));
  req.on("close", unsub);
});

/* ==================== 统一日志管理（/admin/api/logs/*） ==================== */

/** 服务器日志（?date=YYYYMMDD&level=&tag=&q=&limit=&offset=） */
router.get("/api/logs/server", async (req: Request, res: Response) => {
  try {
    const q = req.query ?? {};
    res.json(
      await logService.readServerLog({
        date: queryStr(q.date),
        level: queryStr(q.level),
        tag: queryStr(q.tag),
        q: queryStr(q.q),
        limit: queryNum(q.limit),
        offset: queryNum(q.offset),
      }),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 服务器日志可用日期列表 */
router.get("/api/logs/server/dates", async (_req: Request, res: Response) => {
  res.json(await logService.listServerLogDates());
});

/** 看门狗日志 */
router.get("/api/logs/watchdog", async (_req: Request, res: Response) => {
  res.json(await logService.readWatchdogLog());
});

/** 审计日志（?action=&uid=&q=&limit=；兼容旧 GET /api/logs） */
router.get("/api/logs/audit", async (req: Request, res: Response) => {
  try {
    const q = req.query ?? {};
    res.json(
      await logService.readAuditLog({
        action: queryStr(q.action),
        uid: queryStr(q.uid),
        q: queryStr(q.q),
        limit: queryNum(q.limit),
      }),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 清空服务器日志（confirmWord="CLEAR"） */
router.post("/api/logs/server/clear", validateBody(logClearSchema, 400), async (req: Request, res: Response) => {
  try {
    res.json(await logService.clearServerLogs(String((req.body ?? {}).confirmWord ?? "")));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 日志实时流（SSE：?kind=server|audit|capture；回填最近 50 条后直播） */
router.get("/api/logs/stream", (req: Request, res: Response) => {
  const kind = String((req.query ?? {}).kind ?? "server");
  createSse(req, res);

  if (kind === "capture") {
    void captureManager
      .query({ limit: 50 })
      .then(({ items }) => {
        for (const r of items) sseSend(res, "record", { kind: "capture", type: "backfill", record: r });
      })
      .catch(() => undefined);
    const unsub = captureManager.subscribe((r) => sseSend(res, "record", { kind: "capture", type: "live", record: r }));
    req.on("close", unsub);
    return;
  }

  if (kind === "audit") {
    void logService
      .readAuditLog({ limit: 50 })
      .then((entries) => {
        for (const e of entries) sseSend(res, "log", { kind: "audit", type: "backfill", entry: e });
      })
      .catch(() => undefined);
    const unsub = logService.subscribeAudit((e) => sseSend(res, "log", { kind: "audit", type: "live", entry: e }));
    req.on("close", unsub);
    return;
  }

  // server（默认）
  void logService
    .readServerLog({ limit: 50 })
    .then(({ items }) => {
      for (const e of items) sseSend(res, "log", { kind: "server", type: "backfill", entry: e });
    })
    .catch(() => undefined);
  const unsub = logService.subscribeServer((e) => sseSend(res, "log", { kind: "server", type: "live", entry: e }));
  req.on("close", unsub);
});

/** 资产列表（?category=&name=&limit=&offset=，按 name 模糊搜索） */
router.get("/api/asset", async (req: Request, res: Response) => {
  const q = (req.query ?? {}) as {
    category?: string;
    name?: string;
    limit?: string;
    offset?: string;
  };
  const result = await assetRegistry.listAssets({
    category: q.category as never,
    name: q.name ? String(q.name) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  });
  res.json(result);
});

/** 资产溯源链（?name= 精确查资产，返回该资产完整事件链） */
router.get("/api/asset/lineage", async (req: Request, res: Response) => {
  const name = String((req.query ?? {}).name ?? "");
  if (!name) {
    res.status(400).json({ error: "缺少 ?name= 查询参数" });
    return;
  }
  res.json(await assetRegistry.getAssetLineage(name));
});

/** 审计事件流（?action=&assetId=&limit=，时间降序 JSON） */
router.get("/api/asset/events", async (req: Request, res: Response) => {
  const q = (req.query ?? {}) as { action?: string; assetId?: string; limit?: string };
  const result = await assetRegistry.listEvents({
    action: q.action as never,
    assetId: q.assetId != null ? Number(q.assetId) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  });
  res.json(result);
});

/** 审计事件实时流（SSE：?token= 认证；回填最近 100 条后直播新事件） */
router.get("/api/asset/events/stream", (req: Request, res: Response) => {
  createSse(req, res);
  void assetRegistry
    .listEvents({ limit: 100 })
    .then(({ items }) => {
      for (const e of items.reverse()) sseSend(res, "event", { type: "backfill", event: e });
    })
    .catch(() => undefined);
  const unsub = assetRegistry.subscribe((e) => sseSend(res, "event", { type: "live", event: e }));
  req.on("close", unsub);
});

/** 配置（只读） */
router.get("/api/config", (_req: Request, res: Response) => {
  res.json(config);
});

/** 插件列表（含启用状态与选项取值） */
router.get("/api/plugin", async (_req: Request, res: Response) => {
  const [plugins, options] = await Promise.all([
    pluginConfigService.getAll(),
    pluginConfigService.getAllOptions(),
  ]);
  res.json({ plugins, options });
});

/** 启用插件 */
router.post("/api/plugin/:id/enable", validateBody(enablePluginSchema, 400), async (req: Request, res: Response) => {
  try {
    const enabled = await pluginConfigService.setEnabled(String(req.params.id), true);
    res.json({ ok: true, id: req.params.id, enabled });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 停用插件 */
router.post("/api/plugin/:id/disable", validateBody(disablePluginSchema, 400), async (req: Request, res: Response) => {
  try {
    const enabled = await pluginConfigService.setEnabled(String(req.params.id), false);
    res.json({ ok: true, id: req.params.id, enabled });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
