/**
 * 黑流树海（rogue_6）不期而遇事件引擎
 *
 * 事件全集与效果对照 prts.wiki「沉沦者的黑流树海/事件一览」（2026-08-25 抓取）：
 * - 资源类（res1 桑尼的邀请 / res2 色味不同源 / res3 货从口出 / res4 沉重的契约 / res5 敲动杠杆）
 * - 藏品类（relic1 血衣之下 / relic2 擒与缚）
 * - 剧情链（normal1 沉寂之屋 → normal2 黑诞 / normal3 呼吸的红苔 / normal4 被歌颂的影子 / normal5 愈创之心）
 * - 战斗类（bat1 思乡心切 / bat2 划算买卖 / bat3 鸭托邦 / bat4 传奇团伙 / bat5 湖中仙女 /
 *   bat6 洞中宝（含误入奇境内的 bat6b 差分））
 * - 特殊（task1 和平守卫者 / task2 独活 / chimera2 泪之聚落——三结局“？”标记事件）
 *
 * 数据驱动：场景池/场景图/随机分支/战斗关卡/随机发放/选项门槛全部来自
 * `data/rlv2/event_choices.json` 的 `rogue_6` 段；消耗按官方选项描述文本
 * （<@ro6.lose>N</> 标签与“消耗/失去…”字样）解析，发放优先取官方
 * displayData.itemID（rogue_6_gold/hp/ap/population/hpmax/shield 等虚拟物品的
 * 结算走 inventory.getItem 的既有类型处理器）。
 *
 * 近似说明（服务端边界）：
 * - 「希望的沃土」（normal3）的下一区域实托邦生成未接入（FEATURE 型物品无结算）；
 * - task1_3/task2_3（MOVE）的“立即前往/传送到应急助力”与 task1_4/task2_4（VISION）的
 *   地图标记为客户端表现，服务端按结束节点处理；
 * - normal4 各圈奖励的官方多差分场景合并为单一奖励幕（选项全量给出）。
 */
import excel from "@excel/excel";
import type {
  RoguelikeGameChoiceData,
  RoguelikeTopicDetail,
} from "@excel/excel";
import { RoguelikeV2Manager } from "./logic";
import type { RoguelikeGridZoneManager } from "./modules/grid_zone";
import type { RoguelikeScrapManager } from "./modules/scrap";
import { random } from "@utils/random";

/** rogue_6 event_choices.json 段的松散类型（其余主题同键结构不同，不做严格契约） */
interface Ro6IncidentCond {
  floors?: number[];
  repeat?: boolean;
  requireScene?: string;
  requireRelic?: string;
}
interface Ro6Grant {
  kind: "relic" | "relic_rare" | "scrap_move" | "scrap_passive" | "scrap_goods";
  count?: number;
}
type Ro6BattleSpec = string | { random?: string[]; nextZoneNormal?: boolean };

/** 选项门槛（event_choices.json gates[choice]） */
interface Ro6Gate {
  relic?: string;
  notRelic?: string;
  scrap?: string;
  gold?: number;
  develop?: string;
}

/** 非战斗节点入口（event_choices.json nodeEnters[kind]） */
interface Ro6NodeEnter {
  scene?: string;
  scenes?: string[];
  beaconScene?: string;
  randomChoices?: number;
}

/**
 * rogue_6 event_choices.json 段（`_data.eventChoices.rogue_6`）。
 *
 * `RoguelikeV2Config.eventChoices` 仅建模各主题公共的 enter/choices 两键，本引擎使用的
 * incidents/sceneChoices/randomScenes/battles/grants/gates/nodeEnters 为其外的增量段，
 * 故在此按数据实际形状声明并在取值处单点收窄（同 settle.ts 对 customizeData 的处理）。
 */
interface Ro6EventChoicesData {
  enter?: { [sceneId: string]: string[] };
  incidents?: { [sceneId: string]: Ro6IncidentCond };
  sceneChoices?: { [sceneId: string]: string[] };
  randomScenes?: { [choiceId: string]: string[] };
  battles?: { [choiceId: string]: Ro6BattleSpec };
  grants?: { [choiceId: string]: Ro6Grant };
  gates?: { [choiceId: string]: Ro6Gate };
  nodeEnters?: { [kind: string]: Ro6NodeEnter };
}

/** 选项 displayData 视图（生成模型字段名为 itemID，数据侧另有小写 itemId 兜底） */
interface Ro6ChoiceDisplayData {
  itemID?: string;
  itemId?: string;
}

