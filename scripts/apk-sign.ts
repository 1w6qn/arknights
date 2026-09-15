/**
 * APK 重签名封装（uber-apk-signer + 便携 JRE）
 *
 * 与 `scripts/apk-patch.ts` 配套：改造后的 APK 必须重签名才能安装。本模块把
 * 「定位 JDK/JRE → 调用 uber-apk-signer（V1+V2+V3，默认内置 debug 密钥）→ 归位产物 → 校验」
 * 收敛成一次函数调用，并支持把工具链一键拉到 `tmp/tools/`（gitignored）。
 *
 * 用法：
 *   pnpm run apk:sign -- --fetch-tools                                  # 下载 JRE + signer 到 tmp/tools
 *   pnpm run apk:sign -- --in tmp/apk-out/arknights-hg-2771-mod.apk      # 签名（输出同目录 *-signed.apk）
 *   pnpm run apk:sign -- --in <apk> --keystore my.jks --alias k --store-pass *** --key-pass ***
 *   pnpm run apk:sign -- --verify <apk>                                  # 只校验已有签名
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

/** 仓库根目录 */
const ROOT = path.join(__dirname, "..");
/** 便携工具链目录（gitignored） */
const TOOLS_DIR = path.join(ROOT, "tmp", "tools");
/** uber-apk-signer 固定版本下载地址 */
const SIGNER_URL =
  "https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar";
/** Temurin JRE 21（Linux x64）下载地址 */
const JRE_URL = "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre/hotspot/normal/eclipse";

/** 签名选项 */
export interface SignOptions {
  /** 待签名 APK */
  inApk: string;
  /** 产物目录 */
  outDir: string;
  /** 指定输出文件名（缺省沿用 uber-apk-signer 的 *-signed.apk） */
  outApk?: string;
  /** 自定义 keystore（缺省用内置 debug 密钥） */
  keystore?: string;
  /** keystore 别名 */
  ksAlias?: string;
  /** keystore 口令 */
  ksPass?: string;
  /** 私钥口令 */
  ksKeyPass?: string;
  /** 跳过 zipalign（本仓 apk-patch 已自行对齐） */
  skipZipAlign?: boolean;
}

/**
 * 定位可用的 java 可执行文件：优先 tmp/tools 便携 JRE，其次 JAVA_HOME，最后 PATH。
 * @returns java 可执行文件路径
 */
export function resolveJava(): string {
  const candidates = [
    path.join(TOOLS_DIR, "jre", "bin", "java"),
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : "",
  ].filter((p) => p.length > 0);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const probe = spawnSync("java", ["-version"], { encoding: "utf-8" });
  if (probe.error) {
    throw new Error(
      `未找到 java。请先执行：pnpm run apk:sign -- --fetch-tools（下载便携 JRE 到 tmp/tools），或安装 JDK 并设置 JAVA_HOME`,
    );
  }
  return "java";
}

/**
 * 定位 uber-apk-signer jar。
 * @returns jar 路径
 */
export function resolveSignerJar(): string {
  const jar = path.join(TOOLS_DIR, "uber-apk-signer.jar");
  if (!fs.existsSync(jar)) {
    throw new Error(
      `未找到 ${jar}。请先执行：pnpm run apk:sign -- --fetch-tools`,
    );
  }
  return jar;
}

/**
 * 下载工具链（JRE + uber-apk-signer）到 tmp/tools。
 * @returns 工具链就绪信息
 */
