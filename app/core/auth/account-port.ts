/**
 * 账号认证端口（AccountAuthPort）—— **core 侧契约**
 *
 * 背景：`app/core/auth/auth.ts`（登录/OAuth/改密/改手机号路由）与
 * `app/game/kernel/http/auth-strategy.ts`（uid 解析策略）都需要账号能力，但实现在
 * `app/game/modules/account/AccountManager.ts`。core/kernel 均不得反向依赖 game 模块
 * （R1 / R2，见 tests/unit/architecture/module-boundary.test.ts），故此处声明端口：
 * **接口在 core、实现在 game、绑定在实现侧构造时**（design-spec §6.2.2 端口注入口径）。
 *
 * 两个接口是**宽窄分离**的：
 * - {@link AuthAccountPort}：认证策略需要的最小能力面（token→uid、建号）；
 * - {@link AccountAuthPort}：auth 路由需要的完整账号配置面，扩展前者。
 *
 * 注册：`AccountManager` 构造时经 {@link registerAccountAuthPort} 注册自身，
 * 因此任何取得 AccountManager 实例的代码路径（server.ts、测试 helper）都会自动完成绑定。
 */
import type { UserConfig } from "@core/db/types";

/**
 * 认证策略需要的最小账号能力面
 *
 * 刻意只含两个方法——策略不感知 AccountManager 的其余职责；测试注入两方法替身即可。
 */
export interface AuthAccountPort {
  /**
   * token（uid 或账号 secret）→ uid
   * @param token - 客户端 secret 头值
   * @returns 匹配的 uid；无匹配返回空串（调用方据此判 401）
   */
  getUidByToken(token: string): Promise<string>;

  /**
   * 注册新账号
   * @param phone - 手机号
   * @param password - 密码
   * @returns 新账号 uid
   */
  registerUser(phone: string, password: string): Promise<string>;
}

/**
 * auth 路由需要的完整账号能力面（含账号配置读写）
 */
export interface AccountAuthPort extends AuthAccountPort {
  /**
   * 手机号 + 密码换取 token
   * @param phone - 手机号
   * @param password - 密码
   * @returns 账号 token（secret）
   */
  tokenByPhonePassword(phone: string, password: string): Promise<string>;

  /**
   * 读取账号配置
   * @param uid - 账号 uid
   * @returns 用户配置
   */
  getUserConfig(uid: string): Promise<UserConfig>;

  /** 全量账号配置（uid → UserConfig；只读视图） */
  readonly configs: { [uid: string]: UserConfig };

  /**
   * 修改密码
   * @param uid - 账号 uid
   * @param newPassword - 新密码（明文，由实现负责哈希）
   * @returns 是否成功
   */
  updatePassword(uid: string, newPassword: string): Promise<boolean>;

  /**
   * 修改手机号
   * @param uid - 账号 uid
   * @param newPhone - 新手机号
   * @returns 是否成功
   */
  updatePhone(uid: string, newPhone: string): Promise<boolean>;
}

/** 已注册的账号端口（未注册 = 账号模块尚未加载） */
let port: AccountAuthPort | undefined;

/**
 * 注册账号端口（由 `AccountManager` 构造时调用）
 * @param impl - 端口实现；传 undefined 注销
 */
export function registerAccountAuthPort(impl: AccountAuthPort | undefined): void {
  port = impl;
}

/**
 * 取已注册的账号端口
 * @returns 账号端口实现
 * @throws 未注册时抛错（账号模块未加载 = 装配错误，不应静默降级）
 */
export function getAccountAuthPort(): AccountAuthPort {
  if (!port) {
    throw new Error(
      "AccountAuthPort 未注册：账号模块（AccountManager）尚未加载——请确认组合根已初始化账号服务",
    );
  }
  return port;
}

/**
 * 取认证策略所需的窄端口
 * @returns 同 {@link getAccountAuthPort} 的窄视图
 */
export function getAuthAccountPort(): AuthAccountPort {
  return getAccountAuthPort();
}
