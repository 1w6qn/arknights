/**
 * 社交协议类型
 *
 * 对应客户端 com.hypergryph.arknights_2.7.61.cs 中 Torappu 命名空间的
 * DeleteFriendRequest / SendFriendRequest / GetFriendListRequest 等 Request/Response 类；
 * 字段以 CS 类为准，服务端未返回的协议字段（如部分 result/starFriendList）标为可选。
 */
import { PlayerDeltaResponse } from "../../kernel/http/common";
import { FriendData, FriendDataWithNameCard } from "../../kernel/social-model";
import { PlayerFriendAssist } from "../../kernel/model";

/** 删除好友请求（CS: DeleteFriendRequest；CS 字段名为 friendId，服务端契约为 id） */
export interface DeleteFriendRequest {
  id: string;
}

/** 删除好友响应（CS: DeleteFriendResponse） */
export type DeleteFriendResponse = PlayerDeltaResponse;

/** 发送好友申请请求（CS: SendFriendRequest） */
export interface SendFriendRequest {
  friendId: string;
  afterBattle: number;
  originType: number;
  battleOrigin: string | null;
}

/** 发送好友申请响应（CS: SendFriendResponse；服务端省略 result） */
export interface SendFriendResponse extends PlayerDeltaResponse {
  result?: number;
}

/**
 * 处理好友申请请求（CS: ProcessFriendRequest）
 * action 对应 CS FriendDealEnum（ACCEPT=1 / REFUSE=0）
 */
export interface ProcessFriendRequest {
  friendId: string;
  action: number;
}

/**
 * 处理好友申请响应（CS: ProcessFriendResponse）
 * CS 返回 result 字段，服务端实际返回 friendNum（当前好友数量）
 */
export interface ProcessFriendResponse extends PlayerDeltaResponse {
  friendNum: number;
}

/**
 * 获取好友排序列表请求（CS: GetSortListInfoRequest）
 * type 对应 CS FriendServiceType（SEARCH_FRIEND=0 / GET_FRIEND_LIST=1 / GET_FRIEND_REQUEST=2）
 */
export interface GetSortListInfoRequest {
  type: number;
  sortKeyList: string[];
  param: { [key: string]: string };
}

/**
 * 获取好友排序列表响应（CS: GetSortListInfoResponse；服务端省略 starFriendList）
 * CS 的 result 为 List<FriendSortViewModel>，服务端返回各分支的部分好友字段，故用 Partial；
 * 服务端契约 result 在 type 非法时可能为 undefined，标为可选
 */
export interface GetSortListInfoResponse extends PlayerDeltaResponse {
  result?: Partial<FriendDataWithNameCard>[];
  starFriendList?: string[];
}

/** 搜索玩家请求（CS: SearchPlayerRequest） */
export interface SearchPlayerRequest {
  idList: string[];
}

/**
 * 搜索玩家响应（CS: SearchPlayerResponse）
 * friendStatusList 对应 CS FriendStatus 枚举数值（NORMAL=0/ALREADY_SEND=1/ALREADY_ADD=2）；
 * 注：CS 的 SearchPlayerResponse 不继承 PlayerDeltaResponse，服务端额外返回增量
 */
export interface SearchPlayerResponse extends PlayerDeltaResponse {
  players: FriendDataWithNameCard[];
  friendStatusList: number[];
  resultIdList: string[];
}

/** 获取好友列表请求（CS: GetFriendListRequest） */
export interface GetFriendListRequest {
  idList: string[];
}

/** 获取好友列表响应（CS: GetFriendListResponse） */
export interface GetFriendListResponse extends PlayerDeltaResponse {
  friends: FriendDataWithNameCard[];
  friendAlias: string[];
  resultIdList: string[];
}

/** 获取好友申请列表请求（CS: GetFriendRequestListRequest） */
export interface GetFriendRequestListRequest {
  idList: string[];
}

/** 获取好友申请列表响应（CS: GetFriendRequestResponse） */
export interface GetFriendRequestResponse extends PlayerDeltaResponse {
  requestList: FriendData[];
  resultIdList: string[];
}

/**
 * 设置助战干员列表请求（CS: SetAssistCharListRequest）
 * CS 的 assistCharList 为 List<RequestAssistChar>（charInstId/S_skillIndex/S_currentEquip 等），
 * 服务端契约为 PlayerFriendAssist[]，此处以服务端为准
 */
export interface SetAssistCharListRequest {
  assistCharList: PlayerFriendAssist[];
}

/** 设置助战干员列表响应（CS: SetAssistCharListResponse） */
export type SetAssistCharListResponse = PlayerDeltaResponse;

/** 设置星标好友请求（CS: SetStarFriendListRequest） */
export interface SetStarFriendListRequest {
  idList: string[];
}

/** 设置星标好友响应（CS: SetStarFriendListResponse） */
export interface SetStarFriendListResponse extends PlayerDeltaResponse {
  /** CS: SetStarFriendListResponse.Result 枚举（SUCC=0 / FAIL=1） */
  result: number;
  newIdList: string[];
}

/** 设置好友备注请求（CS: SetFriendAliasRequest） */
export interface SetFriendAliasRequest {
  friendId: string;
  alias: string;
}

/** 设置好友备注响应（CS 类名称为 SetAssistAliasResponse，命名与功能不符） */
export type SetFriendAliasResponse = PlayerDeltaResponse;

/** 领取社交点请求（CS: ReceiveSocialPointRequest，无字段） */
export interface ReceiveSocialPointRequest {}

/** 领取社交点响应（CS: ReceiveSocialPointResponse；服务端省略 reward） */
export interface ReceiveSocialPointResponse extends PlayerDeltaResponse {
  reward?: unknown[];
}

/**
 * 设置名片展示勋章请求（CS: SetCardShowMedalRequest）
 * CS 的 type 为 NameCardMedalType 枚举，服务端契约使用字符串（CUSTOM/TEMPLATE）
 */
export interface SetCardShowMedalRequest {
  type: string;
  customIndex: string;
  templateGroup: string;
}

/** 设置名片展示勋章响应（CS: SetCardShowMedalResponse） */
export type SetCardShowMedalResponse = PlayerDeltaResponse;
