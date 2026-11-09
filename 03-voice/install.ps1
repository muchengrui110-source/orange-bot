# install.ps1 —— 语音模型 Breeze（Breeze TTS 2 v0.1.6）一键落位
#
# 只做这几件事：把 engine 里的程序本体解到 <包>\engine-runtime、写 voice-paths.json、
# 首次生成运行配置和人设声音表（已存在就保留不动）、给 QQ 桥接放一个转发脚本、
# 建桌面快捷方式「Breeze 语音」。
# 模型权重不进包（4~6GB），装完按提示跑 voice\scripts\_setup\Get-Models.ps1 下。
#
# 用法（在解压后的包目录里跑）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#   powershell ... -File .\install.ps1 -VoiceRoot D:\tools\breeze-tts      # 程序/模型换个盘
#   powershell ... -File .\install.ps1 -DshHome D:\dsh-home               # DSH 主目录不是默认的
#   powershell ... -File .\install.ps1 -SkipEngine -NoShortcut            # 只写配置，不动程序
#
# 本文件含中文，必须保持 UTF-8 带 BOM，否则 PowerShell 5.1 会按 GBK 解析直接报语法错。

param(
  [string] $InstallRoot = '',   # 包目录，默认 = 本脚本所在目录
  [string] $DshHome = '',       # DSH 主目录，默认 = $env:DSH_HOME 或 ~\.dsh
  [string] $VoiceRoot = '',     # 程序本体 + 模型的根目录，默认 = <包>\engine-runtime
  [switch] $NoShortcut,
  [switch] $SkipEngine
)

$ErrorActionPreference = 'Stop'

# ---------- 0. 定位 ----------
if (-not $InstallRoot) { $InstallRoot = $PSScriptRoot }
if (-not (Test-Path $InstallRoot)) { throw "InstallRoot 不存在：$InstallRoot" }
if (-not (Test-Path (Join-Path $InstallRoot 'voice\scripts'))) {
  throw "这个目录不像解压后的包（找不到 voice\scripts）：$InstallRoot"
}
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $HOME '.dsh' }
}

$bridgeHome    = Join-Path $DshHome 'qq-bridge'
$binDir        = Join-Path $bridgeHome 'bin'
$voicesDir     = Join-Path $bridgeHome 'voice\breeze-voices'
$voiceScripts  = Join-Path $InstallRoot 'voice\scripts'
$studioDir     = Join-Path $InstallRoot 'voice\studio'
$configFile    = Join-Path $bridgeHome 'breeze-tts.json'
$personaFile   = Join-Path $bridgeHome 'personas.json'
$voicePersonas = Join-Path $bridgeHome 'voice-personas.json'
$pathsPath     = Join-Path $InstallRoot 'voice-paths.json'
$engineZip     = Join-Path $InstallRoot 'engine\breeze-tts-2-v0.1.6-windows-x64-vulkan.zip'
$engineSub     = 'breeze-tts-2-v0.1.6-windows-x64-vulkan'

# 换过根目录的人重跑安装：沿用 voice-paths.json 里记的 voiceRoot，别悄悄挪回去
$existing = @{}
if (Test-Path $pathsPath) {
  try {
    (Get-Content -Raw -Encoding UTF8 -Path $pathsPath | ConvertFrom-Json).PSObject.Properties |
      ForEach-Object { $existing[$_.Name] = $_.Value }
  } catch { Write-Host "[提示] voice-paths.json 读不动，按默认值重写" }
}
if (-not $VoiceRoot) {
  if ($existing['voiceRoot']) { $VoiceRoot = [string]$existing['voiceRoot'] }
  else { $VoiceRoot = Join-Path $InstallRoot 'engine-runtime' }
}
$voiceBinDir = Join-Path $VoiceRoot $engineSub

