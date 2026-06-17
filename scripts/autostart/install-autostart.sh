#!/usr/bin/env bash
# 安装「登录自启」到当前用户的 XDG 自启目录（统信 UOS / 麒麟 / Deepin 等通用），无需 root。
# 登录桌面后自动在后台静默启动 proxy-inspector。
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AUTOSTART_DIR="$HOME/.config/autostart"
DESKTOP="$AUTOSTART_DIR/proxy-inspector.desktop"

mkdir -p "$AUTOSTART_DIR"
chmod +x "$DIR/scripts/autostart/start-daemon.sh" "$DIR/scripts/autostart/stop-daemon.sh" 2>/dev/null || true

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Proxy Inspector
Name[zh_CN]=抓包代理
Comment=登录后台静默启动抓包代理
Comment[zh_CN]=登录后台静默启动抓包代理
Exec=bash "$DIR/scripts/autostart/start-daemon.sh"
Terminal=false
Hidden=false
X-GNOME-Autostart-enabled=true
X-Deepin-Autostart-Delay=5
EOF

echo "已安装登录自启：$DESKTOP"
echo "现在立即启动一次..."
bash "$DIR/scripts/autostart/start-daemon.sh"
echo
echo "提示：下次登录会自动后台启动。停止用 scripts/autostart/stop-daemon.sh"
