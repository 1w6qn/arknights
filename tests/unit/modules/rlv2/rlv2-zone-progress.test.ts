import { describe, it, expect, vi } from "vitest";
import { buildRoguelikeConsts } from "@game/excel/roguelike_consts_gen";
/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }

// ===== 探索中 zone 推进回归（真实 excel 数据）=====
// 完整开局 → 走到 zone_end 节点 → finishEvent → zone 2 生成；
// NORMAL 与 MONTH_TEAM 双模式验证（此前只测到 zone 1 生成，未覆盖推进）
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
import type { RoguelikeV2Manager } from "@game/modules/roguelike/logic";

/**
 * GAME_INIT_SUPPORT 事件载荷的选择项读取视图
 *
 * 真实载荷 `choices` 位于 `content.initSupport.scene.choices`（见
 * app/game/modules/roguelike/events.ts 的 GAME_INIT_SUPPORT builder），生成模型
 * `PlayerRoguelikePendingEvent.Content` 未声明顶层 `choices`；本用例沿用历史写法读
 * `content.choices`（恒 undefined，`|| {}` 惰性分支承受）。为不改运行期行为，仅就地声明
 * 该键的读取视图。
 */
interface ContentWithChoices { choices?: { [key: string]: number } }

/**
 * 开局干员夹具视图
 *
 * 历史夹具给顶层 `troop.chars` 的每个干员带 `rarity`（"TIER_5" 等），生成模型
 * `PlayerCharacter` 未声明该键；该键不被被测实现读取。为不改运行期夹具数据，
 * 仅就地声明该视图。
 */
interface TroopCharFixture {
  charId: string;
  instId: number;
  rarity?: string;
}

/**
 * rlv2NodeChange 推送载荷读取视图
 *
 * `RoguelikePushMessage.payload` 为协议层未建模值，本用例按 path 收窄后读取
 * `nodeList`（官服进层 nodeChange 载荷键）。仅就地声明该键的读取视图。
 */
interface NodeChangePayload { nodeList?: string[] }

