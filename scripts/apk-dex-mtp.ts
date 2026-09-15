/**
 * 静态关闭 MTP（dex 等长补丁，免 Frida 注入）
 *
 * 背景：客户端 Java 层的 MTP（Hypergryph 反外挂框架，`com.hg.sdk`）在进程启动与登录时做注入/环境检测并上报；
 * 私服场景下它只会误报（MuMu 上还可能直接终止进程，见 `tmp/apk-mod/ace-kill-logcat.txt` 里
 * libtersafe2.so 的 SIGSEGV 记录）。原方案靠 Frida 运行期置空两个入口（`hook/main.ts:250-253`），必须注入环境；
 * 本脚本改为**静态 dex 补丁**：把入口方法体原地换成 `return-void`（余下字数用 `nop` 填充），
 * 只改指令字节与 dex 头部（SHA-1 签名 / Adler-32 校验），**dex 结构与长度零位移**——
 * 不走 apktool 反编译/回编译（回编译会重排 dex，极易触发 ACE/TSS 的完整性自校验）。
 *
 * 目标（缺省，与 hook/main.ts 对齐；同名重载全部命中）：
 *   com.hg.sdk.MTPProxyApplication#onProxyCreate   → 不再 initSDKWhenAppCreate / initWhenActivityCreate
 *   com.hg.sdk.MTPDetection#onUserLogin            → 不再上报登录环境
 *
 * 管线：定位 APK → 扫 `classes*.dex` 找目标类 → 置空方法体 → 重算 dex 头 → `scripts/apk-patch.ts`
 *       zip 级增量重写（抹旧签名 + 重做对齐）→ 可选 `scripts/apk-sign.ts` 重签。
 *
 * 用法：
 *   pnpm run apk:dex-mtp                       # 自动定位最新 APK → tmp/apk-out/<名>-nomtp-unsigned.apk
 *   pnpm run apk:dex-mtp -- --list             # 只列 dex 里的 MTP 类/方法（不写盘）
 *   pnpm run apk:dex-mtp -- --sign             # 顺带重签（uber-apk-signer）
 *   pnpm run apk:dex-mtp -- --target com.hg.sdk.MTPDetection#onUserRegister
 *   pnpm run apk:dex-mtp -- --blank-class com.hg.sdk.MTPDetection   # 该类所有有方法体的方法全部置空
 *   pnpm run apk:dex-mtp -- --profile full                          # 追加 MTPSDK 初始化/上报入口（未实测）
 *   pnpm run apk:dex-mtp -- --apk <源.apk> --out <出包.apk> --dry-run
 *
 * 边界：只动 dex 层，native 层（`libtersafe2.so` / `libmsaoaidsec.so`）一律不碰。
 * 政策：本脚本按 2026-09-14 的决定解除 `docs/no-root-injection-chain-2026-09-13.md` §7.1 红线
 *       （记录见 `docs/apk-dex-mtp-2026-09-14.md`）；仅用于自建私服客户端，勿用于官服对抗环境。
 */
import * as fs from "fs";
import * as path from "path";
import { crc32 } from "crc";
import { patchApk, verifyPatchedApk } from "./apk-patch";
import { signApk } from "./apk-sign";
import { listZipEntries, locateLatestApk, readZipEntries } from "./lib/apk-io";
import {
  blankMethods,
  firstInsnAt,
  fixDexHeader,
  isDex,
  listClasses,
  toClassDescriptor,
  methodSignature,
  toClassName,
  verifyDex,
  type DexBlankResult,
  type DexBlankTarget,
  type DexClass,
} from "./lib/dex";

