/**
 * arkhub 网关会话/场景/交互处理（handlers——逻辑层）
 *
 * 登录/重连/心跳 + 场景（EnterScene/ChangeScene/LogoutScene/Move）+ 交互提交/引导推进
 * + 设置更新/名片查看/更换形象/动作掩码/活跃上报/表情/交互等玩法帧的应答构建。
 * 帧形状对齐官服逆向（docs/arkhub-gateway-protocol.md §9.1/§9.6/§10/§11）。
 * 路由注册入口：registerSessionHandlers(router)。
 *
 * 依赖方向：session → shop（buildPixelArtData，场景帧 f7 像素画户籍数据源），
 *           play → session（CAPTURE_MAP_IDS 捕抓区判定）。
 */
import { logger } from "@utils/logger";
import { ARKHUB_GUIDE_ACTOR_FLAGS } from "../../domain/state";
import {
  encodeFieldBytes as fb,
  encodeFieldVarint as fv,
  encodeFieldFixed32 as ff32,
  ProtoReader,
} from "../codec";
import type { ArkhubSessionFrameRouter } from "../dispatch";
import type {
  ArkdexDocsData,
  ArkhubSessionHandlerContext,
  ArkhubSessionFrame,
} from "../contract";
import { buildPixelArtData } from "./shop";
import {
  GW_CHANGE_OUTLOOK_REQ,
  GW_CHANGE_OUTLOOK_RESP,
  GW_CODE_OK,
  GW_EMOTE,
  GW_GET_BUSINESS_CARD_REQ,
  GW_GET_BUSINESS_CARD_RESP,
  GW_GUIDE_FLAGS_NOTIFY,
  GW_INTERACT_ACK,
  GW_INTERACT_REQ,
  GW_INTERACT_WITH_UNIT_REQ,
  GW_INTERACT_WITH_UNIT_RESP,
  GW_LOGOUT_SCENE_REQ,
  GW_MODIFY_PLAYER_ACTION_REQ,
  GW_MOVE_REQ,
  GW_RECONNECT_REQ,
  GW_RECONNECT_RESP,
  GW_REPORT_ACTIVE_REQ,
  GW_REWARD_NOTIFY,
  GW_SCENE_DATA,
  GW_SCENE_HELLO,
  GW_SCENE_SWITCH,
  GW_SCENE_SWITCH_ACK,
  GW_UPDATE_SETTINGS_REQ,
  GW_UPDATE_SETTINGS_RESP,
  GW_USER_LOGIN_REQ,
  GW_USER_LOGIN_RESP,
  GW_LOG_ONLY_DOWN_FRAMES,
  GW_SCENE_PREFIX,
} from "../messages";


/**
 * 玩家状态掩码位（反编译 ActArkhubPlayerStateMask / ActArkhubServerPlayerStatusMask，
 * 二者数值一致：UI 层常量 = 服务端枚举）。
 */
export const ARKHUB_STATE_MASK = {
  IDLE: 0,
  MOVE: 1,
  SPECIAL: 2,
  INTERACT: 0x100,
  MATCHING: 0x200,
  CAPTURE_BATTLE: 0x400,
  DUEL_BATTLE: 0x800,
  PIXEL_CREATE: 0x1000,
} as const;

/** 状态操作（反编译 ActArkhubServerPlayerStatusOperation：SET=1，CLEAR=2） */
export const ARKHUB_STATE_OP = { SET: 1, CLEAR: 2 } as const;

/**
 * 下发玩家状态掩码（PlayerAlterDataNotify 38b36462 的 f1=state_mask）。
 * 官服抓包实锤：捕捉战开始推 0x400、对局开始推 0x800（可单独携带，与 f2 item_alter 独立）；
 * 客户端据此驱动枢纽状态机（对局等待/战斗开始对话框、名片状态图标等）。
 *
 * @param mask - 缺省推连接当前掩码（调用方先改 state.stateMask 再调）
 * @param coin - 可选：同步下发变更后券数（f2=ItemChangeNotify{1:coin}）——状态与券变更
 * 合并为同一帧推送，避免客户端两次消费（对局/扫描结算等“状态+奖励”同时变更场景）。
 */
export function pushPlayerStateMask(
  ctx: ArkhubSessionHandlerContext,
  mask?: number,
  coin?: number,
): void {
  const value = mask ?? ctx.state.stateMask;
  const parts: Buffer[] = [fv(1, value)];
  if (coin !== undefined) {
    parts.push(fb(2, fv(1, Math.max(0, coin))));
  }
  ctx.send(
    8,
    (GW_SCENE_PREFIX << BigInt(32)) | GW_GUIDE_FLAGS_NOTIFY,
    Buffer.concat(parts),
  );
  // 持久化：重连/重启后登录可恢复（官服 PlayerReconnectData.f1 同语义）
  try {
    ctx.opts.onStateMaskChanged?.(ctx.state.uid, value);
  } catch (e) {
    logger.warn("arkhub-gateway", `状态掩码持久化失败: ${(e as Error).message}`);
  }
}

/**
 * 登录/重连时恢复持久化的网关状态（存档 → 连接）：状态掩码、已结算对局去重键、
 * 捕捉会话（重连后 GetCaptureInfo/EndCapture 仍可用）。
 */
function restoreGatewayState(ctx: ArkhubSessionHandlerContext): void {
  const { state, opts } = ctx;
  let persisted: ReturnType<NonNullable<typeof opts.resolveGatewayState>>;
  try {
    persisted = opts.resolveGatewayState?.(state.uid);
  } catch (e) {
    logger.warn("arkhub-gateway", `网关状态恢复失败: ${(e as Error).message}`);
    return;
  }
  if (!persisted) return;
  state.stateMask = Number(persisted.stateMask ?? 0);
  state.settledDuelBattles = new Set(persisted.settledDuels ?? []);
  if (persisted.encounter?.creatures?.length) {
    state.encounter = persisted.encounter;
  }
}

