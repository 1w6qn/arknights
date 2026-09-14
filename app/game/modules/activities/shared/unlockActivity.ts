/**
 * activity 播种（DoctoratePy unlockActivity 移植）
 *
 * 按（可能冻结的）时间戳 ts 播种/修剪（真实时间模式 ts = now()，同样执行）：
 * 按（可能冻结的）时间戳 ts：
 * - 修剪：`playerdata.activity[type][id]` 中 ts > rewardEndTime 的过期活动删除
 * - 播种：basicInfo 中 startTime <= ts <= rewardEndTime 的活动——
 *   BOSS_RUSH / TYPE_ACT* 默认状态、活动任务（ACTIVITY 任务组，可领取态）、
 *   ARK_HUB（奇象巡展方舟枢纽）活动状态、arkodc 主题（ODC 地图 varSeqs/rewards/position）
 * - 关卡：unlockCondition 链扫描解锁可达关卡（seed 语义，共享实现
 *   `@game/kernel/util/stage-unlock` 的 scanUnlockChain，与 battle.finishStoryStage/finish 同源）
 *
 * 真实时间模式（timestamp 缺省/-1）不做任何改动，保持现有行为。
 */
import { PlayerDataManager } from "../../../kernel/player-data-manager";
import { defaultAct44State } from "../act44side/public";
import excel from "@excel/excel";
import { userTimestamp } from "@utils/time";
import { syncAct44SideEntry } from "../act44side/public";
import { logger } from "@utils/logger";
import config from "@core/config/index";
import { scanUnlockChain } from "../../../kernel/util/stage-unlock";
import { resolveDictKey } from "../../../kernel/util/excel-key";
import type { Draft } from "mutative";
import type {
  MissionPlayerData,
  PlayerActivity,
  PlayerDataModel,
  PlayerStatus,
} from "../../../kernel/playerdata";
import { activityDetailJson, asShape, isJsonObjectValue } from "./activity-json";
import type { ServerPayload } from "@excel/json-value";

/** ActivityTable.basicInfo 条目消费面（真正读取的字段；来自 excel 生成类型） */
type BasicInfoEntry = {
  type: string;
  startTime: number;
  rewardEndTime: number;
  medalGroupId?: string;
  ungroupedMedalIds?: string[];
};

/** ARK_HUB 播种默认状态（登记形状的索引元素；squads 支持官服空槽 `{ slots: [] }`） */
type ArkhubSeedState = NonNullable<PlayerActivity["ARK_HUB"]>[string];

/** TYPE_ACT53SIDE 播种默认状态（官方形状：actCoin/campaignCnt/favorList） */
type Act53SideState = {
  actCoin: number;
  campaignCnt: number;
  favorList: string[];
};

/**
 * 强制开启的活动 ID 集合（config.activities.forceOpen，忽略时间窗口无条件播种/不修剪）
 * @returns 强制开启的 basicInfo.id 集合
 */
export function forcedActivityIds(): Set<string> {
  return new Set((config.activities?.forceOpen ?? []).filter(Boolean));
}

/** excel activity 字典键：首字母小写（basicInfo.type 大写枚举 → activity 键 bOSS_RUSH） */
function activityDetailKey(type: string): string {
  return type.charAt(0).toLowerCase() + type.slice(1);
}

/**
 * 从 excel ActivityTable.activity 字典按枚举名定位实际键
 *
 * 修复：excel activity 字典键随数据版本大小写多变（旧数据 dEFAULT/tYPE_ACT3D0 等
 * 坏键、解码规范的 default/typeAct3D0），代码按 lowerFirst(枚举) 读取恒有错位风险；
 * 改为大小写/下划线不敏感匹配——任意版本下都能命中实际键。
 * @param type - basicInfo.type 枚举名（如 "TYPE_ACT3D0" / "COLLECTION"）
 * @returns 字典实际键（未命中返回 undefined）
 *
 * 2026-09-13：纯函数部分上移 `@game/kernel/util/excel-key`（kernel 不再反向依赖本模块），
 * 本函数退化为「取 excel 单例字典 + 委托」的薄壳。
 */
export function activityDictKey(type: string): string | undefined {
  return resolveDictKey(excel.ActivityTable.activity, type);
}