foreach ($d in @($bridgeHome, $binDir, $voicesDir, $VoiceRoot)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ---------- 1. 程序本体（engine\ 里的 zip → VoiceRoot） ----------
$serverExe = Join-Path $voiceBinDir 'breeze-server.exe'
if ($SkipEngine) {
  Write-Host "[1/6] 跳过解压（-SkipEngine）；程序应已在 $voiceBinDir"
} elseif (Test-Path $serverExe) {
  Write-Host "[1/6] 程序本体已解压，保留不动 → $voiceBinDir"
} elseif (-not (Test-Path $engineZip)) {
  Write-Host "[1/6] [警告] 找不到 $engineZip，程序本体没装；下完再解压到 $VoiceRoot"
} else {
  Write-Host "[1/6] 解压程序本体（约 230MB，要等一会儿）→ $VoiceRoot"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($engineZip, $VoiceRoot)
  if (Test-Path $serverExe) { Write-Host "      OK  $serverExe" }
  else { Write-Host "      [警告] 解压完没看到 breeze-server.exe，检查 zip 结构" }
}

# ---------- 2. voice-paths.json（所有脚本从这里取路径） ----------
# 找得到就用绝对路径；找不到就写命令名，让脚本从 PATH / DSH 运行时里自己找
# （WindowsApps 下那些是应用商店的占位 shim，不能当真程序用，跳过）
function Find-Exe([string]$name, [string[]]$extra) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c -and $c.Source -and $c.Source -notmatch '\\WindowsApps\\') { return $c.Source }
  foreach ($p in $extra) { if ($p -and (Test-Path $p) -and $p -notmatch '\\WindowsApps\\') { return $p } }
  return $name
}
$nodeCandidates = @()
$pyCandidates = @()
# DSH 自带的运行时不一定在 DshHome 下（也可能是 ~\.dsh），两个都探
foreach ($rr in @((Join-Path $DshHome 'dsh-runtimes'), (Join-Path $HOME '.dsh\dsh-runtimes'))) {
  if (-not (Test-Path $rr)) { continue }
  Get-ChildItem $rr -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $nodeCandidates += (Join-Path $_.FullName 'dependencies\node\bin\node.exe')
    $pyCandidates   += (Join-Path $_.FullName 'dependencies\python\python.exe')
  }
}
$nodeCandidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
$nodeExe   = Find-Exe 'node'   $nodeCandidates
$pythonExe = Find-Exe 'python' $pyCandidates
$ffmpegExe = Find-Exe 'ffmpeg' @()

