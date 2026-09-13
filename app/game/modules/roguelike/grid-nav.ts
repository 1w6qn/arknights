/**
 * 集成战略（rlv2）分区逻辑：网格地图移动与场景（节点移动/开门/传送/命运/混沌源/碎片事件）
 *
 * 由 RoguelikeV2Manager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { RoguelikeV2Manager, RoguelikeCustomizeDataView } from "./logic";
import {
  PlayerRoguelikeV2,
  RoguelikeItemBundle,
  RoguelikeNodePosition,
  TorappuRoguelikeEventType,
} from "./rlv2";
import excel from "@excel/excel";
import { PlayerSquad } from "../../kernel/model";
import { ROGUE6_NODE } from "./modules/grid_zone";
import {
  ROGUE6_BATTLE_NODES,
  ROGUE6_SHOP_NODES,
  ROGUE6_NODE_SCENE_PREFIX,
  ROGUE6_END2_BOSS_STAGE,
  ROGUE6_END2_RELICS,
  ROGUE6_END3_RELIC,
  ROGUE6_BEAK_OUTBUFF,
  ROGUE6_NON_PORTABLE_SCRAPS,
  ROLL_NODE_TYPE_VALUES,
  isBlackstream,
} from "./theme-rules";
import { random } from "@utils/random";

  /** 重掷节点（CS: RoguelikeRollNodeRequest { nodeIndex }）：消耗次数并按 rollNodeData 重生成节点 */
export async function rerollNode(mgr: RoguelikeV2Manager, args: { nodeIndex: string }) : Promise<void> {
    const { nodeIndex } = args;
    const zone = mgr._status.cursor.zone;
    // 键兼容：标准主题为层号，黑流树海为区域索引（1000+）/隐藏层（3000+）——
    // 原实现直写 zones[zone]，rogue_6 恒取不到节点 → 重掷静默失效
    const mapZone = mgr._map.zones[mgr.zoneKey(zone)];
    const node = mapZone?.nodes[nodeIndex];
    if (!node) return;
    const refresh = node.refresh;
    if (refresh && refresh.usedCount >= refresh.count) return;
    if (refresh) refresh.usedCount += 1;
    // 官方 rollNodeData 按 zoneId 分组（rogue_6 为隐藏层 zone_portal_normal_5_*）
    const theme = mgr.current.game!.theme;
    const detail = excel.RoguelikeTopicTable.details[theme];
    const rollNodeData = detail?.rollNodeData;
    const zoneId = mapZone.id;
    const group = rollNodeData?.[zoneId]?.groups;
    const stageKeys = Object.keys(detail?.stages || {});
    const roNum = theme.slice(-1);
    if (group) {
      const types = Object.values(group) as { nodeType: string }[];
      const pick = types[Math.floor(random() * types.length)];
      // 节点类型名 → 数值统一走 theme-rules 表（原 typeMap 缺 rogue_6 的
      // 命运所指/狭路相逢/秘境行商等 11 类 → 一律退化为普通作战）
      node.type = ROLL_NODE_TYPE_VALUES[pick.nodeType] ?? ROGUE6_NODE.BATTLE_NORMAL;
    } else {
      node.type = ROGUE6_NODE.BATTLE_NORMAL;
    }
    // 战斗类节点补关卡（非战斗类不需要 stage）
    if (ROGUE6_BATTLE_NODES.includes(node.type)) {
      const candidates = stageKeys.filter((s) =>
        s.startsWith(`ro${roNum}_n_${zone}_`),
      );
      if (candidates.length > 0) {
        node.stage = candidates[Math.floor(random() * candidates.length)];
      }
    }
}

  /** 升级节点（CS: RoguelikeUpgradeNodeRequest { nodeType }）：接线 nodeUpgrade 模块 */
export async function upgradeNode(mgr: RoguelikeV2Manager, args: { nodeType: string }) : Promise<void> {
    await mgr._trigger.emit("rlv2:node:upgrade", [args.nodeType]);
}

  /** 网格区域移动（抓包 { route: [nodeIndex] }）：沿 route 路径逐节点移动并消耗行动力 */
