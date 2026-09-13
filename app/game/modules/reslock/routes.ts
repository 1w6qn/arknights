/**
 * 保险库路由模块（薄壳）
 *
 * 客户端「保险库」（ItemRepo 存入/移出）四条端点，路径由反编译 CS
 * Torappu.Network.ServiceCode 实锤：/reslock/{lock,unlock}{Inventory,Consumable}。
 * 领域逻辑（资格校验、存取、计数归零摘除）在 ./reslock，
 * 路由层只做参数校验与增量下发。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import {
  reslockConsumableSchema,
  reslockInventorySchema,
} from "./reslock.schema";
import {
  lockConsumable,
  lockInventory,
  ReslockConsumableArgs,
  ReslockInventoryArgs,
  unlockConsumable,
  unlockInventory,
} from "./reslock";

const router = Router();

/**
 * 存入保险库（库存物品，按数量）
 *
 * @route POST /reslock/lockInventory
 * @param req.body.itemId - 物品 id（须 item_table.canReslock）
 * @param req.body.count - 存入数量（正整数）
 * @returns playerDataDelta（inventory 与 reslock 同批下发）
 */
router.post("/lockInventory", validateBody(reslockInventorySchema), async (req, res) => {
  const player = getPlayer();
  await lockInventory(player, req.body as ReslockInventoryArgs);
  res.send(player.delta);
});

/**
 * 移出保险库（库存物品，按数量）
 *
 * @route POST /reslock/unlockInventory
 * @param req.body.itemId - 物品 id
 * @param req.body.count - 移出数量（正整数）
 * @returns playerDataDelta
 */
router.post("/unlockInventory", validateBody(reslockInventorySchema), async (req, res) => {
  const player = getPlayer();
  await unlockInventory(player, req.body as ReslockInventoryArgs);
  res.send(player.delta);
});

/**
 * 存入保险库（消耗品实例，按数量）
 *
 * @route POST /reslock/lockConsumable
 * @param req.body.instId - 消耗品实例 id
 * @param req.body.itemId - 物品 id（须 item_table.canReslock）
 * @param req.body.count - 存入数量（正整数）
 * @returns playerDataDelta
 */
router.post("/lockConsumable", validateBody(reslockConsumableSchema), async (req, res) => {
  const player = getPlayer();
  await lockConsumable(player, req.body as ReslockConsumableArgs);
  res.send(player.delta);
});

/**
 * 移出保险库（消耗品实例，按数量）
 *
 * @route POST /reslock/unlockConsumable
 * @param req.body.instId - 消耗品实例 id
 * @param req.body.itemId - 物品 id
 * @param req.body.count - 移出数量（正整数）
 * @returns playerDataDelta
 */
router.post("/unlockConsumable", validateBody(reslockConsumableSchema), async (req, res) => {
  const player = getPlayer();
  await unlockConsumable(player, req.body as ReslockConsumableArgs);
  res.send(player.delta);
});

export default router;
