# QQ 机器人登录二维码 —— 实时刷新窗口（通用版）
#
# 为什么需要它：NapCat 每 2 分钟换一张二维码，截图 / 文件快照给用户必然会过期，
# 来回“再发一张”是打地鼠。这个窗口直接盯着 NapCat 的二维码文件，一变就换，
# 显示剩余时间，并把最近一次登录尝试的结果回显出来；登录成功后自己关掉。
#
# 用法（必须 -STA，WinForms 才行）：
#   powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\show-qrcode.ps1
#   或双击同目录的 show-qrcode.cmd
#
# 配置：同目录 napcat-qr.json（先复制 napcat-qr.example.json 再改路径）。
# 注意：本文件必须保存为 UTF-8 带 BOM，否则 PowerShell 5.1 读中文会乱码。
# 注意：NapCat 重启时会把 qrcode.png 删掉重建，所有文件操作都要能容忍中途消失，
#       否则 WinForms 定时器里抛异常会把整个窗口干掉。

param(
    [string] $ConfigFile = '',
    [string] $QrPath     = '',
    [string] $LogPath    = '',
    [int]    $ValidSec   = 0,
    [int]    $HttpPort   = 0,
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

if (-not $QrPath)   { $QrPath = Join-Path $napcatHome 'napcat\cache\qrcode.png' }
if (-not $LogPath)  { $LogPath = Join-Path $napcatHome 'napcat-auto.log' }
if ($ValidSec -le 0) { $ValidSec = if ($cfg.qrValidSeconds) { [int]$cfg.qrValidSeconds } else { 120 } }
if ($HttpPort -le 0) { $HttpPort = if ($cfg.httpPort) { [int]$cfg.httpPort } else { 3003 } }

if ($CheckOnly) {
    [pscustomobject]@{
        configFile = $ConfigFile
        napcatHome = $napcatHome
        qrPath     = $QrPath
        logPath    = $LogPath
        validSec   = $ValidSec
        httpPort   = $HttpPort
        qrExists   = [bool](Test-Path $QrPath)
    } | ConvertTo-Json
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ── 界面 ────────────────────────────────────────────────────────
$form                 = New-Object System.Windows.Forms.Form
$form.Text            = 'QQ 机器人登录'
$form.ClientSize      = New-Object System.Drawing.Size(380, 520)
$form.StartPosition   = 'CenterScreen'
$form.TopMost         = $true
$form.BackColor       = [System.Drawing.Color]::White
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox     = $false

$title           = New-Object System.Windows.Forms.Label
$title.Text      = '手机 QQ → 右上角 + → 扫一扫'
$title.Font      = New-Object System.Drawing.Font('Microsoft YaHei', 11, [System.Drawing.FontStyle]::Bold)
$title.Location  = New-Object System.Drawing.Point(12, 10)
$title.Size      = New-Object System.Drawing.Size(356, 26)
$title.TextAlign = 'MiddleCenter'

$pic           = New-Object System.Windows.Forms.PictureBox
$pic.Location  = New-Object System.Drawing.Point(30, 42)
$pic.Size      = New-Object System.Drawing.Size(320, 320)
$pic.SizeMode  = 'Zoom'
$pic.BackColor = [System.Drawing.Color]::White

$status           = New-Object System.Windows.Forms.Label
$status.Location  = New-Object System.Drawing.Point(12, 368)
$status.Size      = New-Object System.Drawing.Size(356, 28)
$status.Font      = New-Object System.Drawing.Font('Microsoft YaHei', 12, [System.Drawing.FontStyle]::Bold)
$status.TextAlign = 'MiddleCenter'

$feedback           = New-Object System.Windows.Forms.Label
$feedback.Location  = New-Object System.Drawing.Point(12, 398)
$feedback.Size      = New-Object System.Drawing.Size(356, 74)
$feedback.Font      = New-Object System.Drawing.Font('Microsoft YaHei', 9)
$feedback.TextAlign = 'MiddleCenter'

$hint           = New-Object System.Windows.Forms.Label
$hint.Location  = New-Object System.Drawing.Point(12, 472)
$hint.Size      = New-Object System.Drawing.Size(356, 38)
$hint.Font      = New-Object System.Drawing.Font('Microsoft YaHei', 8.5)
$hint.ForeColor = [System.Drawing.Color]::Gray
$hint.TextAlign = 'MiddleCenter'
$hint.Text      = '窗口会自动换成最新的码，不用管它；登录成功会自动关闭。'

$form.Controls.AddRange(@($title, $pic, $status, $feedback, $hint))

# ── 状态 ────────────────────────────────────────────────────────
$script:lastWrite = [datetime]::MinValue
$script:tick      = 0
$script:loggedIn  = $false

function Test-LoggedIn {
    # 不能用「3002 上有 ESTABLISHED」判断登录成功 —— NapCat 的 OneBot 客户端在
    # 登录完成前后都可能连着，那样窗口会误判成功然后自己关掉。
    # 改为问 NapCat 的 HTTP 口要登录信息：拿得到 user_id 才是真登上去了。
    if ($script:loggedIn) { return $true }
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/get_login_info" -TimeoutSec 1 -ErrorAction Stop
        if ($r -and $r.retcode -eq 0 -and $r.data -and $r.data.user_id) {
            $script:loggedIn = $true
            return $true
        }
    } catch { }
    return $false
}

function Get-Stamp([string]$line) {
    if ($line -match '(\d\d:\d\d:\d\d)') { return $matches[1] }
    return ''
}

function Read-LoginFeedback {
    # 日志是 UTF-8，且被 NapCat 独占 —— Get-Content 是共享读，不会冲突
    $tail = Get-Content $LogPath -Tail 60 -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $tail) { return @{ text = ''; color = 'Gray' } }

    $lastErr  = $tail | Where-Object { $_ -match 'Login Error' }   | Select-Object -Last 1
    $lastScan = $tail | Where-Object { $_ -match '二维码已被扫描' } | Select-Object -Last 1
    $lastQr   = $tail | Where-Object { $_ -match '二维码已保存' }   | Select-Object -Last 1

    if ($lastErr) {
        $code = '?'
        if ($lastErr -match 'ErrCode:\s*(\d+)') { $code = $matches[1] }
        $when = Get-Stamp $lastErr
        if ($code -eq '3') {
            return @{ text = "[$when] 上次那张没人扫，超时了 —— 正常，扫现在这张就行"; color = 'DimGray' }
        }
        if ($code -eq '10') {
            return @{ text = "[$when] 扫上了，但 QQ 拒绝了（ErrCode 10）`n多半是网络环境被判有风险"; color = 'Crimson' }
        }
        return @{ text = "[$when] 登录失败，ErrCode $code"; color = 'Crimson' }
    }
    if ($lastScan) { return @{ text = "[$(Get-Stamp $lastScan)] 已扫到，正在等 QQ 确认…"; color = 'DarkOrange' } }
    if ($lastQr)   { return @{ text = '还没有扫码记录'; color = 'DimGray' } }
    return @{ text = ''; color = 'Gray' }
}

