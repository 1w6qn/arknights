/**
 * 陷阱队（/templateTrap/*）协议类型
 *
 * 对应客户端 CS 的 UI.TemplateTrap.SetTemplateTrapRequest/Response，
 * CS 的 trapSquad 为 String[]，服务端原样写回。
 */
import { PlayerDeltaResponse } from "../../kernel/http/common";

/**
 * 设置陷阱队请求（CS: UI.TemplateTrap.SetTemplateTrapRequest）
 * CS 的 trapSquad 为 String[]，服务端原样写回
 */
export interface SetTrapSquadRequest {
  trapDomainId: string;
  trapSquad: string[];
}

/** 设置陷阱队响应（CS: UI.TemplateTrap.SetTemplateTrapResponse） */
export interface SetTrapSquadResponse extends PlayerDeltaResponse {
  trapDomainId: string;
  trapSquad: string[];
}
