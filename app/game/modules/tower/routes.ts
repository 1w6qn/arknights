/**
 * 爬塔路由模块
 *
 * 处理保全派驻相关的 HTTP 请求，包括游戏创建、神卡初始化、战斗处理等功能。
 * 请求/响应类型见 @game/modules/tower/tower（参考 CS 2.7.61 协议类）。
 *
 * 实现说明：
 * - 路由处理函数通过 PlayerDataManager.update() 修改玩家数据，并使用 player.delta 返回增量。
 * - 爬塔状态保存在 player.tower.current 中，所有变更均通过 Immer 跟踪。
 * - 战斗结果与随机招募逻辑相比 Python 参考实现有所简化，但保证玩家数据正确更新。
 */

import { Router } from "express";
import type { Draft } from "mutative";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import type {
  PlayerDataModel,
  TowerCurrent,
  TowerCurrent_HalftimeCandidateGroup,
  TowerCurrent_HalftimeRecruit,
  TowerCurrent_TowerCardType,
  TowerCurrent_TowerGameLayer,
} from "../../kernel/playerdata";
import type { BattleData } from "../../kernel/battle-model";
import { now } from "@utils/time";
import { decryptBattleData } from "@utils/crypt";
import { randomSample } from "@utils/random";
import excel, { ItemBundle } from "@excel/excel";
import { logger } from "@utils/logger";
import {
  ClimbTowerBattleFinishRequest,
  ClimbTowerBattleFinishResponse,
  ClimbTowerBattleStartRequest,
  ClimbTowerBattleStartResponse,
  ClimbTowerCreateGameRequest,
  ClimbTowerCreateGameResponse,
  ClimbTowerHalftimeRecruitRequest,
  ClimbTowerHalftimeRecruitResponse,
  ClimbTowerInitGameRequest,
  ClimbTowerInitGameResponse,
  ClimbTowerInitGodCardRequest,
  ClimbTowerInitGodCardResponse,
  ClimbTowerInitSquadRequest,
  ClimbTowerInitSquadResponse,
  ClimbTowerLayerFirstPassRewardRequest,
  ClimbTowerLayerFirstPassRewardResponse,
  ClimbTowerRecruitSubGodCardRequest,
  ClimbTowerRecruitSubGodCardResponse,
  ClimbTowerSeasonMissionAwardRequest,
  ClimbTowerSeasonMissionAwardResponse,
  ClimbTowerSettleGameRequest,
  ClimbTowerSettleGameResponse,
  ClimbTowerSweepRequest,
  ClimbTowerSweepResponse,
} from "./tower";
import { validateBody } from "@core/http/validate-body";
import {
  battleFinishSchema,
  battleStartSchema,
  chooseSubGodCardSchema,
  createGameSchema,
  initCardSchema,
  initGameSchema,
  initGodCardSchema,
  layerRewardSchema,
  recruitSchema,
  seasonMissionsAwardSchema,
  settleGameSchema,
  sweepGameSchema,
} from "./tower.schema";
import {
  advanceTowerSeasonMissions,
  claimTowerLayerRewards,
  currentTowerSeason,
  ensureTowerOuterTower,
  ensureTowerSeasonMissions,
  ensureTowerState,
  normalizeTowerLayers,
  towerDetailConst,
} from "./tower-reward";

const router = Router();

/**
 * 招募候选组的服务端真值视图
 *
 * 生成模型 `TowerCurrent_HalftimeCandidateGroup.type` 声明为 `number`，但 CS 字段实为
 * `TowerCardType` 枚举、服务端（与参考实现 `reference/opendoctoratepy-ex-public/server/tower.py`
 * createRecruitList）下发字符串 `"CHAR"`。为保持既有下发值不变，按真值视图构造
 * （生成模型 → 本视图必然可赋值，无需断言）。
 */
type HalftimeCandidateGroupView = Omit<TowerCurrent_HalftimeCandidateGroup, "type"> & {
  type: TowerCurrent_TowerCardType | number;
};

