/**
 * arkhub 像素画工具（管理后台像素画生成 / 上传官服用）
 *
 * 像素格式（常量 / 校验 / 调色板）的**唯一事实来源已下沉玩法模块**
 * `@game/modules/activities/arkhub/domain/pixel-format.ts`（2026-09-13，
 * 消除 game → ops 反向依赖）——本文件只保留后台侧能力：PNG 渲染与 md5，
 * 并 re-export 格式 API，保持 `./arkhub-pixel` 既有消费方（AdminService / official-ops / 测试）零改动。
 */
import { createHash } from "crypto";
import { deflateSync } from "zlib";
import {
  PIXEL_CANVAS_W,
  PIXEL_CANVAS_H,
  PIXEL_DATA_LEN,
  PIXEL_EMPTY,
  validatePixelData,
} from "@game/modules/activities/arkhub/public";

// 格式 API 门面转发（ops 内部消费方与测试继续从本模块取）
export {
  PIXEL_CANVAS_W,
  PIXEL_CANVAS_H,
  PIXEL_DATA_LEN,
  PIXEL_EMPTY,
  PIXEL_PALETTE,
  validatePixelData,
  type PixelColorObject,
  type PixelInput,
} from "@game/modules/activities/arkhub/public";

/** 像素数据 md5（hex 小写）——RequestPixelArtUploadTokenReq 的 Md5 字段 */
export function pixelDataMd5(pixels: Buffer): string {
  return createHash("md5").update(pixels).digest("hex");
}

/* ---------- PNG 编码（无第三方依赖，RGBA + 可选网格线 + 空白透明） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * 24×24 RGB 像素数据 → 放大 PNG
 *
 * 空白像素 (255,255,255) 渲染为透明；非空白像素放大为实心色块，边缘画浅灰网格线。
 *
 * @param pixels - 1728 字节 RGB
 * @param scale - 每像素放大倍数（缺省 10）
 * @param grid - 是否画网格线（缺省 true）
 * @returns PNG Buffer
 */
export function pixelDataToPng(pixels: Buffer, scale = 10, grid = true): Buffer {
  const buf = validatePixelData(pixels);
  const W = PIXEL_CANVAS_W * scale;
  const H = PIXEL_CANVAS_H * scale;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 4);
    raw[rowStart] = 0; // filter: none
    const py = Math.floor(y / scale);
    for (let x = 0; x < W; x++) {
      const px = Math.floor(x / scale);
      const i = (py * PIXEL_CANVAS_W + px) * 3;
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      const empty = r === PIXEL_EMPTY[0] && g === PIXEL_EMPTY[1] && b === PIXEL_EMPTY[2];
      const off = rowStart + 1 + x * 4;
      const isGrid = grid && (x % scale === 0 || y % scale === 0);
      if (empty) {
        raw[off] = 255;
        raw[off + 1] = 255;
        raw[off + 2] = 255;
        raw[off + 3] = 0; // 透明
      } else {
        raw[off] = isGrid ? 180 : r;
        raw[off + 1] = isGrid ? 180 : g;
        raw[off + 2] = isGrid ? 180 : b;
        raw[off + 3] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
