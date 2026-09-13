/**
 * 基建分区逻辑：时间累计与每日刷新（advance/各房间会计/心情体力/线索周切）
 *
 * 由 BuildingManager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { BuildingManager } from "../logic";
import { PlayerCharacter } from "../../../kernel/model";
import excel from "@excel/excel";
import { now } from "@utils/time";
import { logger } from "@utils/logger";
import { Draft } from "mutative";
import { PlayerDataModel } from "../../../kernel/playerdata";
import { PlayerBuildingMeetingClue } from "../../../kernel/playerdata";
import { accountManager } from "../../account/public";
import { headcountMoodRelief, isDispersedAp, warmupHoursOf, MAX_AP } from "../mood";
import { getSpecCond, SPEC_ASSIST_BASE_BONUS } from "../mastery";
import { contactSpeedFactor, settleContactProgress } from "../hire-contacts";
import { rarityToIndex } from "@utils/rarity";
import { getManufactFormula, getWorkshopFormula, getBuildingConstant, getRoomPhase, getGoldRate, getManufactPhase, getDormPhase, getFurnitureInfo, getRoomMaxLevel, getManufactFormulaType, getRoomElectricity, getMeetingPhase, getHirePhase, getClueExpiredDays, getMessageLeaveBoardConst, getClueConstant } from "@excel/building_excel";
import {
  CharBuffSource,
  roomSpeedBonus,
  controlGlobalBonus,
  charMoodCost,
  getActiveCharBuffs,
  parseVupValue,
  phaseRank,
} from "../buff";
import {
  meetingSpeedMultiplier,
  CLUE_BASE_SECONDS,
  OWN_CLUE_LIMIT,
} from "../clue-speed";
import { random } from "@utils/random";
import type {
  CharWithFavor,
  CharWithWarmup,
  HireRoom,
  MeetingRoom,
  RoomTimestamp,
  TraineeWithMaxPoint,
} from "./ext-types";

  /**
   * 干员进驻建档回调（`char:init` 事件）：初始化基建在编状态
   *
   * 修复（2026-09-09，审计 §6.3-27）：订阅原先挂在 "building:char:init" 上——该事件全仓无
   * emit 方，真正派发的是干员模块的 "char:init"（onCharGet 获取新干员时）→ 本函数从未执行，
   * 新获得干员在 `building.chars` 无建档（官方存档每个在编干员均有该条目：charId/ap/
   * lastApAddTime/roomSlotId/index/changeScale/bubble/workTime/privateRooms）。
   *
   * 幂等：已有建档（迁移档/重复派发）直接返回，不覆盖心情 AP 与私人宿舍归属。
   * @param char - 新获得干员（`char:init` 载荷）
   */
export async function _onCharInit(mgr: BuildingManager, char: PlayerCharacter) : Promise<void> {
    // 幂等守卫：已有建档不覆盖（char:init 可能对同一 instId 重复派发/迁移档已建档）
    if (mgr._player._playerdata.building?.chars?.[char.instId]) return;
    await mgr._player.update(async (draft) => {
      if (draft.building.chars[char.instId]) return;
      draft.building.chars[char.instId] = {
        charId: char.charId,
        lastApAddTime: now(),
        ap: 8640000,
        roomSlotId: "",
        index: -1,
        changeScale: 0,
        bubble: {
          normal: {
            add: -1,
            ts: 0,
          },
          assist: {
            add: -1,
            ts: 0,
          },
          private: {
            add: -1,
            ts: 0,
          },
        },
        workTime: 0,
        privateRooms: [],
      };
    });
}

  /**
   * 每日刷新：重置会客室每日免费线索 + 留言板社交点周切 + 被动信用（好友访问）累积
   *
   * 修复：
   * 1. getDailyClue 置位 room.dailyReward 后全库无清除逻辑（无每日重置）→
   *    每日免费线索只能领取一次，会客室线索收集（7 阵营合成奖励）形同虚设；
   *    每日刷新将 dailyReward 复位为 null（模板存档的"今日未领"合法值）。
   * 2. messageLeave.sp 周切从未发生——lastWeek 恒 0，留言板"上周社交点"
   *    永远领不到；按周一 4:00 边界滚动：lastWeek ← thisWeek、累计入账。
   * 3. 被动信用（socialReward.daily）从不累积——模板初值领取一次后信用经济
   *    枯竭；每日刷新模拟好友访问：daily += 好友数 × friendSlotInc（封顶
   *    creditPassiveLimit），getMeetingroomReward 领取后清零重新累积。
   */
export async function dailyRefresh(mgr: BuildingManager) {
    let friendCount = 0;
    try {
      const social = await accountManager.getSocial(
        String(mgr._player._playerdata.status.uid),
      );
      friendCount = social.friends.length;
    } catch (e) {
      logger.warn(
        "building",
        `dailyRefresh 好友列表加载失败: ${(e as Error).message}`,
      );
    }
    await mgr._player.update(async (draft) => {
      const ts = now();
      for (const room of Object.values(draft.building.rooms.MEETING ?? {})) {
        const meetingRoom = room as MeetingRoom;
        meetingRoom.dailyReward = null;
        // 自动移除库存（ownStock + receiveStock）中已过期的线索
        mgr._purgeExpiredClues(draft, meetingRoom, ts);
        // 留言板社交点周切（跨周：lastWeek ← thisWeek 可领、thisWeek 归零）
        mgr._rolloverWeekSp(meetingRoom, ts);
        // 留言板社交点累积（模拟好友访问留言板）→ 计入本周 thisWeek
        mgr._accumulateMessageLeaveSp(meetingRoom, friendCount);
        // 修复（2026-09-09，审计 §5.4-12）：宿舍氛围每日结算信用（Cd=10+⌊Ad/125⌋，
        // 每间 50 上限、全天 200）**不再**写入会客室 socialReward.daily——PRTS「信用」页
        // 把它归入「每日结算的信用」（次日于**信用交易所**手动领取），官服存档实测
        // MEETING.socialReward.daily = 0 而 social.yesterdayReward.comfortAmount = 200。
        // 现由 SocialManager.dailyRefresh 写入 yesterdayReward.comfortAmount；会客室容器
        // 只保留 search（访问/情报分享）与 legacy 的 daily。
        room.socialReward = room.socialReward ?? { daily: 0, search: 0 };
        // 线索接收信用每日计次重置（接收好友线索 15/10/5，第 4 张起不获信用）
        meetingRoom.clueReceiveCount = 0;
      }
      // 再修复（2026-08-23）：累积被动信用后刷新 infoShare.reward 待领取指示——
      // 原实现只写 socialReward.daily，不更新 infoShare，客户端"会客室可领信用"红点/
      // 状态在每日刷新后不更新，需等下次 sync 才反映 → 「每日更新不刷新信用可领取状态」。
      mgr._refreshInfoShare(draft);
    });
}

  /**
   * 内部方法：留言板社交点周切（周一 4:00 边界）
   * sp = { lastWeek, lastWeekSum, thisWeek, thisWeekSum }：
   * - 当前周已进入 → lastWeek ← thisWeek（上周可领）、thisWeek 归零重新累计
   * - 跨多周（长时间未登录）→ 只滚动一次（避免累计失真）
   */
