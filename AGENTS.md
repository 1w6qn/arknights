# AGENTS.md

Arknights (明日方舟) private-server backend: Express 5 + TypeScript, JSON-file storage, mutative state. Requires **Node 24** (uses built-in `node:sqlite` and `fetch`). Main data layer supports **SQLite (default) / MySQL / PostgreSQL** — see `app/core/db/`.

## Commands

```bash
pnpm start                # 默认跳过数据更新（config.autoUpdate=false），2s 起服；后台检测新版本并提示
pnpm run update           # 显式更新数据（官方热更管线 + 类型 + gacha + 版本同步）
pnpm start -- --auto-update  # 启动时先更新再起服（旧行为）
pnpm start -- --background-update  # 先起服，更新完成后热重载 excel
pnpm start -- --offline   # zero-network start, verifies 66 local data files first
pnpm run start:quick      # quick local start: tsx index.ts -s (no network, use local data)
pnpm run start:capture    # capture mode: tsx index.ts -s --capture (as/gs 转发官服并记录 tmp/capture/ 统一抓包存储)
PORT=9000 pnpm run start:quick   # 不同端口启动（环境变量 PORT 覆盖 config.json 的 8443）
pnpm run start:quick -- --port 9001  # 或命令行 --port（优先级高于 PORT 环境变量）
pnpm run start:capture -- --port 9002  # capture 模式同样支持端口覆盖（gs/as 地址同步使用新端口）
start.cmd                # Windows one-click: quick start + auto-open admin dashboard
start-mumu.cmd           # Windows one-click: MuMu + WSL 私服 + 4 条中继 + adb forward/reverse + hook 构建 + frida 注入（--dry-run/--no-frida/--duration N，见 docs/frida-mumu-lua-plugin-playbook-2026-09-14.md §8）
pnpm run mumu             # 同上链路的 WSL 侧主体（scripts/mumu-start.sh；中继需已就绪）；mumu:boot = Windows 侧编排，mumu:relay = 中继组
pnpm run build            # tsc (typecheck)
pnpm run test             # vitest run
pnpm exec vitest run tests/unit/manager/char.test.ts   # single test file
pnpm run admin -- users list                       # CLI admin (no server needed)
pnpm run admin -- capture records --json           # 统一抓包存储（capture sessions/records/show/stats/export/clear）
pnpm run admin -- logs server --last 50 --json     # 统一日志（logs server|watchdog|audit）
pnpm run migrate:official -- --accounts <file>     # import official-server account data
pnpm run db:migrate -- --dry-run                   # 主数据层跨后端搬迁（SQLite ⇄ MySQL/PG），先看各表行数
pnpm run db:migrate                                # 按 config.database 复制到目标后端（目标非空时拒绝，--force 覆盖）
pnpm run hook              # frida-compile for hook/main.ts (excluded from tsc)
pnpm run frida:build       # 打包 hook/*.ts → hook/build/*.js（esbuild；MuMu il2cpp 调试用，产物 gitignored）
pnpm run frida:mumu -- --install-gadget   # 首次：把 arm64 frida-gadget 装进 MuMu 应用的 native 库目录
pnpm run frida:mumu -- --duration 60      # 双 agent 日志管线（x86_64 宿主 liblog + arm64 il2cpp/Debug 日志），见 docs/frida-mumu-il2cpp-2026-09-13.md
pnpm run ts                # scripts/proxy-harness.ts = 官服代理抓包 harness（记录写入统一抓包存储 tmp/capture/，支持 --session <名称>）, NOT the vitest suite
pnpm run generate:mapviz   # scripts/generate-mapviz-data.ts → data/mapviz/game-data.js（Dashboard 地图 Tab 数据源）
pnpm run schema:check      # FBO schema 漂移检查（与 reference/ 最新 CS 签名逐字段比对；有 slot 位移则非 0 退出）
pnpm run schema:diff       # 同上 + 打印前 20 处差异明细
pnpm run schema:write      # 按 CS 签名重写 scripts/vendor/fbs-schemas/*.json（改动即生效，谨慎）
pnpm run schema:crosscheck # 与 reference/OpenArknightsFBS-main/FBS 交叉校验（缺表/缺字段/悬空引用/读宽）；-- --md <path> 出报告，-- --strict 有硬漂移时非 0 退出；-- --fbs-zip reference/obs/OpenBachelorM-master.zip --fbs-version 2.7.61 现抽 obs 历史版本再比对
pnpm run schema:timeline   # 逐版本字段时间线（哪个字段哪个版本冒出来）：-- --table item_table [--struct clz_Torappu_ItemData] [--versions a,b]
pnpm run schema:audit      # 报文真值审计：解码官方 bundle 比对 vtable 声明字段数 vs schema 字段数（缺字段/多字段）；-- --json <path> 落盘
pnpm run routes:diff       # OBS(OpenBachelorS) ⇄ 本仓路由差集（挂载感知，静态近似）；-- --json <path> 落盘
pnpm run decompile         # 官服客户端反编译工作流（Cpp2IL→ilspycmd→dump-cs-signature.py），产出 reference/arknights-<版本>-csharp/（含方法体的 C# 源码）+ reference/com.hypergryph.arknights_<版本>.cs（签名文件，供 generate:types 再生类型；均 gitignored）；末尾自动跑 schema:check 门禁
pnpm run apk:lua           # 抓最新官服 Android APK → 定位内置 Lua bundle → 提取明文 → 注入插件引导 → mods/anon_<hash>.dat
pnpm run apk:mod           # 一键改造：定位最新 APK + 对应 mod → zip 级回灌 → 结构自检 → 重签名 → tmp/apk-out/*-mod-signed.apk
pnpm run apk:patch         # 仅 zip 级改造（--list/--dry-run/--replace/--lua-bundle/--sign），不反编译 dex
pnpm run apk:sign          # 重签名封装（--fetch-tools 拉便携 JRE+uber-apk-signer 到 tmp/tools；--verify 复验）
pnpm run apk:rename        # 等长二进制改包名（AXML/arsc/dex/配置；同长替换免反编译）+ --add/--replace/--sign
pnpm run apk:url-redirect  # 官服域名等长改写（https→http + 主机名+1），把客户端流量导到私服（配 /etc/hosts + adb reverse）
pnpm run apk:slim          # APK 精简：默认去掉非 arm64 ABI（--keep-abi/--drop/--drop-prefix/--allow-risky，--report 先体检）
pnpm run apk:assets        # APK assets 体检报告（分组占用/扩展名/逐条目魔数分类）
pnpm run sign:key          # 私服验签密钥：--gen 生成 1024 位密钥对 / --patch-apk 等长替换 asset 公钥 / --sync-plugin / --sign / --verify-content
```

