# 给下一个 AI 的交接说明 —— QQ 桥接 + NapCat

**一句话**：这套东西让 QQ 里的私聊/群聊变成 DSH Agent 的输入输出——NapCat 冒充一个 PC 端 QQ 登录，用 OneBot v11 把消息推给 `dsh-qq-bridge` 插件，插件把消息喂给 DSH Agent，再把 Agent 的回复发回 QQ。

```
手机/电脑上的 QQ（你用来聊天的那个号）
        ↑ ↓  QQ 协议
NapCat 本体（<包>\napcat\，node.exe 跑 index.js，无窗口，独立数据目录）
        ↑ ↓  OneBot v11 反向 WebSocket（NapCat 是客户端）
ws://127.0.0.1:3002   （dsh-qq-bridge 插件是服务端，mode=server）
        ↑ ↓
dsh-qq-bridge 1.6.2（DSH 插件，私人数据在 <DSH_HOME>\qq-bridge\）
        ↑ ↓  会话
DSH Agent（每个 QQ 聊天 = 一个 DSH 会话 + 一个工作区）

旁路：NapCat HTTP 127.0.0.1:3003（get_login_info，判断"登录成功没"，不参与聊天）
     NapCat WebUI 127.0.0.1:6099（临时改 OneBot 配置用，token 在日志里）
     show-qrcode.ps1（盯 cache\qrcode.png 的实时二维码窗口）
     watch-napcat.ps1（每分钟一次的看门狗，DSH/NapCat 谁掉了补谁）
```

本包版本：桥接 **1.6.2**，NapCat core **4.18.42**（QQ shell 9.9.31-49738，自带 wrapper.node，**不需要另外装 QQ**）。
本包目录 **345.3 MB / 729 个文件**（其中 `napcat\` 345.0 MB / 706 个文件），zip 后另算（见 PACK-INFO.txt）。

> **2026-11-04 更新**：NapCat core 从 4.18.37 升到 **4.18.42**（官方 `NapCat.Shell.Windows.Node.zip` v4.18.42 整包替换）。结构、启动方式、配置、扫码流程完全不变；`napcat\napcat\napcat.mjs` 从 3.12MB 变成 3.34MB，`native\`/`node_modules\` 一起换新。升级不影响 `napcat-qr.json`、`personas.json`、桥接配置；旧包升级就把 `napcat\` 整个换掉，`config.example\` 可保留。

---

## 一、安装顺序（别跳步，每步都有期望结果）

> 下面用 `<包>` 指解压后的包根目录，例如 `D:\tools\qq-napcat`（**别放中文路径/OneDrive/桌面同步目录**，见 A9）。

**1. 解压 + 落位检查**

```powershell
cd <包>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

期望看到：`文件齐全：插件、NapCat 本体、二维码/守护脚本都在。` → `落位完成。`
它会：校验文件齐不齐、写 `plugin\scripts\napcat-qr.json`（不存在时，`napcatHome` 指向 `<包>\napcat`）、打印后面几步的命令。已有 `napcat-qr.json` 保留不动。

**2. 装桥接插件（不是复制文件！）**

```powershell
cd <包>\plugin
npm pack           # PATH 里没 npm 时用 DSH 自带 node 目录下的 npm.cmd
```

得到 `dsh-qq-bridge-1.6.2.tgz` → 交给 DSH 插件管理器按 tgz 安装（或写进 profile 的 `package.json` 再 `pnpm install`）。
期望：重启 DSH 后，**设置页出现「QQ 桥接」**；插件页里 `dsh-qq-bridge` 状态是已启用，不是 `failed to import`。

**3. 给 NapCat 写 OneBot 配置**

```powershell
cd <包>\napcat\config.example
copy onebot11.example.json ..\napcat\config\onebot11_<QQ号>.json
copy napcat.example.json   ..\napcat\config\napcat_<QQ号>.json
```

`<QQ号>` = 你要让机器人登录的那个 QQ 号（纯数字）。**必须和桌面 QQ 用的号不同**——同号双端必互踢，这是本包最高频的坑，完整解法见 `docs\napcat-qq-conflict.md`。示例已经配好：反向 WS `ws://127.0.0.1:3002/`、HTTP `127.0.0.1:3003`、token 空、`messagePostFormat: array`。
期望：`<包>\napcat\napcat\config\` 下出现两个带号的文件（第一次启动前目录不存在是正常的，可以自己建）。

**4. 启动 NapCat**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\scripts\start-napcat.ps1 -CheckOnly   # 先核对路径
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\scripts\start-napcat.ps1
Get-Content <包>\napcat\napcat-auto.log -Tail 30
```

期望日志（实测顺序）：
```
NapCat Shell App Loading...
10-xx xx:xx:xx [info] [NapCat] [Core] NapCat.Core Version: 4.18.42
10-xx xx:xx:xx [info] [NapCat] [WebUi] WebUi Token: <12位十六进制>
10-xx xx:xx:xx [info] [NapCat] [WebUi] WebUi User Panel Url: http://127.0.0.1:6099/webui?token=<同一个token>
10-xx xx:xx:xx [info] 等待网络连接... / 网络已连接
10-xx xx:xx:xx [info] 没有 -q 指令指定快速登录，将使用二维码登录方式
10-xx xx:xx:xx [warn] 请扫描下面的二维码，然后在手Q上授权登录：
10-xx xx:xx:xx [warn] 二维码已保存到 <包>\napcat\napcat\cache\qrcode.png
```
> 想让日志用浏览器/控制台看着舒服，也可以直接 `cd <包>\napcat; .\napcat.bat` 前台跑（控制台里二维码是 ASCII 画的，能直接扫）。

