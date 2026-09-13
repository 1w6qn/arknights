/*
 * 宿主侧（x86_64）日志采集：挂 /system/lib64/liblog.so 的 __android_log_print / __android_log_write。
 *
 * 为什么需要它：Java 层（android.util.Log）与宿主原生库的日志走宿主 x86_64 liblog，
 * 而 ARM guest liblog 只承载 ARM64 原生代码的日志。两路合起来才是完整日志。
 * 由 x86_64 frida-server 加载（普通 JS，无需打包）。
 */
(function () {
  var stats = { print: 0, write: 0 };
  // 需要过滤时改这里，例如 /^(HG_|Unity|Torappu|xlua)/i
  var TAG_FILTER = null;

  function cstr(p) {
    try {
      return p.isNull() ? "<null>" : (p.readCString() || "");
    } catch (e) {
      return "<unreadable>";
    }
  }

  function wanted(tag) {
    return TAG_FILTER === null || TAG_FILTER.test(tag);
  }

  var mod = Process.findModuleByName("liblog.so");
  if (mod === null) {
    send({ t: "host-hooks", installed: [], err: "liblog.so 未加载" });
    return;
  }

  var writeAddr = mod.findExportByName("__android_log_write");
  if (writeAddr !== null) {
    Interceptor.attach(writeAddr, {
      onEnter: function (args) {
        stats.write += 1;
        var tag = cstr(args[1]);
        if (wanted(tag)) send({ t: "log", src: "host", fn: "log_write", tag: tag, text: cstr(args[2]) });
      },
    });
  }

  var printAddr = mod.findExportByName("__android_log_print");
  if (printAddr !== null) {
    Interceptor.attach(printAddr, {
      onEnter: function (args) {
        stats.print += 1;
        var tag = cstr(args[1]);
        if (!wanted(tag)) return;
        var fmt = cstr(args[2]);
        var extra = null;
        var first = fmt.indexOf("%");
        if (first >= 0 && fmt.indexOf("%", first + 1) < 0) {
          if (fmt.indexOf("%s") >= 0) extra = cstr(args[3]);
          else if (fmt.indexOf("%d") >= 0 || fmt.indexOf("%u") >= 0) extra = String(args[3].toInt32());
        }
        send({ t: "log", src: "host", fn: "log_print", tag: tag, text: extra === null ? fmt : fmt.replace(/%[sdu]/, extra) });
      },
    });
  }

  send({ t: "host-hooks", installed: ["__android_log_write@" + (writeAddr === null ? "-" : writeAddr.toString()),
                                     "__android_log_print@" + (printAddr === null ? "-" : printAddr.toString())] });
  setInterval(function () { send({ t: "stats", ...stats }); }, 5000);
})();
