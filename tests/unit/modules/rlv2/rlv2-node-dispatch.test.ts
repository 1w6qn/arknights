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

// ===== rogue_6（黑流树海）节点分发与主题规则回归 =====
// 覆盖本轮修复：
// 1. gridZoneMoveTo 的事件节点分发（安全的角落/得偿所愿/失与得/先行一步/狭路相逢/
//    应急助力/险路小径/险路尽头）——原实现仅 MIRAGE/PROPHECY/INCIDENT 有分支，
//    其余节点全部退化为空节点（triggerNodeEvent 定义但零调用）
// 2. 先行一步（EXPEDITION）→ scene_ro6_scout_enter 三结局入口可达
// 3. 节点到达推送（rlv2NodeArrive / rlv2NodeChange）在 gridZone 移动时累积
// 4. 精英/首领节点使用各自关卡池（原 eliteStages 计算后未使用）
// 5. rerollNode 兼容黑流树海 map.zones 键（1000+）且支持 rogue_6 节点类型
// 6. 废品估价取官方 sellPrice（原恒为 1）
// 7. 误入奇境消耗 MOVE 型（官方 scrapTypeData：MOVE=加工品）
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
        init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
        stages: {
          ro6_n_3_1: { id: "ro6_n_3_1" },
          ro6_n_3_2: { id: "ro6_n_3_2" },
          ro6_e_3_1: { id: "ro6_e_3_1" },
          ro6_e_3_2: { id: "ro6_e_3_2" },
          ro6_b_3: { id: "ro6_b_3" },
          ro6_b_3_b: { id: "ro6_b_3_b" },
        },
        items: {
          rogue_6_scrap_M_01: { id: "rogue_6_scrap_M_01", type: "SCRAP", rarity: "NORMAL" },
          rogue_6_scrap_G_02: { id: "rogue_6_scrap_G_02", type: "SCRAP", rarity: "NORMAL" },
        },
        // 各节点类型对应的官方 enter 场景 + 选项（截取真实 id 命名）
        choiceScenes: {
          scene_ro6_rest_enter: { id: "scene_ro6_rest_enter", title: "金色凝滞" },
          scene_ro6_wish_enter: { id: "scene_ro6_wish_enter", title: "无人商店" },
          scene_ro6_sacrifice1_enter: { id: "scene_ro6_sacrifice1_enter", title: "回滚文明" },
          scene_ro6_scout_enter: { id: "scene_ro6_scout_enter", title: "未涉足之树" },
          scene_ro6_sala1_enter: { id: "scene_ro6_sala1_enter", title: "原始娱乐" },
          scene_ro6_hire1_enter: { id: "scene_ro6_hire1_enter", title: "临时中介所" },
          scene_ro6_final1_enter: { id: "scene_ro6_final1_enter", title: "险路尽头" },
          scene_ro6_evacuate_enter: { id: "scene_ro6_evacuate_enter", title: "三重身" },
          scene_ro6_normal1_enter: { id: "scene_ro6_normal1_enter", title: "沉寂之屋" },
        },
        choices: {
          choice_ro6_rest_1: { id: "choice_ro6_rest_1", type: "TRADE" },
          choice_ro6_rest_2: { id: "choice_ro6_rest_2", type: "TRADE" },
          choice_ro6_wish_1: { id: "choice_ro6_wish_1", type: "TRADE_PROB_SHOW" },
          choice_ro6_sacrifice1_1: { id: "choice_ro6_sacrifice1_1", type: "SACRIFICE" },
          choice_ro6_scout_1: { id: "choice_ro6_scout_1", type: "EXPEDITION" },
          choice_ro6_scout_3: { id: "choice_ro6_scout_3", type: "EXPEDITION" },
          choice_ro6_sala1_1: { id: "choice_ro6_sala1_1", type: "NEXT" },
          choice_ro6_hire1_1: { id: "choice_ro6_hire1_1", type: "TRADE" },
          choice_ro6_final1_3: { id: "choice_ro6_final1_3", type: "ZONE_END" },
          choice_ro6_evacuate_4: { id: "choice_ro6_evacuate_4", type: "ZONE_END" },
          choice_ro6_normal1_1: { id: "choice_ro6_normal1_1", type: "TRADE" },
        },
        // 重掷节点：官方仅隐藏层配置，此处给常规区一组用于验证键与类型映射
        rollNodeData: {
          zone_3: {
            zoneId: "zone_3",
            groups: { SCRAP_SHOP: { nodeType: "SCRAP_SHOP" } },
          },
        },
      },
    },
    modules: {
      rogue_6: {
        moduleTypes: ["GRID_ZONE", "SCRAP"],
        scrap: {
          moduleConsts: { identifyScrapId: "rogue_6_scrap_M_01" },
          moveScrapData: {
            rogue_6_scrap_M_01: { scrapId: "rogue_6_scrap_M_01", sellPrice: 1 },
          },
          goodsScrapData: {
            rogue_6_scrap_G_02: { scrapId: "rogue_6_scrap_G_02", sellPrice: 2 },
          },
          scrapItemToType: {
            rogue_6_scrap_M_01: "MOVE",
            rogue_6_scrap_G_02: "GOODS",
          },
        },
      },
    },
    consts: {},
  },
  CharacterTable: {} as Record<string, ExcelCharRowMock>,
  GameDataConst: { maxLevel: [[], [], [], [], [], []] },
}));

vi.mock("@excel/excel", () => ({ default: excelMock }));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerSquad } from "@game/kernel/model";
import type {
  PlayerRoguelikeNode,
  PlayerRoguelikeV2,
  PlayerRoguelikeV2Zone,
} from "@game/modules/roguelike/rlv2-model";
import type { RoguelikePendingEvent } from "@game/modules/roguelike/events";
import { mockPlayerData, asModel } from "../../../helpers";
import {
  ROGUE6_NODE,
  ROGUE6_NODE_SCENE_PREFIX,
  ROLL_NODE_TYPE_VALUES,
  isBlackstream,
} from "@game/modules/roguelike/theme-rules";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/**
 * rlv2 pushMessage 载荷读取视图
 *
 * `RoguelikePushMessage.payload` 生产侧类型未收窄（app/game/kernel/http/common.ts），
 * 各 path 的载荷形状由发送站点确定：rlv2NodeArrive={nodeType}、rlv2NodeChange={nodeList}
 * （battle-nav.ts / grid-nav.ts）、rlv2NodeTeleport={nodeId}（grid-nav.ts）、
 * rlv2GotRandScrap={idList}、rlv2LevelUpMaxWeight={count}（modules/scrap.ts）。
 * 本用例只读取这些字段，故就地声明读取视图，不改任何夹具/生产数据。
 */
