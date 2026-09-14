/**
 * 在位(byte-level) Lua 插件注入器 —— 零结构风险的初始化方案（方案 B）
 *
 * 问题根因（已诊断）：客户端 2.7.61 的 Lua bundle `anon/6edf14bb….dat` 的 SerializedFile 采用
 *   enableTypeTree=true + 完整类型树 + AssetBundle(142) 容器（完整 require 路径 → pathId 映射），
 *   TextAsset 全量 CRYPTIC_A 加密、扁平裸名。旧的 packLuaBundle 生成「无容器 / 无类型树 / 无加密 /
 *   带前缀名」的简化 SerializedFile，导致客户端 CustomLoaders 无法按名解析 `entry.lua` → 注入失败。
 *
 * 本工具不重建 SF，而是**只改写一个已存在 TextAsset 的 m_Script 内容字节，并保持其加密后字节
 * 长度完全不变**。这样：
 *   - UnityFS 头 / 块信息 / SerializedFile 元数据 / 两条类型树 / 对象表 / AssetBundle 容器 /
 *     m_Name 全部字节级不变 → 客户端对 bundle 结构的一切校验都原样通过；
 *   - 唯一变化是该资产的内容（被替换为自包含插件引导代码），require/解析路径不受影响；
 *   - 通过 CRYPTIC_A 加密输出长度可调（AES-CBC + PKCS7，128B 头 + 16B IV），把明文 padding 到
 *     目标长度即可令密文长度 100% 等于原内容长度 → 无需重排对象表 / 类型树 / 容器。
 *
 * 默认注入目标 `TestStubHotfixer.lua`（官方首个 DefinedFix 热更入口，官方预留的空桩，仅实现
 * `HotfixTestStub_GenerateDevInfo`，替换它对游戏无副作用）。DefinedFix 仍列出
 * `"HotFixes/TestStubHotfixer"`，HotfixProcesser.Do 会在启动早期 require(v).new():Init()，
 * 于是执行到我们注入的 OnInit：写 `plugin_boot_trace.txt`（证明确实在客户端执行了注入代码）
 * 并尝试发 GET /plugin/heartbeat（私服日志打印 [PluginHeartbeat] = 插件生效确认）。
 *
 * 用法：
 *   pnpm run inject:lua            # 默认：官方 6edf14bb 源 → mods/anon_6edf14bb….dat
 *   pnpm run inject:lua -- --bundle <官方bundle.dat|.bin> --asset TestStubHotfixer --script <自定义.lua>
 *   --script  可选自定义注入 Lua（缺省用内置自包含引导）；必须为合法 HotfixBase hotfixer
 *   --out     输出 mods 目录（缺省 <项目根>/mods）
 *   --key     私钥 PEM（缺省 data/crypto/private.pem）——用于**重签名**
 *   --resign-all  把 bundle 内**所有** TextAsset 都用我们的私钥重签（客户端换成我们公钥时必须做）
 *
 * ★ 为什么要重签名：`m_Script = [128B RSA-1024/MD5 签名][16B IV^mask][AES 密文]`，
 *   签名覆盖 `script[128:]`；客户端每次加载 Lua 资产都用 `GlobalOptions.cryptoPubKey` 校验，
 *   失败会**直接 abort**（详见 docs/lua-asset-signature-2026-09-14.md）。因此：
 *   - 被改写的资产必须重签；
 *   - 客户端若使用我们的公钥，则**同 bundle 内每个资产**都必须是我们的签名（否则那些资产验签失败）。
 *   重签名不改长度（签名固定 128B），因此 SF 结构依旧零改动。
 */
import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";
import { lz4BlockDecompress, decompressLz4ak, lz4BlockCompress, compressLz4ak } from "./vendor/lz4";
import { encryptLuaScript, decryptLuaScript, signLuaScript } from "./vendor/lua-crypt";

/** 内置 Lua 主 bundle 名（zip 条目名 = 客户端资源名） */
const BUILTIN_BUNDLE_NAME = "anon/6edf14bbd79243eb61e288ff28e446c3.bin";
/** 客户端资源名 → 本地 .dat 文件名（目录分隔 / → _，扩展名 → .dat） */
function bundleToModName(bundleName: string): string {
  return bundleName.replace(/\//g, "_").replace(/#/g, "__").replace(/\.[^.]*$/, "") + ".dat";
}
/** zip 条目固定时间戳（内容不变时产物字节稳定） */
const LUA_ZIP_DATE = new Date("2024-01-01T00:00:00.000Z");

/* ------------------------- UnityFS / SerializedFile 解析 ------------------------- */

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function i64be(b: Uint8Array, o: number): number {
  return u32be(b, o) * 4294967296 + u32be(b, o + 4);
}
function i32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0;
}
function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function readI64(b: Uint8Array, o: number): bigint {
  return (BigInt(u32le(b, o + 4)) << 32n) | BigInt(u32le(b, o));
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

/** 读取 bundle 字节（.dat 取 zip 单条目，.bin 直读） */
async function readBundleBytes(file: string): Promise<Uint8Array> {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".dat") {
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const preferred = names.find((n) => n === BUILTIN_BUNDLE_NAME);
    const inner = await zip.files[preferred ?? names[0]].async("uint8array");
    return new Uint8Array(inner);
  }
  return new Uint8Array(fs.readFileSync(file));
}

