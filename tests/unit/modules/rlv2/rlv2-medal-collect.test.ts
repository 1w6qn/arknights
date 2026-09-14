import { describe, it, expect, vi } from "vitest";

/**
 * 肉鸽局外收藏 → 勋章事件（Round 33）
 *
 * 官服勋章 unlockParam = [主题, 目标数]：
 * - Rlv2CollectRelic「拟造物质编目已持有 N 个收藏品」← collect.relic 中 state ≥ 2 的条目数
 * - Rlv2UnlockBand「解锁 N 个分队」← collect.band 中 state ≥ 1 的条目数
 * 载荷为当前累计值（非增量），模板取 max —— 幂等。
 */
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
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,
    RoguelikeTopicTable: { details: {}, modules: {}, consts: {} },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: {},
  },
}));

import excel from "@excel/excel";
import type { RoguelikeTopicDetail } from "@excel/types_excel_gen";
import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { EventMap } from "@game/kernel/events";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import { asModel, mockPlayerData, type MockSeed } from "../../../helpers";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/** 局外收藏夹具种子（生成模型 `OuterData.collect` 的深可选视图） */
type OuterCollectSeed = MockSeed<PlayerDataModel["rlv2"]["outer"][string]["collect"]>;

function makePlayer(collect: OuterCollectSeed) {
  const pd = mockPlayerData({
    pushFlags: { status: 0 },
    rlv2: { outer: { rogue_4: { collect } }, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme: "rogue_4", mode: "NORMAL", modeGrade: 0, predefined: null, start: 1,
  });
  return player;
}

describe("RoguelikeV2Manager.emitOuterProgressionMedals（局外进度 → 勋章）", () => {
  it("按 collect.relic(state≥2) / collect.band(state≥1) 计数并派发（含主题）", async () => {
    const player = makePlayer({
      relic: {
        r1: { state: 2 }, r2: { state: 2 }, r3: { state: 1 }, // state 1 未获得 → 不计
      },
      band: { band_1: { state: 1 }, band_2: { state: 1 }, band_3: { state: 0 } },
      endBook: { ro4_ending_1: { state: 2 }, ro4_ending_2: { state: 2 } },
    });
    const emit = vi.spyOn(player._trigger, "emit");
    await player.rlv2.emitOuterProgressionMedals("rogue_4");
    const relicCall = emit.mock.calls.find(
      (c): c is ["Rlv2CollectRelic", EventMap["Rlv2CollectRelic"]] =>
        c[0] === "Rlv2CollectRelic",
    )!;
    const bandCall = emit.mock.calls.find(
      (c): c is ["Rlv2UnlockBand", EventMap["Rlv2UnlockBand"]] =>
        c[0] === "Rlv2UnlockBand",
    )!;
    const endingCall = emit.mock.calls.find(
      (c): c is ["Rlv2EndingCollect", EventMap["Rlv2EndingCollect"]] =>
        c[0] === "Rlv2EndingCollect",
    )!;
    expect(relicCall[1][0]).toEqual({ theme: "rogue_4", count: 2 });
    expect(bandCall[1][0]).toEqual({ theme: "rogue_4", count: 2 });
    // 结局图鉴条目数（「达成 N 种结局」）
    expect(endingCall[1][0]).toEqual({ theme: "rogue_4", count: 2 });
  });

  it("resolveBpLevel：按官方 milestones 门槛换算源流堆栈等级", () => {
    const player = makePlayer({ relic: {}, band: {} });
    excel.RoguelikeTopicTable.details.rogue_4 = asModel<RoguelikeTopicDetail>({
      milestones: [
        { level: 1, tokenNum: 0 },
        { level: 2, tokenNum: 100 },
        { level: 65, tokenNum: 19000 },
      ],
    });
    const rlv2 = player.rlv2;
    expect(rlv2.resolveBpLevel("rogue_4", 0)).toBe(1);
    expect(rlv2.resolveBpLevel("rogue_4", 99)).toBe(1);
    expect(rlv2.resolveBpLevel("rogue_4", 100)).toBe(2);
    expect(rlv2.resolveBpLevel("rogue_4", 99999)).toBe(65);
    expect(rlv2.resolveBpLevel("rogue_9", 99999)).toBe(0); // 无该主题 → 0
    delete excel.RoguelikeTopicTable.details.rogue_4;
  });

  it("源流样本累计时派发 Rlv2BpLevel（等级来自 bp.point 换算）", async () => {
    const player = makePlayer({ relic: {}, band: {} });
    excel.RoguelikeTopicTable.details.rogue_4 = asModel<RoguelikeTopicDetail>({
      milestones: [
        { level: 1, tokenNum: 0 },
        { level: 7, tokenNum: 500 },
      ],
    });
    player._playerdata.rlv2.outer.rogue_4.bp = { point: 600, reward: {} };
    const emit = vi.spyOn(player._trigger, "emit");
    await player.rlv2.emitOuterProgressionMedals("rogue_4");
    const call = emit.mock.calls.find(
      (c): c is ["Rlv2BpLevel", EventMap["Rlv2BpLevel"]] =>
        c[0] === "Rlv2BpLevel",
    )!;
    expect(call[1][0]).toEqual({ theme: "rogue_4", level: 7 });
    delete excel.RoguelikeTopicTable.details.rogue_4;
  });

  it("空收藏 / 无该主题 时派发 0（不抛错）", async () => {
    const player = makePlayer({ relic: {}, band: {} });
    const emit = vi.spyOn(player._trigger, "emit");
    await player.rlv2.emitOuterProgressionMedals("rogue_4");
    expect(
      emit.mock.calls.find(
        (c): c is ["Rlv2CollectRelic", EventMap["Rlv2CollectRelic"]] =>
          c[0] === "Rlv2CollectRelic",
      )![1][0].count,
    ).toBe(0);
    emit.mockClear();
    await player.rlv2.emitOuterProgressionMedals("rogue_9");
    expect(emit).not.toHaveBeenCalled();
  });
});
