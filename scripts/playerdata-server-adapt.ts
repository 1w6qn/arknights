import type { ClassDef } from "./playerdata-parser";
import { applyAdaptOps } from "./types-adapt";

/**
 * 服务端协议适配层
 *
 * 客户端 2.7.61 反编译（Assembly-CSharp.dll）的 PlayerDataModel 与服务端 JSON
 * 序列化协议系统性分叉（服务端用保守旧 key/结构，且是超集，如 PlayerCharacter
 * 的 skin/tmpl 双结构并存）。本模块把生成类型视图从「客户端模型」变换为
 * 「服务端协议」，以 test.json（当前官服服务端数据）为权威校验基准。
 *
 * 三操作（按序应用）：
 * 1. renameFields   —— 客户端字段名 → 服务端 JSON key（如 campaign → campaignsV2）
 * 2. addFields      —— 服务端独有、客户端模型未声明的字段（如 PlayerStage.startTimes）
 * 3. overrideFields —— 字段类型整体替换（结构差异；"[server]" 键表示整接口覆盖为索引签名）
 */

/** 字段改名：接口名 → { 客户端字段名: 服务端 JSON key } */
export const SERVER_RENAME_FIELDS: Record<string, Record<string, string>> = {
  PlayerDataModel: {
    campaign: "campaignsV2",
    arkOdc: "arkodc",
    events: "event",
    playerNameCardStyle: "nameCardStyle",
    PlayerAvatar: "avatar",
    playerHomeBackground: "background",
    playerHomeTheme: "homeTheme",
    playerMainlineRecord: "mainline",
    playerAprilFool: "aprilFool",
    autoChessPerm: "autochessSeason",
    playerSetting: "setting",
  },
  PlayerSocial: {
    yesterdayCrisisSeasonId: "yCrisisSs",
    yesterdayCrisisV2SeasonId: "yCrisisV2Ss",
  },
  PlayerTroop: {
    curCharInstCount: "curCharInstId",
  },
  PlayerMedalBoard: {
    customIndex: "custom",
    templateGroupId: "template",
  },
  PlayerCrisis: {
    currentSeason: "current",
  },
  PlayerCharRotation: {
    currentPresetId: "current",
    presets: "preset",
  },
  PlayerAprilFool: {
    actFun3: "act3fun",
    actFun4: "act4fun",
    actFun5: "act5fun",
    actFun6: "act6fun",
    actFun7: "act7fun",
  },
  PlayerCampaign_StageOpenInfo: {
    rotateGroup: "rGroup",
    trainingGroup: "tGroup",
    trainingAllOpenGroup: "tAllOpen",
  },
  PlayerCheckIn_PlayerNewbiePackage: {
    isOpen: "open",
    checkinFinTs: "finish",
    stopSaleTs: "stopSale",
  },
  PlayerRoguelikeV2_OuterData_Collection: {
    endbook: "endBook",
  },
  PlayerRoguelikeV2_OuterData_PlayerRogueActivity: {
    roguelikeActivitySeedModeDatas: "SEED_MODE", // 服务端 activity 字典键为 SEED_MODE（种子模式活动）
  },
  PlayerActFun6Stage: {
    speedRunning: "speedrunning",
  },
  TowerTactical: {
    pioneer: "PIONEER",
    warrior: "WARRIOR",
    tank: "TANK",
    sniper: "SNIPER",
    caster: "CASTER",
    support: "SUPPORT",
    medic: "MEDIC",
    special: "SPECIAL",
  },
  TowerCurrent_Status: {
    towerId: "tower", // 服务端 key 为 tower（字符串 id）
  },
};

