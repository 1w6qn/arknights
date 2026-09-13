/**
 * arkhub 网关会话——帧常量（subID / 返回码）唯一来源
 *
 * 原分散在 `handlers/{hub,play,shop}.ts` 与 `dispatch.ts` 的字面量（99 处）集中于此，
 * 语义与字节值不变；帧形状 / 字段序见 `docs/arkhub-gateway-protocol.md` §9-§11。
 * 层次：messages（本文件，常量）→ codec（线级编解码）→ dispatch（帧分发）→ handlers（业务）→ server（传输）。
 */

/** 网关返回码：100 = OK */
export const GW_CODE_OK = 100;

/** 帧头大小：4B 长度 + 4B mainID + 8B subID */
export const GATEWAY_HEADER_SIZE = 16;

/* ==================== 登录 / 场景 / 交互（原 handlers/hub.ts） ==================== */

/** 登录请求/响应 subID（main=4） */
export const GW_USER_LOGIN_REQ = BigInt(0x0fa1);
export const GW_USER_LOGIN_RESP = BigInt(0x0fa2);
/** 重连登录请求/响应（UserReconnectReq/Resp，main=4） */
export const GW_RECONNECT_REQ = BigInt(0x0fa3);
export const GW_RECONNECT_RESP = BigInt(0x0fa4);
/** 场景 hello subID（登录后客户端必发，实为 EnterSceneReq） */
export const GW_SCENE_HELLO = BigInt("0x00018fb64de29cdb");
/** 场景数据响应 subID（服务端回给 hello 的 EnterSceneNotify 帧） */
export const GW_SCENE_DATA = BigInt("0x0002c89b38b37d3d");
/** 切场景请求 subID（low32） */
export const GW_SCENE_SWITCH = BigInt(0x38b3b60b);
/** 切场景 ACK 响应 subID（low32；响应前缀固定 0x2c89b3） */
export const GW_SCENE_SWITCH_ACK = BigInt(0x38b3a5a8);
/** 离开场景（LogoutSceneReq：{1:logout_type}） */
export const GW_LOGOUT_SCENE_REQ = BigInt(0x38b3c3c9);
/** 位置同步（MoveReq）——回位置 ACK（subID+1），保持既有行为 */
export const GW_MOVE_REQ = BigInt(0x38b32a34);
/** 交互提交请求（领奖/AVG 完成：{1: actorId, 2: operationId("get_reward")}） */
export const GW_INTERACT_REQ = BigInt(0x38b3116d);
/**
 * 交互提交 ACK（0x38b38cd6，官服实锤 2026-08-19 抓包）
 * 形状：[4B 请求序号回显] + {1:100}。交互提交后官服下发三帧：
 * 38b38cd6 ACK → 3000ee32 奖励通知 → 38b36462 引导更新广播。
 */
export const GW_INTERACT_ACK = BigInt(0x38b38cd6);
/**
 * GuideFlags 广播（服务端引导推进后主动下发）
 * 形状：{2:{1:更新数}, 5:[{1:{1:key, 2:value}}×N]}——客户端据此更新引导状态并结束对话。
 */
export const GW_GUIDE_FLAGS_NOTIFY = BigInt(0x38b36462);
/** 状态变更广播 subID（SyncAlterDataNotify，shop.ts 购买后推送道具变更复用） */
export const GW_SYNC_ALTER_NOTIFY = GW_GUIDE_FLAGS_NOTIFY;
/**
 * 奖励/掉落通知（服务端主动下发：{1:类型, 3:生物id列表} / {1:4, 4:npcPixel id}）
 */
