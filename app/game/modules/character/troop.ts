import { PlayerSquad, PlayerSquadItem, PlayerCharEquipInfo, PlayerCharacter } from "../../kernel/model";
import excel from "@excel/excel";
import { ItemBundle } from "@excel/excel";
import { now } from "@utils/time";
import { rarityToIndex } from "@utils/rarity";
import {
  reconcileCharEquips,
  reconcileCharSkills,
} from "../../kernel/char-skills";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { BadRequestError } from "@core/http/errors";
import { isJsonObject } from "@excel/json-value";

export class TroopManager {
  _trigger: TypedEventEmitter;
  _player: PlayerDataManager;

  constructor(player: PlayerDataManager, trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = trigger;
    this._trigger.on("game:fix", this.fix.bind(this));
  }
  async squadFormation(args: {
    squadId: number;
    slots: PlayerSquadItem[];
  }): Promise<void> {
    const { squadId, slots } = args;
    await this._player.update(async (draft) => {
      draft.troop.squads[squadId].slots = slots;
      await this._trigger.emit("SquadFormation", []);
    });
  }

  async changeSquadName(args: {
    squadId: number;
    name: string;
  }): Promise<void> {
    const { squadId, name } = args;
    await this._player.update(async (draft) => {
      draft.troop.squads[squadId].name = name;
    });
    // 修复：ChangeSquadName 任务事件从未 emit → 改名类任务永不推进
    await this._trigger.emit("ChangeSquadName", []);
  }

  async decomposePotentialItem(args: {
    charInstIdList: string[];
  }): Promise<ItemBundle[]> {
    const { charInstIdList } = args;
    const draft = this._player._playerdata;
    // 修复：同一潜能道具只按库存扣/转一次——原实现每个列出的干员都扣全库存
    //（同稀有度/重复干员 → 库存扣成负数 + 重复发放转换物刷奖励）
    const seen = new Set<string>();
    const costs: ItemBundle[] = [];
    const items: ItemBundle[] = [];
    for (const charInstId of charInstIdList) {
      const char = draft.troop.chars[charInstId];
      if (!char) continue; // 防御：不存在的干员跳过
      // 修复：CharacterTable.rarity 为字符串枚举 "TIER_N"，items 表按数值键（0~5）——转索引
      const rarity = rarityToIndex(excel.charData(char.charId)?.rarity);
      const potentialItemId = excel.charData(char.charId)!.potentialItemId!;
      if (seen.has(potentialItemId)) continue;
      seen.add(potentialItemId);
      const count = draft.inventory[potentialItemId] || 0;
      if (count <= 0) continue;
      const item = excel.GachaTable.potentialMaterialConverter.items[rarity];
      if (!item) continue; // 防御：无对应分解配置跳过
      costs.push(excel.makeItem(potentialItemId, count));
      items.push(excel.makeItem(item.id, item.count * count));
    }
    if (costs.length > 0) {
      for (const item of costs) this._player.gainItem.add(item);
      await this._player.gainItem.use();
    }
    if (items.length > 0) {
      for (const item of items) this._player.gainItem.add(item);
      await this._player.gainItem.handle();
    }
    return items;
  }

  async decomposeClassicPotentialItem(args: {
    charInstIdList: string[];
  }): Promise<ItemBundle[]> {
    const { charInstIdList } = args;
    const draft = this._player._playerdata;
    // 修复：同一潜能道具只按库存扣/转一次（同 decomposePotentialItem）
    const seen = new Set<string>();
    const costs: ItemBundle[] = [];
    const items: ItemBundle[] = [];
    for (const charInstId of charInstIdList) {
      const char = draft.troop.chars[charInstId];
      if (!char) continue; // 防御：不存在的干员跳过
      // 修复：rarity 字符串枚举转数值索引
      const rarity = rarityToIndex(excel.charData(char.charId)?.rarity);
      const potentialItemId = excel.charData(char.charId)!.classicPotentialItemId!;
      if (seen.has(potentialItemId)) continue;
      seen.add(potentialItemId);
      const count = draft.inventory[potentialItemId] || 0;
      if (count <= 0) continue;
      const item = excel.GachaTable.classicPotentialMaterialConverter.items[rarity];
      if (!item) continue; // 防御：无对应分解配置跳过
      costs.push(excel.makeItem(potentialItemId, count));
      items.push(excel.makeItem(item.id, item.count * count));
    }
    if (costs.length > 0) {
      for (const item of costs) this._player.gainItem.add(item);
      await this._player.gainItem.use();
    }
    if (items.length > 0) {
      for (const item of items) this._player.gainItem.add(item);
      await this._player.gainItem.handle();
    }
    return items;
  }

