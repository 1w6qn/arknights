/**
 * 怪猎对决（EnemyDuel）实时会话服——六态状态机与对局
 *
 * 逻辑照抄参考实现 `OpenBachelorSS/internal/game/game.go`（Waiting→Entry→Bet→Battle→
 * Settle→Finish，100ms tick，下注赔付与护盾规则）。与 Go 版的差异只在并发模型：
 * Go 用 goroutine + channel，本仓用单线程事件循环 + `setInterval`，`tick()` 也可由
 * 测试用假时钟手动推进（`autoRun: false`）。
 */
import { logger } from "@utils/logger";
import {
  C2SEnemyDuelBet,
  C2SEnemyDuelEmoji,
  C2SEnemyDuelHeartBeat,
  C2SEnemyDuelJoin,
  C2SEnemyDuelQuit,
  C2SEnemyDuelReady,
  C2SEnemyDuelRoundSettle,
  C2SEnemyDuelTeamJoin,
  EnemyDuelBattleStatusRoundLeaderBoard,
  makeClientState,
  makeClientStateForBet,
  makeClientStateForEntry,
  makeClientStateForSettle,
  makeEmoji,
  makeEnd,
  makeFinalSettle,
  makeHeartBeat,
  makeJoin,
  makeKick,
  makeQuit,
  makeStep,
  makeTeamJoin,
  makeTeamStatus,
  phaseName,
  TIMEOUT_SIDE,
  type EnemyDuelMessage,
} from "./payloads";
import { PHASE } from "./messages";

/** 会话抽象（server.ts 提供 TCP 实现；game 层只依赖此接口，便于单测注入假会话） */
export interface EnemyDuelSession {
  /** 发送一条服务端消息 */
  send(msg: EnemyDuelMessage): void;
  /** 连接是否已关闭 */
  isClosed(): boolean;
  /** 关闭连接 */
  close(): void;
}

/** 玩家对局运行态（CS 侧只暴露外部 id） */
export class EnemyDuelPlayerRuntime {
  /** 客户端传的真实 playerId */
  playerId = "";
  /** 内部序号（外部 id = 100 + 此值） */
  internalPlayerId = 0;
  /** 金币 */
  money = 0;
  /** 护盾状态 */
  shieldState = 0;
  /** 连胜 */
  streak = 0;
  /** 本回合下注阵营 */
  side = 0;
  /** 是否 all-in */
  allIn = 0;
  /** 上报的胜方 */
  reportSide = 0;
  /** 是否已准备 */
  isReady = false;

  /** @returns 外部玩家 id（`100` + 内部序号） */
  getExternalPlayerId(): string {
    return externalPlayerIdOf(this.internalPlayerId);
  }
}

/** 会话在游戏侧的挂载状态 */
export class EnemyDuelSessionGameStatus {
  /** 玩家运行态 */
  readonly player = new EnemyDuelPlayerRuntime();
  /** 所属对局（加入后才有） */
  game: EnemyDuelGame | null = null;
  /** 最近活跃时间（毫秒；心跳/任意消息刷新，用于回收死连接） */
  lastActiveTime = 0;
}

/** 内部序号 → 外部玩家 id */
export function externalPlayerIdOf(internalPlayerId: number): string {
  return String(100 + internalPlayerId);
}

/** 回合下注金额表（round → 基础金额） */
const ROUND_MONEY_MAP: Record<number, number> = {
  0: 2000,
  1: 2400,
  2: 3000,
  3: 4000,
  4: 5500,
  5: 8000,
  6: 12000,
  7: 18000,
  8: 30000,
  9: 50000,
};

/** 对局可注入选项（时钟/随机数/定时器便于测试用假实现） */
export interface EnemyDuelGameOptions {
  /** 单人模式：所需人数压成 1 */
  singlePlayer: boolean;
  /** Waiting 态上限（秒） */
  waitSec: number;
  /** 时钟（毫秒），缺省 `Date.now` */
  now?: () => number;
  /** uint32 随机数，缺省 `Math.random` 实现 */
  randomUint32?: () => number;
  /** tick 间隔毫秒，缺省 100 */
  tickMs?: number;
  /** 是否自动起 tick 定时器（缺省 true；测试用假时钟时设 false 手动 tick） */
  autoRun?: boolean;
  /** 日志回调（缺省写 logger） */
  onLog?: (message: string) => void;
}

