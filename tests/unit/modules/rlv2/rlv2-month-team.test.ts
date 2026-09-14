import { describe, it, expect, vi } from "vitest";
import { buildRoguelikeConsts } from "@game/excel/roguelike_consts_gen";
/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }

// ===== 实践者列表（MONTH_TEAM）模式修复回归 =====
// 用户 bug：MONTH_TEAM 开局血/血上限 0、希望 7、recruitChar 意外临时招募、finishEvent 后卡死。
// 根因：createGame 把 MONTH_TEAM 强制转 NORMAL 但保留 predefinedId（month_team_N）→
// status.create/initConfig 的 init.find（modeId==NORMAL && predefinedId==month_team_N）无匹配
// → status.create 抛错（血 0/0）、events.create 部分失败（pending 缺 RELIC/RECRUIT_SET）
// → 客户端开局流程错乱、后续卡死。
// 修复：createGame 保留 MONTH_TEAM mode（init 表有 month_team_1/2 专属条目），
// 仅 CHALLENGE 转 NORMAL（无专属 init 条目）；recruit_group_m1/m2"支援作战"= 2 张随机招募券。

// 用真实 excel 数据（避免 mock 与官方 init 表结构偏差掩盖/伪造 bug）
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
import { mockPlayerData } from "../../../helpers";

/** rlv2 组合根替身类型（真实 `PlayerDataManager.rlv2`） */
type Rlv2Manager = PlayerDataManager["rlv2"];

/**
 * 旧存档兼容 record 夹具视图
 *
 * `record.lastZone` 是私服历史自定义字段（官服 record 无此键，见
 * app/game/modules/roguelike/game-init.ts 的注释与 event.ts 的 `OuterRecordLegacy`）；
 * 生成模型与 rlv2 本地模型均未声明该键，而夹具沿用（其真值被 game-init.ts / event.ts
 * 的旧存档兼容分支读取）。仅额外声明该键，其余字段仍受真实 record 模型校验。
 */
interface LegacyRecordFixture {
  last: number;
  lastZone?: number;
  legacy?: string[];
  stageCnt: { [key: string]: number };
  bandCnt: { [key: string]: { [key: string]: number } };
  bandGrade: { [key: string]: { [key: string]: number } };
}

/** 构造旧存档兼容的 record 夹具（见 {@link LegacyRecordFixture}） */
function legacyRecord(record: LegacyRecordFixture): LegacyRecordFixture {
  return record;
}

/**
 * 干员盒条目夹具视图
 *
 * `rarity` 是历史夹具扩展键（真实 `PlayerCharacter` 不含该字段——干员稀有度由 excel
 * `CharacterTable` 提供，rlv2 只读 `troop.chars` 的键与 `instId`）；夹具沿用该键，
 * 故仅额外声明，其余字段仍受真实模型校验。
 */
interface TroopCharFixture {
  charId: string;
  instId: number;
  rarity: string;
}

/** 干员盒夹具（见 {@link TroopCharFixture}） */
const troopChars: Record<string, TroopCharFixture> = {
  1: { charId: "char_002_amiya", instId: 1, rarity: "TIER_5" },
  2: { charId: "char_010_chen", instId: 2, rarity: "TIER_6" },
  3: { charId: "char_124_kroos", instId: 3, rarity: "TIER_3" },
  4: { charId: "char_1039_thorn2", instId: 4, rarity: "TIER_6" },
  5: { charId: "char_017_huang", instId: 5, rarity: "TIER_6" },
  6: { charId: "char_102_texas", instId: 6, rarity: "TIER_5" },
  7: { charId: "char_129_bluep", instId: 7, rarity: "TIER_5" },
  8: { charId: "char_148_nearl", instId: 8, rarity: "TIER_5" },
  9: { charId: "char_144_red", instId: 9, rarity: "TIER_5" },
  10: { charId: "char_242_otter", instId: 10, rarity: "TIER_5" },
};

