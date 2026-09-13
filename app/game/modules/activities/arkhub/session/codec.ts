/**
 * arkhub 网关 TCP 帧线级编解码（wire 层）
 *
 * 官服网关帧格式（抓包实测）：`[4B 大端总长度][4B mainID][8B subID][protobuf body]`。
 * 本模块只负责线级字节编解码（varint / 字段 / 整帧）与帧名注册表，不含任何业务逻辑——
 * 业务应答见 `handlers/*`，帧分发见 `arkhub-gateway-router.ts`。
 *
 * 提供：
 *   encodeVarint / encodeFieldVarint / encodeFieldBytes / encodeFieldFixed32 / buildFrame
 *     —— protobuf 字段与整帧编码（应答构建用）
 *   ProtoReader
 *     —— 游标式 protobuf 读取器（请求帧字段解析用，替代原 gateway-local 中多段重复手写循环）
 *   FRAME_NAMES
 *     —— low32 subID → 帧名注册表（日志可读化；请求/响应 subID 均收录）
 */
import { GATEWAY_HEADER_SIZE } from "./messages";

/**
 * 无符号 varint 编码（支持 64 位 BigInt）
 *
 * @param v - 待编码的数值（负数由调用方先做 64 位符号扩展）
 * @returns varint 字节
 */
export function encodeVarint(v: bigint | number): Buffer {
  const out: number[] = [];
  let value = BigInt(v);
  do {
    let byte = Number(value & BigInt(0x7f));
    value >>= BigInt(7);
    if (value !== BigInt(0)) byte |= 0x80;
    out.push(byte);
  } while (value !== BigInt(0));
  return Buffer.from(out);
}

/**
 * 编码 varint 字段（field<<3 | wire0）；value 为带符号 int64/int32——负数自动 10 字节符号扩展
 *
 * @param field - 字段号
 * @param v - 字段值
 * @returns `{tag}{varint}` 字节
 */
export function encodeFieldVarint(field: number, v: bigint | number): Buffer {
  let value = BigInt(v);
  if (value < BigInt(0)) value = BigInt.asUintN(64, value);
  return Buffer.concat([Buffer.from([field << 3]), encodeVarint(value)]);
}

/**
 * 编码 bytes/string 字段（field<<3 | wire2）
 *
 * @param field - 字段号
 * @param data - 字段内容（字节）
 * @returns `{tag}{len}{data}` 字节
 */
export function encodeFieldBytes(field: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 2]), encodeVarint(data.length), data]);
}

/**
 * 编码 fixed32 字段（field<<3 | wire5；Vector3 用 field1/2/3 → 标签 0x0d/0x15/0x1d）
 *
 * @param field - 字段号
 * @param v - float32 值
 * @returns `{tag}{4B LE float}` 字节
 */
export function encodeFieldFixed32(field: number, v: number): Buffer {
  const tag = (field << 3) | 5;
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(v, 0);
  return Buffer.concat([Buffer.from([tag]), buf]);
}

/**
 * 组帧：`[4B len][4B mainID][8B subID][body]`
 *
 * @param mainID - 消息族 ID（1=心跳 / 2=心跳回显 / 4=登录 / 8=玩法帧）
 * @param subID - 64 位子消息 ID（玩法帧高 32 位为会话/场景前缀，低 32 位为段内消息号）
 * @param proto - protobuf 消息体
 * @returns 完整帧
 */
export function buildFrame(mainID: number, subID: bigint, proto: Buffer): Buffer {
  const len = GATEWAY_HEADER_SIZE + proto.length;
  const frame = Buffer.alloc(len);
  frame.writeUInt32BE(len, 0);
  frame.writeUInt32BE(mainID, 4);
  frame.writeBigUInt64BE(subID, 8);
  proto.copy(frame, GATEWAY_HEADER_SIZE);
  return frame;
}

/**
 * 游标式 protobuf 字段读取器
 *
 * 替代原 gateway-local 中分散于各帧处理分支的多段手写解析循环
 * （readVarint/readTag/readLengthDelimited/readString 覆盖 wire0/wire2）。
 */
export class ProtoReader {
  /** 当前读取游标 */
  private p: number;

