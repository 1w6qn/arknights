/**
 * 玩家数据管理器类
 *
 * 作为单个玩家数据的核心管理类，负责协调玩家的所有子系统（背包、队伍、地牢、基建等）。
 * 状态引擎（Immer draft 生命周期、patch 聚合、序列化）已拆分至 PlayerStatus，
 * 本类退化为组合根：持有子管理器、事件总线与序列化入口，并委托状态操作。
 */

import excel from "@excel/excel";
import type { ExcelData } from "./excel-port";
import { PlayerDataModel } from "./playerdata";
import { InventoryManager } from "./inventory";
import { GainItemPipeline } from "./inventory-pipeline";
import { TroopManager } from "../modules/character/troop";
import { DungeonManager } from "../modules/dungeon/dungeon";
import { HomeManager } from "../modules/home/HomeManager";
import { StatusManager } from "../modules/user/status";
import { CheckInManager } from "../modules/checkin/checkin";
import { StoryreviewManager } from "../modules/storyreview/StoryreviewManager";
import { MissionManager } from "../modules/mission/logic";
import { ShopManager } from "../modules/shop/logic";
import { RecruitManager } from "../modules/gacha/recruit";
import { RoguelikeV2Manager } from "../modules/roguelike/logic";
import { BattleManager } from "../modules/battle/battle";
import { GachaManager } from "../modules/gacha/logic";
import { SocialManager } from "../modules/social/SocialManager";
import { DexNavManager } from "../modules/dexnav/dexnav";
import { MedalManager } from "../modules/medal/medal";
import { BuildingManager } from "../modules/building/logic";
import { FriendDataWithNameCard, FriendMedalBoard } from "../modules/social/social-model";
import { OpenServerManager } from "../modules/activities/checkin/openServer";
import { PlayerStatus } from "./PlayerStatus";
import {
  composePlayerChildModules,
  type PlayerChildModules,
} from "./player-composition";
import {
  BattleInfo,
  BattleInfoStore,
  BattleRecord,
} from "./battle-info-store";
import { PlayerDataDelta, RoguelikePushMessage } from "./http/common";
import { Draft } from "mutative";
import { logger } from "@utils/logger";
import { TypedEventEmitter } from "./events/runtime";
import { CharRotationManager } from "../modules/character/CharRotationManager";
import { RetroManager } from "../modules/retro/RetroManager";
import { CharManager } from "../modules/character/char";
import { EquipmentMissionManager } from "../modules/equipmentMission/equipmentMission";
import { AprilFoolManager } from "../modules/aprilFool/AprilFoolManager";
import { BossRushManager } from "../modules/activities/bossRush/bossrush";
import { AutoChessManager } from "../modules/autochess/autochess";

