/**
 * GM 面板类型定义（契约对齐归档服务端 GM 面板）
 *
 * 归档 `ak.exe`（Nuitka/FastAPI 主服）内嵌的 GM 面板为 base64 资源，其 JS 已完整还原，
 * 本模块的路径与参数名严格对齐该面板：引导端点 `/gm/{config,players,data}` 与
 * 操作端点 `/admin/<op>`（POST + `X-Admin-Token`，参数为 snake_case）。
 *
 * 说明：操作返回体的 `data` 采用 {@link JsonObject}（纯 JSON 域），避免引入模糊类型
 * （全仓 `any` 已清零、`unknown`/`object` 走逐文件棘轮）。
 */
import type { JsonObject } from "@excel/json-value";

/** 活动引用（`/gm/data.activities` 与 `full_activities`） */
export interface GmActivityRef {
  id: string;
  name: string;
  type: string;
  startTime: number;
  endTime: number;
}

/** 赛季引用（危机合约 / 保全派驻） */
export interface GmSeasonRef {
  id: string;
  name: string;
}

/** 物品引用（`/gm/data.items`；category 供面板分类过滤） */
export interface GmItemRef {
  id: string;
  name: string;
  category: string;
  itemType: string;
  sortId: number;
}

/** 干员引用（`/gm/data.chars`） */
export interface GmCharRef {
  id: string;
  name: string;
  rarity: string;
  profession: string;
}

/** 主题/赛季引用（沙盒主题、集成战略主题） */
export interface GmTopicRef {
  id: string;
  name: string;
}

/** 自走棋干员棋引用 */
export interface GmAutochessCharRef {
  id: string;
  name: string;
  cost: number;
}

/** 自走棋道具棋引用（type：EQUIP/MAGIC） */
export interface GmAutochessItemRef {
  id: string;
  name: string;
  lv: number;
  type: string;
}

/** `/gm/data.autochess` 选择器数据 */
export interface GmAutochessPayload {
  chars: GmAutochessCharRef[];
  items: GmAutochessItemRef[];
}

/** 集成战略选择器数据（主题 / 藏品 / 干员增益） */
export interface GmRlvPayload {
  topics: GmTopicRef[];
  relics: GmTopicRef[];
  charBuffs: GmTopicRef[];
}

/** GM 全局状态（对齐归档 `data/gm_state.json` 的三个字段 + 资源补丁运行态） */
export interface GmStatePayload {
  /** 活动时钟命中的活动 ID（未冻结为空串） */
  activity_clock: string;
  /** 活动时钟时间戳（-1 表示跟随真实时间） */
  activity_clock_ts: number;
  /** 危机合约 V1 赛季 */
  crisis_v1_season: string;
  /** 危机合约 V2 赛季 */
  crisis_v2_season: string;
  /** 强制开启的活动 ID 列表 */
  activity_override: string[];
  /** 资源补丁（mods）当前是否启用 */
  asset_patch: boolean;
}

/** 面板数值边界 */
export interface GmLimits {
  doctor_level: { min: number; max: number };
}

/** 数据重置键（reset_key 白名单项） */
export interface GmResetKeyRef {
  id: string;
  label: string;
}

/** `/gm/data` 响应体 */
export interface GmDataPayload {
  activities: GmActivityRef[];
  full_activities: GmActivityRef[];
  crisis_seasons: GmSeasonRef[];
  tower_seasons: GmSeasonRef[];
  items: GmItemRef[];
  chars: GmCharRef[];
  autochess: GmAutochessPayload;
  sandbox: GmTopicRef[];
  rlv: GmRlvPayload;
  reset_keys: GmResetKeyRef[];
  gm_state: GmStatePayload;
  limits: GmLimits;
}

/** `/gm/config` 响应体（`admin_token` 仅回环请求下发，远程为空串） */
export interface GmConfigPayload {
  base_url: string;
  admin_token: string;
  panel_title: string;
  panel_version: string;
}

/** `/gm/players` 响应体 */
export interface GmPlayersPayload {
  players: string[];
  current: string;
}

/** 干员等级阶段（面板「精英化/等级上限」联动用） */
export interface GmCharPhaseOption {
  phase: number;
  maxLevel: number;
}

/** 干员技能槽（面板「技能槽/专精」选择用） */
export interface GmCharSkillOption {
  index: number;
  skillId: string;
}

/** 干员可用模组（面板「模组」选择用） */
export interface GmCharEquipOption {
  id: string;
  name: string;
  typeName: string;
  maxLevel: number;
}

/** `/gm/char` 响应体（干员可选参数，供面板下拉） */
export interface GmCharOptions {
  id: string;
  name: string;
  rarity: string;
  profession: string;
  phases: GmCharPhaseOption[];
  skills: GmCharSkillOption[];
  equips: GmCharEquipOption[];
}

/** `/gm/state` 响应体（赛季页轻量刷新：不重取整份引导数据） */
export interface GmStateResponse {
  gm_state: GmStatePayload;
  players: string[];
  current: string;
  panel_version: string;
}

/** 操作成功响应 */
export interface GmOpOk {
  ok: true;
  op: string;
  detail: string;
  data: JsonObject;
}

/** 操作失败响应（HTTP 状态码表达失败类别：400/404/409/500） */
export interface GmOpFail {
  ok: false;
  detail: string;
}

/** 操作响应联合 */
export type GmOpResponse = GmOpOk | GmOpFail;

/** 服务层成功返回（路由层补 `ok`/`op` 字段成 {@link GmOpOk}） */
export interface GmOpData {
  detail: string;
  data: JsonObject;
}

/**
 * GM 操作失败（携带 HTTP 状态码）
 *
 * 路由层捕获后映射为 `{detail}` 响应体（面板显示原文）：
 * 400 参数/状态非法、404 目标不存在、409 状态冲突（无对局等）、500 未知异常。
 */
export class GmOpError extends Error {
  /** 建议的 HTTP 状态码 */
  readonly status: number;

  /**
   * @param detail - 人类可读失败原因（面板直接展示）
   * @param status - 建议 HTTP 状态码（缺省 400）
   */
  constructor(detail: string, status = 400) {
    super(detail);
    this.name = "GmOpError";
    this.status = status;
  }
}
