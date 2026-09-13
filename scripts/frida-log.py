#!/usr/bin/env python3
"""Frida 日志观察器（MuMu / Android）

用途：把 frida-server 注入游戏进程，劫持 `__android_log_print` / `__android_log_write`
（枚举**所有已加载与后续加载的模块**，兼容 MuMu 的 ARM 翻译层里另一份 libc），
把 Unity / xLua 的日志实时打到终端——用于确认 Lua 插件是否真的在客户端启动时加载。

依赖：frida Python 绑定。本仓免 pip 安装方式：脚本会自动把 `tmp/frida-py/`（由
`frida-17.x-cp37-abi3-manylinux*.whl` 解包而来）加入 sys.path。

用法：
  python3 scripts/frida-log.py --list                       # 列进程
  python3 scripts/frida-log.py --target com.hypergryph.arkmumu12            # attach 已运行进程
  python3 scripts/frida-log.py --target com.hypergryph.arkmumu12 --spawn    # 由 frida 拉起
  python3 scripts/frida-log.py --target com.hypergryph.arkmumu12 --spawn --grep Plugin,Network
  python3 scripts/frida-log.py --target com.hypergryph.arkmumu12 --extra hook/build/logcat.js

设备地址：默认 `$FRIDA_DEVICE`，否则 172.30.32.1:27043（Windows 侧
`adb forward tcp:27042 tcp:27042` + relay 27043→27042，见 docs/frida-mumu-2026-09-13.md）。
"""
import argparse
import os
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRIDA_PY_DIR = os.path.join(REPO_ROOT, "tmp", "frida-py")
DEFAULT_DEVICE = os.environ.get("FRIDA_DEVICE", "172.30.32.1:27043")

# 劫持 log 出口（attach 模式：进程已过早期初始化，稳定性优先——只挂少量模块、不追踪后续模块）
JS_PAYLOAD = r"""
(function () {
  var NAMES = ["__android_log_print", "__android_log_write"];
  var installed = [];
  var LIMIT = 4;
  Process.enumerateModules().forEach(function (m) {
    if (installed.length >= LIMIT) return;
    NAMES.forEach(function (fn) {
      if (installed.length >= LIMIT) return;
      var addr = null;
      try { addr = m.findExportByName(fn); } catch (e) { return; }
      if (addr === null) return;
      try {
        Interceptor.attach(addr, {
          onEnter: function (args) {
            try {
              var tag = args[1].readCString();
              var msg = args[2].readCString();
              if (tag !== null || msg !== null) {
                send({ t: "log", tag: tag === null ? "" : tag, msg: msg === null ? "" : msg });
              }
            } catch (e) { }
          }
        });
        installed.push(m.name + "!" + fn);
      } catch (e) { }
    });
  });
  send({ t: "ready", hooks: installed.length, detail: installed });
})();
"""


def load_frida():
    """导入 frida；缺依赖时回退到本仓解包的 wheel 目录。"""
    try:
        import frida  # type: ignore
        return frida
    except ImportError:
        if os.path.isdir(FRIDA_PY_DIR):
            sys.path.insert(0, FRIDA_PY_DIR)
            import frida  # type: ignore
            return frida
        raise SystemExit(
            "未找到 frida Python 绑定。请先解包 wheel 到 tmp/frida-py/：\n"
            "  curl -o tmp/frida-dl/frida.whl <frida-17.x-cp37-abi3-manylinux*.whl>\n"
            "  python3 -c \"import zipfile;zipfile.ZipFile('tmp/frida-dl/frida.whl').extractall('tmp/frida-py')\""
        )


def make_on_message(patterns):
    """构造 frida 消息回调：过滤并打印日志行。"""

    def on_message(message, data):
        if message.get("type") == "error":
            print("[frida][error] " + str(message.get("description") or message))
            return
        payload = message.get("payload") or {}
        kind = payload.get("t")
        if kind == "ready":
            print("[frida] hooks installed: %s %s" % (payload.get("hooks"), payload.get("detail") or ""))
            return
        if kind != "log":
            print("[frida] " + str(payload))
            return
        tag = payload.get("tag") or ""
        msg = payload.get("msg") or ""
        line = "%s: %s" % (tag, msg)
        if patterns and not any(p.lower() in line.lower() for p in patterns):
            return
        mark = ">>" if any(k in line for k in ("NetworkRedirectPlugin", "Plugin", "plugin")) else "  "
        print("%s %s" % (mark, line), flush=True)

    return on_message


def main():
    parser = argparse.ArgumentParser(description="Frida 日志观察器（Android/MuMu）")
    parser.add_argument("--device", default=DEFAULT_DEVICE, help="frida-server 地址 host:port")
    parser.add_argument("--target", default="com.hypergryph.arkmumu12", help="包名或进程名")
    parser.add_argument("--spawn", action="store_true", help="由 frida 拉起进程（否则 attach 已运行进程）")
    parser.add_argument("--list", action="store_true", help="只列进程")
    parser.add_argument("--grep", default="", help="逗号分隔的关键词过滤")
    parser.add_argument("--extra", default="", help="额外加载的 JS 文件（如 hook/build/logcat.js）")
    parser.add_argument("--duration", type=int, default=0, help="持续秒数（0=直到 Ctrl+C）")
    args = parser.parse_args()

    frida = load_frida()
    mgr = frida.get_device_manager()
    print("[frida] 连接 %s（host frida %s）" % (args.device, frida.__version__))
    device = mgr.add_remote_device(args.device)

    if args.list:
        for p in device.enumerate_processes():
            print("%6d  %s" % (p.pid, p.name))
        return

    patterns = [p for p in args.grep.split(",") if p]
    on_message = make_on_message(patterns)

    pid = None
    if args.spawn:
        pid = device.spawn([args.target])
        print("[frida] spawn %s → pid %d" % (args.target, pid))
        session = device.attach(pid)
    else:
        session = device.attach(args.target)
        print("[frida] attach %s" % args.target)

    payload = JS_PAYLOAD
    if args.extra:
        with open(args.extra, "r", encoding="utf-8") as fh:
            payload = payload + "\n;\n" + fh.read()
    script = session.create_script(payload)
    script.on("message", on_message)
    script.load()
    if pid is not None:
        device.resume(pid)
        print("[frida] resumed，开始输出日志（Ctrl+C 结束）")
    else:
        print("[frida] 开始输出日志（Ctrl+C 结束）")

    try:
        if args.duration > 0:
            time.sleep(args.duration)
        else:
            while True:
                time.sleep(1)
    except KeyboardInterrupt:
        print("\n[frida] 退出")
    finally:
        try:
            session.detach()
        except Exception:
            pass


if __name__ == "__main__":
    main()
