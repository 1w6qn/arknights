/**
 * 干员星级标记（/char/*）协议类型
 *
 * 对应客户端 CS 的 ChangeStarMarkCharRequest，字段以 CS 类为准。
 * 服务端未返回的协议字段标为可选。
 */
import { PlayerDeltaResponse } from "../../kernel/http/common";

/**
 * 修改干员星级标记请求（CS: ChangeStarMarkCharRequest）
 * CS 的 chrIdDict 为 ListDict<String,Int32>，映射为 { [key: string]: number }
 */
export interface ChangeMarkStarRequest {
  chrIdDict: { [key: string]: number };
}

/** 修改干员星级标记响应（CS: ChangeStarMarkCharResponse） */
export type ChangeMarkStarResponse = PlayerDeltaResponse;
