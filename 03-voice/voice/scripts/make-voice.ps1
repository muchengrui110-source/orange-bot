# 文字转语音（多音色版）：优先用 edge-tts（微软神经网络语音，音色丰富且自然），
# 断网时自动回退到 Windows 本地语音。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-voice.ps1 -Text "要说的话" -Out reply.mp3
#   powershell ... -File make-voice.ps1 -Text "你好" -Out out.mp3 -Voice 云希 -Rate 10 -Pitch 20
#   powershell ... -File make-voice.ps1 -Text "你好" -Out out.mp3 -Voice random      # 随机音色
#   powershell ... -File make-voice.ps1 -ListVoices                                  # 列出所有中文音色
param(
  [string]$Text = '',
  [string]$Out = '',
  [string]$Voice = '晓晓',   # 音色别名或完整名称；random = 随机中文音色
  [int]$Rate = 0,            # 语速 -50..50（对应 -50%..+50%）
  [int]$Volume = 100,        # 音量 0..100
  [int]$Pitch = 0,           # 音调 -50..50（对应 -50Hz..+50Hz）
  [ValidateSet('auto','breeze','edge','local')]
  [string]$Engine = 'auto',  # auto=先本地 Breeze 失败退回 edge；breeze=只用本地；edge/local=老路子
  [string]$Model = 'q4',     # 本地引擎用哪档模型：q4（省显存，默认）/ q8（音质好，慢一点）
  [string]$Instruction = '', # 给本地引擎的声音描述（不给就用 breeze-tts.json 里的）
  [double]$Cfg = -1,         # 本地引擎的引导强度，1.0 最快，2~3 才会出笑声叹气
  [string]$VoiceId = '',     # 本地引擎用存好的音色名（要先存音色）
  [string]$Persona = '',     # 当前性格模式名，按人设自动定声音
  [switch]$ListVoices,
  [switch]$Local             # 强制使用本地 Windows 语音
)

$ErrorActionPreference = 'Stop'

# ── 找一个"装了 edge-tts"的 Python ──────────────────────────────
# 注意：DSH 有不止一套内置 Python（应用自带的在 resources\runtime 下，
# 用户级运行时的在 .dsh\dsh-runtimes 下），装的东西不一定一样。
# 写死路径会在应用升级后失效，然后静默退回 SAPI 机械音，所以这里逐个探测。
function Find-EdgePython {
  $candidates = New-Object System.Collections.ArrayList
    $runtimeRoot = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $runtimeRoot) {
    Get-ChildItem $runtimeRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      [void]$candidates.Add((Join-Path $_.FullName 'dependencies\python\python.exe'))
    }
  }
  if ($env:DSH_VOICE_PYTHON) { [void]$candidates.Insert(0, $env:DSH_VOICE_PYTHON) }
  foreach ($c in $candidates) {
    if (-not (Test-Path $c)) { continue }
    try {
      $ok = & $c -c "import edge_tts;print('ok')" 2>$null
      if ($LASTEXITCODE -eq 0 -and "$ok" -match 'ok') { return $c }
    } catch { }
  }
  return $null
}

