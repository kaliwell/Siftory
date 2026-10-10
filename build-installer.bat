@echo off
REM Floating Clock Electron — installer build script
REM Proxy settings (optional): set HTTP_PROXY and HTTPS_PROXY environment variables before running
REM Example: set HTTP_PROXY=http://127.0.0.1:7888
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set CSC_IDENTITY_AUTO_DISCOVERY=false
cd /d "%~dp0"
REM Clean NSIS cache if needed (adjust path to your environment)
REM rmdir /s /q "%APPDATA%\electron-builder\Cache\nsis" 2>nul
call npm.cmd run build -- %*
exit /b %errorlevel%
