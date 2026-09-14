import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("@utils/crypt", () => ({
  decryptBattleData: vi.fn().mockResolvedValue({ completeState: 1, finalHp: 8, isPerfect: 1 }),
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import { asModel, mockPlayerData, type MockSeed } from "../../../helpers";
import excel from "@excel/excel";

beforeAll(async () => {
  await excel.init();
}, 120000);

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
 * number、无 rarity 键；`RoguelikeV2` 运行时用字符串 instId）——为不改夹具数据，
 * 视图仅放宽这两键，其余字段名/类型仍受真实模型约束。
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

/**
 * 招募候选夹具视图
 *
 * 生产侧候选的 `instId`/`troopInstId` 为字符串序号（见 recruit.ts `Rlv2RecruitCandidate`：
 * 真实 `RecruitChar` 声明为 number，运行时以字符串下发）；夹具按历史写法填字符串，
 * 故视图放宽这两键，其余字段沿用真实模型的深可选视图。
 */
type RecruitCandidateFixture = Omit<
  MockSeed<PlayerRoguelikeV2.CurrentData.RecruitChar>,
  "instId" | "troopInstId"
> & {
  instId: number | string;
  troopInstId: number | string;
};

/** 招募券夹具视图（result 为 null 或候选夹具） */
type RecruitTicketFixture = Omit<
  MockSeed<PlayerRoguelikeV2.CurrentData.Recruit>,
  "list" | "result"
> & {
  list: RecruitCandidateFixture[];
  result: RecruitCandidateFixture | null;
};

function makePlayer() {
  const rogue6Outer: Rogue6OuterFixture = {
    record: { last: 0, lastZone: 3, legacy: [], stageCnt: {}, bandCnt: {}, bandGrade: {} },
    collect: { band: {} },
    buff: { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0 },
    monthTeam: { valid: [] },
  };
  const troopFixture: TroopFixture = {
    chars: {
      33: {
        instId: 33, charId: "char_4230_mcnist", level: 90, exp: 0, evolvePhase: 2,
        potentialRank: 5, favorPoint: 625, mainSkillLvl: 7, gainTime: 0, skin: "char_4230_mcnist#2",
        defaultSkillIndex: 0, voiceLan: "cn",
        skills: [
          { skillId: "skchr_mcnist_1", unlock: 1, state: 0, specializeLevel: 2, completeUpgradeTime: -1 },
          { skillId: "skchr_mcnist_2", unlock: 1, state: 0, specializeLevel: 2, completeUpgradeTime: -1 },
          { skillId: "skchr_mcnist_3", unlock: 1, state: 0, specializeLevel: 3, completeUpgradeTime: -1 },
        ],
        currentEquip: "uniequip_002_mcnist",
        equip: {
          uniequip_001_mcnist: { hide: 0, locked: 0, level: 1 },
          uniequip_002_mcnist: { hide: 0, locked: 0, level: 3 },
        },
        master: { master_mcnist_1: 3, master_mcnist_2: 2, master_mcnist_3: 3, master_mcnist_4: 3, master_mcnist_5: 1, master_mcnist_6: 1 },
      },
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
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefined: null, outer: { support: false } });
  return player;
}

describe("recruitChar 响应结构对齐官服（2026-08-18 抓包校准）", () => {
  it("招募结果含完整养成结构：skills/master/equip/currentEquip + instId/troopInstId 语义", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    // Emittery emit 异步：构造期 rlv2:init 未 await，等微任务落定后再注入票
    await Promise.resolve();
    const rm = rlv2.inventory!._recruit;
    const ticketFixture: RecruitTicketFixture = {
      index: "t_0", id: "rogue_6_recruit_ticket_sniper", state: 1,
      list: [{
        instId: "0", charId: "char_4230_mcnist", type: "NORMAL",
        favorPoint: 625, potentialRank: 5, mainSkillLvl: 7, skin: "char_4230_mcnist#2",
        level: 90, exp: 0, evolvePhase: 2, defaultSkillIndex: 0, skills: [],
        upgradeLimited: false, upgradePhase: 1, isUpgrade: false, isCure: false,
        population: 2, charBuff: [], troopInstId: "33", master: {},
      }],
      result: null, from: "initial", mustExtra: 0, needAssist: false, ts: 0,
    };
    rm.tickets["t_0"] = ticketFixture as PlayerRoguelikeV2.CurrentData.Recruit;
    await rm.done("t_0", "0");
    const c = rm.tickets["t_0"].result!;
    expect(c).toBeTruthy();
    // 官服 chars[0] 22 键
    const expected = ["instId","charId","type","favorPoint","potentialRank","mainSkillLvl","skin","level","exp","evolvePhase","defaultSkillIndex","skills","upgradeLimited","upgradePhase","isUpgrade","isCure","population","charBuff","troopInstId","master","currentEquip","equip"];
    expect(Object.keys(c).sort()).toEqual([...expected].sort());
    // instId = 候选序号（list 下标，与客户端 optionId 一致——官服 recruitChar chars[].instId 即 optionId）；
    // troopInstId = 对局内入队序号（1 基递增）
    expect(c.instId).toBe("0");
    expect(c.troopInstId).toBe("1");
    expect((c.skills || []).length).toBe(3);
    expect(Object.keys(c.master || {}).length).toBe(6);
    expect(c.currentEquip).toBe("uniequip_002_mcnist");
    expect(Object.keys(c.equip || {}).length).toBe(2);
    const troopChars = rlv2.troop.chars;
    expect(Object.keys(troopChars)).toEqual(["1"]);
    expect(troopChars["1"].instId).toBe("1");
    expect(troopChars["1"].charId).toBe("char_4230_mcnist");
    expect((troopChars["1"].skills || []).length).toBe(3);
    expect(troopChars["1"].currentEquip).toBe("uniequip_002_mcnist");
  });

  it("精二源干员首次招募被锁定精一时：专精/模组养成同步裁剪（显示与状态一致）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await Promise.resolve();
    const rm = rlv2.inventory!._recruit;
    // 候选体现 active() 的 levelPatch：精二源降为精一（evolvePhase=1、精一满级、exp=0、upgradeLimited）
    const ticketFixture: RecruitTicketFixture = {
      index: "t_0", id: "rogue_6_recruit_ticket_sniper", state: 1,
      list: [{
        instId: "0", charId: "char_4230_mcnist", type: "NORMAL",
        favorPoint: 625, potentialRank: 5, mainSkillLvl: 7, skin: "char_4230_mcnist#2",
        level: 50, exp: 0, evolvePhase: 1, defaultSkillIndex: 0, skills: [],
        upgradeLimited: true, upgradePhase: 0, isUpgrade: false, isCure: false,
        population: 2, charBuff: [], troopInstId: "33", master: {},
      }],
      result: null, from: "initial", mustExtra: 0, needAssist: false, ts: 0,
    };
    rm.tickets["t_0"] = ticketFixture as PlayerRoguelikeV2.CurrentData.Recruit;
    await rm.done("t_0", "0");
    const c = rm.tickets["t_0"].result!;
    expect(c.evolvePhase).toBe(1);
    // 精一仅保留已解锁的前 2 个技能（三技能 skchr_mcnist_3 为 PHASE_2 需精二，剔除）
    expect(c.skills.map((s) => s.skillId)).toEqual([
      "skchr_mcnist_1",
      "skchr_mcnist_2",
    ]);
    // 专精归零（精一不可专精）
    for (const s of c.skills) expect(s.specializeLevel).toBe(0);
    // 默认技能钳制到保留技能数内（候选 defaultSkillIndex=0 保持 0）
    expect(c.defaultSkillIndex).toBe(0);
    // 无专精 → master 清空；无模组 → equip/currentEquip 清空
    expect(Object.keys(c.master || {})).toEqual([]);
    expect(Object.keys(c.equip || {})).toEqual([]);
    expect(c.currentEquip).toBe("");
  });

  it("战斗获取招募券招募：result.instId 保持候选序号（防客户端按 instId 回查候选列表命中错误干员崩溃）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await Promise.resolve();
    const rm = rlv2.inventory!._recruit;
    // 模拟战斗获取招募券 t_0：候选 troopInstId 为玩家主队伍 instId（此处恰为 "5"，
    // 数值落在候选列表下标范围内——旧实现把 result.instId 写成该值会让客户端
    // 按 chars[].instId 回查候选列表命中错误干员 → 招募后崩溃）
    const ticketFixture: RecruitTicketFixture = {
      index: "t_0", id: "rogue_6_recruit_ticket_tank", state: 1,
      list: [{
        instId: "0", charId: "char_4230_mcnist", type: "NORMAL",
        favorPoint: 625, potentialRank: 5, mainSkillLvl: 7, skin: "char_4230_mcnist#2",
        level: 80, exp: 0, evolvePhase: 1, defaultSkillIndex: 0, skills: [],
        upgradeLimited: true, upgradePhase: 0, isUpgrade: false, isCure: false,
        population: 6, charBuff: [], troopInstId: "5", master: {},
      }],
      result: null, from: "battle", mustExtra: 0, needAssist: false, ts: 0,
    };
    rm.tickets["t_0"] = ticketFixture as PlayerRoguelikeV2.CurrentData.Recruit;
    await rm.done("t_0", "0");
    const c = rm.tickets["t_0"].result!;
    // instId 必须等于候选序号（与客户端请求 optionId "0" 一致），而非玩家主队伍 instId "5"
    expect(c.instId).toBe("0");
    expect(c.charId).toBe("char_4230_mcnist");
    expect(c.troopInstId).toBe("1");
    // 信赖取整（客户端 favorPoint 为 int；历史数据可为小数）
    expect(Number.isInteger(c.favorPoint)).toBe(true);
    // 招募结果结构与官服一致（22 键）
    const expected = ["instId","charId","type","favorPoint","potentialRank","mainSkillLvl","skin","level","exp","evolvePhase","defaultSkillIndex","skills","upgradeLimited","upgradePhase","isUpgrade","isCure","population","charBuff","troopInstId","master","currentEquip","equip"];
    expect(Object.keys(c).sort()).toEqual([...expected].sort());
  });
});
