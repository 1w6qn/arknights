import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'node:url';

// 以 .mts 显式声明 ESM，规避 Vite 8 的 configLoader:'native' 把本项目（type: commonjs）
// 下的 .ts 配置误判为 CommonJS 加载——该误判会导致套件注册失败（所有测试弃跑）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // 单用例上限：仓内有一批**全仓扫描型守卫**（类型债棘轮/物品管线棘轮/excel 单例棘轮/
    // 解耦与路由契约守卫等），在慢机器或并发负载下单文件就要 10~100 秒；5s 默认值会让
    // 这些守卫假失败（不区分「跑得慢」与「真失败」）。这里放宽到 2 分钟——真挂死仍会失败。
    testTimeout: 120000,
    // 测试期间日志落盘到 tmp/（gitignored），避免污染 logs/
    env: { LOG_DIR: 'tmp/test-logs' },
    include: ['tests/**/*.test.ts'],
    // 磁盘模块缓存（vitest 4 experimental）：把 esbuild 转换结果按「内容哈希」落到
    // node_modules/.experimental-vitest-cache，供**同一次运行的多个 worker 之间**以及
    // 多次运行之间复用。本仓在 WSL 9p/drvfs 上，每个测试文件都要重新转换其整张依赖图，
    // 实测 30 文件的探针组 transform 从 310s 降到 99s（-68%），整组耗时 50.1s → 38.0s（热缓存）。
    // 关闭方式：删掉本项，或 `vitest --clearCache` 清缓存。缓存目录在 node_modules 下，已被 gitignore。
    experimental: { fsModuleCache: true },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json', 'lcov'],
      include: ['app/**/*.ts'],
      exclude: ['app/game/excel/**', 'app/core/config/**', 'app/ops/assets/**'],
      thresholds: {
        // 实测全局 ~51% 行 / 47% 函数 / 41% 分支——阈值低于现值留缓冲（D2）
        lines: 40,
        functions: 35,
        branches: 25,
        statements: 40,
      },
    },
  },
  resolve: {
    alias: {
      '@game': path.resolve(__dirname, 'app/game'),
      '@excel': path.resolve(__dirname, 'app/game/excel'),
      '@utils': path.resolve(__dirname, 'app/core/utils'),
      '@capture': path.resolve(__dirname, 'app/ops/capture'),
      '@logs': path.resolve(__dirname, 'app/core/logs'),
      '@plugin': path.resolve(__dirname, 'app/ops/plugin'),
      '@asset': path.resolve(__dirname, 'app/ops/assets/asset-registry'),
      '@core': path.resolve(__dirname, 'app/core'),
      '@ops': path.resolve(__dirname, 'app/ops'),
    },
  },
});