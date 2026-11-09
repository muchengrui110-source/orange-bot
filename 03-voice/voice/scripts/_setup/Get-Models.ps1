# Get-Models.ps1 —— 下载 Breeze TTS 2 的 GGUF 模型
#
# 程序本体（breeze-server.exe 等）已经随包的 engine\ 一起给了，这里只下模型。
# 直连 HuggingFace 通常很慢（单连接会被限到 1MB/s 左右），所以走分段并发下载脚本。
#
# 用法：
#   powershell -File Get-Models.ps1                       # 下 q4（2.4G，够用）
#   powershell -File Get-Models.ps1 -Which both           # q4 + q8（6G）
#   powershell -File Get-Models.ps1 -Proxy http://127.0.0.1:10808
#   powershell -File Get-Models.ps1 -VoiceRoot D:\tools\breeze-tts
#
# 本文件含中文，必须保持 UTF-8 带 BOM。

param(
  [string] $VoiceRoot = '',
  [ValidateSet('q4','q8','both')][string] $Which = 'q4',
  [string] $Proxy = '',
  [int] $Chunks = 4
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$get = Join-Path $here 'Get-Chunked.ps1'
if (-not (Test-Path $get)) { throw "缺少分段下载脚本：$get" }

# 模型放哪：优先读包根的 voice-paths.json（install.ps1 写的），没有就退回
# <包根>\engine-runtime。命令行给 -VoiceRoot 时以参数为准。
if (-not $VoiceRoot) {
  $probe = $here
  for ($i = 0; $i -lt 6 -and $probe; $i++) {
    $cand = Join-Path $probe 'voice-paths.json'
    if (Test-Path $cand) {
      try {
        $j = Get-Content -Raw -Encoding UTF8 -Path $cand | ConvertFrom-Json
        if ($j.voiceRoot) { $VoiceRoot = [string]$j.voiceRoot }
      } catch { }
      break
    }
    $probe = Split-Path $probe -Parent
  }
}
if (-not $VoiceRoot) {
  $pkg = $here
  for ($i = 0; $i -lt 6 -and $pkg; $i++) {
    if (Test-Path (Join-Path (Join-Path $pkg 'voice') 'scripts')) { break }
    $pkg = Split-Path $pkg -Parent
  }
  if (-not $pkg) { $pkg = $here }
  $VoiceRoot = Join-Path $pkg 'engine-runtime'
}

$base = 'https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/'
$models = @{
  q4 = @{ file = 'breeze-tts-2-q4_k.gguf'; size = 2538909376; sha = '483418fbbb438f5f1c08dbe2b017e42db0f1d126765cd3f772d8622a30a4915c' }
  q8 = @{ file = 'breeze-tts-2-q8_0.gguf'; size = 3568844480; sha = 'a02bcc4b69b0601032727f8040c4942149b1b73aa0f69022fe5aaa6a8f0ef879' }
}
$pick = if ($Which -eq 'both') { @('q4','q8') } else { @($Which) }

if (-not (Test-Path $VoiceRoot)) { New-Item -ItemType Directory -Path $VoiceRoot -Force | Out-Null }

foreach ($k in $pick) {
  $m = $models[$k]
  $out = Join-Path $VoiceRoot $m.file
  if (Test-Path $out) {
    $len = (Get-Item $out).Length
    if ($len -eq $m.size) {
      Write-Host "[$k] 已存在且大小正确，校验哈希…"
      $h = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
      if ($h -eq $m.sha) { Write-Host "[$k] 校验通过，跳过"; continue }
      Write-Host "[$k] 哈希不对，重新下载"
    } else {
      Write-Host "[$k] 已有文件大小不对（$len），重新下载"
    }
    Remove-Item $out -Force
  }
  Write-Host "[$k] 开始下载 → $out"
  $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$get,
            '-Url', ($base + $m.file), '-Out', $out, '-Size', $m.size, '-Sha256', $m.sha, '-Chunks', $Chunks)
  if ($Proxy) { $args += @('-Proxy', $Proxy) }
  & powershell @args
  if ($LASTEXITCODE -ne 0) { Write-Host "[$k] 失败（退出码 $LASTEXITCODE）；断点分片会保留，重跑本脚本会接着补" -ForegroundColor Red; exit $LASTEXITCODE }
  Write-Host "[$k] 完成" -ForegroundColor Green
}
Write-Host '模型就绪。跑一下 breeze-tts.ps1 -Status 看服务能不能起来。'