/**
 * 远征详情视图：`troop.expeditionDetails` 管理器字段声明为 `{ [key: string]: number }`，
 * 但三结局远征标记实际写入布尔 `ending`（event.ts 同源写法，见 rlv2-ending-3 测试断言
 * `expeditionDetails.ending === true`）。
 */
interface ExpeditionDetailsView {
  [key: string]: number | boolean;
}

/** 不期而遇事件引擎（控制器持有单例，随控制器持久） */
export class Rogue6IncidentEngine {
  _player: RoguelikeV2Manager;

  constructor(player: RoguelikeV2Manager) {
    this._player = player;
  }

  /** rogue_6 事件配置段（incidents/enter/sceneChoices/randomScenes/battles/grants/gates） */
  private get data(): Ro6EventChoicesData | undefined {
    return this._player._data?.eventChoices?.["rogue_6"] as
      | Ro6EventChoicesData
      | undefined;
  }

  private get detail(): Partial<RoguelikeTopicDetail> {
    const theme = this._player.current.game?.theme || "";
    return excel.RoguelikeTopicTable.details[theme] || {};
  }

  /** 网格区域管理器（GRID_ZONE：模块访问器声明为 any，按实现类收窄） */
  private get gridZone(): RoguelikeGridZoneManager | undefined {
    return this._player._module?.gridZone as
      | RoguelikeGridZoneManager
      | undefined;
  }

  /** 废品管理器（SCRAP：模块访问器声明为 any，按实现类收窄） */
  private get scrap(): RoguelikeScrapManager | undefined {
    return this._player._module?.scrap as RoguelikeScrapManager | undefined;
  }

  /**
   * 不期而遇节点（INCIDENT）入点：按当前层/遭遇记录/持有物过滤事件池随机抽一幕。
   * 线人（bomb1）由控制器优先判定；本方法兜底通用池。
   * @returns 已生成事件场景返回 true；池为空（数据缺失等）返回 false 交回旧分发
   */
  async createIncident(): Promise<boolean> {
    const player = this._player;
    const incidents = this.data?.incidents;
    if (!incidents) return false;
    const zone = player._status.cursor.zone;
    const inPortal = !!this.gridZone?.portal?.active;
    const seen = this.seenList();
    const pool = Object.entries(incidents).filter(([id, c]) => {
      if (c.floors && !c.floors.includes(zone)) return false;
      if (c.requireScene && !seen.includes(c.requireScene)) return false;
      if (c.requireRelic && !this.hasRelic(c.requireRelic)) return false;
      if (!c.repeat && seen.includes(id)) return false;
      return true;
    });
    if (pool.length === 0) return false;
    let [sceneId] = pool[Math.floor(random() * pool.length)];
    // 误入奇境隐藏层内「洞中宝」使用 bat6b 差分（官方：内外各出现一次）
    if (inPortal && sceneId === "scene_ro6_bat6_enter") {
      sceneId = "scene_ro6_bat6b_enter";
    }
    this.markSeen(
      sceneId === "scene_ro6_bat6b_enter" ? "scene_ro6_bat6_enter" : sceneId,
    );
    const enter = this.data?.enter?.[sceneId];
    if (!enter) return false;
    await this.openScene(sceneId, enter);
    return true;
  }

  /**
   * 结算不期而遇事件选项：消耗/发放/随机分支/场景推进/战斗。
   * @param choice 选项 id（choice_ro6_ 前缀的 res/relic/normal/bat/bat6b/task/chimera 系列）
   * @returns 已处理返回 true；选项不在事件表内返回 false（交回通用路径）
   */
  async resolveChoice(choice: string): Promise<boolean> {
    const player = this._player;
    const choiceConfig = this.detail.choices?.[choice];
    if (!choiceConfig || !this.data) return false;

    // 战斗选项：映射关卡后开始战斗（节点标记 stage 供客户端/结算使用）
    const battleSpec = this.data.battles?.[choice];
    if (battleSpec) {
      this.startIncidentBattle(battleSpec);
      return true;
    }

    // 消耗：按官方描述文本解析（先扣后发，与客户端结算顺序一致）
    const descPlain = (choiceConfig.description || "").replace(
      /<[^>]+>/g,
      "",
    );
    this.applyDescriptionCost(descPlain);
    // 发放：官方 displayData.itemID + 描述 GET 数量；无 itemID 的随机奖励查 grants 表
    await this.applyGrants(choice, choiceConfig);

    // 沉寂之屋遭遇记录（呼吸的红苔的前置条件）
    if (/^choice_ro6_normal1_/.test(choice)) {
      this.markSeen("scene_ro6_normal1_enter");
    }

    // 随机分支场景优先，其次官方 nextSceneId
    const rand = this.data.randomScenes?.[choice];
    let nextScene: string | null = null;
    if (Array.isArray(rand) && rand.length > 0) {
      nextScene = rand[Math.floor(random() * rand.length)];
    } else {
      nextScene = choiceConfig.nextSceneId || null;
    }
    if (!nextScene) {
      // 终端选项（战斗外的 MOVE/VISION/无后续幕）：节点结束
      player._status.pending.shift();
      player._status.state = "WAIT_MOVE";
      return true;
    }
    await this.openScene(nextScene);
    return true;
  }

