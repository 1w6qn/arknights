import "./frida17-compat";
import "frida-il2cpp-bridge";
import { PLUGIN_LUA } from "./build/plugin-lua";

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
/**
 * 验签公钥端序 A/B 模式（由 `scripts/frida-mumu-arm64.py --pubkey-mode` 注入）：
 *   asis = 不动公钥；flip = 一律换成「反转写法」；ab = 逐次交替（一次跑出结论）；ours = 换我们的公钥。
 * 背景：客户端读 `<RSAKeyValue>` 的 Modulus 到底是按大端原样读还是按 CAPI 小端反转读，
 * 决定了我们替换公钥时该写哪种端序（`data/crypto/public.xml` 目前写的是小端）。
 */
const PUBKEY_MODE = "__DTS_PUBKEY_MODE__";
/** 官方公钥的两种端序写法（A/B 用，由管线在构建时从官方 APK 提取并注入） */
const OFFICIAL_PUBKEY_BE = "__OFFICIAL_PUBKEY_BE__";
const OFFICIAL_PUBKEY_LE = "__OFFICIAL_PUBKEY_LE__";
const MAX_LOG = 60;
/** Lua 加载器探针的日志上限（脚本加载次数远多于 URL 改写次数） */
const MAX_LUA_LOG = 400;
/** byte[] 重载（Lua 资产验签）的判定日志上限 */
const MAX_BIN_LOG = 60;
/** byte[] 重载累计调用次数（A/B 交替用） */
let binVerifyCalls = 0;
/** 已上报的 byte[] 验签结论条数 */
let binLogs = 0;

const stats = { urlsSeen: 0, urlsRewritten: 0, verifyCalls: 0, keysReplaced: 0, pubkeyLoaded: false, logsSeen: 0, luaLoads: 0 };
/** 最近一次 `_CustomLoader(filePath)` 的入参（onEnter/onLeave 之间传递，加载器是串行调用） */
let lastLuaPath: string | null = null;
/**
 * 是否正处于 `_CustomLoader`（Lua 资产加载）内部。
 *
 * 为什么需要：`VerifySignMD5RSA(byte[],byte[],string)` 这个重载**两条路都在用**——
 * ① Lua 资产（`_CustomLoader` 里，我们的 mod bundle 用**我们的**私钥签，需要换成我们的公钥）；
 * ② excel/DB 等 `CrypticConverter_WithSign` 资产（官方签名，必须**保持官方公钥**）。
 * 早先不分场合地全局换公钥，会导致②全部验签失败、客户端在 DB 阶段就卡住（实测 `ours` 模式
 * 只走到 2 次验签、Lua 一个都没加载）。故按调用上下文区分。
 */
let luaLoaderDepth = 0;
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
 * frida 侧把插件系统注入**运行中的 Lua VM**（不改任何游戏资产）。
 *
 * 为什么需要它：实测客户端会拒绝任何被重新加密的 Lua 资产（连「明文逐字节相同、只换 IV」都返回
 * null），所以「改 Lua bundle」这条路在当前客户端上走不通；`LuaEnv.DoString` 是可直接调用的托管
 * 接口，于是改为在**游戏主线程、Lua 空闲时**把插件源码灌进 Lua VM（自用调试，符合目标里的 frida 路线）。
 *
 * 三个关键点（全部由 `docs/il2cpp-dump-trace-2026-09-14.md` 的 dump/trace 实测确定）：
 *  1) `XLua.LuaEnv::DoString` 有**两个都是 3 参数**的重载（`String` / `Byte[]` 版），
 *     桥的 `method("DoString")` 取到哪一个不确定——必须用 `.overload("System.String","System.String","XLua.LuaTable")`
 *     显式选字符串版，第三个参数（LuaTable env）传空指针常量 `NULL`（传 JS `null` 会报参数类型错）。
 *  2) 注入时机：`LuaManager._DoLoadEntryScript` 返回（`entry` 与 hotfix 链跑完、Lua 栈已退空）之后，
 *     在 `LuaManager._DoUpdate` 的 onEnter 里调用——由 Unity Update 循环驱动，不在任何 Lua 调用栈内，
 *     避免在 `require` 的 searcher 回调里重入 Lua VM。
 *  3) 插件源码不能靠 `require` 从资产里拿，payload 自带源码表：注入时先装一个只认
 *     `Plugin/*` 的 searcher，再按插件自己的引导顺序 require（`_G.PluginDefs` → `PluginManager`
 *     → …，与 lua/plugin/PluginBootHotfixer.lua 的 `_BootstrapGlobals` 一致）。
 */
/** 插件模块名 → 源码（构建期由 scripts/build-frida-hook.mjs 从 lua/plugin/*.lua 生成）。 */
const LUA_MODULES: { [name: string]: string } = PLUGIN_LUA;
/** LuaManager 实例（`_CustomLoader` 的 this），作为取 m_env 的入口 */
let luaManagerPtr: NativePointer | null = null;
/** 注入是否已成功（只做一次；失败允许后续重试，成功即停） */
let luaInjected = false;
/** `entry` 脚本是否已执行完（`_DoLoadEntryScript` 返回过）——注入的时序门禁 */
let entryScriptDone = false;
/** Update 帧计数（`_DoLoadEntryScript` 没等到时的兜底触发用） */
let updateFrames = 0;
/** 真正调用过 DoString 的次数（失败重试上限，防每帧重试风暴） */
let injectAttempts = 0;
/** 失败重试上限 */
const MAX_INJECT_ATTEMPTS = 8;
/** 兜底：entry 脚本迟迟没等到时，多少帧后仍尝试注入 */
const FALLBACK_FRAMES = 900;

/**
 * 构造注入 payload（自包含：源码表 + searcher + 引导）。
 * 返回字符串即自检结论：`DTS_PLUGIN_OK` 或 `DTS_PLUGIN_ERR: …`——经 `DoString` 的返回值回传，
 * 不依赖日志/文件即可判定成功。
 * @returns Lua chunk 源码
 */
