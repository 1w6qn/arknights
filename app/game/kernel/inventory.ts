import { ItemBundle, ItemType } from "@excel/excel";
import excel from "@excel/excel";
import { logger } from "@utils/logger";
import { now } from "@utils/time";
import { getFurnitureThemeId } from "@excel/building_excel";
import { isJsonObject } from "@excel/json-value";
import { PlayerDataModel, PlayerStatus } from "./playerdata";
import { PlayerDataManager } from "./player-data-manager";
import { Draft } from "mutative";
import type { PipelineItem } from "./inventory-pipeline";
import { TypedEventEmitter } from "./events/runtime";
import { BadRequestError } from "@core/http/errors";
import { resolveDictKey } from "./util/excel-key";
import { asShape } from "./util/json-shape";

/** 余额位于 consumable 实例的物品类型（consumable[itemId][instId].count） */
const CONSUMABLE_TYPES: ReadonlySet<string> = new Set([
  "AP_SUPPLY",
  "RENAMING_CARD",
  "RENAMING_CARD_2",
  "VOUCHER_PICK",
  "VOUCHER_CGACHA",
  "VOUCHER_MGACHA",
  "LMTGS_COIN",
  "LIMITED_TKT_GACHA_10",
  "LINKAGE_TKT_GACHA_10",
  "VOUCHER_ELITE_II_4",
  "VOUCHER_ELITE_II_5",
  "VOUCHER_ELITE_II_6",
  "VOUCHER_SKIN",
  "EXTERMINATION_AGENT",
  "OPTIONAL_VOUCHER_PICK",
  "VOUCHER_LEVELMAX_4",
  "VOUCHER_LEVELMAX_5",
  "VOUCHER_LEVELMAX_6",
  "VOUCHER_SKILL_SPECIALLEVELMAX_4",
  "VOUCHER_SKILL_SPECIALLEVELMAX_5",
  "VOUCHER_SKILL_SPECIALLEVELMAX_6",
  "ACTIVITY_POTENTIAL",
  "ITEM_PACK",
  "MATERIAL_ISSUE_VOUCHER",
  "EXCLUSIVE_TKT_GACHA",
  "EXCLUSIVE_TKT_GACHA_10",
]);

/** 余额位于 inventory[itemId] 的物品类型 */
const INVENTORY_TYPES: ReadonlySet<string> = new Set([
  "MATERIAL",
  "CARD_EXP",
  "ACTIVITY_COIN",
  "ACTIVITY_ITEM",
  "PLOT_ITEM",
  "TKT_GACHA_PRSV",
  "EPGS_COIN",
  "REP_COIN",
  "VOUCHER_FULL_POTENTIAL",
  "MAGAZINE_LEAF",
]);

/** 余额位于 status 字段的物品类型 → 字段名 */
const STATUS_TYPES: Readonly<Record<string, keyof PlayerStatus>> = {
  GOLD: "gold",
  DIAMOND: "androidDiamond",
  DIAMOND_SHD: "diamondShard",
  HGG_SHD: "hggShard",
  LGG_SHD: "lggShard",
  CLASSIC_SHD: "classicShard",
  SOCIAL_PT: "socialPoint",
  TKT_TRY: "practiceTicket",
  TKT_RECRUIT: "recruitLicense",
  TKT_INST_FIN: "instantFinishTicket",
  TKT_GACHA: "gachaTicket",
  TKT_GACHA_10: "tenGachaTicket",
  CLASSIC_TKT_GACHA: "classicGachaTicket",
  CLASSIC_TKT_GACHA_10: "classicTenGachaTicket",
};

/** TYPE_ACT53SIDE 活动币映射（coinItemId → actId，惰性构建；奇象巡展等事件共用） */
let _act53CoinMap: Map<string, string> | null = null;
function act53SideActIdByCoinItem(itemId: string): string | undefined {
  if (!_act53CoinMap) {
    _act53CoinMap = new Map();
    const activityTable = excel.ActivityTable;
    const basic = activityTable?.basicInfo ?? {};
    // 活动详情表为未建模 JSON（ActivityTable_ActivityDetailTable = JsonValue 字典型），
    // 逐层用 isJsonObject 收窄后取 constData.coinItemId
    const activityTypeDict = activityTable?.activity?.[
      resolveDictKey(activityTable?.activity, "TYPE_ACT53SIDE") ?? "tYPE_ACT53SIDE"
    ];
    const activity = isJsonObject(activityTypeDict) ? activityTypeDict : {};
    for (const [actId, info] of Object.entries(basic)) {
      if (info?.type !== "TYPE_ACT53SIDE") continue;
      const detail = activity[actId];
      if (!isJsonObject(detail)) continue;
      const constData = detail.constData;
      const coin = isJsonObject(constData) ? constData.coinItemId : undefined;
      if (coin) _act53CoinMap.set(String(coin), actId);
    }
  }
  return _act53CoinMap.get(itemId);
}

