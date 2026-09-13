/**
 * 未校验 JSON 值类型（严格 JSON 域）——**规范定义**
 *
 * 位置说明：本文件在 `app/core/utils/`（基础设施内核）而非 `app/game/excel/`，因为
 * core 的 I/O 工具（`readJson` / `decryptBattleReplay` 等）也需要它，而架构守卫
 * R1 禁止 core → game 的依赖。`@excel/json-value`（`app/game/excel/json-value.ts`）
 * 是本文件的 **re-export**，故业务与生成类型的既有 import 路径全部不变。
 *
 * 用途：生成类型里那些「服务端/表数据形状未在客户端模型中声明」的字段。
 * 此前这些字段一律标成 TS 的 `object` 关键字——它既不能索引也不能取属性，
 * 逼得调用方到处写 `as any` 逃生，等于把类型系统整段关掉（见
 * docs/type-system-audit.md §1）。改用递归 JSON 联合后：
 *
 *  - 仍然是严格类型：不是 `any`/`unknown`，赋值与取属性都受检查；
 *  - 取属性返回 `JsonValue`，调用方必须显式收窄（`typeof`/zod）才能当具体类型用；
 *  - 语义诚实：这些位置确实是「未经校验的 JSON」，不是「任意值」。
 *
 * 生成器（scripts/types-builder.ts）会把 `object` 关键字统一改写成本类型的
 * `JsonValue`，因此生成文件里不应再出现裸 `object`。
 */

/** 任意 JSON 值（递归联合，含 null 与数组） */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 任意 JSON 对象（键为 string，值为 JsonValue） */
export type JsonObject = { [key: string]: JsonValue };

/** 服务端未建模 payload 的标量叶子 */
export type ServerPayloadLeaf = string | number | boolean | null;

/**
 * 深度受限的服务端 payload（**Draft 安全**）
 *
 * mutative 的 `Draft<T>` 会对 T 做递归映射，任何**递归类型**放进 PlayerDataModel 都会
 * 触发 TS2589「类型实例化过深且可能无限」（实测：`JsonValue` 内的
 * `{ [key: string]: JsonValue }` 分支使 Drain 无限展开）。因此玩家存档里的
 * 未建模字段必须使用非递归形态：显式展开两层（标量 / 标量数组 / 一层嵌套对象）。
 *
 * 相比原先的 `object`：仍可索引、可取属性、可 `Object.keys`，但不再是「万能」类型——
 * 访问第三层会直接报错，迫使调用方显式收窄或补精确类型。
 */
export type ServerPayload =
  | ServerPayloadLeaf
  | ServerPayloadLeaf[]
  | { [key: string]: ServerPayloadLeaf | ServerPayloadLeaf[] };

/**
 * 运行时判断一个值是否为 JSON 对象（非 null、非数组）
 *
 * 用于把 `JsonValue` 收窄为可安全取属性的形态。
 * @param value - 待判断的值
 * @returns 是否为普通对象
 */
export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 运行时判断一个值是否为 JSON 数组
 * @param value - 待判断的值
 * @returns 是否为数组
 */
export function isJsonArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}
