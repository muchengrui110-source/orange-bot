# 架构与设计思路

## 一句话

四套东西拼起来是**一个长在 QQ 里的本地 agent**：能收发 QQ 私聊/群聊、记得住人、有固定人设、会发语音条。

拆开看是四件事：

| 目录 | 是什么 | 在架构里的角色 |
|---|---|---|
| `01-qq-bridge` | dsh-qq-bridge 1.6.2 + NapCat 分发包 | 通道层：QQ ↔ DSH 的翻译器 |
| `02-persona` | dsh-persona 1.4.0 | 人设层：编辑那份被通道层读的人格文件 |
| `03-voice` | Breeze TTS 2 v0.1.6 对接层 | 出口层：把文字变成 mp3 再变成语音条 |
| `04-memory` | dsh-mnemon 0.5.39（第三方 MIT） | 记忆层：让 agent 跨会话记住人和事 |

关键事实：**四者之间没有一行互相 import**。全部耦合都是「文件契约 + DSH 服务契约」——同一份 `personas.json`、同一个 `make-voice.ps1` 路径、同一套 DSH 会话与工作区服务。所以任何一个都能单独换掉，这也是这套东西能拆成四个包发布的原因。

## 数据流

```
手机/电脑上的 QQ（用户那个号）
      ↑↓  QQ 私有协议
NapCat（headless QQ NT，自带 wrapper.node，独立数据目录）
      ↑↓  OneBot v11
      ├─ 反向 WebSocket  ws://127.0.0.1:3002   ← 插件是服务端
      └─ HTTP            http://127.0.0.1:3003 ← 旁路，只用来查「登录成功没」
      ↑↓
dsh-qq-bridge（DSH 插件，数据在 <DSH_HOME>/qq-bridge/）
      ↑↓  ctx.agents / ctx.workspaceRegistry / ctx.sessionTitle …
DSH 会话（每个 QQ 聊天 = 一个会话 + 一个工作区）
      ├─ 人格：每条消息重读 personas.json → 拼进注入文本
      ├─ 记忆：dsh-mnemon 在宿主层提供 VIEW 与 mnemon_* 工具
      └─ 语音：agent 调 <DSH_HOME>/qq-bridge/bin/make-voice.ps1
                    ↓ 转发到 <语音包>/voice/scripts/make-voice.ps1
                    ↓ 按需拉起 Breeze（127.0.0.1:8137，Vulkan）
                    ↓ 出 mp3
      ↑↓  回复里的 ![](本地音频路径) → 插件识别成语音段 → send_msg
```

一次完整往返（私聊）：

1. NapCat 收到消息，走 3002 推一个 `post_type=message` 的 JSON 帧。
2. 插件解析消息段（text / image / record / at …），拼成文本，图片和语音单独拿。
3. 查 `sessions.json`：这个聊天有会话就 `resume`，没有就 `create`。
4. 图片下载到工作区 `attachments/`，把本地路径写进消息（agent 用 `read_image` 看图）。
5. 语音先让 NapCat `get_record` 转码成通用音频，再用 ffmpeg 转 16k 单声道 WAV，交给 DSH 的 `speechToText` 服务转文字。
6. `agent.followup()` → 等 `whenIdle()` → 只取这一轮新出现的 assistant 文本。
7. 文本按人类说话节奏切成多条，逐条 `send_msg`；按概率再补一张表情包。
8. agent 如果写了 `![语音](x.mp3)`，插件按扩展名识别成 `record` 段发出去。

## 分层设计与取舍

### QQ 协议端：为什么是 OneBot，不是直接 hook QQ

NapCat 本身就是「headless QQ NT + 注入层」，它已经把最难的那部分（登录、协议、风控、收发）做完了。插件只在它之上接一个**标准协议**，于是：

- 插件不认识 QQ 协议。换 OneBot 实现（LLOneBot、Lagrange、旧版 NapCat）理论上不用改代码——插件只要 `mode` / `host` / `port` / `accessToken` 这几个字段对上。
- 桥接不碰 `wrapper.node`、不碰 QQ 安装目录，出问题往下一层退，边界清楚。
- 代价是 NapCat 的坑会浮上来：杀软误报 `wrapper.node`、版本必须成套替换、`KickedOffline` 这类账号级问题。

