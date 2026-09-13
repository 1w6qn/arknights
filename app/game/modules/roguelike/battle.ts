import { ItemType, ItemBundle } from "@excel/excel";
import { RoguelikeV2Manager } from "./logic";
import type { RoguelikeItemBundle } from "./rlv2";
import { BattleData } from "../../kernel/battle-model";
import { decryptBattleData, decryptBattleReplay } from "@utils/crypt";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { generateBattleId } from "@utils/random";
import type { BattleRecord } from "../../kernel/battle-info-store";
import { logger } from "@utils/logger";
import excel from "@excel/excel";
import { ROGUE6_NODE } from "./theme-rules";
import { random } from "@utils/random";

/** 各账号最近一次 rlv2 战斗上下文（start 生成写入，finish 读取结算与记录留存用） */
const battleSessionByUid = new Map<
  string,
  { battleId: string; stageId: string }
>();

/**
 * rlv2 战斗结算报文视图（解密 data 与请求明文 battleData 合并后的形状）
 *
 * 客户端 battleFinish 的 battleData 为完整战报（BattleData + 结算摘要
 * finalHp/isPerfect 等），解密 data 同形；合并规则为"请求兜底、解密优先"。
 */
interface Rlv2BattleReport extends Partial<BattleData> {
  /** 结算时剩余生命（仅战报留存，不入 earn） */
  finalHp?: number;
  /** 完美作战标记（三星 isPerfect=1） */
  isPerfect?: number;
}

/** 战斗奖励组（BATTLE_REWARD 事件 payload 的单档：index/items/done） */
interface Rlv2BattleRewardBlock {
  index: number;
  items: RoguelikeItemBundle[];
  done: number;
}

/**
 * 组装 rlv2 战斗结束记录（battle_records 表留存，供未来分析）
 *
 * @param controller - RoguelikeV2Manager（提供 _player.data 访问底层 PlayerDataManager）
 * @param battleId - 战斗 id
 * @param stageId - 关卡 id
 * @param decryptResult - 解密后的战斗数据（win 路径；可为 null）
 * @param rewards - 结算奖励（扁平化为 ItemBundle 摘要）
 * @param opts - 可选战报扩展：isCheat 反作弊标识、battleLog 解析后的战斗回放
 * @returns 战斗结束记录对象
 */
function buildRlv2Record(
  controller: RoguelikeV2Manager,
  battleId: string,
  stageId: string,
  decryptResult: Rlv2BattleReport | null,
  rewards: ItemBundle[],
  opts: { isCheat?: string; battleLog?: unknown } = {},
): BattleRecord {
  // controller 内置 _player 字段即底层 PlayerDataManager（提供 uid 与记录存储）
  const player = controller._player;
  const stats = decryptResult?.battleData?.stats;
  const completeState =
    decryptResult?.completeState === 1 ? 1 : (decryptResult?.completeState ?? 0);
  return {
    battleId,
    uid: player.uid,
    stageId,
    isPractice: 0,
    source: "rlv2",
    completeState,
    beginTs: stats?.beginTs ?? Math.floor(Date.now() / 1000),
    endTs: stats?.endTs ?? Math.floor(Date.now() / 1000),
    killCnt: stats?.checkKilledCnt ?? 0,
    totalDamage: stats?.totalDamage ?? 0,
    leftHp: stats?.leftHp ?? 0,
    totalHeal: stats?.totalHeal ?? 0,
    fixedPlayTime: stats?.fixedPlayTime ?? 0,
    squadInstIds: [],
    rewards,
    stats,
    ...(opts.isCheat ? { isCheat: opts.isCheat } : {}),
    ...(opts.battleLog !== undefined ? { battleLog: opts.battleLog } : {}),
    createdTs: Math.floor(Date.now() / 1000),
  };
}

/** 黑流树海标准职业枚举（ticket 存在性由 excel recruitTickets 校验） */
const ROGUE6_CLASSES = [
  "pioneer",
  "warrior",
  "tank",
  "sniper",
  "caster",
  "support",
  "medic",
  "special",
] as const;

/**
 * 随机抽取一张黑流树海职业招募券（8 职业等概率）
 *
 * 修复：ticket id 列表原硬编码——现按职业枚举从 excel recruitTickets 过滤存在性
 * （官服 battleFinish 奖励为职业券而非通用 _all）。
 * @returns 一个职业招募券 id
 */
