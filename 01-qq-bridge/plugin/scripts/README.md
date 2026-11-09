# 登录二维码弹窗 / NapCat 守护（可选脚本）

这两个脚本是**插件之外的可选工具**，插件本体不依赖它们。

- `show-qrcode.ps1`：实时刷新 NapCat 登录二维码的窗口，登录成功后自动关闭。
- `watch-napcat.ps1`：每分钟检查一次，DSH 起来了就拉起 NapCat；需要扫码时自动弹出上面的窗口；登录卡死时换一张新码。

## 1. 准备配置

把 `napcat-qr.example.json` 复制成 `napcat-qr.json`，改这几项：

| 字段 | 说明 |
|---|---|
| `napcatHome` | NapCat 安装目录，里面要有 `napcat.bat`（例如 `D:/NapCat`） |
| `dshExe` | DeepSeek Harness 的 exe；不启用 `keepAlive` 时可以留空 |
| `dshProcessName` | DSH 进程名，默认 `DeepSeek Harness` |
| `botUin` | 机器人 QQ 号；NapCat 能快速登录时可以留空 |
| `pluginPort` | QQ 桥接的 WS 端口，默认 3002 |
| `httpPort` | NapCat 的 HTTP 端口，默认 3003；只用于判断“登录成功、自动关窗口” |
| `qrValidSeconds` | 二维码有效期，默认 120 秒 |
| `keepAlive` | `true` = DSH 关了也把它拉起来；`false` = DSH 不在就停掉 NapCat |

## 2. 先手动检查

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\watch-napcat.ps1 -CheckOnly
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\show-qrcode.ps1
```

第一条只打印解析出来的路径和状态，不会动任何进程。第二条会直接打开扫码窗口，确认能显示二维码、能自动换码即可。

> 如果 NapCat 没开 HTTP 服务，窗口不会靠“登录成功”自动关闭，但二维码仍会刷新；手动关掉窗口就行。

## 3. 交给计划任务（可选）

在**管理员 PowerShell**里执行（先 `cd` 到 `scripts` 目录，路径不用改）：

```powershell
$dir = (Get-Location).Path
$ps  = Join-Path $dir 'watch-napcat.ps1'
$cfg = Join-Path $dir 'napcat-qr.json'
$action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ps`" -ConfigFile `"$cfg`""
schtasks /Create /TN "DSH-NapCat-Watchdog" /SC MINUTE /MO 1 /TR $action /F
```

这会每分钟跑一次 `watch-napcat.ps1`。如果机器上已经有同名任务，`/F` 会覆盖它——不想覆盖就换一个任务名。

常用管理：

```powershell
Get-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' | Select TaskName,State
Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'
Enable-ScheduledTask  -TaskName 'DSH-NapCat-Watchdog'
Unregister-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' -Confirm:$false
```

## 4. 注意

- 守护脚本会停掉路径在 `napcatHome` 下的 `node` 进程，`napcatHome` 一定要填对。
- 它不会修改插件配置，也不会往 QQ 发消息。
- 二维码窗口和脚本都只在本机运行，不上传任何东西。
