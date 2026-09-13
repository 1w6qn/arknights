/**
 * 用户路由
 * 请求/响应类型见 @game/modules/account/user（参考 CS 2.7.61 协议类）
 */
import { Router } from "express";
import type { Draft } from "mutative";
import { getPlayer, getPlayerOptional } from "../../kernel/http/request-context";
import { PlayerDataManager } from "../../kernel/PlayerDataManager";
import type { PlayerDataModel } from "../../kernel/playerdata";
import { parseMultipartForm } from "../../kernel/util/multipart";
import excel from "@excel/excel";
import { ItemBundle } from "@excel/excel";
import { isJsonObject, type JsonValue } from "@excel/json-value";
import { now } from "@utils/time";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cgCollectionStore } from "./cg-store";
import {
  AddCgCollectionRequest,
  AddCgCollectionResponse,
  BindBirthdayRequest,
  BindBirthdayResponse,
  BindNickNameRequest,
  BindNickNameResponse,
  BuyApRequest,
  BuyApResponse,
  ChangeAvatarRequest,
  ChangeAvatarResponse,
  ChangeMagazineSquadRequest,
  ChangeMagazineSquadResponse,
  ChangeResumeRequest,
  ChangeResumeResponse,
  ChangeSecretaryRequest,
  ChangeSecretaryResponse,
  CheckInHomeRequest,
  CheckInHomeResponse,
  ConfirmShareMissionRequest,
  ConfirmCharVoiceRecordRewardRequest,
  ConfirmCharVoiceRecordRewardResponse,
  EnterCharVoiceRecordRequest,
  EnterCharVoiceRecordResponse,
  ExchangeDiamondShardRequest,
  ExchangeDiamondShardResponse,
  GetCgCollectionRequest,
  GetCgCollectionResponse,
  GetClueRewardsRequest,
  GetClueRewardsResponse,
  GetCollectionRewardsRequest,
  GetCollectionRewardsResponse,
  GetFirstRewardsRequest,
  GetFirstRewardsResponse,
  GetThumbnailUrlRequest,
  GetThumbnailUrlResponse,
  ItemGet,
  MedalSetCustomDataRequest,
  MedalSetCustomDataResponse,
  ReceiveTeamCollectionRewardRequest,
  ReceiveTeamCollectionRewardResponse,
  RecvLongTermCheckInRewardRequest,
  RecvLongTermCheckInRewardResponse,
  RemoveCgCollectionRequest,
  RemoveCgCollectionResponse,
  RewardItemModel,
  RewardMedalRequest,
  RewardMedalResponse,
  SaveDiyMagazineRequest,
  SaveDiyMagazineResponse,
  ServerTimeResponse,
  SpecialOperatorUnlockNodeRequest,
  StartStoryRequest,
  UnlockClueRequest,
  UnlockClueResponse,
  UseItemRequest,
  UseItemResponse,
  UseItemsRequest,
  UseItemsResponse,
  UseRenameCardRequest,
  UseRenameCardResponse,
} from "../account/user";
import { validateBody } from "../../kernel/http/validate-body";
import {
  bindBirthdaySchema,
  bindNickNameSchema,
  buyApSchema,
  changeAvatarSchema,
  changeMagazineSquadSchema,
  changeResumeSchema,
  changeSecretarySchema,
  cgCollectionSchema,
  checkInSchema,
  confirmCharVoiceRecordRewardSchema,
  confirmShareMissionSchema,
  enterCharVoiceRecordSchema,
  exchangeDiamondShardSchema,
  getCgCollectionSchema,
  getCollectionRewardsSchema,
  getFirstRewardsSchema,
  getRewardsSchema,
  getThumbnailUrlSchema,
  medalSetCustomDataSchema,
  pixelArtReviewSchema,
  receiveTeamCollectionRewardSchema,
  recvLongTermCheckInRewardSchema,
  rewardMedalSchema,
  saveDiyMagazineSchema,
  specialOperatorUnlockNodeSchema,
  startStorySchema,
  unlockClueSchema,
  useItemSchema,
  useItemsSchema,
  useRenameCardSchema,
} from "../account/user.schema";


/** 1x1 透明 PNG（静态图片占位） */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * 杂志页服务端视图
 *
 * 客户端透传字段（charSkin/decorList 未经建模），写入 gallery.leafMap 与缩略图落盘共用。
 * 值域用 JsonValue：这里确实是「客户端任意 JSON」的 I/O 边界，消费侧仅做存转不作结构假设。
 */
interface MagazineView {
  leafId?: string;
  charSkin?: JsonValue;
  decorList?: JsonValue;
}

/**
 * 将未知 JSON 收窄为杂志视图
 *
 * V1 body 已声明结构、V2（JSON/multipart）为 unknown，统一在此收窄：
 * 非对象返回 undefined（调用侧按「无 magazine」处理，与旧实现 `magazine?.leafId` 等价）。
 *
 * @param value - 待收窄的杂志负载
 * @returns 杂志视图；非对象时为 undefined
 */
function asMagazineView(value: unknown): MagazineView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const rec = value as Record<string, JsonValue>;
  return {
    leafId: typeof rec.leafId === "string" ? rec.leafId : undefined,
    charSkin: rec.charSkin,
    decorList: rec.decorList,
  };
}

/**
 * 画廊叶子页服务端视图
 *
 * charSkin 服务端写 null（生成类型为必填元素结构）、decorList 为客户端透传元素——
 * 两者保留 `unknown`：此处是「客户端任意 JSON 落存档」的 I/O 边界，且用 unknown 才能
 * 让生成模型 Draft<PlayerArtMagazineLeafData> 与视图互相收窄（JsonValue 因递归不可用于 Draft）。
 */
interface GalleryLeafView {
  leafId: string;
  charSkin: unknown;
  decorList: unknown;
  getTs: number;
  version: number;
}

/**
 * 画廊服务端视图
 *
 * 生成类型 PlayerGallery 是客户端模型：firstRewards 声明为 number 而服务端写布尔 false/true；
 * 子表（magazineSquad/collectionRewards）服务端惰性建键 → 可选。
 */
interface GalleryView {
  firstRewards: number | boolean;
  leafMap: { [key: string]: GalleryLeafView };
  magazineSquad?: string[];
  collectionRewards?: { [key: string]: number };
}

