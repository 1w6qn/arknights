import { TypedEventEmitter } from "../../kernel/events/runtime";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { ItemBundle, ItemType } from "@excel/excel";
import type { ItemBundleInput } from "../../kernel/inventory-pipeline";
import excel from "@excel/excel";
import { newlyCompletedPowers } from "./team-power";
import { GachaResult } from "../../kernel/model";
import { now } from "@utils/time";
import { logger } from "@utils/logger";
import { rarityToIndex } from "@utils/rarity";
import {
  reconcileCharEquips,
  reconcileCharSkills,
} from "../../kernel/char-skills";
import { PlayerCharacter, PlayerCharPatch } from "../../kernel/model";
import type { PlayerStatus } from "../../kernel/playerdata";
import { UniEquipData } from "@excel/excel";
import { BadRequestError } from "@core/http/errors";

/**
 * character_table 技能条目读取视图（既有实现按 `levelUpCostCond` 读专精档位）
 *
 * 生成类型字段为 `specializeLevelUpData`（真表同键，`levelUpCostCond` 不存在，见台账 #6/#14）；
 * 本视图仅描述既有实现的读取口径以完成类型清除，不改变行为——修正需同步更新
 * tests/unit/manager/building-unlocks.test.ts / building.test.ts 的 mock。
 */
interface MasterSkillView {
  skillId?: string;
  levelUpCostCond?: {
    unlockCond?: { phase?: string | number | null };
    lvlUpTime?: number;
    levelUpCost?: ItemBundle[];
  }[];
}

/**
 * 管道消耗/入账目标视图 = {@link ItemBundleInput}（服务端口径）
 *
 * 消耗品券调用点只给 id/count/instId（`type` 由物品表推导），`ItemBundle` 声明必填——
 * 入管道时直接用管道的入参类型 {@link ItemBundleInput}，不再做任何断言。
 */

/** 物品类型数字枚举 → 字符串（spCharMissions 等表的 rewards.type 为数字枚举） */
function itemTypeToString(itemType: number | string): string {
  const key =
    typeof itemType === "string" ? parseInt(itemType, 10) : itemType;
  if (isNaN(key)) return String(itemType);
  const map: { [key: number]: string } = {
    0: "NONE", 1: "CHAR", 2: "CARD_EXP", 3: "MATERIAL", 4: "GOLD",
    5: "EXP_PLAYER", 6: "TKT_TRY", 7: "TKT_RECRUIT", 8: "TKT_INST_FIN",
    9: "TKT_GACHA", 10: "DIAMOND", 11: "DIAMOND_SHD", 12: "LGG_SHD",
    13: "HGG_SHD", 14: "FURN", 15: "ACTIVITY_COIN", 16: "AP_GAMEPLAY",
  };
  return map[key] ?? String(itemType);
}

export class CharManager {
  _trigger: TypedEventEmitter;
  _player: PlayerDataManager;

  constructor(player: PlayerDataManager, trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = trigger;
    // 修复：原订阅丢弃了 onCharGet.bind() 结果（抽卡/招募干员从未入账）；
    // 改为异步闭包调用（事件处理器要求 void 返回）
    this._trigger.on("char:get", async (data) => {
      await this.onCharGet(data);
    });
    this._trigger.on("char:levelUp", async ([{ charId, level }]) => {
      await this._player.update(async (draft) => {
        const char = draft.troop.chars[charId];
        const charInfo = excel.charData(char.charId)!;
        if (rarityToIndex(charInfo.rarity) <= 1 && char.level == 30) {
          //unlock addonStage
          //unlock addonStory
          //unlock buildingSkill
        }
        if (rarityToIndex(charInfo.rarity) <= 2 && char.level == 55) {
          //unlock addonStage
          //unlock addonStory
          //unlock buildingSkill
        }
      });
    });
  }

  /**
   * 消耗物品：经 gainItem 管道统一出队（inventory-pipeline），不直发 items:use。
   * @param items - 待消耗物品列表（空列表直接跳过）
   */
  private async _useItems(items: ItemBundleInput[]): Promise<void> {
    if (items.length === 0) return;
    const pipe = this._player.gainItem;
    for (const item of items) pipe.add(item);
    await pipe.use();
  }

  /**
   * 发放物品：经 gainItem 管道统一入账（inventory-pipeline），不直发 items:get。
   * @param items - 待发放物品列表（空列表直接跳过）
   */
  private async _getItems(items: ItemBundle[]): Promise<void> {
    if (items.length === 0) return;
    const pipe = this._player.gainItem;
    for (const item of items) pipe.add(item);
    await pipe.handle();
  }

