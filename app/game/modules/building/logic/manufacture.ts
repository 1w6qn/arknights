import { ItemBundle } from "@excel/excel";
/**
 * 基建分区逻辑：制造站与加工站（生产结算/配方切换/合成分解）
 *
 * 由 BuildingManager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { BuildingManager } from "../logic";
import excel from "@excel/excel";
import { now } from "@utils/time";
import { Draft } from "mutative";
import { PlayerDataModel } from "../../../kernel/playerdata";
import { PlayerBuildingDIYSolution } from "../../../kernel/playerdata";
import { headcountMoodRelief, isDispersedAp, warmupHoursOf, MAX_AP } from "../mood";
import { getManufactFormula, getWorkshopFormula, getBuildingConstant, getRoomPhase, getGoldRate, getManufactPhase, getDormPhase, getFurnitureInfo, getRoomMaxLevel, getManufactFormulaType, getRoomElectricity, getMeetingPhase, getHirePhase, getClueExpiredDays, getMessageLeaveBoardConst, getManufactureInputCapacity } from "@excel/building_excel";
import {
  isFormulaUnlocked,
  isDiamondStrategyUnlocked,
  FormulaUnlockCtx,
} from "../unlocks";
import { random } from "@utils/random";

  /**
   * 内部方法：制造站生产时间推进（deltaTime 驱动）
   * processPoint += 流逝时间 × 有效容量；达到 costPoint 产出 1 方案（计划剩余数钳制）。
   *
   * 修复：基建生产不随时间累积、生产速度 buff 无效的问题。
   * 官方模型：房间有效容量（基础容量 × (1 + 干员技能加成 + 控制中枢全局加成)）× 流逝时间
   * → processPoint，每满 formula.costPoint 产出 1 方案（remainSolutionCnt 递减、outputSolutionCnt 递增）。
   * 用房间自维护的 lastUpdateTime 计算流逝（生成器的 saveTime/tailTime 为相对值，不可用）。
   *
   * @param draft - mutative 可写草稿
   * @param roomSlotId - 制造站槽位 ID
   * @param ts - 当前时间基准（秒），elapsed = ts - lastUpdateTime
   */
export function _accrueManufacture(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    roomSlotId: string,
    ts: number,) : void {
    const room = draft.building.rooms.MANUFACTURE[roomSlotId];
    if (!room || room.state !== 1) return;
    const formula = getManufactFormula(room.formulaId);
    if (!formula) return;
    const costPoint = formula.costPoint ?? 0;
    // 有效容量回写客户端显示字段（仓库容量语义）；同时从回写的 buff.speed 取加成
    const capacity = mgr._roomCapacity(draft, roomSlotId, formula);
    if (costPoint <= 0 || capacity <= 0) return;
    // 修复（2026-08-26 dc-fix，生产速度过快）：官方生产速率 = 1 × (1+加成) 点/秒，
    // 阈值 costPoint = 配方基础秒数（如赤金 4320=72 分钟）——2222 真存档实测：
    // 剩余进度 1481.3 ÷ 剩余 833s = 1.778 = 1 + buff.speed(0.78) ✓。
    // 原实现按 capacity(54)×(1+加成) 点/秒累积 → 快约 54 倍（制造站几分钟出一批）。
    const speedBonus = room.buff?.speed ?? 0;
    // 修复：计划已耗尽（remain ≤ 0）即停止生产——官方计划完成后房间停摆待收取；
    // 原实现 remain=0 时跳过钳制 → 产出无上限累积（制造站赤金数量异常）
    const remain = room.remainSolutionCnt ?? 0;
    if (remain <= 0) return;
    const elapsed = ts - (room.lastUpdateTime || ts);
    if (elapsed <= 0) return;
    room.lastUpdateTime = ts;
    room.processPoint = (room.processPoint ?? 0) + elapsed * (1 + speedBonus);
    let produced = Math.floor(room.processPoint / costPoint);
    if (produced <= 0) return;
    // 修复：先按 remain 钳制再扣进度——原实现先扣全部 produced 再钳制，
    // 计划完成时超出部分的进度被整体销毁（如 produced=10、remain=3 → 7 方案进度蒸发）
    produced = Math.min(produced, remain);
    room.processPoint -= produced * costPoint;
    room.remainSolutionCnt = remain - produced;
    room.outputSolutionCnt = (room.outputSolutionCnt ?? 0) + produced;
}

  /**
   * 制造站结算
   * 参考实现：根据配方将产出物品加入背包，并消耗对应材料，重置制造站状态
   * @param args - 包含 roomSlotId 的参数对象
   */
