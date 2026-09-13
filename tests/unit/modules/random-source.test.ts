/**
 * 可注入随机源（建议 15）：setRandSource 注入确定性、resetRandSource 恢复默认
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { random, resetRandSource, setRandSource } from "@utils/random";

afterEach(() => {
  resetRandSource();
  vi.restoreAllMocks();
});

describe("随机源注入（domain/util/random）", () => {
  it("setRandSource 注入后 random() 返回固定值", () => {
    setRandSource(() => 0.42);
    expect(random()).toBe(0.42);
    expect(random()).toBe(0.42);
  });

  it("resetRandSource 后恢复 Math.random（可被 vi.spyOn 接管）", () => {
    resetRandSource();
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.7);
    expect(random()).toBe(0.7);
    spy.mockRestore();
  });

  it("默认源动态读取 Math.random（既有测试 mock 兼容）", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.3);
    expect(random()).toBe(0.3);
    spy.mockRestore();
  });
});