No lint script exists（ESLint 配置在仓但 `typescript-eslint` 8 尚不支持 TS 7，跑不起来）. Verification order: `pnpm run typecheck` (= `tsc -p tsconfig.json`, app+index) → `pnpm run typecheck:scripts` (= `tsc -p tsconfig.scripts.json`, app+index+scripts) → `pnpm run typecheck:tests` (= `tsc -p tsconfig.tests.json`, 含 `tests/**`) → `pnpm exec vitest run`。（`tsc` 增量模式会吞掉未变更文件的错误——判 0 错误时加 `--incremental false`，或先删 `.tsbuildinfo`。）

**类型债棘轮**：`pnpm run type:debt` 报告全仓（`app`+`scripts`+`tests`+`hook`+`index.ts`）的 `any`/`unknown`/`object` 计数、**逃逸点（`as unknown as`）**与 **suppression（`@ts-expect-error`/`@ts-ignore`/`@ts-nocheck`）**，守卫是 `tests/unit/architecture/type-debt-ratchet.test.ts`（逐文件只减不增；新文件必须零模糊类型）。**全仓 `any` 已清零（7131 → 0），并由守卫的「全仓 `any === 0`」用例固化——不得回退**；`unknown`/`object` 仍走逐文件棘轮（存量计数以 `tests/unit/architecture/type-debt-baseline.json` 为准）。两条逃生通道各有独立基线（`type-escape-baseline.json` / `type-suppression-baseline.json`），刷新用 `pnpm run type:debt -- --write-escapes` 与 `-- --write-suppressions`（均只紧不松）；收敛后刷新模糊类型基线 `pnpm run type:debt -- --write`；**扫描范围扩容**时才用 `pnpm run type:debt -- --write --expand-scope`（只放行新增文件）。策略、四种归宿与集中 suppression 政策见 `docs/type-system-audit.md`。