  async onCharGet([charId, args = { from: "NORMAL" }, callback]: [
    string,
    ({ from: string; extraItem?: ItemBundle } | undefined)?,
    ((res: GachaResult) => void)?,
  ]): Promise<GachaResult> {
    let isNew: number = 0;
    let charInstId: number = 0;
    let potent: { delta: number; now: number } | undefined;
    /** 新干员 instId（recipe 结束后统一 emit char:init） */
    let createdCharInstId: number | undefined;
    const items: ItemBundle[] = [];
    await this._player.update(async (draft) => {
      const { from, extraItem } = args;
      // 防御：全新号 dexNav 可能为空对象（无 character 子树），先补结构再读写
      if (!draft.dexNav.character) draft.dexNav.character = {};
      isNew = draft.dexNav.character[charId] ? 0 : 1;
      const info = excel.charData(charId)!;
      logger.info(
        "CharManager",
        `获得${rarityToIndex(info.rarity) + 1}星干员 ${info.name} ${isNew ? "新" : "重复"} ${from}`,
      );
      if (isNew) {
        draft.dexNav.character[charId] = {
          charInstId: draft.troop.curCharInstId,
          count: 0,
        };
      }
      const dexInfo = draft.dexNav.character[charId];
      if (from == "CLASSIC") {
        if (dexInfo.classicCount) {
          dexInfo.classicCount += 1;
        } else {
          dexInfo.classicCount = 1;
        }
      } else {
        dexInfo.count += 1;
      }
      charInstId = dexInfo.charInstId;
      // 防御：dexNav.charInstId 悬空/错指（干员发放重建 roster 或导入损坏）时，
      // 客户端按 charInstId 查 troop.chars 失败 → 抽卡结果"获取干员信息"报错。
      // 按 charId 在 roster 找回正确 instId 并同步修正 dexNav（patch 随 delta 下发）。
      if (!isNew) {
        const liveChars = this._player._playerdata.troop.chars;
        const rosterChar = liveChars[charInstId];
        if (!rosterChar || rosterChar.charId !== charId) {
          const found = Object.entries(liveChars).find(
            ([, c]) => c.charId === charId,
          );
          if (found) {
            charInstId = Number(found[0]);
            dexInfo.charInstId = charInstId;
          }
        }
      }
      if (!isNew) {
        const potentId = excel.charData(charId)!.potentialItemId!;
        items.push(excel.makeItem(potentId, 1));
        // 修复：CS GachaResult.potent——未满潜的重复干员返回潜能提升信息（delta/now）
        const maxPotential = excel.charData(charId)!.maxPotentialLevel ?? 5;
        // 性能：从实时对象读（不经 draft 代理 troop.chars——只读子树被代理后
        // unfinalizedDrafts_ 永不归零，Immer finalize 全树遍历每次 update ~90ms）
        const repeatChar =
          this._player._playerdata.troop.chars[charInstId];
        if (repeatChar && (repeatChar.potentialRank ?? 0) < maxPotential) {
          potent = { delta: 1, now: (repeatChar.potentialRank ?? 0) + 1 };
        }
        const mul: number = dexInfo.count > 6 ? 1.5 : 1;
        if (from == "CLASSIC") {
          switch (rarityToIndex(excel.charData(charId)!.rarity)) {
            case 5:
              items.push(excel.makeItem("classic_normal_ticket", 100));
              break;
            case 4:
              items.push(excel.makeItem("classic_normal_ticket", 50));
              break;
            case 3:
              items.push(excel.makeItem("classic_normal_ticket", 5));
              break;
            case 2:
              items.push(excel.makeItem("classic_normal_ticket", 1));
              break;
            default:
              break;
          }
        } else {
          switch (rarityToIndex(excel.charData(charId)!.rarity)) {
            case 5:
              items.push(excel.makeItem("4004", Math.ceil(10 * mul)));
              break;
            case 4:
              items.push(excel.makeItem("4004", Math.ceil(5 * mul)));
              break;
            case 3:
              items.push(excel.makeItem("4005", 30));
              break;
            case 2:
              items.push(excel.makeItem("4005", 5));
              break;
            case 1:
              items.push(excel.makeItem("4005", 1));
              break;
            case 0:
              items.push(excel.makeItem("4005", 1));
              break;
            default:
              break;
          }
        }
      } else {
        draft.troop.chars[charInstId] = {
          instId: charInstId,
          charId,
          favorPoint: 0,
          potentialRank: 0,
          mainSkillLvl: 1,
          skin: `${charId}#1`,
          level: 1,
          exp: 0,
          evolvePhase: 0,
          defaultSkillIndex: -1,
          gainTime: now(),
          skills: [],
          // 修复：新干员不写 currentTmpl/tmpl —— 官方参考（test.json 379 干员仅
          // char_002_amiya 有 currentTmpl/tmpl，且指向异格形态并带完整 tmpl 映射）。
          // 原实现 currentTmpl:charId + tmpl:{} 为自引用空模板 → 破坏存档结构
          //（客户端干员详情按 currentTmpl 查 tmpl 得 undefined）。
          currentEquip: null,
          equip: {},
          voiceLan: "CN_MANDARIN",
        };
        // 修复：新干员按官服线格式填充技能（excel skills[i].unlockCond.phase；
        // 未解锁技能以 unlock:0 占位；原实现 skills 恒为空 → 客户端干员详情无技能可看）
        // + defaultSkillIndex
        reconcileCharSkills(draft.troop.chars[charInstId]);
        // 修复：新干员预填该干员模组占位条目（E0 时 hide:1 隐藏，精二后
        // reconcileCharEquips 按阶段置 hide:0）——否则 equip 恒空，精二后客户端
        // 无模组入口可显示/解锁
        reconcileCharEquips(draft.troop.chars[charInstId]);
        // 修复：新干员创建后递增 curCharInstId，避免后续新干员 instId 冲突互相覆盖
        draft.troop.curCharInstId += 1;
        createdCharInstId = charInstId;
        if (from == "CLASSIC") {
          items.push(excel.makeItem("classic_normal_ticket", 10));
        } else {
          items.push({ id: "4004", count: 1, type: "HGG_SHD" as ItemType });
        }
      }
      // 修复：extraItem（如限定池 LMTGSID 凭证）每抽发放，与是否新干员无关
      //（原实现只在 isNew 分支内发放 → 重复干员抽不到限定凭证）
      // 防御：空 id 的 extraItem 不发放（避免 gainItem 查 ItemTable[""] 警告跳过）
      if (extraItem && extraItem.id) {
        items.push(extraItem);
      }
    });
    // 优化+修复：items:get / char:init 移到 recipe 之后触发。
    // 原实现在 recipe 内 await emit("items:get") → gainItem 对同一 base 嵌套 update
    //（外层 draft 未关闭）→ Immer 无法增量 diff，每次 update 全树对比（十连每抽
    // ~250ms）；且内层 finishDraft 先替换 _playerdata、外层 finishDraft 再按旧 base
    // 覆盖 → 发放物品从存档丢失（数据一致性 bug）。移出后每次 update 只 diff 实际
    // 变更路径，入账物品也在干员落定后独立 update。
    if (createdCharInstId != null) {
      await this._trigger.emit("char:init", [
        this._player._playerdata.troop.chars[createdCharInstId],
      ]);
    }
    await this._getItems(items);
    // 修复：HasChar 任务事件从未 emit（模板已注册监听）→ 拥有干员类任务永不推进；
    // 干员入账后补发（含新/重复干员）
    const liveChar = this._player._playerdata.troop.chars[charInstId];
    if (liveChar) {
      await this._trigger.emit("HasChar", [{ char: liveChar }]);
      // 修复：勋章事件从未 emit → 干员数量/获得干员勋章永不推进
      await this._trigger.emit("CharNum", [
        { curCharInstId: this._player._playerdata.troop.curCharInstId },
      ]);
      await this._trigger.emit("GotChars", [{ char: liveChar }]);
      // 限时获得干员勋章（GotCharsBeforeTime）—— 活动期间获得指定干员（模板按
      // unlockParam charId + 结束时间过滤，越界/非目标干员不推进）
      await this._trigger.emit("GotCharsBeforeTime", [{ charId }]);
      // 修复（2026-09-09，S2）：势力全员收集任务（GainTeamChar，guide_43/guide_48）——
      // 仅在「新干员」时判定，避免重复获得干员时对已完成的势力重复计数。
      if (isNew) {
        const owned = new Set(
          Object.values(this._player._playerdata.troop.chars).map(
            (c) => c.charId,
          ),
        );
        owned.add(charId);
        for (const teamId of newlyCompletedPowers(owned, charId)) {
          logger.info("CharManager", `势力 ${teamId} 全员收集达成`);
          await this._trigger.emit("GainTeamChar", [{ teamId }]);
        }
      }
    }
    const res = {
      charInstId: charInstId,
      charId: charId,
      isNew: isNew,
      itemGet: items,
      ...(potent ? { potent } : {}),
    };
    callback?.(res);
    return res;
  }

