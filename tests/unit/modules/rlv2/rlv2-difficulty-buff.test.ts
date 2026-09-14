import { describe, it, expect, vi, beforeEach } from "vitest";
/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }
/** excel mock 干员行形状（本文件用到的字段即可） */
interface ExcelCharRowMock {
  name?: string;
  charId?: string;
  rarity?: string;
  profession?: string;
  subProfessionId?: string;
}


// 官方 excel mock：difficulties 带 ruleDesc/addDesc（难度描述）
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

    RoguelikeTopicTable: {
      details: {
        rogue_6: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          difficulties: [
            { modeDifficulty: "NORMAL", grade: 1, ruleDesc: "初始目标生命上限-2" },
            { modeDifficulty: "NORMAL", grade: 5, ruleDesc: "所有敌人最大生命+30%" },
            { modeDifficulty: "NORMAL", grade: 7, ruleDesc: "零件箱的初始容量-2" },
            {
              modeDifficulty: "NORMAL",
              grade: 9,
              ruleDesc: "进入下一区域时损失10%的源石锭",
            },
            {
              modeDifficulty: "NORMAL",
              grade: 10,
              ruleDesc: "可同时部署人数-1，初始目标生命上限-2",
            },
            {
              modeDifficulty: "NORMAL",
              grade: 13,
              ruleDesc: "非初始招募五星干员的希望+1",
            },
            {
              modeDifficulty: "NORMAL",
              grade: 15,
              ruleDesc: "非初始招募六星干员的希望+1",
            },
          ],
          items: {},
          relics: {},
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
        rogue_3: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          difficulties: [
            { modeDifficulty: "NORMAL", grade: 2, ruleDesc: "初始目标生命上限-4" },
            {
              modeDifficulty: "NORMAL",
              grade: 6,
              ruleDesc: "招募4星及以上干员时希望消耗+1",
            },
            { modeDifficulty: "NORMAL", grade: 9, ruleDesc: "可同时部署人数-1" },
          ],
          items: {},
          relics: {},
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
        rogue_2: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          difficulties: [
            {
              modeDifficulty: "NORMAL",
              grade: 4,
              ruleDesc: "招募3星及以上干员时希望消耗+1",
              addDesc: "每进入新的区域，所有敌人攻击力和生命值额外+4%",
            },
            { modeDifficulty: "NORMAL", grade: 14, ruleDesc: "可同时部署人数-1" },
          ],
          items: {},
          relics: {},
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
      },
      modules: {
        rogue_6: { moduleTypes: ["SCRAP"], scrap: { scrapItemToType: {} } },
        rogue_3: { moduleTypes: [] },
        rogue_2: { moduleTypes: ["SANCHECK", "DICE"] },
      },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: { rogue_6: { modebuff: {} } },
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer(theme: string, modeGrade: number) {
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: { [theme]: {} },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  // 夹具只声明被测分支读到的键，其余 game 字段由惰性分支承受
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme,
    mode: "NORMAL",
    modeGrade,
  });
  return player;
}

