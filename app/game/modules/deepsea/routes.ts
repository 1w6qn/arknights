/**
 * 深海路由模块
 * 
 * 处理深海猎人相关的 HTTP 请求，包括科技树分支选择等功能。
 * 请求/响应类型见 @game/modules/deepsea/deepsea（参考 CS 2.7.61 协议类）。
 */

import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import {
  DeepSeaActiveTechTreeRequest,
  DeepSeaActivateNodeRequest,
  DeepSeaChangeTechBranchRequest,
  DeepSeaChangeTechBranchResponse,
  DeepSeaCompleteStoryRequest,
  DeepSeaDeltaResponse,
  DeepSeaDiscoverPlaceRequest,
  DeepSeaOpenTreasureRequest,
  DeepSeaReadEventRequest,
  DeepSeaReadEventResponse,
  DeepSeaSelectChoiceRequest,
  DeepSeaUnlockTechTreeRequest,
} from "./deepsea";
import { validateBody } from "@core/http/validate-body";
import {
  activateNodeSchema,
  activeTechTreeSchema,
  changeTechBranchSchema,
  completeStorySchema,
  discoverPlaceSchema,
  openTreasureSchema,
  readEventSchema,
  selectChoiceSchema,
  unlockTechTreeSchema,
} from "./deepsea.schema";

const router = Router();

/**
 * 设置深海科技树分支
 * @route POST /deepsea/branch
 * @param req.body.branches - 分支列表
 * @returns 玩家增量数据
 */
router.post("/branch", validateBody(changeTechBranchSchema), async (req, res) => {
  const player = getPlayer();
  const { branches = [] } = req.body as DeepSeaChangeTechBranchRequest;

  const techTrees: { [key: string]: { branch: string; state: number } } = {};
  for (const branch of branches) {
    techTrees[branch.techTreeId] = {
      branch: branch.branchId,
      state: 2,
    };
  }

  // 修复：原实现只返回假 delta 从不落盘（分支选择刷新即回退）——
  // 与其他 deepsea 路由一致，写入玩家数据
  await player.update(async (draft) => {
    const ds = draft.deepSea;
    if (!ds.techTrees) ds.techTrees = {};
    Object.assign(ds.techTrees, techTrees);
  });
  res.send(player.delta satisfies DeepSeaChangeTechBranchResponse);
});

/**
 * 深海事件处理
 * @route POST /deepsea/event
 * @returns 玩家增量数据
 */
router.post("/event", validateBody(readEventSchema), async (req, res) => {
  const player = getPlayer();
  req.body as DeepSeaReadEventRequest;

  res.send({
    playerDataDelta: {
      deleted: {},
      modified: {},
    },
  } satisfies DeepSeaReadEventResponse);
});

// ---- 2026-08-13 补全：CS Torappu.UI.DeepSeaRP 其余 7 条路由（发现地点/节点/剧情/宝藏/科技树/分支选择）----

/** 计数型状态更新（placeId → 计数+1，返回 promise 供路由 await） */
function bumpCount(key: "places" | "nodes" | "stories" | "treasures", placeId: string, player: PlayerDataManager): Promise<void> {
  return player.update(async (draft) => {
    draft.deepSea[key][placeId] = (draft.deepSea[key][placeId] ?? 0) + 1;
  });
}

/**
 * 发现地点
 * @route POST /deepsea/place
 */
router.post("/place", validateBody(discoverPlaceSchema), async (req, res) => {
  const player = getPlayer();
  const { placeId } = req.body as DeepSeaDiscoverPlaceRequest;
  await bumpCount("places", placeId, player);
  res.send(player.delta satisfies DeepSeaDeltaResponse);
});

/**
 * 激活节点
 * @route POST /deepsea/node
 */
router.post("/node", validateBody(activateNodeSchema), async (req, res) => {
  const player = getPlayer();
  const { placeId } = req.body as DeepSeaActivateNodeRequest;
  await bumpCount("nodes", placeId, player);
  res.send(player.delta satisfies DeepSeaDeltaResponse);
});

/**
 * 完成剧情
 * @route POST /deepsea/story
 */
router.post("/story", validateBody(completeStorySchema), async (req, res) => {
  const player = getPlayer();
  const { placeId } = req.body as DeepSeaCompleteStoryRequest;
  await bumpCount("stories", placeId, player);
  res.send(player.delta satisfies DeepSeaDeltaResponse);
});

/**
 * 开启宝藏
 * @route POST /deepsea/treasure
 */
router.post("/treasure", validateBody(openTreasureSchema), async (req, res) => {
  const player = getPlayer();
  const { placeId } = req.body as DeepSeaOpenTreasureRequest;
  await bumpCount("treasures", placeId, player);
  res.send(player.delta satisfies DeepSeaDeltaResponse);
});

/**
 * 解锁科技树节点（placeId 标识节点）
 * @route POST /deepsea/techTreeUnlock
 */
router.post("/techTreeUnlock", validateBody(unlockTechTreeSchema), async (req, res) => {
  const player = getPlayer();
  const { placeId } = req.body as DeepSeaUnlockTechTreeRequest;
  await player.update(async (draft) => {
    draft.deepSea.techTrees[placeId] = { state: 1, branch: "" };
  });
  res.send(player.delta satisfies DeepSeaDeltaResponse);
});

/**
 * 激活科技树（techTreeId 标识树）
 * @route POST /deepsea/techTreeActive
 */
router.post("/techTreeActive", validateBody(activeTechTreeSchema), async (req, res) => {
  const player = getPlayer();
  const { techTreeId } = req.body as DeepSeaActiveTechTreeRequest;
  await player.update(async (draft) => {
    draft.deepSea.techTrees[techTreeId] = {
      state: 2,
      branch: draft.deepSea.techTrees[techTreeId]?.branch ?? "",
    };
  });
  res.send(player.delta satisfies DeepSeaDeltaResponse);
});

/**
 * 选择分支（记录到 choices）
 * @route POST /deepsea/choice
 */
router.post("/choice", validateBody(selectChoiceSchema), async (req, res) => {
  const player = getPlayer();
  const { placeId } = req.body as DeepSeaSelectChoiceRequest;
  await player.update(async (draft) => {
    const list = draft.deepSea.choices[placeId] ?? [];
    list.push(1);
    draft.deepSea.choices[placeId] = list;
  });
  res.send(player.delta satisfies DeepSeaDeltaResponse);
});

export default router;
