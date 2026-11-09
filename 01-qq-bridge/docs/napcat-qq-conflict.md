# NapCat 和桌面 QQ 互踢：原因与解决

**一句话**：同一个 QQ 号在同一台 Windows 上只能有一个 QQ NT 在线会话。NapCat 本质上是**另起一个 QQ NT 实例**，所以它和桌面 QQ 用同一个号时，必然互相顶号——这是协议层行为，不是 bug，改目录、多开、装两份 NapCat 都解决不了。

> 这份文档专门解决「被踢」这一类问题。装不上、连不上 OneBot、二维码过期等问题看 `..\NEXT-AI.md` 和 `qq-bridge.md`。

---

## 一、现象（对号入座）

| 现象 | 谁被踢 |
|---|---|
| 桌面 QQ 登录后，NapCat 掉线 / 不回复 / 日志反复重连 | NapCat 被桌面 QQ 顶掉 |
| NapCat 登录后，桌面 QQ 弹「账号已在其他设备登录」/ 直接被登出 | 桌面 QQ 被 NapCat 顶掉 |
| 两边轮流掉、每隔一两分钟顶一次，看门狗一拉就踢 | 看门狗拉起 NapCat → 踢桌面 QQ → 你重新登桌面 QQ → 踢 NapCat，**死循环** |
| NapCat 日志出现 `KickedOffline` / `kicked` / `账号被踢` / `下线通知` | 明确被踢，按本文处理 |
| 机器人还在线但发消息不回、3002 上 Established 时有时无 | 大概率也是被踢后重连抖动，先看日志确认 |

---

## 二、原因（为什么换目录也没用）

1. QQ 账号的在线会话是**按号**占用的，不是按进程、不是按目录。无论同一台机器装多少个 QQ / NapCat，同一个号只能有一个 QQ NT 会话在线。
2. NapCat 的「shell 模式」不是外挂模拟，它启动的就是一个 headless 的 QQ NT（自带的 `QQNT.dll` + `wrapper.node`），登录后对服务器来说就是一台「新设备」，和你桌面 QQ 抢同一个号的会话位。
3. 所以：**多开、换安装目录、装两份 NapCat、用不同数据目录，都只解决文件冲突，不解决踢号。同号就是互踢。**
4. 看门狗 `watch-napcat.ps1` 会把这件事放大：它每分钟检查一次，发现 NapCat 不在就拉起；NapCat 一起来就把桌面 QQ 顶掉；你再登桌面 QQ 又把 NapCat 顶掉——表现就是「反复互踢、看门狗一拉就踢」。

---

## 三、三种方案（先选路，再动手）

| 方案 | 适用 | 代价 | 推荐 |
|---|---|---|---|
| **A. 机器人用独立小号** | 长期用、想 24 小时在线 | 需要一个额外 QQ 号 | ✅ 推荐 |
| **B. 必须同一个号** | 只是临时跑一下、或没有第二个号 | 两边只能二选一，不能同时在线 | 可用，但麻烦 |
| **C. 手机 QQ + NapCat** | 想在手机上聊、电脑上跑机器人 | 手机 QQ 与电脑端是**不同设备类型**，可以并存 | 了解一下 |

> 手机 QQ 和电脑 QQ 可以同时在线；**两个 Windows 端不行**。所以「手机 QQ 收着消息、NapCat 在电脑上跑机器人」这个组合是成立的，前提是机器人号在电脑上没有登录桌面 QQ。

---

## 四、方案 A：机器人用独立小号（推荐）

桌面 QQ 登你的主号，NapCat 登小号，各占各的会话位，从此不会互踢。

**准备小号**（不需要新手机）：

1. 手机 QQ → 左上角头像 → 设置 → 账号管理 / 切换账号 → 添加账号，用小号登一次。
2. 小号建议：注册满一段时间、有头像昵称、在自己的手机 QQ 上正常用过几天（新号直接上 PC 端容易被风控，见 `NEXT-AI.md` B3）。
3. 不需要给电脑装第二个 QQ。

**改这三处（都换成小号）**：