function buildLuaPayload(): string {
  const lines: string[] = ["local SRC = {"];
  for (const name of Object.keys(LUA_MODULES)) {
    lines.push("  [" + JSON.stringify(name) + "] = " + JSON.stringify(LUA_MODULES[name]) + ",");
  }
  lines.push(
    "}",
    "local searchers = package.searchers or package.loaders",
    "local function dts_searcher(name)",
    "  local code = SRC[name]",
    '  if code == nil then return "\\n\\tno DoctorateTs module \'" .. name .. "\'" end',
    "  local chunk, err = load(code, \"@\" .. name)",
    '  if chunk == nil then return "\\n\\tDoctorateTs module \'" .. name .. "\' load error: " .. tostring(err) end',
    "  return chunk",
    "end",
    "table.insert(searchers, 1, dts_searcher)",
    "local function dts_trace(msg)",
    "  pcall(function()",
    '    local path = CS.UnityEngine.Application.persistentDataPath .. "/frida_plugin_trace.txt"',
    '    CS.Torappu.FileUtil.WriteToFile("[DTS] " .. msg, path, true)',
    "  end)",
    "end",
    'dts_trace("frida inject enter")',
    "local ok, err = xpcall(function()",
    '  _G.PluginDefs = require "Plugin/PluginDefs"',
    '  dts_trace("PluginDefs ok")',
    '  _G.PluginManager = require "Plugin/PluginManager"',
    '  dts_trace("PluginManager ok")',
    '  _G.PluginEntry = require "Plugin/PluginEntry"',
    '  dts_trace("PluginEntry ok")',
    '  _G.PluginHeartbeat = require "Plugin/PluginHeartbeat"',
    '  dts_trace("PluginHeartbeat ok")',
    "  PluginEntry.init()",
    '  dts_trace("PluginEntry.init ok")',
    "  PluginHeartbeat.ScheduleAuto()",
    '  dts_trace("ScheduleAuto ok")',
    "end, debug.traceback)",
    "local detail = \"\"",
    "if ok then",
    "  local parts = {}",
    "  for _, def in ipairs(PluginDefs) do",
    '    parts[#parts + 1] = def.id .. (PluginManager.me:GetPlugin(def.id) ~= nil and "=1" or "=0")',
    "  end",
    '  detail = " " .. table.concat(parts, " ")',
    "end",
    "-- UI 挂载自检：面板/浮动按钮是否已在 Canvas 上建出来（Canvas 晚于注入就绪时由自愈链补建）",
    "local function dts_ui(id)",
    "  local okP, p = pcall(function() return PluginManager.me:GetPlugin(id) end)",
    '  if not okP or p == nil then return id .. "=nil" end',
    "  local built = (p._root ~= nil) and (p._floatBtn ~= nil)",
    '  return id .. "=" .. (built and "1" or "0")',
    "end",
    'local uis = " ui:" .. dts_ui("plugin_panel") .. "," .. dts_ui("options_panel")',
    "-- 顺手把面板打开：便于用截屏按颜色（蓝色 Toggle #4D99FF）做「浮窗真的画出来了」的无眼验证",
    "pcall(function()",
    "  local p = PluginManager.me:GetPlugin(\"plugin_panel\")",
    "  if p ~= nil and p._root ~= nil and p.TogglePanel ~= nil then p:TogglePanel() end",
    "end)",
    'local out = ok and ("DTS_PLUGIN_OK" .. detail) or ("DTS_PLUGIN_ERR: " .. tostring(err))',
    "out = out .. uis",
    "dts_trace(out)",
    "-- 延迟复核：Canvas 晚就绪时自愈链应在数秒内补建；结果写入独立 trace 供回读",
    "pcall(function()",
    "  local tm = TimerModel and TimerModel.me",
    "  if tm == nil then return end",
    "  local cb=function()",
    "    xpcall(function()",
    '      local path = CS.UnityEngine.Application.persistentDataPath .. "/frida_ui_trace.txt"',
    '      CS.Torappu.FileUtil.WriteToFile("[DTS-UI] " .. dts_ui("plugin_panel") .. " " .. dts_ui("options_panel"), path, true)',
    "    end, function() end)",
    "  end",
    "  -- Timer 回调同样必须是带 Call 方法的对象（Timer:52 是 `self.m_call:Call()`），裸函数会让客户端 abort",
    "  pcall(function() if Event~=nil and Event.CreateStatic~=nil then cb=Event.CreateStatic(cb) end end)",
    "  tm:Delay(10, cb)",
    "end)",
    "return out",
  );
  return lines.join("\n");
}

/**
 * 读 `LuaManager.m_env`（尚未建立时返回 null）。
 * @param manager - LuaManager 实例指针
 * @returns LuaEnv 对象指针，未就绪为 null
 */
function readLuaEnv(manager: NativePointer): Il2Cpp.Object | null {
  try {
    const env = new Il2Cpp.Object(manager).field("m_env").value as Il2Cpp.Object;
    return env.isNull() ? null : env;
  } catch (e) {
    return null;
  }
}

/**
 * 构造「插件浮窗/面板状态」探针 chunk。
 *
 * 用途：插件系统起来后，实际去看 `PanelPlugin` 有没有把浮窗按钮与面板建出来
 * （`PluginUI.FindCanvas()` 找不到活 Canvas 时会由自愈链重试，所以要"过一会儿再看"）。
 * `toggle=true` 时额外调用 `TogglePanel()` 把面板打开，用于验证"能开且 activeInHierarchy"；
 * `invokeRow=true` 时再 invoke 第一行的「切换」按钮，用于验证**实际功能**（启停 → 写配置 → 推服务端）。
 * @param toggle - 是否顺便开合一次面板
 * @param invokeRow - 是否 invoke 第一行的开关按钮
 * @returns Lua chunk 源码（返回一行状态串）
 */
let uiProbeStage = 0;

