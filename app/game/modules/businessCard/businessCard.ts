/**
 * 名片（NameCard / businessCard）协议类型
 *
 * 对应客户端 com.hypergryph.arknights_2.7.61.cs 中 Torappu 命名空间的
 * ChangeNameCardSkinRequest / ChangeNameCardComponentRequest / EditNameCardRequest /
 * GetOtherPlayerNameCardRequest 等 Request/Response 类；字段以服务端契约为准，
 * CS 存在但服务端未读取的字段（如 GetOtherPlayerNameCardRequest.src）标为可选。
 * 设置名片展示勋章（SetCardShowMedal）相关类型见协议 social.ts。
 */
import { FriendDataWithNameCard } from "../../kernel/social-model";
import { PlayerNameCardMisc } from "../../kernel/playerdata";
import { PlayerDeltaResponse } from "../../kernel/http/common";

/** 更换名片皮肤请求（CS: ChangeNameCardSkinRequest） */
export interface ChangeNameCardSkinRequest {
  skinId: string;
}

/** 更换名片皮肤响应（CS: ChangeNameCardSkinResponse） */
export type ChangeNameCardSkinResponse = PlayerDeltaResponse;

/** 更换名片组件请求（CS: ChangeNameCardComponentRequest） */
export interface ChangeNameCardComponentRequest {
  component: string[];
}

/** 更换名片组件响应（CS: ChangeNameCardComponentResponse） */
export type ChangeNameCardComponentResponse = PlayerDeltaResponse;

/**
 * 编辑名片内容（CS: EditNameCardContent { skinId, component, misc, skinTmpl }）
 * 服务端仅读取 skinId/component/misc，skinTmpl 未使用；字段可空，均标为可选
 */
export interface EditNameCardContent {
  skinId?: string;
  component?: string[];
  misc?: PlayerNameCardMisc;
}

/**
 * 编辑名片请求（CS: EditNameCardRequest { flag: EditNameCardFlag, content: EditNameCardContent }）
 * flag 对应 CS EditNameCardFlag 枚举数值（1=组件 / 2=皮肤 / 4=杂项）
 */
export interface EditNameCardRequest {
  flag: number;
  content: EditNameCardContent;
}

/** 编辑名片响应（CS: EditNameCardResponse） */
export type EditNameCardResponse = PlayerDeltaResponse;

/**
 * 获取其他玩家名片请求（CS: GetOtherPlayerNameCardRequest { uid, src }）
 * CS 另有 src 字段，服务端未读取，标为可选
 */
export interface GetOtherPlayerNameCardRequest {
  uid: string;
  src?: string;
}

/** 获取其他玩家名片响应（CS: GetOtherPlayerNameCardResponse） */
export interface GetOtherPlayerNameCardResponse extends PlayerDeltaResponse {
  nameCard: FriendDataWithNameCard;
}
