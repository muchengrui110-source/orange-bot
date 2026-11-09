# verify-pack.ps1 —— 分发包最终验收
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-pack.ps1 -Root "D:\packs"
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-pack.ps1 -Root "D:\packs" -Packs "01-qq-bridge","02-persona" -RequireZip
#
# 自动发现 -Root 下「含 install.ps1 或 NEXT-AI.md 的子目录」当包。
# 全 PASS -> exit 0；有问题 -> exit 1。
# 注意：本文件含中文，必须 UTF-8 带 BOM。
param(
    [string]$Root = '.',
    [string[]]$Packs = @(),
    [string]$PatternsFile = '',
    [switch]$RequireZip
)

$ErrorActionPreference = 'Continue'

$scan = Join-Path $PSScriptRoot 'scan-secrets.ps1'
if (-not (Test-Path $scan)) { throw "找不到 scan-secrets.ps1（应与本脚本同目录）" }

# 名单（用于 zip 条目名扫描）
if ([string]::IsNullOrWhiteSpace($PatternsFile)) {
    foreach ($c in @((Join-Path $PSScriptRoot 'redact-patterns.txt'), (Join-Path $PSScriptRoot 'redact-patterns.example.txt'))) {
        if (Test-Path $c) { $PatternsFile = $c; break }
    }
}
$patterns = @()
if ($PatternsFile -and (Test-Path $PatternsFile)) {
    $patterns = @(Get-Content -Path $PatternsFile -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
}

function Has-Chinese([string]$path) {
    $t = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
    return ($t -match '[\u4e00-\u9fff]')
}

if ($Packs.Count -eq 0 -and (Test-Path $Root)) {
    $Packs = @(Get-ChildItem -Path $Root -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { (Test-Path (Join-Path $_.FullName 'install.ps1')) -or (Test-Path (Join-Path $_.FullName 'NEXT-AI.md')) } |
            ForEach-Object { $_.Name })
}
if ($Packs.Count -eq 0) { Write-Host "没找到包（-Root 下没有含 install.ps1 / NEXT-AI.md 的子目录）" -ForegroundColor Yellow; exit 1 }

$rows = @()
$fail = 0

foreach ($p in $Packs) {
    $dir = Join-Path $Root $p
    $zip = Join-Path $Root ($p + '.zip')
    $issues = New-Object System.Collections.ArrayList
    $notes = New-Object System.Collections.ArrayList

    if (-not (Test-Path $dir)) { [void]$issues.Add('目录不存在') }
    if ($RequireZip -and -not (Test-Path $zip)) { [void]$issues.Add('zip 不存在') }

    foreach ($n in @('NEXT-AI.md', 'README.md', 'install.ps1')) {
        if (-not (Test-Path (Join-Path $dir $n))) { [void]$issues.Add("缺 $n") }
    }
    if ((Test-Path $dir) -and -not (Test-Path (Join-Path $dir 'PACK-INFO.txt'))) { [void]$notes.Add('缺 PACK-INFO.txt（建议补）') }

    # zip 条目名
    if (Test-Path $zip) {
        try {
            Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
            $z = [IO.Compression.ZipFile]::OpenRead($zip)
            $names = @($z.Entries | ForEach-Object { $_.FullName })
            $z.Dispose()
            foreach ($pat in $patterns) {
                $hit = @($names | Where-Object { $_.IndexOf($pat, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
                if ($hit.Count -gt 0) { [void]$issues.Add("zip 条目名命中 ${pat}: " + ($hit[0..([math]::Min(2, $hit.Count - 1))] -join ',')) }
            }
            foreach ($pat in @('*.log', '*.breeze', '*.mp3', '*.wav', 'personas.json', 'napcat-qr.json')) {
                $hit = @($names | Where-Object { $_ -like $pat })
                if ($hit.Count -gt 0) { [void]$issues.Add("zip 含禁止文件 ${pat}: " + $hit[0]) }
            }
            foreach ($n in @('NEXT-AI.md', 'README.md', 'install.ps1')) {
                $found = @($names | Where-Object { $_ -match "(^|/)$([regex]::Escape($n))$" }).Count
                if ($found -eq 0) { [void]$issues.Add("zip 缺 $n") }
            }
        } catch { [void]$issues.Add("zip 打不开: " + $_.Exception.Message) }
    }

    # 脱敏扫描
    if (Test-Path $dir) {
        $scanArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scan, '-Root', $dir)
        if ($PatternsFile) { $scanArgs += @('-PatternsFile', $PatternsFile) }
        $out = & powershell @scanArgs 2>&1 | Out-String
        if ($out -notmatch 'OK: 0 命中') {
            [void]$issues.Add('敏感扫描未通过')
            $out.Trim().Split("`n") | Select-Object -First 12 | ForEach-Object { [void]$issues.Add('  scan| ' + $_.Trim()) }
        }
    }

    # ps1 语法 + BOM
    if (Test-Path $dir) {
        Get-ChildItem -Path $dir -Recurse -File -Filter *.ps1 -ErrorAction SilentlyContinue | ForEach-Object {
            $e = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$e)
            if ($e.Count -gt 0) { [void]$issues.Add("语法错 " + $_.Name + ": " + $e[0].Message) }
            if (Has-Chinese $_.FullName) {
                $b = [IO.File]::ReadAllBytes($_.FullName)
                $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
                if (-not $hasBom) { [void]$issues.Add("含中文但无 BOM: " + $_.Name) }
            }
        }
    }

    # 禁止文件（再扫一遍，防漏）
    if (Test-Path $dir) {
        foreach ($g in @('*.log', '*.db', '*.breeze', 'personas.json', 'settings-ui.json', 'sessions.json', 'voice-personas.json', 'napcat-qr.json', 'login-qrcode.png', '*.mp3')) {
            Get-ChildItem -Path $dir -Recurse -File -Force -Filter $g -ErrorAction SilentlyContinue | ForEach-Object {
                [void]$issues.Add('禁止文件: ' + $_.FullName.Replace($dir, '.'))
            }
        }
    }

    $sizeMB = 0
    if (Test-Path $dir) { $sizeMB = [math]::Round((Get-ChildItem -Path $dir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1) }
    $zipMB = if (Test-Path $zip) { [math]::Round((Get-Item $zip).Length / 1MB, 1) } else { 0 }
    $nextLines = if (Test-Path (Join-Path $dir 'NEXT-AI.md')) { (Get-Content -Encoding UTF8 (Join-Path $dir 'NEXT-AI.md')).Count } else { 0 }

    $status = if ($issues.Count -eq 0) { 'PASS' } else { 'FAIL' }
    if ($issues.Count -gt 0) { $fail++ }
    $rows += [pscustomobject]@{
        包     = $p
        状态   = $status
        目录MB = $sizeMB
        zipMB  = $zipMB
        NEXT行 = $nextLines
        问题   = ($issues -join ' | ')
        提示   = ($notes -join ' | ')
    }
}

$rows | Format-Table -AutoSize -Wrap | Out-String -Width 250 | Write-Host
if ($fail -eq 0) {
    Write-Host ("全部通过 (" + $Packs.Count + "/" + $Packs.Count + ")") -ForegroundColor Green
    exit 0
}
Write-Host ("失败 " + $fail + " 个") -ForegroundColor Red
exit 1
