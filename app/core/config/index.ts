/**
 * 配置模块
 * 
 * 读取并导出应用配置数据，包括服务器地址、端口、版本号、资源配置等。
 */

import { readJsonSync } from "@utils/file";
import os from "os";

/**
 * 自动检测本机局域网 IPv4 地址（真机/模拟器连接场景）
 * 取第一个非回环 IPv4；无局域网 IP 时回退 127.0.0.1
 */
export function detectLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * 网络配置端点值
 *
 * 官方扁平 network_config 的 `network` 表值域：端点地址字符串 /
 * 功能开关布尔（如 secure）/ 官服空占位 null。
 */
export type NetworkEndpointValue = string | boolean | null;

/** 单个网络配置档（`configs[funcVer]`）：覆盖标记 + 端点表 */
export interface NetworkConfigEntry {
  /** 覆盖标记（官方字段，私服不消费） */
  override?: boolean;
  /** 端点表：gs/as/u8/hu/hv/rc/an/prean/sl/of/pkgAd/pkgIOS/secure … */
  network?: Record<string, NetworkEndpointValue>;
}

/**
 * NetworkConfig 文件结构（`data/config.json` 的 NetworkConfig 块）
 *
 * 与官方 `/config/prod/official/network_config` 响应体同构；
 * `devsdk` / `pkgIOS` 为可选顶层字段（官方格式由 game-config 补齐，私服缺省回退）。
 */
export interface NetworkConfigFile {
  /** 配置版本（响应原样下发） */
  configVer?: string;
  /** 功能版本号（update 管线按官服同步，决定 configs 命中档位） */
  funcVer?: string;
  /** 功能版本 → 配置档 */
  configs?: Record<string, NetworkConfigEntry>;
  /** 触达 SDK 开关（官方顶层字段，缺省 false） */
  devsdk?: boolean;
  /** iOS 包地址（客户端 iOS 更新用，私服置空） */
  pkgIOS?: string | null;
}

/** 远程功能开关值域（官方 remote_config 扁平响应的标量值） */
export type RemoteConfigValue = string | number | boolean;

/**
 * 用户配置接口
 * 
 * 定义应用配置的数据结构。
 */
