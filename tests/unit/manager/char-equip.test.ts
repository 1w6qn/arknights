import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ItemBundle, ItemTable } from "@excel/excel";
import type { CharacterData, StageTable } from "@excel/types_excel_gen";

vi.mock("@excel/excel", () => {
  return {
    default: {
    // 空表底座:门面方法体引用 this.X，键必须存在（空表语义与旧夹具一致——读不到数据）
    ItemTable: {} as ItemTable,
    CharacterTable: {} as CharacterData,
    StageTable: {} as StageTable,
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string) { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },

      GameDataConst: {},
      UniequipTable: {
        equipDict: {
          uniequip_001_test1: {
            uniEquipId: "uniequip_001_test1",
            uniEquipName: "测试模组1",
            uniEquipIcon: "icon1",
            uniEquipDesc: "desc1",
            typeIcon: "ORIGINAL",
            typeName1: "X",
            typeName2: null,
            equipShiningColor: "",
            showEvolvePhase: "PHASE_1",
            unlockEvolvePhase: "PHASE_1",
            charId: "char_001",
            tmplId: null,
            showLevel: 1,
            unlockLevel: 40,
            missionList: [],
            unlockFavors: { "1": null, "2": 100, "3": 200 },
            itemCost: {
              1: [{ id: "mat_unlock", count: 1, type: "MATERIAL" }],
              2: [{ id: "mat_up1", count: 2, type: "MATERIAL" }],
              3: [{ id: "mat_up2", count: 3, type: "MATERIAL" }],
            },
            type: "INITIAL",
            uniEquipGetTime: 0,
            uniEquipShowEnd: 0,
            charEquipOrder: 1,
            hasUnlockMission: false,
            isSpecialEquip: false,
            specialEquipDesc: "",
            specialEquipColor: "",
            charColor: "",
          },
          // 特殊模组：带解锁任务 + PHASE_2 门槛
          uniequip_002_test1: {
            uniEquipId: "uniequip_002_test1",
            uniEquipName: "测试模组2（特殊）",
            charId: "char_001",
            unlockEvolvePhase: "PHASE_2",
            unlockLevel: 50,
            missionList: ["mission_002_1"],
            unlockFavors: { "1": null },
            itemCost: { 1: [{ id: "mat_special", count: 1, type: "MATERIAL" }] },
            type: "ADVANCED",
            hasUnlockMission: true,
          },
          // 属于其它干员的模组（归属校验用）
          uniequip_003_other: {
            uniEquipId: "uniequip_003_other",
            charId: "char_999",
            unlockEvolvePhase: "PHASE_0",
            unlockLevel: 1,
            missionList: [],
            itemCost: { 1: [] },
            type: "INITIAL",
            hasUnlockMission: false,
          },
          // 无精二/等级门槛的基础模组（fresh char 解锁用）
          uniequip_004_fresh: {
            uniEquipId: "uniequip_004_fresh",
            charId: "char_001",
            showEvolvePhase: "PHASE_2",
            unlockEvolvePhase: "PHASE_0",
            unlockLevel: 1,
            missionList: [],
            itemCost: { 1: [{ id: "mat_fresh", count: 1, type: "MATERIAL" }] },
            type: "INITIAL",
            hasUnlockMission: false,
          },
          // 精二即用模组（真实 excel：unlockEvolvePhase 为数字 0 + unlockLevel 0）
          uniequip_005_free: {
            uniEquipId: "uniequip_005_free",
            charId: "char_001",
            showEvolvePhase: "PHASE_2",
            unlockEvolvePhase: 0,
            unlockLevel: 0,
            missionList: [],
            itemCost: { 1: [] },
            type: "INITIAL",
            hasUnlockMission: false,
          },
        },
        missionList: {
          mission_002_1: {
            template: "EquipmentDeployStage",
            desc: "部署 5 次无人机",
            paramList: ["5", "5", "token_x", "char_001"],
            uniEquipMissionId: "mission_002_1",
            uniEquipMissionSort: 1,
            uniEquipId: "uniequip_002_test1",
            jumpStageId: null,
          },
        },
        subProfDict: {},
        charEquip: { char_001: ["uniequip_001_test1", "uniequip_002_test1", "uniequip_004_fresh", "uniequip_005_free"] },
        equipTrackDict: [],
      },
      CharMetaTable: {
        spCharMissions: {
          char_001: {
            mission_char_001_0: {
              charId: "char_001",
              missionId: "mission_char_001_0",
              sortId: 1,
              condType: 1,
              param: ["1", "1"],
              rewards: [{ id: "2002", count: 25, type: 2 }],
            },
          },
        },
      },
    },
  };
});

