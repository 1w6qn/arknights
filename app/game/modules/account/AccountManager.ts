/**
 * 账户管理类
 * 
 * 负责管理所有玩家账户的配置数据、登录验证、好友系统和战斗回放等功能。
 * 作为全局单例存在，通过 accountManager 实例访问。
 */

import { PlayerDataModel } from "../../kernel/playerdata";
import type { JsonObject, JsonValue } from "@excel/json-value";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import {
  BattleInfo,
  BattleInfoStore,
  BattleRecord,
} from "../../kernel/battle-info-store";
import { unlockActivity } from "../activities/shared/unlockActivity";
import { readJson } from "@utils/file";
import { now } from "@utils/time";
import { writeFile, rename, rm } from "fs/promises";
import { createHash } from "crypto";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import Emittery from "emittery";
import { FriendRepository } from "@core/db/friend-repo";
import { openDatabase } from "@core/db/database";
import { ReplayRepository } from "@core/db/replay-repo";
import { PlayerDataRepository } from "@core/db/player-data-repo";
import * as fs from "fs";
import { BattleStore } from "../battle/BattleStore";
import { SocialService } from "../social/SocialService";
import { UserRepository, migrateUsersFromJsonFile } from "@core/db/user-repo";
import config from "@core/config/index";
import { migrateFromUserConfigs } from "@core/db/migrate";
import { acquireLock } from "@utils/mutex";
import { hashPassword, verifyPassword, isHashedPassword } from "@utils/crypt";
import { logger } from "@utils/logger";
import { checkAndRepairSave, logSaveRepair } from "../../kernel/save-health";
import { buildFreshPlayerData } from "../user/freshPlayer";
import { BadRequestError } from "../../kernel/http/errors";

/**
 * 热路径顶层键（放最前）
 *
 * 性能背景：Immer autoFreeze 被全局关闭（PlayerDataManager）后，finishDraft 的
 * finalize 会对「最后一个已修改 draft 之前」的全部顶层子树做深遍历（键序靠后 +
 * 只读访问大子树时 unfinalizedDrafts_ 永不归零 → 每次 update 全树遍历）。
 * 把高频率写路径（gacha/inventory/dexNav 等）前置后，前缀遍历极小，更新开销从
 * 每次 ~60-90ms 降到亚毫秒级。仅改变对象键序（JSON 语义不变），保存格式随之变化。
 */
const HOT_FIRST_KEYS = [
  "inventory",
  "dexNav",
  "gacha",
  "consumable",
  "status",
  "mission",
  "medal",
  "troop",
  "building",
  "rlv2",
];

/**
 * 重排存档顶层键序（热路径前置，其余保持原序）
 * @param data - 玩家数据对象
 * @returns 键序重排后的新对象（原对象不被修改）
 */
function reorderRootKeys<T>(data: T): T {
  const src = data as Record<string, unknown>;
  if (!src || typeof src !== "object" || Array.isArray(src)) return data;
  const ordered: Record<string, unknown> = {};
  for (const k of HOT_FIRST_KEYS) {
    if (k in src) ordered[k] = src[k];
  }
  for (const k of Object.keys(src)) {
    if (!(k in ordered)) ordered[k] = src[k];
  }
  return ordered as T;
}

/**
 * 递归冻结对象（跳过已冻结节点，幂等）
 *
 * 入参取「非空值」形态（JSON 值域）：非对象/原语直接返回，与历史实现一致。
 * @param obj - 待冻结的存档子树
 */
function deepFreeze(obj: {} | null | undefined): void {
  if (!obj || typeof obj !== "object" || Object.isFrozen(obj)) return;
  Object.freeze(obj);
  const children = obj as Record<string, {} | null | undefined>;
  for (const key of Object.keys(children)) {
    deepFreeze(children[key]);
  }
}

/**
 * 深冻结存档顶层子树（排除指定键——直接改 _playerdata 的子树必须保持可变）
 * @param data - 玩家数据对象（原地冻结其顶层子树）
 * @param except - 不冻结的顶层键（rlv2/medal/dungeon/status）
 */
function deepFreezeExcept(data: {} | null | undefined, except: string[]): void {
  if (!data || typeof data !== "object") return;
  const children = data as Record<string, {} | null | undefined>;
  for (const key of Object.keys(children)) {
    if (except.includes(key)) continue;
    deepFreeze(children[key]);
  }
}

export class AccountManager implements BattleInfoStore {
  /** 玩家数据管理器映射，key为uid */
  data: { [key: string]: PlayerDataManager };
  /** 用户配置数据映射，key为uid */
  configs: { [key: string]: UserConfig };
  /** 事件触发器 */
  _trigger: TypedEventEmitter;
  /** 好友关系仓储（SQLite，init() 中初始化，避免模块加载时创建数据库文件） */
  _friendRepo!: FriendRepository;
  /** 用户配置仓储（SQLite，init() 中初始化——users.json 仅首次迁移种子） */
  _userRepo!: UserRepository;
  /** 战斗回放仓储（SQLite replays 表——回放独立于用户配置存储） */
  _replayRepo!: ReplayRepository;
  /** 玩家存档仓储（方案 A+C：SQLite gzip BLOB） */
  _playerDataRepo?: PlayerDataRepository;
  /** 战斗数据存储（B-1：回放/结算——BattleStore 委托） */
  _battleStore!: BattleStore;
  /** 社交服务（B-1：好友/申请/访问——SocialService 委托） */
  _socialService!: SocialService;

