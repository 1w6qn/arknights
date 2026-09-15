/**
 * DEX 字节级工具：解析类/方法、把指定方法体**等长原地置空**、按 DEX 规范重算头部校验。
 *
 * 为什么要「等长原地改写」：本仓的 APK 改造一律走 zip 结构级增量重写（`scripts/apk-patch.ts`），
 * 不反编译、不重编译 dex（apktool 回编译会重排 dex 结构，ACE/TSS 一类的完整性校验极易发现并终止进程，
 * 见 `tmp/apk-mod/ace-kill-logcat.txt` 里 libtersafe2.so 的 SIGSEGV 记录）。把目标方法体的指令替换成
 * 「同字数的 `return-void` + `nop` 填充」后，code_item 的 `insns_size`、`try_item` 偏移、
 * `class_data_item` 布局全部不变，只有指令字节与头部（SHA-1 签名 / Adler-32 校验）变，
 * dex 结构零位移、文件长度不变。
 *
 * 格式参考：Android DEX 规范。字段序 = header(112B) → string_ids → type_ids → proto_ids
 * → field_ids → method_ids → class_defs → data(class_data_item / code_item / …)。
 */
import * as crypto from "crypto";

/** DEX 文件魔数（`dex\n` 共 4 字节） */
const DEX_MAGIC = "dex\n";
/** DEX 头部固定长度（字节） */
const DEX_HEADER_SIZE = 112;
/** `code_item` 头部长度（字节；其后紧跟 insns） */
const CODE_ITEM_HEADER = 16;
/** 指令：`return-void` */
const OP_RETURN_VOID = 0x000e;
/** 指令：`return v0` */
const OP_RETURN = 0x000f;
/** 指令：`return-wide v0` */
const OP_RETURN_WIDE = 0x0010;
/** 指令：`return-object v0` */
const OP_RETURN_OBJECT = 0x0011;
/** 指令：`const/4 v0, #0` */
const OP_CONST4_V0_0 = 0x0012;
/** 指令：`const-wide/16 v0, #0` */
const OP_CONST_WIDE16_V0_0 = 0x0013;
/** `nop` */
const OP_NOP = 0x0000;

/** DEX 头部关键字段 */
export interface DexHeader {
  /** 版本号（`dex\n035\0` → 35） */
  version: number;
  /** 头部声明的文件长度 */
  fileSize: number;
  /** string_ids 数量 */
  stringIdsSize: number;
  /** string_ids 偏移 */
  stringIdsOff: number;
  /** type_ids 数量 */
  typeIdsSize: number;
  /** type_ids 偏移 */
  typeIdsOff: number;
  /** proto_ids 数量 */
  protoIdsSize: number;
  /** proto_ids 偏移 */
  protoIdsOff: number;
  /** method_ids 数量 */
  methodIdsSize: number;
  /** method_ids 偏移 */
  methodIdsOff: number;
  /** class_defs 数量 */
  classDefsSize: number;
  /** class_defs 偏移 */
  classDefsOff: number;
  /** map_off */
  mapOff: number;
}

/** 单个方法的元信息 */
export interface DexMethod {
  /** method_ids 下标 */
  methodIndex: number;
  /** 方法名（如 `onProxyCreate`） */
  name: string;
  /** 类描述符（如 `Lcom/hg/sdk/MTPDetection;`） */
  classDescriptor: string;
  /** 返回类型描述符（`V` / `I` / `Ljava/lang/String;` …） */
  returnType: string;
  /** 入参类型描述符列表（按顺序；无参为空数组） */
  parameters: string[];
  /** 是否 direct 方法（构造器/静态/私有） */
  isDirect: boolean;
  /** 访问标志 */
  accessFlags: number;
  /** code_item 偏移（0 = abstract/native，无方法体） */
  codeOff: number;
  /** 寄存器总数 */
  registersSize: number;
  /** 入参寄存器数（含 `this`） */
  insSize: number;
  /** 指令字数（16 位 code unit） */
  insnsSize: number;
}

/** 单个类的元信息（含其全部方法） */
export interface DexClass {
  /** class_defs 下标 */
  classIndex: number;
  /** 类描述符（如 `Lcom/hg/sdk/MTPDetection;`） */
  descriptor: string;
  /** 访问标志 */
  accessFlags: number;
  /** class_data_item 偏移（0 = 无成员） */
  classDataOff: number;
  /** 直接方法 + 虚方法（按 dex 内顺序） */
  methods: DexMethod[];
}

