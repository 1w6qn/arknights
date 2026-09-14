import { describe, it, expect, beforeEach, vi } from "vitest";
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
        rogue_3: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL", initRelic: {}, initRecruit: {} }],
          recruitTickets: {},
        },
      },
      modules: {
        rogue_3: { totemBuff: { totemBuffDatas: {} } },
      },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { EventMap } from "@game/kernel/events";
import { mockPlayerData } from "../../../helpers";

function makePlayer() {
  const pd = mockPlayerData({
    rlv2: { outer: {}, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  return new PlayerDataManager(pd._playerdata);
}

/**
 * rlv2 引用同步回归测试
 *
 * RoguelikeV2Manager.update() 在 recipe 结束后统一刷新 outer/current/pinned 引用。
 * 若刷新缺失，recipe 克隆过的子树会让 this.current/this.outer 指向旧对象，
 * createGame/gameSettle 的直接写会落到孤儿对象（不持久化，重启丢失）。
 */
describe("rlv2 引用同步（wrapper 统一刷新）", () => {
  let player: PlayerDataManager;

  beforeEach(() => {
    player = makePlayer();
  });

  it("update() 克隆子树后 outer/current/pinned 与持久态同步", async () => {
    const rlv2 = player.rlv2;
    const oldCurrent = rlv2.current;
    await rlv2.update(async (draft) => {
      draft.current.game = {
        mode: "NONE",
        predefined: "",
        theme: "",
        outer: { support: false },
        start: -1,
        modeGrade: 0,
        equivalentGrade: 0,
      };
    });
    expect(rlv2.current).toBe(player._playerdata.rlv2.current);
    expect(rlv2.current).not.toBe(oldCurrent);
    expect(rlv2.outer).toBe(player._playerdata.rlv2.outer);
    expect(rlv2.pinned).toBe(player._playerdata.rlv2.pinned);
  });

  it("setPinned 后 pinned 引用同步到持久态", async () => {
    const rlv2 = player.rlv2;
    await rlv2.setPinned({ id: "relic_1" });
    expect(player._playerdata.rlv2.pinned).toBe("relic_1");
    expect(rlv2.pinned).toBe("relic_1");
  });

  it("giveUpGame 后再 createGame：直接写落在持久态（重启不丢失）", async () => {
    const rlv2 = player.rlv2;
    // rlv2:create 的子管理器 create() 处理器需要完整 excel 配置（与本用例断言无关），stub 掉
    const originalEmit = player._trigger.emit.bind(player._trigger);
    vi.spyOn(player._trigger, "emit").mockImplementation(
      async <Name extends keyof EventMap>(event: Name, data: EventMap[Name]) => {
        if (event === "rlv2:create") return;
        return originalEmit(event, data);
      },
    );

    await rlv2.giveUpGame();
    expect(rlv2.current).toBe(player._playerdata.rlv2.current);

    await rlv2.createGame({
      theme: "rogue_3",
      mode: "NORMAL",
      modeGrade: 0,
      predefinedId: null,
    });
    expect(rlv2.current.game!.theme).toBe("rogue_3");
    expect(player._playerdata.rlv2.current.game!.theme).toBe("rogue_3");
  });
});
