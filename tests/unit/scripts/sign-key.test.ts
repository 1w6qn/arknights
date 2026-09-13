/**
 * sign-key 单测：密钥生成（等长约束）、.NET XML 互转、RSA-MD5 签名/验签往返。
 */
import { describe, expect, it } from "vitest";
import * as crypto from "crypto";
import {
  dotNetXmlToPublicKey,
  publicKeyToDotNetXml,
  signContent,
  verifyWithKey,
} from "../../../scripts/sign-key";

/** 生成一对测试密钥（与工具同参数：1024 位 + e=65537） */
function testKeyPair(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 65537 });
}

describe("sign-key", () => {
  it("公钥 XML 与官方 asset 内公钥等长（243 字节，等长替换前提）", () => {
    const { publicKey } = testKeyPair();
    const xml = publicKeyToDotNetXml(publicKey);
    expect(Buffer.byteLength(xml, "utf8")).toBe(243);
    expect(xml.startsWith("<RSAKeyValue><Modulus>")).toBe(true);
    expect(xml.endsWith("</Exponent></RSAKeyValue>")).toBe(true);
  });

  it(".NET XML 往返：导出→解析→验签成功", () => {
    const { privateKey, publicKey } = testKeyPair();
    const xml = publicKeyToDotNetXml(publicKey);
    const parsed = dotNetXmlToPublicKey(xml);
    const content = '{"configVer":"5"}';
    const sig = signContent(content, privateKey);
    expect(verifyWithKey(content, sig, parsed)).toBe(true);
    expect(verifyWithKey(content + "x", sig, parsed)).toBe(false);
  });

  it("我方私钥签名不能被另一方公钥验过（真实校验语义，非放行）", () => {
    const a = testKeyPair();
    const b = testKeyPair();
    const sig = signContent("payload", a.privateKey);
    expect(verifyWithKey("payload", sig, b.publicKey)).toBe(false);
  });

  it("签名是 RSA-1024 PKCS#1 v1.5（128 字节）", () => {
    const { privateKey } = testKeyPair();
    expect(Buffer.from(signContent("x", privateKey), "base64").length).toBe(128);
  });
});
