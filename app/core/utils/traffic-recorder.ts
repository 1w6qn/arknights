/**
 * 调试请求/响应记录中间件（已合并原 game/reqres-log 定向记录能力）
 *
 * 调试时记录每个 HTTP 请求的 request 与 response，写入统一抓包存储
 * （captureManager → tmp/capture/，SQLite 索引 + records/{rid}/ body 文件），
 * 供 Dashboard「抓包」Tab / CLI / 脚本查询与对比（官服 vs 私服逐接口）。
 *
 * 开关（两通道任一开启即启用本中间件的记录判定）：
 * - data/config.json 的 `debug.recordTraffic: true`（默认关，避免正常运行时落盘噪音），
 *   capture 模式（--capture）强制开启；
 * - 环境变量 REQRES_LOG 设为非关闭值（原 game/reqres-log 的开关，默认**关闭**——
 *   行为变更：旧 reqres-log 默认 "rlv2" 常开，与其"临时调试设施"定位相悖，现改为默认关）。
 *
 * 过滤语义：
 * - **默认排除本地管理/资源/配置噪音**：/admin、/assetbundle、/pcSdk、/config、/api、
 *   /audit、/batch_event 等本地挂载请求不记录（协议对比无意义且 /admin 轮询、资源下载量大），
 *   可通过 `debug.recordTrafficExclude` 覆盖（传空数组 [] = 全部记录）。
 * - **include 正向匹配优先于 exclude**：命中 include 前缀（options.include 或 REQRES_LOG）
 *   的请求即使命中排除前缀也记录（修复旧 reqres-log 排除被旁路/语义不互通问题）。
 *
 * 与 morgan 不同：morgan 只输出一行访问日志；本中间件保存完整请求/响应体用于协议对比。
 * 与旧版差异：不再写 tmp/{module}/{endpoint}/{timestamp}.json 散文件——
 * 全部来源（私服/capture 转发/独立代理/官服操作）统一进入 captureManager 存储。
 */
import { RequestHandler } from "express";
import type { CaptureRecorder } from "@capture/capture-recorder";
import { captureManager, CaptureSource } from "@capture/capture-manager";
import { logger } from "@utils/logger";
import { matchesAnyPrefix, LOCAL_ONLY_PREFIXES } from "@utils/path-prefix";

/**
 * 共享"已记录"标记（Symbol.for 全局注册表，跨中间件模块共享）：
 * 同一请求若已被任一 HTTP 抓包中间件记录，其余中间件据此跳过包裹 res，
 * 避免一个请求被多次落库。
 */
export const CAPTURE_RECORDED: unique symbol = Symbol.for("DoctorateTs.capture.recorded");

/**
 * 已挂"已记录"标记的响应对象视图
 *
 * 标记由本中间件在运行期挂到 `res` 上（`Symbol.for` 保证跨模块副本共享），
 * 不在 `@types/express` 的 `Response` 声明内——用精确的 symbol 键视图承接，
 * 避免 `res as unknown as Record<string | symbol, unknown>` 这类模糊断言。
 */
type CaptureMarkedResponse = { [CAPTURE_RECORDED]?: boolean };

/** 应用配置中与本中间件相关的调试字段 */
export interface TrafficRecorderConfig {
  debug?: {
    /** 总开关：记录所有非排除路径的请求/响应 */
    recordTraffic?: boolean;
    /** 排除前缀列表（覆盖默认 LOCAL_ONLY_PREFIXES；[] = 不排除） */
    recordTrafficExclude?: string[];
  };
}

/**
 * REQRES_LOG 解析结果：
 * - `{ enabled: false }` 关闭
 * - `{ enabled: true, prefix: null }` 全部记录（REQRES_LOG=all）
 * - `{ enabled: true, prefix: "/xxx" }` 仅记录命中前缀的请求
 */
export type ReqresLogMode =
  | { enabled: false }
  | { enabled: true; prefix: string | null };