## Generated files — never hand-edit

- `app/game/excel/types_excel_gen.ts` — regenerated from CS decompiled source (`reference/com.hypergryph.arknights_<ver>.cs`, auto-detected newest — **never hardcode the version**) by `scripts/generate-types.ts --excel`
- `app/game/excel/types-playerdata.ts` (796 interfaces, 1065 enums) — regenerated by `scripts/generate-types.ts --playerdata`
- `data/gacha_detail_table.json` — 卡池详情（`data/gacha/` 源目录已移除，不再由 update 合并生成；`pnpm run admin -- official gacha-sync` 从官服同步）
- `data/excel/*.json` — generated by `scripts/official-excel.ts` (官方 CDN 热更，纯 TS 零 Python 依赖：UnityFS 解包 + FBO/AES-CBC JSON 解密 + camelCase + 枚举字符串转换); **`pnpm run update` 触发管线并重新生成类型**. Manual excel tweaks get clobbered. 每张表旁挂 `<表>.json.meta.json` 溯源指纹（`sourceMtime`/`schemaMtime`/`csSource`，由 `excel-convert.ts#writeMeta` 落盘，是 `isUpToDate` 增量判据与 `verifyTableFreshness` 同批校验的数据源）。部分表（range/player_avatar/roguelike/sandbox/uniequip_data/handbook/tech_buff）为 AES-CBC 加密 JSON，直接用 `MASK_V2` 解密，非 FBS。schema 描述在 `scripts/vendor/fbs-schemas/*.json`（由 `scripts/cs2schema.ts` 从 CS 签名源生成；`scripts/schema-gen.ts` 是从已移除的 vendored Python schema 的一次性历史工具）。
- `2221.js` — compiled Frida artifact, never edit.
- `hook/build/*.js` — `pnpm run frida:build` 的产物（frida-il2cpp-bridge / frida-java-bridge 的 bundle），gitignored，勿手改

**Schema 生成规则（2026-09-12 起，`scripts/cs2schema.ts`）**：字段 = 自身 + 基类链（自身在前，泛型基类按实例展开）；引用闭包补齐缺失表；不可达表清理；`NON_WIRE_FIELDS`/`NON_WIRE_TYPES` 登记实测不在报文里的运行时字段（漏登记会让其后 slot 整体位移）。三条判定口径互为交叉验证：`schema:check`（CS 签名）、`schema:crosscheck`（OpenArknightsFBS 参考）、`schema:audit`（报文 vtable 真值，唯一不依赖外部参考的口径）；不变量守卫见 `tests/unit/scripts/fbs-schema-invariants.test.ts`，修复记录见 `docs/fbs-schema-repair-2026-09-12.md`。

Game-data update (`scripts/update-data.ts`) 调用官方热更管线 `scripts/official-excel.ts --download --decode --convert`（TS 实现，零 Python 依赖，无 ArknightsGameData 仓库依赖）；excel/playerdata 类型均由 CS 反编译源生成（不再依赖 OpenArknightsFBS/FBS）。**CS 源路径必须经 `scripts/lib/cs-source.ts#resolveCsFile()` 通配探测**——`reference/` 被 gitignore 且文件名内嵌客户端版本号（每次客户端更新改名），硬编码版本号会让 `existsSync` 守卫静默失效（历史缺陷：类型生成被跳过、CS 枚举补充被禁用，均不报错）。参考数据链路：`pnpm run decompile` 产出反编译源码与签名文件，末尾自动跑 `pnpm run schema:check` 做 **FBO schema 漂移门禁**（C# 字段序 = FBO vtable slot 序，字段插入中部会让其后 slot 全体位移 → 解码错位/OOM）；漂移时用 `pnpm run schema:write` 重写。

## Architecture