$paths = [ordered]@{
  _说明         = '这份文件由包根的 install.ps1 生成，所有脚本都从包目录向上找它。想换程序/模型存放盘就改 voiceRoot（voiceBinDir 要跟着改）。'
  voiceRoot     = $VoiceRoot
  voiceBinDir   = $voiceBinDir
  configFile    = $configFile
  voicesDir     = $voicesDir
  studioDir     = $studioDir
  personaFile   = $personaFile
  voicePersonas = $voicePersonas
  nodeExe       = $nodeExe
  pythonExe     = $pythonExe
  ffmpegExe     = $ffmpegExe
}
# 用户手改过的程序路径优先（例如把 nodeExe 指到别的版本）
foreach ($k in @('voiceRoot', 'voiceBinDir', 'nodeExe', 'pythonExe', 'ffmpegExe')) {
  if ($existing[$k] -and -not ($PSBoundParameters.ContainsKey('VoiceRoot') -and $k -like 'voice*')) {
    $paths[$k] = $existing[$k]
  }
}
[System.IO.File]::WriteAllText(
  $pathsPath, ($paths | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[2/6] voice-paths.json 已更新 → $pathsPath"
Write-Host "      voiceRoot = $($paths.voiceRoot)"
Write-Host "      node      = $($paths.nodeExe)"
Write-Host "      （换盘/换 node 就改这个文件，或者重跑本脚本时带 -VoiceRoot）"

# ---------- 3. 运行配置（已存在就不覆盖） ----------
if (-not (Test-Path $configFile)) {
  $example = Join-Path $InstallRoot 'voice\config\breeze-tts.example.json'
  $cfg = Get-Content -Raw -Encoding UTF8 -Path $example | ConvertFrom-Json
  $cfg.voicesDir = $voicesDir
  $cfg.personaFile = $personaFile
  $cfg.voicePersonas = $voicePersonas
  [System.IO.File]::WriteAllText($configFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[3/6] 写好运行配置 → $configFile"
  Write-Host "      （想换默认音色/模型档位就改这个文件，或直接用网页工作室）"
} else {
  Write-Host "[3/6] 运行配置已存在，保留不动 → $configFile"
}

# ---------- 4. 人设声音表（不存在才放示例；示例里没有任何真实音色） ----------
if (-not (Test-Path $voicePersonas)) {
  Copy-Item (Join-Path $InstallRoot 'voice\config\voice-personas.example.json') $voicePersonas -Force
  Write-Host "[4/6] 放了人设声音表示例 → $voicePersonas"
} else {
  Write-Host "[4/6] 人设声音表已存在，保留不动 → $voicePersonas"
}

# ---------- 5. 桥接用的转发脚本（QQ 桥接默认在这个位置找 make-voice.ps1） ----------
$forwarder =
  '# 由包根的 install.ps1 生成：把调用转发给包里的 make-voice.ps1。' + "`r`n" +
  '# 桥接固定从这个位置调用，所以包挪了目录要重跑一次 install.ps1。' + "`r`n" +
  '$argList = @(''-NoProfile'',''-ExecutionPolicy'',''Bypass'',''-File'',''' + (Join-Path $voiceScripts 'make-voice.ps1') + ''') + $args' + "`r`n" +
  '& powershell.exe @argList' + "`r`n" +
  'exit $LASTEXITCODE' + "`r`n"
$fwdPath = Join-Path $binDir 'make-voice.ps1'
# 生成的文件里带中文路径，必须 UTF-8 带 BOM，否则 -File 启动会报语法错
[System.IO.File]::WriteAllText($fwdPath, $forwarder, (New-Object System.Text.UTF8Encoding($true)))
Write-Host "[5/6] 生成桥接转发脚本 → $fwdPath"

# ---------- 6. 桌面快捷方式 ----------
if ($NoShortcut) {
  Write-Host "[6/6] 跳过快捷方式（-NoShortcut）"
} else {
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop 'Breeze 语音.lnk'
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $voiceScripts 'breeze-webui.ps1') + '"'
    $s.WorkingDirectory = $voiceScripts
    $ico = Join-Path $InstallRoot 'voice\icon\breeze-icon.ico'
    if (Test-Path $ico) { $s.IconLocation = $ico + ',0' }
    $s.Description = '打开本地语音工作室（127.0.0.1:8140）'
    $s.Save()
    Write-Host "[6/6] 桌面快捷方式 → $lnk"
  } catch {
    Write-Host "[6/6] 快捷方式没建成（不影响使用）：$($_.Exception.Message)"
  }
}

# ---------- 下一步 ----------
$modelQ4 = Join-Path $VoiceRoot 'breeze-tts-2-q4_k.gguf'
Write-Host ''
Write-Host '摆好了。接下来按顺序：'
if (-not (Test-Path $modelQ4)) {
  Write-Host '  1) 下模型（不进包，q4 2.4G 够用；q8 3.4G 可选）：'
  Write-Host ('     powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $voiceScripts '_setup\Get-Models.ps1') + '"')
  Write-Host '     直连 HuggingFace 不通就加 -Proxy http://127.0.0.1:10808；断了重跑会接着补'
} else {
  Write-Host "  1) 模型已在 $VoiceRoot，跳过下载"
}
Write-Host ('  2) 看服务能不能起来：powershell -File "' + (Join-Path $voiceScripts 'breeze-tts.ps1') + '" -Status   （期望 health=True）')
Write-Host '  3) 打开网页工作室（或双击桌面「Breeze 语音」）：http://127.0.0.1:8140/'
Write-Host '  4) 想接 QQ 语音：先装包 1（QQ 桥接与 NapCat），桥接会自动调用上面那个转发脚本'
Write-Host '  5) 出问题先看 NEXT-AI.md 的「症状 → 排查」表'
