/**
 * Lua bundle 重打包器：将明文 Lua 脚本打包为 UnityFS bundle（Arknights 客户端可加载）。
 *
 * 结构依据 scripts/analyze-bundle.ts 分析的官方 bundle 布局：
 *   zip(.dat) → UnityFS(.bin) → SerializedFile(v22) → TextAsset 对象
 *
 * 打包策略（与官方差异点，已在注释标注）：
 *   - SerializedFile enableTypeTree=false：TextAsset(49)/AssetBundle(142) 是 Unity 引擎内置类型，
 *     客户端用内置类型树即可解析，无需附带超长类型树 blob（官方为 true，此处为降低体积与风险）。
 *   - 数据块 mode=0（不压缩）：避免实现 LZ4AK(4) 压缩器；Unity 引擎原生支持不压缩块。
 *   - 块信息 infoMode=0（不压缩）：同上。
 *
 * 用法：
 *   npx tsx scripts/pack-lua-bundle.ts --name <asset名> --input <lua文件> [--output <bundle.bin>]
 *   --name    必填，TextAsset 的 m_Name（客户端资源名，如 gamedata/[uc]lua/feature/xxx.lua）
 *   --input   明文 Lua 文件路径
 *   --output  输出的 UnityFS bundle 字节（缺省打印到 stdout 前不写盘）
 */
import * as fs from "fs";
import * as path from "path";

/** 引擎版本常量（对齐官方 bundle，客户端据此识别） */
const UNITY_VERSION = "2021.3.39f1";

/** 客户端 Lua 资产名前缀（对齐 resource_manifest_idx 约定：gamedata/[uc]lua/...） */
const LUA_ASSET_PREFIX = "gamedata/[uc]lua/";

/** zip 条目固定时间戳：内容不变时产物字节一致（md5 稳定，避免客户端重复全量下载） */
const LUA_ZIP_DATE = new Date("2024-01-01T00:00:00.000Z");

/** 字节写入器（小端为主，UnityFS 头例外用大端字段） */class ByteWriter {
  /** 底层缓冲（buildSerializedFile 需直接按偏移写入，保持公开） */
  buf: Buffer;

  constructor(size: number) {
    this.buf = Buffer.alloc(size);
  }

  /** 返回底层 Buffer */
  buffer(): Buffer {
    return this.buf;
  }

  /** 追加任意字节 */
  bytes(off: number, data: Uint8Array): number {
    Buffer.from(data).copy(this.buf, off);
    return off + data.length;
  }

  /** 写 u32 小端 */
  u32le(off: number, v: number): number {
    this.buf.writeUInt32LE(v >>> 0, off);
    return off + 4;
  }

  /** 写 i32 小端 */
  i32le(off: number, v: number): number {
    this.buf.writeInt32LE(v | 0, off);
    return off + 4;
  }

  /** 写 u16 小端 */
  u16le(off: number, v: number): number {
    this.buf.writeUInt16LE(v & 0xffff, off);
    return off + 2;
  }

  /** 写 i64 小端（Js number，受 2^53 限制内安全） */
  i64le(off: number, v: number): number {
    this.buf.writeBigUInt64LE(BigInt(v), off);
    return off + 8;
  }

  /**
   * 写 i64 小端（bigint，pathId 可能超出 Number 精度）。
   * @param off - 写入偏移
   * @param v   - 64 位无符号值
   * @returns 新偏移
   */
  i64leBig(off: number, v: bigint): number {
    this.buf.writeBigUInt64LE(v, off);
    return off + 8;
  }

  /** 写 u32 大端 */
  u32be(off: number, v: number): number {
    this.buf.writeUInt32BE(v >>> 0, off);
    return off + 4;
  }

  /** 写 u64 大端 */
  u64be(off: number, v: number): number {
    this.buf.writeBigUInt64BE(BigInt(v), off);
    return off + 8;
  }

  /** 写 C 字符串（结尾 0） */
  cstr(off: number, s: string): number {
    const n = Buffer.byteLength(s, "utf8");
    this.buf.write(s, off, "utf8");
    this.buf[off + n] = 0;
    return off + n + 1;
  }
}

