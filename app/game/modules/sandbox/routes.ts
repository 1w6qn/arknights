/**
 * 沙盒路由模块
 * 
 * 处理沙盒模式相关的 HTTP 请求，包括沙盒V2/V3的游戏创建、战斗、基地管理等功能。
 */

import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import { now } from "@utils/time";
import {
  SandboxPermChangeTopicRequest,
  SandboxPermChangeTopicResponse,
  SandboxPermPinTopicRequest,
  SandboxPermPinTopicResponse,
  SandboxV2AlchemyRequest,
  SandboxV2AlchemyResponse,
  SandboxV2BasementUpgradeRequest,
  SandboxV2BasementUpgradeResponse,
  SandboxV2BattleFinishRequest,
  SandboxV2BattleFinishResponse,
  SandboxV2BattleStartRequest,
  SandboxV2BattleStartResponse,
  SandboxV2ChallengeExitRequest,
  SandboxV2ChallengeExitResponse,
  SandboxV2ChallengeSettleRequest,
  SandboxV2ChallengeSettleResponse,
  SandboxV2CookDrinkRequest,
  SandboxV2CookDrinkResponse,
  SandboxV2CookFoodRequest,
  SandboxV2CookFoodResponse,
  SandboxV2ConstructOperationRequest,
  SandboxV2ConstructOperationResponse,
  SandboxV2CraftRequest,
  SandboxV2CraftResponse,
  SandboxV2CreateGameRequest,
  SandboxV2CreateGameResponse,
  SandboxV2DineRequest,
  SandboxV2DineResponse,
  SandboxV2DiscardApRequest,
  SandboxV2DiscardApResponse,
  SandboxV2EventChoiceRequest,
  SandboxV2EventChoiceResponse,
  SandboxV2ExploreModeRequest,
  SandboxV2ExploreModeResponse,
  SandboxV2ExtractRequest,
  SandboxV2ExtractResponse,
  SandboxV2GetChallengeRewardRequest,
  SandboxV2GetChallengeRewardResponse,
  SandboxV2GuideLoadRequest,
  SandboxV2GuideLoadResponse,
  SandboxV2HomeBuildSaveRequest,
  SandboxV2HomeBuildSaveResponse,
  SandboxV2LoadArchiveRequest,
  SandboxV2LoadArchiveResponse,
  SandboxV2MonthBattleFinishRequest,
  SandboxV2MonthBattleFinishResponse,
  SandboxV2MonthBattleStartRequest,
  SandboxV2MonthBattleStartResponse,
  SandboxV2NextDayRequest,
  SandboxV2NextDayResponse,
  SandboxV2RacingBattleFinishRequest,
  SandboxV2RacingBattleFinishResponse,
  SandboxV2RacingBattleStartRequest,
  SandboxV2RacingBattleStartResponse,
  SandboxV2RacingLearnTalentRequest,
  SandboxV2RacingLearnTalentResponse,
  SandboxV2RacingRegisterRequest,
  SandboxV2RacingRegisterResponse,
  SandboxV2RacingReleaseRequest,
  SandboxV2RacingReleaseResponse,
  SandboxV2RacingSaveMarkRequest,
  SandboxV2RacingSaveMarkResponse,
  SandboxV2RemoveSupplyRequest,
  SandboxV2RemoveSupplyResponse,
  SandboxV2RiftCloseRequest,
  SandboxV2RiftCloseResponse,
  SandboxV2RiftCreateRequest,
  SandboxV2RiftCreateResponse,
  SandboxV2RiftSetDifficultyRequest,
  SandboxV2RiftSetDifficultyResponse,
  SandboxV2RiftSetTeamRequest,
  SandboxV2RiftSetTeamResponse,
  SandboxV2RiftSettleRequest,
  SandboxV2RiftSettleResponse,
  SandboxV2ScienceUnlockRequest,
  SandboxV2ScienceUnlockResponse,
  SandboxV2SetSquadRequest,
  SandboxV2SetSquadResponse,
  SandboxV2SetSupplyRequest,
  SandboxV2SetSupplyResponse,
  SandboxV2SettleDayRequest,
  SandboxV2SettleDayResponse,
  SandboxV2SettleGameRequest,
  SandboxV2SettleGameResponse,
  SandboxV2ShopBuyRequest,
  SandboxV2ShopBuyResponse,
  SandboxV2StartChallengeRequest,
  SandboxV2StartChallengeResponse,
  SandboxV2StartMissionRequest,
  SandboxV2StartMissionResponse,
  SandboxV2SwitchModeRequest,
  SandboxV2SwitchModeResponse,
  SandboxV3BaseShopBuyRequest,
  SandboxV3BaseShopBuyResponse,
  SandboxV3BaseShopSellRequest,
  SandboxV3BaseShopSellResponse,
  SandboxV3BattleFinishRequest,
  SandboxV3BattleFinishResponse,
  SandboxV3BattleStartRequest,
  SandboxV3BattleStartResponse,
  SandboxV3BuildSaveRequest,
  SandboxV3BuildSaveResponse,
  SandboxV3ChangeDefendRequest,
  SandboxV3ChangeDefendResponse,
  SandboxV3ChooseBandRequest,
  SandboxV3ChooseBandResponse,
  SandboxV3CreateGameRequest,
  SandboxV3CreateGameResponse,
  SandboxV3DayPassRecruitRequest,
  SandboxV3DayPassRecruitResponse,
  SandboxV3EatFoodRequest,
  SandboxV3EatFoodResponse,
  SandboxV3EnterBaseRequest,
  SandboxV3EnterBaseResponse,
  SandboxV3EventChoiceRequest,
  SandboxV3EventChoiceResponse,
  SandboxV3GetDayPassRecruitListRequest,
  SandboxV3GetDayPassRecruitListResponse,
  SandboxV3GiveUpGameRequest,
  SandboxV3GiveUpGameResponse,
  SandboxV3HarvestRequest,
  SandboxV3HarvestResponse,
  SandboxV3HomeUpgradeRequest,
  SandboxV3HomeUpgradeResponse,
  SandboxV3InitRecruitRequest,
  SandboxV3InitRecruitResponse,
  SandboxV3NextDayRequest,
  SandboxV3NextDayResponse,
  SandboxV3RefreshHarvestRequest,
  SandboxV3RefreshHarvestResponse,
  SandboxV3SettleGameRequest,
  SandboxV3SettleGameResponse,
  SandboxV3ShopBuyRecruitRequest,
  SandboxV3ShopBuyRecruitResponse,
  SandboxV3ShopBuyRequest,
  SandboxV3ShopBuyResponse,
  SandboxV3ShopRefreshRequest,
  SandboxV3ShopRefreshResponse,
  SandboxV3ShopSellRequest,
  SandboxV3ShopSellResponse,
  SandboxV3SwitchModeRequest,
  SandboxV3SwitchModeResponse,
  SandboxV3UnlockTechRequest,
  SandboxV3UnlockTechResponse,
} from "./sandbox";
import * as ReqSchema from "./sandbox.schema";
import { validateBody } from "@core/http/validate-body";

