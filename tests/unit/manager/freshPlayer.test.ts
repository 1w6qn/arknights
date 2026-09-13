import { describe, it, expect } from "vitest";
import {
  buildFreshPlayerData,
  buildFreshStatus,
  freshTroop,
  freshGacha,
} from "@game/kernel/fresh-player";

/**
 * freshPlayer 构造函数的返回契约是 `Record<string, unknown>`（用于整体覆盖存档分区），
 * 用例按「被读到键」的窄视图断言；下表即各分区的窄视图，字段名与真实模型一致。
 */
type FreshStatusView = {
  uid: string;
  level: number;
  exp: number;
  gold: number;
  androidDiamond: number;
  iosDiamond: number;
  gachaTicket: number;
  registerTs: number;
  lastOnlineTs: number;
  mainStageProgress: number;
  campaigns: Record<string, number>;
  maxAccountResVersion?: string;
  avatar: { avatar_icon: Record<string, { ts: number; src: string }> };
};

type FreshTroopView = {
  chars: Record<string, never>;
  addon: Record<string, never>;
  charGroup: Record<string, never>;
  squads: Record<string, { slots: null[] }>;
};

type FreshGachaView = {
  normal: { cnt: number; poolId: string };
  newbee: { cnt: number; poolId: string };
};

type FreshBuildingView = { chars: Record<string, never> };
type FreshHomeThemeView = { selected: string };

/** 一份模拟的「满配模板」基底（足够表征各分区，用于验证全新化） */
function maxedTemplate(): Record<string, unknown> {
  return {
    status: {
      uid: "1",
      nickName: "满配号",
      nickNumber: "1",
      level: 120,
      exp: 99999,
      gold: 99999999,
      androidDiamond: 99999,
      iosDiamond: 99999,
      diamondShard: 88888,
      gachaTicket: 99,
      maxAp: 178,
      ap: 178,
      lastApAddTime: 1000,
      lastOnlineTs: 2000,
      registerTs: 1000,
      mainStageProgress: "obt/main/level_main_14-20_end",
      maxAccountResVersion: "v1",
      campaigns: { "obt/main/level_main_01": 1 },
      progress: { some: 1 },
      avatar: {
        avatar_icon: {
          avatar_def_01: { ts: 1, src: "initial" },
          avatar_activity_EP13: { ts: 2, src: "other" },
        },
      },
    },
    troop: {
      curCharInstId: 317,
      curSquadCount: 4,
      squads: {
        0: { squadId: "0", name: "1", slots: [{ charInstId: 2, skillIndex: 1 }] },
        1: { squadId: "1", name: "2", slots: [null, null] },
      },
      chars: { "2": { charId: "char_002_amiya" } },
      addon: { char_002_amiya: 1 },
      charGroup: { g1: 1 },
      charMission: { m1: 1 },
    },
    inventory: { gold: 100, renamingCard: 3, some_mat: 999 },
    consumable: { item_1: { "0": { ts: -1, count: 999 } } },
    gacha: {
      newbee: { openFlag: 0, cnt: 0, poolId: "BOOT_0_1_1" },
      normal: { openFlag: 1, cnt: 50, poolId: "OBT" },
    },
    medal: { medals: { m: { id: 1 } }, custom: {} },
    mission: { missions: { DAYILY: { "x": {} } }, missionRewards: {}, missionGroups: {} },
    building: {
      status: { labor: { value: 225, maxValue: 225 } },
      chars: { "2": {} },
      rooms: {},
    },
    homeTheme: { selected: "tm_rogue_4", themes: { tm_rogue_4: { unlock: 1 } } },
    rlv2: { outer: { rogue_4: {} }, current: { x: 1 }, pinned: "rogue_4" },
    pushFlags: { hasGifts: 1, status: 11112222 },
    skin: { a: 1 },
    social: { friends: [] },
  };
}

