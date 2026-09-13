import "./frida17-compat";
import "frida-il2cpp-bridge";

/*
 * 详细 Unity 日志：在 arm64 gadget agent 里同时挂两层日志源。
 *
 *  A) 原生层：ARM guest libc 的 __android_log_print / __android_log_write
 *     —— Unity 引擎日志、xLua、HGSDK(HG_*) 都从这里出。
 *  B) 托管层：UnityEngine.DebugLogHandler.Internal_Log / Internal_LogException
 *     —— 拿到 Debug.Log* 的原文与调用类型；顺便把日志开关与堆栈级别拉满。
 *
 * 消息格式：{t:"log", src:"native"|"managed", tag/type, text}
 */

const stats = { native: 0, managed: 0, exception: 0 };
let verbose = true;

function isNull(p: NativePointer): boolean {
  return p.isNull();
}

/** 安全读 C 字符串。 */
function cstr(p: NativePointer): string {
  try {
    if (isNull(p)) return "<null>";
    return p.readCString() ?? "<unreadable>";
  } catch (e) {
    return "<unreadable>";
  }
}

// ---------- A) 原生日志 ----------
/**
 * 扫所有已加载模块找导出（ARM guest 环境里 __android_log_* 在 liblog.so，
 * 不在 libc；这里不写死模块名，按「谁有导出就挂谁」处理，并按地址去重）。
 */
function findAllExports(name: string): NativePointer[] {
  const seen: string[] = [];
  const out: NativePointer[] = [];
  for (const mod of Process.enumerateModules()) {
    let addr: NativePointer | null = null;
    try {
      addr = mod.findExportByName(name);
    } catch (e) {
      addr = null;
    }
    if (addr === null) continue;
    const key = addr.toString();
    if (seen.indexOf(key) >= 0) continue;
    seen.push(key);
    out.push(addr);
  }
  return out;
}

function hookNativeLogs(): string[] {
  const installed: string[] = [];

  // __android_log_write(int prio, const char* tag, const char* text)
  for (const addr of findAllExports("__android_log_write")) {
    Interceptor.attach(addr, {
      onEnter(args) {
        stats.native += 1;
        send({ t: "log", src: "native", fn: "log_write", prio: args[0].toInt32(), tag: cstr(args[1]), text: cstr(args[2]) });
      },
    });
    installed.push("__android_log_write@" + addr.toString());
  }

  // __android_log_print(int prio, const char* tag, const char* fmt, ...)
  for (const addr of findAllExports("__android_log_print")) {
    Interceptor.attach(addr, {
      onEnter(args) {
        stats.native += 1;
        const fmt = cstr(args[2]);
        // 单占位符的常见情形：把第一个可变参数解出来，其余保持 fmt 原文
        let extra: string | null = null;
        const first = fmt.indexOf("%");
        if (first >= 0 && fmt.indexOf("%", first + 1) < 0) {
          if (fmt.indexOf("%s") >= 0) extra = cstr(args[3]);
          else if (fmt.indexOf("%d") >= 0 || fmt.indexOf("%u") >= 0) extra = String(args[3].toInt32());
        }
        send({ t: "log", src: "native", fn: "log_print", prio: args[0].toInt32(), tag: cstr(args[1]),
               text: extra === null ? fmt : fmt.replace(/%[sdu]/, extra) });
      },
    });
    installed.push("__android_log_print@" + addr.toString());
  }

  return installed;
}

// ---------- B) 托管日志 ----------
function findClass(fullName: string): Il2Cpp.Class | null {
  for (const asm of Il2Cpp.domain.assemblies) {
    let image: Il2Cpp.Image | null = null;
    try {
      image = asm.image;
    } catch (e) {
      continue;
    }
    if (image === null) continue;
    try {
      const klass = image.tryClass(fullName);
      if (klass !== null) return klass;
    } catch (e) {
      /* keep looking */
    }
  }
  return null;
}

const LOG_TYPES = ["Error", "Assert", "Warning", "Log", "Exception"];

/** Debug/Logger 的日志入口方法名。 */
const LOG_ENTRY_NAMES = ["Log", "LogWarning", "LogError", "LogException", "LogAssertion", "LogFormat"];

/** 把托管对象（通常是 System.String）转成文本。 */
function objText(value: NativePointer): string {
  if (isNull(value)) return "<null>";
  try {
    const content = new Il2Cpp.String(value).content;
    if (content !== null) return content;
  } catch (e) {
    /* 不是字符串，走 ToString */
  }
  try {
    const text = new Il2Cpp.Object(value).method("ToString").invoke();
    return typeof text === "string" ? text : String(text);
  } catch (e) {
    return "<unreadable: " + e + ">";
  }
}