/** tower.current 的服务端真值视图（仅覆盖招募候选组 type 的生成模型偏差） */
type TowerCurrentView = Omit<TowerCurrent, "halftime"> & {
  halftime: Omit<TowerCurrent_HalftimeRecruit, "candidate"> & {
    candidate: HalftimeCandidateGroupView[];
  };
};

/**
 * 生成爬塔招募候选列表
 *
 * 从玩家未在当前爬塔卡组中使用的干员里随机抽取 5 名，构造候选列表。
 * 简化实现：与 Python 参考相比不依赖 dexNav，直接遍历 troop.chars。
 *
 * @param draft - 玩家数据的 Immer 草稿
 * @returns 候选干员列表（结构同协议中 halftime.candidate）
 */
function buildRecruitCandidate(draft: Draft<PlayerDataModel>): HalftimeCandidateGroupView[] {
  const allCards = Object.keys(draft.troop.chars);
  const usedCards = Object.values(draft.tower.current.cards).map(
    (c) => c.relation,
  );
  const available = allCards.filter((c) => !usedCards.includes(c));
  // 候选数量上限为 5，不足时返回全部可用干员
  const picked = randomSample(
    [...available],
    Math.min(5, available.length),
  );
  return picked.map((charInstId) => {
    const char = draft.troop.chars[charInstId];
    return {
      groupId: char.charId,
      type: "CHAR",
      cards: [
        {
          instId: "0",
          type: "CHAR",
          charId: char.charId,
          relation: charInstId,
          evolvePhase: char.evolvePhase,
          level: char.level,
          favorPoint: char.favorPoint,
          potentialRank: char.potentialRank,
          mainSkillLvl: char.mainSkillLvl,
          skills: char.skills ?? [],
          defaultSkillIndex: char.defaultSkillIndex ?? 0,
          currentEquip: char.currentEquip ?? null,
          equip: char.equip ?? {},
          skin: char.skin ?? "",
        },
      ],
    };
  });
}

/**
 * 创建爬塔游戏
 *
 * 根据 tower 与 isHard 参数从塔表中读取关卡列表，初始化爬塔状态机。
 * 状态切换为 INIT_GOD_CARD，等待玩家选择主神卡。
 *
 * @route POST /tower/createGame
 * @param req.body.tower - 塔ID
 * @param req.body.isHard - 是否困难模式（1 表示困难）
 * @returns 玩家增量数据，包含完整的 tower.current 初始化结构
 */
router.post("/createGame", validateBody(createGameSchema), async (req, res) => {
  const player = getPlayer();
  const { tower, isHard } = req.body as ClimbTowerCreateGameRequest;

  // 缺参校验：tower 为必填字段
  if (tower == null) {
    res.send({ result: 1, ...player.delta } as ClimbTowerCreateGameResponse);
    return;
  }

  // 从塔表中读取对应模式（普通/困难）的关卡列表
  const towerData = excel.ClimbTowerTable.towers[tower];
  const levels =
    isHard === 1 ? towerData.hardLevels : towerData.levels;

  // 构造层数列表，每层初始尝试次数为 0 且未通过
  const layer = levels.map((level: string) => ({
    id: level,
    tryNum: 0,
    pass: 0,
  }));

  await player.update(async (draft) => {
    draft.tower.current = {
      cards: {},
      godCard: {
        id: "",
        subGodCardId: "",
      },
      halftime: {
        canGiveUp: false,
        candidate: [],
        count: 0,
      },
      layer,
      reward: {
        high: 0,
        low: 0,
      },
      status: {
        coord: 0,
        isHard: isHard === 1,
        start: Math.round(now()),
        state: "INIT_GOD_CARD",
        strategy: "OPTIMIZE",
        tactical: {
          CASTER: "",
          MEDIC: "",
          PIONEER: "",
          SNIPER: "",
          SPECIAL: "",
          SUPPORT: "",
          TANK: "",
          WARRIOR: "",
        },
        tower,
      },
      trap: [],
    };
  });

  res.send(player.delta satisfies ClimbTowerCreateGameResponse);
});

/**
 * 初始化神卡
 *
 * 设置玩家选择的主神卡 ID，状态由 INIT_GOD_CARD 切换为 INIT_BUFF。
 *
 * @route POST /tower/initGodCard
 * @param req.body.godCardId - 神卡ID
 * @returns 玩家增量数据
 */
