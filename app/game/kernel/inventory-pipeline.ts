/**
 * 统一物品变更管道（GainItemPipeline）
 *
 * 对齐 OBS `player_data.gainItem.setTarget(...).handle(player_data)` 的 fluent 形式：
 * 物品增减统一经管道入队、一次执行，替代散落的 `_trigger.emit("items:get"/"items:use")`
 * 直发（建议 4）。执行语义与既有事件完全一致：
 * - `handle()` → emit "items:get"（InventoryManager 串行 gainItem：入账 + 活动币跟踪 +
 *   勋章/任务事件，逐物品）
 * - `use()`   → emit "items:use"（InventoryManager 串行消耗，含 AP 补给等复合行为）
 *
 * 用法：
 * ```ts
 * await player.gainItem
 *   .setTarget("TKT_GACHA", "TKT_GACHA", 1)
 *   .setTarget("4003", "DIAMOND_SHD", 600)
 *   .use();                       // 一次请求内消耗多类物品
 * await player.gainItem.add({ id: "4002", type: "DIAMOND", count: 1 }).handle(); // 发放
 * ```
 */
import type { PlayerDataManager } from "./PlayerDataManager";
import type { TypedEventEmitter } from "./events/runtime";
import { ItemBundle, ItemType } from "@excel/excel";

/**
 * 管道物品条目：ItemBundle + consumable 实例 id
 *
 * `setTarget` 的 instId 供 inventory.ts 消耗路径定位 `consumable[itemId][instId]`
 * 实例（ItemBundle 本身不含该字段；运行时为同一对象，事件订阅方按需读取）。
 */
export interface PipelineItem extends ItemBundle {
  /** consumable 实例 id（仅实例化物品使用） */
  instId?: number;
}

/**
 * 管道入参物品条目（服务端输入形状）
 *
 * 生成类型 `ItemBundle.type` 必填（客户端报文契约），但服务端合法存在「入队时不带 type、
 * 由库存层按 `item_table` 推导后就地回填」的输入（`Excel.makeItem` 的缺省语义，
 * 客户端上报的裸 `{ id, count }`、multipart 上传的 `{ id, count, instId }`）。
 * `GainItemPipeline.add` 以此类型接入参，调用点不再写 `as unknown as ItemBundle`；
 * 队列元素仍是 {@link PipelineItem}，与入参是同一对象引用。
 */
export interface ItemBundleInput {
  /** 物品 id */
  id: string;
  /** 数量（正=获得，负=消耗） */
  count: number;
  /** 物品类型（缺省由库存层按 `item_table` 推导后就地回填） */
  type?: ItemType;
  /** consumable 实例 id（仅实例化物品使用） */
  instId?: number;
}

export class GainItemPipeline {
  private _targets: PipelineItem[] = [];

  constructor(
    private _player: PlayerDataManager,
    private _trigger: TypedEventEmitter,
  ) {}

  /** 已入队的目标（只读，供断言/审计） */
  get targets(): readonly PipelineItem[] {
    return this._targets;
  }

  /**
   * 追加一个发放/消耗目标（fluent）
   * @param itemId - 物品 id（如 "TKT_GACHA" / "4003"）
   * @param itemType - 物品类型（如 "TKT_GACHA" / "DIAMOND_SHD"；缺省由 ItemTable 推断）
   * @param itemCount - 数量（正=获得，负=消耗）
   * @param itemInstId - consumable 实例 id（可选）
   */
  setTarget(
    itemId: string,
    itemType?: string,
    itemCount?: number,
    itemInstId?: number,
  ): this {
    this._targets.push({
      id: itemId,
      type: itemType as ItemType,
      count: itemCount ?? 1,
      instId: itemInstId,
    });
    return this;
  }

  /**
   * 追加一个已组装的物品（fluent）
   * @param bundle - 物品（{@link ItemBundleInput} 形状：type 可缺省，由库存层推导回填）
   */
  add(bundle: ItemBundleInput): this {
    // 入队时 type 缺省是合法语义（inventory 按 item_table 推导后就地回填），而
    // PipelineItem 沿用 ItemBundle 的 type 必填声明——此处是两者之间唯一的收窄点。
    this._targets.push(bundle as PipelineItem);
    return this;
  }

  /** 队列长度（0 时不执行） */
  get size(): number {
    return this._targets.length;
  }

  /** 清空队列（失败重试/复用场景） */
  clear(): this {
    this._targets = [];
    return this;
  }

  /**
   * 执行发放：emit "items:get"（经 InventoryManager 串行 gainItem 全链路）
   */
  async handle(): Promise<void> {
    if (this._targets.length === 0) return;
    await this._trigger.emit("items:get", [this._targets]);
    this._targets = [];
  }

  /**
   * 执行消耗：emit "items:use"（经 InventoryManager 串行消耗）
   */
  async use(): Promise<void> {
    if (this._targets.length === 0) return;
    await this._trigger.emit("items:use", [this._targets]);
    this._targets = [];
  }
}
