/**
 * 怪猎对决实时会话服单测
 *
 * 覆盖三层：
 *  1. 编解码：用参考实现 `payloads_test.go` 的字节样例做 round-trip 断言（线级真值）
 *  2. 状态机：假时钟手动 tick 推进 Waiting→Entry→Bet→Battle→Settle→Finish
 *  3. TCP：真实起服 + 客户端发 TeamJoin/Join，断言回包类型序列
 */
import { describe, it, expect } from "vitest";
import net from "net";
import {
  encodeEnvelope,
  EnemyDuelFrameReader,
  type EnemyDuelEnvelope,
} from "@game/modules/activities/enemyDuel/session/codec";
import {
  C2SEnemyDuelBet,
  C2SEnemyDuelEmoji,
  C2SEnemyDuelJoin,
  C2SEnemyDuelReady,
  C2SEnemyDuelRoundSettle,
  C2SEnemyDuelTeamJoin,
  EnemyDuelBattleStatusBetItem,
  EnemyDuelBattleStatusEntryData,
  EnemyDuelBattleStatusRoundLeaderBoard,
  S2CEnemyDuelClientState,
  S2CEnemyDuelEmoji,
  S2CEnemyDuelEnd,
  S2CEnemyDuelStep,
  decodeEnemyDuelMessage,
  type EnemyDuelMessage,
} from "@game/modules/activities/enemyDuel/session/payloads";
import {
  EnemyDuelGameRegistry,
  EnemyDuelSessionGameStatus,
  handleEnemyDuelMessage,
  parseModeIdStageId,
  type EnemyDuelSession,
} from "@game/modules/activities/enemyDuel/session/game";
import { C2S, S2C } from "@game/modules/activities/enemyDuel/session/messages";
import {
  startEnemyDuelSessionServer,
  resetEnemyDuelSessionState,
} from "@game/modules/activities/enemyDuel/public";

/** 记录发送内容的假会话 */
class FakeSession implements EnemyDuelSession {
  /** 已发送消息 */
  readonly sent: EnemyDuelMessage[] = [];
  /** 是否已关闭 */
  closed = false;

  /** @param msg 服务端消息 */
  send(msg: EnemyDuelMessage): void {
    this.sent.push(msg);
  }

  /** @returns 是否已关闭 */
  isClosed(): boolean {
    return this.closed;
  }

  /** 关闭 */
  close(): void {
    this.closed = true;
  }
}