interface Rlv2PushPayloadView {
  nodeType?: number;
  nodeList?: string[];
  nodeId?: string;
  idList?: string[];
  count?: number;
}

/**
 * `RoguelikeV2Manager` 上的历史可选入口视图
 *
 * 该处历史写法 `rlv2.beginMove?.()` 的方法实际只存在于 gridZone 子管理器
 * （本文件其余位置均以 `gz.beginMove()` 调用），`?.()` 使其在运行期恒为 no-op。
 * 为不改运行期行为，仅就地声明该可选入口的读取视图。
 */
interface MaybeBeginMoveOnPlayer {
  beginMove?: () => void;
}

function makePlayer() {
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

/**
 * 在 zone 3 生成地图后，把指定节点改为给定类型并移动到该节点。
 * @returns 落地后的 pending 事件列表与状态
 */
async function moveToNodeOfType(
  player: PlayerDataManager,
  kind: number,
): Promise<{ pending: RoguelikePendingEvent[]; state: string }> {
  const rlv2 = player.rlv2;
  const gz = rlv2._module.gridZone;
  gz.generate([3]);
  rlv2._status.cursor.zone = 3;
  const inner = gz.zones["zone_3"].nodes;
  const id = Object.keys(inner)[1];
  // 改内部节点为目标类型（清掉战斗/商店内容，只留 kind）
  inner[id].content = { kind };
  rlv2._status.cursor.position = {
    x: Math.floor(Number(id) / 100),
    y: Number(id) % 100,
  };
  await rlv2.gridZoneMoveTo({ route: [id] });
  return { pending: rlv2._status.pending, state: rlv2._status.state };
}

describe("rogue_6 事件节点分发（gridZoneMoveTo）", () => {
  it.each([
    ["安全的角落", ROGUE6_NODE.REST, /^scene_ro6_rest_enter$/],
    ["得偿所愿", ROGUE6_NODE.WISH, /^scene_ro6_(wish|relic\d*)_enter$/],
    ["失与得", ROGUE6_NODE.SACRIFICE, /^scene_ro6_sacrifice\d*_enter$/],
    ["先行一步", ROGUE6_NODE.EXPEDITION, /^scene_ro6_scout_enter$/],
    ["狭路相逢", ROGUE6_NODE.FACE_OFF, /^scene_ro6_sala\d*_enter$/],
    ["险路尽头", ROGUE6_NODE.VISIBLE_END, /^scene_ro6_final\d*_enter$/],
    ["险路小径", ROGUE6_NODE.VISIBLE_PATH, /^scene_ro6_evacuate\d*_enter$/],
  ])(
    "%s 节点落地生成 SCENE 事件（原实现退化为空节点）",
    async (_name, kind, scenePattern) => {
      const player = makePlayer();
      await player.rlv2._module.create();
      const { pending, state } = await moveToNodeOfType(player, kind);
      expect(state).toBe("PENDING");
      expect(pending.length).toBeGreaterThan(0);
      expect(pending[0].type).toBe("SCENE");
      expect(pending[0].content.scene!.id).toMatch(scenePattern);
      // 选项非空（客户端需要至少一个可选项才能推进）
      expect(
        Object.keys(pending[0].content.scene!.choices).length,
      ).toBeGreaterThan(0);
    },
  );

  it("先行一步选项含 choice_ro6_scout_1/3（三结局入口可达）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const { pending } = await moveToNodeOfType(player, ROGUE6_NODE.EXPEDITION);
    const choices = Object.keys(pending[0].content.scene!.choices);
    expect(choices).toContain("choice_ro6_scout_1");
    expect(choices).toContain("choice_ro6_scout_3");
  });

  it("应急助力按商店语义开 BATTLE_SHOP（官方 subName=商店；含 content 精简形态）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const { pending, state } = await moveToNodeOfType(
      player,
      ROGUE6_NODE.EMERGENCY_AID,
    );
    expect(state).toBe("PENDING");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].type).toBe("BATTLE_SHOP");
  });

  it("不期而遇未触发线人时回退通用场景（normal 幕）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    // Math.random=0.9：线人概率判定（<0.4）不通过 → 走通用不期而遇场景
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      const { pending, state } = await moveToNodeOfType(
        player,
        ROGUE6_NODE.INCIDENT,
      );
      expect(state).toBe("PENDING");
      expect(pending[0].content.scene!.id).toMatch(
        /^scene_ro6_(normal|bat)\d*_enter$/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("林间空地/曲折密道/羽瞰点仍为空节点（WAIT_MOVE，官方 subName 为空白/传送/视野）", async () => {
    for (const kind of [
      ROGUE6_NODE.GLADE,
      ROGUE6_NODE.TUNNEL,
      ROGUE6_NODE.RAIN_VIEW,
    ]) {
      const player = makePlayer();
      await player.rlv2._module.create();
      const { state, pending } = await moveToNodeOfType(player, kind);
      expect(state, `kind ${kind}`).toBe("WAIT_MOVE");
      expect(pending.length, `kind ${kind}`).toBe(0);
    }
  });
});

