/**
 * 剿灭作战（campaignV2）每周经济
 *
 * 官服语义（prts《剿灭作战》/ 官服存档 campaignsV2）：
 * - 每击杀 1 名敌人获得 1 合成玉（DIAMOND_SHD 4003），每周上限 = `campaignTotalFee`（存档 1800）；
 * - `campaignCurrentFee` 为本周已获得量，每周一 04:00 重置；
 * - `instances[stageId].maxKills` 记录该委托的历史最高歼灭数（扫荡/进度奖励据此结算）。
 *
 * 修复（2026-09-09，S6）：原实现 `battleSweep` 不校验任何记录、固定发 1 合成玉且不扣理智，
 * 而 CAMPAIGN 战斗结算只发任务事件——剿灭既无产出又可脚本无限刷合成玉。
 */
import { checkNew } from "@utils/time";
import type { ItemBundle } from "@excel/excel";

import type { Draft } from "mutative";
import type { PlayerDataModel } from "../../kernel/playerdata";

/** 每周上限缺省值（官服存档 campaignTotalFee=1800） */
const DEFAULT_CAMPAIGN_TOTAL_FEE = 1800;

/** campaignsV2 存档结构（仅本模块关心的字段） */
export interface CampaignsV2State {
  campaignCurrentFee?: number;
  campaignTotalFee?: number;
  lastRefreshTs?: number;
  instances?: {
    [stageId: string]: { maxKills?: number; rewardStatus?: number[] } | undefined;
  };
  /** 委托任务状态（missionId → 0 未达成 / 1 待领 / 2 已领） */
  missions?: Record<string, number>;
}

/**
 * 读取服务端存档中生成模型未覆盖的 `campaignsV2` 字段
 *
 * `PlayerDataModel` 由 CS 反编译源生成，不含服务端独有的 `campaignsV2`
 * （登记缺口见 docs/type-system-audit.md §4.2 轮 A / PROGRESS #28）。
 * 本函数是本模块**唯一**的「模型 → 服务端独有字段」断言点：入参接受玩家存档根对象
 * 或其 mutative 草稿，断言目标写成 `入参类型 & { campaignsV2?: … }`（交叉类型与入参
 * 必然重叠，故不需要 `as unknown as`），调用点直接取字段，
 * 不再各自写 `as unknown as { campaignsV2?: never }`。
 * @param root - 玩家存档根对象（`PlayerDataModel`）或其 mutative 草稿
 * @returns `{ campaignsV2 }` 视图（键可缺省：存档惰性建键）
 */
export function campaignsV2View(
  root: PlayerDataModel | Draft<PlayerDataModel>,
): { campaignsV2?: CampaignsV2State } {
  return root as (PlayerDataModel | Draft<PlayerDataModel>) & {
    campaignsV2?: CampaignsV2State;
  };
}

/**
 * 确保 campaignsV2 结构存在并按周重置（每周一 04:00，`checkNew` 内含 4h 偏移）
 * @param draft - mutative 可写草稿（含 campaignsV2 字段）
 * @param ts - 当前时间戳（秒）
 * @returns 规范化后的 campaignsV2 对象
 */
export function ensureCampaignsV2State(
  draft: { campaignsV2?: CampaignsV2State },
  ts: number,
): CampaignsV2State {
  const root = (draft.campaignsV2 = draft.campaignsV2 ?? {});
  root.instances = root.instances ?? {};
  if (typeof root.campaignTotalFee !== "number" || root.campaignTotalFee <= 0) {
    root.campaignTotalFee = DEFAULT_CAMPAIGN_TOTAL_FEE;
  }
  if (typeof root.campaignCurrentFee !== "number") root.campaignCurrentFee = 0;
  if (checkNew(root.lastRefreshTs ?? 0, ts, "week")) {
    root.campaignCurrentFee = 0;
    root.lastRefreshTs = ts;
  }
  return root;
}

/**
 * 结算一次剿灭作战的歼灭数：写 maxKills 并按每周上限累计合成玉
 * @param draft - mutative 可写草稿（含 campaignsV2 字段）
 * @param stageId - 剿灭委托关卡 id（camp_XX）
 * @param killCnt - 本次歼灭数
 * @param ts - 当前时间戳（秒）
 * @returns before/after/gained（合成玉，DIAMOND_SHD）
 */
