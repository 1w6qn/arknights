/**
 * 私服验签密钥工具：生成 RSA 密钥对 + 把客户端 asset 里的官服公钥替换成我们的
 *
 * 背景（`docs/crypto-resign-2026-09-13.md`）：
 *   客户端对 `network_config` 与 BSON/加密响应做 RSA-MD5 验签，公钥来自
 *   `GlobalOptions.cryptoPubKey`（Unity 资产 `assets/bin/Data/sharedassets0.assets.split5` 内的
 *   TextAsset `arknights_key`，内容为 .NET XML 形式 `<RSAKeyValue>…`，长度 **243 字节**）。
 *   私服无官方私钥 → 只能 ①让插件把验签 hotfix 成恒 true（本仓既有做法），或
 *   ②**换成我们自己的密钥对**：asset 公钥等长替换 + 服务端用私钥真实签名（本工具，走 ②）。
 *
 * 等长约束：官方 Modulus base64 为 172 字符（1024 位，.NET 小端字节序），Exponent 4 字符；
 * 新密钥同样用 **1024 位 + 指数 65537**（`AQAB`，同为 4 字符）⇒ XML 总长恰好仍是 243 字节，
 * 资产内长度前缀/偏移不变（无需重建 SerializedFile）。
 *
 * 用法：
 *   pnpm run sign:key -- --gen                                   # 生成密钥对到 data/crypto/
 *   pnpm run sign:key -- --show                                  # 打印当前公钥 XML 与指纹
 *   pnpm run sign:key -- --patch-apk --in <apk> --out <apk> [--sign]   # 替换 asset 内公钥
 *   pnpm run sign:key -- --sign <content> [--file <路径>]         # 用私钥签名（RSA-MD5/PKCS1，base64）
 *   pnpm run sign:key -- --verify <content> --signature <b64>     # 用公钥验签（自检）
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import yauzl from "yauzl";
import { patchApk, inspectApk, verifyPatchedApk, type ApkReplacement } from "./apk-patch";
import { signApk } from "./apk-sign";

/** 仓库根目录 */
const ROOT = path.join(__dirname, "..");
/** 密钥存放目录（gitignored） */
const KEY_DIR = path.join(ROOT, "data", "crypto");
/** 私钥（PKCS#8 PEM，仅供服务端签名使用） */
const PRIVATE_KEY_PATH = path.join(KEY_DIR, "private.pem");
/** 公钥（.NET XML，供替换 asset / Lua 插件使用） */
const PUBLIC_XML_PATH = path.join(KEY_DIR, "public.xml");
/** 公钥所在 Unity 资产条目 */
const PUBKEY_ASSET_ENTRY = "assets/bin/Data/sharedassets0.assets.split5";
/** 公钥 XML 期望长度（官方实测 243 字节；替换必须等长） */
const PUBKEY_XML_LEN = 243;
/** 新密钥模数位数（1024 位 ⇒ base64 172 字符，与官方等长） */
const KEY_BITS = 1024;

/**
 * 由公钥导出 .NET XML 形式（`FromXmlString` 语义：Modulus/Exponent 均为**小端**字节序）。
 * @param publicKey - Node 公钥对象
 * @returns `<RSAKeyValue>…</RSAKeyValue>` 字符串
 */
export function publicKeyToDotNetXml(publicKey: crypto.KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  const n = Buffer.from(jwk.n ?? "", "base64url").reverse(); // 小端
  const e = Buffer.from(jwk.e ?? "", "base64url").reverse();
  return `<RSAKeyValue><Modulus>${n.toString("base64")}</Modulus><Exponent>${e.toString("base64")}</Exponent></RSAKeyValue>`;
}

/**
 * 生成 RSA 密钥对并写盘（私钥 PEM + 公钥 XML）。
 * @param force - 覆盖已存在的密钥
 * @returns 公钥 XML
 */
