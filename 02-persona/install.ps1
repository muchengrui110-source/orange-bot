# ============================================================================
# dsh-persona 1.4.0 —— 一键落位脚本
# ----------------------------------------------------------------------------
# 这个脚本只做三件事（都是幂等的，可以反复跑）：
#   1. 校验包内文件齐不齐；
#   2. 把人设模板放一份到 <DSH_HOME>\qq-bridge\personas.template.json（已存在就保留不动）；
#   3. 打印插件该怎么装、装完从哪儿进设置页。
#
# 它**不会**：装插件、写 personas.json、动你已有的任何人格正文。
# 插件本身要靠 DSH 的插件页按 tgz / 包名装（见脚本最后的输出）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DshHome "D:\tools\dsh-home"
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Force   # 覆盖已存在的模板
#
# 注意：中文必须 UTF-8 带 BOM，否则 PowerShell 5.1 按 GBK 解析会报语法错。
# ============================================================================

[CmdletBinding()]
param(
    [string]$DshHome = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 68) -ForegroundColor DarkCyan
}

function Write-Ok([string]$Text)   { Write-Host ('  [OK]   ' + $Text) -ForegroundColor Green }
function Write-Keep([string]$Text) { Write-Host ('  [保留] ' + $Text) -ForegroundColor Yellow }
function Write-Info([string]$Text) { Write-Host ('  ' + $Text) }
function Write-Warn([string]$Text) { Write-Host ('  [注意] ' + $Text) -ForegroundColor Yellow }

$PkgRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($PkgRoot)) {
    throw '拿不到脚本所在目录（$PSScriptRoot 为空），请用 -File 方式运行本脚本。'
}

Write-Head 'dsh-persona 1.4.0 · 身份与人设插件 落位脚本'
Write-Info ('包目录: ' + $PkgRoot)

# --- 1. 校验包内文件 --------------------------------------------------------
$pluginDir  = Join-Path $PkgRoot 'plugin'
$manifest   = Join-Path $pluginDir 'package.json'
$entry      = Join-Path $pluginDir 'lib\index.js'
$template   = Join-Path $pluginDir 'templates\personas.template.json'
$patchFile  = Join-Path $pluginDir 'cordis.patch.yml'

$missing = @()
foreach ($item in @($pluginDir, $manifest, $entry, $template, $patchFile)) {
    if (-not (Test-Path -LiteralPath $item)) { $missing += $item }
}
if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host '包不完整，缺这些：' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host ('  - ' + $_) -ForegroundColor Red }
    throw '先把完整的包解压出来再跑 install.ps1（别只拷一部分文件）。'
}

$pkgJson = [IO.File]::ReadAllText($manifest, [Text.Encoding]::UTF8) | ConvertFrom-Json
Write-Ok ('包内自检通过：' + $pkgJson.name + ' ' + $pkgJson.version)
if ($pkgJson.version -ne '1.4.0') {
    Write-Warn ('这个包不是 1.4.0（实际 ' + $pkgJson.version + '），下面的路径说明按 1.4.0 写的，注意对不上。')
}

# --- 2. 定位 DSH_HOME ------------------------------------------------------
# 优先级：-DshHome 参数 > 环境变量 DSH_HOME > %USERPROFILE%\.dsh
# ⚠ 变量名千万别叫 $home：PowerShell 变量名大小写不敏感，$HOME 是只读自动变量，
#   一赋值就报 "Cannot overwrite variable HOME because it is read-only or constant"。
if (-not [string]::IsNullOrWhiteSpace($DshHome)) {
    $dshRoot = $DshHome
} elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    $dshRoot = $env:DSH_HOME
} else {
    $dshRoot = Join-Path $env:USERPROFILE '.dsh'
}
$dshRoot = [IO.Path]::GetFullPath($dshRoot)
$qqDir = Join-Path $dshRoot 'qq-bridge'
Write-Info ('DSH_HOME: ' + $dshRoot)

