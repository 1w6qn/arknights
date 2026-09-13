/**
 * 模组（uniequip）任务管理器
 *
 * 负责明日方舟干员专属模组解锁任务的真实进度推进。
 *
 * 模组任务定义于 excel.UniequipTable.missionList（948 条），每项归属一个干员模组（uniEquipId），
 * 条件由「指定干员非助战上场 + 指定关卡/星级 + 战斗内统计」组合而成。
 *
 * 「战斗内统计」依据反编译的 BattleStats 契约（reference/com.hypergryph.arknights_2.7.61.cs）：
 *   - charStats（ListCounterPool<CharStatKey>）：SPAWN=部署 / DEAD=阵亡 / WITHDRAW=撤退（召唤物同样按 charId 统计）
 *   - skillTrigStats（ListCounterPool<SkillTrigStatsKey>）：技能施放次数
 *   - charAdvancedStats（charId → CharAdvancedStats）：outputDamageTotal（伤害）/
 *     outputElementDamageTotal（按元素伤害）/ outputEpBreakCnt（按元素爆发次数）/
 *     outputDamageByTypeTotal（按伤害类型）
 *   - enemyStats（按 enemyId 的 HP_ZERO/… 击杀计数，全队维度）
 *
 * 无法从 BattleStats 提取的逐干员统计（"使用 XX 干员歼灭 XX 敌人"的 DEATHDETAIL、部署顺序），
 * 采用「enemyStats 全队击杀数（HP_ZERO 求和）」作为代理：击杀类模板（EquipmentCharKilled /
 * EquipmentCharKilledStage / EquipmentBattleCharKilled）据此真实累计，不再一上场就自动完成；
 * 特定精英/领袖/事件类模板（EventTotal/EventStage*）仍以通关场次兜底保证可完成不卡死。
 *
 * 进度写入 playerdata.equipment.missions[missionId] = { value, target }。
 * 模板按完成形态分三类：
 *   - once（一次性）：达标一场即完成（多含关卡+三星）
 *   - field（场次型）：完成 N 次有效战斗
 *   - sum（累计型）：累计某统计量达到 target
 */
import excel from "@excel/excel";
import type { Draft } from "mutative";
import type { PlayerDataModel } from "../../kernel/playerdata";
import { logger } from "@utils/logger";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { BattleInfo } from "../../kernel/battle-info-store";
import { BattleData, BattleStats } from "../../kernel/battle-model";
import { BadRequestError } from "@core/http/errors";

/** 模组任务进度条目（playerdata.equipment.missions 的单项） */
interface EquipmentMissionEntry {
  value: number;
  target: number;
}

/** 模板完成形态分类 */
enum EquipTmplKind {
  /** 一次性：达标（含指定关卡三星）一场即完成 */
  ONCE = "once",
  /** 场次型：完成 N 场指定干员上场的战斗 */
  FIELD = "field",
  /** 累计型：累计某统计量达到 target */
  SUM = "sum",
}

/** 战斗统计视图（从 battleData.battleData.stats 防御式提取，缺字段时为空） */
interface StatView {
  /** 全队造成伤害（stats.totalDamage，float） */
  totalDamage: number;
  /** charId → 造成总伤害（ceil 转 int） */
  charDamage: Map<string, number>;
  /** charId → 按元素类型爆发次数数组 */
  charElementBurst: Map<string, number[]>;
  /** charId → 按元素类型造成伤害数组 */
  charElementDamage: Map<string, number[]>;
  /** charId → 按伤害类型造成伤害数组 */
  charDamageByType: Map<string, number[]>;
  /** charId+skillId → 技能施放次数 */
  skillCast: Map<string, number>;
  /** charId → SPAWN 部署/召唤次数 */
  deploy: Map<string, number>;
  /** charId → DEAD 阵亡次数 */
  dead: Map<string, number>;
  /** charId → WITHDRAW 撤退次数 */
  withdraw: Map<string, number>;
  /** enemyStats.HP_ZERO 求和：全队击杀数（击杀类模板的代理统计） */
  enemyKills: number;
  /** 是否存在 enemyStats 击杀数据（区分「本场 0 击杀」与「无击杀数据」） */
  killHasData: boolean;
  /** 是否存在 charStats 部署/阵亡/撤退计数（区分「本场 0 阵亡」与「无该统计」） */
  hasCounterData: boolean;
}