function buildUiProbeChunk(toggle: boolean, invokeRow = false): string {
  return [
    "local out = {}",
    "local INVOKE_ROW = " + (invokeRow ? "true" : "false"),
    'local function add(k, v) out[#out + 1] = k .. "=" .. tostring(v) end',
    "xpcall(function()",
    "  local pm = PluginManager",
    "  add(\"pm\", pm ~= nil and pm.me ~= nil)",
    "  local p = nil",
    "  if pm ~= nil and pm.me ~= nil then p = pm.me:GetPlugin(\"plugin_panel\") end",
    "  add(\"panel\", p ~= nil)",
    "  if p ~= nil then",
    "    add(\"canvas\", p._canvas ~= nil)",
    "    add(\"btn\", p._floatBtn ~= nil)",
    "    add(\"root\", p._root ~= nil)",
    "    add(\"open\", p._open)",
    "    if p._floatBtn ~= nil then",
    "      add(\"btn_name\", p._floatBtn.name)",
    "      add(\"btn_active\", p._floatBtn.activeSelf)",
    "      add(\"btn_hier\", p._floatBtn.activeInHierarchy)",
    "      local bp = p._floatBtn.transform.parent",
    "      add(\"btn_parent\", bp ~= nil and bp.name or \"nil\")",
    "      local rt = p._floatBtn:GetComponent(typeof(CS.UnityEngine.RectTransform))",
    "      if rt ~= nil then",
    "        add(\"btn_rect\", string.format(\"%.0f,%.0f %.0fx%.0f\", rt.anchoredPosition.x, rt.anchoredPosition.y, rt.sizeDelta.x, rt.sizeDelta.y))",
    "      end",
    "    end",
    "    if p._root ~= nil then",
    "    -- 实际功能验证：invoke 第一行的「切换」按钮（等价于点它）→ 看启停状态/写配置/推服务端是否真发生",
    "    if INVOKE_ROW and p._listRoot ~= nil and p._listRoot.transform.childCount > 0 then",
    "      local okr, errr = pcall(function()",
    "        local row = p._listRoot.transform:GetChild(0)",
    "        local st = row:Find(\"State\")",
    "        if st ~= nil then add(\"row0_before\", st:GetComponent(typeof(CS.UnityEngine.UI.Text)).text) end",
    "        pcall(function()",
    "          local id0 = PluginDefs[1].id",
    "          local q = PluginManager.me:GetPlugin(id0)",
    "          add(\"p0_id\", id0)",
    "          add(\"p0_before\", q ~= nil and tostring(q.enabled) or \"nil\")",
    "        end)",
    "        local t = row:Find(\"Toggle\")",
    "        if t == nil then add(\"row0_invoked\", \"no-toggle\") return end",
    "        local b = t:GetComponent(typeof(CS.UnityEngine.UI.Button))",
    "        if b ~= nil then",
    "          b.onClick:Invoke()",
    "          add(\"row0_invoked\", \"ugui\")",
    "        else",
    "          add(\"row0_invoked\", \"selfdraw\")  -- 已改成自绘点击，合成点击请用真实 input",
    "        end",
    "      end)",
    "      if not okr then add(\"row0_err\", tostring(errr)) end",
    "      pcall(function()",
    "        local id0 = PluginDefs[1].id",
    "        local q2 = PluginManager.me:GetPlugin(id0)",
    "        add(\"p0_after\", q2 ~= nil and tostring(q2.enabled) or \"nil\")",
    "      end)",
    "      pcall(function()",
    "        local row2 = p._listRoot.transform:GetChild(0)",
    "        local st2 = row2:Find(\"State\")",
    "        if st2 ~= nil then add(\"row0_after\", st2:GetComponent(typeof(CS.UnityEngine.UI.Text)).text) end",
    "      end)",
    "    end",
    "      add(\"root_name\", p._root.name)",
    "      add(\"root_active\", p._root.activeSelf)",
    "      add(\"root_hier\", p._root.activeInHierarchy)",
    "      add(\"rows\", p._listRoot ~= nil and p._listRoot.transform.childCount or -1)",
    "    end",
    toggle ? "    p:TogglePanel()" : "    -- no toggle",
    "    if p._root ~= nil then",
    "      add(\"after_open\", p._open)",
    "      add(\"after_active\", p._root.activeSelf)",
    "      add(\"after_hier\", p._root.activeInHierarchy)",
    "    end",
    "  end",
    "  add(\"screen\", CS.UnityEngine.Screen.width .. \"x\" .. CS.UnityEngine.Screen.height)",
    "  -- 供真实 input 定位：行开关与二级(选项)面板按钮的屏幕坐标（bottom-up，top-down y=1080-y）",
    "  pcall(function()",
    "    if p == nil or p._listRoot == nil then return end",
    "    local rows = p._listRoot.transform",
    "    if rows.childCount > 0 then",
    "      local t = rows:GetChild(0):Find(\"Toggle\")",
    "      if t ~= nil then",
    "        local sp = CS.UnityEngine.RectTransformUtility.WorldToScreenPoint(nil, t.position)",
    "        add(\"row0_toggle_screen\", string.format(\"%.0f,%.0f\", sp.x, sp.y))",
    "      end",
    "    end",
    "  end)",
    "  pcall(function()",
    "    local p2 = PluginManager.me:GetPlugin(\"options_panel\")",
    "    if p2 == nil or p2._root == nil then return end",
    "    add(\"opt_root_active\", tostring(p2._root.activeInHierarchy))",
    "    add(\"opt_open\", tostring(p2._open))",
    "    if p2._floatBtn ~= nil then",
    "      local s2 = CS.UnityEngine.RectTransformUtility.WorldToScreenPoint(nil, p2._floatBtn.transform.position)",
    "      add(\"opt_btn_screen\", string.format(\"%.0f,%.0f\", s2.x, s2.y))",
    "    end",
    "    if p2._tabRoot ~= nil and p2._tabRoot.transform.childCount > 0 then",
    "      local tb = p2._tabRoot.transform:GetChild(0)",
    "      local s3 = CS.UnityEngine.RectTransformUtility.WorldToScreenPoint(nil, tb.position)",
    "      add(\"opt_tab0_screen\", string.format(\"%.0f,%.0f\", s3.x, s3.y))",
    "    end",
    "  end)",
    "  -- 世界坐标 → 屏幕坐标：判定浮窗/面板到底画在屏幕的哪里（Overlay 画布传 nil 相机即可）",
    "  pcall(function()",
    "    if p == nil then return end",
    "    if p._floatBtn ~= nil then",
    "      local wp = p._floatBtn.transform.position",
    "      local sp = CS.UnityEngine.RectTransformUtility.WorldToScreenPoint(nil, wp)",
    "      add(\"btn_screen\", string.format(\"%.0f,%.0f\", sp.x, sp.y))",
    "    end",
    "    if p._root ~= nil then",
    "      local wp2 = p._root.transform.position",
    "      local sp2 = CS.UnityEngine.RectTransformUtility.WorldToScreenPoint(nil, wp2)",
    "      add(\"root_screen\", string.format(\"%.0f,%.0f\", sp2.x, sp2.y))",
    "    end",
    "    if p._canvas ~= nil then",
    "      local cv = p._canvas:GetComponent(typeof(CS.UnityEngine.Canvas))",
    "      if cv ~= nil then",
    "        add(\"canvas_mode\", tostring(cv.renderMode))",
    "        add(\"canvas_order\", tostring(cv.sortingOrder))",
    "        add(\"canvas_scale\", string.format(\"%.2f\", cv.scaleFactor))",
    "      end",
    "    end",
    "  end)",
    "  local sc = CS.UnityEngine.SceneManagement.SceneManager.GetActiveScene()",
    "  add(\"scene\", sc.name)",
    "end, function(e) add(\"err\", tostring(e)) end)",
    'return table.concat(out, " ")',
  ].join("\n");
}

