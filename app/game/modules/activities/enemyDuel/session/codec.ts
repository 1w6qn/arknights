/**
 * 怪猎对决（EnemyDuel）实时会话服——线级编解码
 *
 * 协议参考 `OpenBachelorSS`：`pkg/protocol/protocol.go`（帧）+ `pkg/contract/payloads.go`
 * （字段编码）。**帧格式与字段序照抄参考实现，不要"顺手优化"**：
 *
 * - 帧 = `[uint32 BE payload 长度][uint32 BE 消息类型][payload]`，读侧限长 1 MB
 * - 字符串 = `uint16 BE 字节长度` + UTF-8 字节
 * - 切片 = `uint16 BE 元素数` + 元素依次序列化
 * - 上限：字符串 1024B（`MAX_STR_SIZE`）、切片 128 元素（`MAX_SLICE_SIZE`）
 *
 * 本文件只做字节层读写；消息结构见 `payloads.ts`，状态机见 `game.ts`。
 */

/** 帧头字节数：4B payload 长度 + 4B 消息类型 */
export const ENVELOPE_HEADER_SIZE = 8;
/** payload 长度上限（1 MB，与参考实现一致） */
export const MAX_PAYLOAD_SIZE = 1 << 20;
/** 字符串长度上限（字节） */
export const MAX_STR_SIZE = 1 << 10;
/** 切片元素数上限 */
export const MAX_SLICE_SIZE = 128;

/** 一帧（消息类型 + payload） */
export interface EnemyDuelEnvelope {
  /** 消息类型号（见 messages.ts） */
  type: number;
  /** 消息体 */
  payload: Buffer;
}

/** 编码一帧（长度前缀 + 类型 + payload） */
export function encodeEnvelope(env: EnemyDuelEnvelope): Buffer {
  const head = Buffer.alloc(ENVELOPE_HEADER_SIZE);
  head.writeUInt32BE(env.payload.length, 0);
  head.writeUInt32BE(env.type >>> 0, 4);
  return Buffer.concat([head, env.payload]);
}

/** 帧解析错误：长度非法 / 声明长度超上限 */
export class EnvelopeDecodeError extends Error {
  /**
   * @param message 错误说明
   */
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeDecodeError";
  }
}

/**
 * 流式帧读取器：socket 分片到达时 `push(chunk)`，返回本次切出的全部完整帧
 *
 * 声明长度超过 {@link MAX_PAYLOAD_SIZE} 时抛 {@link EnvelopeDecodeError}（调用方断开连接）。
 */
export class EnemyDuelFrameReader {
  /** 尚未凑齐一帧的残留字节 */
  private _buffer: Buffer = Buffer.alloc(0);

  /**
   * 追加一段收到的字节并切出完整帧
   * @param chunk 本次收到的字节
   * @returns 已完整的帧（可能为空数组）
   * @throws EnvelopeDecodeError 帧头声明长度非法
   */
  push(chunk: Buffer): EnemyDuelEnvelope[] {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    const frames: EnemyDuelEnvelope[] = [];
    while (this._buffer.length >= ENVELOPE_HEADER_SIZE) {
      const length = this._buffer.readUInt32BE(0);
      if (length > MAX_PAYLOAD_SIZE) {
        throw new EnvelopeDecodeError(`帧声明长度超上限（${length} > ${MAX_PAYLOAD_SIZE}）`);
      }
      if (this._buffer.length < ENVELOPE_HEADER_SIZE + length) break;
      const type = this._buffer.readUInt32BE(4);
      const payload = this._buffer.subarray(ENVELOPE_HEADER_SIZE, ENVELOPE_HEADER_SIZE + length);
      this._buffer = this._buffer.subarray(ENVELOPE_HEADER_SIZE + length);
      frames.push({ type, payload });
    }
    return frames;
  }
}

/** 读侧解包越界错误（payload 比结构短） */
export class PayloadReadError extends Error {
  /**
   * @param message 错误说明
   */
  constructor(message: string) {
    super(message);
    this.name = "PayloadReadError";
  }
}

/** 按结构顺序写 payload 的写入器 */
export class PayloadWriter {
  /** 已写入的分片 */
  private readonly _chunks: Buffer[] = [];

  /**
   * 写 uint8
   * @param value 0..255
   */
  writeUInt8(value: number): void {
    const b = Buffer.alloc(1);
    b.writeUInt8(value & 0xff, 0);
    this._chunks.push(b);
  }