function Update-Qr {
    try {
        $script:tick++

        # 1) 登录成功了吗？（每 5 秒问一次 HTTP 口，避免界面卡顿）
        if (($script:tick % 5 -eq 1) -or $script:loggedIn) {
            if (Test-LoggedIn) {
                $form.Close()
                return
            }
        }

        if (-not (Test-Path $QrPath)) {
            $pic.Visible = $false
            $status.Text = '等待 NapCat 生成二维码…'
            $status.ForeColor = [System.Drawing.Color]::Gray
            return
        }

        $item = Get-Item $QrPath -ErrorAction SilentlyContinue
        if (-not $item) { return }
        $age = ((Get-Date) - $item.LastWriteTime).TotalSeconds

        # 2) 变了就重读（按字节读，不锁 NapCat 正在写的文件）
        if ($item.LastWriteTime -ne $script:lastWrite) {
            $bytes = [System.IO.File]::ReadAllBytes($QrPath)
            if ($bytes.Length -gt 100) {
                $ms  = New-Object System.IO.MemoryStream(, $bytes)
                $img = [System.Drawing.Image]::FromStream($ms)
                $old = $pic.Image
                $pic.Image = $img
                if ($old) { $old.Dispose() }
                $script:lastWrite = $item.LastWriteTime
            }
        }

        # 3) 倒计时
        $left = [int]($ValidSec - $age)
        if ($left -gt 15) {
            $status.Text = "可以扫   ·   还剩 $left 秒"
            $status.ForeColor = [System.Drawing.Color]::FromArgb(0, 140, 60)
            $pic.Visible = $true
        } else {
            $status.Text = '这张过期了，正在等新码…'
            $status.ForeColor = [System.Drawing.Color]::FromArgb(200, 110, 0)
            $pic.Visible = $false   # 过期就别让人白扫一次
        }

        # 4) 每 2 秒回显一次最近一次登录结果
        if ($script:tick % 2 -eq 0) {
            $fb = Read-LoginFeedback
            $feedback.Text = $fb.text
            $feedback.ForeColor = [System.Drawing.Color]::FromName($fb.color)
        }
    } catch {
        # 关键：定时器里绝不能把异常抛出去，否则窗口直接没了
        $status.Text = '刷新中…'
        $status.ForeColor = [System.Drawing.Color]::Gray
    }
}

# 兜底：UI 线程上的未捕获异常也别把窗口带走
[System.Windows.Forms.Application]::ThreadException.AddHandler({
    param($sender, $e)
})

$timer          = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ Update-Qr })
$form.Add_Shown({ $timer.Start(); Update-Qr })
$form.Add_FormClosed({ $timer.Stop() })

[void]$form.ShowDialog()
