/**
 * 任务管理器
 * 
 * 负责明日方舟中所有类型任务的管理，包括：
 * - 每日任务（DAILY）：每日刷新的常规任务
 * - 每周任务（WEEKLY）：每周一刷新的进阶任务
 * - 活动任务（ACTIVITY）：限时活动期间的特殊任务
 * - 开服任务（OPENSERVER）：服务器开启期间的限时任务
 * 
 * 任务系统核心机制：
 * 1. 任务按阶段解锁，完成前置任务后自动解锁下一任务
 * 2. 完成任务可获得任务点数，累计点数可兑换奖励
 * 3. 每日/每周任务到期自动重置进度
 */
import { MissionCalcState, MissionPlayerDataGroup, PlayerDataModel } from "../../kernel/playerdata";
import type { Draft } from "mutative";
import excel from "@excel/excel";
import { ItemBundle, ItemType } from "@excel/excel";
import { PlayerCharacter } from "../../kernel/model";
import { BattleData } from "../../kernel/battle-model";
import { checkBetween, now, userTimestamp } from "@utils/time";
import type { EventMap } from "../../kernel/events";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { MissionData } from "@excel/excel";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { logger } from "@utils/logger";
import { readJsonSync } from "@utils/file";
import { registerMissionTriggers } from "./trigger";
import { arkhubSyncMissionCoin } from "../activities/arkhub/public";

/**
 * 每日任务链头 ID 列表（startList）。
 *
 * 每日任务按链式解锁：链头任务（本列表内）无前置、播种即可见（state=2）；
 * 链中任务前置完成（unlockNextMission）才置 state=2 可见。列表来自
 * opendoctoratepy-ex-public 的 daily_start_list（官方每日任务组链头）。
 * 由 dailyRefresh 播种与 unlockNextMission 共用。
 */
export const DAILY_START_LIST: readonly string[] = [
  "daily_4801", "daily_4806", "daily_4808", "daily_4813", "daily_4814", "daily_4815",
  "daily_4816", "daily_4817", "daily_4819", "daily_4821", "daily_4822", "daily_4826",
  "daily_4829", "daily_4901", "daily_4906", "daily_4908", "daily_4913", "daily_4914",
  "daily_4915", "daily_4916", "daily_4917", "daily_4919", "daily_4921", "daily_4922",
  "daily_4926", "daily_4929", "daily_5001", "daily_5006", "daily_5008", "daily_5013",
  "daily_5014", "daily_5015", "daily_5016", "daily_5017", "daily_5019", "daily_5021",
  "daily_5022", "daily_5026", "daily_5029", "daily_5101", "daily_5106", "daily_5108",
  "daily_5113", "daily_5114", "daily_5115", "daily_5116", "daily_5117", "daily_5119",
  "daily_5121", "daily_5122", "daily_5126", "daily_5129", "daily_5201", "daily_5206",
  "daily_5208", "daily_5213", "daily_5214", "daily_5215", "daily_5216", "daily_5217",
  "daily_5219", "daily_5221", "daily_5222", "daily_5226", "daily_5229", "daily_5301",
  "daily_5306", "daily_5308", "daily_5313", "daily_5314", "daily_5315", "daily_5316",
  "daily_5317", "daily_5319", "daily_5321", "daily_5322", "daily_5326", "daily_5329",
  "daily_5401", "daily_5406", "daily_5408", "daily_5413", "daily_5414", "daily_5415",
  "daily_5416", "daily_5417", "daily_5419", "daily_5421", "daily_5422", "daily_5426",
  "daily_5429", "daily_5501", "daily_5506", "daily_5508", "daily_5513", "daily_5514",
  "daily_5515", "daily_5516", "daily_5517", "daily_5519", "daily_5521", "daily_5522",
  "daily_5526", "daily_5529", "daily_5601", "daily_5606", "daily_5608", "daily_5613",
  "daily_5614", "daily_5615", "daily_5616", "daily_5617", "daily_5619", "daily_5621",
  "daily_5622", "daily_5626", "daily_5629", "daily_5701", "daily_5706", "daily_5708",
  "daily_5713", "daily_5714", "daily_5715", "daily_5716", "daily_5717", "daily_5719",
  "daily_5721", "daily_5722", "daily_5726", "daily_5729", "daily_5801", "daily_5806",
  "daily_5808", "daily_5813", "daily_5814", "daily_5815", "daily_5816", "daily_5817",
  "daily_5819", "daily_5821", "daily_5822", "daily_5826", "daily_5829", "daily_5901",
  "daily_5906", "daily_5908", "daily_5913", "daily_5914", "daily_5915", "daily_5916",
  "daily_5917", "daily_5919", "daily_5921", "daily_5922", "daily_5926", "daily_5929",
  "daily_6001", "daily_6006", "daily_6008", "daily_6013", "daily_6014", "daily_6015",
  "daily_6016", "daily_6017", "daily_6019", "daily_6021", "daily_6022", "daily_6026",
  "daily_6029", "daily_6101", "daily_6106", "daily_6108", "daily_6113", "daily_6114",
  "daily_6115", "daily_6116", "daily_6117", "daily_6119", "daily_6121", "daily_6122",
  "daily_6126", "daily_6129", "daily_6201", "daily_6206", "daily_6208", "daily_6213",
  "daily_6214", "daily_6215", "daily_6216", "daily_6217", "daily_6219", "daily_6221",
  "daily_6222", "daily_6226", "daily_6229", "daily_6301", "daily_6306", "daily_6308",
  "daily_6313", "daily_6314", "daily_6315", "daily_6316", "daily_6317", "daily_6319",
  "daily_6321", "daily_6322", "daily_6326", "daily_6329",
];

/** 每周任务链头 ID 列表（startList），语义同 {@link DAILY_START_LIST} */
export const WEEKLY_START_LIST: readonly string[] = [
  "weekly_701", "weekly_707", "weekly_708", "weekly_713", "weekly_714",
  "weekly_715", "weekly_716", "weekly_718", "weekly_720", "weekly_723",
  "weekly_725", "weekly_729", "weekly_732",
];

/** 存档内单条任务记录（`任务类型 → 任务 id → 记录` 两层字典的叶类型） */
type MissionEntry = MissionPlayerDataGroup[string][string];

/** 任务记录的服务端视图：额外持久化 `confirmed` 防重复领取标记（官方结构无此字段） */
type MissionEntryView = MissionEntry & { confirmed?: number };

export class MissionManager {
  missions: { [key: string]: MissionProgress[] };
  /** init() 的 promise（构造期异步执行；AccountManager 加载后 await 它再播种活动任务） */
  initPromise?: Promise<void>;
  _trigger: TypedEventEmitter;
  _player: PlayerDataManager;

