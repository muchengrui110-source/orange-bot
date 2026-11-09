# NapCat 守护脚本（通用版，以 DSH 状态为准）
#
# 设计目标：DSH 一起来，NapCat 就自动跟进；DSH 不在，NapCat 也不必空跑。
#
# 判断顺序：
#  1) DSH 未运行                        -> 开了 keepAlive 就拉起 DSH；没开则若 NapCat 在跑就停掉它，退出
#  2) DSH 在运行但插件端口未就绪         -> 等待，退出（DSH 刚启动，插件还没挂载）
#  3) NapCat 进程不在                   -> 拉起，退出
#  4) 已连上插件                        -> 一切正常，清标记，退出
#  5) 未连接，但二维码比进程还新         -> 当前实例正在等你扫码，弹二维码窗口，退出
#  6) 未连接且本次启动不足 3 分钟        -> 给登录 / 重连留时间，退出
#  7) 未连接且 10 分钟内刚重启过         -> 防抖动，别反复重启，退出
#  8) 其余情况                          -> 重启换一张新码，并记录重启时间
#
# 用法（建议交给计划任务每分钟跑一次）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\watch-napcat.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\watch-napcat.ps1 -CheckOnly
#
# 配置：同目录 napcat-qr.json（先复制 napcat-qr.example.json 再改路径）。
# 本文件必须保存为 UTF-8 带 BOM，否则 PowerShell 5.1 读中文会乱码。

param(
    [string] $ConfigFile = '',
    [switch] $CheckOnly
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not $ConfigFile) { $ConfigFile = Join-Path $PSScriptRoot 'napcat-qr.json' }
if (-not (Test-Path $ConfigFile)) {
    Write-Host "找不到配置文件：$ConfigFile" -ForegroundColor Red
    Write-Host '先把 napcat-qr.example.json 复制成 napcat-qr.json，再把 napcatHome 改成 NapCat 的安装目录。'
    exit 1
}
try {
    $cfg = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Host "配置文件不是合法 JSON：$ConfigFile" -ForegroundColor Red
    exit 1
}

$napcatHome = [string]$cfg.napcatHome
if (-not $napcatHome) {
    Write-Host '配置里缺 napcatHome（NapCat 安装目录，里面有 napcat.bat）。' -ForegroundColor Red
    exit 1
}
$napcatHome = $napcatHome.TrimEnd('\')

$qrcode       = Join-Path $napcatHome 'napcat\cache\qrcode.png'
$logPath      = Join-Path $napcatHome 'napcat-auto.log'
$watchLog     = Join-Path $napcatHome 'watchdog.log'
$marker       = Join-Path $napcatHome '.login-required'
$restartStamp = Join-Path $napcatHome '.last-restart'
$keepAlive    = Join-Path $napcatHome '.keepalive'
$dshStamp     = Join-Path $napcatHome '.last-dsh-restart'
$napcatBat    = Join-Path $napcatHome 'napcat.bat'
$qrWindow     = Join-Path $PSScriptRoot 'show-qrcode.ps1'

$dshExe         = [string]$cfg.dshExe
$dshProcessName = if ($cfg.dshProcessName) { [string]$cfg.dshProcessName } else { 'DeepSeek Harness' }
$botUin         = [string]$cfg.botUin
$pluginPort     = if ($cfg.pluginPort) { [int]$cfg.pluginPort } else { 3002 }
$keepAliveOn    = ($cfg.keepAlive -eq $true)

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $watchLog -Value $line -Encoding UTF8
}

function Get-NapCatProcess {
    Get-Process node -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "$napcatHome\*" }
}

