import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import type { Response } from "express";
import type { ItemBundle } from "@excel/excel";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

import missionRouter from "@game/modules/mission/routes";
import httpContext from "express-http-context2";

/** 路由处理器的测试请求视图：只声明被测分支读到的三个成员 */
interface MockReq {
  method: string;
  url: string;
  body: Record<string, string>;
}

/** 路由处理器的测试响应视图：只声明被测分支读到的四个方法 */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** 路由被测分支读到的玩家组合根面（mission 四入口） */
interface MissionRoutePlayer {
  delta: { modified: Record<string, never> };
  mission: {
    confirmMission: Mock<(body: { missionId: string }) => Promise<ItemBundle[]>>;
    confirmMissionGroup: Mock<(body: { missionGroupId: string }) => Promise<void>>;
    autoConfirmMissions: Mock<(body: { type: string }) => Promise<ItemBundle[]>>;
    exchangeMissionRewards: Mock<(body: { targetRewardsId: string }) => Promise<void>>;
  };
}

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

type RouterReq = Parameters<typeof missionRouter>[0];

async function call(req: MockReq, res: MockRes) {
  // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
  missionRouter(req as RouterReq, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("mission 路由", () => {
  let mockPlayer: MissionRoutePlayer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlayer = {
      delta: { modified: {} },
      mission: {
        confirmMission: vi
          .fn<(body: { missionId: string }) => Promise<ItemBundle[]>>()
          .mockResolvedValue([{ id: "4001", type: "GOLD", count: 100 }]),
        confirmMissionGroup: vi
          .fn<(body: { missionGroupId: string }) => Promise<void>>()
          .mockResolvedValue(undefined),
        autoConfirmMissions: vi
          .fn<(body: { type: string }) => Promise<ItemBundle[]>>()
          .mockResolvedValue([{ id: "30012", type: "MATERIAL", count: 5 }]),
        exchangeMissionRewards: vi
          .fn<(body: { targetRewardsId: string }) => Promise<void>>()
          .mockResolvedValue(undefined),
      },
    };
    vi.mocked(httpContext.get).mockReturnValue(mockPlayer);
  });

  it("confirmMission 应返回奖励与 delta", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/confirmMission", body: { missionId: "daily_1" } }, res);
    expect(mockPlayer.mission.confirmMission).toHaveBeenCalledWith({ missionId: "daily_1" });
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ items: [{ id: "4001", type: "GOLD", count: 100 }], modified: {} }));
  });

  it("confirmMissionGroup 应委托调用", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/confirmMissionGroup", body: { missionGroupId: "g1" } }, res);
    expect(mockPlayer.mission.confirmMissionGroup).toHaveBeenCalledWith({ missionGroupId: "g1" });
    expect(res.send).toHaveBeenCalledWith({ modified: {} });
  });

  it("autoConfirmMissions 应返回自动确认奖励", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/autoConfirmMissions", body: { type: "DAILY" } }, res);
    expect(mockPlayer.mission.autoConfirmMissions).toHaveBeenCalledWith({ type: "DAILY" });
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ items: [{ id: "30012", type: "MATERIAL", count: 5 }] }));
  });

  it("exchangeMissionRewards 应委托调用", async () => {
    const res = mockRes();
    await call({ method: "POST", url: "/exchangeMissionRewards", body: { targetRewardsId: "r1" } }, res);
    expect(mockPlayer.mission.exchangeMissionRewards).toHaveBeenCalledWith({ targetRewardsId: "r1" });
    expect(res.send).toHaveBeenCalledWith({ modified: {} });
  });
});