export async function fetchTools(): Promise<string> {
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const jreTar = path.join(TOOLS_DIR, "jre21.tar.gz");
  const jar = path.join(TOOLS_DIR, "uber-apk-signer.jar");

  /** 流式下载到文件 */
  const download = async (url: string, dest: string): Promise<void> => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
      console.log(`[apk-sign] 复用已下载: ${dest}（${fs.statSync(dest).size} B）`);
      return;
    }
    console.log(`[apk-sign] 下载 ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    fs.writeFileSync(dest, Buffer.concat(chunks.map((c) => Buffer.from(c))));
    console.log(`[apk-sign] 完成 ${dest}（${fs.statSync(dest).size} B）`);
  };

  await Promise.all([download(JRE_URL, jreTar), download(SIGNER_URL, jar)]);

  const jreDir = path.join(TOOLS_DIR, "jre");
  if (!fs.existsSync(path.join(jreDir, "bin", "java"))) {
    console.log(`[apk-sign] 解包 JRE → ${jreDir}`);
    fs.rmSync(jreDir, { recursive: true, force: true });
    fs.mkdirSync(jreDir, { recursive: true });
    const untar = spawnSync("tar", ["xzf", jreTar, "-C", jreDir, "--strip-components=1"], { encoding: "utf-8" });
    if (untar.status !== 0) throw new Error(`解包 JRE 失败: ${untar.stderr}`);
  }
  const java = resolveJava();
  const ver = spawnSync(java, ["-version"], { encoding: "utf-8" });
  return `java: ${java}（${(ver.stderr || ver.stdout).split("\n")[0].trim()}）\njar:  ${jar}`;
}

/**
 * 在产物目录里挑出**本次**签名产物。
 *
 * 坑：uber-apk-signer 的命名会**去掉输入名末尾的 `-unsigned`**（`X-unsigned.apk` → `X-debugSigned.apk`），
 * 中间还会落一个 `X-aligned.apk`（仅对齐、**未签名**）。早期实现按「输入名去 `.apk`」做前缀匹配，
 * 于是 `X-unsigned.apk` 输入永远匹配不到真签名产物，反而把**输入自身**（或对齐中间产物）当成结果改名成
 * `*-signed.apk` —— 交付物名不副实（2026-09-14 实测：`--sign` 出的 `*-signed.apk` 其实是未签名包）。
 * 现在按「后缀 `signed.apk`（`-debugSigned.apk` / `-signed.apk`）」匹配 + 显式排除输入文件。
 *
 * @param outDir - 产物目录
 * @param inApk - 输入 APK（绝对路径）
 * @param startedAt - 本次签名开始时间（毫秒，用于排除历史产物）
 * @returns 签名产物绝对路径（找不到抛错）
 */
export function findSignedArtifact(outDir: string, inApk: string, startedAt: number): string {
  const inputPath = path.resolve(inApk);
  const baseStem = path.basename(inApk).replace(/\.apk$/i, "").replace(/-unsigned$/i, "");
  const candidates = fs
    .readdirSync(outDir)
    .filter((n) => /signed\.apk$/i.test(n) && n.startsWith(baseStem))
    .map((n) => path.join(outDir, n))
    .filter((p) => path.resolve(p) !== inputPath && fs.statSync(p).mtimeMs >= startedAt - 1000)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`签名命令成功但未在 ${outDir} 找到签名产物（期望前缀 ${baseStem}、后缀 signed.apk）`);
  }
  return candidates[0];
}

/**
 * 调用 uber-apk-signer 对 APK 重签名。
 * @param opts - 签名选项
 * @returns 签名产物路径
 */
export function signApk(opts: SignOptions): string {
  const java = resolveJava();
  const jar = resolveSignerJar();
  const inApk = path.resolve(opts.inApk);
  if (!fs.existsSync(inApk)) throw new Error(`APK 不存在: ${inApk}`);
  const outDir = path.resolve(opts.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();

  const args = ["-jar", jar, "--apks", inApk, "--out", outDir, "--allowResign"];
  if (opts.skipZipAlign) args.push("--skipZipAlign");
  if (opts.keystore) {
    args.push("--ks", path.resolve(opts.keystore));
    if (opts.ksAlias) args.push("--ksAlias", opts.ksAlias);
    if (opts.ksPass) args.push("--ksPass", opts.ksPass);
    if (opts.ksKeyPass) args.push("--ksKeyPass", opts.ksKeyPass);
  }
  console.log(`[apk-sign] ${java} ${args.join(" ")}`);
  const run = spawnSync(java, args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  if (run.stdout) console.log(run.stdout.trim());
  if (run.stderr) console.error(run.stderr.trim());
  if (run.status !== 0) throw new Error(`签名失败（exit=${run.status}）`);

  let result = findSignedArtifact(outDir, inApk, startedAt);
  if (opts.outApk && path.resolve(opts.outApk) !== result) {
    const dest = path.resolve(opts.outApk);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(result, dest);
    // v4 签名（.idsig，adb install --incremental 用）随主体一起改名
    if (fs.existsSync(`${result}.idsig`)) fs.renameSync(`${result}.idsig`, `${dest}.idsig`);
    result = dest;
  }
  console.log(`[apk-sign] 产物: ${result}（${(fs.statSync(result).size / 1e6).toFixed(1)} MB）`);
  return result;
}

/**
 * 校验 APK 签名（调用 uber-apk-signer 的 verify 模式）。
 * @param apkPath - 待校验 APK
 * @returns 控制台输出文本
 */
export function verifyApk(apkPath: string): string {
  const java = resolveJava();
  const jar = resolveSignerJar();
  const run = spawnSync(java, ["-jar", jar, "--onlyVerify", "--apks", path.resolve(apkPath)], {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  if (run.status !== 0) throw new Error(`签名校验失败（exit=${run.status}）:\n${out}`);
  return out;
}

/**
 * 解析命令行参数。
 * @returns CLI 参数对象
 */
function parseCli(): {
  inApk: string;
  outDir: string;
  outApk: string;
  keystore: string;
  alias: string;
  storePass: string;
  keyPass: string;
  fetchTools: boolean;
  verify: string;
  skipZipAlign: boolean;
} {
  const argv = process.argv.slice(2);
  const cli = {
    inApk: "",
    outDir: path.join(ROOT, "tmp", "apk-out"),
    outApk: "",
    keystore: "",
    alias: "",
    storePass: "",
    keyPass: "",
    fetchTools: false,
    verify: "",
    skipZipAlign: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") cli.inApk = argv[++i] ?? "";
    else if (a === "--out-dir") cli.outDir = argv[++i] ?? cli.outDir;
    else if (a === "--out") cli.outApk = argv[++i] ?? "";
    else if (a === "--keystore") cli.keystore = argv[++i] ?? "";
    else if (a === "--alias") cli.alias = argv[++i] ?? "";
    else if (a === "--store-pass") cli.storePass = argv[++i] ?? "";
    else if (a === "--key-pass") cli.keyPass = argv[++i] ?? "";
    else if (a === "--no-skip-zipalign") cli.skipZipAlign = false;
    else if (a === "--fetch-tools") cli.fetchTools = true;
    else if (a === "--verify") cli.verify = argv[++i] ?? "";
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: pnpm run apk:sign -- [--fetch-tools] [--in <apk>] [--out <签名产物.apk>] [--out-dir <目录>]\n" +
          "            [--keystore <ks> --alias <a> --store-pass <p> --key-pass <p>] [--verify <apk>]",
      );
      process.exit(0);
    }
  }
  return cli;
}

/** CLI 入口 */
async function main(): Promise<void> {
  const cli = parseCli();
  if (cli.fetchTools) {
    console.log(await fetchTools());
    return;
  }
  if (cli.verify) {
    console.log(verifyApk(cli.verify));
    return;
  }
  if (!cli.inApk) {
    console.error("[apk-sign] 需要 --in <apk>（或 --fetch-tools / --verify）");
    process.exit(1);
  }
  const signed = signApk({
    inApk: cli.inApk,
    outDir: cli.outDir,
    outApk: cli.outApk || undefined,
    keystore: cli.keystore || undefined,
    ksAlias: cli.alias || undefined,
    ksPass: cli.storePass || undefined,
    ksKeyPass: cli.keyPass || undefined,
    skipZipAlign: cli.skipZipAlign,
  });
  console.log(`[apk-sign] 完成: ${signed}`);
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[apk-sign] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