/**
 * 解析 REQRES_LOG 环境变量为记录模式（纯函数，导出供测试）
 *
 * - 缺省/空串/"0"/"false"/"off"（大小写不敏感）→ 关闭
 *   （**行为变更：缺省不再视为 "rlv2"**，默认关闭与临时调试设施定位一致）
 * - "all" → 全部记录（prefix=null）
 * - 其余值 → 视为路径前缀，自动补前导 "/"（如 "battle" → "/battle"、"rlv2" → "/rlv2"）
 *
 * @param raw - REQRES_LOG 原始值（undefined 视为空串）
 * @returns 记录模式
 */
export function parseReqresLogMode(raw?: string | undefined): ReqresLogMode {
  const mode = (raw ?? "").toLowerCase();
  if (mode === "" || mode === "0" || mode === "false" || mode === "off") {
    return { enabled: false };
  }
  if (mode === "all") return { enabled: true, prefix: null };
  return { enabled: true, prefix: mode.startsWith("/") ? mode : `/${mode}` };
}

/** createTrafficRecorder 对象参数形态（推荐：需要 include/note 时使用） */
export interface TrafficRecorderOptions {
  /** 应用配置（读取 debug.recordTraffic / debug.recordTrafficExclude） */
  config: TrafficRecorderConfig;
  /** 抓包来源标记（capture 官服转发模式传 "official"，普通私服 "private"，默认 "private"） */
  source?: CaptureSource;
  /** 写入端口（默认 captureManager 单例；测试可注入 mock） */
  recorder?: CaptureRecorder;
  /**
   * 正向包含前缀：命中的请求**即使命中 exclude 也记录**（include 优先于 exclude）。
   * 与 REQRES_LOG 环境变量的前缀语义一致，两者取并集。
   */
  include?: string[];
  /** 记录备注，透传 addRecord 的 note（如 "reqres-log" 来源标记） */
  note?: string;
}

/**
 * 创建调试记录中间件（兼容两种调用形态）
 *
 * 形态一（对象参数）：`createTrafficRecorder({ config, source?, recorder?, include?, note? })`
 * 形态二（位置参数，既有调用方兼容）：`createTrafficRecorder(config, source?, recorder?)`
 *
 * 拦截 res.send/res.json，在响应发出（finish）后把 request/response 异步写入
 * recorder（默认 captureManager）存储。写入失败仅 logger.debug，不阻塞响应。
 *
 * 判定顺序：
 * 1. 两通道均关闭（recordTraffic=false 且 REQRES_LOG 未启用）→ 直接放行；
 * 2. include 命中（显式 include ∪ REQRES_LOG 前缀，或 REQRES_LOG=all）→ 无条件记录；
 * 3. 未命中 include 时按主开关通道规则过滤（仅 REQRES_LOG 通道时不记录白名单外请求；
 *    主开关开启且未命中 exclude → 记录）。
 *
 * @param options - 对象参数（含 config/source/recorder/include/note）
 * @param config - 形态二：应用配置
 * @param source - 形态二：来源标记
 * @param recorder - 形态二：写入端口
 * @returns Express 中间件
 */
