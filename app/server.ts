/**
 * DoctorateTs 服务器启动编排（由根 index.ts 调用）
 *
 * 启动 Express 服务器，初始化所有模块，注册路由和中间件。
 */

import express from "express";
import * as path from "path";
import config from "@core/config/index";
import { logger, flush as flushLogs } from "@utils/logger";
import { formatTimestamp, parseVirtualTime } from "@utils/time";
import { createTrafficRecorder } from "@utils/traffic-recorder";
import { captureManager } from "@capture/capture-manager";
import { assetHooks } from "@ops/assets/asset-hooks";
import { registerAssetHooks } from "@core/config/asset-hooks";
import excel from "@excel/excel";
import morgan from "morgan";
import compression, { filter as compressionFilter } from "compression";
import prod from "@core/config/prod";
import { remoteConfigRouter } from "@core/config/remote-config";
import { createHostRouter } from "@core/config/host-router";
import auth from "@core/auth/auth";
import asset from "@ops/assets/asset";
import game, { setup } from "./game/app";
import bodyParser from "body-parser";
import { accountManager } from "@game/modules/account/account-manager";

/**
 * 应用启动入口函数
 * 
 * 执行以下步骤：
 * 1. 更新游戏数据和生成类型（可选）
 * 2. 启用 Immer 补丁功能
 * 3. 初始化 Excel 数据表
 * 4. 创建 Express 应用
 * 5. 注册中间件（JSON解析、日志记录）
 * 6. 注册路由（配置、认证、游戏、资源）
 * 7. 启动服务器监听
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skipUpdate = args.includes("--skip-update") || args.includes("-s");
  // 激进：默认不跑数据更新（config.autoUpdate=false），仅显式 --auto-update / pnpm run update
  const autoUpdate = args.includes("--auto-update") || config.autoUpdate === true;
  // 运行期自动更新（检测官服 CDN 数据变动 → 自动拉取 + 解包重签）：CLI 或 config 开启
  const watchAutoUpdate =
    args.includes("--auto-update-watch") || config.autoUpdateWatch?.enabled === true;
  // 完全离线模式：命令行参数 --offline/-o 或 data/config.json 中 offline: true
  const offline = args.includes("--offline") || args.includes("-o") || config.offline === true;
  // 抓包专用官服转发模式：命令行 --capture 或 data/config.json 中 capture.enabled: true
  const capture = args.includes("--capture") || config.capture?.enabled === true;
  // capture 模式的核心用途就是抓包：强制开启流量落盘（统一抓包存储 tmp/capture/）
  if (capture) {
    config.debug = { ...config.debug, recordTraffic: true };
    // capture 模式禁用 mod：抓包须还原官服原生行为——mod 会改写热更清单/resVersion 并下发替换资源，
    // 混入 mod 数据会污染抓包对比与协议逆向（客户端行为/资源 hash 均与官服不一致）。
    // 仅运行时关闭（不改写 data/config.json），mod 加载（lua 自动重打包/initMods）与
    // 清单生成（asset.ts 热更清单注入、prod.ts resVersion 签名）随之全部跳过。
    if (config.assets.enableMods) {
      config.assets.enableMods = false;
      logger.info("index", "capture 模式：已禁用 mod（assets.enableMods=false），还原官服原生资源");
    }
  }
  
  if (offline) {
    logger.info("index", "完全离线模式：跳过所有网络操作，使用本地缓存数据");
    const updateModule = await import("../scripts/update-data");
    const code = await updateModule.main(false, true);
    if (code !== 0) {
      logger.error("index", "本地数据不完整，无法离线启动。请先联网执行 `pnpm run update` 初始化数据，");
      logger.error("index", "或去掉 --offline 参数以在线模式启动（会自动回退到本地缓存）。");
      process.exit(1);
    }
    logger.info("index", "本地数据校验通过，继续启动...");
  } else if (!skipUpdate && autoUpdate) {
    if (args.includes("--background-update")) {
      // 后台异步更新：先起服（本地数据），更新完成后热重载 excel——启动秒就绪
      logger.info("index", "后台异步更新模式：立即起服，数据更新完成后热重载");
      void (async () => {
        try {
          const updateModule = await import("../scripts/update-data");
          const code = await updateModule.main(false);
          logger.info("index", `后台数据更新完成（code=${code}），热重载 excel 数据`);
          if (code === 0) {
            await excel.init(); // 重新加载新数据（Excel/Shop 全量重读）
            // 懒加载大表（handbook/charword/skill/enemy 等）后台重新预热
            void excel.warmupLazyTables().catch(() => undefined);
            logger.info("index", "excel 数据已热重载");
          }
        } catch (error) {
          logger.error("index", "后台数据更新失败，使用本地缓存数据:", (error as Error).message);
        }
      })();
    } else {
      logger.info("index", "开始更新游戏数据...");
      try {
        const updateModule = await import("../scripts/update-data");
        await updateModule.main(false);
        logger.info("index", "游戏数据更新完成");
      } catch (error) {
        logger.error("index", "游戏数据更新失败，使用本地缓存数据:", (error as Error).message);
      }
    }
  } else {
    logger.info("index", "跳过游戏数据更新，使用本地缓存数据");
  }
  
  // 独立初始化并行：Excel 数据表 + 统一抓包存储 + mod 预热（互不依赖，均不依赖 Express）——
  // 原串行三段（ excel.init → captureManager.init → initMods ）改为并行，缩短启动关键路径。
  const [excelInitPromise, captureInitPromise, modInitPromise, assetInitPromise] = [
    excel.init(),
    (async () => {
      // 统一抓包存储初始化（幂等）：Dashboard「抓包」Tab / CLI / 各抓包来源共用
      if (config.capture?.root) {
        captureManager.configure({ root: config.capture.root });
      }
      await captureManager
        .init()
        .catch((e) =>
          logger.warn("index", `抓包存储初始化失败: ${(e as Error).message}`),
        );
    })(),
    // 启用 mod 时启动预热加载（避免首个热更清单请求卡在扫描、mod 文件请求早于清单时列表为空）
    config.assets.enableMods
      ? (async () => {
          // 自动重打包内置 Lua bundle 覆盖 mod（工作版本，经真机验证的心跳/加载路径）：
          // 插件源码变更后无需手动 pnpm run repack:lua，服务启动自动整包重建并覆盖下发。
          // （缺省开启，可用 data/config.json 的 assets.autoBuildLuaMod=false 关闭）
          if (config.assets.autoBuildLuaMod !== false) {
            await (await import("@plugin/lua-mod-builder")).ensureLuaModBuilt();
          }
          await (await import("@ops/assets/asset")).initMods();
        })()
      : Promise.resolve(),
    // 一体化资产注册表初始化（幂等）：Dashboard「资产」Tab / 各上游获取与生成点共用
    (async () => {
      const { assetRegistry } = await import("@asset/asset-service");
      await assetRegistry
        .init()
        .catch((e) => logger.warn("index", `资产注册表初始化失败: ${(e as Error).message}`));
    })(),
  ];
  await Promise.all([excelInitPromise, captureInitPromise, modInitPromise, assetInitPromise]);
  const app = express();
  // 响应压缩（B1）：syncData 等大响应（user 全量数 MB）gzip 后传输大幅减小。
  // 放 bodyParser 之前——压缩作用于响应，客户端带 Accept-Encoding: gzip 时生效
  // SSE 实时流（/admin/api/*/stream）排除压缩：zlib 缓冲会破坏逐事件推送
  // level=1：gzip 快速档（CPU ~6ms vs 默认 L6 ~15ms，体积 187KB vs 154KB——LAN 私服带宽充裕，
  // 事件循环时间是更稀缺资源；压缩在响应路径上阻塞主线程）
  app.use(
    compression({
      level: 1,
      filter: (req, res) => {
        if (String(req.url).includes("/stream")) return false;
        return compressionFilter(req, res);
      },
    }),
  );
  app.use(bodyParser.json());
  // capture 模式：捕获非 JSON 原始请求体（multipart 等），转发时原样透传字节——
  // bodyParser.json 不解析 multipart，透传 req.body 会变成 {} 导致官服 400 "Invalid multipart payload format"
  // （实测 POST /activity/arkhub/savePixelArt multipart 2106B → 转发 {} → 400）。JSON 已由 json() 消费，跳过。
  if (capture) {
    app.use((req, _res, next) => {
      if (req.is("application/json")) return next();
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        req.rawBody = Buffer.concat(chunks);
        next();
      });
    });
  }
  app.use(morgan("short"));
  // 调试记录：debug.recordTraffic=true 时保存 request/response 到统一抓包存储 tmp/capture/
  // recordTrafficAllExceptAdmin=true 时为所有除 /admin 外路由开启抓包（覆盖默认排除列表）
  if (config.debug?.recordTrafficAllExceptAdmin) {
    config.debug = {
      ...config.debug,
      recordTraffic: true,
      recordTrafficExclude: ["/admin"],
    };
  }
  // 抓包写入端口由组合根注入（core 层不再缺省绑定 @capture 单例，见 @core/capture/port）
  app.use(createTrafficRecorder(config, capture ? "official" : "private", captureManager));
  // 资产热更钩子由组合根注入（core/config 不得 import ops，见 @core/config/asset-hooks）
  registerAssetHooks(assetHooks);
  // 子域名分发：*.hypergryph.com 请求按官服子域名映射到私服路由
  app.use(createHostRouter());
  app.use("/config/prod", prod);
  app.use("/api/remote_config", remoteConfigRouter);
  app.use("/api/gate", (await import("@core/config/gate")).default);
  // 启动器版本检查（/api/game/get_latest——action:0 空包，客户端无需更新直接启动）
  app.use("/api/game", (await import("@core/config/launcher")).default);
  // 全量对齐（参考 ODPY 旧版路径）：/user/register 等别名到既有 /user/auth/v1/* 实现
  app.use("/", (req, _res, next) => {
    const OLD_AUTH_ALIASES: Record<string, string> = {
      "/user/register": "/user/auth/v1/register",
      "/user/login": "/user/auth/v1/login",
      "/user/sendSmsCode": "/user/auth/v1/send_sms_code",
      "/user/loginBySmsCode": "/user/auth/v1/login_by_smscode",
      "/user/v1/guestLogin": "/user/auth/v1/guest_login",
      "/user/changePassword": "/user/auth/v1/change_password",
      "/user/changePhone": "/user/auth/v1/change_phone",
      "/user/changePhoneCheck": "/user/auth/v1/change_phone_check",
      "/user/checkIdCard": "/user/auth/v1/check_id_card",
      "/user/authenticateUserIdentity": "/user/auth/v1/authenticate_user_identity",
      "/user/updateAgreement": "/user/auth/v1/update_agreement",
    };
    const path = req.path;
    if (OLD_AUTH_ALIASES[path]) {
      req.url = OLD_AUTH_ALIASES[path];
    }
    next();
  });
  // 抓包专用官服转发模式：as/gs 流量转发官服（config/launcher 保持本地——客户端才能被引导连到本代理）
  if (capture) {
    const { createProxyForwarder, warmUpOfficialConnections, registerUpstreams } = await import(
      "@ops/proxy"
    );
    // 静态自定义上游（config.proxy.upstreams）：优先于官方内置求值，可截获本会落到官方兜底的路径。
    // config 结构类型 rules 可选 → 归一化为 ProxyUpstream（缺省空规则）
    registerUpstreams(
      (config.proxy?.upstreams ?? []).map((u) => ({ ...u, rules: u.rules ?? [] })),
    );
    // 预热官服连接（共享 keep-alive 池）：客户端首个请求（登录 getToken 等）免付 TLS 冷启动延迟
    const asHost = config.capture?.asHost ?? "https://as.hypergryph.com";
    const gsHost = config.capture?.gsHost ?? "https://ak-gs-gf.hypergryph.com";
    await warmUpOfficialConnections(asHost, gsHost).catch(() => undefined);
    // arkhub 网关特殊适配：enterHall 返回官服网关地址，客户端随后 WebSocket 连网关——本代理
    // 监听 gatewayPort（缺省 30000）透传官服网关并记录流量，enterHall 响应 endpoint 改写为本代理
    // （网关基础设施已迁入 arkhub 活动模块，经 public 出口消费；抓包记录经注入接入 captureManager）
    const { startArkhubGatewayProxy, setGatewayRecordSink } = await import(
      "@game/modules/activities/arkhub/public"
    );
    // 注入网关抓包记录提交回调（captureManager 未就绪时网关仅落盘不索引）
    setGatewayRecordSink(captureManager);
    const gatewayPort = config.capture?.gatewayPort ?? 30000;
    // 端口自动避让：多实例并存时首选端口被占会依次尝试下一个空闲端口（30000/30001/30002...），
    // 每个实例各自拿到空闲端口，客户端互不干扰。改写用实际监听端口（gw.port）。
    const gw = await startArkhubGatewayProxy({ port: gatewayPort });
    const proxyHost = String(config.Host).replace(/^https?:\/\//, "");
    // 转发器就绪（或避让端口全部被占、配置端口上大概率有另一实例转发器）时都改写 enterHall
    // endpoint 指向本代理——否则客户端直连官服网关、网关流量不经过任何代理（实测无法进入）。
    // 转发器目标主机为动态值：官服 enterHall 响应 endpoint 会变化（2026-08-18 起为
    // arkhub-gateway-canary.hypergryph.com 灰度域名，老域名登录帧 0 响应）——
    // proxy 内置 enterHall 变换器在改写响应前调用 updateGatewayTarget 跟随；启动初始值缺省 canary。
    const arkhubGateway =
      gw.server || gw.exhausted ? { endpoint: proxyHost, port: gw.port } : null;
    app.use(createProxyForwarder({ arkhubGateway }));
    logger.info("index", "抓包官服转发模式已开启：proxy 通用转发管线（自定义上游 + 变换器）转发上游并记录到统一抓包存储 tmp/capture/");
  } else {
    // 私服模式：启动 arkhub 本地会话服（登录 code=100 + 心跳 + 合法 EnterSceneNotify），
    // enterHall 指向本服端口——客户端可进入空广场（不再连不可达的官服网关域名）。
    // 玩法回调绑定收归模块（session/bindings.ts），此处只注入玩家端口（取存档/判存在/懒加载）。
    const { startArkhubSessionServer, createArkhubSessionBindings } = await import(
      "@game/modules/activities/arkhub/public"
    );
    await startArkhubSessionServer({
      port: config.capture?.gatewayPort ?? 30000,
      ...createArkhubSessionBindings({
        get: (uid) => accountManager.data[uid],
        has: (uid) => Boolean(accountManager.configs[uid]),
        ensureLoaded: (uid) => accountManager.getPlayerData(uid).then(() => undefined),
      }),
    });
    // 怪猎对决实时会话服（TCP + 长度前缀帧）：HTTP 侧 queryMatch/createTeam 回报
    // serverAddress=本服:port，客户端据此连上来跑 Waiting→…→Finish 六态流程。
    // 缺省开启（config.multiplayer.enabled=false 关闭）；capture 模式不启动。
    if (config.multiplayer?.enabled !== false) {
      const { startEnemyDuelSessionServer } = await import(
        "@game/modules/activities/enemyDuel/public"
      );
      const mpPort = config.multiplayer?.port ?? 8543;
      await startEnemyDuelSessionServer({
        port: mpPort,
        publicHost: String(config.Host).replace(/^https?:\/\//, ""),
        singlePlayer: config.multiplayer?.singlePlayer ?? true,
        waitSec: config.multiplayer?.waitSec ?? 30,
      });
    }
  }
  // auth 挂根路径：as 域接口（/user/*、/u8/*、/app/* 等）直接命中（用户最终决定，勿改回 /auth）
  app.use("/", auth);
  await setup(game);
  app.use("/", game);
  app.use("/assetbundle", asset);

  // 单例模式：确保固定账号存在（如配置的 singleUid 不存在则自动创建）
  if (config.authMode === "single") {
    const singleUid = config.singleUid || "1";
    try {
      await accountManager.ensureSingleUser(singleUid);
    } catch (error) {
      logger.error("index", "单例账号创建失败:", (error as Error).message);
    }
  }

  // 单例模式：自动生成满配账号（全干员/全物品——随版本刷新，版本变化重新生成）
  if (config.authMode === "single" && config.singleAutoMaxAccount !== false) {
    const singleUid = config.singleUid || "1";
    try {
      const player = await accountManager.getPlayerData(singleUid);
      const marker = player?._playerdata?.status?.maxAccountResVersion;
      if (player && marker !== config.version.resVersion) {
        const { generateMaxedAccount } = await import("../scripts/generate-max-account");
        await generateMaxedAccount(player);
        await accountManager.flushSave(singleUid);
        logger.info("index", `单例满配账号已生成（${singleUid}，版本 ${config.version.resVersion}）`);
      }
    } catch (error) {
      logger.error("index", "满配账号生成失败:", (error as Error).message);
    }
  }

  app.use("/admin", (await import("@ops/admin/admin-router")).default);
  // GM 面板：/gm 静态面板 + 引导端点，/admin/<snake_op> 兼容操作端点（归档服务端 GM 契约）
  app.use("/admin", (await import("@ops/admin/gm/gm-ops-router")).default);
  app.use("/gm", (await import("@ops/admin/gm/gm-router")).default);
  // 自动化桥：MCP 工具的游戏侧执行器 + 命令中转（属控制平面，与 /admin 同类，
  // 故在组合根挂载而非走 game 业务路由表——见 app/ops/automation/automation.routes.ts）
  app.use("/plugin/automation", (await import("@ops/automation/automation.routes")).default);
  // Unity 日志回传：游戏内 Lua 插件把运行期日志分片回传，落盘 data/plugin/logs 供离线分析
  // （同属调试设施，故与 /plugin/automation 一起在组合根挂载，见 plugin-log.routes.ts）
  app.use("/plugin/log", (await import("@ops/plugin/plugin-log.routes")).default);
  const server = app.listen(config.PORT, () => {
    logger.info("index", `--------------DoctorateTs--------------`);
    logger.info("index", `running at http://localhost:${config.PORT}`);
    // 虚拟时钟（DoctoratePy server.virtualtime 移植）：冻结为常量时钟时显式告警——
    // 依赖时间流逝的结算（每日刷新/基建产能/AP 与信赖恢复）在此期间不推进
    const virtualTs = parseVirtualTime(config.virtualtime);
    if (virtualTs !== null) {
      logger.warn(
        "index",
        `虚拟时钟已启用（config.virtualtime）：服务器逻辑时间冻结于 ${virtualTs}（${formatTimestamp(new Date(virtualTs * 1000))}）`,
      );
    }
    // B5：后台预热懒加载大表（消除首访 handbook/charword/skill/enemy 表 30-65ms 同步 parse 卡顿）
    void excel
      .warmupLazyTables()
      .then((ms) => logger.info("Excel", `懒加载大表后台预热完成（${ms}ms，请求路径已无首访卡顿）`))
      .catch(() => undefined);
    logger.info("index", `命令行已就绪：终端输入管理 CLI 命令（如 users list --json），exit 退出命令行`);
    // 服务器内嵌命令行 REPL（日志与命令行共存；非 TTY 自动跳过）
    import("@ops/admin/server-repl").then((m) => m.startServerRepl());
    // 后台版本检测提示（非阻塞）：本地数据较旧时提醒 pnpm run update（默认已跳过自动更新）
    if (!offline && !autoUpdate && !watchAutoUpdate) {
      checkRemoteVersionHint().catch(() => undefined);
    }
    // 运行期自动更新（检测官服 CDN 数据变动 → 自动拉取 + 解包重签）：开启后不再仅提示，自动执行
    if (!offline && watchAutoUpdate) {
      import("@ops/updater/auto-update-watch").then(({ autoUpdateWatch }) =>
        autoUpdateWatch.start((config.autoUpdateWatch?.intervalMinutes ?? 15) * 60 * 1000),
      );
    }
  });
/**
 * 后台检测官服最新数据版本（非阻塞）：本地数据较旧时提示 pnpm run update。
 * 仅提示不更新——默认启动已跳过自动更新（config.autoUpdate=false）。
 */
async function checkRemoteVersionHint(): Promise<void> {
  try {
    const res = await fetch("https://ak-conf.hypergryph.com/config/prod/official/Windows/version", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    // 官服 version 端点响应（仅消费 resVersion）
    const data: { resVersion?: string } = await res.json();
    const remote = String(data.resVersion ?? "").split("_")[0];
    const local = (config.version?.windows?.resVersion ?? config.version?.resVersion ?? "").split("_")[0];
    if (remote && local && remote !== local) {
      logger.warn("index", `检测到新版本数据（本地 ${local} → 官服 ${remote}），运行 \`pnpm run update\` 更新`);
    }
  } catch {
    // 网络失败静默（离线/无网环境）
  }
}

  // 端口被占用等监听失败：明确报错并退出（替代默认 uncaughtException 兜底的"无声挂起"）
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error("index", `端口 ${config.PORT} 被占用，无法启动——可能已有实例在运行。`);
      logger.error("index", `排查：netstat -ano | findstr :${config.PORT}，结束占用进程或换端口启动。`);
    } else {
      logger.error("index", `监听失败: ${err.message}`);
    }
    process.exit(1);
  });
}