/**
 * 形艺特辑杂志缩略图存储目录
 *
 * 编辑保存的 base64 缩略图以 `{uid}_magazine_{leafId}.jpg` 落盘于此，
 * 展示环节（getThumbnailUrl /gallery/jpg）据此回传真实图片，形成编辑→展示闭环。
 * 该目录属持久化用户数据，随 data/user 一并管理。
 */
const GALLERY_DIR = "./data/user/gallery";

/**
 * 生成杂志缩略图文件名（对齐参考实现 `{uid}_magazine_{leafId}.jpg`）
 *
 * @param uid - 玩家 uid
 * @param leafId - 杂志页 ID
 * @returns 缩略图文件名
 */
function galleryThumbnailName(uid: string, leafId: string): string {
  return `${uid}_magazine_${leafId}.jpg`;
}

/**
 * 将客户端上传的 base64 缩略图落盘为 jpg
 *
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py gallery.saveDiyMagazineV1._b64_to_jpg
 * @param uid - 玩家 uid
 * @param leafId - 杂志页 ID
 * @param base64Data - base64 编码的 jpg 数据（可含 data URI 前缀）
 */
function saveGalleryThumbnail(uid: string, leafId: string, base64Data: string): void {
  // 解析 base64：剥离 data URI 前缀（如 data:image/jpeg;base64,）并移除空白
  let code = base64Data;
  if (code.includes(",")) code = code.split(",")[1];
  code = code.replace(/\s/g, "");
  if (!code) return;
  // 补齐 base64 填充位，避免解码报错
  const padding = 4 - (code.length % 4);
  if (padding !== 4) code += "=".repeat(padding);

  mkdirSync(GALLERY_DIR, { recursive: true });
  writeFileSync(join(GALLERY_DIR, galleryThumbnailName(uid, leafId)), Buffer.from(code, "base64"));
}

/**
 * 删除指定杂志页的缩略图（页面内容清空时清理磁盘残留）
 *
 * @param uid - 玩家 uid
 * @param leafId - 杂志页 ID
 */
function removeGalleryThumbnail(uid: string, leafId: string): void {
  const filepath = join(GALLERY_DIR, galleryThumbnailName(uid, leafId));
  if (existsSync(filepath)) unlinkSync(filepath);
}

/**
 * 编辑后同步缩略图到磁盘
 *
 * 有 thumbnail 则保存；页面内容为空且无 thumbnail 时删除残留（页面被清空）。
 * 已在 player.update 之外调用，文件 IO 不进入 immer 草稿更新。
 *
 * @param uid - 玩家 uid
 * @param magazine - 杂志数据（leafId/charSkin/decorList）
 * @param thumbnail - 客户端上传的 base64 缩略图（可为空）
 */
function persistGalleryThumbnail(
  uid: string,
  magazine: MagazineView | undefined,
  thumbnail?: string,
): void {
  const leafId = magazine?.leafId;
  if (!leafId) return;
  const decorList = Array.isArray(magazine?.decorList) ? magazine.decorList : [];
  const hasContent = magazine?.charSkin != null || decorList.length > 0;
  if (thumbnail) {
    saveGalleryThumbnail(uid, leafId, thumbnail);
  } else if (!hasContent) {
    removeGalleryThumbnail(uid, leafId);
  }
}

/** 构造请求基准 URL（协议请求的主机前缀），用于生成缩略图绝对地址 */
function requestBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  return `${req.protocol}://${req.get("host")}`;
}

/**
 * 收集请求原始字节流（multipart 等非 JSON body）
 *
 * express.json 只解析 application/json，multipart 请求的 req.body 为空；
 * capture 模式已捕获 rawBody 时直接取用，否则监听 stream 逐块收齐原始字节。
 */