export function createTrafficRecorder(options: TrafficRecorderOptions): RequestHandler;
export function createTrafficRecorder(
  config: TrafficRecorderConfig,
  source?: CaptureSource,
  recorder?: CaptureRecorder,
): RequestHandler;
export function createTrafficRecorder(
  configOrOptions: TrafficRecorderConfig | TrafficRecorderOptions,
  source: CaptureSource = "private",
  recorder: CaptureRecorder = captureManager,
): RequestHandler {
  // 兼容分派：带 config 键 → 对象形态；否则按旧位置参数处理（index.ts / 既有测试不受影响）
  const opts: TrafficRecorderOptions =
    typeof configOrOptions === "object" &&
    configOrOptions !== null &&
    "config" in configOrOptions
      ? (configOrOptions as TrafficRecorderOptions)
      : { config: configOrOptions as TrafficRecorderConfig, source, recorder };

  const sink: CaptureRecorder = opts.recorder ?? captureManager;
  const src: CaptureSource = opts.source ?? "private";
  const note = opts.note;

  // REQRES_LOG 在创建时解析一次（原 reqres-log 为模块加载时读取；创建时读取更可测、可多实例隔离）
  const reqres = parseReqresLogMode(process.env.REQRES_LOG);
  const includes = [...(opts.include ?? [])];
  if (reqres.enabled && reqres.prefix) includes.push(reqres.prefix);
  const forceAll = reqres.enabled && reqres.prefix === null;

  return (req, res, next) => {
    const mainEnabled = !!opts.config.debug?.recordTraffic;
    if (!mainEnabled && !reqres.enabled) return next();
    const pathname = req.originalUrl.split("?")[0];
    // include 优先于 exclude：命中正向前缀（或 REQRES_LOG=all）无条件记录
    const hitInclude = forceAll || matchesAnyPrefix(pathname, includes);
    // 未命中 include 时回落到主开关通道规则：仅主开关开启且未命中排除前缀才记录
    if (!hitInclude) {
      const excludes = opts.config.debug?.recordTrafficExclude ?? LOCAL_ONLY_PREFIXES;
      if (!(mainEnabled && !matchesAnyPrefix(pathname, excludes))) return next();
    }

    // 共享标记：请求已被其他 HTTP 抓包中间件记录 → 跳过，避免同一请求重复落库
    const marked = res as CaptureMarkedResponse;
    if (marked[CAPTURE_RECORDED]) return next();
    marked[CAPTURE_RECORDED] = true;

    const startedAt = Date.now();
    // 非 JSON（multipart 等）请求体：index.ts capture 模式用 rawBody 捕获原始字节
    const rawBody = req.rawBody;

    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);
    let body: unknown;

    res.json = ((data: unknown) => {
      body = data;
      return originalJson(data);
    }) as typeof res.json;

    res.send = ((data: unknown) => {
      body = data;
      return originalSend(data);
    }) as typeof res.send;

    // 响应结束（finish 事件）后异步落库，不阻塞响应
    res.on("finish", () => {
      void (async () => {
        try {
          // Express res.send/res.json 在链上可能已把对象序列化为字符串，统一解析回对象再落盘
          let payload: unknown = body ?? undefined;
          if (typeof payload === "string") {
            try {
              payload = JSON.parse(payload);
            } catch {
              /* 非 JSON 文本（如 404 HTML）保持原样 */
            }
          }
          const url = req.originalUrl.split("?")[0];
          const query = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : undefined;

          // 请求体：rawBody（multipart/二进制原始字节）优先，其次 req.body（JSON）
          const reqBody =
            rawBody && rawBody.length > 0
              ? { kind: "bin" as const, data: rawBody }
              : req.body !== undefined && req.body !== null
                ? { kind: "json" as const, data: req.body }
                : undefined;

          // 响应体：对象→json；Buffer/非 JSON 字符串→bin
          const resBody =
            payload === undefined
              ? undefined
              : typeof payload === "object" && !Buffer.isBuffer(payload)
                ? { kind: "json" as const, data: payload }
                : { kind: "bin" as const, data: payload };

          await sink.addRecord(
            {
              ts: startedAt,
              method: req.method,
              path: url,
              query,
              status: res.statusCode,
              latencyMs: Date.now() - startedAt,
              source: src,
              ...(note !== undefined ? { note } : {}),
              reqHeaders: req.headers as Record<string, unknown>,
              resHeaders: res.getHeaders() as Record<string, unknown>,
            },
            {
              req: reqBody,
              res: resBody,
            },
          );
        } catch (e) {
          logger.debug("traffic-recorder", "记录失败:", (e as Error).message);
        }
      })();
    });

    next();
  };
}
