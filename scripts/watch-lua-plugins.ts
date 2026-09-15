/**
 * Lua 插件热重载脚本
 *
 * 监听 lua/plugin/ 下的全部 .lua 变更 → 自动重打包内置 Lua bundle mod → 使平台 mods 指纹缓存失效，
 * 客户端下次拉取 hot_update_list.json 时 app/ops/assets/asset.ts 会重扫 mods/ 拿到新指纹并重新下载覆盖。
 * 目标：改一个插件 Lua 免手动重打包，提升插件开发迭代体验。
 *
 * 依赖：Node 24 内置 fs.watch（无需 chokidar）。
 *
 * 用法：
 *   pnpm run watch:lua
 *   --debounce <ms>  变更防抖窗口（缺省 300ms，避免保存瞬间多次触发）
 *   --once           只重打包一次后退出（不监听）
 */
import * as fs from "fs";
import * as path from "path";
import { repackBuiltinFromRef } from "./repack-lua-bundle";

/** 插件源码根目录（相对项目根） */
const PLUGIN_DIR = path.join(__dirname, "..", "lua", "plugin");
/** 明文 Lua 参考目录（内置 bundle 的明文源） */
const REF_LUA_DIR = path.join(
  __dirname,
  "..",
  "reference",
  "ArknightsGameData",
  "zh_CN",
  "gamedata",
  "[uc]lua",
);
/** 输出 mods 目录 */
const OUT_MODS_DIR = path.join(__dirname, "..", "mods");
/**
 * mods 指纹缓存路径集合：asset.ts 实际缓存为 mods.<platform>.json
 * （见 app/ops/assets/asset.ts loadMods，平台隔离缓存），另兼容历史单文件 mods.json。
 * 重打包后需删除以强制重建（asset.ts 的 refreshModsIfChanged 指纹检测是主要重载路径，
 * 此处为双保险）。
 */
const MODS_CACHE_PATHS = [
  path.join(__dirname, "..", "mods.json"),
  path.join(__dirname, "..", "mods.Android.json"),
  path.join(__dirname, "..", "mods.Windows.json"),
];

/**
 * 执行一次重打包：重建内置 Lua bundle mod 并删除平台 mods 指纹缓存。
 * 删除缓存的目的是让 asset.ts 重新指纹比对（bundle 内容已变 → md5/crc32 变 → 客户端重新下载）。
 * @param refDir        明文 Lua 参考目录
 * @param pluginDir     插件源码目录
 * @param outModsDir    输出 mods 目录
 * @param modsCacheFiles 待删除的 mods 指纹缓存路径列表
 * @returns 重打包结果（dat 路径、bundle 字节、资产数）
 */
export async function rebuildOnce(
  refDir: string,
  pluginDir: string,
  outModsDir: string,
  modsCacheFiles: string[],
): Promise<{ dat: string; bundle: Uint8Array; assetCount: number }> {
  const result = await repackBuiltinFromRef(refDir, pluginDir, outModsDir);
  // 使 mods.<platform>.json 指纹缓存失效（下次 hot_update_list 请求时 asset.ts 重扫）
  for (const cachePath of modsCacheFiles) {
    try {
      if (fs.existsSync(cachePath)) {
        fs.rmSync(cachePath, { force: true });
        console.log(`[watch:lua] 已删除 mods 缓存: ${cachePath}`);
      }
    } catch (error) {
      console.warn(
        `[watch:lua] 删除 mods 缓存失败（忽略）: ${cachePath}`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  console.log(
    `[watch:lua] ${new Date().toLocaleTimeString()} 重打包完成: ${result.dat} ` +
      `(${result.bundle.length} B, ${result.assetCount} 条 Lua)`,
  );
  return result;
}

/**
 * 解析 CLI 参数。
 * @param argv 命令行参数
 * @returns 解析结果
 */
function parseArgs(argv: string[]): { debounce: number; once: boolean } {
  let debounce = 300;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--debounce") debounce = Number(argv[++i]) || 300;
    else if (arg === "--once") once = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: pnpm run watch:lua [--debounce <ms>] [--once]");
      process.exit(0);
    }
  }
  return { debounce, once };
}

/** 主入口 */
async function main(): Promise<void> {
  const { debounce, once } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(REF_LUA_DIR)) {
    console.error(
      `明文 Lua 参考目录不存在: ${REF_LUA_DIR}\n` +
        `请先运行 pnpm run extract:lua -- --bundle <内置bundle.dat|.bin> 生成本地参考（或提供已装客户端的 bundle）。`,
    );
    process.exit(1);
  }

  // 首次构建
  await rebuildOnce(REF_LUA_DIR, PLUGIN_DIR, OUT_MODS_DIR, MODS_CACHE_PATHS);

  if (once) {
    console.log("[watch:lua] --once 模式：已构建一次，退出。");
    return;
  }

  console.log(`[watch:lua] 监听 ${PLUGIN_DIR}/**/*.lua 变更（防抖 ${debounce}ms），Ctrl+C 退出…`);

  let timer: NodeJS.Timeout | null = null;
  // recursive：插件目录分层（core/ ui/ plugins/），非递归 watch 收不到子目录变更
  fs.watch(PLUGIN_DIR, { persistent: true, recursive: true }, (_eventType, filename) => {
    if (!filename || !filename.endsWith(".lua")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void rebuildOnce(REF_LUA_DIR, PLUGIN_DIR, OUT_MODS_DIR, MODS_CACHE_PATHS);
    }, debounce);
  });

  // 保持进程存活
  await new Promise<never>(() => {});
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("watch:lua 启动失败:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}