/**
 * 活动路由：arkhub（由 router/activity.ts 拆分而来，实现未改动）
 */
import { Router } from "express";
import { collectRawBody, arkhubFullHost } from "../shared/shared";
import * as ReqSchema from "../shared/activity.schema";

import { getPlayer, getPlayerOptional } from "../../../kernel/http/request-context";
import config from "@core/config/index";
import {
  arkhubPixelPublished,
  arkhubPixelCollected,
} from "./arkhub";
import { parseMultipartForm } from "../../../kernel/util/multipart";
import {
  savePixel,
  loadPixelBytes,
  buildPixelArtResp,
  computeNewCollects,
  consumePixelUploadToken,
  ARKPIXEL_MAX_PUBLISH,
} from "./arkpixel";
import {
  ActCheckinvsSignRequest,
  ActCheckinvsSignResponse,
  AutoConfirmMissionsRequest,
  AutoConfirmMissionsResponse,
  ChangeFestivalCharRequest,
  ChangeFestivalCharResponse,
  ConfirmActivityMissionGroupRequest,
  ConfirmActivityMissionGroupResponse,
  ConfirmActivityMissionListRequest,
  ConfirmActivityMissionListResponse,
  ConfirmActivityMissionRequest,
  ConfirmActivityMissionResponse,
  ExchangeActivityShopItemRequest,
  ExchangeActivityShopItemResponse,
  GetActivityCheckInRewardRequest,
  GetActivityCheckInRewardResponse,
  GetActivityCollectionRewardRequest,
  GetActivityCollectionRewardResponse,
  GetActivityShopInfoRequest,
  GetActivityShopInfoResponse,
  GetChainLogInFinalRewardsRequest,
  GetChainLogInFinalRewardsResponse,
  GetChainLogInRewardRequest,
  GetChainLogInRewardResponse,
  GetCheckInRewardRequest,
  GetCheckInRewardResponse,
  GetOpenServerCheckInRewardRequest,
  GetOpenServerCheckInRewardResponse,
  GetSwitchOnlyRewardRequest,
  GetSwitchOnlyRewardResponse,
  RecycleCharmsRequest,
  RecycleCharmsResponse,
  RewardAllMilestoneRequest,
  RewardAllMilestoneResponse,
  RewardMilestoneRequest,
  RewardMilestoneResponse,
  TryGetCharmFirstRewardRequest,
  TryGetCharmFirstRewardResponse,
  BossRushStartBattleRequest,
  BossRushStartBattleResponse,
  BossRushFinishBattleRequest,
  BossRushFinishBattleResponse,
  BossRushRelicSelectRequest,
  BossRushRelicSelectResponse,
  BossRushRelicUpgradeRequest,
  BossRushRelicUpgradeResponse,
  EnemyDuelBattleStartResponse,
  EnemyDuelCreateTeamRequest,
  EnemyDuelCreateTeamResponse,
  EnemyDuelJoinTeamRequest,
  EnemyDuelJoinTeamResponse,
  EnemyDuelMultiBattleFinishRequest,
  EnemyDuelMultiBattleFinishResponse,
  EnemyDuelMultiBattleStartRequest,
  EnemyDuelQueryMatchRequest,
  EnemyDuelQueryMatchResponse,
  EnemyDuelRankInfo,
  EnemyDuelSingleBattleFinishRequest,
  EnemyDuelSingleBattleFinishResponse,
  EnemyDuelSingleBattleStartRequest,
  EnemyDuelStartMatchRequest,
  EnemyDuelStartMatchResponse,
  Act24sideAlchemyRequest,
  Act24sideAlchemyResponse,
  Act24sideBattleFinishRequest,
  Act24sideBattleFinishResponse,
  Act24sideBattleStartRequest,
  Act24sideBattleStartResponse,
  Act24sideEatRequest,
  Act24sideEatResponse,
  Act24sideGetHuntCollectRewardsRequest,
  Act24sideGetHuntCollectRewardsResponse,
  Act24sideSetToolRequest,
  Act24sideSetToolResponse,
  Act25sideBattleFinishRequest,
  Act25sideBattleFinishResponse,
  Act25sideBattleStartRequest,
  Act25sideBattleStartResponse,
  Act25sideDailyRefreshRequest,
  Act25sideDailyRefreshResponse,
  Act25sideFinishInvestigationRequest,
  Act25sideFinishInvestigationResponse,
  Act25sideHarvestRequest,
  Act25sideHarvestResponse,
  Act25sideInvestigateRequest,
  Act25sideInvestigateResponse,
  Act29sideCommitMelodyRequest,
  Act29sideCommitMelodyResponse,
  Act29sideStartMajorInvestRequest,
  Act29sideStartMajorInvestResponse,
  Act29sideSyncthesizeRequest,
  Act29sideSyncthesizeResponse,
  Act36sideConfirmDexNavRewardRequest,
  Act36sideConfirmDexNavRewardResponse,
  FootballBattleFinishRequest,
  FootballBattleFinishResponse,
  FootballBattleStartRequest,
  FootballBattleStartResponse,
  TrainingGroundBattleFinishRequest,
  TrainingGroundBattleFinishResponse,
  TrainingGroundBattleStartRequest,
  TrainingGroundBattleStartResponse,
  Act13sideDailyMissionCommitRequest,
  Act13sideDailyMissionRandomRequest,
  Act1vhalfidleRequest,
  Act35sideBuyRequest,
  Act35sideCreateRequest,
  Act42sideGetDailyRewardsRequest,
  Act44sideNextStateRequest,
  Act44sideSelectChoiceRequest,
  Act44sideStartGameRequest,
  Act45sideConfirmRequest,
  Act46sideGameRequest,
  Act5d1BuyGoodsRequest,
  ActivityGetRewardRequest,
  ActivityMiniBattleFinishRequest,
  ActivityMiniBattleFinishResponse,
  ActivityMiniBattleStartRequest,
  ActivityMiniBattleStartResponse,
  ActivityStubItemsResponse,
  ActivityStubRequest,
  ActivityStubResponse,
} from "../shared/activity";
import { validateBody } from "../../../kernel/http/validate-body";

