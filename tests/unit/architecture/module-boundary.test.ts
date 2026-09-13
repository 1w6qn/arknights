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

/** 显式豁免登记表（第一版违规裁决清单 2026-08-28）：存量越界引用逐条裁决并带 reason，新增越界必须走此表或重构 */
const EXEMPTIONS: { file: string; spec: string; reason: string }[] = [
  { file: "app/core/auth/auth.ts", spec: "@game/modules/account/AccountManager", reason: "技术债：core 鉴权直连账号服务（token/uid/密码），应抽象认证端口" },
  { file: "app/core/config/prod.ts", spec: "../../ops/assets/asset", reason: "技术债：core 配置联动 ops 资源热更/注册表" },
  { file: "app/core/config/prod.ts", spec: "@asset/asset-service", reason: "技术债：core 配置联动 ops 资源热更/注册表" },
  { file: "app/core/db/migrate.ts", spec: "@game/modules/account/AccountManager", reason: "技术债：首启迁移导入 UserConfig 账号配置类型" },
  { file: "app/core/db/replay-repo.ts", spec: "@game/kernel/battle-info-store", reason: "技术债：回放仓储依赖战斗信息类型" },
  { file: "app/core/db/user-repo.ts", spec: "@game/modules/account/AccountManager", reason: "技术债：用户仓储依赖账号类型" },
  { file: "app/core/logs/log-service.ts", spec: "../../ops/admin/AdminService", reason: "技术债：日志服务联动 admin 审计接口" },
  { file: "app/core/utils/crypt.ts", spec: "@game/kernel/battle-model", reason: "技术债：加密层引用战斗载荷类型" },
  { file: "app/core/utils/traffic-recorder.ts", spec: "@capture/capture-manager", reason: "技术债：抓包记录器依赖 ops capture 单例/端口" },
  { file: "app/core/utils/traffic-recorder.ts", spec: "@capture/capture-recorder", reason: "技术债：抓包记录器依赖 ops capture 单例/端口" },
  { file: "app/game/kernel/events/core.ts", spec: "../../modules/roguelike/rlv2-model", reason: "事件契约载荷类型引用模块模型（建议上移 kernel/shared 类型层）" },
  { file: "app/game/kernel/events/rlv2.ts", spec: "../../modules/roguelike/rlv2-model", reason: "事件契约载荷类型引用模块模型（建议上移 kernel/shared 类型层）" },
  { file: "app/game/kernel/http/auth-strategy.ts", spec: "../../modules/account/AccountManager", reason: "端口默认值绑定：RealAccountStrategy/createAuthStrategy 的 AuthAccountPort 缺省值取 accountManager 单例（可注入，见 design-spec §6.2.2）" },
  { file: "app/game/kernel/inventory.ts", spec: "../modules/activities/shared/unlockActivity", reason: "技术债：物品增减管道调用活动解锁逻辑（建议事件驱动）" },
  { file: "app/game/kernel/save-health.ts", spec: "../modules/character/char-skills", reason: "技术债：存档健康检查引用干员技能数据" },
  { file: "app/game/modules/account/AccountManager.ts", spec: "../battle/BattleStore", reason: "共享战斗存储/信息接口（回放/结算）" },
  { file: "app/game/modules/account/AccountManager.ts", spec: "../social/SocialService", reason: "共享社交服务（好友委托）" },
  { file: "app/game/modules/account/AccountManager.ts", spec: "../user/freshPlayer", reason: "共享新玩家初始化数据构建" },
  { file: "app/game/modules/battle/battle.ts", spec: "../account/AccountManager", reason: "共享账号服务（好友/uid/计数）——建议拆 account-data 门面" },
  { file: "app/game/modules/battle/battle.ts", spec: "../activities/act44side/informant", reason: "battle 引用活动族 informant 状态机" },
  { file: "app/game/modules/building/logic/accrue.ts", spec: "../../account/AccountManager", reason: "共享账号服务（好友/uid/计数）——建议拆 account-data 门面" },
  { file: "app/game/modules/building/logic/meeting.ts", spec: "../../account/AccountManager", reason: "共享账号服务（好友/uid/计数）——建议拆 account-data 门面" },
  { file: "app/game/modules/building/logic/misc.ts", spec: "../../account/AccountManager", reason: "共享账号服务（好友/uid/计数）——建议拆 account-data 门面" },
  { file: "app/game/modules/businessCard/businessCard.ts", spec: "../social/social-model", reason: "共享社交模型类型" },
  { file: "app/game/modules/character/char.ts", spec: "../gacha/gacha", reason: "共享卡池实现/列表" },
  { file: "app/game/modules/charm/routes.ts", spec: "../home/home", reason: "charm 读取 home 主界面数据" },
  { file: "app/game/modules/crisis/routes.ts", spec: "../pay/purchase-record", reason: "共享购买记录实现" },
  { file: "app/game/modules/gacha/logic.ts", spec: "../account/AccountManager", reason: "共享账号服务（好友/uid/计数）——建议拆 account-data 门面" },
  { file: "app/game/modules/roguelike/logic.ts", spec: "../character/troop", reason: "共享编队实现" },
  { file: "app/game/modules/roguelike/recruit.ts", spec: "../character/troop", reason: "共享编队实现" },
  { file: "app/game/modules/shop/logic/low-high.ts", spec: "../../gacha/gacha-up-list", reason: "共享卡池实现/列表" },
  { file: "app/game/modules/shop/logic/social.ts", spec: "../../pay/purchase-record", reason: "共享购买记录实现" },
  { file: "app/game/modules/social/SocialManager.ts", spec: "../account/AccountManager", reason: "共享账号服务（好友/uid/计数）——建议拆 account-data 门面" },
  { file: "app/game/modules/system/plugin-heartbeat.ts", spec: "@plugin/index", reason: "system 插件心跳是插件宿主入口，需直连 ops 插件注册表（端口化待做）" },
  { file: "app/game/modules/user/routes.ts", spec: "../account/user", reason: "user 路由引用 account 协议/校验（路由层耦合，需下沉）" },
  { file: "app/game/modules/user/routes.ts", spec: "../account/user.schema", reason: "user 路由引用 account 协议/校验（路由层耦合，需下沉）" },
];

