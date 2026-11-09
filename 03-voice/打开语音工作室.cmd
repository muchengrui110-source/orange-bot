@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0voice\scripts\breeze-webui.ps1"
exit /b %errorlevel%