  /**
   * 构造函数
   * @param player 玩家数据管理器实例
   * @param _trigger 事件发射器实例
   */
  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this.missions = {};
    // 事件订阅统一登记（见 ./trigger；构造期执行，时机与原内联订阅一致）
    registerMissionTriggers(this);
  }

  /**
   * 获取当前每日任务周期ID
   * 根据当前时间和星期几，从配置表中获取对应的每日任务组ID
   */
  get dailyMissionPeriod(): string {
    const ts = now();
    // 修复：`getDay()+1` 把周日(0)→1、周五(5)→6，与配置表 1=周一..7=周日的
    // 周期编号错位（周日匹配到工作日组、周五匹配到周末组）；先映射周日→7
    const weekDay = new Date().getDay() === 0 ? 7 : new Date().getDay();
    const period = excel.MissionTable.dailyMissionPeriodInfo.find(
      (p) => p.startTime <= ts && p.endTime >= ts,
    )!;
    return period.periodList.find((p) =>
      p.period.includes(weekDay),
    )!.missionGroupId;
  }

  /**
   * 获取当前每日任务奖励周期ID
   * 根据当前时间和星期几，从配置表中获取对应的奖励组ID
   */
  get dailyMissionRewardPeriod(): string {
    const ts = now();
    // 修复：同 dailyMissionPeriod——getDay()+1 星期错位，先映射周日→7
    const weekDay = new Date().getDay() === 0 ? 7 : new Date().getDay();
    const period = (excel.MissionTable.dailyMissionPeriodInfo ?? []).find(
      (p) => p.startTime <= ts && p.endTime >= ts,
    );
    // 防御：periodicalRewards 缺失/单测未配置周期表时返回空串（兑换据此不过滤）
    if (!period) return "";
    const match = period.periodList?.find((p) => p.period.includes(weekDay));
    return match?.rewardGroupId ?? "";
  }

  /**
   * 获取当前每周任务奖励周期ID
   *
   * weeklyRewards 无 periodList 分组概念，每条凭 beginTime/endTime 时间窗标识生效期；
   * 取覆盖当前时间的所有奖励组（通常唯一），多组并存时按 id 排序取最小以保证确定。
   * @returns 当前生效的周奖励组 id（如 reward_weekly_g_4）；无覆盖时返回空串
   */
  get weeklyRewardPeriod(): string {
    const ts = now();
    const groupIds = new Set<string>(
      Object.values(excel.MissionTable.weeklyRewards ?? {})
        .filter(
          (r) => r && checkBetween(ts, r.beginTime, r.endTime),
        )
        .map((r) => r.groupId),
    );
    return [...groupIds].sort()[0] ?? "";
  }

  /**
   * 取当前生效的特勤干员周任务 id 列表。
   *
   * 数据源：@@MissionTable.soCharMissionGroupInfo@@——特勤干员周任务是**独立的**
   * 周期组容器（不登记在 @@MissionTable.missionGroups@@ 中，全表 209 组仅
   * GUIDE/SUB/MAIN/DAILY/WEEKLY/RETRO 六类），每组带 startTs/endTs 时间窗：
   * - @@soWeekTask_g_1@@（soWeekTask_1/2/3，endTs 1783886399 = 2026-07-12）已过期
   * - @@soWeekTask_g_2@@（soWeekTask_1/2/3_rogue6，startTs 1783886400 起）当前生效
   * 因此必须按时间窗过滤，过期组不再播种（客户端也随之不再显示）。
   *
   * 兜底：数据表缺 soCharMissionGroupInfo（旧版数据/单测 mock）时按 @@type@@ 扫描
   * @@MissionTable.missions@@。
   * @returns 生效组内、且确实存在于 MissionTable.missions 的任务 id（保持组内顺序）
   */
  private _activeSpecialOperatorWeeklyIds(): string[] {
    const missions = excel.MissionTable?.missions ?? {};
    const groups = excel.MissionTable?.soCharMissionGroupInfo;
    if (groups && typeof groups === "object") {
      const ts = now();
      const active = Object.values(groups).filter(
        (g) =>
          g &&
          checkBetween(ts, Number(g.startTs ?? 0), Number(g.endTs ?? 0)),
      );
      if (active.length > 0) {
        return active
          .flatMap((g) => g.missionIds ?? [])
          .filter((id) => !!missions[id]);
      }
      // 组容器存在但当前无生效组（活动间歇期）→ 不播种任何特勤周任务
      if (Object.keys(groups).length > 0) return [];
    }
    return Object.entries(missions)
      .filter(
        ([, m]) =>
          !!m &&
          typeof m === "object" &&
          m.type === "SPECIAL_OPERATOR_WEEKLY",
      )
      .map(([id]) => id);
  }

  /**
   * 播种特勤干员**周任务**（SPECIAL_OPERATOR_WEEKLY）到玩家任务数据（幂等）
   *
   * 数据源：@@MissionTable.soCharMissionGroupInfo@@ 当前生效组
   * （@@soWeekTask_1/2/3(_rogue6)@@：累计消耗 500/1000 理智、结算一次集成战略，
   * 奖励 @@SO_CHAR_EXP@@ 特勤作战记录 @@so_char_exp_1@@ 6000/6000/8000）。
   *
   * 修复（2026-09-09，审计 §5.4-11）：这些任务的 @@missionGroup@@ 指向
   * @@soWeekTask_g_1/g_2@@，而 @@MissionTable.missionGroups@@ **没有**这两个组，
   * 故既不会被周期组播种、也不在任何组的 @@missionIds@@ 中 → 全仓无引用、
   * 特勤干员经验来源缺失。现按 @@soCharMissionGroupInfo@@ 时间窗播种
   * （与既有 @@seedSpecialOperatorMissions@@ 同口径）。
   *
   * **解锁门控**：@@SpecialOperatorTable.constData.weeklyTaskBoardUnlock = "main_03-08"@@
   * ——未通关该关（completeTimes > 0 或 state ≥ 2）不播种（官服任务板此时未开放）。
   * 播种条目 state 取 @@_isChainHead@@（@@preMissionIds@@ 为空 → 2 可见可做）。
   * @param draft - update() 配方的可写草稿（playerData）
   */
  private seedSpecialOperatorWeeklyMissions(draft: Draft<PlayerDataModel>): void {
    if (!this._specialOperatorBoardUnlocked(draft)) return;
    const group = (draft.mission.missions["SPECIAL_OPERATOR_WEEKLY"] ??= {});
    for (const id of this._activeSpecialOperatorWeeklyIds()) {
      // 幂等：已有条目（含已完成进度）保持不变
      if (!group[id]) {
        group[id] = {
          state: this._isChainHead(id) ? 2 : 1,
          progress: this._seedInitialProgress(id),
        };
      }
    }
  }

  /**
   * 特勤干员任务板是否已解锁
   *
   * 依据 @@SpecialOperatorTable.constData.weeklyTaskBoardUnlock@@（实测 "main_03-08"）——
   * 该关通关（completeTimes > 0）或已达成星数（state ≥ 2）视为解锁；常量缺失时不设门槛。
   */
  private _specialOperatorBoardUnlocked(draft: Draft<PlayerDataModel>): boolean {
    const unlockStage = excel.SpecialOperatorTable?.constData?.weeklyTaskBoardUnlock;
    if (!unlockStage) return true;
    const stage = draft?.dungeon?.stages?.[unlockStage];
    if (!stage) return false;
    return Number(stage.completeTimes ?? 0) > 0 || Number(stage.state ?? 0) >= 2;
  }

  /**
   * 初始化任务系统
   * 遍历所有任务类型，为每个任务创建MissionProgress实例并初始化
   */
  async init() {
    // 先补 ACTIVITY 分组（Immer draft 内不创建 MissionProgress，避免模板 push 到冻结 draft）。
    // 修复：改为仅在分组不存在时补空——原无条件 `ACTIVITY = {}` 会清空已加载存档里的
    // ACTIVITY 任务（含奇象巡展 1arkhubActivity_* 的 progress 进度），后续 unlockActivity
    // 播种因组已空而全部重建为初始态 → 玩家既有任务进度无法从存档继承（丢失）。
    await this._player.update(async (draft) => {
      draft.mission.missions["ACTIVITY"] ??= {};
      // 播种特勤干员（SPECIAL_OPERATOR）任务（幂等：仅补缺失条目，见 seedSpecialOperatorMissions）
      this.seedSpecialOperatorMissions(draft);
      // 播种特勤干员周任务（SPECIAL_OPERATOR_WEEKLY，审计 §5.4-11：原全仓无引用，
      // 因 missionGroup 指向 MissionTable 中不存在的组；按 type 播种 + 任务板解锁门控）
      this.seedSpecialOperatorWeeklyMissions(draft);
    });
    for (const [type, v] of Object.entries(
      this._player._playerdata.mission.missions,
    )) {
      // 填充内存任务列表（confirmMission/getMissionById 依赖）
      this.missions[type] = [];
      for (const [id] of Object.entries(v)) {
        const mission = new MissionProgress(id, type, this._player);
        await mission.init();
        // 无效任务（数据表缺失）跳过——不进入内存列表
        if (mission.valid) {
          this.missions[type].push(mission);
        }
      }
    }
  }

  /**
   * 播种特勤干员（SPECIAL_OPERATOR）任务到玩家任务数据（幂等）。
   *
   * 数据源：SpecialOperatorTable.nodeUnlockMissionData（电弧/机械师解锁任务，type=SPECIAL_OPERATOR）。
   * 该表任务不在 MissionTable.missions，须在 init 阶段补种；播种条目 progress 为空数组，
   * 由 MissionProgress.init 按模板 init 构建（与 dailyRefresh 新组任务同款）。
   * 已有条目（旧存档/重复登录）保持不变，避免覆盖已完成进度。
   * @param draft update() 配方的可写草稿（playerData）
   */
  private seedSpecialOperatorMissions(draft: Draft<PlayerDataModel>): void {
    const missionData = excel.SpecialOperatorTable?.nodeUnlockMissionData;
    if (!missionData || typeof missionData !== "object") return;
    const group = (draft.mission.missions["SPECIAL_OPERATOR"] ??= {});
    for (const missionId of Object.keys(missionData)) {
      if (!group[missionId]) {
        group[missionId] = { state: 1, progress: [] };
      }
    }
  }

  /**
   * 生成任务的初始进度条目 [{value:0,target}]（非空数组）。
   *
   * dailyRefresh 播种日常任务时调用。原实现播种 `progress: []`（空数组），依赖
   * MissionProgress.init 里的模板 init 兜底填充；一旦该兜底未执行（数据缺失/边缘路径）
   * 便会向存档残留空数组，日常任务进度显示为空、无法推进。此处播种即调用模板 init
   * 推导真实 target，从根源保证 progress 结构完整。
   *
   * 纯计算，不触碰 playerdata（模板 init 只写入传入的临时 mission 对象），可在 update
   * 配方的 draft 内安全调用。
   * @param missionId 任务 ID（MissionTable.missions 中的键）
   * @returns 初始进度数组；模板缺失时兜底 [{value:0,target:1}]
   */
  private _seedInitialProgress(
    missionId: string,
  ): { value: number; target: number }[] {
    const info = excel.MissionTable.missions[missionId];
    const template = info?.template as keyof typeof MissionTemplates | undefined;
    const branch = info?.param?.[0];
    // 数据表缺失或模板/分支不存在 → 兜底单目标 1，仍保证非空数组
    if (!template || !branch || !(template in MissionTemplates)) {
      return [{ value: 0, target: 1 }];
    }
    const tpl = MissionTemplates[template]?.[branch ?? ""];
    if (!tpl?.init) {
      return [{ value: 0, target: 1 }];
    }
    const seed: { value: number; target: number }[] = [];
    try {
      // 复用模板 init 计算 target（与 MissionProgress.init 兜底一致）
      tpl.init({ progress: seed, value: 0, param: info.param } as never);
    } catch {
      return [{ value: 0, target: 1 }];
    }
    return seed.length > 0 ? seed : [{ value: 0, target: 1 }];
  }

  /**
   * 根据任务ID获取任务进度实例
   * @param missionId 任务ID
   * @returns MissionProgress实例（任务不在数据表/内存列表时返回 undefined，调用方自行判空）
   */
  async getMissionById(
    missionId: string,
  ): Promise<MissionProgress | undefined> {
    // 防御：数据表缺失（版本错位/下架任务）时 .type 解引用会 500
    const missionInfo = excel.MissionTable.missions[missionId];
    if (!missionInfo) return undefined;
    const type = missionInfo.type;
    return this.missions[type]?.filter((m) => m.missionId == missionId)[0];
  }

  /**
   * 每日任务刷新
   * 重置每日任务进度和奖励状态，加载新的每日任务列表
   */
  async dailyRefresh() {
    // 修复：退订旧实例监听器（防泄漏 + 旧进度写回新任务）
    for (const m of this.missions["DAILY"] ?? []) {
      m.unsubscribe();
    }
    await this._player.update(async (draft) => {
      draft.mission.missionRewards.dailyPoint = 0;
      draft.mission.missionRewards.rewards["DAILY"] = {};
      for (const reward of Object.values(
        excel.MissionTable.periodicalRewards,
      )) {
        // 防御：数据表末尾混入字段名伪键（值 null 的转换产物，如 "groupId"/"id"）
        // → reward.groupId 读 null 崩溃（2026-08-14 线上 daily refresh 500）
        if (!reward || typeof reward !== "object") continue;
        if (reward.groupId == this.dailyMissionRewardPeriod) {
          draft.mission.missionRewards.rewards["DAILY"][reward.id] = 0;
        }
      }
      // 修复：播种当前周期组任务到存档（原实现只重建内存列表——存档仍是创建时的旧组
      // 任务，当前组 id 在存档缺失 → init 全部 invalid → DAILY 列表空 → confirmMission
      // 拿不到实例返回空 → "任务无法确认"；且客户端仍显示旧组 state=3 任务，点确认无响应）。
      // 官方每日重置即替换当日任务组：删旧组条目、补新组条目。
      const currentIds =
        excel.MissionTable.missionGroups[this.dailyMissionPeriod].missionIds ??
        [];
      const daily = (draft.mission.missions["DAILY"] ??= {});
      // 跨天周期组相同（如周内连续工作日同组）时，无论任务是否已存在都强制重置为
      // 初始可接取态，避免昨日完成态残留导致"每日更新不刷新进度"。
      // 修复（2026-08-23）：播种的 progress 直接写入结构完整、target 真实的
      // [{value:0,target}]——原实现播种 progress:[]（空数组中间态），一旦依赖的模板
      // init 兜底未执行便会残留空数组 → 日常任务进度被置空、存档坏数据。此处播种即
      // 用模板 init 推导初始 target，从根源保证 progress 永不为空数组。
      // 修复（2026-08-25）：播种 state 对齐官方（Torappu.MissionHoldingState +
      // opendoctoratepy re_set_state）——链头任务（startList）置 state=2（可见可做），
      // 链中任务置 state=1（隐藏，前置完成 unlockNextMission 才可见）。原实现全部
      // state=1，客户端任务列表只显示 state>=2 的任务 → 未完成且进度为 0 的链头
      // 每日任务不显示；仅靠游戏事件触发 getState() 才偶然提升为 2。
      for (const id of currentIds) {
        daily[id] = {
          // 修复（2026-09-09）：链头按数据表 preMissionIds 动态判定（原硬编码
          // DAILY_START_LIST 停留在 daily_6329 一代，当前周期组 daily_g_70/71 命中率 0
          // → 29 条每日任务全部播种 state=1，客户端列表恒空）
          state: this._isChainHead(id) ? 2 : 1,
          progress: this._seedInitialProgress(id),
        };
      }
      // 删除当前组之外的历史任务条目
      for (const id of Object.keys(daily)) {
        if (!currentIds.includes(id)) delete daily[id];
      }
    });
    const missionIds =
      excel.MissionTable.missionGroups[this.dailyMissionPeriod].missionIds;
    // 修复：原实现直接 new 不 init → progress 空/无监听器，刷新后任务系统失效；
    // 逐实例 init（与 Manager.init 一致，无效任务跳过）
    this.missions["DAILY"] = [];
    for (const missionId of missionIds) {
      const mission = new MissionProgress(missionId, "DAILY", this._player);
      await mission.init();
      if (mission.valid) {
        this.missions["DAILY"].push(mission);
      }
    }
  }

  /**
   * 每周任务刷新
   * 重置每周任务进度和奖励状态，加载新的每周任务列表
   */
  async weeklyRefresh() {
    // 修复：退订旧实例监听器（防泄漏 + 旧进度写回新任务）
    for (const m of this.missions["WEEKLY"] ?? []) {
      m.unsubscribe();
    }
    await this._player.update(async (draft) => {
      draft.mission.missionRewards.weeklyPoint = 0;
      draft.mission.missionRewards.rewards["WEEKLY"] = {};
      // 修复（2026-08-25）：播种全部 WEEKLY 任务到存档并重置进度——原实现只重置点数，
      // 存档中上周完成态（state=3）原样保留 → 客户端每周任务显示上周完成态、不刷新；
      // 且新账号存档无 WEEKLY 条目 → init 全部 invalid → 周任务列表空（与 dailyRefresh
      // 播种前同病）。对齐官方 re_set_state（opendoctoratepy-ex-public）：全部置
      // state=1、链头（WEEKLY_START_LIST）置 state=2（可见可做）、progress 清零
      // （target 由模板推导，与 dailyRefresh 播种同款）。
      const weekly = (draft.mission.missions["WEEKLY"] ??= {});
      const weeklyIds = Object.keys(excel.MissionTable.missions).filter((id) => {
        const m = excel.MissionTable.missions[id];
        return !!m && typeof m === "object" && m.type == "WEEKLY";
      });
      for (const id of weeklyIds) {
        weekly[id] = {
          state: this._isChainHead(id) ? 2 : 1,
          progress: this._seedInitialProgress(id),
        };
      }
    });
    // 特勤干员周任务（SPECIAL_OPERATOR_WEEKLY）：同口径周重置（审计 §5.4-11）——
    // 这些任务不属于 MissionTable.missionGroups 周期组，原实现从不重置：上周完成态
    // 永久保留、新账号也不会出现。此处按生效组整体重建（含任务板解锁门控）并重建实例；
    // 整体重建同时处理了组轮换（g_1 过期 → g_2 生效）与过期组条目的清除。
    await this._player.update(async (draft) => {
      // 未解锁：清空该组（避免旧存档残留条目在未通关时仍显示）
      if (!this._specialOperatorBoardUnlocked(draft)) {
        draft.mission.missions["SPECIAL_OPERATOR_WEEKLY"] = {};
        return;
      }
      const rebuilt: Record<string, MissionEntry> = {};
      for (const id of this._activeSpecialOperatorWeeklyIds()) {
        rebuilt[id] = {
          state: this._isChainHead(id) ? 2 : 1,
          progress: this._seedInitialProgress(id),
        };
      }
      draft.mission.missions["SPECIAL_OPERATOR_WEEKLY"] = rebuilt;
    });
    for (const m of this.missions["SPECIAL_OPERATOR_WEEKLY"] ?? []) {
      m.unsubscribe();
    }
    this.missions["SPECIAL_OPERATOR_WEEKLY"] = [];
    for (const id of Object.keys(
      this._player._playerdata.mission.missions["SPECIAL_OPERATOR_WEEKLY"] ?? {},
    )) {
      const instance = new MissionProgress(id, "SPECIAL_OPERATOR_WEEKLY", this._player);
      await instance.init();
      if (instance.valid) {
        this.missions["SPECIAL_OPERATOR_WEEKLY"].push(instance);
      }
    }
    // 修复：原实现 new 后不 init（progress 空/无监听器）；逐实例 init
    this.missions["WEEKLY"] = [];
    for (const mission of Object.values(excel.MissionTable.missions).filter(
      // 防御：数据表末尾字段名伪键（值 null）——m.type 读 null 崩溃，跳过
      (m): m is MissionData => !!m && typeof m === "object" && m.type == "WEEKLY",
    )) {
      const instance = new MissionProgress(
        mission.id,
        "WEEKLY",
        this._player,
      );
      await instance.init();
      if (instance.valid) {
        this.missions["WEEKLY"].push(instance);
      }
    }
  }

  /**
   * 重建 ACTIVITY 任务进度实例（活动播种后调用）
   *
   * MissionManager.init 在活动播种（unlockActivity）之前执行——init 时 ACTIVITY
   * 组为空（播种任务尚未写入），播种后的新任务没有 MissionProgress 实例/监听器，
   * 事件驱动进度（奇象巡展 8 类 Arkhub 模板）无法生效。此方法退订旧实例并按其
   * 当前存档重建（与 dailyRefresh 同款：无效任务跳过）。
   */
  async reloadActivity(): Promise<void> {
    for (const m of this.missions["ACTIVITY"] ?? []) {
      m.unsubscribe();
    }
    this.missions["ACTIVITY"] = [];
    const saveMissions = this._player._playerdata.mission.missions["ACTIVITY"] ?? {};
    for (const missionId of Object.keys(saveMissions)) {
      const mission = new MissionProgress(missionId, "ACTIVITY", this._player);
      await mission.init();
      if (mission.valid) {
        this.missions["ACTIVITY"].push(mission);
      }
    }
  }

  /**
   * 确认完成任务并领取奖励
   * @param missionId 任务ID
   * @returns 获得的物品奖励列表
   * 
   * 任务状态定义（参照明日方舟Torappu.MissionHoldingState）：
   * - 0: 未解锁（前置任务未完成）
   * - 1: 未接取（已解锁但未开始）
   * - 2: 进行中（已接取且未完成）
   * - 3: 已完成（可领取奖励）
   */
  async confirmMission(args: { missionId: string }): Promise<ItemBundle[]> {
    const { missionId } = args;
    const missionInfo = excel.MissionTable.missions[missionId];
    if (!missionInfo) {
      // 特勤干员任务（SpecialOperatorTable.nodeUnlockMissionData）：无 rewards，确认仅置
      // confirmed 防重复（节点解锁由客户端 SpecialOperatorUnlockNode 驱动），返回空奖励。
      const soMission = excel.SpecialOperatorTable?.nodeUnlockMissionData?.[missionId];
      if (soMission) {
        await this._player.update(async (draft) => {
          const data: MissionEntryView | undefined =
            draft.mission.missions["SPECIAL_OPERATOR"]?.[missionId];
          if (data) {
            data.state = 3;
            data.confirmed = 1;
          }
        });
        return [];
      }
      // 活动任务（ActivityTable.missionData，如 1arkhubActivity_*/53sideActivity_*）
      // 兜底领取——枢纽任务奖励同步 ARK_HUB.coin/tshop 币（官服形状）
      return this.mergeItemBundles(
        await this._confirmActivityTableMission(missionId),
      );
    }
    const mission = await this.getMissionById(missionId);
    const items: ItemBundle[] = [];
    // 修复：确认判定以存档为准（内存列表可能因每日刷新重建/旧周期组为空——
    // 客户端仍显示存档中已完成可领取的任务，此前 getMissionById 拿不到实例直接返回空
    // → "无法领取奖励"）；持久化 confirmed 标记防重复（原仅内存实例标记，重启/列表
    // 重建后丢失 → 可重复刷周期点数）。
    // 再修复：按**进度**判定完成（对齐 opendoctoratepy-ex-public：所有 progress 项
    // value>=target 即可领取并置 state=3），而非要求 state==3——state 可能因事件链
    // 失败/旧存档未置 3（progress 已满但 state 仍为 2），仅查 state 会拒绝发放。
    if (mission?.confirmed) return items;
    await this._player.update(async (draft) => {
      const data: MissionEntryView | undefined =
        draft.mission.missions[missionInfo.type]?.[missionId];
      if (
        !data ||
        !Array.isArray(data.progress) ||
        data.progress.length === 0
      ) {
        return;
      }
      // confirmed 为服务端持久化的防重复标记（官方结构无此字段，见 MissionEntryView）
      const full = data.progress.every((p) => p.value >= p.target);
      // 修复：state=3 是"已完成可领取"而非"已领取"——任务进度填满时 init 事件回调即置 3
      //（见 init），此刻奖励尚未发放。原 guard 把 data.state===3 一并视为已领 → 已完成待领取
      // 的任务 confirmMission 直接 return（items 空、dailyPoint 不累计）→ 客户端"显示待领取
      // 却无法领取"。改以新增的 confirmed 标记判重（发放时置 1），state 不再参与判重。
      if (!full || data.confirmed) return;
      data.state = 3;
      data.confirmed = 1;
      if (mission) mission.confirmed = true;
      const missionRewards = draft.mission.missionRewards;
      switch (missionInfo.type) {
        case "DAILY":
        case "WEEKLY": {
          // 修复：WEEKLY 与 DAILY 对称——累加周期点后自动兑换所有达标周期奖励。
          // 原 WEEKLY 分支只累加 weeklyPoint 从不兑换 → 确认周任务后响应 items
          // 恒为空，客户端"获得物品"提示永不出现（官服 autoConfirm WEEKLY 抓包
          // R-1787047281356-0118 确认周任务会兑换 reward_weekly_* 并返回物品）。
          const isWeekly = missionInfo.type === "WEEKLY";
          const type = isWeekly ? "WEEKLY" : "DAILY";
          const pointField = isWeekly ? "weeklyPoint" : "dailyPoint";
          missionRewards[pointField] += missionInfo.periodicalPoint ?? 0;
          // 防御：新账号 missionRewards 可能为空对象（freshMission 只给
          // { missions, missionRewards: {}, missionGroups }），rewards 子树未初始化
          // → 原 Object.entries(undefined) 直接崩溃（接口 500 → 客户端无任何提示）。
          const rewardsTree = (missionRewards.rewards ??= {});
          const rewardMap = (rewardsTree[type] ??= {});
          // 奖励定义表：DAILY 走 periodicalRewards（仅 DAILY），WEEKLY 走 weeklyRewards——
          // 原实现统一查 periodicalRewards，而该表只有 DAILY → WEEKLY 周期奖励永不兑换。
          // 当前周期组：多组并存（历史组残留）时只兑换当前生效组，避免一次确认把多个
          // 奖励组的奖励全部发放（重复刷金币/材料/寻访凭证）。
          const rewardDefs = isWeekly
            ? (excel.MissionTable.weeklyRewards ?? {})
            : (excel.MissionTable.periodicalRewards ?? {});
          const currentGroup = isWeekly
            ? this.weeklyRewardPeriod
            : this.dailyMissionRewardPeriod;
          for (const [k, v] of Object.entries(rewardMap)) {
            const reward = rewardDefs[k];
            // 防御：数据表缺该奖励（版本错位/伪键）时跳过，避免读 undefined.cost
            if (!reward || v != 0) continue;
            // 只兑当前周期组——rewards 若残留历史组条目，跳过以免多组同时发放
            if (currentGroup && reward.groupId !== currentGroup) continue;
            if (missionRewards[pointField] >= reward.periodicalPointCost) {
              missionRewards[pointField] -= reward.periodicalPointCost;
              items.push(...reward.rewards);
              rewardMap[k] = 1;
            }
          }
          break;
        }
        default:
          // 修复：MAIN/SUB/GUIDE/RETRO/SPECIAL 等非周期点任务——直接发放任务自身 rewards。
          // 原实现 default 分支空 out → 完成态任务 confirm 后 items 为空，客户端视为
          // "领取无奖励/无法领取"（2222 存档里大量 MAIN/SUB 任务即属此类）。
          for (const r of missionInfo.rewards ?? []) {
            items.push({ id: r.id, count: r.count, type: String(r.type) as ItemType });
          }
          break;
      }
    });

    // 修复：合并相同物品（相同 type+id count 相加，保持首次出现顺序）——多任务
    // 兑换/发放产生的 items 常含重复 id 条目（如 autoConfirm 多个 reward 都含 GOLD
    // 4001），不合并则客户端"获得物品"提示按多条拆分、计数错乱/重复弹窗。
    const merged = this.mergeItemBundles(items);
    for (const it of merged) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    return merged;
  }

  /**
   * 合并物品列表：相同 type+id 的条目 count 相加，保留首次出现顺序。
   *
   * 用于单任务确认与一键领取返回给客户端的"获得物品"列表——不同任务/周期奖励
   * 常产出重复 id 的物品（如多个奖励都含 GOLD 4001），未合并会拆成多条，客户端
   * 提示计数错误或重复弹出。合并后每类物品仅一条，count 为总和。
   * @param items 待合并的物品列表
   * @returns 合并后的物品列表
   */
  mergeItemBundles(items: ItemBundle[]): ItemBundle[] {
    const map = new Map<string, ItemBundle>();
    for (const item of items) {
      if (item == null) continue;
      const key = `${item.type}|${item.id}`;
      const prev = map.get(key);
      if (prev) {
        prev.count = (prev.count ?? 0) + (item.count ?? 0);
      } else {
        map.set(key, {
          id: item.id,
          count: item.count ?? 0,
          type: item.type,
        });
      }
    }
    return [...map.values()];
  }

  /**
   * 活动任务领取（ActivityTable.missionData，如 1arkhubActivity_* / 53sideActivity_*）
   *
   * 官服抓包对齐（R-1786877191677-0085 confirmMultiGroupMissionList）：领取后
   * 发 missionData.rewards、置 state=3，且枢纽任务（奖励含 act1arkhub_token_seal）
   * 同步累加 activity.ARK_HUB.act1arkhub.coin 与 tshop.shop_act1arkhub.coin。
   * @param missionId - 活动任务 ID
   * @returns 奖励物品列表（未知任务返回空）
   */
  private async _confirmActivityTableMission(
    missionId: string,
  ): Promise<ItemBundle[]> {
    const missionInfo = excel.ActivityTable?.missionData?.find(
      (m) => m.id === missionId,
    );
    if (!missionInfo) return [];
    const items: ItemBundle[] = (missionInfo.rewards ?? []).map((r) => ({
      id: r.id,
      count: r.count,
      type: String(r.type) as ItemType,
    }));
    let newlyCompleted = false;
    let alreadyConfirmed = false;
    await this._player.update(async (draft) => {
      const activityMissions = draft.mission.missions?.["ACTIVITY"];
      const data: MissionEntryView | undefined = activityMissions?.[missionId];
      // 修复：活动任务确认后还能重复确认刷奖励——原实现仅 state!=3 置 3，state 已为 3
      // 时仍无条件返回全部 rewards。现与普通任务一致：以持久化 confirmed 标记判重，
      // 已领取即返回空奖励并中止（不累加枢纽 ARK_HUB coin），避免重复发放。
      if (data && data.confirmed) {
        alreadyConfirmed = true;
        return;
      }
      if (data && data.state !== 3) {
        data.state = 3;
        newlyCompleted = true;
      }
      if (data) data.confirmed = 1;
      // 枢纽任务奖励 → ARK_HUB.coin / tshop.shop_act1arkhub.coin 同步累加（统一实现）
      arkhubSyncMissionCoin(draft, missionInfo.rewards ?? []);
    });
    // 已领取：不发放奖励、不重复触发勋章/物品事件
    if (alreadyConfirmed) return [];
    // 活动任务完成勋章（MissionCompleteSome，medal_activity_53side_04）：每新完成
    // 一个 53side 任务 +1，目标 = 任务列表长度
    if (newlyCompleted) {
      await this._trigger.emit("MissionCompleteSome", [{ count: 1 }]);
    }
    if (items.length > 0) {
      for (const it of items) this._player.gainItem.add(it);
      await this._player.gainItem.handle();
    }
    return items;
  }

  /**
   * 确认完成任务组并领取奖励
   * @param missionGroupId 任务组ID
   * 
   * 任务组是多个相关任务的集合，完成所有任务后可领取组奖励
   */
  /**
   * 判定任务是否为链头（无前置任务 → 播种即可见 state=2）
   *
   * 修复（2026-09-09）：原实现用硬编码白名单 DAILY_START_LIST / WEEKLY_START_LIST 判定链头，
   * 白名单停留在 daily_6329 一代；当前生效周期组为 daily_g_70/71（链头 daily_7001…），
   * 命中率 0 → 29 条每日任务全部播种 state=1（隐藏），客户端任务列表恒空。
   * 改为按数据表 preMissionIds 动态判定（与 MissionProgress.getState 同规则）。
   * @param missionId - 任务 id
   */
  private _isChainHead(missionId: string): boolean {
    const info = excel.MissionTable.missions[missionId] as
      | { preMissionIds?: string[] | null }
      | undefined;
    // 数据表缺失时保守视为链头（可见），不回退已过期的白名单
    return !info || !info.preMissionIds || info.preMissionIds.length === 0;
  }

  /**
   * 读取某任务在存档中的状态（跨类型桶查找；找不到返回 0 = 未解锁）
   * @param missionId - 任务 id
   */
  private _savedMissionState(missionId: string): number {
    const buckets = (this._player._playerdata.mission?.missions ?? {}) as Record<
      string,
      Record<string, { state?: number }> | undefined
    >;
    for (const bucket of Object.values(buckets)) {
      const entry = bucket?.[missionId];
      if (entry) return entry.state ?? 0;
    }
    return 0;
  }

  async confirmMissionGroup(args: { missionGroupId: string }) {
    const { missionGroupId } = args;
    const group = excel.MissionTable.missionGroups[missionGroupId];
    if (!group?.rewards) return;
    // 修复：已领取过的任务组不再发放（原实现每次调用都发放组奖励 → 重复刷）
    if (this._player._playerdata.mission.missionGroups[missionGroupId] === 1) {
      return;
    }
    // 修复（2026-09-09）：组奖励须「组内任务全部完成（state=3）」才发放——原实现只查
    // 「已领取」标记，任意客户端发一次 confirmMissionGroup 即可凭空领到组奖励
    // （如 guide_g_8 的五星干员 char_102_texas、guide_g_1~4 的十连凭证）。
    const missionIds = (group as { missionIds?: string[] }).missionIds ?? [];
    if (missionIds.length === 0) return;
    const notDone = missionIds.filter((id) => this._savedMissionState(id) < 3);
    if (notDone.length > 0) {
      logger.warn(
        "MissionManager",
        `任务组 ${missionGroupId} 未全部完成，拒绝发放组奖励（未完成 ${notDone.length}/${missionIds.length}：${notDone.slice(0, 5).join(",")}）`,
      );
      return;
    }
    for (const it of group.rewards) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    await this._player.update(async (draft) => {
      draft.mission.missionGroups[missionGroupId] = 1;
    });
  }

  /**
   * 自动确认并领取所有已完成的任务奖励
   * @param type 任务类型（DAILY/WEEKLY等）
   * @returns 获得的物品奖励列表
   */
  async autoConfirmMissions(args: { type: string }): Promise<ItemBundle[]> {
    const { type } = args;
    const items: ItemBundle[] = [];
    // 对齐参考实现（opendoctoratepy-ex-public）：遍历存档该类型全部任务，由
    // confirmMission 按进度（value>=target）+ confirmed 标记判定发放——原实现只
    // 遍历内存列表（每日刷新/旧周期组导致为空）且过滤 state==2（恒不成立 →
    // 一键领取永远为空）
    const saveMissions =
      this._player._playerdata.mission.missions[type] ?? {};
    for (const missionId of Object.keys(saveMissions)) {
      items.push(...(await this.confirmMission({ missionId })));
    }
    // 聚合后统一合并相同物品（confirmMission 各自返回已合并，但跨任务重复 id
    // 仍需在此再聚合一次，保证一键领取响应去重）
    return this.mergeItemBundles(items);
  }

  /**
   * 使用任务点数兑换奖励
   * @param targetRewardsId 奖励ID
   * @returns 获得的物品奖励列表
   */
  async exchangeMissionRewards(args: { targetRewardsId: string }) {
    const { targetRewardsId } = args;
    const periodicalReward = excel.MissionTable.periodicalRewards[targetRewardsId];
    // 修复：原实现无已领校验、不扣点数 → 可无限刷奖励；
    // 现校验已领取状态与点数余额，发放时扣点并标记已领
    if (!periodicalReward?.rewards) return [];
    const type = periodicalReward.type === "WEEKLY" ? "WEEKLY" : "DAILY";
    const rewards: ItemBundle[] = [];
    await this._player.update(async (draft) => {
      const missionRewards = draft.mission.missionRewards;
      const claimed = missionRewards.rewards[type]?.[targetRewardsId] ?? 0;
      if (claimed !== 0) return;
      const points =
        type === "DAILY"
          ? missionRewards.dailyPoint
          : missionRewards.weeklyPoint;
      if (points < periodicalReward.periodicalPointCost) return;
      if (type === "DAILY") {
        missionRewards.dailyPoint -= periodicalReward.periodicalPointCost;
      } else {
        missionRewards.weeklyPoint -= periodicalReward.periodicalPointCost;
      }
      missionRewards.rewards[type][targetRewardsId] = 1;
      rewards.push(...periodicalReward.rewards);
    });
    for (const it of rewards) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    return rewards;
  }
}

