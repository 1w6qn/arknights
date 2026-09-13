/**
 * arkhub 网关特殊适配（capture 模式）
 *
 * 官服 `POST /activity/arkhub/enterHall` 响应返回 `{ result, endpoint, port }`，
 * 客户端随后用 BestHTTP WebSocket 连接 `endpoint:port`（阿卡狄亚大厅实时网关，私有协议）。
 * capture 模式下需要两件事才能让客户端连到本代理、网关流量也被抓：
 *   1. **改写 enterHall 响应**：endpoint 改为代理主机（config.Host 去 scheme）、port 保持 30000，
 *      否则客户端直连官服网关（hosts 重写时连 127.0.0.1:30000 无监听而失败，且网关流量不经过代理）
 *   2. **30000 端口 TCP 转发器**：监听本机端口，把客户端连接透传到官服网关
 *      `arkhub-gateway.hypergryph.com:30000`，双向字节流原样转发并落盘
 *      `tmp/capture/records/{connectionId}/`（统一抓包存储的网关记录目录）。
 *
 * 网关为明文 TCP（官服 30000 可 TCP 连接；TLS 握手被直接断开、明文 WebSocket 握手无响应），
 * 因此转发器是纯 TCP pipe（不做协议解析）；客户端自带上层握手/鉴权，原样透传即可。
 * 连接关闭时按网关帧协议解析出 parsed.json/messages.json，并提交一条
 * direction=gateway-bidi 的抓包记录（source=gateway）到统一索引库，供 Dashboard 统一查看。
 */
import net from "net";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import { logger } from "@utils/logger";
import {
  parseGatewayStream,
  framesToJson,
  gatewayTranscript,
} from "./protocol";

/**
 * 网关抓包记录提交回调（server.ts 注入 captureManager；缺省 no-op）
 *
 * 与 @ops/capture/capture-manager 的 commitRecord 结构化兼容（本模块不依赖 ops——
 * 迁移自 ops/proxy 时为消除 game→ops 逆向依赖而抽象为注入；字段形状见 capture-manager.ts 的
 * CaptureRecordInput）。未注入时网关流量仍落盘 tmp/capture/records/，仅不提交统一索引库。
 */
