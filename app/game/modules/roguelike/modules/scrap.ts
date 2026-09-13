/**
 * SCRAP 模块（rogue_6 废品/载具）
 *
 * 客户端状态形状（types-playerdata）：scrap = {
 *   activeVehicle: { instId, isWalk },   // 当前移动方式（0=步行 / 载具 instId）
 *   inventory: { [instId]: { instId, id, value, useCnt, ts } },
 *   limit,                               // 库存上限
 * }
 * 简化实现：开局持有 1 个随机 MOVE 型废品（载具）；changeVehicle 切换当前载具。
 */
import { RoguelikeV2Manager } from "../logic";
import excel from "@excel/excel";
import { now } from "@utils/time";
import { TypedEventEmitter } from "../../../kernel/events/runtime";
import { isBlackstream } from "../theme-rules";
import type { RoguelikeScrapModuleData } from "@excel/excel";
import { random } from "@utils/random";

/**
 * 当前移动方式（步行 = isWalk true；载具 = instId）
 *
 * 生成/内部模型把 isWalk 声明为 number（FBO 原生数值），本实现的运行时值为 boolean
 * （toJSON 输出 boolean，见 tests），故按联合声明以兼容存档读回。
 */
export type ScrapActiveVehicle = { instId?: string; isWalk: boolean | number };

export interface ScrapItem {
  instId: string;
  id: string;
  value: number;
  useCnt: number;
  ts: number;
}

/** 自然物（GOODS 型废品）估价动态效果的触发事件类型 */
type GoodsTrigger =
  | "battle_win" // 作战胜利
  | "battle_perfect" // 完美作战
  | "battle_nonperfect" // 胜利但非完美
  | "battle_fail" // 作战失败
  | "move" // 移动后
  | "node_reveal" // 揭示节点
  | "recruit" // 招募干员
  | "scrap_gain"; // 获得零件