function collectRawBody(req: import("express").Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 解析 multipart/form-data 的杂志保存负载（saveDiyMagazineV2 专用）
 *
 * 客户端 V2 走 form-data（抓包 content-level ~49KB：含缩略图图片部分）。复用 arkhub
 * savePixelArt 的极简 multipart 解析：主负载 `json` part（含 magazine/magazineSquad），
 * thumbnail 图片 part 转 base64 data URI；规避 express.json 无法解析 multipart 的问题。
 *
 * @param req - Express 请求（读取 content-type 与原始裸体）
 * @returns 解析结果；非 multipart 或无可解析 part 时返回 null
 */
async function parseMagazineMultipart(req: import("express").Request): Promise<{
  magazine?: JsonValue;
  thumbnail?: string;
  magazineSquad?: JsonValue[];
  squad?: JsonValue[];
} | null> {
  const raw = req.rawBody ?? (await collectRawBody(req));
  const parts = parseMultipartForm(raw, req.headers["content-type"]);
  if (parts.size === 0) return null;

  // 主负载：优先 `json` part（对齐 savePixelArt 约定），其次常见别名
  let payload: JsonValue = {};
  const jsonPart = parts.get("json") ?? parts.get("data") ?? parts.get("payload");
  if (jsonPart) {
    try {
      payload = JSON.parse(jsonPart.toString("utf-8")) as JsonValue;
    } catch {
      payload = {};
    }
  }
  // 非对象负载（字符串/数组/null）与旧实现同样取不到任何字段
  const fields = isJsonObject(payload) ? payload : {};

  // thumbnail：独立二进制图片 part → base64 data URI
  let thumbnail = typeof fields.thumbnail === "string" ? fields.thumbnail : undefined;
  if (parts.get("thumbnail")) {
    thumbnail = `data:image/jpeg;base64,${parts.get("thumbnail")!.toString("base64")}`;
  }

  // magazine：主负载字段，或独立 JSON part
  let magazine: JsonValue | undefined = fields.magazine;
  if (!magazine && parts.get("magazine")) {
    const mPart = parts.get("magazine")!.toString("utf-8");
    try {
      magazine = JSON.parse(mPart) as JsonValue;
    } catch {
      magazine = mPart;
    }
  }

  // magazineSquad：主负载字段，或独立 JSON part
  let magazineSquad: JsonValue[] | undefined = Array.isArray(fields.magazineSquad)
    ? fields.magazineSquad
    : undefined;
  if (!magazineSquad && parts.get("magazineSquad")) {
    try {
      const parsed = JSON.parse(parts.get("magazineSquad")!.toString("utf-8")) as JsonValue;
      magazineSquad = Array.isArray(parsed) ? parsed : undefined;
    } catch {
      magazineSquad = undefined;
    }
  }
  // squad：官服 changeMagazineSquad 请求字段（R-1787473456620-0040），multipart 时同样兼容
  let squad: JsonValue[] | undefined;
  if (Array.isArray(fields.squad)) {
    squad = fields.squad;
  } else if (parts.get("squad")) {
    try {
      const parsed = JSON.parse(parts.get("squad")!.toString("utf-8")) as JsonValue;
      squad = Array.isArray(parsed) ? parsed : undefined;
    } catch {
      squad = undefined;
    }
  }

  return { magazine, thumbnail, magazineSquad, squad };
}

const router = Router();

/** 更换秘书干员（CS: ChangeSecretaryRequest） */
router.post("/changeSecretary", validateBody(changeSecretarySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeSecretaryRequest;
  await player.status.changeSecretary(body);
  res.send(player.delta satisfies ChangeSecretaryResponse);
});

/** 更换头像（CS: ChangeAvatarRequest） */
router.post("/changeAvatar", validateBody(changeAvatarSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeAvatarRequest;
  await player.status.changeAvatar(body);
  res.send(player.delta satisfies ChangeAvatarResponse);
});

/** 更换简介（CS: ChangeResumeRequest） */
router.post("/changeResume", validateBody(changeResumeSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ChangeResumeRequest;
  // 修复：移除"resume 以 @ 开头触发任意内部事件"的后门——客户端可借此触发
  // 任意事件（@refresh:daily/@char:get/@items:get 等）破坏状态或 500。
  // 一律按普通简介文本处理；非字符串入参防御（避免 .slice 崩溃）
  const resume = typeof body?.resume === "string" ? body.resume : "";
  await player.status.changeResume({ resume } as ChangeResumeRequest);
  res.send(player.delta satisfies ChangeResumeResponse);
});

/** 绑定昵称（服务端自定义） */
router.post("/bindNickName", validateBody(bindNickNameSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BindNickNameRequest;
  const nickName = body.nickName;
  // 修复：缺 nickName 必填参数时返回业务错误，而非 500
  if (typeof nickName !== "string" || nickName.length === 0) {
    return res.send({ result: 1 } satisfies BindNickNameResponse);
  }
  let result = 0;
  const specialChars = "~!@#$%^&*()_+{}|:\"<>?[]\\;',./";
  if (nickName.length > 16) {
    result = 1;
  }

  if (Array.from(specialChars).some((char) => nickName.includes(char))) {
    result = 2;
  }

  const sensitiveWords = ["admin", "ban", "banned", "forbidden", "root"];
  if (sensitiveWords.includes(nickName.toLowerCase())) {
    result = 3;
  }
  if (result !== 0) res.send({ result } satisfies BindNickNameResponse);
  else {
    // 修复（类型收紧暴露出真实缺陷）：客户端/schema 字段为 nickName，而管理器契约读取
    // nickname——旧实现用 `as unknown as { nickname: string }` 把 body 原样透传，
    // 运行时 args.nickname 恒为 undefined → 绑定昵称静默失效（与 useRenameCard 同源写法不一致）。
    await player.status.bindNickName({ nickname: body.nickName });
    res.send(player.delta satisfies BindNickNameResponse);
  }
});

/** 使用改名卡（CS: UseRenameCardRequest） */
router.post("/useRenameCard", validateBody(useRenameCardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UseRenameCardRequest;
  await player.status.bindNickName({ nickname: body.nickName });
  player.gainItem.setTarget(body.itemId, undefined, 1, body.instId);
  await player.gainItem.use();
  res.send(player.delta satisfies UseRenameCardResponse);
});

/** 领取团队收集奖励（CS: ReceiveTeamCollectionRewardRequest） */
router.post("/receiveTeamCollectionReward", validateBody(receiveTeamCollectionRewardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ReceiveTeamCollectionRewardRequest;
  await player.status.receiveTeamCollectionReward(body);
  res.send(player.delta satisfies ReceiveTeamCollectionRewardResponse);
});

/** 购买理智（CS: BuyApRequest） */
router.post("/buyAp", validateBody(buyApSchema), async (req, res) => {
  const player = getPlayer();
  req.body as BuyApRequest;
  const ok = await player.status.buyAp();
  if (!ok) {
    return res.send({ result: 1, ...player.delta } satisfies BuyApResponse);
  }
  res.send(player.delta satisfies BuyApResponse);
});

/** 兑换源石碎片（CS: ExchangeDiamondShardRequest） */
router.post("/exchangeDiamondShard", validateBody(exchangeDiamondShardSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as ExchangeDiamondShardRequest;
  // 修复：负数 count 绕过余额守卫（_useItem 取反后反向入账 → 免费刷源石）；非法入参直接拒绝
  if (typeof body?.count !== "number" || !Number.isInteger(body.count) || body.count <= 0) {
    return res.status(400).send({ status: 1, msg: "非法参数" });
  }
  if (player._playerdata.status.androidDiamond < body.count) {
    res.send({
      result: 1,
      errMsg: "至纯源石不足，是否前往商店购买至纯源石？",
    } satisfies ExchangeDiamondShardResponse);
  } else {
    await player.status.exchangeDiamondShard(body);
    res.send(player.delta satisfies ExchangeDiamondShardResponse);
  }
});

/** 使用单个物品（CS: UseItemRequest；字段名为 cnt，兼容 count） */
router.post("/useItem", validateBody(useItemSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UseItemRequest;
  // 修复：客户端字段为 cnt（CS UseItemRequest 字段名）——原实现读 count 恒 undefined，
  // 负数校验直接把所有单物品使用打成 400（AP 补给/凭证等全部无法消耗）
  const count = body?.cnt ?? body?.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
    return res.status(400).send({ status: 1, msg: "非法参数" });
  }
  player.gainItem.setTarget(body.itemId, undefined, count, body.instId);
  await player.gainItem.use();
  res.send(player.delta satisfies UseItemResponse);
});