/** 默认 uint32 随机数 */
function defaultRandomUint32(): number {
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** 非零 uint32 随机数（种子不能为 0） */
function nonZeroRandomUint32(random: () => number): number {
  for (;;) {
    const v = random() >>> 0;
    if (v !== 0) return v;
  }
}

/** 状态机基类：记录进入时间与强制退出时间 */
abstract class EnemyDuelGameStateBase {
  /** 所属对局 */
  readonly game: EnemyDuelGame;
  /** 进入时间（毫秒） */
  enterTime = 0;
  /** 强制退出时间（毫秒） */
  forceExitTime = 0;

  /**
   * @param game 所属对局
   */
  constructor(game: EnemyDuelGame) {
    this.game = game;
  }

  /** 记录进入时间 */
  setEnterTime(): void {
    this.enterTime = this.game.now();
  }

  /**
   * 设置强制退出时间
   * @param ms 时长（毫秒）
   */
  setForceExitTime(ms: number): void {
    this.forceExitTime = this.enterTime + ms;
  }

  /** 阶段进入 */
  abstract onEnter(): void;
  /** 阶段退出 */
  abstract onExit(): void;
  /** 每 tick 推进 */
  abstract update(): void;
}

/** 等待开局（等 ready 或 waitSec 超时） */
class EnemyDuelWaitingState extends EnemyDuelGameStateBase {
  /** 进入等待，超时 = waitSec */
  onEnter(): void {
    this.setEnterTime();
    this.setForceExitTime(this.game.opts.waitSec * 1000);
  }

  /** 无副作用 */
  onExit(): void {
    // 无
  }

  /** 全员 ready 或超时 → Entry */
  update(): void {
    if (this.game.isAllPlayerReady() || this.game.now() > this.forceExitTime) {
      this.game.setNoNewSession();
      this.game.setState(new EnemyDuelEntryState(this.game));
    }
  }
}

/** 入场（3s，推种子 + 每 tick 步骤） */
class EnemyDuelEntryState extends EnemyDuelGameStateBase {
  /** 本回合入场种子 */
  seed = 0;

  /** 生成种子、清步骤/状态并推入场状态包 */
  onEnter(): void {
    this.setEnterTime();
    this.setForceExitTime(3000);
    this.seed = nonZeroRandomUint32(() => this.game.random());
    this.game.clearStep();
    this.game.clearState();
    for (const session of this.game.getSessions().keys()) {
      session.send(
        makeClientStateForEntry(PHASE.Entry, this.game.round, Math.floor(this.forceExitTime / 1000), this.seed),
      );
    }
  }

  /** 无副作用 */
  onExit(): void {
    // 无
  }

  /** 推步骤；超时 → Bet */
  update(): void {
    if (this.game.now() > this.forceExitTime) {
      this.game.setState(new EnemyDuelBetState(this.game));
      return;
    }
    this.game.doStep();
  }
}

/** 下注（20s） */
class EnemyDuelBetState extends EnemyDuelGameStateBase {
  /** 推下注阶段状态包 */
  onEnter(): void {
    this.setEnterTime();
    this.setForceExitTime(20_000);
    for (const session of this.game.getSessions().keys()) {
      session.send(makeClientState(PHASE.Bet, this.game.round, Math.floor(this.forceExitTime / 1000)));
    }
  }

  /** 无副作用 */
  onExit(): void {
    // 无
  }

  /** 超时 → Battle */
  update(): void {
    if (this.game.now() > this.forceExitTime) {
      this.game.setState(new EnemyDuelBattleState(this.game));
    }
  }
}

/** 战斗（150s，等上报胜方或超时） */
class EnemyDuelBattleState extends EnemyDuelGameStateBase {
  /** 推战斗阶段状态包 */
  onEnter(): void {
    this.setEnterTime();
    this.setForceExitTime(150_000);
    for (const session of this.game.getSessions().keys()) {
      session.send(makeClientState(PHASE.Battle, this.game.round, Math.floor(this.forceExitTime / 1000)));
    }
  }

  /** 无副作用 */
  onExit(): void {
    // 无
  }

  /** 有胜方或超时 → Settle；否则推步骤 */
  update(): void {
    let reportSide = this.game.getReportSide();
    if (reportSide !== 0 || this.game.now() > this.forceExitTime) {
      if (reportSide === 0) reportSide = TIMEOUT_SIDE;
      this.game.reportSide = reportSide;
      this.game.setState(new EnemyDuelSettleState(this.game));
      return;
    }
    this.game.doStep();
  }
}

/** 结算（10s） */
class EnemyDuelSettleState extends EnemyDuelGameStateBase {
  /** 计算全员结果并逐个会话推送（自己那条换成真实 playerId） */
  onEnter(): void {
    this.setEnterTime();
    this.setForceExitTime(10_000);
    const allPlayerResult = this.game.getAllPlayerResult();
    for (const [session, status] of this.game.getSessions()) {
      session.send(
        makeClientStateForSettle(
          PHASE.Settle,
          this.game.round,
          Math.floor(this.forceExitTime / 1000),
          allPlayerResult,
          status.player.playerId,
          status.player.getExternalPlayerId(),
        ),
      );
    }
  }

  /** 无副作用 */
  onExit(): void {
    // 无
  }

  /** 超时 → 下一回合 Entry 或 Finish */
  update(): void {
    if (this.game.now() > this.forceExitTime) {
      const maxRound = this.game.getMaxRound();
      if (this.game.round + 1 >= maxRound) {
        this.game.setState(new EnemyDuelFinishState(this.game));
      } else {
        this.game.round += 1;
        this.game.setState(new EnemyDuelEntryState(this.game));
      }
    }
  }
}

/** 结束（推 finish 状态，退出时发最终结算 + 结束包） */
class EnemyDuelFinishState extends EnemyDuelGameStateBase {
  /** 推 finish 阶段状态包 */
  onEnter(): void {
    this.setEnterTime();
    this.setForceExitTime(10_000);
    for (const session of this.game.getSessions().keys()) {
      session.send(makeClientState(PHASE.Finish, this.game.round, Math.floor(this.forceExitTime / 1000)));
    }
  }

  /** 向所有会话发最终结算（C2S 镜像）与结束包 */
  onExit(): void {
    for (const session of this.game.getSessions().keys()) {
      session.send(makeFinalSettle());
      session.send(makeEnd());
    }
  }

  /** 立即结束对局（state = null → tick 停） */
  update(): void {
    this.game.setState(null);
  }
}

/** 对局：六态状态机 + 会话表 + 下注/赔付 */
export class EnemyDuelGame {
  /** 对局 id（`sceneId|modeId|stageId`） */
  readonly gameId: string;
  /** 模式 id */
  readonly modeId: string;
  /** 关卡 id */
  readonly stageId: string;
  /** 玩法可调参数 */
  readonly opts: Required<Pick<EnemyDuelGameOptions, "singlePlayer" | "waitSec" | "now" | "randomUint32" | "tickMs" | "autoRun">>;
  /** 关卡种子 */
  readonly seed: number;

  /** 当前回合 */
  round = 0;
  /** 步骤计数 */
  step = 0;
  /** 本回合实际胜方 */
  reportSide = 0;

  /** 会话 → 玩家状态 */
  private readonly _sessions = new Map<EnemyDuelSession, EnemyDuelSessionGameStatus>();
  /** 下一个内部序号 */
  private _nextInternalPlayerId = 0;
  /** 是否不再接受新会话（Waiting 结束时置位） */
  private _noNewSession = false;
  /** 当前状态（null = 已结束） */
  private _state: EnemyDuelGameStateBase | null = null;
  /** tick 定时器 */
  private _timer: NodeJS.Timeout | null = null;
  /** 无存活会话的起始时间（0 = 有存活会话） */
  private _noAliveSince = 0;
  /** 是否已停止 */
  private _stopped = false;

  /**
   * @param gameId 对局 id
   * @param modeId 模式 id
   * @param stageId 关卡 id
   * @param opts   参数（时钟/随机数/单人模式等）
   */
  constructor(gameId: string, modeId: string, stageId: string, opts: EnemyDuelGameOptions) {
    this.gameId = gameId;
    this.modeId = modeId;
    this.stageId = stageId;
    this.opts = {
      singlePlayer: opts.singlePlayer,
      waitSec: opts.waitSec,
      now: opts.now ?? Date.now,
      randomUint32: opts.randomUint32 ?? defaultRandomUint32,
      tickMs: opts.tickMs ?? 100,
      autoRun: opts.autoRun ?? true,
    };
    this._log = opts.onLog ?? ((m: string) => logger.debug("enemyDuel-session", m));
    this.seed = nonZeroRandomUint32(() => this.random());
    this.setState(new EnemyDuelWaitingState(this));
  }

  /** 日志输出 */
  private readonly _log: (message: string) => void;

  /** @returns 当前毫秒时间戳 */
  now(): number {
    return this.opts.now();
  }

  /** @returns uint32 随机数 */
  random(): number {
    return this.opts.randomUint32();
  }

  /** @returns 会话表快照 */
  getSessions(): Map<EnemyDuelSession, EnemyDuelSessionGameStatus> {
    return new Map(this._sessions);
  }

  /** @returns 存活会话数 */
  get sessionCount(): number {
    return this._sessions.size;
  }

  /** @returns 是否已停止 */
  get stopped(): boolean {
    return this._stopped;
  }

  /**
   * 切换状态（先退出旧状态再进入新状态；传 null 表示结束）
   * @param next 新状态
   */
  setState(next: EnemyDuelGameStateBase | null): void {
    if (this._state) this._state.onExit();
    this._state = next;
    if (this._state) this._state.onEnter();
    this._log(`${this.gameId} 状态 → ${this.currentPhaseName()}（round=${this.round}）`);
  }

  /**
   * 加入会话（对局满 / 已闭门时失败）
   * @param session 会话
   * @param status  会话状态
   * @returns 成功与否
   */
  addSession(session: EnemyDuelSession, status: EnemyDuelSessionGameStatus): boolean {
    if (this._noNewSession) return false;
    if (this._nextInternalPlayerId >= this.getMaxNumPlayer()) return false;
    this._sessions.set(session, status);
    status.game = this;
    status.player.internalPlayerId = this._nextInternalPlayerId;
    this._nextInternalPlayerId += 1;
    return true;
  }

  /** 闭门（不再接受新会话） */
  setNoNewSession(): void {
    this._noNewSession = true;
  }

  /** 启动 100ms tick 循环（autoRun 时才需调用；测试可手动 tick） */
  run(): void {
    if (!this.opts.autoRun) return;
    if (this._timer || this._stopped) return;
    this._timer = setInterval(() => this.tick(), this.opts.tickMs);
    this._timer.unref?.();
  }

  /** 停止对局（清定时器；幂等） */
  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._state = null;
  }

  /**
   * 推进一帧（状态机 update；无存活会话满 1s 或状态为 null 时自动停止）
   */
  tick(): void {
    if (this._stopped) return;
    const now = this.now();
    if (!this.hasAliveSession()) {
      if (this._noAliveSince === 0) this._noAliveSince = now;
      if (now - this._noAliveSince >= 1000) {
        this.stop();
        return;
      }
    } else {
      this._noAliveSince = 0;
    }
    if (this._state) this._state.update();
    else this.stop();
  }

  /** @returns 本模式最大回合数（未知模式 255） */
  getMaxRound(): number {
    return this.modeId === "multiOperationMatch" ? 10 : 0xff;
  }

  /** @returns 本模式最大人数（未知模式 30） */
  getMaxNumPlayer(): number {
    return this.modeId === "multiOperationMatch" ? 8 : 30;
  }

  /** 给所有会话推一步步骤包 */
  doStep(): void {
    for (const session of this._sessions.keys()) {
      session.send(makeStep(this.step, this.round));
    }
    this.step += 1;
  }

  /** 步骤计数归零 */
  clearStep(): void {
    this.step = 0;
  }

  /** 清空全员下注/上报态 */
  clearState(): void {
    for (const status of this._sessions.values()) {
      status.player.side = 0;
      status.player.allIn = 0;
      status.player.reportSide = 0;
    }
  }

  /**
   * 多数票统计上报的胜方
   * @returns 得票最多的阵营（全 0 时返回 0）
   */
  getReportSide(): number {
    const counts = new Map<number, number>();
    for (const [session, status] of this._sessions) {
      if (session.isClosed()) continue;
      const side = status.player.reportSide;
      counts.set(side, (counts.get(side) ?? 0) + 1);
    }
    let reportSide = 0;
    let best = 0;
    for (const [side, count] of counts) {
      if (count > best) {
        reportSide = side;
        best = count;
      }
    }
    return reportSide;
  }

  /** @returns 是否存在存活会话 */
  hasAliveSession(): boolean {
    for (const session of this._sessions.keys()) {
      if (!session.isClosed()) return true;
    }
    return false;
  }

  /** 回收已关闭连接的会话条目 */
  pruneClosedSessions(): void {
    for (const session of [...this._sessions.keys()]) {
      if (session.isClosed()) this._sessions.delete(session);
    }
  }

  /**
   * 处理表情：广播给自己（真实 id）与他人（外部 id）
   *
   * 注意：参考实现里「他人」那条用的是**发送者**的外部 id（`game.go:602-614`），
   * 这里照抄以保持线级行为一致。
   * @param sender 发送者会话
   * @param status 发送者状态
   * @param emojiGroup 表情组
   * @param emojiId 表情 id
   */
  handleEmojiMessage(sender: EnemyDuelSession, status: EnemyDuelSessionGameStatus, emojiGroup: string, emojiId: string): void {
    for (const session of this._sessions.keys()) {
      const playerId = session === sender ? status.player.playerId : status.player.getExternalPlayerId();
      session.send(makeEmoji(emojiGroup, emojiId, playerId));
    }
  }

  /**
   * 处理下注（仅 Bet 阶段生效）：记录并广播状态包
   * @param sender 发送者会话
   * @param status 发送者状态
   * @param side 阵营
   * @param allIn 是否 all-in
   */
  handleBetMessage(sender: EnemyDuelSession, status: EnemyDuelSessionGameStatus, side: number, allIn: number): void {
    if (!(this._state instanceof EnemyDuelBetState)) return;
    status.player.side = side;
    status.player.allIn = allIn;
    for (const session of this._sessions.keys()) {
      const playerId = session === sender ? status.player.playerId : status.player.getExternalPlayerId();
      session.send(
        makeClientStateForBet(
          PHASE.Bet,
          this.round,
          Math.floor(this._state.forceExitTime / 1000),
          playerId,
          status.player.side,
          status.player.allIn,
          status.player.streak,
        ),
      );
    }
  }

  /**
   * 除自己外的全部外部 id
   * @param internalPlayerId 自己内部序号
   * @returns 外部 id 列表
   */
  getOtherPlayerIdSlice(internalPlayerId: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.getMaxNumPlayer(); i += 1) {
      if (i === internalPlayerId) continue;
      out.push(externalPlayerIdOf(i));
    }
    return out;
  }

  /**
   * 初始化玩家金币/护盾
   * @param status 玩家状态
   * @param playerId 真实 playerId
   */
  initPlayerStatus(status: EnemyDuelSessionGameStatus, playerId: string): void {
    status.player.playerId = playerId;
    if (this.modeId === "multiOperationMatch") {
      status.player.money = 10000;
      return;
    }
    status.player.money = 1;
    status.player.shieldState = 2;
  }

  /** @returns 本回合基础下注金额 */
  getRoundMoney(): number {
    return ROUND_MONEY_MAP[this.round] ?? 50000;
  }

  /**
   * 单个玩家本回合结算
   * @param status 玩家状态
   * @returns 结算条目（playerId 为外部 id）
   */
  getPlayerResult(status: EnemyDuelSessionGameStatus): EnemyDuelBattleStatusRoundLeaderBoard {
    const p = status.player;
    if (p.shieldState === 1) p.shieldState = 0;
    if ((p.side & 0b11) === 0b11) p.side = 0;

    let won = p.money > 0 && (this.reportSide & p.side) !== 0;
    const skip = p.side === 0;

    const entry = new EnemyDuelBattleStatusRoundLeaderBoard();
    entry.playerId = p.getExternalPlayerId();
    entry.oldMoney = p.money;
    entry.result = this.reportSide;
    entry.bet = p.side;

    if (this.modeId === "multiOperationMatch") {
      const roundMoney = this.getRoundMoney();
      if (won) {
        p.streak += 1;
        p.money += p.allIn !== 0 ? 2 * roundMoney : roundMoney;
      } else {
        p.streak = 0;
        if (!won && !skip) {
          if (p.allIn !== 0) p.money = 0;
          else p.money -= roundMoney;
        }
      }
      entry.newMoney = p.money;
      entry.streak = p.streak;
      if (p.money > 0) entry.maxRound = this.round + 1;
      return entry;
    }

    if (this.round < 5) {
      if (!won && p.shieldState === 2) {
        won = true;
        p.shieldState = 1;
      }
    } else {
      p.shieldState = 0;
    }
    if (!won) p.money = 0;
    entry.newMoney = p.money;
    entry.shieldState = p.shieldState;
    if (p.money > 0) entry.maxRound = this.round + 1;
    return entry;
  }

  /**
   * 全员结算（含未入场的空条目）
   * @returns 外部 id → 结算条目
   */
  getAllPlayerResult(): Map<string, EnemyDuelBattleStatusRoundLeaderBoard> {
    const all = new Map<string, EnemyDuelBattleStatusRoundLeaderBoard>();
    for (const status of this._sessions.values()) {
      const entry = this.getPlayerResult(status);
      all.set(entry.playerId, entry);
    }
    for (let i = 0; i < this.getMaxNumPlayer(); i += 1) {
      const id = externalPlayerIdOf(i);
      if (!all.has(id)) {
        const empty = new EnemyDuelBattleStatusRoundLeaderBoard();
        empty.playerId = id;
        all.set(id, empty);
      }
    }
    return all;
  }

  /** @returns 是否达到开局人数且全员已 ready */
  isAllPlayerReady(): boolean {
    const required = this.opts.singlePlayer ? 1 : this.getMaxNumPlayer();
    if (this._sessions.size < required) return false;
    for (const status of this._sessions.values()) {
      if (!status.player.isReady) return false;
    }
    return true;
  }

  /** @returns 当前阶段名（日志用） */
  currentPhaseName(): string {
    if (!this._state) return "Stopped";
    if (this._state instanceof EnemyDuelWaitingState) return "Waiting";
    return phaseName(this._stateOfPhase());
  }

  /** 当前状态 → 客户端阶段号（日志用；Waiting 归 0） */
  private _stateOfPhase(): number {
    if (this._state instanceof EnemyDuelEntryState) return PHASE.Entry;
    if (this._state instanceof EnemyDuelBetState) return PHASE.Bet;
    if (this._state instanceof EnemyDuelBattleState) return PHASE.Battle;
    if (this._state instanceof EnemyDuelSettleState) return PHASE.Settle;
    if (this._state instanceof EnemyDuelFinishState) return PHASE.Finish;
    return 0;
  }
}

