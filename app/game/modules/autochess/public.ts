/**
 * 自走棋（卫戍协议）模块对外出口
 *
 * 其他模块仅允许 import 本文件（或走事件总线）；目前无跨模块调用方，
 * 先导出 Manager 类型与协议类型供测试/后续模块复用。
 */
export {
  AutoChessManager,
  emptyAutoChessFinishPayload,
  autoChessGmCatalog,
  AUTOCHESS_GM_CODES,
  AUTOCHESS_GM_ECONOMY,
} from "./autochess";
export type {
  AutoChessSession,
  AutoChessActionResult,
  AutoChessGmCatalog,
  AutoChessGmCatalogChar,
  AutoChessGmCatalogItem,
  AutoChessGmCode,
  AutoChessGmData,
  AutoChessGmParam,
  AutoChessGmResult,
  AutoChessGmStateView,
  AutoChessGmTable,
} from "./autochess";
export type {
  ActAutoChessSyncInfoBattleInfo,
  ActAutoChessSyncInfoRequest,
  ActAutoChessSyncInfoResponse,
  AutoChessSeasonSettleGameInfo,
  AutoChessTeamInfo,
} from "./autochess.protocol";
