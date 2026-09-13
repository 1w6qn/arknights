/**
 * 危机合约路由模块
 *
 * 处理危机合约相关的 HTTP 请求，包括危机合约V1/V2、重构符文等功能。
 * 参考实现：reference/opendoctoratepy-ex-public/server/crisis.py
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { Draft } from "mutative";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import {
  listCrisisSeasons,
  CRISIS_JSON_BASE_PATH,
  CRISIS_V2_JSON_BASE_PATH,
} from "./crisis-seasons";
import { validateBody } from "@core/http/validate-body";
import {
  crisisBuyGoodsSchema,
  crisisChallengeRewardAllSchema,
  crisisChallengeRewardPointSchema,
  crisisChallengeRewardTaskSchema,
  crisisGetAllItemsSchema,
  crisisGetGoodListSchema,
  crisisGetInfoSchema,
  crisisUnlockMapRankSchema,
  crisisUnlockRuneSchema,
  crisisV1BattleFinishSchema,
  crisisV1BattleStartSchema,
  crisisV2BattleFinishSchema,
  crisisV2BattleStartSchema,
  crisisV2BuyGoodSchema,
  crisisV2ConfirmMissionsSchema,
  crisisV2GetGoodListSchema,
  crisisV2GetInfoSchema,
  crisisV2GetSnapshotSchema,
  recalRuneBattleFinishSchema,
  recalRuneBattleStartSchema,
} from "./crisis.schema";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import type { PlayerCrisis, PlayerDataModel } from "../../kernel/playerdata";
import {
  asCrisisV1Permanent,
  crisisV1SeasonView,
  crisisV1SeasonsView,
  crisisV2SeasonsView,
  type CrisisV1File,
  type CrisisV1SeasonReady,
  type CrisisV1SeasonView,
  type CrisisV1TemporaryJson,
  type CrisisV2File,
  type CrisisV2MapDetailJson,
  type CrisisV2SeasonReady,
  type CrisisV2SeasonView,
} from "./crisis-data";
import { recordPurchase } from "../../kernel/util/purchase-record";
import { now } from "@utils/time";
import { readJson } from "@utils/file";
import { decryptBattleData } from "@utils/crypt";
import type { BattleData } from "../../kernel/battle-model";
import excel from "@excel/excel";
import { logger } from "@utils/logger";
import config from "@core/config/index";
import {
  CrisisBuyGoodsRequest,
  CrisisBuyGoodsResponse,
  CrisisChallengeRewardAllRequest,
  CrisisChallengeRewardAllResponse,
  CrisisChallengeRewardPointRequest,
  CrisisChallengeRewardPointResponse,
  CrisisChallengeRewardTaskRequest,
  CrisisChallengeRewardTaskResponse,
  CrisisGetAllItemsRequest,
  CrisisGetAllItemsResponse,
  CrisisGetGoodListRequest,
  CrisisGetGoodListResponse,
  CrisisGetInfoRequest,
  CrisisGetInfoResponse,
  CrisisUnlockMapRankRequest,
  CrisisUnlockMapRankResponse,
  CrisisUnlockRuneRequest,
  CrisisUnlockRuneResponse,
  CrisisV1BattleFinishRequest,
  CrisisV1BattleFinishResponse,
  CrisisV1BattleStartRequest,
  CrisisV1BattleStartResponse,
  CrisisV2BattleFinishRequest,
  CrisisV2BattleFinishResponse,
  CrisisV2BattleStartRequest,
  CrisisV2BattleStartResponse,
  CrisisV2BuyGoodRequest,
  CrisisV2BuyGoodResponse,
  CrisisV2ConfirmMissionsRequest,
  CrisisV2ConfirmMissionsResponse,
  CrisisV2GetGoodListRequest,
  CrisisV2GetGoodListResponse,
  CrisisV2GetInfoRequest,
  CrisisV2GetInfoResponse,
  CrisisV2GetSnapshotRequest,
  CrisisV2GetSnapshotResponse,
  RecalRuneBattleFinishRequest,
  RecalRuneBattleFinishResponse,
  RecalRuneBattleStartRequest,
  RecalRuneBattleStartResponse,
} from "./crisis";

// ==================== 常量定义 ====================

/** 默认选中的危机合约V1赛季文件名（对应 data/crisis/cc1.json；被 config.activities.crisisV1 覆盖） */
const DEFAULT_SELECTED_CRISIS = "cc1";
/** 默认选中的危机合约V2赛季文件名（对应 data/crisisV2/cc1.json；被 config.activities.crisisV2 覆盖） */
const DEFAULT_SELECTED_CRISIS_V2 = "cc1";
/** 一天的秒数 */
const ONE_DAY_SECONDS = 86400;
/** 固定战斗ID（与参考实现一致） */
const BATTLE_ID = "abcdefgh-1234-5678-a1b2c3d4e5f6";

// 赛季选择（自定义活动切换：config.activities.crisisV1/V2）相关数据查询见危机合约赛季服务
// ../crisis-seasons（listCrisisSeasons / CRISIS_JSON_BASE_PATH / CRISIS_V2_JSON_BASE_PATH）。

/**
 * 选中危机合约V1赛季（config.activities.crisisV1；文件不存在时回退默认 cc1）
 * @returns 赛季 id
 */
async function selectedCrisisV1(): Promise<string> {
  const wanted = config.activities?.crisisV1 || DEFAULT_SELECTED_CRISIS;
  const seasons = await listCrisisSeasons();
  if (seasons.v1.includes(wanted)) return wanted;
  if (wanted !== DEFAULT_SELECTED_CRISIS) {
    logger.warn("crisis", `配置 crisisV1=${wanted} 不存在 data/crisis/ 目录，回退 ${DEFAULT_SELECTED_CRISIS}`);
  }
  return DEFAULT_SELECTED_CRISIS;
}

/**
 * 选中危机合约V2赛季（config.activities.crisisV2；文件不存在时回退默认 cc1）
 * @returns 赛季 id
 */
async function selectedCrisisV2(): Promise<string> {
  const wanted = config.activities?.crisisV2 || DEFAULT_SELECTED_CRISIS_V2;
  const seasons = await listCrisisSeasons();
  if (seasons.v2.includes(wanted)) return wanted;
  if (wanted !== DEFAULT_SELECTED_CRISIS_V2) {
    logger.warn("crisis", `配置 crisisV2=${wanted} 不存在 data/crisisV2/ 目录，回退 ${DEFAULT_SELECTED_CRISIS_V2}`);
  }
  return DEFAULT_SELECTED_CRISIS_V2;
}

// ==================== 接口定义 ====================

/** 危机合约V1战斗上下文 */
interface CrisisV1BattleContext {
  /** 选中的危机合约赛季 */
  chosenCrisis: string;
  /** 关卡ID（勋章 CrisisStageScoreSome / CrisisStageScoreBeforeTime 按 unlockParam[1] 门控） */
  stageId: string;
  /** 选中的风险符文列表 */
  chosenRisks: string[];
  /** 总风险等级 */
  totalRisks: number;
}