/** 方舟枢纽广场 map_id（activity.ARK_HUB.sceneTypeMap：-1520665757 = TOWN 广场） */
export const HALL_MAP_ID = -1520665757;
/** 巡展捕抓区 map_id（sceneTypeMap：CAPTURE 场景 1/2/3） */
export const CAPTURE_MAP_IDS = [-820616879, -820813487, -820747951];
/** 场景类型（官服 EnterSceneNotify HallInfo.scene_type 恒定 200） */
const HALL_SCENE_TYPE = 200;
/** 广场属性位（HallInfo.attributes 恒定 1） */
const HALL_ATTRIBUTES = 1;
/** 位置同步间隔 ms（HallInfo.sync_interval 恒定 200） */
const HALL_SYNC_INTERVAL = 200;

/** 枢纽 actor → 领奖奖励（activity.ARK_HUB.rewardDataDict 映射；据官服/抓包） */
const HUB_REWARD_MAP: Record<string, { id: string; count: number; type: string }[]> = {
  // 夏妮引导（capture_catch_guide_01）：mmkabi 同款引导奖励 reward_guide_01（×50 券）
  arkhub_main_shiane_02b: [{ id: "arkdex_1_gold", count: 50, type: "COIN" }],
  arkhub_capture1_mmkabi_01b: [{ id: "arkdex_1_gold", count: 50, type: "COIN" }], // reward_guide_01
  arkhub_main_daily_task_02a: [{ id: "arkdex_1_gold", count: 100, type: "COIN" }], // reward_daily_task_01
};

/** 引导 flag → feature_doc(f6) 功能位 id（FeatureFlagsDoc.flags 的 int key）。 */
const ARKHUB_FEATURE_IDS: Record<string, number> = {
  pixel_unlock: 1,
  pixel_unlock_system: 2,
};

/* ---------- 应答构建 ---------- */

/** 登录响应 body：{1: code=100, 2: heartbeatInterval, 3: reconnectToken(payload.signature)} */
function buildLoginResp(uid: string): Buffer {
  // 官服 field3 = `base64({uuid, device_id, expire_time}).signature` 两段式（签名部分任意）
  const payload = Buffer.from(
    JSON.stringify({
      uuid: uid,
      device_id: "0".repeat(32),
      expire_time: Math.floor(Date.now() / 1000) + 86400,
    }),
    "utf8",
  ).toString("base64");
  const token = `${payload}.local-gateway`;
  return Buffer.concat([
    fv(1, GW_CODE_OK),
    fv(2, 2000),
    fb(3, Buffer.from(token, "utf8")),
  ]);
}

/** Vector3 位置（3× fixed32，15B） */
function buildVector3(x: number, y: number, z: number): Buffer {
  return Buffer.concat([ff32(1, x), ff32(2, y), ff32(3, z)]);
}

/** 枢纽 GuideFlags 默认值（对齐官服完成态快照；传输层按连接初始化用） */
export function defaultGuideFlags(): Record<string, number> {
  return {
    arkdex_battle_guide: 2,
    area_2_guard: 1,
    area_3_guard: 1,
    terminal_guide: 1,
    area_3_blcok: 1,
    terminal_guide_arkdex: 1,
    arkhub_login: 1,
    arkdex_mmkabi1: 1,
    // capture_catch_guide_02 取 2（完成态）——取 1 会触发 mmkabi_01b [AUTO] 引导
    capture_catch_guide_02: 2,
    pixel_unlock: 1,
    pixel_unlock_system: 1,
    area_2_block: 1,
    area_1_block: 1,
    capture_catch_guide_01: 2,
  };
}

/**
 * 合法 EnterSceneNotify body：{1: HallInfo, 2: PlayerSyncData(自己), 3: PlayerHallBrief}
 * 官方形状（抓包验证，tmp/capture/records/2026-08-09T04-29-12-534Z/parsed.json）：
 * - HallInfo: {1:unique_id, 2:map_id(-1520665757=TOWN), 3:scene_type(200), 5:attributes(1), 6:sync_interval(200)}
 * - PlayerSyncData: {
 *     1: PlayerBrief{1:uid, 2:nickname, 3:nicknumber, 4:level, 5:channel, 6:charater, 7:skin}
 *     2: AvatarInfo{1:"ICON", 2:avatar_id, 3:secretary, 4:secretary_skin_id}
 *     3: GuideFlags{1:[{1:key, 2:value}...], 2:ts}
 *     4: GameplayAttr{1:[{1:attrId, 2:level}...]}
 *   }（配置 resolveArkdexDocs 时补 f5-f9 户籍）
 * - PlayerHallBrief: {1:unique_id, 2:pos(Vector3)}
 */
