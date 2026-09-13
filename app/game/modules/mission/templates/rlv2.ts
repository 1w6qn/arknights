/**
 * 集成战略（rlv2）任务模板及其统计辅助函数
 */
/**
 * 特勤干员（SPECIAL_OPERATOR）任务节点类型名 → 数值映射。
 * 用于 Rlv2PassNodeSpec 等模板把任务 param 中的节点类型名（如 "INCIDENT"、
 * "BATTLE_NORMAL,BATTLE_ELITE,BATTLE_BOSS"）解析为地图节点 type 数值。
 * 数值与 TorappuRoguelikeEventType / ROGUE6_NODE 对齐。
 * 岁兽残识"祸乱"节点（BATTLE / BATTLE_HARD）后端未实现专属机制，按作战/紧急作战近似。
 * 映射固化在 data/rlv2/mission-node-values.json——excel nodeTypeData 分主题且同名节点
 * 位值跨主题不一致（如「诡意行商」rogue_1~5=8、rogue_6=4096），无法从单一主题推出
 * 全局映射；一致性由 tests/unit/data/mission-node-values.test.ts 守护（位值 ∈ 某主题键）。
 */
const RLV2_MISSION_NODE_VALUES: Record<string, number> = readJsonSync(
  `${__dirname}/../../../../../data/rlv2/mission-node-values.json`,
);

/**
 * 校验特勤干员任务事件上下文是否匹配任务 param 的 theme/mode/grade 门槛。
 * 各模板 param 布局不同（有的含 mode、有的不含），事件载荷缺失对应字段时跳过该校验。
 * @param mission 任务进度实例
 * @param ctx 事件载荷中的主题/模式/难度字段
 * @returns 匹配返回 true
 */
function matchesRlv2Context(
  mission: MissionInfo,
  ctx: { theme?: string; mode?: string; grade?: number },
): boolean {
  if (ctx.theme !== undefined && ctx.theme !== mission.param[1]) return false;
  if (ctx.mode !== undefined && ctx.mode !== mission.param[2]) return false;
  if (
    ctx.grade !== undefined &&
    ctx.grade < parseInt(mission.param[3] || "0", 10)
  ) {
    return false;
  }
  return true;
}

/** 在 grade 及以上通关过任意结局的分队数（按累计分队×难度记录统计） */
function countBandsAtGrade(
  bandGrade: Record<string, Record<string, number>>,
  minGrade: number,
): number {
  return Object.values(bandGrade).filter((grades) =>
    Object.entries(grades).some(
      ([g, cnt]) => parseInt(g, 10) >= minGrade && cnt > 0,
    ),
  ).length;
}

/** 在 grade 及以上达成过指定结局的分队数（按累计分队×结局、分队×难度记录统计） */
function countBandsWithEndingAtGrade(
  bandGrade: Record<string, Record<string, number>>,
  bandCnt: Record<string, Record<string, number>>,
  minGrade: number,
  ending: string,
): number {
  return Object.entries(bandCnt).filter(([bandId, endings]) => {
    if (!endings?.[ending]) return false;
    const grades = bandGrade?.[bandId] || {};
    return Object.entries(grades).some(
      ([g, cnt]) => parseInt(g, 10) >= minGrade && cnt > 0,
    );
  }).length;
}

/** 是否在 grade 及以上达成过指定结局（0/1） */
function achievedEndingAtGrade(
  bandGrade: Record<string, Record<string, number>>,
  bandCnt: Record<string, Record<string, number>>,
  minGrade: number,
  ending: string,
): number {
  return countBandsWithEndingAtGrade(bandGrade, bandCnt, minGrade, ending) > 0
    ? 1
    : 0;
}

import type { MissionTemplateGroup, MissionInfo } from "./types";
import { readJsonSync } from "@utils/file";

