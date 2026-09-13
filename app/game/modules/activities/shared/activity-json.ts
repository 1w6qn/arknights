/**
 * 活动 excel 未建模 JSON 读取辅助
 *
 * 生成类型里 `ActivityTable.activity` 是 `{ [typeKey: string]: JsonValue }`——异构活动详情，
 * 客户端模型未声明各活动的子形状。此前消费侧用 `as any` / `as {...}` 直达，
 * 把类型系统整段关掉；本文件把「按已知形状读取只读表数据」收口到一处：
 *
 * - {@link activityDetailJson} 做 `activity[typeKey][actId]` 的逐级对象收窄；
 * - {@link asRecord} / {@link asArray} / {@link asShape} / {@link isJsonObjectValue}
 *   是**通用** JSON 形状收窄，2026-09-13 已上移 `@game/kernel/util/json-shape`
 *   （kernel 的 `inventory.ts` 曾因 R2 被迫保留一份最小副本），本文件仅 re-export。
 *
 * **用途仅限只读 excel 表数据**：形状由官方数据保证、服务端不写回。
 * 玩家存档内未建模字段禁止 JsonValue（mutative Draft 会 TS2589），存档一律走
 * `playerdata-server-adapt.ts` 的具名成员登记 + `ServerPayload`。
 *
 * 本文件不 import `@excel/excel` 单例（excel 端口守卫棘轮禁止新增直连）——
 * `activity` 字典由调用方传入。
 */
import type { JsonObject } from "@excel/json-value";
import { isJsonObjectValue } from "../../../kernel/util/json-shape";

export { asArray, asRecord, asShape, isJsonObjectValue } from "../../../kernel/util/json-shape";

/**
 * 取活动详情对象（`activity[typeKey][actId]`）
 * @param activity - excel `ActivityTable.activity` 字典（调用方传入，避免单例直连）
 * @param typeKey - `activity` 字典的实际键（调用方经 activityDictKey 容错解析）
 * @param actId - 活动 id
 * @returns 活动详情对象（任一环缺失/非对象返回 undefined）
 */
export function activityDetailJson(
  activity: JsonObject,
  typeKey: string,
  actId: string,
): JsonObject | undefined {
  const typeDict = activity[typeKey];
  if (!isJsonObjectValue(typeDict)) return undefined;
  const detail = typeDict[actId];
  return isJsonObjectValue(detail) ? detail : undefined;
}