/** 战斗推进上下文（编队构成 + 关卡/星级） */
interface EquipBattleCtx {
  /** 非助战在场（编入）干员 charId */
  onFieldCharIds: Set<string>;
  /** 全部编队成员 charId（含助战，供编成限制判定） */
  squadCharIds: string[];
  /** 结算关卡 id */
  stageId: string;
  /** 通关星级（3 = 三星） */
  completeState: number;
}

/** 单次战斗推进结果 */
interface Advance {
  /** 累计型：本场应累加的进度值 */
  add?: number;
  /** 击杀型：本场实际击杀数（原样累加，可为 0） */
  killAdd?: number;
  /** 累计型兜底：无可算统计时直接置满 */
  set?: number;
  /** 场次/一次性：本场是否计一次有效战斗 */
  hit?: boolean;
}

export class EquipmentMissionManager {
  /** 战斗推进上下文 */
  private static _kind(template: string): EquipTmplKind {
    if (SUM_TMPLS.has(template)) return EquipTmplKind.SUM;
    if (FIELD_TMPLS.has(template)) return EquipTmplKind.FIELD;
    return EquipTmplKind.ONCE;
  }

  private _player: PlayerDataManager;

  /**
   * 构造函数
   * @param player 玩家数据管理器实例
   */
  constructor(player: PlayerDataManager) {
    this._player = player;
  }

  /**
   * 依据模板形态判定任务目标值
   * @param template 模板名
   * @param paramList 参数列表
   * @returns 任务目标值
   */
  private _targetFor(template: string, paramList?: string[]): number {
    const params = paramList ?? [];
    // 一次性击杀关卡：目标为击杀数（param[3]，如「歼灭20个敌人」→ target=20）
    if (template === "EquipmentCharKilledStage") {
      return this._firstNumber(params.slice(3)) ?? 1;
    }
    const kind = EquipmentMissionManager._kind(template);
    if (kind === EquipTmplKind.FIELD) {
      return this._firstNumber(params) ?? 1;
    }
    if (kind === EquipTmplKind.SUM) {
      return this._firstNumber(params) ?? 1;
    }
    return 1;
  }