| 位置 | 改什么 |
|---|---|
| `plugin\scripts\napcat-qr.json` | `botUin` 填小号（纯数字）；不填也行，不填就每次扫码 |
| NapCat 配置文件名 | `napcat\napcat\config\onebot11_<小号>.json`、`napcat_<小号>.json`（文件名必须和登录号一致） |
| DSH 设置 → QQ 桥接 | `allowlist` 里放**允许跟机器人聊天的人**（主号、朋友），是「谁能用」，不是机器人自己；`workspaceMap` 的会话键写成 `private:<小号>` / `private:<对方号>` |
| 会话键 | 私聊 `private:<QQ号>`，群聊 `group:<群号>`；换号后旧会话键对应的历史不会自动搬过去 |

扫小号的码用 `plugin\scripts\show-qrcode.ps1`（实时窗口，2 分钟过期，别截图）。
改完插件配置**重启 DSH** 才生效。

---

## 五、方案 B：必须同一个号（只能二选一）

同号情况下，**NapCat 在跑，桌面 QQ 就必须退；桌面 QQ 在登，NapCat 就必须停**。没有第三条路。

**用 NapCat 时（机器人模式）**：

1. 桌面 QQ **从托盘退出**（右键托盘图标 → 退出；只点窗口右上角 × 只是最小化到托盘，号还在线）。
2. 任务管理器确认 `QQ.exe` 进程没了。
3. 防止它自己又起来：任务管理器 → 启动 → 把 QQ 的自启动禁用。
4. 起 NapCat：`powershell -NoProfile -ExecutionPolicy Bypass -File <包>\scripts\start-napcat.ps1`。

**用桌面 QQ 时（人肉模式）**：

1. 停 NapCat：`powershell -NoProfile -ExecutionPolicy Bypass -File <包>\scripts\start-napcat.ps1 -Stop`（只杀包内的 node，不碰桌面 QQ）。
2. **关掉看门狗**，否则它一分钟内又给你拉起来，然后踢掉桌面 QQ：

```powershell
# 二选一
Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'          # 临时禁用，之后可 Enable 回来
Unregister-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' -Confirm:$false   # 彻底删掉
```

3. 如果不想禁用任务，就把 `plugin\scripts\napcat-qr.json` 里 `keepAlive` 设成 `false`（这只能防「拉起 DSH」，**防不住看门狗拉起 NapCat**，所以还是建议禁用任务）。

**切回机器人模式**：重新 `Enable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'`，然后按下面第六节走一遍。

---

## 六、换号 / 切换的完整步骤（照抄）

> 顺序很重要：先把桌面 QQ 彻底弄下线，再让 NapCat 登目标号，否则你扫的码一登上去就被踢。

```powershell
$pkg = '<包目录，例如 D:\tools\qq-napcat>'

# ① 完全退出桌面 QQ（托盘退出，再确认进程没了）
Get-Process QQ -ErrorAction SilentlyContinue | Select Id,Path
# 期望：没有输出。有就手动托盘退出，别用 Stop-Process 硬杀（更保险的是正常退出）
Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' -ErrorAction SilentlyContinue   # 先别让看门狗插一脚

# ② 停 NapCat（只杀包内 node，不碰桌面 QQ）
powershell -NoProfile -ExecutionPolicy Bypass -File "$pkg\scripts\start-napcat.ps1" -Stop

# ③ 清掉该号的快速登录缓存，否则它可能自动用旧号重登，又被踢
Remove-Item "$pkg\napcat\napcat\cache\*" -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem "$pkg\napcat\napcat\config" -Force | Select Name          # 看一眼有哪些带号的配置
# 换号时把旧号的配置挪走/删掉（改名成 .bak 也行），例：
#   onebot11_<旧号>.json、napcat_<旧号>.json
# 同时把 napcat-qr.json 的 botUin 改成新号，或者干脆留空（留空=不快速登录，只扫码，最不容易被踢）
notepad "$pkg\plugin\scripts\napcat-qr.json"

# ④ 重新起 NapCat，扫码登目标号
powershell -NoProfile -ExecutionPolicy Bypass -File "$pkg\scripts\start-napcat.ps1"
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "$pkg\plugin\scripts\show-qrcode.ps1"
```

⑤ **桥接设置页改两处**：机器人账号（`botUin` / 查询 NapCat 账号确认是哪个号）+ `allowlist`（谁能用机器人，纯数字、一个一行，不写机器人自己）。会话键 `private:<QQ号>` / `group:<群号>` 跟着新号走，旧会话历史不会自动迁移。**重启 DSH**。

