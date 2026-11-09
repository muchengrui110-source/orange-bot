# breeze-tts.ps1 - on-demand local TTS front end for the QQ bridge.
# ASCII only: PowerShell 5.1 parses -File scripts as ANSI unless a UTF-8 BOM is
# present, so Chinese literals here would corrupt the parser.
#
# Detached spawn uses WScript.Shell.Run on purpose. Start-Process with redirects
# makes the child inherit every inheritable handle of the parent, so a spawned
# server keeps the caller's stdout pipe open and hangs node's exec / PowerShell
# pipelines. WScript.Run does not inherit handles.
#
# Usage:
#   powershell -File breeze-tts.ps1 -TextFile in.txt -Out out.mp3 [-Model q4|q8]
#              [-Voice <savedVoiceId>] [-Instruction <text>] [-Cfg 1.0]
#   ... -Status         show health / pid / loaded model
#   ... -Stop           stop the server now
param(
  [string]$Text = '',
  [string]$TextFile = '',
  [string]$Out = '',
  [string]$Model = '',
  [string]$Voice = '',
  [string]$Instruction = '',
  [string]$Persona = '',
  [string]$PersonaFile = '',
  [double]$Cfg = -1,
  [switch]$NoStart,
  [switch]$Stop,
  [switch]$Status,
  [switch]$EnsureServer,
  [switch]$ShowVoice,
  [switch]$DesignOnly
)

# ---------------------------------------------------------------------------
# Portable paths. Every machine-specific location comes from
# <package root>\voice-paths.json (written by the installer). When that file is
# missing the built-in defaults below are used, so the scripts still run on a
# fresh copy of the bundle.
# ---------------------------------------------------------------------------
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

# Keep the config object out of any name that collides with a typed parameter:
# PowerShell variables are case insensitive, so $cfg would BE the [double]$Cfg.
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

# The fallback defaults are deliberately generic: the bridge locations live under
# the DSH home, the model/binary root is <package root>\engine-runtime (unpacked
# by install.ps1; move it by editing voice-paths.json, nothing is machine-bound).
$DshHome = $env:DSH_HOME
if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$DshBridge = Join-Path $DshHome 'qq-bridge'

$ErrorActionPreference = 'Stop'
$Root       = VP 'voiceRoot' (Join-Path $PkgRoot 'engine-runtime')
$BinDir     = VP 'voiceBinDir' (Join-Path $Root 'breeze-tts-2-v0.1.6-windows-x64-vulkan')
$ServerExe  = Join-Path $BinDir 'breeze-server.exe'
$RunDir     = Join-Path $Root 'run'
$ConfigPath = VP 'configFile' (Join-Path $DshBridge 'breeze-tts.json')
$StatePath  = Join-Path $RunDir 'state.json'
$ActivityPath = Join-Path $RunDir 'last-activity.txt'
$ServerLog  = Join-Path $RunDir 'server.log'
$ServerErr  = Join-Path $RunDir 'server.err.log'
$JanitorPid = Join-Path $RunDir 'janitor.pid'
$JanitorPs1 = Join-Path (Join-Path $PSScriptRoot '_setup') 'breeze-janitor.ps1'

if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir -Force | Out-Null }

# Keep the config object out of any name that collides with a typed parameter:
# PowerShell variables are case insensitive, so $cfg would BE the [double]$Cfg.
function Get-Conf {
  $conf = [ordered]@{
    enabled = $true; port = 8137; model = 'q4'; idleExitMinutes = 10
    cfgScale = 1.0; instruction = 'Speak naturally.'; voiceId = ''
    voicesDir = (VP 'voicesDir' (Join-Path $DshBridge 'voice\breeze-voices'))
    personaFile = (VP 'personaFile' (Join-Path $DshBridge 'personas.json'))
    voicePersonas = (VP 'voicePersonas' (Join-Path $DshBridge 'voice-personas.json'))
    startupTimeoutSeconds = 120; requestTimeoutSeconds = 180
  }
  if (Test-Path $ConfigPath) {
    try {
      $raw = Get-Content -Raw -Encoding UTF8 -Path $ConfigPath
      $j = $raw | ConvertFrom-Json
      foreach ($k in @($j.PSObject.Properties.Name)) { if ($conf.Contains($k)) { $conf[$k] = $j.$k } }
    } catch { Write-Warning "config unreadable, using defaults: $($_.Exception.Message)" }
  }
  return $conf
}

