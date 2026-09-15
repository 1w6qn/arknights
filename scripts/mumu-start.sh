#!/usr/bin/env bash
# MuMu 一键启动（WSL 侧主体）
#
# 一条命令把「官方客户端 + 私服 + frida 观测」拉到可调试状态（4 步）：
#   1/4 设备与端口：adb devices + forward 27042/27099 + reverse 80/8443/8543，并确认设备内
#       frida-server 常驻（不在就尝试拉起 /data/local/tmp/frida-server）
#   2/4 WSL 私服：在跑就复用，不在就 `node scripts/watchdog.mjs` 托管启动并等端口；最后自检
#       「WSL → Windows 中继 → 私服」这条链（能识破中继目标 WSL IP 过期这种静默失效）
#   3/4 frida hook：hook/*.ts 或 lua/plugin/*.lua 比产物新时才重建 il2cpp-client-redirect
#   4/4 启动游戏 + 注入：冷启动客户端并由 python 双 agent 管线注入（ARM64 gadget + il2cpp），
#       日志 tee 到 tmp/mumu/frida.log；有硬超时（duration + 60s）兜住 detach 卡死
#
# Windows 侧双击入口是仓库根目录的 `start-mumu.cmd`（它负责模拟器、中继、再调本脚本）；
# 在 WSL 里也可以直接 `pnpm run mumu`（此时中继需已就绪，见 tmp/port-relay.mjs / scripts/mumu-relay.mjs）。
#
# 用法：
#   bash scripts/mumu-start.sh                    # 全链路（默认 600s 后自动 detach）
#   bash scripts/mumu-start.sh --no-frida         # 只起基础设施：adb + 私服 + 构建 hook
#   bash scripts/mumu-start.sh --duration 120 --pubkey-mode ours
#   bash scripts/mumu-start.sh --no-restart       # 不冷启动游戏，直接注入当前进程
#   bash scripts/mumu-start.sh --dry-run          # 只打印计划与自检结果，不改任何状态
#
# 环境变量：ADB / MUMU_HOME / MUMU_WIN_HOST / MUMU_SERVER_PORT / MUMU_TLS_PORT /
#          FRIDA_DEVICE / GADGET_DEVICE（后两者缺省用 <Windows 主机>:27043 / :27098）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/tmp/mumu"
SERVER_LOG="$STATE_DIR/server.log"
SERVER_PID_FILE="$STATE_DIR/server.pid"
FRIDA_LOG="$STATE_DIR/frida.log"

SERVER_PORT="${MUMU_SERVER_PORT:-8443}"
TLS_PORT="${MUMU_TLS_PORT:-8543}"

DURATION=600
NO_FRIDA=0
NO_SERVER=0
NO_ADB=0
REBUILD=0
DRY_RUN=0
HOST_ONLY=0
NO_RESTART=0
JAVA_REDIRECT=0
PUBKEY_MODE="${MUMU_PUBKEY_MODE:-oursonly}"
SCRIPT_MODE=""
FRIDA_SCRIPT=""
PKG=""
EXTRA_ARGS=()

info() { printf '\033[36m[mumu]\033[0m %s\n' "$*"; }
ok() { printf '\033[32m  ✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  !\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m  ✘\033[0m %s\n' "$*" >&2
  exit 1
}
step() { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2"; }

usage() {
  # 打印文件头注释块（第二行起、遇到第一行非注释就停）
  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
  --duration)
    DURATION="${2:?--duration 需要秒数}"
    shift 2
    ;;
  --no-frida)
    NO_FRIDA=1
    shift
    ;;
  --no-server)
    NO_SERVER=1
    shift
    ;;
  --no-adb)
    NO_ADB=1
    shift
    ;;
  --rebuild)
    REBUILD=1
    shift
    ;;
  --dry-run)
    DRY_RUN=1
    shift
    ;;
  --host-only)
    HOST_ONLY=1
    shift
    ;;
  --no-restart)
    NO_RESTART=1
    shift
    ;;
  --java-redirect)
    JAVA_REDIRECT=1
    shift
    ;;
  --pubkey-mode)
    PUBKEY_MODE="${2:?--pubkey-mode 需要取值}"
    shift 2
    ;;
  --script-mode)
    SCRIPT_MODE="${2:?--script-mode 需要取值}"
    shift 2
    ;;
  --script)
    FRIDA_SCRIPT="${2:?--script 需要路径}"
    shift 2
    ;;
  --pkg)
    PKG="${2:?--pkg 需要包名}"
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  --)
    # `--` 只是分隔符（pnpm 会把它一起传下来）：继续按已知开关解析，
    # 未知参数照旧进 EXTRA_ARGS，别把它整段塞给 python（否则会 unrecognized arguments）
    shift
    ;;
  *)
    EXTRA_ARGS+=("$1")
    shift
    ;;
  esac
