#!/usr/bin/env bash
# ============================================================
#  Proxy Inspector 启动器 (Linux / macOS)
#  对应 Windows 的 start.cmd。改端口：改下面两行，无需动代码。
# ============================================================
set -e

# 端口（也可在外部用环境变量覆盖：PROXY_PORT=xxx UI_PORT=yyy bash start.sh）
export PROXY_PORT="${PROXY_PORT:-28899}"
export UI_PORT="${UI_PORT:-28900}"

# 切到脚本所在目录，保证相对路径正确
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装对应架构的 Node 并加入 PATH。"
  exit 1
fi

echo "Proxy: http://127.0.0.1:${PROXY_PORT}    UI: http://127.0.0.1:${UI_PORT}"
echo
node src/index.js