  async upgradeChar(args: {
    charInstId: number;
    expMats: ItemBundle[];
  }): Promise<void> {
    await this._player.update(async (draft) => {
      const { charInstId, expMats } = args;
      const char = draft.troop.chars[charInstId];
      // 防御：charInstId 悬空/错指时直接抛业务错误（原实现读 char.charId 500）
      if (!char) {
        throw new BadRequestError(`干员不存在: instId=${charInstId}`);
      }
      const expMap = excel.GameDataConst.characterExpMap;
      const goldMap = excel.GameDataConst.characterUpgradeCostMap;
      const expItems = excel.ItemTable.expItems;
      let expTotal = 0,
        gold = 0;
      const charId = char.charId;
      const evolvePhase = char.evolvePhase;
      const rarity = rarityToIndex(excel.charData(charId)!.rarity);
      // 防御：稀有度/精二阶段超界（如 1 星机器人被满配生成器置为 phase 2）时钳制到有效档位
      const maxLevelArr = excel.GameDataConst.maxLevel[rarity] ?? [];
      const maxLevel =
        maxLevelArr[evolvePhase] ?? maxLevelArr[maxLevelArr.length - 1] ?? 0;
      for (let i = 0; i < expMats.length; i++) {
        // 修复：部分经验卡 gainExp 为占位字符串（2001 = "EXCHANGE_CREATED"）——
        // 字符串 × count = NaN → 污染 char.exp 与金币；非法值跳过
        const gain = expItems[expMats[i].id]?.gainExp;
        const gainNum =
          typeof gain === "number" ? gain : parseInt(String(gain ?? "0"), 10);
        if (!Number.isFinite(gainNum)) continue;
        expTotal += gainNum * expMats[i].count;
      }
      char.exp += expTotal;
      // 已满级时不再升级（原实现 expMap[maxLevel-1] 哨兵 -1 触发一次循环 →
      // 金币 -1）；但玩家喂入的经验卡仍应消耗，否则可白嫖无限喂卡。
      // 清 exp 丢弃溢出经验，仅扣经验卡本身、不产生金币。
      if (char.level >= maxLevel) {
        char.exp = 0;
        await this._useItems(expMats);
        return;
      }
      while (true) {
        if (char.exp >= expMap[evolvePhase][char.level - 1]) {
          char.exp -= expMap[evolvePhase][char.level - 1];
          // 修复：先按当前等级累加本次升级费用，再提升等级——
          // 原实现先 level += 1 再读 goldMap[level-1]，每级都多扣下一级费用
          //（且升到 maxLevel 那一步会读越界档位的费用）
          gold += goldMap[evolvePhase][char.level - 1];
          char.level += 1;
          if (char.level >= maxLevel) {
            char.level = maxLevel;
            char.exp = 0;
            break;
          }
        } else {
          break;
        }
      }
      // 累计消耗龙门币任务（CostGold / CostGoldPlus）—— 升级耗币统计（type0 param[1]=target）
      await this._trigger.emit("CostGold", [{ goldCost: gold }]);
      await this._trigger.emit("CostGoldPlus", [{ goldCostPlus: gold }]);
      expMats.push(excel.makeItem("4001", gold));
      // 技能：按官服线格式校正 unlock（等级提升不会解锁技能），保留已有技能状态
      reconcileCharSkills(char);
      await this._useItems(expMats);
      await this._trigger.emit("UpgradeChar", [{ char, exp: expTotal }]);
    });
  }

  async evolveChar(args: {
    charInstId: number;
    destEvolvePhase: number;
  }): Promise<void> {
    await this._player.update(async (draft) => {
      const { charInstId, destEvolvePhase } = args;
      const char = draft.troop.chars[charInstId];
      if (!char) throw new BadRequestError(`干员不存在 instId=${charInstId}`);
      const info = excel.charData(char.charId)!;
      const phases = info?.phases;
      // 修复：目标相位必须存在且高于当前——原实现无校验，可升到不存在的相位/免费升阶/倒降级
      if (
        !phases ||
        destEvolvePhase <= char.evolvePhase ||
        !phases[destEvolvePhase]
      ) {
        throw new BadRequestError(
          `目标相位 ${destEvolvePhase} 非法（当前精${char.evolvePhase}，最高精${phases.length - 1}）`,
        );
      }
      // 修复（2026-09-09）：精英化需当前阶段满级（prts《精英化》；gamedata_const.maxLevel
      // 按 [稀有度][当前相位]，如 6★ 精0=50、精1=80、精2=90）——原实现只校验目标相位更高，
      // 改包/构造请求即可把 1 级干员直接精二。
      const maxLevelRow = (excel.GameDataConst as { maxLevel?: number[][] })
        .maxLevel;
      const phaseCap = maxLevelRow?.[rarityToIndex(info.rarity)]?.[char.evolvePhase];
      if (typeof phaseCap === "number" && phaseCap > 0 && (char.level ?? 0) < phaseCap) {
        throw new BadRequestError(
          `干员 ${char.charId} 未满级（当前 ${char.level}/${phaseCap}），无法精英化`,
        );
      }
      const phaseConfig = phases[destEvolvePhase] as {
        evolveCost?: ItemBundle[] | null;
      } | undefined;
      // 防御：部分特殊干员（预备干员等）无精二配置（evolveCost 为 null），跳过消耗直接升阶
      const evolveCost = phaseConfig?.evolveCost ?? [];
      const rarity = rarityToIndex(info.rarity);
      // 修复：evolveGoldCost 下标约定为「精一费, 精二费」两列（无 phase0 列），
      // 须用 destEvolvePhase - 1 取列。原实现直接以 destEvolvePhase 当下标：
      // 精一取到精二价（多扣钱）、精二取 undefined → ?? -1 → 被拒，无法精二。
      // -1 表示该稀有度无此相位（如 3 星无精二），直接拒绝。
      const goldRow = excel.GameDataConst.evolveGoldCost[rarity];
      const goldCost = goldRow?.[destEvolvePhase - 1] ?? -1;
      if (goldCost < 0) {
        throw new BadRequestError(
          `干员 ${char.charId} 无精${destEvolvePhase} 相位配置`,
        );
      }
      await this._useItems(evolveCost.concat([excel.makeItem("4001", goldCost)]));
      // 累计消耗龙门币任务（CostGold / CostGoldPlus）—— 晋升耗币统计
      await this._trigger.emit("CostGold", [{ goldCost: goldCost }]);
      await this._trigger.emit("CostGoldPlus", [{ goldCostPlus: goldCost }]);
      char.evolvePhase = destEvolvePhase;
      char.level = 1;
      char.exp = 0;
      // 修复：勋章 CharEvolveCount 事件从未 emit → 精英化勋章永不推进
      await this._trigger.emit("CharEvolveCount", [{ char }]);
      // 修复（2026-09-09，审计 §5.3）：CharEvolvePhase（特勤干员精二章，2 枚）此前既无
      // emit 方、模板目标位又取错下标（param[0] 是 charId）→ 恒不可得。现派发干员 id + 阶段。
      await this._trigger.emit("CharEvolvePhase", [
        { charId: char.charId, phase: destEvolvePhase },
      ]);
      // 技能：精英化后按官服线格式校正 unlock（如 E1 解锁技能2、E2 解锁技能3），保留已有技能状态
      reconcileCharSkills(char);
      // 修复：精二后校正当前目标相位范围内干员的模组状态——按 showEvolvePhase
      // 把该干员模组条目的 hide 置 0（从隐藏到显示），并补齐缺失条目、精二即用的
      // 首个模组置 locked 0 + 设置 currentEquip。此前从未处理 → 精二后客户端无模组入口
      reconcileCharEquips(char);
      if (destEvolvePhase >= 2) {
        char.skin = char.charId + "#2";
      }
      await this._trigger.emit("EvolveChar", [{ char }]);
    });
  }