/** UnityFS → SerializedFile(CAB) 字节与节点路径 */
export function unityfsToSF(uf: Uint8Array): { sf: Uint8Array; cabNodeName: string } {
  let off = 0;
  while (uf[off] !== 0) off++;
  off += 1;
  const version = u32be(uf, off);
  off += 4;
  while (uf[off] !== 0) off++;
  off += 1;
  while (uf[off] !== 0) off++;
  off += 1;
  const size = i64be(uf, off);
  off += 8;
  const cSize = u32be(uf, off);
  off += 4;
  const uSize = u32be(uf, off);
  off += 4;
  const flags = u32be(uf, off);
  off += 4;
  if (version >= 7) while (off % 16 !== 0) off++;
  const biBytes = flags & 0x80 ? uf.subarray(uf.length - cSize) : uf.subarray(off, off + cSize);
  const infoMode = flags & 0x3f;
  let bi: Uint8Array;
  if (infoMode === 0) bi = biBytes;
  else if (infoMode === 3 || infoMode === 2) bi = lz4BlockDecompress(biBytes, uSize);
  else if (infoMode === 4) bi = decompressLz4ak(biBytes, uSize);
  else throw new Error(`块信息压缩模式不支持: ${infoMode}`);
  let o = 16;
  const blockCount = u32be(bi, o);
  o += 4;
  const blocks: { u: number; c: number; mode: number }[] = [];
  for (let i = 0; i < blockCount; i++) {
    const u = u32be(bi, o);
    const c = u32be(bi, o + 4);
    const fl = (bi[o + 8] << 8) | bi[o + 9];
    o += 10;
    blocks.push({ u, c, mode: fl & 0x3f });
  }
  const nodeCount = u32be(bi, o);
  o += 4;
  const nodes: { offset: number; size: number; path: string }[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const no = i64be(bi, o);
    const ns = i64be(bi, o + 8);
    const nf = u32be(bi, o + 16);
    o += 20;
    const s = cstrLen(bi, o);
    o += s.len + 1;
    nodes.push({ offset: no, size: ns, path: s.s });
    void nf;
  }
  let dataOff = off + cSize;
  if (flags & 0x200) while (dataOff % 16 !== 0) dataOff++;
  let bstart = dataOff;
  const parts: Uint8Array[] = [];
  for (const b of blocks) {
    const raw = uf.subarray(bstart, bstart + b.c);
    bstart += b.c;
    if (b.mode === 0) parts.push(raw);
    else if (b.mode === 3 || b.mode === 2) parts.push(lz4BlockDecompress(raw, b.u));
    else if (b.mode === 4) parts.push(decompressLz4ak(raw, b.u));
    else throw new Error(`数据块压缩模式不支持: ${b.mode}`);
  }
  const cab = concatBytes(parts);
  const node = nodes[0];
  void size;
  return { sf: cab.subarray(node.offset, node.offset + node.size), cabNodeName: node.path };
}
function cstrLen(b: Uint8Array, o: number): { s: string; len: number } {
  let e = o;
  while (b[e] !== 0) e++;
  return { s: new TextDecoder().decode(b.subarray(o, e)), len: e - o };
}

