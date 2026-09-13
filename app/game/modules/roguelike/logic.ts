import { PlayerRoguelikeV2, PlayerRoguelikePendingEvent, RoguelikeItemBundle, RoguelikeNodePosition, TorappuRoguelikeEventType } from "./rlv2";
import excel from "@excel/excel";
import { readFileSync } from "fs";
import zlib from "node:zlib";
import { RoguelikeInventoryManager } from "./inventory";
import { TroopManager } from "../character/troop";
import { RoguelikeBuffManager } from "./buff";
import { RoguelikePlayerStatusManager } from "./status";
import { now } from "@utils/time";
import { RoguelikeModuleManager } from "./module";
import type { RoguelikeDiceManager } from "./modules/dice";
import { RoguelikeTroopManager } from "./troop";
import { RoguelikeMapManager } from "./map";
import { PlayerSquad } from "../../kernel/model";
import { RoguelikeBattleManager } from "./battle";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { PlayerDataModel } from "../../kernel/playerdata";
import { BattleData } from "../../kernel/battle-model";
import { RoguelikePoolManager } from "./pool";
import { composeRlv2ChildModules, type Rlv2ChildModules } from "./rlv2-composition";
import { RoguelikeGameInitData } from "@excel/excel";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { RoguelikePushMessage } from "../../kernel/http/common";
import { Draft } from "mutative";
import { ItemBundle } from "@excel/excel";
import { logger } from "@utils/logger";
import { Rogue6IncidentEngine } from "./incident";

/**
 * 事件选项效果载荷中的数值字典（`{ gold: 2 }` / 嵌套 `{ hp: { current: 2 } }`）
 *
 * 键为 property/module 的字段名（gold/hp/population/shield/san/dice…），见
 * data/rlv2/event_choices.json。
 */
export interface RoguelikeChoiceEffectMap {
  [key: string]: number | { [key: string]: number };
}

/**
 * 事件选项效果载荷（lose/get/m_get/m_lose/i_get/i_lose）
 *
 * 取值形态来自 data/rlv2/event_choices.json 实测：null、字符串（藏品 id 前缀）、
 * 数字、字符串数组（GET 多选一）与数值字典（含嵌套 `{ hp: { current: N } }`）。
 */
export type RoguelikeChoiceEffectPayload =
  | null
  | string
  | number
  | string[]
  | RoguelikeChoiceEffectMap;

/** event_choices.json 单条选项：效果载荷 + 后续选项（choices 为字符串时表示战斗关卡前缀） */
export interface RoguelikeChoiceEffectConfig {
  choices: string[] | string;
  lose?: RoguelikeChoiceEffectPayload;
  get?: RoguelikeChoiceEffectPayload;
  m_lose?: RoguelikeChoiceEffectPayload;
  m_get?: RoguelikeChoiceEffectPayload;
  i_get?: RoguelikeChoiceEffectPayload;
  i_lose?: RoguelikeChoiceEffectPayload;
  curse?: boolean;
  /** 条件分支：以列表内 get/curse 组合替代顶层效果（rogue_2 liar/11 系列） */
  get_id?: { get: string; curse: boolean }[];
}

/** `customizeData[theme]` 科技树节点（生成模型 RL0xCustomizeData 的 developments 值） */
export type RoguelikeCustomizeDevelopmentNode = {
  frontNodeId: string[];
  tokenCost: number;
  /** 节点原始描述（先行一步/喙 等节点效果的文本判定来源，见 grid-nav.ts） */
  rawDesc?: string[];
};

/**
 * `customizeData[theme]` 的科技树区段视图
 *
 * 生成模型的 customizeData 为未建模线格式 JSON（`RoguelikeTopicCustomizeData` = JsonValue），
 * 各主题节点类型不同，服务端只消费 frontNodeId/tokenCost，故按实测字段声明最小视图。
 */
export type RoguelikeCustomizeDataView = {
  developments?: { [nodeId: string]: RoguelikeCustomizeDevelopmentNode };
  commonDevelopment?: {
    developments?: { [nodeId: string]: RoguelikeCustomizeDevelopmentNode };
  };
};

export class RoguelikeV2Config {
  choiceScenes: { [key: string]: { choices: { [key: string]: number } } };
  eventChoices: {
    [theme: string]: {
      enter: { [sceneId: string]: string[] };
      choices: { [choiceId: string]: RoguelikeChoiceEffectConfig };
    };
  };
  /** 招募组 → 标准职业映射（data/rlv2/recruit-groups.json） */
  recruitGroups: { [key: string]: string[] };

  constructor() {
    this.choiceScenes = JSON.parse(
      readFileSync(`${__dirname}/../../../../data/rlv2/choices.json`, "utf-8"),
    );
    this.eventChoices = JSON.parse(
      readFileSync(`${__dirname}/../../../../data/rlv2/event_choices.json`, "utf-8"),
    );
    this.recruitGroups = JSON.parse(
      readFileSync(`${__dirname}/../../../../data/rlv2/recruit-groups.json`, "utf-8"),
    );
  }
}

import { generateShopGoods, buildShopContent, buyGoods, refreshShop, leaveShop, shopBattleStart, isInShopNode } from "./shop";
import { bankPut, bankWithdraw } from "./bank";
import { applyBandUpgradeVisibility, initModeGradeStates, maxClearedGrade, buildSettlement, exploreBreakdown, exploreScoreFactor, exploreScore, lifeGameNodes, blackstreamEfficiency, canEvolveOperators, blackstreamAwards, gameSettle, buildSettleResponse } from "./settle";
import { rerollNode, upgradeNode, gridZoneMoveTo, createRogue6NodeScene, createPortalScene, enterPortalZone, consumePortalScrap, startChaosSourceBattle, gainPreciousScrap, gainRandomScrap, isBeakUnlocked, createFateScene, createIncidentScene, gridZoneMoveAndBattleStart, gridZoneEmptyStep, gridZoneReadStepZero } from "./grid-nav";
import { _normalizeMutablePlayerdata, setPinned, giveUpGame, createGame, ensureOuterTheme, refreshMission, chooseInitialRelic, chooseInitialRecruitSet, chooseInitialExploreTool, setSeed } from "./game-init";

import { finishEvent, hasReachedZone3, locateStartNode, zoneKey, isZoneEnd, checkZoneEnd, hasRelic, emitSpecialOperatorZone, nodeTypeCounts, emitSpecialOperatorSettle, selectChoice, readEndingChange } from "./event";
import { moveAndBattleStart, moveTo, createNodeScene, confirmZoneReward, confirmTraderReturn, specialZoneLeave, battlePassGetReward, battlePassBuyReward } from "./battle-nav";
import { chooseBattleReward, finishBattleReward } from "./reward";
import { activeRecruitTicket, recruitChar, closeRecruitTicket, getTicketAssistList, recruitAssistChar, stashRecruitTicket, useStashedTicket } from "./recruit-flow";
import { random } from "../../kernel/util/random";

export class RoguelikeV2Manager implements PlayerRoguelikeV2 {
  get pinned(): string | undefined {
    return this._player._playerdata.rlv2.pinned;
  }

