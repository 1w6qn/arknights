import Java from "frida-java-bridge";

/*
 * Java 层域名重定向（跑在 x86_64 agent 里）。
 *
 * 为什么需要它：游戏的 Unity/il2cpp 流量由 hook/il2cpp-client-redirect.ts 处理，
 * 但 HGSDK 登录/账号/公告等请求走 Java 侧 okhttp（core-api-account-stable.hypergryph.net、
 * launcher.hypergryph.com…），il2cpp 钩子覆盖不到——客户端就会卡在登录界面。
 *
 * 做法：改写 okhttp 的 URL 入口（host→host+x，https→http），配合设备 /etc/hosts
 * 与 adb reverse 指到私服；并放开明文流量限制（改 http 后 Android 9+ 默认禁止明文）。
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

const MAX_LOG = 80;
const stats = { seen: 0, rewritten: 0, javaErrors: 0 };

/**
 * Java 类的方法表视图：`Java.use<T>` 的类型参数须满足 `T extends Members<T>` 约束，
 * 用索引签名表达"按方法名取重载派发器"——避免 `as unknown as` 逃逸（类型债棘轮禁用）。
 */
type JavaMethodTable = Record<string, Java.MethodDispatcher>;

/** URL 改写：仅命中映射表时改写，并强制 http。 */
function rewrite(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const hit = HOST_MAP.find((m) => url.indexOf(m.from) >= 0);
  if (hit === undefined) return null;
  let out = url.replace(hit.from, hit.to);
  out = out.replace(/^https:\/\//i, "http://");
  return out === url ? null : out;
}

Java.perform(() => {
  const installed: string[] = [];

  /** 给某个类的若干方法挂「读第一个字符串参数 → 命中就替换」。 */
  function hookStatics(className: string, methods: string[]): void {
    let klass: Java.Wrapper<JavaMethodTable> | null = null;
    try {
      klass = Java.use<JavaMethodTable>(className);
    } catch (e) {
      return; // 类不在（不同 okhttp 版本/未加载）
    }
    if (klass === null) return; // 显式收窄（TS 不对 try/catch 内的赋值做流分析）
    for (const name of methods) {
      try {
        const overloads = klass[name];
        if (overloads === undefined) continue;
        overloads.implementation = function (...args) {
          const first = args[0];
          if (typeof first === "string") {
            stats.seen += 1;
            const next = rewrite(first);
            if (next !== null) {
              stats.rewritten += 1;
              if (stats.rewritten <= MAX_LOG) send({ t: "java-url", fn: className + "." + name, url: first, rewritten: next });
              args[0] = next;
            } else if (stats.seen <= MAX_LOG) {
              send({ t: "java-url", fn: className + "." + name, url: first, rewritten: null });
            }
          }
          return overloads.call(this, ...args);
        };
        installed.push(className + "." + name);
      } catch (e) {
        stats.javaErrors += 1;
      }
    }
  }

  hookStatics("okhttp3.HttpUrl", ["get", "parse"]);
  hookStatics("okhttp3.Request$Builder", ["url"]);
  hookStatics("okhttp3.Request", ["url"]);

  // 改 http 后 Android 9+ 默认禁止明文流量 → 直接放行
  try {
    const policy = Java.use("android.security.NetworkSecurityPolicy");
    const instance = policy.getInstance();
    instance.isCleartextTrafficPermitted.overload("java.lang.String").implementation = function () {
      return true;
    };
    try {
      instance.isCleartextTrafficPermitted.overload().implementation = function () {
        return true;
      };
    } catch (e) {
      /* 无无参重载 */
    }
    installed.push("NetworkSecurityPolicy.isCleartextTrafficPermitted");
  } catch (e) {
    stats.javaErrors += 1;
  }

  send({ t: "java-hooks", installed: installed });
}).catch((e: Error) => send({ t: "java-hooks-fail", err: String(e) }));

setInterval(() => {
  send({ t: "java-stats", ...stats });
}, 8000);
