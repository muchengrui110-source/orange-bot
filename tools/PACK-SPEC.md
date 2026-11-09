# 分发包打包规范

目标根目录（示例）：`D:\tools\packs\`，换成你自己的路径即可。每个包 = 一个目录 + 同级一个同名 zip；目录内自包含，解压即用。

本仓库 `tools/` 下的 `scan-secrets.ps1`、`verify-pack.ps1` 按本规范自动检查；规范本身以这份文件为准。

## 0. 包清单

目录名建议用 `<序号>-<主题>-v<版本>`：纯英文、数字、连字符，不用中文和空格（PowerShell 5.1 在命令行里处理中文路径容易踩编码）。

| 目录名（示例） | 内容 | 版本 |
|---|---|---|
| `1-qq-bridge-v1.6.2` | QQ 桥接插件 + NapCat 本体 + 看门狗/守护/二维码刷新脚本 + `install.ps1` | 1.6.2 |
| `2-persona-v1.4.0` | 身份与人设插件 + 人设模板 + `install.ps1` | 1.4.0 |
| `3-voice-v0.1.6` | 语音引擎本体 + 语音脚本 + 工作室 + 模型下载脚本 + `install.ps1` | 0.1.6 |
| `4-mnemon-v0.5.39` | 长期记忆插件 + 全部子包依赖 + `install.ps1` | 0.5.39 |

版本以包内 `PACK-INFO.txt` 为准，打包前跟源码 `package.json` 对一遍。

## 1. 每个包的标准结构

```
<包目录>\
  NEXT-AI.md      ← 给下一个 AI 看的避坑说明（最重要的交付物，见第 3 节）
  README.md       ← 给人看的安装说明（短，200 行内）
  install.ps1     ← 一键落位脚本（幂等，UTF-8 带 BOM，不覆盖已有配置）
  PACK-INFO.txt   ← 版本、体积、文件数、打包时间、自检结果、内容清单
  docs\           ← 本包相关的专题文档（脱敏后才放）
  <内容目录>\      ← plugin\ / napcat\ / engine\ / voice\ / node_modules\ 等
```

## 2. 脱敏红线（最高优先级，违反=重做）

任何包内文件（含 zip 内的）**不得出现**：

| 类别 | 不能出现 | 替代写法 |
|---|---|---|
| 账号 | 真实 QQ 号、手机号、邮箱 | `10001`、`user@example.com` |
| 人名/角色名 | 真名、昵称、角色名 | `<你的名字>`、`示例角色` |
| 个人路径 | 真实用户名下的 `C:\Users\<username>`、个人盘符下的 NapCat 等真实安装目录 | `<DSH_HOME>`、`%USERPROFILE%`、`$PSScriptRoot`、`D:\tools\...`（示例安装路径） |
| 密钥 | OneBot token、API key、密码 | 空值 + 注释「自己填」 |
| 私人数据 | `personas.json` 正文、`settings-ui.json`、`sessions.json`、`voice-personas.json`、`qq-names.json`、`napcat-qr.json`、`*.log`、`*.db*`、`login-qrcode.png` | 只给 `.example` 模板 |
| 个人音色 | `*.breeze`、参考录音、`demo-*.mp3`、`reply*.mp3` | 不给，用户自己录 |
| 模型权重 | 几 G 的 gguf / safetensors | 下载脚本 + 校验 sha256 |
| 运行时配置 | NapCat 的 `config\*_<QQ号>.json`（含 token）、登录二维码 | `config.example\`，首次启动重建 |

补充：

- 文档里的示例值也只能是假的（`10001`、`example.com`、`C:\Users\<username>`），别拿真实值当例子。
- 唯一例外：人设模板里已泛化过的「示例角色」可以保留。
- 打包前必须跑第 6 节的扫描，`OK: 0 命中` 才能打 zip。

## 3. NEXT-AI.md 的要求（每个包都要，缺一不可）

这是给「下一个 AI」看的，不是给人看的。必须：

1. 开头一句话：这套是什么、数据流图（谁连谁、端口）
2. 安装顺序（编号，别跳步），每条写清楚跑什么命令、期望看到什么
3. 三条铁律（违反会浪费半天的那种），每条给出现象和正确做法
4. 坑清单：按模块分节（A/B/C…），每条格式 = **现象 → 原因 → 怎么办**，要具体到文件/命令/字段名
5. 关键文件表（路径 + 作用）
6. 自检清单（可直接复制跑的 PowerShell，含期望输出）
7. 症状 → 排查对照表
8. 「本包不含什么」：数据/密钥/模型权重/音色，以及怎么补齐

语气：短句、直给；数字用实测值；不写空话。

## 4. README.md 的要求

给人看的：这套装完是什么样、前置条件、5~8 步安装、第一次怎么验证、出问题看 `NEXT-AI.md`。

## 5. install.ps1 的要求

- 中文必须 UTF-8 **带 BOM**（否则 PowerShell 5.1 按 GBK 解析报语法错）。写完补 BOM：
  `$p='<脚本路径>'; $b=[IO.File]::ReadAllBytes($p); if(!($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)){ $bom=[byte[]](0xEF,0xBB,0xBF); [IO.File]::WriteAllBytes($p, [byte[]]($bom + $b)) }`
- 用 `$PSScriptRoot` 定位包内文件，用 `$env:DSH_HOME` / `$env:USERPROFILE` 定位用户目录
- 落位目录做成参数（如 `-InstallDir`）或从环境变量读，默认给一个示例路径，别写死个人路径
- 幂等：已存在的配置不覆盖（打印「保留不动」）
- 只做：复制/落位、写示例配置（仅当不存在时）、建快捷方式、打印下一步
- 不自动扫码、不自动装插件（插件要用户自己在 DSH 里按包名/tgz 装）

## 6. 打包前自检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-secrets.ps1 -Root "<包目录>"
# 有名单就加 -PatternsFile "D:\path\to\redact-patterns.txt"
```

