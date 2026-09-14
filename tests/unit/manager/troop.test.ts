import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ItemData, StageData } from "@excel/types_excel_gen";
import type { PlayerSquadItem } from "@game/kernel/model";

/** 干员表窄视图行（TroopManager 只读这几个字段；真实 CharacterData 的其余字段本例不涉及） */
interface MockTroopCharRow {
  charId: string;
  name: string;
  /** 用例覆盖两种真实形态：数值索引与 "TIER_5" 字符串 */
  rarity: number | string;
  potentialItemId?: string;
  classicPotentialItemId?: string;
  skills: { skillId: string; unlockCond?: { phase: number; level: number } }[];
}

// Mock excel 数据表,提供 TroopManager 依赖的最小数据
vi.mock("@excel/excel", () => {
  /** 角色表:提供 rarity、potentialItemId、classicPotentialItemId、skills 字段（带索引签名） */
  const characterTable: Record<string, MockTroopCharRow> = {
    char_001: {
      charId: "char_001",
      name: "测试干员",
      rarity: 5,
      potentialItemId: "pot_001",
      classicPotentialItemId: "pot_classic_001",
      skills: [
        {
          skillId: "sk1",
          unlockCond: { phase: 0, level: 1 },
        },
      ],
    },
    char_002: {
      charId: "char_002",
      name: "字符串稀有度干员（真实数据格式）",
      rarity: "TIER_5",
      potentialItemId: "pot_001",
      classicPotentialItemId: "pot_classic_001",
      skills: [
        {
          skillId: "sk1",
          unlockCond: { phase: 0, level: 1 },
        },
      ],
    },
    char_002_amiya: {
      charId: "char_002_amiya",
      name: "阿米娅",
      rarity: 5,
      potentialItemId: "pot_amiya",
      skills: [],
    },
  };
  return {
    default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    // 本例 mock 未提供 ItemTable/StageTable：与真实门面「该表缺失 → 取不到」等价
    getItem(_id: string): ItemData | undefined { return undefined; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(_stageId: string): StageData | undefined { return undefined; },

      CharacterTable: characterTable,
      // 抽卡表:提供潜能物品转换器
      GachaTable: {
        potentialMaterialConverter: {
          items: {
            5: { id: "shard_5", count: 10, type: "MATERIAL" },
            4: { id: "shard_4", count: 5, type: "MATERIAL" },
          },
        },
        classicPotentialMaterialConverter: {
          items: {
            5: { id: "classic_shard_5", count: 5, type: "MATERIAL" },
          },
        },
      },
      // 模组装备表
      UniequipTable: {
        equipDict: {
          equip_001: {
            uniEquipId: "equip_001",
            charId: "char_001",
          },
          // tmpl 变体专属模组（fix 应对 tmpl 各形态按各自 charId 回填）
          equip_tmpl_001: {
            uniEquipId: "equip_tmpl_001",
            charId: "char_001_alt",
          },
        },
      },
      // 干员密录表（Round 22：addonStoryUnlock 归属与解锁条件校验的数据源）
      HandbookInfoTable: {
        handbookDict: {
          char_001: {
            charID: "char_001",
            handbookAvgList: [
              {
                storySetId: "story_001",
                storySetName: "测试密录",
                unlockParam: [
                  { unlockType: "AWAKE", unlockParam1: "2", unlockParam2: "1" },
                  { unlockType: "FAVOR", unlockParam1: "50" },
                ],
              },
              // 无解锁条件、且无对应勋章的密录（用于「无勋章配置返回 null」用例）
              { storySetId: "story_002", storySetName: "无勋章密录", unlockParam: [] },
            ],
          },
          // 有密录配置但玩家未持有（「未持有干员」用例）
          char_003: {
            charID: "char_003",
            handbookAvgList: [{ storySetId: "story_003", unlockParam: [] }],
          },
        },
      },
      // 信赖换算表（favorFrames：percent = 信赖显示值、favorPoint = 存档内部值）
      // 实测锚点：信赖 50 → 2732、信赖 200 → 25570（非线性曲线）
      FavorTable: {
        maxFavor: 25570,
        favorFrames: [
          { level: 0, data: { favorPoint: 0, percent: 0 } },
          { level: 2732, data: { favorPoint: 2732, percent: 50 } },
          { level: 25570, data: { favorPoint: 25570, percent: 200 } },
        ],
      },
      // 勋章表:提供干员密录勋章（CharStoryUnlock 模板）配置
      MedalTable: {
        medalList: [
          {
            medalId: "medal_story_char_001",
            template: "CharStoryUnlock",
            unlockParam: ["char_001", "story_001"],
          },
        ],
        medalTypeData: {},
      },
    },
  };
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

// Mock 时间工具,返回固定时间戳便于断言
vi.mock("@utils/time", () => ({
  now: () => 1234567890,
  checkBetween: (ts: number, start: number, end: number) =>
    ts >= start && ts <= end,
}));



import {
  asPlayerManager,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";
import { TroopManager } from "@game/modules/character/troop";

/**
 * TroopManager 单元测试
 * 覆盖编队管理、潜能分解、故事解锁、战斗事件触发等核心功能
 */
describe("TroopManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      troop: {
        curCharInstId: 1001,
        curSquadCount: 1,
        squads: {
          1: {
            squadId: "1",
            name: "编队1",
            slots: [],
          },
        },
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
          1002: {
            instId: 1002,
            charId: "char_002",
            favorPoint: 0,
            potentialRank: 0,
            mainSkillLvl: 1,
            skin: "char_002#1",
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
        addon: {
          char_001: {
            story: {},
          },
        },
        charGroup: {},
        charMission: {},
      },
      inventory: {
        pot_001: 3,
        pot_classic_001: 2,
      },
    });

    mockPlayer._trigger = mockTrigger;
    // 重写 update 实现,使其在 draft 上执行 recipe 并同步回 _playerdata
    // 覆写替身默认 update：与 helper 实现等价（JSON 深拷贝 draft → recipe → 回写）
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  describe("constructor", () => {
    it("应该正确初始化实例并注册 game:fix 事件监听", () => {
      const onSpy = vi.spyOn(mockTrigger, "on");
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
      expect(onSpy).toHaveBeenCalledWith("game:fix", expect.any(Function));
    });
  });

  describe("squadFormation", () => {
    it("应该更新编队槽位并触发 SquadFormation 事件", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      // 槽位夹具只给三个字段：真实 PlayerSquadItem 还要求 tmpl，而管理器对 slots 原样透传
      // （不读 tmpl），故此处按「契约的窄视图」声明后断言到 PlayerSquadItem[]，运行期值一字未改。
      const newSlots: { charInstId: number; skillIndex: number; currentEquip: string | null }[] = [
        { charInstId: 1001, skillIndex: 0, currentEquip: null },
      ];
      await manager.squadFormation({ squadId: 1, slots: newSlots as PlayerSquadItem[] });

      expect(mockPlayer._playerdata.troop!.squads[1].slots).toEqual(newSlots);
      expect(emitSpy).toHaveBeenCalledWith("SquadFormation", []);
    });
  });

  describe("changeSquadName", () => {
    it("应该更新指定编队的名称", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.changeSquadName({ squadId: 1, name: "新编队名" });

      expect(mockPlayer._playerdata.troop!.squads[1].name).toBe("新编队名");
    });
  });

  describe("decomposePotentialItem", () => {
    it("应该按稀有度分解潜能物品并触发 items:use 与 items:get 事件", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // rarity=5 -> 10 个 shard_5;inventory 中 pot_001 有 3 个 -> 共 30 个
      const result = await manager.decomposePotentialItem({
        charInstIdList: ["1001"],
      });

      expect(result).toEqual([{ id: "shard_5", count: 30 }]);
      // 扣/发经 gainItem 管道（use/handle + add），不再直发 items:use/items:get
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({ id: "pot_001", count: 3 });
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({ id: "shard_5", count: 30 });
    });
  });

  describe("decomposeClassicPotentialItem", () => {
    it("应该分解经典潜能物品并触发事件", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // rarity=5 -> 5 个 classic_shard_5;inventory 中 pot_classic_001 有 2 个 -> 共 10 个
      const result = await manager.decomposeClassicPotentialItem({
        charInstIdList: ["1001"],
      });

      expect(result).toEqual([{ id: "classic_shard_5", count: 10 }]);
      // 扣/发经 gainItem 管道（use/handle + add），不再直发 items:use/items:get
      expect(mockPlayer.gainItem.use).toHaveBeenCalled();
      expect(mockPlayer.gainItem.handle).toHaveBeenCalled();
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({ id: "pot_classic_001", count: 2 });
      expect(mockPlayer.gainItem.add).toHaveBeenCalledWith({ id: "classic_shard_5", count: 10 });
    });
  });

  describe("addonStoryUnlock", () => {
    /** 让 char_001 满足 story_001 的解锁条件（精二 Lv1 + 信赖 50 = favorPoint 2732） */
    function satisfyConditions() {
      const c = mockPlayer._playerdata.troop!.chars[1001];
      c.evolvePhase = 2;
      c.level = 1;
      c.favorPoint = 2732;
    }

    it("应该解锁指定干员的附加故事并记录时间戳", async () => {
      satisfyConditions();
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.addonStoryUnlock({
        charId: "char_001",
        storyId: "story_001",
      });

      const story = mockPlayer._playerdata.troop!.addon!.char_001.story;
      expect(story).toBeDefined();
      expect(story!.story_001).toBeDefined();
      expect(story!.story_001.fts).toBe(1234567890);
      expect(story!.story_001.rts).toBe(1234567890);
    });

    it("应该同步发放密录对应勋章并返回勋章 ID（对照官服抓包）", async () => {
      satisfyConditions();
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const medalId = await manager.addonStoryUnlock({
        charId: "char_001",
        storyId: "story_001",
      });

      expect(medalId).toBe("medal_story_char_001");
      const medal = mockPlayer._playerdata.medal!.medals.medal_story_char_001;
      expect(medal).toBeDefined();
      expect(medal.id).toBe("medal_story_char_001");
      expect(medal.val).toEqual([]);
      expect(medal.fts).toBe(1234567890);
      expect(medal.rts).toBe(-1);
    });

    it("无对应勋章配置时返回 null 且不写勋章", async () => {
      satisfyConditions();
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const medalId = await manager.addonStoryUnlock({
        charId: "char_001",
        storyId: "story_002",
      });

      expect(medalId).toBeNull();
      expect(mockPlayer._playerdata.medal).toBeUndefined();
      expect(mockPlayer._playerdata.troop!.addon!.char_001.story.story_002).toBeDefined();
    });

    // ===== Round 22：零校验修复（原实现任意组合都能解锁并白拿 384 枚勋章）=====

    it("归属校验：干员没有该密录时拒绝", async () => {
      satisfyConditions();
      const manager = new TroopManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(
        manager.addonStoryUnlock({ charId: "char_001", storyId: "story_401_not_exist" }),
      ).rejects.toThrow(/不存在密录/);
      expect(mockPlayer._playerdata.troop!.addon?.char_001?.story?.story_401_not_exist).toBeUndefined();
      expect(mockPlayer._playerdata.medal).toBeUndefined();
    });

    it("归属校验：storyId 与 charId 不匹配（他人密录）时拒绝", async () => {
      satisfyConditions();
      const manager = new TroopManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(
        manager.addonStoryUnlock({ charId: "char_002", storyId: "story_001" }),
      ).rejects.toThrow(/不存在密录/);
    });

    it("未持有该干员时拒绝", async () => {
      const manager = new TroopManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(
        manager.addonStoryUnlock({ charId: "char_003", storyId: "story_003" }),
      ).rejects.toThrow(/未持有干员/);
    });

    it("精英化/等级不满足时拒绝（story_001 需精二 Lv1）", async () => {
      satisfyConditions();
      mockPlayer._playerdata.troop!.chars[1001].evolvePhase = 1;
      const manager = new TroopManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(
        manager.addonStoryUnlock({ charId: "char_001", storyId: "story_001" }),
      ).rejects.toThrow(/需精英化2/);
    });

    it("信赖不足时拒绝（story_001 需信赖 50 = favorPoint 2732）", async () => {
      satisfyConditions();
      mockPlayer._playerdata.troop!.chars[1001].favorPoint = 2731;
      const manager = new TroopManager(asPlayerManager(mockPlayer), mockTrigger);
      await expect(
        manager.addonStoryUnlock({ charId: "char_001", storyId: "story_001" }),
      ).rejects.toThrow(/需信赖 50/);
    });
  });

  describe("addonStageBattleStart", () => {
    it("应调用 player.battle.start（携带关卡/编队/演习标记）并返回其结果（含 battleId）", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const startFn = vi.fn().mockResolvedValue({
        result: 0,
        battleId: "battle_abc",
        apFailReturn: 0,
        isApProtect: 0,
        inApProtectPeriod: false,
        notifyPowerScoreNotEnoughIfFailed: false,
      });
      // 组合根 battle 子管理器只用到 start 一个入口：Object.assign 注入（不新增关键字/Cast）
      Object.assign(mockPlayer, { battle: { start: startFn } });

      const squad = {
        squadId: "1",
        name: "test",
        slots: [],
      };
      const result = await manager.addonStageBattleStart({
        charId: "char_001",
        stageId: "stage_001",
        squad,
        stageType: "STORY",
      });

      // 复用 quest battle.start，带回 battleId 等结算上下文（客户端据此解密结算）
      expect(startFn).toHaveBeenCalledTimes(1);
      expect(startFn).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "stage_001",
          squad,
          // 悖论模拟为真实战斗（非演习），首通发 handbook rewardItem + 记录完成
          usePracticeTicket: 0,
          isReplay: 0,
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ battleId: "battle_abc", result: 0 }),
      );
    });
  });

  describe("addonStageBattleFinish", () => {
    it("应该触发 battle:finish 事件并原样传递参数与回调", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const emitSpy = vi.spyOn(mockTrigger, "emit");
      const args = {
        data: "test_data",
        battleData: { isCheat: "0", completeTime: 100 },
      };
      await manager.addonStageBattleFinish(args);

      expect(emitSpy).toHaveBeenCalledWith("battle:finish", [
        args,
        expect.any(Function),
      ]);
    });

    it("应通过回调回传战斗结算结果", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      const mockResult = {
        rewards: [{ id: "mat_001", type: "MATERIAL", count: 1 }],
        firstRewards: [],
      };
      mockTrigger.on("battle:finish", ([, cb]) => {
        // 事件契约的 callback 参数可为空，此处按用例意图必然存在
        cb!(mockResult);
      });

      const result = await manager.addonStageBattleFinish({
        data: "test_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result).toEqual(mockResult);
    });
  });

  describe("fix", () => {
    it("应该为干员补充缺失的技能与装备信息", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.fix();

      const char = mockPlayer._playerdata.troop!.chars[1001];
      // skills 应被补充为 excel 中定义的技能
      expect(char.skills!.length).toBe(1);
      expect(char.skills![0].skillId).toBe("sk1");
      // defaultSkillIndex 原为 -1,存在 skills 时应被修正为 0
      expect(char.defaultSkillIndex).toBe(0);
      // equip 应根据 UniequipTable 初始化
      expect(char.equip!.equip_001).toBeDefined();
      expect(char.equip!.equip_001.hide).toBe(1);
      expect(char.equip!.equip_001.locked).toBe(1);
    });

    it("tmpl 变体按各自 charId 回填 equip", async () => {
      mockPlayer._playerdata.troop!.chars[1001].tmpl = {
        char_001_alt: {
          skinId: "char_001_alt#1",
          defaultSkillIndex: 0,
          skills: [],
          currentEquip: null,
          equip: {},
        },
      };
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.fix();

      const patch = mockPlayer._playerdata.troop!.chars[1001].tmpl!.char_001_alt;
      // 归属 char_001_alt 的模组被回填；归属 char_001 的 base 模组不进 tmpl
      expect(patch.equip.equip_tmpl_001).toBeDefined();
      expect(patch.equip.equip_tmpl_001.hide).toBe(1);
      expect(patch.equip.equip_tmpl_001.locked).toBe(1);
      expect(patch.equip.equip_001).toBeUndefined();
    });
  });

  describe("decomposePotentialItem 字符串 rarity（2026-08-09 修复）", () => {
    it('rarity 为 "TIER_5" 字符串时应转索引分解（原 items["TIER_5"] undefined 500）', async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      // char_002 的 rarity 为字符串 "TIER_5"，items 表按数值键 5 —— 修复后应正确命中
      const result = await manager.decomposePotentialItem({
        charInstIdList: ["1002"],
      });
      // TIER_5 → 索引 4 → items[4] shard_4 count 5 × 3（pot_001 库存）= 15
      expect(result).toEqual([{ id: "shard_4", count: 15 }]);
    });

    it("不存在的干员应跳过而非 500", async () => {
      const manager = new TroopManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      const result = await manager.decomposePotentialItem({
        charInstIdList: ["99999"],
      });
      expect(result).toEqual([]);
    });
  });
});
