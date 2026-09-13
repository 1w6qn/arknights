import excel from "@excel/excel";
import { PlayerRoguelikeV2 } from "./rlv2";
import { RoguelikeV2Manager } from "./logic";
import { now } from "@utils/time";
import { rarityToIndex } from "@utils/rarity";
import { logger } from "@utils/logger";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { random } from "@utils/random";

/**
 * 招募候选/结果干员（官方 activeRecruitTicket/recruitChar 的运行时形状）
 *
 * 与内部模型 RecruitChar 的差异：
 *  - instId/troopInstId 为字符串序号（模型为 number；候选用列表下标序号、结果用入队序号）；
 *  - 不下发玩家养成字段 gainTime/voiceLan；equip/currentEquip 仅结果结构补齐（候选无）。
 * 声明为 RecruitChar 的 Omit 视图，使「运行时形状 → 模型」的桥接断言可成立
 * （RecruitChar → 该形状可赋值，反向不可）。
 */
type Rlv2RecruitCandidate = Omit<
  PlayerRoguelikeV2.CurrentData.RecruitChar,
  "instId" | "troopInstId" | "gainTime" | "voiceLan" | "currentEquip" | "equip"
> & {
  instId: string | number;
  troopInstId: string | number;
  /** 结果结构补齐（候选不下发） */
  currentEquip?: PlayerRoguelikeV2.CurrentData.RecruitChar["currentEquip"];
  equip?: PlayerRoguelikeV2.CurrentData.RecruitChar["equip"];
};

/**
 * 分队初始干员（immediate_recruit）入队 payload
 *
 * 官方简化入队结构：不含候选的 skin/defaultSkillIndex（其余字段同候选白名单）。
 */
type Rlv2RecruitInitialChar = Omit<
  Rlv2RecruitCandidate,
  "skin" | "defaultSkillIndex"
>;

