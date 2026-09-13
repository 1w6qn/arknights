/**
 * 未建模 JSON 值的只读形状收窄（跨模块共享纯函数）
 *
 * 生成类型里活动详情等字典是 `{ [key: string]: JsonValue }`——异构子形状未声明。
 * 消费侧此前各自写 `as any` / `as {...}` 直达（把类型系统整段关掉），或用局部最小副本；
 * 本文件把「按调用方声明的局部视图读取」收口到一处，**仍然是精确类型而非 any**。
 *
 * 2026-09-13 由 `modules/activities/shared/activity-json.ts` 上移 kernel：kernel 层的
 * `inventory.ts` 曾因 R2（kernel 不得 import modules）被迫保留一份最小副本
 * （`asJsonShape`），上移后一处定义、两处复用。
 *
 * **用途仅限只读 excel 表数据**：形状由官方数据保证、服务端不写回。玩家存档内未建模
 * 字段禁止 JsonValue（mutative Draft 会 TS2589），存档一律走具名成员登记。
 */
import { isJsonObject, type JsonObject, type JsonValue } from "@excel/json-value";

/**
 * `JsonValue | undefined` → JSON 对象收窄
 *
 * `json-value.ts` 的 {@link isJsonObject} 只接受 `JsonValue`（undefined 不在 JSON 域内），
 * 而可选链取值天然产生 `JsonValue | undefined`，故在此收口。
 * @param value - 待判定值
 * @returns 是否为 JSON 对象
 */
export function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && isJsonObject(value);
}

/**
 * JSON 值 → 字符串键字典视图（非对象按空表处理）
 * @param value - 原始 JSON 值
 * @returns 调用方声明的条目类型字典
 */
export function asRecord<T>(value: JsonValue | undefined): Record<string, T> {
  return (isJsonObjectValue(value) ? value : {}) as Record<string, T>;
}

/**
 * JSON 值 → 数组视图（非数组按空数组处理）
 * @param value - 原始 JSON 值
 * @returns 调用方声明的条目类型数组
 */
export function asArray<T>(value: JsonValue | undefined): T[] {
  return (Array.isArray(value) ? value : []) as T[];
}

/**
 * JSON 值 → 对象视图（非对象返回 undefined）
 * @param value - 原始 JSON 值
 * @returns 调用方声明的对象类型
 */
export function asShape<T>(value: JsonValue | undefined): T | undefined {
  return isJsonObjectValue(value) ? (value as T) : undefined;
}