export function accrueCampaignKills(
  draft: { campaignsV2?: CampaignsV2State },
  stageId: string,
  killCnt: number,
  ts: number,
): { before: number; after: number; gained: number } {
  const root = ensureCampaignsV2State(draft, ts);
  const kills = Math.max(0, Math.floor(killCnt || 0));
  const inst = (root.instances![stageId] = root.instances![stageId] ?? {
    maxKills: 0,
    rewardStatus: [],
  });
  if ((inst.maxKills ?? 0) < kills) inst.maxKills = kills;
  const before = root.campaignCurrentFee ?? 0;
  const capacity = Math.max(0, (root.campaignTotalFee ?? 0) - before);
  const gained = Math.min(kills, capacity);
  root.campaignCurrentFee = before + gained;
  return { before, after: root.campaignCurrentFee, gained };
}

/**
 * 本周剩余可获得的合成玉（扫荡按此封顶）
 * @param draft - mutative 可写草稿（含 campaignsV2 字段）
 * @param ts - 当前时间戳（秒）
 */
export function campaignWeeklyBudget(
  draft: { campaignsV2?: CampaignsV2State },
  ts: number,
): { before: number; total: number; remaining: number } {
  const root = ensureCampaignsV2State(draft, ts);
  const before = root.campaignCurrentFee ?? 0;
  const total = root.campaignTotalFee ?? 0;
  return { before, total, remaining: Math.max(0, total - before) };
}

/**
 * 读取某剿灭委托的历史最高歼灭数（无记录返回 0）
 * @param data - campaignsV2 存档对象
 * @param stageId - 委托关卡 id
 */
export function campaignMaxKills(
  data: CampaignsV2State | undefined,
  stageId: string,
): number {
  return data?.instances?.[stageId]?.maxKills ?? 0;
}
/**
 * 突破奖励档位（campaign_table.campaigns[stageId].breakLadders）
 *
 * `rewards` 直接来自 campaign_table，形状即客户端物品条目（`type` 为物品类型枚举字符串）——
 * 用 {@link ItemBundle} 而非就地宽化的 `{ id; count; type: string }`，使领取结果的 items
 * 可以直接进玩家资源管道 / 应答，调用点不再需要 `as unknown as ItemBundle[]`。
 */
export interface BreakLadder {
  killCnt: number;
  breakFeeAdd?: number;
  rewards?: ItemBundle[];
}

/**
 * 领取剿灭作战「突破奖励」（进度奖励）
 *
 * 官服语义（prts《剿灭作战》/ 官服存档 `instances[stageId].rewardStatus`）：
 * 每个委托有 8 档进度奖励（击杀 100/200/250/300/325/350/375/400），
 * `rewardStatus[index]` 记录该档是否已领（1=已领，0=可领）；
 * 领取需 `maxKills >= breakLadders[index].killCnt`；档位携带 `breakFeeAdd`（额外进度/合成玉）。
 *
 * 修复（2026-09-09，S6）：原 `POST /campaignV2/getBreakReward` 只回 delta（空增量），
 * 突破奖励永不发放且 `rewardStatus` 永不写入 → 剿灭蚀刻章与「获得全部进度奖励」任务双双卡死。
 * @param draft - mutative 可写草稿（含 campaignsV2）
 * @param stageId - 剿灭委托关卡 id（camp_XX）
 * @param indexList - 要领取的档位下标；空数组表示一键领取全部可领档位
 * @param ladders - 该委托的档位表（缺省由调用方从 excel 取）
 * @param ts - 当前时间戳（秒）
 * @returns items（奖励物品）/ feeGain（本次计入的进度，即额外合成玉）/ claimed（本次领取的档位）/ allClaimed（是否已全部领取）
 */