function buildEnterScene(
  uid: string,
  profile: {
    nickname: string;
    level: number;
    charId: string;
    skinId: string;
    avatarId?: string;
  },
  mapId: number = HALL_MAP_ID,
  guideValues: Record<string, number> = defaultGuideFlags(),
  arkdocs?: ArkdexDocsData,
): Buffer {
  // HallInfo（unique_id 每会话生成，取 uid 数值稳定；map_id 决定客户端加载哪个场景）
  const uidNum = BigInt(uid || "0") || BigInt(Date.now());
  const hallUnique = BigInt.asUintN(32, uidNum) | BigInt(1);
  const hallInfo = Buffer.concat([
    fv(1, hallUnique),
    fv(2, mapId),
    fv(3, HALL_SCENE_TYPE),
    fv(5, HALL_ATTRIBUTES),
    fv(6, HALL_SYNC_INTERVAL),
  ]);
  // PlayerBrief：1~3 基本，4=level，5=channel，6=charater，7=skin（权威字段名 §10；
  // PlayerBrief 无 avatarId 字段——玩家形象走下方 Avatar f3/f4 = secretary/secretary_skin_id）
  const playerBrief = Buffer.concat([
    fb(1, Buffer.from(uid, "utf8")),
    fb(2, Buffer.from(profile.nickname, "utf8")),
    fb(3, Buffer.from(String(uidNum & BigInt(9999)), "utf8")),
    fv(4, profile.level || 1),
    fv(5, 1), // channel（登录渠道，官方 f5）
    fb(6, Buffer.from(profile.charId, "utf8")),
    fb(7, Buffer.from(profile.skinId, "utf8")),
  ]);
  // Avatar：{1:type="ICON", 2:avatar_id, 3:secretary(代表干员), 4:secretary_skin_id(秘书皮肤)}（§10）
  const avatarInfo = Buffer.concat([
    fb(1, Buffer.from("ICON", "utf8")),
    fb(2, Buffer.from(profile.avatarId || "avatar_dyn_04", "utf8")),
    fb(3, Buffer.from(profile.charId, "utf8")),
    fb(4, Buffer.from(profile.skinId, "utf8")),
  ]);
  // GuideFlags：f1 为【重复字段】，每条 {1:key, 2:value} 独立一条，f2 为时间戳
  const guideFlags = Buffer.concat([
    ...Object.entries(guideValues).map(([key, val]) =>
      fb(1, Buffer.concat([fb(1, Buffer.from(key, "utf8")), fv(2, val)])),
    ),
    fv(2, BigInt(Date.now())),
  ]);
  // GameplayAttr：官方样例 [{1:4,2:1},{1:5,2:1},{1:9}]
  const gameAttrs = Buffer.concat([
    fb(1, Buffer.concat([fv(1, 4), fv(2, 1)])),
    fb(1, Buffer.concat([fv(1, 5), fv(2, 1)])),
    fb(1, Buffer.concat([fv(1, 9)])),
  ]);
  // 户籍裁剪：配置 resolveArkdexDocs 时补 f5-f9（客户端据此渲染生物图鉴/道具/功能位）
  const syncParts = [
    fb(1, playerBrief),
    fb(2, avatarInfo),
    fb(3, guideFlags),
    fb(4, gameAttrs),
  ];
  if (arkdocs) {
    syncParts.push(fb(5, buildCreatureData(arkdocs)));
    syncParts.push(fb(6, buildArkhubItemData(arkdocs)));
    syncParts.push(fb(7, buildPixelArtData(uid)));
    syncParts.push(fb(8, buildBuffDoc()));
    syncParts.push(fb(9, buildFeatureDoc()));
  }
  const playerSync = Buffer.concat(syncParts);
  // PlayerHallBrief：{1: unique_id(ulong), 2: pos}
  const selfUnitId = BigInt.asUintN(64, uidNum) | (BigInt(1) << BigInt(40));
  const hallBrief = Buffer.concat([
    fv(1, selfUnitId),
    fb(2, buildVector3(...spawnPointFor(mapId))),
  ]);
  return Buffer.concat([
    fb(1, hallInfo),
    fb(2, playerSync),
    fb(3, hallBrief),
  ]);
}

/* ---------- PlayerSyncData f5-f9 户籍构建（奇象展册，字段号对齐官服逆向） ---------- */

/**
 * 生物图鉴数据（PlayerSyncData.f5 CreatureData）
 * 官方结构：f1 creatures[]（Creature），f2 collections[]（CreatureCollection）。
 * dex 每种收录 → collections 一条 CreatureCollection（template_id=numId）；scanBag 每个持有个体
 * → creatures 一条 Creature（unique_id=个体id，template_id=numId）。
 */
function buildCreatureData(docs: ArkdexDocsData): Buffer {
  const creatures = (docs.scanBag ?? []).map((b) =>
    fb(1, Buffer.concat([
      fv(1, BigInt(b.id)), // unique_id
      fv(2, b.numId), // template_id
      fv(3, b.persona ?? 0), // persona
      fv(5, BigInt(Date.now())), // gain_time
      ...(b.source ? [fb(6, Buffer.from(b.source, "utf8"))] : []), // source(string)
    ])),
  );
  const collections = Object.keys(docs.dex ?? {}).map((numId) =>
    fb(2, Buffer.concat([
      fv(1, Number(numId)), // template_id
      fv(3, 1), // caught_count
    ])),
  );
  return Buffer.concat([...creatures, ...collections]);
}

/**
 * 道具数据（PlayerSyncData.f6 ArkhubItemData）
 * 官方结构：f1 coin(int)，f2 items[]（ArkhubItem{1:item_id(int), 2:count(int)}）。
 */
function buildArkhubItemData(docs: ArkdexDocsData): Buffer {
  const items = (docs.items ?? []).map((it) =>
    fb(2, Buffer.concat([fv(1, it.itemId), fv(2, it.count)])),
  );
  return Buffer.concat([fv(1, docs.coin ?? 0), ...items]);
}

/**
 * 状态数据（PlayerSyncData.f8 BuffDoc）：空容器。
 */
function buildBuffDoc(): Buffer {
  return Buffer.alloc(0);
}

/** 非永久功能菜单解锁位（ActArkHubMenuType 枚举值 = menuData.sortId）：4=扫描仪、
 *  5=道具箱、6=数据库、7=画像册、8=交换站。 */
const ARKHUB_MENU_UNLOCK_IDS = [4, 5, 6, 7, 8];

