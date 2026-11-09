# install.ps1 —— QQ 桥接 + NapCat 分发包 · 一键落位（幂等）
#
# 只做四件事，不碰你的 DSH 配置、不装插件、不自动扫码：
#   1) 校验解压位置（文件齐不齐、路径有没有坑）
#   2) 生成 napcat-qr.json（仅在不存在时；指向本包的 napcat\ 目录）
#   3) 可选：在桌面建两个快捷方式（加 -Shortcuts）
#   4) 打印下一步：装插件、写 OneBot 配置、扫码、建计划任务
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Shortcuts
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#
# 安全约定：已存在的 napcat-qr.json 一律「保留不动」，不覆盖。
# 本文件必须保存为 UTF-8 带 BOM，否则 PowerShell 5.1 按 GBK 解析中文会报语法错。

param(
    [switch] $Shortcuts,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

$root      = $PSScriptRoot
$pluginDir = Join-Path $root 'plugin'
$napcatDir = Join-Path $root 'napcat'
$scriptsDir = Join-Path $root 'scripts'

function Say($msg)  { Write-Host $msg }
function Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Warn($msg) { Write-Host $msg -ForegroundColor Yellow }
function Bad($msg)  { Write-Host $msg -ForegroundColor Red }

Say ''
Say '=========================================='
Say '  QQ 桥接 + NapCat 分发包 · 落位检查'
Say '=========================================='
Say ("包目录：{0}" -f $root)
Say ''

# ── 1) 校验解压位置 ─────────────────────────────────────────────
$required = @(
    @{ Path = (Join-Path $root 'NEXT-AI.md');                        Name = 'NEXT-AI.md' },
    @{ Path = (Join-Path $root 'README.md');                         Name = 'README.md' },
    @{ Path = (Join-Path $pluginDir 'lib\index.js');                 Name = 'plugin\lib\index.js' },
    @{ Path = (Join-Path $pluginDir 'package.json');                 Name = 'plugin\package.json' },
    @{ Path = (Join-Path $pluginDir 'scripts\watch-napcat.ps1');     Name = 'plugin\scripts\watch-napcat.ps1' },
    @{ Path = (Join-Path $pluginDir 'scripts\show-qrcode.ps1');      Name = 'plugin\scripts\show-qrcode.ps1' },
    @{ Path = (Join-Path $napcatDir 'node.exe');                     Name = 'napcat\node.exe' },
    @{ Path = (Join-Path $napcatDir 'index.js');                     Name = 'napcat\index.js' },
    @{ Path = (Join-Path $napcatDir 'napcat.bat');                   Name = 'napcat\napcat.bat' },
    @{ Path = (Join-Path $napcatDir 'napcat\napcat.mjs');            Name = 'napcat\napcat\napcat.mjs' },
    @{ Path = (Join-Path $scriptsDir 'start-napcat.ps1');            Name = 'scripts\start-napcat.ps1' }
)

$missing = @()
foreach ($item in $required) {
    if (-not (Test-Path $item.Path)) { $missing += $item.Name }
}

if ($missing.Count -gt 0) {
    Bad '解压不完整，缺这些文件：'
    foreach ($m in $missing) { Bad ("  - {0}" -f $m) }
    Say ''
    Warn '多半是在压缩包里直接双击运行，或者只解压了一部分。'
    Warn '请把 zip 完整解压到一个本地目录（不要在 zip 预览窗口里跑），再执行 install.ps1。'
    exit 1
}
Ok '文件齐全：插件、NapCat 本体、二维码/守护脚本都在。'

# 路径坑：中文、空格、OneDrive 同步、超长
if ($root -match '[\u4e00-\u9fa5]') {
    Warn ("注意：包路径含中文（{0}）。脚本本身支持，但如果 NapCat 起不来，" -f $root)
    Warn '      先把它挪到纯英文路径（例如 D:\tools\qq-napcat）再试一次。'
}
if ($root -match 'OneDrive') {
    Warn '注意：包放在 OneDrive 同步目录下，NapCat 运行中会一直改日志/缓存，容易同步冲突。建议挪出来。'
}
if ($root.Length -gt 120) {
    Warn '注意：包路径过长，Windows 可能有 260 字符限制。建议挪到更短的路径。'
}
Say ''

# ── 2) 生成 napcat-qr.json（不存在才写）─────────────────────────
$qrTargets = @(
    (Join-Path $pluginDir 'scripts\napcat-qr.json'),
    (Join-Path $scriptsDir 'napcat-qr.json')
)

$qrObject = [ordered]@{
    napcatHome    = $napcatDir
    dshExe        = ''
    dshProcessName = 'DeepSeek Harness'
    botUin        = ''
    pluginPort    = 3002
    httpPort      = 3003
    qrValidSeconds = 120
    keepAlive     = $false
}
$qrJson = $qrObject | ConvertTo-Json -Depth 4

foreach ($target in $qrTargets) {
    if (Test-Path $target) {
        Say ("保留不动：{0}" -f $target)
        continue
    }
    if ($DryRun) {
        Say ("[DryRun] 会写：{0}" -f $target)
        continue
    }
    $dir = Split-Path -Parent $target
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($target, $qrJson, (New-Object Text.UTF8Encoding($false)))
    Ok ("已写配置：{0}" -f $target)
}
Say ''

# ── 3) 可选：桌面快捷方式 ───────────────────────────────────────
if ($Shortcuts) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $ws = New-Object -ComObject WScript.Shell
    $links = @(
        @{ Name = 'QQ桥接 · 启动 NapCat.lnk';
           Target = 'powershell.exe';
           Args = ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $scriptsDir 'start-napcat.ps1'));
           Desc = '无窗口拉起 NapCat（幂等）' },
        @{ Name = 'QQ桥接 · 扫码登录.lnk';
           Target = 'powershell.exe';
           Args = ('-NoProfile -STA -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $pluginDir 'scripts\show-qrcode.ps1'));
           Desc = '实时刷新 NapCat 登录二维码' }
    )
    foreach ($l in $links) {
        $lnkPath = Join-Path $desktop $l.Name
        if (Test-Path $lnkPath) { Say ("保留不动：{0}" -f $lnkPath); continue }
        if ($DryRun) { Say ("[DryRun] 会建快捷方式：{0}" -f $lnkPath); continue }
        $sc = $ws.CreateShortcut($lnkPath)
        $sc.TargetPath = $l.Target
        $sc.Arguments = $l.Args
        $sc.WorkingDirectory = $root
        $sc.Description = $l.Desc
        $sc.Save()
        Ok ("已建快捷方式：{0}" -f $lnkPath)
    }
    Say ''
}

