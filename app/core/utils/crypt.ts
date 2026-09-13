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

/** 密码哈希前缀（sha256——私服账号存储；旧明文账号登录时惰性升级） */
const PASSWORD_HASH_PREFIX = "sha256$";

/**
 * 密码哈希（不可逆——账号存储不落明文）
 * @param password - 明文密码
 * @returns 带前缀的哈希字符串
 */
export function hashPassword(password: string): string {
  return `${PASSWORD_HASH_PREFIX}${crypto
    .createHash("sha256")
    .update(password)
    .digest("hex")}`;
}

/**
 * 校验密码（兼容旧明文账号）
 * 存储值带 sha256$ 前缀则哈希比较；否则按旧明文比较（匹配后调用方应惰性升级为哈希）
 * @param stored - 存储值（哈希或旧明文）
 * @param input - 输入明文
 * @returns 是否匹配
 */
export function verifyPassword(stored: string, input: string): boolean {
  if (!stored) return false;
  if (stored.startsWith(PASSWORD_HASH_PREFIX)) {
    return stored === hashPassword(input);
  }
  return stored === input;
}

/** 是否为哈希存储（false = 旧明文，登录成功后应升级） */
export function isHashedPassword(stored: string): boolean {
  return !!stored && stored.startsWith(PASSWORD_HASH_PREFIX);
}