/**
 * 任务进度管理类
 * 
 * 负责单个任务的进度追踪、状态管理和事件监听。
 * 明日方舟任务系统的核心逻辑实现，包括：
 * - 根据任务模板注册相应的事件监听器
 * - 实时更新任务进度
 * - 任务完成后自动解锁下一任务
 */
export class MissionProgress {
  progress: MissionCalcState[];
  missionId: string;
  _trigger: TypedEventEmitter;
  _player: PlayerDataManager;
  param!: string[];
  type: string;
  value: number;
  state: number;
  confirmed: boolean;
  /** 任务是否有效（数据表缺失/版本错位时为 false——init 时跳过） */
  valid = true;
  /** 已注册的事件模板与监听器（供每日/每周刷新退订，防泄漏+旧进度写回） */
  private _registeredTemplate: keyof typeof MissionTemplates | null = null;
  private _registeredFunc: Function | null = null;

  /**
   * 构造函数
   * @param missionId 任务ID
   * @param type 任务类型（DAILY/WEEKLY/ACTIVITY/OPENSERVER）
   * @param player 玩家数据管理器实例
   */
  constructor(missionId: string, type: string, player: PlayerDataManager) {
    this.missionId = missionId;
    this.progress = [];
    this.value = 0;
    this.type = type;
    this._player = player;
    this._trigger = player._trigger;
    this.state = 0;
    this.confirmed = false;
  }