export function _rolloverWeekSp(mgr: BuildingManager, room: MeetingRoom, ts: number) : void {
    const leave = room?.messageLeave;
    if (!leave?.sp) return;
    const lastTs = leave.lastUpdateSpTs ?? 0;
    if (lastTs <= 0) {
      leave.lastUpdateSpTs = ts;
      return;
    }
    const weekStart = (t: number): number => {
      const d = new Date(t * 1000);
      // 周一为每周起点（getDay(): 0=周日）
      const day = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - day);
      d.setHours(4, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    };
    if (weekStart(ts) <= weekStart(lastTs)) return; // 同一周
    const sp = leave.sp;
    // 上周累计入账 + 上周可领 ← 本周累计
    sp.lastWeekSum = (sp.lastWeekSum ?? 0) + (sp.lastWeek ?? 0);
    sp.lastWeek = sp.thisWeek ?? 0;
    sp.thisWeekSum = (sp.thisWeekSum ?? 0) + (sp.thisWeek ?? 0);
    sp.thisWeek = 0;
    leave.lastUpdateSpTs = ts;
}

  /**
   * 发电站在岗干员的无人机充能加成（Σ roomSpeedBonus(POWER)，对应官方 labor.buffSpeed）
   * @param draft - mutative 可写草稿
   * @returns 充能速度加成（0.6 = +60%）
   */
function _powerLaborSpeed(
  mgr: BuildingManager,
  draft: Draft<PlayerDataModel>,
): number {
  let bonus = 0;
  for (const [slotId, room] of Object.entries(
    draft.building.rooms.POWER ?? {},
  )) {
    // 仅在运行的发电站计入（state=1；缺省视为运行）
    if (room && (room as { state?: number }).state !== 0) {
      const slot = draft.building.roomSlots[slotId];
      const chars = mgr._roomCharSources(draft, slot);
      bonus += roomSpeedBonus(chars, "POWER", [], mgr._specialCtx(draft));
    }
  }
  return bonus;
}

  /**
   * 按 laborRecoverTime（秒/点）自动恢复劳动力（_advanceBuilding 统一 deltaTime 推进调用）
   * 例：laborRecoverTime=360 → 6 分钟恢复 1 点，封顶 maxValue
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒），elapsed = ts - lastUpdateTime
   */
export function _recoverLabor(mgr: BuildingManager, draft: Draft<PlayerDataModel>, ts: number) : void {
    const labor = draft.building.status.labor;
    const baseRate = getBuildingConstant("laborRecoverTime") ?? 360;
    // 修复（2026-09-09）：充能速率须计入发电站在岗干员加成——prts《发电站》：
    // 每名在岗干员充能速度 +5%，实际加成为所有发电站之和（真存档 labor.buffSpeed=0.6）。
    // 原实现固定 360s/架且从不写 buffSpeed → 发电站干员（伊芙利特/澄闪/THRM-EX）完全无效。
    const buffSpeed = _powerLaborSpeed(mgr, draft);
    (labor as { buffSpeed?: number }).buffSpeed = buffSpeed;
    const rate = baseRate / (1 + Math.max(0, buffSpeed));
    const elapsed = ts - (labor.lastUpdateTime || ts);
    if (elapsed <= 0 || rate <= 0) return;
    const gain = Math.floor(elapsed / rate);
    if (gain > 0) {
      labor.value = Math.min(labor.value + gain, labor.maxValue);
      labor.lastUpdateTime = ts;
    }
}

  /** 会客室 infoShare 待领取奖励指示（官方 reward 为 0/1：socialReward 有未领取信用 → 1） */
export function _infoShareReward(mgr: BuildingManager, sr: { daily?: number; search?: number } | undefined,) : number {
    return (sr?.daily ?? 0) + (sr?.search ?? 0) > 0 ? 1 : 0;
}

  /**
   * 内部方法：单次好友访问/情报分享的信用量（会客室相位 friendSlotInc，
   * 保底 creditGuaranteed=10，兜底 35）——信用经济循环的每次入账量
   */
export function _meetingCreditPerVisit(mgr: BuildingManager, draft: Draft<PlayerDataModel>) : number {
    const guaranteed = getBuildingConstant("creditGuaranteed") ?? 10;
    for (const slot of Object.values(draft.building.roomSlots)) {
      if (slot?.roomId !== "MEETING") continue;
      const phase = getMeetingPhase(slot.level ?? 1);
      if (typeof phase?.friendSlotInc === "number" && phase.friendSlotInc > 0) {
        return phase.friendSlotInc;
      }
      return guaranteed;
    }
    return guaranteed;
}

  /**
   * 宿舍氛围每日结算信用（PRTS：Cd = 10 + ⌊Ad/125⌋，每间 ≤50，全天 ≤200）
   *
   * **归属修正（2026-09-09，审计 §5.4-12）**：PRTS「信用」页把「根据宿舍氛围获取信用」
   * 列在**每日结算的信用**之下——「以上结算获得的信用将于次日发放至信用交易所，需要
   * 手动领取」，即写入 social.yesterdayReward.comfortAmount 并由 social/receiveSocialPoint
   * 领取。原实现写入**会客室** socialReward.daily、经 getMeetingroomReward 领取：官服存档
   * 实测 MEETING.socialReward.daily = 0 而 social.yesterdayReward.comfortAmount = 200，
   * 两者分属不同容器 → 归属错误。
   *
   * 宿舍氛围值 Ad 取该间宿舍的 comfort 字段（真实存档 comfort=5000 → 50，正好封顶）。
   * @param draft - mutative 草稿
   * @returns 当日宿舍结算信用总量（≤200）
   */