  async boostPotential(args: {
    charInstId: number;
    itemId: string;
    targetRank: number;
  }): Promise<void> {
    await this._player.update(async (draft) => {
      const { charInstId, itemId, targetRank } = args;
      const char = draft.troop.chars[charInstId];
      if (!char) return;
      const info = excel.charData(char.charId)!;
      // 修复：targetRank 无钳制可写超上限（如 maxPotential 5 写 99）+ 无道具归属校验；
      // 钳制到 [当前+1, maxPotential]，且只接受该干员潜能道具
      const maxPotential = info?.maxPotentialLevel ?? 5;
      const target = Math.min(Math.max(targetRank, (char.potentialRank ?? 0) + 1), maxPotential);
      const allowedItems = [
        info?.potentialItemId,
        info?.classicPotentialItemId,
        info?.activityPotentialItemId,
        // 满潜能凭证（VOUCHER_FULL_POTENTIAL）为通用道具，任意干员可用
        "VOUCHER_FULL_POTENTIAL",
      ].filter(Boolean) as string[];
      if (allowedItems.length > 0 && !allowedItems.includes(itemId)) {
        return; // 非法道具：拒绝（防消耗任意库存物品）
      }
      char.potentialRank = target;
      await this._useItems([excel.makeItem(itemId, 1)]);
      await this._trigger.emit("BoostPotential", [{ targetLevel: target }]);
      // 修复：勋章 CharPotential 事件从未 emit → 潜能提升勋章永不推进
      await this._trigger.emit("CharPotential", [{ targetLevel: target }]);
    });
  }

  async setDefaultSkill(args: {
    charInstId: number;
    defaultSkillIndex: number;
  }): Promise<void> {
    await this._player.update(async (draft) => {
      const { charInstId, defaultSkillIndex } = args;
      const char = draft.troop.chars[charInstId];
      // 防御：干员不存在/技能索引越界/指向未解锁技能时拒绝（客户端按索引查技能崩溃）
      if (!char) {
        throw new BadRequestError(`干员不存在: instId=${charInstId}`);
      }
      const skills = char.skills ?? [];
      const valid =
        defaultSkillIndex === -1 ||
        (defaultSkillIndex >= 0 &&
          defaultSkillIndex < skills.length &&
          skills[defaultSkillIndex]?.unlock === 1);
      if (!valid) {
        throw new BadRequestError(
          `默认技能索引 ${defaultSkillIndex} 非法或技能未解锁（干员 ${char.charId}）`,
        );
      }
      char.defaultSkillIndex = defaultSkillIndex;
    });
  }

  async upgradeSkill(args: {
    charInstId: number;
    targetLevel: number;
  }): Promise<void> {
    await this._player.update(async (draft) => {
      const { charInstId, targetLevel } = args;
      const char = draft.troop.chars[charInstId];
      // 防御：干员不存在时抛业务错误（原实现读 char.charId 500）
      if (!char) {
        throw new BadRequestError(`干员不存在: instId=${charInstId}`);
      }
      // 防御：targetLevel < 2 时 allSkillLvlup[-] 越界（客户端正常只发 >=2）
      if (targetLevel < 2) {
        throw new BadRequestError(`技能目标等级 ${targetLevel} 非法（最低 2）`);
      }
      const info = excel.charData(char.charId)!;
      const allSkillLvlup = info?.allSkillLvlup;
      // 防御：无技能干员（2 星等）或 targetLevel 超上限（官方最高 7）时拒绝
      //（原实现 allSkillLvlup[targetLevel-2] 取 undefined 再读 .lvlUpCost 500）
      if (!allSkillLvlup || targetLevel - 2 >= allSkillLvlup.length) {
        throw new BadRequestError(
          `技能目标等级 ${targetLevel} 超过上限 ${allSkillLvlup ? allSkillLvlup.length + 1 : 1}（干员 ${char.charId}）`,
        );
      }
      const lvlUpCond = allSkillLvlup[targetLevel - 2];
      // 修复：技能升级受精英化门槛约束（4/5/6 级需精一、7 级需精二）——
      // 原实现不校验 unlockCond.phase，E0 干员可越级升满
      const phaseNeed = this._phaseRank(lvlUpCond?.unlockCond?.phase);
      if (char.evolvePhase < phaseNeed) {
        throw new BadRequestError(
          `技能升至 ${targetLevel} 需精英化${phaseNeed}（当前精${char.evolvePhase}）`,
        );
      }
      // 修复：按从当前等级到目标等级逐档累计扣费，防止一次性越级直达
      //（如 1→7）时只扣最高一档费用、少扣中间 2~6 档材料。
      // 目标不高于当前等级时拒绝（无升级空间，防刷请求）。
      const currentLevel = char.mainSkillLvl ?? 1;
      if (targetLevel <= currentLevel) {
        throw new BadRequestError(
          `技能目标等级 ${targetLevel} 不高于当前等级 ${currentLevel}（干员 ${char.charId}）`,
        );
      }
      const costItems: ItemBundle[] = [];
      for (let i = currentLevel - 1; i < targetLevel - 1; i++) {
        costItems.push(...(allSkillLvlup[i]?.lvlUpCost ?? []));
      }
      char.mainSkillLvl = targetLevel;
      await this._useItems(costItems);
      // 修复：原实现发错事件 BoostPotential → 技能升级任务（监听 UpgradeSkill）永不推进；
      // 改为 UpgradeSkill
      await this._trigger.emit("UpgradeSkill", [{ targetLevel }]);
      // 修复：勋章 CharSkillCount 事件从未 emit → 技能升级勋章永不推进
      await this._trigger.emit("CharSkillCount", [{ targetLevel }]);
    });
  }

