/**
 * 奇象巡展（ARK_HUB）玩法事件入口（私服扩展，2026-08-17）
 *
 * 统一承载 ARK_HUB 玩法的计数更新与事件发射：ARKDUEL 结算、每日物资领取、
 * 生物数据收录、画像收集/发布。任务（8 类 Arkhub 模板，ActivityTable.missionData）
 * 与勋章（巡展印象/珍奇/镀层，medal_table）的进度都监听这些事件——计数写入
 * activity.ARK_HUB.act1arkhub 的私服扩展字段（官服快照无这些字段，客户端不读）。
 *
 * 调用方：网关回调（index.ts 注入 arkhub-gateway-local）、Phase 2 的 ARKDEX/
 * ARKPIXEL 玩法路由。所有函数幂等可重复调用（计数取 max/累加）。
 */
import { PlayerDataManager } from "../../../../kernel/player-data-manager";
import { ItemBundle } from "@excel/excel";
import { logger } from "@utils/logger";
import type { Draft } from "mutative";
import type { PlayerActivity, PlayerDataModel } from "../../../../kernel/playerdata";

/** ARK_HUB 活动 id（activity.basicInfo.act1arkhub） */
export const ARKHUB_ACT_ID = "act1arkhub";

/** 枢纽店 id（templateShop.shop_act1arkhub，币与 ARK_HUB.coin 镜像） */
export const ARKHUB_SHOP_ID = "shop_act1arkhub";

/**
 * 枢纽店货币读写引用（shop_act1arkhub 币 = activity.ARK_HUB.act1arkhub.coin）
 *
 * templateShop 经此消费，不再自行持有 ARK_HUB 存档形状知识（2026-09-13 跨模块收敛）。
 *
 * @param draft - player.update 的 draft
 * @returns 硬币读写引用；枢纽状态未播种返回 null
 */
export function arkhubCoinRef(
  draft: Draft<PlayerDataModel>,
): { coin: number; set: (v: number) => void } | null {
  const hub = draft.activity?.ARK_HUB?.act1arkhub;
  return hub ? { coin: hub.coin ?? 0, set: (v: number) => (hub.coin = v) } : null;
}

/**
 * 活动任务奖励的枢纽币同步（官服形状）
 *
 * 领取奖励含 `act1arkhub_token_seal` 时，同步累加 `activity.ARK_HUB.act1arkhub.coin`
 * 与 `tshop.shop_act1arkhub.coin`。mission 主管线、activities/shared 兜底领取统一走此函数
 * （2026-09-13 收敛三处重复实现；interlockRefresh 的无调用方私有副本已删除）。
 *
 * @param draft - player.update 的 draft
 * @param rewards - 本次领取的奖励列表（读 id/count）
 * @returns 是否发生同步
 */
export function arkhubSyncMissionCoin(
  draft: Draft<PlayerDataModel>,
  rewards: ReadonlyArray<{ id: string; count: number }>,
): boolean {
  const seal = rewards.find((r) => r.id === "act1arkhub_token_seal");
  if (!seal?.count) return false;
  const hub = draft.activity?.ARK_HUB?.act1arkhub;
  if (hub) hub.coin = (hub.coin ?? 0) + seal.count;
  const shop = draft.tshop?.[ARKHUB_SHOP_ID];
  if (shop) shop.coin = (shop.coin ?? 0) + seal.count;
  return true;
}

/**
 * ARK_HUB 活动状态（draft.activity.ARK_HUB[actId]）
 *
 * 形状登记在 scripts/playerdata-server-adapt.ts 的 SERVER_OVERRIDE_FIELDS
 * （生成类型 PlayerActivity.ARK_HUB 的条目即本别名），本模块不再需要任何 cast。
 */
export type ArkhubState = NonNullable<NonNullable<PlayerActivity["ARK_HUB"]>[string]>;

