/**
 * 勋章领域事件映射（Medal）
 *
 * 集中定义勋章系统的领域事件：
 * - 勋章生命周期：完成 / 解锁 / 奖励领取
 * - 勋章追踪模板事件（template 语义的事件名），由各玩法动作 emit，
 *   MedalManager 的勋章模板按 template 名订阅
 */
import type { PlayerDataManager } from "../player-data-manager";
import type { PlayerCharacter } from "../model";

/**
 * 战斗统计载荷（勋章追踪共用）
 *
 * 由 battle 结算统一携带：通关状态 + 当关敌人击杀计数 + 场外 token 计数，
 * 供 PassStage 系列（PassStageKilled 等）模板按 unlockParam 过滤判定。
 */
export interface PassStageStats {
  stageId: string;
  completeState: number;
  enemyStats?: {
    Key: { enemyId: string; counterType: string };
    Value: number;
  }[];
  /** extraBattleInfo：token 名 → 计数/取值（如 pirene_hp_full、killed_by_nstree） */
  extraBattleInfo?: Record<string, unknown>;
}

/**
 * 勋章领域事件映射
 */
export type EventMapMedal = {
  /** 勋章完成事件 */
  "medal:complete": [{ medalId: string }];
  /** 勋章解锁事件 */
  "medal:unlock": [{ medalId: string }];
  /** 勋章奖励领取事件 */
  "medal:reward": [{ medalId: string }];

  /** 玩家等级提升（勋章追踪） */
  PlayerLevel: [{ level: number }];
  /** 加入游戏天数（勋章追踪） */
  JoinGameDays: [{ registerTs: number }];
  /** 角色数量（勋章追踪） */
  CharNum: [{ curCharInstId: number }];
  /** 招募次数（勋章追踪） */
  RecruitCount: [];
  /** 关卡完成情况（勋章追踪） */
  PassStageSome: [PlayerDataManager];
  /** 任务完成情况（勋章追踪） */
  MissionCompleteSome: [{ count: number }];
  /** 累计获得指定活动材料（勋章追踪，act53side TotalSimpleTokenCount：param[3]=材料列表） */
  TotalSimpleTokenCount: [{ itemId: string; count: number }];
  /** 累计获得活动货币（ActivityCoinGain：param[1]=activityId，param[2]=目标，param[3]=活动币 itemId） */
  ActivityCoinGain: [{ itemId: string; count: number }];
  /** 累计消耗龙门币（CostGold：param[1]=目标；升级/晋升耗币 emit {goldCost}） */
  CostGold: [{ goldCost: number }];
  /** 干员升级与晋升累计消耗龙门币（CostGoldPlus：param[1]=目标） */
  CostGoldPlus: [{ goldCostPlus: number }];
  /** 通关关卡且满足条件次数（勋章追踪，act53side PassStageWithSimpleCountMore；enemyStats=当关各敌人击杀计数） */
  PassStageWithSimpleCountMore: [PassStageStats];
  /** 通关关卡且未触发指定计数的次数（PassStageWithSimpleCountLess；修复：原为占位实现） */
  PassStageWithSimpleCountLess: [PassStageStats];
  /** 通关关卡且击杀指定敌人的次数（PassStageKilled；修复：原为占位实现） */
  PassStageKilled: [PassStageStats];
  /** 通关关卡且未被击杀（击杀数不超阈值）的次数（PassStageKilledLess；修复：原为占位实现） */
  PassStageKilledLess: [PassStageStats];
  /** 指定关卡组累计击杀指定敌人（PassStageKilledTotal；修复：原为占位实现） */
  PassStageKilledTotal: [PassStageStats];
  /** 通关时场外 token 计数不低于阈值的次数（PassStageWithSimpleTokenCountMore） */
  PassStageWithSimpleTokenCountMore: [PassStageStats];
  /** 通关时场外 token 计数未达到阈值的次数（PassStageWithSimpleTokenCountLess） */
  PassStageWithSimpleTokenCountLess: [PassStageStats];
  /** arkodc 变量序列达标（勋章追踪，act53side ArkodcVarSeqAtLeast：读 topic.varSeqs） */
  ArkodcVarSeqAtLeast: [{ activityId: string; varSeqs: Record<string, number> }];
  /** 干员精英化次数（勋章追踪，补声明——medal.ts CharEvolveCount 模板监听） */
  CharEvolveCount: [{ char: PlayerCharacter }];
  /** 干员信赖档位（勋章追踪，补声明——medal.ts CharFavorCount 模板监听） */
  CharFavorCount: [{ favorPoint: number }];
  /** 获得干员（勋章追踪，补声明——medal.ts GotChars 模板监听） */
  GotChars: [{ char: PlayerCharacter }];
  /** 累计签到次数（勋章追踪，补声明——medal.ts TotalCheckinCount 模板监听） */
  TotalCheckinCount: [];
  /** 技能升级次数（勋章追踪，补声明——medal.ts CharSkillCount 模板监听） */
  CharSkillCount: [{ targetLevel: number }];
  /** 技能专精次数（勋章追踪，补声明——medal.ts CharSkillSpecCount 模板监听；2026-09-09 接线） */
  CharSkillSpecCount: [{ targetLevel: number }];
  /** 特勤干员精英化阶段达成（勋章追踪，补声明——medal.ts CharEvolvePhase 模板监听；2026-09-09 接线） */
  CharEvolvePhase: [{ charId: string; phase: number }];
  /** 潜能提升次数（勋章追踪，补声明——medal.ts CharPotential 模板监听） */
  CharPotential: [{ targetLevel: number }];
  /** 基建放置建筑（勋章追踪） */
  Sbv2PlaceBuilding: [];
  /** 基建通关裂隙（勋章追踪） */
  Sbv2PassRiftLevel: [{ level: number }];
  /** 基建通关裂隙次数（勋章追踪） */
  Sbv2PassRiftCount: [];
  /** 基建捕获动物（勋章追踪） */
  Sbv2CatchAnimal: [];
  /** 基建解锁科技（勋章追踪） */
  Sbv2UnlockTech: [];
  /** 基建生存天数（勋章追踪） */
  Sbv2SurviveDays: [{ days: number }];
  /** 基建击杀Boss（勋章追踪） */
  Sbv2KillBoss: [];
  /**
   * 肉鸽V2通关节点（勋章追踪）
   *
   * 载荷补 theme/nodeType（2026-09-09）：勋章 unlockParam[0] 为主题 id（rogue_4 等），
   * 模板据此做主题门控——原载荷为空，模板无法过滤主题。
   */
  Rlv2PassNode: [{ theme?: string; nodeType?: number }];
  /**
   * 肉鸽V2通过区域（勋章追踪）
   *
   * 官服 getMethod「通过XX区域 N 次」；unlockParam = [主题, zoneId, 目标次数]。
   */
  Rlv2PassZone: [{ theme?: string; zoneId?: string }];
  /**
   * 肉鸽V2通行证等级（源流堆栈等级，勋章追踪）
   *
   * 载荷为按官方奖励轨道门槛换算出的**当前等级**（outer[theme].bp.point → milestones），
   * theme 供 unlockParam[0] 主题门控（2026-09-09 补）。
   */
  Rlv2BpLevel: [{ theme?: string; level: number }];
  /** 永久升级（勋章追踪） */
  PermUpgrade: [];
  /** 使用炼金（勋章追踪） */
  UseAlchemy: [];
  /**
   * 肉鸽V2招募（勋章追踪）
   *
   * 载荷补 theme（2026-09-09）：unlockParam = [主题, 目标次数]，模板需按主题门控。
   */
  Rlv2Recruit: [{ theme?: string }];
  /** 肉鸽V2获得队伍奖励（勋章追踪） */
  Rlv2GetTeamReward: [];
  /**
   * 肉鸽V2结局收集（勋章追踪）
   *
   * 载荷为**当前已达成结局种数**（collect.endBook 条目数，2026-09-09 起由 settle 写入），
   * 模板取 max（幂等）；ending 保留为单条结局 id 的兼容字段。
   */
  Rlv2EndingCollect: [{ theme?: string; ending?: string; count?: number }];
  /**
   * 肉鸽V2收集遗物（勋章追踪）
   *
   * 载荷改为「当前累计收藏品数」（2026-09-09）：官服 getMethod 为「拟造物质编目已持有
   * N 个收藏品」——按局外 collect.relic 已获得条目数整体上报，模板取 max（幂等）。
   */
  Rlv2CollectRelic: [{ theme?: string; relicId?: string; count?: number }];
  /**
   * 肉鸽V2使用指定角色完成战斗（勋章追踪）
   *
   * 载荷补 theme/mode/charIds/battleWinCount（2026-09-09）：unlockParam =
   * [主题, 干员A, 干员A变体, 目标胜利次数]，模板需按主题门控并判断本局是否携带该干员；
   * 官服 getMethod 允许「常规行动或讲述者列表」，两种模式均计入。
   */
  Rlv2FinishBattleWithSpecChar: [
    {
      theme?: string;
      mode?: string;
      charIds?: string[];
      battleWinCount?: number;
      charId?: string;
    },
  ];
  /** 肉鸽V2指定难度通关结局（勋章追踪） */
  Rlv2EndingWithModeGrade: [{ ending: string; grade: number }];
  /**
   * 肉鸽V2解锁乐队/分队（勋章追踪）
   *
   * 载荷为当前已解锁分队数（collect.band state ≥ 1），模板取 max（幂等）。
   */
  Rlv2UnlockBand: [{ theme?: string; count?: number }];
  /** 肉鸽V2图腾共鸣（勋章追踪） */
  Rlv2TotemResonance: [];
  /** 肉鸽V2完成节点任务（勋章追踪） */
  Rlv2CompleteNodeMission: [];
  /** 肉鸽V2获得胶囊（勋章追踪） */
  Rlv2GainCapsule: [];
  /** 基建家具主题数量（勋章追踪） */
  BuildingGotFurnitureThemeCount: [{ count: number }];
  /** 基建制造产品次数（勋章追踪） */
  BuildingManufactureProductTimes: [{ count: number }];
  /** 基建工坊合成（勋章追踪） */
  BuildingWorkshopSynthesisGroupByID: [{ groupId: string }];
  /** 限时获取角色（勋章追踪） */
  GotCharsBeforeTime: [{ charId: string }];
  /** 活动代币消耗（勋章追踪） */
  ActivityCoinCost: [{ coinType: string; cost: number }];
  /** 活动里程碑点数（勋章追踪） */
  ActivityMilestonePoint: [{ point: number }];
  /** 限时获取物品（勋章追踪） */
  GotItemBeforeTime: [{ itemId: string }];
  /**
   * 保全派驻通关（勋章追踪，PassTower 模板）
   *
   * 修复（2026-09-09）：该事件此前从未 emit，59 枚「保全任务」勋章永不可得。
   * 载荷 stageId 对应 medal.unlockParam[0]（tower_n_XX），isHard 对应 unlockParam[2]。
   */
  PassTower: [{ stageId?: string; count?: number; isHard?: boolean }];
  /**
   * 剿灭作战完成（勋章追踪，CampaignsComplete 模板）
   *
   * 修复（2026-09-09）：该事件此前从未 emit，36 枚剿灭蚀刻章永不可得。
   * 载荷为 campaignsV2 存档（模板按 unlockParam[0] 读 instances[stageId].maxKills/rewardStatus）。
   */
  CampaignsComplete: [
    {
      instances?: Record<
        string,
        { maxKills?: number; rewardStatus?: number[] } | undefined
      >;
    },
  ];
  /**
   * 危机合约维度分数总计（勋章追踪）
   *
   * 修复（2026-09-09）：载荷补 seasonId/mapId——勋章 unlockParam[0] 为赛季 id、
   * [1] 为主测试地关卡，模板据此做赛季与地图门控（否则打一个赛季会推进所有赛季的章）。
   */
  CrisisV2DimScoreTotal: [{ seasonId?: string; mapId?: string; score: number }];
  /** 危机合约解锁节点（勋章追踪；nodeIds 为本次完成的节点 id，如 mapId^keypoint_1） */
  CrisisV2NodeSome: [{ seasonId?: string; nodeIds?: string[] }];
  /** 危机合约维度分数达标（勋章追踪，峰值得分） */
  CrisisV2DimScoreSome: [{ seasonId?: string; mapId?: string; score: number }];
  /** 危机合约V2使用助战（勋章追踪，battleFinish 按是否携带助战发 used） */
  CrisisV2UseAssist: [{ seasonId?: string; used: number }];
  /** 危机合约分数达标（勋章追踪，峰值得分；stageId 用于对齐 unlockParam[1]） */
  CrisisStageScoreSome: [{ seasonId?: string; stageId?: string; score: number }];
  /** 危机合约完成任务（勋章追踪；taskId 用于对齐 unlockParam[1] 的任务清单） */
  CrisisTaskSome: [{ seasonId?: string; taskId?: string; count?: number }];
  /** 危机合约解锁永久符文（勋章追踪；runeId 用于对齐 unlockParam[1] 的词条清单） */
  CrisisUnlockPermRuneSome: [{ seasonId?: string; runeId?: string; count?: number }];
  /** 危机合约使用助战（勋章追踪） */
  CrisisUseAssist: [{ seasonId?: string; used: number }];
  /** 危机合约临时派遣结算（CrisisTempClearSome：每结算局 +1） */
  CrisisTempClearSome: [{ seasonId?: string; count?: number }];
  /** 危机合约限时达成得分（CrisisStageScoreBeforeTime：峰值 score，超截止时间不计） */
  CrisisStageScoreBeforeTime: [{ seasonId?: string; stageId?: string; score: number }];
  /** 重构符文关卡得分（RecalRuneStageScoreSome：峰值 score；由 recal battleFinish 发） */
  RecalRuneStageScoreSome: [{ seasonId?: string; stageId?: string; score: number }];
};