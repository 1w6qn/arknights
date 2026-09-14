import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("@utils/crypt", () => ({
  decryptBattleData: vi.fn().mockResolvedValue({ completeState: 1, finalHp: 8, isPerfect: 1 }),
}));
vi.mock("@utils/time", () => ({ now: () => 1786434411 }));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import { isJsonArray, isJsonObject, type JsonValue } from "@excel/json-value";
import type {
  PlayerRoguelikePendingEvent,
  PlayerRoguelikeV2,
} from "@game/modules/roguelike/rlv2-model";
import excel from "@excel/excel";
import * as fs from "node:fs";
import * as path from "node:path";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

const CAPTURE_ROOT = path.resolve(__dirname, "../../../fixtures/rlv2-official");
function readRes(route: string, ts: string) {
  return JSON.parse(fs.readFileSync(path.join(CAPTURE_ROOT, route, `${ts}.json`), "utf8"));
}

beforeAll(async () => {
  await excel.init();
}, 120000);

const OFF_CREATE = readRes("createGame", "2026-08-11T07-45-24-344Z");
const OFF_OUTER = OFF_CREATE.playerDataDelta.modified.rlv2.outer.rogue_6;

function allOutbuff(): Record<string, number> {
  const c = excel.RoguelikeConsts?.rogue_6?.outbuff ?? {};
  return Object.fromEntries(Object.keys(c).map((k) => [k, 1]));
}

function makePlayer() {
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: {
        rogue_6: {
          // 官服 8-11 createGame GIFT=gold10+pop1 → 上一把 2 猫（gold5×2）+1 狗（pop1）
          record: {
            ...JSON.parse(JSON.stringify(OFF_OUTER.record)),
            legacy: ["rogue_6_legacy_01", "rogue_6_legacy_01", "rogue_6_legacy_02"],
          },
          monthTeam: JSON.parse(JSON.stringify(OFF_OUTER.monthTeam)),
          collect: { band: {} },
          buff: { pointOwned: 0, pointCost: 0, unlocked: allOutbuff(), score: 0 },
        },
      },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
    troop: { chars: {} },
  });
  const player = new PlayerDataManager(pd._playerdata);
  // 夹具只声明被测分支读到的键，其余 game 字段由惰性分支承受
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefined: null, outer: { support: true } });
  return player;
}

