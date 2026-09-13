/**
 * 统一物品变更管道（GainItemPipeline）测试
 *
 * 建议 4 验收：
 * 1. fluent 链式：setTarget/add 入队、use/handle 执行、队列清空；
 * 2. 执行语义与既有 items:get / items:use 事件直发等价（emit 载荷一致）；
 * 3. 空队列 no-op。
 */
import { describe, it, expect } from "vitest";
import { GainItemPipeline, type PipelineItem } from "@game/kernel/inventory-pipeline";
import type { PlayerDataManager } from "@game/kernel/PlayerDataManager";
import { mockTypedEventEmitter } from "../../helpers";

/** 记录到的 emit（事件名 + 载荷实参） */
interface RecordedEmit {
  event: "items:get" | "items:use";
  args: [PipelineItem[]];
}

/**
 * 夹具：真实事件总线 + 订阅待断言的两个事件
 *
 * 用 `tests/helpers#mockTypedEventEmitter()`（真实 TypedEventEmitter）承接，经 `on` 订阅
 * 记录载荷——而不是手写 `{ emit }` 替身再 `as unknown as TypedEventEmitter`
 * （Emittery 的 emit 是复杂泛型，替身无法结构兼容，断言会掩盖签名漂移）。
 */
function makeEnv() {
  const emitted: RecordedEmit[] = [];
  const trigger = mockTypedEventEmitter();
  trigger.on("items:get", ([items]) => {
    emitted.push({ event: "items:get", args: [items] });
  });
  trigger.on("items:use", ([items]) => {
    emitted.push({ event: "items:use", args: [items] });
  });
  const player = {} as PlayerDataManager;
  return { player, trigger, emitted };
}

describe("GainItemPipeline", () => {
  it("setTarget 入队并链式执行 use（emit items:use 载荷一致）", async () => {
    const { player, trigger, emitted } = makeEnv();
    const pipe = new GainItemPipeline(player, trigger);
    await pipe
      .setTarget("TKT_GACHA", "TKT_GACHA", 1)
      .setTarget("4003", "DIAMOND_SHD", 600)
      .use();
    expect(emitted).toEqual([
      {
        event: "items:use",
        args: [
          [
            { id: "TKT_GACHA", type: "TKT_GACHA", count: 1, instId: undefined },
            { id: "4003", type: "DIAMOND_SHD", count: 600, instId: undefined },
          ],
        ],
      },
    ]);
    expect(pipe.size).toBe(0); // 执行后清空
  });

  it("add 入队并链式执行 handle（emit items:get 载荷一致）", async () => {
    const { player, trigger, emitted } = makeEnv();
    const pipe = new GainItemPipeline(player, trigger);
    await pipe.add({ id: "4002", type: "DIAMOND", count: 1 }).handle();
    expect(emitted).toEqual([
      {
        event: "items:get",
        args: [[{ id: "4002", type: "DIAMOND", count: 1 }]],
      },
    ]);
    expect(pipe.size).toBe(0);
  });

  it("空队列 no-op（不 emit）", async () => {
    const { player, trigger, emitted } = makeEnv();
    const pipe = new GainItemPipeline(player, trigger);
    await pipe.use();
    await pipe.handle();
    expect(emitted).toEqual([]);
  });

  it("clear 清空队列", () => {
    const { player, trigger } = makeEnv();
    const pipe = new GainItemPipeline(player, trigger);
    pipe.setTarget("a", "b", 1).setTarget("c", "d", 2);
    expect(pipe.size).toBe(2);
    pipe.clear();
    expect(pipe.size).toBe(0);
  });

  it("targets 只读快照可断言", () => {
    const { player, trigger } = makeEnv();
    const pipe = new GainItemPipeline(player, trigger);
    pipe.setTarget("x", "y", 3, 7);
    expect([...pipe.targets]).toEqual([
      { id: "x", type: "y", count: 3, instId: 7 },
    ]);
  });
});
