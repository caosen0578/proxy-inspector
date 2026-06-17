#!/usr/bin/env bash
# 移除「登录自启」并停止当前运行的实例。
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$HOME/.config/autostart/proxy-inspector.desktop"
if [ -f "$DESKTOP" ]; then
  rm -f "$DESKTOP"
  echo "已移除登录自启：$DESKTOP"
else
  echo "未发现登录自启项"
fi
bash "$DIR/scripts/autostart/stop-daemon.sh" 2>/dev/null || true
