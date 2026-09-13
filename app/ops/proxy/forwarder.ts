/**
 * 通用转发中间件（forwarder.ts）
 *
 * 从 official-forward.ts 重构而来：旧 createOfficialForwarder 的 axios 转发逻辑保留，
 * 上游解析改走 upstream.ts 的 resolveProxyTarget（自定义 + 官方内置），请求/响应经
 * transform.ts 变换器管线（可编程修改 headers/body/status/responseBody）。
 *
 * 流程：resolveProxyTarget → 未命中 next() / 命中 → 剥头+rawBody → applyRequestTransforms
 * → axios 转发 → applyResponseTransforms → res 回写；网络层错误 → 502。
 */
import { RequestHandler } from "express";
import axios, { AxiosError, RawAxiosRequestHeaders } from "axios";
import http from "http";
import https from "https";
import { logger } from "@utils/logger";
import config from "../../core/config";
import { resolveRegion, resolveRegionAsPrefixes, resolveRegionHosts } from "../../core/config/region";
import type { ArkhubGatewayInfo } from "@game/modules/activities/arkhub/public";
import {
  AS_PATH_PREFIXES,
  OFFICIAL_AS_HOST,
  OFFICIAL_GS_HOST,
  resolveAllUpstreams,
  resolveProxyTarget,
} from "./upstream";
import {
  applyRequestTransforms,
  applyResponseTransforms,
  ProxyTransformContext,
  setArkhubGatewayInfo,
} from "./transform";

/**
 * 官服连接复用 agent（模块级共享）：所有转发请求复用同一连接池——
 * 避免每请求重新 TLS 握手（首请求冷启动实测 ~100-170ms，复用后 ~60ms 官服 RTT）。
 * Node 24 全局 agent 默认已 keep-alive，这里显式建池保证跨版本行为一致且可调。
 */
export const officialHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
export const officialHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: 30000,
});

/**
 * 预热官服连接（capture 启动时调用）
 *
 * 用共享 agent 向 as/gs 各发一个轻量请求，提前建立 TLS 连接——客户端首个请求
 * （登录 getToken/oauth2 等）不再付 TLS 冷启动延迟（实测首个请求 171ms vs 之后 58-61ms）。
 * 轻量端点：as 用 /general/v1/server_time（GET 快返回），gs 用 /account/login（空 body 400 快返回）。
 *
 * @param asHost - 上游 as 主机
 * @param gsHost - 上游 gs 主机
 */
export async function warmUpOfficialConnections(
  asHost: string,
  gsHost: string,
): Promise<void> {
  await Promise.allSettled([
    axios({
      method: "GET",
      url: `${asHost}/general/v1/server_time`,
      httpAgent: officialHttpAgent,
      httpsAgent: officialHttpsAgent,
      validateStatus: () => true,
      timeout: 5000,
    }),
    axios({
      method: "POST",
      url: `${gsHost}/account/login`,
      data: {},
      headers: { "content-type": "application/json" },
      httpAgent: officialHttpAgent,
      httpsAgent: officialHttpsAgent,
      validateStatus: () => true,
      timeout: 5000,
    }),
  ]);
}

/** 转发中间件选项 */
export interface ProxyForwarderOptions {
  /** arkhub 网关代理信息（capture 模式启动 30000 转发器后传入；缺省/null 时不改写 enterHall 响应） */
  arkhubGateway?: ArkhubGatewayInfo | null;
}

/**
 * 创建通用转发中间件
 *
 * 仅应在 capture 模式下挂载（index.ts 按 --capture / config.capture.enabled 判断）。
 * 命中转发的请求直接 res 返回上游响应（不 next()），未命中的调用 next() 走本地路由。
 * 上游表 = 已注册自定义（config/API）+ 官方内置（region/capture 主机覆写）。
 * 转发响应经外层 traffic-recorder 中间件自动落盘 tmp/（capture 模式已强制开启记录）。
 *
 * @param opts - 转发选项（arkhub 网关代理信息）
 * @returns Express 中间件
 */