export async function gridZoneMoveTo(mgr: RoguelikeV2Manager, args: { route: string[] }) : Promise<void> {
    let route = args.route || [];
    if (route.length === 0) return;
    // 清空上一请求的残留推送（控制器为持久实例，与标准 moveTo 一致）
    mgr._pushMessages = [];
    const gz = mgr._module.gridZone;
    const zone = mgr._status.cursor.zone;
    const gzZoneKey = `zone_${zone}`;
    // 阻碍徒步：流窜居民被占领的节点无法徒步越过——若路径中途含被占领节点，将路径截断
    // 到第一个被占领节点（玩家被迫停在被占领节点，进入驱逐战）。
    const barricadeIdx = route.findIndex(
      (nid, i) => i < route.length - 1 && !!gz?.banditAt(gzZoneKey, nid),
    );
    if (barricadeIdx !== -1) {
      route = route.slice(0, barricadeIdx + 1);
    }
    // 界定本次移动请求的变化节点收集范围（rlv2NodeChange.nodeList 只下发发生变化的节点）
    gz?.beginMove();
    // 路径中每个节点消耗一步（含末节点）
    for (const _nodeId of route) {
      mgr._trigger.emit("rlv2:grid:step", []);
    }
    // 沿路径标记各节点已访问
    const last = route[route.length - 1];
    for (const nodeId of route) {
      gz?.moveTo([nodeId]);
    }
    const node = gz?.moveTo([last]);
    // _map.zones 键为字符串（zoneKey 可能回退返回层号 number）
    const mapZoneKey = String(mgr.zoneKey(zone));
    let lastX = Math.floor(Number(last) / 100);
    let lastY = Number(last) % 100;
    // 曲折密道传送（服务端记录成对 + 送声）：抵达密道节点且存在配对密道时，玩家位置
    // 直接位移到另一密道坐标；官服"行动力只在进入时被消耗、可重复进入、立即揭示"。
    // 密道为通路节点（无 scene），落位到配对处继续走。服务端只改位置，动画由客户端
    // （RL06DoorAnimDialog）表现。
    const tunnelTarget = gz?.tunnelPairTarget(gzZoneKey, last);
    if (tunnelTarget) {
      lastX = Math.floor(Number(tunnelTarget) / 100);
      lastY = Number(tunnelTarget) % 100;
      mgr.pushMessage("rlv2NodeTeleport", { nodeId: tunnelTarget });
    }
    // 被经过的节点衰减为林间空地：玩家移走的上一个位置 + 路径中途节点（不含末节点，
    // 消费者为玩家当前所在，保留事件；商店/林间空地/尽头/小径/密道等可反复进入类保留）。
    const passed = new Set<string>(route.slice(0, -1));
    const prev = mgr._status.cursor.position;
    if (prev) passed.add(String(prev.x * 100 + prev.y));
    passed.delete(last); // 玩家当前所在不衰减
    for (const pid of passed) {
      gz?.decayPassed(mapZoneKey, gzZoneKey, pid);
    }
    mgr._status.trace.push({ zone, position: { x: lastX, y: lastY } });
    mgr._status.cursor.position = { x: lastX, y: lastY };
    // 节点类型/关卡判定来源（gridZone vs map.zones 双轨）：
    // - 会话内（未落盘）：gridZone 节点 content.kind/savage 是最新语义的权威来源
    //   （含手动变更/事件改写，与 map.zones 可能不同步）。
    // - 重登"继续探索"恢复后：gridZone.toJSON 为客户端线格式精简会剥除 savage/kind，
    //   content 丢失战斗/特殊节点判定 → 必须回退到完整持久化的 map.zones（type/stage
    //   完整保留），否则续局移动进作战节点既不触发战斗、也不下发 rlv2NodeArrive
    //   （kind 恒 undefined）→ 客户端卡死（2026-08-20 复现）。
    const mapNode = mgr._map.zones[mgr.zoneKey(zone)]?.nodes?.[last];
    const kind =
      typeof node?.content?.kind === "number"
        ? node.content.kind
        : typeof mapNode?.type === "number"
          ? mapNode.type
          : undefined;
    // 战斗判定与节点类型绑定，避免误开战：
    // - 会话内 content.kind 存在时以 content.savage 为准（含被改写成非战斗节点，如林间
    //   空地/羽瞰点，map.zones 里可能残留生成期灌入的 stage——不能据此误判战斗）。
    // - 仅当 content.kind 缺失（重登"继续探索"恢复后被剥除）才回退 map.zones 的 stage，
    //   保证续局移动进作战节点仍能触发战斗。
    const battleStage =
      node?.content?.savage?.stageId ||
      (node?.content?.kind === undefined ? mapNode?.stage : undefined);
    // 节点到达推送（官服对齐）：rlv2NodeArrive 携节点类型、rlv2NodeChange 携本次发生
    // 状态/视野变化的节点列表（官服抓包 R-1786531228496.9993-3674：nodeList=["202","200"]
    // 为到达节点+新揭示邻居，非整层全量）。
    // 原实现只在标准 moveTo 中累积，而黑流树海走本方法 → 推送永不下发。
    // 流窜居民移动：每次玩家移动后，各流窜居民沿连通路径移动 1 格。若末节点本就是
    // 被流窜占领节点（本次为驱逐战，战斗胜利后由 finishClearing 驱逐），则不步进该节点。
    if (!gz?.banditAt(gzZoneKey, last)) {
      gz?.stepBandits(gzZoneKey);
    }
    const changedMoveNodes = gz?.takeChangedNodes() ?? [];
    if (typeof kind === "number") {
      mgr.pushMessage("rlv2NodeArrive", { nodeType: kind });
      mgr.pushMessage("rlv2NodeChange", { nodeList: changedMoveNodes });
      // 特勤干员任务：黑流树海节点通过 + "居民"恶意节点（Rlv2PassNodeSpec / Rlv2MeetBandit）
      const gzGame = mgr.current.game!;
      const gzCtx = {
        theme: gzGame.theme,
        mode: gzGame.mode,
        grade: gzGame.modeGrade ?? 0,
      };
      await mgr._trigger.emit("Rlv2PassNodeSpec", [
        { ...gzCtx, nodeType: kind },
      ]);
      if (kind === ROGUE6_NODE.RESIDENT) {
        await mgr._trigger.emit("Rlv2MeetBandit", [gzCtx]);
      }
    }
    // 特勤干员任务：累计消耗行动力（Rlv2MoveCostAp，路径每节点 1 步）
    if (route.length > 0) {
      const apGame = mgr.current.game!;
      await mgr._trigger.emit("Rlv2MoveCostAp", [
        {
          theme: apGame.theme,
          mode: apGame.mode,
          grade: apGame.modeGrade ?? 0,
          cost: route.length,
        },
      ]);
    }
    // 自然物（GOODS）估价动态：移动后 → G_05 随机 -6~+8、G_10 -2；本次移动揭示节点 →
    // G_03 每次揭示 +1（按本次变化节点数计）。
    const goodsScrap = mgr._module.scrap;
    goodsScrap?.applyGoodsEffect("move");
    if (changedMoveNodes.length > 0) {
      goodsScrap?.applyGoodsEffect("node_reveal", changedMoveNodes.length);
    }
    if (battleStage) {
      // 战斗节点（作战/紧急作战/险路恶敌/“居民”据点）→ 战斗
      // 记录驱逐战目标（被流窜占领节点 / "居民"据点）：战斗胜利由 battleFinish →
      // grid_zone.finishClearing 驱逐（被占节点毁为林间空地 / 居民据点驱逐全层流窜）。
      gz?.startClearing(gzZoneKey, last);
      mgr._status.state = "PENDING";
      await mgr._trigger.emit("rlv2:battle:start", [battleStage]);
      return;
    }
    // 商店节点判定：会话内以 content.shop 为准；续局恢复后 content 被精简剥除
    // （kind/shop 可能丢失）时回退 map.zones 节点类型判定（与战斗判定同模式）——
    // 否则续局后抵达商店节点不开商店（诡意行商/秘境行商/应急助力全部失效）。
    const isShopNode =
      !!node?.content?.shop ||
      (typeof kind === "number" && ROGUE6_SHOP_NODES.includes(kind));
    if (isShopNode) {
      // 进入行商节点：重置卖零件计数（多边贸易"同一个行商节点"语义）
      mgr._shopSellCount = 0;
      // 多边贸易升级（band_20）：每次进入行商节点获得 1 个<枯苔藓球>
      if (
        isBlackstream(mgr.current.game!.theme) &&
        mgr.hasRelic("rogue_6_band_20")
      ) {
        mgr._trigger.emit("rlv2:scrap:gain", ["rogue_6_scrap_G_08"]);
      }
      mgr._status.state = "PENDING";
      mgr._trigger.emit("rlv2:event:create", [
        "BATTLE_SHOP",
        mgr.buildShopContent(mgr.current.game!.theme),
      ]);
      return;
    }
    // 误入奇境（MIRAGE）：进入黑潭场景（消耗加工品 → 隐藏层 未萌生的摇篮）
    if (kind === ROGUE6_NODE.MIRAGE) {
      mgr.createPortalScene();
      return;
    }
    // 命运所指（PROPHECY，V 层二结局 / VI 层调谐仪式入口）：好奇心与死 / 窥视箱中
    if (kind === ROGUE6_NODE.PROPHECY || kind === ROGUE6_NODE.PROPHECY_HIDDEN) {
      mgr.createFateScene();
      return;
    }
    // 不期而遇（INCIDENT）：优先二结局线人事件，否则交回事件引擎完整事件池
    if (kind === ROGUE6_NODE.INCIDENT && (await mgr.createIncidentScene())) {
      return;
    }
    // 非战斗事件节点（安全的角落/得偿所愿/失与得/险路尽头/险路小径）：
    // 事件引擎按 nodeEnters 表下发完整效果（随机 3 选项/出口进区等）；
    // 无配置时回退下方前缀场景分发。
    if (typeof kind === "number" && (await mgr._incident.createNodeScene(kind))) {
      return;
    }
    // 其余事件节点（安全的角落/得偿所愿/失与得/先行一步/狭路相逢/应急助力/险路小径/险路尽头）：
    // 按节点类型从官方 choiceScenes 抽 enter 场景生成 SCENE 事件。
    // 原实现缺此分发（triggerNodeEvent 零调用）→ 这些节点全部退化为空节点，
    // 三结局入口（先行一步 → scene_ro6_scout_enter）也因此不可达。
    if (typeof kind === "number" && mgr.createRogue6NodeScene(kind)) {
      return;
    }
    // 空节点（林间空地/曲折密道/羽瞰点）：网格区域自由移动，回到 WAIT_MOVE（客户端继续走）
    mgr._status.state = "WAIT_MOVE";
}

  /**
   * 生成黑流树海节点事件场景（SCENE）。
   * 按节点类型取官方 enter 场景前缀（ROGUE6_NODE_SCENE_PREFIX），随机抽一幕，
   * 选项取该幕同前缀的 choices（如 scene_ro6_rest_enter → choice_ro6_rest_1..6）。
   * @param nodeType 节点类型数值（ROGUE6_NODE）
   * @returns 已生成场景返回 true；该类型无场景映射或数据缺失返回 false
   */
