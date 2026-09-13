import excel from "@excel/excel";
import { PlayerRoguelikeV2, RoguelikeBuff } from "../rlv2";
import type { RoguelikeAlchemyData } from "@excel/excel";
import { RoguelikeV2Manager } from "../logic";
import { now } from "@utils/time";
import { randomChoice } from "@utils/random";
import { rarityToIndex } from "@utils/rarity";
import { logger } from "@utils/logger";
import { TypedEventEmitter } from "../../../kernel/events/runtime";
import { random } from "@utils/random";

export class RoguelikeFragmentManager {
  index: number;
  limitWeight: number;
  _fragments: {
    [key: string]: PlayerRoguelikeV2.CurrentData.Module.InventoryFragment;
  };
  _troopCarry: string[];
  _currInspiration: PlayerRoguelikeV2.CurrentData.Module.InventoryInspiration | null;
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this.index = 0;
    this.limitWeight = 0;
    this._fragments = player.current.module?.fragment?.fragments || {};
    this._troopCarry = player.current.module?.fragment?.troopCarry || [];
    this._currInspiration =
      player.current.module?.fragment?.currInspiration || null;
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("rlv2:module:init", this.init.bind(this));
    this._trigger.on("rlv2:continue", this.continue.bind(this));
    this._trigger.on("rlv2:fragment:gain", this.gain.bind(this));
    this._trigger.on("rlv2:fragment:max_weight:add", ([count]) => {
      this.limitWeight += count;
    });
    this._trigger.on("rlv2:fragment:use", this.use.bind(this));
    this._trigger.on("rlv2:fragment:lose", this.lose.bind(this));
    this._trigger.on(
      "rlv2:fragment:use_inspiration",
      this.useInspiration.bind(this),
    );
    this._trigger.on(
      "rlv2:fragment:set_troop_carry",
      ([troopCarry]: [string[]]) => {
        const weights = this._troopWeights;
        this.limitWeight -= this._troopCarry.reduce(
          (acc, cur) => acc + weights[cur],
          0,
        );
        this.limitWeight += troopCarry.reduce(
          (acc, cur) => acc + weights[cur],
          0,
        );
        this._troopCarry = troopCarry;
      },
    );
    this._trigger.on(
      "rlv2:fragment:change_type_weight",
      ([b]: [RoguelikeBuff]) => {
        const theme = player.current.game!.theme;
        Object.values(this._fragments).forEach((f) => {
          const info =
            excel.RoguelikeTopicTable.modules[theme].fragment?.fragmentData[
              f.id
            ];
          if (b.blackboard[1].valueStr == info?.type) {
            f.weight += b.blackboard[0].value!;
          }
        });
      },
    );
    this._trigger.on("rlv2:levelUp", ([targetLevel]) => {
      const theme = this._player.current.game!.theme;
      this.limitWeight += excel.RoguelikeTopicTable.modules[theme].fragment
        ?.fragmentLevelData[targetLevel].weightUp as number;
    });
  }

  get _totalWeight(): number {
    return Object.values(this._fragments)
      .filter((f) => !f.used)
      .reduce((acc, cur) => acc + cur.weight, 0);
  }

  get _troopWeights(): { [key: string]: number } {
    const chars = this._player.troop.chars;
    return Object.fromEntries(
      Object.entries(chars).map(([k, v]) => {
        const data = excel.charData(v.charId);
        // 修复：rarity 是 "TIER_N" 字符串——原 `rarity - 1` 得 NaN → 权重恒 undefined
        //（limitWeight 全 NaN）；统一经 rarityToIndex 转 0~5 下标
        const rarity = rarityToIndex(data?.rarity);
        let weight = [
          [2, 2, 2, 2, 3, 4],
          [-1, -1, -1, 4, 5, 6],
        ][v.evolvePhase == 2 ? 1 : 0][rarity] ?? 0;
        this._player._buff.filterBuffs("char_weight_rarity").forEach((b) => {
          if (b.blackboard[0].value == rarity) {
            weight += b.blackboard[1].value!;
          }
        });
        if (v.charId == "char_4151_tinman") {
          weight += 0;
          if (v.evolvePhase > 0) {
            weight += v.evolvePhase == 1 ? 3 : 9;
            if (v.potentialRank == 2) {
              weight += 1;
            }
          }
        }
        return [k, weight];
      }),
    );
  }

  /**
   * 解析碎片：按 id 键 或 index（f_N）寻址
   *
   * 修复：gain 以碎片 id 为键（this._fragments[id]），而客户端 loseFragment/
   * useInspiration/alchemy 传的是 index（f_N）——原实现直接 this._fragments[index]
   * → undefined（500/no-op）；兼容两种寻址
   */
  private _resolveFragment(key: string): PlayerRoguelikeV2.CurrentData.Module.InventoryFragment | undefined {
    if (this._fragments[key]) return this._fragments[key];
    return Object.values(this._fragments).find((f) => f.index === key);
  }

  alchemy(fragmentIndex: [string, string]) {
    const [f1, f2] = fragmentIndex;
    const theme = this._player.current.game!.theme;
    const fragmentData = excel.RoguelikeTopicTable.modules[theme].fragment;
    const alchemyData = fragmentData?.alchemyData || {};

    const fragment1 = this._resolveFragment(f1);
    const fragment2 = this._resolveFragment(f2);
    if (!fragment1 || !fragment2 || fragment1.used || fragment2.used) {
      return;
    }

    const type1 = fragmentData?.fragmentData[fragment1.id]?.type || "";
    const type2 = fragmentData?.fragmentData[fragment2.id]?.type || "";
    const value1 = fragment1.value;
    const value2 = fragment2.value;
    const squareSum = value1 * value1 + value2 * value2;

    let matchedRecipe: RoguelikeAlchemyData | null = null;
    for (const recipe of Object.values(alchemyData)) {
      const types = recipe.fragmentTypeList;
      const expectedSum = recipe.fragmentSquareSum;
      if (
        expectedSum === squareSum &&
        ((types[0] === type1 && types[1] === type2) ||
          (types[0] === type2 && types[1] === type1))
      ) {
        matchedRecipe = recipe;
        break;
      }
    }

    if (matchedRecipe) {
      fragment1.used = true;
      fragment2.used = true;

      const rand = random();
      if (rand < matchedRecipe.relicProp) {
        // 修复：原实现 emit 不存在的 `${theme}_relic_` → getItem 500（且多为
        // fire-and-forget → unhandled rejection）；改为随机发一个真实 RELIC 物品
        const relicIds = Object.entries(
          excel.RoguelikeTopicTable.details[theme]?.items ?? {},
        )
          .filter(([, it]) => it.type === "RELIC")
          .map(([id]) => id);
        if (relicIds.length > 0) {
          this._trigger.emit(
            "rlv2:get:items",
            [[{ id: randomChoice(relicIds), count: 1 }]],
          );
        } else {
          logger.warn("rlv2", `主题 ${theme} 无 RELIC 物品，炼金遗物奖励跳过`);
        }
      } else if (rand < matchedRecipe.relicProp + matchedRecipe.shieldProp) {
        this._player._status.property.shield += 1000;
      } else if (
        rand <
        matchedRecipe.relicProp + matchedRecipe.shieldProp + matchedRecipe.populationProp
      ) {
        this._player._status.property.population.max += 1;
      }
    }
  }

  alchemyReward(fragmentIndex: [string, string]) {
    const [f1, f2] = fragmentIndex;
    const theme = this._player.current.game!.theme;
    const fragmentData = excel.RoguelikeTopicTable.modules[theme].fragment;

    const fragment1 = this._fragments[f1];
    const fragment2 = this._fragments[f2];
    if (!fragment1 || !fragment2) {
      return;
    }

    const value1 = fragment1.value;
    const value2 = fragment2.value;
    const totalValue = value1 + value2;

    const goldReward = totalValue * 50;
    this._player._status.property.gold += goldReward;

    const expReward = totalValue * 10;
    this._player._status.property.exp += expReward;
  }

  useInspiration([fragmentIndex]: [string]): void {
    const frag = this._resolveFragment(fragmentIndex);
    if (!frag) return; // 防御：未知碎片不 500
    frag.used = true;
    this._currInspiration = {
      instId: fragmentIndex,
      id: frag.id,
      ei: -1,
    };
  }

  use([id, count]: [string, number]) {
    const unused = Object.values(this._fragments).filter(
      (f) => f.id == id && !f.used,
    );
    // 修复：count 超过可用碎片时原实现 [i]! 为 undefined → 崩溃；钳制到可用数量
    for (let i = 0; i < Math.min(count, unused.length); i++) {
      unused[i].used = true;
    }
  }

  lose([fragmentIndex]: [string]): void {
    const frag = this._resolveFragment(fragmentIndex);
    if (!frag) return; // 防御：未知碎片不 500
    frag.used = true;
  }

  gain([id]: [string]): void {
    const theme = this._player.current.game!.theme;
    const data =
      excel.RoguelikeTopicTable.modules[theme].fragment?.fragmentData[id];
    // 防御：未知碎片 id 不崩（原 data! 解引用 → 500）
    if (!data) {
      logger.warn("rlv2", `碎片 ${id} 不在主题 ${theme} fragmentData，跳过发放`);
      return;
    }
    this._fragments[id] = {
      index: `f_${this.index}`,
      id: id,
      used: false,
      ts: now(),
      weight: data.weight,
      value: data.value,
      ei: -1,
    };
    this.index += 1;
  }

  init() {
    this.index = 0;
    this.limitWeight = 3;
    this._currInspiration = null;
    this._fragments = {};
    this._troopCarry = [];
  }

  continue() {}

  toJSON(): PlayerRoguelikeV2.CurrentData.Module.Fragment {
    return {
      totalWeight: this._totalWeight,
      limitWeight: this.limitWeight,
      overWeight: Math.floor(this.limitWeight * 1.5),
      fragments: this._fragments,
      troopWeights: this._troopWeights,
      troopCarry: this._troopCarry,
      currInspiration: this._currInspiration,
    };
  }
}
