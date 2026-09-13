/**
 * CHAOS / VISION 模块（rogue_3 坍缩/视域）
 *
 * 客户端状态形状（types-playerdata）：
 *   chaos = { value, level, curMaxValue, chaosList, predict, deltaChaos, lastBattleGain }
 *   vision = { value, isMax }
 *
 * 简化实现：战斗胜利累积坍缩值，达到上限升层并随机挂一个坍缩（chaosDatas 按层过滤）。
 */
import { RoguelikeV2Manager } from "../logic";
import excel from "@excel/excel";
import { TypedEventEmitter } from "../../../kernel/events/runtime";
import { random } from "@utils/random";

export class RoguelikeChaosManager {
  value: number;
  level: number;
  curMaxValue: number;
  chaosList: string[];
  predict: string;
  deltaChaos: {
    dValue: number;
    preLevel: number;
    afterLevel: number;
    dChaos: string[];
  };
  lastBattleGain: number;
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this.value = 0;
    this.level = 0;
    this.curMaxValue = 4;
    this.chaosList = [];
    this.predict = "";
    this.deltaChaos = { dValue: 0, preLevel: 0, afterLevel: 0, dChaos: [] };
    this.lastBattleGain = 0;
    this._trigger.on("rlv2:module:init", this.init.bind(this));
    this._trigger.on("rlv2:continue", this.continue.bind(this));
    this._trigger.on("rlv2:battle:finish", this.onBattleFinish.bind(this));
  }

  init(): void {
    this.value = 0;
    this.level = 0;
    // 官方 levelInfoDict：当前层坍缩值上限（rule_1 level 0: 0-4 → curMaxValue 4）
    this.curMaxValue = this.chaosLevelMax(0);
    this.chaosList = [];
    this.predict = "";
    this.deltaChaos = { dValue: 0, preLevel: 0, afterLevel: 0, dChaos: [] };
    this.lastBattleGain = 0;
  }

  /** 当前层坍缩值上限（官方 levelInfoDict rule_1：level N 的区间上界） */
  private chaosLevelMax(level: number): number {
    const theme = this._player.current.game!.theme;
    const dict = excel.RoguelikeTopicTable.modules[theme]?.chaos?.levelInfoDict;
    const rule = dict?.rule_1?.[level];
    return rule?.chaosLevelEndNum ?? 4 + level * 4;
  }

  continue(): void {
    const c = this._player.current.module?.chaos;
    this.value = c?.value ?? 0;
    this.level = c?.level ?? 0;
    this.curMaxValue = c?.curMaxValue ?? 4;
    this.chaosList = c?.chaosList ?? [];
    this.predict = c?.predict ?? "";
    this.deltaChaos = c?.deltaChaos ?? { dValue: 0, preLevel: 0, afterLevel: 0, dChaos: [] };
    this.lastBattleGain = c?.lastBattleGain ?? 0;
  }

  /** 战斗结束：胜利时累积坍缩值（胜利判据：战斗数据缺失时按 0 处理——不累积） */
  onBattleFinish(): void {
    // 简化：战斗结算时坍缩累积由调用方（battle.ts）驱动 gainChaos
  }

  /** 累积坍缩值（战斗胜利调用）；达到上限升层并挂坍缩 */
  gainChaos(gain: number): void {
    this.lastBattleGain = gain;
    const preLevel = this.level;
    this.deltaChaos = { dValue: gain, preLevel, afterLevel: preLevel, dChaos: [] };
    this.value += gain;
    while (this.value >= this.curMaxValue) {
      this.value -= this.curMaxValue;
      this.level += 1;
      // 每层上限按官方 levelInfoDict 提升
      this.curMaxValue = this.chaosLevelMax(this.level);
      const chaos = this.pickChaos();
      if (chaos) {
        this.chaosList.push(chaos);
        this.deltaChaos.dChaos.push(chaos);
      }
    }
    this.deltaChaos.afterLevel = this.level;
  }

  /** 按层随机挂一个坍缩（chaosDatas 过滤 level ≤ 当前层） */
  private pickChaos(): string {
    const theme = this._player.current.game!.theme;
    const chaosDatas = excel.RoguelikeTopicTable.modules[theme]?.chaos?.chaosDatas;
    if (!chaosDatas) return "";
    const candidates = Object.entries(chaosDatas)
      .filter(([, d]) => {
        // 去重键原写作 `d.id`：生成类型 RoguelikeChaosData 只声明 chaosId（线格式实测
        // 20/20 条无 id 字段），故该条件在真实数据下恒为真（includes(undefined)）。
        // 此处按原语义读取可选的历史 id 字段（保持行为不变，见报告"真实缺陷"）。
        const legacyId = (d as { id?: string }).id;
        return d.level <= this.level && !this.chaosList.some((id) => id === legacyId);
      })
      .map(([id]) => id);
    if (candidates.length === 0) return "";
    return candidates[Math.floor(random() * candidates.length)];
  }

  toJSON(): {
    value: number;
    level: number;
    curMaxValue: number;
    chaosList: string[];
    predict: string;
    deltaChaos: { dValue: number; preLevel: number; afterLevel: number; dChaos: string[] };
    lastBattleGain: number;
  } {
    return {
      value: this.value,
      level: this.level,
      curMaxValue: this.curMaxValue,
      chaosList: this.chaosList,
      predict: this.predict,
      deltaChaos: this.deltaChaos,
      lastBattleGain: this.lastBattleGain,
    };
  }
}

/** VISION 模块（rogue_3 视域——商店/宝箱可见范围） */
export class RoguelikeVisionManager {
  value: number;
  isMax: number;
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this.value = 0;
    this.isMax = 0;
    this._trigger.on("rlv2:module:init", this.init.bind(this));
    this._trigger.on("rlv2:continue", this.continue.bind(this));
  }

  init(): void {
    this.value = 0;
    this.isMax = 0;
  }

  continue(): void {
    const v = this._player.current.module?.vision as
      | { value?: number; isMax?: number | boolean }
      | undefined;
    this.value = v?.value ?? 0;
    this.isMax = v?.isMax ? 1 : 0;
  }

  toJSON(): { value: number; isMax: number } {
    return { value: this.value, isMax: this.isMax };
  }
}