export function dormComfortCredit(draft: Draft<PlayerDataModel>) : number {
    let total = 0;
    for (const room of Object.values(draft.building?.rooms?.DORMITORY ?? {})) {
      const comfort = room?.comfort ?? 0;
      total += Math.min(10 + Math.floor(comfort / 125), 50);
    }
    return Math.min(total, 200);
}

  /** 委派至 {@link dormComfortCredit}（保留既有 BuildingManager 门面签名） */
export function _settleDormCredit(mgr: BuildingManager, draft: Draft<PlayerDataModel>) : number {
    return dormComfortCredit(draft);
}

  /**
   * 内部方法：留言板社交点（messageLeave.sp.thisWeek）累积——好友访问
   * 留言板每位 + visitorBonus，封顶 visitorBonusLimit（每周）
   *
   * 修复（2026-08-23）：confirmMessageBoardReward 领取的是 sp.lastWeek
   * （上周留言板社交点），但私服从未累积 sp.thisWeek——lastWeek 恒 0，
   * 留言板"上周社交点"永远领不到。此处模拟好友访问留言板，每日刷新时
   * 把 thisWeek 累积起来，跨周（_rolloverWeekSp）后 lastWeek ← thisWeek
   * 即可正常领取。
   */
export function _accumulateMessageLeaveSp(mgr: BuildingManager, room: MeetingRoom,
    visitCount: number,) : void {
    if (!room || visitCount <= 0) return;
    const { visitorBonus, visitorBonusLimit } = getMessageLeaveBoardConst();
    const leave = room.messageLeave ??= {
      inUse: false,
      lastVisitTs: 0,
      lastShowTs: 0,
      lastUpdateSpTs: 0,
      sp: { lastWeek: 0, lastWeekSum: 0, thisWeek: 0, thisWeekSum: 0 },
    };
    leave.inUse = true;
    leave.lastVisitTs = now();
    const sp = leave.sp ??= { lastWeek: 0, lastWeekSum: 0, thisWeek: 0, thisWeekSum: 0 };
    sp.thisWeek = Math.min(
      (sp.thisWeek ?? 0) + visitCount * visitorBonus,
      visitorBonusLimit,
    );
}

  /**
   * 内部方法：主动信用（socialReward.search）累积——情报分享每个访客 +
   * friendSlotInc，封顶 creditInitiativeLimit
   */
export function _accumulateSearchCredit(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    room: MeetingRoom,
    visitorCount: number,) : void {
    if (!room || visitorCount <= 0) return;
    const perVisit = mgr._meetingCreditPerVisit(draft);
    const limit = getBuildingConstant("creditInitiativeLimit") ?? 100;
    room.socialReward = room.socialReward ?? { daily: 0, search: 0 };
    room.socialReward.search = Math.min(
      (room.socialReward.search ?? 0) + visitorCount * perVisit,
      limit,
    );
}

  /**
   * 更新会客室 infoShare 字段（惰性初始化 + reward 待领取指示）
   * 官方 sync/基建请求响应 delta 含 infoShare（抓包 reward:1=有待领取，
   * getInfoShareReward 处理后归 0）；不更新则客户端红点/领取状态不刷新。
   */
export function _refreshInfoShare(mgr: BuildingManager, draft: Draft<PlayerDataModel>) : void {
    const room = Object.values(draft.building.rooms.MEETING)[0];
    if (!room) return;
    const is = (room.infoShare ??= { ts: 0, reward: 0 });
    is.reward = mgr._infoShareReward(room.socialReward);
}

  /**
   * 同步基建数据
   * 时间驱动：劳动力恢复 → 干员心情档位重算（岗位/技能）→ 干员心情累积 →
   * 制造站生产累积 → 贸易站订单补充 → 训练室进度推进 → 会客室 infoShare 待领取指示。
   * @returns 当前时间戳
   */
  /**
   * 内部方法：推进各生产房间 completeWorkTime 到未来（修复高频无限 sync）
   *
   * 客户端基建界面依据每个房间的 completeWorkTime 设置倒计时，并在其到达时触发
   * /building/sync 刷新。若 completeWorkTime 为过去值（含 0/缺失），客户端判定该房间
   * "事件已到期待处理"→ 立即 sync → 服务端不推进 → 无限请求。官方存档中 completeWorkTime
   * 恒为未来（下一次生产/订单/招募完成时刻）。此处按当前生产进度重算：
   * - 制造站：now + (costPoint - processPoint) / capacity（下一方案完成）
   * - 贸易站：now + (maxPoint - next.processPoint) / next.speed（下一订单刷新）
   * - 会客室/招募：now + (phase 阶段点 - processPoint) / speed（下一线索/干员刷新）
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒）
   */
