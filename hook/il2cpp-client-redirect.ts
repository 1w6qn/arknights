import "./frida17-compat";
import "frida-il2cpp-bridge";

/*
 * 客户端运行时改造（等价于 apk:url-redirect + sign:key --patch-apk，但不改 APK）：
 *
 *  1) URL 重定向：挂 UnityEngine.Networking.UnityWebRequest 的 URL 入口，
 *     把官方域名改写成「http + 主机名+1」（如 https://ak-conf.hypergryph.com
 *     → http://ak-confx.hypergryph.com），配合设备 hosts 指到 127.0.0.1 + adb reverse。
 *     在调用点替换字符串没有长度限制，比 APK 里的等长改写更自由。
 *  2) 验签公钥替换：挂 Torappu.CryptUtils.VerifySignMD5RSA(content, sign, pubKey)，
 *     把官方公钥参数换成我们自己的公钥，于是私服的签名**真的能验过**（不是绕过验证）。
 *
 * 公钥从设备文件读取（缺省 /data/local/tmp/doctoratets-pubkey.xml，由管线推送），
 * 这样脚本本身不含个人密钥。
 */

/** 官方域名 → 私服域名（与 scripts/apk-url-redirect.ts 的 DEFAULT_HOST_MAP 一致）。 */
const HOST_MAP: { from: string; to: string }[] = [
  { from: "ak-conf.hypergryph.com", to: "ak-confx.hypergryph.com" },
  { from: "launcher.hypergryph.com", to: "launcherx.hypergryph.com" },
  { from: "game-config.hypergryph.com", to: "game-configx.hypergryph.com" },
  { from: "core-api-account-stable.hypergryph.net", to: "core-api-account-stablex.hypergryph.net" },
  { from: "ak-asset.hypergryph.com", to: "ak-assetx.hypergryph.com" },
  { from: "ak-webview.hypergryph.com", to: "ak-webviewx.hypergryph.com" },
  { from: "ak-gs-gf-audit.hypergryph.com", to: "ak-gs-gf-auditx.hypergryph.com" },
  { from: "ak.hycdn.cn", to: "akx.hycdn.cn" },
  { from: "ak.hypergryph.com", to: "akx.hypergryph.com" },
];

/**
 * 公钥：优先用管线注入的占位符（构建后由 scripts/frida-mumu-arm64.py 替换），
 * 手工运行时退回读设备文件。
 */
const PUBKEY_XML = "__PUBKEY_XML__";
const PUBKEY_PATH = "__PUBKEY_PATH__";
const MAX_LOG = 60;
/** Lua 加载器探针的日志上限（脚本加载次数远多于 URL 改写次数） */
const MAX_LUA_LOG = 400;

const stats = { urlsSeen: 0, urlsRewritten: 0, verifyCalls: 0, keysReplaced: 0, pubkeyLoaded: false, logsSeen: 0, luaLoads: 0 };
/** 最近一次 `_CustomLoader(filePath)` 的入参（onEnter/onLeave 之间传递，加载器是串行调用） */
let lastLuaPath: string | null = null;
let pubkey = "";
let pubkeyWarned = false;
let verbose = true;

/** 取公钥：占位符已注入则直接用，否则读设备文件（失败只警告一次）。 */
function loadPubkey(): string {
  if (PUBKEY_XML.indexOf("RSAKeyValue") >= 0) {
    stats.pubkeyLoaded = true;
    return PUBKEY_XML;
  }
  try {
    const text = File.readAllText(PUBKEY_PATH).trim();
    stats.pubkeyLoaded = text.indexOf("RSAKeyValue") >= 0;
    return text;
  } catch (e) {
    if (!pubkeyWarned) {
      pubkeyWarned = true;
      send({ t: "warn", msg: "未读到公钥文件 " + PUBKEY_PATH + "，跳过公钥替换（" + e + "）" });
    }
    return "";
  }
}

/**
 * URL 改写：仅命中映射表时改写，并强制 http。
 * @param url 原始 URL
 * @returns 改写后的 URL；无需改写时返回 null
 */
