import { describe, it, expect, vi } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

import type { Response } from "express";
import batchEventRouter from "@game/modules/batchEvent/routes";

/** 路由测试请求体视图 */
interface BatchEventBody {
  events?: { id?: number }[];
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: BatchEventBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

type RouterReq = Parameters<typeof batchEventRouter>[0];

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
  batchEventRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("batchEvent 路由：客户端事件批量上报", () => {
  it("POST /batch_event 应返回 200 空对象（客户端只认状态码）", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/batch_event", body: { events: [{ id: 1 }] } }, res);
    expect(res.send).toHaveBeenCalledWith({});
  });
});