/** 服务端独有字段补充：接口名 → { 字段名: TS 类型 } */
export const SERVER_ADD_FIELDS: Record<string, Record<string, string>> = {
  PlayerDataModel: {
    deleted: "{ [key: string]: object }",
    checkMeta: "{ version: number; ts: number }",
  },
  PlayerStage: {
    startTimes: "number",
    practiceTimes: "number",
  },
  PlayerSpecialStage: {
    type: "string",
    val: "number",
    fts: "number",
    rts: "number",
  },
  PlayerStatus: {
    uid: "string",
    avatarId: "string",
    friendNumLimit: "number",
    tipMonthlyCardExpireTs: "number",
    // 助战信用每日限次（私服字段，客户端模型无）：写入见 modules/battle/battle.ts
    // 的助战结算（使用方 assistUsedDay/Count、被使用方 assistBeUsedDay）
    assistUsedDay: "number",
    assistUsedCount: "number",
    assistBeUsedDay: "number",
    // 单例满配账号生成标记（scripts/generate-max-account.ts 写 resVersion 字符串；
    // 读取见 app/server.ts 的版本比对，避免每次启动重刷满配账号）
    maxAccountResVersion: "string",
  },
  PlayerTroop: {
    charGroup: "{ [key: string]: { favorPoint: number } }",
    // 干员六星里程碑：服务端自建的「按 groupId → rewardId 领取标记」字典
    // （写入见 modules/quest/routes.ts#confirmSixStarReward）
    sixStarReward: "{ [key: string]: { [key: string]: number } }",
  },
  // 说明（2026-09-11）：此处原有第二份 `PlayerCharPatch: { skills: "PlayerSkill[]" }`，
  // 与下方（原 177 行）的线格式内联声明同名——JS 语义「后者胜」，前者静默失效，
  // 且 tsc 因跨行同名字面量报 TS1117。已删除陈旧声明，保留线格式版本
  // （并有 SERVER_FIELD_TYPE_OVERRIDES["PlayerCharPatch.skills"] 兜底）。
  PlayerNpcWithAudio: {
    npcShowAudioInfoFlag: "string",
  },
  PlayerReturnData: {
    current: "object",
  },
  PlayerHandBookAddon_GetInfo: {
    startTimes: "number",
    completeTimes: "number",
    state: "number",
    startTime: "number",
  },
  PlayerMedalBoard: {
    templateMedalList: "string[]",
  },
  PlayerMainlineRecord: {
    version: "number",
    // 语音档案（服务端自建形状，客户端模型无此字段）：{ [topicId]: { isOpen, confirmEnterReward, nodes[nodeId]=1|2 } }
    // 此前登记为 `object`（生成后为两层 ServerPayload），但 nodes 是第三层对象 → 写入侧只
    // 剩 `as any` 一条路（见 modules/user/routes.ts）。此处直接给出精确非递归形状。
    charVoiceRecord:
      "{ [key: string]: { isOpen: boolean; confirmEnterReward: boolean; nodes: { [key: string]: number } } }",
  },
  PlayerAvatar: {
    // 头像图标解锁记录：{ [iconId]: { ts: 解锁时间, src: 来源 } }
    // （写入见 kernel/inventory.ts 的 PLAYER_AVATAR 消耗函数）
    avatar_icon: "{ [key: string]: { ts: number; src: string } }",
  },
  PlayerHomeBackground: {
    selected: "string",
  },
  PlayerHomeTheme: {
    selected: "string",
  },
  PlayerCrisis: {
    lst: "number",
    nst: "number",
    map: "{ [key: string]: { rank: number; confirmed: number } }",
    training: "{ currentStage: string[]; stage: { [key: string]: { point: number } }; nst: number }",
    box: "object[]",
  },
  PlayerCrisisV2: {
    current: "string",
    nst: "number",
  },
  PlayerGacha: {
    double: "object",
  },
  PlayerGacha_PlayerGachaPool: {
    rarity: "number",
  },
  PlayerCharacter: {
    skin: "string",
    defaultSkillIndex: "number",
    // 线格式 char.skills = [{ skillId, unlock, state, specializeLevel, completeUpgradeTime }]
    skills: "{ skillId: string; unlock: number; state: number; specializeLevel: number; completeUpgradeTime: number }[]",
    voiceLan: "string",
    currentEquip: "string",
    equip: "{ [key: string]: PlayerCharEquipInfo }",
    master: "object",
  },
  PlayerCharPatch: {
    skills: "{ skillId: string; unlock: number; state: number; specializeLevel: number; completeUpgradeTime: number }[]",
  },
  PlayerBuildingWorkshopStatus: { bonusActive: "number" },
  PlayerBuildingCharBubble: { ts: "number" },
  PlayerBuildingChar_BubbleContainer: { private: "object" },
  PlayerBuildingChar: { workTime: "number", privateRooms: "string[]" },
  PlayerBuildingRoomSlot: { charInstIds: "number[]" },
  PlayerBuildingControlBuff_Global: { roomCnt: "number" },
  PlayerBuildingControlBuff: {
    manufacture: "object", trading: "object", meeting: "object",
    apCost: "object", point: "object", hire: "object",
    power: "object", dormitory: "object", training: "object",
  },
  PlayerBuildingControl: { lastUpdateTime: "number" },
  PlayerBuildingPowerBuff: { apCost: "object", global: "object", manufacture: "object" },
  PlayerBuildingTradingBuff: {
    apCost: "object", rate: "object", tgw: "object[]", point: "object",
    manuLines: "object", orderBuff: "object[]", violatedInfo: "object",
    orderWtBuff: "object[]", speGoldOrder: "object",
  },
  PlayerBuildingTrading: { completeWorkTime: "number" },
  BuildingBuffDisplay: { base: "number" },
  PlayerBuildingTradingOrder: { delivery: "object", buff: "object" },
  PlayerBuildingWorkshopBuff: { recovery: "object", fFix: "object", activeBonus: "object" },
  PlayerBuildingWorkshop: { statistic: "object" },
  PlayerBuildingMeetingBuff: {
    weight: "object", flag: "object", apCost: "object",
    notOwned: "object", owned: "object",
  },
  PlayerBuildingMeetingClueChar: { skin: "string" },
  PlayerBuildingMeeting: {
    expiredReward: "number", mfc: "number", completeWorkTime: "number",
    startApCounter: "number", mustgetClue: "number",
  },
  PlayerBuildingHireBuff: { meeting: "object", stack: "object", point: "object", apCost: "object" },
  PlayerBuildingTrainingBuff: { lvEx: "object", lvCost: "object", reduce: "object", apCost: "object" },
  PlayerBuildingTrainingReduceTimeBd: { fulltime: "object", reset: "object" },
  PlayerBuildingTraining: { state: "number" },
  BuildingMusicState: { progress: "number" },
  // 其他散点
  PlayerArtMagazineLeafData: { leafId: "string", charSkin: "string", decorList: "string[]" },
  PlayerDexNav: {
    character: "{ [key: string]: { charInstId: number; count: number; classicCount?: number } }",
    // 干员图鉴编队统计：{ [teamKey]: { [charId]: 次数 } }（读法见 modules/dexnav/dexnav.ts）
    teamV2: "{ [key: string]: { [key: string]: number } }",
  },
  PlayerFormulaUnlockRecord: { shop: "object" },
  PlayerCrisisSeason: { permanent: "object", temporary: "object", sInfo: "object" },
  PlayerCrisisV2Season_PermanentMapInfo: {
    state: "number", scoreTotal: "number", rune: "object", challenge: "object",
  },
  PlayerHomeUnlockStatus: { unlock: "boolean" },
  PlayerHomeConditionProgress: { v: "number", t: "number" },
  // rlv2 outer
  PlayerRoguelikeV2_OuterData_Buff: { score: "number" },
  PlayerRoguelikeV2_OuterData_Collection: { chat: "object" },
  PlayerRoguelikeV2_OuterData_Collection_DifficultyUnlockInfo: { progress: "number" },
  PlayerRoguelikeV2_OuterData_MonthTeam: { valid: "boolean" },
  PlayerRoguelikeV2_OuterData_Record: { modeCnt: "number", endingCnt: "number" },
  PlayerRoguelikeV2_OuterData_Challenge: { highScore: "number" },
  PlayerRoguelikeV2_OuterData_Mission_MissionItem: { tmpl: "object" },
  // rlv2 战斗内状态：CS 有 `Properties.RewardHpShowStatus hpShowState`（客户端运行时枚举，
  // 官服报文不含），服务端在 init 写初值 "NORMAL"（modules/roguelike/status.ts）——
  // 硬编码模型 rlv2-model.ts 早已声明该字段，此前不登记导致 `current` / `update` 两处
  // `as unknown as`（2026-09-13 登记）。
  PlayerRoguelikeV2_CurrentData_PlayerStatus_Properties: { hpShowState: "string" },
  PlayerRoguelikeV2_CurrentData: { record: "object" },
  // tower
  TowerCurrent_Status: { strategy: "string" }, // towerId 由 rename 处理；strategy 线格式字符串
  TowerCurrent_TowerGodCard: { id: "string" },
  TowerCurrent_HalftimeRecruit: { count: "number" },
  TowerOuter_TowerData: { unlockHard: "boolean" },
  TowerOuter: { pickedGodCard: "object", squad: "object" },
  TowerCurrent: { reward: "{ high: number; low: number }" }, // 服务端内部战斗奖励计数
  TowerSeason: { passWithGodCard: "object", slots: "object" },
  TowerSeason_TowerSeasonPeriod: { cur: "number", len: "number" },
  // sandboxPerm
  PlayerSandboxPerm_PlayerSandboxTemplateData: { SANDBOX_V2: "object", SANDBOX_V3: "object" },
  PlayerSandboxPerm_PlayerSandboxSummaryData: { SANDBOX_V2: "object", SANDBOX_V3: "object" },
  PlayerRecalRuneStage: { runes: "object" },
  PlayerCampaign: { lastRefreshTs: "number" },
  PlayerCampaign_Stage: { rewardStatus: "number[]" },
  PlayerPerMedal: { val: "number[][]" },
  PlayerRecruit_NormalModel_SlotModel: { tags: "number[]", selectTags: "{ tagId: number; pick: number }[]" },
  PlayerRetro: { lst: "number", nst: "number" },
  PlayerSetting: { perf: "{ lowPower: number }" },
  PlayerCharRotationPreset: { profileInst: "number" },
  PlayerActFun4: { cameraLv: "number", fans: "number" },
  // 房间 buff/结构（线格式具名，抓包标量审计反推）
  PlayerBuildingManufactureBuff: {
    apCost: "{ self: object; all: number }",
    sSpeed: "number",
    tSpeed: "object",
    cSpeed: "number",
    capFrom: "object",
    maxSpeed: "number",
    point: "object",
    flag: "object",
    skillExtend: "{ [key: string]: string[] }",
  },
  PlayerBuildingManufacture: { tailTime: "number" },
  PlayerBuildingDormitory_Buff_APCost: { self: "object", exclude: "object" },
  PlayerBuildingDormitory_Buff: { point: "object" },
  PlayerBuildingDormitory: { lockQueue: "number[]" },
  PlayerBuildingPrivate: { owners: "number[]" },
  // 助战/编队槽位（客户端模型为空接口，线格式有实字段）
  PlayerFriendAssist: { charInstId: "number", skillIndex: "number", currentEquip: "string", currentTmpl: "string" },
  PlayerSquadItem: { charInstId: "number", skillIndex: "number", currentEquip: "string" },
  PlayerSquad: { slots: "PlayerSquadItem[]" },
  // 商店各品类服务端独有字段
  PlayerLowQCShopProgressData: { curShopId: "string", info: "PlayerGoodItemData[]" },
  PlayerHighQCShopProgressData: { curShopId: "string" },
  PlayerCommonShopProgressData: { lastClick: "number" },
  PlayerGiftProgressPerData: { curGroupId: "string" },
  PlayerSocialShopData: { curShopId: "string", charPurchase: "{ [key: string]: number }", costSocialPoint: "number" },
  // 礼包商店：服务端多一个 monthlySub 分档（月卡礼包），客户端模型只有 6 档
  // （见 modules/shop/logic/misc.ts#buyGoodWithTicket 的 sub 计算）
  PlayerGiftProgressData: { monthlySub: "PlayerGiftProgressPerData" },
  // 第五周年探索：服务端把「进行中一局的交互状态」直接摊平在 game 上（客户端模型无这些键）
  // 写入见 modules/explore/routes.ts（selectEventChoice/selectTargetChoice/confirmPassTarget/
  // giveUpGame/settleGame），值均为 1 或请求下标。
  PlayerMainlineExplore_PlayerExploreGameContext: {
    eventChoice: "number",
    targetChoice: "number",
    passTarget: "number",
    gaveUp: "number",
    settled: "number",
  },
  // 第五周年探索外层：missions 为服务端任务领取记录（客户端模型只有 mission 任务进度），
  // initGroupId 为服务端记录的初始探索组（写入见 modules/explore/routes.ts）。
  PlayerMainlineExplore_PlayerExploreOuterContext: {
    missions: "{ [key: string]: number }",
    initGroupId: "string",
  },
};

