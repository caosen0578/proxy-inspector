@echo off
setlocal
cd /d "%~dp0"
set SRC=dist\proxy-inspector

echo.
echo ============================================
echo    发布：注入环境配置 + 清理 + 打包
echo ============================================
echo.

REM ---- 选环境（可传参：dist-release.cmd fat001 / fat）----
set ENV=
if /I "%~1"=="fat001" set ENV=fat001
if /I "%~1"=="fat" set ENV=fat
if not "%ENV%"=="" goto :haveenv

echo 选择要发布的环境：
echo    1 = 测试环境（fat001）
echo    2 = 生产环境（fat）
set /p CH=输入 1 或 2 回车：
if "%CH%"=="1" set ENV=fat001
if "%CH%"=="2" set ENV=fat
if "%ENV%"=="" goto :badchoice

:haveenv
set ENVLABEL=%ENV%
if /I "%ENV%"=="fat001" set ENVLABEL=测试环境fat001
if /I "%ENV%"=="fat" set ENVLABEL=生产环境fat
set ENVFILE=env\settings-%ENV%.json
if not exist "%SRC%"      goto :nodist
if not exist "%ENVFILE%"  goto :noenvfile

echo.
echo 环境：%ENVLABEL%    配置：%ENVFILE%
echo.

echo [1/3] 注入配置为 settings.json ...
copy /y "%ENVFILE%" "%SRC%\settings.json" >nul
if errorlevel 1 goto :copyfail
findstr /c:"FILL-" "%SRC%\settings.json" >nul && echo   [警告] 该环境配置里还有 FILL- 占位没填（reporterBaseUrl / reporterToken）！发出去将无法上送。

echo [2/3] 清理不该分发的文件 ...
if exist "%SRC%\certs"                  rmdir /s /q "%SRC%\certs"
if exist "%SRC%\reporter-queue.json"    del /q "%SRC%\reporter-queue.json"
if exist "%SRC%\last-upload-debug.json" del /q "%SRC%\last-upload-debug.json"
if exist "%SRC%\logs"                   rmdir /s /q "%SRC%\logs"

echo [3/3] 打包成 zip ...
set VER=
for /f "delims=" %%v in ('node scripts/print-env-version.js "%ENVFILE%"') do set VER=%%v
set ZIP=dist\资金同业代码解析工具-%ENVLABEL%%VER%.zip
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%SRC%' -DestinationPath '%ZIP%' -Force"
if errorlevel 1 goto :zipfail

echo.
echo ============================================
echo    完成！分发这个文件：
echo    %CD%\%ZIP%
echo ============================================
echo    另一套环境：再运行一次本脚本，选另一个即可。
echo.
pause
exit /b 0

:badchoice
echo [错误] 没选有效环境（只能 1 或 2）。
echo. & pause & exit /b 1
:nodist
echo [错误] 找不到 %SRC%，请先运行 pack.cmd。
echo. & pause & exit /b 1
:noenvfile
echo [错误] 找不到 %ENVFILE%，请先在 env\ 里配好该环境的地址/Token。
echo. & pause & exit /b 1
:copyfail
echo [错误] 注入配置失败。
echo. & pause & exit /b 1
:zipfail
echo [错误] 压缩失败，请手动压缩 %SRC%。
echo. & pause & exit /b 1
