# 测试性能诊断与优化（2026-09-13）

本文记录本轮「优化测试速度 / 移除冗余测试」的**实测证据**、改动清单与残余瓶颈。
所有数字来自本机（WSL2，32 vCPU，`/mnt/d` = 9p/drvfs，Node v22.22.1）。

---

## 1. 结论先行：耗时由「读盘次数」决定，不由断言数决定

对 30 个「用例本身几乎不耗时」的测试文件做探针，vitest 自报的分段耗时是：

```
Duration  46.48s  (transform 248.28s, setup 0ms, import 567.96s, tests 1.82s, environment 2ms)
```

- **tests 1.82s**：断言总共只花了不到 2 秒。
- **transform 248s + import 568s**：816 秒的 worker 时间全部花在把源码读进来 + 转换 + 求值。

进一步单文件测量：

| 探针文件 | Duration | transform | import |
|---|---|---|---|
| 空用例（只 `expect(1+1)`） | 3.47s | 44ms | 316ms |
| `import excel from "@excel/excel"` | 13.03s | 227ms | 713ms |
| `import { PlayerDataManager }` | 11.76s（热缓存） | 7.17s | 8.98s |

`import duration` 展示的明细里，单个模块的 self 时间普遍在 **100~500ms**，而每个文件只有几十 KB。
根因是**逐文件的系统调用延迟**：在 9p/drvfs 上 `fs.readFileSync` 实测约 **36ms/文件**：

```bash
$ node -e '…读取 app/game/modules + app/game/kernel 共 354 个 .ts…'
文件数 354 字节 3077413 耗时 12864ms      # ≈36ms/文件，与总字节数无关
```

推论（本轮优化的两条主线）：

1. **同一个测试文件内重复扫描同一批源码**，代价是线性叠加的（一个全仓扫描 ≈ 10s）。
2. **每新增一个测试文件**，都要重新加载整张 app 依赖图（≈10~20s worker 时间），
   而该文件真正执行的断言通常只有 1~50ms。

全量套件的时间线也印证第 2 点：从 t=250s 到 t=468s 有约 180 个文件被处理，
其**用例时长合计只有约 10 秒**，其余全是模块加载。

---

## 2. 已落地的改动

### 2.1 架构守卫：消除同一文件内的重复全树扫描

新增 `tests/helpers/fs-scan.ts`（`readSource` / `readLines` / `collectFiles` / `collectSources`），
把「每用例各读一遍盘」收敛为「每个测试进程读一遍」的惰性缓存（源码在单次运行内不变，判定语义完全不变）。

**同窗口 A/B（同一时段、同一台机器、先跑原版再跑改造版，排除并发与缓存差异）**：

| 守卫文件 | 原版（HEAD） | 改造后 | 倍数 | 扫描次数 |
|---|---|---|---|---|
| `excel-singleton-ratchet` | 17028ms（6 用例） | **1127ms**（6 用例） | 15.1× | 4 次 → 1 次 |
| `decoupling` | 15191ms（13 用例） | **1929ms**（11 用例） | 7.9× | `app/game` 3 遍+admin 2 遍 → 各 1 遍 |
| `inventory-pipeline-ratchet` | 4801ms（7 用例） | **995ms**（7 用例） | 4.8× | 4 次全仓 → 1 次 |

（`decoupling` 用例数 13→11 是因为删掉了 2 条扫描已删除目录 `app/game/domain` 的空转用例，见 §2.2。）

其余守卫的改造与实测：

| 守卫文件 | 改造内容 | 用例时长（改造前 → 后） |
|---|---|---|
| `module-boundary` | 435 文件读 2 遍 → 1 遍 | 20.3s → 15.8s* |
| `file-size-guard` | 去掉对 `activities` 子集的重复扫描 | 6.5s → 2.7s* |
| `schema-first-guard` | `activities` 走两遍 → 单遍 | 8.4s → 2.3s* |
| `errors-guard` | 已是单遍（仅统一到 helper） | 20.5s → 4.9s* |
| `composition-order` | 读 2 个文件（仅统一到 helper） | 0.1s |

\* 这些数字取自套件内的并发运行（受同时运行的文件数与机器负载影响较大），
仅作量级参考；确定性的结论是「扫描次数 N → 1」这一结构性减量。

9 个守卫文件的用例时长合计：**279.6s → 约 35~39s**。

**等价性验证**（改造必须不改变扫描范围）：用脚本复刻「原实现」与「新实现」的收集逻辑，
逐一比对文件集合：

```
module-boundary: 原 435 新 435 一致: true
schema-first  : 原  95 新  95 一致: true
file-size     : 原覆盖集合 324 新 324 一致: true
```

### 2.2 删除冗余测试