router.post("/initGodCard", validateBody(initGodCardSchema), async (req, res) => {
  const player = getPlayer();
  const { godCardId } = req.body as ClimbTowerInitGodCardRequest;

  await player.update(async (draft) => {
    draft.tower.current.status.state = "INIT_BUFF";
    draft.tower.current.godCard.id = godCardId;
  });

  res.send(player.delta satisfies ClimbTowerInitGodCardResponse);
});

/**
 * 初始化游戏
 *
 * 设置策略与战术配置，状态由 INIT_BUFF 切换为 INIT_CARD，等待玩家选卡。
 *
 * @route POST /tower/initGame
 * @param req.body.strategy - 策略（如 OPTIMIZE）
 * @param req.body.tactical - 战术配置，按职业映射战术 buff ID
 * @returns 玩家增量数据
 */
router.post("/initGame", validateBody(initGameSchema), async (req, res) => {
  const player = getPlayer();
  const { strategy, tactical } = req.body as ClimbTowerInitGameRequest;

  await player.update(async (draft) => {
    draft.tower.current.status.state = "INIT_CARD";
    draft.tower.current.status.strategy = strategy;
    draft.tower.current.status.tactical = tactical;
  });

  res.send(player.delta satisfies ClimbTowerInitGameResponse);
});

/**
 * 初始化卡牌
 *
 * 根据玩家选择的槽位列表，从 troop.chars 中读取对应干员数据，
 * 复制到爬塔卡组 tower.current.cards 中。状态由 INIT_CARD 切换为 STANDBY。
 *
 * @route POST /tower/initCard
 * @param req.body.slots - 槽位数组，每项包含 charInstId、skillIndex、currentEquip
 * @returns 玩家增量数据
 */
router.post("/initCard", validateBody(initCardSchema), async (req, res) => {
  const player = getPlayer();
  const { slots } = req.body as ClimbTowerInitSquadRequest;

  // 缺参校验：slots 必须为非空数组
  if (!Array.isArray(slots) || slots.length === 0) {
    res.send({ result: 1, ...player.delta } as ClimbTowerInitSquadResponse);
    return;
  }

  await player.update(async (draft) => {
    draft.tower.current.status.state = "STANDBY";

    let cnt = 1;
    for (const slot of slots) {
      const charInstId = String(slot.charInstId);
      const char = draft.troop.chars[charInstId];
      draft.tower.current.cards[String(cnt)] = {
        charId: char.charId,
        currentEquip: slot.currentEquip ?? null,
        // 注意：协议字段为 defaultSkillIndex，对应请求中的 skillIndex
        defaultSkillIndex: slot.skillIndex ?? char.defaultSkillIndex ?? 0,
        equip: char.equip ?? {},
        evolvePhase: char.evolvePhase,
        favorPoint: char.favorPoint,
        instId: String(cnt),
        level: char.level,
        mainSkillLvl: char.mainSkillLvl,
        potentialRank: char.potentialRank,
        relation: charInstId,
        skills: char.skills ?? [],
        skin: char.skin ?? "",
        type: "CHAR",
      };
      cnt += 1;
    }
  });

  res.send(player.delta satisfies ClimbTowerInitSquadResponse);
});

/**
 * 爬塔战斗开始
 *
 * 记录当前关卡在 layer 列表中的索引到 status.coord，并增加该关卡的尝试次数。
 *
 * @route POST /tower/battleStart
 * @param req.body.stageId - 关卡ID
 * @returns 玩家增量数据
 */
router.post("/battleStart", validateBody(battleStartSchema), async (req, res) => {
  const player = getPlayer();
  const { stageId } = req.body as ClimbTowerBattleStartRequest;

  await player.update(async (draft) => {
    // 计算当前关卡在层数列表中的索引（0-based）
    const coord = draft.tower.current.layer.findIndex(
      (l) => l.id === stageId,
    );
    if (coord >= 0) {
      draft.tower.current.status.coord = coord;
    }
    // 增加当前关卡的尝试次数
    for (const stage of draft.tower.current.layer) {
      if (stage.id === stageId) {
        stage.tryNum += 1;
        break;
      }
    }
  });

  res.send(player.delta satisfies ClimbTowerBattleStartResponse);
});