**5. 扫码登录（二维码 2 分钟过期）**

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File <包>\plugin\scripts\show-qrcode.ps1
```

期望：弹出「QQ 机器人登录」窗口，二维码标题写着「手机 QQ → 右上角 + → 扫一扫」，下面有倒计时；NapCat 换码时窗口跟着换；登录成功后窗口自己关掉（它每 5 秒问一次 `http://127.0.0.1:3003/get_login_info`，拿到 `user_id` 才算成功）。
**不要截图发给别人**，发过去就失效了。

**6. 确认桥接连上了**

```powershell
Get-NetTCPConnection -LocalPort 3002 -State Listen,Established | Select LocalPort,State
curl.exe -s http://127.0.0.1:3003/get_login_info
```

期望：3002 有 `Listen`（插件）和 `Established`（NapCat 连上来了）；`get_login_info` 返回 `"retcode":0` 且 `data.user_id` 是你的机器人号。
然后在设置 → QQ 桥接里点「查询 NapCat 账号」，应显示号 + 昵称。给机器人发「你好」，应收到回复。

**7. 建看门狗（强烈建议）**

```powershell
schtasks /create /tn "DSH-NapCat-Watchdog" /sc minute /mo 1 /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"<包>\plugin\scripts\watch-napcat.ps1\" -ConfigFile \"<包>\plugin\scripts\napcat-qr.json\"" /f
```

提示「拒绝访问」就用管理员 PowerShell 再跑一次。
期望：`Get-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' | Select TaskName,State` 显示 `Ready`；
DSH 在跑、NapCat 被杀掉 → 一分钟内自动重新拉起并弹二维码窗口。
停用/卸载：

```powershell
Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'
Unregister-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' -Confirm:$false
```

**8. 重启 DSH 让配置生效，然后跑第五节自检清单。**

---

## 二、三条铁律（违反会浪费你半天）

### 铁律 1：插件永远不要「从本地文件夹安装」

- **现象**：插件页只有一行英文 `failed to import`，或者设置里根本没有「QQ 桥接」；DSH 日志里 `ERR_MODULE_NOT_FOUND: Cannot find package 'ws'`。
- **原因**：pnpm 遇到本地目录会写成 `link:`，**不装依赖**。这个插件依赖 `ws`（OneBot WebSocket 库），bare import 直接找不到。
- **正确做法**：`cd <包>\plugin; npm pack` 生成 tgz → 按 tgz 装；或把 `"dsh-qq-bridge": "file:<tgz绝对路径>"` 写进 profile 的 `package.json` 后 `pnpm install` 再重启 DSH。**永远不要**把 `plugin\` 目录路径直接塞给插件管理器。

### 铁律 2：带中文的 `.ps1` 必须 UTF-8 **带 BOM**，且绝不能用 Get-Content/Set-Content 回写

- **现象**：`powershell -File xxx.ps1` 报「缺少右括号/字符串未终止」，报错行号还乱飘；或者整份文件里的中文变成一堆问号/乱码。
- **原因**：PowerShell 5.1 用 `-File` 启动时按 **ANSI(GBK)** 解析无 BOM 文件，中文注释会把语法吃坏。反过来，PS 5.1 的 `Get-Content`/`Set-Content` 默认按 GBK 读写，把 UTF-8 源码读进来再写出去 = 不可逆乱码（真实事故：一份 170KB 的插件源码就是这么毁的）。
- **正确做法**：改文本只用 `read`/`edit`/`write` 这类工具（或用 Node/Python 显式 UTF-8）。写完立刻验：

```powershell
$p = '<改过的 .ps1>'
$e = $null; [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$e); "syntax errors: $($e.Count)"   # 期望 0
$b = [IO.File]::ReadAllBytes($p); "bom: $($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)"                            # 期望 True
# 补 BOM：
$b=[IO.File]::ReadAllBytes($p); if(!($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)){ [IO.File]::WriteAllBytes($p, [byte[]](,@(0xEF,0xBB,0xBF) + $b)) }
```

纯 ASCII 脚本不需要 BOM；**加了一个中文字符就必须补**。`edit`/`write` 工具会掉 BOM，改完要重新补。

### 铁律 3：拉「常驻后台进程」别用 `Start-Process -RedirectStandardOutput`

- **现象**：命令永远不返回；node 的 `exec` 卡死；PowerShell `| Out-String` 挂住；计划任务看着"在运行"其实卡在那。
- **原因**：子进程继承父进程所有可继承句柄，那个 stdout 管道一直被吊着。
- **正确做法**：用 WScript.Shell 隐藏启动 + cmd 重定向（`scripts\start-napcat.ps1` 和 `plugin\scripts\watch-napcat.ps1` 都是这么写的，别改回 Start-Process）：

```powershell
$ws = New-Object -ComObject WScript.Shell
$null = $ws.Run('cmd.exe /c ""' + $bat + '" > "' + $log + '" 2> "' + $err + '""', 0, $false)   # 0 = 无窗口
```

---

## 三、坑清单（现象 → 原因 → 怎么办）

### A. NapCat 本体 / 网络

- **A1 启动即退，日志只有一行 `NapCat Shell App Loading...` 就没了。**
  → 缺文件或杀软删了。原因：shell 模式要 `node.exe` + `index.js` + `wrapper.node` + 同目录那一堆 `.dll`（`QQNT.dll`、`LightQuic.dll`、`libvips-42.dll`、`ncnn.dll`、`opencv.dll`、`ssl.dll`、`crypto.dll`、`QBar.dll`、`broadcast_ipc.dll`、`avif_convert.dll`、`libglib-2.0-0.dll`、`libgobject-2.0-0.dll`）+ `win64\parent-ipc-core-x64.dll` + `win64\SSOShareInfoHelper64.dll` + `napcat\` 整个子目录。
  → 对一下文件数：`napcat\` 应当约 **344.6 MB / 707 个文件**（整包 729 个）。少文件就重新解压；杀软隔离的从隔离区恢复，并把 `<包>` 整个目录加进白名单（见 A8）。

- **A2 换端口以后插件连不上。**
  → 两个地方必须同时改，缺一个就静默连不上：
  1. NapCat：`<包>\napcat\napcat\config\onebot11_<QQ号>.json` 里 `network.websocketClients[0].url` = `ws://127.0.0.1:3002/`
  2. 插件：设置 → QQ 桥接 → 传输方式 `mode=server`、`host=127.0.0.1`、`port=3002`（写进 `<DSH_HOME>\qq-bridge\settings-ui.json`）
  → 改完两边都要重启（NapCat 重启用 `start-napcat.ps1 -Stop` 再启动；插件改完**要重启 DSH**，见 C2）。

