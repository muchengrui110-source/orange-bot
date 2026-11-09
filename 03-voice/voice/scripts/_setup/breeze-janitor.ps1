# breeze-janitor.ps1 - idle watchdog for the on-demand breeze-server.
# ASCII only (PowerShell 5.1 parses -File scripts as ANSI without a BOM).
# Runs detached with a hidden window; kills the server after idleExitMinutes of
# no requests, then exits. Restarted automatically by breeze-tts.ps1 when needed.
$ErrorActionPreference = 'SilentlyContinue'

# Portable paths: <package root>\voice-paths.json found by walking up 4 levels
# from here (_setup -> scripts -> voice -> package root); defaults below apply
# when the file has not been generated yet.
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

# bundle layout is <pkg root>\voice\scripts\_setup, so walk up to the first
# ancestor that holds voice\scripts (never a hard-coded D:\ path)
$PkgRoot = $PSScriptRoot
for ($i = 0; $i -lt 5 -and $PkgRoot; $i++) {
  if (Test-Path (Join-Path (Join-Path $PkgRoot 'voice') 'scripts')) { break }
  $PkgRoot = Split-Path $PkgRoot -Parent
}
if (-not $PkgRoot) { $PkgRoot = $PSScriptRoot }

# generic fallback defaults: the runtime config lives under the DSH home and the
# model root is <package root>\engine-runtime (install.ps1 unpacks it there)
$DshHome = $env:DSH_HOME
if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$DshBridge = Join-Path $DshHome 'qq-bridge'

$Root      = VP 'voiceRoot' (Join-Path $PkgRoot 'engine-runtime')
$RunDir    = Join-Path $Root 'run'
$StatePath = Join-Path $RunDir 'state.json'
$ActivityPath = Join-Path $RunDir 'last-activity.txt'
$JanitorPid = Join-Path $RunDir 'janitor.pid'
$ConfigPath = VP 'configFile' (Join-Path $DshBridge 'breeze-tts.json')

$idleMinutes = 10
if (Test-Path $ConfigPath) {
  try {
    $j = (Get-Content -Raw -Encoding UTF8 -Path $ConfigPath) | ConvertFrom-Json
    if ($j.idleExitMinutes) { $idleMinutes = [int]$j.idleExitMinutes }
  } catch { }
}
if ($idleMinutes -lt 1) { $idleMinutes = 10 }

Set-Content -Path $JanitorPid -Value $PID

while ($true) {
  Start-Sleep -Seconds 60

  if (-not (Test-Path $StatePath)) { break }
  $st = $null
  try { $st = (Get-Content -Raw -Encoding UTF8 -Path $StatePath) | ConvertFrom-Json } catch { break }
  if (-not $st -or -not $st.pid) { break }

  $proc = Get-Process -Id $st.pid -ErrorAction SilentlyContinue
  if (-not $proc) { Remove-Item $StatePath -Force -ErrorAction SilentlyContinue; break }

  $last = $null
  if (Test-Path $ActivityPath) {
    try { $last = [datetime]::Parse((Get-Content -Raw -Path $ActivityPath).Trim()) } catch { $last = $null }
  }
  if (-not $last -and $st.startedAt) {
    try { $last = [datetime]::Parse($st.startedAt) } catch { $last = (Get-Date) }
  }
  if (-not $last) { $last = Get-Date }

  $idle = ((Get-Date) - $last).TotalMinutes

  # someone has the web UI (or an API client) connected: not idle
  $busy = $false
  try {
    $port = 8137
    if ($st.port) { $port = [int]$st.port }
    $conns = @(Get-NetTCPConnection -LocalPort $port -State Established -ErrorAction SilentlyContinue)
    if ($conns.Count -gt 0) { $busy = $true }
  } catch { }

  if ($idle -ge $idleMinutes -and -not $busy) {
    Stop-Process -Id $st.pid -Force
    Start-Sleep -Milliseconds 500
    Remove-Item $StatePath -Force -ErrorAction SilentlyContinue
    break
  }
}

Remove-Item $JanitorPid -Force -ErrorAction SilentlyContinue