  /**
   * 打开场景（SCENE 事件）：选项取场景图表（未登记的幕默认仅"离开"），
   * 条件选项（持有笼控器/源石锭>50 等）不满足时剔除。
   * @param sceneId 场景 id
   * @param overrideChoices enter 场景的选项列表（来自 enter 表）
   */
  private async openScene(
    sceneId: string,
    overrideChoices?: string[],
  ): Promise<void> {
    const player = this._player;
    player._status.pending.shift();
    await this.emitScene(sceneId, overrideChoices);
  }

  /** 直接下发场景事件（不消费 pending）：选项经门槛过滤，未登记场景默认仅"离开" */
  private async emitScene(
    sceneId: string,
    overrideChoices?: string[],
  ): Promise<void> {
    const player = this._player;
    const raw =
      overrideChoices ??
      (this.data!.sceneChoices?.[sceneId] || ["choice_leave"]);
    const list = raw.filter(
      (c) => c === "choice_leave" || this.passGate(c),
    );
    if (list.length === 0) list.push("choice_leave");
    const choices = list.reduce((acc, c) => ({ ...acc, [c]: 1 }), {});
    const choiceAdditional = list.reduce(
      (acc, c) => ({ ...acc, [c]: { rewards: [] } }),
      {},
    );
    player._status.state = "PENDING";
    await player._trigger.emit("rlv2:event:create", [
      "SCENE",
      {
        scene: { id: sceneId, choices, choiceAdditional },
        done: false,
        popReport: false,
      },
    ]);
  }

  /** 选项门槛判定（gates 表：需持有收藏品/零件/源石锭，或不得持有，或已点亮科技树节点） */
  private passGate(choice: string): boolean {
    const g = this.data?.gates?.[choice];
    if (!g) return true;
    if (g.relic && !this.hasRelic(g.relic)) return false;
    if (g.notRelic && this.hasRelic(g.notRelic)) return false;
    if (g.scrap && !this.hasScrap(g.scrap)) return false;
    if (g.develop && !this.developUnlocked(g.develop)) return false;
    if (typeof g.gold === "number") {
      const gold = this._player._status.property.gold;
      if (gold < g.gold) return false;
    }
    return true;
  }

  /** 【生命游戏】科技树节点是否已点亮（失与得声带/手掌等选项门槛） */
  private developUnlocked(outbuffId: string): boolean {
    const player = this._player;
    const theme = player.current.game?.theme || "";
    return !!player.outer?.[theme]?.buff?.unlocked?.[outbuffId];
  }

  /**
   * 按官方描述文本结算消耗：
   * 全部/一半源石锭、N源石锭、N目标生命值（至少保留1）、一半目标生命值、
   * N行动力、随机2件加工品、1枚种子、源私钥。
   */
  private applyDescriptionCost(desc: string): void {
    const player = this._player;
    const prop = player._status.property;
    if (/消耗[^。，]*全部[^。，]*源石锭/.test(desc)) {
      prop.gold = 0;
      return;
    }
    if (/消耗[^。，]*一半[^。，]*源石锭/.test(desc)) {
      prop.gold = Math.ceil(prop.gold / 2);
      return;
    }
    if (/消耗一半目标生命值/.test(desc)) {
      prop.hp.current = Math.max(1, Math.ceil(prop.hp.current / 2));
      return;
    }
    if (/消耗源私钥/.test(desc)) {
      this.loseRelic("rogue_6_relic_cargo_13");
      return;
    }
    if (/消耗随机?\s*\d+\s*件加工品/.test(desc)) {
      this.loseScrapByType("MOVE", 2);
      return;
    }
    if (/种下\s*\d+\s*枚种子/.test(desc)) {
      this.loseScrapById("rogue_6_scrap_G_01", 1);
      return;
    }
    let m = /(?:消耗|失去)\s*(\d+)\s*行动力/.exec(desc);
    if (m) {
      const gz = this.gridZone;
      if (gz) gz.stepRemain = Math.max(0, (gz.stepRemain || 0) - parseInt(m[1], 10));
      return;
    }
    m = /(?:消耗|失去)\s*(\d+)\s*源石锭/.exec(desc);
    if (m) {
      prop.gold = Math.max(0, prop.gold - parseInt(m[1], 10));
      return;
    }
    m = /(?:消耗|失去)\s*(\d+)\s*目标生命值/.exec(desc);
    if (m) {
      const n = parseInt(m[1], 10);
      const keepMin = desc.includes("至少保留");
      prop.hp.current = keepMin
        ? Math.max(1, prop.hp.current - n)
        : prop.hp.current - n;
    }
  }

