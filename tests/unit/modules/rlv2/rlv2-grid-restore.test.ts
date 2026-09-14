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

// rogue_6（黑流树海）网格对局"落盘 → 重登续局"的恢复回归测试。
// 触发点：重登后 gridZone.zones 节点 content 已是客户端线格式（savage/kind 被剥除），
// 续局 gridZoneMoveTo 进战斗节点必须能判定并触发战斗（此前从 gridZone 节点 content 取
// savgment.stageId/kind → 恢复后缺失 → 只回 WAIT_MOVE，客户端卡死，2026-08-20 复现）。
const excelMock = vi.hoisted(() => ({
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
        stages: {
          ro6_n_1_1: { id: "ro6_n_1_1" },
          ro6_n_1_2: { id: "ro6_n_1_2" },
          ro6_n_1_3: { id: "ro6_n_1_3" },
          ro6_e_1_1: { id: "ro6_e_1_1" },
          ro6_n_5_1: { id: "ro6_n_5_1" },
          ro6_e_5_1: { id: "ro6_e_5_1" },
        },
        init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
        items: {},
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["GRID_ZONE"],
      },
    },
    consts: {},
  },
  CharacterTable: {} as Record<string, ExcelCharRowMock>,
  GameDataConst: { maxLevel: [[], [], [], [], [], []] },
}));

vi.mock("@excel/excel", () => ({ default: excelMock }));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, type MockSeed } from "../../../helpers";
import type { PlayerDataModel } from "@game/kernel/playerdata";

/** 重登存档 current 子树（生成模型视图） */
type Rlv2Current = PlayerDataModel["rlv2"]["current"];

/**
 * 进行中对局 player 状态夹具视图
 *
 * 历史夹具沿用内部模型/线格式取值（`cursor.position` 为 null、`state` 为字符串），而生成模型
 * `PlayerRoguelikeV2_CurrentData_PlayerStatus` 把 `cursor.position` 声明为非空对象、
 * `state` 声明为字符串字面量联合。这些值不被本用例断言，为不改运行期夹具数据，仅就地声明
 * 读取视图后单向断言（真实种子类型可赋给本视图，故断言两侧仍可比较）。
 */
interface PlayerStatusFixture {
  state?: string | number;
  property?: { hp?: { current?: number; max?: number }; gold?: number };
  cursor?: { zone?: number; position?: { x?: number; y?: number } | null };
  trace?: { zone?: number; position?: { x?: number; y?: number } | null }[];
  pending?: {
    index?: string;
    type?: string | number;
    content?: {
      success?: number;
      result?: { brief?: {} | null; record?: {} | null };
      popReport?: boolean | number;
    };
  }[];
  status?: { bankPut?: number };
  toEnding?: string;
  chgEnding?: boolean;
}

/**
 * 开局 game 夹具视图
 *
 * 历史夹具沿用内部模型取值范围（`mode: "NORMAL"` 字符串、`predefined: null` 可空），生成模型
 * `PlayerRoguelikeV2_CurrentData_Game` 声明 `mode` 为数字、`predefined` 为非空字符串。
 * 这些值不被本用例断言，仅就地声明读取视图后单向断言。
 */
interface GameFixture {
  theme?: string;
  mode?: string | number;
  modeGrade?: number;
  predefined?: string | null;
  outer?: { support?: boolean };
  start?: number;
  equivalentGrade?: number;
}

/**
 * 进行中对局 buff 夹具视图
 *
 * 历史夹具 `current.buff.capsule` 为 null（内部模型声明为 `Capsule | null`），而生成模型
 * `PlayerRoguelikeV2_CurrentData_Buff.capsule` 声明为非空。该字段不被本用例断言，仅就地声明
 * 读取视图后单向断言。
 */
interface BuffFixture {
  tmpHP?: number;
  capsule?: Partial<Rlv2Current["buff"]["capsule"]> | null;
  squadBuff?: string[];
}

/**
 * 干员队列夹具视图
 *
 * 历史夹具 `current.troop.expeditionReturn` 为 null，而生成模型
 * `PlayerRoguelikeV2_CurrentData_Troop.expeditionReturn` 声明为非空。该字段不被本用例断言，
 * 仅就地声明读取视图后单向断言。
 */
interface TroopFixture {
  chars?: { [key: string]: MockSeed<Rlv2Current["troop"]["chars"][string]> };
  expedition?: string[];
  expeditionDetails?: { [key: string]: number };
  expeditionReturn?: MockSeed<Rlv2Current["troop"]["expeditionReturn"]> | null;
  hasExpeditionReturn?: boolean;
}

/**
 * 局内物品栏夹具视图
 *
 * 历史夹具 `current.inventory.trap` 为 null，而生成模型
 * `PlayerRoguelikeV2_CurrentData_Inventory.trap` 声明为非空。该字段不被本用例断言，仅就地
 * 声明读取视图后单向断言。
 */
interface InventoryFixture {
  relic?: { [key: string]: MockSeed<Rlv2Current["inventory"]["relic"][string]> };
  recruit?: { [key: string]: MockSeed<Rlv2Current["inventory"]["recruit"][string]> };
  trap?: MockSeed<Rlv2Current["inventory"]["trap"]> | null;
  exploreTool?: { [key: string]: MockSeed<Rlv2Current["inventory"]["exploreTool"][string]> };
  consumable?: { [key: string]: number };
}

/** Math.random 固定 0：generate 恒取每层第一张模板，便于精确确定战斗节点 */
async function withFixedRandom(fn: () => Promise<void> | void) {
  const spy = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
}

