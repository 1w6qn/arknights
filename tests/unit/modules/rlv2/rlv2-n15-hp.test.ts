import { describe, it, expect, vi } from "vitest";
import { buildRoguelikeConsts } from "@game/excel/roguelike_consts_gen";
/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }


// ===== N15 开局血量回归 =====
// 用户 bug：N15（modeGrade 15）开局血/血上限 0，客户端"系统发生未知故障"。
// 根因：init 表已按 modeGrade 预扣血量（grade 0=8 / 1-9=6 / 10+=4），
// 但 difficultyBuffs 又从难度描述解析"目标生命上限-2"（难度1/难度10 各 -2）
// 二次应用 → N15 4-2-2=0/0。
// 修复：难度描述不再生成 level_life_point_add（血量由 init 表承载）。

// 用真实 excel 数据
vi.mock("@excel/excel", () => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,

    RoguelikeTopicTable: require("../../../../data/excel/roguelike_topic_table.json"),
    CharacterTable: require("../../../../data/excel/character_table.json"),
    GameDataConst: require("../../../../data/excel/gamedata_const.json"),
    RoguelikeConsts: buildRoguelikeConsts(require("../../../../data/excel/roguelike_topic_table.json")),
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import { asModel, mockPlayerData, type MockSeed } from "../../../helpers";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/** 生成模型局外主题数据类型（`outer[theme]`） */
type GeneratedOuter = PlayerDataModel["rlv2"]["outer"][string];

/**
 * 局外 rogue_6 夹具视图
 *
 * 历史夹具携带两个未建模键：`record.lastZone`、`monthTeam.valid`（生产侧只读
 * record/collect/buff/monthTeam 的已建模键）；为不改夹具数据，按读取面声明视图，
 * 真实 `GeneratedOuter` 可赋给本视图（各键同名同型、本视图键全可选），故单点断言成立。
 */
interface Rogue6OuterFixture {
  record?: {
    last?: number;
    lastZone?: number;
    legacy?: string[];
    stageCnt?: { [key: string]: number };
    bandCnt?: { [key: string]: { [key: string]: number } };
    bandGrade?: { [key: string]: { [key: string]: number } };
  };
  collect?: { band?: { [key: string]: { state?: number } } };
  buff?: {
    pointOwned?: number;
    pointCost?: number;
    unlocked?: { [key: string]: number };
    score?: number;
  };
  monthTeam?: { valid?: number[] };
}

/**
 * 干员夹具视图
 *
 * 历史夹具用数字 `instId` 且带展示用 `rarity`（真实 `PlayerCharacter.instId` 为
 * number、无 rarity 键）——为不改夹具数据，视图仅放宽这两键，其余字段名/类型
 * 仍受真实模型约束。
 */
type TroopCharFixture = Omit<
  MockSeed<PlayerDataModel["troop"]["chars"][string]>,
  "instId"
> & {
  instId?: number | string;
  rarity?: string;
};

/** 队伍夹具视图 */
interface TroopFixture {
  chars?: { [key: string]: TroopCharFixture };
}

function makePlayer(modeGrade = 15) {
  const rogue6Outer: Rogue6OuterFixture = {
    record: { last: 0, lastZone: 3, legacy: [], stageCnt: {}, bandCnt: {}, bandGrade: {} },
    collect: { band: {} },
    buff: { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0 },
    monthTeam: { valid: [] },
  };
  const troopFixture: TroopFixture = {
    chars: {
      1: { charId: "char_002_amiya", instId: 1, rarity: "TIER_5" },
      2: { charId: "char_010_chen", instId: 2, rarity: "TIER_6" },
      3: { charId: "char_124_kroos", instId: 3, rarity: "TIER_3" },
      4: { charId: "char_1039_thorn2", instId: 4, rarity: "TIER_6" },
      5: { charId: "char_017_huang", instId: 5, rarity: "TIER_6" },
      6: { charId: "char_102_texas", instId: 6, rarity: "TIER_5" },
    },
  };
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: {
        rogue_6: rogue6Outer as MockSeed<GeneratedOuter>,
      },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
    troop: troopFixture as MockSeed<PlayerDataModel["troop"]>,
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade, predefined: null, outer: { support: true } });
  return player;
}