/** 解析 SerializedFile → 对象表（pathId / 绝对 byteStart / 对象大小 / typeId） */
export function parseSFObjects(sf: Uint8Array): { classIds: number[]; objects: { pathId: bigint; start: number; size: number; typeId: number }[]; dataOffset: number; version: number; enableTypeTree: boolean } {
  let o = 0;
  const version = u32be(sf, 8);
  o += 16;
  o += 4; // endian + reserved
  let dataOffset = 0;
  if (version >= 22) {
    o += 4;
    o += 8;
    dataOffset = Number(i64be(sf, o)); // v22 扩展头为 64 位大端
    o += 8;
    o += 8;
  }
  while (sf[o] !== 0) o++;
  o += 1;
  o += 4; // targetPlatform
  const enableTypeTree = sf[o] !== 0;
  o += 1;
  const typeCount = i32le(sf, o);
  o += 4;
  const classIds: number[] = [];
  for (let i = 0; i < typeCount; i++) {
    const classId = i32le(sf, o);
    o += 4;
    classIds.push(classId);
    if (version >= 16) o += 1;
    if (version >= 17) o += 2;
    if (version >= 13) {
      if (version >= 16 ? classId === 114 : classId < 0) o += 16;
      o += 16;
    }
    if (enableTypeTree && version >= 12) {
      const n = i32le(sf, o);
      o += 4;
      const sb = i32le(sf, o);
      o += 4;
      o += 32 * n + sb;
    }
    if (version >= 21) {
      const dep = i32le(sf, o);
      o += 4;
      o += 4 * dep;
    }
  }
  if (version >= 7 && version < 14) o += 4;
  const objectCount = i32le(sf, o);
  o += 4;
  while (o % 4 !== 0) o++;
  const objects: { pathId: bigint; start: number; size: number; typeId: number }[] = [];
  for (let i = 0; i < objectCount; i++) {
    const pathId = readI64(sf, o);
    o += 8;
    const start = Number(readI64(sf, o)) + dataOffset;
    o += 8;
    const size = i32le(sf, o);
    o += 4;
    const typeId = i32le(sf, o);
    o += 4;
    objects.push({ pathId, start, size, typeId });
  }
  return { classIds, objects, dataOffset, version, enableTypeTree };
}

/** 从 TextAsset 对象数据读 m_Name */
function textAssetName(obj: Uint8Array): string {
  const len = i32le(obj, 0);
  return new TextDecoder().decode(obj.subarray(4, 4 + len));
}

/**
 * 在 TextAsset 对象内定位 m_Script 字节区（绝对 SF 偏移）。
 * TextAsset 布局：m_Name(AlignedString) → m_Script(Int32 长度 + 字节)。
 * @param sf  - SerializedFile 字节
 * @param objAbsStart - 对象在 SF 内的绝对起始偏移
 * @param objSize     - 对象大小
 * @returns 找到则返回 { scriptAbs, scriptLen, name }；否则 null
 */
export function locateScript(sf: Uint8Array, objAbsStart: number, objSize: number): { scriptAbs: number; scriptLen: number; name: string } | null {
  let p = objAbsStart;
  const end = objAbsStart + objSize;
  if (p + 4 > end) return null;
  const nameLen = i32le(sf, p);
  p += 4;
  if (p + nameLen > end) return null;
  const name = new TextDecoder().decode(sf.subarray(p, p + nameLen));
  p += nameLen;
  // m_Name 对齐 4（相对对象起点）
  while ((p - objAbsStart) % 4 !== 0 && p < end) p++;
  if (p + 4 > end) return null;
  const scriptLen = i32le(sf, p);
  p += 4;
  if (p + scriptLen > end) return null;
  return { scriptAbs: p, scriptLen, name };
}

/* ------------------------- 注入内容（内置自包含引导） ------------------------- */

/**
 * 生成内置自包含插件引导（Default）。是合法 HotfixBase hotfixer。
 *
 * 可观测性优先：`HotfixProcesser.Do` 发生在本 bundle 被 require 时（早于 ModelMgr/网络就绪），
 * 此时 `UISender.me` 通常还不存在，心跳发不出去；落盘 API 也可能不适用。因此引导的**首要证据**
 * 是走游戏自带 Lua 日志（`CS.Torappu.Lua.Util.LogHotfixError`）——frida 的 guest liblog 钩子
 * 与 logcat 都能看到 `[DoctorateTs]`。落盘 `plugin_boot_trace.txt` 作为次证据（best-effort）。
 * 明文预算受目标资产限制（TestStubHotfixer 密文 496B → 明文 ≤351B），故代码压到最简。
 * @returns 明文 Lua 源码
 */
export function buildDefaultBootstrap(): string {
  return [
    'local T=Class("T",HotfixBase)',
    "function T:OnInit()",
    "xpcall(function()",
    "local u=CS.Torappu.Lua.Util",
    'u.LogHotfixError("[DoctorateTs] boot OnInit")',
    'local p=CS.UnityEngine.Application.persistentDataPath.."/plugin_boot_trace.txt"',
    'CS.Torappu.FileUtil.WriteToFile("i",p,true)',
    "end,function()end)",
    "end",
    "return T",
    "",
  ].join("\n");
}

/**
 * 生成 robust 自包含引导（复刻之前成功心跳链路）。
 *
 * 目标：让 GET /plugin/heartbeat 在网络就绪后**可靠送达**服务端（[PluginHeartbeat]），
 * 而不只是引导时试一次。做法与旧成功版 PluginHeartbeat.ScheduleAuto 一致：
 *   1) 立即尝试一次（UISender 可能还没建，忽略失败）；
 *   2) xlua.hotfix 兜底挂 `CS.Torappu.Battle.UI.UIController.Awake` —— 战斗 UI Awake 必然晚于
 *      登录/网络/UISender 就绪，届时再发心跳（与旧版 UIController.Awake 兜底同源）；
 *   3) TimerModel.me 若可用，额外延时一次重试。
 * 全程 xpcall 兜底，绝不阻断游戏；引导时仍写 plugin_boot_trace.txt（确定性执行证明）。
 * 体积约 0.5KB，需在明文预算 ≥1KB 的资产（如 ArkventHotfixer）内使用。
 * @returns 明文 Lua 源码
 */