function Get-ModelPath([string]$name) {
  if ($name -eq 'q8') { return (Join-Path $Root 'breeze-tts-2-q8_0.gguf') }
  return (Join-Path $Root 'breeze-tts-2-q4_k.gguf')
}

# Build the voice description for a persona mode.
# The base (gender / age / timbre) comes from voice-personas.json; the tone is
# derived from the mode's own replyStyle + behavior + identity at call time, so
# editing the persona text changes the voice without touching any config.
function Get-PersonaInstruction([string]$name, [string]$personaPath, [string]$mapPath, [string]$fallback) {
  if (-not $name) { return $fallback }
  $map = $null; $people = $null
  try { if (Test-Path $mapPath) { $map = Get-Content -Raw -Encoding UTF8 -Path $mapPath | ConvertFrom-Json } } catch { }
  try { if (Test-Path $personaPath) { $people = Get-Content -Raw -Encoding UTF8 -Path $personaPath | ConvertFrom-Json } } catch { }
  if (-not $people -or -not $people.chats) { return $fallback }

  $mode = $null
  $chatKeys = @($people.chats.PSObject.Properties.Name)
  foreach ($k in $chatKeys) {
    $chat = $people.chats.$k
    if ($chat.active -eq $name -and $chat.modes.PSObject.Properties.Name -contains $name) { $mode = $chat.modes.$name; break }
  }
  if (-not $mode) {
    foreach ($k in $chatKeys) {
      $chat = $people.chats.$k
      if ($chat.modes.PSObject.Properties.Name -contains $name) { $mode = $chat.modes.$name; break }
    }
  }
  if ($null -eq $mode) { return $fallback }

  $base = $null
  $entry = $null
  if ($map -and $map.defaults -and $map.defaults.base) { $base = $map.defaults.base }
  if ($map -and $map.personas -and $map.personas.PSObject.Properties.Name -contains $name) {
    $entry = $map.personas.$name
    if ($entry -and $entry.base) { $base = $entry.base }
  }
  if (-not $base) { $base = $fallback }

  $blob = ''
  if ($mode -is [string]) { $blob = [string]$mode }
  else {
    $blob = ('' + $mode.replyStyle)
    if (-not $blob.Trim()) { $blob = ('' + $mode.behavior + ' ' + $mode.identity) }
  }
  $traits = New-Object System.Collections.ArrayList
  $skip = @()
  if ($entry -and $entry.skipTraits) { $skip = @($entry.skipTraits) }
  if ($map -and $map.traits) {
    foreach ($p in $map.traits.PSObject.Properties) {
      if ($blob -match $p.Name) {
        $v = [string]$p.Value
        if ($skip -notcontains $v) { [void]$traits.Add($v) }
      }
    }
  }
  $toneList = @($traits | Select-Object -Unique | Select-Object -First 3)
  $out = $base
  if ($toneList.Count -gt 0) { $out = $out + '；' + ($toneList -join '，') }
  if ($entry -and $entry.extra) { $out = $out + '；' + [string]$entry.extra }
  return $out
}

function Test-Health([int]$port) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    if ($r.StatusCode -eq 200 -and $r.Content -match '"status"\s*:\s*"ok"') { return $true }
  } catch { }
  return $false
}

function Read-State {
  if (-not (Test-Path $StatePath)) { return $null }
  try { return (Get-Content -Raw -Encoding UTF8 -Path $StatePath | ConvertFrom-Json) } catch { return $null }
}