export function _refreshRoomCompletionTimes(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    ts: number,) : void {
    const rooms = draft.building.rooms;
    // 制造站：下一方案完成时刻
    for (const [slotId, room] of Object.entries(rooms.MANUFACTURE ?? {})) {
      if (!room || room.state !== 1) continue;
      const formula = getManufactFormula(room.formulaId);
      if (!formula) continue;
      const costPoint = formula.costPoint ?? 0;
      const capacity = mgr._roomCapacity(draft, slotId, formula);
      if (costPoint <= 0 || capacity <= 0) continue;
      const remain = room.remainSolutionCnt ?? 0;
      if (remain > 0) {
        // 计划未耗尽：下一方案完成时刻（未来）
        const left = Math.max(0, costPoint - (room.processPoint ?? 0));
        room.completeWorkTime = ts + Math.max(1, Math.ceil(left / capacity));
      } else if (room.completeWorkTime == null || room.completeWorkTime < ts) {
        // 计划已停摆（remain=0）：对齐官方置 -1（无倒计时，客户端据此显示"待收取"而非过期）
        room.completeWorkTime = -1;
      }
    }
    // 贸易站：下一订单生成/刷新时刻（next.processPoint → maxPoint）
    for (const room of Object.values(rooms.TRADING ?? {})) {
      if (!room || room.state !== 1) continue;
      const next = room.next;
      if (next && typeof next.maxPoint === "number" && typeof next.processPoint === "number") {
        const speed = next.speed && next.speed > 0 ? next.speed : 1;
        const left = Math.max(0, next.maxPoint - next.processPoint);
        const cwt = ts + Math.max(1, Math.ceil(left / speed));
        // 参考官方：贸易站 completeWorkTime = 下一订单完成时刻（含 stock 补货）
        if (room.completeWorkTime == null || room.completeWorkTime < ts) {
          room.completeWorkTime = cwt;
        }
      }
    }
    // 会客室/招募：推进到下一重置边界（避免过去值导致无限 sync）
    // 官方这些房间的 completeWorkTime 是"下一事件完成时刻"（分钟级）。私服存档
    // processPoint 无精确阈值，直接推进到下一个 4:00/16:00 基建重置边界——
    // 既保证恒为未来（客户端不会因过去值无限 sync），又避免秒级高频轮询。
    for (const rtype of ["MEETING", "HIRE"] as const) {
      for (const room of Object.values(rooms[rtype] ?? {})) {
        if (!room || room.state !== 1) continue;
        if (room.completeWorkTime == null || room.completeWorkTime < ts) {
          room.completeWorkTime = mgr._nextDailyBoundary(ts);
        }
      }
    }
}

  /**
   * 内部方法：刷新 event.building = 下一个最近事件时刻
   *
   * 官方语义：客户端在 event.building 到达时触发下一次 /building/sync。
   * 取 min(下一 4:00/16:00 重置边界, 所有房间最小未来 completeWorkTime)——
   * 既有即将完成的房间事件（订单/生产完成）时用事件时刻，否则回到重置边界
   * （DoctoratePy 参考行为），保证 event.building 恒为未来、随 sync 动态推进。
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒）
   */
export function _refreshBuildingEventTs(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    ts: number,) : void {
    const boundary = mgr._nextDailyBoundary(ts);
    let earliestCwt = Infinity;
    for (const roomsByType of Object.values(draft.building.rooms)) {
      for (const room of Object.values(roomsByType ?? {})) {
        const cwt = (room as RoomTimestamp)?.completeWorkTime;
        if (typeof cwt === "number" && cwt > ts) {
          earliestCwt = Math.min(earliestCwt, cwt);
        }
      }
    }
    const target = Math.min(boundary, earliestCwt);
    draft.event.building = target;
}

  /**
   * 内部方法：下一次 4:00/16:00 基建重置边界（秒）
   * @param ts - 当前时间戳（秒）
   * @returns 下一个 4:00/16:00 边界（若已过今日 16:00 则取明日 4:00）
   */
export function _nextDailyBoundary(mgr: BuildingManager, ts: number) : number {
    const d = new Date(ts * 1000);
    const at = (h: number): Date => {
      const x = new Date(d);
      x.setHours(h, 0, 0, 0);
      return x;
    };
    const t4 = at(4).getTime();
    const t16 = at(16).getTime();
    const t4Next = at(4);
    t4Next.setDate(t4Next.getDate() + 1);
    const ms = d.getTime();
    const target = ms <= t4 ? t4 : ms <= t16 ? t16 : t4Next.getTime();
    return Math.floor(target / 1000);
}

  /**
   * 统一 deltaTime 基建状态推进入口
   *
   * 时间基准由调用方注入（ts=整数秒、tsFloat=浮点秒）——所有子系统以
   * elapsed = ts - lastUpdateTime 推进，同一轮推进内时间一致，且不依赖真实时钟
   * （测试可直接注入任意 ts 验证 deltaTime 语义，无需 mock now()）。
   *
   * 推进顺序（与官方 sync 语义一致）：
   * 劳动力恢复 → 心情档位重算 → 干员心情累积 → 制造站生产 → 贸易站订单推进 →
   * 贸易站补单兜底 → 训练室进度 → 会客室 infoShare 指示。
   *
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（整数秒）
   * @param tsFloat - 浮点秒时间基准（默认同 ts；干员心情用毫秒精度保证增量恒在）
   */
export function _advanceBuilding(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    ts: number,
    tsFloat: number = ts,) : void {
    // 劳动力恢复（按 laborRecoverTime 自动回涨，封顶 maxValue）
    mgr._recoverLabor(draft, ts);
    // 干员心情档位（changeScale）按当前岗位 + 干员技能重算——换班后无需等客户端
    mgr._recomputeCharScales(draft);
    // 干员心情（building.chars[].ap）随时间累积——官方每次 sync 都下发 chars 增量
    mgr._accrueCharAp(draft, tsFloat);
    // 干员暖机工时（在岗累积，离岗/换工位清零）——贸易概率改写等暖机技能消费
    mgr._accrueWarmup(draft, ts);
    // 干员信赖（favorPoint）随时间累积：在岗 + 助战干员按流逝时间结算（basicFavorPerDay/24/h）
    mgr._accrueFavor(draft, tsFloat);
    // 制造站生产随时间累积（进度/产出不再与时间脱钩）
    for (const roomSlotId of Object.keys(draft.building.rooms.MANUFACTURE)) {
      mgr._accrueManufacture(draft, roomSlotId, ts);
    }
    // 贸易站订单按 next.processPoint 随时间生成（deltaTime 驱动）+ 静态补单兜底
    mgr._accrueTrading(draft, ts);
    mgr._refreshTradingOrders(draft, ts);
    // 训练室进度推进（trainee.processPoint 随时间累积，客户端进度显示一致）
    mgr._accrueTraining(draft, ts);
    // 会客室线索搜集进度推进（processPoint 随时间累积，speed 含 meet_* buff）
    mgr._accrueMeeting(draft, ts);
    // 人力办公室人脉搜集进度推进（processPoint 随时间累积，speed 含 hire_* buff）
    mgr._accrueHire(draft, ts);
    // 统一时间戳：所有工作时间房间（state=1）lastUpdateTime 推进到 ts——
    // 修复 CONTROL/无推进条件房间（如无 next 的旧存档贸易站）时间戳长期停留旧值
    // （2222 存档 CONTROL/MEETING/HIRE lastUpdateTime 停在 6 天前）
    mgr._touchActiveRooms(draft, ts);
    // 会客室 infoShare.reward 待领取指示（官方 sync 响应含该字段）
    mgr._refreshInfoShare(draft);
}

  /**
   * 内部方法：会客室线索搜集进度推进
   *
   * 官方模型（PlayerBuildingMeeting）：processPoint 随时间按有效速度累积
   * （基础 gatheringSpeed × (1 + 进驻干员 meet_* buff)），达到阈值出线索。
   * 修复（2026-08-19）：此前无推进逻辑——2222 存档会客室 processPoint 停在
   * 540 万、lastUpdateTime 停在 8-13，客户端进度/倒计时失实。
   * 私服简化：进度真实累积供客户端显示；线索产出仍由 getDailyClue/访客/边界驱动。
   *
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒）
   */