function rewriteUrl(url: string): string | null {
  const hit = HOST_MAP.find((m) => url.indexOf(m.from) >= 0);
  if (hit === undefined) return null;
  let out = url.replace(hit.from, hit.to);
  out = out.replace(/^https:\/\//i, "http://");
  return out === url ? null : out;
}

/** 安全读托管字符串。 */
function readString(ptr: NativePointer): string | null {
  try {
    if (ptr.isNull()) return null;
    return new Il2Cpp.String(ptr).content;
  } catch (e) {
    return null;
  }
}

/** 在某个类里挂所有「以字符串为首参」的方法（URL 入口）。 */
function hookUrlEntries(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];
  const names = /^(Get|Post|Put|Delete|Head|GetTexture|GetAudioClip|GetAssetBundle|set_url|set_uri)$/;
  const seen: string[] = [];
  for (const method of klass.methods) {
    if (!names.test(method.name)) continue;
    let index = -1;
    try {
      const params = method.parameters;
      for (let i = 0; i < params.length; i += 1) {
        if (params[i].type.name === "System.String") {
          index = i;
          break;
        }
      }
    } catch (e) {
      continue;
    }
    if (index < 0) continue;
    if (!method.isStatic) index += 1; // 实例方法 args[0] 是 this
    const addr = method.virtualAddress.toString();
    if (seen.indexOf(addr) >= 0) continue;
    seen.push(addr);
    try {
      const argIndex = index;
      const label = method.name + "#" + argIndex;
      Interceptor.attach(method.virtualAddress, {
        onEnter(args) {
          // 触发一次 Lua 插件注入：URL 入口必然在 Lua 起来之后被调用，且此处不在 Lua 调用栈内
          if (luaManagerPtr !== null && !luaInjected) tryInjectLua(luaManagerPtr);
          const url = readString(args[argIndex]);
          if (url === null) return;
          stats.urlsSeen += 1;
          const next = rewriteUrl(url);
          if (next === null) {
            if (verbose && stats.urlsSeen <= MAX_LOG) send({ t: "url", fn: label, url: url, rewritten: null });
            return;
          }
          stats.urlsRewritten += 1;
          if (verbose && stats.urlsRewritten <= MAX_LOG) send({ t: "url", fn: label, url: url, rewritten: next });
          try {
            args[argIndex] = Il2Cpp.string(next).handle;
          } catch (e) {
            send({ t: "url-rewrite-fail", url: url, err: String(e) });
          }
        },
      });
      installed.push(label);
    } catch (e) {
      /* 单个方法挂不上就跳过 */
    }
  }
  return installed;
}

/**
 * frida 侧把插件源码注入**运行中的 Lua VM**（不改任何游戏资产）。
 *
 * 为什么需要它：实测客户端会拒绝任何被重新加密的 Lua 资产（连「明文逐字节相同、只换 IV」都返回
 * null），所以「改 Lua bundle」这条路在当前客户端上走不通；而 `LuaEnv.DoString` 是可调用的托管接口，
 * 于是改为在**游戏线程**上直接往 Lua VM 里灌插件代码（自用调试，符合目标里的 frida 路线）。
 *
 * 时序与安全：`LuaManager.m_env` 指针从 `_CustomLoader(this, …)` 的 `this` 取；真正的注入放在
 * 托管日志钩子里（同样跑在游戏线程、且不在 Lua 调用栈内），等 Lua 明确起来后再执行一次。
 */
const LUA_INJECT_SNIPPET = [
  "xpcall(function()",
  '  local u = CS.Torappu.Lua.Util',
  '  u.LogHotfixError("[DoctorateTs] frida lua inject OK")',
  '  local p = CS.UnityEngine.Application.persistentDataPath .. "/frida_lua_inject.txt"',
  '  CS.Torappu.FileUtil.WriteToFile("ok", p, true)',
  "end, function(e)",
  '  CS.Torappu.Lua.Util.LogHotfixError("[DoctorateTs] inject err: " .. tostring(e))',
  "end)",
].join("\n");
/** LuaManager 实例（`_CustomLoader` 的 this），作为取 m_env 的入口 */
let luaManagerPtr: NativePointer | null = null;
/** 注入是否已成功（只做一次；失败允许后续重试） */
let luaInjected = false;
/** Lua 加载计数（作为注入时机：第 5 次加载脚本时注入） */
let luaLoadCalls = 0;

/**
 * 经 il2cpp 在游戏线程上调用 `LuaManager.m_env.DoString(snippet)`。
 * @param manager - LuaManager 实例指针（来自 `_CustomLoader` 的 this）
 */
