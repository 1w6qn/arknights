import { describe, it, expect, vi, beforeEach } from "vitest";
/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }
/** excel mock 干员行形状（本文件用到的字段即可） */
interface ExcelCharRowMock {
  name?: string;
  charId?: string;
  rarity?: string;
  profession?: string;
  subProfessionId?: string;
}

// 官方 excel mock：rogue_1 developments（增益树节点，含 frontNodeId 数组/tokenCost）
vi.mock("@excel/excel", () => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,

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
            outbuff_1: { buffId: "outbuff_1", frontNodeId: [], nextNodeId: ["outbuff_5"], tokenCost: 10, nodeType: "BRANCH" },
            outbuff_2: { buffId: "outbuff_2", frontNodeId: [], nextNodeId: ["outbuff_6"], tokenCost: 10, nodeType: "BRANCH" },
            outbuff_5: { buffId: "outbuff_5", frontNodeId: ["outbuff_1"], nextNodeId: ["outbuff_9"], tokenCost: 20, nodeType: "BRANCH" },
            outbuff_6: { buffId: "outbuff_6", frontNodeId: ["outbuff_2"], nextNodeId: ["outbuff_9"], tokenCost: 20, nodeType: "BRANCH" },
            outbuff_9: { buffId: "outbuff_9", frontNodeId: ["outbuff_5", "outbuff_6"], nextNodeId: [], tokenCost: 30, nodeType: "BRANCH" },
          },
        },
      },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: {},
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData } from "../../../helpers";

function makePlayer() {
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: {
        rogue_1: {
          buff: { pointOwned: 50, pointCost: 0, unlocked: {}, score: 0 },
        },
      },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  return player;
}

describe("rlv2 增益树解锁（unlockBuff）", () => {
  let player: PlayerDataManager;

  beforeEach(() => {
    player = makePlayer();
  });

  it("根节点（无前置）点数足够应解锁成功", async () => {
    const ret = await player.rlv2.unlockBuff("rogue_1", "outbuff_1");
    expect(ret).toEqual({ success: true });
    const buff = player.rlv2.outer.rogue_1.buff;
    expect(buff.pointOwned).toBe(40); // 50 - 10
    expect(buff.pointCost).toBe(10);
    expect(buff.unlocked).toHaveProperty("outbuff_1", 1);
  });

  it("前置未解锁应失败且不扣点", async () => {
    const ret = await player.rlv2.unlockBuff("rogue_1", "outbuff_5");
    expect(ret.success).toBe(false);
    expect(ret.reason).toBe("FRONT_NOT_UNLOCKED");
    const buff = player.rlv2.outer.rogue_1.buff;
    expect(buff.pointOwned).toBe(50);
    expect(buff.pointCost).toBe(0);
  });

  it("点数不足应失败", async () => {
    // 解锁 outbuff_1(10) + outbuff_2(10) + outbuff_5(20) = 40 点，剩 10
    await player.rlv2.unlockBuff("rogue_1", "outbuff_1");
    await player.rlv2.unlockBuff("rogue_1", "outbuff_2");
    await player.rlv2.unlockBuff("rogue_1", "outbuff_5");
    // outbuff_6 cost 20 > 10（前置 outbuff_2 已解锁）→ 点数不足
    const ret = await player.rlv2.unlockBuff("rogue_1", "outbuff_6");
    expect(ret.success).toBe(false);
    expect(ret.reason).toBe("POINT_NOT_ENOUGH");
  });

  it("已解锁应幂等返回 ALREADY_UNLOCKED", async () => {
    await player.rlv2.unlockBuff("rogue_1", "outbuff_1");
    const ret = await player.rlv2.unlockBuff("rogue_1", "outbuff_1");
    expect(ret.success).toBe(false);
    expect(ret.reason).toBe("ALREADY_UNLOCKED");
  });

  it("节点不存在应失败", async () => {
    const ret = await player.rlv2.unlockBuff("rogue_1", "outbuff_999");
    expect(ret.success).toBe(false);
    expect(ret.reason).toBe("NODE_NOT_FOUND");
  });

  it("多前置需全部解锁才可解锁", async () => {
    // 只解锁 outbuff_1（outbuff_9 需要 outbuff_5 + outbuff_6）→ 前置未解锁
    await player.rlv2.unlockBuff("rogue_1", "outbuff_1");
    const ret = await player.rlv2.unlockBuff("rogue_1", "outbuff_9");
    expect(ret.success).toBe(false);
    expect(ret.reason).toBe("FRONT_NOT_UNLOCKED");
    // 只解锁 outbuff_5（前置 outbuff_1 ✓）但 outbuff_6 未解锁 → 仍前置未解锁
    await player.rlv2.unlockBuff("rogue_1", "outbuff_5");
    const ret2 = await player.rlv2.unlockBuff("rogue_1", "outbuff_9");
    expect(ret2.success).toBe(false);
    expect(ret2.reason).toBe("FRONT_NOT_UNLOCKED");
    // 全部前置解锁后成功（加点确保足够）
    player.rlv2.outer.rogue_1.buff.pointOwned = 100;
    await player.rlv2.unlockBuff("rogue_1", "outbuff_2");
    await player.rlv2.unlockBuff("rogue_1", "outbuff_6");
    const ret3 = await player.rlv2.unlockBuff("rogue_1", "outbuff_9");
    expect(ret3).toEqual({ success: true });
    expect(player.rlv2.outer.rogue_1.buff.unlocked).toHaveProperty("outbuff_9", 1);
  });
});
