/**
 * PlayerDataManager excel 数据端口注入测试
 *
 * 验证 DI 解耦成果（见 app/game/kernel/excel-port.ts）：
 *  - 缺省时端口绑定 `@excel/excel` 单例（行为与迁移前一致）；
 *  - `deps.excel` 可覆写端口，子模块经 `player.excel` 取到替身数据
 *    （以 DungeonManager 读 StageTable 为端到端证据）。
 */
import { describe, it, expect } from "vitest";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
import {
  asExcelPort,
  mockExcel,
  mockExcelWith,
  mockPlayerData,
  type MockSeed,
} from "../../helpers";

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

/** 构造真实 PlayerDataManager 所需的模型（复用 mock helper 的原始数据） */
function freshModel(extra: Record<string, unknown> = {}): PlayerDataModel {
  const pd = mockPlayerData({
    mission: { missions: {} },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    rlv2: looseRlv2,
    dungeon: { stages: {}, cowLevel: {}, hideStages: {}, mainlineBannedStages: [] },
    ...extra,
  });
  return pd._playerdata;
}

describe("PlayerDataManager excel 数据端口", () => {
  it("缺省绑定 @excel/excel 单例（端口可直接当单例用）", () => {
    const player = new PlayerDataManager(freshModel());
    expect(typeof player.excel.makeItem).toBe("function");
    expect(typeof player.excel.charData).toBe("function");
    expect(typeof player.excel.stageData).toBe("function");
  });

  it("deps.excel 覆写端口，子模块经 player.excel 读到注入的表", async () => {
    // 与历史夹具等价：以空表底座 + 只提供 StageTable.stages 的窄视图（其余表读不到数据）
    const fake = mockExcelWith({
      StageTable: {
        stages: { main_01: { stageId: "main_01" } },
        runeStageGroups: {},
      },
    });

    const player = new PlayerDataManager(freshModel(), undefined, {
      excel: asExcelPort(fake),
    });
    expect(player.excel).toBe(fake);

    // 端到端证据：DungeonManager 通过组合根注入的端口读取 StageTable
    await player.dungeon.initStages();
    expect(Object.keys(player._playerdata.dungeon.stages)).toContain("main_01");
  });

  it("未注入端口的子模块仍走默认单例（与注入并存）", async () => {
    const player = new PlayerDataManager(freshModel(), undefined, {
      excel: asExcelPort(mockExcel()),
    });
    expect(player.excel.stageData("not_exists")).toBeUndefined();
    expect(player.inventory).toBeTruthy();
    expect(player.status).toBeTruthy();
  });
});