export async function settleManufacture(mgr: BuildingManager, args: { roomSlotIdList?: string[]; supplement?: number }) {
    // 修复：官方字段为 roomSlotIdList（数组），原实现读取单值 roomSlotId →
    // 客户端请求解构不到 → 空 delta → 客户端"无法更新制造站状态"
    const list = args.roomSlotIdList ?? [];
    // 修复：CS BuildingSettleManufactRequest.supplement = 免费生产自动补货次数。
    // 原实现忽略该字段：免费配方（F_EXP/F_GOLD，costs 为空）计划耗尽即停止，
    // 玩家需反复手动 changeManufactureSolution 补货。客户端每次收获会带上
    // supplement>0，据此对免费生产方案自动回填计划、继续保持生产。
    const supplement = args.supplement ?? 0;
    let producedTotal = 0;
    await mgr._player.update(async (draft) => {
      for (const roomSlotId of list) {
        // 先推进时间累积的产出再结算
        mgr._accrueManufacture(draft, roomSlotId, now());
        const room = draft.building.rooms.MANUFACTURE[roomSlotId];
        producedTotal += room?.outputSolutionCnt ?? 0;
        await mgr._settleManufactureInternal(draft, roomSlotId);
        // 收获后状态（防御：非法 roomSlotId 直接跳过不 500）
        const roomAfter = draft.building.rooms.MANUFACTURE[roomSlotId];
        if (!roomAfter) continue;
        if ((roomAfter.remainSolutionCnt ?? 0) > 0) {
          // 修复：计划未耗尽时保留配方继续生产（原实现清空 state/formulaId →
          // 客户端"会清空当前计划"）；仅重置已收获的产出与进度
          roomAfter.outputSolutionCnt = 0;
          roomAfter.processPoint = 0;
          roomAfter.lastUpdateTime = now();
        } else {
          // 计划耗尽：若为免费生产配方且请求带 supplement → 自动补货，否则停止清空
          const formula = getManufactFormula(roomAfter.formulaId);
          // 仅配方存在且无材料成本才算"免费生产"——未知配方（数据缺失）不视为免费
          const isFree =
            !!formula &&
            (formula.costs ?? []).every((c) => (c?.count ?? 0) <= 0);
          if (isFree && supplement > 0) {
            // 免费生产自动补货：把刚收获的产量回填为剩余计划，继续保持生产
            const harvested = roomAfter.outputSolutionCnt || 0;
            // 修复（2026-09-09，B4）：回填后同样受 99 份上限约束
            roomAfter.remainSolutionCnt = Math.min(
              getManufactureInputCapacity(),
              Math.max(roomAfter.remainSolutionCnt ?? 0, harvested),
            );
            roomAfter.outputSolutionCnt = 0;
            roomAfter.processPoint = 0;
            roomAfter.lastUpdateTime = now();
            roomAfter.completeWorkTime = -1;
          } else {
            // 非免费配方 / 未请求补货：停止生产并清空
            roomAfter.state = 0;
            roomAfter.formulaId = "";
            roomAfter.lastUpdateTime = now();
            roomAfter.completeWorkTime = -1;
            roomAfter.remainSolutionCnt = 0;
            roomAfter.outputSolutionCnt = 0;
            roomAfter.processPoint = 0;
          }
        }
      }
    });
    // 修复：BuildingManufactureProductTimes 勋章事件从未 emit → 制造勋章永不推进
    if (producedTotal > 0) {
      await mgr._trigger.emit("BuildingManufactureProductTimes", [
        { count: producedTotal },
      ]);
    }
    // 产出的追踪事件补发（B12）：制造产出经 _applyItemDelta 直写库存，
    // 绕过 items:get → 勋章/任务不推进
    await mgr._flushGainEvents();
    // 返回结算的房间数（CS BuildingSettleManufactResponse.supplement）
    return list.length;
}

  /**
   * 内部方法：执行制造站结算的材料/产出更新（Excel 驱动——查 manufactFormulas）
   * 产出：itemId × count × outputSolutionCnt；消耗：costs（MATERIAL 扣 inventory / GOLD 扣 status.gold）
   * @param draft - Immer 可写草稿
   * @param roomSlotId - 房间槽位 ID
   */
