/**
 * Lua CRYPTIC_A 加解密 + **资产签名**（Android 客户端内置 Lua bundle）
 *
 * 实测格式（2.7.71 Android APK）：
 *   TextAsset.m_Script = [128B RSA 签名][16B IV-XOR][AES-128-CBC(PKCS7) 密文]
 *   - Key = UTF8(mask[0..16])，mask = "UITpAi82pHAWwnzqHRMCwPonJLIB3WCl"
 *     （= excel 管线的 MASK_V2 / PlayerData.chatMask，32 字符）
 *   - IV  = script[128..144] XOR UTF8(mask[16..32])
 *   - 明文 = AES-CBC 解密(script[144:])
 *
 * ★ 128B 头**不是随机数据，而是签名**（2026-09-14 用 RSA 公钥运算反推确证）：
 *   `sign = RSA-1024/PKCS#1 v1.5/MD5(script[128:])`，即签名覆盖 **IV 域 + AES 密文**，
 *   由客户端 `Torappu.CryptUtils.VerifySignMD5RSA(byte[] contentBytes, byte[] sign, string publicKey)`
 *   （RVA 0x042FD3F0）用 `GlobalOptions.cryptoPubKey` 校验。判据：344/344 个官方资产的
 *   `head^e mod n` 都呈 PKCS#1 v1.5 结构且 DigestInfo 摘要 == MD5(script[128:])；
 *   换私服公钥则 0/344（负对照）。同 IV 原样重加密可逐字节复现官方密文（344/344），
 *   所以「重加密被客户端拒绝」不是解密问题，而是**签名对不上** —— 重加密后必须用**自己的私钥重签名**，
 *   并让客户端用**我们的公钥**验签（运行时 frida 换公钥参数，或 APK 资产内等长替换）。
 *
 * 参考：Ark-Unpacker ArkAESLibrary.aes_cbc_decrypt_bytes（key=mask[:16]，
 * iv=data[:16]^mask[16:]），Android Lua 在 16B IV 之前另有 128B 签名头。
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "crypto";

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
 * 用私钥给一段 m_Script 重签名（把 128B 头换成 `RSA-1024/MD5(script[128:])` 的签名）。
 *
 * 为什么必须做：客户端用 `CryptUtils.VerifySignMD5RSA(byte[] contentBytes, byte[] sign, string publicKey)`
 * 校验 `head == Sign(script[128:])`；任何重加密都让旧签名失效 ⇒ 加载器返回 null。
 * 签名覆盖范围是**偏移 128 之后的全部字节**（16B IV 域 + AES 密文）。
 * @param script - 已加密的 m_Script（含占位头；头会被整体替换）
 * @param privateKeyPem - PEM 私钥（须为 1024 位，签名恰好 128 字节）
 * @returns 换好签名的 m_Script
 */
export function signLuaScript(script: Uint8Array, privateKeyPem: string): Uint8Array {
  const key = createPrivateKey(privateKeyPem);
  const signed = Buffer.from(script.subarray(HEAD_LEN));
  const signature = cryptoSign("md5", signed, key);
  if (signature.length !== HEAD_LEN) {
    throw new Error(
      `签名长度 ${signature.length} ≠ ${HEAD_LEN}：Lua 资产头固定 128B，必须用 1024 位 RSA 密钥`,
    );
  }
  return new Uint8Array(Buffer.concat([signature, signed]));
}

/**
 * 解析 .NET XML 公钥（`<RSAKeyValue><Modulus>…<Exponent>…`）。
 *
 * 端序：Modulus/Exponent 的 base64 字节**按大端直接读**——用官服 `network_config` 的真实签名
 * 反证过（大端 + MD5 验签通过；按 CAPI 小端解读则失败）。官方指数是 17（`EQ==`）。
 * @param xml - 公钥 XML
 * @returns Node KeyObject
 */
export function parseDotNetPublicKeyXml(xml: string): KeyObject {
  const modulus = /<Modulus>([^<]+)<\/Modulus>/.exec(xml);
  const exponent = /<Exponent>([^<]+)<\/Exponent>/.exec(xml);
  if (!modulus || !exponent) throw new Error("公钥 XML 解析失败：缺 Modulus/Exponent");
  return createPublicKey({
    key: {
      kty: "RSA",
      n: Buffer.from(modulus[1], "base64").toString("base64url"),
      e: Buffer.from(exponent[1], "base64").toString("base64url"),
    },
    format: "jwk",
  });
}

/**
 * 按客户端同一契约校验一段 m_Script 的 128B 头签名。
 * @param script - m_Script 字节
 * @param publicKeyXml - 客户端会使用的公钥 XML（官方的或我们替换后的）
 * @returns 签名是否有效
 */
export function verifyLuaScriptSignature(script: Uint8Array, publicKeyXml: string): boolean {
  if (script.length <= HEAD_LEN) return false;
  const signature = Buffer.from(script.subarray(0, HEAD_LEN));
  const signed = Buffer.from(script.subarray(HEAD_LEN));
  try {
    return cryptoVerify("md5", signed, parseDotNetPublicKeyXml(publicKeyXml), signature);
  } catch (e) {
    return false;
  }
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