- **A3 端口被占：NapCat 起来但 3002 上连不上，或插件报 EADDRINUSE。**
  → 查谁占着：`Get-NetTCPConnection -LocalPort 3002,3003,6099 -ErrorAction SilentlyContinue | Select LocalPort,State,OwningProcess` + `Get-Process -Id <pid>`。
  → 3002 只能有一个服务端：如果之前装过旧版桥接/别的 OneBot 框架（LLOneBot、Lagrange、旧版 NapCat）也在抢，先全停。
  → 3003 是 NapCat 的 HTTP 口，被别的程序占了 NapCat 会在日志里报 `listen EADDRINUSE`，改 `onebot11_<QQ号>.json` 的 `httpServers[0].port` 并同步改 `napcat-qr.json` 的 `httpPort`（只影响"扫码成功自动关窗口"）。
  → 6099 是 WebUI。**被占用时 NapCat 会自己往上找空口**（实测 6099 被别的实例占着，日志打印 `http://127.0.0.1:6100/webui?token=...`），所以以日志里的 URL 为准，别死记 6099；想固定端口改 `napcat\napcat\config\webui.json` 的 `port`。

- **A4 token 填了但连不上。**
  → NapCat 的 `token`（在 websocketClients 里）和插件设置页的 access token **必须逐字符相同**，大小写也算。插件把 token 存成 `settings-ui.json` 里的 `accessToken`，页面上只回显「已设置，不回显」，看不到明文；要核对就直接看那个文件。
  → 内部网段/别人机器能连到 NapCat 才需要 token；本机 127.0.0.1 之间用空 token 最简单，也最不容易错。

- **A5 防火墙 / 局域网。**
  → 本包默认全程 `127.0.0.1`，**不需要任何入站规则**。只有把插件 `host` 改成 `0.0.0.0` 让别的机器连进来时才要放行 3002；此时**必须设 token**，否则本机任何人都能让机器人替他说话。
  → Windows 第一次运行 node.exe 可能弹「是否允许网络访问」，选「专用网络」即可，拒绝也不影响本机回环。

