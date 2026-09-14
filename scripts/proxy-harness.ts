import express from "express";
import axios, { AxiosError, RawAxiosRequestHeaders } from "axios";
import http from "http";
import https from "https";
import morgan from "morgan";
import { logger } from "@utils/logger";
import { captureManager } from "@capture/capture-manager";

/**
 * 官服独立抓包代理（pnpm run ts，端口 8444）
 *
 * 客户端（network_config 指向本代理）→ 本代理 → 按官服路由规则分发到官方主机。
 * 与主服务器 --capture 模式规则同源（resolveForwardTarget 语义一致），可独立运行；
 * 抓包记录写入统一抓包存储（captureManager → tmp/capture/，source=harness），
 * 与主服务器抓包（source=official/private）同库，可统一在 Dashboard「抓包」Tab 查看。
 *
 * 用法：
 *   pnpm run ts                          # 默认启动（自动会话）
 *   pnpm run ts -- --session 登录链路      # 指定命名会话
 *   pnpm run ts -- --quiet               # 抑制 INFO 日志
 *
 * 路由分发规则（路径前缀 → 官方主机，注册顺序即匹配优先级）：
 *   /config/*                      → ak-conf.hypergryph.com/config
 *   /u8/*                          → as.hypergryph.com/u8
 *   /auth/*                        → as.hypergryph.com（as 域带 /auth 前缀的私服形式）
 *   /app/*                         → as.hypergryph.com/app
 *   /user/auth|info|online|oauth2*、/general/* → as.hypergryph.com（as 域根路径形式）
 *   /game/*                        → ak-gs-gf.hypergryph.com（ak-gs 域带 /game 基址前缀形式）
 *   /api/gate/*                    → ak-webview.hypergryph.com/api/meta
 *   /api/*                         → game-config.hypergryph.com/api
 *   其余 POST（根路径游戏域）       → ak-gs-gf.hypergryph.com
 */
const PORT = 8444;
const BASE = `http://127.0.0.1:${PORT}`;

/** 官服连接复用池（与主服务器 official-forward 同配置）：避免每请求 TLS 握手 */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30000 });

const args = process.argv.slice(2);
const sessionArg = args[args.indexOf("--session") + 1];
const quiet = args.includes("--quiet");
if (quiet) process.env.LOG_LEVEL = "error";

const app = express();
app.use(express.json());
// 非 JSON 原始请求体捕获（multipart 等）：bodyParser.json 不解析 multipart，转发 req.body
// 会变成 {} 导致官服 400 "Invalid multipart payload format"，这里按原字节透传
app.use((req, _res, next) => {
  if (req.is("application/json")) return next();
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
});
app.use(morgan(":method :url :status :res[content-length] - :response-time ms"));

/** 启动时初始化抓包存储；--session 指定时复用同名运行中会话，否则新建 */
async function setupSession(): Promise<string | null> {
  await captureManager.init();
  if (!sessionArg) return null;
  const sessions = await captureManager.listSessions();
  const open = sessions.find((s) => s.name === sessionArg && s.endedAt === null);
  if (open) {
    logger.info("harness", `复用会话「${sessionArg}」(${open.id})`);
    return open.id;
  }
  const s = await captureManager.startSession(sessionArg, "harness", "独立抓包代理（proxy-harness）");
  logger.info("harness", `新建会话「${sessionArg}」(${s.id})`);
  return s.id;
}