/** 输入：一条 Lua 资产（TextAsset） */
export interface LuaAsset {
  /** TextAsset 的 m_Name（客户端资源名） */
  name: string;
  /** 明文 Lua 脚本字节 */
  script: Uint8Array;
}

/** AssetBundle 容器条目：客户端资源路径 → assets 数组下标 */
export interface ContainerSpec {
  /** 容器 key（客户端 `AssetBundle.LoadAsset` 用的路径，如 `dyn/gamedata/[uc]lua/base/foo.lua.bytes`） */
  key: string;
  /** 对应 `assets` 数组下标 */
  assetIndex: number;
}

/** 打包附加项（保留官方 AssetBundle 容器） */
export interface PackOptions {
  /** 容器条目；缺省不写 AssetBundle(142) 对象（旧行为，客户端无法按名解析） */
  container?: ContainerSpec[];
  /** AssetBundle.m_Name（缺省官方实测值 `init/gamedata/[uc]lua.ab`） */
  assetBundleName?: string;
  /** AssetBundle 对象 m_Container 之后的原始字节（从官方 bundle 复制，保留 m_Dependencies 等字段） */
  tail?: Uint8Array;
  /** 各资产的 pathId（与 assets 同序；0n 表示自动分配）。客户端清单按 pathId 寻址，重打包须保留官方值 */
  pathIds?: bigint[];
  /** AssetBundle 对象的 pathId（官方实测 1） */
  assetBundlePathId?: bigint;
  /** 官方类型表原始字节（含类型树）；提供时 enableTypeTree=true 并原样写入 */
  typeTable?: Uint8Array;
  /** CAB 节点名（缺省官方值 {@link DEFAULT_LUA_CAB_NAME}；重打包应传源 bundle 的名字） */
  cabName?: string;
}

/**
 * 计算 AssetBundle(142) 对象的数据长度（与 buildSerializedFile 的写入逻辑同构）。
 * @param abNameBytes - m_Name 字节数
 * @param keys        - m_Container 的 key 列表
 * @param assetCount  - TextAsset 数量（m_PreloadTable 每条 12 字节）
 * @param tailLen     - m_Container 之后的尾部字节数
 * @returns 对象数据字节数
 */
function measureAssetBundleObject(abNameBytes: number, keys: string[], assetCount: number, tailLen: number): number {
  let o = 4 + abNameBytes;
  while (o % 4 !== 0) o++;
  o += 4 + assetCount * 12; // m_PreloadTable
  o += 4; // m_Container count
  for (const key of keys) {
    o += 4 + Buffer.byteLength(key, "utf8");
    while (o % 4 !== 0) o++;
    o += 4 + 4 + 4 + 8; // preloadIndex + preloadSize + PPtr.fileID + PPtr.pathID
  }
  return o + tailLen;
}

/**
 * 构造 SerializedFile v22（N 条 TextAsset 对象，enableTypeTree=false）。
 *
 * 布局（小端，对齐官方 unityfs.ts 的解包顺序）：
 *   头 16B（version=22 在偏移 8）→ endian+reserved 4B → v22 扩展头(metadataSize/fileSize/dataOffset/unknown)
 *   → unityVersion cstr → targetPlatform i32 → enableTypeTree u8 → typeCount i32
 *   → 类型表(TextAsset/49 [+ AssetBundle/142]) → objectCount → object 表 → 数据区
 *
 * 客户端按**容器路径**取 Lua 资产：不带 `opts.container` 时产出的 bundle 无法按名加载
 * （实测 `Failed to load asset: gamedata/[uc]lua/entry.lua`），因此重打包一律应传容器。
 *
 * @param assets - 多条 Lua 资产（≥1），object 表按序排列，数据区依次写各 m_Name+m_Script
 * @param opts   - 打包附加项（容器 / bundle 名 / 尾部字节）
 * @returns SerializedFile 字节
 */