describe("enemyDuel 会话服：编解码（参考实现字节样例）", () => {
  it("S2C 表情 payload 与 payloads_test.go 期望逐字节一致", () => {
    const msg = new S2CEnemyDuelEmoji();
    msg.playerId = "123";
    msg.emojiGroup = "some_group";
    msg.emojiId = "some_id";
    const expected = Buffer.from([
      0x00, 0x03, 0x31, 0x32, 0x33,
      0x00, 0x0a, 0x73, 0x6f, 0x6d, 0x65, 0x5f, 0x67, 0x72, 0x6f, 0x75, 0x70,
      0x00, 0x07, 0x73, 0x6f, 0x6d, 0x65, 0x5f, 0x69, 0x64,
    ]);
    expect(msg.marshal().equals(expected)).toBe(true);
  });

  it("WriteContent：组帧结果与 payloads_test.go 期望一致（含 8B 帧头）", () => {
    const msg = new S2CEnemyDuelEmoji();
    msg.playerId = "123456";
    msg.emojiGroup = "emoji_group";
    msg.emojiId = "emoji_id";
    const expected = Buffer.from([
      0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00, 0xe0,
      0x00, 0x06, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36,
      0x00, 0x0b, 0x65, 0x6d, 0x6f, 0x6a, 0x69, 0x5f, 0x67, 0x72, 0x6f, 0x75, 0x70,
      0x00, 0x08, 0x65, 0x6d, 0x6f, 0x6a, 0x69, 0x5f, 0x69, 0x64,
    ]);
    const packet = encodeEnvelope({ type: msg.contentType(), payload: msg.marshal() });
    expect(packet.equals(expected)).toBe(true);
    expect(msg.contentType()).toBe(S2C.Emoji);
  });

  it("ReadContent：客户端表情帧解出 C2S 表情", () => {
    const packet = Buffer.from([
      0x00, 0x00, 0x00, 0x29, 0x00, 0x00, 0x00, 0xdf,
      0x00, 0x12, 0x65, 0x6d, 0x74, 0x69, 0x63, 0x6f, 0x6e, 0x5f, 0x64, 0x75, 0x65, 0x6c, 0x5f, 0x62, 0x61, 0x73, 0x69, 0x63,
      0x00, 0x13, 0x64, 0x75, 0x65, 0x6c, 0x5f, 0x62, 0x61, 0x74, 0x74, 0x6c, 0x65, 0x5f, 0x77, 0x72, 0x6f, 0x6e, 0x67, 0x65, 0x64,
    ]);
    const frames = new EnemyDuelFrameReader().push(packet);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(C2S.Emoji);
    const msg = decodeEnemyDuelMessage(frames[0]);
    expect(msg).toBeInstanceOf(C2SEnemyDuelEmoji);
    const emoji = msg as C2SEnemyDuelEmoji;
    expect(emoji.emojiGroup).toBe("emticon_duel_basic");
    expect(emoji.emojiId).toBe("duel_battle_wronged");
  });

  it("ClientState 嵌套切片 round-trip", () => {
    const msg = new S2CEnemyDuelClientState();
    msg.state = 4;
    msg.round = 3;
    msg.forceEndTs = 1_700_000_000;
    const entry = new EnemyDuelBattleStatusEntryData();
    entry.seed = 42;
    entry.seedHistory = [1, 2, 3];
    entry.sideHistory = [0, 1];
    msg.srcEntryData = [entry];
    const bet = new EnemyDuelBattleStatusBetItem();
    bet.playerId = "p1";
    bet.side = 1;
    bet.streak = 2;
    bet.updateTs = 9;
    msg.betList = [bet];
    const board = new EnemyDuelBattleStatusRoundLeaderBoard();
    board.playerId = "100";
    board.oldMoney = 10000;
    board.newMoney = 12000;
    board.maxRound = 1;
    board.streak = 1;
    board.result = 1;
    board.bet = 1;
    msg.leaderBoard = [board];
    const decoded = S2CEnemyDuelClientState.read(msg.marshal());
    expect(decoded.state).toBe(4);
    expect(decoded.round).toBe(3);
    expect(decoded.forceEndTs).toBe(1_700_000_000);
    expect(decoded.srcEntryData[0].seed).toBe(42);
    expect(decoded.srcEntryData[0].seedHistory).toEqual([1, 2, 3]);
    expect(decoded.srcEntryData[0].sideHistory).toEqual([0, 1]);
    expect(decoded.betList[0].playerId).toBe("p1");
    expect(decoded.betList[0].streak).toBe(2);
    expect(decoded.betList[0].updateTs).toBe(9);
    expect(decoded.leaderBoard[0].newMoney).toBe(12000);
  });

  it("Step 布局：index/duration/2B 占位/checkSeq(-1)/round", () => {
    const msg = new S2CEnemyDuelStep();
    msg.index = 7;
    msg.round = 2;
    const buf = msg.marshal();
    expect(buf.length).toBe(15);
    expect(buf.readUInt32BE(0)).toBe(7);
    expect(buf.readUInt32BE(4)).toBe(100);
    expect(buf.readUInt8(8)).toBe(0);
    expect(buf.readUInt8(9)).toBe(0);
    expect(buf.readInt32BE(10)).toBe(-1);
    expect(buf.readUInt8(14)).toBe(2);
    expect(S2CEnemyDuelStep.read(buf).checkSeq).toBe(-1);
  });

  it("FrameReader：分片与多帧同包", () => {
    const a = encodeEnvelope({ type: 1, payload: Buffer.from([1, 2]) });
    const b = encodeEnvelope({ type: 2, payload: Buffer.alloc(0) });
    const reader = new EnemyDuelFrameReader();
    expect(reader.push(a.subarray(0, 5))).toHaveLength(0);
    const frames = reader.push(Buffer.concat([a.subarray(5), b]));
    expect(frames.map((f) => f.type)).toEqual([1, 2]);
    expect(frames[0].payload.equals(Buffer.from([1, 2]))).toBe(true);
  });
});

