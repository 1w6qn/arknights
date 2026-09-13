import { describe, it, expect, beforeEach, vi } from "vitest";
import { SocialManager } from "@game/modules/social/SocialManager";
import { accountManager } from "@game/modules/account/AccountManager";
import type { FriendDataWithNameCard } from "@game/kernel/social-model";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import {
  asModel,
  asPlayerManager,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";

describe("SocialManager 双向好友", () => {
  let social: SocialManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    const pd = mockPlayerData({
      status: { uid: "1", nickName: "A" },
      pushFlags: { hasFriendRequest: 1 },
    });
    social = new SocialManager(asPlayerManager(pd), mockTypedEventEmitter());
    vi.spyOn(accountManager, "deleteFriendRequest").mockResolvedValue(undefined);
    vi.spyOn(accountManager, "getFriendRequests").mockResolvedValue([]);
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [],
      friendRequests: [],
      visited: [],
    });
  });

  it("同意申请（action=1）应双向加好友", async () => {
    const addFriend = vi
      .spyOn(accountManager, "addFriend")
      .mockResolvedValue(undefined);
    await social.processFriendRequest({ friendId: "2", action: 1 });
    // 己方加对方 + 对方加己方
    expect(addFriend).toHaveBeenCalledWith("1", "2");
    expect(addFriend).toHaveBeenCalledWith("2", "1");
  });

  it("拒绝申请（action=0）不应加好友", async () => {
    const addFriend = vi
      .spyOn(accountManager, "addFriend")
      .mockResolvedValue(undefined);
    await social.processFriendRequest({ friendId: "2", action: 0 });
    expect(addFriend).not.toHaveBeenCalled();
  });
});

