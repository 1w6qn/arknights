/**
 * 干员技能解锁工具（等级/精英化驱动）
 *
 * 完全采用官服线格式：
 * - 干员 skills 数组列出该干员 excel 中的全部技能（阿米娅除外，其技能在 tmpl 中）。
 * - 每个技能用 unlock 表示当前是否解锁：1 = 已解锁，0 = 未解锁的官方锁定占位。
 * - 解锁条件以 excel CharacterTable[charId].skills[i].unlockCond.phase 为准，
 *   即当前 evolvePhase >= 所需 phase 时 unlock = 1，否则 unlock = 0。
 * - 官服存档在未精一/未精二时仍会列出未来技能占位（unlock:0），修复/回填时不得删除。
 *
 * 位置：2026-09-13 由 `app/game/modules/character/char-skills.ts` 上移 `app/game/kernel/`——
 * kernel 的存档健康检查（`save-health.ts`）需要它，而 kernel 不得反向依赖 modules（R2）。
 * 仍直连 `@excel/excel` 单例（棘轮基线已随之重键）：`checkAndRepairSave` 在 PlayerDataManager
 * 之前对原始存档 JSON 运行，此处拿不到 `player.excel` 端口。
 */
import excel from "@excel/excel";
import type { UniEquipData } from "@excel/excel";

/** 干员技能条目（存档线格式） */
export interface CharSkillEntry {
  skillId: string;
  unlock: number;
  state: number;
  specializeLevel: number;
  completeUpgradeTime: number;
}

/**
 * excel 技能条目读取视图
 *
 * 生成类型的技能解锁条件字段为 `initialUnlockCond`（CS 模型，真表数据同键），
 * 但既有实现按 `unlockCond` 读取（真表恒 undefined → phase 恒 0，见实现报告台账）。
 * 本视图仅描述既有实现的读取口径以完成类型清除，**不改变行为**；修正需同步更新
 * tests/unit/manager/char.test.ts 的技能 mock（当前 mock 用 unlockCond）。
 */
interface SkillExcelView {
  /** 技能 ID（生成类型 CharacterData_MainSkill.skillId，用于结构化赋值） */
  skillId: string;
  unlockCond?: { phase?: string | number | null };
}

/** 干员技能相关字段（兼容 PlayerCharacter 与 save-health 的 any 数据） */
export interface CharSkillsLike {
  charId: string;
  evolvePhase: number;
  level: number;
  skills?: CharSkillEntry[] | null;
  defaultSkillIndex?: number;
}

/** 干员模组相关字段（兼容 PlayerCharacter 与 save-health 的 any 数据） */
export interface CharEquipsLike {
  charId: string;
  evolvePhase: number;
  equip?: Record<string, { hide: number; locked: number; level: number }> | null;
  currentEquip?: string | null;
}

/** 单个模组在 excel 中的展示/解锁信息 */
interface ExcelEquipInfo {
  uiEquipId: string;
  /** 显示所需精英化阶段（showEvolvePhase，0/1/2） */
  showPhase: number;
  /** 无条件解锁标记（unlockEvolvePhase 为 number 0 且 unlockLevel 0 → 精二即解锁） */
  freeUnlock: boolean;
}

/** 单个技能在 excel 中的解锁信息 */
interface ExcelSkillInfo {
  skillId: string;
  /** 解锁所需精英化阶段（0/1/2） */
  phase: number;
}

/**
 * 将 excel 的 phase 字段（数字 0/1/2 或 "PHASE_0"/"PHASE_1"/"PHASE_2"）归一化为数字
 */