/**
 * 挂托管日志入口：UnityEngine.Debug（静态）/ UnityEngine.Logger（实例）。
 *
 * 为什么不能只挂 DebugLogHandler.Internal_Log：本项目客户端把 Unity 的 logHandler 换掉了，
 * Debug.Log 不再走默认 handler，Internal_Log 永远不触发。
 */
function hookLogEntryPoints(klass: Il2Cpp.Class, label: string): string[] {
  const installed: string[] = [];
  const seen: string[] = [];
  for (const method of klass.methods) {
    if (LOG_ENTRY_NAMES.indexOf(method.name) < 0) continue;
    try {
      // 消息参数下标：先跳过 this 与 LogType/LogOption 这类枚举，
      // 再取「第一个非字符串引用参数」（object/Exception）；*Format* 方法例外，
      // 取字符串参数（格式串）。兼容 "LogType" 与 "UnityEngine.LogType" 两种写法。
      const skip = method.isStatic ? 0 : 1;
      const params = method.parameters;
      const typeNames: string[] = [];
      const isFormat = method.name.indexOf("Format") >= 0;
      let firstString = -1;
      let firstPayload = -1;
      for (let i = 0; i < params.length; i += 1) {
        const typeName = params[i].type.name;
        typeNames.push(typeName);
        if (/(^|\.)(LogType|LogOption)$/.test(typeName)) continue;
        const isString = typeName === "System.String" || typeName === "String";
        if (isString) {
          if (firstString < 0) firstString = i;
          if (isFormat) {
            firstPayload = i;
            break;
          }
          continue;
        }
        if (firstPayload < 0) firstPayload = i;
      }
      if (firstPayload < 0) firstPayload = firstString < 0 ? 0 : firstString;
      const payloadIndex = skip + firstPayload;
      const signature = label + "." + method.name + "(" + typeNames.join(",") + ")[" + payloadIndex + "]";
      const addr = method.virtualAddress;
      const key = addr.toString();
      if (seen.indexOf(key) >= 0) continue;
      seen.push(key);
      Interceptor.attach(addr, {
        onEnter(args) {
          stats.managed += 1;
          send({
            t: "log",
            src: "managed",
            fn: label + "." + method.name,
            type: "Debug",
            text: objText(args[payloadIndex]),
          });
        },
      });
      installed.push(signature);
    } catch (e) {
      /* 某个重载挂不上就跳过 */
    }
  }
  return installed;
}

function typeName(index: number): string {
  return index >= 0 && index < LOG_TYPES.length ? LOG_TYPES[index] : String(index);
}

/** 把 Il2Cpp 字符串句柄转成 JS 字符串。 */
function il2cppString(value: NativePointer): string {
  try {
    if (isNull(value)) return "<null>";
    const s = new Il2Cpp.String(value);
    return s.content ?? "<null>";
  } catch (e) {
    return "<unreadable>";
  }
}

function hookManagedLogs(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];

  try {
    const addr = klass.method("Internal_Log").virtualAddress;
    Interceptor.attach(addr, {
      onEnter(args) {
        stats.managed += 1;
        send({ t: "log", src: "managed", fn: "Internal_Log", type: typeName(args[1].toInt32()), text: il2cppString(args[2]) });
      },
    });
    installed.push("Internal_Log");
  } catch (e) {
    send({ t: "hook-fail", name: "Internal_Log", err: String(e) });
  }

  try {
    const addr = klass.method("Internal_LogException").virtualAddress;
    Interceptor.attach(addr, {
      onEnter(args) {
        stats.exception += 1;
        let text = "<exception>";
        try {
          const obj = new Il2Cpp.Object(args[1]);
          text = obj.method("ToString").invoke() as string;
        } catch (e) {
          text = "<exception unreadable: " + e + ">";
        }
        send({ t: "log", src: "managed", fn: "Internal_LogException", type: "Exception", text: text });
      },
    });
    installed.push("Internal_LogException");
  } catch (e) {
    send({ t: "hook-fail", name: "Internal_LogException", err: String(e) });
  }

  return installed;
}

