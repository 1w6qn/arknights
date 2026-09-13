/**
 * 自走棋（AutoChess，卫戍协议）赛季活动管理器
 *
 * 数据源（excel 优先）：
 * - 赛季详情：excel.ActivityTable.activity.autochessSeason[actId]（ActAutoChessData，含
 *   modeDataDict/baseRewardDataList/bandDataListDict/charShopChessDatas/stageDatasDict/
 *   bossInfoDict/constData/milestoneList 等，见 data/excel/activity_table.json）
 * - 赛季通用：excel.ActivityTable.autoChessData（AutoChessData）
 * - 玩家存档：draft.activity.AUTOCHESS_SEASON[actId]
 *   （PlayerActivity.PlayerActAutoChessActivity，CS 2.7.61 PlayerActivity.cs#L5961）
 *   与 draft.autochessSeason（PlayerAutoChessPerm { band, trainingModeFin }）
 *
 * 私服边界（与 enemyDuel 等轮次活动一致）：官方由实时对战服务（serverAddress/serverToken）
 * 驱动组队/匹配/回合推进与结算；本服务不托管实时对战，故：
 * - 训练模式（入门协议，modeType=LOCAL）走标准战斗链路（battle.start/finish），可完整游玩；
 * - 单人/多人模式（SINGLE/MULTI）按协议形状返回 battleId/team，结算按会话默认
 *   curRound=1 推进（真实回合数依赖实时对战服务，见 TODO 注释），不虚构回合数。
 */
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import excel from "@excel/excel";
import type { ActAutoChessData } from "@excel/excel";
import type { PlayerActivity, PlayerActivity_PlayerActAutoChessActivity_AutoChessSquadSlot } from "@excel/types-playerdata";
import type { PlayerDataModel } from "../../kernel/playerdata";
import type { Draft } from "mutative";
import { logger } from "@utils/logger";
import { generateBattleId, randomChoices } from "@utils/random";
import { userTimestamp } from "@utils/time";
import config from "@core/config/index";
import { activityDictKey } from "../activities/shared/unlockActivity";
import type { CommonStartBattleRequest } from "../../kernel/battle-model";
import type {
  ActAutoChessSyncInfoBattleInfo,
  ActAutoChessSyncInfoResponse,
  AutoChessCreateTeamResponse,
  AutoChessDiyCharDeploy,
  AutoChessFinishBattleResponse,
  AutoChessGetFriendAssistListResponse,
  AutoChessJoinTeamResponse,
  AutoChessQueryMatchResponse,
  AutoChessSeasonSettleGameInfo,
  AutoChessSeasonSettleTeamInfo,
  AutoChessStartBattleResponse,
  AutoChessStartMatchResponse,
  AutoChessTeamInfo,
} from "./autochess.protocol";

/** 玩家赛季存档（draft.activity.AUTOCHESS_SEASON[actId]；形状登记见 playerdata-server-adapt.ts） */
type AutoChessSeasonData = NonNullable<NonNullable<PlayerActivity["AUTOCHESS_SEASON"]>[string]>;

/** 棋池槽位（user.chessSquad[chessId]） */
type AutoChessSquadSlot = PlayerActivity_PlayerActAutoChessActivity_AutoChessSquadSlot;

/** 进行中的 autochess 单局会话（私服内存态；官方由实时对战服务持有） */
export interface AutoChessSession {
  battleId: string;
  sceneId: string;
  modeId: string;
  /** 会话所属活动（act1autochess/act2autochess）——结算与 GM 指令需要 */
  activityId: string;
  /** 出战阵营（band_bldsk 等）：官方在实时对战准备阶段选择，私服 HTTP 流无入口，恒空串 */
  bandId: string;
  startTs: number;
  endTs: number;
  /** 当前回合：私服默认 1；真实回合由实时对战服务推进（TODO：接入实时服务后回填） */
  curRound: number;
  finished: boolean;
  settled: boolean;
  /** 是否被 GM 冻结（`pause`/`resume`）；冻结期间 endTs 不变 */
  paused: boolean;
  /** 冻结时刻（userTimestamp；未冻结为 0）——`resume` 把冻结时长顺延到 endTs */
  pausedAt: number;
  /** 本局金币（GM `add_coin`） */
  coin: number;
  /** 本局生命（GM `set_hp`） */
  hp: number;
  /** 商店等级（GM `set_shop_lv`） */
  shopLv: number;
  /** 本局 Boss（GM `reroll_boss`） */
  bossId: string;
  /** 本局桌面（GM `grant_char`/`grant_item` 发放的干员棋 / 道具棋 id） */
  table: AutoChessGmTable;
}

/** 本局桌面（GM 视角：已发放的干员棋 / 道具棋 id） */
export interface AutoChessGmTable {
  chars: string[];
  items: string[];
}

/** GM 指令码（契约对齐归档服务端 GM 面板的 `/admin/autochess_gm` code 字段） */
export const AUTOCHESS_GM_CODES = [
  "state",
  "skip_round",
  "add_coin",
  "set_hp",
  "set_shop_lv",
  "grant_char",
  "grant_item",
  "reroll_boss",
  "force_settle",
  "pause",
  "resume",
] as const;

/** GM 指令码字面量联合 */
export type AutoChessGmCode = (typeof AUTOCHESS_GM_CODES)[number];

/**
 * 本局经济默认值（对齐官方实时对战服务配置）
 *
 * excel `constData` 只有 shopRefreshPrice/maxDeckChessCnt 等字段、不含经济初值；
 * 取值来源：归档 OpenBachelorSS `configs/autochess_act2.json`
 * （initialCoin=10 / initialHp=100 / maxRound=14）。
 */
