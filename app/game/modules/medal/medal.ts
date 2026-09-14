/**
 * 勋章管理器
 * 
 * 负责明日方舟中所有勋章的管理，包括：
 * - 勋章进度追踪
 * - 勋章完成检测
 * - 勋章奖励发放
 * - 勋章展示自定义
 * 
 * 勋章系统核心机制：
 * 1. 勋章通过完成特定目标获得（如升级干员、通关关卡等）
 * 2. 每个勋章有独立的进度追踪逻辑
 * 3. 完成勋章可获得相应奖励（通常为家具或头像框）
 * 4. 玩家可自定义勋章展示布局
 */
import {
  PlayerCampaign,
  PlayerDataModel,
  PlayerMedal,
  PlayerMedalCustom,
  PlayerMedalCustomLayout,
  PlayerPerMedal,
} from "../../kernel/playerdata";
import excel from "@excel/excel";
import { ItemBundle } from "@excel/excel";
import { now } from "@utils/time";
import moment from "moment";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import type { EventMap } from "../../kernel/events";
import type { PassStageStats } from "../../kernel/events/medal";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { PlayerCharacter } from "../../kernel/model";
import { rarityToIndex } from "@utils/rarity";
import { logger } from "@utils/logger";

export class MedalManager implements PlayerMedal {
  medals: { [key: string]: MedalProgress };
  custom: PlayerMedalCustom;
  _trigger: TypedEventEmitter;
  _player: PlayerDataManager;

  /**
   * 玩家数据（getter：实时读取 PlayerDataManager 当前状态。
   * Immer finishDraft 会替换 _playerdata 引用，若构造时持有固定引用会读到旧对象——
   * 直接写回 rts 等标量会丢失，故必须经 _player 动态取）
   */
  get _playerdata(): PlayerDataModel {
    return this._player._playerdata;
  }

  /**
   * 构造函数
   * @param player 玩家数据管理器实例（动态取 _playerdata，避免 finishDraft 替换引用后读到旧对象）
   * @param _trigger 事件发射器实例
   */
  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this.medals = {};
    this.custom = player._playerdata.medal.custom;
    this._trigger = _trigger;
    this._trigger.on("medal:complete", this.onMedalComplete.bind(this));
  }

  /**
   * 初始化勋章系统
   * 遍历所有勋章数据，创建MedalProgress实例并初始化
   */
  async init() {
    for (const [id, item] of Object.entries(this._playerdata.medal.medals)) {
      this.medals[id] = new MedalProgress(item, this._trigger, () =>
        this._player.markDirty(),
      );
    }
  }

  /**
   * 设置勋章自定义展示数据
   * @param index 自定义布局索引
   * @param data 自定义布局数据
   */
  setCustomData(args: { index: string; data: PlayerMedalCustomLayout }) {
    this.custom.currentIndex = args.index;
    this.custom.customs[args.index] = args.data;
  }

  /**
   * 发放勋章奖励
   * @param medalId 勋章ID
   * @param group 奖励组ID
   * @returns 获得的物品奖励列表
   * 
   * 勋章奖励通常包括：家具、头像框、名片装饰等
   */
  async rewardMedal(args: { medalId: string; group: string }): Promise<ItemBundle[]> {
    // 已领取（rts != -1）不重复发放
    const current =
      this.medals[args.medalId] ?? this._playerdata.medal.medals[args.medalId];
    if (current && current.rts !== undefined && current.rts !== -1) {
      return [];
    }
    const medalInfo = excel.MedalTable.medalList.find(
      (m) => m.medalId == args.medalId,
    );
    // 防御：未知勋章/未知奖励组不 500
    if (!medalInfo?.medalRewardGroup) return [];
    const medalRewardGroup = medalInfo.medalRewardGroup.find(
      (m) => m.groupId == args.group,
    );
    if (!medalRewardGroup?.itemList) return [];
    // 修复：未完成的勋章不允许领取（原实现只查 rts → 任意勋章任意领）。
    // 完成判定：首次获得时间戳（fts>0）或进度达标（val[0][0] >= val[0][1]）
    const persisted = this._playerdata.medal.medals[args.medalId];
    const progress = current?.val?.[0] ?? persisted?.val?.[0];
    const completed =
      (current?.fts ?? persisted?.fts) > 0 ||
      (progress?.[1] != null && progress[0] >= progress[1]);
    if (!completed) return [];
    const items = medalRewardGroup.itemList;
    const rts = now();
    if (this.medals[args.medalId]) {
      this.medals[args.medalId].rts = rts;
      // 同步写回持久态（MedalProgress 构造持有引用，rts 为标量需显式同步）
      if (this._playerdata.medal.medals[args.medalId]) {
        this._playerdata.medal.medals[args.medalId].rts = rts;
      }
    } else if (this._playerdata.medal.medals[args.medalId]) {
      this._playerdata.medal.medals[args.medalId].rts = rts;
    }
    // 绕过 update() 的原地写回不产生 Immer 补丁，显式标记脏以触发条件落盘
    this._player.markDirty();
    // 必须 await：管道 handle() 内部 emit("items:get") 是异步事件，其监听器
    // （InventoryManager 入账）在下一个 microtask 才完成。若不 await，奖励发放会与
    // 响应读取 player.delta 竞态——客户端收到「已领取」但物品未进本次 delta。
    // 修复前本方法未声明 async，调用方写的 await 作用在非 Promise 上是空操作。
    for (const it of items) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    // 勋章完成推送（对齐官服 medalFinish pushMessage，payload 为 idList）：
    // 随本次响应下发，客户端据此刷新勋章界面
    this._player.pushMessage("medalFinish", { idList: [args.medalId] });
    return items;
  }

  /**
   * 勋章完成事件处理
   * @param medalId 完成的勋章ID
   * 
   * 当勋章进度达到目标时触发，自动发放奖励
   */
  async onMedalComplete([{ medalId }]: [{ medalId: string }]) {
    const medalInfo = excel.MedalTable.medalList.find(
      (m) => m.medalId == medalId,
    );
    // 集齐章结算：无 template 的章靠 preMedalIdList 集齐解锁——任一章达成后重算，
    // 使组内「01 号集章」在前置普通章全部完成时自动点亮
    await this._settleCollectionMedals();
    if (
      !medalInfo ||
      !medalInfo.medalRewardGroup ||
      medalInfo.medalRewardGroup.length === 0
    ) {
      return;
    }
    const defaultRewardGroup = medalInfo.medalRewardGroup[0];
    await this.rewardMedal({ medalId, group: defaultRewardGroup.groupId });
  }

  /**
   * 集齐章（无 template 且含 preMedalIdList）结算
   *
   * 无 template 的章（多为活动组「01 号」全收集章，如 medal_activity_49side_01）没有进度
   * 模板，官方获取方式 = 获得 preMedalIdList 中所有前置普通章后自动解锁。本方法在任一
   * 章完成（medal:complete）后重算：前置全部达成（fts>0 或进度满）即点亮该集章（写 fts +
   * markDirty），不再次触发 medal:complete（避免递归），有奖励组则发放。
   */
  private async _settleCollectionMedals(): Promise<void> {
    const medalList = excel.MedalTable?.medalList ?? [];
    for (const m of medalList) {
      // 仅处理无 template 的集齐章（跳过有模板的普通章）
      if (m.template || !m.preMedalIdList || m.preMedalIdList.length === 0) {
        continue;
      }
      const progress =
        this.medals[m.medalId] ?? this._playerdata.medal.medals[m.medalId];
      if (!progress || (progress.fts ?? 0) > 0) {
        continue;
      }
      // 前置章全部达成才点亮
      const allDone = m.preMedalIdList.every((pre) => {
        const p = this.medals[pre] ?? this._playerdata.medal.medals[pre];
        if (!p) return false;
        if ((p.fts ?? 0) > 0) return true;
        const v = p.val?.[0];
        return v?.[1] != null && v[0] >= v[1];
      });
      if (!allDone) {
        continue;
      }
      const fts = now();
      if (this.medals[m.medalId]) {
        this.medals[m.medalId].fts = fts;
      }
      if (this._playerdata.medal.medals[m.medalId]) {
        this._playerdata.medal.medals[m.medalId].fts = fts;
      }
      this._player.markDirty();
      this._player.pushMessage("medalFinish", { idList: [m.medalId] });
      if (m.medalRewardGroup?.length) {
        await this.rewardMedal({
          medalId: m.medalId,
          group: m.medalRewardGroup[0].groupId,
        });
      }
    }
  }

  /**
   * 序列化勋章数据
   * @returns 勋章数据的JSON表示
   */
  toJSON() {
    return {
      medals: Object.fromEntries(
        Object.entries(this.medals).map(([id, medal]) => [id, medal.toJSON()]),
      ),
      customs: this.custom,
    };
  }
}
/**
 * 勋章进度管理类
 * 
 * 负责单个勋章的进度追踪、事件监听和完成检测。
 * 明日方舟勋章系统的核心逻辑实现，包括：
 * - 根据勋章模板注册相应的事件监听器
 * - 实时更新勋章进度
 * - 勋章完成后触发奖励发放事件
 * 
 * 勋章进度数据结构：
 * - val[0][0]: 当前进度值
 * - val[0][1]: 目标进度值
 * - fts: 首次获得时间戳（完成时间）
 * - rts: 奖励领取时间戳
 * - reward: 奖励领取状态
 */
export class MedalProgress implements PlayerPerMedal {
  val: number[][];
  id: string;
  rts: number;
  fts: number;
  reward: string;
  _trigger: TypedEventEmitter;
  _v: number;
  param!: string[];
  /** 持久态勋章数据引用（_syncToPersist 显式写回用） */
  _item?: PlayerPerMedal;
  /**
   * 进度更新脏标记回调（条件落盘）
   *
   * 保留说明：MedalProgress 采用「共享引用」模型——模板 update 直接原地写 this.val，
   * 且 this.val 与 _playerdata.medal.medals[id].val 为同一数组（构造时重链接，见
   * tests/unit/player/medal.test.ts L282~L322/L695~L722 断言）。单一勋章进度更新
   * 体量极小，若迁入 update() 配方需按 draft.medal.medals[id] 定位重写全部模板方法并
   * 破坏共享引用契约，故事件处理器内保留直改 + 显式 markDirty（迁移前需先重构引用模型）。
   */
  _markDirty?: () => void;

  /**
   * 构造函数
   * @param item 玩家勋章数据
   * @param _trigger 事件发射器实例
   * @param _markDirty 进度更新后的脏标记回调（由 MedalManager 传入——进度绕过 update()，需显式标记条件落盘）
   */
  constructor(
    item: PlayerPerMedal,
    _trigger: TypedEventEmitter,
    _markDirty?: () => void,
  ) {
    this.id = item.id;
    // scratch：init() 在此构建进度结构（[0, target]）；with-val 时末尾改绑存档数组，此结构丢弃
    this.val = [[]];
    this.rts = item.rts;
    this.fts = item.fts;
    this.reward = item.reward || "";
    this._v = item.val?.[0]?.[0] || 0;
    this._trigger = _trigger;
    this._item = item;
    this._markDirty = _markDirty;
    // 未完成（fts 未设或进度未满）的勋章注册进度监听，使既有存档也能继续追踪
    const target = item.val?.[0]?.[1];
    // 目标位缺失/非数值同样要重建进度（修复 2026-09-09）：旧实现把危机合约等模板的
    // 目标算成 NaN，JSON 落盘为 null —— 此处 target 为 null（falsy）→ 原本连 init()
    // 都不执行 → 监听器根本不注册，即使模板目标位已修好也依然零进度可累积。
    const targetMissing = target == null || !Number.isFinite(Number(target));
    if (!this.fts || targetMissing || (target && this._v < target)) {
      this.init();
    }
    // 持久态绑定：
    // - with-val：共享存档数组（模板 update 原地写 this.val 即落入 _playerdata）
    // - missing-val：把 init 构建的结构回填到 item.val 并共享引用（否则构建结果被丢弃、
    //   进度更新断链丢失——旧数据勋章进度永不持久化）
    const missingVal = !item.val;
    if (missingVal) {
      item.val = this.val;
    } else {
      this.val = item.val;
    }
  }

