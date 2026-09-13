import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JsonValue } from "@excel/json-value";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

// enemyDuel 结算读取 excel ActivityTable.ENEMY_DUEL.npcData 填充排行榜
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
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): ExcelCharRowMock | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): ExcelRowMock | undefined { return this.StageTable?.stages?.[stageId]; },

    ActivityTable: {
      activity: {
        ENEMY_DUEL: {
          act1enemyduel: {
            npcData: { act1enemyduel_npc_01: {}, act1enemyduel_npc_02: {} },
          },
        },
      },
    },
  },
}));

import type { Response } from "express";
import httpContext from "express-http-context2";
import activityRouter from "@game/modules/activities";
import { mockPlayerData } from "../../helpers";
import type { MockPlayerDataManager } from "../../helpers";

/** 怪猎对决请求体视图（本文件各端点用到的字段集合） */
interface EnemyDuelBody {
  activityId?: string;
  modeId?: string;
  sceneId?: string;
  teamId?: string;
  data?: string;
  needLeave?: boolean;
  battleData?: { isCheat?: string; completeTime?: number };
  settle?: { rankList?: { id?: string; rank?: number; score?: number; isPlayer?: number }[] };
  /** 抓包真值形状：`[{ round, unitIds: { <enemyId>: count } }]` */
  surviveUnits?: { round: number; unitIds: Record<string, number> }[];
  /** 抓包真值形状：`[{ round, leftUnitIds, rightUnitIds }]`（右阵营为正数，非 Insight 的负数合并口径） */
  bornUnits?: {
    round: number;
    leftUnitIds: Record<string, number>;
    rightUnitIds: Record<string, number>;
  }[];
}

/**
 * 路由测试请求体
 *
 * 除合法请求外，还要能发**故意非法**的 JSON（用于覆盖 zod 拒绝分支，如
 * `surviveUnits[].unitIds` 给字符串）——故走 HTTP 边界的原始 JSON 形态，
 * 而不是给非法夹具套 `as unknown as` 断言（那会掩盖夹具本身的类型错误）。
 */
type TestBody = EnemyDuelBody | Record<string, JsonValue>;

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: TestBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/**
 * 活动子树夹具读取视图
 *
 * 夹具历史值 `modeInfo.*.isUnlock` 为布尔（生成模型 `PlayerActivity` 的 ENEMY_DUEL 覆盖声明为
 * number，服务端读取面只有 curStage）；运行期原样保留，仅将 `_playerdata.activity` 就地声明为
 * 本视图以便写入该夹具键。
 */
interface EnemyDuelActivityView {
  ENEMY_DUEL?: {
    [actId: string]: {
      modeInfo?: {
        [modeId: string]: { curStage?: string; highScore?: number; isUnlock?: number | boolean };
      };
    };
  };
}

type RouterReq = Parameters<typeof activityRouter>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