/**
 * 功能位数据（PlayerSyncData.f9 FeatureFlagsDoc）
 * 官方结构：f1 flags 为 Dictionary<int,int>（proto map：重复 f1 元素 {1:menuType, 2:value}）。
 */
function buildFeatureDoc(): Buffer {
  return Buffer.concat(
    ARKHUB_MENU_UNLOCK_IDS.map((id) => fb(1, Buffer.concat([fv(1, id), fv(2, 1)]))),
  );
}

/**
 * 各场景出生点（官服抓包验证：EnterSceneNotify PlayerHallBrief.pos）
 * - TOWN 广场 = (4.742, -0.008, 6.079)
 * - CAPTURE 1 = (1.945, 0.513, -6.850)（CAPTURE 2/3 无样本，沿用 CAPTURE 1）
 */
function spawnPointFor(mapId: number): [number, number, number] {
  if (CAPTURE_MAP_IDS.includes(mapId)) return [1.945, 0.513, -6.85];
  return [4.742, -0.008, 6.079];
}

/**
 * 道具奖励通知（3000ee32，交互提交领奖后服务端下发）
 * 官服形状（2026-08-19 shiane_02b 领奖实锤）：{1:1, 2:[{1:奖励id, 2:数量}×N]}。
 *
 * @param items - 奖励条目（{id: 数值奖励 id, count: 数量}）
 */
function buildItemRewardNotify(items: Array<{ id: number; count: number }>): Buffer {
  const entries = (items ?? []).map((it) => fb(2, Buffer.concat([fv(1, it.id), fv(2, it.count)])));
  return Buffer.concat([fv(1, 1), ...entries]);
}

/**
 * GuideFlags 广播（38b36462，引导推进后服务端主动下发）
 * 该帧官方业务对象为 PlayerAlterDataNotify（SyncAlterDataNotify），字段：
 *   f2 = item_alter_data:ItemChangeNotify{ 1:coin, 2:modified:ArkhubItem[], 3:deleted }
 *   f5 = task_alter_data:TaskAlterList{ 1:modified:TaskInfo[] }，TaskInfo{ 1:seq_number, 2:status }
 * 本地发送对齐官方结构：f2 放当前券数 + 本次领奖道具，f5 把引导推进项封装为
 * task_alter_data.modified（关键：f5 必须包进 TaskAlterList.modified 这层嵌套），
 * f6 兜底双通道下发 feature_doc（画像册等设施解锁）。
 *
 * @param flags - 本次推进的 GuideFlags（{key: value}，转为 TaskInfo{seq_number, status}）
 * @param gold - 玩家当前奇象兑换券数（arkdex_1_gold 持有量，f2.f1/ItemChangeNotify.coin）
 * @param items - 本次领奖道具（{id, count}，f2.f2/ArkhubItem[]）
 */
function buildGuideFlagsNotify(
  flags: Record<string, number>,
  gold = 0,
  items: Array<{ id: number; count: number }> = [],
): Buffer {
  // f2 = ItemChangeNotify{ 1:coin, 2:modified[] }（官方字段号，ArkhubItem{item_id,count} 兼容）
  const f2 = Buffer.concat([
    fv(1, gold),
    ...(items ?? []).map((it) => fb(2, Buffer.concat([fv(1, it.id), fv(2, it.count)]))),
  ]);
  // f5 = TaskAlterList{ 1:modified:[TaskInfo{1:seq_number, 2:status}] }
  const modified = Object.entries(flags).map(([key, val]) =>
    fb(1, Buffer.concat([fb(1, Buffer.from(key, "utf8")), fv(2, val)])),
  );
  // f6 = feature_doc: FeatureFlagsDoc{ 1:flags:[{1:featureId, 2:value}] }（兜底双通道）
  const featureFlags = Object.entries(flags)
    .filter(([key]) => ARKHUB_FEATURE_IDS[key] !== undefined)
    .map(([key, val]) =>
      fb(1, Buffer.concat([fv(1, ARKHUB_FEATURE_IDS[key] as number), fv(2, val)])),
    );
  return Buffer.concat([
    fb(2, f2),
    ...(modified.length ? [fb(5, Buffer.concat(modified))] : []),
    ...(featureFlags.length ? [fb(6, Buffer.concat(featureFlags))] : []),
  ]);
}

/**
 * 设置更新响应（38b36054 → 38b3db61，官服抓包 2026-08-09 字节对齐）
 * 请求 {1:settings=map<int,int>}（每条 {1:key, 2:value}）；响应回显 code + settings 快照。
 *
 * @param entries - 请求解析出的 settings 条目（{key, value}；value 缺省 0）
 */
function buildUpdateSettingsResp(entries: Array<{ key: number; value: number }>): Buffer {
  const settings = (entries ?? []).map((e) => fb(2, Buffer.concat([fv(1, e.key), fv(2, e.value)])));
  return Buffer.concat([fv(1, GW_CODE_OK), ...settings]);
}

/**
 * 名片响应（38b322c3 → 38b3613c BusinessCardResp{1:card=BusinessCard}）
 * 单机无其他玩家——回最小合法结构（card → card_info 空 NameCard），保证客户端
 * 拿到正确 subID 的响应而非错位的 subID+1 ACK（此前会导致卡片 UI 流程错乱）。
 */
function buildBusinessCardResp(): Buffer {
  const businessCard = fb(1, Buffer.alloc(0)); // BusinessCard{1: card_info: NameCard(空)}
  return fb(1, businessCard);
}

/**
 * 更换形象响应（38b3d83c → 38b3f7a7 ChangeOutlookResp）
 * 回显 code=100 + 服务端确认后的外观（干员/皮肤/SP），与请求一致时客户端视为生效。
 *
 * @param charater - 角色干员 ID
 * @param skin - 皮肤 ID
 * @param skinSp - 是否 SP 皮肤
 */