- **目录三层**：`app/core/`（基础设施内核：config/db/logs/utils/auth，被依赖方，禁止 import game/ops）、`app/game/`（业务）、`app/ops/`（运营设施：admin/capture/proxy/updater/plugin/assets，可依赖 core 与 game 模块的 public.ts）。
- **game 侧特性切片**：`game/kernel/`（PlayerDataManager 组合根、PlayerStatus、player-composition、events 事件契约+总线、http 路由契约基建、inventory-pipeline、共享 util）、`game/excel/`（游戏数据 + 生成类型）、`game/modules/<mod>/`（一业务模块一目录，自含 `routes.ts` 薄路由 + `*.schema.ts` 契约 + manager/logic 业务 + public.ts 对外出口）、`game/modules/activities/<family>/`（活动族自含 `routes.ts`+`logic.ts`，共享逻辑在 `activities/shared/`）。
- **模块示例**：autochess（卫戍协议自走棋，`modules/autochess/`，路由挂 `/activity` 前缀、客户端调用 `/activity/autochessSeason/*`）、user（玩家资料端点：buyAp/useItem/主线线索/语音档案/长期签到/CG 持久化，`modules/user/`）、arkhub（奇象巡展，`activities/arkhub/`：`domain/`（状态/ARKDEX/像素格式）+ `session/`（长连接网关协议栈 messages→codec→contract→dispatch→handlers→server，启动绑定在 `session/bindings.ts`）+ `capture/`（抓包转发器/协议解析），模块外一律经 `public.ts`，见 `docs/arkhub-重构-2026-09-13.md`）；全量模块清单与成熟度结论见 `docs/module-audit-2026-08-29.md`。
- **主数据层（`app/core/db/`）**：好友/账号配置/回放/结算/玩家存档统一走 `SqlDatabase` 抽象（`prepare`/`exec`/`transaction`，**全异步**）。仓储只写 `?` 占位符与公共 SQL，方言差异（`INSERT OR REPLACE` vs `ON DUPLICATE KEY UPDATE` vs `ON CONFLICT`、`?→$n`）收敛在 `dialect.ts`，表结构声明在 `schema.ts` 的 `TABLES`（新增表/列只改这里）。**新增仓储方法必须异步**；测试用 `await openDatabase(":memory:")` 并 `await closeDatabase()`。后端由 `config.database` 或 `DB_*` 环境变量选择，缺省 SQLite 保持历史行为；`mysql2`/`pg` 是 optionalDependencies，**禁止顶层 import**（用 `drivers/load.ts` 动态加载）。抓包索引与资源注册表仍是本地 SQLite，不参与切换。
- **落位规则（唯一）**：新功能 = 找到业务模块包，没有就在 `modules/` 建包。不设 domain/service/manager 目录。模块间只允许 import 对方 `public.ts` 或走事件总线；守卫见 `tests/unit/architecture/module-boundary.test.ts`。
- **Flow**: `game/routes.ts` 聚合注册（懒加载）→ `modules/<mod>/routes.ts`（薄壳 + validateBody）→ 模块内 manager（经 `kernel/PlayerDataManager` 组合，`httpContext` key `playerData`）。事件驱动：managers 在构造器 `this._trigger.on(...)` 订阅，事件契约在 `game/kernel/events/`。
- **State changes**: all through `player.update(recipe)` (mutative two-phase in `kernel/PlayerStatus`) which records patches. mutative `enableAutoFreeze` is off — managers mutate arrays directly; do not re-enable freezing.
- **Response contract**: `res.send(player.delta)`. The `delta` getter returns `{ playerDataDelta }`, **clears `_changes` and triggers `save`** (persists to `data/user/databases/{uid}.json`). Never read `player.delta` twice in one request.
- **Single-account private server**: `game/app.ts` middleware forces any `secret` header to `"1"` → every request is uid=1.
- **统一抓包存储** (`app/ops/capture/capture-manager.ts` 单例 `captureManager` + `capture-db.ts`)、**统一日志服务** (`app/core/logs/log-service.ts` 单例 `logService` + `app/core/utils/sse.ts`)：职责不变，路径更新如上。
- **入口**：根 `index.ts` 仅含进程级兜底与 CLI 解析，服务器编排在 `app/server.ts` 的 `main()`。

