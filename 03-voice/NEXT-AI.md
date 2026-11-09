# 给下一个 AI 的交接说明（先读完再动手）

这是**语音模型 Breeze** 的分发包：Breeze TTS 2 的 C++ GGUF 版（v0.1.6，Windows x64 Vulkan，不是 PyTorch 版）+ 一套 PowerShell 脚本 + 一个自建的网页工作室。它只负责「本地把文字变成语音」，不包含 QQ 桥接（那是另一个包）。

数据流和端口：

```
调用方（QQ 桥接 / 你自己）
   └→ voice\scripts\make-voice.ps1        （外壳：先本地 Breeze，失败退 edge-tts，再失败退 Windows SAPI）
        └→ voice\scripts\breeze-tts.ps1   （入口：按需拉起服务、拼请求、落 mp3）
             └→ breeze-server.exe  ← 127.0.0.1:8137（HTTP，OpenAI 风格 /v1/audio/speech、/v1/voices）
                                      ← 127.0.0.1:8138（voice-conversion 的 WebSocket，一般用不到）

网页工作室（浏览器）──→ Node server.js 127.0.0.1:8140 ──代理 /api/*──→ 8137
                                              └──/admin/* 直接改本机配置和音色文件
```

| 端口 | 谁在听 | 说明 |
|---|---|---|
| 8137 | `breeze-server.exe` | TTS/克隆 API。只绑 127.0.0.1，**没有鉴权**，别绑 0.0.0.0 |
| 8138 | `breeze-server.exe` | WebSocket（健康检查里会报 `ws_port`），调音色转换才用 |
| 8140 | `node server.js` | 工作室页面 + `/api` 代理 + `/admin` 本机管理接口 |

已完成状态：包根有 `install.ps1`、`NEXT-AI.md`、`README.md`、`docs\`、`engine\`（程序本体 zip）、`voice\`（脚本/工作室/配置示例/图标），以及快捷方式三件套 `Breeze 语音.lnk`、`打开语音工作室.cmd`、`创建桌面快捷方式.cmd`。**模型权重不在包里**。

---

## 一、安装顺序（别跳步，每步都有期望输出）

> 下面的 `<包>` 指解压后的包目录，`<DSH_HOME>` 指 DSH 主目录（`$env:DSH_HOME`，没有就是 `%USERPROFILE%\.dsh`）。包里所有脚本都用相对定位（`$PSScriptRoot` 往上找 `voice-paths.json`），不写死盘符。

**第 0 步：确认前置条件**

```powershell
# PowerShell 5.1（不是 7 也没关系，本包就是照着 5.1 写的）
$PSVersionTable.PSVersion.Major          # 期望 5（或更高）
Get-Command curl.exe | Select-Object Source   # 期望 Windows\System32\curl.exe（Win10 1803+ 自带）
Get-Command ffmpeg                        # 期望能解析到；没有就装一个（克隆参考音频要用）
```

有 Node 就用本机 Node（`Get-Command node`）；没有也没关系，`voice-paths.json` 里可以写 DSH 自带的 node 绝对路径。**DSH 的 node/python 不在 PATH 里是常态**，`install.ps1` 会自动把 `~\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe` 探测出来写进配置。

**第 1 步：跑安装器（落位 + 解压程序本体 + 写配置）**

```powershell
cd <包>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

期望看到 6 行进度，重点三条：

- `[1/6] 解压程序本体（约 230MB…）` → `OK  <包>\engine-runtime\breeze-tts-2-v0.1.6-windows-x64-vulkan\breeze-server.exe`
- `[2/6] 写好 voice-paths.json`，并打印 `voiceRoot = <包>\engine-runtime`
- `[5/6] 生成桥接转发脚本 → <DSH_HOME>\qq-bridge\bin\make-voice.ps1`

可选参数：`-VoiceRoot D:\tools\breeze-tts`（程序+模型换盘）、`-DshHome D:\dsh-home`、`-SkipEngine`（只写配置不解压）、`-NoShortcut`（不建桌面快捷方式）。**可以重复跑**：已有配置打印「保留不动」，只有程序本体缺失才会解压。