/** 置空目标（类描述符 + 方法名；同名重载全部命中） */
export interface DexBlankTarget {
  /** 类描述符（`Lcom/hg/sdk/MTPDetection;`）或点号类名（`com.hg.sdk.MTPDetection`） */
  className: string;
  /** 方法名 */
  methodName: string;
}

/** 单次置空的结果 */
export interface DexBlankResult {
  /** 类描述符 */
  classDescriptor: string;
  /** 方法名 */
  methodName: string;
  /** 方法描述符（名 + 返回类型，够诊断用） */
  signature: string;
  /** 置空前的指令字数 */
  beforeInsnsSize: number;
  /** 改写后的首条指令 */
  firstInsn: number;
  /** 是否为非 void 返回而抬升了 registers_size */
  registersBumped: boolean;
}

/** 置空批量结果 */
export interface DexBlankReport {
  /** 成功置空的方法 */
  patched: DexBlankResult[];
  /** 命中类但没有可改方法体（abstract/native/指令区放不下）的方法 */
  skipped: DexBlankResult[];
  /** 未找到的目标（`类#方法`） */
  missing: string[];
}

/**
 * 计算 Adler-32（DEX 头部校验用；zlib 只提供 CRC32，故自带实现）。
 * @param buf - 输入数据
 * @returns Adler-32 值（无符号 32 位）
 */
export function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * 判断是否为 DEX 字节流。
 * @param buf - 待判定字节
 * @returns true = 以 `dex\n` 开头
 */
export function isDex(buf: Buffer): boolean {
  return buf.length >= DEX_HEADER_SIZE && buf.subarray(0, 4).toString("latin1") === DEX_MAGIC;
}

/**
 * 按 DEX 规范重算头部：signature = SHA-1(bytes[32..]) 写入 [12,32)，checksum = Adler-32(bytes[12..]) 写入 [8,12)。
 * @param dex - DEX 字节（就地修改）
 */
export function fixDexHeader(dex: Buffer): void {
  if (dex.length < 32 || dex.subarray(0, 4).toString("latin1") !== DEX_MAGIC) return;
  crypto.createHash("sha1").update(dex.subarray(32)).digest().copy(dex, 12);
  dex.writeUInt32LE(adler32(dex.subarray(12)), 8);
}

/**
 * 解析 DEX 头部（校验魔数、版本与各段边界）。
 * @param dex - DEX 字节
 * @returns 头部字段
 * @throws 魔数/版本/段偏移越界时抛错
 */
export function parseDexHeader(dex: Buffer): DexHeader {
  if (!isDex(dex)) throw new Error("不是 DEX：魔数不匹配");
  const version = Number.parseInt(dex.subarray(4, 7).toString("latin1"), 10);
  if (!Number.isFinite(version) || version < 35 || version > 41) {
    throw new Error(`不是 DEX：版本号异常（${version}）`);
  }
  const header: DexHeader = {
    version,
    fileSize: dex.readUInt32LE(32),
    stringIdsSize: dex.readUInt32LE(56),
    stringIdsOff: dex.readUInt32LE(60),
    typeIdsSize: dex.readUInt32LE(64),
    typeIdsOff: dex.readUInt32LE(68),
    protoIdsSize: dex.readUInt32LE(72),
    protoIdsOff: dex.readUInt32LE(76),
    methodIdsSize: dex.readUInt32LE(88),
    methodIdsOff: dex.readUInt32LE(92),
    classDefsSize: dex.readUInt32LE(96),
    classDefsOff: dex.readUInt32LE(100),
    mapOff: dex.readUInt32LE(52),
  };
  for (const [label, off, size] of [
    ["string_ids", header.stringIdsOff, header.stringIdsSize * 4],
    ["type_ids", header.typeIdsOff, header.typeIdsSize * 4],
    ["proto_ids", header.protoIdsOff, header.protoIdsSize * 12],
    ["method_ids", header.methodIdsOff, header.methodIdsSize * 8],
    ["class_defs", header.classDefsOff, header.classDefsSize * 32],
  ] as [string, number, number][]) {
    if (off < 0 || off + size > dex.length) {
      throw new Error(`DEX 头部异常：${label} 段越界（off=${off} size=${size} file=${dex.length}）`);
    }
  }
  return header;
}

/**
 * 读取 uleb128 编码的整数。
 * @param buf - 输入字节
 * @param off - 起始偏移
 * @returns 值 + 下一字节偏移
 */
export function readUleb128(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = off;
  for (;;) {
    const byte = buf[cursor];
    value |= (byte & 0x7f) << shift;
    cursor++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) break;
  }
  return { value: value >>> 0, next: cursor };
}

