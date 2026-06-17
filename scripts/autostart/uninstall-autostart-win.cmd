@echo off
chcp 65001 >nul
setlocal
REM 移除 Windows 登录自启项（不影响已在运行的进程；如需停止请关闭对应 node 进程或重启）。
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\proxy-inspector.vbs"
if exist "%VBS%" (
  del "%VBS%"
  echo 已移除登录自启：%VBS%
) else (
  echo 未发现登录自启项
)
echo.
echo 如需停止正在运行的代理：任务管理器结束 node.exe，或注销/重启。
pause