/**
 * 场景事件载荷的选择项读取视图
 *
 * 真实载荷 `choices` 位于 `content.initSupport.scene.choices`（见
 * app/game/modules/roguelike/events.ts 的 GAME_INIT_SUPPORT builder，返回
 * `{ initSupport: { step, scene: { id, choices } } }`）；生成模型
 * `PlayerRoguelikePendingEvent.Content` 未声明顶层 `choices`。`consumeGiftAndSupport`
 * 沿用历史写法读 `content.choices`（恒 undefined，`|| {}` 兜底后 `choiceId` 为
 * undefined，由 selectChoice 的消费分支承受）。为不改运行期行为，仅就地声明该键的读取视图。
 */
interface ContentWithChoices {
  choices?: { [key: string]: number };
}

function makePlayer() {
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: {
        rogue_6: {
          record: legacyRecord({ last: 0, lastZone: 3, legacy: [], stageCnt: {}, bandCnt: {}, bandGrade: {} }),
          collect: { band: {} },
          buff: { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0 },
        },
      },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
    troop: { chars: troopChars },
  });
  const player = new PlayerDataManager(pd._playerdata);
  return player;
}

/** 消费 GIFT（finishEvent）+ SUPPORT（selectChoice 首个选项） */
async function consumeGiftAndSupport(rlv2: Rlv2Manager) {
  await rlv2.finishEvent(); // GAME_INIT_GIFT
  const s = rlv2._status;
  const sup = s.pending.find((e) => e.type === "GAME_INIT_SUPPORT");
  if (sup) {
    const choiceId = Object.keys((sup.content as ContentWithChoices).choices || {})[0];
    await rlv2.selectChoice({ choice: choiceId });
  }
}