  constructor() {
    this.configs = {};
    this.data = {};
    this._trigger = new Emittery();
    this._socialService = new SocialService(this);
  }

  /** secret→uid 索引（真实模式 getUidByToken 懒构建，避免每次请求线性扫描 configs） */
  private _secretIndex: Map<string, string> | null = null;
  /** 构建 _secretIndex 时的 configs 引用（检测 configs 被整体替换——init 重新加载/测试直接赋值时失效重建） */
  private _secretIndexConfigs: { [key: string]: UserConfig } | null = null;

  /**
   * 初始化账户管理器
   * 
   * 从 SQLite（users 表）加载用户配置（首次表空时从 users.json 种子迁移），
   * 玩家存档以 SQLite player_data 表为唯一数据源（gzip BLOB，懒加载）。设置保存事件监听器。
   */
  async init() {
    logger.info("AccountManager", "loading users...");
    // 打开主数据库（默认 SQLite 文件；可配置为 MySQL / PostgreSQL——见 config.database）
    // 建连是异步的（网络型后端），首次运行自动建库表
    const db = await openDatabase();
    this._friendRepo = new FriendRepository(db);
    this._userRepo = new UserRepository(db);
    this._replayRepo = new ReplayRepository(db);
    this._battleStore = new BattleStore(this._replayRepo);
    this._playerDataRepo = new PlayerDataRepository(db);
    // 用户配置：数据库唯一事实源；首次（表空）从 users.json 种子迁移
    this.configs = await this._userRepo.getAll();
    if (Object.keys(this.configs).length === 0) {
      await migrateUsersFromJsonFile(this._userRepo);
      this.configs = await this._userRepo.getAll();
    }
    this._trigger.on("save", async () => {
      await this.saveUserConfig();
    });
    // 社交数据迁移：social.db 首次创建时从 users.json 导入，之后 SQLite 为唯一事实源
    await migrateFromUserConfigs(db, this.configs);
    // 回放迁移：旧 configs 内嵌回放 → replays 表（一次性；此后 users 表/内存均不再保留回放）
    for (const [uid, conf] of Object.entries(this.configs)) {
      // 历史 UserConfig 曾内嵌 battle.replays / battle.infos（已迁至 replays/battle_infos 表）——
      // 现类型不再声明，迁移读取时按遗留视图收窄
      const legacyBattle = (
        conf as { battle?: UserConfig["battle"] & LegacyUserConfigBattle }
      ).battle;
      const replays = legacyBattle?.replays;
      if (legacyBattle && replays && Object.keys(replays).length > 0) {
        for (const [stageId, replay] of Object.entries<string>(replays)) {
          await this._replayRepo.upsert(uid, stageId, replay);
        }
        delete legacyBattle.replays;
      }
      // 结算信息迁移：旧 configs 内嵌 infos → battle_infos 表（一次性）
      const infos = legacyBattle?.infos;
      if (legacyBattle && infos && Object.keys(infos).length > 0) {
        for (const [battleId, info] of Object.entries<BattleInfo>(infos)) {
          await this._replayRepo.upsertInfo(uid, battleId, info);
        }
        delete legacyBattle.infos;
      }
    }
    await this.saveUserConfig();
    // 存档懒加载（启动提速）：不再启动全量加载玩家数据——首个请求/登录时按需 _loadPlayer。
    // 存档 → SQLite player_data 表（方案 A+C：gzip BLOB）迁移在首次 _doLoadPlayer 时惰性执行。
    logger.info(
      "AccountManager",
      `${Object.keys(this.configs).length} users ready（存档懒加载）`,
    );
    // D-1：real 模式启动空闲账号清扫（单例模式不启用）
    this.startIdleSweep();
  }

  /**
   * 获取战斗回放数据（BattleStore 委托——replays 表独立存储）
   * @param uid - 用户ID
   * @param stageId - 关卡ID
   * @returns 战斗回放数据字符串
   */
  async getBattleReplay(uid: string, stageId: string): Promise<string> {
    return (await this._battleStore?.getReplay(uid, stageId)) ?? "";
  }

  /**
   * 保存战斗回放数据（BattleStore 委托——不再改写 users 表，避免大字符串全量重写配置）
   * @param uid - 用户ID
   * @param stageId - 关卡ID
   * @param replay - 战斗回放数据字符串
   */
  async saveBattleReplay(
    uid: string,
    stageId: string,
    replay: string,
  ): Promise<void> {
    await this._battleStore?.saveReplay(uid, stageId, replay);
  }

  /**
   * 获取用户配置
   * @param uid - 用户ID
   * @returns 用户配置对象
   */
  async getUserConfig(uid: string): Promise<UserConfig> {
    return this.configs[uid]!;
  }

  /**
   * 判断账号是否被禁用（Dashboard 禁用用户后，登录/鉴权均拒绝）
   * @param uid - 用户ID（可为空，空视为未禁用）
   * @returns 是否禁用
   */
  isAccountDisabled(uid: string | undefined): boolean {
    return !!uid && !!this.configs[uid]?.disabled;
  }

  /**
   * 保存用户配置到 SQLite（全量同步 upsert）
   * 未 init（_userRepo 未初始化，如单测直接操作 configs）时 no-op——不污染真实库
   */
  async saveUserConfig(): Promise<void> {
    if (this._userRepo) {
      await this._userRepo.upsertAll(this.configs);
    }
  }