  /**
   * 显式写回持久态并标记脏（A1）
   *
   * 进度更新绕过 update()（无 Immer 补丁），依赖共享引用隐式落盘——此方法显式重链接
   * （自愈：即使共享引用被 Immer 克隆打断也重新指向）并触发条件落盘脏标记。
   */
  private _syncToPersist(): void {
    if (this._item) {
      this._item.val = this.val;
      this._item.rts = this.rts;
      this._item.fts = this.fts;
    }
    this._markDirty?.();
  }

  /**
   * 取 unlockParam 的数值目标（按官方参数位取；非数值 → 永不达成）
   *
   * 危机合约 / 重构符文系列的 unlockParam[0] 是**赛季 id**（如 rune_season_12_1），
   * 数值目标排在其后的关卡 / 词条 / 任务列表之后再一位。修复（2026-09-09）：
   * 原实现这些模板一律 parseInt(this.param[0]) → NaN → init 后
   * `0 >= NaN` 恒为 false → 监听器虽注册但**永不可能达成**（危机合约批次
   * 约 100 枚 + 重构符文 16 枚因此全数不可得）。
   * 返回 Number.MAX_SAFE_INTEGER 而非 0：宁可不可得，也不要把缺参误判成「已达成」
   * 而错发勋章。
   *
   * @param index - unlockParam 下标
   */
  _paramNum(index: number): number {
    const raw = this.param?.[index];
    const n = parseInt(String(raw ?? ""), 10);
    if (Number.isFinite(n)) return n;
    logger.warn(
      "MedalManager",
      `${this.id} unlockParam[${index}] 非数值（${String(raw)}）——按不可达成处理`,
    );
    return Number.MAX_SAFE_INTEGER;
  }

