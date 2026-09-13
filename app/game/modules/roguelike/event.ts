/**
 * 集成战略（rlv2）分区逻辑：节点事件（选择/事件完成/结局触发/特殊干员区域判定）
 *
 * 由 RoguelikeV2Manager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { RoguelikeV2Manager } from "./logic";
import excel from "@excel/excel";
import { logger } from "@utils/logger";
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
import { applyBandUpgradeVisibility, initModeGradeStates, maxClearedGrade, buildSettlement, exploreBreakdown, exploreScoreFactor, exploreScore, lifeGameNodes, blackstreamEfficiency, canEvolveOperators, blackstreamAwards, gameSettle, buildSettleResponse } from "./settle";
import { rerollNode, upgradeNode, gridZoneMoveTo, createRogue6NodeScene, createPortalScene, enterPortalZone, consumePortalScrap, startChaosSourceBattle, gainPreciousScrap, gainRandomScrap, isBeakUnlocked, createFateScene, createIncidentScene, gridZoneMoveAndBattleStart, gridZoneEmptyStep, gridZoneReadStepZero } from "./grid-nav";
import { _normalizeMutablePlayerdata, setPinned, giveUpGame, createGame, ensureOuterTheme, refreshMission, chooseInitialRelic, chooseInitialRecruitSet, chooseInitialExploreTool } from "./game-init";
import { random } from "@utils/random";
import type { PlayerRoguelikeV2 } from "./rlv2";
import type {
  RoguelikeChoiceEffectMap,
  RoguelikeChoiceEffectPayload,
} from "./logic";

/**
 * 先行一步远征明细视图
 *
 * 内部模型 Troop.expeditionDetails 声明为数值字典（`{ [key: string]: number }`），
 * 运行时另有 `ending` 布尔标记（先行一步归来结局，见 checkZoneEnd/selectChoice）。
 */
type ExpeditionDetails = { [key: string]: number | boolean };

/** 旧存档自定义字段视图（record.lastZone：到达层数兼容判定） */
type OuterRecordLegacy = { lastZone?: number };

/**
 * 事件选项效果载荷 → 数值字典
 *
 * 仅对象形态（非 null/非数组）可参与累加；标量/字符串数组/null 形态原实现同样无效果
 * （对象分支内按下标取字段取不到 → 不变），此处显式判空保持同一语义。
 * @param v - event_choices.json 的效果载荷
 * @returns 数值字典（非对象形态为 undefined）
 */
function asEffectMap(
  v: RoguelikeChoiceEffectPayload | undefined,
): RoguelikeChoiceEffectMap | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
}