$python = Find-EdgePython
if (-not $python) {
  # 一个都没有：退回任一个能用的内置 Python（下面会走 SAPI 本地语音）
  foreach ($c in @(
      (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'))) {
    if (Test-Path $c) { $python = $c; break }
  }
}

# ── 音色别名表（别名 → edge-tts 音色名）─────────────────────────
$VOICE_MAP = @{
  '晓晓' = 'zh-CN-XiaoxiaoNeural'; 'xiaoxiao' = 'zh-CN-XiaoxiaoNeural'
  '晓伊' = 'zh-CN-XiaoyiNeural';   'xiaoyi'   = 'zh-CN-XiaoyiNeural'
  '云希' = 'zh-CN-YunxiNeural';    'yunxi'    = 'zh-CN-YunxiNeural'
  '云健' = 'zh-CN-YunjianNeural';  'yunjian'  = 'zh-CN-YunjianNeural'
  '云扬' = 'zh-CN-YunyangNeural';  'yunyang'  = 'zh-CN-YunyangNeural'
  '云夏' = 'zh-CN-YunxiaNeural';   'yunxia'   = 'zh-CN-YunxiaNeural'
  '晓北' = 'zh-CN-liaoning-XiaobeiNeural'; '东北话' = 'zh-CN-liaoning-XiaobeiNeural'; 'xiaobei' = 'zh-CN-liaoning-XiaobeiNeural'
  '晓妮' = 'zh-CN-shaanxi-XiaoniNeural';   '陕西话' = 'zh-CN-shaanxi-XiaoniNeural';   'xiaoni'  = 'zh-CN-shaanxi-XiaoniNeural'
  '晓曼' = 'zh-HK-HiuMaanNeural';  '粤语'    = 'zh-HK-HiuMaanNeural'; 'hiumaan' = 'zh-HK-HiuMaanNeural'
  '云龙' = 'zh-HK-WanLungNeural';  'wanlung' = 'zh-HK-WanLungNeural'
  '晓臻' = 'zh-TW-HsiaoChenNeural'; '台湾'   = 'zh-TW-HsiaoChenNeural'; 'hsiaochen' = 'zh-TW-HsiaoChenNeural'
}

$CN_VOICES = @(
  'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural',
  'zh-CN-YunjianNeural', 'zh-CN-YunyangNeural', 'zh-CN-YunxiaNeural',
  'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'zh-HK-HiuMaanNeural', 'zh-HK-WanLungNeural',
  'zh-TW-HsiaoChenNeural', 'zh-TW-YunJheNeural'
)

function Resolve-Voice([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { return 'zh-CN-XiaoxiaoNeural' }
  $key = $name.Trim().ToLower()
  if ($key -eq 'random' -or $key -eq '随机') { return ($CN_VOICES | Get-Random) }
  if ($VOICE_MAP.ContainsKey($name.Trim())) { return $VOICE_MAP[$name.Trim()] }
  if ($VOICE_MAP.ContainsKey($key)) { return $VOICE_MAP[$key] }
  return $name.Trim()   # 直接当作完整音色名
}

# ── 仅列出音色 ──────────────────────────────────────────────────
if ($ListVoices) {
  if (Test-Path $python) {
    & $python -m edge_tts --list-voices 2>&1 | Select-String -Pattern 'zh-CN|zh-HK|zh-TW'
  } else {
    Write-Output '（未找到内置 Python，无法列出 edge-tts 音色）'
  }
  exit 0
}

if (-not $Text -or -not $Out) { Write-Error '需要 -Text 和 -Out 参数'; exit 1 }

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$resolvedVoice = Resolve-Voice $Voice
if ($Engine -eq 'local') { $Local = $true }

# ── 先试本地 Breeze（按需拉起；失败就往下走 edge-tts）──────────
# 方言音色它做不了，auto 模式下这种直接跳过本地。
$usedBreeze = $false
$breezeOut = ''
$dialects = @('晓北','东北话','晓妮','陕西话','晓曼','粤语','云龙','晓臻','台湾',
              'xiaobei','xiaoni','hiumaan','wanlung','hsiaochen')
$wantBreeze = ($Engine -eq 'breeze') -or
              ($Engine -eq 'auto' -and -not ($dialects -contains $Voice.Trim()))
$launcher = Join-Path $PSScriptRoot 'breeze-tts.ps1'
if ($wantBreeze -and (Test-Path $launcher)) {
  # 文本走临时文件传，避免命令行编码把中文弄坏
  $breezeTxt = [System.IO.Path]::ChangeExtension($Out, '.breeze.txt')
  [System.IO.File]::WriteAllText($breezeTxt, $Text, (New-Object System.Text.UTF8Encoding($false)))
  $bv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher,
          '-TextFile', $breezeTxt, '-Out', $Out, '-Model', $Model)
  if ($Instruction) { $bv += @('-Instruction', $Instruction) }
  if ($Cfg -ge 0) { $bv += @('-Cfg', ('{0}' -f $Cfg)) }
  if ($VoiceId) { $bv += @('-Voice', $VoiceId) }
  if ($Persona) { $bv += @('-Persona', $Persona) }
  Remove-Item $Out -Force -ErrorAction SilentlyContinue
  try {
    $breezeOut = (& powershell.exe @bv 2>&1 | Out-String).Trim()
    if ($breezeOut -match '^OK ' -and (Test-Path $Out) -and (Get-Item $Out).Length -ge 2048) {
      $usedBreeze = $true
    }
  } catch { $breezeOut = $_.Exception.Message }
  Remove-Item $breezeTxt -Force -ErrorAction SilentlyContinue
  if (-not $usedBreeze -and $Engine -eq 'breeze') {
    Write-Error ('本地 Breeze 失败：' + $breezeOut)
    exit 1
  }
}
if ($usedBreeze) {
  Write-Output $breezeOut
  exit 0
}

# ── 首选：edge-tts ──────────────────────────────────────────────
$usedEdge = $false
if (-not $Local -and (Test-Path $python)) {
  $tmpTxt = [System.IO.Path]::ChangeExtension($Out, '.tmp.txt')
  # 用 UTF-8 无 BOM 写文本文件，避免命令行中文编码问题
  [System.IO.File]::WriteAllText($tmpTxt, $Text, (New-Object System.Text.UTF8Encoding($false)))
  $rateStr = if ($Rate -ge 0) { "+$Rate%" } else { "$Rate%" }
  $volStr = if ($Volume -ge 0) { "+$Volume%" } else { "$Volume%" }
  $pitchStr = if ($Pitch -ge 0) { "+${Pitch}Hz" } else { "${Pitch}Hz" }
  # 最多尝试 3 次：edge-tts 偶发返回空/极短音频
  for ($attempt = 1; $attempt -le 3 -and -not $usedEdge; $attempt++) {
    try {
      Remove-Item $Out -Force -ErrorAction SilentlyContinue
      $null = & $python -m edge_tts --file $tmpTxt --voice $resolvedVoice `
        --rate=$rateStr --volume=$volStr --pitch=$pitchStr --write-media $Out 2>&1
      if ($LASTEXITCODE -eq 0 -and (Test-Path $Out)) {
        if ((Get-Item $Out).Length -ge 2048) { $usedEdge = $true }
        else { Start-Sleep -Milliseconds 400 }
      }
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  Remove-Item $tmpTxt -Force -ErrorAction SilentlyContinue
}

if ($usedEdge) {
  Write-Output "OK $Out (engine=edge-tts voice=$resolvedVoice)"
  exit 0
}

# ── 回退：Windows 本地语音 ──────────────────────────────────────
Add-Type -AssemblyName System.Speech
$wav = [System.IO.Path]::ChangeExtension($Out, '.tmp.wav')
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int]($Rate / 5)))
  $synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
  $zhVoice = $synth.GetInstalledVoices() | Where-Object {
    $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh*'
  } | Select-Object -First 1
  if ($zhVoice) { $synth.SelectVoice($zhVoice.VoiceInfo.Name) }
  $synth.SetOutputToWaveFile($wav)
  $synth.Speak($Text)
} finally {
  $synth.Dispose()
}

# 便携写法：ffmpeg 从 PATH 里找；要指定路径就把它写进包根 voice-paths.json 的 ffmpegExe
$ffmpeg = 'ffmpeg'
& $ffmpeg -hide_banner -loglevel error -y -i $wav -ac 1 -ar 24000 -b:a 64k $Out
$code = $LASTEXITCODE
Remove-Item $wav -Force -ErrorAction SilentlyContinue

if ($code -ne 0 -or -not (Test-Path $Out)) { Write-Error "语音生成失败（ffmpeg 退出码 $code）"; exit 1 }
Write-Output "OK $Out (engine=windows-local)"
exit 0
