import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AccountManager } from "@game/modules/account/account-manager";
import type { UserConfig } from "@game/modules/account/account-manager";
import { closeDatabase, openDatabase } from "@core/db/database";
import { FriendRepository } from "@core/db/friend-repo";
import { asModel, asPlayerManager, mockPlayerData } from "../../helpers";

describe("AccountManager 社交方法（SQLite 后端）", () => {
  let manager: AccountManager;

  /**
   * 构造「update 不执行 recipe」的玩家替身
   *
   * 原夹具给 `data[uid]` 挂的是 `update: vi.fn().mockResolvedValue(undefined)`——
   * 接收方红点写入（`draft.pushFlags.hasFriendRequest = 1`）不真正执行。mockPlayerData
   * 的默认 update 会执行 recipe，而本夹具 `_playerdata` 没有 pushFlags 子树会抛错，
   * 故此处保留原语义（空实现，只在类型层换成真实 PlayerDataManager 视图）。
   * @param uid - 账号 uid
   * @returns 该账号的玩家数据管理器替身
   */
  const stubPlayer = (uid: string) => {
    const pd = mockPlayerData({ status: { uid } });
    pd.update.mockImplementation(async () => {});
    return asPlayerManager(pd);
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    // 用内存库构造 manager
    const db = await openDatabase(":memory:");
    manager = new AccountManager();
    manager._friendRepo = new FriendRepository(db);
    // 社交数据以 _friendRepo（social.db）为唯一事实源——夹具不再挂已废弃的 configs.social 键
    manager.configs = {
      "1": asModel<UserConfig>({ uid: "1" }),
      "2": asModel<UserConfig>({ uid: "2" }),
    };
    // sendFriendRequest 会更新接收方 pushFlags
    manager.data = {
      "1": stubPlayer("1"),
      "2": stubPlayer("2"),
    };
    vi.spyOn(manager._trigger, "emit").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it("addFriend + getSocial 应返回好友列表", async () => {
    await manager.addFriend("1", "2");
    const social = await manager.getSocial("1");
    expect(social.friends).toEqual([{ uid: "2", alias: "" }]);
  });

  it("sendFriendRequest + getFriendRequests 应返回申请者", async () => {
    await manager.sendFriendRequest("2", "1");
    expect(await manager.getFriendRequests("1")).toEqual(["2"]);
  });

  it("deleteFriendRequest 应删除申请", async () => {
    await manager.sendFriendRequest("2", "1");
    await manager.deleteFriendRequest("1", "2");
    expect(await manager.getFriendRequests("1")).toEqual([]);
  });

  it("setFriendAlias 应更新备注", async () => {
    await manager.addFriend("1", "2");
    await manager.setFriendAlias("1", "2", "新备注");
    const social = await manager.getSocial("1");
    expect(social.friends[0].alias).toBe("新备注");
  });

  it("sendFriendRequest 给自己应抛错", async () => {
    await expect(manager.sendFriendRequest("1", "1")).rejects.toThrow(/自己/);
  });

  it("sendFriendRequest 已是好友应抛错", async () => {
    await manager.addFriend("1", "2");
    await expect(manager.sendFriendRequest("1", "2")).rejects.toThrow(/已是你的好友/);
  });

  it("sendFriendRequest 重复申请应抛错", async () => {
    await manager.sendFriendRequest("1", "2");
    await expect(manager.sendFriendRequest("1", "2")).rejects.toThrow(/重复/);
  });

  it("deleteFriend 应双向删除", async () => {
    await manager.addFriend("1", "2");
    await manager.addFriend("2", "1");
    await manager.deleteFriend("1", "2");
    expect((await manager.getSocial("1")).friends).toEqual([]);
    expect((await manager.getSocial("2")).friends).toEqual([]);
  });

  // Round 48（审计 §5.4-10）：星标好友（原为空桩）与申请冷却（原缺失）
  it("setStarFriendList：仅好友、去重、按 maxStarFriendNum 截断（默认 5）", async () => {
    for (const fid of ["2", "3", "4", "5", "6", "7"]) {
      await manager.addFriend("1", fid);
    }
    const applied = await manager.setStarFriendList("1", [
      "2",
      "3",
      "2", // 重复
      "99", // 非好友 → 剔除
      "4",
      "5",
      "6",
      "7", // 超出上限（第 6 个）→ 截断
    ]);
    expect(applied).toEqual(["2", "3", "4", "5", "6"]);
    expect(await manager.getStarFriendList("1")).toEqual(["2", "3", "4", "5", "6"]);
  });

  it("setStarFriendList 覆盖式：再次提交只保留新列表", async () => {
    await manager.addFriend("1", "2");
    await manager.addFriend("1", "3");
    await manager.setStarFriendList("1", ["2", "3"]);
    await manager.setStarFriendList("1", ["3"]);
    expect(await manager.getStarFriendList("1")).toEqual(["3"]);
  });

  it("sendFriendRequest：同一好友在 requestSameFriendCd 冷却期内重复申请应抛错", async () => {
    await manager.sendFriendRequest("2", "1");
    // 申请被处理/撤回（行已删除，但冷却记录保留）
    await manager.deleteFriendRequest("1", "2");
    await expect(manager.sendFriendRequest("2", "1")).rejects.toThrow(/申请过于频繁/);
  });
});
