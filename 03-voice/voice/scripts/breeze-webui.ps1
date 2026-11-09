# breeze-webui.ps1 - open the local voice studio page in the default browser,
# starting whatever is needed first.
#  1) the TTS server (breeze-server, on demand, idle-exits on its own)
#  2) the studio page server (node, serves the page and proxies /api to the TTS)
# ASCII only (PowerShell 5.1 parses -File scripts as ANSI without a BOM).
param(
  [switch]$NoBrowser
)

# Package root\voice-paths.json drives every machine-specific location; the
# defaults below keep the script working when that file has not been written
# yet (see breeze-tts.ps1 for the same loader).
$P = $PSScriptRoot
for ($i = 0; $i -lt 4 -and $P; $i++) {
  $cand = Join-Path $P 'voice-paths.json'
  if (Test-Path $cand) {
    # a damaged file must not kill the script: fall back to the defaults
    try { $VP = Get-Content -Raw -Encoding UTF8 -Path $cand | ConvertFrom-Json } catch { $VP = $null }
    break
  }
  $P = Split-Path $P -Parent
}
if (-not $VP) { $VP = [pscustomobject]@{} }
function VP([string]$name, [string]$fallback) {
  if ($VP.PSObject.Properties.Name -contains $name -and $VP.$name) { return [string]$VP.$name }
  return $fallback
}

# bundle layout is <pkg root>\voice\scripts, so walk up to the first ancestor
# that holds voice\scripts (use $PkgRoot, never a hard-coded D:\ path)
$PkgRoot = $PSScriptRoot
for ($i = 0; $i -lt 5 -and $PkgRoot; $i++) {
  if (Test-Path (Join-Path (Join-Path $PkgRoot 'voice') 'scripts')) { break }
  $PkgRoot = Split-Path $PkgRoot -Parent
}
if (-not $PkgRoot) { $PkgRoot = $PSScriptRoot }

# generic fallback defaults: bridge files under the DSH home, model root is
# <package root>\engine-runtime (install.ps1 unpacks the engine there; move it by
# editing voice-paths.json — no machine-specific path is baked in)
$DshHome = $env:DSH_HOME
if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$DshBridge = Join-Path $DshHome 'qq-bridge'

$ErrorActionPreference = 'Stop'
$Root    = VP 'voiceRoot' (Join-Path $PkgRoot 'engine-runtime')
$RunDir  = Join-Path $Root 'run'
$Launcher = Join-Path $PSScriptRoot 'breeze-tts.ps1'
$ConfigPath = VP 'configFile' (Join-Path $DshBridge 'breeze-tts.json')
$ActivityPath = Join-Path $RunDir 'last-activity.txt'
$StudioDir = VP 'studioDir' (Join-Path (Join-Path $PkgRoot 'voice') 'studio')
$StudioJs  = Join-Path $StudioDir 'server.js'
$StudioLog = Join-Path $StudioDir 'studio.log'
$StudioErr = Join-Path $StudioDir 'studio.err.log'
$Node = VP 'nodeExe' (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
if (-not (Test-Path $Node)) { $Node = 'node' }

$uiPort = 8140
$base = "http://127.0.0.1:$uiPort/"

function Test-Port([int]$p) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(600)
    if ($ok) { $c.EndConnect($iar) }
    $c.Close()
    return $ok
  } catch { return $false }
}

function Start-Detached([string]$exe, [string]$argLine, [string]$outLog, [string]$errLog) {
  $inner = '"' + $exe + '" ' + $argLine
  if ($outLog) { $inner = $inner + ' > "' + $outLog + '"' }
  if ($errLog) { $inner = $inner + ' 2> "' + $errLog + '"' }
  $ws = New-Object -ComObject WScript.Shell
  $null = $ws.Run('cmd.exe /c "' + $inner + '"', 0, $false)
}

function Fail([string]$msg) {
  $ws = New-Object -ComObject WScript.Shell
  $null = $ws.Popup($msg, 20, 'Breeze 语音', 48)
  exit 1
}

if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir -Force | Out-Null }

# 1) TTS server (model + API)
$ready = & powershell -NoProfile -ExecutionPolicy Bypass -File $Launcher -EnsureServer 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Fail ("语音模型没起来，看看日志：" + (Join-Path $RunDir 'server.err.log')) }

# 2) studio page server
if (-not (Test-Port $uiPort)) {
  Start-Detached $Node ('"' + $StudioJs + '" ' + $uiPort) $StudioLog $StudioErr
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and -not (Test-Port $uiPort)) { Start-Sleep -Milliseconds 300 }
}
if (-not (Test-Port $uiPort)) { Fail ("页面服务没起来，看看日志：" + $StudioErr) }

Set-Content -Path $ActivityPath -Value (Get-Date).ToString('o') -Encoding UTF8
if (-not $NoBrowser) { Start-Process $base }
Write-Output ('opened ' + $base)
exit 0