export function buildSerializedFile(assets: LuaAsset[], opts?: PackOptions): Uint8Array {
  if (assets.length === 0) {
    throw new Error("至少需要 1 条 Lua 资产");
  }
  const container = opts?.container ?? [];
  const hasAssetBundle = container.length > 0;
  // pathId：优先用传入值（保留官方），0/缺省者顺序分配（避开已用值）
  const provided = opts?.pathIds ?? [];
  const used = new Set<string>(provided.filter((v) => v > 0n).map((v) => v.toString()));
  // AssetBundle 对象的 pathId 先占位，避免新资产与它撞号
  const requestedAbPathId = opts?.assetBundlePathId && opts.assetBundlePathId > 0n ? opts.assetBundlePathId : 0n;
  if (requestedAbPathId > 0n) used.add(requestedAbPathId.toString());
  let nextFree = 1n;
  const pathIds = assets.map((_, i) => {
    const v = provided[i];
    if (v !== undefined && v > 0n) return v;
    while (used.has(nextFree.toString())) nextFree += 1n;
    const assigned = nextFree;
    used.add(assigned.toString());
    nextFree += 1n;
    return assigned;
  });
  const abPathId = requestedAbPathId > 0n
    ? requestedAbPathId
    : (() => {
        let v = 1n;
        while (used.has(v.toString())) v += 1n;
        return v;
      })();
  // 计算每个 TextAsset 对象数据长度（m_Name AlignedString + m_Script ByteArray）
  const infos = assets.map((asset) => {
    const nameBytes = Buffer.byteLength(asset.name, "utf8");
    const namePadded = (4 + nameBytes + 3) & ~3; // AlignedString 对齐 4
    const scriptLen = asset.script.length;
    return { asset, nameBytes, namePadded, scriptLen, objSize: namePadded + 4 + scriptLen };
  });

  // AssetBundle(142) 对象数据：m_Name + m_PreloadTable + m_Container + tail
  const abName = opts?.assetBundleName ?? "init/gamedata/[uc]lua.ab";
  const abNameBytes = Buffer.byteLength(abName, "utf8");
  const abTail = hasAssetBundle ? (opts?.tail ?? new Uint8Array(0)) : new Uint8Array(0);
  const abObjSize = hasAssetBundle
    ? measureAssetBundleObject(abNameBytes, container.map((c) => c.key), assets.length, abTail.length)
    : 0;

  const totalObjData = infos.reduce((a, o) => a + o.objSize, 0) + abObjSize;

  // 各对象在数据区内的 byteStart（相对 dataOffset）：**对象起点对齐 8 字节**
  // （官方 bundle 实测：345 个对象起点全部 8 字节对齐，对象之间以零填充补齐；
  //  不对齐会让 Unity 在读资产时越界/崩溃——实测 libunity.so SIGSEGV）
  const starts: number[] = [];
  let cursor = 0;
  for (const o of infos) {
    starts.push(cursor);
    cursor = (cursor + o.objSize + 7) & ~7;
  }
  const abStart = cursor;
  const alignedObjData = abStart + ((abObjSize + 7) & ~7);

  const unityVerStr = "2021.3.39f1"; // 与官方 SerializedFile 内部 unityVersion 一致（官方实测值）

  // ---- 构建 metadata 内容（从 offset 48 起，v22 扩展头结束于 48）----
  const typeEntry = (() => {
    // classId i32 + isStripped u8 + scriptTypeIndex i16 + oldTypeHash 16B + depCount i32
    return 4 + 1 + 2 + 16 + 4;
  })();
  const objEntry = 8 + 8 + 4 + 4; // pathId i64 + byteStart i64 + size u32 + typeId i32
  const typeCount = hasAssetBundle ? 2 : 1;
  const objectCount = assets.length + (hasAssetBundle ? 1 : 0);
  const rawTypeTable = opts?.typeTable;
  const useTypeTable = rawTypeTable !== undefined && rawTypeTable.length > 0;
  const metaContentLen =
    Buffer.byteLength(unityVerStr, "utf8") + 1 + // unityVersion cstr
    4 + // targetPlatform
    1 + // enableTypeTree u8
    4 + // typeCount
    (useTypeTable ? rawTypeTable.length : typeEntry * typeCount) +
    4 + // objectCount
    objEntry * objectCount;
  // objectCount 后需 align_stream(4)（从 metadata 起点对齐到 4）
  const metaContentAligned = ((metaContentLen + 3) & ~3);

  // metadataSize = 真实 metadata 长度（4 字节对齐后），与官方同义（官方实测 10777B）
  const metadataSize = metaContentAligned;

  // dataOffset = align16(48 + metadataSize)：官方实测 `10832 = align16(48 + 10777)`（填充 7B）。
  // 曾用 4096 页对齐 → 客户端**拒绝**该 bundle（实测 C2：下载后回退为内置 bundle、无崩溃；
  // 同一容器换成官方 SF 则被正常接受），且同内容下 SF 比官方大 1.4KB。
  const DATA_OFFSET = (48 + metadataSize + 15) & ~15;

  const fileSize = DATA_OFFSET + alignedObjData;

  const w = new ByteWriter(fileSize);

  // ---- SerializedFile 头（大端，对齐 unityfs.ts 的 u32be/i64be 读取）----
  w.u32be(0, metadataSize); // metadataSize
  w.u32be(4, fileSize); // fileSize
  w.u32be(8, 22); // version = 22
  w.u32be(12, DATA_OFFSET); // dataOffset
  w.buf[16] = 0; // endian u8 = 0（小端）+ reserved（已归零）
  // v22 扩展头（第 2 份，64 位，大端）
  let o = 20;
  o = w.u32be(o, metadataSize); // metadataSize
  o = w.u64be(o, fileSize); // fileSize i64
  o = w.u64be(o, DATA_OFFSET); // dataOffset i64
  o = w.u64be(o, 0); // unknown i64（此时 o=48）

  // ---- metadata 内容 ----
  o = w.cstr(o, unityVerStr); // unityVersion（offset 48 起）
  o = w.i32le(o, 13); // targetPlatform=13 (Android)
  if (useTypeTable) {
    // 原样保留官方类型表（含类型树）：AssetBundle(142) 的容器字段序依赖类型树，
    // 缺类型树时 Unity 以内置类型解析会读错容器 → LoadAsset 全部失败
    w.buf[o] = 1; // enableTypeTree = true
    o += 1;
    o = w.i32le(o, typeCount);
    o = w.bytes(o, Buffer.from(rawTypeTable));
  } else {
    w.buf[o] = 0; // enableTypeTree u8 = false
    o += 1;
    o = w.i32le(o, typeCount);
    // 类型条目 0：classId=49（TextAsset）
    o = w.i32le(o, 49);
    w.buf[o] = 0; // isStrippedType u8
    o += 1;
    o = w.u16le(o, 0); // scriptTypeIndex i16
    o = w.bytes(o, Buffer.alloc(16)); // oldTypeHash 16B
    o = w.i32le(o, 0); // depCount i32（version>=21）
    if (hasAssetBundle) {
      // 类型条目 1：classId=142（AssetBundle，Unity 内置类型树）
      o = w.i32le(o, 142);
      w.buf[o] = 0;
      o += 1;
      o = w.u16le(o, 0);
      o = w.bytes(o, Buffer.alloc(16));
      o = w.i32le(o, 0);
    }
  }
  // objectCount
  o = w.i32le(o, objectCount);
  // align_stream(4)：使 object 表从 metadata 起点对齐到 4
  const metaStartAbs = 48;
  while ((o - metaStartAbs) % 4 !== 0) o++;
  // object 表：pathId / byteStart(相对数据区) / size / typeId
  for (let i = 0; i < assets.length; i++) {
    o = w.i64leBig(o, pathIds[i]); // pathId（保留官方值）
    o = w.i64le(o, starts[i]); // byteStart（相对数据区）
    o = w.u32le(o, infos[i].objSize);
    o = w.i32le(o, 0); // typeId=0（TextAsset）
  }
  if (hasAssetBundle) {
    o = w.i64leBig(o, abPathId); // AssetBundle 对象 pathId
    o = w.i64le(o, abStart);
    o = w.u32le(o, abObjSize);
    o = w.i32le(o, 1); // typeId=1（AssetBundle）
  }
  if (o - metaStartAbs !== metaContentAligned) {
    throw new Error(`metadata 长度不匹配: 实际 ${o - metaStartAbs}, 期望 ${metaContentAligned}`);
  }

  // ---- 对象数据区（dataOffset 起，16 字节对齐）----
  let dof = DATA_OFFSET;
  for (let i = 0; i < assets.length; i++) {
    const info = infos[i];
    const objStart = dof; // 对象数据起点（对齐基于对象起点，而非 DATA_OFFSET）
    dof = w.u32le(dof, info.nameBytes); // m_Name 长度
    dof = w.bytes(dof, Buffer.from(info.asset.name, "utf8"));
    while ((dof - objStart) % 4 !== 0) dof++; // m_Name 对齐 4（相对对象起点）
    dof = w.u32le(dof, info.scriptLen); // m_Script 长度
    dof = w.bytes(dof, info.asset.script);
    while ((dof - DATA_OFFSET - starts[i]) % 8 !== 0) dof++; // 对象起点 8 字节对齐（零填充）
  }

  if (hasAssetBundle) {
    const objStart = dof;
    dof = w.u32le(dof, abNameBytes); // m_Name 长度
    dof = w.bytes(dof, Buffer.from(abName, "utf8"));
    while ((dof - objStart) % 4 !== 0) dof++;
    dof = w.i32le(dof, assets.length); // m_PreloadTable count
    for (let i = 0; i < assets.length; i++) {
      dof = w.i32le(dof, 0); // PPtr.fileID
      dof = w.i64leBig(dof, pathIds[i]); // PPtr.pathID = 对应 TextAsset
    }
    dof = w.i32le(dof, container.length); // m_Container count
    for (const c of container) {
      const keyLen = Buffer.byteLength(c.key, "utf8");
      dof = w.u32le(dof, keyLen);
      dof = w.bytes(dof, Buffer.from(c.key, "utf8"));
      while ((dof - objStart) % 4 !== 0) dof++;
      dof = w.i32le(dof, c.assetIndex); // AssetInfo.preloadIndex
      dof = w.i32le(dof, 1); // AssetInfo.preloadSize
      dof = w.i32le(dof, 0); // AssetInfo.asset.m_FileID
      dof = w.i64leBig(dof, pathIds[c.assetIndex]); // AssetInfo.asset.m_PathID
    }
    if (abTail.length > 0) dof = w.bytes(dof, Buffer.from(abTail));
    if (dof - objStart !== abObjSize) {
      throw new Error(`AssetBundle 对象长度不匹配: 实际 ${dof - objStart}, 期望 ${abObjSize}`);
    }
  }

  return w.buffer();
}