- **A6 日志在哪。**
  | 日志 | 路径 | 看什么 |
  |---|---|---|
  | NapCat 控制台 | `<包>\napcat\napcat-auto.log` | 启动、二维码、登录、收发消息、OneBot 连接 |
  | NapCat 错误 | `<包>\napcat\napcat-auto.err.log` | node 崩溃堆栈（一般在几百字节内） |
  | NapCat 文件日志 | `<包>\napcat\napcat\logs\` | 只有 `napcat_<QQ号>.json` 里 `fileLog=true` 才有 |
  | 看门狗 | `<包>\napcat\watchdog.log` | 每次重启/拉起的时间戳 |
  | 桥接调试 | `<DSH_HOME>\qq-bridge\qq-bridge-debug.log` | 插件侧收发、会话、错误 |
  → 日志里的 `[info] <昵称> | 接收 <- 私聊 (号码) 内容` 就是桥接在转发；**只有 `接收/发送` 行没有 `OneBot` 连接信息**说明 NapCat 没连上插件。

- **A7 二维码 / 登录状态相关文件。**
  → 二维码：`<包>\napcat\napcat\cache\qrcode.png`（NapCat 每 ~2 分钟覆写一次，删了会重建）。
  → 看门狗会复制一份到 `<包>\napcat\login-qrcode.png` 方便找（这是运行时产物，**不要打进分发包**）。
  → 登录标记/防抖戳：`<包>\napcat\.login-required`、`.last-restart`、`.last-dsh-restart`、`.keepalive`。排查"看门狗为什么不重启"时先看 `.last-restart` 的时间。

- **A8 杀毒误杀（360/火绒/Defender）。**
  → 现象：`wrapper.node` 或 `node.exe` 突然消失、启动即退、`NapCatWinBootHook.dll` 报毒。
  → 原因：这俩是"注入/钩子"性质的文件（NapCat 靠它接管 QQ NT 协议），启发式必报。这不是误报不误报的问题，任何 NapCat 都会被报。
  → 怎么办：把 `<包>` 整个目录加进杀软排除项，再从隔离区恢复文件。**别为了这个关掉系统防护。**
  → 分发给别人时提前说清楚，否则对方第一句话就是"你的包有毒"。

- **A9 路径有空格/中文/OneDrive/太长。**
  → 现象：`cmd` 启动失败、`找不到 node.exe`、日志写不出来、随机 `ENOENT`。
  → 原因：本包脚本都做了引号处理，但 NapCat 内部还有若干拼路径的地方；OneDrive 会在进程写日志时锁文件；260 字符上限在深目录会踩。
  → 怎么办：解压到**纯英文短路径**，例如 `D:\tools\qq-napcat`；`install.ps1` 会对中文/OneDrive/超长路径给出警告。
  → 路径变了以后记得改 `napcat-qr.json` 的 `napcatHome`（`install.ps1` 只在文件不存在时写，挪目录后要手改或删掉重跑 `install.ps1`）。

- **A10 NapCat / QQNT 版本不匹配。**
  → 本包是 **shell 模式**（`package.json` 里 `"isPureShell": true`、`"isByteCodeShell": true`），用自带的 `QQNT.dll` + `wrapper.node` 跑，版本由 `<包>\napcat\config.json`（`baseVersion/curVersion = 9.9.31-49738`）和 `<包>\napcat\package.json`（`version 9.9.31-49738`）决定，**不依赖你系统里装的 QQ**。
  → 所以：`napcat\launcher.bat` / `launcher-user.bat` / `launcher-win10*.bat` 这些是**注入安装版 QQ** 的路子，本包用不到，别拿来启动（它会去注册表找 `QQ.exe`，找不到就 `pause` 卡住）。
  → 反过来，如果你把本包 `napcat\` 里的文件跟别的版本混着拷（比如换了个 `wrapper.node` 但 `QQNT.dll` 没换），会白屏/秒退。整目录替换，别单换文件。

- **A11 NapCat 自己升级 / 被 QQ 自动更新带坏。**
  → 现象：昨天还好，今天 `wrapper.node` 版本号变了、启动报 `hook 失败/inject 失败`。
  → 原因：NapCat 有自更新（`napcat.mjs` 的 update 逻辑）或 QQ 自动更新替换了 `wrapper.node`。
  → 怎么办：`wrapper.node` 与 `QQNT.dll` 必须成对；**关掉 QQ 的自动更新**、别在 NapCat 里点升级；真被换坏了就用本包重新解压一份 `napcat\`（数据在 `napcat\napcat\config` 和 `cache`，复制回去即可）。

### B. 登录 / 双端互踢

- **B1 二维码 2 分钟过期，截图一定失效。**
  → 现象：发过去的二维码扫了提示"二维码已失效"。
  → 原因：NapCat 每 ~120 秒换码；`qrValidSeconds` 默认 120。
  → 怎么办：用 `plugin\scripts\show-qrcode.ps1 -STA` 开实时窗口；窗口会自动换码并倒计时，过期会显示"这张过期了，正在等新码…"。**永远不要截图发人、不要读 `qrcode.png` 再转发**。

- **B2 同一个 QQ 号在桌面 QQ 和 NapCat 同时登录 → 互踢（最高频的坑；完整解法见 `docs\napcat-qq-conflict.md`）。**
  → 现象（对号入座）：① 桌面 QQ 一登录，NapCat 就掉线 / 不回消息 / 日志反复重连；② NapCat 一登录，桌面 QQ 弹「账号已在其他设备登录」直接被登出；③ 两边轮流顶、每隔一两分钟踢一次，**看门狗一拉就踢**（死循环）；④ NapCat 日志出现 `KickedOffline` / `kicked` / `账号被踢`。
  → 原因：同一个号在同一台 Windows 上只允许一个 QQ NT 在线会话。NapCat 本质是另起一个 headless QQ NT 实例（自带 `QQNT.dll` + `wrapper.node`），登录后对服务器就是"新设备"，和桌面 QQ 抢同一个会话位。**多开、换目录、装两份 NapCat 都不解决——同号就是互踢。**
  → 怎么办（三选一）：
    **A（推荐）机器人用独立小号**：桌面 QQ 登主号、NapCat 登小号（手机 QQ 里切换账号加一次即可，不需要新手机）；然后改 `plugin\scripts\napcat-qr.json` 的 `botUin`、把配置改名成 `napcat\napcat\config\onebot11_<小号>.json` / `napcat_<小号>.json`、DSH 设置页的 `allowlist`（谁能用机器人，纯数字）与 `workspaceMap`（会话键 `private:<QQ号>` / `group:<群号>`），重启 DSH。
    **B（必须同号）二选一**：用 NapCat 时托盘退出桌面 QQ（只点 × 是收进托盘，号还在线）+ 任务管理器→启动 里禁用 QQ 自启；用桌面 QQ 时 `scripts\start-napcat.ps1 -Stop` 停 NapCat，并且**必须** `Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'`，否则看门狗每分钟把 NapCat 拉起来又踢。
    **C（要知道）手机 QQ 不受影响**：手机端和电脑端是不同设备类型，可以同时在线；但两个 Windows 端不行。
  → 被踢急救：`Select-String "<包>\napcat\napcat-auto.log" -Pattern 'KickedOffline|kicked|账号被踢'`；处理 = 重启 NapCat 重新扫码（旧码作废，别反复扫旧码）；反复被踢先查三件事：桌面 QQ 是不是开机自启在后台偷登、有没有第二个 NapCat/另一个 QQ 客户端用同一个号、`botUin` 是不是还写着旧号（看门狗拿它 `-q` 快速登录 → 被踢 → 再登，无限循环）。
  → 检查：手机 QQ → 设置 → 账号安全 → 登录设备管理（能看到并踢掉多出来的 Windows 端）；NapCat 日志 `<包>\napcat\napcat-auto.log`（`<包>\napcat\napcat\logs\` 默认因为 `fileLog=false` 是空的，要看得把 `napcat_<QQ号>.json` 的 `fileLog` 改 true）。
  → 另外：**就算分了号，NapCat 和桌面 QQ 也必须不同目录 / 不同数据目录**（别共用 `Tencent Files`），QQ 运行时锁文件，撞上可能把 QQ 本体写坏（真实见过 QQ 升级失败/白屏）。

- **B3 扫码后一直"正在等 QQ 确认"，然后 `Login Error ErrCode: 10`。**
  → 原因：QQ 风控（新设备/异地/同 IP 多号）。`ErrCode: 3` 是"这张没人扫超时了"，正常，扫当前那张即可。
  → 怎么办：换网络（手机热点）再扫；小号先在自己的手机 QQ 上登录养几天；同一 IP 别同时登一堆机器人号。

- **B4 扫码成功但 3002 一直没 Established。**
  → 说明登录成功了、但 OneBot 没连。查 `onebot11_<QQ号>.json` 的 `websocketClients[0].enable` 是不是 `true`、`url` 对不对、文件名里的 `<QQ号>` 是不是**真的登录的那个号**（文件名和后缀必须一致，NapCat 按 `onebot11_<登录号>.json` 找配置，找不到就退回 `onebot11.json`）。
  → 改完配置必须**重启 NapCat**（`start-napcat.ps1 -Stop` 后重新启动）。

- **B5 换号以后旧配置还在生效。**
  → 现象：换了机器人号登录，OneBot 连的还是旧端口/旧 token。
  → 原因：配置文件名带号，NapCat 读的是 `onebot11_<新号>.json`，旧文件不会自动改名。
  → 怎么办：把配置文件复制成新号的文件名，旧号的文件删掉；`napcat-qr.json` 的 `botUin` 也一起改（或留空强制扫码）。

- **B6 重启机器后 NapCat 登录态还在，但 Day 2 掉了。**
  → QQ 的登录态大约能维持一段时间，掉线是常态。所以**必须有看门狗**（第六步）；掉线时 `watch-napcat.ps1` 会重启 NapCat 换新码并自动弹扫码窗口。

### C. 插件安装 / 配置

- **C1 `failed to import`。** → 铁律 1。别从文件夹装，用 tgz 或 profile 里写版本号再 `pnpm install`。

- **C2 改完插件配置（端口/token/allowlist/人格）没生效。**
  → 原因：插件模块有缓存，设置页写的是 `<DSH_HOME>\qq-bridge\settings-ui.json`，部分字段（传输方式、提示词、人格）要**重启 DSH** 才重读；人格文件 `personas.json` 是每次读、改完下一条消息就生效。
  → 怎么办：改传输类字段 → 重启 DSH；改人格 → 不用重启。`/dsh-qq-bridge/api/transport/restart` 可以只重启传输层，但保险还是重启 DSH。

- **C3 设置页看不到「QQ 桥接」。**
  → 插件没装成功 / 没启用 / 装完没重启 DSH / 插件在"已禁用"列表里。查：`<DSH_HOME>\profiles\<profile>\node_modules\dsh-qq-bridge` 目录在不在、`package.json` 有没有被写进 link、DSH 启动日志里 `qq-bridge` 有没有挂载成功。

- **C4 私人数据在哪（装完才出现，别指望包里有）。**
  | 文件/目录 | 作用 |
  |---|---|
  | `<DSH_HOME>\qq-bridge\sessions.json` | QQ 聊天 ↔ DSH 会话映射（删了会重建会话，历史对话要重新积累） |
  | `<DSH_HOME>\qq-bridge\personas.json` | 人格/性格模式（可直接手改，下一条消息生效） |
  | `<DSH_HOME>\qq-bridge\settings-ui.json` | 设置页改过的配置（含 accessToken 明文） |
  | `<DSH_HOME>\qq-bridge\features.json` | 按需开启的功能开关 |
  | `<DSH_HOME>\qq-bridge\stickers\` | 表情包库，按聊天分文件夹 |
  | `<DSH_HOME>\qq-workspaces\<会话键>\attachments\` | 图片/语音下载缓存（每个聊天一个工作区；超过 `mediaRetentionDays` 自动清） |
  | `<DSH_HOME>\qq-bridge\qq-bridge-debug.log` | 桥接调试日志 |
  `DSH_HOME` 默认 `%USERPROFILE%\.dsh`；换位置就设环境变量 `DSH_HOME`（插件里所有路径都从它派生）。

- **C5 语音回复失败（本包不带语音引擎）。**
  → 插件发语音会调 `<DSH_HOME>\qq-bridge\bin\make-voice.ps1`，本包没这个文件，所以**文字/图片/表情包正常，语音会失败**。要语音得另外装 TTS（Breeze TTS 那种），把 `make-voice.ps1` 放进 `bin\`，或者干脆让 Agent 只发文字。

### D. 桥接行为（这些"不是 bug"）

- **D1 allowlist 只认纯数字 QQ 号。**
  → 现象：明明把某人加进了 allowlist，机器人却不回他（表现像"机器人坏了"）。
  → 原因：`allowlist` 里带后缀/空格/中文（例如 `10001.`、`"10001 "`、`10001@qq.com`）会被整条丢掉；插件 1.6.x 会自愈清洗并在日志里 `warn` 一句，但写错的那个号等于没加。
  → 怎么办：设置页里一个号一行，纯数字；核对 `<DSH_HOME>\qq-bridge\settings-ui.json` 里的 `allowlist` 数组。`allowlist` 为空 = 所有私聊都回，**别在不知道的情况下留空**。

- **D2 会话被 DSH 归档 → 每轮都被挡成 `blocked`，机器人只回旧话或干脆不回。**
  → 现象：日志里 `turn/end reason=blocked`，模型一步都没跑；回复是旧内容。
  → 原因：DSH 对"已归档会话"的每个 turn 都直接挡掉。插件 1.2.1 起自愈：只认本轮新文本 + `blocked` 时换新会话重试，但**上下文会丢**。
  → 怎么办：先确认 `<DSH_HOME>\qq-bridge\sessions.json` 里那个 `sessionId` 在 DSH 侧是不是已归档；要恢复上下文就删掉该聊天的映射（设置页有「清掉会话映射」/`POST /dsh-qq-bridge/api/sessions/clear`），下一条消息会在新会话里重新开始。

- **D3 群聊默认要 @ 才回，被 @ 后 60 秒最多 3 条。**
  → `groupRequireAt: true`（默认）、`groupAtReplyLimit: 3`。用完 3 条要再 @ 一次。**这不是限流 bug**，是防止机器人在群里刷屏。
  → 想让群里随便聊：设置页关掉"必须 @"，或把 `groupAtReplyLimit` 调大。

- **D4 上下文到 40% 就换新会话。**
  → `contextRotatePercent: 40`（0 = 关闭）。表现是"聊着聊着它忘了前面"。日志里会有 `上下文到 ?% (阈值 40%)，换新会话`。
  → 想长记忆就调大或设 0；代价是 token 消耗。

- **D5 定时醒来主动发消息。**
  → `wakeEnabled: true`、`wakeIntervalMinutes: 60`、`wakeChance: 0.6`；`wakeTargets` 空 = 所有聊过天的私聊。觉得骚扰就关 `wakeEnabled`。**机器人莫名其妙先发一条消息，先看这里，不是灵异事件。**

- **D6 回复太长被分段。**
  → `maxReplyChars: 3800`，超过会自动拆成多条发。单轮超时 `turnTimeoutMs: 600000`（10 分钟），超时会把已有内容先发回来。看到"话说一半停了"，多半是这俩。

- **D7 回复会带表情包（默认开）。**
  → `stickerEnabled: true`、`stickerChance: 0.4`、`stickerMaxBytes: 2097152`、`stickerMaxPerChat: 200`；对方发来的表情包/图片自动收进 `<DSH_HOME>\qq-bridge\stickers\<private-号|group-号>\`，回复时按概率从该聊天的文件夹挑一张附上。
  → 包根 `stickers\` 里只有 `README.txt`：素材是聊天里攒出来的，属聊天数据，不进分发包；新装空库，别人发几张就自动收。想马上有素材就手动放 png/jpg/gif 进对应文件夹。想关：`stickerEnabled: false` 或设置页关掉。

### E. 看门狗 / 计划任务

- **E1 看门狗在干什么（`watch-napcat.ps1`，每分钟一次）。**
  1. DSH 没跑：`keepAlive=true`（或存在 `<包>\napcat\.keepalive`）→ 拉起 DSH（3 分钟防抖）；否则 NapCat 在跑就停掉它省资源。
  2. DSH 在跑但 3002 还没 Listen（刚启动）→ 等下一分钟。
  3. NapCat 进程不在 → 拉起，退出。
  4. 3002 有 Established → 一切正常，清 `.login-required`，退出。
  5. 未连接但 `cache\qrcode.png` 比进程还新 → 正在等扫码：写 `.login-required`、复制 `login-qrcode.png`、**自动弹扫码窗口**。
  6. 本次启动不足 3 分钟 → 给登录/重连留时间。
  7. 10 分钟内刚重启过 → 防抖动，跳过。
  8. 其余 → 重启 NapCat 换新码，写 `.last-restart`。

- **E2 计划任务没跑起来。**
  → 查 `Get-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' | Select TaskName,State,LastRunTime,LastTaskResult`；`LastTaskResult` 非 0 看 `Get-ScheduledTaskInfo`。
  → 手动跑一次看输出：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<包>\plugin\scripts\watch-napcat.ps1" -CheckOnly`（只打印解析结果，不动进程）。
  → 常见：路径里 `<包>` 写错、漏了 `-ConfigFile`、计划任务用 SYSTEM 账户跑导致找不到用户目录 → 改成"只在用户登录时运行"用当前用户跑。