export class PlayerDataManager {
  /** 状态引擎（Immer 状态管理、patch 聚合、序列化） */
  playerStatus: PlayerStatus;
  /**
   * 子模块聚合（组合根核心字段）
   *
   * 全部 25 个子模块经 composePlayerChildModules 构造后挂在 modules 下；
   * 下方平铺字段为转发 getter（兼容既有调用点），新代码优先经 player.modules.xxx 访问。
   */
  modules: PlayerChildModules;
  /** 地牢管理器 */
  get dungeon(): DungeonManager { return this.modules.dungeon; }
  /** 背包管理器 */
  get inventory(): InventoryManager { return this.modules.inventory; }
  /** 队伍管理器 */
  get troop(): TroopManager { return this.modules.troop; }
  /** 状态管理器 */
  get status(): StatusManager { return this.modules.status; }
  /** 家园管理器 */
  get home(): HomeManager { return this.modules.home; }
  /** 角色轮换管理器 */
  get charRotation(): CharRotationManager { return this.modules.charRotation; }
  /** 签到管理器 */
  get checkIn(): CheckInManager { return this.modules.checkIn; }
  /** 剧情回顾管理器 */
  get storyreview(): StoryreviewManager { return this.modules.storyreview; }
  /** 任务管理器 */
  get mission(): MissionManager { return this.modules.mission; }
  /** 商店管理器 */
  get shop(): ShopManager { return this.modules.shop; }
  /** 招募管理器 */
  get recruit(): RecruitManager { return this.modules.recruit; }
  /** 肉鸽V2管理器 */
  get rlv2(): RoguelikeV2Manager { return this.modules.rlv2; }
  /** 抽卡管理器 */
  get gacha(): GachaManager { return this.modules.gacha; }
  /** 社交管理器 */
  get social(): SocialManager { return this.modules.social; }
  /** 索引导航管理器 */
  get dexNav(): DexNavManager { return this.modules.dexNav; }
  /** 基建管理器 */
  get building(): BuildingManager { return this.modules.building; }
  /** 开服活动管理器 */
  get openServer(): OpenServerManager { return this.modules.openServer; }
  /** 怀旧活动管理器 */
  get retro(): RetroManager { return this.modules.retro; }
  /** 角色管理器 */
  get char(): CharManager { return this.modules.char; }
  /** 模组任务管理器 */
  get equipmentMission(): EquipmentMissionManager { return this.modules.equipmentMission; }
  /** 勋章管理器 */
  get medal(): MedalManager { return this.modules.medal; }
  /** 愚人节活动管理器 */
  get aprilFool(): AprilFoolManager { return this.modules.aprilFool; }
  /** 尖灭测试（bossRush）活动管理器 */
  get bossRush(): BossRushManager { return this.modules.bossRush; }
  /** 自走棋（卫戍协议）赛季活动管理器 */
  get autoChess(): AutoChessManager { return this.modules.autoChess; }
  /** 战斗管理器 */
  get battle(): BattleManager { return this.modules.battle; }
  /**
   * 统一物品变更管道（建议 4）：物品增减经 setTarget(...).use()/handle() 链式执行，
   * 替代散落的 items:get/items:use 直发。见 inventory-pipeline.ts。
   */
  private _gainItemPipeline: GainItemPipeline | null = null;
  get gainItem(): GainItemPipeline {
    if (!this._gainItemPipeline) {
      this._gainItemPipeline = new GainItemPipeline(this, this._trigger);
    }
    return this._gainItemPipeline;
  }

  /**
   * 回收物品管道队列（请求边界清理）
   *
   * 管道的 `_targets` 是实例态，而本实例经 AccountManager 缓存**跨请求存活**：
   * 调用方若在 `handle()`/`use()` 之前抛错，残留目标会被**下一个请求**一并发放。
   * 故在每个请求的必经出口（{@link delta} 收尾）与异常路径（gameErrorHandler）各回收一次。
   *
   * 刻意不经 `gainItem` getter——那会为从未使用物品管道的请求凭空创建实例。
   */
  resetGainItem(): void {
    this._gainItemPipeline?.clear();
  }
  /** 事件触发器 */
  _trigger: TypedEventEmitter;
  /**
   * 待随下一响应下发的通用推送（medalFinish/equipmentMission 等）
   *
   * 由 delta getter 统一带出并清空；与 rlv2 的附加 pushMessage（rlv2Response 自走一条）
   * 正交，避免互相覆盖。
   */
  _pushMessages: RoguelikePushMessage[] = [];
  /** 登录会话内是否已推送过项目信息提示（避免 rest/重连时重复弹提示） */
  private _loginNoticePushed = false;
  /** 战斗信息存储（构造器注入，解耦 AccountManager） */
  private _battleStore: BattleInfoStore;

  /**
   * excel 数据表端口（构造器注入，解耦 `@excel/excel` 全局单例）
   *
   * 缺省绑定全局单例（行为与迁移前一致），测试/多数据目录场景经 `deps.excel` 覆写。
   * 类型为只读数据端口（见 excel-port.ts），不含 init/resetLazyTables 等生命周期方法。
   */
  private _excel: ExcelData;