/** 结构差异覆盖：接口名 → { 字段名: 完整 TS 类型 }（"[server]" 表示整接口覆盖） */
export const SERVER_OVERRIDE_FIELDS: Record<string, Record<string, string>> = {
  // 服务端 activity = { [类型key]: { [actId]: 活动数据 } } 字典（客户端是 60 个分列表字段）。
  //
  // 具名类型键给出**精确形状**（这些字段的真相在服务端，客户端模型里没有），
  // 其余键回落到 `ServerPayload`（非递归两层，Draft 安全）。兜底索引签名必须用
  // **交叉类型**挂载：具名成员与索引签名写在同一对象字面量里会触发 TS2411
  // （具名值类型不可赋给索引签名值类型），交叉写法绕开该检查。
  //
  // 新增具名键时：只声明服务端真正读写的字段，保持非递归（禁止 JsonValue）；
  // **具名键一律写作可选（`?:`）**——索引签名语义下键本就不保证存在（存档惰性建键），
  // 写成必填会让 `draft.activity = {}` 之类的赋值直接报错，访问侧也因此必须 `?.`。
  PlayerActivity: {
    "[server]":
      "{" +
      // 尖灭（BOSS_RUSH，见 modules/activities/bossRush）：milestone 进度 / relic 遗物 / bestWaveDic 波次
      " BOSS_RUSH?: { [actId: string]: { milestone?: { point?: number; got?: string[] }; relic?: { token?: { current?: number; total?: number }; unlockedRelicLevelDic?: { [key: string]: number }; selectingRelicId?: string }; bestWaveDic?: { [key: string]: number } } }" +
      // 奇象巡展（ARK_HUB，见 modules/activities/arkhub）：
      //   官服快照字段（coin/secretary/squads 等）形状自 arkhub/logic.ts + unlockActivity.ts 播种反推；
      //   私服扩展计数（duelCount…pixelPublished）与 ARKDEX/交换站/网关状态形状自 arkhub.ts、arkdex.ts、
      //   gateway 回调（server.ts）与 ops/admin/arkhub-pets.ts 的读写点反推。
      //   注：secretarySkinSp/globalBan 播种写布尔 false，客户端模型为 number → 两者都声明。
      " ; ARK_HUB?: { [actId: string]: {" +
      " coin?: number; secretary?: string; secretarySkinId?: string; secretarySkinSp?: number | boolean; protectTs?: number; squads?: (PlayerSquad | { slots?: ServerPayload[] })[]; globalBan?: number | boolean;" +
      " duelCount?: number; dailySupplyDays?: number; dailySupplyLastDay?: string; creatureCollected?: number; activeCreatureCollected?: number; alterCollected?: number; pixelCollected?: number; pixelPublished?: number;" +
      " pixelCollectedIds?: number[]; reviewedPixelArts?: { [key: string]: ServerPayload };" +
      " dex?: { [key: string]: { numId?: number; isAlter?: boolean; alterOf?: number; active?: boolean } };" +
      " scanBag?: { id: number; numId: number; isAlter?: boolean; alterOf?: number; fav?: boolean; sourceUid?: string }[];" +
      " scanSeq?: number; props?: { [key: string]: { count: number; uses: number } }; propSoldToday?: { date: string; sold: { [key: string]: number } };" +
      " shopToday?: { date?: string; ids?: number[] }; trade?: { wantSpecies?: number | null; offerNumIds?: number[]; ts?: number }; unlockedAreas?: { [key: string]: number };" +
      " stateMask?: number; settledDuels?: string[]; claimedRewards?: { [key: string]: number }; guideFlags?: { [key: string]: number | undefined };" +
      " arkdexState?: { activeLure?: number; activeEncounter?: { id?: string; areaId?: number | string; habitat?: string; isProtected?: boolean; cluster?: boolean; lureNumId?: number; creatures?: { numId?: number; name?: string; rarity?: number; isAlter?: boolean; active?: boolean; collected?: boolean }[] } }" +
      " } }" +
      // 特别战线（VEC_BREAK_V2，见 modules/vecbreak/routes.ts）：activatedBuff / defendStages 驻防 /
      //   milestone 里程碑 / bestShowTs 最佳记录时间；squads 为官服快照透传（服务端只读不写）。
      //   recvTimeLimited/recvNormal 结算写 0/1，setDefend 建键写布尔 false → 两者都声明。
      " ; VEC_BREAK_V2?: { [actId: string]: { activatedBuff: string[]; defendStages: { [stageId: string]: { stageId: string; defendSquad: { charInstId?: number; currentTmpl?: string | null }[]; recvTimeLimited: number | boolean; recvNormal: number | boolean } }; milestone: { point: number; got: string[] }; bestShowTs?: number; squads?: ServerPayload[] } }" +
      // 签到族（见 modules/activities/checkin/logic.ts）：
      //   CHECKIN_ONLY / CHECKIN_ALL_PLAYER = { lastTs 上次签到秒, history[index]=0 已领标记 }
      " ; CHECKIN_ONLY?: { [actId: string]: { lastTs: number; history: number[] } }" +
      " ; CHECKIN_ALL_PLAYER?: { [actId: string]: { lastTs: number; history: number[] } }" +
      //   CHECKIN_VS 甜咸投票签到（canVote 播种写布尔 false，客户端模型为 number）
      " ; CHECKIN_VS?: { [actId: string]: { sweetVote: number; saltyVote: number; canVote: number | boolean; todayVoteState: number; voteRewardState: number; signedCnt: number; availSignCnt: number; socialState: number; actDay: number } }" +
      //   CHECKIN_ACCESS 访问签到（rewardsCount 领取次数 / currentStatus 状态位 / lastTs 上次领取秒）
      " ; CHECKIN_ACCESS?: { [actId: string]: { rewardsCount: number; currentStatus: number; lastTs: number } }" +
      //   LOGIN_ONLY 登录奖励（reward=0 已领）；SWITCH_ONLY 开关奖励（rewards[rewardId]=0 已领）
      " ; LOGIN_ONLY?: { [actId: string]: { reward: number } }" +
      " ; SWITCH_ONLY?: { [actId: string]: { [rewardId: string]: number } }" +
      //   BLESS_ONLY 祝福签到（festivalHistory 节日干员槽；history 服务端只建空数组，保持未建模）
      " ; BLESS_ONLY?: { [actId: string]: { festivalHistory?: { charId?: string; state?: number }[]; history?: ServerPayload[]; lastTs?: number } }" +
      // 次生预案半挂机（HALFIDLE_VERIFY1，见 modules/activities/act1vhalfidle）：
      //   形状自 act1vhalfidle/logic.ts#ensureHalfIdleData 的逐字段回填反推（旧存档缺字段 → 一律可选）；
      //   troop.char 多一个遗留 skillLvl（升级技能读取时 `skillLvlWithSpec ?? skillLvl ?? 0`）。
      " ; HALFIDLE_VERIFY1?: { [actId: string]: { coin?: number; globalBan?: number; troop?: { chars?: { [instId: string]: { instId?: number; charId?: string; level?: number; skillLvl?: number; skillLvlWithSpec?: number; evolvePhase?: number; isAssist?: number; defaultSkillId?: string; defaultEquipId?: string } }; trap?: string[]; npc?: string[]; assist?: ServerPayload[]; extraAssist?: number }; stage?: { [stageId: string]: { rate?: { [itemId: string]: number }; bossState?: number } }; settleInfo?: { rate?: { [itemId: string]: number }; bossState?: number; stageId?: string; progress?: number }; production?: { rate?: { [itemId: string]: number }; product?: { [itemId: string]: number }; harvestTs?: number; refreshTs?: number }; recruit?: { poolGain?: { [poolId: string]: string[] }; poolTimes?: { [poolId: string]: number } }; milestone?: { point?: number; got?: string[] }; inventory?: { [itemId: string]: number }; tech?: { unlock?: string[] } } }" +
      // 怪猎对决（ENEMY_DUEL，见 modules/activities/enemyDuel）：服务端只读 modeInfo[modeId].curStage
      //   （queryMatch 拼 serverToken）；其余字段按生成模型 PlayerActivity_PlayerEnemyDuelActivity 声明
      " ; ENEMY_DUEL?: { [actId: string]: { milestone?: { point?: number; got?: string[] }; dailyMission?: { process?: number; state?: number }; modeInfo?: { [modeId: string]: { highScore?: number; curStage?: string; isUnlock?: number } }; globalBan?: number } }" +
      // 怪猎 act24side（TYPE_ACT24SIDE，见 modules/activities/act24side/router.ts）：
      //   炼金（price 余值 / item 素材 / gacha 各箱已抽）/ 用餐（digested/chance/id/day）/ 工具（tool[key]=1|2）
      " ; TYPE_ACT24SIDE?: { [actId: string]: { meal?: { chance?: number; digested?: number; id?: string; day?: string }; alchemy?: { price?: number; item?: { [key: string]: number }; gacha?: { [boxId: string]: { [goodId: string]: number } } }; tool?: { [key: string]: number }; favorList?: string[]; hunt?: { infoBook?: { [key: string]: number }; enemyKillCntStats?: { [key: string]: number }; collectRewards?: number }; unlockItemMap?: { [key: string]: number }; globalBan?: number } }" +
      // act42side（TYPE_ACT42SIDE，见 modules/activities/act42side/router.ts）：dailyRewardState /
      //   taskMap[taskId]（服务端按 ODPY 写裸数值 2/4；客户端模型为 { state } → 两者都声明）
      " ; TYPE_ACT42SIDE?: { [actId: string]: { coin?: number; favorList?: string[]; outerPlayerOpen?: number; taskMap?: { [taskId: string]: number | { state?: number } }; gunMap?: { [key: string]: number }; fileMap?: { [key: string]: number }; trustedItem?: { has?: number; got?: number; dailyState?: number }; dailyRewardState?: number } }" +
      // 情报屋 act44side（TYPE_ACT44SIDE，见 modules/activities/act44side/informant.ts）：
      //   现场形状以抓包为准（与生成模型不同：会话字段为 game，boom/success 可为布尔）——
      //   game 收摊后写 null；isNew/outerOpen 播种写布尔、客户端模型为 number → 两者都声明。
      " ; TYPE_ACT44SIDE?: { [actId: string]: { coin?: number; favorList?: string[]; informantPt?: number; milestone?: { point?: number; got?: string[] }; businessDay?: number; unlockedCustomers?: { [customerId: string]: number }; unlockedTags?: { [tagId: string]: number }; isNew?: number | boolean; outerOpen?: number | boolean; game?: { state?: number; customerList?: number[]; curCustomer?: number; newsId?: string; customerId?: string; round?: number; boom?: number | boolean; tagId?: string; basicIncome?: number; customerLine?: string | null; keeperLine?: string | null; insightTimes?: number; insight?: { trustRE?: number; trustMAX?: number; attentionRE?: number; attentionMAX?: number } | null; tradeInfo?: { trust?: number; attention?: number; choices?: string[]; lastChoice?: string | null }; settle?: { customerId?: string; tagId?: string; success?: number | boolean; successRate?: number; incomeRate?: number; income?: number }[] } | null } }" +
      // 收集型活动（COLLECTION，见 modules/activities/milestone/logic.ts#handleGetActivityCollectionReward）：
      //   activity.COLLECTION[actId][collectionId]=0 已领标记
      " ; COLLECTION?: { [actId: string]: { [collectionId: number]: number } }" +
      // 里程碑兜底标记（MILESTONE_ONLY，同上）：activity.MILESTONE_ONLY[actId][milestoneId]=0 已领
      " ; MILESTONE_ONLY?: { [actId: string]: { [milestoneId: string]: number } }" +
      // 自走棋赛季（AUTOCHESS_SEASON，见 modules/autochess/autochess.ts）：
      // 键名与客户端模型类名不同（PlayerActAutoChessActivity），故显式映射到生成类——
      // ensureState 构造的形状与该类逐字段一致。
      " ; AUTOCHESS_SEASON?: { [actId: string]: PlayerActivity_PlayerActAutoChessActivity }" +
      " } & { [typeKey: string]: { [actId: string]: ServerPayload } }",
  },
  // 信物（charm）服务端扩展：firstReward[charmId]=1 表示首通奖励已领
  // （见 modules/activities/charm/router.ts#tryGetCharmFirstReward）
  CharmStatus: {
    "[server]":
      "{ charms: { [key: string]: number }; squad: string[]; firstReward?: { [charmId: string]: number } }",
  },
  // 开服签到（openServer）：服务端惰性建键（checkin/openServer.ts#_ensureState 逐字段回填），
  // 三个子状态均可缺失 → 全部可选。
  PlayerOpenServer: {
    "[server]":
      "{ chainLogin?: OpenServerChainLogin; checkIn?: OpenServerCheckIn; fullOpen?: OpenServerFullOpen }",
  },
  // 服务端 shop = LS/HS/ES/CASH/GP/FURNI/SOCIAL/EPGS/REP/CLASSIC/SKIN 缩写 key 字典
  // （缩写 ↔ 客户端完整名：LS=lowQCShop、HS=highQCShop、ES=extraQCShop、CASH=cashShop、
  //   GP=giftShop、FURNI=furnitureShop、SOCIAL=socialShop、EPGS=epgsQCShop、REP=repQCShop、
  //   CLASSIC=classicQCShop、SKIN=skinShop）
  PlayerShop: {
    "[server]":
      "{ LS: PlayerLowQCShopProgressData; HS: PlayerHighQCShopProgressData; ES: PlayerCommonShopProgressData; CASH: PlayerCashProgressData; GP: PlayerGiftProgressData; FURNI: PlayerFurnitureShopData; SOCIAL: PlayerSocialShopData; EPGS: PlayerEPGSProgressData; REP: PlayerEPGSProgressData; CLASSIC: PlayerClassicQCShopProgressData; SKIN: PlayerSkinShopData; LMTGS?: PlayerLMTGSProgressData }",
  },
  // 服务端 building.rooms = { [房间类型大写key]: { [slotId]: 房间 } }（客户端是具名类 PlayerBuildingRoom）
  // 具名 12 房间类型（线格式键大写），值引用生成房间类——消除 object 盲区
  PlayerBuilding: {
    rooms:
      // 电梯/走廊：客户端模型无具名类（其余 10 类复用生成的房间类），内联其可达字段。
      // 写入见 building/logic/construction.ts，预设队列读取见 building/logic/misc.ts
      "{ CONTROL: { [slotId: string]: PlayerBuildingControl }; ELEVATOR: { [slotId: string]: { state?: number; presetQueue?: number[][]; completeConstructTime?: number } }; POWER: { [slotId: string]: PlayerBuildingPower }; MANUFACTURE: { [slotId: string]: PlayerBuildingManufacture }; TRADING: { [slotId: string]: PlayerBuildingTrading }; CORRIDOR: { [slotId: string]: { state?: number; presetQueue?: number[][]; completeConstructTime?: number } }; WORKSHOP: { [slotId: string]: PlayerBuildingWorkshop }; DORMITORY: { [slotId: string]: PlayerBuildingDormitory }; MEETING: { [slotId: string]: PlayerBuildingMeeting }; HIRE: { [slotId: string]: PlayerBuildingHire }; TRAINING: { [slotId: string]: PlayerBuildingTraining }; PRIVATE: { [slotId: string]: PlayerBuildingPrivate } }",
  },
  // PlayerCartInfo.Cart 继承 Dictionary<CartAccessoryPos, string>（解析器生成空接口，实际是索引签名字典）
  PlayerCartInfo_Cart: {
    "[server]": "{ [key: string]: string }",
  },
  // 基建干员气泡：线格式只有 normal/assist/private（客户端多 privateBubble）
  PlayerBuildingChar_BubbleContainer: {
    "[server]": "{ normal: PlayerBuildingCharBubble; assist: PlayerBuildingCharBubble; private: PlayerBuildingCharBubble }",
  },
  // 贸易订单：线格式 { instId, delivery: ItemBundle[], type, gain, buff }（客户端多 extraCost/specGoldTag）
  PlayerBuildingTradingOrder: {
    "[server]": "{ instId: number; delivery: ItemBundle[]; type: BuildingData_OrderType; gain: ItemBundle; buff: object[] }",
  },
  // 塔神卡：线格式 { id, subGodCardId }（客户端多 godCardId，服务端已改名）
  TowerCurrent_TowerGodCard: {
    "[server]": "{ id: string; subGodCardId: string }",
  },
  // 塔卡牌：C# GameCard 继承 PlayerCharacter（parser 不支持继承，需整接口覆盖补全字段）
  TowerCurrent_GameCard: {
    "[server]":
      "{ relation: string; type: TowerCurrent_TowerCardType; charId: string; currentEquip: string | null; defaultSkillIndex: number; equip: { [key: string]: PlayerCharEquipInfo }; evolvePhase: number; favorPoint: number; instId: string; level: number; mainSkillLvl: number; potentialRank: number; skills: { skillId: string; unlock: number; state: number; specializeLevel: number; completeUpgradeTime: number }[]; skin: string }",
  },
  // 任务分组：线格式 { [groupType]: { [missionId]: { state, progress } } }（客户端为 Dictionary 继承，解析为空接口）
  MissionPlayerDataGroup: {
    "[server]": "{ [groupType: string]: { [missionId: string]: { state: number; progress: MissionCalcState[] } } }",
  },
  // 背景/主题解锁状态：线格式仅 { unlock: number }；conditions/unlockTime 为运行时内部进度
  PlayerHomeUnlockStatus: {
    "[server]": "{ unlock: number; unlockTime?: number; conditions?: { [key: string]: PlayerHomeConditionProgress } }",
  },
};

