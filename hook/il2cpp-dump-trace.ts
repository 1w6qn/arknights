import "./frida17-compat";
import "frida-il2cpp-bridge";

/*
 * il2cpp 元数据 dump + 定向方法 trace（MuMu/Houdini 下的 ARM64 gadget agent）。
 *
 * 为什么要分模式：dump 与 trace 都会长时间占用 agent 的 JS 线程。
 * Frida 的 Interceptor 回调在**被 hook 的那个线程**上执行，进 JS 前要抢 JS 运行时锁；
 * 若 dump（纯 JS 循环逐类取元数据）与 trace 同时进行，被 trace 的游戏线程会一直等锁，
 * 表现为游戏卡住甚至 ANR。故用 __DTS_MODE__ 把两者分开（构建时由
 * scripts/frida-mumu-arm64.py --script-mode <trace|dump|both> 注入）：
 *   dump  = 只落盘元数据（按 assembly 分文件，边 dump 边可见，可中途拉回）
 *   trace = 只挂定向 trace（抓启动 / Lua 加载调用链）
 *   both  = 先挂 trace，DUMP_DELAY_MS 之后再 dump（默认）
 *
 * 为什么不用桥自带的 Il2Cpp.dump()：它写 Il2Cpp.application.dataPath，
 * 而 Android 上那是 APK 路径（只读，必然失败）；这里直接用 libc 写应用私有目录
 * （/data/user/0/<pkg>/files/…），应用自己可写、adb(root) 可拉。
 */

/** 运行模式，由管线替换（未替换时按 both 处理）。 */
const MODE = "__DTS_MODE__";
/** dump 输出目录名（挂在应用私有 files/ 下）。 */
const DUMP_DIR_NAME = "dts-dump";
/** dump 写入缓冲（UTF-8）。4MB 足够容纳单个类的完整文本。 */
const WRITE_BUFFER_SIZE = 4 * 1024 * 1024;
/** both 模式下 dump 前的等待（ms）：先把启动/Lua 链的 trace 抓完。 */
const DUMP_DELAY_MS = 60000;
/** dump 模式下 dump 前的等待（ms）：等客户端把托管侧初始化跑完。 */
const DUMP_SETTLE_MS = 5000;
/** trace 是否带参数值（带参数信息更多，输出与开销也更大）。 */
const TRACE_PARAMS = false;
/** 不 trace 的逐帧方法（噪声大、且每秒都在跑）。 */
const SKIP_METHODS = /^(Update|LateUpdate|FixedUpdate)$/;
/**
 * 要 trace 的类（全名；名字取自 tmp/dts-dump 的元数据 dump）。
 * 找不到的会原样列进 traced 报告里，便于发现名字写错。
 */
const TRACE_CLASSES: string[] = [
  "Torappu.GlobalInitializerAndUpdater",
  "Torappu.Lua.LuaManager",
  "Torappu.Lua.LuaEntry",
  "Torappu.Lua.Util",
  "Torappu.Lua.PageEntry",
  "Torappu.Lua.StateEntry",
  "Torappu.VersionCompat",
  "Torappu.DB.CrypticConverter",
  "XLua.LuaEnv",
  "XLua.LuaTable",
];

/** 解析出的 libc 文件 IO 入口（拿不到就退化为「不 dump」并报告原因）。 */
let ioReady = false;
let buffer: NativePointer | null = null;
let fputsFn: NativeFunction<number, [NativePointer, NativePointer]> | null = null;
let fopenFn: NativeFunction<NativePointer, [NativePointer, NativePointer]> | null = null;
let fcloseFn: NativeFunction<number, [NativePointer]> | null = null;
let fflushFn: NativeFunction<number, [NativePointer]> | null = null;
let mkdirFn: NativeFunction<number, [NativePointer, number]> | null = null;
/** 报告过的错误（避免重复刷屏）。 */
const reported: { [key: string]: boolean } = {};

/**
 * 在全部已映射模块里找导出（Houdini 下 guest 的 libc 不在 x86_64 注册表里，
 * 只能走全局查找）。
 * @param name - 导出名
 * @returns 地址，找不到为 null
 */
function findGlobalExport(name: string): NativePointer | null {
  try {
    return Module.findGlobalExportByName(name);
  } catch (e) {
    return null;
  }
}