const router = Router();

/**
 * 切换主题
 * @route POST /sandbox/changeTopic
 * @returns 玩家增量数据和结果
 */
router.post("/changeTopic", validateBody(ReqSchema.changeTopicSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxPermChangeTopicRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
    result: 0,
  } satisfies SandboxPermChangeTopicResponse);
});

/**
 * 固定主题
 * @route POST /sandbox/pinTopic
 * @returns 空响应（202）
 */
router.post("/pinTopic", validateBody(ReqSchema.pinTopicSchema), async (req, res) => {
  req.body as SandboxPermPinTopicRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2创建游戏
 * @route POST /sandbox/v2/createGame
 * @returns 玩家增量数据
 */
router.post("/v2/createGame", validateBody(ReqSchema.v2CreateGameSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2CreateGameRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2CreateGameResponse);
});

/**
 * 沙盒V2战斗开始
 * @route POST /sandbox/v2/battleStart
 * @returns 玩家增量数据
 */
router.post("/v2/battleStart", validateBody(ReqSchema.v2BattleStartSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2BattleStartRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2BattleStartResponse);
});

/**
 * 沙盒V2战斗结束
 * @route POST /sandbox/v2/battleFinish
 * @returns 玩家增量数据
 */
router.post("/v2/battleFinish", validateBody(ReqSchema.v2BattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2BattleFinishRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2BattleFinishResponse);
});