**第 2 步：下模型（不进包，必须单独下）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\voice\scripts\_setup\Get-Models.ps1
# 只要 q8 音质档：-Which q8；两个都要：-Which both
# 直连 HuggingFace 不通：-Proxy http://127.0.0.1:10808
# 想自己定并发数：-Chunks 8（默认 4）
```

期望结尾：`[q4] 完成` 和 `模型就绪`。下完目录里应该有两个文件之一：

| 文件 | 字节数 | sha256 |
|---|---|---|
| `breeze-tts-2-q4_k.gguf`（2.4G，默认） | 2538909376 | `483418fbbb438f5f1c08dbe2b017e42db0f1d126765cd3f772d8622a30a4915c` |
| `breeze-tts-2-q8_0.gguf`（3.4G，可选） | 3568844480 | `a02bcc4b69b0601032727f8040c4942149b1b73aa0f69022fe5aaa6a8f0ef879` |

模型放在 `voiceRoot` 根下（和 `breeze-tts-2-v0.1.6-windows-x64-vulkan\` 同级）。断了就重跑同一个命令：分片文件会保留，`Get-Chunked.ps1` 从头补、`Finish-Chunked.ps1` 只补每个分片剩下的尾巴（参数一样）。

**第 3 步：先单独跑通语音（这一步不过，别碰后面）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\voice\scripts\breeze-tts.ps1 -Status
# 期望：health=True pid=<数字> model=q4   （第一次跑 pid 可能是 -，再跑一次就有）

# 出一句话到文件（文本走 UTF-8 文件，别塞命令行）
$t = "$env:TEMP\line.txt"; [IO.File]::WriteAllText($t, '你好，这是测试。', (New-Object Text.UTF8Encoding($false)))
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\voice\scripts\breeze-tts.ps1 -TextFile $t -Out "$env:TEMP\a.mp3"
# 期望：OK <path> (engine=breeze model=q4 bytes=xxxxx)，mp3 能放
```

**第 4 步：打开网页工作室**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <包>\voice\scripts\breeze-webui.ps1
# 或者双击桌面快捷方式「Breeze 语音」
```

期望：浏览器起在 `http://127.0.0.1:8140/`，页面上有一排声音胶囊（设计 / 人设 / 克隆三类）。**首次打开会等 7~15 秒**（Node 代理发现 8137 没起，会去拉服务），这是正常行为。

**第 5 步（可选）：接 QQ 语音**

先装「包 1：QQ 桥接与 NapCat」。桥接在 `<DSH_HOME>\qq-bridge\bin\make-voice.ps1` 找转发脚本，第 1 步已经生成了，它会转发到本包的 `make-voice.ps1`。桥接调用带 `-Persona "<性格模式名>"` 时，本包按 `voice-personas.json` 自动选嗓子。

**第 6 步：跑第六节的自检清单**，全绿再交付。

---

## 二、三条铁律（违反会浪费你半天）

**铁律 1：带中文的 `.ps1` 必须是 UTF-8 带 BOM。**
PowerShell 5.1 用 `-File` 启动时按 ANSI(GBK) 解析无 BOM 的文件。中文注释/字符串会把语法吃坏，报「缺少括号 / 字符串未结束」，而且**报错行号乱飘**，看着像别处的错。`read`/`edit`/`write` 类工具改完会把 BOM 去掉，改完必须补：

```powershell
# 补 BOM
$p = '<脚本>'; $b = [IO.File]::ReadAllBytes($p)
if (-not ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) {
  [IO.File]::WriteAllBytes($p, [byte[]]([byte[]](0xEF,0xBB,0xBF) + $b))
}
# 验语法（期望 0）和 BOM（期望 True）
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$null,[ref]$e); $e.Count
$b=[IO.File]::ReadAllBytes($p); ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
```

纯 ASCII 的脚本不用 BOM（本包的 `make-voice.ps1`、`Get-Chunked.ps1`、`Finish-Chunked.ps1` 是纯 ASCII 才敢不带）。

**铁律 2：永远不要用 `Get-Content` / `Set-Content` 回写 UTF-8 源码。**
PS 5.1 读文件按当前代码页（中文系统 = GBK），写回时又把 UTF-8 当 GBK 编码，整份源码不可逆乱码，中文全变 `锟斤拷`。这个项目真的这么毁过一份 170KB 的插件源码。改文本只用 `read`/`edit`/`write` 工具，或用 Node / Python 显式 UTF-8 读写。**读**文件用 `-Encoding UTF8` 可以（只读不回写）。

**铁律 3：拉常驻后台进程不能用 `Start-Process -RedirectStandardOutput`。**
子进程会继承父进程所有可继承句柄，把调用方（Node 的 `execFileSync`、PowerShell 的 `| Out-String`）的 stdout 管道一直吊着，命令永远不返回，看起来像「卡死」。正确做法是 `WScript.Shell.Run`：

```powershell
$ws = New-Object -ComObject WScript.Shell
$null = $ws.Run('cmd.exe /c "' + $exe + '" ' + $argLine + ' > "' + $log + '" 2> "' + $err + '"', 0, $false)
```

包里的 `breeze-tts.ps1`（起服务）、`breeze-webui.ps1`（起工作室）、`breeze-tts.ps1` 里的 `Ensure-Janitor`（起看门狗）都用这个写法，别改回去。

---

## 三、坑清单（现象 → 原因 → 怎么办）

### A. Windows / PowerShell

**A1 变量名大小写不敏感，`$Cfg` 和 `$cfg` 是同一个变量。**
现象：跑 `breeze-tts.ps1 -Cfg 2` 报 `Cannot convert OrderedDictionary to Double`。
原因：`param([double]$Cfg)` 之后又写了 `$cfg = Get-Conf`，把配置对象塞进了 `[double]` 变量。
怎么办：配置对象一律命名 `$conf` / `$VP`（包里已经是这样）。写新脚本时记住这条。

