/**
 * DEX 字节级工具守卫（`scripts/lib/dex.ts` + `scripts/lib/apk-io.ts`）
 *
 * 覆盖 `pnpm run apk:dex-mtp` 的核心：合成一个最小 DEX 夹具（1 个类 / 4 个方法，
 * 覆盖 void / int / wide 返回、native 无方法体、`registers_size=0` 三个分支），
 * 逐项验证「解析 → 置空 → 头部重算 → 结构零位移」。
 *
 * 另用 JSZip 造一个只含 `classes.dex` 的假 APK，验证 apk-io 的条目列表/读取路径。
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { listZipEntries, readZipEntry, readZipEntries } from "../../../scripts/lib/apk-io";
import {
  blankMethods,
  firstInsnAt,
  fixDexHeader,
  listClasses,
  toClassDescriptor,
  toClassName,
  verifyDex,
} from "../../../scripts/lib/dex";

/** uleb128 编码 */
function uleb(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

/** 4 字节对齐 */
function align4(n: number): number {
  return (n + 3) & ~3;
}

/** 构造 code_item（无 try/catch） */
function codeItem(registers: number, insSize: number, insns: number[]): Buffer {
  const buf = Buffer.alloc(16 + insns.length * 2);
  buf.writeUInt16LE(registers, 0);
  buf.writeUInt16LE(insSize, 2);
  buf.writeUInt32LE(insns.length, 12);
  insns.forEach((w, i) => buf.writeUInt16LE(w, 16 + i * 2));
  return buf;
}

/** DEX 夹具里使用的字符串池 */
const STRINGS = [
  "Lcom/hg/sdk/MTPDetection;", // 0
  "Ljava/lang/Object;", // 1
  "V", // 2
  "onUserLogin", // 3
  "I", // 4
  "ping", // 5
  "nativeProbe", // 6
  "MTPDetection.java", // 7
  "J", // 8
  "now", // 9
  "VI", // 10（shorty of (I)V）
];
/** type_ids → string_ids 下标（Lcom/hg/sdk/MTPDetection; / Object / V / I / J） */
const TYPES = [0, 1, 2, 4, 8];
/** proto_ids：[shorty_idx, return_type_idx, parameters_off]（()V / ()I / ()J / (I)V） */
const PROTOS: [number, number, number][] = [
  [2, 2, 0],
  [4, 3, 0],
  [8, 4, 0],
  [10, 2, 0], // (I)V —— parameters_off 在布局时回填
];
/** 带参数的 proto 下标（onUserLogin 用它，覆盖 type_list 解析） */
const PROTO_WITH_PARAM = 3;
/** method_ids：[class_idx, proto_idx, name_idx] */
const METHODS: [number, number, number][] = [
  [0, 3, 3], // 0 onUserLogin(I)V
  [0, 0, 6], // 1 nativeProbe()V（native，无方法体）
  [0, 2, 9], // 2 now()J（registers_size=0，覆盖抬升分支）
  [0, 1, 5], // 3 ping()I
];
/** 方法体指令（下标 = method_ids 下标；null = 无方法体） */
const CODE_BODIES: (number[] | null)[] = [
  [0x0000, 0x0000, 0x0000, 0x000e], // onUserLogin：4 字
  null, // nativeProbe：native
  [0x0012, 0x000f, 0x0000], // now：3 字
  [0x0012, 0x000f], // ping：2 字
];
/** 各方法 registers_size / ins_size */
const METHOD_REGS: [number, number][] = [
  [1, 0],
  [0, 0],
  [0, 0],
  [1, 1],
];

/**
 * 构造最小 DEX 夹具：1 个类 `Lcom/hg/sdk/MTPDetection;`，
 * direct = {onUserLogin, nativeProbe, now}，virtual = {ping}（真实 dex 里 now 更可能是静态方法，
 * 这里把它放 direct 只为覆盖 `registers_size=0` 的抬升分支）。
 * 不生成 map 区（`map_off=0`）——本仓解析器不读 map，夹具仅服务自身解析/补丁路径。
 * @returns 含未修正头部的 dex 字节
 */
function buildFixtureDex(): Buffer {
  const stringData = STRINGS.map((s) => Buffer.concat([uleb(s.length), Buffer.from(s, "utf8"), Buffer.from([0])]));
  const fixedSize = 112 + STRINGS.length * 4 + TYPES.length * 4 + PROTOS.length * 12 + METHODS.length * 8 + 32;
  const dataStart = fixedSize;
  const stringDataOffs: number[] = [];
  let cursor = dataStart;
  for (const buf of stringData) {
    stringDataOffs.push(cursor);
    cursor += buf.length;
  }
  const codeOffs: number[] = [];
  const codeBufs: Buffer[] = [];
  cursor = align4(cursor);
  for (let i = 0; i < METHODS.length; i++) {
    const body = CODE_BODIES[i];
    if (!body) {
      codeOffs.push(0);
      continue;
    }
    const [regs, ins] = METHOD_REGS[i];
    const buf = codeItem(regs, ins, body);
    codeOffs.push(cursor);
    codeBufs.push(buf);
    cursor += buf.length;
  }
  const classDataOff = align4(cursor);
  // class_data_item：static=0 / instance=0 / direct=3 / virtual=1
  const classData = Buffer.concat([
    uleb(0),
    uleb(0),
    uleb(3),
    uleb(1),
    uleb(0),
    uleb(0x9),
    uleb(codeOffs[0]), // onUserLogin
    uleb(1),
    uleb(0x109),
    uleb(0), // nativeProbe
    uleb(1),
    uleb(0x9),
    uleb(codeOffs[2]), // now
    uleb(3), // ping（虚拟列表首元素：method_idx_diff 直接给绝对下标）
    uleb(0x1),
    uleb(codeOffs[3]), // ping
  ]);
  const typeListOff = align4(classDataOff + classData.length);
  const dex = Buffer.alloc(typeListOff + 6);
  const dataSize = typeListOff + 6 - dataStart;
  dex.write("dex\n035\0", 0, "latin1");
  dex.writeUInt32LE(dex.length, 32);
  dex.writeUInt32LE(112, 36);
  dex.writeUInt32LE(0x12345678, 40);
  dex.writeUInt32LE(0, 44);
  dex.writeUInt32LE(0, 48);
  dex.writeUInt32LE(0, 52); // map_off（夹具不生成 map）
  dex.writeUInt32LE(STRINGS.length, 56);
  dex.writeUInt32LE(112, 60);
  dex.writeUInt32LE(TYPES.length, 64);
  dex.writeUInt32LE(112 + STRINGS.length * 4, 68);
  dex.writeUInt32LE(PROTOS.length, 72);
  dex.writeUInt32LE(112 + STRINGS.length * 4 + TYPES.length * 4, 76);
  dex.writeUInt32LE(0, 80);
  dex.writeUInt32LE(0, 84);
  dex.writeUInt32LE(METHODS.length, 88);
  dex.writeUInt32LE(112 + STRINGS.length * 4 + TYPES.length * 4 + PROTOS.length * 12, 92);
  dex.writeUInt32LE(1, 96);
  dex.writeUInt32LE(112 + STRINGS.length * 4 + TYPES.length * 4 + PROTOS.length * 12 + METHODS.length * 8, 100);
  dex.writeUInt32LE(dataSize, 104);
  dex.writeUInt32LE(dataStart, 108);
  stringDataOffs.forEach((off, i) => dex.writeUInt32LE(off, 112 + i * 4));
  TYPES.forEach((stringIdx, i) => dex.writeUInt32LE(stringIdx, 112 + STRINGS.length * 4 + i * 4));
  const protoOff = 112 + STRINGS.length * 4 + TYPES.length * 4;
  PROTOS.forEach(([shorty, ret, params], i) => {
    dex.writeUInt32LE(shorty, protoOff + i * 12);
    dex.writeUInt32LE(ret, protoOff + i * 12 + 4);
    dex.writeUInt32LE(i === PROTO_WITH_PARAM ? typeListOff : params, protoOff + i * 12 + 8);
  });
  const methodOff = protoOff + PROTOS.length * 12;
  METHODS.forEach(([cls, proto, name], i) => {
    dex.writeUInt16LE(cls, methodOff + i * 8);
    dex.writeUInt16LE(proto, methodOff + i * 8 + 2);
    dex.writeUInt32LE(name, methodOff + i * 8 + 4);
  });
  const classDefOff = methodOff + METHODS.length * 8;
  dex.writeUInt32LE(0, classDefOff); // class_idx
  dex.writeUInt32LE(0x1, classDefOff + 4); // access_flags
  dex.writeUInt32LE(1, classDefOff + 8); // superclass_idx
  dex.writeUInt32LE(0, classDefOff + 12); // interfaces_off
  dex.writeUInt32LE(7, classDefOff + 16); // source_file_idx
  dex.writeUInt32LE(0, classDefOff + 20); // annotations_off
  dex.writeUInt32LE(classDataOff, classDefOff + 24);
  dex.writeUInt32LE(0, classDefOff + 28); // static_values_off
  let at = dataStart;
  for (const buf of stringData) {
    buf.copy(dex, at);
    at += buf.length;
  }
  // 代码区按 codeOffs 写入（native 方法无 code_item，跳过）
  let ci = 0;
  for (let i = 0; i < METHODS.length; i++) {
    if (!CODE_BODIES[i]) continue;
    codeBufs[ci].copy(dex, codeOffs[i]);
    ci++;
  }
  classData.copy(dex, classDataOff);
  // type_list：u32 size + u16 type_idx[]（(I)V 的入参 I = type_ids[3]）
  dex.writeUInt32LE(1, typeListOff);
  dex.writeUInt16LE(3, typeListOff + 4);
  return dex;
}

describe("DEX 解析（scripts/lib/dex.ts）", () => {
  it("解析类/方法表：描述符、返回类型、registers/insns、native 无方法体", () => {
    const dex = buildFixtureDex();
    const classes = listClasses(dex);
    expect(classes).toHaveLength(1);
    expect(classes[0].descriptor).toBe("Lcom/hg/sdk/MTPDetection;");
    expect(toClassName(classes[0].descriptor)).toBe("com.hg.sdk.MTPDetection");
    const methods = classes[0].methods;
    expect(methods.map((m) => `${m.name}(${m.parameters.join("")})${m.returnType}`)).toEqual([
      "onUserLogin(I)V",
      "nativeProbe()V",
      "now()J",
      "ping()I",
    ]);
    expect(methods[0].parameters).toEqual(["I"]);
    expect(methods[0].isDirect).toBe(true);
    expect(methods[0].insnsSize).toBe(4);
    expect(methods[0].registersSize).toBe(1);
    expect(methods[1].codeOff).toBe(0);
    expect(methods[2].isDirect).toBe(true); // 夹具把 now 放 direct（覆盖 registers_size=0 分支）
    expect(methods[2].returnType).toBe("J");
    expect(methods[3].isDirect).toBe(false);
    expect(methods[3].insSize).toBe(1);
  });

  it("头部自洽：未修正时报 checksum/signature 不符，fixDexHeader 后通过", () => {
    const dex = buildFixtureDex();
    const before = verifyDex(dex);
    expect(before.length).toBeGreaterThan(0);
    expect(before.join("\n")).toMatch(/checksum/);
    fixDexHeader(dex);
    expect(verifyDex(dex)).toEqual([]);
  });

  it("置空 void 方法：首指令 return-void，余下字数补 nop，长度与结构不变", () => {
    const dex = buildFixtureDex();
    const original = Buffer.from(dex);
    const bodyOff = listClasses(dex)[0].methods[0].codeOff;
    const report = blankMethods(dex, [{ className: "com.hg.sdk.MTPDetection", methodName: "onUserLogin" }]);
    expect(report.missing).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.patched).toHaveLength(1);
    expect(report.patched[0].firstInsn).toBe(0x000e);
    expect(firstInsnAt(dex, bodyOff)).toBe(0x000e);
    for (let i = 1; i < 4; i++) expect(dex.readUInt16LE(bodyOff + 16 + i * 2)).toBe(0x0000);
    fixDexHeader(dex);
    expect(verifyDex(dex)).toEqual([]);
    expect(dex.length).toBe(original.length);
    // 只允许 code_item 指令区与头部两个区间发生变化
    const allowed = (i: number): boolean => (i >= 8 && i < 32) || (i >= bodyOff + 16 && i < bodyOff + 16 + 8);
    const changed = [...original.keys()].filter((i) => original[i] !== dex[i]);
    expect(changed.filter((i) => !allowed(i))).toEqual([]);
  });

  it("置空非 void 方法：const/4 v0,#0 + return v0（int）", () => {
    const dex = buildFixtureDex();
    const ping = listClasses(dex)[0].methods[3];
    const report = blankMethods(dex, [{ className: "Lcom/hg/sdk/MTPDetection;", methodName: "ping" }]);
    expect(report.patched).toHaveLength(1);
    expect(report.patched[0].registersBumped).toBe(false);
    expect(firstInsnAt(dex, ping.codeOff)).toBe(0x0012);
    expect(dex.readUInt16LE(ping.codeOff + 18)).toBe(0x000f);
  });

  it("置空 wide 方法：registers_size 0→1 就地抬升 + const-wide/16 + return-wide", () => {
    const dex = buildFixtureDex();
    const now = listClasses(dex)[0].methods[2];
    expect(now.registersSize).toBe(0);
    const report = blankMethods(dex, [{ className: "com.hg.sdk.MTPDetection", methodName: "now" }]);
    expect(report.patched).toHaveLength(1);
    expect(report.patched[0].registersBumped).toBe(true);
    expect(dex.readUInt16LE(now.codeOff)).toBe(1);
    expect(firstInsnAt(dex, now.codeOff)).toBe(0x0013);
    expect(dex.readUInt16LE(now.codeOff + 18)).toBe(0x0000);
    expect(dex.readUInt16LE(now.codeOff + 20)).toBe(0x0010);
  });

  it("native 方法计入 skipped，未知类/方法计入 missing", () => {
    const dex = buildFixtureDex();
    const skipped = blankMethods(dex, [{ className: "com.hg.sdk.MTPDetection", methodName: "nativeProbe" }]);
    expect(skipped.patched).toEqual([]);
    expect(skipped.skipped).toHaveLength(1);
    expect(skipped.missing).toEqual([]);
    const missing = blankMethods(dex, [{ className: "com.hg.sdk.NotHere", methodName: "onUserLogin" }]);
    expect(missing.missing).toEqual(["Lcom/hg/sdk/NotHere;#onUserLogin"]);
  });

  it("类名规整：点号 / 斜杠 / 描述符三种写法等价", () => {
    expect(toClassDescriptor("com.hg.sdk.MTPDetection")).toBe("Lcom/hg/sdk/MTPDetection;");
    expect(toClassDescriptor("com/hg/sdk/MTPDetection")).toBe("Lcom/hg/sdk/MTPDetection;");
    expect(toClassDescriptor("Lcom/hg/sdk/MTPDetection;")).toBe("Lcom/hg/sdk/MTPDetection;");
  });
});

describe("APK 只读访问（scripts/lib/apk-io.ts）", () => {
  it("列出条目并取回 classes.dex 内容", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-fixture-"));
    try {
      const dex = buildFixtureDex();
      const zip = new JSZip();
      zip.file("classes.dex", dex);
      zip.file("classes2.dex", Buffer.from("not a dex"));
      zip.file("assets/readme.txt", "hi");
      const apk = path.join(dir, "fake.apk");
      fs.writeFileSync(apk, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

      const entries = await listZipEntries(apk);
      expect(entries.map((e) => e.name).sort()).toEqual(["assets/readme.txt", "classes.dex", "classes2.dex"]);

      const one = await readZipEntry(apk, "classes.dex");
      expect(one.equals(dex)).toBe(true);

      const many = await readZipEntries(apk, ["classes.dex", "classes2.dex", "missing.dex"]);
      expect([...many.keys()].sort()).toEqual(["classes.dex", "classes2.dex"]);
      expect(many.get("classes2.dex")?.toString()).toBe("not a dex");

      await expect(readZipEntry(apk, "nope.dex")).rejects.toThrow(/没有条目/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
