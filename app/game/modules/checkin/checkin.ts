import { ItemBundle } from "@excel/excel";
import { checkBetween, now } from "@utils/time";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { Draft } from "mutative";
import { PlayerDataModel } from "../../kernel/playerdata";

export class CheckInManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("refresh:monthly", this.monthlyRefresh.bind(this));
    this._trigger.on("refresh:daily", this.dailyRefresh.bind(this));
  }

  async dailyRefresh() {
    await this._player.update(async (draft) => {
      // 幂等：同日重复触发（周一/月初 daily+weekly 并发）不重复计数
      if (draft.checkIn.canCheckIn === 1) return;
      draft.checkIn.canCheckIn = 1;
      draft.checkIn.checkInRewardIndex += 1;
      // 累计签到天数（长期签到进度）：官服"登录即自动签到"语义，每日 +1
      this._bumpShowCount(draft);
    });
  }

  /**
   * 递增累计签到天数；老档缺失时按注册时长回填（满配号可直接领取长期签到档位）
   * @param draft - 可写草稿
   */
  private _bumpShowCount(draft: Draft<PlayerDataModel>) {
    if (draft.checkIn.showCount == null) {
      draft.checkIn.showCount = Math.max(
        0,
        Math.floor((now() - (draft.status.registerTs ?? now())) / 86400),
      );
    } else {
      draft.checkIn.showCount += 1;
    }
  }

  /**
   * 确保累计签到天数存在（长期签到路由读取前调用）
   */
  async ensureShowCount() {
    await this._player.update(async (draft) => {
      if (draft.checkIn.showCount == null) {
        draft.checkIn.showCount = Math.max(
          0,
          Math.floor((now() - (draft.status.registerTs ?? now())) / 86400),
        );
      }
    });
  }

  async monthlyRefresh() {
    await this._player.update(async (draft) => {
      // 防御：当前时间无匹配签到组（数据缺失/时间跨度断档）时保持原组，不 500
      const group = Object.values(this._player.excel.CheckinTable.groups).find(
        // 防御：数据表末尾字段名伪键（值 null）——t.signStartTime 读 null 崩溃
        (t) => !!t && checkBetween(now(), t.signStartTime, t.signEndTime),
      );
      if (!group) {
        return;
      }
      draft.checkIn.checkInGroupId = group.groupId;
      draft.checkIn.checkInHistory = [];
      draft.checkIn.checkInRewardIndex = -1;
    });
  }

  async checkIn(): Promise<{
    signInRewards: ItemBundle[];
    subscriptionRewards: ItemBundle[];
  }> {
    return (await this._player.update(async (draft) => {
      const signInRewards: ItemBundle[] = [];
      const subscriptionRewards: ItemBundle[] = [];
      if (!draft.checkIn.canCheckIn) {
        return;
      }
      draft.checkIn.canCheckIn = 0;
      if (draft.checkIn.checkInRewardIndex < 0) {
        draft.checkIn.checkInRewardIndex = 0;
      }
      const groupItems =
        this._player.excel.CheckinTable.groups[draft.checkIn.checkInGroupId]?.items ?? [];
      // 修复：奖励索引越界（组内物品数少于连续签到天数）时钳制到末位，不 500
      const idx = Math.min(
        draft.checkIn.checkInRewardIndex,
        groupItems.length - 1,
      );
      const item = groupItems[idx];
      if (!item) {
        return;
      }
      signInRewards.push({
        id: item.itemId,
        count: item.count,
        type: item.itemType,
      });
      const { monthlySubscriptionStartTime, monthlySubscriptionEndTime } =
        draft.status;
      if (
        checkBetween(
          now(),
          monthlySubscriptionStartTime,
          monthlySubscriptionEndTime,
        )
      ) {
        const currentMonthlySubId = this._player.excel.CheckinTable.currentMonthlySubId;
        subscriptionRewards.push(
          ...this._player.excel.CheckinTable.monthlySubItem[currentMonthlySubId][1].items,
        );
      }
      draft.checkIn.checkInHistory.push(0);
      const granted = subscriptionRewards.concat(signInRewards);
      for (const it of granted) this._player.gainItem.add(it);
      await this._player.gainItem.handle();
      // 修复：勋章 TotalCheckinCount 事件从未 emit → 累计签到勋章永不推进
      await this._trigger.emit("TotalCheckinCount", []);
      return { signInRewards, subscriptionRewards };
    }))!;
  }
}