**A2 `HttpListener` 需要 URL ACL，非管理员绑 `127.0.0.1` 也可能失败。**
现象：PowerShell 起网页服务报 `拒绝访问 (5)` / `Access is denied`。
原因：`netsh http add urlacl` 没配，非管理员不行。
怎么办：**别用 HttpListener**。本包的页面服务是 Node 的 `http` 模块（`voice\studio\server.js`），Node 绑 127.0.0.1 不需要 URL 预留。要加新接口就改 `server.js`。

**A3 Node 抓 PowerShell 输出会乱码。**
现象：`/admin/persona` 拿回来是 `voiceId= instruction=锟斤拷`，或者中文人设名解析成乱码。
原因：子进程输出到管道时用 OEM 代码页（936/GBK），Node 按 UTF-8 解。
怎么办：命令里先强制 UTF-8，中文参数走环境变量传：

```javascript
execFileSync('powershell.exe',
  ['-NoProfile','-ExecutionPolicy','Bypass','-Command',
   "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '<脚本>' -Persona $env:BREEZE_PERSONA -ShowVoice"],
  { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { BREEZE_PERSONA: name }) })
```

**A4 路径里有中文（`C:\Users\…\插件\`）时，命令行拼字符串容易踩编码。**
现象：`-File '<路径>'` 找不到文件 / 参数被截断。
原因：PS 5.1 命令行按命令行代码页传参。
怎么办：包里所有脚本都用 `$PSScriptRoot` 相对定位，不要硬编码中文路径；必须传路径时用变量传递，或写成 UTF-8 文件再读。

**A5 落盘一律用 .NET，别用 `Out-File` / `Set-Content`。**
现象：写出来的 JSON/文本带 BOM 或 CRLF 差异，下游 `ConvertFrom-Json` 报「意外的字符」。
怎么办：

```powershell
[IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding($false)))   # UTF-8 无 BOM
[IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding($true)))    # UTF-8 带 BOM（.ps1 用）
```

**A6 控制台里中文乱码不代表数据坏了。**
先 `Get-Content -Raw -Encoding UTF8` 读一遍，或 `chcp 65001` 再看。`Invoke-WebRequest` 遇到没写 charset 的 JSON 会按 Latin-1 解，看接口返回用 `curl.exe` 落盘再读。

### B. 模型 / 显存 / 速度 / 下载 / 许可

**B1 别装官方 PyTorch 版。**
现象：按官方说明装，要么要 Linux，要么 8G 显存直接 OOM。
原因：官方 PyTorch 版约 7.7G 显存（推荐 12G）。
怎么办：用 C++ GGUF 版。本包是 `HoppouAI/Breeze-TTS-2.cpp` v0.1.6 Windows x64 Vulkan（不依赖 CUDA 工具链，A 卡/N 卡都能跑）；同类的还有 `0xShug0/audio.cpp`。引擎 zip 里除了 `breeze-server.exe` 还有 `breeze-cli.exe`（命令行合成）、`breeze-convert.exe`、`breeze-quantize.exe`（自己转 GGUF），以及 `docs\`、`LICENSE`。

**B2 显存占用（RTX 5060 Laptop 8G 实测）**
Q4_K 约 2.9G，Q8_0 约 3.8G。两个都放着不占显存（只有加载的那个占），默认 Q4，要音质再 `-Model q8`。8G 卡同时开游戏/浏览器再跑 Q8 会紧。

**B3 速度（同上机器）**
Q4 约 2.2 倍实时，首音 ~110ms；冷启动 7 秒（**第一次**要编译着色器，30 多秒，之后走缓存）；Q8 冷启动约 12 秒。换显卡/换驱动后第一次又会慢一次。

**B4 8137 只监听 127.0.0.1，而且没有鉴权。**
现象：想给局域网别的机器用，改 `--host 0.0.0.0` 后同网段谁都能调、谁都能克隆音色。
怎么办：**别改**。要远程用就套 SSH 隧道 / 反代加鉴权。`breeze-tts.ps1` 里 `--host 127.0.0.1` 是故意的。

**B5 按需拉起 + 空闲退出（省显存）**
`breeze-tts.ps1` 每次调用先看 `/health`，没起就拉起；起完顺便拉起 `_setup\breeze-janitor.ps1`。看门狗每 60 秒看一次 `run\last-activity.txt`，超过 `idleExitMinutes`（默认 10 分钟）没请求就杀服务再自己退出。
例外：**8137 上有 Established 连接时不杀**（有人开着页面/长连接在等）。调试时想让它一直活着就把 `idleExitMinutes` 调大。

**B6 服务器只认 WAV 做参考音频。**
现象：上传 mp3/m4a 存音色，报解码失败或存出一把怪嗓子。
原因：`/v1/voices` 的 `ref_audio` 只吃 WAV（24k 单声道最稳）。
怎么办：先转。工作室页面用 WebAudio 在前端转；命令行用 `breeze-save-voice.ps1`，它内部调 ffmpeg 转成 `run\voice-ref.wav` 再上传，你给 mp3 也行。

**B7 模型下载：直连不通、单连接被限速。**
现象：`Get-Models.ps1` 卡在 1MB/s，或者 HuggingFace 直接超时。
原因：HF 在国内常被墙；单 TCP 连接被限速（实测 ~1MB/s）。
怎么办：① 加代理 `-Proxy http://127.0.0.1:10808`（脚本会设 `HTTPS_PROXY`/`HTTP_PROXY`，已有环境变量就不覆盖）；② 分段并发，默认 4 路能上 10MB/s+，`-Chunks 8` 更快；③ 下完必须对 sha256（脚本自动对）；④ 断了别删分片，重跑 `Get-Models.ps1` 或 `Finish-Chunked.ps1` 接着补。
手工下也行（浏览器/IDM 都可以）：`https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q4_k.gguf`，放到位后自己 `Get-FileHash` 对一遍。