/**
 * 读取 string_data_item 指向的字符串（MUTF-8；类描述符/方法名均为 ASCII 子集）。
 * @param dex - DEX 字节
 * @param off - string_data_item 偏移
 * @returns 字符串
 */
function readStringData(dex: Buffer, off: number): string {
  const { next } = readUleb128(dex, off);
  let end = next;
  while (end < dex.length && dex[end] !== 0) end++;
  return dex.subarray(next, end).toString("utf8");
}

/** DEX 字符串/类型/方法访问器（按需解码，不做全量建表） */
class DexReader {
  private readonly _dex: Buffer;
  private readonly _header: DexHeader;
  private readonly _stringCache = new Map<number, string>();

  constructor(dex: Buffer) {
    this._dex = dex;
    this._header = parseDexHeader(dex);
  }

  /** 头部字段 */
  get header(): DexHeader {
    return this._header;
  }

  /**
   * 取 string_ids[idx] 的字符串。
   * @param idx - 字符串下标
   * @returns 字符串
   */
  string(idx: number): string {
    if (idx < 0 || idx >= this._header.stringIdsSize) throw new Error(`string_ids 越界：${idx}`);
    const cached = this._stringCache.get(idx);
    if (cached !== undefined) return cached;
    const dataOff = this._dex.readUInt32LE(this._header.stringIdsOff + idx * 4);
    const value = readStringData(this._dex, dataOff);
    this._stringCache.set(idx, value);
    return value;
  }

  /**
   * 取 type_ids[idx] 的类型描述符。
   * @param idx - 类型下标
   * @returns 描述符（`L…;` / `I` / `V` …）
   */
  type(idx: number): string {
    if (idx < 0 || idx >= this._header.typeIdsSize) throw new Error(`type_ids 越界：${idx}`);
    return this.string(this._dex.readUInt32LE(this._header.typeIdsOff + idx * 4));
  }

  /**
   * 取 method_ids[idx] 的元信息。
   * @param idx - 方法下标
   * @param classDescriptor - 调用方已解析的类描述符（避免重复解析）
   * @returns 方法元信息
   */
  method(idx: number, classDescriptor: string): DexMethod {
    if (idx < 0 || idx >= this._header.methodIdsSize) throw new Error(`method_ids 越界：${idx}`);
    const at = this._header.methodIdsOff + idx * 8;
    const protoIdx = this._dex.readUInt16LE(at + 2);
    const nameIdx = this._dex.readUInt32LE(at + 4);
    const returnType = this.protoReturnType(protoIdx);
    return {
      methodIndex: idx,
      name: this.string(nameIdx),
      classDescriptor,
      returnType,
      parameters: this.protoParameters(protoIdx),
      isDirect: false,
      accessFlags: 0,
      codeOff: 0,
      registersSize: 0,
      insSize: 0,
      insnsSize: 0,
    };
  }

  /**
   * 取 proto_ids[idx] 的入参类型描述符列表（`parameters_off` → type_list）。
   * @param idx - proto 下标
   * @returns 入参描述符数组
   */
  protoParameters(idx: number): string[] {
    if (idx < 0 || idx >= this._header.protoIdsSize) throw new Error(`proto_ids 越界：${idx}`);
    const listOff = this._dex.readUInt32LE(this._header.protoIdsOff + idx * 12 + 8);
    if (listOff === 0) return [];
    const size = this._dex.readUInt32LE(listOff);
    if (listOff + 4 + size * 2 > this._dex.length) throw new Error(`type_list 越界：off=${listOff} size=${size}`);
    const params: string[] = [];
    for (let i = 0; i < size; i++) params.push(this.type(this._dex.readUInt16LE(listOff + 4 + i * 2)));
    return params;
  }

  /**
   * 取 proto_ids[idx] 的返回类型描述符。
   * @param idx - proto 下标
   * @returns 返回类型描述符
   */
  protoReturnType(idx: number): string {
    if (idx < 0 || idx >= this._header.protoIdsSize) throw new Error(`proto_ids 越界：${idx}`);
    return this.type(this._dex.readUInt32LE(this._header.protoIdsOff + idx * 12 + 4));
  }
}

/**
 * 遍历 DEX 的全部类（含方法表）；无成员类返回空方法表。
 * @param dex - DEX 字节
 * @returns 类列表
 */
