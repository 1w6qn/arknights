import { describe, it, expect } from "vitest";

/**
 * 回溯插曲解锁（unlockRetroBlock）
 *
 * 修复（2026-09-09，审计 §5.4-8）：原实现无条件 coin -= 1 并置 open →
 * ① 结晶可扣成负数；② 重复请求对已开放插曲反复扣费；③ 费用写死不读 retroUnlockCost。
 * 官方规则原文（data/excel/retro_table.json → retroDetail）：
 * 「消耗 {1} 个【事相结晶】，可解锁 1 个【插曲】」，{1} = retroUnlockCost。
 */
// excel 数据端口替身:RetroManager 经 `player.excel` 取表(不再是模块级 mock)
// 以 mockExcelWith 的空表底座（含门面方法）承载，只覆盖被测分支读到的表
const excelMock = mockExcelWith({
    // 故意取 2 以验证「读数据而非写死 1」；其余常量取真实数据值
    // （data/excel/retro_table.json：initRetroCoin 2 / retroCoinPerWeek 3 /
    //  retroCoinMaxOfLevels {"60":3}）
    RetroTable: {
      retroUnlockCost: 2,
      initRetroCoin: 2,
      retroCoinPerWeek: 3,
      retroCoinMaxOfLevels: { "60": 3 },
    },
    ActivityTable: { activity: {} },
});

import type { PlayerDataModel } from "@game/kernel/playerdata";
import { RetroManager } from "@game/modules/retro/retro-manager";
import {
  asPlayerManager,
  mockExcelWith,
  mockPlayerData,
  mockTypedEventEmitter,
  type MockSeed,
} from "../../helpers";

function makePlayer(retro: MockSeed<PlayerDataModel["retro"]>, level = 1) {
  const pd = mockPlayerData({
    retro,
    status: { level },
    pushFlags: {},
  });
  // excel 数据端口替身注入
  pd.excel = excelMock;
  return pd;
}

/** 时间 mock 基准（本文件不 mock @utils/time，故只断言变化而非具体值） */
const NOW_IS_NUMBER = (v: number) => typeof v === "number" && v > 0;

describe("RetroManager.unlockRetroBlock（消耗事相结晶）", () => {
  it("结晶充足时按 retroUnlockCost 扣费并开放插曲", async () => {
    const player = makePlayer({
      coin: 5,
      block: { r1: { locked: 1, open: 0 } },
      trail: {},
      rewardPerm: [],
    });
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    const ok = await mgr.unlockRetroBlock({ retroId: "r1" });
    expect(ok).toBe(true);
    const r = player._playerdata.retro;
    expect(r.coin).toBe(3); // 5 - 2（retroUnlockCost）
    expect(r.block.r1).toEqual({ locked: 0, open: 1 });
  });

  it("结晶不足时拒绝且不扣成负数", async () => {
    const player = makePlayer({
      coin: 1,
      block: { r1: { locked: 1, open: 0 } },
      trail: {},
      rewardPerm: [],
    });
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    expect(await mgr.unlockRetroBlock({ retroId: "r1" })).toBe(false);
    const r = player._playerdata.retro;
    expect(r.coin).toBe(1);
    expect(r.block.r1).toEqual({ locked: 1, open: 0 });
  });

  it("已开放的插曲重复解锁不重复扣费（幂等）", async () => {
    const player = makePlayer({
      coin: 5,
      block: { r1: { locked: 0, open: 1 } },
      trail: {},
      rewardPerm: [],
    });
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    expect(await mgr.unlockRetroBlock({ retroId: "r1" })).toBe(false);
    expect(player._playerdata.retro.coin).toBe(5); // 原实现会扣到 4
  });

  it("未知插曲不扣费（不 500）", async () => {
    const player = makePlayer({ coin: 5, block: {}, trail: {}, rewardPerm: [] });
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    expect(await mgr.unlockRetroBlock({ retroId: "nope" })).toBe(false);
    expect(player._playerdata.retro.coin).toBe(5);
  });
});

/**
 * 事相结晶周期补充（ensureWeeklySupplement / weeklyRefresh）
 *
 * 官方规则原文（data/excel/retro_table.json → retroDetail）：
 * 「每周一 04:00 重置 1 次【事相结晶】的领取机会，不可累计。未达到储存上限时，在登录
 *  签到后将自动领取 2 个【事相结晶】。博士等级达到 60 级后，自动领取数量增长至 3 个。
 *  储存上限…2 个；60 级后增长至 3 个。」
 * 修复前：这些常量与 retro.supplement 全仓无人使用 → 结晶无获取途径。
 */
describe("RetroManager.ensureWeeklySupplement（事相结晶周期补充）", () => {
  it("60 级及以上：有领取机会且未达上限 → 补到上限（+1，2→3）并消耗机会", async () => {
    const player = makePlayer(
      { coin: 2, supplement: 1, block: {}, trail: {}, rewardPerm: [], lst: 0 },
      112,
    );
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    expect(await mgr.ensureWeeklySupplement()).toBe(1);
    const r = player._playerdata.retro;
    expect(r.coin).toBe(3); // cap = retroCoinMaxOfLevels["60"] = 3
    expect(r.supplement).toBe(0); // 机会已消耗
    expect(NOW_IS_NUMBER(r.lst)).toBe(true);
  });

  it("60 级以下：上限与领取量均为 initRetroCoin（2）", async () => {
    const player = makePlayer(
      { coin: 0, supplement: 1, block: {}, trail: {}, rewardPerm: [], lst: 0 },
      30,
    );
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    expect(await mgr.ensureWeeklySupplement()).toBe(2);
    expect(player._playerdata.retro.coin).toBe(2);
  });

  it("已达储存上限时不发放且**保留**本周机会", async () => {
    const player = makePlayer(
      { coin: 3, supplement: 1, block: {}, trail: {}, rewardPerm: [] },
      112,
    );
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    expect(await mgr.ensureWeeklySupplement()).toBe(0);
    const r = player._playerdata.retro;
    expect(r.coin).toBe(3);
    expect(r.supplement).toBe(1); // 机会未消耗（文本：未达上限时才自动领取）
  });

  it("无领取机会（supplement ≠ 1）时不发放", async () => {
    const player = makePlayer(
      { coin: 0, supplement: 0, block: {}, trail: {}, rewardPerm: [] },
      112,
    );
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    expect(await mgr.ensureWeeklySupplement()).toBe(0);
    expect(player._playerdata.retro.coin).toBe(0);
  });

  it("weeklyRefresh 重置领取机会（不可累计 → 恒置 1）", async () => {
    const player = makePlayer(
      { coin: 3, supplement: 0, block: {}, trail: {}, rewardPerm: [] },
      112,
    );
    const mgr = new RetroManager(asPlayerManager(player), mockTypedEventEmitter());
    await mgr.weeklyRefresh();
    expect(player._playerdata.retro.supplement).toBe(1);
  });
});
