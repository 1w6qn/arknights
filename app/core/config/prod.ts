import { Router } from "express";
import config from "./index";
import { readJson } from "@utils/file";
import { signedEnvelope } from "@utils/rsa-sign";
import { buildNetworkConfigContent } from "./remote-config";
import { getAssetHooks } from "./asset-hooks";
import { resolveRegion, resolveRegionVersion } from "./region";

/** 版本端点签发溯源（fire-and-forget，不阻断响应） */
function traceVersionIssued(platform: string, resVersion: string): void {
  void getAssetHooks()
    .traceVersionIssued({ platform, resVersion })
    .catch(() => undefined);
}

/**
 * 拼接带 mod 签名的 resVersion：替换 hash 部分而非追加后缀，保持官方格式
 * `YYYY-MM-DD-HH-MM-SS_<6位hash>`——追加 `-m` 会破坏客户端 versionId 解析，
 * 导致客户端静默跳过热更（mod 永不下载，见 app/ops/assets/asset.ts getModVersionSuffix 注释）。
 * @param base - 官方 resVersion（如 26-08-07-10-51-39_26e0fc）
 * @param sig  - 6 位 mod 签名（空则不修改版本）
 */
function withModSig(base: string, sig: string): string {
  return base.slice(0, 18) + sig;
}

/**
 * 生效版本：capture + region 伪装（region.version 字段级回退 config.version）；
 * 无生效 region 时返回 config.version（现状）。仅 capture 模式消费——非 capture
 * 的私服游玩场景不伪装，避免破坏客户端正常更新链路。
 */
function servedVersion() {
  const region = resolveRegion();
  return region ? resolveRegionVersion(region, config.version) : config.version;
}

const router = Router();
// Windows 平台独立版本（odpy 参考：config.version.windows；无则回退单版本）
router.get("/official/Windows/version", async (req, res) => {
  const version = servedVersion();
  // 平台独立版本（region 伪装字段级回退后的 ResolvedVersion.windows；缺省回退单版本）
  const win = version.windows;
  let modPatch: { resVersion?: string } = {};
  if (config.assets.enableMods) {
    const hooks = getAssetHooks();
    await hooks.ensureModsLoaded("Windows");
    // 运行时检测 mod 变更（重打包后无需重启即可让 resVersion 变化 → 客户端重新拉取下载）
    await hooks.refreshModsIfChanged("Windows");
    const sig = hooks.getModVersionSuffix("Windows");
    // Windows 与 Android 均需各自平台 mod 签名：resVersion 变更才能触发客户端重新拉取热更清单
    if (sig) modPatch = { resVersion: withModSig(win?.resVersion || version.resVersion, sig) };
  }
  traceVersionIssued("Windows", modPatch.resVersion ?? (win?.resVersion || version.resVersion));
  res.send(Object.assign({}, win || version, modPatch));
});
router.get("/official/Android/version", async (req, res) => {
  const version = servedVersion();
  let modPatch: { resVersion?: string } = {};
  if (config.assets.enableMods) {
    const hooks = getAssetHooks();
    await hooks.ensureModsLoaded("Android");
    // 运行时检测 mod 变更（重打包后无需重启即可让 resVersion 变化 → 客户端重新拉取下载）
    await hooks.refreshModsIfChanged("Android");
    const sig = hooks.getModVersionSuffix("Android");
    // 确定性签名：mod 不变则版本稳定（避免随机 +0..99 每次启动全量重下），mod 变更才变
    if (sig) modPatch = { resVersion: withModSig(version.resVersion, sig) };
  }
  traceVersionIssued("Android", modPatch.resVersion ?? version.resVersion);
  res.send(Object.assign({}, version, modPatch));
});
// hv 端点格式：/config/prod/official/{clientVersion}/version（客户端按版本号请求）
router.get("/official/:version/version", async (req, res) => {
  const version = servedVersion();
  let modPatch: { resVersion?: string } = {};
  if (config.assets.enableMods) {
    // 通用版本端点无法判定平台，回退 Android mod 集
    const hooks = getAssetHooks();
    await hooks.ensureModsLoaded("Android");
    // 运行时检测 mod 变更（重打包后无需重启即可让 resVersion 变化 → 客户端重新拉取下载）
    await hooks.refreshModsIfChanged("Android");
    const sig = hooks.getModVersionSuffix("Android");
    if (sig) modPatch = { resVersion: withModSig(version.resVersion, sig) };
  }
  traceVersionIssued("Android", modPatch.resVersion ?? version.resVersion);
  res.send(Object.assign({}, version, modPatch));
});
router.get("/official/network_config", async (req, res) => {
  const content = buildNetworkConfigContent();
  // 真实签名（RSA-MD5）：仅当 data/crypto/private.pem 存在时启用；否则退回历史占位 sign，
  // 由 Lua 插件的 VerifySignMD5RSA hotfix 兜底（见 app/core/utils/rsa-sign.ts 注释）。
  res.send(signedEnvelope(content));
});
router.get("/official/refresh_config", async (req, res) => {
  res.send(servedVersion());
});
router.get("/official/remote_config", async (req, res) => {
  res.send({
    enableGameBI: false,
    enableSDKNetSecure: true,
    enableBestHttp: true,
  });
});
// 公告元数据（平台参数化——Android/Windows/iOS）
router.get(
  "/announce_meta/:platform/preannouncement.meta.json",
  async (req, res) => {
    res.send(await readJson("./data/announce/preannouncement.meta.json"));
  },
);
router.get(
  "/announce_meta/:platform/announcement.meta.json",
  async (req, res) => {
    res.send(await readJson("./data/announce/announcement.meta.json"));
  },
);
// 容错：客户端 URL 拼接（announce_meta + /api/gate/meta 误拼成一条请求）——返回公告
router.get(
  "/announce_meta/:platform/preannouncement.meta.json/api/gate/meta/:gatePlatform",
  async (req, res) => {
    res.send(await readJson("./data/announce/preannouncement.meta.json"));
  },
);

/** 1x1 透明 PNG（静态图片占位） */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);



/** bilibili 渠道网络配置（ODPY 独有，stub 复用官方网络配置） */
router.get("/b/network_config", async (_req, res) => {
  res.send({});
});

/** 官方资源文件审计（/official/Android/assets/<hash>/<file>；私服无资源返回空） */
router.get("/official/Android/assets/:assetsHash/:fileName", async (_req, res) => {
  res.send({});
});

export default router;
