/**
 * 怪猎对决（EnemyDuel）实时会话服——消息类型号
 *
 * 照抄参考实现 `OpenBachelorSS/pkg/contract/messages.go:11-34`（该实现为逆向所得，
 * 类型号已由抓包 round-trip 验证）。未注册的类型号按 `UnknownMessage` 原样透传。
 */

/** 消息域（本仓只实现怪猎对决；参考实现的 icebreaker 8544 是空壳，不移植） */
export const ENEMY_DUEL_DOMAIN = "enemyDuel";

/** 服务端 → 客户端 类型号 */
export const S2C = {
  /** 表情 */
  Emoji: 224,
  /** 心跳回包 */
  HeartBeat: 2,
  /** 退出通知 */
  Quit: 204,
  /** 步骤同步（状态机每 tick 推一次） */
  Step: 210,
  /** 客户端状态（阶段/回合/截止时间/下注/排行榜） */
  ClientState: 214,
  /** 加入场景结果 */
  Join: 220,
  /** 对局结束 */
  End: 206,
  /** 历史步骤回放 */
  History: 212,
  /** 组队加入结果 */
  TeamJoin: 602,
  /** 踢出 */
  Kick: 714,
  /** 队伍状态 */
  TeamStatus: 702,
} as const;

/** 客户端 → 服务端 类型号 */
export const C2S = {
  /** 表情 */
  Emoji: 223,
  /** 准备 */
  Ready: 201,
  /** 加入场景 */
  Join: 219,
  /** 回合结算（上报本方胜者） */
  RoundSettle: 217,
  /** 下注 */
  Bet: 215,
  /** 拉取历史步骤 */
  History: 211,
  /** 退出 */
  Quit: 203,
  /** 心跳 */
  HeartBeat: 1,
  /** 最终结算 */
  FinalSettle: 221,
  /** 组队加入 */
  TeamJoin: 601,
} as const;

/** 状态机的客户端阶段号（S2C ClientState.state） */
export const PHASE = {
  /** 入场（Entry，3s） */
  Entry: 1,
  /** 下注（Bet，20s） */
  Bet: 2,
  /** 战斗（Battle，150s） */
  Battle: 3,
  /** 结算（Settle，10s） */
  Settle: 4,
  /** 结束（Finish，10s） */
  Finish: 5,
} as const;

/** 队伍状态号（S2C TeamStatus.state，参考实现固定 3=可加入） */
export const TEAM_STATE_JOINABLE = 3;

/** 超时未上报胜者时用的双方标记（参考实现 `0b11`） */
export const SIDE_BOTH = 0b11;
