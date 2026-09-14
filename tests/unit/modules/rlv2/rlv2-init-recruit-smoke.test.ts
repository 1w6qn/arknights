import { describe, it, expect, vi } from "vitest";
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
          init: [{ modeGrade: 15, predefinedId: null, modeId: "NORMAL", initialRecruitGroup: ["recruit_group_1"], initialBandRelic: ["rogue_6_band_1"] }],
          stages: { ro6_n_1_1: { id: "ro6_n_1_1" }, ro6_n_1_2: { id: "ro6_n_1_2" } },
          recruitTickets: {
            rogue_6_recruit_ticket_pioneer: { id: "rogue_6_recruit_ticket_pioneer", professionList: ["PIONEER"], rarityList: ["TIER_3", "TIER_4", "TIER_5"] },
            rogue_6_recruit_ticket_sniper: { id: "rogue_6_recruit_ticket_sniper", professionList: ["SNIPER"], rarityList: ["TIER_3", "TIER_4", "TIER_5"] },
            rogue_6_recruit_ticket_special: { id: "rogue_6_recruit_ticket_special", professionList: ["SPECIAL"], rarityList: ["TIER_3", "TIER_4", "TIER_5"] },
            rogue_6_recruit_ticket_support: { id: "rogue_6_recruit_ticket_support", professionList: ["SUPPORT"], rarityList: ["TIER_3", "TIER_4", "TIER_5"] },
            rogue_6_recruit_ticket_medic: { id: "rogue_6_recruit_ticket_medic", professionList: ["MEDIC"], rarityList: ["TIER_3", "TIER_4", "TIER_5"] },
            rogue_6_recruit_ticket_caster: { id: "rogue_6_recruit_ticket_caster", professionList: ["CASTER"], rarityList: ["TIER_3", "TIER_4", "TIER_5"] },
            rogue_6_recruit_ticket_warrior: { id: "rogue_6_recruit_ticket_warrior", professionList: ["WARRIOR"], rarityList: ["TIER_3", "TIER_4", "TIER_5"] },
            rogue_6_recruit_ticket_tank: { id: "rogue_6_recruit_ticket_tank", professionList: ["TANK"], rarityList: ["TIER_3", "TIER_4", "TIER_5"] },
          },
          recruitGrps: {
            recruit_group_1: { id: "recruit_group_1", name: "先手必胜", desc: "先锋、狙击、特种招募券各一张" },
          },
          choices: { choice_x: { id: "choice_x", nextSceneId: null, type: "LEAVE" } },
          items: {
            rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: "NONE" },
            rogue_6_band_1: { id: "rogue_6_band_1", type: "BAND", rarity: "BORN" },
          },
          relics: {
            rogue_6_band_1: { id: "rogue_6_band_1", buffs: [{ key: "level_life_point_add", blackboard: [{ key: "value", value: 2 }] }] },
          },
          bandRef: { rogue_6_band_1: { itemID: "rogue_6_band_1", bandLevel: 0, normalBandId: "rogue_6_band_1" } },
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
      },
      modules: { rogue_6: { moduleTypes: [] } },
      consts: {},
    },
    CharacterTable: {
      char_1001_amiya2: { charId: "char_1001_amiya2", rarity: "TIER_5", profession: "CASTER", name: "阿米娅" },
      char_1013_chen: { charId: "char_1013_chen", rarity: "TIER_5", profession: "MEDIC", name: "夜莺" },
      char_1014_nearl: { charId: "char_1014_nearl", rarity: "TIER_5", profession: "SUPPORT", name: "白面鸮" },
      char_1015_ebnholz: { charId: "char_1015_ebnholz", rarity: "TIER_5", profession: "WARRIOR", name: "近卫" },
      char_1016_skalter: { charId: "char_1016_skalter", rarity: "TIER_5", profession: "TANK", name: "重装" },
      char_1012_skadi: { charId: "char_1012_skadi", rarity: "TIER_6", profession: "PIONEER", name: "斯卡蒂" },
      char_1024_swire: { charId: "char_1024_swire", rarity: "TIER_5", profession: "PIONEER", name: "苇草" },
      char_1039_thorn2: { charId: "char_1039_thorn2", rarity: "TIER_6", profession: "SNIPER", name: "鸿雪" },
      char_1063_vigil: { charId: "char_1063_vigil", rarity: "TIER_5", profession: "SPECIAL", name: "海蒂" },
    } as Record<string, ExcelCharRowMock>,
    GameDataConst: { maxLevel: [[], [], [], [], [], []] },
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/** GAME_INIT_* 事件载荷（step 进度；GAME_INIT_SUPPORT 另有 id 字段，本文件不提供） */
interface InitEventArgs {
  step: number[];
}