export async function _settleManufactureInternal(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    roomSlotId: string,) {
    const room = draft.building.rooms.MANUFACTURE[roomSlotId];
    if (!room) return;
    const outputSolutionCnt = room.outputSolutionCnt;
    const formulaIdStr = String(room.formulaId ?? "");
    if (outputSolutionCnt === 0 || !formulaIdStr) return;
    const formula = getManufactFormula(formulaIdStr);
    if (!formula) return; // 配方不存在（数据版本错位）——容错跳过

    // 产出：itemId × count × 已产出方案数
    const gainCount = (formula.count ?? 1) * outputSolutionCnt;
    mgr._applyItemDelta(draft, formula.itemId, gainCount);
    // 修复：ManufactureItem 任务事件从未 emit → 制造物品类任务永不推进
    //（模板 0/2 读 item、模板 1 读 count，一并携带）
    await mgr._trigger.emit("ManufactureItem", [
      { item: excel.makeItem(formula.itemId, gainCount), count: gainCount },
    ]);

    // 消耗：costs（MATERIAL 扣 inventory / GOLD 扣 status.gold）
    // 修复：余额校验——材料/金币不足时按比例只结算可承担部分，避免负库存/负金币
    let affordable = outputSolutionCnt;
    for (const cost of formula.costs ?? []) {
      const per = cost.count ?? 0;
      if (per <= 0) continue;
      const need = per * outputSolutionCnt;
      const have =
        cost.type === "GOLD"
          ? draft.status.gold
          : draft.inventory[cost.id] || 0;
      if (need > 0 && have < need) {
        affordable = Math.min(affordable, Math.floor(have / per));
      }
    }
    if (affordable <= 0) {
      // 材料不足：回退产出（下轮 settle 再补扣），并恢复已产出方案到 remain——
      // 原实现只回退 inventory，outputSolutionCnt 残留被调用方清零 → 已产出货物丢失
      mgr._applyItemDelta(draft, formula.itemId, -gainCount);
      room.remainSolutionCnt =
        (room.remainSolutionCnt ?? 0) + room.outputSolutionCnt;
      room.outputSolutionCnt = 0;
      return;
    }
    const settleCount = Math.min(outputSolutionCnt, affordable);
    if (settleCount !== outputSolutionCnt) {
      // 部分结算：产出与消耗都按可承担数
      mgr._applyItemDelta(
        draft,
        formula.itemId,
        -(gainCount - (formula.count ?? 1) * settleCount),
      );
      room.outputSolutionCnt = outputSolutionCnt - settleCount;
      room.remainSolutionCnt = (room.remainSolutionCnt ?? 0) + (outputSolutionCnt - settleCount);
    }
    for (const cost of formula.costs ?? []) {
      if (cost.type === "GOLD") {
        mgr._applyGoldDelta(draft, -(cost.count * settleCount));
      } else {
        mgr._applyItemDelta(draft, cost.id, -(cost.count * settleCount));
      }
    }
}

  /**
   * 更换制造方案（客户端"收获后一键补货"入口）
   * 先推进并结算当前已产出的方案，再切换到新配方。
   * 返回 { change } 对齐官方 BuildingChangeManufactResponse（抓包 6 例均为 false——
   * 该字段为服务端确认标识，补货/换配方一律 false；方案本身按请求生效）。
   * @param args - 包含 roomSlotId、targetFormulaId、solutionCount 的参数对象
   */
