#!/usr/bin/env bash
# =========================================================
# 馄饨Agent-OC · 一键启动（开发期）
#
#   ./launch-desktop.sh            构建 + 开窗口
#   ./launch-desktop.sh --no-build 跳过构建，直接开窗口（改过 TS 却没构建会用到旧产物）
#   ./launch-desktop.sh --smoke    只跑引擎生命周期冒烟，不开窗口
#   ./launch-desktop.sh --dry-run  只做检查和版本打印，不启动
#
# 为什么要有这个脚本（npm start 已经能跑）：
#   从桌面双击进来时，PATH 是桌面会话的，不是终端的——里面往往没有 node，
#   或者有一个版本过老、跑不了引擎的 node。而引擎子进程用的是 PATH 里的 `node`
#   （src/main/engine/paths.ts 的 OPENCLAW_DEV_NODE 兜底），选错了表现是
#   「窗口开了，状态页一直转圈」，没有任何一句人话。
#   所以这里负责：挑一个够新的 node、把它钉进 OPENCLAW_DEV_NODE、再启动。
#
# 日志：~/.cache/hundun-agent-oc/launch-<时间>.log（latest.log 指向最新一份）
# 这个终端会一直开着；关窗口等于结束应用，Ctrl+C 同理。
# =========================================================

set -uo pipefail

# 上游 engines 硬要求：node >=24.16.0（需要 node:sqlite；低于它会直接拒跑）
MIN_NODE="24.16.0"

MODE=""
for arg in "$@"; do
  case "$arg" in
    --no-build|--smoke|--dry-run) MODE="$arg" ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "不认识的参数：$arg（可用：--no-build / --smoke / --dry-run）"; exit 2 ;;
  esac
done

PROJ="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
LOG_DIR="$HOME/.cache/hundun-agent-oc"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/launch-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG"
ln -sfn "$LOG" "$LOG_DIR/latest.log"

C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_0=$'\033[0m'
info() { printf '%s[√]%s %s\n' "$C_OK"   "$C_0" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_WARN" "$C_0" "$*"; }
err()  { printf '%s[×]%s %s\n' "$C_ERR"  "$C_0" "$*"; }

# 双击进来的人只看到窗口一闪就没了，等于没报错，所以失败必须留窗。
hold() {
  [ "$MODE" = "--dry-run" ] && return 0
  echo
  printf '%s日志留在：%s%s\n' "$C_DIM" "$LOG" "$C_0"
  printf '%s按回车关闭这个窗口%s\n' "$C_DIM" "$C_0"
  read -r _ || true
}
die() { err "$*"; hold; exit 1; }

# ver_ge A B：A >= B 时为真（GNU sort -V 做版本比较，避免手写拆分出错）
ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]; }

# ---------- 0. 清掉宿主注入的 Electron / Node 环境 ----------
# 从 VS Code / Cursor 这类 Electron 应用里起的终端会带 ELECTRON_RUN_AS_NODE=1，
# 那会让 Electron 二进制退化成纯 Node，主进程在 app.whenReady() 处报
# "Cannot read properties of undefined"——看起来像代码写错了，其实是环境。
# dev-launch.mjs 也摘了一次，这里更早摘，保证后面的检查不被污染。
unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE 2>/dev/null || true
unset NODE_OPTIONS 2>/dev/null || true
export ELECTRON_DISABLE_SECURITY_WARNINGS=1

# ---------- 1. 找一个够新的 node ----------
NODE=""
OLD_SEEN=""
if [ -n "${OPENCLAW_DEV_NODE:-}" ]; then
  # 用户显式指定就尊重它，但仍然验版本：指定了一个跑不了引擎的 node 是最难查的情况
  [ -x "$OPENCLAW_DEV_NODE" ] || die "OPENCLAW_DEV_NODE 指向的文件不可执行：$OPENCLAW_DEV_NODE"
  NODE="$(readlink -f "$OPENCLAW_DEV_NODE")"
fi

if [ -z "$NODE" ]; then
  for c in \
    "$HOME/.local/node/bin/node" \
    "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$(command -v node 2>/dev/null || true)" \
    /usr/local/bin/node /usr/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    v="$("$c" -v 2>/dev/null)"; v="${v#v}"
    [ -n "$v" ] || continue
    if ver_ge "$v" "$MIN_NODE"; then NODE="$(readlink -f "$c")"; break; fi
    OLD_SEEN="${OLD_SEEN}${OLD_SEEN:+、}$v ($c)"
  done
fi

if [ -z "$NODE" ]; then
  err "找不到 >= $MIN_NODE 的 node（引擎要 node:sqlite，低版本直接拒跑）。"
  [ -n "$OLD_SEEN" ] && err "扫到的都是旧版本：$OLD_SEEN"
  hold; exit 1
