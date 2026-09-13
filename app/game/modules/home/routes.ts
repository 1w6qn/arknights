/**
 * 首页（home）路由模块
 *
 * 客户端无 /home 前缀，本 router 由 game/routes.ts 以 prefix:"/" 兜底挂载。
 * 原先堆在本文件的跨域端点已按 URL 域拆为独立模块（char / troop / story /
 * batchEvent / firework / car / templateTrap），本模块只保留 HomeManager
 * 自身的端点（首页主题、背景、低电量设置、NPC 语音）。
 * `/charRotation/*` 曾在本文件有一份与 character 模块重复的死副本，去重时已删除。
 */
import { Router } from "express";
import { getPlayer } from "../../kernel/http/request-context";
import { validateBody } from "@core/http/validate-body";
import {
  NpcAudioChangeLanRequest,
  NpcAudioChangeLanResponse,
  SetBackgroundRequest,
  SetBackgroundResponse,
  SetHomeThemeRequest,
  SetHomeThemeResponse,
  SetLowPowerRequest,
  SetLowPowerResponse,
} from "./home";
import {
  npcAudioChangeLanSchema,
  setBackgroundSchema,
  setHomeThemeSchema,
  setLowPowerSchema,
} from "./home.schema";

const router = Router();

/** 更换首页主题（CS: SetHomeThemeRequest { themeId }） */
router.post("/homeTheme/change", validateBody(setHomeThemeSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetHomeThemeRequest;
  await player.home.setHomeTheme(body);
  res.send(player.delta satisfies SetHomeThemeResponse);
});

/** 设置首页背景（CS: SetHomeBackgroundRequest { bgID }） */
router.post("/background/setBackground", validateBody(setBackgroundSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetBackgroundRequest;
  await player.home.setBackground(body);
  res.send(player.delta satisfies SetBackgroundResponse);
});

/** 设置低电量模式（CS: SetLowPowerRequest { newValue }） */
router.post("/setting/perf/setLowPower", validateBody(setLowPowerSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SetLowPowerRequest;
  await player.home.setLowPower(body);
  res.send(player.delta satisfies SetLowPowerResponse);
});

/** 切换 NPC 语音语言（CS: ChangeRogueNpcVoiceLanRequest { id, voiceLan }） */
router.post("/npcAudio/changeLan", validateBody(npcAudioChangeLanSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as NpcAudioChangeLanRequest;
  // 修复：缺 id/voiceLan 必填参数时返回业务错误，而非 500
  if (typeof body?.id !== "string" || typeof body?.voiceLan !== "string") {
    return res.send({ result: 1, ...player.delta });
  }
  await player.home.npcAudioChangeLan(body);
  res.send(player.delta satisfies NpcAudioChangeLanResponse);
});

export default router;
