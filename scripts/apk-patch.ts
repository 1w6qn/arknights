/**
 * APK 改造器（zip 级增量重写）
 *
 * 背景：客户端内置 Lua bundle（`assets/AB/Android/anon/<hash>.bin`）是私服插件引导的唯一分发点。
 * `scripts/apk-lua.ts` 产出的注入版 bundle（`mods/anon_<hash>.dat`）平时经私服热更下发，
 * 但首次启动时客户端尚未连上私服、拿不到热更清单——把注入版 bundle **回灌进 APK 本体**即可打破鸡生蛋，
 * 让插件在客户端首次启动时就走内置 Lua 管线加载（NetworkRedirectPlugin 随即接管网络路由）。
 *
 * 本脚本不反编译 dex/资源，只做 zip 结构级改动：
 *   1. 逐条目原样复制（含压缩字节），只替换 `--lua-bundle` / `--replace` 指定的条目；
 *   2. 数据描述符（bit3）改写为本地头直写尺寸，去掉 Bit3；
 *   3. 对 STORED 条目重做 4 字节（`.so` 为 4096 字节）对齐，等价 zipalign；
 *   4. 抹掉旧签名（V1 的 META-INF/*.SF|RSA|MF 与 CD 前的 APK Signing Block），交给 --sign 重签。
 *
 * 用法：
 *   pnpm run apk:patch -- --list --in tmp/apk/2.7.71/arknights-hg-2771.apk
 *   pnpm run apk:patch -- --in <官方.apk> --lua-bundle mods/anon_<hash>.dat --out tmp/apk-out/arknights-hg-2771-mod.apk
 *   pnpm run apk:patch -- --in <官方.apk> --lua-bundle mods/anon_<hash>.dat --entry assets/AB/Android/anon/<hash>.bin --out <出包> --sign
 *   pnpm run apk:patch -- --in <官方.apk> --replace assets/U8Config.json=tmp/patch/U8Config.json --out <出包>
 */
import * as fs from "fs";
import * as path from "path";
import { crc32 } from "crc";
import { findLuaBundleInApk } from "./apk-lua";
import { signApk } from "./apk-sign";

/** zip 本地文件头签名 */
const LOCAL_SIG = 0x04034b50;
/** zip 中央目录记录签名 */
const CD_SIG = 0x02014b50;
/** zip 结尾记录（EOCD）签名 */
const EOCD_SIG = 0x06054b50;
/** 通用位标记：数据描述符（bit3） */
const FLAG_DATA_DESCRIPTOR = 0x0008;
/** 通用位标记：UTF-8 文件名（bit11） */
const FLAG_UTF8 = 0x0800;
/** 压缩方法：仅存储 */
const METHOD_STORE = 0;
/** 拷贝缓冲区大小（8MB，兼顾 drvfs 读放大与内存） */
const COPY_CHUNK = 8 * 1024 * 1024;
/** zipalign 私有 extra 字段 id（Android 对齐用，装载器忽略） */
const EXTRA_ID_ALIGN = 0xd935;
/** STORED 条目默认对齐字节（zipalign 默认 4；`.so` 用 4096） */
const ALIGN_DEFAULT = 4;
/** STORED `.so` 对齐字节（zipalign -p，保证可直接 mmap） */
const ALIGN_SO = 4096;
/** V1 签名相关条目（其余 META-INF 内容保留） */
const V1_SIG_RE = /^META-INF\/(MANIFEST\.MF|[^/]+\.(SF|RSA|DSA|EC))$/i;

/** EOCD 解析结果 */
interface EocdInfo {
  /** 中央目录条目数 */
  entryCount: number;
  /** 中央目录字节数 */
  cdSize: number;
  /** 中央目录在文件中的偏移 */
  cdOffset: number;
  /** zip 注释 */
  comment: Buffer;
}

/** 中央目录条目 */
interface ZipEntryRecord {
  /** 条目名（zip 内路径） */
  name: string;
  /** 条目名原始字节 */
  nameBytes: Buffer;
  /** 创建者版本 */
  versionMadeBy: number;
  /** 解压所需版本 */
  versionNeeded: number;
  /** 通用位标记 */
  flags: number;
  /** 压缩方法 */
  method: number;
  /** 修改时间（MS-DOS） */
  modTime: number;
  /** 修改日期（MS-DOS） */
  modDate: number;
  /** CRC32 */
  crc: number;
  /** 压缩后大小 */
  compressedSize: number;
  /** 原始大小 */
  uncompressedSize: number;
  /** 内部属性 */
  internalAttrs: number;
  /** 外部属性 */
  externalAttrs: number;
  /** 起始磁盘号 */
  diskStart: number;
  /** 条目注释 */
  comment: Buffer;
  /** 中央目录额外字段 */
  extra: Buffer;
  /** 本地文件头偏移（源文件） */
  localHeaderOffset: number;
}