/** 对局注册表（按 gameId 复用；参考实现 game.go 的全局 map 收进类里便于测试隔离） */
export class EnemyDuelGameRegistry {
  /** gameId → 对局 */
  private readonly _games = new Map<string, EnemyDuelGame>();
  /** 是否停止接受新对局 */
  private _noNewGame = false;
  /** 对局选项 */
  private readonly _opts: EnemyDuelGameOptions;

  /**
   * @param opts 对局选项（时钟/随机数/单人模式等）
   */
  constructor(opts: EnemyDuelGameOptions) {
    this._opts = opts;
  }

  /** @returns 当前对局数 */
  get size(): number {
    return this._games.size;
  }

  /**
   * 取或建对局
   * @param gameId 对局 id
   * @param modeId 模式 id
   * @param stageId 关卡 id
   * @returns 对局；已停止接受新对局且不存在时返回 null
   */
  getOrCreate(gameId: string, modeId: string, stageId: string): EnemyDuelGame | null {
    const existing = this._games.get(gameId);
    if (existing) return existing;
    if (this._noNewGame) return null;
    const game = new EnemyDuelGame(gameId, modeId, stageId, this._opts);
    this._games.set(gameId, game);
    game.run();
    return game;
  }

  /**
   * 按 id 取对局
   * @param gameId 对局 id
   * @returns 对局或 undefined
   */
  get(gameId: string): EnemyDuelGame | undefined {
    return this._games.get(gameId);
  }

