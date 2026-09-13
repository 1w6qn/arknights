import { accountManager } from "../account/public";

import excel from "@excel/excel";
import { decryptBattleData } from "@utils/crypt";
import { now } from "@utils/time";
import { CommonStartBattleRequest, BattleData } from "../../kernel/battle-model";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import type { PlayerDataModel, PlayerSocial } from "../../kernel/playerdata";
import type { Draft } from "mutative";
import { ItemBundle, ItemType } from "@excel/excel";
import { DisplayDetailRewards } from "@excel/excel";
import { syncAct44SideEntry } from "../activities/act44side/informant";
import {
  accrueCampaignKills,
  campaignsV2View,
  refreshCampaignMissions,
  type CampaignsV2State,
} from "../campaignV2/public";
import { randomChoice, randomChoices, generateBattleId } from "@utils/random";
import { rarityToIndex } from "@utils/rarity";
import { pickKeys } from "@utils/object";
import { logger } from "@utils/logger";
import {
  defaultStageState,
  scanUnlockChain,
} from "../../kernel/util/stage-unlock";
import type { BattleInfo, BattleRecord } from "../../kernel/battle-info-store";

/** excel 关卡表镜像类型（来自 types_excel_gen，与 excel.StageTable.stages 值一致） */
type ExcelStage = (typeof excel.StageTable.stages)[string];

/**
 * 解析战斗关卡配置（StaageTable.stages 未收录时才回退到悖论模拟）。
 *
 * 悖论模拟（干员密录）关卡以 `mem_` 为前缀（如 mem_blkkgt_1），不入 StageTable，
 * 而是存在 `handbook_info_table.handbookStageData`。此前 battleStart/battleFinish
 * 会把这类关卡误判为「未知关卡」。这里回退查找，为悖论模拟构造一个最小可结算
 * 的 stage 片段（无理智/经验/金币消耗，默认无体力保护期、无精英前置校验）。
 *
 * @param stageId - 客户端请求的关卡 id
 * @returns 解析到的 stage 配置；未知关卡返回 undefined
 */
function resolveStage(stageId: string): ExcelStage | undefined {
  const stage = excel.StageTable.stages[stageId];
  if (stage) return stage;
  const mem = Object.values(excel.HandbookInfoTable.handbookStageData).find(
    (s) => s.stageId === stageId,
  );
  if (!mem) return undefined;
  // 悖论模拟特殊关卡：零体力/零经验/零金币，无前置，公开练习向
  return {
    stageId,
    zoneId: mem.zoneId,
    code: mem.code,
    name: mem.name,
    description: mem.description,
    apCost: 0,
    apFailReturn: 0,
    expGain: 0,
    goldGain: 0,
    loseExpGain: 0,
    loseGoldGain: 0,
    dangerLevel: "",
    dangerPoint: 0,
    hardStagedId: null,
    loadingPicId: mem.loadingPicId,
    canPractice: true,
    canBattleReplay: false,
    etItemId: null,
    etCost: 0,
    etFailReturn: 0,
    etButtonStyle: null,
    apProtectTimes: 0,
    diamondOnceDrop: 0,
    practiceTicketCost: 0,
    dailyStageDifficulty: 0,
    passFavor: 0,
    completeFavor: 0,
    slProgress: 0,
    displayMainItem: null,
    hilightMark: false,
    bossMark: false,
    isPredefined: false,
    isHardPredefined: false,
    isSkillSelectablePredefined: false,
    isStoryOnly: false,
    appearanceStyle: "SPECIAL_STORY",
    stageDropInfo: { displayDetailRewards: [] },
    canUseCharm: false,
    canUseTech: false,
    canUseTrapTool: false,
    canUseBattlePerformance: false,
    canContinuousBattle: false,
    startButtonOverrideId: null,
    isStagePatch: false,
    mainStageId: null,
    extraCondition: null,
    extraInfo: null,
    stageType: "SPECIAL_STORY",
    difficulty: "NORMAL",
    performanceStageFlag: "NORMAL_STAGE",
    diffGroup: "NONE",
    unlockCondition: [],
  } as unknown as ExcelStage;
}

/**
 * 关卡掉落条目（数字档位视图）
 *
 * excel 加载时 `normalizeStageDropInfo`（`@excel/excel`）已把 `dropType`/`occPercent` 从
 * 字符串枚举**就地**改写为数字档位（`DROP_TYPE_NUMERIC` / `OCC_PERCENT_NUMERIC`），
 * 但生成类型 `StageData.stageDropInfo.displayDetailRewards` 仍声明为字符串枚举，
 * 读取侧此前只能写 `displayDetailRewards as unknown as DisplayDetailRewards[]` /
 * `item.dropType as unknown as number`。
 *
 * 这里按数字档位返回**副本**：已是数字的原样保留；若拿到未归一化的表（测试夹具等），
 * 按 `normalizeStageDropInfo` 相同的缺省档位兜底（occPercent=4 / dropType=2）——
 * 该兜底不会产出 1/8，故 `[1, 8]`（ONCE/COMPLETE 首通奖励）判定与旧字符串实现一致。
 * @param stage - 关卡表条目（`excel.StageTable.stages[id]`）
 * @returns 掉落条目数组（dropType/occPercent 为数字档位）
 */
function dropRewardsOf(stage: ExcelStage): DisplayDetailRewards[] {
  const raw = stage.stageDropInfo?.displayDetailRewards ?? [];
  return raw.map((item) => ({
    ...item,
    occPercent: typeof item.occPercent === "number" ? item.occPercent : 4,
    dropType: typeof item.dropType === "number" ? item.dropType : 2,
  }));
}

/**
 * 查找悖论模拟（干员密录）关卡的手册元数据
 *
 * 悖论模拟关卡（mem_ 前缀，handbookStageData 收录）结算时需要用到其中的
 * `charID`（对应干员，决定 `troop.addon.<charID>.stage` 写入目标）与 `rewardItem`
 * （首通奖励，如合成玉 DIAMOND_SHD）。resolveStage 只关心战斗数值，元数据在此单独暴露。
 *
 * @param stageId - 客户端请求的关卡 id
 * @returns 手册阶段元数据（含 charID/rewardItem）；非悖论模拟关卡返回 undefined
 */
function resolveHandbookMeta(stageId: string): {
  charID: string;
  rewardItem: ItemBundle[];
} | undefined {
  const mem = Object.values(excel.HandbookInfoTable.handbookStageData).find(
    (s) => s.stageId === stageId,
  );
  if (!mem) return undefined;
  return { charID: mem.charID, rewardItem: mem.rewardItem ?? [] };
}

/**
 * 各账号最近一次 battleStart 时的战斗加密锚点（pushFlags.status 快照）
 *
 * 客户端以「开始战斗时」的会话锚点时间戳加密战斗数据，而 pushFlags.status 会被每次
 * syncData 刷新为新的 now()——若战斗中途 syncData 推进了 status，battleFinish 直接用
 * 当前 status 解密会 key 漂移抛 bad decrypt。battleStart 快照后，finish 优先用存值解密。
 * 单账号私服场景下 uid 做 key 足够（覆盖最近一场战斗）。
 */
const battleLoginTimes = new Map<string, number>();

/** 单场战斗的生命周期状态 */
type BattleSessionStatus = "in_progress" | "finished";

/** 进行中的战斗会话（供生命周期跟踪与重复开始/结算判定） */
interface BattleSession {
  battleId: string;
  stageId: string;
  startTs: number;
  status: BattleSessionStatus;
}

/**
 * 战斗结算响应（`battleFinish` 的统一骨架）
 *
 * 四个返回分支（重复结算被拒 / 未知关卡 / 演习 / 正规结算）此前形状不一：
 * 后三个分支里「演习」只回 `{ result: 0 }`，而另两个最小分支回的是完整空壳——
 * 客户端按完整骨架解析，故统一为下面的骨架（演习分支的**行为微调**：补齐空列表，
 * 与原 `{ result: 0 }` 相比只增不减；跨模块消费方此前只能靠
 * `as unknown as Omit<XFinishBattleResponse, …>` 断言，现在有了声明式契约）。
 */
export interface BattleFinishResponse {
  result: number;
  apFailReturn: number;
  expScale: number;
  goldScale: number;
  rewards: ItemBundle[];
  firstRewards: ItemBundle[];
  unlockStages: string[];
  unusualRewards: ItemBundle[];
  additionalRewards: ItemBundle[];
  furnitureRewards: ItemBundle[];
  alert: string[];
  suggestFriend: boolean;
  /** 好友建议占位（恒为空表；逻辑未实现，仅对齐响应结构） */
  pryResult: never[];
}

