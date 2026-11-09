# ============================================================================
# dsh-mnemon 0.5.39 —— 离线落位脚本（把插件 + 全部依赖塞进 profile 的 node_modules）
# ----------------------------------------------------------------------------
# 做的事（幂等，可反复跑）：
#   1. 校验包内文件齐不齐（dsh-mnemon 本体 + 18 个子包 + 4 个外部依赖）；
#   2. 把 plugin\dsh-mnemon 和 plugin\node_modules\* 复制进
#      <DSH_HOME>\profiles\<profile>\node_modules\（默认 profile = desktop）；
#      已存在的目录默认「保留不动」，加 -Force 才覆盖；
#   3. 打印 profile package.json 要加的两处，以及重启 / 验收步骤。
#
# 它**不**改 package.json、**不**跑 pnpm、**不**碰 .mnemon 里的任何数据。
# 你的记忆数据（%USERPROFILE%\.mnemon）本脚本一行都不动。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ProfileName web
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DshHome "D:\tools\dsh-home"
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Force    # 覆盖已存在的包目录
#
# 注意：中文必须 UTF-8 带 BOM，否则 PowerShell 5.1 按 GBK 解析会报语法错。
# ============================================================================

[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$ProfileName = 'desktop',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 70) -ForegroundColor DarkCyan
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 70) -ForegroundColor DarkCyan
}
function Write-Ok([string]$Text)   { Write-Host ('  [OK]   ' + $Text) -ForegroundColor Green }
function Write-Keep([string]$Text) { Write-Host ('  [保留] ' + $Text) -ForegroundColor Yellow }
function Write-Info([string]$Text) { Write-Host ('  ' + $Text) }
function Write-Warn([string]$Text) { Write-Host ('  [注意] ' + $Text) -ForegroundColor Yellow }

$PkgRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($PkgRoot)) {
    throw '拿不到脚本所在目录（$PSScriptRoot 为空），请用 -File 方式运行本脚本。'
}
$srcPlugin = Join-Path $PkgRoot 'plugin'

Write-Head 'dsh-mnemon 0.5.39 · 长期记忆插件 离线落位'
Write-Info ('包目录: ' + $PkgRoot)

# --- 1. 校验包内文件 --------------------------------------------------------
$srcMain = Join-Path $srcPlugin 'dsh-mnemon'
$srcDeps = Join-Path $srcPlugin 'node_modules'
$mainManifest = Join-Path $srcMain 'package.json'
$mainEntry = Join-Path $srcMain 'lib\index.js'
$patchFile = Join-Path $srcMain 'cordis.patch.yml'

$missing = @()
foreach ($item in @($srcPlugin, $srcMain, $mainManifest, $mainEntry, $patchFile, $srcDeps)) {
    if (-not (Test-Path -LiteralPath $item)) { $missing += $item }
}
if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host '包不完整，缺这些：' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host ('  - ' + $_) -ForegroundColor Red }
    throw '先把完整包解压出来（plugin\dsh-mnemon 和 plugin\node_modules 都要在），再跑 install.ps1。'
}

$mainJson = [IO.File]::ReadAllText($mainManifest, [Text.Encoding]::UTF8) | ConvertFrom-Json
$depDirs = @(Get-ChildItem -LiteralPath $srcDeps -Directory -Force)
$subCount = @($depDirs | Where-Object { $_.Name -like 'dsh-mnemon-*' }).Count
$extNames = @('zod', 'yaml', 'fflate', 'markdown-to-jsx')
$extMissing = @($extNames | Where-Object { -not (Test-Path -LiteralPath (Join-Path $srcDeps $_)) })

Write-Ok ('包内自检通过：' + $mainJson.name + ' ' + $mainJson.version)
Write-Info ('plugin\node_modules 里共 ' + $depDirs.Count + ' 个目录：' + $subCount + ' 个 dsh-mnemon-* 子包 + ' + ($depDirs.Count - $subCount) + ' 个外部依赖')
if ($subCount -ne 18) { Write-Warn ('预期 18 个 dsh-mnemon-* 子包，实际 ' + $subCount + ' 个，包可能不全。') }
if ($extMissing.Count -gt 0) {
    Write-Warn ('缺外部依赖：' + ($extMissing -join ', ') + '（少了插件会 ERR_MODULE_NOT_FOUND）')
}
if ($mainJson.version -ne '0.5.39') {
    Write-Warn ('这个包不是 0.5.39（实际 ' + $mainJson.version + '），下面的说明按 0.5.39 写的。')
}

# --- 2. 定位 DSH_HOME 和 profile -------------------------------------------
# ⚠ 变量名别叫 $home：$HOME 是只读自动变量（变量名大小写不敏感），赋值会直接报错。
if (-not [string]::IsNullOrWhiteSpace($DshHome)) {
    $dshRoot = $DshHome
} elseif (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    $dshRoot = $env:DSH_HOME
} else {
    $dshRoot = Join-Path $env:USERPROFILE '.dsh'
}
$dshRoot = [IO.Path]::GetFullPath($dshRoot)
$profilesDir = Join-Path $dshRoot 'profiles'
$profileDir = Join-Path $profilesDir $ProfileName
$destNodeModules = Join-Path $profileDir 'node_modules'