### 传输：为什么是反向 WS 长连接

默认 `mode: server`，**插件监听 3002，NapCat 作为客户端连过来**（NapCat 侧配 `websocketClients`）。

- 方向反过来的好处：插件重启时不需要去「找到」NapCat，NapCat 自己会重连；插件也不用管心跳、不用管谁先起。
- 长连接而不是轮询：QQ 消息是推送式的，轮询既慢又费。WS 一帧一条消息，`echo` 字段用来把响应和请求对上（`sendActionAwait`，用于 `get_record`、`get_login_info` 这类要返回值的接口）。
- 插件同时接受多个连接（`sockets` 是个 Set，出站 action 广播给所有连接），重连期间残留的旧连接不会把新连接挤掉。
- 也留了 `mode: client` 正向模式：插件主动连机器人的 WS 服务端，断线按 `reconnectMs` 重连。适合机器人不在本机的情况。
- 3003 是 NapCat 自己开的 HTTP，只作旁路诊断（`get_login_info` 判断登录成功没），不参与聊天。少一条链路就少一个失败点。

### 桥接插件：几个核心决定

**会话键。** `private:<QQ号>`、`group:<群号>:<QQ号>`。群聊键带发言人 QQ 号，所以群里每人一个会话；但 `workspaceKey` 都是 `group:<群号>`，于是全群共用一个工作区、一份 `群记忆.md`。想让某人（或某群）落到已有工作区，用 `workspaceMap` 显式映射。

**跨重启记忆。** DSH 把会话事件日志持久化在磁盘上，但插件原来只把「聊天 → 会话」放在内存 Map 里，重启就断了。所以加了 `sessions.json`：记 `sessionId` 和一个 `signature`（人格 + 修图开关的指纹）。

恢复顺序是三级降级：

1. `ctx.agents.get(sessionId)` 拿到活的 Agent → **借用**（用户可能正把这个会话开在 DSH 界面里，`resume` 必然报 "already owned"）。借来的会话不能 `dispose`，handle 是空实现。
2. 没活的 → `resume`，最多 5 次指数退避（多半是刚被人打开）。失败写 `resume-debug.log`。
3. 都不行 → 新建。最差只是退化成没有历史的新会话，不会「发消息没人理」。

**会话失效的两条自愈路径。** `contextRotatePercent`（默认 40%）用 `tokenMeter` 量上下文，到阈值就下一条消息换新会话。另一个是 DSH 会直接挡掉已归档会话的每个 turn（`turn/end reason=blocked`），插件看到「没有新回复 + blocked」就换新会话把这条消息重送一次。两条都会丢上下文，这是刻意的：宁可从零开始，也不要一直对着一个跑不动的会话。

**消息切分。** 这块最琐碎，也最能看出为什么这么设计。整个流程在 `lib/index.js`：

```
回复原文
  → sanitizeReplyText   洗 HTML（块级标签转换行），代码块/行内代码先摘出来保护
  → buildReplySegments  扫 ![](...)，按扩展名分 image / record 段，其余是文本段
  → splitChunks         空行分段 → 句末标点断句 → 超长才按字数硬切
  → hasVisibleContent   只有标点的块直接丢
  → send_msg ×N
```

三个决定值得说：

- **一句一条，不像「一次性甩一大段」。** 所以短回复也按句切（`splitSentences` 按 `。！？；!?;` 和换行断）。
- **必须洗 HTML。** 模型偶尔被网页内容带偏，回一段 `<p>…</p>`；叠上「一句一条」，`</p>` 这种裸标签会单独变成一条消息发出去。清洗在出口统一做，混排（文字 + 图片）里的文本段也过一遍。
- **媒体段不占字符预算。** `maxReplyChars`（默认 3800）只数文本；图片/语音段挂在消息里一起发，发不出去（文件不存在）就退回一句文本提示，不静默丢。

**人格注入：增补，不是改写。** 桥接不改 system prompt，也不打补丁到宿主预设上，而是把拼好的文本当成一条 **user 消息** `inject` 进去（`makeUserMessage(..., {kind:'qq-bridge'})`）。拼的内容分四段：

