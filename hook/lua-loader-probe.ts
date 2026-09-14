import "./frida17-compat";
import "frida-il2cpp-bridge";

/*
 * Lua 加载器探测：搞清「把插件文件直接放进 APK / 设备」能不能被 require 到。
 *
 * 为什么要它：`LuaManager._CustomLoader`（RVA 0x2C56DB0）在 Cpp2IL 里是
 * "failed to recover any usable IL"，也就是说它到底先探测哪个物理路径（APK 内
 * StreamingAssets 散装 `.lua`？持久化目录？还是只认 bundle）无法从反编译源码判断，
 * 只能实测。本脚本一次跑出两组事实：
 *
 *  1) libc 级路径日志：挂 `open`/`open64`/`fopen`/`fopen64`/`access`/`stat64`，
 *     只打印含 `.lua` / `assets` / `Bundles` / `anon` / `Plugin` 的路径
 *     —— 这是「加载器真正去读了哪个文件」的 ground truth。
 *  2) Lua 侧搜索器实况：注入一段只读查询，返回 `package.path` / searcher 数量 /
 *     `require` 不存在模块时的完整错误串（Lua 会把**每个 searcher 试过的路径**拼进错误里）
 *     —— 由此可知有没有「文件系统 searcher」以及它找哪几个目录。
 *
 * 两者结合即可判断：直接把 `.lua` 放进 APK 的哪个条目（或设备的哪个目录）能被加载。
 */

/** 只关心与 Lua/资产有关的路径，避免刷屏。 */
const PATH_RE = /\.lua|assets|Bundles|anon|Plugin/;
/** 路径日志条数上限。 */
const MAX_LOGGED = 400;
/** libc 钩子调用总数上限（超过就静默，避免热路径拖慢游戏）。 */
const MAX_CALLS = 600000;
/** 探测查询的执行时机门禁（与注入插件一致：entry 脚本跑完后在 Update 里查询）。 */
const FALLBACK_FRAMES = 900;

let logged = 0;
let calls = 0;
let probesDone = false;
let updateFrames = 0;
let entryScriptDone = false;
/** 已挂钩子的 libc 函数名 */
const hookedFns: string[] = [];

/**
 * 安全读 C 字符串（截断到 400 字节）。
 * @param ptr - 指针
 * @returns 字符串或 null
 */
function readCString(ptr: NativePointer): string | null {
  try {
    if (ptr.isNull()) return null;
    return ptr.readUtf8String(400);
  } catch (e) {
    return null;
  }
}

/**
 * 挂一个 libc 路径函数，只上报命中 PATH_RE 的路径。
 * @param name - 导出名
 * @returns 是否挂上
 */
function hookPathFn(name: string): boolean {
  let addr: NativePointer | null = null;
  try {
    addr = Module.findGlobalExportByName(name);
  } catch (e) {
    addr = null;
  }
  if (addr === null) return false;
  try {
    Interceptor.attach(addr, {
      onEnter(args) {
        calls += 1;
        if (logged >= MAX_LOGGED || calls > MAX_CALLS) return;
        const path = readCString(args[0]);
        if (path === null || !PATH_RE.test(path)) return;
        logged += 1;
        send({ t: "path", fn: name, path: path });
      },
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 只读查询 chunk：返回 package.path / searcher 概况 / require 失败的完整搜索路径。
 * @returns Lua 源码
 */
function buildProbeChunk(): string {
  return [
    "local out = {}",
    'out[#out + 1] = "path=" .. tostring(package.path)',
    'out[#out + 1] = "cpath=" .. tostring(package.cpath)',
    "local searchers = package.searchers or package.loaders",
    'out[#out + 1] = "searchers=" .. tostring(searchers and #searchers or -1)',
    'out[#out + 1] = "loadfile=" .. tostring(type(loadfile))',
    'out[#out + 1] = "io=" .. tostring(type(io))',
    'out[#out + 1] = "os=" .. tostring(type(os))',
    'pcall(function() out[#out + 1] = "pwd=" .. tostring(os.getenv("PWD")) end)',
    'local ok, err = pcall(require, "DoctorateTsNoSuchModule")',
    'out[#out + 1] = "requireErr=" .. tostring(err)',
    'return table.concat(out, " || ")',
  ].join("\n");
}

/**
 * 在游戏主线程上执行探测查询，把返回字符串发回宿主机。
 * @param manager - LuaManager 实例指针
 */
function runProbe(manager: NativePointer): void {
  try {
    const env = new Il2Cpp.Object(manager).field("m_env").value as Il2Cpp.Object;
    if (env.isNull()) return;
    const chunk = buildProbeChunk();
    const result = env
      .method("DoString")
      .overload("System.String", "System.String", "XLua.LuaTable")
      .invoke(Il2Cpp.string(chunk), Il2Cpp.string("dts_probe"), NULL);
    const handle = (result as Il2Cpp.Array).handle;
    const count = handle.add(0x18).readS32();
    const text = count > 0 ? readCString(handle.add(0x20).readPointer()) : null;
    probesDone = true;
    send({ t: "lua-probe", retCount: count, text: text });
  } catch (e) {
    send({ t: "lua-probe-fail", err: String(e) });
  }
}

/**
 * 找类（跨 assembly 全名查找）。
 * @param fullName - 类全名
 * @returns 类或 null
 */
function findClass(fullName: string): Il2Cpp.Class | null {
  for (const asm of Il2Cpp.domain.assemblies) {
    let found: Il2Cpp.Class | null = null;
    try {
      found = asm.image.tryClass(fullName);
    } catch (e) {
      found = null;
    }
    if (found !== null) return found;
  }
  return null;
}

Il2Cpp.perform(() => {
  hookedFns.push("open", "open64", "fopen", "fopen64", "access", "stat64", "faccessat");
  const installed = hookedFns.filter((name) => hookPathFn(name));
  send({ t: "path-hooks", installed: installed, missing: hookedFns.filter((n) => installed.indexOf(n) < 0) });

  const luaMgr = findClass("Torappu.Lua.LuaManager");
  if (luaMgr === null) {
    send({ t: "probe-fail", err: "LuaManager 未找到" });
    return;
  }
  const hooks: string[] = [];
  for (const method of luaMgr.methods) {
    if (method.name === "_DoLoadEntryScript") {
      try {
        Interceptor.attach(method.virtualAddress, {
          onLeave() {
            entryScriptDone = true;
            send({ t: "entry-script-done", frames: updateFrames });
          },
        });
        hooks.push("_DoLoadEntryScript");
      } catch (e) {
        hooks.push("_DoLoadEntryScript(fail:" + e + ")");
      }
    }
    if (method.name === "_DoUpdate") {
      try {
        Interceptor.attach(method.virtualAddress, {
          onEnter(args) {
            updateFrames += 1;
            if (probesDone) return;
            if (!entryScriptDone && updateFrames < FALLBACK_FRAMES) return;
            runProbe(args[0]);
          },
        });
        hooks.push("_DoUpdate");
      } catch (e) {
        hooks.push("_DoUpdate(fail:" + e + ")");
      }
    }
  }
  send({ t: "hooks", lua: hooks });
}).catch((e: Error) => send({ t: "il2cpp-fail", err: String(e), stack: e.stack }));

setInterval(() => {
  send({ t: "stats", calls: calls, logged: logged, probesDone: probesDone });
}, 10000);
