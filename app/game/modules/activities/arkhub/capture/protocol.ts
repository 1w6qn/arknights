/**
 * 奇象巡展（arkhub）网关 TCP 协议解析
 *
 * 官服网关（arkhub-gateway.hypergryph.com:30000）的帧格式（实测，见 capture-forward-mode 记忆）：
 *   [4B 大端总长度][4B 大端消息 ID][8B 头字段（seq/标志等，含义待确认）][protobuf payload]
 *
 * 实测 3176 帧 up 流零断帧；down 流登录阶段（65 帧）同格式，登录后变为另一类结构
 * （连续 protobuf/自定义封装，需进一步逆向——解析器对无法按长度前缀切分的余量如实报告）。
 *
 * 提供：
 *   splitGatewayFrames   —— 按长度前缀切帧（容错：断帧即停，返回余量）
 *   decodeProtobuf       —— 通用 protobuf 解码（varint/64bit/length-delimited/32bit + 嵌套消息）
 *   parseGatewayStream   —— 整流解析 → 帧数组（含解码 payload）+ 余量
 *   MSG_NAMES            —— 观测到的消息 ID → 名称映射（best-effort）
 */
import { logger } from "@utils/logger";
import { GATEWAY_HEADER_SIZE } from "../session/messages";

/**
 * 消息 ID → 名称（2026-08-11 由反编译注册表 LongServiceProtocolTypeID/SubID 确认）：
 *   1 = MsgPing（up，[type, param]）
 *   2 = MsgPong（down，回显 ping + 时间戳/序号）
 *   4 = Login（UserLoginReq up / UserLoginResp down，同 ID 分方向）
 *   8 = MoveReq（up：{Status, Shrink, Position(Vector3), Time}；down 为服务器广播变体）
 * 其余 GamePlay 消息（CheckVersion/SyncScene/InteractWithUnit/DoRolePlaying/SubmitActorOp/
 * PixelArt/Shop 系列等 83 条）见 docs/arkhub-gateway-protocol.md §9 注册表。
 */
export const MSG_NAMES: Record<number, string> = {
  1: "Ping",
  2: "Pong",
  4: "Login",
  8: "MoveReq",
};

/**
 * 已确认的 protobuf schema（字段号 → 字段名，按声明顺序；由抓包实测值反推验证）：
 *   msgId 4 up   = UserLoginReq   —— field1=uid、2=secret、3=loginChannel、4=deviceId、5=gameContext（实测 ✓）
 *   msgId 4 down = UserLoginResp  —— field1=code、2=heartbeatInterval、3=reconnectToken、4=ip、5=port（实测 ✓）
 * 其余网关消息的类名/字段名已从 .cs 提取，但 msgId 注册表在编译体内无法提取，待逐帧观测补充。
 */
export const MSG_SCHEMAS: Record<number, { name: string; up?: string[]; down?: string[] }> = {
  4: {
    name: "Login",
    up: ["uid", "secret", "loginChannel", "deviceId", "gameContext"],
    down: ["code", "heartbeatInterval", "reconnectToken", "ip", "port"],
  },
  8: {
    name: "MoveReq",
    // up 向：field3=Position（15B Vector3 自动解为 vec3）
    up: ["status", "shrink", "position", "time"],
  },
};

/**
 * 定长二进制 payload 的解释（msgId 1/2 等，按 4B 大端 uint32 分段）。
 * 实测 msgId 1（up 移动输入）与 msgId 2（down 位置广播）均为 [type:uint32][param:uint32]（+8B extra）；
 * type 0-3 为四种输入/移动命令。
 */
export function decodeFixedPayload(payload: Buffer): number[] {
  const words: number[] = [];
  for (let off = 0; off + 4 <= payload.length; off += 4) {
    words.push(payload.readUInt32BE(off));
  }
  return words;
}

