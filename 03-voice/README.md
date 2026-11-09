# 语音模型 Breeze（Breeze TTS 2 v0.1.6）

> **仓库版不带推理引擎。** `engine\` 下没有那个 74MB 的 zip，在 Releases 的 `3-voice-breeze-v0.1.6.zip` 里。要从仓库直接装，先把引擎 zip 放回 `engine\`，或者用 Releases 的包。

本地文字转语音：给一句话，出 mp3。纯本地跑，不联网（除了第一次下模型），Windows 10/11 64 位，N 卡 A 卡都行（Vulkan，不用装 CUDA）。

装完你会得到：

- 一个本地语音服务 `127.0.0.1:8137`（按需拉起，空闲 10 分钟自动关，省显存）
- 一个网页工作室 `127.0.0.1:8140`，桌面有快捷方式「Breeze 语音」：试听、设计声音、克隆真人声音、给人设锁音色
- 一套 PowerShell 脚本，QQ 桥接那边会自动调用（装了包 1 才有用）

## 前置条件

| 需要 | 说明 |
|---|---|
| Windows 10 1803+ / 11，64 位 | 命令行用自带 PowerShell 5.1 就行 |
| `curl.exe` | Win10 1803+ 自带（`Get-Command curl.exe` 能解析到即可） |
| `ffmpeg` | 克隆音色时要转 WAV。没有就 `winget install ffmpeg` 或自己装一个放 PATH |
| 显卡 | 实测 RTX 5060 Laptop 8G：Q4 档显存约 2.9G。集成显卡也能试着跑，很慢 |
| 磁盘 | 程序本体约 230MB + 模型 q4 2.4G（q8 3.4G 可选） |

## 安装（6 步）

**1. 解压这个包**（路径别太浅也行，含中文没问题），然后在该目录打开 PowerShell：

```powershell
cd <解压出来的目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

它会自动：解压程序本体到 `engine-runtime\`、写 `voice-paths.json`、生成运行配置、给 QQ 桥接放转发脚本、建桌面快捷方式「Breeze 语音」。**已有配置不会覆盖**，重复跑没事。

**2. 下模型**（不进包，必须自己下；直连可能不通，见下）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\voice\scripts\_setup\Get-Models.ps1
# 直连 HuggingFace 不通就加代理：
# powershell ... -File .\voice\scripts\_setup\Get-Models.ps1 -Proxy http://127.0.0.1:10808
```

q4 约 2.4G，脚本自动分段并发 + 校验 sha256；断了重跑会接着补。想要更高音质加 `-Which q8`（再 3.4G）。

**3. 看看服务能不能起来**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\voice\scripts\breeze-tts.ps1 -Status
```

期望：`health=True pid=<数字> model=q4`。第一次可能要等 7~10 秒（在加载模型）。

**4. 出一句话试试**：

```powershell
$t = "$env:TEMP\line.txt"; [IO.File]::WriteAllText($t,'你好，我是本地语音。',(New-Object Text.UTF8Encoding($false)))
powershell -NoProfile -ExecutionPolicy Bypass -File .\voice\scripts\breeze-tts.ps1 -TextFile $t -Out "$env:TEMP\a.mp3"
```

期望打印 `OK ... (engine=breeze model=q4 bytes=…)`，然后放 `%TEMP%\a.mp3` 听听。

**5. 打开工作室**：双击桌面「Breeze 语音」（或跑 `voice\scripts\breeze-webui.ps1`）。浏览器会开在 `http://127.0.0.1:8140/`，第一次等 7~15 秒是服务在自拉。

包根还带了三个快捷方式相关的文件：

- `Breeze 语音.lnk`：按示例解压路径 `D:\tools\breeze-tts-package` 做的模板。解压到这个路径就能直接双击；解压到别处它指不到，别硬双击。
- `打开语音工作室.cmd`：相对路径，解压到哪都能双击，直接开工作室。
- `创建桌面快捷方式.cmd`：双击跑一次 `install.ps1`，在桌面重新生成指向你本机位置的「Breeze 语音」。

**6. 想接 QQ 语音**：先装「包 1：QQ 桥接与 NapCat」，装完之后桥接会自动调用本包生成语音。本包自己不连 QQ。

## 第一次怎么验

```powershell
# 三行都应答 True / 200 / OK
Test-Path .\engine-runtime\breeze-tts-2-v0.1.6-windows-x64-vulkan\breeze-server.exe
powershell -File .\voice\scripts\breeze-tts.ps1 -Status
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8140/').StatusCode
```

出问题看同目录的 **`NEXT-AI.md`**，里面按 A/B/C/D 分了坑和「症状 → 排查」表，比这里细得多。

## 本包不含什么（重要）

- **不含任何个人音色**：没有 `.breeze` 音色文件、没有个人录音、没有 demo mp3。嗓子要自己录/自己设计（工作室里「克隆真人」或「设计」）。
- **不含真实的人设声音表**：只有 `voice\config\voice-personas.example.json` 示例，安装时复制一份空模板到 DSH 目录，自己填。
- **不含模型权重**：q4 2.4G / q8 3.4G 都是下载的，见上面第 2 步。
- **不含 QQ 桥接 / NapCat**：在另一个包里。
- **不含程序本体解压后的文件**：包里只有 `engine\` 那个 74MB zip，`install.ps1` 会解压。

## 许可证

推理代码 Apache-2.0；**模型权重是非商用研究许可**（BreezeBlue Research and Non-Commercial License）。自己用、给朋友听没问题，**别拿生成的音频去接商单或商业发布**。引擎 zip 里有 `LICENSE` 和 `THIRD_PARTY_NOTICES.txt`。

## 目录里都有什么

```
install.ps1                 一键落位（幂等）
NEXT-AI.md                  给下一个 AI 的避坑说明（最重要，出问题先看它）
Breeze 语音.lnk             快捷方式模板（按示例路径 D:\tools\breeze-tts-package 生成）
打开语音工作室.cmd           双击直接开工作室（相对路径，换位置也能用）
创建桌面快捷方式.cmd          双击跑 install.ps1，重建桌面「Breeze 语音」
docs\voice.md               语音系统详细说明（下载、配置、命令、性能）
engine\...zip               程序本体（74MB，解压后 230MB）
voice\scripts\              语音脚本（入口、克隆、人设批量锁音色、模型下载、看门狗）
voice\studio\               网页工作室（server.js + index.html）
voice\config\               运行配置示例、人设声音表示例
voice\icon\                 图标
```