/**
 * 构造「卸载插件 / 清 C# 回调」chunk：游戏释放或重载 LuaEnv 之前调用，避免
 * `InvalidOperationException: try to dispose a LuaEnv with C# callback!`（会 abort 整个进程）。
 * @returns Lua chunk 源码
 */
function buildCleanupChunk(): string {
  return [
    "local out = {}",
    "pcall(function()",
    "  if PluginEntry ~= nil and PluginEntry.dispose ~= nil then",
    "    PluginEntry.dispose()",
    "    out[#out + 1] = \"plugin-dispose-ok\"",
    "  end",
    "end)",
    "pcall(function()",
    "  if _G.DTS_BootstrapCleanup ~= nil then",
    "    _G.DTS_BootstrapCleanup()",
    "    out[#out + 1] = \"boot-cleanup-ok\"",
    "  end",
    "end)",
    "return table.concat(out, \" \")",
  ].join("\n");
}

/**
 * 跑一次清理并把结果发回（在游戏主线程上调用）。
 * @param reason - 触发原因（方法名）
 */
function runLuaCleanup(reason: string): void {
  const manager = luaManagerPtr;
  if (manager === null) return;
  const env = readLuaEnv(manager);
  if (env === null) return;
  try {
    const result = env
      .method("DoString")
      .overload("System.String", "System.String", "XLua.LuaTable")
      .invoke(Il2Cpp.string(buildCleanupChunk()), Il2Cpp.string("dts_cleanup"), NULL);
    const handle = (result as Il2Cpp.Array).handle;
    const count = handle.add(0x18).readS32();
    const text = count > 0 ? readString(handle.add(0x20).readPointer()) : null;
    send({ t: "lua-cleanup", reason: reason, text: text });
  } catch (e) {
    send({ t: "lua-cleanup", reason: reason, err: String(e) });
  }
}

/** lua_tostring 的导出地址（惰性解析；没有就放弃读错误文本） */
let luaToStringPtr: NativePointer | null = null;
let luaToStringTried = false;

/**
 * 读 Lua 栈顶（或次顶）的错误文本。
 * @param envPtr - LuaEnv 实例指针
 * @returns 错误文本，失败为 null
 */