function tryInjectLua(manager: NativePointer): void {
  if (luaInjected) return;
  luaInjected = true;
  try {
    const mgr = new Il2Cpp.Object(manager);
    const env = mgr.field("m_env").value as Il2Cpp.Object;
    // 第三个参数是 XLua.LuaTable（可空）：必须传空指针常量 NULL，不能传 JS null
    env
      .method("DoString")
      .invoke(Il2Cpp.string(LUA_INJECT_SNIPPET), Il2Cpp.string("dts_frida_inject"), NULL);
    send({ t: "lua-inject", ok: true });
  } catch (e) {
    luaInjected = false; // 允许下一轮重试
    let sig = "?";
    let luaExports = 0;
    try {
      const mgr = new Il2Cpp.Object(manager);
      const env = mgr.field("m_env").value as Il2Cpp.Object;
      sig = env
        .method("DoString")
        .parameters.map((p) => p.type.name)
        .join(",");
    } catch (inner) {
      sig = "读取签名失败:" + inner;
    }
    try {
      const il2cpp = Process.findModuleByName("libil2cpp.so");
      if (il2cpp !== null) {
        luaExports = il2cpp.enumerateExports().filter((x) => x.name.indexOf("lua") === 0).length;
      }
    } catch (inner) {
      luaExports = -1;
    }
    send({ t: "lua-inject", ok: false, err: String(e), sig: sig, luaExports: luaExports });
  }
}
/** 挂验签入口，把官方公钥换成我们自己的。 */
function hookVerifySign(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];
  for (const method of klass.methods) {
    if (method.name !== "VerifySignMD5RSA") continue;
    let params = "";
    try {
      params = method.parameters.map((p) => p.type.name).join(",");
    } catch (e) {
      params = "?";
    }
    // 只处理 (String, String, String) 重载：内容、签名、公钥
    if (params !== "System.String,System.String,System.String") continue;
    try {
      Interceptor.attach(method.virtualAddress, {
        onEnter(args) {
          stats.verifyCalls += 1;
          const content = readString(args[0]);
          const given = readString(args[2]);
          if (verbose && stats.verifyCalls <= MAX_LOG) {
            send({
              t: "verify",
              contentLen: content === null ? -1 : content.length,
              contentHead: content === null ? null : content.slice(0, 80),
              pubkeyLen: given === null ? -1 : given.length,
              pubkeyOurs: given !== null && pubkey.length > 0 && given === pubkey,
            });
          }
          if (pubkey.length === 0) return;
          if (given !== null && given === pubkey) return;
          try {
            args[2] = Il2Cpp.string(pubkey).handle;
            stats.keysReplaced += 1;
          } catch (e) {
            send({ t: "verify-key-fail", err: String(e) });
          }
        },
      });
      installed.push("VerifySignMD5RSA(String,String,String)");
    } catch (e) {
      installed.push("VerifySignMD5RSA(fail:" + e + ")");
    }
  }
  return installed;
}

/**
 * 最小托管日志钩子（只挂 2 个入口，且钩子内不做任何托管调用）。
 *
 * 为什么不复用 il2cpp-unity-logs.ts 的全量钩子：Hook 数量越多、越热的方法，
 * 在 Houdini 翻译层下踩到翻译缓存/蹦床的风险越高（实测同一进程反复装卸钩子后
 * 出现过 pc=0 的 SIGSEGV）。这里只保留最能代表「Unity 日志」的两个入口，
 * 且只读字符串、绝不从钩子里回调托管代码。
 */
function hookManagedLogsMinimal(find: (fullName: string) => Il2Cpp.Class | null): string[] {
  const installed: string[] = [];
  const hooks: { klass: string; method: string; params: string }[] = [
    { klass: "UnityEngine.Debug", method: "Log", params: "System.Object" },
    { klass: "UnityEngine.Logger", method: "Log", params: "UnityEngine.LogType,System.Object" },
  ];
  for (const spec of hooks) {
    const klass = find(spec.klass);
    if (klass === null) {
      installed.push(spec.klass + ".<未找到>");
      continue;
    }
    for (const method of klass.methods) {
      if (method.name !== spec.method) continue;
      let params = "";
      try {
        params = method.parameters.map((p) => p.type.name).join(",");
      } catch (e) {
        continue;
      }
      if (params !== spec.params) continue;
      const skip = method.isStatic ? 0 : 1;
      const argIndex = skip + method.parameters.length - 1;
      try {
        Interceptor.attach(method.virtualAddress, {
          onEnter(args) {
            // 兜底触发：日志量足够大时（说明游戏已跑起来）注入一次，游戏线程、非 Lua 栈
            if (stats.logsSeen > 30 && luaManagerPtr !== null && !luaInjected) tryInjectLua(luaManagerPtr);
            const text = readString(args[argIndex]);
            stats.logsSeen += 1;
            if (text === null) {
              if (stats.logsSeen <= MAX_LOG) send({ t: "log", src: spec.klass, text: "<非字符串>" });
              return;
            }
            if (text.length === 0) return;
            if (verbose && stats.logsSeen <= MAX_LOG) send({ t: "log", src: spec.klass, text: text });
          },
        });
        installed.push(spec.klass + "." + spec.method + "(" + params + ")");
      } catch (e) {
        installed.push(spec.klass + "." + spec.method + "(fail:" + e + ")");
      }
    }
  }
  return installed;
}