export function createRogue6NodeScene(mgr: RoguelikeV2Manager, nodeType: number) : boolean {
    const theme = mgr.current.game!.theme;
    const prefixes = ROGUE6_NODE_SCENE_PREFIX[nodeType];
    if (!prefixes || prefixes.length === 0) return false;
    const detail = excel.RoguelikeTopicTable.details[theme];
    // enter 场景：scene_ro6_{prefix}{N}_enter（N 可空，如 scene_ro6_rest_enter）
    const sceneIds = Object.keys(detail?.choiceScenes || {}).filter((id) =>
      prefixes.some((p) => new RegExp(`^scene_ro\\d+_${p}\\d*_enter$`).test(id)),
    );
    if (sceneIds.length === 0) return false;
    const sceneId = sceneIds[Math.floor(random() * sceneIds.length)];
    // 该幕的选项：与场景同名前缀（scene_ro6_bat1_enter → choice_ro6_bat1_*）
    const stem = sceneId.replace(/^scene_/, "").replace(/_enter$/, "");
    const choiceIds = Object.keys(detail?.choices || {}).filter((k) =>
      k.startsWith(`choice_${stem}_`),
    );
    if (choiceIds.length === 0) return false;
    mgr._status.state = "PENDING";
    mgr._trigger.emit("rlv2:event:create", [
      "SCENE",
      {
        scene: {
          id: sceneId,
          choices: choiceIds.reduce((acc, cid) => ({ ...acc, [cid]: 1 }), {}),
          choiceAdditional: choiceIds.reduce(
            (acc, cid) => ({ ...acc, [cid]: { rewards: [] } }),
            {},
          ),
        },
        done: false,
        popReport: false,
      },
    ]);
    return true;
}

  /**
   * 误入奇境（MIRAGE 节点）入口场景：随机选一个雾色场景族（scene_ro6_portalX*_enter），
   * 选项为该族全部 choice（_1.._3 消耗 1 件加工品进入 / _4 直接进入 / _5 无加工品 / _6 离开）。
   * 选项效果由 selectChoice 的 portal 分支处理（进入隐藏层或结束节点）。
   */
