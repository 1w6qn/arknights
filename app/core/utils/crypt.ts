/**
 * 加密解密工具模块
 * 
 * 提供游戏数据的加密解密功能，包括战斗数据、作弊检测数据和战斗回放数据。
 */

import crypto from "crypto";
import JSZip from "jszip";
import type { JsonValue } from "./json-value";

const LOG_TOKEN_KEY = "pM6Umv*^hVQuB6t&";

/**
 * 解密战斗数据
 *
 * 使用 AES-128-CBC 算法解密战斗数据，密钥由 LOG_TOKEN_KEY 和登录时间生成。
 *
 * 分层（2026-09-13）：本文件在 `app/core/`，**不得依赖 game**（R1）。战斗载荷类型
 * `BattleData` 属 game 领域，故返回值泛型化——调用方显式传 `<BattleData>`：
 * `await decryptBattleData<BattleData>(data, loginTime)`（缺省 `JsonValue`，仅供不解构字段的场景）。
 *
 * @param data - 加密的战斗数据（十六进制字符串）
 * @param loginTime - 登录时间戳
 * @returns 解密后的战斗数据对象（调用方声明的形状）
 */
export async function decryptBattleData<T = JsonValue>(
  data: string,
  loginTime: number,
): Promise<T> {
  const battleData = Buffer.from(data.slice(0, data.length - 32), "hex");
  const src = LOG_TOKEN_KEY + loginTime.toString();
  const key = crypto.createHash("md5").update(src).digest();
  const iv = Buffer.from(data.slice(data.length - 32), "hex");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const decryptedData = decipher.update(battleData);
  const decrypt = Buffer.concat([decryptedData, decipher.final()]).toString();
  return JSON.parse(decrypt) as T;
}

/**
 * 加密战斗数据
 * 
 * 使用 AES-128-CBC 算法加密战斗数据，密钥由 LOG_TOKEN_KEY 和登录时间生成。
 * 
 * @param data - 要加密的战斗数据对象
 * @param loginTime - 登录时间戳
 * @returns 加密后的十六进制字符串
 */
export async function encryptBattleData<T>(
  data: T,
  loginTime: number,
): Promise<string> {
  const jsonData = JSON.stringify(data);
  const src = LOG_TOKEN_KEY + loginTime.toString();
  const key = crypto.createHash("md5").update(src).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  let encryptedData = cipher.update(jsonData, "utf8", "hex");
  encryptedData += cipher.final("hex");
  return encryptedData + iv.toString("hex");
}

/**
 * 加密战斗 ID 用于作弊检测
 * 
 * 将战斗 ID 的每个字节加 7 后进行 Base64 编码。
 * 
 * @param battleId - 战斗 ID
 * @returns 加密后的字符串
 */
export async function encryptIsCheat(battleId: string): Promise<string> {
  return btoa(
    Buffer.from(battleId)
      .map((v) => v + 7)
      .toString(),
  );
}

/**
 * 解密作弊检测数据
 * 
 * 将 Base64 解码后的数据每个字节减 7 还原原始战斗 ID。
 * 
 * @param isCheat - 加密的作弊检测数据
 * @returns 原始战斗 ID
 */
export async function decryptIsCheat(isCheat: string): Promise<string> {
  return Buffer.from(isCheat, "base64")
    .map((v) => v - 7)
    .toString();
}

/**
 * 解密战斗回放数据
 * 
 * 战斗回放数据经过 Base64 编码和 ZIP 压缩，此函数进行反向操作。
 * 
 * @param battleReplay - Base64 编码的战斗回放数据
 * @returns 解密后的战斗回放对象（严格 JSON 域：回放包未建模，取值须显式收窄）
 */
export async function decryptBattleReplay(
  battleReplay: string,
): Promise<JsonValue> {
  const data = Buffer.from(battleReplay, "base64");
  const zip = await new JSZip().loadAsync(data);
  return JSON.parse(await zip.files["default_entry"].async("string"));
}

/** 密码哈希前缀（scrypt——私服账号存储；旧 sha256$/明文账号登录时惰性升级） */
const PASSWORD_HASH_PREFIX = "scrypt$";
/** 旧版哈希前缀（单轮无盐 sha256——仅用于校验存量账号，验证通过后升级为 scrypt） */
const LEGACY_SHA256_PREFIX = "sha256$";
/** scrypt 派生密钥长度（字节） */
const SCRYPT_KEYLEN = 32;
/** scrypt 盐长度（字节） */
const SCRYPT_SALT_BYTES = 16;

/**
 * 定长字符串常量时间比较
 *
 * 长度不同直接返回 false（长度本身不是秘密）；长度相同走 `timingSafeEqual`，
 * 避免按字节短路比较泄露前缀信息。
 * @param a - 待比较字符串
 * @param b - 待比较字符串
 * @returns 是否相等
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * 密码哈希（scrypt + 每账号随机盐，不可逆）
 * @param password - 明文密码
 * @returns `scrypt$<saltHex>$<hashHex>` 格式字符串
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${PASSWORD_HASH_PREFIX}${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * 校验密码（兼容旧 sha256$ 哈希与更早的明文存储）
 *
 * 存储值前缀决定算法：`scrypt$` 按新方案比对；`sha256$` 按旧方案比对；
 * 其余按旧明文比对（匹配后调用方应惰性升级为 scrypt）。所有分支均为常量时间比较。
 * @param stored - 存储值（scrypt/sha256 哈希或旧明文）
 * @param input - 输入明文
 * @returns 是否匹配
 */
export function verifyPassword(stored: string, input: string): boolean {
  if (!stored) return false;
  if (stored.startsWith(PASSWORD_HASH_PREFIX)) {
    const parts = stored.split("$");
    const saltHex = parts[1];
    const hashHex = parts[2];
    if (!saltHex || !hashHex) return false;
    const derived = crypto.scryptSync(
      input,
      Buffer.from(saltHex, "hex"),
      hashHex.length / 2,
    );
    return timingSafeEqualString(derived.toString("hex"), hashHex);
  }
  if (stored.startsWith(LEGACY_SHA256_PREFIX)) {
    const expect = crypto
      .createHash("sha256")
      .update(input)
      .digest("hex");
    return timingSafeEqualString(
      expect,
      stored.slice(LEGACY_SHA256_PREFIX.length),
    );
  }
  return timingSafeEqualString(stored, input);
}

/**
 * 是否为哈希存储（false = 旧明文，登录成功后应升级）
 * @param stored - 存储值
 * @returns 是否为 scrypt$/sha256$ 前缀的哈希
 */
export function isHashedPassword(stored: string): boolean {
  return (
    !!stored &&
    (stored.startsWith(PASSWORD_HASH_PREFIX) ||
      stored.startsWith(LEGACY_SHA256_PREFIX))
  );
}

/**
 * 是否需要在验证通过后重新哈希升级（明文/旧 sha256 → scrypt）
 * @param stored - 存储值
 * @returns true 表示当前存储不是最新的 scrypt 方案
 */
export function needsPasswordRehash(stored: string): boolean {
  return !stored || !stored.startsWith(PASSWORD_HASH_PREFIX);
}