- **E3 看门狗把 NapCat 反复重启（抖动）。**
  → 10 分钟防抖在 `.last-restart` 里；删这个文件等于解除防抖（排查时有用，平时别删）。
  → 一直"未连接 + 没有新二维码"说明 NapCat 起来了但登录不了（号被踢 / 风控），不是看门狗的问题，看 B2/B3。

- **E4 不想让看门狗乱拉 DSH。**
  → `napcat-qr.json` 的 `keepAlive: false`（默认）就只守 NapCat；`dshExe` 留空也不会误拉。`keepAlive: true` 时 `dshExe` 必须填对，否则日志里只有 `keepAlive 已开，但找不到 <dshExe>`。

- **E5 看门狗会停掉"路径在 napcatHome 下"的 node 进程。**
  → 所以 `napcatHome` 一定要写对（指向 `<包>\napcat`），写错可能误杀别的 node；本包脚本只按 `$_.Path -like "$napcatHome\*"` 过滤，不会去杀 DSH 自己的 node。

### F. 分发 / 二次打包（给维护者）

- **F1 绝不能进包的东西**：任何真实 QQ 号（文件名里也不行）、`napcat\napcat\config\` 下的真实配置（含号、token）、`napcat-qr.json`、`napcat-auto.log`、`watchdog.log`、`*.db*`、`login-qrcode.png`、`cache\`、`logs\`、`.keepalive`、`.last-restart`、`.login-required`、个人路径（`<DSH_HOME>` 之外的绝对路径）、人格正文。
- **F2 配置只放 `config.example\`**，文件名不带号（`onebot11.example.json` / `napcat.example.json`），token 留空，号统一写 `10001` 这种假号。
- **F3 打包前必跑扫描**：`powershell -NoProfile -ExecutionPolicy Bypass -File <扫描脚本> -Root "<包>"`，必须 `OK: 0 命中`；再验所有 `.ps1` 语法 0 错误 + 中文脚本有 BOM。
- **F4 zip 用 `tar.exe -a -c -f <包>.zip <包>`**（比 `Compress-Archive` 快很多；345MB 的包别用 Compress-Archive，容易慢到怀疑人生）。
- **F5 本包的 `scripts\napcat.bat` 是转发壳**（真正的入口是 `<包>\napcat\napcat.bat`），因为它 `cd` 到了 `..\napcat`。别把它和 `napcat\` 里的那份搞混。

---

## 四、关键文件表

| 路径 | 作用 |
|---|---|
| `NEXT-AI.md` | 本文件 |
| `README.md` | 给人看的短安装说明 |
| `install.ps1` | 落位检查 + 写 `napcat-qr.json` + 打印下一步（`-Shortcuts` 建桌面快捷方式，`-DryRun` 只看不做） |
| `plugin\lib\index.js` | 桥接主体：OneBot WS、会话、人格注入、收发消息、控制面 API |
| `plugin\lib\client.js` | 设置页「QQ 桥接」前端 |
| `plugin\cordis.patch.yml` | 插件挂载声明（`name:` 必须等于包名 `dsh-qq-bridge`） |
| `plugin\package.json` | 包名/版本 1.6.2/依赖 `ws`/`files` 白名单 |
| `plugin\scripts\show-qrcode.ps1` | 实时二维码窗口（**必须 `-STA`**，WinForms） |
| `plugin\scripts\watch-napcat.ps1` | 看门狗（`-CheckOnly` 干跑） |
| `plugin\scripts\napcat-qr.example.json` | `napcat-qr.json` 模板 |
| `scripts\start-napcat.ps1` | 无窗口启动 NapCat（`-CheckOnly` / `-Stop`，读 `napcat-qr.json` 的 `botUin`） |
| `scripts\run-hidden.vbs` | 用 wscript 完全隐藏跑一个 ps1（计划任务里可用） |
| `scripts\napcat.bat` | 转发到 `..\napcat\napcat.bat` 的壳 |
| `scripts\napcat-qr.example.json` | 同 plugin 里的模板（install.ps1 会生成真正的 json） |
| `napcat\index.js` | NapCat 入口：设好 `NAPCAT_WRAPPER_PATH` 等环境变量后动态 import `napcat\napcat.mjs` |
| `napcat\napcat.bat` | 真正的启动脚本：`node.exe index.js %*` |
| `napcat\node.exe` | 内置 Node（~77 MB），**不需要系统装 node** |
| `napcat\wrapper.node` | NapCat 注入层（~100 MB），杀软最爱误报 |
| `napcat\win64\*.dll` | IPC / SSO 两个 x64 依赖，缺了登录必失败 |
| `napcat\napcat\napcat.mjs` | NapCat core（~3 MB），工作目录 = `napcat\napcat\` |
| `napcat\napcat\config\` | **运行时生成**：`onebot11_<QQ号>.json`、`napcat_<QQ号>.json`、`webui.json`、`napcat.json` |
| `napcat\napcat\cache\qrcode.png` | **运行时生成**：登录二维码（2 分钟一换） |
| `napcat\napcat\logs\` | 文件日志（`fileLog=true` 时才有） |
| `napcat\config.json` | QQ shell 版本锁：`9.9.31-49738` |
| `napcat\config.example\onebot11.example.json` | OneBot v11 示例：ws 3002 / http 3003 / token 空 |
| `napcat\config.example\napcat.example.json` | NapCat 应用配置示例 |
| `stickers\README.txt` | 表情包库示例目录：说明回复带表情包的开关、收图规则、素材从聊天里攒；真实库在 `<DSH_HOME>\qq-bridge\stickers\` |
| `docs\qq-bridge.md` | 本包的安装与使用说明（给人看的中文版） |
| `docs\napcat-qq-conflict.md` | **NapCat 与桌面 QQ 互踢的完整解法**：现象 / 原因 / 方案 A 小号 / 方案 B 同号二选一 / 换号 6 步 / 被踢急救 / 谁在线怎么查 |

---

## 五、自检清单（装完逐条跑，复制即可）

```powershell
$pkg = '<改成你的包目录，例如 D:\tools\qq-napcat>'

