import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { ItemBundle } from "@excel/excel";
import type { JsonValue } from "@excel/json-value";
import { asRecord, asShape } from "../activities/shared/activity-json";
import { now } from "@utils/time";

export class RetroManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    // 每周一 04:00 重置 1 次【事相结晶】的领取机会（不可累计）——事件由
    // StatusManager.refreshTime 在跨周时派发（Round 46 起已由请求中间件驱动）
    this._trigger.on("refresh:weekly", this.weeklyRefresh.bind(this));
  }

  /**
   * 每周事相结晶「领取机会」重置
   *
   * 官方规则原文（data/excel/retro_table.json → retroDetail）：「每周一 04:00 重置 1 次
   * 【事相结晶】的领取机会，**不可累计**。」→ 直接置 @@supplement = 1@@（上周未领取也一并
   * 被覆盖，不叠加）。
   */
  async weeklyRefresh(): Promise<void> {
    await this._player.update(async (draft) => {
      draft.retro.supplement = 1;
    });
  }

  /**
   * 登录签到后的【事相结晶】自动补充
   *
   * 官方规则原文（同上）：「未达到储存上限时，在登录签到后将自动领取 2 个【事相结晶】。
   * 博士等级达到 60 级后，自动领取数量增长至 3 个。储存上限…2 个；60 级后增长至 3 个。」
   * 数据映射：@@initRetroCoin = 2@@（60 级以下的领取量与上限）、@@retroCoinPerWeek = 3@@
   * （60 级及以上的领取量）、@@retroCoinMaxOfLevels = { "60": 3 }@@（等级阈值 → 上限）。
   *
   * 修复（2026-09-09，审计 §5.4-8 前半）：此前上述常量与 @@retro.supplement@@ 全仓无人
   * 使用——结晶除初始值外无任何获取途径，且 @@supplement@@ 恒不消耗。
   *
   * 语义：无领取机会（supplement ≠ 1）不发；**已达上限不发且保留机会**（文本「未达到
   * 储存上限时…自动领取」）；发放后置 supplement = 0 并记录 lst。
   *
   * @returns 本次实际发放的结晶数量（0 = 未发放）
   */
  async ensureWeeklySupplement(): Promise<number> {
    const table = this._player.excel.RetroTable;
    const base = Math.max(0, Number(table?.initRetroCoin ?? 2));
    const highGrant = Math.max(0, Number(table?.retroCoinPerWeek ?? base));
    const level = Number(this._player._playerdata.status?.level ?? 0);
    // 逐档取「已达到的最高等级」对应的上限/领取量
    let cap = base;
    let grant = base;
    for (const [lvKey, capValue] of Object.entries(
      table?.retroCoinMaxOfLevels ?? {},
    )) {
      if (level >= Number(lvKey)) {
        cap = Math.max(cap, Number(capValue));
        grant = Math.max(grant, highGrant);
      }
    }
    const retro = this._player._playerdata.retro;
    if (!retro) return 0;
    if (Number(retro.supplement ?? 0) !== 1) return 0; // 本周无领取机会
    const coin = Number(retro.coin ?? 0);
    if (coin >= cap) return 0; // 已达储存上限：不发，且保留本周机会
    const gain = Math.min(grant, cap - coin);
    if (gain <= 0) return 0;
    await this._player.update(async (draft) => {
      draft.retro.coin = Number(draft.retro.coin ?? 0) + gain;
      draft.retro.supplement = 0;
      draft.retro.lst = now();
    });
    return gain;
  }

  /**
   * 解锁回溯插曲（消耗事相结晶）
   *
   * 官方规则原文（data/excel/retro_table.json → retroDetail）：「消耗 {1} 个【事相结晶】，
   * 可解锁 1 个【插曲】」；{1} 取 retroUnlockCost（实测 1）。
   *
   * 修复（2026-09-09，审计 §5.4-8）：原实现无条件 draft.retro.coin -= 1 并置 open ——
   * ① 无余额校验 → 结晶可被扣成**负数**；② 无「已解锁」校验 → 重复请求对同一个已开放
   * 插曲反复扣费；③ 费用写死 1，不读 retroUnlockCost。
   *
   * @param args.retroId - 插曲（retro 区块）id
   * @returns 是否实际完成了解锁（false = 已解锁/未持有该插曲/结晶不足）
   */
  async unlockRetroBlock(args: { retroId: string }): Promise<boolean> {
    const cost = Math.max(
      0,
      Number(this._player.excel.RetroTable.retroUnlockCost ?? 1),
    );
    let unlocked = false;
    await this._player.update(async (draft) => {
      const block = draft.retro.block?.[args.retroId];
      if (!block) return; // 未知插曲：不扣费、不 500
      if (Number(block.open ?? 0) === 1) return; // 已解锁：不重复扣费
      if (cost > 0 && Number(draft.retro.coin ?? 0) < cost) return; // 结晶不足
      if (cost > 0) draft.retro.coin = Number(draft.retro.coin ?? 0) - cost;
      block.locked = 0;
      block.open = 1;
      unlocked = true;
    });
    return unlocked;
  }

  async getRetroTrailReward(args: { retroId: string; rewardId: string }) {
    return await this._player.update(async (draft) => {
      const { retroId, rewardId } = args;
      const trailList = this._player.excel.RetroTable.retroTrailList[retroId]?.trailRewardList;
      const reward = trailList?.find((v) => v.trailRewardId === rewardId)
        ?.rewardItem;
      // 防御：未知 retro/奖励 id 不 500
      if (!reward) return [];
      // 修复：trail 惰性初始化（新 retro/旧存档缺条目时直接写 trail[retroId][rewardId]
      // 会 TypeError 500——模板只预置已知 retro，版本更新新增 retro 后必崩）
      const trail = (draft.retro.trail ??= {});
      if (!trail[retroId]) trail[retroId] = {};
      // 修复：已领取过的不再发放（原实现无幂等 → 可无限刷）
      if (trail[retroId][rewardId]) return [];
      trail[retroId][rewardId] = 1;
      await this._player.gainItem.add(reward).handle();
      return [reward];
    });
  }

  async getRetroPassReward(args: { retroId: string; activityId: string }) {
    const { retroId } = args;
    // 修复：幂等——已领取过的通行证奖励不再发放（原实现无任何记录 → 可无限刷）
    if (this._player._playerdata.retro.rewardPerm?.includes(retroId)) {
      return [];
    }
    const rewards: ItemBundle[] = [];
    const retroActivities = this._player.excel.ActivityTable.activity;
    for (const [, activities] of Object.entries(retroActivities)) {
      // 活动详情为未建模 JSON（ActivityTable.activity 值为 JsonValue）——
      // 按「是否存在通行证奖励」的局部形状收窄（activities/shared 共享辅助）
      for (const [id, activity] of Object.entries(asRecord<JsonValue>(activities))) {
        if (id !== args.activityId) continue;
        const detail = asShape<{
          retroData?: { rewards?: { id?: string; items?: ItemBundle[] }[] };
        }>(activity);
        const retroData = detail?.retroData;
        if (!retroData) continue;
        const passReward = (retroData.rewards ?? []).find((r) => r.id === retroId);
        if (passReward?.items) {
          rewards.push(...passReward.items);
        }
      }
    }
    if (rewards.length === 0) return rewards;
    // rewardPerm 未被业务使用，复用为已领取通行证奖励 id 记录
    await this._player.update(async (draft) => {
      if (!draft.retro.rewardPerm) draft.retro.rewardPerm = [];
      if (!draft.retro.rewardPerm.includes(retroId)) {
        draft.retro.rewardPerm.push(retroId);
      }
    });
    for (const it of rewards) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    return rewards;
  }
}