  /** 发放：官方 displayData.itemID（虚拟资源物品）+ grants 表的随机奖励 */
  private async applyGrants(
    choice: string,
    choiceConfig: RoguelikeGameChoiceData,
  ): Promise<void> {
    const player = this._player;
    const dd: Ro6ChoiceDisplayData = choiceConfig?.displayData || {};
    const officialItem = dd.itemID ?? dd.itemId;
    if (officialItem) {
      const m = (choiceConfig?.description || "").match(
        /<@ro\d+\.get>(\d+)<\/>/,
      );
      const count = m ? parseInt(m[1], 10) : 1;
      await player._trigger.emit("rlv2:get:items", [
        [{ id: officialItem, count }],
      ]);
    }
    const grant = this.data?.grants?.[choice];
    if (grant) {
      await this.grantRandom(grant.kind, grant.count ?? 1);
    }
  }

  /**
   * 随机发放（官方描述"获得1件随机…"）：
   * 收藏品（池抽/珍贵=高稀有度优先）、加工品/概念体/自然物（零件池按类型抽）。
   */
  private async grantRandom(kind: Ro6Grant["kind"], count: number): Promise<void> {
    const player = this._player;
    if (kind === "relic" || kind === "relic_rare") {
      for (let i = 0; i < count; i++) {
        const owned = Object.values(player.inventory?.relic || {}).map(
          (r) => r.id,
        );
        let id: string | undefined;
        if (kind === "relic_rare") {
          const items = this.detail.items || {};
          const rarePool = Object.keys(items).filter(
            (k) =>
              items[k]?.type === "RELIC" &&
              items[k]?.rarity === "SUPER_RARE" &&
              !owned.includes(k),
          );
          id = rarePool[Math.floor(random() * rarePool.length)];
        }
        id = id || player._pool?.getRelic("pool_relic_all", owned);
        if (id) {
          await player._trigger.emit("rlv2:relic:gain", [{ id, count: 1 }]);
        }
      }
      return;
    }
    const scrapTypeMap = excel.RoguelikeTopicTable.modules["rogue_6"]?.scrap
      ?.scrapItemToType;
    const want =
      kind === "scrap_move"
        ? "MOVE"
        : kind === "scrap_passive"
          ? "PASSIVE"
          : "GOODS";
    const pool = Object.keys(scrapTypeMap ?? {}).filter(
      (id) => scrapTypeMap?.[id] === want,
    );
    if (pool.length === 0) return;
    for (let i = 0; i < count; i++) {
      const id = pool[Math.floor(random() * pool.length)];
      await player._trigger.emit("rlv2:scrap:gain", [id]);
    }
  }

  /** 开始事件战斗：解析关卡（指定/随机/下一层普通作战）→ 节点标记 + BATTLE 事件 */
  private startIncidentBattle(spec: Ro6BattleSpec): void {
    const player = this._player;
    let stageId: string | undefined;
    if (typeof spec === "string") {
      stageId = spec;
    } else if (Array.isArray(spec.random) && spec.random.length > 0) {
      stageId = spec.random[Math.floor(random() * spec.random.length)];
    } else if (spec.nextZoneNormal) {
      const zone = Math.min((player._status.cursor.zone || 1) + 1, 6);
      const keys = Object.keys(this.detail.stages || {}).filter((k) =>
        k.startsWith(`ro6_n_${zone}_`),
      );
      stageId = keys[Math.floor(random() * keys.length)];
    }
    if (stageId) {
      const pos = player._status.cursor.position;
      if (pos) {
        const node =
          player._map.zones[this.zoneKeyOf(player._status.cursor.zone)]
            ?.nodes?.[pos.x * 100 + pos.y];
        if (node) node.stage = stageId;
      }
    }
    player._status.pending.shift();
    player._status.state = "PENDING";
    player._trigger.emit("rlv2:event:create", [
      "BATTLE",
      {
        state: 1,
        chestCnt: 100,
        goldTrapCnt: 100,
        diceRoll: [],
        boxInfo: {},
        tmpChar: [],
        sanity: 0,
        // 修复（2026-09-11）：遭遇战原固定空数组 → 丢失藏品/难度增益
        unKeepBuff: player._buff.getBuffs(),
      },
    ]);
  }

