/**
 * 认证策略模块
 *
 * 将 single（单账号私服）与 real（真实多账号）两种认证模式收敛为统一的
 * AuthStrategy 策略接口。authMiddleware 通过策略对象完成 uid 解析，不再直接
 * 分叉 config.authMode；策略工厂是唯一依据 config.authMode 做出模式决策的地方。
 *
 * 依赖注入（2026-09）：real 模式所需的账号能力收敛为 `AuthAccountPort` 端口。
 * 2026-09-13：端口契约下沉 `@core/auth/account-port`（core 不得依赖 game，R2/R1），
 * **缺省绑定移出 kernel**——未显式注入时经 `getAuthAccountPort()` 取账号模块构造时
 * 注册进 core 的实现；测试仍可注入两方法替身。
 */

import type { Request } from "express";
import { getAuthAccountPort } from "@core/auth/account-port";
import type { AuthAccountPort } from "@core/auth/account-port";

export type { AuthAccountPort } from "@core/auth/account-port";

/**
 * 策略工厂读取的最小配置形状
 *
 * 只关心 authMode 与 singleUid，避免依赖完整 config 结构（便于单测与分层解耦）。
 */
export interface AuthStrategyConfig {
  /** 认证模式：single（单账号私服）/ real（真实多账号）；缺省按 single 处理 */
  authMode?: "single" | "real";
  /** 单例模式固定账号 uid（缺省 "1"） */
  singleUid?: string;
}

/**
 * 认证策略接口
 *
 * 封装「从请求解析玩家 uid」的判定逻辑，使 authMiddleware 无需感知 single/real 差异。
 * 新增第三种认证模式时，仅需新增一个实现并在工厂中映射，无需改动中间件。
 */
export interface AuthStrategy {
  /**
   * 从请求解析出玩家 uid
   * @param req - Express 请求（读取 secret 头）
   * @returns 解析出的 uid；无法认证（real 模式 secret 缺失或无效）返回 undefined
   */
  resolveUid(req: Request): Promise<string | undefined>;

  /**
   * 注册新账号（real 模式真正建号；single 模式收敛到固定账号）
   * @param phone - 手机号
   * @param password - 密码
   * @returns 新账号 uid
   */
  registerUid(phone: string, password: string): Promise<string>;

  /**
   * 是否在解析后强制覆盖请求 secret 头为解析出的 uid
   * single 模式为 true（任意/缺失 secret 归一为固定账号）；real 模式为 false（保留客户端 secret）
   */
  readonly forceSecretHeader: boolean;
}

/**
 * 单账号私服策略
 *
 * 任何/缺失 secret 一律收敛到固定账号（config.singleUid || "1"），注册同样返回固定账号，
 * 不进行真实建号（避免污染 configs/users 表）。
 */
export class SingleAccountStrategy implements AuthStrategy {
  /** 单例模式固定账号 uid */
  private readonly _singleUid: string;

  /** singleton 模式强制将请求 secret 头归一为固定账号 */
  readonly forceSecretHeader = true;

  /**
   * @param cfg - 认证策略配置（读取 singleUid）
   */
  constructor(cfg: AuthStrategyConfig) {
    this._singleUid = cfg.singleUid || "1";
  }

  /**
   * 固定返回单例账号 uid（忽略请求中的 secret）
   * @param _req - Express 请求（单例模式不读取）
   * @returns 固定账号 uid
   */
  async resolveUid(_req: Request): Promise<string | undefined> {
    return this._singleUid;
  }

  /**
   * 注册收敛到固定账号（不真正建号）
   * @param _phone - 手机号（忽略）
   * @param _password - 密码（忽略）
   * @returns 固定账号 uid
   */
  async registerUid(_phone: string, _password: string): Promise<string> {
    return this._singleUid;
  }
}

/**
 * 真实多账号策略
 *
 * 校验 secret 为有效账号 uid 或账号 token（经注入的账号端口解析），
 * 无效或缺省返回 undefined；注册同样委托端口真正建号。
 *
 * 端口缺省解析：构造时未注入 → 每次调用经 `getAuthAccountPort()` 取
 * `AccountManager` 构造时向 core 注册的实现（未注册时抛错，不静默降级）。
 */
export class RealAccountStrategy implements AuthStrategy {
  /** real 模式保留客户端 secret 头，不强制覆盖 */
  readonly forceSecretHeader = false;

  /** 账号服务端口（显式注入优先；缺省取 core 注册的账号端口） */
  private readonly _accounts?: AuthAccountPort;

  /**
   * @param accounts - 账号服务端口（缺省 `getAuthAccountPort()` 注册值）
   */
  constructor(accounts?: AuthAccountPort) {
    this._accounts = accounts;
  }

  /**
   * 取生效的账号端口（显式注入优先，否则回落 core 注册值）
   * @returns 账号端口
   */
  private _port(): AuthAccountPort {
    return this._accounts ?? getAuthAccountPort();
  }

  /**
   * 从 secret 头解析 uid
   * @param req - Express 请求（读取 secret 头）
   * @returns 解析出的 uid；secret 缺失或无效返回 undefined
   */
  async resolveUid(req: Request): Promise<string | undefined> {
    const secret = req.headers?.secret as string | undefined;
    if (!secret) return undefined;
    const uid = await this._port().getUidByToken(secret);
    return uid || undefined;
  }

  /**
   * 委托账号端口真正注册新账号
   * @param phone - 手机号
   * @param password - 密码
   * @returns 新账号 uid
   */
  async registerUid(phone: string, password: string): Promise<string> {
    return this._port().registerUser(phone, password);
  }
}

/**
 * 认证策略工厂：唯一依据 config.authMode 做出模式决策的地方
 * @param cfg - 应用配置（读取 authMode / singleUid）
 * @param accounts - 账号服务端口（real 模式使用；缺省取 core 注册的账号端口）
 * @returns 对应当前模式的认证策略实例
 */
export function createAuthStrategy(
  cfg: AuthStrategyConfig,
  accounts?: AuthAccountPort,
): AuthStrategy {
  return cfg.authMode === "real"
    ? new RealAccountStrategy(accounts)
    : new SingleAccountStrategy(cfg);
}