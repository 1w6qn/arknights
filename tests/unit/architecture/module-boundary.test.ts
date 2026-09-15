/**
 * 模块边界守卫（特性切片架构不变量）
 *
 * R1 core 不依赖 game/ops；R2 kernel/excel 不依赖 modules（组合根 PlayerDataManager/player-composition 豁免）；
 * R3 模块间仅可 import 对方 public.ts（activities 族对 shared、activities/index.ts 聚合根豁免）；
 * R4 路由文件仅允许约定位置。检查器为纯函数，附负样本自证有效性。
 *
 * 豁免登记表 EXEMPTIONS = 第一版违规裁决清单（2026-08-28）：存量越界引用逐条裁决并带 reason，
 * 守卫真实生效后任何新增越界引用将直接红。裁决明细与重构建议见 docs/architecture-coupling-adjudication.md。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { collectFiles, readSource } from "../../helpers/fs-scan";


const APP_ROOT = path.resolve(__dirname, "../../../app");
const ALIASES: Record<string, string> = {
  "@game": "app/game", "@excel": "app/game/excel", "@utils": "app/core/utils",
  "@capture": "app/ops/capture", "@logs": "app/core/logs", "@plugin": "app/ops/plugin",
  "@asset": "app/ops/assets/asset-registry", "@core": "app/core", "@ops": "app/ops",
};

/** 提取一个 TS 源文件的全部 import 说明符（含动态 import 与 type import） */
export function extractSpecs(src: string): string[] {
  const specs: string[] = [];
  for (const re of [/from\s*['"]([^'"]+)['"]/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of src.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

/** 说明符 → 仓库相对路径（无扩展名；无法解析的相对路径返回 null） */
export function resolveSpec(spec: string, fromRepoRel: string): string | null {
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (spec === alias) return target;
    if (spec.startsWith(alias + "/")) return `${target}/${spec.slice(alias.length + 1)}`;
  }
  if (!spec.startsWith(".")) return null;
  const dir = path.posix.dirname(fromRepoRel);
  return path.posix.normalize(path.posix.join(dir, spec));
}

export interface Violation { rule: string; file: string; spec: string }

/**
 * 显式豁免登记表（第一版违规裁决清单 2026-08-28；2026-09-13 收敛至 5 条）
 *
 * 现存豁免仅为**不属 kernel 提取范畴**的残余项：4 条 R3（battle→act44side、
 * charm→home、user/routes→account 协议 ×2，处置为门面/事件/落位修正）+
 * 2 条 modules→ops（system/plugin.routes，需插件宿主端口）。
 * R1（core→game/ops）与 R2（kernel→modules）已全部清零，并由下方用例固化——
 * 新增越界引用必须走此表并说明理由。
 */
const EXEMPTIONS: { file: string; spec: string; reason: string }[] = [
  { file: "app/game/modules/battle/battle.ts", spec: "../activities/act44side/informant", reason: "battle 引用活动族 informant 状态机" },
  { file: "app/game/modules/charm/routes.ts", spec: "../home/home", reason: "charm 读取 home 主界面数据" },
  { file: "app/game/modules/system/plugin.routes.ts", spec: "@plugin/index", reason: "system 插件心跳是插件宿主入口，需直连 ops 插件注册表（端口化待做）" },
  { file: "app/game/modules/system/plugin.routes.ts", spec: "@plugin/lua-chunk-builder", reason: "同上：GET /plugin/lua 直接复用 ops 的插件 chunk 打包器（端口化待做）" },
  { file: "app/game/modules/user/routes.ts", spec: "../account/user", reason: "user 路由引用 account 协议/校验（路由层耦合，需下沉）" },
  { file: "app/game/modules/user/routes.ts", spec: "../account/user.schema", reason: "user 路由引用 account 协议/校验（路由层耦合，需下沉）" },
];

/** 组合根：PlayerDataManager/player-composition 按架构显式组装各模块 manager，R2 豁免 */
const COMPOSITION_ROOTS = new Set([
  "app/game/kernel/player-data-manager.ts",
  "app/game/kernel/player-composition.ts",
]);

/** 活动路由聚合根：activities/index.ts 聚合各活动族 router，R3/R4 豁免 */
const AGGREGATION_ROOT = "app/game/modules/activities/index.ts";

/** R4 显式豁免：存量合理路由载体（不在约定命名内但确属路由文件），每条必须带 reason */
const R4_EXEMPTIONS: { file: string; reason: string }[] = [
  { file: "app/game/modules/activities/index.ts", reason: "活动路由聚合根（default 聚合 /activity 前缀 + rootRouter 根级路由），聚合中心即约定位置" },
  // 2026-09-14 命名统一：原 system/plugin-heartbeat.ts 已改名 system/plugin.routes.ts，
  // 符合 `*.routes.ts` 约定，该条豁免随之删除。
];

/** 边界规则检查器（纯函数，供全量扫描与负样本共用） */
export function checkImport(fileRepoRel: string, spec: string): Violation | null {
  if (EXEMPTIONS.some((e) => e.file === fileRepoRel && e.spec === spec)) return null;
  const target = resolveSpec(spec, fileRepoRel);
  if (!target) return null;
  const t = target.replace(/\.ts$/, "");
  const inCore = fileRepoRel.startsWith("app/core/");
  const inKernel = (fileRepoRel.startsWith("app/game/kernel/") || fileRepoRel.startsWith("app/game/excel/")) && !COMPOSITION_ROOTS.has(fileRepoRel);
  const modOf = (p: string) => p.match(/^app\/game\/modules\/(activities\/[^/]+|[^/]+)\//)?.[1] ?? null;
  const srcMod = modOf(fileRepoRel);

  if (inCore && (t.startsWith("app/game/") || t.startsWith("app/ops/")))
    return { rule: "R1 core 不得依赖 game/ops", file: fileRepoRel, spec };
  if (inKernel && t.startsWith("app/game/modules/"))
    return { rule: "R2 kernel/excel 不得依赖 modules", file: fileRepoRel, spec };
  // R5（2026-09-13）：分层单向——game 不得反向依赖 ops（唯一历史违规 arkhub/arkpixel →
  // @ops/admin/arkhub-pixel 已由像素格式下沉消除）。ops 依赖 game 仍合法（须走 public）。
  if (fileRepoRel.startsWith("app/game/") && t.startsWith("app/ops/"))
    return { rule: "R5 game 不得依赖 ops", file: fileRepoRel, spec };
  if (srcMod && fileRepoRel !== AGGREGATION_ROOT) {
    const dstMod = modOf(t);
    if (dstMod && dstMod !== srcMod) {
      // 收紧（2026-09-09，对应审计 §6.3-26）：原实现对**任何** activities/* 源文件整体豁免
      // （srcMod.startsWith("activities/")），使活动族可以任意直连其它模块内部文件而不被
      // 守卫发现。现仅保留「activities/shared 为活动族共享实现」这一条合理豁免，
      // 其余跨模块（含跨活动族）一律要求 public.ts 门面。
      const sharedOk = dstMod === "activities/shared";
      if (!sharedOk && !t.endsWith("public"))
        return { rule: "R3 跨模块仅可 import public.ts", file: fileRepoRel, spec };
    }
  }
  return null;
}

/** arkhub 模块门面（R6：模块外只经 public 消费） */
const ARKHUB_PREFIX = "app/game/modules/activities/arkhub/";

/**
 * R6：arkhub 模块外的引用必须落在 `activities/arkhub/public`
 *
 * 覆盖 app/ops、scripts、tests（app/game 内部自引用不受此规则约束，由 R3 管跨模块）。
 * 模块外的**相对路径**引用同样拦截（resolveSpec 统一解析后判定）。
 *
 * @param fileRepoRel 引用方仓库相对路径
 * @param spec import 说明符
 * @returns 违规项；不涉及 arkhub 或落在 public 时返回 null
 */
export function checkArkhubFacade(fileRepoRel: string, spec: string): Violation | null {
  if (fileRepoRel.startsWith(ARKHUB_PREFIX)) return null; // 模块内自引用
  const target = resolveSpec(spec, fileRepoRel);
  if (!target) return null;
  const t = target.replace(/\.ts$/, "");
  if (!t.startsWith(ARKHUB_PREFIX)) return null;
  if (t === `${ARKHUB_PREFIX}public`) return null;
  return { rule: "R6 arkhub 模块外仅可 import public 门面", file: fileRepoRel, spec };
}

describe("模块边界守卫", () => {
  // 只收 `.ts`（与原实现一致）：app/ 下另有 dashboard 的 svg/html/webmanifest，
  // 它们不是模块图的一部分，纳入扫描只会引入误读。
  const allFiles = [
    ...collectFiles(path.join(APP_ROOT, "core"), ".ts"),
    ...collectFiles(path.join(APP_ROOT, "game"), ".ts"),
    ...collectFiles(path.join(APP_ROOT, "ops"), ".ts"),
  ];

  it("R1-R3：全量扫描无非法规界 import", () => {
    const violations: Violation[] = [];
    for (const f of allFiles) {
      // ????????? app/ ????checkImport/modOf ????????
      const rel = path.relative(path.resolve(APP_ROOT, ".."), f).replace(/\\/g, "/");
      for (const spec of extractSpecs(readSource(f))) {
        const v = checkImport(rel, spec);
        if (v) violations.push(v);
      }
    }
    expect(violations).toEqual([]);
  });

  it("R4：Express Router 只允许在约定路由文件中创建", () => {
    // 约定路由文件（2026-09-14 命名统一后只剩两种）：`routes.ts`（模块/活动族主载体）
    // 与 `<域>.routes.ts`（同一模块的第二个路由文件，如 charRotation/mailCollection/rlv2/plugin）。
    // 原 `router.ts` / `handler.ts` 已全部改名，不再接受。
    // 扫描范围仅限 app/game/——core/ops 的基础设施路由（网关/管理面板/资源服务）是服务入口，不受业务路由位置约束。
    const conventionRouteFile = /(^|\/)routes\.ts$|\.routes\.ts$/;
    const offenders = allFiles.filter((f) => {
      // ????????? app/ ????checkImport/modOf ????????
      const rel = path.relative(path.resolve(APP_ROOT, ".."), f).replace(/\\/g, "/");
      if (!rel.startsWith("app/game/")) return false;
      if (rel === "game/routes.ts" || rel === "game/app.ts") return false;
      if (R4_EXEMPTIONS.some((e) => e.file === rel)) return false;
      if (conventionRouteFile.test(rel)) return false;
      return /express\.Router\(\)|\bRouter\(\)\s*;/.test(readSource(f));
    });
    expect(offenders).toEqual([]);
  });

  it("R2：kernel/excel 不得保留 modules 反向依赖豁免（2026-09-13 清零后固化）", () => {
    const r2 = EXEMPTIONS.filter((e) => {
      const inKernel =
        (e.file.startsWith("app/game/kernel/") || e.file.startsWith("app/game/excel/")) &&
        !COMPOSITION_ROOTS.has(e.file);
      const target = resolveSpec(e.spec, e.file);
      return inKernel && !!target && target.startsWith("app/game/modules/");
    });
    expect(
      r2,
      `kernel/excel 不得再豁免 modules 反向依赖（应改为 kernel 端口/类型或公共件上移）：\n  ${r2
        .map((e) => `${e.file} → ${e.spec}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });

  it("R2：组合根白名单固定为 2 个文件（防止扩表）", () => {
    expect([...COMPOSITION_ROOTS].sort()).toEqual([
      "app/game/kernel/player-composition.ts",
      "app/game/kernel/player-data-manager.ts",
    ]);
  });

  it("R6：ops/scripts/tests 引用 arkhub 必须经 public 门面", () => {
    const repoRoot = path.resolve(APP_ROOT, "..");
    const files = [
      ...collectFiles(path.join(APP_ROOT, "ops"), ".ts"),
      ...collectFiles(path.join(repoRoot, "scripts"), ".ts"),
      ...collectFiles(path.join(repoRoot, "tests"), ".ts"),
    ];
    const violations: Violation[] = [];
    for (const f of files) {
      const rel = path.relative(repoRoot, f).replace(/\\/g, "/");
      for (const spec of extractSpecs(readSource(f))) {
        const v = checkArkhubFacade(rel, spec);
        if (v) violations.push(v);
      }
    }
    expect(violations).toEqual([]);
  });

  it("负样本：R5/R6 检查器能识别反向依赖与子路径越门面", () => {
    expect(
      checkImport("app/game/modules/activities/arkhub/domain/pixel", "@ops/admin/arkhub-pixel"),
    ).toMatchObject({ rule: /^R5/ });
    expect(
      checkArkhubFacade("app/ops/admin/arkhub-pets", "@game/modules/activities/arkhub/domain/dex"),
    ).toMatchObject({ rule: /^R6/ });
    expect(
      checkArkhubFacade("app/ops/admin/arkhub-pets", "@game/modules/activities/arkhub/public"),
    ).toBeNull();
    // 模块内自引用不受 R6 约束
    expect(
      checkArkhubFacade("app/game/modules/activities/arkhub/session/server", "./handlers/hub"),
    ).toBeNull();
    // 非 arkhub 模块不受 R6 影响
    expect(checkArkhubFacade("app/ops/admin/x", "@game/modules/gacha/logic")).toBeNull();
  });

  it("负样本：检查器能检出越界 import（自证有效性）", () => {
    expect(checkImport("app/core/config/gate", "@game/modules/gacha/public")).toMatchObject({ rule: /^R1/ });
    expect(checkImport("app/game/kernel/model", "@game/modules/gacha/public")).toMatchObject({ rule: /^R2/ });
    expect(checkImport("app/game/modules/gacha/manager", "@game/modules/shop/manager")).toMatchObject({ rule: /^R3/ });
    expect(checkImport("app/game/modules/gacha/manager", "@game/modules/shop/public")).toBeNull();
    // 收紧后（2026-09-09，审计 §6.3-26）：活动族不再整体豁免 ——
    // 跨活动族/跨模块的**内部文件**引用须报错，public.ts 门面与 activities/shared 仍放行。
    expect(
      checkImport(
        "app/game/modules/activities/milestone/logic",
        "../act44side/informant",
      ),
    ).toMatchObject({ rule: /^R3/ });
    expect(
      checkImport(
        "app/game/modules/activities/milestone/logic",
        "../act44side/public",
      ),
    ).toBeNull();
    expect(
      checkImport(
        "app/game/modules/activities/bossRush/bossrush",
        "../../account/account-manager",
      ),
    ).toMatchObject({ rule: /^R3/ });
    expect(
      checkImport(
        "app/game/modules/activities/bossRush/bossrush",
        "../../account/public",
      ),
    ).toBeNull();
    // activities/shared 为活动族共享实现，仍豁免
    expect(
      checkImport(
        "app/game/modules/activities/milestone/logic",
        "../shared/shared",
      ),
    ).toBeNull();
  });
});
