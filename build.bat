@echo off
REM Floating Clock Electron — build script
REM Proxy settings (optional): set HTTP_PROXY and HTTPS_PROXY environment variables before running
REM Example: set HTTP_PROXY=http://127.0.0.1:7888
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set CSC_IDENTITY_AUTO_DISCOVERY=false
cd /d "%~dp0"
call npm.cmd run build -- %*
exit /b %errorlevel%
