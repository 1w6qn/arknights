import { describe, it, expect, vi } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

import type { Response } from "express";
import carRouter from "@game/modules/car/routes";
import httpContext from "express-http-context2";

/** 被测端的请求体视图 */
interface CarBody {
  car?: { carId?: string };
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: CarBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** 端点写入的 draft 夹具视图 */
interface CarDraft {
  car: { battleCar?: { carId?: string } };
}

type RouterReq = Parameters<typeof carRouter>[0];

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
  carRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("car 路由（OBS misc_bp 移植端点）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirmBattleCar 应写入 car.battleCar", async () => {
    const draft: CarDraft = { car: {} };
    const update = vi.fn<(recipe: (draft: CarDraft) => void) => Promise<void>>(async (recipe) => {
      recipe(draft);
    });
    vi.mocked(httpContext.get).mockReturnValue({
      update,
      delta: { modified: {} },
    });
    const res = mockRes();
    await call({ method: "POST", url: "/car/confirmBattleCar", body: { car: { carId: "car_1" } } }, res);
    expect(draft.car.battleCar).toEqual({ carId: "car_1" });
    expect(res.send).toHaveBeenCalledWith({ modified: {} });
  });
});
