/**
 * GRID_ZONE 模块（rogue_6 网格区域——无相地图）
 *
 * 客户端状态形状（types-playerdata）：gridZone = {
 *   zones: { [zoneId]: { nodes: { [nodeId]: {
 *     content: { savage: { stageId }, shop: { goods[] } }, state, show } } } },
 *   stepRemain, needConfirmStepZero
 * }
 *
 * 黑流树海为"无相地图"：地图由官方构造模板（BLACKSTREAM_CONSTRUCTIONS）决定
 * 连通结构（occupiedSlots/edges/startSlot/terminalSlots），节点类型按
 * 距起点徒步最短距离（沿普通连线数边）落在距离规则（BLACKSTREAM_DISTANCE_RULES）
 * 与数量规则（BLACKSTREAM_COUNT_RULES）范围内。节点 ID 与官服一致：x*100+y。
 */
import { RoguelikeV2Manager } from "../logic";
import type { PlayerRoguelikeNode } from "../rlv2";
import excel from "@excel/excel";
import { TypedEventEmitter } from "../../../kernel/events/runtime";
import {
  BLACKSTREAM_CONSTRUCTIONS,
  BLACKSTREAM_COUNT_RULES,
  BLACKSTREAM_DISTANCE_RULES,
  BLACKSTREAM_LAYER_TYPES,
  BlackstreamConstruction,
} from "../data/blackstream-data";
import {
  ROGUE6_NODE,
  ROGUE6_BATTLE_NODES,
  ROGUE6_SHOP_NODES,
  ROGUE6_INITIALLY_LIT_NODES,
  ROGUE6_REVISITABLE_NODES,
  ROGUE6_FORESIGHT,
  ROGUE6_ZONE_ACTION,
  ROGUE6_WING_OUTBUFF,
  ROGUE6_NON_PORTABLE_SCRAPS,
  BLACKSTREAM_THEME,
  isBlackstream,
} from "../theme-rules";
import { random } from "@utils/random";

// 节点类型数值统一由 theme-rules 提供（单一事实来源）；此处 re-export 保持既有
// `import { ROGUE6_NODE } from "./modules/grid_zone"` 调用方不变。
export { ROGUE6_NODE };

interface GridNode {
  content: {
    savage?: { stageId: string };
    shop?: { goods: string[] };
    kind?: number;
  };
  state: number; // 0 未访问 / 1 可访问 / 2 已访问
  /**
   * 视野：false 未点亮 / true 可见
   *
   * 运行时为 boolean（toJSON 输出 boolean，见 tests）；生成模型
   * PlayerRoguelikeV2_CurrentData_Module_GridMapZoneNodeData.show 声明为 number，
   * 故按联合声明以兼容存档读回。
   */
  show: boolean | number;
}

interface GridZone {
  nodes: { [key: string]: GridNode };
}

/**
 * 存档 gridZone 视图（本模块 toJSON 落盘、continue 读回）
 *
 * 与生成模型 PlayerRoguelikeV2_CurrentData_Module_GridMapData 的差异：
 * needConfirmStepZero 运行时为 boolean（模型为 number）；portal 为服务端扩展键
 * （隐藏层状态，官服线格式无此键）。
 */
interface PersistedGridZone {
  zones?: { [key: string]: GridZone };
  stepRemain?: number;
  needConfirmStepZero?: boolean | number;
  portal?: GridPortalState | null;
}

/** 本层关卡池（按节点类型取用）：普通作战 / 紧急作战 / 险路恶敌 */
interface ZoneStagePools {
  normal: string[];
  elite: string[];
  boss: string[];
  /**
   * “居民”/流窜居民战斗关卡池——独立于首领池（老板 ro6_b_*）。
   * 官方 rogue_6.stages 无“流窜居民”专属关卡 id（全部为 ro6_n/e/b_*），
   * 故居民战斗复用普通作战池（ro6_n_*），前缀与首领池天然隔离、不冲突。
   */
  resident: string[];
}

/**
 * 流窜居民的单一占领状态：被占领节点临时变为特殊作战（独立关卡池），
 * 会阻碍徒步移动路线；前往作战驱逐后节点被毁（变林间空地）。
 */
interface Bandit {
  /** 所在层键（zone_N / portal 键） */
  zoneKey: string;
  /** 被占领节点 id（x*100+y） */
  nodeId: string;
  /** 被占前节点的原始类型（流窜离开/驱逐时恢复或销毁用） */
  originalType: number;
  /** 该流窜居民战斗的独立关卡 id */
  stageId: string;
}

/** 构造模板节点 type 字符串 → 节点数值（与官服 nodeTypeData 对齐） */
const CONSTRUCTION_TYPE_TO_NODE: { [key: string]: number } = {
  start: ROGUE6_NODE.GLADE,
  combat: ROGUE6_NODE.BATTLE_NORMAL,
  "emergency-combat": ROGUE6_NODE.BATTLE_ELITE,
  "danger-enemy": ROGUE6_NODE.BATTLE_BOSS,
  "safe-corner": ROGUE6_NODE.REST,
  encounter: ROGUE6_NODE.INCIDENT,
  wish: ROGUE6_NODE.WISH,
  "gain-loss": ROGUE6_NODE.SACRIFICE,
  "first-step": ROGUE6_NODE.EXPEDITION,
  "rogue-trader": ROGUE6_NODE.SHOP,
  "wrong-turn": ROGUE6_NODE.MIRAGE,
  "fate-choice": ROGUE6_NODE.PROPHECY,
  "narrow-meet": ROGUE6_NODE.FACE_OFF,
  "secret-trader": ROGUE6_NODE.SECRET_SHOP,
  "winding-path": ROGUE6_NODE.TUNNEL,
  "danger-end": ROGUE6_NODE.VISIBLE_END,
  "danger-path": ROGUE6_NODE.VISIBLE_PATH,
  "emergency-aid": ROGUE6_NODE.EMERGENCY_AID,
  overlook: ROGUE6_NODE.RAIN_VIEW,
  settlement: ROGUE6_NODE.RESIDENT,
  glade: ROGUE6_NODE.GLADE,
};

/**
 * 生成数据（blackstream-data.ts）中 nodeType 缺失的规则按中文标签解析。
 * 抽取脚本（已不存在）未映射「林间空地」→ 该规则 nodeType 为 null，
 * 导致林间空地从不进入候选类型（填充格全为事件/战斗节点）；按标签补解析。
 */
const RULE_LABEL_TO_NODE: { [label: string]: number } = {
  林间空地: ROGUE6_NODE.GLADE,
};

/** 层索引（0 起）→ 距离规则列索引：I II III IV IV追忆 V（官服 Ut 映射） */
function distanceColumnForLayer(layer: number): number {
  // 层 1..3 → 列 0..2；层 4 → 列 3（IV）；层 5 → 列 5（V）
  if (layer <= 3) return layer - 1;
  if (layer === 4) return 3;
  return 5;
}

/** 层（1 起）→ 数量规则列索引（I..V → 0..4） */
function countColumnForLayer(layer: number): number {
  return Math.min(4, layer - 1);
}

/** 误入奇境隐藏层（未萌生的摇篮）活动状态：
 * active=true 时当前地图为 portal zone（_map.zones 键 = portalZoneKey），
 * 行动力（stepRemain）耗尽后返回 returnZone/returnPos。
 * 乌托邦效果（variation）在进入时写入 portal zone 的 variation。 */
export interface GridPortalState {
  active: boolean;
  /** 返回区域（进入隐藏层前的 cursor.zone） */
  returnZone: number;
  /** 返回节点（进入隐藏层前的位置，x*100+y 节点 id） */
  returnNode: string;
  /** 本层乌托邦效果 id（variationData 键，如 variation_1） */
  variation: string;
  /** portal zone 在 _map.zones 的键（3000+ 避开常规 1000+ 键） */
  zoneKey: string;
  /** 进入时的场景族（portal1a/1b/2a…，用于返回提示/续局） */
  family: string;
}

/** 雾色场景族（scene_ro6_portalN → N）→ 乌托邦效果 id（variationData 键）。
 * 官方 variationData 共 9 条，与雾色一一对应：1~4=红雾（巨人摇篮/迪斯科狂热/已知浩劫/
 * 孤立石林，4 种战斗乌托邦）、5=蓝（全知者盲区）、6=绿（未亡者遗怨）、7=金（源石之城）、
 * 8=橙（消耗螺旋）、9=紫（换心联结）。
 *
 * 隐藏层构造模板不再硬编码：treehole-* 模板自带 `utopiaPortal`（单族）或
 * `utopiaPortals`（多族，红雾四族共用同一批模板）字段标注其所属雾色族，
 * 由 pickPortalTemplate 按该字段筛选。 */
function portalVariationIds(family: string): string[] {
  const n = parseInt(family, 10);
  // 红雾四族共用 variation_1..4（进入时随机取其一）；其余族与雾色一对一
  return n >= 1 && n <= 4
    ? ["variation_1", "variation_2", "variation_3", "variation_4"]
    : [`variation_${n}`];
}

