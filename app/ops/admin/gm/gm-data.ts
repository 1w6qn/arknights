/**
 * `/gm/data` 数据装配
 *
 * 面板引导时一次性拉取全部选择器数据（活动/赛季/物品/干员/自走棋棋池/沙盒/肉鸽/
 * 重置键/全局状态/数值边界），与归档 GM 面板 `state.data` 的字段一一对应。
 */
import excel from "@excel/excel";
import config from "@core/config";
import { readJson } from "@utils/file";
import { adminGame } from "../game-gateway";
import { charName, charRarity } from "../admin-names";
import type {
  GmActivityRef,
  GmRlvPayload,
  GmAutochessCharRef,
  GmAutochessItemRef,
  GmCharRef,
  GmDataPayload,
  GmItemRef,
  GmResetKeyRef,
  GmSeasonRef,
  GmStatePayload,
  GmTopicRef,
} from "./gm-types";

/** 面板数值边界（博士等级 1..120，与归档面板 limits 一致） */
const DOCTOR_LEVEL_MIN = 1;
const DOCTOR_LEVEL_MAX = 120;

/**
 * 可重置的存档分区（`reset_key` 白名单）
 *
 * 与 `@game/kernel/fresh-player` 的分区构造器一一对应；
 * 未纳入 `pushFlags`（战斗加密锚点，重置会破坏客户端一致性）。
 */
export const GM_RESET_KEYS: GmResetKeyRef[] = [
  { id: "status", label: "博士状态（等级/昵称/资源计数）" },
  { id: "inventory", label: "背包（计数清零，保留键集）" },
  { id: "troop", label: "干员（清空持有，保留队伍骨架）" },
  { id: "gacha", label: "寻访计数（各卡池进度清零）" },
  { id: "medal", label: "勋章（清空勋章组）" },
  { id: "mission", label: "任务（清空，加载时重新播种）" },
  { id: "building", label: "基建动态进度（保留房间结构）" },
  { id: "homeTheme", label: "首页主题（仅默认主题）" },
  { id: "rlv2", label: "集成战略（空存档）" },
  { id: "skin", label: "皮肤（清空持有）" },
  { id: "dexNav", label: "图鉴索引（清空）" },
];

/**
 * 活动列表（按开始时间倒序）
 * @returns 活动引用数组
 */
function activityRefs(): GmActivityRef[] {
  const basicInfo = excel.ActivityTable?.basicInfo ?? {};
  return Object.entries(basicInfo)
    .map(([id, info]) => ({
      id,
      name: info?.name ?? id,
      type: String(info?.type ?? ""),
      startTime: Number(info?.startTime ?? 0),
      endTime: Number(info?.rewardEndTime ?? info?.endTime ?? 0),
    }))
    .sort((a, b) => b.startTime - a.startTime);
}

/**
 * 物品清单（含面板分类字段）
 * @returns 物品引用数组
 */
function itemRefs(): GmItemRef[] {
  const items = excel.ItemTable?.items ?? {};
  return Object.entries(items).map(([id, info]) => ({
    id,
    name: info?.name ?? id,
    category: String(info?.classifyType ?? ""),
    itemType: String(info?.itemType ?? ""),
    sortId: Number(info?.sortId ?? 0),
  }));
}

/**
 * 干员清单（仅玩家可获取的 char_* 条目）
 * @returns 干员引用数组
 */
function charRefs(): GmCharRef[] {
  const table = excel.CharacterTable ?? {};
  return Object.keys(table)
    .filter((id) => id.startsWith("char_"))
    .map((id) => ({
      id,
      name: charName(id),
      rarity: String(charRarity(id)),
      profession: String(table[id]?.profession ?? ""),
    }));
}

/**
 * 危机合约赛季列表（V1+V2，面板用 V2 选择器）
 * @returns 赛季引用数组
 */
async function crisisSeasonRefs(): Promise<GmSeasonRef[]> {
  const seasons = await adminGame.listCrisisSeasons();
  return seasons.v2.map((id) => ({ id, name: id }));
}

/**
 * 保全派驻赛季列表
 * @returns 赛季引用数组
 */
