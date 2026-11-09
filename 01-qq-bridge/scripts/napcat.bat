@echo off
REM 原版 NapCat 启动脚本的副本。原版依赖“node.exe 与本 bat 同目录”，
REM 而本包里真正的 NapCat 在 ..\napcat\，所以这里转发过去，避免双击报“找不到 node.exe”。
REM 平时请用 start-napcat.ps1 或计划任务里的 watch-napcat.ps1，不要手点这个。
setlocal
cd /d "%~dp0..\napcat" || exit /b 1
call "%~dp0..\napcat\napcat.bat" %*
exit /b %errorlevel%
