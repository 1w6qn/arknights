/**
 * 肉鸽V2 领域事件映射（Rlv2）
 *
 * 集中定义肉鸽V2（roguelike）控制器的领域事件：
 * - 控制器生命周期：init / create / continue / move
 * - 玩法动作：招募、遗物、buff、区域、节点、碎片、银行、灾祸等
 * - 特勤干员（SPECIAL_OPERATOR）任务模板事件（由 rlv2 控制器 emit，mission 模板订阅）
 */
import type {
  PlayerRoguelikeV2,
  RoguelikeItemBundle,
} from "../rlv2-model";
import type { RoguelikeBuff } from "@excel/excel";
import type { BattleData } from "../battle-model";

/**
 * 肉鸽V2 领域事件映射
 */
export type EventMapRlv2 = {
  /** 肉鸽V2初始化事件 */
  "rlv2:init": [];
  /** 肉鸽V2模块初始化事件 */
  "rlv2:module:init": [];
  /** 肉鸽V2创建事件 */
  "rlv2:create": [];
  /** 肉鸽V2继续事件 */
  "rlv2:continue": [];
  /** 肉鸽V2移动事件 */
  "rlv2:move": [];
  /** 肉鸽V2获取物品事件 */
  "rlv2:get:items": [RoguelikeItemBundle[]];
  /** 肉鸽V2升级事件 */
  "rlv2:levelUp": [number];
  /** 肉鸽V2招募获取事件 */
  "rlv2:recruit:gain": [string, string, number];
  /** 肉鸽V2招募激活事件 */
  "rlv2:recruit:active": [string];
  /** 肉鸽V2招募完成事件 */
  "rlv2:recruit:done": [string, string];
  /** 肉鸽V2角色获取事件 */
  "rlv2:char:get": [PlayerRoguelikeV2.CurrentData.RecruitChar];
  /** 肉鸽V2选择初始招募组事件 */
  "rlv2:choose_init_recruit_set": [string[]];
  /** 肉鸽V2遗物获取事件 */
  "rlv2:relic:gain": [RoguelikeItemBundle];
  /** 肉鸽V2遗物回收事件 */
  "rlv2:relic:recycle": [string];
  /** 肉鸽V2遗物放置事件 */
  "rlv2:relic:put": [string];
  /** 肉鸽V2事件创建事件 */
  "rlv2:event:create": [string, object];
  /** 肉鸽V2buff应用事件 */
  "rlv2:buff:apply": [[...RoguelikeBuff[]]];
  /** 肉鸽V2区域新事件 */
  "rlv2:zone:new": [number];
  /** 肉鸽V2战斗开始事件 */
  "rlv2:battle:start": [string];
  /** 肉鸽V2战斗结束事件 */
  "rlv2:battle:finish": [
    {
      battleLog: string;
      data: string;
      battleData: BattleData;
    },
  ];
  /** 肉鸽V2银行存入事件 */
  "rlv2:bankPut": [boolean];
  /** 肉鸽V2银行取出事件 */
  "rlv2:bank:withdraw": [];
  /** 肉鸽V2灾祸抽象事件 */
  "rlv2:disaster:abstract": [];
  /** 肉鸽V2灾祸生成事件 */
  "rlv2:disaster:generate": [];
  /** 肉鸽V2节点附着事件 */
  "rlv2:node:attach": [string[], string[]];
  /** 肉鸽V2节点升级事件 */
  "rlv2:node:upgrade": [string];
  /** 肉鸽V2节点完成事件 */
  "rlv2:node:complete": [{ nodeId: string }];
  /** 肉鸽V2网格区域步进事件（rogue_6 GRID_ZONE） */
  "rlv2:grid:step": [];
  /** 肉鸽V2误入奇境隐藏层返回事件（rogue_6 portal 行动力耗尽返回原区域） */
  "rlv2:portal:return": [];
  /** 肉鸽V2废品获得事件（rogue_6 SCRAP） */
  "rlv2:scrap:gain": [string];
  /** 肉鸽V2铜币开局抽牌事件（rogue_5 COPPER） */
  "rlv2:copper:init": [];
  /** 肉鸽V2怒气获得事件（rogue_5 WRATH） */
  "rlv2:wrath:gain": [string];
  /** 肉鸽V2游戏结束事件 */
  "rlv2:game:end": [{ score: number; rank: string }];
  /** 肉鸽V2碎片获取事件 */
  "rlv2:fragment:gain": [string];
  /** 肉鸽V2分队初始干员事件（immediate_recruit：TEMP 干员入队） */
  "rlv2:recruit:initial_char": [string];
  /** 肉鸽V2碎片设置队伍携带事件 */
  "rlv2:fragment:set_troop_carry": [string[]];
  /** 肉鸽V2碎片使用灵感事件 */
  "rlv2:fragment:use_inspiration": [string];
  /** 肉鸽V2碎片改变类型权重事件 */
  "rlv2:fragment:change_type_weight": [RoguelikeBuff];
  /** 肉鸽V2碎片最大权重增加事件 */
  "rlv2:fragment:max_weight:add": [number];
  /** 肉鸽V2碎片使用事件 */
  "rlv2:fragment:use": [string, number];
  /** 肉鸽V2碎片丢失事件 */
  "rlv2:fragment:lose": [string];

  // ============ 特勤干员（SPECIAL_OPERATOR）任务事件 ============
  // 事件名 = SpecialOperatorTable.nodeUnlockMissionData 中任务的 template，由 rlv2 控制器
  // 在对应玩法动作处 emit。各模板 param 语义见 mission.ts MissionTemplates 对应条目。
  /** Rlv2PassZoneSpec：到达指定区域（emit 于进入新区域时；zoneId 形如 "zone_2"） */
  Rlv2PassZoneSpec: [
    { theme: string; mode: string; grade: number; zoneId: string },
  ];
  /** Rlv2PassNodeSpec：通过指定类型节点（emit 于抵达节点；nodeType 为节点类型数值） */
  Rlv2PassNodeSpec: [
    { theme: string; mode: string; grade: number; nodeType: number },
  ];
  /** Rlv2CandleTimes：累计秉烛（rogue_5 岁兽残识——干员入队即视为秉烛，emit 于招募） */
  Rlv2CandleTimes: [{ theme: string; mode: string; grade: number }];
  /** Rlv2SpZoneSteps：累计在岁兽残识消耗烛火（emit 于 rogue_5 移动，每步 1 点） */
  Rlv2SpZoneSteps: [
    { theme: string; mode: string; grade: number; cost: number },
  ];
  /** Rlv2BandGradeCnt：使用 N 个分队在 grade 及以上通关任意结局（结算时发累计分队×难度记录，模板按 param[2] 门槛过滤） */
  Rlv2BandGradeCnt: [
    { theme: string; bandGrade: Record<string, Record<string, number>> },
  ];
  /** Rlv2EndingBandGradeCnt：使用 N 个分队在 grade 及以上达成指定结局（结算时发累计分队记录） */
  Rlv2EndingBandGradeCnt: [
    {
      theme: string;
      bandGrade: Record<string, Record<string, number>>;
      bandCnt: Record<string, Record<string, number>>;
      ending: string;
    },
  ];
  /** Rlv2EndingModeGrade：在 grade 及以上达成指定结局（结算时发累计分队记录） */
  Rlv2EndingModeGrade: [
    {
      theme: string;
      bandGrade: Record<string, Record<string, number>>;
      bandCnt: Record<string, Record<string, number>>;
      ending: string;
    },
  ];
  /** Rlv2EndingWithBandChar：使用指定分队招募指定干员并达成任意结局（本局判定） */
  Rlv2EndingWithBandChar: [
    { theme: string; mode: string; grade: number; bandId: string; charIds: string[]; ending: string },
  ];
  /** Rlv2EndingWithCharPassSpBattle：招募指定干员、通过 N 次祸乱节点并达成指定结局（本局判定） */
  Rlv2EndingWithCharPassSpBattle: [
    { theme: string; mode: string; grade: number; charIds: string[]; spBattleCount: number; ending: string },
  ];
  /** Rlv2EndingWithCandleChar：招募指定干员、N 名干员成为伺烛客并达成指定结局（本局判定） */
  Rlv2EndingWithCandleChar: [
    { theme: string; mode: string; grade: number; charIds: string[]; candleCharCount: number; ending: string },
  ];
  /** Rlv2EliteBattleWithChar：招募指定干员并通关任意紧急作战（本局判定；eliteCount=本局通过紧急作战节点数） */
  Rlv2EliteBattleWithChar: [
    { theme: string; mode: string; grade: number; charIds: string[]; eliteCount: number; ending: string },
  ];
  /** Rlv2StageSimpleEventMore：指定关卡内战斗简单事件计数（如击杀"易"，battle finish emit；events 为 extraBattleInfo 映射） */
  Rlv2StageSimpleEventMore: [
    {
      theme: string;
      mode: string;
      grade: number;
      stageId: string;
      events: Record<string, number>;
    },
  ];
  /** Rlv2RecruitSpecificChar：招募指定干员（emit 于 recruit done） */
  Rlv2RecruitSpecificChar: [{ theme: string; charId: string }];
  /** Rlv2UpgradeSpecificChar：进阶指定干员（emit 于招募时直接进阶 upgradePhase>=1） */
  Rlv2UpgradeSpecificChar: [{ theme: string; charId: string }];
  /** Rlv2MeetBandit：探索"居民"恶意占据的节点（rogue_6 RESIDENT 节点，emit 于抵达） */
  Rlv2MeetBandit: [{ theme: string; mode: string; grade: number }];
  /** Rlv2GainItem：累计获得零件（emit 于 rlv2:scrap:gain；itemType 恒 "SCRAP"） */
  Rlv2GainItem: [{ itemType: string; count: number }];
  /** Rlv2MoveCostAp：累计消耗行动力（emit 于 rogue_6 网格移动/空步；cost=步数） */
  Rlv2MoveCostAp: [
    { theme: string; mode: string; grade: number; cost: number },
  ];
  /** Rlv2ShopRecycle：累计卖出零件（emit 于行商节点丢弃废品；itemType 恒 "SCRAP"） */
  Rlv2ShopRecycle: [{ itemType: string; count: number }];
};