function Get-ServerProc {
  return (Get-Process -Name 'breeze-server' -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Start-Detached([string]$exe, [string]$argLine, [string]$outLog, [string]$errLog) {
  $inner = '"' + $exe + '" ' + $argLine
  if ($outLog) { $inner = $inner + ' > "' + $outLog + '"' }
  if ($errLog) { $inner = $inner + ' 2> "' + $errLog + '"' }
  $ws = New-Object -ComObject WScript.Shell
  $null = $ws.Run('cmd.exe /c "' + $inner + '"', 0, $false)
}

function Stop-Server {
  $procs = @(Get-Process -Name 'breeze-server' -ErrorAction SilentlyContinue)
  foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { } }
  if ($procs.Count -gt 0) { Start-Sleep -Milliseconds 800 }
  Remove-Item $StatePath -Force -ErrorAction SilentlyContinue
}

function Ensure-Janitor {
  $alive = $false
  if (Test-Path $JanitorPid) {
    $jp = (Get-Content -Raw -Path $JanitorPid).Trim()
    if ($jp -and (Get-Process -Id ([int]$jp) -ErrorAction SilentlyContinue)) { $alive = $true }
  }
  if (-not $alive -and (Test-Path $JanitorPs1)) {
    Start-Detached 'powershell.exe' ('-NoProfile -ExecutionPolicy Bypass -File "' + $JanitorPs1 + '"') (Join-Path $RunDir 'janitor.log') (Join-Path $RunDir 'janitor.err.log')
  }
}

function Wait-Healthy([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Ensure-Server([int]$port, [string]$modelName, $conf) {
  $modelPath = Get-ModelPath $modelName
  if (-not (Test-Path $modelPath)) { throw "model file missing: $modelPath" }
  if (-not (Test-Path $ServerExe)) { throw "server binary missing: $ServerExe" }

  $state = Read-State
  $loadedModel = 'q4'
  if ($state -and $state.model) { $loadedModel = $state.model }

  $proc = Get-ServerProc
  if ($proc) {
    if (Test-Health $port) {
      if ($loadedModel -eq $modelName) { return }
      Stop-Server
    } else {
      # already loading: give it the same budget before replacing it
      if ((Wait-Healthy $port ([int]$conf.startupTimeoutSeconds)) -and $loadedModel -eq $modelName) { return }
      Stop-Server
    }
  }

  if (-not (Test-Path $conf.voicesDir)) { New-Item -ItemType Directory -Path $conf.voicesDir -Force | Out-Null }
  $argLine = '"' + $modelPath + '" --host 127.0.0.1 --port ' + $port +
             ' --voices-dir "' + $conf.voicesDir + '" --parallel 1 --webui'
  Start-Detached $ServerExe $argLine $ServerLog $ServerErr

  $waitProc = $null
  $spawnDeadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $spawnDeadline) {
    $waitProc = Get-ServerProc
    if ($waitProc) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $waitProc) { throw "server process did not appear (see $ServerErr)" }

  $st = [ordered]@{ pid = $waitProc.Id; model = $modelName; port = $port; startedAt = (Get-Date).ToString('o') }
  $st | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8

  if (-not (Wait-Healthy $port ([int]$conf.startupTimeoutSeconds))) {
    throw "server did not become healthy within $($conf.startupTimeoutSeconds)s (see $ServerErr)"
  }
  Write-Verbose "server up: pid $($waitProc.Id) model $modelName"
}

function Touch-Activity { Set-Content -Path $ActivityPath -Value (Get-Date).ToString('o') -Encoding UTF8 }

$conf = Get-Conf

if (-not $Status -and -not $Stop -and -not $conf.enabled) {
  Write-Output 'FAIL disabled in breeze-tts.json'
  exit 3
}

if ($Status) {
  $st = Read-State
  $ok = Test-Health ([int]$conf.port)
  $m = '-'; $p = '-'
  if ($st) { $m = $st.model; $p = $st.pid }
  Write-Output ("health={0} pid={1} model={2}" -f $ok, $p, $m)
  exit 0
}

if ($Stop) { Stop-Server; Write-Output 'stopped'; exit 0 }

if ($EnsureServer) {
  $wantModel = $Model
  if (-not $wantModel) { $wantModel = $conf.model }
  try {
    Ensure-Server ([int]$conf.port) $wantModel $conf
    Touch-Activity
    Ensure-Janitor
    Write-Output 'server ready'
    exit 0
  } catch {
    Write-Output ("FAIL {0}" -f $_.Exception.Message)
    exit 2
  }
}

if (-not $Text -and $TextFile) {
  if (-not (Test-Path $TextFile)) { Write-Error "text file missing: $TextFile"; exit 1 }
  $Text = [System.IO.File]::ReadAllText($TextFile, (New-Object System.Text.UTF8Encoding($false)))
}

if ($Model -eq '') { $Model = $conf.model }
if ($Model -notin @('q4', 'q8')) { $Model = 'q4' }
if ($Cfg -lt 0) { $Cfg = [double]$conf.cfgScale }
if ($Instruction -eq '') { $Instruction = $conf.instruction }
if ($Voice -eq '') { $Voice = $conf.voiceId }

# a persona name overrides the instruction with one derived from that mode's text,
# and switches to the saved voice for that persona when one exists (a saved voice
# keeps the timbre fixed; a pure design prompt re-invents it on every request)
if ($Persona) {
  $pf = $conf.personaFile
  if ($PersonaFile) { $pf = $PersonaFile }
  $Instruction = Get-PersonaInstruction -name $Persona -personaPath $pf -mapPath $conf.voicePersonas -fallback $Instruction
  if (-not $PSBoundParameters.ContainsKey('Voice') -and -not $DesignOnly) {
    try {
      if (Test-Path $conf.voicePersonas) {
        $vm = Get-Content -Raw -Encoding UTF8 -Path $conf.voicePersonas | ConvertFrom-Json
        if ($vm.personas -and $vm.personas.PSObject.Properties.Name -contains $Persona) {
          $pvid = $vm.personas.$Persona.voiceId
          if ($pvid -and (Test-Path (Join-Path $conf.voicesDir ($pvid + '.breeze')))) { $Voice = $pvid }
        }
      }
    } catch { }
  }
}

if ($ShowVoice) {
  Write-Output ("persona=" + $Persona + " voiceId=" + $Voice + " instruction=" + $Instruction)
  exit 0
}

if (-not $Text -or -not $Out) { Write-Error 'need -Text/-TextFile and -Out'; exit 1 }

$port = [int]$conf.port
$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

try {
  if (-not $NoStart) { Ensure-Server $port $Model $conf }
  if (-not (Test-Health $port)) { throw 'server not reachable' }

  $payload = [ordered]@{
    model = 'tts-1'
    input = $Text
    response_format = 'mp3'
    instructions = $Instruction
    cfg_scale = $Cfg
    seed = 42
  }
  if ($Voice -ne '') { $payload['voice'] = $Voice }
  $json = $payload | ConvertTo-Json -Compress
  $jsonPath = Join-Path $RunDir 'request.json'
  [System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))

  $tmpOut = "$Out.tmp"
  Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue
  Touch-Activity
  $maxTime = [int]$conf.requestTimeoutSeconds
  $curlOut = curl.exe -sS --max-time $maxTime -X POST "http://127.0.0.1:$port/v1/audio/speech" `
    -H 'Content-Type: application/json; charset=utf-8' --data-binary "@$jsonPath" -o $tmpOut 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw ("curl exit {0}: {1}" -f $code, ($curlOut | Out-String).Trim()) }
  if (-not (Test-Path $tmpOut)) { throw 'no output produced' }
  $len = (Get-Item $tmpOut).Length
  if ($len -lt 2048) {
    $head = ''
    if ($len -gt 0) { try { $head = (Get-Content -Raw -Path $tmpOut) } catch { } }
    Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue
    throw ("short/invalid response ({0} bytes): {1}" -f $len, $head)
  }
  Move-Item -Force $tmpOut $Out
  Touch-Activity
  Ensure-Janitor
  Write-Output ("OK {0} (engine=breeze model={1} bytes={2})" -f $Out, $Model, $len)
  exit 0
} catch {
  Write-Output ("FAIL {0}" -f $_.Exception.Message)
  exit 2
}
