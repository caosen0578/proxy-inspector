#!/usr/bin/env bash
# 后台静默启动 proxy-inspector（无终端窗口、脱离会话、防重复启动、按天留日志）。
# 适用于统信 UOS / 麒麟 等 Linux 桌面，无需 root。
set -e

# 项目根 = 本脚本所在目录的上两级（scripts/autostart/ → 根）
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DIR"

PIDFILE="$DIR/.proxy-inspector.pid"
LOGDIR="$DIR/logs"
mkdir -p "$LOGDIR"

# 已在运行（pid 存活）则不重复拉起
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "proxy-inspector 已在运行（pid $(cat "$PIDFILE")）"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "[错误] 未找到 Node.js，请先安装 x86_64 版 Node 并加入 PATH" >&2
  exit 1
fi

# nohup + 后台：脱离登录会话，关终端也不退出；日志按天追加；stdin 接 /dev/null 避免 readline 占用
nohup "$NODE" src/index.js < /dev/null >> "$LOGDIR/proxy-$(date +%Y%m%d).log" 2>&1 &
echo $! > "$PIDFILE"
echo "proxy-inspector 已后台启动（pid $!），面板 http://127.0.0.1:28900"
