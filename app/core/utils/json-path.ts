/**
 * JSON 路径读写工具（严格类型，零 `any`）
 *
 * 用途：对「形状运行时才确定」的 JSON 子树做按路径读写——典型场景是运营后台
 * 的上帝视角补丁（`AdminService#applyRlv2Patch`：`player.property.hp.current`
 * 这类点分路径）、以及任何需要沿着不确定层级的对象/数组下钻的代码。
 *
 * 为什么需要它：此前这类代码写作 `(cur as any)[key]`——因为容器既可能是对象
 * 也可能是数组，联合类型下 `container[key] = value` 无法通过类型检查，于是用 `as any`
 * 把类型系统整段关掉（见 docs/type-system-audit.md §2.1）。本模块把这个「容器
 * 形态分派」收敛到一处，用 {@link JsonValue} 的联合分支 + `Array.isArray` 收窄，
 * 调用方拿到的是 `JsonValue`，必须显式收窄后才能当具体类型用。
 *
 * 语义（与迁移前的 `AdminService#applyRlv2Patch` 保持一致）：
 *  - 段为字符串；对**数组**容器，纯数字段按下标处理，非数字段视为无效（不写入）；
 *  - `setIn` 会自动创建缺失的中间容器（对象）；显式传 `undefined` 等价于删除该段；
 *  - `delIn` 对数组用 `splice`（元素前移，与旧实现一致），对对象用 `delete`；
 *  - `incIn` 以 `Number(旧值 ?? 0) + delta` 写回（旧值非数值时结果为 `NaN`，与旧实现一致）；
 *  - 全部为**原地修改**：调用方传入的子树会被直接改写（RLV2 是 autoFreeze 兼容的可写孤岛）。
 *
 * 位置：2026-09-13 由 `app/game/kernel/util/json-path.ts` 下沉 `app/core/utils/`（仅依赖
 * 同为 core 的 `@utils/json-value`，零 game 语义），使 ops/scripts 复用不再经 game。
 */
import type { JsonObject, JsonValue } from "./json-value";

/** 路径段数组（如 `["player", "property", "hp", "current"]`） */
export type JsonPath = readonly string[];

/** 可变容器：JSON 对象或 JSON 数组 */
type JsonContainer = JsonObject | JsonValue[];

/**
 * 判断路径段是否为数组下标
 * @param seg - 路径段
 * @returns 是否为非负整数写法
 */
function isIndexSeg(seg: string): boolean {
  return /^\d+$/.test(seg);
}

/**
 * 把未知值收窄为 JSON 容器
 *
 * 入口刻意接受**任意**入参（泛型 `T`，不限 `JsonValue`）：调用方手里的根往往是
 * `Record<string, unknown>`、管理器实例或类实例，强制它们先转成 `JsonValue`
 * 只会把 cast 推回调用点。此处一次性按运行时形态收窄，之后全程走 `JsonValue` 分支。
 * @param value - 待判断的值
 * @returns 容器（对象或数组）；标量、null、undefined 返回 undefined
 */
function asContainer<T>(value: T): JsonContainer | undefined {
  if (Array.isArray(value)) return value as JsonValue[];
  if (typeof value !== "object" || value === null) return undefined;
  return value as JsonObject;
}

/**
 * 把「形状由调用方保证」的外部值接入 JSON 域
 *
 * 唯一用途：请求体等外部输入进入路径补丁时，类型面需要一个明确的接纳点
 * （对应迁移前 `(container as any)[last] = value` 的行为——不做运行时校验）。
 * 该收窄只影响类型，不改变值本身。
 * @param value - 外部值
 * @returns 同一值的 JSON 域视图
 */
export function acceptJsonValue<T>(value: T): JsonValue {
  return value as JsonValue;
}

/**
 * 读取容器的子节点
 *
 * 数组只接受数字下标段（非数字段视为不存在），对象按键读取。
 * @param node - 容器
 * @param seg - 路径段
 * @returns 子节点；不存在时为 undefined
 */
function readChild(node: JsonContainer, seg: string): JsonValue | undefined {
  if (Array.isArray(node)) return isIndexSeg(seg) ? node[Number(seg)] : undefined;
  return node[seg];
}