export function generateKeyPair(force = false): string {
  if (!force && fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error(`私钥已存在：${PRIVATE_KEY_PATH}（如需覆盖请加 --force）`);
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: KEY_BITS,
    publicExponent: 65537,
  });
  const xml = publicKeyToDotNetXml(publicKey);
  if (Buffer.byteLength(xml, "utf8") !== PUBKEY_XML_LEN) {
    throw new Error(`公钥 XML 长度 ${Buffer.byteLength(xml, "utf8")} != ${PUBKEY_XML_LEN}（等长替换前提被破坏）`);
  }
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  fs.writeFileSync(PUBLIC_XML_PATH, xml + "\n");
  return xml;
}

/**
 * 读取公钥 XML（缺失时报错提示先生成）。
 * @returns 公钥 XML（无换行）
 */
export function readPublicXml(): string {
  if (!fs.existsSync(PUBLIC_XML_PATH)) {
    throw new Error(`未找到公钥：${PUBLIC_XML_PATH}。请先执行 pnpm run sign:key -- --gen`);
  }
  return fs.readFileSync(PUBLIC_XML_PATH, "utf-8").trim();
}

/**
 * 读取私钥（缺失时报错提示先生成）。
 * @returns 私钥 KeyObject
 */
export function readPrivateKey(): crypto.KeyObject {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error(`未找到私钥：${PRIVATE_KEY_PATH}。请先执行 pnpm run sign:key -- --gen`);
  }
  return crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_PATH, "utf-8"));
}

/**
 * 由 .NET XML 公钥解析出 KeyObject（Modulus/Exponent 为小端字节序）。
 * @param xml - `<RSAKeyValue>…</RSAKeyValue>` 字符串
 * @returns 公钥 KeyObject
 */
export function dotNetXmlToPublicKey(xml: string): crypto.KeyObject {
  const m = /<Modulus>([^<]+)<\/Modulus>/.exec(xml);
  const e = /<Exponent>([^<]+)<\/Exponent>/.exec(xml);
  if (!m || !e) throw new Error("公钥 XML 解析失败（缺 Modulus/Exponent）");
  const n = Buffer.from(m[1], "base64").reverse();
  const exp = Buffer.from(e[1], "base64").reverse();
  const jwk = { kty: "RSA", n: n.toString("base64url"), e: exp.toString("base64url") };
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * 读取公钥 KeyObject（来自 data/crypto/public.xml）。
 * @returns 公钥 KeyObject
 */
export function readPublicKey(): crypto.KeyObject {
  return dotNetXmlToPublicKey(readPublicXml());
}

/**
 * 用指定公钥验签（内存态，供测试/服务端自检）。
 * @param content   - 原文（UTF-8）
 * @param signature - base64 签名
 * @param publicKey - 公钥
 * @returns 是否通过
 */
export function verifyWithKey(content: string, signature: string, publicKey: crypto.KeyObject): boolean {
  return crypto.verify("md5", Buffer.from(content, "utf8"), publicKey, Buffer.from(signature, "base64"));
}

/**
 * 用私钥签名（RSA-MD5 / PKCS#1 v1.5，与服务端 `VerifySignMD5RSA` 一致）。
 * @param content - 待签名内容（UTF-8）
 * @param key     - 私钥（缺省读盘）
 * @returns base64 签名
 */
export function signContent(content: string, key?: crypto.KeyObject): string {
  const privateKey = key ?? readPrivateKey();
  return crypto.sign("md5", Buffer.from(content, "utf8"), privateKey).toString("base64");
}

/**
 * 用公钥验签（自检/测试用）。
 * @param content   - 原文（UTF-8）
 * @param signature - base64 签名
 * @returns 是否通过
 */
export function verifyContent(content: string, signature: string): boolean {
  return verifyWithKey(content, signature, readPublicKey());
}

/**
 * 在 APK 资产内把官服公钥替换为我们的公钥（等长校验）。
 * @param apkPath - 源 APK
 * @param keyXml  - 我们的公钥 XML
 * @returns 该条目的替换（未命中则抛错）
 */
export function buildPubkeyReplacement(apkPath: string, keyXml: string): Promise<ApkReplacement> {
  return new Promise((resolve, reject) => {
    yauzl.open(apkPath, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(new Error(`APK 打开失败: ${err?.message ?? "unknown"}`));
      zf.on("entry", (e) => {
        if (e.fileName !== PUBKEY_ASSET_ENTRY) return zf.readEntry();
        zf.openReadStream(e, (openErr, rs) => {
          if (openErr || !rs) return reject(new Error(`读取资产失败: ${openErr?.message ?? "unknown"}`));
          const chunks: Buffer[] = [];
          rs.on("data", (c: Buffer) => chunks.push(c));
          rs.on("error", reject);
          rs.on("end", () => {
            const buf = Buffer.concat(chunks);
            const needle = Buffer.from(keyXml, "utf8");
            const idx = buf.indexOf(Buffer.from("<RSAKeyValue>", "utf8"));
            if (idx < 0) return reject(new Error(`资产内未找到 <RSAKeyValue>（${e.fileName}）`));
            const end = buf.indexOf(Buffer.from("</RSAKeyValue>", "utf8"), idx);
            if (end < 0) return reject(new Error("资产内 RSAKeyValue 未闭合"));
            const oldLen = end + "</RSAKeyValue>".length - idx;
            if (oldLen !== needle.length) {
              return reject(
                new Error(
                  `公钥长度不等长：资产内 ${oldLen} 字节 vs 新公钥 ${needle.length} 字节（必须等长，否则 SerializedFile 结构位移）`,
                ),
              );
            }
            const out = Buffer.from(buf);
            needle.copy(out, idx);
            console.log(`[sign-key] ${e.fileName}: 公钥已替换（offset=${idx}，${needle.length} 字节，等长 ✓）`);
            resolve({ entry: e.fileName, data: out });
          });
        });
      });
      zf.on("end", () => reject(new Error(`未找到资产条目：${PUBKEY_ASSET_ENTRY}`)));
      zf.on("error", (e) => reject(new Error(`APK 扫描失败: ${e.message}`)));
      zf.readEntry();
    });
  });
}

