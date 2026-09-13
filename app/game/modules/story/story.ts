/**
 * 剧情推进（/story/*）协议类型
 *
 * 对应客户端 CS 的 FinishStoryRequest / FinishStoryResponse，字段以 CS 类为准。
 */
import { ItemBundle } from "@excel/excel";
import { PlayerDeltaResponse } from "../../kernel/http/common";

/** 完成剧情请求（CS: FinishStoryRequest） */
export interface FinishStoryRequest {
  storyId: string;
}

/** 完成剧情响应（CS: FinishStoryResponse；服务端返回空 items） */
export interface FinishStoryResponse extends PlayerDeltaResponse {
  items: ItemBundle[];
}