/** 使用多个物品（CS: UseItemsRequest） */
router.post("/useItems", validateBody(useItemsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UseItemsRequest;
  if (
    !Array.isArray(body?.items) ||
    body.items.some(
      (item) =>
        typeof item?.cnt !== "number" ||
        !Number.isInteger(item.cnt) ||
        item.cnt <= 0,
    )
  ) {
    return res.status(400).send({ status: 1, msg: "非法参数" });
  }
  for (const item of body.items) {
    player.gainItem.setTarget(item.itemId, undefined, item.cnt, item.instId);
  }
  await player.gainItem.use();
  res.send(player.delta satisfies UseItemsResponse);
});

/** 签到（CS ServiceCode: CHECKIN_HOME） */
router.post("/checkIn", validateBody(checkInSchema), async (req, res) => {
  const player = getPlayer();
  req.body as CheckInHomeRequest;
  res.send({
    ...(await player.checkIn.checkIn()),
    ...player.delta,
  } satisfies CheckInHomeResponse);
});

// ==================== 新增路由 ====================

/**
 * 绑定生日
 *
 * 设置玩家 status 中的生日信息（月份与日期）。
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py bindBirthday
 *
 * 路径：POST /user/bindBirthday
 * @param req.body.month - 生日月份
 * @param req.body.day - 生日日期
 * @returns playerDataDelta（包含 status.birthday 的变更）
 */
router.post("/bindBirthday", validateBody(bindBirthdaySchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as BindBirthdayRequest;
  const { month, day } = body;
  await player.update(async (draft) => {
    draft.status.birthday = {
      month: Number(month),
      day: Number(day),
    };
  });
  res.send(player.delta satisfies BindBirthdayResponse);
});

export { router };
export default router;

// ==================== 根级路由 ====================
//
// 以下路由在参考实现（user.py）中定义，但其 URL 路径并不挂在 /user 前缀下
// （例如 /gallery/*、/cg/*、/medal/*、/mainlineClue/*、/general/v1/server_time）。
// 因此通过独立的 rootRouter 导出，并在 app.ts 中挂载到根路径 "/"。
//
// 注意：gallery 与 mainline 字段已在 types-playerdata.ts 的生成模型中声明，
// 直接经 Draft 访问即可保证 Immer 追踪变更并生成 delta（无需再 `as any`）。

/**
 * 服务器内 CG 收藏集合（内存态）
 *
 * 参考实现中 cgList 存储于 server_data（SERVER_DATA_PATH），为全服共享数据。
 * 此处简化为模块级内存 Set，进程重启后不持久化。
 */
/** 根级路由实例，挂载非 /user 前缀的用户相关接口 */
export const rootRouter = Router();

/**
 * 领取勋章奖励
 *
 * 调用 MedalManager.rewardMedal 发放对应奖励组物品（items:get），
 * 并记录领取时间戳 rts（防重复领取）。
 *
 * 路径：POST /medal/rewardMedal
 */
rootRouter.post("/medal/rewardMedal", validateBody(rewardMedalSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RewardMedalRequest;
  const items = await player.medal.rewardMedal(body);
  res.send({
    items,
    ...player.delta,
  } satisfies RewardMedalResponse);
});

/**
 * 解锁主线线索
 *
 * 将指定线索的解锁状态设置为 2（已解锁）。
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py mainlineClue.unlockClue
 *
 * 路径：POST /mainlineClue/unlockClue
 * @param req.body.id - 线索 ID
 * @returns playerDataDelta（包含 mainline.clue.state 的变更）
 */
rootRouter.post("/mainlineClue/unlockClue", validateBody(unlockClueSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as UnlockClueRequest;
  const { id } = body;
  await player.update(async (draft) => {
    const mainline = draft.mainline;
    if (!mainline.clue) {
      mainline.clue = { unlock: false, state: {}, reward: {} };
    }
    mainline.clue.state[id] = 2;
  });
  res.send(player.delta satisfies UnlockClueResponse);
});

/**
 * 领取长期签到奖励
 * CS: Torappu.UI.LongTermCheckIn.ReceiveLongTermCheckInRewardRequest { groupId }
 * 条件：活动已开启（now >= constData.startTs）且 status.level >= group.level
 * 且 checkIn.showCount >= group.days 且 longTermRecvRecord 未领。
 * 发放后写 longTermRecvRecord[groupId]（幂等），响应 { rewards, ...delta }。
 */
rootRouter.post("/user/recvLongTermCheckInReward", validateBody(recvLongTermCheckInRewardSchema), async (req, res) => {
  const player = getPlayer();
  const { groupId } = req.body as RecvLongTermCheckInRewardRequest;
  const ltData = excel.OpenServerTable?.longTermCheckInData as
    | {
        groupList?: Array<{ groupId: string; level: number; days: number; rewardList: ItemBundle[] }>;
        constData?: { startTs: number };
      }
    | undefined;
  const group = ltData?.groupList?.find((g) => g.groupId === groupId);
  if (!group || !ltData?.constData || now() < ltData.constData.startTs) {
    return res.send({ ...player.delta, rewards: [] } as RecvLongTermCheckInRewardResponse);
  }
  await player.checkIn.ensureShowCount();
  let granted = false;
  await player.update(async (draft) => {
    draft.checkIn.longTermRecvRecord = draft.checkIn.longTermRecvRecord ?? {};
    if (draft.checkIn.longTermRecvRecord[groupId] != null) return;
    const days = draft.checkIn.showCount ?? 0;
    const level = draft.status.level ?? 0;
    if (level < group.level || days < group.days) return;
    draft.checkIn.longTermRecvRecord[groupId] = now();
    granted = true;
  });
  const rewards: RewardItemModel[] = [];
  if (granted) {
    for (const item of group.rewardList ?? []) player.gainItem.add(item);
    await player.gainItem.handle();
    for (const item of group.rewardList ?? []) {
      rewards.push({ type: item.type, id: item.id, count: item.count });
    }
  }
  res.send({ rewards, ...player.delta } satisfies RecvLongTermCheckInRewardResponse);
});

/**
 * 语音档案条目（服务端自建；形状见 scripts/playerdata-server-adapt.ts 的 charVoiceRecord 登记）
 */
interface CharVoiceRecordView {
  isOpen: boolean;
  confirmEnterReward: boolean;
  nodes: { [nodeId: string]: number };
}

