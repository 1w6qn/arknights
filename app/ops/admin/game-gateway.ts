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
import { autoChessGmCatalog } from "@game/modules/autochess/public";
import type { JsonObject } from "@excel/json-value";
import {
  buildFreshPlayerData,
  buildFreshStatus,
  freshInventory,
  freshTroop,
  freshGacha,
  freshMedal,
  freshMission,
  freshBuilding,
  freshHomeTheme,
  freshRlv2,
} from "@game/kernel/fresh-player";

/**
 * 构造全新玩家存档并收口为 JSON 域（GM 数据重置用）
 *
 * freshPlayer 的返回契约是 `Record<string, unknown>`（泛型存档脚手架），
 * 在网关这一层统一收口为 {@link JsonObject}，避免 admin 业务代码出现模糊类型。
 * @param template - 结构合法的模板存档（当前存档的深拷贝）
 * @param opts     - 新号身份信息（uid/昵称/编号/注册时间戳）
 * @returns 全新存档对象（纯 JSON 域）
 */
function freshPlayerJson(
  template: JsonObject,
  opts: { uid: string; nickName: string; nickNumber: string; registerTs: number },
): JsonObject {
  return buildFreshPlayerData(template, opts) as JsonObject;
}

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
  // 「GM 数据重置」所需：新玩家存档构建与各分区重置构造器（reset_all / reset_key）
  buildFreshPlayerData,
  buildFreshStatus,
  freshInventory,
  freshTroop,
  freshGacha,
  freshMedal,
  freshMission,
  freshBuilding,
  freshHomeTheme,
  freshRlv2,
  // 「GM 面板」所需：自走棋棋池目录（/gm/data 的 autochess 选择器）与存档重置构造
  autoChessGmCatalog,
  freshPlayerJson,
};

/** 网关对象类型（便于测试 mock） */
export type AdminGameGateway = typeof adminGame;