function makePlayer() {
  const pd = mockPlayerData({
    rlv2: { outer: { rogue_6: {} }, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
    troop: {
      chars: {
        1: { charId: "char_1012_skadi" },
        2: { charId: "char_1024_swire" },
        3: { charId: "char_1039_thorn2" },
        4: { charId: "char_1063_vigil" },
        5: { charId: "char_1001_amiya2" },
        6: { charId: "char_1013_chen" },
        7: { charId: "char_1014_nearl" },
        8: { charId: "char_1015_ebnholz" },
        9: { charId: "char_1016_skalter" },
      },
    },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefined: null });
  return player;
}

/** 走完整开局：用官方事件工厂构造 GAME_INIT 链（relic/gift/support/recruit_set/recruit） */
async function runInitFlow(player: PlayerDataManager) {
  await player.rlv2._status._pending.init();
  const trigger = player.rlv2._trigger;
  const emit = (type: string, args: InitEventArgs) => trigger.emit("rlv2:event:create", [type, args]);
  await emit("GAME_INIT_RELIC", { step: [1, 5] });
  await emit("GAME_INIT_GIFT", { step: [2, 5] });
  await emit("GAME_INIT_SUPPORT", { step: [3, 5] });
  await emit("GAME_INIT_RECRUIT_SET", { step: [4, 5] });
  await emit("GAME_INIT_RECRUIT", { step: [5, 5] });
}

describe("初始招募流程（GAME_INIT_RECRUIT）", () => {
  it("chooseInitialRecruitSet 后 tickets 非空，activeRecruitTicket 生成 RECRUIT 事件", async () => {
    // 固定 Math.random：chooseInitialRecruitSet 洗牌取前 3 张票、active 候选稳定（避免跨文件 random 抖动）
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.1);
    try {
    const player = makePlayer();
    await runInitFlow(player);
    const events = player.rlv2._status._pending;
    // 消费 RELIC
    await player.rlv2.chooseInitialRelic({ select: "0" });
    // 消费 GIFT
    await player.rlv2.finishEvent();
    // 消费 SUPPORT（selectChoice）
    await player.rlv2.selectChoice({ choice: "choice_x" });
    // 消费 RECRUIT_SET
    await player.rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = events._pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    expect(recruitEvt!.content.initRecruit!.tickets.length).toBeGreaterThan(0);
    const ticketIndex = recruitEvt!.content.initRecruit!.tickets[0];
    // activeRecruitTicket → 应生成 RECRUIT pending 事件（客户端招募 UI）
    await player.rlv2.activeRecruitTicket({ id: ticketIndex });
    const recEvent = events._pending.find((e) => e.type === "RECRUIT");
    expect(recEvent, "activeRecruitTicket 应创建 RECRUIT 事件").toBeTruthy();
    expect(recEvent!.content.recruit!.ticket).toBe(ticketIndex);
    // 候选列表非空（主队伍干员 + 票职业匹配）
    const ticket = player.rlv2.inventory!.recruit[ticketIndex];
    expect(ticket.list.length).toBeGreaterThan(0);
    } finally {
      rand.mockRestore();
    }
  });

  it("3 张票逐张招募后 finishEvent 应进入 WAIT_MOVE", async () => {
    const player = makePlayer();
    await runInitFlow(player);
    const events = player.rlv2._status._pending;
    await player.rlv2.chooseInitialRelic({ select: "0" });
    await player.rlv2.finishEvent();
    await player.rlv2.selectChoice({ choice: "choice_x" });
    await player.rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = events._pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const tickets = [...recruitEvt!.content.initRecruit!.tickets];
    // 逐张激活 + 招募
    for (const t of tickets) {
      await player.rlv2.activeRecruitTicket({ id: t });
      const ticket = player.rlv2.inventory!.recruit[t];
      // 若该票候选为空则跳过（模拟客户端换票），否则招募
      if (ticket.list.length > 0) {
        await player.rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
      }
    }
    // 消费 GAME_INIT_RECRUIT → 进入 WAIT_MOVE
    await player.rlv2.finishEvent();
    const state = player.rlv2._status.state;
    expect(state).toBe("WAIT_MOVE");
    expect(player.rlv2._status.cursor.zone).toBe(1);
  });

  it("开局进入第一层后，已招募干员保留在 inventory.recruit（未招募票被清理）", async () => {
    const player = makePlayer();
    await runInitFlow(player);
    const events = player.rlv2._status._pending;
    await player.rlv2.chooseInitialRelic({ select: "0" });
    await player.rlv2.finishEvent();
    await player.rlv2.selectChoice({ choice: "choice_x" });
    await player.rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = events._pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    const tickets = [...recruitEvt!.content.initRecruit!.tickets];
    // 只招募第一张票，其余保持未招募状态
    const first = tickets[0];
    await player.rlv2.activeRecruitTicket({ id: first });
    const firstTicket = player.rlv2.inventory!.recruit[first];
    if (firstTicket.list.length > 0) {
      await player.rlv2.recruitChar({ ticketIndex: first, optionId: String(firstTicket.list[0].instId) });
    }
    // 进入 WAIT_MOVE
    await player.rlv2.finishEvent();
    const recruit = player.rlv2.inventory!.recruit;
    // 已招募票保留（state=2 且 result 非空）
    if (firstTicket.list.length > 0) {
      expect(recruit[first]?.state).toBe(2);
      expect(recruit[first]?.result).toBeTruthy();
    }
    // 未招募票（剩余第一张之外的）被清理
    for (const t of tickets.slice(1)) {
      expect(recruit[t]).toBeUndefined();
    }
  });
});