export const AUTOCHESS_GM_ECONOMY = {
  initialCoin: 10,
  initialHp: 100,
  maxRound: 14,
} as const;

/** GM 指令可接受的参数值（面板 `params` 数组元素） */
export type AutoChessGmParam = string | number | boolean | null;

/** GM 本局态快照（`state` 指令与各指令的返回体） */
export interface AutoChessGmStateView {
  battleId: string;
  sceneId: string;
  modeId: string;
  activityId: string;
  curRound: number;
  startTs: number;
  endTs: number;
  paused: boolean;
  coin: number;
  hp: number;
  shopLv: number;
  bossId: string;
  table: AutoChessGmTable;
  finished: boolean;
  settled: boolean;
  maxRound: number;
}

/** GM 指令成功返回体（各指令字段并集，面板按 code 取用） */
export interface AutoChessGmData {
  code?: string;
  active?: boolean;
  state?: AutoChessGmStateView | null;
  result?: string;
  settle?: { result: number; gameSettleData: AutoChessSeasonSettleGameInfo | null } | null;
}

/** GM 指令执行结果（status 供 HTTP 层映射：无对局 409、未知指令 400） */
export type AutoChessGmResult =
  | { ok: true; data: AutoChessGmData }
  | { ok: false; reason: string; status: number };

/** 匹配状态（私服单账号内存态，官方由匹配服务持有） */
interface AutoChessMatchState {
  modeId: string;
}

export type AutoChessActionResult<T> =
  | { ok: true; data?: T }
  | { ok: false; reason: string };

/** 空结算负载（CommonFinishBattleResponse 子类通用字段，参考 enemyDuel/bossRush） */
export function emptyAutoChessFinishPayload(): Omit<
  AutoChessFinishBattleResponse,
  "playerDataDelta" | "pushMessage"
> {
  return {
    result: 0,
    apFailReturn: 0,
    expScale: 0,
    goldScale: 0,
    rewards: [],
    firstRewards: [],
    unlockStages: null,
    unusualRewards: [],
    additionalRewards: [],
    furnitureRewards: [],
    diamondMaterialRewards: [],
    alert: [],
    suggestFriend: false,
    pryResult: [],
  };
}

/** GM 面板棋池目录中的干员棋 */
export interface AutoChessGmCatalogChar {
  id: string;
  name: string;
  cost: number;
}

/** GM 面板棋池目录中的道具棋 */
export interface AutoChessGmCatalogItem {
  id: string;
  name: string;
  lv: number;
  type: string;
}

/** GM 面板棋池目录（干员棋 / 道具棋） */
export interface AutoChessGmCatalog {
  chars: AutoChessGmCatalogChar[];
  items: AutoChessGmCatalogItem[];
}

/**
 * 取赛季详情（excel.ActivityTable.activity[dictKey][actId]）
 *
 * `activity` 在生成类型里是 `{ [key: string]: JsonValue }`（多态大字典），
 * 故按既有口径做一次受控下探；键名经 activityDictKey("AUTOCHESS_SEASON") 解析
 * （转换后的 excel 键为 defaultAutoChessData）。
 * @param actId - 活动 ID（act1autochess/act2autochess）
 * @returns 赛季详情（缺失返回 undefined）
 */
function autochessSeasonData(actId: string): ActAutoChessData | undefined {
  const activity = excel.ActivityTable?.activity ?? {};
  const dict = activity as Record<string, unknown>;
  // 主路径：按类型枚举名匹配（单测替身/旧数据的字典键为 autochessSeason）。
  // 回退：真实 excel 的该字典键是 C# 字段名 defaultAutoChessData——与类型枚举名
  // AUTOCHESS_SEASON 不同名，历史缺陷：只按枚举名匹配会恒 miss，导致多人对战/结算
  // 读不到赛季配置（GM 棋池目录同理），故补一次含 "autochess" 的键回退。
  const key =
    activityDictKey("AUTOCHESS_SEASON") ??
    Object.keys(activity).find((k) => k.replace(/_/g, "").toLowerCase().includes("autochess"));
  if (!key) return undefined;
  return (dict[key] as Record<string, ActAutoChessData | undefined>)?.[actId];
}

/**
 * GM 面板棋池目录（干员棋 / 道具棋，供 GM 选择器使用）
 *
 * 数据源：赛季 `charShopChessDatas` / `trapShopChessDatas`；
 * 道具棋 `itemType`（AutoChessItemType）在面板侧只区分「法术/装备」两类，
 * 这里按 1=EQUIP / 其余=MAGIC 归一（口径与归档面板一致，待抓包校准）。
 * @param actId - 赛季活动 ID（缺省 act2autochess）
 * @returns 干员棋与道具棋列表
 */
export function autoChessGmCatalog(actId = "act2autochess"): AutoChessGmCatalog {
  const data = autochessSeasonData(actId);
  const chars: AutoChessGmCatalogChar[] = Object.entries(data?.charShopChessDatas ?? {}).map(
    ([id, chess]) => ({
      id,
      name: excel.charData(chess.charId)?.name ?? chess.charId ?? id,
      cost: chess.chessLevel ?? 0,
    }),
  );
  const items: AutoChessGmCatalogItem[] = Object.entries(data?.trapShopChessDatas ?? {}).map(
    ([id, item]) => ({
      id,
      name: item.trapId ?? id,
      lv: item.itemLevel ?? 0,
      type: item.itemType === "MAGIC" ? "MAGIC" : "EQUIP",
    }),
  );
  return { chars, items };
}

