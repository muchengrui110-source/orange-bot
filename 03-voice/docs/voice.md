# 语音系统（Breeze TTS 2）安装与使用

## 1. 放什么、放哪

**程序本体随包给了**（`engine\breeze-tts-2-v0.1.6-windows-x64-vulkan.zip`，约 74MB，解压后约 230MB，Windows x64 Vulkan 版，不用装 CUDA）；**模型不进包**（q4 2.4G / q8 3.4G），用 `voice\scripts\_setup\Get-Models.ps1` 下。

包根跑一次 `install.ps1`，它会自动把程序本体解到 `<包>\engine-runtime\` 并生成 `voice-paths.json`。最终目录长这样：

```
<voiceRoot>\                                   ← 默认 <包>\engine-runtime，可用 -VoiceRoot 换盘
  breeze-tts-2-v0.1.6-windows-x64-vulkan\      ← 程序本体（breeze-server.exe 在这里）
  breeze-tts-2-q4_k.gguf                       ← 2.4G，默认用这个
  breeze-tts-2-q8_0.gguf                       ← 3.4G，音质档（可选）
  run\                                         ← 运行日志、状态、看门狗 pid、请求临时文件
```

手工解压也行：

```powershell
$root = '<包>\engine-runtime'
New-Item -ItemType Directory -Path $root -Force | Out-Null
Expand-Archive -Path .\engine\breeze-tts-2-v0.1.6-windows-x64-vulkan.zip -DestinationPath $root -Force
```

下模型（自动分段并发 + SHA256 校验，断了重跑会接着补）：

```powershell
powershell -File .\voice\scripts\_setup\Get-Models.ps1                 # 只下 q4
powershell -File .\voice\scripts\_setup\Get-Models.ps1 -Which both     # q4 + q8
powershell -File .\voice\scripts\_setup\Get-Models.ps1 -Proxy http://127.0.0.1:10808
powershell -File .\voice\scripts\_setup\Get-Models.ps1 -VoiceRoot D:\tools\breeze-tts   # 换盘
```

默认放到 `voice-paths.json` 里 `voiceRoot` 指的目录。直连 HuggingFace 一般连不上，需要代理；单连接会被限速到 ~1MB/s，脚本默认 4 路并发。

手工下载也行（HuggingFace，可能需要代理）：

```
https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q4_k.gguf   （2,538,909,376 字节）
https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q8_0.gguf   （3,568,844,480 字节）
```

下完自己核对 sha256：

| 文件 | sha256 |
|---|---|
| `breeze-tts-2-q4_k.gguf` | `483418fbbb438f5f1c08dbe2b017e42db0f1d126765cd3f772d8622a30a4915c` |
| `breeze-tts-2-q8_0.gguf` | `a02bcc4b69b0601032727f8040c4942149b1b73aa0f69022fe5aaa6a8f0ef879` |

直连慢是常态。用包里的分段并发下载：

```powershell
powershell -File voice\scripts\_setup\Get-Chunked.ps1 `
  -Url "https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q4_k.gguf" `
  -Out "<voiceRoot>\breeze-tts-2-q4_k.gguf" `
  -Size 2538909376 -Sha256 483418fbbb438f5f1c08dbe2b017e42db0f1d126765cd3f772d8622a30a4915c `
  -Chunks 4
```

下到一半断了就用 `Finish-Chunked.ps1`（同样参数）接着补，它只补每个分片剩下的尾巴。

## 2. 配置

`<包根>\voice-paths.json` 管所有路径（`install.ps1` 生成，模板见 `voice\voice-paths.example.json`）；`<DSH_HOME>\qq-bridge\breeze-tts.json` 是运行配置（首次由 `voice\config\breeze-tts.example.json` 生成）：

| 字段 | 说明 |
|---|---|
| `port` | 服务端口，默认 8137（只绑 127.0.0.1，无鉴权） |
| `model` | `q4` 或 `q8` |
| `instruction` | 没有固定音色时，用这句话现场设计声音（每次都会重新捏） |
| `voiceId` | 固定音色 id（`voicesDir\<id>.breeze`）；空 = 用 instruction |
| `cfgScale` | 1.0 最快最平；2~3 才触发 `[叹气]` 之类事件 |
| `idleExitMinutes` | 空闲多久自动关服务（省显存），默认 10 |
| `startupTimeoutSeconds` / `requestTimeoutSeconds` | 起服务 / 单次请求的超时预算 |
| `enabled` | 关掉就整体退回旧方案 |

人设 → 声音的映射另有一份：`<DSH_HOME>\qq-bridge\voice-personas.json`（`install.ps1` 首次只放示例，见 `voice\config\voice-personas.example.json`）。

## 3. 常用命令

所有脚本在 `<包>\voice\scripts\` 下。

```powershell
# 看状态 / 停服务
powershell -File voice\scripts\breeze-tts.ps1 -Status
powershell -File voice\scripts\breeze-tts.ps1 -Stop

# 生成一句话到文件
$t = "$env:TEMP\line.txt"; [IO.File]::WriteAllText($t,'你好，这是测试。',(New-Object Text.UTF8Encoding($false)))
powershell -File voice\scripts\breeze-tts.ps1 -TextFile $t -Out "$env:TEMP\a.mp3"

# 用某个人设的声音（Persona 名字要和 personas.json 里的模式名一致）
powershell -File voice\scripts\breeze-tts.ps1 -TextFile $t -Out "$env:TEMP\b.mp3" -Persona "默认" -ShowVoice

# 存一个音色（参考录音 + 逐字文稿，格式随便，脚本会转 WAV）
powershell -File voice\scripts\breeze-save-voice.ps1 -Name my_voice -Audio ref.mp3 -TextFile ref.txt

# 给每个人设批量锁定音色（生成一版设计 → 存成 .breeze → 回写 voice-personas.json）
powershell -File voice\scripts\breeze-build-persona-voices.ps1
```

## 4. 网页工作室

桌面快捷方式「Breeze 语音」，或 `http://127.0.0.1:8140/`。三个来源的嗓子都在一排：设计（浏览器本地）、人设（读 `voice-personas.json`）、克隆（`.breeze` 文件）。点「克隆真人」上传参考录音即可存新嗓子。删掉的音色会进 `voice\voices-deleted\<时间戳>\` 回收站，能找回来。

服务是按需拉起的：页面发现 8137 没起会自己去拉，第一次请求会等 7~15 秒，正常。空闲 10 分钟没请求会自动关服务省显存。

## 5. 实测性能（RTX 5060 Laptop 8G）

| 档位 | 显存 | 速度 | 冷启动 |
|---|---|---|---|
| Q4_K | ~2.9G | ~2.2× 实时，首音 110ms | 7s（首次编译着色器约 35s） |
| Q8_0 | ~3.8G | 略慢一档 | 12s |

## 6. 许可证

推理代码是 Apache-2.0（见引擎 zip 里的 `LICENSE` / `THIRD_PARTY_NOTICES.txt`）；**模型权重是 BreezeBlue 非商用研究许可**。自托管生成的音频不能用于商业发布，个人用随便。
