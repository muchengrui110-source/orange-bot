# scan-secrets.ps1 —— 扫描一个分发包里的私人信息
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan-secrets.ps1 -Root "<包目录>"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan-secrets.ps1 -Root "<包目录>" -PatternsFile ".\redact-patterns.txt"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan-secrets.ps1 -Root "<包目录>" -Strict
#
# 判定：命中名单或禁止文件 -> exit 1；只有「提示」也打印但 exit 0。
# -Strict 时「提示」（邮箱 / 令牌 / 个人用户目录 / 疑似账号）也算失败。
# 注意：本文件含中文，必须 UTF-8 带 BOM，否则 PowerShell 5.1 按 GBK 解析报语法错。
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$PatternsFile = '',
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Root)) { throw "Root 不存在: $Root" }

# ── 名单 ─────────────────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($PatternsFile)) {
    $candidates = @(
        (Join-Path $PSScriptRoot 'redact-patterns.txt'),
        (Join-Path $PSScriptRoot 'redact-patterns.example.txt')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { $PatternsFile = $c; break } }
}
$patterns = @()
if ($PatternsFile -and (Test-Path $PatternsFile)) {
    $patterns = @(Get-Content -Path $PatternsFile -Encoding UTF8 |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and -not $_.StartsWith('#') })
}

# ── 扫什么 ───────────────────────────────────────────────────────────────
$textExt = @('.md', '.json', '.js', '.mjs', '.cjs', '.ps1', '.cmd', '.bat', '.vbs', '.yml', '.yaml', '.txt', '.html', '.css', '.svg', '.example', '')
$forbidden = @('*.log', '*.db', '*.db-shm', '*.db-wal', '*.breeze',
    'personas.json', 'settings-ui.json', 'sessions.json',
    'voice-personas.json', 'qq-names.json', 'napcat-qr.json',
    'login-qrcode.png', '*.mp3', '*.wav', '*.ogg')

$bad = New-Object System.Collections.ArrayList
$hints = New-Object System.Collections.ArrayList

function Add-Bad([string]$msg) { [void]$bad.Add($msg) }

# ── 1) 文件名 / 内容命中名单 ─────────────────────────────────────────────
$files = Get-ChildItem -Path $Root -Recurse -File -Force -ErrorAction SilentlyContinue
foreach ($f in $files) {
    foreach ($p in $patterns) {
        if ($f.Name.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Add-Bad ("FILENAME: " + $f.FullName + "  <= " + $p)
        }
    }

    if ($f.Length -gt 8MB) { continue }
    if (-not ($textExt -contains $f.Extension.ToLower())) { continue }
    try { $txt = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) } catch { continue }

    foreach ($p in $patterns) {
        if ($txt.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        $lineNo = 0
        $lines = $txt -split "`n"
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i].IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $lineNo = $i + 1; break }
        }
        Add-Bad ("CONTENT: " + $f.FullName + ":" + $lineNo + "  <= " + $p)
    }
}

# ── 2) 禁止出现的文件类型（运行产物 / 隐私数据 / 个人音色）───────────────
foreach ($g in $forbidden) {
    Get-ChildItem -Path $Root -Recurse -File -Force -Filter $g -ErrorAction SilentlyContinue | ForEach-Object {
        Add-Bad ("FORBIDDEN: " + $_.FullName)
    }
}

# ── 3) 通用规则：不依赖名单也能看出来的东西（只提示，不判失败）──────────
$generic = @(
    @{ Name = '邮箱'; Pattern = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' },
    @{ Name = '令牌前缀'; Pattern = 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}' },
    @{ Name = '疑似个人用户目录'; Pattern = 'C:\\Users\\(?![<{%$]|用户名|username|Public)[A-Za-z0-9_\-\.]+\\' },
    @{ Name = '账号字样旁的长数字'; Pattern = '(?i)(qq|uin|群号|账号|account)\D{0,6}[1-9][0-9]{4,10}' }
)
$scanForHints = $files | Where-Object { $_.Length -lt 2MB -and ($textExt -contains $_.Extension.ToLower()) }
foreach ($f in $scanForHints) {
    try { $txt = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8) } catch { continue }
    foreach ($r in $generic) {
        $m = [regex]::Match($txt, $r.Pattern)
        if ($m.Success) {
            [void]$hints.Add(("HINT " + $r.Name + ": " + $f.FullName + "  (" + $m.Value.Substring(0, [Math]::Min(40, $m.Value.Length)) + ")"))
        }
    }
}

# ── 输出 ─────────────────────────────────────────────────────────────────
if ($Strict -and $hints.Count -gt 0) {
    foreach ($h in $hints) { Add-Bad("STRICT " + $h) }
    $hints = New-Object System.Collections.ArrayList
}

if ($hints.Count -gt 0) {
    Write-Host ("提示 " + $hints.Count + " 条（人工看一眼，不一定是问题）：") -ForegroundColor Yellow
    $hints | Sort-Object -Unique | Select-Object -First 20 | ForEach-Object { Write-Host ("  " + $_) }
}

if ($bad.Count -eq 0) {
    Write-Host ("OK: 0 命中 -> " + $Root)
    exit 0
}

Write-Host ("发现 " + $bad.Count + " 处问题：") -ForegroundColor Red
$bad | Sort-Object -Unique | ForEach-Object { Write-Host ("  " + $_) }
exit 1