fi

NODE_VER="$("$NODE" -v 2>/dev/null || echo v0)"
NODE_VER="${NODE_VER#v}"
ver_ge "$NODE_VER" "$MIN_NODE" || die "node $NODE_VER 低于要求的 $MIN_NODE（$NODE）"

# 桌面会话 PATH 里没有 node：把它排到最前面，构建用的 npx、引擎子进程都靠它
export PATH="$(dirname "$NODE"):$PATH"
# 把校验过的 node 绝对路径钉给引擎，别让它再去 PATH 里挑一个
export OPENCLAW_DEV_NODE="$NODE"

info "node $NODE_VER  ($NODE)"

command -v npx >/dev/null 2>&1 || die "找到 node 但找不到 npx（构建脚本 build.mjs 用它跑 tsc）。"

# ---------- 2. 项目与依赖 ----------
[ -f "$PROJ/package.json" ] || die "项目目录不对：$PROJ"
cd "$PROJ" || die "进不去 $PROJ"

if [ ! -x "$PROJ/node_modules/electron/dist/electron" ]; then
  err "Electron 二进制不在（node_modules 里没有 electron/dist/electron）。"
  echo "  在项目里跑一次："
  printf '     %scd %s && npm install%s\n' "$C_DIM" "$PROJ" "$C_0"
  echo "  若 Electron 下载卡住，用镜像："
  printf '     %sELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js%s\n' "$C_DIM" "$C_0"
  hold; exit 1
fi
ELECTRON_VER="$("$NODE" -p "require('$PROJ/node_modules/electron/package.json').version" 2>/dev/null || echo '?')"
info "Electron $ELECTRON_VER 在位"

# ---------- 3. 引擎（开发期用本机装好的 openclaw） ----------
ENGINE="${OPENCLAW_DEV_ENGINE:-$HOME/.local/lib/node_modules/openclaw}"
if [ ! -f "$ENGINE/dist/index.js" ]; then
  err "找不到引擎入口：$ENGINE/dist/index.js"
  echo "  两种办法："
  echo "   1) npm i -g openclaw"
  echo "   2) export OPENCLAW_DEV_ENGINE=<openclaw 包根目录>（含 dist/index.js 的那层）"
  hold; exit 1
fi
ENGINE_VER="$("$NODE" -p "require('$ENGINE/package.json').version" 2>/dev/null || echo unknown)"
info "引擎 openclaw $ENGINE_VER  ($ENGINE)"

# ---------- 4. 版本指纹：一眼看出这个窗口跑的是哪一版 ----------
APP_VER="$("$NODE" -p "require('$PROJ/package.json').version" 2>/dev/null || echo unknown)"
if [ -d "$PROJ/.git" ]; then
  HASH="$(git -C "$PROJ" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  DIRTY=""
  [ -n "$(git -C "$PROJ" status --porcelain 2>/dev/null)" ] && DIRTY="  + 有未提交改动"
  info "应用 $APP_VER  代码 $HASH$DIRTY"
else
  info "应用 $APP_VER"
fi

# 记忆放在文档目录而不是应用数据目录（D024），这里只提示位置，不碰它
DOCS_DIR="$(xdg-user-dir DOCUMENTS 2>/dev/null || echo "$HOME/Documents")"
MEM_DIR="$DOCS_DIR/馄饨Agent-OC"
if [ -d "$MEM_DIR" ]; then info "记忆目录 $MEM_DIR"; else printf '%s[·]%s 记忆目录 %s（首次启动后生成）\n' "$C_DIM" "$C_0" "$MEM_DIR"; fi

# ---------- 5. 已经在跑就别开第二个（会抢同一份 userData / 状态目录） ----------
# ⚠️ 这里不能用 `pgrep -f "<二进制路径>"` 一句话判完。
# 主进程被强杀（kill -9）后，zygote / gpu / renderer 这些子进程会被 init 收养并继续
# 命中那条模式——于是「明明没有窗口」也一律报「已经在运行」，而且越杀越乱。
# 2026-11-24 连踩三次。判据改成「有没有一个**不带 --type=** 的主进程」：
# 主进程的命令行是 `electron --no-sandbox <项目目录>`，子进程都带 `--type=xxx`。
MAIN_PIDS="$(ps -eo pid,args | grep -F "electron --no-sandbox $PROJ" | grep -v -- "--type=" | grep -v grep | awk '{print $1}')"
if [ -n "$MAIN_PIDS" ]; then
  warn "馄饨Agent-OC 已经在运行了（主进程 $MAIN_PIDS），不再开第二个窗口。"
  warn "要重启：先关掉那个窗口，或 kill $MAIN_PIDS"
  exit 0
fi