done

mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------- 基础解析
resolve_adb() {
  if [ -n "${ADB:-}" ] && [ -x "${ADB}" ]; then
    printf '%s\n' "$ADB"
    return
  fi
  local home="${MUMU_HOME:-/mnt/d/Program Files/YXArkNights-12.0}"
  if [ -x "$home/shell/adb.exe" ]; then
    printf '%s\n' "$home/shell/adb.exe"
    return
  fi
  command -v adb || true
}

ADB="$(resolve_adb)"
[ -n "$ADB" ] || die "找不到 adb：设置 ADB 或 MUMU_HOME 环境变量"

WIN_HOST="${MUMU_WIN_HOST:-$(ip route | awk '/^default/{print $3; exit}')}"
[ -n "$WIN_HOST" ] || die "取不到 Windows 主机 IP（WSL 默认网关），请设置 MUMU_WIN_HOST"
FRIDA_DEVICE="${FRIDA_DEVICE:-$WIN_HOST:27043}"
GADGET_DEVICE="${GADGET_DEVICE:-$WIN_HOST:27098}"
[ -n "$FRIDA_SCRIPT" ] || FRIDA_SCRIPT="$ROOT/hook/build/il2cpp-client-redirect.js"
PKG_NAME="${PKG:-com.hypergryph.arknights}"
CLIENT_REDIRECT_JS="$ROOT/hook/build/il2cpp-client-redirect.js"

info "仓库：$ROOT"
info "adb：$ADB"
info "Windows 主机（中继）：$WIN_HOST   私服端口：$SERVER_PORT/$TLS_PORT"
[ "$DRY_RUN" = "1" ] && warn "dry-run：只自检并打印计划，不做任何改动"

adb_shell() { "$ADB" shell "$@" 2>/dev/null | tr -d '\r'; }

