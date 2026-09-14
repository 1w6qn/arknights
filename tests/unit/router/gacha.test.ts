import { describe, it, expect, vi } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));
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
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): ExcelCharRowMock | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): ExcelRowMock | undefined { return this.StageTable?.stages?.[stageId]; },

    GachaTable: {
      gachaPoolClient: [
        { gachaPoolId: "p_single_1", gachaRuleType: "SINGLE" },
        { gachaPoolId: "p_limited_1", gachaRuleType: "LIMITED" },
      ],
    },
  },
}));

import gachaRouter from "@game/modules/gacha/routes";
import type { Response } from "express";
import httpContext from "express-http-context2";

/** 路由测试请求体视图（本文件各端点字段合集） */
interface GachaBody {
  tagList?: number[];
  poolId?: string;
  chooseChar?: string;
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: GachaBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

type RouterReq = Parameters<typeof gachaRouter>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

async function call(req: MockReq, res: MockRes): Promise<MockRes> {
  // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
  gachaRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

/** 抽卡存档 draft 夹具视图（只声明本用例写入的 upChar 键） */
interface GachaDraftFixture {
  gacha: { single: { [poolId: string]: { upChar?: string } } };
}

describe("gacha 路由", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cancelNormalGacha 应调用 recruit.cancel 并返回增量", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.mocked(httpContext.get).mockReturnValue({
      recruit: { cancel },
      delta: { modified: {} },
    });
    const res = mockRes();
    await call({ method: "POST", url: "/cancelNormalGacha", body: { tagList: [1] } }, res);
    expect(cancel).toHaveBeenCalledWith({ tagList: [1] });
    // CS CancelNormalGachaResponse 要求 result（2026-08-09 修复）
    expect(res.send).toHaveBeenCalledWith({ result: 0, modified: {} });
  });

  it("旧拼写 /cancleNormalGacha 不应再命中", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.mocked(httpContext.get).mockReturnValue({
      recruit: { cancel },
      delta: { modified: {} },
    });
    const res = mockRes();
    await call({ method: "POST", url: "/cancleNormalGacha", body: {} }, res);
    expect(res.send).not.toHaveBeenCalled();
  });

  it("choosePoolUp 应写入 gacha[gachaType][poolId].upChar（对齐 OBS bp_gacha）", async () => {
    const draft: GachaDraftFixture = { gacha: { single: { p_single_1: {} } } };
    const update = vi.fn<(recipe: (draft: GachaDraftFixture) => void) => Promise<void>>(async (recipe) => {
      recipe(draft);
    });
    vi.mocked(httpContext.get).mockReturnValue({
      update,
      delta: { modified: {} },
    });
    const res = mockRes();
    await call(
      { method: "POST", url: "/choosePoolUp", body: { poolId: "p_single_1", chooseChar: "char_1001" } },
      res,
    );
    expect(draft.gacha.single.p_single_1.upChar).toBe("char_1001");
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ result: 0, modified: {} }));
  });

  it("getFreeChar：满 300 抽时发放当期 UP 六星并返回 result 0（修复：原为空桩）", async () => {
    const claimed = vi.fn().mockResolvedValue({ charId: "char_up1" });
    vi.mocked(httpContext.get).mockReturnValue({
      gacha: { claimLimitFreeChar: claimed },
      delta: { modified: {} },
    });
    const res = mockRes();
    await call({ method: "POST", url: "/getFreeChar", body: { poolId: "p_single_1" } }, res);
    expect(claimed).toHaveBeenCalledWith({ poolId: "p_single_1" });
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ result: 0, modified: {} }));
  });

  it("getFreeChar：不可领取时返回 result 1", async () => {
    vi.mocked(httpContext.get).mockReturnValue({
      gacha: { claimLimitFreeChar: vi.fn().mockResolvedValue(null) },
      delta: { modified: {} },
    });
    const res = mockRes();
    await call({ method: "POST", url: "/getFreeChar", body: { poolId: "p_single_1" } }, res);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ result: 1 }));
  });
});
