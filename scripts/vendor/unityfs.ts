/**
 * UnityFS bundle 解析 + SerializedFile → TextAsset 提取（Arknights excel bundle 专用）。
 * 已验证：Arknights excel bundle（112 个）均为 UnityFS v8，块信息 LZ4-block 压缩，
 * 数据块不压缩，文本资源为 SerializedFile v22 内的 TextAsset 对象。
 */
import { lz4BlockDecompress, decompressLz4ak } from "./lz4";

function cstr(buf: Uint8Array, off: number): { s: string; off: number } {
  let e = off;
  while (buf[e] !== 0) e++;
  return { s: new TextDecoder().decode(buf.subarray(off, e)), off: e + 1 };
}

function u32be(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}
function i64be(buf: Uint8Array, off: number): number {
  const hi = u32be(buf, off);
  const lo = u32be(buf, off + 4);
  return hi * 4294967296 + lo;
}
function i32le(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) | 0;
}
function u32le(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

export interface TextAssetData {
  name: string;
  script: Uint8Array;
}

/**
 * 解析 UnityFS bundle → 提取第一个 TextAsset（m_Name / m_Script）。
 * @param unityfs - 解包后的 UnityFS bundle 字节
 */
export function extractTextAsset(unityfs: Uint8Array): TextAssetData | null {
  // ---- UnityFS 头（大端）----
  let off = 0;
  const sig = cstr(unityfs, off);
  if (sig.s !== "UnityFS") throw new Error(`非 UnityFS bundle: ${sig.s}`);
  off = sig.off;
  const version = u32be(unityfs, off); off += 4;
  const vp = cstr(unityfs, off); off = vp.off;
  const ve = cstr(unityfs, off); off = ve.off;
  i64be(unityfs, off); off += 8; // size（忽略）
  const cSize = u32be(unityfs, off); off += 4;
  const uSize = u32be(unityfs, off); off += 4;
  const flags = u32be(unityfs, off); off += 4;

  // 版本 >= 7 对齐到 16
  if (version >= 7) {
    while (off % 16 !== 0) off++;
  }

  // ---- 块信息（在头部，组合模式）----
  let biBytes: Uint8Array;
  if (flags & 0x80) {
    // 块信息在末尾
    biBytes = unityfs.subarray(unityfs.length - cSize);
  } else {
    biBytes = unityfs.subarray(off, off + cSize);
  }
  const infoMode = flags & 0x3f;
  let bi: Uint8Array;
  if (infoMode === 0) {
    bi = biBytes;
  } else if (infoMode === 3 || infoMode === 2) {
    bi = lz4BlockDecompress(biBytes, uSize);
  } else {
    throw new Error(`块信息压缩模式不支持: ${infoMode}`);
  }

  // 解析块信息（大端）
  let o = 16; // 跳过 16 字节 hash
  const blockCount = u32be(bi, o); o += 4;
  const blocks: { u: number; c: number; mode: number }[] = [];
  for (let i = 0; i < blockCount; i++) {
    const u = u32be(bi, o); o += 4;
    const c = u32be(bi, o); o += 4;
    const fl = (bi[o] << 8) | bi[o + 1]; o += 2;
    blocks.push({ u, c, mode: fl & 0x3f });
  }
  const nodeCount = u32be(bi, o); o += 4;
  const nodes: { offset: number; size: number; path: string }[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = i64be(bi, o); o += 8;
    const size = i64be(bi, o); o += 8;
    o += 4; // flags
    const name = cstr(bi, o); o = name.off;
    nodes.push({ offset, size, path: name.s });
  }

  // ---- 数据块 ----
  let dataOff = off + cSize; // 块信息在 off 处占用 cSize 字节
  if (flags & 0x200) {
    while (dataOff % 16 !== 0) dataOff++; // 块信息前填充
  }
  let blocksStart = dataOff;
  const parts: Uint8Array[] = [];
  for (const blk of blocks) {
    const raw = unityfs.subarray(blocksStart, blocksStart + blk.c);
    blocksStart += blk.c;
    if (blk.mode === 0) {
      parts.push(raw);
    } else if (blk.mode === 2 || blk.mode === 3) {
      parts.push(lz4BlockDecompress(raw, blk.u));
    } else if (blk.mode === 4) {
      parts.push(decompressLz4ak(raw, blk.u));
    } else {
      throw new Error(`数据块压缩模式不支持: ${blk.mode}`);
    }
  }
  const cab = concatBytes(parts);
  if (nodes.length === 0) return null;

  // ---- SerializedFile（取第一个节点，即 CAB 序列化文件）----
  const node = nodes[0];
  const sf = cab.subarray(node.offset, node.offset + node.size);
  const assets = parseSerializedFiles(sf);
  return assets.length > 0 ? assets[0] : null;
}

/**
 * 解析 UnityFS bundle → 提取全部 TextAsset（m_Name / m_Script）。
 * 用于多 TextAsset 插件 bundle 的打包回读验证。
 * @param unityfs - 解包后的 UnityFS bundle 字节
 */
export function extractTextAssets(unityfs: Uint8Array): TextAssetData[] {
  return parseSerializedFiles(unityFsToSerializedFile(unityfs));
}

/**
 * 解包 UnityFS → 取 SerializedFile 字节（含 TextAsset 与 AssetBundle 元数据解析入口）。
 * @param unityfs - UnityFS bundle 字节
 * @returns SerializedFile 字节
 */
export function unityFsToSerializedFile(unityfs: Uint8Array): Uint8Array {
  // ---- UnityFS 头（大端）----
  let off = 0;
  const sig = cstr(unityfs, off);
  if (sig.s !== "UnityFS") throw new Error(`非 UnityFS bundle: ${sig.s}`);
  off = sig.off;
  const version = u32be(unityfs, off); off += 4;
  const vp = cstr(unityfs, off); off = vp.off;
  const ve = cstr(unityfs, off); off = ve.off;
  i64be(unityfs, off); off += 8; // size（忽略）
  const cSize = u32be(unityfs, off); off += 4;
  const uSize = u32be(unityfs, off); off += 4;
  const flags = u32be(unityfs, off); off += 4;

  if (version >= 7) {
    while (off % 16 !== 0) off++;
  }

  let biBytes: Uint8Array;
  if (flags & 0x80) {
    biBytes = unityfs.subarray(unityfs.length - cSize);
  } else {
    biBytes = unityfs.subarray(off, off + cSize);
  }
  const infoMode = flags & 0x3f;
  let bi: Uint8Array;
  if (infoMode === 0) {
    bi = biBytes;
  } else if (infoMode === 3 || infoMode === 2) {
    bi = lz4BlockDecompress(biBytes, uSize);
  } else {
    throw new Error(`块信息压缩模式不支持: ${infoMode}`);
  }

  let o = 16;
  const blockCount = u32be(bi, o); o += 4;
  const blocks: { u: number; c: number; mode: number }[] = [];
  for (let i = 0; i < blockCount; i++) {
    const u = u32be(bi, o); o += 4;
    const c = u32be(bi, o); o += 4;
    const fl = (bi[o] << 8) | bi[o + 1]; o += 2;
    blocks.push({ u, c, mode: fl & 0x3f });
  }
  const nodeCount = u32be(bi, o); o += 4;
  const nodes: { offset: number; size: number; path: string }[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = i64be(bi, o); o += 8;
    const size = i64be(bi, o); o += 8;
    o += 4; // flags
    const name = cstr(bi, o); o = name.off;
    nodes.push({ offset, size, path: name.s });
  }

  let dataOff = off + cSize;
  if (flags & 0x200) {
    while (dataOff % 16 !== 0) dataOff++;
  }
  let blocksStart = dataOff;
  const parts: Uint8Array[] = [];
  for (const blk of blocks) {
    const raw = unityfs.subarray(blocksStart, blocksStart + blk.c);
    blocksStart += blk.c;
    if (blk.mode === 0) {
      parts.push(raw);
    } else if (blk.mode === 2 || blk.mode === 3) {
      parts.push(lz4BlockDecompress(raw, blk.u));
    } else if (blk.mode === 4) {
      parts.push(decompressLz4ak(raw, blk.u));
    } else {
      throw new Error(`数据块压缩模式不支持: ${blk.mode}`);
    }
  }
  const cab = concatBytes(parts);
  if (nodes.length === 0) throw new Error("UnityFS 无节点（nodes 为空）");

  const node = nodes[0];
  const sf = cab.subarray(node.offset, node.offset + node.size);
  return sf;
}

/**
 * 解析 UnityFS bundle → TextAsset 列表 + AssetBundle(142) 容器（重打包需保留容器）。
 * @param unityfs - UnityFS bundle 字节
 * @returns TextAsset 列表与 AssetBundle 元数据
 */
export function extractBundleWithMeta(unityfs: Uint8Array): {
  assets: TextAssetData[];
  assetPathIds: bigint[];
  assetBundle: AssetBundleMeta | null;
  assetBundlePathId: bigint;
  typeTable: Uint8Array;
  enableTypeTree: boolean;
  typeCount: number;
} {
  return parseSerializedFileFull(unityFsToSerializedFile(unityfs));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * SerializedFile v22 → 提取全部 TextAsset 对象。
 * 对象数据布局（TextAsset 固定字段序）：m_Name(AlignedString) → m_Script(ByteArray) → m_PathName。
 */
function parseSerializedFiles(sf: Uint8Array): TextAssetData[] {
  return parseSerializedFileFull(sf).assets;
}

/** AssetBundle(142) 对象的容器信息 */
export interface AssetBundleMeta {
  /** m_Name（官方实测为 `init/gamedata/[uc]lua.ab`） */
  name: string;
  /** m_Container 条目：key = 客户端资源路径（`dyn/gamedata/[uc]lua/<小写相对路径>.lua.bytes`） */
  container: { key: string; pathId: bigint }[];
  /** m_Container 之后的原始字节（m_MainAsset / m_Dependencies 等字段，重打包时原样保留） */
  tail: Uint8Array;
}

/**
 * 解析 SerializedFile：TextAsset 列表 + AssetBundle 容器。
 *
 * 客户端按**容器路径**（`AssetBundle.LoadAsset(容器 key)`）解析 Lua 资产，重打包必须保留容器；
 * 容器 key 与 TextAsset 的 m_Name 不是同一字符串（key 含相对目录、全小写、带 `.bytes` 后缀），
 * 因此重打包需从**官方 bundle** 读取 key 并按 basename 与对象一一对应。
 *
 * @param sf - SerializedFile 字节
 * @returns TextAsset 列表与（可选的）AssetBundle 容器
 */
export function parseSerializedFileFull(sf: Uint8Array): {
  assets: TextAssetData[];
  /** 各 TextAsset 的 pathId（与 assets 同序；客户端清单按 pathId 寻址，重打包须保留） */
  assetPathIds: bigint[];
  assetBundle: AssetBundleMeta | null;
  /** AssetBundle(142) 对象的 pathId（官方实测为 1） */
  assetBundlePathId: bigint;
  /** 类型表原始字节（含类型树） */
  typeTable: Uint8Array;
  /** 原文件是否带类型树（enableTypeTree） */
  enableTypeTree: boolean;
  /** 类型表条目数 */
  typeCount: number;
} {
  // 头（大端）：初始 4 u32（v22 后按 64 位重读）+ endian u8 + reserved 3
  let o = 0;
  const version = u32be(sf, 8); // 初始头的 version 字段
  o += 16;
  o += 4; // endian u8 + reserved 3
  let dataOffset = 0;
  if (version >= 22) {
    o += 4; // metadataSize u32（重读）
    o += 8; // fileSize i64
    dataOffset = Number(i64be(sf, o)); o += 8; // dataOffset i64
    o += 8; // unknown i64
  }
  // 元数据：unityVersion cstr, targetPlatform i32, enableTypeTree bool
  const uv = cstr(sf, o); o = uv.off;
  o += 4; // targetPlatform
  const enableTypeTree = sf[o] !== 0; o += 1;
  const typeCount = i32le(sf, o); o += 4;
  const typeEntriesStart = o;
  // 收集类型 classId（对象表的 typeId 是类型数组下标）
  const classIds: number[] = [];
  // 跳过类型定义（v22：classId + 可选字段 + 类型树 blob + 依赖）
  for (let i = 0; i < typeCount; i++) {
    const classId = i32le(sf, o); o += 4;
    classIds.push(classId);
    if (version >= 16) o += 1; // isStrippedType
    if (version >= 17) o += 2; // scriptTypeIndex i16
    if (version >= 13) {
      // scriptId(16B) 仅 MonoBehaviour(classId==114) 或负 classId
      if (version >= 16 ? classId === 114 : classId < 0) o += 16;
      o += 16; // oldTypeHash
    }
    if (enableTypeTree && version >= 12) {
      // 类型树 blob：nodeCount i32 + stringbufferSize i32 + 32*count + stringbuffer
      const nodeCount = i32le(sf, o); o += 4;
      const sbSize = i32le(sf, o); o += 4;
      o += 32 * nodeCount + sbSize;
    }
    if (version >= 21) {
      const depCount = i32le(sf, o); o += 4;
      o += 4 * depCount;
    }
  }
  if (version >= 7 && version < 14) o += 4; // bigIdEnabled
  /** 类型表原始字节（含类型树；重打包原样保留——缺失类型树会让 Unity 用内置类型读 AssetBundle(142) 失败） */
  const typeTable = sf.slice(typeEntriesStart, o);

  // 对象信息表（v22）：align 4 → pathId i64 → byteStart i64 → byteSize u32 → typeId i32
  const objectCount = i32le(sf, o); o += 4;
  while (o % 4 !== 0) o++; // align_stream(4)
  // pathId 必须保持 bigint：官方 pathId 为 64 位散列（> 2^53），转 Number 会丢精度 →
  // 重建后的 pathId 与客户端清单不一致 → 资产全部查找失败（实测症状：Failed to load asset）
  const objs: { pathId: bigint; start: number; size: number; typeId: number }[] = [];
  for (let i = 0; i < objectCount; i++) {
    const pathId = version >= 14 ? readI64(sf, o) : BigInt(i32le(sf, o));
    o += version >= 14 ? 8 : 4;
    let start: number;
    if (version >= 22) {
      start = Number(readI64(sf, o)) + dataOffset; o += 8;
    } else {
      start = i32le(sf, o) + dataOffset; o += 4;
    }
    const size = i32le(sf, o); o += 4;
    const typeId = i32le(sf, o); o += 4;
    objs.push({ pathId, start, size, typeId });
  }

  // TextAsset ClassID = 49；对象 typeId 是类型数组下标
  const taTypeIdx = classIds.indexOf(49);
  const textAssets = taTypeIdx < 0 ? [] : objs.filter((x) => x.typeId === taTypeIdx);
  const assetPathIds = textAssets.map((x) => x.pathId);
  const assets = textAssets
    .map((ta) => parseTextAsset(sf.subarray(ta.start, ta.start + ta.size)))
    .filter((x): x is TextAssetData => x !== null);

  // AssetBundle ClassID = 142
  const abTypeIdx = classIds.indexOf(142);
  let assetBundle: AssetBundleMeta | null = null;
  const abObj = abTypeIdx < 0 ? undefined : objs.find((x) => x.typeId === abTypeIdx);
  if (abObj) {
    const obj = sf.subarray(abObj.start, abObj.start + abObj.size);
    let p = 0;
    const abNameLen = i32le(obj, p); p += 4;
    const abName = new TextDecoder().decode(obj.subarray(p, p + abNameLen)); p += abNameLen;
    while (p % 4 !== 0) p++;
    const preCount = i32le(obj, p); p += 4;
    p += preCount * 12; // m_PreloadTable：fileID i32 + pathID i64
    const contCount = i32le(obj, p); p += 4;
    const container: { key: string; pathId: bigint }[] = [];
    for (let i = 0; i < contCount; i++) {
      const keyLen = i32le(obj, p); p += 4;
      const key = new TextDecoder().decode(obj.subarray(p, p + keyLen)); p += keyLen;
      while (p % 4 !== 0) p++;
      p += 4; // preloadIndex
      p += 4; // preloadSize
      p += 4; // asset.m_FileID
      const pathId = readI64(obj, p); p += 8;
      container.push({ key, pathId });
    }
    assetBundle = { name: abName, container, tail: obj.subarray(p).slice() };
  }

  return {
    assets,
    assetPathIds,
    assetBundle,
    assetBundlePathId: abObj ? abObj.pathId : 0n,
    typeTable,
    enableTypeTree,
    typeCount,
  };
}

function readI64(buf: Uint8Array, off: number): bigint {
  const lo = BigInt(u32le(buf, off));
  const hi = BigInt(u32le(buf, off + 4));
  return (hi << 32n) | lo;
}

function parseTextAsset(obj: Uint8Array): TextAssetData | null {
  let o = 0;
  const nameLen = i32le(obj, o); o += 4;
  const name = new TextDecoder().decode(obj.subarray(o, o + nameLen));
  o += nameLen;
  while (o % 4 !== 0) o++;
  const scriptLen = i32le(obj, o); o += 4;
  const script = obj.subarray(o, o + scriptLen).slice();
  return { name, script };
}