interface UserConfig {
  /** 服务器主机地址 */
  Host: string;
  /** 服务器端口 */
  PORT: number;
  /** 是否完全离线模式启动（不进行任何网络操作，使用本地缓存数据） */
  offline?: boolean;
  /** 是否启动时自动更新数据（缺省 false——激进默认：仅 npm run update / --auto-update 更新） */
  autoUpdate?: boolean;
  /**
   * 运行期自动更新（缺省关闭）：周期探测官服 CDN 数据版本，发现变动即自动
   * 拉取资源并执行「下载→解包→解码转换→生成类型→同步版本」全管线（解包重签），
   * 成功后热重载 excel。可用 CLI `--auto-update-watch` 强制开启。
   */
  autoUpdateWatch?: {
    /** 是否启用运行期自动更新 */
    enabled?: boolean;
    /** 探测间隔（分钟，缺省 15） */
    intervalMinutes?: number;
  };
  /** 登录响应主版本号（客户端校验用——去硬编码，缺省 "446"） */
  majorVersion?: string;
  /** 当前 region（缺省 "cn"；仅 capture 模式消费，见 config/region.ts） */
  region?: string;
  /**
   * region 配置表（capture 模式下按 region 伪装版本/资源通道/转发目标；
   * 字段级回退，零迁移——未配置任何 region 时行为与现状一致）。
   * 结构见 app/core/config/region.ts 的 RegionConfig。
   */
  regions?: Record<string, import("./region").RegionConfig>;
  /** 版本信息 */
  version: {
    /** 资源版本 */
    resVersion: string;
    /** 客户端版本 */
    clientVersion: string;
    /** Windows 独立资源版本（可选；缺省回退 resVersion） */
    windows?: { resVersion: string; clientVersion: string };
  };
  /** 资源配置 */
  assets: {
    /** 是否启用模组 */
    enableMods: boolean;
    /** 是否本地下载 */
    downloadLocally: boolean;
    /** 是否自动更新 */
    autoUpdate: boolean;
    /** 代理模式（odpy 参考）：直接转发官服 CDN，不落盘 */
    downloadPeoxy?: boolean;
    /** 是否启动时自动重打包内置 Lua bundle mod（缺省 true；false 关闭自动构建） */
    autoBuildLuaMod?: boolean;
    /**
     * 资产补全的历史资源版本列表（asset-backfill 探测用，可缺省）。
     * 缺省时自动收集 assets/ 目录下已知版本 + 当前官方版本；
     * 手动补充官方 CDN 上存在但本地从未下载过的历史 resVersion 可提高补全命中率。
     */
    backfillVersions?: string[];
  };
  /** 网络配置（官方 network_config 结构，见 {@link NetworkConfigFile}） */
  NetworkConfig: NetworkConfigFile;
  /** 远程功能配置（新版 remote_config 接口响应，缺省使用官方默认值） */
  RemoteConfig?: Record<string, RemoteConfigValue>;
  /** 抓包专用官服转发模式：as/gs 流量转发官服并记录（等价命令行 --capture） */
  capture?: {
    /** 是否开启官服转发（客户端连接私服，as/gs 请求转发官服；config/asset/admin 仍本地响应）。
     *  开启时强制禁用 assets.enableMods——抓包须还原官服原生资源，mod 污染抓包流量 */
    enabled?: boolean;
    /** capture 专用 region 覆盖（可选；优先于全局 region；缺省跟随 config.region） */
    region?: string;
    /** 官服 as 主机（缺省 https://as.hypergryph.com） */
    asHost?: string;
    /** 官服 gs 主机（缺省 https://ak-gs-gf.hypergryph.com） */
    gsHost?: string;
    /** arkhub 网关本地转发器监听端口（缺省 30000，对齐官服网关端口） */
    gatewayPort?: number;
    /** 统一抓包存储根目录（缺省 tmp/capture；一般无需覆盖） */
    root?: string;
  };
  /**
   * proxy 通用转发管线（capture 模式生效）：静态自定义上游声明。
   * 结构与 app/ops/proxy/upstream.ts 的 ProxyUpstream 一致——core 不依赖 ops（R1），
   * 此处内联结构类型，字段级兼容（rules 缺省 = 空）。
   */
  proxy?: {
    /** 静态自定义上游（优先于官方内置上游求值；同名 id 覆盖，不重复） */
    upstreams?: Array<{
      /** 唯一 id */
      id: string;
      /** 目标主机（如 https://obs.example.com） */
      baseUrl: string;
      /** 有序规则（同一上游内按序求值） */
      rules?: Array<{
        /** Host 通配匹配（小写，* 段通配；如 "ak-gs-*"、"as.*.hypergryph.com"） */
        hosts?: string[];
        /** 路径前缀匹配（精确或 前缀/ 开头） */
        paths?: string[];
        /** 允许的方法（大写；缺省全匹配） */
        methods?: Array<"GET" | "POST" | "PUT" | "DELETE" | "PATCH">;
        /** 转发前剥除的路径前缀（如 "/game"） */
        stripPrefix?: string;
        /** 兜底规则（任意未命中路径；配合 methods，如仅 POST） */
        catchAll?: boolean;
      }>;
    }>;
  };
  /** 奇象巡展（arkhub）配置 */
  arkhub?: {
    /**
     * 渐进引导/剧情推进：true=GuideFlags 初始未开始态（0），玩家完成引导对话
     * （夏妮/收集师捕抓/苍苔对决）逐步推进 flag + 完成出展指引任务 1-3；
     * false=保持完成态（默认，不触发任何引导，零风险）。
     */
    guideProgressive?: boolean;
  };
  /**
   * 怪猎对决（EnemyDuel）实时会话服配置
   *
   * 对应参考实现 OpenBachelorSS（TCP + 长度前缀二进制帧，见
   * `app/game/modules/activities/enemyDuel/session/`）。HTTP 侧 enemyDuel
   * 路由把 `serverAddress` 回报为 `${Host}:${port}`，客户端据此连本服。
   */
  multiplayer?: {
    /** 是否启动会话服（缺省 true；false 时 serverAddress 回退 HTTP 端口，客户端连不上即超时） */
    enabled?: boolean;
    /** 监听端口（缺省 8543，对齐参考实现） */
    port?: number;
    /** 单人模式：所需人数压成 1，单人也能开局（缺省 true，首版只走单人链路） */
    singlePlayer?: boolean;
    /** 等待开局超时秒数（Waiting 态上限，缺省 30） */
    waitSec?: number;
  };
  /** 调试配置 */
  debug?: {
    /** 是否记录请求/响应到统一抓包存储 tmp/capture/（traffic-recorder 中间件） */
    recordTraffic?: boolean;
    /**
     * 抓包记录排除的路径前缀（覆盖默认列表；传空数组 [] = 全部记录）。
     * 默认排除本地管理/资源/配置噪音：/admin /assetbundle /pcSdk /config /api /audit /batch_event
     */
    recordTrafficExclude?: string[];
    /**
     * 抓包记录开关：为所有除 /admin 外的路由开启抓包（录 request/response 到统一抓包存储）。
     * 开启时强制 debug.recordTraffic=true 且仅排除 /admin 前缀——不再默认排除
     * assetbundle/config/api 等本地噪音，全量记录协议对比所需流量。
     */
    recordTrafficAllExceptAdmin?: boolean;
  };
  /** 管理后台配置 */
  admin?: {
    /** 是否开启 /admin HTTP 管理接口 */
    enable: boolean;
    /** 管理 API Bearer Token（缺省空——由 `ADMIN_TOKEN` 环境变量或进程内随机令牌兜底） */
    token?: string;
    /**
     * 是否允许远程访问 GM 面板引导接口（`/gm/{config,players,data}`）
     *
     * 缺省 false：引导接口仅限回环（对齐归档 `admin_allow_remote=false`）；
     * 置 true 时远程需携带有效管理令牌，但 `/gm/config` 仍只在回环下回传 admin_token。
     */
    allowRemote?: boolean;
  };
  /** 认证模式：single（单例——secret 强制 1，任意 token 宽松）/ real（真实——多账号严格校验） */
  authMode?: "single" | "real";
  /**
   * real 模式下「未知 token 兜底到默认账号」开关（**缺省关闭**）
   *
   * 历史行为（对齐 DoctoratePy）把任何非配置键的非空 token 收敛到 `singleUid`/首个账号，
   * 便于客户端 SDK 会话 token 直接换取主账号——但等价于「任意字符串即主账号」的认证绕过。
   * 仅在明确需要该兼容行为时置 true；single 模式不受此开关影响（本就收敛到固定账号）。
   */
  authTokenFallback?: boolean;
  /**
   * 登录时未知手机号自动注册开关（**缺省关闭**）
   *
   * 历史行为：`/user/auth/v1/token_by_phone_password` 用不存在的手机号登录会静默建号，
   * 可被用于批量注册与手机号探测。缺省关闭后应走显式注册端点（`/user/auth/v1/register`）。
   */
  authAutoRegister?: boolean;
  /**
   * 认证端点限流参数（进程内固定窗口，按「IP + 端点」计数）
   *
   * 缺省 `{ windowMs: 60000, max: 20 }`；`max <= 0` 关闭限流（仅建议本地调试）。
   */
  authRateLimit?: {
    /** 窗口长度（毫秒，缺省 60000） */
    windowMs?: number;
    /** 窗口内最大请求数（缺省 20） */
    max?: number;
  };
  /** 官服操作自定义后端（enabled=true 时官服工具库/操作走自定义地址，可指向 obs 观察服务器或自建代理） */
  officialBackend?: {
    enabled?: boolean;
    /** 游戏服务器地址（缺省 https://ak-gs-gf.hypergryph.com） */
    game?: string;
    /** 账号服务器地址（缺省 https://as.hypergryph.com） */
    account?: string;
    /** 配置服务器地址（缺省 https://ak-conf.hypergryph.com） */
    conf?: string;
  };
  /** 单例模式固定账号 uid（默认 "1"——如某账号异常可切换过渡） */
  singleUid?: string;
  /** 单例模式是否自动生成满配账号（全干员/全物品，随版本刷新——默认开启） */
  singleAutoMaxAccount?: boolean;
  /**
   * 虚拟时钟（DoctoratePy `server.virtualtime` 移植）——全局业务时间基准，
   * 由 `@utils/time` 的 `now()` 读取（游戏逻辑/账号同步/客户端可见 serverTime 全部生效）。
   *
   * - 缺省 / ≤ 0：未启用，等价真实时间（保持历史行为；0 亦按未启用处理，避免 1970）
   * - 数值 > 0：冻结到该秒级时间戳（可用于开启旧卡池/旧活动；允许未来值，
   *   但大幅回退会让基建等「按流逝时间结算」的系统出现异常时长，确定后勿随意调小）
   * - 字符串：纯数字串视同数值；或 `YYYY/MM/DD HH:mm:ss`、`DDMMYYYY HH:mm:ss`、
   *   `DD-MM-YYYY HH:mm:ss`、`YYYY-MM-DD HH:mm:ss`、`YYYYMMDD HH:mm:ss`
   *   （本地时区，1~2 位月/日/时/分/秒均接受）；无法解析时回退真实时间
   *
   * 提示：冻结为常量时钟，依赖时间流逝的结算（每日刷新/基建产能/AP 与信赖恢复）
   * 在冻结期间不推进；修改后需重启（config 启动时读入内存）。
   */
  virtualtime?: number | string;
  /** 开发者调试配置 */
  developer?: {
    /**
     * 客户端可见服务器时间戳冻结（activity 切换用，参考 DoctoratePy）：
     * -1（缺省）= 真实时间；数值 = 冻结到该时间戳（仅允许过去时间，未来值回退真实时间）
     */
    timestamp?: number;
    /**
     * 专精技能训练时间强制为 0：调用专精升级（/building/upgradeSpecialization）
     * 时立即完成升级（specializeLevel 直接 +1），无需基建训练室等待（缺省 false）。
     */
    specializationTimeZero?: boolean;
  };
  /** 自定义活动切换（强制开启 + 合约赛季选择 + 资产补全） */
  activities?: {
    /**
     * 强制开启的活动 ID 列表（ActivityTable.basicInfo.id，如 "act1arkhub"）。
     * 忽略时间窗口无条件播种（含活动任务），修剪阶段也跳过这些 ID。缺省空数组。
     */
    forceOpen?: string[];
    /** 危机合约V1赛季（data/crisis/<id>.json，如 "cc2"；缺省 "cc1"） */
    crisisV1?: string;
    /** 危机合约V2赛季（data/crisisV2/<id>.json，如 "cc3"；缺省 "cc1"） */
    crisisV2?: string;
    /**
     * 活动切换后是否自动补全该活动缺失的 asset（后台预取关卡 bundle，缺省 true）。
     * 仅当 assets.downloadLocally=true 时生效。
     */
    autoBackfill?: boolean;
  };
  /** 商店功能配置 */
  shop?: {
    /**
     * 皮肤商店售卖全部皮肤：true 时 /shop/getSkinGoodList 返回 SkinTable 中所有
     * 可购买（isBuySkin）皮肤，而非仅静态 SkinGoodList.json 列出的皮肤（缺省 false）。
     * 动态生成的商品统一按源石（DIAMOND）定价，price 可随皮肤实际价格覆盖。
     */
    skinSellAll?: boolean;
  };
  /** 支付配置（pay 路由） */
  pay?: {
    /**
     * 支付模式：
     * - "fake"（缺省）：虚假支付——createOrder 后 confirmOrderAlipay/Wechat 直接成功，
     *   confirmOrder 立即发货，全程免费（私服测试用）
     * - "real"：真实支付——confirmOrderAlipay/Wechat 仅登记支付，须支付渠道异步回调
     *   /pay/notify（或管理端 `pay order <id> confirm` 手动确认）标记 paid 后，
     *   confirmOrder 才发货
     */
    mode?: "fake" | "real";
    /** 支付宝支付参数（real 模式：app_id/notify 地址/密钥） */
    alipay?: {
      appId?: string;
      notifyUrl?: string;
      privateKey?: string;
    };
    /** 微信支付参数（real 模式：appid/商户号/密钥） */
    wechat?: {
      appId?: string;
      mchId?: string;
      apiKey?: string;
    };
  };
  /**
   * 主数据库后端配置（**可选**——缺省 sqlite，行为与历史版本完全一致）
   *
   * 三选一：`sqlite`（缺省，Node 内置 `node:sqlite`，零依赖单文件）/
   * `mysql` / `postgresql`（网络型后端，需安装可选驱动 mysql2 / pg）。
   *
   * 结构与 app/core/db/config.ts 的 `DatabaseConfigBlock` 字段一致；
   * 亦可由环境变量覆盖（DB_TYPE / DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME），
   * 环境变量优先于本块。切换后端**不会自动搬迁既有数据**——新库为空表，
   * 用户账号会从 users.json 种子重建，好友/回放/存档需另行迁移。
   */
  database?: {
    /** 后端类型（缺省 "sqlite"；亦接受 "postgres"/"pg"/"mariadb" 等别名） */
    type?: import("../db/types").DatabaseBackend;
    /** SQLite 数据库文件路径（type="sqlite" 时生效，缺省 ./data/user/social.db） */
    file?: string;
    /** 主机（type="mysql"|"postgresql" 时生效，缺省 127.0.0.1） */
    host?: string;
    /** 端口（缺省 mysql 3306 / postgresql 5432） */
    port?: number;
    /** 用户名（缺省 mysql root / postgresql postgres） */
    user?: string;
    /** 密码（缺省空串） */
    password?: string;
    /** 库名（缺省 "arknights"；须预先创建，本层只建表不建库） */
    database?: string;
    /** 连接池最大连接数（缺省 10） */
    connectionLimit?: number;
    /** SSL 配置（透传驱动） */
    ssl?: boolean | Record<string, unknown>;
    /** 连接字符集（仅 mysql；缺省 utf8mb4——中文/emoji 兼容） */
    charset?: string;
  };
}

/** 应用配置实例 */
const config = readJsonSync<UserConfig>("./data/config.json");

// Host 支持 "auto"：自动检测本机局域网 IPv4（避免硬编码 IP，换网络环境无需改配置）
if (String(config.Host).includes("auto")) {
  config.Host = `http://${detectLocalIp()}`;
}

/**
 * 端口覆盖：命令行 --port <n> > 环境变量 PORT > config.json
 * 支持不同端口启动：`PORT=9000 npm start` 或 `npm start -- --port 9000`
 * （config.PORT 被 index.ts listen 与各 resolveServer 地址拼接共同消费，统一在此覆盖）
 */
export function resolvePortOverride(args?: string[], envPort?: string): number | null {
  const argv = args ?? process.argv.slice(2);
  const idx = argv.indexOf("--port");
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    const p = Number(argv[idx + 1]);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  }
  const env = envPort !== undefined ? envPort : process.env.PORT;
  if (env !== undefined) {
    const p = Number(env);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  }
  return null;
}

const overridePort = resolvePortOverride();
if (overridePort !== null) {
  config.PORT = overridePort;
}

export default config;