  /**
   * @param buf - 待解析字节（一般取帧体去除 [4B 请求序号] 前缀后的部分）
   * @param start - 起始偏移（缺省 0）
   */
  constructor(
    private readonly buf: Buffer,
    start = 0,
  ) {
    this.p = start;
  }

  /** 是否已读完 */
  get eof(): boolean {
    return this.p >= this.buf.length;
  }

  /** 剩余未读字节数 */
  get remaining(): number {
    return this.buf.length - this.p;
  }

  /** 读一个 varint（超界时返回已累积值） */
  readVarint(): bigint {
    let v = 0n;
    let s = 0n;
    for (;;) {
      if (this.p >= this.buf.length) return v;
      const b = this.buf[this.p++];
      v |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return v;
      s += 7n;
    }
  }

  /**
   * 读一个字段标签
   *
   * @returns { field, wire }；流结束或读到非法标签（0）返回 null
   */
  readTag(): { field: number; wire: number } | null {
    if (this.eof) return null;
    const t = this.readVarint();
    if (t === 0n) return null;
    return { field: Number(t >> 3n), wire: Number(t & 7n) };
  }

  /** 读 length-delimited 字段内容（wire2） */
  readLengthDelimited(): Buffer {
    const len = Number(this.readVarint());
    const out = this.buf.subarray(this.p, this.p + len);
    this.p += len;
    return out;
  }

  /** 读 length-delimited 字段并转为 UTF-8 字符串（wire2） */
  readString(): string {
    return this.readLengthDelimited().toString("utf8");
  }

  /** 读取当前位置的 4B 大端 uint32（请求序号回显等） */
  readUInt32BE(): number {
    const v = this.buf.readUInt32BE(this.p);
    this.p += 4;
    return v;
  }

  /** 跳过多余字节（解析失败时保留现场） */
  skip(n: number): void {
    this.p = Math.min(this.buf.length, this.p + n);
  }
}

/**
 * low32 subID → 帧名注册表（日志可读化）
 *
 * 请求/响应 subID 均收录（响应 subID 未必注册为路由——由各 handler 决定应答 subID）。
 * 值为官方消息名（docs/arkhub-gateway-protocol.md §9/§10/§11），本地未实现语义的帧仅用于日志标注。
 */