/**
 * 已知的定长二进制 schema（非 protobuf，按字段名解释）：
 *   msgId 1 = {type, param}      —— 移动输入命令（type 0-3；up 向）
 *   msgId 2 = {type, param, extra1, extra2} —— 位置广播（down 向，type/param 与 up 输入一致 = 服务器回显广播）
 */
export const FIXED_SCHEMAS: Record<number, string[]> = {
  1: ["type", "param"],
  2: ["type", "param", "extra1", "extra2"],
};

/** 按 FIXED_SCHEMAS 命名定长二进制 payload */
export function decodeFixedWithSchema(payload: Buffer, fieldNames: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let off = 0; off + 4 <= payload.length; off += 4) {
    const idx = off / 4;
    const name = idx < fieldNames.length ? fieldNames[idx] : `word${idx}`;
    out[name] = payload.readUInt32BE(off);
  }
  return out;
}

/** protobuf wire type 名称 */
export const WIRE_NAMES: Record<number, string> = {
  0: "varint",
  1: "fixed64",
  2: "length-delimited",
  3: "start-group",
  4: "end-group",
  5: "fixed32",
};

/** 解码后的 protobuf 字段 */
export interface PbField {
  /** 字段号 */
  field: number;
  /** wire type（0/1/2/5） */
  wire: number;
  /** wire type 名称 */
  wireName: string;
  /** varint 数值 */
  varint?: bigint;
  /** 64-bit 数值 */
  fixed64?: bigint;
  /** 32-bit 数值 */
  fixed32?: number;
  /** length-delimited 原始字节（hex） */
  bytes?: string;
  /** length-delimited 若为合法 UTF-8 字符串则给出 */
  str?: string;
  /** length-delimited 若能再解为嵌套 protobuf 则给出子字段 */
  nested?: PbField[];
  /** 15B Vector3 位置（field 匹配 0x0d/0x15/0x1d 三个 fixed32） */
  vec3?: { x: number; y: number; z: number };
}

/**
 * 解码产物的 JSON 友好值：varint/fixed64 → 字符串、fixed32 → 数字、
 * length-delimited → 文本/hex/嵌套对象/vec3；字段缺失为 undefined。
 */
export type PbDecodedValue = string | number | undefined | PbDecodedValue[] | { [key: string]: PbDecodedValue };

/**
 * 解码 protobuf 字段序列（通用，不依赖 schema）
 *
 * 支持 wire type 0(varint)/1(fixed64)/2(length-delimited)/5(fixed32)；
 * length-delimited 字段若字节可完整解码为 protobuf 且首个标签合法，则递归为 nested，
 * 否则保留 bytes（并尝试 str）。
 *
 * @param buf - 待解码字节
 * @returns 字段数组；首字节不是合法标签时返回空数组（调用方据此判断是否嵌套消息）
 */
export function decodeProtobuf(buf: Buffer): PbField[] {
  return decodeProtobufWalk(buf, 0).fields;
}