const router = Router();
import { handleArkhubenterHall, handleArkhubgetFriendUidList, handleArkhubgetPixelArt, handleArkhubsetSecretary, handleArkhubsetSquad, handleArkhubsyncInfo, handleArkhubreport } from "./logic";


router.post("/arkhub/enterHall", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  res.send(await handleArkhubenterHall(getPlayer(), req.body as ActivityStubRequest));
});

router.post("/arkhub/getFriendUidList", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  res.send(await handleArkhubgetFriendUidList(getPlayer(), req.body as ActivityStubRequest));
});

router.post("/arkhub/savePixelArt", async (req, res) => {
  const player = getPlayer();
  const raw = req.rawBody ?? (await collectRawBody(req));
  let brief: { activityId?: string; token?: string } | undefined;
  let pixelData: Buffer | undefined;
  try {
    const parts = parseMultipartForm(raw, req.headers["content-type"]);
    const jsonPart = parts.get("json");
    const pixelPart = parts.get("pixelData");
    brief = jsonPart ? (JSON.parse(jsonPart.toString("utf-8"))?.brief ?? undefined) : undefined;
    pixelData = pixelPart;
  } catch {
    // 解析失败按无 brief 处理
  }
  if (brief?.activityId !== "act1arkhub" || !pixelData || pixelData.length !== 1728) {
    res.status(400).json({ error: "invalid pixel art payload", ...player.delta });
    return;
  }
  // 发布上限 50 次（攻略）
  const hub = player._playerdata.activity?.ARK_HUB?.act1arkhub;
  if ((hub?.pixelPublished ?? 0) >= ARKPIXEL_MAX_PUBLISH) {
    res.status(400).json({ error: "publish limit reached", ...player.delta });
    return;
  }
  let pixelArtId: number;
  try {
    // token 阶段（网关 RequestPixelArtUploadToken）预分配的 id——客户端上传成功后用该 id
    // 调 getPixelArt 加载画像，落盘必须沿用此 id（否则"上传成功但无法加载"）；消费一次性。
    const pending = consumePixelUploadToken(brief?.token ?? "");
    pixelArtId = savePixel(String(player._playerdata.status?.uid ?? ""), pixelData, pending?.id);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message, ...player.delta });
    return;
  }
  await arkhubPixelPublished(player, (hub?.pixelPublished ?? 0) + 1);
  res.send({ pixelArtId, ...player.delta });
});

router.get("/arkhub/pixel/:id.dat", (req, res) => {
  const bytes = loadPixelBytes(req.params.id);
  if (!bytes) {
    res.status(404).json({ error: "pixel art not found" });
    return;
  }
  res.type("application/octet-stream").send(bytes);
});

router.post("/arkhub/getPixelArt", validateBody(ReqSchema.arkhubGetPixelArtSchema), async (req, res) => {
  res.send(await handleArkhubgetPixelArt(getPlayer(), req.body));
});

router.post("/arkhub/setSecretary", validateBody(ReqSchema.arkhubSetSecretarySchema), async (req, res) => {
  res.send(await handleArkhubsetSecretary(getPlayer(), req.body));
});

router.post("/arkhub/setSquad", validateBody(ReqSchema.arkhubSetSquadSchema), async (req, res) => {
  res.send(await handleArkhubsetSquad(getPlayer(), req.body));
});

router.post("/arkhub/syncInfo", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  res.send(await handleArkhubsyncInfo(getPlayer(), req.body as ActivityStubRequest));
});

router.post("/arkhub/report", validateBody(ReqSchema.activityStubSchema), async (req, res) => {
  res.send(await handleArkhubreport(getPlayer(), req.body as ActivityStubRequest));
});

export default router;