/** 项目根 */
const ROOT = path.join(__dirname, "..");
/** 官方 APK 落盘目录（`pnpm run apk:lua` 下载） */
const APK_DIR = path.join(ROOT, "tmp", "apk");
/** 产物目录 */
const OUT_DIR = path.join(ROOT, "tmp", "apk-out");
/** 中间产物目录（补丁后的 dex 留档，便于 `--list` / 反查） */
const WORK_DIR = path.join(ROOT, "tmp", "apk-mod");
/** dex 条目名 */
const DEX_ENTRY_RE = /^classes\d*\.dex$/i;
/** 缺省置空目标（与 hook/main.ts:250-253 对齐：客户端在运行期就是这样被置空且实测可用） */
const DEFAULT_TARGETS: DexBlankTarget[] = [
  { className: "com.hg.sdk.MTPProxyApplication", methodName: "onProxyCreate" },
  { className: "com.hg.sdk.MTPDetection", methodName: "onUserLogin" },
];
/**
 * `--profile full`：在缺省目标之外，追加 MTP 框架自身的初始化与上报入口
 * （`--list` 实测 `com.hg.sdk.MTPSDK` 的 initSDKWhenAppCreate/initWhenActivityCreate/onUserLogin
 * 与广播接收器 `MTPSDK$MyTssInfoReceiver.onReceive` 都有方法体）。更彻底但**未在设备上实测**，
 * 只置空无返回值的方法/回调，避免 caller 拿到 null 崩溃（刻意不动 getData/getInstance/isSupportMethod）。
 */
const FULL_TARGETS: DexBlankTarget[] = [
  ...DEFAULT_TARGETS,
  { className: "com.hg.sdk.MTPSDK", methodName: "initSDKWhenAppCreate" },
  { className: "com.hg.sdk.MTPSDK", methodName: "initWhenActivityCreate" },
  { className: "com.hg.sdk.MTPSDK", methodName: "onUserLogin" },
  { className: "com.hg.sdk.MTPSDK$MyTssInfoReceiver", methodName: "onReceive" },
];
/** `--list` 命中的类描述符特征（MTP 框架类） */
const MTP_CLASS_RE = /Lcom\/hg\/sdk\/[^;]*mtp/i;

/** CLI 参数 */
interface CliArgs {
  /** 源 APK（空 = 自动定位最新） */
  inApk: string;
  /** 输出 APK（空 = tmp/apk-out/<名>-nomtp-unsigned.apk） */
  outApk: string;
  /** 追加置空目标（`类#方法`） */
  targets: string[];
  /** 整类置空（类名，点号或描述符） */
  blankClasses: string[];
  /** 置空档位（`default` / `full`） */
  profile: string;
  /** 只列 MTP 类/方法 */
  list: boolean;
  /** 补丁后重签 */
  sign: boolean;
  /** 只分析不写盘 */
  dryRun: boolean;
  /** 不把补丁后的 dex 留档到 tmp/apk-mod */
  noKeepDex: boolean;
  /** 打印帮助 */
  help: boolean;
}

/** 单个 dex 条目的解析结果 */
interface DexSlice {
  /** zip 条目名（如 `classes4.dex`） */
  entry: string;
  /** dex 字节（就地补丁） */
  buf: Buffer;
  /** 类表 */
  classes: DexClass[];
}

