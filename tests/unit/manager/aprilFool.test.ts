import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ItemTable } from "@excel/excel";
import type { CharacterData, StageTable } from "@excel/types_excel_gen";

// Mock excel 数据表,AprilFoolManager 不直接依赖任何 excel 表
vi.mock("@excel/excel", () => {
  return {
    default: {
    // 门面方法读取的表显式声明（工厂对象 `this` 即字面量自身）；
    // 空表与「键不存在的旧 mock」运行期等价（`?.` 链同样取到 undefined）
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



// Mock 加密工具,使用 vi.fn() 以便针对每个用例动态配置返回值
vi.mock("@utils/crypt", () => ({
  decryptBattleData: vi.fn(),
}));

import { asPlayerManager, mockPlayerData, mockTypedEventEmitter } from "../../helpers";
import { AprilFoolManager } from "@game/modules/aprilFool/april-fool-manager";
import { decryptBattleData } from "@utils/crypt";

/**
 * AprilFoolManager 单元测试
 * 覆盖 act5funBattleFinish 方法的得分解析、胜利计数、边界场景等
 */
describe("AprilFoolManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      pushFlags: {
        hasGifts: 0,
        hasFriendRequest: 0,
        hasClues: 0,
        hasFreeLevelGP: 0,
        status: 999,
      },
    });

    mockPlayer._trigger = mockTrigger;
    // 重写 update 实现,使其在 draft 上执行 recipe 并同步回 _playerdata
    mockPlayer.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(mockPlayer._playerdata));
      const result = await recipe(draft);
      Object.assign(mockPlayer._playerdata, draft);
      return result;
    });
  });

  /**
   * 辅助函数:配置 decryptBattleData mock 的返回值
   * @param extraBattleInfo - 战斗额外信息对象
   */
  function mockDecryptReturn(extraBattleInfo: { [key: string]: number }) {
    (decryptBattleData as ReturnType<typeof vi.fn>).mockResolvedValue({
      battleId: "battle_001",
      interrupt: 0,
      giveUp: 0,
      percent: 0,
      completeState: 0,
      killCnt: 0,
      validKillCnt: 0,
      battleData: {
        stats: {
          extraBattleInfo,
        },
        isCheat: "0",
        completeTime: 100,
      },
      currentIndex: 0,
      platform: 0,
    });
  }

  describe("constructor", () => {
    it("应该正确初始化 AprilFoolManager 实例", () => {
      const manager = new AprilFoolManager(asPlayerManager(mockPlayer), mockTrigger);
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
    });
  });

  describe("act5funBattleFinish", () => {
    it("应该从 SIMPLE,money 字段中解析得分", async () => {
      const manager = new AprilFoolManager(asPlayerManager(mockPlayer), mockTrigger);

      mockDecryptReturn({
        "SIMPLE,money,12345": 1,
      });

      const result = await manager.act5funBattleFinish({
        data: "encrypted_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result.result).toBe(0);
      expect(result.score).toBe(12345);
      expect(result.isHighScore).toBe(false);
      expect(result.reward).toEqual([]);
    });

    it("应该统计 DETAILED,player,*,win 的胜利次数", async () => {
      const manager = new AprilFoolManager(asPlayerManager(mockPlayer), mockTrigger);

      mockDecryptReturn({
        "DETAILED,player,1,win": 1,
        "DETAILED,player,2,win": 1,
        "DETAILED,player,3,win": 1,
      });

      const result = await manager.act5funBattleFinish({
        data: "encrypted_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      // 三条 win 记录应累计 totalWin = 3
      expect(result.playerResult.totalWin).toBe(3);
      expect(result.playerResult.streak).toBe(0);
      expect(result.playerResult.totalRound).toBe(10);
    });

    it("应该同时处理得分与胜利计数的混合信息", async () => {
      const manager = new AprilFoolManager(asPlayerManager(mockPlayer), mockTrigger);

      mockDecryptReturn({
        "SIMPLE,money,500": 1,
        "DETAILED,player,1,win": 1,
        "SIMPLE,other,999": 1, // 非 money,应忽略
        "DETAILED,player,2,lose": 1, // 非 win,应忽略
        "DETAILED,enemy,1,win": 1, // 非 player,应忽略
        "DETAILED,player,3,win": 1,
      });

      const result = await manager.act5funBattleFinish({
        data: "encrypted_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      // 只有 SIMPLE,money,500 计入得分
      expect(result.score).toBe(500);
      // 只有 DETAILED,player,*,win 计入胜利: 2 条
      expect(result.playerResult.totalWin).toBe(2);
    });

    it("当 extraBattleInfo 为空时应返回 0 得分与 0 胜利", async () => {
      const manager = new AprilFoolManager(asPlayerManager(mockPlayer), mockTrigger);

      mockDecryptReturn({});

      const result = await manager.act5funBattleFinish({
        data: "encrypted_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      expect(result.score).toBe(0);
      expect(result.playerResult.totalWin).toBe(0);
      expect(result.npcResult).toEqual({});
    });

    it("stats.extraBattleInfo 缺失（异常/旧版战斗数据）时应返回空结果而非 500", async () => {
      const manager = new AprilFoolManager(asPlayerManager(mockPlayer), mockTrigger);
      // 修复前：battleLog.battleData.stats.extraBattleInfo 解引用 undefined → TypeError
      (decryptBattleData as ReturnType<typeof vi.fn>).mockResolvedValue({
        battleId: "battle_001",
        battleData: { isCheat: "0", completeTime: 100 },
      });
      const result = await manager.act5funBattleFinish({
        data: "encrypted_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });
      expect(result.score).toBe(0);
      expect(result.playerResult.totalWin).toBe(0);
    });

    it("应该将玩家 pushFlags.status 作为 loginTime 传给 decryptBattleData", async () => {
      const manager = new AprilFoolManager(asPlayerManager(mockPlayer), mockTrigger);

      mockDecryptReturn({});

      await manager.act5funBattleFinish({
        data: "my_encrypted_data",
        battleData: { isCheat: "0", completeTime: 100 },
      });

      // decryptBattleData 应以 (data, status) 形式被调用
      expect(decryptBattleData).toHaveBeenCalledWith(
        "my_encrypted_data",
        999
      );
    });
  });
});