export const rlv2Templates: MissionTemplateGroup = {

  /**
   * 完成并结算指定主题的集成战略（Rlv2SettleGame）
   *
   * 修复（2026-09-09）：原实现 `update: () => {}` 恒不推进，且全仓无 emit 站点
   * → 任务「完成并结算一次集成战略：岁的界园志异」(soWeekTask_3) 永久卡死。
   * 现由 settle.ts#gameSettle 成功结算时 emit `Rlv2SettleGame`。
   * @param param[0] 分支位（恒 "0"）
   * @param param[1] 目标结算次数
   * @param param[2] 主题 id（如 rogue_5；缺省不限主题）
   */
  Rlv2SettleGame: {
    "0": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[1]),
        });
      },
      update: (
        mission,
        args: {
          data?: { current?: { game?: { theme?: string } | null } } | null;
        },
      ) => {
        // 主题取值：整份 rlv2 存档（data.current.game.theme）为发送形态
        const theme = args?.data?.current?.game?.theme;
        const want = mission.param[2];
        if (want && theme !== want) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 完成并结算任意主题的集成战略（Rlv2SettleGameTimes）
   *
   * 修复（2026-09-09）：同 Rlv2SettleGame——原 update 空实现且无 emit 站点，
   * 任务 soWeekTask_3_rogue6 永久卡死。
   * @param param[0] 分支位（恒 "0"）
   * @param param[1] 目标结算次数
   */
  Rlv2SettleGameTimes: {
    "0": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[1]),
        });
      },
      update: (mission) => {
        mission.progress[0].value += 1;
      },
    },
  },

  // ==================== 特勤干员（SPECIAL_OPERATOR）任务模板 ====================
  // SpecialOperatorTable.nodeUnlockMissionData 中任务的 template（Rlv2* 系列，18 类）。
  // 事件名 = 模板名，由 rlv2 控制器在对应玩法动作处 emit（见 events.ts 特勤干员区块）。
  // param 布局因模板而异（见各模板注释）；param[0] 恒为分支位。

  /**
   * 到达指定区域（Rlv2PassZoneSpec）
   *
   * 在指定主题/模式/难度门槛下，到达 param[5] 指定区域（如 zone_2）各计 1，达 param[4] 完成。
   * 用例：「在XX的常规行动中，到达3层」（mcnist_t_evolve_1 param=["1","rogue_6","NORMAL","0","1","zone_2"]）。
   * @param param[1] 主题 id（rogue_5/rogue_6）
   * @param param[2] 模式（NORMAL）
   * @param param[3] 难度门槛（modeGrade >= 该值）
   * @param param[4] 目标到达次数
   * @param param[5] 区域 id（zone_N）
   */
  Rlv2PassZoneSpec: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[4]),
        });
      },
      update: (mission, args: { theme: string; mode: string; grade: number; zoneId: string }) => {
        if (!matchesRlv2Context(mission, args)) return;
        if (args.zoneId !== mission.param[5]) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 累计通过指定类型节点（Rlv2PassNodeSpec）
   *
   * 在主题/模式/难度门槛下，通过 param[4]（逗号分隔节点类型名）任一节点各计 1，达 param[5] 完成。
   * 用例：「累计通过5次不期而遇节点」（param[4]="INCIDENT"）、「累计通过12次任意界园战斗节点」
   * （param[4]="BATTLE_NORMAL,BATTLE_ELITE,BATTLE_BOSS"）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 节点类型名列表（逗号分隔，见 RLV2_MISSION_NODE_VALUES）
   * @param param[5] 目标通过次数
   */
  Rlv2PassNodeSpec: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[5]),
        });
      },
      update: (mission, args: { theme: string; mode: string; grade: number; nodeType: number }) => {
        if (!matchesRlv2Context(mission, args)) return;
        const names = mission.param[4].split(",");
        const ok = names.some((n) => RLV2_MISSION_NODE_VALUES[n] === args.nodeType);
        if (!ok) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 累计秉烛（Rlv2CandleTimes）
   *
   * 在主题/模式/难度门槛下，秉烛（岁兽残识中干员入队即视为秉烛）各计 1，达 param[4] 完成。
   * 用例：「累计秉烛5次」（param=["1","rogue_5","NORMAL","1","5"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 目标秉烛次数
   */
  Rlv2CandleTimes: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[4]),
        });
      },
      update: (mission, args: { theme: string; mode: string; grade: number }) => {
        if (!matchesRlv2Context(mission, args)) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 累计在岁兽残识消耗烛火（Rlv2SpZoneSteps）
   *
   * 在主题/模式/难度门槛下，移动消耗烛火按 cost 累计，达 param[4] 完成。
   * 用例：「累计在岁兽残识消耗8点烛火」（param=["1","rogue_5","NORMAL","1","8"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 目标烛火消耗
   */
  Rlv2SpZoneSteps: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[4]),
        });
      },
      update: (mission, args: { theme: string; mode: string; grade: number; cost: number }) => {
        if (!matchesRlv2Context(mission, args)) return;
        mission.progress[0].value += args.cost || 1;
      },
    },
  },

  /**
   * 使用 N 个分队在难度门槛以上通关任意结局（Rlv2BandGradeCnt）
   *
   * 结算时按累计「分队×难度」记录统计在 param[2] 及以上通关任意结局的分队数，取较大值作进度。
   * 用例：「请君入园·2及以上，通关任意结局」（param=["1","rogue_5","2","1"]）、
   * 「请君入园·4及以上，累计使用三个分队通关任意结局」（param=["1","rogue_5","4","3"]）。
   * @param param[1] 主题 id
   * @param param[2] 难度门槛
   * @param param[3] 目标分队数
   */
  Rlv2BandGradeCnt: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[3]),
        });
      },
      update: (mission, args: { theme: string; bandGrade: Record<string, Record<string, number>> }) => {
        if (args.theme !== mission.param[1]) return;
        const count = countBandsAtGrade(args.bandGrade, parseInt(mission.param[2]));
        mission.progress[0].value = Math.max(mission.progress[0].value, count);
      },
    },
  },

  /**
   * 使用 N 个分队在难度门槛以上达成指定结局（Rlv2EndingBandGradeCnt）
   *
   * 结算时按累计「分队×结局」「分队×难度」记录统计在 param[2] 及以上达成 param[4] 结局的分队数。
   * 用例：「请君入园·5及以上，累计使用三个分队达成结局'长卷留痕'」（param=["1","rogue_5","5","3","ro5_ending_2"]）。
   * @param param[1] 主题 id
   * @param param[2] 难度门槛
   * @param param[3] 目标分队数
   * @param param[4] 结局 id
   */
  Rlv2EndingBandGradeCnt: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[3]),
        });
      },
      update: (
        mission,
        args: {
          theme: string;
          bandGrade: Record<string, Record<string, number>>;
          bandCnt: Record<string, Record<string, number>>;
          ending: string;
        },
      ) => {
        if (args.theme !== mission.param[1]) return;
        if (args.ending !== mission.param[4]) return;
        const count = countBandsWithEndingAtGrade(
          args.bandGrade,
          args.bandCnt,
          parseInt(mission.param[2]),
          args.ending,
        );
        mission.progress[0].value = Math.max(mission.progress[0].value, count);
      },
    },
  },

  /**
   * 在难度门槛以上达成指定结局（Rlv2EndingModeGrade）
   *
   * 结算时按累计记录判定是否在 param[3] 及以上达成 param[4] 结局（目标恒 1）。
   * 用例：「请君入园·9及以上，达成结局'黑白入玄'」（param=["1","rogue_5","NORMAL","9","ro5_ending_3"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 结局 id
   */
  Rlv2EndingModeGrade: {
    "1": {
      init: (mission) => {
        mission.progress.push({ value: mission.value, target: 1 });
      },
      update: (
        mission,
        args: {
          theme: string;
          bandGrade: Record<string, Record<string, number>>;
          bandCnt: Record<string, Record<string, number>>;
          ending: string;
        },
      ) => {
        if (args.theme !== mission.param[1]) return;
        if (args.ending !== mission.param[4]) return;
        const ok = achievedEndingAtGrade(
          args.bandGrade,
          args.bandCnt,
          parseInt(mission.param[3]),
          args.ending,
        );
        mission.progress[0].value = Math.max(mission.progress[0].value, ok);
      },
    },
  },

  /**
   * 使用指定分队招募指定干员并达成任意结局（Rlv2EndingWithBandChar）
   *
   * 本局判定：分队属于 param[4]（逗号分隔分队 id）、招募 param[5] 干员、通关任意结局。
   * 用例：「请君入园·7及以上，使用游客分队招募电弧并达成任意结局」
   * （param=["1","rogue_5","NORMAL","7","rogue_5_band_15,rogue_5_band_16,rogue_5_band_27","char_4195_radian"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 分队 id 列表（逗号分隔）
   * @param param[5] 指定干员 id
   */
  Rlv2EndingWithBandChar: {
    "1": {
      init: (mission) => {
        mission.progress.push({ value: mission.value, target: 1 });
      },
      update: (
        mission,
        args: { theme: string; mode: string; grade: number; bandId: string; charIds: string[]; ending: string },
      ) => {
        if (!matchesRlv2Context(mission, args)) return;
        if (!args.ending) return;
        if (!mission.param[4].split(",").includes(args.bandId)) return;
        if (!args.charIds.includes(mission.param[5])) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 招募指定干员、通过 N 次祸乱节点并达成指定结局（Rlv2EndingWithCharPassSpBattle）
   *
   * 本局判定：招募 param[4] 干员、通过 >=param[5] 次祸乱节点、达成 param[6] 结局。
   * 用例：「请君入园·6及以上，招募干员电弧，通过至少2次'祸乱'节点并达成结局'依律镇抚'」
   * （param=["1","rogue_5","NORMAL","6","char_4195_radian","2","ro5_ending_1"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 指定干员 id
   * @param param[5] 祸乱节点通过次数门槛
   * @param param[6] 结局 id
   */
  Rlv2EndingWithCharPassSpBattle: {
    "1": {
      init: (mission) => {
        mission.progress.push({ value: mission.value, target: 1 });
      },
      update: (
        mission,
        args: { theme: string; mode: string; grade: number; charIds: string[]; spBattleCount: number; ending: string },
      ) => {
        if (!matchesRlv2Context(mission, args)) return;
        if (args.ending !== mission.param[6]) return;
        if (!args.charIds.includes(mission.param[4])) return;
        if (args.spBattleCount < parseInt(mission.param[5])) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 招募指定干员、N 名干员成为伺烛客并达成指定结局（Rlv2EndingWithCandleChar）
   *
   * 本局判定：招募 param[4] 干员、伺烛客数 >=param[5]（param[5]="0" 表示任意）、达成 param[6] 结局。
   * 岁兽残识中所有入队干员即为伺烛客（秉烛）。
   * 用例：「请君入园·6及以上，招募干员电弧，令至少6名干员成为伺烛客并达成结局'长卷留痕'」
   * （param=["1","rogue_5","NORMAL","6","char_4195_radian","6","ro5_ending_2"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 指定干员 id
   * @param param[5] 伺烛客数门槛（0=任意）
   * @param param[6] 结局 id
   */
  Rlv2EndingWithCandleChar: {
    "1": {
      init: (mission) => {
        mission.progress.push({ value: mission.value, target: 1 });
      },
      update: (
        mission,
        args: { theme: string; mode: string; grade: number; charIds: string[]; candleCharCount: number; ending: string },
      ) => {
        if (!matchesRlv2Context(mission, args)) return;
        if (args.ending !== mission.param[6]) return;
        if (!args.charIds.includes(mission.param[4])) return;
        const need = parseInt(mission.param[5]);
        if (need > 0 && args.candleCharCount < need) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 招募指定干员并通关任意紧急作战（Rlv2EliteBattleWithChar）
   *
   * 本局判定：招募 param[4] 干员、通关任意紧急作战（BATTLE_ELITE 节点）。
   * 用例：「请君入园·6及以上，招募干员电弧并通关任意紧急作战」
   * （param=["1","rogue_5","NORMAL","6","char_4195_radian"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 指定干员 id
   */
  Rlv2EliteBattleWithChar: {
    "1": {
      init: (mission) => {
        mission.progress.push({ value: mission.value, target: 1 });
      },
      update: (
        mission,
        args: { theme: string; mode: string; grade: number; charIds: string[]; eliteCount: number; ending: string },
      ) => {
        if (!matchesRlv2Context(mission, args)) return;
        if (!args.ending) return;
        if ((args.eliteCount ?? 0) < 1) return;
        if (!args.charIds.includes(mission.param[4])) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 指定关卡内达成战斗简单事件计数（Rlv2StageSimpleEventMore）
   *
   * 在主题/模式/难度门槛下，指定关卡 param[4] 中战斗简单事件 param[5]（如击杀"易"）按计数累计。
   * 用例：「请君入园·6及以上，使用电弧及其召唤物击杀'易'」
   * （param=["1","rogue_5","NORMAL","6","ro5_b_4","radian_kill_enemy_dylbhm","1"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 关卡 id
   * @param param[5] 简单事件键（extraBattleInfo 键）
   * @param param[6] 目标计数
   */
  Rlv2StageSimpleEventMore: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[6]),
        });
      },
      update: (
        mission,
        args: { theme: string; mode: string; grade: number; stageId: string; events: Record<string, number> },
      ) => {
        if (!matchesRlv2Context(mission, args)) return;
        if (args.stageId !== mission.param[4]) return;
        const count = args.events?.[mission.param[5]] ?? 0;
        mission.progress[0].value = Math.max(
          mission.progress[0].value,
          Math.min(count, mission.progress[0].target!),
        );
      },
    },
  },

  /**
   * 招募指定干员（Rlv2RecruitSpecificChar）
   *
   * 在指定主题中招募 param[2] 干员各计 1，达 param[3] 完成（可跨局累计）。
   * 用例：「招募机械师」「累计招募机械师3次」（param=["1","rogue_6","char_4230_mcnist","3"]）。
   * @param param[1] 主题 id
   * @param param[2] 指定干员 id
   * @param param[3] 目标招募次数
   */
  Rlv2RecruitSpecificChar: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[3]),
        });
      },
      update: (mission, args: { theme: string; charId: string }) => {
        if (args.theme !== mission.param[1]) return;
        if (args.charId !== mission.param[2]) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 进阶指定干员（Rlv2UpgradeSpecificChar）
   *
   * 在指定主题中招募时直接进阶（upgradePhase>=1，如 limited_direct_upgrade 直接进阶）的
   * param[2] 干员各计 1，达 param[3] 完成。
   * 用例：「进阶机械师」（param=["1","rogue_6","char_4230_mcnist","1"]）。
   * @param param[1] 主题 id
   * @param param[2] 指定干员 id
   * @param param[3] 目标进阶次数
   */
  Rlv2UpgradeSpecificChar: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[3]),
        });
      },
      update: (mission, args: { theme: string; charId: string }) => {
        if (args.theme !== mission.param[1]) return;
        if (args.charId !== mission.param[2]) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 探索被"居民"的恶意占据的节点（Rlv2MeetBandit）
   *
   * 在主题/模式/难度门槛下，抵达"居民"据点（BATTLE_SAVAGE）节点各计 1，达 param[4] 完成。
   * 用例：「探索1次被'居民'的恶意占据的节点」（param=["1","rogue_6","NORMAL","4","1"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 目标探索次数
   */
  Rlv2MeetBandit: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[4]),
        });
      },
      update: (mission, args: { theme: string; mode: string; grade: number }) => {
        if (!matchesRlv2Context(mission, args)) return;
        mission.progress[0].value += 1;
      },
    },
  },

  /**
   * 累计获得零件（Rlv2GainItem）
   *
   * 获得 param[2] 类型物品按数量累计，达 param[1] 完成。
   * 用例：「累计获得10个零件」（param=["1","10","SCRAP"]）。
   * @param param[1] 目标数量
   * @param param[2] 物品类型（SCRAP）
   */
  Rlv2GainItem: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[1]),
        });
      },
      update: (mission, args: { itemType: string; count: number }) => {
        if (args.itemType !== mission.param[2]) return;
        mission.progress[0].value += args.count || 1;
      },
    },
  },

  /**
   * 累计消耗行动力（Rlv2MoveCostAp）
   *
   * 在主题/模式/难度门槛下，网格移动消耗行动力按 cost 累计，达 param[4] 完成。
   * 用例：「累计消耗40行动力」（param=["1","rogue_6","NORMAL","0","40"]）。
   * @param param[1] 主题 id
   * @param param[2] 模式
   * @param param[3] 难度门槛
   * @param param[4] 目标行动力消耗
   */
  Rlv2MoveCostAp: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[4]),
        });
      },
      update: (mission, args: { theme: string; mode: string; grade: number; cost: number }) => {
        if (!matchesRlv2Context(mission, args)) return;
        mission.progress[0].value += args.cost || 1;
      },
    },
  },

  /**
   * 累计卖出零件（Rlv2ShopRecycle）
   *
   * 卖出 param[1] 类型物品按数量累计，达 param[2] 完成。
   * 用例：「累计卖出10个零件」（param=["1","SCRAP","10"]）。
   * @param param[1] 物品类型（SCRAP）
   * @param param[2] 目标数量
   */
  Rlv2ShopRecycle: {
    "1": {
      init: (mission) => {
        mission.progress.push({
          value: mission.value,
          target: parseInt(mission.param[2]),
        });
      },
      update: (mission, args: { itemType: string; count: number }) => {
        if (args.itemType !== mission.param[1]) return;
        mission.progress[0].value += args.count || 1;
      },
    },
  },
  // 奇象巡展（ARK_HUB）任务模板不在此文件：见 ./arkhub.ts（arkhubTemplates）
};
