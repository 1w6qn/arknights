/**
 * GM 服务层（归档 GM 面板能力的本仓实现）
 *
 * 契约来源：归档 `ak.exe` 内嵌 GM 面板（已完整还原其 JS/CSS/HTML）。本服务提供：
 * - `/gm/data` 装配（见 gm-data.ts）
 * - `/admin/<op>` 全部操作的业务实现（参数名与归档面板逐字对齐）
 *
 * 复用策略：能在既有 `AdminService` 上完成的（活动切换/邮件/关卡/肉鸽/导入导出）一律委托，
 * 不重复实现；其余（博士等级、全量发放、清仓、重置、沙盒、保全派驻、自走棋 GM）在本文件内
 * 经 `PlayerDataManager.update` 完成，game 运行期取值统一走 `game-gateway`。
 *
 * 失败语义：抛 {@link GmOpError}（携带 HTTP 状态码），由路由层映射为 `{detail}` 响应体；
 * 成功返回 `{detail, data}`（data 为纯 JSON 域，面板原样展示）。
 */
import { mkdir, rm } from "fs/promises";
import path from "path";
import excel from "@excel/excel";
import type { ItemType } from "@excel/excel";
import config from "@core/config";
import type { JsonObject, JsonValue } from "@excel/json-value";
import type { PlayerDataManager } from "@game/kernel/player-data-manager";
import { logger } from "@utils/logger";
import { logService } from "@logs/log-service";
import { now } from "@utils/time";
import { readJsonSync, writeJson } from "@utils/file";
import { adminGame } from "../game-gateway";
import { AdminService } from "../admin-service";
import { reloadMods } from "../../assets/asset";
import { GM_RESET_KEYS } from "./gm-data";
import { charName, charRarity } from "../admin-names";
import { GmOpError } from "./gm-types";
import type { GmCharOptions, GmOpData } from "./gm-types";

/** 干员可修改属性（归档面板「干员调整」页字段） */
export interface GmCharAttrs {
  /** 目标干员 ID（char_*） */
  char_id: string;
  level?: number;
  evolve_phase?: number;
  favor_point?: number;
  potential_rank?: number;
  main_skill_lvl?: number;
  skill_idx_lst?: number[];
  specialize_level?: number;
  equip_id_lst?: string[];
  equip_level?: number;
  tmpl_id?: string;
}

/** 商店货币字段（`status` 内的凭证/点数；与归档面板「发放商店货币」对应） */
const SHOP_CURRENCY_FIELDS = [
  "gold",
  "diamondShard",
  "socialPoint",
  "hggShard",
  "lggShard",
  "classicShard",
] as const;

/** 商店货币发放目标值（socialPoint 有 3000 上限，单列） */
const SHOP_CURRENCY_VALUES: Record<(typeof SHOP_CURRENCY_FIELDS)[number], number> = {
  gold: 9999999,
  diamondShard: 9999999,
  socialPoint: 3000,
  hggShard: 9999999,
  lggShard: 9999999,
  classicShard: 9999999,
};

/** 家具发放数量（归档面板文案：全家具各 99 件，覆盖现有数量） */
const FURNITURE_COUNT = 99;

/**
 * 当前活动切换参数（供 GM 只改其中一项时保持其余不变）
 * @returns 与 `AdminService.switchActivity` 入参同形的当前值
 */
function currentSwitchParams(): {
  timestamp: number;
  forceOpen: string[];
  crisisV1: string;
  crisisV2: string;
} {
  return {
    timestamp: Number(config.developer?.timestamp ?? -1),
    forceOpen: [...(config.activities?.forceOpen ?? [])],
    crisisV1: String(config.activities?.crisisV1 ?? "cc1"),
    crisisV2: String(config.activities?.crisisV2 ?? "cc1"),
  };
}

/**
 * 把委托调用（AdminService 等）抛出的领域错误收口为 {@link GmOpError}(400)
 *
 * 既有管理服务对「赛季不存在 / 活动不存在 / 时间非法」等一律抛普通 Error，
 * 若原样冒泡会被路由层当成 500；这里统一按参数错误（400）回给面板。
 * @param error - 捕获到的异常
 * @returns 归一化后的 GmOpError（已是 GmOpError 则原样返回）
 */
function asOpError(error: Error): GmOpError {
  return error instanceof GmOpError ? error : new GmOpError(error.message || "执行失败", 400);
}

/**
 * GM 服务（单例 `gmService`）
 */
export class GmService {
  /** 复用的管理服务（活动切换/邮件/关卡/肉鸽/导入导出） */
  private _admin = new AdminService();

  /** 会话服对局上报缓存（uid → 上报内容；仅内存态，重启即失效） */
  private _battleReports = new Map<
    string,
    { sceneId: string; squad: number; secretary: string; curRound: number; ts: number }
  >();