export function _accrueMeeting(mgr: BuildingManager, draft: Draft<PlayerDataModel>, ts: number) : void {
    for (const [slotId, roomRaw] of Object.entries(draft.building.rooms.MEETING ?? {})) {
      const room = roomRaw as MeetingRoom;
      if (!room || room.state !== 1) continue;
      const slot = draft.building.roomSlots[slotId];
      const base = getMeetingPhase(slot?.level ?? 1)?.gatheringSpeed;
      if (typeof base !== "number" || base <= 0) continue;
      // 未进驻干员不搜集线索——PRTS《罗德岛基建/会客室》：「进驻干员后，干员将自动
      // 开始线索收集」（同「仅在有干员进驻时，每日 4:00 可发放 1 份会客室线索」）。
      // 修复（2026-09-09，B11）：原实现不校验进驻——空会客室照常按 107% 产出线索。
      if (mgr._roomCharSources(draft, slot ?? null).length === 0) continue;
      // 官方线索速度全公式（2026-08-25 对齐，会客室页）：等级基础效率（107/109/111%）+
      // 全宿舍氛围档 + Σ进驻干员（稀有度/精英阶段/非涣散）+ meet_* 技能
      const meetBonus = roomSpeedBonus(
        mgr._roomCharSources(draft, slot),
        "MEETING",
        [],
        mgr._specialCtx(draft),
      );
      let totalComfort = 0;
      for (const d of Object.values(draft.building.rooms.DORMITORY ?? {})) {
        totalComfort += d?.comfort ?? 0;
      }
      const charInfos = (slot?.charInstIds ?? [])
        .filter((i) => i > 0)
        .map((instId) => {
          const src = mgr._charSource(draft, instId);
          if (!src) return null;
          return {
            rarityIndex: rarityToIndex(
              excel.CharacterTable?.[src.charId]?.rarity,
            ),
            evolvePhase: src.evolvePhase ?? 0,
            dispersed: isDispersedAp(
              draft.building.chars[String(instId)]?.ap,
            ),
          };
        })
        .filter((c): c is NonNullable<typeof c> => c != null);
      const mult = meetingSpeedMultiplier({
        roomLevel: slot?.level ?? 1,
        totalComfort,
        chars: charInfos,
        meetBonus,
      });
      room.speed = Math.round(base * mult);
      const elapsed = ts - (room.lastUpdateTime || ts);
      if (elapsed <= 0) continue;
      room.lastUpdateTime = ts;
      const threshold = CLUE_BASE_SECONDS * base;
      // 满库滞留（B11 修复 2026-09-09）：PRTS《罗德岛基建/会客室》——
      // 「最多存储 10 份，达到上限时无法继续入库。※对于干员搜集，在满上限的情况下
      //   依然可以搜集，但在完成第 11 份时将会停止工作并滞留线索。」
      // 原实现满库即 continue：满库期间进度被整体丢弃，第 11 份永不完成，
      // 客户端也看不到「满库滞留」态。现语义：满库仍继续累积；达阈值即把进度
      // **停在阈值**（= 第 11 份已完成、滞留待入库）并停工；自有库腾出空位后，
      // 下一轮结算把滞留线索入库并自然恢复累积。
      if ((room.ownStock?.length ?? 0) >= OWN_CLUE_LIMIT) {
        if ((room.processPoint ?? 0) >= threshold) {
          room.processPoint = threshold;
          continue; // 已滞留：停工待入库，进度不再累积（时间戳照常推进）
        }
      }
      room.processPoint = (room.processPoint ?? 0) + elapsed * room.speed;
      // 达到 20h 基准阈值 → 真实产出线索（阵营加权含晓歌/U-Official 技能），
      // 支持长离线多份；满库时第 11 份转为「滞留」不再入库（进度停在阈值）
      while (room.processPoint >= threshold) {
        if ((room.ownStock?.length ?? 0) >= OWN_CLUE_LIMIT) {
          room.processPoint = threshold; // 滞留：停工于阈值
          break;
        }
        room.processPoint -= threshold;
        const clue: PlayerBuildingMeetingClue = {
          id: `${draft.status.uid}#${Math.floor(random() * 9000 + 1000)}#${ts}`,
          type: mgr._clueFactionWeighted(draft, room),
          number: 1 + Math.floor(random() * 3),
          uid: String(draft.status.uid),
          name: draft.status.nickName,
          nickNum: String(draft.status.nickNumber),
          chars: [],
          inUse: 0,
          ts: now() + getClueExpiredDays() * 86400,
        };
        room.ownStock.push(clue);
        // 修复（2026-09-09，B6）：定时产出线索同样发信用——原实现只在 getDailyClue 发，
        // 而实际产出走本路径（_accrueMeeting）→ 会客室挂机产出的线索零信用。
        // 数值取 clue_data.outputBasicBonus（实测 20，与 getDailyClue 同口径）。
        draft.status.socialPoint =
          (draft.status.socialPoint ?? 0) +
          (getClueConstant("outputBasicBonus") ?? 20);
        draft.pushFlags.hasClues = 1;
      }
    }
}

  /**
   * 内部方法：人力办公室人脉搜集进度推进
   *
   * 官方模型（PlayerBuildingHire）：processPoint 随时间按有效速度累积
   * （基础 resSpeed × (1 + 进驻干员 hire_* buff)），达到阈值刷新招募位。
   * 修复（2026-08-19）：同会客室——此前无推进逻辑（2222 人力 processPoint 停摆）。
   * 私服简化：进度真实累积供客户端显示；招募位刷新由边界/每日刷新驱动。
   *
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒）
   */
