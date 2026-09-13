/**
 * 怪猎对决（EnemyDuel）实时会话服——TCP 服务
 *
 * 客户端从 HTTP `enemyDuel/queryMatch|createTeam` 拿到 `serverAddress`+`serverToken` 后
 * 连本服务（TCP + 长度前缀帧）。协议与状态机见 `codec.ts`/`payloads.ts`/`game.ts`；
 * 本文件只负责监听、连接生命周期、帧切分与死连接回收（对照参考实现
 * `OpenBachelorSS/internal/hub/hub.go`、`session/session.go`、`cmd/server/main.go`）。
 *
 * 参考实现的 icebreaker（8544）在 obs 里是空壳（无消息定义），不移植。
 */
import net from "net";
import { logger } from "@utils/logger";
import { encodeEnvelope, EnemyDuelFrameReader, type EnemyDuelEnvelope } from "./codec";
import { decodeEnemyDuelMessage, type EnemyDuelMessage } from "./payloads";
import {
  EnemyDuelGameRegistry,
  EnemyDuelSessionGameStatus,
  handleEnemyDuelMessage,
  type EnemyDuelSession,
} from "./game";

/** 会话服监听选项 */
export interface EnemyDuelSessionServerOptions {
  /** 监听端口 */
  port: number;
  /** 客户端可见主机（配合实际监听端口组成 S2C TeamStatus.Address / HTTP 侧回报地址） */
  publicHost: string;
  /** 单人模式：所需人数压成 1 */
  singlePlayer: boolean;
  /** Waiting 态上限（秒） */
  waitSec: number;
  /** 监听地址（缺省 0.0.0.0） */
  host?: string;
  /** 端口被占时的最大避让次数（缺省 20） */
  maxPortTries?: number;
  /** 时钟（毫秒），缺省 `Date.now` */
  now?: () => number;
  /** 死连接回收间隔毫秒（缺省 3000） */
  sweepMs?: number;
  /** 无消息超过该毫秒数即回收（缺省 10000） */
  idleMs?: number;
}

/** 实际监听端口（0 = 未启动；HTTP 侧据此回报 serverAddress） */
let _activePort = 0;
/** 实际对外地址（`host:port`；端口避让后随之更新） */
let _activeAddress = "";
/** 实际监听是否已启动 */
let _active = false;

/** @returns 会话服实际监听端口（未启动为 0） */
export function getEnemyDuelSessionPort(): number {
  return _activePort;
}

/** @returns 会话服对外地址 `host:port`（未启动为空串） */
export function getEnemyDuelSessionAddress(): string {
  return _activeAddress;
}

/** @returns 会话服是否已启动 */
export function isEnemyDuelSessionActive(): boolean {
  return _active;
}

/** 重置启动态（单测隔离用） */
export function resetEnemyDuelSessionState(): void {
  _activePort = 0;
  _activeAddress = "";
  _active = false;
}

/** TCP 会话（发送即写 socket；关闭后静默丢弃） */
class TcpEnemyDuelSession implements EnemyDuelSession {
  /** 底层连接 */
  private readonly _socket: net.Socket;
  /** 是否已关闭 */
  private _closed = false;

  /**
   * @param socket 已建立的 TCP 连接
   */
  constructor(socket: net.Socket) {
    this._socket = socket;
  }

  /**
   * 组帧并写回客户端
   * @param msg 服务端消息
   */
  send(msg: EnemyDuelMessage): void {
    if (this._closed || this._socket.destroyed) return;
    try {
      const env: EnemyDuelEnvelope = { type: msg.contentType(), payload: msg.marshal() };
      this._socket.write(encodeEnvelope(env));
    } catch (e) {
      logger.warn("enemyDuel-session", `发送失败（${msg.contentType()}）：${(e as Error).message}`);
      this.close();
    }
  }

  /** @returns 是否已关闭 */
  isClosed(): boolean {
    return this._closed;
  }

  /** 关闭连接（幂等） */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._socket.destroy();
  }
}

/**
 * 启动怪猎对决实时会话服
 *
 * 监听首选端口；被占时依次尝试 port+1…（最多 maxPortTries 次），实际端口经
 * {@link getEnemyDuelSessionPort} 供 HTTP 侧回报——客户端总是拿到真实端口。
 *
 * @param opts 监听与玩法选项
 * @returns 成功返回 net.Server；全部端口被占返回 null
 */