/**
 * 解析命令行参数。
 * @param argv - `process.argv.slice(2)`
 * @returns 参数对象
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inApk: "",
    outApk: "",
    targets: [],
    blankClasses: [],
    profile: "default",
    list: false,
    sign: false,
    dryRun: false,
    noKeepDex: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apk" || a === "--in") args.inApk = argv[++i] ?? "";
    else if (a === "--out") args.outApk = argv[++i] ?? "";
    else if (a === "--target") args.targets.push(argv[++i] ?? "");
    else if (a === "--blank-class") args.blankClasses.push(argv[++i] ?? "");
    else if (a === "--profile") args.profile = argv[++i] ?? "";
    else if (a === "--list" || a === "--scan") args.list = true;
    else if (a === "--sign") args.sign = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-keep-dex") args.noKeepDex = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  args.targets = args.targets.filter((t) => t.length > 0);
  args.blankClasses = args.blankClasses.filter((c) => c.length > 0);
  return args;
}

/** 打印帮助 */
function printHelp(): void {
  console.log(
    [
      "用法: pnpm run apk:dex-mtp -- [--apk <源.apk>] [--out <出包.apk>] [--target <类#方法>]...",
      "            [--blank-class <类名>]... [--profile default|full] [--list] [--sign] [--dry-run]",
      "",
      "  --apk <路径>        源 APK（缺省自动定位 tmp/apk/<版本>/*.apk 中最新的一个）",
      "  --out <路径>        输出 APK（缺省 tmp/apk-out/<源名>-nomtp-unsigned.apk）",
      "  --target 类#方法    追加置空目标（可重复；类名点号或描述符皆可）",
      "  --blank-class 类名  把该类所有带方法体的方法全部置空（可重复）",
      "  --profile <档位>    default（缺省：2 个入口，与 hook/main.ts 齐平）/ full（追加 MTPSDK",
      "                      初始化与上报入口；更彻底但未在设备上实测）",
      "  --list              只列出 dex 内 MTP 类/方法与指令字数，不写盘",
      "  --sign              用 uber-apk-signer 重签（默认只产未签名包）",
      "  --dry-run           只做补丁与自检，不重写 APK",
      "  --no-keep-dex       不把补丁后的 dex 留档到 tmp/apk-mod/",
    ].join("\n"),
  );
}

/**
 * 解析 `类#方法` 目标。
 * @param raw - 形如 `com.hg.sdk.MTPDetection#onUserLogin`
 * @returns 置空目标
 * @throws 格式非法时抛错
 */
function parseTarget(raw: string): DexBlankTarget {
  const at = raw.indexOf("#");
  if (at <= 0 || at === raw.length - 1) throw new Error(`--target 需要「类#方法」格式，收到：${raw}`);
  return { className: raw.slice(0, at).trim(), methodName: raw.slice(at + 1).trim() };
}

/**
 * 计算某返回类型置空后的首条指令。
 * @param returnType - 返回类型描述符
 * @returns 指令字（`return-void` / `const/4` / `const-wide/16`）
 */
function expectedFirstInsn(returnType: string): number {
  if (returnType === "V") return 0x000e;
  if (returnType === "J" || returnType === "D") return 0x0013;
  return 0x0012;
}

/**
 * 补丁后校验：dex 头自洽 + 每个置空方法的首指令已改写。
 * @param dex - 补丁后的 dex 字节
 * @param results - 置空明细
 * @returns 问题列表（空 = 通过）
 */
function verifyPatchedDex(dex: Buffer, results: DexBlankResult[]): string[] {
  const problems = verifyDex(dex);
  const classes = listClasses(dex);
  for (const r of results) {
    const cls = classes.find((c) => c.descriptor === r.classDescriptor);
    const methods = cls ? cls.methods.filter((m) => m.name === r.methodName && m.codeOff !== 0) : [];
    if (methods.length === 0) {
      problems.push(`${toClassName(r.classDescriptor)}#${r.methodName} 补丁后找不到方法体`);
      continue;
    }
    for (const m of methods) {
      const first = firstInsnAt(dex, m.codeOff);
      const expected = expectedFirstInsn(m.returnType);
      if (first !== expected) {
        problems.push(
          `${toClassName(r.classDescriptor)}#${r.methodName} 首指令 0x${first.toString(16)}，应为 0x${expected.toString(16)}`,
        );
      }
    }
  }
  return problems;
}

