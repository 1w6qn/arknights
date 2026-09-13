/**
 * 特殊干员置顶（/troop/*）协议类型
 *
 * 服务端自定义端点，无 CS 对应类；字段以服务端读取为准。
 */
import { PlayerDeltaResponse } from "../../kernel/http/common";

/** 特殊干员置顶请求（服务端自定义，无 CS 对应类） */
export interface PinSpecialOperatorRequest {
  instId: number;
}

/** 特殊干员置顶响应（服务端自定义；仅增量） */
export type PinSpecialOperatorResponse = PlayerDeltaResponse;