function pickRogue6ClassTicket(): string {
  const tickets =
    excel.RoguelikeTopicTable.details.rogue_6?.recruitTickets ?? {};
  const valid = ROGUE6_CLASSES.filter(
    (c) => tickets[`rogue_6_recruit_ticket_${c}`],
  );
  if (valid.length === 0) {
    logger.warn("rlv2", "rogue_6 recruitTickets 缺失标准职业券，回退先锋券");
    return "rogue_6_recruit_ticket_pioneer";
  }
  return `rogue_6_recruit_ticket_${valid[Math.floor(random() * valid.length)]}`;
}

export class RoguelikeBattleManager {
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("rlv2:battle:start", this.start.bind(this));
    this._trigger.on("rlv2:battle:finish", this.finish.bind(this));
  }

  /**
   * 留存 rlv2 战斗结束记录（失败不阻断结算）
   *
   * @param record - 战斗结束记录
   */
  private async persistRecord(record: BattleRecord): Promise<void> {
    try {
      await this._player._player.saveBattleRecord(record);
    } catch (e) {
      // 留存失败不影响战斗结算/状态机（分析数据偶发丢失可接受）
      logger.warn("rlv2", `战斗记录留存失败: ${(e as Error).message}`);
    }
  }

  /**
   * 合并解密战报（data）与请求明文 battleData——两者同为 BattleData 结构。
   * 解密结果为权威数据源；请求明文 battleData 用于补齐解密缺失字段，
   * 并在 data 解密失败/为空时作为降级数据源（completeState 缺失仍走软失败路径）。
   *
   * @param decryptResult - decryptBattleData<BattleData>(data) 的解密结果（可为 null）
   * @param requestBattleData - 请求顶层 battleData 字段（可为 undefined）
   * @returns 合并后的战报对象（两者皆空返回 null）
   */
  private mergeBattleData(
    decryptResult: Rlv2BattleReport | null,
    requestBattleData: BattleData | undefined,
  ): Rlv2BattleReport | null {
    if (!decryptResult && !requestBattleData) return null;
    return { ...(requestBattleData ?? {}), ...(decryptResult ?? {}) };
  }

  /**
   * 解析战斗上下文（battleId/stageId）。
   * battleId 优先取战报内回传值（客户端回传 start 下发的 battleId），
   * 会话内存 Map（battleSessionByUid）作为兜底；stageId 战报无此字段，仅走会话 Map。
   * 战报回传 battleId 与会话不一致时告警（不阻断——续局/异常场景容忍）。
   *
   * @param battleData - 合并后的战报对象
   * @param uid - 账号 uid
   * @returns 解析出的 battleId 与 stageId
   */
  private resolveBattleContext(
    battleData: Rlv2BattleReport | null,
    uid: string,
  ): { battleId: string; stageId: string } {
    const session = battleSessionByUid.get(uid);
    const reportBattleId = battleData?.battleId;
    if (reportBattleId && session?.battleId && reportBattleId !== session.battleId) {
      logger.warn(
        "rlv2",
        `battleId 不一致: 战报=${reportBattleId}, 会话=${session.battleId}`,
      );
    }
    return {
      battleId: reportBattleId || session?.battleId || "",
      stageId: session?.stageId || "",
    };
  }

  /**
   * 解析战斗回放（battleLog——base64+zip 压缩的回放数据）。
   * 空串直接跳过（不触发解析）；解析失败仅告警、不阻断结算（分析数据可丢失）。
   *
   * @param battleLog - 客户端回放字段
   * @returns 解析后的回放对象（无/解析失败为 undefined）
   */
  private async parseBattleLog(battleLog: string): Promise<unknown> {
    if (!battleLog) return undefined;
    try {
      return await decryptBattleReplay(battleLog);
    } catch (e) {
      logger.warn(
        "rlv2",
        `battleLog 解析失败（仅分析数据，不阻断结算）: ${(e as Error).message}`,
      );
      return undefined;
    }
  }

  async start([stageId]: [string]) {
    // 唯一 battleId：crypto.randomUUID 随机生成，替换固定 "1"，支持多场战斗区分/历史检索
    const battleId = generateBattleId();
    // 记录当前 battleId 与关卡，finish 据此读取本次战斗（覆盖最近一场）
    battleSessionByUid.set(this._player._player.uid, { battleId, stageId });
    let sanity = 0;
    const diceRoll = [];
    if (this._player._module.hasModule("SANCHECK")) {
      sanity = this._player._module.toJSON().san?.sanity || sanity;
    }
    if (this._player._module.hasModule("DICE")) {
      let diceUpgradeCount = 0;
      const relics = Object.values(this._player.inventory!.relic || {});
      const firstRelic = relics[0];
      const band = firstRelic?.id || "";
      if (band === "rogue_2_band_16" || band === "rogue_2_band_17" || band === "rogue_2_band_18") {
        diceUpgradeCount += 1;
      }
      for (const relic of relics) {
        if (relic.id === "rogue_2_relic_grace_63") {
          diceUpgradeCount += 1;
          break;
        }
      }
      let diceFaceCount: number;
      let diceId: string;
      if (diceUpgradeCount === 0) {
        diceFaceCount = 6;
        diceId = "trap_067_dice";
      } else if (diceUpgradeCount === 1) {
        diceFaceCount = 8;
        diceId = "trap_088_dice2";
      } else {
        diceFaceCount = 12;
        diceId = "trap_089_dice3";
      }
      for (let i = 0; i < 100; i++) {
        diceRoll.push(Math.floor(random() * diceFaceCount) + 1);
      }
    }
    await this._trigger.emit("rlv2:event:create", [
      "BATTLE",
      {
        state: 1,
        chestCnt: 2,
        goldTrapCnt: 1,
        diceRoll: diceRoll,
        boxInfo: {},
        tmpChar: [],
        sanity: sanity,
        unKeepBuff: this._player._buff.getBuffs(),
      },
    ]);
    await this._trigger.emit("save:battle", [
      battleId,
      { stageId: stageId, isPractice: 0 },
    ]);
  }

  async finish([args]: [
    {
      battleLog: string;
      data: string;
      battleData: BattleData;
    },
  ]) {
    const loginTime = this._player._player.loginTime;
    let decryptResult: BattleData | null = null;
    try {
      decryptResult = await decryptBattleData<BattleData>(args.data, loginTime);
    } catch {
      // 无效/空战斗数据（模拟器/异常结算）：降级到请求明文 battleData 判定
    }
    // 合并解密战报（data）与请求明文 battleData——解密失败时后者兜底提供 completeState
    const battleInfo = this.mergeBattleData(decryptResult, args.battleData);
    // battleId 优先取战报回传值（客户端回传 start 下发），会话 Map 兜底；stageId 仅来自会话
    const { battleId, stageId } = this.resolveBattleContext(
      battleInfo,
      this._player._player.uid,
    );
    // 战斗回放（battleLog）解析——仅留存分析数据，解析失败不阻断结算
    const replay = await this.parseBattleLog(args.battleLog);
    const event = this._player._status.pending.shift();
    const theme = this._player.current.game!.theme;
    const detail = excel.RoguelikeTopicTable.details[theme];
    const ticket = `${theme}_recruit_ticket_all`;

    for (const buff of this._player._buff.filterBuffs("battle_extra_reward")) {
      await this._trigger.emit("rlv2:get:items", [
        [
          {
            id: buff.blackboard[0].valueStr!,
            count: buff.blackboard[1].value!,
          },
        ],
      ]);
    }

    // 指挥分队升级（band_2 battle_extra_drop，prts.wiki「<3+>每次战斗结束后若护盾小于 5 点，
    // 额外获得 1 点护盾」）：blackboard = [阈值, 物品 id, 数量]；与战斗额外回复同为每次战斗结束生效。
    for (const buff of this._player._buff.filterBuffs("battle_extra_drop")) {
      const bb = buff.blackboard;
      const threshold = bb[0]?.value ?? 0;
      const dropId = bb[1]?.valueStr;
      const dropCount = bb[2]?.value ?? 1;
      if (dropId && this._player._status.property.shield < threshold) {
        await this._trigger.emit("rlv2:get:items", [
          [excel.makeItem(dropId, dropCount)],
        ]);
      }
    }

    const earn = {
      damage: 0,
      hp: 0,
      shield: 0,
      exp: 0,
      populationMax: 0,
      squadCapacity: 0,
      maxHpUp: 0,
    };

    // 战斗胜利判定：completeState 语义与标准战斗一致（1=失败 / 2=通关 / 3=三星）。
    // 修复：原实现用 `=== 1` 当胜利——真实胜利（2/3）被误判为失败 → 清空 pending、
    // 直接进 WAIT_MOVE（表现为"进入 zone 而不弹 BATTLE_REWARD"），而真实失败（1）反而误发奖励。
    // 判定基于合并后战报（解密 data 优先，请求明文 battleData 兜底）。
    const battleStats = battleInfo?.battleData?.stats;
    // 缺省视为未通关（原 `undefined >= 2` 同为 false）
    if ((battleInfo?.completeState ?? 0) >= 2) {
      // 战斗胜利：rogue_3 CHAOS 模块累积坍缩值（每次胜利 +1，达到上限升层）
      const chaosMgr = this._player._module.chaos;
      chaosMgr?.gainChaos(1);
      const finalHp = battleInfo?.finalHp || 0;
      const maxHp = this._player._status.property.hp.max;
      // 官服 battleFinish 抓包 earn = { damage:0, hp:0, shield:0, exp:13, populationMax:4 }：
      // 战斗结束不回复目标生命（回复经安全的角落/藏品），earn 仅报经验与升级增量；
      // 原实现 earn.hp=伤害*0.3 并直接回血 → 客户端结算弹出血量变化异常。
      // damage/finalHp 仅留存战报记录，不入 earn。
      void finalHp;
      void maxHp;
      
      // 指挥经验（官服单点抓包 exp=13、isPerfect=1：基础=下一级需求值，三星+3 近似）：
      // 原实现恒发"下一级需求值"且延迟到 finishBattleReward 才入账（官服在 battleFinish 响应
      // 内已带升级后的 exp/level）→ 获得数量与升级时机双重异常。现改为战斗结束即入账。
      const levelTable = detail.detailConst.playerLevelTable;
      const nextLevelReq =
        levelTable[this._player._status.property.level + 1]?.exp || 10;
      const perfectBonus = battleInfo?.isPerfect ? 3 : 0;
      earn.exp = nextLevelReq + perfectBonus;
      // earn.populationMax：本场升级带来的希望上限增加（官服=4=lv2.populationUp）
      earn.populationMax =
        levelTable[this._player._status.property.level + 1]?.populationUp ?? 0;
      // await：经验/升级需在响应序列化前入账（官服 battleFinish 响应已含升级后 exp/level）
      await this._trigger.emit("rlv2:get:items", [
        [{ id: `${theme}_exp`, count: earn.exp }],
      ]);

      // —— 战斗奖励组构建：奖励组"序 + 内容"对齐官服黑流树海 battleFinish（金/废品/招募券）——
      const rewards: Rlv2BattleRewardBlock[] = [];

      // 节点/阶段判定（boss 战必掉多件——废品/收藏品数量加成）
      // 兼容黑流树海（map.zones 键为区域索引 1000+）与标准主题（层号键）
      const pos = this._player._status.cursor.position;
      const mapZones = this._player._map.zones;
      const zoneKey = mapZones[this._player._status.cursor.zone]
        ? this._player._status.cursor.zone
        : String(1000 + this._player._status.cursor.zone - 1);
      const node = pos
        ? mapZones[zoneKey]?.nodes[pos.x * 100 + pos.y]
        : undefined;
      const curStageId = node?.stage || "";
      const isBoss = curStageId.includes("_b_");

      // 黄金奖励（官服 index 0）：基础 5-14，随击杀表现上调上限（每 10 杀 +5，封顶 30）
      const killed = (battleStats?.checkKilledCnt as number) || 0;
      const goldMax = Math.min(14 + Math.floor(killed / 10) * 5, 30);
      const goldReward = Math.floor(random() * (goldMax - 4)) + 5;
      rewards.push({
        index: 0,
        items: [{ sub: 0, id: `${theme}_gold`, count: goldReward }],
        done: 0,
      });

      // 黑流树海（rogue_6）专属：零件（废品）组（官服 index 1）——官方抓包 battleFinish
      // rewards 含 rogue_6_scrap_P_01/P_02 等。从主题 scrapItemToType 池随机 1-2 件
      // （boss 必 2 件）。
      if (theme === "rogue_6") {
        const scrapPool = Object.keys(
          excel.RoguelikeTopicTable.modules[theme]?.scrap?.scrapItemToType || {},
        );
        const scrapRewards: RoguelikeItemBundle[] = [];
        const scrapCount = isBoss ? 2 : random() < 0.5 ? 1 : 0;
        for (let i = 0; i < scrapCount && scrapPool.length > 0; i++) {
          const pick =
            scrapPool[Math.floor(random() * scrapPool.length)];
          scrapRewards.push({ sub: i, id: pick, count: 1 });
        }
        if (scrapRewards.length > 0) {
          rewards.push({ index: rewards.length, items: scrapRewards, done: 0 });
        }
      }

      // 招募券奖励（官服 index 2）：黑流树海发职业券（官服 rogue_6_recruit_ticket_sniper），
      // 其余主题沿用通用券（`${theme}_recruit_ticket_all`）。
      const rewardTicket =
        theme === "rogue_6" ? pickRogue6ClassTicket() : ticket;
      rewards.push({
        index: rewards.length,
        items: [{ sub: 0, id: rewardTicket, count: 1 }],
        done: 0,
      });

      // 通用主题（非黑流树海）追加碎片 + 随机收藏品掉落——黑流树海战斗藏品掉落
      // 走下方专属块（路标档案馆观测池，按节点类型/特殊关卡选池）。
      if (theme !== "rogue_6") {
        const fragmentPool = detail.items
          ? Object.keys(detail.items).filter((k) => k.includes("fragment"))
          : [];
        if (fragmentPool.length > 0) {
          const fragmentId =
            fragmentPool[Math.floor(random() * fragmentPool.length)];
          rewards.push({
            index: rewards.length,
            items: [{ sub: 0, id: fragmentId, count: 1 }],
            done: 0,
          });
        }

        // 随机收藏品掉落（参考 Dorothinights generateBaseBattleRewards：
        // 收藏品池过滤已拥有，boss 战必掉 2 个）
        const relicChance = isBoss ? 1 : 0.4; // 简化概率：普通/紧急 40%，boss 100%
        const hasRelic = Object.values(this._player.inventory!.relic || {}).map(
          (r) => r.id,
        );
        const relicCount = isBoss ? 2 : 1;
        if (random() < relicChance) {
          const relicItems: RoguelikeItemBundle[] = [];
          for (let i = 0; i < relicCount; i++) {
            const relicId = this._player._pool.getRelic(
              "pool_relic_all",
              hasRelic,
            );
            if (!relicId) break;
            relicItems.push({ sub: i, id: relicId, count: 1 });
            hasRelic.push(relicId);
          }
          if (relicItems.length > 0) {
            rewards.push({ index: rewards.length, items: relicItems, done: 0 });
          }
        }
      } else {
        // 黑流树海战斗藏品掉落（路标档案馆观测池 lubiao.wiki /pools/rogue_6）：
        // 作战/紧急作战/险路恶敌/居民据点各有独立池，事件战斗（湖中仙女/无效验尸/
        // 狭路相逢）按关卡选池；普通/紧急 40% 概率，首领与居民据点必掉（首领 2 件）。
        const nodeType = node?.type;
        const isSavage = nodeType === ROGUE6_NODE.RESIDENT;
        const ro6Chance = isBoss || isSavage ? 1 : 0.4;
        if (random() < ro6Chance) {
          const owned = Object.values(this._player.inventory!.relic || {}).map(
            (r) => r.id,
          );
          const ro6Count = isBoss ? 2 : 1;
          const relicItems: RoguelikeItemBundle[] = [];
          for (let i = 0; i < ro6Count; i++) {
            const relicId = this.pickBattleRelic(nodeType, curStageId, owned);
            if (!relicId) break;
            relicItems.push({ sub: i, id: relicId, count: 1 });
            owned.push(relicId);
          }
          // 狭路相逢（公平战斗）：右敌奖收藏品、左/中敌奖零件——服务端无法区分
          // 击败对象，藏品组内补 1 件随机零件（node_duel_scrap 观测池）
          if (curStageId.startsWith("ro6_duel")) {
            const scrapId = this.pickFromPool("node_duel_scrap", [], (id) => {
              const items = excel.RoguelikeTopicTable.details[theme]?.items;
              return items?.[id]?.type === "SCRAP";
            });
            if (scrapId) {
              relicItems.push({
                sub: relicItems.length,
                id: scrapId,
                count: 1,
              });
            }
          }
          if (relicItems.length > 0) {
            rewards.push({ index: rewards.length, items: relicItems, done: 0 });
          }
        }
        // 地质调查分队（rogue_6_band_21“探访节点提升战斗后获得收藏品的概率”）：
        // 额外掉落 1 件 drop_extra_pool 藏品，概率随本局已过节点数上调（近似）。
        if (this.hasBand("rogue_6_band_21")) {
          const visited = this._player._status.trace.length;
          const extraChance = Math.min(0.2 + visited * 0.02, 0.6);
          if (random() < extraChance) {
            const owned = Object.values(
              this._player.inventory!.relic || {},
            ).map((r) => r.id);
            const extraId = this.pickFromPool("drop_extra_pool", owned);
            if (extraId) {
              rewards.push({
                index: rewards.length,
                items: [{ sub: 0, id: extraId, count: 1 }],
                done: 0,
              });
            }
          }
        }
      }

      await this._trigger.emit("rlv2:event:create", [
        "BATTLE_REWARD",
        {
          earn: earn,
          rewards: rewards,
          show: "2",
          state: 0,
          isPerfect: battleInfo?.isPerfect || 0,
        },
      ]);

      // —— 自然物（GOODS）估价动态：每次作战胜利 → G_02 +2；完美作战 → G_06 +4；
      // 非完美作战 → G_06 自身损坏（移除）。
      const perfect = battleInfo?.isPerfect || 0;
      const scrap = this._player._module?.scrap;
      scrap?.applyGoodsEffect("battle_win");
      scrap?.applyGoodsEffect(perfect ? "battle_perfect" : "battle_nonperfect");

      // —— 战斗结束记录留存（win 路径）：扁平化奖励摘要 + 统计 + 回放/反作弊标识入库 ——
      const flatRewards: ItemBundle[] = [];
      for (const block of rewards) {
        for (const it of block.items ?? []) {
          flatRewards.push({ type: "" as ItemType, id: it.id, count: it.count });
        }
      }
      await this.persistRecord(
        buildRlv2Record(
          this._player,
          battleId,
          stageId,
          battleInfo,
          flatRewards,
          {
            isCheat: battleInfo?.battleData?.isCheat,
            battleLog: replay,
          },
        ),
      );

      // 特勤干员任务：战斗简单事件计数（Rlv2StageSimpleEventMore，如"使用电弧及其召唤物击杀'易'"）。
      // 事件携带本关 extraBattleInfo（键如 "radian_kill_enemy_dylbhm"），模板按任务 param 的键匹配。
      const extraInfo = battleInfo?.battleData?.stats?.extraBattleInfo;
      if (extraInfo && typeof extraInfo === "object") {
        await this._trigger.emit("Rlv2StageSimpleEventMore", [
          {
            theme: this._player.current.game?.theme || "",
            mode: this._player.current.game?.mode || "NORMAL",
            grade: this._player.current.game?.modeGrade ?? 0,
            stageId,
            events: extraInfo,
          },
        ]);
      }
    } else {
      // 自然物估价动态：非完美作战（含失败）→ G_06 自身损坏（移除）
      this._player._module?.scrap?.applyGoodsEffect("battle_fail");

      // —— 战斗结束记录留存（loss 路径）：仅统计入库，无奖励 ——
      await this.persistRecord(
        buildRlv2Record(this._player, battleId, stageId, battleInfo, [], {
          isCheat: battleInfo?.battleData?.isCheat,
          battleLog: replay,
        }),
      );

      if (battleInfo?.completeState === 1) {
        // 战斗战败（completeState 语义 1=失败）：直接结算结束本局——官服肉鸽战败即终止。
        // runResult 置 "fail"（非 "success"）→ gameSettle 的 success=0，展示失败结算页；
        // fire-and-forget 防未捕获拒绝终止进程（同 checkZoneEnd 通关路径的 void gameSettle 约定）。
        this._player._status.runResult = "fail";
        void this._player.gameSettle().catch((e: Error) =>
          logger.error("rlv2", `battle-fail gameSettle failed: ${e.message}`),
        );
      } else {
        // 解密失败/无效数据（模拟器/异常报文）：软失败——不清空整局，仅回退一步并进入
        // WAIT_MOVE（不下发结算，避免一次异常请求终止整局）。
        this._player._status.state = "WAIT_MOVE";
        while (this._player._status.pending.length > 0) {
          this._player._status.pending.shift();
        }
        this._player._status.trace.pop();
      }
    }
  }

  /**
   * 黑流树海战斗藏品选池（路标档案馆观测池）：特殊关卡优先，其次节点类型；
   * 档内池抽空后降档稀有度池/全量池。
   * - ro6_t_5/ro6_e_t_5 = 湖中仙女（普通/紧急）事件战；ro6_t_12 = 无效验尸；
   *   ro6_duel_* = 狭路相逢公平战斗（左/中/右三敌池并集）
   * - 紧急作战 → node_battle_elite；险路恶敌 → pool_boss；“居民”据点 → node_battle_savage；
   *   普通作战 → node_battle_normal（观测仅人偶之家，降档 pool_relic_normal 兜底）
   * @param nodeType 当前节点类型（ROGUE6_NODE，可为 undefined）
   * @param stageId 关卡 id（节点标记/事件战）
   * @param owned 已拥有藏品 id（过滤）
   * @returns 抽中藏品 id；全部池空返回空串
   */
  private pickBattleRelic(
    nodeType: number | undefined,
    stageId: string,
    owned: string[],
  ): string {
    const pools: string[] =
      stageId === "ro6_t_5"
        ? ["node_incident_lake_fairy"]
        : stageId === "ro6_e_t_5"
          ? ["node_incident_lake_fairy_emergency"]
          : stageId === "ro6_t_12"
            ? ["node_battle_normal_invalid_autopsy"]
            : stageId.startsWith("ro6_duel")
              ? ["node_duel_relic"]
              : nodeType === ROGUE6_NODE.BATTLE_ELITE
                ? ["node_battle_elite", "pool_relic_rare"]
                : nodeType === ROGUE6_NODE.BATTLE_BOSS
                  ? ["pool_boss", "pool_relic_super_rare"]
                  : nodeType === ROGUE6_NODE.RESIDENT
                    ? ["node_battle_savage"]
                    : ["node_battle_normal", "pool_relic_normal"];
    pools.push("pool_relic_all");
    for (const p of pools) {
      const id = this.pickFromPool(p, owned);
      if (id) return id;
    }
    return "";
  }

  /**
   * 从指定池抽 1 件未拥有且通过校验的物品（不放回，与 pool.getRelic 同语义）。
   * 默认校验 = 主题 relics 表登记（藏品结算依赖 buffs 数据）；零件等传入自定义校验。
   * @param poolId 池 id（data/rlv2/pools.json）
   * @param owned 已拥有/已抽出的物品 id（过滤）
   * @param validate 成员合法性校验（缺省：主题 relics 表登记）
   * @returns 抽中 id；池空/全被过滤返回空串
   */
  private pickFromPool(
    poolId: string,
    owned: string[],
    validate?: (id: string) => boolean,
  ): string {
    const theme = this._player.current.game?.theme || "";
    const detail = excel.RoguelikeTopicTable.details[theme];
    const ok = validate ?? ((id: string) => !!detail?.relics?.[id]);
    const pool = this._player._pool?._pools?.[poolId];
    if (!pool) return "";
    const avail = pool.filter((id) => !owned.includes(id) && ok(id));
    if (avail.length === 0) return "";
    const id = avail[Math.floor(random() * avail.length)];
    pool.splice(pool.indexOf(id), 1);
    return id;
  }

  /** 是否持有指定分队（开局分队以收藏品形式入库存，如地质调查分队） */
  private hasBand(bandId: string): boolean {
    return Object.values(this._player.inventory?.relic || {}).some(
      (r) => r.id === bandId,
    );
  }
}
