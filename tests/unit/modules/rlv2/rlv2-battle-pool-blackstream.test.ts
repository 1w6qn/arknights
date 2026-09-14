import { describe, it, expect, vi } from "vitest";

// ===== rogue_6（黑流树海）战斗藏品池回归 =====
// 池来源：路标档案馆（lubiao.wiki）/pools/rogue_6 观测池（成员为官方藏品 id）：
// 作战 / 作战·无效验尸 / 紧急作战 / “居民”据点 / 湖中仙女（普通/紧急）/
// 狭路相逢（藏品+零件双池）/ Boss 藏品池 / 额外掉落池（地质调查分队）。
// excel mock 的 relics/items 由真实 pools.json 成员动态构建（登记即合法）。

/** 道具/藏品行夹具（本文件只登记 id/type/rarity 三键） */
interface PoolRowFixture { id: string; type: string; rarity: number | string }
/** 藏品行夹具（buffs 只登记空表，被测实现按 id 取材） */
interface RelicRowFixture { id: string; buffs: never[] }

vi.mock("@excel/excel", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path");
  const pools = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../../../data/rlv2/pools.json"),
      "utf8",
    ),
  ).pools;
  const relicIds = new Set<string>([
    ...pools.node_battle_normal.members,
    ...pools.node_battle_normal_invalid_autopsy.members.slice(0, 3),
    ...pools.node_battle_elite.members.slice(0, 3),
    ...pools.node_battle_savage.members.slice(0, 3),
    ...pools.node_incident_lake_fairy.members.slice(0, 3),
    ...pools.node_duel_relic.members.slice(0, 3),
    ...pools.pool_boss.members.slice(0, 3),
    ...pools.drop_extra_pool.members.slice(0, 3),
  ]);
  const items: { [id: string]: PoolRowFixture } = {
    rogue_6_gold: { id: "rogue_6_gold", type: "GOLD", rarity: 0 },
    rogue_6_band_21: { id: "rogue_6_band_21", type: "RELIC", rarity: 0 },
  };
  const relics: { [id: string]: RelicRowFixture } = {
    rogue_6_band_21: { id: "rogue_6_band_21", buffs: [] },
  };
  for (const id of relicIds) {
    items[id] = { id, type: "RELIC", rarity: "NORMAL" };
    relics[id] = { id, buffs: [] };
  }
  for (const id of pools.node_duel_scrap.members.slice(0, 5)) {
    items[id] = { id, type: "SCRAP", rarity: "NORMAL" };
  }
  return {
    default: {
      RoguelikeTopicTable: {
        details: {
          rogue_6: {
            init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
            items,
            relics,
          },
        },
        modules: {
          rogue_6: {
            moduleTypes: ["SCRAP"],
            scrap: { scrapItemToType: {} },
          },
        },
        consts: {},
      },
      CharacterTable: {},
      GameDataConst: { maxLevel: [[], [], [], [], [], []] },
    },
  };
});

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import excel from "@excel/excel";
import { mockPlayerData, asModel } from "../../../helpers";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require("path");
const realPools = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../../data/rlv2/pools.json"),
    "utf8",
  ),
).pools;

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer(): PlayerDataManager {
  const pd = mockPlayerData({
    rlv2: {
      outer: { rogue_6: {} },
      current: {},
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: {
      missions: { DAILY: {}, ACTIVITY: {} },
      missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} },
    },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({
    theme: "rogue_6",
    mode: "NORMAL",
    modeGrade: 0,
  });
  return player;
}

async function setup(player: PlayerDataManager) {
  // 构造期发射的 rlv2:init 为异步（Emittery 微任务），先冲刷再建池，
  // 否则 init 监听会在 create 之后把 _pools 清空
  await new Promise((r) => setTimeout(r, 0));
  await player.rlv2._pool.create();
  vi.spyOn(Math, "random").mockReturnValue(0);
}

afterEach(() => vi.restoreAllMocks());

describe("pools.json 战斗藏品池数据（路标档案馆 2026-08-25）", () => {
  it("战斗池成员规模与来源一致", () => {
    expect(realPools.node_battle_normal.members.length).toBe(1);
    expect(realPools.node_battle_normal_invalid_autopsy.members.length).toBe(16);
    expect(realPools.node_battle_elite.members.length).toBe(62);
    expect(realPools.node_battle_savage.members.length).toBe(25);
    expect(realPools.node_incident_lake_fairy.members.length).toBe(9);
    expect(realPools.node_incident_lake_fairy_emergency.members.length).toBe(15);
    expect(realPools.pool_boss.members.length).toBe(36);
    expect(realPools.drop_extra_pool.members.length).toBe(76);
    expect(realPools.node_duel_relic.members.length).toBeGreaterThan(0);
    expect(realPools.node_duel_scrap.members.length).toBeGreaterThan(0);
  });
});

describe("战斗藏品选池（节点类型 / 特殊关卡）", () => {
  it("紧急作战节点 → node_battle_elite 观测池", async () => {
    const player = makePlayer();
    await setup(player);
    const id = player.rlv2._battle["pickBattleRelic"](2, "", []);
    expect(realPools.node_battle_elite.members).toContain(id);
  });

  it("险路恶敌（首领）→ pool_boss", async () => {
    const player = makePlayer();
    await setup(player);
    const id = player.rlv2._battle["pickBattleRelic"](4, "", []);
    expect(realPools.pool_boss.members).toContain(id);
  });

  it("“居民”据点 → node_battle_savage", async () => {
    const player = makePlayer();
    await setup(player);
    const id = player.rlv2._battle["pickBattleRelic"](134217728, "", []);
    expect(realPools.node_battle_savage.members).toContain(id);
  });

  it("无效验尸关卡（ro6_t_12）→ 专属 16 件池", async () => {
    const player = makePlayer();
    await setup(player);
    const id = player.rlv2._battle["pickBattleRelic"](1, "ro6_t_12", []);
    expect(realPools.node_battle_normal_invalid_autopsy.members).toContain(id);
  });

  it("湖中仙女事件战（ro6_t_5 / ro6_e_t_5）→ 各自观测池", async () => {
    const player = makePlayer();
    await setup(player);
    const id = player.rlv2._battle["pickBattleRelic"](undefined, "ro6_t_5", []);
    expect(realPools.node_incident_lake_fairy.members).toContain(id);
    const player2 = makePlayer();
    await setup(player2);
    const id2 = player2.rlv2._battle["pickBattleRelic"](undefined, "ro6_e_t_5", []);
    expect(realPools.node_incident_lake_fairy_emergency.members).toContain(id2);
  });

  it("狭路相逢（ro6_duel_*）→ 藏品池 + 零件池各可抽", async () => {
    const player = makePlayer();
    await setup(player);
    const id = player.rlv2._battle["pickBattleRelic"](undefined, "ro6_duel_1", []);
    expect(realPools.node_duel_relic.members).toContain(id);
    const scrap = player.rlv2._battle["pickFromPool"](
      "node_duel_scrap",
      [],
      (sid: string) =>
        excel.RoguelikeTopicTable.details.rogue_6.items[sid]?.type ===
        "SCRAP",
    );
    expect(realPools.node_duel_scrap.members).toContain(scrap);
  });

  it("普通作战 → 观测池抽空后降档稀有度池（不放回）", async () => {
    const player = makePlayer();
    await setup(player);
    const only = realPools.node_battle_normal.members[0];
    const first = player.rlv2._battle["pickBattleRelic"](1, "", []);
    expect(first).toBe(only);
    // 池已抽空 → 降档（本 mock 稀有度池 = 全部登记藏品），不再返回同一件
    const second = player.rlv2._battle["pickBattleRelic"](1, "", [first]);
    expect(second).not.toBe(only);
    expect(second).not.toBe("");
  });

  it("地质调查分队判定（持有 rogue_6_band_21）", async () => {
    const player = makePlayer();
    await setup(player);
    expect(player.rlv2._battle["hasBand"]("rogue_6_band_21")).toBe(false);
    player.rlv2.inventory!._relic.relics = {
      r_0: { index: "r_0", id: "rogue_6_band_21", count: 1, ts: 0 },
    };
    expect(player.rlv2._battle["hasBand"]("rogue_6_band_21")).toBe(true);
  });
});
