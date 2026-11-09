@echo off
setlocal
cd /d "%~dp0"
echo 正在生成桌面快捷方式「Breeze 语音」...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -SkipEngine
if errorlevel 1 (
  echo 生成失败，看上面的报错；也可以直接双击「打开语音工作室.cmd」。
) else (
  echo 好了，桌面上应该有「Breeze 语音」了。
)
pause