/**
 * 沙盒V2进食
 * @route POST /sandbox/v2/eatFood
 * @returns 空响应（202）
 */
router.post("/v2/eatFood", validateBody(ReqSchema.v2DineSchema), async (req, res) => {
  req.body as SandboxV2DineRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2烹饪饮品
 * @route POST /sandbox/v2/cookDrink
 * @returns 空响应（202）
 */
router.post("/v2/cookDrink", validateBody(ReqSchema.v2CookDrinkSchema), async (req, res) => {
  req.body as SandboxV2CookDrinkRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2烹饪食物
 * @route POST /sandbox/v2/cookFood
 * @returns 空响应（202）
 */
router.post("/v2/cookFood", validateBody(ReqSchema.v2CookFoodSchema), async (req, res) => {
  req.body as SandboxV2CookFoodRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2设置编队
 * @route POST /sandbox/v2/setSquad
 * @returns 玩家增量数据
 */
router.post("/v2/setSquad", validateBody(ReqSchema.v2SetSquadSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2SetSquadRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2SetSquadResponse);
});

/**
 * 沙盒V2结算游戏
 * @route POST /sandbox/v2/settleGame
 * @returns 玩家增量数据
 */
router.post("/v2/settleGame", validateBody(ReqSchema.v2SettleGameSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2SettleGameRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2SettleGameResponse);
});

/**
 * 沙盒V2基地建造保存
 * @route POST /sandbox/v2/homeBuildSave
 * @returns 玩家增量数据
 */
router.post("/v2/homeBuildSave", validateBody(ReqSchema.v2HomeBuildSaveSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2HomeBuildSaveRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2HomeBuildSaveResponse);
});

/**
 * 沙盒V2月度战斗开始
 * @route POST /sandbox/v2/monthBattleStart
 * @returns 玩家增量数据
 */
router.post("/v2/monthBattleStart", validateBody(ReqSchema.v2MonthBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2MonthBattleStartRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2MonthBattleStartResponse);
});

/**
 * 沙盒V2月度战斗结束
 * @route POST /sandbox/v2/monthBattleFinish
 * @returns 玩家增量数据
 */
router.post("/v2/monthBattleFinish", validateBody(ReqSchema.v2MonthBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2MonthBattleFinishRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2MonthBattleFinishResponse);
});

/**
 * 沙盒V2探索模式
 * @route POST /sandbox/v2/exploreMode
 * @returns 玩家增量数据
 */
router.post("/v2/exploreMode", validateBody(ReqSchema.v2ExploreModeSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2ExploreModeRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2ExploreModeResponse);
});

/**
 * 沙盒V2事件选择
 * @route POST /sandbox/v2/eventChoice
 * @returns 玩家增量数据
 */
router.post("/v2/eventChoice", validateBody(ReqSchema.v2EventChoiceSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV2EventChoiceRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV2EventChoiceResponse);
});

/**
 * 沙盒V2炼金术
 * @route POST /sandbox/v2/alchemy
 * @returns 空响应（202）
 */