  /**
   * 回收已停止的对局
   */
  prune(): void {
    for (const [id, game] of [...this._games]) {
      if (game.stopped) {
        game.stop();
        this._games.delete(id);
      }
    }
  }

  /** 停止全部对局并闭门 */
  stopAll(): void {
    this._noNewGame = true;
    for (const game of this._games.values()) game.stop();
    this._games.clear();
  }
}

/** `modeId|stageId` 拆解结果 */
export interface EnemyDuelModeStage {
  /** 模式 id */
  modeId: string;
  /** 关卡 id */
  stageId: string;
}

/**
 * 解析队伍令牌（`modeId|stageId`；HTTP 侧 serverToken 与客户端原样带回）
 * @param teamToken 队伍令牌
 * @returns 解析结果；无 `|` 分隔符时返回 null
 */
export function parseModeIdStageId(teamToken: string): EnemyDuelModeStage | null {
  const parts = teamToken.split("|");
  if (parts.length < 2) return null;
  return { modeId: parts[0], stageId: parts[1] };
}

/** 会话消息处理上下文 */
export interface EnemyDuelMessageContext {
  /** 对局注册表 */
  registry: EnemyDuelGameRegistry;
  /** 会话服对外地址（host:port，用于 TeamStatus.Address） */
  address: string;
  /** 时钟（毫秒），缺省 `Date.now` */
  now?: () => number;
}