export function createPortalScene(mgr: RoguelikeV2Manager) : void {
    const theme = mgr.current.game!.theme;
    const detail = excel.RoguelikeTopicTable.details[theme];
    const sceneIds = Object.keys(detail?.choiceScenes || {}).filter(
      (id) => id.startsWith(`scene_ro6_portal`) && id.endsWith("_enter"),
    );
    if (sceneIds.length === 0) {
      mgr._status.state = "WAIT_MOVE";
      return;
    }
    const sceneId = sceneIds[Math.floor(random() * sceneIds.length)];
    // 场景族：scene_ro6_portal1a_enter → "1a"
    const family =
      sceneId.match(/scene_ro\d+_portal(\d+[ab]?)_enter/)?.[1] ?? "1a";
    const prefix = `choice_ro6_portal${family}`;
    const choiceIds = Object.keys(detail.choices || {}).filter((k) =>
      k.startsWith(prefix),
    );
    if (choiceIds.length === 0) {
      mgr._status.state = "WAIT_MOVE";
      return;
    }
    const choices = choiceIds.reduce(
      (acc, cid) => ({ ...acc, [cid]: 1 }),
      {},
    );
    const choiceAdditional = choiceIds.reduce(
      (acc, cid) => ({ ...acc, [cid]: { rewards: [] } }),
      {},
    );
    mgr._status.state = "PENDING";
    mgr._trigger.emit("rlv2:event:create", [
      "SCENE",
      {
        scene: { id: sceneId, choices, choiceAdditional },
        done: false,
        popReport: false,
      },
    ]);
}

  /**
   * 进入误入奇境隐藏层（未萌生的摇篮）：记录返回点，生成 portal zone（乌托邦模板 + 本层专用行动力）。
   * @param family 雾色场景族数字（1..9，字母变体已剥离）
   */