## Conventions

- **文件命名（2026-09-14 统一，守卫固化）**：一份文件只有两种路由载体——`routes.ts`（模块/活动族主路由）与 `<域>.routes.ts`（同一模块的第二个路由文件，如 `charRotation.routes.ts`、`mailCollection.routes.ts`、`rlv2.routes.ts`、`plugin.routes.ts`）；**不再使用** `router.ts` / `handler.ts` / `schemas.ts`。请求契约一律 `*.schema.ts`（`building.schema.ts`、`user.schema.ts`…）。其余文件名一律 kebab-case（`account-manager.ts` 导出 `class AccountManager`、`social-service.ts`、`storyreview-manager.ts`）。守卫：`tests/unit/architecture/module-boundary.test.ts`（R4 路由载体）与 `file-size-guard.test.ts`（路由载体 ≤1500 行）。
- Imports use aliases `@game/*`, `@excel/*`, `@utils/*`, `@capture/*` (统一抓包存储), `@logs/*` (统一日志服务), `@plugin/*`, `@asset/*`, `@core/*`, `@ops/*`（共 9 个）. **Aliases are configured in both `tsconfig.json` and `vitest.config.ts`** — update both when adding one.
- Logging: use `logger` from `@utils/logger` (`logger.info/debug/warn/error(tag, ...args)`). Never `console.*` in `app/`. Level is gated by `LOG_LEVEL` env (default `info`; `debug` shows battle drop traces). 实时日志订阅见 `subscribeLog`（统一日志服务 SSE 尾随的数据源）。高日志密度域用 `domainLogger(domain)` 工厂（固定域标签，见 design-spec §35.2）。
- 物品增减统一经 `player.gainItem.setTarget(...).use()/handle()` 管道（inventory-pipeline.ts），不直发 `items:get/items:use` 事件（见 design-spec §35.3）。**已全量迁移并由棘轮守卫固化**（2026-09-11，84 处 → 0）：检查 `pnpm run items:direct`，守卫见 `tests/unit/architecture/inventory-pipeline-ratchet.test.ts`；管道队列由 `PlayerDataManager.delta` 收尾与 `gameErrorHandler` 双点回收，防跨请求残留。
- 新增寻访池规则类型须显式适配 gacha 策略表（未知类型会报错，不再静默回退 NORMAL）；保底概率计算收敛在 `game/modules/gacha/gacha.ts#resolveGachaRank` 纯函数（见 design-spec §35.4）。
- 基建新技能优先以 Buff 模板类声明（`game/modules/building/buffs/`，继承 BaseBuffTpl），value 与 buff-parse 引擎一致（见 design-spec §35.6）。
- 新路由先落 contract：POST 路由必须经 `validateBody(zodSchema)`（守卫 tests/unit/architecture/schema-first-guard.test.ts 强制，multipart 端点豁免）。
- **跨层能力一律走端口注册（2026-09-13）**：core 不得依赖 game/ops（R1）、kernel 不得依赖 modules（R2）。需要上层能力时，在 core/kernel 定义端口 + 注册函数，由**实现侧构造时自注册**或**组合根 `app/server.ts` 注入**；禁止在 core/kernel 里缺省绑定上层单例。已落地四处：`@core/capture/port`（组合根注入 recorder）、`@core/auth/account-port`（`AccountManager` 自注册）、`@core/logs/log-service` 的 `AuditLogSource`（`AdminService` 自注册）、`@core/config/asset-hooks`（组合根注册 `@ops/assets/asset-hooks`）。模块间一律经对方 `public.ts`（`account/public.ts`、`social/public.ts` …）。登记表现存 5 条豁免，R1/R2 已清零并由 `module-boundary.test.ts` 固化。
- JSDoc on all classes/methods (design-spec §3); private fields prefixed `_`.
- Commit messages: conventional prefixes with Chinese descriptions, e.g. `feat(offline): 完全离线模式数据校验`.
- **技能（skills）**：可复用的任务级说明放 `skills/<name>/SKILL.md`（YAML frontmatter：`name` + `description`），项目根会被 harness 的技能发现扫描到；本机同时同步到 `~/.dsh/skills/`（用户级，跨项目可用）。现有：`arknights-mumu-frida-debug`（MuMu+frida 环境/管线/探针/诊断钩子）、`arknights-lua-plugin-contracts`（游戏 Lua 契约与 UI 自绘交互）、`arknights-lua-asset-signing`（Lua 资产签名与重签名交付）。