/**
 * 应用服务端协议适配：rename → add → override → 字段覆盖（共享应用逻辑）
 * @param classes - 客户端闭包类定义
 * @returns 适配后的类定义列表（不修改入参）
 */
export function applyServerAdapt(classes: ClassDef[]): ClassDef[] {
  // 字段级类型覆盖由 applyWireFormat 最后应用（保持原顺序）
  return applyAdaptOps(classes, {
    rename: SERVER_RENAME_FIELDS,
    add: SERVER_ADD_FIELDS,
    override: SERVER_OVERRIDE_FIELDS,
    optional: SERVER_OPTIONAL_FIELDS,
  });
}

// ---------- 线格式适配（wire format pass） ----------

/**
 * 官服 JSON 线格式把枚举/时间戳/布尔系统性降为数字：
 *  - 枚举字段 → number（0/1/2…，客户端枚举名作参考保留在定义处）
 *  - boolean 字段 → number（0/1），少数真正序列化为 true/false 的字段在白名单保留
 *  - System.DateTime 已在解析器映射为 number（unix 时间戳）
 *
 * 白名单键格式 "IfaceName.fieldName"，由标量审计（validate-playerdata-json.ts）
 * 报告 "期望 number，实际 boolean" 的字段反推填充。
 */
export const SERVER_BOOL_KEEP_AS_BOOLEAN: string[] = [
  // 线格式真正序列化为 true/false 的字段（抓包标量审计反推）
  "BuildingMusic.inUse",
  "BuildingMusicState.unlock",
  "OpenServerChainLogin.isAvailable",
  "OpenServerCheckIn.isAvailable",
  "OpenServerFullOpen.isAvailable",
  "OpenServerFullOpen.today",
  "PlayerActFun4Mission.finished",
  "PlayerActFun4Mission.hasRecv",
  "PlayerBuildingMessageLeave.inUse",
  "PlayerBuildingTrainingReduceTimeBd.activated",
  "PlayerCharRotationPreset.profileSp",
  "PlayerCharRotationSlot.skinSp",
  "PlayerCheckIn_PlayerNewbiePackage.open",
  "PlayerFirework.unlock",
  "PlayerGacha_PlayerFreeLimitGacha.recruitedFreeChar",
  "PlayerGacha_PlayerGachaPool.avail",
  "PlayerGacha_PlayerSingleGacha.singleEnsureUse",
  "PlayerInviteData.closeAccept",
  "PlayerInviteData.newInvite",
  "PlayerMainlineClue.unlock",
  "PlayerMainlineExplore_PlayerExploreOuterContext.isOpen",
  "PlayerMainlineExplore_PlayerExploreOuterContextHistoryPath.success",
  "PlayerNameCardMisc.showBirthday",
  "PlayerNameCardMisc.showDetail",
  "PlayerNameCardSkin_SkinState.unlock",
  "PlayerReturnData.open",
  "PlayerRoguelikeV2_CurrentData_PlayerStatus.chgEnding",
  "PlayerRoguelikeV2_CurrentData_Troop.hasExpeditionReturn",
  "PlayerRoguelikeV2_OuterData_Bank.show",
  "PlayerSandboxPerm.isClose",
  "PlayerStatus.secretarySkinSp",
  "TowerCurrent_HalftimeRecruit.canGiveUp",
  "TowerCurrent_Status.isHard",
  "TowerOuter_TowerData.canSweep",
  "TowerOuter_TowerData.canSweepHard",
  "TowerOuter_TowerData.unlockHard",
  "TowerSeason_TowerSeasonMission.hasRecv",
];