**B8 许可证：代码 Apache-2.0，模型权重非商用。**
权重是 BreezeBlue Research and Non-Commercial License：**自托管生成的音频不能用于商业发布/接商单**，个人玩随便。要商用得换权重或另买授权。分发这个包时引擎 zip 里的 `LICENSE`、`THIRD_PARTY_NOTICES.txt` 别删。

**B9 模型不进包。**
原因：q4 2.4G + q8 3.4G，加起来 6G，谁都不会为了个脚本下 6G。包里只有 `engine\breeze-tts-2-v0.1.6-windows-x64-vulkan.zip`（74MB，解压 230MB 程序本体）。模型靠 `Get-Models.ps1` 补，补到 `voiceRoot` 根目录，文件名必须**完全一致**（`breeze-tts-2-q4_k.gguf` / `breeze-tts-2-q8_0.gguf`），脚本按名字拼路径，不看配置文件。

### C. 音色与声音（最容易白忙的地方）

**C1 纯文字「设计」声音，每次都会重新捏一个。**
现象：同一个 `instruction`，两次跑出来音色不一样；调 API 反复试总觉得「不稳定」。
原因：设计模式是从描述采样出来的，没有固定种子记忆——这是模型行为，不是 bug。
怎么办：要稳定就存成 `.breeze` 音色，然后用 `voiceId`（配置里的 `voiceId` 字段，或 `breeze-tts.ps1 -Voice <id>`）。一个描述只能定「方向」，不能定「这一把嗓子」。

**C2 存音色 = 克隆。**
要一段**干净**参考音频（无底噪、无 BGM、单人、10~30 秒）+ 它的**逐字文稿**（一字不差，包括语气词）。参考音频不干净 = 克隆出来的嗓子带噪声/带混响。
固定「设计出来的声音」的正确姿势：先设计一版 → 生成一段话存 mp3 → 拿这段 mp3 当参考音频存成克隆 → 以后用 `voiceId` 指它。包里的 `breeze-build-persona-voices.ps1` 就是批量干这个的。

**C3 描述里写「句子短 / 别拖长音 / 语气懒」会把声音压平。**
现象：声音像机器人念稿，平平的，没有起伏。
原因：这些词会被模型当成韵律约束，去掉了自然停顿和重音。
怎么办：写「说话放松、不像念稿子、尾音轻轻往上扬、中间有自然停顿和换气」。这段经验来自 `voice-personas.example.json` 里 `traits` 的用法：**正向描述**有效，「负向禁止」容易压平。

**C4 `cfg_scale` 与语音事件**
1.0 最快也最平（默认）；2~3 才会真的触发 `[叹气]` `[咳嗽]` `[笑]` 这类语音事件，代价是慢约 25%。要事件就 2.0~2.5，别极限拉高（会失真）。`-Cfg 2`。