describe("SocialManager 其他方法", () => {
  let social: SocialManager;
  let pd: ReturnType<typeof mockPlayerData>;
  let mockTrigger: ReturnType<typeof mockTypedEventEmitter>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockTrigger = mockTypedEventEmitter();
    pd = mockPlayerData({
      status: { uid: "1", nickName: "A" },
      pushFlags: { hasFriendRequest: 1 },
      social: {
        yesterdayReward: { canReceive: 1, assistAmount: 10, comfortAmount: 5 },
      },
    });
    pd._trigger = mockTrigger;
    social = new SocialManager(asPlayerManager(pd), mockTrigger);
    // 覆写替身默认 update：与 helper 实现等价（JSON 深拷贝 draft → recipe → 回写）
    pd.update.mockImplementation(async (recipe) => {
      const draft = JSON.parse(JSON.stringify(pd._playerdata));
      const result = await recipe(draft);
      Object.assign(pd._playerdata, draft);
      return result;
    });
  });

  it("getSortListInfo GET_FRIEND_REQUEST 应返回申请者信息", async () => {
    vi.spyOn(accountManager, "getFriendRequests").mockResolvedValue(["2"]);
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockResolvedValue(
      asModel<FriendDataWithNameCard>({
        uid: "2",
        nickName: "B",
        nickNumber: "1",
        level: 1,
      }),
    );
    const result = await social.getSortListInfo({
      type: 2,
      sortKeyList: [],
      param: {},
    });
    expect(result).toHaveLength(1);
    expect(result![0].uid).toBe("2");
  });

  it("getSortListInfo SEARCH_FRIEND 应返回搜索结果", async () => {
    vi.spyOn(accountManager, "searchPlayer").mockResolvedValue(["3"]);
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockResolvedValue(
      asModel<FriendDataWithNameCard>({
        uid: "3",
        nickName: "C",
        nickNumber: "1",
        level: 2,
      }),
    );
    const result = await social.getSortListInfo({
      type: 0,
      sortKeyList: [],
      param: { nickName: "C", nickNumber: "1" },
    });
    expect(result).toEqual([{ uid: "3", level: 2 }]);
  });

  it("getSortListInfo GET_FRIEND_LIST 应按 sortKeyList 返回好友", async () => {
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [{ uid: "2", alias: "好友2" }],
      friendRequests: [],
      visited: [],
    });
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockResolvedValue(
      asModel<FriendDataWithNameCard>({
        uid: "2",
        nickName: "B",
        nickNumber: "1",
        level: 1,
      }),
    );
    const result = await social.getSortListInfo({
      type: 1,
      sortKeyList: ["nickName"],
      param: {},
    });
    expect(result).toEqual([{ uid: "2", nickName: "B" }]);
  });

  it("getFriendList 应返回好友信息与别名", async () => {
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockResolvedValue(
      asModel<FriendDataWithNameCard>({
        uid: "2",
        nickName: "B",
        nickNumber: "1",
        level: 1,
      }),
    );
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [{ uid: "2", alias: "阿米娅" }],
      friendRequests: [],
      visited: [],
    });
    const result = await social.getFriendList({ idList: ["2"] });
    expect(result.friends).toHaveLength(1);
    expect(result.friendAlias).toContain("阿米娅");
  });

  it("receiveSocialPoint 应发放昨日信用点、清零金额并关闭领取（幂等）", async () => {
    const emitSpy = vi.spyOn(mockTrigger, "emit");
    const point = await social.receiveSocialPoint();
    expect(point).toBe(15);
    // 信用发放已收敛到 player.gainItem 管道（不再直发 items:get 事件）
    expect(pd.gainItem.add).toHaveBeenCalledWith({
      id: "",
      type: "SOCIAL_PT",
      count: 15,
    });
    expect(pd.gainItem.handle).toHaveBeenCalled();
    // 任务模板按「获得的信用」计量
    expect(emitSpy).toHaveBeenCalledWith("ReceiveSocialPoint", [
      { socialPoint: 15 },
    ]);
    expect(pd._playerdata.social!.yesterdayReward.canReceive).toBe(0);
    // 修复（2026-09-09，审计 §5.4-12）：领取后金额归零重新累积（原实现只关开关 → 金额永久残留）
    expect(pd._playerdata.social!.yesterdayReward.assistAmount).toBe(0);
    expect(pd._playerdata.social!.yesterdayReward.comfortAmount).toBe(0);
    // 幂等：再次领取不发第二次（canReceive 已关）
    pd.gainItem.add.mockClear();
    pd.gainItem.handle.mockClear();
    expect(await social.receiveSocialPoint()).toBe(0);
    expect(pd.gainItem.add).not.toHaveBeenCalled();
    expect(pd.gainItem.handle).not.toHaveBeenCalled();
  });

  it("dailyRefresh 应结算宿舍氛围信用到昨日奖励并开启领取", async () => {
    // 夹具只声明被测分支读到的房间/槽位（asModel 深可选视图，字段类型仍受真实模型约束）
    pd._playerdata.building = asModel<NonNullable<PlayerDataModel["building"]>>({
      rooms: { DORMITORY: { slot_1: { comfort: 5000 }, slot_2: { comfort: 1000 } } },
    });
    pd._playerdata.status!.socialPoint = 10;
    await social.dailyRefresh();
    // 5000→50、1000→18，合计 68；canReceive 置 1（次日可领）
    expect(pd._playerdata.social!.yesterdayReward.comfortAmount).toBe(68);
    expect(pd._playerdata.social!.yesterdayReward.canReceive).toBe(1);
    // 未超上限不动
    expect(pd._playerdata.status!.socialPoint).toBe(10);
  });

  it("dailyRefresh 按 creditLimit(300) 清空超出上限的信用", async () => {
    // PRTS 采购中心：「信用上限为 300…每日凌晨 4:00，计数器会自动将超出上限的部分
    // 清空（即最多保留 300 点信用到下一日）」；本地常量 data/excel/gamedata_const.json
    // → creditLimit = 300
    const limit = 300;
    pd._playerdata.status!.socialPoint = limit + 500;
    await social.dailyRefresh();
    expect(pd._playerdata.status!.socialPoint).toBe(limit);
  });

  it("deleteFriend 应委托 accountManager 删除好友", async () => {
    const del = vi.spyOn(accountManager, "deleteFriend").mockResolvedValue(undefined);
    await social.deleteFriend({ id: "2" });
    expect(del).toHaveBeenCalledWith("1", "2");
  });
});