/** 字符串序列化枚举字段：保留枚举字面量联合（线格式为枚举名字符串，如 roomId "CONTROL"、mode "NORMAL"） */
export const SERVER_ENUM_KEEP_AS_STRING: string[] = [
  "AvatarInfo.type",
  "ItemBundle.type",
  "PlayerBuildingRoomSlot.roomId",
  "PlayerBuildingTrading.strategy",
  "PlayerBuildingTradingOrder.type",
  "PlayerMedalBoard.type",
  "PlayerRoguelikeV2_CurrentData_PlayerStatus.state",
  "PlayerRoguelikeV2_OuterData_Mission_MissionItem.type",
  "PlayerRoguelikeV2_OuterData_Mission_MissionSlot.type",
  "PlayerRoguelikeV2_OuterData_Record_History.mode",
  // 肉鸽事件类型：线格式为枚举名字符串（CS 为 PlayerRoguelikePlayerEventType 枚举）。
  // 证据：参考实现 reference/opendoctoratepy-ex-public/server/rlv2.py 一律写
  // `"type": "SCENE"` / `"BATTLE"` / "RECRUIT"；本仓运行时（events.ts#createEvent 的 emit 点）
  // 同样写字符串枚举名。此前生成类型为 number，与硬编码模型 rlv2-model.ts（string）冲突，
  // 逼出 roguelike/logic.ts 的 current / update 两处 `as unknown as`。
  "PlayerRoguelikePendingEvent.type",
  // 同一子树的事件结束简报 mode（CS: RoguelikeTopicMode）——该枚举在
  // PlayerRoguelikeV2_OuterData_Record_History.mode 上已按名字符串登记，此处保持同族一致。
  "PlayerRoguelikePendingEvent_EndingBrief.mode",
  // 待证实（**未登记**）：同子树内 ChoiceAddition.Reward/Cost.type、
  // InitRecruitContent.ShowChar.type、InitTeam.Char.type、BattleContent.battleFailDisplay、
  // SacrificeContent/ExpeditionContent.type 也是 CS 枚举，且本仓从不写非空值（零报文风险）；
  // 但「名字符串」这一线格式仅由父级 .type 与参考实现间接支持，缺客户端侧证据，
  // 故暂不登记（登记前需抓包/客户端解析确认）。它们也是 roguelike/logic.ts
  // current/update 两处断言无法降级的第二层原因。
  "PlayerStatus.globalVoiceLan",
  "TowerCurrent_GameCard.type", // 线格式 "CHAR" 等字符串
  "TowerCurrent_Status.state",
  "TowerOuter.strategy",
];

