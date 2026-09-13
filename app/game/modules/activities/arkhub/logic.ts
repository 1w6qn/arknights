/**
 * 活动路由：arkhub（由 router/activity.ts 拆分而来，实现未改动）
 */
import { arkhubFullHost } from "../shared/shared";
import * as ReqSchema from "../shared/activity.schema";

import type { PlayerActivity } from "../../../kernel/playerdata";
import config from "@core/config/index";
import { arkhubPixelCollected } from "./domain/state";
import { buildPixelArtResp, computeNewCollects } from "./domain/pixel";
import { ActivityStubRequest, ActivityStubResponse } from "../shared/activity";

import { PlayerDataManager } from "../../../kernel/PlayerDataManager";

/**
 * arkhub 活动族业务逻辑（建议 11：族包五件套——router 仅路由注册，业务收敛于 logic）
 *
 * 由 router.ts 内联 handler 提取（实现未改动）：每个活动接口一个具名函数，
 * 输入 player + 请求体，返回响应对象（原 res.send 载荷）。
 */

export async function handleArkhubenterHall(player: PlayerDataManager, body: ActivityStubRequest) {
  // 私服模式：本地网关应答器启动后指向本服端口（客户端连本服进空广场），
  // 否则返回官服域名（官服网关不可达/账号凭据无效时客户端无法进入）
  const { isArkhubSessionActive, getArkhubSessionPort } = await import("./session/server");
  const endpoint = isArkhubSessionActive()
    ? String(config.Host).replace(/^https?:\/\//, "")
    : "arkhub-gateway.hypergryph.com";
  // 实际监听端口（本地网关端口被占自动避让后的真实端口；未启动回退配置端口）
  const port = isArkhubSessionActive()
    ? getArkhubSessionPort() || (config.capture?.gatewayPort ?? 30000)
    : 30000;
  return ({
    result: 0,
    endpoint,
    port,
    ...player.delta,
  });
}

export async function handleArkhubgetFriendUidList(player: PlayerDataManager, body: ActivityStubRequest) {
  return ({
    friendUidList: [],
    ...player.delta,
  });
}

/**
 * 方舟枢纽像素画查询请求（arkhubGetPixelArtSchema；服务端只读 pixelArtIds）
 */
interface ArkhubGetPixelArtRequest {
  pixelArtIds?: number[];
}

/** 方舟枢纽设置秘书请求（arkhubSetSecretarySchema） */
interface ArkhubSetSecretaryRequest {
  secretary?: string;
  secretarySkinId?: string;
}

/**
 * 方舟枢纽设置队伍请求（arkhubSetSquadSchema）
 *
 * squads 整段存入 activity.ARK_HUB[actId].squads（不读元素字段）——形状取自
 * playerdata-server-adapt.ts 的 ARK_HUB 登记。
 */
interface ArkhubSetSquadRequest {
  squads?: NonNullable<NonNullable<PlayerActivity["ARK_HUB"]>[string]["squads"]>;
}



export async function handleArkhubgetPixelArt(
  player: PlayerDataManager,
  body: ArkhubGetPixelArtRequest,
) {
  const ids = Array.isArray(body.pixelArtIds) ? body.pixelArtIds : [];
  // 收集计数：非本人发布且未收集过的画像（computeNewCollects 去重）
  const hub = player._playerdata.activity?.ARK_HUB?.act1arkhub;
  const collectedIds: number[] = Array.isArray(hub?.pixelCollectedIds) ? hub.pixelCollectedIds : [];
  const fresh = computeNewCollects(String(player._playerdata.status?.uid ?? ""), ids, collectedIds);
  if (fresh.length > 0) {
    await player.update(async (draft) => {
      const h = draft.activity.ARK_HUB?.act1arkhub;
      if (!h) return;
      h.pixelCollectedIds = [...collectedIds, ...fresh];
    });
    await arkhubPixelCollected(player, collectedIds.length + fresh.length);
  }
  return ({
    pixelArts: buildPixelArtResp(ids, arkhubFullHost()),
    ...player.delta,
  });
}

export async function handleArkhubsetSecretary(
  player: PlayerDataManager,
  body: ArkhubSetSecretaryRequest,
) {
  await player.update(async (draft) => {
    const act = draft.activity;
    if (!act.ARK_HUB) act.ARK_HUB = {};
    const hub = (act.ARK_HUB["act1arkhub"] = act.ARK_HUB["act1arkhub"] ?? {
      coin: 0,
      secretary: "",
      secretarySkinId: "",
      secretarySkinSp: false,
      protectTs: -1,
      squads: [],
      globalBan: false,
    });
    if (body.secretary) hub.secretary = body.secretary;
    if (body.secretarySkinId) hub.secretarySkinId = body.secretarySkinId;
  });
  return (player.delta satisfies ActivityStubResponse);
}

export async function handleArkhubsetSquad(
  player: PlayerDataManager,
  body: ArkhubSetSquadRequest,
) {
  await player.update(async (draft) => {
    const act = draft.activity;
    if (!act.ARK_HUB) act.ARK_HUB = {};
    const hub = (act.ARK_HUB["act1arkhub"] = act.ARK_HUB["act1arkhub"] ?? {
      coin: 0,
      secretary: "",
      secretarySkinId: "",
      secretarySkinSp: false,
      protectTs: -1,
      squads: [],
      globalBan: false,
    });
    if (Array.isArray(body.squads)) hub.squads = body.squads;
  });
  return (player.delta satisfies ActivityStubResponse);
}

export async function handleArkhubsyncInfo(player: PlayerDataManager, body: ActivityStubRequest) {
  // 官服抓包对齐（R-1786877177293-0081）：syncInfo 返回枢纽进度增量
  // {mission.missions.ACTIVITY(1arkhubActivity_* 进度), medal.medals(枢纽勋章),
  //  activity.ARK_HUB.act1arkhub(状态)}——客户端据此刷新枢纽进度页。
  // 用 forcePatch 强制推送（纯读请求不产生 Immer 补丁，直接 res.delta 为空）。
  // 进度真实化（2026-08-17）：不再把未完成任务强制 [{1,1}]——任务模板监听事件
  // 驱动真实进度（播种 value:0/target:N），此处仅防御性保证 progress 为数组。
  const pd = player._playerdata;
  await player.update(async (draft) => {
    const actMissions = draft.mission.missions["ACTIVITY"];
    for (const id of Object.keys(actMissions ?? {})) {
      if (!id.startsWith("1arkhubActivity_")) continue;
      const m = actMissions[id];
      if (m && !Array.isArray(m.progress)) {
        m.progress = [];
      }
    }
  });
  const actMissions = pd.mission.missions["ACTIVITY"] ?? {};
  const hubMissions: Record<string, (typeof actMissions)[string]> = {};
  for (const id of Object.keys(actMissions)) {
    if (id.startsWith("1arkhubActivity_")) hubMissions[id] = actMissions[id];
  }
  player.forcePatch(["mission", "missions", "ACTIVITY"], hubMissions);
  player.forcePatch(["medal", "medals"], pd.medal?.medals ?? {});
  player.forcePatch(["activity", "ARK_HUB"], pd.activity?.ARK_HUB ?? {});
  return (player.delta satisfies ActivityStubResponse);
}

export async function handleArkhubreport(player: PlayerDataManager, body: ActivityStubRequest) {
  return ({ result: 0, ...player.delta });
}

/**
 * 像素画审核（CS: ActArkhubReviewPixelArtRequest { uid, status, items }）
 *
 * 私服仅记录审核动作到 `activity.ARK_HUB.act1arkhub.reviewedPixelArts`，返回空增量。
 * 2026-09-13 自 `user/routes.ts` 迁入（原端点 `/pixelArt/review` 挂在 user 的 rootRouter）。
 *
 * @param player 玩家组合根
 * @returns 空增量响应
 */
export async function handleArkhubReviewPixelArt(player: PlayerDataManager) {
  await player.update(async (draft) => {
    const act = draft.activity;
    if (!act.ARK_HUB) act.ARK_HUB = {};
    const hub = (act.ARK_HUB["act1arkhub"] = act.ARK_HUB["act1arkhub"] ?? {});
    hub.reviewedPixelArts = hub.reviewedPixelArts ?? {};
  });
  return player.delta satisfies ActivityStubResponse;
}

// ===== 顶层辅助函数（由 router.ts 拆分时保留，原样迁移）=====