- 名单：`tools\redact-patterns.txt`（把 `redact-patterns.example.txt` 复制一份，换成自己的号/名/路径，不进仓库）；没有名单也能跑，只用内置通用规则（邮箱 / 令牌 / 个人目录 / 疑似账号）
- 输出必须是 `OK: 0 命中`，exit code 0 才算过；有命中就回去改，别在扫描脚本里加白名单糊弄
- 「提示」类（邮箱 / 令牌 / 个人目录 / 疑似账号）默认只打印、不算失败；要一起卡死加 `-Strict`
- 整个包根目录再跑一次终验：`powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-pack.ps1 -Root "<包根目录>"`
- 目录里没有 `*.log`、`*.db*`、`*.breeze`、`personas.json`、`settings-ui.json`、`sessions.json`、`voice-personas.json`、`napcat-qr.json`
- 所有 `.ps1` 语法 0 错误，含中文的有 BOM
- zip 大小、条目数记录到包目录的 `PACK-INFO.txt`

## 7. zip 要求

- 用 `Compress-Archive` 或 `tar -a -c -f` 打，zip 放 `D:\tools\packs\<包目录名>.zip`
- 打完抽查：解压到临时目录，确认 `NEXT-AI.md` / `README.md` / `install.ps1` 在根、关键内容目录在
- 大包（NapCat 这种）压缩尽量用 `tar.exe -a`（更快）
- 条目名同样要过名单检查（目录名/文件名里带真号一样算泄露）

## 8. 来源与版本（别装错）

- 源码来自本仓库对应目录（`01-qq-bridge/`、`02-persona/`、`03-voice/`、`04-memory/`），版本以各自 `package.json` 和 `PACK-INFO.txt` 为准
- 第三方运行时（NapCat、语音引擎、模型权重）从各自上游发布页下载，记录版本号和 sha256，不把大文件塞进 git
- 别用「最新版」：打包当天是什么版本就记什么版本
- 成品包、原始文档至少留两个位置；只存一处等于没存

## 9. 验收清单

```
[ ] scan-secrets.ps1 输出 OK: 0 命中（exit 0）
[ ] verify-pack.ps1 全部 PASS
[ ] 所有 .ps1 语法 0 错误，含中文的有 BOM
[ ] 所有 .json 能解析
[ ] 无 *.log / *.db* / personas.json / settings-ui.json / sessions.json / *.breeze / *.mp3
[ ] zip 条目名无私人信息
[ ] zip 解压根目录含 NEXT-AI.md / README.md / install.ps1
[ ] PACK-INFO.txt 记了体积、文件数、自检结果
[ ] 在干净机器（或空 profile）上装一遍，能跑
```
