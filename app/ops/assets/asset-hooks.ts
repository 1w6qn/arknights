/**
 * 资产热更钩子的 ops 侧实现（装配点）
 *
 * 把 `app/ops/assets/asset.ts` 的 mod 能力与 `asset-registry/asset-service.ts` 的
 * 溯源能力收敛为 `@core/config/asset-hooks` 的 {@link AssetHooks} 端口实现，
 * 由组合根 `app/server.ts` 在启动期经 `registerAssetHooks` 注入。
 *
 * 存在意义：`app/core/config/prod.ts` 是 core 层，不得直接 import ops（R1）；
 * 端口在 core、实现在 ops、绑定在组合根，是 design-spec §6.2.2 的固定口径。
 */
import {
  ensureModsLoaded,
  getModVersionSuffix,
  refreshModsIfChanged,
} from "./asset";
import { assetRegistry } from "./asset-registry/asset-service";
import type { AssetHooks, VersionDeliveryTrace } from "@core/config/asset-hooks";

/** 端口实现（函数名与 asset 模块一致，便于对照排查） */
export const assetHooks: AssetHooks = {
  async ensureModsLoaded(platform: string): Promise<void> {
    await ensureModsLoaded(platform);
  },

  async refreshModsIfChanged(platform: string): Promise<void> {
    await refreshModsIfChanged(platform);
  },

  getModVersionSuffix(platform: string): string {
    return getModVersionSuffix(platform);
  },

  async traceVersionIssued(trace: VersionDeliveryTrace): Promise<void> {
    await assetRegistry.recordEvent({
      asset: {
        name: "version",
        category: "version",
        source: trace.platform,
        version: trace.resVersion,
      },
      action: "deliver",
      actor: "version-endpoint",
      source: trace.platform,
      version: trace.resVersion,
    });
  },
};