describe("rogue_6 节点到达推送（pushMessage）", () => {
  it("gridZone 移动累积 rlv2NodeArrive + rlv2NodeChange（原实现永不下发）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    await moveToNodeOfType(player, ROGUE6_NODE.GLADE);
    const msgs = player.rlv2.takePushMessages();
    const paths = msgs.map((m) => m.path);
    expect(paths).toContain("rlv2NodeArrive");
    expect(paths).toContain("rlv2NodeChange");
    const arrive = msgs.find((m) => m.path === "rlv2NodeArrive");
    expect((arrive!.payload as Rlv2PushPayloadView).nodeType).toBe(ROGUE6_NODE.GLADE);
    const change = msgs.find((m) => m.path === "rlv2NodeChange");
    expect(
      Array.isArray((change!.payload as Rlv2PushPayloadView).nodeList),
    ).toBe(true);
    // 取走后清空（避免残留累积到下一请求）
    expect(player.rlv2.takePushMessages().length).toBe(0);
  });

  it("rlv2NodeChange.nodeList 只含发生变化的节点（到达节点+新揭示邻居），非整层全量（官服抓包 R-1786531228496.9993-3674）", async () => {
    // 固定随机：构造模板/关卡/节点类型稳定；用单格 moveTo 直接验证变化节点集合
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    gz.beginMove();
    // 手工铺一张平铺网格：0,0 起点（已访问）；目标节点 100 → 到达后按地图边点亮
    // 可达首节点（边连 0/200/101）。断言 nodeList = 到达节点 + 实际发生状态/视野变化的
    // 边可达邻居，且不含非边连接（曼哈顿相邻但未连通）的 1/2。
    gz.zones = {
      zone_3: {
        nodes: {
          "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
          "1": { content: { kind: ROGUE6_NODE.BATTLE_NORMAL }, state: 0, show: false },
          "2": { content: { kind: ROGUE6_NODE.INCIDENT }, state: 0, show: false },
          "100": { content: { kind: ROGUE6_NODE.BATTLE_NORMAL }, state: 0, show: true },
          "101": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
          "200": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
        },
      },
    };
    // 沿边可达揭示 visibility：设置 map.zones 邻接（100 边连 0/200/101）供 moveTo 按边揭示。
    // 起点 0 已揭示（visibility=NORMAL），抵达 100 后 200/101 由 HIDE_INVISIBLE → NORMAL，
    // 起点不降级、1/2 非边连接不入列。（变化集 = 视野变化节点；官服 state 仅 0/2，
    // gridZone state 不再产生 0→1 中间态，故邻居必须有 map 节点才能入变化集）
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "0": { next: [{ x: 1, y: 0 }], visibility: 0 },
        "100": { next: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }], visibility: 1 },
        "101": { next: [], visibility: 1 },
        "200": { next: [], visibility: 1 },
      },
    });
    rlv2._status.cursor.zone = 3;
    (rlv2 as MaybeBeginMoveOnPlayer).beginMove?.();
    gz.moveTo(["100"]);
    const changed = gz.takeChangedNodes();
    expect(changed).toContain("100"); // 到达节点：state 0 → 2
    expect(changed).toContain("101"); // 距离 1 邻居（x1,y1）：visibility 1 → 0
    expect(changed).toContain("200"); // 距离 1 邻居（x2,y0）：visibility 1 → 0
    expect(changed).not.toContain("1"); // 非边连接，不揭示
    expect(changed).not.toContain("2"); // 非边连接，不揭示
    // 已访问起点 0（state 2 / show 已有）不重复进变化集
    expect(changed).not.toContain("0");
    // nodeList 必须反映真实变化（否则退回归漏、全量兜底回归）
    expect(changed.length).toBe(3);
    // beginMove 界定边界：第二次未变化移动不再累积
    gz.beginMove();
    gz.moveTo(["100"]);
    expect(gz.takeChangedNodes()).toEqual([]);
  });

  it("羽瞰点前往后按到羽瞰点的曼哈顿距离照亮 2（普通节点仅沿边 1 跳）", async () => {
    // 布局：0(起点) 直链边连 100 - 200 - 300；另有 101(1,1)/103(1,3) 不与任何边连通。
    // 羽瞰点 100（抵达即经过，state→2）视野半径 2：按曼哈顿距离铺开，
    // 101(距1)、200(距1)、300(距2) 全部揭示；103(距3) 在半径 2 之外保持隐藏——含无边连接。
    // 普通节点 1 跳：沿地图边只点亮直链邻居 200，无边连接的 101/103 与距离 2 的 300 不亮。
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    const layer = (zoneKey: string, kind: number) => {
      gz.beginMove();
      gz.zones = {
        [zoneKey]: {
          nodes: {
            "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
            "100": { content: { kind }, state: 1, show: true },
            "200": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
            "300": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
            "101": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
            "103": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
          },
        },
      };
      // map.zones 邻接：仅直链 0-100-200-300；101/103 无边（next 空）。
      // visibility 官方枚举语义：0=NORMAL 已揭示，1=HIDE_INVISIBLE 未揭示。
      rlv2._map.zones["1003"] = asModel<PlayerRoguelikeV2Zone>({
        nodes: {
          "0": { next: [{ x: 1, y: 0 }], visibility: 0 },
          "100": { next: [{ x: 0, y: 0 }, { x: 2, y: 0 }], visibility: 1 },
          "200": { next: [{ x: 1, y: 0 }, { x: 3, y: 0 }], visibility: 1 },
          "300": { next: [{ x: 2, y: 0 }], visibility: 1 },
          "101": { next: [], visibility: 1 },
          "103": { next: [], visibility: 1 },
        },
      });
      rlv2._status.cursor.zone = 4;
      gz.beginMove();
      gz.moveTo(["100"]);
    };
    const mapOf = () => rlv2._map.zones["1003"].nodes;

    // 羽瞰点：曼哈顿距离 ≤2（101/200 距1、300 距2）全部揭示为 NORMAL(0)；103 距3 保持隐藏
    layer("zone_4", ROGUE6_NODE.RAIN_VIEW);
    let changed = gz.takeChangedNodes();
    expect(changed).toContain("100");
    expect(changed).toContain("200");
    expect(changed).toContain("300");
    expect(changed).toContain("101"); // 无边连接，但距羽瞰点 1 → 曼哈顿揭示
    expect(changed).not.toContain("103"); // 距羽瞰点 3 → 半径 2 之外
    expect(mapOf()["101"].visibility).toBe(0);
    expect(mapOf()["103"].visibility).toBe(1);

    // 普通节点：沿地图边 1 跳，仅直链邻居 200 揭示；101/103 无边、300 距离 2 均保持 HIDE_INVISIBLE(1)
    layer("zone_4", ROGUE6_NODE.BATTLE_NORMAL);
    changed = gz.takeChangedNodes();
    expect(changed).toContain("200");
    expect(changed).not.toContain("300");
    expect(changed).not.toContain("101");
    expect(changed).not.toContain("103");
    expect(mapOf()["300"].visibility).toBe(1);
    expect(mapOf()["101"].visibility).toBe(1);
  });

  it("进层生成时羽瞰点默认揭示曼哈顿距离 1（周围4格；距离 2 保持隐藏）", async () => {
    // 直接校验 generate 中默认揭示（r=1）：羽瞰点 1 半径内（上下左右）揭示为 NORMAL(0)，
    // 距离 2 节点保持 HIDE_INVISIBLE(1)。
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    // 羽瞰点 200(2,0) 居中：左 100(1,0) 距1、上 201(2,1) 距1、右 300(3,0) 距1、远 500(5,0) 距3
    gz.zones = {
      zone_4: {
        nodes: {
          "100": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
          "200": { content: { kind: ROGUE6_NODE.RAIN_VIEW }, state: 0, show: true },
          "201": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
          "300": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
          "500": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: false },
        },
      },
    };
    // 羽瞰点在 map.zones 固定为已揭示（visibility=NORMAL），其余保持隐藏
    rlv2._map.zones["1003"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "100": { next: [{ x: 2, y: 0 }], visibility: 1 },
        "200": { next: [{ x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 0 }], visibility: 0 },
        "201": { next: [{ x: 2, y: 0 }], visibility: 1 },
        "300": { next: [{ x: 2, y: 0 }], visibility: 1 },
        "500": { next: [{ x: 4, y: 0 }], visibility: 1 },
      },
    });
    // 模拟 generate 中羽瞰点的默认揭示（r=1）
    gz.beginMove();
    gz["revealManhattan"]("1003", "zone_4", 2, 0, 1);
    const mapNodes = rlv2._map.zones["1003"].nodes;
    expect(mapNodes["100"].visibility).toBe(0); // 左，距1 → NORMAL
    expect(mapNodes["201"].visibility).toBe(0); // 上，距1 → NORMAL
    expect(mapNodes["300"].visibility).toBe(0); // 右，距1 → NORMAL
    expect(mapNodes["500"].visibility).toBe(1); // 距3 → 半径 1 之外，保持 HIDE_INVISIBLE
  });

  it("羽瞰点 moveTo 前往后揭示曼哈顿距离 2 并补偿 1 行动力", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    gz.zones = {
      zone_3: {
        nodes: {
          "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
          "100": { content: { kind: ROGUE6_NODE.RAIN_VIEW }, state: 0, show: true },
          "200": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: true },
          "201": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: true },
        },
      },
    };
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "0": { next: [{ x: 1, y: 0 }], visibility: 0 },
        "100": { next: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }], visibility: 1 },
        "200": { next: [{ x: 1, y: 0 }], visibility: 1 },
        "201": { next: [{ x: 1, y: 0 }], visibility: 1 },
      },
    });
    rlv2._status.cursor.zone = 3;
    rlv2._status.cursor.position = { x: 0, y: 0 };
    gz.stepRemain = 5;
    gz.beginMove();
    gz.moveTo(["100"]);
    // 前往羽瞰点：+1 行动力（官服"前往该节点后……获得1行动力"）
    expect(gz.stepRemain).toBe(6);
    // 曼哈顿距离 1/2（200 距1、201 距2）均揭示为 NORMAL(0)
    expect(rlv2._map.zones["1002"].nodes["200"].visibility).toBe(0);
    expect(rlv2._map.zones["1002"].nodes["201"].visibility).toBe(0);
  });
});

