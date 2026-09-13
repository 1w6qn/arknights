/**
 * 怪猎对决（EnemyDuel）实时会话服——消息结构（逐字段 marshal/unmarshal）
 *
 * 逐字段照抄参考实现 `OpenBachelorSS/pkg/contract/payloads.go`（含其中的字段序与
 * 整型宽度，以及 Step/Join/TeamStatus 里那几处固定的 2 字节占位）。**不要"顺手优化"**：
 * 字段序错位客户端会直接解错。工厂函数对照 `pkg/contract/factory.go`。
 */
import {
  PayloadReader,
  PayloadWriter,
  type EnemyDuelEnvelope,
} from "./codec";
import { C2S, PHASE, S2C, SIDE_BOTH, TEAM_STATE_JOINABLE } from "./messages";

/** 可序列化消息（服务端按 contentType + marshal 组帧；客户端发来的按注册表解码） */
export interface EnemyDuelMessage {
  /** 线级消息类型号 */
  contentType(): number;
  /** 序列化为 payload */
  marshal(): Buffer;
}

/**
 * 未注册类型号的原样透传（参考实现 `UnknownMessage`）
 */
export class UnknownEnemyDuelMessage implements EnemyDuelMessage {
  /** 消息类型号 */
  readonly type: number;
  /** 原始 payload */
  readonly payload: Buffer;

  /**
   * @param type 消息类型号
   * @param payload 原始消息体
   */
  constructor(type: number, payload: Buffer) {
    this.type = type;
    this.payload = payload;
  }

  /** @returns 原始类型号 */
  contentType(): number {
    return this.type;
  }

  /** @returns 原始 payload 的副本 */
  marshal(): Buffer {
    return Buffer.from(this.payload);
  }
}

/* ===== 复合值类型 ===== */

/** 回合入场数据（CS: Torappu.EnemyDuel.BattleStatusEntryData） */
export class EnemyDuelBattleStatusEntryData {
  /** 回合随机种子 */
  seed = 0;
  /** 种子历史 */
  seedHistory: number[] = [];
  /** 阵营历史（0/1/2） */
  sideHistory: number[] = [];

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt32(this.seed);
    w.writeUInt32Slice(this.seedHistory);
    w.writeUInt8Slice(this.sideHistory);
  }

  /**
   * 按协议顺序读出
   * @param r payload 读取器
   * @returns 解析结果
   */
  static read(r: PayloadReader): EnemyDuelBattleStatusEntryData {
    const v = new EnemyDuelBattleStatusEntryData();
    v.seed = r.readUInt32();
    v.seedHistory = r.readUInt32Slice();
    v.sideHistory = r.readUInt8Slice();
    return v;
  }
}

/** 回合下注条目（CS: Torappu.EnemyDuel.BattleStatusBetItem） */
export class EnemyDuelBattleStatusBetItem {
  /** 玩家 id */
  playerId = "";
  /** 下注阵营 */
  side = 0;
  /** 是否 all-in */
  allIn = 0;
  /** 连胜数 */
  streak = 0;
  /** 更新时间戳（秒） */
  updateTs = 0;

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.playerId);
    w.writeUInt8(this.side);
    w.writeUInt8(this.allIn);
    w.writeUInt8(this.streak);
    w.writeUInt64(this.updateTs);
  }

  /**
   * 按协议顺序读出
   * @param r payload 读取器
   * @returns 解析结果
   */
  static read(r: PayloadReader): EnemyDuelBattleStatusBetItem {
    const v = new EnemyDuelBattleStatusBetItem();
    v.playerId = r.readString();
    v.side = r.readUInt8();
    v.allIn = r.readUInt8();
    v.streak = r.readUInt8();
    v.updateTs = r.readUInt64();
    return v;
  }
}

