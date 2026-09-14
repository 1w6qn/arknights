import { PlayerFriendAssist, PlayerSocial, PlayerSocialReward } from "../../kernel/playerdata";
import type { PlayerDataModel } from "../../kernel/playerdata";
import type { AvatarInfo, SharedCharData } from "../../kernel/model";
import type { Draft } from "mutative";
import { settleDormComfortCredit } from "../building/public";
import { accountManager } from "../account/public";
import type { FriendDataWithNameCard } from "../../kernel/social-model";
import { pickKeys, pickLoose } from "@utils/object";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { NameCardMedalType, PlayerNameCardMisc } from "../../kernel/playerdata";
import { domainLog } from "@utils/logger";

enum FriendServiceType {
  SEARCH_FRIEND = 0,
  GET_FRIEND_LIST = 1,
  GET_FRIEND_REQUEST = 2,
}

/**
 * 编队助战列表条目（quest/getAssistList 响应 list 项）
 *
 * 好友信息（FriendDataWithNameCard）+ 选中助战干员槽位 + 私服补的 powerScore；
 * aliasName 非好友时为 null（协议允许）。
 */
interface AssistListEntry {
  aliasName: string | null;
  assistCharList: SharedCharData[];
  assistSlotIndex: number;
  avatar: AvatarInfo;
  canRequestFriend: boolean;
  isFriend: boolean;
  lastOnlineTime: number;
  level: number;
  nickName: string;
  nickNumber: string;
  powerScore: number;
  uid: string;
}

