/**
 * 管理 REST API 请求体 zod schema
 *
 * 供 app/ops/admin/admin-router.ts 的 POST/DELETE/PUT/PATCH 端点经 validateBody
 * 做运行时校验：缺失必填字段 / 类型不符时返回 HTTP 400，避免非法 body 传入
 * AdminService 抛 500。GET 端点基本只读（除个别用 query 参数），不在此列。
 *
 * 约定：
 * - schema 覆盖 handler 实际读取的 req.body 字段：必填用对应类型，可选用 .optional()。
 * - handler 会读内层字段的嵌套对象按被读字段收紧（如邮件 items 的 id/count），
 *   passthrough 保留其余字段；服务端整体透传/透传给官方 cgi 的（pixelData/body 等）
 *   用 z.json() 不做深检（pixelData 还被 validatePixelData 统一归一化多种形态）。
 * - 需将 req.body 中其余字段透传给控制器（如 setCharAttrs 的 ...attrs 展开）的，
 *   用 .passthrough() 保留未知字段，避免误删影响 handler 逻辑。
 * - 不读取 body 的端点用共享的 emptyObjectSchema（z.object({})）。
 */
import { z } from "zod";

/** 空请求体（handler 不读取 req.body 字段，仅约法校验存在即可） */
export const emptyObjectSchema = z.object({});

/* ===== 用户管理 ===== */

/** 创建用户（读 phone/password） */
export const createUserSchema = z.object({
  phone: z.string(),
  password: z.string(),
});

/** 禁用/启用用户（读 disabled） */
export const setUserDisabledSchema = z.object({
  disabled: z.boolean(),
});

/** 删除用户（读 confirmWord，须为 "DELETE" 防误删） */
export const deleteUserSchema = z.object({
  confirmWord: z.string(),
});

/** 发放物品（读 itemId/count） */
export const grantItemSchema = z.object({
  itemId: z.string(),
  count: z.number(),
});

/** 发放干员（读 charId） */
export const grantCharSchema = z.object({
  charId: z.string(),
});

/** 解锁皮肤（读 skinId） */
export const grantSkinSchema = z.object({
  skinId: z.string(),
});

/** 干员模组操作 unlock/upgrade/set（读 equipId/templateId/targetLevel） */
export const charModuleSchema = z.object({
  equipId: z.string(),
  templateId: z.string().optional(),
  targetLevel: z.number().optional(),
});

/** 重置签到（无 body） */
export const resetCheckInSchema = emptyObjectSchema;

/** 设置玩家推送标记（读 hasGifts 等红点/通知开关，数值以 0 清除） */
export const pushMessageSchema = z.object({
  hasGifts: z.number().optional(),
  hasFriendRequest: z.number().optional(),
  hasClues: z.number().optional(),
  hasFreeLevelGP: z.number().optional(),
});

/** 代签（无 body） */
export const doCheckInSchema = emptyObjectSchema;

/** 修改干员属性（读 instId，其余属性透传；用 passthrough 保留任意属性字段） */
export const setCharAttrsSchema = z.object({
  instId: z.number(),
}).passthrough();

/** 一键满配（无 body） */
export const maxOutAccountSchema = emptyObjectSchema;

/** 基建满级（无 body） */
export const buildingMaxSchema = emptyObjectSchema;

/** 基建加速（读 seconds：快进秒数，正整数） */
export const buildingAdvanceSchema = z.object({
  seconds: z.number(),
});

/** 创建备份（无 body） */
export const createBackupSchema = emptyObjectSchema;

/** 从备份恢复（读 backup） */
export const restoreSchema = z.object({
  backup: z.string(),
});

/** 发送邮件（读 uid/subject/content/items） */
export const sendMailSchema = z.object({
  uid: z.string(),
  subject: z.string(),
  content: z.string().optional(),
  // items 为附件条目列表——AdminService#sendMail 读 it.id/it.count 转 ItemBundle，
  // 故按被读字段收紧；passthrough 保留客户端附加字段（如 type）
  items: z
    .array(
      z.object({
        id: z.string(),
        count: z.number(),
      }).passthrough(),
    )
    .optional(),
});

/** 群发邮件（读 subject/content/items） */
export const sendMailAllSchema = z.object({
  subject: z.string(),
  content: z.string().optional(),
  // 同 sendMailSchema.items
  items: z
    .array(
      z.object({
        id: z.string(),
        count: z.number(),
      }).passthrough(),
    )
    .optional(),
});

/** 每日/每周刷新（无 body） */
export const refreshUserSchema = emptyObjectSchema;

/** 立即保存（无 body） */
export const saveUserSchema = emptyObjectSchema;

/** 肉鸽流程自动模拟（读 uid/theme/maxZone） */
export const rogueSimAutoSchema = z.object({
  uid: z.string(),
  theme: z.string(),
  maxZone: z.number().optional(),
});

/** 肉鸽流程分步模拟（读 uid/action/body） */
export const rogueSimStepSchema = z.object({
  uid: z.string(),
  action: z.string(),
  // body 为各 action 的透传参数，灵活结构不深检
  body: z.json().optional(),
});

/** 上帝视角实时修改（读 uid/ops：set|del|inc 路径补丁数组） */
export const rogueModifySchema = z.object({
  uid: z.string(),
  ops: z.array(
    z.object({
      op: z.enum(["set", "del", "inc"]),
      path: z.string(),
      value: z.json().optional(),
    }),
  ),
});

