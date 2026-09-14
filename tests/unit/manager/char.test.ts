import { describe, it, expect, vi, beforeEach } from "vitest";

/** excel 模块默认导出类型（mock 后的单例引用类型） */
type ExcelDefault = typeof import("@excel/excel")["default"];

/** excel mock 物品行形状（本文件提供的最小表；仅声明被测分支读到的字段） */
interface ExcelItemRowMock {
  /** 物品名（`itemName` 回退读取） */
  name?: string;
  /** 物品类型（`MATERIAL` / `CARD_EXP` / `VOUCHER_*` 等） */
  itemType: string;
  /** 稀有度（数字档位或 `TIER_*` 字符串） */
  rarity: number | string;
}

/** excel mock 技能行形状（干员技能/专精材料） */
interface ExcelSkillMock {
  /** 技能 ID */
  skillId?: string;
  /** 解锁条件 */
  unlockCond?: { phase: string | number; level: number };
  /** 专精档位（材料 + 训练时长） */
  levelUpCostCond?: {
    /** 该档解锁条件 */
    unlockCond?: { phase: string | number; level: number };
    /** 训练时长（秒） */
    lvlUpTime?: number;
    /** 该档材料 */
    levelUpCost?: { id: string; count: number }[];
  }[];
}

/** excel mock 干员行形状（`phases`/`skills`/`allSkillLvlup` 按被测分支声明） */
interface ExcelCharRowMock {
  /** 干员 ID */
  charId: string;
  /** 干员名 */
  name: string;
  /** 稀有度（数字档位） */
  rarity: number;
  /** 潜能道具 ID */
  potentialItemId?: string;
  /** 精英化相位（含精英化材料） */
  phases?: { evolveCost: { id: string; count: number }[] }[];
  /** 技能表 */
  skills?: ExcelSkillMock[];
  /** 技能等级提升档位（解锁条件 + 材料） */
  allSkillLvlup?: { unlockCond: { phase: string; level: number }; lvlUpCost: { id: string; count: number }[] }[];
}

/** excel mock 关卡行形状（本文件 stages 为空表） */
interface ExcelStageRowMock {
  /** 关卡 ID */
  stageId?: string;
}

