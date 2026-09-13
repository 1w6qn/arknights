/**
 * GM 兼容端点请求体 zod schema
 *
 * 字段名与归档 GM 面板（`gm.js`）逐字对齐（snake_case）；面板对「恢复/清除」类操作
 * 会发送 `null` body，validateBody 会先规整为 `{}`，故这些 schema 全部字段可选。
 */
import { z } from "zod";

/* ===== 赛季与活动 ===== */

/** 活动时钟（`{activity_id}`；null body = 恢复真实时间） */
export const gmActivityClockSchema = z.object({
  activity_id: z.string().nullable().optional(),
});

/** 活动切换（`{activity_id}`；null body = 取消强制开启） */
export const gmActivitySwitchSchema = z.object({
  activity_id: z.string().nullable().optional(),
});

/** 危机合约赛季（`{season_id}`；`{}` = 跟随配置） */
export const gmCrisisSeasonSchema = z.object({
  season_id: z.string().optional(),
});

/** 保全派驻赛季（`{player_id, season_id?}`） */
export const gmTowerSeasonSchema = z.object({
  player_id: z.string(),
  season_id: z.string().optional(),
});

/** 资源补丁开关（`{state:"on"|"off"}`） */
export const gmAssetPatchSchema = z.object({
  state: z.string(),
});

/* ===== 养成工具 ===== */

/** 博士等级（`{player_id, level}`，1..120 由服务层钳制） */
export const gmDoctorLevelSchema = z.object({
  player_id: z.string(),
  level: z.number(),
});

/** 仅玩家 ID（发放全部干员/皮肤/家具/商店货币、解锁全部关卡等） */
export const gmPlayerOnlySchema = z.object({
  player_id: z.string(),
});

/* ===== 干员调整 ===== */

/** 修改干员属性（字段与归档面板 executeChar 一致，未传不改） */
export const gmCharSchema = z.object({
  player_id: z.string(),
  char_id: z.string(),
  level: z.number().optional(),
  evolve_phase: z.number().optional(),
  favor_point: z.number().optional(),
  potential_rank: z.number().optional(),
  main_skill_lvl: z.number().optional(),
  skill_idx_lst: z.array(z.number()).optional(),
  specialize_level: z.number().optional(),
  equip_id_lst: z.array(z.string()).optional(),
  equip_level: z.number().optional(),
  tmpl_id: z.string().optional(),
});

/** 单干员满养成（`{player_id, char_id}`） */
export const gmCharMaxSchema = z.object({
  player_id: z.string(),
  char_id: z.string(),
});

/* ===== 物品发放/清理 ===== */

/** 清理物品（`{player_id, item_id?}`；缺 item_id = 清空整个仓库，货币/凭证/家具豁免） */
export const gmItemClearSchema = z.object({
  player_id: z.string(),
  item_id: z.string().optional(),
});

/** 邮件发放（`{player_id, items[], subject?, content?}`） */
export const gmMailGrantSchema = z.object({
  player_id: z.string(),
  items: z.array(z.object({ id: z.string(), count: z.number() })),
  subject: z.string().optional(),
  content: z.string().optional(),
});

/* ===== 集成战略 ===== */

/** 肉鸽难度（`{player_id, n}`） */
export const gmRlv2DifficultySchema = z.object({
  player_id: z.string(),
  n: z.number(),
});

/** 肉鸽藏品层数（`{player_id, relic_id, layer?}`） */
export const gmRlv2RelicLayerSchema = z.object({
  player_id: z.string(),
  relic_id: z.string(),
  layer: z.number().optional(),
});

/** 肉鸽干员增益（`{player_id, char_id, char_buff_id}`） */
export const gmRlv2CharBuffSchema = z.object({
  player_id: z.string(),
  char_id: z.string(),
  char_buff_id: z.string(),
});

/* ===== 沙盒管理 ===== */

/** 沙盒赛季（`{player_id, topic_id, season_idx}`） */
export const gmSandboxSeasonSchema = z.object({
  player_id: z.string(),
  topic_id: z.string(),
  season_idx: z.number(),
});

/** 沙盒敌潮（`{player_id, topic_id, enemy_id, node_id}`） */
export const gmSandboxEnemyRushSchema = z.object({
  player_id: z.string(),
  topic_id: z.string(),
  enemy_id: z.string(),
  node_id: z.string(),
});

/* ===== 数据重置 ===== */

/** 重置单个分区（`{player_id, key}`） */
export const gmResetKeySchema = z.object({
  player_id: z.string(),
  key: z.string(),
});

/** 恢复初始模板（`{player_id}`） */
export const gmResetAllSchema = z.object({
  player_id: z.string(),
});

/** 清空全部玩家存档（空 body；仅回环/允许远程时可用） */
export const gmResetDbSchema = z.object({});

/* ===== 卫戍协议（自走棋）GM ===== */

/** 自走棋 GM 指令（`{uid, code, params[]}`） */
export const gmAutochessGmSchema = z.object({
  uid: z.string().optional(),
  code: z.string(),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

/** 服务间：对局开始上报（Go 会话服 → 本服） */
export const gmAutochessBattleActiveSchema = z.object({
  uid: z.string(),
  sceneId: z.string().optional(),
  scene_id: z.string().optional(),
  squad: z.number().optional(),
  secretary: z.string().optional(),
  curRound: z.number().optional(),
  cur_round: z.number().optional(),
});

/** 服务间：对局结算上报 */
export const gmAutochessBattleSettledSchema = z.object({
  uid: z.string(),
  slot: z.number().optional(),
  mode: z.string().optional(),
  req: z.number().optional(),
});

/** 服务间：玩家名片（Go 会话服 → 本服） */
export const gmAutochessPlayerCardSchema = z.object({
  uid: z.string(),
});