/** 线格式字段类型覆盖（最高优先级，wire pass 后应用）："Iface.field" → TS 类型 */
export const SERVER_FIELD_TYPE_OVERRIDES: Record<string, string> = {
  // 服务端把 uid 序列化为字符串（如 "100566259"），客户端模型为数值
  "PlayerBuildingMeetingClue.uid": "string",
  // 服务端把社交分序列化为字符串数字（新官服 "300"），老存档为 number——两态并存
  "PlayerCrisisSocialInfo.maxPnt": "number | string",
  // 勋章板 custom 线格式为 null（客户端模型 string）
  "PlayerMedalBoard.custom": "string | null",
  // 编队 squadId 线格式为字符串（"0"）
  "PlayerSquad.squadId": "string",
  // 未装备干员/槽位的 currentEquip 可为 null（线格式与运行时并存）
  "PlayerCharacter.currentEquip": "string | null",
  "PlayerCharPatch.currentEquip": "string | null",
  "PlayerSquadItem.currentEquip": "string | null",
  "PlayerFriendAssist.currentEquip": "string | null",
  // 干员技能：线格式 skills = [{ skillId, unlock, state, specializeLevel, completeUpgradeTime }]
  // （字段级覆盖，客户端 PlayerCharSkill 缺 state/completeUpgradeTime）
  "PlayerCharacter.skills": "{ skillId: string; unlock: number; state: number; specializeLevel: number; completeUpgradeTime: number }[]",
  "PlayerCharPatch.skills": "{ skillId: string; unlock: number; state: number; specializeLevel: number; completeUpgradeTime: number }[]",
  // 名片皮肤解锁进度线格式可为 null（老皮肤无进度）
  "PlayerNameCardSkin_SkinState.progress": "number[][] | null",
  // 动态立绘开关（changeSkinSpState）：服务端按 CS Boolean 写 true/false，
  // 客户端模型声明为 number → 两态并存（见 modules/character/routes.ts#changeSkinSpState）
  "PlayerSkins.skinSp": "{ [key: string]: number | boolean }",
  // 牛关（特殊关卡）奖励标记：真实存档为 boolean[]（如 spst_08-02 → [true]、spst_08-04 → []），
  // 而非 ADD_FIELDS 里按客户端模型登记的 number；写入见 modules/quest/routes.ts#getCowLevelReward
  // （val.map(() => false) 置为已领）。
  "PlayerSpecialStage.val": "boolean[]",
  // ODC 主题坐标：restart 路由把 position 显式置 null（重置游玩进度，
  // 见 modules/arkodc/routes.ts#/arkodc/restart），种子逻辑亦按 null 兜底
  "PlayerArkOdcTopic.position": "PlayerArkOdcTopic_Position | null",
  // 画廊杂志页：服务端建键时 charSkin 写 null（客户端模型为 ArtMagazineLeafElementData，
  // 见 modules/gallery 与 kernel/inventory.ts#MAGAZINE_LEAF）
  "PlayerArtMagazineLeafData.charSkin": "ArtMagazineLeafElementData | null",
};