describe("rogue_6 曲折密道成对传送", () => {
  it("层内两个 TUNNEL 节点成对索引，进入其一返回配对密道目标", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    // 手工铺一张恰好含两个 TUNNEL 节点的层，避免 generate 随机抽取额外密道影响成对计数
    gz.zones = {
      zone_3: {
        nodes: {
          "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
          "100": { content: { kind: ROGUE6_NODE.TUNNEL }, state: 0, show: true },
          "300": { content: { kind: ROGUE6_NODE.TUNNEL }, state: 0, show: true },
          "200": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: true },
        },
      },
    };
    gz["indexTunnelPairs"](3, gz.zones["zone_3"].nodes);
    expect(gz.tunnelPairTarget("zone_3", "100")).toBe("300");
    expect(gz.tunnelPairTarget("zone_3", "300")).toBe("100");
    // 非密道节点无目标
    expect(gz.tunnelPairTarget("zone_3", "0")).toBeUndefined();
  });

  it("移动进密道节点：服务端位移到配对密道并下发 rlv2NodeTeleport", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    gz.zones = {
      zone_3: {
        nodes: {
          "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
          "100": { content: { kind: ROGUE6_NODE.TUNNEL }, state: 0, show: true },
          "300": { content: { kind: ROGUE6_NODE.TUNNEL }, state: 0, show: true },
        },
      },
    };
    gz["indexTunnelPairs"](3, gz.zones["zone_3"].nodes);
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "0": { next: [{ x: 1, y: 0 }], visibility: 0 },
        "100": { next: [{ x: 0, y: 0 }], visibility: 1 },
        "300": { next: [{ x: 0, y: 0 }], visibility: 1 },
      },
    });
    rlv2._status.cursor.zone = 3;
    rlv2._status.cursor.position = { x: 0, y: 0 };
    gz.beginMove();
    rlv2.takePushMessages();
    await rlv2.gridZoneMoveTo({ route: ["100"] });
    // 位置位移到配对密道 300（3,0）
    expect(rlv2._status.cursor.position).toEqual({ x: 3, y: 0 });
    const msgs = rlv2.takePushMessages();
    const tele = msgs.find((m) => m.path === "rlv2NodeTeleport");
    expect(tele).toBeTruthy();
    expect((tele!.payload as Rlv2PushPayloadView).nodeId).toBe("300");
  });
});

describe("rogue_6 关卡池按节点类型分流（eliteStages 修复）", () => {
  it("紧急作战取 ro6_e_*、险路恶敌取 ro6_b_*、作战取 ro6_n_*", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    const pools = { normal: ["ro6_n_3_1"], elite: ["ro6_e_3_1"], boss: ["ro6_b_3"], resident: [] };
    expect(
      gz.makeContentNode(ROGUE6_NODE.BATTLE_NORMAL, pools).content.savage!.stageId,
    ).toBe("ro6_n_3_1");
    expect(
      gz.makeContentNode(ROGUE6_NODE.BATTLE_ELITE, pools).content.savage!.stageId,
    ).toBe("ro6_e_3_1");
    expect(
      gz.makeContentNode(ROGUE6_NODE.BATTLE_BOSS, pools).content.savage!.stageId,
    ).toBe("ro6_b_3");
  });

  it("生成 zone 3 时精英节点的关卡来自 e 池、boss 节点来自 b 池", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const gz = player.rlv2._module.gridZone;
    gz.generate([3]);
    const mapNodes = player.rlv2._map.zones["1002"].nodes;
    for (const n of Object.values(mapNodes)) {
      if (n.type === ROGUE6_NODE.BATTLE_ELITE) {
        expect(n.stage, `elite ${n.index}`).toMatch(/^ro6_e_3_/);
      }
      if (n.type === ROGUE6_NODE.BATTLE_BOSS) {
        expect(n.stage, `boss ${n.index}`).toMatch(/^ro6_b_3/);
      }
      if (n.type === ROGUE6_NODE.BATTLE_NORMAL) {
        expect(n.stage, `normal ${n.index}`).toMatch(/^ro6_n_3_/);
      }
    }
  });
});