  /** 取 unlockParam 的分号分隔 id 列表（危机合约节点 / 词条 / 任务清单） */
  _paramList(index: number): string[] {
    return String(this.param?.[index] ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * 赛季门控：事件载荷的 seasonId 与本勋章 unlockParam[0] 一致才计入。
   * 载荷缺 seasonId 时放行（兼容不携带赛季的旧载荷，避免进度倒退）。
   */
  _seasonMatch(seasonId?: string): boolean {
    const want = String(this.param?.[0] ?? "");
    if (!want || !seasonId) return true;
    return seasonId === want;
  }

  /**
   * 初始化勋章进度
   * 
   * 根据勋章模板注册事件监听器，监听相关游戏事件以更新勋章进度。
   * 如果勋章已完成（进度达到目标），则不注册监听器。
   */
  init() {
    // excel 未初始化时跳过（私服健壮性：PlayerDataManager 构造早于 excel 加载的场景不崩）
    if (!excel.MedalTable?.medalList) {
      return;
    }
    const medalInfo = excel.MedalTable.medalList.find(
      (m) => m.medalId == this.id,
    );
    // 勋章不在配置表中（活动下架残留等）时跳过进度注册
    if (!medalInfo) {
      return;
    }
    const template = medalInfo.template;
    if (!template) {
      this.val = [];
      return;
    }
    this.param = medalInfo.unlockParam;
    // 模板名 → 处理函数（显式表）。表里没有 = 未实现模板，语义等价于原 `template in this`。
    const handler = MedalTemplateHandlers[template];
    if (!handler) {
      // 未实现模板（数据版本新增 / 活动模板）——降级为不追踪进度，避免整服崩溃
      logger.debug(
        "MedalManager",
        `template ${template} not implemented, skip ${this.id}`,
      );
      this.val = [[0, 0]];
      return;
    }

    handler(this, {} as never, "init");

    const target = this.val[0][1];
    // 存档侧目标位修复（2026-09-09）：旧实现在危机合约等模板上把目标算成 NaN，
    // 而 JSON 无法表达 NaN → 落盘为 null → 客户端进度条无目标、且奖励/集齐章的
    // 完成判定（val[0][1] != null）永假。此处把重算出的目标回写存档数组
    // （直接改持久态数组 → 显式 markDirty）。
    const persistedVal = this._item?.val?.[0];
    if (
      persistedVal &&
      target < Number.MAX_SAFE_INTEGER &&
      (persistedVal[1] == null || !Number.isFinite(Number(persistedVal[1])))
    ) {
      persistedVal[1] = target;
      this._markDirty?.();
    }
    if (this.val[0][0] >= target) {
      return;
    }

    // 模板名即事件名。已声明模板直接命中 EventMap 键；历史模板名（无 emit 侧）
    // 不在 EventMap 中，但运行时仍是同一个字符串键，订阅/退订语义不变。
    const eventName = template as keyof EventMap;
    const func = async (data: EventMap[keyof EventMap]) => {
      // data 为事件载荷元组（Emittery 单参约定），首元素即模板载荷
      handler(this, data[0] as never, "update");
      // 进度更新显式写回持久态 + 标记脏（A1——不依赖共享引用隐式落盘）
      this._syncToPersist();
      if (this.val[0][0] >= target) {
        logger.info("MedalManager", `${this.id} complete`);
        // 修复：完成时记录首次获得时间戳（原实现从不设 fts，完成态判定仅靠进度）
        this.fts = now();
        this._syncToPersist();
        this._trigger.off(eventName, func);
        // 修复：await 完成事件——Emittery.emit 并行执行监听器，原 fire-and-forget
        // 的 medal:complete 与同批任务监听器的 update() 并发竞争共享 Immer draft，
        // 可触发 "proxy revoked"（与 mission.ts 同源交错问题）
        await this._trigger.emit("medal:complete", [{ medalId: this.id }]);
      }
    };

    this._trigger.on(eventName, func);
  }

  /**
   * 空更新方法（用于兼容性）
   */
  update() {}

  /**
   * 玩家等级勋章模板
   * 追踪玩家等级达到指定等级
   * @param param[0] 目标等级
   */
  PlayerLevel(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { level: number }) => {
        this.val[0][0] = args.level;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 加入游戏天数勋章模板
   * 追踪玩家加入游戏的天数
   * @param param[0] 目标天数
   */
  JoinGameDays(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 干员数量勋章模板
   * 追踪玩家拥有的干员数量
   * @param param[0] 目标干员数量
   */
  CharNum(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { curCharInstId: number }) => {
        // 修复：实际干员数 = curCharInstId - 1（instId 从 1 递增，与
        // PlayerDataManager.socialInfo.charCnt 一致）——原实现多算 1
        this.val[0][0] = Math.max(0, (args.curCharInstId ?? 1) - 1);
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 招募次数勋章模板
   * 追踪玩家招募干员的次数
   * @param param[0] 目标招募次数
   */
  RecruitCount(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: {}) => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关特定关卡勋章模板
   * 追踪玩家通关指定关卡的数量
   * @param param[0] 通关状态要求
   * @param param[1] 关卡ID列表（分号分隔）
   * @param param[2] 目标通关数量
   */
  PassStageSome(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[2])),
      update: (args: PlayerDataManager) => {
        const stages: string[] = this.param[1].split(";");
        let count = 0;
        Object.values(args._playerdata.dungeon.stages).forEach((stage) => {
          if (
            stages.includes(stage.stageId) &&
            stage.state >= parseInt(this.param[0])
          ) {
            count += 1;
          }
        });
        this.val[0][0] = count;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 剿灭作战花费理智勋章模板
   * 追踪玩家在剿灭作战中花费的理智（源石碎片）数量
   * @param param[0] 目标花费数量
   */
  CampaignsDiamondLimit(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: PlayerCampaign) => {
        this.val[0][0] = args.campaignTotalFee;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 剿灭作战完成勋章模板
   * 追踪玩家完成剿灭作战的次数（击杀400敌人且领取奖励）
   * @param param[0] 剿灭作战ID
   */
  CampaignsComplete(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, 1),
      update: (args: PlayerCampaign) => {
        if (args.instances[this.param[0]].maxKills != 400) {
          return;
        }
        if (args.instances[this.param[0]].rewardStatus.includes(0)) {
          return;
        }
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关剿灭作战勋章模板
   * 追踪玩家通关剿灭作战的数量
   * @param param[0] 目标通关数量
   */
  PassTower(args: {}, mode: string = "update") {
    // 修复（2026-09-09）：数据里 param[0] 是保全派驻关卡 id（tower_n_01…）、param[2] 为
    // 困难标记（0/1）——原实现 `parseInt(param[0])` 恒 NaN（目标 NaN 永不完成），
    // 且把「通关数量」当累加值。现改为「通关指定副本即完成」。
    const funcs = {
      init: () => this.val[0].push(0, 1),
      update: (args: { stageId?: string; count?: number; isHard?: boolean }) => {
        const want = this.param[0];
        if (want && args?.stageId !== want) return;
        const wantHard = this.param[2];
        if (wantHard === "1" && !args?.isHard) return;
        if (wantHard === "0" && args?.isHard) return;
        this.val[0][0] += args?.count ?? 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 干员精英化次数勋章模板
   * 追踪玩家将干员精英化到指定阶段的次数
   * @param param[0] 目标精英化次数
   * @param param[1] 精英化阶段要求（默认为2，即精英二）
   */
  CharEvolveCount(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { char: PlayerCharacter }) => {
        if (args.char.evolvePhase >= parseInt(this.param[1] || "2")) {
          this.val[0][0] += 1;
        }
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 干员技能升级次数勋章模板
   * 追踪玩家升级干员技能的总次数（按等级累加）
   * @param param[0] 目标技能等级累加值
   */
  CharSkillCount(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { targetLevel: number }) => {
        this.val[0][0] += args.targetLevel;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 干员技能专精次数勋章模板
   * 追踪玩家将干员技能专精到指定等级的次数
   * @param param[0] 目标专精次数
   * @param param[1] 专精等级要求（默认为3）
   */
  CharSkillSpecCount(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { targetLevel: number }) => {
        if (args.targetLevel >= parseInt(this.param[1] || "3")) {
          this.val[0][0] += 1;
        }
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 干员信赖度达成勋章模板
   * 追踪玩家将干员信赖度提升到指定百分比的次数
   * @param param[0] 目标干员数量
   * @param param[1] 信赖度百分比要求（默认为200%）
   */
  CharFavorCount(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { favorPoint: number }) => {
        let percent: number;
        if (args.favorPoint == excel.FavorTable.maxFavor) {
          percent = 200;
        } else {
          const frame = excel.FavorTable.favorFrames.find((_f, idx, table) => {
            return (
              args.favorPoint >= table[idx].level &&
              args.favorPoint < (table[idx + 1]?.level || Infinity)
            );
          });
          percent = (frame?.data as { percent?: number })?.percent || 0;
        }
        if (percent >= parseInt(this.param[1] || "200")) {
          this.val[0][0] += 1;
        }
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 获取干员勋章模板
   * 追踪玩家获取指定稀有度干员的数量
   * @param param[0] 目标干员数量
   * @param param[1] 干员稀有度要求（默认为5星）
   */
  GotChars(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => {
        // 修复：param[0] 可能是分号分隔的干员列表（medal_growth_char_*）——
        // parseInt 得 NaN → 目标永远无法达成；列表形式目标 = 列表长度
        const p0 = String(this.param[0] ?? "");
        const target = p0.includes(";")
          ? p0.split(";").length
          : parseInt(p0) || 0;
        this.val[0].push(0, target);
      },
      update: (args: { char: PlayerCharacter }) => {
        const data = excel.charData(args.char.charId);
        const p0 = String(this.param[0] ?? "");
        if (p0.includes(";")) {
          // 指定干员列表形式：命中列表内干员 +1
          if (p0.split(";").includes(args.char.charId)) {
            this.val[0][0] += 1;
          }
          return;
        }
        // 稀有度阈值形式：rarity 为 "TIER_N" 字符串——原 `"TIER_5" >= 5` 恒 false，
        // 统一经 rarityToIndex 转 0~5 再比较
        if (rarityToIndex(data?.rarity) >= parseInt(this.param[1] || "5")) {
          this.val[0][0] += 1;
        }
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 干员潜能提升勋章模板
   * 追踪玩家将干员潜能提升到指定等级的次数
   * @param param[0] 目标潜能提升次数
   * @param param[1] 潜能等级要求（默认为6）
   */
  CharPotential(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => {
        // 修复：param[0] 可能是分号分隔的干员列表（medal_growth_potential_*）——
        // parseInt 得 NaN → 目标永不可达成；列表形式目标 = 列表长度
        const p0 = String(this.param[0] ?? "");
        const target = p0.includes(";")
          ? p0.split(";").length
          : parseInt(p0) || 0;
        this.val[0].push(0, target);
      },
      update: (args: { targetLevel: number }) => {
        if (args.targetLevel >= parseInt(this.param[1] || "6")) {
          this.val[0][0] += 1;
        }
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 解锁干员档案勋章模板
   * 追踪玩家解锁干员档案的数量
   * @param param[0] 目标解锁数量
   */
  CharStoryUnlock(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 升级基地等级
   *
   * 追踪玩家在生息演算玩法中升级基地的进度。目标为 param[0]。
   * 注：当前为占位实现（进度恒取注册后天数，未接入玩法真实状态）。
   * @param param[0] 目标基地等级
   */
  Sbv2UpgradeBase(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题 id（sandbox_1），数值目标在
    // param[1]（官服存档 val[0][1] 反推）——原实现 parseInt(param[0]) → NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 完成任务
   *
   * 追踪玩家在生息演算玩法中完成的任务数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标完成任务数
   */
  Sbv2FinishQuest(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam = [主题, 条件 id, …]，官服存档 val 为
    // [[1,1]]（达成标志），param[1] 是**条件 id 而非数值**——原实现 parseInt(param[0])
    //（主题 id）→ NaN → 永不可得。故目标恒为 1，条件满足时置 1。
    const target = 1;
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 使用指定角色通关战斗
   *
   * 追踪玩家使用指定干员完成生息演算战斗的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  Sbv2BattleFinishWithChar(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题 id（sandbox_1），数值目标在
    // param[2]（官服存档 val[0][1] 反推）——原实现 parseInt(param[0]) → NaN → 永不可得。
    const target = this._paramNum(2);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 解锁菜谱
   *
   * 追踪玩家在生息演算玩法中解锁的菜谱数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标菜谱数量
   */
  Sbv2UnlockCook(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题 id（sandbox_1），数值目标在
    // param[1]（官服存档 val[0][1] 反推）——原实现 parseInt(param[0]) → NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 放置建筑
   *
   * 追踪玩家在生息演算基建中放置建筑的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标建筑放置数
   */
  Sbv2PlaceBuilding(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam = [主题, 条件 id, …]，官服存档 val 为
    // [[1,1]]（达成标志），param[1] 是**条件 id 而非数值**——原实现 parseInt(param[0])
    //（主题 id）→ NaN → 永不可得。故目标恒为 1，条件满足时置 1。
    const target = 1;
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 通关指定裂隙关卡
   *
   * 追踪玩家通关生息演算指定关卡（裂隙）的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标关卡进度
   */
  Sbv2PassRiftLevel(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam = [主题, 条件 id, …]，官服存档 val 为
    // [[1,1]]（达成标志），param[1] 是**条件 id 而非数值**——原实现 parseInt(param[0])
    //（主题 id）→ NaN → 永不可得。故目标恒为 1，条件满足时置 1。
    const target = 1;
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 通关裂隙次数
   *
   * 追踪玩家通关生息演算裂隙关卡的总次数。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标通关次数
   */
  Sbv2PassRiftCount(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题 id（sandbox_1），数值目标在
    // param[1]（官服存档 val[0][1] 反推）——原实现 parseInt(param[0]) → NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 捕获生物
   *
   * 追踪玩家在生息演算玩法中捕获生物的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标捕获生物数
   */
  Sbv2CatchAnimal(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题 id（sandbox_1），数值目标在
    // param[1]（官服存档 val[0][1] 反推）——原实现 parseInt(param[0]) → NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 解锁科技
   *
   * 追踪玩家在生息演算玩法中解锁的科技数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标科技解锁数
   */
  Sbv2UnlockTech(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题 id（sandbox_1），数值目标在
    // param[1]（官服存档 val[0][1] 反推）——原实现 parseInt(param[0]) → NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 存活天数
   *
   * 追踪玩家在生息演算玩法中存活的天数。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标存活天数
   */
  Sbv2SurviveDays(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题 id（sandbox_1），数值目标在
    // param[2]（官服存档 val[0][1] 反推）——原实现 parseInt(param[0]) → NaN → 永不可得。
    const target = this._paramNum(2);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv2）— 击杀首领
   *
   * 追踪玩家在生息演算玩法中击杀首领的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标击杀首领数
   */
  Sbv2KillBoss(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 通关节点
   *
   * 每次通关节点 +1，达 param[0] 完成。
   * @param param[0] 目标节点数
   */
  Rlv2PassNode(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam = [主题, 目标节点数]（官服 getMethod
    // 「在集成战略：XX主题中通过 N 个节点」，官服存档 val[0][1] 反推目标位 = param[1]）。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 事件由 roguelike battle-nav 在抵达节点时发射（载荷带 theme）
      update: (args: { theme?: string }) => {
        if (!this._seasonMatch(args.theme)) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 月度小队/点数等级
   *
   * 进度直接取当前点数等级 level（覆盖式），达 param[0] 完成。
   * @param param[0] 目标等级
   */
  Rlv2BpLevel(args: {}, mode: string = "update") {
    // unlockParam = [主题, 目标等级]（官服 getMethod「在集成战略：XX主题的源流堆栈中解锁至 N 级」）。
    // 目标位修复（2026-09-09）：原实现取 parseInt(param[0])（主题 id）→ NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 载荷为当前等级（由 bp.point 按官方 milestones 门槛换算）——等级单调递增，
      // 覆盖写入即可；补主题门控（args.theme），避免别主题的等级覆盖本章进度。
      update: (args: { theme?: string; level?: number }) => {
        if (!this._seasonMatch(args.theme)) return;
        this.val[0][0] = Math.max(this.val[0][0], args.level ?? 0);
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 装扮/通用养成到位
   *
   * 每次事件 +1，达 param[0] 完成。
   * @param param[0] 目标次数
   */
  PermUpgrade(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 炼金/合成使用
   *
   * 每次使用炼金（合成）事件 +1，达 param[0] 完成。
   * @param param[0] 目标次数
   */
  UseAlchemy(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 招募干员
   *
   * 每次招募干员 +1，达 param[0] 完成。
   * @param param[0] 目标招募次数
   */
  Rlv2Recruit(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam = [主题, 目标招募次数]（官服 getMethod
    // 「在集成战略：XX主题中招募或应急雇佣干员 N 次」）。原实现取 parseInt(param[0]) → NaN。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 事件由 roguelike recruit.ts 在招募确认时发射（载荷带 theme）
      update: (args: { theme?: string }) => {
        if (!this._seasonMatch(args.theme)) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 获得小队奖励
   *
   * 每次获得小队奖励 +1，达 param[0] 完成。
   * @param param[0] 目标奖励获取次数
   */
  Rlv2GetTeamReward(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 结局收集
   *
   * 每次获得结局（args.ending）事件 +1，达 param[0] 完成。
   * @param param[0] 目标结局数
   */
  Rlv2EndingCollect(args: {}, mode: string = "update") {
    // unlockParam = [主题, 目标结局种数]（官服 getMethod「在集成战略：XX主题中达成 N 种结局」）。
    // 目标位修复（2026-09-09）：原实现取 parseInt(param[0])（主题 id）→ NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 载荷为当前**已达成结局种数**（collect.endBook 条目数，settle 写入）——取 max 幂等；
      // 原实现逐条 ending 事件 +1，无去重、也无事件派发。
      update: (args: { theme?: string; count?: number }) => {
        if (!this._seasonMatch(args.theme)) return;
        this.val[0][0] = Math.max(this.val[0][0], args.count ?? 0);
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 收藏收集
   *
   * 追踪玩家收藏密室宝箱/战利品的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标收藏数
   */
  Rlv2CollectRelic(args: {}, mode: string = "update") {
    // unlockParam = [主题, 目标收藏品数]（官服 getMethod「XX主题中的拟造物质编目已持有 N 个收藏品」）。
    // 目标位修复（2026-09-09）：原实现取 parseInt(param[0])（主题 id）→ NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 载荷为**当前累计收藏数**（roguelike 局外 collect.relic 已获得条目数，非增量）——
      // 取 max 保证幂等；原实现为 registerTs 天数占位逻辑。
      update: (args: { theme?: string; count?: number }) => {
        if (!this._seasonMatch(args.theme)) return;
        this.val[0][0] = Math.max(this.val[0][0], args.count ?? 0);
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 使用指定角色通关战斗
   *
   * 追踪玩家使用指定干员完成肉鸽战斗的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  Rlv2FinishBattleWithSpecChar(args: {}, mode: string = "update") {
    // unlockParam = [主题, 干员A, 干员A变体, 目标胜利次数]（官服 getMethod「在 XX主题中
    // 携带干员 YY 战斗胜利 N 次（常规行动或讲述者列表下）」；rogue_1 的两个干员 id 为
    // 基础/进阶形态，携带任一即算）。目标位修复（2026-09-09）：原实现取 parseInt(param[0])
    //（主题 id）→ NaN，且 update 为 registerTs 天数占位逻辑。
    const target = this._paramNum(3);
    const wantChars = [...this._paramList(1), ...this._paramList(2)];
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 载荷由 settle 在结算时发出：本局参战干员 + 本局作战胜利数
      update: (args: {
        theme?: string;
        charIds?: string[];
        battleWinCount?: number;
      }) => {
        if (!this._seasonMatch(args.theme)) return;
        if (!wantChars.length) return;
        const carried = (args.charIds ?? []).some((c) => wantChars.includes(c));
        if (!carried) return;
        this.val[0][0] += args.battleWinCount ?? 0;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 指定模式与难度达成结局
   *
   * 追踪玩家在指定开局/难度下达成结局的次数。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标结局次数
   */
  Rlv2EndingWithModeGrade(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 解锁乐/节奏带
   *
   * 追踪玩家解锁玩法乐带进度的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标解锁数
   */
  Rlv2UnlockBand(args: {}, mode: string = "update") {
    // unlockParam = [主题, 目标分队数]（官服 getMethod「在集成战略：XX主题中解锁 N 个分队」）。
    // 目标位修复（2026-09-09）：原实现取 parseInt(param[0])（主题 id）→ NaN → 永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 载荷为当前**已解锁分队数**（collect.band state ≥ 1，见 events.ts「state 1 = 已解锁」）
      update: (args: { theme?: string; count?: number }) => {
        if (!this._seasonMatch(args.theme)) return;
        this.val[0][0] = Math.max(this.val[0][0], args.count ?? 0);
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 图腾共鸣
   *
   * 追踪玩家触发图腾共鸣进度的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标共鸣数
   */
  Rlv2TotemResonance(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 完成节点任务
   *
   * 追踪玩家完成节点隐藏任务的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标任务数
   */
  Rlv2CompleteNodeMission(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 获得密文胶囊
   *
   * 追踪玩家获得密文胶囊的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标胶囊数
   */
  Rlv2GainCapsule(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 基建家具主题数量勋章模板
   * 追踪玩家拥有的家具主题数量（按 furniture 去重主题计数）
   * @param param[0] 目标主题数量
   */
  BuildingGotFurnitureThemeCount(args: { count?: number }, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      // 修复：原实现复制 JoinGameDays（按注册天数）——主题数恒为注册天数；
      // 现按家具主题去重计数（args.count 由 inventory FURN 发放时下发）
      update: (args: { count?: number }) => {
        this.val[0][0] = Math.max(this.val[0][0], args.count ?? 0);
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 基建制造产品次数勋章模板
   * 追踪玩家制造站累计产出的方案数
   * @param param[0] 目标制造次数
   */
  BuildingManufactureProductTimes(args: { count?: number }, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      // 修复：原实现复制 JoinGameDays——制造次数恒为注册天数；
      // 现按 settleManufacture 实际产出方案数累加
      update: (args: { count?: number }) => {
        this.val[0][0] += args.count ?? 0;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 基建工坊合成（按组）勋章模板
   * 追踪玩家加工站指定配方类型（param[1]，如 F_EVOLVE）的合成次数
   * @param param[0] 目标合成次数
   * @param param[1] 配方类型过滤（formulaType）
   */
  BuildingWorkshopSynthesisGroupByID(args: { groupId?: string }, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      // 修复：原实现复制 JoinGameDays——合成次数恒为注册天数；
      // 现按 workshopSynthesis 配方类型匹配 param[1] 累加
      update: (args: { groupId?: string }) => {
        if (args.groupId && args.groupId === this.param[1]) {
          this.val[0][0] += 1;
        }
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 限时获取角色勋章模板
   * 在指定结束时间（param[1]，unix 秒）前获得 param[0] 指定干员即达成
   *（act53side medal_activity_53side_02）。事件 GotCharsBeforeTime:[{charId}] 由
   * 干员入账处发射。
   */
  GotCharsBeforeTime(args: { charId: string }, mode: string = "update") {
    const funcs = {
      init: (_args: {}) => this.val[0].push(0, 1),
      update: (args: { charId: string }) => {
        if (args.charId !== this.param[0]) return;
        if (now() > parseInt(this.param[1])) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动代币消耗勋章模板
   * 累计消耗活动币，消耗来源（coinType，取 activity id）匹配 param[0] 即累加
   * 花费 param[2] 达成（act53side medal_activity_53side_03）。事件
   * ActivityCoinCost:[{coinType, cost}] 由活动商店扣币处发射。
   */
  ActivityCoinCost(args: { coinType: string; cost: number }, mode: string = "update") {
    const funcs = {
      init: (_args: {}) => this.val[0].push(0, parseInt(this.param[2])),
      update: (args: { coinType: string; cost: number }) => {
        if (typeof args?.coinType === "string" && !String(args.coinType).includes(this.param[0])) {
          return;
        }
        this.val[0][0] += args.cost ?? 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 任务完成数量勋章模板
   * 完成 param[0]（分号分隔的任务 id 列表，如 53sideActivity_*）指定的任务组，
   * 目标 = 列表长度（act53side medal_activity_53side_04）。事件
   * MissionCompleteSome:[{count}] 在活动任务成功领取后发射（每完成一个 +1）。
   */
  MissionCompleteSome(args: { count: number }, mode: string = "update") {
    const funcs = {
      init: () => {
        const p0 = String(this.param[0] ?? "");
        const target = p0.includes(";") ? p0.split(";").length : parseInt(p0) || 0;
        this.val[0].push(0, target);
      },
      update: (args: { count?: number }) => {
        this.val[0][0] += args?.count ?? 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动关卡内累计代币数（下限）
   *
   * 追踪在活动关卡中获得的代币数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标代币数量
   */
  ActivityPassStageWithSimpleTokenCountMore(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act35side）— 完成雕刻
   *
   * 追踪完成活动雕刻的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标雕刻数
   */
  Act35SideFinishCarving(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡且击杀指定敌人勋章模板
   * 官服语义：一次通关战斗中，当关击倒（counterType=param[3]，如 FALLDOWN）目标敌人
   *（param[2]，enemy_10228_agball）即计 1 次，累计 param[4] 次完成；通关状态门槛
   * 取 param[0]（活动章 completeState>=3=三星）。事件
   * PassStageWithSimpleCountMore:[{stageId, completeState, enemyStats}] 由 battle 结算发射。
   */
  PassStageWithSimpleCountMore(
    args: PassStageStats,
    mode: string = "update",
  ) {
    const funcs = {
      init: (_args: {}) => this.val[0].push(0, parseInt(this.param[4])),
      update: (args: PassStageStats) => {
        if (args.stageId !== this.param[1]) return;
        if ((args.completeState ?? 0) < parseInt(this.param[0] || "2")) return;
        const stats = args.enemyStats ?? [];
        const downed = stats.some(
          (s) =>
            s.Key?.enemyId === this.param[2] &&
            s.Key?.counterType === this.param[3] &&
            s.Value > 0,
        );
        if (!downed) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡且击杀敌方指定单位种类（细分）
   *
   * 追踪通关活动关卡且累计击杀指定敌人种类的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标等级
   */
  PassStageWithDetailDiffCountMore(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（代币上限）
   *
   * 通关时场内置放/使用代币数不超过 param[1] 即 +1，达 param[0] 完成。
   * @param param[0] 目标场次
   * @param param[1] 代币数量上限
   */
  PassStageWithSimpleTokenCountLess(args: PassStageStats, mode: string = "update") {
    // 修复（2026-09-09）：数据实参为 [completeState, stageId, token 名, 目标场次]，
    // 原实现读 args.tokenCount/param[1]（stageId）→ 恒不成立。
    const funcs = {
      init: () => this.val[0].push(0, parseInt(this.param[3] ?? "1") || 1),
      update: (args: PassStageStats) => {
        if (args?.stageId !== this.param[1]) return;
        if ((args?.completeState ?? 0) < parseInt(this.param[0] || "2")) return;
        if (this._tokenStatValue(args, this.param[2]) > 0) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 累计击杀敌人总数
   *
   * 每场累计击杀数 killCnt 累加，达 param[0] 完成。
   * @param param[0] 目标击杀总数
   */
  PassStageKilledTotal(args: PassStageStats, mode: string = "update") {
    // 修复（2026-09-09）：数据实参为 [completeState, 关卡列表(;), 敌人 id, 目标击杀数]，
    // 原实现读 args.killCnt/param[0]（completeState）→ 恒错。
    const funcs = {
      init: () => this.val[0].push(0, parseInt(this.param[3] ?? "1") || 1),
      update: (args: PassStageStats) => {
        const stages = String(this.param[1] ?? "").split(";").filter(Boolean);
        if (stages.length && !stages.includes(args?.stageId)) return;
        if ((args?.completeState ?? 0) < parseInt(this.param[0] || "2")) return;
        const killed = this._enemyStatValue(args, this.param[2]);
        if (killed <= 0) return;
        this.val[0][0] = Math.min(this.val[0][1], this.val[0][0] + killed);
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（多人）— 关卡总分
   *
   * 追踪联合行动关卡的累计总分。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标总分
   */
  ActMultiplayVerify2StageTotalScore(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（多人）— 达成分数通关
   *
   * 追踪联合行动中达到指定分数通关的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  ActMultiplayVerify2PassStageWithScore(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[2]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(2);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动里程碑点数
   *
   * 追踪活动里程碑累计点数。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标点数
   */
  ActivityMilestonePoint(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 限时获得指定物品
   *
   * 追踪在限时内获得指定物品（param[?]）的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标物品数
   */
  GotItemBeforeTime(args: {}, mode: string = "update") {
    // 修复（2026-09-09）：原实现是「注册后经过天数」的占位（param[0]=1 时次日即自动获得），
    // 与官方语义「在截止时间前获得指定物品」不符。现按数据实参实现：
    // param[0]=目标数量、param[1]=物品 id（如时装 char_264_f12yin@marthe#13）、param[2]=截止时间戳（秒）。
    // 事件由物品管道（InventoryManager items:get）补发。
    const target = parseInt(this.param[0] ?? "1") || 1;
    const funcs = {
      init: () => this.val[0].push(0, target),
      update: (args: { itemId?: string }) => {
        const wantItem = this.param[1];
        if (wantItem && args?.itemId !== wantItem) return;
        const deadline = Number(this.param[2] ?? 0);
        if (deadline > 0 && now() > deadline) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 读取战斗统计中指定敌人/计数器的值（enemyStats）
   *
   * 修复（2026-09-09）：PassStage 系列模板共用的统计读取工具——
   * enemyId 支持分号分隔多 id；counterType 为空时汇总全部计数器。
   * @param args - 战斗统计载荷（battle 结算发射）
   * @param enemyId - 敌人 id（可分号分隔）
   * @param counterType - 计数器类型（如 FALLDOWN）
   * @returns 命中计数（无记录返回 0）
   */
  private _enemyStatValue(
    args: {
      enemyStats?: {
        Key?: { enemyId?: string; counterType?: string };
        Value?: number;
      }[];
    },
    enemyId?: string,
    counterType?: string,
  ): number {
    const ids = String(enemyId ?? "").split(";").filter(Boolean);
    let sum = 0;
    for (const s of args?.enemyStats ?? []) {
      const id = String(s?.Key?.enemyId ?? "");
      if (ids.length > 0 && !ids.includes(id)) continue;
      if (counterType && s?.Key?.counterType !== counterType) continue;
      sum += Number(s?.Value ?? 0) || 0;
    }
    return sum;
  }

  /**
   * 读取场外 token 计数（extraBattleInfo）
   * @param args - 战斗统计载荷
   * @param token - token 名（可分号分隔多个）
   * @returns 计数（缺失返回 0；非数值取值按「出现即 1」计）
   */
  private _tokenStatValue(
    args: { extraBattleInfo?: Record<string, unknown> },
    token?: string,
  ): number {
    const names = String(token ?? "").split(";").filter(Boolean);
    if (names.length === 0) return 0;
    let sum = 0;
    const info = args?.extraBattleInfo ?? {};
    for (const n of names) {
      const raw = info[n];
      if (raw === undefined || raw === null) continue;
      const num = Number(raw);
      sum += Number.isFinite(num) ? num : 1;
    }
    return sum;
  }

  /**
   * 通关关卡（代币下限）
   *
   * 通关时场内置放/使用代币数不低于 param[1] 即 +1，达 param[0] 完成。
   * （注：数据实参布局为 [completeState, stageId, token, 目标场次]，见下方实现）
   */
  PassStageWithSimpleTokenCountMore(args: PassStageStats, mode: string = "update") {
    // 修复（2026-09-09）：同 TokenCountLess——按 [completeState, stageId, token, 目标场次] 解析
    const funcs = {
      init: () => this.val[0].push(0, parseInt(this.param[3] ?? "1") || 1),
      update: (args: PassStageStats) => {
        if (args?.stageId !== this.param[1]) return;
        if ((args?.completeState ?? 0) < parseInt(this.param[0] || "2")) return;
        if (this._tokenStatValue(args, this.param[2]) < 1) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约V2 — 维度总分
   *
   * 每次单局得分 score 累加，达 param[0] 完成。
   * @param param[0] 目标总分
   */
  CrisisV2DimScoreTotal(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 主测试地关卡, 维度表(0;1;..;5), 目标总分]（如
    // medal_activity_5crisisv2_02 = [..."level_crisis_v2_05-01","0;1;2;3;4;5","300"]）
    // 官服存档实证：_02/_03/_035（300/600/620 三档）val 均为 [[1,1]] → **目标恒为 1**，
    // param[3] 为「总分达到 N 分」的门槛；args.score 由 battleFinish 传单局各维之和。
    const target = 1;
    const need = this._paramNum(3);
    const wantMap = String(this.param?.[1] ?? "").replace(/^level_/, "");
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { seasonId?: string; mapId?: string; score?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        if (wantMap && args.mapId && args.mapId !== wantMap) return;
        if ((args.score ?? 0) >= need) this.val[0][0] = 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约V2 — 通关指定节点
   *
   * 每次通关节点 +1，达 param[0] 完成。
   * @param param[0] 目标节点数
   */
  CrisisV2NodeSome(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 节点 id 列表(分号), 目标节点数]（节点 id 形如
    // "crisis_v2_05-01^pack_1" / "crisis_v2_03-03_b^keypoint_1"）
    const target = this._paramNum(2);
    const wantNodes = this._paramList(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { seasonId?: string; nodeIds?: string[] }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        if (!wantNodes.length) {
          this.val[0][0] = Math.max(this.val[0][0], (args.nodeIds ?? []).length);
          return;
        }
        // 事件载荷是**本次战斗后赛季内已完成节点的全集**（非增量）——取交集计数并取 max，
        // 幂等：重复作战、乱序完成、读档后补发都不会多计。
        const done = new Set(args.nodeIds ?? []);
        let hit = 0;
        for (const id of wantNodes) if (done.has(id)) hit++;
        this.val[0][0] = Math.max(this.val[0][0], hit);
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约V2 — 指定维度达成得分
   *
   * 追踪在指定维度达成得分的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标得分
   */
  CrisisV2DimScoreSome(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 地图 id, 维度表, 目标分]（官服文案「任意一项分数历史最高达到N分」）
    // 官服存档实证：_09 val [[1,1]] → 目标恒为 1，param[3] 为门槛；
    // args.score 由 battleFinish 传「历史最高维度分」（含既有记录）。
    const target = 1;
    const need = this._paramNum(3);
    const wantMap = String(this.param?.[1] ?? "").replace(/^level_/, "");
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { seasonId?: string; mapId?: string; score?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        if (wantMap && args.mapId && args.mapId !== wantMap) return;
        if ((args.score ?? 0) >= need) this.val[0][0] = 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约V2 — 使用助战
   *
   * 追踪携带助战通关危机合约V2的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  CrisisV2UseAssist(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 目标场次]（官服文案「使用助战并通关任意作战不小于5次」）
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 携带助战通关次数（battleFinish 按是否用助战发 used）
      update: (args: { seasonId?: string; used?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        this.val[0][0] += args.used ?? 0;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关首领讨伐（BossRush）
   *
   * 追踪通关首领讨伐玩法的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标进度
   */
  PassStageWithBossRush(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[2]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(2);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（击杀数上限）
   *
   * 追踪通关时击杀数不超过阈值的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithSimpleCountLess(args: PassStageStats, mode: string = "update") {
    // 修复（2026-09-09）：原为「注册后天数」占位实现；数据实参为
    // [completeState, stageId, 敌人 id, 计数器类型, 目标场次]，语义＝通关且该计数器**未触发**。
    const funcs = {
      init: () => this.val[0].push(0, parseInt(this.param[4] ?? "1") || 1),
      update: (args: PassStageStats) => {
        if (args?.stageId !== this.param[1]) return;
        if ((args?.completeState ?? 0) < parseInt(this.param[0] || "2")) return;
        if (this._enemyStatValue(args, this.param[2], this.param[3]) > 0) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 累计代币获得数量勋章模板
   * 累计获得 param[3]（分号分隔的活动材料 id 列表）中指定材料达 param[2] 数量
   *（act53side medal_activity_53side_10/105）。事件 TotalSimpleTokenCount:[{itemId,count}]
   * 由 inventory items:get 处对获得的每个物品发射。
   */
  TotalSimpleTokenCount(args: { itemId: string; count: number }, mode: string = "update") {
    const funcs = {
      init: (_args: {}) => this.val[0].push(0, parseInt(this.param[2])),
      update: (args: { itemId: string; count: number }) => {
        if (typeof args?.itemId !== "string") return;
        const ids = String(this.param[3] ?? "").split(";");
        if (!ids.includes(args.itemId)) return;
        this.val[0][0] += args.count ?? 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（代币达最大值）
   *
   * 追踪单局代币数达到最大值（满场）的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithSimpleTokenCountMax(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act29side）— 每日调查 NPC
   *
   * 追踪参与活动每日调查 NPC 的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标调查数
   */
  Act29SideInvestigateDailyNPC(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 多关卡累计代币数（下限）
   *
   * 追踪在多个指定关卡累计获得代币数。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标代币总数
   */
  SimpleTokenCountMoreInManyStages(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act29side）— 合成旋律
   *
   * 追踪合成活动旋律的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标合成数
   */
  Act29SideSyncthesizeMelody(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act42d0）— 解锁区域
   *
   * 追踪解锁活动区域的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标区域数
   */
  Act42D0UnlockArea(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act42d0）— 携带助战通关
   *
   * 追踪使用助战通关活动关卡的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  Act42D0UseAssistPassStage(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act42d0）— 完成挑战
   *
   * 追踪完成活动挑战的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标挑战数
   */
  Act42D0FinishChallenge(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（陷阱存活数上限）
   *
   * 追踪通关时陷阱载体/装置存活数不超过阈值的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithTrapSurvivedLess(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act38d1）— 维度总分
   *
   * 追踪活动危机维度累计分。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标总分
   */
  ActivityAct38d1DimScoreTotal(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act38d1）— 指定维度达成得分
   *
   * 追踪在指定活动维度达成得分的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标得分
   */
  ActivityAct38d1DimScoreSome(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act38d1）— 解锁指定节点
   *
   * 追踪解锁活动节点的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标节点数
   */
  ActivityAct38d1UnlockNodeSome(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act38d1）— 使用助战
   *
   * 追踪使用助战通关活动关卡的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  ActivityAct38d1UseAssist(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关剧情关卡（story 关卡）
   *
   * 追踪通关指定剧情关卡的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标关卡数
   */
  PassStoryStageSome(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act25side）— 完成简单事件至少
   *
   * 追踪完成活动简单事件达指定次数。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标事件数
   */
  Act25SideSimpleEventAtLeast(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act25side）— 完成调查
   *
   * 追踪完成活动调查任务的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标调查数
   */
  Act25SideFinInvestigation(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约 — 指定关卡达成得分
   *
   * 追踪危机合约关卡达成指定得分的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标关卡数
   */
  CrisisStageScoreSome(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 常驻行动地点（可为分号列表）, 评价档, 所需危机等级]
    // 官服存档实证（data/user/databases/1.json，导入的官服档）：
    //   medal_activity_11d5_02 param=[...,"level_rune_04-01","1","8"] → val [[1,1]]（已得）
    //   medal_activity_10d0_03 param=[...,"1","16"] → val [[0,1]]（未得）
    // 即**目标恒为 1**（达成标志），param[2] = 达成时写入的进度值（1 = S 评价），
    // param[3] = 所需危机等级门槛。故进度 = 「该关卡危机等级 ≥ 门槛」→ param[2]。
    const target = 1;
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { seasonId?: string; stageId?: string; score?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        const stages = this._paramList(1);
        if (stages.length && args.stageId && !stages.includes(args.stageId)) return;
        const need = this._paramNum(3);
        const rated = this._paramNum(2) || 1;
        if ((args.score ?? 0) >= need) {
          this.val[0][0] = Math.max(this.val[0][0], rated);
        }
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约 — 临时派遣结算
   *
   * 追踪危机合约临时派遣结算的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标结算数
   */
  CrisisTempClearSome(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 轮替任务组列表(rg1;..;rg13), 目标天数]
    const target = this._paramNum(2);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 完成并领取全部轮替挑战任务的天数（每日 +1）
      update: (args: { seasonId?: string; count?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        this.val[0][0] += args.count ?? 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约 — 完成任务
   *
   * 追踪危机合约任务完成进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标任务数
   */
  CrisisTaskSome(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 常驻任务 id 列表(normalTask_1;..), 目标任务数]
    const target = this._paramNum(2);
    const wantTasks = this._paramList(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 完成并领取挑战任务数（challengeRewardTask 首次领取 +1）
      update: (args: { seasonId?: string; taskId?: string; count?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        if (args.taskId && wantTasks.length && !wantTasks.includes(args.taskId)) return;
        this.val[0][0] += args.count ?? 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约 — 解锁永久词条（Rune）
   *
   * 追踪危机合约永久词条解锁进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标词条数
   */
  CrisisUnlockPermRuneSome(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 3 级词条 id 列表, 目标词条数]（官服文案「解锁4个3级合约」）
    const target = this._paramNum(2);
    const wantRunes = this._paramList(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 解锁永久词条数（unlockRune 首次解锁 +1）
      update: (args: { seasonId?: string; runeId?: string; count?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        if (args.runeId && wantRunes.length && !wantRunes.includes(args.runeId)) return;
        this.val[0][0] += args.count ?? 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约 — 使用助战
   *
   * 追踪危机合约携带助战通关的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  CrisisUseAssist(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 目标场次]（官服文案「使用助战并通关任意行动地点不小于5次」）
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 携带助战通关次数（battleFinish 按是否用助战发 used）
      update: (args: { seasonId?: string; used?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        this.val[0][0] += args.used ?? 0;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（击杀与存活条件）
   *
   * 追踪同时满足击杀与存活条件的通关场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithKillSurvive(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（陷阱存活）
   *
   * 追踪通关时指定陷阱存活数量的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标陷阱数
   */
  PassStageWithTrapSurvived(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（残留实体）
   *
   * 追踪通关时关卡残留实体数量的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标残留数
   */
  PassStageWithReedResidue(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动点赞歌剧评论
   *
   * 追踪为活动歌剧评论点赞的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标点赞数
   */
  ActivityLikeOperaComment(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动完成角色卡任务
   *
   * 追踪完成活动角色卡任务的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标任务数
   */
  ActivityFinishCharCardTask(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（西西里）— 解锁区域
   *
   * 追踪解锁活动（西西里语地区）区域的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标区域数
   */
  ActivityUnlockSiracusaArea(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 获取载具配件
   *
   * 追踪获取载具配件的累计进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标配件数
   */
  GainCarAccessories(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关且击杀指定敌人（PassStageKilled）
   *
   * 修复（2026-09-09）：原为「注册后天数」占位实现。数据实参为
   * [completeState, stageId(可分号多个), 敌人 id(;), 需要击杀数（缺省 1）]：
   * 通关且该敌人击杀数达标即计 1 场，累计 1 场完成。
   * 事件 PassStageKilled:[{stageId, completeState, enemyStats}] 由 battle 结算发射。
   */
  PassStageKilled(args: PassStageStats, mode: string = "update") {
    const funcs = {
      init: () => this.val[0].push(0, 1),
      update: (args: PassStageStats) => {
        const stages = String(this.param[1] ?? "").split(";").filter(Boolean);
        if (stages.length && !stages.includes(args?.stageId)) return;
        if ((args?.completeState ?? 0) < parseInt(this.param[0] || "2")) return;
        const need = parseInt(this.param[3] ?? "1") || 1;
        if (this._enemyStatValue(args, this.param[2]) < need) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关且未击杀（击杀数不超阈值）指定敌人（PassStageKilledLess）
   *
   * 修复（2026-09-09）：原为「注册后天数」占位实现。数据实参为
   * [completeState, stageId, 敌人 id(;), 允许击杀上限（缺省 0）]：通关且击杀数不超过上限即计 1 场。
   */
  PassStageKilledLess(args: PassStageStats, mode: string = "update") {
    const funcs = {
      init: () => this.val[0].push(0, 1),
      update: (args: PassStageStats) => {
        const stages = String(this.param[1] ?? "").split(";").filter(Boolean);
        if (stages.length && !stages.includes(args?.stageId)) return;
        if ((args?.completeState ?? 0) < parseInt(this.param[0] || "2")) return;
        const limit = parseInt(this.param[3] ?? "0") || 0;
        if (this._enemyStatValue(args, this.param[2]) > limit) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动科技树激活
   *
   * 追踪激活活动科技树科技的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标科技数
   */
  ActivityTechTreeActive(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动宝藏获得
   *
   * 追踪获得活动宝藏的累计进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标宝藏数
   */
  ActivityTreasureGain(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（携带科技树）
   *
   * 追踪携带指定科技通关的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithTechTree(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（场上敌人上限）
   *
   * 追踪通关时场上活跃敌人数不超过阈值的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithEnemyActiveLess(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（至少达成）
   *
   * 追踪通关时达成指定条件的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithAtLeast(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动消耗日程（Agenda）
   *
   * 追踪活动日程资源消耗量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标消耗量
   */
  ActivityCostAgenda(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动达到声望等级
   *
   * 追踪达到活动声望等级的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标声望等级
   */
  ActivityReachPrestigeLevel(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动里程碑奖励
   *
   * 追踪领取活动里程碑奖励的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标奖励数
   */
  ActivityMilestoneReward(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 饰物（Charm）解锁
   *
   * 追踪解锁饰物格位/词条的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标解锁数
   */
  CharmUnlock(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动饰物回收奖励
   *
   * 追踪活动饰物回收获得奖励的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标奖励数
   */
  ActivityCharmRecycleReward(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（活跃装置总数）
   *
   * 追踪通关时活跃装置/载具总数的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标总数
   */
  PassStageWithActiveTotal(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（活跃装置上限）
   *
   * 追踪通关时活跃装置/载具数不超过阈值的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithActiveLess(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（阵亡数上限）
   *
   * 追踪通关时阵亡单位数不超过阈值的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithDeadInLess(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（太极拳）持有
   *
   * 追踪活动（太极拳）累计持有量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标持有量
   */
  ActivityHoldTaichi(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（低部署）
   *
   * 追踪通关时部署干员数不超过阈值的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithLessDeploy(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关首领关卡（不破盾）
   *
   * 追踪未破除首领护盾即通关的场次。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithoutBossShield(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动监禁总数（Confinement）
   *
   * 追踪活动监禁/囚禁总数的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标总数
   */
  ActivityConfinementTotal(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动累计击杀总数
   *
   * 追踪活动累计击杀敌人的总数。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标击杀总数
   */
  ActivityKilledTotal(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动阅读新闻
   *
   * 追踪阅读活动新闻的数量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标新闻数
   */
  ActivityCasimirReadNews(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动砍树（资源采集）
   *
   * 追踪砍伐活动树木（资源）的总量。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标采伐量
   */
  ActivityCutTree(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（砍树）
   *
   * 追踪通关时砍伐树木数量的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithCutTree(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 通关关卡（塔/建筑）
   *
   * 追踪通关时使用/留存塔类装置的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标场次
   */
  PassStageWithTower(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动沙盒创建物品
   *
   * 追踪在沙盒玩法中创建物品的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标物品数
   */
  ActivitySandboxCreateItem(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动沙盒达成结局
   *
   * 追踪在沙盒玩法中达成结局的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标结局数
   */
  ActivitySandboxAchieveEnding(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 解锁剧情组（章节）
   *
   * 追踪解锁剧情章节组的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标章节数
   */
  UnlockStoryGroup(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 潜能溢出（满潜后再获得）
   *
   * 追踪干员潜能溢出材料的获取进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标溢出数
   */
  FullPotentialOverflow(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: (args: { registerTs: number }) => {
        this.val[0][0] = moment().diff(moment(args.registerTs), "days");
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约 — 指定时限前达成得分
   *
   * 追踪在指定时间前达成危机合约关卡得分的进度。目标为 param[0]。
   * 注：当前为占位实现（未接入玩法真实状态）。
   * @param param[0] 目标关卡数
   */
  CrisisStageScoreBeforeTime(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 常驻行动地点关卡, 所需危机等级, 截止时间戳]
    // 官服存档实证：medal_activity_10d0_035 param=[..."level_rune_03-01","18","1591646399"]
    // → val [[0,1]]；medal_activity_10rune_035 → val [[1,1]]。目标同样恒为 1，
    // param[2] = 所需危机等级门槛，param[3] = 截止时间（官服：「且在XX行动开始一周内完成」）。
    const target = 1;
    const deadline = this._paramNum(3);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { seasonId?: string; stageId?: string; score?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        const wantStage = String(this.param?.[1] ?? "");
        if (wantStage && args.stageId && args.stageId !== wantStage) return;
        // 超过截止时间不再计入 —— 限时勋章错过窗口本就不可得，不做宽容处理
        if (deadline < Number.MAX_SAFE_INTEGER && now() > deadline) return;
        if ((args.score ?? 0) >= this._paramNum(2)) this.val[0][0] = 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act1 街机）— 收集全部徽章
   *
   * 每次获得街机徽章 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标徽章数
   */
  Act1ArcadeCollectAllBadge(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act1 足球）— 得分
   *
   * 每次获得足球活动得分 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标得分
   */
  Act1FootballScores(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act1 挂机）— 升级干员
   *
   * 每次升级干员 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标升级数
   */
  Act1HalfidleUpgradeChar(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act38side）— 完成拼图
   *
   * 每次完成拼图 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标拼图数
   */
  Act38SideCompletePuzzle(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act42side）— 解锁枪支
   *
   * 每次解锁枪支 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标解锁枪数
   */
  Act42sideUnlockGunCnt(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动（act46side）— 通过大富翁关卡
   *
   * 每次通过大富翁关卡 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标关卡数
   */
  Act46sidePassMonopolyStage(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（MultiV3）— 提交相册
   *
   * 每次提交相册 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标提交数
   */
  ActMultiV3CommitAlbum(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（MultiV3）— 完成简单事件
   *
   * 每次完成简单事件 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标事件数
   */
  ActMultiV3CompleteSimpleEvent(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（MultiV3）— 防守波次
   *
   * 每次完成防守波次 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标波次数
   */
  ActMultiV3DefenceWave(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（MultiV3）— 足球进球
   *
   * 每次进球 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标进球数
   */
  ActMultiV3FootballGoal(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（MultiV3）— 获得头衔
   *
   * 每次获得头衔 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标头衔数
   */
  ActMultiV3GainTitle(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（MultiV3）— 关卡防守承伤
   *
   * 每次达成防守承伤条件 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标承伤值
   */
  ActMultiV3StageDefenceDamage(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（MultiV3）— 关卡星级
   *
   * 每次达成指定关卡星级 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标星级数
   */
  ActMultiV3StageStar(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 联合行动（MultiV3）— 总星级
   *
   * 每次累计星级 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标总星级
   */
  ActMultiV3TotalStar(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 破碎维度（VecBreak V2）— 关卡简单事件
   *
   * 每次完成关卡简单事件 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标事件数
   */
  ActVecBreakV2LevelSimpleEventAtLeast(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 破碎维度（VecBreak V2）— 时限前过关
   *
   * 每次在指定时间前过关 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标关卡数
   */
  ActVecBreakV2PassStageBeforeTime(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 破碎维度（VecBreak V2）— 过关注击杀敌人
   *
   * 每次达成指定击杀即 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标击杀数
   */
  ActVecBreakV2PassStageWithEnemyKilled(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 破碎维度（VecBreak V2）— 过关注使用技能
   *
   * 每次达成指定技能使用即 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标技能使用数
   */
  ActVecBreakV2PassStageWithSkillUsed(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 破碎维度（VecBreak V2）— 完成简单事件
   *
   * 每次完成简单事件 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标事件数
   */
  ActVecBreakV2SimpleEventAtLeast(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 自动棋（AutoChess）— 乐带徽章数
   *
   * 每次获得乐带徽章 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标徽章数
   */
  ActivityAutoChessBandBadgeCount(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 自动棋（AutoChess）— 干员棋升级
   *
   * 每次升级干员棋 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标升级数
   */
  ActivityAutoChessCharChessUpgrade(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 自动棋（AutoChess）— 通过对局
   *
   * 每次通过对局 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标对局数
   */
  ActivityAutoChessPassGame(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam[0] 是主题/活动 id，数值目标在 param[1]
    //（官服存档 val[0][1] 反推，见 docs/prts-wiki-实现评估-2026-09-09.md Round 32）。
    // 原实现取 parseInt(param[0]) → NaN → 该章永不可得。
    const target = this._paramNum(1);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 自动棋（AutoChess）— 累计乐带通关
   *
   * 每次累计乐带通关 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标通关数
   */
  ActivityAutoChessPassWithBandAccumulative(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 自动棋（AutoChess）— 累计羁绊通关
   *
   * 每次累计羁绊通关 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标通关数
   */
  ActivityAutoChessPassWithBondAccumulative(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 战斗治疗量
   *
   * 每次达成累计治疗量 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标治疗量
   */
  ActivityBattleHeal(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 活动对决排行榜名次
   *
   * 每次达成指定对决名次 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标任务次数
   */
  ActivityEnemyDuelRank(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 特勤干员精英化阶段达成（电弧 / 机械师）
   *
   * 修复（2026-09-09，审计 §5.3）：本模板原先取 `parseInt(param[0])` 作目标，而真实数据
   * `unlockParam = ["char_4195_radian","2"]` / `["char_4230_mcnist","2"]` —— `param[0]` 是
   * **干员 id**（parseInt → NaN，目标位落盘为 null → 该章永不可得），`param[1]` 才是要求的
   * 精英化阶段。现按「指定干员达到指定精英化阶段即获得（目标恒为 1）」实现，并在
   * `CharManager.evolveChar` / `evolveCharUseItem` 派发 `CharEvolvePhase`。
   * @param param[0] 目标干员 charId（如 char_4195_radian）
   * @param param[1] 要求的精英化阶段（如 2 = 精二）
   */
  CharEvolvePhase(args: {}, mode: string = "update") {
    const targetCharId = String(this.param?.[0] ?? "");
    const needPhase = this._paramNum(1);
    const funcs = {
      // 目标恒为 1：该干员达成该阶段即完成（数据表未给出次数目标）
      init: () => this.val[0].push(0, 1),
      update: (args: { charId?: string; phase?: number }) => {
        if (!targetCharId) return;
        if (args?.charId !== targetCharId) return;
        if (Number(args?.phase ?? 0) < needPhase) return;
        this.val[0][0] = 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 获得六星小组积分
   *
   * 每次获得六星小组积分 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标积分
   */
  GainSixStarGroupPoint(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 危机合约（Recal）— 关卡得分
   *
   * 每次达成关卡得分 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标得分
   */
  RecalRuneStageScoreSome(args: {}, mode: string = "update") {
    // unlockParam: [赛季, 关卡, 目标评分]（["recalRune_season_2","level_recalrune_02-01","8"]）
    // 官服存档中无重构符文勋章样本可实证；按同名家族（CrisisStageScoreSome*）的官服
    // 形状实现——目标恒为 1、param[2] 为门槛（「获得 8 评分」）。解锁时机与
    // 「峰值 vs 目标」写法一致，仅进度显示为 1/1 而非 8/8。
    const target = 1;
    const need = this._paramNum(2);
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      update: (args: { seasonId?: string; stageId?: string; score?: number }) => {
        if (!this._seasonMatch(args.seasonId)) return;
        const wantStage = String(this.param?.[1] ?? "");
        if (wantStage && args.stageId && args.stageId !== wantStage) return;
        if ((args.score ?? 0) >= need) this.val[0][0] = 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 铜币抽取
   *
   * 每次铜币抽取 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标抽取次数
   */
  Rlv2CopperDraw(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 严格条件通关节点
   *
   * 每次苛刻条件下通关节点 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标节点数
   */
  Rlv2PassNodeStrict(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 通关区域
   *
   * 每次通关区域 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标区域数
   */
  Rlv2PassZone(args: {}, mode: string = "update") {
    // 目标位修复（2026-09-09）：unlockParam = [主题, zoneId, 目标次数]（官服 getMethod
    // 「在集成战略：XX主题中通过 YY 区域 N 次」）。原实现取 parseInt(param[0]) → NaN。
    const target = this._paramNum(2);
    const wantZone = String(this.param?.[1] ?? "");
    const funcs = {
      init: (args: {}) => this.val[0].push(0, target),
      // 事件由 roguelike event.ts 在进入新区域时发射
      update: (args: { theme?: string; zoneId?: string }) => {
        if (!this._seasonMatch(args.theme)) return;
        if (wantZone && args.zoneId && args.zoneId !== wantZone) return;
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 肉鸽（Roguelike）— 进入特殊区域
   *
   * 每次进入特殊区域 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标区域数
   */
  Rlv2SpecialZoneEnter(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 升级基地
   *
   * 每次升级基地 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标基地等级
   */
  Sbv3BaseUpgrade(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 战斗任务数
   *
   * 每次完成战斗任务 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标任务数
   */
  Sbv3BattleTaskCount(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 清理障碍
   *
   * 每次清理障碍 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标清理数
   */
  Sbv3ClearDebris(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 部署建筑
   *
   * 每次部署建筑 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标部署数
   */
  Sbv3DeployBuilding(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 地牢击杀敌人类型
   *
   * 每次击杀指定类型敌人 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标任务次数
   */
  Sbv3DungeonKillEnemyType(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 电力得分
   *
   * 每次获得电力得分 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标电力分
   */
  Sbv3ElectricScore(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 解锁菜谱
   *
   * 每次解锁菜谱 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标菜谱数
   */
  Sbv3GainCookbook(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 通过地牢
   *
   * 每次通过地牢 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标地牢数
   */
  Sbv3PassDungeon(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 完成任务
   *
   * 每次完成任务 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标任务数
   */
  Sbv3QuestFinish(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 生息演算（Sbv3）— 解锁科技
   *
   * 每次解锁科技 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标科技数
   */
  Sbv3TechUnlock(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * 累计签到次数
   *
   * 每次签到 +1，达 param[0] 完成（未接入玩法真实状态）。
   * @param param[0] 目标签到次数
   */
  TotalCheckinCount(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * ActivityArkhubPixelCollect勋章模板（巡展印象奖章）
   * 奇象巡展期间收集画像（unlockParam=[act1arkhub, 0, 4] → target=param[2]）。
   * 事件参数 {activityId, count}：count=ARK_HUB.pixelCollected 累计收集数。
   */
  ActivityArkhubPixelCollect(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[2])),
      update: (args: { activityId: string; count: number }) => {
        if (args.activityId !== this.param[0]) return;
        this.val[0][0] = Math.max(
          this.val[0][0],
          Math.min(args.count ?? 0, this.val[0][1]),
        );
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * ActivityArkhubCreatureCollect勋章模板（巡展珍奇奖章）
   * 收录 N 种奇象生物数据（unlockParam=[act1arkhub, arkhubMissionCollection1, 10]
   * → target=param[2]）。事件 {activityId, count, collectionKey}：count=已收录种类数。
   */
  ActivityArkhubCreatureCollect(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[2])),
      update: (args: { activityId: string; count: number }) => {
        if (args.activityId !== this.param[0]) return;
        this.val[0][0] = Math.max(
          this.val[0][0],
          Math.min(args.count ?? 0, this.val[0][1]),
        );
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * ActivityArkhubAlterCollect勋章模板（巡展珍奇奖章·镀层）
   * 收录 N 种 + 至少 1 只亚种（unlockParam=[act1arkhub, arkhubMissionCollection1, 10, 1]
   * → target=param[2]、亚种要求=param[3]）。事件 {activityId, count, alterCount}：
   * 仅当 alterCount >= param[3] 时进度才随 count 推进（镀层条件缺一不可）。
   */
  ActivityArkhubAlterCollect(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[2])),
      update: (args: { activityId: string; count: number; alterCount: number }) => {
        if (args.activityId !== this.param[0]) return;
        const needAlter = parseInt(this.param[3] ?? "0");
        if ((args.alterCount ?? 0) < needAlter) return;
        this.val[0][0] = Math.max(
          this.val[0][0],
          Math.min(args.count ?? 0, this.val[0][1]),
        );
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * ArkodcVarSeqAtLeast勋章模板
   * arkodc 主题变量序列(param[1]，如 bool_all_unlocked)达到 param[2] 值达成
   *（act53side medal_activity_53side_05）。事件 ArkodcVarSeqAtLeast:[{activityId, varSeqs}]
   * 由 arkodc 状态更新处发射，模板读 varSeqs[param[1]] 作为进度。
   */
  ArkodcVarSeqAtLeast(args: { activityId: string; varSeqs: Record<string, number> }, mode: string = "update") {
    const funcs = {
      init: (_args: {}) => this.val[0].push(0, parseInt(this.param[2])),
      update: (args: { activityId: string; varSeqs: Record<string, number> }) => {
        if (args.activityId !== this.param[0]) return;
        this.val[0][0] = Math.max(
          this.val[0][0],
          Math.min(args.varSeqs?.[this.param[1]] ?? 0, this.val[0][1]),
        );
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * Rlv2KillWeather勋章模板
   * 肉鸽中击杀天气敌人（target=param[0]；等待 rlv2 KillWeather 事件驱动）
   */
  Rlv2KillWeather(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  /**
   * Rlv2MoveByScrap勋章模板
   * 肉鸽废品玩法中移动/推进（target=param[0]；等待 rlv2 scrap move 事件驱动）
   */
  Rlv2MoveByScrap(args: {}, mode: string = "update") {
    const funcs = {
      init: (args: {}) => this.val[0].push(0, parseInt(this.param[0])),
      update: () => {
        this.val[0][0] += 1;
      },
    };
    dispatch(mode, funcs.init, funcs.update, args);
  }

  toJSON(): PlayerPerMedal {
    return {
      id: this.id,
      val: this.val,
      fts: this.fts,
      rts: this.rts,
      ...(this.reward ? { reward: this.reward } : {}),
    };
  }
}

/* ---------------------------------------------------------------------------
 * 模板派发与处理函数表
 *
 * MedalProgress 的每个模板方法形如 `X(args, mode)`：init 分支构建进度结构、
 * update 分支按事件载荷推进。两个分支载荷类型不同，旧实现靠一个宽化的
 * 索引签名表（`{ [key: string]: (args) => void }`）+ `funcs[mode](args)` 兜底；
 * 现改为显式分支派发（dispatch）+ 显式「模板名 → 处理函数」表，消除模糊类型。
 * ------------------------------------------------------------------------- */

/**
 * 按 init/update 显式分支派发模板载荷
 *
 * 保持旧语义：mode 既非 init 也非 update 时抛 TypeError——旧实现 `funcs[mode]`
 * 为 undefined，调用即抛 TypeError；这里显式抛出同类错误。
 *
 * @param mode - 调用模式（"init" | "update"）
 * @param initFn - 构建进度结构的分支
 * @param updateFn - 推进进度的分支
 * @param args - 载荷（init 传 `{}`，update 传事件载荷元组首元素）
 */
function dispatch<TInit, TUpdate>(
  mode: string,
  initFn: (args: TInit) => void,
  updateFn: (args: TUpdate) => void,
  args: TInit | TUpdate,
): void {
  if (mode === "init") {
    initFn(args as TInit);
  } else if (mode === "update") {
    updateFn(args as TUpdate);
  } else {
    throw new TypeError(`funcs[${mode}] is not a function`);
  }
}

/**
 * 模板处理函数
 *
 * payload 取 never：模板名运行时才确定，具体载荷类型由各模板方法的形参约束，
 * 表中转发无需逐项断言。
 */
type MedalTemplateHandler = (
  progress: MedalProgress,
  payload: never,
  mode: string,
) => void;

/**
 * 模板名 → 处理函数表
 *
 * 键为 excel MedalTable 的 `template` 字段取值，也是事件总线上的订阅名。
 * 表覆盖全部已实现模板（含暂无 emit 侧的历史模板）；查不到即未实现 →
 * init() 走 `this.val = [[0, 0]]` 降级分支（与原 `template in this` 等价）。
 */
const MedalTemplateHandlers: Record<string, MedalTemplateHandler> = {
  PlayerLevel: (p, payload, mode) => p.PlayerLevel(payload, mode),
  JoinGameDays: (p, payload, mode) => p.JoinGameDays(payload, mode),
  CharNum: (p, payload, mode) => p.CharNum(payload, mode),
  RecruitCount: (p, payload, mode) => p.RecruitCount(payload, mode),
  PassStageSome: (p, payload, mode) => p.PassStageSome(payload, mode),
  CampaignsDiamondLimit: (p, payload, mode) => p.CampaignsDiamondLimit(payload, mode),
  CampaignsComplete: (p, payload, mode) => p.CampaignsComplete(payload, mode),
  PassTower: (p, payload, mode) => p.PassTower(payload, mode),
  CharEvolveCount: (p, payload, mode) => p.CharEvolveCount(payload, mode),
  CharSkillCount: (p, payload, mode) => p.CharSkillCount(payload, mode),
  CharSkillSpecCount: (p, payload, mode) => p.CharSkillSpecCount(payload, mode),
  CharFavorCount: (p, payload, mode) => p.CharFavorCount(payload, mode),
  GotChars: (p, payload, mode) => p.GotChars(payload, mode),
  CharPotential: (p, payload, mode) => p.CharPotential(payload, mode),
  CharStoryUnlock: (p, payload, mode) => p.CharStoryUnlock(payload, mode),
  Sbv2UpgradeBase: (p, payload, mode) => p.Sbv2UpgradeBase(payload, mode),
  Sbv2FinishQuest: (p, payload, mode) => p.Sbv2FinishQuest(payload, mode),
  Sbv2BattleFinishWithChar: (p, payload, mode) => p.Sbv2BattleFinishWithChar(payload, mode),
  Sbv2UnlockCook: (p, payload, mode) => p.Sbv2UnlockCook(payload, mode),
  Sbv2PlaceBuilding: (p, payload, mode) => p.Sbv2PlaceBuilding(payload, mode),
  Sbv2PassRiftLevel: (p, payload, mode) => p.Sbv2PassRiftLevel(payload, mode),
  Sbv2PassRiftCount: (p, payload, mode) => p.Sbv2PassRiftCount(payload, mode),
  Sbv2CatchAnimal: (p, payload, mode) => p.Sbv2CatchAnimal(payload, mode),
  Sbv2UnlockTech: (p, payload, mode) => p.Sbv2UnlockTech(payload, mode),
  Sbv2SurviveDays: (p, payload, mode) => p.Sbv2SurviveDays(payload, mode),
  Sbv2KillBoss: (p, payload, mode) => p.Sbv2KillBoss(payload, mode),
  Rlv2PassNode: (p, payload, mode) => p.Rlv2PassNode(payload, mode),
  Rlv2BpLevel: (p, payload, mode) => p.Rlv2BpLevel(payload, mode),
  PermUpgrade: (p, payload, mode) => p.PermUpgrade(payload, mode),
  UseAlchemy: (p, payload, mode) => p.UseAlchemy(payload, mode),
  Rlv2Recruit: (p, payload, mode) => p.Rlv2Recruit(payload, mode),
  Rlv2GetTeamReward: (p, payload, mode) => p.Rlv2GetTeamReward(payload, mode),
  Rlv2EndingCollect: (p, payload, mode) => p.Rlv2EndingCollect(payload, mode),
  Rlv2CollectRelic: (p, payload, mode) => p.Rlv2CollectRelic(payload, mode),
  Rlv2FinishBattleWithSpecChar: (p, payload, mode) => p.Rlv2FinishBattleWithSpecChar(payload, mode),
  Rlv2EndingWithModeGrade: (p, payload, mode) => p.Rlv2EndingWithModeGrade(payload, mode),
  Rlv2UnlockBand: (p, payload, mode) => p.Rlv2UnlockBand(payload, mode),
  Rlv2TotemResonance: (p, payload, mode) => p.Rlv2TotemResonance(payload, mode),
  Rlv2CompleteNodeMission: (p, payload, mode) => p.Rlv2CompleteNodeMission(payload, mode),
  Rlv2GainCapsule: (p, payload, mode) => p.Rlv2GainCapsule(payload, mode),
  BuildingGotFurnitureThemeCount: (p, payload, mode) => p.BuildingGotFurnitureThemeCount(payload, mode),
  BuildingManufactureProductTimes: (p, payload, mode) => p.BuildingManufactureProductTimes(payload, mode),
  BuildingWorkshopSynthesisGroupByID: (p, payload, mode) => p.BuildingWorkshopSynthesisGroupByID(payload, mode),
  GotCharsBeforeTime: (p, payload, mode) => p.GotCharsBeforeTime(payload, mode),
  ActivityCoinCost: (p, payload, mode) => p.ActivityCoinCost(payload, mode),
  MissionCompleteSome: (p, payload, mode) => p.MissionCompleteSome(payload, mode),
  ActivityPassStageWithSimpleTokenCountMore: (p, payload, mode) => p.ActivityPassStageWithSimpleTokenCountMore(payload, mode),
  Act35SideFinishCarving: (p, payload, mode) => p.Act35SideFinishCarving(payload, mode),
  PassStageWithSimpleCountMore: (p, payload, mode) => p.PassStageWithSimpleCountMore(payload, mode),
  PassStageWithDetailDiffCountMore: (p, payload, mode) => p.PassStageWithDetailDiffCountMore(payload, mode),
  PassStageWithSimpleTokenCountLess: (p, payload, mode) => p.PassStageWithSimpleTokenCountLess(payload, mode),
  PassStageKilledTotal: (p, payload, mode) => p.PassStageKilledTotal(payload, mode),
  ActMultiplayVerify2StageTotalScore: (p, payload, mode) => p.ActMultiplayVerify2StageTotalScore(payload, mode),
  ActMultiplayVerify2PassStageWithScore: (p, payload, mode) => p.ActMultiplayVerify2PassStageWithScore(payload, mode),
  ActivityMilestonePoint: (p, payload, mode) => p.ActivityMilestonePoint(payload, mode),
  GotItemBeforeTime: (p, payload, mode) => p.GotItemBeforeTime(payload, mode),
  PassStageWithSimpleTokenCountMore: (p, payload, mode) => p.PassStageWithSimpleTokenCountMore(payload, mode),
  CrisisV2DimScoreTotal: (p, payload, mode) => p.CrisisV2DimScoreTotal(payload, mode),
  CrisisV2NodeSome: (p, payload, mode) => p.CrisisV2NodeSome(payload, mode),
  CrisisV2DimScoreSome: (p, payload, mode) => p.CrisisV2DimScoreSome(payload, mode),
  CrisisV2UseAssist: (p, payload, mode) => p.CrisisV2UseAssist(payload, mode),
  PassStageWithBossRush: (p, payload, mode) => p.PassStageWithBossRush(payload, mode),
  PassStageWithSimpleCountLess: (p, payload, mode) => p.PassStageWithSimpleCountLess(payload, mode),
  TotalSimpleTokenCount: (p, payload, mode) => p.TotalSimpleTokenCount(payload, mode),
  PassStageWithSimpleTokenCountMax: (p, payload, mode) => p.PassStageWithSimpleTokenCountMax(payload, mode),
  Act29SideInvestigateDailyNPC: (p, payload, mode) => p.Act29SideInvestigateDailyNPC(payload, mode),
  SimpleTokenCountMoreInManyStages: (p, payload, mode) => p.SimpleTokenCountMoreInManyStages(payload, mode),
  Act29SideSyncthesizeMelody: (p, payload, mode) => p.Act29SideSyncthesizeMelody(payload, mode),
  Act42D0UnlockArea: (p, payload, mode) => p.Act42D0UnlockArea(payload, mode),
  Act42D0UseAssistPassStage: (p, payload, mode) => p.Act42D0UseAssistPassStage(payload, mode),
  Act42D0FinishChallenge: (p, payload, mode) => p.Act42D0FinishChallenge(payload, mode),
  PassStageWithTrapSurvivedLess: (p, payload, mode) => p.PassStageWithTrapSurvivedLess(payload, mode),
  ActivityAct38d1DimScoreTotal: (p, payload, mode) => p.ActivityAct38d1DimScoreTotal(payload, mode),
  ActivityAct38d1DimScoreSome: (p, payload, mode) => p.ActivityAct38d1DimScoreSome(payload, mode),
  ActivityAct38d1UnlockNodeSome: (p, payload, mode) => p.ActivityAct38d1UnlockNodeSome(payload, mode),
  ActivityAct38d1UseAssist: (p, payload, mode) => p.ActivityAct38d1UseAssist(payload, mode),
  PassStoryStageSome: (p, payload, mode) => p.PassStoryStageSome(payload, mode),
  Act25SideSimpleEventAtLeast: (p, payload, mode) => p.Act25SideSimpleEventAtLeast(payload, mode),
  Act25SideFinInvestigation: (p, payload, mode) => p.Act25SideFinInvestigation(payload, mode),
  CrisisStageScoreSome: (p, payload, mode) => p.CrisisStageScoreSome(payload, mode),
  CrisisTempClearSome: (p, payload, mode) => p.CrisisTempClearSome(payload, mode),
  CrisisTaskSome: (p, payload, mode) => p.CrisisTaskSome(payload, mode),
  CrisisUnlockPermRuneSome: (p, payload, mode) => p.CrisisUnlockPermRuneSome(payload, mode),
  CrisisUseAssist: (p, payload, mode) => p.CrisisUseAssist(payload, mode),
  PassStageWithKillSurvive: (p, payload, mode) => p.PassStageWithKillSurvive(payload, mode),
  PassStageWithTrapSurvived: (p, payload, mode) => p.PassStageWithTrapSurvived(payload, mode),
  PassStageWithReedResidue: (p, payload, mode) => p.PassStageWithReedResidue(payload, mode),
  ActivityLikeOperaComment: (p, payload, mode) => p.ActivityLikeOperaComment(payload, mode),
  ActivityFinishCharCardTask: (p, payload, mode) => p.ActivityFinishCharCardTask(payload, mode),
  ActivityUnlockSiracusaArea: (p, payload, mode) => p.ActivityUnlockSiracusaArea(payload, mode),
  GainCarAccessories: (p, payload, mode) => p.GainCarAccessories(payload, mode),
  PassStageKilled: (p, payload, mode) => p.PassStageKilled(payload, mode),
  PassStageKilledLess: (p, payload, mode) => p.PassStageKilledLess(payload, mode),
  ActivityTechTreeActive: (p, payload, mode) => p.ActivityTechTreeActive(payload, mode),
  ActivityTreasureGain: (p, payload, mode) => p.ActivityTreasureGain(payload, mode),
  PassStageWithTechTree: (p, payload, mode) => p.PassStageWithTechTree(payload, mode),
  PassStageWithEnemyActiveLess: (p, payload, mode) => p.PassStageWithEnemyActiveLess(payload, mode),
  PassStageWithAtLeast: (p, payload, mode) => p.PassStageWithAtLeast(payload, mode),
  ActivityCostAgenda: (p, payload, mode) => p.ActivityCostAgenda(payload, mode),
  ActivityReachPrestigeLevel: (p, payload, mode) => p.ActivityReachPrestigeLevel(payload, mode),
  ActivityMilestoneReward: (p, payload, mode) => p.ActivityMilestoneReward(payload, mode),
  CharmUnlock: (p, payload, mode) => p.CharmUnlock(payload, mode),
  ActivityCharmRecycleReward: (p, payload, mode) => p.ActivityCharmRecycleReward(payload, mode),
  PassStageWithActiveTotal: (p, payload, mode) => p.PassStageWithActiveTotal(payload, mode),
  PassStageWithActiveLess: (p, payload, mode) => p.PassStageWithActiveLess(payload, mode),
  PassStageWithDeadInLess: (p, payload, mode) => p.PassStageWithDeadInLess(payload, mode),
  ActivityHoldTaichi: (p, payload, mode) => p.ActivityHoldTaichi(payload, mode),
  PassStageWithLessDeploy: (p, payload, mode) => p.PassStageWithLessDeploy(payload, mode),
  PassStageWithoutBossShield: (p, payload, mode) => p.PassStageWithoutBossShield(payload, mode),
  ActivityConfinementTotal: (p, payload, mode) => p.ActivityConfinementTotal(payload, mode),
  ActivityKilledTotal: (p, payload, mode) => p.ActivityKilledTotal(payload, mode),
  ActivityCasimirReadNews: (p, payload, mode) => p.ActivityCasimirReadNews(payload, mode),
  ActivityCutTree: (p, payload, mode) => p.ActivityCutTree(payload, mode),
  PassStageWithCutTree: (p, payload, mode) => p.PassStageWithCutTree(payload, mode),
  PassStageWithTower: (p, payload, mode) => p.PassStageWithTower(payload, mode),
  ActivitySandboxCreateItem: (p, payload, mode) => p.ActivitySandboxCreateItem(payload, mode),
  ActivitySandboxAchieveEnding: (p, payload, mode) => p.ActivitySandboxAchieveEnding(payload, mode),
  UnlockStoryGroup: (p, payload, mode) => p.UnlockStoryGroup(payload, mode),
  FullPotentialOverflow: (p, payload, mode) => p.FullPotentialOverflow(payload, mode),
  CrisisStageScoreBeforeTime: (p, payload, mode) => p.CrisisStageScoreBeforeTime(payload, mode),
  Act1ArcadeCollectAllBadge: (p, payload, mode) => p.Act1ArcadeCollectAllBadge(payload, mode),
  Act1FootballScores: (p, payload, mode) => p.Act1FootballScores(payload, mode),
  Act1HalfidleUpgradeChar: (p, payload, mode) => p.Act1HalfidleUpgradeChar(payload, mode),
  Act38SideCompletePuzzle: (p, payload, mode) => p.Act38SideCompletePuzzle(payload, mode),
  Act42sideUnlockGunCnt: (p, payload, mode) => p.Act42sideUnlockGunCnt(payload, mode),
  Act46sidePassMonopolyStage: (p, payload, mode) => p.Act46sidePassMonopolyStage(payload, mode),
  ActMultiV3CommitAlbum: (p, payload, mode) => p.ActMultiV3CommitAlbum(payload, mode),
  ActMultiV3CompleteSimpleEvent: (p, payload, mode) => p.ActMultiV3CompleteSimpleEvent(payload, mode),
  ActMultiV3DefenceWave: (p, payload, mode) => p.ActMultiV3DefenceWave(payload, mode),
  ActMultiV3FootballGoal: (p, payload, mode) => p.ActMultiV3FootballGoal(payload, mode),
  ActMultiV3GainTitle: (p, payload, mode) => p.ActMultiV3GainTitle(payload, mode),
  ActMultiV3StageDefenceDamage: (p, payload, mode) => p.ActMultiV3StageDefenceDamage(payload, mode),
  ActMultiV3StageStar: (p, payload, mode) => p.ActMultiV3StageStar(payload, mode),
  ActMultiV3TotalStar: (p, payload, mode) => p.ActMultiV3TotalStar(payload, mode),
  ActVecBreakV2LevelSimpleEventAtLeast: (p, payload, mode) => p.ActVecBreakV2LevelSimpleEventAtLeast(payload, mode),
  ActVecBreakV2PassStageBeforeTime: (p, payload, mode) => p.ActVecBreakV2PassStageBeforeTime(payload, mode),
  ActVecBreakV2PassStageWithEnemyKilled: (p, payload, mode) => p.ActVecBreakV2PassStageWithEnemyKilled(payload, mode),
  ActVecBreakV2PassStageWithSkillUsed: (p, payload, mode) => p.ActVecBreakV2PassStageWithSkillUsed(payload, mode),
  ActVecBreakV2SimpleEventAtLeast: (p, payload, mode) => p.ActVecBreakV2SimpleEventAtLeast(payload, mode),
  ActivityAutoChessBandBadgeCount: (p, payload, mode) => p.ActivityAutoChessBandBadgeCount(payload, mode),
  ActivityAutoChessCharChessUpgrade: (p, payload, mode) => p.ActivityAutoChessCharChessUpgrade(payload, mode),
  ActivityAutoChessPassGame: (p, payload, mode) => p.ActivityAutoChessPassGame(payload, mode),
  ActivityAutoChessPassWithBandAccumulative: (p, payload, mode) => p.ActivityAutoChessPassWithBandAccumulative(payload, mode),
  ActivityAutoChessPassWithBondAccumulative: (p, payload, mode) => p.ActivityAutoChessPassWithBondAccumulative(payload, mode),
  ActivityBattleHeal: (p, payload, mode) => p.ActivityBattleHeal(payload, mode),
  ActivityEnemyDuelRank: (p, payload, mode) => p.ActivityEnemyDuelRank(payload, mode),
  CharEvolvePhase: (p, payload, mode) => p.CharEvolvePhase(payload, mode),
  GainSixStarGroupPoint: (p, payload, mode) => p.GainSixStarGroupPoint(payload, mode),
  RecalRuneStageScoreSome: (p, payload, mode) => p.RecalRuneStageScoreSome(payload, mode),
  Rlv2CopperDraw: (p, payload, mode) => p.Rlv2CopperDraw(payload, mode),
  Rlv2PassNodeStrict: (p, payload, mode) => p.Rlv2PassNodeStrict(payload, mode),
  Rlv2PassZone: (p, payload, mode) => p.Rlv2PassZone(payload, mode),
  Rlv2SpecialZoneEnter: (p, payload, mode) => p.Rlv2SpecialZoneEnter(payload, mode),
  Sbv3BaseUpgrade: (p, payload, mode) => p.Sbv3BaseUpgrade(payload, mode),
  Sbv3BattleTaskCount: (p, payload, mode) => p.Sbv3BattleTaskCount(payload, mode),
  Sbv3ClearDebris: (p, payload, mode) => p.Sbv3ClearDebris(payload, mode),
  Sbv3DeployBuilding: (p, payload, mode) => p.Sbv3DeployBuilding(payload, mode),
  Sbv3DungeonKillEnemyType: (p, payload, mode) => p.Sbv3DungeonKillEnemyType(payload, mode),
  Sbv3ElectricScore: (p, payload, mode) => p.Sbv3ElectricScore(payload, mode),
  Sbv3GainCookbook: (p, payload, mode) => p.Sbv3GainCookbook(payload, mode),
  Sbv3PassDungeon: (p, payload, mode) => p.Sbv3PassDungeon(payload, mode),
  Sbv3QuestFinish: (p, payload, mode) => p.Sbv3QuestFinish(payload, mode),
  Sbv3TechUnlock: (p, payload, mode) => p.Sbv3TechUnlock(payload, mode),
  TotalCheckinCount: (p, payload, mode) => p.TotalCheckinCount(payload, mode),
  ActivityArkhubPixelCollect: (p, payload, mode) => p.ActivityArkhubPixelCollect(payload, mode),
  ActivityArkhubCreatureCollect: (p, payload, mode) => p.ActivityArkhubCreatureCollect(payload, mode),
  ActivityArkhubAlterCollect: (p, payload, mode) => p.ActivityArkhubAlterCollect(payload, mode),
  ArkodcVarSeqAtLeast: (p, payload, mode) => p.ArkodcVarSeqAtLeast(payload, mode),
  Rlv2KillWeather: (p, payload, mode) => p.Rlv2KillWeather(payload, mode),
  Rlv2MoveByScrap: (p, payload, mode) => p.Rlv2MoveByScrap(payload, mode),
};
