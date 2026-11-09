# QQ 桥接安装与使用（本包版）

插件本体在 `plugin/`，NapCat 本体在 `napcat/`。桥接做一件事：把 QQ 消息交给 DSH Agent，再把回复发回 QQ。

```
QQ ↔ NapCat(OneBot v11) ↔ 反向 WS ws://127.0.0.1:3002 ↔ dsh-qq-bridge 插件 ↔ DSH Agent
```

## 0. 本包的路径约定

| 路径 | 是什么 |
|---|---|
| `<包>\plugin\` | dsh-qq-bridge 1.6.2（要装进 DSH 的插件） |
| `<包>\plugin\scripts\show-qrcode.ps1` | 实时二维码窗口（登录用） |
| `<包>\plugin\scripts\watch-napcat.ps1` | NapCat 守护（计划任务每分钟跑） |
| `<包>\napcat\` | NapCat 本体（node.exe / wrapper.node / napcat\ / win64\） |
| `<包>\napcat\napcat.bat` | NapCat 真正入口（`node.exe index.js`） |
| `<包>\napcat\config.example\` | 脱敏的 OneBot 配置示例（要改名复制到 `napcat\napcat\config\`） |
| `<包>\scripts\start-napcat.ps1` | 无窗口拉起 NapCat（幂等，可 `-CheckOnly` / `-Stop`） |

## 1. 装插件（关键：别用「从文件夹安装」）

pnpm 从本地目录装会写成 `link:` 且不装依赖，插件的 bare import（`ws`）全挂，插件页只显示 `failed to import`。两种可行做法：

**A. 打成 tgz 再按包装（推荐）**

```powershell
cd <包>\plugin
npm pack                 # 得到 dsh-qq-bridge-1.6.2.tgz
```

把 tgz 交给 DSH 的插件管理器安装，或在 DSH 里按包名安装。

**B. 写进 profile**

把 `"dsh-qq-bridge": "file:<tgz 的绝对路径>"` 加进 profile 的 `package.json` 依赖，然后 `pnpm install`，重启 DSH。

装完 DSH 设置页里会多出「QQ 桥接」一页。

## 2. 数据目录

桥接的私人数据默认放 `<DSH_HOME>\qq-bridge\`（`DSH_HOME` 默认 `%USERPROFILE%\.dsh`），**不在本包里**：

```
personas.json        人格/性格模式
features.json        功能开关
sessions.json        QQ 聊天 → DSH 会话映射
settings-ui.json     设置页改过的配置
stickers\            表情包库
qq-bridge-debug.log  调试日志
```

图片和语音的下载缓存**不在这里**——落在每个聊天自己的工作区里（默认 `<DSH_HOME>\qq-workspaces\<会话键>\attachments\` 和 `edited\`），按 `mediaRetentionDays`（默认 14 天）自动清。以代码 `lib/index.js` 为准。

## 3. NapCat 侧

- **号和目录都要分开**：登录用的号不要和桌面上登的 QQ 是同一个，同一个号在两个 PC 端必互踢。NapCat 独立目录（本包的 `napcat\`），数据目录随之独立。
- **配置 OneBot v11**：NapCat 的配置在 `<包>\napcat\napcat\config\`。把 `config.example\` 里两个示例改名复制过去（QQ 号换成你机器人的号）：

```powershell
cd <包>\napcat\config.example
copy onebot11.example.json ..\napcat\config\onebot11_<QQ号>.json
copy napcat.example.json   ..\napcat\config\napcat_<QQ号>.json
```

- 桥接做**反向 WS 服务端**（`mode: server`、端口 3002），所以 NapCat 这边配的是 **websocketClients**，地址 `ws://127.0.0.1:3002/`。
- 示例里另外开了一个 HTTP 服务 `127.0.0.1:3003`：只用来看「登录成功没」和快速排查（`http://127.0.0.1:3003/get_login_info`），不开也不影响聊天。
- 需要鉴权就在两边同时填同一个 token（NapCat 的 `token` 字段 ↔ 插件设置页的 access token）。

## 4. 启动 NapCat 与扫码登录

第一种：手动启动（看得到日志，排错用）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\scripts\start-napcat.ps1 -CheckOnly   # 先核对路径
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\scripts\start-napcat.ps1              # 无窗口拉起
Get-Content <包>\napcat\napcat-auto.log -Tail 30                                   # 看日志
```

第二种：直接 `cd <包>\napcat` 然后 `napcat.bat`，控制台会直接打印二维码（最快验证）。

登录：NapCat 每 2 分钟换一张二维码，截图给人一定会失效，用实时窗口看：

```powershell
copy <包>\plugin\scripts\napcat-qr.example.json <包>\plugin\scripts\napcat-qr.json
# 改 napcat-qr.json：napcatHome 填 <包>\napcat（反斜杠要写成 \\），botUin 填纯数字或留空
powershell -NoProfile -STA -ExecutionPolicy Bypass -File <包>\plugin\scripts\show-qrcode.ps1
```

窗口盯着 `napcat\napcat\cache\qrcode.png`，一变就换新码，登录成功（HTTP 3003 的 `get_login_info` 拿得到 user_id）自动关闭。

## 5. 守护（看门狗）

`plugin\scripts\watch-napcat.ps1` 按 DSH 的状态决定 NapCat 该不该在：DSH 没跑就按配置决定是否拉起；DSH 跑着但 NapCat 掉了就重启换新码；10 分钟内刚重启过就跳过（防抖动）。建议计划任务每分钟跑一次：

```powershell
schtasks /create /tn "DSH-NapCat-Watchdog" /sc minute /mo 1 /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"<包>\plugin\scripts\watch-napcat.ps1\" -ConfigFile \"<包>\scripts\napcat-qr.json\"" /f
```

停 / 查：

```powershell
Get-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' | Select TaskName,State
Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'
Unregister-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' -Confirm:$false
```

## 6. 几个行为说明（不是 bug）

- 群聊要 @ 才回；被 @ 后 60 秒最多 3 条（`groupAtReplyLimit`）。
- 私聊/群聊各自一个 DSH 会话；上下文用到 `contextRotatePercent`（默认 40%）就换新会话。
- 会话如果在 DSH 里被归档，会看起来"只回旧话"，插件会自愈（换新会话重试），但会丢上下文。
- allowlist 只认纯数字 QQ 号，带后缀的值会被整条丢掉。

## 7. 许可证

- dsh-qq-bridge：MIT（见 `plugin\LICENSE`）。
- NapCat：本包只分发其运行时文件，版权归 NapCat 项目（https://github.com/NapNeko/NapCatQQ）所有，按原项目许可证使用。