/**
 * 爬塔战斗结束
 *
 * 解密战斗数据并根据 completeState 处理结果：
 * - completeState === 1：失败，仅增加尝试次数。
 * - 其他值：成功，根据当前关卡位置切换状态：
 *   - 第三层（索引 2）：进入 SUB_GOD_CARD_RECRUIT，解析 trap 信息。
 *   - 最后一层：进入 END 状态。
 *   - 其他层：进入 RECRUIT 状态。
 * 成功时还会推进 coord、增加 halftime.count 并刷新招募候选列表。
 *
 * @route POST /tower/battleFinish
 * @param req.body.data - 加密的战斗数据
 * @returns 战斗结果（drop/isNewRecord/trap）与玩家增量数据
 */
router.post("/battleFinish", validateBody(battleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const { data } = req.body as ClimbTowerBattleFinishRequest;

  // 解密战斗数据（失败时不影响主流程，按失败处理）
  let battleData: BattleData;
  try {
    battleData = await decryptBattleData<BattleData>(data, player.loginTime);
  } catch (err) {
    logger.error("tower/battleFinish", "decrypt failed:", err);
    res.send({
      drop: [],
      isNewRecord: false,
      trap: [],
      ...player.delta,
    } satisfies ClimbTowerBattleFinishResponse);
    return;
  }

  const trap: { id: string; alias: string }[] = [];
  // 修复（2026-09-09，S1）：通关最后一层时补发保全派驻勋章事件（PassTower 模板），
  // 原实现该事件从未 emit → 59 枚「保全任务」勋章永不可得。
  let clearedTowerId = "";
  let clearedHard = false;

  await player.update(async (draft) => {
    const current: TowerCurrentView = draft.tower.current;
    const coord = current.status.coord;

    if (battleData.completeState === 1) {
      // 战斗失败：tryNum 已在 battleStart 计入（修复：原实现 start 与 finish 双计 → 2 倍）
      return;
    }

    // 战斗成功
    const currentStage = current.layer[coord]?.id;
    const layerCount = current.layer.length;
    // 修复（2026-09-09）：层通关标记从未写入（TowerCurrent_TowerGameLayer.pass 恒 0）——
    // 首通奖励与 best 进度都依赖它
    if (current.layer[coord]) current.layer[coord].pass = 1;

    if (layerCount >= 3 && coord === 2) {
      // 第三层：进入副神卡招募阶段
      current.status.state = "SUB_GOD_CARD_RECRUIT";
      // 解析 trap 信息：键名格式形如 "DETAILED,<id>,<alias>,legion_gain_reward_trap"
      const stats = battleData?.battleData?.stats ?? {};
      const extraBattleInfo = stats.extraBattleInfo ?? {};
      for (const key of Object.keys(extraBattleInfo)) {
        if (
          key.startsWith("DETAILED") &&
          key.endsWith("legion_gain_reward_trap")
        ) {
          const parts = key.split(",");
          if (parts.length >= 3) {
            trap.push({
              id: parts[1],
              alias: parts[2],
            });
          }
        }
      }
      current.trap = trap;
    } else if (coord === layerCount - 1) {
      // 最后一层：游戏结束（= 通关，用于保全派驻勋章判定）
      current.status.state = "END";
      clearedTowerId = String(current.status.tower ?? "");
      clearedHard = !!current.status.isHard;
    } else {
      // 其他层：进入招募阶段
      current.status.state = "RECRUIT";
    }

    // 增加当前层尝试次数：已由 battleStart 计入（修复：原实现 start 与 finish 双计 → 2 倍）
    // for (const stage of current.layer) { if (stage.id === currentStage) { stage.tryNum += 1; break; } }

    // 推进坐标与中场计数，并刷新招募候选
    current.status.coord += 1;
    current.halftime.count += 1;
    current.halftime.candidate = buildRecruitCandidate(draft);
  });

  // 修复（2026-09-09）：通关勋章事件（medal_tower_complete_*，PassTower 模板）
  if (clearedTowerId) {
    await player._trigger.emit("PassTower", [
      { stageId: clearedTowerId, count: 1, isHard: clearedHard },
    ]);
  }

  res.send({
    drop: [],
    isNewRecord: false,
    trap,
    ...player.delta,
  } satisfies ClimbTowerBattleFinishResponse);
});