/** 打开日志开关与完整堆栈。 */
function enableVerboseLogging(): void {
  try {
    const debugCls = findClass("UnityEngine.Debug");
    if (debugCls !== null) {
      const logger = debugCls.method("get_unityLogger").invoke() as Il2Cpp.Object;
      logger.method("set_logEnabled").invoke(true);
      send({ t: "logger", logEnabled: true });
    }
  } catch (e) {
    send({ t: "logger", err: String(e) });
  }
  // StackTraceLogType 在部分版本被裁剪；找不到就退化为 hook 内自己抓 backtrace
  try {
    const appCls = findClass("UnityEngine.Application");
    if (appCls === null) return;
    const names = appCls.methods.map((m) => m.name);
    if (names.indexOf("SetStackTraceLogType") < 0) {
      send({ t: "logger", stackTrace: "unavailable (方法被裁剪)" });
      return;
    }
    const setStack = appCls.method("SetStackTraceLogType");
    for (let i = 0; i < LOG_TYPES.length; i += 1) {
      try {
        setStack.invoke(i, 2 /* StackTraceLogType.Full */);
      } catch (e) {
        /* 某些 LogType 可能不被接受，忽略 */
      }
    }
    send({ t: "logger", stackTrace: "Full" });
  } catch (e) {
    send({ t: "logger", stackTraceErr: String(e) });
  }
}

send({ t: "native-hooks", installed: hookNativeLogs() });

/**
 * 等 libil2cpp.so 映射后再交给 frida-il2cpp-bridge。
 *
 * 原因：bridge 的 initialize 找不到目标模块时会退化成「hook linker 的 dlopen 等它出现」，
 * 而 MuMu 的 ARM guest 环境里 linker64 并未映射，那条路会直接抛 unable to find module 'linker'。
 * 所以这里先自旋等待模块就位（冷启动后需要几秒）。
 */
let attempts = 0;
function bootstrapIl2Cpp(): void {
  attempts += 1;
  const mod = Process.findModuleByName("libil2cpp.so") ?? Process.findModuleByName("GameAssembly.so");
  if (mod === null) {
    if (attempts % 5 === 0) {
      send({ t: "wait-il2cpp", attempt: attempts, modules: Process.enumerateModules().length });
    }
    if (attempts > 90) {
      send({ t: "wait-il2cpp", giveUp: true, attempt: attempts });
      return;
    }
    setTimeout(bootstrapIl2Cpp, 1000);
    return;
  }

  send({ t: "il2cpp-module", base: mod.base.toString(), size: mod.size, waited: attempts + "s" });
  Il2Cpp.perform(() => {
    send({ t: "il2cpp", unityVersion: Il2Cpp.unityVersion, assemblies: Il2Cpp.domain.assemblies.length });
    const klass = findClass("UnityEngine.DebugLogHandler");
    if (klass === null) {
      send({ t: "managed", err: "UnityEngine.DebugLogHandler 未找到" });
    } else {
      send({ t: "managed", klass: klass.name, hooks: hookManagedLogs(klass) });
    }
    const debugCls = findClass("UnityEngine.Debug");
    const loggerCls = findClass("UnityEngine.Logger");
    send({
      t: "managed-entries",
      debug: debugCls === null ? [] : hookLogEntryPoints(debugCls, "Debug"),
      logger: loggerCls === null ? [] : hookLogEntryPoints(loggerCls, "Logger"),
    });
    enableVerboseLogging();
    selfTest();
  }).catch((e: Error) => {
    send({ t: "il2cpp-fail", err: String(e) });
    if (attempts < 12) setTimeout(bootstrapIl2Cpp, 2000);
  });
}

/**
 * 自证：从 agent 主动写一条 Unity 日志，应该立刻被上面的托管钩子捕获。
 * 多种调用形态都试一遍，把失败原因也报出来（托管方法重载/字符串封送容易踩坑）。
 */
function selfTest(): void {
  const debugCls = findClass("UnityEngine.Debug");
  if (debugCls === null) {
    send({ t: "self-test", ok: false, err: "UnityEngine.Debug 未找到" });
    return;
  }
  const marker = "frida-il2cpp-hook-online";
  const attempts: { name: string; run: () => void }[] = [
    { name: "Log.invoke(Il2Cpp.string)", run: () => { debugCls.method("Log").invoke(Il2Cpp.string(marker)); } },
    { name: "Log.invoke(js-string)", run: () => { debugCls.method("Log").invoke(marker); } },
    { name: "Log.overload(System.String)", run: () => { debugCls.method("Log").overload("System.String").invoke(marker); } },
    { name: "DebugLogHandler.Log(String, Object)", run: () => { findClass("UnityEngine.DebugLogHandler")?.method("Log").invoke(marker, null); } },
  ];
  for (const attempt of attempts) {
    try {
      attempt.run();
      send({ t: "self-test", ok: true, via: attempt.name, marker: marker });
      return;
    } catch (e) {
      send({ t: "self-test-try", via: attempt.name, err: String(e) });
    }
  }
  send({ t: "self-test", ok: false, err: "所有调用形态都失败" });
}

bootstrapIl2Cpp();

setInterval(() => {
  send({ t: "stats", ...stats });
}, 5000);