export const FRAME_NAMES: Record<string, string> = {
  // 登录（main=4，非 GamePlay 段）
  "00000fa1": "登录(UserLoginReq)",
  "00000fa2": "登录响应(UserLoginResp)",
  "00000fa3": "重连登录(UserReconnectReq)",
  "00000fa4": "重连响应(UserReconnectResp)",
  // 心跳（main=1/2）
  "00000000": "心跳(Ping/Pong)",
  // 场景（0x18fb64 段）
  "4de29cdb": "场景hello(EnterSceneReq)",
  "4de28c3f": "退出场景(SyncClientLogoutNotify)",
  // 场景/输入段（前缀 0x2c89b3）
  "38b37d3d": "场景数据(SyncEnterSceneResultNotify/EnterSceneNotify)",
  "38b3b60b": "切场景(ChangeSceneReq)",
  "38b3a5a8": "切换完成(LeaveSceneNotify)",
  "38b3c3c9": "离开场景(LogoutSceneReq)",
  "38b32a34": "位置同步(MoveReq)",
  "38b32a35": "位置ACK",
  "38b3360a": "玩家同步(SyncSceneNotify)",
  "38b31d8f": "状态同步(SyncStateNotify)",
  "38b36462": "状态变更广播(SyncAlterDataNotify)",
  "38b3116d": "交互提交(SubmitActorOpReq)",
  "38b38cd6": "交互ACK(SubmitActorOpResp)",
  "38b3170a": "表情(DoRolePlayingReq)",
  "38b36054": "设置更新(UpdatePlayerSettingsReq)",
  "38b3db61": "设置更新Resp(UpdatePlayerSettingsResp)",
  "38b322c3": "名片查看(GetBusinessCardReq)",
  "38b3613c": "名片Resp(GetBusinessCardResp)",
  "38b3d83c": "更换形象(ChangeOutlookReq)",
  "38b3f7a7": "更换形象Resp(ChangeOutlookResp)",
  "38b36055": "交互(InteractWithUnitReq)",
  "38b3d134": "交互Resp(InteractionActionResp)",
  "38b3ab0c": "活跃上报(ReportPlayerActiveReq)",
  "38b39680": "动作掩码(ModifyPlayerActionReq)",
  "38b3e70f": "强制定位(ForceSetPositionNotify)",
  "38b3f32d": "重连通知(OnReconnectNotify)",
  "38b39689": "中继登录(OnRelayNotify)",
  // 通知段（前缀 0x1ffd3）
  "30009df1": "错误提示(NotifyErrorMessageNotify)",
  "3000ee32": "Toast提示(NotifyToastMessageNotify)",
  // 捕捉段（前缀 0x29854b → low b7c2）
  "b7c2ad8b": "捕捉信息Req(GetCaptureInfoReq)",
  "b7c2b4de": "捕捉信息Resp(GetCaptureInfoResp)",
  "b7c267d7": "捕捉开始(StartCaptureReq)",
  "b7c2b07e": "捕捉开始Resp(StartCaptureResp)",
  "b7c20f13": "遭遇生物(EncounterCreatureNotify)",
  "b7c204e8": "捕捉结束(EndCaptureReq)",
  "b7c26451": "捕捉结算Resp(EndCaptureResp)",
  // 对局段（入座前缀 0x29854b / 战斗前缀 0x3e546f → low f8fa）
  "b7c277bf": "对局入座(JoinDuelReq)",
  "b7c2a2e2": "对局入座Resp(JoinDuelResp)",
  "b7c2ef4f": "入座广播(OnJoinDuelNotify)",
  "b7c21661": "取消对局(CancelDuelReq)",
  "f8faa515": "对局开始(StartDuelReq)",
  "f8fa2dce": "对局开始Resp(StartDuelResp)",
  "f8faf090": "加载完成(LoadingFinishReq)",
  "f8fa9c6e": "回合准备(RoundPrepareReq)",
  "f8fa293a": "回合结算上报(DuelRoundResultReportReq)",
  "f8faf4f3": "阶段广播(DuelStageChangeNotify)",
  "f8fad282": "离开对局(LeaveDuelReq)",
  "f8faab16": "战报上传(UploadBattleDataReq)",
  // 生物段（前缀 0x29854b）
  "b7c264e3": "删除生物(DeleteCreatureReq)",
  "b7c28d19": "生物点赞(SetCreatureLikeReq)",
  "b7c20b13": "跟随宠物(SetFollowingCreatureReq)",
  "b7c2cbf4": "生物编队(SetCreatureSquadReq)",
  "b7c2d119": "生物变更广播(CreatureAlterNotify)",
  // 交换段（前缀 0x29854b）
  "b7c283a3": "交换状态广播(CreatureExchangeStateNotify)",
  "b7c2369e": "预设交换(PresetCreatureExchangeReq)",
  "b7c2394d": "发起交换(CreateCreatureExchangeReq)",
  "b7c2be4f": "应答交换(AnswerCreatureExchangeReq)",
  "b7c21f3a": "交换信息Req(GetAllCreatureExchangeInfoReq)",
  "b7c25f13": "交换信息Resp(GetAllCreatureExchangeInfoResp)",
  // 商店/道具段（前缀 0x208c32）
  "28f5ba6f": "商店信息(GetShopInfoReq)",
  "28f5229c": "商店信息Resp(GetShopInfoResp)",
  "28f56f2c": "购买道具(BuyItemReq)",
  "28f5568f": "购买Resp(BuyItemResp)",
  "28f5b1ab": "使用道具(UseItemReq)",
  "28f5de74": "使用道具Resp(UseItemResp)",
  // 像素画段（前缀 0x29ce23）
  "31d603b3": "像素上传token(RequestPixelArtUploadTokenReq)",
  "31d60cf6": "像素token Resp",
  "31d674d5": "像素保存确认(SavePixelArtReq)",
  "31d62bbd": "像素变更广播(PixelArtDataAlterNotify)",
  "31d61490": "收集画像(CollectPixelArtReq)",
  "31d6d13b": "删除像素(DeletePixelArtReq)",
  "31d65453": "删除像素收藏(DeletePixelArtCollectionReq)",
  "31d67d3e": "删除像素Resp(DeletePixelArtResp)",
  "31d6ea56": "删除像素收藏Resp(DeletePixelArtCollectionResp)",
};