  /** 当前层地图键（误入奇境隐藏层 → portal 键；黑流树海常规层 → 1000+ 键） */
  private zoneKeyOf(zone: number): string | number {
    const player = this._player;
    const zones = player._map.zones;
    const gz = this.gridZone;
    if (gz?.portal?.active && gz.portal.zoneKey) return gz.portal.zoneKey;
    if (zones[zone]) return zone;
    if (zones[String(1000 + zone - 1)]) return String(1000 + zone - 1);
    return zone;
  }

  /** 本局遭遇记录（持久于 current.game，供非重复事件与前置条件判定） */
  private seenList(): string[] {
    const game = this._player.current.game;
    if (!game) return [];
    if (!Array.isArray(game.incidentSeen)) game.incidentSeen = [];
    return game.incidentSeen;
  }

  private markSeen(sceneId: string): void {
    const list = this.seenList();
    if (!list.includes(sceneId)) list.push(sceneId);
  }

  private hasRelic(id: string): boolean {
    return Object.values(this._player.inventory?.relic || {}).some(
      (r) => r.id === id,
    );
  }

  private hasScrap(id: string): boolean {
    const scrap = this.scrap;
    return Object.values(scrap?.inventory || {}).some((it) => it.id === id);
  }

  /** 移除收藏品（首个匹配实例）：愈创之心消耗源私钥 */
  private loseRelic(id: string): void {
    this._player.inventory?._relic?.lose?.(id);
  }

  /** 按零件类型移除 n 件（估价低者优先，与误入奇境扣加工品一致） */
  private loseScrapByType(type: string, n: number): void {
    const player = this._player;
    const scrap = this.scrap;
    if (!scrap) return;
    const scrapTypeMap = excel.RoguelikeTopicTable.modules["rogue_6"]?.scrap
      ?.scrapItemToType;
    const cands = Object.values(scrap.inventory || {})
      .filter((it) => scrapTypeMap?.[it.id] === type)
      .sort((a, b) => a.value - b.value);
    for (let i = 0; i < n && i < cands.length; i++) {
      const it = cands[i];
      delete scrap.inventory[it.instId];
      if (scrap.activeVehicle?.instId === it.instId) {
        scrap.activeVehicle = { isWalk: true };
      }
    }
  }

  /** 按零件 id 移除 n 件（呼吸的红苔消耗种子） */
  private loseScrapById(id: string, n: number): void {
    const scrap = this.scrap;
    if (!scrap) return;
    const cands = Object.values(scrap.inventory || {}).filter(
      (it) => it.id === id,
    );
    for (let i = 0; i < n && i < cands.length; i++) {
      const it = cands[i];
      delete scrap.inventory[it.instId];
      if (scrap.activeVehicle?.instId === it.instId) {
        scrap.activeVehicle = { isWalk: true };
      }
    }
  }

  /* ===== 非战斗事件节点（对照 prts.wiki 事件节点节）===== */

  /**
   * 非战斗节点入点（安全的角落/得偿所愿/失与得/险路尽头/险路小径）：
   * 按 nodeEnters 表选入口场景并下发选项。安全的角落官方"随机出现 3 个"选项；
   * 失与得持怦然信标时进入含"复原文明"的差分（三结局削弱前置）。
   * @param kind 节点类型数值（ROGUE6_NODE）
   * @returns 已生成场景返回 true；无配置返回 false 交回旧前缀分发
   */
  async createNodeScene(kind: number): Promise<boolean> {
    const enter = this.data?.nodeEnters?.[String(kind)];
    if (!enter) return false;
    let sceneId = enter.scene || "";
    if (Array.isArray(enter.scenes) && enter.scenes.length > 0) {
      sceneId = enter.scenes[Math.floor(random() * enter.scenes.length)];
    }
    // 三结局削弱差分：持怦然信标后失与得提供"复原文明"选项（焚毁文明）
    if (enter.beaconScene && this.hasRelic("rogue_6_relic_final_3")) {
      sceneId = enter.beaconScene;
    }
    if (!sceneId) return false;
    let list = this.data?.enter?.[sceneId] || [];
    if (enter.randomChoices && list.length > enter.randomChoices) {
      list = [...list]
        .sort(() => random() - 0.5)
        .slice(0, enter.randomChoices);
    }
    list = list.filter((c) => c === "choice_leave" || this.passGate(c));
    if (list.length === 0) return false;
    await this.emitScene(sceneId, list);
    return true;
  }

