/**
 * 测试侧文件扫描助手（架构守卫共用）
 *
 * 架构守卫类测试（`tests/unit/architecture/**`）大量做「递归枚举 app/ 全树 → 逐行匹配非法模式」
 * 的静态扫描。同一测试文件内常有多个用例扫描**同一批文件**（excel 单例棘轮 4 处、物品直发
 * 棘轮 5 处、解耦守卫 6 处、模块边界 2 处……），若每个用例各 `readFileSync` 一遍，单次运行内
 * 就会把同一批源码从磁盘读上多遍。本仓位于 9p/drvfs 挂载点上，单文件读取约 10~50ms，
 * 重复读取让这批守卫成为整个套件最慢的一撮（实测 inventory-pipeline 棘轮 54s、excel 单例
 * 棘轮 37s、解耦守卫 45s，合计占全量执行时间 ~22%）。
 *
 * 本助手把磁盘读取收敛成「每个测试文件进程内一次」的惰性缓存：源码在单次测试运行期间不会
 * 被改写，因此缓存**不改变任何判定语义**（调用方拿到的仍是同一份内容），只消除重复的系统调用。
 * 需要「重新读盘」的场景（如测试自身在用例内改写文件）不应使用本助手。
 */
import fs from "node:fs";
import path from "node:path";

/** 文件内容缓存（绝对路径 → 源码） */
const sourceCache = new Map<string, string>();

/** 按行切分结果缓存（绝对路径 → 行数组） */
const lineCache = new Map<string, readonly string[]>();

/**
 * 读取文件内容（同一路径在一次测试运行内只真正读盘一次）
 * @param file - 文件绝对路径
 * @returns 文件源码
 */
export function readSource(file: string): string {
  let src = sourceCache.get(file);
  if (src === undefined) {
    src = fs.readFileSync(file, "utf-8");
    sourceCache.set(file, src);
  }
  return src;
}

/**
 * 读取文件并按行切分（缓存复用 {@link readSource} 的内容）
 * @param file - 文件绝对路径
 * @returns 行数组（不含行尾换行符）
 */
export function readLines(file: string): readonly string[] {
  let lines = lineCache.get(file);
  if (lines === undefined) {
    lines = readSource(file).split(/\r?\n/);
    lineCache.set(file, lines);
  }
  return lines;
}

/**
 * 递归枚举目录下的文件
 * @param dir - 目录绝对路径
 * @param ext - 可选的扩展名过滤（含点号，如 `.ts`）；省略则返回全部普通文件
 * @returns 文件绝对路径数组（目录不存在时为空数组）
 */
export function collectFiles(dir: string, ext?: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, ext));
    else if (entry.isFile() && (ext === undefined || entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * 递归枚举目录下源码文件，并连同仓库相对路径与内容一次性返回
 *
 * 相对路径统一用 `/` 分隔，便于与基线 JSON（仓库相对 POSIX 路径）直接比对。
 * @param dir - 目录绝对路径
 * @param repoRoot - 仓库根绝对路径（用于计算相对路径）
 * @param ext - 扩展名过滤（含点号），默认 `.ts`
 * @returns `{ rel, file, src }` 数组（目录不存在时为空数组）
 */
export function collectSources(
  dir: string,
  repoRoot: string,
  ext = ".ts",
): { rel: string; file: string; src: string }[] {
  return collectFiles(dir, ext).map((file) => ({
    rel: path.relative(repoRoot, file).split(path.sep).join("/"),
    file,
    src: readSource(file),
  }));
}