  get outer(): { [key: string]: PlayerRoguelikeV2.OuterData } {
    const rlv2 = this._player._playerdata.rlv2;
    // 兜底空表：纯索引签名表，`{}` 即合法空值（生成模型视角）
    if (!rlv2.outer) rlv2.outer = {};
    return rlv2.outer as unknown as {
      [key: string]: PlayerRoguelikeV2.OuterData;
    };
  }

  get current(): PlayerRoguelikeV2.CurrentData {
    const rlv2 = this._player._playerdata.rlv2;
    // 兜底空对象：生成模型 CurrentData 各字段必填，运行时此处仅为占位，随后由
    // update() 配方/子模块写入（空占位语义与原实现一致）
    if (!rlv2.current) rlv2.current = {} as typeof rlv2.current;
    return rlv2.current as unknown as PlayerRoguelikeV2.CurrentData;
  }

  /**
   * 局外进度统计 → 勋章事件（Rlv2CollectRelic / Rlv2UnlockBand / Rlv2EndingCollect / Rlv2BpLevel）
   *
   * 官服勋章 unlockParam = [主题, 目标数]：
   * - Rlv2CollectRelic「XX主题中的拟造物质编目已持有 N 个收藏品」← outer[theme].collect.relic
   *   中 state ≥ 2（已获得，见 relic.ts 写入）的条目数；
   * - Rlv2UnlockBand「在 XX主题中解锁 N 个分队」← outer[theme].collect.band 中 state ≥ 1
   *   （已解锁可开局选择，见 events.ts）的条目数；
   * - Rlv2EndingCollect「达成 N 种结局」← outer[theme].collect.endBook 的条目数
   *   （结算成功达成结局时写入，见 settle.ts）；
   * - Rlv2BpLevel「源流堆栈中解锁至 N 级」← outer[theme].bp.point（源流样本）按官方
   *   奖励轨道 details[theme].milestones 中各档 tokenNum 换算出的当前等级
   *   （rogue_6：bp_level_65 → tokenNum 19000 = 满级档）。
   *
   * 载荷是**当前累计值**而非增量，模板侧取 max —— 幂等：重复派发、读档补发、
   * 结算/获得收藏品/首次进主题等多个触发点先后触发都不会多计。
   *
   * @param theme - 肉鸽主题 id（rogue_1 … rogue_6）
   */
  async emitOuterProgressionMedals(theme: string): Promise<void> {
    const outer = this.outer?.[theme];
    if (!outer || !theme) return;
    const relicCount = Object.values(outer.collect?.relic ?? {}).filter(
      (v) => Number(v?.state ?? 0) >= 2,
    ).length;
    const bandCount = Object.values(outer.collect?.band ?? {}).filter(
      (v) => Number(v?.state ?? 0) >= 1,
    ).length;
    // 「达成 N 种结局」← 结局图鉴 collect.endBook 的条目数（结算成功且达成结局时写入）
    const endingCount = Object.keys(outer.collect?.endBook ?? {}).length;
    // 源流堆栈等级：按官方奖励轨道（milestones 各档 tokenNum 门槛）由累计源流样本换算
    const level = this.resolveBpLevel(theme, Number(outer.bp?.point ?? 0));
    await this._trigger.emit("Rlv2CollectRelic", [{ theme, count: relicCount }]);
    await this._trigger.emit("Rlv2UnlockBand", [{ theme, count: bandCount }]);
    await this._trigger.emit("Rlv2EndingCollect", [{ theme, count: endingCount }]);
    await this._trigger.emit("Rlv2BpLevel", [{ theme, level }]);
  }

  /**
   * 源流样本累计 → 源流堆栈（BP）等级
   *
   * 官服奖励轨道 details[theme].milestones 为 65 档（id 形如 bp_level_1..65），
   * 每档给出累计门槛 tokenNum 与下一档 nextTokenNum（末档为 -1）；等级 =
   * 满足 tokenNum ≤ point 的最高档 level。
   *
   * @param theme - 肉鸽主题 id
   * @param point - outer[theme].bp.point（源流样本累计）
   * @returns 当前 BP 等级（无该主题/无轨道时返回 0）
   */
  resolveBpLevel(theme: string, point: number): number {
    const list = excel.RoguelikeTopicTable.details[theme]?.milestones ?? [];
    let level = 0;
    for (const m of list) {
      const need = Number(m?.tokenNum ?? 0);
      const lv = Number(m?.level ?? 0);
      if (Number.isFinite(need) && point >= need && lv > level) level = lv;
    }
    return level;
  }

  troop: RoguelikeTroopManager;

  _troop: TroopManager;

  _pool: RoguelikePoolManager;

  _data: RoguelikeV2Config;

  _player: PlayerDataManager;

  _trigger: TypedEventEmitter;

  _bandId = "";

  _settled = false;

  _pushMessages: RoguelikePushMessage[] = [];
  _shopSellCount?: number;

  _map!: RoguelikeMapManager;
  _status!: RoguelikePlayerStatusManager;
  _buff!: RoguelikeBuffManager;
  _module!: RoguelikeModuleManager;
  _battle!: RoguelikeBattleManager;
  _incident!: Rogue6IncidentEngine;
  inventory!: RoguelikeInventoryManager | null;

  constructor(
    player: PlayerDataManager,
    _trigger: TypedEventEmitter,
    deps?: { modules?: Partial<Rlv2ChildModules> },
  ) {
    // rlv2 内部模型（model/rlv2.ts）与生成模型（types-playerdata）为同一数据的两种视图：
    // 内部模型为功能实现的类型契约，生成模型为线格式存储视图，边界处做显式桥接
    this._player = player;
    this._trigger = _trigger;
    this._data = new RoguelikeV2Config();
    this._incident = new Rogue6IncidentEngine(this);
    // 规范化持久态为可写（autoFreeze 兼容）：构造期同步填充 current.game/buff/record
    // 缺失字段，若 _playerdata.rlv2 已被 Immer 冻结（autoFreeze=true 下 finishDraft 冻结
    // 整个 _playerdata），则以深可变副本替换 rlv2 子树，避免构造期原地写抛错。
    this._normalizeMutablePlayerdata();
    this._troop = player.troop;
    // 构造期占位：仅当存档无进行中的对局（current.game.theme 空——新登录/无对局）
    // 时初始化 NONE 占位；有进行中游戏（重启后重登"继续探索"）保留存档
    // current.game/buff/record——无条件重置会把进行中对局清空 → 重登后无法继续。
    // 防御：game.theme 存在但 player.state 缺失/NONE（如服务器中途强退留下的
    // "半初始化"存档——game 已写但状态机未跑）视为无进行中游戏——否则 continue
    // 恢复出"有对局但状态机 NONE"的僵尸态，客户端既不能移动也不能放弃。
    const st = this.current.player as
      | PlayerRoguelikeV2.CurrentData.PlayerStatus
      | undefined;
    const hasRunning =
      !!this.current.game?.theme && !!st?.state && st.state !== "NONE";
    if (!hasRunning) {
      this.current.game = {
        mode: "NONE",
        // 未指定预置剧本（predefined）时用 null 而非 ""（Game.predefined 类型为 string|null，
        // 空串会让客户端按"有预置剧本"解析，与官服线格式不符）
        predefined: null,
        theme: "",
        outer: {
          support: false,
        },
        start: -1,
        modeGrade: 0,
        equivalentGrade: 0,
      };
      this.current.buff = {
        tmpHP: 0,
        capsule: null,
        squadBuff: [],
      };
      this.current.record = { brief: null };
    }

    // 组合子模块：默认工厂按原顺序构造 8 个子管理器；deps.modules 覆写个别模块。
    // 构造顺序即事件订阅顺序，必须与迁移前完全一致（见 rlv2-composition.ts）。
    const composed = composeRlv2ChildModules(this, this._trigger);
    const m = { ...composed, ...deps?.modules };
    this.troop = m.troop;
    this._status = m.status;
    this.inventory = m.inventory;
    this._buff = m.buff;
    this._map = m.map;
    this._module = m.module;
    this._battle = m.battle;
    this._pool = m.pool;
    // 进行中的对局：走 rlv2:continue 恢复（grid_zone/weather/scrap/chaos/buff/
    // events 等从存档 current 恢复；status 单独恢复，避免 rlv2:init 重置为 NONE）
    if (hasRunning) {
      this._trigger.emit("rlv2:continue", []);
      this._status.continue();
    } else {
      this._trigger.emit("rlv2:init", []);
    }
  }