/**
 * 爬塔招募
 *
 * 处理玩家在招募阶段的选择：
 * - halftime.count === 1 时保持 RECRUIT 状态并重置 count（用于连续招募）。
 * - 否则切换到 STANDBY 状态，继续推进关卡。
 * - giveUp !== 1 时，根据 charId 在 troop.chars 中查找干员并加入爬塔卡组。
 * 最后刷新招募候选列表。
 *
 * @route POST /tower/recruit
 * @param req.body.charId - 干员ID
 * @param req.body.giveUp - 是否放弃（1 表示放弃招募）
 * @returns 玩家增量数据
 */
router.post("/recruit", validateBody(recruitSchema), async (req, res) => {
  const player = getPlayer();
  const { charId, giveUp } = req.body as ClimbTowerHalftimeRecruitRequest;
  let recruitedProfession = "";

  await player.update(async (draft) => {
    const current: TowerCurrentView = draft.tower.current;

    // 根据 halftime 计数切换状态
    if (current.halftime.count === 1) {
      current.status.state = "RECRUIT";
      current.halftime.count = 0;
    } else {
      current.status.state = "STANDBY";
    }

    if (giveUp !== 1) {
      // 招募指定干员到爬塔卡组：instId 接在已有卡组末尾（+2 与参考实现保持一致）
      const cnt = Object.keys(current.cards).length + 2;
      // 通过 charId 在 troop.chars 中查找第一个匹配的 instId
      let charInstId = "";
      for (const [instId, char] of Object.entries(draft.troop.chars)) {
        if (char.charId === charId) {
          charInstId = instId;
          break;
        }
      }
      const char = draft.troop.chars[charInstId];
      if (char) {
        recruitedProfession = String(excel.charData(char.charId)?.profession ?? "");
        current.cards[String(cnt)] = {
          charId,
          currentEquip: char.currentEquip ?? null,
          defaultSkillIndex: char.defaultSkillIndex ?? 0,
          equip: char.equip ?? {},
          evolvePhase: char.evolvePhase,
          favorPoint: char.favorPoint,
          instId: String(cnt),
          level: char.level,
          mainSkillLvl: char.mainSkillLvl,
          potentialRank: char.potentialRank,
          relation: charInstId,
          skills: char.skills ?? [],
          skin: char.skin ?? "",
          type: "CHAR",
        };
      }
    }

    // 重新生成招募候选列表
    current.halftime.candidate = buildRecruitCandidate(draft);
    // 修复（2026-09-09）：赛季任务进度从未推进（TowerRecruit 模板：累计招募 N 次某职业）
    if (recruitedProfession) {
      ensureTowerSeasonMissions(draft, Math.round(now()));
      advanceTowerSeasonMissions(draft, { recruitProfession: recruitedProfession });
    }
  });

  res.send(player.delta satisfies ClimbTowerHalftimeRecruitResponse);
});

/**
 * 选择副神卡
 *
 * 设置玩家选择的副神卡 ID，状态由 SUB_GOD_CARD_RECRUIT 切换为 STANDBY。
 *
 * @route POST /tower/chooseSubGodCard
 * @param req.body.subGodCardId - 副神卡ID
 * @returns 玩家增量数据
 */