export function buildRobustBootstrap(): string {
  return [
    'local T=Class("T",HotfixBase)',
    "local function hb()",
    '  if UISender and UISender.me then UISender.me:SendGet("/plugin/heartbeat",nil,{useMask=false}) end',
    "end",
    "local function inst()",
    "  xpcall(function()",
    '    local p=CS.UnityEngine.Application.persistentDataPath.."/plugin_boot_trace.txt"',
    '    CS.Torappu.FileUtil.WriteToFile("ok\\n",p,true)',
    "  end,function()end)",
    "  xpcall(hb,function()end)",
    "  -- 兜底①：战斗 UI Awake（晚于网络/ UISender 就绪）再发一次",
    "  xpcall(function()",
    "    local C=CS.Torappu.Battle.UI.UIController",
    '    xlua.hotfix(C,"Awake",function(so)',
    "      local o=C.__Hotfix0_Awake",
    "      if o then o(so) end",
    "      xpcall(hb,function()end)",
    "    end)",
    "  end,function()end)",
    "  -- 兜底②：TimerModel 可用时 5s 后重试",
    "  xpcall(function()",
    "    local tm=TimerModel and TimerModel.me",
    "    if tm then",
    "      local cb=function() xpcall(hb,function()end) end",
    "      pcall(function() if Event~=nil and Event.CreateStatic~=nil then cb=Event.CreateStatic(cb) end end)",
    "      tm:Delay(5,cb)",
    "    end",
    "  end,function()end)",
    "end",
    "function T:OnInit()",
    "  inst()",
    "end",
    "return T",
    "",
  ].join("\n");
}

/**
 * 生成「网络拉取插件源码」引导（对应服务端 `GET /plugin/lua`）。
 *
 * 为什么不把插件源码直接内联进资产：Lua bundle 里最大的 TextAsset 明文只有约 33KB，
 * 而 `lua/plugin/*.lua` 合计约 60KB，一个资产装不下。于是资产里只放这段几百字节的引导：
 *   1) 立即尝试 `UISender.me:SendGet("/plugin/lua")`（此时 UISender 可能还没建）；
 *   2) `TimerModel` 就绪后每 3s 重试，至多 10 次；
 *   3) `Battle.UI.UIController.Awake` 兜底再试一次（必然晚于登录/网络就绪）。
 * 取回的 JSON 里 `lua` 字段是自包含 chunk（源码 + searcher + 引导），`load()` 执行即可；
 * 结果（含各插件启停自检）写入 `plugin_boot_trace.txt`。
 * @returns 明文 Lua 源码
 */
export function buildFetchBootstrap(): string {
  return [
    'local T=Class("T",HotfixBase)',
    "local DONE=false",
    "local ATT=0",
    "local APPLIED=false",
    "local function trace(m)",
    "  xpcall(function()",
    '    local p=CS.UnityEngine.Application.persistentDataPath.."/plugin_boot_trace.txt"',
    '    CS.Torappu.FileUtil.WriteToFile("[DTS] "..m,p,true)',
    "  end,function()end)",
    "end",
    "local function ready()",
    "  return UISender~=nil and UISender.me~=nil and UISender.me.SendGet~=nil",
    "end",
    "local function apply(raw)",
    "  local body=raw",
    "  -- 游戏网络层把响应包成 { text = <原始响应体> }（实测 keys=text:string）",
    '  if type(body)=="table" and type(body.text)=="string" then body=body.text end',
    '  if type(body)=="string" then',
    '    local ok,d=pcall(function() return require("rapidjson").decode(body) end)',
    "    if ok then body=d end",
    "  end",
    '  if type(body)~="table" then return false end',
    "  local function findLua(t,depth)",
    '    if type(t)~="table" or depth>3 then return nil end',
    '    if type(t.lua)=="string" then return t.lua end',
    "    for _,v in pairs(t) do",
    "      local r=findLua(v,depth+1)",
    "      if r~=nil then return r end",
    "    end",
    "    return nil",
    "  end",
    "  local chunk=findLua(body,0)",
    '  if type(chunk)~="string" then',
    "    local ks={}",
    "    for k,v in pairs(body) do ks[#ks+1]=tostring(k)..\":\"..type(v) end",
    '    trace("no lua; keys="..table.concat(ks,","))',
    "    return false",
    "  end",
    '  local fn=load(chunk,"@dts_http")',
    "  if fn==nil then return false end",
    "  local ok,res=pcall(fn)",
    '  trace("chunk "..(ok and "ok" or "err")..": "..tostring(res))',
    "  return ok",
    "end",
    "local function fetch()",
    "  if DONE or ATT>=20 then return end",
    "  if not ready() then return end",
    "  ATT=ATT+1",
    '  trace("fetch #"..ATT)',
    "  local h=function(data)",
    "    -- 回调在游戏 `UISender._HandleGetResponse` 里同步执行：这里绝不能抛异常，",
    "    -- 否则会变成未捕获的托管异常 → 进程 abort（实测）。同时只应用一次，避免重复装载。",
    "    local okc,resc=pcall(function()",
    '      trace("cb "..type(data))',
    "      if APPLIED then return end",
    "      local r=apply(data)",
    "      if r then APPLIED=true; DONE=true end",
    "    end)",
    '    if not okc then trace("cb err: "..tostring(resc)) end',
    "  end",
    "  local cb=h",
    "  pcall(function() if Event~=nil and Event.CreateStatic~=nil then cb=Event.CreateStatic(h) end end)",
    '  pcall(function() UISender.me:SendGet("/plugin/lua",nil,{onProceed=cb,useMask=false}) end)',
    "end",
    "function T:OnInit()",
    '  trace("init")',
    "  fetch()",
    "  pcall(function()",
    "    local G=CS.Torappu.GlobalInitializerAndUpdater",
    "    local orig=G.Update",
    "    local n=0",
    '    xlua.hotfix(G,"Update",function(...)',
    "      if orig~=nil then orig(...) end",
    "      n=n+1",
    "      if DONE then",
    '        xpcall(function() xlua.hotfix(G,"Update",orig) end,function()end)',
    "        return",
    "      end",
    "      if n%30==0 then fetch() end",
    "    end)",
    "  end)",
    "end",
    "return T",
    "",
  ].join("\n");
}