  async changeCharSkin(args: {
    charInstId: number;
    skinId: string;
  }): Promise<void> {
    await this._player.update(async (draft) => {
      const { charInstId, skinId } = args;
      const char = draft.troop.chars[charInstId];
      char.skin = skinId;
    });
  }

  async changeCharTemplate(args: {
    charInstId: number;
    templateId: string;
  }): Promise<void> {
    await this._player.update(async (draft) => {
      const { charInstId, templateId } = args;
      const char = draft.troop.chars[charInstId];
      if (!templateId || templateId === char.charId) {
        // 切回基础形态：清除 currentTmpl（避免自引用空模板破坏干员详情——
        // 原实现 currentTmpl:charId + tmpl:{} 使客户端按 currentTmpl 查 tmpl 得 undefined）
        char.currentTmpl = undefined;
        return;
      }
      this._ensureTmplPatch(char, templateId);
      char.currentTmpl = templateId;
    });
  }

  async batchSetCharVoiceLan(args: { voiceLan: string }): Promise<void> {
    await this._player.update(async (draft) => {
      const { voiceLan } = args;
      Object.values(draft.troop.chars).forEach(
        (char) => (char.voiceLan = voiceLan),
      );
      // 对齐官服抓包 R-1689144511000-4558：批量设置是全局语音设置——
      // 同步 status.globalVoiceLan 与 npcAudio.*.npcShowAudioInfoFlag
      if (draft.status) {
        draft.status.globalVoiceLan = voiceLan as PlayerStatus["globalVoiceLan"];
      }
      Object.values(draft.npcAudio ?? {}).forEach((npc) => {
        npc.npcShowAudioInfoFlag = voiceLan;
      });
    });
  }

  async setCharVoiceLan(args: { charList: number[]; voiceLan: string }) {
    await this._player.update(async (draft) => {
      const { charList, voiceLan } = args;
      charList.forEach((charInstId) => {
        const char = draft.troop.chars[charInstId];
        char.voiceLan = voiceLan;
      });
    });
  }

  // ===== 模组（uniequip）内部工具 =====

  /** 取模组配置（equipDict 含 null 占位条目——防御） */
  private _getEquipData(equipId: string): UniEquipData {
    const data = excel.UniequipTable.equipDict[equipId];
    if (!data) {
      throw new BadRequestError(`模组不存在: ${equipId}`);
    }
    return data;
  }

  /** EvolvePhase 枚举字符串 → 数值档位（"PHASE_2" → 2；缺省/未知 → 0） */
  private _phaseRank(phase: unknown): number {
    const m = typeof phase === "string" ? /^PHASE_(\d)$/.exec(phase) : null;
    return m ? Number(m[1]) : 0;
  }

  /** 校验模组归属（equipId 属于该干员或其模板变体） */
  private _assertEquipOwned(
    char: PlayerCharacter,
    equip: UniEquipData,
    templateId: string,
  ): void {
    const owner = templateId || char.charId;
    if (equip.charId !== owner && equip.charId !== char.charId) {
      throw new BadRequestError(`模组 ${equip.uniEquipId} 不属于干员 ${owner}`);
    }
  }

  /** 解锁/升级条件校验：精二阶段/等级/信赖（unlockFavors 值 null 表示不要求） */
  private _assertEquipCondition(
    char: PlayerCharacter,
    equip: UniEquipData,
    level: number,
  ): void {
    const phaseNeed = this._phaseRank(equip.unlockEvolvePhase);
    if (char.evolvePhase < phaseNeed) {
      throw new BadRequestError(
        `模组 ${equip.uniEquipId} 需精英化${phaseNeed}才能解锁（当前精${char.evolvePhase}）`,
      );
    }
    if (char.level < (equip.unlockLevel ?? 0)) {
      throw new BadRequestError(
        `模组 ${equip.uniEquipId} 需等级 ${equip.unlockLevel} 才能解锁（当前 ${char.level}）`,
      );
    }
    const favorNeed = equip.unlockFavors?.[String(level)];
    if (typeof favorNeed === "number" && (char.favorPoint ?? 0) < favorNeed) {
      throw new BadRequestError(
        `模组 ${equip.uniEquipId} 需信赖 ${favorNeed}（当前 ${char.favorPoint}）`,
      );
    }
  }

  /** 模组最高等级（itemCost 键的最大档位，缺省 1） */
  private _maxEquipLevel(equip: UniEquipData): number {
    const keys = Object.keys(equip.itemCost ?? {});
    return keys.length ? Math.max(...keys.map((k) => Number(k))) : 1;
  }

  /** 确保干员模板补丁存在（缺失时按基础形态初始化——皮肤/技能/模组状态拷贝） */
  private _ensureTmplPatch(
    char: PlayerCharacter,
    templateId: string,
  ): PlayerCharPatch {
    if (!char.tmpl) char.tmpl = {};
    if (!char.tmpl[templateId]) {
      char.tmpl[templateId] = {
        skinId: char.skin,
        defaultSkillIndex: char.defaultSkillIndex,
        skills: char.skills?.map((s) => ({ ...s })) ?? [],
        currentEquip: char.currentEquip,
        equip: { ...(char.equip ?? {}) },
      };
    }
    return char.tmpl[templateId];
  }

  /** 解析模组操作目标（base 或 tmpl 变体），并确保 equip 字典存在 */
  private _resolveEquipTarget(
    char: PlayerCharacter,
    templateId: string,
  ): PlayerCharacter | PlayerCharPatch {
    if (templateId) return this._ensureTmplPatch(char, templateId);
    if (!char.equip) char.equip = {};
    return char;
  }

  /**
   * 技能专精配置（skills[i].levelUpCostCond[targetLevel-1]）
   *
   * levelUpCostCond 下标 0/1/2 对应专精 1/2/3（M1/M2/M3），每档含
   * unlockCond.phase（解锁所需精英化阶段）、lvlUpTime（训练秒数）、
   * levelUpCost（材料）。配置缺失返回 null（防御，由调用方抛业务错误）。
   */
  private _masterCond(
    charId: string,
    skillIndex: number,
    targetLevel: number,
  ): {
    unlockCond?: { phase?: unknown };
    lvlUpTime?: number;
    levelUpCost?: ItemBundle[];
  } | null {
    const skill: MasterSkillView | undefined =
      excel.CharacterTable?.[charId]?.skills?.[skillIndex];
    const cond = skill?.levelUpCostCond?.[targetLevel - 1];
    return cond ?? null;
  }

