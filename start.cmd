@echo off
chcp 65001 >nul
REM ============================================================
REM  Proxy Inspector launcher (Windows)
REM  To change ports: edit the two lines below. No code change.
REM ============================================================
set PROXY_PORT=28899
set UI_PORT=28900

cd /d "%~dp0"
echo Proxy: 127.0.0.1:%PROXY_PORT%    UI: http://127.0.0.1:%UI_PORT%
echo.
node src/index.js
echo.
echo Service stopped. Press any key to close.
pause >nul