describe("enemyDuel 会话服：六态状态机（假时钟）", () => {
  /** 建注册表 + 单人对局 + 已就绪会话 */
  function setup() {
    const clock = { t: 0 };
    const registry = new EnemyDuelGameRegistry({
      singlePlayer: true,
      waitSec: 30,
      now: () => clock.t,
      randomUint32: () => 12345,
      autoRun: false,
    });
    const game = registry.getOrCreate("scene|multiOperationMatch|stage_1", "multiOperationMatch", "stage_1");
    if (!game) throw new Error("对局创建失败");
    const session = new FakeSession();
    const status = new EnemyDuelSessionGameStatus();
    game.addSession(session, status);
    game.initPlayerStatus(status, "player_1");
    const ctx = { registry, address: "127.0.0.1:8543", now: () => clock.t };
    return { clock, registry, game, session, status, ctx };
  }

  /** 取最后一条状态包 */
  function lastState(session: FakeSession): S2CEnemyDuelClientState {
    for (let i = session.sent.length - 1; i >= 0; i -= 1) {
      const m = session.sent[i];
      if (m instanceof S2CEnemyDuelClientState) return m;
    }
    throw new Error("未收到 ClientState");
  }

  it("Ready 后进入 Entry（带非零种子）→ Bet → Battle → Settle", () => {
    const { clock, game, session, status, ctx } = setup();
    handleEnemyDuelMessage(ctx, session, status, new C2SEnemyDuelReady());
    game.tick();
    expect(lastState(session).state).toBe(1);
    expect(lastState(session).srcEntryData[0].seed).toBe(12345);

    clock.t += 3001;
    game.tick();
    expect(lastState(session).state).toBe(2);

    clock.t += 20001;
    game.tick();
    expect(lastState(session).state).toBe(3);

    handleEnemyDuelMessage(ctx, session, status, Object.assign(new C2SEnemyDuelRoundSettle(), { side: 1 }));
    game.tick();
    const settle = lastState(session);
    expect(settle.state).toBe(4);
    // 结算排行榜补齐到 8 人（multiOperationMatch），自己那条换成真实 playerId
    expect(settle.leaderBoard).toHaveLength(8);
    expect(settle.leaderBoard.some((e) => e.playerId === "player_1")).toBe(true);

    clock.t += 10001;
    game.tick();
    expect(lastState(session).state).toBe(1);
    expect(lastState(session).round).toBe(1);
  });

  it("第 10 回合结算后进入 Finish 并发最终结算 + 结束包", () => {
    const { clock, game, session, status, ctx } = setup();
    handleEnemyDuelMessage(ctx, session, status, new C2SEnemyDuelReady());
    game.tick();
    // 直接跳到最后回合，省去 9 轮推进
    game.round = 9;
    clock.t += 3001;
    game.tick(); // Entry → Bet
    clock.t += 20001;
    game.tick(); // Bet → Battle
    handleEnemyDuelMessage(ctx, session, status, Object.assign(new C2SEnemyDuelRoundSettle(), { side: 1 }));
    game.tick(); // Battle → Settle
    expect(lastState(session).state).toBe(4);
    clock.t += 10001;
    game.tick(); // Settle → Finish
    expect(lastState(session).state).toBe(5);
    game.tick(); // Finish.update → state=null（OnExit 发最终结算 + 结束包）
    expect(session.sent.some((m) => m.contentType() === C2S.FinalSettle)).toBe(true);
    expect(session.sent.some((m) => m instanceof S2CEnemyDuelEnd)).toBe(true);
    game.tick();
    expect(game.stopped).toBe(true);
  });

  it("下注仅在 Bet 阶段生效并广播 BetList", () => {
    const { clock, game, session, status, ctx } = setup();
    handleEnemyDuelMessage(ctx, session, status, new C2SEnemyDuelReady());
    // Bet 之前的下注被忽略
    handleEnemyDuelMessage(ctx, session, status, Object.assign(new C2SEnemyDuelBet(), { side: 2, allIn: 1 }));
    expect(session.sent.filter((m) => m instanceof S2CEnemyDuelClientState)).toHaveLength(0);

    game.tick(); // → Entry
    clock.t += 3001;
    game.tick(); // → Bet
    const before = session.sent.length;
    handleEnemyDuelMessage(ctx, session, status, Object.assign(new C2SEnemyDuelBet(), { side: 1, allIn: 1 }));
    const bet = lastState(session);
    expect(session.sent.length).toBe(before + 1);
    expect(bet.betList).toHaveLength(1);
    expect(bet.betList[0].side).toBe(1);
    expect(bet.betList[0].allIn).toBe(1);
  });

  it("parseModeIdStageId 需要 `modeId|stageId` 两段", () => {
    expect(parseModeIdStageId("multiOperationMatch|act1_01")).toEqual({
      modeId: "multiOperationMatch",
      stageId: "act1_01",
    });
    expect(parseModeIdStageId("join")).toBeNull();
    expect(parseModeIdStageId("a|b|c")).toEqual({ modeId: "a", stageId: "b" });
  });
});