function buildChangeOutlookResp(charater: string, skin: string, skinSp: boolean): Buffer {
  return Buffer.concat([
    fv(1, GW_CODE_OK),
    fb(2, Buffer.from(charater, "utf8")),
    fb(3, Buffer.from(skin, "utf8")),
    fv(4, skinSp ? 1 : 0),
  ]);
}

/**
 * 交互响应（38b36055 → 38b3d134 InteractionActionResp）
 * 权威字段：{1:result_code(int)}——0=成功（本地回 0，对齐 doc §10 交互动作语义）。
 */
function buildInteractionWithUnitResp(): Buffer {
  return Buffer.from([0x08, 0]);
}

/** 重连登录响应（0x0fa3 → 0x0fa4）：{1:101（重连成功 code）} */
function buildReconnectResp(): Buffer {
  return Buffer.from([0x08, 101]);
}

/** 通用 ACK body：{1:code=100} */
function ackBody(): Buffer {
  return Buffer.from([0x08, GW_CODE_OK]);
}

/* ---------- 帧处理 ---------- */

/** 玩家资料（charId/skinId 供客户端渲染广场玩家模型；缺省回退通用值） */
function buildProfile(ctx: ArkhubSessionHandlerContext): {
  nickname: string;
  level: number;
  charId: string;
  skinId: string;
  avatarId?: string;
} {
  const { state, opts } = ctx;
  const nickname = opts.resolveNickname ? opts.resolveNickname(state.uid) : `博士${state.uid || "1"}`;
  const profile = opts.resolvePlayerProfile ? opts.resolvePlayerProfile(state.uid) : undefined;
  return {
    nickname: profile?.nickname || nickname,
    level: profile?.level || 1,
    charId: profile?.charId || "",
    skinId: profile?.skinId || "",
    avatarId: profile?.avatarId,
  };
}

/**
 * 场景数据帧：EnterSceneNotify（目标 map_id 决定客户端加载场景）
 *
 * 户籍依赖玩家存档在内存：构建前 await ensurePlayerLoaded（网关登录不走 HTTP 懒加载链，
 * 未加载时 resolveArkdexDocs 读不到玩家 → 场景帧缺 f5-f9 → 捕捉区/图鉴等功能不解锁）。
 */
async function sendSceneFrame(ctx: ArkhubSessionHandlerContext, mapId: number): Promise<void> {
  const { state, opts } = ctx;
  try {
    await opts.ensurePlayerLoaded?.(state.uid);
  } catch (e) {
    logger.warn("arkhub-gateway", `场景帧构建前存档加载失败: ${(e as Error).message}`);
  }
  // 户籍裁剪：配置 resolveArkdexDocs 时把玩家奇象展册数据编进 PlayerSyncData f5-f9
  const arkdocs = opts.resolveArkdexDocs?.(state.uid);
  ctx.send(
    8,
    GW_SCENE_DATA,
    buildEnterScene(state.uid, buildProfile(ctx), mapId, state.guideState, arkdocs),
  );
}

/** 心跳（main=1）：回显 16B（客户端时间戳 + 服务端时间戳） */
function handleHeartbeat(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const echo = Buffer.alloc(16);
  frame.body.copy(echo, 0, 0, Math.min(frame.body.length, 8));
  echo.writeBigUInt64BE(BigInt(Date.now()), 8);
  ctx.send(2, BigInt(0), echo);
}

/** 判断回调返回值是否为 thenable（配置回调允许同步返回或 Promise） */
function isPromiseLike<T>(v: T | PromiseLike<T>): v is PromiseLike<T> {
  return typeof (v as PromiseLike<T>).then === "function";
}

/** 登录（main=4 sub=0x0fa1）：解析 uid（field1）用于 token/场景，任意凭据均放行（私服） */
function handleLogin(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const { state, opts } = ctx;
  const uid = readLoginUid(frame.body);
  state.uid = uid;
  state.currentMapId = HALL_MAP_ID;
  // 恢复持久化的网关状态（掩码/对局去重键/捕捉会话——重连与重启后不丢）
  restoreGatewayState(ctx);
  // 渐进引导：登录后按 uid 解析 GuideFlags（persisted，缺省回退完成态）。
  // 支持异步回调（动态加载玩法模块）——fire-and-forget，场景 hello 前生效。
  const guideResolved = opts.resolveGuideFlags?.(uid);
  if (guideResolved && isPromiseLike(guideResolved)) {
    guideResolved
      .then((flags) => {
        if (flags) state.guideState = flags;
      })
      .catch((e: Error) => logger.warn("arkhub-gateway", `GuideFlags 解析失败: ${e.message}`));
  } else if (guideResolved) {
    state.guideState = guideResolved;
  }
  logger.info("arkhub-gateway", `本地网关登录: uid=${uid || "?"}`);
  ctx.send(4, GW_USER_LOGIN_RESP, buildLoginResp(uid));
}

/** 重连登录（UserReconnectReq：{1:uid, 2:base64 JWT}）→ {1:101} 重连成功（私服单账号任意放行） */
function handleReconnect(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const uid = readLoginUid(frame.body);
  ctx.state.uid = uid;
  // 重连同样恢复持久化状态（官服重连经 PlayerReconnectData 下发 state_mask 等）
  restoreGatewayState(ctx);
  logger.info("arkhub-gateway", `本地网关重连登录: uid=${uid || "?"}`);
  ctx.send(4, GW_RECONNECT_RESP, buildReconnectResp());
}