export interface GatewayRecordSink {
  isReady(): boolean;
  commitRecord(
    rid: string,
    input: {
      ts: number;
      path: string;
      /** 固定 "gateway"（与 @ops/capture 的 CaptureSource 兼容，结构化收紧） */
      source: "gateway";
      /** 固定 "gateway-bidi"（与 CaptureDirection 兼容） */
      direction: "gateway-bidi";
      status: number | null;
      latencyMs: number;
      reqSize: number;
      resSize: number;
      note: string;
    },
    dir: string,
    extraMeta?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** 已注入的记录提交 sink（null = 未注入，仅落盘不索引） */
let recordSink: GatewayRecordSink | null = null;

/** 注入抓包记录提交回调（server.ts capture 分支调用；null 取消注入） */
export function setGatewayRecordSink(sink: GatewayRecordSink | null): void {
  recordSink = sink;
}

/** 当前注入的记录 sink（测试/接线判断用） */
export function getGatewayRecordSink(): GatewayRecordSink | null {
  return recordSink;
}

/** 官服 arkhub 网关主机 */
export const OFFICIAL_ARKHUB_GATEWAY_HOST = "arkhub-gateway.hypergryph.com";
/** 官服 arkhub 网关端口 */
export const OFFICIAL_ARKHUB_GATEWAY_PORT = 30000;
/** 官服 arkhub 网关 canary 灰度域名（2026-08-18 起 enterHall 返回此地址；老域名登录帧 0 响应） */
export const OFFICIAL_ARKHUB_GATEWAY_CANARY_HOST = "arkhub-gateway-canary.hypergryph.com";
/** 默认记录根目录（统一抓包存储的 records 目录；测试可传独立临时目录） */
const DEFAULT_RECORD_ROOT = "tmp/capture/records";

/**
 * 当前转发目标（动态可更新）
 *
 * 2026-08-18 官服把 arkhub 网关切到 canary 灰度子域名（官服 enterHall 响应 endpoint
 * 由 `arkhub-gateway.hypergryph.com` 变为 `arkhub-gateway-canary.hypergryph.com`），
 * 老域名 TCP 可连但对登录帧 0 响应。转发目标由 official-forward 在改写 enterHall 响应前
 * 调用 updateGatewayTarget 动态跟随；启动初始值可用 opts.targetHost 覆盖。
 */
let _targetHost = OFFICIAL_ARKHUB_GATEWAY_CANARY_HOST;
let _targetPort = OFFICIAL_ARKHUB_GATEWAY_PORT;

/** 更新转发目标（官服 enterHall 响应 endpoint/port 变化时调用；幂等） */
export function updateGatewayTarget(host: string, port: number): void {
  if (!host) return;
  _targetHost = host;
  if (Number.isInteger(port) && port > 0) _targetPort = port;
}

/** 当前转发目标（供日志/测试） */
export function getGatewayTarget(): { host: string; port: number } {
  return { host: _targetHost, port: _targetPort };
}

/** arkhub 网关代理信息（用于改写 enterHall 响应 + 启动转发器） */
export interface ArkhubGatewayInfo {
  /** 改写后的网关地址（客户端可连接的代理主机，如 127.0.0.1） */
  endpoint: string;
  /** 改写后的网关端口（代理监听端口，缺省 30000） */
  port: number;
}

/**
 * 改写 arkhub enterHall 响应中的网关 endpoint/port
 *
 * 纯函数（可单测）：仅当 payload 为对象且含 string endpoint + number port 时改写，
 * 否则原样返回（不破坏其它响应）。playerDataDelta 等字段不动。
 *
 * @param payload - 转发响应的 body（axios 解析后的对象）
 * @param gateway - 代理网关信息
 * @returns 改写后的 payload（原地修改并返回）
 */
export function adaptArkhubEnterHallResponse(
  payload: unknown,
  gateway: ArkhubGatewayInfo,
): unknown {
  if (payload && typeof payload === "object" && !Buffer.isBuffer(payload)) {
    const data = payload as { endpoint?: unknown; port?: unknown };
    if (typeof data.endpoint === "string" && typeof data.port === "number") {
      data.endpoint = gateway.endpoint;
      data.port = gateway.port;
    }
  }
  return payload;
}

/** 判断转发目标路径是否为 arkhub enterHall（/game 基址前缀已在 resolveForwardTarget 剥除） */
export function isArkhubEnterHall(pathname: string): boolean {
  return pathname === "/activity/arkhub/enterHall";
}

/** TCP 转发器启动选项 */
export interface ArkhubGatewayProxyOptions {
  /** 首选监听端口（缺省 30000；config.capture.gatewayPort 可覆盖）——被占时自动避让到下一个空闲端口 */
  port?: number;
  /** 目标官服网关主机（测试可覆写） */
  targetHost?: string;
  /** 目标官服网关端口（测试可覆写） */
  targetPort?: number;
  /** 记录根目录（测试传独立临时目录） */
  recordRoot?: string;
  /** 自动避让最大尝试次数（缺省 50；测试可调小验证耗尽路径） */
  maxPortTries?: number;
}

/** 网关转发器启动结果 */
export interface ArkhubGatewayProxyResult {
  /** 监听成功的 net.Server；失败为 null */
  server: net.Server | null;
  /**
   * 实际监听端口（成功时=避让后的端口，供 enterHall 响应改写使用；失败时=配置首选端口）
   */
  port: number;
  /** 配置端口被占且自动避让的端口也全部耗尽（server 为 null 的原因——此时调用方可仍改写指向配置端口，其上大概率有另一实例转发器） */
  exhausted: boolean;
  /** 是否发生了自动避让（配置端口被占，实际监听在 port） */
  adjusted: boolean;
}

/**
 * 启动 arkhub 网关 TCP 转发器（端口自动避让）
 *
 * 监听首选端口，被占（多实例并存时另一实例的转发器已占用）时**自动尝试下一个端口**
 * （port, port+1, ... 最多 maxPortTries 次），避免多实例冲突——每个实例各自拿到空闲端口，
 * enterHall 响应改写用实际监听端口，客户端互不干扰。每个客户端连接建立到官服网关的透传管道，
 * 双向字节流落盘 `{recordRoot}/{connectionId}/`（up.bin=客户端→官服、down.bin=官服→客户端、
 * meta.json；关闭时另写 parsed.json/messages.json 并提交 gateway-bidi 抓包记录到统一索引库）。
 *
 * @param opts - 监听/目标/记录配置
 * @returns 启动结果：{ server, port, exhausted:false, adjusted } 监听成功（port=实际端口）；
 *          { server:null, exhausted:true } 首选端口及全部避让端口被占；
 *          { server:null, exhausted:false } 其它错误
 */
export function startArkhubGatewayProxy(
  opts: ArkhubGatewayProxyOptions = {},
): Promise<ArkhubGatewayProxyResult> {
  const {
    port = OFFICIAL_ARKHUB_GATEWAY_PORT,
    targetHost,
    targetPort = OFFICIAL_ARKHUB_GATEWAY_PORT,
    recordRoot = DEFAULT_RECORD_ROOT,
    maxPortTries = 50,
  } = opts;
  // opts.targetHost 提供时覆盖初始转发目标（缺省 canary 灰度域名，见 _targetHost 注释）
  if (targetHost) {
    updateGatewayTarget(targetHost, targetPort);
  }

  // 单连接处理（每个尝试端口新建的 server 共用）：客户端 → 官服网关透传 + 双向字节流落盘
  const handleConnection = (client: net.Socket): void => {
    const connectionId = new Date().toISOString().replace(/[:.]/g, "-");
    const startedAt = Date.now();
    // 目标动态读取（enterHall 响应可能已通过 updateGatewayTarget 切换到新域名/端口）
    const { host: targetHostName, port: targetPortNum } = getGatewayTarget();
    const upstream = net.connect({ host: targetHostName, port: targetPortNum });
    let upBytes = 0;
    let downBytes = 0;
    let metaWritten = false;
    const upBuf: Buffer[] = [];
    const downBuf: Buffer[] = [];

    const record = (dir: string, file: string, chunk: Buffer): void => {
      // 先建目录（data 事件可能先于 meta.json 的 mkdir），再追加写
      void (async () => {
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, file), chunk, { flag: "a" });
        } catch {
          /* 记录失败不影响转发 */
        }
      })();
    };

