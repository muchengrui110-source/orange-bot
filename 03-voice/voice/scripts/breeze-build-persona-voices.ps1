# breeze-build-persona-voices.ps1 - give every persona a fixed voice.
# Design mode invents a voice from a text description on every request, so the
# timbre drifts. This script designs one take per persona, saves it as a normal
# .breeze voice and writes the id back into voice-personas.json; from then on
# that persona always uses the saved voice (the tone text becomes direction).
# ASCII only (PowerShell 5.1 reads -File scripts as ANSI without a BOM).
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Portable paths: <package root>\voice-paths.json, defaults below if missing.
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
# that holds voice\scripts (never a hard-coded D:\ path)
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

$Root = VP 'voiceRoot' (Join-Path $PkgRoot 'engine-runtime')
$RunDir = Join-Path $Root 'run'
$WorkDir = Join-Path $Root '_persona'
$MapPath = VP 'voicePersonas' (Join-Path $DshBridge 'voice-personas.json')
$VoicesDir = VP 'voicesDir' (Join-Path $DshBridge 'voice\breeze-voices')
$Launcher = Join-Path $PSScriptRoot 'breeze-tts.ps1'
$Saver = Join-Path $PSScriptRoot 'breeze-save-voice.ps1'

if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }

$seedText = '嗯，我在呢。今天就先这样吧。'
$seedFile = Join-Path $WorkDir 'seed.txt'
[System.IO.File]::WriteAllText($seedFile, $seedText, (New-Object System.Text.UTF8Encoding($false)))

$map = Get-Content -Raw -Encoding UTF8 -Path $MapPath | ConvertFrom-Json
$names = @($map.personas.PSObject.Properties.Name)
$i = 0
foreach ($name in $names) {
  $i++
  $entry = $map.personas.$name
  $id = 'p' + $i
  if (-not $Force -and $entry.voiceId -and (Test-Path (Join-Path $VoicesDir ($entry.voiceId + '.breeze')))) {
    Write-Output ("skip " + $name + " -> " + $entry.voiceId)
    continue
  }
  $mp3 = Join-Path $WorkDir ('demo-' + $id + '.mp3')
  Remove-Item $mp3 -Force -ErrorAction SilentlyContinue
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Launcher -TextFile $seedFile -Out $mp3 -Persona $name 2>&1 | Out-String
  if (-not (Test-Path $mp3)) { Write-Output ("FAIL design " + $name + ": " + $out.Trim()); continue }
  $save = & powershell -NoProfile -ExecutionPolicy Bypass -File $Saver -Name $id -Audio $mp3 -TextFile $seedFile -Description $name 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Write-Output ("FAIL save " + $name + ": " + $save.Trim()); continue }
  $entry | Add-Member -NotePropertyName voiceId -NotePropertyValue $id -Force
  [System.IO.File]::WriteAllText($MapPath, ($map | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ("ok " + $name + " -> " + $id)
}
Write-Output 'done'