  /**
   * 解锁干员密录剧情（附加故事）
   * 对照官服抓包（tmp/charBuild_addonStory_unlock_res_1107.json）：
   * 写入 addon.story + 同步发放对应勋章（medal_story_x，CharStoryUnlock 模板）。
   *
   * 修复（2026-09-09）：原实现**零校验** —— 任意 charId/storyId 组合都能写入 `addon.story`
   * 并白拿 384 枚 `CharStoryUnlock` 勋章。现按 `handbook_info_table.handbookDict[charId]
   * .handbookAvgList[]`（`storySetId` / `unlockParam`）校验归属与解锁条件。
   *
   * @param args.charId - 干员 ID
   * @param args.storyId - 密录剧情集 ID（`storySetId`，如 story_amgoat_set_1）
   * @returns 发放的勋章 ID（无对应勋章配置时返回 null，供 router 组装 medalFinish pushMessage）
   * @throws BadRequestError 干员无该密录、未持有该干员、或未满足解锁条件
   */
  async addonStoryUnlock(args: {
    charId: string;
    storyId: string;
  }): Promise<string | null> {
    const { charId, storyId } = args;
    this._assertAvgUnlockable(charId, storyId);
    let medalId: string | null = null;
    await this._player.update(async (draft) => {
      // 防御：addon 条目缺失（新干员/发放干员无密录基座）时先初始化，避免 500
      draft.troop.addon[charId] = draft.troop.addon[charId] ?? {
        story: {},
        stage: {},
      };
      draft.troop.addon[charId].story = Object.assign(
        draft.troop.addon[charId].story || {},
        { [storyId]: { fts: now(), rts: now() } },
      );
      // 对照官服抓包：解锁密录同步发放对应勋章
      // （medal_story_x，template CharStoryUnlock + unlockParam=[charId, storyId]，val 空数组、rts=-1）
      const medal = excel.MedalTable?.medalList?.find(
        (m) =>
          m.template === "CharStoryUnlock" &&
          m.unlockParam[0] === charId &&
          m.unlockParam[1] === storyId,
      );
      if (medal) {
        medalId = medal.medalId;
        draft.medal ??= {
          medals: {},
          custom: { currentIndex: "", customs: {} },
        };
        draft.medal.medals[medal.medalId] = {
          id: medal.medalId,
          val: [],
          fts: now(),
          rts: -1,
        };
      }
    });
    return medalId;
  }

  /**
   * 校验密录解锁条件（`handbookAvgList[].unlockParam`）
   *
   * 数据源：`handbook_info_table.handbookDict[charId].handbookAvgList[]`，每集含
   * `storySetId` 与 `unlockParam[]`：
   * - `AWAKE`：`unlockParam1` = 精英化阶段、`unlockParam2` = 等级（如精二 Lv60）
   * - `FAVOR`：`unlockParam1` = 信赖值（0~200 显示值）——需经 `favor_table.favorFrames`
   *   换算为存档内部 favorPoint（0~25570）后比较
   * @param charId - 干员 id
   * @param storyId - 密录剧情集 id
   * @throws BadRequestError 归属或条件不符
   */
  private _assertAvgUnlockable(charId: string, storyId: string): void {
    const sets =
      excel.HandbookInfoTable?.handbookDict?.[charId]?.handbookAvgList ?? [];
    const set = sets.find((s) => s?.storySetId === storyId);
    if (!set) {
      throw new BadRequestError(`干员 ${charId} 不存在密录 ${storyId}`);
    }
    const char = Object.values(this._player._playerdata.troop.chars).find(
      (c) => c.charId === charId,
    );
    if (!char) {
      throw new BadRequestError(`未持有干员 ${charId}，无法解锁密录 ${storyId}`);
    }
    for (const p of set.unlockParam ?? []) {
      const type = String(p?.unlockType ?? "");
      if (type === "AWAKE") {
        const phase = Number(p.unlockParam1 ?? 0);
        const level = Number(p.unlockParam2 ?? 0);
        if ((char.evolvePhase ?? 0) < phase || (char.level ?? 0) < level) {
          throw new BadRequestError(
            `密录 ${storyId} 需精英化${phase} Lv${level}（当前精${char.evolvePhase} Lv${char.level}）`,
          );
        }
      } else if (type === "FAVOR") {
        const favor = Number(p.unlockParam1 ?? 0);
        const need = this._favorPointFor(favor);
        if ((char.favorPoint ?? 0) < need) {
          throw new BadRequestError(
            `密录 ${storyId} 需信赖 ${favor}（当前信赖点数 ${char.favorPoint ?? 0}/${need}）`,
          );
        }
      }
    }
  }

