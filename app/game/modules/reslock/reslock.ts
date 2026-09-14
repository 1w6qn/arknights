/**
 * 保险库（reslock）业务逻辑
 *
 * 客户端「保险库」= 物品仓库（ItemRepo）的存入/移出：把物品从可用库存移入
 * `user.reslock`，被存入的物品不可使用/消耗（客户端依 reslock 状态置灰按钮），
 * 可随时移出。基建设施（building/vault/*）只是入口 UI，数据与逻辑都在玩家存档。
 *
 * 协议来源（权威，反编译 CS 2.7.71 Torappu.Network.ServiceCode）：
 * - ITEM_REPO_LOCK_INVENTORY    = "/reslock/lockInventory"    ItemRepoReslockInventoryRequest   { itemId, count }
 * - ITEM_REPO_UNLOCK_INVENTORY  = "/reslock/unlockInventory"  ItemRepoResUnlockInventoryRequest { itemId, count }
 * - ITEM_REPO_LOCK_CONSUMABLE   = "/reslock/lockConsumable"   ItemRepoReslockConsumableRequest  { instId, itemId, count }
 * - ITEM_REPO_UNLOCK_CONSUMABLE = "/reslock/unlockConsumable" ItemRepoResUnlockConsumableRequest{ instId, itemId, count }
 * 存档结构：PlayerReslock { inventory: {itemId: count}, consumable: {itemId: {instId: {count, ts}}} }
 *
 * 参考实现：reference/opendoctoratepy-ex-public/server/reslock.py —— **该实现不可用**：
 * 1) app.py 中两条注册写成 `add_url_rile` / `add_url_reul`（拼写错误）→ 路由从未注册；
 * 2) `reslock_data.get(...).get(...) += count` 是 Python 语法错误 → 模块 import 即失败；
 * 3) ODPY 仅覆盖 consumable 两条，缺 inventory 两条（客户端实际 4 条都调）。
 * 故本实现直接按客户端协议重写，并沿用本地 mutative 增量约定（patches → delta，绝对值为准）。
 */
import { Draft } from "mutative";
import { logger } from "@utils/logger";
import { BadRequestError } from "@core/http/errors";
import type { ExcelData } from "../../kernel/excel-port";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { PlayerDataModel, PlayerConsumableItem } from "../../kernel/playerdata";

/** 保险库存取参数（库存物品：按数量计库存） */
export interface ReslockInventoryArgs {
  /** 物品 id */
  itemId: string;
  /** 存取数量（正整数，方向由调用方决定） */
  count: number;
}

/** 保险库存取参数（消耗品：按实例计库存） */
export interface ReslockConsumableArgs extends ReslockInventoryArgs {
  /** 消耗品实例 id（客户端可能下发字符串或数字） */
  instId: string | number;
}

/**
 * 规范化保险库容器（老存档可能缺字段；mutative 草稿内原地补齐）
 *
 * @param draft - 玩家数据草稿
 * @returns 可写的 reslock 容器
 */
function ensureReslock(draft: Draft<PlayerDataModel>) {
  if (!draft.reslock) {
    draft.reslock = { inventory: {}, consumable: {} };
  }
  if (!draft.reslock.inventory) draft.reslock.inventory = {};
  if (!draft.reslock.consumable) draft.reslock.consumable = {};
  return draft.reslock;
}

/**
 * 校验物品是否允许存入保险库
 *
 * 依据 item_table 的 `canReslock`（由客户端 UI 同一字段决定按钮可用性）：
 * 官方仅对「物资补给箱/随机材料箱」等易误用物品开放（本版本 568 件）。
 * 注意不能改用 `reslockStatus`——该字段在当前 excel 数据里存在跨枚举取名缺陷
 * （值 1000 被写成其他枚举的 "HIGH_PRIORITY"，不在 ItemReslockStatus 取值内）。
 *
 * @param excelData - excel 数据端口（player.excel，模块层禁止直连 @excel/excel 单例）
 * @param itemId - 物品 id
 * @throws BadRequestError 物品不存在或标记为不可存入
 */
