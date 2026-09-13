/**
 * 奇象巡展像素画数据格式（24×24×3 RGB）
 *
 * 官服 arkhub 像素画数据格式（自抓包逆向确认）：
 *   - 画布 24×24，每像素 3 字节 RGB（共 1728 字节）
 *   - 空白像素为 (255,255,255)，上传时原样传输；md5 即像素数据字节的 md5
 *   - 调色板：官方热更下发（display_meta_table.pixelMapData.paramMap.<id>.htmlColors），
 *     本地数据为空，先用内置默认 40 色（PIXEL_PALETTE 可替换）
 *
 * 归属：本文件是像素格式的**唯一事实来源**（原在 `app/ops/admin/arkhub-pixel.ts`，
 * 2026-09-13 下沉到玩法模块，消除 game → ops 反向依赖）；后台侧（PNG 生成 / 官服上传）
 * 反向经模块 public 出口消费。
 */
import type { JsonValue } from "@excel/json-value";
import { BadRequestError } from "../../../../kernel/http/errors";

/** 画布宽 */
export const PIXEL_CANVAS_W = 24;
/** 画布高 */
export const PIXEL_CANVAS_H = 24;
/** 像素数据字节数（24×24×3 RGB） */
export const PIXEL_DATA_LEN = PIXEL_CANVAS_W * PIXEL_CANVAS_H * 3;

/** 空白像素 RGB（透明/背景） */
export const PIXEL_EMPTY: readonly [number, number, number] = [255, 255, 255];

/**
 * 官服 40 色调色板（display_meta_table.json → pixelMapData.paramMap.pixelMap1.htmlColors）
 * 服务端校验每个像素颜色必须在此白名单内（否则 400 "invalid pixel color"）。
 */
export const PIXEL_PALETTE: readonly string[] = [
  "#222222", "#b4b4b4", "#eae7df", "#ffffff", "#d32f36",
  "#9c0a00", "#d60c4a", "#e6968d", "#fe9875", "#f7d0c0",
  "#fcefea", "#fbf6e8", "#dcd2c8", "#e2ceab", "#d56322",
  "#d48c42", "#f29900", "#f9c933", "#fce499", "#b3b47a",
  "#c2da72", "#6c6e00", "#b19155", "#a98f74", "#aa9228",
  "#3f2b12", "#74491f", "#534658", "#2a2446", "#394599",
  "#5a459d", "#baa3d7", "#b6bcdf", "#a9acbe", "#63abb9",
  "#b4d2dc", "#91d8e6", "#47aea0", "#b6d3c8", "#273864",
];

/** 单像素对象形态（`{r,g,b}` 或 `{red,green,blue}`） */
export interface PixelColorObject {
  r?: number;
  g?: number;
  b?: number;
  red?: number;
  green?: number;
  blue?: number;
}

/**
 * 像素输入形态：原始字节（Buffer/Uint8Array）、JSON 域值（字符串 base64/hex、
 * 1728 长度的 number[]、576 长度的单像素对象数组，含 null/undefined 由校验函数拒绝）。
 */
export type PixelInput = JsonValue | Buffer | Uint8Array | undefined;

/**
 * 校验并归一化像素数据为 24×24×3 RGB Buffer
 *
 * 接受：
 *  - Buffer/Uint8Array（长度 1728，RGB 栅格）
 *  - number[]（长度 1728）
 *  - { r,g,b }[]（长度 576）或 { red,green,blue }[]
 *  - 字符串（base64 或 16 进制）
 * 非法输入抛 Error。
 *
 * @param input - 像素数据
 * @returns 1728 字节 RGB Buffer
 */
export function validatePixelData(input: PixelInput): Buffer {
  let buf: Buffer;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (input instanceof Uint8Array) {
    buf = Buffer.from(input);
  } else if (typeof input === "string") {
    // 兼容 base64 / hex 输入
    try {
      buf = Buffer.from(input, "base64");
      if (buf.length !== PIXEL_DATA_LEN) buf = Buffer.from(input, "hex");
    } catch {
      buf = Buffer.alloc(0);
    }
  } else if (Array.isArray(input)) {
    if (input.length === PIXEL_DATA_LEN) {
      buf = Buffer.from(input as number[]);
    } else if (input.length === PIXEL_CANVAS_W * PIXEL_CANVAS_H) {
      // 对象数组 {r,g,b}
      const arr = Buffer.alloc(PIXEL_DATA_LEN);
      input.forEach((px, i: number) => {
        const o = px as PixelColorObject;
        arr[i * 3] = o.r ?? o.red ?? PIXEL_EMPTY[0];
        arr[i * 3 + 1] = o.g ?? o.green ?? PIXEL_EMPTY[1];
        arr[i * 3 + 2] = o.b ?? o.blue ?? PIXEL_EMPTY[2];
      });
      buf = arr;
    } else {
      throw new BadRequestError(`像素数据长度非法：${input.length}（应为 ${PIXEL_DATA_LEN} 字节 RGB 或 ${PIXEL_CANVAS_W * PIXEL_CANVAS_H} 像素）`);
    }
  } else {
    throw new BadRequestError("像素数据格式不支持");
  }
  if (buf.length !== PIXEL_DATA_LEN) {
    throw new BadRequestError(`像素数据长度非法：${buf.length}（应为 ${PIXEL_DATA_LEN} 字节 = ${PIXEL_CANVAS_W}×${PIXEL_CANVAS_H}×3）`);
  }
  return buf;
}