export function claimCampaignBreakRewards(
  draft: { campaignsV2?: CampaignsV2State },
  stageId: string,
  indexList: number[],
  ladders: BreakLadder[],
  ts: number,
): {
  items: ItemBundle[];
  feeGain: number;
  claimed: number[];
  allClaimed: boolean;
} {
  const root = ensureCampaignsV2State(draft, ts);
  const inst = (root.instances![stageId] = root.instances![stageId] ?? {
    maxKills: 0,
    rewardStatus: [],
  });
  const status = (inst.rewardStatus = Array.isArray(inst.rewardStatus)
    ? inst.rewardStatus
    : []);
  // 对齐档位数（官服存档 rewardStatus 长度 = 档位数 = 8）
  while (status.length < ladders.length) status.push(0);
  const maxKills = inst.maxKills ?? 0;
  const wanted =
    indexList.length > 0
      ? indexList
      : ladders
          .map((_, i) => i)
          .filter((i) => maxKills >= (ladders[i]?.killCnt ?? 0));
  const items: ItemBundle[] = [];
  const claimed: number[] = [];
  let feeGain = 0;
  for (const idx of wanted) {
    const ladder = ladders[idx];
    if (!ladder) continue;
    if (status[idx]) continue; // 已领取
    if (maxKills < (ladder.killCnt ?? 0)) continue; // 歼灭数未达标
    status[idx] = 1;
    claimed.push(idx);
    for (const r of ladder.rewards ?? []) {
      items.push({ id: r.id, count: r.count, type: r.type });
    }
    feeGain += ladder.breakFeeAdd ?? 0;
  }
  // breakFeeAdd 计入本周进度（与击杀同源，受每周上限约束）
  let feeAdded = 0;
  if (feeGain > 0) {
    const before = root.campaignCurrentFee ?? 0;
    const remaining = Math.max(0, (root.campaignTotalFee ?? 0) - before);
    feeAdded = Math.min(feeGain, remaining);
    root.campaignCurrentFee = before + feeAdded;
  }
  const allClaimed =
    ladders.length > 0 && ladders.every((_, i) => !!status[i]);
  return { items, feeGain: feeAdded, claimed, allClaimed };
}
/** 委托任务（campaignMissions）配置条目 */
export interface CampaignMissionCfg {
  id: string;
  /** param[0] = 单次作战歼灭数门槛 */
  param?: string[];
  /** 达标奖励（计入本周进度 = 合成玉） */
  breakFeeAdd?: number;
}

/**
 * 刷新剿灭「委托任务」达标状态
 *
 * 官服语义（campaign_table.campaignMissions + 存档 `campaignsV2.missions`）：
 * 4 个委托任务要求「任意一次剿灭委托单次作战达到 N 歼灭数」（N = 200/300/350/400），
 * 存档状态 0/缺省 = 未达成、1 = 达成待领、2 = 已领取。
 *
 * 修复（2026-09-09，S6）：原实现 `getExMissionReward` 恒返回空 delta、`missions` 永不写入，
 * 委托任务奖励（breakFeeAdd 25 进度）与客户端任务列表状态全程为空。
 * @param draft - mutative 可写草稿（含 campaignsV2）
 * @param missions - 委托任务配置表
 * @param ts - 当前时间戳（秒）
 * @returns 本次新达成（0 → 1）的任务 id
 */
export function refreshCampaignMissions(
  draft: { campaignsV2?: CampaignsV2State },
  missions: Record<string, CampaignMissionCfg>,
  ts: number,
): string[] {
  const root = ensureCampaignsV2State(draft, ts);
  const state = (root.missions ??= {});
  const instances = root.instances ?? {};
  // 历史最高单次歼灭数（跨全部委托取最大值）
  const maxKills = Object.values(instances).reduce(
    (acc, inst) => Math.max(acc, inst?.maxKills ?? 0),
    0,
  );
  const achieved: string[] = [];
  for (const cfg of Object.values(missions)) {
    if (!cfg?.id) continue;
    const target = Number(cfg.param?.[0] ?? 0);
    if (target <= 0) continue;
    const current = state[cfg.id] ?? 0;
    if (current !== 0) continue;
    if (maxKills < target) continue;
    state[cfg.id] = 1; // 达成待领
    achieved.push(cfg.id);
  }
  return achieved;
}

/**
 * 领取剿灭「委托任务」奖励
 * @param draft - mutative 可写草稿（含 campaignsV2）
 * @param missionId - 任务 id（exterminateActivity_N）
 * @param missions - 委托任务配置表
 * @param ts - 当前时间戳（秒）
 * @returns ok（是否发放）/ feeGain（计入本周进度的合成玉）
 */
export function claimCampaignMissionReward(
  draft: { campaignsV2?: CampaignsV2State },
  missionId: string,
  missions: Record<string, CampaignMissionCfg>,
  ts: number,
): { ok: boolean; feeGain: number } {
  const cfg = missions[missionId];
  if (!cfg) return { ok: false, feeGain: 0 };
  const root = ensureCampaignsV2State(draft, ts);
  const state = (root.missions ??= {});
  if ((state[missionId] ?? 0) !== 1) return { ok: false, feeGain: 0 };
  state[missionId] = 2; // 已领取
  const fee = cfg.breakFeeAdd ?? 0;
  let gained = 0;
  if (fee > 0) {
    const before = root.campaignCurrentFee ?? 0;
    const remaining = Math.max(0, (root.campaignTotalFee ?? 0) - before);
    gained = Math.min(fee, remaining);
    root.campaignCurrentFee = before + gained;
  }
  return { ok: true, feeGain: gained };
}