## Tests

- Vitest, globals on, node env. `tests/unit/**` mirrors `app/` layout（模块级单测放 `tests/unit/modules/<mod>/`，路由/manager 测试按原镜像路径）。**Do not add tests under `test/`** (`test/` is gitignored, `scripts/proxy-harness.ts` 是官服代理抓包 harness).
- Helpers in `tests/helpers/`: `mockPlayerData`, `mockExcel`, `mockEventBus`, `mocks` — use these instead of loading real excel/user data.
- **测试性能不变量（2026-09-13 实测）**：本仓在 WSL 的 9p/drvfs（`/mnt/d`）上，单次 `fs.readFileSync` 约 **36ms/文件**，因此耗时由「读盘次数」而非「断言数」决定：
  - 架构守卫（`tests/unit/architecture/**`）扫全树时必须经 `tests/helpers/fs-scan` 的 `readSource/readLines/collectFiles`（进程内缓存）。同一测试文件内把同一批源码读N遍，代价是线性叠加的：同窗口 A/B 实测 `excel-singleton-ratchet` 17.0s→1.1s（4 次扫描→1 次）、`decoupling` 15.2s→1.9s、`inventory-pipeline-ratchet` 4.8s→1.0s。
  - **每新增一个测试文件**都要重新加载整张 app 模块图（实测每个文件约 10~20s 的 worker 时间，而该文件的断言通常只需 1~50ms）。给已有模块加用例应优先并入既有文件，不要为每条小用例新建文件。
  - 详证与配置对比见 `docs/test-performance-2026-09-13.md`。

## Known constraints (documented in design-spec.md)

