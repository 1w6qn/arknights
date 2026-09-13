/**
 * 架构解耦守卫测试（Architecture Guardrails）
 *
 * 对本次解耦改造的成果做静态扫描不变量的守护，防止回归：
 *  1. excel 层不得反向依赖 game 业务层（无 `from "@game/`）
 *  2. router 层不得直接依赖请求上下文实现（express-http-context2），
 *     访问玩家门面必须经 app/game/request-context 助手
 *  3. 抓包写入方（traffic-recorder，含已并入的原 reqres-log 定向记录）面向 CaptureRecorder
 *     端口写入，不得直接调用 captureManager.addRecord 落库
 *
 * 这是对改造点的持久证明：任何未来改动若重新引入反向/越界耦合，本测试将红灯。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { collectFiles, readLines } from "../../helpers/fs-scan";

/** app 根目录（相对本文件：tests/unit/architecture/ 上溯 3 级） */
const APP_ROOT = path.resolve(__dirname, "../../../app");

/**
 * 断言某文件不含匹配给定正则的代码行
 *
 * 逐行读取走 `tests/helpers/fs-scan` 的进程内缓存：本文件有 6 个用例扫描
 * `app/game` 全树（365 个文件），不缓存则同一批文件要被读 3 遍（实测本文件 45 秒）。
 * @param file - 文件绝对路径
 * @param re - 非法模式
 * @returns 命中非法模式的起始行（1 起）
 */
function firstOffendingLine(
  file: string,
  re: RegExp,
): number | null {
  const lines = readLines(file);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return null;
}