router.post("/v2/alchemy", validateBody(ReqSchema.v2AlchemySchema), async (req, res) => {
  req.body as SandboxV2AlchemyRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2基地升级
 * @route POST /sandbox/v2/baseUpgrade
 * @returns 空响应（202）
 */
router.post("/v2/baseUpgrade", validateBody(ReqSchema.v2BaseUpgradeSchema), async (req, res) => {
  req.body as SandboxV2BasementUpgradeRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2建造
 * @route POST /sandbox/v2/build
 * @returns 空响应（202）
 */
router.post("/v2/build", validateBody(ReqSchema.v2BuildSchema), async (req, res) => {
  req.body as SandboxV2ConstructOperationRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2烹饪
 * @route POST /sandbox/v2/cook
 * @returns 空响应（202）
 */
router.post("/v2/cook", validateBody(ReqSchema.v2CookSchema), async (req, res) => {
  req.body as SandboxV2CraftRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2放弃行动点
 * @route POST /sandbox/v2/discardAp
 * @returns 空响应（202）
 */
router.post("/v2/discardAp", validateBody(ReqSchema.v2DiscardApSchema), async (req, res) => {
  req.body as SandboxV2DiscardApRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2进入挑战
 * @route POST /sandbox/v2/enterChallenge
 * @returns 空响应（202）
 */
router.post("/v2/enterChallenge", validateBody(ReqSchema.v2EnterChallengeSchema), async (req, res) => {
  req.body as SandboxV2StartChallengeRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2退出挑战
 * @route POST /sandbox/v2/exitChallenge
 * @returns 空响应（202）
 */
router.post("/v2/exitChallenge", validateBody(ReqSchema.v2ExitChallengeSchema), async (req, res) => {
  req.body as SandboxV2ChallengeExitRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2提取
 * @route POST /sandbox/v2/extract
 * @returns 空响应（202）
 */
router.post("/v2/extract", validateBody(ReqSchema.v2ExtractSchema), async (req, res) => {
  req.body as SandboxV2ExtractRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2获取挑战奖励
 * @route POST /sandbox/v2/getChallengeReward
 * @returns 空响应（202）
 */
router.post("/v2/getChallengeReward", validateBody(ReqSchema.v2GetChallengeRewardSchema), async (req, res) => {
  req.body as SandboxV2GetChallengeRewardRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2引导加载
 * @route POST /sandbox/v2/guideLoad
 * @returns 空响应（202）
 */
router.post("/v2/guideLoad", validateBody(ReqSchema.v2GuideLoadSchema), async (req, res) => {
  req.body as SandboxV2GuideLoadRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2加载
 * @route POST /sandbox/v2/load
 * @returns 空响应（202）
 */
router.post("/v2/load", validateBody(ReqSchema.v2LoadSchema), async (req, res) => {
  req.body as SandboxV2LoadArchiveRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2进入下一天
 * @route POST /sandbox/v2/nextDay
 * @returns 空响应（202）
 */
router.post("/v2/nextDay", validateBody(ReqSchema.v2NextDaySchema), async (req, res) => {
  req.body as SandboxV2NextDayRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2移除补给
 * @route POST /sandbox/v2/removeSupply
 * @returns 空响应（202）
 */
router.post("/v2/removeSupply", validateBody(ReqSchema.v2RemoveSupplySchema), async (req, res) => {
  req.body as SandboxV2RemoveSupplyRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2裂隙关闭
 * @route POST /sandbox/v2/riftClose
 * @returns 空响应（202）
 */
router.post("/v2/riftClose", validateBody(ReqSchema.v2RiftCloseSchema), async (req, res) => {
  req.body as SandboxV2RiftCloseRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2裂隙创建
 * @route POST /sandbox/v2/riftCreate
 * @returns 空响应（202）
 */
router.post("/v2/riftCreate", validateBody(ReqSchema.v2RiftCreateSchema), async (req, res) => {
  req.body as SandboxV2RiftCreateRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2裂隙设置难度
 * @route POST /sandbox/v2/riftSetDifficulty
 * @returns 空响应（202）
 */
router.post("/v2/riftSetDifficulty", validateBody(ReqSchema.v2RiftSetDifficultySchema), async (req, res) => {
  req.body as SandboxV2RiftSetDifficultyRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2裂隙设置队伍
 * @route POST /sandbox/v2/riftSetTeam
 * @returns 空响应（202）
 */
router.post("/v2/riftSetTeam", validateBody(ReqSchema.v2RiftSetTeamSchema), async (req, res) => {
  req.body as SandboxV2RiftSetTeamRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2裂隙结算
 * @route POST /sandbox/v2/riftSettle
 * @returns 空响应（202）
 */
router.post("/v2/riftSettle", validateBody(ReqSchema.v2RiftSettleSchema), async (req, res) => {
  req.body as SandboxV2RiftSettleRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2设置补给
 * @route POST /sandbox/v2/setSupply
 * @returns 空响应（202）
 */
router.post("/v2/setSupply", validateBody(ReqSchema.v2SetSupplySchema), async (req, res) => {
  req.body as SandboxV2SetSupplyRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2结算挑战
 * @route POST /sandbox/v2/settleChallenge
 * @returns 空响应（202）
 */
router.post("/v2/settleChallenge", validateBody(ReqSchema.v2SettleChallengeSchema), async (req, res) => {
  req.body as SandboxV2ChallengeSettleRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2结算天数
 * @route POST /sandbox/v2/settleDay
 * @returns 空响应（202）
 */
router.post("/v2/settleDay", validateBody(ReqSchema.v2SettleDaySchema), async (req, res) => {
  req.body as SandboxV2SettleDayRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2商店购买
 * @route POST /sandbox/v2/shopBuy
 * @returns 空响应（202）
 */
router.post("/v2/shopBuy", validateBody(ReqSchema.v2ShopBuySchema), async (req, res) => {
  req.body as SandboxV2ShopBuyRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2开始任务
 * @route POST /sandbox/v2/startMission
 * @returns 空响应（202）
 */
router.post("/v2/startMission", validateBody(ReqSchema.v2StartMissionSchema), async (req, res) => {
  req.body as SandboxV2StartMissionRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2切换模式
 * @route POST /sandbox/v2/switchMode
 * @returns 空响应（202）
 */
router.post("/v2/switchMode", validateBody(ReqSchema.v2SwitchModeSchema), async (req, res) => {
  req.body as SandboxV2SwitchModeRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V2解锁科技
 * @route POST /sandbox/v2/unlockTech
 * @returns 空响应（202）
 */
router.post("/v2/unlockTech", validateBody(ReqSchema.v2UnlockTechSchema), async (req, res) => {
  req.body as SandboxV2ScienceUnlockRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3切换模式
 * @route POST /sandbox/v3/switchMode
 * @returns 玩家增量数据
 */
router.post("/v3/switchMode", validateBody(ReqSchema.v3SwitchModeSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV3SwitchModeRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV3SwitchModeResponse);
});

/**
 * 沙盒V3生产刷新
 * @route POST /sandbox/v3/productionRefresh
 * @param req.body.topicId - 主题ID
 * @returns 玩家增量数据
 */
router.post("/v3/productionRefresh", validateBody(ReqSchema.v3ProductionRefreshSchema), async (req, res) => {
  const player = getPlayer();
  const { topicId } = req.body as SandboxV3RefreshHarvestRequest;

  res.send({
    playerDataDelta: {
      modified: {
        sandboxPerm: {
          template: {
            SANDBOX_V3: {
              [topicId]: {
                base: {
                  production: {
                    refreshTs: now(),
                  },
                },
              },
            },
          },
        },
      },
      deleted: {},
    },
  } satisfies SandboxV3RefreshHarvestResponse);
});

/**
 * 沙盒V3生产收取
 * @route POST /sandbox/v3/productionHarvest
 * @param req.body.topicId - 主题ID
 * @returns 玩家增量数据
 */
router.post("/v3/productionHarvest", validateBody(ReqSchema.v3ProductionHarvestSchema), async (req, res) => {
  const player = getPlayer();
  const { topicId } = req.body as SandboxV3HarvestRequest;

  res.send({
    playerDataDelta: {
      modified: {
        sandboxPerm: {
          template: {
            SANDBOX_V3: {
              [topicId]: {},
            },
          },
        },
      },
      deleted: {},
    },
  } satisfies SandboxV3HarvestResponse);
});

/**
 * 沙盒V3基地进入
 * @route POST /sandbox/v3/homeEnter
 * @returns 玩家增量数据
 */
router.post("/v3/homeEnter", validateBody(ReqSchema.v3HomeEnterSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV3EnterBaseRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV3EnterBaseResponse);
});

/**
 * 沙盒V3基地商店购买
 * @route POST /sandbox/v3/homeShopBuy
 * @param req.body.topicId - 主题ID
 * @param req.body.goodId - 商品ID
 * @param req.body.count - 数量
 * @returns 玩家增量数据
 */
router.post("/v3/homeShopBuy", validateBody(ReqSchema.v3HomeShopBuySchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV3BaseShopBuyRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV3BaseShopBuyResponse);
});

/**
 * 沙盒V3基地保存
 * @route POST /sandbox/v3/homeSave
 * @param req.body.topicId - 主题ID
 * @param req.body.operation - 操作列表
 * @returns 玩家增量数据
 */
router.post("/v3/homeSave", validateBody(ReqSchema.v3HomeSaveSchema), async (req, res) => {
  const player = getPlayer();
  req.body as SandboxV3BuildSaveRequest;

  res.send({
    playerDataDelta: {
      modified: {},
      deleted: {},
    },
  } satisfies SandboxV3BuildSaveResponse);
});

/**
 * 沙盒V3基地商店出售
 * @route POST /sandbox/v3/homeShopSell
 * @returns 空响应（202）
 */
router.post("/v3/homeShopSell", validateBody(ReqSchema.v3HomeShopSellSchema), async (req, res) => {
  req.body as SandboxV3BaseShopSellRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3基地升级
 * @route POST /sandbox/v3/homeUpgrade
 * @returns 空响应（202）
 */
router.post("/v3/homeUpgrade", validateBody(ReqSchema.v3HomeUpgradeSchema), async (req, res) => {
  req.body as SandboxV3HomeUpgradeRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3创建游戏
 * @route POST /sandbox/v3/createGame
 * @param req.body.topicId - 主题ID
 * @param req.body.nodeId - 节点ID
 * @param req.body.difficultyId - 难度ID
 * @returns 玩家增量数据
 */
router.post("/v3/createGame", validateBody(ReqSchema.v3CreateGameSchema), async (req, res) => {
  const player = getPlayer();
  const { topicId } = req.body as SandboxV3CreateGameRequest;

  res.send({
    playerDataDelta: {
      modified: {
        sandboxPerm: {
          summary: {
            SANDBOX_V3: {
              [topicId]: {
                inCurrent: 1,
                baseLv: 1,
              },
            },
          },
          template: {
            SANDBOX_V3: {
              [topicId]: {
                current: {
                  nodeId: "",
                  state: 0,
                  game: {
                    idx: 21,
                    openTs: now(),
                    difficultyId: "",
                    npcInstId: -1,
                    day: 1,
                    weather: "weather_rain",
                    windDir: "UP",
                    power: 0,
                    pros: 0,
                    aesth: 0,
                  },
                  map: {
                    subStage: [],
                    unlockIndex: [],
                    initIndex: [],
                  },
                  band: {
                    id: "",
                    level: 0,
                  },
                  troop: {},
                  shop: {},
                  dailyReport: null,
                  bag: {},
                  eventInfo: null,
                  effect: {
                    rune: [],
                    shopRefreshDiscount: 10,
                    shopRefreshFree: 0,
                    shopSlotAdd: 0,
                    shopStockAdd: {},
                    shopDiscountRate: 0,
                    gapGainItem: {},
                    recipeRefreshDiscount: 0,
                    productAdd: {},
                    trapDrop: {},
                    buildReturn: {},
                    taskRefreshAdd: 1,
                  },
                  save: null,
                },
              },
            },
          },
        },
      },
      deleted: {},
    },
  } satisfies SandboxV3CreateGameResponse);
});

/**
 * 沙盒V3放弃游戏
 * @route POST /sandbox/v3/giveUpGame
 * @param req.body.topicId - 主题ID
 * @returns 玩家增量数据
 */
router.post("/v3/giveUpGame", validateBody(ReqSchema.v3GiveUpGameSchema), async (req, res) => {
  const player = getPlayer();
  const { topicId } = req.body as SandboxV3GiveUpGameRequest;

  res.send({
    playerDataDelta: {
      modified: {
        sandboxPerm: {
          template: {
            SANDBOX_V3: {
              [topicId]: {
                current: null,
              },
            },
          },
        },
      },
      deleted: {},
    },
  } satisfies SandboxV3GiveUpGameResponse);
});

/**
 * 沙盒V3战斗开始
 * @route POST /sandbox/v3/battleStart
 * @returns 空响应（202）
 */
router.post("/v3/battleStart", validateBody(ReqSchema.v3BattleStartSchema), async (req, res) => {
  req.body as SandboxV3BattleStartRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3战斗结束
 * @route POST /sandbox/v3/battleFinish
 * @returns 空响应（202）
 */
router.post("/v3/battleFinish", validateBody(ReqSchema.v3BattleFinishSchema), async (req, res) => {
  req.body as SandboxV3BattleFinishRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3更改防御
 * @route POST /sandbox/v3/changeDefend
 * @param req.body.topicId - 主题ID
 * @param req.body.zoneId - 区域ID
 * @param req.body.operate - 是否操作
 * @param req.body.chars - 干员列表
 * @returns 玩家增量数据
 */
router.post("/v3/changeDefend", validateBody(ReqSchema.v3ChangeDefendSchema), async (req, res) => {
  const player = getPlayer();
  const { topicId } = req.body as SandboxV3ChangeDefendRequest;

  res.send({
    playerDataDelta: {
      modified: {
        sandboxPerm: {
          template: {
            SANDBOX_V3: {
              [topicId]: {
                map: {},
              },
            },
          },
        },
      },
      deleted: {},
    },
  } satisfies SandboxV3ChangeDefendResponse);
});

/**
 * 沙盒V3选择乐队
 * @route POST /sandbox/v3/chooseBand
 * @returns 空响应（202）
 */
router.post("/v3/chooseBand", validateBody(ReqSchema.v3ChooseBandSchema), async (req, res) => {
  req.body as SandboxV3ChooseBandRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3每日招募
 * @route POST /sandbox/v3/dailyRecruit
 * @returns 空响应（202）
 */
router.post("/v3/dailyRecruit", validateBody(ReqSchema.v3DailyRecruitSchema), async (req, res) => {
  req.body as SandboxV3DayPassRecruitRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3进食
 * @route POST /sandbox/v3/eatFood
 * @returns 空响应（202）
 */
router.post("/v3/eatFood", validateBody(ReqSchema.v3EatFoodSchema), async (req, res) => {
  req.body as SandboxV3EatFoodRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3事件选择
 * @route POST /sandbox/v3/eventChoice
 * @returns 空响应（202）
 */
router.post("/v3/eventChoice", validateBody(ReqSchema.v3EventChoiceSchema), async (req, res) => {
  req.body as SandboxV3EventChoiceRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3获取每日招募列表
 * @route POST /sandbox/v3/getDailyRecruitList
 * @returns 空响应（202）
 */
router.post("/v3/getDailyRecruitList", validateBody(ReqSchema.v3GetDailyRecruitListSchema), async (req, res) => {
  req.body as SandboxV3GetDayPassRecruitListRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3进入下一天
 * @route POST /sandbox/v3/nextDay
 * @returns 空响应（202）
 */
router.post("/v3/nextDay", validateBody(ReqSchema.v3NextDaySchema), async (req, res) => {
  req.body as SandboxV3NextDayRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3初始化招募
 * @route POST /sandbox/v3/initRecruit
 * @returns 空响应（202）
 */
router.post("/v3/initRecruit", validateBody(ReqSchema.v3InitRecruitSchema), async (req, res) => {
  req.body as SandboxV3InitRecruitRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3结算游戏
 * @route POST /sandbox/v3/settleGame
 * @returns 空响应（202）
 */
router.post("/v3/settleGame", validateBody(ReqSchema.v3SettleGameSchema), async (req, res) => {
  req.body as SandboxV3SettleGameRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3商店购买
 * @route POST /sandbox/v3/shopBuy
 * @returns 空响应（202）
 */
router.post("/v3/shopBuy", validateBody(ReqSchema.v3ShopBuySchema), async (req, res) => {
  req.body as SandboxV3ShopBuyRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3商店购买招募
 * @route POST /sandbox/v3/shopBuyRecruit
 * @returns 空响应（202）
 */
router.post("/v3/shopBuyRecruit", validateBody(ReqSchema.v3ShopBuyRecruitSchema), async (req, res) => {
  req.body as SandboxV3ShopBuyRecruitRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3商店刷新
 * @route POST /sandbox/v3/shopRefresh
 * @returns 空响应（202）
 */
router.post("/v3/shopRefresh", validateBody(ReqSchema.v3ShopRefreshSchema), async (req, res) => {
  req.body as SandboxV3ShopRefreshRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3商店出售
 * @route POST /sandbox/v3/shopSell
 * @returns 空响应（202）
 */
router.post("/v3/shopSell", validateBody(ReqSchema.v3ShopSellSchema), async (req, res) => {
  req.body as SandboxV3ShopSellRequest;
  res.sendStatus(202);
});

/**
 * 沙盒V3解锁科技
 * @route POST /sandbox/v3/unlockTech
 * @param req.body.topicId - 主题ID
 * @param req.body.techId - 科技ID
 * @returns 玩家增量数据
 */
router.post("/v3/unlockTech", validateBody(ReqSchema.v3UnlockTechSchema), async (req, res) => {
  const player = getPlayer();
  const { topicId, techId } = req.body as SandboxV3UnlockTechRequest;

  res.send({
    playerDataDelta: {
      modified: {
        sandboxPerm: {
          template: {
            SANDBOX_V3: {
              [topicId]: {
                tech: {},
              },
            },
          },
        },
      },
      deleted: {},
    },
  } satisfies SandboxV3UnlockTechResponse);
});

/**
 * 沙盒竞速战斗结束
 * @route POST /sandbox/racingBattleFinish
 * @returns 空响应（202）
 */
router.post("/racingBattleFinish", validateBody(ReqSchema.racingBattleFinishSchema), async (req, res) => {
  req.body as SandboxV2RacingBattleFinishRequest;
  res.sendStatus(202);
});

/**
 * 沙盒竞速战斗开始
 * @route POST /sandbox/racingBattleStart
 * @returns 空响应（202）
 */
router.post("/racingBattleStart", validateBody(ReqSchema.racingBattleStartSchema), async (req, res) => {
  req.body as SandboxV2RacingBattleStartRequest;
  res.sendStatus(202);
});

/**
 * 沙盒竞速战斗开始/结束（OBS 客户端路径形态，2026-09-13 补别名）
 *
 * OBS `bp_sandboxPerm.py` 声明的路径是 `/sandboxPerm/sandboxV2/racing/battleStart|battleFinish`
 * （经 routes.ts 的 `sandboxPermRewrite` 映射为 router 内 `/v2/racing/battleStart|battleFinish`）；
 * 本模块历史命名为 `/racingBattleStart|Finish`，两者并存以对齐客户端实际调用。
 * @route POST /sandbox/v2/racing/battleStart
 * @returns 空响应（202）
 */
router.post("/v2/racing/battleStart", validateBody(ReqSchema.racingBattleStartSchema), async (req, res) => {
  req.body as SandboxV2RacingBattleStartRequest;
  res.sendStatus(202);
});

/**
 * 沙盒竞速战斗结束（OBS 客户端路径形态）
 * @route POST /sandbox/v2/racing/battleFinish
 * @returns 空响应（202）
 */
router.post("/v2/racing/battleFinish", validateBody(ReqSchema.racingBattleFinishSchema), async (_req, res) => {
  res.sendStatus(202);
});

/**
 * 沙盒竞速学习天赋
 * @route POST /sandbox/racingLearnTalent
 * @returns 空响应（202）
 */
router.post("/racingLearnTalent", validateBody(ReqSchema.racingLearnTalentSchema), async (req, res) => {
  req.body as SandboxV2RacingLearnTalentRequest;
  res.sendStatus(202);
});

/**
 * 沙盒竞速注册
 * @route POST /sandbox/racingRegister
 * @returns 空响应（202）
 */
router.post("/racingRegister", validateBody(ReqSchema.racingRegisterSchema), async (req, res) => {
  req.body as SandboxV2RacingRegisterRequest;
  res.sendStatus(202);
});

/**
 * 沙盒竞速释放
 * @route POST /sandbox/racingRelease
 * @returns 空响应（202）
 */
router.post("/racingRelease", validateBody(ReqSchema.racingReleaseSchema), async (req, res) => {
  req.body as SandboxV2RacingReleaseRequest;
  res.sendStatus(202);
});

/**
 * 沙盒竞速保存标记
 * @route POST /sandbox/racingSaveMark
 * @returns 空响应（202）
 */
router.post("/racingSaveMark", validateBody(ReqSchema.racingSaveMarkSchema), async (req, res) => {
  req.body as SandboxV2RacingSaveMarkRequest;
  res.sendStatus(202);
});

/** 沙盒 V2 竞速小游戏 stub（客户端 /sandboxPerm/sandboxV2/racing/*；参考 ODPY racing 未实现） */
for (const racingRoute of [
  "battleStart",
  "battleFinish",
  "learnTalent",
  "register",
  "release",
  "saveMark",
]) {
  router.post(`/v2/racing/${racingRoute}`, validateBody(ReqSchema.v2RacingStubSchema), async (req, res) => {
    const player = getPlayer();
    res.send(player.delta satisfies { playerDataDelta: unknown });
  });
}

export default router;