import { Router } from "express";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import { PlayerDataManager } from "../../kernel/player-data-manager";
import {
  addonStageBattleFinishSchema,
  addonStageBattleStartSchema,
  addonStoryUnlockSchema,
  batchSetCharVoiceLanSchema,
  boostPotentialSchema,
  changeCharSkinSchema,
  changeCharTemplateSchema,
  changeSkinSpStateSchema,
  completeUpgradeSpecializationSchema,
  evolveCharSchema,
  evolveCharUseItemSchema,
  getSpCharMissionRewardSchema,
  lockCharSchema,
  sellCharSchema,
  setCharVoiceLanSchema,
  setDefaultSkillSchema,
  setEquipmentSchema,
  unlockEquipmentSchema,
  upgradeCharLevelMaxUseItemSchema,
  upgradeCharSchema,
  upgradeEquipmentSchema,
  upgradeSkillSchema,
  upgradeSpecializationSchema,
  upgradeSpecializedSkillUseItemSchema,
} from "./charBuild.schema";
import {
  AddonStageBattleFinishRequest,
  AddonStageBattleFinishResponse,
  AddonStageBattleStartRequest,
  AddonStageBattleStartResponse,
  AddonStoryUnlockRequest,
  AddonStoryUnlockResponse,
  BatchSetCharVoiceLanRequest,
  BatchSetCharVoiceLanResponse,
  BoostPotentialRequest,
  BoostPotentialResponse,
  ChangeCharSkinRequest,
  ChangeCharSkinResponse,
  ChangeCharSkinSpStateRequest,
  ChangeCharSkinSpStateResponse,
  ChangeCharTemplateRequest,
  ChangeCharTemplateResponse,
  CompleteUpgradeSpecializationRequest,
  CompleteUpgradeSpecializationResponse,
  EvolveCharRequest,
  EvolveCharResponse,
  EvolveCharUseItemRequest,
  EvolveCharUseItemResponse,
  GetSpCharMissionRewardRequest,
  GetSpCharMissionRewardResponse,
  LockCharRequest,
  LockCharResponse,
  SellCharRequest,
  SellCharResponse,
  SetCharVoiceLanRequest,
  SetCharVoiceLanResponse,
  SetDefaultSkillRequest,
  SetDefaultSkillResponse,
  SetEquipmentRequest,
  SetEquipmentResponse,
  UpgradeCharLevelMaxUseItemRequest,
  UpgradeCharLevelMaxUseItemResponse,
  UpgradeCharRequest,
  UpgradeCharResponse,
  UpgradeEquipmentRequest,
  UpgradeEquipmentResponse,
  UpgradeSkillRequest,
  UpgradeSkillResponse,
  UpgradeSpecializationRequest,
  UpgradeSpecializationResponse,
  UpgradeSpecializedSkillUseItemRequest,
  UpgradeSpecializedSkillUseItemResponse,
  UnlockEquipmentRequest,
  UnlockEquipmentResponse,
} from "./charBuild";

const router = Router();
router.post("/setDefaultSkill", validateBody(setDefaultSkillSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetDefaultSkillRequest;
  // 缺参校验：空 body 或缺 charInstId/defaultSkillIndex 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.defaultSkillIndex !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.setDefaultSkill(body);
  res.send(player.delta satisfies SetDefaultSkillResponse);
});
router.post("/upgradeChar", validateBody(upgradeCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UpgradeCharRequest;
  // 缺参校验：空 body 或缺 charInstId/expMats 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    !Array.isArray(body?.expMats)
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.upgradeChar(body);
  res.send(player.delta satisfies UpgradeCharResponse);
});
router.post("/evolveChar", validateBody(evolveCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EvolveCharRequest;
  await player.char.evolveChar(body);
  res.send(player.delta satisfies EvolveCharResponse);
});
router.post("/lockChar", validateBody(lockCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as LockCharRequest;
  // 缺参校验：空 body 或缺 charInstIdList 时返回业务错误（避免空操作误判）
  if (!Array.isArray(body?.charInstIdList)) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.lockChar(body);
  res.send(player.delta satisfies LockCharResponse);
});
router.post("/sellChar", validateBody(sellCharSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SellCharRequest;
  // 缺参校验：空 body 或缺 charInstIdList 时返回业务错误（避免空操作误判）
  if (!Array.isArray(body?.charInstIdList)) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.sellChar(body);
  res.send(player.delta satisfies SellCharResponse);
});
router.post("/boostPotential", validateBody(boostPotentialSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BoostPotentialRequest;
  await player.char.boostPotential(body);
  res.send({
    result: 1,
    ...player.delta,
  } satisfies BoostPotentialResponse);
});

