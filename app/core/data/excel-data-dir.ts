/**
 * excel 数据目录解析（Excel Data Directory）
 *
 * 把 excel 表文件的物理位置从「散落 50+ 处的 `./data/excel/*.json` 字面量」收敛为
 * 单一解析点：`getExcelDataDir()` 决定根目录，`excelFilePath()` 把内置相对路径
 * 重定向到该根目录。
 *
 * 动机（多服/多数据集支持的前置改造）：
 * - 现状硬编码 `./data/excel/` —— 分服（region）数据目录、测试夹具目录均无法替换；
 * - 热重载（init 二次调用）与懒加载 getter 读写盘路径此前不可控。
 *
 * 解析优先级：`setExcelDataDir()` 显式覆写 > `ARKNIGHTS_EXCEL_DIR` 环境变量 > 默认值。
 * 不引入 @core/config 依赖，保持本模块零反向耦合（守卫 decoupling.test.ts）。
 *
 * 位置：2026-09-13 由 `app/game/excel/excel-data-dir.ts` 下沉 `app/core/data/`——零依赖，
 * 属热更管线基础设施而非游戏业务，下沉后 ops/updater 与 scripts 复用不再经 game。
 */

/** 默认 excel 数据目录（仓库既有相对路径，行为与改造前一致） */
export const DEFAULT_EXCEL_DATA_DIR = "./data/excel";

/** 进程内显式覆写目录（null = 未覆写，回落到环境变量/默认值） */
let overrideDir: string | null = null;

/**
 * 读取当前 excel 数据目录
 * @returns 生效的数据目录（相对或绝对路径均可）
 */
export function getExcelDataDir(): string {
  const env = process.env.ARKNIGHTS_EXCEL_DIR;
  return overrideDir ?? (env && env.trim() ? env.trim() : DEFAULT_EXCEL_DATA_DIR);
}

/**
 * 覆写 excel 数据目录（进程级；传 null 清除覆写，回落环境变量/默认值）
 *
 * 供分服启动参数、测试夹具目录使用。写入方应保证目录内含全部表文件——
 * `init()` 会按同一目录批量加载，缺文件将直接抛错（不静默降级）。
 * @param dir - 目标数据目录；null 清除覆写
 */
export function setExcelDataDir(dir: string | null): void {
  overrideDir = dir;
}

/**
 * 解析 excel 数据文件路径
 *
 * 内置字面量形如 `./data/excel/xxx.json`；本函数把其前缀替换为当前数据目录，
 * 其余路径（如 `./data/arkhub/arkdex.json`）原样返回，便于渐进迁移。
 * @param relative - 内置相对路径字面量
 * @returns 实际读取路径
 */
export function excelFilePath(relative: string): string {
  const m = /^\.\/data\/excel\/(.+)$/.exec(relative);
  if (!m) return relative;
  return `${getExcelDataDir().replace(/[\\/]+$/, "")}/${m[1]}`;
}