function readLuaErrorText(envPtr: NativePointer): string | null {
  try {
    if (!luaToStringTried) {
      luaToStringTried = true;
      luaToStringPtr = Module.findGlobalExportByName("lua_tostring");
    }
    if (luaToStringPtr === null) return null;
    const env = new Il2Cpp.Object(envPtr);
    const raw = env.method("get_L").invoke();
    const L = raw as NativePointer;
    const fn = new NativeFunction(luaToStringPtr, "pointer", ["pointer", "int"]);
    for (const idx of [-1, -2]) {
      const p = fn(L, idx);
      if (!p.isNull()) {
        const text = p.readUtf8String(600);
        if (text !== null && text.length > 0) return text;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 死因探针：Lua 错误被转成托管异常的那一刻（`LuaEnv.ThrowExceptionFromError`）以及
 * Unity 记录异常的时刻（`Debug.LogException`），把**错误文本 + C# 调用栈**打出来。
 *
 * 为什么需要：客户端 abort 只打印 `terminating with uncaught exception of type Il2CppExceptionWrapper`，
 * Unity 侧没有消息，光看崩溃栈定位不到是哪条 Lua 错误（本轮排查就卡在这里）。
 * @param luaEnvCls - XLua.LuaEnv 类
 * @param debugCls - UnityEngine.Debug 类（可为 null）
 * @returns 已挂钩子的方法名列表
 */
function hookExceptionDiagnostics(luaEnvCls: Il2Cpp.Class, debugCls: Il2Cpp.Class | null): string[] {
  const installed: string[] = [];
  for (const method of luaEnvCls.methods) {
    if (method.name !== "ThrowExceptionFromError") continue;
    try {
      Interceptor.attach(method.virtualAddress, {
        onEnter(args) {
          const text = readLuaErrorText(args[0]);
          let frames = "";
          try {
            frames = Thread.backtrace(this.context, Backtracer.FUZZY)
              .slice(0, 6)
              .map((f) => f.toString())
              .join(" ");
          } catch (e) {
            frames = "bt-fail";
          }
          send({ t: "lua-throw", msg: text, bt: frames });
        },
      });
      installed.push("LuaEnv.ThrowExceptionFromError");
    } catch (e) {
      installed.push("ThrowExceptionFromError(fail:" + e + ")");
    }
  }
  // 直接抓 xLua 抛出的异常消息：`XLua.LuaException..ctor(string)`（比 lua_tostring 可靠得多）
  const luaExCls = findClass("XLua.LuaException");
  if (luaExCls !== null) {
    for (const method of luaExCls.methods) {
      if (method.name !== ".ctor") continue;
      try {
        Interceptor.attach(method.virtualAddress, {
          onEnter(args) {
            send({ t: "lua-exception", msg: readString(args[1]) });
          },
        });
        installed.push("LuaException..ctor");
      } catch (e) {
        installed.push("LuaException..ctor(fail:" + e + ")");
      }
    }
  }
  if (debugCls !== null) {
    for (const method of debugCls.methods) {
      if (method.name !== "LogException") continue;
      let sig = "?";
      try {
        sig = method.parameters.map((x) => x.type.name).join(",");
      } catch (e) {
        sig = "?";
      }
      try {
        Interceptor.attach(method.virtualAddress, {
          onEnter(args) {
            let text: string | null = null;
            try {
              text = new Il2Cpp.Object(args[0]).method("ToString").invoke().content;
            } catch (e) {
              text = "<读异常文本失败:" + e + ">";
            }
            send({ t: "log-exception", sig: sig, text: text === null ? null : text.slice(0, 600) });
          },
        });
        installed.push("Debug.LogException(" + sig + ")");
      } catch (e) {
        installed.push("Debug.LogException(fail:" + e + ")");
      }
    }
  }
  return installed;
}

/**
 * 在游戏销毁 LuaEnv 之前先卸载插件（释放 xLua 的 C# 回调），否则 xLua 会抛异常并 abort。
 * @param klass - LuaManager 类
 * @returns 已挂钩子的方法名列表
 */
function hookLuaDispose(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];
  for (const method of klass.methods) {
    if (method.name !== "_DoDisposeLuaEnv" && method.name !== "Dispose") continue;
    try {
      Interceptor.attach(method.virtualAddress, {
        onEnter() {
          send({ t: "lua-dispose", fn: method.name });
          runLuaCleanup(method.name);
        },
      });
      installed.push(method.name);
    } catch (e) {
      installed.push(method.name + "(fail:" + e + ")");
    }
  }
  return installed;
}

/**
 * 直接挂 `XLua.LuaEnv.Dispose`（真正抛 `try to dispose a LuaEnv with C# callback!` 的地方）。
 *
 * 为什么不能只挂 `LuaManager`：客户端的官方 Lua 会把 `LuaManager` 的一堆方法 hotfix 掉
 * （C# 里满屏 `__Hotfix0_*`），调用会走 DelegateBridge，我们挂在原方法体上的钩子**根本不会触发**
 * （实测 `_DoDisposeLuaEnv`/`Dispose` 一次都没进来）。所以要挂到 xLua 自己的 Dispose 上，
 * 并在那里先卸载插件、再打出调用栈，定位"谁在释放 LuaEnv"。
 * @param klass - XLua.LuaEnv 类
 * @returns 已挂钩子的方法名列表
 */
function hookLuaEnvDispose(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];
  for (const method of klass.methods) {
    if (method.name !== "Dispose") continue;
    let sig = "?";
    try {
      sig = method.parameters.map((x) => x.type.name).join(",");
    } catch (e) {
      sig = "?";
    }
    try {
      Interceptor.attach(method.virtualAddress, {
        onEnter() {
          let frames = "";
          try {
            frames = Thread.backtrace(this.context, Backtracer.FUZZY)
              .slice(0, 5)
              .map((f) => f.toString())
              .join(" ");
          } catch (e) {
            frames = "bt-fail";
          }
          send({ t: "luaenv-dispose", sig: sig, bt: frames });
          runLuaCleanup("LuaEnv.Dispose(" + sig + ")");
        },
      });
      installed.push("Dispose(" + sig + ")");
    } catch (e) {
      installed.push("Dispose(" + sig + ")(fail:" + e + ")");
    }
  }
  return installed;
}

/**
 * 在主线程上跑一次浮窗探针并把结果发回宿主机。
 * @param toggle - 是否顺便开合面板
 */
function probePluginUi(toggle: boolean, invokeRow = false): void {
  const manager = luaManagerPtr;
  send({ t: "ui-probe-enter", toggle: toggle, invokeRow: invokeRow, hasMgr: manager !== null });
  if (manager === null) return;
  const env = readLuaEnv(manager);
  if (env === null) return;
  try {
    const result = env
      .method("DoString")
      .overload("System.String", "System.String", "XLua.LuaTable")
      .invoke(
        Il2Cpp.string(buildUiProbeChunk(toggle, invokeRow)),
        Il2Cpp.string(toggle ? "dts_ui_probe_open" : "dts_ui_probe"),
        NULL,
      );
    const handle = (result as Il2Cpp.Array).handle;
    const count = handle.add(0x18).readS32();
    const text = count > 0 ? readString(handle.add(0x20).readPointer()) : null;
    send({ t: "plugin-ui", toggle: toggle, invokeRow: invokeRow, text: text });
  } catch (e) {
    send({ t: "plugin-ui", toggle: toggle, text: null, err: String(e) });
  }
}

/**
 * 在游戏主线程上调用 `m_env.DoString(payload)`，经返回值判定插件系统是否起来。
 * @param manager - LuaManager 实例指针（来自 `_DoUpdate` / `_CustomLoader` 的 this）
 */
function tryInjectLua(manager: NativePointer): void {
  if (luaInjected || injectAttempts >= MAX_INJECT_ATTEMPTS) return;
  const env = readLuaEnv(manager);
  if (env === null) return; // LuaEnv 还没建，等下一帧（不计入尝试次数）
  injectAttempts += 1;
  const payload = buildLuaPayload();
  try {
    const result = env
      .method("DoString")
      .overload("System.String", "System.String", "XLua.LuaTable")
      .invoke(Il2Cpp.string(payload), Il2Cpp.string("dts_frida_inject"), NULL);
    // DoString 返回 System.Object[]（chunk 的返回值列表）：第 0 个元素即插件自检结论
    const handle = (result as Il2Cpp.Array).handle;
    const count = handle.add(0x18).readS32();
    const text = count > 0 ? readString(handle.add(0x20).readPointer()) : null;
    // 判定用前缀匹配：payload 成功时返回 `DTS_PLUGIN_OK <各插件状态>`
    const ok = text !== null && text.indexOf("DTS_PLUGIN_OK") === 0;
    luaInjected = ok;
    if (ok) {
      // 插件起来后再验浮窗：Canvas 可能要等主 UI 才就绪（PluginUI 有自愈重试），所以看两次
      setTimeout(() => probePluginUi(false), 20000);
      setTimeout(() => probePluginUi(false, true), 45000); // ★ 实际功能：点第一行开关
      setTimeout(() => probePluginUi(true), 75000);        // 再顺带验证开合
    }
    send({
      t: "lua-inject",
      ok: ok,
      attempt: injectAttempts,
      payloadBytes: payload.length,
      retCount: count,
      ret: text,
    });
  } catch (e) {
    let sig = "?";
    try {
      sig = env
        .method("DoString")
        .parameters.map((p) => p.type.name)
        .join(",");
    } catch (inner) {
      sig = "读取签名失败:" + inner;
    }
    send({
      t: "lua-inject",
      ok: false,
      attempt: injectAttempts,
      payloadBytes: payload.length,
      err: String(e),
      sig: sig,
    });
  }
}

/**
 * 注入时序门禁：`LuaManager._DoLoadEntryScript` 返回后置位。
 * 该返回点在 `entry`/hotfix 链执行完之后、Lua 栈退空时（trace 实测：此方法 → `_DoLoad` → `_CustomLoader`）。
 * @param klass - LuaManager 类
 * @returns 已挂钩子的方法名列表
 */
function hookEntryScriptDone(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];
  for (const method of klass.methods) {
    if (method.name !== "_DoLoadEntryScript") continue;
    try {
      Interceptor.attach(method.virtualAddress, {
        onLeave() {
          entryScriptDone = true;
          send({ t: "entry-script-done", frames: updateFrames });
        },
      });
      installed.push("_DoLoadEntryScript");
    } catch (e) {
      installed.push("_DoLoadEntryScript(fail:" + e + ")");
    }
  }
  return installed;
}

/**
 * 安全注入点：`LuaManager._DoUpdate(deltaTime)` 的 onEnter。
 * 由 Unity Update 循环驱动 ⇒ 游戏主线程、不在任何 Lua 调用栈内（不会在 require 的 searcher 里重入 VM）。
 * 门禁：等 `_DoLoadEntryScript` 跑完（`Class` 等游戏侧 Lua 全局已就绪）再注入；超过 FALLBACK_FRAMES 帧兜底。
 * @param klass - LuaManager 类
 * @returns 已挂钩子的方法名列表
 */
/**
 * 排一次浮窗探针（幂等）。
 *
 * 为什么要单独抽出来：`LuaManager._DoUpdate` 在**某些客户端状态**下并不是每帧都调用
 * （实测同一脚本有时能排上、有时整段错过），而 `GlobalInitializerAndUpdater.Update`
 * 是确定的每帧入口（资产内引导的帧轮询就挂在它上面）。两处都调，保证一定排上。
 */
function maybeScheduleUiProbes(): void {
  if (uiProbeStage !== 0) return;
  if (!entryScriptDone || luaInjected || PUBKEY_MODE !== "oursonly") return;
  uiProbeStage = 1;
  send({ t: "ui-probe-scheduled", mode: PUBKEY_MODE, frames: updateFrames });
  setTimeout(() => probePluginUi(false), 20000);
  setTimeout(() => probePluginUi(false, true), 45000); // ★ 实际功能：点第一行开关
  setTimeout(() => probePluginUi(true), 75000);
}

/**
 * 把浮窗探针排程挂到「确定的每帧入口」`GlobalInitializerAndUpdater.Update` 上。
 * @param klass - Torappu.GlobalInitializerAndUpdater 类
 * @returns 已挂钩子的方法名列表
 */
function hookGlobalInitUpdate(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];
  for (const method of klass.methods) {
    if (method.name !== "Update") continue;
    try {
      Interceptor.attach(method.virtualAddress, {
        onEnter() {
          updateFrames += 1;
          maybeScheduleUiProbes();
        },
      });
      installed.push("GlobalInitializerAndUpdater.Update");
    } catch (e) {
      installed.push("GlobalInitializerAndUpdater.Update(fail:" + e + ")");
    }
  }
  return installed;
}