/**
 * mainline 语音档案写入视图
 *
 * 生成类型把 mainline 声明为必填，但旧存档/部分测试夹具可能整体缺失该分区，
 * 旧实现用 `(draft.mainline as any) ??= {}` 兜底；此处保留同一行为（可选 + `??=`）。
 */
interface MainlineVoiceView {
  mainline?: { charVoiceRecord?: { [topicId: string]: CharVoiceRecordView } };
}

/** 取语音档案 topic 的干员 id（取首个 clip 的 charId） */
function missionArchiveCharId(topicId: string): string | undefined {
  const ma = excel.ActivityTable?.missionArchives?.[topicId];
  const clips = ma?.nodes?.flatMap((n) => n?.clips ?? []) ?? ma?.hiddenClips ?? [];
  return clips[0]?.charId;
}

/**
 * 进入角色语音记录并领取入口奖励
 * CS: FifthAnnivService.MissionArchiveClaimEntryRewardRequest { topicId }
 * 响应 { reward: ItemGet[] }；写 mainline.charVoiceRecord[topicId]（isOpen/confirmEnterReward）
 */
rootRouter.post("/mainline/enterCharVoiceRecord", validateBody(enterCharVoiceRecordSchema), async (req, res) => {
  const player = getPlayer();
  const { topicId } = req.body as EnterCharVoiceRecordRequest;
  const charId = missionArchiveCharId(topicId);
  let granted = false;
  await player.update(async (draft) => {
    const view = draft as MainlineVoiceView;
    const mainline = (view.mainline ??= {});
    mainline.charVoiceRecord ??= {};
    const archive = (mainline.charVoiceRecord[topicId] ??= { isOpen: false, confirmEnterReward: false, nodes: {} });
    if (archive.confirmEnterReward) return;
    archive.isOpen = true;
    archive.confirmEnterReward = true;
    granted = true;
  });
  const reward: ItemGet[] = [];
  if (granted && charId) {
    player.gainItem.setTarget(charId, "CHAR", 1);
    await player.gainItem.handle();
    reward.push({ type: "CHAR", id: charId, count: 1 });
  }
  res.send({ reward, ...player.delta } satisfies EnterCharVoiceRecordResponse);
});

/**
 * 领取语音记录节点奖励
 * CS: FifthAnnivService.MissionArchiveClaimNodeRewardRequest { topicId, nodeId }
 * 响应 { reward: ItemGet[] }；写 mainline.charVoiceRecord[topicId].nodes[nodeId]=2（CLAIMED）
 */
rootRouter.post("/mainline/confirmCharVoiceRecordReward", validateBody(confirmCharVoiceRecordRewardSchema), async (req, res) => {
  const player = getPlayer();
  const { topicId, nodeId } = req.body as ConfirmCharVoiceRecordRewardRequest;
  const topic = excel.ActivityTable?.missionArchives?.[topicId];
  const node = topic?.nodes?.find((n) => n?.nodeId === nodeId);
  const charId = node?.clips?.[0]?.charId ?? topic?.hiddenClips?.[0]?.charId;
  let granted = false;
  await player.update(async (draft) => {
    const view = draft as MainlineVoiceView;
    const mainline = (view.mainline ??= {});
    mainline.charVoiceRecord ??= {};
    const archive = (mainline.charVoiceRecord[topicId] ??= { isOpen: false, confirmEnterReward: false, nodes: {} });
    if (!node || archive.nodes[nodeId] === 2) return;
    archive.nodes[nodeId] = 2;
    granted = true;
  });
  const reward: ItemGet[] = [];
  if (granted && charId) {
    // 潜能信物 id 约定：`p_char_` + 干员 id（去 char_ 前缀，如 char_4134_cetsyr → p_char_4134_cetsyr）
    const tokenId = `p_char_${charId.replace(/^char_/, "")}`;
    player.gainItem.setTarget(tokenId, "MATERIAL", 1);
    await player.gainItem.handle();
    reward.push({ type: "MATERIAL", id: tokenId, count: 1 });
  }
  res.send({ reward, ...player.delta } satisfies ConfirmCharVoiceRecordRewardResponse);
});

/**
 * 阅读线索
 * CS: Anniv7thService.READ_CLUE "/mainlineClue/readClue"
 * 写 mainline.clue.state[id]（与 unlockClue 同结构）
 */
rootRouter.post("/mainlineClue/readClue", validateBody(unlockClueSchema), async (req, res) => {
  const player = getPlayer();
  const { id } = req.body as { id: string };
  await player.update(async (draft) => {
    const mainline = draft.mainline;
    if (!mainline.clue) {
      mainline.clue = { unlock: false, state: {}, reward: {} };
    }
    mainline.clue.state[id] = 2;
  });
  res.send(player.delta);
});

/**
 * 领取线索奖励
 * CS: Anniv7thService.GET_REWARDS "/mainlineClue/getRewards"（请求 { ids: string[] }）
 * 条件：已解锁线索数（state >= 2）达到 clueRewardData[recordId].clueRecord；
 * 发放后写 mainline.clue.reward[recordId]（幂等）。奖励经 gainItem 管道发放（recipe 外）。
 */
rootRouter.post("/mainlineClue/getRewards", validateBody(getRewardsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetClueRewardsRequest & { id?: string };
  const ids = Array.isArray(body?.ids) && body.ids.length > 0 ? body.ids : body?.id ? [body.id] : [];
  if (ids.length === 0) {
    return res.send({ ...player.delta, items: [] } satisfies GetClueRewardsResponse);
  }
  const rewardConfig = excel.ActivityTable?.anniv7thData?.clueRewardData ?? [];
  const pending: ItemBundle[] = [];
  await player.update(async (draft) => {
    const mainline = draft.mainline;
    if (!mainline.clue) mainline.clue = { unlock: false, state: {}, reward: {} };
    const clueState: Record<string, number> = mainline.clue.state ?? {};
    const gainedRecord = Object.values(clueState).filter((v) => v >= 2).length;
    for (const recordId of ids) {
      const cfg = rewardConfig.find((c) => c.clueRecordId === recordId);
      if (!cfg || mainline.clue.reward[recordId]) continue;
      if (gainedRecord < cfg.clueRecord) continue;
      mainline.clue.reward[recordId] = 1;
      pending.push(...(cfg.rewards ?? []));
    }
  });
  const items: RewardItemModel[] = [];
  if (pending.length > 0) {
    for (const item of pending) player.gainItem.add(item);
    await player.gainItem.handle();
    for (const item of pending) items.push({ type: item.type, id: item.id, count: item.count });
  }
  res.send({ items, ...player.delta } satisfies GetClueRewardsResponse);
});

