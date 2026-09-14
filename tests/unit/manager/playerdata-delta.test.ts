import { describe, it, expect, beforeEach } from "vitest";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import { mockPlayerData, type MockSeed } from "../../helpers";

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

/**
 * 测试专用动态事件通道
 *
 * `test:nested` 不在 EventMap 契约内（该事件仅本用例用于在 recipe 内触发嵌套 update），
 * Emittery 运行期允许任意事件名。此处按发射器的运行期形状就地声明窄接口，避免用
 * `as never` 把事件载荷类型抹成 never；调用与载荷一字未改。
 */
interface NestedEventChannel {
  /** 注册嵌套触发监听 */
  on(eventName: "test:nested", listener: () => void | Promise<void>): void;
  /** 触发嵌套 update（载荷沿用历史空数组） */
  emit(eventName: "test:nested", eventData: []): Promise<void>;
}

/**
 * 条件落盘回归测试
 *
 * delta getter 仅在存在变更时触发 save（Immer 补丁或 markDirty 的直接变更），
 * 纯读请求（syncStatus/syncPushMessage 等）不应触发全量落盘。
 * 注意：TypedEventEmitter（Emittery）的 emit 是异步的，断言前需 flush。
 */
describe("PlayerDataManager 条件落盘", () => {
  let player: PlayerDataManager;
  let saveCount: number;

  const flush = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(async () => {
    const pd = mockPlayerData({
      mission: { missions: {} },
      medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
      rlv2: looseRlv2,
    });
    player = new PlayerDataManager(pd._playerdata);
    await flush();
    saveCount = 0;
    player._trigger.on("save", () => {
      saveCount++;
    });
  });

  /**
   * 消费构造期异步 init（mission.init 等）可能产生的补丁，建立干净基线。
   * 构造期补丁触发的 save 计入 saveCount，断言前重置为 0。
   */
  async function settleBaseline(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      player.delta;
      await flush();
    }
    saveCount = 0;
  }

  it("纯读 delta 不触发 save；update() 后触发", async () => {
    await settleBaseline();

    player.delta;
    await flush();
    expect(saveCount).toBe(0);

    await player.update(async (draft) => {
      draft.status.level = 2;
    });
    player.delta;
    await flush();
    expect(saveCount).toBe(1);

    // 无新变更再读——不重复落盘
    player.delta;
    await flush();
    expect(saveCount).toBe(1);
  });

  it("markDirty 的直接变更触发 save", async () => {
    await settleBaseline();

    player.markDirty();
    player.delta;
    await flush();
    expect(saveCount).toBe(1);

    player.delta;
    await flush();
    expect(saveCount).toBe(1);
  });

  it("recipe 内嵌套 update 不丢变更（事件处理器再调 update 复用同一 draft）", async () => {
    // 前置：status 需含 gold 字段（mockPlayerData 默认不含，NaN 干扰断言）。
    // 经 update() 配方设置，兼容 setAutoFreeze(true)（直接改冻结对象会抛错）。
    await player.update(async (draft) => {
      draft.status.gold = 0;
    });
    await settleBaseline();

    // 模拟 items:get → gainItem → 事件处理器内再调 player.update（原实现内层
    // finishDraft 先提交、外层 finishDraft 再按旧 base 覆盖 → 嵌套变更从存档丢失）
    const nested = player._trigger as NestedEventChannel;
    nested.on("test:nested", async () => {
      await player.update(async (draft) => {
        draft.status.gold += 100;
      });
    });
    await player.update(async (draft) => {
      draft.status.level = 5;
      await nested.emit("test:nested", []);
    });

    expect(player._playerdata.status.gold).toBe(100);
    const delta = player.delta;
    // modified 在协议层声明为 `{ [key: string]: unknown }`；用例按被改写分区的窄视图读取
    const modified = delta.playerDataDelta.modified as {
      status: { gold: number };
    };
    expect(modified.status.gold).toBe(100);
  });

  it("同路径多次 update 时 delta 下发最新值（补丁正序，非反转）", async () => {
    await settleBaseline();
    await player.update(async (draft) => {
      draft.status.nickName = "b";
    });
    await player.update(async (draft) => {
      draft.status.nickName = "c";
    });
    const delta = player.delta;
    const modified = delta.playerDataDelta.modified as {
      status: { nickName: string };
    };
    expect(modified.status.nickName).toBe("c");
  });
});