/** 登录请求 body 解析 uid（field1 string） */
function readLoginUid(body: Buffer): string {
  const reader = new ProtoReader(body);
  let uid = "";
  for (;;) {
    const tag = reader.readTag();
    if (!tag) break;
    if (tag.wire === 2) {
      const s = reader.readString();
      if (tag.field === 1) uid = s;
    } else if (tag.wire === 0) {
      reader.readVarint();
    } else break;
  }
  return uid;
}

/** 场景 hello（EnterSceneReq）→ 合法 EnterSceneNotify（当前场景 + 自己） */
function handleEnterScene(ctx: ArkhubSessionHandlerContext, _frame: ArkhubSessionFrame): void {
  const { state, opts } = ctx;
  state.currentMapId = HALL_MAP_ID;
  // 进入大厅：首次自动完成"登录/入场引导"（arkhub_login）。
  // 渐进模式下 arkhub_login 初始为 0（触发入场引导对话）；这里在本连接把它置 1
  // 并经 onGuideAdvance→arkhubAdvanceGuide 持久化——本次场景仍播一次，之后不再重复。
  if (state.guideState.arkhub_login === 0) {
    state.guideState.arkhub_login = 1;
    try {
      opts.onGuideAdvance?.(state.uid, "arkhub_login", "");
    } catch (e) {
      logger.warn("arkhub-gateway", `登录引导自动完成失败: ${(e as Error).message}`);
    }
  }
  logger.info(
    "arkhub-gateway",
    `场景 hello → EnterSceneNotify (uid=${state.uid}, map=${state.currentMapId})`,
  );
  sendSceneFrame(ctx, state.currentMapId);
}

/**
 * 切场景（传送门）：请求 {1:2, 2:<目标 map_id 有符号 varint>}（官服抓包：
 * 0x38b3b60b → ACK 0x38b3a5a8{f1:9} + 新场景 EnterSceneNotify 0x38b37d3d）
 */
function handleChangeScene(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const { state } = ctx;
  let targetMapId = state.currentMapId;
  try {
    const reader = new ProtoReader(frame.body);
    for (;;) {
      const tag = reader.readTag();
      if (!tag) break;
      if (tag.wire === 0) {
        const v = reader.readVarint();
        if (tag.field === 2) targetMapId = Number(BigInt.asIntN(64, v));
      } else break;
    }
  } catch {
    // 解析失败保持原场景
  }
  state.currentMapId = targetMapId;
  const mapName = CAPTURE_MAP_IDS.includes(targetMapId)
    ? `CAPTURE(${CAPTURE_MAP_IDS.indexOf(targetMapId) + 1})`
    : targetMapId === HALL_MAP_ID
      ? "TOWN"
      : "?";
  logger.info(
    "arkhub-gateway",
    `切场景 → ${mapName} (map=${targetMapId}) uid=${state.uid}`,
  );
  // 官服序列：先小 ACK（{1:9}），再发新场景 EnterSceneNotify
  ctx.send(
    8,
    (GW_SCENE_PREFIX << BigInt(32)) | GW_SCENE_SWITCH_ACK,
    Buffer.from([0x08, 0x09]),
  );
  sendSceneFrame(ctx, state.currentMapId);
}

/** 离开场景（LogoutSceneReq）→ 通用 ACK {1:100} */
function handleLogoutScene(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  logger.debug("arkhub-gateway", `离开场景 (uid=${ctx.state.uid || "?"})`);
  ctx.send(8, frame.subID + BigInt(1), ackBody());
}

/** 位置同步（MoveReq）——body 仅日志，回位置 ACK（subID+1，保持既有行为） */
function handleMove(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  ctx.send(8, frame.subID + BigInt(1), ackBody());
}

/** 设置更新（UpdatePlayerSettingsReq：{1:settings=map<int,int>}）→ 38b3db61 回显 code + settings */
function handleUpdateSettings(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const entries: Array<{ key: number; value: number }> = [];
  const reader = new ProtoReader(frame.body);
  for (;;) {
    const tag = reader.readTag();
    if (!tag) break;
    if (tag.wire === 2) {
      if (tag.field === 1) {
        const entryBuf = reader.readLengthDelimited();
        const er = new ProtoReader(entryBuf);
        let key = 0;
        let value = 0;
        for (;;) {
          const et = er.readTag();
          if (!et) break;
          if (et.wire === 0) {
            const v = Number(er.readVarint());
            if (et.field === 1) key = v;
            else if (et.field === 2) value = v;
          } else break;
        }
        entries.push({ key, value });
      } else {
        reader.readLengthDelimited();
      }
    } else if (tag.wire === 0) {
      reader.readVarint();
    } else break;
  }
  logger.info("arkhub-gateway", `设置更新 settings=${JSON.stringify(entries)} → 响应 (uid=${ctx.state.uid || "?"})`);
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_UPDATE_SETTINGS_RESP,
    buildUpdateSettingsResp(entries),
  );
}

/** 名片查看（GetBusinessCardReq：[seq]{1:unique_id}）→ 38b3613c BusinessCardResp（最小结构） */
function handleGetBusinessCard(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const seq = frame.body.length >= 4 ? frame.body.readUInt32BE(0) : 0;
  logger.info("arkhub-gateway", `名片查看 (uid=${ctx.state.uid || "?"}) → BusinessCard (seq=${seq})`);
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_GET_BUSINESS_CARD_RESP,
    buildBusinessCardResp(),
  );
}

/** 更换形象（ChangeOutlookReq：{1:charater, 2:skin, 3:skin_sp}）→ 38b3f7a7 回显确认 */
function handleChangeOutlook(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const reader = new ProtoReader(frame.body);
  let charater = "";
  let skin = "";
  let skinSp = false;
  for (;;) {
    const tag = reader.readTag();
    if (!tag) break;
    if (tag.wire === 2) {
      const s = reader.readString();
      if (tag.field === 1) charater = s;
      else if (tag.field === 2) skin = s;
    } else if (tag.wire === 0) {
      const v = reader.readVarint();
      if (tag.field === 3) skinSp = v !== 0n;
    } else break;
  }
  logger.info("arkhub-gateway", `更换形象 charater=${charater} skin=${skin} skin_sp=${skinSp}`);
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_CHANGE_OUTLOOK_RESP,
    buildChangeOutlookResp(charater, skin, skinSp),
  );
}