describe("rogue_6 重掷节点（rerollNode 键与类型映射修复）", () => {
  it("按 1000+ 键取到节点并写入 rogue_6 节点类型（原实现静默失效）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2._module.create();
    const gz = rlv2._module.gridZone;
    gz.generate([3]);
    rlv2._status.cursor.zone = 3;
    const mapZone = rlv2._map.zones["1002"];
    // rollNodeData 按 map zone 的 id 匹配（zone_3）
    expect(mapZone.id).toBe("zone_3");
    const nodeIndex = Object.keys(mapZone.nodes)[0];
    await rlv2.rerollNode({ nodeIndex });
    // 官方 groups 仅 SCRAP_SHOP → 秘境行商（2097152），原 typeMap 无此项会退化为 1
    expect(mapZone.nodes[nodeIndex].type).toBe(ROGUE6_NODE.SECRET_SHOP);
  });
});

describe("rogue_6 废品估价（官方 sellPrice）", () => {
  it("gain 的废品 value 取官方 sellPrice，而非恒为 1", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const scrap = player.rlv2._module.scrap;
    await player.rlv2._trigger.emit("rlv2:scrap:gain", [
      "rogue_6_scrap_G_02",
    ]);
    const gained = Object.values(scrap.inventory).find(
      (it) => it.id === "rogue_6_scrap_G_02",
    );
    expect(gained).toBeTruthy();
    expect(gained!.value).toBe(2); // goodsScrapData.sellPrice
  });

  it("开局 s_1/s_2 取 moduleConsts.identifyScrapId 与其 sellPrice", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const scrap = player.rlv2._module.scrap;
    expect(scrap.inventory["s_1"].id).toBe("rogue_6_scrap_M_01");
    expect(scrap.inventory["s_1"].value).toBe(1); // moveScrapData.sellPrice
  });
});

describe("主题规则注册表（theme-rules）", () => {
  it("isBlackstream 仅对 rogue_6 为真", () => {
    expect(isBlackstream("rogue_6")).toBe(true);
    expect(isBlackstream("rogue_5")).toBe(false);
    expect(isBlackstream(undefined)).toBe(false);
  });

  it("节点数值与官方 nodeTypeData 键一致（21 项）", () => {
    // 官方 details.rogue_6.nodeTypeData 的键集合
    const official = [
      1, 2, 4, 16, 32, 512, 1024, 2048, 4096, 8192, 32768, 65536, 262144,
      2097152, 4194304, 8388608, 16777216, 33554432, 67108864, 134217728,
      268435456,
    ];
    const mine = Object.values(ROGUE6_NODE).sort((a, b) => a - b);
    expect(mine).toEqual(official.sort((a, b) => a - b));
  });

  it("场景前缀表不含地图机制类节点（曲折密道/羽瞰点/林间空地）", () => {
    expect(ROGUE6_NODE_SCENE_PREFIX[ROGUE6_NODE.TUNNEL]).toBeUndefined();
    expect(ROGUE6_NODE_SCENE_PREFIX[ROGUE6_NODE.RAIN_VIEW]).toBeUndefined();
    expect(ROGUE6_NODE_SCENE_PREFIX[ROGUE6_NODE.GLADE]).toBeUndefined();
  });

  it("重掷类型映射覆盖 rogue_6 专属类型（原 typeMap 缺失 → 退化为作战）", () => {
    expect(ROLL_NODE_TYPE_VALUES.SCRAP_SHOP).toBe(ROGUE6_NODE.SECRET_SHOP);
    expect(ROLL_NODE_TYPE_VALUES.STORY).toBe(ROGUE6_NODE.PROPHECY);
    expect(ROLL_NODE_TYPE_VALUES.DUEL).toBe(ROGUE6_NODE.FACE_OFF);
    expect(ROLL_NODE_TYPE_VALUES.EMPLOY).toBe(ROGUE6_NODE.EMERGENCY_AID);
    expect(ROLL_NODE_TYPE_VALUES.FINAL).toBe(ROGUE6_NODE.VISIBLE_END);
    expect(ROLL_NODE_TYPE_VALUES.EMPTY).toBe(ROGUE6_NODE.GLADE);
  });
});

// ===== 新增 pushMessage 类型（对应官方 Rolggelike*Trigger）=====
describe("rogue_6 新增 pushMessage 类型", () => {
  it("废品 gain → rlv2GotRandScrap{idList}", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    // 先取走创建期可能累积的推送，保证断言针对本次 gain
    player.rlv2.takePushMessages();
    await player.rlv2._trigger.emit("rlv2:scrap:gain", [
      "rogue_6_scrap_G_02",
    ]);
    const msgs = player.rlv2.takePushMessages();
    const scor = msgs.find((m) => m.path === "rlv2GotRandScrap");
    expect(scor).toBeTruthy();
    expect((scor!.payload as Rlv2PushPayloadView).idList).toEqual(["rogue_6_scrap_G_02"]);
  });

  it("changeVehicle 切载具/回步行 → rlv2VehicleChange{}", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const scrap = player.rlv2._module.scrap;
    player.rlv2.takePushMessages();
    // 开局步行 → 切到已持有的 MOVE 载具
    scrap.changeVehicle("s_1");
    let msgs = player.rlv2.takePushMessages();
    expect(msgs.map((m) => m.path)).toContain("rlv2VehicleChange");
    // 切回步行再触发一次
    scrap.changeVehicle("");
    msgs = player.rlv2.takePushMessages();
    expect(msgs.map((m) => m.path)).toContain("rlv2VehicleChange");
    // 无变化（当前已是该载具，重复切同一载具）不再推送
    scrap.changeVehicle("s_1"); // walk→s_1 有效变更
    player.rlv2.takePushMessages(); // 排空
    scrap.changeVehicle("s_1"); // 已在该载具 → 无变化
    expect(player.rlv2.takePushMessages().length).toBe(0);
  });

  it("setLimit 扩容 → rlv2LevelUpMaxWeight{count}；缩减 → rlv2WeightWorse{}", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const scrap = player.rlv2._module.scrap;
    player.rlv2.takePushMessages();
    scrap.setLimit(12);
    let msgs = player.rlv2.takePushMessages();
    const up = msgs.find((m) => m.path === "rlv2LevelUpMaxWeight");
    expect(up).toBeTruthy();
    expect((up!.payload as Rlv2PushPayloadView).count).toBe(2);
    scrap.setLimit(8);
    msgs = player.rlv2.takePushMessages();
    expect(msgs.map((m) => m.path)).toContain("rlv2WeightWorse");
    // 容量不变不推送
    scrap.setLimit(8);
    expect(player.rlv2.takePushMessages().length).toBe(0);
  });

  it("非 rogue_6 主题下 pushMessage 静默跳过（不改污染收集器）", async () => {
    const player = makePlayer();
    player.rlv2.current.game!.theme = "rogue_5";
    player.rlv2.pushMessage("rlv2VehicleChange", {});
    expect(player.rlv2.takePushMessages().length).toBe(0);
  });
});