/**
 * 解析 libc 的 fopen/fputs/fclose/mkdir，并分配写入缓冲。
 * @returns 是否可用
 */
function setupIo(): boolean {
  const fopenPtr = findGlobalExport("fopen");
  const fputsPtr = findGlobalExport("fputs");
  const fclosePtr = findGlobalExport("fclose");
  const fflushPtr = findGlobalExport("fflush");
  const mkdirPtr = findGlobalExport("mkdir");
  if (
    fopenPtr === null ||
    fputsPtr === null ||
    fclosePtr === null ||
    fflushPtr === null ||
    mkdirPtr === null
  ) {
    send({
      t: "io-fail",
      fopen: fopenPtr !== null,
      fputs: fputsPtr !== null,
      fclose: fclosePtr !== null,
      fflush: fflushPtr !== null,
      mkdir: mkdirPtr !== null,
    });
    return false;
  }
  fopenFn = new NativeFunction(fopenPtr, "pointer", ["pointer", "pointer"]);
  fputsFn = new NativeFunction(fputsPtr, "int", ["pointer", "pointer"]);
  fcloseFn = new NativeFunction(fclosePtr, "int", ["pointer"]);
  fflushFn = new NativeFunction(fflushPtr, "int", ["pointer"]);
  mkdirFn = new NativeFunction(mkdirPtr, "int", ["pointer", "int"]);
  buffer = Memory.alloc(WRITE_BUFFER_SIZE);
  return true;
}

/**
 * 建目录（已存在不算错）。
 * @param path - 目录路径
 */
function makeDir(path: string): void {
  if (mkdirFn === null) return;
  mkdirFn(Memory.allocUtf8String(path), 0o755);
}

/**
 * 打开文件写（自带缓冲，返回 libc FILE*）。
 * @param path - 目标文件路径
 * @returns FILE*，失败为 null
 */
function openFile(path: string): NativePointer | null {
  const open = fopenFn;
  if (open === null) return null;
  const handle = open(Memory.allocUtf8String(path), Memory.allocUtf8String("w"));
  return handle.isNull() ? null : handle;
}

/**
 * 往已打开的 FILE* 写一段文本（超长会截断，防止越过缓冲）。
 * @param handle - FILE*
 * @param text - 内容
 */
function writeText(handle: NativePointer, text: string): void {
  const puts = fputsFn;
  const buf = buffer;
  if (puts === null || buf === null) return;
  let out = text;
  if (out.length > WRITE_BUFFER_SIZE - 128) {
    out = out.substring(0, WRITE_BUFFER_SIZE - 128) + "\n<truncated/>\n";
  }
  buf.writeUtf8String(out);
  puts(buf, handle);
}

/**
 * 关闭 FILE*。
 * @param handle - FILE*
 */
function closeFile(handle: NativePointer): void {
  const close = fcloseFn;
  if (close !== null) close(handle);
}

/**
 * 把 FILE* 的用户态缓冲刷进内核（dump 中途被打断时保住已写内容）。
 * @param handle - FILE*
 */
function flushFile(handle: NativePointer): void {
  const flush = fflushFn;
  if (flush !== null) flush(handle);
}

/**
 * 整段写文本到一个新文件（内部走 libc，不依赖 Frida 的 File API）。
 * @param path - 目标文件路径
 * @param text - 内容（UTF-8）
 * @returns 是否写成功
 */
function writeFile(path: string, text: string): boolean {
  const handle = openFile(path);
  if (handle === null) return false;
  writeText(handle, text);
  closeFile(handle);
  return true;
}

/**
 * 跨 assembly 按全名找类（找不到返回 null）。
 * @param fullName - 类的全名
 * @returns 类对象或 null
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

/**
 * 按 assembly 逐类流式 dump 成 `<assembly>.cs`（不整段攒内存：
 * 单个 assembly 的文本可能远超写入缓冲，攒起来会被截断）。
 * 逐 assembly 落盘 + 定期 fflush，中途打断也已有可用产物。
 * @param root - 输出目录
 * @returns 汇总信息
 */