/** 回合排行榜条目（CS: Torappu.EnemyDuel.BattleStatusRoundLeaderBoard） */
export class EnemyDuelBattleStatusRoundLeaderBoard {
  /** 玩家 id（结算时自己那条被换成真实 playerId） */
  playerId = "";
  /** 回合前金币 */
  oldMoney = 0;
  /** 回合后金币 */
  newMoney = 0;
  /** 到达的最大回合（金币 > 0 时 = round+1） */
  maxRound = 0;
  /** 连胜 */
  streak = 0;
  /** 本回合实际胜方（reportSide，超时为 0b11） */
  result = 0;
  /** 自己的下注阵营 */
  bet = 0;
  /** 护盾状态 */
  shieldState = 0;

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.playerId);
    w.writeUInt32(this.oldMoney);
    w.writeUInt32(this.newMoney);
    w.writeUInt8(this.maxRound);
    w.writeUInt8(this.streak);
    w.writeUInt8(this.result);
    w.writeUInt8(this.bet);
    w.writeUInt8(this.shieldState);
  }

  /**
   * 按协议顺序读出
   * @param r payload 读取器
   * @returns 解析结果
   */
  static read(r: PayloadReader): EnemyDuelBattleStatusRoundLeaderBoard {
    const v = new EnemyDuelBattleStatusRoundLeaderBoard();
    v.playerId = r.readString();
    v.oldMoney = r.readUInt32();
    v.newMoney = r.readUInt32();
    v.maxRound = r.readUInt8();
    v.streak = r.readUInt8();
    v.result = r.readUInt8();
    v.bet = r.readUInt8();
    v.shieldState = r.readUInt8();
    return v;
  }
}

/** 场景内玩家简介（CS: Torappu.EnemyDuel.ServicePlayer） */
export class EnemyDuelServicePlayer {
  /** 玩家 id */
  playerId = "";
  /** 头像 id */
  avatarId = "avatar_def_01";
  /** 昵称（`Bachelor#0100` 形式） */
  nickName = "";
  /** 头像类型 */
  avatarType = "ICON";
  /** 秘书干员 */
  secretary = "";
  /** 秘书皮肤 */
  secretarySkinId = "";
  /** 秘书皮肤 sp 态 */
  secretarySkinSp = 0;
  /** 是否持有护盾 */
  haveShield = 0;

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.playerId);
    w.writeString(this.avatarId);
    w.writeString(this.nickName);
    w.writeString(this.avatarType);
    w.writeString(this.secretary);
    w.writeString(this.secretarySkinId);
    w.writeUInt8(this.secretarySkinSp);
    w.writeUInt8(this.haveShield);
  }

  /**
   * 按协议顺序读出
   * @param r payload 读取器
   * @returns 解析结果
   */
  static read(r: PayloadReader): EnemyDuelServicePlayer {
    const v = new EnemyDuelServicePlayer();
    v.playerId = r.readString();
    v.avatarId = r.readString();
    v.nickName = r.readString();
    v.avatarType = r.readString();
    v.secretary = r.readString();
    v.secretarySkinId = r.readString();
    v.secretarySkinSp = r.readUInt8();
    v.haveShield = r.readUInt8();
    return v;
  }
}

/** 队伍内玩家状态（CS: Torappu.EnemyDuel.PlayerStatus） */
export class EnemyDuelPlayerStatus {
  /** 玩家 id */
  playerId = "";
  /** 昵称 */
  nickName = "";
  /** 头像类型 */
  avatarType = "ICON";
  /** 头像 id */
  avatarId = "avatar_def_01";
  /** 秘书干员 */
  secretary = "";
  /** 秘书皮肤 */
  secretarySkinId = "";
  /** 秘书皮肤 sp 态 */
  secretarySkinSp = 0;
  /** 状态 */
  state = 0;
  /** 是否断线离开 */
  connLeave = 0;
  /** 加入时间戳（秒） */
  joinTs = 0;

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.playerId);
    w.writeString(this.nickName);
    w.writeString(this.avatarType);
    w.writeString(this.avatarId);
    w.writeString(this.secretary);
    w.writeString(this.secretarySkinId);
    w.writeUInt8(this.secretarySkinSp);
    w.writeUInt8(this.state);
    w.writeUInt8(this.connLeave);
    w.writeUInt64(this.joinTs);
  }

  /**
   * 按协议顺序读出
   * @param r payload 读取器
   * @returns 解析结果
   */
  static read(r: PayloadReader): EnemyDuelPlayerStatus {
    const v = new EnemyDuelPlayerStatus();
    v.playerId = r.readString();
    v.nickName = r.readString();
    v.avatarType = r.readString();
    v.avatarId = r.readString();
    v.secretary = r.readString();
    v.secretarySkinId = r.readString();
    v.secretarySkinSp = r.readUInt8();
    v.state = r.readUInt8();
    v.connLeave = r.readUInt8();
    v.joinTs = r.readUInt64();
    return v;
  }
}

/** 历史步骤条目（CS: Torappu.EnemyDuel.ServiceStepData） */
export class EnemyDuelServiceStepData {
  /** 步骤序号 */
  index = 0;
  /** 步长毫秒 */
  duration = 100;
  /** 校验序号（-1 表示不校验） */
  checkSeq = -1;
  /** 回合 */
  round = 0;

