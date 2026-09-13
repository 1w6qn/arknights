/**
 * 奇象巡展巡展像素（ARKPIXEL）存储服务（私服扩展，2026-08-17）
 *
 * 官服链路（抓包 R-1786876787370-0074 / R-1786680304215-0147）：
 * - savePixelArt（multipart：json part `{"brief":{"activityId","token"}}` +
 *   pixelData part 1728B RGB）→ 响应 `{"pixelArtId":<数字>}`
 * - getPixelArt（JSON `{activityId, pixelArtIds:[...]}`）→
 *   `{"pixelArts":{<id>:{"url":...,"isBanned":false}}}`
 *
 * 私服实现：像素落盘 `data/arkhub/pixels/<pixelArtId>.bin`（1728B），
 * getPixelArt 返回本服下载 URL（`<config.Host>/activity/arkhub/pixel/<id>.dat`），
 * 发布/收集计数驱动任务 20-23 与勋章 01（arkhubPixelPublished/arkhubPixelCollected）。
 * 像素跨账号共享（"对外公开"），pixelArtId 全局唯一。
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logger } from "@utils/logger";
import {
  validatePixelData,
  PIXEL_DATA_LEN,
  PIXEL_PALETTE,
  type PixelInput,
} from "./pixel-format";
import { BadRequestError } from "@core/http/errors";

/** 像素存储目录（gitignored 运行时数据；index.json 为元数据索引；测试可注入临时目录） */
export let PIXELS_DIR = path.resolve("data/arkhub/pixels");

/** 测试注入：切换存储目录并重置内存索引 */
export function setPixelsDirForTest(dir: string): void {
  PIXELS_DIR = dir;
  _index = null;
}

/** 索引文件路径（跟随 PIXELS_DIR） */
function indexFile(): string {
  return path.join(PIXELS_DIR, "index.json");
}

/** 像素元数据（按 pixelArtId 索引；跨账号共享） */
export interface PixelMeta {
  uid: string;
  ts: number;
  md5: string;
  banned: boolean;
}

/** 发布次数上限（攻略：最多申请 50 次发布） */
export const ARKPIXEL_MAX_PUBLISH = 50;

let _index: Record<string, PixelMeta> | null = null;

/**
 * 上传 token → {pixel_art_id, md5} 暂存（内存，进程内共享）。
 * 网关 RequestPixelArtUploadToken 分支分配 id 后登记；HTTP savePixelArt 消费。
 * 作用：保证"token 阶段分配给客户端的 pixel_art_id" = "落盘 pixelArtId"——
 * 客户端上传成功后用 token 响应里的 id 调 getPixelArt 加载画像时能命中（此前两者不一致
 * 导致"上传成功但无法加载"）。token 一次性消费，客户端重试会重新申请。
 */
const _pendingPixelUploads = new Map<string, { id: number; md5: string }>();

/** 登记像素上传 token（网关 token 请求分支调用） */
export function registerPixelUploadToken(token: string, id: number, md5: string): void {
  if (token) _pendingPixelUploads.set(token, { id, md5 });
}

/** 查询像素上传 token（不消费；savePixelArt 校验/取 id 用） */
export function peekPixelUploadToken(token: string): { id: number; md5: string } | undefined {
  return _pendingPixelUploads.get(token);
}

/** 消费像素上传 token（savePixelArt 落盘成功后调用，一次性删除） */
export function consumePixelUploadToken(token: string): { id: number; md5: string } | undefined {
  const v = _pendingPixelUploads.get(token);
  _pendingPixelUploads.delete(token);
  return v;
}

/** 测试辅助：清空待消费上传 token（单测隔离用） */
export function _resetPendingPixelUploadsForTest(): void {
  _pendingPixelUploads.clear();
}

