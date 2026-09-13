/*
 * 合成模块（Synthetic Module）。
 *
 * 背景：MuMu 的 Houdini 翻译层里，部分 ARM64 库不会进入 Frida 的模块注册表——
 * 实测 libil2cpp.so 明明在 /proc/self/maps 里，Process.enumerateModules() 却看不到它
 * （libunity/libmain/libtersafe2 能看到）。而 frida-il2cpp-bridge 必须先拿到这个模块对象
 * 才能解析 il2cpp_* 导出。
 *
 * 做法：直接读 /proc/self/maps，按「同一路径的连续段」分组，选出真正的装载组
 * （判据：含文件偏移 > 0 的段——纯线性只读视图没有），再用自解析的 ELF 动态符号表
 * 提供 findExportByName / enumerateExports 等能力，最后挂到 Process.findModuleByName /
 * getModuleByName 的失败分支上。
 */

/** maps 里的一段内存映射。 */
interface MapSegment {
  start: NativePointer;
  end: NativePointer;
  perms: string;
  offset: number;
  path: string;
}

/** 合成出来的模块替身（形状与 Frida 的 Module 对齐到 bridge 用到的部分）。 */
export interface SyntheticModule {
  name: string;
  path: string;
  base: NativePointer;
  size: number;
  findExportByName(name: string): NativePointer | null;
  getExportByName(name: string): NativePointer;
  enumerateExports(): { type: string; name: string; address: NativePointer }[];
  enumerateSymbols(): { type: string; name: string; address: NativePointer }[];
  enumerateRanges(protection?: string): { base: NativePointer; size: number; protection: string }[];
}

const ELF_MAGIC = 0x464c457f;
const ELF_SHT_DYNSYM = 11;
/** 同一区域内允许的最大段间空洞（超过就认为属于另一套映射）。 */
const REGION_GAP_LIMIT = 4 * 1024 * 1024;
const ELF64_SYMENT_SIZE = 24;
const ELF64_SHENT_SIZE = 64;

function readMaps(): MapSegment[] {
  const out: MapSegment[] = [];
  let text = "";
  try {
    text = File.readAllText("/proc/self/maps");
  } catch (e) {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) ([0-9a-f]+) \S+ \S+\s*(.*)$/.exec(line);
    if (m === null) continue;
    out.push({
      start: ptr("0x" + m[1]),
      end: ptr("0x" + m[2]),
      perms: m[3],
      offset: parseInt(m[4], 16),
      path: m[5],
    });
  }
  out.sort((a, b) => (a.start.compare(b.start) < 0 ? -1 : 1));
  return out;
}

/**
 * 指针转数字。
 * 两个坑：Frida 17 的 NativePointer **没有 toNumber()**；且 NativePointer.toString() 默认十六进制，
 * 而 readU64() 返回的 UInt64.toString() 默认**十进制**——混用会把段表偏移解析成天文数字。
 */
function ptrNum(p: NativePointer): number {
  return parseInt(p.toString(), 16);
}

/** UInt64（readU64 的返回值）转数字。 */
function u64Num(v: UInt64): number {
  return Number(v.toString());
}