export async function changeManufactureSolution(mgr: BuildingManager, args: {
    roomSlotId: string;
    targetFormulaId: string;
    solutionCount: number;
  }) : Promise<{ change: boolean }> {
    const { roomSlotId, targetFormulaId, solutionCount } = args;
    await mgr._player.update(async (draft) => {
      const room = draft.building.rooms.MANUFACTURE[roomSlotId];
      if (!room) return;
      // 官方配方解锁校验（曾达等级 + 房间数 + 关卡星）——未解锁拒绝，不结算不扣资源
      const formula = getManufactFormula(targetFormulaId);
      if (formula && !isFormulaUnlocked(formula, mgr._unlockCtx(draft))) return;
      // 先推进并结算当前已产出的方案
      mgr._accrueManufacture(draft, roomSlotId, now());
      mgr._settleManufactureInternal(draft, roomSlotId);
      // 切换到新配方（修复：产出随时间累积而非立即满产——
      // remainSolutionCnt 为目标批次数，outputSolutionCnt 从 0 开始由 _accrueManufacture 推进）
      room.state = 1;
      room.formulaId = targetFormulaId;
      room.lastUpdateTime = now();
      room.completeWorkTime = -1;
      // 修复（2026-09-09，B4）：制造站单次排产份数上限 = building_data.manufactInputCapacity（99）——
      // 原实现 `Math.max(0, solutionCount)` 无上限，可排 999999 份。
      // 官服存档佐证：制造站 remainSolutionCnt 73 + outputSolutionCnt 26 = 99（恰为上限）。
      room.remainSolutionCnt = Math.min(
        getManufactureInputCapacity(),
        Math.max(0, Math.floor(solutionCount ?? 0)),
      );
      room.outputSolutionCnt = 0;
      room.processPoint = 0;
    });
    // 切换配方前会先结算已产出（B12 产出追踪事件补发）
    await mgr._flushGainEvents();
    return { change: false };
}

  /**
   * 更换自定义方案
   *
   * 修复：舒适度由服务端按方案内家具 Excel 数据计算（BuildingData.customData
   * .furnitures[].comfort 求和）——原实现读 room.comfort 静态值，客户端摆放
   * 新家具后氛围不变（宿舍恢复/心情档位不受 DIY 影响）。
   *
   * @param args - 包含 roomSlotId 和 solution 的参数对象
   */