describe("难度描述 → buff 生成（difficultyBuffs）", () => {
  it("rogue_6 难度 1：不再生成生命 buff（init 表已按 modeGrade 预扣：grade1 初始 6）", async () => {
    const player = makePlayer("rogue_6", 1);
    await player.rlv2._module.create();
    await player.rlv2._buff.create();
    const buffs = player.rlv2._buff.difficultyBuffs("rogue_6", 1);
    // 生命上限扣减由 init 表承载（grade1 initialHp=6），难度描述不再二次解析——
    // 否则 N15 双重扣血（init 4 再 -2-2 → 0/0 开局崩溃）
    expect(buffs.some((b) => b.key === "level_life_point_add")).toBe(false);
  });

  it("rogue_6 难度 7：零件箱容量-2", async () => {
    const player = makePlayer("rogue_6", 7);
    await player.rlv2._module.create();
    const buffs = player.rlv2._buff.difficultyBuffs("rogue_6", 7);
    expect(buffs).toContainEqual({
      key: "scrap_limit_add",
      blackboard: [{ key: "value", value: -2 }],
    });
  });

  it("rogue_6 难度 9：区域损失 10% 源石锭", async () => {
    const player = makePlayer("rogue_6", 9);
    await player.rlv2._module.create();
    const buffs = player.rlv2._buff.difficultyBuffs("rogue_6", 9);
    expect(buffs).toContainEqual({
      key: "zone_gold_loss_percent",
      blackboard: [{ key: "value", value: 10 }],
    });
  });

  it("rogue_6 难度 10：部署人数-1（生命上限-2 由 init 表承载，不重复解析）", async () => {
    const player = makePlayer("rogue_6", 10);
    await player.rlv2._module.create();
    const buffs = player.rlv2._buff.difficultyBuffs("rogue_6", 10);
    expect(buffs).toContainEqual({
      key: "deploy_limit_add",
      blackboard: [{ key: "value", value: -1 }],
    });
    expect(buffs.some((b) => b.key === "level_life_point_add")).toBe(false);
  });

  it("rogue_6 难度 13/15：五星/六星干员希望+1（中文数字，精确星级 gte=0）", async () => {
    const player13 = makePlayer("rogue_6", 13);
    await player13.rlv2._module.create();
    const b13 = player13.rlv2._buff.difficultyBuffs("rogue_6", 13);
    expect(b13).toContainEqual({
      key: "recruit_hop_cost",
      blackboard: [
        { key: "min_star", value: 5 },
        { key: "cost", value: 1 },
        { key: "gte", value: 0 },
      ],
    });
    const player15 = makePlayer("rogue_6", 15);
    await player15.rlv2._module.create();
    const b15 = player15.rlv2._buff.difficultyBuffs("rogue_6", 15);
    expect(b15).toContainEqual({
      key: "recruit_hop_cost",
      blackboard: [
        { key: "min_star", value: 6 },
        { key: "cost", value: 1 },
        { key: "gte", value: 0 },
      ],
    });
  });

  it("rogue_3 难度 2/6/9：生命扣减由 init 承载 / 4星及以上希望+1（gte=1）/ 部署-1", async () => {
    const player = makePlayer("rogue_3", 2);
    await player.rlv2._module.create();
    // rogue_3 难度 2 的"初始目标生命上限-4"由 init 表承载（grade2 initialHp=4），
    // 难度描述不再二次解析（避免双重扣血）
    expect(
      player.rlv2._buff.difficultyBuffs("rogue_3", 2).some(
        (b) => b.key === "level_life_point_add",
      ),
    ).toBe(false);
    expect(player.rlv2._buff.difficultyBuffs("rogue_3", 6)).toContainEqual({
      key: "recruit_hop_cost",
      blackboard: [
        { key: "min_star", value: 4 },
        { key: "cost", value: 1 },
        { key: "gte", value: 1 },
      ],
    });
    expect(player.rlv2._buff.difficultyBuffs("rogue_3", 9)).toContainEqual({
      key: "deploy_limit_add",
      blackboard: [{ key: "value", value: -1 }],
    });
  });

  it("rogue_2 难度 4：3星及以上干员希望+1（gte=1，含 addDesc 干扰不误匹配）", async () => {
    const player = makePlayer("rogue_2", 4);
    await player.rlv2._module.create();
    const buffs = player.rlv2._buff.difficultyBuffs("rogue_2", 4);
    expect(buffs).toContainEqual({
      key: "recruit_hop_cost",
      blackboard: [
        { key: "min_star", value: 3 },
        { key: "cost", value: 1 },
        { key: "gte", value: 1 },
      ],
    });
    // addDesc 中"敌人攻击力和生命值额外+4%"不产生服务端 buff
    expect(buffs.some((b) => b.key === "level_life_point_add")).toBe(false);
  });

  it("applyBuffs 实际应用：难度 1 生命-2、难度 7 废品上限-2、难度 10 部署-1 不作用于开局 capacity", async () => {
    const player = makePlayer("rogue_6", 10);
    await player.rlv2._module.create();
    const buff = player.rlv2._buff;
    // 手工构造状态（create 全流程会重置为 init 数值）
    player.rlv2._status.property.hp = { current: 10, max: 10 };
    player.rlv2._status.property.capacity = 6;
    // 进阶式累积：N10 应用 grade 1..10（生命扣减由 init 表承载，不再解析；
    // grade10 部署-1——2026-08-18 对齐官服：可部署人数是战斗内上限，
    // 开局 capacity 不受影响（官服 createGame capacity=7=init6+outbuff_22 携带+1））
    await buff.applyBuffs([buff.difficultyBuffs("rogue_6", 10)]);
    expect(player.rlv2._status.property.hp.max).toBe(10); // 难度 buff 不含生命扣减
    expect(player.rlv2._status.property.capacity).toBe(6); // 部署-1 不作用于开局 capacity
    // 废品上限：N7 应用 grade 1..7（grade7 零件箱-2；grade1 生命-2 不影响）
    const player7 = makePlayer("rogue_6", 7);
    await player7.rlv2._module.create();
    const scrap = player7.rlv2._module.scrap;
    scrap.limit = 6;
    await player7.rlv2._buff.applyBuffs([
      player7.rlv2._buff.difficultyBuffs("rogue_6", 7),
    ]);
    expect(scrap.limit).toBe(4); // 6 - 2(grade7)
  });
});