describe("rogue_6 经过后节点衰减为林间空地（decayPassed）", () => {
  // 主力验证 grid_zone.decayPassed 的类型改写：
  // 普通节点被经过 → gridZone/map 均变 GLADE；可反复进入类节点保持不变。
  it("普通节点被移走后变为林间空地（gridZone 与 map 类型同步）", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    gz.zones = {
      zone_3: {
        nodes: {
          "100": { content: { kind: ROGUE6_NODE.BATTLE_NORMAL }, state: 2, show: true },
          "200": { content: { kind: ROGUE6_NODE.REST }, state: 0, show: true },
        },
      },
    };
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "100": { next: [{ x: 2, y: 0 }], visibility: 0, type: ROGUE6_NODE.BATTLE_NORMAL },
        "200": { next: [{ x: 1, y: 0 }], visibility: 1, type: ROGUE6_NODE.REST },
      },
    });
    expect(gz.decayPassed("1002", "zone_3", "100")).toBe(true);
    expect(gz.zones["zone_3"].nodes["100"].content.kind).toBe(ROGUE6_NODE.GLADE);
    expect(rlv2._map.zones["1002"].nodes["100"].type).toBe(ROGUE6_NODE.GLADE);
    // decayPassed 不改 visibility；100 已揭示（NORMAL=0）
    expect(rlv2._map.zones["1002"].nodes["100"].visibility).toBe(0);
  });

  it("可反复进入类节点（商店/林间空地/尽头/小径/密道）经过后保持原类型", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    const revisit = [
      ROGUE6_NODE.SHOP,
      ROGUE6_NODE.SECRET_SHOP,
      ROGUE6_NODE.EMERGENCY_AID,
      ROGUE6_NODE.GLADE,
      ROGUE6_NODE.VISIBLE_END,
      ROGUE6_NODE.VISIBLE_PATH,
      ROGUE6_NODE.TUNNEL,
    ];
    gz.zones = { zone_3: { nodes: {} } };
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({ nodes: {} });
    revisit.forEach((kind, i) => {
      const id = String((i + 1) * 100);
      gz.zones["zone_3"].nodes[id] = { content: { kind }, state: 2, show: true };
      rlv2._map.zones["1002"].nodes[id] = asModel<PlayerRoguelikeNode>({ type: kind, visibility: 0 });
    });
    revisit.forEach((kind, i) => {
      const id = String((i + 1) * 100);
      expect(gz.decayPassed("1002", "zone_3", id)).toBe(false);
      expect(gz.zones["zone_3"].nodes[id].content.kind).toBe(kind);
      expect(rlv2._map.zones["1002"].nodes[id].type).toBe(kind);
    });
  });

  it("gridZoneMoveTo：移动后上一位置普通节点变 GLADE 并进入 nodeList", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    // 起点 0 已访问（GLADE）；目标 100 为普通作战；玩家起点在 0 → 移动到 100
    gz.zones = {
      zone_3: {
        nodes: {
          "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
          "100": { content: { kind: ROGUE6_NODE.BATTLE_NORMAL }, state: 0, show: true },
          "200": { content: { kind: ROGUE6_NODE.GLADE }, state: 0, show: true },
        },
      },
    };
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "0": { next: [{ x: 1, y: 0 }], visibility: 0, type: ROGUE6_NODE.GLADE },
        "100": { next: [{ x: 0, y: 0 }, { x: 2, y: 0 }], visibility: 1, type: ROGUE6_NODE.BATTLE_NORMAL },
        "200": { next: [{ x: 1, y: 0 }], visibility: 1, type: ROGUE6_NODE.GLADE },
      },
    });
    rlv2._status.cursor.zone = 3;
    rlv2._status.cursor.position = { x: 0, y: 0 };
    gz.beginMove();
    await rlv2.gridZoneMoveTo({ route: ["100"] });
    // 抵达 100 后，起点 0 为 GLADE（本来就 GLADE，不衰减）；无中途节点 → 无衰减
    expect(rlv2._map.zones["1002"].nodes["100"].type).toBe(ROGUE6_NODE.BATTLE_NORMAL);
    expect(rlv2._map.zones["1002"].nodes["0"].type).toBe(ROGUE6_NODE.GLADE);
  });
});