export async function changeDiySolution(mgr: BuildingManager, args: { roomSlotId: string; solution: PlayerBuildingDIYSolution }) {
    const { roomSlotId, solution } = args;
    let comfort = 0;
    await mgr._player.update(async (draft) => {
      // 会客室（slot_36）单独处理
      if (roomSlotId === "slot_36") {
        draft.building.rooms.MEETING[roomSlotId].diySolution = solution;
        return;
      }
      // 其他房间：通过 roomSlots 找到房间类型
      const slot = draft.building.roomSlots[roomSlotId];
      if (slot) {
        const roomType = slot.roomId as keyof PlayerDataModel["building"]["rooms"];
        const room = draft.building.rooms[roomType];
        if (room && room[roomSlotId]) {
          const target = room[roomSlotId] as {
            diySolution?: PlayerBuildingDIYSolution;
            comfort?: number;
          };
          target.diySolution = solution;
          // 修复：舒适度服务端计算——墙纸/地板/地毯/其他家具 comfort 求和
          const sol = solution as {
            wallPaper?: string;
            floor?: string;
            carpet?: { id: string }[];
            other?: { id: string }[];
          };
          const ids = [
            sol?.wallPaper,
            sol?.floor,
            ...(sol?.carpet ?? []).map((f) => f?.id),
            ...(sol?.other ?? []).map((f) => f?.id),
          ].filter((id): id is string => !!id);
          comfort = ids.reduce((sum, id) => {
            const info = getFurnitureInfo(id);
            return sum + (info?.comfort ?? 0);
          }, 0);
          target.comfort = comfort;
        }
      }
    });
    // 修复：DiyComfort 任务事件从未 emit → DIY 舒适度任务永不推进
    if (roomSlotId !== "slot_36" && comfort > 0) {
      await mgr._trigger.emit("DiyComfort", [{ comfort }]);
    }
}

  /**
   * 加工站合成（Excel 驱动——查 workshopFormulas）
   * 消耗 costs（MATERIAL 扣 inventory / GOLD 扣金币）+ goldCost + 干员心情（apCost），
   * 产出 itemId×count×times；extraOutcomeRate 概率触发 extraOutcomeGroup 加权副产物。
   *
   * 修复（2026-08-14 经济系统补全）：
   * 1. 干员心情消耗——公式 apCost 为每次合成的心情成本（1 心情点 = manpowerDisplayFactor
   *    =360000 raw AP；模板公式 1 apCost=360000 = 1 点/次），从进驻加工站干员的
   *    building.chars[].ap 扣减，心情不足时按可承担次数合成；
   * 2. 工坊 bonus（ws_bonus）——进驻干员技能（如夜半「因果/业报」：累积 N 点必定产出
   *    一次副产品）：status.workshop.bonus[bonusId]=[curPoint,totalPoint] 逐次合成推进，
   *    满格后 bonusActive=1，下一次合成必定触发副产物并重置计数。
   *
   * @param args - 包含 roomSlotId、times、formulaId（客户端传，缺失时回退房间 formulaId）的参数对象
   * @returns 合成结果对象（包含 type/id/count）
   */