/** 加载像素索引（惰性；损坏时重置为空并告警） */
function loadIndex(): Record<string, PixelMeta> {
  if (_index) return _index;
  try {
    if (fs.existsSync(indexFile())) {
      _index = JSON.parse(fs.readFileSync(indexFile(), "utf-8"));
    } else {
      _index = {};
    }
  } catch (e) {
    logger.warn("arkpixel", `像素索引损坏，重置为空: ${(e as Error).message}`);
    _index = {};
  }
  return _index!;
}

/** 持久化索引（防抖：直接同步写——像素操作低频） */
function saveIndex(): void {
  if (!_index) return;
  fs.mkdirSync(PIXELS_DIR, { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(_index, null, 1));
}

/** 分配全局唯一 pixelArtId（10 位数字，与官服同量级；防冲突重试） */
export function allocPixelArtId(): number {
  const idx = loadIndex();
  for (let i = 0; i < 50; i++) {
    const id = crypto.randomInt(1_000_000_000, 9_999_999_999);
    if (!idx[String(id)]) return id;
  }
  // 极端冲突：时间戳低位兜底
  return Number(BigInt(Date.now()) & 0xffffffffffn);
}

/** 调色板白名单（hex 小写集合；官方语义：每个像素颜色必须在此内） */
const PALETTE_SET: Set<string> = new Set(PIXEL_PALETTE.map((h) => h.toLowerCase()));

/**
 * 保存像素（发布）：校验 1728B + 调色板 → 分配 id → 落盘 + 索引
 * @param uid - 发布者 uid（入索引）
 * @param pixelData - 1728B RGB 或可被 validatePixelData 接受的输入
 * @param pixelArtId - 可选：指定 id（网关 token 阶段预分配的 id，保证客户端加载命中）；
 *                     缺省/已被占用时自动分配新 id
 * @returns 分配的 pixelArtId
 * @throws 像素数据非法（长度/调色板）抛 Error
 */
export function savePixel(uid: string, pixelData: PixelInput, pixelArtId?: number): number {
  const buf = validatePixelData(pixelData);
  if (buf.length !== PIXEL_DATA_LEN) {
    throw new BadRequestError(`pixel data length ${buf.length} != ${PIXEL_DATA_LEN}`);
  }
  // 调色板白名单校验（每像素 RGB → hex）
  for (let i = 0; i < buf.length; i += 3) {
    const hex =
      "#" +
      buf[i].toString(16).padStart(2, "0") +
      buf[i + 1].toString(16).padStart(2, "0") +
      buf[i + 2].toString(16).padStart(2, "0");
    if (!PALETTE_SET.has(hex)) {
      throw new BadRequestError(`invalid pixel color ${hex} at px ${i / 3}`);
    }
  }
  const idx = loadIndex();
  // 指定 id 未被占用则沿用（token 阶段预分配），否则回退自动分配
  const id = pixelArtId && !idx[String(pixelArtId)] ? pixelArtId : allocPixelArtId();
  fs.mkdirSync(PIXELS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PIXELS_DIR, `${id}.bin`), buf);
  idx[String(id)] = {
    uid,
    ts: Math.floor(Date.now() / 1000),
    md5: crypto.createHash("md5").update(buf).digest("hex"),
    banned: false,
  };
  saveIndex();
  logger.info("arkpixel", `像素发布: id=${id} uid=${uid} md5=${idx[String(id)].md5.slice(0, 8)}`);
  return id;
}

