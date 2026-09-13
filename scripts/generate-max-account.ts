/**
 * 满配账号生成器（单例模式）
 *
 * 基于当前 excel 数据生成满配账号：全干员（char_ 前缀）+ 全物品 + 大额资源。
 * "随版本更新"：生成时标记 resVersion，启动时版本变化则重新生成（新干员/新物品加入）。
 *
 * 参考：opendoctoratepy tools/生成背包物品.py（物品分类处理）
 *
 * 注意：buildMaxedSkills / buildMaxedEquip 已迁至 app/ops/admin/maxout.ts（供管理后台复用），
 * 此处 re-export 保持公共 API 不变。
 */
import excel from "@excel/excel";
import config from "@core/config/index";
import { readJson } from "@utils/file";
import { PlayerDataManager } from "@game/kernel/PlayerDataManager";
import { acceptJsonValue, setIn } from "@utils/json-path";
import type { PlayerDataModel } from "@excel/types-playerdata";
import {
  buildMaxedSkills,
  buildMaxedEquip,
  type MaxedSkill,
  type MaxedEquipEntry,
} from "@ops/admin/maxout";

export { buildMaxedSkills, buildMaxedEquip } from "@ops/admin/maxout";

/** 阿米娅升变形态条目（`tmpl` 的值——客户端按 tmpl 渲染形态） */
export type MaxedCharFormEntry = {
  skinId: null;
  defaultSkillIndex: number;
  skills: MaxedSkill[];
  currentEquip: string | null;
  equip: Record<string, MaxedEquipEntry>;
};

/**
 * 满配干员条目（官服抓包形态——`player_data.json` 的 `troop.chars` 值）
 *
 * `skin` 为 `null`（抓包实况），与生成模型 `PlayerCharacter`（`skin: string`）不同；
 * 因此写回存档时不走静态属性赋值，而经 JSON 路径接纳点
 * （{@link setIn} + {@link acceptJsonValue}），避免新增断言。
 */
export type MaxedCharEntry = {
  instId: number;
  charId: string;
  favorPoint: number;
  potentialRank: number;
  mainSkillLvl: number;
  skin: null;
  level: number;
  exp: number;
  evolvePhase: number;
  defaultSkillIndex: number;
  gainTime: number;
  skills: MaxedSkill[];
  currentEquip: string | null;
  equip: Record<string, MaxedEquipEntry>;
  voiceLan: string;
  starMark: number;
  currentTmpl?: string;
  tmpl?: Record<string, MaxedCharFormEntry>;
};

/** 存档字段值联合（`Object.keys` 动态遍历用；由生成模型逐字段汇聚） */
type PlayerDataFieldValue = PlayerDataModel[keyof PlayerDataModel];

/**
 * 满配生成器操作的存档视图：生成模型 + 字符串索引签名（交叉挂载，避免 TS2411）
 *
 * 与 `player._playerdata` 同一对象引用，额外支持 `delete data[k]` / `data[k] = v`
 * 这类动态键操作（合并式刷新按 `Object.keys` 逐键搬迁）。
 */
type MaxedAccountData = PlayerDataModel & Record<string, PlayerDataFieldValue | undefined>;

/** 存档 status 的精确视图：生成模型 `PlayerStatus` + 私服扩展标记 */
type MaxedAccountStatus = PlayerDataModel["status"] & { maxAccountResVersion?: string };

/**
 * 满配干员结构（满潜/满级/精二/满信赖/满技能）
 * 参考 data：player_data.json（官服 453 干员抓包——通用结构含 skills/equip/voiceLan/starMark，无 tmpl；
 * 唯一例外 char_002_amiya 带 currentTmpl/tmpl 三形态）。
 * @param instId - 干员实例 ID
 * @param charId - 干员 ID
 * @returns 抓包形态的满配干员条目
 */
export function buildMaxedChar(instId: number, charId: string): MaxedCharEntry {
  const charData = excel.CharacterTable[charId];
  const skills = buildMaxedSkills(charData);
  const { ids: equipIds, equip } = buildMaxedEquip(charId);
  // 精二满级：最高阶段 maxLevel（无 phases 数据回退 90）
  const phases = charData?.phases;
  const maxEvolve = phases && phases.length > 0 ? phases.length - 1 : 2;
  const maxLevel = phases?.[maxEvolve]?.maxLevel ?? 90;
  const base = {
    instId,
    charId,
    favorPoint: 25570,
    potentialRank: 5,
    mainSkillLvl: 7, // 技能 7 级满（专精等级在 skills[].specializeLevel）
    skin: null,
    level: maxLevel,
    exp: 0,
    evolvePhase: maxEvolve,
    defaultSkillIndex: -1,
    gainTime: Math.floor(Date.now() / 1000),
    skills,
    currentEquip: equipIds[0] || null,
    equip,
    voiceLan: "CN_MANDARIN",
    starMark: 0,
  };
  // 阿米娅特殊：多形态模板（升变——客户端按 tmpl 渲染形态，缺字段会异常）
  if (charId === "char_002_amiya") {
    const tmpl: Record<string, MaxedCharFormEntry> = {};
    for (const form of ["char_002_amiya", "char_1001_amiya2", "char_1037_amiya3"]) {
      const tChar = excel.CharacterTable[form];
      const tSkills = buildMaxedSkills(tChar);
      const { ids: tEquipIds, equip: tEquip } = buildMaxedEquip(form);
      tmpl[form] = {
        skinId: null,
        defaultSkillIndex: tSkills.length > 0 ? 0 : -1,
        skills: tSkills,
        currentEquip: tEquipIds[0] || null,
        equip: tEquip,
      };
    }
    return { ...base, currentTmpl: "char_002_amiya", tmpl };
  }
  return base;
}