  /**
   * 写 uint16（大端）
   * @param value 无符号 16 位值
   */
  writeUInt16(value: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value & 0xffff, 0);
    this._chunks.push(b);
  }

  /**
   * 写 uint32（大端）
   * @param value 无符号 32 位值
   */
  writeUInt32(value: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0, 0);
    this._chunks.push(b);
  }

  /**
   * 写 int32（大端）
   * @param value 有符号 32 位值
   */
  writeInt32(value: number): void {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value | 0, 0);
    this._chunks.push(b);
  }

  /**
   * 写 uint64（大端；入参为 JS number，超出 2^53 会失真——协议里的时间戳不会到该量级）
   * @param value 无符号 64 位值
   */
  writeUInt64(value: number): void {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(Math.trunc(value)), 0);
    this._chunks.push(b);
  }

  /**
   * 写 uint16 长度前缀字符串
   * @param value UTF-8 字符串
   * @throws EnvelopeDecodeError 超过 65535 字节（协议上限）
   */
  writeString(value: string): void {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > 0xffff) {
      throw new EnvelopeDecodeError(`字符串超过 65535 字节（${bytes.length}）`);
    }
    const len = Buffer.alloc(2);
    len.writeUInt16BE(bytes.length, 0);
    this._chunks.push(len, bytes);
  }

  /**
   * 写 uint8 切片（uint16 元素数 + 元素）
   * @param values 0..255 数组
   */
  writeUInt8Slice(values: number[]): void {
    this._writeSliceLength(values.length);
    const b = Buffer.from(values.map((v) => v & 0xff));
    this._chunks.push(b);
  }

  /**
   * 写 uint32 切片（uint16 元素数 + 元素）
   * @param values 无符号 32 位数组
   */
  writeUInt32Slice(values: number[]): void {
    this._writeSliceLength(values.length);
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
    this._chunks.push(b);
  }

  /**
   * 写两个占位零字节（协议里若干结构固定带 2B 保留/对齐字段）
   */
  writeReservedZeros(): void {
    this._chunks.push(Buffer.from([0, 0]));
  }

  /**
   * 写出已写入的分片
   * @returns payload
   */
  toBuffer(): Buffer {
    return Buffer.concat(this._chunks);
  }

  /**
   * 写切片元素数（uint16）
   * @param count 元素数
   * @throws EnvelopeDecodeError 超过协议上限
   */
  private _writeSliceLength(count: number): void {
    if (count > 0xffff) {
      throw new EnvelopeDecodeError(`切片元素数超过 65535（${count}）`);
    }
    const b = Buffer.alloc(2);
    b.writeUInt16BE(count, 0);
    this._chunks.push(b);
  }
}

/** 按结构顺序读 payload 的读取器 */
export class PayloadReader {
  /** 底层字节 */
  private readonly _buf: Buffer;
  /** 当前读取位置 */
  private _pos = 0;

  /**
   * @param payload 消息体
   */
  constructor(payload: Buffer) {
    this._buf = payload;
  }

  /** 是否已读到末尾 */
  get eof(): boolean {
    return this._pos >= this._buf.length;
  }

  /** 剩余字节数 */
  get remaining(): number {
    return this._buf.length - this._pos;
  }

  /**
   * 读 uint8
   * @returns 0..255
   */
  readUInt8(): number {
    this._require(1);
    const v = this._buf.readUInt8(this._pos);
    this._pos += 1;
    return v;
  }

  /**
   * 读 uint32（大端）
   * @returns 无符号 32 位值
   */
  readUInt32(): number {
    this._require(4);
    const v = this._buf.readUInt32BE(this._pos);
    this._pos += 4;
    return v;
  }

  /**
   * 读 int32（大端）
   * @returns 有符号 32 位值
   */
  readInt32(): number {
    this._require(4);
    const v = this._buf.readInt32BE(this._pos);
    this._pos += 4;
    return v;
  }

  /**
   * 读 uint64（大端）
   * @returns 无符号 64 位值（JS number；协议时间戳在安全整数内）
   */
  readUInt64(): number {
    this._require(8);
    const v = Number(this._buf.readBigUInt64BE(this._pos));
    this._pos += 8;
    return v;
  }

  /**
   * 读 uint16 长度前缀字符串
   * @returns UTF-8 字符串
   * @throws PayloadReadError 超过协议上限或字节不足
   */
  readString(): string {
    const len = this._readLength();
    if (len > MAX_STR_SIZE) {
      throw new PayloadReadError(`字符串长度超上限（${len} > ${MAX_STR_SIZE}）`);
    }
    this._require(len);
    const s = this._buf.toString("utf8", this._pos, this._pos + len);
    this._pos += len;
    return s;
  }

  /**
   * 读 uint8 切片
   * @returns 0..255 数组
   * @throws PayloadReadError 元素数超上限或字节不足
   */
  readUInt8Slice(): number[] {
    const count = this._readSliceLength();
    this._require(count);
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) out.push(this._buf.readUInt8(this._pos + i));
    this._pos += count;
    return out;
  }

  /**
   * 读 uint32 切片
   * @returns 无符号 32 位数组
   * @throws PayloadReadError 元素数超上限或字节不足
   */
  readUInt32Slice(): number[] {
    const count = this._readSliceLength();
    this._require(count * 4);
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) out.push(this._buf.readUInt32BE(this._pos + i * 4));
    this._pos += count * 4;
    return out;
  }

  /**
   * 跳过固定保留字节（协议里 2B 占位）
   * @param n 字节数
   */
  skip(n: number): void {
    this._require(n);
    this._pos += n;
  }

  /**
   * 读切片元素数（uint16，带 {@link MAX_SLICE_SIZE} 上限校验）
   * @returns 元素数
   * @throws PayloadReadError 超过协议上限
   */
  readSliceCount(): number {
    return this._readSliceLength();
  }

  /**
   * 读 uint16 长度（字符串用）
   * @returns 长度
   */
  private _readLength(): number {
    this._require(2);
    const v = this._buf.readUInt16BE(this._pos);
    this._pos += 2;
    return v;
  }

  /**
   * 读切片元素数并校验上限
   * @returns 元素数
   * @throws PayloadReadError 超过协议上限
   */
  private _readSliceLength(): number {
    const count = this._readLength();
    if (count > MAX_SLICE_SIZE) {
      throw new PayloadReadError(`切片元素数超上限（${count} > ${MAX_SLICE_SIZE}）`);
    }
    return count;
  }

  /**
   * 断言剩余字节足够
   * @param n 需要的字节数
   * @throws PayloadReadError 字节不足
   */
  private _require(n: number): void {
    if (this._pos + n > this._buf.length) {
      throw new PayloadReadError(`payload 不足：需要 ${n} 字节，剩余 ${this._buf.length - this._pos}`);
    }
  }
}
