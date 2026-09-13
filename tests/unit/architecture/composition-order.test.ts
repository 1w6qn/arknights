/**
 * 组合工厂构造顺序快照（构造顺序 = 事件订阅顺序 = 事件派发顺序）
 *
 * 全部子模块/子管理器在构造器内就地注册事件订阅（TypedEventEmitter 按注册序
 * 派发），组合工厂的 new 顺序即事件派发顺序——与 DDD 化重构前完全一致，
 * 任何重排都会改变 refresh:daily / items:get / rlv2:* 等事件的处理次序。
 * 本测试以源码扫描方式锁定顺序，防止未来"顺手整理"破坏行为。
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { readLines } from "../../helpers/fs-scan";

const APP_ROOT = path.resolve(__dirname, "../../../app");

/** 提取文件中匹配正则的行（trim 后），用于顺序断言 */
function collectMatchingLines(file: string, re: RegExp): string[] {
  return readLines(file)
    .filter((l) => re.test(l))
    .map((l) => l.trim().replace(/,$/, ""));
}

describe("组合工厂构造顺序快照（事件订阅顺序）", () => {
  it("player-composition 子模块构造顺序与基线一致（24 个，顺序即派发顺序）", () => {
    const file = path.join(
      APP_ROOT,
      "game",
      "kernel",
      "player-composition.ts",
    );
    expect(fs.existsSync(file)).toBe(true);
    const order = collectMatchingLines(file, /new \w+Manager\(pdm/);
    expect(order).toEqual([
      "status: new StatusManager(pdm, trigger)",
      "inventory: new InventoryManager(pdm, trigger)",
      "troop: new TroopManager(pdm, trigger)",
      "dungeon: new DungeonManager(pdm, trigger)",
      "home: new HomeManager(pdm, trigger)",
      "charRotation: new CharRotationManager(pdm, trigger)",
      "checkIn: new CheckInManager(pdm, trigger)",
      "storyreview: new StoryreviewManager(pdm, trigger)",
      "mission: new MissionManager(pdm, trigger)",
      "shop: new ShopManager(pdm, trigger)",
      "battle: new BattleManager(pdm, trigger)",
      "recruit: new RecruitManager(pdm, trigger)",
      "rlv2: new RoguelikeV2Manager(pdm, trigger)",
      "social: new SocialManager(pdm, trigger)",
      "gacha: new GachaManager(pdm, trigger)",
      "dexNav: new DexNavManager(pdm, trigger)",
      "building: new BuildingManager(pdm, trigger)",
      "openServer: new OpenServerManager(pdm, trigger)",
      "retro: new RetroManager(pdm, trigger)",
      "char: new CharManager(pdm, trigger)",
      "equipmentMission: new EquipmentMissionManager(pdm)",
      "medal: new MedalManager(pdm, trigger)",
      "aprilFool: new AprilFoolManager(pdm, trigger)",
      "bossRush: new BossRushManager(pdm, trigger)",
      "autoChess: new AutoChessManager(pdm, trigger)",
    ]);
  });

  it("rlv2-composition 子管理器构造顺序与基线一致（8 个，构造期互读兄弟字段）", () => {
    const file = path.join(
      APP_ROOT,
      "game",
      "modules",
      "roguelike",
      "rlv2-composition.ts",
    );
    expect(fs.existsSync(file)).toBe(true);
    const order = collectMatchingLines(file, /new Roguelike\w+Manager\(controller/);
    expect(order).toEqual([
      "troop: (controller.troop = new RoguelikeTroopManager(controller, trigger))",
      "status: (controller._status = new RoguelikePlayerStatusManager(controller, trigger))",
      "inventory: (controller.inventory = new RoguelikeInventoryManager(controller, trigger))",
      "buff: (controller._buff = new RoguelikeBuffManager(controller, trigger))",
      "map: (controller._map = new RoguelikeMapManager(controller, trigger))",
      "module: (controller._module = new RoguelikeModuleManager(controller, trigger))",
      "battle: (controller._battle = new RoguelikeBattleManager(controller, trigger))",
      "pool: (controller._pool = new RoguelikePoolManager(controller, trigger))",
    ]);
  });
});
