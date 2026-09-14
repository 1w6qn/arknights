/**
 * 物品管道请求边界回收（GainItemPipeline 队列泄漏防护）
 *
 * 背景：管道 `_targets` 是实例态，而 PlayerDataManager 经 AccountManager 缓存
 * **跨请求存活**——调用方若在 handle()/use() 之前抛错，残留目标会被下一个请求
 * 一并发放。本测试锁定两处回收点：
 *  1. `PlayerDataManager.delta` 收尾（每请求必经出口，res.send(player.delta)）；
 *  2. `resetGainItem()`（供 gameErrorHandler 的异常路径调用）。
 *
 * 同时锁定「回收不触发懒建」——否则从未使用物品管道的请求会凭空创建实例。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
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

describe("物品管道请求边界回收", () => {
  let player: PlayerDataManager;

  /** 消费构造期异步 init（mission.init 等）可能产生的补丁 */
  const flush = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(async () => {
    const pd = mockPlayerData({
      mission: { missions: {} },
      medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
      rlv2: looseRlv2,
    });
    player = new PlayerDataManager(pd._playerdata);
    await flush();
  });

  it("未使用管道时 resetGainItem 不触发懒建", () => {
    // `_gainItemPipeline` 是私有字段：中括号访问是类型层唯一合法读法（运行期零差异）
    expect(player["_gainItemPipeline"]).toBeNull();
    player.resetGainItem();
    // 仍为 null：回收刻意不走 gainItem getter，避免凭空创建实例
    expect(player["_gainItemPipeline"]).toBeNull();
  });

  it("resetGainItem 清空已入队但未执行的目标", () => {
    player.gainItem.add({ id: "4002", type: "DIAMOND", count: 1 });
    expect(player.gainItem.size).toBe(1);
    player.resetGainItem();
    expect(player.gainItem.size).toBe(0);
  });

  it("delta 收尾回收：残留目标不会被下一个请求发放", async () => {
    const getSpy = vi.fn();
    player._trigger.on("items:get", getSpy);
    // 请求 1：入队后未执行（模拟 handle() 之前抛错）
    player.gainItem.add({ id: "4002", type: "DIAMOND", count: 1 });
    player.delta; // 请求 1 的响应出口
    expect(player.gainItem.size).toBe(0);
    // 请求 2：正常执行，队列已空 → no-op，不应把请求 1 的残留补发出去
    await player.gainItem.handle();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("异常路径：errorHandler 式回收后队列为空", () => {
    player.gainItem.add({ id: "4002", type: "DIAMOND", count: 1 });
    player.resetGainItem(); // 对应 gameErrorHandler 的调用
    expect(player.gainItem.size).toBe(0);
  });
});
