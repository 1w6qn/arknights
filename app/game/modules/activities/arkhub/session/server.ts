/**
 * arkhub 网关本地应答器（私服模式——客户端进入广场不再依赖官服网关）——传输层
 *
 * 官服 `POST /activity/arkhub/enterHall` 返回 endpoint:port，客户端随后用 TCP 连接
 * 网关（长连接二进制协议）：帧 = [4B 大端总长][4B mainID][8B subID][protobuf 消息体]。
 * 本地应答器对任意登录凭据回 code=100（私服账号），心跳回显，场景回合法的
 * EnterSceneNotify（TOWN 广场 + 自己的 PlayerSyncData）——客户端能进入空广场。
 *
 * 本文件只负责「传输」：
 *   - TCP 监听（端口自动避让，多实例并存各拿空闲端口）
 *   - 连接生命周期 + 帧切分（长度前缀）
 *   - 帧收发日志（可读化：已知帧显示语义名 + 字段摘要，心跳/位置同步降噪为 DEBUG）
 *   - 路由装配：把 handlers/* 注册到 ArkhubSessionFrameRouter，未注册帧回通用 ACK
 * 帧 → 应答的业务逻辑已拆分：
 *   - 逻辑层：handlers/session.ts（登录/场景/交互/引导）、handlers/play.ts（捕捉/对局/生物/交换）、
 *     handlers/shop.ts（商店/道具/像素）
 *   - 路由层：arkhub-gateway-router.ts（FrameRouter 分发 + 上下文契约）
 *   - 线级编解码：arkhub-gateway-codec.ts
 */
import net from "net";
import { logger } from "@utils/logger";
import { buildFrame } from "./codec";
import { GW_CODE_OK } from "./messages";
import {
  ArkhubSessionFrameRouter,
} from "./dispatch";
import type {
  ArkhubSessionConnectionState,
  ArkhubSessionHandlerContext,
  ArkhubSessionFrame,
  ArkhubSessionServerOptions,
} from "./contract";
import { registerSessionHandlers, HALL_MAP_ID, defaultGuideFlags } from "./handlers/hub";
import { registerPlayHandlers } from "./handlers/play";
import { registerShopHandlers } from "./handlers/shop";

/** 兼容旧导出：网关配置项/户籍数据类型（现定义于 arkhub-gateway-router.ts） */
export type { ArkhubSessionServerOptions, ArkdexDocsData } from "./contract";

/** 本地网关是否已启动（enterHall 路由据此把客户端导向本地而非官服域名） */
let _localGatewayActive = false;
/** 查询本地网关是否已启动 */
export function isArkhubSessionActive(): boolean {
  return _localGatewayActive;
}
/** 设置本地网关启动状态（测试重置用） */
export function setArkhubSessionActive(v: boolean): void {
  _localGatewayActive = v;
}

/** 本地网关实际监听端口（enterHall 路由回报给客户端；未启动为 0） */
let _localGatewayPort = 0;
/** 查询本地网关实际监听端口 */
export function getArkhubSessionPort(): number {
  return _localGatewayPort;
}

/** 默认监听端口（对齐官服网关端口） */
const DEFAULT_GATEWAY_PORT = 30000;
/** 帧头非法长度下界（len < 16 或 > 65536 视为损坏断开） */
const MIN_FRAME_LEN = 16;
const MAX_FRAME_LEN = 65536;

/**
 * 启动 arkhub 本地网关应答器（端口自动避让）
 *
 * 监听首选端口，被占（另一实例/其它程序占用）时自动尝试下一个端口（port, port+1, ...
 * 最多 maxPortTries 次）——多实例并存或端口冲突时各拿一个空闲端口，enterHall 经
 * getArkhubSessionPort() 回报实际端口。监听成功后解析客户端帧并按路由分发：
 * 登录（任意凭据 code=100，记录 uid 供场景使用）、心跳回显、场景 hello（合法
 * EnterSceneNotify——含自己的 PlayerSyncData）、切场景（传送门）等——具体应答见
 * handlers/* 与 docs/arkhub-gateway-protocol.md §11 帧处理总表。
 * 全部避让端口被占返回 null（本地网关不可用，enterHall 回退官服域名）。
 *
 * @param opts - 监听配置 + 私服玩法回调（见 ArkhubSessionServerOptions）
 * @returns 成功返回 net.Server，全部端口被占返回 null
 */