describe("实践者列表（MONTH_TEAM）模式", () => {
  it("createGame 不崩：血 8/8、希望 6、pending 完整 5 事件", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    // 该局携带襁褓（猫+狗）→ 应有 GAME_INIT_GIFT
    rlv2.outer.rogue_6.record.legacy = ["rogue_6_legacy_01", "rogue_6_legacy_02"];
    await rlv2.createGame({ theme: "rogue_6", mode: "MONTH_TEAM", modeGrade: 0, predefinedId: "month_team_1" });
    const s = rlv2._status;
    expect(s.property.hp.current).toBe(8);
    expect(s.property.hp.max).toBe(8);
    expect(s.property.population.max).toBe(6);
    // pending 完整（修复前缺 GAME_INIT_RELIC / GAME_INIT_RECRUIT_SET）
    const types = s.pending.map((e) => e.type);
    expect(types).toContain("GAME_INIT_RELIC");
    expect(types).toContain("GAME_INIT_GIFT");
    expect(types).toContain("GAME_INIT_RECRUIT_SET");
    expect(types).toContain("GAME_INIT_RECRUIT");
    // 招募组为实践者专属（支援作战 m1）
    expect(rlv2.initConfig.initialRecruitGroup).toContain("recruit_group_m1");
  });

  it("无襁褓 legacy → 不生成 GAME_INIT_GIFT（开局礼物由上一把藏品动态触发）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    const types = rlv2._status.pending.map((e) => e.type);
    expect(types).not.toContain("GAME_INIT_GIFT");
    // 无礼物 → 希望保持 6
    expect(rlv2._status.property.population.max).toBe(6);
  });

  it("开局礼物内容 = init_gift buff 累加（襁褓猫+狗 → 金+5/希望+1）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    // lastZone=0：无行动奖励（SUPPORT），干净验证 GIFT 发放（finishEvent 循环不会代选 SUPPORT）
    rlv2.outer.rogue_6.record = legacyRecord({
      last: 0, lastZone: 0,
      legacy: ["rogue_6_legacy_01", "rogue_6_legacy_02"],
      stageCnt: {}, bandCnt: {}, bandGrade: {},
    });
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    const gift = rlv2._status.pending.find((e) => e.type === "GAME_INIT_GIFT");
    expect(gift).toBeTruthy();
    expect(gift!.content.initGift!.items).toEqual([
      { id: "rogue_6_gold", count: 5 },
      { id: "rogue_6_population", count: 1 },
    ]);
    // finishEvent 消费 GIFT → 金 8+5、希望 6+1（无双发）；先消费 RELIC（pending[0]）
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.finishEvent();
    expect(rlv2._status.property.gold).toBe(13);
    expect(rlv2._status.property.population.max).toBe(7);
  });

  it("完整开局流程不卡死：2 张支援作战票招募后 finishEvent 进入 WAIT_MOVE", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await rlv2.createGame({ theme: "rogue_6", mode: "MONTH_TEAM", modeGrade: 0, predefinedId: "month_team_1" });
      await rlv2.chooseInitialRelic({ select: "0" });
      await consumeGiftAndSupport(rlv2);
      await rlv2.chooseInitialRecruitSet({ select: "recruit_group_m1" });
      const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
      const tickets = recruitEvt?.content?.initRecruit?.tickets || [];
      // 支援作战：2 张随机招募券
      expect(tickets.length).toBe(2);
      for (const t of tickets) {
        await rlv2.activeRecruitTicket({ id: t });
        const ticket = rlv2.inventory!.recruit[t];
        // 候选非空（真实干员库），招募结果为 NORMAL（非意外临时）
        expect(ticket.list.length).toBeGreaterThan(0);
        const res = await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
        expect(res[0]?.type).toBe("NORMAL");
        // 票保留（state=2 终态）；inventory.recruit 由 finishEvent 统一清空
        expect(rlv2.inventory!.recruit[t].state).toBe(2);
      }
      // 消费 GAME_INIT_RECRUIT → 进入第一层
      await rlv2.finishEvent();
      expect(rlv2._status.state).toBe("WAIT_MOVE");
      expect(rlv2._status.cursor.zone).toBe(1);
      // 与官服一致：进入第一层后 pending 为空（无残留 RECRUIT——否则客户端报"系统发生未知故障"）
      expect(rlv2._status.pending.length).toBe(0);
    } finally {
      rand.mockRestore();
    }
  });

  it("recruitChar 消费对应 RECRUIT 事件（残留会导致客户端未知故障）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
      await rlv2.chooseInitialRelic({ select: "0" });
      await consumeGiftAndSupport(rlv2);
      await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
      const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
      const tickets = recruitEvt?.content?.initRecruit?.tickets || [];
      for (const t of tickets) {
        await rlv2.activeRecruitTicket({ id: t });
        const evBefore = rlv2._status.pending.filter(
          (e) => e.type === "RECRUIT" && e.content?.recruit?.ticket === t,
        );
        expect(evBefore.length).toBe(1);
        const ticket = rlv2.inventory!.recruit[t];
        if (ticket.list.length > 0) {
          await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
          // 招募后对应 RECRUIT 事件被消费
          const evAfter = rlv2._status.pending.filter(
            (e) => e.type === "RECRUIT" && e.content?.recruit?.ticket === t,
          );
          expect(evAfter.length).toBe(0);
        }
      }
      // 放弃/空票残留场景：finishEvent 也应清空初始 RECRUIT（防御）
      await rlv2.finishEvent();
      expect(rlv2._status.state).toBe("WAIT_MOVE");
      expect(rlv2._status.pending.filter((e) => e.type === "RECRUIT").length).toBe(0);
    } finally {
      rand.mockRestore();
    }
  });

  it("recruit_group_m2 同样 2 张随机票", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await rlv2.createGame({ theme: "rogue_6", mode: "MONTH_TEAM", modeGrade: 0, predefinedId: "month_team_2" });
      await rlv2.chooseInitialRelic({ select: "0" });
      await consumeGiftAndSupport(rlv2);
      await rlv2.chooseInitialRecruitSet({ select: "recruit_group_m2" });
      const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
      expect(recruitEvt?.content?.initRecruit?.tickets?.length).toBe(2);
    } finally {
      rand.mockRestore();
    }
  });

  it("CHALLENGE 模式保持转 NORMAL（无专属 init 条目）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "CHALLENGE", modeGrade: 0, predefinedId: null });
    expect(rlv2.current.game!.mode).toBe("NORMAL");
    const s = rlv2._status;
    expect(s.property.hp.max).toBe(8); // NORMAL grade 0 初始血
  });
});