/** 每日物资奖励：巡展纪念章 ×100（与网关 HUB_REWARD_MAP daily_task 对齐） */
export const ARKHUB_DAILY_SUPPLY_REWARD: ItemBundle = {
  id: "act1arkhub_token_seal",
  count: 100,
  type: "ACTIVITY_ITEM",
};

/**
 * 奇象拟合对战奖励：胜 15 券 / 负 7 券（攻略 + 官服回合结算上报帧
 * f8fa293a 胜负字段实锤：胜局带胜者 uid、负局仅终局报，见 docs/arkhub-gateway-protocol.md §12）。
 */
export const ARKHUB_DUEL_WIN_REWARD: ItemBundle = {
  id: "act1arkhub_token_seal",
  count: 15,
  type: "ACTIVITY_ITEM",
};

/** 奇象拟合对战失败奖励：7 券（官方：负 7） */
export const ARKHUB_DUEL_LOSE_REWARD: ItemBundle = {
  id: "act1arkhub_token_seal",
  count: 7,
  type: "ACTIVITY_ITEM",
};

/**
 * 网关错误码（反编译 ActArkhubErrorCode 全量还原）。
 * 客户端两条消费链路（反编译实锤）：
 * - 响应 f1 code≠100 → ActArkhubErrorCodeUtil.ShowErrorToast 按码映射 i18n 键弹提示；
 * - 服务端推 NotifyErrorMessageNotify(30009df1){1:error_code} → ON_ERROR_CODE → 同样弹提示。
 * 故业务失败只需回正确错误码，客户端自行显示对应文案。
 */
export const ARKHUB_ERR = {
  OK: 100,
  CREATURE_HAS_DISAPPEARED: 201,
  CREATURE_ALREADY_CAPTURED: 202,
  CREATURE_BAG_FULL: 203,
  CREATURE_DUEL_ROOM_FULL: 204,
  CREATURE_DUEL_FINISHED: 205,
  SERVER_REGISTER_FAILED: 500,
  HUB_SCENE_NOT_EXIST: 501,
  PRIVATE_HALL_IN_CD: 502,
  HALL_FULL: 503,
  HALL_DESTROYED: 504,
  NO_VALID_LINE: 505,
  PRIVATE_HALL_UPPER_LIMIT: 506,
  INTERACT_TARGET_BUSY: 534,
  ITEM_NOT_ENOUGH: 601,
  ITEM_ID_INVALID: 602,
  ITEM_CAN_NOT_USE: 603,
  ITEM_BAG_FULL: 604,
  SHOP_ITEM_NOT_ENOUGH: 605,
  SHOP_ITEM_NOT_FOUND: 606,
  SHOP_EXPIRED: 607,
  NO_EMPTY_CREATURE_POINT: 608,
  MUST_IN_CAPTURE_AREA: 609,
} as const;

/** 读 ARK_HUB 状态（防缺省；非 update 配方内只读用） */
function hubState(player: PlayerDataManager): ArkhubState | undefined {
  return player._playerdata.activity?.ARK_HUB?.[ARKHUB_ACT_ID];
}

/** 自然日键（本地时区；每日物资/每日限次用） */
function dayKey(ts: number): string {
  return new Date(ts).toDateString();
}

/** 发放 token_seal（入背包 + ARK_HUB.coin / tshop.coin 同步，对齐活动任务领取形状） */
async function grantTokenSeal(
  player: PlayerDataManager,
  reward: ItemBundle,
): Promise<void> {
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (hub) hub.coin = (hub.coin ?? 0) + reward.count;
    const shop = draft.tshop?.["shop_act1arkhub"];
    if (shop) shop.coin = (shop.coin ?? 0) + reward.count;
  });
  await player.gainItem.add(reward).handle();
}

/**
 * ARKDUEL 战斗结算（网关回合结算上报帧后调用，同一局已按 battle_id 去重）
 * 累计对战次数（任务 17-19）+ 按胜负发放奖励（WIN 15 / LOSE 7）+ 同步币。
 * @param win - 是否胜利（缺省 true：胜负字段不可解析时保守按胜，不扣玩家）
 */