/**
 * 把明文内容 padding 到目标字节长度 P，使 encryptLuaScript 输出密文长度 == targetEncLen。
 * 目标关系：encLen = 144 + nextMultiple16(P)。调用方先由原密文长度反推 P 区间，本函数取区间内
 * 最大长度并填充 `-- 注释` 行（Lua 尾注释安全），保证实际明文长度恰好落在能复现 encLen 的集合。
 * @param plain  - 明文 Lua（含 return）
 * @param targetP - 目标明文字节长度
 * @returns 填充后的明文（UTF-8 ASCII，长度 == targetP）
 */
export function padTo(plain: string, targetP: number): string {
  let bytes = Buffer.byteLength(plain, "utf8");
  if (bytes > targetP) {
    throw new Error(`注入内容过长（${bytes}B）超过目标明文预算 ${targetP}B`);
  }
  const suffix = ["\n\n-- [[ plugin-inject padding ]]", "-- " + "-".repeat(60), "-- end padding"];
  const padLine = "-- " + " ".repeat(48);
  let out = plain;
  let cur = bytes;
  let i = 0;
  while (cur < targetP) {
    const line = suffix[i % suffix.length];
    i++;
    const extra = Buffer.byteLength(line, "utf8");
    if (cur + extra <= targetP) {
      out += line;
      cur += extra;
    } else {
      // 按需把长注释行截断为刚好补足的注释（仍是注释，语法安全）
      const need = targetP - cur;
      const sliced = "-- " + " ".repeat(Math.max(0, need - 3));
      out += sliced;
      cur = targetP;
      break;
    }
    if (i > 400) break; // 兜底防死循环
  }
  const final = Buffer.byteLength(out, "utf8");
  if (final !== targetP) {
    throw new Error(`padding 失败: 期望 ${targetP}B 实际 ${final}B`);
  }
  return out;
}

/** 由原密文长度 L 计算可用的明文长度集合上限与目标 P（取最大，留足空间） */
export function plainBudget(L: number): number {
  // encLen = 144 + nextMultiple16(P) = L  =>  P ∈ [L-160, L-145]（L>=160 时）
  return L - 145;
}

/* ------------------------- UnityFS 压缩重建（对齐官方 mode-4） ------------------------- */

/**
 * 重建 UnityFS wrapper：块信息 standard-LZ4(mode3) 压缩、数据块 LZ4AK(mode4) 压缩，
 * flags=0x243 —— 与官方 6edf14bb 完全一致的加载路径（客户端只认 LZ4-HK/mode4，mode0 会原生崩）。
 * @param sf - SerializedFile(CAB) 字节
 * @param cabName - CAB 节点名（保留官方的 CAB-<hash>）
 * @returns UnityFS bundle 字节
 */