/**
 * 写入容器的子节点
 *
 * 数组只接受数字下标段（非数字段不写入——数组不是字典），对象按键写入。
 * @param node - 容器
 * @param seg - 路径段
 * @param value - 目标值
 */
function writeChild(node: JsonContainer, seg: string, value: JsonValue): void {
  if (Array.isArray(node)) {
    if (isIndexSeg(seg)) node[Number(seg)] = value;
    return;
  }
  node[seg] = value;
}

/**
 * 删除容器的子节点
 *
 * 数组按 `splice` 前移（与旧实现的 `container.splice(idx, 1)` 一致），对象用 `delete`。
 * @param node - 容器
 * @param seg - 路径段
 */
function deleteChild(node: JsonContainer, seg: string): void {
  if (Array.isArray(node)) {
    if (isIndexSeg(seg)) node.splice(Number(seg), 1);
    return;
  }
  delete node[seg];
}

/**
 * 沿路径下钻，返回「父容器 + 末段」
 *
 * 中间段缺失或非容器时按 `create` 决定是否补建空对象；数组下标越界不补建
 * （写入 `arr[i]` 由 JS 语义自然扩展，与旧实现一致）。
 * @param root - 根节点（必须已是容器）
 * @param segs - 完整路径段（至少 1 段）
 * @param create - 中间容器缺失时是否补建空对象
 * @returns 父容器与末段；路径不可达时返回 undefined
 */
function resolveParent(
  root: JsonContainer,
  segs: JsonPath,
  create: boolean,
): { parent: JsonContainer; last: string } | undefined {
  if (segs.length === 0) return undefined;
  let cur: JsonContainer = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = readChild(cur, seg);
    const container = asContainer(next);
    if (container) {
      cur = container;
      continue;
    }
    if (!create) return undefined;
    const fresh: JsonObject = {};
    writeChild(cur, seg, fresh);
    cur = fresh;
  }
  return { parent: cur, last: segs[segs.length - 1] };
}

/**
 * 按路径读取值
 * @param root - 根节点（任意值；非容器时返回 undefined）
 * @param segs - 路径段
 * @returns 目标值；路径不可达时为 undefined
 */
export function getIn<T>(root: T, segs: JsonPath): JsonValue | undefined {
  const start = asContainer(root);
  if (!start) return undefined;
  const resolved = resolveParent(start, segs, false);
  if (!resolved) return undefined;
  return readChild(resolved.parent, resolved.last);
}

/**
 * 按路径写入值（自动补建缺失的中间对象）
 *
 * `value` 显式传 `undefined` 表示删除该段（与旧实现一致：避免把 undefined 留在 JSON 里）。
 * @param root - 根节点（任意值；非容器时为无操作）
 * @param segs - 路径段
 * @param value - 目标值；`undefined` 表示删除
 */
export function setIn<T>(
  root: T,
  segs: JsonPath,
  value: JsonValue | undefined,
): void {
  const start = asContainer(root);
  if (!start) return;
  const resolved = resolveParent(start, segs, true);
  if (!resolved) return;
  if (value === undefined) deleteChild(resolved.parent, resolved.last);
  else writeChild(resolved.parent, resolved.last, value);
}

/**
 * 按路径删除节点
 * @param root - 根节点（任意值；非容器时为无操作）
 * @param segs - 路径段
 */
export function delIn<T>(root: T, segs: JsonPath): void {
  const start = asContainer(root);
  if (!start) return;
  const resolved = resolveParent(start, segs, false);
  if (!resolved) return;
  deleteChild(resolved.parent, resolved.last);
}

/**
 * 按路径做数值累加（`Number(旧值 ?? 0) + delta`）
 *
 * 缺失路径会自动补建中间对象（与 `setIn` 一致）；旧值非数值时结果为 `NaN`
 * ——与迁移前行为保持一致，调用方需自行保证目标位置是数字。
 * @param root - 根节点（任意值；非容器时为无操作）
 * @param segs - 路径段
 * @param delta - 增量，默认 1
 */
export function incIn<T>(root: T, segs: JsonPath, delta = 1): void {
  const start = asContainer(root);
  if (!start) return;
  const resolved = resolveParent(start, segs, true);
  if (!resolved) return;
  const base = Number(readChild(resolved.parent, resolved.last) ?? 0);
  writeChild(resolved.parent, resolved.last, base + delta);
}