export function assertReslockable(excelData: ExcelData, itemId: string): void {
  const def = excelData.getItem(itemId);
  if (!def) {
    logger.warn("reslock", `物品不在 item_table，拒绝存入：${itemId}`);
    throw new BadRequestError(`物品不存在：${itemId}`, "RESLOCK_ITEM_UNKNOWN");
  }
  if (!def.canReslock) {
    logger.warn("reslock", `物品不可存入保险库：${itemId}（${def.name ?? ""}）`);
    throw new BadRequestError(
      `该物品不可存入保险库：${itemId}`,
      "RESLOCK_NOT_ALLOWED",
    );
  }
}

/**
 * 存入保险库（库存物品，按数量）
 *
 * @param player - 玩家门面
 * @param args - { itemId, count }
 * @throws BadRequestError 物品不可存入 / 持有不足
 */
export async function lockInventory(
  player: PlayerDataManager,
  args: ReslockInventoryArgs,
): Promise<void> {
  assertReslockable(player.excel, args.itemId);
  await player.update(async (draft) => {
    const reslock = ensureReslock(draft);
    const owned = draft.inventory[args.itemId] ?? 0;
    if (owned < args.count) {
      throw new BadRequestError(
        `物品不足：${args.itemId} 持有 ${owned} < 需要 ${args.count}`,
        "RESLOCK_STOCK_NOT_ENOUGH",
      );
    }
    draft.inventory[args.itemId] = owned - args.count;
    reslock.inventory[args.itemId] = (reslock.inventory[args.itemId] ?? 0) + args.count;
  });
}

/**
 * 移出保险库（库存物品，按数量）
 *
 * 移出不做 canReslock 校验：资格数据随版本变化时，历史存入的物品必须仍能取出。
 *
 * @param player - 玩家门面
 * @param args - { itemId, count }
 * @throws BadRequestError 保险库内持有不足
 */
export async function unlockInventory(
  player: PlayerDataManager,
  args: ReslockInventoryArgs,
): Promise<void> {
  await player.update(async (draft) => {
    const reslock = ensureReslock(draft);
    const locked = reslock.inventory[args.itemId] ?? 0;
    if (locked < args.count) {
      throw new BadRequestError(
        `保险库内物品不足：${args.itemId} 存有 ${locked} < 需要 ${args.count}`,
        "RESLOCK_STOCK_NOT_ENOUGH",
      );
    }
    draft.inventory[args.itemId] = (draft.inventory[args.itemId] ?? 0) + args.count;
    const rest = locked - args.count;
    // 归零即摘除条目：留着 0 计数会让客户端仓库/保险库两侧各显示一个空条目
    if (rest > 0) reslock.inventory[args.itemId] = rest;
    else delete reslock.inventory[args.itemId];
  });
}

/**
 * 归一化消耗品实例键
 *
 * consumable / reslock.consumable 的内层索引签名为 number（JSON 里键为数字字符串），
 * 故统一转数字后索引，避免字符串索引在 noImplicitAny 下报 TS7015。
 * @param instId - 客户端下发的实例 id（字符串或数字）
 * @returns 数字实例键
 * @throws BadRequestError 非有限数字
 */
function normalizeInstId(instId: string | number): number {
  const instKey = Number(instId);
  if (!Number.isFinite(instKey) || !Number.isInteger(instKey)) {
    throw new BadRequestError(
      `消耗品实例 id 非法：${String(instId)}`,
      "RESLOCK_INST_INVALID",
    );
  }
  return instKey;
}

/**
 * 存入保险库（消耗品实例，按数量）
 *
 * consumable 按实例计库存（每个实例带 ts），存入时保留原实例时间戳，移出后不丢获取时间。
 * 实例计数归零时从 `consumable` 摘除（物品整体已搬进保险库）。
 *
 * @param player - 玩家门面
 * @param args - { instId, itemId, count }
 * @throws BadRequestError 物品不可存入 / 实例不存在 / 持有不足
 */
