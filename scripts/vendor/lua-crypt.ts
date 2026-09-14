/**
 * Lua CRYPTIC_A 加解密（Android 客户端内置 Lua bundle）
 *
 * 实测格式（2.7.61 Android APK，bundle d48d924f...bin）：
 *   TextAsset.m_Script = [128B 头部][16B IV-XOR][AES-128-CBC(PKCS7) 密文]
 *   - Key = UTF8(mask[0..16])，mask = "UITpAi82pHAWwnzqHRMCwPonJLIB3WCl"
 *     （= excel 管线的 MASK_V2 / PlayerData.chatMask，32 字符）
 *   - IV  = script[128..144] XOR UTF8(mask[16..32])
 *   - 明文 = AES-CBC 解密(script[144:])（128 字节头不参与解密，内容随机，保留即可）
 *
 * 参考：Ark-Unpacker ArkAESLibrary.aes_cbc_decrypt_bytes（key=mask[:16]，
 * iv=data[:16]^mask[16:]），Android Lua 在 16B IV 之前另有 128B 随机头。
 *
 * 反向加密（repack 注入插件 / 重写 DefinedFix 时使用）：
 *   随机 128B 头 + (随机IV XOR mask[16:32]) + AES-CBC(key, 随机IV) 加密明文。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/** CRYPTIC_A 密钥掩码（= excel 管线 MASK_V2 / chatMask） */
export const LUACRYPT_MASK = Buffer.from("UITpAi82pHAWwnzqHRMCwPonJLIB3WCl");
/** AES Key = mask 前 16 字节 */
const KEY = LUACRYPT_MASK.subarray(0, 16);
/** IV 掩码 = mask 后 16 字节 */
const IV_MASK = LUACRYPT_MASK.subarray(16, 32);
/** 固定头部长度（Android Lua 加密格式）；重打包需保留原始头，故对外导出 */
export const HEAD_LEN = 128;
/** IV 区长度 */
const IV_LEN = 16;

/**
 * 解密一段 Android Lua 密文（m_Script 原始字节 → Lua 明文源码字节）。
 * 头部 128 字节不参与解密；IV = script[128..144] XOR mask[16..32]。
 * @param script - TextAsset.m_Script 原始字节（含 128B 头）
 * @returns Lua 明文源码字节
 */
export function decryptLuaScript(script: Uint8Array): Uint8Array {
  if (script.length < HEAD_LEN + IV_LEN + 16) {
    throw new Error(`Lua 密文过短（${script.length} B），无法解密`);
  }
  const iv = Buffer.alloc(IV_LEN);
  for (let i = 0; i < IV_LEN; i++) {
    iv[i] = script[HEAD_LEN + i] ^ IV_MASK[i];
  }
  const d = createDecipheriv("aes-128-cbc", KEY, iv);
  d.setAutoPadding(true);
  const plain = Buffer.concat([d.update(Buffer.from(script.subarray(HEAD_LEN + IV_LEN))), d.final()]);
  return new Uint8Array(plain);
}

/**
 * 加密一段 Lua 明文为 Android 格式（随机 128B 头 + 随机 IV）。
 * 输出与官方格式一致，客户端加载时按上述规则解密。
 * @param plain - Lua 明文源码字节
 * @param head  - 可选 128 字节头（缺省随机生成；官方头为随机数据，内容不影响解密）
 * @returns Android Lua 密文字节（TextAsset.m_Script 布局）
 */
export function encryptLuaScript(plain: Uint8Array, head?: Uint8Array): Uint8Array {
  const headBuf = head && head.length === HEAD_LEN
    ? Buffer.from(head)
    : randomBytes(HEAD_LEN);
  const iv = randomBytes(IV_LEN);
  const ivStore = Buffer.alloc(IV_LEN);
  for (let i = 0; i < IV_LEN; i++) {
    ivStore[i] = iv[i] ^ IV_MASK[i];
  }
  const c = createCipheriv("aes-128-cbc", KEY, iv);
  c.setAutoPadding(true);
  const enc = Buffer.concat([c.update(Buffer.from(plain)), c.final()]);
  return new Uint8Array(Buffer.concat([headBuf, ivStore, enc]));
}

/**
 * 判断一段 m_Script 是否为 Android 加密格式（长度 ≥ 160 且偏移 128 处能解出合法 UTF-8 文本）。
 * 判据：AES-PKCS7 解密成功（padding 校验）+ 结果可解码为合法 UTF-8（无 U+FFFD 替换符）。
 * 明文 Lua 当密文解密时 padding 校验几乎必然失败（概率 ~1/256，且解出乱码含 U+FFFD），
 * 空文件（加密格式解密回空）亦判为加密。
 * @param script - TextAsset.m_Script 字节
 * @returns 是否加密
 */
export function isLuaEncrypted(script: Uint8Array): boolean {
  if (script.length < HEAD_LEN + IV_LEN + 32) return false;
  try {
    const plain = Buffer.from(decryptLuaScript(script));
    // 全量解码（截断子串会切断 UTF-8 多字节序列产生 U+FFFD 误判）
    const text = plain.toString("utf8");
    return !text.includes("\uFFFD");
  } catch {
    return false;
  }
}
