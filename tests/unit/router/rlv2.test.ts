import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

import type { Response } from "express";
import rlv2Router from "@game/modules/roguelike/rlv2.routes";

/** rlv2 请求体视图（本文件各端点字段合集） */
interface Rlv2Body {
  battleData?: Record<string, never>;
  data?: string;
  battleLog?: string;
  index?: number;
  sub?: number;
  choice?: string;
  totemIndex?: string[];
  nodeIndex?: string[];
  id?: string;
  theme?: string;
  rewards?: string[];
  count?: number;
  mode?: string;
  modeGrade?: number;
  predefinedId?: null;
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: Rlv2Body;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** rlv2 统一响应视图（本文件断言到的字段） */
interface Rlv2ResponseFixture {
  playerDataDelta: {
    modified: {
      status: { ap: number };
      rlv2: { current: { record?: { brief?: { level?: number; seed?: string } } } };
    };
  };
}

type RouterReq = Parameters<typeof rlv2Router>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

/**
 * rlv2 玩家组合根替身（只覆盖本文件断言到的 modules.rlv2 面）
 *
 * createGame / giveUpGame 先以桩声明，用例按需覆写（与历史夹具的「按需挂载」一致）。
 */
function makeMockPlayer() {
  return {
    delta: { playerDataDelta: { modified: { status: { ap: 1 } }, deleted: {} } },
    modules: {
      rlv2: {
        persistCurrent: vi.fn(),
        toJSON: () => ({ outer: {}, current: {} }),
        snapshotCurrent: () => ({ outer: {}, current: {} }),
        clearPushMessages: vi.fn(),
        refreshShop: vi.fn().mockResolvedValue(undefined),
        leaveShop: vi.fn().mockResolvedValue(undefined),
        useTotem: vi.fn().mockResolvedValue(undefined),
        confirmPredict: vi.fn().mockResolvedValue(undefined),
        closeRecruitTicket: vi.fn().mockResolvedValue(undefined),
        selectChoice: vi.fn().mockResolvedValue(undefined),
        battlePassGetReward: vi.fn().mockResolvedValue({ items: [{ type: "GOLD", id: "4001", count: 1 }] }),
        nodeMissionConfirm: vi.fn().mockResolvedValue(undefined),
        nodeMissionGiveUp: vi.fn().mockResolvedValue(undefined),
        nodeMissionCloseTip: vi.fn().mockResolvedValue(undefined),
        scrapIdentify: vi.fn().mockResolvedValue({
          scrap: [{ id: "rogue_6_scrap_G_05", count: 1 }],
          legacy: [{ id: "rogue_6_legacy_02", count: 1 }],
        }),
        battleFinish: vi.fn().mockResolvedValue(undefined),
        chooseBattleReward: vi.fn().mockResolvedValue(undefined),
        sacrificeChoice: vi.fn().mockResolvedValue(undefined),
        // 多数端点经 rlv2Response 透传 takePushMessages；默认返回空数组，
        // 保证未触发推送时响应不带 pushMessage 字段
        takePushMessages: vi.fn().mockReturnValue([]),
        createGame: vi.fn().mockResolvedValue(undefined),
        giveUpGame: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
}

describe("rlv2 路由", () => {
  let player: ReturnType<typeof makeMockPlayer>;
  let res: MockRes;

  beforeEach(async () => {
    player = makeMockPlayer();
    res = mockRes();
    const ctx = await import("express-http-context2");
    vi.mocked(ctx.default.get).mockReturnValue(player);
  });

  async function call(url: string, body: Rlv2Body) {
    const req: MockReq = { method: "POST", url, body };
    // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
    rlv2Router(req as RouterReq, res as Response, () => {});
    await new Promise((r) => setTimeout(r, 20));
  }

  /**
   * rlv2 统一响应约定：playerDataDelta.modified 含 Immer 增量 + rlv2 子树。
   * 2026-08-18 对齐官服：非 createGame/gameSettle 路由不再输出 outer/pinned
   * （官服所有 rlv2 响应均无 pinned；outer 仅 createGame/gameSettle/gridZone
   * moveAndBattleStart 下发当前主题 {record, monthTeam}）。
   */
  function expectRlv2Response(calledWith: Rlv2ResponseFixture) {
    expect(calledWith.playerDataDelta).toBeTruthy();
    expect(calledWith.playerDataDelta.modified.status).toEqual({ ap: 1 });
    expect(calledWith.playerDataDelta.modified.rlv2).toEqual({ current: {} });
  }

  it("POST /refreshShop 应调用控制器并返回 delta", async () => {
    await call("/refreshShop", {});
    expect(player.modules.rlv2.refreshShop).toHaveBeenCalled();
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /leaveShop 应调用控制器并返回 delta", async () => {
    await call("/leaveShop", {});
    expect(player.modules.rlv2.leaveShop).toHaveBeenCalled();
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /battleFinish 透传 pushMessage（战斗发放护盾/零件推送）", async () => {
    player.modules.rlv2.takePushMessages.mockReturnValue([
      { path: "rlv2GotRandScrap", payload: { idList: ["rogue_6_scrap_M_01"] } },
    ]);
    await call("/battleFinish", { battleData: {}, data: "", battleLog: "" });
    expect(player.modules.rlv2.battleFinish).toHaveBeenCalled();
    const body = vi.mocked(res.send).mock.calls[0][0];
    expect(body.pushMessage).toEqual([
      { path: "rlv2GotRandScrap", payload: { idList: ["rogue_6_scrap_M_01"] } },
    ]);
  });

  it("POST /chooseBattleReward 透传 pushMessage（领取零件组获得提示）", async () => {
    player.modules.rlv2.takePushMessages.mockReturnValue([
      { path: "rlv2GotRandScrap", payload: { idList: ["rogue_6_scrap_M_02"] } },
    ]);
    await call("/chooseBattleReward", { index: 1, sub: 0 });
    expect(player.modules.rlv2.chooseBattleReward).toHaveBeenCalledWith({ index: 1, sub: 0 });
    const body = vi.mocked(res.send).mock.calls[0][0];
    expect(body.pushMessage).toEqual([
      { path: "rlv2GotRandScrap", payload: { idList: ["rogue_6_scrap_M_02"] } },
    ]);
  });

  it("POST /sacrificeChoice 透传 pushMessage（献祭回报藏品推送）", async () => {
    player.modules.rlv2.takePushMessages.mockReturnValue([
      { path: "rlv2GotRandRelic", payload: { idList: ["rogue_6_relic_a"] } },
    ]);
    await call("/sacrificeChoice", { choice: "0" });
    expect(player.modules.rlv2.sacrificeChoice).toHaveBeenCalled();
    const body = vi.mocked(res.send).mock.calls[0][0];
    expect(body.pushMessage).toEqual([
      { path: "rlv2GotRandRelic", payload: { idList: ["rogue_6_relic_a"] } },
    ]);
  });

  it("POST /useTotem 应透传参数", async () => {
    await call("/useTotem", { totemIndex: ["t_0", "t_1"], nodeIndex: ["1"] });
    expect(player.modules.rlv2.useTotem).toHaveBeenCalledWith({
      totemIndex: ["t_0", "t_1"],
      nodeIndex: ["1"],
    });
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /confirmPredict 应调用控制器并返回 delta", async () => {
    await call("/confirmPredict", {});
    expect(player.modules.rlv2.confirmPredict).toHaveBeenCalled();
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /closeRecruitTicket 应透传 id", async () => {
    await call("/closeRecruitTicket", { id: "t_1" });
    expect(player.modules.rlv2.closeRecruitTicket).toHaveBeenCalledWith({ id: "t_1" });
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /selectChoice 应调用控制器并透传 choice（抓包 body {choice}）", async () => {
    await call("/selectChoice", { choice: "choice_leave" });
    expect(player.modules.rlv2.selectChoice).toHaveBeenCalledWith({ choice: "choice_leave" });
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /battlePass_getReward（下划线路径）应调用控制器并带 items", async () => {
    await call("/battlePass_getReward", { theme: "rogue_2", rewards: ["bp_level_1"] });
    expect(player.modules.rlv2.battlePassGetReward).toHaveBeenCalledWith("rogue_2", ["bp_level_1"]);
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.items).toEqual([{ type: "GOLD", id: "4001", count: 1 }]);
    expectRlv2Response(sent);
  });

  it("POST /nodeMission_confirm（下划线路径）应调用控制器", async () => {
    await call("/nodeMission_confirm", {});
    expect(player.modules.rlv2.nodeMissionConfirm).toHaveBeenCalled();
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /nodeMission_giveUp（下划线路径）应调用控制器", async () => {
    await call("/nodeMission_giveUp", {});
    expect(player.modules.rlv2.nodeMissionGiveUp).toHaveBeenCalled();
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /nodeMission_closeTip（下划线路径）应调用控制器", async () => {
    await call("/nodeMission_closeTip", {});
    expect(player.modules.rlv2.nodeMissionCloseTip).toHaveBeenCalled();
    expectRlv2Response(vi.mocked(res.send).mock.calls[0][0]);
  });

  it("POST /scrap/identify 应调用控制器并带 scrap/legacy", async () => {
    await call("/scrap/identify", { count: 3 });
    expect(player.modules.rlv2.scrapIdentify).toHaveBeenCalledWith({ count: 3 });
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.scrap).toEqual([{ id: "rogue_6_scrap_G_05", count: 1 }]);
    expect(sent.legacy).toEqual([{ id: "rogue_6_legacy_02", count: 1 }]);
    expectRlv2Response(sent);
  });

  /**
   * P1/P2 官服对齐：pushMessage 经控制器收集、router 在响应顶层下发。
   * createGame 端点必须透传 takePushMessages()；非 rogue_6 时收集器为空，
   * rlv2Response 不应附加 pushMessage 字段（避免破坏客户端合并）。
   */
  it("POST /createGame 应透传控制器收集到的 pushMessage（rogue_6）", async () => {
    player.modules.rlv2.createGame = vi.fn().mockResolvedValue(undefined);
    player.modules.rlv2.takePushMessages = vi
      .fn()
      .mockReturnValue([{ path: "rlv2ScrapLimit", payload: {} }]);
    await call("/createGame", {
      theme: "rogue_6",
      mode: "NORMAL",
      modeGrade: 0,
      predefinedId: null,
    });
    expect(player.modules.rlv2.createGame).toHaveBeenCalled();
    expect(player.modules.rlv2.takePushMessages).toHaveBeenCalled();
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.pushMessage).toEqual([{ path: "rlv2ScrapLimit", payload: {} }]);
  });

  it("POST /createGame 非 rogue_6 时响应应无 pushMessage 字段", async () => {
    player.modules.rlv2.createGame = vi.fn().mockResolvedValue(undefined);
    player.modules.rlv2.takePushMessages = vi.fn().mockReturnValue([]);
    await call("/createGame", {
      theme: "rogue_1",
      mode: "NORMAL",
      modeGrade: 0,
      predefinedId: null,
    });
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.pushMessage).toBeUndefined();
  });

  /**
   * P 官服对齐：giveUpGame 响应 current.record 仅下发 brief 摘要（完整 record 在
   * player.pending 的 GAME_SETTLE.result.record 中）。原实现把 {brief, record} 一并
   * 下发多余字段 → 客户端合并 current.record 被污染；此用例锁回归。
   */
  it("POST /giveUpGame 应裁剪 current.record 为仅 {brief}", async () => {
    player.modules.rlv2.giveUpGame = vi.fn().mockResolvedValue(undefined);
    player.modules.rlv2.snapshotCurrent = () => ({
      outer: {},
      current: {
        player: { state: "END" },
        record: {
          brief: { level: 1, seed: "AbCdEfGhIjKlMnOpQr,rogue_6,15" },
          record: { cntZone: 1 },
        },
      },
    });
    await call("/giveUpGame", {});
    expect(player.modules.rlv2.giveUpGame).toHaveBeenCalled();
    const sent = vi.mocked(res.send).mock.calls[0][0];
    const rlv2 = sent.playerDataDelta.modified.rlv2;
    // current.record 只含 brief，不再携带多余 record 键
    expect(rlv2.current.record).toEqual({ brief: { level: 1, seed: "AbCdEfGhIjKlMnOpQr,rogue_6,15" } });
  });
});