export const GW_REWARD_NOTIFY = BigInt(0x3000ee32);
/** 设置更新（UpdatePlayerSettingsReq：{1:settings=map<int,int>}）→ 38b3db61 回显 */
export const GW_UPDATE_SETTINGS_REQ = BigInt(0x38b36054);
export const GW_UPDATE_SETTINGS_RESP = BigInt(0x38b3db61);
/** 名片查看（GetBusinessCardReq：[seq]{1:unique_id}）→ 38b3613c BusinessCardResp */
export const GW_GET_BUSINESS_CARD_REQ = BigInt(0x38b322c3);
export const GW_GET_BUSINESS_CARD_RESP = BigInt(0x38b3613c);
/** 更换形象（ChangeOutlookReq：{1:charater, 2:skin, 3:skin_sp}）→ 38b3f7a7 回显 */
export const GW_CHANGE_OUTLOOK_REQ = BigInt(0x38b3d83c);
export const GW_CHANGE_OUTLOOK_RESP = BigInt(0x38b3f7a7);
/** 交互（InteractWithUnitReq：{1:target_unique_id, 2:action, 3:squad_index}）→ 38b3d134 */
export const GW_INTERACT_WITH_UNIT_REQ = BigInt(0x38b36055);
export const GW_INTERACT_WITH_UNIT_RESP = BigInt(0x38b3d134);
/** 动作掩码（ModifyPlayerActionReq：{1:operation, 2:state_mask}）→ ACK + 状态广播 */
export const GW_MODIFY_PLAYER_ACTION_REQ = BigInt(0x38b39680);
/** 活跃上报（ReportPlayerActiveReq：{1:count}）——fire-and-forget，不响应 */
export const GW_REPORT_ACTIVE_REQ = BigInt(0x38b3ab0c);
/** 表情/动作发送（DoRolePlayingReq：{1:emoj_id, 2:theme_id, 3:action_mask}）→ ACK */
export const GW_EMOTE = BigInt(0x38b3170a);

/* ==================== 捕捉 / 对局 / 生物 / 交换（原 handlers/play.ts） ==================== */

/** 捕捉信息查询（GetCaptureInfoReq）→ GetCaptureInfoResp */
export const GW_CAPTURE_INFO_REQ = BigInt(0xb7c2ad8b);
export const GW_CAPTURE_INFO_RESP = BigInt(0xb7c2b4de);
/** 捕捉开始（StartCaptureReq）→ StartCaptureResp，随后服务端主动推 EncounterCreatureNotify */
export const GW_START_CAPTURE_REQ = BigInt(0xb7c267d7);
export const GW_START_CAPTURE_RESP = BigInt(0xb7c2b07e);
export const GW_ENCOUNTER_CREATURE_NOTIFY = BigInt(0xb7c20f13);
/** 捕捉结束（EndCaptureReq）→ EndCaptureResp（ArkDexSettleInfo 结算） */
export const GW_END_CAPTURE_REQ = BigInt(0xb7c204e8);
export const GW_END_CAPTURE_RESP = BigInt(0xb7c26451);
/** 对局入座（JoinDuelReq）→ JoinDuelResp；入座后服务端主动推 OnJoinDuelNotify */
export const GW_JOIN_DUEL_REQ = BigInt(0xb7c277bf);
export const GW_JOIN_DUEL_RESP = BigInt(0xb7c2a2e2);
export const GW_ON_JOIN_DUEL_NOTIFY = BigInt(0xb7c2ef4f);
/** 取消对局（CancelDuelReq）→ ACK */
export const GW_CANCEL_DUEL_REQ = BigInt(0xb7c21661);
/** 对局开始（StartDuelReq）→ StartDuelResp{code} */
export const GW_START_DUEL_REQ = BigInt(0xf8faa515);
export const GW_START_DUEL_RESP = BigInt(0xf8fa2dce);
/** 回合准备 / 战报上传 / 加载完成 / 离开对局（服务端 fire-and-forget → ACK） */
export const GW_ROUND_PREPARE_REQ = BigInt(0xf8fa9c6e);
export const GW_UPLOAD_BATTLE_DATA_REQ = BigInt(0xf8faab16);
export const GW_LOADING_FINISH_REQ = BigInt(0xf8faf090);
export const GW_LEAVE_DUEL_REQ = BigInt(0xf8fad282);
/** 对局回合结算上报（DuelRoundResultReportReq）→ onDuelSettle（对局结算发券）+ ACK */
export const GW_DUEL_ROUND_RESULT_REPORT_REQ = BigInt(0xf8fa293a);
/** 交换信息（GetAllCreatureExchangeInfoReq）→ GetAllCreatureExchangeInfoResp（本地空状态） */
export const GW_GET_ALL_EXCHANGE_INFO_REQ = BigInt(0xb7c21f3a);
export const GW_GET_ALL_EXCHANGE_INFO_RESP = BigInt(0xb7c25f13);
/** 预设交换 / 发起交换 / 应答交换（单机无真实玩家 → ACK） */
export const GW_PRESET_EXCHANGE_REQ = BigInt(0xb7c2369e);
export const GW_CREATE_EXCHANGE_REQ = BigInt(0xb7c2394d);
export const GW_ANSWER_EXCHANGE_REQ = BigInt(0xb7c2be4f);
/** 交换状态广播（CreatureExchangeStateNotify，收到仅记录日志） */
export const GW_EXCHANGE_STATE_NOTIFY = BigInt(0xb7c283a3);
/** 生物管理请求（单机本地回官方 resp 或 {1:100} ACK） */
export const GW_DELETE_CREATURE_REQ = BigInt(0xb7c264e3);
export const GW_SET_CREATURE_LIKE_REQ = BigInt(0xb7c28d19);
export const GW_SET_FOLLOWING_CREATURE_REQ = BigInt(0xb7c20b13);
export const GW_SET_CREATURE_SQUAD_REQ = BigInt(0xb7c2cbf4);
/** 生物变更广播（CreatureAlterNotify，收到仅记录日志） */
export const GW_CREATURE_ALTER_NOTIFY = BigInt(0xb7c2d119);