**C5 音色文件删除必须可恢复。**
现象：点错一个 ×，`.breeze` 没了，那把嗓子再也复制不出来（本项目的教训：误删过三把嗓子，只能靠旧 demo 录音重新克隆救回来）。
原因：`.breeze` 里存的是克隆向量，删了不可重建。
怎么办：**别 unlink**。`server.js` 的 `DELETE /admin/voice`、`DELETE /admin/persona` 会把文件 `rename` 到 `voicesDir` 同级的 `voices-deleted\<时间戳>\` 里，`voice-personas.json` 还会先写一份 `.bak-<时间戳>`。恢复就是把文件挪回 `voicesDir` 并把 `voiceId` 填回去。改这两个接口时别顺手改回 `unlinkSync`。

**C6 人设 → 音色的映射（`voice-personas.json`）**
位置：`<DSH_HOME>\qq-bridge\voice-personas.json`（`install.ps1` 只在不存在时放一份**示例**，示例里没有任何真实音色）。结构：

```json
{
  "defaults": { "base": "默认底子，没单独配的人设用这句" },
  "personas": {
    "<性格模式名>": {
      "base": "底子：性别、年龄、音色、说话方式",
      "voiceId": "存好的音色 id（有它就固定用这把嗓子）",
      "extra": "额外追加一句，例如：尾音轻轻上扬",
      "skipTraits": ["不想套用的语气词"],
      "hidden": true
    }
  },
  "traits": { "正则片段": "抽出来拼到 base 后面的语气词" }
}
```

运行逻辑（`breeze-tts.ps1` 的 `Get-PersonaInstruction`）：`base` 定底子 → 拿人设模式自己的 `replyStyle`（没有就 `behavior`+`identity`）去 `traits` 里正则匹配，最多取 3 条、去掉 `skipTraits` 里的 → 拼起来当 `instruction`；`voiceId` 存在且文件在，就固定用那把嗓子。
所以：**改人设文字，声音描述自动跟着变；`voiceId` 不变，音色就不会飘。**

**C7 人设是旧格式（字符串）时不能崩。**
现象：老 `personas.json` 里 `modes[name]` 是纯字符串，取 `.replyStyle` 得到 `$null`，直接退回默认嗓子/报错。
原因：人设插件有两个版本，旧版模式是字符串。
怎么办：代码要兼容——`if ($mode -is [string]) { $blob = [string]$mode }`。`breeze-tts.ps1` 已经这么处理了，改写时别丢。

**C8 音色 id 的命名有约束。**
只能是字母/数字/`_`/`-`，最长 64（服务端和 `breeze-save-voice.ps1` 都校验）。中文名当 id 会被拒。

### D. 网页工作室（8140）

**D1 页面在 8140，模型服务在 8137，两个是独立进程。**
页面挂了不代表模型挂了；页面能开但生成 502，八成是 8137 的事（`-Status` 看）。
反例：`breeze-webui.ps1` 发现 8140 已被占用就不再起新的（别人已经开着页面 = 直接用），这时改 `server.js` 不生效，要先把旧的 node 进程杀掉。

**D2 页面靠 `/admin/*` 接口改本机东西，没有鉴权。**
现有接口（都在 `server.js`）：`GET /admin/personas`（列人设）、`GET /admin/persona?name=`（解析该人设最终的 `instruction`/`voiceId`）、`DELETE /admin/persona?name=`（删映射 + 回收音色）、`GET/POST /admin/bridge`（读写 `breeze-tts.json`）、`DELETE /admin/voice?id=`（删音色）。全绑在 127.0.0.1 上，别暴露到外网/局域网。

**D3 页面里「设计」的声音存在浏览器 localStorage。**
换机器/清缓存就没了。要跨机器就存成音色（`.breeze` 在同级的 `voice\breeze-voices\`，拷走即可）。

**D4 服务睡了，页面不会干等——它会自己去拉。**
Node 代理收到 `ECONNREFUSED` 会同步调 `breeze-tts.ps1 -EnsureServer` 起服务，再重试一次同一个请求（body 已经缓冲过，不会丢）。第一次请求会等 7~15 秒，正常。等超过 30 秒还报 503，才是真起不来。

**D5 端口冲突先查「是不是已经有一份在跑」。**
现象：新装的包打开页面，看到的是另一套配置/音色。
原因：这台机器上可能已经有一份 Breeze 在跑（8137/8140 被占），新脚本会直接复用它。
怎么办：`Get-NetTCPConnection -LocalPort 8137,8140 -State Listen` 看是谁；旧的那份先 `breeze-tts.ps1 -Stop`（只停模型，不停页面）或手动结束 node，再起新的。

### E. 和 QQ 桥接的衔接（本包不含桥接）

**E1 桥接固定从 `<DSH_HOME>\qq-bridge\bin\make-voice.ps1` 调转发脚本。**
`install.ps1` 生成的就是这个转发壳（里面写死了本包的绝对路径 + UTF-8 BOM）。**包挪了目录、或换了机器解压位置，必须重跑一次 `install.ps1`**，否则转发壳指向旧路径，桥接会一直回「语音生成失败」。

**E2 桥接看到 `engine=windows-local` 就是退到 SAPI 了。**
`make-voice.ps1` 的顺序是：本地 Breeze → edge-tts（Python 需要装 `edge_tts`）→ Windows SAPI。机械音 = 前两级都失败。先修 Breeze（`-Status`），别急着调 SAPI 参数。

**E3 QQ 语音是 SILK，桥接靠扩展名判断。**
生成 `.mp3` 直接给桥接路径就行，转码交给 NapCat。别自己转 SILK。

**E4 提示词里要带 `-Persona "<当前性格模式>"`。**
不带的话永远用 `breeze-tts.json` 里的全局 `voiceId`/`instruction`，人设声音不生效。改提示词后要重启 DSH，插件模块有缓存。

### F. 分发 / 维护

**F1 本包里的 `voice-paths.json`、`engine-runtime\`、`run\`、`_persona\`、`*.part*`、`*.log`、`*.gguf` 都是安装/运行产物，打包时不能带。**
打 zip 前删干净（`voice-paths.json` 里全是本机绝对路径）。

**F2 模型权重永远不进包**，只放下载脚本和文档。要换模型地址就改 `Get-Models.ps1` 里的 `$models` 表（文件名/字节数/sha256 三个都要改）。

**F3 改完脚本必做三件事**：语法 0 错误、含中文的补 BOM、跑一遍 `-Status`。
命令见铁律 1。改 `server.js` 后 `node --check voice\studio\server.js`。

**F4 脱敏**：包里不许出现任何个人音色（`.breeze`）、个人录音（`*.mp3`/`*.wav`）、真实 `voice-personas.json`/`personas.json`、QQ 号、人名、本机绝对路径。人设声音只给 `voice-personas.example.json` 示例。

---

## 四、关键文件表

| 路径（相对包根） | 作用 |
|---|---|
| `install.ps1` | 一键落位：解压引擎到 `engine-runtime\`、写 `voice-paths.json`、首次生成运行配置/人设声音表、生成桥接转发脚本、建桌面快捷方式。幂等 |
| `Breeze 语音.lnk` | 桌面快捷方式模板：目标 = 同目录的 `打开语音工作室.cmd`，工作目录 = 示例解压路径 `D:\tools\breeze-tts-package`，图标 = `voice\icon\breeze-icon.ico`。**按示例路径生成的**，解压到别处就失效 |
| `打开语音工作室.cmd` | 用 `%~dp0` 相对定位，双击即开工作室（先 `breeze-webui.ps1` 再开 8140）。换机器/换目录都能用，不依赖 .lnk |
| `创建桌面快捷方式.cmd` | 双击跑 `install.ps1 -SkipEngine`，在本机桌面重新生成「Breeze 语音.lnk」（指向真实解压位置）；cmd 文件是 GBK 编码，别用 UTF-8 重存否则中文乱码 |
| `voice-paths.json`（**运行时生成**） | 全包路径总闸：`voiceRoot`/`voiceBinDir`/`configFile`/`voicesDir`/`studioDir`/`personaFile`/`voicePersonas`/`nodeExe`/`pythonExe`/`ffmpegExe`。所有脚本从自己目录往上找它，找不到就用各自的默认值 |
| `voice-paths.example.json` | 上面那份的示例（说明字段含义），不改程序也能看懂要填什么 |
| `engine\breeze-tts-2-v0.1.6-windows-x64-vulkan.zip` | 程序本体（74MB→解压 230MB）。`breeze-server.exe`（HTTP 服务）、`breeze-cli.exe`（命令行）、`breeze-convert.exe`、`breeze-quantize.exe`、`libbreeze.dll`、`docs\`、`LICENSE` |
| `voice\scripts\breeze-tts.ps1` | **语音总入口**：`-Status` `-Stop` `-EnsureServer` `-Text/-TextFile -Out` `-Persona` `-ShowVoice` `-DesignOnly` `-Model q4/q8` `-Voice <voiceId>` `-Cfg` `-Instruction`。按需拉起服务 + curl 落 mp3 |
| `voice\scripts\make-voice.ps1` | 桥接用的外壳：Breeze → edge-tts → SAPI 三级回退；`-Engine auto/breeze/edge/local` `-Voice` `-Rate` `-Pitch`。方言音色（东北话/粤语等）在 auto 下直接跳过本地引擎 |
| `voice\scripts\breeze-save-voice.ps1` | 存音色（克隆）：参考音频 + 逐字文稿 → ffmpeg 转 24k 单声道 WAV → `POST /v1/voices`；`-Name` `-Audio` `-TextFile` `-Description` `-SetDefault` |
| `voice\scripts\breeze-build-persona-voices.ps1` | 给 `voice-personas.json` 里每个人设批量「设计一版 → 存成 `.breeze` → 回写 voiceId」；`-Force` 重做 |
| `voice\scripts\breeze-webui.ps1` | 打开工作室：先 `-EnsureServer`，再起 `server.js`（8140），最后开浏览器 |
| `voice\scripts\_setup\Get-Models.ps1` | 下模型（q4/q8/both），带 sha256 校验、断点续传；`-Proxy` `-Chunks` `-VoiceRoot` |
| `voice\scripts\_setup\Get-Chunked.ps1` | 分段并发下载器（curl 多进程 + Range），下完拼接 + 校验 |
| `voice\scripts\_setup\Finish-Chunked.ps1` | 续传补充：只补每个分片剩下的尾巴，适合大文件断在 90% |
| `voice\scripts\_setup\breeze-janitor.ps1` | 空闲看门狗：60 秒一查，`idleExitMinutes` 没请求就杀服务；有 Established 连接不杀 |
| `voice\studio\server.js` | 页面服务（8140）+ `/api/*` 代理到 8137 + `/admin/*` 本机管理 + 音色删除回收 |
| `voice\studio\index.html` | 工作室单页：设计/人设/克隆三类声音胶囊、试听、存音色 |
| `voice\config\breeze-tts.example.json` | 运行配置模板（`install.ps1` 会填好三个路径字段后写到 `<DSH_HOME>\qq-bridge\`） |
| `voice\config\voice-personas.example.json` | 人设→声音映射示例（含 `traits` 语气词表） |
| `voice\icon\breeze-icon.ico` / `.png` | 桌面快捷方式 / 页面图标 |
| `docs\voice.md` | 给人看的语音系统说明（安装、配置、常用命令、性能、许可） |
| `README.md` | 短安装说明（5~8 步）+ 本包不含什么 |

运行时生成（不在包里）：`<包>\engine-runtime\`（程序 + 模型 + `run\` 日志/状态）、`<DSH_HOME>\qq-bridge\breeze-tts.json`、`<DSH_HOME>\qq-bridge\voice-personas.json`、`<DSH_HOME>\qq-bridge\voice\breeze-voices\`（`.breeze` 音色）、`<DSH_HOME>\qq-bridge\voice\voices-deleted\`（回收站）、`<DSH_HOME>\qq-bridge\bin\make-voice.ps1`（转发壳）。

---

## 五、自检清单（装完逐条跑，括号是期望输出）

```powershell
$包 = '<包>'; $DSH = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }

# 1) 全部 ps1 语法 0 错误
Get-ChildItem $包 -Recurse -File -Filter *.ps1 | ForEach-Object {
  $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$null,[ref]$e)
  '{0}  {1}' -f $e.Count, $_.Name
}          # 期望：每行开头都是 0

# 2) 含中文的 ps1 有 BOM
Get-ChildItem $包 -Recurse -File -Filter *.ps1 | ForEach-Object {
  $b=[IO.File]::ReadAllBytes($_.FullName)
  $bom = ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  $nonAscii = @($b | Where-Object { $_ -gt 127 }).Count -gt 0
  if ($nonAscii -and -not $bom) { "缺 BOM: $($_.FullName)" }
}          # 期望：无输出

# 3) 程序本体在
Test-Path "$包\engine-runtime\breeze-tts-2-v0.1.6-windows-x64-vulkan\breeze-server.exe"   # True

# 4) 模型在（大小对不对）
Get-Item "$包\engine-runtime\breeze-tts-2-q4_k.gguf" | Select-Object Name,Length        # Length=2538909376

# 5) 服务健康
powershell -NoProfile -ExecutionPolicy Bypass -File "$包\voice\scripts\breeze-tts.ps1" -Status
# 期望：health=True pid=<数字> model=q4

# 6) 人设声音解析（应打印 voiceId= 和 instruction=）
powershell -NoProfile -ExecutionPolicy Bypass -File "$包\voice\scripts\breeze-tts.ps1" -Persona "默认" -ShowVoice

# 7) 出声
$t="$env:TEMP\line.txt"; [IO.File]::WriteAllText($t,'测试一下。',(New-Object Text.UTF8Encoding($false)))
powershell -NoProfile -ExecutionPolicy Bypass -File "$包\voice\scripts\breeze-tts.ps1" -TextFile $t -Out "$env:TEMP\a.mp3"
# 期望：OK … (engine=breeze model=q4 bytes=…)

# 8) 页面（应 200，含"工作室"字样）
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8140/').StatusCode      # 200
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8137/health').Content  # {"status":"ok",...}

# 9) 桥接钩子（装了包 1 才有意义）
Test-Path (Join-Path $DSH 'qq-bridge\bin\make-voice.ps1')                    # True

# 10) 端口只在本机
Get-NetTCPConnection -LocalPort 8137,8140 -State Listen | Select-Object LocalAddress,LocalPort
# 期望：LocalAddress 都是 127.0.0.1
```

---

## 六、症状 → 排查

| 症状 | 先查什么 | 怎么办 |
|---|---|---|
| `-Status` 报 `model file missing` | 模型没下或名字不对 | 跑 `Get-Models.ps1`；文件名必须 `breeze-tts-2-q4_k.gguf` |
| `-Status` 报 `server binary missing` | `engine-runtime` 没解压 | 重跑 `install.ps1`（别加 `-SkipEngine`） |
| `-Status` 一直 `health=False`，pid 有数字 | 服务在起但起不来 | 看 `<包>\engine-runtime\run\server.err.log`；常见是显存不足/模型损坏（对 sha256） |
| 生成报 `FAIL server not reachable` | 8137 没起 | 先 `-Stop` 再跑一次；看 `server.err.log` |
| 生成报 `curl exit 7` / 超时 | 服务卡死（显存被别的程序占） | 关掉吃显存的程序，`-Stop` 后重试；`requestTimeoutSeconds` 默认 180 秒 |
| 生成出来是机械音 / `engine=windows-local` | Breeze 那级失败，退到 SAPI | 修 Breeze（`-Status` + 日志）；顺带看 Python 有没有 `edge_tts` |
| 每次音色都不一样 | 用的纯描述（C1） | 存成 `.breeze`，用 `voiceId` 固定 |
| 说话很平、像念稿 | 描述里有「句子短/别拖长音/语气懒」（C3），或 cfg=1 念长句 | 改成正向描述；要起伏就 `-Cfg 2` |
| 存音色报 400/415 | 参考音频不是 WAV 或太短 | 用 `breeze-save-voice.ps1`（内部转 WAV）；参考音频 10~30 秒、干净 |
| 页面打不开 8140 | node 没起 / 端口被占 | 手动跑 `breeze-webui.ps1`；`Get-NetTCPConnection -LocalPort 8140` 看是不是旧进程 |
| 页面能开，点生成 502 | 8137 断了，且自拉失败 | 看 `<包>\engine-runtime\run\server.err.log`；必要时 `-Stop` 重起 |
| 页面第一次请求等很久（7~15 秒） | 正常（D4，服务睡了在自拉） | 不用管；超 30 秒才查 |
| 页面是「别人的」配置/音色 | 这台机器上已经有一份在跑（D5） | 先停旧的再起新的 |
| 换机器/挪目录后语音全失败 | 转发壳/`voice-paths.json` 还是旧路径 | 删掉 `voice-paths.json` 重跑 `install.ps1` |
| 音色删了找不回 | 用了 `unlink`（C5） | 去 `<DSH_HOME>\qq-bridge\voice\voices-deleted\<时间戳>\` 找；没有就只能重新克隆 |
| 中文全变 `锟斤拷` | 用了 `Get-Content`/`Set-Content` 回写（铁律 2） | 从备份/原始包恢复，下次只用工具改 |
| 双击包里的 `Breeze 语音.lnk` 没反应 / 指向不存在的路径 | .lnk 按示例解压路径 `D:\tools\breeze-tts-package` 生成，解压位置不同就失效 | 双击 `打开语音工作室.cmd`（相对路径，任何位置都能用），或双击 `创建桌面快捷方式.cmd` 重建 |
| `创建桌面快捷方式.cmd` 里中文乱码 | 这个 cmd 是 GBK 编码，被 UTF-8 重存了 | 重新以 ANSI/GBK 保存；或直接跑 `powershell -File .\install.ps1` |
| 脚本报「缺少 }」但行号乱飘 | 缺 BOM（铁律 1） | 补 BOM 再跑 |
| 命令永远不返回 / 卡住 | 用了 `Start-Process -RedirectStandardOutput`（铁律 3） | 改 `WScript.Shell.Run` |

---

## 七、本包不含什么（以及怎么补齐）

| 不含 | 为什么 | 怎么补 |
|---|---|---|
| **模型权重**（q4 2.4G / q8 3.4G） | 太大，且许可单独 | `voice\scripts\_setup\Get-Models.ps1`（自动分段并发 + sha256），或按 `docs\voice.md` 的 HF 直链手下 |
| **任何个人音色 `.breeze`** | 脱敏红线 | 自己用工作室「克隆真人」存，或 `breeze-save-voice.ps1` |
| **任何录音**（`*.mp3`/`*.wav`，demo/回复音频） | 脱敏红线 | 自己录参考音频（干净、10~30 秒、配逐字文稿） |
| **真实 `voice-personas.json`** | 脱敏红线 | 只有 `voice\config\voice-personas.example.json` 示例；`install.ps1` 首次会复制一份到 `<DSH_HOME>\qq-bridge\`，自己填 `base`/`voiceId` |
| **真实 `personas.json` / 人设正文** | 属于人设插件（包 2） | 装包 2；本包只在 `-Persona` 时读它 |
| **QQ 桥接 / NapCat** | 属于包 1 | 装包 1，桥接才会调用本包的 `make-voice.ps1` |
| **程序本体已解压的 `engine-runtime\`** | 只带 74MB zip，解压后 230MB | `install.ps1` 第 1 步自动解压（可 `-VoiceRoot` 换位置） |
| **`voice-paths.json`** | 含本机绝对路径 | `install.ps1` 生成；模板见 `voice-paths.example.json` |

---

## 八、实测环境（数字都是这台机器跑出来的）

| 项 | 值 |
|---|---|
| 机器 | Windows 11，笔记本 |
| 显卡 | RTX 5060 Laptop，8G 显存 |
| 引擎 | Breeze-TTS-2.cpp v0.1.6，Windows x64 Vulkan（不用 CUDA） |
| Q4_K | 显存 ~2.9G，~2.2× 实时，首音 ~110ms，冷启动 7s（首次编译着色器 ~35s） |
| Q8_0 | 显存 ~3.8G，略慢一档，冷启动 ~12s |
| 模型下载 | 单连接 ~1MB/s，4 路并发 10MB/s+ |
| 端口 | 8137 TTS / 8138 WS / 8140 页面 |

换显卡后速度肯定不一样，显存和速度按「Q4 能跑、Q8 紧张」估就行。