export function enterPortalZone(mgr: RoguelikeV2Manager, family: string) : void {
    const gz = mgr._module.gridZone;
    if (!gz) {
      mgr._status.state = "WAIT_MOVE";
      return;
    }
    const pos = mgr._status.cursor.position;
    const returnNode = pos ? String(pos.x * 100 + pos.y) : "0";
    const returnZone = mgr._status.cursor.zone;
    mgr._status.pending.shift();
    gz.generatePortal(family, returnZone, returnNode);
    mgr._status.state = "PENDING";
}

  /**
   * 消耗 1 件加工品（零件箱 MOVE 型废品）进入黑潭；无可用加工品返回 false。
   * 官方 scrapTypeData：MOVE = "加工品"（可用于地图移动），GOODS = "自然物"，
   * PASSIVE = "概念体"——误入奇境选项文本"消耗零件箱里的 1件 加工品"即 MOVE 型。
   * 扣估价（sellPrice）最低者。
   */
export function consumePortalScrap(mgr: RoguelikeV2Manager) : boolean {
    const scrap = mgr._module.scrap;
    if (!scrap) return false;
    const theme = mgr.current.game!.theme;
    const typeMap = excel.RoguelikeTopicTable.modules[theme]?.scrap;
    const candidates = Object.values(scrap.inventory || {}).filter((it) => {
      return typeMap?.scrapItemToType?.[it.id] === "MOVE";
    });
    if (candidates.length === 0) return false;
    // 优先扣估价最低的加工品
    candidates.sort((a, b) => a.value - b.value);
    const consumed = candidates[0];
    delete scrap.inventory[consumed.instId];
    // 扣掉的若是当前载具，切回步行（否则 activeVehicle 指向已删除的 instId）
    if (scrap.activeVehicle?.instId === consumed.instId) {
      scrap.activeVehicle = { isWalk: true };
    }
    return true;
}

  /**
   * 二结局·维度重构：与"窥视箱中"的首领决战 → 混沌源阶理论（ro6_b_5，险路恶敌）。
   * 将当前节点标记为混沌源阶理论并创建 BATTLE 事件（客户端随后 moveAndBattleStart）。
   */