export async function lockConsumable(
  player: PlayerDataManager,
  args: ReslockConsumableArgs,
): Promise<void> {
  assertReslockable(player.excel, args.itemId);
  const instKey = normalizeInstId(args.instId);
  await player.update(async (draft) => {
    const reslock = ensureReslock(draft);
    const bucket = draft.consumable[args.itemId];
    const inst = bucket?.[instKey];
    if (!inst) {
      throw new BadRequestError(
        `消耗品实例不存在：${args.itemId}#${instKey}`,
        "RESLOCK_INST_UNKNOWN",
      );
    }
    const owned = inst.count ?? 0;
    if (owned < args.count) {
      throw new BadRequestError(
        `物品不足：${args.itemId}#${instKey} 持有 ${owned} < 需要 ${args.count}`,
        "RESLOCK_STOCK_NOT_ENOUGH",
      );
    }
    const lockedBucket = (reslock.consumable[args.itemId] ??= {});
    const locked = lockedBucket[instKey];
    if (locked) {
      locked.count = (locked.count ?? 0) + args.count;
    } else {
      lockedBucket[instKey] = {
        count: args.count,
        ts: inst.ts ?? -1,
      } as PlayerConsumableItem;
    }
    const rest = owned - args.count;
    if (rest > 0) {
      inst.count = rest;
    } else {
      delete bucket![instKey];
      if (Object.keys(bucket!).length === 0) delete draft.consumable[args.itemId];
    }
  });
}

/**
 * 移出保险库（消耗品实例，按数量）
 *
 * @param player - 玩家门面
 * @param args - { instId, itemId, count }
 * @throws BadRequestError 保险库内实例不存在 / 存有数量不足
 */
export async function unlockConsumable(
  player: PlayerDataManager,
  args: ReslockConsumableArgs,
): Promise<void> {
  const instKey = normalizeInstId(args.instId);
  await player.update(async (draft) => {
    const reslock = ensureReslock(draft);
    const lockedBucket = reslock.consumable[args.itemId];
    const locked = lockedBucket?.[instKey];
    if (!locked) {
      throw new BadRequestError(
        `保险库内无该实例：${args.itemId}#${instKey}`,
        "RESLOCK_INST_UNKNOWN",
      );
    }
    const lockedCount = locked.count ?? 0;
    if (lockedCount < args.count) {
      throw new BadRequestError(
        `保险库内物品不足：${args.itemId}#${instKey} 存有 ${lockedCount} < 需要 ${args.count}`,
        "RESLOCK_STOCK_NOT_ENOUGH",
      );
    }
    const bucket = (draft.consumable[args.itemId] ??= {});
    const inst = bucket[instKey];
    if (inst) {
      inst.count = (inst.count ?? 0) + args.count;
    } else {
      // 实例已整体移出：按保险库保留的 ts 重建，保持获取时间不丢
      bucket[instKey] = {
        count: args.count,
        ts: locked.ts ?? -1,
      } as PlayerConsumableItem;
    }
    const rest = lockedCount - args.count;
    if (rest > 0) locked.count = rest;
    else {
      delete lockedBucket![instKey];
      if (Object.keys(lockedBucket!).length === 0) {
        delete reslock.consumable[args.itemId];
      }
    }
  });
}

/**
 * 保险库当前存量快照（测试与排障用）
 *
 * @param player - 玩家门面
 * @returns reslock 容器（缺省时返回空结构）
 */
export function reslockSnapshot(player: PlayerDataManager) {
  const reslock = player._playerdata.reslock;
  return {
    inventory: { ...(reslock?.inventory ?? {}) },
    consumable: { ...(reslock?.consumable ?? {}) },
  };
}
