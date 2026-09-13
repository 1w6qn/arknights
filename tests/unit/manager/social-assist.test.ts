import { describe, it, expect, beforeEach, vi } from "vitest";
import { SocialManager } from "@game/modules/social/SocialManager";
import { accountManager } from "@game/modules/account/AccountManager";
import type { FriendDataWithNameCard } from "@game/kernel/social-model";
import type { SharedCharData } from "@game/kernel/model";
import {
  asPlayerManager,
  mockExcelWith,
  mockPlayerData,
  mockTypedEventEmitter,
} from "../../helpers";

// excel 数据端口替身:SocialManager 经 `player.excel` 取表(不再是模块级 mock)；
// 以 mockExcel() 空表 + 门面方法为底，只覆盖用例读到的 CharacterTable
const excelMock = mockExcelWith({
  CharacterTable: {
    char_001: { profession: "WARRIOR" },
    char_002: { profession: "CASTER" },
    char_003: { profession: "WARRIOR" },
  },
});

/**
 * 好友信息夹具（窄视图）
 *
 * 只声明 getAssistList 读到/透传的字段，契约 `FriendDataWithNameCard` 的其余必填字段
 * 在替身里缺省。`lastOnlineTime` 契约是 number 时间戳，夹具沿用 `Date`（被测分支只透传、
 * 不做数值运算也不断言），故按 `Date | number` 加宽后就地断言回契约类型（运行期值一字未改）。
 */
interface AssistFriendFixture {
  uid: string;
  nickName: string;
  nickNumber: string;
  level: number;
  avatar: { type: string; id: string };
  lastOnlineTime: Date | number;
  assistCharList: SharedCharData[];
}

describe("SocialManager.getAssistList 随机补位", () => {
  let social: SocialManager;

  function friendInfo(uid: string, charIds: string[]): FriendDataWithNameCard {
    const assistCharList: SharedCharData[] = charIds.map((charId, i) => ({
      charId,
      charInstId: i + 1,
      skills: [],
      mainSkillLvl: 7,
      skillIndex: 0,
      evolvePhase: 2,
      favorPoint: 100,
      potentialRank: 0,
      level: 50,
      crisisRecord: {},
      crisisV2Record: {},
      currentEquip: null,
      equip: [],
    }));
    const info: AssistFriendFixture = {
      uid,
      nickName: `玩家${uid}`,
      nickNumber: "1000",
      level: 60,
      avatar: { type: "SYSTEM", id: "avatar_1" },
      lastOnlineTime: new Date(),
      assistCharList,
    };
    // 夹具窄视图 → 契约类型（见 AssistFriendFixture 注释）
    return info as FriendDataWithNameCard;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    const pd = mockPlayerData({
      status: { uid: "1", nickName: "A" },
    });
    // excel 数据端口替身注入(见文件头说明)
    pd.excel = excelMock;
    const mockTrigger = mockTypedEventEmitter();
    pd._trigger = mockTrigger;
    social = new SocialManager(asPlayerManager(pd), mockTrigger);
    vi.spyOn(accountManager, "getPlayerUidList").mockReturnValue(["1", "2", "3"]);
  });

  it("好友助战不足时应从其他账号随机补位", async () => {
    // 好友 uid=2 有匹配助战；其他账号 uid=3 也有匹配（补位来源）
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [{ uid: "2", alias: "好友B" }],
      friendRequests: [],
      visited: [],
    });
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockImplementation(
      async (uid: string) => friendInfo(uid, uid === "2" ? ["char_001"] : ["char_003"]),
    );
    const list = await social.getAssistList({ profession: "WARRIOR" });
    expect(list.length).toBe(2);
    // 好友在列表中
    expect(list.some((item) => item.uid === "2" && item.isFriend === true)).toBe(true);
    // 补位项标记为非好友、可请求
    const fill = list.find((item) => item.uid === "3");
    expect(fill).toBeDefined();
    expect(fill!.isFriend).toBe(false);
    expect(fill!.canRequestFriend).toBe(true);
    expect(fill!.aliasName).toBeNull();
  });

  it("无匹配职业时应返回空列表（不补位到错误职业）", async () => {
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [{ uid: "2", alias: "好友B" }],
      friendRequests: [],
      visited: [],
    });
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockImplementation(
      async (uid: string) => friendInfo(uid, ["char_002"]), // CASTER 不匹配 WARRIOR
    );
    const list = await social.getAssistList({ profession: "WARRIOR" });
    expect(list).toHaveLength(0);
  });

  it("玩家过少（无好友、无其他账号）时应回退自己助战补位", async () => {
    // 单账号私服：池子只有自己，好友为空 → 借不到助战则用自己补位
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [],
      friendRequests: [],
      visited: [],
    });
    vi.spyOn(accountManager, "getPlayerUidList").mockReturnValue(["1"]);
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockImplementation(
      async (uid: string) => friendInfo(uid, ["char_001"]),
    );
    const list = await social.getAssistList({ profession: "WARRIOR" });
    expect(list.length).toBe(1);
    const self = list[0];
    expect(self.uid).toBe("1");
    // 自己不可请求好友
    expect(self.isFriend).toBe(true);
    expect(self.canRequestFriend).toBe(false);
  });

  it("排除自己与其他账号重复干员", async () => {
    vi.spyOn(accountManager, "getSocial").mockResolvedValue({
      friends: [],
      friendRequests: [],
      visited: [],
    });
    // uid=2 和 uid=3 都是 WARRIOR 且同 charId
    vi.spyOn(accountManager, "getPlayerFriendInfo").mockImplementation(
      async (uid: string) => friendInfo(uid, ["char_001"]),
    );
    const list = await social.getAssistList({ profession: "WARRIOR" });
    // 只保留 1 个（charId 去重）
    expect(list.length).toBe(1);
  });
});
