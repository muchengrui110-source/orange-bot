# Parallel chunked download (single connections are throttled on this machine).
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads -File scripts as ANSI
# unless they carry a UTF-8 BOM, and Chinese literals break the parser.
# Usage: powershell -File Get-Chunked.ps1 -Url <url> -Out <file> -Size <bytes> [-Sha256 <hash>] [-Chunks 4]
param(
  [Parameter(Mandatory=$true)][string]$Url,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][long]$Size,
  [string]$Sha256 = '',
  [int]$Chunks = 4,
  [string]$Proxy = ''
)

$ErrorActionPreference = 'Stop'
$log = "$Out.log"
function Log($m) { $line = "{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Add-Content -Path $log -Value $line; Write-Host $line }

# empty -Proxy means direct connection: leave HTTP(S)_PROXY untouched
if ($Proxy) {
  if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $Proxy }
  if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $Proxy }
}

$dir = Split-Path -Parent $Out
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
Set-Content -Path $log -Value ("start {0} size={1} chunks={2}" -f (Split-Path -Leaf $Out), $Size, $Chunks)

$per = [math]::Ceiling($Size / $Chunks)
$parts = @()
$procs = @()
for ($i = 0; $i -lt $Chunks; $i++) {
  $start = $i * $per
  if ($start -ge $Size) { break }
  $end = [math]::Min($start + $per - 1, $Size - 1)
  $p = "$Out.part$i"
  $parts += $p
  Remove-Item $p -ErrorAction SilentlyContinue
  $procs += Start-Process -FilePath 'curl.exe' -PassThru -NoNewWindow -ArgumentList @(
    '-sS', '-L', '--retry', '8', '--retry-delay', '3', '--retry-all-errors',
    '-r', "$start-$end", '-o', $p, $Url
  )
}

$deadline = (Get-Date).AddMinutes(120)
while ($true) {
  $running = @($procs | Where-Object { -not $_.HasExited })
  if ($running.Count -eq 0) { break }
  if ((Get-Date) -gt $deadline) { Log 'timeout, killing curl'; $procs | ForEach-Object { try { $_.Kill() } catch {} }; break }
  Start-Sleep -Seconds 15
}

$got = 0
foreach ($p in $parts) { if (Test-Path $p) { $got += (Get-Item $p).Length } }
Log ("chunks done: {0} / {1} bytes" -f $got, $Size)
if ($got -ne $Size) { Log 'size mismatch, keeping parts'; exit 2 }

Log 'concatenating'
$outFs = [System.IO.File]::Create($Out)
try {
  $buf = New-Object byte[] (8 * 1024 * 1024)
  foreach ($p in $parts) {
    $in = [System.IO.File]::OpenRead($p)
    try { while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { $outFs.Write($buf, 0, $n) } }
    finally { $in.Dispose() }
  }
} finally { $outFs.Dispose() }

$final = (Get-Item $Out).Length
Log ("joined: {0} bytes" -f $final)
if ($final -ne $Size) { Log 'joined size mismatch'; exit 3 }

if ($Sha256 -ne '') {
  Log 'verifying sha256'
  $h = (Get-FileHash -Path $Out -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $Sha256.ToLower()) { Log ("sha256 mismatch expected={0} actual={1}" -f $Sha256, $h); exit 4 }
  Log 'sha256 ok'
}

foreach ($p in $parts) { Remove-Item $p -ErrorAction SilentlyContinue }
Log 'OK'
