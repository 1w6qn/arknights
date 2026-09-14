import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ItemTable } from "@excel/excel";
import type { CharacterData, StageTable } from "@excel/types_excel_gen";

// Mock excel 数据表,DexNavManager 不直接依赖任何 excel 表,提供空对象即可
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



import {
  asPlayerManager,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";
import { DexNavManager } from "@game/modules/dexnav/dexnav";

/**
 * DexNavManager 单元测试
 * 覆盖 teamV2Info getter 的各种场景:空数据、多个团队、空团队等
 */
describe("DexNavManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      dexNav: {
        character: {},
        formula: {
          shop: {},
          manufacture: {},
          workshop: {},
        },
        enemy: {
          enemies: {},
          stage: {},
        },
        teamV2: {},
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
    it("应该正确初始化 DexNavManager 实例", () => {
      const manager = new DexNavManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
    });
  });

  describe("teamV2Info", () => {
    it("当 teamV2 为空对象时应返回空对象", () => {
      const manager = new DexNavManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      expect(manager.teamV2Info).toEqual({});
    });

    it("应该将每个团队映射为其成员数量", () => {
      const manager = new DexNavManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockPlayer._playerdata.dexNav!.teamV2 = {
        team_001: { char_a: 1, char_b: 2, char_c: 3 },
        team_002: { char_d: 1 },
      };

      const info = manager.teamV2Info;
      expect(info).toEqual({
        team_001: 3,
        team_002: 1,
      });
    });

    it("当某个团队为空对象时应返回 0", () => {
      const manager = new DexNavManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockPlayer._playerdata.dexNav!.teamV2 = {
        team_empty: {},
        team_with_members: { char_a: 1, char_b: 2 },
      };

      const info = manager.teamV2Info;
      expect(info).toEqual({
        team_empty: 0,
        team_with_members: 2,
      });
    });

    it("应该正确处理包含多个团队的场景", () => {
      const manager = new DexNavManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      mockPlayer._playerdata.dexNav!.teamV2 = {
        team_a: { c1: 1, c2: 2 },
        team_b: { c3: 1 },
        team_c: { c4: 1, c5: 2, c6: 3, c7: 4 },
        team_d: {},
      };

      const info = manager.teamV2Info;
      expect(info).toEqual({
        team_a: 2,
        team_b: 1,
        team_c: 4,
        team_d: 0,
      });
      // 验证总数
      expect(Object.keys(info).length).toBe(4);
    });

    it("每次访问 getter 都应基于最新数据返回结果", () => {
      const manager = new DexNavManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      // 第一次访问,teamV2 为空
      expect(manager.teamV2Info).toEqual({});

      // 修改数据
      mockPlayer._playerdata.dexNav!.teamV2 = {
        team_new: { c1: 1, c2: 2 },
      };

      // 第二次访问应反映最新数据
      expect(manager.teamV2Info).toEqual({
        team_new: 2,
      });
    });
  });
});