vi.mock("@excel/excel", () => {
  return {
    default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

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
        crossAppShareMissionConst: {},
        guideMissionGroupInfo: {},
      },
      MedalTable: { medalList: [], medalTypeData: {} },
      StageTable: {
        stages: {} as Record<string, ExcelStageRowMock>,
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
        storylineConst: {},
        cgGalleryDisplays: {},
        cgGalleryGroups: {},
        cgGalleryCgs: {},
        sixStarRuneData: {},
        sixStarMilestoneInfo: {},
      },
      GachaTable: {},
      GameDataConst: {
        characterExpMap: [[0, 100, 200, 300]],
        characterUpgradeCostMap: [[0, 10, 20, 30]],
        maxLevel: [
          [50, 50, 50, 50, 50, 50],
          [50, 50, 50, 50, 50, 50],
          [50, 50, 50, 50, 50, 50],
          [50, 50, 50, 50, 50, 50],
          [50, 50, 50, 50, 50, 50],
          [50, 50, 50, 50, 50, 50],
        ],
        evolveGoldCost: [
          // 真实 excel 结构：每行仅「精一费, 精二费」两列（无 phase0 列），
          // 与 GameDataConst 对齐；-1 = 该稀有度无此相位（如 3 星无精二）。
          [-1, -1],
          [-1, -1],
          [10000, -1],
          [15000, 60000],
          [20000, 120000],
          [30000, 180000],
        ],
      },
      CharacterTable: {
        char_001: {
          charId: "char_001",
          name: "测试干员",
          rarity: 5,
          potentialItemId: "pot_001",
          phases: [
            { evolveCost: [] },
            { evolveCost: [{ id: "mat_001", count: 5 }] },
            { evolveCost: [{ id: "mat_002", count: 10 }] },
          ],
          skills: [
            {
              skillId: "skchr_test_1",
              unlockCond: { phase: 0, level: 1 },
              levelUpCostCond: [
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 28800, levelUpCost: [{ id: "sp_mat", count: 2 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 57600, levelUpCost: [{ id: "sp_mat", count: 3 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 86400, levelUpCost: [{ id: "sp_mat", count: 4 }] },
              ],
            },
            {
              skillId: "skchr_test_2",
              unlockCond: { phase: "PHASE_1", level: 1 },
              levelUpCostCond: [
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 28800, levelUpCost: [{ id: "sp_mat", count: 2 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 57600, levelUpCost: [{ id: "sp_mat", count: 3 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 86400, levelUpCost: [{ id: "sp_mat", count: 4 }] },
              ],
            },
          ],
          allSkillLvlup: [
            { unlockCond: { phase: "PHASE_0", level: 1 }, lvlUpCost: [{ id: "skill_mat", count: 1 }] },
            { unlockCond: { phase: "PHASE_0", level: 2 }, lvlUpCost: [{ id: "skill_mat", count: 1 }] },
          ],
        },
        char_002: {
          charId: "char_002",
          name: "测试干员二",
          rarity: 5,
          potentialItemId: "pot_002",
          phases: [
            { evolveCost: [] },
            { evolveCost: [{ id: "mat_001", count: 5 }] },
            { evolveCost: [{ id: "mat_002", count: 10 }] },
          ],
          skills: [
            {
              skillId: "skchr_test_2_1",
              unlockCond: { phase: "PHASE_0", level: 1 },
              levelUpCostCond: [
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 28800, levelUpCost: [{ id: "sp_mat", count: 2 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 57600, levelUpCost: [{ id: "sp_mat", count: 3 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 86400, levelUpCost: [{ id: "sp_mat", count: 4 }] },
              ],
            },
            {
              skillId: "skchr_test_2_2",
              unlockCond: { phase: "PHASE_1", level: 1 },
              levelUpCostCond: [
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 28800, levelUpCost: [{ id: "sp_mat", count: 2 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 57600, levelUpCost: [{ id: "sp_mat", count: 3 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 86400, levelUpCost: [{ id: "sp_mat", count: 4 }] },
              ],
            },
            {
              skillId: "skchr_test_2_3",
              unlockCond: { phase: "PHASE_2", level: 1 },
              levelUpCostCond: [
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 28800, levelUpCost: [{ id: "sp_mat", count: 2 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 57600, levelUpCost: [{ id: "sp_mat", count: 3 }] },
                { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpTime: 86400, levelUpCost: [{ id: "sp_mat", count: 4 }] },
              ],
            },
          ],
          allSkillLvlup: [
            { unlockCond: { phase: "PHASE_0", level: 1 }, lvlUpCost: [{ id: "skill_mat", count: 1 }] },
            // 技能2 需精英一解锁（E1）
            { unlockCond: { phase: "PHASE_1", level: 1 }, lvlUpCost: [{ id: "skill_mat", count: 1 }] },
            // 技能3 需精英二解锁（E2）
            { unlockCond: { phase: "PHASE_2", level: 1 }, lvlUpCost: [{ id: "skill_mat", count: 1 }] },
          ],
        },
        // 2 星干员：无技能（excel 无 skills/allSkillLvlup）
        char_502_nblade: {
          charId: "char_502_nblade",
          name: "测试二星",
          rarity: 1,
          potentialItemId: "pot_502",
          phases: [{ evolveCost: [] }, { evolveCost: [] }, { evolveCost: [] }],
        },
      } as Record<string, ExcelCharRowMock>,
      ItemTable: {
        items: {
          mat_001: { itemType: "MATERIAL", rarity: 1 },
          mat_002: { itemType: "MATERIAL", rarity: 2 },
          exp_mat: { itemType: "CARD_EXP", rarity: 0 },
          sp_mat: { itemType: "MATERIAL", rarity: 2 },
          voucher_elite_II_6: { itemType: "VOUCHER_ELITE_II_6", rarity: "TIER_5" },
          voucher_elite_II_4: { itemType: "VOUCHER_ELITE_II_4", rarity: "TIER_5" },
          voucher_levelmax_6: { itemType: "VOUCHER_LEVELMAX_6", rarity: "TIER_5" },
          voucher_skill_specialLevelMax_6: { itemType: "VOUCHER_SKILL_SPECIALLEVELMAX_6", rarity: "TIER_5" },
        } as Record<string, ExcelItemRowMock>,
        expItems: {
          exp_mat: { gainExp: 50 },
        },
      },
      ShopClientTable: {},
      SkillDataBundle: {},
      UniequipTable: {
        charEquip: { char_001: ["uniequip_001_test"] },
        equipDict: {
          // 精二即用模组（真实 excel：unlockEvolvePhase 数字 0 + unlockLevel 0 + showEvolvePhase PHASE_2）
          uniequip_001_test: {
            uniEquipId: "uniequip_001_test",
            charId: "char_001",
            showEvolvePhase: "PHASE_2",
            unlockEvolvePhase: 0,
            unlockLevel: 0,
            missionList: [],
            itemCost: { 1: [] },
          },
        },
        missionList: {},
      },
    },
  };
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

vi.mock("@utils/time", () => ({
  now: () => Math.floor(Date.now() / 1000),
  checkBetween: (ts: number, start: number, end: number) =>
    ts >= start && ts <= end,
}));


import {
  mockPlayerData,
  mockTypedEventEmitter,
  asPlayerManager,
  asModel,
  type MockUpdateRecipe,
} from "../../helpers";
import { CharManager } from "@game/modules/character/char";
import type { EventMap } from "@game/kernel/events";
import type { PlayerCharacter, PlayerDataModel } from "@game/kernel/playerdata";
import type { ItemBundle } from "@excel/excel";
import type { Draft } from "mutative";

describe("CharManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;
  let mockExcelRef: ExcelDefault;

  beforeEach(async () => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockExcelRef = vi.mocked(await import("@excel/excel")).default;

    mockPlayer = mockPlayerData({
      troop: {
        chars: {
          1001: {
            instId: 1001,
            charId: "char_001",
            favorPoint: 0,
            potentialRank: 0,
            mainSkillLvl: 1,
            skin: "char_001#1",
            level: 1,
            exp: 0,
            evolvePhase: 0,
            defaultSkillIndex: -1,
            gainTime: 1234567890,
            skills: [],
            currentEquip: null,
            equip: {},
            voiceLan: "CN_MANDARIN",
          },
        },
        curCharInstId: 1001,
      },
      dexNav: {
        character: {
          char_001: {
            charInstId: 1001,
            count: 1,
          },
        },
      },
      status: { gold: 9999 },
    });

    mockPlayer._trigger = mockTrigger;
    mockPlayer.update = vi
      .fn<(recipe: MockUpdateRecipe) => Promise<void>>()
      .mockImplementation(async (recipe) => {
        const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata)) as Draft<PlayerDataModel>;
        const result = await recipe(draft);
        Object.assign(mockPlayer._playerdata, draft);
        return result;
      });
  });

  describe("constructor", () => {
    it("应该正确初始化 CharManager 实例", () => {
      const manager = new CharManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
    });
  });

  describe("onCharGet", () => {
    it("当获取新干员时应该创建新的干员数据", async () => {
      const manager = new CharManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;

      const result = await manager.onCharGet([
        "char_001",
        { from: "NORMAL" },
      ]);

      expect(result).toBeDefined();
      expect(result.isNew).toBe(1);
      expect(result.charId).toBe("char_001");
    });

    it("当获取已有干员时应该返回 isNew 为 0", async () => {
      const manager = new CharManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const result = await manager.onCharGet([
        "char_001",
        { from: "NORMAL" },
      ]);

      expect(result).toBeDefined();
      expect(result.isNew).toBe(0);
    });

    it("当获取已有干员时应该触发 items:get 返还物品", async () => {
      const manager = new CharManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.onCharGet(["char_001", { from: "NORMAL" }]);

      // 物品返还经 gainItem 管道（add + handle），不再直发 items:get
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
      const granted = mockPlayer.gainItem.add.mock.calls.map((c) => c[0]);
      expect(granted.some((i) => i.id === "pot_001")).toBe(true);
    });
  });

  describe("setDefaultSkill", () => {
    it("应该设置干员的默认技能索引", async () => {
      const manager = new CharManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      // 先给干员填充已解锁技能（真实存档 skills 由 reconcileCharSkills 维护）
      mockPlayer._playerdata.troop!.chars[1001].skills = [
        { skillId: "skchr_test_1", unlock: 1, state: 0, specializeLevel: 0, completeUpgradeTime: -1 },
        { skillId: "skchr_test_2", unlock: 1, state: 0, specializeLevel: 0, completeUpgradeTime: -1 },
      ];

      await manager.setDefaultSkill({
        charInstId: 1001,
        defaultSkillIndex: 1,
      });

      expect(
        mockPlayer._playerdata.troop!.chars[1001].defaultSkillIndex
      ).toBe(1);
    });
  });

  describe("boostPotential", () => {
    it("应该提升干员潜能并触发事件", async () => {
      const manager = new CharManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await manager.boostPotential({
        charInstId: 1001,
        itemId: "pot_001",
        targetRank: 3,
      });

      expect(
        mockPlayer._playerdata.troop!.chars[1001].potentialRank
      ).toBe(3);
      expect(emitSpy).toHaveBeenCalledWith(
        "BoostPotential",
        expect.any(Array)
      );
    });
  });

  describe("upgradeSkill", () => {
    it("应该升级技能等级并触发事件", async () => {
      const manager = new CharManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockPlayer._playerdata.troop!.chars[1001].skills = [
        asModel<PlayerCharacter["skills"][number]>({ specializeLevel: 0 }),
      ];

      await manager.upgradeSkill({
        charInstId: 1001,
        targetLevel: 2,
      });

      expect(
        mockPlayer._playerdata.troop!.chars[1001].mainSkillLvl
      ).toBe(2);
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
    });
  });

  describe("onCharGet 修复（2026-08-09）", () => {
    it("新干员创建后 curCharInstId 应递增（避免 instId 冲突）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      await manager.onCharGet(["char_001", { from: "NORMAL" }]);
      // 新干员创建后 curCharInstId 0 → 1（此前从不递增导致后续新干员 instId 冲突）
      expect(mockPlayer._playerdata.troop!.curCharInstId).toBe(1);
      // 新干员的 instId 使用递增前的 curCharInstId（=0 时用 0 → dexNav 记录）
      const dexChar = mockPlayer._playerdata.dexNav!.character["char_001"];
      expect(dexChar.charInstId).toBe(0);
    });

    it("新干员创建后应 emit char:init（基建侧据此建档），重复干员不派发", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      await manager.onCharGet(["char_001", { from: "NORMAL" }]);
      // 修复（2026-09-09，审计 §6.3-27）：该 emit 自建仓起就存在，但基建侧订阅的是
      // 从未派发的 "building:char:init" → 新干员在 building.chars 永不建档。
      // 此处固化「新干员必派发 char:init」的契约，防止回归。
      const call = emitSpy.mock.calls.find((c) => c[0] === "char:init");
      expect(call).toBeTruthy();
      expect((call![1] as EventMap["char:init"])[0].charId).toBe("char_001");
      // 重复干员（已在 roster）不派发 char:init
      emitSpy.mockClear();
      await manager.onCharGet(["char_001", { from: "NORMAL" }]);
      expect(emitSpy.mock.calls.find((c) => c[0] === "char:init")).toBeFalsy();
    });

    it("重复且未满潜干员应返回 potent {delta, now}", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      // char_001 已在 mock 中（potentialRank 0，maxPotentialLevel 5）
      const result = await manager.onCharGet(["char_001", { from: "NORMAL" }]);
      expect(result.isNew).toBe(0);
      expect(result.potent).toEqual({ delta: 1, now: 1 });
    });

    it("新干员结构应对齐官方参考：不带 currentTmpl/tmpl（官方仅阿米娅带模板字段）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_001", { from: "NORMAL" }]);
      expect(result.isNew).toBe(1);
      const ch = mockPlayer._playerdata.troop!.chars[result.charInstId as number];
      // 官方参考（test.json 379 干员仅 char_002_amiya 带 currentTmpl/tmpl）：
      // 普通干员不应有模板字段（旧实现 currentTmpl:charId + tmpl:{} 自引用空模板
      // → 客户端按 currentTmpl 查 tmpl 得 undefined，破坏存档结构）
      expect(ch.currentTmpl).toBeUndefined();
      expect(ch.tmpl).toBeUndefined();
      expect(ch.charId).toBe("char_001");
      expect(ch.voiceLan).toBe("CN_MANDARIN");
    });
  });

  describe("技能解锁（等级/精英化驱动，官方 skills unlockCond 规则）", () => {
    it("新干员建档应按官服线格式填充全部技能（未解锁为 unlock:0 占位）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_002", { from: "NORMAL" }]);
      expect(result.isNew).toBe(1);
      const ch = mockPlayer._playerdata.troop!.chars[result.charInstId as number];
      // char_002 技能1 条件 PHASE_0 → 建档即解锁；技能2/3 按官服线格式以 unlock:0 占位
      expect(ch.skills.map((s) => s.skillId)).toEqual([
        "skchr_test_2_1",
        "skchr_test_2_2",
        "skchr_test_2_3",
      ]);
      expect(ch.skills[0].unlock).toBe(1);
      expect(ch.skills[1].unlock).toBe(0);
      expect(ch.skills[2].unlock).toBe(0);
      expect(ch.defaultSkillIndex).toBe(0);
    });

    it("无技能干员（如 2 星）保持空 skills 且 defaultSkillIndex=-1", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_502_nblade", { from: "NORMAL" }]);
      expect(result.isNew).toBe(1);
      const ch = mockPlayer._playerdata.troop!.chars[result.charInstId as number];
      expect(ch.skills).toEqual([]);
      expect(ch.defaultSkillIndex).toBe(-1);
    });

    it("精英化应解锁对应技能并保留已有技能状态（精1→技能2、精2→技能3）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_002", { from: "NORMAL" }]);
      const charInstId = result.charInstId as number;
      // 修复（2026-09-09）：精英化需当前阶段满级（maxLevel[rarity][phase]=50）
      mockPlayer._playerdata.troop!.chars[charInstId].level = 50;
      // 精1 解锁技能2；技能1 专精状态保留；技能3 仍是 unlock:0 占位
      await manager.evolveChar({ charInstId, destEvolvePhase: 1 });
      let ch = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(ch.evolvePhase).toBe(1);
      expect(ch.skills.map((s) => s.skillId)).toEqual([
        "skchr_test_2_1",
        "skchr_test_2_2",
        "skchr_test_2_3",
      ]);
      expect(ch.skills[1].unlock).toBe(1);
      expect(ch.skills[2].unlock).toBe(0);
      // 精2 解锁技能3（精英化后等级重置为 1，需重新补满）
      mockPlayer._playerdata.troop!.chars[charInstId].level = 50;
      await manager.evolveChar({ charInstId, destEvolvePhase: 2 });
      ch = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(ch.skills.map((s) => s.skillId)).toEqual([
        "skchr_test_2_1",
        "skchr_test_2_2",
        "skchr_test_2_3",
      ]);
      expect(ch.skills[2].unlock).toBe(1);
      // 两阶段专精：精2 + 主技能 7 后发起 M1（升级只写训练状态），结算后提升等级
      ch.mainSkillLvl = 7;
      await manager.upgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 });
      ch = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(ch.skills[0].state).toBe(1);
      expect(ch.skills[0].specializeLevel).toBe(0);
      await manager.completeUpgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 });
      ch = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(ch.skills[0].specializeLevel).toBe(1);
      expect(ch.skills[0].state).toBe(0);
      expect(ch.skills[0].completeUpgradeTime).toBe(-1);
    });

    it("等级提升不解锁技能2（标准规则：仅精英化解锁）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      // instId 1001 = char_001（level 1，E0）
      await manager.upgradeChar({
        charInstId: 1001,
        expMats: [asModel<ItemBundle>({ id: "exp_mat", count: 1 })], // 50 exp → level 2
      });
      const ch = mockPlayer._playerdata.troop!.chars[1001];
      expect(ch.level).toBe(2);
      // E0 已按官服线格式列出技能1+2，技能2 是 unlock:0 占位；等级提升不会解锁
      expect(ch.skills.map((s) => s.skillId)).toEqual([
        "skchr_test_1",
        "skchr_test_2",
      ]);
      expect(ch.skills[1].unlock).toBe(0);
      expect(ch.defaultSkillIndex).toBe(0);
      // 修复（2026-09-09）：精英化需当前阶段满级 → 先补满等级
      mockPlayer._playerdata.troop!.chars[1001].level = 50;
      // 精1 后解锁技能2
      await manager.evolveChar({ charInstId: 1001, destEvolvePhase: 1 });
      const ch1 = mockPlayer._playerdata.troop!.chars[1001];
      expect(ch1.skills.map((s) => s.skillId)).toEqual([
        "skchr_test_1",
        "skchr_test_2",
      ]);
      expect(ch1.skills[1].unlock).toBe(1);
    });

    it("空 id 的 extraItem 不应发放（防御：避免 gainItem 查 ItemTable[''] 警告）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      // 限定池 LMTGSID 缺失时旧实现 extraItem.id = "" → items:get 警告跳过
      await manager.onCharGet(["char_001", { from: "LIMITED", extraItem: asModel<ItemBundle>({ id: "", count: 1 }) }]);
      // 空 id extraItem 被过滤（不进入 gainItem 管道发放）
      const granted = mockPlayer.gainItem.add.mock.calls.map((c) => c[0]);
      expect(granted.some((i) => i.id === "")).toBe(false);
    });
  });

  describe("技能专精（完整两阶段流程：升级扣费 → 结算提升）", () => {
    /** 新建 char_002（E0，建档技能 unlock 0/0/0）并返回其 instId */
    const setupChar002 = async (manager: CharManager): Promise<number> => {
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_002", { from: "NORMAL" }]);
      return result.charInstId as number;
    };
    const getChar = (charInstId: number) =>
      mockPlayer._playerdata.troop!.chars[charInstId];

    it("升级专精应扣材料、写训练时间并进入训练状态；结算后提升等级", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      let ch = getChar(charInstId);
      ch.mainSkillLvl = 7;
      ch.evolvePhase = 2;
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await manager.upgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 });
      // 材料扣减（levelUpCostCond[0] = M1 材料）
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({ id: "sp_mat", count: 2 });
      ch = getChar(charInstId);
      expect(ch.skills[0].state).toBe(1); // 训练中
      expect(ch.skills[0].completeUpgradeTime).toBeGreaterThan(0); // now + lvlUpTime
      expect(ch.skills[0].specializeLevel).toBe(0); // 升级阶段不提升等级
      // 结算：专精 +1、状态复位
      await manager.completeUpgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 });
      ch = getChar(charInstId);
      expect(ch.skills[0].specializeLevel).toBe(1);
      expect(ch.skills[0].state).toBe(0);
      expect(ch.skills[0].completeUpgradeTime).toBe(-1);
      expect(emitSpy).toHaveBeenCalledWith("UpgradeSpecialization", [{ targetLevel: 1 }]);
      // 修复（2026-09-09，审计 §5.3）：CharSkillSpecCount（技能精熟奖章）此前无 emit 方
      expect(emitSpy).toHaveBeenCalledWith("CharSkillSpecCount", [{ targetLevel: 1 }]);
    });

    it("专精需逐级提升（目标必须为当前+1，防跳级少扣材料）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      const ch = getChar(charInstId);
      ch.mainSkillLvl = 7;
      ch.evolvePhase = 2;
      await expect(
        manager.upgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 2 }),
      ).rejects.toThrow("逐级提升");
    });

    it("主技能未达 7 级无法专精", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      const ch = getChar(charInstId);
      ch.evolvePhase = 2; // mainSkillLvl 保持 1
      await expect(
        manager.upgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 }),
      ).rejects.toThrow("未达 7");
    });

    it("未精二无法专精（levelUpCostCond 要求 PHASE_2）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      const ch = getChar(charInstId);
      ch.mainSkillLvl = 7; // evolvePhase 保持 0
      await expect(
        manager.upgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 }),
      ).rejects.toThrow("精英化2");
    });

    it("未解锁技能无法专精", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      const ch = getChar(charInstId);
      ch.mainSkillLvl = 7;
      ch.evolvePhase = 2;
      // skillIndex 1（skchr_test_2_2）建档时 unlock=0（需精1）
      await expect(
        manager.upgradeSpecialization({ charInstId, skillIndex: 1, targetLevel: 1 }),
      ).rejects.toThrow("未解锁");
    });

    it("未发起训练无法结算专精", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      const ch = getChar(charInstId);
      ch.mainSkillLvl = 7;
      ch.evolvePhase = 2;
      await expect(
        manager.completeUpgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 }),
      ).rejects.toThrow("未在专精训练中");
    });

    it("重复发起专精训练应拒绝（防重复扣材料）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      const ch = getChar(charInstId);
      ch.mainSkillLvl = 7;
      ch.evolvePhase = 2;
      await manager.upgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 });
      await expect(
        manager.upgradeSpecialization({ charInstId, skillIndex: 0, targetLevel: 1 }),
      ).rejects.toThrow("正在专精训练中");
    });
  });

  describe("技能升级精英化门槛与上限", () => {
    it("技能升至 4 级需精英二（allSkillLvlup unlockCond.phase）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_002", { from: "NORMAL" }]);
      const charInstId = result.charInstId as number;
      // E0：allSkillLvlup[2]（4 级）要求 PHASE_2 → 拒绝
      await expect(manager.upgradeSkill({ charInstId, targetLevel: 4 })).rejects.toThrow(
        "精英化2",
      );
      // 精2 后可正常升至 4 级（先补满等级：精英化需当前阶段满级）
      mockPlayer._playerdata.troop!.chars[charInstId].level = 50;
      await manager.evolveChar({ charInstId, destEvolvePhase: 2 });
      await manager.upgradeSkill({ charInstId, targetLevel: 4 });
      expect(mockPlayer._playerdata.troop!.chars[charInstId].mainSkillLvl).toBe(4);
    });

    it("技能目标等级超过上限应拒绝（allSkillLvlup 长度 + 1）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      // char_001 allSkillLvlup 仅 2 档 → 上限 3
      await expect(manager.upgradeSkill({ charInstId: 1001, targetLevel: 10 })).rejects.toThrow(
        "超过上限 3",
      );
      // 无技能干员（2 星）上限 1
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_502_nblade", { from: "NORMAL" }]);
      await expect(
        manager.upgradeSkill({ charInstId: result.charInstId as number, targetLevel: 2 }),
      ).rejects.toThrow("超过上限 1");
    });
  });

  describe("直升券（UseItem 端点：道具家族 + 稀有度校验 + 完整效果）", () => {
    const setupChar002 = async (manager: CharManager): Promise<number> => {
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_002", { from: "NORMAL" }]);
      return result.charInstId as number;
    };

    it("精二直升券应校验稀有度（6★券不可用于 4★干员）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      // char_001 rarity 5 → 6★；voucher_elite_II_4 为 4★券 → 拒绝
      await expect(
        manager.evolveCharUseItem({ charInstId: 1001, itemId: "voucher_elite_II_4", instId: 1 }),
      ).rejects.toThrow("稀有度与干员不匹配");
    });

    it("精二直升券应完整精二（E2、等级重置、皮肤#2、解锁技能）并推进事件", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      await manager.evolveCharUseItem({ charInstId, itemId: "voucher_elite_II_6", instId: 1 });
      const ch = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(ch.evolvePhase).toBe(2);
      expect(ch.level).toBe(1);
      expect(ch.exp).toBe(0);
      expect(ch.skin).toBe("char_002#2");
      expect(ch.skills[2].unlock).toBe(1); // 精二解锁技能3
      expect(emitSpy).toHaveBeenCalledWith("CharEvolveCount", [{ char: ch }]);
      expect(emitSpy).toHaveBeenCalledWith("EvolveChar", [{ char: ch }]);
      // 修复（2026-09-09，审计 §5.3）：CharEvolvePhase（特勤干员精二章）此前无 emit 方
      expect(emitSpy).toHaveBeenCalledWith("CharEvolvePhase", [
        { charId: "char_002", phase: 2 },
      ]);
    });

    it("满级直升券应按当前精英化阶段提升等级", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      // E0 阶段上限 = maxLevel[5][0] = 50
      await manager.upgradeCharLevelMaxUseItem({
        charInstId,
        itemId: "voucher_levelmax_6",
        instId: 1,
      });
      const ch = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(ch.level).toBe(50);
      expect(ch.exp).toBe(0);
    });

    it("专精直升券应满专精并复位训练状态", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      await manager.upgradeSpecializedSkillUseItem({
        charInstId,
        skillIndex: 0,
        itemId: "voucher_skill_specialLevelMax_6",
        instId: 1,
      });
      const ch = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(ch.skills[0].specializeLevel).toBe(3);
      expect(ch.skills[0].state).toBe(0);
      expect(ch.skills[0].completeUpgradeTime).toBe(-1);
    });

    it("使用非直升券道具应拒绝", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(
        manager.evolveCharUseItem({ charInstId: 1001, itemId: "mat_001", instId: 1 }),
      ).rejects.toThrow("不是 VOUCHER_ELITE_II_* 直升券");
    });
  });

  describe("干员存在性防御与安全空操作", () => {
    it("升级不存在的干员应抛业务错误（防 500）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(
        manager.upgradeChar({ charInstId: 9999, expMats: [] }),
      ).rejects.toThrow("干员不存在");
    });

    it("设置默认技能指向未解锁技能应拒绝", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_002", { from: "NORMAL" }]);
      const charInstId = result.charInstId as number;
      // 建档时技能2/3 未解锁（unlock=0）→ 拒绝；技能1 可设
      await expect(
        manager.setDefaultSkill({ charInstId, defaultSkillIndex: 1 }),
      ).rejects.toThrow("未解锁");
      await manager.setDefaultSkill({ charInstId, defaultSkillIndex: 0 });
      expect(mockPlayer._playerdata.troop!.chars[charInstId].defaultSkillIndex).toBe(0);
    });

    it("lockChar/sellChar 为安全空操作（官方已下架；仅校验干员存在性）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      await manager.lockChar({ charInstIdList: [1001, 9999] });
      await manager.sellChar({ charInstIdList: [1001] });
      // roster 不被修改、悬空 instId 不崩溃
      expect(mockPlayer._playerdata.troop!.chars[1001].charId).toBe("char_001");
      expect(mockPlayer._playerdata.troop!.chars[9999]).toBeUndefined();
    });
  });

  describe("精英化金币下标（evolveGoldCost 精一/精二两列）回归", () => {
    it("精一应扣精一档金币（evolveGoldCost[rarity][0]，非精二价）", async () => {
      // char_001 mock rarity=5（数字）→ rarityToIndex 直接返回 5 → index5=6星 [30000,180000]
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.troop!.chars[1001].level = 50; // 精英化需满级
      await manager.evolveChar({ charInstId: 1001, destEvolvePhase: 1 });
      expect(mockPlayer._playerdata.troop!.chars[1001].evolvePhase).toBe(1);
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({ id: "4001", count: 30000 });
    });

    it("精二应扣精二档金币（前端 destEvolvePhase=2 不再被拒，可正常精二）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.troop!.chars[1001].level = 50; // 精英化需满级
      await manager.evolveChar({ charInstId: 1001, destEvolvePhase: 2 });
      expect(mockPlayer._playerdata.troop!.chars[1001].evolvePhase).toBe(2);
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({ id: "4001", count: 180000 });
    });
  });

  describe("精英化错误路径（防静默失败）", () => {
    it("未满级不应可精英化（修复：原实现 1 级可直接精二）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.troop!.chars[1001].level = 1;
      mockPlayer._playerdata.troop!.chars[1001].evolvePhase = 0;
      await expect(
        manager.evolveChar({ charInstId: 1001, destEvolvePhase: 1 }),
      ).rejects.toThrow("未满级");
      // 阶段未推进
      expect(mockPlayer._playerdata.troop!.chars[1001].evolvePhase).toBe(0);
      // 满级后放行
      mockPlayer._playerdata.troop!.chars[1001].level = 50;
      await manager.evolveChar({ charInstId: 1001, destEvolvePhase: 1 });
      expect(mockPlayer._playerdata.troop!.chars[1001].evolvePhase).toBe(1);
    });

    it("不存在的干员应抛业务错误", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(
        manager.evolveChar({ charInstId: 9999, destEvolvePhase: 1 }),
      ).rejects.toThrow("干员不存在");
    });

    it("目标相位不高于当前相位应抛业务错误", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.troop!.chars[1001].evolvePhase = 1;
      await expect(
        manager.evolveChar({ charInstId: 1001, destEvolvePhase: 1 }),
      ).rejects.toThrow("目标相位");
    });
  });

  describe("满级喂经验卡应扣卡（防白嫖材料）", () => {
    it("满级时升级消耗经验卡但不产生金币、不越级", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      // char_001 rarity 5 → maxLevel[4][0]=50
      const char = mockPlayer._playerdata.troop!.chars[1001];
      char.level = 50;
      char.exp = 0;
      await manager.upgradeChar({
        charInstId: 1001,
        expMats: [asModel<ItemBundle>({ id: "exp_mat", count: 2 })],
      });
      // 满级时不产生金币消耗（不 push 4001）
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
      const used = mockPlayer.gainItem.add.mock.calls.map((c) => c[0]);
      expect(used.some((i) => i.id === "4001")).toBe(false);
      expect(used.some((i) => i.id === "exp_mat" && i.count === 2)).toBe(true);
      expect(char.level).toBe(50);
    });
  });

  describe("技能越级升级应逐档累计扣费", () => {
    // char_002 allSkillLvlup 3 档（2/3/4 级），需精二才可升 4 级
    const setupChar002 = async (manager: CharManager): Promise<number> => {
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const result = await manager.onCharGet(["char_002", { from: "NORMAL" }]);
      return result.charInstId as number;
    };

    it("从 1 级直接升 4 级应累计扣 2~4 级三档材料", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      mockPlayer._playerdata.troop!.chars[charInstId].evolvePhase = 2; // 满足 4 级精英化门槛
      await manager.upgradeSkill({ charInstId, targetLevel: 4 });
      // mock 的 update 整体替换 troop → 升级后须重新读取干员对象
      const char = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(char.mainSkillLvl).toBe(4);
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
      // char_002 allSkillLvlup 三档各 1 个 skill_mat → 累计 3 个
      const used = mockPlayer.gainItem.add.mock.calls.map((c) => c[0]);
      const skillMat = used.filter((i) => i.id === "skill_mat");
      expect(skillMat.reduce((s: number, i) => s + i.count, 0)).toBe(3);
    });

    it("目标等级不高于当前等级应拒绝（防刷请求）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      const charInstId = await setupChar002(manager);
      const char = mockPlayer._playerdata.troop!.chars[charInstId];
      char.evolvePhase = 2;
      char.mainSkillLvl = 4;
      await expect(
        manager.upgradeSkill({ charInstId, targetLevel: 3 }),
      ).rejects.toThrow("不高于当前等级");
    });
  });

  describe("建档与精二驱动模组状态（reconcileCharEquips 集成）", () => {
    it("新建干员按 charEquip 预填模组条目（E0 隐藏 hide:1）", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const res = await manager.onCharGet(["char_001", { from: "NORMAL" }]);
      const ch = mockPlayer._playerdata.troop!.chars[res.charInstId as number];
      // 建档即补齐该干员模组占位条目（char_001 → uniequip_001_test）
      expect(ch.equip["uniequip_001_test"]).toBeDefined();
      expect(ch.equip["uniequip_001_test"].hide).toBe(1); // E0 隐藏
      expect(ch.currentEquip).toBeNull();
    });

    it("elite 精二后隐藏→显示（hide:0）+ 精二即用模组 locked:0 + currentEquip", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.dexNav!.character = {};
      mockPlayer._playerdata.troop!.curCharInstId = 0;
      const res = await manager.onCharGet(["char_001", { from: "NORMAL" }]);
      const charInstId = res.charInstId as number;
      mockPlayer._playerdata.troop!.chars[charInstId].level = 50; // 精英化需满级
      await manager.evolveChar({ charInstId, destEvolvePhase: 2 });
      const ch = mockPlayer._playerdata.troop!.chars[charInstId];
      expect(ch.evolvePhase).toBe(2);
      expect(ch.equip["uniequip_001_test"].hide).toBe(0); // 显示
      expect(ch.equip["uniequip_001_test"].locked).toBe(0); // 精二即用解锁
      expect(ch.currentEquip).toBe("uniequip_001_test");
    });
  });

  describe("批量语音设置（batchSetCharVoiceLan 对齐官服抓包 R-1689144511000-4558）", () => {
    it("应设置全部干员 voiceLan 并同步 status.globalVoiceLan 与 npcAudio", async () => {
      const manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
      mockPlayer._playerdata.status.globalVoiceLan = "JP";
      mockPlayer._playerdata.npcAudio = {
        char_508_aguard: { voiceLan: 0, npcShowAudioInfoFlag: "JP" },
      };

      await manager.batchSetCharVoiceLan({ voiceLan: "CN_MANDARIN" });

      expect(mockPlayer._playerdata.troop!.chars[1001].voiceLan).toBe("CN_MANDARIN");
      expect(mockPlayer._playerdata.status.globalVoiceLan).toBe("CN_MANDARIN");
      expect(
        mockPlayer._playerdata.npcAudio.char_508_aguard.npcShowAudioInfoFlag
      ).toBe("CN_MANDARIN");
    });
  });
});