// ---- 2026-08-13 补全：客户端缺失路由（根路径）----

/**
 * 像素画审核（CS: ActArkhubReviewPixelArtRequest { uid, status, items }）
 * 私服记录到 activity.ARK_HUB.pixelArts，返回空增量
 */
rootRouter.post("/pixelArt/review", validateBody(pixelArtReviewSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as { uid?: string; status?: number };
  await player.update(async (draft) => {
    const act = draft.activity;
    if (!act.ARK_HUB) act.ARK_HUB = {};
    const hub = (act.ARK_HUB["act1arkhub"] = act.ARK_HUB["act1arkhub"] ?? {});
    hub.reviewedPixelArts = hub.reviewedPixelArts ?? {};
  });
  res.send(player.delta);
});

/**
 * 演出剧情开始
 * CS: PerformanceStoryRequest { storyId }（ServiceCode REFRESH_PERFORMANCE_STORY_BEFORE_START）
 * 写 performanceStory.unlock[storyId]
 */
rootRouter.post("/performanceStory/startStory", validateBody(startStorySchema), async (req, res) => {
  const player = getPlayer();
  const { storyId } = req.body as StartStoryRequest;
  await player.update(async (draft) => {
    draft.performanceStory ??= { unlock: {} };
    draft.performanceStory.unlock[storyId] = 1;
  });
  res.send(player.delta);
});

/**
 * 确认分享任务
 * CS: CrossAppShare Mission（PlayerCrossAppShare.shareMissions[id].counter）
 * 每次确认 counter+1（当前 excel rewardsList 为空，仅计数；奖励逻辑留待活动数据补全）
 */
rootRouter.post("/share/confirmShareMission", validateBody(confirmShareMissionSchema), async (req, res) => {
  const player = getPlayer();
  const { shareMissionId } = req.body as ConfirmShareMissionRequest;
  await player.update(async (draft) => {
    draft.share ??= { shareMissions: {} };
    const entry = (draft.share.shareMissions[shareMissionId] ??= { counter: 0 });
    entry.counter += 1;
  });
  res.send(player.delta);
});

/**
 * 特勤干员解锁节点（CS: SpecialOperatorBoardUnlockNodeRequest { instId, nodeId }）
 * 写 troop.spOperator[charId][nodeType][nodeId] = { id, state: 1, type: nodeType }
 *（抓包 R-1787477989284-0439：delta 为 troop.spOperator.char_4230_mcnist.SKILL.mcnist_n_skill1_6）
 */
rootRouter.post("/troop/SpecialOperatorUnlockNode", validateBody(specialOperatorUnlockNodeSchema), async (req, res) => {
  const player = getPlayer();
  const { instId, nodeId } = req.body as SpecialOperatorUnlockNodeRequest;
  await player.update(async (draft) => {
    const char = draft.troop.chars[instId];
    if (!char) return;
    const nodeCfg = excel.SpecialOperatorTable?.operatorDetailData?.[char.charId]?.nodeUnlockData?.[nodeId];
    const nodeType = nodeCfg?.nodeType;
    if (!nodeType) return;
    draft.troop.spOperator ??= {};
    draft.troop.spOperator[char.charId] ??= {};
    draft.troop.spOperator[char.charId][nodeType] ??= {};
    draft.troop.spOperator[char.charId][nodeType][nodeId] = { id: nodeId, state: 1, type: nodeType };
  });
  res.send(player.delta);
});

/**
 * 获取 CG 收藏列表
 *
 * 返回当前服务器已收藏的 CG 列表。
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py CG.getCgCollection
 *
 * 路径：POST /cg/getCgCollection
 * @returns playerDataDelta 与 cgList
 */
rootRouter.post("/cg/getCgCollection", validateBody(getCgCollectionSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetCgCollectionRequest;
  res.send({
    ...player.delta,
    cgList: cgCollectionStore.list(String(player.uid)),
  } satisfies GetCgCollectionResponse);
});

/**
 * 添加 CG 到收藏列表
 *
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py CG.addCgCollection
 *
 * 路径：POST /cg/addCgCollection
 * @param req.body.cgId - CG ID
 * @returns playerDataDelta 与更新后的 cgList
 */
rootRouter.post("/cg/addCgCollection", validateBody(cgCollectionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as AddCgCollectionRequest;
  const { cgId } = body;
  cgCollectionStore.add(String(player.uid), cgId);
  res.send({
    ...player.delta,
    cgList: cgCollectionStore.list(String(player.uid)),
  } satisfies AddCgCollectionResponse);
});

/**
 * 从 CG 收藏列表移除
 *
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py CG.removeCgCollection
 *
 * 路径：POST /cg/removeCgCollection
 * @param req.body.cgId - CG ID
 * @returns playerDataDelta 与更新后的 cgList
 */
rootRouter.post("/cg/removeCgCollection", validateBody(cgCollectionSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as RemoveCgCollectionRequest;
  const { cgId } = body;
  cgCollectionStore.remove(String(player.uid), cgId);
  res.send({
    ...player.delta,
    cgList: cgCollectionStore.list(String(player.uid)),
  } satisfies RemoveCgCollectionResponse);
});

/**
 * 初始化或获取玩家 gallery 数据
 *
 * 辅助函数：在 Immer draft 中确保 gallery 字段存在，
 * 若不存在则初始化默认结构（与旧行为一致：仅写 firstRewards/leafMap）。
 * 写入侧经 GalleryView 视图访问——生成类型的 PlayerGallery 是客户端模型
 * （firstRewards 声明 number 而服务端写布尔、charSkin 服务端写 null）。
 *
 * @param draft - Immer 可写草稿
 * @returns gallery 数据对象
 */
function ensureGallery(draft: Draft<PlayerDataModel>): GalleryView {
  const view = draft as { gallery?: GalleryView };
  if (!view.gallery) {
    view.gallery = {
      firstRewards: false,
      leafMap: {},
    };
  }
  return view.gallery;
}