function dumpAssemblies(root: string): { assemblies: number; classes: number; bytes: number } {
  makeDir(root);
  let assemblies = 0;
  let classes = 0;
  let bytes = 0;
  const index: string[] = [];
  for (const asm of Il2Cpp.domain.assemblies) {
    let name = "";
    try {
      name = asm.name;
    } catch (e) {
      continue;
    }
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
    const handle = openFile(`${root}/${safe}.cs`);
    if (handle === null) {
      index.push(`${name}\tOPEN_FAIL`);
      continue;
    }
    let count = 0;
    let written = 0;
    let failure = "";
    try {
      for (const klass of asm.image.classes) {
        try {
          const text = `${klass}\n\n`;
          writeText(handle, text);
          written += text.length;
          count += 1;
          if (count % 200 === 0) flushFile(handle);
        } catch (e) {
          failure = String(e);
        }
      }
    } catch (e) {
      failure = String(e);
    }
    flushFile(handle);
    closeFile(handle);
    assemblies += 1;
    classes += count;
    bytes += written;
    index.push(`${name}\t${count}\t${written}${failure === "" ? "" : "\tPARTIAL " + failure}`);
    send({ t: "dump-asm", asm: name, classes: count, bytes: written, err: failure });
  }
  writeFile(`${root}/_index.tsv`, "assembly\tclasses\tbytes\n" + index.join("\n") + "\n");
  return { assemblies: assemblies, classes: classes, bytes: bytes };
}

/**
 * 给 TRACE_CLASSES 里的每个类挂上 trace。
 * @returns 每个类的挂载结果（人类可读）
 */
function traceTargets(): string[] {
  const results: string[] = [];
  for (const name of TRACE_CLASSES) {
    const klass = findClass(name);
    if (klass === null) {
      results.push(`${name} → 未找到`);
      continue;
    }
    let methodCount = -1;
    try {
      methodCount = klass.methods.length;
    } catch (e) {
      methodCount = -1;
    }
    try {
      Il2Cpp.trace(TRACE_PARAMS)
        .classes(klass)
        .filterMethods((method) => !SKIP_METHODS.test(method.name))
        .and()
        .attach();
      results.push(`${name} → 已挂 (${methodCount} 方法)`);
    } catch (e) {
      results.push(`${name} → 失败: ${String(e)}`);
    }
  }
  return results;
}

/**
 * 报告若干关键方法的地址（供后续运行时 hook / 注入定位用）。
 * @param targets - `类全名#方法名` 列表
 */
function reportMethods(targets: string[]): void {
  const rows: string[] = [];
  for (const target of targets) {
    const hash = target.indexOf("#");
    const clsName = hash < 0 ? target : target.substring(0, hash);
    const methodName = hash < 0 ? "" : target.substring(hash + 1);
    const klass = findClass(clsName);
    if (klass === null) {
      rows.push(`${target}\tNOT_FOUND`);
      continue;
    }
    let hit = 0;
    try {
      for (const method of klass.methods) {
        if (method.name !== methodName) continue;
        hit += 1;
        let sig = "";
        try {
          sig = (method.isStatic ? "static " : "") + method.parameters.map((p) => p.type.name).join(",");
        } catch (e) {
          sig = "?";
        }
        const rva = method.relativeVirtualAddress;
        let params = "";
        try {
          params = method.parameterCount.toString();
        } catch (e) {
          params = "?";
        }
        rows.push(`${target}\t${method.isStatic ? "S" : "I"}\tparams=${params}\t${sig}\trva=${rva}\tva=${method.virtualAddress}`);
      }
    } catch (e) {
      rows.push(`${target}\tITER_FAIL ${String(e)}`);
    }
    if (hit === 0) rows.push(`${target}\tMETHOD_NOT_FOUND`);
  }
  send({ t: "methods", rows: rows });
}

/**
 * 从 Unity 的 persistentDataPath（`/storage/emulated/0/Android/data/<pkg>/files`）里抠包名：
 * 桥的 `Il2Cpp.application.identifier` 在这个 Unity/il2cpp 组合上返回 null，
 * 但 persistentDataPath 里带着包名。
 * @param dataPath - `Il2Cpp.application.dataPath`
 * @returns 包名，抠不到为空串
 */