  /** 直升券稀有度匹配：itemType 尾号（4/5/6）= 星级 → 稀有度索引（3/4/5） */
  private _voucherRarityMatches(itemType: string, rarityIndex: number): boolean {
    const m = /_(\d)$/.exec(itemType);
    return m ? Number(m[1]) - 1 === rarityIndex : false;
  }

  /**
   * 校验直升券道具（家族 + 稀有度匹配），不匹配抛业务错误
   * @param itemId - 道具 ID（如 voucher_elite_II_6）
   * @param familyPrefix - 期望的 itemType 前缀（如 "VOUCHER_ELITE_II_"）
   * @param charRarityIndex - 干员稀有度索引（rarityToIndex 结果）
   */
  private _assertVoucher(
    itemId: string,
    familyPrefix: string,
    charRarityIndex: number,
  ): void {
    const itemType = excel.ItemTable?.items?.[itemId]?.itemType;
    if (!itemType || !itemType.startsWith(familyPrefix)) {
      throw new BadRequestError(`道具 ${itemId} 不是 ${familyPrefix}* 直升券，无法使用`);
    }
    if (!this._voucherRarityMatches(itemType, charRarityIndex)) {
      throw new BadRequestError(
        `直升券 ${itemId} 稀有度与干员不匹配（干员为 ${charRarityIndex + 1}★）`,
      );
    }
  }

  async setEquipment(args: {
    charInstId: number;
    templateId: string;
    equipId: string;
  }): Promise<void> {
    await this._player.update(async (draft) => {
      const { charInstId, templateId, equipId } = args;
      const char = draft.troop.chars[charInstId];
      const equipData = this._getEquipData(equipId);
      this._assertEquipOwned(char, equipData, templateId);
      const target = this._resolveEquipTarget(char, templateId);
      const entry = (target.equip[equipId] ??= { hide: 1, locked: 1, level: 1 });
      if (entry.locked) {
        throw new BadRequestError(`模组 ${equipId} 尚未解锁，无法装备`);
      }
      target.currentEquip = equipId;
    });
  }

  async unlockEquipment(args: {
    charInstId: number;
    templateId: string;
    equipId: string;
  }) {
    await this._player.update(async (draft) => {
      const { charInstId, templateId, equipId } = args;
      const char = draft.troop.chars[charInstId];
      const equipData = this._getEquipData(equipId);
      this._assertEquipOwned(char, equipData, templateId);
      // 解锁条件：精二/等级/信赖（unlockFavors["1"] 数值时校验）
      this._assertEquipCondition(char, equipData, 1);
      const target = this._resolveEquipTarget(char, templateId);
      const entry = (target.equip[equipId] ??= { hide: 1, locked: 1, level: 1 });
      if (!entry.locked) {
        throw new BadRequestError(`模组 ${equipId} 已解锁`);
      }
      entry.hide = 0;
      entry.locked = 0;
      // 特殊模组解锁任务：按其真实进度校验（进度由 battle 胜利结算时按「指定干员
      // 非助战 + 指定关卡/星级」推进，见 EquipmentMissionManager.onBattleWin）——
      // 任务未完成时拒绝解锁；老存档中的完成态条目保留（向后兼容）
      if (equipData.missionList?.length) {
        this._player.equipmentMission.assertUnlockable(
          char.charId,
          equipData.missionList,
          draft,
        );
      }
      await this._useItems(equipData.itemCost?.[1] ?? []);
      await this._trigger.emit("HasEquipment", [{ char }]);
    });
  }

  async upgradeEquipment(args: {
    charInstId: number;
    templateId: string;
    equipId: string;
    targetLevel: number;
  }) {
    await this._player.update(async (draft) => {
      const { charInstId, templateId, equipId, targetLevel } = args;
      const char = draft.troop.chars[charInstId];
      const equipData = this._getEquipData(equipId);
      this._assertEquipOwned(char, equipData, templateId);
      const target = this._resolveEquipTarget(char, templateId);
      const entry = (target.equip[equipId] ??= { hide: 1, locked: 1, level: 1 });
      if (entry.locked) {
        throw new BadRequestError(`模组 ${equipId} 尚未解锁，无法升级`);
      }
      // 修复：先快照旧等级再算扣费（原实现先置 level 再按已更新等级循环——
      // 只扣了目标档一级，且 tmpl 变体误读 base 等级）
      const oldLevel = entry.level;
      if (targetLevel <= oldLevel) {
        throw new BadRequestError(`目标等级 ${targetLevel} 不高于当前等级 ${oldLevel}`);
      }
      const maxLevel = this._maxEquipLevel(equipData);
      if (targetLevel > maxLevel) {
        throw new BadRequestError(`模组 ${equipId} 最高等级为 ${maxLevel}`);
      }
      // 信赖门槛：unlockFavors[targetLevel] 数值时校验（如 2732/10070 信赖点）
      this._assertEquipCondition(char, equipData, targetLevel);
      const items: ItemBundle[] = [];
      for (let i = oldLevel + 1; i <= targetLevel; i++) {
        items.push(...(equipData.itemCost?.[i] ?? []));
      }
      entry.level = targetLevel;
      await this._useItems(items);
      await this._trigger.emit("HasEquipment", [{ char }]);
    });
  }

  async changeMarkStar(args: { chrIdDict: { [key: string]: number } }) {
    await this._player.update(async (draft) => {
      const { chrIdDict } = args;
      // 修复：troop.chars 按 instId 键，客户端 chrIdDict 按 charId——
      // 原实现 chars[charId] 恒 undefined → 500；改为按 charId 扫描匹配
      for (const [charId, mark] of Object.entries(chrIdDict ?? {})) {
        const char = Object.values(draft.troop.chars).find(
          (c) => c.charId === charId,
        );
        if (char) char.starMark = mark;
      }
    });
  }

  /**
   * 锁定干员（当前版本无锁定字段，安全空操作）
   *
   * 说明：2.7.61 客户端干员数据模型（PlayerCharacter）不含 locked 字段，
   * 锁定功能已随旧版本下架。此处仅校验干员存在性（防悬空 instId 静默通过），
   * 不做任何写入——避免引入客户端不认识的字段破坏存档结构。
   */
  async lockChar(args: { charInstIdList: number[] }) {
    await this._player.update(async (draft) => {
      const { charInstIdList } = args;
      for (const charInstId of charInstIdList) {
        if (!draft.troop.chars[charInstId]) {
          logger.warn("CharManager", `lockChar 干员不存在: instId=${charInstId}`);
        }
      }
    });
  }