/** 交互（InteractWithUnitReq）→ 38b3d134 InteractionActionResp{1:result_code=0} */
function handleInteractWithUnit(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  logger.info("arkhub-gateway", `交互 (uid=${ctx.state.uid || "?"}) → InteractionActionResp`);
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_INTERACT_WITH_UNIT_RESP,
    buildInteractionWithUnitResp(),
  );
}

/**
 * 动作掩码（ModifyPlayerActionReq：{1:operation(SET=1/CLEAR=2), 2:state_mask}）。
 * 客户端上报自身状态变化（像素画 0x1000 / 交互 0x100 等）：按连接应用 SET（置位）/CLEAR（清位）
 * 后 ACK，并回推 PlayerAlterDataNotify f1=新掩码确认（官服同形——客户端据此更新状态机）。
 */
function handleModifyPlayerAction(
  ctx: ArkhubSessionHandlerContext,
  frame: ArkhubSessionFrame,
): void {
  let op = 0;
  let mask = 0;
  const reader = new ProtoReader(frame.body);
  for (;;) {
    const tag = reader.readTag();
    if (!tag || tag.wire !== 0) break;
    const v = Number(reader.readVarint());
    if (tag.field === 1) op = v;
    else if (tag.field === 2) mask = v;
  }
  if (op === ARKHUB_STATE_OP.SET) ctx.state.stateMask |= mask;
  else if (op === ARKHUB_STATE_OP.CLEAR) ctx.state.stateMask &= ~mask;
  logger.info(
    "arkhub-gateway",
    `动作掩码 ${op === ARKHUB_STATE_OP.SET ? "SET" : "CLEAR"} 0x${mask.toString(16)} → 当前 0x${ctx.state.stateMask.toString(16)} (uid=${ctx.state.uid || "?"})`,
  );
  ctx.send(8, frame.subID + BigInt(1), ackBody());
  pushPlayerStateMask(ctx);
}

/** 活跃上报（ReportPlayerActiveReq）——官服 fire-and-forget，不响应（仅日志） */
function handleReportActive(ctx: ArkhubSessionHandlerContext, _frame: ArkhubSessionFrame): void {
  logger.debug("arkhub-gateway", `活跃上报 (uid=${ctx.state.uid || "?"})`);
}

/** 服务端下发帧（down 广播，客户端不会主动发）——收到仅记录日志，不回帧 */
function logOnlyDown(ctx: ArkhubSessionHandlerContext, _frame: ArkhubSessionFrame): void {
  logger.debug("arkhub-gateway", `服务端下发帧（忽略） uid=${ctx.state.uid || "?"}`);
}

/** 表情/动作（DoRolePlayingReq）→ 通用 ACK {1:100}（单机 fire-and-forget） */
function handleEmote(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  ctx.send(8, frame.subID + BigInt(1), ackBody());
}

/**
 * 枢纽交互提交（领奖）：[seq] {1:actorId, 2:operationId("get_reward")}
 * 响应三帧（官服实锤 2026-08-19 shiane_02b 领奖抓包）：
 * ① 38b38cd6 通用 ACK（[seq回显]{1:100}）
 * ② 3000ee32 道具奖励通知（{1:1, 2:[{1:5012,2:1},{1:5022,2:1}]}）
 * ③ 38b36462 引导更新广播（capture_update_guide=1，客户端据此结束对话）
 */