/** 单条替换请求（`file` 与 `data` 二选一） */
export interface ApkReplacement {
  /** zip 内条目名 */
  entry: string;
  /** 替换用的本地文件 */
  file?: string;
  /** 替换用的内存数据（与 `file` 互斥，优先于 `file`） */
  data?: Buffer;
}

/** 改造选项 */
export interface ApkPatchOptions {
  /** 源 APK */
  inApk: string;
  /** 输出 APK */
  outApk: string;
  /** 条目替换列表 */
  replacements: ApkReplacement[];
  /** 新增条目列表（源包中不存在；用于把新版资源补进已安装包，如热更后的 Lua bundle 名） */
  additions?: ApkReplacement[];
  /** 删除：精确条目名 */
  drops?: string[];
  /** 删除：条目名前缀（目录级，如 `lib/armeabi-v7a/`） */
  dropPrefixes?: string[];
  /** 是否抹掉 V1 签名条目（默认 true） */
  stripV1: boolean;
  /** 只分析不写盘 */
  dryRun: boolean;
}

/** 改造结果 */
export interface ApkPatchReport {
  /** 源条目总数 */
  entryCount: number;
  /** 实际写入的条目数 */
  writtenCount: number;
  /** 被抹掉的 V1 签名条目 */
  stripped: string[];
  /** 替换明细 */
  replaced: { entry: string; oldSize: number; oldCrc: number; newSize: number; newCrc: number }[];
  /** 新增条目明细 */
  added: { entry: string; newSize: number; newCrc: number }[];
  /** 删除条目明细 */
  dropped: { entry: string; size: number }[];
  /** 输出文件大小 */
  outSize: number;
}

/** 源 APK 概况（--list / 校验用） */
export interface ApkInspection {
  /** 文件大小 */
  fileSize: number;
  /** 条目总数 */
  entryCount: number;
  /** 中央目录偏移 */
  cdOffset: number;
  /** 是否存在 V1 签名条目 */
  hasV1: boolean;
  /** 是否存在 APK Signing Block */
  hasSigningBlock: boolean;
  /** 条目名列表 */
  names: string[];
}

/**
 * 读文件指定区间（循环补齐短读）。
 * @param fd       - 文件描述符
 * @param length   - 期望字节数
 * @param position - 起始偏移
 * @returns 读到的字节
 */
function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, position + read);
    if (n <= 0) throw new Error(`读取失败：pos=${position} 需要 ${length} 字节，实际 ${read}`);
    read += n;
  }
  return buf;
}

/**
 * 解析 EOCD（从文件尾部反向查找签名）。
 * @param fd       - 文件描述符
 * @param fileSize - 文件大小
 * @returns EOCD 信息
 */
function readEocd(fd: number, fileSize: number): EocdInfo {
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const base = fileSize - tailLen;
  const tail = readAt(fd, tailLen, base);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    const entryCount = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    const commentLen = tail.readUInt16LE(i + 20);
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error("源 APK 使用 zip64，本脚本暂不支持");
    }
    if (i + 22 + commentLen > tail.length) {
      throw new Error("EOCD 注释长度越界，文件可能已损坏");
    }
    return { entryCount, cdSize, cdOffset, comment: tail.subarray(i + 22, i + 22 + commentLen) };
  }
  throw new Error("未找到 EOCD：不是有效 zip/APK");
}

/**
 * 解析中央目录。
 * @param fd   - 文件描述符
 * @param eocd - EOCD 信息
 * @returns 条目记录数组（按中央目录顺序）
 */