  /**
   * 信赖显示值（0~200）→ 存档内部 favorPoint（favor_table.favorFrames）
   * @param favor - unlockParam 给出的信赖值
   * @returns 所需 favorPoint（表缺失时按 maxFavor/200 线性回退）
   */
  private _favorPointFor(favor: number): number {
    const frames = excel.FavorTable?.favorFrames ?? [];
    const exact = frames.find((f) => {
      const data = isJsonObject(f?.data) ? f.data : undefined;
      return Number(data?.percent ?? -1) >= favor;
    });
    if (exact) {
      const data = isJsonObject(exact.data) ? exact.data : undefined;
      return Number(data?.favorPoint ?? 0);
    }
    const maxFavor = Number(excel.FavorTable?.maxFavor ?? 25570);
    return Math.ceil((favor / 200) * maxFavor);
  }

  async addonStageBattleStart(args: {
    charId: string;
    stageId: string;
    squad: PlayerSquad;
    stageType: string;
  }) {
    const { stageId, squad } = args;
    // 修复①：原实现 emit "battle:start" 且丢弃返回值 → /charBuild/addonStage/battleStart
    // 响应不含 battleId，客户端结算时只能沿用上一次战斗（如肉鸽内层 ro6_*）的 battleId 解密，
    // 导致 battleFinish 读错 battleInfo → 未知关卡空结算。改为直接调用 battle.start 并返回结果，
    // 由路由把 battleId 等一并回传（与 /quest/battleStart 对齐）。
    //
    // 修复②（悖论模拟完整结算）：悖论模拟（mem_ 干员密录关卡）不是演习——
    // 首通会发放 handbook rewardItem（如合成玉）+ 记录 addon.stage。此前 usePracticeTicket=1
    // 固定练习模式，battle.finish 走练习分支直接返回 {result:0}，永不发奖/记录通关。改为
    // 真实战斗（usePracticeTicket=0）即可走标准结算；mem_ 关卡在 resolveStage 已保证 apCost=0/
    // expGain=0/goldGain=0，故不耗理智、不发经验金币，仅结算首通奖励与完成状态。
    return this._player.battle.start({
      isRetro: 0,
      pray: 0,
      battleType: 0,
      continuous: {
        battleTimes: 1,
      },
      usePracticeTicket: 0,
      stageId: stageId,
      squad: squad,
      assistFriend: null,
      isReplay: 0,
      startTs: now(),
    });
  }

  async addonStageBattleFinish(args: {
    data: string;
    battleData: { isCheat: string; completeTime: number };
  }) {
    let result: unknown;
    await this._trigger.emit("battle:finish", [
      args,
      (res: unknown) => {
        result = res;
      },
    ]);
    return result;
  }

  /**
   * 读取玩家干员字典（跨模块只读查询，rlv2 等模块经此访问，不直接读 _playerdata）
   * @returns 干员字典（instId → 干员数据）
   */
  getChars(): Record<string, PlayerCharacter> {
    return this._player._playerdata.troop?.chars ?? {};
  }

  async fix(): Promise<void> {
    // 迁移：进度修复移入 update() 配方——配方内 mutate draft（可变代理，
    // push/splice/赋值均安全）会记录补丁，无需再 markDirty
    await this._player.update((draft) => {
      // 防御：某些测试/空基座构造传入无 troop 的数据，直接跳过
      if (!draft.troop?.chars) return Promise.resolve();
      Object.values(draft.troop.chars).forEach((char) => {
        if (char.charId == "char_002_amiya") {
          return;
        }
        // 技能按官服线格式回填/解锁（excel skills[i].unlockCond.phase；
        // test.json 378/378 验证；未解锁技能以 unlock:0 占位保留）
        reconcileCharSkills(char);
        // 模组回填 + 精二隐藏→显示校正（补齐缺失条目；hide 按 showEvolvePhase 置 0/1）
        reconcileCharEquips(char);
        // 模板变体回填（tmpl 各形态按各自 charId 归属，分别校正）
        if (char.tmpl) {
          Object.entries(char.tmpl).forEach(([tmplId, patch]) => {
            patch.equip = patch.equip || {};
            reconcileCharEquips({
              charId: tmplId,
              evolvePhase: char.evolvePhase ?? 0,
              equip: patch.equip,
              currentEquip: patch.currentEquip,
            });
          });
        }
      });
      return Promise.resolve();
    });
  }
}