/** 组合根：PlayerDataManager/player-composition 按架构显式组装各模块 manager，R2 豁免 */
const COMPOSITION_ROOTS = new Set([
  "app/game/kernel/PlayerDataManager.ts",
  "app/game/kernel/player-composition.ts",
]);

/** 活动路由聚合根：activities/index.ts 聚合各活动族 router，R3/R4 豁免 */
const AGGREGATION_ROOT = "app/game/modules/activities/index.ts";

/** R4 显式豁免：存量合理路由载体（不在约定命名内但确属路由文件），每条必须带 reason */
const R4_EXEMPTIONS: { file: string; reason: string }[] = [
  { file: "app/game/modules/activities/index.ts", reason: "活动路由聚合根（default 聚合 /activity 前缀 + rootRouter 根级路由），聚合中心即约定位置" },
  { file: "app/game/modules/system/plugin-heartbeat.ts", reason: "system 模块第二路由文件（插件心跳，独立 /plugin 前缀，与 routes.ts 的 audit 路由并存）" },
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
    // 约定路由文件：routes.ts / router.ts / *.routes.ts / *.router.ts / handler.ts（模块五文件约定的路由载体）。
    // 扫描范围仅限 app/game/——core/ops 的基础设施路由（网关/管理面板/资源服务）是服务入口，不受业务路由位置约束。
    const conventionRouteFile = /(^|\/)(routes|router|handler)\.ts$|\.(routes|router)\.ts$/;
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
        "../../account/AccountManager",
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