- Routes after `/campaignV2` in `app/game/app.ts` 404 on the real server (pre-existing issue).
- Non-practice battle HTTP chain is incomplete (battleStart lacks battleId) — settlement covered by unit tests instead.
- Social/friend data, user account configs (UserConfig), battle replays/infos and player saves live in the main data layer (`app/core/db/`). Default backend is SQLite `data/user/social.db` (runtime-generated, gitignored); MySQL/PostgreSQL are opt-in via `config.database` + `pnpm run db:migrate`. `users.json` is a first-run migration seed only.
- Docs of record: `docs/frida-mumu-lua-plugin-playbook-2026-09-14.md`（**本会话经验总纲/手册**：环境拓扑与三条交付链路（Lua VM 注入 / 资产内引导+私服 HTTP / 改 APK=死路）、**契约清单**（`x:Call(...)` 处必须传 Event 对象、自建 Overlay 画布、自绘点击拖拽、重载前先卸载、`Object.Destroy` 帧末生效）、**诊断套路**（`LuaException..ctor` 抓 Lua 错误文本、无眼 UI 验证：探针+真实 input+像素）、操作纪律与 RVA 速查；并索引全部专文与三个技能）、`docs/plugin-ui-verify-2026-09-14.md`（**插件浮窗验证 + 两个契约型致命 bug**：`UISender` 的 `onProceed` 与 `TimerModel` 的 `m_call` 都必须是 `Event` 对象（`:Call()`），传裸函数会抛 LuaException 并从游戏回调/定时器里逸出 → **整个客户端 abort**；`PluginUI.FindCanvas()` 改为自建 `ScreenSpaceOverlay` 画布（`sortingOrder=30000`）否则对象 active 却看不见；验收：探针 `btn_hier/root_hier=true rows=6` + 截屏扫 Toggle 蓝 `#4D99FF` 面板开 1e4 px / 关 5e2 px）、`docs/lua-asset-signature-2026-09-14.md`（**重加密 Lua 被拒的根因：128B 头是 `RSA-1024/PKCS#1 v1.5/MD5(script[128:])` 签名**，客户端用 `CryptUtils.VerifySignMD5RSA(byte[],byte[],string)`（RVA `0x042FD3F0`）+ `GlobalOptions.cryptoPubKey` 校验；判定链：官方公钥按**大端**读（用官服 network_config 真签名反证，指数 17）、344/344 头呈 PKCS#1 结构且摘要 == MD5(IV+密文)、换我们公钥 0/344 负对照、同 IV 重加密逐字节复现官方密文 344/344；新增 `signLuaScript`/`verifyLuaScriptSignature`/`parseDotNetPublicKeyXml`，重签名后 @我们公钥 344/344 ⇒ **改 Lua 资产的路重新打开**；待修：`data/crypto/public.xml` 的 Modulus 是**小端**写法（与官方大端相反）、hook 漏挂 byte[] 重载）、`docs/lua-plugin-frida-injection-2026-09-14.md`（**Lua 插件系统在官方包上跑起来**：frida 注入运行中的 Lua VM——显式选 `LuaEnv.DoString(String,String,LuaTable)` 重载 + 在 `_DoLoadEntryScript` 之后用 `_DoUpdate` onEnter 注入（不在 `_CustomLoader` 里重入 VM）+ payload 自带 12 个模块源码与 searcher；验收三条链：`ret='DTS_PLUGIN_OK enemy_hp=1 … network_redirect=1'`、设备 `frida_plugin_trace.txt`、私服 `[PluginHeartbeat] 5/5 ON` + `GET /plugin/heartbeat 200`）、`docs/il2cpp-dump-trace-2026-09-14.md`（**il2cpp 元数据 dump + 运行期 trace**：新增 `hook/il2cpp-dump-trace.ts` 与 `scripts/frida-mumu-arm64.py --script-mode dump|trace|both`；88 个 assembly / 49,370 类 / 53 MB 按 assembly 分文件落盘（走 libc 直写应用私有目录——桥的 `Il2Cpp.dump` 在 Android 上路径语义与写缓冲都不合用），Lua 引导链唯一调用树（`Awake → InitIfNot → _DoLoadEntryScript → _DoLoad → _CustomLoader ×344`）与关键方法 RVA 表）、`docs/dsh-tui-crash-2026-09-14.md`（TUI 意外崩溃排查：node 的 V8 `ud2` 中止证据链、内存/并发量化、管线**输出闸门**（`--max-output-bytes` 2MB/单行 2000 字符/单条日志 400 字符）与长会话操作纪律）、`docs/lua-load-chain-reconstructed-2026-09-14.md`（**从 AssetBundle 到 Lua 执行的加载链路还原**：C# 调用链/Lua 侧 hotfix 链/资产寻址与容器格式/CRYPTIC_A 解密，以及 C1/C2 对照实验定位出的「SF 构造器产出不被客户端接受」与 `funcVer` 门禁）、`docs/lua-mod-delivery-2026-09-14.md`（私服 mod 下发打通：客户端下载并登记 mod bundle 的**身份字段保留**修复、`get_latest_game_info` 门禁、WSL↔Windows 中继、重打包 bundle 加载即崩的证据与下一步）、`docs/frida-mumu-il2cpp-2026-09-13.md`（MuMu 上把 Frida 接进 ARM64 il2cpp：双 agent 管线、合成模块、日志钩子与踩坑记录）、`docs/fbs-crosscheck-2026-09-12.md`（schema 与 OpenArknightsFBS 交叉校验报告）、`docs/fbs-schema-repair-2026-09-12.md`（本轮修复：根因/改动/三口径证据/残余冻结表清单）、`design-spec.md` (architecture + mission/medal/battle/building/migration internals), `api.md` (protocol), `docs/module-audit-2026-08-29.md` (模块成熟度审计，含抓包/反编译/excel 证据), `docs/prts-wiki-实现评估-2026-09-09.md` (prts.wiki 对照的耦合量化 + 「与实际效果不符」实现清单 + P0/P1/P2 修复清单，含复核记录与可复跑脚本), `.trae/specs/` (feature specs, local).
