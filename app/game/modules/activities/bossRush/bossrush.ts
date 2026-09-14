/**
 * 尖灭测试（bossRush）活动管理器
 *
 * 承载 BOSS_RUSH 活动的业务逻辑（参考 DoctoratePy activity.py / OBS misc_bp，适配本仓库）：
 * - relicSelect   密文选择（写入 relic.selectingRelicId，校验遗物存在且已解锁）
 * - relicUpgrade  密文升级（数据驱动消耗：relicLevelInfoDataMap[relicId].levelInfos 的 needItemCount）
 * - battleStart   开始战斗（进行中互斥 + zone 归属/编队校验后复用标准 battle.start，尖灭关卡 apCost=0）
 * - battleFinish  结算战斗（防重/互斥守卫后复用标准 battle.finish，再按波次数据驱动累计
 *                 milestone/token/bestWaveDic，并计算里程碑/代币是否已达上限）
 *
 * 玩家存档形状对齐官方快照：milestone.point/got + relic.token{current,total} +
 * relic.unlockedRelicLevelDic{relicId:level} + relic.selectingRelicId + bestWaveDic{stageId:wave}。
 * excel 数据源：excel.ActivityTable.basicInfo[actId].type === "BOSS_RUSH"，
 * 活动详情位于 excel.ActivityTable.activity.bossRush[actId]（ActivityBossRushData）。
 */
import { PlayerDataManager } from "../../../kernel/player-data-manager";
import { TypedEventEmitter } from "../../../kernel/events/runtime";
import type { Draft } from "mutative";
import type { PlayerDataModel } from "../../../kernel/playerdata";
import excel from "@excel/excel";
import { decryptBattleData } from "@utils/crypt";
import { logger } from "@utils/logger";
import { accountManager } from "../../account/public";
import { activityDictKey } from "../shared/unlockActivity";
import { activityDetailJson, asShape } from "../shared/activity-json";
import type { BattleData, CommonStartBattleRequest } from "../../../kernel/battle-model";
import type { PlayerDeltaResponse } from "../../../kernel/http/common";
import type {
  BossRushFinishBattleRequest,
  BossRushFinishBattleResponse,
  BossRushStartBattleRequest,
  BossRushStartBattleResponse,
} from "../shared/activity";
import type {
  ActivityBossRushData,
  ActivityBossRushData_RelicLevelInfo,
} from "@excel/excel";

/** 波次掉落档（ActivityBossRushData.stageDropDataMap 元素；仅声明本模块消费面） */
interface BossRushWaveDrop {
  clearWaveCount?: number;
  displayDetailRewards?: { id?: string; dropCount?: number }[];
}

/** 玩家尖灭存档（draft.activity.BOSS_RUSH[actId] 的宽松子集，对齐 PlayerActivity_PlayerBossRushActivity） */
interface BossRushPlayerData {
  milestone?: { point?: number; got?: string[] };
  relic?: {
    token?: { current?: number; total?: number };
    unlockedRelicLevelDic?: { [key: string]: number };
    selectingRelicId?: string;
  };
  bestWaveDic?: { [key: string]: number };
}

/** 尖灭密文选择结果 */
export type BossRushRelicSelectResult = { ok: true } | { ok: false; reason: string };

/** 尖灭密文升级结果 */
export type BossRushRelicUpgradeResult =
  | { ok: true; cost: number; level: number }
  | { ok: false; reason: string };

/** 尖灭战斗开始响应载荷（不含玩家增量，增量由路由合并 player.delta） */
export type BossRushStartPayload = Omit<BossRushStartBattleResponse, keyof PlayerDeltaResponse>;

/** 尖灭战斗结算响应载荷（不含玩家增量，增量由路由合并 player.delta） */
export type BossRushFinishPayload = Omit<BossRushFinishBattleResponse, keyof PlayerDeltaResponse>;

/** 尖灭战斗开始结果 */
export type BossRushBattleStartResult =
  | { ok: true; data: BossRushStartPayload }
  | { ok: false; reason: string };

export class BossRushManager {
  /** 玩家数据管理器引用 */
  _player: PlayerDataManager;
  /** 事件触发器（预留，当前无跨系统事件） */
  _trigger: TypedEventEmitter;
  /** 进行中的尖灭战斗 battleId（互斥：开战未结算时拒绝并发开战；实例内存态，重启即失效） */
  _ongoingBattleId: string | null = null;
  /** 已结算的尖灭战斗 battleId 集合（防重：同一 battleId 拒绝二次结算，避免重复发奖） */
  _settledBattleIds = new Set<string>();

  /**
   * 构造函数
   * @param player  - 玩家数据管理器
   * @param trigger - 事件触发器
   */
  constructor(player: PlayerDataManager, trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = trigger;
  }