export async function workshopSynthesis(mgr: BuildingManager, args: {
    roomSlotId?: string;
    times: number;
    formulaId?: string;
  }) {
    const { roomSlotId, times, formulaId } = args;
    // 修复：times 必须为正整数——小数（0.5 等）会产出小数物品/半价合成，损坏库存
    if (typeof times !== "number" || !Number.isInteger(times) || times <= 0) {
      return null;
    }
    let resultItem: { type: string; id: string; count: number } | null = null;
    let synGroup: string | undefined;
    await mgr._player.update(async (draft) => {
      const roomFormulaId =
        formulaId ??
        (roomSlotId
          ? draft.building.rooms.MANUFACTURE[roomSlotId]?.formulaId
          : undefined);
      const formula = getWorkshopFormula(roomFormulaId);
      if (!formula) return; // 配方不存在（数据版本错位/制造配方 ID）——容错跳过
      // 官方配方解锁校验（加工站等级 + 关卡星）——未解锁拒绝，不扣资源不产出
      if (!isFormulaUnlocked(formula, mgr._unlockCtx(draft))) return;
      synGroup = formula.formulaType as string | undefined;

      // 修复：余额校验——材料/金币不足时按可承担次数合成，避免负库存/负金币
      const totalGoldCost = (formula.goldCost ?? 0) * times;
      let affordable = times;
      for (const cost of formula.costs ?? []) {
        const per = cost.count ?? 0;
        if (per <= 0) continue;
        const have =
          cost.type === "GOLD"
            ? draft.status.gold
            : draft.inventory[cost.id] || 0;
        if (have < per * times) {
          affordable = Math.min(affordable, Math.floor(have / per));
        }
      }
      if (totalGoldCost > 0 && draft.status.gold < totalGoldCost) {
        affordable = Math.min(affordable, Math.floor(draft.status.gold / (formula.goldCost ?? 1)));
      }
      // 干员心情（体力）余额：apCost 为每次合成的心情成本（raw AP），不足时按可承担次数
      const workshopChar = mgr._workshopChar(draft);
      // 官方：无进驻干员时副产物概率锁定 0%；涣散干员技能失效同样不产副产物。
      // 注意：按扣减前心情判定——本次合成可承担即视为非涣散（扣减后才到 0 不影响本次）
      const canBonus = !!workshopChar && !isDispersedAp(workshopChar.ap);
      const apCostPer = formula.apCost ?? 0;
      if (workshopChar && apCostPer > 0) {
        const charAp = workshopChar.ap ?? 0;
        affordable = Math.min(affordable, Math.floor(charAp / apCostPer));
      }
      if (affordable <= 0) return;
      const times2 = affordable;

      // 消耗：costs（MATERIAL 扣 inventory / GOLD 扣金币）
      for (const cost of formula.costs ?? []) {
        if (cost.type === "GOLD") {
          mgr._applyGoldDelta(draft, -(cost.count * times2));
        } else {
          mgr._applyItemDelta(draft, cost.id, -(cost.count * times2));
        }
      }
      // 消耗：goldCost（合成手续费）
      if (formula.goldCost) {
        mgr._applyGoldDelta(draft, -(formula.goldCost * times2));
      }
      // 消耗：干员心情（按实际合成次数）
      if (workshopChar && apCostPer > 0) {
        workshopChar.ap = Math.max(0, (workshopChar.ap ?? 0) - apCostPer * times2);
      }
      // 产出（主产物）
      mgr._applyItemDelta(
        draft,
        formula.itemId,
        (formula.count ?? 1) * times2,
      );

      // 工坊 bonus（ws_bonus）：进驻干员技能累积“因果/业报”点数 → 必定副产物
      const ws = (draft.building.status.workshop ??= {
        bonusActive: 0,
        bonus: {},
      });
      const wsBonusIds = canBonus
        ? mgr._workshopBonusIds(draft, workshopChar)
        : [];
      const formulaType = formula.formulaType as string | undefined;

      // 副产物：逐次合成处理 ws_bonus 累计/触发 + 概率副产物
      for (let i = 0; i < times2; i++) {
        const charged = ws.bonusActive === 1;
        let guaranteed = false;
        for (const bonusId of wsBonusIds) {
          if (formulaType && !mgr._wsBonusMatches(bonusId, formulaType)) continue;
          const entry = ws.bonus[bonusId] ?? (ws.bonus[bonusId] = [0, mgr._wsBonusThreshold(bonusId)]);
          const total = Math.max(1, entry[1] ?? 1);
          const cur = entry[0] ?? 0;
          if (charged) {
            // 蓄力状态：本次合成必定出副产物；首个满格 bonus 重置计数
            if (!guaranteed) {
              guaranteed = true;
              ws.bonus[bonusId] = [0, total];
            } else {
              ws.bonus[bonusId] = [cur + 1 >= total ? total : cur + 1, total];
            }
            ws.bonusActive = 0;
          } else {
            const next = cur + 1;
            if (next >= total) {
              // 满格蓄力：下一次合成必定副产物
              ws.bonus[bonusId] = [total, total];
              ws.bonusActive = 1;
            } else {
              ws.bonus[bonusId] = [next, total];
            }
          }
        }
        // 副产物（概率 or 蓄力必定；无干员/涣散时锁定 0%）
        if (formula.extraOutcomeGroup?.length) {
          const shouldRoll =
            canBonus &&
            (guaranteed ||
              (!!formula.extraOutcomeRate && random() < formula.extraOutcomeRate));
          if (shouldRoll) {
            const pool = formula.extraOutcomeGroup as {
              weight?: number;
              itemId: string;
              itemCount: number;
            }[];
            const total = pool.reduce((s, g) => s + (g.weight ?? 1), 0);
            let roll = random() * total;
            for (const g of pool) {
              roll -= g.weight ?? 1;
              if (roll <= 0) {
                mgr._applyItemDelta(draft, g.itemId, g.itemCount ?? 1);
                // 修复：WorkshopExBonus 任务事件从未 emit → 工坊副产物任务永不推进
                await mgr._trigger.emit("WorkshopExBonus", []);
                break;
              }
            }
          }
        }
      }

      resultItem = {
        type: "MATERIAL",
        id: formula.itemId,
        count: times2,
      };
      // 修复：WorkshopSynthesis 任务事件从未 emit → 工坊合成类任务永不推进
      await mgr._trigger.emit("WorkshopSynthesis", [
        {
          item: excel.makeItem(formula.itemId, (formula.count ?? 1) * times2),
        },
      ]);
    });
    // 修复：BuildingWorkshopSynthesisGroupByID 勋章事件从未 emit →
    // 工坊合成组勋章（F_EVOLVE 等）永不推进
    if (synGroup) {
      await mgr._trigger.emit("BuildingWorkshopSynthesisGroupByID", [
        { groupId: synGroup },
      ]);
    }
    // 加工副产品/产出的追踪事件补发（B12）
    await mgr._flushGainEvents();
    return resultItem;
}

  /** 内部方法：加工站进驻干员（首个有效干员；未进驻返回 null） */