/** 内部：从 start 开始解码，返回字段数组 + 实际消费到的 end 偏移（用于余量恢复） */
function decodeProtobufWalk(buf: Buffer, start: number): { fields: PbField[]; end: number } {
  const fields: PbField[] = [];
  let off = start;
  while (off < buf.length) {
    const tag = readVarint(buf, off);
    if (tag === null) break;
    const tagValue = tag.value;
    const field = Number(tagValue >> 3n);
    const wire = Number(tagValue & 7n);
    if (field === 0 || wire === 6 || wire === 7) {
      // 非法标签：停止，off 停在标签起点（不推进——余量恢复要靠起点位置跳过 4B 前缀）
      break;
    }
    off = tag.next;
    const entry: PbField = { field, wire, wireName: WIRE_NAMES[wire] ?? `wire${wire}` };
    switch (wire) {
      case 0: {
        const v = readVarint(buf, off);
        if (!v) { off = buf.length; break; }
        entry.varint = v.value;
        off = v.next;
        break;
      }
      case 1: {
        if (off + 8 > buf.length) { off = buf.length; break; }
        entry.fixed64 = buf.readBigUInt64LE(off);
        off += 8;
        break;
      }
      case 2: {
        const len = readVarint(buf, off);
        if (!len) { off = buf.length; break; }
        const size = Number(len.value);
        off = len.next;
        if (off + size > buf.length) { off = buf.length; break; }
        const bytes = buf.subarray(off, off + size);
        entry.bytes = bytes.toString("hex");
        entry.str = toUtf8(bytes);
        // Vector3 位置块（msgId8 等：0x0d/0x15/0x1d + 3×f32）
        const vec3 = decodeVector3(bytes);
        if (vec3) entry.vec3 = vec3;
        // 尝试嵌套解码：仅当首个字段是 varint(0)/length-delimited(2) 且整体不是可读文本
        // （纯 ASCII 字符串如 "100566259" 会被 toUtf8 命中，判为文本而非嵌套消息）
        if (isPlausibleNestedStart(bytes)) {
          const nested = decodeProtobuf(bytes);
          if (nested.length > 0) entry.nested = nested;
        }
        off += size;
        break;
      }
      case 5: {
        if (off + 4 > buf.length) { off = buf.length; break; }
        entry.fixed32 = buf.readUInt32LE(off);
        off += 4;
        break;
      }
      default:
        // group 类型（3/4）不再支持：停止
        off = buf.length;
        break;
    }
    fields.push(entry);
  }
  return { fields, end: off };
}

/**
 * 余量 protobuf 恢复（down 登录后为连续 protobuf 消息，无外层长度前缀）：
 * 在前 maxScan 字节内扫描最佳干净起点（解码字段数最多），返回恢复的字段与消费区间。
 */
export function recoverProtobufRegion(
  buffer: Buffer,
  maxScan = 512,
): { start: number; fields: PbField[]; end: number } | null {
  let best: { start: number; fields: PbField[]; end: number } | null = null;
  const limit = Math.min(buffer.length, maxScan);
  for (let s = 0; s < limit; s++) {
    const { fields, end } = decodeProtobufWalk(buffer, s);
    // 起点须是合法 protobuf 标签且至少解出 2 个字段才考虑
    if (fields.length >= 2 && (!best || fields.length > best.fields.length)) {
      best = { start: s, fields, end };
    }
  }
  return best;
}

/**
 * 带 4B 前缀跳过的余量恢复（down 登录后专用）
 *
 * down 流登录后每条消息/记录形如 `[00 00 00 <type>][protobuf]`（实测余量中 18936 处该前缀），
 * 解码器在 `00`（field 0 非法标签）处停止。此模式在遇到 `00 00 00 XX` 前缀时跳过 4 字节继续解，
 * 可把登录后的玩家/单元记录（uid/昵称/哈希/时间戳）成片恢复。
 */
export function recoverProtobufWithPrefixSkip(
  buffer: Buffer,
  maxScan = 512,
): { start: number; fields: PbField[]; end: number; prefixSkips: number } | null {
  const limit = Math.min(buffer.length, maxScan);

  const walk = (start: number): { fields: PbField[]; end: number; prefixSkips: number } => {
    const fields: PbField[] = [];
    let off = start;
    let skips = 0;
    while (off < buffer.length) {
      // 4B 前缀跳过：00 00 00 XX + 后续合法标签
      if (
        buffer[off] === 0 &&
        buffer[off + 1] === 0 &&
        buffer[off + 2] === 0 &&
        off + 5 < buffer.length &&
        isPlausibleTag(buffer[off + 4])
      ) {
        off += 4;
        skips++;
        continue;
      }
      const step = decodeProtobufWalk(buffer, off);
      if (step.fields.length === 0) break;
      fields.push(...step.fields);
      if (step.end <= off) break;
      off = step.end;
    }
    return { fields, end: off, prefixSkips: skips };
  };

  // 先试前缀边界起步（记录流起点应在 [00 00 00 XX] 处），无结果再通用扫描兜底
  const scan = (startFilter: (s: number) => boolean): { start: number; fields: PbField[]; end: number; prefixSkips: number } | null => {
    let best: { start: number; fields: PbField[]; end: number; prefixSkips: number } | null = null;
    for (let s = 0; s < limit; s++) {
      if (!startFilter(s)) continue;
      const { fields, end, prefixSkips } = walk(s);
      // 起点须解出足够字段；同字段数取更早起点（避免垃圾中间点因"假字段"胜出）
      if (fields.length >= 4 && (!best || fields.length > best.fields.length)) {
        best = { start: s, fields, end, prefixSkips };
      }
    }
    return best;
  };
  const isBoundary = (s: number): boolean => s === 0 || (buffer[s] === 0 && buffer[s + 1] === 0 && buffer[s + 2] === 0);
  return scan(isBoundary) ?? scan(() => true);
}