export async function finishEvent(mgr: RoguelikeV2Manager) {
    if (mgr._status.cursor.zone === 0) {
      // 初始阶段：按官服语义消费事件——finishEvent 每次只推进一个"确认型"事件
      // （GIFT 发礼物 / RECRUIT 招募完成），其余留给客户端专用接口：
      // RELIC→chooseInitialRelic、SUPPORT→selectChoice、RECRUIT_SET→chooseInitialRecruitSet。
      // 8-11 官服抓包对照：finishEvent#1 消费 GIFT（pending 剩 SUPPORT/RECRUIT_SET/RECRUIT），
      // finishEvent#2 消费 RECRUIT 进入 WAIT_MOVE。原实现循环消费会把 SUPPORT 代选
      // （跳过客户端 selectChoice 步骤，且代选选项可能误改属性——hp 4→6 差异）。
      // 仅当 GIFT/RECRUIT 不存在时才兜底清空（防客户端异常跳步卡死）。
      const top = mgr._status.pending[0];
      if (top?.type === "GAME_INIT_GIFT") {
        const items = top.content.initGift?.items || [];
        if (items.length > 0) {
          await mgr._trigger.emit("rlv2:get:items", [items]);
        }
        mgr._status.pending.shift();
      } else if (top?.type === "GAME_INIT_RECRUIT") {
        mgr._status.pending.shift();
        // 清空初始招募残留的 RECRUIT 事件（放弃票/候选为空未招募场景——
        // 官服进入第一层 WAIT_MOVE 时 pending 为空，残留会导致客户端"系统发生未知故障"）
        mgr._status._pending._pending =
          mgr._status._pending._pending.filter((e) => e.type !== "RECRUIT");
      } else if (top && top.type.startsWith("GAME_INIT_")) {
        // 其余 GAME_INIT_*（SUPPORT/RECRUIT_SET）需专用接口，不消费
        mgr._status.state = "INIT";
        return;
      } else if (top?.type === "RECRUIT") {
        // 非初始 RECRUIT 事件（商店/战斗获得招募券后）：消费
        mgr._status.pending.shift();
      }
      const hasInit = mgr._status.pending.some((e) =>
        (e.type || "").startsWith("GAME_INIT_"),
      );
      if (hasInit) {
        mgr._status.state = "INIT";
        return;
      }
      // 兜底：清理初始招募残留票（官服进入第一层 WAIT_MOVE 时 inventory.recruit 基本为空）。
      // 仅移除未招募(state=0/1)/放弃(state=3)的票；保留已招募(state=2 且 result 非空)的票，
      // 使玩家在本局内仍能从 inventory.recruit 查看已招募干员（干员同时已在 troop）。
      // 全量清空会让已招募干员从本局 inventory.recruit 直接消失。
      for (const k of Object.keys(mgr.inventory!.recruit || {})) {
        const t = mgr.inventory!.recruit[k];
        if (t && t.state === 2 && t.result) continue;
        delete mgr.inventory!.recruit[k];
      }
      mgr._status.cursor.zone = 1;
      mgr._status.cursor.position = null;
      await mgr._trigger.emit("rlv2:zone:new", [mgr._status.cursor.zone]);
      // 特勤干员任务：到达区域事件（Rlv2PassZoneSpec）
      await mgr.emitSpecialOperatorZone(mgr._status.cursor.zone);
      // 进入第一层后 cursor.position = 起点节点位置（官服 finishEvent#2：
      // position={x:0,y:1} 即 type=268435456 起点；null 会导致客户端无法定位当前
      // 节点 → 地图渲染/步进崩溃）
      // 起点定位见 locateStartNode：起点是 gridZone 唯一 state=2 节点，不能按
      // map.zones 首个 GLADE 推断——林间空地同为填充节点类型（官方数量规则每层
      // 可铺 0..16 个，见 BLACKSTREAM_COUNT_RULES），首次命中可能是填充林间空地。
      const gz = mgr._module?.gridZone;
      const startPos = mgr.locateStartNode();
      if (startPos) {
        mgr._status.cursor.position = { x: startPos.x, y: startPos.y };
        // 进层后自动完成"起点走一步"（官服 finishEvent#2 对齐）：起点标已访问、
        // trace 追加起点、清 needConfirmStepZero（无需再要求玩家确认初始位置）。
        // 进层下发唯一 rlv2NodeChange（官服抓包 R-1786531228496.9993-3674：
        // nodeList 为起点列节点["202","200"]，排除起点；仅 nodeChange 不带 nodeArrive）。
        // 不做 moveTo 揭示——moveTo 会把周边 state0 节点改成 state1，而官服进层后
        // gridZone 节点 state 只取 0/2（平铺无中间态），故仅显式标起点 state=2。
        if (gz) {
          const startId = String(startPos.x * 100 + startPos.y);
          const z = gz.zones?.[gz.currentZoneKey()];
          const sn = z?.nodes?.[startId];
          if (sn && sn.state !== 2) sn.state = 2;
          gz.needConfirmStepZero = false;
          const colNodeIds = Object.keys(z?.nodes || {}).filter(
            (id) =>
              Math.floor(Number(id) / 100) === startPos.x && id !== startId,
          );
          if (colNodeIds.length > 0) {
            mgr.pushMessage("rlv2NodeChange", { nodeList: colNodeIds });
          }
        }
        mgr._status.trace.push({
          zone: mgr._status.cursor.zone,
          position: { x: startPos.x, y: startPos.y },
        });
      }
      mgr._status.state = "WAIT_MOVE";
      return;
    }
    // 非初始阶段：先检查本层终点（isZoneEnd 依赖当前 position），再清空位置
    mgr._status.pending.shift();
    const settling = await mgr.checkZoneEnd();
    mgr._status.cursor.position = null;
    if (settling) {
      // 最终层结算已触发（gameSettle 为异步，此处同步置 END 保证状态一致）
      mgr._status.state = "END";
      return;
    }
    mgr._status.state = "WAIT_MOVE";
}

export function hasReachedZone3(mgr: RoguelikeV2Manager, stageCnt?: Record<string, number>) : boolean {
    if (stageCnt) {
      for (const stageId of Object.keys(stageCnt)) {
        // 通过 2 层：ro6_[ne]_2_* / ro6_b_2* / ro6_c_2（通关记录）
        if (/^ro\d+_[ne]_2_/.test(stageId)) return true;
        if (/^ro\d+_(b|c)_2/.test(stageId)) return true;
        // 兼容：3 层通关记录（抓包样本形态，通过 3 层必已通过 2 层）
        if (/^ro\d+_[ne]_3_/.test(stageId)) return true;
        if (/^ro\d+_(b|c)_3/.test(stageId)) return true;
      }
    }
    // 兼容旧存档自定义字段（到达层数，>=3 即通过两层）
    const legacy = (
      mgr.outer?.[mgr.current.game?.theme || ""]?.record as
        | OuterRecordLegacy
        | undefined
    )?.lastZone;
    return typeof legacy === "number" && legacy >= 3;
}