function hookLuaUpdate(klass: Il2Cpp.Class): string[] {
  const installed: string[] = [];
  for (const method of klass.methods) {
    if (method.name !== "_DoUpdate") continue;
    try {
      Interceptor.attach(method.virtualAddress, {
        onEnter(args) {
          luaManagerPtr = args[0];
          // 每帧兜底清一次「Lua 加载中」标记：`_CustomLoader` 若抛异常，其 onLeave 不会执行，
          // 标记残留会让后续非 Lua 的验签也换公钥（那是会把 DB/excel 阶段打死的事故）。
          luaLoaderDepth = 0;
          updateFrames += 1;
          // 浮窗探针（与"谁把插件送进来"无关）：entry 脚本跑完后再等约 20s / 45s，
          // 分别看一次面板状态与"开合后"的状态。`uiProbeStage` 保证各自只跑一次。
          maybeScheduleUiProbes();
          if (luaInjected) return;
          if (!entryScriptDone && updateFrames < FALLBACK_FRAMES) return;
          tryInjectLua(args[0]);
        },
      });
      installed.push("_DoUpdate");
    } catch (e) {
      installed.push("_DoUpdate(fail:" + e + ")");
    }
  }
  return installed;
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
    // (String,String,String)：网络响应（内容、签名 base64、公钥）→ 换成我们的公钥
    if (params === "System.String,System.String,System.String") {
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
        installed.push("VerifySignMD5RSA(String..)(fail:" + e + ")");
      }
      continue;
    }
    // (Byte[],Byte[],String)：这个重载**两边都在用** —— Lua 资产（`_CustomLoader` 内）与
    // excel/DB 的 `CrypticConverter_WithSign` 资产。换公钥必须**只在 Lua 加载上下文里**做，
    // 否则②的官方签名验不过（实测会让客户端卡在 DB 阶段，Lua 一个都不加载）。
    if (params !== "System.Byte[],System.Byte[],System.String") continue;
    try {
      Interceptor.attach(method.virtualAddress, {
        onEnter(args) {
          stats.verifyCalls += 1;
          binVerifyCalls += 1;
          if (PUBKEY_MODE === "asis") return;
          if (luaLoaderDepth <= 0) return; // 非 Lua 上下文：保持官方公钥
          const given = readString(args[2]);
          let next = "";
          if (PUBKEY_MODE === "ours" || PUBKEY_MODE === "oursonly") {
            next = pubkey;
          } else if (PUBKEY_MODE === "flip") {
            next = OFFICIAL_PUBKEY_LE;
          } else if (given !== null && given.indexOf("RSAKeyValue") >= 0) {
            // ab：奇数轮原样（大端），偶数轮反转（小端）
            next = binVerifyCalls % 2 === 1 ? OFFICIAL_PUBKEY_BE : OFFICIAL_PUBKEY_LE;
          }
          if (next.length === 0) return;
          try {
            args[2] = Il2Cpp.string(next).handle;
            stats.keysReplaced += 1;
          } catch (e) {
            /* 写不进去就保持原样 */
          }
        },
        onLeave(retval) {
          if (binLogs >= MAX_BIN_LOG) return;
          binLogs += 1;
          send({
            t: "verify-bin",
            call: binVerifyCalls,
            ok: retval.toInt32() !== 0,
            mode: PUBKEY_MODE,
            form: PUBKEY_MODE === "ab" ? (binVerifyCalls % 2 === 1 ? "BE(as-is)" : "LE(flipped)") : PUBKEY_MODE,
          });
        },
      });
      installed.push("VerifySignMD5RSA(Byte[],Byte[],String)");
    } catch (e) {
      installed.push("VerifySignMD5RSA(Byte..)(fail:" + e + ")");
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
          luaManagerPtr = args[0]; // this（LuaManager 实例）——供后续经 m_env.DoString 注入插件
          luaLoaderDepth += 1; // 标记「当前在 Lua 资产加载上下文」（验签换公钥要用它区分）
          // 注意：这里**不**注入。`_CustomLoader` 是 xLua searcher 的回调，
          // 此刻 Lua 调用栈是活的（正在 require），重入 Lua VM 会破坏状态；
          // 注入统一放在 `_DoUpdate` 的 onEnter（见 hookLuaUpdate）。
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
          luaLoaderDepth = luaLoaderDepth > 0 ? luaLoaderDepth - 1 : 0;
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
send({
  t: "pubkey",
  loaded: stats.pubkeyLoaded,
  length: pubkey.length,
  path: PUBKEY_PATH,
  mode: PUBKEY_MODE,
  officialInjected: OFFICIAL_PUBKEY_BE.length > 100 && OFFICIAL_PUBKEY_LE.length > 100,
});

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
    luaEntryScript: luaMgrCls === null ? [] : hookEntryScriptDone(luaMgrCls),
    luaUpdate: luaMgrCls === null ? [] : hookLuaUpdate(luaMgrCls),
    globalUpdate: (() => {
      const giCls = findClass("Torappu.GlobalInitializerAndUpdater");
      return giCls === null ? [] : hookGlobalInitUpdate(giCls);
    })(),
    luaDispose: luaMgrCls === null ? [] : hookLuaDispose(luaMgrCls),
    luaEnvDispose: (() => {
      const envCls = findClass("XLua.LuaEnv");
      return envCls === null ? [] : hookLuaEnvDispose(envCls);
    })(),
    exceptionDiag: (() => {
      const envCls = findClass("XLua.LuaEnv");
      if (envCls === null) return [];
      return hookExceptionDiagnostics(envCls, findClass("UnityEngine.Debug"));
    })(),
    pluginModules: Object.keys(LUA_MODULES).length,
  });
}).catch((e: Error) => send({ t: "il2cpp-fail", err: String(e), stack: e.stack }));