  /**
   * excel 数据表端口（模块层读取游戏配置表的唯一入口）
   *
   * 子管理器经 `this._player.excel` 取表，替代 `import excel from "@excel/excel"` 直连单例；
   * 端口成员为消费方驱动（新增表须显式加入 excel-port.ts），守卫见
   * tests/unit/architecture/excel-singleton-ratchet.test.ts。
   */
  get excel(): ExcelData { return this._excel; }

  /**
   * 构造函数
   * @param playerdata - 玩家数据模型
   * @param battleStore - 战斗信息存储（默认 no-op，由 AccountManager 注入）
   * @param deps - 可选依赖（DI）：`deps.modules` 可部分覆写子模块（测试缩小构造面）；
   *   `deps.excel` 覆写 excel 数据端口（测试注入替身 / 多数据目录）
   */
  constructor(
    playerdata: PlayerDataModel,
    battleStore?: BattleInfoStore,
    deps?: { modules?: Partial<PlayerChildModules>; excel?: ExcelData },
  ) {
    this.playerStatus = new PlayerStatus(playerdata);
    // excel 数据端口须在组合子模块之前就位：子模块构造期即可经 this._player.excel 取表
    this._excel = deps?.excel ?? excel;
    this._battleStore = battleStore ?? {
      getBattleInfo: async () => undefined,
      saveBattleInfo: async () => {},
      saveBattleRecord: async () => {},
      getBattleRecord: async () => undefined,
      listBattleRecords: async () => [],
    };
    this._trigger = new TypedEventEmitter();
    // 构造期兼容：子模块构造器可能经 player.xxx 读兄弟模块（getter 转发到 modules），
    // 先给空壳避免 TypeError——旧字段语义为 undefined，此处保持一致，组合完成后覆写。
    this.modules = {} as PlayerChildModules;
    // 组合子模块：默认工厂按原顺序构造全部子模块；deps.modules 覆写个别模块。
    // 构造顺序即事件订阅顺序，必须与迁移前完全一致（见 player-composition.ts）。
    const composed = composePlayerChildModules(this, this._trigger);
    const m = { ...composed, ...deps?.modules };
    // 全部子模块挂到 modules 聚合下（平铺字段为转发 getter，见类字段声明）
    this.modules = m;
    // init 的 promise 暴露给外部（AccountManager 加载后先 await 再播种活动任务，
    // 避免 MissionManager.init 的 missions["ACTIVITY"] = {} 清掉已播种条目）
    this.modules.mission.initPromise = this.modules.mission
      .init()
      .catch((e) => logger.error("MissionManager", `init failed: ${(e as Error).message}`));
    // 子模块初始化副作用
    void this.medal.init().catch((e) => logger.error("MedalManager", `init failed: ${(e as Error).message}`));
    this._trigger.on(
      "save:battle",
      async ([battleId, info]: [string, BattleInfo]) => {
        await this._battleStore.saveBattleInfo(this.uid, battleId, info);
      },
    );
    // 启动迁移：干员技能/模组回填（含精二后模组隐藏→显示状态校正）。
    // 历史上一度通过 game:fix 事件触发但无 emit 方 → 从不执行，导致新/存量干员
    // 的模组条目缺失、精二后客户端无模组入口。这里在构造末直接调用一次。
    void this.troop.fix().catch((e) =>
      logger.error("TroopManager", `fix failed: ${(e as Error).message}`),
    );
  }

  /**
   * 获取玩家原始数据模型（只读 getter，委托状态引擎）
   *
   * 供子管理器与序列化读取；状态变更一律通过 update()/markDirty()。
   */
  get _playerdata(): PlayerDataModel {
    return this.playerStatus._playerdata;
  }

