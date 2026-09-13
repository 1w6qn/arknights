import { ItemType, ItemBundle } from "@excel/excel";
/**
 * 管理服务层
 *
 * 供 CLI 与 HTTP 管理接口共用的纯逻辑层：
 * 用户管理、物品/干员/皮肤发放、干员属性编辑、一键满配、基建满级、
 * 备份/回滚、邮件（单发/群发/查看/删除）、每日刷新、原始 JSON、统计与审计日志。
 * 所有数据操作均基于本地 JSON（AccountManager / mailManager），离线可用。
 */
import { appendFile, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import * as fs from "fs";
import * as path from "path";
import { captureManager } from "@capture/capture-manager";
import excel from "@excel/excel";
import { getRoomPhase } from "@excel/building_excel";
import { PlayerDataManager } from "@game/kernel/PlayerDataManager";
import { PlayerDataModel } from "@game/kernel/playerdata";
import type { PlayerCharEquipInfo, PlayerCharacter } from "@game/kernel/model";
import { acceptJsonValue, delIn, getIn, incIn, setIn } from "@utils/json-path";
import { isJsonObject } from "@excel/json-value";
import type { JsonValue } from "@excel/json-value";
import type { RoguelikeV2Manager } from "@game/modules/roguelike/logic";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import { adminGame } from "./game-gateway";
import { runMigration } from "../../../scripts/migrate-official";
import { loadUsers } from "../../../scripts/official-register";
import { buildMaxedChar } from "../../../scripts/generate-max-account";
import { GAME_API, ACCOUNT_API, CONF_API } from "../../../scripts/official-api";
import {
  runOfficialAction,
  runOfficialCall,
  runGachaSync,
  uploadPixelArt as uploadPixelArtToOfficial,
  OfficialAction,
} from "./official-ops";
import type {
  OfficialActionResult,
  OfficialCgiResponse,
  OfficialCallResult,
} from "./official-ops";
import { MAIL_TEMPLATES } from "./mail-templates";
import { exists, size, readJson, readJsonSync, writeJson } from "@utils/file";
import { now, realNow, userTimestamp } from "@utils/time";
import { logger } from "@utils/logger";
import { logService, registerAuditLogSource } from "@logs/log-service";
import {
  startBackfillTask,
  getBackfillTask as getAssetBackfillTask,
  listBackfillTasks as listAssetBackfillTasks,
  autoBackfillAfterSwitch,
  BackfillTask,
} from "../assets/asset-backfill";
import type { PayOrderRecord } from "@game/modules/pay/pay-store";
import {
  itemName,
  charName,
  charRarity,
  skinName,
  resolveItemRef,
  resolveCharRef,
  COMMON_ITEMS,
} from "./admin-names";
import config from "../../core/config";

/**
 * 解构 admin 可访问的 game 运行时实体（来自 game-gateway 薄网关）。
 * 别名保持与迁移前一致：loadPayOrders=loadOrders、markPayOrderPaid=markPaid。
 */
const {
  buildMaxedSkills,
  buildMaxedEquip,
  GACHA_RULE_TYPE,
  accountManager,
  mailManager,
  unlockActivity,
  forcedActivityIds,
  listCrisisSeasons,
  loadOrders: loadPayOrders,
  markPaid: markPayOrderPaid,
} = adminGame;

/** 审计日志文件（JSONL：一行一条 {ts, action, uid, detail}） */
const ADMIN_LOG_PATH = "./data/admin/logs.jsonl";
/** 用户存档备份目录 */
const BACKUP_DIR = "./data/user/backups";

/** 本地 data/excel/gacha_table.json 视图（卡池同步只取池 id 列表） */
type LocalGachaTableFile = { gachaPoolClient?: { gachaPoolId: string }[] };

/** 本地 data/gacha_detail_table.json 视图（卡池 id → 官服原始详情，原样透传落盘） */
type LocalGachaDetailFile = { details?: { [poolId: string]: JsonValue } };

/** 黑流树海（rogue_6）数据模块类型（dashboard 无相地图构造数据的真实来源类型） */
type BlackstreamDataModule = typeof import("@game/modules/roguelike/data/blackstream-data");

/** mapviz「无相地图」网格数据（构造模板/距离规则/数量规则/层类型） */
type MapvizGridData = {
  constructions: BlackstreamDataModule["BLACKSTREAM_CONSTRUCTIONS"];
  distanceRules: BlackstreamDataModule["BLACKSTREAM_DISTANCE_RULES"];
  countRules: BlackstreamDataModule["BLACKSTREAM_COUNT_RULES"];
  layerTypes: BlackstreamDataModule["BLACKSTREAM_LAYER_TYPES"];
};

/** 用户列表摘要 */
export interface UserSummary {
  uid: string;
  nickName: string;
  nickNumber: string;
  level: number;
  phone: string;
  lastOnlineTs: number;
  /** 是否被禁用（Dashboard 禁用/删除用户状态展示） */
  disabled: boolean;
}

/** 用户详情（列表摘要 + 资源/道具摘要） */
export interface UserDetail extends UserSummary {
  gold: number;
  androidDiamond: number;
  gachaTicket: number;
  recruitLicense: number;
  practiceTicket: number;
  exp: number;
  charCnt: number;
  registerTs: number;
  inventory: { [key: string]: number };
  /** 带中文名的背包道具（按数量降序；Dashboard 展示用） */
  inventoryInfo: { id: string; name: string; count: number }[];
  /** 更多资源（理智/凭证/信用等） */
  ap: number;
  maxAp: number;
  hggShard: number;
  lggShard: number;
  socialPoint: number;
  diamondShard: number;
  instantFinishTicket: number;
  tenGachaTicket: number;
}

/** 干员摘要 */
export interface CharSummary {
  instId: number;
  charId: string;
  name: string;
  rarity: number;
  level: number;
  maxLevel: number;
  evolvePhase: number;
  potentialRank: number;
  mainSkillLvl: number;
  skin: string | null;
  skinName: string | null;
}

/** 干员详情（含技能/专精/装备/语音） */
export interface CharDetail extends CharSummary {
  favorPoint: number;
  voiceLan: string;
  skills: { skillId: string; unlock: number; specializeLevel: number }[];
  currentEquip: string | null;
  equip: { [key: string]: PlayerCharEquipInfo };
}

/** 干员属性修改参数（均可选，未传不修改） */
export interface CharAttrs {
  level?: number;
  evolvePhase?: number;
  potentialRank?: number;
  mainSkillLvl?: number;
}

/** 备份文件摘要 */
export interface BackupInfo {
  name: string;
  size: number;
  ts: number;
}

/** 邮件摘要 */
export interface MailSummary {
  mailId: number;
  subject: string;
  content: string;
  createAt: number;
  expireAt: number;
  receiveAt: number;
  state: number;
  hasItem: number;
  items: { id: string; name: string; count: number }[];
}

/** 服务器状态 */
export interface ServerStatus {
  port: number;
  offline: boolean;
  clientVersion: string;
  resVersion: string;
  uptime: number;
  userCount: number;
  dataFiles: { path: string; exists: boolean; size: number }[];
  /** 数据总量（用户存档 + 数据文件，KB） */
  totalDataKB: number;
  /** 进程内存（Node RSS，MB） */
  memoryMB: number;
}

/** 统计聚合 */
export interface AdminStats {
  userCount: number;
  totalChars: number;
  totalGold: number;
  totalDiamond: number;
  avgLevel: number;
  levelDist: { [bucket: string]: number };
  registerDist: { [month: string]: number };
}

/** 审计日志条目 */
export interface AuditLogEntry {
  ts: number;
  action: string;
  uid: string;
  detail: string;
}

/** 卡池摘要 */
export interface PoolSummary {
  poolId: string;
  name: string;
  ruleType: string;
  gachaType: string;
  openTime: number;
  endTime: number;
  guarantee5Count: number;
  guarantee5Avail: number;
  summary: string;
}

/** 卡池干员（UP/可用） */
export interface PoolCharInfo {
  charId: string;
  name: string;
  percent?: number;
  count?: number;
  rarityRank?: number;
}

/** 卡池详情 */
export interface PoolDetail extends PoolSummary {
  upChars: PoolCharInfo[];
  availChars: PoolCharInfo[];
  limitedChars: string[];
}

/** 玩家卡池状态（UP 选择 + 保底计数） */
export interface PlayerPoolState {
  poolId: string;
  name: string;
  ruleType: string;
  gachaType: string;
  upCharIds: string[];
  upChars: { charId: string; name: string }[];
  beforeNonHitCnt: number;
  guarantee5Count: number;
}

/** 玩家签到状态 */
export interface CheckInState {
  groupId: string;
  groupTitle: string;
  canCheckIn: number;
  rewardIndex: number;
  historyCount: number;
  total: number;
}

/**
 * 从玩家数据提取列表摘要
 * @param uid - 用户 ID
 * @param pd - 玩家数据管理器；存档不可读（懒加载失败）时传 null——按账号配置降级为占位摘要
 * @returns 用户列表摘要
 */
export function toUserSummary(uid: string, pd: PlayerDataManager | null): UserSummary {
  const status = pd?._playerdata.status;
  return {
    uid,
    nickName: status?.nickName ?? "",
    nickNumber: status?.nickNumber ?? "",
    level: status?.level ?? 0,
    phone: accountManager.configs[uid]?.auth.phone ?? "",
    lastOnlineTs: status?.lastOnlineTs ?? 0,
    disabled: !!accountManager.configs[uid]?.disabled,
  };
}

/** 格式化时间戳为 YYYYMMDD-HHmmss（备份文件名用） */
function formatTs(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * rlv2 上帝视角可写根
 *
 * 各顶层段路由到的「权威对象」类型（管理器实例或其持有的 JSON 子树）——取自
 * {@link RoguelikeV2Manager} 的真实字段类型，不再用 `any` 关掉类型系统。
 * `undefined` 分支对应 `inventory` 未挂载（对局外）时 relic/recruit 子树不可达。
 */
type Rlv2WritableRoot =
  | RoguelikeV2Manager["current"]
  | RoguelikeV2Manager["_status"]
  | RoguelikeV2Manager["_map"]
  | RoguelikeV2Manager["_module"]
  | RoguelikeV2Manager["troop"]
  | NonNullable<RoguelikeV2Manager["inventory"]>
  | NonNullable<RoguelikeV2Manager["inventory"]>["_relic"]["relics"]
  | NonNullable<RoguelikeV2Manager["inventory"]>["_recruit"]["tickets"]
  | undefined;

/**
 * 上帝视角修改：把 current 顶层段路由到对应 manager 的"可写权威对象"。
 * rlv2 的 player/map/module/troop/inventory 是内存 manager，persistCurrent() 以
 * manager.toJSON() 为快照回写 current——若直接改 current.* 会被回写覆盖。故把补丁
 * 作用到 manager 实际持有的对象（其 toJSON 读取的同一引用）。record/game/buff 未
 * 被 manager 接管，直接落在 current。
 *
 * @param ctl  - RoguelikeV2Manager（rlv2 模块组合根实例）
 * @param segs - 完整路径段（如 ["player","property","hp","current"]）
 * @returns 权威根对象 + 剩余路径段（已去掉顶层段）
 */
function rlv2AuthoritativeRoot(
  ctl: RoguelikeV2Manager,
  segs: string[],
): { root: Rlv2WritableRoot; rest: string[] } {
  const top = segs[0];
  const rest = segs.slice(1);
  const cur = ctl.current;
  switch (top) {
    case "player":
      return { root: ctl._status, rest }; // property/cursor/state 等字段
    case "map":
      return { root: ctl._map, rest }; // _map.zones === current.map.zones（别名）
    case "module":
      return { root: ctl._module, rest }; // gridZone/scrap 等经 _modules 管理器
    case "troop":
      return { root: ctl.troop, rest };
    case "inventory":
      // relic/recruit 是 getter（子管理器），需钻进 *_relic.relics / *_recruit.tickets
      if (rest[0] === "relic") return { root: ctl.inventory?._relic?.relics, rest: rest.slice(1) };
      if (rest[0] === "recruit") return { root: ctl.inventory?._recruit?.tickets, rest: rest.slice(1) };
      return { root: ctl.inventory ?? undefined, rest };
    default:
      // record / game / buff 直接同居 current
      return { root: cur, rest: segs };
  }
}

/**
 * 沿 JSON 路径对 rlv2 current 子树应用单个补丁（set/del/inc）。
 *
 * 路径遍历收敛在 `@utils/json-path`（严格 `JsonValue` 域，容器形态
 * 分派只在该模块内做一次）。修改对象（含数组）须为可变——rlv2 是 autoFreeze
 * 兼容的可写孤岛，直接改即可。
 * @param root  - 权威根对象（管理器实例或其 JSON 子树，形状由调用方保证）
 * @param op    - set=赋值（不存在则创建中间路径）；del=删除键/数组元素；inc=数值加（默认 +1）
 * @param segs  - 点分路径段（如 ["player","property","hp","current"]）
 * @param value - set 的目标值（JSON 域值；来自管理接口请求体）
 */
export function applyRlv2Patch<T>(
  root: T,
  op: "set" | "del" | "inc",
  segs: string[],
  value?: JsonValue,
): void {
  if (op === "del") {
    delIn(root, segs);
    return;
  }
  if (op === "inc") {
    incIn(root, segs, Number(value ?? 0));
    return;
  }
  // set：空值可选语义——显式传 undefined 表示删除，避免误留
  if (value === undefined) {
    delIn(root, segs);
    return;
  }
  setIn(root, segs, value);
}

/**
 * 补齐阿米娅升变模板（currentTmpl + 三形态 tmpl 映射）
 *
 * `buildMaxedChar`（scripts/generate-max-account）返回 `Record<string, unknown>`
 * ——动态 JSON 产物。这里经 `@utils/json-path` 的 JSON 域接纳点
 * （{@link acceptJsonValue} + {@link setIn}）写回，避免为动态结构写 `as any` 断言；
 * `currentTmpl` 按字符串收窄后直接赋值（非字符串即不写，与迁移前写 undefined 的
 * 可序列化结果一致，见 save-health 的模板字段归一化规则）。
 * @param ch - 目标干员（存档草稿中的可写对象）
 * @param instId - 干员实例 ID（buildMaxedChar 回填 instId）
 */
function applyAmiyaTemplate(ch: PlayerCharacter, instId: number): void {
  const full = buildMaxedChar(instId, "char_002_amiya");
  const currentTmpl = full["currentTmpl"];
  if (typeof currentTmpl === "string") ch.currentTmpl = currentTmpl;
  setIn(ch, ["tmpl"], acceptJsonValue(full["tmpl"]));
}

/** rlv2 快照中的标准地图节点（自走模拟读取的字段） */
type Rlv2SimMapNode = {
  pos?: { x: number; y: number } | null;
  type?: number | null;
  zone_end?: boolean | null;
  next?: { x: number; y: number }[] | null;
};

/** rlv2 快照中的网格节点（rogue_6 无相地图；自走模拟读取的字段） */
type Rlv2SimGridNode = {
  zone_end?: boolean | null;
  content?: {
    kind?: number | null;
    savage?: { stageId?: string | null } | null;
    shop?: JsonValue | null;
  } | null;
};

/** rlv2 快照中的待处理事件（自走模拟读取的字段） */
type Rlv2SimPending = {
  type?: string | null;
  content?: {
    scene?: { choices?: { [key: string]: JsonValue } | null } | null;
    initSupport?: { scene?: { choices?: { [key: string]: JsonValue } | null } | null } | null;
  } | null;
};

/** rlv2 快照（gameProxy 响应 modified.rlv2 的只读视图；自走模拟只读下列字段） */
type Rlv2SimSnapshot = {
  current?: {
    player?: {
      state?: string | null;
      cursor?: {
        zone?: number | null;
        position?: { x: number; y: number } | null;
      } | null;
      pending?: Rlv2SimPending[] | null;
    } | null;
    map?: {
      zones?: {
        [zone: string]: { nodes?: { [nodeId: string]: Rlv2SimMapNode } | null } | null;
      } | null;
    } | null;
    module?: {
      gridZone?: {
        zones?: {
          [zone: string]: { nodes?: { [nodeId: string]: Rlv2SimGridNode } | null } | null;
        } | null;
      } | null;
    } | null;
  } | null;
};

/**
 * rlv2 快照节点判定（`playerDataDelta.modified.rlv2` 的值本身）
 *
 * 边界：gameProxy 的响应体是 HTTP 自代理返回的 JSON（外部不可信输入）。此处只确认
 * `current` 为对象——字段级形状不做深校验（大响应深校验有明显开销，且读取端一律
 * `?.` + `??` 兜底，与迁移前 `any` 访问逐分支行为一致）。非对象一律判定失败。
 * @param value - 待判定的 rlv2 节点
 * @returns 是否为 rlv2 增量快照视图
 */
function isRlv2SimSnapshot(value: JsonValue): value is Rlv2SimSnapshot {
  return isJsonObject(value) && isJsonObject(value["current"]);
}

/**
 * 从 gameProxy 响应体提取 rlv2 快照（非快照 → null，与迁移前 `?? null` 一致）
 *
 * 注意返回的是**内层 rlv2 节点**（`playerDataDelta.modified.rlv2`），不是整个响应体
 * ——调用方（rogueSimStep/rogueSimAuto）与 CLI 消费的都是 `state.current.*`。
 * @param data - gameProxy 响应体（JSON 域值）
 * @returns 快照视图；响应不是 rlv2 增量时为 null
 */
function pickRlv2SimSnapshot(data: JsonValue): Rlv2SimSnapshot | null {
  if (!isJsonObject(data)) return null;
  const delta = data["playerDataDelta"];
  if (!isJsonObject(delta)) return null;
  const modified = delta["modified"];
  if (!isJsonObject(modified)) return null;
  const rlv2 = modified["rlv2"];
  return rlv2 !== undefined && isRlv2SimSnapshot(rlv2) ? rlv2 : null;
}

export class AdminService {
  constructor() {
    // 审计日志源注册（2026-09-13）：core 的 log-service 不再反向 import 本模块（R1），
    // 改由本类构造时经 @logs/log-service 的 AuditLogSource 端口注入自身。
    registerAuditLogSource(this);
  }

  /** 玩家数据快照（grant 等写操作后的落盘：存档 + 账号配置，并清 debounce） */
  private async savePlayer(uid: string): Promise<void> {
    await accountManager.flushSave(uid);
  }

  /** 取玩家（已加载直接返回；未加载走懒加载；不存在/读取失败统一报"用户不存在"） */
  private async getPlayer(uid: string): Promise<PlayerDataManager> {
    if (accountManager.data[uid]) return accountManager.data[uid];
    try {
      return await accountManager.getPlayerData(uid);
    } catch {
      throw new Error(`用户不存在: ${uid}`);
    }
  }

  /** 审计日志：追加一行 JSONL（失败不阻断业务操作）；每 200 条检查一次大小，超 1MB 自动轮转保留最近 3000 行 */
  private _auditCount = 0;
  private async _audit(action: string, uid: string, detail: string): Promise<void> {
    try {
      await mkdir("./data/admin", { recursive: true });
      const entry = { ts: now(), action, uid, detail };
      await appendFile(
        ADMIN_LOG_PATH,
        JSON.stringify(entry) + "\n",
        "utf8",
      );
      // 实时广播（统一日志服务 → Dashboard「日志」Tab SSE 尾随）
      logService.emitAudit(entry);
      this._auditCount++;
      if (this._auditCount % 200 === 0) {
        const st = await stat(ADMIN_LOG_PATH).catch(() => null);
        if (st && st.size > 1024 * 1024) {
          const entries = await this.logs(3000); // 最新在前
          const kept = entries.reverse().map((e) => JSON.stringify(e)).join("\n") + "\n";
          await writeFile(ADMIN_LOG_PATH, kept, "utf8");
        }
      }
    } catch (e) {
      logger.warn("AdminService", `审计日志写入失败: ${(e as Error).message}`);
    }
  }

  /** 用户列表（按 uid 排序；filter 匹配 uid/昵称/手机号，空返回全部） */
  async listUsers(filter = ""): Promise<UserSummary[]> {
    const kw = String(filter ?? "").trim().toLowerCase();
    // 存档懒加载后 data 可能为空——从 configs 迭代，逐个惰性加载
    const uids = Object.keys(accountManager.configs).sort((a, b) => Number(a) - Number(b));
    const summaries = await Promise.all(
      uids.map(async (uid) => {
        try {
          const pd = await accountManager.getPlayerData(uid);
          return toUserSummary(uid, pd);
        } catch {
          // 存档不可读（懒加载失败）：降级为仅账号配置的占位摘要。
          // 原实现传 undefined 会在 toUserSummary 内读 _playerdata 抛 TypeError，
          // 使 catch 分支反而把整个用户列表接口打成 500。
          return toUserSummary(uid, null);
        }
      }),
    );
    return summaries.filter(
      (u) =>
        !kw ||
        u.uid.includes(kw) ||
        u.nickName.toLowerCase().includes(kw) ||
        u.phone.toLowerCase().includes(kw),
    );
  }

  /** 用户详情 */
  async getUserInfo(uid: string): Promise<UserDetail | null> {
    let pd: PlayerDataManager;
    try {
      pd = await accountManager.getPlayerData(uid);
    } catch {
      return null;
    }
    const status = pd._playerdata.status;
    const inventory = pd._playerdata.inventory ?? {};
    const inventoryInfo = Object.entries(inventory)
      .map(([id, count]) => ({ id, name: itemName(id), count }))
      .sort((a, b) => b.count - a.count);
    return {
      ...toUserSummary(uid, pd),
      gold: status.gold,
      androidDiamond: status.androidDiamond,
      gachaTicket: status.gachaTicket,
      recruitLicense: status.recruitLicense,
      practiceTicket: status.practiceTicket,
      exp: status.exp,
      charCnt: pd._playerdata.troop.curCharInstId - 1,
      registerTs: status.registerTs,
      inventory,
      inventoryInfo,
      ap: status.ap,
      maxAp: status.maxAp,
      hggShard: status.hggShard,
      lggShard: status.lggShard,
      socialPoint: status.socialPoint,
      diamondShard: status.diamondShard,
      instantFinishTicket: status.instantFinishTicket,
      tenGachaTicket: status.tenGachaTicket,
    };
  }

  /**
   * 发放物品/资源
   * @param uid - 目标用户ID
   * @param itemId - 物品ID（如 4001=龙门币、4003=合成玉）或中文名/别名（如 "合成玉"）
   * @param count - 数量（正整数）
   */
  async grantItem(uid: string, itemId: string, count: number): Promise<void> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`数量必须为正整数，收到: ${count}`);
    }
    const resolved = resolveItemRef(itemId);
    if (!resolved) {
      throw new Error(`未知物品: ${itemId}（可先 users config 或用 item_table.json 核对 ID）`);
    }
    if (!excel.getItem(resolved)) {
      throw new Error(`物品 ${resolved} 不在 ItemTable，无法发放`);
    }
    const pd = await this.getPlayer(uid);
    // makeItem 保持「type 缺省 = 无 type 语义」（由库存层按 item_table 推导）
    await pd.inventory.gainItem(excel.makeItem(resolved, count));
    await this.savePlayer(uid);
    await this._audit("grantItem", uid, `${resolved}(${itemName(resolved)}) x${count}`);
  }

  /**
   * 发放干员（新干员建档；重复干员按稀有度折算信物/凭证）
   * @param uid - 目标用户ID
   * @param charId - 干员ID（如 char_002_amiya）或中文名
   */
  async grantChar(uid: string, charId: string): Promise<{ isNew: number; name: string }> {
    const resolved = resolveCharRef(charId);
    if (!excel.charData(resolved)) {
      throw new Error(`未知干员: ${charId}`);
    }
    const pd = await this.getPlayer(uid);
    // 直接调用 onCharGet（char:get 事件监听为无操作，见 char.ts 构造器）
    const res = await pd.char.onCharGet([resolved, { from: "ADMIN" }]);
    // 阿米娅特殊：升变多形态模板（currentTmpl 指向异格形态 + 完整 tmpl 映射）。
    // onCharGet 新干员已不写 currentTmpl/tmpl，此处按官方结构补全（checkData 亦依赖）。
    if (resolved === "char_002_amiya" && res?.isNew) {
      await pd.update(async (draft) => {
        const ch = draft.troop.chars[res.charInstId as number];
        if (ch) {
          applyAmiyaTemplate(ch, ch.instId);
        }
      });
    }
    await this.savePlayer(uid);
    await this._audit("grantChar", uid, `${resolved}(${charName(resolved)})`);
    return { isNew: res?.isNew ?? 0, name: charName(resolved) };
  }

  /**
   * 解锁皮肤
   * @param uid - 目标用户ID
   * @param skinId - 皮肤ID（如 char_002_amiya#2）
   */
  async grantSkin(uid: string, skinId: string): Promise<void> {
    if (!excel.SkinTable?.charSkins?.[skinId]) {
      throw new Error(`未知皮肤: ${skinId}`);
    }
    const pd = await this.getPlayer(uid);
    await pd.inventory.gainItem({ id: skinId, count: 1, type: "CHAR_SKIN" as ItemType });
    await this.savePlayer(uid);
    await this._audit("grantSkin", uid, `${skinId}(${skinName(skinId) ?? ""})`);
  }

  /** 干员列表 */
  async listChars(uid: string): Promise<CharSummary[]> {
    const pd = await this.getPlayer(uid);
    const chars = pd._playerdata.troop?.chars ?? {};
    return Object.values(chars)
      .sort((a, b) => a.instId - b.instId)
      .map((ch) => {
        const phases = excel.charData(ch.charId)?.phases;
        const maxLevel = phases?.[ch.evolvePhase ?? 0]?.maxLevel ?? 90;
        return {
          instId: ch.instId,
          charId: ch.charId,
          name: charName(ch.charId),
          rarity: charRarity(ch.charId),
          level: ch.level,
          maxLevel,
          evolvePhase: ch.evolvePhase,
          potentialRank: ch.potentialRank,
          mainSkillLvl: ch.mainSkillLvl,
          skin: ch.skin ?? null,
          skinName: ch.skin ? skinName(ch.skin) : null,
        };
      });
  }

  /** 单个干员详情（技能/专精/装备/信赖/语音等；不存在返回 null） */
  async getCharDetail(
    uid: string,
    instId: number,
  ): Promise<CharDetail | null> {
    const pd = await this.getPlayer(uid);
    const ch = pd._playerdata.troop?.chars?.[String(instId)];
    if (!ch) return null;
    const info = excel.charData(ch.charId);
    return {
      instId,
      charId: ch.charId,
      name: charName(ch.charId),
      rarity: charRarity(ch.charId),
      level: ch.level,
      maxLevel: info?.phases?.[ch.evolvePhase]?.maxLevel ?? 90,
      evolvePhase: ch.evolvePhase,
      potentialRank: ch.potentialRank,
      mainSkillLvl: ch.mainSkillLvl,
      favorPoint: ch.favorPoint,
      skin: ch.skin ?? null,
      skinName: ch.skin ? skinName(ch.skin) : null,
      voiceLan: ch.voiceLan,
      skills: (ch.skills ?? []).map((s) => ({
        skillId: s.skillId,
        unlock: s.unlock,
        specializeLevel: s.specializeLevel,
      })),
      currentEquip: ch.currentEquip ?? null,
      equip: ch.equip ?? {},
    };
  }

  /**
   * 干员模组操作（委托 char manager——解锁/升级/装备）
   * @param action - unlock / upgrade / set
   * @param body - { equipId, templateId?, targetLevel? }
   */
  async operateCharModule(
    uid: string,
    instId: number,
    action: "unlock" | "upgrade" | "set",
    body: { equipId?: string; templateId?: string; targetLevel?: number } = {},
  ): Promise<{ ok: true; equipId: string; level?: number }> {
    const pd = await this.getPlayer(uid);
    const ch = pd._playerdata.troop?.chars?.[String(instId)];
    if (!ch) {
      throw new Error(`干员不存在: ${instId}`);
    }
    const { equipId, templateId = "", targetLevel } = body;
    if (!equipId) {
      throw new Error(`缺少 equipId`);
    }
    if (!excel.UniequipTable?.equipDict?.[equipId]) {
      throw new Error(`未知模组: ${equipId}`);
    }
    if (action === "unlock") {
      await pd.char.unlockEquipment({ charInstId: instId, templateId, equipId });
    } else if (action === "upgrade") {
      await pd.char.upgradeEquipment({
        charInstId: instId,
        templateId,
        equipId,
        targetLevel: Number(targetLevel ?? 1),
      });
    } else if (action === "set") {
      await pd.char.setEquipment({ charInstId: instId, templateId, equipId });
    } else {
      throw new Error(`未知操作: ${action}`);
    }
    await this.savePlayer(uid);
    await this._audit("operateCharModule", uid, `${action} ${instId} ${equipId}`);
    const level = templateId
      ? pd._playerdata.troop.chars[String(instId)]?.tmpl?.[templateId]?.equip?.[equipId]?.level
      : pd._playerdata.troop.chars[String(instId)]?.equip?.[equipId]?.level;
    return { ok: true, equipId, level };
  }

  /** 商店数据汇总（只读：各商店类型购买记录数） */
  async getShopSummary(
    uid: string,
  ): Promise<{ types: { type: string; curShopId?: string; items: number }[]; total: number }> {
    const pd = await this.getPlayer(uid);
    const shop = pd._playerdata.shop;
    const types = Object.entries(shop).map(([type, v]) => ({
      type,
      // 各商店档位的字段并集（部分类型无 curShopId）：按存在性收窄
      curShopId: "curShopId" in v && typeof v.curShopId === "string" ? v.curShopId : undefined,
      items: "info" in v && Array.isArray(v.info) ? v.info.length : 0,
    }));
    return {
      types,
      total: types.reduce((s, t) => s + t.items, 0),
    };
  }

  /**
   * 修改干员属性（免费路径，不消耗道具；未传参数不改动）
   * 边界钳制：精二 ≤ phases 上限、等级 ≤ 当前阶段 maxLevel、潜能 ≤ maxPotentialLevel、技能 ≤ 7
   */
  async setCharAttrs(uid: string, instId: number, attrs: CharAttrs): Promise<CharSummary> {
    if (!attrs || Object.keys(attrs).length === 0) {
      throw new Error("未提供任何要修改的属性");
    }
    const pd = await this.getPlayer(uid);
    const ch = pd._playerdata.troop?.chars?.[String(instId)];
    if (!ch) {
      throw new Error(`干员不存在: instId=${instId}`);
    }
    const info = excel.charData(ch.charId);
    const phases = info?.phases;
    const maxEvolve = phases?.length ? phases.length - 1 : 2;
    const maxPotential = info?.maxPotentialLevel ?? 5;

    await pd.update(async (draft) => {
      const target = draft.troop.chars[String(instId)];
      if (attrs.evolvePhase !== undefined) {
        target.evolvePhase = Math.min(Math.max(attrs.evolvePhase, 0), maxEvolve);
      }
      const maxLevel = phases?.[target.evolvePhase]?.maxLevel ?? 90;
      if (attrs.level !== undefined) {
        target.level = Math.min(Math.max(attrs.level, 1), maxLevel);
      } else {
        target.level = Math.min(target.level, maxLevel);
      }
      if (attrs.potentialRank !== undefined) {
        target.potentialRank = Math.min(Math.max(attrs.potentialRank, 0), maxPotential);
      }
      if (attrs.mainSkillLvl !== undefined) {
        target.mainSkillLvl = Math.min(Math.max(attrs.mainSkillLvl, 1), 7);
      }
      target.exp = 0;
    });
    await this.savePlayer(uid);
    await this._audit(
      "setCharAttrs",
      uid,
      `instId=${instId} ${JSON.stringify(attrs)}`,
    );
    return (await this.listChars(uid)).find((c) => c.instId === instId)!;
  }

  /**
   * 一键满配（软满配——不覆盖阵容，最大化当前账号）：
   * 大额资源 + 全背包物品 999 + 已有干员拉满（精二满级/满潜/满技能/专三/满信赖/满专精装备）
   * + 已拥有干员的全部皮肤解锁 + 基建满级。
   * @returns 影响统计 {chars, items, skins, rooms}
   */
  async maxOutAccount(uid: string): Promise<{ chars: number; items: number; skins: number; rooms: number }> {
    const pd = await this.getPlayer(uid);
    const stats = { chars: 0, items: 0, skins: 0, rooms: 0 };
    const ownedCharIds = new Set(
      Object.values(pd._playerdata.troop?.chars ?? {}).map((c) => c.charId),
    );

    await pd.update(async (draft) => {
      // 1. 大额资源（与 generate-max-account 保持一致）
      draft.status.gold = 99999999;
      draft.status.androidDiamond = 99999;
      draft.status.iosDiamond = 99999;
      draft.status.level = 120;
      draft.status.exp = 0;
      if (draft.status.maxAp) draft.status.ap = draft.status.maxAp;

      // 2. 全背包物品（sortId>0；CONSUME → consumable，其余 → inventory）
      const items = excel.ItemTable?.items ?? {};
      for (const [itemId, info] of Object.entries(items)) {
        if (info.sortId <= 0) continue;
        if (info.classifyType === "CONSUME") {
          draft.consumable[itemId] = { "0": { ts: -1, count: 999 } };
        } else if (info.classifyType === "NORMAL" || info.classifyType === "MATERIAL") {
          draft.inventory[itemId] = 999;
        }
        stats.items++;
      }

      // 3. 已有干员拉满
      for (const ch of Object.values(draft.troop?.chars ?? {})) {
        const charData = excel.charData(ch.charId);
        const phases = charData?.phases;
        const maxEvolve = phases?.length ? phases.length - 1 : 2;
        ch.evolvePhase = maxEvolve;
        ch.level = phases?.[maxEvolve]?.maxLevel ?? 90;
        ch.exp = 0;
        ch.potentialRank = 5;
        ch.mainSkillLvl = 7;
        ch.favorPoint = 25570;
        const skills = buildMaxedSkills(charData);
        if (skills.length) {
          ch.skills = skills;
          ch.defaultSkillIndex = ch.defaultSkillIndex ?? 0;
        }
        const { ids: equipIds, equip } = buildMaxedEquip(ch.charId);
        ch.currentEquip = equipIds[0] || null;
        // buildMaxedEquip 的 MaxedEquipEntry 与 PlayerCharEquipInfo 同形（hide/locked/level）
        ch.equip = equip;
        stats.chars++;
      }

      // 4. 已拥有干员的全部皮肤解锁
      for (const [skinId, skin] of Object.entries(excel.SkinTable?.charSkins ?? {})) {
        if (skin?.charId && ownedCharIds.has(skin.charId)) {
          draft.skin.characterSkins[skinId] = 1;
          draft.skin.skinTs[skinId] = now();
          stats.skins++;
        }
      }

      // 5. 基建满级
      for (const slot of Object.values(draft.building?.roomSlots ?? {})) {
        if (!slot?.roomId) continue;
        let level = slot.level ?? 1;
        while (getRoomPhase(slot.roomId, level + 1)) level++;
        slot.level = level;
        stats.rooms++;
      }
    });

    await this.savePlayer(uid);
    await this._audit("maxOutAccount", uid, JSON.stringify(stats));
    return stats;
  }

  /** 基建满级（所有已建造房间升到最高相位等级） */
  async buildingMax(uid: string): Promise<{ rooms: number }> {
    const pd = await this.getPlayer(uid);
    let rooms = 0;
    await pd.update(async (draft) => {
      for (const slot of Object.values(draft.building?.roomSlots ?? {})) {
        if (!slot?.roomId) continue;
        let level = slot.level ?? 1;
        while (getRoomPhase(slot.roomId, level + 1)) level++;
        slot.level = level;
        rooms++;
      }
    });
    await this.savePlayer(uid);
    await this._audit("buildingMax", uid, `${rooms} 间房间`);
    return { rooms };
  }

  /**
   * 手动加速指定玩家基建指定时间（快进 seconds 秒并立即结算产出）
   *
   * 委托 BuildingManager.advance：前移基建时间基准后按真实时间统一结算
   * 制造产出/贸易订单/训练进度/心情/信赖/劳动力，随后落盘并写审计日志。
   *
   * @param uid - 玩家 UID
   * @param seconds - 快进秒数（正整数）
   * @returns 实际快进的秒数
   */
  async buildingAdvance(uid: string, seconds: number): Promise<{ advanced: number }> {
    const secs = Math.floor(Number(seconds));
    if (!Number.isFinite(secs) || secs <= 0) {
      throw new Error("加速秒数必须为正整数");
    }
    const pd = await this.getPlayer(uid);
    await pd.building.advance(secs);
    await this.savePlayer(uid);
    await this._audit("buildingAdvance", uid, `基建快进 ${secs}s`);
    return { advanced: secs };
  }

  /** 备份用户存档（data/user/backups/{uid}-{YYYYMMDD-HHmmss}.json） */
  async backup(uid: string): Promise<BackupInfo> {
    // SQLite 感知：方案 A+C 下存档主体在库（gzip BLOB），直读文件对库内账号 ENOENT
    const data = await accountManager.readPlayerData(uid);
    if (!data) {
      throw new Error(`用户不存在: ${uid}`);
    }
    await mkdir(BACKUP_DIR, { recursive: true });
    const name = `${uid}-${formatTs(now())}.json`;
    await writeFile(`${BACKUP_DIR}/${name}`, JSON.stringify(data));
    const st = await this.statBackup(name);
    await this._audit("backup", uid, name);
    return st;
  }

  /** 列出某用户全部备份（按时间倒序） */
  async listBackups(uid: string): Promise<BackupInfo[]> {
    let names: string[] = [];
    try {
      names = await readdir(BACKUP_DIR);
    } catch {
      return [];
    }
    const prefix = `${uid}-`;
    const list: BackupInfo[] = [];
    for (const name of names) {
      if (name.startsWith(prefix) && name.endsWith(".json")) {
        const st = await this.statBackup(name);
        if (st) list.push(st);
      }
    }
    return list.sort((a, b) => b.ts - a.ts);
  }

  /** 清理旧备份（保留最近 keep 个；按时间倒序） */
  async cleanBackups(uid: string, keep = 10): Promise<{ removed: number; kept: number }> {
    if (!Number.isInteger(keep) || keep < 0) {
      throw new Error(`keep 必须为非负整数: ${keep}`);
    }
    const list = await this.listBackups(uid);
    const remove = list.slice(keep);
    for (const b of remove) {
      await rm(`${BACKUP_DIR}/${b.name}`).catch(() => {});
    }
    await this._audit("cleanBackups", uid, `删除 ${remove.length} 个旧备份（保留 ${list.length - remove.length}）`);
    return { removed: remove.length, kept: list.length - remove.length };
  }

  /** 备份文件信息（不存在返回 null） */
  private async statBackup(name: string): Promise<BackupInfo> {
    const path = `${BACKUP_DIR}/${name}`;
    if (!(await exists(path))) {
      throw new Error(`备份不存在: ${name}`);
    }
    const buf = await readFile(path);
    const match = /^(\d+)-([\d-]+)\.json$/.exec(name);
    const tsMatch = /-(\d{14})\.json$/.exec(name);
    const ts = tsMatch
      ? this.parseTs(tsMatch[1])
      : Number(match?.[1] ?? 0);
    return { name, size: buf.length, ts };
  }

  /** YYYYMMDDHHmmss → 秒级时间戳（解析失败返回 0） */
  private parseTs(s: string): number {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
    if (!m) return 0;
    const [, Y, Mo, D, H, Mi, Se] = m;
    return Math.floor(
      new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(Se)).getTime() /
        1000,
    );
  }

  /**
   * 从备份恢复用户存档
   * @param uid - 用户ID
   * @param backupName - 备份文件名（须匹配 {uid}-{ts}.json，防路径穿越）
   */
  async restore(uid: string, backupName: string): Promise<void> {
    if (!new RegExp(`^${uid}-[\\d-]+\\.json$`).test(backupName)) {
      throw new Error(`非法的备份文件名: ${backupName}`);
    }
    const path = `${BACKUP_DIR}/${backupName}`;
    if (!(await exists(path))) {
      throw new Error(`备份不存在: ${backupName}`);
    }
    const data = await readJson<PlayerDataModel>(path);
    accountManager.data[uid] = new PlayerDataManager(data);
    await this.savePlayer(uid);
    await this._audit("restore", uid, backupName);
  }

  /**
   * 发送系统邮件
   * @param uid - 接收者用户ID
   * @param args - 标题/内容/附件
   */
  async sendMail(
    uid: string,
    args: { subject: string; content: string; items: { id: string; count: number }[] },
  ) {
    try {
      await accountManager.getPlayerData(uid);
    } catch {
      throw new Error(`用户不存在: ${uid}`);
    }
    const items = args.items.map((it) => (excel.makeItem(it.id, it.count)));
    const mail = await mailManager.sendMail(uid, {
      subject: args.subject,
      content: args.content,
      items,
    });
    await this._audit(
      "sendMail",
      uid,
      `mailId=${mail.mailId} ${args.subject}（附件 ${items.length} 种）`,
    );
    return mail;
  }

  /** 群发邮件（发送给所有用户） */
  async sendMailAll(
    args: { subject: string; content: string; items: { id: string; count: number }[] },
  ): Promise<{ sent: number }> {
    const uids = Object.keys(accountManager.data);
    for (const uid of uids) {
      await mailManager.sendMail(uid, {
        subject: args.subject,
        content: args.content,
        items: args.items.map((it) => excel.makeItem(it.id, it.count)),
      });
    }
    await this._audit("sendMailAll", "", `${args.subject} → ${uids.length} 人`);
    return { sent: uids.length };
  }

  /** 用户邮件列表 */
  async listMails(uid: string): Promise<MailSummary[]> {
    await this.getPlayer(uid);
    return mailManager.listAllMail(uid).map((mail) => ({
      mailId: mail.mailId,
      subject: mail.subject,
      content: mail.content,
      createAt: mail.createAt,
      expireAt: mail.expireAt,
      receiveAt: mail.receiveAt,
      state: mail.state,
      hasItem: mail.hasItem,
      items: (mail.items ?? []).map((it) => ({
        id: it.id,
        name: itemName(it.id),
        count: it.count,
      })),
    }));
  }

  /** 删除用户单封邮件 */
  async deleteMail(uid: string, mailId: number): Promise<boolean> {
    const ok = await mailManager.deleteMail(uid, mailId);
    if (ok) {
      await this._audit("deleteMail", uid, `mailId=${mailId}`);
    }
    return ok;
  }

  /** 触发每日/每周刷新（理智恢复、购买次数、任务重置等） */
  async refreshUser(uid: string): Promise<void> {
    const pd = await this.getPlayer(uid);
    try {
      await pd.status.refreshTime();
    } catch (e) {
      logger.warn("AdminService", `refreshTime 失败: ${(e as Error).message}`);
    }
    try {
      await pd.mission.dailyRefresh();
    } catch (e) {
      logger.warn("AdminService", `mission.dailyRefresh 失败: ${(e as Error).message}`);
    }
    await this.savePlayer(uid);
    await this._audit("refreshUser", uid, "每日/每周刷新");
  }

  /** 一键日常：每日/每周刷新 + 签到代签 + 落盘 */
  async dailyRoutine(uid: string): Promise<{ refreshed: boolean; checkin: string }> {
    const pd = await this.getPlayer(uid);
    try {
      await pd.status.refreshTime();
      await pd.mission.dailyRefresh();
    } catch (e) {
      logger.warn("AdminService", `dailyRoutine 刷新失败: ${(e as Error).message}`);
    }
    let checkin = "不可签";
    try {
      const res = await pd.checkIn.checkIn();
      if (res) checkin = "已签";
    } catch {
      checkin = "签到失败";
    }
    await this.savePlayer(uid);
    await this._audit("dailyRoutine", uid, `刷新 + ${checkin}`);
    return { refreshed: true, checkin };
  }

  /**
   * 手动刷新信用交易所（服务器指令）
   *
   * 等价于每日 04:00 的 refresh:daily 自动刷新：重置低级商店当日限购记录，
   * 并重置信用商店（SOCIAL）当日购买记录 + 更新当天 shopId。
   * @param uid - 玩家 uid
   */
  async refreshSocialShop(uid: string): Promise<void> {
    const pd = await this.getPlayer(uid);
    await pd.shop.refreshSocialShop();
    await this.savePlayer(uid);
    await this._audit("refreshSocialShop", uid, "手动刷新信用交易所");
  }

  /**
   * 支付订单列表（只读）
   * @param uid - 可选玩家 uid 过滤
   * @returns 订单记录列表
   */
  async listPayOrders(uid?: string) {
    const orders = loadPayOrders();
    return uid ? orders.filter((o) => o.uid === uid) : orders;
  }

  /**
   * 手动确认支付（real 模式：真实收款后标记订单 paid，客户端 confirmOrder 时发货）
   * @param orderId - 订单号
   * @returns 确认结果
   */
  async confirmPayOrder(orderId: string): Promise<{ ok: boolean; order?: PayOrderRecord }> {
    const order = markPayOrderPaid(orderId);
    if (!order) {
      return { ok: false };
    }
    await this._audit("confirmPayOrder", order.uid, `订单 ${orderId} 标记已支付（${order.goodId}）`);
    return { ok: true, order };
  }

  /** 立即保存用户存档 */
  async saveUser(uid: string): Promise<void> {
    await this.getPlayer(uid);
    await this.savePlayer(uid);
    await this._audit("saveUser", uid, "手动保存");
  }

  /** 原始玩家数据（完整 JSON） */
  async getRawJson(uid: string): Promise<PlayerDataModel> {
    const pd = await this.getPlayer(uid);
    return pd.toJSON();
  }

  /**
   * 游戏协议代理：以目标玩家 secret 调用游戏端点（Dashboard「接口」协议调试用）
   * @param uid - 目标玩家 uid（取其 secret 认证；single 模式强制固定账号不受影响）
   * @param path - 游戏端点路径（须以 / 开头，禁止 /admin、/auth 控制面路径）
   * @param method - HTTP 方法（默认 GET）
   * @param body - 请求体 JSON
   * @returns 内层 HTTP 状态码与响应体（JSON 解析失败原样返回文本）
   */
  async gameProxy(
    uid: string,
    path: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: JsonValue,
  ): Promise<{ status: number; data: JsonValue; uid: string }> {
    const p = String(path ?? "").trim();
    if (!p.startsWith("/")) {
      throw new Error(`路径必须以 / 开头: ${path}`);
    }
    if (p.startsWith("/admin") || p.startsWith("/auth")) {
      throw new Error(`不允许代理控制面路径: ${path}`);
    }
    await this.getPlayer(uid);
    const token = await accountManager.getTokenByUid(uid);
    const url = `http://localhost:${config.PORT}${p}`;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method,
        headers: {
          secret: token,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`服务器内部请求失败: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: JsonValue = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应（如错误页）原样返回文本
    }
    return { status: res.status, data, uid };
  }

  /**
   * 肉鸽流程模拟：自动一键跑完整流程（不含战斗，战斗节点传空 battleData 跳过）
   *
   * 复用 gameProxy（HTTP 自代理 → /rlv2/*），逐步推进状态机：
   *   INIT → 开局链（选分队/招募组/开局 buff）→ WAIT_MOVE → 逐层 BFS 路径走到 zone_end
   *   → 消费节点事件（SCENE/BATTLE_SHOP，战斗节点跳过）→ 下一层 …→ 最终层 gameSettle → END
   *
   * @param uid - 目标玩家 uid
   * @param theme - 集成战略主题（rogue_1..6）
   * @param maxZone - 模拟到第几层为止（缺省模拟到底直至结算）
   * @returns 步骤日志 + 最终 rlv2 快照（含结算报告 current.record）
   */
  async rogueSimAuto(
    uid: string,
    theme: string,
    maxZone?: number,
  ): Promise<{
    ok: boolean;
    steps: { step: number; action: string; zone: number; state: string }[];
    final: Rlv2SimSnapshot | null;
    error?: string;
  }> {
    const steps: { step: number; action: string; zone: number; state: string }[] = [];
    const log = (action: string, snap: Rlv2SimSnapshot | null) => {
      steps.push({
        step: steps.length + 1,
        action,
        zone: snap?.current?.player?.cursor?.zone ?? 0,
        state: snap?.current?.player?.state ?? "?",
      });
    };
    const call = async (path: string, body?: JsonValue): Promise<Rlv2SimSnapshot | null> => {
      const res = await this.gameProxy(uid, `/rlv2/${path}`, "POST", body ?? {});
      if (res.status >= 400) {
        throw new Error(`rlv2/${path} 失败(${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
      }
      // 响应 data: { playerDataDelta: { modified: { rlv2: {...} } } }
      return pickRlv2SimSnapshot(res.data);
    };

    try {
      // 开局
      await call("createGame", { theme, mode: "NORMAL", modeGrade: 0, predefinedId: null });
      // createGame 后状态为 INIT；第一次 finishEvent 触发 GAME_INIT_* 事件生成
      let snap = await call("finishEvent");
      log("createGame", snap);

      // 开局链：INIT 状态消费 GAME_INIT_* 事件（按 pending 顶部选择专用接口，至 zone=1 生成地图）
      let guard = 0;
      while (guard++ < 30) {
        const state = snap?.current?.player?.state;
        const zone = snap?.current?.player?.cursor?.zone;
        if (state === "WAIT_MOVE" && (zone ?? 0) >= 1) break;
        if (state !== "INIT" && state !== "WAIT_MOVE") break;
        // pending 顶部按类型消费（INIT 阶段专用接口：RELIC/RECRUIT_SET/SUPPORT 各司其职，其余走 finishEvent）
        const pending = snap?.current?.player?.pending ?? [];
        const topType = pending[0]?.type ?? "";
        if (topType === "GAME_INIT_RELIC") {
          await call("chooseInitialRelic", { select: "0" });
          log("chooseInitialRelic", snap);
        } else if (topType === "GAME_INIT_RECRUIT_SET") {
          await call("chooseInitialRecruitSet", { select: "0" });
          log("chooseInitialRecruitSet", snap);
        } else if (topType === "GAME_INIT_SUPPORT") {
          const choices = Object.keys(pending[0]?.content?.initSupport?.scene?.choices ?? {});
          await call("selectChoice", { choice: choices[0] ?? "" });
          log("selectChoice(startbuff)", snap);
        } else {
          log("finishEvent(init)", snap);
        }
        snap = await call("finishEvent");
      }
      log("开局完成", snap);

      // 主流程：逐层走到 zone_end → 消费事件 → 推进（至 END 或达到 maxZone）
      let guard2 = 0;
      while (guard2++ < 200) {
        snap = await call("finishEvent");
        const state = snap?.current?.player?.state;
        const zone = snap?.current?.player?.cursor?.zone ?? 0;
        if (state === "END") break;
        if (maxZone !== undefined && zone > maxZone) break;
        if (state !== "WAIT_MOVE" && state !== "PENDING") break;

        // 当前层地图节点（标准地图 zones[zone].nodes；rogue_6 为 gridZone 结构不同，走 route 路径）
        const zones = snap?.current?.map?.zones ?? {};
        const zoneNodes = zones[String(zone)]?.nodes ?? {};
        const nodeIds = Object.keys(zoneNodes);
        if (nodeIds.length === 0) {
          // 网格区域（rogue_6）：route 沿连通路径走到终点
          await this.rogueGridZoneAuto(uid, snap, call, log);
          continue;
        }

        // BFS 找当前节点（或起点）到 zone_end 的最短路径
        const curPos = snap?.current?.player?.cursor?.position;
        const startKey = curPos ? `${curPos.x * 100 + curPos.y}` : null;
        const startIds = startKey && zoneNodes[startKey]
          ? [startKey]
          : nodeIds.filter((id) => {
              const n = zoneNodes[id];
              return n && !n.zone_end && (n.pos?.x ?? 0) <= 1;
            });
        const startId = startIds[0] ?? nodeIds[0];
        const path = this.bfsToZoneEnd(startId, zoneNodes);
        if (path.length === 0) {
          // 无可达终点：直接 finishEvent 尝试推进（防御）
          log("finishEvent(no path)", snap);
          continue;
        }
        // 沿路径逐节点移动 + 消费事件（战斗节点跳过）
        for (const nid of path) {
          const node = zoneNodes[nid];
          if (!node) continue;
          const x = node.pos?.x, y = node.pos?.y;
          if (x === undefined || y === undefined) continue;
          const isBattle = node.type === 1 || node.type === 2 || node.type === 4;
          await call("moveTo", { to: { x, y } });
          log("moveTo", snap);
          // 消费该节点产生的 PENDING 事件
          snap = await this.consumePending(uid, call, log);
          if (isBattle) {
            // 战斗节点：moveTo 不产生事件（type 1/2/4 无场景），空 battleData 跳过
            await call("battleFinish", { data: "", battleData: { isCheat: "0", completeTime: 0 } });
            log("battleFinish(skip)", snap);
          }
          if (node.zone_end) {
            // 到达终点：finishEvent 触发 checkZoneEnd 推进下一层（最终层结算）
            await call("finishEvent");
            log("zone_end→next", snap);
          }
          const st2 = snap?.current?.player?.state;
          if (st2 === "END") break;
          const zn = snap?.current?.player?.cursor?.zone;
          if (zn !== zone) break; // 已推进到下一层
        }
      }
      const finalSnap = await call("gameSettle").catch(() => null) ?? snap;
      log("END", finalSnap);
      return { ok: true, steps, final: finalSnap };
    } catch (e) {
      return { ok: false, steps, final: null, error: (e as Error).message };
    }
  }

  /** 消费当前 PENDING 事件（SCENE→selectChoice 首选项；BATTLE_SHOP→leaveShop；BATTLE→跳过） */
  private async consumePending(
    uid: string,
    call: (path: string, body?: JsonValue) => Promise<Rlv2SimSnapshot | null>,
    log: (action: string, snap: Rlv2SimSnapshot | null) => void,
  ): Promise<Rlv2SimSnapshot | null> {
    let snap: Rlv2SimSnapshot | null = null;
    let guard = 0;
    while (guard++ < 10) {
      snap = await call("finishEvent");
      const state = snap?.current?.player?.state;
      const pending = snap?.current?.player?.pending ?? [];
      if (state === "WAIT_MOVE" && pending.length === 0) break;
      if (pending.length === 0) break;
      const topType = pending[0]?.type ?? "";
      if (topType === "BATTLE_SHOP") {
        await call("leaveShop");
        log("leaveShop", snap);
      } else if (topType === "SCENE") {
        const choices = Object.keys(pending[0]?.content?.scene?.choices ?? {});
        const choice = choices.find((c) => c !== "choice_leave") ?? choices[0];
        await call("selectChoice", { choice: choice ?? "" });
        log("selectChoice(scene)", snap);
      } else if (topType === "BATTLE") {
        await call("battleFinish", { data: "", battleData: { isCheat: "0", completeTime: 0 } });
        log("battleFinish(skip)", snap);
      } else if (topType === "GAME_SETTLE" || topType === "END_RESULT") {
        break;
      } else {
        log(`finishEvent(${topType})`, snap);
      }
    }
    return snap;
  }

  /** rogue_6 网格区域：沿构造模板连通路径（node.next）BFS 到终点，逐节点 route 移动 */
  private async rogueGridZoneAuto(
    uid: string,
    snap: Rlv2SimSnapshot | null,
    call: (path: string, body?: JsonValue) => Promise<Rlv2SimSnapshot | null>,
    log: (action: string, snap: Rlv2SimSnapshot | null) => void,
  ): Promise<void> {
    const zone = snap?.current?.player?.cursor?.zone ?? 0;
    const gz = snap?.current?.module?.gridZone?.zones?.[String(zone)];
    const nodes = gz?.nodes ?? {};
    const ids = Object.keys(nodes);
    if (ids.length === 0) return;
    // 起点：state/show 可见且距其他节点无入边的根节点（简单取第一个 GLADE 或任意）
    const startId = ids.find((id) => nodes[id]?.content?.kind === 268435456) ?? ids[0];
    // BFS 沿 nodes[id].next（gridZone 节点无 next——用 map.zones 邻接或直接全连）
    const curPos = snap?.current?.player?.cursor?.position;
    const startKey = curPos ? `${curPos.x * 100 + curPos.y}` : startId;
    const path = this.bfsGridToEnd(startKey, nodes);
    if (path.length === 0) return;
    await call("gridZoneMoveTo", { route: path });
    log("gridZoneMoveTo", snap);
    // 消费终点事件（商店/战斗跳过/空节点回 WAIT_MOVE）
    snap = await this.consumePending(uid, call, log);
    const lastNode = nodes[path[path.length - 1]];
    if (lastNode?.content?.savage?.stageId) {
      await call("battleFinish", { data: "", battleData: { isCheat: "0", completeTime: 0 } });
      log("battleFinish(skip r6)", snap);
    } else if (lastNode?.content?.shop) {
      await call("leaveShop");
      log("leaveShop(r6)", snap);
    }
    await call("finishEvent");
    log("r6 zone_end→next", snap);
  }

  /** BFS：标准地图 nodes 中从 startId 到 zone_end 节点的最短路径（节点 id 列表，含起点终点） */
  private bfsToZoneEnd(startId: string, nodes: { [nodeId: string]: Rlv2SimMapNode }): string[] {
    if (!nodes[startId]) return [];
    const prev: Record<string, string | null> = { [startId]: null };
    const queue: string[] = [startId];
    let endId: string | null = null;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const node = nodes[cur];
      if (node?.zone_end) { endId = cur; break; }
      const nexts = node?.next ?? [];
      for (const nx of nexts) {
        const nid = `${nx.x * 100 + nx.y}`;
        if (prev[nid] === undefined && nodes[nid]) {
          prev[nid] = cur;
          queue.push(nid);
        }
      }
    }
    if (!endId) return [];
    const path: string[] = [];
    let cur: string | null = endId;
    while (cur !== null) {
      path.unshift(cur);
      cur = prev[cur];
    }
    return path;
  }

  /** BFS：rogue_6 网格节点（无 next 字段，用 map.zones 邻接或全连）到终点 */
  private bfsGridToEnd(startId: string, nodes: { [nodeId: string]: Rlv2SimGridNode }): string[] {
    if (!nodes[startId]) return [];
    const ids = Object.keys(nodes);
    const prev: Record<string, string | null> = { [startId]: null };
    const queue: string[] = [startId];
    let endId: string | null = null;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      // gridZone 节点无 next：终点为 zone_end 或 content.kind 为险路尽头/险路恶敌
      const kind = nodes[cur]?.content?.kind;
      if (nodes[cur]?.zone_end || kind === 8388608 || kind === 4) { endId = cur; break; }
      // 无 next 邻接：退化为所有未访问节点依次相连（网格自由移动）
      for (const nid of ids) {
        if (prev[nid] === undefined && nid !== cur) {
          prev[nid] = cur;
          queue.push(nid);
        }
      }
    }
    if (!endId) return [];
    const path: string[] = [];
    let cur: string | null = endId;
    while (cur !== null) {
      path.unshift(cur);
      cur = prev[cur];
    }
    return path;
  }

  /** 肉鸽流程分步模拟：白名单单步执行（经 gameProxy），返回 rlv2 快照 */
  async rogueSimStep(
    uid: string,
    action: string,
    body?: JsonValue,
  ): Promise<{ ok: boolean; state: Rlv2SimSnapshot | null; error?: string }> {
    const WHITELIST = [
      "createGame", "chooseInitialRelic", "chooseInitialRecruitSet",
      "finishEvent", "selectChoice", "moveTo", "moveAndBattleStart",
      "battleFinish", "leaveShop", "confirmZoneReward", "confirmTraderReturn",
      "gameSettle", "gridZoneMoveTo", "giveUpGame", "specialZoneLeave",
    ];
    if (!WHITELIST.includes(action)) {
      return { ok: false, state: null, error: `非法操作: ${action}（白名单: ${WHITELIST.join("/")}）` };
    }
    try {
      const res = await this.gameProxy(uid, `/rlv2/${action}`, "POST", body ?? {});
      if (res.status >= 400) {
        return { ok: false, state: null, error: `rlv2/${action} 失败(${res.status}): ${JSON.stringify(res.data).slice(0, 300)}` };
      }
      return { ok: true, state: pickRlv2SimSnapshot(res.data) };
    } catch (e) {
      return { ok: false, state: null, error: (e as Error).message };
    }
  }

  /** 肉鸽流程分步：当前 rlv2 状态快照（纯读，无副作用） */
  async rogueSimState(uid: string): Promise<PlayerRoguelikeV2> {
    const pd = await this.getPlayer(uid);
    return pd.rlv2.toJSON();
  }

  /**
   * 上帝视角：按 JSON 路径实时修改 rlv2 内存态，并回写存档。
   * 允许对 player/inventory/record/buff/map/module/troop/game 任意字段做 set/del/inc。
   * 说明：rlv2 的 player/map/module/troop/inventory 为内存 manager（persistCurrent 以
   * manager toJSON 快照为准），直接改 current.* 会被回写覆盖——因此按顶层段路由到
   * 对应 manager 的可变对象上修改，再 persistCurrent 落盘。record/game/buff 直接同居
   * current。直接改内存态是"上帝模式"，绕过状态机事件；客户端下次拉取即生效。
   *
   * @param uid - 目标玩家
   * @param ops  - 操作数组：{ op: "set"|"del"|"inc", path: "player.property.hp.current", value? }
   *              路径以 current 为根，点分号分隔；数字段按数组下标处理。
   * @returns { ok, state, error } — state 为修改后完整 rlv2 快照
   */
  async rogueModifyState(
    uid: string,
    ops: { op: "set" | "del" | "inc"; path: string; value?: JsonValue }[],
  ): Promise<{ ok: boolean; state: PlayerRoguelikeV2 | null; error?: string }> {
    try {
      const pd = await this.getPlayer(uid);
      const ctl = pd.rlv2;
      if (!ctl?.current) {
        return { ok: false, state: null, error: "该玩家无 rlv2 上下文（未发起对局或已卸载）" };
      }
      for (const op of ops || []) {
        const segs = String(op.path ?? "").split(".").filter(Boolean);
        if (segs.length === 0) throw new Error("操作路径不能为空");
        // 顶层段路由到对应 manager 的可变权威对象（record/game/buff 直接落在 current）
        const { root, rest } = rlv2AuthoritativeRoot(ctl, segs);
        applyRlv2Patch(root, op.op, rest, op.value);
        this._audit("rogueModify", uid, `${op.op} ${op.path}`);
      }
      // 内存 manager 快照写回存档（供重登"继续探索"），同 rlv2Response 的持久化契约
      ctl.persistCurrent();
      return { ok: true, state: ctl.toJSON() };
    } catch (e) {
      return { ok: false, state: null, error: (e as Error).message };
    }
  }

  /** 卡池清单（excel.GachaTable.gachaPoolClient） */
  listPools(): PoolSummary[] {
    return (excel.GachaTable?.gachaPoolClient ?? []).map((p) => ({
      poolId: p.gachaPoolId,
      name: p.gachaPoolName,
      ruleType: p.gachaRuleType,
      gachaType: GACHA_RULE_TYPE[p.gachaRuleType] ?? "single",
      openTime: p.openTime,
      endTime: p.endTime,
      guarantee5Count: p.guarantee5Count,
      guarantee5Avail: p.guarantee5Avail,
      summary: p.gachaPoolSummary ?? "",
    }));
  }

  /** 卡池详情（UP/可用干员 + 概率；不存在返回 null） */
  poolDetail(poolId: string): PoolDetail | null {
    const pool = (excel.GachaTable?.gachaPoolClient ?? []).find(
      (p) => p.gachaPoolId === poolId,
    );
    if (!pool) return null;
    const detail = excel.GachaDetailTable?.details?.[poolId];
    const mapList = (
      list?: { charIdList: string[]; percent?: number; count?: number; rarityRank?: number }[],
    ): PoolCharInfo[] =>
      (list ?? []).flatMap((per) =>
        per.charIdList.map((charId) => ({
          charId,
          name: charName(charId),
          percent: per.percent,
          count: per.count,
          rarityRank: per.rarityRank,
        })),
      );
    return {
      poolId,
      name: pool.gachaPoolName,
      ruleType: pool.gachaRuleType,
      gachaType: GACHA_RULE_TYPE[pool.gachaRuleType] ?? "single",
      openTime: pool.openTime,
      endTime: pool.endTime,
      guarantee5Count: pool.guarantee5Count,
      guarantee5Avail: pool.guarantee5Avail,
      summary: pool.gachaPoolSummary ?? "",
      upChars: mapList(detail?.upCharInfo?.perCharList),
      availChars: mapList(detail?.availCharInfo?.perAvailList),
      limitedChars: detail?.limitedChar ?? [],
    };
  }

  /** 玩家卡池状态（UP 选择 + 保底计数） */
  async getPlayerPoolState(uid: string, poolId: string): Promise<PlayerPoolState> {
    const pool = (excel.GachaTable?.gachaPoolClient ?? []).find(
      (p) => p.gachaPoolId === poolId,
    );
    if (!pool) {
      throw new Error(`卡池不存在: ${poolId}`);
    }
    const pd = await this.getPlayer(uid);
    const gachaType = GACHA_RULE_TYPE[pool.gachaRuleType] ?? "single";
    // gacha[gachaType][poolId].upChar：gachaType 是运行时字符串（生成模型 PlayerGacha 只有
    // 固定键），upChar 又有字典/数组两种形态（见 gacha/logic._selfSelectedUpForRank）——
    // 动态下钻统一走 json-path，避免 cast；只取数组形态（管理后台写入形态）
    const upChar = getIn(pd._playerdata.gacha, [gachaType, poolId, "upChar"]);
    const upCharIds: string[] = Array.isArray(upChar)
      ? upChar.filter((id) => typeof id === "string")
      : [];
    const beforeNonHitCnt = await accountManager.getBeforeNonHitCnt(
      uid,
      pool.gachaRuleType,
    );
    return {
      poolId,
      name: pool.gachaPoolName,
      ruleType: pool.gachaRuleType,
      gachaType,
      upCharIds,
      upChars: upCharIds.map((id) => ({ charId: id, name: charName(id) })),
      beforeNonHitCnt,
      guarantee5Count: pool.guarantee5Count,
    };
  }

  /**
   * 设置玩家卡池 UP 选择（空数组清除；与 choosePoolUp 写入同一位置 gacha[gachaType][poolId].upChar）
   * @returns 更新后的玩家卡池状态
   */
  async setPlayerPoolUp(
    uid: string,
    poolId: string,
    charIds: string[],
  ): Promise<PlayerPoolState> {
    const pool = (excel.GachaTable?.gachaPoolClient ?? []).find(
      (p) => p.gachaPoolId === poolId,
    );
    if (!pool) {
      throw new Error(`卡池不存在: ${poolId}`);
    }
    const clean = charIds.map(String).map(resolveCharRef).filter(Boolean);
    const pd = await this.getPlayer(uid);
    const gachaType = GACHA_RULE_TYPE[pool.gachaRuleType] ?? "single";
    await pd.update(async (draft) => {
      // gacha[gachaType][poolId].upChar（gachaType 为运行时字符串）：逐层补建缺失容器
      // 的语义与迁移前一致，收敛在 json-path.setIn（自动创建中间对象）
      setIn(draft.gacha, [gachaType, poolId, "upChar"], clean);
    });
    await this.savePlayer(uid);
    await this._audit(
      "setPoolUp",
      uid,
      `${poolId} → ${clean.join(",") || "（清除）"}`,
    );
    return this.getPlayerPoolState(uid, poolId);
  }

  /**
   * 设置玩家保底计数（保底按 gachaRuleType 存于账号配置，如 NORMAL/LIMITED/CLASSIC）
   * @returns 更新后的保底计数
   */
  async setPlayerPity(
    uid: string,
    ruleType: string,
    count: number,
  ): Promise<{ uid: string; ruleType: string; beforeNonHitCnt: number }> {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`保底计数必须为非负整数: ${count}`);
    }
    await this.getPlayer(uid);
    const key = String(ruleType).toUpperCase();
    await accountManager.saveBeforeNonHitCnt(uid, key, count);
    await this.savePlayer(uid);
    await this._audit("setPity", uid, `${key} → ${count}`);
    return {
      uid,
      ruleType: key,
      beforeNonHitCnt: await accountManager.getBeforeNonHitCnt(uid, key),
    };
  }

  /** 查看玩家某规则类型保底计数 */
  async getPlayerPity(
    uid: string,
    ruleType: string,
  ): Promise<{ uid: string; ruleType: string; beforeNonHitCnt: number }> {
    await this.getPlayer(uid);
    const key = String(ruleType).toUpperCase();
    return {
      uid,
      ruleType: key,
      beforeNonHitCnt: await accountManager.getBeforeNonHitCnt(uid, key),
    };
  }

  /** 列出玩家全部规则类型的保底计数 */
  async listPlayerPity(
    uid: string,
  ): Promise<{ ruleType: string; beforeNonHitCnt: number }[]> {
    await this.getPlayer(uid);
    const gacha = accountManager.configs[uid]?.gacha ?? {};
    return Object.entries(gacha).map(([ruleType, v]) => ({
      ruleType,
      beforeNonHitCnt: v?.beforeNonHitCnt ?? 0,
    }));
  }

  /**
   * 批量发放全部 ItemTable 物品（sortId>0；CONSUME → consumable，其余 → inventory）
   * @returns 发放物品种数
   */
  async grantAllItems(uid: string, count = 999): Promise<{ items: number }> {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`数量必须为正整数: ${count}`);
    }
    const pd = await this.getPlayer(uid);
    let n = 0;
    await pd.update(async (draft) => {
      for (const [itemId, info] of Object.entries(excel.ItemTable?.items ?? {})) {
        if (info.sortId <= 0) continue;
        if (info.classifyType === "CONSUME") {
          draft.consumable[itemId] = { "0": { ts: -1, count } };
        } else if (info.classifyType === "NORMAL" || info.classifyType === "MATERIAL") {
          draft.inventory[itemId] = count;
        } else {
          continue;
        }
        n++;
      }
    });
    await this.savePlayer(uid);
    await this._audit("grantAllItems", uid, `${n} 种物品 x${count}`);
    return { items: n };
  }

  /**
   * 批量拉满全部已有干员（精二满级/满潜/满技能/专三/满信赖/满专精装备；不含资源/背包）
   * @returns 拉满干员数
   */
  async maxAllChars(uid: string): Promise<{ chars: number }> {
    const pd = await this.getPlayer(uid);
    let n = 0;
    await pd.update(async (draft) => {
      for (const ch of Object.values(draft.troop?.chars ?? {})) {
        const charData = excel.charData(ch.charId);
        const phases = charData?.phases;
        const maxEvolve = phases?.length ? phases.length - 1 : 2;
        ch.evolvePhase = maxEvolve;
        ch.level = phases?.[maxEvolve]?.maxLevel ?? 90;
        ch.exp = 0;
        ch.potentialRank = 5;
        ch.mainSkillLvl = 7;
        ch.favorPoint = 25570;
        const skills = buildMaxedSkills(charData);
        if (skills.length) {
          ch.skills = skills;
          ch.defaultSkillIndex = ch.defaultSkillIndex ?? 0;
        }
        const { ids: equipIds, equip } = buildMaxedEquip(ch.charId);
        ch.currentEquip = equipIds[0] || null;
        // buildMaxedEquip 的 MaxedEquipEntry 与 PlayerCharEquipInfo 同形（hide/locked/level）
        ch.equip = equip;
        n++;
      }
    });
    await this.savePlayer(uid);
    await this._audit("maxAllChars", uid, `${n} 名干员`);
    return { chars: n };
  }

  /** 玩家推图进度（只读：已解锁/已完成关卡） */
  async listStages(
    uid: string,
  ): Promise<{
    total: number;
    done: number;
    stages: { stageId: string; state: number; completeTimes: number }[];
  }> {
    const pd = await this.getPlayer(uid);
    const stages = pd._playerdata.dungeon?.stages ?? {};
    const list = Object.entries(stages)
      .map(([stageId, s]) => ({
        stageId,
        state: s.state,
        completeTimes: s.completeTimes,
      }))
      .sort((a, b) => a.stageId.localeCompare(b.stageId));
    return {
      total: list.length,
      done: list.filter((s) => s.completeTimes > 0).length,
      stages: list.slice(0, 500),
    };
  }

  /** 解锁指定关卡（标记已完成 state=3 + completeTimes=1） */
  async unlockStage(uid: string, stageId: string): Promise<{ stageId: string }> {
    if (!excel.StageTable?.stages?.[stageId]) {
      throw new Error(`关卡不存在: ${stageId}`);
    }
    const pd = await this.getPlayer(uid);
    await pd.update(async (draft) => {
      draft.dungeon.stages[stageId] = {
        stageId,
        completeTimes: 1,
        startTimes: 1,
        practiceTimes: 0,
        state: 3,
        hasBattleReplay: 0,
        noCostCnt: 0,
      };
    });
    await this.savePlayer(uid);
    await this._audit("unlockStage", uid, stageId);
    return { stageId };
  }

  /** 推图全解锁（遍历 StageTable 全部关卡，跳过已有进度的） */
  async unlockAllStages(uid: string): Promise<{ stages: number; total: number }> {
    const pd = await this.getPlayer(uid);
    const ids = Object.keys(excel.StageTable?.stages ?? {});
    let n = 0;
    await pd.update(async (draft) => {
      for (const stageId of ids) {
        if (draft.dungeon.stages[stageId]) continue;
        draft.dungeon.stages[stageId] = {
          stageId,
          completeTimes: 1,
          startTimes: 1,
          practiceTimes: 0,
          state: 3,
          hasBattleReplay: 0,
          noCostCnt: 0,
        };
        n++;
      }
    });
    await this.savePlayer(uid);
    await this._audit("unlockAllStages", uid, `新增 ${n} 关（共 ${ids.length} 关）`);
    return { stages: n, total: ids.length };
  }

  /**
   * 物品搜索（按 ID/中文名过滤 ItemTable；供发放弹窗选择）
   * @param q - 关键字（空返回前 limit 条）
   * @returns 匹配物品（id/name/classifyType）
   */
  searchItems(q: string, limit = 50): { id: string; name: string; classifyType: string }[] {
    const kw = String(q ?? "").trim().toLowerCase();
    const items = excel.ItemTable?.items ?? {};
    const list: { id: string; name: string; classifyType: string }[] = [];
    for (const [id, info] of Object.entries(items)) {
      const name = info?.name ?? "";
      if (!kw || id.toLowerCase().includes(kw) || name.toLowerCase().includes(kw)) {
        list.push({ id, name, classifyType: info?.classifyType ?? "" });
        if (list.length >= limit) break;
      }
    }
    return list;
  }

  /** 任务进度统计（只读：各组任务数/已完成数；state≥2 视为已完成） */
  async listMissionStats(
    uid: string,
  ): Promise<{
    total: number;
    done: number;
    groups: { group: string; total: number; done: number }[];
  }> {
    const pd = await this.getPlayer(uid);
    const missions = pd._playerdata.mission?.missions ?? {};
    const groups = Object.entries(missions).map(([group, byId]) => {
      const list = Object.values(byId ?? {});
      return {
        group,
        total: list.length,
        done: list.filter((m) => m.state >= 2).length,
      };
    });
    return {
      total: groups.reduce((s, g) => s + g.total, 0),
      done: groups.reduce((s, g) => s + g.done, 0),
      groups,
    };
  }

  /** 勋章进度（只读：已解锁/总数；fts>0 视为已解锁） */
  async listMedals(
    uid: string,
  ): Promise<{ total: number; unlocked: number; medals: { id: string; unlocked: boolean; fts: number }[] }> {
    const pd = await this.getPlayer(uid);
    const medals = pd._playerdata.medal?.medals ?? {};
    const list = Object.values(medals)
      .map((m) => ({ id: m.id, unlocked: m.fts > 0, fts: m.fts }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      total: list.length,
      unlocked: list.filter((m) => m.unlocked).length,
      medals: list.slice(0, 500),
    };
  }

  /**
   * 导出用户存档到 JSON 文件（默认 ./exports/{uid}-{ts}.json）
   * @returns 导出路径与大小
   */
  async exportUser(
    uid: string,
    targetPath?: string,
  ): Promise<{ uid: string; path: string; size: number }> {
    // SQLite 感知：方案 A+C 下存档主体在库（gzip BLOB），直读文件对库内账号 ENOENT
    const data = await accountManager.readPlayerData(uid);
    if (!data) {
      throw new Error(`用户不存在: ${uid}`);
    }
    const out = targetPath ?? `./exports/${uid}-${formatTs(now())}.json`;
    await mkdir(path.dirname(out), { recursive: true });
    await writeJson(out, data);
    const size = (await readFile(out)).length;
    await this._audit("exportUser", uid, out);
    return { uid, path: out, size };
  }

  /**
   * 从 JSON 文件导入存档（替换指定 uid；uid 缺省取文件内 status.uid）
   * @returns 目标 uid
   */
  async importUser(filePath: string, uid?: string): Promise<{ uid: string }> {
    const data = await readJson<PlayerDataModel>(filePath);
    if (!data?.status?.uid) {
      throw new Error(`存档缺少 status.uid，无法导入: ${filePath}`);
    }
    const targetUid = uid ?? String(data.status.uid);
    accountManager.data[targetUid] = new PlayerDataManager(data);
    await this.savePlayer(targetUid);
    await this._audit("importUser", targetUid, filePath);
    return { uid: targetUid };
  }

  /** 数据完整性校验：遍历已加载用户，检查 status/troop 与 JSON 可序列化 */
  async checkData(): Promise<{
    ok: boolean;
    users: { uid: string; ok: boolean; error?: string }[];
  }> {
    const uids = Object.keys(accountManager.data).sort((a, b) => Number(a) - Number(b));
    const users: { uid: string; ok: boolean; error?: string }[] = [];
    for (const uid of uids) {
      try {
        const d = (await accountManager.getPlayerData(uid))._playerdata;
        if (!d?.status || !d?.troop) {
          throw new Error("缺少 status/troop");
        }
        // 干员结构校验（历史问题：旧生成器 currentTmpl:null 卡死——逐字段检查）
        const chars = d.troop?.chars ?? {};
        for (const [instId, ch] of Object.entries(chars)) {
          if (!ch?.charId || !excel.charData(ch.charId)) {
            throw new Error(`干员 instId=${instId} 缺失 charId 或不在 CharacterTable`);
          }
          // 逐字段检查（字段名限定为生成模型的键，直接索引不再需要 any）
          const requiredFields: (keyof PlayerCharacter)[] = [
            "level", "evolvePhase", "potentialRank", "mainSkillLvl", "favorPoint", "gainTime", "voiceLan",
          ];
          for (const f of requiredFields) {
            if (ch[f] === undefined) {
              throw new Error(`干员 ${ch.charId}(instId=${instId}) 缺少 ${f}`);
            }
          }
          if (ch.charId === "char_002_amiya" && (!ch.currentTmpl || !ch.tmpl)) {
            throw new Error("阿米娅缺少 currentTmpl/tmpl（旧生成器结构问题）");
          }
        }
        JSON.stringify(d); // 可序列化检查
        users.push({ uid, ok: true });
      } catch (e) {
        users.push({ uid, ok: false, error: (e as Error).message });
      }
    }
    return { ok: users.every((u) => u.ok), users };
  }

  /** 存档文件级校验：遍历磁盘 data/user/databases/*.json（含未加载用户），检查可解析与基本结构 */
  async checkDataFiles(): Promise<{
    ok: boolean;
    files: { uid: string; ok: boolean; error?: string }[];
  }> {
    let names: string[] = [];
    try {
      names = await readdir("./data/user/databases");
    } catch {
      return { ok: true, files: [] };
    }
    const files: { uid: string; ok: boolean; error?: string }[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const uid = name.replace(/\.json$/, "");
      try {
        const d = await readJson<PlayerDataModel>(`./data/user/databases/${name}`);
        if (!d?.status || !d?.troop) {
          throw new Error("缺少 status/troop");
        }
        JSON.stringify(d);
        files.push({ uid, ok: true });
      } catch (e) {
        files.push({ uid, ok: false, error: (e as Error).message });
      }
    }
    return { ok: files.every((f) => f.ok), files };
  }

  /** 活动数据摘要（只读：各类型活动数） */
  async getActivitySummary(
    uid: string,
  ): Promise<{ total: number; types: { type: string; activities: number }[] }> {
    const pd = await this.getPlayer(uid);
    const act = pd._playerdata.activity ?? {};
    const types = Object.entries(act)
      .map(([type, v]) => ({
        type,
        activities: v && typeof v === "object" ? Object.keys(v).length : 0,
      }))
      .filter((t) => t.activities > 0);
    return { total: types.reduce((s, t) => s + t.activities, 0), types };
  }

  /**
   * 活动列表 + 开关状态（activity 切换，参考 DoctoratePy developer.timestamp + 自定义强制开启）
   * @returns 当前冻结时间戳/生效时间戳 + 各活动窗口与 open 判定 + 强制开启/合约赛季配置
   */
  async listActivities(): Promise<{
    timestamp: number;
    effectiveTs: number;
    usingOverride: boolean;
    forceOpen: string[];
    crisisV1: string;
    crisisV2: string;
    autoBackfill: boolean;
    crisisSeasons: { v1: string[]; v2: string[] };
    activities: {
      id: string;
      name: string;
      type: string;
      displayType: string;
      startTime: number;
      endTime: number;
      rewardEndTime: number;
      open: boolean;
      forced: boolean;
    }[];
  }> {
    const frozen = config.developer?.timestamp ?? -1;
    const effectiveTs = userTimestamp();
    const forced = forcedActivityIds();
    const basicInfo = excel.ActivityTable?.basicInfo ?? {};
    const activities = Object.values(basicInfo)
      // 防御：basicInfo 含 null 占位条目（20/331）
      .filter((info) => info && typeof info === "object")
      .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
      .map((info) => ({
        id: info.id,
        name: info.name ?? "",
        type: info.type ?? "",
        displayType: info.displayType ?? "",
        startTime: info.startTime ?? 0,
        endTime: info.endTime ?? 0,
        rewardEndTime: info.rewardEndTime ?? 0,
        open: info.startTime <= effectiveTs && effectiveTs <= info.rewardEndTime,
        forced: forced.has(info.id),
      }));
    const seasons = await listCrisisSeasons();
    return {
      timestamp: frozen,
      effectiveTs,
      usingOverride: frozen !== -1,
      forceOpen: [...forced],
      crisisV1: config.activities?.crisisV1 ?? "cc1",
      crisisV2: config.activities?.crisisV2 ?? "cc1",
      autoBackfill: config.activities?.autoBackfill !== false,
      crisisSeasons: seasons,
      activities,
    };
  }

  /**
   * 切换活动（自定义活动切换：时间冻结 + 强制开启 + 合约赛季选择）
   *
   * 兼容旧调用：传数字等价于 { timestamp: 数字 }。
   * - timestamp: -1 恢复真实时间；数值冻结到该时间戳（仅允许过去时间，未来拒绝）
   * - forceOpen: 强制开启的活动 ID 列表（basicInfo.id，忽略时间窗口播种且不修剪）
   * - crisisV1/crisisV2: 危机合约赛季选择（data/crisis*.json 文件名，须存在）
   * 生效后对已加载玩家重跑活动播种，并按 activities.autoBackfill 后台补全缺失 asset。
   */
  async switchActivity(
    params: number | {
      timestamp?: number;
      forceOpen?: string[];
      crisisV1?: string;
      crisisV2?: string;
    },
  ): Promise<{
    ok: true;
    timestamp: number;
    effectiveTs: number;
    openCount: number;
    forceOpen: string[];
    crisisV1: string;
    crisisV2: string;
    backfillTasks: string[];
  }> {
    const p = typeof params === "number" ? { timestamp: params } : params;
    const timestamp = p.timestamp ?? config.developer?.timestamp ?? -1;
    if (timestamp !== -1) {
      if (!Number.isFinite(timestamp)) {
        throw new Error(`时间戳非法: ${timestamp}`);
      }
      // 校验基准取真实时钟：虚拟时钟（config.virtualtime）可能已冻结到过去，
      // 用 now() 会把「真实时间的过去」误判为未来而拒绝（开发者覆盖恒优先于虚拟时钟）
      const timeNow = realNow();
      if (timestamp > timeNow) {
        throw new Error(
          `不能设置未来时间（${timestamp} > 当前 ${timeNow}）；仅支持冻结到过去时间`,
        );
      }
    }
    const basicInfo = excel.ActivityTable?.basicInfo ?? {};
    const seasons = await listCrisisSeasons();
    // 校验合约赛季存在（文件缺失时拒绝，避免客户端拿到空数据）
    const crisisV1 = p.crisisV1 ?? config.activities?.crisisV1 ?? "cc1";
    const crisisV2 = p.crisisV2 ?? config.activities?.crisisV2 ?? "cc1";
    if (!seasons.v1.includes(crisisV1)) {
      throw new Error(`危机合约V1赛季 ${crisisV1} 不存在（可用: ${seasons.v1.join(", ")}）`);
    }
    if (!seasons.v2.includes(crisisV2)) {
      throw new Error(`危机合约V2赛季 ${crisisV2} 不存在（可用: ${seasons.v2.join(", ")}）`);
    }
    // 校验强制开启活动 ID 存在（大小写不敏感 + 前缀/包含近似提示）
    const forceOpen = p.forceOpen ?? config.activities?.forceOpen ?? [];
    for (const id of forceOpen) {
      if (!basicInfo[id]) {
        const keys = Object.keys(basicInfo);
        const fuzzy =
          keys.find((k) => k.toLowerCase() === id.toLowerCase()) ??
          keys.find((k) => k.toLowerCase().startsWith(id.toLowerCase())) ??
          keys.find((k) => id.toLowerCase().startsWith(k.toLowerCase())) ??
          keys.find((k) => k.toLowerCase().includes(id.toLowerCase()));
        throw new Error(
          `强制开启活动 ${id} 不在 basicInfo（${fuzzy ? `疑似应为 ${fuzzy}` : "无近似匹配"}）`,
        );
      }
    }
    // 持久化 data/config.json（读-改-写，保留其它字段）
    // 类型取内存 config 的同一形状（`typeof config`）：磁盘文件即该对象的序列化形态
    const cfg = readJsonSync<typeof config>("./data/config.json");
    cfg.developer = { timestamp };
    cfg.activities = {
      ...(cfg.activities ?? {}),
      forceOpen,
      crisisV1,
      crisisV2,
    };
    await writeJson("./data/config.json", cfg);
    // 内存 config 同步——userTimestamp/unlockActivity/crisis 立即读取新值，无需重启
    config.developer = { timestamp };
    config.activities = cfg.activities ?? {};

    // 对已加载玩家重跑活动播种（新玩家加载时 _doLoadPlayer 也会播种）
    for (const uid of Object.keys(accountManager.data)) {
      try {
        await unlockActivity(accountManager.data[uid]);
      } catch (error) {
        logger.warn("AdminService", `活动播种失败 ${uid}: ${(error as Error).message}`);
      }
    }
    const effectiveTs = userTimestamp();
    const windowOpen = Object.values(basicInfo).filter(
      (info) => info && info.startTime <= effectiveTs && effectiveTs <= info.rewardEndTime,
    ).length;
    const openCount = windowOpen + forceOpen.length;
    // 自动补全缺失 asset（后台任务；强制开启的活动 + 选中合约赛季）
    const backfillTargets = [...new Set([...forceOpen, crisisV1, crisisV2])];
    const backfillTasks: string[] = [];
    if ((config.activities?.autoBackfill ?? true) !== false) {
      for (const target of backfillTargets) {
        const task = await autoBackfillAfterSwitch(target, "Android").catch((error) => {
          logger.warn("AdminService", `活动 ${target} 自动补全启动失败: ${(error as Error).message}`);
          return null;
        });
        if (task) backfillTasks.push(task.id);
      }
    }
    await this._audit(
      "switchActivity",
      "all",
      JSON.stringify({ timestamp, forceOpen, crisisV1, crisisV2, effectiveTs }),
    );
    return {
      ok: true,
      timestamp,
      effectiveTs,
      openCount,
      forceOpen,
      crisisV1,
      crisisV2,
      backfillTasks,
    };
  }

  /**
   * 启动资产补全后台任务（自动补全过往活动缺失的 asset）
   * @param target   - all（全部关卡）| 活动 id | 危机赛季 id
   * @param platform - 平台键（缺省 Android）
   * @returns 后台任务对象（status=running，进度经 getBackfillTaskStatus 查询）
   */
  async backfillAssets(target: string, platform = "Android"): Promise<BackfillTask> {
    const task = await startBackfillTask(target, platform);
    await this._audit("backfillAssets", "all", `target=${target} platform=${platform} task=${task.id}`);
    return task;
  }

  /** 查询资产补全后台任务 */
  getBackfillTaskStatus(id: string): BackfillTask | undefined {
    return getAssetBackfillTask(id);
  }

  /** 最近资产补全后台任务列表（新→旧） */
  listAssetBackfillTasks(): BackfillTask[] {
    return listAssetBackfillTasks();
  }

  /**
   * 删除用户（危险操作：删除存档文件 + 从 configs/data 移除 + saveUserConfig 同步 SQLite）
   * @param uid - 目标用户
   * @param confirmWord - 确认词，必须为 "DELETE"（防误删）
   */
  async deleteUser(uid: string, confirmWord = ""): Promise<{ uid: string }> {
    if (confirmWord !== "DELETE") {
      throw new Error("危险操作：需传 confirmWord=\"DELETE\" 确认");
    }
    if (!accountManager.configs[uid] && !accountManager.data[uid]) {
      throw new Error(`用户不存在: ${uid}`);
    }
    if (Object.keys(accountManager.configs).length <= 1) {
      throw new Error("不能删除最后一个用户");
    }
    // B-2 统一清理：存档文件 + configs/data + SQLite（users/社交/回放/结算）
    await accountManager.deleteAccount(uid);
    await this._audit("deleteUser", uid, "已删除");
    return { uid };
  }

  /**
   * 禁用/启用用户（Dashboard 禁用用户：登录与鉴权立即被 AccountManager 拦截）
   * @param uid - 目标用户
   * @param disabled - true=禁用；false=启用
   * @returns 操作结果（含最新 disabled 状态）
   */
  async setUserDisabled(uid: string, disabled: boolean): Promise<{ uid: string; disabled: boolean }> {
    const conf = accountManager.configs[uid];
    if (!conf) {
      throw new Error(`用户不存在: ${uid}`);
    }
    conf.disabled = !!disabled;
    await accountManager.saveUserConfig();
    await this._audit("setUserDisabled", uid, disabled ? "已禁用" : "已启用");
    return { uid, disabled: conf.disabled };
  }

  /**
   * 修复干员结构（对应历史"旧生成器干员结构"问题，如 check 发现的缺 voiceLan）：
   * 补齐 voiceLan/starMark/favorPoint/gainTime/skills/equip，阿米娅补 currentTmpl/tmpl 三形态。
   * @returns 修复统计 {chars: 有缺口的干员数, fields: 补全字段数}
   */
  async repairChars(uid: string): Promise<{ chars: number; fields: number }> {
    const pd = await this.getPlayer(uid);
    let chars = 0;
    let fields = 0;
    await pd.update(async (draft) => {
      for (const ch of Object.values(draft.troop?.chars ?? {})) {
        let changed = false;
        const patch = (cond: boolean, fn: () => void): void => {
          if (cond) {
            fn();
            changed = true;
            fields++;
          }
        };
        patch(ch.voiceLan === undefined, () => {
          ch.voiceLan = "CN_MANDARIN";
        });
        patch(ch.starMark === undefined, () => {
          ch.starMark = 0;
        });
        patch(ch.favorPoint === undefined, () => {
          ch.favorPoint = 0;
        });
        patch(ch.gainTime === undefined, () => {
          ch.gainTime = now();
        });
        const charData = excel.charData(ch.charId);
        patch(!ch.skills || !ch.skills.length, () => {
          const skills = buildMaxedSkills(charData);
          if (skills.length) {
            ch.skills = skills;
            ch.defaultSkillIndex = 0;
          }
        });
        patch(ch.equip === undefined, () => {
          const { ids: equipIds, equip } = buildMaxedEquip(ch.charId);
          ch.currentEquip = equipIds[0] || null;
          ch.equip = equip;
        });
        patch(ch.charId === "char_002_amiya" && (!ch.currentTmpl || !ch.tmpl), () => {
          applyAmiyaTemplate(ch, ch.instId);
        });
        if (changed) chars++;
      }
    });
    await this.savePlayer(uid);
    await this._audit("repairChars", uid, `${chars} 名干员 / ${fields} 个字段`);
    return { chars, fields };
  }

  /** 玩家签到状态（只读） */
  async getCheckInState(uid: string): Promise<CheckInState> {
    const pd = await this.getPlayer(uid);
    const ci = pd._playerdata.checkIn;
    const group = excel.CheckinTable?.groups?.[ci?.checkInGroupId];
    return {
      groupId: ci?.checkInGroupId ?? "",
      groupTitle: group?.title ?? "",
      canCheckIn: ci?.canCheckIn ?? 0,
      rewardIndex: ci?.checkInRewardIndex ?? 0,
      historyCount: (ci?.checkInHistory ?? []).length,
      total: group?.items?.length ?? 0,
    };
  }

  /** 重置签到（切到当前进行中的签到组，清空进度） */
  async resetCheckIn(uid: string): Promise<CheckInState> {
    const pd = await this.getPlayer(uid);
    await pd.checkIn.monthlyRefresh();
    await this.savePlayer(uid);
    await this._audit("resetCheckIn", uid, "重置签到");
    return this.getCheckInState(uid);
  }

  /**
   * 发放推送信息（设置玩家 pushFlags——客户端 syncData/syncPushMessage 增量下发红点/通知）
   *
   * pushFlags 语义（客户端读取显示红点）：
   *   hasGifts=1 有未领取礼物；hasFriendRequest=1 有好友申请；
   *   hasClues=1 有线索待处理；hasFreeLevelGP=1 有免费等级礼包
   * @param uid - 目标用户 uid
   * @param flags - 要设置的推送标记（只更新传入的键；传 0 清除）
   * @returns 更新后的 pushFlags
   */
  async pushMessage(
    uid: string,
    flags: {
      hasGifts?: number;
      hasFriendRequest?: number;
      hasClues?: number;
      hasFreeLevelGP?: number;
    },
  ): Promise<Record<string, number>> {
    const pd = await this.getPlayer(uid);
    await pd.update(async (draft) => {
      if (flags.hasGifts != null) draft.pushFlags.hasGifts = flags.hasGifts;
      if (flags.hasFriendRequest != null)
        draft.pushFlags.hasFriendRequest = flags.hasFriendRequest;
      if (flags.hasClues != null) draft.pushFlags.hasClues = flags.hasClues;
      if (flags.hasFreeLevelGP != null)
        draft.pushFlags.hasFreeLevelGP = flags.hasFreeLevelGP;
    });
    await this.savePlayer(uid);
    const changed = Object.entries(flags)
      .filter(([, v]) => v != null)
      .map(([k]) => k)
      .join(",");
    await this._audit("pushMessage", uid, `发放推送信息: ${changed}`);
    return { ...pd._playerdata.pushFlags };
  }

  /** 代签（领取当前档位奖励；当日已签返回空奖励） */
  async doCheckIn(
    uid: string,
  ): Promise<{ rewards: { id: string; name: string; count: number }[]; state: CheckInState }> {
    const pd = await this.getPlayer(uid);
    const res = await pd.checkIn.checkIn();
    await this.savePlayer(uid);
    const rewards = [...(res?.signInRewards ?? []), ...(res?.subscriptionRewards ?? [])].map(
      (r) => ({ id: r.id, name: itemName(r.id), count: r.count }),
    );
    await this._audit(
      "doCheckIn",
      uid,
      rewards.length ? `奖励 ${rewards.map((r) => `${r.name}x${r.count}`).join(",")}` : "当日已签",
    );
    return { rewards, state: await this.getCheckInState(uid) };
  }

  /**
   * 官服账号迁移（联网拉取官服数据 → 转私服存档 → 注册账号）
   * 成功后热加载新用户到内存（服务器运行中可直接使用），并写审计日志。
   * @param accountsText - 账号内容文本（每行「手机号 密码」或两行一组「手机号\n密码」）
   * @param templateUid - 模板存档 uid（私服特有字段兜底，默认 1）
   * @returns 每账号迁移结果（成功 uid/昵称，失败 error；单个失败不中断）
   */
  async migrateOfficial(
    accountsText: string,
    templateUid = "1",
  ): Promise<Awaited<ReturnType<typeof runMigration>>> {
    if (!accountsText?.trim()) {
      throw new Error("账号内容为空");
    }
    const results = await runMigration({
      accounts: accountsText,
      templateUid,
    });
    // 修复：迁移账号必须同步进内存 configs——否则下次 saveUserConfig → upsertAll
    // 会删除不在 configs 的 uid（registerImportedUser 只写 SQLite/users，不更新 configs）
    // → 迁移账号在下一次任何保存时从 users 表消失（账号丢失/重复注册）
    const migrated = await loadUsers();
    for (const r of results) {
      if (r.uid) {
        if (migrated[r.uid]) {
          accountManager.configs[r.uid] = migrated[r.uid];
        }
        try {
          await this.reloadUser(r.uid); // 热加载到内存（服务器运行中创建后立即可用）
        } catch (e) {
          logger.warn(
            "AdminService",
            `迁移后加载用户 ${r.uid} 失败: ${(e as Error).message}`,
          );
        }
        // 官服枢纽宠物继承（官服存档不含宠物，只存在于官服网关户籍——按官服 uid 匹配
        // 本机网关抓包还原；无匹配抓包时静默跳过，不阻断迁移。见 app/ops/admin/arkhub-pets.ts）
        try {
          const pets = await this.importArkhubPets(r.uid, undefined, r.officialUid);
          if (pets.imported) {
            logger.info(
              "AdminService",
              `迁移 ${r.uid} 继承官服宠物: 图鉴+${pets.dexAdded} 个体+${pets.bagAdded}`,
            );
          }
        } catch (e) {
          logger.warn(
            "AdminService",
            `迁移 ${r.uid} 宠物还原失败（不阻断迁移）: ${(e as Error).message}`,
          );
        }
        await this._audit(
          "officialMigrate",
          r.uid,
          `${r.phone} 昵称=${r.nickName ?? ""}`,
        );
      }
    }
    return results;
  }

  /**
   * 官服枢纽宠物还原（旧存档/官服账号导入后继承原有宠物）
   *
   * 官服 playerdata 不含枢纽宠物（仅网关户籍持有）——从官服网关抓包（tmp/capture/
   * gateway-bidi）提取 EnterSceneNotify 的 CreatureData/ArkhubItemData 并合并进存档。
   * @param uid - 私服目标账号 uid
   * @param rid - 可选：指定抓包记录 rid（缺省按官服 uid 自动匹配，其次取最新含户籍的记录）
   * @param officialUid - 可选：官服原 uid（迁移流程传入；缺省读存档 status.officialUid 如有）
   * @returns { imported, dexAdded, bagAdded, rid }（无可用抓包时 imported=false）
   */
  async importArkhubPets(
    uid: string,
    rid?: string,
    officialUid?: string,
  ): Promise<{ imported: boolean; dexAdded: number; bagAdded: number; rid?: string }> {
    const {
      extractArkhubDocsFromRecord,
      findCaptureDirByOfficialUid,
      applyArkhubDocs,
    } = await import("./arkhub-pets");
    let dir = "";
    if (rid) {
      dir = path.join(captureManager.recordsDir(), rid);
      if (!fs.existsSync(path.join(dir, "down.bin"))) {
        throw new Error(`抓包记录不存在或非网关记录: ${rid}`);
      }
    } else if (officialUid) {
      dir = await findCaptureDirByOfficialUid(officialUid);
    }
    if (!dir) return { imported: false, dexAdded: 0, bagAdded: 0 };
    const docs = extractArkhubDocsFromRecord(dir);
    if (!docs) return { imported: false, dexAdded: 0, bagAdded: 0 };
    const player = await accountManager.getPlayerData(uid);
    const stats = await applyArkhubDocs(player, docs);
    await accountManager.flushSave(uid);
    await this._audit(
      "arkhubImportPets",
      uid,
      `宠物还原 图鉴+${stats.dexAdded} 个体+${stats.bagAdded}（源 ${path.basename(dir)}）`,
    );
    return { imported: true, ...stats, rid: path.basename(dir) };
  }

  /**
   * 官服操作（无状态会话：登录官服 → 执行签到/邮件等 → 即弃）
   * @param phone - 官服手机号
   * @param pwd - 官服密码
   * @param action - status/signin/mails/receive/daily
   * @returns 操作结果（失败抛错由路由层返回 400）
   */
  async officialAction(
    phone: string,
    pwd: string,
    action: OfficialAction,
  ): Promise<OfficialActionResult> {
    if (!phone || !pwd) {
      throw new Error("需提供官服手机号与密码");
    }
    const result = await runOfficialAction(String(phone), String(pwd), action);
    await this._audit(
      "officialAction",
      "",
      `${phone} → ${action}（${result.ok ? "成功" : result.reason ?? "失败"}）`,
    );
    return result;
  }

  /**
   * 官服通用 API 调用（登录后调用任意官方 cgi）
   * @param phone - 官服手机号
   * @param pwd - 官服密码
   * @param cgi - 官服接口路径（如 /user/checkIn）
   * @param body - 请求体（可选）
   * @returns 官服完整响应
   */
  async officialCall(
    phone: string,
    pwd: string,
    cgi: string,
    body?: JsonValue,
  ): Promise<OfficialCallResult> {
    if (!phone || !pwd) {
      throw new Error("需提供官服手机号与密码");
    }
    const result = await runOfficialCall(String(phone), String(pwd), String(cgi), body);
    await this._audit("officialCall", "", `${phone} → ${result.cgi}`);
    return result;
  }

  /**
   * 上传像素画到官服 arkhub（24×24 RGB → savePixelArt 完整流程：网关 token → multipart 上传 → 保存确认）
   * @param phone - 官服手机号
   * @param pwd - 官服密码
   * @param pixelData - 24×24×3 RGB（数组/Buffer/对象数组，validatePixelData 归一化）
   * @returns { pixelArtId, uploadToken, httpResp }
   */
  async uploadPixelArt(
    phone: string,
    pwd: string,
    pixelData: JsonValue,
  ): Promise<{ pixelArtId: string; uploadToken: string; httpResp: OfficialCgiResponse }> {
    if (!phone || !pwd) {
      throw new Error("需提供官服手机号与密码");
    }
    const { validatePixelData } = await import("./arkhub-pixel");
    const pixels = validatePixelData(pixelData);
    const r = await uploadPixelArtToOfficial(String(phone), String(pwd), pixels);
    await this._audit("pixelUpload", "", `${phone} → pixelArtId=${r.pixelArtId}`);
    return {
      pixelArtId: r.pixelArtId.toString(),
      uploadToken: r.uploadToken,
      httpResp: r.httpResp,
    };
  }

  /**
   * 批量上传像素画到官服 arkhub（大图拆分为多张 24×24 逐张上传）
   * 速度优化：复用 official-ops 的 uploadPixelArtBatch——登录一次 + 网关连接一次循环全部块。
   *
   * @param phone - 官服手机号
   * @param pwd - 官服密码
   * @param pixelDataList - 多张 24×24×3 RGB 数据（每项经 validatePixelData 归一化）
   * @returns 逐张结果（index/ok/pixelArtId/error）
   */
  async uploadPixelArtBatch(
    phone: string,
    pwd: string,
    pixelDataList: JsonValue[],
  ): Promise<{ index: number; ok: boolean; pixelArtId?: string; error?: string }[]> {
    if (!phone || !pwd) {
      throw new Error("需提供官服手机号与密码");
    }
    const { validatePixelData } = await import("./arkhub-pixel");
    const { uploadPixelArtBatch: batchUploadToOfficial } = await import("./official-ops");
    // 逐张校验 + 归一化为 Buffer，交给批量函数（登录/网关连接各一次）
    const buffers: Buffer[] = [];
    const errors: { index: number; ok: boolean; error: string }[] = [];
    for (let i = 0; i < (pixelDataList ?? []).length; i++) {
      try {
        buffers.push(validatePixelData(pixelDataList[i]));
      } catch (e) {
        errors.push({ index: i, ok: false, error: (e as Error).message });
      }
    }
    const results = await batchUploadToOfficial(String(phone), String(pwd), buffers);
    // 合并：校验失败项（未进 buffers，结果按原索引回填）+ 批量上传结果
    const all: { index: number; ok: boolean; pixelArtId?: string; error?: string }[] = [];
    let resIdx = 0;
    for (let i = 0; i < (pixelDataList ?? []).length; i++) {
      const err = errors.find((e) => e.index === i);
      if (err) {
        all.push(err);
        continue;
      }
      const r = results[resIdx++];
      all.push(r ? { index: i, ok: r.ok, pixelArtId: r.pixelArtId?.toString(), error: r.error } : { index: i, ok: false, error: "缺少上传结果" });
    }
    await this._audit("pixelUploadBatch", "", `${phone} → ${all.length} 张（成功 ${all.filter((r) => r.ok).length}）`);
    return all;
  }

  /**
   * 从官服读取已上传像素画（getPixelArtList：HTTP 拉取列表 + OSS .dat 下载解析）
   * @param phone - 官服手机号
   * @param pwd - 官服密码
   * @param pixelArtIds - 像素画 ID 列表（缺省读全部）
   * @returns 逐张 { id, url, isBanned, pixels }
   */
  async getPixelArtList(
    phone: string,
    pwd: string,
    pixelArtIds?: (number | bigint)[],
  ): Promise<{ id: string; url: string; isBanned: boolean; pixels: number[] | null }[]> {
    if (!phone || !pwd) throw new Error("需提供官服手机号与密码");
    const { getPixelArtList: getList } = await import("./official-ops");
    const list = await getList(String(phone), String(pwd), pixelArtIds);
    await this._audit("pixelList", "", `${phone} → ${list.length} 张`);
    return list;
  }

  /**
   * 撤销（删除）已上传像素画（网关 DeletePixelArtReq）
   * @param phone - 官服手机号
   * @param pwd - 官服密码
   * @param pixelArtIds - 要删除的像素画 ID 列表
   * @returns 逐张结果
   */
  async deletePixelArt(
    phone: string,
    pwd: string,
    pixelArtIds: (number | bigint)[],
  ): Promise<{ id: string; ok: boolean; error?: string }[]> {
    if (!phone || !pwd) throw new Error("需提供官服手机号与密码");
    const { deletePixelArt: del } = await import("./official-ops");
    const results = await del(String(phone), String(pwd), pixelArtIds ?? []);
    await this._audit("pixelDelete", "", `${phone} → ${results.filter((r) => r.ok).length}/${results.length} 张`);
    return results;
  }

  /**
   * 从官服同步卡池详情到 data/gacha_detail_table.json
   * @param phone - 官服手机号
   * @param pwd - 官服密码
   * @param poolIds - 目标池列表（缺省读 data/excel/gacha_table.json 的 gachaPoolClient 全部）
   * @returns 同步统计（成功合并写回，旧文件备份 .bak；重启后服务器生效）
   */
  async syncGachaPools(
    phone: string,
    pwd: string,
    poolIds?: string[],
    opts?: { refresh?: boolean },
  ): Promise<{
    total: number;
    ok: number;
    skipped: number;
    failed: { poolId: string; error: string }[];
    updated: number;
  }> {
    if (!phone || !pwd) {
      throw new Error("需提供官服手机号与密码");
    }
    // 缺省池列表：读本地 gacha_table（不依赖 excel.init）
    let targets = poolIds?.map(String).filter(Boolean) ?? [];
    if (!targets.length) {
      const table = await readJson<LocalGachaTableFile>("./data/excel/gacha_table.json");
      targets = (table?.gachaPoolClient ?? []).map((p) => p.gachaPoolId);
    }
    if (!targets.length) {
      throw new Error("未提供 poolId 且本地 gachaPoolClient 为空");
    }
    // 补全模式（默认）：跳过本地已有的卡池，只抓缺失的新池；--refresh 全量刷新
    const current = await readJson<LocalGachaDetailFile>("./data/gacha_detail_table.json").catch(
      (): LocalGachaDetailFile => ({}),
    );
    const existingKeys = new Set(Object.keys(current.details ?? {}));
    const refresh = opts?.refresh === true;
    const toSync = refresh ? targets : targets.filter((p) => !existingKeys.has(p));
    const skipped = targets.length - toSync.length;

    const results = await runGachaSync(phone, pwd, toSync);
    const ok = results.filter((r) => r.detailInfo);
    const failed = results
      .filter((r) => r.error)
      .map((r) => ({ poolId: r.poolId, error: r.error! }));

    // 备份旧详情表 + 合并写回（保留未抓取的池）
    const target = "./data/gacha_detail_table.json";
    if (await exists(target)) {
      await copyFile(target, `${target}.${formatTs(now())}.bak`);
    }
    const details = current.details ?? {};
    for (const r of ok) {
      if (r.detailInfo !== undefined) details[r.poolId] = r.detailInfo;
    }
    await writeJson(target, { details });
    await this._audit(
      "syncGachaPools",
      "",
      `${phone} → ${ok.length}/${toSync.length} 池（跳过 ${skipped}，失败 ${failed.length}）${refresh ? "，全量刷新" : ""}`,
    );
    return {
      total: targets.length,
      ok: ok.length,
      skipped,
      failed,
      updated: ok.length,
    };
  }

  /** 统计聚合（等级分布/注册分布/资源合计） */
  async stats(): Promise<AdminStats> {
    const users = await this.listUsers();
    const levelDist: { [bucket: string]: number } = {};
    const registerDist: { [month: string]: number } = {};
    let totalChars = 0;
    let totalGold = 0;
    let totalDiamond = 0;
    let levelSum = 0;
    for (const u of users) {
      const info = await this.getUserInfo(u.uid);
      if (!info) continue;
      const bucket = `${Math.floor(info.level / 10) * 10}-${Math.floor(info.level / 10) * 10 + 9}`;
      levelDist[bucket] = (levelDist[bucket] ?? 0) + 1;
      const month = new Date(info.registerTs * 1000).toISOString().slice(0, 7);
      registerDist[month] = (registerDist[month] ?? 0) + 1;
      totalChars += info.charCnt;
      totalGold += info.gold;
      totalDiamond += info.androidDiamond;
      levelSum += info.level;
    }
    return {
      userCount: users.length,
      totalChars,
      totalGold,
      totalDiamond,
      avgLevel: users.length ? Math.round(levelSum / users.length) : 0,
      levelDist,
      registerDist,
    };
  }

  /** 审计日志（最新在前） */
  async logs(limit = 50): Promise<AuditLogEntry[]> {
    let raw = "";
    try {
      raw = await readFile(ADMIN_LOG_PATH, "utf8");
    } catch {
      return [];
    }
    const entries: AuditLogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // 跳过损坏行
      }
    }
    return entries.slice(-limit).reverse();
  }

  /** 清空审计日志（确认词保护，防误清） */
  async clearLogs(confirmWord = ""): Promise<{ cleared: number }> {
    if (confirmWord !== "CLEAR") {
      throw new Error("危险操作：需传 confirmWord=\"CLEAR\" 确认");
    }
    const before = await this.logs(100000);
    await writeFile(ADMIN_LOG_PATH, "", "utf8"); // JSONL 清空（空文件）
    await this._audit("clearLogs", "", `清空 ${before.length} 条审计日志`);
    return { cleared: before.length };
  }

  /** 常用物品别名（展示给服主参考） */
  getCommonItems(): { name: string; id: string }[] {
    return Object.entries(COMMON_ITEMS).map(([name, id]) => ({ name, id }));
  }

  /** 邮件模板列表（完整模板：供 CLI 展示与 Dashboard 填充用） */
  getMailTemplates(): { name: string; subject: string; content: string; items: { id: string; count: number }[] }[] {
    return MAIL_TEMPLATES;
  }

  /** 当前官服操作后端（自定义后端配置摘要） */
  getOfficialBackend(): {
    enabled: boolean;
    game: string;
    account: string;
    conf: string;
  } {
    return {
      enabled: config.officialBackend?.enabled === true,
      game: GAME_API,
      account: ACCOUNT_API,
      conf: CONF_API,
    };
  }

  /**
   * 地图可视化数据（dashboard「地图」tab）
   * 读取 data/mapviz/game-data.js（scripts/generate-mapviz-data.ts 的产物：window.MAPVIZ_DATA = {...}），
   * 剥掉前缀/尾分号后 JSON.parse；附加黑流树海（rogue_6）gridzone 构造数据
   * （BLACKSTREAM 构造模板/距离规则/数量规则/层类型，供 dashboard 按无相地图模板生成）。
   * 文件缺失或解析失败返回 null（router 层转 404）。
   */
  async getMapvizData(): Promise<{ themes: JsonValue; grid: MapvizGridData } | null> {
    try {
      const raw = await readFile(
        path.join(process.cwd(), "data", "mapviz", "game-data.js"),
        "utf-8",
      );
      const start = raw.indexOf("=");
      const end = raw.lastIndexOf(";");
      if (start === -1 || end === -1 || end <= start) {
        logger.warn("Mapviz", "game-data.js 格式异常（缺少 = 或 ;）");
        return null;
      }
      const themes: JsonValue = JSON.parse(raw.slice(start + 1, end));
      // rogue_6 无相地图：构造模板等由黑流树海数据模块提供（并行 GRID_ZONE 同源）
      const { BLACKSTREAM_CONSTRUCTIONS, BLACKSTREAM_DISTANCE_RULES, BLACKSTREAM_COUNT_RULES, BLACKSTREAM_LAYER_TYPES } = await import(
        "@game/modules/roguelike/data/blackstream-data"
      );
      return {
        themes,
        grid: {
          constructions: BLACKSTREAM_CONSTRUCTIONS,
          distanceRules: BLACKSTREAM_DISTANCE_RULES,
          countRules: BLACKSTREAM_COUNT_RULES,
          layerTypes: BLACKSTREAM_LAYER_TYPES,
        },
      };
    } catch (e) {
      logger.warn("Mapviz", `地图数据读取失败: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 创建新用户
   * 以 1 号用户数据库为模板复制，替换 uid/昵称/注册时间，写入文件并更新内存配置。
   * @param phone - 登录手机号
   * @param password - 登录密码
   * @returns 新用户 uid
   */
  async createUser(phone: string, password: string): Promise<string> {
    // 注册逻辑统一在 AccountManager（模板复制 + uid 递增 + 写文件 + 更新配置）
    const uid = await accountManager.registerUser(phone, password);
    await this._audit("createUser", uid, `${phone}`);
    return uid;
  }

  /**
   * 热加载用户到内存（服务器运行中创建用户后调用；CLI 场景无需）
   *
   * SQLite 感知：走 accountManager.reloadPlayer（先落盘卸载再从库重载）——
   * 原直读 JSON 文件，方案 A+C 下库内新账号无文件 → ENOENT。
   * @param uid - 用户ID
   */
  async reloadUser(uid: string): Promise<void> {
    await accountManager.reloadPlayer(uid);
  }

  /** 服务器状态 */
  async status(): Promise<ServerStatus> {
    const files = [
      "./data/config.json",
      "./data/user/users.json",
      "./data/user/mails.json",
      "./data/gacha_detail_table.json",
    ];
    const dataFiles: ServerStatus["dataFiles"] = [];
    let totalBytes = 0;
    for (const path of files) {
      const s = (await exists(path)) ? await size(path) : 0;
      totalBytes += s;
      dataFiles.push({ path, exists: s > 0, size: s });
    }
    // 用户存档目录总量
    try {
      const dbDir = "./data/user/databases";
      if (await exists(dbDir)) {
        for (const f of await readdir(dbDir)) {
          if (f.endsWith(".json")) {
            totalBytes += (await size(`${dbDir}/${f}`)).valueOf();
          }
        }
      }
    } catch {
      // 目录不存在忽略
    }
    return {
      port: config.PORT,
      offline:
        config.offline === true ||
        process.argv.includes("--offline") ||
        process.argv.includes("-o"),
      clientVersion: config.version.clientVersion,
      resVersion: config.version.resVersion,
      uptime: Math.floor(process.uptime()),
      userCount: Object.keys(accountManager.data).length,
      dataFiles,
      totalDataKB: Math.round(totalBytes / 1024),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  }
}

/** 管理服务全局实例 */
export const adminService = new AdminService();
