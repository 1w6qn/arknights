import { describe, it, expect, vi, beforeEach } from "vitest";


vi.mock("express-http-context2", () => ({
  default: {
    get: vi.fn(),
  },
}));

// mock accountManager（PlayerDataManager 构造依赖）
vi.mock("@game/modules/account/account-manager", () => ({
  accountManager: {
    init: vi.fn().mockResolvedValue(undefined),
    getBattleInfo: vi.fn().mockResolvedValue({}),
  },
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
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): ExcelCharRowMock | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): ExcelRowMock | undefined { return this.StageTable?.stages?.[stageId]; },

    RoguelikeTopicTable: {
      details: {
        rogue_1: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          items: {},
          relics: {},
        },
      },
      modules: { rogue_1: { fragment: null } },
      customizeData: {
        rogue_1: {
          developments: {
            outbuff_1: { buffId: "outbuff_1", frontNodeId: [], nextNodeId: [], tokenCost: 10, nodeType: "BRANCH" },
            outbuff_5: { buffId: "outbuff_5", frontNodeId: ["outbuff_1"], nextNodeId: [], tokenCost: 20, nodeType: "BRANCH" },
          },
        },
      },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: {},
  },
}));

import type { Response } from "express";
import type { JsonValue } from "@excel/json-value";
import httpContext from "express-http-context2";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData } from "../../helpers";
import router from "@game/modules/roguelike/routes";

function makePlayerData(): PlayerDataManager {
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: {
        rogue_1: {
          buff: { pointOwned: 50, pointCost: 0, unlocked: {}, score: 0 },
        },
      },
      current: {},
      // 历史夹具占位：真实模型 pinned 为 string（肉鸽置顶主题 id），值原样保留
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  return new PlayerDataManager(pd._playerdata);
}

/** 路由请求视图（本文件各端点字段合集） */
interface UpgradeBuffBody {
  theme?: string;
  id?: string;
  buffId?: string;
}

/** 路由请求替身（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: UpgradeBuffBody;
}

/** 路由响应视图（本文件断言到 result/errorMsg/playerDataDelta） */
interface UpgradeBuffResponseView {
  result?: number;
  errorMsg?: string;
  playerDataDelta?: { modified?: JsonValue };
}

/** 路由响应替身（只声明被测分支用到的成员） */
interface MockRes {
  statusCode: number;
  status(code: number): MockRes;
  send(data: UpgradeBuffResponseView): void;
}

type RouterReq = Parameters<typeof router>[0];

function callRouter(
  method: string,
  path: string,
  body: UpgradeBuffBody,
): Promise<{ status: number; data: UpgradeBuffResponseView | undefined }> {
  return new Promise((resolve, reject) => {
    const req: MockReq = { body, method, url: path };
    const res: MockRes = {
      statusCode: 0,
      status(code: number) { this.statusCode = code; return this; },
      send(data: UpgradeBuffResponseView) { resolve({ status: this.statusCode, data }); },
    };
    // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
    router(req as RouterReq, res as Response, (err) =>
      err ? reject(err) : resolve({ status: res.statusCode, data: undefined }),
    );
  });
}

describe("roguelike upgradeOutBuff 路由", () => {
  let player: PlayerDataManager;

  beforeEach(async () => {
    player = makePlayerData();
    vi.mocked(httpContext.get).mockReturnValue(player);
  });

  it("解锁成功返回 result 0 + delta 记录 unlocked", async () => {
    const { status, data } = await callRouter("POST", "/roguelike/upgradeOutBuff", {
      theme: "rogue_1",
      id: "outbuff_1",
    });
    expect(status).toBe(0);
    expect(data!.result).toBe(0);
    // delta 记录了 outer 修改
    const delta = data!.playerDataDelta;
    expect(delta!.modified).toBeDefined();
    const buffDelta = JSON.stringify(delta!.modified);
    expect(buffDelta).toContain("outbuff_1");
    // 内存状态已解锁
    expect(player._playerdata.rlv2.outer.rogue_1.buff.unlocked).toHaveProperty("outbuff_1", 1);
  });

  it("前置未解锁返回 result 1 + errorMsg", async () => {
    const { data } = await callRouter("POST", "/roguelike/upgradeOutBuff", {
      theme: "rogue_1",
      id: "outbuff_5",
    });
    expect(data!.result).toBe(1);
    expect(data!.errorMsg).toBe("FRONT_NOT_UNLOCKED");
    expect(player._playerdata.rlv2.outer.rogue_1.buff.pointOwned).toBe(50);
  });

  it("兼容 buffId 字段名", async () => {
    const { data } = await callRouter("POST", "/roguelike/upgradeOutBuff", {
      theme: "rogue_1",
      buffId: "outbuff_1",
    });
    expect(data!.result).toBe(0);
  });
});