  /**
   * 取尖灭活动详情数据（excel.ActivityTable.activity.bossRush[actId]）
   *
   * 键定位复用 unlockActivity.activityDictKey（大小写/下划线不敏感），兼容数据版本键名漂移。
   * @param actId - 活动 ID（如 act6bossrush）
   * @returns 活动详情（缺失返回 undefined）
   */
  private activityData(actId: string): ActivityBossRushData | undefined {
    const key = activityDictKey("BOSS_RUSH");
    if (!key) return undefined;
    return asShape<ActivityBossRushData>(
      activityDetailJson(excel.ActivityTable.activity, key, actId),
    );
  }

  /**
   * 取玩家尖灭存档（draft.activity.BOSS_RUSH[actId]）
   *
   * 形状来自生成类型 `PlayerActivity["BOSS_RUSH"]`（登记在
   * scripts/playerdata-server-adapt.ts 的 SERVER_OVERRIDE_FIELDS），本模块的
   * `BossRushPlayerData` 只是其可读别名，不再需要 cast。
   * @param draft - 玩家数据 draft
   * @param actId - 活动 ID
   * @returns 玩家尖灭存档（缺失返回 undefined）
   */
  private userData(draft: Draft<PlayerDataModel>, actId: string): BossRushPlayerData | undefined {
    return draft.activity.BOSS_RUSH?.[actId];
  }

  /**
   * 密文选择
   *
   * 空串表示清除当前选择；非空时校验遗物在活动 relicList 中且已解锁
   * （unlockedRelicLevelDic 中存在即已解锁），通过后写入 relic.selectingRelicId。
   * @param actId   - 活动 ID
   * @param relicId - 遗物 ID（空串清除）
   * @returns ok 或失败原因
   */
  async relicSelect(actId: string, relicId: string): Promise<BossRushRelicSelectResult> {
    return await this._player.update(async (draft) => {
      const user = this.userData(draft, actId);
      if (!user?.relic) return { ok: false, reason: "no-activity" } as const;
      // 非空才校验；空串直接清除选择
      if (relicId !== "") {
        const detail = this.activityData(actId);
        const relicList = detail?.relicList ?? [];
        if (!relicList.some((r) => r.relicId === relicId)) {
          return { ok: false, reason: "invalid-relic" } as const;
        }
        if (!user.relic.unlockedRelicLevelDic?.[relicId]) {
          return { ok: false, reason: "lock-relic" } as const;
        }
      }
      user.relic.selectingRelicId = relicId;
      return { ok: true } as const;
    });
  }

  /**
   * 密文升级
   *
   * 校验遗物存在/已解锁/未满级，数据驱动消耗下一级 needItemCount（无配置回退 0），
   * 余额不足拒绝；通过后扣代币并升级 unlockedRelicLevelDic[relicId]。
   * @param actId   - 活动 ID
   * @param relicId - 遗物 ID
   * @returns ok（含消耗/新等级）或失败原因
   */
  async relicUpgrade(actId: string, relicId: string): Promise<BossRushRelicUpgradeResult> {
    return await this._player.update(async (draft) => {
      const user = this.userData(draft, actId);
      if (!user?.relic) return { ok: false, reason: "no-activity" } as const;
      const detail = this.activityData(actId);
      const relicList = detail?.relicList ?? [];
      if (!relicList.some((r) => r.relicId === relicId)) {
        return { ok: false, reason: "invalid-relic" } as const;
      }
      const dic = user.relic.unlockedRelicLevelDic ?? {};
      const curLevel = dic[relicId] ?? 0;
      if (curLevel <= 0) return { ok: false, reason: "lock-relic" } as const;
      // 满级判定：levelInfos 键数即最大等级（配置缺失视为不可升级）
      const levelInfos = detail?.relicLevelInfoDataMap?.[relicId]?.levelInfos ?? {};
      const maxLevel = Object.keys(levelInfos).length;
      if (maxLevel <= 0 || curLevel >= maxLevel) {
        return { ok: false, reason: "max-level" } as const;
      }
      const cost =
        (levelInfos as Record<string, ActivityBossRushData_RelicLevelInfo | undefined>)[
          String(curLevel + 1)
        ]?.needItemCount ?? 0;
      const token = user.relic.token;
      if (!token || (token.current ?? 0) < cost) {
        return { ok: false, reason: "not-enough-token" } as const;
      }
      token.current = (token.current ?? 0) - cost;
      dic[relicId] = curLevel + 1;
      user.relic.unlockedRelicLevelDic = dic;
      return { ok: true, cost, level: curLevel + 1 } as const;
    });
  }

