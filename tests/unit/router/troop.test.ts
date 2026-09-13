import { describe, it, expect, vi } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

import type { Response } from "express";
import troopRouter from "@game/modules/troop/routes";
import httpContext from "express-http-context2";

/** 被测端的请求体视图 */
interface TroopBody {
  instId?: string;
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: TroopBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** 端点写入的 draft 夹具视图 */
interface TroopDraft {
  troop: { chars: { [instId: string]: { charId?: string } } };
  mission: { pinnedSpecialOperator?: string };
}

type RouterReq = Parameters<typeof troopRouter>[0];

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
  troopRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("troop 路由（OBS misc_bp 移植端点）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pinSpecialOperator 应写入 mission.pinnedSpecialOperator", async () => {
    const draft: TroopDraft = { troop: { chars: { "10": { charId: "char_1001" } } }, mission: {} };
    const update = vi.fn<(recipe: (draft: TroopDraft) => void) => Promise<void>>(async (recipe) => {
      recipe(draft);
    });
    vi.mocked(httpContext.get).mockReturnValue({
      update,
      delta: { modified: {} },
    });
    const res = mockRes();
    await call({ method: "POST", url: "/troop/pinSpecialOperator", body: { instId: "10" } }, res);
    expect(draft.mission.pinnedSpecialOperator).toBe("char_1001");
    expect(res.send).toHaveBeenCalledWith({ modified: {} });
  });
});