# 1) 包完整性：期望 约 345.0 MB / 729 个文件
$s = Get-ChildItem $pkg -Recurse -File -Force | Measure-Object Length -Sum
"{0:N1} MB / {1} files" -f ($s.Sum/1MB), $s.Count

# 2) 所有 ps1 语法 + BOM（期望：每个都是 errors=0；中文脚本 bom=True）
Get-ChildItem $pkg -Recurse -File -Filter *.ps1 | ForEach-Object {
  $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$e)
  $b = [IO.File]::ReadAllBytes($_.FullName)
  $bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  "{0,3} errors bom={1,-5} {2}" -f $e.Count, $bom, $_.FullName.Substring($pkg.Length)
}

# 3) 关键文件都在（期望全部 True）
@('NEXT-AI.md','README.md','install.ps1','plugin\lib\index.js','plugin\scripts\show-qrcode.ps1',
  'plugin\scripts\watch-napcat.ps1','scripts\start-napcat.ps1','scripts\run-hidden.vbs','scripts\napcat.bat',
  'napcat\node.exe','napcat\index.js','napcat\napcat.bat','napcat\wrapper.node',
  'napcat\win64\parent-ipc-core-x64.dll','napcat\win64\SSOShareInfoHelper64.dll',
  'napcat\napcat\napcat.mjs','napcat\config.example\onebot11.example.json') |
  ForEach-Object { "{0,-5} {1}" -f (Test-Path (Join-Path $pkg $_)), $_ }