function Start-NapCat {
    if (-not (Test-Path $napcatBat)) {
        Write-Log "[watchdog] 找不到 $napcatBat"
        return
    }
    $napcatCmd = if ($botUin) { "/c `"$napcatBat`" -q $botUin" } else { "/c `"$napcatBat`"" }
    Start-Process -FilePath 'cmd.exe' -ArgumentList $napcatCmd `
        -WorkingDirectory $napcatHome `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError (Join-Path $napcatHome 'napcat-auto.err.log') `
        -WindowStyle Hidden
    (Get-Date).ToString('o') | Set-Content -Path $restartStamp -Encoding UTF8
}

function Stop-NapCat {
    Get-NapCatProcess | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

# ── 扫码窗口 ─────────────────────────────────────────────────────
# 掉登录时只把二维码写进文件没人知道；需要扫码就自动弹一个实时刷新窗口。
$qrTitle = 'QQ 机器人登录'

function Get-QrWindow {
    Get-Process powershell -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq $qrTitle }
}

function Show-QrWindow {
    if (Get-QrWindow) { return }
    if (-not (Test-Path $qrWindow)) { return }
    $arg = "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$qrWindow`" -ConfigFile `"$ConfigFile`""
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arg
    Write-Log '[watchdog] 需要扫码，已弹出扫码窗口'
}

if ($CheckOnly) {
    [pscustomobject]@{
        configFile      = $ConfigFile
        napcatHome      = $napcatHome
        napcatBat       = $napcatBat
        napcatBatExists = [bool](Test-Path $napcatBat)
        qrPath          = $qrcode
        qrWindow        = $qrWindow
        qrWindowExists  = [bool](Test-Path $qrWindow)
        dshExe          = $dshExe
        dshExeExists    = [bool]($dshExe -and (Test-Path $dshExe))
        dshProcessName  = $dshProcessName
        dshRunning      = [bool](Get-Process $dshProcessName -ErrorAction SilentlyContinue)
        botUin          = $botUin
        pluginPort      = $pluginPort
        keepAlive       = $keepAliveOn
        napcatCount     = @(Get-NapCatProcess).Count
        portListening   = [bool](Get-NetTCPConnection -LocalPort $pluginPort -State Listen -ErrorAction SilentlyContinue)
    } | ConvertTo-Json
    exit 0
}

# ── 1) DSH 是否在运行 ────────────────────────────────────────────
$dsh = Get-Process $dshProcessName -ErrorAction SilentlyContinue
$napcat = Get-NapCatProcess

if (-not $dsh) {
    # 1a) 开了 keepAlive（配置 keepAlive=true 或存在 napcatHome\.keepalive）→ 守护 DSH 本体
    if ($keepAliveOn -or (Test-Path $keepAlive)) {
        $lastDsh = $null
        if (Test-Path $dshStamp) {
            try { $lastDsh = [datetime]::Parse((Get-Content $dshStamp -Raw).Trim()) } catch { }
        }
        # 3 分钟防抖：DSH 是 Electron，启动本身要十几秒，别一分钟拉一次
        if (-not $lastDsh -or ((Get-Date) - $lastDsh).TotalMinutes -ge 3) {
            if ($dshExe -and (Test-Path $dshExe)) {
                Write-Log '[watchdog] DSH 未运行，按 keepAlive 拉起'
                Start-Process -FilePath $dshExe -WorkingDirectory (Split-Path -Parent $dshExe)
                (Get-Date).ToString('o') | Set-Content -Path $dshStamp -Encoding UTF8
            } else {
                Write-Log "[watchdog] keepAlive 已开，但找不到 $dshExe"
            }
        }
        exit 0
    }
    # 1b) 没开 keepAlive：DSH 不在，NapCat 也停掉省资源
    if ($napcat) {
        Stop-NapCat
        Remove-Item $marker -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

# ── 2) DSH 在运行，但插件端口还没就绪（刚启动）→ 等待 ────────────
$portListening = Get-NetTCPConnection -LocalPort $pluginPort -State Listen -ErrorAction SilentlyContinue
if (-not $portListening) { exit 0 }

# ── 3) 插件已就绪，NapCat 进程不在 → 拉起 ────────────────────────
if (-not $napcat) {
    Remove-Item $marker -Force -ErrorAction SilentlyContinue
    Write-Log '[watchdog] NapCat 未运行，拉起'
    Start-NapCat
    exit 0
}

# ── 4) 已连上插件：一切正常 ──────────────────────────────────────
$conn = Get-NetTCPConnection -LocalPort $pluginPort -State Established -ErrorAction SilentlyContinue
if ($conn) {
    if (Test-Path $marker) { Remove-Item $marker -Force -ErrorAction SilentlyContinue }
    exit 0
}

$proc = $napcat | Sort-Object StartTime | Select-Object -First 1
$aliveMinutes = if ($proc) { ((Get-Date) - $proc.StartTime).TotalMinutes } else { 0 }

# ── 5) 二维码比进程新 = 当前实例正在等扫码 ──────────────────────
if (Test-Path $qrcode) {
    $qrTime = (Get-Item $qrcode).LastWriteTime
    $started = if ($proc) { $proc.StartTime } else { (Get-Date) }
    if ($qrTime -gt $started) {
        "login required at {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') |
            Set-Content -Path $marker -Encoding UTF8
        # 顺手把二维码复制到固定位置，方便直接找（NapCat 自己的 cache 路径太深）
        Copy-Item $qrcode (Join-Path $napcatHome 'login-qrcode.png') -Force
        # 并弹出实时刷新的扫码窗口——不然用户根本不知道机器人在等扫码
        Show-QrWindow
        exit 0
    }
}

# ── 6) 刚启动不满 3 分钟：给它时间登录与连接 ─────────────────────
if ($aliveMinutes -lt 3) { exit 0 }

# ── 7) 10 分钟内刚重启过：防抖动 ─────────────────────────────────
if (Test-Path $restartStamp) {
    $last = $null
    try { $last = [datetime]::Parse((Get-Content $restartStamp -Raw).Trim()) } catch { }
    if ($last -and ((Get-Date) - $last).TotalMinutes -lt 10) { exit 0 }
}

# ── 8) 该重启了 ──────────────────────────────────────────────────
Write-Log ("[watchdog] 未连接且无新二维码（已运行 {0:N1} 分钟），重启 NapCat" -f $aliveMinutes)
Remove-Item $marker -Force -ErrorAction SilentlyContinue
Stop-NapCat
Start-NapCat
exit 0