/**
 * 领取画廊首通奖励
 *
 * 标记首通奖励已领取，并初始化默认杂志页（leaf_default2）。
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py gallery.getFirstRewards
 *
 * 路径：POST /gallery/getFirstRewards
 * @returns playerDataDelta（包含 gallery 的变更）
 */
/** 画廊杂志图片（客户端 /gallery/jpg/<name>；私服无素材文件，返回 1x1 透明占位图避免客户端报错） */
/** 公告图片（客户端 /announce/images/<subpath>；私服无素材文件，返回 1x1 占位图） */
rootRouter.get("/announce/images/:subpath", async (_req, res) => {
  res.type("png").send(PLACEHOLDER_PNG);
});
rootRouter.get("/gallery/jpg/:jpgName", async (req, res) => {
  // 仅取 basename，防止目录穿越；缩略图以 `{uid}_magazine_{leafId}.jpg` 命名
  const jpgName = basename(req.params.jpgName || "");
  const filepath = join(GALLERY_DIR, jpgName);
  if (jpgName && existsSync(filepath)) {
    res.type("image/jpeg").send(readFileSync(filepath));
    return;
  }
  // 私服无对应缩略图：返回 1x1 透明占位图，避免客户端报错
  res.type("png").send(PLACEHOLDER_PNG);
});
rootRouter.get("/gallery/jpg/:jpgName.png", async (req, res) => {
  const jpgName = basename(req.params.jpgName || "");
  const filepath = join(GALLERY_DIR, `${jpgName}.png`);
  if (jpgName && existsSync(filepath)) {
    res.type("image/png").send(readFileSync(filepath));
    return;
  }
  res.type("png").send(PLACEHOLDER_PNG);
});

rootRouter.post("/gallery/getFirstRewards", validateBody(getFirstRewardsSchema), async (req, res) => {
  const player = getPlayer();
  req.body as GetFirstRewardsRequest;
  await player.update(async (draft) => {
    const gallery = ensureGallery(draft);
    gallery.firstRewards = true;
    gallery.leafMap["leaf_default2"] = {
      charSkin: null,
      decorList: [],
      getTs: now(),
      leafId: "leaf_default2",
      version: 0,
    };
  });
  res.send(player.delta satisfies GetFirstRewardsResponse);
});

/**
 * 获取杂志缩略图 URL 列表
 *
 * 参考实现根据 leafMap 中的内容生成缩略图 URL。
 * 此处简化实现：返回与请求 idList 等长的 null 占位数组，
 * 同时同步 gallery 数据到 delta。
 *
 * 路径：POST /gallery/getThumbnailUrl
 * @param req.body.idList - 杂志页 ID 列表
 * @returns playerDataDelta 与 url 列表
 */
rootRouter.post("/gallery/getThumbnailUrl", validateBody(getThumbnailUrlSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetThumbnailUrlRequest;
  const idList: string[] = body?.idList || [];
  const base = requestBaseUrl(req);
  const uid = String(player.uid);
  let urlList: (string | null)[] = [];
  await player.update(async (draft) => {
    const gallery = ensureGallery(draft);
    // 仅当杂志页有实际内容（角色皮肤或装饰）才返回真实缩略图 URL，否则 null
    urlList = idList.map((leafId) => {
      const leaf = gallery.leafMap?.[leafId];
      const hasContent =
        leaf != null && (leaf.charSkin != null || (Array.isArray(leaf.decorList) && leaf.decorList.length > 0));
      return hasContent ? `${base}/gallery/jpg/${galleryThumbnailName(uid, leafId)}` : null;
    });
  });
  res.send({
    ...player.delta,
    url: urlList,
  } satisfies GetThumbnailUrlResponse);
});

/**
 * 修改杂志编队
 *
 * 参考实现仅返回当前 gallery 数据而不实际修改编队。
 * 此处同步 gallery 数据到 delta。
 *
 * 路径：POST /gallery/changeMagazineSquad
 * @returns playerDataDelta（包含 gallery 的变更）
 */
rootRouter.post("/gallery/changeMagazineSquad", async (req, res) => {
  const player = getPlayer();
  const ct = String(req?.headers?.["content-type"] ?? "");
  // 解析客户端提交的编队列表（兼容 multipart 与 JSON body 的多种字段写法）
  let squad: JsonValue | undefined;
  if (ct.includes("multipart/form-data")) {
    const parsed = await parseMagazineMultipart(req);
    squad = parsed?.squad ?? parsed?.magazineSquad;
  } else {
    const body: JsonValue = (req.body ?? {}) as JsonValue;
    const fields = isJsonObject(body) ? body : {};
    // 修复（2026-08-25）：官服请求字段是 `squad`（抓包 R-1787473456620-0040
    // {"squad":["leaf_default"]}）——原实现只解析 magazineSquad/leafIds/leafId/
    // magazineId，客户端"添加到当前陈列"发 squad → 无匹配 → magazineSquad 不更新、
    // delta 为空 → 界面无变化。squad 优先级最高，其余保留兼容旧写法。
    squad =
      fields.squad ??
      fields.magazineSquad ??
      fields.leafIds ??
      (typeof fields.leafId === "string" ? [fields.leafId] : undefined) ??
      (typeof fields.magazineId === "string" ? [fields.magazineId] : undefined);
  }
  await player.update(async (draft) => {
    const gallery = ensureGallery(draft);
    if (Array.isArray(squad)) {
      // 实际修改展示编队：去重 + 过滤空值
      gallery.magazineSquad = Array.from(new Set(squad.map(String).filter(Boolean)));
    }
  });
  res.send(player.delta satisfies ChangeMagazineSquadResponse);
});

/**
 * 保存自定义杂志（V1）
 *
 * 更新指定杂志页的装饰列表与角色皮肤。
 * 参考实现中还处理 base64 缩略图图片的保存，此处简化为仅更新数据结构。
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py gallery.saveDiyMagazineV1
 *
 * 路径：POST /gallery/saveDiyMagazineV1
 * @param req.body.magazine.leafId - 杂志页 ID
 * @param req.body.magazine.decorList - 装饰列表
 * @param req.body.magazine.charSkin - 角色皮肤
 * @returns playerDataDelta（包含 gallery.leafMap 的变更）
 */
