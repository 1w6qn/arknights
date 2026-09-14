import { ItemBundle } from "@excel/excel";
import type { PlayerStoryReviewUnlockInfo } from "@excel/types-playerdata";
import { now } from "@utils/time";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../kernel/events/runtime";

export class StoryreviewManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
  }

  /**
   * 由 storyId 推导所属 group key
   * 1) storyId 本身是 group key（部分调用方传组 key）
   * 2) 最长前缀匹配：storyId 以 "groupKey_" 开头 → groupKey（兼容多下划线组名）
   * 3) 兜底参考 DoctoratePy：首段 + "min"→"mini" 特例
   */
  private _groupKeyOf(
    storyId: string,
    groups: Record<string, PlayerStoryReviewUnlockInfo>,
  ): string {
    if (groups[storyId]) return storyId;
    let best = "";
    for (const gk of Object.keys(groups)) {
      if (storyId.startsWith(gk + "_") && gk.length > best.length) {
        best = gk;
      }
    }
    if (best) return best;
    let groupId = storyId.split("_")[0];
    if (groupId.includes("min") && !groupId.includes("mini")) {
      groupId += "i";
    }
    return groupId;
  }

  async unlockStoryByCoin(args: { storyId: string }) {
    await this._player.update(async (draft) => {
      const { storyId } = args;
      // 修复：group key 为 storyId 首段，而非完整 storyId（原实现 groups[storyId] undefined → 500）
      const group = draft.storyreview.groups[this._groupKeyOf(storyId, draft.storyreview.groups)];
      if (!group) return; // 防御：未知 group 跳过
      if (group.stories.some((s) => s.id === storyId)) return; // 已解锁
      group.stories.push({ id: storyId, uts: now(), rc: 0 });
      await this._player.gainItem
        .add(this._player.excel.makeItem("STORY_REVIEW_COIN", 1))
        .use();
    });
  }

  async readStory(args: { storyId: string }) {
    await this._player.update(async (draft) => {
      const { storyId } = args;
      // 修复：group key 为 storyId 首段（原实现 groups[storyId] undefined → 500）
      const group = draft.storyreview.groups[this._groupKeyOf(storyId, draft.storyreview.groups)];
      const story = group?.stories.find((s) => s.id == storyId);
      if (story) story.rc += 1;
    });
  }

  async rewardGroup(args: { groupId: string }) {
    return await this._player.update(async (draft) => {
      const { groupId } = args;
      const group = draft.storyreview.groups[groupId];
      if (!group) return []; // 防御：未知 group 跳过
      // 修复：已领取过（rts 已设）不再发放——原实现只写 rts 从不读 → 无限刷
      if (group.rts) return [];
      group.rts = now();
      const items = this._player.excel.StoryReviewTable[groupId]?.rewards ?? [];
      if (items.length > 0) {
        for (const it of items) this._player.gainItem.add(it);
        await this._player.gainItem.handle();
      }
      return items;
    });
  }

  async markStoryAcceKnown() {
    await this._player.update(async (draft) => {
      draft.storyreview.tags.knownStoryAcceleration = 1;
    });
  }

  async trailReward(args: {
    groupId: string;
    rewardIdList: string[];
  }): Promise<ItemBundle[]> {
    return await this._player.update(async (draft) => {
      const { groupId, rewardIdList } = args;
      const group =
        this._player.excel.StoryReviewMetaTable.miniActTrialData.miniActTrialDataMap[
          groupId
        ];
      const groupData = draft.storyreview.groups[groupId];
      // 防御：未知 group 不 500
      if (!group?.rewardList || !groupData) return [];
      // 修复：已领取过的试炼奖励不再发放（原实现重复调用可无限刷）
      const claimed = new Set(groupData.trailRewards ?? []);
      const rewardList = group.rewardList.filter(
        (reward) =>
          rewardIdList.includes(reward.trialRewardId) &&
          !claimed.has(reward.trialRewardId),
      );
      const items = rewardList.map((reward) => reward.item);
      if (items.length > 0) {
        for (const it of items) this._player.gainItem.add(it);
        await this._player.gainItem.handle();
        if (!groupData.trailRewards) groupData.trailRewards = [];
        groupData.trailRewards.push(...rewardList.map((r) => r.trialRewardId));
      }
      return items;
    });
  }
}
