/**
 * 通用 multipart/form-data 极简解析（由 arkhub 活动域上移，供多域复用：savePixelArt/diy 杂志等）
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