# 4) 启动脚本解析对不对（不动进程）
powershell -NoProfile -ExecutionPolicy Bypass -File "$pkg\scripts\start-napcat.ps1" -CheckOnly
# 期望：napcatBatExists=true, nodeExeExists=true, napcatHome 指向 <包>\napcat

# 5) 看门狗解析对不对（不动进程）
powershell -NoProfile -ExecutionPolicy Bypass -File "$pkg\plugin\scripts\watch-napcat.ps1" -CheckOnly
# 期望：napcatBatExists=true, qrWindowExists=true, pluginPort=3002

# 6) 插件能被 Node 解析（用包里的 node，不需要系统 node）
& "$pkg\napcat\node.exe" --check "$pkg\plugin\lib\index.js"
& "$pkg\napcat\node.exe" --check "$pkg\plugin\lib\client.js"
# 期望：无输出 = 通过

# 7) NapCat 在跑吗 / 连上了吗
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$pkg\napcat\*" } | Select Id,StartTime
Get-NetTCPConnection -LocalPort 3002 -ErrorAction SilentlyContinue | Select LocalPort,State
# 期望：3002 同时有 Listen（插件）和 Established（NapCat）

# 8) 登录成功了吗（NapCat HTTP 口）
$r = Invoke-RestMethod 'http://127.0.0.1:3003/get_login_info' -TimeoutSec 3
"retcode=$($r.retcode) user_id=$($r.data.user_id) nickname=$($r.data.nickname)"
# 期望：retcode=0 且 user_id 是你的机器人号

