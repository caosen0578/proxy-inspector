#!/usr/bin/env bash
# 停止后台运行的 proxy-inspector。
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PIDFILE="$DIR/.proxy-inspector.pid"
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null)"
  if kill "$PID" 2>/dev/null; then
    echo "已停止 proxy-inspector（pid $PID）"
  else
    echo "进程未在运行（pid $PID）"
  fi
  rm -f "$PIDFILE"
else
  echo "未找到 pid 文件，可能未在运行"
fi
