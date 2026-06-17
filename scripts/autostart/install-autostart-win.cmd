@echo off
chcp 65001 >nul
setlocal
REM 安装「登录自启」到当前用户的启动文件夹（无需管理员）。
REM 用 VBS 包装实现无黑窗口后台启动。

REM 项目根 = 本脚本上两级（scripts\autostart\ -> 根）
pushd "%~dp0..\.."
set "ROOT=%CD%"
popd

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\proxy-inspector.vbs"

if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

REM 生成无窗口启动脚本：切到项目根，隐藏窗口跑 node，日志追加到 logs\
> "%VBS%" echo Set ws = CreateObject("WScript.Shell")
>> "%VBS%" echo ws.CurrentDirectory = "%ROOT%"
>> "%VBS%" echo ws.Run "cmd /c node src\index.js 1>> logs\proxy.log 2>>&1", 0, False

echo 已安装登录自启（无窗口）：
echo   %VBS%
echo.
echo 现在立即启动一次...
cscript //nologo "%VBS%"
echo 已启动，面板 http://127.0.0.1:28900
echo.
echo 卸载请运行 uninstall-autostart-win.cmd
pause
