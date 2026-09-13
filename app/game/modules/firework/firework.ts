/**
 * 烟花（/firework/*）协议类型
 *
 * 对应客户端 CS 的 UI.Firework.FireworkSavePlateSlotRequest /
 * FireworkChangeAnimalRequest 等 Request/Response 类，字段以 CS 类为准；
 * CS 另有服务端未读取的 groupId 字段，标为可选。
 */
import { PlayerDeltaResponse } from "../../kernel/http/common";

/** 烟花棋盘槽位（CS: FireworkData.PlateSlotData） */
export interface PlateSlotData {
  id: string;
  idx: number;
}

/**
 * 保存烟花棋盘槽位请求（CS: UI.Firework.FireworkSavePlateSlotRequest）
 * CS 另有 groupId 字段，服务端未读取
 */
export interface FireworkSavePlateSlotsRequest {
  groupId?: string;
  slots: PlateSlotData[];
}

/** 保存烟花棋盘槽位响应（CS: UI.Firework.FireworkSavePlateSlotResponse） */
export type FireworkSavePlateSlotsResponse = PlayerDeltaResponse;

/**
 * 更换烟花动物请求（CS: UI.Firework.FireworkChangeAnimalRequest）
 * CS 另有 groupId 字段，服务端未读取
 */
export interface FireworkChangeAnimalRequest {
  animal: string;
  groupId?: string;
}

/** 更换烟花动物响应（CS: UI.Firework.FireworkChangeAnimalResponse） */
export interface FireworkChangeAnimalResponse extends PlayerDeltaResponse {
  animal: string;
}
