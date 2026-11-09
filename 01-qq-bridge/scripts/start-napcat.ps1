# NapCat 启动脚本（幂等 · 脱敏通用版）
#
# 干什么：把 NapCat 以“无窗口”方式拉起来，控制台输出写到 napcat\napcat-auto.log。
#         已经在跑（node.exe 路径在 napcatHome 之下）就直接退出，重复调用没有副作用。
#
# 为什么不用 Start-Process -RedirectStandardOutput：那会把调用方（node / 计划任务 / 管道）
# 的 stdout 句柄吊住，命令可能永远不返回。这里用 WScript.Shell 的隐藏 Run + cmd 重定向。
#
# 用法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-napcat.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-napcat.ps1 -CheckOnly
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-napcat.ps1 -Stop
#
# 配置来源（按顺序找，找到就用）：
#   1) -ConfigFile 参数
#   2) 本脚本同目录的 napcat-qr.json
#   3) ..\plugin\scripts\napcat-qr.json
#   都没有就用默认值：napcatHome = 本包下的 napcat\，botUin 空（走扫码登录）。
#   botUin 非空时会以 -q <纯数字QQ号> 启动（快速登录）；写成空串/带其它字符则不传 -q。
#
# 注意：本文件必须保存为 UTF-8 带 BOM，否则 PowerShell 5.1 按 GBK 解析中文会报语法错。

param(
    [string] $ConfigFile = '',
    [switch] $CheckOnly,
    [switch] $Stop
)

$ErrorActionPreference = 'SilentlyContinue'

$scriptDir = $PSScriptRoot
$pkgRoot   = Split-Path -Parent $scriptDir

# ── 找配置 ──────────────────────────────────────────────────────
$cfgFile = $ConfigFile
if (-not $cfgFile) {
    foreach ($c in @((Join-Path $scriptDir 'napcat-qr.json'),
                     (Join-Path $pkgRoot  'plugin\scripts\napcat-qr.json'))) {
        if (Test-Path $c) { $cfgFile = $c; break }
    }
}

$conf = $null
if ($cfgFile -and (Test-Path $cfgFile)) {
    try { $conf = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $conf = $null }
}

$napcatHome = Join-Path $pkgRoot 'napcat'
if ($conf -and $conf.napcatHome) { $napcatHome = ([string]$conf.napcatHome).TrimEnd('\') }

# botUin 只留数字：带空格、引号、后缀都会让 NapCat 的 -q 参数失效
$botUin = ''
if ($conf -and $conf.botUin) { $botUin = (([string]$conf.botUin) -replace '[^0-9]', '') }

$pluginPort = 3002
if ($conf -and $conf.pluginPort) { $pluginPort = [int]$conf.pluginPort }

$napcatBat    = Join-Path $napcatHome 'napcat.bat'
$nodeExe      = Join-Path $napcatHome 'node.exe'
$logPath      = Join-Path $napcatHome 'napcat-auto.log'
$errPath      = Join-Path $napcatHome 'napcat-auto.err.log'
$restartStamp = Join-Path $napcatHome '.last-restart'

function Get-NapCatProcess {
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$napcatHome\*" }
}

# ── -CheckOnly：只打印解析结果，不动任何进程 ─────────────────────
if ($CheckOnly) {
    [pscustomobject]@{
        configFile      = $cfgFile
        napcatHome      = $napcatHome
        napcatBat       = $napcatBat
        napcatBatExists = [bool](Test-Path $napcatBat)
        nodeExe         = $nodeExe
        nodeExeExists   = [bool](Test-Path $nodeExe)
        botUin          = $botUin
        pluginPort      = $pluginPort
        napcatCount     = @(Get-NapCatProcess).Count
        pluginListening = [bool](Get-NetTCPConnection -LocalPort $pluginPort -State Listen -ErrorAction SilentlyContinue)
        onebotConnected = [bool](Get-NetTCPConnection -LocalPort $pluginPort -State Established -ErrorAction SilentlyContinue)
    } | ConvertTo-Json
    exit 0
}

# ── -Stop：只停 napcatHome 底下的 node，不碰桌面的 QQ ────────────
if ($Stop) {
    $procs = Get-NapCatProcess
    if (-not $procs) { Write-Host 'NapCat 没在运行，不用停'; exit 0 }
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host ('已停止 {0} 个 NapCat 进程' -f @($procs).Count)
    exit 0
}

# ── 启动（幂等）──────────────────────────────────────────────────
if (-not (Test-Path $napcatBat)) {
    Write-Host "找不到 napcat.bat：$napcatBat" -ForegroundColor Red
    Write-Host 'napcatHome 要指向解压后 napcat\ 这一层（里面有 node.exe / index.js / napcat.bat）。' -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path $nodeExe)) {
    Write-Host "找不到 node.exe：$nodeExe" -ForegroundColor Red
    exit 1
}
if (Get-NapCatProcess) { Write-Host 'NapCat 已经在运行，跳过'; exit 0 }

$argLine = if ($botUin) { ' -q ' + $botUin } else { '' }
$cmdLine = 'cmd.exe /c ""' + $napcatBat + '"' + $argLine + ' > "' + $logPath + '" 2> "' + $errPath + '""'

$ws = New-Object -ComObject WScript.Shell
$null = $ws.Run($cmdLine, 0, $false)

(Get-Date).ToString('o') | Set-Content -Path $restartStamp -Encoding UTF8

Write-Host 'NapCat 已隐藏启动（没有窗口是正常的）'
Write-Host ("  安装目录：{0}" -f $napcatHome)
Write-Host ("  控制台日志：{0}" -f $logPath)
Write-Host ("  错误日志：{0}" -f $errPath)
if ($botUin) { Write-Host ("  快速登录号码：{0}" -f $botUin) } else { Write-Host '  未配置 botUin：需要扫码登录，用 plugin\scripts\show-qrcode.ps1 看实时二维码' }
exit 0