  /**
   * 按协议顺序写入（index/duration/2B 占位/checkSeq/round）
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt32(this.index);
    w.writeUInt32(this.duration);
    w.writeReservedZeros();
    w.writeInt32(this.checkSeq);
    w.writeUInt8(this.round);
  }

  /**
   * 按协议顺序读出
   * @param r payload 读取器
   * @returns 解析结果
   */
  static read(r: PayloadReader): EnemyDuelServiceStepData {
    const v = new EnemyDuelServiceStepData();
    v.index = r.readUInt32();
    v.duration = r.readUInt32();
    r.skip(2);
    v.checkSeq = r.readInt32();
    v.round = r.readUInt8();
    return v;
  }
}

/* ===== 服务端 → 客户端 ===== */

/** S2C 表情（224） */
export class S2CEnemyDuelEmoji implements EnemyDuelMessage {
  /** 发送者 id */
  playerId = "";
  /** 表情组 */
  emojiGroup = "";
  /** 表情 id */
  emojiId = "";

  /** @returns 224 */
  contentType(): number {
    return S2C.Emoji;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.playerId);
    w.writeString(this.emojiGroup);
    w.writeString(this.emojiId);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelEmoji {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelEmoji();
    v.playerId = r.readString();
    v.emojiGroup = r.readString();
    v.emojiId = r.readString();
    return v;
  }
}

/** S2C 心跳（2） */
export class S2CEnemyDuelHeartBeat implements EnemyDuelMessage {
  /** 客户端发来的序号（回显） */
  seq = 0;
  /** 客户端发来的时间（回显） */
  time = 0;

  /** @returns 2 */
  contentType(): number {
    return S2C.HeartBeat;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt32(this.seq);
    w.writeUInt64(this.time);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelHeartBeat {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelHeartBeat();
    v.seq = r.readUInt32();
    v.time = r.readUInt64();
    return v;
  }
}

/** S2C 退出（204，空体） */
export class S2CEnemyDuelQuit implements EnemyDuelMessage {
  /** @returns 204 */
  contentType(): number {
    return S2C.Quit;
  }

  /** @returns 空 payload */
  marshal(): Buffer {
    return Buffer.alloc(0);
  }

  /**
   * 解码（空体）
   * @returns 解析结果
   */
  static read(): S2CEnemyDuelQuit {
    return new S2CEnemyDuelQuit();
  }
}

/** S2C 步骤同步（210） */
export class S2CEnemyDuelStep implements EnemyDuelMessage {
  /** 步骤序号 */
  index = 0;
  /** 步长毫秒（固定 100） */
  duration = 100;
  /** 校验序号（-1） */
  checkSeq = -1;
  /** 回合 */
  round = 0;

  /** @returns 210 */
  contentType(): number {
    return S2C.Step;
  }

  /**
   * 按协议顺序写入（index/duration/2B 占位/checkSeq/round）
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt32(this.index);
    w.writeUInt32(this.duration);
    w.writeReservedZeros();
    w.writeInt32(this.checkSeq);
    w.writeUInt8(this.round);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelStep {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelStep();
    v.index = r.readUInt32();
    v.duration = r.readUInt32();
    r.skip(2);
    v.checkSeq = r.readInt32();
    v.round = r.readUInt8();
    return v;
  }
}

/** S2C 客户端状态（214） */
export class S2CEnemyDuelClientState implements EnemyDuelMessage {
  /** 阶段（1..5，见 PHASE） */
  state = 0;
  /** 回合 */
  round = 0;
  /** 阶段强制结束时间戳（秒） */
  forceEndTs = 0;
  /** 入场数据（Entry 阶段带种子） */
  srcEntryData: EnemyDuelBattleStatusEntryData[] = [];
  /** 下注列表 */
  betList: EnemyDuelBattleStatusBetItem[] = [];
  /** 排行榜（Settle 阶段） */
  leaderBoard: EnemyDuelBattleStatusRoundLeaderBoard[] = [];