function handleSubmitActorOp(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
  const { state, opts } = ctx;
  const body = frame.body;
  const seq = body.length >= 4 ? body.readUInt32BE(0) : 0;
  let actorId = "";
  let operationId = "";
  try {
    const reader = new ProtoReader(body.subarray(4));
    for (;;) {
      const tag = reader.readTag();
      if (!tag) break;
      if (tag.wire === 2) {
        const s = reader.readString();
        if (tag.field === 1) actorId = s;
        else if (tag.field === 2) operationId = s;
      } else if (tag.wire === 0) {
        reader.readVarint();
      } else break;
    }
  } catch {
    // 解析失败按空 actor 处理
  }
  const reward = HUB_REWARD_MAP[actorId] ?? [];
  // 领奖一次性闸门：get_reward 已领过 → 仅回 ACK（不重复发奖、不弹提示——修复“每次进入都提示”）。
  // 每日演员（daily_task）按自然日重置，次日可再领；其余演员永久一次性。
  if (operationId === "get_reward" && opts.claimActorReward) {
    const claimKey = actorId.includes("daily_task")
      ? `${actorId}:${new Date().toDateString()}`
      : actorId;
    let claimable = true;
    try {
      claimable = opts.claimActorReward(state.uid, claimKey);
    } catch (e) {
      logger.warn("arkhub-gateway", `领奖闸门检查失败: ${(e as Error).message}`);
    }
    if (!claimable) {
      logger.info("arkhub-gateway", `交互提交 actor=${actorId} op=${operationId} → 已领过，仅回 ACK`);
      const ackOnly = Buffer.alloc(4);
      ackOnly.writeUInt32BE(seq, 0);
      ctx.send(
        8,
        (frame.subID & ~0xffffffffn) | GW_INTERACT_ACK,
        Buffer.concat([ackOnly, Buffer.from([0x08, GW_CODE_OK])]),
      );
      return;
    }
  }
  // 引导推进：命中引导 actor → 本连接 guideState 同步 + 通知私服落持久化/出展指引任务。
  // 引导推进后服务端主动下发 GuideFlags 广播（38b36462）——客户端据此更新引导状态并结束对话。
  const guideFlags = ARKHUB_GUIDE_ACTOR_FLAGS[actorId];
  let guideBroadcast: Buffer | null = null;
  if (guideFlags) {
    for (const [key, value] of Object.entries(guideFlags)) {
      state.guideState[key] = Math.max(state.guideState[key] ?? 0, value as number);
    }
    // 引导更新广播（38b36462）push 两件事：
    //  ① capture_update_guide=1 —— 客户端据此"重新读取引导状态并结束当前对话"；
    //  ② 本次推进的其余 GuideFlags（如 pixel_unlock）——经 task_alter_data 下发，
    //     客户端据此解锁画像册等设施。f2 对齐官服：{1:当前券数, 2:[本次领奖道具]}
    // 券数修正：发奖为异步落盘，此处直接加上本次增量（每日物资 +100，仅当日未领过时），
    // 否则客户端券数要等切地图重发场景帧才刷新。
    const dailyDelta =
      actorId === "arkhub_main_daily_task_02a" && !(opts.resolveDailyClaimed?.(state.uid) ?? false)
        ? 100
        : 0;
    const gold = (opts.resolveArkDexGold?.(state.uid) ?? 0) + dailyDelta;
    guideBroadcast = buildGuideFlagsNotify(
      { ...(guideFlags as Record<string, number>), capture_update_guide: 1 },
      gold,
      [
        { id: 5012, count: 1 },
        { id: 5022, count: 1 },
      ],
    );
    try {
      opts.onGuideAdvance?.(state.uid, actorId, operationId);
    } catch (e) {
      logger.warn("arkhub-gateway", `引导推进处理失败: ${(e as Error).message}`);
    }
  }
  // 每日物资：服务端记录领取天数 + 发 100 券（onDailySupplyClaimed）
  if (actorId === "arkhub_main_daily_task_02a") {
    try {
      opts.onDailySupplyClaimed?.(state.uid);
    } catch (e) {
      logger.warn("arkhub-gateway", `每日物资处理失败: ${(e as Error).message}`);
    }
  }
  logger.info(
    "arkhub-gateway",
    `交互提交 actor=${actorId} op=${operationId} → 奖励 ${reward.map((r) => `${r.id}x${r.count}`).join(",") || "无"}`,
  );
  const ack = Buffer.alloc(4);
  ack.writeUInt32BE(seq, 0);
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_INTERACT_ACK,
    Buffer.concat([ack, Buffer.from([0x08, GW_CODE_OK])]),
  );
  ctx.send(
    8,
    (frame.subID & ~0xffffffffn) | GW_REWARD_NOTIFY,
    buildItemRewardNotify([
      { id: 5012, count: 1 },
      { id: 5022, count: 1 },
    ]),
  );
  if (guideBroadcast) {
    ctx.send(8, (frame.subID & ~0xffffffffn) | GW_GUIDE_FLAGS_NOTIFY, guideBroadcast);
  }
}

/** 注册会话/场景/交互/引导路由 */
export function registerSessionHandlers(router: ArkhubSessionFrameRouter): void {
  // main 级（心跳无 subID 语义）
  router.registerMain(1, "心跳(Ping)", handleHeartbeat);
  // full 匹配（登录/重连/场景 hello——整 64 位 subID）
  router.register(4, GW_USER_LOGIN_REQ, "登录(UserLoginReq)", handleLogin);
  router.register(4, GW_RECONNECT_REQ, "重连登录(UserReconnectReq)", handleReconnect);
  router.register(8, GW_SCENE_HELLO, "场景hello(EnterSceneReq)", handleEnterScene);
  // low32 匹配（场景/交互/设置/外观等玩法帧）
  router.registerLow(8, GW_SCENE_SWITCH, "切场景(ChangeSceneReq)", handleChangeScene);
  router.registerLow(8, GW_LOGOUT_SCENE_REQ, "离开场景(LogoutSceneReq)", handleLogoutScene);
  router.registerLow(8, GW_MOVE_REQ, "位置同步(MoveReq)", handleMove);
  router.registerLow(8, GW_UPDATE_SETTINGS_REQ, "设置更新(UpdatePlayerSettingsReq)", handleUpdateSettings);
  router.registerLow(8, GW_GET_BUSINESS_CARD_REQ, "名片查看(GetBusinessCardReq)", handleGetBusinessCard);
  router.registerLow(8, GW_CHANGE_OUTLOOK_REQ, "更换形象(ChangeOutlookReq)", handleChangeOutlook);
  router.registerLow(8, GW_INTERACT_WITH_UNIT_REQ, "交互(InteractWithUnitReq)", handleInteractWithUnit);
  router.registerLow(8, GW_MODIFY_PLAYER_ACTION_REQ, "动作掩码(ModifyPlayerActionReq)", handleModifyPlayerAction);
  router.registerLow(8, GW_REPORT_ACTIVE_REQ, "活跃上报(ReportPlayerActiveReq)", handleReportActive);
  router.registerLow(8, GW_EMOTE, "表情(DoRolePlayingReq)", handleEmote);
  router.registerLow(8, GW_INTERACT_REQ, "交互提交(SubmitActorOpReq)", handleSubmitActorOp);
  for (const f of GW_LOG_ONLY_DOWN_FRAMES) router.registerLow(8, f.id, f.name, logOnlyDown);
  // 服务端下发帧（down 广播——客户端不会主动发；注册为 log-only 使路由表覆盖 §11 全表，
  // 避免误落入通用 ACK 兜底回错帧）
}
