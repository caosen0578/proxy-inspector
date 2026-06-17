@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set OUT=dist\proxy-inspector

echo.
echo ============================================
echo    Proxy Inspector - offline packaging
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode

echo [1/4] cleaning old dist ...
if exist dist rmdir /s /q dist
mkdir "%OUT%"

echo [2/4] npm install (with cert patch) ...
call npm install
if errorlevel 1 goto :npmfail

echo [3/4] copying runtime files ...
robocopy src             "%OUT%\src"             /e /njh /njs /ndl /nc /ns >nul
robocopy web             "%OUT%\web"             /e /njh /njs /ndl /nc /ns >nul
robocopy node_modules    "%OUT%\node_modules"    /e /njh /njs /ndl /nc /ns >nul
robocopy mapping-presets "%OUT%\mapping-presets" /e /njh /njs /ndl /nc /ns >nul
robocopy patches         "%OUT%\patches"         /e /njh /njs /ndl /nc /ns >nul
robocopy scripts         "%OUT%\scripts"         /e /njh /njs /ndl /nc /ns /xf gen-admin-token.js gen-keypair.js >nul
copy /y package.json      "%OUT%\" >nul
copy /y package-lock.json "%OUT%\" >nul
copy /y start.cmd         "%OUT%\" >nul
copy /y *.md              "%OUT%\" >nul

echo [4/4] DONE.
echo.
echo Output folder: %CD%\%OUT%
echo Excluded: certs\, secrets\ (admin private key), scripts\gen-admin-token.js, settings.json, reporter-queue.json, temp files
echo Next: zip the folder above and send it. Recipient unzips and runs start.cmd (needs Node.js).
echo.
pause
exit /b 0

:nonode
echo [ERROR] Node.js not found. Please install Node.js first.
echo.
pause
exit /b 1

:npmfail
echo.
echo [ERROR] npm install failed. Check network / npm registry, then retry.
echo.
pause
exit /b 1
