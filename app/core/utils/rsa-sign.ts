/**
 * 私服响应签名（RSA-MD5 / PKCS#1 v1.5）
 *
 * 客户端 `CryptUtils.VerifySignMD5RSA(content, sign, publicKey)` 对 `network_config` 与
 * BSON/加密响应做验签，公钥取自 `GlobalOptions.cryptoPubKey`（Unity 资产内 TextAsset，见
 * `scripts/sign-key.ts`）。私服无官方私钥，因此两条路二选一：
 *   1) Lua 插件把 `VerifySignMD5RSA` hotfix 成恒 true（`lua/plugin/NetworkRedirectPlugin.lua` 既有行为）；
 *   2) **换用自己的密钥对**：`scripts/sign-key.ts` 改写 asset 内公钥 + 本模块用配套私钥真实签名。
 *
 * 本模块只负责 (2) 的签名侧：私钥缺省读 `data/crypto/private.pem`（可用 `SIGN_KEY_PATH` 覆盖）。
 * 未生成密钥时返回 `null`，调用方保持历史行为（占位 sign），不影响既有私服流程。
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { logger } from "./logger";

/** 缺省私钥路径（仓库根 data/crypto/private.pem，gitignored） */
const DEFAULT_KEY_PATH = path.join(__dirname, "..", "..", "..", "data", "crypto", "private.pem");

/** 私钥缓存（避免每请求读盘） */
let cachedKey: crypto.KeyObject | null = null;
/** 是否已尝试加载（含失败，避免反复告警） */
let loadAttempted = false;

/**
 * 解析私钥路径（环境变量优先）。
 * @returns 私钥文件路径
 */
function resolveKeyPath(): string {
  return process.env.SIGN_KEY_PATH || DEFAULT_KEY_PATH;
}

/**
 * 懒加载私钥；文件缺失/解析失败时返回 null 并只告警一次。
 * @returns 私钥或 null
 */
export function loadSignKey(): crypto.KeyObject | null {
  if (cachedKey !== null || loadAttempted) return cachedKey;
  loadAttempted = true;
  const keyPath = resolveKeyPath();
  try {
    if (!fs.existsSync(keyPath)) {
      logger.debug("sign", `未找到签名私钥（${keyPath}），响应签名回退为占位值`);
      return null;
    }
    cachedKey = crypto.createPrivateKey(fs.readFileSync(keyPath, "utf-8"));
    logger.info("sign", `响应签名已启用：${keyPath}`);
    return cachedKey;
  } catch (e) {
    logger.warn("sign", `私钥加载失败（${keyPath}）：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * 用私钥对内容做 RSA-MD5 签名。
 * @param content - 待签名内容（UTF-8）
 * @returns base64 签名；无可用私钥时返回 null
 */
export function trySignContent(content: string): string | null {
  const key = loadSignKey();
  if (!key) return null;
  try {
    return crypto.sign("md5", Buffer.from(content, "utf8"), key).toString("base64");
  } catch (e) {
    logger.warn("sign", `签名失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * 签名 `{sign, content}` 信封（无密钥时退化为历史占位 `sign: "sign"`）。
 * @param content - 已序列化的响应内容
 * @returns 官方信封结构
 */
export function signedEnvelope(content: string): { sign: string; content: string } {
  return { sign: trySignContent(content) ?? "sign", content };
}