/**
 * 处理一条客户端消息（对照 `game.go#handleSessionMessageEnemyDuel`）
 * @param ctx 上下文
 * @param session 会话
 * @param status 会话在游戏侧状态
 * @param msg 解码后的消息
 */
export function handleEnemyDuelMessage(
  ctx: EnemyDuelMessageContext,
  session: EnemyDuelSession,
  status: EnemyDuelSessionGameStatus,
  msg: EnemyDuelMessage,
): void {
  const now = (ctx.now ?? Date.now)();
  status.lastActiveTime = now;

  if (msg instanceof C2SEnemyDuelHeartBeat) {
    session.send(makeHeartBeat(msg.seq, msg.time));
    return;
  }

  if (msg instanceof C2SEnemyDuelQuit) {
    session.send(makeQuit());
    return;
  }

  if (msg instanceof C2SEnemyDuelTeamJoin) {
    const parsed = parseModeIdStageId(msg.teamToken);
    if (!parsed) {
      logger.warn("enemyDuel-session", `队伍令牌非法（缺少 modeId|stageId）：${msg.teamToken}`);
      session.send(makeKick());
      return;
    }
    const gameId = `${msg.teamId}|${parsed.modeId}|${parsed.stageId}`;
    const game = ctx.registry.getOrCreate(gameId, parsed.modeId, parsed.stageId);
    if (!game) {
      session.send(makeKick());
      return;
    }
    session.send(makeTeamJoin());
    session.send(makeTeamStatus(msg.teamId, msg.teamToken, ctx.address));
    // 参考实现用 defer 在函数返回时发 Kick——成功路径上 Kick 排在 TeamStatus 之后
    session.send(makeKick());
    return;
  }

  if (msg instanceof C2SEnemyDuelJoin) {
    const parsed = parseModeIdStageId(msg.token);
    if (!parsed) {
      logger.warn("enemyDuel-session", `加入失败：令牌非法 ${msg.token}`);
      session.send(makeQuit());
      return;
    }
    const gameId = `${msg.sceneId}|${parsed.modeId}|${parsed.stageId}`;
    const game = ctx.registry.get(gameId);
    if (!game) {
      logger.warn("enemyDuel-session", `加入失败：对局不存在 ${gameId}`);
      session.send(makeQuit());
      return;
    }
    if (!game.addSession(session, status)) {
      logger.warn("enemyDuel-session", `加入失败：对局已满/闭门 ${gameId}`);
      session.send(makeQuit());
      return;
    }
    game.initPlayerStatus(status, msg.playerId);
    const others = game.getOtherPlayerIdSlice(status.player.internalPlayerId);
    session.send(
      makeJoin(parsed.stageId, msg.playerId, status.player.getExternalPlayerId(), others, game.seed, Math.floor(now / 1000)),
    );
    logger.info(
      "enemyDuel-session",
      `玩家 ${msg.playerId} 加入对局 ${gameId}（第 ${status.player.internalPlayerId} 位，阶段 ${game.currentPhaseName()}）`,
    );
    return;
  }

  if (msg instanceof C2SEnemyDuelRoundSettle) {
    status.player.reportSide = msg.side;
    return;
  }

  if (msg instanceof C2SEnemyDuelEmoji) {
    status.game?.handleEmojiMessage(session, status, msg.emojiGroup, msg.emojiId);
    return;
  }

  if (msg instanceof C2SEnemyDuelBet) {
    status.game?.handleBetMessage(session, status, msg.side, msg.allIn);
    return;
  }

  if (msg instanceof C2SEnemyDuelReady) {
    status.player.isReady = true;
    return;
  }
}