  /**
   * 从参数列表取首个纯数值（>0）
   * @param params 参数列表
   * @param from 起始下标
   */
  private _firstNumber(params: string[], from = 0): number | undefined {
    for (let i = from; i < (params?.length ?? 0); i++) {
      const n = Number(params[i]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  }

  /** 一次性模板所要求匹配的关卡（ONCE 的 param[1] 多为关卡 id） */
  private _requiredStage(template: string, paramList?: string[]): string | undefined {
    if (EquipmentMissionManager._kind(template) !== EquipTmplKind.ONCE) return undefined;
    const stage = (paramList ?? [])[1];
    return stage && !/^\d+$/.test(stage) ? stage : undefined;
  }

  /**
   * 取 paramList 中所有以 token_ 开头并作 ; 拆分的 id 集合（用于召唤物统计）
   * @param params 参数列表
   */
  private _tokenIds(params: string[]): string[] {
    const out: string[] = [];
    for (const raw of params ?? []) {
      for (const id of (raw ?? "").split(";")) {
        if (id.startsWith("token_")) out.push(id);
      }
    }
    return out;
  }

  /**
   * 防御式汇总指定 charId/token 的某统计并上报是否可算
   * @param ids 关注的角色 id（干员 + 若干 token）
   * @param get 统计取值函数（返回 undefined 表示该角色无记录）
   * @returns 可算时返回累计值，否则 undefined
   */
  private _sumOfIds(
    ids: string[],
    get: (id: string) => number | undefined,
  ): { value: number; computable: boolean } {
    let sum = 0;
    let hasValue = false;
    for (const id of ids) {
      const v = get(id);
      if (v != null && Number.isFinite(v)) {
        sum += v;
        hasValue = true;
      }
    }
    return { value: sum, computable: hasValue };
  }

  /**
   * 从战斗数据提取统计视图（防御：字段缺失/类型不符时置空，不影响结算主流程）
   * @param battleData 解密后的战斗数据
   */
  private _extractStats(battleData: BattleData): StatView {
    const sv: StatView = {
      totalDamage: 0,
      charDamage: new Map(),
      charElementBurst: new Map(),
      charElementDamage: new Map(),
      charDamageByType: new Map(),
      skillCast: new Map(),
      deploy: new Map(),
      dead: new Map(),
      withdraw: new Map(),
      enemyKills: 0,
      killHasData: false,
      hasCounterData: false,
    };
    const stats: BattleStats | undefined = battleData.battleData?.stats;
    if (!stats) return sv;
    sv.totalDamage = stats.totalDamage ?? 0;
    // charAdvancedStats（dict：charId → CharAdvancedStats）
    const cas = stats.charAdvancedStats as
      | { [k: string]: Partial<BattleStats.CharAdvancedStats> }
      | undefined;
    if (cas) {
      for (const [cid, a] of Object.entries(cas)) {
        if (!a || !cid) continue;
        if (typeof a.outputDamageTotal === "number") {
          sv.charDamage.set(cid, Math.ceil(a.outputDamageTotal));
        }
        if (Array.isArray(a.outputEpBreakCnt)) {
          sv.charElementBurst.set(cid, a.outputEpBreakCnt.map(Number));
        }
        if (Array.isArray(a.outputElementDamageTotal)) {
          sv.charElementDamage.set(cid, a.outputElementDamageTotal.map(Number));
        }
        if (Array.isArray(a.outputDamageByTypeTotal)) {
          sv.charDamageByType.set(cid, a.outputDamageByTypeTotal.map(Number));
        }
      }
    }
    // charStats（ListCounterPool<CharStatKey>）
    for (const item of stats.charStats ?? []) {
      const key = item?.Key;
      if (!key?.charId) continue;
      const v = Number(item.Value) || 0;
      const cid = key.charId;
      sv.hasCounterData = true;
      if (key.counterType === "SPAWN") {
        sv.deploy.set(cid, (sv.deploy.get(cid) ?? 0) + v);
      } else if (key.counterType === "DEAD") {
        sv.dead.set(cid, (sv.dead.get(cid) ?? 0) + v);
      } else if (key.counterType === "WITHDRAW") {
        sv.withdraw.set(cid, (sv.withdraw.get(cid) ?? 0) + v);
      }
    }
    // enemyStats（全队击杀代理：HP_ZERO 求和；无法按干员拆分，故整体累计）
    for (const item of stats.enemyStats ?? []) {
      if (!item?.Key || item.Key.counterType !== "HP_ZERO") continue;
      const v = Number(item.Value) || 0;
      sv.enemyKills += v;
      sv.killHasData = true;
    }
    // skillTrigStats（ListCounterPool<SkillTrigStatsKey>；线上可能为 dict/entias，防御双形态）
    const skillSrc = stats.skillTrigStats as unknown;
    const skillEntries = Array.isArray(skillSrc)
      ? (skillSrc as Array<{ Key?: { charId?: string; skillId?: string }; Value?: number }>)
      : [];
    for (const item of skillEntries) {
      const key = item?.Key;
      if (!key?.charId || !key.skillId) continue;
      const mapKey = `${key.charId}\u0001${key.skillId}`;
      sv.skillCast.set(mapKey, (sv.skillCast.get(mapKey) ?? 0) + (Number(item.Value) || 0));
    }
    return sv;
  }

  /** 该模板本次战斗是否命中基础（ONCE 需关卡+三星，field/sum 需通关）由 caller 判断，此处仅做统计推进 */
  private _advanceBattle(
    template: string,
    paramList: string[],
    charId: string,
    sv: StatView,
    ctx: EquipBattleCtx,
  ): Advance {
    const p = paramList ?? [];
    switch (template) {
      // ===== 累计造成伤害 =====
      case "EquipmentDamageTotal": {
        const ids = [charId];
        return this._sumAdvance(sv, ids, (id) => sv.charDamage.get(id), p);
      }
      case "EquipmentDamageTotalWithToken": {
        const ids = [charId, ...this._tokenIds(p)];
        return this._sumAdvance(sv, ids, (id) => sv.charDamage.get(id), p);
      }
      // ===== 按元素伤害（param[1]=阈值, param[2]=元素索引，如妮芙 60000/5）=====
      // 修复（2026-09-09）：原读 outputDamageByTypeTotal（按伤害类型）——官服任务描述为「元素伤害」，
      // 应对应 outputElementDamageTotal（sv.charElementDamage；该字段此前已被提取却从未被读）。
      case "EquipmentDamageTypeTotal": {
        const typeIdx = Number(p[2]) || 0;
        return this._arraySumAdvance(sv, [charId], (id) => sv.charElementDamage.get(id), typeIdx, p);
      }
      // ===== 元素爆发次数（param[1]=阈值, param[2]=元素类型索引）=====
      case "EquipmentElementBurst": {
        const typeIdx = Number(p[2]) || 0;
        return this._arraySumAdvance(sv, [charId], (id) => sv.charElementBurst.get(id), typeIdx, p);
      }
      // ===== 累计技能施放（param[1]=skill id）=====
      case "EquipmentSkillCast": {
        const skillId = p[1];
        const ids = [charId];
        return this._sumAdvanceSkill(sv, ids, skillId, p);
      }
      // ===== 累计召唤/部署（token spawn）=====
      case "EquipmentDeployTotal": {
        const ids = this._tokenIds(p);
        return this._sumAdvance(sv, ids, (id) => sv.deploy.get(id), p);
      }
      // ===== 累计歼灭敌人（enemyStats 全队击杀逐场累加；无数据兜底置满）=====
      case "EquipmentCharKilled": {
        return this._killsAccumulate(sv, this._firstNumber(p.slice(1)) ?? 1);
      }
      // ===== 累计歼灭精英/领袖（DEATHDETAIL，不可逐干员统计 → 置满兜底）=====
      case "EquipmentEventTotal": {
        return { set: this._firstNumber(p) ?? 1 };
      }
      // ===== 一次性关卡 + 统计阈值 =====
      case "EquipmentDamageStage": {
        const threshold = this._firstNumber(p.slice(2)) ?? 0;
        const ids = [charId];
        return this._thresholdFight(sv, ids, (id) => sv.charDamage.get(id), threshold);
      }
      // 修复（2026-09-09）：param 形如 ["3","main_14-06","char_4146_nymph","5000","5"] ——
      // 阈值 = param[3]、元素索引 = param[4]。原实现用 `_firstNumber(p.slice(3))` 取「首个数值」
      // 把阈值 5000 当成数组下标 → 恒 undefined → 兜底 hit:true（一次三星通关即完成）。
      case "EquipmentDamageTypeStage": {
        const typeIdx = Number(p[4]) || 0;
        const threshold = Number(p[3]) || 0;
        const ids = [charId];
        return this._arrayThresholdFight(sv, ids, (id) => sv.charElementDamage.get(id), typeIdx, threshold);
      }
      case "EquipmentElementBurstStage": {
        const typeIdx = Number(p[4]) || 0;
        const threshold = Number(p[3]) || 0;
        const ids = [charId];
        return this._arrayThresholdFight(sv, ids, (id) => sv.charElementBurst.get(id), typeIdx, threshold);
      }
      // ===== 场次型 + 统计阈值 =====
      case "EquipmentBattleCharDamage": {
        const threshold = this._firstNumber(p.slice(1)) ?? 0;
        return this._thresholdFight(sv, [charId], (id) => sv.charDamage.get(id), threshold);
      }
      case "EquipmentSkillCastBattle": {
        const skillIds = (p[1] ?? "").split(";").filter(Boolean);
        const threshold = this._firstNumber(p.slice(2)) ?? 0;
        return this._skillThresholdFight(sv, [charId], skillIds, threshold);
      }
      case "EquipmentDeployStage": {
        const tokens = this._tokenIds(p);
        const threshold = this._firstNumber(p.slice(1)) ?? 0;
        return this._thresholdFight(sv, tokens, (id) => sv.deploy.get(id), threshold);
      }
      // 修复（2026-09-09）：条件为「整场战斗仅部署过<干员>与至多 param[3] 位其他干员」，
      // 原实现误用「该干员自身部署次数 ≥ param[3]」代替（语义替换 → 提前完成）。
      case "EquipmentStageDeployCntAndSpec": {
        if (sv.deploy.size === 0) return { hit: true };
        const maxOthers = Number(p[p.length - 1]) || 0;
        const deployers = [...sv.deploy.keys()].filter(
          (id) => id !== charId && !id.startsWith("token_") && (sv.deploy.get(id) ?? 0) > 0,
        );
        return { hit: deployers.length <= maxOthers };
      }
      // 修复（2026-09-09）：条件为「部署至少 param[1] 次 **且** 歼灭至少 param[4] 名敌人」，
      // 原实现只判部署次数、丢弃 param[4]（击杀阈值）。
      case "EquipmentDeployCharAndKillCnt": {
        const deployNeed = Number(p[1]) || 0;
        const killNeed = Number(p[4]) || 0;
        const deployed = sv.deploy.get(charId) ?? 0;
        const killOk = sv.killHasData ? sv.enemyKills >= killNeed : true;
        return { hit: deployed >= deployNeed && killOk };
      }
      // ===== 无撤退不撤退（DO EARW裁判）=====
      case "EquipmentDeployOneNoEvac": {
        const dead = sv.dead.get(charId) ?? 0;
        const withdraw = sv.withdraw.get(charId) ?? 0;
        const computable = sv.dead.size > 0 || sv.withdraw.size > 0;
        // 无统计可算 → 兜底 hit；有统计 → 必须无阵亡且无撤退
        const hit = computable ? dead === 0 && withdraw === 0 : true;
        return { hit };
      }
      // ===== 一次性击杀关卡（3星通关 + 击杀数逐场累计；enemyStats 代理）=====
      case "EquipmentCharKilledStage": {
        const killTarget = this._firstNumber(p.slice(3)) ?? 1;
        return this._killsAccumulate(sv, killTarget);
      }
      // ===== 一次性关卡 + 击杀/事件（特定单位击杀，不可逐干员统计 → 已达基就完成）=====
      // 修复（2026-09-09）：这 7 类模板此前一律 `hit: true`（随便编队三星通关即解锁，
      // 涉及 173 条任务：SquadPro 32 / SquadProEx 86 / SquadNum 47 / SquadNoAnyDead 27 /
      // SquadPos 6 / SquadStar 2 / SkillCastStage 78）。现有统计足以真实判定：
      //  - SquadPro / SquadPos / SquadStar / SquadNum / SquadProEx：读编队构成（ctx.squadCharIds）
      //  - SquadNoAnyDead：读 charStats DEAD 计数
      //  - SkillCastStage：param[2]=技能 id、param[3]=次数阈值，读 skillTrigStats
      case "EquipmentSquadNoAnyDead": {
        if (!sv.hasCounterData) return { hit: true };
        const anyDead = ctx.squadCharIds.some((id) => (sv.dead.get(id) ?? 0) > 0);
        return { hit: !anyDead };
      }
      case "EquipmentSquadNum":
      case "EquipmentSquadPos":
      case "EquipmentSquadPro":
      case "EquipmentSquadProEx":
      case "EquipmentSquadStar":
        return { hit: this._squadRuleHit(template, p, charId, ctx) };
      case "EquipmentSkillCastStage": {
        const skillId = p[2] ?? "";
        const threshold = Number(p[3]) || 0;
        return this._skillThresholdFight(sv, [charId], [skillId], threshold);
      }
      case "EquipmentEventStageKill":
      case "EquipmentEventStageMore":
      case "EquipmentEventBattleMore":
      case "EquipmentDeployCharOrder":
        return { hit: true };
      // ===== 场次型 + 单场击杀阈值（每场击杀 >= param[2] 才计一场）=====
      case "EquipmentBattleCharKilled": {
        const minKills = this._firstNumber(p.slice(2)) ?? 0;
        return this._killsThreshold(sv, minKills);
      }
      // ===== 场次型（无统计/队伍限制，按有效战斗计数）=====
      // 场次型编成限制（非助战该干员上场完成 N 场；其他成员仅可编入指定职业/星级）
      case "EquipmentSquadProStage":
      case "EquipmentSquadStarStage":
        return { hit: this._squadRuleHit(template, p, charId, ctx) };
      default:
        return { hit: true };
    }
  }

  /**
   * 编成限制判定（EquipmentSquadPro / SquadPos / SquadStar / SquadNum / SquadProEx 共用）
   *
   * paramList 末位参数格式（实测 data/excel/uniequip_table.json）：
   * - `SquadPro` / `SquadPos` / `SquadStar`：`"<其他成员上限>,<约束>"`
   *   （约束为职业如 PIONEER、站位如 MELEE/RANGED，或星级如 3）
   * - `SquadNum`：`"<其他成员上限>"`
   * - `SquadProEx`：`"A;B"` —— 其他成员不得属于这些职业
   * 「其他成员」= 编队中除该任务干员以外的全部成员（含助战，对齐任务描述「包含助战」）。
   * @param template - 模板名
   * @param p - paramList
   * @param charId - 任务所属干员
   * @param ctx - 战斗上下文（含编队构成）
   * @returns 是否满足编成限制
   */
  private _squadRuleHit(
    template: string,
    p: string[],
    charId: string,
    ctx: EquipBattleCtx,
  ): boolean {
    const spec = String(p[p.length - 1] ?? "");
    const others = ctx.squadCharIds.filter((id) => id !== charId);
    if (template === "EquipmentSquadProEx") {
      const banned = new Set(spec.split(";").map((s) => s.trim()).filter(Boolean));
      if (!banned.size) return true;
      return !others.some((id) =>
        banned.has(String(excel.charData(id)?.profession ?? "")),
      );
    }
    if (template === "EquipmentSquadNum") {
      const max = Number(spec);
      return Number.isFinite(max) ? others.length <= max : true;
    }
    const [maxRaw, rawConstraint] = spec.split(",");
    const max = Number(maxRaw);
    if (Number.isFinite(max) && others.length > max) return false;
    const constraint = String(rawConstraint ?? "").trim();
    if (!constraint) return true;
    for (const id of others) {
      const info = excel.charData(id);
      if (!info) return false;
      if (constraint === "MELEE" || constraint === "RANGED") {
        if (String(info.position ?? "") !== constraint) return false;
      } else if (/^\d+$/.test(constraint)) {
        const star = Number(/TIER_(\d)/.exec(String(info.rarity ?? ""))?.[1] ?? 0);
        if (star !== Number(constraint)) return false;
      } else if (String(info.profession ?? "") !== constraint) {
        return false;
      }
    }
    return true;
  }

  /**
   * 击杀累计（累计型/一次性击杀关卡共用）：enemyStats 全队击杀原样累加；
   * 无击杀数据时置满兜底（保证任务可完成不卡死）
   *
   * @param sv 统计视图
   * @param target 击杀目标值
   * @returns 有数据返回 killAdd（可为 0），否则返回 set 置满
   */
  private _killsAccumulate(sv: StatView, target: number): Advance {
    if (sv.killHasData) return { killAdd: sv.enemyKills };
    return { set: target };
  }

  /**
   * 单场击杀阈值判定（场次型）：本场击杀达阈值才计一次有效战斗；
   * 无击杀数据时兜底计（保证可完成）
   *
   * @param sv 统计视图
   * @param threshold 单场击杀阈值
   * @returns 有数据按阈值判定 hit，否则兜底 hit
   */
  private _killsThreshold(sv: StatView, threshold: number): Advance {
    if (!sv.killHasData) return { hit: true };
    return { hit: sv.enemyKills >= threshold };
  }

  /** 累计型（标量统计）：可算则累加，否则置满兜底 */
  private _sumAdvance(
    sv: StatView,
    ids: string[],
    get: (id: string) => number | undefined,
    p: string[],
  ): Advance {
    const { value, computable } = this._sumOfIds(ids, get);
    if (computable) return { add: value };
    return { set: this._firstNumber(p) ?? 1 };
  }

  /** 累计型（数组统计按索引）：同上 */
  private _arraySumAdvance(
    sv: StatView,
    ids: string[],
    get: (id: string) => number[] | undefined,
    idx: number,
    p: string[],
  ): Advance {
    const vals = ids.map((id) => (get(id) ?? [])[idx]).filter((v) => v != null && Number.isFinite(v));
    if (vals.length > 0) return { add: Math.ceil(vals.reduce((a, b) => a + b, 0)) };
    return { set: this._firstNumber(p) ?? 1 };
  }

  /** 累计型（技能施放）：可算则累加，否则置满兜底 */
  private _sumAdvanceSkill(
    sv: StatView,
    ids: string[],
    skillId: string | undefined,
    p: string[],
  ): Advance {
    if (skillId) {
      const vals = ids
        .map((id) => sv.skillCast.get(`${id}\u0001${skillId}`))
        .filter((v): v is number => v != null && Number.isFinite(v));
      if (vals.length > 0) return { add: vals.reduce((a, b) => a + b, 0) };
    }
    return { set: this._firstNumber(p) ?? 1 };
  }

  /** 场次/一次性（标量阈值）：统计可算则按达标判定，否则兜底命中 */
  private _thresholdFight(
    sv: StatView,
    ids: string[],
    get: (id: string) => number | undefined,
    threshold: number,
  ): Advance {
    const { value, computable } = this._sumOfIds(ids, get);
    if (computable) return { hit: value >= threshold };
    return { hit: true };
  }

  /** 场次/一次性（数组阈值）：同上 */
  private _arrayThresholdFight(
    sv: StatView,
    ids: string[],
    get: (id: string) => number[] | undefined,
    idx: number,
    threshold: number,
  ): Advance {
    const vals = ids.map((id) => (get(id) ?? [])[idx]).filter((v) => v != null && Number.isFinite(v));
    if (vals.length > 0) return { hit: vals.reduce((a, b) => a + b, 0) >= threshold };
    return { hit: true };
  }

  /** 场次型（技能阈值）：统计可算则按达标判定，否则兜底命中 */
  private _skillThresholdFight(
    sv: StatView,
    ids: string[],
    skillIds: string[],
    threshold: number,
  ): Advance {
    const vals = ids.flatMap((id) =>
      skillIds.map((sk) => sv.skillCast.get(`${id}\u0001${sk}`)),
    );
    const defined = vals.filter((v): v is number => v != null);
    if (defined.length > 0) return { hit: defined.reduce((a, b) => a + b, 0) >= threshold };
    return { hit: true };
  }

  /**
   * 序列化当前玩家存档的模组任务集合（缺失时初始化）
   * @param draft 当前可变存档 draft
   */
  private _missionDict(draft: Draft<PlayerDataModel>): { [missionId: string]: EquipmentMissionEntry } {
    draft.equipment ??= { missions: {} };
    draft.equipment.missions ??= {};
    return draft.equipment.missions;
  }

  /**
   * 战斗胜利结算后推进在场（非助战）干员的模组任务进度
   *
   * 由 BattleManager.finish 在胜利（completeState>=2 且非演习）时调用。逐任务依据
   * 反编译 BattleStats 统计真实推进；统计缺失时按「干员在场+通关场次」兜底，保证可完成。
   *
   * @param args 结算上下文（battleInfo 供编队/助战，battleData 供星级/关卡/统计）
   */
  async onBattleWin(args: {
    battleInfo: BattleInfo;
    battleData: BattleData;
  }): Promise<void> {
    const { battleInfo, battleData } = args;
    // 防护：未 mock / 未加载 UniequipTable（单测精简 mock、excel 尚未初始化）时不推进
    if (!excel.UniequipTable?.equipDict) return;
    const ctx = this._buildCtx(battleInfo, battleData);
    if (!ctx) return;
    const sv = this._extractStats(battleData);
    const updates: {
      [missionId: string]: { template: string; paramList?: string[]; charId: string };
    } = {};
    for (const charId of ctx.onFieldCharIds) {
      for (const equip of Object.values(excel.UniequipTable.equipDict)) {
        if (!equip || equip.charId !== charId) continue;
        for (const missionId of equip.missionList ?? []) {
          if (updates[missionId]) continue;
          const mission = excel.UniequipTable.missionList[missionId];
          updates[missionId] = {
            template: mission?.template ?? "",
            paramList: mission?.paramList,
            charId,
          };
        }
      }
    }
    if (Object.keys(updates).length === 0) return;
    const touched: { missionId: string; value: number; target: number }[] = [];
    await this._player.update(async (draft) => {
      const missions = this._missionDict(draft);
      for (const [missionId, u] of Object.entries(updates)) {
        const kind = EquipmentMissionManager._kind(u.template);
        const reqStage = this._requiredStage(u.template, u.paramList);
        const p = u.paramList ?? [];
        // 基础判定：ONCE 需关卡+三星、field/sum 需通关才参与统计
        const baseHit = this._matchBattle(kind, ctx.stageId, reqStage, ctx.completeState);
        const entry = (missions[missionId] ??= {
          value: 0,
          target: this._targetFor(u.template, p),
        });
        if (!baseHit) continue;
        const adv = this._advanceBattle(u.template, p, u.charId, sv, ctx);
        const before = entry.value;
        if (adv.killAdd != null) {
          // 击杀累计：原样累加本场击杀（可为 0，避免 0 击杀也被 max(1) 顶上）
          entry.value = Math.min(entry.target, entry.value + adv.killAdd);
        } else if (adv.set != null) {
          entry.value = Math.min(entry.target, adv.set);
        } else if (adv.add != null) {
          entry.value = Math.min(entry.target, entry.value + Math.max(1, adv.add));
        } else if (adv.hit) {
          if (kind === EquipTmplKind.ONCE) entry.value = entry.target;
          else entry.value = Math.min(entry.target, entry.value + 1);
        }
        if (entry.value !== before) {
          touched.push({ missionId, value: entry.value, target: entry.target });
        }
      }
    });
    // 模组任务进度推送（对齐官服 equipmentMission pushMessage，payload 为 idList）：
    // 随本次战斗结算响应下发，逐条推进的任务各发一条
    for (const t of touched) {
      this._player.pushMessage("equipmentMission", { idList: [t.missionId] });
    }
    logger.debug(
      "EquipmentMission",
      `模组任务推进 ${Object.keys(updates).length} 条（stage=${ctx.stageId} star=${ctx.completeState}）`,
    );
  }

  /**
   * 由结算信息构建战斗上下文（提取非助战在场干员、关卡、星级）
   * @param battleInfo 战斗信息（编队 + 助战）
   * @param battleData 战斗数据（消耗completeState）
   */
  private _buildCtx(
    battleInfo: BattleInfo,
    battleData: BattleData,
  ): EquipBattleCtx | undefined {
    if (battleInfo.isPractice) return undefined;
    const slots = battleInfo.squad?.slots;
    if (!slots?.length) return undefined;
    const assistChars = new Set<string>(
      (battleInfo.assistFriend?.assistChar ?? []).map((c) => c.charId),
    );
    const onFieldCharIds = new Set<string>();
    // 修复（2026-09-09）：编成限制类任务（SquadPro/Pos/Star/Num/ProEx）需要完整编队构成——
    // 原 ctx 只保留「非助战在场干员」，无从判定「其他成员仅可编入 X」。
    const squadCharIds: string[] = [];
    const chars = this._player._playerdata.troop.chars;
    for (const slot of slots) {
      if (!slot) continue;
      const char = chars[slot.charInstId];
      if (!char || !char.charId) continue;
      squadCharIds.push(char.charId);
      if (assistChars.has(char.charId)) continue;
      onFieldCharIds.add(char.charId);
    }
    // 助战干员（好友方）不在 troop.chars 内，单独并入编队构成（任务描述「包含助战」）
    for (const id of assistChars) squadCharIds.push(id);
    if (onFieldCharIds.size === 0) return undefined;
    return {
      onFieldCharIds,
      squadCharIds,
      stageId: battleInfo.stageId,
      completeState: battleData.completeState ?? 0,
    };
  }

  /**
   * 关卡/星级基础判定
   * @param kind 模板形态
   * @param stageId 结算关卡
   * @param reqStage 要求的关卡（可能为 undefined）
   * @param completeState 通关星级
   */
  private _matchBattle(
    kind: EquipTmplKind,
    stageId: string,
    reqStage: string | undefined,
    completeState: number,
  ): boolean {
    if (kind === EquipTmplKind.ONCE) {
      if (reqStage && stageId !== reqStage) return false;
      return completeState >= 3;
    }
    return completeState >= 2;
  }

  /**
   * 解锁前播种并校验目标模组的任务完成度（供 CharManager 解锁时调用）
   *
   * 老存档已播种完成态（value===target）的条目保留，判定通过——向后兼容。
   *
   * @param _charId 干员 id
   * @param missionIds 该模组的任务 id 列表
   * @param draft 解锁配方中的可变存档 draft
   * @throws 存在未完成任务时抛出（阻止解锁）
   */
  assertUnlockable(_charId: string, missionIds: string[], draft: Draft<PlayerDataModel>): void {
    const missions = this._missionDict(draft);
    for (const missionId of missionIds) {
      const mission = excel.UniequipTable.missionList[missionId];
      const target = missions[missionId]?.target ?? this._targetFor(mission?.template ?? "", mission?.paramList);
      if (!missions[missionId]) {
        missions[missionId] = { value: 0, target };
      } else {
        missions[missionId].target = target;
      }
      const cur = missions[missionId]?.value ?? 0;
      if (cur < target) {
        throw new BadRequestError(`模组 ${missionId} 任务未完成（${cur}/${target}），请完成对应战斗后再解锁`);
      }
    }
  }
}

/**
 * 场次型模板（param[0]=需完成的战斗场次；无关卡约束，通关即计入，统计可算时以统计阈值判定）
 *
 * 修复（2026-09-09）：`EquipmentStageDeployCntAndSpec` 原被误列入本集合——其实例 param 为
 * `["3","main_03-04","char_2023_ling","4"]`（param[0]=星级、param[1]=关卡），属一次性模板，
 * 归入场次型后既丢关卡约束（_requiredStage 对 FIELD 恒 undefined）又把星级 3 当成战斗场次目标。
 */
const FIELD_TMPLS: ReadonlySet<string> = new Set([
  "EquipmentBattleCharDamage",
  "EquipmentBattleCharKilled",
  "EquipmentDeployCharAndKillCnt",
  "EquipmentDeployCharOrder",
  "EquipmentDeployStage",
  "EquipmentEventBattleMore",
  "EquipmentSkillCastBattle",
  "EquipmentSquadProStage",
  "EquipmentSquadStarStage",
]);

/** 累计型模板（目标为累计统计量；有统计时真实累加，无统计时一场达标兜底） */
const SUM_TMPLS: ReadonlySet<string> = new Set([
  "EquipmentCharKilled",
  "EquipmentDamageTotal",
  "EquipmentDamageTotalWithToken",
  "EquipmentDamageTypeTotal",
  "EquipmentDeployTotal",
  "EquipmentElementBurst",
  "EquipmentEventTotal",
  "EquipmentSkillCast",
]);