router.post("/chooseSubGodCard", validateBody(chooseSubGodCardSchema), async (req, res) => {
  const player = getPlayer();
  const { subGodCardId } = req.body as ClimbTowerRecruitSubGodCardRequest;

  await player.update(async (draft) => {
    ensureTowerState(draft);
    draft.tower.current.status.state = "STANDBY";
    draft.tower.current.godCard.subGodCardId = subGodCardId;
    // 修复（2026-09-09）：导能配件甄选结果从未落盘（官服 outer.pickedGodCard: { 神卡: [副卡…] }）
    const godCardId = String(draft.tower.current.godCard.id ?? "");
    if (godCardId) {
      const picked = draft.tower.outer.pickedGodCard as Record<string, string[]>;
      if (!Array.isArray(picked[godCardId])) picked[godCardId] = [];
      if (subGodCardId && !picked[godCardId].includes(subGodCardId)) {
        picked[godCardId].push(subGodCardId);
      }
    }
  });

  res.send(player.delta satisfies ClimbTowerRecruitSubGodCardResponse);
});

/**
 * 爬塔结算
 *
 * 修复（2026-09-09）：原实现直接返回 high{0,24}/low{0,60} 且不写 `outer.towers[]` —— 打通零报酬、
 * 进度不落盘。现按 `climb_tower_table`：
 * - 领取本次已通关层的首通奖励（`rewardInfoList`，按 `detailConst` 上限 60/24 封顶，已领层去重）；
 * - 写 `outer.towers[tower]` 的 best / hardBest / unlockHard / canSweep / canSweepHard；
 * - 推进赛季任务（TowerCardPassLayer / TowerCardChallenge / TowerSettlePass / TowerSettleLayer）；
 * - 记录 `season.passWithGodCard` 与 `outer.hasTowerPass`。
 *
 * @route POST /tower/settleGame
 * @returns 奖励信息（cnt/from/to）、时间戳与玩家增量数据
 */
router.post("/settleGame", validateBody(settleGameSchema), async (req, res) => {
  const player = getPlayer();
  req.body as ClimbTowerSettleGameRequest;

  const detail = towerDetailConst();
  const lowId = String(detail.lowerItemId ?? "mod_update_token_1");
  const highId = String(detail.higherItemId ?? "mod_update_token_2");
  let lowBefore = 0;
  let lowAfter = 0;
  let highBefore = 0;
  let highAfter = 0;
  let lowCnt = 0;
  let highCnt = 0;
  let grantedItems: ItemBundle[] = [];

  await player.update(async (draft) => {
    ensureTowerState(draft);
    const current = draft.tower.current;
    const towerId = String(current?.status?.tower ?? "");
    const isHard = Boolean(current?.status?.isHard);
    const layers: TowerCurrent_TowerGameLayer[] = Array.isArray(current?.layer) ? current.layer : [];
    const totalLayers = layers.length;
    const clearedSorts = layers
      .map((l, idx) => (l?.pass === 1 ? idx + 1 : 0))
      .filter((s) => s > 0);
    const clearedLayers = clearedSorts.length;
    lowBefore = Number(draft.inventory?.[lowId] ?? 0);
    highBefore = Number(draft.inventory?.[highId] ?? 0);
    if (towerId && clearedLayers > 0) {
      const claim = claimTowerLayerRewards(draft, towerId, clearedSorts, isHard);
      grantedItems = claim.granted;
      lowCnt = claim.low;
      highCnt = claim.high;
      const rec = ensureTowerOuterTower(draft, towerId);
      if (clearedLayers > Number(rec.best ?? 0)) rec.best = clearedLayers;
      if (isHard && clearedLayers > Number(rec.hardBest ?? 0)) rec.hardBest = clearedLayers;
      if (isHard) rec.isHardValid = 1;
      const fullClear = totalLayers > 0 && clearedLayers >= totalLayers;
      if (fullClear && !isHard) rec.unlockHard = true;
      // 扫荡解锁：该塔属于当期赛季且已全通（官服快照中仅当期赛季塔带 canSweep）
      const season = currentTowerSeason(Math.round(now()));
      const inSeason = Boolean(season && (season.towers ?? []).includes(towerId));
      if (inSeason && fullClear) {
        if (isHard) rec.canSweepHard = true;
        else rec.canSweep = true;
      }
      if (fullClear) {
        draft.tower.outer.hasTowerPass = 1;
        const godCardId = String(current?.godCard?.id ?? "");
        if (godCardId) {
          const passMap = draft.tower.season.passWithGodCard;
          if (!Array.isArray(passMap[godCardId])) passMap[godCardId] = [];
          if (!passMap[godCardId].includes(towerId)) passMap[godCardId].push(towerId);
        }
      }
      ensureTowerSeasonMissions(draft, Math.round(now()));
      advanceTowerSeasonMissions(draft, {
        godCardId: String(current?.godCard?.id ?? ""),
        towerId,
        clearedLayers,
        totalLayers,
        isHard,
      });
      lowAfter = Number(draft.inventory?.[lowId] ?? 0);
      highAfter = Number(draft.inventory?.[highId] ?? 0);
    }
    draft.tower.current.status = {
      state: "NONE",
      tower: "",
      coord: 0,
      tactical: {
        PIONEER: "",
        WARRIOR: "",
        TANK: "",
        SNIPER: "",
        CASTER: "",
        SUPPORT: "",
        MEDIC: "",
        SPECIAL: "",
      },
      strategy: "OPTIMIZE",
      start: 0,
      isHard: false,
    };
    draft.tower.current.layer = [];
    draft.tower.current.cards = {};
    draft.tower.current.godCard = {
      id: "",
      subGodCardId: "",
    };
    draft.tower.current.halftime = {
      count: 0,
      candidate: [],
      canGiveUp: false,
    };
    draft.tower.current.trap = [];
    draft.tower.current.reward = { high: 0, low: 0 };
  });

  if (grantedItems.length > 0) {
    for (const it of grantedItems) player.gainItem.add(it);
    await player.gainItem.handle();
  }

  res.send({
    reward: {
      high: { cnt: highCnt, from: highBefore, to: highAfter },
      low: { cnt: lowCnt, from: lowBefore, to: lowAfter },
    },
    ts: Math.round(now()),
    ...player.delta,
  } satisfies ClimbTowerSettleGameResponse);
});