/** 自走棋赛季管理器（经 player.autoChess 访问，注册于 player-composition） */
export class AutoChessManager {
  /** 玩家数据管理器 */
  _player: PlayerDataManager;
  /** 事件触发器（预留；当前无跨系统事件） */
  _trigger: TypedEventEmitter;
  /** 进行中的单局会话：uid -> session（实例内存态，重启即失效） */
  _sessions = new Map<string, AutoChessSession>();
  /** 匹配状态：uid -> { modeId } */
  _matches = new Map<string, AutoChessMatchState>();
  /** 已结算 battleId 集合（防重复结算/重复发奖励） */
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
   * 取赛季详情（excel.ActivityTable.activity.autochessSeason[actId]）
   * @param actId - 活动 ID（act1autochess/act2autochess）
   * @returns 赛季详情（缺失返回 undefined）
   */
  private activityData(actId: string): ActAutoChessData | undefined {
    return autochessSeasonData(actId);
  }

  /**
   * 取玩家赛季存档（draft.activity.AUTOCHESS_SEASON[actId]）
   * @param draft - player.update 的 draft
   * @param actId - 活动 ID
   * @returns 玩家赛季存档（缺失返回 undefined）
   */
  private userData(draft: Draft<PlayerDataModel>, actId: string): AutoChessSeasonData | undefined {
    return draft.activity.AUTOCHESS_SEASON?.[actId];
  }

  /**
   * 惰性初始化玩家赛季存档（draft.activity.AUTOCHESS_SEASON[actId] + draft.autochessSeason）
   *
   * 形状对齐官方快照：mode/dailyMission/band/protectTs/trophyNum/milestone/match/scene/
   * globalBan/chessSquad（PlayerActAutoChessActivity）+ autoChessPerm（PlayerAutoChessPerm）。
   * @param draft - player.update 的 draft
   * @param actId - 活动 ID
   */
  private ensureState(draft: Draft<PlayerDataModel>, actId: string): void {
    const activity = (draft.activity ??= {});
    const season = (activity.AUTOCHESS_SEASON ??= {});
    if (!season[actId]) {
      season[actId] = {
        mode: {},
        dailyMission: { process: 0, state: 0 },
        band: {},
        protectTs: 0,
        trophyNum: 0,
        milestone: { point: 0, got: [] },
        match: { bannedUntilTs: 0 },
        scene: { lastMate: [] },
        globalBan: 0,
        chessSquad: {},
      };
    }
    draft.autochessSeason = draft.autochessSeason ?? { band: {}, trainingModeFin: {} };
  }

  /**
   * 私服对战地址（无真实实时对战服务，指向本服 HTTP 入口；参考 enemyDuel）
   * @returns "host:port"
   */
  private serverAddress(): string {
    return `${String(config.Host).replace(/^https?:\/\//, "")}:${config.PORT}`;
  }

  /**
   * 组装进行中战场信息（CS: ActAutoChessSyncInfoBattleInfo）
   * @param session - 进行中的会话
   * @returns 战场信息
   */
  private sessionBattleInfo(session: AutoChessSession): ActAutoChessSyncInfoBattleInfo {
    return {
      sceneId: session.sceneId,
      address: this.serverAddress(),
      token: session.battleId,
      modeId: session.modeId,
      endTime: session.endTs,
      curRound: session.curRound,
    };
  }