/**
 * 将多条明文 Lua 资产打包为 UnityFS bundle（客户端可加载）。
 * @param assets - Lua 资产列表（m_Name 为客户端资源名，如 plugin/core/PluginManager.lua）
 * @param opts   - 打包附加项（容器 / bundle 名 / CAB 名 / 尾部字节）
 * @returns UnityFS bundle 字节
 */
export function packLuaBundle(assets: LuaAsset[], opts?: PackOptions): Uint8Array {
  const sf = buildSerializedFile(assets, opts);
  return buildUnityFS(sf, opts?.cabName);
}

/**
 * 官方内置 Lua bundle 的 CAB 节点名（**逻辑 bundle 标识**，不是内容哈希——两个不同版本的官方
 * Lua bundle 实测共用此名，见 docs/lua-load-chain-reconstructed-2026-09-14.md）。
 * 重打包时应沿用源 bundle 的 CAB 名；无法取得源时用此官方值，勿再自造名字。
 */
export const DEFAULT_LUA_CAB_NAME = "CAB-86d1ff11409b16a8308b9b0810871c29";

/**
 * 构造 UnityFS bundle（version 8，块信息不压缩，数据块不压缩 mode=0）。
 *
 * 布局（大端头）：
 *   "UnityFS\0" → version u32 → unityVersion cstr → engine cstr → size u64
 *   → 块信息 cSize/uSize/flags → (version>=7 对齐 16) → 块信息 → 数据块
 *
 * @param sf - SerializedFile（CAB 内容）
 * @param cabName - CAB 节点名（缺省官方值；重打包应传源 bundle 的名字）
 * @returns UnityFS bundle 字节
 */