# 只剩子进程 → 上一次主进程没退干净。清掉再开，否则它们会一直占着 GPU/网络连接。
ORPHANS="$(pgrep -x electron 2>/dev/null | while read -r p; do
  grep -qa "hundun-agent-oc" "/proc/$p/cmdline" 2>/dev/null && echo "$p"
done)"
if [ -n "$ORPHANS" ]; then
  warn "清掉上次没退干净的 electron 子进程：$(echo $ORPHANS | tr '\n' ' ')"
  for p in $ORPHANS; do kill -9 "$p" 2>/dev/null || true; done
  sleep 1
fi

# ---------- 6. 图形会话 ----------
if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  warn "没有检测到图形会话（DISPLAY / WAYLAND_DISPLAY 均为空）。"
  warn "双击没问题；纯 SSH 里跑起不来窗口，只能跑 --smoke。"
  [ "$MODE" = "--smoke" ] || [ "$MODE" = "--dry-run" ] || die "无图形会话，退出。"
fi

# ---------- 7. 冒烟 / 纯检查：到此为止 ----------
if [ "$MODE" = "--smoke" ]; then
  printf '%s跑引擎生命周期冒烟（起 → 就绪 → 收尾 → 断言无孤儿）…%s\n' "$C_DIM" "$C_0"
  "$NODE" scripts/dev-engine-smoke.mjs 2>&1 | tee -a "$LOG"
  CODE="${PIPESTATUS[0]}"
  if [ "$CODE" -eq 0 ]; then info "冒烟全绿。"; exit 0; fi
  err "冒烟失败（退出码 $CODE），上面是引擎的理由。"
  hold; exit "$CODE"
fi

if [ "$MODE" = "--dry-run" ]; then
  info "dry-run：以上检查全部通过。将要执行 ——"
  printf '     %scd %s && npm run build && node scripts/dev-launch.mjs%s\n' "$C_DIM" "$PROJ" "$C_0"
  exit 0
fi

# ---------- 8. 构建 ----------
if [ "$MODE" = "--no-build" ]; then
  [ -f "$PROJ/dist/main/main.js" ] || die "--no-build 但 dist/main/main.js 不存在，先完整跑一次。"
  warn "跳过构建，直接用现有 dist/（改过 TS 的话这里跑的是旧产物）"
else
  printf '%s构建中（tsc）…%s\n' "$C_DIM" "$C_0"
  npm run build 2>&1 | tee -a "$LOG"
  CODE="${PIPESTATUS[0]}"
  if [ "$CODE" -ne 0 ]; then
    err "构建失败（退出码 $CODE）。往上面翻，找 TS 报的第一个错。"
    hold; exit "$CODE"
  fi
  info "构建完成 → dist/"
fi

# ---------- 9. 启动 ----------
printf '%s启动…（这个终端会一直开着；关窗口即结束）%s\n\n' "$C_DIM" "$C_0"
"$NODE" scripts/dev-launch.mjs 2>&1 | tee -a "$LOG"
CODE="${PIPESTATUS[0]}"

# ---------- 10. 退出诊断 ----------
case "$CODE" in
  0)   info "已正常退出。"; exit 0 ;;
  130) info "你用 Ctrl+C 停的。"; exit 0 ;;
  132|133|134|139)
    SIG=$((CODE - 128))
    case "$SIG" in
      4)  NAME="SIGILL（非法指令）" ;;
      5)  NAME="SIGTRAP（断点陷阱）" ;;
      6)  NAME="SIGABRT（自己 abort 了）" ;;
      11) NAME="SIGSEGV（段错误）" ;;
      *)  NAME="信号 $SIG" ;;
    esac
    err "Electron 在启动阶段就挂了：$NAME，退出码 $CODE"
    echo "  按成因从高到低查："
    echo "  1) Chromium 沙箱 —— dev-launch 已经自动降级 --no-sandbox，若仍失败看它的提示；"
    echo "  2) 没有图形会话 —— 远程/无头终端里就是这样，必须在本机桌面双击；"
    echo "  3) 缺系统库 —— ldd node_modules/electron/dist/electron | grep 'not found'"
    ;;
  1)   err "起来了但主进程抛了异常（退出码 1）。往上面翻，找第一个 Error。"
       echo "  引擎相关的常见原因：状态目录被另一个 gateway 占着；配置键写错会让引擎以 78 退出。" ;;
  78)  err "引擎报「配置无效」（退出码 78）——上游用这个码阻断重启循环，别重试，先修配置。"
       echo "  配置文件：$MEM_DIR/openclaw.json" ;;
  137) err "被 SIGKILL 了。多半是内存不够，或被别的进程杀了。" ;;
  *)   err "退出码 $CODE。上面最后几行一般是原因。" ;;
esac
hold
exit "$CODE"