describe("enemyDuel（怪猎对决）路由", () => {
  let player: MockPlayerDataManager;
  let res: MockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    player = mockPlayerData({ status: { uid: "1" }, activity: {} });
    // 按历史夹具逐字段写回（键与值一字不改）
    (player._playerdata.activity as EnemyDuelActivityView).ENEMY_DUEL = {
      act1enemyduel: {
        modeInfo: {
          soloOperation: { curStage: "act1enemyduel_01b", highScore: 0, isUnlock: true },
        },
      },
    };
    res = mockRes();
    vi.mocked(httpContext.get).mockReturnValue(player);
  });

  async function call(url: string, body: TestBody) {
    const req: MockReq = { method: "POST", url, body };
    // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
    activityRouter(req as RouterReq, res as Response, () => {});
    await new Promise((r) => setTimeout(r, 20));
  }

  it("POST /enemyDuel/singleBattleStart 应返回 battleId stub", async () => {
    await call("/enemyDuel/singleBattleStart", { activityId: "act1enemyduel", modeId: "soloOperation" });
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.result).toBe(0);
    expect(typeof sent.battleId).toBe("string");
    expect(sent.battleId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("POST /enemyDuel/singleBattleFinish 应返回玩家成绩 + 活动表 NPC 填充排行榜", async () => {
    await call("/enemyDuel/singleBattleFinish", {
      activityId: "act1enemyduel",
      data: "x",
      battleData: { isCheat: "0", completeTime: 1 },
      settle: { rankList: [{ id: "1", rank: 1, score: 1919810, isPlayer: 1 }] },
    });
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.result).toBe(0);
    // 玩家 + 2 个 NPC 填充
    expect(sent.rankList).toHaveLength(3);
    expect(sent.rankList[0]).toEqual({ id: "1", rank: 1, score: 1919810, isPlayer: 1 });
    expect(sent.rankList[1]).toEqual({ id: "act1enemyduel_npc_01", rank: 2, score: 0, isPlayer: 0 });
    expect(sent.choiceCnt).toEqual({ skip: 0, normal: 5, allIn: 1 });
    expect(sent.isHighScore).toBe(false);
    expect(sent.dailyMission).toEqual({ add: 0, reward: 0 });
    expect(sent.bp).toBe(0);
  });

  it("POST /enemyDuel/startMatch + queryMatch 应返回队伍信息（serverToken = modeId|curStage）", async () => {
    await call("/enemyDuel/startMatch", { activityId: "act1enemyduel", modeId: "soloOperation" });
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ result: 0 }));

    await call("/enemyDuel/queryMatch", { activityId: "act1enemyduel", needLeave: false });
    const sent = vi.mocked(res.send).mock.calls[1][0];
    expect(sent.result).toBe(0);
    expect(sent.team.serverToken).toBe("soloOperation|act1enemyduel_01b");
    expect(sent.team.serverAddress).toContain(":");
    expect(sent.playerCnt).toBe(8);
  });

  it("POST /enemyDuel/queryMatch needLeave 应返回 result 1 team null", async () => {
    await call("/enemyDuel/queryMatch", { activityId: "act1enemyduel", needLeave: true });
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: 1, team: null, playerCnt: 0 })
    );
  });

  it("POST /enemyDuel/createTeam / joinTeam 应返回队伍 stub", async () => {
    await call("/enemyDuel/createTeam", { activityId: "act1enemyduel", modeId: "multiOperationMatch" });
    const created = vi.mocked(res.send).mock.calls[0][0];
    expect(created.result).toBe(0);
    expect(created.team.serverToken).toBe("multiOperationMatch|create");

    await call("/enemyDuel/joinTeam", { activityId: "act1enemyduel", teamId: "team-123" });
    const joined = vi.mocked(res.send).mock.calls[1][0];
    expect(joined.result).toBe(0);
    expect(joined.team.teamId).toBe("team-123");
  });

  it("POST /enemyDuel/multiBattleStart / multiBattleFinish 应返回对应 stub", async () => {
    await call("/enemyDuel/multiBattleStart", { activityId: "act1enemyduel", sceneId: "scene_1" });
    const startSent = vi.mocked(res.send).mock.calls[0][0];
    expect(startSent.result).toBe(0);
    expect(typeof startSent.battleId).toBe("string");

    await call("/enemyDuel/multiBattleFinish", {
      activityId: "act1enemyduel",
      sceneId: "scene_1",
      data: "x",
      battleData: { isCheat: "0", completeTime: 1 },
    });
    const finishSent = vi.mocked(res.send).mock.calls[1][0];
    expect(finishSent.result).toBe(0);
    expect(finishSent.rankList.length).toBeGreaterThanOrEqual(1);
    expect(finishSent.rankList[0].isPlayer).toBe(1);
  });

  // 真值样本取自参考包 Insight 的抓包 jsonl（act3enemyduel_01a），字段名与嵌套形状一字不改
  const REAL_SURVIVE_UNITS: NonNullable<EnemyDuelBody["surviveUnits"]> = [
    { round: 0, unitIds: { enemy_15013_dqsnsl: 1 } },
    { round: 1, unitIds: { enemy_15018_dqskzc: 2 } },
    { round: 2, unitIds: { enemy_5030_dqpro_3: 22, enemy_15026_dqmtrf: 2 } },
  ];
  const REAL_BORN_UNITS: NonNullable<EnemyDuelBody["bornUnits"]> = [
    {
      round: 0,
      leftUnitIds: { enemy_15013_dqsnsl: 12 },
      rightUnitIds: { enemy_5055_dqkill: 1 },
    },
    {
      round: 1,
      leftUnitIds: { enemy_15002_dqwing: 4 },
      rightUnitIds: { enemy_15018_dqskzc: 3 },
    },
  ];

  it("singleBattleFinish 应接受抓包真值形状的 surviveUnits/bornUnits", async () => {
    await call("/enemyDuel/singleBattleFinish", {
      activityId: "act1enemyduel",
      data: "x",
      battleData: { isCheat: "0", completeTime: 1 },
      surviveUnits: REAL_SURVIVE_UNITS,
      bornUnits: REAL_BORN_UNITS,
    });
    expect(res.status).not.toHaveBeenCalledWith(422);
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.result).toBe(0);
  });

  it("multiBattleFinish 应接受抓包真值形状的 surviveUnits/bornUnits", async () => {
    await call("/enemyDuel/multiBattleFinish", {
      activityId: "act1enemyduel",
      sceneId: "scene_1",
      data: "x",
      battleData: { isCheat: "0", completeTime: 1 },
      surviveUnits: REAL_SURVIVE_UNITS,
      bornUnits: REAL_BORN_UNITS,
    });
    expect(res.status).not.toHaveBeenCalledWith(422);
    const sent = vi.mocked(res.send).mock.calls[0][0];
    expect(sent.result).toBe(0);
  });

  it("singleBattleFinish 遇结构不符的 surviveUnits 应被 422 拦下（不再透传任意 JSON）", async () => {
    await call("/enemyDuel/singleBattleFinish", {
      activityId: "act1enemyduel",
      data: "x",
      battleData: { isCheat: "0", completeTime: 1 },
      // 数量为字符串（旧 z.json() 会放行），类型化后应拒绝
      surviveUnits: [{ round: 0, unitIds: { enemy_1: "1" } }],
    });
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.send).not.toHaveBeenCalled();
    expect(vi.mocked(res.json).mock.calls[0][0]).toMatchObject({ result: -1 });
  });
});