export async function arkhubOnDuelSettle(
  player: PlayerDataManager,
  win = true,
): Promise<void> {
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    hub.duelCount = (hub.duelCount ?? 0) + 1;
  });
  await grantTokenSeal(player, win ? ARKHUB_DUEL_WIN_REWARD : ARKHUB_DUEL_LOSE_REWARD);
  await player._trigger.emit("ArkhubPassDexBattle", [
    { activityId: ARKHUB_ACT_ID, count: hubState(player)?.duelCount ?? 0 },
  ]);
  logger.info(
    "arkhub",
    `ARKDUEL 结算: ${win ? "WIN(15 券)" : "LOSE(7 券)"} duelCount=${hubState(player)?.duelCount}`,
  );
}

/**
 * 每日物资领取（网关 daily_task 交互领奖后调用）
 * 每日限 1 次（按自然日），累计领取天数（任务 4-8）+ 发放 100 券。
 */
export async function arkhubOnDailySupply(
  player: PlayerDataManager,
): Promise<void> {
  let claimed = false;
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    const today = dayKey(Date.now());
    if (hub.dailySupplyLastDay === today) return; // 今日已领
    hub.dailySupplyLastDay = today;
    hub.dailySupplyDays = (hub.dailySupplyDays ?? 0) + 1;
    claimed = true;
  });
  if (!claimed) {
    logger.debug("arkhub", "每日物资今日已领取，跳过");
    return;
  }
  await grantTokenSeal(player, ARKHUB_DAILY_SUPPLY_REWARD);
  await player._trigger.emit("ArkhubDailyMissionCompleted", [
    { activityId: ARKHUB_ACT_ID, days: hubState(player)?.dailySupplyDays ?? 0 },
  ]);
  logger.info("arkhub", `每日物资领取: dailySupplyDays=${hubState(player)?.dailySupplyDays}`);
}

/**
 * 生物数据收录（ARKDEX 扫描入库后调用）
 * @param count - 已收录生物种类总数（任务 9-11/勋章 02）
 * @param activeCount - 已收录"活动频繁"种类数（任务 12-14）
 * @param alterCount - 已收录亚种数（勋章 025 镀层）
 */
export async function arkhubCreatureCollected(
  player: PlayerDataManager,
  args: { count: number; activeCount: number; alterCount: number },
): Promise<void> {
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    hub.creatureCollected = args.count;
    hub.activeCreatureCollected = args.activeCount;
    hub.alterCollected = args.alterCount;
  });
  await player._trigger.emit("ArkhubCreatureCollection", [
    { activityId: ARKHUB_ACT_ID, count: args.count, collectionKey: "arkhubMissionCollection1" },
  ]);
  await player._trigger.emit("ArkhubCreatureCollection", [
    { activityId: ARKHUB_ACT_ID, count: args.activeCount, collectionKey: "arkhubMissionCollection2" },
  ]);
  await player._trigger.emit("ActivityArkhubCreatureCollect", [
    { activityId: ARKHUB_ACT_ID, count: args.count, collectionKey: "arkhubMissionCollection1" },
  ]);
  await player._trigger.emit("ActivityArkhubAlterCollect", [
    { activityId: ARKHUB_ACT_ID, count: args.count, alterCount: args.alterCount },
  ]);
}

/** 信息素诱引生物扫描（任务 15；Phase 2 ARKDEX 调用） */
export async function arkhubCreatureCaptured(
  player: PlayerDataManager,
): Promise<void> {
  await player._trigger.emit("ArkhubCreatureCaptured", [
    { activityId: ARKHUB_ACT_ID },
  ]);
}

/** 发起生物数据交换（任务 16；Phase 2 交换站调用） */
export async function arkhubCreatureExchange(
  player: PlayerDataManager,
): Promise<void> {
  await player._trigger.emit("ArkhubCreatureExchange", [
    { activityId: ARKHUB_ACT_ID },
  ]);
}

