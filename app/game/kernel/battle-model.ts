import { PlayerSquad, SquadFriendData } from "./model";
import type { JsonValue } from "@excel/json-value";

type ListCounterPool<T> = { Key: T; Value: number }[];
export interface BattleData {
  battleId: string;
  interrupt: number;
  giveUp: number;
  percent: number;
  completeState: number;
  killCnt: number;
  validKillCnt: number;
  battleData: BattleLogger;
  currentIndex: number;
  platform: number;
}

export interface BattleLogger {
  stats: BattleStats;
  isCheat: string;
  completeTime: number;
}

export interface BattleStats {
  killedEnemiesCnt: number;
  unnatrualRecoveredCost: number;
  charStats: ListCounterPool<BattleStats.CharStatKey>;
  enemyStats: ListCounterPool<BattleStats.EnemyStatKey>;
  skillTrigStats: ListCounterPool<BattleStats.SkillTrigStatsKey>;
  charAdvancedStats: { [charId: string]: BattleStats.CharAdvancedStats };
  /**
   * 客户端上报的高级统计（逐项形状未在客户端模型中声明）
   *
   * 这些字段是**未经校验的客户端 JSON**：此前声明为 TS `object`（既不可索引也不可取属性，
   * 调用方唯一出路是 `as any`）。按 docs/type-system-audit.md §2.2/§3.1 改用严格 JSON 域
   * 类型 {@link JsonValue}——仍是严格类型，取值必须显式收窄。
   */
  enemyAdvancedStats: JsonValue;
  runeAdvancedStats: JsonValue[];
  rlBuffAdvancedStats: JsonValue[];
  extraBattleInfoStats: JsonValue;
  extraBattleInfoSubStats: JsonValue[];
  charList: JsonValue;
  enemyList: { [key: string]: number[][] };
  runeList: JsonValue[];
  rlBuffList: JsonValue[];
  beginTs: number;
  endTs: number;
  access: string;
  hash: string;
  packageName: string;
  checkKilledCnt: number;
  leftHp: number;
  totalHeal: number;
  totalDamage: number;
  fixedPlayTime: number;
  extraInfo: { [key: string]: string };
  extraBattleInfo: { [key: string]: number };
  clientAntiCheatLog: JsonValue;
  idList: JsonValue[];
  packedRuneDataList: null;
  autoReplayCancelled: number;
}

export namespace BattleStats {
  export interface EnemyStatKey {
    enemyId: string;
    counterType: string;
    isInvalidKilled: number;
  }
  /**
   * 干员计数键（反编译 Torappu.Battle.BattleLogger.BattleStats.CharStatKey）
   * counterType 为线格式字符串枚举：SPAWN/DEAD/WITHDRAW
   */
  export interface CharStatKey {
    charId: string;
    counterType: "SPAWN" | "DEAD" | "WITHDRAW";
  }
  /** 技能施放计数键（反编译 SkillTrigStatsKey）：charId + skillId */
  export interface SkillTrigStatsKey {
    charId: string;
    skillId: string;
  }
  /**
   * 干员高级统计（反编译 CharAdvancedStats，基于 CharacterSnapshot 聚合）
   * - outputDamageTotal：干员造成总伤害
   * - outputElementDamageTotal：按元素类型的造成伤害累计
   * - outputEpBreakCnt：按元素类型的元素爆发次数
   * - outputDamageByTypeTotal：按伤害类型的造成伤害累计
   */
  export interface CharAdvancedStats {
    outputDamageRange?: [number, number];
    inputDamageRange?: [number, number];
    outputDamageTotal: number;
    outputElementDamageTotal?: number[];
    outputEpBreakCnt?: number[];
    outputDamageByTypeTotal?: number[];
  }
}
export interface CommonStartBattleRequest {
  isRetro: number;
  pray: number;
  battleType: number;
  continuous: {
    battleTimes: number;
  };
  usePracticeTicket: number;
  stageId: string;
  squad: PlayerSquad;
  assistFriend: null | SquadFriendData;
  isReplay: number;
  startTs: number;
}
