/**
 * JSON 路径读写工具单测（app/core/utils/json-path.ts）
 *
 * 覆盖 get/set/del/inc 的路径语义、数组下标处理、中间容器自动补建，
 * 以及「数组非数字段不写入」这一相对旧实现的收紧行为。
 * 迁移前语义由 tests/unit/admin/rlv2-modify.test.ts 持续覆盖（AdminService 调用方）。
 */
import { describe, it, expect } from "vitest";
import type { JsonValue } from "@excel/json-value";
import { acceptJsonValue, delIn, getIn, incIn, setIn } from "@utils/json-path";

describe("json-path 路径读写", () => {
  it("getIn 按路径读取，路径不可达或根非容器时返回 undefined", () => {
    const root: JsonValue = { a: { b: [{ c: 7 }] } };
    expect(getIn(root, ["a", "b", "0", "c"])).toBe(7);
    expect(getIn(root, ["a", "missing"])).toBeUndefined();
    expect(getIn(root, ["a", "b", "9"])).toBeUndefined();
    expect(getIn(42, ["a"])).toBeUndefined();
    expect(getIn(null, ["a"])).toBeUndefined();
    expect(getIn(undefined, ["a"])).toBeUndefined();
    expect(getIn(root, [])).toBeUndefined();
  });

  it("setIn 写入标量并自动补建中间对象", () => {
    const root: JsonValue = {};
    setIn(root, ["x", "y", "z"], 5);
    expect(root).toEqual({ x: { y: { z: 5 } } });
  });

  it("setIn 对数组按数字下标写入（越界按下标扩展）", () => {
    const root: JsonValue = { list: [{ id: 1 }] };
    setIn(root, ["list", "1", "id"], 2);
    expect(root).toEqual({ list: [{ id: 1 }, { id: 2 }] });
  });

  it("setIn 传 undefined 表示删除（对象删键 / 数组 splice）", () => {
    const root: JsonValue = { keep: 1, gone: 2, arr: [10, 20, 30] };
    setIn(root, ["gone"], undefined);
    setIn(root, ["arr", "1"], undefined);
    expect(root).toEqual({ keep: 1, arr: [10, 30] });
  });

  it("delIn 删除对象键与数组元素，路径不可达时无操作", () => {
    const root: JsonValue = { obj: { a: 1, b: 2 }, arr: [10, 20, 30] };
    delIn(root, ["obj", "a"]);
    delIn(root, ["arr", "0"]);
    delIn(root, ["nope", "deep"]);
    expect(root).toEqual({ obj: { b: 2 }, arr: [20, 30] });
  });

  it("incIn 从 0 起步累加 / 显式增量 / 数组下标累加", () => {
    const root: JsonValue = { n: 5, blank: {}, arr: [1] };
    incIn(root, ["n"], 3);
    incIn(root, ["blank", "x"], 7);
    incIn(root, ["arr", "0"]);
    expect(root).toEqual({ n: 8, blank: { x: 7 }, arr: [2] });
  });

  it("incIn 旧值非数值时结果为 NaN（与迁移前行为一致）", () => {
    const root: JsonValue = { s: "abc" };
    incIn(root, ["s"], 1);
    expect(Number.isNaN(Number((root as { s: JsonValue }).s))).toBe(true);
  });

  it("数组容器遇到非数字段不写入（收紧：数组不是字典）", () => {
    const root: JsonValue = { arr: [1, 2] };
    setIn(root, ["arr", "foo"], 9);
    incIn(root, ["arr", "bar"], 1);
    expect(root).toEqual({ arr: [1, 2] });
  });

  it("根为非容器时写操作静默无操作", () => {
    const root: JsonValue = 42;
    setIn(root, ["a"], 1);
    delIn(root, ["a"]);
    incIn(root, ["a"], 1);
    expect(root).toBe(42);
  });

  it("acceptJsonValue 原样接纳外部值（仅收窄类型面）", () => {
    const payload = { nested: [1, "two", null] };
    expect(acceptJsonValue(payload)).toBe(payload);
  });
});