describe("N15 开局血量（init 表承载难度扣血，不二次解析）", () => {
  it("createGame N15：血 4/4（init grade15 initialHp=4），难度 buff 无 level_life_point_add", async () => {
    const player = makePlayer(15);
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    expect(rlv2._status.property.hp).toEqual({ current: 4, max: 4 });
    expect(rlv2._status.property.population.max).toBe(6);
    const diffs = rlv2._buff.difficultyBuffs("rogue_6", 15);
    expect(diffs.some((b) => b.key === "level_life_point_add")).toBe(false);
    // 其余难度 buff 正常累积
    const keys = diffs.map((b) => b.key);
    expect(keys).toContain("scrap_limit_add");
    expect(keys).toContain("zone_gold_loss_percent");
    expect(keys).toContain("deploy_limit_add");
    expect(keys).toContain("recruit_hop_cost");
  });

  it("各难度档初始血量 = init 表（0:8 / 1:6 / 10:4），无双重扣血", async () => {
    for (const [grade, hp] of [
      [0, 8],
      [1, 6],
      [9, 6],
      [10, 4],
      [15, 4],
    ] as const) {
      const player = makePlayer(grade);
      const rlv2 = player.rlv2;
      await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: grade, predefinedId: null });
      expect(rlv2._status.property.hp.current).toBe(hp);
      expect(rlv2._status.property.hp.max).toBe(hp);
    }
  });

  it("N15 完整开局（选分队→招募→finishEvent）：血保持 4/4，WAIT_MOVE 进入第一层", async () => {
    const player = makePlayer(15);
    const rlv2 = player.rlv2;
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
      await rlv2.chooseInitialRelic({ select: "0" });
      // 消费 GIFT（无 legacy 则无）→ SUPPORT → RecruitSet → 招募
      // 官服语义：finishEvent 消费 GIFT，selectChoice 消费 SUPPORT，
      // chooseInitialRecruitSet 消费 RECRUIT_SET（8-11 抓包对照）
      const pend = rlv2._status.pending;
      const types = pend.map((e) => e.type);
      expect(types).toContain("GAME_INIT_RECRUIT_SET");
      if (pend[0]?.type === "GAME_INIT_GIFT") await rlv2.finishEvent();
      if (pend[0]?.type === "GAME_INIT_SUPPORT") {
        const choices = pend[0].content.initSupport!.scene.choices;
        await rlv2.selectChoice({ choice: Object.keys(choices)[0] });
      }
      await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
      const recruitEvt = pend.find((e) => e.type === "GAME_INIT_RECRUIT");
      for (const t of recruitEvt?.content?.initRecruit?.tickets || []) {
        await rlv2.activeRecruitTicket({ id: t });
        const ticket = rlv2.inventory!.recruit[t];
        if (ticket.list.length > 0) {
          await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
        }
      }
      await rlv2.finishEvent();
      expect(rlv2._status.state).toBe("WAIT_MOVE");
      expect(rlv2._status.cursor.zone).toBe(1);
      // 分队 0 = 指挥分队（目标生命上限+2）→ 4+2=6；血量非 0/0 即通过（回归双重扣血）
      expect(rlv2._status.property.hp.max).toBe(6);
      expect(rlv2._status.property.hp.current).toBe(6);
    } finally {
      rand.mockRestore();
    }
  });
});

describe("各主题招募/进阶希望消耗（官方表）", () => {
  it("rogue_5 萨卡兹：招募消耗表 000026（4星0/5星2/6星6）", async () => {
    const player = makePlayer(0);
    const rlv2 = player.rlv2;
    // 覆盖当前主题为 rogue_5（populationFor 按 theme 分支）
    rlv2.current.game!.theme = "rogue_5";
    await rlv2._module.create();
    const recruit = rlv2.inventory!._recruit;
    const pop = recruit["populationFor"].bind(recruit);
    // TIER_3→2 / TIER_4→3 / TIER_5→4 / TIER_6→5
    expect(pop(2)).toBe(0); // 3星
    expect(pop(3)).toBe(0); // 4星
    expect(pop(4)).toBe(2); // 5星
    expect(pop(5)).toBe(6); // 6星
    // rogue_6 同官方表 000026：6星6（官方文本+实测确认）
    rlv2.current.game!.theme = "rogue_6";
    expect(pop(5)).toBe(6);
    // 进阶消耗表（000113：4星1/5星1/6星3）
    rlv2.current.game!.theme = "rogue_5";
    const adv = recruit["advancePopulationFor"].bind(recruit);
    expect(adv(3)).toBe(1);
    expect(adv(4)).toBe(1);
    expect(adv(5)).toBe(3);
  });
});

describe("rlv2 响应 outer 精简（对齐官服 createGame）", () => {
  it("createGame 响应 outer 只含当前主题 record/monthTeam，响应显著瘦身", async () => {
    const player = makePlayer(15);
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    const { rlv2Response } = await import("@game/modules/roguelike/response");
    // 2026-08-18：outer 改为显式 outerKeys（对齐官服 createGame={record,monthTeam}）
    const resp = rlv2Response(player, undefined, undefined, ["record", "monthTeam"]);
    const r = resp.playerDataDelta.modified.rlv2;
    // outer 只含当前主题 rogue_6（不再全量 6 主题）
    expect(Object.keys(r.outer!)).toEqual(["rogue_6"]);
    // 该主题只含 record + monthTeam（官服 createGame 结构；collect/buff/bank 等
    // 客户端从 syncData 全量拿，不随 rlv2 路由下发）
    expect(Object.keys(r.outer!.rogue_6).sort()).toEqual(["monthTeam", "record"]);
    // 响应总大小显著小于修复前（255KB → 数 KB）
    expect(JSON.stringify(resp).length).toBeLessThan(20000);
  });
});

describe("重登继续探索（controller 重建恢复进行中游戏）", () => {
  it("createGame 后重建 controller：current.game 保留、status/map/pending 恢复", async () => {
    const player = makePlayer(15);
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    // 模拟 rlv2Response：内存态写回存档（status/pending 等持久化）
    player.rlv2.persistCurrent();
    // 模拟重启重登：用同一存档数据新建 PlayerDataManager → 新 controller 构造
    const pd2 = mockPlayerData({});
    // 复用当前玩家数据（含进行中 current）——直接改 pd2 的引用为同一 _playerdata
    const player2 = new PlayerDataManager(player._playerdata);
    const rlv22 = player2.rlv2;
    // 构造器 hasRunning 分支：current.game.theme 保留（不被重置 NONE）
    expect(rlv22.current.game!.theme).toBe("rogue_6");
    expect(rlv22.current.game!.mode).toBe("NORMAL");
    // status 恢复（非 NONE、有属性）
    expect(rlv22._status.state).toBe("INIT");
    expect(rlv22._status.property.hp.max).toBeGreaterThan(0);
    // pending 恢复（RELIC 已被 chooseInitialRelic 消费，剩余 RECRUIT_SET 等）
    await new Promise((r) => setTimeout(r, 0)); // 等 rlv2:continue 异步 emit 恢复 pending
    const types = rlv22._status.pending.map((e) => e.type);
    expect(types).toContain("GAME_INIT_RECRUIT_SET");
  });
});
