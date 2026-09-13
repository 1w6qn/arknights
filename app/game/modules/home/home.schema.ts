/**
 * 首页（home）请求 zod schema
 *
 * 对应 home.ts 的 Request 类型（参考 CS 2.7.61 协议类）。
 * 供 home/routes.ts 经 validateBody 做运行时校验：缺失必填字段 /
 * 类型不符时返回 HTTP 4xx，避免非法 body 传入控制器抛 500。
 *
 * 其余曾堆在本文件的跨域契约已随路由拆到各自独立模块的 *.schema.ts。
 */
import { z } from "zod";

/* ===== 主题与背景 ===== */

/** 更换首页主题请求（CS: SetHomeThemeRequest { themeId }） */
export const setHomeThemeSchema = z.object({
  themeId: z.string(),
});

/** 设置首页背景请求（CS: SetHomeBackgroundRequest { bgID }） */
export const setBackgroundSchema = z.object({
  bgID: z.string(),
});

/* ===== 设置 ===== */

/** 设置低电量模式请求（CS: SetLowPowerRequest { newValue }） */
export const setLowPowerSchema = z.object({
  newValue: z.number(),
});

/** 切换 NPC 语音请求（CS: ChangeRogueNpcVoiceLanRequest { id, voiceLan }） */
export const npcAudioChangeLanSchema = z.object({
  id: z.string(),
  voiceLan: z.string(),
});