  /**
   * 获取战斗信息
   * @param uid - 用户ID
   * @param battleId - 战斗ID
   * @returns 战斗信息对象
   */
  /**
   * 获取战斗结算信息（battle_infos 表独立存储——A3）
   * @param uid - 用户ID
   * @param battleId - 战斗ID
   * @returns 战斗信息（不存在返回 undefined，调用方须显式处理）
   */
  async getBattleInfo(uid: string, battleId: string): Promise<BattleInfo | undefined> {
    return await this._battleStore?.getInfo(uid, battleId);
  }

  /**
   * 留存战斗结束记录（BattleStore 委托——battle_records 表，供未来分析）
   * @param record - 战斗结束记录（含 battleId/uid）
   */
  async saveBattleRecord(record: BattleRecord): Promise<void> {
    await this._battleStore?.saveRecord(record);
  }

  /** 读取战斗结束记录（无则 undefined） */
  async getBattleRecord(uid: string, battleId: string): Promise<BattleRecord | undefined> {
    return await this._battleStore?.getRecord(uid, battleId);
  }

  /** 读取最近 N 条战斗结束记录（按创建时间倒序） */
  async listBattleRecords(uid: string, limit = 50): Promise<BattleRecord[]> {
    return (await this._battleStore?.listRecords(uid, limit)) ?? [];
  }

  /**
   * 保存战斗结算信息（BattleStore 委托——不再改写 users 表，避免每次结算全量重写配置）
   * @param uid - 用户ID
   * @param battleId - 战斗ID
   * @param info - 战斗信息对象
   */
  async saveBattleInfo(
    uid: string,
    battleId: string,
    info: BattleInfo,
  ): Promise<void> {
    await this._battleStore?.saveInfo(uid, battleId, info);
  }

  /**
   * 获取玩家数据管理器（懒加载：data 未加载时从存档文件读取——real 模式注册新账号后免重启）
   * @param uid - 用户ID
   * @returns 玩家数据管理器实例
   */
  async getPlayerData(uid: string): Promise<PlayerDataManager> {
    if (!this.data[uid]) {
      await this._loadPlayer(uid);
    }
    this._lastAccess[uid] = Date.now(); // D-1 空闲卸载：请求访问即刷新
    return this.data[uid];
  }

  /**
   * 读取玩家存档对象（SQLite 感知；内存已加载优先，否则从库/文件读取）
   *
   * admin 备份/导出/重载使用——方案 A+C 下存档主体在 SQLite player_data 表
   * （gzip BLOB），直读 data/user/databases/{uid}.json 对库内账号必 ENOENT。
   * @param uid - 用户ID
   * @returns 存档 JSON 对象（不存在返回 null）
   */
  async readPlayerData(uid: string): Promise<PlayerDataModel | null> {
    if (this.data[uid]) return this.data[uid]._playerdata;
    if (this._playerDataRepo) {
      const raw = await this._playerDataRepo.get(uid);
      if (raw !== null) return reorderRootKeys(JSON.parse(raw));
    }
    const filePath = `./data/user/databases/${uid}.json`;
    if (fs.existsSync(filePath)) {
      return reorderRootKeys(
        JSON.parse(fs.readFileSync(filePath, "utf-8")),
      );
    }
    return null;
  }

  /**
   * 热重载玩家数据（admin 创建/修改账号后调用；SQLite 时代存档在库不在文件）
   *
   * 先落盘并卸载内存实例，再走 _loadPlayer 从 SQLite（方案 A+C）重新加载——
   * 原 reloadUser 直读 JSON 文件，库内新账号无文件 → ENOENT。
   * @param uid - 用户ID
   */
  async reloadPlayer(uid: string): Promise<void> {
    if (this.data[uid]) {
      await this.flushSave(uid);
      delete this.data[uid];
      delete this._lastAccess[uid];
    }
    await this._loadPlayer(uid);
  }

  /** 最近访问时间戳（D-1 空闲卸载用） */
  private _lastAccess: { [uid: string]: number } = {};
  /** 空闲卸载清扫定时器 */
  private _idleSweepTimer: NodeJS.Timeout | null = null;
  /** 空闲卸载阈值（30 分钟无请求） */
  private _idleUnloadMs = 30 * 60 * 1000;
  /** 清扫间隔（1 分钟） */
  private _idleSweepIntervalMs = 60 * 1000;

  /**
   * 启动空闲账号清扫（D-1：real 模式多账号内存优化）
   * 仅 real 模式启动；单例模式单账号卸载会抖动，不启用。
   */
  private startIdleSweep(): void {
    if (this._idleSweepTimer || config.authMode !== "real") return;
    this._idleSweepTimer = setInterval(() => {
      void this.sweepIdleAccounts();
    }, this._idleSweepIntervalMs);
  }

  /**
   * 卸载超时未访问的账号（先落盘再卸载——防抖窗口内变更不丢）
   * 守卫：singleUid 不卸载；有进行中请求的账号不卸载（_lastAccess 在 getPlayerData 已刷新）
   */
  async sweepIdleAccounts(): Promise<void> {
    const now = Date.now();
    const singleUid = config.singleUid || "1";
    for (const [uid, last] of Object.entries(this._lastAccess)) {
      if (uid === singleUid) continue;
      if (now - last < this._idleUnloadMs) continue;
      if (!this.data[uid]) {
        delete this._lastAccess[uid];
        continue;
      }
      await this.flushSave(uid);
      delete this.data[uid];
      delete this._lastAccess[uid];
      logger.info("AccountManager", `空闲账号卸载 ${uid}（下次请求自动重载）`);
    }
  }