/**
 * 诊断：记录 Lua 脚本加载器 `Torappu.Lua.LuaManager._CustomLoader(string) → byte[]` 的调用。
 *
 * 用途：确认客户端是否真的从（被我们替换的）Lua bundle 里取脚本——客户端对每个 Lua 模块
 * 会先探测 StreamingAssets 散装文件（`jar:file://…apk!/assets/<模块路径>.lua`），失败才回退 bundle，
 * 而 bundle 路径走 `AssetBundle.LoadAsset`（不产生 URL，看不见）。这里直接看加载器的入参与返回：
 *   返回数组长度 0 / 指针为空 ⇒ 该模块没被解析到。
 * @param klass - LuaManager 类
 * @returns 已挂钩子的方法名列表
 */
function hookLuaLoader(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];
  for (const method of klass.methods) {
    if (method.name !== "_CustomLoader") continue;
    let argIndex = -1;
    let byRef = false;
    let sig = "?";
    try {
      const ps = method.parameters;
      sig = (method.isStatic ? "" : "this,") + ps.map((p) => p.type.name).join(",");
      const skip = method.isStatic ? 0 : 1;
      for (let i = 0; i < ps.length; i += 1) {
        const tn = ps[i].type.name;
        if (tn.indexOf("System.String") === 0) {
          argIndex = i + skip;
          byRef = tn.charAt(tn.length - 1) === "&"; // 形如 System.String& ⇒ 需解一层引用
          break;
        }
      }
    } catch (e) {
      sig = "?" + e;
    }
    if (argIndex < 0) {
      installed.push("_CustomLoader(无字符串参数: " + sig + ")");
      continue;
    }
    const pathArg = argIndex;
    const pathByRef = byRef;
    try {
      Interceptor.attach(method.virtualAddress, {
        onEnter(args) {
          luaLoadCalls += 1;
          luaManagerPtr = args[0]; // this（LuaManager 实例）——供后续经 m_env.DoString 注入插件
          // 第 5 次加载脚本时注入插件：此刻 Lua VM 已初始化且已加载若干模块，仍在游戏线程上。
          // （URL 钩子做触发点不可靠——它可能只在 Lua 起来之前触发。）
          if (luaLoadCalls === 2 && !luaInjected) tryInjectLua(args[0]);
          try {
            const slot = args[pathArg];
            if (slot.isNull()) {
              lastLuaPath = null;
            } else {
              lastLuaPath = readString(pathByRef ? slot.readPointer() : slot);
            }
          } catch (e) {
            lastLuaPath = "<读路径失败:" + e + ">";
          }
        },
        onLeave(retval) {
          stats.luaLoads += 1;
          if (stats.luaLoads > MAX_LUA_LOG) return;
          // 返回值是解密后的明文 byte[]：长度在 +0x18，数据在 +0x20
          let len = -1;
          let head = "";
          try {
            if (!retval.isNull()) {
              len = retval.add(0x18).readS32();
              if (len > 0) head = retval.add(0x20).readUtf8String(Math.min(len, 44)) ?? "";
            }
          } catch (e) {
            head = "<读头部失败:" + e + ">";
          }
          send({ t: "lua-load", path: lastLuaPath, len: len, head: head });
        },
      });
      installed.push("_CustomLoader(" + sig + ")");
    } catch (e) {
      installed.push("_CustomLoader(fail:" + e + ")");
    }
  }
  return installed;
}

/** 按全名找类（跨 assembly）。 */
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

pubkey = loadPubkey();
send({ t: "pubkey", loaded: stats.pubkeyLoaded, length: pubkey.length, path: PUBKEY_PATH });

Il2Cpp.perform(() => {
  const webCls = findClass("UnityEngine.Networking.UnityWebRequest");
  const cryptCls = findClass("Torappu.CryptUtils");
  const luaMgrCls = findClass("Torappu.Lua.LuaManager");
  send({
    t: "hooks",
    url: webCls === null ? [] : hookUrlEntries(webCls),
    verify: cryptCls === null ? [] : hookVerifySign(cryptCls),
    logs: hookManagedLogsMinimal(findClass),
    luaLoader: luaMgrCls === null ? [] : hookLuaLoader(luaMgrCls),
  });
}).catch((e: Error) => send({ t: "il2cpp-fail", err: String(e), stack: e.stack }));

setInterval(() => {
  send({ t: "stats", ...stats });
}, 8000);
