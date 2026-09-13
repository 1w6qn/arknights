import { describe, it, expect, vi } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

import type { Response } from "express";
import templateTrapRouter from "@game/modules/templateTrap/routes";
import httpContext from "express-http-context2";

/** 被测端的请求体视图 */
interface TemplateTrapBody {
  trapDomainId?: string;
  trapSquad?: number[];
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: TemplateTrapBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** 端点写入的 draft 夹具视图 */
interface TemplateTrapDraft {
  templateTrap: { domains: { [domainId: string]: { squad?: number[] } } };
}

type RouterReq = Parameters<typeof templateTrapRouter>[0];

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
  templateTrapRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("templateTrap 路由（OBS misc_bp 移植端点）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("setTrapSquad 应写入 templateTrap.domains[id].squad 并回显", async () => {
    const draft: TemplateTrapDraft = { templateTrap: { domains: { d1: {} } } };
    const update = vi.fn<(recipe: (draft: TemplateTrapDraft) => void) => Promise<void>>(async (recipe) => {
      recipe(draft);
    });
    vi.mocked(httpContext.get).mockReturnValue({
      update,
      delta: { modified: {} },
    });
    const res = mockRes();
    await call(
      { method: "POST", url: "/templateTrap/setTrapSquad", body: { trapDomainId: "d1", trapSquad: [1, 2] } },
      res,
    );
    expect(draft.templateTrap.domains.d1.squad).toEqual([1, 2]);
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ trapDomainId: "d1", trapSquad: [1, 2], modified: {} }),
    );
  });
});
