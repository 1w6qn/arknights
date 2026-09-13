/**
 * 核心领域事件映射（Core）
 *
 * 集中定义跨模块的生命周期、运行时与共享交易事件：
 * - 生命周期：save / 刷新 / 登录
 * - 对象变更：角色、物品、玩家、基建、背景、家园、招募
 * - 战斗生命周期：开始 / 结束 / 完成
 * - 共享交易事件：通关、制造、商店、抽卡等，被 mission / medal 模板共同订阅
 *
 * 拆分为独立领域文件，避免所有事件挤在一个全局文件中，
 * 新增/修改事件只触及对应领域文件即可。
 */
import type { ItemBundle } from "@excel/excel";
import type { GachaResult } from "../model";
import type {
  BattleData,
  CommonStartBattleRequest,
} from "../battle-model";
import type { PlayerCharacter, SquadFriendData } from "../model";
import type { PlayerRoguelikeV2 } from "../rlv2-model";

/**
 * 核心事件映射
 *
 * 键为事件名称，值为事件参数数组（沿用全局 EventMap 的协变声明）。
 */
export type EventMapCore = {
  /** 保存事件 - 触发数据持久化 */
  save: [];
  /** 游戏修复事件 - 触发游戏数据修复 */
  "game:fix": [];
  /** 状态时间刷新事件 - 刷新时间相关状态 */
  "status:refresh:time": [];
  /** 月度刷新事件 - 触发月度数据刷新 */
  "refresh:monthly": [];
  /** 周度刷新事件 - 触发周度数据刷新 */
  "refresh:weekly": [];
  /** 每日刷新事件 - 触发每日数据刷新 */
  "refresh:daily": [number];
  /** 关卡更新事件 - 关卡进度更新 */
  "stage:update": [];
  /** 角色获取事件 - 获取新角色（from 标记来源，extraItem 如限定池 LMTGSID 凭证） */
  "char:get": [string, { from: string; extraItem?: ItemBundle }?, ((res: GachaResult) => void)?];
  /** 干员升级事件 - 干员等级提升 */
  "char:levelUp": [{ charId: string; level: number }];
  /** 干员精英化事件 - 干员精英化 */
  "char:evolve": [{ charId: string; phase: number }];
  /** 干员技能升级事件 - 干员技能升级 */
  "char:skillUp": [{ charId: string; skillIndex: number; level: number }];
  /** 干员潜能提升事件 - 干员潜能提升 */
  "char:potential": [{ charId: string; potential: number }];
  /** 角色初始化事件 - 新角色初始化 */
  "char:init": [PlayerCharacter];
  /** 物品使用事件 - 消耗物品 */
  "items:use": [ItemBundle[]];
  /** 物品获取事件 - 获得物品 */
  "items:get": [ItemBundle[]];
  /** 获得物品事件 - 获得物品 */
  "item:get": [{ items: ItemBundle[] }];
  /** 使用物品事件 - 使用物品 */
  "item:use": [{ items: ItemBundle[] }];
  /** 玩家等级提升事件 - 玩家等级提升 */
  "player:levelUp": [{ level: number }];
  /** 玩家登录事件 - 玩家登录 */
  "player:login": [{ playerId: string }];
  // 说明（2026-09-09，审计 §6.3-27）：「building:char:init」自建仓起就**从未有 emit 方**
  // （git log -S 'emit("building:char:init"' 为空），而干员模块获取新干员时 emit 的是
  // 「char:init」（payload 同为 [PlayerCharacter]）→ 基建侧 `_onCharInit` 永不执行、
  // 新获得干员在 `building.chars` 无建档（心情/私人宿舍/进驻状态缺失）。
  // 契约已合并到 "char:init"，此处删除死契约以免再次误订阅。
  /** 战斗保存事件 - 保存战斗信息 */
  "save:battle": [string, { stageId: string; isPractice: number }];
  /** 战斗开始事件 - 开始战斗 */
  "battle:start": [CommonStartBattleRequest];
  /** 战斗结束事件 - 战斗完成（回调可选，用于回传结算结果） */
  "battle:finish": [
    {
      data: string;
      battleData: { isCheat: string; completeTime: number };
    },
    ((res: unknown) => void)?,
  ];
  /** 战斗完成事件 - 战斗完成 */
  "battle:complete": [{ stageId: string; result: string }];
  /** 背景获取事件 - 获取背景 */
  "background:get": [string];
  /** 背景解锁事件 - 解锁背景 */
  "background:unlock": [{ bgID: string }];
  /** 背景条件更新事件 - 更新背景解锁条件 */
  "background:condition:update": [string, string, number];
  /** 家园主题获取事件 - 获取家园主题 */
  "homeTheme:get": [string];
  /** 家园主题条件更新事件 - 更新家园主题条件 */
  "homeTheme:condition:update": [
    {
      themeId: string;
      conditionId: string;
      target: number;
    },
  ];
  /** 家园主题解锁事件 - 解锁家园主题 */
  "homeTheme:unlock": [{ themeId: string }];
  /** 招募标签刷新事件 - 刷新招募标签 */
  "recruit:refresh:tags": [{ slotId: number }];
  /** 开服活动登录事件 - 开服活动登录奖励 */
  "openserver:chain:login": [number];

  // ============ 共享交易 / 领域事件（被 mission / medal 模板共同订阅） ============
  /** 完成任意类型关卡 */
  CompleteStageAnyType: [BattleData];
  /** 关卡击杀敌人 */
  StageWithEnemyKill: [BattleData & { stageId: string }];
  /** 任意关卡击杀敌人 */
  EnemyKillInAnyStage: [BattleData];
  /** 使用助战角色通关（assistFriend 为 battleStart 快照的助战好友，未助战为 null） */
  StageWithAssistChar: [BattleData & { assistFriend: null | SquadFriendData }];
  /** 升级角色 */
  UpgradeChar: [{ char: PlayerCharacter; exp: number }];
  /** 获得社交点数 */
  ReceiveSocialPoint: [{ socialPoint: number }];
  /** 购买商店物品 */
  BuyShopItem: [{ type: string; socialPoint: number }];
  /** 普通抽卡 */
  NormalGacha: [];
  /** 获得信赖度 */
  GainIntimacy: [{ count: number }];
  /** 制造物品 */
  ManufactureItem: [{ item: ItemBundle; count: number }];
  /** 交付订单 */
  DeliveryOrder: [{ count: number }];
  /** 恢复角色理智 */
  RecoverCharBaseAp: [{ count: number }];
  /** 访问基建 */
  VisitBuilding: [];
  /** 升级技能 */
  UpgradeSkill: [{ targetLevel: number }];
  /** 编队 */
  SquadFormation: [];
  /** 完成关卡 */
  CompleteStage: [BattleData & { stageId: string; isPractice: number }];
  /** 升级玩家 */
  UpgradePlayer: [{ level: number }];
  /** 完成任意关卡 */
  CompleteAnyStage: [BattleData & { stageId: string }];
  /** 拥有角色 */
  HasChar: [{ char: PlayerCharacter }];
  /** 拥有装备 */
  HasEquipment: [{ char: PlayerCharacter }];
  /** 精二角色 */
  EvolveChar: [{ char: PlayerCharacter }];
  /** 舒适度DIY */
  DiyComfort: [{ comfort: number }];
  /** 拥有房间 */
  HasRoom: [{ roomCount: number }];
  /** 工坊合成 */
  WorkshopSynthesis: [{ item: ItemBundle }];
  /** 专精升级 */
  UpgradeSpecialization: [{ targetLevel: number }];
  /** 战斗击杀敌人 */
  BattleWithEnemyKill: [BattleData & { stageId: string }];
  /** 角色信赖度 */
  CharIntimacy: [{ favorPoint: number }];
  /** 完成突破奖励 */
  CompleteBreakReward: [];
  /** 开启信息分享 */
  StartInfoShare: [];
  /** 编辑名片 */
  EditBusinessCard: [];
  /** 设置助战角色列表 */
  SetAssistCharList: [];
  /** 更改队伍名称 */
  ChangeSquadName: [];
  /** 关卡回放 */
  StageWithReplay: [{ isReplay: number }];
  /** 接管回放 */
  TakeOverReplay: [BattleData];
  /** 完成活动关卡 */
  CompleteCampaign: [BattleData & { stageId: string }];
  /** 设置基建助手 */
  SetBuildingAssist: [];
  /** 潜能提升 */
  BoostPotential: [{ targetLevel: number }];
  /** 工坊额外加成 */
  WorkshopExBonus: [];
  /** 普通抽卡提升 */
  BoostNormalGacha: [];
  /** 完成主线关卡 */
  CompleteMainStage: [BattleData & { stageId: string }];
  /** 发送线索 */
  SendClue: [];
  /**
   * 势力全员收集达成（guide_43/guide_48，模板 GainTeamChar）
   *
   * 修复（2026-09-09，S2）：原为空载荷且全仓无 emit 站点 → 两个引导任务永久卡死。
   * 载荷 teamId 供排查（模板仅计数）。
   */
  GainTeamChar: [{ teamId?: string }];
  /** 加速订单 */
  AccelerateOrder: [];
  /** 消耗理智 */
  CostAp: [{ ap: number }];
  /** 肉鸽V2结算游戏 */
  Rlv2SettleGame: [{ data: PlayerRoguelikeV2 }];
  /** 肉鸽V2结算游戏次数 */
  Rlv2SettleGameTimes: [];

  // 日志相关事件
  /** 事件日志事件 - 记录事件日志 */
  "log:event": [{ eventName: string; timestamp: number }];
};