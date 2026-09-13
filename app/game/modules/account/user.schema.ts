/**
 * 用户（user）请求 zod schema
 *
 * 对应 protocol/user.ts 的 Request 类型（参考 CS 2.7.61 协议类）以及
 * router/user.ts rootRouter 中一些仅有内联类型的服务端自定义接口。
 * 供 router/user.ts 经 validateBody 做运行时校验：缺失必填字段 /
 * 类型不符时返回 HTTP 4xx，避免非法 body 传入控制器抛 500。
 */
import { z } from "zod";

/* ===== default 路由 ===== */

/** 更换秘书干员请求（CS: ChangeSecretaryRequest { charInstId, skinId }） */
export const changeSecretarySchema = z.object({
  charInstId: z.number(),
  skinId: z.string(),
});

/**
 * 更换头像请求（CS: ChangeAvatarRequest { avatar }）
 *
 * avatar 为生成类型 AvatarInfo（app/game/excel/types-playerdata.ts）——服务端仅整体
 * 存入 status.avatar、不读内层字段，故用 z.json() 透传，避免手抄生成类型造成漂移。
 */
export const changeAvatarSchema = z.object({
  avatar: z.json(),
});

/** 更换简介请求（CS: ChangeResumeRequest { resume }） */
export const changeResumeSchema = z.object({
  resume: z.string(),
});

/** 绑定昵称请求（服务端自定义，管理器按 nickName 读取） */
export const bindNickNameSchema = z.object({
  nickName: z.string(),
});

/** 使用改名卡请求（CS: UseRenameCardRequest { itemId, instId, nickName }） */
export const useRenameCardSchema = z.object({
  itemId: z.string(),
  instId: z.number(),
  nickName: z.string(),
});

/** 领取团队收集奖励请求（CS: ReceiveTeamCollectionRewardRequest { rewardId }） */
export const receiveTeamCollectionRewardSchema = z.object({
  rewardId: z.string(),
});

/** 购买理智请求（CS: BuyApRequest，空请求体） */
export const buyApSchema = z.object({});

/** 兑换源石碎片请求（CS: ExchangeDiamondShardRequest { count }） */
export const exchangeDiamondShardSchema = z.object({
  count: z.number(),
});

/** 使用单个物品请求（CS: UseItemRequest；字段名为 cnt，兼容 count，二者均可选） */
export const useItemSchema = z.object({
  instId: z.number(),
  itemId: z.string(),
  cnt: z.number().optional(),
  count: z.number().optional(),
});

/** 使用多个物品请求（CS: UseItemsRequest { items }） */
export const useItemsSchema = z.object({
  items: z.array(
    z.object({
      instId: z.number(),
      itemId: z.string(),
      cnt: z.number(),
    }),
  ),
});

/** 签到请求（对应 ServiceCode CHECKIN_HOME，空请求体） */
export const checkInSchema = z.object({});

/** 绑定生日请求（CS: UI.Birthday.BirthdaySettingRequest { month, day }） */
export const bindBirthdaySchema = z.object({
  month: z.number(),
  day: z.number(),
});

/* ===== rootRouter 路由 ===== */

/** 领取勋章奖励请求（服务端自定义 { medalId, group }） */
export const rewardMedalSchema = z.object({
  medalId: z.string(),
  group: z.string(),
});

/** 解锁主线线索请求（服务端自定义 { id }）；readClue/getRewards 同结构复用 */
export const unlockClueSchema = z.object({
  id: z.string(),
});

/** 领取长期签到奖励请求（CS: ReceiveLongTermCheckInRewardRequest { groupId }） */
export const recvLongTermCheckInRewardSchema = z.object({
  groupId: z.string(),
});

/** 进入角色语音记录请求（服务端自定义 { topicId }） */
export const enterCharVoiceRecordSchema = z.object({
  topicId: z.string(),
});

/** 领取语音记录节点奖励请求（服务端自定义 { topicId, nodeId }） */
export const confirmCharVoiceRecordRewardSchema = z.object({
  topicId: z.string(),
  nodeId: z.string(),
});

/** 演出剧情开始请求（CS: PerformanceStoryRequest { storyId }） */
export const startStorySchema = z.object({
  storyId: z.string(),
});

/** 确认分享任务请求（服务端自定义 { shareMissionId }） */
export const confirmShareMissionSchema = z.object({
  shareMissionId: z.string(),
});

/** 特勤干员解锁节点请求（服务端自定义 { instId, nodeId }） */
export const specialOperatorUnlockNodeSchema = z.object({
  instId: z.string(),
  nodeId: z.string(),
});

/** 领取线索奖励请求（CS: Anniv7thGetRewardsRequest { ids }；兼容旧单 id 写法） */
export const getRewardsSchema = z.object({
  ids: z.array(z.string()).optional(),
  id: z.string().optional(),
});

/** 获取 CG 收藏列表请求（服务端自定义，空请求体） */
export const getCgCollectionSchema = z.object({});

/** 添加/移除 CG 收藏请求（服务端自定义 { cgId }） */
export const cgCollectionSchema = z.object({
  cgId: z.string(),
});

/** 获取画廊首通奖励请求（服务端自定义，空请求体） */
export const getFirstRewardsSchema = z.object({});

/** 获取杂志缩略图 URL 请求（服务端自定义 { idList }） */
export const getThumbnailUrlSchema = z.object({
  idList: z.array(z.string()),
});

/** 修改杂志编队请求（服务端自定义，空请求体） */
export const changeMagazineSquadSchema = z.object({});

/**
 * 保存自定义杂志请求（V1/V2）
 *
 * magazine 按 handler（user/routes.ts#saveDiyMagazine / persistGalleryThumbnail）实际
 * 读取的字段收紧：leafId（页 ID）、decorList（装饰列表）、charSkin；三项内层结构服务端
 * 不读，整体透传存储。passthrough 保留客户端附加字段，thumbnail 为 base64 缩略图（可选）。
 */
export const saveDiyMagazineSchema = z.object({
  magazine: z
    .object({
      leafId: z.string().optional(),
      charSkin: z.json().optional(),
      decorList: z.array(z.json()).optional(),
    })
    .passthrough(),
  thumbnail: z.string().optional(),
});

/** 设置勋章自定义数据请求（CS: MedalSetCustomDataRequest { index?, data }）；data 复杂，用 z.json() */
export const medalSetCustomDataSchema = z.object({
  index: z.string().optional(),
  data: z.json(),
});

/** 领取画廊收集奖励请求（CS: ArtMagazineGetCollectionRewardsRequest { setId?, missionId? }） */
export const getCollectionRewardsSchema = z.object({
  setId: z.string().optional(),
  missionId: z.string().optional(),
});