router.post("/upgradeSkill", validateBody(upgradeSkillSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UpgradeSkillRequest;
  // 缺参校验：空 body 或缺 charInstId/targetLevel 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.targetLevel !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.upgradeSkill(body);
  res.send(player.delta satisfies UpgradeSkillResponse);
});
router.post("/upgradeSpecialization", validateBody(upgradeSpecializationSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UpgradeSpecializationRequest;
  // 缺参校验：空 body 或缺 charInstId/skillIndex/targetLevel 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.skillIndex !== "number" ||
    typeof body?.targetLevel !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.upgradeSpecialization(body);
  res.send(player.delta satisfies UpgradeSpecializationResponse);
});
router.post("/completeUpgradeSpecialization", validateBody(completeUpgradeSpecializationSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as CompleteUpgradeSpecializationRequest;
  // 缺参校验：空 body 或缺 charInstId/skillIndex/targetLevel 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.skillIndex !== "number" ||
    typeof body?.targetLevel !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.completeUpgradeSpecialization(body);
  res.send(player.delta satisfies CompleteUpgradeSpecializationResponse);
});
router.post("/changeCharSkin", validateBody(changeCharSkinSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeCharSkinRequest;
  // 缺参校验：空 body 或缺 charInstId/skinId 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.skinId !== "string"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.changeCharSkin(body);
  res.send(player.delta satisfies ChangeCharSkinResponse);
});
router.post("/changeCharTemplate", validateBody(changeCharTemplateSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeCharTemplateRequest;
  // 缺参校验：空 body 或缺 charInstId/templateId 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.templateId !== "string"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.changeCharTemplate(body);
  res.send(player.delta satisfies ChangeCharTemplateResponse);
});
router.post("/getSpCharMissionReward", validateBody(getSpCharMissionRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetSpCharMissionRewardRequest;
  // 缺参校验：读类端点但确实需要必填字段 charId/missionId，缺参时返回业务错误（避免 500）
  if (
    typeof body?.charId !== "string" ||
    typeof body?.missionId !== "string"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.getSpCharMissionReward(body);
  res.send(player.delta satisfies GetSpCharMissionRewardResponse);
});
router.post("/evolveCharUseItem", validateBody(evolveCharUseItemSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as EvolveCharUseItemRequest;
  // 修复：CS 字段为 charInsId/itemInsId——客户端按 CS 发，服务端读 charInstId/instId
  //（原实现读不到 → undefined 干员 → 500）
  const charInstId = body?.charInstId ?? body?.charInsId;
  const instId = body?.instId ?? body?.itemInsId;
  // 缺参校验：空 body 或缺 charInstId/itemId/instId 时返回业务错误（避免 500）
  if (
    typeof charInstId !== "number" ||
    typeof body?.itemId !== "string" ||
    typeof instId !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.evolveCharUseItem({ charInstId, itemId: body.itemId, instId });
  res.send(player.delta satisfies EvolveCharUseItemResponse);
});
router.post("/upgradeCharLevelMaxUseItem", validateBody(upgradeCharLevelMaxUseItemSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UpgradeCharLevelMaxUseItemRequest;
  // 修复：同上 CS 字段名归一化
  const charInstId = body?.charInstId ?? body?.charInsId;
  const instId = body?.instId ?? body?.itemInsId;
  // 缺参校验：空 body 或缺 charInstId/itemId/instId 时返回业务错误（避免 500）
  if (
    typeof charInstId !== "number" ||
    typeof body?.itemId !== "string" ||
    typeof instId !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.upgradeCharLevelMaxUseItem({ charInstId, itemId: body.itemId, instId });
  res.send(player.delta satisfies UpgradeCharLevelMaxUseItemResponse);
});
router.post("/upgradeSpecializedSkillUseItem", validateBody(upgradeSpecializedSkillUseItemSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UpgradeSpecializedSkillUseItemRequest;
  // 修复：同上 CS 字段名归一化
  const charInstId = body?.charInstId ?? body?.charInsId;
  const instId = body?.instId ?? body?.itemInsId;
  // 缺参校验：空 body 或缺 charInstId/skillIndex/itemId/instId 时返回业务错误（避免 500）
  if (
    typeof charInstId !== "number" ||
    typeof body?.skillIndex !== "number" ||
    typeof body?.itemId !== "string" ||
    typeof instId !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.upgradeSpecializedSkillUseItem({
    charInstId,
    skillIndex: body.skillIndex,
    itemId: body.itemId,
    instId,
  });
  res.send(player.delta satisfies UpgradeSpecializedSkillUseItemResponse);
});

router.post("/addonStory/unlock", validateBody(addonStoryUnlockSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AddonStoryUnlockRequest;
  const medalId = await player.troop.addonStoryUnlock(body);
  res.send({
    rewards: null,
    // 对齐官服响应：解锁密录发放勋章时推送 medalFinish（无勋章配置则省略）
    ...(medalId
      ? { pushMessage: [{ path: "medalFinish", payload: { idList: [medalId] } }] }
      : {}),
    ...player.delta,
  } satisfies AddonStoryUnlockResponse);
});
router.post("/addonStage/battleStart", validateBody(addonStageBattleStartSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AddonStageBattleStartRequest;
  // 修复：把 battle.start 的结果（含 battleId）并入响应——若不回传 battleId，
  // 客户端结算时沿用上一次战斗的 battleId 解密 → 读错 battleInfo → 未知关卡空结算
  const result = await player.troop.addonStageBattleStart(body);
  res.send({ ...result, ...player.delta } satisfies AddonStageBattleStartResponse);
});
router.post("/addonStage/battleFinish", validateBody(addonStageBattleFinishSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AddonStageBattleFinishRequest;
  // 缺参校验：空 body 或缺 data/battleData 时返回业务错误（避免 battle:finish 读 undefined 崩溃）
  if (
    typeof body?.data !== "string" ||
    !body?.battleData ||
    typeof body.battleData.completeTime !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  const result = await player.troop.addonStageBattleFinish(body);
  res.send({
    ...(result && typeof result === "object" ? result : {}),
    ...player.delta,
  } satisfies AddonStageBattleFinishResponse);
});
router.post("/unlockEquipment", validateBody(unlockEquipmentSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UnlockEquipmentRequest;
  // 缺参校验：空 body 或缺 charInstId/equipId 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.equipId !== "string"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.unlockEquipment(body);
  res.send({ result: 0, ...player.delta } satisfies UnlockEquipmentResponse);
});
router.post("/upgradeEquipment", validateBody(upgradeEquipmentSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UpgradeEquipmentRequest;
  // 缺参校验：空 body 或缺 charInstId/equipId/targetLevel 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.equipId !== "string" ||
    typeof body?.targetLevel !== "number"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.upgradeEquipment(body);
  res.send({ result: 0, ...player.delta } satisfies UpgradeEquipmentResponse);
});
router.post("/setEquipment", validateBody(setEquipmentSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetEquipmentRequest;
  // 缺参校验：空 body 或缺 charInstId/equipId 时返回业务错误（避免 500）
  if (
    typeof body?.charInstId !== "number" ||
    typeof body?.equipId !== "string"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.setEquipment(body);
  res.send(player.delta satisfies SetEquipmentResponse);
});

router.post("/batchSetCharVoiceLan", validateBody(batchSetCharVoiceLanSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BatchSetCharVoiceLanRequest;
  await player.char.batchSetCharVoiceLan(body);
  res.send(player.delta satisfies BatchSetCharVoiceLanResponse);
});
router.post("/setCharVoiceLan", validateBody(setCharVoiceLanSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetCharVoiceLanRequest;
  // 缺参校验：空 body 或缺 charList/voiceLan 时返回业务错误（避免 forEach undefined 崩溃）
  if (
    !Array.isArray(body?.charList) ||
    typeof body?.voiceLan !== "string"
  ) {
    return res.send({ result: 1, ...player.delta });
  }
  await player.char.setCharVoiceLan(body);
  res.send(player.delta satisfies SetCharVoiceLanResponse);
});
router.post("/changeSkinSpState", validateBody(changeSkinSpStateSchema), async (req, res) => {
  const player = getPlayer();
  const { skinId, isSpecial } = req.body as ChangeCharSkinSpStateRequest;
  // 参考 OBS bp_charBuild.changeSkinSpState：skin.skinSp[skinId] = isSpecial
  await player.update(async (draft) => {
    const skin = draft.skin;
    // 修复：skin.skinSp 从未初始化（新存档/模板均无此字段）→ 原实现直接写 undefined 500
    if (!skin.skinSp) skin.skinSp = {};
    skin.skinSp[skinId] = isSpecial;
  });
  res.send(player.delta satisfies ChangeCharSkinSpStateResponse);
});
export default router;