/** CLI 入口 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const apk = args.inApk ? path.resolve(args.inApk) : locateLatestApk(APK_DIR);
  if (!apk) {
    console.error("[apk-dex-mtp] 未找到官方 APK：请先 `pnpm run apk:lua` 下载，或用 --apk 指定");
    process.exit(1);
  }
  if (!fs.existsSync(apk)) {
    console.error(`[apk-dex-mtp] 源 APK 不存在：${apk}`);
    process.exit(1);
  }

  // 1) 读全部 classes*.dex
  const entries = await listZipEntries(apk);
  const dexNames = entries
    .filter((e) => DEX_ENTRY_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  if (dexNames.length === 0) {
    console.error(`[apk-dex-mtp] ${apk} 内没有 classes*.dex`);
    process.exit(1);
  }
  const t0 = Date.now();
  const dexBufs = await readZipEntries(apk, dexNames);
  const slices: DexSlice[] = [];
  for (const name of dexNames) {
    const buf = dexBufs.get(name);
    if (!buf) continue;
    if (!isDex(buf)) {
      console.warn(`[apk-dex-mtp] 跳过非 dex 条目：${name}`);
      continue;
    }
    slices.push({ entry: name, buf, classes: listClasses(buf) });
  }
  console.log(
    `[apk-dex-mtp] 源: ${path.relative(ROOT, apk)}（${(fs.statSync(apk).size / 1e6).toFixed(1)} MB，` +
      `${dexNames.length} 个 dex / ${slices.reduce((n, s) => n + s.classes.length, 0)} 个类，读取 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );

  // 2) --list：列出 MTP 相关类与方法
  if (args.list) {
    let hits = 0;
    for (const slice of slices) {
      for (const cls of slice.classes) {
        if (!MTP_CLASS_RE.test(cls.descriptor)) continue;
        hits++;
        console.log(`\n[${slice.entry}] ${toClassName(cls.descriptor)}`);
        for (const m of cls.methods) {
          const body = m.codeOff === 0 ? "无方法体" : `insns=${m.insnsSize} 字 / regs=${m.registersSize}`;
          console.log(`    ${methodSignature(m)}  ${body}`);
        }
      }
    }
    console.log(
      hits === 0
        ? "\n[apk-dex-mtp] 没找到 Lcom/hg/sdk/*mtp* 类（用 --target 显式指定，或先 `pnpm run apk:audit` 复核）"
        : `\n[apk-dex-mtp] 命中 ${hits} 个 MTP 类；缺省置空目标：${DEFAULT_TARGETS.map((t) => `${t.className}#${t.methodName}`).join(", ")}`,
    );
    return;
  }

  // 3) 汇总置空目标
  if (args.profile !== "default" && args.profile !== "full") {
    console.error(`[apk-dex-mtp] 未知档位 --profile ${args.profile}（可选 default / full）`);
    process.exit(1);
  }
  if (args.profile === "full") {
    console.warn("[apk-dex-mtp] --profile full：追加 MTPSDK 初始化/上报入口，设备上未实测；客户端异常时改回 default");
  }
  const targets: DexBlankTarget[] = (args.profile === "full" ? FULL_TARGETS : DEFAULT_TARGETS).slice();
  for (const raw of args.targets) targets.push(parseTarget(raw));
  for (const raw of args.blankClasses) {
    const descriptor = toClassDescriptor(raw);
    const cls = slices.flatMap((s) => s.classes).find((c) => c.descriptor === descriptor);
    if (!cls) {
      console.error(`[apk-dex-mtp] --blank-class 未找到类：${toClassName(descriptor)}`);
      process.exit(1);
    }
    for (const m of cls.methods) {
      if (m.codeOff !== 0) targets.push({ className: descriptor, methodName: m.name });
    }
  }
  const seen = new Set<string>();
  const uniqueTargets = targets.filter((t) => {
    const key = `${toClassDescriptor(t.className)}#${t.methodName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`[apk-dex-mtp] 置空目标 ${uniqueTargets.length} 个：${[...seen].join(", ")}`);

  // 4) 逐 dex 打补丁
  const patched: { entry: string; data: Buffer; results: DexBlankResult[] }[] = [];
  const unresolved = new Set(uniqueTargets.map((t) => `${toClassDescriptor(t.className)}#${t.methodName}`));
  const skippedKeys = new Set<string>();
  for (const slice of slices) {
    const here = uniqueTargets.filter((t) => slice.classes.some((c) => c.descriptor === toClassDescriptor(t.className)));
    if (here.length === 0) continue;
    const report = blankMethods(slice.buf, here);
    for (const r of report.patched) unresolved.delete(`${r.classDescriptor}#${r.methodName}`);
    for (const r of report.skipped) {
      const key = `${r.classDescriptor}#${r.methodName}`;
      unresolved.delete(key);
      skippedKeys.add(key);
      console.warn(
        `[apk-dex-mtp] ${slice.entry} 无法置空（abstract/native 无方法体，或指令区放不下）：${toClassName(r.classDescriptor)}#${r.methodName}`,
      );
    }
    if (report.patched.length === 0) continue;
    fixDexHeader(slice.buf);
    const problems = verifyPatchedDex(slice.buf, report.patched);
    if (problems.length > 0) {
      console.error(`[apk-dex-mtp] ${slice.entry} 自检失败：`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    for (const r of report.patched) {
      const bumped = r.registersBumped ? "（registers_size 0→1）" : "";
      console.log(
        `[apk-dex-mtp] ${slice.entry} 置空 ${toClassName(r.classDescriptor)}#${r.methodName}` +
          ` → 首指令 0x${r.firstInsn.toString(16).padStart(4, "0")}，原 ${r.beforeInsnsSize} 字指令已用 nop 填充${bumped}`,
      );
    }
    patched.push({ entry: slice.entry, data: slice.buf, results: report.patched });
  }
  if (unresolved.size > 0) {
    console.error(`[apk-dex-mtp] 未命中目标（类/方法名写错？先跑 --list）：${[...unresolved].join(", ")}`);
    process.exit(1);
  }
  if (skippedKeys.size > 0) {
    console.error(`[apk-dex-mtp] 以下目标没有可置空的方法体，未达成交付预期：${[...skippedKeys].join(", ")}`);
    process.exit(1);
  }
  if (patched.length === 0) {
    console.error("[apk-dex-mtp] 没有可补丁的 dex，未写盘");
    process.exit(1);
  }

  // 5) 留档补丁后的 dex（便于反查/复现）
  if (!args.noKeepDex) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    for (const p of patched) {
      const out = path.join(WORK_DIR, `${p.entry}.nomtp.dex`);
      fs.writeFileSync(out, p.data);
      console.log(`[apk-dex-mtp] 补丁后 dex 留档: ${path.relative(ROOT, out)}`);
    }
  }
  if (args.dryRun) {
    console.log("[apk-dex-mtp] --dry-run：补丁与自检通过，未重写 APK");
    return;
  }

  // 6) zip 级重写（保留结构，抹旧签名，重做对齐）
  const stem = path.basename(apk).replace(/\.apk$/i, "");
  const out = args.outApk
    ? path.resolve(args.outApk)
    : path.join(OUT_DIR, `${stem}-nomtp-unsigned.apk`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const t1 = Date.now();
  const report = patchApk({
    inApk: apk,
    outApk: out,
    replacements: patched.map((p) => ({ entry: p.entry, data: p.data })),
    stripV1: true,
    dryRun: false,
  });
  console.log(
    `[apk-dex-mtp] 写出 ${path.relative(ROOT, out)}（${(report.outSize / 1e6).toFixed(1)} MB，` +
      `替换 ${report.replaced.length} 条，${((Date.now() - t1) / 1000).toFixed(1)}s）`,
  );
  const problems = verifyPatchedApk(out, new Map(patched.map((p) => [p.entry, crc32(p.data)])));
  if (problems.length > 0) {
    console.error("[apk-dex-mtp] 出包自检失败：");
    for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[apk-dex-mtp] 出包自检通过");

  if (args.sign) {
    const signed = signApk({
      inApk: out,
      outDir: OUT_DIR,
      outApk: path.join(OUT_DIR, `${stem}-nomtp-signed.apk`),
    });
    console.log(`[apk-dex-mtp] 已签名: ${path.relative(ROOT, signed)}`);
  }
  console.log(
    "[apk-dex-mtp] 完成：dex 层 MTP 入口已静态置空（native 层 libtersafe2/libmsaoaidsec 未动）；" +
      "设备侧仍需 hosts + adb reverse，见 docs/apk-mod-2771-2026-09-13.md §8.7",
  );
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[apk-dex-mtp] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