/** 读取像素原始字节（供下载端点；不存在返回 null） */
export function loadPixelBytes(pixelArtId: number | string): Buffer | null {
  const p = path.join(PIXELS_DIR, `${pixelArtId}.bin`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

/**
 * 删除像素（发布者删除）：移除 .bin 与索引记录
 * @param pixelArtId - 像素 id
 * @returns 是否存在并已删除（不存在返回 false）
 */
export function deletePixel(pixelArtId: number | string): boolean {
  const idx = loadIndex();
  const key = String(pixelArtId);
  if (!idx[key]) return false;
  delete idx[key];
  try {
    fs.rmSync(path.join(PIXELS_DIR, `${key}.bin`), { force: true });
  } catch {
    // 文件已缺失也视为删除成功
  }
  saveIndex();
  logger.info("arkpixel", `像素删除: id=${key}`);
  return true;
}

/** 像素元数据（不存在返回 undefined） */
export function pixelMeta(pixelArtId: number | string): PixelMeta | undefined {
  return loadIndex()[String(pixelArtId)];
}

/**
 * 列出指定 uid 发布的像素（creations 数据源：PixelArtData.f1）
 * @param uid - 发布者 uid
 * @returns 像素列表（id/md5/ts，按时间升序）
 */
export function listPixelsByUid(uid: string): Array<PixelMeta & { id: number }> {
  const idx = loadIndex();
  const out: Array<PixelMeta & { id: number }> = [];
  for (const [id, meta] of Object.entries(idx)) {
    if (meta.uid === uid) out.push({ id: Number(id), ...meta });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * getPixelArt 响应构造（对齐官服形状）：url 指向本服下载端点
 * @param pixelArtIds - 请求的画像 id 列表
 * @param baseUrl - config.Host（拼绝对下载 URL）
 */
export function buildPixelArtResp(
  pixelArtIds: number[],
  baseUrl: string,
): Record<string, { url: string; isBanned: boolean }> {
  const idx = loadIndex();
  const out: Record<string, { url: string; isBanned: boolean }> = {};
  const host = String(baseUrl).replace(/\/$/, "");
  for (const id of pixelArtIds) {
    const meta = idx[String(id)];
    if (!meta) continue;
    out[String(id)] = {
      url: `${host}/activity/arkhub/pixel/${id}.dat`,
      isBanned: !!meta.banned,
    };
  }
  return out;
}

/**
 * 收集画像去重计算（getPixelArt 路由用）：
 * 请求的画像 id 中"非本人发布且尚未收集"的 → 新收集列表。
 * @param uid - 当前玩家 uid
 * @param pixelArtIds - 本次请求拉取的画像 id
 * @param collectedIds - 已收集画像 id 集合（ARK_HUB.pixelCollectedIds）
 * @returns 新增收集的画像 id 列表（调用方据此累加计数）
 */
export function computeNewCollects(
  uid: string,
  pixelArtIds: number[],
  collectedIds: number[] = [],
): number[] {
  const idx = loadIndex();
  const collected = new Set(collectedIds.map(String));
  const fresh: number[] = [];
  for (const id of pixelArtIds) {
    const meta = idx[String(id)];
    if (!meta || meta.uid === uid) continue; // 不存在或本人发布不算收集
    if (collected.has(String(id))) continue;
    collected.add(String(id));
    fresh.push(id);
  }
  return fresh;
}

/** 测试辅助：重置内存索引（单测隔离用） */
export function _resetPixelIndexForTest(): void {
  _index = null;
}

/**
 * 极简 multipart/form-data 解析（savePixelArt 用：json part + pixelData part）
 * boundary 从 Content-Type 提取；part 按 `--boundary` 分隔，headers 取 name 属性。
 * @returns name → body（去除尾部 \r\n）
 */
export function parseMultipartForm(
  raw: Buffer,
  contentType: string | undefined,
): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!raw || raw.length === 0) return out;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  const boundary = (m?.[1] ?? m?.[2])?.trim();
  if (!boundary) return out;
  const delim = Buffer.from(`--${boundary}`);
  let pos = raw.indexOf(delim);
  while (pos >= 0) {
    const next = raw.indexOf(delim, pos + delim.length);
    if (next < 0) break;
    const part = raw.subarray(pos + delim.length, next);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString("utf-8");
      const nameM = /name="([^"]+)"/.exec(headers);
      if (nameM) {
        let body = part.subarray(headerEnd + 4);
        if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
          body = body.subarray(0, body.length - 2);
        }
        out.set(nameM[1], body);
      }
    }
    pos = next;
  }
  return out;
}