export function listClasses(dex: Buffer): DexClass[] {
  const reader = new DexReader(dex);
  const { classDefsSize, classDefsOff } = reader.header;
  const classes: DexClass[] = [];
  for (let i = 0; i < classDefsSize; i++) {
    const at = classDefsOff + i * 32;
    const classIdx = dex.readUInt32LE(at);
    const descriptor = reader.type(classIdx);
    const accessFlags = dex.readUInt32LE(at + 4);
    const classDataOff = dex.readUInt32LE(at + 24);
    classes.push({ classIndex: i, descriptor, accessFlags, classDataOff, methods: parseClassMethods(dex, reader, descriptor, classDataOff) });
  }
  return classes;
}

/**
 * 解析 class_data_item 的方法表（直接方法 + 虚方法）。
 * @param dex - DEX 字节
 * @param reader - 字符串/类型访问器
 * @param classDescriptor - 所属类描述符
 * @param classDataOff - class_data_item 偏移（0 = 无成员）
 * @returns 方法列表
 */
function parseClassMethods(dex: Buffer, reader: DexReader, classDescriptor: string, classDataOff: number): DexMethod[] {
  if (classDataOff === 0) return [];
  let cursor = classDataOff;
  const staticFields = readUleb128(dex, cursor);
  cursor = staticFields.next;
  const instanceFields = readUleb128(dex, cursor);
  cursor = instanceFields.next;
  const directMethods = readUleb128(dex, cursor);
  cursor = directMethods.next;
  const virtualMethods = readUleb128(dex, cursor);
  cursor = virtualMethods.next;
  for (let i = 0; i < staticFields.value + instanceFields.value; i++) {
    cursor = readUleb128(dex, cursor).next; // field_idx_diff
    cursor = readUleb128(dex, cursor).next; // access_flags
  }
  const methods: DexMethod[] = [];
  for (const [count, isDirect] of [
    [directMethods.value, true],
    [virtualMethods.value, false],
  ] as [number, boolean][]) {
    // 注意：method_idx_diff 是「同列表内前一个方法」的相对差，每个列表独立（首元素直接给绝对下标），
    // 因此这里必须在 direct / virtual 两个列表之间重置累加器。
    let methodIdx = 0;
    for (let i = 0; i < count; i++) {
      const diff = readUleb128(dex, cursor);
      cursor = diff.next;
      methodIdx += diff.value;
      const flags = readUleb128(dex, cursor);
      cursor = flags.next;
      const codeOff = readUleb128(dex, cursor);
      cursor = codeOff.next;
      const meta = reader.method(methodIdx, classDescriptor);
      meta.isDirect = isDirect;
      meta.accessFlags = flags.value;
      meta.codeOff = codeOff.value;
      if (meta.codeOff !== 0) {
        meta.registersSize = dex.readUInt16LE(meta.codeOff);
        meta.insSize = dex.readUInt16LE(meta.codeOff + 2);
        meta.insnsSize = dex.readUInt32LE(meta.codeOff + 12);
      }
      methods.push(meta);
    }
  }
  return methods;
}

/**
 * 类名规整：点号类名 / 描述符 → 描述符。
 * @param className - `com.hg.sdk.MTPDetection` 或 `Lcom/hg/sdk/MTPDetection;` 或 `com/hg/sdk/MTPDetection`
 * @returns 描述符
 */
export function toClassDescriptor(className: string): string {
  const trimmed = className.trim();
  if (trimmed.startsWith("L") && trimmed.endsWith(";")) return trimmed;
  return "L" + trimmed.replace(/\./g, "/") + ";";
}

/**
 * 类描述符 → 点号类名（日志用）。
 * @param descriptor - 如 `Lcom/hg/sdk/MTPDetection;`
 * @returns 如 `com.hg.sdk.MTPDetection`
 */