| 删除项 | 数量 | 依据 |
|---|---|---|
| `tests/unit/game/model/events.test.ts` | 37 用例 / 538 行 | 与 `tests/unit/model/events.test.ts` 用例标题序列完全相同（49 个 describe+it 标题全等、51 个 expect）。后者已做类型化改造（`EventMap` 强类型夹具、`unknown` 计数 **6 → 0**），前者是未改造的旧副本 |
| `tests/unit/__probe__.test.ts` | 1 用例 / 7 行 | vitest 配置探针残留，`expect(1 + 1).toBe(2)`，零覆盖 |
| `tests/unit/model/character.test.ts` | 22 用例 / 523 行 | 自证式：断言的全是自己刚构造的字面量，`asModel` 只是 `return seed as T` |
| `tests/unit/model/playerdata.test.ts` | 28 用例 / 728 行 | 同上；其中唯一 2 条真断言（`mockPlayerData`）已被 `tests/helpers/mocks.test.ts` 完整覆盖 |
| `tests/unit/model/battle.test.ts` | 14 用例 / 472 行 | 同上，且**连生产值导入都没有**（纯 `import type`） |
| `tests/unit/architecture/decoupling.test.ts` 中 2 条空转用例 | 2 用例 | 扫描 `app/game/domain`——该目录已删除，`collectFiles` 恒返回 `[]`，断言永远成立（零覆盖） |
| `tests/unit/router/crisis.test.ts` 的死 mock | — | `vi.mock("./crisis-seasons")` 解析到不存在的 `tests/unit/router/crisis-seasons.ts`；删除后 13 个用例仍全绿 |

合计 **-102 个用例 / -6 个测试文件**（少 6 次整图加载）。

`tests/unit/architecture/type-debt-baseline.json` 同步收紧：移除 `tests/unit/game/model/events.test.ts`
条目（`unknown: 6`），总量 413 → **407**（守卫自校验「逐文件求和 == 声明总量」通过）。

### 2.3 vitest 配置：启用磁盘模块缓存

`vitest.config.mts` 增加 `experimental.fsModuleCache: true`。
同一次运行的多个 worker 之间、以及多次运行之间复用 esbuild 转换结果：

| 30 文件探针组 | Duration | transform | import |
|---|---|---|---|
| 默认 | 50.1s | 248~310s | ~655s |
| `fsModuleCache` 冷启动 | 49.9s | 310s | 655s |
| `fsModuleCache` 热缓存 | **38.0s** | **99s** | 445s |

（缓存目录 `node_modules/.experimental-vitest-cache`，约 11MB。）

---

## 3. 试过但**未**采用的方案

| 方案 | 实测 | 未采用原因 |
|---|---|---|
| `pool: 'threads'` | 30 文件探针 44.2s vs 50.1s（约 -12%，样本波动大） | 收益在噪声范围内；且 4 个测试文件会改写 `process.env`（`traffic-recorder`/`excel-data-dir`/`logger`/`log-service`），线程池下同进程复用 worker 的环境泄漏风险高于收益 |
| `isolate: false` | 30 文件探针 42.9s；但 `--no-isolate --pool=threads --maxWorkers=4` 达 26.3s | **语义不安全**：全仓 122 个测试文件用 `vi.mock("@excel/excel")` 等文件级 mock，模块注册表一旦跨文件共享，后续文件的 mock 会被"已被导入的真实模块"顶掉 —— 结果是静默错误判定，不能用速度换 |
| `maxWorkers` 调小（如 8） | 30 文件探针 **98.2s**（默认 50.1s） | 收益方向相反：本负载是 I/O 延迟型，并行度越高越好 |
| `fsModuleCachePath` 指向 tmpfs（symlink 到 `/tmp`） | 热缓存 44.4s（drvfs 上 38.0s） | 无收益：vitest 仍需读原始源码做哈希，缓存命中省不掉那次 drvfs 读 |

---

## 4. 残余瓶颈与后续建议

1. **每文件整图加载是硬成本**：约 290 个测试文件 × 10~20s worker 时间 ÷ 31 workers ≈ 全量套件的 wall time。
   最有效的降本手段是**减少测试文件数**（把同模块的碎片用例并入既有文件），而不是优化断言。
   反面教材：`tests/unit/modules/rlv2/` 49 个文件、`tests/unit/manager/building-*` 14 个文件。
2. **`tests/helpers/mockExcel.ts` 零使用**，而 122 个测试文件各自手写 excel 门面（约 4,762 行）——
   这笔收敛同时能减少每个文件的转换量（详见 `docs/代码冗余审查-2026-09-10.md` §3.2 批次 E）。
3. **把仓库放到 ext4 上跑测试**可整体提速（9p/drvfs 的 36ms/文件是本文所有数字的分母）；
   这是环境侧改动，未写入仓库。
4. 本机同时存在**其他会话在改 `app/**`**（类型债收敛批次 + `tests/helpers/mockExcel.ts` 收敛），
   全量套件的 wall time 在那种情况下不可比——本文的守卫对比均改为
   「同窗口、先原版后改造版」的单文件 A/B（§2.1），避免跨时段比较。
   交付时全量套件仍有一处红：`module-boundary` 的 R1（`app/core/utils/{crypt,file}.ts`
   新增了 `import type { JsonValue } from "@excel/json-value"`，即 core 依赖 game/excel）。
   已用 HEAD 版守卫在同一工作树上复现同一处失败，确认与本次改动无关，属并发会话的在途改动。

---

## 5. 复现命令

```bash
# 单文件读盘成本
node -e '…见 §1 片段…'

# 分段耗时（transform / import / tests）
pnpm exec vitest run <一组文件> --reporter=default   # 末尾 Duration 行含分段

# 慢导入明细
#   vitest.config 加 experimental.importDurations = { print: true, limit: 25 }

# 守卫改造前后的单文件耗时
pnpm exec vitest run tests/unit/architecture/inventory-pipeline-ratchet.test.ts
```