  /**
   * 加载玩家数据到内存（文件读取 + 事件接线；init/ensureSingleUser/懒加载共用）
   *
   * 并发安全：进行中的加载以 promise 缓存（_loadingPlayers），并发请求共享同一次加载，
   * 避免同一 uid 两个请求都过了 data[uid] 守卫、各建一个 PlayerDataManager 实例互踩。
   * @param uid - 用户ID
   * @param playerData - 可选：已有数据对象则跳过文件读取（ensureSingleUser 用）
   */
  private _loadingPlayers: { [uid: string]: Promise<void> } = {};

  private async _loadPlayer(uid: string, playerData?: PlayerDataModel): Promise<void> {
    if (this.data[uid]) return;
    if (!this._loadingPlayers[uid]) {
      this._loadingPlayers[uid] = this._doLoadPlayer(uid, playerData).finally(() => {
        delete this._loadingPlayers[uid];
      });
    }
    await this._loadingPlayers[uid];
  }

  private async _doLoadPlayer(uid: string, playerData?: PlayerDataModel): Promise<void> {
    let data: PlayerDataModel;
    if (playerData) {
      data = playerData;
    } else if (this._playerDataRepo) {
      // 方案 A+C：优先存档表（gzip 二进制文档）
      const raw = await this._playerDataRepo.get(uid);
      if (raw !== null) {
        data = reorderRootKeys(JSON.parse(raw));
      } else {
        // 惰性迁移：文件存档 → SQLite（导入后删除文件）
        const filePath = `./data/user/databases/${uid}.json`;
        if (fs.existsSync(filePath)) {
          data = reorderRootKeys(
            JSON.parse(fs.readFileSync(filePath, "utf-8")),
          );
          await this._playerDataRepo.upsert(uid, JSON.stringify(data));
          // 迁移完成删除旧文件（1.json 保留——新用户模板；后续 registerUser 也走 SQLite 优先）
          if (uid !== "1") {
            fs.rmSync(filePath, { force: true });
          }
        } else {
          data = reorderRootKeys(
            await readJson<PlayerDataModel>(filePath),
          );
        }
      }
    } else {
      data = reorderRootKeys(
        await readJson<PlayerDataModel>(`./data/user/databases/${uid}.json`),
      );
    }
    // 存档健康检查与自动修复（结构性损坏——如 PRIVATE.owners 含 null——幂等修复）
    const loadIssues = checkAndRepairSave(data);
    const fixed = loadIssues.filter((i) => i.fixed);
    // 修复后标记脏，使首个请求落盘时写回修复结果（临时标记，构造管理器后立即删除）
    const marked = data as PlayerDataModel & { _repairMarked?: boolean };
    if (fixed.length > 0) {
      logSaveRepair(uid, loadIssues);
      marked._repairMarked = true;
    }
    this.data[uid] = new PlayerDataManager(data, this);
    if (marked._repairMarked) {
      this.data[uid].markDirty();
      delete marked._repairMarked;
    }
    // 构造期子管理器可能原地初始化数据（如 rlv2 current 结构），标记脏使首个请求落盘一次
    // （与条件落盘前"每次请求都落盘"的首请求行为保持一致）
    this.data[uid].markDirty();
    // activity 切换（冻结模式）：等 mission.init 完成后播种活动状态/任务/关卡——
    // 必须在其后执行，避免 MissionManager.init 的 missions["ACTIVITY"] = {} 清掉播种任务
    try {
      if (this.data[uid].mission.initPromise) {
        await this.data[uid].mission.initPromise;
      }
      await unlockActivity(this.data[uid]);
    } catch (error) {
      logger.error(
        "AccountManager",
        `活动播种失败 ${uid}: ${(error as Error).message}`,
      );
    }
    // 仅当文件里的 uid 与目录键不一致时才自愈写回（文件 uid 写错）；否则纯 no-op 不落盘
    if (data.status.uid !== uid) {
      this.data[uid]._playerdata.status.uid = uid;
      void this.flushSave(uid);
    }
    // 性能：深冻结大子树（排除直接改 _playerdata 的 rlv2/medal/dungeon/status，以及
    // 构造后异步 init 原地补结构的 mission）。Immer autoFreeze 关闭时 finalize 会遍历
    // 变更路径前的全部顶层子树；冻结后 finalize 对冻结子树 O(1) 跳过（isFrozen 短路），
    // 只有实际修改的路径被遍历。冻结子树在会话内不可变 → 不会产生新损坏。
    deepFreezeExcept(data, ["rlv2", "medal", "dungeon", "status", "mission"]);
    this.data[uid]._trigger.on("save", () => {
      // 防抖合并：500ms 内的多次变更只落盘一次
      this.scheduleSave(uid);
    });
  }

  /**
   * 加载新账号模板存档（方案 A+C：SQLite 单一数据源）
   *
   * 优先从 SQLite player_data 表的 uid=1 模板行读取（1.json 已迁移入表）；
   * 模板行尚不存在（首次运行/测试未 init 等无 repo 场景）时回退 JSON 文件：
   * 1.json（历史模板）→ player_data.json（官服满配基底）。
   * @returns 模板存档对象（深拷贝由调用方负责）
   * @throws 模板均不可用时抛错
   */
  private async _loadTemplate(): Promise<JsonObject> {
    // 方案 A+C：优先 SQLite player_data 表 uid=1 模板行
    if (this._playerDataRepo) {
      const raw = await this._playerDataRepo.get("1");
      if (raw !== null) return JSON.parse(raw) as JsonObject;
    }
    // 回退 JSON 文件模板（迁移过渡/无 repo 防御路径）
    const templatePath = `./data/user/databases/1.json`;
    try {
      return await readJson<JsonObject>(templatePath);
    } catch {
      const official = await readJson<JsonObject>("./player_data.json").catch(() => null);
      if (!official) {
        throw new BadRequestError(
          `找不到模板存档 ${templatePath}（player_data.json 亦缺失），无法创建账号`,
        );
      }
      return official;
    }
  }

