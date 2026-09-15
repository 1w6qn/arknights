/**
 * resolveGachaRank 保底稀有度解析纯函数测试
 *
 * 由 GachaManager._getRarityRank 拆分出的概率/保底计算，覆盖：
 * - 六星权重修正（非六星连续计数 >50 后每抽 +2%）
 * - 六星命中（rand 注入固定值）
 * - 五星一次性保底（恰达 maxCnt 且未出五星时强制 4）
 * - 非保底权重选择（单权重确定性）
 * - 保底点边界（maxCnt 前/后不触发）
 */
import { describe, it, expect } from "vitest";
import { resolveGachaRank } from "@game/modules/gacha/gacha";

const base = {
  per6Base: 0.02, // totalPercent 为小数概率（0.02 = 2%）
  beforeNonHitCnt: 0,
  nextCnt: 1,
  ranks: [3, 4, 5],
  weights: [0.5, 0.48, 0.02],
};

describe("resolveGachaRank", () => {
  it("未超 50 抽阈值时六星权重不做修正", () => {
    const r = resolveGachaRank({ ...base, beforeNonHitCnt: 49, rand: () => 0.019 });
    expect(r).toBe(5); // per6=0.02，rand=0.019 < 0.02 → 六星
    // 未中六星后会走权重抽取，而权重抽取用的是全局 random（不受注入 rand 控制）——
    // 若沿用 base 的 [3,4,5]/[0.5,0.48,0.02]，有 2% 概率抽到 5（六星）令断言偶发失败。
    // 故与下方用例一致：改用单权重让「非六星」这一分支确定性可断言。
    const r2 = resolveGachaRank({
      ...base,
      beforeNonHitCnt: 49,
      rand: () => 0.021, // 0.021 > 0.02 → 不中六星
      ranks: [3],
      weights: [1],
    });
    expect(r2).toBe(3);
  });

  it("超过 50 抽后每抽 +2% 修正六星权重", () => {
    // 修复（2026-09-09）后曲线：per6 = 2% + max(0, cnt-49)*2%（第 51 抽=4%、第 99 抽=100%）
    // beforeNonHitCnt=60（即第 61 抽）→ per6 = 0.02 + 11*0.02 = 0.24
    const r = resolveGachaRank({ ...base, beforeNonHitCnt: 60, rand: () => 0.23 });
    expect(r).toBe(5); // rand=0.23 < 0.24（修正后命中）
    // 非六星分支用单权重确定性验证（避免权重随机选中五星的 2% 概率波动）
    const r2 = resolveGachaRank({ ...base, beforeNonHitCnt: 60, rand: () => 0.25, ranks: [3], weights: [1] });
    expect(r2).toBe(3); // 0.25 > 0.24 → 非六星，单权重必选 3
  });

  it("第 51 抽概率应为 4%、第 50 抽仍为 2%", () => {
    // 第 50 抽：cnt=49 → 仍为基础 2%
    const r50 = resolveGachaRank({ ...base, beforeNonHitCnt: 49, rand: () => 0.03, ranks: [3], weights: [1] });
    expect(r50).toBe(3); // 0.03 > 0.02 → 非六星
    // 第 51 抽：cnt=50 → 4%
    const r51 = resolveGachaRank({ ...base, beforeNonHitCnt: 50, rand: () => 0.03 });
    expect(r51).toBe(5); // 0.03 < 0.04 → 六星
    // 第 99 抽：cnt=98 → 100% 必得
    const r99 = resolveGachaRank({ ...base, beforeNonHitCnt: 98, rand: () => 0.999 });
    expect(r99).toBe(5);
  });

  it("rand 高于修正后权重时不中六星，走权重选择", () => {
    const r = resolveGachaRank({
      ...base,
      beforeNonHitCnt: 60,
      rand: () => 0.5, // 0.5 > 0.22 → 非六星
      ranks: [3],
      weights: [1], // 单权重：必选 3（确定性）
    });
    expect(r).toBe(3);
  });

  it("恰达五星保底点且未出五星时强制 4", () => {
    const r = resolveGachaRank({
      ...base,
      nextCnt: 10,
      maxCnt: 10,
      rand: () => 0.99, // 必不中六星
      weights: [1, 0, 0], // 权重只可能选到 3
    });
    expect(r).toBe(4); // 3 < 4 且 atGuarantee → 强制升 4
  });

  it("保底点之前不强制五星", () => {
    const r = resolveGachaRank({
      ...base,
      nextCnt: 9,
      maxCnt: 10,
      rand: () => 0.99,
      weights: [1, 0, 0],
    });
    expect(r).toBe(3); // 非保底点，保持原稀有度
  });

  it("保底点之后（一次性事件已过）不再强制", () => {
    const r = resolveGachaRank({
      ...base,
      nextCnt: 11,
      maxCnt: 10,
      rand: () => 0.99,
      weights: [1, 0, 0],
    });
    expect(r).toBe(3);
  });

  it("抽到五星及以上时不触发五星保底（保持原稀有度）", () => {
    const r = resolveGachaRank({
      ...base,
      nextCnt: 10,
      maxCnt: 10,
      rand: () => 0.99,
      weights: [0, 1, 0], // 权重只可能选到 4
    });
    expect(r).toBe(4); // 已 >=4，不再强制
  });

  it("maxCnt 缺省按 10", () => {
    const r = resolveGachaRank({
      ...base,
      nextCnt: 10,
      rand: () => 0.99,
      weights: [1, 0, 0],
    });
    expect(r).toBe(4);
  });

  it("六星权重基础值兜底 2 时必中六星（详情无六星条目，原实现行为）", () => {
    const r = resolveGachaRank({
      per6Base: 2,
      beforeNonHitCnt: 0,
      nextCnt: 1,
      ranks: [3, 4],
      weights: [0.5, 0.5],
      rand: () => 0.99, // 任意值均 <= 2
    });
    expect(r).toBe(5);
  });
});
