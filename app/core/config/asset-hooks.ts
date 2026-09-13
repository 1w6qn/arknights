/**
 * 资产热更钩子端口（core 定义，ops/assets 启动装配时注册）
 *
 * 背景：`core/config/prod.ts` 的版本端点需要「平台 mod 加载/变更检测/版本签名」与
 * 「版本投递溯源」两类能力，其实现在 `app/ops/assets/`。core 不得依赖 ops（R1），
 * 故此处声明端口，由组合根 `app/server.ts` 在启动期注入 `@ops/assets/asset-hooks`。
 *
 * 未注册时 {@link getAssetHooks} 返回**安全降级实现**（mod 相关为 no-op/空签名，
 * 溯源为 no-op）——纯 core 单测与未装配 ops 的场景不会崩，只是不产生 mod 补丁与溯源。
 */
/** 平台名（与 asset 模块的 platform 口径一致） */
export type AssetPlatform = string;

/** 版本投递溯源事件（core 侧最小形状；ops 的 AssetEventInput 更宽，结构性兼容） */
export interface VersionDeliveryTrace {
  /** 平台（Windows / Android） */
  platform: AssetPlatform;
  /** 实际投递的 resVersion */
  resVersion: string;
}

/**
 * 资产热更钩子
 *
 * @remarks
 * 四个方法对应 `core/config/prod.ts` 版本端点的全部 ops 依赖点。
 */
export interface AssetHooks {
  /**
   * 确保指定平台的 mod 集已加载（幂等）
   * @param platform - 平台名
   */
  ensureModsLoaded(platform: AssetPlatform): Promise<void>;

  /**
   * 运行时检测 mod 变更（重打包后无需重启即让 resVersion 变化）
   * @param platform - 平台名
   */
  refreshModsIfChanged(platform: AssetPlatform): Promise<void>;

  /**
   * 取平台 mod 版本签名
   * @param platform - 平台名
   * @returns 6 位签名；无 mod 时为空串
   */
  getModVersionSuffix(platform: AssetPlatform): string;

  /**
   * 记录一次版本投递（溯源，fire-and-forget 语义由调用方负责）
   * @param trace - 投递事件
   */
  traceVersionIssued(trace: VersionDeliveryTrace): Promise<void>;
}

/** 安全降级实现（未注册 ops 时使用） */
const FALLBACK: AssetHooks = {
  async ensureModsLoaded() {
    /* 未装配 ops/assets：无 mod 可加载 */
  },
  async refreshModsIfChanged() {
    /* 未装配 ops/assets：无 mod 可刷新 */
  },
  getModVersionSuffix() {
    return "";
  },
  async traceVersionIssued() {
    /* 未装配 ops/assets：不产生溯源事件 */
  },
};

/** 已注册的钩子实现（null = 未注册，回落安全降级） */
let hooks: AssetHooks | null = null;

/**
 * 注册资产热更钩子（组合根启动装配时调用）
 * @param impl - 实现；传 null 注销（回落安全降级）
 */
export function registerAssetHooks(impl: AssetHooks | null): void {
  hooks = impl;
}

/**
 * 取当前生效的资产热更钩子
 * @returns 已注册实现；未注册时返回安全降级实现
 */
export function getAssetHooks(): AssetHooks {
  return hooks ?? FALLBACK;
}