/**
 * 获取层首通奖励
 *
 * 修复（2026-09-09）：原实现直接 `sendStatus(202)`（无响应体），客户端拿不到 delta；也不发奖。
 * 现按 `climb_tower_table.rewardInfoList[stageSort-1]` 发放 `detailConst.lowerItemId` /
 * `higherItemId`（上限 60 / 24），并把层号记入 `outer.towers[tower].reward` 去重
 * （官服存档实证：reward 即已领取层号数组）。
 *
 * @route POST /tower/layerReward
 * @returns 玩家增量数据
 */
router.post("/layerReward", validateBody(layerRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ClimbTowerLayerFirstPassRewardRequest;
  let grantedItems: ItemBundle[] = [];
  await player.update(async (draft) => {
    ensureTowerState(draft);
    const towerId = String(body.tower || draft.tower.current?.status?.tower || "");
    if (!towerId) return;
    const isHard = body.isHard === 1 || body.isHard === true;
    let sorts = normalizeTowerLayers(body.layers);
    if (sorts.length === 0) {
      // 未带 layers 时按「本次已通关且未领取」的层补齐
      const layers: TowerCurrent_TowerGameLayer[] = Array.isArray(draft.tower.current?.layer)
        ? draft.tower.current.layer
        : [];
      sorts = layers.map((l, idx) => (l?.pass === 1 ? idx + 1 : 0)).filter((s) => s > 0);
    }
    grantedItems = claimTowerLayerRewards(draft, towerId, sorts, isHard).granted;
  });
  if (grantedItems.length > 0) {
    for (const it of grantedItems) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send(player.delta satisfies ClimbTowerLayerFirstPassRewardResponse);
});

/**
 * 领取赛季任务奖励
 *
 * 修复（2026-09-09）：原实现 `sendStatus(202)` 不发奖、不置 hasRecv。现对达成（value ≥ target）
 * 且未领取的赛季任务发 `missionData[id].rewards` 并置 `season.missions[id].hasRecv = true`。
 *
 * @route POST /tower/seasonMissionsAward
 * @returns 玩家增量数据
 */
router.post("/seasonMissionsAward", validateBody(seasonMissionsAwardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ClimbTowerSeasonMissionAwardRequest;
  const grantedItems = await claimTowerSeasonMissions(player, body);
  if (grantedItems.length > 0) {
    for (const it of grantedItems) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send(player.delta satisfies ClimbTowerSeasonMissionAwardResponse);
});

/**
 * 赛季任务奖励（客户端拼写别名）
 * 客户端实际调用 /tower/seasonMissonsAward（CS 类名同此拼写），既有 /seasonMissionsAward 命中不到
 *
 * @route POST /tower/seasonMissonsAward
 * @returns 玩家增量数据
 */
router.post("/seasonMissonsAward", validateBody(seasonMissionsAwardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ClimbTowerSeasonMissionAwardRequest;
  const grantedItems = await claimTowerSeasonMissions(player, body);
  if (grantedItems.length > 0) {
    for (const it of grantedItems) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send(player.delta satisfies ClimbTowerSeasonMissionAwardResponse);
});

/**
 * 扫荡游戏
 *
 * 修复（2026-09-09）：原实现 `sendStatus(202)`。现要求 `outer.towers[tower].canSweep`
 * （该塔属当期赛季且已全通）后，一次性领取该塔全部未领首通奖励；客户端给了 `itemId` 时
 * 按 `detailConst.sweepCostCount` 扣费（不足则 result=1 拒绝）。
 *
 * @route POST /tower/sweepGame
 * @returns 玩家增量数据
 */
router.post("/sweepGame", validateBody(sweepGameSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ClimbTowerSweepRequest;
  let grantedItems: ItemBundle[] = [];
  let ok = true;
  await player.update(async (draft) => {
    ensureTowerState(draft);
    const towerId = String(body.tower || draft.tower.current?.status?.tower || "");
    const isHard = body.isHard === 1 || body.isHard === true;
    const rec = towerId ? draft.tower.outer.towers[towerId] : undefined;
    const canSweep = isHard ? Boolean(rec?.canSweepHard) : Boolean(rec?.canSweep);
    if (!towerId || !canSweep) {
      ok = false;
      return;
    }
    const cost = Math.max(0, Number(towerDetailConst().sweepCostCount ?? 0));
    if (body.itemId && cost > 0) {
      const stock = Number(draft.inventory[body.itemId] ?? 0);
      if (stock < cost) {
        ok = false;
        return;
      }
      draft.inventory[body.itemId] = stock - cost;
    }
    const totalLayers = Number(excel.ClimbTowerTable?.towers?.[towerId]?.levels?.length ?? 0);
    const all = Array.from({ length: totalLayers }, (_, i) => i + 1);
    grantedItems = claimTowerLayerRewards(draft, towerId, all, isHard).granted;
  });
  if (!ok) {
    res.send({ result: 1, ...player.delta });
    return;
  }
  if (grantedItems.length > 0) {
    for (const it of grantedItems) player.gainItem.add(it);
    await player.gainItem.handle();
  }
  res.send(player.delta satisfies ClimbTowerSweepResponse);
});

/**
 * 领取赛季任务奖励（两个拼写端点共用）
 * @param player - 玩家数据管理器
 * @param body - 请求体（missionIds 可选；缺省时领取全部已达成任务）
 * @returns 实际发放的物品列表
 */
async function claimTowerSeasonMissions(
  player: PlayerDataManager,
  body: ClimbTowerSeasonMissionAwardRequest,
): Promise<ItemBundle[]> {
  const out: ItemBundle[] = [];
  await player.update(async (draft) => {
    ensureTowerState(draft);
    ensureTowerSeasonMissions(draft, Math.round(now()));
    const wanted = Array.isArray(body.missionIds) && body.missionIds.length > 0
      ? body.missionIds
      : Object.keys(draft.tower.season.missions);
    const missions = excel.ClimbTowerTable?.missionData ?? {};
    for (const id of wanted) {
      const state = draft.tower.season.missions[id];
      if (!state || state.hasRecv) continue;
      if (Number(state.value ?? 0) < Number(state.target ?? 1)) continue;
      state.hasRecv = true;
      for (const reward of missions[id]?.rewards ?? []) {
        out.push({
          id: String(reward.id),
          count: Number(reward.count ?? 0),
          type: String(reward.type ?? "MATERIAL") as ItemBundle["type"],
        });
      }
    }
  });
  return out;
}

export default router;