/** 危机合约V2战斗上下文 */
interface CrisisV2BattleContext {
  /** 地图ID */
  mapId: string;
  /** 赛季ID（勋章赛季门控用） */
  seasonId: string;
  /** 符文槽位列表 */
  runeSlots: string[];
  /** 是否携带助战（CrisisV2UseAssist：使用助战并通关 N 次） */
  usedAssist: boolean;
}

/** 重构符文战斗上下文 */
interface RecalRuneBattleContext {
  /** 赛季ID */
  seasonId: string;
  /** 关卡ID */
  stageId: string;
  /** 符文列表 */
  runes: string[];
  /** 槽位列表 */
  slots: unknown[];
  /** 助战好友信息 */
  assistFriend: unknown;
}

/** 重构符文关卡数据（由 excel 表类型派生；业务代码不直连生成类型模块） */
type RecalRuneStageData =
  (typeof excel.CrisisV2SharedData)["recalRuneData"]["seasons"][string]["stages"][string];

// ==================== 战斗上下文存储类 ====================

/**
 * 危机合约战斗上下文存储类
 *
 * 在 battleStart 和 battleFinish 之间临时保存战斗上下文数据，
 * 替代 Python 参考实现中的 RUNE_JSON_PATH 临时文件方案。
 * 按玩家 UID 隔离，支持多玩家并发。
 */
class CrisisBattleStore {
  /** V1战斗上下文，按UID索引 */
  private v1Store = new Map<string, CrisisV1BattleContext>();
  /** V2战斗上下文，按UID索引 */
  private v2Store = new Map<string, CrisisV2BattleContext>();
  /** 重构符文战斗上下文，按UID索引 */
  private recalStore = new Map<string, RecalRuneBattleContext>();

  /**
   * 保存危机合约V1战斗上下文
   * @param uid - 玩家UID
   * @param ctx - V1战斗上下文
   */
  setV1(uid: string, ctx: CrisisV1BattleContext): void {
    this.v1Store.set(uid, ctx);
  }

  /**
   * 获取危机合约V1战斗上下文
   * @param uid - 玩家UID
   * @returns V1战斗上下文，不存在返回undefined
   */
  getV1(uid: string): CrisisV1BattleContext | undefined {
    return this.v1Store.get(uid);
  }

  /**
   * 保存危机合约V2战斗上下文
   * @param uid - 玩家UID
   * @param ctx - V2战斗上下文
   */
  setV2(uid: string, ctx: CrisisV2BattleContext): void {
    this.v2Store.set(uid, ctx);
  }

  /**
   * 获取危机合约V2战斗上下文
   * @param uid - 玩家UID
   * @returns V2战斗上下文，不存在返回undefined
   */
  getV2(uid: string): CrisisV2BattleContext | undefined {
    return this.v2Store.get(uid);
  }

  /**
   * 保存重构符文战斗上下文
   * @param uid - 玩家UID
   * @param ctx - 重构符文战斗上下文
   */
  setRecal(uid: string, ctx: RecalRuneBattleContext): void {
    this.recalStore.set(uid, ctx);
  }

  /**
   * 获取重构符文战斗上下文
   * @param uid - 玩家UID
   * @returns 重构符文战斗上下文，不存在返回undefined
   */
  getRecal(uid: string): RecalRuneBattleContext | undefined {
    return this.recalStore.get(uid);
  }
}

// ==================== 数据缓存类 ====================

/**
 * 危机合约数据缓存类
 *
 * 缓存从JSON文件加载的危机合约静态数据，避免每次请求都读取文件。
 * 数据文件为只读静态资源，缓存后无需失效。
 */
class CrisisDataCache {
  /** V1数据缓存，按赛季文件名索引 */
  private v1Cache = new Map<string, CrisisV1File>();
  /** V2数据缓存，按赛季文件名索引 */
  private v2Cache = new Map<string, CrisisV2File>();

  /**
   * 获取危机合约V1赛季数据
   * @param crisisId - 赛季文件名（如 "cc1"）
   * @returns V1赛季数据对象
   */
  async getV1Data(crisisId: string): Promise<CrisisV1File> {
    if (!this.v1Cache.has(crisisId)) {
      const data = await readJson<CrisisV1File>(
        `${CRISIS_JSON_BASE_PATH}${crisisId}.json`,
      );
      this.v1Cache.set(crisisId, data);
    }
    return this.v1Cache.get(crisisId)!;
  }

  /**
   * 获取危机合约V2赛季数据
   * @param crisisId - 赛季文件名（如 "cc1"）
   * @returns V2赛季数据对象
   */
  async getV2Data(crisisId: string): Promise<CrisisV2File> {
    if (!this.v2Cache.has(crisisId)) {
      const data = await readJson<CrisisV2File>(
        `${CRISIS_V2_JSON_BASE_PATH}${crisisId}.json`,
      );
      this.v2Cache.set(crisisId, data);
    }
    return this.v2Cache.get(crisisId)!;
  }
}

// ==================== 模块级单例 ====================

/** 战斗上下文存储实例 */
const battleStore = new CrisisBattleStore();
/** 数据缓存实例 */
const dataCache = new CrisisDataCache();

// ==================== 辅助函数 ====================

/**
 * 构建危机合约V1赛季的临时数据结构
 *
 * 与参考实现一致，每个赛季的 temporary 字段包含默认的日程、积分和挑战信息。
 * @param nextDay - 下一天的Unix时间戳
 * @returns 临时数据对象
 */
function buildSeasonTemporary(nextDay: number): CrisisV1TemporaryJson {
  /** 构建积分列表，键为0-8，值均为-1 */
  const pointList: { [key: string]: number } = {};
  for (let i = 0; i <= 8; i++) {
    pointList[String(i)] = -1;
  }
  return {
    schedule: "rg1",
    nst: nextDay,
    point: -1,
    challenge: {
      taskList: {
        dailyTask_1: {
          fts: -1,
          rts: -1,
        },
      },
      topPoint: -1,
      pointList,
    },
  };
}

/**
 * 取（必要时创建）危机合约V1某赛季的玩家记录
 *
 * 官服形状（`data/user/databases/1.json` → `crisis.season[rune_season_X_Y]`）：
 * `{ coin, tCoin, permanent: { rune, point, challenge: { taskList, topPoint, pointList } }, temporary, sInfo }`。
 * 私服存档可能完全没有该赛季条目，直接下标会 500。
 * @param draft - 玩家数据草稿
 * @param seasonId - 赛季 id（如 rune_season_1_1）
 * @returns 该赛季的玩家记录（permanent 各子块已补齐）
 */