  /**
   * 持久化玩家存档（方案 A+C：SQLite 单一数据源）
   *
   * 有 SQLite 仓储（生产/init 后）时仅写入 player_data 表（事务原子）；
   * 无仓储（测试/未 init 的防御路径）回退原子文件写（.tmp + rename）。
   * @param uid - 用户ID
   * @param data - 可序列化存档载荷（原始 JSON 对象 / 生成模型 / 管理器实例——其 toJSON() 落到存档）
   */
  private async _writePlayerData<T>(uid: string, data: T): Promise<void> {
    if (this._playerDataRepo) {
      await this._playerDataRepo.upsert(uid, JSON.stringify(data));
    } else {
      const finalPath = `./data/user/databases/${uid}.json`;
      const tmpPath = `${finalPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(data));
      await rename(tmpPath, finalPath);
    }
  }

  /**
   * 获取全部已加载账号 uid 列表
   */
  getPlayerUidList(): string[] {
    return Object.keys(this.data);
  }

  /**
   * 获取玩家社交信息（好友相关）
   * @param uid - 用户ID
   * @returns 玩家社交信息
   */
  async getPlayerFriendInfo(uid: string) {
    return (await this.getPlayerData(uid)).socialInfo;
  }

  /** 保存防抖定时器（key 为 uid） */
  private _saveTimers: { [uid: string]: NodeJS.Timeout } = {};

  /** 保存防抖窗口（毫秒） */
  private _saveDebounceMs = 500;

  /**
   * 防抖调度保存：窗口内的多次变更合并为一次落盘（原子写 + 配置保存）
   * @param uid - 用户ID
   */
  private scheduleSave(uid: string): void {
    if (this._saveTimers[uid]) return;
    this._saveTimers[uid] = setTimeout(() => {
      delete this._saveTimers[uid];
      void this.flushSave(uid);
    }, this._saveDebounceMs);
  }

  /**
   * 立即保存玩家数据（原子写 + 用户配置）
   * 服务器关闭/测试可显式调用；防抖到期也会调用
   * @param uid - 用户ID
   */
  async flushSave(uid: string): Promise<void> {
    if (this._saveTimers[uid]) {
      clearTimeout(this._saveTimers[uid]);
      delete this._saveTimers[uid];
    }
    try {
      await this.savePlayerData(uid);
      await this.saveUserConfig();
    } catch (e) {
      logger.error("AccountManager", `save ${uid} failed: ${(e as Error).message}`);
    }
  }

  /**
   * 保存玩家数据（方案 A+C：存档仅写入 SQLite player_data 表，事务原子）
   * @param uid - 用户ID
   */
  async savePlayerData(uid: string): Promise<void> {
    const finalPath = `./data/user/databases/${uid}.json`;
    // 写盘前健康校验：发现可修复损坏时修复（避免把坏数据落盘）。
    // 修复：原对 PlayerDataManager 实例做校验（无 activity 等字段 → 误报
    // "activity 缺失" 并往管理器上塞垃圾字段）；改为校验真实存档 _playerdata。
    // 冻结子树（troop 等）在加载时已修复且会话内不可变，此处修复为 no-op 安全。
    const saveIssues = checkAndRepairSave(this.data[uid]._playerdata);
    const saveFixed = saveIssues.filter((i) => i.fixed);
    if (saveFixed.length > 0) {
      logSaveRepair(uid, saveIssues);
    }
    const t0 = Date.now();
    // 方案 A+C：存档仅写入 SQLite player_data 表（gzip BLOB，事务原子）——替代文件 tmp+rename
    await this._writePlayerData(uid, this.data[uid]);
    // 迁移收尾：SQLite 落盘后清理遗留 JSON 文件（1.json 模板保留）
    if (this._playerDataRepo && fs.existsSync(finalPath) && uid !== "1") {
      fs.rmSync(finalPath, { force: true });
    }
    // 耗时可观测（A-2）：序列化大存档约 9ms/5.4MB 对象——防抖后离请求路径
    logger.debug("AccountManager", `savePlayerData ${uid}`, `${Date.now() - t0}ms`);
  }

  /**
   * 获取抽卡保底计数
   * @param uid - 用户ID
   * @param gachaType - 抽卡类型
   * @returns 保底计数（未初始化时 0）
   */
  async getBeforeNonHitCnt(uid: string, gachaType: string): Promise<number> {
    const config = this.configs[uid];
    if (!config || !config.gacha[gachaType]) {
      return 0;
    }
    return config.gacha[gachaType].beforeNonHitCnt;
  }

  /**
   * 保存抽卡保底计数
   * @param uid - 用户ID
   * @param gachaType - 抽卡类型
   * @param cnt - 保底计数
   */
  async saveBeforeNonHitCnt(
    uid: string,
    gachaType: string,
    cnt: number,
  ): Promise<void> {
    const config = this.configs[uid]!;
    if (!config.gacha[gachaType]) {
      config.gacha[gachaType] = { beforeNonHitCnt: 0 };
    }
    config.gacha[gachaType].beforeNonHitCnt = cnt;
    await this._trigger.emit("save", []);
  }

  /**
   * 获取社交信息（好友列表、好友请求、访问记录）
   * @param uid - 用户ID
   * @returns 社交信息对象
   */
  async getSocial(uid: string): Promise<{
    friends: { uid: string; alias: string }[];
    friendRequests: string[];
    visited: string[];
  }> {
    return this._socialService.getSocial(uid);
  }

  /**
   * 删除好友（双向删除：双方好友列表都移除对方）
   * @param uid - 用户ID
   * @param friendUid - 好友用户ID
   */
  async deleteFriend(uid: string, friendUid: string): Promise<void> {
    await this._socialService.deleteFriend(uid, friendUid);
  }

  /**
   * 添加好友（单向；双向关系由调用方决定，如 processFriendRequest）
   * @param uid - 用户ID
   * @param friendUid - 好友用户ID
   */
  async addFriend(uid: string, friendUid: string): Promise<void> {
    await this._socialService.addFriend(uid, friendUid);
  }

  /**
   * 发送好友请求（带校验：不能给自己发、已是好友拒绝、重复申请拒绝、冷却期拒绝）
   * @param from - 发送请求的用户ID
   * @param to - 接收请求的用户ID
   */
  async sendFriendRequest(from: string, to: string): Promise<void> {
    await this._socialService.sendFriendRequest(from, to);
  }

  /**
   * 设置星标好友列表（覆盖式；仅好友 + 上限 maxStarFriendNum 截断）
   * @param uid - 用户ID
   * @param idList - 星标好友 id 列表
   * @returns 实际生效的星标好友列表
   */
  async setStarFriendList(uid: string, idList: string[]): Promise<string[]> {
    return await this._socialService.setStarFriendList(uid, idList);
  }

  /**
   * 获取星标好友列表
   * @param uid - 用户ID
   */
  async getStarFriendList(uid: string): Promise<string[]> {
    return await this._socialService.getStarFriendList(uid);
  }

  /**
   * 删除好友请求
   * @param uid - 用户ID
   * @param friendId - 发起请求的用户ID
   */
  async deleteFriendRequest(uid: string, friendId: string): Promise<void> {
    await this._socialService.deleteFriendRequest(uid, friendId);
  }

  /**
   * 设置好友别名
   * @param uid - 用户ID
   * @param friendId - 好友用户ID
   * @param alias - 别名
   */
  async setFriendAlias(
    uid: string,
    friendId: string,
    alias: string,
  ): Promise<void> {
    await this._socialService.setFriendAlias(uid, friendId, alias);
  }

  /**
   * 获取好友请求列表
   * @param uid - 用户ID
   * @returns 好友请求用户ID列表
   */
  async getFriendRequests(uid: string): Promise<string[]> {
    return this._socialService.getFriendRequests(uid);
  }

  /**
   * 搜索玩家
   * @param keyword - 搜索关键词（支持uid、昵称、昵称#数字）
   * @returns 匹配的用户ID列表
   */
  async searchPlayer(keyword: string): Promise<string[]> {
    return this._socialService.searchPlayer(keyword);
  }

  /**
   * 通过手机号和密码获取Token
   * @param phone - 用户手机号
   * @param password - 用户密码
   * @returns 用户Token（即uid）
   */
  async tokenByPhonePassword(phone: string, password: string): Promise<string> {
    if (config.authMode !== "real") {
      // 单例模式：任意登录返回固定账号（不查询/不注册——单账号私服）
      return config.singleUid || "1";
    }
    const found = Object.entries(this.configs).find(([, conf]) => {
      return conf.auth.phone == phone && verifyPassword(conf.password, password);
    });
    if (found) {
      // 真实模式：返回账号 secret（参考 DoctoratePy——token=secret）
      const [uid, conf] = found;
      // 禁用账号拦截：已禁用（Dashboard 操作）则拒绝登录
      if (conf.disabled) {
        throw new BadRequestError("该账号已被禁用，请联系管理员");
      }
      // 旧明文账号登录成功后惰性升级为哈希（之后不再明文存储）
      if (!isHashedPassword(conf.password)) {
        conf.password = hashPassword(password);
      }
      return conf.secret || this.getTokenByUid(uid);
    }
    // 账号不存在：自动注册（私服创建新用户），返回新 uid 作为 token
    const uid = await this.registerUser(phone, password);
    return this.getTokenByUid(uid);
  }

  /**
   * 创建新用户
   * 以 1 号用户数据库为模板复制，替换 uid/昵称/注册时间，写入文件并更新内存配置。
   *
   * - single 模式：不建号（注册收敛到固定账号——避免生成永远无法登录的垃圾账号污染 configs/users 表）
   * - real 模式：并发注册以互斥锁串行化（newUid = max+1 分配，并发下会拿到相同 uid 互相覆盖）
   * @param phone - 登录手机号
   * @param password - 登录密码
   * @returns 新用户 uid
   */
  async registerUser(phone: string, password: string): Promise<string> {
    if (config.authMode === "single") {
      return config.singleUid || "1";
    }
    const release = await acquireLock("account:register");
    try {
      const phoneStr = String(phone ?? "").trim();
      if (!phoneStr) {
        throw new BadRequestError(`手机号不能为空`);
      }
      if (Object.values(this.configs).some((c) => c.auth.phone === phoneStr)) {
        throw new BadRequestError(`手机号已存在: ${phoneStr}`);
      }
      const uids = Object.keys(this.configs).map(Number);
      const newUid = String((uids.length ? Math.max(...uids) : 0) + 1);

      // 方案 A+C：新账号模板从 SQLite player_data 表 uid=1 模板行读取（无 repo 回退 JSON 文件）
      // 参考 LocalArknight 新玩家语义：以模板为结构脚手架构造「从零开始的崭新新号」，
      // 而非直接复制满配模板（避免新号继承 1 号满配的财富/干员/进度）。
      const templateData = await this._loadTemplate();
      const registerTs = now();
      const playerData = buildFreshPlayerData(templateData, {
        uid: newUid,
        nickName: `博士${newUid}`,
        nickNumber: "1",
        registerTs,
      });

      const userConfig: UserConfig = {
        uid: newUid,
        password: hashPassword(password), // 哈希存储（不落明文）
        secret: generateSecret(phoneStr),
        auth: {
          hgId: newUid,
          phone: phoneStr,
          email: "",
          identityNum: "doctorate",
          identityName: "doctorate",
          isMinor: false,
          isLatestUserAgreement: true,
        },
        battle: { stageId: "" },
        gacha: {},
        rlv2: {},
      };

      // 方案 A+C：新账号存档写入 SQLite player_data 表（事务原子；无 repo 回退文件写）
      await this._writePlayerData(newUid, playerData);
      this.configs[newUid] = userConfig;
      this._secretIndex = null; // 新增账号：secret 索引失效，下次查询重建
      await this.saveUserConfig();
      // 注册后加载玩家数据（与 ensureSingleUser 一致——searchPlayer/getPlayerData 立即可用，免重启）
      await this._loadPlayer(newUid, playerData as unknown as PlayerDataModel);
      return newUid;
    } finally {
      release();
    }
  }

  /**
   * 修改账号密码（real 模式用户管理闭环）
   * @param uid - 用户 uid
   * @param newPassword - 新密码（明文，内部哈希存储）
   * @returns 是否成功（账号不存在返回 false）
   */
  async updatePassword(uid: string, newPassword: string): Promise<boolean> {
    const conf = this.configs[uid];
    if (!conf) return false;
    conf.password = hashPassword(newPassword);
    await this.saveUserConfig();
    return true;
  }

  /**
   * 换绑手机号（real 模式用户管理闭环——同步刷新 secret，旧 token 失效需重新登录）
   * @param uid - 用户 uid
   * @param newPhone - 新手机号
   * @returns 是否成功（账号不存在返回 false）
   */
  async updatePhone(uid: string, newPhone: string): Promise<boolean> {
    const conf = this.configs[uid];
    if (!conf) return false;
    conf.auth.phone = newPhone;
    conf.secret = generateSecret(newPhone);
    this._secretIndex = null; // secret 变化：索引失效，下次查询重建
    await this.saveUserConfig();
    return true;
  }

  /**
   * 确保单例账号存在（不存在时以模板创建——干净账号）
   * 单例模式固定账号（config.singleUid）可能不存在（如切到 2222 过渡）
   *
   * 模板来源（方案 A+C）：优先 SQLite player_data 表 uid=1 模板行；无 repo/模板行缺失时
   * 回退 1.json → player_data.json（官服满配基底）。随后 index.ts 的 generateMaxedAccount
   * 会按版本刷新内容字段（S1 合并式刷新），故模板结构差异会被自动纠正。
   * @param uid - 单例账号 uid
   */
  async ensureSingleUser(uid: string): Promise<void> {
    if (this.configs[uid]) return;
    // 方案 A+C：模板优先从 SQLite player_data 表 uid=1 模板行读取（无 repo 回退 1.json/player_data.json）
    const templateData = await this._loadTemplate();
    const playerData = JSON.parse(JSON.stringify(templateData));
    playerData.status.uid = uid;
    playerData.status.nickName = `博士${uid}`;
    playerData.status.nickNumber = "1";
    playerData.status.registerTs = now();
    playerData.status.lastOnlineTs = 0;

    const userConfig: UserConfig = {
      uid,
      password: hashPassword("single"),
      secret: generateSecret(`single_${uid}`),
      auth: {
        hgId: uid,
        phone: uid,
        email: "",
        identityNum: "doctorate",
        identityName: "doctorate",
        isMinor: false,
        isLatestUserAgreement: true,
      },
      battle: { stageId: "" },
      gacha: {},
      rlv2: {},
    };

    // 方案 A+C：新账号存档写入 SQLite player_data 表（事务原子；无 repo 回退文件写）
    await this._writePlayerData(uid, playerData);
    this.configs[uid] = userConfig;
    this._secretIndex = null; // 新增账号：secret 索引失效，下次查询重建
    await this.saveUserConfig();

    // 加载玩家数据（与 init 一致——getPlayerData 可用；直接使用内存 playerData，避免重读文件）
    await this._loadPlayer(uid, playerData as PlayerDataModel);
  }

  /**
   * 删除账号（B-2 统一清理入口）
   *
   * 清理范围：内存 configs/data + SQLite（users 行 + 社交 + 回放/结算）+ 存档文件。
   * 调用方需确认——不可恢复（备份可用 admin users backup）。
   * @param uid - 用户ID
   */
  async deleteAccount(uid: string): Promise<void> {
    delete this.configs[uid];
    delete this.data[uid];
    this._secretIndex = null;
    await this._friendRepo?.deleteUser(uid);
    await this._replayRepo?.deleteUser(uid);
    await this._playerDataRepo?.delete(uid); // 方案 A+C：存档表行
    await rm(`./data/user/databases/${uid}.json`, { force: true });
    await this.saveUserConfig();
  }

  /**
   * 通过uid获取Token（真实模式：账号 secret；旧账号无 secret 回退 uid）
   * @param uid - 用户ID
   * @returns 用户Token（secret 或 uid）
   */
  async getTokenByUid(uid: string): Promise<string> {
    return this.configs[uid]?.secret || uid;
  }

  /**
   * 通过Token获取uid
   * @param token - 用户Token（uid 或账号 secret）
   * @returns 用户ID（匹配 uid 或 secret；无效返回空串）
   */
  async getUidByToken(token: string): Promise<string> {
    if (config.authMode === "real") {
      // 真实模式：token 匹配账号 secret（参考 DoctoratePy query_account_by_secret）
      // 收紧：有 secret 的账号必须以 secret 登录（防止 uid 数字直通枚举冒用）；
      // 仅无 secret 的旧账号保留 uid 直通（兼容迁移前账号）
      if (this.configs[token] && !this.configs[token].secret) {
        return this.isAccountDisabled(token) ? "" : token;
      }
      // 懒构建 secret→uid 索引；configs 被整体替换（init/直接赋值）或新增账号（register/ensure）后失效重建
      if (!this._secretIndex || this._secretIndexConfigs !== this.configs) {
        this._secretIndexConfigs = this.configs;
        this._secretIndex = new Map<string, string>();
        for (const uid of Object.keys(this.configs)) {
          const secret = this.configs[uid]?.secret;
          if (secret && !this._secretIndex.has(secret)) {
            this._secretIndex.set(secret, uid);
          }
        }
      }
      const hit = this._secretIndex.get(token);
      if (hit) return this.isAccountDisabled(hit) ? "" : hit;
      // 宽松兜底（对齐 ODPY——私服单机不卡客户端流程）：未知 token（非配置账号 key，
      // 即客户端 SDK 会话 token）回退默认账号（singleUid 优先，其次第一个配置账号）。
      // 配置账号 key 本身（uid 数字直通）仍拒绝——有 secret 的账号必须用 secret 登录。
      if (token && !this.configs[token]) {
        const fallback = config.singleUid || Object.keys(this.configs)[0];
        if (fallback && this.configs[fallback]) {
          return this.isAccountDisabled(fallback) ? "" : fallback;
        }
      }
      return "";
    }
    // 单例模式：任意 token 收敛到固定账号（oauth2/basic/u8 全流程返回单例 uid）。
    // 语义契约：single 下 token=secret=uid 三者语义统一（middleware 会强制覆盖 secret header），
    // real 下 token 为账号 secret（旧账号无 secret 回退 uid）。
    const singleUid = config.singleUid || "1";
    return this.isAccountDisabled(singleUid) ? "" : singleUid;
  }
}

/**
 * 好友排序视图模型
 */
export interface FriendSortViewModel {
  uid: string;
  level: number;
  infoShare?: number;
  infoShareVisited?: number;
  recentVisited?: number;
}

/** 账号密钥渠道常量（参考 DoctoratePy USER_TOKEN_KEY——官方 appCode） */
const USER_TOKEN_KEY = "7318def77669979d";

/**
 * 生成账号密钥（参考 DoctoratePy user.py：MD5(account + 渠道密钥)——确定性）
 * @param phone - 注册手机号
 */
export function generateSecret(phone: string): string {
  return createHash("md5").update(`${phone}${USER_TOKEN_KEY}`).digest("hex");
}

/**
 * UserConfig 的历史遗留战斗字段（旧 users.json 内嵌回放/结算信息）
 *
 * 回放独立存 replays 表、结算信息独立存 battle_infos 表后，UserConfig.battle
 * 不再声明这两项；init() 的一次性迁移仍需按遗留形状读取并删除。
 */
interface LegacyUserConfigBattle {
  replays?: { [stageId: string]: string };
  infos?: { [battleId: string]: BattleInfo };
}

/**
 * 用户配置接口
 * 
 * 存储用户的账户认证、社交、战斗、抽卡等配置信息。
 */
export interface UserConfig {
  uid: string;
  password: string;
  /** 账号密钥（参考 DoctoratePy：MD5(phone + 渠道密钥)，真实模式 token 用） */
  secret?: string;
  /** 是否禁用（Dashboard 删除/禁用用户；禁用后无法登录/鉴权） */
  disabled?: boolean;
  auth: {
    hgId: string;
    phone: string;
    email: string;
    identityNum: string;
    identityName: string;
    isMinor: false;
    isLatestUserAgreement: true;
  };
  // 社交数据（好友/申请/访问）以 social.db 为唯一事实源（R3）——UserConfig 不再携带 social 字段
  battle: {
    stageId: string;
    // 回放独立存 replays 表（R4）、结算信息独立存 battle_infos 表（A3）——configs 均不再携带
  };
  gacha: {
    [key: string]: {
      beforeNonHitCnt: number;
    };
  };
  /** 肉鸽存档快照（服务端自定义；未建模 JSON，索引/取值均须显式收窄） */
  rlv2: JsonValue;
}

/**
 * 战斗信息接口（从 BattleInfoStore 重导出，保持向后兼容）
 */
export type { BattleInfo, BattleRecord } from "../../kernel/battle-info-store";

/** 账户管理器全局实例 */
export const accountManager = new AccountManager();