const createProxyHandler = (baseUrl: string) => {
  return async (req: express.Request, res: express.Response) => {
    // 官服对双斜杠路径返回 404，归一化去掉前导斜杠，保证拼出的转发 URL 无 //
    // Express 5 的通配路由（`/*endpoint`）把通配段挂成数组，而 @types/express 声明为
    // `ParamsDictionary`（string）——此处按运行期真值收窄（非数组时包一层，行为与 join 一致）。
    const endpointParam: string | string[] = req.params.endpoint;
    const endpoint: string = (Array.isArray(endpointParam) ? endpointParam : [endpointParam])
      .join("/")
      .replace(/^\/+/, "");
    const startedAt = Date.now();

    try {
      // 转发头剥离 host/content-length/transfer-encoding：客户端原始 body 可能带空白（content-length
      // 偏大），express.json 解析后 axios 重序列化变短——透传 content-length 会让官服按声明长度等
      // 剩余字节而挂起；去掉后由 axios 按实际 body 重算。
      const forwardedHeaders: RawAxiosRequestHeaders = { ...req.headers };
      delete forwardedHeaders.host;
      delete forwardedHeaders["content-length"];
      delete forwardedHeaders["transfer-encoding"];
      const rawBody = req.rawBody;
      const requestData =
        req.method === "POST"
          ? rawBody && rawBody.length > 0
            ? rawBody
            : req.body
          : undefined;
      const response = await axios({
        method: req.method,
        url: `${baseUrl}/${endpoint}`,
        data: requestData,
        headers: forwardedHeaders,
        params: req.query,
        // 复用 keep-alive 连接池：避免每请求 TLS 握手（首请求冷启动 ~100ms，复用后仅官服 RTT）
        httpAgent: httpAgent,
        httpsAgent: httpsAgent,
        // 官服返回 401/400 等状态属正常（未带有效 secret/参数），不抛异常，原样透传
        validateStatus: () => true,
      });
      res.status(response.status).send(response.data);
      await record(endpoint, req, response.status, response.data, startedAt);
    } catch (error) {
      const axiosError = error as AxiosError; // 类型断言
      // 仅网络层错误（官方主机不可达）返回 502；有响应则已由 validateStatus 透传
      logger.error(
        "harness",
        `转发失败 ${req.method} ${req.originalUrl} → ${baseUrl}/${endpoint}: ${axiosError.message}`,
      );
      res.status(502).send("Bad Gateway");
      await record(endpoint, req, 502, { error: axiosError.message }, startedAt);
    }
  };
};

/** 记录一次转发（请求 + 响应）到统一抓包存储（source=harness） */
async function record(
  endpoint: string,
  req: express.Request,
  status: number,
  resData: unknown,
  startedAt: number,
): Promise<void> {
  try {
    const rawBody = req.rawBody;
    await captureManager.addRecord(
      {
        sessionId: sessionId,
        ts: startedAt,
        method: req.method,
        path: req.originalUrl.split("?")[0],
        query: req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : undefined,
        status,
        latencyMs: Date.now() - startedAt,
        source: "harness",
        reqHeaders: req.headers as Record<string, unknown>,
        resHeaders: {
          "content-type": typeof resData === "object" && !Buffer.isBuffer(resData) ? "application/json" : "application/octet-stream",
        },
        note: `转发 → ${endpoint}`,
      },
      {
        req:
          rawBody && rawBody.length > 0
            ? { kind: "bin", data: rawBody }
            : req.body !== undefined && req.body !== null
              ? { kind: "json", data: req.body }
              : undefined,
        res:
          typeof resData === "object" && !Buffer.isBuffer(resData)
            ? { kind: "json", data: resData }
            : resData !== undefined
              ? { kind: "bin", data: resData }
              : undefined,
      },
    );
  } catch (e) {
    logger.debug("harness", "抓包记录失败:", (e as Error).message);
  }
}

/** 会话 id（setupSession 后填充；null=自动默认会话） */
let sessionId: string | null = null;