    // 客户端 → 官服
    client.on("data", (chunk: Buffer) => {
      upBytes += chunk.length;
      upBuf.push(chunk);
      if (upstream.destroyed) return;
      upstream.write(chunk);
      record(path.join(recordRoot, connectionId), "up.bin", chunk);
    });
    // 官服 → 客户端
    upstream.on("data", (chunk: Buffer) => {
      downBytes += chunk.length;
      downBuf.push(chunk);
      if (client.destroyed) return;
      client.write(chunk);
      record(path.join(recordRoot, connectionId), "down.bin", chunk);
    });

    const finish = (reason: string): void => {
      if (metaWritten) return;
      metaWritten = true;
      void (async () => {
        const dir = path.join(recordRoot, connectionId);
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(
            path.join(dir, "meta.json"),
            JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                clientAddr: client.remoteAddress,
                targetAddr: `${getGatewayTarget().host}:${getGatewayTarget().port}`,
                upBytes,
                downBytes,
                reason,
              },
              null,
              2,
            ),
            "utf-8",
          );
        } catch {
          /* 元数据写失败不影响转发 */
        }
        // 解析网关协议帧（arkodc）并落盘 parsed.json + messages.json（真实可读 request/response）
        try {
          const upResult = parseGatewayStream(Buffer.concat(upBuf), "up");
          const downResult = parseGatewayStream(Buffer.concat(downBuf), "down");
          await writeFile(
            path.join(dir, "parsed.json"),
            JSON.stringify(
              {
                up: framesToJson(upResult.frames),
                down: framesToJson(downResult.frames),
                upRemainderHex: upResult.remainder.toString("hex"),
                downRemainderHex: downResult.remainder.toString("hex"),
                upRemainderLen: upResult.remainder.length,
                downRemainderLen: downResult.remainder.length,
                downRecovered: downResult.recovered
                  ? { start: downResult.recovered.start, end: downResult.recovered.end }
                  : undefined,
              },
              null,
              2,
            ),
            "utf-8",
          );
          // 真实可读的 request/response 记录（命名解码 + Login/Ping 语义配对）
          await writeFile(
            path.join(dir, "messages.json"),
            JSON.stringify(gatewayTranscript(upResult, downResult), null, 2),
            "utf-8",
          );
        } catch {
          /* 解析失败不影响抓包 */
        }
        // 提交网关抓包记录到统一索引库（sink 未注入/未初始化时仅保留文件，不落库）
        try {
          if (recordSink?.isReady()) {
            await recordSink.commitRecord(
              connectionId,
              {
                ts: startedAt,
                path: "/arkhub/gateway",
                source: "gateway",
                direction: "gateway-bidi",
                status: null,
                latencyMs: Date.now() - startedAt,
                reqSize: upBytes,
                resSize: downBytes,
                note: `arkhub 网关连接（${getGatewayTarget().host}:${getGatewayTarget().port}，${reason}）`,
              },
              dir,
              {
                targetAddr: `${getGatewayTarget().host}:${getGatewayTarget().port}`,
                clientAddr: client.remoteAddress,
                upBytes,
                downBytes,
                reason,
              },
            );
          }
        } catch (e) {
          logger.debug("capture", "arkhub 网关记录索引失败:", (e as Error).message);
        }
      })();
    };

    client.on("error", (e) => {
      logger.debug("capture", "arkhub 客户端连接错误:", e.message);
      upstream.destroy();
      finish("client-error");
    });
    upstream.on("error", (e) => {
      logger.debug("capture", "arkhub 官服网关连接错误:", e.message);
      client.destroy();
      finish("upstream-error");
    });
    client.on("close", () => {
      upstream.destroy();
      finish("closed");
    });
    upstream.on("close", () => {
      client.destroy();
      finish("closed");
    });
  };

  // 自动避让监听：首选端口被占 → 依次尝试 port, port+1, ...（多实例并存时各拿一个空闲端口）。
  // 每次尝试新建 server（复用同一 server 重 listen 有回调错乱风险——实测 adjusted 结果错乱），
  // 全部避让端口被占则返回 exhausted，调用方仍可改写 enterHall 指向配置端口（其上大概率有另一实例转发器）。
  return new Promise((resolve) => {
    const tryListen = (p: number, attempt: number): void => {
      const server = net.createServer(handleConnection);
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempt + 1 < maxPortTries) {
          // 端口被占：避让到下一个端口重试
          tryListen(p + 1, attempt + 1);
          return;
        }
        if (e.code === "EADDRINUSE") {
          // 首选端口及全部避让端口都被占（极罕见）：调用方仍可改写 enterHall 指向配置端口——
          // 该端口上大概率有另一实例的转发器，客户端连上后经其透传官服
          logger.warn("capture", `arkhub 网关端口 ${port}~${p} 均被占用（耗尽 ${maxPortTries} 次避让）——enterHall 响应仍改写指向 :${port}，客户端网关流量经占用该端口的转发器`);
          resolve({ server: null, port, exhausted: true, adjusted: false });
          return;
        }
        logger.error("capture", `arkhub 网关转发器启动失败: ${e.message}`);
        resolve({ server: null, port, exhausted: false, adjusted: false });
      });
      server.listen(p, () => {
        const actualPort = (server.address() as net.AddressInfo).port;
        if (attempt > 0) {
          logger.warn("capture", `arkhub 网关端口 ${port} 被占用，自动避让到 :${actualPort} → ${getGatewayTarget().host}:${getGatewayTarget().port}（流量记录 ${recordRoot}）`);
        } else {
          logger.info("capture", `arkhub 网关转发器已启动：监听 :${actualPort} → ${getGatewayTarget().host}:${getGatewayTarget().port}（流量记录 ${recordRoot}）`);
        }
        resolve({ server, port: actualPort, exhausted: false, adjusted: attempt > 0 });
      });
    };
    tryListen(port, 0);
  });
}
