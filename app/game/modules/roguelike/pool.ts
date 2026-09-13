import excel from "@excel/excel";
import { readFileSync } from "fs";
import { RoguelikeItemBundle } from "./rlv2";
import { RoguelikeV2Manager } from "./logic";
import { randomChoice } from "@utils/random";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { logger } from "@utils/logger";
import { random } from "@utils/random";

/**
 * 官方池定义（data/rlv2/pools.json）：成员清单来自路标档案馆 pools/rogue_6 页面
 * （2026-08-17 抓取），比 excel 推断更精确：
 * - pool_scrap_3/6 为加权池（成员 {id, weight}，官方出现概率）
 * - pool_scrap_7/8/9 为多成员零件池（持有 迷藏/囊中骨/林中小手 时发放）
 * - pool_small_gift 为多成员小礼物池（持有 古地树实 时发放）
 * - pool_treasure / drop_extra_pool / pool_boss 为官方精确成员（非全 R/SR 超集）
 */
interface OfficialPoolDef {
  hasWeight?: boolean;
  members: string[] | { id: string; weight: number }[];
}

export class RoguelikePoolManager {
  _pools: { [id: string]: string[] };
  /** 加权池：poolId → { memberId → 权重 }（官方出现概率） */
  _poolWeights: { [id: string]: { [member: string]: number } };
  /** 官方池定义（data/rlv2/pools.json，加载失败为 null 时回退推断实现） */
  _official: { pools: { [id: string]: OfficialPoolDef } } | null;

  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._pools = {};
    this._poolWeights = {};
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("rlv2:relic:recycle", this.recycle.bind(this));
    this._trigger.on("rlv2:relic:put", this.put.bind(this));
    this._trigger.on("rlv2:init", this.init.bind(this));
    this._trigger.on("rlv2:create", this.create.bind(this));
    try {
      this._official = JSON.parse(
        readFileSync(`${__dirname}/../../../../data/rlv2/pools.json`, "utf-8"),
      );
    } catch {
      this._official = null;
    }
  }

  recycle([id]: [string]) {
    logger.debug("RLV2Pool", "recycle", id);
  }

  put([id]: [string]) {
    logger.debug("RLV2Pool", "put", id);
  }

  init() {
    this._pools = {};
  }

  async create() {
    const theme = this._player.current.game!.theme;
    const detail = excel.RoguelikeTopicTable.details[theme];
    this._pools["pool_sacrifice_n"] = [];
    this._pools["pool_sacrifice_r"] = [];
    // 收藏品池：按稀有度分类（官方 items.rarity：NORMAL/RARE/SUPER_RARE/BORN）
    this._pools["pool_relic_normal"] = [];
    this._pools["pool_relic_rare"] = [];
    this._pools["pool_relic_super_rare"] = [];
    this._pools["pool_relic_all"] = [];
    // 加工品池（rogue_6 开拓者分队 zone_into_reward pool_scrap_3/6）：
    // 官方成员由 data/rlv2/pools.json 提供（见下方 official 覆盖），此处按 GOODS 型
    // 废品建兜底池，避免 pools.json 缺失时池为空
    const typeMap = excel.RoguelikeTopicTable.modules[theme]?.scrap;
    const goodsIds = Object.keys(typeMap?.scrapItemToType || {}).filter(
      (id) => typeMap?.scrapItemToType?.[id] === "GOODS",
    );
    this._pools["pool_scrap_3"] = [...goodsIds];
    this._pools["pool_scrap_6"] = [...goodsIds];
    // 官方池（路标档案馆 pools/rogue_6 页面精确成员，data/rlv2/pools.json）：
    // 覆盖 pool_scrap_3/6/7/8/9、pool_small_gift、pool_treasure、drop_extra_pool、pool_boss
    const official = this._official?.pools || {};
    for (const [poolId, def] of Object.entries(official)) {
      if (def.hasWeight) {
        const members = def.members as { id: string; weight: number }[];
        this._pools[poolId] = members.map((m) => m.id);
        this._poolWeights[poolId] = {};
        for (const m of members) this._poolWeights[poolId][m.id] = m.weight;
      } else {
        this._pools[poolId] = [...(def.members as string[])];
      }
    }
    // 收藏品池：按稀有度分类（官方 items.rarity：NORMAL/RARE/SUPER_RARE/BORN）
    this._pools["pool_relic_normal"] = [];
    this._pools["pool_relic_rare"] = [];
    this._pools["pool_relic_super_rare"] = [];
    this._pools["pool_relic_all"] = [];
    const fragment = excel.RoguelikeTopicTable.modules[theme].fragment;
    if (fragment) {
      this._pools["pool_fragment_3"] = [];
      this._pools["pool_fragment_4"] = [];
      this._pools["pool_fragment_5"] = [];
      Object.values(fragment.fragmentData).forEach((data) => {
        if (data.type == "INSPIRATION") {
          this._pools["pool_fragment_3"].push(data.id);
        } else if (data.type == "WISH") {
          this._pools["pool_fragment_4"].push(data.id);
        } else if (data.type == "IDEA") {
          this._pools["pool_fragment_5"].push(data.id);
        }
      });
    }
    Object.values(detail.items)
      .filter((data) => data.canSacrifice)
      .forEach((data) => {
        if (data.value == 8) {
          this._pools["pool_sacrifice_n"].push(data.id);
        } else if (data.value == 12) {
          this._pools["pool_sacrifice_r"].push(data.id);
        }
      });
    // 收藏品池填充（type === RELIC 的物品，含诅咒/遗物等）
    for (const [id, item] of Object.entries(detail.items)) {
      if (item.type !== "RELIC") continue;
      this._pools["pool_relic_all"].push(id);
      const rarity = item.rarity;
      if (rarity === "NORMAL") {
        this._pools["pool_relic_normal"].push(id);
      } else if (rarity === "RARE") {
        this._pools["pool_relic_rare"].push(id);
      } else if (rarity === "SUPER_RARE") {
        this._pools["pool_relic_super_rare"].push(id);
      }
    }
  }

  /**
   * 从收藏品池随机抽一个未拥有的收藏品（不放回）
   * @param poolId 池 id（pool_relic_all / pool_relic_normal / ...）
   * @param hasRelic 已拥有的收藏品 id 列表（过滤避免重复）
   * @returns 收藏品 id；池空或全部已拥有返回空串
   */
  getRelic(poolId: string, hasRelic: string[] = []): string {
    const pool = this._pools[poolId] || [];
    const avail = pool.filter((id) => !hasRelic.includes(id));
    if (avail.length === 0) return "";
    const picked = avail[Math.floor(random() * avail.length)];
    // 不放回：从池中移除（同一探索内不重复出同池藏品）
    this._pools[poolId].splice(this._pools[poolId].indexOf(picked), 1);
    return picked;
  }

  get(id: string, putback = false): RoguelikeItemBundle {
    const pool = this._pools[id] || [];
    let res = "";
    const weights = this._poolWeights[id];
    if (weights && pool.length > 0) {
      // 加权抽取（官方出现概率）：按权重累加命中
      const total = pool.reduce((sum, m) => sum + (weights[m] ?? 1), 0);
      let r = random() * total;
      for (const m of pool) {
        r -= weights[m] ?? 1;
        if (r <= 0) { res = m; break; }
      }
      if (!res) res = pool[pool.length - 1];
    } else {
      res = pool.length > 0 ? randomChoice(pool) : "";
    }
    if (!putback && pool.length > 0) {
      pool.splice(pool.indexOf(res), 1);
    }
    return { id: res, count: 1 };
  }
}
