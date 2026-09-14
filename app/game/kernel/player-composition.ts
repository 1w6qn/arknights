/**
 * 玩家子模块组合（Player Composition Factory）
 *
 * 将 PlayerDataManager 构造器中「硬编码的 new 子模块 + 固定构造顺序」抽取为
 * 独立的、可覆写的组合工厂，作为依赖注入（DI）的组成根：
 * - `composePlayerChildModules` 按原顺序构造全部子模块，交由 PlayerDataManager 组装；
 * - `PlayerDataManager` 支持注入 `deps.modules`（部分覆写），测试可只替换个别模块
 *   而无需构造整棵子模块树（缩小门面测试面，见解耦方案角度 A）。
 *
 * 说明：子模块均无法在外部先于父构造完成而构建（它们需要 `this` 引用），
 * 故组合仍在父构造期执行，但「构造哪些、顺序如何」已从业务类剥离为可覆写策略。
 * 构造顺序即事件订阅顺序，必须与迁移前完全一致，以保证事件派发顺序不变。
 */
import type { PlayerDataManager } from "./player-data-manager";
import type { TypedEventEmitter } from "./events/runtime";

import { StatusManager } from "../modules/user/status";
import { InventoryManager } from "./inventory";
import { TroopManager } from "../modules/character/troop";
import { DungeonManager } from "../modules/dungeon/dungeon";
import { HomeManager } from "../modules/home/home-manager";
import { CharRotationManager } from "../modules/character/char-rotation-manager";
import { CheckInManager } from "../modules/checkin/checkin";
import { StoryreviewManager } from "../modules/storyreview/storyreview-manager";
import { MissionManager } from "../modules/mission/logic";
import { ShopManager } from "../modules/shop/logic";
import { BattleManager } from "../modules/battle/battle";
import { RecruitManager } from "../modules/gacha/recruit";
import { RoguelikeV2Manager } from "../modules/roguelike/logic";
import { SocialManager } from "../modules/social/social-manager";
import { GachaManager } from "../modules/gacha/logic";
import { DexNavManager } from "../modules/dexnav/dexnav";
import { BuildingManager } from "../modules/building/logic";
import { OpenServerManager } from "../modules/activities/checkin/openServer";
import { RetroManager } from "../modules/retro/retro-manager";
import { CharManager } from "../modules/character/char";
import { EquipmentMissionManager } from "../modules/equipmentMission/equipmentMission";
import { MedalManager } from "../modules/medal/medal";
import { AprilFoolManager } from "../modules/aprilFool/april-fool-manager";
import { BossRushManager } from "../modules/activities/bossRush/bossrush";
import { AutoChessManager } from "../modules/autochess/autochess";

/**
 * 玩家子模块集合（组合工厂返回值）
 *
 * 覆盖 PlayerDataManager 构造器中创建的全部子模块（不含 playerStatus/触发器/战斗存储，
 * 这三者由 PlayerDataManager 自身负责）。
 */
export interface PlayerChildModules {
  status: StatusManager;
  inventory: InventoryManager;
  troop: TroopManager;
  dungeon: DungeonManager;
  home: HomeManager;
  charRotation: CharRotationManager;
  checkIn: CheckInManager;
  storyreview: StoryreviewManager;
  mission: MissionManager;
  shop: ShopManager;
  battle: BattleManager;
  recruit: RecruitManager;
  rlv2: RoguelikeV2Manager;
  social: SocialManager;
  gacha: GachaManager;
  dexNav: DexNavManager;
  building: BuildingManager;
  openServer: OpenServerManager;
  retro: RetroManager;
  char: CharManager;
  equipmentMission: EquipmentMissionManager;
  medal: MedalManager;
  aprilFool: AprilFoolManager;
  bossRush: BossRushManager;
  autoChess: AutoChessManager;
}

/**
 * 组合玩家子模块（默认工厂）
 *
 * 按迁移前的原始构造顺序依次 new 出全部子模块并返回。
 * 每个子模块接收父玩家数据管理器 `pdm` 与事件触发器 `trigger`（equipmentMission 例外，仅收 pdm）。
 *
 * @param pdm - 玩家数据管理器（父）
 * @param trigger - 类型化事件触发器
 * @returns 全部子模块集合
 */
export function composePlayerChildModules(
  pdm: PlayerDataManager,
  trigger: TypedEventEmitter,
): PlayerChildModules {
  return {
    status: new StatusManager(pdm, trigger),
    inventory: new InventoryManager(pdm, trigger),
    troop: new TroopManager(pdm, trigger),
    dungeon: new DungeonManager(pdm, trigger),
    home: new HomeManager(pdm, trigger),
    charRotation: new CharRotationManager(pdm, trigger),
    checkIn: new CheckInManager(pdm, trigger),
    storyreview: new StoryreviewManager(pdm, trigger),
    mission: new MissionManager(pdm, trigger),
    shop: new ShopManager(pdm, trigger),
    battle: new BattleManager(pdm, trigger),
    recruit: new RecruitManager(pdm, trigger),
    rlv2: new RoguelikeV2Manager(pdm, trigger),
    social: new SocialManager(pdm, trigger),
    gacha: new GachaManager(pdm, trigger),
    dexNav: new DexNavManager(pdm, trigger),
    building: new BuildingManager(pdm, trigger),
    openServer: new OpenServerManager(pdm, trigger),
    retro: new RetroManager(pdm, trigger),
    char: new CharManager(pdm, trigger),
    equipmentMission: new EquipmentMissionManager(pdm),
    medal: new MedalManager(pdm, trigger),
    aprilFool: new AprilFoolManager(pdm, trigger),
    bossRush: new BossRushManager(pdm, trigger),
    autoChess: new AutoChessManager(pdm, trigger),
  };
}
