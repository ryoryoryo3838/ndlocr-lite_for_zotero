@echo off
chcp 65001 >nul
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1" %*
echo.
pause