/** 可选字段（线格式服务端常省略）：接口名 → 字段名数组；生成时输出 name?: type */
export const SERVER_OPTIONAL_FIELDS: Record<string, string[]> = {
  // 新手池账本：首建/旧存档可整块缺失，管理器惰性建键
  // （modules/gacha/logic.ts#NEWBEE：`if (!draft.gacha.newbee) draft.gacha.newbee = {…}`）。
  // 客户端模型声明为必填，服务端存档实为可选——此前逼出两处 `as unknown as`。
  PlayerGacha: ["newbee"],
  // 单抽池：线格式不含基础池字段 cnt/maxCnt/avail（客户端模型继承自 PlayerGachaPool）
  PlayerGacha_PlayerSingleGacha: ["cnt", "maxCnt", "avail"],
  // 线索：线格式不含 ts（管理器创建时才写入）
  PlayerBuildingMeetingClue: ["ts"],
  // 塔：reward 为服务端内部战斗奖励计数（线格式不含）
  TowerCurrent: ["reward"],
  // 塔中场招募：线格式不含 remainCount（客户端模型字段）
  TowerCurrent_HalftimeRecruit: ["remainCount"],
  // 任务进度项：线格式不含 compare（客户端模型字段）
  MissionCalcState: ["compare"],
  // 助战干员：线格式不含 currentTmpl（部分条目缺失）
  PlayerFriendAssist: ["currentTmpl"],
  PlayerSquadItem: ["currentTmpl"],
  // 干员：线格式不含 starMark/master（客户端模型字段）；currentTmpl/tmpl 亦常省略
  //（官方 test.json 379 干员仅 char_002_amiya 带模板字段——普通干员发放/建档不含，
  // 旧实现自引用空模板破坏存档结构）
  PlayerCharacter: ["starMark", "master", "currentTmpl", "tmpl"],
  // 名片皮肤：线格式不含 tmpl（客户端模型字段）
  PlayerNameCardSkin: ["tmpl"],
  // 名片皮肤解锁进度：线格式部分条目不含 unlockTs（老皮肤）
  PlayerNameCardSkin_SkinState: ["unlockTs"],
  // 勋章：线格式不含 reward（客户端模型字段）
  PlayerPerMedal: ["reward"],
  // 基建干员：线格式不含 skinIdInVisit（客户端模型字段）
  PlayerBuildingChar: ["skinIdInVisit"],
  // 礼包商店 monthlySub 分档 / 信用商店累计信用消费：服务端惰性建键，旧存档缺失
  PlayerGiftProgressData: ["monthlySub"],
  PlayerSocialShopData: ["costSocialPoint"],
  // 第五周年探索：服务端防御性初始化会先写入空对象再逐层补键
  // （modules/explore/routes.ts#ensureOuter：`?? {}` 后 `outer = outer ?? {}`），
  // 故两侧结构在存档里都可缺失；game 上的服务端自建键同样可选。
  PlayerMainlineExplore: ["game", "outer"],
  PlayerMainlineExplore_PlayerExploreGameContext: [
    "state",
    "node",
    "map",
    "log",
    "eventChoice",
    "targetChoice",
    "passTarget",
    "gaveUp",
    "settled",
  ],
  PlayerMainlineExplore_PlayerExploreOuterContext: [
    "isOpen",
    "mission",
    "lastGameResult",
    "historyPaths",
    "missions",
    "initGroupId",
  ],
  // 隐藏关卡 missions 为客户端模型字段，服务端新建条目只写 { unlock: 1 }
  // （modules/quest/routes.ts#unlockHideStage）
  PlayerHiddenStage: ["missions"],
  // 烟花：服务端防御性建键（modules/firework/routes.ts#firework/savePlateSlots、changeAnimal
  // 先 `firework ??= {}` 再 `plate ??= {}`），存档可整块缺失
  PlayerDataModel: ["firework"],
  PlayerFirework: ["unlock", "plate", "animal"],
  PlayerFirework_PlayerPlate: ["unlock", "slots"],
  PlayerFirework_PlayerAnimal: ["unlock", "select"],
  // 画廊：服务端只惰性建 leafMap（kernel/inventory.ts#MAGAZINE_LEAF 的
  // `gallery ??= { leafMap: {} }`），firstRewards 等客户端字段存档可缺失
  PlayerGallery: ["firstRewards", "magazineSquad", "collectionRewards", "stickerMap", "offlineList"],
  // 助战信用每日限次：旧存档/未打过助战战不存在这三个计数键
  PlayerStatus: [
    "assistUsedDay",
    "assistUsedCount",
    "assistBeUsedDay",
    "maxAccountResVersion",
  ],
};

