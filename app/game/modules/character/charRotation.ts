/**
 * 干员轮换协议类型
 *
 * 对应客户端 com.hypergryph.arknights_2.7.61.cs 中 Torappu 命名空间的
 * CharRotationSetCurrentPresetRequest / CharRotationCreatePresetRequest /
 * CharRotationUpdatePresetRequest / CharRotationDeletePresetRequest 等 Request/Response 类；
 * 字段以 CS 类为准，服务端未返回的协议字段标为可选。
 */
import { PlayerCharRotationSlot } from "../../kernel/playerdata";
import { PlayerDeltaResponse } from "../../kernel/http/common";

/** 设置当前轮换配置请求（CS: CharRotationSetCurrentPresetRequest） */
export interface CharRotationSetCurrentPresetRequest {
  instId: string;
}

/** 设置当前轮换配置响应（CS: CharRotationSetCurrentPresetResponse） */
export type CharRotationSetCurrentPresetResponse = PlayerDeltaResponse;

/** 创建轮换预设请求（CS: CharRotationCreatePresetRequest，无字段） */
export interface CharRotationCreatePresetRequest {}

/**
 * 创建轮换预设响应（CS: CharRotationCreatePresetResponse : PlayerDeltaResponse）
 * CS 字段 instId 为新建预设的实例ID，客户端 `_OnBtnCreatePresetClick` 回调据此选中新预设
 */
export interface CharRotationCreatePresetResponse extends PlayerDeltaResponse {
  instId: string;
}

/** 删除轮换预设请求（CS: CharRotationDeletePresetRequest） */
export interface CharRotationDeletePresetRequest {
  instId: string;
}

/** 删除轮换预设响应（CS: CharRotationDeletePresetResponse） */
export type CharRotationDeletePresetResponse = PlayerDeltaResponse;

/**
 * 更新轮换预设请求（CS: CharRotationUpdatePresetRequest）
 * CS 的 flag 为 UpdateFlag 枚举；CS 的 data 含 secretaryShowSpDynIllust、Slot 含 skinSp，
 * 服务端契约未读取，此处以服务端为准
 */
export interface CharRotationUpdatePresetRequest {
  instId: string;
  flag: number;
  data: {
    name?: string;
    background?: string;
    homeTheme?: string;
    secretarySkinId?: string;
    secretaryCharInstId?: string;
    slots?: PlayerCharRotationSlot[];
  };
}

/** 更新轮换预设响应（CS: CharRotationUpdatePresetResponse : ExaminResponse；服务端仅返回增量） */
export type CharRotationUpdatePresetResponse = PlayerDeltaResponse;