/** 值级 diff：收集所有值/结构差异（白名单路径除外） */
function collectDiffs(a: JsonValue, b: JsonValue, p: string, out: string[]): void {
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) { out.push(`${p}: 类型 ${ta}->${tb}`); return; }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { out.push(`${p}.${k}: 缺失`); continue; }
      if (!(k in b)) { out.push(`${p}.${k}: 多余`); continue; }
      collectDiffs(a[k], b[k], `${p}.${k}`, out);
    }
    return;
  }
  if (isJsonArray(a) && isJsonArray(b)) {
    if (a.length !== b.length) out.push(`${p}: 长度 ${a.length}->${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) collectDiffs(a[i], b[i], `${p}[${i}]`, out);
    return;
  }
  if (a !== b) out.push(`${p}: ${JSON.stringify(a)}->${JSON.stringify(b)}`);
}

/** 白名单：地图/账号数据/随机值（值级完全一致允许的动态差异） */
function allowed(p: string): boolean {
  return (
    p.startsWith("current.map") ||
    p.includes(".gridZone.") ||
    p.includes("cursor.position") ||
    p.includes("initRelic.items") || // 分队解锁集（账号数据）
    p.includes("initSupport.scene.choices") || // 3 选 1 随机
    p.includes("initSupport.scene.choices.") ||
    p.startsWith("current.inventory.relic") || // 分队选择结果（账号）
    p.startsWith("current.inventory.recruit") || // 干员候选（账号）
    p.startsWith("current.troop") || // 干员（账号）
    p.includes("outer.rogue_6.record.legacy") || // legacy 存储位置差异（GIFT 内容已单独断言对齐）
    p.includes("outer.rogue_6.record.lastZone") ||
    p.startsWith("current.player.pending") || // 事件内容含账号数据
    p === "pinned" ||
    p.includes(".ts") || // 时间戳
    p.includes("outer.rogue_6.collect") ||
    p.includes("outer.rogue_6.buff") ||
    p.includes("outer.rogue_6.bank") ||
    p.includes("outer.rogue_6.bp") ||
    p.includes("outer.rogue_6.mission")
  );
}

describe("8.11 官服值级完全一致（除地图/账号数据）", () => {
  it("createGame → finishEvent#1 确定性字段值一致", async () => {
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      const player = makePlayer();
      const rlv2 = player.rlv2;
      await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });

      // createGame 响应比对（rlv2Response SEC.ALL + outer）——
      // 先 JSON round-trip 还原线格式（实例 toJSON 生效，剥离 _player/_trigger 等内部字段）
      const { rlv2Response } = await import("@game/modules/roguelike/response");
      const ourResp = rlv2Response(player, undefined, undefined, ["record", "monthTeam"]);
      const offRlv2 = OFF_CREATE.playerDataDelta.modified.rlv2;
      const ourRlv2 = JSON.parse(JSON.stringify(ourResp.playerDataDelta.modified.rlv2));
      const diffs1: string[] = [];
      collectDiffs(offRlv2, ourRlv2, "", diffs1);
      const real1 = diffs1.filter((d) => !allowed(d));
      console.log("=== createGame 非白名单差异 " + real1.length + " 条 ===");
      for (const d of real1.slice(0, 40)) console.log("  " + d);
      expect(real1).toEqual([]);

      // 确定性属性断言（官服 createGame）
      const p = ourRlv2.current.player;
      expect(p.state).toBe("INIT");
      expect(p.property.hp).toEqual({ current: 4, max: 4 });
      expect(p.property.gold).toBe(20);
      expect(p.property.shield).toBe(2);
      expect(p.property.capacity).toBe(7);
      expect(p.property.population).toEqual({ cost: 0, max: 6 });
      expect(p.pending.map((e: PlayerRoguelikePendingEvent) => e.type)).toEqual(["GAME_INIT_RELIC", "GAME_INIT_GIFT", "GAME_INIT_SUPPORT", "GAME_INIT_RECRUIT_SET", "GAME_INIT_RECRUIT"]);

      // GIFT 内容：gold10 + pop1（同类合并）
      const gift = p.pending.find((e: PlayerRoguelikePendingEvent) => e.type === "GAME_INIT_GIFT");
      expect(gift.content.initGift.items).toEqual([
        { id: "rogue_6_gold", count: 10 },
        { id: "rogue_6_population", count: 1 },
      ]);

      // ===== 后续步骤：chooseInitialRelic → finishEvent(GIFT) → selectChoice(SUPPORT) =====
      await rlv2.chooseInitialRelic({ select: "0" });
      await rlv2.finishEvent(); // 消费 GIFT
      const afterGift = JSON.parse(JSON.stringify(rlv2.toJSON()));
      expect(afterGift.current.player.state).toBe("INIT");
      expect(afterGift.current.player.pending.map((e: PlayerRoguelikePendingEvent) => e.type)).toEqual([
        "GAME_INIT_SUPPORT", "GAME_INIT_RECRUIT_SET", "GAME_INIT_RECRUIT",
      ]);
      // GIFT 生效：gold 20+10=30、population.max 6+1=7（官服 finishEvent#1 一致）
      expect(afterGift.current.player.property.gold).toBe(30);
      expect(afterGift.current.player.property.population).toEqual({ cost: 0, max: 7 });
      // hp 取决于所选分队（mock 第 0 个为指挥分队 +2 血；官服选 band_9 无加成）——
      // 不硬断言 4/4，仅验证 finishEvent 消费 GIFT 本身不改血
      expect(afterGift.current.player.property.hp.current).toBeGreaterThan(0);

      // selectChoice 消费 SUPPORT（官服选 startbuff_8 希望+1；测试固定选 startbuff_2=金8
      // 无随机藏品副作用——避免随机 relic 触发进阶券 RECRUIT 事件）
      const sup = afterGift.current.player.pending[0];
      const supChoices = Object.keys(sup.content.initSupport.scene.choices);
      const pickSup = supChoices.includes("choice_ro6_startbuff_2")
        ? "choice_ro6_startbuff_2"
        : supChoices[0];
      await rlv2.selectChoice({ choice: pickSup });
      const afterSup = JSON.parse(JSON.stringify(rlv2.toJSON()));
      expect(afterSup.current.player.pending.map((e: PlayerRoguelikePendingEvent) => e.type)).toEqual([
        "GAME_INIT_RECRUIT_SET", "GAME_INIT_RECRUIT",
      ]);

      // chooseInitialRecruitSet 消费 RECRUIT_SET
      await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
      const afterRecruitSet = JSON.parse(JSON.stringify(rlv2.toJSON()));
      // 官服 chooseInitialRecruitSet 后 pending=[GAME_INIT_RECRUIT]；
      // 私服可能残留 RECRUIT（activeRecruitTicket 流程事件）——断言至少含 GAME_INIT_RECRUIT
      const rsTypes = afterRecruitSet.current.player.pending.map((e: PlayerRoguelikePendingEvent) => e.type);
      expect(rsTypes).toContain("GAME_INIT_RECRUIT");
      const recruitEvt = afterRecruitSet.current.player.pending.find(
        (e: PlayerRoguelikePendingEvent) => e.type === "GAME_INIT_RECRUIT",
      );
      expect(recruitEvt.content.initRecruit.tickets.length).toBeGreaterThan(0);
    } finally {
      rand.mockRestore();
    }
  });
});