/** 切换活动（读 timestamp/forceOpen/crisisV1/crisisV2；forceOpen 兼容数组或逗号串） */
export const switchActivitySchema = z.object({
  timestamp: z.number().optional(),
  forceOpen: z.union([z.array(z.string()), z.string()]).optional(),
  crisisV1: z.string().optional(),
  crisisV2: z.string().optional(),
});

/** 启动资产补全（读 target/platform） */
export const backfillAssetsSchema = z.object({
  target: z.string(),
  platform: z.string().optional(),
});

/** CLI 集成执行（读 command） */
export const cliExecSchema = z.object({
  command: z.string(),
});

/** 游戏协议代理（读 uid/path/method；body 为透传的游戏请求，不深检） */
export const gameProxySchema = z.object({
  uid: z.string(),
  path: z.string(),
  method: z.string().optional(),
  body: z.json().optional(),
});

/** 设置玩家卡池 UP 选择（读 charIds） */
export const setPlayerPoolUpSchema = z.object({
  charIds: z.array(z.string()).optional(),
});

/** 设置玩家保底计数（读 ruleType/count） */
export const setPlayerPitySchema = z.object({
  ruleType: z.string(),
  count: z.number(),
});

/* ===== 官服操作 ===== */

/** 官服账号迁移（读 accounts/templateUid） */
export const migrateOfficialSchema = z.object({
  accounts: z.string().optional(),
  templateUid: z.string().optional(),
});

/** 官服枢纽宠物还原（读 uid/rid/officialUid；rid、officialUid 可选） */
export const arkhubImportPetsSchema = z.object({
  uid: z.string(),
  rid: z.string().optional(),
  officialUid: z.string().optional(),
});

/** 官服操作（读 phone/pwd/action） */
export const officialActionSchema = z.object({
  phone: z.string(),
  pwd: z.string(),
  action: z.string(),
});

/** 官服通用 API 调用（读 phone/pwd/cgi；body 为透传官方 cgi 请求，不深检） */
export const officialCallSchema = z.object({
  phone: z.string(),
  pwd: z.string(),
  cgi: z.string(),
  body: z.json().optional(),
});

/** 从官服同步卡池（读 phone/pwd/poolIds/refresh） */
export const syncGachaPoolSchema = z.object({
  phone: z.string(),
  pwd: z.string(),
  poolIds: z.array(z.string()).optional(),
  refresh: z.boolean().optional(),
});

/** 上传像素画官服（读 phone/pwd；pixelData 为复杂像素结构） */
export const uploadPixelArtSchema = z.object({
  phone: z.string(),
  pwd: z.string(),
  pixelData: z.json(),
});

/** 批量上传像素画官服（读 phone/pwd/pixelDataList） */
export const uploadPixelArtBatchSchema = z.object({
  phone: z.string(),
  pwd: z.string(),
  pixelDataList: z.array(z.json()).optional(),
});

/** 读取官服已上传像素画（读 phone/pwd/pixelArtIds） */
export const listPixelArtSchema = z.object({
  phone: z.string(),
  pwd: z.string(),
  pixelArtIds: z.array(z.number()).optional(),
});

/** 撤销官服像素画（读 phone/pwd/pixelArtIds） */
export const deletePixelArtSchema = z.object({
  phone: z.string(),
  pwd: z.string(),
  pixelArtIds: z.array(z.number()).optional(),
});

/* ===== 用户进阶操作 ===== */

/** 批量发放全部物品（读 count，缺省 999） */
export const grantAllItemsSchema = z.object({
  count: z.number().optional(),
});

/** 批量拉满全部已有干员（无 body） */
export const maxAllCharsSchema = emptyObjectSchema;

/** 修复干员结构（无 body） */
export const repairCharsSchema = emptyObjectSchema;

/** 解锁指定关卡（读 stageId） */
export const unlockStageSchema = z.object({
  stageId: z.string(),
});

/** 推图全解锁（无 body） */
export const unlockAllStagesSchema = emptyObjectSchema;

/** 导出用户存档（读 path，可选） */
export const exportUserSchema = z.object({
  path: z.string().optional(),
});

/** 导入存档（读 filePath/uid，uid 可选） */
export const importUserSchema = z.object({
  filePath: z.string(),
  uid: z.string().optional(),
});

/** 删除单封邮件（无 body，仅用路径参数） */
export const deleteMailSchema = emptyObjectSchema;

/* ===== 抓包 / 日志管理 ===== */

/** 新建抓包会话（读 name/source/note） */
export const createCaptureSessionSchema = z.object({
  name: z.string().optional(),
  source: z.string().optional(),
  note: z.string().optional(),
});

/** 停止抓包会话（无 body） */
export const stopCaptureSessionSchema = emptyObjectSchema;

/** 删除抓包会话（无 body） */
export const deleteCaptureSessionSchema = emptyObjectSchema;

/** 删除单条抓包记录（无 body） */
export const deleteCaptureRecordSchema = emptyObjectSchema;

/** 清空全部抓包（读 confirmWord="CLEAR" 确认） */
export const captureClearSchema = z.object({
  confirmWord: z.string().optional(),
});

/** 清空服务器日志（读 confirmWord="CLEAR" 确认） */
export const logClearSchema = z.object({
  confirmWord: z.string().optional(),
});

/* ===== 插件管理 ===== */

/** 启用插件（无 body） */
export const enablePluginSchema = emptyObjectSchema;

/** 停用插件（无 body） */
export const disablePluginSchema = emptyObjectSchema;