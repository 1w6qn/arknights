import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("express-http-context2", () => ({
  default: { get: vi.fn(), set: vi.fn() },
}));

vi.mock("@utils/crypt", () => ({
  decryptBattleData: vi.fn().mockResolvedValue({
    completeState: 3,
    battleId: "b1",
    battleData: { stats: { extraBattleInfo: { bossrush_finished_wave: 3 } } },
  }),
}));

vi.mock("@game/modules/account/account-manager", () => ({
  accountManager: {
    getBattleInfo: vi.fn().mockResolvedValue({ stageId: "act6bossrush_01" }),
  },
}));

// 单元测试不跑 excel.init()，只 mock 尖灭结算用到的表：
// - StageTable：标准战斗结算（battle.finish 被 mock，不读）
// - ActivityTable.bossRush[actId]：尖灭活动详情（stageDropDataMap 驱动 milestone/token 加值）
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
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): ExcelCharRowMock | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): ExcelRowMock | undefined { return this.StageTable?.stages?.[stageId]; },

    StageTable: {
      stages: {
        act6bossrush_01: {
          zoneId: "act6bossrush_zone1",
          stageDropInfo: {
            displayDetailRewards: [],
          },
        },
        act6bossrush_02: {
          zoneId: "act6bossrush_zone2",
          stageDropInfo: {
            displayDetailRewards: [],
          },
        },
      },
    } as { stages?: Record<string, ExcelRowMock> },
    ActivityTable: {
      basicInfo: {
        act1bossrush: { id: "act1bossrush", type: "BOSS_RUSH", name: "test" },
      },
      zoneToActivity: {
        act6bossrush_zone1: "act1bossrush",
        act6bossrush_zone2: "other_act", // 不属于 act1bossrush → 归属校验应拒绝
      },
      activity: {
        bossRush: {
          act1bossrush: {
            relicList: [
              { relicId: "act1bossrush_relic_01" },
              { relicId: "act1bossrush_relic_02" },
            ],
            relicLevelInfoDataMap: {
              act1bossrush_relic_01: {
                levelInfos: {
                  1: { needItemCount: 20 },
                  2: { needItemCount: 20 },
                  3: { needItemCount: 20 },
                },
              },
              act1bossrush_relic_02: {
                levelInfos: {
                  1: { needItemCount: 30 },
                  2: { needItemCount: 30 },
                },
              },
            },
            mileStoneList: [
              {
                mileStoneId: "mileStone_1",
                mileStoneLvl: 1,
                needPointCnt: 50,
                rewardItem: { id: "4001", count: 10000, type: "GOLD" },
              },
              {
                mileStoneId: "mileStone_2",
                mileStoneLvl: 2,
                needPointCnt: 9999,
                rewardItem: { id: "4001", count: 20000, type: "GOLD" },
              },
            ],
            stageAdditionDataMap: {
              act6bossrush_01: {
                stageId: "act6bossrush_01",
                stageType: "NORMAL",
                stageGroupId: "act6bossrush_group01",
                teamIdList: ["1"],
              },
              act6bossrush_02: {
                stageId: "act6bossrush_02",
                stageType: "NORMAL",
                stageGroupId: "act6bossrush_group02",
                teamIdList: [],
              },
            },
            teamDataMap: {
              "1": { teamId: "1", teamName: "测试编队" },
            },
            stageDropDataMap: {
              act6bossrush_01: {
                3: {
                  clearWaveCount: 3,
                  displayDetailRewards: [
                    { id: "act1bossrush_milestone_point", dropCount: 25 },
                    { id: "act1bossrush_token_relic", dropCount: 10 },
                  ],
                },
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
import activityRouter from "@game/modules/activities";
import { mockPlayerData, asPlayerManager } from "../../helpers";
import type { MockPlayerDataManager } from "../../helpers";
import { BossRushManager } from "@game/modules/activities/bossRush/bossrush";

/** 尖灭请求体视图（本文件各端点用到的字段集合） */
interface BossRushBody {
  activityId?: string;
  stageId?: string;
  teamId?: string;
  ownSlots?: { slots?: { charInstId?: number; level?: number }[] };
  assistFriend?: string | null;
  data?: string;
  battleData?: { isCheat?: string; completeTime?: number };
  relicId?: string;
  milestoneId?: string;
}

/** 路由测试请求视图（只声明被测分支读到的三个成员） */
interface MockReq {
  method: string;
  url: string;
  body: BossRushBody;
}

/** 路由测试响应视图（只声明被测分支读到的四个方法） */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** 尖灭活动槽读取视图（字段面与 R1 覆盖 BOSS_RUSH 一致） */
interface BossRushDetailView {
  milestone?: { point?: number; got?: string[] };
  relic?: {
    token?: { current?: number; total?: number };
    unlockedRelicLevelDic?: { [key: string]: number };
    selectingRelicId?: string;
  };
  bestWaveDic?: { [key: string]: number };
}

interface BossRushActivityView {
  BOSS_RUSH?: { [actId: string]: BossRushDetailView };
  MILESTONE_ONLY?: { [actId: string]: { [milestoneId: string]: number } };
}

/** 战斗替身返回值（历史夹具：真实 BossRushManager 只 spread 后再覆盖 result，故无需 result 键） */
const battleStartResult = {
  result: 0,
  battleId: "b1",
  apFailReturn: 0,
  isApProtect: 0,
  inApProtectPeriod: false,
  notifyPowerScoreNotEnoughIfFailed: false,
};

const battleFinishResult = {
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
};

type RouterReq = Parameters<typeof activityRouter>[0];

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

/**
 * 组装 bossRush 用例的玩家组合根
 *
 * `MockPlayerDataManager` 的窄接口不含 `bossRush`，且 `battle.finish` 的替身返回值
 * （helpers 的 `MockBattleManager`）声明必带 `result`，而本用例历史夹具无该键
 * （真实 `BossRushManager.battleFinish` 只 spread 该结果并覆盖 `result: 0`）。
 * 故用 `Object.assign` 在运行时把 battle 替身与真实 BossRushManager 挂到 mock 上，
 * 其余成员（update/_playerdata/delta/gainItem）保持 mock 原样。
 */
function makePlayer() {
  const mock = mockPlayerData({
    status: { uid: "1" },
    activity: {},
    pushFlags: { status: 1234567890 },
    dungeon: {
      stages: {
        act6bossrush_01: {
          stageId: "act6bossrush_01",
          completeTimes: 0,
          startTimes: 0,
          practiceTimes: 0,
          state: 0,
          hasBattleReplay: 0,
          noCostCnt: 1,
        },
      },
    },
  });
  // BOSS_RUSH 子树为三层结构，无法经 mockPlayerData 种子写入（TS2345），故就地声明视图后写入
  (mock._playerdata.activity as BossRushActivityView).BOSS_RUSH = {
    act1bossrush: {
      milestone: { point: 100, got: [] },
      relic: {
        token: { current: 20, total: 10 },
        unlockedRelicLevelDic: {
          act1bossrush_relic_01: 1,
          act1bossrush_relic_02: 1,
        },
        selectingRelicId: "act1bossrush_relic_01",
      },
      bestWaveDic: {},
    },
  };
  return Object.assign(mock, {
    battle: {
      start: vi.fn().mockResolvedValue(battleStartResult),
      finish: vi.fn().mockResolvedValue(battleFinishResult),
    },
    // 注入真实 BossRushManager（复用 mock update/_playerdata/battle），校验逻辑走真实现
    bossRush: new BossRushManager(asPlayerManager(mock), mock._trigger),
  });
}

type BossRushPlayer = ReturnType<typeof makePlayer>;

describe("bossRush（尖灭测试）路由", () => {
  let player: BossRushPlayer;
  let res: MockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    player = makePlayer();
    res = mockRes();
    vi.mocked(httpContext.get).mockReturnValue(player);
  });

  async function call(url: string, body: BossRushBody) {
    const req: MockReq = { method: "POST", url, body };
    // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
    activityRouter(req as RouterReq, res as Response, () => {});
    await new Promise((r) => setTimeout(r, 20));
  }

  /** 读取 BOSS_RUSH 活动槽（见 BossRushActivityView 的说明） */
  function bossRush(): BossRushDetailView {
    return (player._playerdata.activity as BossRushActivityView).BOSS_RUSH!.act1bossrush!;
  }

  it("POST /bossRush/battleStart 应复用 battle.start 并透传 squad/assistFriend", async () => {
    const ownSlots = { slots: [{ charInstId: 1, level: 90 }] };
    await call("/bossRush/battleStart", {
      activityId: "act1bossrush",
      stageId: "act6bossrush_01",
      teamId: "1",
      ownSlots,
      assistFriend: null,
    });
    expect(player.battle.start).toHaveBeenCalledWith(
      expect.objectContaining({
        stageId: "act6bossrush_01",
        squad: ownSlots,
        usePracticeTicket: 0,
        assistFriend: null,
      })
    );
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 0,
        battleId: "b1",
        playerDataDelta: {},
      })
    );
  });

  it("POST /bossRush/battleStart 编队不合法（teamId 不在 teamIdList）应返回 result=1", async () => {
    await call("/bossRush/battleStart", {
      activityId: "act1bossrush",
      stageId: "act6bossrush_01",
      teamId: "999",
      ownSlots: { slots: [] },
      assistFriend: null,
    });
    expect(player.battle.start).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: 1 })
    );
  });

  it("POST /bossRush/battleStart 进行中互斥：未结算再次开战应返回 result=1", async () => {
    const body = {
      activityId: "act1bossrush",
      stageId: "act6bossrush_01",
      teamId: "1",
      ownSlots: { slots: [] },
      assistFriend: null,
    };
    await call("/bossRush/battleStart", body);
    expect(player.battle.start).toHaveBeenCalledTimes(1);
    // 第二次开战：进行中未结算 → 互斥拒绝
    await call("/bossRush/battleStart", body);
    expect(player.battle.start).toHaveBeenCalledTimes(1); // 未再调用标准 battle.start
    const last = vi.mocked(res.send).mock.calls.at(-1)![0];
    expect(last).toMatchObject({ result: 1, playerDataDelta: {} });
  });

  it("POST /bossRush/battleStart 跨活动关卡（zone 归属不符）应返回 result=1", async () => {
    await call("/bossRush/battleStart", {
      activityId: "act1bossrush",
      stageId: "act6bossrush_02", // zone2 归属 other_act ≠ act1bossrush
      teamId: "1",
      ownSlots: { slots: [] },
      assistFriend: null,
    });
    expect(player.battle.start).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: 1 })
    );
  });

  it("POST /bossRush/battleFinish 应解析 wave 并更新 bestWaveDic/milestone/token", async () => {
    await call("/bossRush/battleFinish", {
      activityId: "act1bossrush",
      data: "fake",
      battleData: { isCheat: "0", completeTime: 100 },
    });
    expect(player.battle.finish).toHaveBeenCalledWith({
      data: "fake",
      battleData: { isCheat: "0", completeTime: 100 },
    });
    // wave 更新 bestWaveDic；stageDropDataMap 驱动 milestone/token 加值（milestone_point +25 / token_relic +10）
    const br = bossRush();
    expect(br.bestWaveDic!["act6bossrush_01"]).toBe(3);
    expect(br.milestone!.point).toBe(125); // 100 + 25
    expect(br.relic!.token!.total).toBe(20); // 10 + 10
    expect(br.relic!.token!.current).toBe(30); // 20 + 10
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        wave: 3,
        milestoneBefore: 100,
        milestoneAdd: 25,
        isMilestoneMax: false,
        tokenAdd: 10,
        isTokenMax: false,
        playerDataDelta: {},
      })
    );
  });

  it("POST /bossRush/battleFinish 同一 battleId 重复结算应拒绝（battle.finish 仅一次）", async () => {
    const body = {
      activityId: "act1bossrush",
      data: "fake",
      battleData: { isCheat: "0", completeTime: 100 },
    };
    // 第一次结算成功（未先 battleStart，进行中为空 → 放行）
    await call("/bossRush/battleFinish", body);
    expect(player.battle.finish).toHaveBeenCalledTimes(1);
    const br = bossRush();
    expect(br.milestone!.point).toBe(125); // 已累计
    // 同一 battleId 重复结算 → 防重拒绝，不再调用标准 battle.finish（不重复发奖）
    await call("/bossRush/battleFinish", body);
    expect(player.battle.finish).toHaveBeenCalledTimes(1);
    expect(br.milestone!.point).toBe(125); // 未重复累计
    const last = vi.mocked(res.send).mock.calls.at(-1)![0];
    expect(last).toMatchObject({ result: 1, playerDataDelta: {} });
  });

  it("POST /bossRush/relicSelect 应写入 selectingRelicId", async () => {
    await call("/bossRush/relicSelect", {
      activityId: "act1bossrush",
      relicId: "act1bossrush_relic_02",
    });
    expect(bossRush().relic!.selectingRelicId).toBe("act1bossrush_relic_02");
    expect(res.send).toHaveBeenCalledWith({ playerDataDelta: {} });
  });

  it("POST /bossRush/relicSelect 未解锁遗物应返回 result=1", async () => {
    await call("/bossRush/relicSelect", {
      activityId: "act1bossrush",
      relicId: "act1bossrush_relic_99",
    });
    expect(bossRush().relic!.selectingRelicId).toBe("act1bossrush_relic_01"); // 保持原选择
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: 1 })
    );
  });

  it("POST /bossRush/relicUpgrade 应等级 +1 并数据驱动消耗 20 代币", async () => {
    await call("/bossRush/relicUpgrade", {
      activityId: "act1bossrush",
      relicId: "act1bossrush_relic_01",
    });
    const relic = bossRush().relic!;
    expect(relic.unlockedRelicLevelDic!["act1bossrush_relic_01"]).toBe(2);
    expect(relic.token!.current).toBe(0); // 20 - 20
    expect(res.send).toHaveBeenCalledWith({ playerDataDelta: {} });
  });

  it("POST /bossRush/relicUpgrade 代币不足应拒绝升级", async () => {
    await call("/bossRush/relicUpgrade", {
      activityId: "act1bossrush",
      relicId: "act1bossrush_relic_02",
    });
    const relic = bossRush().relic!;
    expect(relic.unlockedRelicLevelDic!["act1bossrush_relic_02"]).toBe(1); // 等级不变
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: 1 })
    );
  });

  it("POST /activity/rewardMilestone 对 BOSS_RUSH 活动应写入 milestone.got 并发放奖励", async () => {
    // 修复（2026-09-09）：里程碑领奖改为查配置表 + 校验 point —— 原实现只写标记、零发放
    //（mock 的 needPointCnt=50 ≤ 玩家 point=100，故可领并发放 rewardItem）
    await call("/rewardMilestone", {
      activityId: "act1bossrush",
      milestoneId: "mileStone_1",
    });
    expect(bossRush().milestone!.got).toContain("mileStone_1");
    expect((player._playerdata.activity as BossRushActivityView).MILESTONE_ONLY).toBeUndefined();
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        item: [{ id: "4001", count: 10000, type: "GOLD" }],
        playerDataDelta: {},
      })
    );
  });

  it("POST /activity/rewardMilestone 未达标（point < needPointCnt）应拒绝且不写标记", async () => {
    await call("/rewardMilestone", {
      activityId: "act1bossrush",
      milestoneId: "mileStone_2", // needPointCnt=9999 > point=100
    });
    const ms = bossRush().milestone!;
    expect(ms.got).not.toContain("mileStone_2");
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ item: [] })
    );
  });

  it("POST /activity/rewardAllMilestone 应一次领完所有达标里程碑并发奖", async () => {
    await call("/rewardAllMilestone", {
      activityId: "act1bossrush",
    });
    const ms = bossRush().milestone!;
    expect(ms.got).toContain("mileStone_1"); // 达标档位已领
    expect(ms.got).not.toContain("mileStone_2"); // 未达标档位不领
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        item: [{ id: "4001", count: 10000, type: "GOLD" }],
      })
    );
  });
});