export class RoguelikeScrapManager {
  activeVehicle: ScrapActiveVehicle;
  inventory: { [key: string]: ScrapItem };
  limit: number;
  _index: number;
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    // 官服 createGame scrap：activeVehicle 仅 { isWalk: true }（步行无 instId）、
    // 开局 2 个初始废品（s_1/s_2 = G_01，value 2）、零件箱容量 8（抓包确认）
    this.activeVehicle = { isWalk: true };
    this.inventory = {};
    this.limit = 10; // 零件箱基础容量 10（难度 buff 叠加后为 8）
    this._index = 0;
    this.seedInitial();
    this._trigger.on("rlv2:module:init", this.init.bind(this));
    this._trigger.on("rlv2:continue", this.continue.bind(this));
    this._trigger.on("rlv2:scrap:gain", this.gain.bind(this));
  }

  init(): void {
    this.activeVehicle = { isWalk: true };
    this.inventory = {};
    this.limit = 10; // 零件箱基础容量 10（难度 buff 叠加后为 8）
    this._index = 0;
    this.seedInitial();
  }

  /** 官方开局废品：s_1/s_2 = rogue_6_scrap_G_01（value 2）——初始零件箱自带 2 件 */
  private seedInitial(): void {
    const theme = this._player.current.game?.theme || "";
    if (!isBlackstream(theme)) return;
    // 开局废品 id 取官方 moduleConsts.identifyScrapId（实测 = rogue_6_scrap_G_01），
    // 估价取该废品的官方 sellPrice（实测 2），与抓包一致
    const id = this.scrapModule()?.moduleConsts?.identifyScrapId ?? "rogue_6_scrap_G_01";
    const tpl = { id, value: this.sellPriceOf(id, 2), useCnt: 0, ts: now() };
    this.inventory["s_1"] = { instId: "s_1", ...tpl };
    this.inventory["s_2"] = { instId: "s_2", ...tpl };
    this._index = 3; // 下个废品 s_3（不覆盖 s_1/s_2）
  }

  /**
   * 当前主题的 SCRAP 模块数据（官方 modules[theme].scrap）。
   * @returns 模块数据；主题无该模块时为 undefined
   */
  private scrapModule(): RoguelikeScrapModuleData | undefined {
    const theme = this._player.current.game?.theme || "";
    return excel.RoguelikeTopicTable.modules[theme]?.scrap ?? undefined;
  }

  /**
   * 废品官方估价（sellPrice）。
   * 官方按类型分表：goodsScrapData（自然物）/ moveScrapData（加工品/载具）/
   * passiveScrapData（概念体）。估价决定行商售价与"消耗最低估价加工品"的排序。
   * @param id 废品 id
   * @param fallback 数据缺失时的兜底估价
   * @returns 估价
   */
  private sellPriceOf(id: string, fallback = 1): number {
    const m = this.scrapModule();
    const price =
      m?.goodsScrapData?.[id]?.sellPrice ??
      m?.moveScrapData?.[id]?.sellPrice ??
      m?.passiveScrapData?.[id]?.sellPrice;
    return typeof price === "number" ? price : fallback;
  }

  continue(): void {
    const s = this._player.current.module?.scrap;
    this.activeVehicle = s?.activeVehicle || { isWalk: true };
    this.inventory = s?.inventory || {};
    this.limit = s?.limit ?? 10;
    // 修复：原实现 _index = 键数——seedInitial 后 s_1/s_2 存在（键数 2），
    // 续局 _index=2 → 下个废品写成 s_2 覆盖已播种项；改为 最大 instId 后缀 + 1
    let maxN = 0;
    for (const id of Object.keys(this.inventory)) {
      const m = /_(\d+)$/.exec(id);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    this._index = maxN + 1;
  }

  /** 获得废品（战斗/事件奖励） */
  gain([id]: [string]): void {
    const type = this.scrapModule()?.scrapItemToType?.[id];
    if (!type) return;
    if (Object.keys(this.inventory).length >= this.limit) return;
    const instId = `s_${this._index}`;
    // 估价取官方 sellPrice（原实现恒为 1，导致行商售价与"扣最低估价加工品"排序失真）
    let value = this.sellPriceOf(id);
    // 藏品被动 scrap_fill_up（如【多生苔藓】"获得零件时估价+1"）：持有该 buff 时，
    // 本次获得的零件估价 +1。applyBuffs 已把该 buff 记录进 _buffs（其余 key 原样入池）。
    if (this._player._buff?.filterBuffs("scrap_fill_up").length) {
      value += 1;
    }
    this.inventory[instId] = {
      instId,
      id,
      value,
      useCnt: 0,
      ts: now(),
    };
    this._index += 1;
    // 特勤干员任务：获得零件（Rlv2GainItem，每件 1 计）
    this._trigger.emit("Rlv2GainItem", [{ itemType: "SCRAP", count: 1 }]);
    // 自然物 G_07【多生藓苔】"获得时，立刻获得3个枯苔藓球"：获得该自然物时额外发放 3 件 G_08
    if (id === "rogue_6_scrap_G_07") {
      for (let i = 0; i < 3; i++) {
        this.gain(["rogue_6_scrap_G_08"]);
      }
    }
    // 自然物获得时估价效果：已持有的 G_07/G_09 在"获得零件时"估价 +1/+4（自身受事件累积）
    this.applyGoodsEffect("scrap_gain");
    // 散件获得推送（rlv2GotRandScrap，触发类 RoguelikeScrapGainTrigger）：携带获得的散件 id
    this._player.pushMessage("rlv2GotRandScrap", { idList: [id] });
    // MOVE 型废品自动装备为载具（首个）
    if (type === "MOVE" && this.activeVehicle.isWalk) {
      this.activeVehicle = {
        instId,
        isWalk: false,
      };
    }
  }

  /**
   * 自然物（GOODS 型废品）估价动态效果——服务端事件驱动 value。
   * 各自然物在对应事件发生时自身的 value（估价）累积变化，供行商售价与
   * "消耗最低估价加工品"排序使用（consumePortalScrap / loseScrap 读 inventory.value）。
   * @param trigger 触发事件类型
   * @param count 事件发生次数（如一次移动揭示多个节点）
   */
  applyGoodsEffect(trigger: GoodsTrigger, count = 1): void {
    if (!this.inventory) return;
    const stm = this.scrapModule();
    if (!stm) return;
    // 待移除（损坏）的自然物 id 集，遍历后统一删除（避免遍历中改动）
    const toRemove: string[] = [];
    for (const it of Object.values(this.inventory)) {
      if (stm.scrapItemToType?.[it.id] !== "GOODS") continue;
      this.applySingleGoodsEffect(it, trigger, count, toRemove);
    }
    if (toRemove.length > 0) {
      for (const instId of toRemove) delete this.inventory[instId];
    }
  }

  /** 对单个自然物按其 id 应用一次事件估价效果 */
  private applySingleGoodsEffect(
    it: ScrapItem,
    trigger: GoodsTrigger,
    count: number,
    toRemove: string[],
  ): void {
    const value = (d: number) => {
      it.value += d;
    };
    switch (it.id) {
      case "rogue_6_scrap_G_02": // 每次作战后估价+2
        if (trigger === "battle_win") value(2 * count);
        break;
      case "rogue_6_scrap_G_03": // 每次揭示节点信息时估价+1
        if (trigger === "node_reveal") value(1 * count);
        break;
      case "rogue_6_scrap_G_04": // 每次招募干员时估价+3
        if (trigger === "recruit") value(3 * count);
        break;
      case "rogue_6_scrap_G_05": // 每次移动后估价随机 -6~+8（含两端）
        if (trigger === "move") {
          for (let i = 0; i < count; i++) {
            it.value += Math.floor(random() * 15) - 6;
          }
        }
        break;
      case "rogue_6_scrap_G_06": // 完美作战后+4；非完美作战后自身损坏（移除）
        if (trigger === "battle_perfect") value(4 * count);
        else if (trigger === "battle_fail" || trigger === "battle_nonperfect") {
          toRemove.push(it.instId);
        }
        break;
      case "rogue_6_scrap_G_07": // 获得零件时估价+1
        if (trigger === "scrap_gain") value(1 * count);
        break;
      case "rogue_6_scrap_G_09": // 获得零件时估价+4
        if (trigger === "scrap_gain") value(4 * count);
        break;
      case "rogue_6_scrap_G_10": // 每次移动后估价-2
        if (trigger === "move") value(-2 * count);
        break;
      default:
        break; // G_01/G_08/G_11/G_12：无估价动态（G_12 不期而遇特殊作用见节点钩子）
    }
  }

  /** 切换当前载具（scrap/changeVehicle）→ rlv2VehicleChange 推送（触发类 RoguelikeVehicleChangeTrigger） */
  changeVehicle(instId: string): void {
    if (instId === "") {
      if (this.activeVehicle?.isWalk) return; // 已是步行，无变化不推送
      this.activeVehicle = { isWalk: true };
      this._player.pushMessage("rlv2VehicleChange", {});
      return;
    }
    const item = this.inventory[instId];
    if (!item || this.activeVehicle?.instId === instId) return;
    this.activeVehicle = { instId, isWalk: false };
    this._player.pushMessage("rlv2VehicleChange", {});
  }

  /**
   * 调整零件箱容量上限（统一入口：MAX_WEIGHT / scrap_limit_add 增减均由外部改 scrap.limit，
   * 这里集中触发容量变化推送，避免各调用点重复逻辑）。
   * 官方触发类：RoguelikeFragmentBagWeightUpgradeTrigger（rlv2LevelUpMaxWeight {count}，扩容）、
   * RoguelikeFragmentBagWeightWorseTrigger（rlv2WeightWorse {}，缩减）。
   * @param next 调整后的容量上限
   */
  setLimit(next: number): void {
    const prev = this.limit;
    const n = Math.max(0, next);
    if (n === prev) return;
    this.limit = n;
    if (n < prev) {
      // 容量缩减 → WeightWorse（零件箱变小提示）
      this._player.pushMessage("rlv2WeightWorse", {});
    } else {
      // 容量扩容 → LevelUpMaxWeight（count = 本次新增容量）
      this._player.pushMessage("rlv2LevelUpMaxWeight", { count: n - prev });
    }
  }

  toJSON(): {
    activeVehicle: ScrapActiveVehicle;
    inventory: { [key: string]: ScrapItem };
    limit: number;
  } {
    return {
      activeVehicle: this.activeVehicle,
      inventory: this.inventory,
      limit: this.limit,
    };
  }
}