  /**
   * 结算非战斗节点选项（rest/wish/sacrifice/final/evacuate/scout 系列）：
   * - ZONE_END（险路尽头进区/险路小径离开）→ 标记节点终点并推进区域（checkZoneEnd
   *   处理结局判定/区域奖励/远征归来）
   * - 险路尽头"说服同伴" → +1 加工品 + 全部行动力转希望；"召集同伴" → 取回留存券招募
   * - 险路小径"接受提议" → +1 珍贵加工品（行动力保留至出口选项）
   * - 得偿所愿 → 搬桶得随机收藏品；撬桶耗 4 金换更高稀有度陈列（官方刷新一次）
   * - 失与得 → 藏品/零件交换；复原"文明"（怦然信标）耗 2 随机自然物 → 焚毁文明
   * - 安全的角落/先行一步 → 官方 displayData 发放 + 场景图推进（子幕默认"离开"收尾）
   * @param choice 选项 id
   * @returns 已处理返回 true；选项不在表内返回 false（交回通用路径）
   */
  async resolveNodeChoice(choice: string): Promise<boolean> {
    const player = this._player;
    const choiceConfig = this.detail.choices?.[choice];
    if (!choiceConfig || !this.data) return false;

    // 区域出口：险路尽头"进入下一区域"/险路小径"保留行动力进入下一区域"
    if (choiceConfig.type === "ZONE_END") {
      await this.advanceZone();
      return true;
    }

    // 险路尽头：说服同伴 → +1 加工品，消耗全部行动力转化为等量希望
    if (choice === "choice_ro6_final1_1" || choice === "choice_ro6_final1_5") {
      player.gainRandomScrap?.();
      this.apToHope();
      return this.continueTo(choiceConfig.nextSceneId || "scene_ro6_final1_3");
    }
    // 险路尽头：召集同伴 → 取回留存招募券并开启招募，随后回到黑池幕
    if (choice === "choice_ro6_final1_2") {
      player._status.pending.shift();
      await this.useStashedTicketForFinal();
      await this.emitScene("scene_ro6_final1_1");
      return true;
    }
    // 险路小径：接受提议 → +1 珍贵加工品（保留行动力，出口选项再进区）
    if (
      /^choice_ro6_evacuate[23]?_[13]$/.test(choice) &&
      choiceConfig.type === "TRADE"
    ) {
      player.gainPreciousScrap?.();
      return this.continueTo(choiceConfig.nextSceneId);
    }

    if (/^choice_ro6_wish_/.test(choice)) {
      return this.resolveWish(choice, choiceConfig);
    }
    if (/^choice_ro6_sacrifice\d_/.test(choice)) {
      return this.resolveSacrifice(choice, choiceConfig);
    }
    if (/^choice_ro6_scout_/.test(choice)) {
      return this.resolveScout(choice, choiceConfig);
    }

    // 其余（安全的角落等）：官方 displayData 发放 + 场景图推进（子幕默认仅"离开"）
    await this.applyGrants(choice, choiceConfig);
    return this.continueTo(choiceConfig.nextSceneId || null);
  }

  /** 得偿所愿（无人商店）：搬桶得收藏品（陈列幕决定稀有度档）；撬桶 4 金刷新陈列 */
  private async resolveWish(
    choice: string,
    choiceConfig: RoguelikeGameChoiceData,
  ): Promise<boolean> {
    const player = this._player;
    // 撬开木桶：消耗 4 源石锭，换一批更高级的收藏品陈列（官方仅可刷新一次）
    if (choice === "choice_ro6_wish_3" || choice === "choice_ro6_wish_8") {
      player._status.property.gold = Math.max(
        0,
        player._status.property.gold - 4,
      );
      return this.continueTo(choiceConfig.nextSceneId || "scene_ro6_wish_2");
    }
    // 搬桶取得收藏品：稀有度档按当前陈列幕（撬桶后逐级提升）
    const sceneId = player._status.pending[0]?.content?.scene?.id || "";
    const tier =
      sceneId === "scene_ro6_wish_3"
        ? 2
        : sceneId === "scene_ro6_wish_2"
          ? 1
          : 0;
    await this.grantWishRelic(tier);
    return this.continueTo(choiceConfig.nextSceneId || "scene_ro6_wish_1");
  }