rootRouter.post("/gallery/saveDiyMagazineV1", validateBody(saveDiyMagazineSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as SaveDiyMagazineRequest;
  const magazine = asMagazineView(body?.magazine);
  const { thumbnail } = body;
  const uid = String(player.uid);
  await player.update(async (draft) => {
    saveDiyMagazine(draft, magazine);
  });
  // 编辑闭环：将客户端上传的缩略图落盘（页面清空时清理残留），供展示环节回传
  persistGalleryThumbnail(uid, magazine, thumbnail);
  res.send(player.delta satisfies SaveDiyMagazineResponse);
});

/**
 * 保存自定义杂志（V2）
 *
 * 与 V1 相同的 leafMap 更新逻辑（OBS misc_bp.saveDiyMagazineV2 字段一致），
 * 客户端 V2 走 form-data 的 json 字段，DTS bodyParser.json 已解析为 JSON body。
 *
 * 路径：POST /gallery/saveDiyMagazineV2
 * @param req.body.magazine - 杂志数据（leafId/charSkin/decorList）
 * @returns playerDataDelta（包含 gallery.leafMap 的变更）
 */
rootRouter.post("/gallery/saveDiyMagazineV2", async (req, res) => {
  const player = getPlayer();
  const ct = String(req?.headers?.["content-type"] ?? "");
  const uid = String(player.uid);
  let magazine: unknown;
  let thumbnail: string | undefined;
  if (ct.includes("multipart/form-data")) {
    // 客户端 V2 走 form-data（express.json 不解析 multipart，需读原始裸体）
    const parsed = await parseMagazineMultipart(req);
    magazine = parsed?.magazine;
    thumbnail = parsed?.thumbnail;
  } else {
    const body = req.body as SaveDiyMagazineRequest;
    magazine = body?.magazine;
    thumbnail = body?.thumbnail;
  }
  const magazineView = asMagazineView(magazine);
  await player.update(async (draft) => {
    saveDiyMagazine(draft, magazineView);
  });
  // 编辑闭环：将客户端上传的缩略图落盘（页面清空时清理残留），供展示环节回传
  persistGalleryThumbnail(uid, magazineView, thumbnail);
  res.send(player.delta satisfies SaveDiyMagazineResponse);
});

/**
 * 保存自定义杂志公共逻辑（V1/V2 共用）
 *
 * @param draft - Immer 可写草稿
 * @param magazine - 杂志数据（leafId/charSkin/decorList）
 */
function saveDiyMagazine(draft: Draft<PlayerDataModel>, magazine: MagazineView | undefined): void {
  const gallery = ensureGallery(draft);
  if (magazine?.leafId) {
    if (!gallery.leafMap[magazine.leafId]) {
      gallery.leafMap[magazine.leafId] = {
        charSkin: null,
        decorList: [],
        getTs: now(),
        leafId: magazine.leafId,
        version: 0,
      };
    }
    gallery.leafMap[magazine.leafId].decorList = magazine.decorList || [];
    gallery.leafMap[magazine.leafId].charSkin = magazine.charSkin || null;
  }
}

/**
 * 设置勋章自定义数据
 * 对齐抓包 R-1707532038347.211-4603：delta 含 medal.custom.currentIndex 与 customs[index]
 *
 * 路径：POST /medal/setCustomData
 * @param req.body.index - 槽位索引（缺省 "1"）
 * @param req.body.data - 自定义布局数据
 * @returns playerDataDelta（包含 medal.custom 的变更）
 */
rootRouter.post("/medal/setCustomData", validateBody(medalSetCustomDataSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as MedalSetCustomDataRequest;
  const index = body.index ?? "1";
  await player.update(async (draft) => {
    draft.medal.custom.currentIndex = index;
    draft.medal.custom.customs[index] = body.data;
  });
  res.send(player.delta satisfies MedalSetCustomDataResponse);
});

/**
 * 领取画廊收集奖励
 *
 * 按 collectionSets[setId].missionList[missionId].rewardList 发放奖励并标记已领取
 * （CS: ArtMagazineGetCollectionRewardsRequest/Response { setId, missionId, rewards }）。
 * 修复：原占位实现 res.sendStatus(202) 返回文本 "Accepted"，客户端按 JSON 解析失败。
 *
 * 路径：POST /gallery/getCollectionRewards
 */
rootRouter.post("/gallery/getCollectionRewards", validateBody(getCollectionRewardsSchema), async (req, res) => {
  const player = getPlayer();
  const body = req.body as GetCollectionRewardsRequest;
  const rewards: ItemBundle[] = [];
  const set = excel.DisplayMetaTable?.artGalleryCollectData?.collectionSets?.[
    body.setId ?? ""
  ];
  const mission = set?.missionList?.[body.missionId ?? ""];
  if (mission?.rewardList?.length) {
    rewards.push(...mission.rewardList);
    let granted = false;
    await player.update(async (draft) => {
      const gallery = ensureGallery(draft);
      if (!gallery.collectionRewards) gallery.collectionRewards = {};
      // 幂等：已领取不重复发放
      if (gallery.collectionRewards[body.missionId!] == null) {
        gallery.collectionRewards[body.missionId!] = 1;
        granted = true;
      }
    });
    // 发放移到 recipe 外（避免嵌套 update → revoked proxy/慢）
    if (granted) {
      for (const it of rewards) player.gainItem.add(it);
      await player.gainItem.handle();
    } else {
      rewards.length = 0;
    }
  }
  res.status(202).send({
    rewards,
    ...player.delta,
  } satisfies GetCollectionRewardsResponse);
});

/**
 * 获取服务器时间
 *
 * 返回当前服务器时间戳。该接口为 SDK/门户类接口，
 * 响应格式使用 status/msg/data 包裹，而非游戏协议的 playerDataDelta。
 * 参考实现：reference/opendoctoratepy-ex-public/server/user.py server_time
 *
 * 路径：GET /general/v1/server_time
 * @returns 服务器时间与节日标识
 */
rootRouter.get("/general/v1/server_time", async (req, res) => {
  res.send({
    status: 0,
    msg: "OK",
    data: {
      serverTime: now(),
      isHoliday: false,
    },
  } satisfies ServerTimeResponse);
});