export class SocialManager {
  private readonly socialLog = domainLog("SocialManager");
  _player: PlayerDataManager;
  _uid: string;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._uid = player._playerdata.status.uid;
    this._trigger = _trigger;
    // 每日 04:00 结算「每日结算的信用」（PRTS 信用页）：宿舍氛围信用 + 领取开关开启。
    // 修复（2026-09-09，审计 §5.4-12）：此前 yesterdayReward 全字段无任何写入方 →
    // 信用交易所「昨日奖励」永不出现、social/receiveSocialPoint 恒为空操作。
    this._trigger.on("refresh:daily", this.dailyRefresh.bind(this));
  }

  /**
   * 每日结算的信用（PRTS「信用」页「每日结算的信用」段）
   *
   * - 宿舍氛围信用：Cd = 10 + ⌊Ad/125⌋，每间 ≤50、全天 ≤200 → `comfortAmount`
   * - 支援单位信用（使用 30/日上限 1 次、被使用 20/日）由 battle 结算时累积 → `assistAmount`
   * - 结算结果**次日**于信用交易所手动领取（`canReceive = 1` → `receiveSocialPoint`）
   * - 同时执行信用持有上限清理：`gamedata_const.creditLimit`（实测 300），
   *   「每日凌晨 4:00，计数器会自动将超出上限的部分清空」（PRTS 采购中心）
   *
   * 官服存档实测：`yesterdayReward = {canReceive: 0, assistAmount: 50, comfortAmount: 200,
   * first: 0}`（50 = 使用支援 30 + 被使用 20；200 = 4 间满氛围宿舍 × 50）。
   */
  async dailyRefresh(): Promise<void> {
    await this._player.update(async (draft) => {
      const reward = this._rewardBucket(draft);
      reward.comfortAmount = settleDormComfortCredit(draft);
      reward.canReceive = 1;
      // 数据缺失时兜底官方实测值（data/excel/gamedata_const.json → creditLimit = 300）
      const limit = this._player.excel.GameDataConst?.creditLimit ?? 300;
      const point = draft.status.socialPoint ?? 0;
      if (point > limit) draft.status.socialPoint = limit;
    });
  }

  /**
   * 取（缺省则初始化）昨日奖励容器 `social.yesterdayReward`
   *
   * 官服存档必有该字段；新号/迁移档缺失时按 CS 形状补零值，避免读 undefined 崩溃。
   */
  private _rewardBucket(draft: Draft<PlayerDataModel>): PlayerSocialReward {
    // social 为客户端/服务端共有的必需子树，全新存档可能整体缺失 → 防御性建键
    // （生成类型各字段必填，运行时只建最小子树，故此处放宽）
    draft.social ??= {} as PlayerSocial;
    draft.social.yesterdayReward ??= {
      canReceive: 0,
      first: 0,
      assistAmount: 0,
      comfortAmount: 0,
    };
    return draft.social.yesterdayReward;
  }

  /**
   * 星标好友列表（供 getSortListInfo 响应携带 starFriendList）
   *
   * 修复（2026-09-09，审计 §5.4-10）：CS GetSortListInfoResponse 含 starFriendList，
   * 原实现省略 → 客户端好友列表无法渲染星标。
   */
  async getStarFriendList(): Promise<string[]> {
    return await accountManager.getStarFriendList(this._uid);
  }

  async getSortListInfo(args: {
    type: FriendServiceType;
    sortKeyList: string[];
    param: { [key: string]: string };
  }) {
    const { type, sortKeyList, param } = args;

    if (type === FriendServiceType.GET_FRIEND_REQUEST) {
      const friendIdList = await accountManager.getFriendRequests(this._uid);
      return await Promise.all(
        friendIdList.map((friend) =>
          accountManager.getPlayerFriendInfo(friend),
        ),
      );
    } else if (type === FriendServiceType.SEARCH_FRIEND) {
      const playerList = await accountManager.searchPlayer(
        param.nickName + "#" + param.nickNumber,
      );
      const infoList = await Promise.all(
        playerList.map((friend) => accountManager.getPlayerFriendInfo(friend)),
      );
      return infoList.map((friend) => pickKeys(friend, ["uid", "level"]));
    } else if (type === FriendServiceType.GET_FRIEND_LIST) {
      const social = await accountManager.getSocial(this._uid);
      const friendIdList = social.friends.map((friend) => friend.uid);
      const friendInfoList = await Promise.all(
        friendIdList.map((friend) =>
          accountManager.getPlayerFriendInfo(friend),
        ),
      );
      return friendInfoList.map((friend) =>
        pickLoose(friend, ["uid", ...sortKeyList]),
      );
    }
  }

  async getFriendList(args: { idList?: string[] }) {
    const idList = args?.idList ?? [];
    const friends = await Promise.all(
      idList.map((friend) => accountManager.getPlayerFriendInfo(friend)),
    );
    const friendAlias = (await accountManager.getSocial(this._uid)).friends.map(
      (friend) => friend.alias,
    );
    return {
      friends,
      friendAlias,
      resultIdList: idList,
    };
  }

  async deleteFriend(args: { id: string }) {
    await accountManager.deleteFriend(this._uid, args.id);
  }

  /**
   * 设置星标好友（覆盖式）——委托 accountManager（社交数据以 social.db 为唯一事实源）
   *
   * 修复（2026-09-09，审计 §5.4-10）：原路由为空桩，无任何存储。
   * @param args.idList - 客户端提交的星标好友 id 列表
   * @returns 实际生效的星标好友列表（仅好友、去重、上限 maxStarFriendNum）
   */
  async setStarFriendList(args: { idList?: string[] }): Promise<string[]> {
    return await accountManager.setStarFriendList(this._uid, args?.idList ?? []);
  }

  async sendFriendRequest(args: {
    friendId: string;
    afterBattle: number;
    originType: number;
    battleOrigin: string | null;
  }) {
    await accountManager.sendFriendRequest(this._uid, args.friendId);
  }

  async processFriendRequest(args: { friendId: string; action: number }) {
    await accountManager.deleteFriendRequest(this._uid, args.friendId);
    if (args.action === 1) {
      // 双向好友：己方加对方 + 对方加己方
      await accountManager.addFriend(this._uid, args.friendId);
      await accountManager.addFriend(args.friendId, this._uid);
      await accountManager.deleteFriendRequest(args.friendId, this._uid);
    }
    // 修复：红点应在我自己收件箱清空后消失——原实现查对方（args.friendId）的收件箱，
    // 对方有其他待处理申请时我方红点永不消、我方清空后也仍亮
    if ((await accountManager.getFriendRequests(this._uid)).length === 0) {
      await this._player.update(async (draft) => {
        draft.pushFlags.hasFriendRequest = 0;
      });
    }
    return {
      friendNum: (await accountManager.getSocial(this._uid)).friends.length,
    };
  }

  /**
   * 领取「昨日奖励」（信用交易所，PRTS：每日结算的信用「次日…需要手动领取」）
   *
   * 修复（2026-09-09，审计 §5.4-12）：
   * 1. 原实现把 `items:get` 写在 `player.update` 配方内（嵌套 update）——本次改为两阶段：
   *    先在同一配方内把待领额清零（幂等，重复请求不会重复发放），再在配方外发放；
   * 2. 领取后金额归零，重新开始累积当日信用（原实现只清 canReceive，金额永久残留）；
   * 3. 发放同时 emit `ReceiveSocialPoint`（任务模板按「获得的信用」计量，原实现只有
   *    助战分支 emit 且是立即入账口径）。
   * @returns 实际发放的信用点数（未到领取时间返回 0）
   */
  async receiveSocialPoint(): Promise<number> {
    let point = 0;
    await this._player.update(async (draft) => {
      const reward = this._rewardBucket(draft);
      if (!reward.canReceive) return;
      point = (reward.assistAmount ?? 0) + (reward.comfortAmount ?? 0);
      reward.assistAmount = 0;
      reward.comfortAmount = 0;
      reward.canReceive = 0;
    });
    if (point > 0) {
      await this._player.gainItem
        .add({ id: "", type: "SOCIAL_PT", count: point })
        .handle();
      await this._trigger.emit("ReceiveSocialPoint", [{ socialPoint: point }]);
    }
    return point;
  }

  async setCardShowMedal(args: {
    type: string;
    customIndex: string;
    templateGroup: string;
  }) {
    const { type, customIndex, templateGroup } = args;
    await this._player.update(async (draft) => {
      const medalBoard = draft.social.medalBoard;
      medalBoard.type = type as NameCardMedalType;
      if (type === "CUSTOM") {
        medalBoard.custom = customIndex;
        medalBoard.template = "";
        medalBoard.templateMedalList = [];
      } else if (type === "TEMPLATE") {
        medalBoard.custom = null;
        medalBoard.template = templateGroup;
        let medalGroupId;
        if (templateGroup.includes("Activity")) {
          medalGroupId = "activityMedal";
        } else if (templateGroup.includes("Rogue")) {
          medalGroupId = "rogueMedal";
        } else {
          medalGroupId = "";
        }
        const medalIdList = this._player.excel.MedalTable.medalTypeData[
          medalGroupId
        ].groupData.find((item) => item.groupId === templateGroup)!.medalId;
        // 修复：`medal.medalId in medalIdList` 在数组上测的是下标（恒 false）→
        // 进阶勋章永不加入模板；改为 includes 语义判断
        medalIdList.push(
          ...this._player.excel.MedalTable.medalList
            .filter(
              (medal) => medalIdList.includes(medal.medalId) && medal.advancedMedal,
            )
            .map((medal) => medal.advancedMedal!),
        );

        medalBoard.templateMedalList = medalIdList.filter(
          (medal) => medal in draft.medal.medals,
        );
      } else {
        medalBoard.custom = null;
        medalBoard.template = "";
        medalBoard.templateMedalList = [];
      }
    });
  }

  async getOtherPlayerNameCard(args: { uid: string }) {
    const { uid } = args;
    return await accountManager.getPlayerFriendInfo(uid);
  }
  async changeNameCardComponent(args: { component: string[] }){
    const { component } = args;
    await this._player.update(async (draft) => {
      draft.nameCardStyle.componentOrder = component;
    });
  }
  async changeNameCardSkin(args: { skinId: string }){
    const { skinId } = args;
    await this._player.update(async (draft) => {
      draft.nameCardStyle.skin.selected = skinId;
    });
  }
  async editNameCard(args: {
    flag: number;
    content: { skinId?: string; component?: string[]; misc?: PlayerNameCardMisc };
  }) {
    const { flag, content } = args;
    await this._player.update(async (draft) => {
      switch (flag) {
        case 1:
          draft.nameCardStyle.componentOrder = content.component!;
          break;
        case 2:
          draft.nameCardStyle.skin.selected = content.skinId!;
          break;
        case 4:
          draft.nameCardStyle.misc = content.misc!;
          break;
        default:
          break;
      }
    });
  }
  async setAssistCharList(args: { assistCharList: PlayerFriendAssist[] }) {
    const { assistCharList } = args;
    await this._player.update(async (draft) => {
      draft.social.assistCharList = assistCharList;
    });
    // 修复：SetAssistCharList 任务事件从未 emit → 设置助战类任务永不推进
    await this._trigger.emit("SetAssistCharList", []);
  }

  /**
   * 获取编队助战列表（按职业筛选好友助战干员）
   * 好友随机排序，最多取 6 个，干员按 charId 去重；
   * 好友数据不足时从其他账号随机补位（非好友、可请求）
   */
  async getAssistList(args: { profession: string }) {
    const { profession } = args;
    const social = await accountManager.getSocial(this._uid);
    const friendUids = new Set(social.friends.map((f) => f.uid));
    const assistList: AssistListEntry[] = [];
    const usedCharIds = new Set<string>();
    const MAX_LIST = 6;

    const buildAssistInfo = (
      info: FriendDataWithNameCard,
      isFriend: boolean,
      alias: string,
    ): AssistListEntry | null => {
      const assistChars = info.assistCharList;
      const matched = assistChars.find((c) => {
        const data = this._player.excel.charData(c?.charId);
        return data?.profession === profession;
      });
      if (!matched) return null;
      if (usedCharIds.has(matched.charId)) return null;
      usedCharIds.add(matched.charId);
      return {
        aliasName: isFriend ? alias : null,
        assistCharList: assistChars,
        assistSlotIndex: assistChars.indexOf(matched),
        avatar: info.avatar,
        canRequestFriend: !isFriend,
        isFriend,
        lastOnlineTime: info.lastOnlineTime,
        level: info.level,
        nickName: info.nickName,
        nickNumber: info.nickNumber,
        powerScore: 200,
        uid: info.uid,
      };
    };

    // 1. 好友助战（随机洗牌，最多 MAX_LIST）——并发查询（建议 14：N 次独立 IO 并行，
    //    结果保持洗牌序，失败项跳过）
    const friends = [...social.friends].sort(() => Math.random() - 0.5);
    const friendInfos = await Promise.all(
      friends.map((f) => accountManager.getPlayerFriendInfo(f.uid).catch(() => null)),
    );
    for (let i = 0; i < friendInfos.length && assistList.length < MAX_LIST; i++) {
      const info = friendInfos[i];
      if (!info) continue;
      const item = buildAssistInfo(info, true, friends[i].alias);
      if (item) assistList.push(item);
    }

    // 2. 数据不足时随机补位（其他账号，非好友）——并发查询（建议 14）
    if (assistList.length < MAX_LIST) {
      const otherUids = accountManager
        .getPlayerUidList()
        .filter((uid) => uid !== this._uid && !friendUids.has(uid))
        .sort(() => Math.random() - 0.5);
      const otherInfos = await Promise.all(
        otherUids.map((uid) => accountManager.getPlayerFriendInfo(uid).catch(() => null)),
      );
      for (let i = 0; i < otherInfos.length && assistList.length < MAX_LIST; i++) {
        const info = otherInfos[i];
        if (!info) continue;
        const item = buildAssistInfo(info, false, "");
        if (item) assistList.push(item);
      }
    }

    // 3. 仍不足时回退当前玩家自己的助战干员（修复：单账号私服/玩家过少时好友与
    //    其他账号池皆为空 → 借不到助战；用自己的助战补位保证始终能借）
    if (assistList.length < MAX_LIST) {
      const self = await accountManager.getPlayerFriendInfo(this._uid);
      const item = buildAssistInfo(self, true, "");
      if (item) assistList.push(item);
    }

    // 结构化域日志（建议 16）：助战列表刷新事件，字段自解释，Dashboard 可按域/事件过滤
    this.socialLog.event("refreshAssistList", {
      profession,
      assistCount: assistList.length,
      friendCount: social.friends.length,
      nextAllowAskTs: 0, // 占位：无独立冷却字段（请求冷却在路由层判定）
    });

    return assistList;
  }

  async setFriendAlias(args: { friendId: string; alias: string }) {
    const { friendId, alias } = args;
    await accountManager.setFriendAlias(this._uid, friendId, alias);
  }

  async searchPlayer(args: { idList?: string[] }) {
    const idList = args?.idList ?? [];
    const social = await accountManager.getSocial(this._uid);
    const friendRequestList = await Promise.all(
      idList.map((id) => accountManager.getPlayerFriendInfo(id)),
    );
    // 修复：status 1（已发送申请）应为"我向 TA 发过申请"——原实现查 social.friendRequests
    //（我收到的申请）方向相反；改为查对方收到的申请里是否含我
    const friendStatusList = await Promise.all(
      friendRequestList.map(async (id) => {
        if (social.friends.some((friend) => friend.uid === id.uid)) {
          return 2;
        }
        const sentTo = await accountManager.getFriendRequests(id.uid);
        if (sentTo.includes(this._uid)) {
          return 1;
        }
        return 0;
      }),
    );
    return {
      players: friendRequestList,
      resultIdList: idList,
      friendStatusList: friendStatusList,
    };
  }

  async getFriendRequestList(args: { idList?: string[] }) {
    const idList = args?.idList ?? [];
    const friendRequestList = idList.map((id) =>
      accountManager.getPlayerFriendInfo(id),
    );
    return {
      requestList: await Promise.all(friendRequestList),
      resultIdList: idList,
    };
  }
}
