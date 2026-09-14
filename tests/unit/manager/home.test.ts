import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  CharacterData,
  ItemData,
  StageData,
} from "@excel/types_excel_gen";

vi.mock("@excel/excel", () => {
  return {
    default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    // 本替身刻意不提供数据表：三张表恒为空，查表得到 undefined（与旧夹具一致）
    ItemTable: undefined as { items?: Record<string, ItemData> } | undefined,
    CharacterTable: undefined as Record<string, CharacterData> | undefined,
    StageTable: undefined as { stages?: Record<string, StageData> } | undefined,
    getItem(id: string): ItemData | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string): CharacterData | undefined { return this.CharacterTable?.[charId]; },
    stageData(stageId: string): StageData | undefined { return this.StageTable?.stages?.[stageId]; },
},
  };
});

vi.mock("@game/kernel/player-data-manager", () => ({
  PlayerDataManager: vi.fn(),
}));

// Mock 时间工具,返回固定时间戳便于断言解锁时间
vi.mock("@utils/time", () => ({
  now: () => 1234567890,
}));



import {
  asPlayerManager,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";
import { HomeManager } from "@game/modules/home/home-manager";

/**
 * HomeManager 单元测试
 * 覆盖背景、主题、低功耗设置、NPC 语音切换及事件触发等
 */
describe("HomeManager", () => {
  let mockPlayer: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();

    mockPlayer = mockPlayerData({
      background: {
        selected: "bg_default",
        bgs: {
          bg_001: {
            unlock: 0,
            conditions: {
              cond_001: { v: 0, t: 10 },
            },
          },
          bg_002: {
            unlock: 0,
          },
        },
      },
      homeTheme: {
        selected: "tm_default",
        themes: {
          tm_001: {
            unlock: 0,
            conditions: {
              cond_001: { v: 0, t: 10 },
            },
          },
          tm_002: {
            unlock: 0,
          },
        },
      },
      setting: {
        perf: {
          lowPower: 0,
        },
      },
      npcAudio: {
        npc_001: {
          npcShowAudioInfoFlag: "CN_MANDARIN",
        },
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
    it("应该正确初始化并注册所有背景/主题事件监听", () => {
      const onSpy = vi.spyOn(mockTrigger, "on");
      const manager = new HomeManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );
      expect(manager).toBeDefined();
      expect(manager._player).toBe(mockPlayer);
      expect(manager._trigger).toBe(mockTrigger);
      // 验证注册了背景与主题相关的事件
      expect(onSpy).toHaveBeenCalledWith(
        "background:condition:update",
        expect.any(Function)
      );
      expect(onSpy).toHaveBeenCalledWith(
        "background:unlock",
        expect.any(Function)
      );
      expect(onSpy).toHaveBeenCalledWith(
        "background:get",
        expect.any(Function)
      );
      expect(onSpy).toHaveBeenCalledWith(
        "homeTheme:condition:update",
        expect.any(Function)
      );
      expect(onSpy).toHaveBeenCalledWith(
        "homeTheme:unlock",
        expect.any(Function)
      );
      expect(onSpy).toHaveBeenCalledWith(
        "homeTheme:get",
        expect.any(Function)
      );
    });
  });

  describe("setBackground", () => {
    it("应该更新选中的背景 ID", async () => {
      const manager = new HomeManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.setBackground({ bgID: "bg_001" });

      expect(mockPlayer._playerdata.background!.selected).toBe("bg_001");
    });
  });

  describe("setHomeTheme", () => {
    it("应该更新选中的主题 ID", async () => {
      const manager = new HomeManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.setHomeTheme({ themeId: "tm_001" });

      expect(mockPlayer._playerdata.homeTheme!.selected).toBe("tm_001");
    });
  });

  describe("setLowPower", () => {
    it("应该更新低功耗模式开关", async () => {
      const manager = new HomeManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.setLowPower({ newValue: 1 });

      expect(mockPlayer._playerdata.setting!.perf.lowPower).toBe(1);
    });
  });

  describe("npcAudioChangeLan", () => {
    it("应该更新 NPC 语音语言", async () => {
      const manager = new HomeManager(
        asPlayerManager(mockPlayer),
        mockTrigger
      );

      await manager.npcAudioChangeLan({
        id: "npc_001",
        voiceLan: "JP",
      });

      expect(
        mockPlayer._playerdata.npcAudio!["npc_001"].npcShowAudioInfoFlag
      ).toBe("JP");
    });
  });

  describe("background:get 事件", () => {
    it("触发 background:get 事件应该解锁指定背景", async () => {
      new HomeManager(asPlayerManager(mockPlayer), mockTrigger);

      // 直接 emit background:get 事件,模拟事件触发
      await mockTrigger.emit("background:get", ["bg_002"]);

      expect(mockPlayer._playerdata.background!.bgs["bg_002"].unlock).toBe(
        1234567890
      );
    });
  });

  describe("background:condition:update 事件", () => {
    it("条件达成时应该更新进度并触发 background:unlock 事件", async () => {
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      new HomeManager(asPlayerManager(mockPlayer), mockTrigger);

      // 设置目标值为 10(达成条件 t=10)
      await mockTrigger.emit("background:condition:update", [
        "bg_001",
        "cond_001",
        10,
      ]);

      // 进度应被更新
      expect(
        mockPlayer._playerdata.background!.bgs["bg_001"].conditions!["cond_001"]
          .v
      ).toBe(10);
      // 应触发 background:unlock 事件
      expect(emitSpy).toHaveBeenCalledWith("background:unlock", [
        { bgID: "bg_001" },
      ]);
    });

    it("条件未达成时应该只更新进度但不触发 unlock 事件", async () => {
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      new HomeManager(asPlayerManager(mockPlayer), mockTrigger);

      // 设置目标值为 5(未达成 t=10)
      await mockTrigger.emit("background:condition:update", [
        "bg_001",
        "cond_001",
        5,
      ]);

      expect(
        mockPlayer._playerdata.background!.bgs["bg_001"].conditions!["cond_001"]
          .v
      ).toBe(5);
      // 不应触发 background:unlock
      const unlockCalls = emitSpy.mock.calls.filter(
        (c) => c[0] === "background:unlock"
      );
      expect(unlockCalls.length).toBe(0);
    });
  });

  describe("homeTheme:condition:update 事件", () => {
    it("主题条件达成时应该触发 homeTheme:unlock 事件", async () => {
      const emitSpy = vi.spyOn(mockTrigger, "emit");
      new HomeManager(asPlayerManager(mockPlayer), mockTrigger);

      await mockTrigger.emit("homeTheme:condition:update", [
        { themeId: "tm_001", conditionId: "cond_001", target: 10 },
      ]);

      expect(
        mockPlayer._playerdata.homeTheme!.themes["tm_001"].conditions![
          "cond_001"
        ].v
      ).toBe(10);
      expect(emitSpy).toHaveBeenCalledWith("homeTheme:unlock", [
        { themeId: "tm_001" },
      ]);
    });
  });
});