function ensureCrisisV1Season(draft: Draft<PlayerDataModel>, seasonId: string): CrisisV1SeasonReady {
  // 整块缺失时先建空对象（生成模型 crisis 各字段必填，按「先建后补齐」的既有语义断言）
  if (!draft.crisis) draft.crisis = {} as PlayerCrisis;
  if (!draft.crisis.season) draft.crisis.season = {};
  const seasons = crisisV1SeasonsView(draft);
  if (!seasons[seasonId]) seasons[seasonId] = {};
  const season = seasons[seasonId]!;
  if (season.coin == null) season.coin = 0;
  if (season.tCoin == null) season.tCoin = 0;
  if (!season.permanent) season.permanent = {};
  const perm = asCrisisV1Permanent(season.permanent);
  if (!perm.rune) perm.rune = {};
  if (perm.point == null) perm.point = -1;
  if (!perm.challenge) perm.challenge = {};
  if (!perm.challenge.taskList) perm.challenge.taskList = {};
  if (perm.challenge.topPoint == null) perm.challenge.topPoint = -1;
  if (!perm.challenge.pointList) perm.challenge.pointList = {};
  if (!season.temporary) season.temporary = {};
  if (!season.sInfo) season.sInfo = { assistCnt: 0, maxPnt: 0 };
  // 上方已逐个补齐 permanent 各子块；视图两侧兼容（Ready ⊂ View），故断言安全
  return season as CrisisV1SeasonReady;
}

/**
 * 取（必要时创建）危机合约V2某赛季的玩家记录
 *
 * 官服形状（`crisisV2.seasons[seasonId]`）：`{ permanent: { state, scoreTotal, scoreSingle,
 * rune, challenge, comment, exRunes, runePack, reward }, temporary: { [mapId]: { state, scoreTotal,
 * rune, challenge } }, social }`（见 types-playerdata PlayerCrisisV2Season*）。
 * @param draft - 玩家数据草稿
 * @param seasonId - 赛季 id（如 crisis_v2_season_1_1）
 * @returns 该赛季的玩家记录（permanent 各子块已补齐）
 */
function ensureCrisisV2Season(draft: Draft<PlayerDataModel>, seasonId: string): CrisisV2SeasonReady {
  if (!draft.crisisV2) draft.crisisV2 = {} as PlayerDataModel["crisisV2"];
  if (!draft.crisisV2.seasons) draft.crisisV2.seasons = {};
  const seasons = crisisV2SeasonsView(draft);
  if (!seasons[seasonId]) seasons[seasonId] = {};
  const season = seasons[seasonId]!;
  if (!season.permanent) season.permanent = {};
  const perm = season.permanent;
  if (perm.state == null) perm.state = 0;
  if (!Array.isArray(perm.scoreTotal)) perm.scoreTotal = [0, 0, 0, 0, 0, 0];
  if (!Array.isArray(perm.scoreSingle)) perm.scoreSingle = [0, 0, 0, 0, 0, 0];
  if (!perm.rune) perm.rune = {};
  if (!perm.exRunes) perm.exRunes = {};
  if (!perm.runePack) perm.runePack = {};
  if (!perm.challenge) perm.challenge = {};
  if (!Array.isArray(perm.comment)) perm.comment = [];
  if (!perm.reward) perm.reward = {};
  if (!season.temporary) season.temporary = {};
  // 上方已逐个补齐生成模型声明的 permanent 字段；视图两侧兼容，故断言安全
  return season as CrisisV2SeasonReady;
}

/**
 * 计算危机合约V2战斗分数
 *
 * 移植自参考实现的评分逻辑：根据玩家选择的符文槽位，
 * 从地图数据中计算各维度的得分。
 * @param rune - V2赛季数据
 * @param mapId - 地图ID
 * @param runeSlots - 玩家选择的符文槽位列表
 * @returns 包含各维度得分和符文ID列表的结果对象
 */
function computeV2BattleScore(
  rune: CrisisV2File,
  mapId: string,
  runeSlots: string[],
): { scoreCurrent: number[]; runeIds: string[]; satisfiedPacks: string[] } {
  /** 6个维度的得分 */
  const scoreCurrent = [0, 0, 0, 0, 0, 0];
  const runeIds: string[] = [];
  /** 本局满足全部互斥组的指标集（bagDataMap 键，写入 permanent.runePack 用） */
  const satisfiedPacks: string[] = [];

  const mapData = rune?.info?.mapDetailDataMap?.[mapId];
  if (!mapData) {
    return { scoreCurrent, runeIds, satisfiedPacks };
  }

  /** 构建节点结构：slotPackId -> mutualExclusionGroup -> slot -> score */
  const nodes: {
    [slotPackId: string]: {
      [mutualExclusionGroup: string]: { [slot: string]: number };
    };
  } = {};

  /** 遍历所有节点，构建评分映射 */
  const nodeDataMap = mapData.nodeDataMap ?? {};
  for (const slot in nodeDataMap) {
    if (!slot.startsWith("node_")) continue;
    const nodeData = nodeDataMap[slot];
    const slotPackId = nodeData.slotPackId;
    if (!slotPackId) continue;
    if (!nodes[slotPackId]) nodes[slotPackId] = {};
    const mutualExclusionGroup = nodeData.mutualExclusionGroup || slot;
    if (!nodes[slotPackId][mutualExclusionGroup]) {
      nodes[slotPackId][mutualExclusionGroup] = {};
    }
    let score = 0;
    if (nodeData.runeId !== undefined) {
      const runeId = nodeData.runeId;
      if (runeId) {
        const runeData = mapData.runeDataMap?.[runeId];
        score = runeData?.score ?? 0;
      }
    }
    nodes[slotPackId][mutualExclusionGroup][slot] = score;
  }

  /** 检查每个槽位包是否满足奖励条件 */
  const slotsSet = new Set(runeSlots);
  for (const slotPackId in nodes) {
    let allGroupsSatisfied = true;
    for (const mutualExclusionGroup in nodes[slotPackId]) {
      const groupSlots = nodes[slotPackId][mutualExclusionGroup];
      /** 找出该互斥组中的最高分 */
      let scoreMax = 0;
      for (const slot in groupSlots) {
        scoreMax = Math.max(scoreMax, groupSlots[slot]);
      }
      /** 检查玩家是否选择了最高分的槽位 */
      let hasMaxSlot = false;
      for (const slot in groupSlots) {
        if (groupSlots[slot] !== scoreMax) continue;
        if (slotsSet.has(slot)) {
          hasMaxSlot = true;
          break;
        }
      }
      if (!hasMaxSlot) {
        allGroupsSatisfied = false;
        break;
      }
    }
    /** 若所有互斥组都满足，累加背包奖励分数 */
    if (allGroupsSatisfied) {
      const bagData = mapData.bagDataMap?.[slotPackId];
      if (bagData) {
        scoreCurrent[bagData.dimension] += bagData.rewardScore;
        satisfiedPacks.push(slotPackId);
      }
    }
  }

  /** 累加玩家选择符文的分数 */
  for (const slot of runeSlots) {
    const nodeData = mapData.nodeDataMap?.[slot];
    if (!nodeData) continue;
    if (nodeData.runeId !== undefined) {
      // 数据实测：START/END 节点的 runeId 显式为 null（如 cc1 的 node_1），而本判定只排除
      // undefined。为保持既有运行时行为（不新增跳过分支），此处按符文 id 收窄为 string；
      // 潜在缺陷（null 会被 push 进 runeIds）已在报告中登记，未改行为。
      const runeId = nodeData.runeId as string;
      runeIds.push(runeId);
      const runeData = mapData.runeDataMap?.[runeId];
      if (runeData) {
        scoreCurrent[runeData.dimension] += runeData.score;
      }
    }
  }

  return { scoreCurrent, runeIds, satisfiedPacks };
}