export function locateStartNode(mgr: RoguelikeV2Manager) : { x: number; y: number } | undefined {
    const gz = mgr._module?.gridZone;
    if (gz) {
      const zoneKey = gz.currentZoneKey();
      // 起点 = state=2 且 kind=GLADE（官服 state 仅 0/2：初始点亮的险路尽头/密道/羽瞰点也为 2，
      // 填充林间空地为 state=0，故 "state=2 且 GLADE" 唯一标识起点；不能仅按 state=2 取首个）
      for (const [id, n] of Object.entries(gz.zones?.[zoneKey]?.nodes || {})) {
        if (n?.state === 2 && n?.content?.kind === ROGUE6_NODE.GLADE) {
          return { x: Math.floor(Number(id) / 100), y: Number(id) % 100 };
        }
      }
      // 兑底（旧存档/异常形态）：任一 state=2 节点
      for (const [id, n] of Object.entries(gz.zones?.[zoneKey]?.nodes || {})) {
        if (n?.state === 2) {
          return { x: Math.floor(Number(id) / 100), y: Number(id) % 100 };
        }
      }
    }
    const zoneNodes =
      mgr._map.zones[String(1000 + mgr._status.cursor.zone - 1)]?.nodes;
    const g = Object.values(zoneNodes || {}).find(
      (n) => n?.type === ROGUE6_NODE.GLADE,
    );
    return g?.pos ? { x: g.pos.x, y: g.pos.y } : undefined;
}

export function zoneKey(mgr: RoguelikeV2Manager, zone: number) : string | number {
    const zones = mgr._map.zones;
    // 误入奇境隐藏层（portal active）：地图为 portal zone（键 3000+）
    const gz = mgr._module?.gridZone;
    if (gz?.portal?.active && gz.portal.zoneKey) return gz.portal.zoneKey;
    if (zones[zone]) return zone;
    if (zones[String(1000 + zone - 1)]) return String(1000 + zone - 1);
    return zone;
}

export function isZoneEnd(mgr: RoguelikeV2Manager) : boolean {
    const pos = mgr._status.cursor.position;
    if (!pos) return false;
    const node = mgr._map.zones[mgr.zoneKey(mgr._status.cursor.zone)]?.nodes[
      pos.x * 100 + pos.y
    ];
    return !!node?.zone_end;
}

export async function checkZoneEnd(mgr: RoguelikeV2Manager) : Promise<boolean> {
    if (!mgr.isZoneEnd()) return false;
    const zone = mgr._status.cursor.zone;
    const theme = mgr.current.game!.theme;
    if (zone >= mgr.maxZone) {
      // 三结局·纠缠调和：持有【怦然信标】通过第Ⅵ层 → ending_3
      if (isBlackstream(theme) && mgr.hasRelic(ROGUE6_END3_RELIC)) {
        mgr._status.toEnding = "ro6_ending_3";
      } else if (
        isBlackstream(theme) &&
        (mgr.hasRelic(ROGUE6_END2_RELICS.sandboxAlpha) ||
          mgr.hasRelic(ROGUE6_END2_RELICS.sandboxBeta))
      ) {
        // 二结局·维度重构：持有沙盘α/β 且不持有怦然信标通过第Ⅴ层 → ending_2
        mgr._status.toEnding = "ro6_ending_2";
      }
      // 结局切换为二/三号时下发变更推送（rlv2ChangeEnding，触发类 RoguelikeCheckOnlyEndingChangeNotifyTrigger）
      if (mgr._status.toEnding === "ro6_ending_2" || mgr._status.toEnding === "ro6_ending_3") {
        mgr.pushMessage("rlv2ChangeEnding", {});
      }
      // 修复：通关到最终层终点 → 标记成功（原实现 toEnding 恒非 "normal" → 每次通关
      // 结算都显示失败）；放弃路径由 giveUpGame 置 "giveup"
      mgr._status.runResult = "success";
      // 修复：fire-and-forget 未捕获拒绝会导致 Node 进程终止（gameSettle 内部 game 可能为 null）
      void mgr.gameSettle().catch((e) =>
        logger.error("rlv2", `gameSettle failed: ${(e as Error).message}`),
      );
      return true;
    }
    // 区域奖励：非最终层通关时填充 zoneReward（confirmZoneReward 发放并清空）
    if (!mgr._status.zoneReward || Object.keys(mgr._status.zoneReward).length === 0) {
      const hasRelic = Object.values(mgr.inventory!.relic || {}).map(
        (r) => r.id,
      );
      const rewardId = mgr._pool.getRelic("pool_relic_all", hasRelic);
      if (rewardId) {
        mgr._status.zoneReward = {
          z0: { id: rewardId, count: 1, instId: "" },
        };
      }
    }
    // 难度效果：进入下一区域损失 N% 源石锭（difficulty zone_gold_loss_percent）
    const goldLossPct = mgr._buff?._zoneGoldLossPercent ?? 0;
    if (goldLossPct > 0) {
      const lost = Math.floor((mgr._status.property.gold * goldLossPct) / 100);
      mgr._status.property.gold -= lost;
    }
    mgr._status.cursor.zone += 1;
    mgr._status.cursor.position = null;
    // 先行一步：派出的干员返回。
    // - 基础：归来带回 2 希望（先行一步节点"干员将在下一层开始时归来"，官方选树口述）。
    // - 三结局·纠缠调和：持有【怦然信标】的 ending 分支额外发【怦然信标】
    //   （gameConst.expedEndingRelic = rogue_6_relic_final_3）。
    // - 【生命游戏】"喙"节点（rogue_6_outbuff_33，RAW_TEXT_EFFECT"“先行一步”归来时额外获得
    //   随机加工品"）：归来时额外获得 1 个随机加工品——从 excel 该节点 rawDesc 读取判定。
    const expDetails: ExpeditionDetails = mgr.troop.expeditionDetails;
    if (mgr.troop.expedition.length > 0) {
      const detail = excel.RoguelikeTopicTable.details[theme];
      // 基础：2 希望（先行一步派发归来通用奖励）
      await mgr._trigger.emit("rlv2:get:items", [
        [{ id: `${theme}_population`, count: 2 }],
      ]);
      // «喙»已点亮 → 额外随机加工品（读取 excel 科技树节点 rawDesc 判定，与"翅膀"同模式）
      if (mgr.isBeakUnlocked()) {
        mgr.gainRandomScrap();
      }
      // 三结局分支：额外怦然信标
      if (expDetails?.["ending"]) {
        const endingRelic = detail?.gameConst?.expedEndingRelic;
        if (endingRelic) {
          await mgr._trigger.emit("rlv2:relic:gain", [
            { id: endingRelic, count: 1 },
          ]);
        }
      }
      mgr.troop.expedition = [];
      delete expDetails["ending"];
    }
    await mgr._trigger.emit("rlv2:zone:new", [mgr._status.cursor.zone]);
    // 特勤干员任务：到达区域事件（Rlv2PassZoneSpec）
    await mgr.emitSpecialOperatorZone(mgr._status.cursor.zone);
    return false;
}