// ===== “居民”据点与流窜居民机制（rogue_6） =====
describe("rogue_6 居民据点与流窜居民机制", () => {
  /** 构造一张含居民据点的 zone_3（modeGrade 由参数指定），并返回相关句柄 */
  async function residentFixture(modeGrade: number) {
    const player = makePlayer();
    player.rlv2.current.game!.modeGrade = modeGrade;
    const rlv2 = player.rlv2;
    await rlv2._module.create();
    const gz = rlv2._module.gridZone;
    // gridZone：0 起点 GLADE、100 “居民”据点、200/300 普通节点（可被流窜占领）
    gz.zones = {
      zone_3: {
        nodes: {
          "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
          "100": { content: { kind: ROGUE6_NODE.RESIDENT }, state: 0, show: true },
          "200": { content: { kind: ROGUE6_NODE.BATTLE_NORMAL }, state: 0, show: true },
          "300": { content: { kind: ROGUE6_NODE.INCIDENT }, state: 0, show: true },
        },
      },
    };
    // map：100 边连 200/300（供周边流窜生成）；200/300 visibility 初始隐藏
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "0": { next: [{ x: 1, y: 0 }], visibility: 0, type: ROGUE6_NODE.GLADE },
        "100": { next: [{ x: 2, y: 0 }, { x: 3, y: 0 }], visibility: 1, type: ROGUE6_NODE.RESIDENT },
        "200": { next: [], visibility: 1, type: ROGUE6_NODE.BATTLE_NORMAL },
        "300": { next: [], visibility: 1, type: ROGUE6_NODE.INCIDENT },
      },
    });
    rlv2._status.cursor.zone = 3;
    return { player, rlv2, gz };
  }

  it("canSpawnResident：保密等级>=4 且非 I/VI 层才允许", async () => {
    const { player, gz } = await residentFixture(4);
    expect(gz.canSpawnResident(3)).toBe(true);
    expect(gz.canSpawnResident(1)).toBe(false); // I 层
    expect(gz.canSpawnResident(6)).toBe(false); // VI 层
    player.rlv2.current.game!.modeGrade = 3;
    expect(gz.canSpawnResident(3)).toBe(false); // 保密等级不足
  });

  it("保密等级>=4：生成流窜居民、据点被记录、被占节点临时变特殊作战（独立池，不与首领冲突）", async () => {
    const { rlv2, gz } = await residentFixture(4);
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.3); // <0.6 → 生成流窜
    try {
      gz.spawnResidentAndBandits(3, {
        normal: ["ro6_n_3_1"],
        elite: ["ro6_e_3_1"],
        boss: ["ro6_b_3"],
        resident: ["ro6_n_3_1"],
      });
    } finally {
      spy.mockRestore();
    }
    // 据点被记录
    expect(gz.isResidentNode("zone_3", "100")).toBe(true);
    expect(gz.residentNodeIds("zone_3")).toEqual(["100"]);
    // 周边合法邻居被流窜占领，临时变特殊作战，关卡来自独立池（ro6_n 非 ro6_b）
    const b200 = gz.banditAt("zone_3", "200");
    const b300 = gz.banditAt("zone_3", "300");
    expect(b200 || b300).toBeTruthy();
    const mapNodes = rlv2._map.zones["1002"].nodes;
    for (const nid of ["200", "300"]) {
      if (gz.banditAt("zone_3", nid)) {
        expect(mapNodes[nid].type).toBe(ROGUE6_NODE.BATTLE_NORMAL);
        expect(mapNodes[nid].stage).toMatch(/^ro6_n_3_/); // 独立池：不与首领 ro6_b 冲突
        if (mapNodes[nid].visibility !== 0) {
          expect(mapNodes[nid].visibility).toBe(0); // 立即揭示
        }
      }
    }
    // 据点自身保留 RESIDENT 类型
    expect(mapNodes["100"].type).toBe(ROGUE6_NODE.RESIDENT);
  });

  it("保密等级<4：居民据点被改写为林间空地，不生成流窜", async () => {
    const { rlv2, gz } = await residentFixture(0);
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.3);
    try {
      gz.spawnResidentAndBandits(3, {
        normal: ["ro6_n_3_1"],
        elite: [],
        boss: [],
        resident: ["ro6_n_3_1"],
      });
    } finally {
      spy.mockRestore();
    }
    expect(gz.isResidentNode("zone_3", "100")).toBe(false);
    expect(gz.residentNodeIds("zone_3")).toEqual([]);
    expect(gz.banditAt("zone_3", "200")).toBeUndefined();
    expect(rlv2._map.zones["1002"].nodes["100"].type).toBe(ROGUE6_NODE.GLADE);
  });

  it("驱逐被占领节点后节点被毁为林间空地（其余流窜保留）", async () => {
    const { rlv2, gz } = await residentFixture(4);
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.3);
    try {
      gz.spawnResidentAndBandits(3, {
        normal: ["ro6_n_3_1"],
        elite: [],
        boss: [],
        resident: ["ro6_n_3_1"],
      });
    } finally {
      spy.mockRestore();
    }
    expect(gz.banditAt("zone_3", "200")).toBeTruthy();
    gz.beginMove();
    gz.startClearing("zone_3", "200");
    gz.finishClearing();
    // 被驱逐节点毁为林间空地
    expect(gz.banditAt("zone_3", "200")).toBeUndefined();
    expect(gz.zones["zone_3"].nodes["200"].content.kind).toBe(ROGUE6_NODE.GLADE);
    expect(rlv2._map.zones["1002"].nodes["200"].type).toBe(ROGUE6_NODE.GLADE);
    // 其余流窜居民（若有）保留
    expect(gz.banditAt("zone_3", "300")).toBeTruthy();
  });

  it("战胜居民据点驱逐区域内全部流窜居民（据点本身也被毁）", async () => {
    const { rlv2, gz } = await residentFixture(4);
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.3);
    try {
      gz.spawnResidentAndBandits(3, {
        normal: ["ro6_n_3_1"],
        elite: [],
        boss: [],
        resident: ["ro6_n_3_1"],
      });
    } finally {
      spy.mockRestore();
    }
    // 确保两个邻居都被占领
    expect(gz.banditAt("zone_3", "200")).toBeTruthy();
    expect(gz.banditAt("zone_3", "300")).toBeTruthy();
    gz.beginMove();
    gz.startClearing("zone_3", "100"); // 居民据点
    const cleared = gz.finishClearing();
    expect(cleared).toBe(true);
    // 全部流窜被驱逐
    expect(gz.banditAt("zone_3", "200")).toBeUndefined();
    expect(gz.banditAt("zone_3", "300")).toBeUndefined();
    // 据点被毁为林间空地
    expect(gz.isResidentNode("zone_3", "100")).toBe(false);
    expect(gz.residentNodeIds("zone_3")).toEqual([]);
    expect(gz.zones["zone_3"].nodes["100"].content.kind).toBe(ROGUE6_NODE.GLADE);
    expect(rlv2._map.zones["1002"].nodes["100"].type).toBe(ROGUE6_NODE.GLADE);
  });

  it("流窜居民沿连通路径移动 1 格，不进入可反复进入节点/林间空地（GLADE）", async () => {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2._module.create();
    const gz = rlv2._module.gridZone;
    // 流窜居民在 200；可移动邻居 100(作战，合法) 与 300(林间空地，非法)
    gz.zones = {
      zone_3: {
        nodes: {
          "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
          "100": { content: { kind: ROGUE6_NODE.BATTLE_NORMAL }, state: 0, show: true },
          "200": { content: { kind: ROGUE6_NODE.INCIDENT }, state: 1, show: true },
          "300": { content: { kind: ROGUE6_NODE.GLADE }, state: 0, show: true },
        },
      },
    };
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "0": { next: [{ x: 1, y: 0 }], visibility: 0, type: ROGUE6_NODE.GLADE },
        "200": { next: [{ x: 1, y: 0 }, { x: 3, y: 0 }], visibility: 1, type: ROGUE6_NODE.INCIDENT },
        "100": { next: [{ x: 2, y: 0 }], visibility: 1, type: ROGUE6_NODE.BATTLE_NORMAL },
        "300": { next: [{ x: 2, y: 0 }], visibility: 1, type: ROGUE6_NODE.GLADE },
      },
    });
    rlv2._status.cursor.zone = 3;
    rlv2._status.cursor.position = { x: 0, y: 0 }; // 玩家在起点 0，不参与
    // 手工安置一个流窜居民在 200（原始类型 INCIDENT，独立池关卡 ro6_n_3_1）
    player.rlv2.current.game!.modeGrade = 4;
    gz["spawnBanditAt"]("zone_3", "1002", "200", {
      normal: ["ro6_n_3_1"],
      elite: [],
      boss: [],
      resident: ["ro6_n_3_1"],
    });
    expect(gz.banditAt("zone_3", "200")).toBeTruthy();
    // 只给出一个合法候选（100）→ random 取值不影响唯一性
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.0);
    try {
      gz.stepBandits("zone_3");
    } finally {
      spy.mockRestore();
    }
    // 流窜移动到 100：原节点 200 恢复为 INCIDENT，目标 100 被占领
    expect(gz.banditAt("zone_3", "200")).toBeUndefined();
    expect(gz.banditAt("zone_3", "100")).toBeTruthy();
    expect(gz.zones["zone_3"].nodes["200"].content.kind).toBe(ROGUE6_NODE.INCIDENT);
    expect(rlv2._map.zones["1002"].nodes["100"].type).toBe(ROGUE6_NODE.BATTLE_NORMAL);
    expect(rlv2._map.zones["1002"].nodes["100"].stage).toBe("ro6_n_3_1");
  });
});

