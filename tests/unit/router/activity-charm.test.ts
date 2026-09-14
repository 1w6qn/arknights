import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 信物回收（/activity/recycleCharms）
 *
 * 修复（2026-09-09）：
 * 1. 龙门币（id 4001 / itemType GOLD）余额在 status.gold，不在 inventory ——
 *    原实现写 draft.inventory["4001"]，玩家实际拿不到钱、存档多出幽灵键；
 * 2. 返还额改为数据驱动 CharmTable.charmList[].price（原硬编码 1）。
 */
vi.mock("express-http-context2", () => ({ default: { get: vi.fn(), set: vi.fn() } }));

/** excel mock 行形状（本文件用到的字段子集） */
interface ExcelRowMock {
  name?: string;
}

/** 干员行夹具形状（本文件用到的字段子集） */
interface ExcelCharRowMock {
  charId?: string;
  rarity?: string;
  profession?: string;
}

vi.mock("@excel/excel", () => ({
  default: {
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    CharacterTable: undefined as Record<string, ExcelCharRowMock> | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): ExcelCharRowMock | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): ExcelRowMock | undefined { return this.StageTable?.stages?.[stageId]; },
    CharmTable: {
      charmList: [
        { id: "level_cost_1", name: "多索雷斯游客章", price: 15 },
        { id: "level_cost_2", name: "徽章", price: 30 },
      ],
    },
  },
}));

import type { Response } from "express";
import httpContext from "express-http-context2";
import charmRouter from "@game/modules/activities/charm/routes";
import { mockPlayerData } from "../../helpers";
import type { MockPlayerDataManager } from "../../helpers";
import type { RecycleCharmsRequest } from "@game/modules/activities/shared/activity";

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: RecycleCharmsRequest;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

type RouterReq = Parameters<typeof charmRouter>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

describe("信物回收（recycleCharms）", () => {
  let player: MockPlayerDataManager;
  let res: MockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    player = mockPlayerData({
      status: { uid: "1", gold: 100 },
      inventory: {},
      charm: { charms: { level_cost_1: 2 }, squad: [] },
      pushFlags: {},
    });
    res = mockRes();
    vi.mocked(httpContext.get).mockReturnValue(player);
  });

  async function call(body: RecycleCharmsRequest) {
    const req: MockReq = { method: "POST", url: "/recycleCharms", body };
    // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
    charmRouter(req as RouterReq, res as Response, () => {});
    await new Promise((r) => setTimeout(r, 30));
  }

  it("回收信物返还龙门币到 status.gold（按 CharmTable.price），不写 inventory[4001]", async () => {
    await call({ charmIds: ["level_cost_1"] });
    expect(player._playerdata.status.gold).toBe(115); // 100 + 15
    expect(player._playerdata.inventory["4001"]).toBeUndefined();
    expect(player._playerdata.charm.charms.level_cost_1).toBe(1);
    expect(vi.mocked(res.send).mock.calls.at(-1)![0].recycleNum).toBe(1);
  });

  it("多次回收累计返还；未持有/未知信物不返还", async () => {
    await call({ charmIds: ["level_cost_1", "level_cost_1"] });
    // 只持有 2 个 level_cost_1 → 两次均回收（15×2）
    expect(player._playerdata.status.gold).toBe(130);
    expect(player._playerdata.charm.charms.level_cost_1).toBe(0);
    await call({ charmIds: ["level_cost_1", "unknown_charm"] });
    // 已持有 0 / 未知 id → 均不返还
    expect(player._playerdata.status.gold).toBe(130);
    expect(vi.mocked(res.send).mock.calls.at(-1)![0].recycleNum).toBe(0);
  });
});