setInterval(() => {
  send({ t: "stats", ...stats });
}, 8000);
/* ---------------------------------------------------------------------------
 * 双信任锚：JS 侧自行按「我们的公钥」复算 128B RSA/MD5 签名
 *
 * 为什么需要：客户端会在 `_CustomLoader` **之外**（典型场景：mod bundle 被判"脏"后的加载前
 * 校验）调同一个 `VerifySignMD5RSA(byte[],byte[],string)`。那种上下文里按既有设计必须保持
 * 官方公钥（否则官方 excel/DB 资产全挂），于是我们重签的内容必然验不过 → Lua 入口拿不到内容
 * → 未捕获 LuaException → 客户端 abort（详见 docs/lua-mod-delivery-2026-09-14.md §6.1）。
 * 这里在 JS 里独立复算 MD5 + RSA-1024/PKCS#1 v1.5：只要内容确实是**我们**签的，就把返回值
 * 强制算成功——客户端此刻拿的是哪把公钥都不再影响我们的资产；官方资产仍走客户端自身验签。
 * ------------------------------------------------------------------------- */

/** MD5 常量表（sin 表前 64 项）。 */
const MD5_K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);
/** MD5 每轮的循环左移位数。 */
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
/** PKCS#1 v1.5 里 MD5 的 DigestInfo 前缀（`30 20 30 0c 06 08 2a864886f70d02050500 04 10`）。 */
const MD5_DIGEST_INFO = [0x30, 0x20, 0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05, 0x05, 0x00, 0x04, 0x10];
/** 锚点复算的内容上限：Lua 脚本都是 KB 级，超过这个尺寸（excel/DB 大 blob）直接不参与。 */
const ANCHOR_MAX_BYTES = 256 * 1024;
/** 锚点日志上限（避免刷屏）。 */
const MAX_ANCHOR_LOG = 20;
/** 我们公钥解析出的 { n, e }（自检失败保持 null → 锚点整体禁用）。 */
let anchorKey: { n: bigint; e: bigint } | null = null;
/** 锚点是否可用（运行时自检：BigInt 可用 + MD5 向量正确 + 公钥可解析）。 */
let anchorReady = false;
/** `verify-anchor` 已强制放行的次数 */
let anchorForced = 0;
/** 锚点自身报错次数（限流上报） */
let anchorErrors = 0;
/** 每线程的锚点判定（onEnter 计算、onLeave 应用；按线程隔离避免交叉调用串味） */
const anchorByThread = new Map<number, boolean>();

/** 字节转十六进制（诊断用）。 */
function hexBytes(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += (byte < 16 ? "0" : "") + byte.toString(16);
  return out;
}

/** 字节数组比较。 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 纯 JS 的 MD5（Frida 的 QuickJS 没有 node:crypto，也不保证有 TextEncoder）。
 * @param input - 输入字节
 * @returns 16 字节摘要
 */