export function startChaosSourceBattle(mgr: RoguelikeV2Manager) : void {
    const stageId = ROGUE6_END2_BOSS_STAGE; // 混沌源阶理论（stages 表实锤 ro6_b_5）
    // 当前节点标记为混沌源阶理论（客户端地图显示险路恶敌）
    const pos = mgr._status.cursor.position;
    if (pos) {
      const node = mgr._map.zones[mgr.zoneKey(mgr._status.cursor.zone)]?.nodes[
        pos.x * 100 + pos.y
      ];
      if (node) {
        node.stage = stageId;
        node.type = TorappuRoguelikeEventType.BATTLE_BOSS;
        node.zone_end = true; // 首领战可推进结算
      }
    }
    mgr._status.pending.shift();
    mgr._trigger.emit("rlv2:event:create", [
      "BATTLE",
      {
        state: 1,
        chestCnt: 100,
        goldTrapCnt: 100,
        diceRoll: [],
        boxInfo: {},
        tmpChar: [],
        sanity: 0,
        // 修复（2026-09-11）：首领战原固定空数组 → 丢失藏品/难度增益
        // （对齐 ODPY gridZone/moveAndBattleStart 的 unKeepBuff = getBuffs）。
        unKeepBuff: mgr._buff.getBuffs(),
      },
    ]);
    mgr._status.state = "PENDING";
}

  /** 线人事件：获得 1 件珍贵的加工品（零件池随机 1 件入零件箱） */
export function gainPreciousScrap(mgr: RoguelikeV2Manager) : void {
    mgr.gainRandomScrap();
}

  /**
   * 获得 1 件随机加工品（零件池随机 1 件入零件箱）。
   * 「先行一步 归来」与线人事件共用；零件源 = 官方 modules[theme].scrap.scrapItemToType 键。
   */