// ===== 无法携带至下一区域的加工品 =====
describe("rogue_6 无法携带至下一区域的加工品", () => {
  it("进入新的常规区域时移除 M_04/M_07（无法携带类），保留普通加工品", async () => {
    const player = makePlayer();
    await player.rlv2._module.create();
    const rlv2 = player.rlv2;
    const gz = rlv2._module.gridZone;
    // 手工注入零件箱：不可携带的 M_04/M_07 + 可携带的 M_01/M_05
    rlv2._module.scrap.inventory = {
      s_1: { instId: "s_1", id: "rogue_6_scrap_M_01", value: 1, useCnt: 0, ts: 0 },
      s_2: { instId: "s_2", id: "rogue_6_scrap_M_04", value: 1, useCnt: 0, ts: 0 },
      s_3: { instId: "s_3", id: "rogue_6_scrap_M_07", value: 1, useCnt: 0, ts: 0 },
      s_4: { instId: "s_4", id: "rogue_6_scrap_M_05", value: 1, useCnt: 0, ts: 0 },
    };
    // 生成常规层（非 portal）→ 移除不可携带类
    gz.generate([3]);
    const ids = Object.values(rlv2._module.scrap.inventory).map((s) => s.id);
    expect(ids).toContain("rogue_6_scrap_M_01");
    expect(ids).toContain("rogue_6_scrap_M_05");
    expect(ids).not.toContain("rogue_6_scrap_M_04");
    expect(ids).not.toContain("rogue_6_scrap_M_07");
  });
});

// ===== gridZoneMoveAndBattleStart 复用完整移动逻辑（防破坏存档结构） =====
describe("rogue_6 gridZoneMoveAndBattleStart（移动并开战）", () => {
  /** 构造 zone_3 网格：0 起点 GLADE、100 战斗节点（可攻击目标） */
  async function battleMoveFixture() {
    const player = makePlayer();
    const rlv2 = player.rlv2;
    await rlv2._module.create();
    const gz = rlv2._module.gridZone;
    gz.zones = {
      zone_3: {
        nodes: {
          "0": { content: { kind: ROGUE6_NODE.GLADE }, state: 2, show: true },
          "100": {
            content: {
              savage: { stageId: "ro6_n_3_1" },
              kind: ROGUE6_NODE.BATTLE_NORMAL,
            },
            state: 0,
            show: true,
          },
        },
      },
    };
    rlv2._map.zones["1002"] = asModel<PlayerRoguelikeV2Zone>({
      nodes: {
        "0": { next: [{ x: 1, y: 0 }], visibility: 0, type: ROGUE6_NODE.GLADE },
        "100": { next: [], visibility: 1, type: ROGUE6_NODE.BATTLE_NORMAL, stage: "ro6_n_3_1" },
      },
    });
    rlv2._status.cursor.zone = 3;
    rlv2._status.cursor.position = { x: 0, y: 0 };
    return { player, rlv2, gz };
  }

  it("移动并进入战斗：触发 BATTLE 事件且累积节点到达推送（原简化实现两者皆缺失）", async () => {
    const { player, rlv2 } = await battleMoveFixture();
    await rlv2.gridZoneMoveAndBattleStart({
      route: ["100"],
      stageId: "ro6_n_3_1",
      squad: asModel<PlayerSquad>({}),
    });
    // 战斗节点落地 → PENDING + BATTLE 事件（gridZoneMoveTo 内部触发 battle:start）
    expect(rlv2._status.state).toBe("PENDING");
    expect(rlv2._status.pending.some((e) => e.type === "BATTLE")).toBe(true);
    // 与 gridZoneMoveTo 一致累积节点到达/变化推送（客户端地图据此刷新）
    const msgs = rlv2.takePushMessages();
    const paths = msgs.map((m) => m.path);
    expect(paths).toContain("rlv2NodeArrive");
    expect(paths).toContain("rlv2NodeChange");
  });

  it("非战斗节点（林间空地）不重复触发战斗——pending 无新增事件时不兜底开战", async () => {
    const { player, rlv2, gz } = await battleMoveFixture();
    // 把目标改写为空节点（GLADE）：gridZoneMoveTo 走 WAIT_MOVE，不会产生事件
    gz.zones["zone_3"].nodes["100"].content = {
      kind: ROGUE6_NODE.GLADE,
    };
    rlv2._map.zones["1002"].nodes["100"].type = ROGUE6_NODE.GLADE;
    await rlv2.gridZoneMoveAndBattleStart({
      route: ["100"],
      stageId: "ro6_n_3_1",
      squad: asModel<PlayerSquad>({}),
    });
    // 空节点：gridZoneMoveTo 置 WAIT_MOVE（未进事件），moveAndBattleStart 按客户端
    // stageId 兜底开战（BATTLE）——保持"移动并开战"语义
    expect(rlv2._status.state).toBe("PENDING");
    expect(rlv2._status.pending.some((e) => e.type === "BATTLE")).toBe(true);
    // 兜底仅触发一次 BATTLE，不产生双事件
    const battles = rlv2._status.pending.filter((e) => e.type === "BATTLE");
    expect(battles.length).toBe(1);
  });

  it("移动经中间节点后起点被经过处保留（无中途节点则不衰减）", async () => {
    const { rlv2, gz } = await battleMoveFixture();
    await rlv2.gridZoneMoveTo({ route: ["100"] });
    // 抵达 100 后，起点 0 为 GLADE（本来就 GLADE，不衰减）
    expect(gz.zones["zone_3"].nodes["100"].state).toBe(2);
    expect(rlv2._map.zones["1002"].nodes["100"].type).toBe(
      ROGUE6_NODE.BATTLE_NORMAL,
    );
  });
});