app.get("/config/prod/official/network_config", (req, res) => {
  const responseData = {
    sign: "sign",
    content: JSON.stringify({
      configVer: "5",
      // 必须与客户端 Lua 的 `GlobalConfig.CUR_FUNC_VER` 一致：不一致会让 `entry.lua` 顶层早退，
      // 整套 Lua 初始化（含插件加载）变空实现。见 docs/lua-load-chain-reconstructed-2026-09-14.md §4.1
      funcVer: "V077",
      configs: {
        V077: {
          override: true,
          network: {
            gs: BASE,
            as: BASE,
            u8: `${BASE}/u8`,
            hu: "https://ak.hycdn.cn/assetbundle/official",
            hv: "https://ak-conf.hypergryph.com/config/prod/official/{0}/version",
            rc: `${BASE}/config/prod/official/remote_config`,
            an: `${BASE}/config/prod/announce_meta/Android/announcement.meta.json`,
            prean: `${BASE}/config/prod/announce_meta/Android/preannouncement.meta.json`,
            sl: "https://ak.hypergryph.com/protocol/service",
            of: "https://ak.hypergryph.com/index.html",
            pkgAd: "https://ak.hypergryph.com/download",
            pkgIOS: "https://apps.apple.com/cn/app/id1454663939",
            secure: false,
          },
        },
      },
    }),
  };
  res.json(responseData);
});
app.get("/api/game/get_latest", (req, res) => {
  const responseData = {
  "action": 0,
  "version": "76.0.0",
  "request_version": "76.0.0",
  "pkg": {
    "packs": [],
    "total_size": "0",
    "file_path": "https://ak.hycdn.cn/GzD1CpaWgmSq1wew/76.0/update/1/1/Windows/76.0.0_jbAnLFy2dtzNQvii/files",
    "url": "",
    "md5": "",
    "package_size": "0",
    "file_id": "0",
    "sub_channel": "1",
    "game_files_md5": "86f10402f2abeb283624ae90f4a0063a"
  },
  "patch": null,
  "state": 0,
  "launcher_action": 0,
  "pre_patch": null,
  "client_version": "2.7.61"
}
  res.json(responseData);
});
app.get("/api/remote_config/1/prod/default/Windows/network_config", (req, res) => {
  const responseData = {
    "an": "https://ak-conf.hypergryph.com/config/prod/announce_meta/{0}/announcement.meta.json",
    "as": BASE,
    "gs": BASE,
    "hu": "https://ak.hycdn.cn/assetbundle/official",
    "hv": "https://ak-conf.hypergryph.com/config/prod/official/{0}/version",
    "of": "https://ak.hypergryph.com/index.html",
    "sl": "https://ak.hypergryph.com/protocol/service",
    "u8": `${BASE}/u8`,
    "pkgAd": "https://ak.hypergryph.com/download",
    "prean": "https://ak-webview.hypergryph.com",
    "devsdk": false,
    "pkgIOS": "https://apps.apple.com/cn/app/id1454663939",
    "configVer": 5
  }
  res.json(responseData);
});
app.get("/config/*endpoint", createProxyHandler("https://ak-conf.hypergryph.com/config"));
app.post("/u8/*endpoint", createProxyHandler("https://as.hypergryph.com/u8"));
app.get("/auth/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.get("/app/*endpoint", createProxyHandler("https://as.hypergryph.com/app"));
app.post("/auth/*endpoint", createProxyHandler("https://as.hypergryph.com"));
// as 域根路径形式（gs/as 为裸地址时客户端不再带 /auth 前缀）
app.get("/user/auth/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.post("/user/auth/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.get("/user/info/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.post("/user/info/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.get("/user/online/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.post("/user/online/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.get("/user/oauth2/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.post("/user/oauth2/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.get("/general/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.post("/general/*endpoint", createProxyHandler("https://as.hypergryph.com"));
app.post(
  "/game/*endpoint",
  createProxyHandler("https://ak-gs-gf.hypergryph.com"),
);
app.get(
  "/api/gate/*endpoint",
  createProxyHandler("https://ak-webview.hypergryph.com/api/meta"),
);
app.get(
  "/api/*endpoint",
  createProxyHandler("https://game-config.hypergryph.com/api"),
);
// 游戏域根路径兜底（gs 为裸地址或官服域名时，游戏路由以根路径到达：
// /shop/getSkinGoodList、/activity/getActivityCheckInVideoReward、/account/login、
// /user/checkIn、/batch_event 等）。放在最后，as 域根路径规则优先匹配。
app.post("/*endpoint", createProxyHandler("https://ak-gs-gf.hypergryph.com"));

setupSession().then((sid) => {
  sessionId = sid;
  app.listen(PORT, () => {
    logger.info("harness", `官服抓包代理已启动：http://0.0.0.0:${PORT}（抓包记录 tmp/capture/）`);
  });
}).catch((e) => {
  logger.error("harness", `抓包存储初始化失败: ${(e as Error).message}——继续启动（不记录抓包）`);
  app.listen(PORT, () => {
    logger.info("harness", `官服抓包代理已启动：http://0.0.0.0:${PORT}（抓包记录不可用）`);
  });
});
