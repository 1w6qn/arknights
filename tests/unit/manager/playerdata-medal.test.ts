import { describe, it, expect, vi } from "vitest";
import type {
  CharacterData,
  ItemData,
  StageData,
} from "@excel/types_excel_gen";

vi.mock("@excel/excel", () => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    // 本替身刻意不提供数据表（与旧夹具一致）：三张表恒为空，查表得到 undefined
    ItemTable: undefined as { items?: Record<string, ItemData> } | undefined,
    CharacterTable: undefined as Record<string, CharacterData> | undefined,
    StageTable: undefined as { stages?: Record<string, StageData> } | undefined,
    getItem(id: string): ItemData | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): CharacterData | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): StageData | undefined { return this.StageTable?.stages?.[stageId]; },

    MedalTable: {
      medalList: [
        { medalId: "medal_a", template: "PlayerLevel", unlockParam: ["10"], medalRewardGroup: [] },
      ],
    },
  },
}));
vi.mock("@utils/time", () => ({ now: () => 1234567890 }));
vi.mock("moment", () => ({ default: () => ({ diff: () => 0 }) }));

import type { PlayerDataModel } from "@game/kernel/playerdata";
import { mockPlayerData, type MockSeed } from "../../helpers";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { MedalManager } from "@game/modules/medal/medal";

/**
 * rlv2 夹具宽视图
 *
 * `PlayerRoguelikeV2.pinned` 真实模型声明为 `string`（肉鸽置顶主题 id），而本用例沿用
 * 历史夹具值 `{}`——该占位由被测实现的惰性分支承受（用例从不读取 pinned）。改值会改变
 * 运行期夹具数据（规则禁止），故仅就地放宽该子树的类型声明，其余种子仍受
 * `MockPlayerDataSeed` 的字段校验。
 */
const looseRlv2 = { outer: {}, current: {}, pinned: {} } as MockSeed<
  PlayerDataModel["rlv2"]
>;

describe("PlayerDataManager medal 挂载", () => {
  it("构造后 player.medal 应为 MedalManager 实例", () => {
    const pd = mockPlayerData({
      rlv2: looseRlv2,
      medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
      mission: {
        missions: { DAILY: {}, ACTIVITY: {} },
        missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} },
        missionGroups: {},
      },
    });
    const player = new PlayerDataManager(pd._playerdata);
    expect(player.medal).toBeInstanceOf(MedalManager);
  });

  it("init 后 medals 应按玩家数据创建进度实例", async () => {
    const pd = mockPlayerData({
      rlv2: looseRlv2,
      medal: {
        medals: {
          medal_a: { id: "medal_a", val: [[5, 10]], fts: 0, rts: -1, reward: "" },
        },
        custom: { currentIndex: "0", customs: {} },
      },
      mission: {
        missions: { DAILY: {}, ACTIVITY: {} },
        missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} },
        missionGroups: {},
      },
    });
    const player = new PlayerDataManager(pd._playerdata);
    await player.medal.init();
    expect(player.medal.medals["medal_a"]).toBeDefined();
  });
});