describe("enemyDuel 会话服：TCP 链路", () => {
  /**
   * 起真实会话服并连接，收集到 count 帧或超时
   * @returns 帧列表与客户端 socket
   */
  async function connectAndCollect(
    server: net.Server,
    port: number,
    payloads: EnemyDuelEnvelope[],
    count: number,
  ): Promise<{ frames: EnemyDuelEnvelope[]; socket: net.Socket }> {
    const socket = net.connect(port, "127.0.0.1");
    const reader = new EnemyDuelFrameReader();
    const frames: EnemyDuelEnvelope[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("data", (chunk: Buffer) => {
      frames.push(...reader.push(chunk));
    });
    for (const env of payloads) socket.write(encodeEnvelope(env));
    const deadline = Date.now() + 3000;
    while (frames.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // server 参数仅用于类型对齐（关闭由调用方负责）
    void server;
    return { frames, socket };
  }

  it("TeamJoin(601) 回 602/702/714，Join(219) 回 220", async () => {
    resetEnemyDuelSessionState();
    const server = await startEnemyDuelSessionServer({
      port: 0,
      publicHost: "127.0.0.1",
      singlePlayer: true,
      waitSec: 30,
    });
    expect(server).not.toBeNull();
    const address = server?.address();
    if (!address || typeof address === "string") throw new Error("未取得监听端口");
    try {
      const teamJoin = new C2SEnemyDuelTeamJoin();
      teamJoin.playerId = "1";
      teamJoin.teamId = "team-1";
      teamJoin.teamToken = "multiOperationMatch|act1_01";
      const { frames, socket } = await connectAndCollect(
        server as net.Server,
        address.port,
        [{ type: C2S.TeamJoin, payload: teamJoin.marshal() }],
        3,
      );
      expect(frames.map((f) => f.type)).toEqual([S2C.TeamJoin, S2C.TeamStatus, S2C.Kick]);
      const join = new C2SEnemyDuelJoin();
      join.playerId = "1";
      join.sceneId = "team-1";
      join.token = "multiOperationMatch|act1_01";
      socket.write(encodeEnvelope({ type: C2S.Join, payload: join.marshal() }));
      const reader = new EnemyDuelFrameReader();
      const got: EnemyDuelEnvelope[] = [];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        socket.on("data", (chunk: Buffer) => {
          got.push(...reader.push(chunk));
          if (got.some((f) => f.type === S2C.Join)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      expect(got.map((f) => f.type)).toContain(S2C.Join);
      socket.destroy();
    } finally {
      await new Promise<void>((resolve) => (server as net.Server).close(() => resolve()));
    }
    expect(server?.listening).toBe(false);
  });
});