/** 字段类型递归改写：枚举/布尔 → number */
function rewriteWireType(t: string, enumNames: Set<string>, fieldName: string, keepBool: boolean): string {
  t = t.trim();
  if (enumNames.has(t)) return "number";
  if (t === "boolean") return keepBool ? t : "number";
  const arr = t.match(/^(.+)\[\]$/);
  if (arr) {
    const inner = rewriteWireType(arr[1].trim(), enumNames, fieldName, keepBool);
    return inner === arr[1] ? t : `${inner}[]`;
  }
  const idx = t.match(/^\{\s*\[([a-zA-Z_][a-zA-Z0-9_]*:\s*[^\]]+)\]:\s*(.+)\s*\}$/);
  if (idx) {
    const inner = rewriteWireType(idx[2].trim(), enumNames, fieldName, keepBool);
    return inner === idx[2] ? t : `{ [${idx[1]}]: ${inner} }`;
  }
  return t;
}

/**
 * 应用线格式适配（在 applyServerAdapt 之后调用）：
 * 枚举字段与布尔字段（除白名单）改写为 number，使生成模型描述真实服务端 JSON。
 * @param classes - 服务端协议适配后的类定义
 * @param enumNames - 闭包内枚举类型名集合（用于识别枚举字段）
 * @returns 线格式改写后的类定义（不修改入参）
 */
export function applyWireFormat(classes: ClassDef[], enumNames: Set<string>): ClassDef[] {
  return classes.map(iface => {
    const boolFields = new Set<string>();
    const stringEnumFields = new Set<string>();
    for (const k of SERVER_BOOL_KEEP_AS_BOOLEAN) {
      const dot = k.indexOf(".");
      if (dot > 0 && k.slice(0, dot) === iface.name) boolFields.add(k.slice(dot + 1));
    }
    for (const k of SERVER_ENUM_KEEP_AS_STRING) {
      const dot = k.indexOf(".");
      if (dot > 0 && k.slice(0, dot) === iface.name) stringEnumFields.add(k.slice(dot + 1));
    }
    return {
      ...iface,
      optionalFields: iface.optionalFields,
      fields: iface.fields.map(f => {
        let type = f.type;
        // 字符串序列化枚举：跳过改写，保留字面量联合
        const isStringEnum = enumNames.has(f.type) && stringEnumFields.has(f.name);
        if (!isStringEnum) {
          type = rewriteWireType(f.type, enumNames, f.name, boolFields.has(f.name));
        }
        // 字段级类型覆盖（最高优先级）
        const override = SERVER_FIELD_TYPE_OVERRIDES[`${iface.name}.${f.name}`];
        if (override) type = override;
        return type === f.type ? f : { ...f, rawType: type, type };
      }),
    };
  });
}
