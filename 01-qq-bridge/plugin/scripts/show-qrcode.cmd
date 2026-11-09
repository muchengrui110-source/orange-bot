@echo off
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0show-qrcode.ps1" %*
