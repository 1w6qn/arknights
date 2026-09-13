import type {
  MissionTable,
  MedalData,
  StageTable,
  GachaData,
  GameDataConsts,
  CharacterData,
  ShopClientData,
  SkillDataBundle,
} from "@excel/types_excel_gen";
import type { ItemTable, ItemBundle } from "@excel/excel";

/**
 * 创建最小化的 excel 数据 Mock
 * 包含测试所需的基础数据结构，可按需扩展
 */
export function mockExcel() {
  return {
    MissionTable: {
      missions: {},
      missionGroups: {},
      periodicalRewards: {},
      weeklyRewards: {},
      soCharMissionGroupInfo: {},
      dailyMissionGroupInfo: {},
      dailyMissionPeriodInfo: [],
      mainlineMissionEndImageDataList: [],
      crossAppShareMissions: {},
      crossAppShareMissionConst: { nameCardShareMissionId: "" },
      guideMissionGroupInfo: {},
    } as MissionTable,

    MedalTable: {
      medalList: [],
      medalTypeData: {},
    } as MedalData,

    StageTable: {
      stages: {},
      runeStageGroups: {},
      mapThemes: {},
      tileInfo: {},
      forceOpenTable: {},
      timelyStageDropInfo: {},
      overrideDropInfo: {},
      overrideUnlockInfo: {},
      timelyTable: {},
      stageValidInfo: {},
      stageFogInfo: {},
      stageStartConds: {},
      diffGroupTable: {},
      storyStageShowGroup: {},
      specialBattleFinishStageData: {},
      recordRewardData: {},
      apProtectZoneInfo: {},
      antiSpoilerDict: {},
      actCustomStageDatas: {},
      spNormalStageIdFor4StarList: [],
      storylines: {},
      storylineStorySets: {},
      storylineTags: {},
      storylineConst: {
        recommendHideGuideGroupId: "",
        tutorialSelectStorylineId: "",
        mainlineStorylineId: "",
      },
      cgGalleryDisplays: {},
      cgGalleryGroups: {},
      cgGalleryCgs: {},
      sixStarRuneData: {},
      sixStarMilestoneInfo: {},
      sixStarCompatibleInfo: {},
      conditionalDropInfo: {},
    } as StageTable,

    GachaTable: {} as GachaData,
    GameDataConst: {} as GameDataConsts,
    CharacterTable: {} as CharacterData,
    ItemTable: {} as ItemTable,
    ShopClientTable: {} as ShopClientData,
    SkillDataBundle: {} as SkillDataBundle,

    // —— 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) {
      return this.ItemTable?.items?.[id];
    },
    itemName(id: string): string {
      return this.getItem(id)?.name ?? id;
    },
    makeItem(id: string, count: number, type?: string) {
      return type
        ? ({ id, count, type: type as ItemBundle["type"] } as ItemBundle)
        : ({ id, count } as ItemBundle);
    },
    charData(charId: string) {
      return this.CharacterTable?.[charId];
    },
    stageData(stageId: string) {
      return this.StageTable?.stages?.[stageId];
    },
  };
}

export type MockExcel = ReturnType<typeof mockExcel>;

/**
 * 以 {@link mockExcel} 的空表 + 门面方法为底，覆盖用例自带的表数据
 *
 * 用途：`PlayerDataManager.excel` 端口的用例替身。真实端口（`app/game/kernel/excel-port.ts`
 * 的 `ExcelData`）是 32 个成员全必填的 `Pick<Excel, …>`，而用例通常只关心 1~3 张表；
 * 直接写字面量对象既缺成员、表内数据又只是「用例读到的那几行」的窄视图，无法满足
 * 生成类型的全量必填字段。本助手把「空表底 + 覆盖」收敛为单点：未覆盖的表保持空表，
 * 读不到数据 —— 与「只注入最小端口替身」的旧夹具语义一致（旧夹具缺的表同样读不到）。
 *
 * 注意：`overrides` 是**用例自带的窄视图**（不做生成类型校验，因为夹具只声明被测分支
 * 会读到的行），返回值同时保留空表底座与覆盖项，可直接赋给 `mockPlayer.excel`。
 * @param overrides - 用例覆盖的表/门面数据（键名须与 excel 端口一致）
 * @returns 空表底座 + 覆盖项的端口替身（含覆盖项类型，便于用例回读断言）
 */
export function mockExcelWith<T>(overrides: T): MockExcel & T {
  return Object.assign(mockExcel(), overrides);
}