export function _accrueHire(mgr: BuildingManager, draft: Draft<PlayerDataModel>, ts: number) : void {
    for (const [slotId, roomRaw] of Object.entries(draft.building.rooms.HIRE ?? {})) {
      const room = roomRaw as HireRoom;
      if (!room || room.state !== 1) continue;
      const slot = draft.building.roomSlots[slotId];
      const phase = getHirePhase(slot?.level ?? 1);
      const base = phase?.resSpeed;
      if (typeof base !== "number" || base <= 0) continue;
      const chars = mgr._roomCharSources(draft, slot);
      const bonus = roomSpeedBonus(chars, "HIRE", [], mgr._specialCtx(draft));
      room.speed = Math.round(base * (1 + bonus));
      const elapsed = ts - (room.lastUpdateTime || ts);
      if (elapsed <= 0) continue;
      room.lastUpdateTime = ts;
      room.processPoint = (room.processPoint ?? 0) + elapsed * room.speed;
      // 官方联络模型（2026-08-25 对齐，办公室页）：每 12h × 速度系数获得 1 次人脉库存，
      // 上限相位 refreshTimes（3），满则暂停累积（达上限干员暂停工作）；
      // 无人进驻不恢复（官方：无人进驻时刷新次数不恢复）。
      // 修复（2026-09-09）：人脉库存改用官服字段 refreshCount（types-playerdata.ts:2604，
      // 真存档 HIRE 房 refreshCount=2）——原实现读写服务端自建 refreshStock，官服迁移存档
      // 该字段不存在 → 判定为 0，公开招募标签刷新被拒、充能后客户端数字不动。
      // contactSec 仍为服务端扩展字段（进度累计），refreshStock 保留为旧存档回退值。
      if (chars.length === 0) continue;
      const cap = phase?.refreshTimes ?? 3;
      const stock = (room.refreshCount ?? room.refreshStock ?? 0) as number;
      if (stock >= cap) continue;
      room.contactSec =
        (room.contactSec ?? 0) + elapsed * contactSpeedFactor(base, bonus);
      const { gained, remainder } = settleContactProgress(room.contactSec);
      if (gained > 0) {
        const next = Math.min(stock + gained, cap);
        room.refreshCount = next;
        room.refreshStock = next;
        room.contactSec = remainder;
      }
    }
}

  /**
   * 内部方法：工作时间房间统一时间戳推进
   * 所有工作时间房间（state=1）及常驻房间（CONTROL 无 state 字段、恒运行）的
   * lastUpdateTime ← ts——保证 sync 后基建时间戳恒为当前时间（官方每次 sync 推进
   * 全部房间），不因"无生产逻辑"（CONTROL）或"无订单进度"（旧存档 TRADING）而停留旧值。
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒）
   */
export function _touchActiveRooms(mgr: BuildingManager, draft: Draft<PlayerDataModel>, ts: number) : void {
    for (const [rtype, roomsByType] of Object.entries(draft.building.rooms)) {
      for (const roomRaw of Object.values(roomsByType ?? {})) {
        const room = roomRaw as RoomTimestamp;
        if (!room || typeof room.lastUpdateTime !== "number") continue;
        // 工作时间（state=1）或常驻房间（CONTROL 无 state 字段）
        const active = room.state === 1 || rtype === "CONTROL";
        if (active) room.lastUpdateTime = ts;
      }
    }
}

export async function sync(mgr: BuildingManager) {
    const synced = await mgr._player.update(async (draft) => {
      const ts = now();
      // 浮点秒（毫秒精度）：任意两次 sync（≥1ms 间隔）lastApAddTime 必变 →
      // chars 增量恒在（同秒紧邻调用也能正常推进，不会出现空 delta 回归）。
      // 时间基准与 ts 同源（now() + 真实时钟亚秒小数部分）——避免注入式时间基准
      // （测试 mock now()）与 Date.now() 混用导致 elapsed 失真（心情被按真实时钟超发扣成涣散）
      const tsFloat = ts + (Date.now() % 1000) / 1000;
      // 统一 deltaTime 推进（时间基准一次取定，全子系统共用）
      mgr._advanceBuilding(draft, ts, tsFloat);
      // 自动移除会客室线索盒（receiveStock）中已过期的好友赠送线索
      mgr._purgeAllExpiredClues(draft, ts);
      // 修复（高频无限 sync 根因）：客户端基建界面据各房间 completeWorkTime 调度倒计时
      // 与下一次 sync——存档中 completeWorkTime 是过去值（2025）→ 客户端判定"事件已到期
      // 待处理"→ 立即 sync → 服务端不推进 → 无限循环。此处按生产进度把制造站/贸易站/
      // 会客室/招募的 completeWorkTime 推进到未来，客户端据此正常调度。
      mgr._refreshRoomCompletionTimes(draft, ts);
      // event.building = 下一个最近事件时刻（min：下一 4:00/16:00 重置边界 / 最小未来
      // completeWorkTime）——对齐官方：客户端在 event.building 时刻触发下一次 sync。
      mgr._refreshBuildingEventTs(draft, ts);
      // 强制 event.building 每次进 delta（对齐 DoctoratePy 响应恒含 event）：
      // Immer 对未变化的值不产生补丁，而客户端需用它调度下一次 sync——
      // 缺失时沿用缓存旧值（过期边界）→ 立即重同步 → 紧循环。
      // 经 PlayerDataManager.forcePatch 注入（不回写 _playerdata，仅进 delta）
      mgr._player.forcePatch(
        ["event", "building"],
        draft.event.building as number,
      );
      return ts;
    });
    // 产出的追踪事件补发（B12：制造/贸易/加工产出经 _applyItemDelta 直写库存，
    // 绕过 items:get → 勋章与任务不推进）——必须在 update 之外派发
    await mgr._flushGainEvents();
    return synced;
}

  /**
   * 管理员加速基建：将指定玩家的基建整体快进 seconds 秒
   *
   * 语义：把所有基建时间相关字段（劳动力恢复、各房间 lastUpdateTime、
   * 干员心情 lastApAddTime、干员信赖 lastFavorAddTime）统一前移 seconds，
   * 再以真实当前时间调用一次 sync()——统一 deltaTime 推进会把前移的
   * seconds 一次性结算（制造产出/贸易订单/训练进度/心情/信赖/劳动力），
   * 并把各时间戳复位到当前时间，不产生"未来冷却"副作用。
   *
   * 注意：快进受既有上限约束（制造站计划 remainSolutionCnt、贸易站
   * stockLimit、心情 clamp [0,8640000]、劳动力封顶 maxValue），符合
   * "手动补 N 秒基建产出"的管理员语义。
   *
   * @param seconds - 快进秒数（正整数；内部向下取整，至少为 1）
   * @returns 结算后的当前时间戳（sync 返回值）
   */