function towerSeasonRefs(): GmSeasonRef[] {
  const infos = excel.ClimbTowerTable?.seasonInfos ?? {};
  return Object.entries(infos).map(([id, info]) => ({ id, name: info?.name ?? id }));
}

/**
 * 沙盒主题列表
 * @returns 主题引用数组
 */
function sandboxTopicRefs(): GmTopicRef[] {
  const basic = excel.SandboxPermTable?.basicInfo ?? {};
  return Object.entries(basic).map(([id, info]) => ({
    id: info?.topicId ?? id,
    name: info?.topicName ?? id,
  }));
}

/**
 * 集成战略主题列表
 * @returns 主题引用数组
 */
function rlvTopicRefs(): GmTopicRef[] {
  const topics = excel.RoguelikeTopicTable?.topics ?? {};
  return Object.entries(topics).map(([id, info]) => ({ id, name: info?.name ?? id }));
}

/** `data/rlv2/pools.json` 的最小结构（仅取藏品成员 id） */
interface RlvPoolsFile {
  pools?: Record<string, { members?: string[] } | undefined>;
}

/**
 * 集成战略选择器数据（主题 + 藏品目录）
 *
 * 藏品目录取自 `data/rlv2/pools.json` 各池成员里的 `*_relic_*` id（excel 无独立藏品表）；
 * 干员增益 id 无集中数据源，留空由面板自由输入。
 * @returns 集成战略载荷
 */
async function rlvPayload(): Promise<GmRlvPayload> {
  let relics: GmTopicRef[] = [];
  try {
    const file = await readJson<RlvPoolsFile>("./data/rlv2/pools.json");
    const ids = new Set<string>();
    for (const pool of Object.values(file?.pools ?? {})) {
      for (const id of pool?.members ?? []) {
        if (id.includes("_relic_")) ids.add(id);
      }
    }
    relics = [...ids].sort().map((id) => ({ id, name: id }));
  } catch {
    relics = [];
  }
  return { topics: rlvTopicRefs(), relics, charBuffs: [] };
}

/**
 * 当前全局状态（活动时钟 / 合约赛季 / 强制开启 / 资源补丁）
 * @returns 与归档 `data/gm_state.json` 同形的状态对象
 */
export function buildGmState(): GmStatePayload {
  const basicInfo = excel.ActivityTable?.basicInfo ?? {};
  const ts = Number(config.developer?.timestamp ?? -1);
  let clock = "";
  if (ts !== -1) {
    clock =
      Object.entries(basicInfo).find(
        ([, info]) => Number(info?.startTime ?? 0) <= ts && ts <= Number(info?.rewardEndTime ?? 0),
      )?.[0] ?? "";
  }
  return {
    activity_clock: clock,
    activity_clock_ts: ts,
    crisis_v1_season: String(config.activities?.crisisV1 ?? "cc1"),
    crisis_v2_season: String(config.activities?.crisisV2 ?? "cc1"),
    activity_override: [...(config.activities?.forceOpen ?? [])],
    asset_patch: config.assets?.enableMods === true,
  };
}

/**
 * 装配 `/gm/data` 响应体
 * @returns 面板引导数据
 */
export async function buildGmData(): Promise<GmDataPayload> {
  const activities = activityRefs();
  const catalog = adminGame.autoChessGmCatalog();
  const chars: GmAutochessCharRef[] = catalog.chars.map((c) => ({
    id: c.id,
    name: c.name,
    cost: c.cost,
  }));
  const items: GmAutochessItemRef[] = catalog.items.map((i) => ({
    id: i.id,
    name: i.name,
    lv: i.lv,
    type: i.type,
  }));
  return {
    activities,
    full_activities: activities,
    crisis_seasons: await crisisSeasonRefs(),
    tower_seasons: towerSeasonRefs(),
    items: itemRefs(),
    chars: charRefs(),
    autochess: { chars, items },
    sandbox: sandboxTopicRefs(),
    rlv: await rlvPayload(),
    reset_keys: GM_RESET_KEYS,
    gm_state: buildGmState(),
    limits: { doctor_level: { min: DOCTOR_LEVEL_MIN, max: DOCTOR_LEVEL_MAX } },
  };
}