function makePlayer() {
  const troopChars: { [key: string]: TroopCharFixture } = {
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
  // 历史 outer 夹具含 `record.lastZone`（生成模型未声明，内部模型有此键），
  // 以变量承载以免对象字面量的多余属性检查报错；字段值原样保留。
  const outerSeed = {
    rogue_6: {
      record: { last: 0, lastZone: 3, legacy: [], stageCnt: {}, bandCnt: {}, bandGrade: {} },
      collect: { band: {} },
      buff: { pointOwned: 0, pointCost: 0, unlocked: {}, score: 0 },
    },
  };
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: {
      outer: outerSeed,
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

/** 完整开局到 WAIT_MOVE（zone 1），返回 recruitGroup 选择函数 */
async function openToWaitMove(rlv2: RoguelikeV2Manager, group = "recruit_group_1") {
  await rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 0, predefinedId: null });
  await rlv2.chooseInitialRelic({ select: "0" });
  await rlv2.finishEvent();
  const sup = rlv2._status.pending.find((e) => e.type === "GAME_INIT_SUPPORT");
  if (sup) {
    const cid = Object.keys((sup.content as ContentWithChoices).choices || {})[0];
    await rlv2.selectChoice({ choice: cid });
  }
  await rlv2.chooseInitialRecruitSet({ select: group });
  const recruitEvt = rlv2._status.pending.find((e) => e.type === "GAME_INIT_RECRUIT");
  for (const t of recruitEvt?.content?.initRecruit?.tickets || []) {
    await rlv2.activeRecruitTicket({ id: t });
    const ticket = rlv2.inventory!.recruit[t];
    if (ticket.list.length > 0) {
      await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
    }
  }
  await rlv2.finishEvent();
}

/** 走到当前层 zone_end 节点并 finishEvent 推进（消费可能的商店事件） */
async function advanceZone(rlv2: RoguelikeV2Manager): Promise<number> {
  const zone = rlv2._status.cursor.zone;
  const mapKey = String(1000 + zone - 1);
  const mapZone = rlv2._map.zones[mapKey];
  const ends = Object.entries(mapZone.nodes).filter(([, n]) => n.zone_end);
  expect(ends.length).toBeGreaterThan(0);
  await rlv2.gridZoneMoveTo({ route: [ends[0][0]] });
  if (rlv2._status.pending[0]?.type === "BATTLE_SHOP") {
    await rlv2.finishEvent();
  }
  await rlv2.finishEvent(); // checkZoneEnd
  return rlv2._status.cursor.zone;
}

describe("探索中 zone 推进（真实 excel）", () => {
  it("NORMAL：zone 1 → 终点 → zone 2 生成，pending 为空与官服一致", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    let seed = 0;
    const rand = vi.spyOn(Math, "random").mockImplementation(() => (seed++ % 100) / 100);
    try {
      await openToWaitMove(rlv2);
      expect(rlv2._status.state).toBe("WAIT_MOVE");
      expect(rlv2._status.cursor.zone).toBe(1);
      // cursor.position = 起点节点位置（官服 finishEvent#2 position={x:0,y:1}；
      // null 会导致客户端无法定位当前节点崩溃）
      expect(rlv2._status.cursor.position).not.toBeNull();
      const startNode = Object.values(rlv2._map.zones["1000"].nodes).find(
        (n) => n.type === 268435456,
      )!;
      expect(startNode).toBeTruthy();
      expect(rlv2._status.cursor.position).toEqual({
        x: startNode.pos.x,
        y: startNode.pos.y,
      });
      // 层尾节点存在且标记 zone_end（map 侧）
      const ends = Object.entries(rlv2._map.zones["1000"].nodes).filter(
        ([, n]) => n.zone_end,
      );
      expect(ends.length).toBeGreaterThan(0);
      const nextZone = await advanceZone(rlv2);
      expect(nextZone).toBe(2);
      expect(rlv2._status.state).toBe("WAIT_MOVE");
      // pending 空（与官服 finishEvent → WAIT_MOVE 一致）
      expect(rlv2._status.pending.length).toBe(0);
      // 新层地图已生成（map + gridZone 双侧）
      expect(rlv2._map.zones["1001"]).toBeTruthy();
      expect(rlv2._module.gridZone.zones["zone_2"]).toBeTruthy();
    } finally {
      rand.mockRestore();
    }
  });

  it("MONTH_TEAM：同样可推进到 zone 2（模式修复后完整链路）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    let seed = 0;
    const rand = vi.spyOn(Math, "random").mockImplementation(() => (seed++ % 100) / 100);
    try {
      await rlv2.createGame({ theme: "rogue_6", mode: "MONTH_TEAM", modeGrade: 0, predefinedId: "month_team_1" });
      await rlv2.chooseInitialRelic({ select: "0" });
      await rlv2.finishEvent();
      const sup = rlv2._status.pending.find((e) => e.type === "GAME_INIT_SUPPORT");
      if (sup) {
        const cid = Object.keys((sup.content as ContentWithChoices).choices || {})[0];
        await rlv2.selectChoice({ choice: cid });
      }
      await rlv2.chooseInitialRecruitSet({ select: "recruit_group_m1" });
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
      const nextZone = await advanceZone(rlv2);
      expect(nextZone).toBe(2);
      expect(rlv2._status.pending.length).toBe(0);
    } finally {
      rand.mockRestore();
    }
  });

  it("作战节点：移动生成 BATTLE 事件（state PENDING），后续可正常 finishEvent", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    let seed = 0;
    const rand = vi.spyOn(Math, "random").mockImplementation(() => (seed++ % 100) / 100);
    try {
      await openToWaitMove(rlv2);
      const battle = Object.entries(rlv2._map.zones["1000"].nodes).find(
        ([, n]) => n.type === 1 && n.stage,
      );
      expect(battle).toBeTruthy();
      await rlv2.gridZoneMoveTo({ route: [battle![0]] });
      expect(rlv2._status.state).toBe("PENDING");
      const bEvent = rlv2._status.pending.find((e) => e.type === "BATTLE");
      expect(bEvent).toBeTruthy();
      expect(bEvent!.content.battle?.state).toBe(1);
    } finally {
      rand.mockRestore();
    }
  });

  it("进层 finishEvent：自动起点走一步 + 下发 rlv2NodeChange（官服抓包 R-1786531228496.9993-3674 对齐）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    let seed = 0;
    const rand = vi.spyOn(Math, "random").mockImplementation(() => (seed++ % 100) / 100);
    try {
      await openToWaitMove(rlv2);
      // 进层完成：WAIT_MOVE、无需确认起点
      expect(rlv2._status.state).toBe("WAIT_MOVE");
      expect(rlv2._module.gridZone.needConfirmStepZero).toBe(false);
      const startNode = Object.values(rlv2._map.zones["1000"].nodes).find(
        (n) => n.type === 268435456,
      )!;
      expect(startNode).toBeTruthy();
      // trace 含起点（官服进层 trace=[起点]），position 已定位
      expect(rlv2._status.trace).toEqual([
        { zone: 1, position: { x: startNode.pos.x, y: startNode.pos.y } },
      ]);
      // 起点 gridZone state=2（已访问）；进层后无 state=1 中间态（官服 gridZone 只取 0/2）
      const gz = rlv2._module.gridZone;
      const startId = String(startNode.pos.x * 100 + startNode.pos.y);
      expect(gz.zones["zone_1"].nodes[startId].state).toBe(2);
      const zg = gz.zones["zone_1"];
      expect(Object.values(zg.nodes).some((n) => n.state === 1)).toBe(false);
      // 进层下发唯一 rlv2NodeChange（nodeList=起点列排除起点，官服 ["202","200"]）
      const pushes = rlv2.takePushMessages();
      const nc = pushes.find((p) => p.path === "rlv2NodeChange");
      expect(nc).toBeTruthy();
      const colIds = Object.keys(zg.nodes).filter(
        (id) =>
          Math.floor(Number(id) / 100) === startNode.pos.x && id !== startId,
      );
      expect((nc!.payload as NodeChangePayload).nodeList!.sort()).toEqual(colIds.sort());
      // 进层只有 nodeChange，不带 rlv2NodeArrive
      expect(pushes.some((p) => p.path === "rlv2NodeArrive")).toBe(false);
    } finally {
      rand.mockRestore();
    }
  });

  it("多林间空地时起点定位为 state=2 且 kind=GLADE 节点（官服 state 仅 0/2：点亮节点也为 2）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    let seed = 0;
    const rand = vi.spyOn(Math, "random").mockImplementation(() => (seed++ % 100) / 100);
    try {
      await openToWaitMove(rlv2);
      const gz = rlv2._module.gridZone;
      const zg = gz.zones["zone_1"];
      const cursorPos = rlv2._status.cursor.position!;
      const sid = String(cursorPos.x * 100 + cursorPos.y);
      // 起点是 gridZone 中唯一 state=2 且 kind=GLADE 的节点（初始点亮节点也为 2 但非 GLADE）
      const startLikeIds = Object.keys(zg.nodes).filter(
        (id) => zg.nodes[id].state === 2 && zg.nodes[id].content?.kind === 268435456,
      );
      expect(startLikeIds).toEqual([sid]);
      // 注入一个 state=0 的"填充林间空地"，模拟同一层出现的多个 GLADE
      // （官方数量规则每层可铺 0..16 个，见 BLACKSTREAM_COUNT_RULES）
      const cand = sid === "0" ? "1" : "0";
      zg.nodes[cand] = { content: { kind: 268435456 }, state: 0, show: true };
      // 修复后定位仍返回真实起点（state=2 且 GLADE），而非注入的填充林间空地/点亮节点
      const pos = rlv2.locateStartNode()!;
      expect(String(pos.x * 100 + pos.y)).toBe(sid);
      expect(String(pos.x * 100 + pos.y)).not.toBe(cand);
    } finally {
      rand.mockRestore();
    }
  });
});