export class InventoryManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("items:use", async ([items]: [PipelineItem[]]) => {
      // 修复（2026-09-09）：消耗接口**不接受负数量**（全局不变量）。`_useItem` 对非
      // consumable 类型走 else 分支 emit `items:get`（`count: -item.count`），即负数量
      // 会被当作「反向入账」**发放**物品；而 `canConsume` 又用 `Math.abs()` 校验余额——
      // 二者叠加即可凭空复制物品（Round 41 的 depot / milestone 两处入口漏洞正是由此
      // 放大）。0 仍放行：部分商店商品价格为 0（免费），等价于无操作且无副作用。
      for (const item of items) {
        if (Number(item.count ?? 0) < 0) {
          logger.warn(
            "inventory",
            `items:use 拒绝负数量：${item.id} count=${item.count}`,
          );
          throw new BadRequestError(
            `物品数量非法：${item.id} count=${item.count}`,
          );
        }
      }
      // 修复（2026-09-09，S5 消耗余额校验）：整批「先校验后扣减」——原实现无任何余额
      // 校验（gainItem 的 `+=` 无下限），玩家 0 材料即可精二/专三/模组满级，库存与
      // 龙门币可被扣成负数。校验失败抛 BadRequestError（gameErrorHandler → 400 JSON），
      // 调用方 await emit 时自然中断，不再执行后续发放。
      for (const item of items) {
        const reason = this.canConsume(item);
        if (reason) {
          logger.warn("inventory", `items:use 余额不足，拒绝消耗：${reason}`);
          throw new BadRequestError(`物品不足：${reason}`);
        }
      }
      // 串行扣减（与 items:get 同理：并发 update 会在同一 _playerdata 上交错）
      for (const item of items) {
        await this._useItem(item);
      }
    });
    this._trigger.on("items:get", async ([items]: [PipelineItem[]]) => {
      // 串行发放：Promise.all 并发 gainItem 会在同一 _playerdata 上并发
      // createDraft/finishDraft（后一个 finishDraft 覆盖前一个结果 → 物品丢失 +
      // Immer 全树 diff 慢）；逐个 update 语义等价且每个只 diff 实际变更路径
      for (const item of items) {
        await this.gainItem(item);
        // 奇象巡展等 TYPE_ACT53SIDE 活动币跟踪：获得 coinItemId 物品时累加 actCoin
        // （官服 activity.TYPE_ACT53SIDE[actId].actCoin 随活动币获取累计——关卡掉落
        // act53side_token_photo 等；缺此逻辑事件页硬币计数恒 0）
        await this._trackAct53SideCoin(item);
        // 累计获得活动代币/材料勋章（TotalSimpleTokenCount）—— 模板按 param[3]
        // 材料列表过滤相关物品，非目标 id 不推进
        await this._trigger.emit("TotalSimpleTokenCount", [
          { itemId: item.id, count: item.count ?? 1 },
        ]);
        // 修复（2026-09-09，S1）：限时获得物品勋章（GotItemBeforeTime）——原实现无 emit
        // 站点，模板退化为「注册后天数」占位；此处按官方契约补发 itemId。
        await this._trigger.emit("GotItemBeforeTime", [{ itemId: item.id }]);
        // 累计获得活动币任务（ActivityCoinGain）—— 模板按 param[3] 活动币 itemId 过滤。
        // act17side/act24side 等别传用（累计获得 actXXside_token 达目标）
        await this._trigger.emit("ActivityCoinGain", [
          { itemId: item.id, count: item.count ?? 1 },
        ]);
      }
    });
  }

  /**
   * 校验玩家是否持有足量「待消耗」物品（count 取绝对值）
   *
   * 余额来源按物品类型判定：consumable 实例（凭证/道具）→ inventory[itemId]
   * （材料/作战记录/活动币）→ status 字段（龙门币/合成玉/各类票据）。
   * 未纳入校验的类型（如 AP_GAMEPLAY、活动专用计数）返回 null（本层不拦截）。
   * @param item - 待消耗物品（count 为正表示消耗数量）
   * @returns 不足时的原因文案；充足或不可校验时为 null
   */
  canConsume(item: PipelineItem): string | null {
    const count = Math.abs(item.count ?? 0);
    if (count <= 0) return null;
    const data = this._player._playerdata;
    const type = (item.type ??
      (excel.getItem(item.id)?.itemType as string | undefined)) as
      | string
      | undefined;
    if (!type) return null;
    const balances: Array<{ from: string; value: number }> = [];
    if (CONSUMABLE_TYPES.has(type)) {
      const instId = item.instId;
      const inst =
        instId === undefined ? undefined : data.consumable[item.id]?.[instId];
      balances.push({
        from: "consumable",
        value: typeof inst?.count === "number" ? inst.count : 0,
      });
    }
    if (INVENTORY_TYPES.has(type)) {
      const owned = data.inventory?.[item.id];
      balances.push({
        from: "inventory",
        value: typeof owned === "number" ? owned : 0,
      });
    }
    const statusField = STATUS_TYPES[type];
    if (statusField) {
      const owned = data.status[statusField];
      balances.push({
        from: `status.${statusField}`,
        value: typeof owned === "number" ? owned : 0,
      });
    }
    // 无可校验余额来源的类型不拦截（避免误拒：AP 增减、活动专用计数等）
    if (balances.length === 0) return null;
    const best = balances.reduce((a, b) => (b.value > a.value ? b : a));
    return best.value >= count
      ? null
      : `${item.id}（${type}）持有 ${best.value} < 需要 ${count}`;
  }

  get skinCnt(): number {
    // 防御：全新号 skin 可能为空对象（无 characterSkins 子树）
    return Object.keys(this._player._playerdata.skin.characterSkins ?? {}).length;
  }

  /**
   * TYPE_ACT53SIDE 活动币累计（奇象巡展 actCoin）
   *
   * 获得活动币物品（constData.coinItemId，如 act53side_token_photo）时，
   * 累加 activity.TYPE_ACT53SIDE[actId].actCoin——事件页硬币计数与官服一致
   * （官服完成态快照 actCoin=33 随关卡掉落累计）。
   * @param item - 已入账的物品
   */
  private async _trackAct53SideCoin(item: ItemBundle): Promise<void> {
    if (!item.id || (item.count ?? 0) <= 0) return;
    const actId = act53SideActIdByCoinItem(item.id);
    if (!actId) return;
    await this._player.update(async (draft) => {
      // TYPE_ACT53SIDE 未具名登记（PlayerActivity 兜底索引签名只展开两层 ServerPayload），
      // 第三层 actCoin 就地收窄为存档形状
      const act = asShape<{ actCoin?: number }>(draft.activity?.TYPE_ACT53SIDE?.[actId]);
      if (act) {
        act.actCoin = (act.actCoin ?? 0) + (item.count ?? 0);
      }
    });
  }

  async _useItem(item: PipelineItem): Promise<void> {
    if (!item.type) {
      const def = excel.getItem(item.id);
      if (!def) {
        logger.warn(
          "inventory",
          `items:use 物品 ${item.id} 不在 ItemTable，跳过消耗`,
        );
        return;
      }
      item.type = def.itemType;
    }
    const consumableFunc = async (
      item: PipelineItem,
      draft: Draft<PlayerDataModel>,
    ) => {
      // 防御：目标 consumable 条目不存在（客户端乱传 itemId/instId）时不 500，
      // WARN 跳过——避免 useItem 假 instId 直接崩溃
      const instId = item.instId;
      const target =
        instId === undefined ? undefined : draft.consumable[item.id]?.[instId];
      if (!target) {
        logger.warn(
          "inventory",
          `items:use ${item.id}#${item.instId} 不存在于 consumable，跳过消耗`,
        );
        return;
      }
      target.count -= item.count;
    };
    const funcs: {
      [key: string]: (
        item: PipelineItem,
        draft: Draft<PlayerDataModel>,
      ) => Promise<void>;
    } = {
      TKT_GACHA_PRSV: consumableFunc,
      VOUCHER_ELITE_II_4: consumableFunc,
      VOUCHER_ELITE_II_5: consumableFunc,
      VOUCHER_ELITE_II_6: consumableFunc,
      VOUCHER_LEVELMAX_6: consumableFunc,
      VOUCHER_LEVELMAX_5: consumableFunc,
      VOUCHER_LEVELMAX_4: consumableFunc,
      VOUCHER_SKILL_SPECIALLEVELMAX_6: consumableFunc,
      VOUCHER_SKILL_SPECIALLEVELMAX_5: consumableFunc,
      VOUCHER_SKILL_SPECIALLEVELMAX_4: consumableFunc,
      AP_SUPPLY: async (item, draft) => {
        await consumableFunc(item, draft);
        await this._trigger.emit("items:get", [
          [{ id: "", type: "AP_GAMEPLAY" as ItemType, count: 120 * item.count }],
        ]);
      },
    };
    if (item.type in funcs) {
      await this._player.update(async (draft) => {
        await funcs[item.type!](item, draft);
      });
    } else {
      await this._trigger.emit("items:get", [
        [Object.assign({}, item, { count: -item.count })],
      ]);
    }
  }

  async gainItem(item: ItemBundle, callback?: () => void): Promise<void> {
    if (!item.type) {
      const def = excel.getItem(item.id);
      if (!def) {
        logger.warn(
          "inventory",
          `items:get 物品 ${item.id} 不在 ItemTable，跳过发放`,
        );
        return;
      }
      item.type = def.itemType as ItemType;
    }
    // 修复（2026-09-09，S5）：负数增收即消耗，先校验余额（防库存/龙门币被扣成负数）
    if ((item.count ?? 0) < 0) {
      const reason = this.canConsume({
        ...item,
        count: -(item.count ?? 0),
      } as ItemBundle);
      if (reason) {
        logger.warn("inventory", `items:get 负数消耗余额不足，拒绝：${reason}`);
        throw new BadRequestError(`物品不足：${reason}`);
      }
    }
    const consumableFunc = async (
      item: PipelineItem,
      draft: Draft<PlayerDataModel>,
    ) => {
      let consumableId = item.instId;
      if (!consumableId) {
        const consumable_set = new Set<number>();
        // 性能：从实时对象遍历（经 draft 代理遍历会对每个 consumable 条目创建
        // Proxy——100+ 条时每次发放 ~100ms 且随条目增长；本扫描发生在任何
        // consumable 写入之前，实时对象与 draft 基值一致）
        for (const entry of Object.values(
          this._player._playerdata.consumable,
        )) {
          const keys = Object.keys(entry);
          if (keys.length > 0) {
            consumable_set.add(parseInt(keys[0], 10));
          }
        }
        const maxConsumableId =
          consumable_set.size > 0 ? Math.max(...Array.from(consumable_set)) : 0;
        consumableId = maxConsumableId + 1;
      }

      if (!draft.consumable[item.id]) {
        draft.consumable[item.id] = {};
      }
      if (draft.consumable[item.id][consumableId]) {
        draft.consumable[item.id][consumableId].count += item.count;
      } else {
        draft.consumable[item.id][consumableId] = { count: item.count, ts: -1 };
      }
    };
    const funcs: {
      [key: string]: (
        item: PipelineItem,
        draft: Draft<PlayerDataModel>,
      ) => Promise<void>;
    } = {
      NONE: async () => {},
      CHAR: async (item) => {
        await this._trigger.emit("char:get", [item.id]);
      },
      CARD_EXP: async (item, draft) => {
        draft.inventory[item.id] = (draft.inventory[item.id] || 0) + item.count;
      },
      // 修复（2026-09-09，审计 §5.4-11 配套）：特勤作战记录（so_char_exp_1 / SO_CHAR_EXP，
      // item_table 实测 itemType = SO_CHAR_EXP，用途「增加特勤干员的经验值」）——
      // 原实现未处理该类型 → gainItem 走「未知物品类型」分支 WARN 跳过，特勤干员周任务
      // 奖励（6000/8000 特勤作战记录）实际**发放失败**。与 CARD_EXP/MATERIAL 同口径入库。
      SO_CHAR_EXP: async (item, draft) => {
        draft.inventory[item.id] = (draft.inventory[item.id] || 0) + item.count;
      },
      MATERIAL: async (item, draft) => {
        draft.inventory[item.id] = (draft.inventory[item.id] || 0) + item.count;
      },
      GOLD: async (item, draft) => {
        draft.status.gold += item.count;
      },
      EXP_PLAYER: async (item, draft) => {
        draft.status.exp += item.count;
        for (
          let i = draft.status.level - 1;
          i < excel.GameDataConst.playerExpMap.length;
          i++
        ) {
          const exp = excel.GameDataConst.playerExpMap[i];
          if (draft.status.exp >= exp) {
            draft.status.level += 1;
            draft.status.exp -= exp;
            draft.status.maxAp =
              excel.GameDataConst.playerApMap[draft.status.level - 1];
            await this._trigger.emit("items:get", [
              [
                {
                  id: "",
                  type: "AP_GAMEPLAY" as ItemType,
                  count: draft.status.maxAp,
                },
              ],
            ]);
            await this._trigger.emit("player:levelUp", [{ level: draft.status.level }]);
            // 修复：UpgradePlayer 任务事件从未 emit → 玩家等级类任务永不推进
            await this._trigger.emit("UpgradePlayer", [
              { level: draft.status.level },
            ]);
            // 修复：勋章 PlayerLevel 事件从未 emit → 玩家等级勋章永不推进
            await this._trigger.emit("PlayerLevel", [
              { level: draft.status.level },
            ]);
          } else {
            break;
          }
        }
      },
      TKT_TRY: async (item, draft) => {
        draft.status.practiceTicket += item.count;
      },
      TKT_RECRUIT: async (item, draft) => {
        draft.status.recruitLicense += item.count;
      },
      TKT_INST_FIN: async (item, draft) => {
        draft.status.instantFinishTicket += item.count;
      },
      TKT_GACHA: async (item, draft) => {
        draft.status.gachaTicket += item.count;
      },
      ACTIVITY_COIN: async (item, draft) => {
        draft.inventory[item.id] = (draft.inventory[item.id] || 0) + item.count;
      },
      DIAMOND: async (item, draft) => {
        draft.status.androidDiamond += item.count;
      },
      DIAMOND_SHD: async (item, draft) => {
        draft.status.diamondShard += item.count;
      },
      HGG_SHD: async (item, draft) => {
        draft.status.hggShard += item.count;
      },
      LGG_SHD: async (item, draft) => {
        draft.status.lggShard += item.count;
      },
      FURN: async (item, draft) => {
        if (draft.building.furniture[item.id]) {
          draft.building.furniture[item.id].count += item.count;
        } else {
          draft.building.furniture[item.id] = {
            count: item.count,
            inUse: 0,
          };
        }
        draft.building.solution.furnitureTs[item.id] = now();
        // 修复：BuildingGotFurnitureThemeCount 勋章事件从未 emit → 家具主题勋章
        // 永不推进；按持有家具去重主题数下发
        const themes = new Set<string>();
        for (const furnId of Object.keys(draft.building.furniture)) {
          const themeId = getFurnitureThemeId(furnId);
          if (themeId) themes.add(themeId);
        }
        await this._trigger.emit("BuildingGotFurnitureThemeCount", [
          { count: themes.size },
        ]);
      },
      AP_GAMEPLAY: async (item, draft) => {
        const addAp = Math.floor((now() - draft.status.lastApAddTime) / 360);
        if (draft.status.ap < draft.status.maxAp) {
          if (draft.status.ap + addAp >= draft.status.maxAp) {
            draft.status.ap = draft.status.maxAp;
          } else if (addAp > 0) {
            draft.status.ap += addAp;
          }
        }
        draft.status.ap += item.count;
        draft.status.lastApAddTime = now();
      },
      AP_BASE: async () => {},
      SOCIAL_PT: async (item, draft) => {
        draft.status.socialPoint += item.count;
      },
      CHAR_SKIN: async (item, draft) => {
        draft.skin.characterSkins[item.id] = 1;
        draft.skin.skinTs[item.id] = now();
      },
      TKT_GACHA_10: async (item, draft) => {
        draft.status.tenGachaTicket += item.count;
      },
      TKT_GACHA_PRSV: async (item, draft) => {
        draft.inventory[item.id] = (draft.inventory[item.id] || 0) + item.count;
      },
      AP_ITEM: async () => {},
      AP_SUPPLY: consumableFunc,
      RENAMING_CARD: consumableFunc,
      RENAMING_CARD_2: consumableFunc,
      ET_STAGE: async () => {},
      ACTIVITY_ITEM: async () => {},
      VOUCHER_PICK: consumableFunc,
      VOUCHER_CGACHA: consumableFunc,
      VOUCHER_MGACHA: consumableFunc,
      CRS_SHOP_COIN: async () => {},
      CRS_RUNE_COIN: async () => {},
      LMTGS_COIN: consumableFunc,
      EPGS_COIN: async (item, draft) => {
        draft.inventory[item.id] = (draft.inventory[item.id] || 0) + item.count;
      },
      LIMITED_TKT_GACHA_10: consumableFunc,
      LIMITED_FREE_GACHA: async () => {},
      REP_COIN: async (item, draft) => {
        draft.inventory[item.id] = (draft.inventory[item.id] || 0) + item.count;
      },
      ROGUELIKE: async () => {},
      LINKAGE_TKT_GACHA_10: consumableFunc,
      VOUCHER_ELITE_II_4: consumableFunc,
      VOUCHER_ELITE_II_5: consumableFunc,
      VOUCHER_ELITE_II_6: consumableFunc,
      VOUCHER_SKIN: consumableFunc,
      RETRO_COIN: async () => {},
      PLAYER_AVATAR: async (item, draft) => {
        draft.avatar.avatar_icon[item.id] = {
          ts: now(),
          src: "other",
        };
      },
      UNI_COLLECTION: async () => {},
      VOUCHER_FULL_POTENTIAL: async (item, draft) => {
        draft.inventory[item.id] = (draft.inventory[item.id] || 0) + item.count;
      },
      RL_COIN: async () => {},
      RETURN_CREDIT: async () => {},
      MEDAL: async () => {},
      CHARM: async () => {},
      HOME_BACKGROUND: async (item) => {
        await this._trigger.emit("background:get", [item.id]);
      },
      EXTERMINATION_AGENT: consumableFunc,
      OPTIONAL_VOUCHER_PICK: consumableFunc,
      ACT_CART_COMPONENT: async () => {},
      VOUCHER_LEVELMAX_6: consumableFunc,
      VOUCHER_LEVELMAX_5: consumableFunc,
      VOUCHER_LEVELMAX_4: consumableFunc,
      VOUCHER_SKILL_SPECIALLEVELMAX_6: consumableFunc,
      VOUCHER_SKILL_SPECIALLEVELMAX_5: consumableFunc,
      VOUCHER_SKILL_SPECIALLEVELMAX_4: consumableFunc,
      ACTIVITY_POTENTIAL: consumableFunc,
      ITEM_PACK: consumableFunc,
      SANDBOX: async () => {},
      FAVOR_ADD_ITEM: async () => {},
      CLASSIC_SHD: async (item, draft) => {
        draft.status.classicShard += item.count;
      },
      CLASSIC_TKT_GACHA: async (item, draft) => {
        draft.status.classicGachaTicket += item.count;
      },
      CLASSIC_TKT_GACHA_10: async (item, draft) => {
        draft.status.classicTenGachaTicket += item.count;
      },
      LIMITED_BUFF: async () => {},
      CLASSIC_FES_PICK_TIER_5: async () => {},
      CLASSIC_FES_PICK_TIER_6: async () => {},
      RETURN_PROGRESS: async () => {},
      NEW_PROGRESS: async () => {},
      MCARD_VOUCHER: async () => {},
      MATERIAL_ISSUE_VOUCHER: consumableFunc,
      CRS_SHOP_COIN_V2: async () => {},
      HOME_THEME: async (item) => {
        await this._trigger.emit("homeTheme:get", [item.id]);
      },
      SANDBOX_PERM: async () => {},
      SANDBOX_TOKEN: async () => {},
      TEMPLATE_TRAP: async () => {},
      NAME_CARD_SKIN: async (item, draft) => {
        draft.nameCardStyle.skin.state[item.id] = {
          unlock: true,
          progress: null,
        };
      },
      EXCLUSIVE_TKT_GACHA: consumableFunc,
      EXCLUSIVE_TKT_GACHA_10: consumableFunc,
      MAGAZINE_LEAF: async (item, draft) => {
        // 画廊收集奖励：杂志页入 leafMap（对齐 OBS gallery.leafMap 结构；
        // charSkin 服务端写 null，见生成器 SERVER_FIELD_TYPE_OVERRIDES）
        const gallery = (draft.gallery ??= { leafMap: {} });
        gallery.leafMap ??= {};
        if (!gallery.leafMap[item.id]) {
          gallery.leafMap[item.id] = {
            leafId: item.id,
            charSkin: null,
            decorList: [],
            getTs: now(),
            version: 0,
          };
        }
      },
    };
    callback?.();
    await this._player.update(async (draft) => {
      const fn = funcs[item.type!];
      // 防御：未知物品类型不 500（WARN + 跳过，避免画廊等新奖励类型炸接口）
      if (typeof fn !== "function") {
        logger.warn("inventory", `items:get 未知物品类型 ${item.type}（${item.id}），跳过发放`);
        return;
      }
      await fn(item, draft);
    });
  }
}