  /** @returns 214 */
  contentType(): number {
    return S2C.ClientState;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt8(this.state);
    w.writeUInt8(this.round);
    w.writeUInt64(this.forceEndTs);
    writeSlice(w, this.srcEntryData);
    writeSlice(w, this.betList);
    writeSlice(w, this.leaderBoard);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelClientState {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelClientState();
    v.state = r.readUInt8();
    v.round = r.readUInt8();
    v.forceEndTs = r.readUInt64();
    v.srcEntryData = readSlice(r, EnemyDuelBattleStatusEntryData.read);
    v.betList = readSlice(r, EnemyDuelBattleStatusBetItem.read);
    v.leaderBoard = readSlice(r, EnemyDuelBattleStatusRoundLeaderBoard.read);
    return v;
  }
}

/** S2C 加入场景结果（220） */
export class S2CEnemyDuelJoin implements EnemyDuelMessage {
  /** 返回码（0 成功） */
  retCode = 0;
  /** 服务端当前时间（秒） */
  nowTs = 0;
  /** 场景创建时间（秒） */
  sceneCreateTs = 0;
  /** 新令牌（本实现不回填） */
  newToken = "";
  /** 关卡 id */
  stageId = "";
  /** 关卡种子 */
  stageSeed = 0;
  /** 场景内玩家列表 */
  players: EnemyDuelServicePlayer[] = [];

  /** @returns 220 */
  contentType(): number {
    return S2C.Join;
  }

  /**
   * 按协议顺序写入（players 之后固定 2B 占位）
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt32(this.retCode);
    w.writeUInt64(this.nowTs);
    w.writeUInt64(this.sceneCreateTs);
    w.writeString(this.newToken);
    w.writeString(this.stageId);
    w.writeUInt32(this.stageSeed);
    writeSlice(w, this.players);
    w.writeReservedZeros();
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelJoin {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelJoin();
    v.retCode = r.readUInt32();
    v.nowTs = r.readUInt64();
    v.sceneCreateTs = r.readUInt64();
    v.newToken = r.readString();
    v.stageId = r.readString();
    v.stageSeed = r.readUInt32();
    v.players = readSlice(r, EnemyDuelServicePlayer.read);
    r.skip(2);
    return v;
  }
}

/** S2C 对局结束（206） */
export class S2CEnemyDuelEnd implements EnemyDuelMessage {
  /** 结束原因 */
  reason = 0;

  /** @returns 206 */
  contentType(): number {
    return S2C.End;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt8(this.reason);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelEnd {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelEnd();
    v.reason = r.readUInt8();
    return v;
  }
}

/** S2C 历史步骤（212） */
export class S2CEnemyDuelHistory implements EnemyDuelMessage {
  /** 步骤列表 */
  steps: EnemyDuelServiceStepData[] = [];

  /** @returns 212 */
  contentType(): number {
    return S2C.History;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    writeSlice(w, this.steps);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelHistory {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelHistory();
    v.steps = readSlice(r, EnemyDuelServiceStepData.read);
    return v;
  }
}

/** S2C 组队加入结果（602） */
export class S2CEnemyDuelTeamJoin implements EnemyDuelMessage {
  /** 返回码（0 成功） */
  retCode = 0;
  /** 失败原因 */
  reason = "";
  /** 服务端时间（秒） */
  svrTime = 0;

  /** @returns 602 */
  contentType(): number {
    return S2C.TeamJoin;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt32(this.retCode);
    w.writeString(this.reason);
    w.writeUInt64(this.svrTime);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelTeamJoin {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelTeamJoin();
    v.retCode = r.readUInt32();
    v.reason = r.readString();
    v.svrTime = r.readUInt64();
    return v;
  }
}

/** S2C 踢出（714） */
export class S2CEnemyDuelKick implements EnemyDuelMessage {
  /** 原因 */
  reason = 0;

  /** @returns 714 */
  contentType(): number {
    return S2C.Kick;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt8(this.reason);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelKick {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelKick();
    v.reason = r.readUInt8();
    return v;
  }
}

/** S2C 队伍状态（702） */
export class S2CEnemyDuelTeamStatus implements EnemyDuelMessage {
  /** 队伍状态（3=可加入） */
  state = TEAM_STATE_JOINABLE;
  /** 队长 id */
  owner = "";
  /** 队伍状态截止时间（秒） */
  teamStateEndTs = 0;
  /** 关卡 id */
  stageId = "";
  /** 模式 id */
  modeId = "";
  /** 队员状态列表 */
  players: EnemyDuelPlayerStatus[] = [];
  /** 场景 id（= 队伍 id） */
  sceneId = "";
  /** 会话服地址（host:port） */
  address = "";
  /** 队伍令牌（= serverToken） */
  token = "";
  /** 是否允许 NPC */
  allowNpc = 0;

  /** @returns 702 */
  contentType(): number {
    return S2C.TeamStatus;
  }