export async function advance(mgr: BuildingManager, seconds: number) : Promise<number> {
    const secs = Math.max(1, Math.floor(seconds));
    // 第一步：把基建各子系统时间基准统一前移 secs（使其早于当前时间）
    await mgr._player.update(async (draft) => {
      // 劳动力恢复时间戳前移
      const labor = draft.building.status?.labor;
      if (labor && typeof labor.lastUpdateTime === "number") {
        labor.lastUpdateTime -= secs;
      }
      // 各房间（制造/贸易/训练/会客/人力等）生产时间戳前移——
      // 只前移工作时间（state=1）或常驻（CONTROL）房间，停工房间保持当前基准，
      // 避免下次开工时凭空多结算 seconds（与 _touchActiveRooms 的 active 判定一致）
      for (const [rtype, roomsByType] of Object.entries(draft.building.rooms ?? {})) {
        for (const roomRaw of Object.values(roomsByType ?? {})) {
          const room = roomRaw as RoomTimestamp;
          if (!room || typeof room.lastUpdateTime !== "number") continue;
          const active = room.state === 1 || rtype === "CONTROL";
          if (active) room.lastUpdateTime -= secs;
        }
      }
      // 干员心情/信赖结算基准前移
      for (const ch of Object.values(draft.building.chars ?? {})) {
        if (ch && typeof ch.lastApAddTime === "number") {
          ch.lastApAddTime -= secs;
        }
        const raw = ch as CharWithFavor;
        if (typeof raw.lastFavorAddTime === "number") {
          raw.lastFavorAddTime -= secs;
        }
      }
    });
    // 第二步：以真实当前时间结算——统一 deltaTime 推进前移的秒数并复位时间戳
    return mgr.sync();
}

  /**
   * 内部方法：训练室进度推进
   * trainee.processPoint += 流逝时间 × trainee.speed × (1 + 教官训练 buff 加成)
   *（speed 为训练速度系数：官方空态=1、训练中 ≈1.x（2222 存档 1.65），教官 train_*
   *  buff 在 (1 + trainBonus) 项另行计入——修复后 upgradeSpecialization/assignChar
   *  不再硬编码 1000，见上。）
   *
   * 修复（2026-08-19）：trainee.state 判定错误——官方 PlayerBuildingTraineeState 枚举
   * EMPTY=0/TRAINING=1/OUTOFDATE=2/WAITING=3，训练中为 **state=1**；原实现 `state !== 3`
   * 把 WAITING(3) 当训练态 → 真实存档（state=1）训练进度从不推进（2222 空弦 processPoint 停摆）。
   * 完成（state=2 OUTOFDATE）仍由客户端计时驱动 completeUpgradeSpecialization。
   *
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒），elapsed = ts - lastUpdateTime
   */
export function _accrueTraining(mgr: BuildingManager, draft: Draft<PlayerDataModel>, ts: number) : void {
    const trainingRoom = draft.building.rooms.TRAINING;
    for (const roomSlotId of Object.keys(trainingRoom)) {
      const room = trainingRoom[roomSlotId];
      const trainee = room?.trainee;
      if (!trainee || trainee.charInstId <= 0 || trainee.state !== 1) continue;
      // 教官（slot charInstIds[0] 或 room.trainer）的 train_* buff 加速训练
      const slot = draft.building.roomSlots[roomSlotId];
      const trainerId =
        room.trainer?.charInstId ?? slot?.charInstIds?.[0] ?? -1;
      const trainerSrc = trainerId > 0 ? mgr._charSource(draft, trainerId) : null;
      const trainBonus = roomSpeedBonus(
        trainerSrc ? [trainerSrc] : [],
        "TRAINING",
        [],
      );
      // 协助位非涣散基础 +5%（官方，2026-08-25 对齐）叠加教官 train_* 技能
      const assistBase =
        trainerSrc && !isDispersedAp(trainerSrc.ap) ? SPEC_ASSIST_BASE_BONUS : 0;
      const elapsed = ts - (room.lastUpdateTime || ts);
      if (elapsed <= 0) continue;
      room.lastUpdateTime = ts;
      trainee.processPoint =
        (trainee.processPoint ?? 0) +
        elapsed * (trainee.speed ?? 1) * (1 + assistBase + trainBonus);
      // 达到训练时长（maxPoint = lvlUpTime，新模型）→ 待领取（OUTOFDATE），不超额；
      // 旧存档无 maxPoint → 保持原行为（领取由 completeUpgradeSpecialization 驱动）
      const maxPoint = (trainee as TraineeWithMaxPoint).maxPoint ?? 0;
      if (maxPoint > 0 && trainee.processPoint >= maxPoint) {
        trainee.processPoint = maxPoint;
        trainee.state = 2; // OUTOFDATE 待领取
      }
    }
}

  /**
   * 会客室干员体力（AP）随时间累积
   * 官方模型：building.chars[].ap += 流逝时间 × changeScale（会客室干员 changeScale>0
   * 恢复体力；工作干员 changeScale<0 消耗）；clamp 到 [0, 8640000]，更新 lastApAddTime。
   *
   * lastApAddTime 写**浮点秒（毫秒精度）**：官方每次基建请求都下发 chars 增量
   * （抓包 res_1074 含 308 chars）——秒级整型在客户端紧邻重拉（同一秒内多次调用）
   * 时无法变化 → 空 delta → 会客室会话不推进 → 无限重复获取；
   * 浮点秒保证任意两次调用（≥1ms 间隔）lastApAddTime 必变 → 增量恒在。
   * @param draft - mutative 可写草稿
   * @param nowSec - 当前时间基准（浮点秒，毫秒精度；缺省取 Date.now()/1000）
   */