# ---------------------------------------------------------------- 1) 设备与端口
step "1/4" "设备与端口"
device_list="$(timeout 20 "$ADB" devices 2>/dev/null | tr -d '\r' | awk 'NR>1 && $2=="device"{print $1}')" || true
if [ -z "$device_list" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    warn "dry-run：当前没有 adb 设备（Windows 侧 start-mumu.cmd 会负责起模拟器）"
  else
    die "没有可用的 adb 设备：先在 Windows 侧启动 MuMu（或跑 start-mumu.cmd）"
  fi
else
  ok "设备：$(echo "$device_list" | paste -sd, -)"
fi

if [ "$NO_ADB" = "1" ]; then
  warn "按 --no-adb 跳过 forward/reverse 与 frida-server 检查"
elif [ "$DRY_RUN" = "1" ]; then
  info "将执行：adb forward tcp:27042 / tcp:27099；adb reverse tcp:80/8443/8543 → 私服"
else
  for port in 27042 27099; do
    timeout 20 "$ADB" forward "tcp:$port" "tcp:$port" >/dev/null || die "adb forward tcp:$port 失败"
  done
  ok "forward：27042（frida-server）、27099（gadget）"
  while read -r from to; do
    timeout 20 "$ADB" reverse "tcp:$from" "tcp:$to" >/dev/null || die "adb reverse tcp:$from → $to 失败"
  done <<<"80 $SERVER_PORT
$SERVER_PORT $SERVER_PORT
$TLS_PORT $TLS_PORT"
  ok "reverse：80/$SERVER_PORT/$TLS_PORT → Windows 中继 → WSL 私服"
fi

# 历史坑：把备份恢复到 `files/files/`（多套了一层）会留下第二份注册表与旧 mod 内容，
# 与 `files/` 下的新内容不一致时，客户端会把 mod bundle 当"脏"重新校验 → 换公钥必崩。
if [ -n "$device_list" ]; then
  nested="/storage/emulated/0/Android/data/$PKG_NAME/files/files"
  if [ "$(adb_shell "test -d $nested && echo yes" || true)" = "yes" ]; then
    warn "客户端里有多余的嵌套缓存树 $nested（历史备份恢复写错层）"
    warn "  建议改名后再跑：adb shell mv $nested ${nested}.bak-$(date +%Y%m%d)"
  fi
fi

# frida-server 常驻检查（设备内 27042 由它监听）
if [ "$NO_ADB" = "0" ] && [ -n "$device_list" ]; then
  frida_count="$(adb_shell "ps -A | grep frida-server | grep -v grep | wc -l" | tr -dc '0-9' || true)"
  if [ "${frida_count:-0}" -gt 0 ] 2>/dev/null; then
    ok "设备内 frida-server 已在跑"
  elif [ "$DRY_RUN" = "1" ]; then
    warn "dry-run：设备内 frida-server 未运行（正式运行会尝试拉起 /data/local/tmp/frida-server）"
  else
    warn "设备内 frida-server 未运行，尝试拉起"
    if [ "$(adb_shell "test -f /data/local/tmp/frida-server && echo yes" || true)" = "yes" ]; then
      adb_shell "nohup /data/local/tmp/frida-server >/data/local/tmp/frida.log 2>&1 &" || true
      sleep 2
      frida_count="$(adb_shell "ps -A | grep frida-server | grep -v grep | wc -l" | tr -dc '0-9' || true)"
      if [ "${frida_count:-0}" -gt 0 ] 2>/dev/null; then
        ok "frida-server 已拉起"
      else
        die "frida-server 拉不起来：手动执行 adb shell /data/local/tmp/frida-server -D 后重试"
      fi
    else
      die "设备内没有 /data/local/tmp/frida-server，请先推送 frida-server（见 docs/frida-mumu-il2cpp-2026-09-13.md）"
    fi
  fi
fi

# ---------------------------------------------------------------- 2) 私服
step "2/4" "WSL 私服（端口 $SERVER_PORT）"
http_code() {
  local code
  code="$(curl -s -o /dev/null --max-time 3 -w '%{http_code}' "$1" 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}
server_code() { http_code "http://127.0.0.1:$SERVER_PORT/gm/"; }
code="$(server_code)"
if [ "$code" != "000" ]; then
  ok "私服已在运行（HTTP $code）"
elif [ "$NO_SERVER" = "1" ]; then
  warn "私服未运行，但按 --no-server 跳过启动"
elif [ "$DRY_RUN" = "1" ]; then
  warn "dry-run：私服未运行（正式运行会 node scripts/watchdog.mjs 托管启动）"
else
  info "启动私服：node scripts/watchdog.mjs（日志 $SERVER_LOG）"
  # setsid：脱离当前会话，关掉本窗口/管线被打断也不会带走私服
  (cd "$ROOT" && setsid node scripts/watchdog.mjs >"$SERVER_LOG" 2>&1 </dev/null & echo $! >"$SERVER_PID_FILE")
  for _ in $(seq 1 120); do
    code="$(server_code)"
    [ "$code" != "000" ] && break
    sleep 1
  done
  if [ "$(server_code)" = "000" ]; then
    printf '\n--- %s（末尾 2000 字节）---\n' "$SERVER_LOG"
    tail -c 2000 "$SERVER_LOG" || true
    die "私服 120s 内没起来，见上方日志"
  fi
  ok "私服已就绪（pid $(cat "$SERVER_PID_FILE" 2>/dev/null || echo '?')，HTTP $(server_code)）"
fi

# 中继链路自检：WSL → Windows 中继 → 私服（能识破"中继目标 WSL IP 已过期"这种静默失效）
if [ "$DRY_RUN" = "0" ] && [ "$(server_code)" != "000" ]; then
  relay_code="$(http_code "http://$WIN_HOST:$SERVER_PORT/gm/")"
  if [ "$relay_code" != "000" ]; then
    ok "中继链路已通：WSL → $WIN_HOST:$SERVER_PORT → 私服（HTTP $relay_code）"
  else
    warn "经中继访问失败（$WIN_HOST:$SERVER_PORT）：Windows 侧中继没起，或它的目标 WSL IP 已过期"
    warn "  处理：结束旧的中继进程（tmp/port-relay.mjs），再跑一次 start-mumu.cmd 让它重起"
  fi
fi

# ---------------------------------------------------------------- 3) hook 构建
step "3/4" "frida hook 构建"
needs_build() {
  [ ! -f "$CLIENT_REDIRECT_JS" ] && return 0
  [ -n "$(find "$ROOT/hook" -maxdepth 1 -name '*.ts' -newer "$CLIENT_REDIRECT_JS" -print -quit 2>/dev/null)" ] && return 0
  [ -n "$(find "$ROOT/lua/plugin" -name '*.lua' -newer "$CLIENT_REDIRECT_JS" -print -quit 2>/dev/null)" ] && return 0
  return 1
}
if [ "$REBUILD" = "1" ] || needs_build; then
  if [ "$DRY_RUN" = "1" ]; then
    warn "dry-run：需要重建 hook（hook/*.ts 或 lua/plugin/*.lua 比产物新）"
  else
    info "重建 il2cpp-client-redirect（含 lua/plugin → plugin-lua.js）"
    (cd "$ROOT" && node scripts/build-frida-hook.mjs il2cpp-client-redirect) || die "hook 构建失败"
    ok "产物：$CLIENT_REDIRECT_JS ($(stat -c '%s' "$CLIENT_REDIRECT_JS") 字节)"
  fi
else
  ok "产物已是最新：$(basename "$CLIENT_REDIRECT_JS")"
fi

if [ ! -f "$FRIDA_SCRIPT" ] && [ "$DRY_RUN" = "0" ]; then
  die "注入脚本不存在：$FRIDA_SCRIPT"
fi

# ---------------------------------------------------------------- 4/5) 注入
if [ "$NO_FRIDA" = "1" ]; then
  printf '\n'
  ok "按 --no-frida 结束（基础设施就绪；手动注入见 scripts/frida-mumu-arm64.py）"
  exit 0
fi

step "4/4" "启动游戏 + frida 注入"
FRIDA_ARGS=(--script "$FRIDA_SCRIPT" --pubkey-mode "$PUBKEY_MODE" --duration "$DURATION")
[ -n "$SCRIPT_MODE" ] && FRIDA_ARGS+=(--script-mode "$SCRIPT_MODE")
[ -n "$PKG" ] && FRIDA_ARGS+=(--pkg "$PKG")
[ "$HOST_ONLY" = "1" ] && FRIDA_ARGS+=(--host-only)
[ "$NO_RESTART" = "1" ] && FRIDA_ARGS+=(--no-restart)
if [ "$JAVA_REDIRECT" = "1" ] && [ -f "$ROOT/hook/build/java-redirect.js" ]; then
  FRIDA_ARGS+=(--java-script "$ROOT/hook/build/java-redirect.js")
else
  FRIDA_ARGS+=(--java-script "")
fi
[ "${#EXTRA_ARGS[@]}" -gt 0 ] && FRIDA_ARGS+=("${EXTRA_ARGS[@]}")

if [ "$DRY_RUN" = "1" ]; then
  info "将执行：ADB='$ADB' FRIDA_DEVICE='$FRIDA_DEVICE' GADGET_DEVICE='$GADGET_DEVICE' \\"
  info "         python3 scripts/frida-mumu-arm64.py ${FRIDA_ARGS[*]} | tee -a $FRIDA_LOG"
  printf '\n'
  ok "dry-run 结束（没有改动任何状态）"
  exit 0
fi

info "日志同时写入 $FRIDA_LOG（Ctrl+C 结束注入）"
# 硬超时：frida 的 session.detach() 偶发卡住（agent 正卡在长调用里），没有上限会让"一键"
# 永远不返回；duration + GRACE 秒后强制结束，游戏内 hook 随进程退出一起解除。
GRACE="${MUMU_FRIDA_GRACE:-60}"
HARD_TIMEOUT=$((DURATION + GRACE))
info "最长运行 $HARD_TIMEOUT s（--duration $DURATION + 宽限 $GRACE；超时会强制结束）"
# 本次运行的日志切片起点：frida.log 是跨次追加的，收尾诊断只能看本次新增的部分
LOG_BYTES_BEFORE=$(stat -c %s "$FRIDA_LOG" 2>/dev/null || echo 0)
set +e
timeout -k 5 "$HARD_TIMEOUT" env ADB="$ADB" FRIDA_DEVICE="$FRIDA_DEVICE" GADGET_DEVICE="$GADGET_DEVICE" \
  python3 "$ROOT/scripts/frida-mumu-arm64.py" "${FRIDA_ARGS[@]}" 2>&1 | tee -a "$FRIDA_LOG"
status=${PIPESTATUS[0]}
set -e
printf '\n'
case "$status" in
0) ok "frida 管线正常结束（$DURATION s）" ;;
124 | 137)
  warn "注入进程超过 ${HARD_TIMEOUT}s 没退出（多半是 detach 卡住），已强制结束"
  status=0
  ;;
