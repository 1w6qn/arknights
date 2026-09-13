/**
 * 集成战略（rlv2）分区逻辑：节点移动与战斗进入（移动/创建场景/区域结算/关卡奖励领取）
 *
 * 由 RoguelikeV2Manager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import { RoguelikeV2Manager } from "./logic";
import {
  PlayerRoguelikeV2,
  RoguelikeItemBundle,
  RoguelikeNodePosition,
  TorappuRoguelikeEventType,
} from "./rlv2";
import excel from "@excel/excel";
import { PlayerSquad } from "../../kernel/model";
import { ItemBundle } from "@excel/excel";
import { generateShopGoods, buildShopContent, buyGoods, refreshShop, leaveShop, shopBattleStart, isInShopNode } from "./shop";
import { random } from "@utils/random";

export async function moveAndBattleStart(mgr: RoguelikeV2Manager, args: {
    to: RoguelikeNodePosition;
    stageId: string;
    squad: PlayerSquad;
  }) : Promise<string> {
    await mgr.moveTo(args);
    const nodeId = args.to.x * 100 + args.to.y;
    const stageId =
      mgr._map.zones[mgr._status.cursor.zone].nodes[nodeId].stage!;
    await mgr._trigger.emit("rlv2:battle:start", [stageId]);
    return "";
}

export async function moveTo(mgr: RoguelikeV2Manager, args: { to: RoguelikeNodePosition }) : Promise<void> {
    const theme = mgr.current.game!.theme;
    // 清空上一请求的残留推送（控制器为持久实例）
    mgr._pushMessages = [];
    const detail = excel.RoguelikeTopicTable.details[theme].gameConst;
    const pos = mgr._status.cursor.position;
    mgr._status.state = "PENDING";
    if (pos) {
      const nodeId = pos.x * 100 + pos.y;
      const node = mgr._map.zones[mgr._status.cursor.zone].nodes[nodeId];
      if (node.next.find((n) => n.x === args.to.x && n.y === args.to.y)?.key) {
        await mgr._trigger.emit("rlv2:get:items", [
          [
            {
              id: detail.unlockRouteItemId!,
              count: -detail.unlockRouteItemCount,
            },
          ],
        ]);
      }
    }
    mgr._buff.filterBuffs("overweight_move_cost").forEach((b) => {
      mgr._trigger.emit("rlv2:get:items", [
        [{ id: b.blackboard[0].valueStr!, count: -b.blackboard[1].value! }],
      ]);
    });
    await mgr._trigger.emit("rlv2:move", []);
    mgr._status.trace.push({
      zone: mgr._status.cursor.zone,
      position: args.to,
    });
    const next = mgr._map.findNode(mgr._status.cursor.zone, args.to);
    switch (next.type) {
      case TorappuRoguelikeEventType.INCIDENT: {
        // 不期而遇：从 event_choices 的 enter 场景池随机抽一个，生成 SCENE 事件
        const enterScenes = mgr._data.eventChoices?.[theme]?.enter;
        if (enterScenes) {
          const sceneIds = Object.keys(enterScenes);
          if (sceneIds.length > 0) {
            const sceneId = sceneIds[Math.floor(random() * sceneIds.length)];
            const choicesList = enterScenes[sceneId] || [];
            const choices = choicesList.reduce((acc, cid) => ({ ...acc, [cid]: 1 }), {});
            const choiceAdditional = choicesList.reduce(
              (acc, cid) => ({ ...acc, [cid]: { rewards: [] } }),
              {},
            );
            mgr._status.state = "PENDING";
            mgr._trigger.emit("rlv2:event:create", [
              "SCENE",
              {
                scene: { id: sceneId, choices, choiceAdditional },
                done: false,
                popReport: false,
              },
            ]);
          }
        }
        break;
      }
      case TorappuRoguelikeEventType.SHOP:
      case 4096:
        mgr._status.state = "PENDING";
        mgr._trigger.emit("rlv2:event:create", [
          "BATTLE_SHOP",
          mgr.buildShopContent(theme),
        ]);
        break;
      default: {
        // 非战斗节点效果：按节点类型从官方 choiceScenes 抽 enter 场景，生成 SCENE
        // （REST 安全的角落 / WISH 得偿所愿 / TREASURE 古堡馈赠 / SACRIFICE 失与得 /
        //   ENTERTAINMENT 兴致盎然 / EXPEDITION 先行一步 / UNKNOWN 迷雾重重）
        mgr.createNodeScene(theme, next.type);
        break;
      }
    }
    mgr._status.cursor.position = args.to;
    // 节点到达推送（官服对齐）：rlv2NodeArrive 携节点类型，rlv2NodeChange 携当前 zone 节点列表。
    // 仅 rogue_6（黑流树海）范围内下发；其余主题静默跳过（pushMessage 仅在 rogue_6 累积）。
    if (theme === "rogue_6" && next) {
      const zoneNodes =
        mgr._map.zones[mgr._status.cursor.zone]?.nodes ?? {};
      mgr.pushMessage("rlv2NodeArrive", { nodeType: next.type });
      mgr.pushMessage("rlv2NodeChange", {
        nodeList: Object.keys(zoneNodes),
      });
    }
    // 特勤干员任务：节点通过事件（Rlv2PassNodeSpec）+ 岁兽残识移动消耗烛火（Rlv2SpZoneSteps 近似，
    // 每移动一步计 1 点烛火——后端未实现烛火机制，以步进近似）。
    const rlv2Game = mgr.current.game!;
    const rlv2Ctx = {
      theme: rlv2Game.theme,
      mode: rlv2Game.mode,
      grade: rlv2Game.modeGrade ?? 0,
    };
    await mgr._trigger.emit("Rlv2PassNodeSpec", [
      { ...rlv2Ctx, nodeType: next.type },
    ]);
    // 勋章：Rlv2PassNode（「通过 N 个节点」，unlockParam = [主题, 目标节点数]）
    // 与 Rlv2PassNodeSpec（特勤干员任务）同点触发，载荷带 theme 供主题门控。
    await mgr._trigger.emit("Rlv2PassNode", [
      { theme: rlv2Game.theme, nodeType: next.type },
    ]);
    if (rlv2Game.theme === "rogue_5") {
      await mgr._trigger.emit("Rlv2SpZoneSteps", [
        { ...rlv2Ctx, cost: 1 },
      ]);
    }
}

export function createNodeScene(mgr: RoguelikeV2Manager, theme: string, nodeType: number) : void {
    const prefixes =
      RoguelikeV2Manager.NODE_SCENE_PREFIX[nodeType];
    if (!prefixes) return;
    const detail = excel.RoguelikeTopicTable.details[theme];
    const sceneIds = Object.keys(detail.choiceScenes || {}).filter(
      (id) =>
        id.endsWith("_enter") &&
        prefixes.some((p) => id.includes(`_${p}`)),
    );
    if (sceneIds.length === 0) return;
    const sceneId =
      sceneIds[Math.floor(random() * sceneIds.length)];
    const roNum = theme.slice(-1);
    const prefix = prefixes.find((p) => sceneId.includes(`_${p}`))!;
    const choiceIds = Object.keys(detail.choices || {}).filter(
      (k) =>
        k.startsWith(`choice_ro${roNum}_${prefix}`) && !k.endsWith("_enter"),
    );
    if (choiceIds.length === 0) return;
    const choices = choiceIds.reduce(
      (acc, cid) => ({ ...acc, [cid]: 1 }),
      {},
    );
    const choiceAdditional = choiceIds.reduce(
      (acc, cid) => ({ ...acc, [cid]: { rewards: [] } }),
      {},
    );
    mgr._status.state = "PENDING";
    mgr._trigger.emit("rlv2:event:create", [
      "SCENE",
      {
        scene: { id: sceneId, choices, choiceAdditional },
        done: false,
        popReport: false,
      },
    ]);
}

export async function confirmZoneReward(mgr: RoguelikeV2Manager) : Promise<void> {
    const zoneReward = mgr._status.zoneReward;
    if (zoneReward && Object.keys(zoneReward).length > 0) {
      const items = Object.values(zoneReward).map((r) => ({
        id: r.id,
        count: r.count,
      }));
      await mgr._trigger.emit("rlv2:get:items", [items]);
      mgr._status.zoneReward = undefined;
    }
    mgr._status.state = "WAIT_MOVE";
}

export async function confirmTraderReturn(mgr: RoguelikeV2Manager) : Promise<void> {
    const traderReturn = mgr._status.traderReturn;
    if (traderReturn && Object.keys(traderReturn).length > 0) {
      const items = Object.values(traderReturn).map((r) => ({
        id: r.id,
        count: r.count,
      }));
      await mgr._trigger.emit("rlv2:get:items", [items]);
      mgr._status.traderReturn = undefined;
    }
    mgr._status.state = "WAIT_MOVE";
}

export async function specialZoneLeave(mgr: RoguelikeV2Manager) : Promise<void> {
    mgr._status._pending._pending.length = 0;
    await mgr.checkZoneEnd();
    mgr._status.state = "WAIT_MOVE";
}

export async function battlePassGetReward(mgr: RoguelikeV2Manager, theme: string,
    rewards: string[],) : Promise<{ items: ItemBundle[] }> {
    const milestones = excel.RoguelikeTopicTable.details[theme].milestones;
    if (!mgr.outer[theme]?.bp) return { items: [] };
    const items: ItemBundle[] = [];
    await mgr.update(async (draft) => {
      const bp = draft.outer[theme].bp;
      if (!bp.reward) bp.reward = {};
      for (const rewardId of rewards ?? []) {
        const milestone = milestones.find((m) => m.id === rewardId);
        if (!milestone || bp.reward[rewardId]) continue;
        bp.reward[rewardId] = 1;
        if (milestone.itemCount > 0) {
          items.push({
            type: milestone.itemType,
            id: milestone.itemID,
            count: milestone.itemCount,
          });
        }
      }
    });
    for (const it of items) mgr._player.gainItem.add(it);
    await mgr._player.gainItem.handle();
    return { items };
}

/**
 * 战令直购奖励（客户端 /rlv2/battlePass/buyReward，CS: RoguelikeTopicBattlePassPurchaseRequest）
 *
 * 与 battlePassGetReward 的差别：领奖按里程碑 tokenNum 免费领取；直购是**付费购买**
 * （主题干员等大奖，grandPrizes.bpLevelId 指向对应里程碑）——需从战令点数 `bp.point`
 * 扣除 cost，再发放里程碑奖励并标记已领，响应带 items（CS 响应类同名字段）。
 *
 * 价格取客户端下发的 cost（roguelike_topic_table 无价格表：milestones 仅有 tokenNum、
 * grandPrizes 仅有展示字段），服务端只校验点数余额与重复领取，不校验价格本身。
 * @param mgr - 肉鸽管理器
 * @param theme - 主题 id
 * @param reward - 奖励 id（里程碑 id 或大奖展示 id，如 bp_level_1 / grand_1）
 * @param cost - 客户端声明的战令点数价格
 * @returns 实际发放的物品列表
 */