```
BASE_RULES        QQ 场景 + 收发能力约定（图片给路径用 read_image、语音已转文字、
                  要发图直接写 markdown、要发语音调 make-voice.ps1 并带 -Persona…）
imageEditRules    修图能力的边界与调用方式（关掉时换成 IMAGE_EDIT_OFF_HINT）
【当前性格模式：X】  personas.json 里 active 那个模式的正文
【共用规则】        personas.json.rules，被模式正文前 24 字覆盖的不重复拼（省 token）
```

为什么这么选：

- **零侵入。** 不依赖宿主「预设改写」的私有能力，任何 DSH 版本都能跑；换人格只改一个 JSON。
- **只在创建会话时注入一次。** `resume` 不再注入——历史里已经有了，重复注入纯烧 token。
- **变了才补。** `signature` 变化时补一条 `[会话设定已更新]`，包括「机器人停机期间用户改了人格文件」这种情况。
- **备用风格不落盘。** `variants` / `variantChance` 掷一次只影响**本次**注入的文本，绝不写回 persona——写回会让签名抖动，每条消息都触发一次重注入。
- 代价：人格不是真 system prompt，模型理论上可以「不听话」；实际靠 BASE_RULES 里那句「严格按设定说话，但不要自称在扮演」压住。

**群聊规则。** 默认 `groupRequireAt`：没 @ 不回。被 @ 一次开 60 秒窗口，窗口内最多 `groupAtReplyLimit`（3）条，被 @ 的那条也算 1 条。状态在内存（`GroupReplyWindow`），重启清零。目的很直白：不让机器人在群里刷屏。群记忆靠工作区里的 `群记忆.md`——每条消息前把文件内容（截最后 4000 字）拼在 payload 开头，于是全群所有成员的会话看到同一份记忆，不需要跨会话同步。

**表情包。** 素材是聊天里攒的，不随包分发。判据（`looksLikeSticker`）：`summary` 含「表情」、`sub_type=1`、gif、或 ≤384KB 的小 png/jpg/webp。对方发来的图顺手入库（按聊天分文件夹，每聊天最多 200 张），回复时按 `stickerChance`（0.4）挑一张补发。只给 agent 的真实回复配表情，「收到」「状态」「帮助」这类系统回话不配。

**主动消息（定时醒来）。** `wakeIntervalMinutes`（60）到点掷骰子，`wakeChance`（0.6）掷中就挑一个聊过天的私聊，用**它自己的会话**生成一句话发出去——不是固定模板，语气跟着人格走。一次只发一个对象，避免同时骚扰几个人。