130 | 143) warn "注入被 Ctrl+C 结束（游戏内 hook 随之解除）" ;;
*) warn "frida 管线退出码 $status，完整日志：$FRIDA_LOG" ;;
esac

# 收尾自检：客户端还活着吗（abort 类崩溃在管线里只表现为 detach/日志中断）
if [ "$NO_ADB" = "0" ] && [ -n "$device_list" ]; then
  if [ -n "$(adb_shell "pidof $PKG_NAME" || true)" ]; then
    ok "客户端仍在运行（$PKG_NAME）"
  else
    warn "客户端已退出（$PKG_NAME 不在进程表：崩溃/被杀）"
    warn "  排查：grep -n CRASH $FRIDA_LOG；设备 tombstone 在"
    warn "  /storage/emulated/0/Android/data/$PKG_NAME/files/tombstone_*"
    # 已定位过的头号死因：换公钥模式与当前生效的 Lua 资产不匹配
    # （客户端 `_CustomLoader` 里 entry.lua 验签失败 → 返回空 → require 抛 LuaException → abort）
    run_log="$(tail -c +$((LOG_BYTES_BEFORE + 1)) "$FRIDA_LOG" 2>/dev/null || true)"
    if printf '%s' "$run_log" | grep -q "verify-bin.*'ok': False" &&
      printf '%s' "$run_log" | grep -q "lua-load', 'path': 'entry.lua', 'len': -1"; then
      warn "  命中已知死因：入口 Lua 验签失败（verify-bin ok:False + entry.lua len=-1）"
      warn "  含义：当前生效的 entry.lua 不是用本模式的公钥签的 —— 换公钥后官方签名的 Lua 必被拒"
      warn "  处置一：改 --pubkey-mode asis 先让客户端起来（插件走 frida 注入 payload，实测可用）"
      warn "  处置二：让私服下发「我们重签」的 Lua 容器（assets/<ver>/redirect/ 里别留官方回源的 lpack_v077.dat）"
    fi
  fi
fi
exit "$status"