function packageFromDataPath(dataPath: string): string {
  const matched = /\/Android\/data\/([^/]+)/.exec(dataPath);
  return matched === null ? "" : matched[1];
}

/**
 * 选一个真正可写的 dump 目录：应用私有目录优先（快、adb root 可拉），
 * 不可写则退回 Unity 的 persistentDataPath（外部私有目录）。
 * @param pkg - 包名（可为空）
 * @param dataPath - `Il2Cpp.application.dataPath`
 * @returns 可用目录，都不可写时为空串
 */
function pickDumpRoot(pkg: string, dataPath: string): string {
  const candidates: string[] = [];
  if (pkg.length > 0) candidates.push(`/data/user/0/${pkg}/files/${DUMP_DIR_NAME}`);
  if (dataPath.length > 0) candidates.push(`${dataPath}/${DUMP_DIR_NAME}`);
  for (const candidate of candidates) {
    makeDir(candidate);
    if (writeFile(`${candidate}/_probe`, "ok\n")) return candidate;
  }
  return "";
}

Il2Cpp.perform(() => {
  let identifier = "unknown";
  let dataPath = "";
  let unityVersion = "";
  let appVersion = "";
  try {
    identifier = Il2Cpp.application.identifier ?? "unknown";
  } catch (e) {
    /* 拿不到就用缺省名 */
  }
  try {
    dataPath = Il2Cpp.application.dataPath ?? "";
  } catch (e) {
    /* 同上 */
  }
  try {
    unityVersion = Il2Cpp.unityVersion ?? "";
  } catch (e) {
    /* 同上 */
  }
  try {
    appVersion = Il2Cpp.application.version ?? "";
  } catch (e) {
    /* 同上 */
  }
  const pkg = identifier === "unknown" ? packageFromDataPath(dataPath) : identifier;
  let moduleBase = "";
  let moduleSize = 0;
  try {
    moduleBase = Il2Cpp.module.base.toString();
    moduleSize = Il2Cpp.module.size;
  } catch (e) {
    /* 合成模块信息拿不到就留空 */
  }
  let assemblies = -1;
  try {
    assemblies = Il2Cpp.domain.assemblies.length;
  } catch (e) {
    /* 同上 */
  }
  send({
    t: "env",
    mode: MODE,
    id: identifier,
    pkg: pkg,
    ver: appVersion,
    unity: unityVersion,
    dataPath: dataPath,
    assemblies: assemblies,
    module: moduleBase,
    moduleSize: moduleSize,
  });

  if (MODE !== "dump") {
    send({ t: "traced", rows: traceTargets() });
    reportMethods([
      "Torappu.GlobalInitializerAndUpdater#Awake",
      "Torappu.GlobalInitializerAndUpdater#_LoadInitialAssetsImpl",
      "Torappu.Lua.LuaManager#InitIfNot",
      "Torappu.Lua.LuaManager#ReloadScripts",
      "Torappu.Lua.LuaManager#_DoLoadEntryScript",
      "Torappu.Lua.LuaManager#_CustomLoader",
      "Torappu.Lua.LuaManager#_InjectDefinesToLuaEnv",
      "XLua.LuaEnv#DoString",
      "Torappu.VersionCompat#get_CUR_FUNC_VER",
      "Torappu.VersionCompat#SetFuncVersion",
    ]);
  }

  if (MODE === "dump" || MODE === "both") {
    const delay = MODE === "dump" ? DUMP_SETTLE_MS : DUMP_DELAY_MS;
    setTimeout(() => {
      try {
        if (!setupIo()) {
          send({ t: "dump-fail", reason: "libc IO 解析失败" });
          return;
        }
        const root = pickDumpRoot(pkg, dataPath);
        if (root === "") {
          send({ t: "dump-fail", reason: "没有可写目录", pkg: pkg, dataPath: dataPath });
          return;
        }
        send({ t: "dump-start", root: root });
        const summary = dumpAssemblies(root);
        send({ t: "dump-done", ...summary, root: root });
      } catch (e) {
        send({ t: "dump-fail", reason: String(e) });
      }
    }, delay);
  }
}).catch((e: Error) => {
  if (!reported["perform"]) {
    reported["perform"] = true;
    send({ t: "il2cpp-fail", err: String(e), stack: e.stack });
  }
});