export async function battlePassBuyReward(mgr: RoguelikeV2Manager, theme: string,
    reward: string, cost: number,) : Promise<{ items: ItemBundle[] }> {
    const detail = excel.RoguelikeTopicTable.details[theme];
    const milestones = detail?.milestones ?? [];
    // reward 既可能是里程碑 id（bp_level_N），也可能是大奖展示 id（grand_N）→ 归一为里程碑 id
    const grandPrize = (detail?.grandPrizes ?? []).find(
      (g) => g.grandPrizeDisplayId === reward,
    );
    const rewardId: string = grandPrize?.bpLevelId ?? reward;
    const milestone = milestones.find((m) => m.id === rewardId);
    if (!milestone) return { items: [] };
    const items: ItemBundle[] = [];
    await mgr.update(async (draft) => {
      const bp = draft.outer[theme]?.bp;
      if (!bp) return;
      if (!bp.reward) bp.reward = {};
      // 已领取不可重复购买；点数不足不扣不发（与领奖的「不满足即跳过」一致）
      if (bp.reward[rewardId]) return;
      if ((bp.point ?? 0) < cost) return;
      bp.point = (bp.point ?? 0) - cost;
      bp.reward[rewardId] = 1;
      if (milestone.itemCount > 0) {
        items.push({
          type: milestone.itemType,
          id: milestone.itemID,
          count: milestone.itemCount,
        });
      }
    });
    for (const it of items) mgr._player.gainItem.add(it);
    await mgr._player.gainItem.handle();
    return { items };
}