export function buildUnityFS(sf: Uint8Array, cabName: string = DEFAULT_LUA_CAB_NAME): Uint8Array {
  const unityVer = "5.x.x";
  const engine = UNITY_VERSION;

  // 块信息体（1 个数据块 + 1 个节点）
  const blockCount = 1;
  const nodeCount = 1;
  const cabHash = cabName;
  // 块信息：16B hash + blockCount u32 + (u u32 + c u32 + fl u16) + nodeCount u32 + (offset i64 + size i64 + flags u32 + name cstr)
  const biBodySize = 16 + 4 + (4 + 4 + 2) + 4 + (8 + 8 + 4 + (cabHash.length + 1));
  const cSize = biBodySize; // infoMode=0 不压缩
  const uSize = biBodySize;

  const dataSize = sf.length; // 数据块不压缩
  const sfSize = sf.length;

  // 头部固定部分长度（不含版本>=7 对齐）
  let headerLen = 0;
  headerLen += Buffer.byteLength("UnityFS", "utf8") + 1;
  headerLen += 4; // version
  headerLen += Buffer.byteLength(unityVer, "utf8") + 1;
  headerLen += Buffer.byteLength(engine, "utf8") + 1;
  headerLen += 8; // size u64
  headerLen += 4; // cSize
  headerLen += 4; // uSize
  headerLen += 4; // flags
  // version>=7 对齐到 16
  while (headerLen % 16 !== 0) headerLen++;

  // 块信息结束后的数据对齐（flags 0x200）
  const dataAlign = (headerLen + cSize) % 16 === 0 ? 0 : 16 - ((headerLen + cSize) % 16);
  const totalSize = headerLen + cSize + dataAlign + dataSize;

  const w = new ByteWriter(totalSize);
  let o = 0;
  o = w.cstr(o, "UnityFS");
  o = w.u32be(o, 8); // version
  o = w.cstr(o, unityVer); // 5.x.x
  o = w.cstr(o, engine); // engine version
  o = w.u64be(o, totalSize); // size
  o = w.u32be(o, cSize); // 块信息压缩后大小
  o = w.u32be(o, uSize); // 块信息解压后大小
  o = w.u32be(o, 0x200); // flags：infoMode=0 | 0x200(块信息后数据对齐16)。不设 0x80（块信息 inline）
  while (o % 16 !== 0) o++; // version>=7 对齐 16

  // 块信息（大端）
  let bo = o;
  bo = w.bytes(bo, Buffer.alloc(16)); // hash 16B
  bo = w.u32be(bo, blockCount); // blockCount
  bo = w.u32be(bo, dataSize); // blk uncompressed
  bo = w.u32be(bo, dataSize); // blk compressed（mode=0 不压缩）
  bo = w.u16le(bo, 0); // 块 flags：mode=0（小端，2 字节）
  bo = w.u32be(bo, nodeCount); // nodeCount
  bo = w.u64be(bo, 0); // node offset
  bo = w.u64be(bo, sfSize); // node size
  bo = w.u32be(bo, 0); // node flags
  bo = w.cstr(bo, cabHash); // node path
  if (bo - o !== cSize) {
    throw new Error(`块信息长度不匹配: 实际 ${bo - o}, 期望 ${cSize}`);
  }

  // 数据块（mode=0 不压缩）——块信息后对齐 16
  let dataOff = bo;
  while (dataOff % 16 !== 0) dataOff++;
  if (dataOff + dataSize !== totalSize) {
    throw new Error(`数据偏移不匹配: ${dataOff + dataSize} vs ${totalSize}`);
  }
  w.bytes(dataOff, sf);
  return w.buffer();
}