# 9) 计划任务
Get-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' -ErrorAction SilentlyContinue | Select TaskName,State
# 期望：Ready

# 10) 端到端：用手机 QQ / 电脑 QQ 给机器人发「你好」
#     期望：几秒内收到回复；<包>\napcat\napcat-auto.log 里同时有「接收 <- 私聊」和「发送 -> 私聊」
```

---

## 六、症状 → 排查对照表

| 症状 | 先查 |
|---|---|
| 插件页 `failed to import` / 设置里没有「QQ 桥接」 | 铁律 1（是不是从文件夹装的）+ 重启过 DSH 没有（C3） |
| `node.exe` 秒退，日志只有 `NapCat Shell App Loading...` | 文件缺 / 杀软隔离（A1、A8） |
| 日志里连 `WebUi Token` 都没打印 | 同上，本体没起来 |
| 二维码窗口一直"等待 NapCat 生成二维码…" | NapCat 没起来或还没到出码阶段；看 `napcat-auto.log`（A6） |
| 二维码扫了提示失效 | 用了截图（B1）；用 `show-qrcode.ps1` 实时窗口 |
| `Login Error ErrCode: 3` | 上一张没人扫超时，正常（B3） |
| `Login Error ErrCode: 10` | QQ 风控，换网络/养号（B3） |
| 桌面 QQ 被顶下线 / 两边轮流掉 / 看门狗一拉就踢 | 同号双端互踢（B2），完整解法见 `docs\napcat-qq-conflict.md`；正解是机器人换小号 |
| NapCat 日志出现 `KickedOffline` / `账号被踢` | 同号互踢或另一头在抢号（B2 → `docs\napcat-qq-conflict.md` 第七节急救） |
| 登录成功但 3002 没有 Established | OneBot 配置文件名/端口/enable/重启（B4） |
| 3002 有 Listen 没有 Established，NapCat 一直重连 | token 不一致 或 插件没在运行（A4） |
| 插件报 `EADDRINUSE` | 3002 被旧框架占（A3） |
| 机器人不回私聊 | allowlist 写脏 / 留空但群聊规则干扰（D1）；会话被归档（D2） |
| 只回旧内容 / 模型一步没跑 | 会话归档 `blocked`（D2） |
| 群里不回 | 没 @（D3）、被 @ 后超过 3 条（D3）、`groupEnabled=false` |
| 聊两句就忘前文 | `contextRotatePercent` 到阈值换会话（D4） |
| 机器人自己先发消息 | `wakeEnabled` 定时醒来（D5） |
| 回复被拆成好几条 / 说一半停 | `maxReplyChars` / `turnTimeoutMs`（D6） |
| 发语音失败 | 本包不带 TTS（C5） |
| 看门狗不干活 | 计划任务状态 + `-CheckOnly` 手跑（E2） |
| 看门狗反复重启 NapCat | `.last-restart` 防抖（E3）；真原因是登录不上（B2/B3） |
| 改了端口/token 没反应 | 两边都要改 + 重启（A2、C2） |

---

## 七、本包**不含**什么（以及怎么补）

| 不含 | 说明 | 怎么补 |
|---|---|---|
| 任何真实 QQ 号 / token / 密码 | 全部脱敏；配置只给 `config.example\`（假号 `10001`、token 空） | 装完自己填机器人号，或扫码登录 |
| `napcat-qr.json` | `install.ps1` 生成（`napcatHome` 指向本包），**不进包** | 跑 `install.ps1`，或手改 `napcat-qr.example.json` 另存 |
| `napcat\napcat\config\` 真实配置 | 含号/token，绝不进包；首次启动自动生成 | 复制 `config.example\` 里的示例改名（第一节第 3 步） |
| 日志 / 数据库 / 二维码 / 缓存 | `*.log`、`*.db*`、`qrcode.png`、`login-qrcode.png`、`cache\`、`logs\` 都不在包里 | 运行时自动生成 |
| 人格正文 / 聊天记录 / 表情包库 | 在 `<DSH_HOME>\qq-bridge\`，属私人数据 | 自己攒；人格可在设置页写 |
| 语音合成引擎（TTS） | 本包只做文字/图片/表情包；发语音会因缺 `bin\make-voice.ps1` 失败 | 另装 TTS（如 Breeze TTS 2 C++ 版），把 `make-voice.ps1` 放到 `<DSH_HOME>\qq-bridge\bin\` |
| `dsh-persona`（身份与人设页） | 不在本包 | 单独装 `dsh-persona` |
| 系统里的 Node/npm | 不需要 | 本包自带 `napcat\node.exe`；`npm pack` 用 DSH 自带 node 目录里的 npm |
| QQ 客户端 | **shell 模式不需要装 QQ** | 无需；想用注入模式才需要装 QQ（本包不用） |

---

## 八、给接手 AI 的 5 句话总结

1. 先跑 `install.ps1` 看文件齐不齐，再按第一节 1→8 走，别跳扫码那步。
2. 插件只有一种正确装法：`npm pack` 出 tgz 再装，从文件夹装必挂。
3. 二维码永远用 `show-qrcode.ps1` 实时窗口，2 分钟过期、截图必废。
4. 机器人不回：先 `curl http://127.0.0.1:3003/get_login_info` → 再 `Get-NetTCPConnection -LocalPort 3002` → 再看 allowlist / 群聊 @ / 会话归档。
5. 看门狗是计划任务 `DSH-NapCat-Watchdog`，每分钟一次；不想让它跑就 `Disable-ScheduledTask`，别直接删脚本。