  /**
   * 按 modeDataDict 前置条件刷新全部模式解锁状态
   *
   * preposedMode 为空（如 mode_training_1）默认解锁；否则按 `;` 分隔的
   * 单/多线并行前置（如 mode_single_normal 前置 mode_single_funny;mode_multi_funny），
   * 任一前置模式完成即解锁。注意：部分模式文案要求多次通关
   * （如终极模拟“通关2次绝境模拟”），阈值未出现在 excel 字段，按 >=1 处理并留
   * TODO（待 prts/抓包校准）。
   * @param user    - 玩家赛季存档
   * @param actData - 赛季详情
   */
  private refreshModeUnlocks(user: AutoChessSeasonData, actData: ActAutoChessData | undefined): void {
    for (const [modeId, modeData] of Object.entries(actData?.modeDataDict ?? {})) {
      const preposed =
        (modeData?.preposedMode ?? "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean) ?? [];
      const unlocked =
        preposed.length === 0 ||
        preposed.some((p) => (user.mode?.[p]?.completeCnt ?? 0) >= 1);
      const entry = user.mode?.[modeId] ?? { unlock: 0, completeCnt: 0 };
      entry.unlock = unlocked ? 1 : 0;
      user.mode = user.mode ?? {};
      user.mode[modeId] = entry;
    }
  }

  /**
   * 同步赛季信息（/activity/autochessSeason/syncInfo）
   *
   * 惰性播种玩家存档后返回 changed（棋池变更提示，无变更空数组）与 battleInfo
   * （存在未结算会话时返回，供客户端断线重连/待结算展示）。
   * @param body - ActAutoChessSyncInfoRequest
   * @returns 响应负载（changed/battleInfo，增量由路由合并）
   */
  async syncInfo(
    body: { actId: string },
  ): Promise<Omit<ActAutoChessSyncInfoResponse, "playerDataDelta" | "pushMessage">> {
    return await this._player.update(async (draft) => {
      this.ensureState(draft, body.actId);
      const session = this._sessions.get(this._player.uid);
      return {
        changed: [],
        battleInfo:
          session && !session.settled ? this.sessionBattleInfo(session) : null,
      };
    });
  }

  /**
   * 设置棋池部署（setChessPoolDeploy）
   *
   * 校验 chessId 均在 charShopChessDatas（含 golden 映射 chessNormalIdLookupDict）且
   * 数量不超过 constData.maxDeckChessCnt（excel），通过后整体替换 chessSquad。
   * @param body - AutoChessSetChessPoolDeployRequest
   * @returns ok / 失败原因
   */
  async setChessPoolDeploy(body: {
    actId: string;
    chessPool: { [key: string]: { skillIndex?: number; currentEquip?: string | null } };
  }): Promise<AutoChessActionResult<undefined>> {
    return await this._player.update(async (draft) => {
      this.ensureState(draft, body.actId);
      const actData = this.activityData(body.actId);
      if (!actData) return { ok: false, reason: "no-activity" } as const;
      const entries = Object.entries(body.chessPool);
      const maxDeck = actData.constData?.maxDeckChessCnt ?? 0;
      if (entries.length > maxDeck) return { ok: false, reason: "too-many" } as const;
      const user = this.userData(draft, body.actId);
      if (!user) return { ok: false, reason: "no-activity" } as const;
      const squad: Record<string, AutoChessSquadSlot> = {};
      for (const [chessId, deploy] of entries) {
        const shop = this.charShopData(actData, chessId);
        if (!shop) return { ok: false, reason: `invalid-chess:${chessId}` } as const;
        squad[chessId] = this.buildSquadSlot(shop, chessId, {
          skillIndex: deploy.skillIndex ?? 1,
          currentEquip: deploy.currentEquip ?? "",
        });
      }
      user.chessSquad = squad;
      return { ok: true } as const;
    });
  }

  /**
   * 设置棋池自定干员（setChessPoolDiyChar）
   *
   * diyChessPool 中每个棋子在 charShopChessDatas/diyChessDict 内，写入 chessSquad
   * 且 type=DIY(3)，diyChar 覆盖 charId、origChessId 写入 diyBackupChessId。
   * @param body - AutoChessSetChessPoolDiyCharRequest
   * @returns ok / 失败原因
   */
  async setChessPoolDiyChar(body: {
    actId: string;
    diyChessPool: { [key: string]: AutoChessDiyCharDeploy };
  }): Promise<AutoChessActionResult<undefined>> {
    return await this._player.update(async (draft) => {
      this.ensureState(draft, body.actId);
      const actData = this.activityData(body.actId);
      if (!actData) return { ok: false, reason: "no-activity" } as const;
      const user = this.userData(draft, body.actId);
      if (!user) return { ok: false, reason: "no-activity" } as const;
      const squad = { ...(user.chessSquad ?? {}) };
      for (const [chessId, deploy] of Object.entries(body.diyChessPool)) {
        const shop = this.charShopData(actData, chessId);
        if (!shop) return { ok: false, reason: `invalid-chess:${chessId}` } as const;
        squad[chessId] = this.buildSquadSlot(shop, chessId, {
          skillIndex: deploy.skillIndex ?? 1,
          currentEquip: deploy.currentEquip ?? "",
          diyChar: deploy.diyChar ?? shop.charId ?? "",
          origChessId: deploy.origChessId ?? "",
          type: 3, // DIY
        });
      }
      user.chessSquad = squad;
      return { ok: true } as const;
    });
  }

  /**
   * 移除棋池角色（removeChessPoolChar）
   * @param body - AutoChessRemoveChessPoolCharRequest
   * @returns ok / 失败原因
   */
  async removeChessPoolChar(body: {
    actId: string;
    chessId: string;
  }): Promise<AutoChessActionResult<undefined>> {
    return await this._player.update(async (draft) => {
      this.ensureState(draft, body.actId);
      const user = this.userData(draft, body.actId);
      if (!user?.chessSquad?.[body.chessId]) {
        return { ok: false, reason: "invalid-chess" } as const;
      }
      delete user.chessSquad[body.chessId];
      return { ok: true } as const;
    });
  }

  /**
   * 设置棋池助战（setChessPoolAssist）
   *
   * 私服单账号无好友数据，assistInfo 仅记录 uid（昵称等留空，待好友系统接入）。
   * @param body - AutoChessSetFriendAssistRequest
   * @returns ok / 失败原因
   */
  async setChessPoolAssist(body: {
    actId: string;
    assistChessId: string;
    assistUid: string;
  }): Promise<AutoChessActionResult<undefined>> {
    return await this._player.update(async (draft) => {
      this.ensureState(draft, body.actId);
      const user = this.userData(draft, body.actId);
      const slot = user?.chessSquad?.[body.assistChessId];
      if (!slot) return { ok: false, reason: "invalid-chess" } as const;
      slot.assistInfo = {
        uid: body.assistUid,
        nickName: "",
        nickNumber: "",
        alias: "",
      };
      return { ok: true } as const;
    });
  }

  /**
   * 获取好友助战列表（getFriendCharAssistList）
   *
   * 私服单账号无好友，返回空列表（协议字段 assistList）。
   * @returns 响应负载
   */
  async getFriendCharAssistList(): Promise<
    Omit<AutoChessGetFriendAssistListResponse, "playerDataDelta" | "pushMessage">
  > {
    return { assistList: [] };
  }

  /**
   * 创建队伍（createTeam）
   * @param body - AutoChessCreateTeamRequest
   * @returns 响应负载（result/team）
   */
  createTeam(body: {
    activityId: string;
    modeId: string;
  }): Omit<AutoChessCreateTeamResponse, "playerDataDelta" | "pushMessage"> {
    const team: AutoChessTeamInfo = {
      teamId: generateBattleId(),
      serverAddress: this.serverAddress(),
      serverToken: `${body.modeId}|create`,
    };
    return { result: 0, team };
  }

  /**
   * 加入队伍（joinTeam）
   * @param body - AutoChessJoinTeamRequest
   * @returns 响应负载（result/team）
   */
  joinTeam(body: {
    activityId: string;
    teamId: string;
  }): Omit<AutoChessJoinTeamResponse, "playerDataDelta" | "pushMessage"> {
    const team: AutoChessTeamInfo = {
      teamId: body.teamId,
      serverAddress: this.serverAddress(),
      serverToken: "join",
    };
    return { result: 0, team };
  }

  /**
   * 开始匹配（startMatch）
   *
   * 记录匹配状态（modeId）供 queryMatch 构建 serverToken；result=0（OK）。
   * @param body - AutoChessStartMatchRequest
   * @returns 响应负载（result）
   */
  startMatch(body: {
    activityId: string;
    option?: { mode?: string; matchType?: number } | null;
  }): Omit<AutoChessStartMatchResponse, "playerDataDelta" | "pushMessage"> {
    this._matches.set(this._player.uid, {
      modeId: body.option?.mode ?? "",
    });
    return { result: 0 };
  }

  /**
   * 查询匹配（queryMatch）
   *
   * needLeave 或未匹配时返回 result=1（CANCEL）+ team=null；否则 result=0 +
   * team（serverAddress 指向本服，serverToken=modeId，参考 enemyDuel 私服实现）。
   * @param body - AutoChessQueryMatchRequest
   * @returns 响应负载（result/team）
   */
  queryMatch(body: {
    activityId: string;
    needLeave?: number;
  }): Omit<AutoChessQueryMatchResponse, "playerDataDelta" | "pushMessage"> {
    const uid = this._player.uid;
    if (body.needLeave) {
      this._matches.delete(uid);
      return { result: 1, team: null };
    }
    const match = this._matches.get(uid);
    if (!match) return { result: 1, team: null };
    return {
      result: 0,
      team: {
        teamId: generateBattleId(),
        serverAddress: this.serverAddress(),
        serverToken: match.modeId,
      },
    };
  }

  /**
   * 多人战斗开始（multiBattleStart）
   *
   * 校验 sceneId 在 stageDatasDict（excel）；创建会话（curRound 默认 1，真实回合由
   * 实时对战服务推进——TODO：接入实时服务后按服务端状态回填 endTs/curRound）。
   * @param body - AutoChessMultiBattleStartRequest
   * @returns ok（battleId/result 等 CommonStartBattleResponse 字段）/ 失败原因
   */
  async multiBattleStart(body: {
    activityId: string;
    sceneId: string;
  }): Promise<AutoChessActionResult<Omit<AutoChessStartBattleResponse, "playerDataDelta" | "pushMessage">>> {
    const uid = this._player.uid;
    const actData = this.activityData(body.activityId);
    if (!actData) return { ok: false, reason: "no-activity" };
    if (!actData.stageDatasDict?.[body.sceneId]) {
      return { ok: false, reason: "invalid-scene" };
    }
    if (this._sessions.get(uid)) return { ok: false, reason: "battle-in-progress" };
    const match = this._matches.get(uid);
    const modeId = match?.modeId ?? "";
    const mode = actData.modeDataDict?.[modeId];
    const specialPhaseTime = mode?.specialPhaseTime ?? 0; // excel：特殊阶段时长（act2autochess=150s）
    const nowTs = userTimestamp();
    const session: AutoChessSession = {
      battleId: generateBattleId(),
      sceneId: body.sceneId,
      modeId,
      activityId: body.activityId,
      bandId: "",
      startTs: nowTs,
      endTs: nowTs + specialPhaseTime,
      curRound: 1,
      finished: false,
      settled: false,
      paused: false,
      pausedAt: 0,
      coin: AUTOCHESS_GM_ECONOMY.initialCoin,
      hp: AUTOCHESS_GM_ECONOMY.initialHp,
      shopLv: 1,
      bossId: "",
      table: { chars: [], items: [] },
    };
    this._sessions.set(uid, session);
    return {
      ok: true,
      data: {
        result: 0,
        battleId: session.battleId,
        apFailReturn: 0,
        isApProtect: 0,
        inApProtectPeriod: false,
        notifyPowerScoreNotEnoughIfFailed: false,
      },
    };
  }

  /**
   * 多人战斗结束（multiBattleFinish）
   *
   * 标记会话 finished 并返回空结算负载；真实奖励/回合数据由实时对战服务结算
   * （settleGame 统一应用，见 settleGame 注释）。
   * @param body - AutoChessMultiBattleFinishRequest
   * @returns ok（空结算负载）/ 失败原因
   */
  multiBattleFinish(body: {
    activityId: string;
    sceneId: string;
  }): AutoChessActionResult<Omit<AutoChessFinishBattleResponse, "playerDataDelta" | "pushMessage">> {
    const uid = this._player.uid;
    const session = this._sessions.get(uid);
    if (!session || session.settled || session.sceneId !== body.sceneId) {
      return { ok: false, reason: "no-session" };
    }
    session.finished = true;
    return { ok: true, data: emptyAutoChessFinishPayload() };
  }

  /**
   * 引导（训练）战斗开始（startGuideBattle）
   *
   * 训练模式（入门协议）为普通关卡战斗（constData.trStageId 如 act1autochess_m01），
   * 复用标准 battle.start；校验 stageId 在 stageDatasDict。
   * @param body - AutoChessTrainingBattleStartRequest
   * @returns ok（CommonStartBattleResponse 字段）/ 失败原因
   */
  async trainingBattleStart(body: {
    activityId: string;
    stageId: string;
  }): Promise<AutoChessActionResult<Omit<AutoChessStartBattleResponse, "playerDataDelta" | "pushMessage">>> {
    const actData = this.activityData(body.activityId);
    if (!actData) return { ok: false, reason: "no-activity" };
    if (!actData.stageDatasDict?.[body.stageId]) {
      return { ok: false, reason: "invalid-stage" };
    }
    const start = await this._player.battle.start({
      stageId: body.stageId,
      // 服务端内部调用（训练战斗）：无客户端编队。
      // 注意 `slots` 必须存在——battle.start 会遍历 `squad.slots` 做危险等级/精英化校验
      // （原先此处传 `squad: []`，运行期 `[].slots` 为 undefined → 500；断言把它藏住了）。
      squad: { squadId: "", name: "", slots: [] },
      usePracticeTicket: 0,
      assistFriend: null,
      isRetro: 0,
      pray: 0,
      battleType: 0,
      continuous: { battleTimes: 1 },
      isReplay: 0,
      startTs: 0,
    });
    return {
      ok: true,
      data: {
        result: 0,
        battleId: (start as { battleId?: string }).battleId ?? "",
        apFailReturn: 0,
        isApProtect: 0,
        inApProtectPeriod: false,
        notifyPowerScoreNotEnoughIfFailed: false,
      },
    };
  }

  /**
   * 引导（训练）战斗结束（finishGuideBattle）
   *
   * 先复用标准 battle.finish（关卡结算），再标记训练模式完成
   * （autoChessPerm.trainingModeFin[trainingModeId]=1，对应 C# IsTrainingModeFinished）
   * 并推进模式解锁。训练模式 excel 描述“无奖励”，故不叠加 autochess 赛季奖励。
   * @param body - AutoChessTrainingBattleFinishRequest
   * @returns ok（结算负载）/ 失败原因
   */
  async trainingBattleFinish(body: {
    activityId: string;
    data?: string;
    battleData?: unknown;
  }): Promise<AutoChessActionResult<Omit<AutoChessFinishBattleResponse, "playerDataDelta" | "pushMessage">>> {
    const actData = this.activityData(body.activityId);
    if (!actData) return { ok: false, reason: "no-activity" };
    const trainingModeId =
      actData.constData?.trainingModeId ?? "mode_training_1"; // excel 缺失时兜底（训练模式固定 id）
    let finishPayload = emptyAutoChessFinishPayload();
    if (body.data != null && body.battleData != null) {
      try {
        finishPayload = {
          ...finishPayload,
          // battle.finish 声明了 BattleFinishResponse 骨架（见 battle.ts），可安全叠加
          ...(await this._player.battle.finish({
            data: body.data,
            battleData: body.battleData as { isCheat: string; completeTime: number },
          })),
        };
      } catch (error) {
        logger.error(
          "autochess/trainingBattleFinish",
          "标准战斗结算失败（保留训练完成状态）:",
          error,
        );
      }
    }
    await this._player.update(async (draft) => {
      this.ensureState(draft, body.activityId);
      draft.autochessSeason.trainingModeFin[trainingModeId] = 1;
      const user = this.userData(draft, body.activityId)!;
      const mode = user.mode[trainingModeId] ?? { unlock: 0, completeCnt: 0 };
      mode.unlock = 1;
      mode.completeCnt += 1;
      user.mode[trainingModeId] = mode;
      this.refreshModeUnlocks(user, actData);
    });
    return { ok: true, data: finishPayload };
  }

  /**
   * 结算游戏（settleGame）
   *
   * 依据会话 + excel 推进赛季进度（全部取值自表，公式推断处均有注释）：
   * - milestone.point += baseRewardDataList[curRound].item.count（token 数，
   *   constData.milestoneId 即该 token，milestoneList.tokenNum 为领取阈值）
   * - dailyMission.process += baseRewardDataList[curRound].dailyMissionPoint，
   *   封顶 constData.dailyMissionParam；达标置 state=CLAIMED(1)
   *   （达标后的额外 token 奖励仅在文案中，无表字段，见 TODO）
   * - mode[modeId].completeCnt+1 并刷新全模式解锁
   * - trophyRecord 暂按通过回合数（curRound）推断（TODO：待官服结算抓包校准公式）
   * 出战阵营（bandId）进度依赖实时对战选择，HTTP 流无入口，留 TODO。
   * @param body - AutoChessSettleGameRequest
   * @returns ok（result/gameSettleData）/ 失败原因
   */
  async settleGame(body: {
    activityId: string;
    quitBattle?: boolean;
  }): Promise<
    AutoChessActionResult<{
      result: number;
      gameSettleData: AutoChessSeasonSettleGameInfo | null;
    }>
  > {
    const uid = this._player.uid;
    const session = this._sessions.get(uid);
    if (!session || session.settled) return { ok: false, reason: "no-session" };
    session.settled = true;
    let gameSettleData: AutoChessSeasonSettleGameInfo | null = null;
    await this._player.update(async (draft) => {
      this.ensureState(draft, body.activityId);
      const actData = this.activityData(body.activityId);
      const user = this.userData(draft, body.activityId);
      if (!user) return;
      const constData = actData?.constData;
      // 按当前回合取基础奖励（无精确命中取低于当前回合的最高档）
      const rewards = [...(actData?.baseRewardDataList ?? [])].reverse();
      const baseReward =
        rewards.find((r) => r.round <= session.curRound) ?? rewards[0];
      const tokenAdd = baseReward?.item?.count ?? 0;
      const dailyAdd = baseReward?.dailyMissionPoint ?? 0;
      // 里程碑点 = 累计 token 数（constData.milestoneId 即该 token 物品）
      if (tokenAdd > 0) {
        user.milestone = user.milestone ?? { point: 0, got: [] };
        user.milestone.point = (user.milestone.point ?? 0) + tokenAdd;
      }
      // 每日防卫目标进度（封顶 dailyMissionParam）
      if (dailyAdd > 0) {
        user.dailyMission = user.dailyMission ?? { process: 0, state: 0 };
        const target = constData?.dailyMissionParam ?? Number.MAX_SAFE_INTEGER;
        user.dailyMission.process = Math.min(
          (user.dailyMission.process ?? 0) + dailyAdd,
          target,
        );
        if (
          constData?.dailyMissionParam != null &&
          user.dailyMission.process >= constData.dailyMissionParam
        ) {
          user.dailyMission.state = 1; // CLAIMED
        }
        // TODO：达标额外 token（dailyMissionRule 文案 x300）无表字段，暂不发
      }
      // 模式完成计数 + 解锁链
      if (session.modeId) {
        const mode = user.mode[session.modeId] ?? { unlock: 0, completeCnt: 0 };
        mode.unlock = 1;
        mode.completeCnt += 1;
        user.mode[session.modeId] = mode;
        this.refreshModeUnlocks(user, actData);
      }
      // 奖杯：按通过回合数推断（TODO：待官服结算抓包校准，出战阵营进度同待实时服务）
      const trophyRecord = session.curRound;
      user.trophyNum = (user.trophyNum ?? 0) + trophyRecord;
      const selfStatus = this._player._playerdata.status ?? {};
      const selfTeam: AutoChessSeasonSettleTeamInfo = {
        uid: this._player.uid,
        channel: 0,
        passRound: session.curRound,
        gameCode: 1, // DEAD（C#: 胜利=DEAD，见 AutoChessSettleGamePlayerStatus）
        card: {
          title: "",
          nickname: selfStatus.nickName ?? "",
          nicknameNumber: String(selfStatus.nickNumber ?? ""),
          level: selfStatus.level ?? 0,
          trophyNum: user.trophyNum ?? 0,
          secretary: selfStatus.secretary ?? "",
          secretarySkinId: "",
          secretarySkinSp: false,
          avatarType: "",
          avatarId: "",
          nameCardSkinId: "",
          nameCardSkinTmpl: 0,
        },
        uidIndex: 0,
      };
      gameSettleData = {
        modeId: session.modeId,
        bandId: session.bandId,
        startTs: session.startTs,
        endTs: session.endTs,
        gameFinished: true,
        isViolation: false,
        bossRecord: [],
        onStageChars: [],
        onStageBond: [],
        teamInfo: [selfTeam],
        recordInfos: {
          trophyRecord,
          normalMilestone: user.milestone?.point ?? 0,
          dailyMilestone: user.dailyMission?.process ?? 0,
          dailyProcessAdd: dailyAdd,
        },
      };
    });
    this._settledBattleIds.add(session.battleId);
    this._sessions.delete(uid);
    return { ok: true, data: { result: 0, gameSettleData } };
  }

  /**
   * 退出单机游戏（quitSingleGame）
   *
   * 清除进行中会话并返回 battleInfo=null（无进行中战场）。
   * @param body - AutoChessQuitSingleGameRequest
   * @returns 响应负载（result/battleInfo）
   */
  quitSingleGame(body: {
    activityId: string;
    sceneId: string;
  }): {
    result: number;
    battleInfo: ActAutoChessSyncInfoBattleInfo | null;
  } {
    const uid = this._player.uid;
    const session = this._sessions.get(uid);
    if (session && session.sceneId === body.sceneId) {
      this._sessions.delete(uid);
    }
    return { result: 0, battleInfo: null };
  }

  /**
   * 结算点赞（settleLike）——私服无跨玩家点赞，空实现
   * @returns 空对象（增量由路由合并）
   */
  settleLike(): Record<string, never> {
    return {};
  }

  /**
   * 上报战斗结果（report）——服务端自定义，空实现
   * @returns 空对象（增量由路由合并）
   */
  report(): Record<string, never> {
    return {};
  }

  /**
   * 取棋池干员商城配置（charShopChessDatas 直接命中或经 chessNormalIdLookupDict 映射）
   * @param actData - 赛季详情
   * @param chessId - 棋子 ID
   * @returns 商城配置（缺失返回 undefined）
   */
  private charShopData(
    actData: ActAutoChessData,
    chessId: string,
  ): ActAutoChessData["charShopChessDatas"][string] | undefined {
    const direct = actData.charShopChessDatas?.[chessId];
    if (direct) return direct;
    const normalId = actData.chessNormalIdLookupDict?.[chessId];
    return normalId ? actData.charShopChessDatas?.[normalId] : undefined;
  }

  /**
   * 构建 chessSquad 槽位（PlayerActAutoChessActivity.AutoChessSquadSlot）
   * @param shop        - 商城配置
   * @param chessId     - 棋子 ID
   * @param options     - 部署项/自定义字段
   * @returns 槽位数据
   */
  private buildSquadSlot(
    shop: ActAutoChessData["charShopChessDatas"][string],
    chessId: string,
    options: {
      skillIndex: number;
      currentEquip: string;
      diyChar?: string;
      origChessId?: string;
      type?: number;
    },
  ): AutoChessSquadSlot {
    return {
      chessId,
      charId: options.diyChar ?? shop.charId ?? "",
      tmplId: shop.tmplId ?? "",
      diyBackupChessId: options.origChessId ?? "",
      cultivateEffect: "",
      currentEquip: options.currentEquip,
      skin: "",
      type: options.type ?? 0, // OWN
      potentialRank: 0,
      skillIndex: options.skillIndex,
      assistInfo: { uid: "", nickName: "", nickNumber: "", alias: "" },
    };
  }

  /**
   * 本局态视图（GM `state` 与各指令的返回体）
   * @param session - 进行中的会话
   * @returns 可 JSON 序列化的本局态快照
   */
  private gmStateView(session: AutoChessSession): AutoChessGmStateView {
    return {
      battleId: session.battleId,
      sceneId: session.sceneId,
      modeId: session.modeId,
      activityId: session.activityId,
      curRound: session.curRound,
      startTs: session.startTs,
      endTs: session.endTs,
      paused: session.paused,
      coin: session.coin,
      hp: session.hp,
      shopLv: session.shopLv,
      bossId: session.bossId,
      table: { chars: [...session.table.chars], items: [...session.table.items] },
      finished: session.finished,
      settled: session.settled,
      maxRound: AUTOCHESS_GM_ECONOMY.maxRound,
    };
  }

  /**
   * 执行 GM 指令（卫戍协议 GM；契约对齐归档服务端 GM 面板的 `/admin/autochess_gm`）
   *
   * 语义边界（本仓无实时对战服务，故直接驱动本进程内的单局会话态）：
   * - `state` 为查询：无对局返回 `{active:false}`（不算错误）；其余指令无对局 → 409
   * - `force_settle('win')` 复用既有 `settleGame` 结算链路（正常发奖），
   *   `force_settle('lose')` 仅清场不发奖
   * - `pause`/`resume` 冻结/顺延 `endTs`；`skip_round` 不超过 `maxRound`
   * @param code   - 指令码（见 AUTOCHESS_GM_CODES）
   * @param params - 指令参数：数值类取 params[0]，干员/道具类取字符串 id，force_settle 取 'win'|'lose'
   * @returns 成功数据或失败原因（status 供 HTTP 层映射）
   */
  async executeGm(code: string, params: AutoChessGmParam[] = []): Promise<AutoChessGmResult> {
    if (!(AUTOCHESS_GM_CODES as readonly string[]).includes(code)) {
      return { ok: false, reason: `unknown-code: ${code}`, status: 400 };
    }
    const uid = this._player.uid;
    const session = this._sessions.get(uid);
    const num = (fallback: number): number | null => {
      const raw = params[0];
      if (raw === undefined || raw === null || raw === "") return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const str = (): string => (typeof params[0] === "string" ? params[0].trim() : "");
    if (code === "state") {
      return {
        ok: true,
        data: session
          ? { active: true, state: this.gmStateView(session) }
          : { active: false, state: null },
      };
    }
    if (!session) {
      return { ok: false, reason: "no-active-battle", status: 409 };
    }
    switch (code) {
      case "skip_round": {
        session.curRound = Math.min(session.curRound + 1, AUTOCHESS_GM_ECONOMY.maxRound);
        break;
      }
      case "add_coin":
      case "set_hp":
      case "set_shop_lv": {
        const fallback = code === "add_coin" ? 10 : code === "set_hp" ? 100 : 1;
        const n = num(fallback);
        if (n === null) return { ok: false, reason: "invalid-param", status: 400 };
        const value = Math.trunc(n);
        if (code === "add_coin") session.coin = Math.max(0, session.coin + value);
        else if (code === "set_hp") session.hp = Math.max(0, value);
        else session.shopLv = Math.max(1, value);
        break;
      }
      case "grant_char": {
        const chessId = str();
        if (!chessId) return { ok: false, reason: "invalid-param", status: 400 };
        session.table.chars.push(chessId);
        break;
      }
      case "grant_item": {
        const itemId = str();
        if (!itemId) return { ok: false, reason: "invalid-param", status: 400 };
        session.table.items.push(itemId);
        break;
      }
      case "reroll_boss": {
        const bosses = Object.values(this.activityData(session.activityId)?.bossInfoDict ?? {});
        if (!bosses.length) return { ok: false, reason: "no-boss-config", status: 409 };
        const weights = bosses.map((b) => (Number.isFinite(b.weight) && b.weight > 0 ? b.weight : 1));
        session.bossId = randomChoices(bosses, weights, 1)[0]?.bossId ?? "";
        break;
      }
      case "pause": {
        if (session.paused) return { ok: false, reason: "already-paused", status: 409 };
        session.paused = true;
        session.pausedAt = userTimestamp();
        break;
      }
      case "resume": {
        if (!session.paused) return { ok: false, reason: "not-paused", status: 409 };
        session.paused = false;
        session.endTs += Math.max(0, userTimestamp() - session.pausedAt);
        session.pausedAt = 0;
        break;
      }
      case "force_settle": {
        const outcome = str() === "lose" ? "lose" : "win";
        if (outcome === "lose") {
          session.settled = true;
          this._settledBattleIds.add(session.battleId);
          this._sessions.delete(uid);
          return { ok: true, data: { result: "lose", settle: null } };
        }
        const settled = await this.settleGame({ activityId: session.activityId });
        if (!settled.ok) return { ok: false, reason: settled.reason, status: 409 };
        return { ok: true, data: { result: "win", settle: settled.data ?? null } };
      }
      default:
        return { ok: false, reason: `unknown-code: ${code}`, status: 400 };
    }
    return { ok: true, data: { code, state: this.gmStateView(session) } };
  }
}