if (-not (Test-Path -LiteralPath $dshRoot)) {
    Write-Warn ('DSH_HOME 目录还不存在：' + $dshRoot)
    Write-Warn '这台机器可能还没装 DSH，或者 DSH_HOME 不在这里；先装 DSH 再用 -DshHome 指过来。'
}

# --- 3. 放人设模板（不覆盖） -----------------------------------------------
Write-Host ''
Write-Info '把人设模板放到 QQ 桥接的数据目录 ...'

if (-not (Test-Path -LiteralPath $qqDir)) {
    New-Item -ItemType Directory -Path $qqDir -Force | Out-Null
    Write-Ok ('新建目录：' + $qqDir)
}

$templateDest = Join-Path $qqDir 'personas.template.json'
if ((Test-Path -LiteralPath $templateDest) -and (-not $Force)) {
    Write-Keep ('已存在，保留不动：' + $templateDest)
} else {
    Copy-Item -LiteralPath $template -Destination $templateDest -Force
    Write-Ok ('已放模板：' + $templateDest)
}

# 已有的正式人格文件绝不动
$personaFile = Join-Path $qqDir 'personas.json'
if (Test-Path -LiteralPath $personaFile) {
    Write-Keep ('已有人格文件，不动它：' + $personaFile)
} else {
    Write-Info ('还没有 personas.json —— 插件第一次读配置时会用上面的模板初始化，不用你手建。')
}

# --- 4. 打印装法 -----------------------------------------------------------
Write-Head '下一步：装插件（脚本不能替你装）'
Write-Host @'
  铁律：别在插件页选「从本地文件夹安装」，也别在 profile 里写 link: 路径。
        pnpm 只会建一个软链、不装依赖，插件页会一直显示 failed to import。
        这个包没有第三方依赖，所以「tgz 安装」和「包名安装」两条路都干净。

  方式 A（推荐，离线可用）：用 npm pack 把 plugin 目录打成 tgz，再交给插件页
      1) cd 到本包的 plugin 目录
         cd "<包目录>\plugin"
      2) npm pack
         期望：当前目录出现 dsh-persona-1.4.0.tgz
      3) 打开 DSH 桌面版 → 插件页 → 添加插件 → 选这个 tgz → 安装 → 启用
      4) 重启 DSH（或插件页里热重载 / 禁用再启用）

  方式 B（联网）：插件页搜索 dsh-persona（1.4.0）直接安装。

  方式 C（手改 profile，装完必须重启）：
      <DSH_HOME>\profiles\<profile>\package.json 里加两处——
        "dependencies":  { "dsh-persona": "1.4.0" }
        "dsh": { "profile": { "bundles": [ ... , "dsh-persona" ] } }
      然后在那个 profile 目录里 pnpm install，再重启 DSH。

  装完从哪儿进：
      左下角账号菜单 → 设置 → 左侧「身份与人设」
      页面里能看到「身份（默认人格）」「QQ 会话人格」「角色库」「规则」四块就对了。
'@

Write-Host @'
  依赖关系（很重要）：
      personas.json 是 QQ 桥接（dsh-qq-bridge）建在 <DSH_HOME>\qq-bridge\ 里的。
      所以顺序上是：先装桥接 → 再装人设页。没装桥接也能装这一页，只是没人用它、
      目录也不一定存在（本脚本会把目录建出来，但也仅此而已）。

  人格文件路径不一样怎么办：
      桥接那边如果改过 personaFile，这里也要指到同一个文件：
        改 plugin\cordis.patch.yml 里 id: dsh-persona 的 config.personaFile，
        或在 profile 的 cordis 配置里按 id 覆盖它，然后重启 DSH。
      两边指不到同一个文件 = 设置页改了半天、QQ 那边一点变化都没有。
'@

Write-Head '完成'
Write-Info ('模板位置: ' + $templateDest)
Write-Info ('人格文件: ' + $personaFile)
Write-Info '出问题先看本包根目录的 NEXT-AI.md（第三节坑清单 G 段）。'