export function createProxyForwarder(opts: ProxyForwarderOptions = {}): RequestHandler {
  const { arkhubGateway } = opts;
  // 注入 arkhub 网关代理信息（内置 enterHall 变换器消费；null = 转发器未启动不改写）
  setArkhubGatewayInfo(arkhubGateway ?? null);

  // region 主机数据源（优先级：region.as/gs → capture.asHost/gsHost 现状 → OFFICIAL_*_HOST）；
  // as 域路径前缀同步扩展（region.asPathPrefixes，yostar 登录链路等）
  const region = resolveRegion();
  const fallbackAs = config.capture?.asHost || OFFICIAL_AS_HOST;
  const fallbackGs = config.capture?.gsHost || OFFICIAL_GS_HOST;
  const hosts = region
    ? resolveRegionHosts(region, fallbackAs, fallbackGs)
    : { as: fallbackAs, gs: fallbackGs };
  const asPathPrefixes = resolveRegionAsPrefixes(region, AS_PATH_PREFIXES);
  // 解析器实际使用：自定义在前 + 官方内置（region/覆写主机）
  const upstreams = resolveAllUpstreams({
    asHost: hosts.as,
    gsHost: hosts.gs,
    asPathPrefixes,
  });

  return async (req, res, next) => {
    const target = resolveProxyTarget(req.method, req.url, req.headers.host || "", upstreams);
    if (!target) return next();

    // 上游对双斜杠路径返回 404：归一化去前导斜杠，保证拼出的转发 URL 无 //
    const endpoint = target.path.replace(/^\/+/, "");

    // 转发头剥离 host/content-length/transfer-encoding：
    // 客户端原始 body 可能带空白/换行（content-length 94B），express.json 解析后 axios
    // 重序列化变短（74B）——透传 content-length 会让上游按声明长度等剩余字节而永久挂起，
    // 去掉后由 axios 按实际发送的 body 重算；transfer-encoding 同理（axios 按 data 定 chunked/定长）。
    const forwardedHeaders: RawAxiosRequestHeaders = { ...req.headers };
    delete forwardedHeaders.host;
    delete forwardedHeaders["content-length"];
    delete forwardedHeaders["transfer-encoding"];

    // POST 转发体：非 JSON（multipart 等）用 server.ts 捕获的原始字节 rawBody 原样透传——
    // express.json 不解析 multipart，透传 req.body（空 {}）会让上游 400 "Invalid multipart payload format"；
    // 无 rawBody（测试/独立挂载）时回退 req.body
    const rawBody = req.rawBody;
    const requestData =
      req.method === "POST"
        ? rawBody && rawBody.length > 0
          ? rawBody
          : req.body
        : undefined;

    // 变换上下文：request 阶段（转发前）先跑管线，可改 headers/body
    let ctx: ProxyTransformContext = {
      method: req.method,
      originalUrl: req.originalUrl ?? req.url,
      path: target.path,
      upstream: target.upstream,
      headers: forwardedHeaders,
      body: requestData,
      status: 200,
      responseBody: undefined,
    };

    try {
      ctx = await applyRequestTransforms(ctx);
      const response = await axios({
        method: req.method,
        url: `${target.baseUrl}/${endpoint}`,
        data: ctx.body,
        headers: ctx.headers,
        // 复用共享连接池（避免每请求 TLS 握手）
        httpAgent: officialHttpAgent,
        httpsAgent: officialHttpsAgent,
        // Express ParsedQs 与 axios params 宽松类型相容
        params: req.query,
        // 上游返回 401/400 等状态属正常（未带有效 secret/参数），不抛异常，原样透传
        validateStatus: () => true,
      });
      // 变换上下文：response 阶段（回写前）跑管线，可改 status/responseBody
      ctx = { ...ctx, status: response.status, responseBody: response.data };
      ctx = await applyResponseTransforms(ctx);
      res.status(ctx.status).send(ctx.responseBody);
    } catch (error) {
      // 仅网络层错误（上游主机不可达/变换器异常）返回 502；有响应则已由 validateStatus 透传
      const axiosError = error as AxiosError;
      logger.error(
        "proxy",
        `转发失败 ${req.method} ${req.originalUrl} → ${target.baseUrl}/${endpoint}: ${axiosError.message}`,
      );
      res.status(502).send("Bad Gateway");
    }
  };
}