/** 将 UnityFS bundle 包装为官方 CDN .dat（zip 单条目，条目名 = bundle 路径） */
export async function buildDat(unityfs: Uint8Array, bundlePath: string): Promise<Uint8Array> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(bundlePath, Buffer.from(unityfs), { createFolders: false, date: LUA_ZIP_DATE });
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return buf;
}

/** CLI 入口：支持单文件（--name/--input）、目录（--dir）或 mod 快捷输出（--mod） */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf("--name");
  const inIdx = args.indexOf("--input");
  const dirIdx = args.indexOf("--dir");
  const outIdx = args.indexOf("--output");
  const modFlag = args.includes("--mod");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : "";
  const input = inIdx >= 0 ? args[inIdx + 1] : "";
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : "";
  let output = outIdx >= 0 ? args[outIdx + 1] : "";

  let assets: LuaAsset[];
  if (dir) {
    assets = collectLuaAssets(dir);
  } else if (name && input) {
    assets = [{ name, script: fs.readFileSync(input) }];
  } else {
    console.error(
      "用法: npx tsx scripts/pack-lua-bundle.ts --dir <目录> [--output <bundle.bin>] [--mod]\n" +
        "  或: npx tsx scripts/pack-lua-bundle.ts --name <asset名> --input <lua文件> [--output <bundle.bin>]\n" +
        "  --mod    快捷输出到 mods/ 目录（bundle 路径自动使用内置 Lua bundle 名，并启用 mod）",
    );
    process.exit(1);
  }

  if (modFlag) {
    // mod 快捷输出：打包为 .dat → mods/anon_7d91430e114d86fef7d3b3511151e12d.dat
    const bundleName = "anon/7d91430e114d86fef7d3b3511151e12d.bin";
    const uf = packLuaBundle(assets);
    const dat = await buildDat(uf, bundleName);
    const modsDir = path.join(__dirname, "..", "mods");
    const downloadName = bundleName.replace(/\//g, "_").replace(/#/g, "__").split(".")[0] + ".dat";
    const datPath = path.join(modsDir, downloadName);
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(datPath, Buffer.from(dat));
    console.log(`mod 已生成: ${datPath} (${dat.length} B, ${assets.length} 条 Lua)`);

    // 启用 assets.enableMods
    const configPath = path.join(__dirname, "..", "data", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!config.assets?.enableMods) {
      config.assets = config.assets || {};
      config.assets.enableMods = true;
      config.assets.downloadLocally = true;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`已启用 assets.enableMods（data/config.json）`);
    }
    return;
  }

  const uf = packLuaBundle(assets);
  if (!output) {
    output = path.join(__dirname, "..", "mods", "lua_bundle.bin");
  }
  fs.writeFileSync(output, Buffer.from(uf));
  console.log(`已生成 UnityFS bundle: ${output} (${uf.length} B, ${assets.length} 条 Lua)`);
}

/**
 * 递归收集目录下所有 .lua 文件为 Lua 资产，m_Name = gamedata/[uc]lua/<相对 POSIX 路径>。
 * 前缀与客户端 loader 解析约定一致（repack-lua-bundle 的插件资产另有 Plugin/ 前缀，
 * 见 scripts/repack-lua-bundle.ts）。
 * @param dir - 源目录
 * @returns Lua 资产列表
 */
function collectLuaAssets(dir: string): LuaAsset[] {
  const out: LuaAsset[] = [];
  const walk = (cur: string): void => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".lua")) {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        out.push({ name: LUA_ASSET_PREFIX + rel, script: fs.readFileSync(full) });
      }
    }
  };
  walk(dir);
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

if (require.main === module) {
  main().catch((e) => {
    console.error("打包失败:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}