/*
 * 宿主侧（x86_64）日志采集：挂 /system/lib64/liblog.so 的 __android_log_print / __android_log_write。
 *
 * 为什么需要它：Java 层（android.util.Log）与宿主原生库的日志走宿主 x86_64 liblog，
 * 而 ARM guest liblog 只承载 ARM64 原生代码的日志。两路合起来才是完整日志。
 * 由 x86_64 frida-server 加载（普通 JS，无需打包）。
 */
(function () {
  var stats = { print: 0, write: 0, dropped: 0, suppressed: 0 };
  // 需要过滤时改这里，例如 /^(HG_|Unity|Torappu|xlua)/i
  var TAG_FILTER = null;
  // 噪声标签黑名单：MuMu 的 houdini 转译层用 __android_log_print 高频打 "[%d] %s"
  // （实测单轮 27.5 万行 / 14.9MB，占整份日志 99.96%），必须丢弃——否则日志文件与
  // agent 消息通道被淹没（曾拖出 DSH 进程内存压力崩溃），有用信号也读不出来。
  var TAG_DENY = /^(houdini|Houdini)$/;
  // 单轮 agent 消息上限：兜底防某个标签刷屏把通道打爆（超限只计数，不再 send）
  var MAX_SEND = 4000;
  var sent = 0;

  function cstr(p) {
    try {
      return p.isNull() ? "<null>" : (p.readCString() || "");
    } catch (e) {
      return "<unreadable>";
    }
  }

  function wanted(tag) {
    if (TAG_DENY.test(tag)) {
      stats.dropped += 1;
      return false;
    }
    return TAG_FILTER === null || TAG_FILTER.test(tag);
  }

  function emit(payload) {
    if (sent >= MAX_SEND) {
      stats.suppressed += 1;
      return;
    }
    sent += 1;
    send(payload);
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
        if (wanted(tag)) emit({ t: "log", src: "host", fn: "log_write", tag: tag, text: cstr(args[2]) });
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
        emit({ t: "log", src: "host", fn: "log_print", tag: tag, text: extra === null ? fmt : fmt.replace(/%[sdu]/, extra) });
      },
    });
  }

  send({ t: "host-hooks", installed: ["__android_log_write@" + (writeAddr === null ? "-" : writeAddr.toString()),
                                     "__android_log_print@" + (printAddr === null ? "-" : printAddr.toString())] });
  setInterval(function () { send({ t: "stats", ...stats }); }, 5000);
})();