  /**
   * 按协议顺序写入（players 之后固定 2B 占位）
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt8(this.state);
    w.writeString(this.owner);
    w.writeUInt64(this.teamStateEndTs);
    w.writeString(this.stageId);
    w.writeString(this.modeId);
    writeSlice(w, this.players);
    w.writeReservedZeros();
    w.writeString(this.sceneId);
    w.writeString(this.address);
    w.writeString(this.token);
    w.writeUInt8(this.allowNpc);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): S2CEnemyDuelTeamStatus {
    const r = new PayloadReader(payload);
    const v = new S2CEnemyDuelTeamStatus();
    v.state = r.readUInt8();
    v.owner = r.readString();
    v.teamStateEndTs = r.readUInt64();
    v.stageId = r.readString();
    v.modeId = r.readString();
    v.players = readSlice(r, EnemyDuelPlayerStatus.read);
    r.skip(2);
    v.sceneId = r.readString();
    v.address = r.readString();
    v.token = r.readString();
    v.allowNpc = r.readUInt8();
    return v;
  }
}

/* ===== 客户端 → 服务端 ===== */

/** C2S 表情（223） */
export class C2SEnemyDuelEmoji implements EnemyDuelMessage {
  /** 表情组 */
  emojiGroup = "";
  /** 表情 id */
  emojiId = "";

  /** @returns 223 */
  contentType(): number {
    return C2S.Emoji;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.emojiGroup);
    w.writeString(this.emojiId);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): C2SEnemyDuelEmoji {
    const r = new PayloadReader(payload);
    const v = new C2SEnemyDuelEmoji();
    v.emojiGroup = r.readString();
    v.emojiId = r.readString();
    return v;
  }
}

/** C2S 准备（201，空体） */
export class C2SEnemyDuelReady implements EnemyDuelMessage {
  /** @returns 201 */
  contentType(): number {
    return C2S.Ready;
  }

  /** @returns 空 payload */
  marshal(): Buffer {
    return Buffer.alloc(0);
  }

  /**
   * 解码（空体）
   * @returns 解析结果
   */
  static read(): C2SEnemyDuelReady {
    return new C2SEnemyDuelReady();
  }
}

/** C2S 加入场景（219） */
export class C2SEnemyDuelJoin implements EnemyDuelMessage {
  /** 玩家 id */
  playerId = "";
  /** 场景 id（= 队伍 id） */
  sceneId = "";
  /** 队伍令牌（HTTP 侧 serverToken，`modeId|stageId`） */
  token = "";

  /** @returns 219 */
  contentType(): number {
    return C2S.Join;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.playerId);
    w.writeString(this.sceneId);
    w.writeString(this.token);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): C2SEnemyDuelJoin {
    const r = new PayloadReader(payload);
    const v = new C2SEnemyDuelJoin();
    v.playerId = r.readString();
    v.sceneId = r.readString();
    v.token = r.readString();
    return v;
  }
}

/** C2S 回合结算（217） */
export class C2SEnemyDuelRoundSettle implements EnemyDuelMessage {
  /** 上报的胜方（0/1/2） */
  side = 0;
  /** 结算附加信息 */
  info = "";
  /** 信息哈希 */
  infoHash = "";

  /** @returns 217 */
  contentType(): number {
    return C2S.RoundSettle;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt8(this.side);
    w.writeString(this.info);
    w.writeString(this.infoHash);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): C2SEnemyDuelRoundSettle {
    const r = new PayloadReader(payload);
    const v = new C2SEnemyDuelRoundSettle();
    v.side = r.readUInt8();
    v.info = r.readString();
    v.infoHash = r.readString();
    return v;
  }
}

/** C2S 下注（215） */
export class C2SEnemyDuelBet implements EnemyDuelMessage {
  /** 玩家 id */
  playerId = "";
  /** 下注阵营 */
  side = 0;
  /** 是否本人（客户端标识） */
  isPlayer = 0;
  /** 是否 all-in */
  allIn = 0;

  /** @returns 215 */
  contentType(): number {
    return C2S.Bet;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.playerId);
    w.writeUInt8(this.side);
    w.writeUInt8(this.isPlayer);
    w.writeUInt8(this.allIn);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): C2SEnemyDuelBet {
    const r = new PayloadReader(payload);
    const v = new C2SEnemyDuelBet();
    v.playerId = r.readString();
    v.side = r.readUInt8();
    v.isPlayer = r.readUInt8();
    v.allIn = r.readUInt8();
    return v;
  }
}

/** C2S 拉取历史（211） */
export class C2SEnemyDuelHistory implements EnemyDuelMessage {
  /** 起始序号 */
  seq = 0;

