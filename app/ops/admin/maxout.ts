/**
 * 满配账号共享构建器
 *
 * 从 excel 干员数据生成满配技能/装备结构，供 generate-max-account（single 模式）
 * 与 AdminService.maxOutAccount（管理后台一键满配）复用。
 * 原实现位于 scripts/generate-max-account.ts，为让 app/ 可安全引用（tsc include 仅 app/**）迁入本文件。
 */
import excel from "@excel/excel";
import type { CharacterData } from "@excel/excel";

/** 满配技能条目（存档线格式，与 PlayerCharacter.skills 元素同形） */
export interface MaxedSkill {
  skillId: string;
  unlock: number;
  state: number;
  specializeLevel: number;
  completeUpgradeTime: number;
}

/** 满配模组条目（存档线格式：hide/locked/level） */
export interface MaxedEquipEntry {
  hide: number;
  locked: number;
  level: number;
}

/**
 * 从 excel 干员数据生成满配技能列表（满解锁 + 满专精）
 * @param charData - excel.CharacterTable[charId]（缺表/无干员时返回空列表）
 * @returns 满配技能条目（skillId 取自 excel skills，unlock=1/专三/无训练等待）
 */
export function buildMaxedSkills(charData: CharacterData | undefined): MaxedSkill[] {
  return (charData?.skills ?? [])
    .filter((s) => s?.skillId)
    .map((s) => ({
      skillId: s.skillId,
      unlock: 1,
      state: 0,
      specializeLevel: 3,
      completeUpgradeTime: -1,
    }));
}

/**
 * 从 excel 装备表生成满配装备字典（满级满解锁）
 * @param charId - 干员 id
 * @returns 模组 id 列表与 id → 满配条目字典（无模组干员为空）
 */
export function buildMaxedEquip(charId: string): {
  ids: string[];
  equip: Record<string, MaxedEquipEntry>;
} {
  const ids: string[] = excel.UniequipTable?.charEquip?.[charId] || [];
  const equip: Record<string, MaxedEquipEntry> = {};
  for (const id of ids) equip[id] = { hide: 0, locked: 0, level: 3 };
  return { ids, equip };
}