  /**
   * 出售干员（官方已下架，安全空操作）
   *
   * 说明：官方自 2020 年下架干员出售功能；重复干员在获取时（onCharGet）已按
   * 稀有度自动转化为资质凭证/高级凭证入账。直接删除 roster 会破坏编队/助战/
   * 图鉴引用（dexNav.charInstId、squad、assist），故维持空操作——与官方现版本
   * 行为一致。仅校验干员存在性。
   */
  async sellChar(args: { charInstIdList: number[] }) {
    await this._player.update(async (draft) => {
      const { charInstIdList } = args;
      for (const charInstId of charInstIdList) {
        if (!draft.troop.chars[charInstId]) {
          logger.warn("CharManager", `sellChar 干员不存在: instId=${charInstId}`);
        }
      }
    });
  }

  /**
   * 开始技能专精（M1/M2/M3，两阶段流程第一阶段）
   *
   * 官方流程：发起专精 → 扣材料（skills[i].levelUpCostCond[targetLevel-1].levelUpCost）、
   * 写训练完成时间（now + lvlUpTime，客户端据此显示倒计时）、技能置训练中（state=1）；
   * specializeLevel 在 completeUpgradeSpecialization 结算时提升（本方法不改等级）。
   *
   * 校验：干员存在、技能已解锁、主技能等级 ≥ 7、目标 ∈ [1,3] 且 = 当前 + 1（逐级提升）、
   * 精英化阶段满足 levelUpCostCond 的 unlockCond.phase（通常要求精二）、
   * 无进行中的专精训练（防重复扣材料）。
   */
  async upgradeSpecialization(args: {
    charInstId: number;
    skillIndex: number;
    targetLevel: number;
  }) {
    await this._player.update(async (draft) => {
      const { charInstId, skillIndex, targetLevel } = args;
      const char = draft.troop.chars[charInstId];
      if (!char) throw new BadRequestError(`干员不存在: instId=${charInstId}`);
      const skill = char.skills?.[skillIndex];
      if (!skill) {
        throw new BadRequestError(`技能索引 ${skillIndex} 越界（干员 ${char.charId}）`);
      }
      if (skill.unlock !== 1) {
        throw new BadRequestError(`技能 ${skill.skillId} 未解锁，无法专精`);
      }
      if ((char.mainSkillLvl ?? 1) < 7) {
        throw new BadRequestError(`主技能等级 ${char.mainSkillLvl} 未达 7，无法专精`);
      }
      const current = skill.specializeLevel ?? 0;
      if (targetLevel < 1 || targetLevel > 3) {
        throw new BadRequestError(`专精目标等级 ${targetLevel} 非法（1-3）`);
      }
      if (targetLevel !== current + 1) {
        throw new BadRequestError(`专精需逐级提升（当前 ${current}，目标必须为 ${current + 1}）`);
      }
      if (skill.state === 1 && (skill.completeUpgradeTime ?? 0) > 0) {
        throw new BadRequestError(`技能 ${skill.skillId} 正在专精训练中`);
      }
      const cond = this._masterCond(char.charId, skillIndex, targetLevel);
      if (!cond) {
        throw new BadRequestError(`缺少技能 ${skill.skillId} 专精 ${targetLevel} 配置`);
      }
      const phaseNeed = this._phaseRank(cond.unlockCond?.phase);
      if (char.evolvePhase < phaseNeed) {
        throw new BadRequestError(
          `专精需要精英化${phaseNeed}（当前精${char.evolvePhase}）`,
        );
      }
      await this._useItems(cond.levelUpCost ?? []);
      skill.state = 1;
      skill.completeUpgradeTime = now() + (cond.lvlUpTime ?? 0);
    });
  }

  /**
   * 完成技能专精（两阶段流程第二阶段）
   *
   * 结算条件：训练已发起（completeUpgradeTime > 0）、目标 = 当前 + 1；
   * 结算后 specializeLevel = targetLevel、state = 0、completeUpgradeTime = -1。
   * 私服不强制等待 lvlUpTime 到点（与基建训练室路径一致，可立即领取），
   * 但必须先经 upgradeSpecialization 扣费后才能结算（防白嫖专精）。
   */
  async completeUpgradeSpecialization(args: {
    charInstId: number;
    skillIndex: number;
    targetLevel: number;
  }) {
    await this._player.update(async (draft) => {
      const { charInstId, skillIndex, targetLevel } = args;
      const char = draft.troop.chars[charInstId];
      if (!char) throw new BadRequestError(`干员不存在: instId=${charInstId}`);
      const skill = char.skills?.[skillIndex];
      if (!skill) {
        throw new BadRequestError(`技能索引 ${skillIndex} 越界（干员 ${char.charId}）`);
      }
      if ((skill.completeUpgradeTime ?? -1) <= 0) {
        throw new BadRequestError(`技能 ${skill.skillId} 未在专精训练中，无法结算`);
      }
      const current = skill.specializeLevel ?? 0;
      if (targetLevel < 1 || targetLevel > 3 || targetLevel !== current + 1) {
        throw new BadRequestError(`专精结算等级 ${targetLevel} 非法（应为 ${current + 1}）`);
      }
      skill.specializeLevel = targetLevel;
      skill.state = 0;
      skill.completeUpgradeTime = -1;
      await this._trigger.emit("UpgradeSpecialization", [{ targetLevel }]);
      // 修复（2026-09-09，审计 §5.3）：CharSkillSpecCount（技能精熟奖章 I–IX，9 枚）模板已
      // 实现（按 targetLevel >= param[1] 计数），但全仓无同名事件派发 → 全部不可得。
      await this._trigger.emit("CharSkillSpecCount", [{ targetLevel }]);
    });
  }

