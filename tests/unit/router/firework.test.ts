import { describe, it, expect, vi } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

import type { Response } from "express";
import fireworkRouter from "@game/modules/firework/routes";
import httpContext from "express-http-context2";

/** 被测端的请求体视图（本文件各端点字段合集） */
interface FireworkBody {
  slots?: { x?: number }[];
  animal?: string;
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: FireworkBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** 各端点写入的 draft 夹具视图（每个用例只喂一棵子树） */
interface FireworkPlateDraft {
  firework: { plate: { slots?: { x?: number }[] } };
}
interface FireworkAnimalDraft {
  firework: { animal: { select?: string } };
}
type FireworkDraftFixture = FireworkPlateDraft | FireworkAnimalDraft;

type RouterReq = Parameters<typeof fireworkRouter>[0];

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
  fireworkRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("firework 路由（OBS misc_bp 移植端点）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockUpdate(draft: FireworkDraftFixture) {
    const update = vi.fn<(recipe: (draft: FireworkDraftFixture) => void) => Promise<void>>(async (recipe) => {
      recipe(draft);
    });
    vi.mocked(httpContext.get).mockReturnValue({
      update,
      delta: { modified: {} },
    });
    return update;
  }

  it("savePlateSlots 应写入 firework.plate.slots", async () => {
    const draft: FireworkPlateDraft = { firework: { plate: {} } };
    mockUpdate(draft);
    const res = mockRes();
    await call({ method: "POST", url: "/firework/savePlateSlots", body: { slots: [{ x: 1 }] } }, res);
    expect(draft.firework.plate.slots).toEqual([{ x: 1 }]);
    expect(res.send).toHaveBeenCalledWith({ modified: {} });
  });

  it("changeAnimal 应写入 firework.animal.select 并回显 animal", async () => {
    const draft: FireworkAnimalDraft = { firework: { animal: {} } };
    mockUpdate(draft);
    const res = mockRes();
    await call({ method: "POST", url: "/firework/changeAnimal", body: { animal: "dog" } }, res);
    expect(draft.firework.animal.select).toBe("dog");
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ animal: "dog", modified: {} }));
  });
});