function readCentralDirectory(fd: number, eocd: EocdInfo): ZipEntryRecord[] {
  const cd = readAt(fd, eocd.cdSize, eocd.cdOffset);
  const entries: ZipEntryRecord[] = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      name: cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      nameBytes: Buffer.from(cd.subarray(p + 46, p + 46 + nameLen)),
      versionMadeBy: cd.readUInt16LE(p + 4),
      versionNeeded: cd.readUInt16LE(p + 6),
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      modTime: cd.readUInt16LE(p + 12),
      modDate: cd.readUInt16LE(p + 14),
      crc: cd.readUInt32LE(p + 16),
      compressedSize: cd.readUInt32LE(p + 20),
      uncompressedSize: cd.readUInt32LE(p + 24),
      internalAttrs: cd.readUInt16LE(p + 36),
      externalAttrs: cd.readUInt32LE(p + 38),
      diskStart: cd.readUInt16LE(p + 34),
      comment: Buffer.from(cd.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)),
      extra: Buffer.from(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)),
      localHeaderOffset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length !== eocd.entryCount) {
    throw new Error(`中央目录条目数不一致：EOCD=${eocd.entryCount}，实读=${entries.length}`);
  }
  return entries;
}

/**
 * 求条目数据在源文件中的起始偏移（必须读本地文件头，其 extra 长度可能与中央目录不同）。
 * @param fd    - 文件描述符
 * @param entry - 条目记录
 * @returns 数据起始偏移
 */
function localDataOffset(fd: number, entry: ZipEntryRecord): number {
  const lh = readAt(fd, 30, entry.localHeaderOffset);
  if (lh.readUInt32LE(0) !== LOCAL_SIG) {
    throw new Error(`条目 ${entry.name} 的本地文件头签名非法`);
  }
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  return entry.localHeaderOffset + 30 + nameLen + extraLen;
}

/**
 * 构造对齐填充 extra（本地头专用）：使数据偏移落在 align 边界。
 * @param currentOffset - 该条目本地头将写入的偏移
 * @param nameLen       - 条目名字节数
 * @param baseExtra     - 源本地头 extra（保留其内容）
 * @param align         - 对齐字节（1 表示不对齐）
 * @returns 本地头 extra
 */
function buildLocalExtra(currentOffset: number, nameLen: number, baseExtra: Buffer, align: number): Buffer {
  if (align <= 1) return baseExtra;
  // 数据偏移 = currentOffset + 30 + nameLen + extraLen，extraLen 至少再加一个 4 字节字段头
  const need = (align - ((currentOffset + 30 + nameLen + baseExtra.length + 4) % align)) % align;
  const field = Buffer.alloc(4 + need);
  field.writeUInt16LE(EXTRA_ID_ALIGN, 0);
  field.writeUInt16LE(need, 2);
  return Buffer.concat([baseExtra, field]);
}

/**
 * 构造本地文件头。
 * @param entry        - 条目记录（尺寸/CRC 用新值）
 * @param extra        - 本地头 extra
 * @returns 30 字节头
 */
function buildLocalHeader(entry: ZipEntryRecord, extra: Buffer): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(LOCAL_SIG, 0);
  h.writeUInt16LE(Math.max(entry.versionNeeded, 20), 4);
  h.writeUInt16LE(entry.flags & ~FLAG_DATA_DESCRIPTOR, 6);
  h.writeUInt16LE(entry.method, 8);
  h.writeUInt16LE(entry.modTime, 10);
  h.writeUInt16LE(entry.modDate, 12);
  h.writeUInt32LE(entry.crc >>> 0, 14);
  h.writeUInt32LE(entry.compressedSize, 18);
  h.writeUInt32LE(entry.uncompressedSize, 22);
  h.writeUInt16LE(entry.nameBytes.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return h;
}

/**
 * 构造中央目录记录。
 * @param entry - 条目记录（尺寸/CRC/偏移用新值）
 * @returns 中央目录记录字节
 */
function buildCdRecord(entry: ZipEntryRecord): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(CD_SIG, 0);
  h.writeUInt16LE(entry.versionMadeBy, 4);
  h.writeUInt16LE(Math.max(entry.versionNeeded, 20), 6);
  h.writeUInt16LE(entry.flags & ~FLAG_DATA_DESCRIPTOR, 8);
  h.writeUInt16LE(entry.method, 10);
  h.writeUInt16LE(entry.modTime, 12);
  h.writeUInt16LE(entry.modDate, 14);
  h.writeUInt32LE(entry.crc >>> 0, 16);
  h.writeUInt32LE(entry.compressedSize, 20);
  h.writeUInt32LE(entry.uncompressedSize, 24);
  h.writeUInt16LE(entry.nameBytes.length, 28);
  h.writeUInt16LE(entry.extra.length, 30);
  h.writeUInt16LE(entry.comment.length, 32);
  h.writeUInt16LE(entry.diskStart, 34);
  h.writeUInt16LE(entry.internalAttrs, 36);
  h.writeUInt32LE(entry.externalAttrs, 38);
  h.writeUInt32LE(entry.localHeaderOffset, 42);
  return Buffer.concat([h, entry.nameBytes, entry.extra, entry.comment]);
}