  /** @returns 211 */
  contentType(): number {
    return C2S.History;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt32(this.seq);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): C2SEnemyDuelHistory {
    const r = new PayloadReader(payload);
    const v = new C2SEnemyDuelHistory();
    v.seq = r.readUInt32();
    return v;
  }
}

/** C2S 退出（203，空体） */
export class C2SEnemyDuelQuit implements EnemyDuelMessage {
  /** @returns 203 */
  contentType(): number {
    return C2S.Quit;
  }

  /** @returns 空 payload */
  marshal(): Buffer {
    return Buffer.alloc(0);
  }

  /**
   * 解码（空体）
   * @returns 解析结果
   */
  static read(): C2SEnemyDuelQuit {
    return new C2SEnemyDuelQuit();
  }
}

/** C2S 心跳（1） */
export class C2SEnemyDuelHeartBeat implements EnemyDuelMessage {
  /** 序号 */
  seq = 0;
  /** 时间 */
  time = 0;

  /** @returns 1 */
  contentType(): number {
    return C2S.HeartBeat;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeUInt32(this.seq);
    w.writeUInt64(this.time);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): C2SEnemyDuelHeartBeat {
    const r = new PayloadReader(payload);
    const v = new C2SEnemyDuelHeartBeat();
    v.seq = r.readUInt32();
    v.time = r.readUInt64();
    return v;
  }
}

/** C2S 最终结算（221，空体） */
export class C2SEnemyDuelFinalSettle implements EnemyDuelMessage {
  /** @returns 221 */
  contentType(): number {
    return C2S.FinalSettle;
  }

  /** @returns 空 payload */
  marshal(): Buffer {
    return Buffer.alloc(0);
  }

  /**
   * 解码（空体）
   * @returns 解析结果
   */
  static read(): C2SEnemyDuelFinalSettle {
    return new C2SEnemyDuelFinalSettle();
  }
}

/** C2S 组队加入（601） */
export class C2SEnemyDuelTeamJoin implements EnemyDuelMessage {
  /** 玩家 id */
  playerId = "";
  /** 队伍 id */
  teamId = "";
  /** 队伍令牌（HTTP 侧 serverToken） */
  teamToken = "";

  /** @returns 601 */
  contentType(): number {
    return C2S.TeamJoin;
  }

  /**
   * 按协议顺序写入
   * @param w payload 写入器
   */
  write(w: PayloadWriter): void {
    w.writeString(this.playerId);
    w.writeString(this.teamId);
    w.writeString(this.teamToken);
  }

  /** @returns payload */
  marshal(): Buffer {
    const w = new PayloadWriter();
    this.write(w);
    return w.toBuffer();
  }