export function _accrueCharAp(mgr: BuildingManager, draft: Draft<PlayerDataModel>, nowSec?: number) : void {
    const ts = nowSec ?? Date.now() / 1000; // 浮点秒（毫秒精度）
    let recovered = 0;
    for (const ch of Object.values(draft.building.chars ?? {})) {
      const last =
        typeof ch.lastApAddTime === "number" ? ch.lastApAddTime : ts;
      const elapsedSec = ts - last;
      if (elapsedSec <= 0) continue;
      ch.lastApAddTime = ts;
      const scale = ch.changeScale ?? 0;
      if (scale !== 0) {
        const before = ch.ap ?? 0;
        ch.ap = Math.min(Math.max((ch.ap ?? 0) + elapsedSec * scale, 0), 8640000);
        if (ch.ap > before) recovered += 1;
      }
    }
    // 修复：RecoverCharBaseAp 任务事件从未 emit → 恢复干员心情任务永不推进；
    // 本次有干员恢复心情时计 1 次
    if (recovered > 0) {
      void mgr._trigger.emit("RecoverCharBaseAp", [{ count: recovered }]);
    }
}

  /**
   * 内部方法：干员暖机工时（在岗累积工作时间）随时间推进。
   *
   * 官方语义（贸易站页：裁缝/手工艺品 α/β 概率改写需累积工作 3/5 小时，
   * 干员离岗/换工位累积时间清零）：仅工作区在岗干员累积；离岗（含宿舍/中枢）
   * 或换房间即清零。存档扩展字段（服务端自洽，旧存档惰性初始化）：
   * building.chars[].warmupSec（累积秒）/ warmupTs（上次推进时间，秒）/
   * warmupSlot（累积中的房间槽位，换岗判定）。
   *
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒）
   */
export function _accrueWarmup(mgr: BuildingManager, draft: Draft<PlayerDataModel>, ts: number) : void {
    // 工作区在岗干员 → 槽位（宿舍/控制中枢不计暖机：休息/无暖机消费技能）
    const workSlotOf = new Map<number, string>();
    for (const [slotId, slot] of Object.entries(draft.building.roomSlots)) {
      if (!slot || slot.roomId === "DORMITORY" || slot.roomId === "CONTROL") continue;
      for (const instId of slot?.charInstIds ?? []) {
        if (instId > 0) workSlotOf.set(instId, slotId);
      }
    }
    for (const [instIdStr, chRaw] of Object.entries(draft.building.chars ?? {})) {
      const ch = chRaw as CharWithWarmup;
      const last = typeof ch.warmupTs === "number" ? ch.warmupTs : ts;
      const elapsed = ts - last;
      ch.warmupTs = ts;
      const slotId = workSlotOf.get(Number(instIdStr));
      if (!slotId) {
        // 离岗（含进驻宿舍/中枢/未进驻）→ 累积清零（官方：离岗清零）
        ch.warmupSec = 0;
        ch.warmupSlot = "";
        continue;
      }
      if (ch.warmupSlot !== slotId) {
        // 换工位/换房间 → 累积清零；本次 elapsed 属于旧岗位，一并丢弃（官方：换工位清零）
        ch.warmupSec = 0;
        ch.warmupSlot = slotId;
      } else if (elapsed > 0) {
        ch.warmupSec = (ch.warmupSec ?? 0) + elapsed;
      }
    }
}

  /**
   * 内部方法：干员信赖（favorPoint）随时间累积
   *
   * 官方机制：进驻干员（在岗）+ 助战干员按小时累积信赖（basicFavorPerDay 每日量
   * ÷ 24 为每小时量）。修复（2026-08-23）：原实现仅在手动 gainIntimacy /
   * gainAllIntimacy / gainAssistIntimacy 时发放固定量，sync 推进不结算 → 长时间
   * 在线信赖停滞（需要手动点数），与官方「随时间自动累积」语义不符。
   *
   * 现按流逝时间持续结算：duration = ts - lastFavorAddTime，信赖增量 =
   * duration × (basicFavorPerDay / 24) / 3600；只对「在岗 + 助战」干员累积，未进驻
   * 干员不结算；同步更新 troop.chars 与 charGroup。lastFavorAddTime 复用浮点秒
   * （毫秒精度，任意两次 sync ≥1ms 必变 → 信赖增量恒在）。
   *
   * @param draft - Immer 草稿
   * @param nowSec - 当前时间基准（浮点秒，毫秒精度；缺省取 Date.now()/1000）
   */
export function _accrueFavor(mgr: BuildingManager, draft: Draft<PlayerDataModel>, nowSec?: number) : void {
    const ts = nowSec ?? Date.now() / 1000; // 浮点秒（毫秒精度）
    const perDay = getBuildingConstant("basicFavorPerDay") ?? 720;
    const perHour = Math.max(perDay / 24, 1); // 每小时信赖量（默认 720/24 = 30）
    const perSec = perHour / 3600; // 每秒信赖量
    if (perSec <= 0) return;
    // 收集「在岗 + 助战」干员（去重），未进驻的干员不结算
    const targets = new Set<number>();
    for (const slot of Object.values(draft.building.roomSlots)) {
      for (const id of slot?.charInstIds ?? []) {
        if (id && id > 0) targets.add(id);
      }
    }
    for (const id of draft.building.assist ?? []) {
      if (id && id > 0) targets.add(id);
    }
    for (const instId of targets) {
      const ch = draft.building.chars[String(instId)];
      if (!ch) continue;
      // 非官方扩展字段：记录上次信赖结算时间（浮点秒），缺省用当前时间（首次引入）
      const raw = ch as CharWithFavor;
      const last =
        typeof raw.lastFavorAddTime === "number" ? raw.lastFavorAddTime : ts;
      const elapsedSec = ts - last;
      // 无论是否产生增量都推进基准时间（首次缺省用当前时间 → 下次才从该基准结算）
      raw.lastFavorAddTime = ts;
      if (elapsedSec <= 0) continue;
      const gain = elapsedSec * perSec;
      if (gain <= 0) continue;
      mgr._addFavor(draft, instId, gain);
    }
}