/** CLI 参数 */
interface CliArgs {
  gen: boolean;
  force: boolean;
  show: boolean;
  patchApk: boolean;
  inApk: string;
  outApk: string;
  sign: boolean;
  signContent: string;
  verifyContent: string;
  signature: string;
  outDir: string;
  syncPlugin: boolean;
}

/**
 * 解析命令行参数。
 * @param argv - 参数（不含 node/脚本名）
 * @returns 解析结果
 */
function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    gen: false,
    force: false,
    show: false,
    patchApk: false,
    inApk: "",
    outApk: "",
    sign: false,
    signContent: "",
    verifyContent: "",
    signature: "",
    outDir: path.join(ROOT, "tmp", "apk-out"),
    syncPlugin: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--gen") a.gen = true;
    else if (v === "--force") a.force = true;
    else if (v === "--show") a.show = true;
    else if (v === "--patch-apk") a.patchApk = true;
    else if (v === "--in") a.inApk = argv[++i] ?? "";
    else if (v === "--out") a.outApk = argv[++i] ?? "";
    else if (v === "--sign") a.sign = true;
    else if (v === "--content") a.signContent = argv[++i] ?? "";
    else if (v === "--verify-content") a.verifyContent = argv[++i] ?? "";
    else if (v === "--signature") a.signature = argv[++i] ?? "";
    else if (v === "--out-dir") a.outDir = argv[++i] ?? a.outDir;
    else if (v === "--sync-plugin") a.syncPlugin = true;
    else if (v === "--help" || v === "-h") {
      console.log(
        "用法: pnpm run sign:key -- [--gen [--force]] [--show]\n" +
          "            [--patch-apk --in <apk> --out <apk> [--sign]]  [--sync-plugin]\n" +
          "            [--sign --content <文本>] [--verify-content <文本> --signature <b64>]",
      );
      process.exit(0);
    }
  }
  return a;
}

