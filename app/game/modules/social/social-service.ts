/**
 * 社交服务（B-1 拆分）
 *
 * 好友/申请/访问操作（social.db 为唯一事实源）。
 * 依赖 AccountManager 门面（friendRepo/trigger/data/playerData）。
 * 由 AccountManager 持有并委托——公共方法签名保留在门面上，调用点零改动。
 */
import type { FriendRepository } from "@core/db/friend-repo";
import type { PlayerDataManager } from "../../kernel/player-data-manager";
import type { TypedEventEmitter } from "../../kernel/events/runtime";

/**
 * AccountManager ??? SocialService ????????????
 * ???????? account ??????????social ??? core/kernel ?????
 * ???? social ? account ???? import???? docs/architecture-coupling-adjudication.md??
 */
interface SocialAccountAccess {
  _friendRepo: FriendRepository;
  _trigger: TypedEventEmitter;
  data: { [key: string]: PlayerDataManager };
  getPlayerData(uid: string): Promise<PlayerDataManager>;
}
import { BadRequestError } from "@core/http/errors";
import excel from "@excel/excel";
import { now } from "@utils/time";

export class SocialService {
  constructor(private _manager: SocialAccountAccess) {}

  /** 获取社交信息（好友列表、好友请求、访问记录） */
  async getSocial(uid: string): Promise<{
    friends: { uid: string; alias: string }[];
    friendRequests: string[];
    visited: string[];
  }> {
    return {
      friends: await this._manager._friendRepo.getFriendList(uid),
      friendRequests: await this._manager._friendRepo.getFriendRequests(uid),
      visited: await this._manager._friendRepo.getVisited(uid),
    };
  }

  /**
   * 设置星标好友列表（覆盖式）
   *
   * 修复（2026-09-09，审计 §5.4-10）：原实现为**空桩**（路由直接返回 result 0 + 空
   * newIdList，无任何存储）→ 星标好友功能完全不可用。现按官方语义实现：
   * ① 仅接受**已是好友**的 id（无效 id 静默剔除，不报错）；② 去重并按数量上限
   * @@gamedata_const.maxStarFriendNum@@（实测 5）截断；③ 覆盖式落库并返回最终列表，
   * 客户端以 newIdList 渲染（超出上限的部分被丢弃）。
   *
   * @param uid - 账号 uid
   * @param idList - 客户端提交的星标好友 id 列表（顺序即优先级）
   * @returns 实际生效的星标好友列表
   */
  async setStarFriendList(uid: string, idList: string[]): Promise<string[]> {
    const cap = Math.max(0, Number(excel.GameDataConst?.maxStarFriendNum ?? 5));
    const friends = new Set(
      (await this._manager._friendRepo.getFriendList(uid)).map((f) => f.uid),
    );
    const applied: string[] = [];
    const seen = new Set<string>();
    for (const id of idList ?? []) {
      if (typeof id !== "string" || !id) continue;
      if (!friends.has(id)) continue; // 非好友：剔除
      if (seen.has(id)) continue; // 去重
      if (applied.length >= cap) break; // 上限截断
      seen.add(id);
      applied.push(id);
    }
    await this._manager._friendRepo.setStarList(uid, applied);
    await this._manager._trigger.emit("save", []);
    return applied;
  }

  /**
   * 获取星标好友列表（供好友排序/列表响应携带 starFriendList）
   * @param uid - 账号 uid
   */
  async getStarFriendList(uid: string): Promise<string[]> {
    return await this._manager._friendRepo.getStarList(uid);
  }

  /** 删除好友（双向删除） */
  async deleteFriend(uid: string, friendUid: string): Promise<void> {
    await this._manager._friendRepo.deleteFriend(uid, friendUid);
    await this._manager._friendRepo.deleteFriend(friendUid, uid);
    await this._manager._trigger.emit("save", []);
  }

  /** 添加好友（单向；双向关系由调用方决定） */
  async addFriend(uid: string, friendUid: string): Promise<void> {
    await this._manager._friendRepo.addFriend(uid, friendUid);
    await this._manager._trigger.emit("save", []);
  }

  /**
   * 发送好友请求（校验：不能给自己发、已是好友拒绝、重复申请拒绝、**冷却期**拒绝）
   *
   * 修复（2026-09-09，审计 §5.4-10）：新增 requestSameFriendCd 冷却——官方常量
   * @@gamedata_const.requestSameFriendCd@@（实测 14400s = 4 小时）限制「对同一好友
   * 重复申请」，原实现只挡了「存在未处理申请」的情形：申请被拒/撤回后即可立刻再发，
   * 可无限骚扰。冷却基准存 friend_request_log（与 friend_requests 行解耦，被处理
   * 或撤回后仍保留）。
   */
  async sendFriendRequest(from: string, to: string): Promise<void> {
    if (from === to) {
      throw new BadRequestError("不能向自己发送好友请求");
    }
    if (await this._manager._friendRepo.hasFriend(from, to)) {
      throw new BadRequestError("对方已是你的好友");
    }
    if (await this._manager._friendRepo.hasFriendRequest(to, from)) {
      throw new BadRequestError("好友请求已发送，请勿重复发送");
    }
    const cd = Number(excel.GameDataConst?.requestSameFriendCd ?? 14400);
    const lastTs = await this._manager._friendRepo.getLastRequestTs(from, to);
    if (cd > 0 && lastTs > 0 && now() - lastTs < cd) {
      const leftMin = Math.ceil((cd - (now() - lastTs)) / 60);
      throw new BadRequestError(
        `申请过于频繁，请 ${leftMin} 分钟后再试（冷却 ${cd}s）`,
      );
    }
    await this._manager._friendRepo.sendFriendRequest(from, to);
    await this._manager._friendRepo.touchRequestLog(from, to);
    const friendData = await this._manager.getPlayerData(to);
    await friendData.update(async (draft) => {
      draft.pushFlags.hasFriendRequest = 1;
    });
    await this._manager._trigger.emit("save", []);
  }

  /** 删除好友请求 */
  async deleteFriendRequest(uid: string, friendId: string): Promise<void> {
    await this._manager._friendRepo.deleteFriendRequest(uid, friendId);
    await this._manager._trigger.emit("save", []);
  }

  /** 设置好友别名 */
  async setFriendAlias(
    uid: string,
    friendId: string,
    alias: string,
  ): Promise<void> {
    await this._manager._friendRepo.setFriendAlias(uid, friendId, alias);
    await this._manager._trigger.emit("save", []);
  }

  /** 获取好友请求列表 */
  async getFriendRequests(uid: string): Promise<string[]> {
    return await this._manager._friendRepo.getFriendRequests(uid);
  }

  /** 搜索玩家（uid/昵称/昵称#数字） */
  async searchPlayer(keyword: string): Promise<string[]> {
    return Object.entries(this._manager.data)
      .filter(([uid, data]) => {
        return (
          // 修复：原 `keyword.includes(uid)` 方向反了——昵称里含某 uid 数字就误匹配，
          // 搜索结果混入无关账号；改为按 uid 部分匹配
          uid.includes(keyword) ||
          data._playerdata.status.nickName == keyword ||
          data._playerdata.status.nickName + "#" + data._playerdata.status.nickNumber ==
            keyword
        );
      })
      .map(([uid]) => uid);
  }
}