# ── 4) 打印下一步 ───────────────────────────────────────────────
$np = Join-Path $napcatDir 'napcat'
$cfgDir = Join-Path $np 'config'
$pluginScripts = Join-Path $pluginDir 'scripts'

Say '---------------- 下一步 1：装桥接插件（铁律：别「从文件夹安装」）----------------'
Say '  从文件夹装会被 pnpm 记成 link: 且不装依赖，插件页只会显示 failed to import。'
Say ('  正确做法：cd "{0}"' -f $pluginDir)
Say '             npm pack        （PATH 里没有 npm 时，用 DSH 自带的 node 目录里的 npm.cmd）'
Say '             把生成的 dsh-qq-bridge-1.6.2.tgz 交给 DSH 插件管理器安装，或写进 profile 的 package.json 再 pnpm install。'
Say '  装完重启 DSH，设置页会出现「QQ 桥接」。'
Say ''

Say '---------------- 下一步 2：给 NapCat 写 OneBot 配置 ----------------'
Say ('  配置目录：{0}' -f $cfgDir)
Say '  （第一次启动 NapCat 会自动建这个目录；下面的命令把示例改名复制进去，<QQ号> 换成机器人号码）'
Say ('    cd "{0}"' -f (Join-Path $napcatDir 'config.example'))
Say '    copy onebot11.example.json ..\napcat\config\onebot11_<QQ号>.json'
Say '    copy napcat.example.json   ..\napcat\config\napcat_<QQ号>.json'
Say '  示例已经配好：反向 WS 指向 ws://127.0.0.1:3002/（桥接是服务端），另开 HTTP 3003 便于排错，token 为空。'
Say '  不想手改也可以：启动后打开 WebUI http://127.0.0.1:6099/webui ，token 在 napcat-auto.log 里（搜 "WebUi Token"）。'
Say '  WebUI 端口被占时会自动往上找空口，以日志打印的 User Panel Url 为准。'
Say ''

Say '---------------- 下一步 3：启动 NapCat 并扫码 ----------------'
Say ('  powershell -NoProfile -ExecutionPolicy Bypass -File "{0}" -CheckOnly' -f (Join-Path $scriptsDir 'start-napcat.ps1'))
Say ('  powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $scriptsDir 'start-napcat.ps1'))
Say ('  powershell -NoProfile -STA -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $pluginScripts 'show-qrcode.ps1'))
Say '  二维码 2 分钟过期，用上面这个实时窗口看，别截图给人。'
Say ''

Say '---------------- 下一步 4：建看门狗计划任务（每分钟，可选但强烈建议）----------------'
$watchPs  = Join-Path $pluginScripts 'watch-napcat.ps1'
$watchCfg = Join-Path $pluginScripts 'napcat-qr.json'
Say ('  schtasks /create /tn "DSH-NapCat-Watchdog" /sc minute /mo 1 /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{0}\" -ConfigFile \"{1}\"" /f' -f $watchPs, $watchCfg)
Say '  停用/卸载：'
Say '    Disable-ScheduledTask -TaskName "DSH-NapCat-Watchdog"'
Say '    Unregister-ScheduledTask -TaskName "DSH-NapCat-Watchdog" -Confirm:$false'
Say ''

Say '---------------- 配置提示 ----------------'
Say ('  napcat-qr.json 已指向：{0}' -f $qrTargets[0])
Say '  botUin 留空 = 每次扫码登录；想快速登录就填纯数字 QQ 号（带其它字符会被忽略）。'
Say '  keepAlive=false = DSH 不在就停掉 NapCat 省资源；true = 连 DSH 一起拉起来（需要 dshExe 填对）。'
Say ''
Ok '落位完成。详细避坑看 NEXT-AI.md，出问题先看它的「症状 → 排查」表。'
exit 0