export function toClassName(descriptor: string): string {
  return descriptor.replace(/^L/, "").replace(/;$/, "").replace(/\//g, ".");
}

/**
 * 人类可读的方法签名（`名(入参)返回`）。
 * @param method - 方法元信息
 * @returns 形如 `onUserLogin(IILjava/lang/String;Ljava/lang/String;)V`
 */
export function methodSignature(method: DexMethod): string {
  return `${method.name}(${method.parameters.join("")})${method.returnType}`;
}

/**
 * 把单个方法体等长置空：`return-void`（void）或 `const/4 v0,#0; return v0`（其它返回类型），余下补 `nop`。
 * 非 void 且 registers_size 为 0 时把 registers_size 就地抬到 1（同长度，不影响入参寄存器）。
 * @param dex - DEX 字节（就地修改）
 * @param method - 目标方法（需带 codeOff）
 * @returns 结果；指令区放不下时返回 null
 */
export function blankMethodBody(dex: Buffer, method: DexMethod): DexBlankResult | null {
  const insnsOff = method.codeOff + CODE_ITEM_HEADER;
  const insnsSize = dex.readUInt32LE(method.codeOff + 12);
  const words: number[] = [];
  if (method.returnType === "V") {
    words.push(OP_RETURN_VOID);
  } else if (method.returnType === "J" || method.returnType === "D") {
    words.push(OP_CONST_WIDE16_V0_0, 0x0000, OP_RETURN_WIDE);
  } else if (method.returnType.startsWith("L") || method.returnType.startsWith("[")) {
    words.push(OP_CONST4_V0_0, OP_RETURN_OBJECT);
  } else {
    words.push(OP_CONST4_V0_0, OP_RETURN);
  }
  if (insnsSize < words.length) return null;
  let registersBumped = false;
  if (words.length > 1 && dex.readUInt16LE(method.codeOff) === 0) {
    // 非 void 返回需要 v0：registers_size 就地抬到 1（字段等长，入参寄存器位于末尾寄存器段，不受影响）
    dex.writeUInt16LE(1, method.codeOff);
    registersBumped = true;
  }
  for (let i = 0; i < insnsSize; i++) {
    dex.writeUInt16LE(i < words.length ? words[i] : OP_NOP, insnsOff + i * 2);
  }
  return {
    classDescriptor: method.classDescriptor,
    methodName: method.name,
    signature: methodSignature(method),
    beforeInsnsSize: insnsSize,
    firstInsn: words[0],
    registersBumped,
  };
}

/**
 * 批量把目标方法置空（同名重载全部命中）。
 * @param dex - DEX 字节（就地修改）
 * @param targets - 置空目标
 * @returns 明细报告
 */
export function blankMethods(dex: Buffer, targets: DexBlankTarget[]): DexBlankReport {
  const classes = listClasses(dex);
  const byDescriptor = new Map<string, DexClass>();
  for (const cls of classes) byDescriptor.set(cls.descriptor, cls);
  const report: DexBlankReport = { patched: [], skipped: [], missing: [] };
  for (const target of targets) {
    const descriptor = toClassDescriptor(target.className);
    const cls = byDescriptor.get(descriptor);
    let hits = 0;
    if (cls) {
      for (const method of cls.methods) {
        if (method.name !== target.methodName) continue;
        hits++;
        if (method.codeOff === 0) {
          report.skipped.push({
            classDescriptor: descriptor,
            methodName: method.name,
            signature: methodSignature(method),
            beforeInsnsSize: 0,
            firstInsn: 0,
            registersBumped: false,
          });
          continue;
        }
        const result = blankMethodBody(dex, method);
        if (result) report.patched.push(result);
        else
          report.skipped.push({
            classDescriptor: descriptor,
            methodName: method.name,
            signature: methodSignature(method),
            beforeInsnsSize: method.insnsSize,
            firstInsn: 0,
            registersBumped: false,
          });
      }
    }
    if (hits === 0) report.missing.push(`${descriptor}#${target.methodName}`);
  }
  return report;
}

/**
 * 校验 DEX 头部自洽（长度 / Adler-32 / SHA-1）。
 * @param dex - DEX 字节
 * @returns 问题列表（空 = 通过）
 */
export function verifyDex(dex: Buffer): string[] {
  const problems: string[] = [];
  if (!isDex(dex)) return ["魔数不是 dex\\n"];
  const header = parseDexHeader(dex);
  if (header.fileSize !== dex.length) problems.push(`file_size=${header.fileSize} 与实际长度 ${dex.length} 不符`);
  const checksum = dex.readUInt32LE(8);
  const expectChecksum = adler32(dex.subarray(12));
  if (checksum !== expectChecksum) problems.push(`checksum=0x${checksum.toString(16)} 应为 0x${expectChecksum.toString(16)}`);
  const stored = dex.subarray(12, 32);
  const expectSig = crypto.createHash("sha1").update(dex.subarray(32)).digest();
  if (!stored.equals(expectSig)) problems.push("signature 与 SHA-1(bytes[32..]) 不符");
  return problems;
}

/**
 * 读取方法体首条指令（自检用）。
 * @param dex - DEX 字节
 * @param codeOff - code_item 偏移
 * @returns 首条指令（codeOff=0 返回 -1）
 */
export function firstInsnAt(dex: Buffer, codeOff: number): number {
  if (codeOff === 0) return -1;
  return dex.readUInt16LE(codeOff + CODE_ITEM_HEADER);
}
