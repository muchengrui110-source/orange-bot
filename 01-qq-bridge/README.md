# QQ 桥接 + NapCat 分发包 v1.6.2

> **仓库版不带运行时。** 这里只有桥接插件、脚本和文档；`napcat\` 下只留了脱敏的 `config.example\`。NapCat 本体（345MB）在 Releases 的 `1-qq-bridge-napcat-v1.6.2.zip` 里，要直接装就下那个 zip，别从仓库目录跑 `install.ps1`（会报缺 `napcat\node.exe`）。

把 QQ 私聊/群聊接到 DSH Agent：NapCat 替你登录一个小号，消息交给 DSH 处理，回复自动发回 QQ。
带**实时二维码窗口**、**NapCat 看门狗**、**一键启动脚本**，NapCat 本体已打包，不用另外装 QQ。

```
QQ ↔ NapCat ↔ OneBot v11（ws://127.0.0.1:3002）↔ dsh-qq-bridge 插件 ↔ DSH Agent
```

## 里面有什么

```
README.md            本文件
NEXT-AI.md           ★ 给 AI 看的避坑说明书（踩坑先查它，症状→排查表在第六节）
install.ps1          一键落位检查（写 napcat-qr.json、打印后续命令）
plugin\              dsh-qq-bridge 1.6.2（MIT，含二维码窗口 + 看门狗脚本）
napcat\              NapCat 本体（core 4.18.42，自带 node.exe / wrapper.node，无需装 QQ）
  config.example\    脱敏的 OneBot 配置示例（ws 3002 / http 3003 / token 空 / 假号 10001）
scripts\             start-napcat.ps1（无窗口启动）、run-hidden.vbs、napcat.bat
docs\qq-bridge.md    安装与使用说明
docs\napcat-qq-conflict.md  同一个 QQ 号跟桌面 QQ 互踢的完整解法（必读）
stickers\README.txt  表情包库说明（回复带表情包默认开，素材是聊天里自动攒的）
```

**不含**：真实 QQ 号、token、聊天记录、人格正文、日志、数据库、表情包素材、语音合成引擎。
目录约 **345 MB / 729 个文件**。

## 前置条件

- Windows 10/11 x64，PowerShell 5.1（系统自带）。
- 一个**专门给机器人用的小号 QQ**（**不要**和桌面 QQ 登录同一个号，同号双端必互踢）。
- DSH 已装好，并且你能进设置页装插件。
- 磁盘留 ≥ 500 MB（含日志/缓存）；建议放在纯英文短路径，例如 `D:\tools\qq-napcat`。

## ⚠️ 同一个 QQ 号不能两边同时上（必读）

同一个 QQ 号在同一台 Windows 上只能有**一个** QQ NT 在线：桌面 QQ 登了这个号，NapCat 就会被踢；NapCat 登了这个号，桌面 QQ 就弹「账号已在其他设备登录」。**换目录、多开、装两份 NapCat 都没用——同号就是互踢。**

- **推荐**：机器人用**独立小号**（手机 QQ 里切换账号加一次就行，不用新手机），桌面 QQ 用主号，从此不会互踢。
- **必须同号**：只能二选一。用 NapCat 就**托盘退出**桌面 QQ（只点 × 是收进托盘，号还在线）+ 任务管理器→启动 里禁用 QQ 自启；用桌面 QQ 就先 `scripts\start-napcat.ps1 -Stop` 停 NapCat，再 `Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'`——不然看门狗每分钟把它拉起来又踢，看起来像"反复互踢"。
- **手机 QQ 不受影响**：手机端和电脑端是不同设备类型，可以同时在线；但两个 Windows 端不行。
- 被踢后怎么急救、怎么换号（6 步）、怎么看当前谁在线：见 `docs\napcat-qq-conflict.md`，里面还有一张速查表。

就算分了号，NapCat 也放自己的目录（本包默认 `<包>\napcat\`），别和桌面 QQ 共用安装目录或 `Tencent Files`——QQ 运行时会锁文件，撞上可能把 QQ 本体写坏。

## 安装（6 步）

**1. 解压 + 落位检查**

```powershell
cd <包>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

看到 `落位完成。` 就行。它会提示你接下来每一步的确切命令。

**2. 装桥接插件**

```powershell
cd <包>\plugin
npm pack
```

把生成的 `dsh-qq-bridge-1.6.2.tgz` 用 DSH 插件管理器安装（或写进 profile 的 `package.json` 再 `pnpm install`），然后**重启 DSH**。
⚠️ 千万别「从本地文件夹安装」——pnpm 会写成 link 且不装依赖，插件页只会显示 `failed to import`。

**3. 给 NapCat 写 OneBot 配置**

```powershell
cd <包>\napcat\config.example
copy onebot11.example.json ..\napcat\config\onebot11_<你的机器人QQ号>.json
copy napcat.example.json   ..\napcat\config\napcat_<你的机器人QQ号>.json
```

**4. 启动 NapCat**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\scripts\start-napcat.ps1
```

没有窗口是正常的。日志在 `<包>\napcat\napcat-auto.log`。

**5. 扫码登录**

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File <包>\plugin\scripts\show-qrcode.ps1
```

用手机 QQ 扫窗口里的码。二维码 **2 分钟过期**，窗口会自己换码；登录成功后窗口自动关闭。
（别截图发给别人，发过去就失效了。）

**6. 建看门狗（强烈建议）**

```powershell
schtasks /create /tn "DSH-NapCat-Watchdog" /sc minute /mo 1 /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"<包>\plugin\scripts\watch-napcat.ps1\" -ConfigFile \"<包>\plugin\scripts\napcat-qr.json\"" /f
```

它会每分钟检查一次：DSH/NapCat 谁掉了补谁，掉登录就重启换新码并自动弹扫码窗口。
不想用了：`Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'`。

## 第一次验证

1. DSH 设置页有「QQ 桥接」，点「查询 NapCat 账号」能看到机器人号 + 昵称。
2. `curl.exe http://127.0.0.1:3003/get_login_info` 返回 `"retcode":0`。
3. `Get-NetTCPConnection -LocalPort 3002` 同时有 `Listen` 和 `Established`。
4. 用另一个 QQ 给机器人发「你好」，几秒内收到回复。

## 出问题

先看 `NEXT-AI.md` 的**第六节「症状 → 排查对照表」**。最常踩的三个：

| 现象 | 原因 |
|---|---|
| 插件页 `failed to import` | 从文件夹装的，改用 tgz（第 2 步） |
| 桌面 QQ 被顶下线 / 两边轮流掉 / 看门狗一拉就踢 | 机器人和桌面用了同一个号：换小号，或二选一停对方；详见 `docs\napcat-qq-conflict.md` |
| 扫了码提示失效 | 截图了，用 `show-qrcode.ps1` 实时窗口 |
| 扫码后马上又掉、日志有 `KickedOffline` | 被另一头踢了，照 `docs\napcat-qq-conflict.md` 第七节急救 |

## 许可

- dsh-qq-bridge：MIT（见 `plugin\LICENSE`）。
- NapCat：版权归 NapCat 项目（https://github.com/NapNeko/NapCatQQ），按原项目许可证使用。
