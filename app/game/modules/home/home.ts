/**
 * 首页（home）协议类型
 *
 * 对应客户端 com.hypergryph.arknights_2.7.61.cs 中 Torappu 命名空间的
 * SetHomeThemeRequest / SetHomeBackgroundRequest / SetLowPowerRequest /
 * ChangeRogueNpcVoiceLanRequest 等 Request/Response 类，以及 charm 模块复用的
 * Activity.Act12side.UI.CharmSetSquadRequest/Response；
 * 字段以 CS 类为准，服务端未返回的协议字段标为可选。
 *
 * 其余曾堆在本文件的跨域协议（干员标记/剧情/事件上报/烟花/战车/陷阱队等）已随
 * 路由按 URL 域拆到各自的独立模块。
 */
import { PlayerDeltaResponse } from "../../kernel/http/common";

/* ===== 主题与背景 ===== */

/** 更换首页主题请求（CS: SetHomeThemeRequest） */
export interface SetHomeThemeRequest {
  themeId: string;
}

/** 更换首页主题响应（CS: SetHomeThemeResponse） */
export type SetHomeThemeResponse = PlayerDeltaResponse;

/** 设置首页背景请求（CS: SetHomeBackgroundRequest） */
export interface SetBackgroundRequest {
  bgID: string;
}

/** 设置首页背景响应（CS: SetHomeBackgroundResponse） */
export type SetBackgroundResponse = PlayerDeltaResponse;

/* ===== 设置 ===== */

/** 设置低电量模式请求（CS: SetLowPowerRequest） */
export interface SetLowPowerRequest {
  newValue: number;
}

/** 设置低电量模式响应（CS: SetLowPowerResponse） */
export type SetLowPowerResponse = PlayerDeltaResponse;

/**
 * 切换 NPC 语音请求（CS: ChangeRogueNpcVoiceLanRequest）
 * CS 的 voiceLan 为 VoiceLangType 枚举，服务端以字符串读取
 */
export interface NpcAudioChangeLanRequest {
  id: string;
  voiceLan: string;
}

/** 切换 NPC 语音响应（CS: ChangeRogueNpcVoiceLanResponse） */
export type NpcAudioChangeLanResponse = PlayerDeltaResponse;

/* ===== 信物（charm 模块复用） ===== */

/** 设置信物小队请求（CS: Activity.Act12side.UI.CharmSetSquadRequest） */
export interface CharmSetSquadRequest {
  squad: string[];
}

/** 设置信物小队响应（CS: Activity.Act12side.UI.CharmSetSquadResponse） */
export type CharmSetSquadResponse = PlayerDeltaResponse;
