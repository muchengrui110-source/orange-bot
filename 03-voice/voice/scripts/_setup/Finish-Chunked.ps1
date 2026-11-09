# Finish-Chunked.ps1 - top up a partially downloaded chunked file with more
# connections, then join and verify. ASCII only (PowerShell 5.1 reads -File
# scripts as ANSI without a BOM).
# Expects existing files named <Out>.part0 .. <Out>.part(N-1); keeps whatever
# bytes they already hold and downloads only the remaining tail of each range.
param(
  [Parameter(Mandatory=$true)][string]$Url,
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][long]$Size,
  [string]$Sha256 = '',
  [int]$Parts = 4,
  [long]$PieceBytes = 50331648,
  [string]$Proxy = ''
)
$ErrorActionPreference = 'Stop'
$log = "$Out.finish.log"
function Log($m) { $line = "{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Add-Content -Path $log -Value $line; Write-Host $line }
# empty -Proxy means direct connection: leave HTTP(S)_PROXY untouched
if ($Proxy) {
  if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $Proxy }
  if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $Proxy }
}

$per = [math]::Ceiling($Size / $Parts)
$order = New-Object System.Collections.ArrayList
$procs = @()
$expect = @{}
$i = 0
while ($i -lt $Parts) {
  $rangeStart = [long]($i * $per)
  if ($rangeStart -ge $Size) { break }
  $rangeEnd = [math]::Min($rangeStart + $per - 1, $Size - 1)
  $base = "$Out.part$i"
  $got = 0
  if (Test-Path $base) { $got = (Get-Item $base).Length }
  if ($got -gt ($rangeEnd - $rangeStart + 1)) { throw "part$i larger than its range" }
  [void]$order.Add(@{ path = $base; len = $got })
  $cursor = $rangeStart + $got
  $k = 0
  if ($cursor -le $rangeEnd) {
    $need = $rangeEnd - $cursor + 1
    $pieces = [math]::Max(1, [math]::Ceiling($need / $PieceBytes))
    $pieceLen = [math]::Ceiling($need / $pieces)
    while ($cursor -le $rangeEnd) {
      $end = [math]::Min($cursor + $pieceLen - 1, $rangeEnd)
      $xp = "$Out.part${i}_x$k"
      Remove-Item $xp -ErrorAction SilentlyContinue
      $procs += Start-Process -FilePath 'curl.exe' -PassThru -NoNewWindow -ArgumentList @(
        '-sS', '-L', '--retry', '8', '--retry-delay', '3', '--retry-all-errors',
        '-r', "$cursor-$end", '-o', $xp, $Url
      )
      $expect[$xp] = $end - $cursor + 1
      [void]$order.Add(@{ path = $xp; len = ($end - $cursor + 1) })
      $cursor = $end + 1
      $k++
    }
  }
  $i++
}

Log ("spawned {0} curl processes" -f $procs.Count)
$deadline = (Get-Date).AddMinutes(180)
while ($true) {
  if (@($procs | Where-Object { -not $_.HasExited }).Count -eq 0) { break }
  if ((Get-Date) -gt $deadline) { $procs | ForEach-Object { try { $_.Kill() } catch {} }; Log 'timeout'; break }
  Start-Sleep -Seconds 15
}

foreach ($k in $expect.Keys) {
  $f = Get-Item $k -ErrorAction SilentlyContinue
  if (-not $f -or $f.Length -ne $expect[$k]) { Log ("bad piece {0}: {1}" -f $k, $(if ($f) { $f.Length } else { 0 })); exit 2 }
}
$total = 0
foreach ($o in $order) { $total += $o.len }
Log ("have {0} / {1} bytes" -f $total, $Size)
if ($total -ne $Size) { Log 'size mismatch'; exit 3 }

Log 'joining'
$fs = [System.IO.File]::Create($Out)
try {
  $buf = New-Object byte[] (8 * 1024 * 1024)
  foreach ($o in $order) {
    if (-not (Test-Path $o.path) -or $o.len -eq 0) { continue }
    $in = [System.IO.File]::OpenRead($o.path)
    try { while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { $fs.Write($buf, 0, $n) } }
    finally { $in.Dispose() }
  }
} finally { $fs.Dispose() }

$final = (Get-Item $Out).Length
Log ("joined {0} bytes" -f $final)
if ($final -ne $Size) { Log 'joined size mismatch'; exit 4 }

if ($Sha256 -ne '') {
  Log 'verifying sha256'
  $h = (Get-FileHash -Path $Out -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $Sha256.ToLower()) { Log ("sha mismatch {0}" -f $h); exit 5 }
  Log 'sha256 ok'
}
foreach ($o in $order) { Remove-Item $o.path -Force -ErrorAction SilentlyContinue }
Log 'OK'
