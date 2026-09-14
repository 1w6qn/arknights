/**
 * PlayerDataManager 组合根 DI 测试
 *
 * 验证解耦后的组合策略：
 * - 可在构造时通过 `deps.modules` 覆写单个子模块（缩小构造面），其余模块沿用默认工厂；
 * - 不传 deps 时，构造并组装全部默认子模块（行为与迁移前一致）。
 */
import { describe, it, expect, vi } from "vitest";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
import {
  asChildModules,
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
    ...extra,
  });
  return pd._playerdata;
}

/** 消费构造期异步 init 的补丁，建立干净基线 */
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("PlayerDataManager 组合根 DI", () => {
  it("deps.modules 覆写单个子模块，其余保持默认构造", async () => {
    const fakeMission = {
      init: vi.fn(async () => undefined),
      initPromise: undefined,
    };
    // 注入替身只覆盖构造期被调用的 init/initPromise 面（真实 MissionManager 另含
    // missions/_trigger/_player 等公共成员与私有实现）；适配口径见 helpers/diAdapters。
    const player = new PlayerDataManager(freshModel(), undefined, {
      modules: asChildModules({ mission: fakeMission }),
    });
    await flush();

    // 被覆写的模块是注入的假实现，且构造期确实调用了其 init
    expect(player.mission).toBe(fakeMission);
    expect(fakeMission.init).toHaveBeenCalledTimes(1);
    // 未覆写模块仍由默认工厂构造（真实管理器实例）
    expect(player.status).toBeTruthy();
    expect(player.inventory).toBeTruthy();
    expect(player.battle).toBeTruthy();
    expect(player.bossRush).toBeTruthy();
  });

  it("不传 deps 时构造并组装全部默认子模块", async () => {
    const player = new PlayerDataManager(freshModel());
    await flush();

    expect(player.status).toBeTruthy();
    expect(player.inventory).toBeTruthy();
    expect(player.troop).toBeTruthy();
    expect(player.mission).toBeTruthy();
    expect(player.medal).toBeTruthy();
    expect(player.bossRush).toBeTruthy();
    // 构造后 delta 可正常读取（组合完整）
    expect(player.delta).toHaveProperty("playerDataDelta");
  });
});