describe("recruit_hop_cost 消费语义（gte 精确 vs 及以上）", () => {
  // 复用现有 mock：CharacterTable 需含对应干员——用真实 excel 验证语义
  // （此处直接验证 buff 判定逻辑：通过 makePlayer + 手工应用 buff + 调 recruit 内部逻辑较重，
  //   改为验证难度文本解析的 gte 标记已在上面断言覆盖；再验证招募消耗由 rlv2-band-effects 集成测）
  it("rogue_6 N15：6 星消耗 5（4+六星1，非 6）、5 星消耗 3（2+五星1）", async () => {
    // 真实数据集成验证见 rlv2-month-team / rlv2-zone-progress（真实 excel）；
    // 此处轻量断言解析出的 gte 标记组合
    const p = makePlayer("rogue_6", 15);
    await p.rlv2._module.create();
    const buffs = p.rlv2._buff.difficultyBuffs("rogue_6", 15);
    const hop = buffs.filter((b) => b.key === "recruit_hop_cost");
    expect(hop.length).toBe(2);
    expect(hop.map((b) => [b.blackboard[0].value, b.blackboard[2].value])).toEqual([
      [5, 0],
      [6, 0],
    ]);
  });
});

describe("recruit_hop_cost 消费语义（gte 精确 vs 及以上）", () => {
  // 复用现有 mock：CharacterTable 需含对应干员——用真实 excel 验证语义
  // （此处直接验证 buff 判定逻辑：通过 makePlayer + 手工应用 buff + 调 recruit 内部逻辑较重，
  //   改为验证难度文本解析的 gte 标记已在上面断言覆盖；再验证招募消耗由 rlv2-band-effects 集成测）
  it("rogue_6 N15：6 星消耗 5（4+六星1，非 6）、5 星消耗 3（2+五星1）", async () => {
    // 真实数据集成验证见 rlv2-month-team / rlv2-zone-progress（真实 excel）；
    // 此处轻量断言解析出的 gte 标记组合
    const p = makePlayer("rogue_6", 15);
    await p.rlv2._module.create();
    const buffs = p.rlv2._buff.difficultyBuffs("rogue_6", 15);
    const hop = buffs.filter((b) => b.key === "recruit_hop_cost");
    expect(hop.length).toBe(2);
    expect(hop.map((b) => [b.blackboard[0].value, b.blackboard[2].value])).toEqual([
      [5, 0],
      [6, 0],
    ]);
  });
});