describe("freshPlayer 构造全新玩家存档", () => {
  const opts = { uid: "99", nickName: "博士99", nickNumber: "1", registerTs: 123456 };

  it("新号不从满配模板继承财富/等级（status 归零重置为 1 级）", () => {
    const data = buildFreshPlayerData(maxedTemplate(), opts);
    const s = data.status as FreshStatusView;
    expect(s.level).toBe(1);
    expect(s.exp).toBe(0);
    expect(s.gold).toBe(0);
    expect(s.androidDiamond).toBe(0);
    expect(s.iosDiamond).toBe(0);
    expect(s.gachaTicket).toBe(0);
    expect(s.registerTs).toBe(opts.registerTs);
    expect(s.lastOnlineTs).toBe(0);
    expect(s.mainStageProgress).toBe(0);
    expect(s.campaigns).toEqual({});
    expect(s.uid).toBe("99");
  });

  it("去除满配版本标记，避免新号被按版本刷成满配", () => {
    const data = buildFreshPlayerData(maxedTemplate(), opts);
    expect((data.status as FreshStatusView).maxAccountResVersion).toBeUndefined();
  });

  it("拥有干员清空、编队槽位保留为空", () => {
    const data = buildFreshPlayerData(maxedTemplate(), opts);
    const troop = data.troop as FreshTroopView;
    expect(troop.chars).toEqual({});
    expect(troop.addon).toEqual({});
    expect(troop.charGroup).toEqual({});
    // 编队骨架保留，槽位清空
    expect(Object.keys(troop.squads)).toContain("0");
    expect(troop.squads["0"].slots.every((slot) => slot === null)).toBe(true);
  });

  it("背包计数清零、消耗品/皮肤清空", () => {
    const data = buildFreshPlayerData(maxedTemplate(), opts);
    const inv = data.inventory as Record<string, number>;
    for (const k of Object.keys(inv)) expect(inv[k]).toBe(0);
    expect(data.consumable).toEqual({});
    expect(data.skin).toEqual({});
  });

  it("抽卡计数重置但保留各卡池 poolId", () => {
    const data = buildFreshPlayerData(maxedTemplate(), opts);
    const g = data.gacha as FreshGachaView;
    expect(g.normal.cnt).toBe(0);
    expect(g.normal.poolId).toBe("OBT");
    expect(g.newbee.poolId).toBe("BOOT_0_1_1");
  });

  it("勋章/任务/肉鸽/基建动态/首页主题重置为全新默认", () => {
    const data = buildFreshPlayerData(maxedTemplate(), opts);
    expect(data.medal).toEqual({ medals: {}, custom: {} });
    expect(data.mission).toEqual({ missions: {}, missionRewards: {}, missionGroups: {} });
    expect(data.rlv2).toEqual({ outer: {}, current: {}, pinned: "" });
    expect((data.building as FreshBuildingView).chars).toEqual({});
    expect((data.homeTheme as FreshHomeThemeView).selected).toBe("tm_rhodes_day");
  });

  it("收集/历史分区全新清空，不继承满配图鉴与活动进度", () => {
    const data = buildFreshPlayerData(maxedTemplate(), opts);
    expect(data.dexNav).toEqual({});
    expect(data.collectionReward).toEqual({});
    expect(data.activity).toEqual({});
    expect(data.nameCardStyle).toEqual({
      componentOrder: ["module_medal", "module_sign"],
      skin: { selected: "nc_rhodes_default", state: {} },
      misc: { showDetail: false, showBirthday: false },
    });
    expect(data.charRotation).toEqual({ current: "", preset: {} });
  });

  it("头像仅保留默认（src=initial），丢弃活动头像", () => {
    const fr = buildFreshStatus(maxedTemplate().status as FreshStatusView, opts);
    const icons = (fr.avatar as FreshStatusView["avatar"]).avatar_icon;
    expect(Object.keys(icons)).toEqual(["avatar_def_01"]);
  });

  it("未对模板产生副作用（深拷贝隔离）", () => {
    const tpl = maxedTemplate();
    buildFreshPlayerData(tpl, opts);
    expect((tpl.status as FreshStatusView).level).toBe(120);
    expect((tpl.status as FreshStatusView).gold).toBe(99999999);
  });

  it("freshTroop/freshGacha 对缺省（undefined）输入安全", () => {
    expect(freshTroop(undefined)).toBeDefined();
    expect(freshGacha(undefined)).toEqual({});
  });
});