**控制面 API。** 设置页是插件自带的同源 HTTP 路由，挂到宿主 `webServer` 上：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-qq-bridge/api/state` | 生效配置 + 运行态（连接数、会话、工作区、STT、表情包、主动消息） |
| POST | `/dsh-qq-bridge/api/settings` | 存设置（写 `settings-ui.json` + 立即应用） |
| POST | `/dsh-qq-bridge/api/transport/{pause,resume,restart}` | 暂停 / 恢复 / 重开 WS |
| GET | `/dsh-qq-bridge/api/napcat` | 走 WS 查 `get_login_info` |
| POST | `/dsh-qq-bridge/api/sessions/clear` | 清掉某个聊天的会话映射 |

三条安全与一致性规矩：只接受本机回环（`host` 必须是 127.0.0.1 / localhost / ::1），再过一遍宿主的信任栅栏 `ctx.connection.requestRejection`，栅栏不可用时 fail-closed；`accessToken` 只回 `hasAccessToken`，明文不出宿主；保存带 `baseMtimeMs` 冲突检测，文件在编辑期间被别处改过就 409，不静默覆盖。传输类字段（`mode/host/port/path/accessToken/url/reconnectMs`）改完自动重开 WS，其余立即生效。

**卸载不让宿主卡住。** 卸载钩子故意不 `await` 会话销毁：Session 销毁偶尔会长时间挂住，一 await 就把 HMR 的配置重载队列永久堵死（表现为「改了 `cordis.patch.yml` 毫无反应，只能重启应用」）。所以只发一个后台 Promise，尽力而为。

### 人设插件：只做编辑，不参与运行时

dsh-persona 是**设置页那一层**，读写的就是桥接那份 `personas.json`。它不 import 桥接的代码，也不在运行时注入任何东西——桥接每条消息自己重读文件，所以页面一保存，下一条 QQ 消息就是新人设，不用重启。

文件结构（也是两个插件之间唯一的事实契约）：

```
{
  version, note,
  default:    { title, prompt },              // 没单独配过的聊天兜底
  chats:      { "private:10001": { active, modes: { 模式名: 正文 } } },
  rules:      { 规则名: 正文 },                // 所有人格共用
  characters: { 角色名: { … } }                // 角色库，桥接不读
}
```

模式有两种写法，同一个 `modes` 里可以混用：

- 老格式：一整段字符串，原样注入。
- 新格式：三段式对象 `{ identity, behavior, replyStyle, variants[], variantChance }`，拼成 `你是谁：` / `什么时候开口：` / `说话方式：` 三段，空段跳过。

三段式不是强制重构，是为了**让「怎么说」可被程序读取**：语音脚本要从 `replyStyle` 抽语气，页面要能只改一段不碰另外两段。拼正文的格式必须和桥接的 `composeModeBody` 一字不差，否则页面预览和真实注入对不上——这是刻意的重复实现，`mode.js` 里写明了「改动时两边一起改」。

三件超出「编辑器」的事：

- **从互联网学角色**（`learn.js`）：萌娘百科 / 360 百科 / 360 搜索 / Bing，直连、不需要 key。抓页面 → 拼语料 → 用当前默认模型提炼成人设 + 一段可直接用的提示词。跑成后台任务（同时最多 2 个，结果留 30 分钟，可取消），结果**不自动落盘**，等用户在页面上确认。学出来的东西先按字段截断（`TEXT_LIMITS` / `LIST_LIMITS`），防止粘一大坨把文件撑爆。
- **老格式拆三段式**（`split.js`）：调一次模型，只输出一个 JSON。只在「模型把字段全填成空字符串」时重试一次，别的失败不重试。结果只回给页面，不落盘。注意这是「人格的拆分」，和桥接里「回复的切分」是两件不相干的事，名字撞了而已。
- **说话习惯**（`speech.js`）：监听宿主 `session/event` 的 `user/message`，只统计**长度、行数、标点数量**，不存原话（`speech-habits.json` 里只有数字）。攒够 8 条生成一段节奏提示，用户可以一键追加到某个模式。桥接/系统拼进来的提示词用 `looksLikeHumanMessage` 挡掉，不然统计的是自己的话。

写入规矩三条：先备份（`personas.json.bak-YYYYMMDD-HHMMSS`，最多留 20 份）→ 写临时文件再原子改名（避免写一半留下半个 JSON）→ `baseMtimeMs` 对不上就 409。

### 语音：按需拉起 + 空闲自关

Breeze 是本地 Vulkan 推理，代价是显存和启动时间。所以整条链路是**冷启动、用完就关**：

```
agent 写命令 → <DSH_HOME>/qq-bridge/bin/make-voice.ps1（转发脚本，带 BOM）
            → <语音包>/voice/scripts/make-voice.ps1
            → breeze-tts.ps1：先 /health，没起就拉起 breeze-server.exe
            → POST http://127.0.0.1:8137/v1/audio/speech
            → 拿到 mp3 → 桥接按扩展名识别成 record 段