  /**
   * 获取增量更新数据
   *
   * 委托 PlayerStatus 计算增量并清空变更，仅当有变更时触发保存事件。
   * @returns 包含 playerDataDelta 的增量数据
   */
  get delta() {
    const { playerDataDelta, changed } = this.playerStatus.delta;
    if (changed) {
      this._trigger.emit("save", []);
    }
    const base: { playerDataDelta: PlayerDataDelta; pushMessage?: RoguelikePushMessage[] } = {
      playerDataDelta,
    };
    // 通用推送：一并带出并清空（只在非空时下发，避免多余 pushMessage 节）
    if (this._pushMessages.length > 0) {
      base.pushMessage = this._pushMessages;
      this._pushMessages = [];
    }
    // 请求边界回收物品管道队列：delta 是每个请求的必经出口（res.send(player.delta)），
    // 回收走 handle()/use() 之前抛错遗留的目标，避免其泄漏到下一个请求被一并发放。
    this.resetGainItem();
    return base;
  }

  /**
   * 压入一条随下一响应下发的通用推送
   * @param path 推送标识（如 medalFinish / equipmentMission）
   * @param payload 推送内容
   */
  pushMessage(path: string, payload: unknown): void {
    this._pushMessages.push({ path, payload });
  }

  /**
   * 推送本项目信息提示（登录会话内仅推送一次）
   *
   * 在登录数据同步时调用：向客户端推送一条项目名+版本号的提示信息，
   * 随下一 delta 响应以 pushMessage 形式下发；同一会话（玩家数据管理器实例
   * 缓存存活期）内只会推送一次，避免 rest/重连时重复弹提示。
   * @param title - 提示标题（如项目名）
   * @param content - 提示正文（如版本号 / 欢迎语）
   */
  pushLoginNotice(title: string, content: string): void {
    if (this._loginNoticePushed) return;
    this._loginNoticePushed = true;
    this.pushMessage("serverNotice", { title, content });
  }

  /**
   * 获取用户ID
   * @returns 用户ID
   */
  get uid(): string {
    return this.playerStatus.uid;
  }

  /**
   * 会话时间戳（syncData 每次同步刷新为 now()）
   *
   * 用作战斗数据加解密（decryptBattleData/encryptBattleData）的密钥种子。
   * @returns 会话锚点时间戳
   */
  get loginTime(): number {
    return this.playerStatus.loginTime;
  }

  /**
   * 获取玩家社交信息（用于好友展示）
   *
   * 包含昵称、等级、助战角色、勋章板等信息。
   * @returns 玩家社交信息对象
   */
  get socialInfo(): FriendDataWithNameCard {
    const pd = this.playerStatus._playerdata;
    let medalBoard: FriendMedalBoard;
    if (pd.social.medalBoard.custom) {
      medalBoard = {
        custom: pd.medal.custom.customs[pd.social.medalBoard.custom],
        type: pd.social.medalBoard.type,
        template: null,
      };
    } else {
      medalBoard = {
        custom: null,
        type: pd.social.medalBoard.type,
        template: {
          groupId: pd.social.medalBoard.template!,
          medalList: pd.social.medalBoard.templateMedalList!,
        },
      };
    }
    // 防御：助战槽引用的干员已不存在（全新号 / 满配模板残留）时跳过，避免社交信息崩溃
    const assistCharList = pd.social.assistCharList
      .filter((char) => Boolean(pd.troop.chars[char.charInstId]))
      .map((char) => {
        const charInfo = pd.troop.chars[char.charInstId];
        const res = {
        charId: charInfo.charId,
        skinId: charInfo.skin,
        skills: charInfo.skills,
        mainSkillLvl: charInfo.mainSkillLvl,
        skillIndex: char.skillIndex,
        evolvePhase: charInfo.evolvePhase,
        favorPoint: charInfo.favorPoint,
        potentialRank: charInfo.potentialRank,
        level: charInfo.level,
        crisisRecord: {},
        crisisV2Record: {},
        currentEquip: char.currentEquip,
        equip: charInfo.equip,
      };
      if (char?.currentTmpl) {
        return Object.assign({}, res, {
          currentTmpl: char.currentTmpl,
          tmpl: charInfo.tmpl!,
        });
      } else {
        return res;
      }
    });
    return {
      nickName: pd.status.nickName,
      nickNumber: pd.status.nickNumber,
      uid: this.uid,
      registerTs: pd.status.registerTs,
      mainStageProgress: pd.status.mainStageProgress,
      charCnt: pd.troop.curCharInstId - 1,
      furnCnt: this.building.furnCnt,
      skinCnt: this.inventory.skinCnt,
      secretary: pd.status.secretary,
      secretarySkinId: pd.status.secretarySkinId,
      resume: pd.status.resume,
      teamV2: this.dexNav.teamV2Info,
      serverName: pd.status.serverName,
      level: pd.status.level,
      avatar: pd.status.avatar,
      assistCharList: assistCharList,
      lastOnlineTime: pd.status.lastOnlineTs,
      board: this.building.boardInfo,
      infoShare: this.building.infoShare,
      recentVisited: 0,
      skin: {
        selected: pd.nameCardStyle.skin.selected,
        state: {},
      },
      birthday: pd.status.birthday,
      medalBoard: medalBoard,
      nameCardStyle: pd.nameCardStyle,
    };
  }