export function startArkhubSessionServer(
  opts: ArkhubSessionServerOptions = {},
): Promise<net.Server | null> {
  const { port = DEFAULT_GATEWAY_PORT, maxPortTries = 50 } = opts;

  // 路由装配（一次装配，所有连接共用）——逻辑层 handlers 在此注册
  const router = new ArkhubSessionFrameRouter();
  registerSessionHandlers(router);
  registerPlayHandlers(router);
  registerShopHandlers(router);
  // 未注册帧兜底：main=8 回 {1:100} 业务成功码（subID+1 对齐 req→resp 错位规律）；
  // 其余 main（2/4 响应等）客户端不会发，静默忽略
  router.setFallback("通用ACK(未注册帧)", (ctx, frame) => {
    if (frame.mainID === 8) {
      ctx.send(8, frame.subID + BigInt(1), Buffer.from([0x08, GW_CODE_OK]));
    }
  });

  const handleConnection = (sock: net.Socket): void => {
    let buffer = Buffer.alloc(0);
    // 连接级状态（handler 直接读写；按连接维护，不跨连接保留）
    const state: ArkhubSessionConnectionState = {
      uid: "",
      currentMapId: HALL_MAP_ID,
      guideState: defaultGuideFlags(),
      settledDuelBattles: new Set<string>(),
      stateMask: 0,
    };

    /**
     * protobuf 轻解析为可读字段摘要（field=值，嵌套/字节截断）——帧日志用
     */
    const summarize = (buf: Buffer, max = 200): string => {
      const parts: string[] = [];
      let p = 0;
      const rv = (): bigint => {
        let v = 0n;
        let s = 0n;
        for (;;) {
          if (p >= buf.length) break;
          const b = buf[p++];
          v |= BigInt(b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7n;
        }
        return v;
      };
      try {
        while (p < buf.length && parts.length < 6) {
          const tag = rv();
          if (tag === 0n) break;
          const f = Number(tag >> 3n);
          const w = Number(tag & 7n);
          if (w === 2) {
            const l = Number(rv());
            if (p + l > buf.length) break;
            const chunk = buf.subarray(p, p + l);
            p += l;
            // 可读文本（完整显示，不截断——交互/令牌帧的 actorId/operationId 需可见）
            const txt = chunk.toString("utf8");
            if (/^[\x20-\x7e\xe4-\xe9][\x20-\x7e\xe4-\xe9\u4e00-\u9fff]*$/.test(txt) && l >= 2 && !chunk.includes(0)) {
              parts.push(`f${f}="${txt}"`);
            } else {
              parts.push(`f${f}[${l}B]`);
            }
          } else if (w === 0) {
            const v = rv();
            const signed = Number(BigInt.asIntN(64, v));
            parts.push(`f${f}=${signed}`);
          } else if (w === 5) {
            if (p + 4 > buf.length) break;
            parts.push(`f${f}=float(${buf.readFloatLE(p).toFixed(2)})`);
            p += 4;
          } else break;
        }
      } catch {
        // 解析失败保留 hex 预览
      }
      const out = parts.join(" ");
      if (out.length > max) return out.slice(0, max) + "…";
      return out;
    };

    /**
     * 帧日志（完整记录收发——调试枢纽玩法帧协议用）
     * 心跳（main=1）与位置同步（sub low32=38b32a34/35）为高频噪音帧 → DEBUG；其余帧 → INFO。
     */
    const logFrame = (
      dir: "→" | "←",
      mainID: number,
      subID: bigint,
      body: Buffer,
    ): void => {
      const low = (subID & 0xffffffffn).toString(16).padStart(8, "0");
      const noisy =
        mainID === 1 ||
        (mainID === 2 && subID === BigInt(0)) ||
        low === "38b32a34" ||
        low === "38b32a35";
      const name = router.nameOf(mainID, subID);
      const detail = summarize(body);
      const hex =
        body.length > 32
          ? `hex=${body.toString("hex").slice(0, 32)}…`
          : `hex=${body.toString("hex")}`;
      const line = `${dir} 帧 [${name}] sub=0x${low} len=${body.length} ${detail || hex}`;
      if (noisy) logger.debug("arkhub-gateway", line);
      else logger.info("arkhub-gateway", line);
    };

    /** 发送一帧（mainID + subID + body）——先日志后写 socket */
    const send = (mainID: number, subID: bigint, proto: Buffer): void => {
      if (sock.destroyed) return;
      logFrame("→", mainID, subID, proto);
      sock.write(buildFrame(mainID, subID, proto));
    };

    /** handler 上下文（连接状态 + 网关配置 + send）——注入路由分发 */
    const ctx: ArkhubSessionHandlerContext = { state, opts, send };

    sock.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= MIN_FRAME_LEN) {
        const len = buffer.readUInt32BE(0);
        if (len < MIN_FRAME_LEN || len > MAX_FRAME_LEN) {
          // 帧头非法——断开（不解析）
          sock.destroy();
          return;
        }
        if (buffer.length < len) break; // 等待完整帧
        const mainID = buffer.readUInt32BE(4);
        const subID = buffer.readBigUInt64BE(8);
        const body = buffer.subarray(MIN_FRAME_LEN, len);
        buffer = buffer.subarray(len);
        logFrame("←", mainID, subID, body);

        try {
          const frame: ArkhubSessionFrame = {
            mainID,
            subID,
            low32: subID & 0xffffffffn,
            body,
          };
          router.dispatch(ctx, frame);
        } catch (e) {
          logger.warn("arkhub-gateway", `帧处理失败: ${(e as Error).message}`);
        }
      }
    });

    sock.on("error", (e) => logger.debug("arkhub-gateway", `连接错误: ${e.message}`));
  };

  // 自动避让监听：首选端口被占 → 依次尝试 port, port+1, ...（每次新建 server，避免复用
  // 同一 server 重 listen 的回调错乱）；全部避让端口被占返回 null（enterHall 回退官服）
  return new Promise((resolve) => {
    const tryListen = (p: number, attempt: number): void => {
      const server = net.createServer(handleConnection);
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempt + 1 < maxPortTries) {
          tryListen(p + 1, attempt + 1);
          return;
        }
        if (e.code === "EADDRINUSE") {
          logger.warn(
            "arkhub-gateway",
            `端口 ${port}~${p} 均被占用（耗尽 ${maxPortTries} 次避让），本地网关未启动`,
          );
          resolve(null);
          return;
        }
        logger.error("arkhub-gateway", `本地网关启动失败: ${e.message}`);
        resolve(null);
      });
      server.listen(p, () => {
        const actualPort = (server.address() as net.AddressInfo).port;
        _localGatewayActive = true;
        _localGatewayPort = actualPort;
        if (attempt > 0) {
          logger.warn(
            "arkhub-gateway",
            `端口 ${port} 被占用，本地网关避让到 :${actualPort}（客户端可进入空广场）`,
          );
        } else {
          logger.info("arkhub-gateway", `本地网关已监听 :${actualPort}（客户端可进入空广场）`);
        }
        resolve(server);
      });
    };
    tryListen(port, 0);
  });
}