export function hasRelic(mgr: RoguelikeV2Manager, id: string) : boolean {
    return Object.values(mgr.inventory?.relic || {}).some((r) => r.id === id);
}

export async function emitSpecialOperatorZone(mgr: RoguelikeV2Manager, zone: number) : Promise<void> {
    const game = mgr.current.game;
    if (!game) return;
    await mgr._trigger.emit("Rlv2PassZoneSpec", [
      {
        theme: game.theme,
        mode: game.mode,
        grade: game.modeGrade ?? 0,
        zoneId: `zone_${zone}`,
      },
    ]);
    // 勋章：Rlv2PassZone（「通过 XX 区域 N 次」，unlockParam = [主题, zoneId, 目标次数]）
    await mgr._trigger.emit("Rlv2PassZone", [
      { theme: game.theme, zoneId: `zone_${zone}` },
    ]);
}

export function nodeTypeCounts(mgr: RoguelikeV2Manager) : Map<number, number> {
    const counts = new Map<number, number>();
    for (const t of mgr._status.trace) {
      const node = mgr._map.zones[mgr.zoneKey(t.zone)]?.nodes[
        `${(t.position?.x ?? 0) * 100 + (t.position?.y ?? 0)}`
      ];
      const type = node?.type ?? 0;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return counts;
}

/**
 * 特勤干员任务结算事件
 *
 * 修复（2026-09-09）：本局运行态（trace/map/入队干员）会被结算 update 清空，故
 * 由调用方在结算**前**取快照并下传（snapshot），不再现场读 mgr 的运行态——
 * 原实现把 emit 放在 update 之后，charIds/spBattleCount/eliteCount 恒为空/0。
 *
 * @param mgr - 肉鸽管理器
 * @param theme - 主题 id
 * @param ending - 达成的结局 id
 * @param snapshot - 结算前快照（charIds/nodeCounts/bandId/mode）；缺省时回退现场读取（兼容旧调用）
 */
export async function emitSpecialOperatorSettle(mgr: RoguelikeV2Manager, theme: string,
    ending: string,
    snapshot?: {
      charIds: string[];
      nodeCounts: Map<number, number>;
      bandId: string;
      mode: string;
    },) : Promise<void> {
    const game = mgr.current.game;
    if (!game) return;
    const mode = snapshot?.mode ?? game.mode;
    // 特勤干员任务均针对「常规行动」（NORMAL 模式）——MONTH_TEAM 等特殊模式不计入
    if (mode !== "NORMAL") return;
    const grade = game.modeGrade ?? 0;
    const bandId = snapshot?.bandId ?? mgr._bandId ?? "";
    const charIds = snapshot?.charIds ?? Object.keys(mgr.troop.chars || {});
    const rec = mgr.outer?.[theme]?.record;
    const bandGrade: Record<string, Record<string, number>> =
      rec?.bandGrade || {};
    const bandCnt: Record<string, Record<string, number>> = rec?.bandCnt || {};

    // 本局节点通过：祸乱（BATTLE/BATTLE_HARD 近似作战/紧急作战）与紧急作战数
    const nodeCounts = snapshot?.nodeCounts ?? mgr.nodeTypeCounts();
    const spBattleCount = (nodeCounts.get(1) ?? 0) + (nodeCounts.get(2) ?? 0);
    const eliteCount = nodeCounts.get(2) ?? 0;
    // 岁兽残识：所有入队干员即伺烛客（秉烛）
    const candleCharCount = charIds.length;

    await mgr._trigger.emit("Rlv2BandGradeCnt", [{ theme, bandGrade }]);
    await mgr._trigger.emit("Rlv2EndingBandGradeCnt", [
      { theme, bandGrade, bandCnt, ending },
    ]);
    await mgr._trigger.emit("Rlv2EndingModeGrade", [
      { theme, bandGrade, bandCnt, ending },
    ]);
    await mgr._trigger.emit("Rlv2EndingWithBandChar", [
      { theme, mode, grade, bandId, charIds, ending },
    ]);
    await mgr._trigger.emit("Rlv2EndingWithCharPassSpBattle", [
      { theme, mode, grade, charIds, spBattleCount, ending },
    ]);
    await mgr._trigger.emit("Rlv2EndingWithCandleChar", [
      { theme, mode, grade, charIds, candleCharCount, ending },
    ]);
    await mgr._trigger.emit("Rlv2EliteBattleWithChar", [
      { theme, mode, grade, charIds, eliteCount, ending },
    ]);
}

export async function selectChoice(mgr: RoguelikeV2Manager, args: { choice: string }) : Promise<void> {
    const { choice } = args;
    const theme = mgr.current.game!.theme;
    const detail = excel.RoguelikeTopicTable.details[theme];
    const choiceConfig = detail.choices[choice];
    // 效果数据（lose/get/m_lose/m_get/i_get/i_lose 与后续选项）来自 data/rlv2/event_choices.json
    const eventConfig = mgr._data.eventChoices?.[theme]?.choices?.[choice];

    // GAME_INIT_SUPPORT（开局 buff/行动奖励）：发放 displayData.itemId 奖励并消费 SUPPORT 事件。
    // 客户端抓包（rogue_6）：chooseInitialRelic → finishEvent → selectChoice(choice_roX_startbuff_N)
    // 防御：客户端先 selectChoice 后 finishEvent 时 pending[0] 可能是 GAME_INIT_GIFT（rogue_6
    // 开局礼物）——先消费礼物再处理支援选择（与 finishEvent 的消费逻辑一致）
    let top = mgr._status.pending[0];
    if (top && top.type === "GAME_INIT_GIFT") {
      const giftItems = top.content.initGift?.items || [];
      mgr._trigger.emit("rlv2:get:items", [giftItems]);
      mgr._status.pending.shift();
      top = mgr._status.pending[0];
    }
    if (top && top.type === "GAME_INIT_SUPPORT") {
      const cfg = choiceConfig;
      const desc = cfg?.description || "";
      const dd = cfg?.displayData || {};
      const prop = mgr._status.property;
      // 结算描述中的 <lose> 消耗。开局 buff（行动奖励）选项常带“消耗”，此前只发放 get 奖励、
      // 未扣对应资源，导致实际消耗与 UI 描述不符（如 startbuff_3“消耗6源石锭”却未扣 gold）。
      // 依据描述关键字映射资源类型，避免与后续 get 奖励混淆。
      const loseTags = [...desc.matchAll(/<@[^>]*\.lose>([^<]*)<\/>/g)];
      for (const m of loseTags) {
        const raw = m[1].trim();
        const num = parseInt(raw, 10);
        if (desc.includes("源石锭")) {
          // “消耗N源石锭”扣 gold；“消耗所有源石锭”清空
          prop.gold = Number.isNaN(num) ? 0 : Math.max(0, prop.gold - num);
        } else if (desc.includes("目标生命值上限")) {
          // “消耗N目标生命值上限”：扣上限并夹取当前值（startbuff_4 退行补偿）
          prop.hp.max = Math.max(0, prop.hp.max - num);
          prop.hp.current = Math.min(prop.hp.current, prop.hp.max);
        } else if (desc.includes("零件箱容量")) {
          // “零件箱容量-1 / +N”：scrap 零件箱容量上限，值可为负（startbuff_6 巢寄生缩减）
          const sm = mgr._module.scrap;
          if (!Number.isNaN(num) && sm) sm.setLimit(sm.limit + num);
        } else if (desc.includes("希望")) {
          // “消耗N希望及等量上限”：扣希望（人口）上限（老主题回收战利品）
          prop.population.max = Math.max(0, prop.population.max - num);
        }
      }
      // 官方 displayData.itemID（PascalCase ID）——startbuff_2/3 有 itemID；startbuff_1/4/5/6 无
      // 小写 itemId 变体：生成模型只声明 itemID（实测 excel 全量为 itemID），
      // 但 mock/历史数据可能给出 itemId，此处按视图读取保持原语义
      const itemId = dd.itemID ?? (dd as { itemId?: string }).itemId;
      if (itemId) {
        const itemDef =
          excel.RoguelikeTopicTable.details[theme]?.items?.[itemId];
        // 奖励数量：description 含 <@roX.get>N</>（如"获得<@ro6.get>8</>源石锭"；
        // 带符号的"零件箱容量<@ro6.get>+2</>"也需命中，空间租赁 +2）
        const m = desc.match(/<@ro\d+\.get>([+-]?\d+)<\/>/);
        const count = m ? parseInt(m[1], 10) : 1;
        if (itemDef?.type === "MAX_WEIGHT") {
          // 零件箱容量型（MAX_WEIGHT 无专属结算）：零件箱容量上限+count（startbuff_3“空间租赁”+2）
          const sm = mgr._module.scrap;
          if (sm) sm.setLimit(sm.limit + (count || 1));
        } else {
          mgr._trigger.emit("rlv2:get:items", [[{ id: itemId, count }]]);
        }
      } else {
        // 无 itemId：按官方 funcIconId 语义分发（prts.wiki 行动奖励）：
        // 未编号物=1 件普通收藏品（NORMAL 池）；巢寄生=1 件稀有收藏品（RARE 池）；
        // 林间代步=1 件加工品（MOVE 型零件）；其余（退行补偿）=全量池随机藏品。
        const theme = mgr.current.game!.theme;
        const funcIcon = (dd.funcIconId as string) || "";
        const hasRelic = Object.values(mgr.inventory!.relic || {}).map(
          (r) => r.id,
        );
        if (funcIcon === "initial_reward_scrap_move" || desc.includes("加工品")) {
          // 林间代步：scrapItemToType 中 MOVE 型零件随机 1 件入零件箱
          const typeMap =
            excel.RoguelikeTopicTable.modules[theme]?.scrap?.scrapItemToType ||
            {};
          const moveIds = Object.keys(typeMap).filter(
            (id) => typeMap[id] === "MOVE",
          );
          if (moveIds.length > 0) {
            const scrapId = moveIds[Math.floor(random() * moveIds.length)];
            await mgr._trigger.emit("rlv2:scrap:gain", [scrapId]);
          }
        } else {
          const poolId =
            funcIcon === "initial_reward_relic" || desc.includes("普通收藏品")
              ? "pool_relic_normal"
              : funcIcon === "initial_reward_unknown_pay_weight" ||
                  desc.includes("稀有收藏品")
                ? "pool_relic_rare"
                : "pool_relic_all";
          const rewardId =
            mgr._pool.getRelic(poolId, hasRelic) ||
            (poolId !== "pool_relic_all"
              ? mgr._pool.getRelic("pool_relic_all", hasRelic)
              : "");
          if (rewardId) {
            await mgr._trigger.emit("rlv2:relic:gain", [
              { id: rewardId, count: 1 },
            ]);
          } else {
            mgr._trigger.emit("rlv2:get:items", [
              [{ id: `${theme}_gold`, count: 5 }],
            ]);
          }
        }
      }
      mgr._status.pending.shift();
      // 开局阶段后续仍有 GAME_INIT_RECRUIT_SET/RECRUIT → 保持 INIT（官方 selectChoice 响应 state=INIT），
      // 全部消费完才进入 WAIT_MOVE（finishEvent 消费 GAME_INIT_RECRUIT 时切换）
      const hasInit = mgr._status.pending.some((e) =>
        (e.type || "").startsWith("GAME_INIT_"),
      );
      mgr._status.state = hasInit ? "INIT" : "WAIT_MOVE";
      return;
    }

    // 误入奇境（rogue_6 portal 场景）：消耗 1 件加工品进入隐藏层（未萌生的摇篮）
    // _1.._3=消耗加工品进入（无加工品→无加工品场景 _2）、_4=直接进入、_5=无加工品、_6=离开
    const portalM = choice.match(/^choice_ro\d+_portal(\d+[ab]?)_(\d+)$/);
    if (portalM && mgr.current.game!.theme === "rogue_6") {
      const family = portalM[1];
      const suffix = portalM[2];
      const numFamily = family.replace(/[ab]$/, "");
      const finishPortal = () => {
        mgr._status.pending.shift();
        mgr._status.state = "WAIT_MOVE";
      };
      if (suffix === "4") {
        // 进入黑潭（不消耗加工品）
        mgr.enterPortalZone(numFamily);
        return;
      }
      if (suffix === "1" || suffix === "2" || suffix === "3") {
        if (mgr.consumePortalScrap()) {
          mgr.enterPortalZone(numFamily);
        } else {
          // 没有可用的加工品 → 节点结束（客户端展示对应提示）
          finishPortal();
        }
        return;
      }
      // _5 无加工品 / _6 离开 → 节点结束
      finishPortal();
      return;
    }

    // 二结局·维度重构——命运所指（好奇心与死 end1 / 窥视箱中 end2）
    if (theme === "rogue_6" && /^choice_ro6_end2_[14]$/.test(choice)) {
      // 找到传出声音的位置 → 决战场景（仅给"与当前区域首领的决战"选项）
      mgr._status.pending.shift();
      const c3 = { choice_ro6_end2_3: 1, choice_ro6_end2_4: 1 };
      const ca3 = {
        choice_ro6_end2_3: { rewards: [] },
        choice_ro6_end2_4: { rewards: [] },
      };
      mgr._trigger.emit("rlv2:event:create", [
        "SCENE",
        {
          scene: { id: "scene_ro6_end2_2", choices: c3, choiceAdditional: ca3 },
          done: false,
          popReport: false,
        },
      ]);
      return;
    }
    if (theme === "rogue_6" && choice === "choice_ro6_end2_3") {
      // 与当前区域首领的决战 → 混沌源阶理论（ro6_b_5，险路恶敌）
      mgr.startChaosSourceBattle();
      return;
    }
    if (theme === "rogue_6" && /^choice_ro6_end1_[12]$/.test(choice)) {
      // 好奇心与死：消耗 50 源石锭标记（找投影位置）/ 获得 1 件收藏品
      if (choice === "choice_ro6_end1_1") {
        mgr._status.property.gold = Math.max(
          0,
          mgr._status.property.gold - 50,
        );
      } else {
        const hasRelic = Object.values(mgr.inventory!.relic || {}).map(
          (r) => r.id,
        );
        const rid = mgr._pool.getRelic("pool_relic_all", hasRelic);
        if (rid) {
          mgr._trigger.emit("rlv2:relic:gain", [{ id: rid, count: 1 }]);
        }
      }
      mgr._status.pending.shift();
      mgr._status.state = "WAIT_MOVE";
      return;
    }
    // 二结局·线人（bomb1：不期而遇“线人与线索”）→ 沙盘α / 珍贵加工品 / 离开
    if (theme === "rogue_6" && /^choice_ro6_bomb1_/.test(choice)) {
      if (choice === "choice_ro6_bomb1_1") {
        await mgr._trigger.emit("rlv2:relic:gain", [
          { id: "rogue_6_relic_final_1", count: 1 },
        ]);
      } else if (choice === "choice_ro6_bomb1_2") {
        mgr.gainPreciousScrap();
      }
      mgr._status.pending.shift();
      mgr._status.state = "WAIT_MOVE";
      return;
    }

    // 不期而遇事件选项（res/relic/normal/bat/bat6b/task/chimera 系列）：
    // 事件引擎统一结算（描述文本解析消耗 / displayData 发放 / 随机分支 / 场景图推进 / 战斗）
    if (
      theme === "rogue_6" &&
      /^choice_ro6_(res\d|relic\d|normal\d|bat\d|task\d|chimera\d)/.test(choice)
    ) {
      if (await mgr._incident.resolveChoice(choice)) return;
    }

    // 非战斗事件节点选项（安全的角落/得偿所愿/失与得/险路尽头/险路小径/先行一步）：
    // 引擎结算完整效果（区域出口推进/行动力转化/收藏品与零件交换/招募等）
    if (
      theme === "rogue_6" &&
      /^choice_ro6_(rest|wish|sacrifice|final|evacuate|scout)/.test(choice)
    ) {
      if (await mgr._incident.resolveNodeChoice(choice)) return;
    }

    if (choice === "choice_leave") {
      mgr._status.pending.shift();
      await mgr.checkZoneEnd();
      mgr._status.state = "WAIT_MOVE";
      return;
    }

    const isBattle = choice.includes("bat") || typeof eventConfig?.choices === "string";

    // 构建下一场景 SCENE 事件的选项表（选项列表来自 event_choices 的 choices 数组）
    const buildSceneChoices = (sceneId: string) => {
      const list = Array.isArray(eventConfig?.choices) ? (eventConfig.choices as string[]) : [];
      const choices = list.reduce((acc, key) => ({ ...acc, [key]: 1 }), {});
      const choiceAdditional = list.reduce((acc, key) => ({ ...acc, [key]: { rewards: [] } }), {});
      mgr._status.pending.shift();
      mgr._trigger.emit("rlv2:event:create", [
        "SCENE",
        {
          scene: { id: sceneId, choices, choiceAdditional },
          done: false,
          popReport: false,
        },
      ]);
    };

    if (isBattle) {
      const nextSceneId = choiceConfig?.nextSceneId;
      if (nextSceneId) {
        buildSceneChoices(nextSceneId);
      } else {
        const stageKeyword =
          typeof eventConfig?.choices === "string" ? (eventConfig.choices as string) : undefined;
        let stageId = stageKeyword;
        if (stageKeyword && stageKeyword.endsWith("_")) {
          const stageKeys = Object.keys(detail.stages || {}).filter((k) => k.includes(stageKeyword));
          if (stageKeys.length > 0) {
            stageId = stageKeys[Math.floor(random() * stageKeys.length)];
          }
        }

        if (stageId) {
          const nodeId = mgr._status.cursor.position
            ? mgr._status.cursor.position.x * 100 + mgr._status.cursor.position.y
            : 0;
          const zone = mgr._status.cursor.zone;
          if (mgr._map.zones[zone]?.nodes[nodeId]) {
            mgr._map.zones[zone].nodes[nodeId].stage = stageId;
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
              // 修复（2026-09-11）：本路径原固定下发空数组 → 事件触发的战斗丢失全部藏品/难度
              // 增益（"进入战斗关卡会获得对应藏品的 buff/debuff 加成"在事件战斗不生效）。
              // 对齐 ODPY SelectChoice：unKeepBuff = getBuffs(rlv2, stage_id)。
              unKeepBuff: mgr._buff.getBuffs(),
            },
          ]);
        }
      }
    } else {
      const nextSceneId = choiceConfig?.nextSceneId;
      if (nextSceneId) {
        // 先行一步（rogue_6 三结局·纠缠调和）：选择"派一名同伴进入/探索"
        // （choice_ro6_scout_1/3 → scene_ro6_scout_2/3）→ 标记三结局远征，
        // 干员下一层返回时带回 2 希望 + 【怦然信标】（gameConst.expedEndingRelic）
        if (theme === "rogue_6" && /^choice_ro6_scout_[13]$/.test(choice)) {
          const expeditionDetails: ExpeditionDetails =
            mgr.troop.expeditionDetails;
          expeditionDetails["ending"] = true;
        }
        const rawGet = eventConfig?.get;
        const lose = asEffectMap(eventConfig?.lose);
        const get = asEffectMap(rawGet);
        const mLose = asEffectMap(eventConfig?.m_lose);
        const mGet = asEffectMap(eventConfig?.m_get);
        const iGet = asEffectMap(eventConfig?.i_get);
        const iLose = asEffectMap(eventConfig?.i_lose);

        if (mLose) {
          mgr._module.applyModuleDelta(mLose, -1);
        }
        if (mGet) {
          mgr._module.applyModuleDelta(mGet, 1);
        }
        if (iGet) {
          mgr.applyInventoryDelta(iGet, 1);
        }
        if (iLose) {
          mgr.applyInventoryDelta(iLose, -1);
        }
        if (lose) {
          mgr.applyPropertyDelta(lose, -1);
          if (mgr._status.property.gold < 0) {
            mgr._status.property.gold = 0;
          }
        }
        if (get) {
          mgr.applyPropertyDelta(get, 1);
        }
        if (typeof rawGet === "string") {
          const itemKeys = Object.keys(detail.items || {}).filter(
            (k) => k.includes(rawGet) && !k.includes("curse_")
          );
          if (itemKeys.length > 0) {
            const itemId = itemKeys[Math.floor(random() * itemKeys.length)];
            mgr._trigger.emit("rlv2:get:items", [[{ id: itemId, count: 1 }]]);
          }
        }

        // 官方选项效果：displayData.itemID（PascalCase ID；rogue_6 数据如此）+ 描述 GET 数量
        // （REST 回血/进阶券/希望等节点特有效果；rogue_6 无 event_choices 效果表，由此派生）
        const dd = choiceConfig?.displayData || {};
        const officialItem = dd.itemID ?? (dd as { itemId?: string }).itemId;
        if (officialItem) {
          const m = (choiceConfig?.description || "").match(
            /<@ro\d+\.get>(\d+)<\/>/,
          );
          const count = m ? parseInt(m[1], 10) : 1;
          mgr._trigger.emit("rlv2:get:items", [
            [{ id: officialItem, count }],
          ]);
        }

        buildSceneChoices(nextSceneId);
      } else {
        mgr._status.pending.shift();
        mgr._status.state = "WAIT_MOVE";
      }
    }
}

export async function readEndingChange(mgr: RoguelikeV2Manager) : Promise<void> {
    mgr._status.chgEnding = false;
    mgr._status.state = "WAIT_MOVE";
}