import { mockPlayerData, mockTypedEventEmitter, asPlayerManager } from "../../helpers";
import type { PlayerCharacter } from "@game/kernel/model";
import { CharManager } from "@game/modules/character/char";
import { EquipmentMissionManager } from "@game/modules/equipmentMission/equipmentMission";
import { reconcileCharEquips } from "@game/kernel/char-skills";

/** 构造一份基础干员夹具（可覆盖局部字段；缺省字段由被测实现的惰性分支承受） */
function makeChar(overrides: Partial<PlayerCharacter> = {}): PlayerCharacter {
  return {
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
    ...overrides,
  };
}

describe("CharManager 模组（uniequip）", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;
  let emitSpy: ReturnType<typeof vi.fn>;
  let manager: CharManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockTrigger = mockTypedEventEmitter();
    mockPlayer = mockPlayerData({
      troop: {
        chars: { 1001: makeChar() },
        curCharInstId: 1001,
      },
      equipment: { missions: {} },
      status: { gold: 9999, uid: 10000 },
    });
    mockPlayer._trigger = mockTrigger;
    // CharManager 经真实 PlayerDataManager 的 equipmentMission getter 取任务管理器
    // （mock 组合根没有该 getter，用 Object.assign 挂上等价替身；不引入 any/cast）
    Object.assign(mockPlayer, {
      equipmentMission: new EquipmentMissionManager(asPlayerManager(mockPlayer)),
    });
    manager = new CharManager(asPlayerManager(mockPlayer), mockTrigger);
    // TypedEventEmitter 为真实实现——对 emit 打 spy 记录事件（items:use / HasEquipment）
    emitSpy = vi.spyOn(mockTrigger, "emit");
  });

  /** 从 mockPlayer 取当前干员 */
  function char(): PlayerCharacter {
    return mockPlayer._playerdata.troop!.chars![1001];
  }

  function emittedItemsUse(): ItemBundle[] {
    // 物品消耗经 gainItem 管道（add + use），不再直发 items:use
    return mockPlayer.gainItem.add.mock.calls.map((c) => c[0]);
  }

  describe("unlockEquipment", () => {
    it("满足条件时解锁：扣费 + 置 hide/locked 0 + HasEquipment", async () => {
      // 满足 PHASE_1 + 40 级条件
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({
        evolvePhase: 1,
        level: 45,
      });

      await manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_001_test1" });

      const entry = char().equip["uniequip_001_test1"];
      expect(entry.hide).toBe(0);
      expect(entry.locked).toBe(0);
      expect(entry.level).toBe(1);
      // 扣费 itemCost[1]
      expect(emittedItemsUse()).toEqual([{ id: "mat_unlock", count: 1, type: "MATERIAL" }]);
      expect(emitSpy).toHaveBeenCalledWith("HasEquipment", expect.anything());
    });

    it("条件不足（精二阶段）拒绝且不扣费", async () => {
      // evolvePhase 0 < PHASE_1
      await expect(
        manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_001_test1" }),
      ).rejects.toThrow("精英化");
      expect(emittedItemsUse()).toHaveLength(0);
      expect(char().equip["uniequip_001_test1"]).toBeUndefined();
    });

    it("等级不足拒绝", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({ evolvePhase: 1, level: 10 });
      await expect(
        manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_001_test1" }),
      ).rejects.toThrow("等级 40");
    });

    it("fresh 干员（equip 空条目）解锁不崩溃，条目被初始化", async () => {
      // 无门槛模组
      await manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_004_fresh" });
      const entry = char().equip["uniequip_004_fresh"];
      expect(entry.hide).toBe(0);
      expect(entry.locked).toBe(0);
    });

    it("重复解锁拒绝", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({
        evolvePhase: 1,
        level: 45,
        equip: { uniequip_001_test1: { hide: 0, locked: 0, level: 1 } },
      });
      await expect(
        manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_001_test1" }),
      ).rejects.toThrow("已解锁");
    });

    it("非本干员模组拒绝", async () => {
      await expect(
        manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_003_other" }),
      ).rejects.toThrow("不属于");
    });

    it("特殊模组任务未完成时拒绝解锁", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({ evolvePhase: 2, level: 60 });
      // 任务未播种/未完成（value=0）→ 拒绝解锁
      await expect(
        manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_002_test1" }),
      ).rejects.toThrow(/未完成/);
      expect(char().equip["uniequip_002_test1"]).toBeUndefined();
    });

    it("特殊模组任务已完成（progress 达标）时解锁", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({ evolvePhase: 2, level: 60 });
      // 任务进度已达标（如战斗胜利结算推进 EquipmentDeployStage 完成 5 场）
      mockPlayer._playerdata.equipment!.missions!["mission_002_1"] = { value: 5, target: 5 };
      await manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_002_test1" });
      expect(char().equip["uniequip_002_test1"].locked).toBe(0);
      // 已完成的任务条目不回退
      expect(mockPlayer._playerdata.equipment!.missions!["mission_002_1"]).toEqual({ value: 5, target: 5 });
    });
  });

  describe("upgradeEquipment", () => {
    beforeEach(() => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({
        evolvePhase: 1,
        level: 45,
        // 满足升级到 3 级的信赖门槛（unlockFavors["3"]=200）
        favorPoint: 300,
        equip: { uniequip_001_test1: { hide: 0, locked: 0, level: 1 } },
      });
    });

    it("1→3 累计扣 itemCost[2]+itemCost[3]（修复：原实现只扣目标档）", async () => {
      await manager.upgradeEquipment({
        charInstId: 1001,
        templateId: "",
        equipId: "uniequip_001_test1",
        targetLevel: 3,
      });

      expect(char().equip["uniequip_001_test1"].level).toBe(3);
      const items = emittedItemsUse();
      expect(items).toHaveLength(2); // itemCost[2] + itemCost[3]
      expect(items[0]).toEqual({ id: "mat_up1", count: 2, type: "MATERIAL" });
      expect(items[1]).toEqual({ id: "mat_up2", count: 3, type: "MATERIAL" });
    });

    it("目标等级不高于当前等级拒绝", async () => {
      await expect(
        manager.upgradeEquipment({
          charInstId: 1001,
          templateId: "",
          equipId: "uniequip_001_test1",
          targetLevel: 1,
        }),
      ).rejects.toThrow("不高于");
    });

    it("目标等级超过最高档拒绝", async () => {
      await expect(
        manager.upgradeEquipment({
          charInstId: 1001,
          templateId: "",
          equipId: "uniequip_001_test1",
          targetLevel: 4,
        }),
      ).rejects.toThrow("最高等级为 3");
    });

    it("未解锁模组拒绝升级", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({
        evolvePhase: 1,
        level: 45,
        equip: { uniequip_001_test1: { hide: 1, locked: 1, level: 1 } },
      });
      await expect(
        manager.upgradeEquipment({
          charInstId: 1001,
          templateId: "",
          equipId: "uniequip_001_test1",
          targetLevel: 2,
        }),
      ).rejects.toThrow("尚未解锁");
    });

    it("tmpl 变体：操作 tmpl 内的 equip，不读 base 等级", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({
        evolvePhase: 1,
        level: 45,
        favorPoint: 300,
        tmpl: {
          char_1001_alt: {
            skinId: "char_1001_alt#1",
            defaultSkillIndex: 0,
            skills: [],
            currentEquip: null,
            equip: { uniequip_001_test1: { hide: 0, locked: 0, level: 2 } },
          },
        },
        equip: { uniequip_001_test1: { hide: 0, locked: 0, level: 1 } },
      });

      await manager.upgradeEquipment({
        charInstId: 1001,
        templateId: "char_1001_alt",
        equipId: "uniequip_001_test1",
        targetLevel: 3,
      });

      const patch = char().tmpl!["char_1001_alt"];
      expect(patch.equip["uniequip_001_test1"].level).toBe(3);
      // base 等级不受影响
      expect(char().equip["uniequip_001_test1"].level).toBe(1);
      // 只扣第 3 档费用
      const items = emittedItemsUse();
      expect(items).toEqual([{ id: "mat_up2", count: 3, type: "MATERIAL" }]);
    });
  });

  describe("setEquipment", () => {
    it("仅可装备已解锁模组", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({
        equip: { uniequip_001_test1: { hide: 0, locked: 0, level: 1 } },
      });
      await manager.setEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_001_test1" });
      expect(char().currentEquip).toBe("uniequip_001_test1");
    });

    it("未解锁模组拒绝装备", async () => {
      await expect(
        manager.setEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_001_test1" }),
      ).rejects.toThrow("尚未解锁");
    });

    it("非本干员模组拒绝", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({
        equip: { uniequip_003_other: { hide: 0, locked: 0, level: 1 } },
      });
      await expect(
        manager.setEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_003_other" }),
      ).rejects.toThrow("不属于");
    });
  });

  describe("changeCharTemplate", () => {
    it("templateId 为基础 charId 时切回基础形态（currentTmpl 清除）", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({ currentTmpl: "char_1001_alt" });
      await manager.changeCharTemplate({ charInstId: 1001, templateId: "char_001" });
      expect(char().currentTmpl).toBeUndefined();
    });

    it("未知模板自动初始化 tmpl 补丁（拷贝基础形态）", async () => {
      await manager.changeCharTemplate({ charInstId: 1001, templateId: "char_1001_alt" });
      expect(char().currentTmpl).toBe("char_1001_alt");
      const patch = char().tmpl!["char_1001_alt"];
      expect(patch.skinId).toBe("char_001#1");
      expect(patch.currentEquip).toBeNull();
      expect(patch.equip).toEqual({});
    });
  });

  describe("精二模组校正（reconcileCharEquips：从无到有转变）", () => {
    it("E0 建档隐藏模组条目（hide:1）", () => {
      const ch = makeChar(); // 默认 E0、equip 空
      reconcileCharEquips(ch);
      // E0：模组条目补齐但隐藏（showEvolvePhase=PHASE_2 → hide:1）
      expect(ch.equip).toBeDefined();
      expect(ch.equip["uniequip_001_test1"].hide).toBe(1);
      expect(ch.equip["uniequip_004_fresh"].hide).toBe(1);
      expect(ch.equip["uniequip_005_free"].hide).toBe(1);
      expect(ch.currentEquip).toBeNull();
    });

    it("E2 精二后模组条目隐藏→显示（hide:0）+ 精二即用模组 locked:0 + currentEquip", () => {
      const ch = makeChar({ evolvePhase: 2 });
      reconcileCharEquips(ch);
      // 精二后所有模组显示
      expect(ch.equip["uniequip_001_test1"].hide).toBe(0);
      expect(ch.equip["uniequip_004_fresh"].hide).toBe(0);
      // 精二即用模组（unlockEvolvePhase 数字 0 + unlockLevel 0）自动解锁
      expect(ch.equip["uniequip_005_free"].hide).toBe(0);
      expect(ch.equip["uniequip_005_free"].locked).toBe(0);
      // 需材料解锁的模组仍 locked:1
      expect(ch.equip["uniequip_001_test1"].locked).toBe(1);
      // currentEquip 指向首个已解锁模组
      expect(ch.currentEquip).toBe("uniequip_005_free");
    });

    it("unlockEquipment 对精二后显示条目的解锁仍可用（不破坏既有解锁流程）", async () => {
      mockPlayer._playerdata.troop!.chars![1001] = makeChar({ evolvePhase: 1, level: 45 });
      await manager.unlockEquipment({ charInstId: 1001, templateId: "", equipId: "uniequip_001_test1" });
      expect(char().equip["uniequip_001_test1"].locked).toBe(0);
    });
  });
});
