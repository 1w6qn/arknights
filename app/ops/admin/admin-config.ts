/**
 * 管理后台配置模块
 *
 * 令牌解析优先级（安全审阅 2026-09：仓库内硬编码默认令牌等于公开凭据）：
 * 1. `ADMIN_TOKEN` 环境变量；
 * 2. `data/config.json` 的 `admin.token`；
 * 3. 两者均未配置时，为**本次进程**生成随机令牌并打印到日志（不再回退到可猜的常量）。
 *
 * `enable` 缺省 false（安全默认：接口关闭），令牌缺失不会把它打开。
 */
import { randomBytes } from "crypto";
import config from "../../core/config";
import { logger } from "@utils/logger";

/** 管理后台配置接口 */
export interface AdminConfig {
  /** 是否开启 /admin HTTP 管理接口（CLI 不受影响） */
  enable: boolean;
  /** 管理 API Bearer Token */
  token: string;
}

/** 进程内随机令牌（未显式配置时生成一次并复用，避免每次请求变化） */
let ephemeralToken: string | null = null;

/**
 * 读取管理配置
 *
 * token 恒非空：未显式配置时使用进程内随机令牌（见模块头注释）。
 */
export function getAdminConfig(): AdminConfig {
  const admin = config.admin;
  const enable = admin?.enable ?? false;
  const envToken = process.env.ADMIN_TOKEN?.trim();
  const configToken = admin?.token?.trim();
  let token = envToken || configToken || "";
  if (!token) {
    if (!ephemeralToken) {
      ephemeralToken = randomBytes(24).toString("base64url");
      logger.warn(
        "admin",
        `未配置管理令牌（ADMIN_TOKEN 环境变量 / data/config.json 的 admin.token）——` +
          `本次进程已生成随机令牌：${ephemeralToken}（重启后变化，请在 Dashboard/GM 面板输入）`,
      );
    }
    token = ephemeralToken;
  }
  return { enable, token };
}