  /**
   * 得偿所愿发放：按档抽未拥有收藏品。
   * 官方无对应 pool_* 代码，成员以路标档案馆观测池为准（data/rlv2/pools.json）：
   * 默认陈列 = node_wish_relic（78 件），撬桶后更高级陈列 = node_wish_relic_advanced（83 件）；
   * 池空时降档回退稀有度池/全量池，全空回退 8 金。
   */
  private async grantWishRelic(tier: number): Promise<void> {
    const player = this._player;
    const owned = Object.values(player.inventory?.relic || {}).map(
      (r) => r.id,
    );
    const pools =
      tier >= 1
        ? [
            "node_wish_relic_advanced",
            "pool_relic_super_rare",
            "pool_relic_rare",
            "pool_relic_all",
          ]
        : ["node_wish_relic", "pool_relic_all"];
    let id = "";
    for (const p of pools) {
      id = this.pickFromPool(p, owned);
      if (id) break;
    }
    if (id) {
      await player._trigger.emit("rlv2:relic:gain", [{ id, count: 1 }]);
    } else {
      await player._trigger.emit("rlv2:get:items", [
        [{ id: "rogue_6_gold", count: 8 }],
      ]);
    }
  }

  /**
   * 从指定池抽 1 件未拥有且当前主题 relics 表登记的藏品（不放回）。
   * 与 pool.getRelic 同语义，额外校验 relics 登记（结算依赖 buffs 数据）。
   */
  private pickFromPool(poolId: string, owned: string[]): string {
    const player = this._player;
    const pool = player._pool?._pools?.[poolId] || [];
    const avail = pool.filter(
      (id) => !owned.includes(id) && !!this.detail.relics?.[id],
    );
    if (avail.length === 0) return "";
    const id = avail[Math.floor(random() * avail.length)];
    pool.splice(pool.indexOf(id), 1);
    return id;
  }

  /** 失与得（回滚文明）：藏品/零件交换与复原"文明"（三结局削弱） */
  private async resolveSacrifice(
    choice: string,
    choiceConfig: RoguelikeGameChoiceData,
  ): Promise<boolean> {
    const player = this._player;
    const variant = choice.startsWith("choice_ro6_sacrifice2") ? 2 : 1;
    // 复原"文明"：消耗随机 2 件自然物（仅持怦然信标时出现，门槛在入口选项过滤）
    if (choice === "choice_ro6_sacrifice2_20") {
      this.loseScrapByType("GOODS", 2);
      return this.continueTo(choiceConfig.nextSceneId || "scene_ro6_sacrifice2_20");
    }
    // 等待结果：获得焚毁"文明"（官方 displayData 发放）
    if (choice === "choice_ro6_sacrifice2_21") {
      await this.applyGrants(choice, choiceConfig);
      return this.continueTo(choiceConfig.nextSceneId || "scene_ro6_sacrifice2_21");
    }
    // 拿出工具（零件交换）：消耗 1 件随机零件 → 获得 1 件随机零件（可继续交换）。
    // 精确后缀匹配：_11/_14 为零件选项，须先于藏品分支判定（_11 尾部含 1）
    if (choiceConfig.type === "SACRIFICE" && /_(11|14)$/.test(choice)) {
      this.sacrificeScrap();
      return this.continueTo(`scene_ro6_sacrifice${variant}_13`);
    }
    // 拿出珍藏（藏品交换）：献祭 1 件 canSacrifice 藏品 → 随机新藏品（可继续交换）
    if (choiceConfig.type === "SACRIFICE" && /_(1|6)$/.test(choice)) {
      await this.sacrificeRelic();
      return this.continueTo(`scene_ro6_sacrifice${variant}_1`);
    }
    // 离开/到此为止等：按场景图推进（官方无额外效果）
    await this.applyGrants(choice, choiceConfig);
    return this.continueTo(choiceConfig.nextSceneId || null);
  }

  /**
   * 献祭 1 件可献祭藏品（canSacrifice 且 value 8/12），回报随机未拥有藏品。
   * 官方规则"交换后可获得的物品受给出的物品稀有度影响"（路标档案馆同稀有度交换观测）：
   * 回报优先同稀有度档，档内池空时降档。
   */
  private async sacrificeRelic(): Promise<void> {
    const player = this._player;
    const relicMap = player.inventory?.relic || {};
    const sacrificable = Object.values(relicMap).filter((r) => {
      const item = this.detail.items?.[r.id];
      return item?.canSacrifice && (item?.value === 8 || item?.value === 12);
    });
    if (sacrificable.length === 0) return;
    const offered =
      sacrificable[Math.floor(random() * sacrificable.length)];
    delete relicMap[offered.index];
    const offeredRarity = this.detail.items?.[offered.id]?.rarity;
    const owned = Object.values(relicMap).map((r) => r.id);
    const tierPool =
      offeredRarity === "SUPER_RARE"
        ? "pool_relic_super_rare"
        : offeredRarity === "RARE"
          ? "pool_relic_rare"
          : "pool_relic_normal";
    const reward =
      this.pickFromPool(tierPool, owned) ||
      this.pickFromPool("pool_relic_all", owned);
    if (reward) {
      await player._trigger.emit("rlv2:relic:gain", [
        { id: reward, count: 1 },
      ]);
    }
  }

