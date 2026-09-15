/**
 * APK（zip）只读访问：定位本地官方 APK / 列条目 / 取条目的解压内容（yauzl，按需流式读取，不整包解压）。
 *
 * 写盘侧一律交给 `scripts/apk-patch.ts#patchApk`（zip 级增量重写 + 对齐 + 抹旧签名），
 * 本模块只负责「把要改的条目读出来」。
 */
import * as fs from "fs";
import * as path from "path";
import yauzl from "yauzl";

/** zip 条目概况 */
export interface ZipEntryInfo {
  /** 条目名 */
  name: string;
  /** 解压后大小 */
  size: number;
  /** 压缩后大小 */
  compressedSize: number;
  /** 压缩方法（0 = store，8 = deflate） */
  method: number;
}

/**
 * 列出 APK 内全部条目（跳过目录项）。
 * @param apkPath - APK 路径
 * @returns 条目列表
 */
export function listZipEntries(apkPath: string): Promise<ZipEntryInfo[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(apkPath, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err || !zf) {
        reject(new Error(`APK 打开失败: ${err ? err.message : "未知错误"}`));
        return;
      }
      const entries: ZipEntryInfo[] = [];
      zf.on("error", reject);
      zf.on("end", () => resolve(entries));
      zf.on("entry", (entry: yauzl.Entry) => {
        if (!/\/$/.test(entry.fileName)) {
          entries.push({
            name: entry.fileName,
            size: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            method: entry.compressionMethod,
          });
        }
        zf.readEntry();
      });
      zf.readEntry();
    });
  });
}

/**
 * 读取指定条目的解压内容（缺失即 reject）。
 * @param apkPath - APK 路径
 * @param name - 条目名（精确匹配）
 * @returns 条目字节
 */
export function readZipEntry(apkPath: string, name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.open(apkPath, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err || !zf) {
        reject(new Error(`APK 打开失败: ${err ? err.message : "未知错误"}`));
        return;
      }
      let done = false;
      const fail = (e: Error): void => {
        if (done) return;
        done = true;
        zf.close();
        reject(e);
      };
      zf.on("error", fail);
      zf.on("end", () => fail(new Error(`APK 内没有条目 ${name}`)));
      zf.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== name) {
          zf.readEntry();
          return;
        }
        zf.openReadStream(entry, (openErr, rs) => {
          if (openErr || !rs) {
            fail(new Error(`读取条目 ${name} 失败: ${openErr ? openErr.message : "无数据流"}`));
            return;
          }
          const chunks: Buffer[] = [];
          rs.on("data", (chunk: Buffer) => chunks.push(chunk));
          rs.on("error", fail);
          rs.on("end", () => {
            if (done) return;
            done = true;
            zf.close();
            resolve(Buffer.concat(chunks));
          });
        });
      });
      zf.readEntry();
    });
  });
}

/**
 * 一次性读取多个条目（单次遍历，命中即读，缺失的条目不出现在结果里）。
 * @param apkPath - APK 路径
 * @param names - 目标条目名集合
 * @returns 条目名 → 字节
 */
export function readZipEntries(apkPath: string, names: string[]): Promise<Map<string, Buffer>> {
  const wanted = new Set(names);
  return new Promise((resolve, reject) => {
    yauzl.open(apkPath, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err || !zf) {
        reject(new Error(`APK 打开失败: ${err ? err.message : "未知错误"}`));
        return;
      }
      const out = new Map<string, Buffer>();
      let pending = 0;
      let ended = false;
      const finish = (): void => {
        if (ended && pending === 0) {
          zf.close();
          resolve(out);
        }
      };
      zf.on("error", reject);
      zf.on("end", () => {
        ended = true;
        finish();
      });
      zf.on("entry", (entry: yauzl.Entry) => {
        if (!wanted.has(entry.fileName)) {
          zf.readEntry();
          return;
        }
        pending++;
        zf.openReadStream(entry, (openErr, rs) => {
          if (openErr || !rs) {
            pending--;
            zf.readEntry();
            finish();
            return;
          }
          const chunks: Buffer[] = [];
          rs.on("data", (chunk: Buffer) => chunks.push(chunk));
          rs.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            pending--;
            zf.readEntry();
            finish();
          });
          rs.on("error", reject);
        });
      });
      zf.readEntry();
    });
  });
}

/**
 * 在 `tmp/apk/<版本>/*.apk` 下按版本号 + mtime 选出最新的官方 APK。
 * @param apkDir - APK 根目录（`<项目根>/tmp/apk`）
 * @returns APK 路径（找不到返回空串）
 */
export function locateLatestApk(apkDir: string): string {
  if (!fs.existsSync(apkDir)) return "";
  const found: { file: string; version: string; mtime: number }[] = [];
  for (const ver of fs.readdirSync(apkDir)) {
    const dir = path.join(apkDir, ver);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.apk$/i.test(f)) continue;
      const full = path.join(dir, f);
      found.push({ file: full, version: ver, mtime: fs.statSync(full).mtimeMs });
    }
  }
  if (found.length === 0) return "";
  found.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }) || a.mtime - b.mtime);
  return found[found.length - 1].file;
}