/* ==================== 商店 / 道具 / 像素（原 handlers/shop.ts） ==================== */

/** ARKDUEL 商店请求（打开对战道具商店；请求体 [4B seq]）→ 0x28f5229c 价格表 */
export const GW_DUEL_SHOP_REQ = BigInt(0x28f5ba6f);
export const GW_DUEL_SHOP_RESP = BigInt(0x28f5229c);
/**
 * 道具购买（BuyItemReq → 店铺按序号）→ 0x28f5568f 购买响应（[4B seq回显]
 * {1:100, 2:商店序号, 3:道具, 4:数量, 5:价格, 6:剩余券数}）——28f56f2c：
 * [4B seq] {1:count, 2:index}（BuyShopItemReq f1=index/f2=count，抓包实锤修正），
 * 接 arkhubBuyProp（扣券 + 道具箱 + 生效次数 + 每日库存限购）。用道具另见 GW_USE_ITEM_REQ(28f5b1ab)。
 */
export const GW_BUY_ITEM_REQ = BigInt(0x28f56f2c);
export const GW_BUY_ITEM_RESP = BigInt(0x28f5568f);
/** 使用道具（UseItemReq：{1:item_id, 2:count}）→ UseItemResp 0x28f5de74 {1:code=100} */
export const GW_USE_ITEM_REQ = BigInt(0x28f5b1ab);
export const GW_USE_ITEM_RESP = BigInt(0x28f5de74);
/**
 * 错误提示通知（NotifyErrorMessageNotify 0x30009df1，段前缀 0x1ffd3）：
 * ErrorCodeNotify{1:error_code}——客户端 ActArkhubGamePlayModule 收后 emit ON_ERROR_CODE →
 * ActArkhubErrorCodeUtil.ShowErrorToast 按码弹官方文案（反编译消费链路实锤）。
 * 响应 f1 错误码与本帧双通道，保证提示必达。
 */