/** 构造一个"进行中 rogue_6 第 1 层"的控制器，并生成第 1 层网格 */
async function makeRunningGridPlayer() {
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
  const rlv2 = player.rlv2;
  rlv2.current.game = {
    theme: "rogue_6",
    mode: "NORMAL",
    modeGrade: 0,
    predefined: null,
    outer: { support: false },
    start: 1,
    equivalentGrade: 0,
  };
  await rlv2._module.create();
  rlv2._module.gridZone.generate([1]);
  return player;
}

/** 用已生成对局的内存态，构造一份"落盘后再读回"的存档快照（等价 JSON 序列化往返） */
function persistedSnapshot(player: PlayerDataManager): Pick<Rlv2Current, "map" | "module"> {
  const rlv2 = player.rlv2;
  return {
    module: JSON.parse(JSON.stringify(rlv2._module.toJSON())),
    map: JSON.parse(JSON.stringify(rlv2._map.toJSON())),
  };
}

/** 用存档快照重建控制器（重登"继续探索"分支），返回可调用的 rlv2 */
function reloadFromSnapshot(snapshot: Pick<Rlv2Current, "map" | "module">) {
  const playerSeed: PlayerStatusFixture = {
    state: "WAIT_MOVE",
    property: { hp: { current: 4, max: 4 }, gold: 8 },
    cursor: { zone: 1, position: null },
    trace: [],
    pending: [],
    status: { bankPut: 0 },
    toEnding: "ro6_ending_1",
    chgEnding: false,
  };
  const gameSeed: GameFixture = {
    theme: "rogue_6",
    mode: "NORMAL",
    modeGrade: 0,
    predefined: null,
    outer: { support: false },
    start: 1,
    equivalentGrade: 0,
  };
  const buffSeed: BuffFixture = { tmpHP: 0, capsule: null, squadBuff: [] };
  const troopSeed: TroopFixture = {
    chars: {},
    expedition: [],
    expeditionDetails: {},
    expeditionReturn: null,
    hasExpeditionReturn: false,
  };
  const inventorySeed: InventoryFixture = {
    relic: {},
    recruit: {},
    trap: null,
    exploreTool: {},
    consumable: {},
  };
  const pd = mockPlayerData({
    rlv2: {
      outer: { rogue_6: {} },
      current: {
        player: playerSeed as MockSeed<Rlv2Current["player"]>,
        map: snapshot.map,
        module: snapshot.module,
        game: gameSeed as MockSeed<Rlv2Current["game"]>,
        buff: buffSeed as MockSeed<Rlv2Current["buff"]>,
        record: { brief: null },
        troop: troopSeed as MockSeed<Rlv2Current["troop"]>,
        inventory: inventorySeed as MockSeed<Rlv2Current["inventory"]>,
      },
      pinned: {} as string,
    },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: {
      missions: { DAILY: {}, ACTIVITY: {} },
      missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} },
    },
  });
  const player = new PlayerDataManager(pd._playerdata);
  // 构造期 hasRunning=true 走 rlv2:continue（异步微任务），等落定后再驱动续局
  return player.rlv2;
}

describe("rogue_6 网格对局重登续局恢复", () => {
  it("续局网格地图已按存档恢复（zones 非空，可继续走）", async () => {
    await withFixedRandom(async () => {
      const origin = await makeRunningGridPlayer();
      const gz = origin.rlv2._module.gridZone;
      expect(Object.keys(gz.zones["zone_1"].nodes).length).toBeGreaterThan(0);

      const snapshot = persistedSnapshot(origin);
      const rlv2 = reloadFromSnapshot(snapshot);
      // 等构造期 continue 微任务落定
      await Promise.resolve();
      await Promise.resolve();
      // 存档模块恢复后 zones 仍在（map 完整恢复）
      expect(Object.keys(rlv2._module.gridZone.zones["zone_1"].nodes).length).toBeGreaterThan(0);
      const mapNodes = rlv2._map.zones["1000"]?.nodes;
      expect(Object.keys(mapNodes).length).toBeGreaterThan(0);
    });
  });

  it("续局移动进战斗节点：必须触发战斗并推送节点到达（防客户端卡死）", async () => {
    await withFixedRandom(async () => {
      const origin = await makeRunningGridPlayer();
      const gridZone = origin.rlv2._module.gridZone;
      // 取一个作战节点（type===1）作为目标
      const battleId = Object.entries(gridZone.zones["zone_1"].nodes).find(
        ([, n]) => n.content?.kind === 1,
      )![0];
      expect(battleId).toBeTruthy();

      const snapshot = persistedSnapshot(origin);
      const rlv2 = reloadFromSnapshot(snapshot);
      await Promise.resolve();
      await Promise.resolve();

      // 重登恢复后按存档驱动续局：移动到该战斗节点
      await rlv2.gridZoneMoveTo({ route: [battleId] });
      const msgs = rlv2.takePushMessages();
      // 节点到达推送必须携带节点类型（客户端据此渲染到达节点，否则卡死）
      expect(msgs.find((m) => m.path === "rlv2NodeArrive")).toBeTruthy();
      // 战斗节点必须进入战斗态（PENDING + BATTLE pending 事件），而非仅 WAIT_MOVE（卡死态）
      expect(rlv2._status.state).toBe("PENDING");
      expect(rlv2._status.pending.some((e) => e.type === "BATTLE")).toBe(true);
    });
  });
});