  get initConfig(): RoguelikeGameInitData {
    const game = this.current.game!;
    return excel.RoguelikeTopicTable.details[game.theme].init.find(
      (i) =>
        // FBO 对默认值 0 的 int 字段（modeGrade 等）编码为缺省 → undefined，按 0 处理
        (i.modeGrade ?? 0) == (game.modeGrade ?? 0) &&
        i.predefinedId == game.predefined &&
        i.modeId == game.mode,
    )!;
  }

  pushMessage(path: string, payload: unknown, themeOverride?: string): void {
    const theme = themeOverride ?? this.current.game?.theme;
    if (theme !== "rogue_6") return;
    this._pushMessages.push({ path, payload });
  }

  takePushMessages(): RoguelikePushMessage[] {
    const out = this._pushMessages;
    this._pushMessages = [];
    return out;
  }

  clearPushMessages(): void {
    this._pushMessages = [];
  }

  clearPending(): void {
    this._status._pending._pending = [];
  }

  get maxZone(): number {
    const theme = this.current.game!.theme;
    const stages = Object.keys(
      excel.RoguelikeTopicTable.details[theme]?.stages || {},
    );
    let max = 0;
    for (const s of stages) {
      const m = s.match(/^ro\d+_[ne]_(\d+)_/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    // 附加层条件：持有改变结局走向的藏品 → 允许到 6 层（官方结局层）；否则默认 5 层
    if (max >= 6) {
      const relicIds = Object.values(this.inventory?.relic || {}).map(
        (r) => r.id,
      );
      const detail = excel.RoguelikeTopicTable.details[theme];
      const hasEndingChange = relicIds.some(
        (id) =>
          (detail?.items?.[id]?.usage || "").includes("让探索走向不同的结局") ||
          (detail?.items?.[id]?.usage || "").includes("不同结局"),
      );
      // 三结局·纠缠调和：持有【怦然信标】（rogue_6_relic_final_3，gameConst.expedEndingRelic）
      // → 通过第Ⅴ层后可进入第Ⅵ层（源流交汇处）
      const hasBeacon =
        theme === "rogue_6" && relicIds.includes("rogue_6_relic_final_3");
      if (hasEndingChange || hasBeacon) return max;
    }
    return Math.min(max || 6, 5);
  }

  /**
   * property 数值字段累加（事件选项 lose/get 的数值字典）
   *
   * `PlayerStatus.Properties` 键域封闭、无索引签名，故按字段名显式分支：
   * 顶层数值字段直接累加；hp/population 为嵌套数值对象，按 current/max/cost
   * 子键累加（子键当前值须为 number，与原 `typeof target[subKey] === "number"` 一致）。
   * 未知键（san/dice/rogue_2_key 等非 property 字段）与原 `property[key]` 取到
   * undefined 的行为一致——跳过。
   * @param delta - 事件效果数值字典（{gold:2} / {hp:{current:2}}）
   * @param sign - 方向（+1 获得 / -1 失去）
   */
  applyPropertyDelta(delta: RoguelikeChoiceEffectMap, sign: number): void {
    const prop = this._status.property;
    for (const [key, value] of Object.entries(delta)) {
      if (typeof value === "number") {
        switch (key) {
          case "exp":
            prop.exp += sign * value;
            break;
          case "level":
            prop.level += sign * value;
            break;
          case "maxLevel":
            prop.maxLevel += sign * value;
            break;
          case "shield":
            prop.shield += sign * value;
            break;
          case "gold":
            prop.gold += sign * value;
            break;
          case "capacity":
            prop.capacity += sign * value;
            break;
          case "conPerfectBattle":
            prop.conPerfectBattle += sign * value;
            break;
          default:
            // 非 property 数值字段——原动态索引取 undefined，同样跳过
            break;
        }
        continue;
      }
      if (typeof value !== "object" || value === null) continue;
      // 嵌套对象（如 hp: {current: 2}）——事件效果常见格式
      for (const [subKey, subVal] of Object.entries(value)) {
        if (typeof subVal !== "number") continue;
        if (key === "hp" && subKey === "current" && typeof prop.hp.current === "number") {
          prop.hp.current += sign * subVal;
        } else if (key === "hp" && subKey === "max" && typeof prop.hp.max === "number") {
          prop.hp.max += sign * subVal;
        } else if (
          key === "population" &&
          subKey === "cost" &&
          typeof prop.population.cost === "number"
        ) {
          prop.population.cost += sign * subVal;
        } else if (
          key === "population" &&
          subKey === "max" &&
          typeof prop.population.max === "number"
        ) {
          prop.population.max += sign * subVal;
        }
      }
    }
  }

  /**
   * inventory 数值字段累加（事件选项 i_get/i_lose 的消耗品字典）
   *
   * 仅处理 `consumable` 键（`{ consumable: { itemId: count } }`），其余键与原实现
   * 一致——不处理。
   * @param delta - 事件效果数值字典
   * @param sign - 方向（+1 获得 / -1 失去）
   */
  applyInventoryDelta(delta: RoguelikeChoiceEffectMap, sign: number): void {
    Object.entries(delta).forEach(([key, value]) => {
      if (key === "consumable" && typeof value === "object") {
        Object.entries(value).forEach(([itemId, count]) => {
          this._trigger.emit("rlv2:get:items", [[{ id: itemId, count: sign * count }]]);
        });
      }
    });
  }

  async confirmPredict(): Promise<void> {
    this._status._pending._pending.length = 0;
    await this.checkZoneEnd();
    this._status.state = "WAIT_MOVE";
  }

  async useTotem(args: {
    totemIndex: [string, string];
    nodeIndex: string[];
  }): Promise<void> {
    this._module.totem.use(args.totemIndex, args.nodeIndex);
  }

  static readonly NODE_SCENE_PREFIX: {
    [type: number]: string[];
  } = {
    [TorappuRoguelikeEventType.REST]: ["rest"],
    [TorappuRoguelikeEventType.WISH]: ["relic"],
    [TorappuRoguelikeEventType.TREASURE]: ["chest"],
    [TorappuRoguelikeEventType.SACRIFICE]: ["sacrifice"],
    [TorappuRoguelikeEventType.ENTERTAINMENT]: ["ent"],
    [TorappuRoguelikeEventType.EXPEDITION]: ["scout"],
    [TorappuRoguelikeEventType.UNKNOWN]: ["nportal", "eportal"],
  };

  async battleFinish(args: {
    battleLog: string;
    data: string;
    battleData: BattleData;
  }) {
    await this._trigger.emit("rlv2:battle:finish", [args]);
    // "流窜居民"驱逐结算：本次若为驱逐战（进入被占领节点 / "居民"据点），战斗胜利后
    // 驱逐目标——被占领节点被毁为林间空地；居民据点战胜则驱逐该层全部流窜居民。
    this._module.gridZone?.finishClearing();
    // 标准地图节点 fts 标记（网格区域用 gridZone 节点——标准地图可能无此节点，容错跳过）
    const pos = this._status.cursor.position;
    if (pos) {
      const node = this._map.zones[this._status.cursor.zone]?.nodes[
        `${pos.x * 100 + pos.y}`
      ];
      if (node) node.fts = now();
    }
  }

  async nodeMissionConfirm(): Promise<void> {
    const nm = this._status.nodeMission;
    if (!nm) return;
    nm.state = 2;
    const theme = this.current.game!.theme;
    const task = excel.RoguelikeTopicTable.details[theme]?.taskData?.[nm.id];
    const sceneId = task?.rewardSceneId;
    if (sceneId) {
      const prefix = sceneId.replace(/^scene_/, "").replace(/_enter$/, "");
      const choiceIds = Object.keys(
        excel.RoguelikeTopicTable.details[theme]?.choices || {},
      ).filter((k) => k.startsWith(`choice_${prefix}_`) && !k.endsWith("_enter"));
      const choices = choiceIds.reduce((acc, cid) => ({ ...acc, [cid]: 1 }), {});
      const choiceAdditional = choiceIds.reduce(
        (acc, cid) => ({ ...acc, [cid]: { rewards: [] } }),
        {},
      );
      this._trigger.emit("rlv2:event:create", [
        "SCENE",
        {
          scene: {
            id: sceneId,
            choices,
            choiceAdditional,
            independent: true,
          },
          done: false,
          popReport: false,
        },
      ]);
    }
    this._status.state = "PENDING";
  }

  async nodeMissionGiveUp(): Promise<void> {
    const nm = this._status.nodeMission;
    if (nm) nm.state = 3;
    this._status.state = "WAIT_MOVE";
  }

  async nodeMissionCloseTip(): Promise<void> {
    const nm = this._status.nodeMission;
    if (nm) nm.tip = false;
  }

  async expeditionChoice(args: {
    choice?: string;
    leave?: number;
  }): Promise<{ result: number }> {
    if (args.leave) {
      this._status._pending._pending.length = 0;
      this._status.state = "WAIT_MOVE";
      return { result: 1 };
    }
    const ids = (args.choice || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) {
      if (!this.troop.expedition.includes(id)) {
        this.troop.expedition.push(id);
      }
    }
    this._status.state = "WAIT_MOVE";
    return { result: 1 };
  }

  async confirmExpeditonReturn(): Promise<void> {
    this.troop.expedition = [];
    this.troop.expeditionReturn = null;
    this._status._pending._pending.length = 0;
    this._status.state = "WAIT_MOVE";
  }

  async diceChoice(args: { choice?: string | number }): Promise<{ result: number }> {
    const choice = String(args.choice ?? "LEAVE").toUpperCase();
    const dm = this._module.dice;
    const theme = this.current.game!.theme;
    const diceEvent = this._status.pending.find((e) => e.type === "DICE");
    // 无 DICE 事件（非骰子流程）→ 直接回到 WAIT_MOVE
    if (!diceEvent) {
      this._status.state = "WAIT_MOVE";
      return { result: 1 };
    }
    if (choice === "REROLL") {
      // 重掷：重新生成骰子结果（重掷次数 +1）
      const result = this.rollDice(theme, dm);
      diceEvent.content.dice = {
        result,
        rerollCount: (diceEvent.content.dice?.rerollCount ?? 0) + 1,
      };
      this._status.state = "PENDING";
      return { result: 1 };
    }
    // LEAVE：接受结果，发放骰子事件奖励并消费 DICE 事件
    const dice = diceEvent.content.dice;
    const diceEventId = dice?.result?.diceEventId || "";
    const detail = excel.RoguelikeTopicTable.details[theme];
    const eventData = (
      excel.RoguelikeTopicTable.modules[theme]?.dice?.diceEvents || {}
    )[diceEventId];
    const showType = String(eventData?.showType ?? "");
    // 按结果类型发放简化奖励（启示/美德/钥匙等——官方通过 ruleGroup 黑板驱动）
    if (showType === "VIRTUE") {
      this._trigger.emit("rlv2:get:items", [[{ id: "rogue_2_gold", count: 3 }]]);
    } else if (showType === "KEY") {
      this._trigger.emit("rlv2:get:items", [[{ id: "rogue_2_gold", count: 5 }]]);
    } else {
      this._trigger.emit("rlv2:get:items", [[{ id: "rogue_2_gold", count: 2 }]]);
    }
    void detail;
    this._status._pending._pending.splice(
      this._status._pending._pending.indexOf(diceEvent),
      1,
    );
    this._status.state = "WAIT_MOVE";
    return { result: 1 };
  }

  /**
   * 掷骰（结果结构对齐挂起事件 DICE 的 payload）
   * @param theme - 主题 id
   * @param dm - 骰子模块管理器（缺省按 6 面）
   * @returns DICE 事件结果（diceEventId/diceRoll/mutation/virtue）
   */
  rollDice(
    theme: string,
    dm: RoguelikeDiceManager | undefined,
  ): PlayerRoguelikePendingEvent.Dice.Result {
    const faceCount = dm?.faceCount ?? 6;
    const diceRoll = Math.floor(random() * faceCount) + 1;
    const diceEvents = excel.RoguelikeTopicTable.modules[theme]?.dice?.diceEvents;
    const eventIds = diceEvents ? Object.keys(diceEvents) : [];
    const diceEventId =
      eventIds.length > 0
        ? eventIds[Math.floor(random() * eventIds.length)]
        : "";
    return {
      diceEventId,
      diceRoll,
      mutation: { id: "", chars: [] },
      virtue: [],
    };
  }

  async sacrificeChoice(args: {
    choice?: string;
    leave?: number;
  }): Promise<void> {
    const theme = this.current.game!.theme;
    const sacrificeEvent = this._status.pending.find(
      (e) => e.type === "SACRIFICE" || (e.type === "SCENE" && e.content?.sacrifice),
    );
    if (args.leave) {
      if (sacrificeEvent) {
        this._status._pending._pending.splice(
          this._status._pending._pending.indexOf(sacrificeEvent),
          1,
        );
      }
      this._status.state = "WAIT_MOVE";
      return;
    }
    // 可献祭藏品：玩家拥有的、官方 canSacrifice 且 value 8/12 的遗物（pool_sacrifice_n/r）
    const detail = excel.RoguelikeTopicTable.details[theme];
    const relicMap = this.inventory!.relic || {};
    const sacrificable = Object.values(relicMap).filter((r) => {
      const item = detail.items[r.id];
      return item?.canSacrifice && (item?.value === 8 || item?.value === 12);
    });
    // 扣除献祭代价（choice 为选项序号；默认第一个可献祭藏品）
    const choiceIdx = parseInt(args.choice ?? "0", 10) || 0;
    const offered = sacrificable[choiceIdx] || sacrificable[0];
    if (offered) {
      // relic 库存以 index（r_N）为键，按条目键删除
      delete relicMap[offered.index];
    }
    // 发放回报：随机未拥有藏品（池空回退金币）
    const hasRelic = Object.values(relicMap).map((r) => r.id);
    const rewardId = this._pool.getRelic("pool_relic_all", hasRelic);
    if (rewardId) {
      this._trigger.emit("rlv2:relic:gain", [{ id: rewardId, count: 1 }]);
    } else {
      this._trigger.emit("rlv2:get:items", [
        [{ id: `${theme}_gold`, count: 8 }],
      ]);
    }
    if (sacrificeEvent) {
      this._status._pending._pending.splice(
        this._status._pending._pending.indexOf(sacrificeEvent),
        1,
      );
    }
    await this.checkZoneEnd();
    this._status.state = "WAIT_MOVE";
  }

  async alchemy(args: { leave?: number; index?: string[] }): Promise<void> {
    if (args.leave) {
      this._status._pending._pending.length = 0;
      this._status.state = "WAIT_MOVE";
      return;
    }
    const fragmentMgr = this._module.fragment;
    if (fragmentMgr && args.index && args.index.length >= 2) {
      fragmentMgr.alchemy([args.index[0], args.index[1]]);
    }
    this._status.state = "WAIT_MOVE";
  }

  async alchemyReward(args: { index?: number }): Promise<void> {
    // 简化：炼金合成奖励已由 fragment.alchemy 发放；此处确认结算并关闭界面
    this._status._pending._pending.length = 0;
    this._status.state = "WAIT_MOVE";
  }

  async copperGild(args: { choice?: string; leave?: number }): Promise<void> {
    if (args.leave) {
      this._status._pending._pending.length = 0;
      this._status.state = "WAIT_MOVE";
      return;
    }
    const cm = this._module.copper;
    // 镀金当前已抽铜币（choice 为袋键）
    cm?.gild(args.choice || "");
    this._status.state = "WAIT_MOVE";
  }

  async copperRedraw(): Promise<{ copper: string[]; divineEventId: string }> {
    const cm = this._module.copper;
    const ret = cm?.redraw() || { copper: [], divineEventId: "" };
    this._status.state = "WAIT_MOVE";
    return ret;
  }

  /**
   * 更换铜钱（客户端 /rlv2/copper/change，CS: RoguelikeChangeCopperRequest { index }）
   *
   * 该端点用于结算 CHANGE_COPPER 挂起事件（客户端从铜钱界面上报所选 index）。
   * 本地不产生 CHANGE_COPPER 挂起（copper 模块为简化实现，仅 gild/redraw），
   * 故与参考实现（ODPY CopperChange 返回 202 空操作）保持一致：仅收敛状态机，
   * 不改铜钱袋，避免凭空改写袋内铜钱。index 存在时记 debug 日志便于后续对齐。
   * @param args - { index } 客户端所选铜钱袋键
   */
  async copperChange(args: { index?: string }): Promise<void> {
    const index = args?.index ?? "";
    if (index) {
      logger.debug("rlv2", `copper/change index=${index}（铜钱袋未改动，保持 ODPY 空操作语义）`);
    }
    this._status.state = "WAIT_MOVE";
  }

  /**
   * 确认抽铜钱（客户端 /rlv2/copper/confirmDraw，CS: RoguelikeConfirmDrawCopperRequest）
   *
   * 对齐参考实现（ODPY CopperConfirmDraw）：弹出当前挂起事件并回到 WAIT_MOVE，
   * 铜钱袋状态（bag/redrawFreezeCnt）由 copper 模块在抽取时已写入，此处不重复写。
   */
  async copperConfirmDraw(): Promise<void> {
    this._status._pending._pending.length = 0;
    this._status.state = "WAIT_MOVE";
  }

  setTroopCarry(args: { troopCarry: string[] }) {
    this._trigger.emit("rlv2:fragment:set_troop_carry", [args.troopCarry]);
  }

  loseFragment(args: { fragmentIndex: string }) {
    this._trigger.emit("rlv2:fragment:lose", [args.fragmentIndex]);
  }

  useInspiration(args: { fragmentIndex: string }) {
    this._trigger.emit("rlv2:fragment:use_inspiration", [args.fragmentIndex]);
  }

  async scrap(): Promise<void> {
    this._status.state = "WAIT_MOVE";
  }

  async scrapChangeVehicle(args: {
    scrapId?: string;
    scrapInstId?: string;
    toWalk?: number;
  }): Promise<void> {
    const sm = this._module.scrap;
    const instId = args.scrapInstId || args.scrapId || "";
    if (args.toWalk || instId === "") {
      sm?.changeVehicle("");
    } else {
      sm?.changeVehicle(instId);
    }
    this._status.state = "WAIT_MOVE";
  }

  async loseScrap(args: { instId: string }): Promise<void> {
    const sm = this._module.scrap;
    if (!sm) {
      this._status.state = "WAIT_MOVE";
      return;
    }
    const inventory = sm.inventory;
    const item = inventory[args.instId];
    if (!item) {
      this._status.state = "WAIT_MOVE";
      return;
    }
    const isVehicle = sm.activeVehicle?.instId === args.instId;
    // 先移除废品，再处理行商侧副作用——行商卖出/任务推送均为 await 异步，若提前 await
    // 侧副作用抛错会跳过 delete，导致"丢弃后废品仍留在包里"（客户端零件箱不更新）。
    // 置顶 delete 保证丢弃必生效，副作用放移除之后即便异常也不影响槽位清空。
    delete inventory[args.instId];
    if (isVehicle) {
      // 若丢弃的是当前载具，切回步行（模型无耐久度机制，载具被移除即视为"破除"）
      sm.activeVehicle = { isWalk: true };
      // 散件破除推送（rlv2ScrapBreak，触发类 RoguelikeScrapBreakTrigger）：携带破除散件 id
      this.pushMessage("rlv2ScrapBreak", { idList: [item.id] });
    } else if (this.isInShopNode()) {
      // 多边贸易（shop_recycle_reward）：在行商节点卖出零件（非载具）计数
      await this.sellScrapAtShop();
      // 特勤干员任务：行商卖出零件（Rlv2ShopRecycle，每件 1 计）
      await this._trigger.emit("Rlv2ShopRecycle", [
        { itemType: "SCRAP", count: 1 },
      ]);
    }
    this._status.state = "WAIT_MOVE";
  }

  async sellScrapAtShop(): Promise<void> {
    const recycle = this._buff.filterBuffs("shop_recycle_reward");
    if (recycle.length === 0) return;
    const buff = recycle[0];
    const sellCount = buff.blackboard[2]?.value ?? 3;
    if ((this._shopSellCount ?? 0) >= sellCount) return; // 本节点已达卖出上限
    this._shopSellCount = (this._shopSellCount ?? 0) + 1;
    if (this._shopSellCount >= sellCount) {
      const goldId =
        buff.blackboard[0]?.valueStr ||
        `${this.current.game!.theme}_gold`;
      const count = buff.blackboard[1]?.value ?? 8;
      await this._trigger.emit("rlv2:get:items", [[{ id: goldId, count }]]);
    }
  }

  async scrapIdentify(args: { count?: number }): Promise<{
    scrap: RoguelikeItemBundle[];
    legacy: RoguelikeItemBundle[];
  }> {
    const theme = this.current.game?.theme ?? "";
    const pool = Object.keys(
      excel.RoguelikeTopicTable.modules[theme]?.scrap?.scrapItemToType || {},
    );
    const count = Math.max(1, Math.min(args.count ?? 1, 3));
    const scrap: RoguelikeItemBundle[] = [];
    for (let i = 0; i < count && pool.length > 0; i++) {
      const id = pool[Math.floor(random() * pool.length)];
      scrap.push({ id, count: 1 });
      this._trigger.emit("rlv2:scrap:gain", [id]);
    }
    // legacy 部件：LEGACY 型物品（下次探索开局加成，本局无持续效果）
    const items = excel.RoguelikeTopicTable.details[theme]?.items || {};
    const legacyPool = Object.keys(items).filter(
      (id) => items[id]?.type === "LEGACY",
    );
    const legacy: RoguelikeItemBundle[] = [];
    const legacyCount = Math.floor(count / 2);
    for (let i = 0; i < legacyCount && legacyPool.length > 0; i++) {
      const id = legacyPool[Math.floor(random() * legacyPool.length)];
      legacy.push({ id, count: 1 });
      this._trigger.emit("rlv2:get:items", [[{ id, count: 1 }]]);
    }
    this._status.state = "PENDING";
    return { scrap, legacy };
  }

  toJSON(): PlayerRoguelikeV2 {
    // 结算完成后（gameSettle / _settled），本局运行态已结束，不再保留可"继续探索"的
    // current——输出全空（各节 null）。结算内容经 gameSettle 响应的顶层 extra
    // （buildSettleResponse 的 game/outer）下发，current 为空不影响结算页。
    // 也经 persistCurrent 落到存档，重登时 hasRunning=false → 不再提示"继续探索"。
    const current = this._settled
      ? {
          player: null,
          map: null,
          troop: null,
          inventory: null,
          game: null,
          buff: null,
          module: null,
          record: null,
        }
      : {
          player: this._status,
          record: this.current.record,
          map: this._map,
          inventory: this.inventory,
          game: this.current.game,
          troop: this.troop,
          buff: this.current.buff,
          module: this._module,
        };
    return {
      outer: this.outer,
      current,
      pinned: this.pinned,
    } as PlayerRoguelikeV2;
  }

  persistCurrent(): void {
    const pd = this._player._playerdata;
    if (!pd.rlv2?.current) return;
    const j = this.toJSON();
    this.writeCurrentView(pd.rlv2.current, j);
    this._player.markDirty();
  }

  snapshotCurrent(): PlayerRoguelikeV2 {
    const j = this.toJSON();
    const pd = this._player._playerdata;
    if (pd.rlv2?.current) {
      this.writeCurrentView(pd.rlv2.current, j);
      this._player.markDirty();
    }
    return j;
  }

  /**
   * 把内部模型形状的本局运行态写入存档 current（生成模型 = 线格式存储视图）
   *
   * 两套类型体系在边界处显式桥接：内部模型用便于实现的类型（instId: string、枚举
   * 字符串、boolean、current.record: any），生成模型为 FBO 线格式原生类型
   * （instId: number、枚举数值、数值布尔、必填字段更全），逐字段断言会被 TS 判为
   * 不可比，故按槽位整体赋值（运行时与逐字段赋值等价）。
   * @param target - 存档 current（生成模型视图）
   * @param j - toJSON 产出的内部模型视图
   */
  private writeCurrentView(
    target: typeof this._player._playerdata.rlv2.current,
    j: PlayerRoguelikeV2,
  ): void {
    Object.assign(target, {
      player: j.current.player,
      map: j.current.map,
      inventory: j.current.inventory,
      troop: j.current.troop,
      buff: j.current.buff,
      module: j.current.module,
      record: j.current.record,
      game: j.current.game,
    });
  }

  async unlockBuff(
    theme: string,
    buffId: string,
  ): Promise<{ success: boolean; reason?: string }> {
    const customize = excel.RoguelikeTopicTable.customizeData?.[theme] as
      | RoguelikeCustomizeDataView
      | undefined;
    const devs =
      customize?.developments && !Array.isArray(customize.developments)
        ? customize.developments
        : customize?.commonDevelopment?.developments;
    const dev = devs?.[buffId];
    if (!dev) return { success: false, reason: "NODE_NOT_FOUND" };

    const buff = this.outer[theme]?.buff;
    if (!buff) return { success: false, reason: "THEME_NOT_READY" };
    const unlocked = buff.unlocked || {};
    if (unlocked[buffId]) return { success: false, reason: "ALREADY_UNLOCKED" };
    const fronts = dev.frontNodeId || [];
    for (const f of fronts) {
      if (!unlocked[f]) return { success: false, reason: "FRONT_NOT_UNLOCKED" };
    }
    if (buff.pointOwned < dev.tokenCost)
      return { success: false, reason: "POINT_NOT_ENOUGH" };

    await this.update(async (draft) => {
      const db = draft.outer[theme].buff;
      db.pointOwned -= dev.tokenCost;
      db.pointCost = (db.pointCost || 0) + dev.tokenCost;
      db.unlocked = { ...(db.unlocked || {}), [buffId]: 1 };
      // 分队升级隐藏：解锁科技树节点后，若该节点对应分队升级（bandRef bandLevel>0
      // 的升级变体，如 分裂→指挥分队 band_2），升级分队 state 1、旧分队（normalBandId）state 0。
      // 官方机制：升级分队解锁后旧分队隐藏（同分队只显示最高等级）。
      const collectBand = draft.outer[theme]?.collect?.band;
      if (collectBand && typeof collectBand === "object") {
        this.applyBandUpgradeVisibility(theme, buffId, collectBand);
      }
    });
    return { success: true };
  }

  _gameSeed: string | null = null;

  /**
   * 待消费的自定义种子（/rlv2/setSeed 写入，下一局结算时一次性用掉）
   *
   * 官方 PlayerRoguelikeV2 存档无种子字段（种子只出现在 GAME_SETTLE 的 brief.seed），
   * 故与 _gameSeed 一致存于控制器内存：单进程私服下「设种子 → 开局 → 结算」同会话完成。
   * 服务重启后未消费的种子丢失（回退随机），不影响已开始的局。
   */
  _pendingSeed: string | null = null;

  gameSeed(): string {
    if (!this._gameSeed) {
      const theme = this.current.game?.theme ?? "";
      const grade = this.current.game?.modeGrade ?? 0;
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      // 自定义种子优先（setSeed 下发），一次性消费；否则随机 18 位（与官服种子长度一致）
      const rand =
        this._pendingSeed ??
        Array.from(
          { length: 18 },
          () => chars[Math.floor(random() * chars.length)],
        ).join("");
      this._pendingSeed = null;
      this._gameSeed = `${rand},${theme},${grade}`;
    }
    return this._gameSeed;
  }

  buildDetailStr(brief: ReturnType<typeof buildSettlement>["brief"]): string | null {
    const game = this.current.game;
    if (!game) return null;
    // troopChars：当前队伍干员（官方 detailStr 每干员仅 6 字段，无 potentialRank/mainSkillLvl）
    const troopChars = Object.values(this.troop.chars).map((c) => ({
      instId: String(c.instId),
      charId: c.charId,
      type: c.type || "NORMAL",
      upgradePhase: c.upgradePhase ?? 0,
      evolvePhase: c.evolvePhase ?? 0,
      level: c.level ?? 1,
    }));
    // initial：开局配置。私服未单独采集开局快照，relics 用当前藏品、
    // recruits 用当前队伍近似（官方此处为开局确定的 3 名初始干员）。
    const initial = {
      mode: game.mode ?? "NORMAL",
      band: this._bandId || "",
      relics: Object.keys(this.inventory?.relic || {}),
      support: "",
      supportMulti: [],
      recruitSet: "",
      recruits: troopChars.map((t) => ({
        charId: t.charId,
        type: t.type,
        cost: 0,
      })),
      upgrades: [],
    };
    // zones：每层区域。私服无 per-step 物品获取记录，steps 留空（键结构对齐）。
    const zones = Object.values(this._map.zones || {}).map((z) => ({
      index: z.index,
      zoneId: z.id,
      variation: Array.isArray(z.variation) ? z.variation : [],
      type: 0,
      pass: false,
      steps: [],
      snapRecruits: [],
      snapSettleCover: {},
      expeditionReturn: { chars: [] },
    }));
    const payload = { brief, troopChars, initial, zones };
    // deflateSync 默认 level 6 → zlib 头 0x78 0x9c → base64 前缀 "eJ"（与官服一致）
    return zlib.deflateSync(Buffer.from(JSON.stringify(payload))).toString("base64");
  }

  generateShopGoods(theme: string) : ReturnType<typeof generateShopGoods> {
    return generateShopGoods(this, theme);
  }

  buildShopContent(theme: string) : ReturnType<typeof buildShopContent> {
    return buildShopContent(this, theme);
  }

  async buyGoods(args: { select: number }) : Promise<void> {
    return buyGoods(this, args);
  }

  async refreshShop() : Promise<void> {
    return refreshShop(this);
  }

  async leaveShop() : Promise<void> {
    return leaveShop(this);
  }

  async shopBattleStart() : Promise<void> {
    return shopBattleStart(this);
  }

  isInShopNode() : boolean {
    return isInShopNode(this);
  }

  async bankPut() : Promise<void> {
    return bankPut(this);
  }

  async bankWithdraw(args: { count?: number }) : Promise<void> {
    return bankWithdraw(this, args);
  }

  applyBandUpgradeVisibility(theme: string,
    buffId: string,
    collectBand: { [key: string]: { state: number } },) : void {
    return applyBandUpgradeVisibility(this, theme, buffId, collectBand);
  }

  initModeGradeStates(theme: string,
    map?: Parameters<typeof initModeGradeStates>[2],
    game?: Parameters<typeof initModeGradeStates>[3],) : ReturnType<typeof initModeGradeStates> {
    return initModeGradeStates(this, theme, map, game);
  }

  maxClearedGrade(cleared: Set<number>) : number {
    return maxClearedGrade(this, cleared);
  }

  buildSettlement(over: boolean,
    success: number,
    ending: string,) : ReturnType<typeof buildSettlement> {
    return buildSettlement(this, over, success, ending);
  }

  exploreBreakdown() : { detail: number[][]; raw: number } {
    return exploreBreakdown(this);
  }

  exploreScoreFactor() : number {
    return exploreScoreFactor(this);
  }

  exploreScore() : number {
    return exploreScore(this);
  }

  lifeGameNodes(theme: string) : string[] {
    return lifeGameNodes(this, theme);
  }

  blackstreamEfficiency(theme: string, grade: number) : number {
    return blackstreamEfficiency(this, theme, grade);
  }

  canEvolveOperators(theme: string) : boolean {
    return canEvolveOperators(this, theme);
  }

  blackstreamAwards() : { sourceScore: number; efficiency: number } {
    return blackstreamAwards(this);
  }

  async gameSettle() : Promise<void> {
    return gameSettle(this);
  }

  buildSettleResponse() : ReturnType<typeof buildSettleResponse> {
    return buildSettleResponse(this);
  }

  async rerollNode(args: { nodeIndex: string }) : Promise<void> {
    return rerollNode(this, args);
  }

  async upgradeNode(args: { nodeType: string }) : Promise<void> {
    return upgradeNode(this, args);
  }

  async gridZoneMoveTo(args: { route: string[] }) : Promise<void> {
    return gridZoneMoveTo(this, args);
  }

  createRogue6NodeScene(nodeType: number) : boolean {
    return createRogue6NodeScene(this, nodeType);
  }

  createPortalScene() : void {
    return createPortalScene(this);
  }

  enterPortalZone(family: string) : void {
    return enterPortalZone(this, family);
  }

  consumePortalScrap() : boolean {
    return consumePortalScrap(this);
  }

  startChaosSourceBattle() : void {
    return startChaosSourceBattle(this);
  }

  gainPreciousScrap() : void {
    return gainPreciousScrap(this);
  }

  gainRandomScrap() : void {
    return gainRandomScrap(this);
  }

  isBeakUnlocked() : boolean {
    return isBeakUnlocked(this);
  }

  createFateScene() : void {
    return createFateScene(this);
  }

  async createIncidentScene() : Promise<boolean> {
    return createIncidentScene(this);
  }

  async gridZoneMoveAndBattleStart(args: {
    route: string[];
    stageId: string;
    squad: PlayerSquad;
  }) : Promise<void> {
    return gridZoneMoveAndBattleStart(this, args);
  }

  async gridZoneEmptyStep() : Promise<void> {
    return gridZoneEmptyStep(this);
  }

  async gridZoneReadStepZero() : Promise<void> {
    return gridZoneReadStepZero(this);
  }

  _normalizeMutablePlayerdata() : PlayerDataModel {
    return _normalizeMutablePlayerdata(this);
  }

  async setPinned(args: { id: string }) : Promise<void> {
    return setPinned(this, args);
  }

  async giveUpGame() : Promise<void> {
    return giveUpGame(this);
  }

  async createGame(args: {
    theme: string;
    mode: string;
    modeGrade: number;
    predefinedId: string | null;
  }) : Promise<void> {
    return createGame(this, args);
  }

  ensureOuterTheme(theme: string,
    outerMap?: Parameters<typeof ensureOuterTheme>[2],
    game?: Parameters<typeof ensureOuterTheme>[3],) : void {
    return ensureOuterTheme(this, theme, outerMap, game);
  }

  async refreshMission(args: { theme?: string; index?: number }) : Promise<void> {
    return refreshMission(this, args);
  }

  /** 委派至 {@link setSeed}（game-init.ts）：设置自定义种子，返回 CS ResultCode */
  async setSeed(args: { seed: string }) : Promise<{ result: number }> {
    return setSeed(this, args);
  }

  async chooseInitialRelic(args: { select: string }) {
    return chooseInitialRelic(this, args);
  }

  async chooseInitialRecruitSet(args: { select: string }) {
    return chooseInitialRecruitSet(this, args);
  }

  async chooseInitialExploreTool(args: { select: string }) : Promise<void> {
    return chooseInitialExploreTool(this, args);
  }

  async update<T>(
    recipe: (draft: Draft<PlayerRoguelikeV2>) => Promise<T>,
  ): Promise<T> {
    // finishDraft 后 PlayerStatus 已把 rlv2 子树替换为深可变副本（autoFreeze 兼容）；
    // this.outer/current/pinned 为 live getter，每次读取 _playerdata.rlv2，天然与持久态
    // 同步，无需在此手动刷新（避免持有对旧冻结对象的陈旧引用）。
    return await this._player.update(async (draft) => {
      return await recipe(draft.rlv2 as unknown as Draft<PlayerRoguelikeV2>);
    });
  }
  /** 委派至 {@link finishEvent}（event.ts） */
  async finishEvent() {
    return finishEvent(this);
  }
  /** 委派至 {@link hasReachedZone3}（event.ts） */
  hasReachedZone3(stageCnt?: Record<string, number>) : boolean {
    return hasReachedZone3(this, stageCnt);
  }
  /** 委派至 {@link locateStartNode}（event.ts） */
  locateStartNode() : { x: number; y: number } | undefined {
    return locateStartNode(this);
  }
  /** 委派至 {@link zoneKey}（event.ts） */
  zoneKey(zone: number) : string | number {
    return zoneKey(this, zone);
  }
  /** 委派至 {@link isZoneEnd}（event.ts） */
  isZoneEnd() : boolean {
    return isZoneEnd(this);
  }
  /** 委派至 {@link checkZoneEnd}（event.ts） */
  async checkZoneEnd() : Promise<boolean> {
    return checkZoneEnd(this);
  }
  /** 委派至 {@link hasRelic}（event.ts） */
  hasRelic(id: string) : boolean {
    return hasRelic(this, id);
  }
  /** 委派至 {@link emitSpecialOperatorZone}（event.ts） */
  async emitSpecialOperatorZone(zone: number) : Promise<void> {
    return emitSpecialOperatorZone(this, zone);
  }
  /** 委派至 {@link nodeTypeCounts}（event.ts） */
  nodeTypeCounts() : Map<number, number> {
    return nodeTypeCounts(this);
  }
  /**
   * 委派至 {@link emitSpecialOperatorSettle}（event.ts）
   * @param snapshot 结算前本局运行态快照（结算 update 会清空运行态，须由调用方下传）
   */
  async emitSpecialOperatorSettle(theme: string,
    ending: string,
    snapshot?: {
      charIds: string[];
      nodeCounts: Map<number, number>;
      bandId: string;
      mode: string;
    },) : Promise<void> {
    return emitSpecialOperatorSettle(this, theme, ending, snapshot);
  }
  /** 委派至 {@link selectChoice}（event.ts） */
  async selectChoice(args: { choice: string }) : Promise<void> {
    return selectChoice(this, args);
  }
  /** 委派至 {@link readEndingChange}（event.ts） */
  async readEndingChange() : Promise<void> {
    return readEndingChange(this);
  }
  /** 委派至 {@link moveAndBattleStart}（battle-nav.ts） */
  async moveAndBattleStart(args: {
    to: RoguelikeNodePosition;
    stageId: string;
    squad: PlayerSquad;
  }) : Promise<string> {
    return moveAndBattleStart(this, args);
  }
  /** 委派至 {@link moveTo}（battle-nav.ts） */
  async moveTo(args: { to: RoguelikeNodePosition }) : Promise<void> {
    return moveTo(this, args);
  }
  /** 委派至 {@link createNodeScene}（battle-nav.ts） */
  createNodeScene(theme: string, nodeType: number) : void {
    return createNodeScene(this, theme, nodeType);
  }
  /** 委派至 {@link confirmZoneReward}（battle-nav.ts） */
  async confirmZoneReward() : Promise<void> {
    return confirmZoneReward(this);
  }
  /** 委派至 {@link confirmTraderReturn}（battle-nav.ts） */
  async confirmTraderReturn() : Promise<void> {
    return confirmTraderReturn(this);
  }
  /** 委派至 {@link specialZoneLeave}（battle-nav.ts） */
  async specialZoneLeave() : Promise<void> {
    return specialZoneLeave(this);
  }
  /** 委派至 {@link battlePassGetReward}（battle-nav.ts） */
  async battlePassGetReward(theme: string,
    rewards: string[],) : Promise<{ items: ItemBundle[] }> {
    return battlePassGetReward(this, theme, rewards);
  }

  /** 委派至 {@link battlePassBuyReward}（battle-nav.ts）：战令直购（扣点数发奖） */
  async battlePassBuyReward(theme: string, reward: string,
    cost: number,) : Promise<{ items: ItemBundle[] }> {
    return battlePassBuyReward(this, theme, reward, cost);
  }
  /** 委派至 {@link chooseBattleReward}（reward.ts） */
  async chooseBattleReward(args: { index: number; sub: number }) {
    return chooseBattleReward(this, args);
  }
  /** 委派至 {@link finishBattleReward}（reward.ts） */
  async finishBattleReward(args: {}) {
    return finishBattleReward(this, args);
  }
  /** 委派至 {@link activeRecruitTicket}（recruit-flow.ts） */
  async activeRecruitTicket(args: { id: string }) {
    return activeRecruitTicket(this, args);
  }
  /** 委派至 {@link recruitChar}（recruit-flow.ts） */
  async recruitChar(args: {
    ticketIndex: string;
    optionId: string;
  }) : Promise<PlayerRoguelikeV2.CurrentData.RecruitChar[]> {
    return recruitChar(this, args);
  }
  /** 委派至 {@link closeRecruitTicket}（recruit-flow.ts） */
  async closeRecruitTicket(args: { id: string }) : Promise<void> {
    return closeRecruitTicket(this, args);
  }
  /** 委派至 {@link getTicketAssistList}（recruit-flow.ts） */
  async getTicketAssistList(args: {
    ticketIndex: string;
    profession: string;
  }) : Promise<void> {
    return getTicketAssistList(this, args);
  }
  /** 委派至 {@link recruitAssistChar}（recruit-flow.ts） */
  async recruitAssistChar(args: {
    ticketIndex: string;
    profession: string;
    assistUid: string;
    assistCharId: string;
  }) : Promise<void> {
    return recruitAssistChar(this, args);
  }
  /** 委派至 {@link stashRecruitTicket}（recruit-flow.ts） */
  async stashRecruitTicket(args: { index: string }) : Promise<void> {
    return stashRecruitTicket(this, args);
  }
  /** 委派至 {@link useStashedTicket}（recruit-flow.ts） */
  async useStashedTicket(args: { id: string }) : Promise<void> {
    return useStashedTicket(this, args);
  }
}