/** 读 varint，返回 { value, next }；超出边界或损坏返回 null */
function readVarint(buf: Buffer, start: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = start; i < buf.length && i < start + 10; i++) {
    const b = buf[i];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  return null;
}

/**
 * 判断 length-delimited 字节是否可能为嵌套 protobuf：
 * 首个字段须为 varint(0) 或 length-delimited(2)（游戏消息首字段几乎都是小字段号），
 * 且整体不是可读 UTF-8 文本（纯 ASCII 字符串如 uid 判为文本，避免误判嵌套）
 */
function isPlausibleNestedStart(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  const wire = buf[0] & 7;
  if (wire !== 0 && wire !== 2) return false;
  if (toUtf8(buf) !== undefined) return false;
  return true;
}

/** 首字节是否为合法 protobuf 标签（wire type 非保留值 6/7） */
function isPlausibleTag(b: number): boolean {
  const wire = b & 7;
  return wire !== 6 && wire !== 7;
}

/** 尝试 UTF-8 解码（仅当全部字节可解码且无控制字符时给出） */
function toUtf8(buf: Buffer): string | undefined {
  try {
    const s = buf.toString("utf8");
    // 全 ASCII 可打印或合法 UTF-8 中文；含不可见控制符（除 \n\r\t）视为二进制
    if (buf.length > 0 && /^[\x20-\x7e\n\r\t\u00a0-\uffff]*$/.test(s) && s.length === buf.length) {
      return s;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按字段名 schema 解码 protobuf 字段（字段号 i+1 → fieldNames[i]）
 *
 * 已知 schema（MSG_SCHEMAS）时把字段树转成 { 字段名: 值 } 的对象，值类型：
 * varint/fixed32/fixed64 → number|string、length-delimited → 文本/hex/嵌套对象。
 * 仅当字段号 ≤ fieldNames 长度且 wire 匹配时命名；否则保留通用结构。
 */
export function decodeWithSchema(fields: PbField[], fieldNames: string[]): Record<string, PbDecodedValue> {
  const out: Record<string, PbDecodedValue> = {};
  for (const f of fields) {
    const name = f.field >= 1 && f.field <= fieldNames.length ? fieldNames[f.field - 1] : `field${f.field}`;
    let value: PbDecodedValue;
    if (f.varint !== undefined) value = f.varint.toString();
    else if (f.fixed64 !== undefined) value = f.fixed64.toString();
    else if (f.fixed32 !== undefined) value = f.fixed32;
    else if (f.str !== undefined) value = f.str;
    else if (f.vec3) value = f.vec3;
    else if (f.nested) value = decodeWithSchema(f.nested, []);
    else if (f.bytes !== undefined) value = `0x${f.bytes}`;
    else value = undefined;
    // 重复字段 → 数组
    if (name in out) {
      out[name] = Array.isArray(out[name]) ? [...(out[name] as PbDecodedValue[]), value] : [out[name], value];
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * 容错全流恢复（down 记录流最终武器）：
 * 跳过 `00 00 00 XX` 前缀；可解 protobuf 段则收集并按消费偏移推进；
 * 无效标签跳 1 字节重新同步（resyncs）。把整段余量能解的内容最大化恢复。
 */
export function recoverProtobufStream(
  buffer: Buffer,
  maxResyncs = 50000,
): { fields: PbField[]; resyncs: number; prefixSkips: number; segments: number } {
  const fields: PbField[] = [];
  let off = 0;
  let resyncs = 0;
  let prefixSkips = 0;
  let segments = 0;
  while (off < buffer.length) {
    // 4B 前缀 [00 00 00 XX]
    if (
      buffer[off] === 0 &&
      buffer[off + 1] === 0 &&
      buffer[off + 2] === 0 &&
      off + 5 < buffer.length &&
      (buffer[off + 4] & 7) <= 2
    ) {
      off += 4;
      prefixSkips++;
      continue;
    }
    const step = decodeProtobufWalk(buffer, off);
    if (step.fields.length > 0) {
      fields.push(...step.fields);
      segments++;
      if (step.end <= off) {
        off++;
        resyncs++;
      } else {
        off = step.end;
      }
      continue;
    }
    off++;
    resyncs++;
    if (resyncs > maxResyncs) break;
  }
  return { fields, resyncs, prefixSkips, segments };
}

/**
 * 识别并解码 15B Vector3 protobuf（msgId 8 的位置块）
 *
 * 实测位置块 = `[0x0d][f32 X][0x15][f32 Y][0x1d][f32 Z]`——0x0d/0x15/0x1d 即
 * protobuf field1/2/3 wire5(fixed32) 标签，三个 float32（大厅坐标：X∈[-3,12]、Y∈[-0.3,1.5]、Z∈[-7,9]）。
 */
export function decodeVector3(payload: Buffer): { x: number; y: number; z: number } | null {
  if (payload.length !== 15) return null;
  if (payload[0] !== 0x0d || payload[5] !== 0x15 || payload[10] !== 0x1d) return null;
  return {
    x: payload.readFloatLE(1),
    y: payload.readFloatLE(6),
    z: payload.readFloatLE(11),
  };
}

/**
 * 识别 PixelArtInfo 记录（down 记录流 field1 元素）
 *
 * 实测 down 登录后记录流的 field1 元素结构 `{1:id, 2:32hexMd5, 4:createTime, 5:updateTime, 7:revision}`
 * 与客户端 `PixelArtInfo {Id, Md5, Status, CreateTime, UpdateTime, PublishTime, Revision, CollectedCount}`
 * 完全吻合（14/14 样本匹配）——记录流即大厅展示的像素画列表同步。
 */
export function decodePixelArtInfo(fields: PbField[]): Record<string, PbDecodedValue> | null {
  const f = (n: number): PbField | undefined => fields.find((x) => x.field === n);
  const id = f(1)?.varint;
  const md5 = f(2)?.str ?? f(2)?.bytes;
  const createTime = f(4)?.varint;
  const updateTime = f(5)?.varint;
  const revision = f(7)?.varint;
  if (id === undefined || !md5 || createTime === undefined || updateTime === undefined) return null;
  return {
    id: id.toString(),
    md5: typeof md5 === "string" && md5.length === 64 ? md5 : undefined,
    createTime: Number(createTime),
    updateTime: Number(updateTime),
    revision: revision !== undefined ? Number(revision) : undefined,
  };
}

/**
 * 跨 raw wrapper 续链切帧（down 流完整解析）
 *
 * down 流 = [标准帧×N][raw wrapper（无长度前缀的 PixelArtData 同步，如 2176B）][标准帧×N]...
 * 标准帧链断点处：向前扫描下一个合法标准帧头（len 16-5000 + 已知 msgId + 可续链），
 * 断点与续链起点之间的字节作为 wrapper 原样返回（调用方可做 protobuf 恢复）。
 */
export function splitGatewayFramesFull(buffer: Buffer, direction?: "up" | "down"): {
  frames: GatewayFrame[];
  /** raw wrapper 字节段（断点→续链点） */
  wrappers: { start: number; end: number; bytes: Buffer }[];
  /** 未能续链的尾部 */
  tail: Buffer;
} {
  const KNOWN_MSGIDS = new Set([1, 2, 4, 8, 16, 32, 64, 128]);
  const frames: GatewayFrame[] = [];
  const wrappers: { start: number; end: number; bytes: Buffer }[] = [];
  let off = 0;

  const findResume = (from: number): number | null => {
    for (let p = from; p + 8 <= buffer.length && p - from < 50000; p++) {
      const len = buffer.readUInt32BE(p);
      if (len < 16 || len > 5000 || p + len > buffer.length) continue;
      const msgId = buffer.readUInt32BE(p + 4);
      if (!KNOWN_MSGIDS.has(msgId)) continue;
      // 续链帧自身的 payload 应可解（宽松：仅要求再下一帧头合法）
      const next = p + len;
      if (next + 8 <= buffer.length) {
        const nextLen = buffer.readUInt32BE(next);
        if (nextLen >= 16 && next + nextLen <= buffer.length) return p;
      }
      return p;
    }
    return null;
  };

  while (off + 4 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    if (len < GATEWAY_HEADER_SIZE || off + len > buffer.length) {
      // 断点：尝试找续链点
      const resume = findResume(off + 1);
      if (resume === null) break;
      wrappers.push({ start: off, end: resume, bytes: buffer.subarray(off, resume) });
      off = resume;
      continue;
    }
    const msgId = buffer.readUInt32BE(off + 4);
    const seq = buffer.readUInt32BE(off + 8);
    const flag = buffer.readUInt32BE(off + 12);
    const payload = buffer.subarray(off + GATEWAY_HEADER_SIZE, off + len);
    const fields = decodeProtobuf(payload);
    const frame: GatewayFrame = {
      len,
      msgId,
      name: MSG_NAMES[msgId] ?? `Msg${msgId}`,
      seq,
      flag,
      headerHex: buffer.subarray(off + 8, off + 16).toString("hex"),
      fields,
      payloadHex: payload.toString("hex"),
    };
    const schema = MSG_SCHEMAS[msgId];
    if (schema && direction && (direction === "up" ? schema.up : schema.down)) {
      const names = direction === "up" ? schema.up! : schema.down!;
      frame.named = decodeWithSchema(fields, names);
    } else if (fields.length === 0 && payload.length > 0 && payload.length % 4 === 0) {
      const fixedNames = FIXED_SCHEMAS[msgId];
      if (fixedNames) frame.named = decodeFixedWithSchema(payload, fixedNames);
      else frame.fixed = decodeFixedPayload(payload);
    }
    frames.push(frame);
    off += len;
  }
  return { frames, wrappers, tail: buffer.subarray(off) };
}

/** 单帧解析结果 */
export interface GatewayFrame {
  /** 帧总长（含帧头） */
  len: number;
  /** 消息 ID */
  msgId: number;
  /** 消息名称（MSG_NAMES 命中或未知） */
  name: string;
  /** 头字段 8-11（uint32，疑似 seq） */
  seq: number;
  /** 头字段 12-15（uint32，疑似 flag/计数） */
  flag: number;
  /** 原始头 8B（hex） */
  headerHex: string;
  /** protobuf 解码后的字段（空表示非 protobuf payload） */
  fields: PbField[];
  /** 按 schema 命名的 payload（MSG_SCHEMAS 命中时） */
  named?: Record<string, PbDecodedValue>;
  /** 定长二进制 payload 的解释（非 protobuf，如 msgId 1/2 按 4B uint32） */
  fixed?: number[];
  /** 原始 payload（hex） */
  payloadHex: string;
}

/** 整流解析结果 */
export interface GatewayStreamResult {
  /** 成功切分的帧 */
  frames: GatewayFrame[];
  /** 剩余未解析字节（登录后 down 流等无法按长度前缀切分的部分） */
  remainder: Buffer;
  /** raw wrapper 段（标准帧链断点→续链点；down 流为 PixelArtData 等无长度前缀的同步消息） */
  wrappers?: { start: number; end: number; bytes: Buffer; fields: PbField[] }[];
  /** 余量 protobuf 恢复结果（down 登录后连续 protobuf 消息的部分解码） */
  recovered?: { start: number; fields: PbField[]; end: number; prefixSkips: number };
}

/**
 * 按长度前缀切帧
 *
 * @param buffer - 完整字节流
 * @param direction - "up"/"down"（MSG_SCHEMAS 分方向命名用，缺省不命名）
 * @returns 帧数组（断帧即停止解析，余量由 parseGatewayStream 保留）
 */
export function splitGatewayFrames(buffer: Buffer, direction?: "up" | "down"): GatewayFrame[] {
  const frames: GatewayFrame[] = [];
  let off = 0;
  while (off + 4 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    if (len < GATEWAY_HEADER_SIZE || off + len > buffer.length) break;
    const msgId = buffer.readUInt32BE(off + 4);
    const seq = buffer.readUInt32BE(off + 8);
    const flag = buffer.readUInt32BE(off + 12);
    const payload = buffer.subarray(off + GATEWAY_HEADER_SIZE, off + len);
    const fields = decodeProtobuf(payload);
    const frame: GatewayFrame = {
      len,
      msgId,
      name: MSG_NAMES[msgId] ?? `Msg${msgId}`,
      seq,
      flag,
      headerHex: buffer.subarray(off + 8, off + 16).toString("hex"),
      fields,
      payloadHex: payload.toString("hex"),
    };
    // schema 命名（登录双向已确认）；定长二进制按 4B 大端 uint32 解释（msgId 1/2 有命名 schema）
    const schema = MSG_SCHEMAS[msgId];
    if (schema && direction && (direction === "up" ? schema.up : schema.down)) {
      const names = direction === "up" ? schema.up! : schema.down!;
      frame.named = decodeWithSchema(fields, names);
    } else if (fields.length === 0 && payload.length > 0 && payload.length % 4 === 0) {
      const fixedNames = FIXED_SCHEMAS[msgId];
      if (fixedNames) {
        frame.named = decodeFixedWithSchema(payload, fixedNames);
      } else {
        frame.fixed = decodeFixedPayload(payload);
      }
    }
    frames.push(frame);
    off += len;
  }
  return frames;
}

/**
 * 解析整条网关字节流
 *
 * @param buffer - 原始字节流（up 或 down）
 * @param label - 方向（"up"/"down"，日志用）
 * @returns 解析结果
 */
export function parseGatewayStream(buffer: Buffer, label: string): GatewayStreamResult {
  // 完整切分：标准帧链 + 跨 raw wrapper 续链（down 流的 PixelArtData 同步 wrapper）
  const full = splitGatewayFramesFull(buffer, label === "up" ? "up" : "down");
  const frames = full.frames;
  const consumed = frames.reduce((sum, f) => sum + f.len, 0) +
    full.wrappers.reduce((sum, w) => sum + w.bytes.length, 0);
  const remainder = buffer.subarray(consumed);
  const result: GatewayStreamResult = { frames, remainder };

  if (full.wrappers.length > 0) {
    // wrapper 是 raw protobuf（无长度前缀），解码其中可读部分
    result.wrappers = full.wrappers.map((w) => {
      const best = recoverProtobufWithPrefixSkip(w.bytes);
      return {
        start: w.start,
        end: w.end,
        bytes: w.bytes,
        fields: best ? best.fields : [],
      };
    });
    logger.info(
      "arkodc",
      `${label} 流：${frames.length} 帧 + ${full.wrappers.length} 个 raw wrapper（${full.wrappers.map((w) => w.bytes.length).join("/")}B）`,
    );
  }

  if (remainder.length > 0) {
    const recovered = recoverProtobufWithPrefixSkip(remainder);
    if (recovered && recovered.fields.length >= 2) {
      result.recovered = recovered;
      logger.warn(
        "arkodc",
        `${label} 流余 ${remainder.length}B：已从偏移 ${recovered.start} 恢复 ${recovered.fields.length} 个字段（跳过 ${recovered.prefixSkips} 个 4B 前缀，消费 ${recovered.end}B）`,
      );
    } else {
      logger.warn(
        "arkodc",
        `${label} 流解析 ${frames.length} 帧后余 ${remainder.length}B 无法按长度前缀切分`,
      );
    }
  }
  return result;
}

/** 将 protobuf 字段树序列化为 JSON 友好对象 */
export function fieldsToJson(fields: PbField[]): PbDecodedValue[] {
  return fields.map((field) => ({
    field: field.field,
    wire: field.wireName,
    varint: field.varint !== undefined ? field.varint.toString() : undefined,
    fixed64: field.fixed64 !== undefined ? field.fixed64.toString() : undefined,
    fixed32: field.fixed32,
    str: field.str,
    vec3: field.vec3,
    bytes: field.bytes,
    nested: field.nested ? fieldsToJson(field.nested) : undefined,
  }));
}

/** 将解析结果序列化为 JSON 友好对象（bytes/varint 等转字符串） */
export function framesToJson(frames: GatewayFrame[]): PbDecodedValue[] {
  return frames.map((f) => ({
    len: f.len,
    msgId: f.msgId,
    name: f.name,
    seq: f.seq,
    flag: f.flag,
    headerHex: f.headerHex,
    named: f.named,
    fixed: f.fixed,
    payload: f.fields.length ? fieldsToJson(f.fields) : undefined,
  }));
}

/** 可读消息记录（还原真实 request/response） */
export interface GatewayMessage {
  /** 方向：up=客户端请求、down=服务器响应/广播 */
  dir: "up" | "down";
  msgId: number;
  name: string;
  /** 会话 ID（帧头 8-11） */
  seq: number;
  /** 帧头 12-15 */
  flag: number;
  /** 还原的可读内容（named 优先；无 schema 时给字段树/hex） */
  body: PbDecodedValue;
}

/** 请求-响应配对（1:1 语义配对：Login、Ping/Pong 等） */
export interface GatewayPair {
  name: string;
  request: GatewayMessage | null;
  response: GatewayMessage | null;
}

/** 单方向帧 → 可读消息记录 */
function toMessages(frames: GatewayFrame[], dir: "up" | "down"): GatewayMessage[] {
  return frames.map((f) => ({
    dir,
    msgId: f.msgId,
    name: f.name,
    seq: f.seq,
    flag: f.flag,
    body: f.named ?? f.fixed ?? (f.fields.length ? fieldsToJson(f.fields) : `0x${f.payloadHex}`),
  }));
}

/**
 * 生成真实可读的 request/response 消息记录
 *
 * 把 up/down 帧按语义还原为可读消息（Login/MoveReq/Ping/Pong 命名解码），
 * 并按 1:1 语义配对（Login Req→Resp、Ping→Pong）。seq 为会话 ID 非请求序号，
 * 故配对仅限语义明确的请求-响应对。
 *
 * @param up - up 流解析结果
 * @param down - down 流解析结果
 * @returns { up, down, pairs }——可读消息列表 + 配对
 */
export function gatewayTranscript(
  up: GatewayStreamResult,
  down: GatewayStreamResult,
): { up: GatewayMessage[]; down: GatewayMessage[]; pairs: GatewayPair[] } {
  const upMsgs = toMessages(up.frames, "up");
  const downMsgs = toMessages(down.frames, "down");
  const pairs: GatewayPair[] = [];

  const pair = (name: string, upMsgId: number, downMsgId: number): void => {
    const req = upMsgs.find((m) => m.msgId === upMsgId);
    const resp = downMsgs.find((m) => m.msgId === downMsgId);
    if (req || resp) pairs.push({ name, request: req ?? null, response: resp ?? null });
  };
  pair("Login", 4, 4);
  pair("Ping/Pong", 1, 2);

  return { up: upMsgs, down: downMsgs, pairs };
}