function md5Bytes(input: Uint8Array): Uint8Array {
  const len = input.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[len] = 0x80;
  const bitLen = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i] + words[g]) >>> 0;
      b = (b + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/** base64 解码（自带实现：QuickJS 不保证有 atob）。 */
function base64Decode(text: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    let value = -1;
    if (ch >= 65 && ch <= 90) value = ch - 65;
    else if (ch >= 97 && ch <= 122) value = ch - 71;
    else if (ch >= 48 && ch <= 57) value = ch + 4;
    else if (ch === 43) value = 62;
    else if (ch === 47) value = 63;
    else if (ch === 61) break;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** 大端字节 → BigInt。 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** BigInt → 定长大端字节。 */
function bigIntToBytes(value: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let rest = value;
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** 模幂（平方-乘）。 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * 解析 .NET XML 公钥（Modulus/Exponent 的 base64 按大端直读，与 scripts/vendor/lua-crypt.ts 一致）。
 * @param xml - 公钥 XML
 * @returns { n, e }，解析失败返回 null
 */
function parsePublicKey(xml: string): { n: bigint; e: bigint } | null {
  const modulus = /<Modulus>([^<]+)<\/Modulus>/.exec(xml);
  const exponent = /<Exponent>([^<]+)<\/Exponent>/.exec(xml);
  if (modulus === null || exponent === null) return null;
  try {
    return { n: bytesToBigInt(base64Decode(modulus[1])), e: bytesToBigInt(base64Decode(exponent[1])) };
  } catch (e) {
    return null;
  }
}

/**
 * PKCS#1 v1.5 + MD5 验签（signature 覆盖 payload）。
 * @param payload - 被签内容
 * @param signature - 128B 签名
 * @param key - 公钥
 * @returns 是否验签通过
 */
function rsaVerifyMd5(payload: Uint8Array, signature: Uint8Array, key: { n: bigint; e: bigint }): boolean {
  if (payload.length === 0 || signature.length === 0) return false;
  const block = bigIntToBytes(modPow(bytesToBigInt(signature), key.e, key.n), 128);
  if (block[0] !== 0x00 || block[1] !== 0x01) return false;
  let index = 2;
  while (index < block.length && block[index] === 0xff) index += 1;
  if (index >= block.length || block[index] !== 0x00) return false;
  index += 1;
  const tail = block.subarray(index);
  if (tail.length !== MD5_DIGEST_INFO.length + 16) return false;
  for (let i = 0; i < MD5_DIGEST_INFO.length; i += 1) if (tail[i] !== MD5_DIGEST_INFO[i]) return false;
  const digest = md5Bytes(payload);
  for (let i = 0; i < 16; i += 1) if (tail[MD5_DIGEST_INFO.length + i] !== digest[i]) return false;
  return true;
}

/**
 * 读一个托管 byte[] 的内容（il2cpp 数组：长度 +0x18，数据 +0x20）。
 * 超过 {@link ANCHOR_MAX_BYTES} 直接返回 null（大 blob 不参与锚点）。
 * @param ptr - 托管数组指针
 * @returns 字节内容或 null
 */
function readManagedBytes(ptr: NativePointer | null): Uint8Array | null {
  if (ptr === null || ptr.isNull()) return null;
  try {
    const length = ptr.add(0x18).readS32();
    if (length <= 0 || length > ANCHOR_MAX_BYTES) return null;
    const raw = ptr.add(0x20).readByteArray(length);
    return raw === null ? null : new Uint8Array(raw);
  } catch (e) {
    return null;
  }
}

/**
 * 判断这次验签的两个 byte[] 是否构成「我们的签名 + 我们的载荷」。
 * 参数顺序按 `VerifySignMD5RSA(byte[] content, byte[] signature, string pubkey)`，
 * 但客户端两种顺序都可能出现，故两个方向都试；载荷可能含 128B 头（此时摘要覆盖 [128:]）。
 * @param first - 第一参数
 * @param second - 第二参数
 * @param key - 我们的公钥
 * @returns 是否是我们签的内容
 */
function anchorMatches(first: Uint8Array | null, second: Uint8Array | null, key: { n: bigint; e: bigint }): boolean {
  if (first === null || second === null) return false;
  const pairs: [Uint8Array, Uint8Array][] = [
    [second, first],
    [first, second],
  ];
  for (const [signature, content] of pairs) {
    if (signature.length !== 128) continue;
    if (content.length > 128 && bytesEqual(content.subarray(0, 128), signature) && rsaVerifyMd5(content.subarray(128), signature, key)) {
      return true;
    }
    if (rsaVerifyMd5(content, signature, key)) return true;
  }
  return false;
}

/** 锚点自检（惰性一次）：BigInt + MD5 向量 + 公钥解析；任一不满足就整体禁用并上报原因。 */
function initAnchor(): void {
  if (anchorKey !== null || anchorReady) return;
  try {
    if (typeof BigInt !== "function") {
      send({ t: "verify-anchor-selftest", ok: false, reason: "no-bigint" });
      return;
    }
    const probe = md5Bytes(new Uint8Array([0x61, 0x62, 0x63]));
    const digest = hexBytes(probe);
    const key = parsePublicKey(pubkey);
    anchorKey = key;
    anchorReady = digest === "900150983cd24fb0d6963f7d28e17f72" && key !== null;
    send({
      t: "verify-anchor-selftest",
      ok: anchorReady,
      md5: digest,
      keyBits: key === null ? 0 : key.n.toString(16).length * 4,
    });
  } catch (e) {
    send({ t: "verify-anchor-selftest", ok: false, reason: String(e) });
  }
}

      // 诊断用：该次调用进钩子时的 Lua 加载深度，以及是否真的把公钥换成了我们的
      // （`luaLoaderDepth <= 0` 会静默保持官方公钥 → 我们重签的 Lua 必然验签失败）
      let callDepth = 0;
      let callKeyReplaced = false;
          callDepth = luaLoaderDepth;
          callKeyReplaced = false;
          // 双信任锚：先记下「这次的内容是不是我们签的」（客户端用哪把公钥都不影响判定）
          if (!anchorReady) initAnchor();
          if (anchorReady && anchorKey !== null) {
            try {
              const first = readManagedBytes(args[0]);
              const second = readManagedBytes(args[1]);
              anchorByThread.set(Process.getCurrentThreadId(), anchorMatches(first, second, anchorKey));
            } catch (e) {
              anchorByThread.delete(Process.getCurrentThreadId());
            }
          }
            callKeyReplaced = true;
          const threadId = Process.getCurrentThreadId();
          const anchored = anchorByThread.get(threadId) === true;
          anchorByThread.delete(threadId);
          if (anchored && retval.toInt32() === 0) {
            // 内容确实是我们签的，但客户端此刻用的是官方公钥（例如 mod bundle 被判脏后的
            // 加载前校验）——直接算成功，避免 Lua 入口拿不到内容而 abort。
            try {
              retval.replace(1);
              anchorForced += 1;
              if (anchorForced <= MAX_ANCHOR_LOG) {
                send({ t: "verify-anchor", call: binVerifyCalls, depth: callDepth, forced: true });
              }
            } catch (e) {
              if (anchorErrors < 3) {
                anchorErrors += 1;
                send({ t: "verify-anchor-err", err: String(e) });
              }
            }
          }
            depth: callDepth,
            keyReplaced: callKeyReplaced,
initAnchor();