/**
 * 最小结算响应（空壳）
 * @param result - 结算结果码（0=成功/演习，1=被拒）
 * @returns 各奖励/解锁列表全空的结算响应
 */
function emptyBattleFinishResponse(result = 0): BattleFinishResponse {
  return {
    result,
    apFailReturn: 0,
    expScale: 0,
    goldScale: 0,
    rewards: [],
    firstRewards: [],
    unlockStages: [],
    unusualRewards: [],
    additionalRewards: [],
    furnitureRewards: [],
    alert: [],
    suggestFriend: false,
    pryResult: [],
  };
}

export class BattleManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  /** 战斗会话登记表（key=uid，覆盖最近一场战斗；单账号私服场景足够） */
  private _sessions = new Map<string, BattleSession>();

  constructor(_player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = _player;
    this._trigger = _trigger;
    this._trigger.on("battle:start", async([args]) => {
      await this.start(args);
    });
    this._trigger.on("battle:finish", async([args, cb]) => {
      const result = await this.finish(args);
      if (typeof cb === "function") cb(result);
    });
  }

  /**
   * 获取当前账号进行中的战斗会话
   *
   * 供上层查询当前战斗状态（battleId/stageId/开始时间），用于断线重连、
   * 重复开始防护等。无进行中战斗返回 undefined。
   *
   * @returns 进行中的战斗会话；无则 undefined
   */
  getActiveBattle(): BattleSession | undefined {
    const session = this._sessions.get(this._player.uid);
    return session && session.status === "in_progress" ? session : undefined;
  }

  /**
   * 校验关卡开局条件（StageTable.stageStartConds）
   *
   * 修复（2026-09-09）：原实现完全忽略开局条件（battle.ts 旧注释 `//todo: amiya guard`），
   * 8-16/14-19 等要求「阿米娅精英 2」的关卡可被任意编队直接开战。
   * @param stageId - 关卡 id
   * @param squad - 客户端编队（charInstId 列表）
   * @returns 不满足时返回原因文案，满足/无条件返回 null
   */
  private _checkStageStartConds(
    stageId: string,
    squad: { slots: ({ charInstId: number } | null)[] } | undefined,
  ): string | null {
    const cond = (excel.StageTable as {
      stageStartConds?: Record<
        string,
        {
          requireChars?: { charId: string; evolvePhase?: string }[];
        }
      >;
    }).stageStartConds?.[stageId];
    if (!cond?.requireChars?.length) return null;
    const phaseNum = (p: unknown): number => {
      const m = /PHASE_(\d+)/.exec(String(p ?? ""));
      return m ? Number(m[1]) : Number(p ?? 0) || 0;
    };
    const chars = (squad?.slots ?? [])
      .filter((s): s is { charInstId: number } => !!s)
      .map((s) => this._player._playerdata.troop.chars[s.charInstId])
      .filter(Boolean) as { charId: string; evolvePhase?: number }[];
    for (const req of cond.requireChars) {
      const need = phaseNum(req.evolvePhase);
      const ok = chars.some(
        (c) => c.charId === req.charId && (c.evolvePhase ?? 0) >= need,
      );
      if (!ok) {
        return `${stageId} 需要 ${req.charId} 达到 ${req.evolvePhase ?? "PHASE_0"}`;
      }
    }
    return null;
  }

  async start(args: CommonStartBattleRequest) {
    const { stageId, usePracticeTicket, squad } = args;
    // 唯一 battleId：crypto.randomUUID（v4）随机生成，避免多场战斗互相覆盖 battleInfo/replay，
    // 且不再暴露时间戳等可预测信息，支持后续按 uuid 检索历史记录
    const battleId = generateBattleId();
    // 生命周期：登记进行中的战斗会话
    this._sessions.set(this._player.uid, {
      battleId,
      stageId,
      startTs: now(),
      status: "in_progress",
    });
    const stage = resolveStage(stageId);
    // 修复：未知关卡（数据版本错位/客户端请求未收录关卡）不 500——
    // 记录缺失 stageId 并返回最小战斗响应，客户端仍可本地游玩（结算由 finish 容错）
    if (!stage) {
      logger.warn(
        "battle",
        `quest/battleStart 未知关卡 ${stageId}（StageTable 无此关卡），返回最小 battleId`,
      );
      return {
        result: 0,
        battleId,
        apFailReturn: 0,
        isApProtect: 0,
        inApProtectPeriod: false,
        notifyPowerScoreNotEnoughIfFailed: false,
      };
    }
    const { zoneId, apCost, dangerLevel } = stage;
    let { apFailReturn } = stage;
    let notifyPowerScoreNotEnoughIfFailed = false;
    
    // Check zoneInfo of apProtect
    let inApProtectPeriod = false;
    if (zoneId in excel.StageTable.apProtectZoneInfo) {
      inApProtectPeriod = excel.StageTable.apProtectZoneInfo[
        zoneId
      ].timeRanges.some(
        (range) => now() >= range.startTs && now() <= range.endTs,
      );
    }
    let isApProtect = 0;
    // —— 战斗开始即扣费（官方语义）——
    // 修复（2026-09-09）：理智原实现只在 battleFinish 扣 → 起战后不结算即可白嫖开局、
    // 理智不足也能开战、放弃/断线零成本。现改为 start 扣、失败时由 finish 返还。
    const liveStageState =
      this._player._playerdata.dungeon?.stages?.[stageId];
    const noCostFirst = liveStageState?.noCostCnt === 1;
    const apProtected =
      noCostFirst || inApProtectPeriod || apCost === 0 || !!usePracticeTicket;
    // 修复（2026-09-09）：演习券按 stage.practiceTicketCost **原值**扣减 ——
    // 原实现 Math.max(1, cost) 把 0/-1（= 0 理智的教学与剧情关）一律按 1 张收费。
    // 实测 3522 关中 practiceTicketCost ∈ {0, -1} 的 1057 关 apCost **全部为 0**，
    // 官服这些关卡无演习消耗（普通关 1 张、突袭/磨炼 3 张）。
    const practiceCost = Math.max(
      0,
      Number((stage as { practiceTicketCost?: number }).practiceTicketCost ?? 1),
    );
    const liveStatus = this._player._playerdata.status;
    if (usePracticeTicket) {
      if (practiceCost > 0 && (liveStatus.practiceTicket ?? 0) < practiceCost) {
        logger.warn(
          "battle",
          `演习券不足（需 ${practiceCost}，持有 ${liveStatus.practiceTicket}），拒绝开战 ${stageId}`,
        );
        this._sessions.delete(this._player.uid);
        return {
          result: 1,
          battleId: "",
          apFailReturn: 0,
          isApProtect: 0,
          inApProtectPeriod: false,
          notifyPowerScoreNotEnoughIfFailed: false,
        };
      }
    } else if (!apProtected && (liveStatus.ap ?? 0) < apCost) {
      logger.warn(
        "battle",
        `理智不足（需 ${apCost}，持有 ${liveStatus.ap}），拒绝开战 ${stageId}`,
      );
      this._sessions.delete(this._player.uid);
      return {
        result: 1,
        battleId: "",
        apFailReturn: 0,
        isApProtect: 0,
        inApProtectPeriod: false,
        notifyPowerScoreNotEnoughIfFailed: false,
      };
    }
    // 开局条件（StageTable.stageStartConds，如 8-16/14-19 需阿米娅精英 2）
    const startCondReason = this._checkStageStartConds(stageId, squad);
    if (startCondReason) {
      logger.warn("battle", `开局条件不满足（${startCondReason}），拒绝开战 ${stageId}`);
      this._sessions.delete(this._player.uid);
      return {
        result: 1,
        battleId: "",
        apFailReturn: 0,
        isApProtect: 0,
        inApProtectPeriod: false,
        notifyPowerScoreNotEnoughIfFailed: false,
      };
    }
    const apCharged = apProtected ? 0 : apCost;
    await this._player.update(async (draft) => {
      // 修复：新关卡（不在存档模板/后加活动关卡）在下方创建之前读取会 500——
      // 用可选链，创建块再按 guide 规则计算 noCostCnt
      if (draft.dungeon.stages[stageId]?.noCostCnt == 1) {
        isApProtect = 1;
        apFailReturn = apCost;
      }
      if (inApProtectPeriod) {
        isApProtect = 1;
      }
      // Add current stage
      if (stageId in draft.dungeon.stages) {
        draft.dungeon.stages[stageId].startTimes += 1;
      } else {
        // 新关卡默认状态（共享实现）：guide 关卡保留 1 次免体力（原内联规则）
        draft.dungeon.stages[stageId] = defaultStageState(stageId, {
          guideNoCost: true,
        });
      }
      // Check if PracticeTicket is used
      if (apCost == 0 || usePracticeTicket) {
        isApProtect = 0;
        apFailReturn = 0;
      }
      if (usePracticeTicket) {
        // 修复（2026-09-09）：按 stage.practiceTicketCost 扣减（突袭为 3），原实现恒扣 1；
        // 0 理智关（cost 0/-1）不扣（原实现 Math.max(1,·) 会白扣 1 张）
        if (practiceCost > 0) draft.status.practiceTicket -= practiceCost;
        draft.dungeon.stages[stageId].practiceTimes += 1;
      } else if (apCharged > 0) {
        // 修复（2026-09-09）：开战即扣理智（原实现只在 finish 扣）
        draft.status.ap = Math.max(0, (draft.status.ap ?? 0) - apCharged);
      }
      // Check user powerScore
      squad.slots.forEach((char) => {
        if (!char) return;
        if (!dangerLevel || dangerLevel == "-") return;
        const { charInstId } = char;
        const stageLevel = parseInt(dangerLevel.slice(-2).replace(".", ""));
        // 修复：编队引用不存在的干员（已删/损坏存档）时不 500
        const charData = draft.troop.chars[charInstId];
        if (!charData) return;
        const { level: charLevel, evolvePhase } = charData;
        if (
          dangerLevel.startsWith("精英1") &&
          (evolvePhase < 1 || charLevel < stageLevel)
        ) {
          notifyPowerScoreNotEnoughIfFailed = true;
          return;
        } else if (
          dangerLevel.startsWith("精英2") &&
          (evolvePhase < 2 || charLevel < stageLevel)
        ) {
          notifyPowerScoreNotEnoughIfFailed = true;
          return;
        }
      });
      // 战斗加密锚点快照：客户端用「开始战斗时」的 pushFlags.status 加密，finish 用存值解密，
      // 避免中途 syncData 刷新 status 导致 key 漂移（bad decrypt）
      battleLoginTimes.set(draft.status.uid, draft.pushFlags.status);
      await accountManager.saveBattleInfo(draft.status.uid, battleId, {
        stageId,
        isPractice: usePracticeTicket,
        squad,
        // 本场已预扣的理智（finish 失败返还以此为上限，避免多退）
        apCharged,
        // 代理指挥（自动作战）开局标记，供 finish 补发 StageWithReplay 任务事件
        isReplay: (args as { isReplay?: number }).isReplay ?? 0,
        // 助战好友信息（assistFriend 为 null 时不保存）
        ...(args.assistFriend ? { assistFriend: args.assistFriend } : {}),
      });
    });

    return {
      apFailReturn,
      battleId,
      inApProtectPeriod,
      isApProtect,
      notifyPowerScoreNotEnoughIfFailed,
      result: 0,
    };
  }

  async finishStoryStage(args: { stageId: string }) {
    const { stageId } = args;
    const rewards: ItemBundle[] = [];
    const unlockStages: string[] = [];
    await this._player.update(async (draft) => {
      // 修复：关卡未播种（如活动剧情关卡在播种前被客户端提交）时先补默认条目，
      // 避免 `draft.dungeon.stages[stageId].state` 读 undefined 崩溃 → 500
      if (!draft.dungeon.stages[stageId]) {
        draft.dungeon.stages[stageId] = defaultStageState(stageId);
      }
      const stageState = draft.dungeon.stages[stageId].state;
      if (stageState !== 3) {
        draft.dungeon.stages[stageId].state = 3;
        // 情报屋（TYPE_ACT44SIDE）：通关其关卡时自愈创建活动状态（官服语义：
        // 状态随进度事件存在；否则客户端入口恒 LOCKED，无法随关卡进度解锁）
        syncAct44SideEntry(draft, stageId);

        // 解锁链扫描（共享实现，battle.finishStoryStage 原内联逻辑的等价迁移）：
        // 锚点恒为 COMPLETE 档（state=3，与上方写入一致）；无前置条件分支 noCostCnt
        // 恒 1；「存档命中 + 锚点命中」双计致 passCondition 超长的历史行为原样保留
        // （含两代同款修复注释所指的 `in Object.keys(...)` 恒 false / 对象键直查语义）
        const { unlockedIds } = scanUnlockChain(draft, { stageId, state: 3 });
        unlockStages.push(...unlockedIds);

        rewards.push({
          type: "DIAMOND" as ItemType,
          id: "4002",
          count: 1,
        });
      }
    });
    for (const it of rewards) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    return {
      result: 0,
      alert: [],
      rewards: rewards,
      unlockStages: unlockStages,
    };
  }

  /**
   * 战斗结算后置流程（quest/battleFinish 全链路）
   *
   * 流程概要（对应 OBS 后置框架；每步失败不阻断后续，除解密/关卡解析外均幂等）：
   * 1. 解密战斗数据（锚点用 battleStart 快照，防 key 漂移）
   * 2. 拉取 battleInfo（battleStart 快照）并解析关卡配置（未知关卡返回空结算）
   * 3. 星级换算金/经验系数（completeState 2/3 → 1/1.2）
   * 4. 非演习：扣除理智/发放经验金币（items:get）
   * 5. player.update 配方内关卡结算（_settleStageState）：状态推进/失败返理智/
   *    解锁链扫描/首通奖励/通关次数/信赖/悖论模拟/掉落
   * 6. 标记战斗会话结束（session.status = finished）
   * 7. 战斗记录留存（battle_records，失败不阻断）
   * 8. 任务事件补发（CompleteStage* 系 / 击杀系 / 助战系，_emitBattleWinEvents）
   * 9. 助战社交点结算（使用方/助战方分账）
   * 10. 组装结算响应（演习仅返回 result）
   *
   * 官方规格对照（OBS battleFinish 后置框架，审计 2026-08-26）：
   *   ✓ 基础数据收集 / 战斗框架 trace（battle_records）/ debug 逆向（isCheat 解密）/
   *     completeState 地图更新（_settleStageState）/ 测试局判定（演习）/ 干员 buff 值（信赖）/
   *     解锁状态更新+trigger（解锁链+任务事件）/ 当前卡消耗（apCost）/ 先期消耗（战前预扣）/
   *     标准 API 刷新（syncData）/ 后处理·mainLine 与隐藏（任务事件+unlockHideStage）
   *   △ 占位：好友建议（suggestFriend 恒 false，响应结构对齐、逻辑未实现）
   *   ✗ 缺失：barCard 处理 / 公招槽位解锁 / 主线 buff 检查（无数据源，未虚构实现）
   *
   * @param args - 客户端上报的战斗数据（加密）与校验字段
   */
  async finish(args: {
    data: string;
    battleData: { isCheat: string; completeTime: number };
  }): Promise<BattleFinishResponse> {
    const { data } = args;
    // 解密锚点优先用 battleStart 快照（客户端用「开始战斗时」的锚点加密），
    // 防止战斗中途 syncData 刷新 pushFlags.status 导致 key 漂移（bad decrypt）
    const loginTime =
      battleLoginTimes.get(this._player.uid) ?? this._player._playerdata.pushFlags.status;
    const battleData = await decryptBattleData<BattleData>(data, loginTime);
    const fetchedInfo = await accountManager.getBattleInfo(
      this._player.uid,
      battleData.battleId,
    );
    if (!fetchedInfo) {
      // battleStart 上下文缺失（进程重启后直接重放 finish 等）：归一到「未知关卡」
      // （stageId=""，isPractice=0）走下方空结算分支，避免解构 undefined 直接 500。
      logger.warn(
        "battle",
        `quest/battleFinish 缺少 battleStart 上下文 ${battleData.battleId}，返回空结算`,
      );
    }
    const battleInfo: BattleInfo = fetchedInfo ?? { stageId: "", isPractice: 0 };
    let goldScale = 0,
      expScale = 0,
      apFailReturn = 0;
    // 官方步骤 13 存根：好友建议逻辑未实现（响应结构对齐，恒 false）
    const suggestFriend = false;
    const unlockStages: string[] = [];
    const unlockStagesObject: unknown[] = [];
    const firstRewards: ItemBundle[] = [];
    // 修复（2026-09-09）：结算幂等——同一 battleId 只能结算一次（原实现可重放刷奖励）
    if (battleInfo?.settled === 1) {
      logger.warn(
        "battle",
        `battleFinish 重复结算被拒（battleId=${battleData.battleId}）`,
      );
      return emptyBattleFinishResponse(1);
    }
    /**
     * 标记本场战斗已结算（一次性幂等标记，落库 battle_infos）
     * 修复（2026-09-09）：结算后写 settled=1，重放同一 battleFinish 不再发奖。
     */
    const markSettled = async () => {
      try {
        await accountManager.saveBattleInfo(
          this._player.uid,
          battleData.battleId,
          { ...battleInfo, settled: 1 },
        );
      } catch (e) {
        logger.warn("battle", `结算标记写入失败: ${(e as Error).message}`);
      }
    };
    const { stageId, isPractice } = battleInfo;
    const stage = resolveStage(stageId);
    // 修复：未知关卡（battleStart 已容错，battleInfo 里的 stageId 同样可能不在表内）——
    // 返回最小结算响应，避免 500
    if (!stage) {
      logger.warn(
        "battle",
        `quest/battleFinish 未知关卡 ${stageId}，返回空结算`,
      );
      return emptyBattleFinishResponse();
    }
    const { apCost, expGain, goldGain } = stage;
    const displayDetailRewards = dropRewardsOf(stage);
    let [
      additionalRewards,
      unusualRewards,
      furnitureRewards,
      rewards,
    ]: ItemBundle[][] = [[], [], [], []];
    if (battleData.completeState === 3) {
      goldScale = 1.2;
      expScale = 1.2;
    } else if (battleData.completeState === 2) {
      goldScale = 1;
      expScale = 1;
    }
    // 修复：演习（isPractice）不扣理智、不发基础奖励——原实现把 AP/EXP/GOLD 发放
    // 放在 isPractice 早退之前，演习既扣 AP 又发经验/金币
    if (!isPractice) {
      // 修复（2026-09-09）：理智扣除已移至 battleStart（此处不再重复扣），
      // 失败返还仍由 _settleStageState 按 apCharged 上限发放。
      for (const it of [
        {
          type: "EXP_PLAYER" as ItemType,
          id: "",
          count: expGain * expScale,
        },
        {
          type: "GOLD" as ItemType,
          id: "4001",
          count: goldGain * goldScale,
        },
      ]) {
        this._player.gainItem.add(it);
      }
      await this._player.gainItem.handle();
    }
    await this._player.update(async (draft) => {
      await this._settleStageState(draft, {
        battleData,
        battleInfo,
        stage,
        stageId,
        isPractice,
        goldScale,
        ctx: {
          apFailReturn,
          firstRewards,
          unlockStages,
          unlockStagesObject,
          rewards,
          additionalRewards,
          unusualRewards,
          furnitureRewards,
        },
      });
    });

    // —— 生命周期：战斗已结算，标记会话结束 ——
    const session = this._sessions.get(this._player.uid);
    if (session && session.battleId === battleData.battleId) {
      session.status = "finished";
    }
    // —— 战斗结束记录留存：完整解析结果入库（battle_records 表，供未来分析）——
    const stats = battleData.battleData?.stats;
    const record: BattleRecord = {
      battleId: battleData.battleId,
      uid: this._player.uid,
      stageId,
      isPractice: isPractice ? 1 : 0,
      source: "quest",
      completeState: battleData.completeState ?? 0,
      beginTs: stats?.beginTs ?? now(),
      endTs: stats?.endTs ?? now(),
      killCnt: stats?.checkKilledCnt ?? battleData.killCnt ?? 0,
      totalDamage: stats?.totalDamage ?? 0,
      leftHp: stats?.leftHp ?? 0,
      totalHeal: stats?.totalHeal ?? 0,
      fixedPlayTime: stats?.fixedPlayTime ?? battleData.battleData.completeTime ?? 0,
      squadInstIds:
        battleInfo.squad?.slots?.filter((s) => s).map((s) => s!.charInstId) ?? [],
      rewards: [
        ...rewards,
        ...additionalRewards,
        ...unusualRewards,
        ...furnitureRewards,
        ...firstRewards,
      ],
      stats,
      createdTs: now(),
    };
    try {
      await accountManager.saveBattleRecord(record);
    } catch (e) {
      // 留存失败不阻断正常结算（分析数据偶发丢失可接受）
      logger.warn("battle", `战斗记录留存失败: ${(e as Error).message}`);
    }

    await this._trigger.emit("CompleteStageAnyType", [battleData]);
    await this._trigger.emit("CompleteStage", [
      {
        ...battleData,
        ...battleInfo,
      },
    ]);
    // 修复：以下任务事件从未 emit → 相应任务模板永不推进；胜利结算统一补发。
    // 入账顺位在 update 之后（干员信赖 favorPoint 已在 recipe 内 +1）
    if (!isPractice && (battleData.completeState ?? 0) >= 2) {
      await this._emitBattleWinEvents(battleData, battleInfo, apCost, stageId);
    }
    if (isPractice) {
      await markSettled();
      // 演习：无奖励/无解锁，但响应骨架与其它分支一致（此前仅 `{ result: 0 }`）
      return emptyBattleFinishResponse();
    }
    // 修复（2026-09-09）：结算成功即打上一次性标记（重放同 battleId 直接拒绝）
    await markSettled();
    return {
      result: 0,
      apFailReturn,
      expScale,
      goldScale,
      rewards,
      firstRewards,
      unlockStages,
      unusualRewards,
      additionalRewards,
      furnitureRewards,
      alert: [],
      suggestFriend,
      pryResult: [],
    };
  }

  /**
   * 关卡结算（player.update 配方内执行）
   *
   * 由 finish 内联逻辑拆分（步骤 5）：处理关卡状态推进/失败返理智/解锁链扫描/首通奖励/
   * 通关次数/出战干员信赖/悖论模拟结算/掉落。响应可变输出（ctx）由调用方传入，
   * 配方内同步回填——分裂配方边界会破坏 mutative 补丁记录，故保持单配方不变。
   *
   * @param draft - update 配方内的可变草稿（dungeon/dexNav/recruit/troop 写入口）
   * @param deps.battleData - 解密后的战斗数据
   * @param deps.battleInfo - battleStart 快照信息（stageId/isPractice/squad/assistFriend）
   * @param deps.stage - 解析后的关卡配置
   * @param deps.stageId - 关卡 id
   * @param deps.isPractice - 是否演习（不推进状态/不发奖励；battleInfo 原值为 0/1）
   * @param deps.goldScale - 星级金币系数（胜利结算用）
   * @param deps.ctx - 结算响应可变输出（返理智/首通/解锁/掉落列表）
   */
  private async _settleStageState(
    draft: Draft<PlayerDataModel>,
    deps: {
      battleData: BattleData;
      battleInfo: BattleInfo;
      stage: ExcelStage;
      stageId: string;
      isPractice: boolean | number;
      goldScale: number;
      ctx: {
        apFailReturn: number;
        firstRewards: ItemBundle[];
        unlockStages: string[];
        unlockStagesObject: unknown[];
        rewards: ItemBundle[];
        additionalRewards: ItemBundle[];
        unusualRewards: ItemBundle[];
        furnitureRewards: ItemBundle[];
      };
    },
  ): Promise<void> {
    const { battleData, battleInfo, stage, stageId, isPractice, goldScale, ctx } = deps;
    const { apCost, goldGain } = stage;
    const displayDetailRewards = dropRewardsOf(stage);
    const playerStage = draft.dungeon.stages[stageId];
    if (isPractice) {
      if (playerStage.state == 0) {
        playerStage.state = 1;
      }
      return;
    }
    if (battleData.completeState === 1) {
      if (playerStage.state == 0) {
        draft.dexNav.enemy.stage[stageId] = Object.keys(
          battleData.battleData.stats.enemyList,
        );
        playerStage.state = 1;
      }
      if (playerStage.noCostCnt) {
        ctx.apFailReturn = apCost;
        playerStage.noCostCnt -= 1;
      } else {
        ctx.apFailReturn = excel.StageTable.stages[stageId].apFailReturn;
      }
      // 修复（2026-09-09）：理智已由 battleStart 预扣——返还不得超过实扣额
      // （演习/免体力/apProtect 期间 apCharged=0 → 不返还）
      const charged = (battleInfo as { apCharged?: number }).apCharged ?? 0;
      ctx.apFailReturn = Math.max(0, Math.min(ctx.apFailReturn, charged));
      await this._player.gainItem
        .add({ type: "AP_GAMEPLAY" as ItemType, id: "", count: ctx.apFailReturn })
        .handle();
    } else {
      let firstClear = false;
      if (
        (playerStage.state != 3 && battleData.completeState === 3) ||
        (playerStage.state == 3 && battleData.completeState === 4)
      ) {
        firstClear = true;
      }
      // 修复：原 `playerStage.state == 1` 前置——state=1 仅在失败（completeState==1）后
      // 置位，首通（state 0 → completeState 2/3）时解锁链被跳过 → 活动关卡链断裂
      // （如 act53side_01 首通后 tr01 不解锁）。改为任意胜利（2/3）即执行解锁链，
      // 幂等（已存在关卡不覆盖）
      if ([2, 3].includes(battleData.completeState)) {
        if (stageId == "main_08-16") {
          //todo: amiya guard
        }
        // unlock recruit
        if (stageId == "main_00-02") {
          draft.recruit.normal.slots[0].state = 1;
          draft.recruit.normal.slots[1].state = 1;
        }
        //unlock stage
        // 解锁链扫描（共享实现，battle.finish 原内联逻辑的等价迁移）：
        // - 锚点用本次解密的 completeState（与 finishStoryStage 的恒 3 不同源，参数化保留）；
        // - 有前置条件分支的新条目按 #f#/hard_/tr_ 标记置 noCostCnt=0（无前置条件分支恒 1）；
        // - MAIN/SUB 双向判定推进 mainStageProgress（clearedStageType 取已解析 stage，
        //   悖论模拟 mem_ 回退构造为 SPECIAL_STORY 自然不满足）；
        // - 「存档命中 + 锚点命中」双计、`in` 对象键直查等历史修复语义原样保留
        const { unlockedIds, unlockedStates } = scanUnlockChain(
          draft,
          { stageId, state: battleData.completeState },
          {
            noCost: { noCostByMarker: true },
            clearedStageType: stage.stageType as string,
          },
        );
        ctx.unlockStages.push(...unlockedIds);
        ctx.unlockStagesObject.push(...unlockedStates);
        // 情报屋（TYPE_ACT44SIDE）：通关其关卡时自愈创建活动状态（官服语义：
        // 状态随进度事件存在；否则客户端入口恒 LOCKED，无法随关卡进度解锁）
        syncAct44SideEntry(draft, stageId);
      }
      if (firstClear) {
        for (const item of displayDetailRewards) {
          if ([1, 8].includes(item.dropType)) {
            ctx.firstRewards.push({
              type: item.type as ItemType,
              id: item.id,
              count: 1,
            });
            await this._player.gainItem
              .add({ type: item.type as ItemType, id: item.id, count: 1 })
              .handle();
          }
        }
      }
      if (playerStage.state != 3 || battleData.completeState === 4) {
        draft.dungeon.stages[stageId].state = battleData.completeState;
      }
      // 胜利时累加通关次数（非练习）
      if ([2, 3].includes(battleData.completeState)) {
        draft.dungeon.stages[stageId].completeTimes += 1;
        // 出战后干员信赖结算（参战编队干员各 +passFavor/completeFavor）
        // 修复（2026-09-09）：原实现每名出战干员固定 +1，而官服按关卡数据发放——
        // `passFavor`＝通关信赖、`completeFavor`＝完整通关（三星）信赖，两者恒等于消耗
        // 理智（如 4-4=18、CE-5=30），0 理智关卡为 0（剿灭 camp_XX 亦为 0）。
        // 旧行为使信赖积累慢约 18 倍，模组 Lv2/Lv3 的 2732/10070 信赖门槛实际不可达。
        const stageConf = stage as {
          passFavor?: number;
          completeFavor?: number;
        };
        const favorGain = Math.max(
          0,
          battleData.completeState === 3
            ? (stageConf.completeFavor ?? apCost)
            : (stageConf.passFavor ?? apCost),
        );
        if (battleInfo.squad && favorGain > 0) {
          for (const char of battleInfo.squad.slots) {
            if (char && draft.troop.chars[char.charInstId]) {
              const target = draft.troop.chars[char.charInstId];
              target.favorPoint = (target.favorPoint || 0) + favorGain;
              // 修复：勋章 CharFavorCount 事件从未 emit → 干员信赖勋章永不推进
              await this._trigger.emit("CharFavorCount", [
                { favorPoint: target.favorPoint },
              ]);
              // 修复：任务 CharIntimacy 事件从未 emit → 干员信赖任务永不推进
              await this._trigger.emit("CharIntimacy", [
                { favorPoint: target.favorPoint },
              ]);
            }
          }
        }
        // —— 悖论模拟（干员密录 mem_ 关卡）完整结算 ——
        await this.settleParadoxStage(draft, {
          stageId,
          completeState: battleData.completeState,
          firstClear,
          pushFirstReward: (item) => ctx.firstRewards.push(item),
        });
      }
      [ctx.additionalRewards, ctx.unusualRewards, ctx.furnitureRewards, ctx.rewards] =
        await this.dropReward(
          displayDetailRewards,
          battleData.completeState,
          stageId,
        );
      if (goldGain * goldScale != 0) {
        ctx.rewards.push({
          type: "GOLD" as ItemType,
          id: "4001",
          count: goldGain * goldScale,
        });
      }
    }
  }

  /**
   * 胜利后任务事件补发与助战社交点结算（finish 步骤 8/9）
   *
   * 由 finish 内联逻辑拆分：非演习且胜利（completeState >= 2）时统一补发
   * 关卡/击杀/助战/社交类任务事件（此前缺失导致对应任务模板永不推进），
   * 并结算助战使用方（+30/日上限 1）与助战方（+20）的社交点。
   * 事件入账顺位在 player.update 配方之后（信赖 favorPoint 已在配方内 +1）。
   *
   * @param battleData - 解密后的战斗数据（事件载荷基座）
   * @param battleInfo - battleStart 快照信息（squad/assistFriend）
   * @param apCost - 关卡理智消耗（CostAp 事件用）
   * @param stageId - 关卡 id
   */
  private async _emitBattleWinEvents(
    battleData: BattleData,
    battleInfo: BattleInfo,
    apCost: number,
    stageId: string,
  ): Promise<void> {
    // 模组（uniequip）任务真实进度推进——依据上场非助战干员 + 关卡/星级判定
    await this._player.equipmentMission?.onBattleWin({ battleInfo, battleData });
    const stType = excel.StageTable.stages[stageId]?.stageType ?? "";
    await this._trigger.emit("CompleteAnyStage", [
      { ...battleData, stageId },
    ]);
    // 活动关卡累计任务（act53side CompleteStageAct，53sideActivity_37..39）——
    // 每次胜利通关活动关累计 +1，模板按 param[1] 关卡列表过滤
    await this._trigger.emit("CompleteStageAct", [
      { ...battleData, stageId },
    ]);
    // 通用活动战斗模板事件（DoctoratePy MissionTemplate 移植）——battle 胜利统一补发，
    // 参数携带完整 BattleData（stats 统计），模板按自身 param/stageId 过滤；仅已播种
    // 且 init 的活动任务注册了对应监听器，无监听时 no-op
    await this._trigger.emit("StageWithCondition", [{ ...battleData, stageId }]);
    await this._trigger.emit("EnemyKill", [{ ...battleData, stageId }]);
    await this._trigger.emit("CompleteStageOrCampaign", [{ ...battleData, stageId }]);
    await this._trigger.emit("CompleteDailyStage", [{ ...battleData, stageId }]);
    await this._trigger.emit("CompleteAnyMulStage", [{ ...battleData, stageId }]);
    await this._trigger.emit("CompleteStageCondition", [{ ...battleData, stageId }]);
    await this._trigger.emit("CompleteStageSimpleAtLeastId", [{ ...battleData, stageId }]);
    await this._trigger.emit("CompleteStageSimpleAtMostId", [{ ...battleData, stageId }]);
    await this._trigger.emit("CompleteStageWithRelic", [{ ...battleData, stageId }]);
    await this._trigger.emit("CompleteStageWithTechTree", [{ ...battleData, stageId }]);
    // 通关统计类勋章统一载荷（修复 2026-09-09，S1）：除 act53side 的 CountMore 外，
    // 补发 PassStageWithSimpleCountLess / PassStageKilled / PassStageKilledLess /
    // PassStageKilledTotal / PassStageWithSimpleTokenCountMore / ...Less ——
    // 这些事件此前从未 emit（部分模板还是「注册天数」占位），共 72 枚勋章永不可得。
    const stageStatPayload = {
      stageId,
      completeState: battleData.completeState ?? 0,
      enemyStats: (battleData.battleData?.stats?.enemyStats ?? []) as never,
      extraBattleInfo: (battleData.battleData?.stats?.extraBattleInfo ??
        {}) as Record<string, unknown>,
    };
    await this._trigger.emit("PassStageWithSimpleCountMore", [stageStatPayload]);
    await this._trigger.emit("PassStageWithSimpleCountLess", [stageStatPayload]);
    await this._trigger.emit("PassStageKilled", [stageStatPayload]);
    await this._trigger.emit("PassStageKilledLess", [stageStatPayload]);
    await this._trigger.emit("PassStageKilledTotal", [stageStatPayload]);
    await this._trigger.emit("PassStageWithSimpleTokenCountMore", [
      stageStatPayload,
    ]);
    await this._trigger.emit("PassStageWithSimpleTokenCountLess", [
      stageStatPayload,
    ]);
    // 修复（2026-09-09，S2）：代理指挥相关任务事件从未 emit ——
    // - StageWithReplay（guide_16「使用代理指挥完成任意关卡1次」）：本场为代理开局即计 1；
    // - TakeOverReplay（guide_19「在代理指挥中接管1场战斗」）：战报标记 autoReplayCancelled。
    // 两者此前永久卡死，并连带卡住 guide_g_2/guide_g_3 的组奖励。
    if ((battleInfo as { isReplay?: number }).isReplay) {
      await this._trigger.emit("StageWithReplay", [{ isReplay: 1 }]);
    }
    if (battleData.battleData?.stats?.autoReplayCancelled) {
      await this._trigger.emit("TakeOverReplay", [battleData]);
    }
    if (stType === "MAIN") {
      await this._trigger.emit("CompleteMainStage", [
        { ...battleData, stageId },
      ]);
    } else if (stType === "CAMPAIGN" || stType === "ACTIVITY") {
      await this._trigger.emit("CompleteCampaign", [
        { ...battleData, stageId },
      ]);
    }
    // 剿灭作战（CAMPAIGN）经济：每击杀 1 名敌人 +1 合成玉（4003），并记录 maxKills；
    // 每周上限 campaignTotalFee（官服 1800）、每周一 04:00 重置。
    // 修复（2026-09-09，S6）：原实现对 CAMPAIGN 只发任务事件，剿灭战斗零产出。
    if (stType === "CAMPAIGN") {
      const campaignKills =
        battleData.battleData?.stats?.checkKilledCnt ?? 0;
      let campaignGained = 0;
      await this._player.update(async (draft) => {
        campaignGained = accrueCampaignKills(
          draft as never,
          stageId,
          campaignKills,
          now(),
        ).gained;
        // 修复（2026-09-09，S6）：委托任务达标状态（campaignsV2.missions 0→1）刷新——
        // 原实现永不写入，客户端剿灭委托任务列表恒为未完成。
        refreshCampaignMissions(
          draft as never,
          (excel.CampaignTable as { campaignMissions?: Record<string, { id: string; param?: string[]; breakFeeAdd?: number }> })
            .campaignMissions ?? {},
          now(),
        );
      });
      // 修复（2026-09-09，S1）：剿灭作战蚀刻章（CampaignsComplete 模板）——原实现该事件
      // 从未 emit，36 枚剿灭勋章永不可得。载荷为 campaignsV2 存档（模板自行校验
      // instances[unlockParam[0]].maxKills==400 且无未领突破奖励）。
      // campaignsV2 不在生成模型里 → 经 campaignV2 模块的单一断言点取（见 campaignsV2View）。
      const campaignsSave: CampaignsV2State =
        campaignsV2View(this._player._playerdata).campaignsV2 ?? {};
      await this._trigger.emit("CampaignsComplete", [campaignsSave]);
      if (campaignGained > 0) {
        await this._player.gainItem
          .add({ id: "4003", type: "DIAMOND_SHD" as ItemType, count: campaignGained })
          .handle();
      }
    }
    await this._trigger.emit("CostAp", [{ ap: apCost }]);
    // 修复：勋章 PassStageSome 事件从未 emit → 通关特定关卡勋章永不推进
    await this._trigger.emit("PassStageSome", [this._player]);
    const favorGained =
      battleInfo.squad?.slots?.filter(
        (s) => s && this._player._playerdata.troop.chars[s.charInstId],
      ).length ?? 0;
    if (favorGained > 0) {
      await this._trigger.emit("GainIntimacy", [{ count: favorGained }]);
    }
    // 修复：战斗击杀事件从未 emit → 击杀类任务永不推进（checkKilledCnt = 击杀总数）
    const killCnt = battleData.battleData?.stats?.checkKilledCnt ?? 0;
    await this._trigger.emit("EnemyKillInAnyStage", [
      { ...battleData, killCnt },
    ]);
    await this._trigger.emit("StageWithEnemyKill", [
      { ...battleData, stageId, killCnt },
    ]);
    await this._trigger.emit("BattleWithEnemyKill", [
      { ...battleData, stageId, killCnt },
    ]);
    // 助战通关 → 助战任务事件 + 「每日结算的信用」（PRTS「信用」页：使用/被使用支援单位）。
    //
    // 修复（2026-09-09，审计 §5.4-12）：原先直接 `status.socialPoint += 30/20` 立即入账，
    // 与官方口径不符——PRTS 明确「以上结算获得的信用将于**次日**发放至信用交易所，需要
    // 手动领取」，官方存档形状为 social.yesterdayReward.{assistAmount, comfortAmount}
    // （实测 Lv112 存档 assistAmount = 50 = 使用 30 + 被使用 20）。现改为累积进
    // yesterdayReward.assistAmount，由 SocialManager.receiveSocialPoint 领取。
    const assistFriend = battleInfo.assistFriend;
    if (assistFriend?.uid) {
      const assistUid = assistFriend.uid;
      await this._trigger.emit("StageWithAssistChar", [
        { ...battleData, assistFriend },
      ]);
      const usePt = excel.GameDataConst.useAssistSocialPt ?? 30;
      const maxUse = excel.GameDataConst.useAssistSocialPtMaxCount ?? 1;
      const todayKey = Math.floor(now() / 86400);
      // 使用方：每日上限 maxUse 次（status.assistUsedDay/assistUsedCount 为私服字段，
      // 已登记在 scripts/playerdata-server-adapt.ts）
      const st = this._player._playerdata.status;
      const usedToday =
        st.assistUsedDay === todayKey ||
        (st.assistUsedCount !== undefined && st.assistUsedCount >= maxUse);
      if (!usedToday) {
        await this._player.update(async (draft) => {
          this._accumulateAssistReward(draft, this._player.uid, usePt);
          const ds = draft.status;
          ds.assistUsedDay = todayKey;
          ds.assistUsedCount = (ds.assistUsedCount ?? 0) + 1;
        });
      }
      // 助战方：assistBeUsedSocialPt 档位表（{"1": 20} = 当日第 1 次被使用给 20，每日 1 次）
      const beUsedPt =
        excel.GameDataConst.assistBeUsedSocialPt?.["1"] ?? 20;
      if (assistUid !== this._player.uid) {
        try {
          const owner = await accountManager.getPlayerData(assistUid);
          await owner.update(async (draft) => {
            const os = draft.status;
            if (os.assistBeUsedDay === todayKey) return;
            this._accumulateAssistReward(draft, assistUid, beUsedPt);
            os.assistBeUsedDay = todayKey;
          });
        } catch (e) {
          logger.warn(
            "battle",
            `助战方 ${assistUid} 助战信用累积失败: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * 累积「支援单位」信用到 `social.yesterdayReward.assistAmount`（当日结算、次日领取）
   *
   * PRTS「信用」页：每日使用一次任意支援单位 +30（`useAssistSocialPt` /
   * `useAssistSocialPtMaxCount`），每日被他人使用一次支援单位 +20
   * （`assistBeUsedSocialPt = {"1": 20}`）。金额累积进昨日奖励容器后由
   * `social/receiveSocialPoint` 手动领取（不立即入账 `status.socialPoint`）。
   * @param draft - `player.update` 配方内的可变草稿（可为助战方账号的草稿）
   * @param _uid - 收款账号（仅用于日志，写入的是传入 draft 对应账号）
   * @param point - 本次累积的信用点数
   */
  private _accumulateAssistReward(draft: Draft<PlayerDataModel>, _uid: string, point: number): void {
    // social 为客户端/服务端共有的必需子树，全新存档可能整体缺失 → 防御性建键
    // （生成类型各字段必填，运行时只建最小子树，故此处放宽）
    draft.social ??= {} as PlayerSocial;
    draft.social.yesterdayReward ??= {
      canReceive: 0,
      first: 0,
      assistAmount: 0,
      comfortAmount: 0,
    };
    draft.social.yesterdayReward.assistAmount =
      (draft.social.yesterdayReward.assistAmount ?? 0) + point;
  }

  /**
   * 悖论模拟（干员密录 mem_ 关卡）完整结算
   *
   * 悖论模拟关卡不在 StageTable，仅由 handbook_stage_data 收录。胜利（completeState 2/3，
   * 非练习）结算时需额外处理两类独有的写入，标准关卡不触发（resolveHandbookMeta 返回
   * undefined 直接跳过）：
   * - **首通奖励**：发放 handbook rewardItem（如 DIAMOND_SHD 合成玉）入 firstRewards，
   *   并通过 items:get 实际入账（与首通关卡星章/掉落行为对齐）；
   * - **密录进度**：写入 `troop.addon.<charID>.stage.<stageId>`（fts/rts/startTimes/
   *   completeTimes/state/startTime），客户端据此展示干员密录悖论模拟的完成状态。
   *
   * 该方法须在 `player.update` 配方内调用（draft 为可变代理，写入会记录补丁）；
   * 奖励发放经 `player.gainItem` 管道在配方内同步入账。
   *
   * @param draft - player.update 配方内的可变草稿（dungeon/troop.addon 写入口）
   * @param opts.stageId - 当前结算的关卡 id（mem_ 前缀悖论模拟关）
   * @param opts.completeState - 客户端上报的完成状态（2/3 为胜利）
   * @param opts.firstClear - 是否首通（首次胜利）
   * @param opts.pushFirstReward - 把首通奖励追加进响应 firstRewards 列表的回调
   */
  private async settleParadoxStage(
    draft: Draft<PlayerDataModel>,
    opts: {
      stageId: string;
      completeState: number;
      firstClear: boolean;
      pushFirstReward: (item: ItemBundle) => void;
    },
  ): Promise<void> {
    const { stageId, completeState, firstClear } = opts;
    // 标准关卡不触发（resolveHandbookMeta 返回 undefined）
    const meta = resolveHandbookMeta(stageId);
    if (!meta) {
      return;
    }
    // 首通奖励：发放 handbook rewardItem 并回填响应 firstRewards
    if (firstClear && meta.rewardItem.length) {
      for (const item of meta.rewardItem) {
        opts.pushFirstReward(item);
        await this._player.gainItem.add(item).handle();
      }
    }
    // 密录进度：写入 troop.addon.<charID>.stage.<memStageId>
    const addon = draft.troop.addon;
    const prev = addon[meta.charID]?.stage?.[stageId];
    const t = now();
    const addonStage = {
      // 首次记录时 fts（first-time timestamp）设为当前，否则沿用既有
      fts: prev ? prev.fts : t,
      rts: t,
      // 开始次数沿用既有 +1（battle.start 未在 addon.stage 计次，这里以完成为准）
      startTimes: (prev?.startTimes ?? 0) + 1,
      completeTimes: (prev?.completeTimes ?? 0) + 1,
      state: completeState,
      // 官服存档中 startTime 恒为 2（手书解锁标记），新开条目补默认值
      startTime: prev?.startTime ?? 2,
    };
    draft.troop.addon = {
      ...addon,
      [meta.charID]: {
        ...(addon[meta.charID] ?? {}),
        stage: { ...(addon[meta.charID]?.stage ?? {}), [stageId]: addonStage },
      },
    };
  }

  async dropReward(
    displayDetailRewards: DisplayDetailRewards[],
    completeState: number,
    stageId: string,
    depth = 0,
  ): Promise<ItemBundle[][]> {
    const additionalRewards: ItemBundle[] = [];
    const unusualRewards: ItemBundle[] = [];
    const furnitureRewards: ItemBundle[] = [];
    const rewards: ItemBundle[] = [];

    for (const item of displayDetailRewards) {
      const { occPercent, dropType, id: reward_id, type: reward_type } = item;
      let reward_count = 1;
      let reward_rarity = 0;
      let addPercent = 0;

      if (completeState === 3) {
        if (reward_type !== "CHAR") {
          // 修复：rarity 为字符串 "TIER_N"（或 FURN 数字）——原 switch 用数字匹配
          // 恒进 default（addPercent=0），低稀有度 +count 加成永不生效；
          // 统一经 rarityToIndex 转 0~5
          const rawRarity =
            reward_type === "FURN"
              ? excel.BuildingData.customData.furnitures[reward_id]?.rarity
              : excel.getItem(reward_id)?.rarity;
          reward_rarity = rarityToIndex(rawRarity);

          switch (reward_rarity) {
            case 0:
              reward_count += randomChoices([0, 1, 2], [70, 20, 10], 1)[0];
              addPercent = 15;
              break;
            case 1:
              reward_count += randomChoices([0, 1, 2], [85, 10, 5], 1)[0];
              addPercent = 10;
              break;
            case 2:
              addPercent = 5;
              break;
            default:
              addPercent = 0;
              break;
          }
        }
      } else if (completeState === 2) {
        if (reward_type !== "FURN" && reward_type !== "CHAR") {
          reward_rarity = rarityToIndex(
            excel.getItem(reward_id)?.rarity,
          );
        }

        switch (reward_rarity) {
          case 0:
            reward_count += randomChoices([0, 1, 2], [80, 12, 8], 1)[0];
            break;
          case 1:
            reward_count += randomChoices([0, 1, 2], [97, 2, 1], 1)[0];
            break;
        }
      }

      if (stageId.toLowerCase().includes("act")) {
        addPercent += 12;
      } else {
        addPercent += randomChoices([-1, 0, 1], [5, 90, 5], 1)[0];
      }

      const handleMaterial = (stageId: string) => {
        const ToughSiege: { [key: string]: number } = {
          wk_toxic_1: 5,
          wk_toxic_2: 8,
          wk_toxic_3: 11,
          wk_toxic_4: 15,
          wk_toxic_5: 21,
        };
        const AerialThreat: { [key: string]: [number, number, number] } = {
          wk_fly_1: [3, 0, 0],
          wk_fly_2: [5, 0, 0],
          wk_fly_3: [1, 3, 0],
          wk_fly_4: [1, 1, 1.58],
          wk_fly_5: [1.49, 1.5, 2],
        };
        const ResourceSearch: { [key: string]: [number, number, number] } = {
          wk_armor_1: [1, 1, 2],
          wk_armor_2: [1, 3, 4],
          wk_armor_3: [0, 2.5, 5],
          wk_armor_4: [0, 7, 2],
          wk_armor_5: [0, 10, 2.99],
        };

        const stageData = AerialThreat[stageId] || ResourceSearch[stageId];
        if (stageData) {
          stageData.forEach((j, i) => {
            if (
              j === 0 ||
              (parseInt(stageId.slice(-1)) > 3 && reward_id === "3113")
            )
              return;
            // 修复：原 percent=floor(小数) 恒 0 → randomChoices 权重 [0,1] 恒选 +1；
            // 改为按小数部分概率 +1（数学期望 = 配置值 j）
            const jInt = Math.floor(j);
            const drop_array = Math.random() < j - jInt ? 1 : 0;
            let count = jInt + drop_array;

            if (completeState === 3) {
              if (reward_rarity === i) {
                reward_count = count;
                if (
                  reward_type === "MATERIAL" &&
                  stageId === "wk_armor_3" &&
                  reward_id === "3401"
                ) {
                  reward_count = ResourceSearch[stageId][2];
                }
              }
            } else {
              if (
                reward_type === "MATERIAL" &&
                stageId === "wk_armor_3" &&
                reward_id === "3401"
              ) {
                count = ResourceSearch[stageId][2];
              }
              reward_count = Math.round(count / (1.5 * 1.2));
            }
          });
        } else if (stageId in ToughSiege) {
          if (completeState === 3) {
            reward_count = ToughSiege[stageId] + randomChoice([1, 0, -1]);
          } else {
            reward_count = Math.round(ToughSiege[stageId] / (2 * 1.2));
          }
        }
      };

      if (reward_type === "MATERIAL") handleMaterial(stageId);

      if (reward_type === "CARD_EXP") {
        const TacticalDrill: {
          [key: string]: [number, number, number, number];
        } = {
          wk_kc_1: [2.01, 3, 0, 0],
          wk_kc_2: [3.99, 4.99, 0, 0],
          wk_kc_3: [3, 1.73, 3, 0],
          wk_kc_4: [1.99, 3, 1.99, 1],
          wk_kc_5: [0, 1, 1, 3],
          wk_kc_6: [0, 0, 2, 4],
          "sub_02-03": [6.25, 0, 0, 0],
          "main_00-10": [4.27, 0, 0, 0],
          "main_03-05": [0, 5, 0, 0],
          "sub_02-10": [0, 4, 0, 0],
          "main_04-03": [0, 0, 2.74, 0],
          "main_07-11": [0, 0, 2.56, 0],
          "main_08-06": [0, 0, 2.65, 0],
          "sub_06-1-1": [0, 0, 2.82, 0],
          "main_09-09": [0, 0, 2.73, 0],
          "main_10-01": [0, 0, 3.38, 0],
          "tough_10-01": [0, 0, 3.17, 0],
          "main_11-01": [0, 0, 3.47, 0],
          "tough_11-01": [0, 0, 3.43, 0],
          "sub_04-3-3": [0, 0, 3.59, 0],
          "sub_05-3-2": [0, 0, 2.87, 0],
        };

        if (stageId in TacticalDrill) {
          TacticalDrill[stageId].forEach((j, i) => {
            // 修复：同 divmod 概率恒 +1 / 权重反向问题；按小数部分概率 +1
            const jInt = Math.floor(j);
            const drop_array = Math.random() < j - jInt ? 1 : 0;
            const count = jInt + drop_array;
            if (completeState === 3 && reward_rarity === i) {
              reward_count = count;
            } else {
              reward_count = Math.round(count / (1.5 * 1.2));
            }
          });
        }
      }

      if (reward_type === "GOLD") {
        const SpecialGold: { [key: string]: number } = {
          "main_01-01": 660, // 1-1
          "main_02-07": 1500, // 2-7
          "main_03-06": 2040, // 3-6
          "main_04-01": 2700, // 4-1
          "main_06-01": 1216, // 6-1
          "main_07-02": 1216, // 7-3
          "main_08-01": 2700, // R8-1
          "main_08-04": 1216, // R8-4
          "main_09-01": 2700, // Standard 9-2
          "main_09-02": 1216, // Standard 9-3
          "main_10-07": 3480, // Standard 10-8
          "tough_10-07": 3480, // Adverse 10-8
          "main_11-08": 3480, // Standard 11-9
          "tough_11-08": 3480, // Adverse 11-9
          "sub_02-02": 1020, // S2-2
          "sub_04-2-3": 3480, // S4-6
          "sub_05-1-2": 2700, // S5-2
          "sub_05-2-1": 1216, // S5-3
          "sub_05-3-1": 1216, // S5-5
          "sub_06-1-2": 1216, // S6-2
          "sub_06-2-2": 2700, // S6-4
          "sub_07-1-1": 2700, // S7-1
          "sub_07-1-2": 1216, // S7-2
          act18d0_05: 1644, // WD-5
          act17side_03: 1128, // SN-3
          act5d0_01: 1000, // CB-1
          act5d0_03: 1000, // CB-3
          act5d0_05: 2000, // CB-5
          act5d0_07: 2000, // CB-7
          act5d0_09: 3000, // CB-9
          act11d0_04: 1644, // TW-4
          act16d5_04: 1644, // WR-4
        };

        if (stageId in SpecialGold) {
          reward_count =
            completeState === 3
              ? SpecialGold[stageId]
              : Math.round(SpecialGold[stageId] / 1.2);
        }
      }

      const pushReward = () => {
        if (occPercent === 0 && dropType === 3) {
          unusualRewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count,
           });
        } else if (occPercent === 0 && dropType === 4) {
          const drop_array = randomChoices(
            [0, 1],
            [95 - addPercent, 5 + addPercent],
            1,
          )[0];
          if (drop_array)
            additionalRewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count + 1,
             });
        } else {
          if (reward_type === "FURN")
            furnitureRewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count,
             });
          else
            rewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count,
             });
        }
      };

      const handleOccPercent = (occPercent: number) => {
        // 修复：NEVER/DEFINITELY_BUFF 档位（≥5）不产出，且不再刷 "Unknown dropType" 警告
        if (occPercent >= 5) return;
        if (occPercent === 0) {
          if (dropType === 1)
            displayDetailRewards = displayDetailRewards.filter(
              (i) => i !== item,
            );
          else if (dropType === 2) {
            // ALWAYS + NORMAL：必掉基础掉落（对照 Python quest.py 对应分支末尾产出）
            logger.debug(
              "BattleManager",
              `- occPercent:0,dropType:2 - ${JSON.stringify(item)}`,
            );
            pushReward();
          }
          else if (dropType === 8)
            displayDetailRewards = displayDetailRewards.filter(
              (i) => i !== item,
            );
          else pushReward();
        } else if (occPercent === 1) {
          if (dropType === 2) {
            logger.debug(
              "BattleManager",
              `- occPercent:1,dropType:2 - ${JSON.stringify(item)}`,
            );
            const drop_array = randomChoices(
              [0, 1],
              [25 - addPercent, 75 + addPercent],
              1,
            )[0];
            if (drop_array)
              rewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count,
               });
          }
        } else if (occPercent === 2) {
          if (dropType === 2) {
            logger.debug(
              "BattleManager",
              `- occPercent:2,dropType:2 - ${JSON.stringify(item)}`,
            );
            if (stageId.includes("pro_")) {
              const drop_array = randomChoices([0, 1], [50, 50], 1)[0];
              const picked = pickKeys(displayDetailRewards[drop_array], ["id", "type"]);
              rewards.push({
                id: picked.id,
                type: picked.type as ItemType,
                count: reward_count,
              });
            } else {
              const addWeights = 2;
              const drop_array = randomChoices(
                [0, 1],
                [60 - addPercent * addWeights, 40 + addPercent * addWeights],
                1,
              )[0];
              if (drop_array)
                rewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count,
                 });
            }
          }
        } else if (occPercent === 3) {
          if (dropType === 2) {
            logger.debug(
              "BattleManager",
              `- occPercent:3,dropType:2 - ${JSON.stringify(item)}`,
            );
            const drop_array = randomChoices(
              [0, 1],
              [85 - addPercent, 15 + addPercent],
              1,
            )[0];
            if (drop_array) pushReward();
          } else if (dropType === 4) {
            logger.debug(
              "BattleManager",
              `- occPercent:3,dropType:4 - ${JSON.stringify(item)}`,
            );
            const drop_array = randomChoices(
              [0, 1],
              [80 - addPercent, 20 + addPercent],
              1,
            )[0];
            if (drop_array)
              additionalRewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count,
               });
          }
        } else if (occPercent === 4) {
          if (dropType === 2) {
            logger.debug(
              "BattleManager",
              `- occPercent:4,dropType:2 - ${JSON.stringify(item)}`,
            );
            const drop_array = randomChoices(
              [0, 1],
              [97 - addPercent, 3 + addPercent],
              1,
            )[0];
            if (drop_array) pushReward();
          } else if (dropType === 3) {
            logger.debug(
              "BattleManager",
              `- occPercent:4,dropType:3 - ${JSON.stringify(item)}`,
            );
            const drop_array = randomChoices(
              [0, 1],
              [96 - addPercent, 4 + addPercent],
              1,
            )[0];
            if (drop_array)
              unusualRewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count,
               });
          } else if (dropType === 4) {
            logger.debug(
              "BattleManager",
              `- occPercent:4,dropType:4 - ${JSON.stringify(item)}`,
            );
            const drop_array = randomChoices(
              [1, 0],
              [(addPercent - 3) / 103, (100 - (addPercent - 3)) / 103],
              103,
            )[0];
            if (drop_array)
              additionalRewards.push({ id: reward_id, type: reward_type as ItemType, count: reward_count,
               });
          }
        } else {
          logger.warn("BattleManager", `Unknown dropType: ${JSON.stringify(item)}`);
        }
      };

      handleOccPercent(occPercent);
    }

    if (
      !additionalRewards.length &&
      !unusualRewards.length &&
      !rewards.length &&
      displayDetailRewards.length
    ) {
      // 防死循环：概率未中的条目永不移除，重试不会收敛；最多重试 10 轮后返回当前（可能为空）结果
      if (depth < 10) {
        return this.dropReward(displayDetailRewards, completeState, stageId, depth + 1);
      }
    }
    for (const it of additionalRewards.concat(unusualRewards, furnitureRewards, rewards)) {
      this._player.gainItem.add(it);
    }
    await this._player.gainItem.handle();
    return [additionalRewards, unusualRewards, furnitureRewards, rewards];
  }

  async loadReplay(args: { stageId: string }): Promise<string> {
    return await accountManager.getBattleReplay(
      this._player._playerdata.status.uid,
      args.stageId,
    );
  }

  async saveReplay(args: {
    battleId: string;
    battleReplay: string;
  }): Promise<void> {
    const { battleId, battleReplay } = args;
    const stageId = (
      await accountManager.getBattleInfo(
        this._player._playerdata.status.uid,
        battleId,
      )
    )?.stageId;
    return await accountManager.saveBattleReplay(
      this._player._playerdata.status.uid,
      stageId!,
      battleReplay,
    );
  }
}