/** 发布画像（任务 20-21；Phase 3 像素持久化调用） */
export async function arkhubPixelPublished(
  player: PlayerDataManager,
  count: number,
): Promise<void> {
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    hub.pixelPublished = count;
  });
  await player._trigger.emit("ArkhubPublishPixelArt", [
    { activityId: ARKHUB_ACT_ID, count },
  ]);
}

/** 收集画像（任务 22-23/勋章 01；Phase 3 像素持久化调用） */
export async function arkhubPixelCollected(
  player: PlayerDataManager,
  count: number,
): Promise<void> {
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    hub.pixelCollected = count;
  });
  await player._trigger.emit("ArkhubCollectPixelArt", [
    { activityId: ARKHUB_ACT_ID, count },
  ]);
  await player._trigger.emit("ActivityArkhubPixelCollect", [
    { activityId: ARKHUB_ACT_ID, count },
  ]);
}

/* ================= 枢纽引导/剧情推进（GuideFlags 渐进，2026-08-19） =================
 *
 * 现状背景：本地网关原先把 GuideFlags 全部初始化为"完成态"（1/2），客户端因此不触发
 * 任何引导对话/剧情（§25.2c 记：GuideFlags 是进度计数——0=未开始/1=播放中/2=完成）。
 * 本节实现"剧情推进"：GuideFlags 持久化到 ARK_HUB（per-player），渐进模式下初始给
 * 未开始态（0），玩家完成引导对话（交互帧 actor）→ 服务端推进 flag → 出展指引任务
 * 1-3（ArkhubMissionCompleted）随之完成。
 *
 * 安全设计：默认仍回退完成态（零风险）；`config.arkhub.guideProgressive=true` 开启
 * 渐进引导（index.ts 注入 + unlockActivity 播种联动）。
 */

/** 枢纽 GuideFlags 全部键（对齐网关 defaultGuideFlags / 官服完成态快照） */
export const ARKHUB_GUIDE_KEYS = [
  "arkhub_login",
  "terminal_guide",
  "capture_catch_guide_01",
  "capture_catch_guide_02",
  "arkdex_battle_guide",
  "pixel_unlock",
  "pixel_unlock_system",
  "area_1_block",
  "area_2_block",
  "area_3_blcok",
  "area_2_guard",
  "area_3_guard",
  "arkdex_mmkabi1",
] as const;
export type ArkhubGuideKey = (typeof ARKHUB_GUIDE_KEYS)[number];

/** 完成态 GuideFlags（对齐网关 defaultGuideFlags/官服完成态快照：进度类=2、布尔类=1） */
export function arkhubCompletedGuideFlags(): Record<string, number> {
  return {
    arkdex_battle_guide: 2,
    area_2_guard: 1,
    area_3_guard: 1,
    terminal_guide: 1,
    area_3_blcok: 1,
    terminal_guide_arkdex: 1,
    arkhub_login: 1,
    arkdex_mmkabi1: 1,
    capture_catch_guide_02: 2,
    pixel_unlock: 1,
    pixel_unlock_system: 1,
    area_2_block: 1,
    area_1_block: 1,
    capture_catch_guide_01: 2,
  };
}

/**
 * 渐进引导初始态（config.arkhub.guideProgressive=true 时首次下发；持久化后走存档值）。
 * 关键引导 flag=0（未开始，客户端播放引导对话），非引导/防卡 flag 保持完成态：
 * - capture_catch_guide_01（夏妮引导）保持 2——对话 actor 未确认，任务 1 播种完成态可领
 * - area_*_block / area_*_guard / arkdex_mmkabi1 保持 1——防区域/场景卡死
 * - capture_catch_guide_02 / arkdex_battle_guide / arkhub_login / terminal_guide / pixel_* = 0
 */
export function arkhubProgressiveGuideFlags(): Record<string, number> {
  return {
    ...arkhubCompletedGuideFlags(),
    arkhub_login: 0,
    terminal_guide: 0,
    capture_catch_guide_02: 0,
    arkdex_battle_guide: 0,
    pixel_unlock: 0,
    pixel_unlock_system: 0,
  };
}