  /**
   * 标记直接变更（绕过 update() 的原地修改，委托状态引擎）
   */
  markDirty(): void {
    this.playerStatus.markDirty();
  }

  /**
   * 更新玩家数据（使用 mutative，委托状态引擎）
   *
   * 通过传入的 recipe 函数修改数据，自动记录变更补丁（嵌套 update 复用当前 draft）。
   * @param recipe - 数据修改函数
   * @returns recipe 函数的返回值
   */
  async update<T>(
    recipe: (draft: Draft<PlayerDataModel>) => Promise<T>,
  ): Promise<T> {
    return this.playerStatus.update(recipe);
  }

  /**
   * 追加一个强制补丁（委托状态引擎）
   *
   * 供 update() recipe 内主动注入 Immer 无法产生的增量（如 building.event），
   * 避免子管理器直接访问已迁移的 _changes 私有字段。
   * @param path - 补丁路径（如 ["event", "building"]）
   * @param value - 补丁值
   */
  forcePatch(path: (string | number)[], value: unknown): void {
    this.playerStatus.forcePatch(path, value);
  }

  /**
   * 获取战斗信息
   * @param battleId - 战斗ID
   * @returns 战斗信息对象（无记录时为 undefined）
   */
  async getBattleInfo(battleId: string): Promise<BattleInfo | undefined> {
    return await this._battleStore.getBattleInfo(this.uid, battleId);
  }

  /**
   * 留存战斗结束记录（委托存储——battle_records 表，供未来分析）
   * @param record - 战斗结束记录（uid 缺省填当前账号）
   */
  async saveBattleRecord(
    record: BattleRecord,
  ): Promise<void> {
    return this._battleStore.saveBattleRecord({
      ...record,
      uid: record.uid || this.uid,
    });
  }

  /**
   * 读取战斗结束记录（无则 undefined）
   * @param battleId - 战斗ID
   */
  async getBattleRecord(battleId: string): Promise<BattleRecord | undefined> {
    return this._battleStore.getBattleRecord(this.uid, battleId);
  }

  /**
   * 读取最近 N 条战斗结束记录（按创建时间倒序）
   * @param limit - 条数上限
   */
  async listBattleRecords(limit = 50): Promise<BattleRecord[]> {
    return this._battleStore.listBattleRecords(this.uid, limit);
  }

  /**
   * 序列化为JSON（委托状态引擎）
   * @returns 玩家数据模型对象
   */
  toJSON(): PlayerDataModel {
    return this.playerStatus.toJSON();
  }

  /**
   * 预序列化 JSON 字符串（B4 响应缓存，委托状态引擎）
   */
  toJSONString(): string {
    return this.playerStatus.toJSONString();
  }
}