/** CLI 入口 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.gen) {
    const xml = generateKeyPair(args.force);
    console.log(`[sign-key] 已生成 ${KEY_BITS} 位密钥对：`);
    console.log(`  私钥: ${PRIVATE_KEY_PATH}（服务端签名用，勿提交）`);
    console.log(`  公钥: ${PUBLIC_XML_PATH}（${Buffer.byteLength(xml)} 字节，等长于官方 243 字节 ✓）`);
    console.log(`  ${xml}`);
    return;
  }

  if (args.syncPlugin) {
    const xml = readPublicXml();
    const pluginPath = path.join(ROOT, "lua", "plugin", "NetworkRedirectPlugin.lua");
    const src = fs.readFileSync(pluginPath, "utf-8");
    const re = /local PUBLIC_KEY_XML = \[\[<RSAKeyValue>[\s\S]*?\]\]/;
    if (!re.test(src)) {
      console.error(`[sign-key] 未在 ${pluginPath} 找到 PUBLIC_KEY_XML 常量`);
      process.exit(1);
    }
    const next = src.replace(re, `local PUBLIC_KEY_XML = [[${xml}]]`);
    fs.writeFileSync(pluginPath, next);
    console.log(`[sign-key] 已把公钥同步进 Lua 插件：${pluginPath}`);
    console.log(`  提示：重新打包插件 bundle（pnpm run repack:lua …--inline-plugins）后才会生效`);
    return;
  }

  if (args.show) {
    const xml = readPublicXml();
    const der = readPublicKey().export({ type: "spki", format: "der" });
    console.log(`公钥 XML（${Buffer.byteLength(xml)} 字节）:\n  ${xml}`);
    console.log(`SPKI SHA-256 指纹: ${crypto.createHash("sha256").update(der).digest("hex")}`);
    return;
  }

  if (args.signContent) {
    console.log(signContent(args.signContent));
    return;
  }

  if (args.verifyContent) {
    const ok = verifyContent(args.verifyContent, args.signature);
    console.log(ok ? "verify: OK" : "verify: FAIL");
    process.exit(ok ? 0 : 1);
  }

  if (args.patchApk) {
    if (!args.inApk || !fs.existsSync(args.inApk)) {
      console.error(`[sign-key] --in 必须是存在的 APK：${args.inApk || "(空)"}`);
      process.exit(1);
    }
    const xml = readPublicXml();
    const info = inspectApk(args.inApk);
    console.log(`[sign-key] 源: ${args.inApk}（${(info.fileSize / 1e6).toFixed(1)} MB，${info.entryCount} 条）`);
    const replacement = await buildPubkeyReplacement(args.inApk, xml);
    const out = args.outApk || path.join(args.outDir, `${path.basename(args.inApk).replace(/\.apk$/i, "")}-pubkey.apk`);
    const report = patchApk({ inApk: args.inApk, outApk: out, replacements: [replacement], stripV1: true, dryRun: false });
    console.log(`[sign-key] 写出 ${out}（${(report.outSize / 1e6).toFixed(1)} MB）`);
    const problems = verifyPatchedApk(out, new Map(report.replaced.map((r) => [r.entry, r.newCrc])));
    if (problems.length) {
      console.error("[sign-key] 自检失败：");
      for (const p of problems.slice(0, 10)) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log("[sign-key] 自检通过（条目 CRC/布局/对齐）");
    if (args.sign) {
      const signed = signApk({
        inApk: out,
        outDir: args.outDir,
        outApk: path.join(args.outDir, `${path.basename(out).replace(/\.apk$/i, "")}-signed.apk`),
      });
      console.log(`[sign-key] 已签名: ${signed}`);
    }
    return;
  }

  console.error("用法见 --help");
  process.exit(1);
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[sign-key] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
