/**
 * GM 兼容操作路由（`/admin/<op>`）
 *
 * 路径与参数名严格对齐归档 GM 面板（其 `gm.js` 以 `POST /admin/<op>` +
 * `X-Admin-Token` 调用）：本仓挂在既有 `/admin` 前缀下，与 `/admin/api/*`
 * 并存互不冲突；每个端点都经 `adminAuth`（`data/config.json` 的 `admin.enable`
 * 必须为 true）与 `validateBody`。
 *
 * 响应体：`{ok:true, op, detail, data}`；失败 `{ok:false, detail}`（HTTP 状态码
 * 表达类别：400 参数、404 不存在、409 状态冲突、500 未知异常）。
 */
import { Router } from "express";
import type { Request, Response, RequestHandler } from "express";
import type { ZodSchema } from "zod";
import { logger } from "@utils/logger";
import { validateBody } from "@core/http/validate-body";
import { adminAuth } from "../admin-auth";
import { gmService } from "./gm-service";
import { GmOpError } from "./gm-types";
import type { GmOpData } from "./gm-types";
import {
  gmActivityClockSchema,
  gmActivitySwitchSchema,
  gmAssetPatchSchema,
  gmAutochessBattleActiveSchema,
  gmAutochessBattleSettledSchema,
  gmAutochessGmSchema,
  gmAutochessPlayerCardSchema,
  gmCharMaxSchema,
  gmCharSchema,
  gmCrisisSeasonSchema,
  gmDoctorLevelSchema,
  gmItemClearSchema,
  gmMailGrantSchema,
  gmPlayerOnlySchema,
  gmResetAllSchema,
  gmResetDbSchema,
  gmResetKeySchema,
  gmRlv2CharBuffSchema,
  gmRlv2DifficultySchema,
  gmRlv2RelicLayerSchema,
  gmSandboxEnemyRushSchema,
  gmSandboxSeasonSchema,
  gmTowerSeasonSchema,
} from "./gm-schemas";

/** 操作 handler 签名（body 由 zod schema 保证形状） */
type GmBodyHandler<T> = (body: T) => Promise<GmOpData>;

/**
 * 组装一条 GM 操作路由的中间件链（认证 → 校验 → 执行 → 统一错误映射）
 * @param op      - 操作名（响应回显）
 * @param schema  - 请求体 zod schema
 * @param handler - 服务层调用
 * @returns Express 处理链
 */
function gmRoute<T>(
  op: string,
  schema: ZodSchema,
  handler: GmBodyHandler<T>,
): RequestHandler[] {
  const run: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await handler(req.body as T);
      res.json({ ok: true, op, detail: result.detail, data: result.data });
    } catch (error) {
      if (error instanceof GmOpError) {
        res.status(error.status).json({ ok: false, detail: error.message });
        return;
      }
      logger.error("gm", `${op} 失败: ${(error as Error).message}`);
      res.status(500).json({ ok: false, detail: (error as Error).message });
    }
  };
  return [adminAuth, validateBody(schema, 400), run];
}

/** GM 操作路由 */
const router = Router();

/* ===== 赛季与活动 ===== */
router.post(
  "/activity_clock",
  ...gmRoute<{ activity_id?: string | null }>("activity_clock", gmActivityClockSchema, (b) =>
    gmService.activityClock(b.activity_id),
  ),
);
router.post(
  "/activity_switch",
  ...gmRoute<{ activity_id?: string | null }>("activity_switch", gmActivitySwitchSchema, (b) =>
    gmService.activitySwitch(b.activity_id),
  ),
);
router.post(
  "/crisis_season",
  ...gmRoute<{ season_id?: string }>("crisis_season", gmCrisisSeasonSchema, (b) =>
    gmService.crisisSeason(b.season_id),
  ),
);
router.post(
  "/tower_season",
  ...gmRoute<{ player_id: string; season_id?: string }>("tower_season", gmTowerSeasonSchema, (b) =>
    gmService.towerSeason(b),
  ),
);
router.post(
  "/asset_patch",
  ...gmRoute<{ state: string }>("asset_patch", gmAssetPatchSchema, (b) => gmService.assetPatch(b.state)),
);

/* ===== 养成工具 ===== */
router.post(
  "/doctor_level",
  ...gmRoute<{ player_id: string; level: number }>("doctor_level", gmDoctorLevelSchema, (b) =>
    gmService.doctorLevel(b),
  ),
);
router.post(
  "/char_grant_all",
  ...gmRoute<{ player_id: string }>("char_grant_all", gmPlayerOnlySchema, (b) =>
    gmService.charGrantAll(b),
  ),
);
router.post(
  "/skin_grant_all",
  ...gmRoute<{ player_id: string }>("skin_grant_all", gmPlayerOnlySchema, (b) =>
    gmService.skinGrantAll(b),
  ),
);
router.post(
  "/furni_grant_all",
  ...gmRoute<{ player_id: string }>("furni_grant_all", gmPlayerOnlySchema, (b) =>
    gmService.furniGrantAll(b),
  ),
);
router.post(
  "/shop_currency_grant",
  ...gmRoute<{ player_id: string }>("shop_currency_grant", gmPlayerOnlySchema, (b) =>
    gmService.shopCurrencyGrant(b),
  ),
);
router.post(
  "/stage_unlock_all",
  ...gmRoute<{ player_id: string }>("stage_unlock_all", gmPlayerOnlySchema, (b) =>
    gmService.stageUnlockAll(b),
  ),
);