/**
 * 构造 EOCD。
 * @param entryCount - 条目数
 * @param cdSize     - 中央目录字节数
 * @param cdOffset   - 中央目录偏移
 * @param comment    - zip 注释
 * @returns EOCD 字节
 */
function buildEocd(entryCount: number, cdSize: number, cdOffset: number, comment: Buffer): Buffer {
  if (entryCount > 0xffff) throw new Error(`条目数 ${entryCount} 超出 EOCD 表示范围`);
  const h = Buffer.alloc(22);
  h.writeUInt32LE(EOCD_SIG, 0);
  h.writeUInt16LE(0, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(entryCount, 8);
  h.writeUInt16LE(entryCount, 10);
  h.writeUInt32LE(cdSize, 12);
  h.writeUInt32LE(cdOffset, 16);
  h.writeUInt16LE(comment.length, 20);
  return Buffer.concat([h, comment]);
}

/**
 * 追加顺序写盘器（维护自身偏移，替代 WriteStream 以便大文件顺序写）。
 */
class ZipWriter {
  private readonly _fd: number;
  private _offset = 0;
  private readonly _buf = Buffer.alloc(COPY_CHUNK);

  /**
   * @param outPath - 输出文件路径
   */
  constructor(outPath: string) {
    this._fd = fs.openSync(outPath, "w");
  }

  /** 当前已写入字节数 */
  get offset(): number {
    return this._offset;
  }

  /**
   * 写入一段字节。
   * @param buf - 待写入数据
   */
  write(buf: Buffer): void {
    let done = 0;
    while (done < buf.length) {
      const n = fs.writeSync(this._fd, buf, done, buf.length - done, this._offset);
      if (n <= 0) throw new Error("写盘中断");
      done += n;
      this._offset += n;
    }
  }

  /**
   * 从源文件原样拷贝一段字节（压缩后的原始数据，不重新压缩）。
   * @param srcFd    - 源文件描述符
   * @param position - 源起始偏移
   * @param length   - 字节数
   */
  copyFrom(srcFd: number, position: number, length: number): void {
    let done = 0;
    while (done < length) {
      const want = Math.min(this._buf.length, length - done);
      const got = fs.readSync(srcFd, this._buf, 0, want, position + done);
      if (got <= 0) throw new Error(`源文件读取中断：pos=${position + done}`);
      let written = 0;
      while (written < got) {
        const n = fs.writeSync(this._fd, this._buf, written, got - written, this._offset);
        if (n <= 0) throw new Error("写盘中断");
        written += n;
        this._offset += n;
      }
      done += got;
    }
  }

  /** 关闭输出文件 */
  close(): void {
    fs.closeSync(this._fd);
  }
}

/**
 * 选择 STORED 条目的对齐字节。
 * @param entry - 条目记录
 * @returns 对齐字节（1 = 不填充）
 */
function alignFor(entry: ZipEntryRecord): number {
  if (entry.method !== METHOD_STORE) return 1;
  return /\.so$/i.test(entry.name) ? ALIGN_SO : ALIGN_DEFAULT;
}

/**
 * 概览源 APK（不写盘）。
 * @param apkPath - APK 路径
 * @returns 概况
 */
export function inspectApk(apkPath: string): ApkInspection {
  const fileSize = fs.statSync(apkPath).size;
  const fd = fs.openSync(apkPath, "r");
  try {
    const eocd = readEocd(fd, fileSize);
    const entries = readCentralDirectory(fd, eocd);
    // CD 前 20 字节含 APK Signing Block 尾部的魔数
    const probe = readAt(fd, Math.min(64, eocd.cdOffset), eocd.cdOffset - Math.min(64, eocd.cdOffset));
    return {
      fileSize,
      entryCount: entries.length,
      cdOffset: eocd.cdOffset,
      hasV1: entries.some((e) => V1_SIG_RE.test(e.name)),
      hasSigningBlock: probe.includes(Buffer.from("APK Sig Block 42")),
      names: entries.map((e) => e.name),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 执行改造：逐条目重写 zip，替换指定条目并抹掉旧签名。
 * @param opts - 改造选项
 * @returns 改造结果
 */
export function patchApk(opts: ApkPatchOptions): ApkPatchReport {
  if (path.resolve(opts.inApk) === path.resolve(opts.outApk)) {
    throw new Error("输出路径不能与源 APK 相同（如需覆盖请先输出到临时文件）");
  }
  const srcSize = fs.statSync(opts.inApk).size;
  const srcFd = fs.openSync(opts.inApk, "r");
  const writer = opts.dryRun ? null : new ZipWriter(opts.outApk);
  try {
    const eocd = readEocd(srcFd, srcSize);
    const entries = readCentralDirectory(srcFd, eocd);
    const byName = new Map(entries.map((e) => [e.name, e]));

    const replData = new Map<string, { data: Buffer; crc: number; srcSize: number; srcCrc: number }>();
    for (const r of opts.replacements) {
      const target = byName.get(r.entry);
      if (!target) throw new Error(`源 APK 中不存在条目：${r.entry}`);
      let data: Buffer;
      if (r.data) {
        data = r.data;
      } else if (r.file) {
        if (!fs.existsSync(r.file)) throw new Error(`替换文件不存在：${r.file}`);
        data = fs.readFileSync(r.file);
      } else {
        throw new Error(`替换 ${r.entry} 既没有 file 也没有 data`);
      }
      replData.set(r.entry, {
        data,
        crc: crc32(data) >>> 0,
        srcSize: target.uncompressedSize,
        srcCrc: target.crc >>> 0,
      });
    }

    const addData: { entry: string; data: Buffer; crc: number }[] = [];
    for (const a of opts.additions ?? []) {
      if (byName.has(a.entry)) throw new Error(`新增条目已存在（请用 --replace）：${a.entry}`);
      let data: Buffer;
      if (a.data) data = a.data;
      else if (a.file) {
        if (!fs.existsSync(a.file)) throw new Error(`新增文件不存在：${a.file}`);
        data = fs.readFileSync(a.file);
      } else {
        throw new Error(`新增 ${a.entry} 既没有 file 也没有 data`);
      }
      addData.push({ entry: a.entry, data, crc: crc32(data) >>> 0 });
    }

    /** 是否命中删除规则 */
    const shouldDrop = (name: string): boolean =>
      (opts.drops ?? []).includes(name) || (opts.dropPrefixes ?? []).some((p) => name.startsWith(p));

    const report: ApkPatchReport = {
      entryCount: entries.length,
      writtenCount: 0,
      stripped: [],
      replaced: [],
      added: [],
      dropped: [],
      outSize: 0,
    };

    if (!writer) {
      // dry-run：只报告将会发生什么
      for (const e of entries) {
        const repl = replData.get(e.name);
        if (repl) {
          report.replaced.push({
            entry: e.name,
            oldSize: repl.srcSize,
            oldCrc: repl.srcCrc,
            newSize: repl.data.length,
            newCrc: repl.crc,
          });
        }
        if (opts.stripV1 && V1_SIG_RE.test(e.name)) report.stripped.push(e.name);
        else if (shouldDrop(e.name)) report.dropped.push({ entry: e.name, size: e.uncompressedSize });
      }
      for (const a of addData) report.added.push({ entry: a.entry, newSize: a.data.length, newCrc: a.crc });
      report.writtenCount =
        report.entryCount - report.stripped.length - report.dropped.length + addData.length;
      return report;
    }

    const newEntries: ZipEntryRecord[] = [];
    for (const entry of entries) {
      if (opts.stripV1 && V1_SIG_RE.test(entry.name)) {
        report.stripped.push(entry.name);
        continue;
      }
      if (shouldDrop(entry.name)) {
        report.dropped.push({ entry: entry.name, size: entry.uncompressedSize });
        continue;
      }
      const repl = replData.get(entry.name);
      const next: ZipEntryRecord = { ...entry };
      if (repl) {
        next.method = METHOD_STORE;
        next.crc = repl.crc;
        next.compressedSize = repl.data.length;
        next.uncompressedSize = repl.data.length;
        report.replaced.push({
          entry: entry.name,
          oldSize: repl.srcSize,
          oldCrc: repl.srcCrc,
          newSize: repl.data.length,
          newCrc: repl.crc,
        });
      }
      next.localHeaderOffset = writer.offset;
      // 本地头 extra 一律重建（丢弃源 extra）：源 extra 可能含旧的对齐填充/时间戳，
      // 保留会与新的数据偏移冲突；zip64/加密 extra 已在前置校验中排除。
      const localExtra = buildLocalExtra(writer.offset, next.nameBytes.length, Buffer.alloc(0), alignFor(next));
      writer.write(buildLocalHeader(next, localExtra));
      writer.write(next.nameBytes);
      if (localExtra.length > 0) writer.write(localExtra);
      if (repl) {
        writer.write(repl.data);
      } else {
        writer.copyFrom(srcFd, localDataOffset(srcFd, entry), entry.compressedSize);
      }
      newEntries.push(next);
      report.writtenCount++;
      if (report.writtenCount % 500 === 0) {
        console.log(
          `[apk-patch] 已写入 ${report.writtenCount}/${report.entryCount} 条（${(writer.offset / 1e6).toFixed(0)} MB）`,
        );
      }
    }

    // 新增条目：STORED + 4 字节对齐（与官方 assets 布局一致），追加在既有条目之后
    for (const a of addData) {
      const nameBytes = Buffer.from(a.entry, "utf8");
      const added: ZipEntryRecord = {
        name: a.entry,
        nameBytes,
        versionMadeBy: 20,
        versionNeeded: 20,
        flags: FLAG_UTF8,
        method: METHOD_STORE,
        // DOS 时间戳：2024-01-01 00:00（不能用 0——月份/日期为 0 的非法时间戳会让部分 zip 读取器解析异常）
        modTime: 0,
        modDate: 0x5821,
        crc: a.crc,
        compressedSize: a.data.length,
        uncompressedSize: a.data.length,
        internalAttrs: 0,
        externalAttrs: 0,
        diskStart: 0,
        comment: Buffer.alloc(0),
        extra: Buffer.alloc(0),
        localHeaderOffset: writer.offset,
      };
      const localExtra = buildLocalExtra(writer.offset, nameBytes.length, Buffer.alloc(0), ALIGN_DEFAULT);
      writer.write(buildLocalHeader(added, localExtra));
      writer.write(nameBytes);
      if (localExtra.length > 0) writer.write(localExtra);
      writer.write(a.data);
      newEntries.push(added);
      report.added.push({ entry: a.entry, newSize: a.data.length, newCrc: a.crc });
      report.writtenCount++;
    }

    const cdOffset = writer.offset;
    let cdSize = 0;
    for (const e of newEntries) {
      const rec = buildCdRecord(e);
      writer.write(rec);
      cdSize += rec.length;
    }
    writer.write(buildEocd(newEntries.length, cdSize, cdOffset, eocd.comment));
    report.outSize = writer.offset;
    return report;
  } finally {
    if (writer) writer.close();
    fs.closeSync(srcFd);
  }
}

/**
 * 输出改造后 APK 的自检结论（重扫中央目录 + 校验替换条目 + 对齐检查）。
 * @param apkPath - 输出 APK
 * @param expected - 期望条目：条目名 → CRC32
 * @returns 问题列表（空 = 通过）
 */
export function verifyPatchedApk(apkPath: string, expected: Map<string, number>): string[] {
  const problems: string[] = [];
  const fileSize = fs.statSync(apkPath).size;
  const fd = fs.openSync(apkPath, "r");
  try {
    const eocd = readEocd(fd, fileSize);
    const entries = readCentralDirectory(fd, eocd);
    const byName = new Map(entries.map((e) => [e.name, e]));
    for (const [name, crc] of expected) {
      const e = byName.get(name);
      if (!e) {
        problems.push(`缺少条目 ${name}`);
        continue;
      }
      if ((e.crc >>> 0) !== (crc >>> 0)) problems.push(`条目 ${name} CRC 不符`);
      if (e.uncompressedSize !== e.compressedSize) problems.push(`条目 ${name} 未按 STORED 写入`);
    }
    for (const e of entries) {
      const align = alignFor(e);
      if (align <= 1) continue;
      const off = localDataOffset(fd, e);
      if (off % align !== 0) problems.push(`条目 ${e.name} 数据偏移 ${off} 未按 ${align} 字节对齐`);
      if (e.uncompressedSize !== e.compressedSize) problems.push(`STORED 条目 ${e.name} 压缩尺寸异常`);
    }
    // 结构自检：本地头+名字+extra 必须与数据首尾相接（漏写 extra 这类错位只有这里能查出来）
    const spans = entries
      .map((e) => {
        const dataStart = localDataOffset(fd, e);
        return { name: e.name, start: e.localHeaderOffset, end: dataStart + e.compressedSize };
      })
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].start < spans[i - 1].end) {
        problems.push(`条目 ${spans[i].name} 与 ${spans[i - 1].name} 数据区重叠`);
      }
    }
    const last = spans[spans.length - 1];
    if (last && last.end > eocd.cdOffset) {
      problems.push(`末条目 ${last.name} 越过中央目录起点（${last.end} > ${eocd.cdOffset}）`);
    }
    if (entries.some((e) => V1_SIG_RE.test(e.name))) problems.push("仍存在 V1 签名条目（未抹干净）");
  } catch (e) {
    problems.push(`解析输出 APK 失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    fs.closeSync(fd);
  }
  return problems;
}

/** CLI 参数 */
interface CliArgs {
  inApk: string;
  outApk: string;
  luaBundle: string;
  entry: string;
  replace: string[];
  add: string[];
  drop: string[];
  dropPrefix: string[];
  stripV1: boolean;
  dryRun: boolean;
  list: boolean;
  sign: boolean;
  outDir: string;
}

/**
 * 解析命令行参数。
 * @param argv - 参数（不含 node/脚本名）
 * @returns 解析结果
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inApk: "",
    outApk: "",
    luaBundle: "",
    entry: "",
    replace: [],
    add: [],
    drop: [],
    dropPrefix: [],
    stripV1: true,
    dryRun: false,
    list: false,
    sign: false,
    outDir: path.join(__dirname, "..", "tmp", "apk-out"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.inApk = argv[++i] ?? "";
    else if (a === "--out") args.outApk = argv[++i] ?? "";
    else if (a === "--lua-bundle") args.luaBundle = argv[++i] ?? "";
    else if (a === "--entry") args.entry = argv[++i] ?? "";
    else if (a === "--replace") args.replace.push(argv[++i] ?? "");
    else if (a === "--add") args.add.push(argv[++i] ?? "");
    else if (a === "--drop") args.drop.push(argv[++i] ?? "");
    else if (a === "--drop-prefix") args.dropPrefix.push(argv[++i] ?? "");
    else if (a === "--keep-v1") args.stripV1 = false;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--list") args.list = true;
    else if (a === "--sign") args.sign = true;
    else if (a === "--out-dir") args.outDir = argv[++i] ?? args.outDir;
    else if (a === "--help" || a === "-h") {
      console.log(
        "用法: pnpm run apk:patch -- --in <官方.apk> [--lua-bundle <mods/anon_x.dat>] [--entry <zip条目>]\n" +
          "            [--replace <zip条目>=<本地文件>]... [--add <zip条目>=<本地文件>]...\n            [--drop <zip条目>]... [--drop-prefix <前缀>]...\n            [--out <出包.apk>] [--out-dir <签名输出目录>]\n" +
          "            [--keep-v1] [--dry-run] [--list] [--sign]",
      );
      process.exit(0);
    }
  }
  return args;
}

/** CLI 入口 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inApk) {
    console.error("[apk-patch] 必须指定 --in <官方.apk>");
    process.exit(1);
  }
  if (!fs.existsSync(args.inApk)) {
    console.error(`[apk-patch] APK 不存在: ${args.inApk}`);
    process.exit(1);
  }

  if (args.list) {
    const info = inspectApk(args.inApk);
    console.log(
      `[apk-patch] ${args.inApk}\n` +
        `  大小: ${(info.fileSize / 1e6).toFixed(1)} MB，条目 ${info.entryCount}，CD 偏移 ${info.cdOffset}\n` +
        `  V1 签名: ${info.hasV1 ? "有" : "无"}，APK Signing Block: ${info.hasSigningBlock ? "有" : "无"}`,
    );
    for (const n of info.names) console.log(`  - ${n}`);
    return;
  }

  const replacements: ApkReplacement[] = [];
  for (const raw of args.replace) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      console.error(`[apk-patch] --replace 格式应为 <zip条目>=<本地文件>，收到: ${raw}`);
      process.exit(1);
    }
    replacements.push({ entry: raw.slice(0, eq), file: raw.slice(eq + 1) });
  }
  const additions: ApkReplacement[] = [];
  for (const raw of args.add) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      console.error(`[apk-patch] --add 格式应为 <zip条目>=<本地文件>，收到: ${raw}`);
      process.exit(1);
    }
    additions.push({ entry: raw.slice(0, eq), file: raw.slice(eq + 1) });
  }
  if (args.luaBundle) {
    if (!fs.existsSync(args.luaBundle)) {
      console.error(`[apk-patch] 注入版 bundle 不存在: ${args.luaBundle}`);
      process.exit(1);
    }
    let entry = args.entry;
    if (!entry) {
      console.log("[apk-patch] 未指定 --entry，扫描 APK 定位内置 Lua bundle…");
      const found = await findLuaBundleInApk(args.inApk);
      entry = found.entryPath;
      console.log(`[apk-patch] 内置 Lua bundle: ${entry}`);
    }
    replacements.push({ entry, file: args.luaBundle });
  }
  if (replacements.length === 0 && additions.length === 0 && args.drop.length === 0 && args.dropPrefix.length === 0) {
    console.error("[apk-patch] 没有任何改动（--lua-bundle/--replace/--add/--drop/--drop-prefix），无事可做");
    process.exit(1);
  }

  const outApk =
    args.outApk ||
    path.join(args.outDir, `${path.basename(args.inApk).replace(/\.apk$/i, "")}-mod.apk`);
  fs.mkdirSync(path.dirname(path.resolve(outApk)), { recursive: true });

  const info = inspectApk(args.inApk);
  console.log(
    `[apk-patch] 源: ${args.inApk}（${(info.fileSize / 1e6).toFixed(1)} MB，${info.entryCount} 条，` +
      `V1 ${info.hasV1 ? "有" : "无"}，签名块 ${info.hasSigningBlock ? "有" : "无"}）`,
  );
  const t0 = Date.now();
  const report = patchApk({
    inApk: args.inApk,
    outApk,
    replacements,
    additions,
    drops: args.drop,
    dropPrefixes: args.dropPrefix,
    stripV1: args.stripV1,
    dryRun: args.dryRun,
  });
  for (const a of report.added) {
    console.log(`[apk-patch] 新增 ${a.entry}: ${a.newSize} B(crc ${a.newCrc.toString(16)})`);
  }
  if (report.dropped.length > 0) {
    const saved = report.dropped.reduce((n, d) => n + d.size, 0);
    console.log(`[apk-patch] 删除 ${report.dropped.length} 条（未压缩合计 ${(saved / 1e6).toFixed(1)} MB）`);
  }
  for (const r of report.replaced) {
    console.log(
      `[apk-patch] 替换 ${r.entry}: ${r.oldSize} B(crc ${r.oldCrc.toString(16)}) → ${r.newSize} B(crc ${r.newCrc.toString(16)})`,
    );
  }
  console.log(
    `[apk-patch] 抹掉 V1 签名条目 ${report.stripped.length} 个${report.stripped.length ? `（${report.stripped.join(", ")}）` : ""}`,
  );
  if (args.dryRun) {
    console.log(`[apk-patch] dry-run 完成：将写入 ${report.writtenCount} 条，未落盘`);
    return;
  }
  console.log(
    `[apk-patch] 写出 ${outApk}（${(report.outSize / 1e6).toFixed(1)} MB，${report.writtenCount} 条，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );

  const expected = new Map(report.replaced.map((r) => [r.entry, r.newCrc]));
  const problems = verifyPatchedApk(outApk, expected);
  if (problems.length) {
    console.error("[apk-patch] 自检失败：");
    for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[apk-patch] 自检通过（条目 CRC、STORED 布局、对齐、签名条目清理）");

  if (args.sign) {
    const signed = await signApk({ inApk: outApk, outDir: args.outDir });
    console.log(`[apk-patch] 已签名: ${signed}`);
  } else {
    console.log("[apk-patch] 提示：加 --sign 可自动重签（需 tmp/tools 工具链），否则用 apksigner 手动重签");
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((e) => {
    console.error("[apk-patch] 失败:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