export function _workshopChar(mgr: BuildingManager, draft: Draft<PlayerDataModel>,) : { ap?: number; charId: string } | null {
    for (const slot of Object.values(draft.building.roomSlots)) {
      if (slot?.roomId !== "WORKSHOP") continue;
      for (const instId of slot.charInstIds ?? []) {
        if (instId > 0) {
          const ch = draft.building.chars?.[String(instId)];
          if (ch?.charId) return ch as { ap?: number; charId: string };
        }
      }
    }
    return null;
}

  /** 内部方法：进驻干员的工坊 bonus 列表（BuildingData.workshopBonus[charId]） */
export function _workshopBonusIds(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    workshopChar: { charId: string } | null,) : string[] {
    if (!workshopChar?.charId) return [];
    return excel.BuildingData?.workshopBonus?.[workshopChar.charId] ?? [];
}

  /** 内部方法：ws_bonus 阈值（存档条目缺失时按 id 解析：ws_bonus1_40 → 40） */
export function _wsBonusThreshold(mgr: BuildingManager, bonusId: string) : number {
    const m = /^ws_bonus\d+_(\d+)$/.exec(bonusId);
    return m ? parseInt(m[1], 10) : 16;
}

  /** 内部方法：ws_bonus 是否匹配配方类型（对齐 buff targets，如 F_BUILDING/F_EVOLVE…） */
export function _wsBonusMatches(mgr: BuildingManager, bonusId: string, formulaType: string) : boolean {
    const tier = /^ws_bonus(\d+)_/.exec(bonusId)?.[1];
    if (!tier) return true;
    const buff = excel.BuildingData?.buffs?.[`workshop_formula_bonus${tier}[000]`];
    const targets = buff?.targets;
    if (!Array.isArray(targets) || targets.length === 0) return true;
    return targets.includes(formulaType);
}

  /**
   * 加工站分解
   * 分解家具为木材（30012），私服简化固定产出
   *
   * 修复：CS BuildingWorkshopDecompositionRequest 字段为 furniId/times——
   * 原实现读 furnitureId/count（客户端不发）→ 空 delta；现兼容两种形态。
   *
   * @param args - 包含 furnitureId（或 furniId）和 count（或 times）的参数对象
   */
export async function workshopDecomposition(mgr: BuildingManager, args: {
    furnitureId?: string;
    furniId?: string;
    count?: number;
    times?: number;
  }) {
    const furnitureId = args.furnitureId ?? args.furniId;
    const count = args.count ?? args.times;
    if (!furnitureId || typeof count !== "number" || count <= 0) return;
    return await mgr._player.update(async (draft) => {
      const furn = draft.building.furniture[furnitureId];
      if (!furn || furn.count < count) return;
      furn.count -= count;
      // 修复：分解产物按家具 Excel 配置（processedProductId/processedProductCount）——
      // 原实现恒产木材 30012×2，稀有家具分解产物错误
      const info = getFurnitureInfo(furnitureId);
      const productId = info?.processedProductId ?? "30012";
      const productCount = (info?.processedProductCount ?? 2) * count;
      mgr._applyItemDelta(draft, productId, productCount);
    });
    // 分解产出的追踪事件补发（B12）
    await mgr._flushGainEvents();
}
