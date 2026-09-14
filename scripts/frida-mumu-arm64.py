#!/usr/bin/env python3
"""MuMu 上把 Frida 接进 ARM64 il2cpp 的一键管线（双 agent）。

背景（详见 docs/frida-mumu-il2cpp-2026-09-13.md）
-----------------------------------------------
MuMu 的进程是 x86_64 的 `app_process64`，而游戏的 Unity/il2cpp 是 ARM64，
由网易自研翻译引擎（Houdini 包装层 `libnb.so` + `libhoudini.so`）在进程内翻译执行：

* x86_64 frida-server 能 attach（Java/宿主可见），但 Frida 的模块注册表**按架构过滤**，
  ARM64 的 libil2cpp.so/libunity.so 在 x86_64 agent 里根本枚举不到，跨架构 hook 也不可用；
* 只有把 **ARM64 的 frida-gadget** 装进进程，才有 arm64 agent，才能 hook il2cpp。

装载 gadget 的关键一步：`System.load` / `Runtime.load` 会通过 VMStack 取调用者类，
从原生线程调用会拿到 null → NPE；因此直接调私有 `Runtime.load0(Class, String)`，
显式传入应用自己的 Class（其 ClassLoader 是 PathClassLoader），
再经 ART `OpenNativeLibrary → NativeBridge(NativeBridgeItf.loadLibrary) → Houdini`
把 ARM64 的 gadget 映射进来。官方包无需改 APK、无需重签名，因此不会触发 ACE。

流程
----
1. 冷启动目标包（可关）
2. x86_64 frida-server attach → 加载 hook/build/inject-gadget.js 装 ARM64 gadget
3. 等 gadget 监听端口起来
4. x86_64 agent 常驻：挂宿主 liblog（Java/HGSDK 日志）
5. 连 gadget（arm64 agent）：挂 il2cpp 托管日志 + ARM guest liblog
6. 两路消息合成一条时间线打印

用法
----
  # 首次：把 gadget 装到设备（默认从 reference/obs 的 OpenBachelorG 包里抽）
  python3 scripts/frida-mumu-arm64.py --install-gadget

  # 冷启动 + 注入 + 挂日志
  python3 scripts/frida-mumu-arm64.py --duration 60

  # 不重启，直接注入当前进程
  python3 scripts/frida-mumu-arm64.py --no-restart --duration 30

  # 只看宿主日志（Java/HGSDK）
  python3 scripts/frida-mumu-arm64.py --host-only --duration 30

环境变量
--------
  ADB             adb 可执行文件（缺省用 MuMu 自带的）
  FRIDA_DEVICE    x86_64 frida-server 地址（缺省 172.30.32.1:27043）
  GADGET_DEVICE   arm64 gadget 地址（缺省 172.30.32.1:27098）
  GADGET_PORT     设备内 gadget 端口（缺省 27099）
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "tmp", "frida-py"))
import frida  # noqa: E402

DEFAULT_ADB = "/mnt/d/Program Files/YXArkNights-12.0/shell/adb.exe"
ADB = os.environ.get("ADB", DEFAULT_ADB if os.path.exists(DEFAULT_ADB) else "adb")
FRIDA_DEVICE = os.environ.get("FRIDA_DEVICE", "172.30.32.1:27043")
GADGET_DEVICE = os.environ.get("GADGET_DEVICE", "172.30.32.1:27098")
GADGET_PORT = int(os.environ.get("GADGET_PORT", "27099"))
RELAY_PORT = 27098
LAUNCHER = "com.u8.sdk.U8UnityContext"
GADGET_NAME = "libfrida-gadget.so"
GADGET_CONFIG = "libfrida-gadget.config.so"
WINDOWS_NODE = "/mnt/c/Program Files/nodejs/node.exe"
START = time.time()


def adb(*args: str, timeout: int = 30) -> str:
    """执行 adb 命令并返回输出。"""
    proc = subprocess.run([ADB, *args], capture_output=True, text=True, timeout=timeout)
    return (proc.stdout or "") + (proc.stderr or "")


def wait_pid(pkg: str, tries: int = 80) -> int:
    """轮询等待进程出现。"""
    for _ in range(tries):
        out = adb("shell", "pidof " + pkg).strip()
        if out:
            return int(out.split()[0])
        time.sleep(0.25)
    raise SystemExit("等待进程超时: " + pkg)


def port_listening(port: int) -> bool:
    """检查设备内端口是否 LISTEN。"""
    hexport = "%04X" % port
    for line in adb("shell", "cat /proc/net/tcp /proc/net/tcp6").splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[1].endswith(":" + hexport) and parts[3] == "0A":
            return True
    return False


def native_lib_dir(pkg: str) -> str:
    """从 dumpsys 取应用的 native 库目录（MuMu 下形如 /data/app-lib/<hash>）。"""
    out = adb("shell", "dumpsys package " + pkg)
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("legacyNativeLibraryDir="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("未能从 dumpsys 取到 legacyNativeLibraryDir: " + pkg)


def find_gadget_source(explicit: str | None) -> str:
    """定位 ARM64 frida-gadget：显式路径 → tmp/gadget → reference/obs 包内。"""
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates.append(os.path.join(REPO, "tmp", "gadget", "frida-gadget-17.9.1-android-arm64.so"))
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate

    archive = os.path.join(REPO, "reference", "obs", "OpenBachelorG-master.zip")
    if os.path.exists(archive):
        import zipfile

        target = os.path.join(REPO, "tmp", "gadget")
        os.makedirs(target, exist_ok=True)
        with zipfile.ZipFile(archive) as zf:
            member = next((n for n in zf.namelist() if "frida-gadget" in n and "arm64" in n), None)
            if member is None:
                raise SystemExit("obs G 包里没有 arm64 gadget")
            xz_path = os.path.join(target, os.path.basename(member))
            with zf.open(member) as src, open(xz_path, "wb") as dst:
                shutil.copyfileobj(src, dst)
        print("[setup] 已从 obs G 包抽出 %s，请用 7zz 解压为 .so 后重试" % xz_path)
        raise SystemExit("需要先解压: tmp/tools/7zz x %s" % xz_path)
    raise SystemExit("找不到 arm64 frida-gadget，请用 --gadget <path> 指定")


def install_gadget(pkg: str, gadget: str) -> None:
    """把 gadget 与配置推进应用的 native 库目录（默认 listen 127.0.0.1:<port>）。"""
    lib_dir = native_lib_dir(pkg)
    print("[setup] native 库目录 = %s" % lib_dir, flush=True)
    adb("push", gadget, "/data/local/tmp/" + GADGET_NAME)
    config = '{"interaction":{"type":"listen","address":"127.0.0.1","port":%d,"on_load":"resume"},"runtime":{"log_level":"info"}}\n' % GADGET_PORT
    local_config = os.path.join(REPO, "tmp", "gadget", GADGET_CONFIG)
    os.makedirs(os.path.dirname(local_config), exist_ok=True)
    with open(local_config, "w", encoding="utf-8") as fh:
        fh.write(config)
    adb("push", local_config, "/data/local/tmp/" + GADGET_CONFIG)
    adb(
        "shell",
        "cp /data/local/tmp/{0} {1}/{0}; cp /data/local/tmp/{2} {1}/{2}; chmod 755 {1}/{0}; chmod 644 {1}/{2}".format(
            GADGET_NAME, lib_dir, GADGET_CONFIG
        ),
    )
    listing = adb("shell", "ls -l %s/%s %s/%s" % (lib_dir, GADGET_NAME, lib_dir, GADGET_CONFIG))
    print("[setup] " + listing.strip(), flush=True)


def push_pubkey(local_path: str) -> None:
    """把私服公钥推到设备（运行时重定向脚本会用它替换官方公钥）。"""
    if not os.path.exists(local_path):
        print("[boot] 未找到公钥 %s，跳过推送（脚本会跳过公钥替换）" % local_path, flush=True)
        return
    adb("push", local_path, "/data/local/tmp/doctoratets-pubkey.xml")
    print("[boot] 已推送公钥 → /data/local/tmp/doctoratets-pubkey.xml", flush=True)


def ensure_forward(port: int) -> None:
    """确保 adb forward 存在（Windows 侧 loopback）。"""
    adb("forward", "tcp:%d" % port, "tcp:%d" % port)


def reachable(addr: str) -> bool:
    """TCP 探测 host:port 是否可连（判断 WSL 能否到达 Windows 侧转发端口）。"""
    host, _, port = addr.rpartition(":")
    try:
        with socket.create_connection((host, int(port)), timeout=2):
            return True
    except OSError:
        return False


def ensure_relay(device_addr: str, device_port: int) -> None:
    """必要时起 Windows 侧 TCP 中继（WSL 访问不到 Windows 的 loopback）。"""
    if reachable(device_addr):
        return
    relay_script = os.path.join(REPO, "tmp", "port-relay.mjs")
    if not os.path.exists(WINDOWS_NODE) or not os.path.exists(relay_script):
        raise SystemExit(
            "连不上 %s。请在 Windows 侧执行：node tmp/port-relay.mjs %d %d"
            % (device_addr, RELAY_PORT, device_port)
        )
    print("[boot] %s 不可达，启动 Windows 侧中继 %d → %d" % (device_addr, RELAY_PORT, device_port), flush=True)
    subprocess.Popen(
        [WINDOWS_NODE, relay_script, str(RELAY_PORT), str(device_port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=REPO,
    )
    for _ in range(30):
        if reachable(device_addr):
            return
        time.sleep(0.3)
    raise SystemExit("中继启动后仍连不上 %s" % device_addr)


def print_payload(label: str, payload: object) -> None:
    """渲染一条 agent 消息。"""
    ts = "%6.2fs" % (time.time() - START)
    if isinstance(payload, dict):
        kind = payload.get("t")
        if kind == "log":
            src = payload.get("src", label)
            where = payload.get("tag") if src in ("host", "native") else payload.get("fn", payload.get("type"))
            print("%s [%-12s] %-22s %s" % (ts, src, where, payload.get("text")), flush=True)
            return
        if kind == "stats":
            return
    print("%s [%-12s] %s" % (ts, label, payload), flush=True)


def attach(device, target: int, source: str, label: str):
    """建立会话、加载脚本、按 label 前缀打印消息。"""
    session = device.attach(target)

    def on_message(message, data):
        if message.get("type") == "error":
            print("[%s][error] %s" % (label, message.get("description")), flush=True)
            return
        print_payload(label, message.get("payload"))

    script = session.create_script(source)
    script.on("message", on_message)
    script.load()
    return session


def read_script(path: str, pubkey: str = "") -> str:
    """读脚本；把 __PUBKEY_XML__ 占位符替换为私服公钥（运行时重定向脚本要用）。"""
    if not os.path.exists(path):
        raise SystemExit("脚本不存在：%s\n先执行 node scripts/build-frida-hook.mjs（或 pnpm run frida:build）" % path)
    with open(path, "r", encoding="utf-8") as fh:
        source = fh.read()
    if "__PUBKEY_XML__" in source:
        key = ""
        if pubkey and os.path.exists(pubkey):
            with open(pubkey, "r", encoding="utf-8") as fh:
                key = fh.read().strip()
        if key:
            # 用 JSON 转义后嵌入，避免引号/换行破坏脚本
            source = source.replace("__PUBKEY_XML__", json.dumps(key)[1:-1])
        source = source.replace("__PUBKEY_PATH__", "/data/local/tmp/doctoratets-pubkey.xml")
    return source


def main() -> None:
    parser = argparse.ArgumentParser(description="MuMu 双 agent Frida 管线（x86_64 + ARM64 il2cpp）")
    parser.add_argument("--pkg", default="com.hypergryph.arknights")
    parser.add_argument("--script", default=os.path.join(REPO, "hook", "build", "il2cpp-unity-logs.js"))
    parser.add_argument("--host-script", default=os.path.join(REPO, "hook", "host-logs.js"))
    parser.add_argument("--java-script", default=os.path.join(REPO, "hook", "build", "java-redirect.js"),
                        help="x86_64 agent 里的 Java 层重定向脚本（HGSDK/okhttp 流量）")
    parser.add_argument("--injector", default=os.path.join(REPO, "hook", "build", "inject-gadget.js"))
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--no-restart", action="store_true", help="不冷启动，直接对当前进程注入")
    parser.add_argument("--host-only", action="store_true", help="只挂宿主日志，不注入 gadget")
    parser.add_argument("--install-gadget", action="store_true", help="把 ARM64 gadget 装到设备后退出")
    parser.add_argument("--gadget", default=None, help="ARM64 frida-gadget(.so) 路径")
    parser.add_argument("--pubkey", default=os.path.join(REPO, "data", "crypto", "public.xml"),
                        help="私服公钥（运行时替换客户端官方公钥用）")
    args = parser.parse_args()

    if args.install_gadget:
        install_gadget(args.pkg, find_gadget_source(args.gadget))
        return

    ensure_forward(GADGET_PORT)
    ensure_relay(GADGET_DEVICE, GADGET_PORT)

    if args.no_restart:
        pid = wait_pid(args.pkg, tries=5)
    else:
        print("[boot] 冷启动 %s" % args.pkg, flush=True)
        adb("shell", "am force-stop " + args.pkg)
        time.sleep(1)
        adb("shell", "am start -n %s/%s" % (args.pkg, LAUNCHER))
        pid = wait_pid(args.pkg)
    print("[boot] pid=%d" % pid, flush=True)

    x64 = frida.get_device_manager().add_remote_device(FRIDA_DEVICE)
    sessions = []

    if not args.host_only:
        push_pubkey(args.pubkey)
        print("[boot] 注入 ARM64 gadget（Runtime.load0 → NativeBridge → Houdini）", flush=True)
        sessions.append(attach(x64, pid, read_script(args.injector), "inject"))
        time.sleep(1.5)
        for _ in range(80):
            if port_listening(GADGET_PORT):
                break
            time.sleep(0.3)
        else:
            raise SystemExit("gadget 端口 %d 未监听（是否已 --install-gadget？）" % GADGET_PORT)
        print("[boot] gadget 已监听 %d" % GADGET_PORT, flush=True)

    sessions.append(attach(x64, pid, read_script(args.host_script), "x64"))
    print("[boot] 宿主 agent 已挂（Java/宿主 liblog）", flush=True)

    if os.path.exists(args.java_script):
        sessions.append(attach(x64, pid, read_script(args.java_script), "java"))
        print("[boot] Java 层重定向已挂（okhttp/HGSDK 流量）", flush=True)

    if not args.host_only:
        gadget = frida.get_device_manager().add_remote_device(GADGET_DEVICE)
        procs = gadget.enumerate_processes()
        target = next((p for p in procs if p.name.lower() == "gadget"), procs[0] if procs else None)
        if target is None:
            raise SystemExit("gadget 未暴露进程")
        sessions.append(attach(gadget, target.pid, read_script(args.script, args.pubkey), "arm64"))
        print("[boot] ARM64 agent 已挂（il2cpp + guest liblog）", flush=True)

    print("[boot] 运行 %ds（Ctrl+C 结束）" % args.duration, flush=True)
    try:
        time.sleep(args.duration)
    except KeyboardInterrupt:
        pass
    finally:
        for session in sessions:
            try:
                session.detach()
            except Exception:
                pass


if __name__ == "__main__":
    main()