/** BOSS_RUSH 默认遗物（relicList[0].relicId，缺省空） */
function defaultRelic(activityType: string, actId: string): string {
  const detail = asShape<{ relicList?: { relicId?: string }[] }>(
    activityDetailJson(
      excel.ActivityTable.activity,
      activityDictKey(activityType) ?? activityDetailKey(activityType),
      actId,
    ),
  );
  return detail?.relicList?.[0]?.relicId ?? "";
}

/** TYPE_ACT 信赖加成干员（charword startTimeWithTypeDict 按活动 startTime 匹配，缺省空） */
function favorListFor(startTime: number): string[] {
  try {
    const dict = excel.CharWordTable?.startTimeWithTypeDict;
    if (!dict) return [];
    for (const lang of Object.values(dict)) {
      for (const item of lang ?? []) {
        if (item?.timestamp === startTime && Array.isArray(item.charSet)) {
          return item.charSet;
        }
      }
    }
  } catch (error) {
    logger.warn("Activity", `charword 表读取失败，信赖列表留空: ${(error as Error).message}`);
  }
  return [];
}

/** ARK_HUB 活动默认状态（奇象巡展方舟枢纽；参考官服 syncData 快照形状） */
function defaultArkhubState(): ArkhubSeedState {
  // 空队伍槽 ×4（客户端展示 4 个可用编队位，参考官服快照 squads 数组形状）
  return {
    coin: 0,
    secretary: "",
    secretarySkinId: "",
    secretarySkinSp: false,
    protectTs: -1,
    squads: [
      { slots: [] },
      { slots: [] },
      { slots: [] },
      { slots: [] },
    ],
    globalBan: false,
    // ---- 私服扩展（官服快照无这些字段；客户端不读，供任务/勋章进度事件驱动）----
    // Phase 1 计数器
    duelCount: 0, // 奇象拟合对战完成次数（ArkhubPassDexBattle）
    dailySupplyDays: 0, // 每日物资领取天数（ArkhubDailyMissionCompleted）
    dailySupplyLastDay: "", // 每日物资最后领取自然日（每日限 1 次）
    creatureCollected: 0, // 已收录生物种类数（ArkhubCreatureCollection/勋章 02）
    activeCreatureCollected: 0, // 已收录"活动频繁"生物种类数（任务 12-14）
    alterCollected: 0, // 已收录亚种数（勋章 025 镀层）
    pixelCollected: 0, // 收集画像数（ArkhubCollectPixelArt/勋章 01）
    pixelPublished: 0, // 发布画像数（ArkhubPublishPixelArt）
    // Phase 2 ARKDEX 玩法状态
    dex: {}, // 生物数据库：{ [creatureNumId]: { numId, isAlter, alterOf? } }——首次/亚种收录
    scanBag: [], // 扫描仪个体列表（上限 400）：[{ id, numId, isAlter, alterOf?, fav, sourceUid }]
    scanSeq: 0, // 扫描仪个体自增 id（instId）
    props: {}, // 巡展道具箱：{ [itemNumId]: { count, uses } }（count=持有数，uses=剩余生效次数）
    trade: { wantSpecies: null, offerNumIds: [] }, // 交换站需求（1 条；wantSpecies 为种类 id 或 null）
    unlockedAreas: {}, // 保护区解锁：{ [areaId]: 1 }（守门人拟合胜利解锁）
  };
}

/**
 * 活动任务的目标进度（ActivityTable.missionData 模板）
 * @param mission - missionData 条目（id/template/param）
 * @returns 目标值；非既有模板返回 null（保持原"全可领"播种行为）
 */
function arkhubMissionTarget(
  mission: { template?: string; param?: string[] } | undefined,
): number | null {
  const tpl = mission?.template;
  // 奇象巡展（ARK_HUB）8 类模板
  if (tpl === "ArkhubMissionCompleted") return 1; // 引导（本服完成态，播种即完成）
  if (tpl === "ArkhubDailyMissionCompleted") return parseInt(mission?.param?.[4] ?? "");
  if (tpl === "ArkhubCreatureCollection") return parseInt(mission?.param?.[2] ?? "");
  if (tpl === "ArkhubCreatureCaptured") return parseInt(mission?.param?.[2] ?? "");
  if (tpl === "ArkhubCreatureExchange") return parseInt(mission?.param?.[2] ?? "");
  if (tpl === "ArkhubPassDexBattle") return parseInt(mission?.param?.[2] ?? "");
  if (tpl === "ArkhubPublishPixelArt") return parseInt(mission?.param?.[2] ?? "");
  if (tpl === "ArkhubCollectPixelArt") return parseInt(mission?.param?.[2] ?? "");
  // act53side（arkodc）模板——播种真实 target，value:0 走事件驱动真实进度
  if (tpl === "CompleteAnyStage") return 1; // 通关指定关 1 次（param[2]=通关状态门槛）
  if (tpl === "CompleteStageAct") return parseInt(mission?.param?.[2] ?? ""); // 累计通关次数（15/45/85）
  if (tpl === "ArkodcRewardGroupAtLeast") return parseInt(mission?.param?.[3] ?? ""); // 收集奖励组数量
  return null;
}