/**
 * 网关状态持久化：状态掩码落盘（重连/重启不丢；官服 PlayerReconnectData.f1=state_mask
 * 即重连恢复状态的服务端数据源）。
 */
export async function arkhubSetStateMask(
  player: PlayerDataManager,
  mask: number,
): Promise<void> {
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (hub) hub.stateMask = Number(mask) || 0;
  });
}

/** 已结算对局去重键上限（防存档无限增长；远超单活动对局量） */
const ARKHUB_SETTLED_DUEL_CAP = 64;

/**
 * 网关状态持久化：已结算对局 battle_id 落盘（BO3 去重键；重连/重启后客户端重报
 * 不会重复发券）——环形保留最近 64 条，幂等（重复键不追加）。
 */
export async function arkhubRecordSettledDuel(
  player: PlayerDataManager,
  battleId: string,
): Promise<void> {
  if (!battleId || battleId === "unknown") return;
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    const list: string[] = Array.isArray(hub.settledDuels) ? hub.settledDuels : [];
    if (list.includes(battleId)) return;
    hub.settledDuels = [...list.slice(-(ARKHUB_SETTLED_DUEL_CAP - 1)), battleId];
  });
}

/**
 * 网关状态持久化：交互领奖一次性记录（防“每次进入都提示/重复领奖”）。
 * claimKey 语义：一次性演员用 actorId；每日演员用 `actorId:自然日`（次日可再领）。
 * 返回 true=首次领取（已记录），false=已领过。
 */
export function arkhubIsRewardClaimed(
  player: PlayerDataManager,
  claimKey: string,
): boolean {
  const claimed = hubState(player)?.claimedRewards;
  return !!(claimed && claimed[claimKey]);
}

/** 记录领奖（与 arkhubIsRewardClaimed 配套；异步落盘，内存标记由调用方同步完成） */
export async function arkhubMarkRewardClaimed(
  player: PlayerDataManager,
  claimKey: string,
): Promise<void> {
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    hub.claimedRewards = hub.claimedRewards ?? {};
    hub.claimedRewards[claimKey] = Date.now();
  });
}

/**
 * 读玩家持久化的网关状态（登录/重连时恢复连接状态用，同步读内存存档）。
 * @returns { stateMask, settledDuels, encounter }——encounter 取自已落盘的
 * activeEncounter（捕捉会话，重连后 GetCaptureInfo/EndCapture 仍可用）。
 */
export function arkhubReadGatewayState(player: PlayerDataManager): {
  stateMask: number;
  settledDuels: string[];
  encounter?: { creatures: number[]; lureNumId?: number };
} {
  const hub = hubState(player);
  const enc = hub?.arkdexState?.activeEncounter;
  const creatures = Array.isArray(enc?.creatures)
    ? enc.creatures
        .map((c) => Number(c?.numId))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  return {
    stateMask: Number(hub?.stateMask ?? 0),
    settledDuels: Array.isArray(hub?.settledDuels) ? hub.settledDuels.map(String) : [],
    ...(creatures.length > 0
      ? {
          encounter: {
            creatures,
            ...(enc?.lureNumId != null ? { lureNumId: Number(enc.lureNumId) } : {}),
          },
        }
      : {}),
  };
}

/**
 * 读玩家 GuideFlags（持久化优先，兼容无 guideFlags 字段的存量存档）。
 * @param progressive - 无持久化时的缺省：true=渐进初始态（未开始，触发引导对话）；
 *                      false=完成态（不触发任何引导，默认零风险）。
 */