export function startEnemyDuelSessionServer(opts: EnemyDuelSessionServerOptions): Promise<net.Server | null> {
  const {
    port,
    publicHost,
    singlePlayer,
    waitSec,
    host = "0.0.0.0",
    maxPortTries = 20,
    now = Date.now,
    sweepMs = 3000,
    idleMs = 10_000,
  } = opts;

  const registry = new EnemyDuelGameRegistry({ singlePlayer, waitSec, now });
  /** 连接 → 游戏侧状态 */
  const sessions = new Map<TcpEnemyDuelSession, EnemyDuelSessionGameStatus>();
  /** 死连接回收定时器 */
  let sweepTimer: NodeJS.Timeout | null = null;

  const handleConnection = (socket: net.Socket): void => {
    const session = new TcpEnemyDuelSession(socket);
    const status = new EnemyDuelSessionGameStatus();
    // 参考实现用零值 LastActiveTime（连接后 3s 内没消息就被回收）；这里按连接时刻起算，
    // 给客户端留出握手时间，行为更稳且不影响线级协议
    status.lastActiveTime = now();
    sessions.set(session, status);
    const reader = new EnemyDuelFrameReader();
    logger.debug("enemyDuel-session", `连接建立 ${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`);

    socket.on("data", (chunk: Buffer) => {
      let frames: EnemyDuelEnvelope[];
      try {
        frames = reader.push(chunk);
      } catch (e) {
        logger.warn("enemyDuel-session", `帧解析失败，断开连接：${(e as Error).message}`);
        session.close();
        return;
      }
      for (const env of frames) {
        const msg = decodeEnemyDuelMessage(env);
        try {
          handleEnemyDuelMessage({ registry, address: _activeAddress, now }, session, status, msg);
        } catch (e) {
          logger.warn("enemyDuel-session", `消息处理失败（type=${env.type}）：${(e as Error).message}`);
        }
      }
    });

    const cleanup = (): void => {
      sessions.delete(session);
      session.close();
    };
    socket.on("error", (e: Error) => {
      logger.debug("enemyDuel-session", `连接错误：${e.message}`);
      cleanup();
    });
    socket.on("close", cleanup);
  };

  return new Promise((resolve) => {
    const tryListen = (p: number, attempt: number): void => {
      const server = net.createServer(handleConnection);
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempt + 1 < maxPortTries) {
          tryListen(p + 1, attempt + 1);
          return;
        }
        if (e.code === "EADDRINUSE") {
          logger.warn("enemyDuel-session", `端口 ${port}~${p} 均被占用（耗尽 ${maxPortTries} 次避让），会话服未启动`);
          resolve(null);
          return;
        }
        logger.error("enemyDuel-session", `会话服启动失败：${e.message}`);
        resolve(null);
      });
      server.listen(p, host, () => {
        const actualPort = (server.address() as net.AddressInfo).port;
        _active = true;
        _activePort = actualPort;
        _activeAddress = `${publicHost}:${actualPort}`;
        if (attempt > 0) {
          logger.warn("enemyDuel-session", `端口 ${port} 被占用，会话服避让到 :${actualPort}`);
        } else {
          logger.info("enemyDuel-session", `会话服已监听 ${host}:${actualPort}`);
        }
        sweepTimer = setInterval(() => {
          const cutoff = now() - idleMs;
          for (const [session, status] of [...sessions]) {
            if (status.lastActiveTime < cutoff) {
              logger.debug("enemyDuel-session", "回收空闲连接");
              session.close();
              sessions.delete(session);
            }
          }
          registry.prune();
        }, sweepMs);
        sweepTimer.unref?.();
        server.once("close", () => {
          if (sweepTimer) {
            clearInterval(sweepTimer);
            sweepTimer = null;
          }
          registry.stopAll();
          sessions.clear();
          _active = false;
          _activePort = 0;
          _activeAddress = "";
          logger.info("enemyDuel-session", "会话服已停止");
        });
        resolve(server);
      });
    };
    tryListen(port, 0);
  });
}