  async getSpCharMissionReward(args: {
    charId: string;
    missionId: string;
  }): Promise<ItemBundle[]> {
    return await this._player.update(async (draft) => {
      const { charId, missionId } = args;
      const mission = excel.CharMetaTable?.spCharMissions?.[charId]?.[missionId];
      if (!mission) {
        throw new BadRequestError(`异格干员任务不存在: ${charId}/${missionId}`);
      }
      // 加固：charMission 缺省初始化（新干员/导入存档可能无此键）
      if (!draft.troop.charMission) draft.troop.charMission = {};
      draft.troop.charMission[charId] = draft.troop.charMission[charId] || {};
      if (draft.troop.charMission[charId][missionId] === 2) {
        throw new BadRequestError(`任务奖励已领取: ${missionId}`);
      }
      // 资格校验：condType 数值 1 = EVOLVE_PHASE（JSON 数值与 TS 字符串枚举
      // 不一致——按数值/字符串双判断；param = [精二阶段, 等级]）
      const condType = mission.condType as unknown;
      if (condType === 1 || condType === "EVOLVE_PHASE") {
        const [phaseReq, levelReq] = (mission.param ?? []).map((p) => Number(p));
        const char = Object.values(draft.troop.chars).find(
          (c) => c.charId === charId,
        );
        if (!char) {
          throw new BadRequestError(`干员不存在: ${charId}`);
        }
        if (char.evolvePhase < phaseReq || char.level < levelReq) {
          throw new BadRequestError(
            `未满足异格干员任务条件（需精${phaseReq} 级${levelReq}）: ${missionId}`,
          );
        }
      }
      draft.troop.charMission[charId][missionId] = 2;
      // 修复：spCharMissions.rewards 的 type 是数字枚举（2=CARD_EXP、4=GOLD）——
      // gainItem 的 funcs 按字符串类型键（"CARD_EXP"/"GOLD"），数字 type 恒查不到
      // → 奖励被跳过但任务已标记领取（奖励永久丢失）；统一转字符串类型
      const rewards: ItemBundle[] = (mission.rewards ?? []).map((r) => ({
        id: r.id,
        count: r.count,
        type: itemTypeToString(r.type) as ItemType,
      }));
      await this._getItems(rewards);
      return rewards;
    });
  }

  /**
   * 使用精二直升券（VOUCHER_ELITE_II_4/5/6）
   *
   * 校验道具家族与稀有度匹配（如 voucher_elite_II_6 仅限 6★），直接精二：
   * evolvePhase=2、等级/经验重置、皮肤 #2、技能按精二解锁校正；扣消耗道具
   * （items:use 按 instId 扣 consumable 条目）并推进精英化勋章/任务。
   */
  async evolveCharUseItem(args: {
    charInstId: number;
    itemId: string;
    instId: number;
  }) {
    await this._player.update(async (draft) => {
      const { charInstId, itemId, instId } = args;
      const char = draft.troop.chars[charInstId];
      if (!char) throw new BadRequestError(`干员不存在: instId=${charInstId}`);
      const rarity = rarityToIndex(excel.charData(char.charId)!.rarity);
      this._assertVoucher(itemId, "VOUCHER_ELITE_II_", rarity);
      if (char.evolvePhase >= 2) {
        throw new BadRequestError(`干员 ${char.charId} 已精二，无需使用直升券`);
      }
      char.evolvePhase = 2;
      char.level = 1;
      char.exp = 0;
      char.skin = char.charId + "#2";
      // 精二解锁技能3（保留已有技能专精状态）
      reconcileCharSkills(char);
      // 精二后校正模组状态（同 evolveChar：hide 置 0、补齐条目、首个模组 locked 0 + currentEquip）
      reconcileCharEquips(char);
      await this._useItems([{ id: itemId, count: 1, instId }]);
      await this._trigger.emit("CharEvolveCount", [{ char }]);
      // 修复（2026-09-09，审计 §5.3）：精二直升券同样应推进 CharEvolvePhase（特勤干员精二章）
      await this._trigger.emit("CharEvolvePhase", [
        { charId: char.charId, phase: 2 },
      ]);
      await this._trigger.emit("EvolveChar", [{ char }]);
    });
  }

  /**
   * 使用满级直升券（VOUCHER_LEVELMAX_4/5/6）
   *
   * 校验道具家族与稀有度匹配，将干员升至当前精英化阶段的上限等级
   * （maxLevel[rarity][evolvePhase]），经验清零；扣消耗道具并推进升级任务。
   */
  async upgradeCharLevelMaxUseItem(args: {
    charInstId: number;
    itemId: string;
    instId: number;
  }) {
    await this._player.update(async (draft) => {
      const { charInstId, itemId, instId } = args;
      const char = draft.troop.chars[charInstId];
      if (!char) throw new BadRequestError(`干员不存在: instId=${charInstId}`);
      const rarity = rarityToIndex(excel.charData(char.charId)!.rarity);
      this._assertVoucher(itemId, "VOUCHER_LEVELMAX_", rarity);
      // 修复：原实现恒写 maxLevel[rarity][2]（精二满级）——maxLevel 数据为空桩时
      // 写 undefined（等级字段从存档消失）；且无视当前相位（E0 干员被写成 E2 满级）。
      // 按当前相位取对应上限：maxLevel[rarity][evolvePhase]
      const phaseMax =
        excel.GameDataConst.maxLevel[rarity]?.[char.evolvePhase] ??
        excel.GameDataConst.maxLevel[rarity]?.[0] ??
        1;
      char.level = phaseMax;
      char.exp = 0;
      await this._useItems([{ id: itemId, count: 1, instId }]);
      await this._trigger.emit("UpgradeChar", [{ char, exp: 0 }]);
    });
  }

  /**
   * 使用专精直升券（VOUCHER_SKILL_SPECIALLEVELMAX_4/5/6）
   *
   * 校验道具家族与稀有度匹配、技能已解锁，直接将技能专精至 3
   * （completeUpgradeTime=-1、state=0 复位）；扣消耗道具并推进专精任务。
   */
  async upgradeSpecializedSkillUseItem(args: {
    charInstId: number;
    skillIndex: number;
    itemId: string;
    instId: number;
  }) {
    await this._player.update(async (draft) => {
      const { charInstId, skillIndex, itemId, instId } = args;
      const char = draft.troop.chars[charInstId];
      if (!char) throw new BadRequestError(`干员不存在: instId=${charInstId}`);
      const rarity = rarityToIndex(excel.charData(char.charId)!.rarity);
      this._assertVoucher(itemId, "VOUCHER_SKILL_SPECIALLEVELMAX_", rarity);
      const skill = char.skills?.[skillIndex];
      if (!skill) {
        throw new BadRequestError(`技能索引 ${skillIndex} 越界（干员 ${char.charId}）`);
      }
      if (skill.unlock !== 1) {
        throw new BadRequestError(`技能 ${skill.skillId} 未解锁，无法直升专精`);
      }
      skill.specializeLevel = 3;
      skill.state = 0;
      skill.completeUpgradeTime = -1;
      await this._useItems([{ id: itemId, count: 1, instId }]);
      await this._trigger.emit("UpgradeSpecialization", [{ targetLevel: 3 }]);
      // 修复（2026-09-09，审计 §5.3）：专精直升券（VOUCHER_SKILL_SPECIALLEVELMAX_*）同样计数
      await this._trigger.emit("CharSkillSpecCount", [{ targetLevel: 3 }]);
    });
  }
}