Write-Info ('DSH_HOME : ' + $dshRoot)
Write-Info ('profile  : ' + $profileDir)

if (-not (Test-Path -LiteralPath $profileDir)) {
    Write-Host ''
    Write-Warn ('profile 目录不存在：' + $profileDir)
    if (Test-Path -LiteralPath $profilesDir) {
        $avail = @(Get-ChildItem -LiteralPath $profilesDir -Directory -Force | ForEach-Object { $_.Name })
        if ($avail.Count -gt 0) {
            Write-Warn ('现有 profile：' + ($avail -join ', '))
            Write-Warn ('用 -ProfileName 指定正确的那一个，例如：-ProfileName ' + $avail[0])
        } else {
            Write-Warn 'profiles 目录是空的 —— 这台机器可能还没建过 profile，先启动一次 DSH。'
        }
    } else {
        Write-Warn '连 profiles 目录都没有 —— 这台机器大概还没装 DSH，或用 -DshHome 指过去。'
    }
    throw '找不到目标 profile，已停止（什么都没改）。'
}

if (-not (Test-Path -LiteralPath $destNodeModules)) {
    New-Item -ItemType Directory -Path $destNodeModules -Force | Out-Null
    Write-Ok ('新建目录：' + $destNodeModules)
}

# --- 3. 复制本体 + 依赖（默认不覆盖） --------------------------------------
Write-Host ''
Write-Info '开始复制（已存在的默认保留，加 -Force 才覆盖）...'

$copied = 0
$kept = 0

function Install-Pack([string]$Source, [string]$Target) {
    if ((-not $Force) -and (Test-Path -LiteralPath $Target)) {
        Write-Keep ((Split-Path $Target -Leaf) + ' 已存在，保留不动')
        return 'kept'
    }
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force
    Write-Ok ((Split-Path $Target -Leaf) + ' 已落位')
    return 'copied'
}

$r = Install-Pack $srcMain (Join-Path $destNodeModules 'dsh-mnemon')
if ($r -eq 'copied') { $copied++ } else { $kept++ }

foreach ($d in $depDirs) {
    $r = Install-Pack $d.FullName (Join-Path $destNodeModules $d.Name)
    if ($r -eq 'copied') { $copied++ } else { $kept++ }
}

Write-Host ''
Write-Info ('复制完成：新落位 ' + $copied + ' 个目录，保留 ' + $kept + ' 个已存在的目录')

# --- 4. 打印后续步骤 -------------------------------------------------------
Write-Head '下一步 1/3：让 profile 认领这个插件'
Write-Host @'
  打开 <DSH_HOME>\profiles\<profile>\package.json，加两处（缺一不可）：

    "dependencies": {
      "dsh-mnemon": "0.5.39"
    },
    "dsh": {
      "profile": {
        "bundles": [ ...原有条目..., "dsh-mnemon" ]
      }
    }

  说明：
    - 我们已经把包和依赖复制进 node_modules 了，所以**不用再跑 pnpm install**也能加载。
    - 但如果你想让它出现在 pnpm 的依赖图里（以后 pnpm install 不会把它清掉），
      就在 profile 目录里跑一次：pnpm install
    - 别写 "dsh-mnemon": "link:<路径>" —— pnpm 只建软链、不装依赖，插件页会 failed to import。
    - @deepseek-ai/*、react、react-dom 是宿主提供的，**不要**手动装进 profile。
'@

Write-Head '下一步 2/3：重启 DSH'
Write-Info '插件是进程内插件，改完 package.json 必须重启 DSH（不是刷新页面）。'

Write-Head '下一步 3/3：验收'
Write-Host @'
  1) 侧栏出现「记忆系统」。
  2) 记忆系统 → 状态：能看到 Mnemon Native 等组件与 Provider 的状态。
  3) 说一句值得记住的话，回复下方出现回合记忆栏。
  4) 插件页 → 可组合记忆：能看到主策略和各组件页面。

  数据目录（脚本没动、也不会动）：
    %USERPROFILE%\.mnemon\        ← 默认（storageScope=global）
      runtime\  memories.json / MEMORY.md / USER.md / archived\
      documents\ index.json / active\ / archived\
    可用环境变量 MNEMON_DATA_DIR 或设置里的 storageScope 改位置。

  升级/老会话兼容（按需，先备份再动）：
    node "<本包>\plugin\dsh-mnemon\bin\repair-legacy-session.mjs" --help
    node "<本包>\plugin\dsh-mnemon\bin\repair-legacy-session.mjs" --input <会话文件>   # 只预览
'@

Write-Head '完成'
Write-Info ('插件本体: ' + (Join-Path $destNodeModules 'dsh-mnemon'))
Write-Info ('依赖目录: ' + $destNodeModules)
Write-Info '装不上 / 装完没反应，先看本包根目录 NEXT-AI.md（第三节坑清单 + 最后一节 症状→排查）。'