  /**
   * 获取当前任务状态
   * @returns 任务状态值（0-3）
   * 
   * 任务状态定义（参照明日方舟Torappu.MissionHoldingState）：
   * - 0: 未解锁（前置任务未完成）
   * - 1: 未接取（已解锁但未开始）
   * - 2: 进行中（已接取且未完成）
   * - 3: 已完成（可领取奖励）
   */
  async getState(): Promise<number> {
    // 防御：progress 未初始化（刷新后未 init 的实例）时不崩
    if (!this.progress?.[0] || !("value" in this.progress[0])) {
      return 0;
    }
    if (this.progress[0].value >= this.progress[0].target! && this.confirmed) {
      return 3;
    } else {
      const preMissionIds =
        excel.MissionTable.missions[this.missionId]?.preMissionIds;
      if (!preMissionIds) {
        return 2;
      }
      for (const i of preMissionIds) {
        // 防御：前置任务不在数据表/内存列表（下架/无效跳过）时按未完成处理，不 500
        const pre = await this._player.mission.getMissionById(i);
        if (!pre || pre.state != 3) {
          return 1;
        }
      }
      return 2;
    }
  }

  /**
   * 解锁下一个任务
   * 
   * 根据当前任务ID计算下一个任务ID，并将其状态设置为可接取（状态2）。
   * 某些任务是新阶段的起始任务，不需要解锁前置任务，这些任务被列入startList中。
   */
  async unlockNextMission() {
    let startList: readonly string[];
    switch (this.type) {
      case "DAILY":
        startList = DAILY_START_LIST;
        break;
      case "WEEKLY":
        startList = WEEKLY_START_LIST;
        break;
      default:
        return;
    }

    const parts = this.missionId.split("_");
    if (parts.length < 2) {
      return;
    }
    const prefix = parts[0] + "_";
    const num = parseInt(parts[1]);
    if (isNaN(num)) {
      return;
    }
    const nextNum = num + 1;
    const nextMissionId = prefix + nextNum;

    if (startList.includes(nextMissionId)) {
      return;
    }

    await this._player.update(async (draft) => {
      const missions = draft.mission.missions[this.type];
      if (nextMissionId in missions) {
        missions[nextMissionId].state = 2;
      }
    });
  }