export class RoguelikeRecruitManager {
  tickets: { [key: string]: PlayerRoguelikeV2.CurrentData.Recruit };
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._index = 0;
    this.tickets = player.current.inventory?.recruit || {};
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("rlv2:init", () => {
      this.tickets = {};
      this._index = 0;
    });
    this._trigger.on("rlv2:create", () => {
      this.tickets = {};
      this._index = 0;
    });
    this._trigger.on("rlv2:recruit:gain", async ([id, from, mustExtra]) => {
      await this.gain(id, from, mustExtra);
    });
    this._trigger.on("rlv2:recruit:active", async ([id]) => {
      await this.active(id);
    });
    this._trigger.on("rlv2:recruit:done", async ([id, optionId]) => {
      await this.done(id, optionId);
    });
    this._trigger.on("rlv2:recruit:initial_char", async ([charId]) => {
      await this.initialChar(charId);
    });
    this._trigger.on("rlv2:create", () => {
      this.tickets = {};
    });
  }

  /**
   * 各主题招募希望消耗表（索引 = rarityIdx，TIER_1..6 → 0..5）：
   * 黑流树海（rogue_6）：4 星及以下 0 希望、5 星 2、6 星 6（官方文本+实测确认，初始希望 6）
   * 萨卡兹的无终奇语（rogue_5）：4 星 0、5 星 2、6 星 6（官方表 000026）
   * 其余主题（rogue_1..4）：3 星 0、4 星 2、5 星 3、6 星 6（常规曲线）
   */
  private populationFor(rarityIdx: number): number {
    const theme = this._player.current.game?.theme || "";
    const map =
      theme === "rogue_6"
        ? [0, 0, 0, 0, 2, 6]
        : theme === "rogue_5"
          ? [0, 0, 0, 0, 2, 6]
          : [0, 0, 0, 2, 3, 6];
    return map[rarityIdx] || 0;
  }

  /**
   * 各主题干员进阶希望消耗表（索引 = rarityIdx，TIER_1..6 → 0..5）：
   * 黑流树海（rogue_6）：4 星 1、5 星 2、6 星 3（进阶曲线）
   * 萨卡兹的无终奇语（rogue_5）：4 星 1、5 星 1、6 星 3（官方表 000113；
   * 用户消息写 000123 疑笔误，以官方表 ★★★★★ 进阶 1 为准）
   * 其余主题：进阶不消耗希望（[0,0,0,0,0,0]）。
   * 进阶接口（如后续实现）按此扣希望；当前路由无进阶干员接口，表备用于客户端协议。
   */
  private advancePopulationFor(rarityIdx: number): number {
    const theme = this._player.current.game?.theme || "";
    const map =
      theme === "rogue_6"
        ? [0, 0, 0, 1, 2, 3]
        : theme === "rogue_5"
          ? [0, 0, 0, 1, 1, 3]
          : [0, 0, 0, 0, 0, 0];
    return map[rarityIdx] || 0;
  }

  /**
   * 分队初始干员（immediate_recruit）：临时干员直接入队（TEMP 类型，不占招募票）
   * @param charId 干员 id（如 char_504_rguard）
   */
  async initialChar(charId: string): Promise<void> {
    const data = excel.charData(charId)!;
    if (!data) return;
    const rarity = rarityToIndex(data.rarity);
    const popMap = [0, 0, 0, 2, 3, 6];
    // 递增 troopInstId（1 基，与 getChar 直接使用 troopInstId 的约定一致——
    // 原实现此处 0 基 + getChar +1 错位到 2，首名初始干员 instId 应为 1）
    const troopInstId = Object.keys(this._player.troop.chars).length + 1;
    const char: Rlv2RecruitInitialChar = {
      instId: 0,
      charId,
      type: "TEMP",
      upgradePhase: 0,
      upgradeLimited: true,
      population: popMap[rarity] || 0,
      isUpgrade: false,
      isCure: true,
      charBuff: [],
      troopInstId,
      level: 1,
      exp: 0,
      evolvePhase: 0,
      favorPoint: 0,
      potentialRank: 0,
      mainSkillLvl: 1,
      skills: [],
    };
    // 精简白名单结构 → 模型 RecruitChar（桥接断言方向见 Rlv2RecruitCandidate）
    await this._trigger.emit("rlv2:char:get", [
      char as PlayerRoguelikeV2.CurrentData.RecruitChar,
    ]);
  }

  _index: number;

  get index(): string {
    return `t_${this._index}`;
  }

  async active(id: string) {
    const theme = this._player.current.game!.theme;
    this.tickets[id].state = 1;
    const ticketInfo =
      excel.RoguelikeTopicTable.details[theme].recruitTickets[
        this.tickets[id].id
      ] ??
      excel.RoguelikeTopicTable.details[theme].upgradeTickets?.[
        this.tickets[id].id
      ];
    // 遗物/奖励可发放 upgradeTickets（如 *_from_relic），结构与 recruitTickets 同构；
    // 未知票（无候选定义）跳过激活，避免 500。
    if (!ticketInfo?.professionList) {
      logger.warn("rlv2", `active: 未知招募票 ${this.tickets[id].id}，跳过激活`);
      return;
    }
    // 候选干员来自玩家主队伍（collection，312 干员），非 rlv2 对局内 troop（初始为空）
    // 防御：troop 未初始化（构造/测试早期）时不崩
    const troopChars = this._player._player._playerdata.troop?.chars ?? {};
    const chars: Rlv2RecruitCandidate[] = Object.values(troopChars).reduce<
      Rlv2RecruitCandidate[]
    >((acc, char) => {
      const data = excel.charData(char.charId)!;

      if (!ticketInfo.professionList.some((p) => data.profession.includes(p))) {
        return acc;
      }
      if (!ticketInfo.rarityList.some((r) => data.rarity == r)) {
        return acc;
      }
      let isUpgraded = false;
      const rarity = data.rarity;
      // rarity 为字符串枚举（"TIER_N"）→ 统一转数值下标（0 基）
      const rarityIdx = rarityToIndex(rarity);
      let population = this.populationFor(rarityIdx);
      for (const buff of this._player._buff.filterBuffs("recruit_cost")) {
        if (
          buff.blackboard[0].valueStr?.includes(data.rarity.toString()) &&
          buff.blackboard[1].valueStr?.includes(data.profession)
        ) {
          population += buff.blackboard[2].value!;
        }
      }
      // 难度效果：招募 N 星干员希望消耗 +cost（recruit_hop_cost，blackboard min_star/cost/gte）。
      // 语义：gte=1 表示"N 星及以上"（rogue_2/3，>= 阈值）；gte=0 表示精确 N 星
      // （rogue_1/4/5/6——难度13"五星+1"仅对 5 星、难度15"六星+1"仅对 6 星；
      // 原实现统一 >= 会让 6 星同时吃到 5 星与 6 星两条 4+1+1=6，官方应为 4+1=5）
      for (const buff of this._player._buff.filterBuffs("recruit_hop_cost")) {
        const minStar = buff.blackboard[0]?.value ?? 0;
        const cost = buff.blackboard[1]?.value ?? 0;
        const gte = buff.blackboard[2]?.value ?? 0;
        // rarityIdx 0 基：TIER_3→2 / TIER_4→3 / TIER_5→4 / TIER_6→5，与星级（3/4/5/6）差 1
        if (minStar > 0 && (gte ? rarityIdx + 1 >= minStar : rarityIdx + 1 === minStar)) {
          population += cost;
        }
      }
      // 分队效果：本源研修分队（recruit_cost_sub_profession）——本源系子职业干员（4星+）希望降低
      // 官方 buff：rarity "TIER_4,TIER_5,TIER_6" + sub_profession "primcaster,primprotector,primguard,ritualist" + delta -2
      for (const buff of this._player._buff.filterBuffs(
        "recruit_cost_sub_profession",
      )) {
        const rarities = (buff.blackboard[0]?.valueStr || "").split(",");
        const subProfs = (buff.blackboard[1]?.valueStr || "").split(",");
        const delta = buff.blackboard[2]?.value ?? 0;
        if (
          delta !== 0 &&
          rarities.includes(String(data.rarity)) &&
          subProfs.includes(data.subProfessionId)
        ) {
          population += delta;
        }
      }
      for (const buff of this._player._buff.filterBuffs(
        "limited_direct_upgrade",
      )) {
        if (
          buff.blackboard[0].valueStr?.includes(data.rarity.toString()) &&
          buff.blackboard[1].valueStr?.includes(data.profession)
        ) {
          isUpgraded = random() <= buff.blackboard[3].value!;
        }
      }

      if (char.charId == "char_4151_tinman") {
        population -= char.evolvePhase > 0 ? 2 : 1;
      }
      let levelPatch: {
        level?: number;
        exp?: number;
        evolvePhase?: number;
      } = {};
      if (char.evolvePhase == 2 && !isUpgraded) {
        const maxLevel = excel.GameDataConst.maxLevel[rarityIdx][1];
        levelPatch = {
          evolvePhase: 1,
          level: maxLevel,
          exp: 0,
        };
      }
      // 候选干员结构对齐官服（activeRecruitTicket 抓包）——精简结构：
      // 官服 list[0] = {instId:"0"(字符串), charId, type:"NORMAL", favorPoint,
      //   potentialRank, mainSkillLvl, skin, level, exp, evolvePhase,
      //   defaultSkillIndex, skills:[], upgradeLimited, upgradePhase,
      //   isUpgrade:false, isCure:false, population, charBuff:[], troopInstId:"0",
      //   master:{}}——skills/equip 空、instId/troopInstId 字符串、
      //   无 gainTime/currentEquip/voiceLan 等玩家养成字段（客户端按白名单解析）
      return [
        ...acc,
        {
          instId: String(acc.length),
          charId: char.charId,
          type: "NORMAL",
          // 信赖取整（客户端 PlayerCharacter.favorPoint 为 int；历史数据可能出现
          // 小数/超上限——招募候选/结果直接透传会破坏客户端解析）
          favorPoint: Math.round(char.favorPoint ?? 0),
          potentialRank: char.potentialRank ?? 0,
          mainSkillLvl: char.mainSkillLvl ?? 1,
          skin: char.skin ?? "",
          level: levelPatch.level ?? char.level ?? 1,
          exp: levelPatch.exp ?? char.exp ?? 0,
          evolvePhase: levelPatch.evolvePhase ?? char.evolvePhase ?? 0,
          defaultSkillIndex:
            (char.defaultSkillIndex ?? 0) >= 0 ? char.defaultSkillIndex ?? 0 : 0,
          skills: [],
          upgradeLimited: !isUpgraded,
          upgradePhase: isUpgraded ? 1 : 0,
          isUpgrade: false,
          isCure: false,
          population: population >= 0 ? population : 0,
          charBuff: [],
          troopInstId: String(
            char.instId ?? Object.keys(this._player.troop.chars).length,
          ),
          master: {},
        },
      ];
    }, []);

    const freeCharIndexes: number[] = [];
    const tierMap: { [key: string]: number } = {
      TIER_1: 1,
      TIER_2: 2,
      TIER_3: 3,
      TIER_4: 4,
      TIER_5: 5,
      TIER_6: 6,
    };

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const charData = excel.charData(char.charId)!;
      if (!charData) continue;

      const extraFreeRarity = ticketInfo.extraFreeRarity || [];
      for (const tier of extraFreeRarity) {
        const tierNum = tierMap[tier];
        if (tierNum && String(charData.rarity) === tier) {
          freeCharIndexes.push(i);
          break;
        }
      }
    }

    if (freeCharIndexes.length > 0) {
      const freeIndex = freeCharIndexes[Math.floor(random() * freeCharIndexes.length)];
      chars[freeIndex].type = "FREE";
      chars[freeIndex].population = 0;
    }

    const sortedByRarity = [...chars].sort((a, b) => {
      const aRarity = Number(String(excel.charData(a.charId)?.rarity ?? "").replace("TIER_", "")) || 0;
      const bRarity = Number(String(excel.charData(b.charId)?.rarity ?? "").replace("TIER_", "")) || 0;
      return aRarity - bRarity;
    });

    if (sortedByRarity.length >= 3) {
      const thirdLowChar = sortedByRarity[2];
      const thirdLowIndex = chars.findIndex((c) => c.charId === thirdLowChar.charId);
      if (thirdLowIndex !== -1) {
        chars[thirdLowIndex].type = "THIRD_LOW";
      }
    }

    // 候选（精简白名单）→ 模型 RecruitChar（桥接断言方向见 Rlv2RecruitCandidate）
    this.tickets[id].list = chars as PlayerRoguelikeV2.CurrentData.RecruitChar[];
  }

  async done(id: string, optionId: string) {
    // 一张票只能招募一次（官方语义）：state=0 未打开 / 2 已招募 / 3 已放弃(close)
    // 都拒绝招募——仅 state=1（active 打开）可招募；已招募的票重复调用幂等返回
    // （不重复扣希望/入队），放弃的票不可复活。undefined 容错防 500。
    if (!this.tickets[id] || this.tickets[id].state !== 1) return;
    this.tickets[id].state = 2;
    const picked = this.tickets[id].list.find(
      (item) => String(item.instId) === String(optionId),
    ) as Rlv2RecruitCandidate | undefined;
    if (!picked) return;
    // 官服 recruitChar 响应结构（2026-08-18 抓包校准）：完整养成结构——
    //   instId = 玩家主队伍 instId（非候选序号）；troopInstId = 对局内入队序号（1 基递增）；
    //   skills/master/equip/currentEquip 从玩家源干员补齐（候选 list 为精简结构：
    //   skills 空/master {} /无 equip——activeRecruitTicket 抓包确认）。
    // 候选生成时 troopInstId 暂存玩家 instId（active() 里 troopInstId=char.instId），
    // 此处先读玩家源干员补齐养成，再覆写为对局内入队序号（1 基递增）。
    const troopChars = this._player._player.troop.getChars();
    const src = troopChars[String(picked.troopInstId)];
    const troopNo = Object.keys(this._player.troop.chars).length + 1;
    // 首次招募精二干员时 active() 用 levelPatch 将候选锁定为精一（evolvePhase=1、
    // 精一满级、exp=0）。此时若仍从精二源干员原样补齐 skills/master/equip/
    // currentEquip，会"显示为精一却携带精二专属养成（专精/模组/三技能）"。官方
    // 机制（集成战略招募说明）能力上限同样锁定精一满级——故降级时同步裁剪：
    //   * skills 仅保留精一阶段已解锁的技能（按 unlockCond.phase <= evolvePhase，
    //     精二才解锁的三技能等剔除），且 specializeLevel 归零（精一不可专精）
    //   * defaultSkillIndex 钳制到保留后的技能数内（默认技能若被剔除会越界）
    //   * master 清空（专项记录随专精归零）
    //   * equip/currentEquip 清空（模组需精二解锁）
    let skills = src?.skills || [];
    let master = src?.master || {};
    let equip = src?.equip || {};
    let currentEquip = src?.currentEquip ?? "";
    let defaultSkillIndex = picked.defaultSkillIndex ?? 0;
    const downgraded = (src?.evolvePhase ?? 0) > (picked.evolvePhase ?? 0);
    if (downgraded) {
      const capPhase = picked.evolvePhase ?? 0;
      // phase 兼容数字（0）与字符串枚举（"PHASE_1"/"PHASE_2"）
      const phaseOf = (v: number | string | null | undefined): number =>
        typeof v === "number"
          ? v
          : parseInt(String(v ?? "").replace(/PHASE_/i, ""), 10) || 0;
      const skillData =
        excel.CharacterTable?.[picked.charId]?.skills || [];
      // 解锁相位字段名跨版本有两种：2.7.71 起官方把 MainSkill 的 unlockCond 更名为
      // initialUnlockCond（槽位/语义不变）。旧数据仍用 unlockCond，故两者都读以保持兼容。
      // 历史缺陷：只读 unlockCond，数据升级后该键被移除 → phaseOf(undefined)=0 →
      // 精二才解锁的三技能未被剔除（精一却带三技能）。
      const unlockCondOf = (
        s:
          | {
              initialUnlockCond?: { phase?: number | string };
              /** 2.7.71 前旧字段名（与 initialUnlockCond 同语义） */
              unlockCond?: { phase?: number | string };
            }
          | undefined,
      ) => s?.initialUnlockCond ?? s?.unlockCond;
      const cappedSkills = (src?.skills ?? []).filter((_skill, i: number) => {
        return phaseOf(unlockCondOf(skillData[i])?.phase) <= capPhase;
      });
      skills = cappedSkills.map((s) => ({ ...s, specializeLevel: 0 }));
      if (skills.length > 0) {
        defaultSkillIndex = Math.min(
          Math.max(defaultSkillIndex, 0),
          skills.length - 1,
        );
      }
      master = {};
      equip = {};
      currentEquip = "";
    }
    const result: Rlv2RecruitCandidate = {
      ...picked,
      // instId 保持候选序号（list 下标，与客户端请求 optionId 一致——官服 recruitChar
      // 响应 chars[].instId 即 optionId/候选序号，非玩家主队伍 instId）。
      // 原实现写成 String(picked.troopInstId)（玩家主队伍 instId）：当该 instId 数值较小
      // （落在候选列表下标范围内）时，客户端按 chars[].instId 回查候选列表会命中错误干员
      // → 招募结果崩溃（战斗获取招募券招募后游戏崩溃）。候选序号恒与 optionId 一致，安全。
      troopInstId: String(troopNo),
      skills,
      master,
      equip,
      currentEquip,
      defaultSkillIndex,
    };
    // 结果（候选 + 补齐养成）→ 模型 RecruitChar（桥接断言方向见 Rlv2RecruitCandidate）
    this.tickets[id].result =
      result as PlayerRoguelikeV2.CurrentData.RecruitChar;

    await this._trigger.emit("rlv2:char:get", [this.tickets[id].result!]);
    // 特勤干员任务：招募指定干员（Rlv2RecruitSpecificChar）；招募时直接进阶（upgradePhase>=1，
    // 如 limited_direct_upgrade 直接进阶）另发进阶事件（Rlv2UpgradeSpecificChar）；
    // 岁兽残识（rogue_5）中干员入队即视为秉烛（Rlv2CandleTimes 近似）。
    const soTheme = this._player.current.game?.theme || "";
    const soCharId = this.tickets[id].result!.charId;
    await this._trigger.emit("Rlv2RecruitSpecificChar", [
      { theme: soTheme, charId: soCharId },
    ]);
    // 勋章：Rlv2Recruit（「招募或应急雇佣干员 N 次」，unlockParam = [主题, 目标次数]）。
    // 本点位为「招募券确认招募」——应急雇佣（若走其它路径）未单列，先按招募次数计。
    await this._trigger.emit("Rlv2Recruit", [{ theme: soTheme }]);
    if ((this.tickets[id].result!.upgradePhase ?? 0) >= 1) {
      await this._trigger.emit("Rlv2UpgradeSpecificChar", [
        { theme: soTheme, charId: soCharId },
      ]);
    }
    if (soTheme === "rogue_5") {
      await this._trigger.emit("Rlv2CandleTimes", [
        {
          theme: soTheme,
          mode: this._player.current.game?.mode || "NORMAL",
          grade: this._player.current.game?.modeGrade ?? 0,
        },
      ]);
    }
    await this._trigger.emit("rlv2:get:items", [
      [
        {
          id: "",
          count: -this.tickets[id].result!.population || 0,
          type: "POPULATION",
        },
      ],
    ]);
    // 自然物（GOODS）估价动态：每次招募干员 → G_04 +3
    this._player._module?.scrap?.applyGoodsEffect("recruit");
    this.tickets[id].list = [];
  }

  async gain(id: string, from: string, mustExtra: number): Promise<void> {
    this.tickets[this.index] = {
      index: this.index,
      id,
      state: 0,
      list: [],
      result: null,
      from,
      mustExtra,
      needAssist: from == "initial",
      ts: now(),
    };
    this._index++;
  }

  toJSON(): { [key: string]: PlayerRoguelikeV2.CurrentData.Recruit } {
    return this.tickets;
  }
}