export const GW_ERROR_CODE_NOTIFY = BigInt(0x30009df1);
/** 像素上传 token 请求（RequestPixelArtUploadTokenReq：{1:pixel_art_id, 2:md5}）→ 0x31d60cf6 凭据 */
export const GW_PIXEL_UPLOAD_TOKEN_REQ = BigInt(0x31d603b3);
export const GW_PIXEL_UPLOAD_TOKEN_RESP = BigInt(0x31d60cf6);
/**
 * 像素保存确认（SavePixelArtReq：{1:pixel_art_id, 2:upload_success, 3:do_publish}，
 * HTTP savePixelArt 成功后客户端发——官方 fire-and-forget 无 ACK）→ 随后服务端
 * 主动推 PixelArtDataAlterNotify（0x31d62bbd）通知像素数据变更，客户端据此确认保存。
 */
export const GW_SAVE_PIXEL_ART_REQ = BigInt(0x31d674d5);
export const GW_PIXEL_DATA_ALTER_NOTIFY = BigInt(0x31d62bbd);
/** 收集画像（CollectPixelArtReq：{1:target_uid, 2:pixel_art_id}）——单机无真实匿名画像，
 * 记录日志后回 {1:100} ACK（subID+1）。 */
export const GW_COLLECT_PIXEL_REQ = BigInt(0x31d61490);
/**
 * 删除像素 / 删除像素收藏（DeletePixelArtReq / DeletePixelArtCollectionReq，均
 * {1:pixel_art_id}）→ 各自独立的 Resp（{1:code=100}）。
 */
export const GW_DELETE_PIXEL_REQ = BigInt(0x31d6d13b);
export const GW_DELETE_PIXEL_RESP = BigInt(0x31d67d3e);
export const GW_DELETE_PIXEL_COLLECTION_REQ = BigInt(0x31d65453);
export const GW_DELETE_PIXEL_COLLECTION_RESP = BigInt(0x31d6ea56);

/* ==================== 段前缀 / 服务端广播帧 ==================== */

/**
 * 场景段前缀（官服 low32 帧的高 32 位固定 0x2c89b3，随场景/会话变化的前缀族）。
 * 引导广播、切场景 ACK、道具变更广播均以 `(GW_SCENE_PREFIX << 32) | low32` 组帧。
 */
export const GW_SCENE_PREFIX = BigInt("0x2c89b3");
/** 错误提示段前缀（NotifyErrorMessageNotify 0x30009df1 所属段） */
export const GW_ERROR_PREFIX = BigInt("0x1ffd3");
/** 对局阶段广播（DuelStageChangeNotify，down 向——客户端不主动发） */
export const GW_DUEL_STAGE_CHANGE_NOTIFY = BigInt(0xf8faf4f3);

/**
 * 服务端下发帧（down 广播）——客户端不会主动发，注册为 log-only 使路由表覆盖协议文档 §11 全表，
 * 避免误落入通用 ACK 兜底回错帧。
 */
export const GW_LOG_ONLY_DOWN_FRAMES: ReadonlyArray<{ id: bigint; name: string }> = [
  { id: BigInt(0x38b37d3d), name: "场景数据(EnterSceneNotify)" },
  { id: BigInt(0x38b31d8f), name: "状态同步(SyncStateNotify)" },
  { id: BigInt(0x38b3360a), name: "玩家同步(SyncSceneNotify)" },
  { id: BigInt(0x38b3e70f), name: "强制定位(ForceSetPositionNotify)" },
  { id: BigInt(0x38b3f32d), name: "重连通知(OnReconnectNotify)" },
  { id: BigInt(0x38b39689), name: "中继登录(OnRelayNotify)" },
  { id: BigInt(0x30009df1), name: "错误提示(NotifyErrorMessageNotify)" },
  { id: BigInt(0x4de28c3f), name: "退出场景(SyncClientLogoutNotify)" },
];
