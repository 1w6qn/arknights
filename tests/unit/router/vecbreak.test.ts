import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

const timeMock = vi.hoisted(() => ({ now: 1772000000 })); // act2break 特别战线第一期限时窗口内
vi.mock("@utils/time", () => ({ now: () => timeMock.now }));

// 矢量突破两期活动配置（act1break 旧 / act2break 当前）——赛季选择与关卡奖励均据此判定
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
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): ExcelCharRowMock | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): ExcelRowMock | undefined { return this.StageTable?.stages?.[stageId]; },

    ActivityTable: {
      basicInfo: {
        act1break: { id: "act1break", startTime: 1747296000, endTime: 1749067199 },
        act2break: { id: "act2break", startTime: 1771920000, endTime: 1773691199 },
      },
      activity: {
        // 官方表实际键名（CS: ActivityTable.ActivityDetailTable.typeActVecBreakV2Data，
        // 已用 data/excel/activity_table.json 核对：typeActVecBreakV2Data.{act1break,act2break}）。
        // 旧夹具写成 vecBreakV2，与生产数据不一致，掩盖了「赛季字典恒空」的读取缺陷。
        typeActVecBreakV2Data: {
          act1break: {
            offenseStageDict: {
              act1break_01: { stageId: "act1break_01", level: 1 },
            },
            hardStageDict: {},
            defenseBasicDict: {},
            stageRewardDict: {
              act1break_01: { stageId: "act1break_01", completeRewardCnt: 75, normalRewardCnt: 25, limitReward: null },
            },
          },
          act2break: {
            offenseStageDict: {
              act2break_01: { stageId: "act2break_01", level: 1 },
              act2break_02: { stageId: "act2break_02", level: 2 },
            },
            hardStageDict: { act2break_h01: { stageId: "act2break_h01" } },
            defenseBasicDict: {
              act2break_sp01: { stageId: "act2break_sp01", sortId: 1 },
              act2break_sp02: { stageId: "act2break_sp02", sortId: 2 },
            },
            stageRewardDict: {
              act2break_01: { stageId: "act2break_01", completeRewardCnt: 75, normalRewardCnt: 25, limitReward: null },
              act2break_02: { stageId: "act2break_02", completeRewardCnt: 75, normalRewardCnt: 25, limitReward: null },
              act2break_h01: { stageId: "act2break_h01", completeRewardCnt: 180, normalRewardCnt: 60, limitReward: null },
              act2break_sp01: {
                stageId: "act2break_sp01",
                completeRewardCnt: 20,
                normalRewardCnt: 0,
                limitReward: { startTs: 1771920000, endTs: 1772222399, rewardCnt: 20 },
              },
              act2break_sp02: {
                stageId: "act2break_sp02",
                completeRewardCnt: 20,
                normalRewardCnt: 0,
                limitReward: { startTs: 1771920000, endTs: 1772222399, rewardCnt: 20 },
              },
            },
          },
        },
      },
    },
  },
}));

import type { Response } from "express";
import httpContext from "express-http-context2";
import vecbreakRouter from "@game/modules/vecbreak/routes";
import { mockPlayerData } from "../../helpers";
import type { MockPlayerDataSeed } from "../../helpers";

