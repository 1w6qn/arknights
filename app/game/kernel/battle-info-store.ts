/**
 * 战斗信息存储接口模块
 *
 * 定义 BattleInfo / BattleRecord 数据结构与 BattleInfoStore 存储接口。
 * 独立于 AccountManager，供 PlayerDataManager 通过构造器注入使用，
 * 避免 PlayerDataManager 与 AccountManager 之间的循环依赖。
 */
import type { ItemBundle } from "@excel/excel";
import type { SquadFriendData } from "./model";

/**
 * 战斗信息接口（battle_infos 表：结算所需的最小上下文，战斗期间即写入）
 */
export interface BattleInfo {
  stageId: string;
  isPractice: number;
  /**
   * 本场是否为代理指挥（自动作战）开局（battleStart 请求的 isReplay 字段）
   *
   * 修复（2026-09-09）：任务「使用代理指挥完成任意关卡」（guide_16，StageWithReplay 模板）
   * 依赖该字段，原实现 start 未保存、finish 也未 emit → 任务永久卡死。
   */
  isReplay?: number;

  /**
   * 本场战斗开始时已预扣的理智（0/缺省 = 未扣：演习、免体力、apProtect 期间）
   *
   * 修复（2026-09-09）：理智改由 battleStart 预扣，finish 失败返还以此为上限。
   */
  apCharged?: number;

  /**
   * 是否已完成结算（一次性标记）
   *
   * 修复（2026-09-09）：battleFinish 无幂等——battleStart 写入的 battleInfo 结算后仍保留，
   * 重放同一 battleFinish 请求可反复获得 EXP/龙门币/掉落/通关次数。
   * 结算成功后置 1，再次结算直接拒绝。
   */
  settled?: number;
  /** 出战编队（用于结算信赖等后处理） */
  squad?: { slots: ({ charInstId: number } | null)[] };
  /**
   * 助战好友信息（battleStart 快照 CommonStartBattleRequest.assistFriend 原样保存）
   *
   * 修复：原为内联的子集结构（uid/nickName/assistChar/assistSlotIndex），
   * 与事件契约 StageWithAssistChar 的 SquadFriendData 不一致，逼出 `as any`。
   */
  assistFriend?: SquadFriendData | null;
}

/**
 * 战斗来源
 */
export type BattleSource = "quest" | "rlv2";

/**
 * 战斗结束记录（battle_records 表留存数据，供未来分析）
 *
 * 在战斗结算完成后持久化完整的解析结果——相比仅存结算上下文（BattleInfo），
 * 本记录汇聚了战斗统计摘要 + 结算奖励 + 完整遍历统计，用于掉落经济、干员强度、
 * 关卡难度等长期分析，不随会话结束而丢失。
 */
export interface BattleRecord {
  /** 战斗唯一标识（crypto.randomUUID 生成） */
  battleId: string;
  /** 所属账号 uid */
  uid: string;
  /** 关卡 id */
  stageId: string;
  /** 是否演习（1=演习，0=正式结算） */
  isPractice: number;
  /** 战斗来源（游戏内常规战斗 / 肉鸽 rlv2） */
  source: BattleSource;
  /** 结算星级（1=失败，2=通关，3=三星，4=……） */
  completeState: number;
  /** 战斗开始时间戳（秒） */
  beginTs: number;
  /** 战斗结束时间戳（秒） */
  endTs: number;
  /** 击杀数（checkKilledCnt，任务/勋章通用口径） */
  killCnt: number;
  /** 我方造成总伤害 */
  totalDamage: number;
  /** 结算剩余生命（左边血量百分比） */
  leftHp: number;
  /** 我方总治疗量 */
  totalHeal: number;
  /** 有效战斗时长（ms） */
  fixedPlayTime: number;
  /** 参战干员 instId 列表（不含助战） */
  squadInstIds: number[];
  /** 结算奖励摘要（常规+额外+稀有+家具+首通） */
  rewards: ItemBundle[];
  /** 完整战斗统计（BattleStats，含 enemyStats/charStats 等，供深度分析） */
  stats: unknown;
  /** 战报反作弊标识（battleData.isCheat——私服仅留存不校验） */
  isCheat?: string;
  /** 解析后的战斗回放（battleLog 经 decryptBattleReplay 解压，无/解析失败为 undefined） */
  battleLog?: unknown;
  /** 记录创建时间戳（秒） */
  createdTs: number;
}

/**
 * 战斗数据存储接口
 *
 * 提供战斗结算信息（BattleInfo）与战斗结束记录（BattleRecord）的读写能力，
 * 由 AccountManager 实现并注入 PlayerDataManager。解耦对 accountManager 单例的直接依赖。
 */
export interface BattleInfoStore {
  /**
   * 获取战斗结算信息
   *
   * 无对应记录（battleStart 未写入 / 进程重启 / 直接重放 battleFinish）时返回 undefined，
   * 调用方必须显式处理——此前声明为恒有值，逼出实现侧 `as BattleInfo` 与调用侧 `!` 两处断言。
   */
  getBattleInfo(uid: string, battleId: string): Promise<BattleInfo | undefined>;
  /** 保存战斗结算信息 */
  saveBattleInfo(uid: string, battleId: string, info: BattleInfo): Promise<void>;
  /** 留存战斗结束记录（battle_records 表，供未来分析） */
  saveBattleRecord(record: BattleRecord): Promise<void>;
  /** 按账号+战斗 id 读取战斗结束记录（无则 undefined） */
  getBattleRecord(uid: string, battleId: string): Promise<BattleRecord | undefined>;
  /** 按账号读取最近 N 条战斗结束记录（limit 缺省 50，按创建时间倒序） */
  listBattleRecords(uid: string, limit?: number): Promise<BattleRecord[]>;
}