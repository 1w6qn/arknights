import { describe, it, expect, vi } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

import type { Response } from "express";
import charRotationRouter from "@game/modules/character/charRotation.routes";
import httpContext from "express-http-context2";

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: { instId?: string };
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** 被测路由读取的玩家门面视图 */
interface MockPlayer {
  charRotation: { createPreset: () => Promise<string> };
  delta: { modified: Record<string, never> };
}

type RouterReq = Parameters<typeof charRotationRouter>[0];

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
  charRotationRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("charRotation 路由（去重后唯一实现）", () => {
  it("createPreset 应回传新建预设的 instId（CS 声明字段，客户端据此选中新预设）", async () => {
    const player: MockPlayer = {
      charRotation: { createPreset: vi.fn(async () => "2") },
      delta: { modified: {} },
    };
    vi.mocked(httpContext.get).mockReturnValue(player);
    const res = mockRes();
    await call({ method: "POST", url: "/createPreset", body: {} }, res);
    expect(player.charRotation.createPreset).toHaveBeenCalledTimes(1);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ instId: "2", modified: {} }));
  });
});