export function buildUnityFSCompressed(sf: Uint8Array, cabName: string): Uint8Array {
  const unityVer = "5.x.x";
  const engine = "2021.3.39f1";
  const binaryLength = (s: string) => Buffer.byteLength(s, "utf8");
  const BLOCK = 131072; // 官方 128KiB 数据块
  // 1. 切分 CAB 并逐块 LZ4AK 压缩（mode 4）
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < sf.length; off += BLOCK) {
    chunks.push(sf.subarray(off, Math.min(off + BLOCK, sf.length)));
  }
  const comps = chunks.map((c) => compressLz4ak(c));
  // 2. 块信息明文体（大端）：hash + blockCount + (u,c,fl) + nodeCount + node
  const biParts: number[] = [];
  // 每个实参可以是单个字节值，也可以是字节序列（number[] / Uint8Array），逐个展开追加
  const push = (...arr: (number | Uint8Array | number[])[]) => {
    for (const a of arr) {
      if (typeof a === "number") biParts.push(a);
      else for (const b of a) biParts.push(b);
    }
  };
  const wBE = (n: number, width: number) => {
    const out = new Uint8Array(width);
    let x = n >>> 0;
    for (let i = width - 1; i >= 0; i--) {
      out[i] = x & 0xff;
      x = Math.floor(x / 256);
    }
    return Array.from(out);
  };
  push(new Uint8Array(16)); // hash 占位 16B
  push(wBE(chunks.length, 4)); // blockCount
  chunks.forEach((c, i) => {
    push(wBE(c.length, 4)); // uncompressed u
    push(wBE(comps[i].length, 4)); // compressed c
    push(wBE(4, 2)); // block flags mode=4（大端 u16）
  });
  push(wBE(1, 4)); // nodeCount
  push(wBE(0, 8)); // node offset
  push(wBE(sf.length, 8)); // node size
  push(wBE(4, 4)); // node flags
  for (const b of Buffer.from(cabName, "utf8")) biParts.push(b);
  biParts.push(0);
  const biBody = new Uint8Array(biParts);
  const cSizeBody = lz4BlockCompress(biBody);
  const cSize = cSizeBody.length;
  const uSize = biBody.length;
  const BLOCK_FLAGS = 0x243; // infoMode=3(块信息 LZ4) | 0x40 | 0x200(数据对齐)

  // 3. 头部
  let headerLen = 0;
  headerLen += binaryLength("UnityFS") + 1;
  headerLen += 4; // version
  headerLen += binaryLength(unityVer) + 1;
  headerLen += binaryLength(engine) + 1;
  headerLen += 8; // size
  headerLen += 4 + 4 + 4; // cSize,uSize,flags
  while (headerLen % 16 !== 0) headerLen++;
  // 数据块总长
  const dataTotal = comps.reduce((a, c) => a + c.length, 0);
  let dataOff = headerLen + cSize;
  while (dataOff % 16 !== 0) dataOff++;
  const totalSize = dataOff + dataTotal;

  const buf = Buffer.alloc(totalSize);
  let o = 0;
  buf.write("UnityFS", o), o += binaryLength("UnityFS") + 1;
  buf.writeUInt32BE(8, o); o += 4;
  buf.write(unityVer, o), o += binaryLength(unityVer) + 1;
  buf.write(engine, o), o += binaryLength(engine) + 1;
  buf.writeBigUInt64BE(BigInt(totalSize), o); o += 8;
  buf.writeUInt32BE(cSize, o); o += 4;
  buf.writeUInt32BE(uSize, o); o += 4;
  buf.writeUInt32BE(BLOCK_FLAGS, o); o += 4;
  while (o % 16 !== 0) o++;
  Buffer.from(cSizeBody).copy(buf, o); o += cSize; // 压缩块信息
  while (o % 16 !== 0) o++; // 0x200 数据对齐
  for (const c of comps) {
    Buffer.from(c).copy(buf, o);
    o += c.length;
  }
  if (o !== totalSize) throw new Error(`UnityFS 长度不匹配: ${o} vs ${totalSize}`);
  return new Uint8Array(buf);
}