/** 两个地址之差（字节数）。 */
function diff(a: NativePointer, b: NativePointer): number {
  return ptrNum(a) - ptrNum(b);
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 找出真正的装载基址。
 *
 * MuMu 下同一个文件可能有两套映射：一套是「整文件线性只读视图」（单段 r--p，offset 0），
 * 另一套才是真正的装载段（起始段 offset 0，其后还有 offset > 0 的段：.data/.bss 等）。
 * 判据：offset 0 的段 + 同路径更高地址处存在 offset > 0 的段 + 段首是合法 ELF 头。
 */
function pickLoadBase(segments: MapSegment[]): MapSegment | null {
  const sorted = segments.slice().sort((a, b) => (a.start.compare(b.start) < 0 ? -1 : 1));
  const fallback: MapSegment | null = null;
  for (const seg of sorted) {
    if (seg.offset !== 0) continue;
    if (seg.start.readU32() !== ELF_MAGIC) continue;
    // 关键：候选所在区域（4MB 空洞内）必须包含 offset > 0 的段（.data/.bss 等），
    // 否则那只是「整文件线性只读视图」，符号地址会算错。
    const region = collectRegion(sorted, seg);
    if (region.some((s) => s.offset > 0)) return seg;
  }
  // 退化：没有文件偏移段时，取地址最低且 ELF 头合法的段
  for (const seg of sorted) {
    if (seg.start.readU32() === ELF_MAGIC) return seg;
  }
  return fallback;
}

/** 从 base 往后收集同一区域的段（跨过 > 4MB 的空洞就停，避免把线性视图也算进来）。 */
function collectRegion(segments: MapSegment[], base: MapSegment): MapSegment[] {
  const sorted = segments.slice().sort((a, b) => (a.start.compare(b.start) < 0 ? -1 : 1));
  const region: MapSegment[] = [];
  let prevEnd: NativePointer | null = null;
  for (const seg of sorted) {
    if (seg.start.compare(base.start) < 0) continue;
    if (prevEnd !== null && diff(seg.start, prevEnd) > REGION_GAP_LIMIT) break;
    region.push(seg);
    prevEnd = seg.end;
  }
  return region;
}

interface ElfSymbol {
  name: string;
  value: number;
  shndx: number;
}

/**
 * 文件偏移 → 虚拟地址。
 * 装载镜像里段表/符号表的 sh_offset 是**文件偏移**，必须经 PT_LOAD 换算才能读到内存里的位置
 * （base + 文件偏移只在「整文件线性视图」下成立）。
 */
function fileOffsetToAddr(base: NativePointer, fileOffset: number): NativePointer {
  try {
    const phoff = u64Num(base.add(0x20).readU64());
    const phentsize = base.add(0x36).readU16();
    const phnum = base.add(0x38).readU16();
    for (let i = 0; i < phnum; i += 1) {
      const ph = base.add(phoff + i * phentsize);
      if (ph.readU32() !== 1 /* PT_LOAD */) continue;
      const pOffset = u64Num(ph.add(8).readU64());
      const pVaddr = u64Num(ph.add(0x10).readU64());
      const pFilesz = u64Num(ph.add(0x20).readU64());
      if (fileOffset >= pOffset && fileOffset < pOffset + pFilesz) {
        return base.add(pVaddr + (fileOffset - pOffset));
      }
    }
  } catch (e) {
    /* 落回线性视图假设 */
  }
  return base.add(fileOffset);
}

/** PT_DYNAMIC 的位置（装载镜像里读动态符号表只能靠它，节表不在内存里）。 */
function readDynamic(base: NativePointer): { addr: NativePointer; size: number } | null {
  try {
    const phoff = u64Num(base.add(0x20).readU64());
    const phentsize = base.add(0x36).readU16();
    const phnum = base.add(0x38).readU16();
    for (let i = 0; i < phnum; i += 1) {
      const ph = base.add(phoff + i * phentsize);
      if (ph.readU32() !== 2 /* PT_DYNAMIC */) continue;
      const pVaddr = u64Num(ph.add(0x10).readU64());
      const pFilesz = u64Num(ph.add(0x20).readU64());
      return { addr: base.add(pVaddr), size: pFilesz };
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

const DT_HASH = 4;
const DT_STRTAB = 5;
const DT_SYMTAB = 6;
const DT_SYMENT = 11;
const DT_GNU_HASH = 0x6ffffef5;

/** 解析 PT_DYNAMIC 的标签表。 */
function readDynamicTags(dyn: { addr: NativePointer; size: number }): Record<number, number> {
  const tags: Record<number, number> = {};
  for (let off = 0; off < dyn.size; off += 16) {
    const tag = u64Num(dyn.addr.add(off).readU64());
    if (tag === 0) break;
    tags[tag] = u64Num(dyn.addr.add(off + 8).readU64());
  }
  return tags;
}

/** DT_HASH 的 nchain 即符号数。 */
function hashSymbolCount(hashAddr: NativePointer): number | null {
  try {
    const nchain = hashAddr.add(4).readU32();
    return nchain === 0 ? null : nchain;
  } catch (e) {
    return null;
  }
}

/** 从 DT_GNU_HASH 推出符号数：buckets 最大值 + 沿 chain 走到链尾（低位为 1）。 */
function gnuHashSymbolCount(hashAddr: NativePointer): number | null {
  try {
    const nbuckets = hashAddr.readU32();
    const symoffset = hashAddr.add(4).readU32();
    const bloomSize = hashAddr.add(8).readU32();
    if (nbuckets === 0) return null;
    const bucketsOff = 16 + bloomSize * 8;
    const chainsOff = bucketsOff + nbuckets * 4;
    let maxSym = symoffset;
    for (let i = 0; i < nbuckets; i += 1) {
      const bucket = hashAddr.add(bucketsOff + i * 4).readU32();
      if (bucket > maxSym) maxSym = bucket;
    }
    let idx = maxSym;
    const guard = 1 << 22;
    for (let n = 0; n < guard; n += 1) {
      const chain = hashAddr.add(chainsOff + (idx - symoffset) * 4).readU32();
      idx += 1;
      if ((chain & 1) !== 0) break;
    }
    return idx;
  } catch (e) {
    return null;
  }
}

interface DynTables {
  symtab: NativePointer;
  strtab: NativePointer;
  count: number;
  entSize: number;
}

/** 走 PT_DYNAMIC 拿到 .dynsym/.dynstr 与符号数。 */
function dynTables(base: NativePointer): DynTables | null {
  const dyn = readDynamic(base);
  if (dyn === null) return null;
  const tags = readDynamicTags(dyn);
  const symtabVaddr = tags[DT_SYMTAB];
  const strtabVaddr = tags[DT_STRTAB];
  if (symtabVaddr === undefined || strtabVaddr === undefined) return null;
  let count: number | null = null;
  if (tags[DT_HASH] !== undefined) count = hashSymbolCount(base.add(tags[DT_HASH]));
  if (count === null && tags[DT_GNU_HASH] !== undefined) count = gnuHashSymbolCount(base.add(tags[DT_GNU_HASH]));
  if (count === null) return null;
  const entSize = tags[DT_SYMENT] === undefined || tags[DT_SYMENT] === 0 ? ELF64_SYMENT_SIZE : tags[DT_SYMENT];
  return { symtab: base.add(symtabVaddr), strtab: base.add(strtabVaddr), count, entSize };
}

/** 从给定表里收集已定义符号。 */
function collectSymbols(tables: DynTables): ElfSymbol[] {
  const out: ElfSymbol[] = [];
  for (let i = 0; i < tables.count; i += 1) {
    const sym = tables.symtab.add(i * tables.entSize);
    const nameOff = sym.readU32();
    if (nameOff === 0) continue;
    const shndx = sym.add(6).readU16();
    if (shndx === 0) continue; // SHN_UNDEF
    const value = u64Num(sym.add(8).readU64());
    if (value === 0) continue;
    const name = tables.strtab.add(nameOff).readCString();
    if (name === null || name.length === 0) continue;
    out.push({ name, value, shndx });
  }
  return out;
}

/**
 * 自解析 ELF64 的动态符号表。
 * 优先 PT_DYNAMIC（装载镜像唯一可行路径：节表不在内存映射里）；
 * 失败再退回节表（仅对「整文件线性视图」这类映射有效）。
 */
function parseDynsym(base: NativePointer): ElfSymbol[] {
  try {
    const tables = dynTables(base);
    if (tables !== null) {
      const symbols = collectSymbols(tables);
      if (symbols.length > 0) return symbols;
    }
  } catch (e) {
    /* 落到节表路径 */
  }

  const out: ElfSymbol[] = [];
  try {
    const eShoff = u64Num(base.add(0x28).readU64());
    const eShentsize = base.add(0x3a).readU16();
    const eShnum = base.add(0x3c).readU16();
    if (eShoff === 0 || eShnum === 0) return out;
    const shEnt = eShentsize === 0 ? ELF64_SHENT_SIZE : eShentsize;
    const shAddr = fileOffsetToAddr(base, eShoff);

    let dynsymAddr: NativePointer | null = null;
    let dynstrAddr: NativePointer | null = null;
    let dynsymSize = 0;
    let dynsymEnt = ELF64_SYMENT_SIZE;
    for (let i = 0; i < eShnum; i += 1) {
      const sh = shAddr.add(i * shEnt);
      if (sh.add(4).readU32() !== ELF_SHT_DYNSYM) continue;
      dynsymAddr = fileOffsetToAddr(base, u64Num(sh.add(0x18).readU64()));
      dynsymSize = u64Num(sh.add(0x20).readU64());
      const link = sh.add(0x28).readU32();
      const entSize = u64Num(sh.add(0x38).readU64());
      dynsymEnt = entSize === 0 ? ELF64_SYMENT_SIZE : entSize;
      const strSh = shAddr.add(link * shEnt);
      dynstrAddr = fileOffsetToAddr(base, u64Num(strSh.add(0x18).readU64()));
      break;
    }
    if (dynsymAddr === null || dynstrAddr === null) return out;
    const strtab = dynstrAddr;
    return collectSymbols({
      symtab: dynsymAddr,
      strtab,
      count: Math.floor(dynsymSize / dynsymEnt),
      entSize: dynsymEnt,
    });
  } catch (e) {
    return out;
  }
}

let cachedSymbols: { base: string; symbols: ElfSymbol[] } | null = null;

function symbolsFor(base: NativePointer): ElfSymbol[] {
  const key = base.toString();
  if (cachedSymbols !== null && cachedSymbols.base === key) return cachedSymbols.symbols;
  const symbols = parseDynsym(base);
  cachedSymbols = { base: key, symbols };
  return symbols;
}

function buildModule(name: string, path: string, region: MapSegment[]): SyntheticModule {
  const base = region[0].start;
  const last = region[region.length - 1];
  const size = diff(last.end, base);
  const allSegments = readMaps().filter((s) => s.path === path);
  const symbolCache = (): ElfSymbol[] => symbolsFor(base);

  const module: SyntheticModule = {
    name,
    path,
    base,
    size,
    findExportByName(exportName: string): NativePointer | null {
      const found = symbolCache().find((s) => s.name === exportName);
      return found === undefined ? null : base.add(found.value);
    },
    getExportByName(exportName: string): NativePointer {
      const found = module.findExportByName(exportName);
      if (found === null) throw new Error("unable to find export '" + exportName + "' in " + name);
      return found;
    },
    enumerateExports() {
      return symbolCache().map((s) => ({ type: "function", name: s.name, address: base.add(s.value) }));
    },
    enumerateSymbols() {
      return symbolCache().map((s) => ({ type: "function", name: s.name, address: base.add(s.value) }));
    },
    enumerateRanges(protection?: string) {
      return allSegments
        .filter((s) => (protection === undefined ? true : s.perms === protection))
        .map((s) => ({ base: s.start, size: diff(s.end, s.start), protection: s.perms }));
    },
  };
  return module;
}

/** 按模块名（basename）从 maps 合成模块；找不到返回 null。 */
export function findModuleInMaps(name: string): SyntheticModule | null {
  const segments = readMaps();
  const byPath = new Map<string, MapSegment[]>();
  for (const seg of segments) {
    if (seg.path.length === 0) continue;
    if (basename(seg.path) !== name) continue;
    const list = byPath.get(seg.path);
    if (list === undefined) byPath.set(seg.path, [seg]);
    else list.push(seg);
  }
  let result: SyntheticModule | null = null;
  for (const [path, segs] of byPath) {
    const base = pickLoadBase(segs);
    if (base === null) continue;
    const region = collectRegion(segs, base);
    if (region.length === 0) continue;
    const candidate = buildModule(name, path, region);
    if (result === null || candidate.size > result.size) result = candidate;
  }
  return result;
}

/**
 * 把合成模块挂进 Frida 的查找路径。
 *
 * 注意：Frida 的 `Process.findModuleByName` / `getModuleByName` 是**只读**属性，
 * 直接赋值会抛 TypeError（strict 模式下还会中断整个脚本），所以这里只能尽力而为：
 * 能改就改，改不了就静默跳过——真正的兜底是 `predefineIl2CppModule`。
 */
export function installSyntheticModules(): boolean {
  // 注意：Process.getModuleByName 是只读属性（赋值抛 TypeError），
  // 但 Process.findModuleByName 描述符是 writable —— 包住它就够：
  // bridge 的 forModule() 先走 findModuleByName，命中合成模块就不会落到 linker 分支。
  try {
    const realFind = Process.findModuleByName.bind(Process);
    Object.defineProperty(Process, "findModuleByName", {
      value: (name: string) => {
        const direct = realFind(name);
        if (direct !== null) return direct;
        return findModuleInMaps(name);
      },
      configurable: true,
      writable: true,
    });
    return true;
  } catch (e) {
    return false;
  }
}
