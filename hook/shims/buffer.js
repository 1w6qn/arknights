/**
 * Frida 运行时的极简 Buffer 替身。
 *
 * `frida-java-bridge` 的 lib/mkdex.js 在模块加载期就用 Node 的 `buffer`
 * （`Buffer.from/alloc/concat`）。Frida 的 QuickJS 运行时没有这个内建模块，
 * 而我们的用例（System.load 装载 gadget）不会走 dex 生成路径，
 * 所以只需一个形状正确的垫片即可让 bundle 通过。
 */
class Buffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === "string") {
      const bytes = [];
      for (let i = 0; i < value.length; i += 1) bytes.push(value.charCodeAt(i) & 0xff);
      return new Buffer(bytes);
    }
    if (value instanceof ArrayBuffer) return new Buffer(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return new Buffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    return new Buffer(value);
  }

  static alloc(size, fill) {
    const buf = new Buffer(size);
    if (fill !== undefined && fill !== 0) buf.fill(fill);
    return buf;
  }

  static concat(list) {
    let total = 0;
    for (const item of list) total += item.length;
    const out = new Buffer(total);
    let offset = 0;
    for (const item of list) {
      out.set(item, offset);
      offset += item.length;
    }
    return out;
  }

  static isBuffer(value) {
    return value instanceof Buffer;
  }

  copy(target, targetStart) {
    target.set(this, targetStart | 0);
    return this;
  }

  toString() {
    let text = "";
    for (let i = 0; i < this.length; i += 1) text += String.fromCharCode(this[i]);
    return text;
  }
}

export { Buffer };
export default { Buffer };
