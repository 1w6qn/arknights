/**
 * Frida 验签 hook（原生 il2cpp，免编译，直接用 frida -U -l 加载）
 *
 * 作用：定位并 hook 客户端验签入口 `Torappu.CryptUtils.VerifySignMD5RSA`（string/byte[] 两个重载），
 *   - 打印每次验签的 内容长度 / 签名 / 客户端使用的公钥（确认 asset 公钥是否已被替换）；
 *   - `FORCE_TRUE = true` 时把返回值强制为 true（等价于 Lua 插件 bypass 模式，供 PC 端调试）；
 *   - `OVERRIDE_PUBLIC_KEY` 非空时，把实参里的公钥替换为我方公钥（真实验签路径，不改变返回值语义）。
 *
 * 用法（PC 客户端）：
 *   frida -U -f com.hypergryph.arknights -l hook/verify-sign.js --runtime=v8
 * 用法（Android，需 frida-server 且进程内可见 libil2cpp.so；MuMu 的 ARM 翻译层下宿主 Frida
 *   枚举不到 guest 模块，此时脚本会报「libil2cpp.so 未加载」——见 docs/apk-mod-2771-2026-09-13.md §8.3）
 *
 * 配套：`pnpm run sign:key -- --show` 输出的 public.xml 填进 OVERRIDE_PUBLIC_KEY。
 */
var FORCE_TRUE = false;
var OVERRIDE_PUBLIC_KEY = "";
var LOG_ONLY = !FORCE_TRUE && OVERRIDE_PUBLIC_KEY === "";

(function () {
  var mod = null;
  for (var i = 0; i < 400; i++) {
    try {
      mod = Process.findModuleByName("libil2cpp.so");
    } catch (e) {
      mod = null;
    }
    if (mod !== null) break;
    Thread.sleep(0.05);
  }
  if (mod === null) {
    console.log("[verify-sign] libil2cpp.so 未加载（guest 模块对宿主 Frida 不可见？）");
    return;
  }

  function ex(n) {
    var p = mod.findExportByName(n);
    if (p === null) throw new Error("缺少导出: " + n);
    return p;
  }
  var domainGet = new NativeFunction(ex("il2cpp_domain_get"), "pointer", []);
  var assemblyOpen = new NativeFunction(ex("il2cpp_domain_assembly_open"), "pointer", ["pointer", "pointer"]);
  var assemblyGetImage = new NativeFunction(ex("il2cpp_assembly_get_image"), "pointer", ["pointer"]);
  var classFromName = new NativeFunction(ex("il2cpp_class_from_name"), "pointer", ["pointer", "pointer", "pointer"]);
  var getMethod = new NativeFunction(ex("il2cpp_class_get_method_from_name"), "pointer", ["pointer", "pointer", "int"]);

  var str = function (s) {
    return Memory.allocUtf8String(s);
  };

  // 程序集名：验签类在 Assembly-CSharp（Torappu.CryptUtils）
  var images = [];
  ["Assembly-CSharp"].forEach(function (name) {
    var a = assemblyOpen(domainGet(), str(name));
    if (!a.isNull()) images.push(assemblyGetImage(a));
  });
  if (images.length === 0) {
    console.log("[verify-sign] 未找到 Assembly-CSharp 程序集");
    return;
  }

  function hookOverload(argc) {
    var klass = classFromName(images[0], str("Torappu"), str("CryptUtils"));
    if (klass.isNull()) {
      console.log("[verify-sign] 未找到 Torappu.CryptUtils");
      return;
    }
    var mi = getMethod(klass, str("VerifySignMD5RSA"), argc);
    if (mi.isNull()) {
      console.log("[verify-sign] 未找到 VerifySignMD5RSA/" + argc + " 参数重载");
      return;
    }
    var mp = mi.readPointer();

    var readIl2CppString = function (p) {
      try {
        if (p.isNull()) return "(null)";
        var len = p.add(0x10).readS32();
        return p.add(0x14).readUtf16String(len);
      } catch (e) {
        return "(读取失败)";
      }
    };

    Interceptor.attach(mp, {
      onEnter: function (args) {
        var content = readIl2CppString(args[1]);
        var sign = readIl2CppString(args[2]);
        var pub = readIl2CppString(args[3]);
        console.log(
          "[verify-sign] argc=" + argc +
            " content.len=" + (content === null ? "?" : content.length) +
            " sign=" + String(sign).slice(0, 24) + "…" +
            " pubKey=" + String(pub).slice(0, 60) + "…"
        );
        // 公钥替换（真实验签）：把实参指向我方公钥
        if (OVERRIDE_PUBLIC_KEY !== "" && !args[3].isNull()) {
          try {
            var mi2 = ex("il2cpp_string_new");
            var newStr = new NativeFunction(mi2, "pointer", ["pointer"]);
            var p = newStr(str(OVERRIDE_PUBLIC_KEY));
            if (!p.isNull()) {
              args[3] = p;
              console.log("[verify-sign] 已把公钥实参替换为我方公钥");
            }
          } catch (e) {
            console.log("[verify-sign] 公钥替换失败: " + e);
          }
        }
        this.forceTrue = FORCE_TRUE;
      },
      onLeave: function (retval) {
        if (this.forceTrue) {
          console.log("[verify-sign] 原返回值=" + retval + " → 强制 true");
          retval.replace(ptr(1));
        }
      },
    });
    console.log("[verify-sign] 已 hook VerifySignMD5RSA/" + argc + " @ " + mp + (LOG_ONLY ? "（只观察）" : ""));
  }

  hookOverload(3);
  console.log("[verify-sign] 就绪（FORCE_TRUE=" + FORCE_TRUE + "，OVERRIDE_PUBLIC_KEY=" + (OVERRIDE_PUBLIC_KEY ? "有" : "无") + "）");
})();