/* ===== 干员调整 ===== */
router.post(
  "/char",
  ...gmRoute<{ player_id: string; char_id: string }>("char", gmCharSchema, (b) =>
    gmService.charModify(b),
  ),
);
router.post(
  "/char_max",
  ...gmRoute<{ player_id: string; char_id: string }>("char_max", gmCharMaxSchema, (b) =>
    gmService.charMax(b),
  ),
);
router.post(
  "/char_max_all",
  ...gmRoute<{ player_id: string }>("char_max_all", gmPlayerOnlySchema, (b) => gmService.charMaxAll(b)),
);

/* ===== 物品发放 / 清理 ===== */
router.post(
  "/item_clear",
  ...gmRoute<{ player_id: string; item_id?: string }>("item_clear", gmItemClearSchema, (b) =>
    gmService.itemClear(b),
  ),
);
router.post(
  "/mail_grant",
  ...gmRoute<{
    player_id: string;
    items: { id: string; count: number }[];
    subject?: string;
    content?: string;
  }>("mail_grant", gmMailGrantSchema, (b) => gmService.mailGrant(b)),
);

/* ===== 集成战略 ===== */
router.post(
  "/rlv2/difficulty",
  ...gmRoute<{ player_id: string; n: number }>("rlv2/difficulty", gmRlv2DifficultySchema, (b) =>
    gmService.rlv2Difficulty(b),
  ),
);
router.post(
  "/rlv2/relic_layer",
  ...gmRoute<{ player_id: string; relic_id: string; layer?: number }>(
    "rlv2/relic_layer",
    gmRlv2RelicLayerSchema,
    (b) => gmService.rlv2RelicLayer(b),
  ),
);
router.post(
  "/rlv2/char_buff",
  ...gmRoute<{ player_id: string; char_id: string; char_buff_id: string }>(
    "rlv2/char_buff",
    gmRlv2CharBuffSchema,
    (b) => gmService.rlv2CharBuff(b),
  ),
);

/* ===== 沙盒管理 ===== */
router.post(
  "/sandbox/season",
  ...gmRoute<{ player_id: string; topic_id: string; season_idx: number }>(
    "sandbox/season",
    gmSandboxSeasonSchema,
    (b) => gmService.sandboxSeason(b),
  ),
);
router.post(
  "/sandbox/enemy_rush",
  ...gmRoute<{ player_id: string; topic_id: string; enemy_id: string; node_id: string }>(
    "sandbox/enemy_rush",
    gmSandboxEnemyRushSchema,
    (b) => gmService.sandboxEnemyRush(b),
  ),
);

/* ===== 数据重置 ===== */
router.post(
  "/reset_key",
  ...gmRoute<{ player_id: string; key: string }>("reset_key", gmResetKeySchema, (b) =>
    gmService.resetKey(b),
  ),
);
router.post(
  "/reset_all",
  ...gmRoute<{ player_id: string }>("reset_all", gmResetAllSchema, (b) => gmService.resetAll(b)),
);
router.post(
  "/reset_db",
  ...gmRoute<Record<string, never>>("reset_db", gmResetDbSchema, () => gmService.resetDb()),
);

/* ===== 卫戍协议（自走棋）GM ===== */
router.post(
  "/autochess_gm",
  ...gmRoute<{ uid?: string; code: string; params?: (string | number | boolean | null)[] }>(
    "autochess_gm",
    gmAutochessGmSchema,
    (b) => gmService.autochessGm(b),
  ),
);
router.post(
  "/autochess_battle_active",
  ...gmRoute<{
    uid: string;
    sceneId?: string;
    scene_id?: string;
    squad?: number;
    secretary?: string;
    curRound?: number;
    cur_round?: number;
  }>("autochess_battle_active", gmAutochessBattleActiveSchema, (b) =>
    gmService.autochessBattleActive(b),
  ),
);
router.post(
  "/autochess_battle_settled",
  ...gmRoute<{ uid: string; slot?: number; mode?: string; req?: number }>(
    "autochess_battle_settled",
    gmAutochessBattleSettledSchema,
    (b) => gmService.autochessBattleSettled(b),
  ),
);
router.post(
  "/autochess_player_card",
  ...gmRoute<{ uid: string }>("autochess_player_card", gmAutochessPlayerCardSchema, (b) =>
    gmService.autochessPlayerCard(b),
  ),
);

export default router;
