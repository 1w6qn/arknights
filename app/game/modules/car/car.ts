/**
 * 出战战车（/car/*）协议类型
 *
 * 服务端自定义端点，无 CS 对应类；car 结构见 kernel/playerdata 的
 * PlayerCartInfo.battleCar。
 */
import { PlayerCartInfo_Cart } from "../../kernel/playerdata";
import { PlayerDeltaResponse } from "../../kernel/http/common";

/** 确认出战战车请求（服务端自定义，无 CS 对应类；car 结构见 PlayerCartInfo.battleCar） */
export interface ConfirmBattleCarRequest {
  car: PlayerCartInfo_Cart;
}

/** 确认出战战车响应（服务端自定义；仅增量） */
export type ConfirmBattleCarResponse = PlayerDeltaResponse;