export function arkhubResolveGuideFlags(
  player: PlayerDataManager,
  progressive = false,
): Record<string, number> {
  const gf = hubState(player)?.guideFlags;
  if (gf && typeof gf === "object") {
    // 持久化优先；未持久化的引导键按渐进/完成态基线兜底——
    // progressive=true 时用渐进初始态（防卡键外引导=0），避免残留完成态导致新引导对话不触发
    const base = progressive ? arkhubProgressiveGuideFlags() : arkhubCompletedGuideFlags();
    return { ...base, ...(gf as Record<string, number>) };
  }
  return progressive ? arkhubProgressiveGuideFlags() : arkhubCompletedGuideFlags();
}

/**
 * 引导 actor → 推进的 GuideFlags（交互帧 actorId 匹配；值取 max 防回退）。
 * 覆盖完整引导链（arkvent actorTriggerOperations 实锤）：
 * - 夏妮引导①（capture_catch_guide_01，任务 1）：shiane_01（INTERACT 起点/AVG 提交）、
 *   shiane_02b（领奖 ReceiveArkhubReward reward_guide_01）
 * - 捕抓引导②（capture_catch_guide_02，任务 2）：mmkabi_auto（ENTER 起点/StartArkdexCaptureGuideBattle）、
 *   mmkabi_01b（领奖 + 设施解锁：扫描仪/道具箱/数据库）
 * - 终端引导（terminal_guide）：terminal_auto（ENTER）、terminal_02a（INTERACT）
 * - 对决引导（arkdex_battle_guide，任务 3）：bryota_01c（AUTO）
 * - 像素解锁：pixel_unlock
 */
export const ARKHUB_GUIDE_ACTOR_FLAGS: Record<string, Partial<Record<string, number>>> = {
  arkhub_main_shiane_01: { capture_catch_guide_01: 2 },
  arkhub_main_shiane_02b: { capture_catch_guide_01: 2 },
  arkhub_capture1_mmkabi_auto: { capture_catch_guide_02: 2 },
  arkhub_capture1_mmkabi_01b: {
    capture_catch_guide_02: 2,
    pixel_unlock: 1,
    pixel_unlock_system: 1,
  },
  arkhub_main_terminal_auto: { terminal_guide: 2 },
  arkhub_main_terminal_02a: { terminal_guide: 2 },
  arkhub_main_bryota_01c: { arkdex_battle_guide: 2 },
  pixel_unlock: { pixel_unlock: 1 },
  // 进入大厅的"登录/入场引导"（非交互 actor）：本地网关在首次 EnterScene hello 自动完成，
  // 经 arkhubAdvanceGuide 落库为 1，防止渐进模式下每次进入都重复触发该引导对话。
  arkhub_login: { arkhub_login: 1 },
};

/**
 * 推进引导进度（网关交互帧 actor 匹配后调用）
 * 落 ARK_HUB.guideFlags 持久化 + 按推进的 flag 发射 ArkhubMissionCompleted
 * （出展指引任务 1-3 模板监听 args.flag === param[2]）。
 */
export async function arkhubAdvanceGuide(
  player: PlayerDataManager,
  actorId: string,
): Promise<void> {
  const flags = ARKHUB_GUIDE_ACTOR_FLAGS[actorId];
  if (!flags) {
    logger.debug("arkhub", `引导 actor 未映射: ${actorId}`);
    return;
  }
  let changed: string[] = [];
  await player.update(async (draft) => {
    const hub = draft.activity.ARK_HUB?.[ARKHUB_ACT_ID];
    if (!hub) return;
    hub.guideFlags = hub.guideFlags ?? {};
    for (const [key, value] of Object.entries(flags)) {
      const cur = (hub.guideFlags[key] as number) ?? 0;
      if (cur < (value as number)) {
        hub.guideFlags[key] = value;
        changed.push(key);
      }
    }
  });
  if (changed.length === 0) {
    logger.debug("arkhub", `引导 ${actorId} 无新推进（flag 已达成）`);
    return;
  }
  for (const key of changed) {
    await player._trigger.emit("ArkhubMissionCompleted", [
      { activityId: ARKHUB_ACT_ID, flag: key },
    ]);
  }
  logger.info("arkhub", `引导推进 ${actorId}: ${changed.join(",")}`);
}