⑥ **验证一条**：用另一个号给机器人发「你好」，收到回复；再进一个群 @ 它一次，确认群里也回。

---

## 七、被踢之后怎么急救

1. **先确认是不是被踢**：NapCat 控制台日志里搜关键字。

```powershell
Select-String -Path "<包>\napcat\napcat-auto.log" -Pattern 'KickedOffline|kicked|账号被踢|下线|Login Error' | Select-Object -Last 10
```

2. **处理**：重启 NapCat 重新扫码（`start-napcat.ps1 -Stop` → `start-napcat.ps1` → `show-qrcode.ps1`）。被踢后旧二维码等于作废，别拿旧码反复扫。
3. **反复踢（一分钟一次那种）**：NapCat 没问题，是**另一头有人在抢号**。按顺序查：
   - 桌面 QQ 是不是开机自启在后台偷登（任务管理器 → 启动 里把 QQ 禁用）；
   - 是不是还有第二个 NapCat / 另一个 QQ 客户端（另一个目录里的 QQ、旧版本 QQ、LLOneBot 之类）在用同一个号；
   - 看门狗是不是在拉：`Get-ScheduledTask -TaskName 'DSH-NapCat-Watchdog' | Select State`，临时 `Disable-ScheduledTask` 排除干扰；
   - `napcat-qr.json` 的 `botUin` 是不是写着旧号（看门狗会拿它 `-q` 快速登录，登上去就踢，踢完再登，无限循环）。
4. **实在没辙**：换小号（方案 A）。反复同号互踢是最典型的资源浪费。

---

## 八、检查方法（谁在线）

- **手机 QQ 查登录设备**：手机 QQ → 设置 → 账号安全 → 登录设备管理，能看到当前在线的设备列表；发现多出来的「Windows / 电脑」条目就是另一个客户端，可以直接把它踢下线。
- **NapCat 侧**：`curl.exe http://127.0.0.1:3003/get_login_info` 返回 `retcode:0` + `user_id` 才是真登录成功；
  `Get-NetTCPConnection -LocalPort 3002 -State Established` 有连接说明 OneBot 连上了（但**不能**反推一定没被踢，被踢后重连也会短暂 Established）。
- **日志位置**：
  - 控制台日志：`<包>\napcat\napcat-auto.log`（默认就在这，被踢信息一般够看）
  - 文件日志：`<包>\napcat\napcat\logs\` —— **默认 `fileLog=false`，这个目录是空的**。要看文件日志，把 `napcat\napcat\config\napcat_<QQ号>.json` 里的 `fileLog` 改成 `true` 再重启 NapCat。
  - 看门狗：`<包>\napcat\watchdog.log`（每次拉起/重启都有时间戳，能看出「是不是看门狗在拉」）。

---

## 九、顺带一条：就算分号，目录也必须分开

即使桌面 QQ 和 NapCat 用的是**不同号**，也**不要**让它们共用安装目录 / 数据目录（别把 NapCat 放进 QQ 的安装目录，也别共用 `Tencent Files`）：

- QQ 本体在运行时会锁自己的文件，NapCat 写日志/缓存时可能撞锁，轻则写失败，重则把 QQ 本体文件弄坏（真实见过 QQ 升级失败/白屏）。
- 本包的约定就是：NapCat 全部在 `<包>\napcat\` 里，数据在 `<包>\napcat\napcat\`（`config\` / `cache\` / `logs\`），跟桌面 QQ 一点不沾。

---

## 十、速查表

| 问题 | 一条命令 / 一步 |
|---|---|
| 现在谁在线 | 手机 QQ → 设置 → 账号安全 → 登录设备 |
| 停 NapCat | `powershell -File <包>\scripts\start-napcat.ps1 -Stop` |
| 起 NapCat | `powershell -File <包>\scripts\start-napcat.ps1` |
| 扫码 | `powershell -STA -File <包>\plugin\scripts\show-qrcode.ps1` |
| 停看门狗 | `Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'` |
| 查被踢 | `Select-String "<包>\napcat\napcat-auto.log" -Pattern 'kicked|KickedOffline|被踢'` |
| 查登录 | `curl.exe http://127.0.0.1:3003/get_login_info` |
| 查进程 | `Get-Process QQ,node | Select Id,Path` |
| 正解 | 机器人用小号，桌面 QQ 用主号 |
