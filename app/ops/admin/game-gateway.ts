/**
 * admin → game 薄网关（AdminGameGateway）
 *
 * 收敛 admin 后台对游戏运行时实体的访问：所有「值（单例/函数/常量）」的 game 依赖
 * 统一经本网关暴露，admin 业务代码（AdminService 等）只从本网关解构取得——
 * 使「admin 触碰 game」的边界显式、集中，避免散落在多个业务文件里直接混入，
 * 便于维护与测试（可替换为 mock 网关）。
 *
 * 说明：类型（TS 纯类型）不具运行时依赖，admin 仍允许直接 `import type` 自 game。
 */
import { buildMaxedSkills, buildMaxedEquip } from "@ops/admin/maxout";
import { GACHA_RULE_TYPE } from "@game/modules/gacha/gacha";
import { accountManager } from "@game/modules/account/AccountManager";
import { mailManager } from "@game/modules/mail/MailManager";
import { unlockActivity, forcedActivityIds } from "@game/modules/activities/shared/unlockActivity";
import { listCrisisSeasons } from "@game/modules/crisis/crisis-seasons";
import { loadOrders, markPaid } from "@game/modules/pay/pay-store";

/**
 * admin 可访问的 game 运行时实体集合
 */
export const adminGame = {
  buildMaxedSkills,
  buildMaxedEquip,
  GACHA_RULE_TYPE,
  accountManager,
  mailManager,
  unlockActivity,
  forcedActivityIds,
  listCrisisSeasons,
  loadOrders,
  markPaid,
};

/** 网关对象类型（便于测试 mock） */
export type AdminGameGateway = typeof adminGame;