  /**
   * 开始尖灭战斗
   *
   * 校验：无进行中战斗（互斥）、活动存在、关卡在 stageAdditionDataMap（尖灭专属关卡）、
   * zone 归属本活动、关卡已解锁、编队合法（关卡带 teamIdList 时必须指定且命中，否则自由编队）。
   * 通过后复用标准 battle.start（尖灭关卡 apCost=0 不耗理智，battleInfo 落库供 battleFinish 结算）。
   * @param body - BossRushStartBattleRequest（activityId/stageId/teamId/ownSlots/assistFriend）
   * @returns ok（含标准战斗开始结果）或失败原因
   */
  async battleStart(body: BossRushStartBattleRequest): Promise<BossRushBattleStartResult> {
    const { activityId, stageId, teamId, ownSlots, assistFriend } = body;
    // 互斥：存在进行中的尖灭战斗时拒绝并发开战（防客户端并发/重放覆盖进行中战斗）
    if (this._ongoingBattleId) return { ok: false, reason: "battle-in-progress" };
    const detail = this.activityData(activityId);
    if (!detail) return { ok: false, reason: "no-activity" };
    const stageAdd = detail.stageAdditionDataMap?.[stageId];
    if (!stageAdd) return { ok: false, reason: "invalid-stage" };
    // 关卡归属校验：zone 必须属于本活动（防跨活动关卡挂到错误活动刷奖励）；
    // zone 未收录（数据缺失）时跳过，交由后续关卡解锁校验兜底
    const zoneId = excel.StageTable.stages[stageId]?.zoneId;
    const ownerAct = zoneId ? excel.ActivityTable.zoneToActivity?.[zoneId] : undefined;
    if (zoneId && ownerAct && ownerAct !== activityId) {
      return { ok: false, reason: "invalid-activity-stage" };
    }
    // 关卡必须已解锁（dungeon.stages 已播种）
    const stageState = this._player._playerdata.dungeon?.stages?.[stageId];
    if (!stageState) return { ok: false, reason: "lock-stage" };
    // 编队校验：有关卡专属编队列表时必须指定且命中；无列表则自由编队
    const teamIdList = stageAdd.teamIdList ?? [];
    if (teamIdList.length > 0) {
      if (!teamId || !teamIdList.includes(teamId)) {
        return { ok: false, reason: "invalid-team" };
      }
    } else if (teamId && !detail.teamDataMap?.[teamId]) {
      return { ok: false, reason: "invalid-team" };
    }
    // 复用标准战斗开始（同 quest battleStart 形状）
    const data = await this._player.battle.start({
      stageId,
      squad: ownSlots,
      usePracticeTicket: 0,
      assistFriend,
      isRetro: 0,
      pray: 0,
      battleType: 0,
      continuous: { battleTimes: 1 },
      isReplay: 0,
      startTs: 0,
    } as CommonStartBattleRequest);
    // 记录进行中战斗（供 battleFinish 互斥/防重校验）
    this._ongoingBattleId = (data as { battleId?: string }).battleId ?? null;
    return { ok: true, data: data as BossRushStartPayload };
  }