export function gainRandomScrap(mgr: RoguelikeV2Manager) : void {
    const theme = mgr.current.game!.theme;
    const pool = Object.keys(
      excel.RoguelikeTopicTable.modules[theme]?.scrap?.scrapItemToType || {},
    );
    if (pool.length === 0) return;
    const id = pool[Math.floor(random() * pool.length)];
    mgr._trigger.emit("rlv2:scrap:gain", [id]);
}

  /**
   * 【生命游戏】"喙"节点是否已点亮（"先行一步"归来时额外获得随机加工品）。
   * 判定依据：科技树节点（customizeData.commonDevelopment.developments[rogue_6_outbuff_33]）
   * 已捕获（outer.buff.unlocked）且其 RAW_TEXT_EFFECT 的 rawDesc 存在并描述"加工品"。
   * 与"翅膀"（rogue_6_outbuff_37）同模式，但显式校验 rawDesc 指向"归来带加工品"。
   * @returns 已点亮返回 true
   */
export function isBeakUnlocked(mgr: RoguelikeV2Manager) : boolean {
    const theme = (mgr.current.game?.theme as string) || "";
    if (!isBlackstream(theme)) return false;
    const outer = mgr.outer?.[theme];
    if (!outer?.buff?.unlocked?.[ROGUE6_BEAK_OUTBUFF]) return false;
    const customize = excel.RoguelikeTopicTable.customizeData?.[theme] as
      | RoguelikeCustomizeDataView
      | undefined;
    const dev =
      customize?.commonDevelopment?.developments?.[ROGUE6_BEAK_OUTBUFF];
    const rawDesc = Array.isArray(dev?.rawDesc) ? dev.rawDesc.join("") : "";
    // rawDesc 描述"归来时……随机加工品"，据此确认该节点为"先行一步归来带加工品"
    return rawDesc.includes("加工品") && rawDesc.includes("归来");
}

  /**
   * 命运所指（PROPHECY 节点）入口场景：持有双沙盘 → 窥视箱中（end2，谜题与谜底）；
   * 否则随机 1/3 概率窥视箱中、2/3 好奇心与死（V 层 3 个命运所指中 1 个为窥视箱中）。
   */
export function createFateScene(mgr: RoguelikeV2Manager) : void {
    const theme = mgr.current.game!.theme;
    if (!isBlackstream(theme)) {
      mgr._status.state = "WAIT_MOVE";
      return;
    }
    const hasBoth =
      mgr.hasRelic(ROGUE6_END2_RELICS.sandboxAlpha) &&
      mgr.hasRelic(ROGUE6_END2_RELICS.sandboxBeta);
    const isBox = hasBoth || random() < 1 / 3;
    const sceneId = isBox ? "scene_ro6_end2_enter" : "scene_ro6_end1_enter";
    const prefix = isBox ? "choice_ro6_end2_" : "choice_ro6_end1_";
    const detail = excel.RoguelikeTopicTable.details[theme];
    const choiceIds = Object.keys(detail.choices || {}).filter((k) =>
      k.startsWith(prefix),
    );
    if (choiceIds.length === 0) {
      mgr._status.state = "WAIT_MOVE";
      return;
    }
    const choices = choiceIds.reduce(
      (acc, cid) => ({ ...acc, [cid]: 1 }),
      {},
    );
    const choiceAdditional = choiceIds.reduce(
      (acc, cid) => ({ ...acc, [cid]: { rewards: [] } }),
      {},
    );
    mgr._status.state = "PENDING";
    mgr._trigger.emit("rlv2:event:create", [
      "SCENE",
      {
        scene: { id: sceneId, choices, choiceAdditional },
        done: false,
        popReport: false,
      },
    ]);
}

  /**
   * 二结局·线人事件（bomb1"线人与线索"）：不期而遇节点上的专属分支。
   * 仅 Ⅱ-Ⅳ 层、未持有沙盘α时按 40% 概率触发；不触发（或线人数据缺失）时交回
   * 不期而遇事件引擎（_incident）从完整事件池随机一幕。
   * @returns 已生成场景返回 true，数据缺失无法生成返回 false
   */