describe("架构解耦守卫", () => {
  it("excel 数据层不得反向依赖 game 业务层（excel → @game 计数为 0）", () => {
    const excelDir = path.join(APP_ROOT, "game", "excel");
    const offenders: string[] = [];
    for (const file of collectFiles(excelDir, ".ts")) {
      const line = firstOffendingLine(file, /from\s+["']@game\//);
      if (line !== null) {
        offenders.push(`${path.relative(APP_ROOT, file)}:${line} 引用了 @game`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("业务层(game)不得直连生成类型，须经 excel 防腐层(excel-types)", () => {
    // 生成的 @excel/types_excel_gen 是「不可手编入口」；业务层只能经 curated 防腐层取类型。
    const gameDir = path.join(APP_ROOT, "game");
    const offenders: string[] = [];
    for (const file of collectFiles(gameDir, ".ts")) {
      if (file.includes(path.join("game", "excel"))) continue; // excel 防腐层自身豁免
      const line = firstOffendingLine(
        file,
        /@excel\/types_excel_gen|\.\.\/(\.\.\/)*excel\/types_excel_gen/,
      );
      if (line !== null) {
        offenders.push(`${path.relative(APP_ROOT, file)}:${line} 直连生成类型（应经 @excel/excel）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("router 层不得直接依赖请求上下文实现（无 express-http-context2）", () => {
    const routerDir = path.join(APP_ROOT, "game", "modules");
    const offenders: string[] = [];
    for (const file of collectFiles(routerDir, ".ts")) {
      const line = firstOffendingLine(file, /express-http-context2/);
      if (line !== null) {
        offenders.push(`${path.relative(APP_ROOT, file)}:${line} 直接依赖 httpContext`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("抓包写入方须面向 CaptureRecorder 端口，不直接调用 captureManager.addRecord", () => {
    // reqres-log 已并入 traffic-recorder（include 定向记录 + parseReqresLogMode），文件已删除——守卫防回归
    const mergedAway = path.join(APP_ROOT, "game", "reqres-log.ts");
    expect(fs.existsSync(mergedAway)).toBe(false);
    const targets = [path.join(APP_ROOT, "core", "utils", "traffic-recorder.ts")];
    // 通过端口类型注入 recorder，而不是直接落库到具体单例
    expect(targets.every((f) => fs.existsSync(f))).toBe(true);
    for (const file of targets) {
      expect(
        firstOffendingLine(file, /captureManager\.addRecord/),
        `${path.relative(APP_ROOT, file)} 直接落库 captureManager（应改用 recorder.addRecord）`,
      ).toBeNull();
    }
  });

  it("PlayerDataManager 组合根须经 player-composition 工厂，不内联 new 子模块", () => {
    const pdmFile = path.join(APP_ROOT, "game", "kernel", "PlayerDataManager.ts");
    const factoryFile = path.join(APP_ROOT, "game", "kernel", "player-composition.ts");
    expect(fs.existsSync(factoryFile)).toBe(true);
    // 组合工厂必须存在且 PDM 引用它（子模块创建收敛到可覆写策略）
    expect(firstOffendingLine(pdmFile, /composePlayerChildModules/)).not.toBeNull();

    // PDM 构造器不应再内联 new 这些子模块（应收敛到 player-composition.ts）
    const line = firstOffendingLine(
      pdmFile,
      /new (StatusManager|InventoryManager|TroopManager|DungeonManager|HomeManager|CharRotationManager|CheckInManager|StoryreviewManager|MissionManager|ShopManager|BattleManager|RecruitManager|RoguelikeV2Manager|SocialManager|GachaManager|DexNavManager|BuildingManager|OpenServerManager|RetroManager|CharManager|EquipmentMissionManager|MedalManager|AprilFoolManager|BossRushManager)\(/,
    );
    expect(line, `PlayerDataManager.ts:${line} 内联 new 子模块（应移入 player-composition.ts）`).toBeNull();
  });

  it("rlv2 控制器组合须经 rlv2-composition 工厂，不内联 new 子模块", () => {
    const rlv2File = path.join(APP_ROOT, "game", "modules", "roguelike", "logic.ts");
    const factoryFile = path.join(APP_ROOT, "game", "modules", "roguelike", "rlv2-composition.ts");
    expect(fs.existsSync(factoryFile)).toBe(true);
    // 组合工厂必须存在且 rlv2 控制器引用它
    expect(firstOffendingLine(rlv2File, /composeRlv2ChildModules/)).not.toBeNull();
    // rlv2 构造器不应再内联 new 这些子管理器（应收敛到 rlv2-composition.ts）
    const line = firstOffendingLine(
      rlv2File,
      /new (RoguelikeTroopManager|RoguelikePlayerStatusManager|RoguelikeInventoryManager|RoguelikeBuffManager|RoguelikeMapManager|RoguelikeModuleManager|RoguelikeBattleManager|RoguelikePoolManager)\(/,
    );
    expect(line, `rlv2.ts:${line} 内联 new 子模块（应移入 rlv2-composition.ts）`).toBeNull();
  });

  it("rlv2 主题模块分发表须经 rlv2-module-composition，module.ts 不直连 modules/*", () => {
    const moduleFile = path.join(APP_ROOT, "game", "modules", "roguelike", "module.ts");
    const factoryFile = path.join(APP_ROOT, "game", "modules", "roguelike", "rlv2-module-composition.ts");
    expect(fs.existsSync(factoryFile)).toBe(true);
    // module.ts 应消费组合工厂，而不是直接 import 各主题模块实现
    expect(firstOffendingLine(moduleFile, /composeRlv2ThemeModules/)).not.toBeNull();
    const line = firstOffendingLine(moduleFile, /from "\.\/modules\//);
    expect(line, `module.ts:${line} 直连主题模块（应经 rlv2-module-composition）`).toBeNull();
  });

  it("controller 层已移除：app/game/controller 目录不存在且无 @game/controller 引用", () => {
    const controllerDir = path.join(APP_ROOT, "game", "controller");
    expect(fs.existsSync(controllerDir)).toBe(false);
    const gameDir = path.join(APP_ROOT, "game");
    const offenders: string[] = [];
    for (const file of collectFiles(gameDir, ".ts")) {
      const line = firstOffendingLine(file, /@game\/controller\/|game\/controller\//);
      if (line !== null) {
        offenders.push(`${path.relative(APP_ROOT, file)}:${line} 引用已移除的 controller 层（应指向 @game/modules/*）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("旧 domain/service 分层已移除：game 业务代码收敛为 kernel + modules 特性切片", () => {
    const domainDir = path.join(APP_ROOT, "game", "domain");
    const serviceDir = path.join(APP_ROOT, "game", "service");
    expect(fs.existsSync(domainDir)).toBe(false);
    expect(fs.existsSync(serviceDir)).toBe(false);
    const gameDir = path.join(APP_ROOT, "game");
    const offenders: string[] = [];
    for (const file of collectFiles(gameDir, ".ts")) {
      const line = firstOffendingLine(
        file,
        /(?:from|import\()\s*["'][^"']*(?:@game\/(domain|service)|game\/(domain|service))/,
      );
      if (line !== null) {
        offenders.push(`${path.relative(APP_ROOT, file)}:${line} 引用已移除的 domain/service 分层（应指向 @game/kernel/* 或 @game/modules/*）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // 说明（2026-09-13 精简）：此处原有两条「domain 层不得依赖 service 路由/适配面」「domain 纯领域
  // 不得引用根基础设施」用例，均在 `app/game/domain` 下扫描。该目录已随分层重构删除，`collectFiles`
  // 恒返回空数组 → 两条用例的 `expect(offenders).toEqual([])` 永远成立（零覆盖的真空断言）。
  // domain/service 层已不存在这一点由上面那条用例（`existsSync` 为 false + 全树无引用）覆盖，
  // 故删除这两条空转用例，不损失任何检查能力。

  it("admin 层不得依赖 game 的 router 层（admin → @game/router 计数为 0）", () => {
    const adminDir = path.join(APP_ROOT, "ops", "admin");
    const offenders: string[] = [];
    for (const file of collectFiles(adminDir, ".ts")) {
      const line = firstOffendingLine(
        file,
        /from\s+["'](@game\/router\/|\.\.\/.*\/router\/|\.\.\/game\/router\/)/,
      );
      if (line !== null) {
        offenders.push(`${path.relative(APP_ROOT, file)}:${line} 依赖 game router 层`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("admin 运行期 game 取值须经 game-gateway 网关（设计外直连可拦截）", () => {
    const adminDir = path.join(APP_ROOT, "ops", "admin");
    // admin 对 game 的「值」依赖边界：AccountManager/mail/maxout/model-gacha/crisis-seasons/pay-store/unlockActivity
    // 只能由 game-gateway.ts 聚合，其余 admin 文件不得直连；`import type` 不受限（无运行期耦合）。
    const gameValueModules =
      /from\s+["'](@game\/service\/manager\/AccountManager|@game\/service\/manager\/mail|@game\/domain\/util\/maxout|@game\/domain\/gacha|@game\/service\/shared\/crisis-seasons|@game\/service\/shared\/pay-store|@game\/service\/manager\/activity\/unlockActivity)/;
    const offenders: string[] = [];
    for (const file of collectFiles(adminDir, ".ts")) {
      if (path.basename(file) === "game-gateway.ts") continue;
      const lines = readLines(file);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith("import type")) continue;
        if (gameValueModules.test(lines[i])) {
          offenders.push(`${path.relative(APP_ROOT, file)}:${i + 1} 直连 game 取值（应经 game-gateway）`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});