# 从 game 提取：跨层下沉（core/ops）与层内上移（modules → kernel）—— 分阶段重构计划

> 日期：2026-09-13（**第二版**：并入「modules → kernel」层内提取方向）｜ 状态：~~计划（未执行）~~ → **已实施（2026-09-13）**，落地记录见 [§9](#9-实施结果2026-09-13)
> 关联：`docs/architecture-coupling-adjudication.md`（R1–R6 违规裁决与登记表）、`tests/unit/architecture/module-boundary.test.ts`（机器可读守卫）、`tests/unit/architecture/excel-singleton-ratchet.test.ts`（excel 端口棘轮）、`docs/type-system-audit.md`（类型棘轮政策）、`app/core/utils/json-value.ts`（既有的「下沉 core + 垫片」先例）
>
> **第一版与第二版的关系**：第一版只覆盖「game → core/ops」跨层下沉（R1 为主，R2 仅一句占位）；第二版补上「modules → kernel」层内上移（R2 + R3），并把两版共用同一条 auth 端口、同一批棘轮基线，合并为一条执行链。

## 0. 判据与目标

三层职责（AGENTS.md）：`app/core/` 基础设施内核（**被依赖方，禁止 import game/ops**）、`app/game/` 业务（`kernel/` 共享层 + `modules/` 特性切片）、`app/ops/` 运营设施（可依赖 core 与 game 的 `public.ts`）。

**提取判据（按优先级；1–3 为跨层，4–6 为层内）**

1. **只依赖 core / 第三方、零 game 业务语义** → 下沉 `app/core/`。
2. **仅运营后台 / CLI 使用**（game 自身不引用）→ 提取 `app/ops/`。
3. **core→game 反向依赖（R1）或 kernel→modules 反向依赖（R2）** → 在 core 定义端口/类型，game 侧实现或注入。
4. **被 ≥2 模块消费、不含单模块业务规则的纯函数 / 存储适配器 / 共享形状** → 上移 `game/kernel/`（与已落地的 `battle-model` / `stage-unlock` / `multipart` 同性质）。
5. **玩家数据生命周期（bootstrap / 存档健康 / 组合根）** → 上移 `game/kernel/`。
6. **有状态领域服务** → 接口进 kernel（或 core），实现留模块，组合根注入。

**目标**

- core/ops 复用通用能力时不再经 game（当前 `ops/admin/AdminService.ts`、`scripts/*` 仍从 `@game/kernel/*` 取纯工具）。
- 把 `module-boundary.test.ts` 登记表的 **R1 技术债 10 条清零、R2 5 条清零、R3 20 条收敛到 4 条**（另有 1 条 modules→ops 的 R5 类不在本计划范围），而不是继续挂在 `EXEMPTIONS` 里。
- 全程行为零变化、逐阶段独立提交、可回滚。

**先例**：`app/core/utils/json-value.ts` 已是规范定义（core 的 I/O 工具需要它），`app/game/excel/json-value.ts` 只做 re-export 垫片——本计划沿用「先下沉、必要时留垫片」的手法，但优先直接改写 import，避免出现第二处定义。

## 1. 盘点结论（2026-09-13 实测）

引用点统计口径：`grep -rl "<说明符>\"" app scripts tests hook index.ts | wc -l`（含相对路径与别名路径）。

### 1.1 方向 A —— game → core/ops（跨层）

| 候选 | 当前位置 | 依赖 | 引用点 | 结论 |
| --- | --- | --- | --- | --- |
| `http/errors.ts` | `game/kernel` | 仅标准库 | 12 | **下沉 `core/http`** |
| `http/validate-body.ts` | `game/kernel` | express / zod / logger | 76 | **下沉 `core/http`** |
| `http/resp-schema.ts` | `game/kernel` | express / zod / logger | 1（`game/app.ts`） | 可下沉（骨架含 `playerDataDelta`，建议参数化后下沉） |
| `util/json-path.ts` | `game/kernel` | 仅 `json-value`（已是 core 垫片） | 8 | **下沉 `core/utils`**（同时消除 ops→game 边） |
| `util/multipart.ts` | `game/kernel` | 零依赖 | 3 | **下沉 `core/utils`** |
| `util/random.ts` | `game/kernel` | 零依赖 | 29 | **并入 `core/utils/random.ts`** |
| `excel/excel-data-dir.ts` | `game/excel` | 零依赖 | 2 + 测试 | **下沉 `core/data`** |
| `excel/data-version.ts` | `game/excel` | fs / path / logger + 上者 | 3 | **随之下沉 `core/data`** |
| `util/maxout.ts` | `game/kernel` | `@excel/excel`（**默认导入**） | 2（**仅 ops + scripts**） | **提取 `ops/admin`**（见 §4 棘轮修正） |
| `events/runtime.ts` | `game/kernel` | emittery / logger + 泛型实参 `EventMap` | 20（经 `events/index.ts`） | 可选：泛型 `EventBus<M>` 下沉 `core/events` |
| `http/request-context.ts` | `game/kernel` | `PlayerDataManager`（game） | 71 | **拆分**：通用 key-store 下沉 core，玩家门面留 game |
| `http/common.ts` | `game/kernel` | 游戏协议（`playerDataDelta`） | 44 | **不动**（业务协议） |
| `model.ts` / `playerdata.ts` | `game/kernel` | 玩家数据模型 | 32 / — | **不动**（生成类型 + 共享形状） |
| `PlayerStatus` / `inventory*` / `excel-port` / `battle-model` / `battle-info-store` / `util/stage-unlock` | `game/kernel` | 游戏业务 | — | **不动**（kernel 是架构规定的共享层；反向债由 §1.2 与 §2-S5 消） |
| `core/utils/traffic-recorder.ts` → `@capture/*` | core→ops | — | 3 消费面 | **端口化**（R1） |
| `core/utils/crypt.ts` → `battle-model` | core→game | — | — | **类型泛型化**（R1） |
| `core/db/replay-repo.ts` → `battle-info-store` | core→game | — | — | **自有行类型/泛型化**（R1） |
| `core/logs/log-service.ts` → `ops/admin/AdminService` | core→ops | — | — | **audit 端口化**（R1） |
| `core/auth/auth.ts` → `AccountManager` | core→game | — | 20+ 调用点 | **认证端口化**（R1，与 R2 的 `kernel/http/auth-strategy.ts` **同一端口**） |
| `core/config/prod.ts` → `ops/assets` | core→ops | — | 2 条 | **启动期钩子端口化**（R1） |
| `core/db/{migrate,user-repo}.ts` → `UserConfig` | core→game | — | — | **类型下沉 `core/db/types`**（R1） |

### 1.2 方向 B —— modules → kernel（层内）

判定口径见 §0 判据 4–6。全部候选均已核对依赖与棘轮约束（`@excel/excel` **默认导入**才计入棘轮；仅 `import type` / 具名导入不计）。

**B 组：纯搬运（低风险，先做）**

| # | 提取物 | 现状 → 目标 | 引用点 | 棘轮 | 消除 |
| --- | --- | --- | --- | --- | --- |
| B1 | `buildFreshPlayerData` 等 13 个导出（346 行） | `modules/user/freshPlayer.ts` → `kernel/fresh-player.ts` | 3 | 无（**零 `@excel/excel` 依赖**） | R3 ×1 |
| B2 | `BattleStore`（80 行） | `modules/battle/BattleStore.ts` → `kernel/battle-store.ts` | 3 | 无（只依赖 `kernel/battle-info-store` + `@core/db/replay-repo`，**零模块依赖**） | R3 ×1 |
| B3 | `GACHA_RULE_TYPE` + `resolveEffectiveUpPerCharList`（130 行，文件自述「上移公共工具层」但没搬完） | `modules/gacha/gacha-up-list.ts` → `kernel/util/gacha-up-list.ts` | 3 | 无（仅类型导入 excel；已 import `kernel/playerdata` + `kernel/util/json-path`） | R3 ×1 |
| B4 | 好友/名片共享形状（42 行） | `modules/social/social-model.ts` → `kernel/social-model.ts` | 7 | 无（只依赖 `kernel/model` + `kernel/playerdata`） | R3 ×1 |
| B5 | `recordPurchase`（32 行，自述「单点实现」，shop/crisis 跨模块消费） | `modules/pay/purchase-record.ts` → `kernel/util/purchase-record.ts`（`pay/public.ts` 留 re-export） | 4 | 无 | R3 ×2 |
| B6 | `GachaResult` | `character/char.ts:7` 改从 `kernel/model` 取（该类型**已在 `kernel/model.ts:21`**） | 1 | 无 | R3 ×1（一行改动） |

**A 组：R2 反向依赖清零（kernel 自己依赖了 modules）**

| # | 提取物 | 现状 → 目标 | 引用点 | 棘轮 | 消除 |
| --- | --- | --- | --- | --- | --- |
| A1 | 肉鸽 V2 领域模型（862 行；自述「shared 公共件」，且手写 `PlayerRoguelikeV2` 与生成模型同名重复） | `modules/roguelike/rlv2-model.ts` → `kernel/rlv2-model.ts`，模块侧留 `export *` 垫片 | 50（44 测试 + `events/core.ts`、`events/rlv2.ts`、`ops/admin/AdminService.ts`）靠垫片零改动 | 无（仅类型导入） | R2 ×2 |
| A2 | 鉴权默认绑定 | `kernel/http/auth-strategy.ts` 去掉 `= accountManager` 默认值，改由 `app/server.ts` 组合根注入；接口取 core 的 `AccountAuthPort` | 3 | 无 | R2 ×1（与 R1 `core/auth` 合一，共消 2 条） |
| A3 | excel 字典键归一化 + JSON 形状收窄 | `activities/shared/unlockActivity.ts#activityDictKey` → `kernel/util/excel-key.ts` 的**纯函数** `resolveDictKey(dict, type)`（**刻意不 import excel 单例**，调用方传 `excel.ActivityTable.activity`）；`kernel/inventory.ts:24` 的 `asJsonShape` 最小副本 → `kernel/util/json-shape.ts` | 15（经垫片兼容） | 无（正是为了不加新棘轮条目） | R2 ×1 + 消除「R2 逼出的最小副本」 |
| A4 | 干员技能/模组和解（2 类型 + 3 函数，307 行） | `modules/character/char-skills.ts` → `kernel/char-skills.ts`，模块侧留垫片 | 4（`char.ts` / `troop.ts` / `save-health.ts` / 1 测试） | **是**（基线含 `app/game/modules/character/char-skills.ts: 1`） | R2 ×1 |

**C 组：端口化（结构性，收益最大）**

| # | 提取物 | 做法 | 引用点 | 棘轮 | 消除 |
| --- | --- | --- | --- | --- | --- |
| C1 | `AccountManager` 职责切片（1076 行，混了账号身份 / 存档生命周期 / 战斗存档 / 社交存储 / 抽卡保底） | 在 `kernel/ports/` 按**消费者实际成员**切窄接口（结构匹配，无需 `extends`）：`BattleRecordPort`(battle)、`SocialReadPort`(building ×3)、`GachaPityPort`(gacha)、`PlayerLookupPort`(battle/building)；`player-composition` 注入 | 42 | 无 | R3 ×6（并供 R1 的 `core/db/{migrate,user-repo}` 复用） |
| C2 | `SocialService`（169 行，好友/访问存储服务） | 端口化注入，或上移 kernel 并重键基线条目 | 20+ | **是**（基线 1 次） | R3 ×1 |
| C3 | `TroopAccess` | 在 `kernel/ports/troop.ts` 定义结构接口（roguelike 实际只用 `chars` / `getChars()` / `expedition`），**不搬 326 行的有状态 Manager** | 5 | 无 | R3 ×2 |

> 汇总：B 组 6 项消 R3 ×7；A 组 4 项消 R2 ×5；C 组 3 项消 R3 ×9；S5 的 6 条端口另消 R1 ×10（其中认证端口与 A2 共用一条，消 R2 ×1）。故 `EXEMPTIONS` 36 → **5**（残余 4 条 R3 + 1 条实为 modules→ops 的 `system/plugin-heartbeat`，后者不在本计划范围）。
>
> **口径订正**：`architecture-coupling-adjudication.md` §1 记「R3 21 条」，实为 `EXEMPTIONS` 的 R3 区段 21 行——其中 `modules/system/plugin-heartbeat.ts → @plugin/index` 是 modules→ops，命中规则应为 R5（因 `EXEMPTIONS` 先于规则判定，故被掩盖）。本文件按 **R3 20 条 + R5 类 1 条** 计。

## 2. 分阶段方案

### S1 —— modules → kernel 纯搬运（P0，零行为变化，-7 条 R3）

按 §1.2 B 组执行：B6 → B1 → B2 → B4 → B5 → B3。
方式：`rg -l '<旧说明符>'` + 精确替换 → `tsc` 兜底漏网；模块侧如需兼容存量测试，留 `export *` 垫片（A1/A4 必留）。
每搬一项即从 `module-boundary.test.ts#EXEMPTIONS` 删除对应行并复跑守卫。

**验收**：`typecheck`×3；`vitest run tests/unit/architecture tests/unit/util/purchase-record.test.ts tests/unit/manager/account-replay.test.ts tests/unit/manager/freshPlayer.test.ts tests/unit/manager/social-assist.test.ts tests/unit/modules/gacha`。

### S2 —— 跨层纯工具下沉 core（P0，零行为变化）

按 §1.1 执行第 1–6 项（第一版 Phase 1）：

1. `kernel/util/json-path.ts` → `core/utils/json-path.ts`；内部 `@excel/json-value` 改 `@utils/json-value`；改写 8 个引用点 → **注意 S1 新增的 `kernel/util/gacha-up-list.ts` 也在其中**。
2. `kernel/util/multipart.ts` → `core/utils/multipart.ts`（3 个引用点）。
3. `kernel/util/random.ts` → **合并进** `core/utils/random.ts`（新增 `random` / `setRandSource` / `resetRandSource`；保留既有 `randomInt` / `randomChoices` / `randomSample` / `randomChoice` / `divmod`）；29 个引用点改 `@utils/random`；删除原文件。
4. `kernel/http/errors.ts` → `core/http/errors.ts`（12 个引用点，含 `game/app.ts` 的 `gameErrorHandler`）；建议同时把 `detail?: unknown` 收敛为 `JsonValue`，减少一条类型棘轮基线。
5. `kernel/http/validate-body.ts` → `core/http/validate-body.ts`（76 个引用点）。
6. （可选）`kernel/http/resp-schema.ts` → `core/http`，把 `playerDataDelta` 骨架抽为可传参。

**验收**：`typecheck`×3；`vitest run tests/unit/architecture tests/unit/util tests/unit/modules/random-source.test.ts`；同步 `errors-guard.test.ts` 中硬编码的 `kernel/http/errors.ts` 路径；刷新 `type-debt` 基线。

### S3 —— 数据目录 / 版本校验下沉 core（P0-P1）

1. `game/excel/excel-data-dir.ts` → `core/data/excel-data-dir.ts`（零依赖，`core/data/` 需新建）。
2. `game/excel/data-version.ts` → `core/data/data-version.ts`（依赖上一步）。
3. 改写消费点：`game/excel/excel.ts`、`scripts/update-data.ts`、`tests/unit/excel/{data-version,excel-data-dir}.test.ts`。

**理由**：「数据落盘位置 + 新鲜度校验」是热更管线基础设施，不属游戏业务；下沉后 ops/updater 与 scripts 可直接复用，且 `decoupling.test.ts` 的 excel→@game 守卫天然满足。`game/excel/roguelike-keys.ts` 属游戏数据归一化，**不动**。

**验收**：同 S2；额外 `pnpm run start:quick` 冒烟（数据目录解析未回归）。

### S4 —— R2 反向依赖清零（P1，逐条独立提交；§1.2 A 组）

A3（纯函数抽取，最安全）→ A1（大文件 + 垫片）→ A4（含棘轮处理）→ A2（与 S5 的认证端口同一提交）。
每条完成即从 `EXEMPTIONS` 删除对应行。

**验收**：`module-boundary` 的 R2 段 `EXEMPTIONS` 清空；`typecheck`×3 + 触达模块单测 + architecture 全量。

### S5 —— 端口化，统一清除 R1 / R2 / R3（P1，逐项独立提交）

按「收益 / 风险」排序；每条完成即删 `EXEMPTIONS` 对应行并复跑守卫。

| 项 | 内容 | 消除 | 风险 |
| --- | --- | --- | --- |
| 1 | **抓包端口**：`CaptureRecorder` 及输入/结果类型下沉 `core/capture/port.ts`；`ops/capture/capture-manager.ts` 实现/再导出；`core/utils/traffic-recorder.ts` 只依赖 core | R1 ×2 | 低 |
| 2 | **UserConfig 类型**：账号配置持久化形状下沉 `core/db/types.ts`，`AccountManager` 再导出，`core/db/{migrate,user-repo}.ts` 改引用 | R1 ×2 | 低 |
| 3 | **战斗载荷类型**：`core/utils/crypt.ts` 泛型化（`decryptBattleData<T = JsonValue>`，调用方传 `BattleData`）；`core/db/replay-repo.ts` 用自有行类型或对 `BattleInfo` 泛型化。**不整体下沉 `battle-model` / `battle-info-store`**（它们依赖 `model.ts` / `@excel`，整体下沉只会把 R1 换成新的 core→game/@excel 边） | R1 ×2 | 低 |
| 4 | **日志审计端口**：core 定义 `AuditLogSource` 端口 + 注册函数，`ops/admin` 启动时注入；`log-service.ts` 删除对 `AdminService` 的动态 import | R1 ×1 | 低 |
| 5 | **资产热更钩子端口**：core/config 定义 `AssetHooks` 端口，`ops/assets` 启动装配时注册，替换 `core/config/prod.ts` 直连 | R1 ×2 | 低 |
| 6 | **认证端口（合一）**：`core/auth/port.ts` 定义 `AccountAuthPort`（`tokenByPhonePassword` / `getUidByToken` / `getUserConfig` / `registerUser` / `updatePassword` / `updatePhone` 等）；`app/server.ts` 注入 `accountManager`；`core/auth/auth.ts` 与 **`kernel/http/auth-strategy.ts`** 同时改依赖该端口（后者只保留策略类，默认值出 kernel）。**这是一条端口同时消 R1+R2 两条**，也是第一版/第二版合并的主要收益 | R1 ×1 + R2 ×1 | 中 |
| 7 | **账号数据端口**：§1.2 C1 的 4 个窄接口，`player-composition` 注入 | R3 ×6 | 中高 |
| 8 | **社交服务端口** | R3 ×1 | 中 |
| 9 | **编队端口 `TroopAccess`** | R3 ×2 | 低 |

**验收**：R1 10→0；R2 5→0（S4 后）；R3 21→4；`typecheck`×3 + 触达模块单测 + architecture 全量。

### S6 —— 事件总线 / 请求上下文（P2，可选）

1. `events/runtime.ts` 的通用机制（`TypedEventEmitter`、优先级、中间件/验证器、`EventBus`）泛型化为 `EventBus<M extends Record<string, unknown[]>>`，下沉 `core/events/`；`game/kernel/events/index.ts` 绑定 `EventMap` 后再导出 → **20 个引用点不变**。注意 3 处 `@ts-expect-error` 随之迁移，需同步 suppression 基线。
2. `request-context.ts` 拆出 `core/http/context.ts`（`setContextValue` / `getContextValue` / `getContextValueOptional` 通用 key-store），玩家门面 `getPlayer` / `setPlayer` / `PlayerFacade` 留 game 层并委托 → **71 个调用点不变**。

### S7 —— maxout → ops 与 ops→game 复扫（P1）

1. `game/kernel/util/maxout.ts` → `ops/admin/maxout.ts`：消费方只有 `ops/admin/game-gateway.ts` 与 `scripts/generate-max-account.ts`（+2 测试），game 自身零引用。**迁移会触发 excel 棘轮**（见 §4），需同步登记路径变更。
2. `game/excel/data-version.ts` 归 core（S3）而**不**归 ops——`game/excel/excel.ts` 需引用它，而 R5 禁止 game→ops。
3. 复扫 `ops → @game/*` 边：唯一边 **17 → 14**。消失的三条是 `util/json-path`（S2 归 core）、`http/validate-body`（S2 归 core）、`util/maxout`（本阶段归 ops）；`user/freshPlayer`、`roguelike/rlv2-model` 在 S1/S4 后只是改指 `@game/kernel/*`，**边仍在**（合法：ops→game 允许）。其余均为合法运营调用（`pay-store` / `MailManager` / `gacha` / `crisis-seasons` / `unlockActivity` / `arkhub public` / `autochess public`）。

## 3. 阶段间交互与顺序

**推荐顺序：S1 → S2 → S3 → S4 → S5 → S6 → S7。**

理由与已知交叉点：

- **S1 先于 S2**：S1 是纯路径搬运、零接口变更、直接减 7 条 R3，风险最低；代价是 S2 改写 `json-path` 引用时须**额外包含** S1 新增的 `kernel/util/gacha-up-list.ts`（用 `rg -l 'kernel/util/json-path'` 一次覆盖，勿手工列清单）。
- **S4 与 S5 的认证端口是同一件事**：`core/auth/auth.ts`(R1) 与 `kernel/http/auth-strategy.ts`(R2) 指向同一个 `AccountManager`，必须一次设计 `AccountAuthPort` 并放在 **core**（kernel 可以 import core，反向不行）。拆成两次做会造出两个相似端口。
- **S7 的 `maxout` 必须晚于 S2**：S2 把 `random`/`json-path` 并入 core 后，`maxout` 若还留在 kernel 会继续从 `@excel/excel` 取单例；先下沉 core 还是先迁 ops 均可，但两者不要并行（同一提交里改 path + 改棘轮基线最容易出错）。
- **S6 与其余无耦合**，可随时插入。

## 4. 守卫与基线影响清单（修正版）

| 资产 | 是否受影响 | 处理 |
| --- | --- | --- |
| `tests/unit/architecture/errors-guard.test.ts` | **是**（硬编码 `kernel/http/errors.ts`） | S2 移动 errors.ts 时同步改路径 |
| `tests/unit/architecture/schema-first-guard.test.ts` | 否（只匹配函数名 `validateBody`） | 无需改动 |
| `tests/unit/architecture/module-boundary.test.ts` | **是**（S1/S4/S5 逐条删 `EXEMPTIONS`） | 每条完成后删行并复跑 |
| `tests/unit/architecture/excel-singleton-ratchet.test.ts` | **是，且第一版判断有误** | 见下 |
| `tests/unit/architecture/decoupling.test.ts` | 否（目标路径 `core/utils/traffic-recorder.ts` 不变） | 无需改动 |
| `tests/unit/architecture/inventory-pipeline-ratchet` | 否 | 无需改动 |
| `tests/unit/architecture/composition-order` | 否（搬文件不改 new 顺序） | 无需改动；C1 注入端口时需确认构造顺序不变 |
| `type-debt-baseline.json` | **是**（逐文件、禁残留已删除路径） | 每次移动后 `pnpm run type:debt -- --write`（新路径加 `--expand-scope`） |
| `type-escape-baseline.json` / `type-suppression-baseline.json` | 是（S6 的 3 处 `@ts-expect-error` 迁移） | 对应 `--write-escapes` / `--write-suppressions` |
| `file-size-guard.test.ts` | 否（只扫 modules 层 logic/router/handler） | 无需改动 |
| `tsconfig*.json` / `vitest.config.mts` 别名 | 否（现有 9 个别名足够） | 不新增别名 |

**棘轮修正（第一版笔误）**：第一版写「excel-singleton-ratchet 否（按内容/名字匹配）无需改动」——**错**。该棘轮按**仓库相对路径**记账，且 `diffBaseline` 对「新增路径」与「旧路径消失」**双向红灯**。因此：

- **S2/S3 移动的 8 个文件都不含 excel 默认导入**（已逐文件核对）→ 确实无影响，第一版的结论对它们成立。
- 但 **S7 的 `kernel/util/maxout.ts` 在基线里（1 次默认导入）**，迁到 `ops/admin/maxout.ts` 会同时触发 `added` + `migrated` 两条红灯；
- **S4 的 A4 `char-skills.ts` 同理**（基线 1 次）；**C2 `SocialService.ts` 同理**（基线 1 次）。
- 处理口径：路径重键**不是放宽棘轮**（次数 1→1 不变），但必须在同一次提交里（a）从 `counts` 删旧键、加新键，（b）在基线 `_moves` 显式登记 `旧路径 → 新路径 + 日期 + 原因`，供审计。
- **更优解**（推荐 A4/C2 采用）：迁移同时把 excel 改为端口参数（`reconcileCharSkills(excelData, ...)`），旧键直接删除、不再新增——既过棘轮又推进端口化。仅当调用链在 PlayerDataManager 之前（load 阶段）拿不到 `ExcelData` 时才退回重键。

**新增守卫（防回潮）**

1. `module-boundary.test.ts`：把 R2 组合根白名单从「`COMPOSITION_ROOTS` 集合豁免」收紧为**精确 2 文件**，并新增用例「R2 段 `EXEMPTIONS` 必须为空」。
2. `excel-singleton-ratchet.test.ts`：给 `diffBaseline` 增加 `moves` 参数——`added` 与 `migrated` 数量相等时视为路径重键，但必须命中基线 `_moves` 登记，否则仍红灯。防止借「搬文件」之名放宽棘轮。

## 5. 风险与不做清单

**风险**

- **棘轮基线**：逐文件棘轮要求「不得残留已删除路径」+ 新文件零模糊类型 → 每次移动后必须刷新基线，否则 architecture 红；`errors.ts` 的 `detail?: unknown`、`common.ts` / `resp-schema.ts` 的 `unknown` 均已在基线内。
- **测试镜像路径**：`tests/unit/util/json-path.test.ts` 按约定应镜像到 `tests/unit/core/utils/`，但 AGENTS.md 的性能不变量（每个新测试文件约 10~20s worker 时间）要求能不新建文件就不新建——优先原地保留、只改 import。
- **接口变更（S4/S5）**：端口化必须保证「缺省绑定真实单例，行为不变」（沿用 `kernel/http/auth-strategy.ts` 的 `AuthAccountPort` 模式），并逐条独立提交以便回滚。
- **不要为消除 R1 而制造新的 core→@excel**：`battle-model` / `model.ts` / `excel-port.ts` 依赖 `@excel` 或玩家模型，整体下沉会把 core 变成新的耦合方。
- **C1 是最大单项**（42 引用点、AccountManager 1076 行）：必须先只读端口（`PlayerLookupPort` / `SocialReadPort`），写端口（`GachaPityPort`，涉及保底计数持久化）单独提交。

**不做（非目标）**

- 不重构 `PlayerStatus` / `inventory*` / `excel-port` / `playerdata.ts` / `model.ts` / `http/common.ts`（游戏领域，位于 kernel 是架构规定的组合根共享层）。
- **不把以下 R3 边塞进 kernel**（用门面 / 事件 / 落位修正处理，见下表）。
- 不引入新别名。
- 不改 `ops → game public` 的合法运营调用边。
- 不在本计划内改动任何路由协议 / 响应形状 / 存档格式。

**R3 剩余 4 条的处置（不走 kernel）**

| 边 | 处置 | 理由 |
| --- | --- | --- |
| `charm/routes → home/home`（`CharmSetSquadRequest/Response`） | 建 `home/public.ts` 门面 | home 域协议 |
| `user/routes → account/user` + `user.schema` | 协议搬到 user 模块 | 是 `/user/*` 端点协议，落位错误 |
| `battle → activities/act44side/informant` | 事件驱动 | 活动私有状态机 |
| `activities/shared/unlockActivity` 主体（15 引用点） | 留 `activities/shared` | 活动域播种逻辑，守卫已规则级豁免；只有 `activityDictKey` 一个纯函数上移（A3） |
| `system/plugin-heartbeat → @plugin/index` | 端口化插件宿主 | 严格说是 R5（modules→ops）而非 R3，故不计入「剩余 4 条」；本计划不动，单独排期 |

## 6. 执行顺序与验收

| 阶段 | 内容 | 风险 | 削减 | 建议提交粒度 |
| --- | --- | --- | --- | --- |
| S1 | modules → kernel 纯搬运（B 组 6 项） | 低 | R3 −7 | 每 1–2 项一提交 |
| S2 | kernel 纯工具下沉 core（errors / validate-body / json-path / multipart / random / 可选 resp-schema） | 低（机械改写） | ops→game −2 | 每 1–2 文件一提交 |
| S3 | excel-data-dir / data-version 下沉 core | 低 | — | 1 提交 |
| S4 | R2 清零（A 组 4 项） | 中（A1 大文件 + A4 棘轮） | R2 −5 | 每项独立提交 |
| S5 | 端口化 9 项（R1 + R3） | 中→高（认证/账号数据端口） | R1 −10、R3 −9 | 每项独立提交 |
| S6 | 事件总线 / 请求上下文（可选） | 中 | — | 各 1 提交 |
| S7 | maxout → ops + ops→game 复扫 | 低（含棘轮重键） | ops→game −1 | 1 提交 |

每阶段统一验证：

```bash
pnpm run typecheck && pnpm run typecheck:scripts && pnpm run typecheck:tests
pnpm exec vitest run tests/unit/architecture
pnpm run type:debt -- --write            # 需要时加 --expand-scope
pnpm exec vitest run                     # 最终全量（与 HEAD 基线比对，零新增失败）
```

**复跑统计**

```bash
for p in kernel/http/validate-body kernel/http/errors kernel/http/common kernel/util/json-path \
         kernel/util/multipart kernel/util/random kernel/util/maxout kernel/events; do
  n=$(grep -rl "$p\"" app scripts tests hook index.ts | wc -l); printf "%4d  %s\n" "$n" "$p"
done
grep -rn "from \"@game\|from \"@ops\|from \"@capture\|from \"@asset" app/core --include=*.ts   # R1 边
grep -rn "modules/" app/game/kernel --include=*.ts | grep -v "player-composition\|PlayerDataManager"  # R2 边
```

**预期收益（量化）**

| 指标 | 现在 | 目标 |
| --- | --- | --- |
| `EXEMPTIONS` 总数 | 36 | **5** |
| 其中 R1（core→game/ops） | 10 | **0** |
| 其中 R2（kernel→modules） | 5 | **0**（硬门禁） |
| 其中 R3（模块间） | 20 | 4（按 §5 以门面/事件/落位修正处理） |
| 其中 R5 类（modules→ops） | 1（`system/plugin-heartbeat`） | 1（不在本计划范围，需插件宿主端口） |
| kernel 文件数 | 30 | ≈ **38**（搬入 14：A1、B1–B5、A3×2、A4、C1×4、C3；搬出 6：S2 的 5 个 util/http + S7 的 maxout） |
| ops/scripts→`@game` 唯一边 | 17 | **14**（`util/json-path`→core、`http/validate-body`→core、`util/maxout`→ops 三条消失；`freshPlayer`/`rlv2-model` 只是改指 kernel，边仍在） |

完成后：`app/game/kernel/` 是「不依赖任何业务模块（除 2 个组合根）+ 可注入 excel/账号/战斗/社交端口」的纯共享层，`app/core/` 不再依赖 game/ops，`game/kernel` 与 `core` 的分界线可被守卫机器验证。

---

## 9. 实施结果（2026-09-13）

> 本节为**落地记录**，与上文计划逐条对账。**不改变任何运行行为**（除下文「行为可见变更」明确列出的两处）。

### 9.1 总账

| 指标 | 计划前 | 落地后 | 目标 | 结果 |
| --- | --- | --- | --- | --- |
| `EXEMPTIONS` 总数 | 36 | **5** | 5 | ✅ |
| R1（core→game/ops） | 10 | **0** | 0 | ✅ |
| R2（kernel→modules） | 5 | **0** | 0 | ✅ |
| R3（模块间） | 20 | **4** | 4 | ✅ |
| R5 类（modules→ops） | 1 | 1 | 1 | ✅（不在范围） |
| `app/game/kernel` 文件数 | 30 | 33 | ≈38 | 略低于估（S6 跳过 + 2 处改用门面/删死码） |
| `ops/scripts → @game` 唯一边 | 17 | **14** | 14 | ✅ |

### 9.2 各阶段落地情况

| 阶段 | 内容 | 状态 | 备注 |
| --- | --- | --- | --- |
| **S1** | modules → kernel 纯搬运（B1–B6） | ✅ 全部 | `fresh-player`、`battle-store`、`social-model`、`util/gacha-up-list`、`util/purchase-record`（`pay/public` 留 re-export）、`char.ts` 的 `GachaResult` 改从 `kernel/model` 取 |
| **S2** | kernel 纯工具下沉 core | ✅ 5/6 | `json-path`/`multipart` → `core/utils`；`random` **合并进** `core/utils/random.ts`（原文件删除）；`errors`/`validate-body` → `core/http`。**`resp-schema` 未下沉**（计划标为可选，且其骨架含 `playerDataDelta` 游戏协议）。共改写 129 处引用 / 123 个文件 |
| **S3** | `excel-data-dir`/`data-version` → `core/data` | ✅ | 新建 `app/core/data/` |
| **S4** | R2 清零（A1–A4） | ✅ | A2 并入 S5-6 |
| **S5** | 端口化 9 项 | ✅ 9/9 | 见 §9.3 的 3 处口径调整 |
| **S6** | 事件总线 / 请求上下文下沉 | ⏸ 未做 | 计划标「P2，可选」；降级为待排期项（见 §9.5） |
| **S7** | `maxout` → `ops/admin` | ✅ | 因移出 `app/game` 扫描范围，其 excel 棘轮基线条目**直接删除**（88 条） |

**S1/S2/S3/S4 明细**

- S1：`fresh-player.ts`（346 行）、`battle-store.ts`（80 行）、`social-model.ts`（42 行）、`gacha-up-list.ts`（130 行）、`purchase-record.ts`（32 行）上移；`char.ts` 一行改动消一条 R3。
- S2：`random.ts` 采用**合并**而非搬运（`core/utils/random.ts` 新增 `random`/`setRandSource`/`resetRandSource`，既有 5 个导出行为不变）。
- S4：`rlv2-model.ts`（862 行）上移并留 `export *` 垫片（50 个引用点零改动）；`activityDictKey` 抽为**纯函数** `kernel/util/excel-key.ts#resolveDictKey(dict, type)`（刻意不 import excel 单例，故不新增棘轮条目），`activity-json.ts` 的通用形状收窄整体上移 `kernel/util/json-shape.ts` 并 re-export；`char-skills.ts`（307 行）上移，按计划**回退方案**保留 excel 单例 + 棘轮基线重键（`checkAndRepairSave` 运行在 PlayerDataManager 之前，拿不到 `player.excel`）。

### 9.3 与计划的三处口径调整（均为落地时的更优解）

1. **S5-7 `AccountManager` 消费者（R3 ×6）**：计划为「在 `kernel/ports/` 切 4 个窄接口 + 构造注入」。落地改为**经 `account/public.ts` 门面**引用 `accountManager`——这是 AGENTS.md「落位规则」明文许可的模块间机制（R3 只要求经 `public.ts`），而构造注入需要改动 battle/building/gacha/social 四个模块的构造签名与 `player-composition` 装配顺序（后者被 `composition-order.test.ts` 锁定）。**代价**：仍是运行期单例耦合，未获得端口级的可替换性；如后续需要多账号/多服隔离，再按 C1 原文补端口。
2. **S5-9 编队（R3 ×2）**：计划为 `kernel/ports/troop.ts` 的 `TroopAccess`。落地时核实 **roguelike 的 `_troop` 字段是只写不读的死字段**（全仓仅 2 处声明 + 2 处赋值，零读取），故直接删除字段与 import，不再引入仅为死码服务的接口。**顺带消除了 2 条 R3 且零新增抽象。**
3. **S5-8 `SocialService`（R3 ×1）**：计划为「端口化或上移 kernel」。落地新建 `modules/social/public.ts` 门面 re-export（与 1 同理由；且该文件直连 excel 单例，上移会新增棘轮条目）。

### 9.4 端口新增清单（core / ops 各就各位）

| 端口/公共件 | 位置 | 绑定/实现 | 消费者 |
| --- | --- | --- | --- |
| `CaptureRecorder`（+输入/结果类型） | `app/core/capture/port.ts` | `ops/capture/capture-recorder.ts` 转 re-export；**组合根 `app/server.ts` 显式注入 `captureManager`**（`createTrafficRecorder` 缺 recorder 即抛错，不再缺省绑定） | `core/utils/traffic-recorder` |
| `AuditLogSource` | `core/logs/log-service.ts` | `AdminService` 构造时 `registerAuditLogSource(this)` | `log-service.readAuditLog` |
| `AssetHooks` | `core/config/asset-hooks.ts` | `ops/assets/asset-hooks.ts`（装配点）；组合根 `server.ts` 注册；未注册回落安全降级实现 | `core/config/prod` 三个版本端点 |
| `AuthAccountPort`（窄）/ `AccountAuthPort`（宽） | `core/auth/account-port.ts` | `AccountManager` 构造时 `registerAccountAuthPort(this)` | `core/auth/auth.ts` 全部路由 + `kernel/http/auth-strategy.ts`（缺省绑定移出 kernel） |
| `UserConfig` | `core/db/types.ts` | `AccountManager` re-export 兼容存量 13 处引用 | `core/db/{user-repo,migrate}` |
| 战斗载荷泛型 | `core/utils/crypt.ts`（`decryptBattleData<T = JsonValue>`）、`core/db/replay-repo.ts`（`BattleRecordRow` + 泛型读取） | 调用方显式传 `BattleData`（8 个生产调用点） | battle/roguelike/tower/crisis/arkodc/aprilFool/bossRush |
| `common/社交形状` | `kernel/social-model.ts`、`kernel/rlv2-model.ts`、`kernel/char-skills.ts`、`kernel/util/{excel-key,json-shape,gacha-up-list,purchase-record}.ts`、`kernel/{fresh-player,battle-store}.ts` | 模块侧按需留 `export *` 垫片（rlv2-model）或直接改引用 | 全量 modules |

### 9.5 守卫与基线

- `module-boundary.test.ts` **新增 2 条固化用例**：①「R2 段 `EXEMPTIONS` 必须为空」；②「`COMPOSITION_ROOTS` 固定为 `PlayerDataManager.ts` + `player-composition.ts` 两个文件（防止扩表）」。测试数 5 → 7。
- `EXEMPTIONS` 注释与 `docs/architecture-coupling-adjudication.md` 口径同步（现存 5 条 = 4 条 R3 残余 + 1 条 R5 类）。
- `excel-singleton-baseline.json`：`char-skills` 路径重键（1→1，非放宽）；`maxout` 条目删除（移出扫描范围）；条目 89 → 88。
- `type-debt-baseline.json`：`fresh-player`、`char-skills`、`errors` 三处路径重键（计数不变）。
- `errors-guard.test.ts`：硬编码的 `kernel/http/errors.ts` 改指 `app/core/http/errors.ts`。
- **未实施**：计划 §4「新增守卫 2」的 excel 棘轮 `_moves` 重键登记机制。理由：本轮的 3 次重键均**原地重键**（旧键删除、新键写入，计数不变），`diffBaseline` 的 `added`/`migrated` 均为空，`_moves` 无实际吸收对象；该机制只有在「保留旧键 + 登记迁移」的记账方式下才有约束力，需与 `ghosts` 用例一并改造，降级为待排期项。

### 9.6 行为可见变更（仅两处，均为计划内）

1. `createTrafficRecorder` **要求显式注入 recorder**（缺省抛错）。生产唯一调用点 `app/server.ts` 已传 `captureManager`；9 处测试调用点补传同一单例。
2. `logService.readAuditLog` 在 ops/admin 未加载时返回**空列表**（原先经动态 import 强制加载 `AdminService`）。生产路径（Dashboard/CLI 走 admin）不受影响。

### 9.7 验证

- `tsc -p tsconfig.json` / `tsconfig.scripts.json` / `tsconfig.tests.json` **全 0 错误**。
- `tests/unit/architecture` 全绿（9 文件 / 55 用例，含 2 条新增固化用例）。
- **全量 `vitest run`：291 文件 / 3064 用例 → 3053 passed / 11 failed**。11 条失败**全部为既有/环境问题**（逐条定性见下），本轮改动**新增 0 失败**：

| 失败 | 定性 | 证据 |
| --- | --- | --- |
| `admin/admin-service.test.ts` ×2 | 环境：SQLite WAL | 独立复现 `new DatabaseSync("data/user/social.db")` + `PRAGMA journal_mode = WAL` → `disk I/O error`（`/mnt/d` 9p/drvfs 不支持 WAL 共享内存） |
| `scripts/migrate-official.test.ts` ×3 | 环境：同上 | 失败路径经 `readUsers() → openDatabase()` 触达同一 WAL |
| `manager/account-authmode.test.ts` ×2 | 环境：种子文件缺失 | `data/player_data.json.root-backup` 与 `data/user/databases/1.json` 在工作区不存在（`_loadTemplate` 抛「找不到模板存档」） |
| `scripts/pack-lua-min-current` ×1、`scripts/repack-lua-bundle` ×1、`plugin/lua-mod-builder` ×1 | 在途 WIP | `scripts/pack-lua-bundle.ts` / `repack-lua-bundle.ts` 在本轮开始前已是修改态（初始 `git status` 即 `M`） |
| `router/crisis.test.ts` ×1（仅并行全量时） | 时序 flake | **单跑 13/13 全绿**；并行全量下 `await setTimeout(30)` 窗口不足，handler 未及 `res.send`（与 `docs/test-performance-2026-09-13.md` 记录的既有偶发失败同源） |

### 9.8 残余与后续

| 项 | 内容 | 建议 |
| --- | --- | --- |
| R3 ×4 | `battle→act44side/informant`（事件化）、`charm/routes→home/home`（建 `home/public.ts`）、`user/routes→account/{user,user.schema}`（协议搬 user 模块） | 独立小批，见 §5 处置表 |
| R5 ×1 | `system/plugin-heartbeat → @plugin/index` | 插件宿主端口化 |
| S6 | 事件总线泛型下沉 `core/events`、`request-context` 拆通用 key-store | 可选，风险中（20/71 引用点 + 3 处 suppression 迁移） |
| C1 端口 | `AccountManager` 的 4 个窄接口 + 构造注入（本轮回退为 `public.ts` 门面） | 有多账号/多服隔离需求时再排期 |
| `_moves` 守卫 | excel 棘轮迁移登记 | 与 `ghosts` 用例一起改造 |