  /**
   * 零件交换：消耗 1 件随机零件，获得 1 件随机零件。
   * 路标档案馆观测：零件交换在同稀有度内进行（N→N / R→R / SR→SR）。
   */
  private sacrificeScrap(): void {
    const player = this._player;
    const scrap = this.scrap;
    let consumedId = "";
    if (scrap) {
      const list = Object.values(scrap.inventory || {});
      if (list.length > 0) {
        const it = list[Math.floor(random() * list.length)];
        consumedId = it.id;
        delete scrap.inventory[it.instId];
        if (scrap.activeVehicle?.instId === it.instId) {
          scrap.activeVehicle = { isWalk: true };
        }
      }
    }
    // 同稀有度回报：按消耗件的 rarity 筛零件池；无匹配/无消耗时回退任意随机零件
    const rarity = consumedId ? this.detail.items?.[consumedId]?.rarity : "";
    const scrapTypeMap = excel.RoguelikeTopicTable.modules["rogue_6"]?.scrap
      ?.scrapItemToType;
    const sameRarity = Object.keys(scrapTypeMap ?? {}).filter(
      (id) => (this.detail.items?.[id]?.rarity ?? "") === rarity,
    );
    if (sameRarity.length > 0) {
      const id = sameRarity[Math.floor(random() * sameRarity.length)];
      player._trigger.emit("rlv2:scrap:gain", [id]);
    } else {
      player.gainRandomScrap?.();
    }
  }

  /** 先行一步：远征选项标记（三结局）与休息选项发放，随后按场景图推进 */
  private async resolveScout(
    choice: string,
    choiceConfig: RoguelikeGameChoiceData,
  ): Promise<boolean> {
    const player = this._player;
    // 派同伴进入/探索：标记三结局远征（归来时 +2 希望 + 怦然信标，checkZoneEnd 结算）
    if (choice === "choice_ro6_scout_1" || choice === "choice_ro6_scout_3") {
      const expDetails = player.troop?.expeditionDetails as
        | ExpeditionDetailsView
        | undefined;
      if (expDetails) {
        expDetails.ending = true;
      }
    }
    // 休息（+2 希望）等：官方 displayData 发放
    await this.applyGrants(choice, choiceConfig);
    return this.continueTo(choiceConfig.nextSceneId || null);
  }

  /** 场景推进：有下一幕则打开（选项经门槛过滤），否则节点结束 */
  private async continueTo(nextSceneId: string | null): Promise<boolean> {
    const player = this._player;
    if (nextSceneId) {
      await this.openScene(nextSceneId);
      return true;
    }
    player._status.pending.shift();
    player._status.state = "WAIT_MOVE";
    return true;
  }

  /** 行动力全部转化为等量希望（险路尽头"说服同伴"） */
  private apToHope(): void {
    const player = this._player;
    const gz = this.gridZone;
    const ap = gz?.stepRemain || 0;
    if (ap > 0 && gz) {
      player._status.property.population.max += ap;
      gz.stepRemain = 0;
    }
  }

  /**
   * 区域出口推进：标记当前节点为终点并走 checkZoneEnd（结局判定/区域奖励/
   * 远征归来/新层生成）。险路小径为中途捷径节点（无官方 zone_end 标记），需手动补标。
   */
  private async advanceZone(): Promise<void> {
    const player = this._player;
    const pos = player._status.cursor.position;
    if (pos) {
      const node =
        player._map.zones[this.zoneKeyOf(player._status.cursor.zone)]?.nodes?.[
          pos.x * 100 + pos.y
        ];
      if (node) node.zone_end = true;
    }
    player._status.pending.shift();
    await player.checkZoneEnd();
    player._status.state = "WAIT_MOVE";
  }

  /** 险路尽头"召集同伴"：取回首张留存招募券并开启招募（无留存则跳过） */
  private async useStashedTicketForFinal(): Promise<void> {
    const player = this._player;
    const inv = player.inventory;
    if (!inv?.recruit) return;
    const stashed = Object.values(inv.recruit).filter((t) => t.state === 3);
    if (stashed.length === 0) return;
    const t = stashed[0];
    t.state = 0;
    if (Array.isArray(inv.stashRecruit)) {
      inv.stashRecruit = inv.stashRecruit.filter(
        (s) => !s.includes(t.id) && s !== t.index,
      );
    }
    await player._trigger.emit("rlv2:recruit:active", [t.index]);
    await player._trigger.emit("rlv2:event:create", [
      "RECRUIT",
      { tickets: t.index },
    ]);
  }
}