  /**
   * 取玩家（已加载直接返回；未加载懒加载；不存在 404）
   * @param uid - 玩家 uid
   * @returns 玩家数据管理器
   */
  private async _getPlayer(uid: string): Promise<PlayerDataManager> {
    const cached = adminGame.accountManager.data[uid];
    if (cached) return cached;
    try {
      return await adminGame.accountManager.getPlayerData(uid);
    } catch {
      throw new GmOpError(`用户不存在: ${uid}`, 404);
    }
  }

  /**
   * 落盘玩家存档
   * @param uid - 玩家 uid
   */
  private async _savePlayer(uid: string): Promise<void> {
    await adminGame.accountManager.flushSave(uid);
  }

  /**
   * 审计日志（统一日志服务；失败不阻断业务）
   * @param action - 操作名（自动加 `gm:` 前缀）
   * @param uid    - 目标 uid
   * @param detail - 详情
   */
  private _audit(action: string, uid: string, detail: string): void {
    try {
      logService.emitAudit({ ts: now(), action: `gm:${action}`, uid, detail });
    } catch (error) {
      logger.warn("GmService", `审计日志写入失败: ${(error as Error).message}`);
    }
  }

  /**
   * 委托调用包装（把 AdminService 抛出的领域错误收口为 400）
   * @param fn - 委托调用
   * @returns 委托返回值
   */
  private async _delegate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw asOpError(error as Error);
    }
  }

  /**
   * 构造「全新新号」存档（以当前存档为结构脚手架）
   * @param pd - 玩家数据管理器
   * @returns 全新存档对象（纯 JSON）
   */
  private _freshData(pd: PlayerDataManager): JsonObject {
    const template = JSON.parse(JSON.stringify(pd._playerdata)) as JsonObject;
    const status = pd._playerdata.status;
    return adminGame.freshPlayerJson(template, {
      uid: pd.uid,
      nickName: status?.nickName || `博士${pd.uid}`,
      nickNumber: String(status?.nickNumber ?? "1"),
      registerTs: now(),
    });
  }

  /**
   * 用给定存档对象替换指定玩家（经既有 importUser 通道：写临时文件 → 导入 → 清理）
   * @param uid  - 玩家 uid
   * @param data - 完整存档对象
   */
  private async _replaceData(uid: string, data: JsonObject): Promise<void> {
    const dir = "./data/admin";
    const tmpPath = path.join(dir, `gm-reset-${uid}-${now()}.json`);
    await mkdir(dir, { recursive: true });
    await writeJson(tmpPath, data);
    try {
      await this._delegate(() => this._admin.importUser(tmpPath, uid));
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  /* ===================== 赛季与活动 ===================== */

  /**
   * 活动时钟：把开发者时间戳冻结到目标活动的时间窗（`activity_id` 缺失 = 恢复真实时间）
   * @param activityId - 目标活动 ID（null/缺省 = 恢复真实时间）
   * @returns 操作结果
   */
  async activityClock(activityId?: string | null): Promise<GmOpData> {
    const current = currentSwitchParams();
    if (!activityId) {
      const result = await this._delegate(() => this._admin.switchActivity({ ...current, timestamp: -1 }));
      this._audit("activity_clock", "all", "恢复真实时间");
      return {
        detail: "活动时钟已恢复真实时间",
        data: { timestamp: result.timestamp, effectiveTs: result.effectiveTs },
      };
    }
    const info = excel.ActivityTable?.basicInfo?.[activityId];
    if (!info) throw new GmOpError(`活动不存在: ${activityId}`, 404);
    const result = await this._delegate(() =>
      this._admin.switchActivity({ ...current, timestamp: Number(info.startTime) }),
    );
    this._audit("activity_clock", "all", `${activityId} ts=${result.timestamp}`);
    return {
      detail: `活动时钟已冻结到 ${activityId} 时间窗（ts=${result.timestamp}）`,
      data: { activity_id: activityId, timestamp: result.timestamp, effectiveTs: result.effectiveTs },
    };
  }

  /**
   * 活动切换：强制开启目标活动（`activity_id` 缺失 = 取消全部强制开启）
   * @param activityId - 目标活动 ID
   * @returns 操作结果
   */
  async activitySwitch(activityId?: string | null): Promise<GmOpData> {
    const current = currentSwitchParams();
    const forceOpen = activityId ? [activityId] : [];
    const result = await this._delegate(() => this._admin.switchActivity({ ...current, forceOpen }));
    this._audit("activity_switch", "all", forceOpen.join(",") || "(取消)");
    return {
      detail: activityId ? `已强制开启 ${activityId}` : "已取消全部强制开启活动",
      data: { forceOpen: result.forceOpen, openCount: result.openCount },
    };
  }

  /**
   * 危机合约赛季（全服级；`season_id` 缺失 = 恢复 data/config.json 中的配置值）
   * @param seasonId - 赛季 ID
   * @returns 操作结果
   */
  async crisisSeason(seasonId?: string): Promise<GmOpData> {
    const current = currentSwitchParams();
    let target = seasonId;
    if (!target) {
      const disk = readJsonSync<typeof config>("./data/config.json");
      target = String(disk.activities?.crisisV2 ?? "cc1");
    }
    const result = await this._delegate(() => this._admin.switchActivity({ ...current, crisisV2: target }));
    this._audit("crisis_season", "all", target);
    return {
      detail: `危机合约 V2 赛季已切换为 ${result.crisisV2}`,
      data: { crisis_v2_season: result.crisisV2 },
    };
  }

  /**
   * 保全派驻赛季（玩家级：写入 `tower.season.id`）
   * @param body - { player_id, season_id? }
   * @returns 操作结果
   */
  async towerSeason(body: { player_id: string; season_id?: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    let before = "";
    await pd.update(async (draft) => {
      if (!draft.tower?.season) throw new GmOpError("存档缺少 tower.season 分区", 409);
      before = String(draft.tower.season.id ?? "");
      draft.tower.season.id = body.season_id ?? "";
      draft.tower.season.finishTs = 0;
    });
    await this._savePlayer(body.player_id);
    this._audit("tower_season", body.player_id, `${before} → ${body.season_id ?? "(清除)"}`);
    return {
      detail: `保全派驻赛季已设置为 ${body.season_id ?? "（清除）"}`,
      data: { season_id: body.season_id ?? "", previous: before },
    };
  }

  /**
   * 资源补丁（全服级、免重启）：切换 `assets.enableMods` 并热重载 mod 列表
   * @param state - "on" | "off"
   * @returns 操作结果
   */
  async assetPatch(state: string): Promise<GmOpData> {
    const on = state === "on" ? true : state === "off" ? false : null;
    if (on === null) throw new GmOpError(`state 只能是 on/off，收到: ${state}`);
    const disk = readJsonSync<typeof config>("./data/config.json");
    disk.assets = { ...(disk.assets ?? config.assets), enableMods: on };
    await writeJson("./data/config.json", disk);
    config.assets = disk.assets;
    await reloadMods();
    this._audit("asset_patch", "all", on ? "on" : "off");
    return {
      detail: `资源补丁已${on ? "开启" : "关闭"}（已热重载，无需重启）`,
      data: { asset_patch: on },
    };
  }

  /* ===================== 养成工具 ===================== */

  /**
   * 修改博士等级（1..120）
   * @param body - { player_id, level }
   * @returns 操作结果
   */
  async doctorLevel(body: { player_id: string; level: number }): Promise<GmOpData> {
    const level = Math.trunc(body.level);
    if (!Number.isFinite(level) || level < 1 || level > 120) {
      throw new GmOpError("博士等级需在 1..120");
    }
    const pd = await this._getPlayer(body.player_id);
    let before = 0;
    await pd.update(async (draft) => {
      before = Number(draft.status.level ?? 0);
      draft.status.level = level;
    });
    await this._savePlayer(body.player_id);
    this._audit("doctor_level", body.player_id, `${before} → ${level}`);
    return { detail: `博士等级 ${before} → ${level}`, data: { level, previous: before } };
  }

  /**
   * 发放全部可获取干员（已拥有的跳过）
   * @param body - { player_id }
   * @returns 操作结果
   */
  async charGrantAll(body: { player_id: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    const owned = new Set(
      Object.values(pd._playerdata.troop?.chars ?? {}).map((c) => c.charId),
    );
    const table = excel.CharacterTable ?? {};
    const targets = Object.keys(table).filter(
      (id) =>
        id.startsWith("char_") &&
        table[id]?.isNotObtainable !== true &&
        table[id]?.profession !== "TOKEN" &&
        table[id]?.profession !== "TRAP" &&
        !owned.has(id),
    );
    let granted = 0;
    for (const charId of targets) {
      const res = await pd.char.onCharGet([charId, { from: "ADMIN" }]);
      if (res?.isNew) granted++;
    }
    await this._savePlayer(body.player_id);
    this._audit("char_grant_all", body.player_id, `新增 ${granted} 名`);
    return {
      detail: `已发放全部可获取干员：新增 ${granted} 名（跳过已拥有 ${owned.size} 名）`,
      data: { granted, skipped: owned.size, candidates: targets.length },
    };
  }

  /**
   * 发放全部皮肤（覆盖 `skin_table.charSkins` 全量）
   * @param body - { player_id }
   * @returns 操作结果
   */
  async skinGrantAll(body: { player_id: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    const skins = Object.keys(excel.SkinTable?.charSkins ?? {});
    let n = 0;
    for (const skinId of skins) {
      await pd.inventory.gainItem({ id: skinId, count: 1, type: "CHAR_SKIN" as ItemType });
      n++;
    }
    await this._savePlayer(body.player_id);
    this._audit("skin_grant_all", body.player_id, `${n} 件`);
    return { detail: `已发放全部皮肤 ${n} 件`, data: { skins: n } };
  }

  /**
   * 发放全部家具各 99 件（覆盖现有数量）
   * @param body - { player_id }
   * @returns 操作结果
   */
  async furniGrantAll(body: { player_id: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    const furnitures = excel.BuildingData?.customData?.furnitures ?? {};
    const ids = Object.keys(furnitures);
    await pd.update(async (draft) => {
      draft.building.furniture = draft.building.furniture ?? {};
      for (const id of ids) {
        const inUse = Number(draft.building.furniture[id]?.inUse ?? 0);
        draft.building.furniture[id] = { count: FURNITURE_COUNT, inUse };
      }
    });
    await this._savePlayer(body.player_id);
    this._audit("furni_grant_all", body.player_id, `${ids.length} 种 x${FURNITURE_COUNT}`);
    return {
      detail: `已发放全部家具 ${ids.length} 种 x${FURNITURE_COUNT}`,
      data: { furniture: ids.length, count: FURNITURE_COUNT },
    };
  }

  /**
   * 发放商店货币/凭证（`status` 内的凭证与点数）
   * @param body - { player_id }
   * @returns 操作结果
   */
  async shopCurrencyGrant(body: { player_id: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    await pd.update(async (draft) => {
      for (const field of SHOP_CURRENCY_FIELDS) {
        draft.status[field] = SHOP_CURRENCY_VALUES[field];
      }
    });
    await this._savePlayer(body.player_id);
    this._audit("shop_currency_grant", body.player_id, SHOP_CURRENCY_FIELDS.join(","));
    return {
      detail: `已发放商店货币：${SHOP_CURRENCY_FIELDS.join(" / ")}`,
      data: { fields: SHOP_CURRENCY_FIELDS.length },
    };
  }

  /**
   * 解锁全部关卡（委托 AdminService）
   * @param body - { player_id }
   * @returns 操作结果
   */
  async stageUnlockAll(body: { player_id: string }): Promise<GmOpData> {
    const result = await this._delegate(() => this._admin.unlockAllStages(body.player_id));
    return {
      detail: `已解锁全部关卡：新增 ${result.stages} / 共 ${result.total}`,
      data: { stages: result.stages, total: result.total },
    };
  }

  /* ===================== 干员调整 ===================== */

  /**
   * 按 char_id 找玩家持有的干员实例
   * @param pd     - 玩家数据管理器
   * @param charId - 干员 ID
   * @returns 实例 ID
   */
  private _instIdOf(pd: PlayerDataManager, charId: string): number {
    const found = Object.values(pd._playerdata.troop?.chars ?? {}).find((c) => c.charId === charId);
    if (!found) throw new GmOpError(`玩家未持有干员: ${charId}`, 404);
    return found.instId;
  }

  /**
   * 修改干员属性（免费路径；等级/精英化按 phases 钳制）
   * @param body - 归档面板「干员调整」字段（snake_case）
   * @returns 操作结果
   */
  async charModify(body: { player_id: string } & GmCharAttrs): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    const instId = this._instIdOf(pd, body.char_id);
    const info = excel.charData(body.char_id);
    const phases = info?.phases;
    const maxEvolve = phases?.length ? phases.length - 1 : 2;
    const maxPotential = info?.maxPotentialLevel ?? 5;
    const changed: string[] = [];
    await pd.update(async (draft) => {
      const target = draft.troop.chars[String(instId)];
      if (!target) throw new GmOpError(`干员不存在: instId=${instId}`, 404);
      if (body.evolve_phase !== undefined) {
        target.evolvePhase = Math.min(Math.max(body.evolve_phase, 0), maxEvolve);
        changed.push(`evolvePhase=${target.evolvePhase}`);
      }
      const maxLevel = phases?.[target.evolvePhase]?.maxLevel ?? 90;
      if (body.level !== undefined) {
        target.level = Math.min(Math.max(body.level, 1), maxLevel);
        changed.push(`level=${target.level}`);
      }
      if (body.potential_rank !== undefined) {
        target.potentialRank = Math.min(Math.max(body.potential_rank, 0), maxPotential);
        changed.push(`potentialRank=${target.potentialRank}`);
      }
      if (body.main_skill_lvl !== undefined) {
        target.mainSkillLvl = Math.min(Math.max(body.main_skill_lvl, 1), 7);
        changed.push(`mainSkillLvl=${target.mainSkillLvl}`);
      }
      if (body.favor_point !== undefined) {
        target.favorPoint = Math.max(0, Math.trunc(body.favor_point));
        changed.push(`favorPoint=${target.favorPoint}`);
      }
      if (body.skill_idx_lst?.length) {
        const idx = Math.max(0, Math.trunc(body.skill_idx_lst[0]));
        const skill = target.skills?.[idx];
        if (!skill) throw new GmOpError(`技能槽不存在: index=${idx}`, 404);
        if (body.specialize_level !== undefined) {
          skill.specializeLevel = Math.min(Math.max(body.specialize_level, 0), 3);
          changed.push(`skill[${idx}].specializeLevel=${skill.specializeLevel}`);
        }
        target.defaultSkillIndex = idx;
        changed.push(`defaultSkillIndex=${idx}`);
      }
      if (body.equip_id_lst?.length) {
        const equipId = body.equip_id_lst[0];
        if (!excel.UniequipTable?.equipDict?.[equipId]) {
          throw new GmOpError(`未知模组: ${equipId}`, 404);
        }
        target.equip = target.equip ?? {};
        target.equip[equipId] = {
          hide: 0,
          locked: 0,
          level: Math.max(1, Math.trunc(body.equip_level ?? 1)),
        };
        target.currentEquip = equipId;
        changed.push(`equip=${equipId}@${target.equip[equipId].level}`);
      }
      if (body.tmpl_id !== undefined) {
        target.currentTmpl = body.tmpl_id;
        changed.push(`tmpl=${body.tmpl_id}`);
      }
      target.exp = 0;
    });
    if (!changed.length) throw new GmOpError("未提供任何要修改的属性");
    await this._savePlayer(body.player_id);
    this._audit("char", body.player_id, `${body.char_id} ${changed.join(" ")}`);
    return {
      detail: `${body.char_id} 已修改：${changed.join("，")}`,
      data: { char_id: body.char_id, inst_id: instId, changed },
    };
  }

  /**
   * 单个干员满养成（精二满级/满潜/满技能/专三/满信赖/满专精装备）
   * @param body - { player_id, char_id }
   * @returns 操作结果
   */
  async charMax(body: { player_id: string; char_id: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    const instId = this._instIdOf(pd, body.char_id);
    const charData = excel.charData(body.char_id);
    const phases = charData?.phases;
    const maxEvolve = phases?.length ? phases.length - 1 : 2;
    const skills = adminGame.buildMaxedSkills(charData);
    const { ids: equipIds, equip } = adminGame.buildMaxedEquip(body.char_id);
    await pd.update(async (draft) => {
      const ch = draft.troop.chars[String(instId)];
      if (!ch) throw new GmOpError(`干员不存在: instId=${instId}`, 404);
      ch.evolvePhase = maxEvolve;
      ch.level = phases?.[maxEvolve]?.maxLevel ?? 90;
      ch.exp = 0;
      ch.potentialRank = 5;
      ch.mainSkillLvl = 7;
      ch.favorPoint = 25570;
      if (skills.length) {
        ch.skills = skills;
        ch.defaultSkillIndex = ch.defaultSkillIndex ?? 0;
      }
      ch.currentEquip = equipIds[0] || null;
      ch.equip = equip;
    });
    await this._savePlayer(body.player_id);
    this._audit("char_max", body.player_id, body.char_id);
    return {
      detail: `${body.char_id} 已满养成`,
      data: { char_id: body.char_id, inst_id: instId, equips: equipIds.length },
    };
  }

  /**
   * 全部已有干员满养成（委托 AdminService.maxAllChars）
   * @param body - { player_id }
   * @returns 操作结果
   */
  async charMaxAll(body: { player_id: string }): Promise<GmOpData> {
    const result = await this._delegate(() => this._admin.maxAllChars(body.player_id));
    return { detail: `已拉满全部已有干员：${result.chars} 名`, data: { chars: result.chars } };
  }

  /**
   * 干员可选参数（面板下拉数据：阶段等级上限/技能槽/可用模组）
   * @param charId - 干员 ID（char_*）
   * @returns 面板用的选项集合
   */
  charOptions(charId: string): GmCharOptions {
    const info = excel.charData(charId);
    if (!info) throw new GmOpError(`未知干员: ${charId}`, 404);
    const phases = (info.phases ?? []).map((phase, index) => ({
      phase: index,
      maxLevel: Number(phase?.maxLevel ?? 90),
    }));
    const skills = (info.skills ?? []).map((skill, index) => ({
      index,
      skillId: String(skill?.skillId ?? ""),
    }));
    const equipIds = excel.UniequipTable?.charEquip?.[charId] ?? [];
    const equips = equipIds.map((equipId) => {
      const equip = excel.UniequipTable?.equipDict?.[equipId];
      // UniEquipData 无 levelList：模组等级上限恒为 3（itemCost 只覆盖各阶段升级消耗）
      return {
        id: equipId,
        name: String(equip?.uniEquipName ?? equipId),
        typeName: String(equip?.typeName1 ?? ""),
        maxLevel: 3,
      };
    });
    return {
      id: charId,
      name: charName(charId),
      rarity: String(charRarity(charId)),
      profession: String(info.profession ?? ""),
      phases,
      skills,
      equips,
    };
  }

  /* ===================== 物品发放 / 清理 ===================== */

  /**
   * 清理物品：指定 item_id 删单件，缺省清空整个仓库（货币/凭证与家具不受影响）
   * @param body - { player_id, item_id? }
   * @returns 操作结果
   */
  async itemClear(body: { player_id: string; item_id?: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    let cleared = 0;
    await pd.update(async (draft) => {
      if (body.item_id) {
        if (draft.inventory[body.item_id] !== undefined) {
          delete draft.inventory[body.item_id];
          cleared++;
        }
        if (draft.consumable[body.item_id] !== undefined) {
          delete draft.consumable[body.item_id];
          cleared++;
        }
        return;
      }
      for (const key of Object.keys(draft.inventory)) {
        draft.inventory[key] = 0;
        cleared++;
      }
      for (const key of Object.keys(draft.consumable)) {
        delete draft.consumable[key];
        cleared++;
      }
    });
    if (!cleared) {
      throw new GmOpError(body.item_id ? `物品不存在: ${body.item_id}` : "仓库已为空", 404);
    }
    await this._savePlayer(body.player_id);
    this._audit("item_clear", body.player_id, body.item_id ?? "ALL");
    return {
      detail: body.item_id ? `已删除物品 ${body.item_id}` : `已清空仓库（${cleared} 项，货币/凭证/家具保留）`,
      data: { item_id: body.item_id ?? "ALL", cleared },
    };
  }

  /**
   * 发送邮件（委托 AdminService.sendMail）
   * @param body - { player_id, items[], subject?, content? }
   * @returns 操作结果
   */
  async mailGrant(body: {
    player_id: string;
    items: { id: string; count: number }[];
    subject?: string;
    content?: string;
  }): Promise<GmOpData> {
    if (!body.items.length) throw new GmOpError("邮件附件为空：请先添加物品");
    const subject = body.subject?.trim() || "系统补给";
    const content = body.content?.trim() || "来自管理员的补给。";
    await this._delegate(() => this._admin.sendMail(body.player_id, { subject, content, items: body.items }));
    return {
      detail: `已向 ${body.player_id} 发送邮件「${subject}」（附件 ${body.items.length} 种）`,
      data: { subject, attachments: body.items.length },
    };
  }

  /* ===================== 集成战略 ===================== */

  /**
   * 修改肉鸽难度（`current.game.modeGrade`）
   * @param body - { player_id, n }
   * @returns 操作结果
   */
  async rlv2Difficulty(body: { player_id: string; n: number }): Promise<GmOpData> {
    const result = await this._admin.rogueModifyState(body.player_id, [
      { op: "set", path: "game.modeGrade", value: Math.trunc(body.n) },
    ]);
    if (!result.ok) throw new GmOpError(result.error ?? "修改失败", 409);
    return { detail: `肉鸽难度已设置为 ${Math.trunc(body.n)}`, data: { n: Math.trunc(body.n) } };
  }

  /**
   * 修改肉鸽藏品层数（`layer` 缺省 = +1）
   * @param body - { player_id, relic_id, layer? }
   * @returns 操作结果
   */
  async rlv2RelicLayer(body: {
    player_id: string;
    relic_id: string;
    layer?: number;
  }): Promise<GmOpData> {
    const ops =
      body.layer === undefined
        ? [{ op: "inc" as const, path: `inventory.relic.${body.relic_id}.layer`, value: 1 }]
        : [
            {
              op: "set" as const,
              path: `inventory.relic.${body.relic_id}.layer`,
              value: Math.trunc(body.layer),
            },
          ];
    const result = await this._admin.rogueModifyState(body.player_id, ops);
    if (!result.ok) throw new GmOpError(result.error ?? "修改失败", 409);
    return {
      detail: `藏品 ${body.relic_id} 层数已${body.layer === undefined ? "+1" : `设为 ${body.layer}`}`,
      data: { relic_id: body.relic_id, layer: body.layer ?? null },
    };
  }

  /**
   * 发放肉鸽干员增益（追加到 `troop.chars[instId].charBuff`）
   * @param body - { player_id, char_id, char_buff_id }
   * @returns 操作结果
   */
  async rlv2CharBuff(body: {
    player_id: string;
    char_id: string;
    char_buff_id: string;
  }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    const troop = pd.rlv2?.current?.troop;
    if (!troop) throw new GmOpError("该玩家无进行中的集成战略对局", 409);
    const entry = Object.entries(troop.chars).find(([, c]) => c.charId === body.char_id);
    if (!entry) throw new GmOpError(`对局内不存在干员: ${body.char_id}`, 404);
    const [instId, ch] = entry;
    const buffs = [...(ch.charBuff ?? [])];
    if (!buffs.includes(body.char_buff_id)) buffs.push(body.char_buff_id);
    const result = await this._admin.rogueModifyState(body.player_id, [
      { op: "set", path: `troop.chars.${instId}.charBuff`, value: buffs },
    ]);
    if (!result.ok) throw new GmOpError(result.error ?? "修改失败", 409);
    return {
      detail: `${body.char_id} 已获得增益 ${body.char_buff_id}`,
      data: { char_id: body.char_id, buffs },
    };
  }

  /* ===================== 沙盒管理 ===================== */

  /**
   * 修改沙盒赛季（`summary.sandboxV2SummaryData[topic].seasonType`）
   * @param body - { player_id, topic_id, season_idx }
   * @returns 操作结果
   */
  async sandboxSeason(body: {
    player_id: string;
    topic_id: string;
    season_idx: number;
  }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    const seasonType = Math.trunc(body.season_idx);
    await pd.update(async (draft) => {
      const summary = draft.sandboxPerm?.summary?.sandboxV2SummaryData?.[body.topic_id];
      if (!summary) throw new GmOpError(`沙盒主题无存档: ${body.topic_id}`, 404);
      summary.seasonType = seasonType;
    });
    await this._savePlayer(body.player_id);
    this._audit("sandbox_season", body.player_id, `${body.topic_id} seasonType=${seasonType}`);
    return {
      detail: `沙盒赛季已设置为 ${seasonType}（主题 ${body.topic_id}）`,
      data: { topic_id: body.topic_id, season_idx: seasonType },
    };
  }

  /**
   * 修改沙盒敌潮（写入 `main.enemy.enemyRush[node_id]` 的敌潮组）
   * @param body - { player_id, topic_id, enemy_id, node_id }
   * @returns 操作结果
   */
  async sandboxEnemyRush(body: {
    player_id: string;
    topic_id: string;
    enemy_id: string;
    node_id: string;
  }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    await pd.update(async (draft) => {
      const topic = draft.sandboxPerm?.template?.sandboxV2TemplateData?.[body.topic_id];
      if (!topic) throw new GmOpError(`沙盒主题无模板数据: ${body.topic_id}`, 404);
      topic.main.enemy = topic.main.enemy ?? { enemyRush: {}, rareAnimal: {} };
      const day = Number(draft.sandboxPerm?.summary?.sandboxV2SummaryData?.[body.topic_id]?.day ?? 0);
      topic.main.enemy.enemyRush[body.node_id] = {
        enemyRushType: 0,
        groupKey: body.enemy_id,
        state: 0,
        day,
        path: [],
        enemy: [],
        boss: {},
        badge: 0,
        src: { type: 0, id: "" },
      };
    });
    await this._savePlayer(body.player_id);
    this._audit("sandbox_enemy_rush", body.player_id, `${body.topic_id}/${body.node_id}=${body.enemy_id}`);
    return {
      detail: `敌潮已写入节点 ${body.node_id}（主题 ${body.topic_id}，组 ${body.enemy_id}）`,
      data: { topic_id: body.topic_id, node_id: body.node_id, enemy_id: body.enemy_id },
    };
  }

  /* ===================== 数据重置 ===================== */

  /**
   * 重置单个存档分区（白名单见 `GM_RESET_KEYS`）
   * @param body - { player_id, key }
   * @returns 操作结果
   */
  async resetKey(body: { player_id: string; key: string }): Promise<GmOpData> {
    const def = GM_RESET_KEYS.find((k) => k.id === body.key);
    if (!def) {
      throw new GmOpError(
        `未知重置键: ${body.key}（可用: ${GM_RESET_KEYS.map((k) => k.id).join(", ")}）`,
      );
    }
    const pd = await this._getPlayer(body.player_id);
    const current = JSON.parse(JSON.stringify(pd._playerdata)) as JsonObject;
    const fresh = this._freshData(pd);
    const merged: JsonObject = { ...current, [def.id]: fresh[def.id] };
    await this._replaceData(body.player_id, merged);
    this._audit("reset_key", body.player_id, def.id);
    return { detail: `已重置分区「${def.label}」`, data: { key: def.id } };
  }

  /**
   * 恢复初始模板（整份存档重建为全新新号）
   * @param body - { player_id }
   * @returns 操作结果
   */
  async resetAll(body: { player_id: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.player_id);
    const fresh = this._freshData(pd);
    await this._replaceData(body.player_id, fresh);
    this._audit("reset_all", body.player_id, "恢复初始模板");
    return { detail: `玩家 ${body.player_id} 已恢复初始模板`, data: { player_id: body.player_id } };
  }

  /**
   * 清空全部玩家存档
   *
   * 本仓存档在主数据层（SQLite/MySQL/PG 的 player_data 表），语义等价实现为
   * 「全部账号逐一重建为初始模板」（账号与登录凭据保留，玩家下次登录即为新号）。
   * @returns 操作结果
   */
  async resetDb(): Promise<GmOpData> {
    const uids = adminGame.accountManager.getPlayerUidList();
    let done = 0;
    for (const uid of uids) {
      try {
        const pd = await this._getPlayer(uid);
        await this._replaceData(uid, this._freshData(pd));
        done++;
      } catch (error) {
        logger.warn("GmService", `reset_db 跳过 ${uid}: ${(error as Error).message}`);
      }
    }
    this._audit("reset_db", "all", `${done}/${uids.length}`);
    return {
      detail: `已重置全部玩家存档：${done}/${uids.length} 个账号恢复初始模板（账号保留）`,
      data: { total: uids.length, reset: done },
    };
  }

  /* ===================== 卫戍协议（自走棋）GM ===================== */

  /**
   * 执行自走棋 GM 指令（委托 `AutoChessManager.executeGm`）
   * @param body - { uid?, code, params? }
   * @returns 操作结果
   */
  async autochessGm(body: {
    uid?: string;
    code: string;
    params?: (string | number | boolean | null)[];
  }): Promise<GmOpData> {
    const uid = body.uid?.trim() || config.singleUid || "1";
    const pd = await this._getPlayer(uid);
    const result = await pd.autoChess.executeGm(body.code, body.params ?? []);
    if (!result.ok) throw new GmOpError(result.reason, result.status);
    this._audit("autochess_gm", uid, `${body.code} ${JSON.stringify(body.params ?? [])}`);
    return {
      detail: `自走棋 GM ${body.code} 执行完成`,
      data: JSON.parse(JSON.stringify(result.data)) as JsonValue as JsonObject,
    };
  }

  /**
   * 服务间：会话服上报「对局开始」（登记场景/编队/助战，供结算与名片使用）
   * @param body - { uid, sceneId|scene_id?, squad?, secretary?, curRound|cur_round? }
   * @returns 操作结果
   */
  async autochessBattleActive(body: {
    uid: string;
    sceneId?: string;
    scene_id?: string;
    squad?: number;
    secretary?: string;
    curRound?: number;
    cur_round?: number;
  }): Promise<GmOpData> {
    const sceneId = body.sceneId ?? body.scene_id ?? "";
    const curRound = Number(body.curRound ?? body.cur_round ?? 1);
    this._battleReports.set(body.uid, {
      sceneId,
      squad: Number(body.squad ?? 0),
      secretary: body.secretary ?? "",
      curRound,
      ts: now(),
    });
    this._audit("autochess_battle_active", body.uid, `${sceneId} round=${curRound}`);
    logger.info(
      "GmService",
      `game server battle active (scene=${sceneId} squad=${body.squad ?? 0} secretary=${body.secretary ?? ""})`,
    );
    return { detail: `已登记对局：${sceneId}`, data: { uid: body.uid, scene_id: sceneId, curRound } };
  }

  /**
   * 服务间：会话服上报「对局已结算」（标记幂等，避免重复发奖）
   * @param body - { uid, slot?, mode?, req? }
   * @returns 操作结果
   */
  async autochessBattleSettled(body: {
    uid: string;
    slot?: number;
    mode?: string;
    req?: number;
  }): Promise<GmOpData> {
    const report = this._battleReports.get(body.uid);
    this._battleReports.delete(body.uid);
    this._audit("autochess_battle_settled", body.uid, `${report?.sceneId ?? ""} mode=${body.mode ?? ""}`);
    return {
      detail: `对局已结算登记：${body.uid}`,
      data: { uid: body.uid, scene_id: report?.sceneId ?? "", mode: body.mode ?? "" },
    };
  }

  /**
   * 服务间：取玩家对局名片（会话服展示用）
   * @param body - { uid }
   * @returns 操作结果
   */
  async autochessPlayerCard(body: { uid: string }): Promise<GmOpData> {
    const pd = await this._getPlayer(body.uid);
    const status = pd._playerdata.status ?? {};
    const report = this._battleReports.get(body.uid);
    return {
      detail: `玩家名片：${status.nickName ?? body.uid}`,
      data: {
        uid: body.uid,
        nickname: String(status.nickName ?? ""),
        nicknameNumber: String(status.nickNumber ?? ""),
        level: Number(status.level ?? 0),
        avatarId: String(status.secretary ?? "") || "avatar_def_01",
        sceneId: report?.sceneId ?? "",
        curRound: report?.curRound ?? 0,
      },
    };
  }
}

/** GM 服务单例 */
export const gmService = new GmService();