/* ------------------------- 主流程 ------------------------- */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--bundle");
  const ai = args.indexOf("--asset");
  const si = args.indexOf("--script");
  const oi = args.indexOf("--out");
  const bsi = args.indexOf("--bootstrap");
  const bundleFile = path.resolve(bi >= 0 ? args[bi + 1] : "reference/hotupdate/downloads-min/anon_6edf14bbd79243eb61e288ff28e446c3.dat");
  const bootstrapMode = bsi >= 0 ? args[bsi + 1] : "robust";
  // robust（复刻成功心跳链路）默认落到明文预算更大的官方热修资产，避免写不下
  let assetWant = ai >= 0 ? args[ai + 1] : "";
  if (!assetWant) {
    // fetch/robust 引导体积较大（数百字节～1KB），落到明文预算更大的官方热修资产上
    assetWant = bootstrapMode === "default" ? "TestStubHotfixer" : "ArkventHotfixer";
  }
  const scriptFile = si >= 0 ? args[si + 1] : "";
  const outMods = path.resolve(oi >= 0 ? args[oi + 1] : path.join(__dirname, "..", "mods"));
  // 客户端资源名（zip 条目名）——须与 hot_update_list 里的 `anon/<hash>.bin` 同名，否则客户端拉不到
  const bni = args.indexOf("--bundle-name");
  const bundleName = bni >= 0 ? args[bni + 1] : BUILTIN_BUNDLE_NAME;

  console.log(`[inject] 源 bundle: ${bundleFile}`);
  const uf = await readBundleBytes(bundleFile);
  if (uf.length < 8 || String.fromCharCode(...uf.subarray(0, 7)) !== "UnityFS") {
    throw new Error("非 UnityFS bundle");
  }
  const { sf, cabNodeName } = unityfsToSF(uf);
  console.log(`[inject] SerializedFile: ${sf.length}B, CAB 节点=${cabNodeName}`);
  const meta = parseSFObjects(sf);

  // 找到目标 TextAsset 对象
  const taTypeIdx = meta.classIds.indexOf(49);
  if (taTypeIdx < 0) throw new Error("SerializedFile 中无 TextAsset(49) 类型");
  let target: { pathId: bigint; start: number; size: number } | null = null;
  for (const obj of meta.objects.filter((x) => x.typeId === taTypeIdx)) {
    const loc = locateScript(sf, obj.start, obj.size);
    if (loc && loc.name.includes(assetWant)) {
      target = obj;
      break;
    }
  }
  if (!target) throw new Error(`未找到资产 "${assetWant}"（名含该关键词的 TextAsset）`);
  const loc = locateScript(sf, target.start, target.size)!;
  const srcEnc = sf.slice(loc.scriptAbs, loc.scriptAbs + loc.scriptLen);
  console.log(`[inject] 目标: "${loc.name}" (pathId=${target.pathId}, objectStart=${target.start}, size=${target.size})`);
  console.log(`[inject] m_Script 原始密文 ${loc.scriptLen}B @ SF+${loc.scriptAbs}`);

  // 私钥（重签名用）：缺省 data/crypto/private.pem
  const reseignAll = args.indexOf("--resign-all") >= 0;
  const ki = args.indexOf("--key");
  const keyPath = path.resolve(ki >= 0 ? args[ki + 1] : path.join(__dirname, "..", "data", "crypto", "private.pem"));
  if (!fs.existsSync(keyPath)) {
    throw new Error(`找不到私钥 ${keyPath}：先执行 node scripts/sign-key.ts --gen（或加 --key <pem>）`);
  }
  const privateKeyPem = fs.readFileSync(keyPath, "utf8");
  console.log(`[inject] 重签名私钥: ${keyPath}${reseignAll ? "（将重签 bundle 内全部资产）" : ""}`);

  // 生成注入明文并 padding 到可复现同长密文的长度
  const basePlain = scriptFile
    ? fs.readFileSync(scriptFile, "utf8")
    : bootstrapMode === "fetch"
      ? buildFetchBootstrap()
      : bootstrapMode === "robust"
        ? buildRobustBootstrap()
        : buildDefaultBootstrap();
  // 目标明文长度：**保留原资产明文长度**，不要填充到预算上限。
  // 实测：客户端加载器对「明文长度 != 原值」的资产返回 null（官方 DefinedFix 明文 265B，
  // 我们填充到预算 271B 后 require 解析失败 → entry.lua 的 HotfixProcesser.Do 中断，插件永不加载）。
  // 密文长度由 cipher 决定：明文在 [L-160, L-145] 区间内都对应同一密文长度，故可与原文等长。
  const origPlainLen = Buffer.from(decryptLuaScript(srcEnc)).length;
  const targetP = Math.min(plainBudget(loc.scriptLen), origPlainLen);
  if (Buffer.byteLength(basePlain, "utf8") > targetP) {
    throw new Error(`注入内容 ${Buffer.byteLength(basePlain, "utf8")}B 超过该资产明文预算 ${targetP}B；换更大的目标资产或精简内容`);
  }
  const padded = padTo(basePlain, targetP);
  // 重加密：随机 IV（长度与原文一致），随后**用我们的私钥重签名**覆盖那 128B 头
  // （头就是签名，不是"随机数据"；保留旧头会让客户端验签失败并 abort，见文件头注释）。
  const newEnc = Buffer.from(
    signLuaScript(Buffer.from(encryptLuaScript(Buffer.from(padded, "utf8"))), privateKeyPem),
  );
  if (newEnc.length !== loc.scriptLen) {
    throw new Error(`重加密长度不符: 期望 ${loc.scriptLen}B 实际 ${newEnc.length}B`);
  }

  // 原位写回（仅 m_Script 字节区，长度不变 → 结构不动）
  const mutated = sf.slice();
  mutated.set(newEnc, loc.scriptAbs);
  console.log(`[inject] 已原位写回加密引导 ${newEnc.length}B（结构零改动，已重签名）`);

  // 可选：把 bundle 内**所有** TextAsset 用我们的私钥重签
  // （客户端换成我们公钥时，未重签的官方资产会验签失败 → abort）
  if (reseignAll) {
    let resigned = 0;
    let skipped = 0;
    for (const obj of meta.objects.filter((x) => x.typeId === taTypeIdx)) {
      if (obj.pathId === target.pathId) continue; // 目标资产已在上面签过
      const other = locateScript(sf, obj.start, obj.size);
      if (!other) {
        skipped += 1;
        continue;
      }
      const enc = sf.slice(other.scriptAbs, other.scriptAbs + other.scriptLen);
      try {
        const plain = Buffer.from(decryptLuaScript(enc));
        const reenc = Buffer.from(signLuaScript(Buffer.from(encryptLuaScript(plain)), privateKeyPem));
        if (reenc.length !== other.scriptLen) {
          skipped += 1;
          continue;
        }
        mutated.set(reenc, other.scriptAbs);
        resigned += 1;
      } catch (e) {
        skipped += 1; // 非加密/空资产：客户端不走验签路径，跳过
      }
    }
    console.log(`[inject] 全 bundle 重签名: ${resigned} 个已重签，${skipped} 个跳过（非加密或异常）`);
  }

  // 重建 UnityFS（官方 mode-4 压缩，客户端可加载）
  const newUf = buildUnityFSCompressed(mutated, cabNodeName);
  console.log(`[inject] UnityFS 重建: ${newUf.length}B`);

  // 打 .dat（zip 单条目）
  const zip = new JSZip();
  zip.file(bundleName, Buffer.from(newUf), { createFolders: false, date: LUA_ZIP_DATE });
  const dat = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.mkdirSync(outMods, { recursive: true });
  const datPath = path.join(outMods, bundleToModName(bundleName));
  fs.writeFileSync(datPath, Buffer.from(dat));
  console.log(`[inject] 已生成 mod: ${datPath} (${dat.length}B)`);

  // 离线回读校验：结构完整 + 目标资产内容 == 注入明文
  const checkUf = await readBundleBytes(datPath);
  const { sf: checkSF } = unityfsToSF(checkUf);
  const checkMeta = parseSFObjects(checkSF);
  const checkTAType = checkMeta.classIds.indexOf(49);
  const checkTextAssets = checkMeta.objects.filter((x) => x.typeId === checkTAType).length;
  const checkAB = checkMeta.classIds.indexOf(142) >= 0
    ? checkMeta.objects.filter((x) => x.typeId === checkMeta.classIds.indexOf(142)).length
    : 0;
  let targetOk = false;
  for (const obj of checkMeta.objects.filter((x) => x.typeId === checkTAType)) {
    const cl = locateScript(checkSF, obj.start, obj.size);
    if (cl && cl.name.includes(assetWant)) {
      const dec = Buffer.from(decryptLuaScript(checkSF.slice(cl.scriptAbs, cl.scriptAbs + cl.scriptLen)));
      targetOk = dec.toString("utf8").includes("plugin_boot_trace");
      console.log(`[verify] 目标资产回读密文 ${cl.scriptLen}B，解密明文 ${dec.length}B, 含引导标记=${targetOk}`);
      console.log("[verify] 注入明文首行:", dec.toString("utf8").split("\n").slice(-4).join(" … "));
    }
  }
  const abCount = checkMeta.objects.filter((x) => x.typeId === checkMeta.classIds.indexOf(142)).length;
  // 校验基准取**源 bundle 自身**的计数——不同客户端版本的 Lua bundle 资产数不同
  // （官方 anon/63bbacd2….bin 是 344，历史 6edf14bb 是 345），写死数字会让正确产物被判失败
  const srcTextAssets = meta.objects.filter((x) => x.typeId === taTypeIdx).length;
  const srcAbTypeIdx = meta.classIds.indexOf(142);
  const srcAbCount = srcAbTypeIdx >= 0 ? meta.objects.filter((x) => x.typeId === srcAbTypeIdx).length : 0;
  console.log(
    `[verify] 回读结构: TextAsset=${checkTextAssets}/${srcTextAssets} AssetBundle=${checkAB}/${srcAbCount}（应与源 bundle 一致）`,
  );
  if (checkTextAssets !== srcTextAssets || checkAB < srcAbCount || !targetOk) {
    throw new Error("离线回读校验失败：结构与内容未保持完整");
  }
  console.log("[inject] 校验通过。重启服务端加载该 mod，再完全退出并重启客户端即可验证 heartbeat。");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("注入失败:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}