describe("finishEvent 初始阶段消费（官服语义：每次一个事件，专用接口消费其余）", () => {
  it("官服标准序列：Relic → GIFT(finishEvent) → SUPPORT(selectChoice) → RecruitSet → 招募 → finishEvent 进入 WAIT_MOVE", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    // 上一把到 3 层（SUPPORT）+ 遗留襁褓猫狗（GIFT）——
    // support 判定按官服：stageCnt 存在 3 层关卡记录
    rlv2.outer.rogue_6.record = legacyRecord({
      last: 0, lastZone: 3,
      legacy: ["rogue_6_legacy_01", "rogue_6_legacy_01_1", "rogue_6_legacy_02"],
      stageCnt: { ro6_n_3_1: 1 }, bandCnt: {}, bandGrade: {},
    });
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
      const types = rlv2._status.pending.map((e) => e.type);
      expect(types).toContain("GAME_INIT_GIFT");
      expect(types).toContain("GAME_INIT_SUPPORT");
      // 官服标准序列：Relic → GIFT(finishEvent) → SUPPORT(selectChoice) → RecruitSet → 招募 → finishEvent
      await rlv2.chooseInitialRelic({ select: "0" });
      await rlv2.finishEvent(); // GIFT
      const sup = rlv2._status.pending.find((e) => e.type === "GAME_INIT_SUPPORT");
      if (sup) {
        const choiceId = Object.keys(sup!.content.initSupport!.scene.choices)[0];
        await rlv2.selectChoice({ choice: choiceId });
      }
      await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
      const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
      for (const t of recruitEvt?.content?.initRecruit?.tickets || []) {
        await rlv2.activeRecruitTicket({ id: t });
        const ticket = rlv2.inventory!.recruit[t];
        if (ticket.list.length > 0) {
          await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
        }
      }
      await rlv2.finishEvent(); // 消费 RECRUIT → 进入第一层
      expect(rlv2._status.state).toBe("WAIT_MOVE");
      expect(rlv2._status.cursor.zone).toBe(1);
      // GIFT 礼物已发放（襁褓猫×2 → 金+10）
      expect(rlv2._status.property.gold).toBeGreaterThanOrEqual(8 + 10);
    } finally {
      rand.mockRestore();
    }
  });

  it("已 selectChoice 消费 SUPPORT：finishEvent 不重复代选", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    rlv2.outer.rogue_6.record = legacyRecord({
      last: 0, lastZone: 3, legacy: ["rogue_6_legacy_01"],
      stageCnt: { ro6_n_3_1: 1 }, bandCnt: {}, bandGrade: {},
    });
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
      await rlv2.chooseInitialRelic({ select: "0" });
      // 正常流程：selectChoice（SUPPORT，其内部先消费 GIFT）→ RecruitSet → 招募 → finishEvent
      const sup = rlv2._status.pending.find((e) => e.type === "GAME_INIT_SUPPORT");
      const choiceId = Object.keys(sup!.content.initSupport!.scene.choices)[0];
      await rlv2.selectChoice({ choice: choiceId });
      await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
      const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
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
      expect(rlv2._status.pending.length).toBe(0);
    } finally {
      rand.mockRestore();
    }
  });
});