export async function createIncidentScene(mgr: RoguelikeV2Manager) : Promise<boolean> {
    const theme = mgr.current.game!.theme;
    // 线人（二结局前置）：Ⅱ-Ⅳ 层、未持有沙盘α时按 40% 概率优先触发；
    // 未命中则交回不期而遇事件引擎从完整事件池（res*/relic*/normal*/bat*/task*/
    // chimera*，含层数限制/重复规则/前置条件）随机一幕。
    if (!isBlackstream(theme) || mgr.hasRelic(ROGUE6_END2_RELICS.sandboxAlpha)) {
      return await mgr._incident.createIncident();
    }
    const zone = mgr._status.cursor.zone;
    // 线人仅 Ⅱ-Ⅳ 层出现；概率触发（40%）
    if (zone < 2 || zone > 4 || random() >= 0.4) {
      return await mgr._incident.createIncident();
    }
    const detail = excel.RoguelikeTopicTable.details[theme];
    const choiceIds = Object.keys(detail.choices || {}).filter((k) =>
      k.startsWith("choice_ro6_bomb1_"),
    );
    if (choiceIds.length === 0) {
      return await mgr._incident.createIncident();
    }
    const choices = choiceIds.reduce(
      (acc, cid) => ({ ...acc, [cid]: 1 }),
      {},
    );
    const choiceAdditional = choiceIds.reduce(
      (acc, cid) => ({ ...acc, [cid]: { rewards: [] } }),
      {},
    );
    mgr._status.state = "PENDING";
    mgr._trigger.emit("rlv2:event:create", [
      "SCENE",
      {
        scene: { id: "scene_ro6_bomb1_enter", choices, choiceAdditional },
        done: false,
        popReport: false,
      },
    ]);
    return true;
}

  /**
   * 网格区域移动并开始战斗（抓包 { route, stageId, squad }）。
   * 复用 gridZoneMoveTo 的完整移动逻辑（beginMove/takeChangedNodes 变化节点、被经过节点
   * 衰减 decayPassed、流窜居民 stepBandits、驱逐战 startClearing、节点类型判定与推送、
   * 特勤干员任务/goodsScrap 效果等）——若此处走旧简化实现会与 gridZoneMoveTo 行为分叉：
   * 变化节点不收集（rlv2NodeChange 永不下发）、被经过节点不衰减为林间空地、流窜居民/
   * 驱逐战机制缺失，导致续局存档网格结构异常。战斗节点由 gridZoneMoveTo 内部触发
   * battle:start；续局等场景判定失败时用客户端 stageId 兜底开战。
   */
export async function gridZoneMoveAndBattleStart(mgr: RoguelikeV2Manager, args: {
    route: string[];
    stageId: string;
    squad: PlayerSquad;
  }) : Promise<void> {
    // 复用 gridZoneMoveTo 完整移动逻辑；战斗节点内部已触发 battle:start。
    // 仅当移动未进入任何节点事件（空节点/续局判定失败）时才按客户端 stageId 兜底开战，
    // 避免对商店/事件节点重复触发双事件。
    const pendingBefore = mgr._status.pending.length;
    await mgr.gridZoneMoveTo({ route: args.route });
    if (mgr._status.pending.length > pendingBefore) {
      return;
    }
    mgr._status.state = "PENDING";
    await mgr._trigger.emit("rlv2:battle:start", [args.stageId]);
}

  /** 网格区域空步：消耗一步行动力（不移动） */
export async function gridZoneEmptyStep(mgr: RoguelikeV2Manager) : Promise<void> {
    mgr._trigger.emit("rlv2:grid:step", []);
    // 特勤干员任务：空步同样消耗 1 行动力（Rlv2MoveCostAp）
    const game = mgr.current.game;
    if (game) {
      await mgr._trigger.emit("Rlv2MoveCostAp", [
        {
          theme: game.theme,
          mode: game.mode,
          grade: game.modeGrade ?? 0,
          cost: 1,
        },
      ]);
    }
    mgr._status.state = "WAIT_MOVE";
}

  /** 网格区域读取第 0 步：确认初始位置 */
export async function gridZoneReadStepZero(mgr: RoguelikeV2Manager) : Promise<void> {
    const gz = mgr._module.gridZone;
    if (gz) gz.needConfirmStepZero = false;
    mgr._status.state = "PENDING";
}
