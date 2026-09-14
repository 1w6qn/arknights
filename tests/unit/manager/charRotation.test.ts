import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ItemTable } from "@excel/excel";
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
},
  };
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

vi.mock("@utils/time", () => ({
  now: () => 1234567890,
}));


// Mock immer:original 在源码中导入但未实际使用,提供空实现避免运行时错误
vi.mock("immer", () => ({
  original: <T>(x: T): T => x,
}));

import {
  asModel,
  mockPlayerData,
  mockTypedEventEmitter,
  asPlayerManager,
} from "../../helpers";
import type { MockPlayerDataSeed } from "../../helpers";
import type {
  PlayerCharRotationPreset,
  PlayerCharRotationSlot,
} from "@game/kernel/playerdata";
import {
  CharRotationManager,
  CharRotationUpdatePresetRequest,
} from "@game/modules/character/char-rotation-manager";

/**
 * CharRotationManager 单元测试
 * 覆盖预设的增删改查与当前界面配置切换
 */
describe("CharRotationManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    // 夹具沿用旧存档的 mainStageProgress: null（生成模型声明为 string，两态并存：
    // 未同步主线的新档为 null）。运行期值一字不改，仅在种子边界按「深可选宽契约」
    // 断言一次（字段名与其余字段类型仍参与检查）。
    const statusSeed: Omit<NonNullable<MockPlayerDataSeed["status"]>, "mainStageProgress"> & {
      mainStageProgress?: string | null;
    } = {
      nickName: "TestUser",
      nickNumber: "0",
      level: 1,
      exp: 0,
      socialPoint: 0,
      gachaTicket: 0,
      tenGachaTicket: 0,
      instantFinishTicket: 0,
      hggShard: 0,
      lggShard: 0,
      recruitLicense: 0,
      progress: 0,
      buyApRemainTimes: 0,
      apLimitUpFlag: 0,
      uid: "10000",
      flags: {},
      ap: 100,
      maxAp: 100,
      androidDiamond: 0,
      iosDiamond: 0,
      diamondShard: 0,
      gold: 9999,
      practiceTicket: 0,
      lastRefreshTs: 0,
      lastApAddTime: 0,
      mainStageProgress: null,
      registerTs: 0,
      lastOnlineTs: 0,
      serverName: "TestServer",
      avatarId: "",
      resume: "",
      birthday: { month: 1, day: 1 },
      friendNumLimit: 50,
      monthlySubscriptionStartTime: 0,
      monthlySubscriptionEndTime: 0,
      secretary: "",
      secretarySkinId: "",
      tipMonthlyCardExpireTs: 0,
      avatar: { type: "ICON", id: "avatar_001" },
      globalVoiceLan: "CN_MANDARIN",
      classicShard: 0,
      classicGachaTicket: 0,
      classicTenGachaTicket: 0,
    };

    mockPlayer = mockPlayerData({
      charRotation: {
        current: "1",
        preset: {
          "1": {
            name: "预设1",
            background: "bg_rhodes_day",
            homeTheme: "tm_rhodes_day",
            profile: "char_002_amiya#1",
            profileInst: 1001,
            slots: [
              { charId: "char_002_amiya", skinId: "char_002_amiya#1", skinSp: false },
            ],
          },
        },
      },
      background: {
        selected: "bg_default",
        bgs: {},
      },
      homeTheme: {
        selected: "tm_default",
        themes: {},
      },
      status: statusSeed as NonNullable<MockPlayerDataSeed["status"]>,
      troop: {
        curCharInstId: 1001,
        curSquadCount: 1,
        squads: {},
        chars: {
          1001: {
            instId: 1001,
            charId: "char_002_amiya",
            favorPoint: 0,
            potentialRank: 0,
            mainSkillLvl: 1,
            skin: "char_002_amiya#1",
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
        addon: {},
        charGroup: {},
        charMission: {},
      },
    });

    mockPlayer._trigger = mockTrigger;
    // 覆写替身默认 update：与 helper 实现等价（JSON 深拷贝 draft → recipe → 回写）
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  describe("constructor", () => {
    it("应该正确初始化 CharRotationManager 实例", () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
    });
  });

  describe("setCurrent", () => {
    it("应该切换当前预设并同步背景、主题与秘书配置", async () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.setCurrent({ instId: "1" });

      expect(mockPlayer._playerdata.charRotation!.current).toBe("1");
      expect(mockPlayer._playerdata.background!.selected).toBe("bg_rhodes_day");
      expect(mockPlayer._playerdata.homeTheme!.selected).toBe("tm_rhodes_day");
      expect(mockPlayer._playerdata.status!.secretarySkinId).toBe(
        "char_002_amiya#1"
      );
      expect(mockPlayer._playerdata.status!.secretary).toBe("char_002_amiya");
    });
  });

    it("profileInst 指向不存在干员时应回退 profile 字符串而非 500", async () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      // preset 1 的 profileInst=1 在 mock 中不存在（mock chars 键为 1001）→ 回退 profile
      // 夹具为增量写入的局部预设视图（省略 profileSp，模型虽必填但管理器不读该键），
      // 经 asModel 按深可选宽契约断言回真实类型；运行期值一字不改
      mockPlayer._playerdata.charRotation!.preset["1"] = asModel<PlayerCharRotationPreset>({
        name: "test",
        background: "bg_rhodes_day",
        homeTheme: "tm_rhodes_day",
        profile: "char_1012_skadi2#1",
        profileInst: 1,
        slots: [],
      });
      await expect(
        manager.setCurrent({ instId: "1" }),
      ).resolves.not.toThrow();
      expect(mockPlayer._playerdata.status!.secretary).toBe("char_1012_skadi2");
    });

    it("未知预设 instId 不应抛错（不再 500）", async () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      await expect(
        manager.setCurrent({ instId: "999" }),
      ).resolves.not.toThrow();
    });

  describe("createPreset", () => {
    it("应该创建新预设并返回 instId", async () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // 修复：预设键为 {1} → 新预设 id = 最大数值 + 1 = "2"
      //（原实现 maxBy 字典序比较会覆盖最高档而非新建）
      const result = await manager.createPreset();

      expect(result).toBe("2");
      const preset = mockPlayer._playerdata.charRotation!.preset["2"];
      expect(preset).toBeDefined();
      expect(preset.name).toBe("未命名界面配置");
      expect(preset.background).toBe("bg_rhodes_day");
      expect(preset.homeTheme).toBe("tm_rhodes_day");
      expect(preset.profile).toBe("char_002_amiya#1");
      expect(preset.profileInst).toBe(1);
      expect(preset.slots).toEqual([
        { charId: "char_002_amiya", skinId: "char_002_amiya#1", skinSp: false },
      ]);
    });
  });

  describe("updatePreset", () => {
    it("应该根据传入 data 更新预设字段并同步当前选中状态", async () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const req: CharRotationUpdatePresetRequest = {
        instId: "1",
        flag: 0,
        data: {
          name: "更新后的预设",
          background: "bg_new",
          homeTheme: "tm_new",
          secretarySkinId: "char_002_amiya#2",
          secretaryCharInstId: "1001",
          slots: [
            // 客户端载荷可省略 skinSp（下方断言也按省略值比对），模型声明为必填；
            // 经 asModel 按深可选宽契约断言，运行期值一字不改
            asModel<PlayerCharRotationSlot>({ charId: "char_002_amiya", skinId: "char_002_amiya#2" }),
          ],
        },
      };
      await manager.updatePreset(req);

      const preset = mockPlayer._playerdata.charRotation!.preset["1"];
      expect(preset.name).toBe("更新后的预设");
      expect(preset.background).toBe("bg_new");
      expect(preset.homeTheme).toBe("tm_new");
      expect(preset.profile).toBe("char_002_amiya#2");
      expect(preset.profileInst).toBe(1001);
      expect(preset.slots).toEqual([
        { charId: "char_002_amiya", skinId: "char_002_amiya#2" },
      ]);
      // 同步当前选中状态
      expect(mockPlayer._playerdata.background!.selected).toBe("bg_new");
      expect(mockPlayer._playerdata.homeTheme!.selected).toBe("tm_new");
      expect(mockPlayer._playerdata.status!.secretarySkinId).toBe(
        "char_002_amiya#2"
      );
      expect(mockPlayer._playerdata.status!.secretary).toBe("char_002_amiya");
    });

    it("当 data 仅含部分字段时应该只更新对应字段", async () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const originalPreset = JSON.parse(
        JSON.stringify(mockPlayer._playerdata.charRotation!.preset["1"])
      );

      await manager.updatePreset({
        instId: "1",
        flag: 0,
        data: {
          name: "仅改名",
        },
      });

      const preset = mockPlayer._playerdata.charRotation!.preset["1"];
      expect(preset.name).toBe("仅改名");
      // 其他字段保持不变
      expect(preset.background).toBe(originalPreset.background);
      expect(preset.homeTheme).toBe(originalPreset.homeTheme);
      expect(preset.profile).toBe(originalPreset.profile);
    });

    it("secretaryCharInstId 指向不存在干员时应跳过而非 500", async () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      // 修复前：draft.troop.chars["999"].charId 解引用 undefined → TypeError
      await expect(
        manager.updatePreset({
          instId: "1",
          flag: 0,
          data: {
            secretaryCharInstId: "999",
          },
        }),
      ).resolves.not.toThrow();
      // 预设与秘书配置均不被破坏
      const preset = mockPlayer._playerdata.charRotation!.preset["1"];
      expect(preset.profileInst).toBe(1001);
      expect(mockPlayer._playerdata.status!.secretary).toBe("");
    });
  });

  describe("deletePreset", () => {
    it("应该删除指定 instId 的预设", async () => {
      const manager = new CharRotationManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // 先添加第二个预设,确保删除后仍有预设存在
      // 同「增量写入的局部预设视图」：省略 profileSp，经 asModel 按深可选宽契约断言
      mockPlayer._playerdata.charRotation!.preset["2"] = asModel<PlayerCharRotationPreset>({
        name: "预设2",
        background: "bg_2",
        homeTheme: "tm_2",
        profile: "p2",
        profileInst: 2,
        slots: [],
      });

      await manager.deletePreset({ instId: "1" });

      expect(
        mockPlayer._playerdata.charRotation!.preset["1"]
      ).toBeUndefined();
      expect(
        mockPlayer._playerdata.charRotation!.preset["2"]
      ).toBeDefined();
    });
  });
});
