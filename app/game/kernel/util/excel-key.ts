/**
 * excel 字典键容错解析（跨模块共享纯函数）
 *
 * excel 的 activity 等字典键随数据版本大小写/下划线多变（旧数据 `dEFAULT`/`TYPE_ACT3D0`
 * 等坏键、解码规范的 `default`/`typeAct3D0`），按 `lowerFirst(枚举)` 读取恒有错位风险。
 * 本函数做「大小写 + 下划线不敏感」匹配——任意版本下都能命中实际键。
 *
 * 设计约束（2026-09-13 由 `modules/activities/shared/unlockActivity` 上移 kernel）：
 * **刻意不 import `@excel/excel` 单例**——字典由调用方传入。这既让 kernel 层不再需要
 * 反向依赖 modules（R2，见 tests/unit/architecture/module-boundary.test.ts），也不新增
 * excel 单例直连（棘轮守卫 excel-singleton-ratchet.test.ts）。
 */
import type { JsonValue } from "@excel/json-value";

/**
 * 在字典中按「大小写/下划线不敏感」定位实际键
 * @param dict - 目标字典（如 `excel.ActivityTable.activity`）；缺省视为空表
 * @param type - 枚举名（如 `"TYPE_ACT3D0"` / `"COLLECTION"`）
 * @returns 字典实际键；未命中返回 undefined
 */
export function resolveDictKey(
  dict: Readonly<Record<string, JsonValue>> | undefined,
  type: string,
): string | undefined {
  if (!dict) return undefined;
  const norm = type.replace(/_/g, "").toLowerCase();
  return Object.keys(dict).find(
    (k) => k.replace(/_/g, "").toLowerCase() === norm,
  );
}