describe("recruitChar 重复调用容错（客户端会对同一票发两次）", () => {
  it("第二次 recruitChar 返回空数组，不抛错（票已删）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const tickets = recruitEvt?.content?.initRecruit?.tickets || [];
    expect(tickets.length).toBeGreaterThan(0);
    const t = tickets[0];
    await rlv2.activeRecruitTicket({ id: t });
    const ticket = rlv2.inventory!.recruit[t];
    const opt = String(ticket.list[0].instId);
    // 第一次招募成功
    const r1 = await rlv2.recruitChar({ ticketIndex: t, optionId: opt });
    expect(r1.length).toBe(1);
    // 票保留（state=2 终态）——删票会导致客户端重复调用收到 [] 卡死
    expect(rlv2.inventory!.recruit[t]).toBeDefined();
    expect(rlv2.inventory!.recruit[t].state).toBe(2);
    // 第二次（客户端重复调用同一票）：不抛错、返回同样的 result（官服幂等）
    const r2 = await rlv2.recruitChar({ ticketIndex: t, optionId: opt });
    expect(r2.length).toBe(1);
    expect(r2[0].charId).toBe(r1[0].charId);
  });

  it("done 幂等：票 state=2 时重复 done 不重复扣希望", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const t = (recruitEvt?.content?.initRecruit?.tickets || [])[0];
    await rlv2.activeRecruitTicket({ id: t });
    const ticket = rlv2.inventory!.recruit[t];
    const opt = String(ticket.list[0].instId);
    const costBefore = rlv2._status.property.population.cost;
    await rlv2.recruitChar({ ticketIndex: t, optionId: opt });
    const costAfter1 = rlv2._status.property.population.cost;
    // 第一次招募扣希望（cost 增加；4星干员 population=0 则不扣）
    expect(costAfter1).toBeGreaterThanOrEqual(costBefore);
    // 直接再 emit done（模拟重复）——state=2 幂等返回，不重复扣
    await rlv2._trigger.emit("rlv2:recruit:done", [t, opt]);
    expect(rlv2._status.property.population.cost).toBe(costAfter1);
  });

  it("不同 optionId 重复调用（客户端 30→22 序列）：幂等返回首次 result，不重复扣希望", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const t = (recruitEvt?.content?.initRecruit?.tickets || [])[0];
    await rlv2.activeRecruitTicket({ id: t });
    const ticket = rlv2.inventory!.recruit[t];
    expect(ticket.list.length).toBeGreaterThan(0);
    const opt1 = String(ticket.list[0].instId);
    // 第二个不同的 optionId（done 幂等按 state 判定，不看 optionId 值）
    const opt2 = String(Number(opt1) + 9999);
    const costBefore = rlv2._status.property.population.cost;
    const r1 = await rlv2.recruitChar({ ticketIndex: t, optionId: opt1 });
    const costAfter1 = rlv2._status.property.population.cost;
    // 第二次不同 optionId：幂等返回首次 result（非空，客户端不卡），不重复扣希望
    const r2 = await rlv2.recruitChar({ ticketIndex: t, optionId: opt2 });
    expect(r2.length).toBe(1);
    expect(r2[0].charId).toBe(r1[0].charId);
    expect(rlv2._status.property.population.cost).toBe(costAfter1);
    expect(costAfter1).toBeGreaterThanOrEqual(costBefore);
  });

  it("close=放弃：放弃后不可招募（state=3 拒绝 recruitChar，不复活）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const t = (recruitEvt?.content?.initRecruit?.tickets || [])[0];
    await rlv2.activeRecruitTicket({ id: t });
    const opt = String(rlv2.inventory!.recruit[t].list[0].instId);
    // 放弃（close）
    await rlv2.closeRecruitTicket({ id: t });
    expect(rlv2.inventory!.recruit[t].state).toBe(3);
    // 放弃后 recruitChar：不可招募（返回空，票保持 state=3 不复活、不入队）
    const troopBefore = Object.keys(rlv2._player._playerdata.troop.chars || {}).length;
    const r = await rlv2.recruitChar({ ticketIndex: t, optionId: opt });
    expect(r).toEqual([]);
    expect(rlv2.inventory!.recruit[t].state).toBe(3);
    expect(Object.keys(rlv2._player._playerdata.troop.chars || {}).length).toBe(troopBefore);
  });
});