/** 矢量突破请求体视图（本文件各端点字段合集） */
interface VecbreakBody {
  activityId?: string;
  stageId?: string;
  squad?: { slots?: { charInstId?: number; currentTmpl?: string | null }[] };
  data?: string;
  battleData?: { isCheat?: string; completeTime?: number };
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: VecbreakBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

type RouterReq = Parameters<typeof vecbreakRouter>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

describe("vecbreak（矢量突破）进攻链与里程碑", () => {
  let player: ReturnType<typeof makePlayer>;
  let res: MockRes;

  /**
   * 组装 vecbreak 用例的玩家组合根
   *
   * `MockPlayerDataManager` 的窄接口不含 battle 的完整替身面（本用例 battle 替身带
   * `getActiveBattle`，且 `finish` 返回值无 `result` 键），故用 `Object.assign` 在运行时挂载，
   * 其余成员（update/_playerdata/delta/gainItem）保持 mock 原样。
   */
  function makePlayer(extra: MockPlayerDataSeed = {}) {
    const mock = mockPlayerData({
      dungeon: { stages: {} },
      activity: { VEC_BREAK_V2: {} },
      ...extra,
    });
    return Object.assign(mock, {
      battle: {
        start: vi.fn().mockResolvedValue({ result: 0, battleId: "real-battle-id" }),
        finish: vi.fn().mockResolvedValue({
          result: 0,
          apFailReturn: 0,
          expScale: 1,
          goldScale: 1,
          rewards: [],
          firstRewards: [],
          unlockStages: [],
          unusualRewards: [],
          additionalRewards: [],
          furnitureRewards: [],
          alert: [],
          suggestFriend: false,
          pryResult: [],
        }),
        getActiveBattle: vi.fn(() => ({ battleId: "real-battle-id", stageId: "act2break_01" })),
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    player = makePlayer();
    res = mockRes();
    vi.mocked(httpContext.get).mockReturnValue(player);
  });

  async function call(url: string, body: VecbreakBody) {
    const req: MockReq = { method: "POST", url, body };
    // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
    vecbreakRouter(req as RouterReq, res as Response, () => {});
    await new Promise((r) => setTimeout(r, 25));
  }

  it("getSeasonRecord：赛季取当前 act2break 且 stageInfo 反映真实通关状态", async () => {
    player = makePlayer({
      dungeon: { stages: { act2break_01: { state: 3 }, act2break_02: { state: 1 } } },
    });
    vi.mocked(httpContext.get).mockReturnValue(player);
    await call("/vecBreakV2/getSeasonRecord", {});
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(Object.keys(sent.seasons)).toEqual(["act2break"]);
    const info = sent.seasons.act2break.stageInfo;
    expect(info.act2break_01.state).toBe(3);
    expect(info.act2break_02.state).toBe(1); // 原实现一律写 3
    expect(info.act2break_h01.state).toBe(0);
    expect(info.act2break_sp01.state).toBe(0);
    // 最佳记录 = 已通关的最高层
    expect(sent.seasons.act2break.bestRecord.stageId).toBe("act2break_01");
  });

  it("battleStart：复用标准战斗开始并返回真实 battleId（原为固定桩）", async () => {
    await call("/vecBreakV2/battleStart", { activityId: "act2break", stageId: "act2break_01", squad: {} });
    expect(player.battle.start).toHaveBeenCalled();
    expect(vi.mocked(res.send).mock.calls[0][0].battleId).toBe("real-battle-id");
  });

  it("battleFinish：首通发 completeRewardCnt 并写真实 msBefore/msAfter", async () => {
    await call("/vecBreakV2/battleStart", { activityId: "act2break", stageId: "act2break_01", squad: {} });
    await call("/vecBreakV2/battleFinish", { data: "enc", battleData: {} });
    const sent = vi.mocked(res.send).mock.calls.at(-1)![0];
    expect(sent.msBefore).toBe(0);
    expect(sent.msAfter).toBe(75);
    const act = player._playerdata.activity.VEC_BREAK_V2!.act2break;
    expect(act.milestone.point).toBe(75);
  });

  it("battleFinish：重复通关发 normalRewardCnt", async () => {
    player = makePlayer({ dungeon: { stages: { act2break_01: { state: 3 } } } });
    vi.mocked(httpContext.get).mockReturnValue(player);
    await call("/vecBreakV2/battleStart", { activityId: "act2break", stageId: "act2break_01", squad: {} });
    await call("/vecBreakV2/battleFinish", { data: "enc", battleData: {} });
    expect(vi.mocked(res.send).mock.calls.at(-1)![0].msAfter).toBe(25);
  });

  it("defendBattleFinish：首通发 complete + 窗口内限时奖励，并按数值置标记", async () => {
    await call("/vecBreakV2/defendBattleStart", { activityId: "act2break", stageId: "act2break_sp01", squad: { slots: [{ charInstId: 5 }] } });
    await call("/vecBreakV2/defendBattleFinish", {});
    const sent = vi.mocked(res.send).mock.calls.at(-1)![0];
    expect(sent.msBefore).toBe(0);
    expect(sent.msAfter).toBe(40); // 20 首通 + 20 限时
    const rec = player._playerdata.activity.VEC_BREAK_V2!.act2break.defendStages.act2break_sp01;
    expect(rec.recvTimeLimited).toBe(1);
    // recvNormal = 非限时奖励已领取（特别战线各关 normalRewardCnt 为 0，普通奖励即 completeRewardCnt）
    expect(rec.recvNormal).toBe(1);
    expect(rec.defendSquad).toEqual([{ charInstId: 5, currentTmpl: null }]);
  });

  it("defendBattleFinish：限时窗口外不发限时奖励", async () => {
    timeMock.now = 1772400000; // 超出 [1771920000, 1772222399]
    await call("/vecBreakV2/defendBattleStart", { activityId: "act2break", stageId: "act2break_sp02", squad: { slots: [] } });
    await call("/vecBreakV2/defendBattleFinish", {});
    expect(vi.mocked(res.send).mock.calls.at(-1)![0].msAfter).toBe(20);
    const rec = player._playerdata.activity.VEC_BREAK_V2!.act2break.defendStages.act2break_sp02;
    expect(rec.recvTimeLimited).toBe(0);
    timeMock.now = 1772000000;
  });
});