  /**
   * 初始化任务进度
   * 
   * 从玩家数据中加载任务进度，根据任务模板注册事件监听器，
   * 监听相关游戏事件以更新任务进度。
   */
  async init() {
    const missionInfo =
      this._player._playerdata.mission.missions[this.type]?.[this.missionId];
    // 防御：数据缺失（每日刷新后新组任务未播种等）标记无效，不 500。
    // 修复：允许空 progress 的播种条目（dailyRefresh 新组任务 progress:[] 由模板 init 构建）——
    // 仅当整个条目缺失/非数组时无效
    if (!missionInfo || !Array.isArray(missionInfo.progress)) {
      this.valid = false;
      return;
    }
    this.value = missionInfo.progress[0]?.value ?? 0;
    this.progress = missionInfo.progress;
    this.state = missionInfo.state;
    let template: keyof typeof MissionTemplates;
    let mission: MissionData | undefined;
    if (this.type == "ACTIVITY") {
      // 活动任务（奇象巡展 1arkhubActivity_* / 53sideActivity_* 等）不在 MissionTable——
      // 定义在 ActivityTable.missionData（id/template/param/rewards）。原实现直接 return
      // （无监听器、进度全假）；现按模板注册监听器，事件驱动真实进度。
      // 注意：taskData 与 MissionData 同构（id/template/param），生成类型已声明为 MissionData[]。
      const actMission = excel.ActivityTable?.missionData?.find(
        (m) => m.id === this.missionId,
      );
      if (!actMission) {
        this.valid = false;
        logger.debug("MissionManager", `Activity mission ${this.missionId} not found in ActivityTable.missionData`);
        return;
      }
      if (actMission.template in MissionTemplates) {
        template = actMission.template as keyof typeof MissionTemplates;
        this.param = actMission.param;
        // 后续 `if (mission)` 分支依赖 mission 非空——活动任务从 missionData 取
        mission = actMission;
      } else {
        this.valid = false;
        logger.debug("MissionManager", `Invalid activity template: ${actMission.template} (${this.missionId})`);
        return;
      }
    } else if (this.type == "OPENSERVER") {
      // 开服任务数据缺失容错（excel 未初始化/版本错位）——标记无效并降级日志，避免 unhandled rejection
      const schedule = excel.OpenServerTable?.schedule;
      const group = schedule?.find((v) =>
        checkBetween(
          this._player._playerdata.status.registerTs,
          v.startTs,
          v.endTs,
        ),
      )?.id;
      if (!group) {
        this.valid = false;
        logger.debug("MissionManager", `OpenServer schedule not found (${this.missionId})`);
        return;
      }
      mission = excel.OpenServerTable!.dataMap[group].openServerMissionData.find(
        (m) => m.id == this.missionId,
      );
      if (!mission) {
        this.valid = false;
        logger.debug("MissionManager", `Mission ID ${this.missionId} not found in OpenServer data`);
        return;
      }
    } else if (this.type == "SPECIAL_OPERATOR") {
      // 特勤干员任务（电弧/机械师解锁任务）不在 MissionTable——
      // 定义在 SpecialOperatorTable.nodeUnlockMissionData（type=SPECIAL_OPERATOR）。
      mission = excel.SpecialOperatorTable?.nodeUnlockMissionData?.[this.missionId];
      if (!mission) {
        this.valid = false;
        logger.debug("MissionManager", `Special operator mission ${this.missionId} not found in SpecialOperatorTable.nodeUnlockMissionData`);
        return;
      }
    } else {
      // excel 未初始化/表缺失时 mission 为 undefined → 走下方「任务不存在」降级分支（valid=false + debug）
      mission = excel.MissionTable?.missions?.[this.missionId];
    }
    if (mission) {
      if (mission.template in MissionTemplates) {
        template = mission.template as keyof typeof MissionTemplates;
        this.param = mission.param;
      } else {
        // 模板无效（数据版本错位）——标记无效并降级日志
        this.valid = false;
        logger.debug("MissionManager", `Invalid template: ${mission.template} (${this.missionId})`);
        return;
      }
    } else {
      // 任务不存在（旧版本存档任务在新数据中缺失——版本更新后常见）：
      // 标记无效并降级日志（debug），避免 ERROR 刷屏；init 循环跳过
      this.valid = false;
      logger.debug("MissionManager", `Mission ID ${this.missionId} not found in data`);
      return;
    }
    // 防御：模板分支校验——模板 key 合法但 param[0] 分支在该模板中未定义时，
    // MissionTemplates[template][param[0]] 为 undefined，事件触发 func 会抛
    // "Cannot read properties of undefined (reading 'update')"。此类任务（rogue/
    // 活动里模板与 param 分支不匹配）标记无效并降级日志，不注册监听器。
    const tpl = MissionTemplates[template]?.[this.param[0]];
    if (!tpl?.update || !tpl?.init) {
      this.valid = false;
      logger.debug(
        "MissionManager",
        `Template branch not implemented: ${template}/${this.param[0]} (${this.missionId})`,
      );
      return;
    }
    const func = async ([args]: unknown[]) => {
      tpl.update(this, args as never);
      if (this.progress[0].value >= this.progress[0].target!) {
        logger.info("MissionManager", `${this.missionId} complete`);
        this._trigger.off(template, func);
        await this._player.update(async (draft) => {
          draft.mission.missions[this.type][this.missionId].state = 3;
          // 修复：写回同一引用不产生 Immer patch → 进度值不进 delta，客户端进度条停滞；
          // 复制为新数组使 Immer 生成 replace patch，进度随 delta 下发
          draft.mission.missions[this.type][this.missionId].progress = [
            ...this.progress,
          ];
        });
        await this.unlockNextMission();
      } else {
        // 修复：getState 移出 recipe——Emittery.emit 并行执行所有监听器，多个同模板
        // 任务同时推进时，各 update() 的 recipe 内 await getState() 产生交错：
        // 一个 listener 的 finishDraft 撤销 draft 后，另一个 listener 的 recipe 继续
        // 写已撤销代理 → "Cannot perform 'set' on a proxy that has been revoked"，
        // 任务状态不落盘（无法完成/确认）。先算好 state，recipe 内不再 await。
        const nextState = await this.getState();
        await this._player.update(async (draft) => {
          draft.mission.missions[this.type][this.missionId].progress = [
            ...this.progress,
          ];
          draft.mission.missions[this.type][this.missionId].state = nextState;
        });
      }
    };
    // 修复：模板 init 仅在进度为空时构建进度（原实现每次 init 都 push →
    // 存档进度数组随每次刷新/加载重复累加，1.json 已出现 29 份重复条目、
    // 且 getState 读 progress[0] 恒为旧值）；已有 progress[0] 时直接沿用存档进度
    if (this.progress.length === 0) {
      tpl.init(this);
    }
    if (this.progress[0] && this.progress[0].value < this.progress[0].target!) {
      this._registeredTemplate = template;
      this._registeredFunc = func;
      this._trigger.on(template, func);
    }
  }

  /**
   * 退订本任务注册的事件监听器
   *
   * 每日/每周刷新重建任务列表时调用——原实现旧实例监听器永不移除：
   * 既泄漏（每次刷新叠加数百监听器），又会让旧实例把过期进度写回新任务。
   */
  unsubscribe(): void {
    if (this._registeredTemplate && this._registeredFunc) {
      this._trigger.off(
        this._registeredTemplate,
        this._registeredFunc as never,
      );
      this._registeredTemplate = null;
      this._registeredFunc = null;
    }
  }
}
import { MissionTemplates } from "./templates";
import type { MissionInfo } from "./templates/types";

export { MissionTemplates };
export type { MissionInfo };