/**
 * 生成满配账号（合并式刷新——保留玩家进度）
 *
 * single 模式唯一实例：以 player_data.json（官服满级号抓包——uid=1/453 干员/完整模块结构）为基底，
 * 不再逐字段 excel 生成（旧生成器 currentTmpl:null 结构是干员列表卡死根因）。
 * player_data.json 缺失时回退旧 excel 生成逻辑。
 *
 * 合并语义：内容类字段（troop/inventory/consumable/skin——干员与物品随版本新增）以 base 刷新，
 * 其余字段（任务/剧情/基建/勋章/社交/推图等玩家进度）保留当前账号——版本更新不再清空进度。
 *
 * @param player - 目标玩家（单例模式为 uid=1）
 */
export async function generateMaxedAccount(player: PlayerDataManager): Promise<void> {
  const data = player._playerdata as MaxedAccountData;

  // 以 player_data.json 为基底（官服满级号——结构完整，直接作为账号数据）
  const base = await readJson<PlayerDataModel>("./player_data.json").catch(() => null);
  if (base && base.troop?.chars) {
    const uid = data.status?.uid;
    // 合并式刷新：仅内容类字段以 base 覆盖；玩家进度字段保留
    // （troop 假定 instId 映射与 base 一致——同一 player_data.json 基底派生的账号）
    const REFRESH_KEYS = ["troop", "inventory", "consumable", "skin"];
    const preserved: Record<string, PlayerDataFieldValue | undefined> = {};
    for (const k of Object.keys(data)) {
      if (!REFRESH_KEYS.includes(k)) preserved[k] = data[k];
    }
    for (const k of Object.keys(data)) delete data[k];
    Object.assign(data, base);
    for (const k of Object.keys(preserved)) data[k] = preserved[k];
    // 保持当前账号 uid；版本标记（启动时比较——版本变化重新生成）
    const status = data.status as MaxedAccountStatus;
    status.uid = uid;
    status.maxAccountResVersion = config.version.resVersion;
    // 满配资源（独立于保留的进度字段——每次刷新保持大额资源与满级）
    status.gold = 99999999;
    status.androidDiamond = 99999;
    status.iosDiamond = 99999;
    status.level = 120;
    status.exp = 0;
    if (status.maxAp) status.ap = status.maxAp;
    return;
  }

  // 回退：player_data.json 缺失——excel 逐干员生成（旧逻辑，结构见 buildMaxedChar）
  // 1. 全干员（char_ 前缀——玩家可用干员）
  const charIds = Object.keys(excel.CharacterTable).filter((k) =>
    k.startsWith("char_"),
  );
  // 生成模型声明 troop 必填，运行时存档可能缺省——先补空容器再填 chars（与旧 `|| {}` 一致）
  const troop = (data.troop || {}) as PlayerDataModel["troop"];
  data.troop = troop;
  data.troop.chars = {};
  charIds.forEach((charId, i) => {
    // 抓包形态条目（skin:null）经 JSON 路径接纳点落键，与 PlayerCharacter 声明无关
    setIn(data.troop.chars, [String(i + 1)], acceptJsonValue(buildMaxedChar(i + 1, charId)));
  });

  // 2. 全物品（参考 opendoctoratepy 生成背包物品.py）
  data.inventory = {};
  data.consumable = {};
  const items = excel.ItemTable?.items || {};
  for (const [itemId, info] of Object.entries(items)) {
    const classify = info?.classifyType;
    const sortId = info?.sortId ?? 0;
    if (sortId <= 0) continue;
    if (classify === "CONSUME") {
      data.consumable[itemId] = { "0": { ts: -1, count: 999 } };
    } else if (classify === "NORMAL" || classify === "MATERIAL") {
      data.inventory[itemId] = 999;
    }
  }

  // 3. 大额资源/状态
  const status = (data.status || {}) as MaxedAccountStatus;
  data.status = status;
  status.gold = 99999999;
  status.androidDiamond = 99999;
  status.iosDiamond = 99999;
  status.level = 120;
  status.exp = 0;
  if (status.maxAp) status.ap = status.maxAp;

  // 4. 版本标记（启动时比较——版本变化重新生成）
  status.maxAccountResVersion = config.version.resVersion;
}
