# breeze-save-voice.ps1 - register a saved voice (clone) with the local TTS server.
# ASCII only (PowerShell 5.1 reads -File scripts as ANSI without a UTF-8 BOM).
#
# Needs a clean reference clip and its exact transcript. The transcript is read
# from a UTF-8 file so Chinese survives; the upload goes through HttpClient so
# the multipart body is real UTF-8 (curl.exe argv would go through the ANSI code
# page and mangle it).
#
# Usage:
#   powershell -File breeze-save-voice.ps1 -Name myvoice -Audio ref.wav -TextFile ref.txt
#   ... [-Description "calm young man"] [-SetDefault]
#   -Audio may be any format ffmpeg can read; it is converted to 24 kHz mono WAV.
param(
  [Parameter(Mandatory=$true)][string]$Name,
  [Parameter(Mandatory=$true)][string]$Audio,
  [Parameter(Mandatory=$true)][string]$TextFile,
  [string]$Description = '',
  [string]$Model = '',
  [switch]$SetDefault
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

# Portable paths: <package root>\voice-paths.json, with the defaults below used
# when that file is missing. The loader sits right after param() so the config
# object never lands in a name a typed parameter already owns ($cfg is [double]$Cfg).
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
# editing voice-paths.json - no machine-specific path is baked in)
$DshHome = $env:DSH_HOME
if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$DshBridge = Join-Path $DshHome 'qq-bridge'

$Root = VP 'voiceRoot' (Join-Path $PkgRoot 'engine-runtime')
$ConfigPath = VP 'configFile' (Join-Path $DshBridge 'breeze-tts.json')
$Launcher = Join-Path $PSScriptRoot 'breeze-tts.ps1'
# where the server keeps the .breeze clones (the upload endpoint does the writing)
$VoicesDir = VP 'voicesDir' (Join-Path $DshBridge 'voice\breeze-voices')
$FfmpegExe = VP 'ffmpegExe' 'ffmpeg'
$RunDir = Join-Path $Root 'run'
$WorkWav = Join-Path $RunDir 'voice-ref.wav'

if (-not (Test-Path $Audio)) { Write-Error "audio not found: $Audio"; exit 1 }
if (-not (Test-Path $TextFile)) { Write-Error "transcript not found: $TextFile"; exit 1 }
if ($Name -notmatch '^[A-Za-z0-9_-]{1,64}$') { Write-Error 'name: letters, digits, dash, underscore, max 64'; exit 1 }

$refText = [System.IO.File]::ReadAllText($TextFile, (New-Object System.Text.UTF8Encoding($false))).Trim()
if (-not $refText) { Write-Error 'transcript is empty'; exit 1 }

# make sure the server is up (starts it on demand, same config as the bridge)
$ensArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Launcher, '-EnsureServer')
if ($Model) { $ensArgs += @('-Model', $Model) }
$ready = & powershell @ensArgs
if ($LASTEXITCODE -ne 0) { Write-Error "server not ready: $ready"; exit 2 }

$port = 8137
if (Test-Path $ConfigPath) {
  try { $j = (Get-Content -Raw -Encoding UTF8 -Path $ConfigPath) | ConvertFrom-Json; if ($j.port) { $port = [int]$j.port } } catch { }
}

# normalise to 24 kHz mono wav
$ff = $FfmpegExe
if (-not (Test-Path $ff)) { $ff = 'ffmpeg' }
if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir -Force | Out-Null }
& $ff -hide_banner -loglevel error -y -i $Audio -ac 1 -ar 24000 $WorkWav
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $WorkWav)) { Write-Error 'ffmpeg could not read the reference audio'; exit 3 }

$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(180)
$form = [System.Net.Http.MultipartFormDataContent]::new()
$bytes = [System.IO.File]::ReadAllBytes($WorkWav)
$fileContent = [System.Net.Http.ByteArrayContent]::new($bytes)
$fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('audio/wav')
$form.Add($fileContent, 'ref_audio', 'reference.wav')
$form.Add(([System.Net.Http.StringContent]::new($refText, [System.Text.Encoding]::UTF8)), 'ref_text')
$form.Add(([System.Net.Http.StringContent]::new($Name, [System.Text.Encoding]::UTF8)), 'name')
if ($Description) {
  $form.Add(([System.Net.Http.StringContent]::new($Description, [System.Text.Encoding]::UTF8)), 'description')
}

$url = "http://127.0.0.1:$port/v1/voices"
try {
  $resp = $client.PostAsync($url, $form).Result
  $body = $resp.Content.ReadAsStringAsync().Result
} catch {
  Write-Error ("upload failed: " + $_.Exception.Message)
  exit 4
} finally {
  $client.Dispose()
  Remove-Item $WorkWav -Force -ErrorAction SilentlyContinue
}

if (-not $resp.IsSuccessStatusCode) { Write-Error ("server said {0}: {1}" -f [int]$resp.StatusCode, $body); exit 5 }
Write-Output ("saved voice: " + $body)

if ($SetDefault) {
  $j = (Get-Content -Raw -Encoding UTF8 -Path $ConfigPath) | ConvertFrom-Json
  $j.voiceId = $Name
  [System.IO.File]::WriteAllText($ConfigPath, ($j | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ("default voice set to " + $Name)
}

exit 0