  /**
   * 结算尖灭战斗
   *
   * 先解密战斗数据做防重/互斥校验（同一 battleId 已结算或与进行中战斗不符 → 拒绝，避免重复发奖），
   * 再复用标准 battle.finish（掉落/关卡解锁/图鉴/首通），随后按 activity.bossRush[actId]
   * .stageDropDataMap[stageId][wave] 数据驱动累计 milestone.point / relic.token{current,total} /
   * bestWaveDic[stageId]，并计算里程碑/代币是否已达上限（满则不再累计）。
   * @param body - BossRushFinishBattleRequest（CommonFinishBattleRequest + activityId）
   * @returns 标准结算结果 + 尖灭专属字段（wave/milestoneBefore/milestoneAdd/isMilestoneMax/tokenAdd/isTokenMax）
   */
  async battleFinish(body: BossRushFinishBattleRequest): Promise<BossRushFinishPayload> {
    // 解密战斗数据：解析 battleId / 波次 / 关卡（提前到标准结算之前，防重校验需要 battleId）
    let battleData: BattleData | null = null;
    let wave = 0;
    let stageId = "";
    try {
      battleData = await decryptBattleData<BattleData>(
        body.data,
        this._player._playerdata.pushFlags.status,
      );
      const extra: { [key: string]: number } =
        battleData?.battleData?.stats?.extraBattleInfo ?? {};
      for (const [key, value] of Object.entries(extra)) {
        if (key.includes("bossrush_finished_wave")) {
          wave = Number(value);
        }
      }
      const battleInfo = await accountManager.getBattleInfo(
        this._player.uid,
        battleData.battleId,
      );
      stageId = battleInfo?.stageId ?? "";
    } catch (err) {
      logger.error("bossRush/battleFinish", "解密战斗数据失败:", err);
    }

    // 防重/互斥校验（在标准结算之前，避免重复结算重复发奖）：
    // - 同一 battleId 已结算过 → 拒绝
    // - 存在进行中战斗且 battleId 不匹配 → 拒绝（非当前战斗，视为重放/篡改）
    const bid = battleData?.battleId;
    if (bid) {
      if (this._settledBattleIds.has(bid)) {
        return {
          result: 1,
          wave,
          milestoneBefore: 0,
          milestoneAdd: 0,
          isMilestoneMax: false,
          tokenAdd: 0,
          isTokenMax: false,
        };
      }
      if (this._ongoingBattleId && this._ongoingBattleId !== bid) {
        return {
          result: 1,
          wave,
          milestoneBefore: 0,
          milestoneAdd: 0,
          isMilestoneMax: false,
          tokenAdd: 0,
          isTokenMax: false,
        };
      }
    }

    // 标准战斗结算
    const result = await this._player.battle.finish({
      data: body.data,
      battleData: body.battleData,
    });

    const detail = this.activityData(body.activityId);
    let milestoneBefore = 0;
    let milestoneAdd = 0;
    let tokenAdd = 0;
    let isMileStoneMax = false;
    let isTokenMax = false;

    await this._player.update(async (draft) => {
      const user = this.userData(draft, body.activityId);
      if (!user) return;
      milestoneBefore = user.milestone?.point ?? 0;
      // 上限：里程碑满=最后一个里程碑所需点数；代币满=全遗物全等级消耗总和
      const mileStoneList = detail?.mileStoneList ?? [];
      const lastNeed = mileStoneList[mileStoneList.length - 1]?.needPointCnt;
      const tokenMax = Object.values(detail?.relicLevelInfoDataMap ?? {}).reduce(
        (sum, relic) =>
          sum +
          Object.values(relic.levelInfos ?? {}).reduce(
            (s, lv) => s + (lv.needItemCount ?? 0),
            0,
          ),
        0,
      );
      isMileStoneMax = lastNeed != null && milestoneBefore >= lastNeed;
      isTokenMax = (user.relic?.token?.total ?? 0) >= tokenMax;

      // 数据驱动掉落：activity.bossRush[actId].stageDropDataMap[stageId][wave]
      // displayDetailRewards 中 id 含 milestone_point / token_relic 的 dropCount 累计
      if (stageId && wave) {
        const drop = dropInfoForWave(
          detail?.stageDropDataMap?.[stageId],
          wave,
        );
        for (const dropItem of drop?.displayDetailRewards ?? []) {
          const dropId = dropItem?.id ?? "";
          if (dropId.includes("milestone_point")) {
            milestoneAdd += Number(dropItem?.dropCount ?? 0);
          } else if (dropId.includes("token_relic")) {
            tokenAdd += Number(dropItem?.dropCount ?? 0);
          }
        }
      }
      // 已达上限不再累计
      if (isMileStoneMax) milestoneAdd = 0;
      if (isTokenMax) tokenAdd = 0;

      if (user.milestone && milestoneAdd > 0) {
        user.milestone.point = milestoneBefore + milestoneAdd;
      }
      if (user.relic?.token && tokenAdd > 0) {
        user.relic.token.current = (user.relic.token.current ?? 0) + tokenAdd;
        user.relic.token.total = (user.relic.token.total ?? 0) + tokenAdd;
      }
      // 该关最高波次
      if (stageId && wave > 0) {
        const best = user.bestWaveDic ?? {};
        if (wave > (best[stageId] ?? 0)) {
          best[stageId] = wave;
          user.bestWaveDic = best;
        }
      }
    });

    // 结算成功：标记已结算（防重）并清进行中战斗（解除互斥）
    if (bid) {
      this._settledBattleIds.add(bid);
      if (this._ongoingBattleId === bid) this._ongoingBattleId = null;
    }

    return {
      ...result,
      result: 0,
      wave,
      milestoneBefore,
      milestoneAdd,
      isMilestoneMax: isMileStoneMax,
      tokenAdd,
      isTokenMax,
    };
  }
}

/**
 * 取指定波次的掉落档（活动 stageDropDataMap[stageId]）
 *
 * 精确命中 wave 键优先；缺失时回退到 clearWaveCount 不超过当前波次的最高档。
 * @param dropMap - stageDropDataMap[stageId]（波次字符串键 → BossRushDropInfo）
 * @param wave    - 结算波次
 * @returns 掉落档（无命中返回 undefined）
 */
function dropInfoForWave(
  dropMap: { [key: number]: BossRushWaveDrop } | undefined,
  wave: number,
): BossRushWaveDrop | undefined {
  if (!dropMap) return undefined;
  const exact = dropMap[wave];
  if (exact) return exact;
  let best: BossRushWaveDrop | undefined;
  let bestWave = 0;
  for (const [key, value] of Object.entries(dropMap)) {
    const w = Number(value?.clearWaveCount ?? key);
    if (w <= wave && w > bestWave) {
      bestWave = w;
      best = value;
    }
  }
  return best;
}