/**
 * V2 挑战节点求值（官方 challengeNodeDataMap 条件）
 *
 * 官服条件仅两类（实测 data/crisisV2 全部 92 张地图、33 种参数组合）：
 * - PassWithDimScore ["0;1;2;3;4;5","300"]：单局任一（清单内）维度得分 ≥ 门槛
 * - PassWithRunes    ["node_7;node_8","2"]：单局携带清单内节点数 ≥ 门槛
 * 官服存档实证：已完成节点在 season.permanent.challenge / temporary[mapId].challenge
 * 中记为 **2**（crisis_v2_season_2_1 / crisis_v2_02-02 →
 * {keypoint_1:2,keypoint_2:2,keypoint_3:2}）。
 *
 * @param mapData - mapDetailDataMap[mapId]
 * @param scoreCurrent - 本局 6 维得分
 * @param runeSlots - 本局选择的节点槽位（node_N）
 * @returns 本局新达成的挑战节点键列表
 */
function evaluateV2NodeCompletion(
  mapData: CrisisV2MapDetailJson | undefined,
  scoreCurrent: number[],
  runeSlots: string[],
): string[] {
  const done: string[] = [];
  const map = mapData?.challengeNodeDataMap;
  if (!map) return done;
  const slots = new Set(runeSlots ?? []);
  for (const [key, node] of Object.entries(map)) {
    const params: string[] = node?.missionParamList ?? [];
    const list = String(params[0] ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const need = parseInt(String(params[1] ?? ""), 10);
    if (!Number.isFinite(need)) continue;
    if (node?.missionType === "PassWithDimScore") {
      const hit = list.some((d) => Number(scoreCurrent[Number(d)] ?? 0) >= need);
      if (hit) done.push(key);
    } else if (node?.missionType === "PassWithRunes") {
      const carried = list.filter((id) => slots.has(id)).length;
      if (carried >= need) done.push(key);
    }
  }
  return done;
}

/**
 * 收集赛季内**已完成**的 V2 节点 id
 *
 * 勋章 CrisisV2NodeSome 的 unlockParam[1] 为节点 id 清单，形如
 * `${mapId}^pack_1` / `${mapId}^keypoint_1` / `${mapId}^reward_1`——主测试地的
 * 记录位于 season.permanent（challenge / runePack / reward），轮换测试地位于
 * season.temporary[mapId].challenge。官服已完成值实测为 2。
 *
 * @param season - crisisV2.seasons[seasonId]
 * @param permanentMapId - 该赛季主测试地（stageType=PERMANENT）的 mapId
 */
function collectCompletedV2NodeIds(
  season: CrisisV2SeasonView | undefined,
  permanentMapId: string,
): string[] {
  const ids: string[] = [];
  const perm = season?.permanent;
  if (perm && permanentMapId) {
    for (const [k, v] of Object.entries(perm.challenge ?? {})) {
      if (Number(v) >= 2) ids.push(`${permanentMapId}^${k}`);
    }
    for (const [k, v] of Object.entries(perm.runePack ?? {})) {
      if (Number(v) >= 2) ids.push(`${permanentMapId}^${k}`);
    }
    for (const [k, v] of Object.entries(perm.reward ?? {})) {
      if (Number(v?.state ?? 0) >= 2) ids.push(`${permanentMapId}^${k}`);
    }
  }
  for (const [mid, m] of Object.entries(season?.temporary ?? {})) {
    for (const [k, v] of Object.entries(m?.challenge ?? {})) {
      if (Number(v) >= 2) ids.push(`${mid}^${k}`);
    }
  }
  return ids;
}

/**
 * 获取重构符文的赛季关卡数据
 * @param seasonId - 赛季ID
 * @param stageId - 关卡ID
 * @returns 关卡数据对象，不存在返回null
 */
function getRecalRuneStageData(
  seasonId: string,
  stageId: string,
): RecalRuneStageData | null {
  const stageData =
    excel.CrisisV2SharedData?.recalRuneData?.seasons?.[seasonId]?.stages?.[stageId];
  return stageData ?? null;
}

// ==================== 路由定义 ====================

const router = Router();

// ==================== 危机合约V1路由 ====================

/**
 * 获取危机合约信息
 * @route POST /crisis/getCrisisInfo（另有 /getInfo 别名——客户端实际调用 /crisis/getInfo）
 * @returns 危机合约信息和玩家增量数据
 */
async function handleCrisisGetInfo(_req: Request, res: Response): Promise<void> {
  const player = getPlayer();
  const currentTime = now();
  const nextDay = currentTime + ONE_DAY_SECONDS;

  try {
    const rune = await dataCache.getV1Data(await selectedCrisisV1());

    /** 更新时间戳 */
    rune.ts = currentTime;
    rune.playerDataDelta.modified.crisis.lst = currentTime;
    rune.playerDataDelta.modified.crisis.nst = nextDay;
    rune.playerDataDelta.modified.crisis.training.nst = nextDay;

    /** 更新每个赛季的临时数据 */
    const seasons = rune.playerDataDelta.modified.crisis.season;
    for (const seasonId in seasons) {
      seasons[seasonId].temporary = buildSeasonTemporary(nextDay);
    }

    /** 更新玩家危机合约时间戳，保持服务端状态一致 */
    await player.update(async (draft) => {
      draft.crisis.lst = currentTime;
      draft.crisis.nst = nextDay;
      draft.crisis.training.nst = nextDay;
    });

    res.send(rune satisfies CrisisGetInfoResponse);
  } catch (err) {
    /** 数据文件加载失败时返回最小响应 */
    logger.error("crisis/getCrisisInfo", "加载数据失败:", err);
    res.send({
      ts: currentTime,
      data: {},
      playerDataDelta: {
        modified: {
          crisis: {
            lst: currentTime,
            nst: nextDay,
            training: { nst: nextDay },
            season: {},
          },
        },
        deleted: {},
      },
    } satisfies CrisisGetInfoResponse);
  }
}

/** 危机合约信息（服务端既有路径 /getCrisisInfo） */
router.post("/getCrisisInfo", validateBody(crisisGetInfoSchema), async (req, res) => {
  req.body as CrisisGetInfoRequest;
  await handleCrisisGetInfo(req, res);
});

/** 危机合约信息（客户端实际调用 /crisis/getInfo） */
router.post("/getInfo", validateBody(crisisGetInfoSchema), async (req, res) => {
  req.body as CrisisGetInfoRequest;
  await handleCrisisGetInfo(req, res);
});

/**
 * 危机合约V1战斗开始
 * @route POST /crisis/battleStart
 * @param req.body.stageId - 关卡ID
 * @param req.body.rune - 符文列表
 * @returns 战斗ID和玩家增量数据
 */
router.post("/battleStart", validateBody(crisisV1BattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const { stageId, rune: runeList } = req.body as CrisisV1BattleStartRequest;

  let totalRisks = 0;
  try {
    const crisisData = await dataCache.getV1Data(await selectedCrisisV1());
    const stageRune = crisisData?.data?.stageRune?.[stageId];

    /** 累加所有选中符文的风险点数 */
    if (stageRune && Array.isArray(runeList)) {
      for (const runeId of runeList) {
        const runeData = stageRune[runeId];
        if (runeData && typeof runeData.points === "number") {
          totalRisks += runeData.points;
        }
      }
    }
  } catch (err) {
    logger.error("crisis/battleStart", "计算风险等级失败:", err);
  }

  /** 保存战斗上下文，供 battleFinish 使用 */
  battleStore.setV1(player.uid, {
    chosenCrisis: await selectedCrisisV1(),
    stageId,
    chosenRisks: runeList || [],
    totalRisks,
  });

  res.send({
    battleId: BATTLE_ID,
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
    result: 0,
    sign: "abcde",
    signStr: "abcdefg",
  } satisfies CrisisV1BattleStartResponse);
});

/**
 * 危机合约V1战斗结束
 * @route POST /crisis/battleFinish
 * @returns 战斗结果、分数和玩家增量数据
 */
router.post("/battleFinish", validateBody(crisisV1BattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CrisisV1BattleFinishRequest;

  /** 获取战斗开始时保存的风险等级 */
  const ctx = battleStore.getV1(player.uid);
  const totalRisks = ctx?.totalRisks ?? 0;

  // 修复（2026-09-09）：原实现只把风险点数回给客户端，**从不落盘** —— `permanent.point`/
  // `challenge.topPoint` 恒不变（官服存档 crisis.season[rune_season_X_Y].permanent.point = 4、
  // challenge.topPoint = 4，且点数为历史最高）。
  let pointBefore = -1;
  let pointAfter = -1;
  let seasonIdV1 = "";
  try {
    const v1 = await dataCache.getV1Data(await selectedCrisisV1());
    const seasonId = String(v1?.data?.seasonInfo?.[0]?.seasonId ?? "");
    seasonIdV1 = seasonId;
    if (seasonId && totalRisks > 0) {
      await player.update(async (draft) => {
        const season = ensureCrisisV1Season(draft, seasonId);
        const perm = season.permanent;
        pointBefore = Number(perm.point ?? -1);
        if (totalRisks > pointBefore) {
          perm.point = totalRisks;
          if (totalRisks > Number(perm.challenge.topPoint ?? -1)) {
            perm.challenge.topPoint = totalRisks;
          }
        }
        pointAfter = Number(perm.point ?? -1);
      });
    } else {
      pointAfter = totalRisks;
    }
  } catch (err) {
    logger.error("crisis/battleFinish", "记录危机等级失败:", err);
    pointAfter = totalRisks;
  }

  // 勋章（2026-09-09 修复）：V1 危机合约批次此前**从不 emit** ——
  // CrisisStageScoreSome / CrisisStageScoreBeforeTime 的监听器虽注册，却因零事件 +
  // 目标位取错（medal.ts 原取 parseInt(param[0])，而 param[0] 是赛季 id → NaN）而永不可得。
  // 现按官方 unlockParam 参数位发载荷：[赛季, 常驻行动地点, 评价档, 目标危机等级] /
  // [赛季, 常驻行动地点, 目标危机等级, 截止时间]。
  const stageIdV1 = ctx?.stageId ?? "";
  try {
    await player._trigger.emit("CrisisStageScoreSome", [
      { seasonId: seasonIdV1, stageId: stageIdV1, score: totalRisks },
    ]);
    await player._trigger.emit("CrisisStageScoreBeforeTime", [
      { seasonId: seasonIdV1, stageId: stageIdV1, score: totalRisks },
    ]);
  } catch (err) {
    logger.error("crisis/battleFinish", "勋章事件派发失败:", err);
  }

  res.send({
    result: 0,
    score: totalRisks,
    updateInfo: {
      point: {
        before: pointBefore,
        after: pointAfter,
      },
    },
    ...player.delta,
  } satisfies CrisisV1BattleFinishResponse);
});

/**
 * 获取危机合约V1商品列表
 * @route POST /crisis/getGoodList
 * @returns 商品列表和玩家增量数据
 */
router.post("/getGoodList", validateBody(crisisGetGoodListSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CrisisGetGoodListRequest;

  /** 返回玩家危机合约商店数据 */
  res.send({
    goodList: player._playerdata.crisis.shop.info,
    shop: player._playerdata.crisis.shop,
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies CrisisGetGoodListResponse);
});

/**
 * 购买危机合约V1商品
 * @route POST /crisis/buyGoods
 * @param req.body.goodId - 商品ID
 * @param req.body.count - 购买数量
 * @returns 获得的物品和玩家增量数据
 *
 * 简化实现：仅更新商店购买记录（recordPurchase），不扣除危机合约硬币——
 * 购买无代价属既有简化行为（与 V2 buyGood 一致；补扣款需先核对代币字段语义）。
 * 实际物品奖励需要完整的商品定义表，此处仅更新购买计数。
 */
router.post("/buyGoods", validateBody(crisisBuyGoodsSchema), async (req, res) => {
  const player = getPlayer();
  const { goodId, count } = req.body as CrisisBuyGoodsRequest;

  await player.update(async (draft) => {
    /** 更新商店购买记录（共享实现，见 @game/kernel/util/purchase-record） */
    recordPurchase(draft.crisis.shop.info, goodId, count);
  });

  res.send({
    items: [],
    ...player.delta,
  } satisfies CrisisBuyGoodsResponse);
});

/**
 * 领取挑战奖励-任务
 * @route POST /crisis/challengeRewardTask
 * @param req.body.seasonId - 赛季ID
 * @param req.body.taskId - 任务ID
 * @returns 获得的物品和玩家增量数据
 *
 * 简化实现：标记任务奖励为已领取。
 */
router.post("/challengeRewardTask", validateBody(crisisChallengeRewardTaskSchema), async (req, res) => {
  const player = getPlayer();
  const { seasonId, taskId } = req.body as CrisisChallengeRewardTaskRequest;

  let claimed = false;
  await player.update(async (draft) => {
    const season = crisisV1SeasonView(draft, seasonId);
    const perm = asCrisisV1Permanent(season?.permanent);
    const task = perm.challenge?.taskList?.[taskId];
    // 修复（2026-09-09）：原实现无条件置 rts —— 未完成（fts = -1）的任务也能「领取」。
    // 官服形状 { fts, rts }（-1 = 未完成/未领取），故要求已完成且未领取。
    if (task && Number(task.fts ?? -1) >= 0 && Number(task.rts ?? -1) === -1) {
      task.rts = now();
      claimed = true;
    }
  });

  // 勋章（2026-09-09 修复）：CrisisTaskSome（unlockParam [赛季, 常驻任务清单, 目标任务数]）
  // 此前零 emit；仅在**首次领取**时计入，避免重复请求刷进度。
  if (claimed) {
    try {
      await player._trigger.emit("CrisisTaskSome", [{ seasonId, taskId, count: 1 }]);
    } catch (err) {
      logger.error("crisis/challengeRewardTask", "勋章事件派发失败:", err);
    }
  }

  res.send({
    items: [],
    ...player.delta,
  } satisfies CrisisChallengeRewardTaskResponse);
});

/**
 * 领取挑战奖励-积分
 * @route POST /crisis/challengeRewardPoint
 * @param req.body.seasonId - 赛季ID
 * @param req.body.pointId - 积分ID
 * @returns 获得的物品和玩家增量数据
 *
 * 简化实现：标记积分奖励为已领取。
 */
router.post("/challengeRewardPoint", validateBody(crisisChallengeRewardPointSchema), async (req, res) => {
  const player = getPlayer();
  const { seasonId, pointId } = req.body as CrisisChallengeRewardPointRequest;

  await player.update(async (draft) => {
    const season = crisisV1SeasonView(draft, seasonId);
    const perm = asCrisisV1Permanent(season?.permanent);
    if (perm.challenge?.pointList) {
      const pointKey = String(pointId);
      // 修复（2026-09-09）：原实现写入字面量 1 —— 官服 pointList 的值为「领取时间戳」，
      // 未领取为 -1（存档样本：{"1":1591420215,…,"5":-1}）。
      if (Number(perm.challenge.pointList[pointKey] ?? -1) === -1) {
        perm.challenge.pointList[pointKey] = now();
      }
    }
  });

  res.send({
    items: [],
    ...player.delta,
  } satisfies CrisisChallengeRewardPointResponse);
});

/**
 * 领取挑战奖励-全部
 * @route POST /crisis/challengeRewardAll
 * @param req.body.seasonId - 赛季ID
 * @returns 获得的物品和玩家增量数据
 *
 * 简化实现：标记当前赛季所有可领取的积分奖励为已领取。
 */
router.post("/challengeRewardAll", validateBody(crisisChallengeRewardAllSchema), async (req, res) => {
  const player = getPlayer();
  const { seasonId } = req.body as CrisisChallengeRewardAllRequest;

  await player.update(async (draft) => {
    const season = crisisV1SeasonView(draft, seasonId);
    const perm = asCrisisV1Permanent(season?.permanent);
    if (perm.challenge?.pointList) {
      for (const pointKey in perm.challenge.pointList) {
        // 同上：领取标记应为时间戳而非 1
        if (Number(perm.challenge.pointList[pointKey] ?? -1) === -1) {
          perm.challenge.pointList[pointKey] = now();
        }
      }
    }
  });

  res.send({
    items: [],
    ...player.delta,
  } satisfies CrisisChallengeRewardAllResponse);
});

/**
 * 获取危机合约所有物品
 * @route POST /crisis/getAllItems
 * @returns 商店信息和玩家增量数据
 */
router.post("/getAllItems", validateBody(crisisGetAllItemsSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CrisisGetAllItemsRequest;

  res.send({
    shop: player._playerdata.crisis.shop,
    box: player._playerdata.crisis.box,
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies CrisisGetAllItemsResponse);
});

/**
 * 解锁地图排名
 * @route POST /crisis/unlockMapRank
 * @param req.body.mapId - 地图ID
 * @returns 玩家增量数据
 *
 * 简化实现：更新玩家危机合约地图数据，标记地图排名已解锁。
 */
router.post("/unlockMapRank", validateBody(crisisUnlockMapRankSchema), async (req, res) => {
  const player = getPlayer();
  const { mapId } = req.body as CrisisUnlockMapRankRequest;

  await player.update(async (draft) => {
    if (!draft.crisis.map[mapId]) {
      draft.crisis.map[mapId] = {
        rank: 0,
        confirmed: 0,
      };
    }
    draft.crisis.map[mapId].confirmed = 1;
  });

  res.send(player.delta satisfies CrisisUnlockMapRankResponse);
});

/**
 * 解锁符文
 * @route POST /crisis/unlockRune
 * @param req.body.seasonId - 赛季ID
 * @param req.body.runeId - 符文ID
 * @returns 玩家增量数据
 *
 * 简化实现：在玩家赛季数据中标记符文为已解锁。
 */
router.post("/unlockRune", validateBody(crisisUnlockRuneSchema), async (req, res) => {
  const player = getPlayer();
  const { seasonId, runeId } = req.body as CrisisUnlockRuneRequest;

  let firstUnlock = false;
  await player.update(async (draft) => {
    const season = crisisV1SeasonView(draft, seasonId);
    const perm = asCrisisV1Permanent(season?.permanent);
    if (perm.rune) {
      // 幂等赋值；仅「首次解锁」计入勋章进度，重复请求不刷进度
      firstUnlock = Number(perm.rune[runeId] ?? 0) !== 3;
      perm.rune[runeId] = 3;
    }
  });

  // 勋章（2026-09-09 修复）：CrisisUnlockPermRuneSome
  // （unlockParam [赛季, 3 级词条清单, 目标词条数]，官服文案「解锁4个3级合约」）此前零 emit。
  if (firstUnlock) {
    try {
      await player._trigger.emit("CrisisUnlockPermRuneSome", [
        { seasonId, runeId, count: 1 },
      ]);
    } catch (err) {
      logger.error("crisis/unlockRune", "勋章事件派发失败:", err);
    }
  }

  res.send(player.delta satisfies CrisisUnlockRuneResponse);
});

// ==================== 危机合约V2路由 ====================

/**
 * 获取危机合约V2信息
 * @route POST /crisis/v2/getInfo
 * @returns 危机合约V2信息和玩家增量数据
 */
router.post("/v2/getInfo", validateBody(crisisV2GetInfoSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CrisisV2GetInfoRequest;

  try {
    const rune = await dataCache.getV2Data(await selectedCrisisV2());
    res.send(rune satisfies CrisisV2GetInfoResponse);
  } catch (err) {
    /** 数据文件加载失败时返回最小响应 */
    logger.error("crisis/v2/getInfo", "加载数据失败:", err);
    res.send({
      info: {},
      ts: now() - 10,
      playerDataDelta: {
        modified: {},
        deleted: {},
      },
    } satisfies CrisisV2GetInfoResponse);
  }
});

/**
 * 危机合约V2战斗开始
 * @route POST /crisis/v2/battleStart
 * @param req.body.mapId - 地图ID
 * @param req.body.runeSlots - 符文槽位
 * @returns 战斗ID和玩家增量数据
 */
router.post("/v2/battleStart", validateBody(crisisV2BattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const { mapId, runeSlots } = req.body as CrisisV2BattleStartRequest;
  // 助战：CS CrisisV2BattleStartRequest : CrisisStartBattleBaseRequest（含 squad/assistFriend）
  const assistFriend = (req.body as { assistFriend?: unknown }).assistFriend;
  /** 赛季ID：勋章（CrisisV2* 系列）unlockParam[0] 为赛季 id，需据此门控 */
  let seasonId = "";
  try {
    const v2 = await dataCache.getV2Data(await selectedCrisisV2());
    seasonId = String(v2?.info?.seasonId ?? "");
  } catch (err) {
    logger.error("crisis/v2/battleStart", "读取赛季ID失败:", err);
  }

  /** 保存战斗上下文，供 battleFinish 使用 */
  battleStore.setV2(player.uid, {
    mapId: mapId || "",
    seasonId,
    runeSlots: runeSlots || [],
    usedAssist: assistFriend != null,
  });

  res.send({
    result: 0,
    battleId: BATTLE_ID,
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies CrisisV2BattleStartResponse);
});

/**
 * 危机合约V2战斗结束
 * @route POST /crisis/v2/battleFinish
 * @returns 战斗结果、分数和玩家增量数据
 */
router.post("/v2/battleFinish", validateBody(crisisV2BattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CrisisV2BattleFinishRequest;

  /** 获取战斗开始时保存的上下文 */
  const ctx = battleStore.getV2(player.uid);
  const mapId = ctx?.mapId ?? "";
  const runeSlots = ctx?.runeSlots ?? [];

  let scoreCurrent = [0, 0, 0, 0, 0, 0];
  let runeIds: string[] = [];

  let satisfiedPacks: string[] = [];
  try {
    const rune = await dataCache.getV2Data(await selectedCrisisV2());
    const result = computeV2BattleScore(rune, mapId, runeSlots);
    scoreCurrent = result.scoreCurrent;
    runeIds = result.runeIds;
    satisfiedPacks = result.satisfiedPacks;
  } catch (err) {
    logger.error("crisis/v2/battleFinish", "计算分数失败:", err);
  }

  // 修复（2026-09-09）：原实现恒 `isNewRecord: false`、`scoreRecord` 全 0 且**从不落盘** ——
  // 最高分永不更新（危机合约勋章批次因此永不可得）。官服存档形状：
  // permanent.{scoreSingle,scoreTotal} 为 6 维数组；temporary[mapId].{scoreTotal,state,rune}。
  // 说明：`permanent.scoreTotal`（跨图总计）语义未能从数据判定（官服存档中存在 total < single 的样本），
  // 故仅更新可判定的 `scoreSingle`（单次最高）与 temporary 的 `scoreTotal`（该图最高）。
  let isNewRecord = false;
  let scoreRecord: number[] = [0, 0, 0, 0, 0, 0];
  /** 赛季内已完成节点 id（供 CrisisV2NodeSome 勋章） */
  let completedNodeIds: string[] = [];
  try {
    const v2 = await dataCache.getV2Data(await selectedCrisisV2());
    const seasonId = String(v2?.info?.seasonId ?? "");
    const stageType = String(v2?.info?.mapStageDataMap?.[mapId]?.stageType ?? "");
    // 主测试地 mapId（勋章节点 id 前缀；permanent 段自身不存 mapId）
    const permanentMapId =
      Object.entries(v2?.info?.mapStageDataMap ?? {}).find(
        ([mid, mm]) =>
          String(mm?.stageType ?? "") === "PERMANENT" &&
          Boolean(v2?.info?.mapDetailDataMap?.[mid]),
      )?.[0] ?? "";
    // 挑战节点求值（PassWithDimScore / PassWithRunes）
    const nodeKeys = evaluateV2NodeCompletion(
      v2?.info?.mapDetailDataMap?.[mapId],
      scoreCurrent,
      runeSlots,
    );
    if (seasonId && mapId) {
      await player.update(async (draft) => {
        const season = ensureCrisisV2Season(draft, seasonId);
        if (stageType === "PERMANENT") {
          const perm = season.permanent;
          perm.state = 1;
          const single: number[] = perm.scoreSingle;
          for (let i = 0; i < 6; i++) {
            const cur = Number(scoreCurrent[i] ?? 0);
            if (cur > Number(single[i] ?? 0)) {
              single[i] = cur;
              isNewRecord = true;
            }
          }
          scoreRecord = [...single];
        } else {
          if (!season.temporary[mapId]) {
            season.temporary[mapId] = { state: 0, scoreTotal: [0, 0, 0, 0, 0, 0], rune: {}, challenge: {} };
          }
          const map = season.temporary[mapId];
          map.state = 1;
          if (!Array.isArray(map.scoreTotal)) map.scoreTotal = [0, 0, 0, 0, 0, 0];
          for (let i = 0; i < 6; i++) {
            const cur = Number(scoreCurrent[i] ?? 0);
            if (cur > Number(map.scoreTotal[i] ?? 0)) {
              map.scoreTotal[i] = cur;
              isNewRecord = true;
            }
          }
          scoreRecord = [...map.scoreTotal];
        }
        // 挑战节点 / 指标集记录（2026-09-09 修复，B11 同批）：此前**从不写**
        // challenge 与 runePack —— CrisisV2NodeSome（25 枚）既无记录也无事件，
        // 官服存档中二者分别是 {keypoint_N:2} 与 {pack_N:2}。
        const rec =
          stageType === "PERMANENT" ? season.permanent : season.temporary[mapId];
        if (rec) {
          if (!rec.challenge) rec.challenge = {};
          for (const key of nodeKeys) rec.challenge[key] = 2;
        }
        if (stageType === "PERMANENT") {
          if (!season.permanent.runePack) season.permanent.runePack = {};
          for (const pack of satisfiedPacks) {
            season.permanent.runePack[pack] = 2;
          }
        }
        if (isNewRecord) draft.crisisV2.newRecordTs = now();
      });
      // 事件在 update 之外发出（勋章订阅方内部会再次 update，避免嵌套 update 覆盖）
      completedNodeIds = collectCompletedV2NodeIds(
        player._playerdata.crisisV2?.seasons?.[seasonId],
        permanentMapId,
      );
    }
  } catch (err) {
    logger.error("crisis/v2/battleFinish", "记录最高分失败:", err);
  }

  // 勋章（2026-09-09 修复）：V2 批次此前零 emit，且模板目标位取错（param[0] 是赛季 id）。
  // 官方 unlockParam 形状：[赛季, 地图/主测试地, 维度表(0;1;..;5), 目标分]
  //  - CrisisV2DimScoreSome：任意一项分数历史最高达到 N 分 → 单局各维最大值
  //  - CrisisV2DimScoreTotal：主测试地总分达到 N 分 → 单局各维之和
  //  - CrisisV2UseAssist：使用助战并通关 N 次（battleStart 携带 assistFriend 时计 1）
  if (mapId) {
    const dimMax = scoreCurrent.reduce((m, v) => Math.max(m, Number(v ?? 0)), 0);
    const dimSum = scoreCurrent.reduce((s, v) => s + Number(v ?? 0), 0);
    // 「任意一项分数**历史最高**达到 N 分」→ 取本局与既有记录（scoreRecord 为该图各维
    // 历史峰值）的较大者；「总分达到 N 分」→ 本局各维之和。
    const recordMax = scoreRecord.reduce((m, v) => Math.max(m, Number(v ?? 0)), 0);
    try {
      await player._trigger.emit("CrisisV2DimScoreSome", [
        { seasonId: ctx?.seasonId ?? "", mapId, score: Math.max(dimMax, recordMax) },
      ]);
      await player._trigger.emit("CrisisV2DimScoreTotal", [
        { seasonId: ctx?.seasonId ?? "", mapId, score: dimSum },
      ]);
      if (ctx?.usedAssist) {
        await player._trigger.emit("CrisisV2UseAssist", [
          { seasonId: ctx?.seasonId ?? "", used: 1 },
        ]);
      }
      // CrisisV2NodeSome：模板按 unlockParam[1] 节点清单与本次「已完成节点集合」求交计数
      //（取 max，幂等——不依赖逐次 +1，重复作战不会刷进度）
      await player._trigger.emit("CrisisV2NodeSome", [
        { seasonId: ctx?.seasonId ?? "", nodeIds: completedNodeIds },
      ]);
    } catch (err) {
      logger.error("crisis/v2/battleFinish", "勋章事件派发失败:", err);
    }
  }

  res.send({
    result: 0,
    mapId,
    runeSlots,
    runeIds,
    isNewRecord,
    scoreRecord,
    scoreCurrent,
    runeCount: [0, 0],
    commentNew: [],
    commentOld: [],
    ts: now(),
    ...player.delta,
  } satisfies CrisisV2BattleFinishResponse);
});

/**
 * 获取危机合约V2快照
 * @route POST /crisis/v2/getSnapshot
 * @returns 快照详情和玩家增量数据
 */
router.post("/v2/getSnapshot", validateBody(crisisV2GetSnapshotSchema), async (req, res) => {
  req.body as CrisisV2GetSnapshotRequest;

  res.send({
    detail: {},
    simple: {},
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies CrisisV2GetSnapshotResponse);
});

/**
 * 获取危机合约V2商品列表
 * @route POST /crisis/v2/getGoodList
 * @returns 商品列表和玩家增量数据
 */
router.post("/v2/getGoodList", validateBody(crisisV2GetGoodListSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CrisisV2GetGoodListRequest;

  /** 返回玩家危机合约V2商店数据 */
  res.send({
    goodList: player._playerdata.crisisV2.shop.info,
    shop: player._playerdata.crisisV2.shop,
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies CrisisV2GetGoodListResponse);
});

/**
 * 确认危机合约V2任务
 * @route POST /crisis/v2/confirmMissions
 * @returns 推送消息和玩家增量数据
 *
 * 简化实现：返回空推送消息，实际任务确认逻辑需要完整的任务系统支持。
 */
router.post("/v2/confirmMissions", validateBody(crisisV2ConfirmMissionsSchema), async (req, res) => {
  req.body as CrisisV2ConfirmMissionsRequest;

  res.send({
    pushMessage: [],
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies CrisisV2ConfirmMissionsResponse);
});

/**
 * 危机合约V2购买商品
 * @route POST /crisis/v2/buyGood
 * @param req.body.goodId - 商品ID
 * @param req.body.count - 购买数量
 * @returns 获得的物品和玩家增量数据
 *
 * 简化实现：更新商店购买记录。
 * 实际物品奖励需要完整的商品定义表，此处仅更新购买计数。
 */
router.post("/v2/buyGood", validateBody(crisisV2BuyGoodSchema), async (req, res) => {
  const player = getPlayer();
  const { goodId, count } = req.body as CrisisV2BuyGoodRequest;

  await player.update(async (draft) => {
    /** 更新V2商店购买记录（共享实现，见 @game/kernel/util/purchase-record） */
    recordPurchase(draft.crisisV2.shop.info, goodId, count);
  });

  res.send({
    items: [],
    ...player.delta,
  } satisfies CrisisV2BuyGoodResponse);
});

// ==================== 重构符文路由 ====================

/**
 * 重构符文战斗开始
 * @route POST /crisis/recalRune/battleStart
 * @param req.body.seasonId - 赛季ID
 * @param req.body.stageId - 关卡ID
 * @param req.body.runes - 符文列表
 * @param req.body.slots - 槽位
 * @param req.body.assistFriend - 助战好友
 * @returns 战斗ID和玩家增量数据
 */
router.post("/recalRune/battleStart", validateBody(recalRuneBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const { seasonId, stageId, runes, slots, assistFriend } = req.body as RecalRuneBattleStartRequest;

  /** 保存战斗上下文，供 battleFinish 使用 */
  battleStore.setRecal(player.uid, {
    seasonId: seasonId || "",
    stageId: stageId || "",
    runes: runes || [],
    slots: slots || [],
    assistFriend,
  });

  res.send({
    result: 0,
    battleId: BATTLE_ID,
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies RecalRuneBattleStartResponse);
});

/**
 * 重构符文战斗结束
 * @route POST /crisis/recalRune/battleFinish
 * @param req.body.data - 加密的战斗数据
 * @returns 战斗结果、分数和玩家增量数据
 *
 * 简化实现：从重构符文数据表计算总分，解密战斗数据获取完成状态。
 * 注意：玩家数据模型中暂无 recalRune 字段，持久化部分已简化，
 * 仅返回计算结果。完整实现需要扩展 PlayerDataModel。
 */
router.post("/recalRune/battleFinish", validateBody(recalRuneBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RecalRuneBattleFinishRequest;

  /** 获取战斗开始时保存的上下文 */
  const ctx = battleStore.getRecal(player.uid);
  const seasonId = ctx?.seasonId ?? "";
  const stageId = ctx?.stageId ?? "";
  const runes = ctx?.runes ?? [];

  /** 从重构符文数据表获取关卡数据，计算总分 */
  let totalScore = 0;
  const stageData = getRecalRuneStageData(seasonId, stageId);
  if (stageData?.runes) {
    for (const runeId of runes) {
      if (runeId in stageData.runes) {
        totalScore += stageData.runes[runeId].score || 0;
      }
    }
  }

  /** 解密战斗数据，获取完成状态和剩余生命值 */
  let completeState = 3;
  let hp = 0;
  try {
    if (body.data) {
      const battleData = await decryptBattleData<BattleData>(
        body.data,
        player._playerdata.pushFlags.status,
      );
      completeState = battleData.completeState;
      hp = battleData.battleData.stats.leftHp;
    }
  } catch (err) {
    /** 解密失败时默认战斗成功 */
    logger.error("crisis/recalRune/battleFinish", "解密战斗数据失败:", err);
  }

  /** completeState 为 3 表示战斗成功 */
  const isCompleted = completeState === 3;
  const battleState = isCompleted ? 1 : 0;

  // 危机蚀刻章（重构符文）：得分驱动
  await player._trigger.emit("RecalRuneStageScoreSome", [{ score: totalScore }]);
  await player._trigger.emit("CrisisTaskSome", [{ count: 1 }]);

  res.send({
    seasonId,
    stageId,
    state: battleState,
    score: totalScore,
    newRecord: isCompleted,
    runes,
    hp,
    ts: now(),
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies RecalRuneBattleFinishResponse);
});

export default router;