/**
 * 奇象巡展任务日期门控起点（param[2]，如 "2026-08-18 16:00:00"/"2026/8/18 16:00:00"）
 * @param param2 - missionData.param[2]
 * @returns 秒级时间戳（与 userTimestamp() 同单位）；非日期参数（引导 flag 等）返回 null
 */
function arkhubMissionWindowStart(param2?: string): number | null {
  if (!param2 || !/\d{4}/.test(param2)) return null;
  const norm = param2.replace(/\//g, "-");
  const ts = new Date(norm).getTime();
  return Number.isNaN(ts) ? null : Math.floor(ts / 1000);
}

/** TYPE_ACT53SIDE（安洁莉娜的旅行小记主活动 / ODC）默认状态（官方形状：actCoin/campaignCnt/favorList） */
function defaultAct53SideState(startTime: number): Act53SideState {
  return {
    actCoin: 0,
    campaignCnt: 0,
    favorList: favorListFor(startTime),
  };
}

/**
 * 勋章播种目标值推导（与 player/medal.ts 各模板 init 的 target 保持一致，
 * 修改任一模板 target 语义时需同步本函数）
 * @param medalInfo - MedalTable.medalList 条目
 * @returns 目标值（无模板/纯展示章返回 0——MedalProgress 不注册监听）
 */
function medalSeedTarget(
  medalInfo: { template?: string; unlockParam?: string[] } | undefined,
): number {
  const tpl = medalInfo?.template;
  const p = medalInfo?.unlockParam ?? [];
  if (!tpl) return 0;
  if (tpl === "GotCharsBeforeTime") return 1;
  if (tpl === "ActivityCoinCost") return parseInt(p[2]) || 1;
  if (tpl === "MissionCompleteSome") {
    const s = String(p[0] ?? "");
    return s.includes(";") ? s.split(";").length : parseInt(s) || 1;
  }
  if (tpl === "ArkodcVarSeqAtLeast") return parseInt(p[2]) || 1;
  if (tpl === "PassStageWithSimpleCountMore") return parseInt(p[4]) || 1;
  if (tpl === "PassStageSome") return parseInt(p[2]) || 1;
  if (tpl === "TotalSimpleTokenCount") return parseInt(p[2]) || 1;
  return parseInt(p[0]) || 1; // 兜底（通用 target=param[0]）
}

/**
 * 播种活动的勋章组到 playerdata.medal.medals
 * @param draft - 玩家数据 draft
 * @param actId - 活动 id（basicInfo[actId].medalGroupId 指定组）
 *
 * 仿 act1arkhub ungroupedMedalIds 播种：组勋章先入存档，MedalManager.init 才会创建
 * MedalProgress 并注册事件监听 → 事件驱动的真实进度/完成才生效（act53side 6 个
 * 重写的勋章模板即依赖此）。含 advancedMedal（如 medal_activity_53side_105）一并播种。
 */
function seedMedalGroup(draft: Draft<PlayerDataModel>, actId: string): void {
  const info = excel.ActivityTable?.basicInfo?.[actId];
  if (!info?.medalGroupId) return;
  const groupData = excel.MedalTable?.medalTypeData?.["activityMedal"]?.groupData;
  const group = (groupData ?? []).find((g) => g.groupId === info.medalGroupId);
  if (!group) return;
  draft.medal = draft.medal ?? { medals: {}, custom: { currentIndex: "", customs: {} } };
  const ids = [...(group.medalId ?? [])];
  for (const m of excel.MedalTable?.medalList ?? []) {
    if (ids.includes(m.medalId) && m.advancedMedal && !ids.includes(m.advancedMedal)) {
      ids.push(m.advancedMedal);
    }
  }
  for (const medalId of ids) {
    if (draft.medal.medals[medalId]) continue;
    const mi = excel.MedalTable?.medalList?.find((m) => m.medalId === medalId);
    if (!mi) continue;
    draft.medal.medals[medalId] = {
      id: medalId,
      // target 与模板 init 一致（val=[[0,target]]）：target=0 的纯展示章不注册进度监听
      val: [[0, medalSeedTarget(mi)]],
      fts: 0,
      rts: -1,
    };
  }
}

/**
 * 播种 arkodc 主题（ODC 地图状态：topics[topicId].varSeqs/rewards/position）
 * topicId 取自 activity.tYPE_ACT53SIDE[actId].constData.arkOdcTopicId
 */
function seedArkOdcTopics(draft: Draft<PlayerDataModel>): void {
  // 修复：硬编码坏键 tYPE_ACT53SIDE → 动态查键（数据版本键名多变）
  const detail = excel.ActivityTable.activity[
    activityDictKey("TYPE_ACT53SIDE") ?? "tYPE_ACT53SIDE"
  ];
  if (!isJsonObjectValue(detail)) return;
  for (const [actId, data] of Object.entries(detail)) {
    const topicId = asShape<{ constData?: { arkOdcTopicId?: string } }>(
      data,
    )?.constData?.arkOdcTopicId;
    if (!topicId) continue;
    if (!draft.arkodc) draft.arkodc = { topics: {} };
    if (!draft.arkodc.topics) draft.arkodc.topics = {};
    if (!draft.arkodc.topics[topicId]) {
      draft.arkodc.topics[topicId] = {
        varSeqs: {},
        rewards: {},
        position: { x: 0, y: 0, z: 0 },
      };
    }
  }
}

/**
 * 播种单个活动（默认状态 + 活动任务），忽略时间窗口（强制开启与窗口内活动共用）
 * @param draft - 玩家数据 draft
 * @param actId - 活动 ID（basicInfo.id）
 * @param info  - basicInfo 条目
 * @param ts    - （可能冻结的）当前时间戳
 */
function seedActivityState(
  draft: Draft<PlayerDataModel>,
  actId: string,
  info: BasicInfoEntry,
  ts: number,
): void {
  const type = info.type;
  draft.activity[type] = draft.activity[type] || {};
  const existing = draft.activity[type][actId];

  if (type === "BOSS_RUSH" && !existing) {
    const relic = defaultRelic(type, actId);
    const bossRush = (draft.activity.BOSS_RUSH ??= {});
    bossRush[actId] = {
      milestone: { point: 0, got: [] },
      relic: {
        token: { current: 0, total: 0 },
        unlockedRelicLevelDic: relic ? { [relic]: 1 } : {},
        selectingRelicId: "",
      },
      bestWaveDic: {},
    };
  } else if (type === "ARK_HUB" && !existing) {
    // 奇象巡展方舟枢纽（官方形状：coin/secretary/squads/globalBan）
    const arkhub = (draft.activity.ARK_HUB ??= {});
    arkhub[actId] = defaultArkhubState();
  } else if (type === "TYPE_ACT53SIDE" && !existing) {
    // 安洁莉娜的旅行小记主活动（act53side / ODC；官方形状：actCoin/campaignCnt/favorList，与通用 TYPE_ACT 的 coin/news 不同）
    const act53 = (draft.activity.TYPE_ACT53SIDE ??= {});
    act53[actId] = defaultAct53SideState(info.startTime);
  } else if (type === "TYPE_ACT44SIDE" && !existing) {
    // 「墟」情报屋主状态（官服抓包形状：informantPt/milestone/businessDay/
    // unlockedCustomers/unlockedTags/outerOpen，营业会话 game 缺省 null——
    // 由 /activity/act44side/* 路由按需创建）
    const act44 = (draft.activity.TYPE_ACT44SIDE ??= {});
    act44[actId] = defaultAct44State(favorListFor(info.startTime));
  } else if (type.startsWith("TYPE_ACT") && !existing) {
    // 通用 TYPE_ACT* 播种三件套（coin/favorList/news）。news 为第三层嵌套，而兜底
    // 索引签名的 ServerPayload 只展开两层——按已构造 JSON 收窄为存档形状。
    const genericState = asShape<ServerPayload>({
      coin: 0,
      favorList: favorListFor(info.startTime),
      news: {},
    });
    if (genericState !== undefined) draft.activity[type][actId] = genericState;
  }

  // 活动任务：missionGroup[id].missionIds → ACTIVITY 组播种。
  // 奇象巡展（1arkhubActivity_*）：按 8 类模板播种真实进度（value:0 → 事件驱动），
  // 引导任务（ArkhubMissionCompleted）因本服引导为完成态播种即完成（state:2+满进度，
  // 与既有"可领取态"行为一致）；param 日期起点在未来的任务（8/18 更新后）锁定 state:0。
  // 其余活动任务保持原行为（state:2 + value==target，可直接领取）。
  const group = excel.ActivityTable.missionGroup.find((g) => g.id === actId);
  if (group) {
    draft.mission.missions["ACTIVITY"] = draft.mission.missions["ACTIVITY"] || {};
    for (const missionId of group.missionIds) {
      if (draft.mission.missions["ACTIVITY"][missionId]) continue;
      const missionDef = excel.ActivityTable.missionData.find(
        (m) => m.id === missionId,
      );
      const target = missionDef ? arkhubMissionTarget(missionDef) : null;
      if (target !== null) {
        const guide = missionDef?.template === "ArkhubMissionCompleted";
        // 日期门控仅对奇象巡展任务计算（Act53side/官本模板的 param[2] 是门槛/目标数字，
        // 无日期；且这些任务播种应 value:0 走真实进度，不能因误判被 locked）
        const arkhubTask = String(missionDef?.template ?? "").startsWith("Arkhub");
        const windowStart = arkhubTask
          ? arkhubMissionWindowStart(missionDef?.param?.[2])
          : null;
        const locked = windowStart !== null && ts < windowStart;
        // 渐进引导（config.arkhub.guideProgressive）：引导任务按 flag 语义播种进行中——
        // capture_catch_guide_02（任务 2 捕抓引导）/arkdex_battle_guide（任务 3 对决引导）
        // 由引导对话推进完成（交互帧 actor → arkhubAdvanceGuide）；capture_catch_guide_01
        // （任务 1 夏妮）对话 actor 未确认，保持完成态可领。
        const progressiveGuide =
          config.arkhub?.guideProgressive &&
          guide &&
          (missionDef.param?.[2] === "capture_catch_guide_02" ||
            missionDef.param?.[2] === "arkdex_battle_guide");
        draft.mission.missions["ACTIVITY"][missionId] = {
          state: locked ? 0 : 2,
          progress: [{ value: guide && !progressiveGuide ? target : 0, target }],
        };
      } else {
        draft.mission.missions["ACTIVITY"][missionId] = {
          state: 2,
          progress: [{ value: 1, target: 1 }],
        };
      }
    }
  }
}

/**
 * 复刻活动开始：重置未完成的活动蚀刻章进度（幂等，flags 标记）
 *
 * 官服规则（「墟」复刻公告 2026-08-22 / PRTS「空想花庭」复刻说明）：复刻期间活动
 * 任务/计数进度重置，首次活动未获得的蚀刻章需从头收集（进度清零）；已获得的章保留。
 * 服务端此前从不重置——玩家复刻前遗留的半成品章进度原样保留，复刻无法重新达成。
 * 每个复刻活动仅在其开始后重置一次（draft.status.flags `retroMedalReset_<actId>` 标记），
 * 避免复刻进行中每次登录清空玩家新进度。
 *
 * @param draft - player.update 的 draft
 * @param basicInfo - ActivityTable.basicInfo（复刻活动条目 id 以 sre 结尾）
 * @param ts - 当前时间基准（秒）
 */
function resetRetroMedals(
  draft: Draft<PlayerDataModel>,
  basicInfo: Record<string, BasicInfoEntry>,
  ts: number,
): void {
  for (const [actId, info] of Object.entries(basicInfo)) {
    if (!info || typeof info !== "object") continue;
    // 复刻活动（id 以 sre 结尾，如 act43sre/act24sre）
    if (!String(actId).endsWith("sre")) continue;
    // 复刻尚未开始 → 不重置（未开始的复刻不清既有进度）
    if (!(info.startTime <= ts)) continue;
    if (!info.medalGroupId) continue;
    // 幂等：已执行过重置的复刻不再重复
    const flagKey = `retroMedalReset_${actId}`;
    if (draft.status?.flags?.[flagKey] === 1) {
      continue;
    }
    const groupData = excel.MedalTable?.medalTypeData?.["activityMedal"]?.groupData;
    const group = (groupData ?? []).find(
      (g) => g?.groupId === info.medalGroupId,
    );
    if (!group?.medalId || !Array.isArray(group.medalId)) continue;
    draft.status = draft.status ?? ({} as PlayerStatus);
    draft.status.flags = draft.status.flags ?? {};
    let reset = 0;
    for (const medalId of group.medalId) {
      const m = draft.medal?.medals?.[medalId];
      if (!m || typeof m !== "object") continue;
      // 已获得的章（rts > 0）保留，不重复收集
      if ((m.rts ?? -1) > 0) continue;
      const mi = excel.MedalTable?.medalList?.find(
        (x) => x?.medalId === medalId,
      );
      m.val = [[0, medalSeedTarget(mi)]];
      m.fts = 0;
      m.rts = -1;
      reset += 1;
    }
    draft.status.flags[flagKey] = 1;
    if (reset > 0) {
      logger.info(
        "Activity",
        `复刻活动开始：重置 ${reset} 枚未完成蚀刻章进度（${actId}）`,
      );
    }
  }
}

/**
 * 活动播种入口（冻结模式/真实时间模式均执行）
 * @param player - 目标玩家
 */
export async function unlockActivity(player: PlayerDataManager): Promise<void> {
  // 修复：原仅冻结模式（活动切换开启）执行，真实时间（-1/缺省）为 no-op——
  // 真实模式下 userTimestamp() = now()，窗口内活动（如 TYPE_ACT53SIDE（安洁莉娜的旅行小记）/
  // ARK_HUB）从不播种 → 客户端活动状态缺失 → ODC 新手教程卡死、无人物模型。
  // 播种/修剪逻辑本身按 ts 窗口判定，真实模式即按当前时间正确播种当前活动。
  const ts = userTimestamp();
  // 强制开启的活动（config.activities.forceOpen）：忽略时间窗口播种且不修剪
  const forced = forcedActivityIds();
  await player.update(async (draft) => {
    const basicInfo = excel.ActivityTable?.basicInfo ?? {};

    // 修剪：过期活动删除（ts > rewardEndTime）；强制开启的跳过（保持始终开放）
    if (draft.activity) {
      for (const type of Object.keys(draft.activity)) {
        for (const actId of Object.keys(draft.activity[type])) {
          if (forced.has(actId)) continue;
          const info = basicInfo[actId];
          if (info && ts > info.rewardEndTime) {
            // 有该活动关卡进度的条目不修剪：官方语义旧活动玩家态随进度长期保留
            // （如 act31side 商店历史在过期很久后仍随 syncData 下发）；否则窗口外
            // 推完关卡的情报屋等状态会在下次登录被清空 → 入口重新锁死
            const hasStageProgress = Object.keys(draft.dungeon?.stages ?? {}).some(
              (sid) => sid.startsWith(`${actId}_`),
            );
            if (!hasStageProgress) delete draft.activity[type][actId];
          }
        }
      }
    } else {
      draft.activity = {};
    }

    // 任务组播种依赖（ACTIVITY 任务组可能被 MissionManager.init 清空——播种在其后执行）
    draft.mission = draft.mission || ({} as MissionPlayerData);
    draft.mission.missions = draft.mission.missions || {};

    // 播种：窗口内活动 + 强制开启活动（默认状态 + 活动任务 + 关卡）
    for (const [actId, info] of Object.entries(basicInfo)) {
      // 防御：basicInfo 含 null 占位条目（20/331）
      if (!info || typeof info !== "object") continue;
      const isForced = forced.has(actId);
      if (!isForced && !(info.startTime <= ts && ts <= info.rewardEndTime)) continue;
      seedActivityState(draft, actId, info, ts);
      // 活动勋章组播种（medalGroupId → playerdata.medal.medals）——使 MedalProgress
      // 可注册监听、事件驱动真实追踪。原实现只对 TYPE_ACT53SIDE 特判；泛化到所有
      // 已播种且带 medalGroupId 的活动（别传/主活动统一受益，含 act53side/act49side）
      if (info.medalGroupId) seedMedalGroup(draft, actId);
    }
    // 复刻活动开始：重置未完成的活动蚀刻章进度（官服复刻规则，幂等 flags 标记）——
    // 必须在 seedMedalGroup 之后执行（章条目先播种/存在于存档才可重置）
    resetRetroMedals(draft, basicInfo, ts);
    // 强制开启但不在 basicInfo 中的 ID：无法播种，记录告警（大小写不敏感匹配常见笔误）
    for (const id of forced) {
      if (!basicInfo[id]) {
        const fuzzy = Object.keys(basicInfo).find((k) => k.toLowerCase() === id.toLowerCase());
        logger.warn(
          "Activity",
          `强制开启活动 ${id} 不在 basicInfo（${fuzzy ? `疑似应为 ${fuzzy}` : "无近似匹配"}），已忽略`,
        );
      }
    }

    // 奇象巡展勋章播种：activity.ARK_HUB 已播种时，把 ungroupedMedalIds 的两枚勋章
    // （巡展印象/珍奇奖章）写入 playerdata.medal.medals（val=[[0,target]]）。
    // 注意：MedalManager.init 先于播种执行——本会话内存 map 不含新勋章，进度监听
    // 自下次加载生效（模板已实现，不会 "not implemented" throw）；syncInfo 会推送。
    if (draft.activity.ARK_HUB?.act1arkhub && !draft.medal?.medals?.["medal_activity_1arkhub_01"]) {
      draft.medal = draft.medal ?? { medals: {}, custom: { currentIndex: "", customs: {} } };
      const info = excel.ActivityTable?.basicInfo?.["act1arkhub"];
      for (const medalId of info?.ungroupedMedalIds ?? []) {
        if (draft.medal.medals[medalId]) continue;
        const medalInfo = excel.MedalTable?.medalList?.find((m) => m.medalId === medalId);
        if (!medalInfo) continue;
        const target = parseInt(medalInfo.unlockParam?.[2] ?? "0") || 1;
        draft.medal.medals[medalId] = {
          id: medalId,
          val: [[0, target]],
          fts: 0,
          rts: -1,
        };
      }
    }

    // ODC 主题（playerdata.arkodc.topics[topicId]）——客户端据此渲染 ODC 地图状态
    seedArkOdcTopics(draft);

    // ODC 教程状态回填：教程剧情已提交（status.flags 已置 1）但主题
    // varSeq bool_end_guide_done 缺失的旧存档（finishStory 未同步 varSeq 时期的漏洞）——
    // logic_game_end_p1（q003_prog==4 && bool_end_guide_done==0 && q003_banner_showed==1）
    // 每次进图 AUTO_ONCE 重放新手教程，需补置为 1（官服完成态快照含 bool_end_guide_done=1）。
    const odcGuideStoryId = "activities/act53side/ark_odc_act53side_guide";
    if (draft.status?.flags?.[odcGuideStoryId] === 1) {
      const detail = excel.ActivityTable.activity[
        activityDictKey("TYPE_ACT53SIDE") ?? "tYPE_ACT53SIDE"
      ];
      for (const data of isJsonObjectValue(detail) ? Object.values(detail) : []) {
        const topicId = asShape<{ constData?: { arkOdcTopicId?: string } }>(
          data,
        )?.constData?.arkOdcTopicId;
        const topic = topicId ? draft.arkodc?.topics?.[topicId] : undefined;
        if (topic?.varSeqs) {
          topic.varSeqs.bool_end_guide_done = 1;
        }
      }
    }

    // 关卡：unlockCondition 链扫描解锁可达关卡（共享实现 seed 语义——
    // 全表可达性扫描、rank ?? 0 宽档位、#f#/hard_/tr_ 标记 noCostCnt=0，
    // 与原 unlockStages 内联实现逐分支等价）
    scanUnlockChain(draft, undefined, {
      mode: "seed",
      noCost: { noCostByMarker: true },
    });

    // 情报屋（TYPE_ACT44SIDE）：关卡链已推进但活动状态缺失（如迁移存档已通关
    // AT-TR-1、或窗口外打过关卡）——按关卡进度自愈播种。客户端情报屋入口
    // Status 计算需要 TYPE_ACT44SIDE[actId] 非空，否则恒 LOCKED（官服语义：
    // 状态随进度事件创建，不依赖播种窗口）
    syncAct44SideEntry(draft);
  });
  // 播种后重建 ACTIVITY 任务进度实例（MissionManager.init 先于播种执行，播种任务
  // 无监听器——重建后奇象巡展 8 类模板的事件驱动进度才能生效）
  await player.mission?.reloadActivity?.().catch((error) => {
    logger.warn("Activity", `活动任务监听器重建失败: ${(error as Error).message}`);
  });
}