export class RoguelikeGridZoneManager {
  zones: { [key: string]: GridZone };
  stepRemain: number;
  /** 首次进入是否需玩家确认初始位置（运行时 boolean；模型线格式为 number） */
  needConfirmStepZero: boolean | number;
  /** 误入奇境隐藏层活动状态（未进入时为 null） */
  portal: GridPortalState | null;
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;
  /**
   * 本层曲折密道（DOOR/TUNNEL）成对索引：zoneId(1 起) → [密道A id, 密道B id]。
   * 官方定义"曲折密道成对出现，进入后可传送到另一个密道节点位置"，由 generate 在本层
   * 生成完毕后收集恰好两个 TUNNEL 节点配对；供 moveTo 到达密道时确定传送目标。
   * 运行时计算（不落盘，进层重算）。
   */
  private _tunnelPairs: { [zoneId: string]: [string, string] };
  /**
   * 本次移动请求中发生状态/视野变化的节点 id 集合（rlv2NodeChange.nodeList 数据源）。
   * 官服 pushMessage 只下发"变化节点"（到达节点 + 新揭示邻居），非整层全量；
   * moveTo 内累积，由控制器经 beginMove/takeChangedNodes 界定一次请求生命周期。
   */
  private _changedNodeIds: Set<string>;
  /**
   * 本层“居民”据点节点（key = `${zoneKey}:${nodeId}` → true）：
   * 仅在保密等级（modeGrade）>=4 时生成，且不在 I、VI 层出现。
   */
  private _residentNodeKeys: Set<string>;
  /**
   * 被流窜居民占领的节点（key = `${zoneKey}:${nodeId}` → Bandit）：
   * 占领后节点临时变特殊作战（level 池），驱逐后节点被毁为林间空地。
   */
  private _bandits: Map<string, Bandit>;
  /** 当前进行中的驱逐战目标（战斗胜利后据此驱逐），null 表示非驱逐战斗 */
  private _clearingBandit: Bandit | null;
  /** 每次移动后流窜居民沿连通路径可移动的最大步数（官方每次 1 格） */
  private readonly BANDIT_STEP = 1;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this.zones = {};
    this.stepRemain = 20;
    this.needConfirmStepZero = false;
    this.portal = null;
    this._tunnelPairs = {};
    this._changedNodeIds = new Set();
    this._residentNodeKeys = new Set();
    this._bandits = new Map();
    this._clearingBandit = null;
    this._trigger.on("rlv2:module:init", this.init.bind(this));
    this._trigger.on("rlv2:continue", this.continue.bind(this));
    this._trigger.on("rlv2:zone:new", this.generate.bind(this));
    this._trigger.on("rlv2:grid:step", this.step.bind(this));
  }

  init(): void {
    this.zones = {};
    this.stepRemain = 20;
    this.needConfirmStepZero = false;
    this.portal = null;
    this._tunnelPairs = {};
    this._residentNodeKeys = new Set();
    this._bandits = new Map();
    this._clearingBandit = null;
  }

  continue(): void {
    const g: PersistedGridZone | undefined =
      this._player.current.module?.gridZone;
    this.zones = g?.zones || {};
    this.stepRemain = g?.stepRemain ?? 20;
    this.needConfirmStepZero =
      g?.needConfirmStepZero ?? false;
    this.portal = g?.portal ?? null;
    // 续局恢复 portal zone（_map.zones 键已在存档，无需重建）
    if (this.portal?.active && this.portal.zoneKey) {
      // 行动力已耗尽则立即返回（防续局卡在隐藏层）
      if (this.stepRemain <= 0) {
        this.leavePortal();
      }
    }
  }

  /** 官服节点 ID：x*100+y（抓包 route ["602","300"] 确认） */
  nodeId(x: number, y: number): string {
    return String(x * 100 + y);
  }

  /**
   * 生成当前层网格（黑流树海：构造模板 + 距起点边距离规则 + 层数量规则）
   * 从本层构造模板池随机选一张，按模板连通结构铺节点；
   * 起点固定 startSlot（林间空地/起点，可见可访问），终点为 terminalSlots
   * （险路尽头/险路恶敌），固定节点按模板类型放置，其余占位格按
   * 距起点徒步最短距离（沿 edges 数边）落在距离规则范围内。
   */
  generate([zoneId]: [number]): void {
    const theme = this._player.current.game!.theme;
    // 进入新区域（常规层）：移除"无法携带至下一区域"的加工品（官方 moveScrapData 描述
    // "无法被携带至下一区域"，如 M_04/M_07）。误入奇境特殊层经 generatePortal 生成，
    // 不走此方法，故 portal 进入/离开时自动豁免（官方"进入离开特殊层不会损坏此类加工品"）。
    this.dropNonPortableScraps();
    const detail = excel.RoguelikeTopicTable.details[theme];
    const stages = Object.keys(detail?.stages || {});
    const roNum = theme.slice(-1);

    // 本层关卡池：普通 / 紧急（精英）/ 首领分开取——原实现只用普通池，精英与首领
    // 节点也抽普通关卡（eliteStages 算完未用），导致紧急作战/险路恶敌难度与官服不符。
    const zoneStages = stages.filter((s) =>
      s.startsWith(`ro${roNum}_n_${zoneId}_`),
    );
    const eliteStages = stages.filter((s) =>
      s.startsWith(`ro${roNum}_e_${zoneId}_`),
    );
    // 首领关卡：ro6_b_{zone}（含 _b 变体，如 ro6_b_1_b 哀悼铁腕）
    const bossStages = stages.filter((s) =>
      new RegExp(`^ro${roNum}_b_${zoneId}(_|$)`).test(s),
    );
    // 缺失回退全主题普通/紧急关卡（层号越界或数据缺失时不至于无 stage）
    const all =
      zoneStages.length > 0
        ? zoneStages
        : stages.filter((s) => /^ro\d+_[ne]_\d+_/.test(s));
    const pools: ZoneStagePools = {
      normal: zoneStages.length > 0 ? zoneStages : all,
      elite: eliteStages.length > 0 ? eliteStages : all,
      boss: bossStages.length > 0 ? bossStages : all,
      // “居民”/流窜居民独立分池：复用本层普通作战（ro6_n_*），与首领池（ro6_b_*）隔离
      resident: zoneStages.length > 0 ? zoneStages : all,
    };

    // 层 index（0 起）→ 构造模板池（黑流树海 I..V 层；VI 为 boss 层）
    const layerIndex = Math.min(zoneId - 1, 5);
    const pool = BLACKSTREAM_CONSTRUCTIONS.filter(
      (c) => c.layerIndex === layerIndex,
    );
    const template: BlackstreamConstruction =
      pool.length > 0
        ? pool[Math.floor(random() * pool.length)]
        : BLACKSTREAM_CONSTRUCTIONS[0];

    const nodes: { [key: string]: GridNode } = {};

    // 距起点沿边距离（BFS over template.edges）
    const dist = this.edgeDistances(template);

    // 起点（官服 gridZone：GLADE 起点/林间空地节点 state=2——官服 state 语义
    // 0=普通/未访问、2=GLADE(起点/林间空地)；原 state=1 与官服不符，客户端
    // 按 state 渲染节点状态可能异常）
    const [sx, sy] = template.startSlot;
    nodes[this.nodeId(sx, sy)] = {
      content: { kind: ROGUE6_NODE.GLADE },
      state: 2,
      show: true,
    };

    // 终点（险路尽头/险路恶敌）——固定节点/终点状态可见
    const terminalType = template.terminalType;
    const terminalNode = CONSTRUCTION_TYPE_TO_NODE[terminalType] ?? ROGUE6_NODE.VISIBLE_END;
    for (const [tx, ty] of template.terminalSlots) {
      nodes[this.nodeId(tx, ty)] = this.makeContentNode(terminalNode, pools);
    }

    // 模板固定节点（固定 type 字符串）
    for (const f of template.fixedNodes || []) {
      const [fx, fy] = f.slot;
      nodes[this.nodeId(fx, fy)] = this.makeContentNode(
        CONSTRUCTION_TYPE_TO_NODE[f.type] ?? ROGUE6_NODE.INCIDENT,
        pools,
      );
    }

    // 其余占位格：按距离规则 + 数量规则抽类型
    const remaining = template.occupiedSlots.filter(
      ([x, y]) => !nodes[this.nodeId(x, y)],
    );
    // 起点相邻格一二层强制作战（官服 is={0:"combat",1:"combat"}）
    const startAdjacentCombat = layerIndex <= 1;
    const counts = this.typeCounts(template);
    for (const [x, y] of remaining) {
      const id = this.nodeId(x, y);
      const d = dist.get(id);
      const isStartAdjacent = d === 1;
      let type: number;
      if (d === undefined) {
        // 无边连通的孤立占位格：固定铺林间空地（避免不可达的事件/战斗节点；
        // 林间空地数量规则下限正好容纳此类填充）
        type = ROGUE6_NODE.GLADE;
      } else if (startAdjacentCombat && isStartAdjacent) {
        type = ROGUE6_NODE.BATTLE_NORMAL;
      } else {
        type = this.pickTypeByRules(zoneId, d, counts);
      }
      counts[type] = (counts[type] || 0) + 1;
      nodes[id] = this.makeContentNode(type, pools);
    }

    this.zones[`zone_${zoneId}`] = { nodes };
    // 同步官服 map.zones 全量结构（客户端地图渲染读 map.zones：index/pos/next/type/stage/visibility）
    this.syncMapZones(zoneId, template, nodes);
    // 曲折密道成对：本层若恰好有两个 TUNNEL 节点则记为密道对（供传送目标）；
    // 官方"几乎不出现/只在 III-V 层可成对"，层数量规则已约束 0 或 2。
    this.indexTunnelPairs(zoneId, nodes);
    // 进入区域 = 抵达起点：点亮起点沿地图边可达的首节点（初始仅特殊节点点亮，
    // 起点路径在此揭示，否则开局无可移动目标）。
    this.revealReachable(
      this.mapZoneKeyOf(`zone_${zoneId}`),
      `zone_${zoneId}`,
      template.startSlot[0],
      template.startSlot[1],
      1,
    );
    // 羽瞰点：出现时立即揭示自身及周围曼哈顿距离 1（官方"周围4格"；含上下左右 4 格）；
    // 前往后（经过，state=2）由 moveTo 扩大为曼哈顿距离 2（官方"周围12格"）并 +1 行动力。
    for (const [id, n] of Object.entries(nodes)) {
      if (n.content?.kind === ROGUE6_NODE.RAIN_VIEW) {
        this.revealManhattan(
          this.mapZoneKeyOf(`zone_${zoneId}`),
          `zone_${zoneId}`,
          Math.floor(Number(id) / 100),
          Number(id) % 100,
          1,
        );
      }
    }
    // “居民”据点：保密等级 >=4 时在其周边生成流窜居民标记并立即揭示；
    // 不满足条件（保密 <4 或 I/VI 层）则不会出现居民（生成后改写为林间空地）。
    this.spawnResidentAndBandits(zoneId, pools);
    // 进层揭示属于“初始版面”，不落入后续移动的 rlv2NodeChange.nodeList
    this._changedNodeIds = new Set();
    // 行动力：模板显式 action（VI 层/portal 等特殊层）优先，否则按层初始值 5/6/7/8/8
    this.stepRemain = template.action ?? this.initialActionForZone(zoneId);
    this.needConfirmStepZero = true;
    // 常规区域实托邦（难度≥2 起）：附加乌托邦效果（variation）到本层地图，客户端渲染区域效果。
    // 生成频率按难度分档：2~5 较低、6~11 提升（实托邦更频繁）、12+ 更高（晚期）；效果数值由客户端按难度处理。
    this.applyUtopiaVariation(zoneId);
  }

  /**
   * 常规区域实托邦：难度≥2 时按概率给本层附加乌托邦效果（map.zones[zone].variation）。
   * 官方规则：保密等级·2 起"实托邦将会在区域中生成"；6 起"更频繁地生成"；12 起"效果提升至晚期"。
   * 效果 id 取自 variationData（variation_1..9：巨人摇篮/迪斯科狂热/已知浩劫/孤立石林/全知者盲区/
   * 未亡者遗怨/源石之城/消耗螺旋/换心联结）；具体效果数值（早/中/晚期）由客户端按难度渲染。
   */
  private applyUtopiaVariation(zoneId: number): void {
    const theme = this._player.current.game?.theme ?? "";
    if (!isBlackstream(theme)) return;
    // 结局层（zone 6）不生成实托邦
    if (zoneId >= 6) return;
    const modeGrade = this._player.current.game?.modeGrade ?? 0;
    if (modeGrade < 2) return;
    const chance = modeGrade >= 12 ? 0.6 : modeGrade >= 6 ? 0.4 : 0.25;
    if (random() >= chance) return;
    const detail = excel.RoguelikeTopicTable.details[theme];
    const variations = Object.keys(detail?.variationData || {});
    if (variations.length === 0) return;
    const varId = variations[Math.floor(random() * variations.length)];
    const map = this._player._map;
    const key = String(1000 + zoneId - 1);
    if (map?.zones?.[key]) {
      map.zones[key].variation = [varId];
    }
  }

  /** 区域初始行动力（官方 I..V 层 5/6/7/8/8；【生命游戏】"翅膀"节点解锁后 Ⅰ 层 +1；
   * 襁褓天马（rogue_6_start_1）每区 +1 由官方 zone_into_reward buff 实现（进入区域发行动力物品）） */
  private initialActionForZone(zoneId: number): number {
    const base = ROGUE6_ZONE_ACTION[zoneId] ?? 8;
    let bonus = 0;
    const outer = this._player.outer?.[BLACKSTREAM_THEME];
    // 生命游戏"翅膀"节点（rogue_6_outbuff_37，RAW_TEXT_EFFECT"进入第一层时，行动力+1"）：Ⅰ 层初始行动力 6
    if (zoneId === 1 && outer?.buff?.unlocked?.[ROGUE6_WING_OUTBUFF]) {
      bonus += 1;
    }
    return base + bonus;
  }

  /**
   * 同步官服 map.zones（PlayerRoguelikeV2Dungeon）——与 module.gridZone 并存。
   * 键为层号（与控制器 _map.zones[zone] 读取一致），节点带 pos/next/type/stage/zone_end。
   */
  syncMapZones(
    zoneId: number,
    template: BlackstreamConstruction,
    lightNodes: { [key: string]: GridNode },
    mapKey?: string,
  ): void {
    const map = this._player._map;
    if (!map) return;
    const fullNodes: { [key: string]: PlayerRoguelikeNode } = {};
    // 邻接表：template.edges → next（官服 next 为 {x,y} 列表，按 x,y 排序）
    const adj: { [key: string]: { x: number; y: number }[] } = {};
    for (const [a, b] of template.edges) {
      const ia = this.nodeId(a[0], a[1]);
      const ib = this.nodeId(b[0], b[1]);
      (adj[ia] = adj[ia] || []).push({ x: b[0], y: b[1] });
      (adj[ib] = adj[ib] || []).push({ x: a[0], y: a[1] });
    }
    for (const id of Object.keys(lightNodes)) {
      const x = Math.floor(Number(id) / 100);
      const y = Number(id) % 100;
      const light = lightNodes[id];
      const next = (adj[id] || []).slice().sort((p, q) => p.x - q.x || p.y - q.y);
      // visibility（PlayerNodeForesightType 线格式）：0=NORMAL 已揭示可见（起点/初始点亮的
      // 特殊节点），1=HIDE_INVISIBLE 未揭示隐藏（非战斗节点——显名"未知的诡秘"），
      // 2=HIDE_BATTLE 未揭示的战斗节点（作战/紧急作战/险路恶敌/居民据点——显名"未知的凶戾"）。
      // 抵达时由 revealReachable/Manhattan 逐级揭示为 NORMAL。到达状态由 gridZone 节点 state 承载。
      const nodeType = this.lightType(light);
      const isStart =
        template.startSlot[0] === x && template.startSlot[1] === y;
      const visibility =
        isStart || ROGUE6_INITIALLY_LIT_NODES.includes(nodeType)
          ? ROGUE6_FORESIGHT.NORMAL
          : ROGUE6_BATTLE_NODES.includes(nodeType)
            ? ROGUE6_FORESIGHT.HIDE_BATTLE
            : ROGUE6_FORESIGHT.HIDE_INVISIBLE;
      const node: PlayerRoguelikeNode = {
        index: id,
        pos: { x, y },
        next,
        type: nodeType,
        visibility,
      };
      if (light.content?.savage?.stageId) node.stage = light.content.savage.stageId;
      // 终点（险路尽头/险路恶敌）标记 zone_end——控制器 checkZoneEnd 依赖
      const isTerminal = template.terminalSlots.some(
        ([tx, ty]) => tx === x && ty === y,
      );
      if (isTerminal) node.zone_end = true;
      fullNodes[id] = node;
    }
    // 官服 map.zones 键 = 区域索引（zone_1 → 1000），非层号；zone 带 variation + type
    map.zones[mapKey ?? String(1000 + zoneId - 1)] = {
      id: `zone_${zoneId}`,
      index: 1000 + zoneId - 1,
      nodes: fullNodes,
      variation: [],
      type: 0,
    };
  }

  /** GridNode 内容 → 官方节点 type 数值（savage/shop/kind 均带 type 冗余） */
  lightType(light: GridNode): number {
    if (typeof light.content?.kind === "number") return light.content.kind;
    if (light.content?.savage) return ROGUE6_NODE.BATTLE_NORMAL;
    if (light.content?.shop) return ROGUE6_NODE.SHOP;
    return ROGUE6_NODE.GLADE;
  }

  /** 距起点沿模板 edges 的最短步数（BFS），无连通时回退曼哈顿距离 */
  edgeDistances(template: BlackstreamConstruction): Map<string, number> {
    const dist = new Map<string, number>();
    const startId = this.nodeId(template.startSlot[0], template.startSlot[1]);
    dist.set(startId, 0);
    const adj: { [key: string]: string[] } = {};
    const addEdge = (a: string, b: string) => {
      (adj[a] = adj[a] || []).push(b);
      (adj[b] = adj[b] || []).push(a);
    };
    for (const [a, b] of template.edges) {
      addEdge(this.nodeId(a[0], a[1]), this.nodeId(b[0], b[1]));
    }
    const queue = [startId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of adj[cur] || []) {
        if (!dist.has(next)) {
          dist.set(next, dist.get(cur)! + 1);
          queue.push(next);
        }
      }
    }
    // 未连通占位格回退曼哈顿距离（羽瞰/终点的补漏）
    for (const [x, y] of template.occupiedSlots) {
      const id = this.nodeId(x, y);
      if (!dist.has(id)) {
        dist.set(
          id,
          Math.abs(x - template.startSlot[0]) +
            Math.abs(y - template.startSlot[1]),
        );
      }
    }
    return dist;
  }

  /** 本层各类型已占用计数（初始化：模板固定节点 + 终点） */
  typeCounts(template: BlackstreamConstruction): { [type: number]: number } {
    const counts: { [type: number]: number } = {};
    const count = (t: number) => {
      counts[t] = (counts[t] || 0) + 1;
    };
    count(ROGUE6_NODE.GLADE); // 起点
    const terminalType =
      CONSTRUCTION_TYPE_TO_NODE[template.terminalType] ?? ROGUE6_NODE.VISIBLE_END;
    for (const _t of template.terminalSlots) count(terminalType);
    for (const f of template.fixedNodes || []) {
      count(CONSTRUCTION_TYPE_TO_NODE[f.type] ?? ROGUE6_NODE.INCIDENT);
    }
    return counts;
  }

  /**
   * 按距离规则 + 数量规则选择节点类型。
   * 候选 = 距离规则允许该距离的本层类型（未定/— 跳过）；
   * 优先未达数量上限的类型；战斗类型优先（保持层内战斗占比）。
   */
  /**
   * 规则条目 → 节点类型数值：优先 nodeType 映射；nodeType 缺失（生成数据
   * 如「林间空地」）按中文标签解析。start 为固定起点，不参与填充格抽取/计数
   * （起点格由模板 startSlot 预置，若按 start 规则[1,1]限数会把填充林间空地上限错当 1）。
   */
  private ruleNodeValue(rule: {
    nodeType?: string | null;
    label?: string;
  }): number | undefined {
    if (!rule.nodeType || rule.nodeType === "start") {
      return RULE_LABEL_TO_NODE[rule.label ?? ""];
    }
    return CONSTRUCTION_TYPE_TO_NODE[rule.nodeType];
  }

  pickTypeByRules(
    layer: number,
    distance: number,
    counts: { [type: number]: number },
  ): number {
    const dCol = distanceColumnForLayer(layer);
    const cCol = countColumnForLayer(layer);

    // 距离规则表：nodeType → [min,max]，未定跳过，—（null）跳过；
    // nodeType 缺失的规则（林间空地）按标签解析，否则填充格永无林间空地
    const allowedByDistance = new Set<number>();
    for (const rule of BLACKSTREAM_DISTANCE_RULES) {
      const t = this.ruleNodeValue(rule);
      if (t === undefined) continue;
      const v = rule.values[dCol];
      if (!v || v === "unknown") continue;
      if (Array.isArray(v)) {
        const [min, max] = v;
        if (min !== null && distance >= min && (max === null || distance <= max)) {
          allowedByDistance.add(t);
        }
      } else if (typeof v === "object" && v.set) {
        if (v.set.includes(distance)) allowedByDistance.add(t);
      }
    }
    // 层允许类型过滤（BLACKSTREAM_LAYER_TYPES 用中文标签——映射回数值集合；
    // 隐藏层/portal（layer 6）无层类型表 → 跳过过滤，由距离规则限定类型范围）
    const layerTypes = BLACKSTREAM_LAYER_TYPES[layer - 1] || [];
    const layerNodeSet = this.layerTypeSet(layerTypes);
    const candidates =
      layerNodeSet.size > 0
        ? [...allowedByDistance].filter((t) => layerNodeSet.has(t))
        : [...allowedByDistance];

    // 数量规则：候选内未达上限的类型优先（林间空地等标签规则同样参与限数）
    const underLimit = candidates.filter((t) => {
      const rule = BLACKSTREAM_COUNT_RULES.find(
        (r) => this.ruleNodeValue(r) === t,
      );
      if (!rule) return true;
      const v = rule.values[cCol];
      if (!v) return true;
      let max: number | null = null;
      if (Array.isArray(v)) {
        max = v[1];
      } else if (typeof v === "object" && v.set) {
        const nums = v.set.filter((n): n is number => n !== null);
        max = nums.length > 0 ? Math.max(...nums) : null;
      }
      if (max === null) return true;
      return (counts[t] || 0) < max;
    });

    const pool = underLimit.length > 0 ? underLimit : candidates;
    if (pool.length === 0) return ROGUE6_NODE.GLADE;
    return pool[Math.floor(random() * pool.length)];
  }

  /** 层类型中文标签集合 → 节点数值集合 */
  layerTypeSet(labels: string[]): Set<number> {
    const labelToNode: { [key: string]: number } = {
      起点: ROGUE6_NODE.GLADE,
      林间空地: ROGUE6_NODE.GLADE,
      作战: ROGUE6_NODE.BATTLE_NORMAL,
      紧急作战: ROGUE6_NODE.BATTLE_ELITE,
      险路恶敌: ROGUE6_NODE.BATTLE_BOSS,
      安全的角落: ROGUE6_NODE.REST,
      不期而遇: ROGUE6_NODE.INCIDENT,
      得偿所愿: ROGUE6_NODE.WISH,
      失与得: ROGUE6_NODE.SACRIFICE,
      先行一步: ROGUE6_NODE.EXPEDITION,
      诡意行商: ROGUE6_NODE.SHOP,
      误入奇境: ROGUE6_NODE.MIRAGE,
      命运所指: ROGUE6_NODE.PROPHECY,
      狭路相逢: ROGUE6_NODE.FACE_OFF,
      秘境行商: ROGUE6_NODE.SECRET_SHOP,
      曲折密道: ROGUE6_NODE.TUNNEL,
      险路尽头: ROGUE6_NODE.VISIBLE_END,
      险路小径: ROGUE6_NODE.VISIBLE_PATH,
      应急助力: ROGUE6_NODE.EMERGENCY_AID,
      羽瞰点: ROGUE6_NODE.RAIN_VIEW,
      "“居民”据点": ROGUE6_NODE.RESIDENT,
      "流窜“居民”": ROGUE6_NODE.RESIDENT,
    };
    const set = new Set<number>();
    for (const l of labels) {
      const t = labelToNode[l];
      if (t !== undefined) set.add(t);
    }
    // 层列表含林间空地/起点时始终允许 GLADE 作填充
    if (labels.includes("林间空地") || labels.includes("起点")) set.add(ROGUE6_NODE.GLADE);
    return set;
  }

  /**
   * 构造 GridNode：战斗按类型取对应关卡池（普通/紧急/首领）+ kind，
   * 商店（诡意行商/秘境行商/应急助力）空货架 + kind，其余仅 kind；初始均未访问（state 0）。
   * 视野/点亮状态由 map.zones 节点的 visibility（PlayerNodeForesightType 线格式 0/1/2）表示，
   * gridZone 节点 show 恒为 true，不承担点亮语义——见 syncMapZones / revealReachable。
   * @param type 节点类型数值（ROGUE6_NODE）
   * @param pools 本层关卡池
   * @returns 网格节点
   */
  makeContentNode(type: number, pools: ZoneStagePools): GridNode {
    // 官服 gridZone 节点 state 仅取 0/2（官服抓包确证，无中间态）：
    // 初始点亮节点（险路尽头/险路恶敌/曲折密道/羽瞰点）= 2，其余 0；
    // 起点 GLADE 由 generate 显式置 2，填充林间空地仍为 0（未访问）；
    // 抵达后置 2（moveTo）。原实现揭示时置中间态 1 → 客户端可通行状态解析异常。
    const state =
      type !== ROGUE6_NODE.GLADE && ROGUE6_INITIALLY_LIT_NODES.includes(type)
        ? 2
        : 0;
    // “居民”据点使用独立关卡池（与首领 ro6_b_* 隔离）
    if (type === ROGUE6_NODE.RESIDENT) {
      const pool =
        pools.resident && pools.resident.length > 0 ? pools.resident : pools.normal;
      const stageId =
        pool[Math.floor(random() * Math.max(pool.length, 1))] || "";
      return { content: { savage: { stageId }, kind: type }, state, show: true };
    }
    if (ROGUE6_BATTLE_NODES.includes(type)) {
      const pool =
        type === ROGUE6_NODE.BATTLE_ELITE
          ? pools.elite
          : type === ROGUE6_NODE.BATTLE_BOSS
            ? pools.boss
            : pools.normal;
      const usable = pool.length > 0 ? pool : pools.normal;
      const stageId =
        usable[Math.floor(random() * Math.max(usable.length, 1))] || "";
      return { content: { savage: { stageId }, kind: type }, state, show: true };
    }
    if (ROGUE6_SHOP_NODES.includes(type)) {
      return { content: { shop: { goods: [] }, kind: type }, state, show: true };
    }
    return { content: { kind: type }, state, show: true };
  }

  /* ================= “居民”据点与流窜居民机制 ================= */

  /** 节点归组键（居民点/流窜占用的唯一索引键）：`${zoneKey}:${nodeId}` */
  private banditKeyOf(zoneKey: string, nodeId: string): string {
    return `${zoneKey}:${nodeId}`;
  }

  /**
   * “居民”据点是否允许在此层出现：保密等级（modeGrade）>=4 且非 I（zone 1）/VI（zone 6）层。
   * @param zoneId 区域号（1 起）
   * @returns 允许出现返回 true
   */
  canSpawnResident(zoneId: number): boolean {
    const grade = this._player.current.game?.modeGrade ?? 0;
    return grade >= 4 && zoneId !== 1 && zoneId !== 6;
  }

  /**
   * 本层“居民”据点节点 id 集合（用于判断驱逐时是否触发“驱逐区域内全部流窜居民”）。
   * @param zoneKey 层键（zone_N）
   * @returns 据点节点 id 列表
   */
  residentNodeIds(zoneKey: string): string[] {
    return [...this._residentNodeKeys]
      .filter((k) => k.startsWith(`${zoneKey}:`))
      .map((k) => k.slice(zoneKey.length + 1));
  }

  /**
   * 是否“居民”据点节点。
   * @param zoneKey 层键
   * @param nodeId 节点 id
   * @returns 是据点返回 true
   */
  isResidentNode(zoneKey: string, nodeId: string): boolean {
    return this._residentNodeKeys.has(this.banditKeyOf(zoneKey, nodeId));
  }

  /**
   * 生成阶段落地“居民”据点与流窜居民：
   * - 保密等级 <4 或 I/VI 层：不会出现“居民”，生成期铺入的 RESIDENT 节点改写为林间空地；
   * - 否则：逐个据点记录，在其周边生成若干流窜居民并立即揭示（据点 + 被占邻居）。
   * @param zoneId 区域号（1 起）
   * @param pools 本层关卡池（resident 独立池）
   */
  spawnResidentAndBandits(zoneId: number, pools: ZoneStagePools): void {
    const zoneKey = `zone_${zoneId}`;
    const zone = this.zones[zoneKey];
    if (!zone) return;
    const mapKey = this.mapZoneKeyOf(zoneKey);
    const mapNodes = this._player._map?.zones?.[mapKey]?.nodes || {};
    // 不满足出现条件：本层产生的 RESIDENT 节点全部改写为林间空地（保守，避免泄漏）
    if (!this.canSpawnResident(zoneId)) {
      for (const [id, n] of Object.entries(zone.nodes)) {
        if (n.content?.kind !== ROGUE6_NODE.RESIDENT) continue;
        n.content = { kind: ROGUE6_NODE.GLADE };
        if (mapNodes[id]) mapNodes[id].type = ROGUE6_NODE.GLADE;
      }
      return;
    }
    const residentIds = Object.keys(zone.nodes).filter(
      (id) => zone.nodes[id].content?.kind === ROGUE6_NODE.RESIDENT,
    );
    if (residentIds.length === 0) return;
    for (const rid of residentIds) {
      this._residentNodeKeys.add(this.banditKeyOf(zoneKey, rid));
      // 立即揭示：据点 + 其周边地图边邻居各 1 跳（初始版面，不进 rlv2NodeChange）
      this.revealReachable(mapKey, zoneKey, Math.floor(Number(rid) / 100), Number(rid) % 100, 1);
      // 周边邻居中生成若干流窜居民（占领）
      for (const nb of mapNodes[rid]?.next ?? []) {
        const nid = this.nodeId(nb.x, nb.y);
        const kind = zone.nodes[nid]?.content?.kind;
        if (typeof kind !== "number") continue;
        if (!this.isValidBanditTarget(mapKey, zoneKey, nid)) continue;
        // 每个据点随机在部分合法邻居上生成流窜居民（“若干”，最多 2 个）
        if (random() < 0.6) this.spawnBanditAt(zoneKey, mapKey, nid, pools);
      }
    }
  }

  /**
   * 合法性预判：节点能否被流窜居民占领/移入。
   * 不能移入：可反复进入的节点（含林间空地）、居民据点、已被占领节点、玩家当前所在。
   * @param mapKey _map.zones 键
   * @param zoneKey gridZone 键
   * @param nodeId 目标节点 id
   * @param playerId 玩家当前所在节点 id（空串表示无）
   * @returns 可占领返回 true
   */
  private isValidBanditTarget(
    mapKey: string,
    zoneKey: string,
    nodeId: string,
    playerId = "",
  ): boolean {
    const zone = this.zones[zoneKey];
    const zoneNode = zone?.nodes[nodeId];
    if (!zoneNode) return false;
    if (this._bandits.has(this.banditKeyOf(zoneKey, nodeId))) return false;
    if (nodeId === playerId) return false;
    const kind = zoneNode.content?.kind;
    if (typeof kind !== "number") return false;
    if (ROGUE6_REVISITABLE_NODES.includes(kind)) return false; // 可反复进入（含林间空地）
    if (this.isResidentNode(zoneKey, nodeId)) return false;
    // 玩家完成节点产生的林间空地（曾衰减为 GLADE 的节点）同样禁止——kind 已含 GLADE 在上面拦截
    void mapKey;
    return true;
  }

  /**
   * 生成流窜居民：占领指定节点，令其临时变特殊作战（独立关卡池 stageId）、改地图类型为作战，
   * visibility 立即揭示。驱逐后该节点被毁为林间空地。
   * @param zoneKey 层键
   * @param mapKey _map.zones 键
   * @param nodeId 被占领节点 id
   * @param pools 本层关卡池（resident 独立池）
   */
  private spawnBanditAt(
    zoneKey: string,
    mapKey: string,
    nodeId: string,
    pools: ZoneStagePools,
  ): void {
    const zone = this.zones[zoneKey];
    const zoneNode = zone?.nodes[nodeId];
    if (!zoneNode) return;
    const pool = pools.resident && pools.resident.length > 0 ? pools.resident : pools.normal;
    const stageId = pool[Math.floor(random() * Math.max(pool.length, 1))] || "";
    const originalType =
      typeof zoneNode.content?.kind === "number" ? zoneNode.content!.kind! : ROGUE6_NODE.GLADE;
    const bandit: Bandit = { zoneKey, nodeId, originalType, stageId };
    this._bandits.set(this.banditKeyOf(zoneKey, nodeId), bandit);
    // 占领：临时变特殊作战（gridZone + map 同步）
    zoneNode.content = { savage: { stageId }, kind: ROGUE6_NODE.BATTLE_NORMAL };
    const mapNode = this._player._map?.zones?.[mapKey]?.nodes?.[nodeId];
    if (mapNode) {
      mapNode.type = ROGUE6_NODE.BATTLE_NORMAL;
      mapNode.stage = stageId;
      mapNode.visibility = ROGUE6_FORESIGHT.NORMAL;
    }
    // 立即揭示：被占节点 state 0→1 可访问、并入变化集合
    if (zoneNode.state === 0) zoneNode.state = 1;
    this._changedNodeIds.add(nodeId);
  }

  /**
   * 查询节点是否被流窜居民占领。
   * @param zoneKey 层键
   * @param nodeId 节点 id
   * @returns 占领信息，未占领返回 undefined
   */
  banditAt(zoneKey: string, nodeId: string): Bandit | undefined {
    return this._bandits.get(this.banditKeyOf(zoneKey, nodeId));
  }

  /** 当前层全部被流窜居民占领的节点数组 */
  private banditsOf(zoneKey: string): Bandit[] {
    return [...this._bandits.values()].filter((b) => b.zoneKey === zoneKey);
  }

  /**
   * 记录驱逐战斗目标：玩家进入被占领节点 / 居民据点后触发战斗，战斗胜利由
   * finishClearing 据此驱逐。非驱逐战斗不设置（保持 null）。
   * @param zoneKey 层键
   * @param nodeId 触发战斗的节点 id
   */
  startClearing(zoneKey: string, nodeId: string): void {
    const bandit = this._bandits.get(this.banditKeyOf(zoneKey, nodeId));
    this._clearingBandit =
      bandit ??
      (this.isResidentNode(zoneKey, nodeId)
        ? { zoneKey, nodeId, originalType: ROGUE6_NODE.RESIDENT, stageId: "" }
        : null);
  }

  /**
   * 驱逐战斗胜利后的结算（rlv2 battleFinish 挂钩）：
   * - 驱逐目标为被流窜居民占领的节点 → 该节点被毁为林间空地；
   * - 驱逐目标为“居民”据点 → 驱逐该层全部流窜居民（同时据点被毁为林间空地）。
   * @returns 是否发生了驱逐
   */
  finishClearing(): boolean {
    const clearing = this._clearingBandit;
    this._clearingBandit = null;
    if (!clearing) return false;
    const bandits = this.banditsOf(clearing.zoneKey);
    if (this.isResidentNode(clearing.zoneKey, clearing.nodeId)) {
      // 居民据点：驱逐区域内全部流窜居民 + 据点本身被毁
      for (const b of bandits) this.destroyBanditNode(b);
      this.destroyResidentNode(clearing.zoneKey, clearing.nodeId);
      return true;
    }
    // 被流窜占领的节点：仅驱逐该节点（被毁为林间空地）
    const target = this._bandits.get(this.banditKeyOf(clearing.zoneKey, clearing.nodeId));
    if (target) this.destroyBanditNode(target);
    return true;
  }

  /** 把被流窜占领的节点驱逐为林间空地（gridZone 与 map 类型同步、移除占领、记为变化） */
  private destroyBanditNode(bandit: Bandit): void {
    const { zoneKey, nodeId } = bandit;
    this._bandits.delete(this.banditKeyOf(zoneKey, nodeId));
    const zoneNode = this.zones[zoneKey]?.nodes[nodeId];
    if (zoneNode) zoneNode.content = { kind: ROGUE6_NODE.GLADE };
    const mapKey = this.mapZoneKeyOf(zoneKey);
    const mapNode = this._player._map?.zones?.[mapKey]?.nodes?.[nodeId];
    if (mapNode) {
      mapNode.type = ROGUE6_NODE.GLADE;
      delete mapNode.stage;
    }
    this._changedNodeIds.add(nodeId);
  }

  /** 把“居民”据点节点销毁为林间空地（后续不再视为据点） */
  private destroyResidentNode(zoneKey: string, nodeId: string): void {
    this._residentNodeKeys.delete(this.banditKeyOf(zoneKey, nodeId));
    const zoneNode = this.zones[zoneKey]?.nodes[nodeId];
    if (zoneNode) zoneNode.content = { kind: ROGUE6_NODE.GLADE };
    const mapKey = this.mapZoneKeyOf(zoneKey);
    const mapNode = this._player._map?.zones?.[mapKey]?.nodes?.[nodeId];
    if (mapNode) {
      mapNode.type = ROGUE6_NODE.GLADE;
      delete mapNode.stage;
    }
    this._changedNodeIds.add(nodeId);
  }

  /**
   * 玩家每次移动后，所有流窜居民沿连通路径（地图边）移动 1 格（BANDIT_STEP）。
   * 不移动到：可反复进入的节点、居民据点、已被占领节点、玩家当前所在节点、
   * 玩家完成节点产生的林间空地。无合法目标时原地停留。
   * @param zoneKey 层键
   */
  stepBandits(zoneKey: string): void {
    const zone = this.zones[zoneKey];
    if (!zone) return;
    const mapKey = this.mapZoneKeyOf(zoneKey);
    const mapNodes = this._player._map?.zones?.[mapKey]?.nodes || {};
    const pos = this._player._status.cursor?.position;
    const playerId = pos ? this.nodeId(pos.x, pos.y) : "";
    for (let s = 0; s < this.BANDIT_STEP; s++) {
      const bands = this.banditsOf(zoneKey);
      for (const b of bands) {
        const neighbours = mapNodes[b.nodeId]?.next ?? [];
        const candidates = neighbours.filter((n) =>
          this.isValidBanditTarget(mapKey, zoneKey, this.nodeId(n.x, n.y), playerId),
        );
        if (candidates.length === 0) continue;
        const pick = candidates[Math.floor(random() * candidates.length)];
        const targetId = this.nodeId(pick.x, pick.y);
        this.moveBandit(zoneKey, mapKey, b, targetId);
      }
    }
  }

  /**
   * 流窜居民从当前节点移动到目标节点：释放原节点（恢复原始类型），占领目标节点。
   * @param zoneKey 层键
   * @param mapKey _map.zones 键
   * @param bandit 原占领信息
   * @param targetId 目标节点 id
   */
  private moveBandit(
    zoneKey: string,
    mapKey: string,
    bandit: Bandit,
    targetId: string,
  ): void {
    this._bandits.delete(this.banditKeyOf(zoneKey, bandit.nodeId));
    // 释放原节点：恢复原始类型（保留已被占领状态变化）
    const fromNode = this.zones[zoneKey]?.nodes[bandit.nodeId];
    if (fromNode) fromNode.content = { kind: bandit.originalType };
    const fromMap = this._player._map?.zones?.[mapKey]?.nodes?.[bandit.nodeId];
    if (fromMap) {
      fromMap.type = bandit.originalType;
      delete fromMap.stage;
    }
    this._changedNodeIds.add(bandit.nodeId);
    // 占领目标节点（复用原关卡）
    const toNode = this.zones[zoneKey]?.nodes[targetId];
    if (!toNode) return;
    const orig = typeof toNode.content?.kind === "number" ? toNode.content!.kind! : ROGUE6_NODE.GLADE;
    this._bandits.set(this.banditKeyOf(zoneKey, targetId), {
      zoneKey,
      nodeId: targetId,
      originalType: orig,
      stageId: bandit.stageId,
    });
    toNode.content = { savage: { stageId: bandit.stageId }, kind: ROGUE6_NODE.BATTLE_NORMAL };
    const toMap = this._player._map?.zones?.[mapKey]?.nodes?.[targetId];
    if (toMap) {
      toMap.type = ROGUE6_NODE.BATTLE_NORMAL;
      toMap.stage = bandit.stageId;
    }
    if (toNode.state === 0) toNode.state = 1;
    this._changedNodeIds.add(targetId);
  }

  /**
   * 移除"无法携带至下一区域"的加工品（进入新的常规区域时调用）。
   * 官方 moveScrapData 描述中"无法被携带至下一区域"的加工品（见
   * ROGUE6_NON_PORTABLE_SCRAPS）在离开当前区域进入下一层时会被丢弃。
   * 误入奇境特殊层（portal）不调用，故 portal 进入/离开不会触发此类加工品损坏。
   */
  private dropNonPortableScraps(): void {
    const scrap = this._player._module.scrap;
    if (!scrap?.inventory) return;
    for (const [instId, it] of Object.entries(scrap.inventory as { [k: string]: { id: string } })) {
      if (ROGUE6_NON_PORTABLE_SCRAPS.includes(it.id)) {
        delete scrap.inventory[instId];
      }
    }
  }

  /** 消耗一步行动力（rlv2:grid:step 事件处理器） */
  step(): void {
    if (this.stepRemain > 0) {
      this.stepRemain -= 1;
    }
    // 隐藏层行动力耗尽 → 返回进入时所在节点（官服：本层专用行动力耗尽后返回）
    if (this.portal?.active && this.stepRemain <= 0) {
      this.leavePortal();
    }
  }

  /**
   * 按雾色场景族抽取隐藏层构造模板（utopia-* 系列，layerIndex=6）。
   * 模板归属由数据字段决定：`utopiaPortal`（单族，如 treehole-05 = 5 蓝雾/全知者盲区）
   * 或 `utopiaPortals`（多族，treehole-01..04 = [1,2,3,4] 红雾四族共用）。
   * @param family 雾色场景族数字字符串（1..9）
   * @returns 构造模板；无匹配时回退任一隐藏层模板
   */
  private pickPortalTemplate(family: string): BlackstreamConstruction {
    const n = parseInt(family, 10);
    const hidden = BLACKSTREAM_CONSTRUCTIONS.filter((c) => c.layerIndex === 6);
    const pool = hidden.filter((c) =>
      c.utopiaPortals
        ? c.utopiaPortals.includes(n)
        : c.utopiaPortal === n,
    );
    const usable = pool.length > 0 ? pool : hidden;
    return (
      usable[Math.floor(random() * usable.length)] ??
      BLACKSTREAM_CONSTRUCTIONS[0]
    );
  }

  /** 生成误入奇境隐藏层（未萌生的摇篮）：
   * 按雾色场景族选乌托邦模板铺节点，写入 map.zones（键 3000+，variation=乌托邦效果），
   * 本层专用行动力 = 模板 action，记录返回点。 */
  generatePortal(family: string, returnZone: number, returnNode: string): void {
    const theme = this._player.current.game!.theme;
    const detail = excel.RoguelikeTopicTable.details[theme];
    const variationIds = portalVariationIds(family);
    const variationId =
      variationIds[Math.floor(random() * variationIds.length)] ??
      "variation_1";
    const template = this.pickPortalTemplate(family);
    // 隐藏层无专属关卡池（官方 stages 无 portal 层条目）→ 用全主题关卡兜底
    const stages = Object.keys(detail?.stages || {});
    const pools: ZoneStagePools = {
      normal: stages,
      elite: stages,
      boss: stages,
      resident: stages,
    };
    const nodes: { [key: string]: GridNode } = {};

    // 起点（林间空地，可见可访问）
    const [sx, sy] = template.startSlot;
    nodes[this.nodeId(sx, sy)] = {
      content: { kind: ROGUE6_NODE.GLADE },
      state: 2,
      show: true,
    };
    // 模板固定节点（utopia 模板无终点：terminalSlots 为空，行动力耗尽返回）
    for (const f of template.fixedNodes || []) {
      const [fx, fy] = f.slot;
      nodes[this.nodeId(fx, fy)] = this.makeContentNode(
        CONSTRUCTION_TYPE_TO_NODE[f.type] ?? ROGUE6_NODE.INCIDENT,
        pools,
      );
    }
    // 其余占位格：按隐藏层（第 6 列）距离/数量规则抽类型
    const remaining = template.occupiedSlots.filter(
      ([x, y]) => !nodes[this.nodeId(x, y)],
    );
    const dist = this.edgeDistances(template);
    for (const [x, y] of remaining) {
      const id = this.nodeId(x, y);
      const d = dist.get(id);
      // 孤立占位格铺林间空地（与常规层一致，避免不可达事件节点）
      const type =
        d === undefined ? ROGUE6_NODE.GLADE : this.pickTypeByRules(6, d, {});
      nodes[id] = this.makeContentNode(type, pools);
    }

    // portal zone 键：3000 起首个未占用键（原实现 3000+random*900 有 1/900 撞键概率，
    // 同一局多次进入隐藏层可能覆盖上一层残留数据）
    const key = this.nextPortalZoneKey();
    this.zones[`zone_${key}`] = { nodes };
    this.syncMapZones(parseInt(key, 10) - 1000 + 1, template, nodes, key);
    const map = this._player._map;
    if (map?.zones?.[key]) {
      map.zones[key].variation = [variationId];
      map.zones[key].id = `zone_portal_normal_${family}`;
    }
    this.stepRemain = template.action ?? 2;
    this.needConfirmStepZero = true;
    this.portal = {
      active: true,
      returnZone,
      returnNode,
      variation: variationId,
      zoneKey: key,
      family,
    };
    // 进入隐藏层 = 抵达起点：点亮起点沿边可达首节点（portal.active 已置位，
    // mapZoneKeyOf 据此命中 portalZoneKey 本身）
    this.revealReachable(this.mapZoneKeyOf(`zone_${key}`), `zone_${key}`, sx, sy, 1);
    // 初始版面揭示不落入后续移动的 rlv2NodeChange.nodeList
    this._changedNodeIds = new Set();
    // 当前节点 = 隐藏层起点
    const status = this._player._status;
    status.cursor.position = { x: sx, y: sy };
  }

  /**
   * 分配下一个 portal zone 键（3000 起递增，跳过已占用）。
   * @returns 未被 map.zones / this.zones 占用的键
   */
  private nextPortalZoneKey(): string {
    const map = this._player._map;
    for (let n = 3000; n < 3900; n++) {
      const key = String(n);
      if (map?.zones?.[key]) continue;
      if (this.zones[`zone_${key}`]) continue;
      return key;
    }
    return "3000";
  }

  /** 离开隐藏层（行动力耗尽/放弃）：删除 portal zone，恢复返回点，状态回 WAIT_MOVE */
  leavePortal(): void {
    if (!this.portal) return;
    const p = this.portal;
    const map = this._player._map;
    if (map?.zones?.[p.zoneKey]) delete map.zones[p.zoneKey];
    delete this.zones[`zone_${p.zoneKey}`];
    const status = this._player._status;
    status.cursor.zone = p.returnZone;
    const nodeId = parseInt(p.returnNode, 10);
    status.cursor.position = {
      x: Math.floor(nodeId / 100),
      y: nodeId % 100,
    };
    this.portal = null;
    this.stepRemain = this.initialActionForZone(p.returnZone);
    this.needConfirmStepZero = true;
    status.state = "WAIT_MOVE";
    this._trigger.emit("rlv2:portal:return", []);
  }

  /** 当前活动 zone 键（隐藏层返回 portal.zoneKey；常规返回 cursor.zone） */
  currentZoneKey(): string {
    return this.portal?.active
      ? `zone_${this.portal.zoneKey}`
      : `zone_${this._player._status.cursor.zone}`;
  }

  /** 移动到指定节点（route 末节点）；标记节点已访问并返回节点 */
  moveTo(route: string[]): GridNode | undefined {
    const zoneKey = this.currentZoneKey();
    const zone = this.zones[zoneKey];
    if (!zone || !route || route.length === 0) return undefined;
    const last = route[route.length - 1];
    const node = zone.nodes[last];
    if (node) {
      // 到达节点：未访问→已访问（state 0/1 → 2），记为变化节点
      if (node.state !== 2) {
        node.state = 2;
        this._changedNodeIds.add(last);
      }
      // 到达节点在地图上也揭示为可见（visibility=NORMAL）；抵达本身由 gridZone state=2 承载，
      // 不再用 visibility 数值表达（官方 visibility 无"到达"专用值）。
      const mapKey = this.mapZoneKeyOf(zoneKey);
      const mapArrived = this._player._map?.zones?.[mapKey]?.nodes?.[last];
      if (
        mapArrived &&
        (mapArrived.visibility ?? ROGUE6_FORESIGHT.HIDE_INVISIBLE) !==
          ROGUE6_FORESIGHT.NORMAL
      ) {
        mapArrived.visibility = ROGUE6_FORESIGHT.NORMAL;
      }
      // 视野：抵达后揭视可达节点——普通节点沿地图边点亮可达路径首节点（1 跳）；
      // 羽瞰点按到羽瞰点的曼哈顿距离照亮，经过后（state 已置 2）为 2（官方"周围12格"），
      // 出现时的默认 1（官方"周围4格"）在进层生成时揭示（见 generate）。
      const lastX = Math.floor(Number(last) / 100);
      const lastY = Number(last) % 100;
      // 羽瞰点：特殊视野，按到羽瞰点的曼哈顿距离照亮（默认 1，经过后 state=2 增为 2），
      // 并补偿 1 行动力（官方："前往该节点后，揭示范围扩大至周围12格并获得1行动力"）。
      // 普通节点仍沿地图边点亮可达路径首节点（1 跳）。
      if (node.content?.kind === ROGUE6_NODE.RAIN_VIEW) {
        this.revealManhattan(mapKey, zoneKey, lastX, lastY, 2);
        this.stepRemain += 1;
      } else {
        this.revealReachable(mapKey, zoneKey, lastX, lastY, 1);
      }
    }
    return node;
  }

  /**
   * 节点"被经过"衰减：将玩家移走的旧节点改写为林间空地 GLADE（地图类型 + gridZone 类型）。
   * 可反复进入的节点类型（商店类/林间空地/险路尽头/险路小径/曲折密道，见
   * ROGUE6_REVISITABLE_NODES）保持不变。抵达新节点时对刚移走的上一位置调用。
   * @param mapKey _map.zones 键
   * @param zoneKey gridZone 键
   * @param nodeId 被经过的旧节点 id（x*100+y）
   * @returns 是否实际发生了衰减（类型被改写为 GLADE）
   */
  decayPassed(mapKey: string, zoneKey: string, nodeId: string): boolean {
    const zone = this.zones[zoneKey];
    const gzNode = zone?.nodes[nodeId];
    if (!gzNode) return false;
    const kind = gzNode.content?.kind;
    if (typeof kind !== "number" || ROGUE6_REVISITABLE_NODES.includes(kind)) {
      return false;
    }
    gzNode.content = { kind: ROGUE6_NODE.GLADE };
    const mapNode =
      this._player._map?.zones?.[mapKey]?.nodes?.[nodeId];
    if (mapNode) mapNode.type = ROGUE6_NODE.GLADE;
    this._changedNodeIds.add(nodeId);
    return true;
  }

  /**
   * 网格 zone 键（zone_N 常规 / zone_<portalKey> 隐藏层）→ _map.zones 键。
   * 常规层键 = 1000+N-1（与 syncMapZones 一致）；隐藏层 = portal.zoneKey 本身。
   * @param zoneKey gridZone 的 zone 键
   * @returns _map.zones 的对应键
   */
  private mapZoneKeyOf(zoneKey: string): string {
    if (this.portal?.active && zoneKey === `zone_${this.portal.zoneKey}`) {
      return this.portal.zoneKey;
    }
    const zoneId = parseInt(zoneKey.slice("zone_".length), 10);
    return String(1000 + zoneId - 1);
  }

  /**
   * 从节点 (sx,sy) 沿地图边（_map.zones 节点的 next 邻接表）点亮 ≤hops 跳的首段可达节点：
   * 置其 map.zones visibility=NORMAL（揭示可见），按需把 gridZone state 0→1，并入变化节点集合。
   * 供 moveTo 抵达揭示可达路径，以及进入区域时把起点视为“已抵达”揭示起点路径。
   * 揭示为单调（不降级已探索节点：visibility=NORMAL / state=2 不回退）；只取 current hop 的边邻居。
   * @param mapZoneKey _map.zones 键
   * @param zoneKey gridZone 键
   * @param sx 起始 x（x*100+y 节点坐标）
   * @param sy 起始 y
   * @param hops 可达跳数（普通 1；羽瞰点 2）
   * 注：官服 gridZone 节点 state 仅取 0/2（无中间态）——揭示仅改 map.zones visibility，
   * 不改 gridZone state（原实现置中间态 1 → 客户端可通行状态解析异常）。
   */
  private revealReachable(
    mapZoneKey: string,
    zoneKey: string,
    sx: number,
    sy: number,
    hops: number,
  ): void {
    const zone = this.zones[zoneKey];
    const mapNodes = (this._player._map?.zones?.[mapZoneKey]?.nodes ||
      {}) as {
      [id: string]: { next?: { x: number; y: number }[]; visibility?: number };
    };
    if (!zone) return;
    const visited = new Set<string>([this.nodeId(sx, sy)]);
    let frontier: { x: number; y: number }[] = [{ x: sx, y: sy }];
    for (let hop = 1; hop <= hops; hop++) {
      const nextFrontier: { x: number; y: number }[] = [];
      for (const cur of frontier) {
        for (const nb of mapNodes[this.nodeId(cur.x, cur.y)]?.next ?? []) {
          const nid = this.nodeId(nb.x, nb.y);
          if (visited.has(nid)) continue;
          visited.add(nid);
          const gzNode = zone.nodes[nid];
          const mapNode = mapNodes[nid];
          let changed = false;
          // visibility 单调揭示：HIDE（未定义/1/2/3）→ NORMAL(0)；已揭示不回退
          if (
            mapNode &&
            (mapNode.visibility ?? ROGUE6_FORESIGHT.HIDE_INVISIBLE) !==
              ROGUE6_FORESIGHT.NORMAL
          ) {
            mapNode.visibility = ROGUE6_FORESIGHT.NORMAL;
            changed = true;
          }
          if (changed) this._changedNodeIds.add(nid);
          nextFrontier.push(nb);
        }
      }
      frontier = nextFrontier;
    }
  }

  /**
   * 按到起点 (sx,sy) 的曼哈顿距离点亮 zone 内节点（羽瞰点特殊视野）：
   * 曼哈顿距离 = |x-sx|+|y-sy| ≤ radius 的节点置 map.zones visibility=NORMAL（揭示可见），
   * 按需把 gridZone state 0→1，并入变化节点集合。
   * 与 revealReachable（沿地图边）不同，此处以到羽瞰点的曼哈顿半径铺开，
   * 不要求边连通；揭示为单调（不降级已探索节点）。
   * @param mapZoneKey _map.zones 键
   * @param zoneKey gridZone 键
   * @param sx 羽瞰点 x（x*100+y 节点坐标）
   * @param sy 羽瞰点 y
   * @param radius 曼哈顿距离半径（默认 2；经过后 3）
   * 揭示仅改 visibility，不改 gridZone state（state 仅 0/2，见 revealReachable）
   */
  private revealManhattan(
    mapZoneKey: string,
    zoneKey: string,
    sx: number,
    sy: number,
    radius: number,
  ): void {
    const zone = this.zones[zoneKey];
    if (!zone) return;
    const mapNodes = (this._player._map?.zones?.[mapZoneKey]?.nodes ||
      {}) as {
      [id: string]: { visibility?: number };
    };
    for (const nid of Object.keys(zone.nodes)) {
      const x = Math.floor(Number(nid) / 100);
      const y = Number(nid) % 100;
      if (Math.abs(x - sx) + Math.abs(y - sy) > radius) continue;
      const mapNode = mapNodes[nid];
      const gzNode = zone.nodes[nid];
      let changed = false;
      // visibility 单调揭示：HIDE（未定义/1/2/3）→ NORMAL(0)；已揭示不回退
      if (
        mapNode &&
        (mapNode.visibility ?? ROGUE6_FORESIGHT.HIDE_INVISIBLE) !==
          ROGUE6_FORESIGHT.NORMAL
      ) {
        mapNode.visibility = ROGUE6_FORESIGHT.NORMAL;
        changed = true;
      }
      if (changed) this._changedNodeIds.add(nid);
    }
  }

  /**
   * 记录本层曲折密道成对索引（zoneId → [密道A id, 密道B id]）。
   * 官方"曲折密道成对出现"：层内恰好两个 TUNNEL 节点互为传送目标。
   * @param zoneId 区域号（1 起）
   * @param nodes 本层 gridZone 节点表
   */
  private indexTunnelPairs(zoneId: number, nodes: { [key: string]: GridNode }): void {
    const tunnels = Object.keys(nodes).filter(
      (id) => nodes[id].content?.kind === ROGUE6_NODE.TUNNEL,
    );
    if (tunnels.length === 2) {
      this._tunnelPairs[String(zoneId)] = [tunnels[0], tunnels[1]];
    } else if (tunnels.length === 0) {
      delete this._tunnelPairs[String(zoneId)];
    }
    // 非 0 非 2（异常生成）不建对，避免单向传送
  }

  /**
   * 曲折密道传送目标：本层 nodeId 若为已记录密道对的成员，返回另一密道节点 id；
   * 非密道或未成对返回 undefined。供控制器在玩家进入密道节点后决定是否位移到配对位置。
   * @param zoneKey gridZone 层键（zone_1 之类）
   * @param nodeId 当前所在密道节点 id
   */
  tunnelPairTarget(zoneKey: string, nodeId: string): string | undefined {
    const zoneId = zoneKey.replace("zone_", "");
    const pair = this._tunnelPairs[zoneId];
    if (!pair) return undefined;
    if (pair[0] === nodeId) return pair[1];
    if (pair[1] === nodeId) return pair[0];
    return undefined;
  }

  /**
   * 开始一次移动请求的变化节点收集（清空上次遗留，界定请求边界）。
   * 由控制器在一条 route 落格前调用。
   */
  beginMove(): void {
    this._changedNodeIds = new Set();
  }

  /**
   * 取走并清空本次移动请求发生状态/视野变化的节点 id 列表（rlv2NodeChange.nodeList）。
   * @returns 变化节点 id 数组（保持插入顺序，Set 迭代序）
   */
  takeChangedNodes(): string[] {
    const out = [...this._changedNodeIds];
    this._changedNodeIds = new Set();
    return out;
  }

  toJSON(): {
    zones: { [key: string]: GridZone };
    stepRemain: number;
    needConfirmStepZero: boolean | number;
    portal?: GridPortalState | null;
  } {
    // 官方 gridZone 节点 content：地图生成（finishEvent）时全为 {}——战斗信息由 map.zones 提供；
    // 商店节点进入后 content 变为 { shop: { goods } }。savage/kind 为内部标记（战斗触发用），
    // 序列化时剥离（客户端不识别 savage/kind，多余字段解析异常；shop 保留）
    const strip = (n: GridNode): GridNode => {
      const c: GridNode["content"] = {};
      if (n.content?.shop) c.shop = n.content.shop;
      return { content: c, state: n.state, show: n.show };
    };
    const zones: { [key: string]: GridZone } = {};
    for (const [k, z] of Object.entries(this.zones)) {
      const nodes: { [key: string]: GridNode } = {};
      for (const [id, n] of Object.entries(z.nodes)) {
        nodes[id] = strip(n);
      }
      zones[k] = { nodes };
    }
    const out: {
      zones: { [key: string]: GridZone };
      stepRemain: number;
      needConfirmStepZero: boolean | number;
      portal?: GridPortalState;
    } = {
      zones,
      stepRemain: this.stepRemain,
      needConfirmStepZero: this.needConfirmStepZero,
    };
    // portal 状态仅活动（隐藏层中）时输出——官服线格式无此字段，开局/常规状态严格比对不允许多余键
    if (this.portal?.active) out.portal = this.portal;
    return out;
  }
}