  /**
   * 解码
   * @param payload 消息体
   * @returns 解析结果
   */
  static read(payload: Buffer): C2SEnemyDuelTeamJoin {
    const r = new PayloadReader(payload);
    const v = new C2SEnemyDuelTeamJoin();
    v.playerId = r.readString();
    v.teamId = r.readString();
    v.teamToken = r.readString();
    return v;
  }
}

/* ===== 通用切片辅助 ===== */

/**
 * 写入复合值切片（uint16 元素数 + 元素）
 * @param w payload 写入器
 * @param items 元素列表
 */
function writeSlice<T extends { write(w: PayloadWriter): void }>(w: PayloadWriter, items: T[]): void {
  w.writeUInt16(items.length);
  for (const item of items) item.write(w);
}

/**
 * 读出复合值切片（uint16 元素数 + 元素）
 * @param r payload 读取器
 * @param readOne 单元素解码器
 * @returns 元素列表
 */
function readSlice<T>(r: PayloadReader, readOne: (r: PayloadReader) => T): T[] {
  const count = r.readSliceCount();
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) out.push(readOne(r));
  return out;
}

/* ===== 解码注册表 ===== */

/** 消息类型号 → payload 解码器 */
const DECODERS: Record<number, (payload: Buffer) => EnemyDuelMessage> = {
  [C2S.Emoji]: C2SEnemyDuelEmoji.read,
  [C2S.Ready]: C2SEnemyDuelReady.read,
  [C2S.Join]: C2SEnemyDuelJoin.read,
  [C2S.RoundSettle]: C2SEnemyDuelRoundSettle.read,
  [C2S.Bet]: C2SEnemyDuelBet.read,
  [C2S.History]: C2SEnemyDuelHistory.read,
  [C2S.Quit]: C2SEnemyDuelQuit.read,
  [C2S.HeartBeat]: C2SEnemyDuelHeartBeat.read,
  [C2S.FinalSettle]: C2SEnemyDuelFinalSettle.read,
  [C2S.TeamJoin]: C2SEnemyDuelTeamJoin.read,
  [S2C.Emoji]: S2CEnemyDuelEmoji.read,
  [S2C.HeartBeat]: S2CEnemyDuelHeartBeat.read,
  [S2C.Quit]: S2CEnemyDuelQuit.read,
  [S2C.Step]: S2CEnemyDuelStep.read,
  [S2C.ClientState]: S2CEnemyDuelClientState.read,
  [S2C.Join]: S2CEnemyDuelJoin.read,
  [S2C.End]: S2CEnemyDuelEnd.read,
  [S2C.History]: S2CEnemyDuelHistory.read,
  [S2C.TeamJoin]: S2CEnemyDuelTeamJoin.read,
  [S2C.Kick]: S2CEnemyDuelKick.read,
  [S2C.TeamStatus]: S2CEnemyDuelTeamStatus.read,
};

/**
 * 按类型号解码一帧为消息（未注册类型 → {@link UnknownEnemyDuelMessage}）
 * @param env 帧
 * @returns 解码结果
 */
export function decodeEnemyDuelMessage(env: EnemyDuelEnvelope): EnemyDuelMessage {
  const decoder = DECODERS[env.type];
  if (!decoder) return new UnknownEnemyDuelMessage(env.type, env.payload);
  return decoder(env.payload);
}

/* ===== 工厂（对照 factory.go） ===== */

/** 昵称：自己 `Bachelor#0xxx`，他人 `Undergraduate#0xxx` */
function nickNameFor(isSelf: boolean, externalPlayerId: string): string {
  const base = isSelf ? "Bachelor" : "Undergraduate";
  return `${base}#${externalPlayerId.padStart(4, "0")}`;
}

/** 构造心跳回包 */
export function makeHeartBeat(seq: number, time: number): S2CEnemyDuelHeartBeat {
  const m = new S2CEnemyDuelHeartBeat();
  m.seq = seq;
  m.time = time;
  return m;
}

/** 构造空踢出包 */
export function makeKick(): S2CEnemyDuelKick {
  return new S2CEnemyDuelKick();
}

/** 构造空组队加入结果 */
export function makeTeamJoin(): S2CEnemyDuelTeamJoin {
  return new S2CEnemyDuelTeamJoin();
}

/**
 * 构造队伍状态包
 * @param sceneId 场景 id
 * @param token 队伍令牌
 * @param address 会话服地址
 * @returns 队伍状态包
 */
export function makeTeamStatus(sceneId: string, token: string, address: string): S2CEnemyDuelTeamStatus {
  const m = new S2CEnemyDuelTeamStatus();
  m.state = TEAM_STATE_JOINABLE;
  m.address = address;
  m.sceneId = sceneId;
  m.token = token;
  return m;
}

/** 构造对局结束包 */
export function makeEnd(): S2CEnemyDuelEnd {
  return new S2CEnemyDuelEnd();
}

/**
 * 构造加入场景结果
 * @param stageId 关卡 id
 * @param playerId 本人真实 playerId
 * @param externalPlayerId 本人外部 id（100+）
 * @param otherPlayerIds 其余玩家外部 id
 * @param seed 关卡种子
 * @param nowSec 当前时间（秒）
 * @returns 加入结果
 */
export function makeJoin(
  stageId: string,
  playerId: string,
  externalPlayerId: string,
  otherPlayerIds: string[],
  seed: number,
  nowSec: number,
): S2CEnemyDuelJoin {
  const m = new S2CEnemyDuelJoin();
  m.stageId = stageId;
  m.nowTs = nowSec;
  m.stageSeed = seed;
  const self = new EnemyDuelServicePlayer();
  self.playerId = playerId;
  self.nickName = nickNameFor(true, externalPlayerId);
  m.players = [self, ...otherPlayerIds.map((id) => {
    const p = new EnemyDuelServicePlayer();
    p.playerId = id;
    p.nickName = nickNameFor(false, id);
    return p;
  })];
  return m;
}

/**
 * 构造客户端状态包（基础形态）
 * @param state 阶段
 * @param round 回合
 * @param forceEndTs 阶段截止时间（秒）
 * @returns 状态包
 */
export function makeClientState(state: number, round: number, forceEndTs: number): S2CEnemyDuelClientState {
  const m = new S2CEnemyDuelClientState();
  m.state = state;
  m.round = round;
  m.forceEndTs = forceEndTs;
  return m;
}

/** 构造空最终结算包 */
export function makeFinalSettle(): C2SEnemyDuelFinalSettle {
  return new C2SEnemyDuelFinalSettle();
}

/**
 * 构造步骤同步包
 * @param step 步骤序号
 * @param round 回合
 * @returns 步骤包
 */
export function makeStep(step: number, round: number): S2CEnemyDuelStep {
  const m = new S2CEnemyDuelStep();
  m.index = step;
  m.duration = 100;
  m.checkSeq = -1;
  m.round = round;
  return m;
}

/** 构造退出包 */
export function makeQuit(): S2CEnemyDuelQuit {
  return new S2CEnemyDuelQuit();
}

/**
 * 构造表情包
 * @param emojiGroup 表情组
 * @param emojiId 表情 id
 * @param playerId 发送者
 * @returns 表情包
 */
export function makeEmoji(emojiGroup: string, emojiId: string, playerId: string): S2CEnemyDuelEmoji {
  const m = new S2CEnemyDuelEmoji();
  m.playerId = playerId;
  m.emojiGroup = emojiGroup;
  m.emojiId = emojiId;
  return m;
}

/**
 * 构造带下注列表的状态包
 * @param state 阶段
 * @param round 回合
 * @param forceEndTs 截止时间（秒）
 * @param playerId 下注者
 * @param side 阵营
 * @param allIn 是否 all-in
 * @param streak 连胜
 * @returns 状态包
 */
export function makeClientStateForBet(
  state: number,
  round: number,
  forceEndTs: number,
  playerId: string,
  side: number,
  allIn: number,
  streak: number,
): S2CEnemyDuelClientState {
  const m = makeClientState(state, round, forceEndTs);
  const bet = new EnemyDuelBattleStatusBetItem();
  bet.playerId = playerId;
  bet.side = side;
  bet.allIn = allIn;
  bet.streak = streak;
  m.betList = [bet];
  return m;
}

/**
 * 构造带排行榜的状态包（结算阶段）
 *
 * 自己那条把外部 id 换成真实 playerId（参考实现 factory.go 的同名函数）。
 * @param state 阶段
 * @param round 回合
 * @param forceEndTs 截止时间（秒）
 * @param allPlayerResult 外部 id → 结算条目
 * @param playerId 本人真实 id
 * @param externalPlayerId 本人外部 id
 * @returns 状态包
 */
export function makeClientStateForSettle(
  state: number,
  round: number,
  forceEndTs: number,
  allPlayerResult: Map<string, EnemyDuelBattleStatusRoundLeaderBoard>,
  playerId: string,
  externalPlayerId: string,
): S2CEnemyDuelClientState {
  const m = makeClientState(state, round, forceEndTs);
  const leaderBoard: EnemyDuelBattleStatusRoundLeaderBoard[] = [];
  for (const [key, value] of allPlayerResult) {
    if (key === externalPlayerId) {
      const copy = cloneLeaderBoard(value);
      copy.playerId = playerId;
      leaderBoard.push(copy);
    } else {
      leaderBoard.push(value);
    }
  }
  m.leaderBoard = leaderBoard;
  return m;
}

/**
 * 构造带入场种子的状态包
 * @param state 阶段
 * @param round 回合
 * @param forceEndTs 截止时间（秒）
 * @param seed 回合种子
 * @returns 状态包
 */
export function makeClientStateForEntry(
  state: number,
  round: number,
  forceEndTs: number,
  seed: number,
): S2CEnemyDuelClientState {
  const m = makeClientState(state, round, forceEndTs);
  const entry = new EnemyDuelBattleStatusEntryData();
  entry.seed = seed;
  m.srcEntryData = [entry];
  return m;
}

/** 复制结算条目（避免改到共享对象） */
function cloneLeaderBoard(v: EnemyDuelBattleStatusRoundLeaderBoard): EnemyDuelBattleStatusRoundLeaderBoard {
  const c = new EnemyDuelBattleStatusRoundLeaderBoard();
  c.playerId = v.playerId;
  c.oldMoney = v.oldMoney;
  c.newMoney = v.newMoney;
  c.maxRound = v.maxRound;
  c.streak = v.streak;
  c.result = v.result;
  c.bet = v.bet;
  c.shieldState = v.shieldState;
  return c;
}

/** 阶段号 → 名称（日志用） */
export function phaseName(state: number): string {
  switch (state) {
    case PHASE.Entry:
      return "Entry";
    case PHASE.Bet:
      return "Bet";
    case PHASE.Battle:
      return "Battle";
    case PHASE.Settle:
      return "Settle";
    case PHASE.Finish:
      return "Finish";
    default:
      return `Unknown(${state})`;
  }
}

/** 供状态机使用的超时标记（0b11） */
export const TIMEOUT_SIDE = SIDE_BOTH;
