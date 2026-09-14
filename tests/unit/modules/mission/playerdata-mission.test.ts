import { describe, it, expect, vi } from "vitest";

/** 本用例读到的 excel 行形状（只经 ?. 读字段，故全部可选） */
interface ExcelItemRow {
  name?: string;
}
/** MissionTable 行（本文件只声明夹具写入的字段） */
interface ExcelMissionRow {
  id?: string;
  template?: string;
  type?: string;
  param?: string[];
}
/** CharacterTable / StageTable 行 */
interface ExcelCharRow {
  name?: string;
}
interface ExcelStageRow {
  stageType?: string;
}
/** MedalTable / OpenServerTable 行 */
interface ExcelMedalRow {
  medalId?: string;
}
interface ExcelOpenServerRow {
  id?: string;
}
interface ExcelItemTable {
  items: Record<string, ExcelItemRow>;
  expItems: Record<string, ExcelItemRow>;
}

/** excel 门面替身视图（与本文件 vi.mock 工厂形状一致） */
interface ExcelFacadeMock {
  ItemTable: ExcelItemTable;
  CharacterTable: Record<string, ExcelCharRow>;
  StageTable: { stages: Record<string, ExcelStageRow> };
  MissionTable: {
    missions: Record<string, ExcelMissionRow>;
    missionGroups: Record<string, ExcelMissionRow>;
    periodicalRewards: Record<string, ExcelMissionRow>;
    dailyMissionPeriodInfo: ExcelMissionRow[];
  };
  MedalTable: { medalList: ExcelMedalRow[]; medalTypeData: Record<string, ExcelMedalRow> };
  OpenServerTable: { schedule: ExcelOpenServerRow[]; dataMap: Record<string, ExcelOpenServerRow> };
  getItem(id: string): ExcelItemRow | undefined;
  itemName(id: string): string;
  makeItem(id: string, count: number, type?: string): { id: string; count: number; type?: string };
  charData(charId: string): ExcelCharRow | undefined;
  stageData(stageId: string): ExcelStageRow | undefined;
}

vi.mock("@excel/excel", () => {
  const facade: ExcelFacadeMock = {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

    MissionTable: {
      missions: {
        daily_1: { id: "daily_1", template: "CompleteStageAnyType", type: "DAILY", param: ["0", "1", "2"] },
      },
      missionGroups: {},
      periodicalRewards: {},
      dailyMissionPeriodInfo: [],
    },
    MedalTable: { medalList: [], medalTypeData: {} },
    OpenServerTable: { schedule: [], dataMap: {} },
    ItemTable: { items: {}, expItems: {} },
    CharacterTable: {},
    StageTable: { stages: {} },
  };
  return { default: facade };
});

vi.mock("@utils/time", () => ({ now: () => 1234567890, checkBetween: () => true }));
vi.mock("moment", () => ({ default: () => ({ diff: () => 0 }) }));

import { mockPlayerData, type MockSeed } from "../../../helpers/mockPlayerData";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { MissionManager } from "@game/modules/mission/logic";

/**
 * rlv2 夹具宽视图
 *
 * `PlayerRoguelikeV2.pinned` 真实模型声明为 `string`（肉鸽置顶主题 id），而本用例沿用
 * 历史夹具值 `{}`——该占位由被测实现的惰性分支承受（用例从不读取 pinned）。改值会改变
 * 运行期夹具数据（规则禁止），故仅就地放宽该子树的类型声明。
 */
const looseRlv2 = { outer: {}, current: {}, pinned: {} } as MockSeed<
  PlayerDataModel["rlv2"]
>;

describe("PlayerDataManager mission 挂载", () => {
  it("构造后 player.mission 应为 MissionManager 实例", () => {
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
    expect(player.mission).toBeInstanceOf(MissionManager);
  });

  it("init 后 missions 应按玩家数据填充任务进度", async () => {
    const pd = mockPlayerData({
      rlv2: looseRlv2,
      medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
      mission: {
        missions: {
          DAILY: { daily_1: { state: 1, progress: [{ value: 0, target: 1 }] } },
          ACTIVITY: {},
        },
        missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} },
        missionGroups: {},
      },
    });
    const player = new PlayerDataManager(pd._playerdata);
    await player.mission.init();
    expect(player.mission.missions["DAILY"]).toBeDefined();
  });
});