function normalizePhase(phase: unknown): number {
  if (typeof phase === "number") return phase;
  if (typeof phase === "string") {
    const n = Number(phase.replace(/^PHASE_/, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 获取干员在 excel 中的全部技能及解锁阶段（阿米娅/无技能干员返回空）
 */
function excelSkillInfos(charId: string): ExcelSkillInfo[] {
  // 阿米娅：技能在升变 tmpl 三形态中，char.skills 恒为空（官方同）
  if (charId === "char_002_amiya") return [];
  const info = excel.CharacterTable?.[charId];
  const skills = info?.skills as SkillExcelView[] | undefined;
  if (!Array.isArray(skills) || skills.length === 0) return [];
  return skills
    .filter((s) => s?.skillId)
    .map((s) => ({
      skillId: s.skillId,
      phase: normalizePhase(s?.unlockCond?.phase),
    }));
}

/**
 * 计算干员当前应解锁的技能 ID 列表（完全按 excel skills[i].unlockCond.phase）
 * @param charId - 干员ID（char_002_amiya 技能在 tmpl，返回空）
 * @param evolvePhase - 精英化阶段（0/1/2）
 * @param level - 等级（官方解锁条件不依赖等级，保留参数以兼容调用方）
 * @returns 应解锁的技能 ID 数组（无技能干员/阿米娅返回空）
 */
export function unlockedSkillIds(
  charId: string,
  evolvePhase: number,
  level: number,
): string[] {
  const phase = Number(evolvePhase) || 0;
  return excelSkillInfos(charId)
    .filter((s) => s.phase <= phase)
    .map((s) => s.skillId);
}

/**
 * 按官方线格式重组干员 skills：
 * - 保留已有条目的 state/specializeLevel/completeUpgradeTime；
 * - 按 excel skills[i].unlockCond.phase 校正 unlock（1=已解锁，0=锁定占位）；
 * - 补齐缺失的全部官方技能（含未解锁占位），移除不在 excel 中且无投入的技能；
 * - 校正 defaultSkillIndex（有技能时须指向已解锁技能；无技能且 dsi 异常 → -1）。
 *
 * 幂等：对已合规官服存档无副作用。移除仅在技能不在 excel 且无专精/训练投入时进行
 * （有投入保留，不破坏数据）。
 * @param char - 干员对象（原地修改）
 * @returns 是否发生变更
 */
export function reconcileCharSkills(char: CharSkillsLike): boolean {
  let changed = false;
  const skills: CharSkillEntry[] = char.skills ?? (char.skills = []);
  const officialSkills = excelSkillInfos(char.charId);
  const officialIds = new Set(officialSkills.map((s) => s.skillId));
  const evolvePhase = Number(char.evolvePhase) || 0;

  // 1. 移除不在 excel 中且无投入的技能（倒序遍历避免索引错位）
  for (let i = skills.length - 1; i >= 0; i--) {
    const s = skills[i];
    if (!s || !s.skillId) continue;
    if (
      !officialIds.has(s.skillId) &&
      (s.specializeLevel ?? 0) === 0 &&
      s.state !== 1
    ) {
      skills.splice(i, 1);
      changed = true;
    }
  }

  // 2. 按 excel 官方技能列表补齐/校正 unlock
  const byId = new Map<string, CharSkillEntry>();
  for (const s of skills) {
    if (s && s.skillId && !byId.has(s.skillId)) byId.set(s.skillId, s);
  }
  for (const info of officialSkills) {
    const expectedUnlock = info.phase <= evolvePhase ? 1 : 0;
    let entry = byId.get(info.skillId);
    if (!entry) {
      entry = {
        skillId: info.skillId,
        unlock: expectedUnlock,
        state: 0,
        specializeLevel: 0,
        completeUpgradeTime: -1,
      };
      byId.set(info.skillId, entry);
      changed = true;
    } else if (entry.unlock !== expectedUnlock) {
      entry.unlock = expectedUnlock;
      changed = true;
    }
  }

  // 3. 按官方顺序重建数组；不在 excel 中但有投入的非官方技能保留在末尾
  const ordered: CharSkillEntry[] = [];
  for (const info of officialSkills) {
    const entry = byId.get(info.skillId);
    if (entry) ordered.push(entry);
  }
  for (const s of skills) {
    if (s && s.skillId && !officialIds.has(s.skillId)) ordered.push(s);
  }
  if (
    ordered.length !== skills.length ||
    ordered.some((s, i) => s !== skills[i])
  ) {
    skills.length = 0;
    skills.push(...ordered);
    changed = true;
  }

  // 4. defaultSkillIndex 校正：有技能时必须指向已解锁技能（unlock === 1）；
  //    无技能时仅当 dsi 已定义且非 -1 才校正为 -1（旧数据 -1 已合规，缺失不动）
  if (skills.length > 0) {
    const firstUnlocked = skills.findIndex((s) => s && s.unlock === 1);
    const validDefault = firstUnlocked >= 0 ? firstUnlocked : 0;
    const current = char.defaultSkillIndex;
    const pointsToUnlocked =
      current !== undefined &&
      current >= 0 &&
      current < skills.length &&
      skills[current]?.unlock === 1;
    if (!pointsToUnlocked) {
      char.defaultSkillIndex = validDefault;
      changed = true;
    }
  } else if (
    char.defaultSkillIndex !== undefined &&
    char.defaultSkillIndex !== -1
  ) {
    char.defaultSkillIndex = -1;
    changed = true;
  }
  return changed;
}

/**
 * 获取干员在 excel 中拥有的模组列表及展示/解锁信息
 * （UniequipTable.charEquip[charId]；无模组干员返回空）
 */
function excelEquipInfos(charId: string): ExcelEquipInfo[] {
  const table = excel.UniequipTable;
  const dict: { [key: string]: UniEquipData } = table?.equipDict ?? {};
  // 优先按 charEquip 映射获取该干员模组顺序；无映射时退化为 scan equipDict
  // 的 charId 归属（兼容仅按 equipDict[].charId 建模的用例）
  let engine: string[] | null = table?.charEquip?.[charId] ?? null;
  if (!Array.isArray(engine) || engine.length === 0) {
    engine = Object.keys(dict).filter(
      (uid) => dict[uid] && dict[uid].charId === charId,
    );
  }
  if (!engine || engine.length === 0) return [];
  const infos: ExcelEquipInfo[] = [];
  for (const uid of engine) {
    // 防御：equipDict 含 null 占位条目
    const e = dict[uid];
    if (!e) continue;
    infos.push({
      uiEquipId: uid,
      // showPhase：按 showEvolvePhase 归一；缺省视为需精二（2）——无显示配置的
      // 模组默认隐藏，避免 E0 干员误显示（兼容未配置 showEvolvePhase 的用例）
      showPhase: (() => {
        const p = normalizePhase(e.showEvolvePhase);
        return e.showEvolvePhase == null ? 2 : p;
      })(),
      // 无条件解锁：unlockEvolvePhase 为数字 0 且 unlockLevel 0（如各干员首个模组）
      freeUnlock:
        typeof e.unlockEvolvePhase === "number" &&
        e.unlockEvolvePhase === 0 &&
        !(e.unlockLevel ?? 0),
    });
  }
  return infos;
}

/**
 * 按官服线格式校正干员模组（equip）条目：
 * - 补齐缺失的该干员模组占位条目（{hide, locked, level}）；
 * - hide 按 showEvolvePhase 校正：evolvePhase >= 显示所需阶段 → 0，否则 1
 *   （即「干员从无模组状态到有模组状态」的精二转变）；
 * - locked：遗留已解锁条目（locked=0）保留；新增条目中「精二且无条件解锁」
 *   的模组置 locked=0（参照官方精致即带首个模组），其余置 locked=1；
 * - currentEquip：精二且有已解锁条目时，若未指向任何已解锁模组则指向首个已解锁模组。
 *
 * 幂等：对已合规官服存档无副作用；缺失条目才补齐，已有条目只校正 hide。
 * @param char - 干员对象（原地修改）
 * @returns 是否发生变更
 */
export function reconcileCharEquips(char: CharEquipsLike): boolean {
  let changed = false;
  const equip = char.equip ?? (char.equip = {});
  const infos = excelEquipInfos(char.charId);
  if (infos.length === 0) return false;
  const evolvePhase = Number(char.evolvePhase) || 0;

  // 1. 补齐缺失条目 + 按阶段校正 hide
  for (const info of infos) {
    const entry = equip[info.uiEquipId] ??= { hide: 1, locked: 1, level: 1 };
    const targetHide = evolvePhase >= info.showPhase ? 0 : 1;
    if (entry.hide !== targetHide) {
      entry.hide = targetHide;
      changed = true;
    }
    // 新增条目：精二且无条件解锁的模组默认已解锁（与官方精致即用首个模组一致）
    if (
      entry.locked !== 0 &&
      evolvePhase >= info.showPhase &&
      info.freeUnlock
    ) {
      entry.locked = 0;
      changed = true;
    }
  }

  // 2. currentEquip：精二后未指向已解锁模组 → 指向首个已解锁模组
  if (evolvePhase >= 2) {
    const unlockedFirst = Object.entries(equip).find(([, v]) => v && v.locked === 0);
    if (unlockedFirst) {
      const [uid] = unlockedFirst;
      if (!char.currentEquip || equip[char.currentEquip]?.locked !== 0) {
        char.currentEquip = uid;
        changed = true;
      }
    }
  }
  return changed;
}