```

几个决定：

- **桥接只知道一个路径**：`<DSH_HOME>/qq-bridge/bin/make-voice.ps1`（可用 `QB_VOICE_BIN` 覆盖）。这个文件是语音包 `install.ps1` 生成的**转发壳**，把参数转给包里的真脚本。所以语音包挪目录只影响这个壳，桥接不用改。转发壳里含中文路径，必须 UTF-8 **带 BOM** 写。
- **按需拉起**：`breeze-tts.ps1` 先打 `/health`。进程在但模型不对（q4 ↔ q8）就先停再起；进程在但还没健康，给它 `startupTimeoutSeconds`（120）的同一份预算。`state.json` 记 `pid` / `model` / `port`，坏了一律回退默认值。
- **空闲自关**：`breeze-janitor.ps1` 每 60 秒看一次 `last-activity.txt`，超过 `idleExitMinutes`（10）分钟没有请求就杀进程、删 `state.json`、自己退出。8137 上有 `Established` 连接时算「忙」——有人开着网页工作室就不关。下次请求由 `breeze-tts.ps1` 重新拉起来，`Ensure-Janitor` 顺手重启看门狗。
- **接口按 OpenAI 兼容形状**：`{model:'tts-1', input, response_format:'mp3', instructions, cfg_scale, seed:42, voice?}`。好处是第三方客户端能直接对着 8137 说话；坏处是 `seed` 写死 42，靠 `cfg_scale` 和 `instructions` 控制表现。
- **输出校验**：返回体 < 2048 字节当失败（服务起不来时常返回一段 JSON 错误页），先写 `.tmp` 再改名，不留下半截 mp3。
- **人设决定嗓音**：`-Persona "<当前性格模式>"` 会去 `personas.json` 找那个模式，取 `replyStyle`（老格式则退回整段正文）用 `voice-personas.json` 里的正则表抽语气词，拼在固定 `base` 后面。有存好的 `.breeze` 音色就固定用那把嗓子，没有就每次按描述现场设计（音色会飘）。
- **降级路径**：`make-voice.ps1` 的 `-Engine auto` 是先本地 Breeze，失败退 edge-tts（云端），再退 Windows 本地语音。三级阶梯是显式的，因为本地方案要下 2.4G 模型——没下完时宁可退到云端，也不要直接报错让 agent 卡在那。
- **网页工作室**（`voice/studio/server.js`，127.0.0.1:8140）只做两件事：`/api/*` 反向代理到 8137（`ECONNREFUSED` 就拉起服务再重试一次，请求体已经缓冲好了），`/admin/*` 管音色与人设映射。删音色不 `unlink`，挪进 `voice/voices-deleted/<时间戳>/`，误删能捞回来。

### 记忆：为什么分三层

一层装不下。全塞一起要么每轮被淹没，要么漏掉真正要紧的。dsh-mnemon 的默认「分层策略」是：

| 层 | 存什么 | 怎么进上下文 | 成本 |
|---|---|---|---|
| 运行时记忆（热） | 身份、偏好、协作约定、下一轮就要用的事实 | 每轮注入紧凑的 `USER.md` / `MEMORY.md` | 常驻 token，有硬上限（10KB / 4KB） |
| 项目档案（Documents） | 设计、调查、流程、交接这类成篇知识 | 先检索，相关才读全文 | 检索一次 + 按需读 |
| 记忆空间（Memory Space） | 长期事实、决策、实体与关系 | 按需从 Provider 召回 | 一次召回 |

取舍点：

- **热记忆必须小。** 每轮都付 token，所以给了硬上限；超了不是报错丢数据，而是先做容量整理（能外移的归档进记忆空间），实在没地方放就落本地 `runtime\archived\`。
- **成篇的东西不该常驻。** 一份设计文档塞进热记忆等于每轮为它付费，所以走「先搜后读」。
- **零散事实需要地方攒。** 这就是记忆空间，由 Provider 承载；Provider 可换（默认 Mnemon Native 本地，另有 8 个可选，需要远程服务或 key，配置前一律关）。
- **`MEMORY.md` / `USER.md` 是投影，不是数据。** 真正的数据是 `.mnemon\runtime\memories.json`。所以写热记忆只能走工具，手改文件会被下一次投影覆盖。
- **架构上 Source / Strategy / Core 三分。** Source 拥有记忆和操作，Strategy 决定这一轮哪些常驻、哪些可检索、用什么预算，Core 校验成这一轮唯一的不可变 VIEW。宿主把 VIEW 钉在这一轮上——于是「记忆」和「人格」是两条互不干扰的注入路径：人格走桥接的 user 消息，记忆走宿主的 VIEW。
- 对桥接来说这是**透明**的：插件只是把消息 `followup` 进同一个会话，记忆自动生效。这也是为什么 01 里搜不到一个 `mnemon` 字样。

## 四条硬约束

这四条不是建议，是踩出来的。

### 1. 同一个 QQ 号只能有一个 QQ NT 会话在线

NapCat 本质是另起一个 headless QQ NT 实例，登录后对服务器就是「新设备」，和桌面 QQ 抢同一个会话位。**同号就是互踢，多开、换目录、装两份 NapCat 都不解决。**

后果链条：桌面 QQ 登了 → NapCat 被踢 → 看门狗每分钟把它拉起来 → 又被踢。看起来像「反复互踢」，其实是死循环。

正确做法只有两条：机器人用独立小号（首选）；或者二选一，用 NapCat 时托盘退出桌面 QQ 并禁用其自启，还**必须** `Disable-ScheduledTask -TaskName 'DSH-NapCat-Watchdog'`，否则看门狗会一直把它拉回来。手机 QQ 不受影响（不同设备类型）。就算分了号，NapCat 也必须独立目录，别和桌面 QQ 共用 `Tencent Files`——QQ 运行时锁文件。

### 2. 插件改动要重启或重载才生效，但人格文件不用

分清哪些东西是「模块加载时读一次」、哪些是「每次用都读」：

| 改什么 | 生效方式 |
|---|---|
| 传输层字段（`mode/host/port/path/accessToken/url/reconnectMs`） | 设置页保存即重开 WS |
| 主动消息参数 | 保存即重排定时器 |
| `personas.json` / `features.json` | 每条消息重读，下一条消息生效 |
| 插件代码 / `cordis.patch.yml` | 重启 DSH，或靠 HMR 重载（`cordis.patch.yml` 在监听目录里） |
| 装插件本身 | 必须重启 DSH |

装法只有一种是对的：`npm pack` 出 tgz 再装。**从本地文件夹装必挂**——pnpm 遇到本地目录写成 `link:` 且不装依赖，插件的 bare import（比如 `ws`）找不到，插件页只显示 `failed to import`，设置里连页面都看不到。四个包都吃这条。

### 3. Windows PowerShell 5.1 的编码

- `powershell -File x.ps1` 对**没有 BOM** 的文件按 ANSI（中文系统上是 GBK）解析。带中文注释的脚本会报「缺少右括号」之类，报错行号还乱飘。所以含中文的 `.ps1` 必须 UTF-8 **带 BOM**；纯 ASCII 的不需要（`breeze-tts.ps1` 就是全英文写成，注释里写明了原因）。
- 反过来，PS 5.1 的 `Get-Content` / `Set-Content` 默认按 GBK 读写。拿它们绕一圈改 UTF-8 源码 = 不可逆乱码。改文本只走能显式指定编码的 API 或编辑器。
- 生成给别人的脚本（比如语音包给桥接写的 `make-voice.ps1` 转发壳）含中文路径，写的时候就必须用 `UTF8Encoding($true)`。
- 中文参数传给子进程会掉编码：语音工作室的 `server.js` 解析人设名时，先 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，再把中文名通过环境变量传进去，避开命令行码页。

### 4. 本地模型、显存、端口

- 8137 只能有一个 Breeze 实例，`Ensure-Server` 靠 `/health` + `state.json` 判断该复用还是该换。
- 8140 起不来时（`EADDRINUSE`）工作室直接 `exit 0`——「已经有一个在跑」不算错误。
- 3002 只能有一个 OneBot 服务端。旧版本桥接、别的 OneBot 框架（LLOneBot、Lagrange、旧版 NapCat）同时在抢就会 `EADDRINUSE`。
- 3003 被占，NapCat 会 `listen EADDRINUSE`；6099（WebUI）被占会自动往上找空口，**以日志里的 URL 为准**，别死记端口号。
- 显存是真实约束：8G 显存档上 Q4 约 2.9G、Q8 约 3.8G；冷启动 7 秒（首次编译着色器约 35 秒），首音约 110ms。所以才有空闲 10 分钟自动关——不关就等于常驻占着一张卡的显存。

## 接口、端口、文件位置

端口：

| 端口 | 谁在听 | 干什么 | 必需 |
|---|---|---|---|
| 3002 | dsh-qq-bridge 插件 | OneBot v11 反向 WS（`mode=server`） | 是 |
| 3003 | NapCat | HTTP 旁路，`get_login_info` 等 | 否（诊断用） |
| 6099 | NapCat | WebUI（改 OneBot 配置），被占会自动上移 | 否 |
| 8137 | breeze-server.exe | TTS 推理，只绑 127.0.0.1，无鉴权 | 发语音时是 |
| 8140 | voice/studio/server.js | 网页工作室（代理 8137 + 管理音色） | 否 |

插件对外接口：

| 类型 | 名字 | 说明 |
|---|---|---|
| HTTP | `/dsh-qq-bridge/api/*` | 见上文控制面表，只允许本机回环 |
| HTTP | `/dsh-persona/api/{personas,speech,split,learn}` | 人设页，同样只允许本机回环 |
| HTTP | `/v1/audio/speech`、`/health`、`/v1/voices/*` | Breeze 服务 |
| HTTP | `/api/*`、`/admin/*` | 网页工作室（代理 + 音色管理） |
| OneBot action | `send_msg`、`get_record`、`get_login_info`、`get_stranger_info`、`get_group_info`、`get_group_member_info` | 插件用到的全部 OneBot 面 |
| 脚本契约 | `<DSH_HOME>/qq-bridge/bin/make-voice.ps1` | 桥接发语音的唯一入口 |
| 文件契约 | `<DSH_HOME>/qq-bridge/personas.json` | 桥接读、人设页写 |

`<DSH_HOME>`（默认 `%USERPROFILE%\.dsh`，可用环境变量改）的布局：

```
<DSH_HOME>/
  qq-bridge/                        桥接与人设的私人数据
    personas.json                   人格（桥接读，人设页写）
    features.json                   按会话的功能开关（修图等）
    sessions.json                   聊天 → DSH 会话映射
    settings-ui.json                设置页覆盖层（含 accessToken 明文）
    qq-names.json                   昵称/群名缓存
    bridge-runtime.json             运行态快照（当前跑的是哪版、什么配置）
    bridge-client-probe.json        自检：设置页前端有没有被宿主登记
    resume-debug.log                会话恢复失败的可查证据
    qq-bridge-debug.log             入站/语音识别调试日志（默认不写）
    stickers/<private-号|group-号>/  表情包库，按聊天分文件夹
    bin/make-voice.ps1              语音包生成的转发壳（带 BOM）
    breeze-tts.json                 TTS 运行配置（端口、模型档、空闲分钟数…）
    voice-personas.json             人设 → 嗓音 映射
    voice/breeze-voices/*.breeze    已保存的固定音色
    speech-habits.json              说话习惯统计（只有数字，没有原话）
  qq-workspaces/                    桥接默认工作区根（可用 workspaceRoot 改）
    <private-号|group-号>/          每个聊天一个工作区（群聊按群号共用）
      attachments/                  图片/语音下载缓存（超过 mediaRetentionDays 清理）
      edited/                       修图产物
      群记忆.md                     群聊共享记忆，全群一份
  profiles/<profile>/node_modules/  插件装在这里（dsh-qq-bridge 等）
  dsh-runtimes/                     宿主自带的 node / python 运行时
```

包内 `docs/qq-bridge.md` 的数据目录表把 `attachments\` 列在 `qq-bridge\` 下，但按代码它落在**工作区**：`downloadImages` / `transcribeVoices` 都用 `workspacePath`。以代码为准。

`.mnemon/`（`MNEMON_DATA_DIR` 可改）是另一套：

```
<USERPROFILE>/.mnemon/
  runtime/  memories.json（事实源）、MEMORY.md、USER.md（投影）、archived/
  documents/ index.json、active/（≤10MB）、archived/
  state/    machine.json（本机身份，不随备份走）
```

## 扩展点

### 加一个新的人格来源

先想清楚你要动哪一侧：

- **只想加新内容**：往 `personas.json` 里加。新聊天键、新模式、`rules`、`characters` 都是数据，桥接每条消息重读，不重启就生效。这是最省事的路。
- **想加一个「来源」而不是一段文字**（比如从另一个文件、另一个服务读人格）：收敛点只有一个——桥接的 `loadPersonaFile` / `resolvePersona` / `composePersonaText`。在 `resolvePersona` 里加查找顺序（现在是 `精确 chatKey → 发送者私聊键 → default`），或者在 `composePersonaText` 里加一段。注意两件事：注入文本有 `PERSONA_RULES_MAX_CHARS`（6000）的预算，且 `signature` 是 `JSON.stringify([persona, imgEdit])`，你往 persona 里加字段会改签名、触发一次 `[会话设定已更新]` 补偿注入——通常是你想要的。
- **想让设置页也能编辑它**：02 的接口只认 `chats` / `default` / `rules` / `characters` 这套形状，`normalizePersonas` 会保留不认识的顶层字段但不会渲染。所以要么把新来源塞进这四个桶，要么改 02 的页面。
- 已知限制：`characters`（角色库）**桥接不读**。「套用」是把角色正文复制成目标会话的一个模式，复制之后两边独立，改角色不会自动改已套用的模式。

### 换一个 TTS

桥接侧的耦合只有两处，改一处就够：

1. **约定路径与参数**：`<DSH_HOME>/qq-bridge/bin/make-voice.ps1` 接受 `-Text -Out [-Persona] [-Voice] [-Model] [-Cfg] [-Instruction]`，产出的文件扩展名必须在桥接的可发音列表里（mp3/wav/m4a/aac/ogg/flac/amr/silk）。只要满足这两条，桥接**不知道**你背后是 Breeze、edge-tts 还是别的。语音包的 `install.ps1` 就是靠生成一个转发壳来占住这个坑。
2. **改提示词**：调 TTS 的那段命令写在桥接的 `BASE_RULES` 里（含 `-Persona` 的用法）。参数变了就得同步改这里，否则 agent 会按老参数调用。

再加一条：**出口判定看扩展名**。`buildReplySegments` 只按 `SENDABLE_AUDIO_EXT` 决定发 `record` 段，所以新 TTS 的输出格式不要用列表外的扩展名。

网页工作室这一侧是可选的：`/api/*` 只是透明代理，换引擎就把代理指向新端口；`/admin/*` 里跟人设嗓音相关的部分（`voice-personas.json`、`voices-dir`）是 Breeze 特有的概念，换引擎时这套要么重写要么丢掉。

### 加一个新的记忆 Provider

dsh-mnemon 的 Provider 是独立包（现在随包 9 个），走 `dsh-mnemon-source-memory-spaces/provider-sdk`：

- 一个 Provider = 一个记忆空间的驱动：召回、写入、删除、图谱/枚举能力按后端能力各自声明。第三方 Provider 默认关闭，配置前不参与召回。
- 挂载点在 bundle 的 `cordis.patch.yml`：`mnemon-source-memory-spaces` 的 `config.providers` 是显式列表（`use` + `instanceId`），加一项就多一个可选 Provider。
- 更粗的扩展是换**主策略**（`default-three-tier` / `general` 之外还有 `auto-capture` / `light-context` / `scoped`）：策略决定哪些来源常驻、哪些可检索、什么预算，切换不需要迁移数据。
- 两条坑：这个 bundle patch 的 `insert` 块**不要**抄进 profile 的 `cordis.patch.yml`（重复 entry ID，设置页存不了，上游 issue #470）；profile 里只写顶层覆盖行。
- 加新记忆层要意识到：热记忆每轮付 token，动它等于动每一轮的上下文成本。

### 加一个新通道（不是 QQ）

桥接的三个可复用件是：OneBot 帧解析（`extractContent`）、会话与工作区映射（`openChat` / `ensureChat`）、出站切分（`buildReplySegments` / `splitChunks`）。新的 IM 进来，值得复用的是后两个——它们跟 QQ 无关，是「怎么把一段长回复变成像人发的几条消息」这件事本身。

## 未验证

以下几件事在这份文档里没有实测证据，标出来免得被当成结论：

- 换成 LLOneBot / Lagrange 等其他 OneBot v11 实现后，插件能否完全等价工作（代码只依赖 OneBot v11 语义，但没有实测记录）。
- `mode: client` 正向 WS 在真实网络条件下的重连稳定性（只有代码路径，没有对应实测文档）。
- 8 个第三方记忆 Provider 的实际召回质量；本仓库的分发包只带了依赖，没有 provider 的账号与服务。
- Q8 模型档在 8G 显存款上的长时间稳定性（包内文档只给了单次实测的启动与首音数据）。
