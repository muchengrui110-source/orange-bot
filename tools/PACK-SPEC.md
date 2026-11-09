# 打包规范：把一套能跑的东西整理成能发出去的包

这份规范管四件事：包长什么样、哪些东西绝对不能进包、每份文档要写什么、怎么验收。

## 1. 包的形状

每个包 = 一个自包含目录 + 一个同名 zip，解压即用：

```
<包>/
  NEXT-AI.md         给「下一个 AI」看的避坑说明书（最重要的交付物）
  README.md          给人看的安装说明，短，200 行内
  install.ps1        一键落位（幂等，UTF-8 带 BOM，不覆盖已有配置）
  PACK-INFO.txt      版本、体积、打包时间、自检结果、内容清单
  docs/              本包专题文档（脱敏后才放）
  <内容目录>/         plugin/、engine/、voice/ 之类
```

包与包之间可以有依赖（A 用 B 建出来的配置文件），但依赖只能写在文档里，不能靠脚本自动跨包装。

## 2. 脱敏红线

包内任何文件（含 zip 里的条目名）不得出现：

| 类别 | 例子 | 替代写法 |
|---|---|---|
| 账号 | 真实 QQ 号、手机号、群号、学号 | `10001` |
| 人名/角色名 | 真名、昵称、角色名 | `<示例角色>` |
| 个人路径 | `C:\Users\<真名>\...`、`D:\<私人目录>\...` | `<DSH_HOME>`、`%USERPROFILE%`、`D:\tools\...` |
| 密钥 | OneBot token、API key、密码 | 空值 + 注释「自己填」 |
| 私人数据 | `personas.json`、`settings-ui.json`、`sessions.json`、`*.log`、`*.db*`、登录二维码 | 只给 `.example` 模板 |
| 个人音色 | `*.breeze`、参考录音、生成的 `*.mp3` | 不给，用户自己录 |
| 模型权重 | 几个 G 的 gguf | 给下载脚本 + sha256 |
| 运行时配置 | 协议端 `config/*_<号>.json`（含 token） | `config.example/`，首次启动重建 |

判断标准：**这段东西贴到公开仓库，我会不会难受**。会，就别放。

真实名单放 `redact-patterns.txt`（不进仓库），`scan-secrets.ps1` 读它；仓库里只留 `redact-patterns.example.txt`。

## 3. NEXT-AI.md 的要求（每个包都要）

这是给「下一个 AI」看的，不是给人看的。必须包含：

1. 开头一句话：这套是什么、数据流图（谁连谁、端口）
2. 安装顺序（编号，别跳步），每条写清跑什么命令、期望看到什么
3. 三条铁律（违反会浪费半天的那种），每条给现象和正确做法
4. 坑清单：按模块分节（A/B/C…），格式 = **现象 → 原因 → 怎么办**，具体到文件/命令/字段名
5. 关键文件表（路径 + 作用）
6. 自检清单（可直接复制跑的 PowerShell，含期望输出）
7. 症状 → 排查对照表
8. 「本包不含什么」：数据/密钥/模型权重/音色，以及怎么补齐

语气：短句、直给；数字用实测值；不写空话。

## 4. README.md 的要求

给人看的：装完是什么样、前置条件、5~8 步安装、第一次怎么验证、出问题看 NEXT-AI.md。

## 5. install.ps1 的要求

- 中文必须 UTF-8 **带 BOM**（PowerShell 5.1 否则按 GBK 解析报语法错）。补 BOM 的写法：

```powershell
$b = [IO.File]::ReadAllBytes($p)
if (-not ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)) {
    $bom = [byte[]](0xEF, 0xBB, 0xBF)
    [IO.File]::WriteAllBytes($p, [byte[]]($bom + $b))
}
```

- 用 `$PSScriptRoot` 定位包内文件，用 `$env:DSH_HOME` / `$env:USERPROFILE` 定位用户目录。
- 幂等：已存在的配置打印「保留不动」，加 `-Force` 才覆盖。
- 只做：复制/落位、写示例配置（仅当不存在时）、建快捷方式、打印下一步。
- 不自动扫码、不自动装插件（插件要用户自己在 DSH 里按包名/tgz 装）。

## 6. 打包前自检

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-secrets.ps1 -Root "<包目录>"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-pack.ps1 -Root "<包目录的父目录>" -RequireZip
```

另外确认：
- 没有 `*.log`、`*.db*`、`*.breeze`、`personas.json`、`settings-ui.json`、`sessions.json`、`voice-personas.json`、`napcat-qr.json`
- 所有 `.ps1` 语法 0 错误，含中文的有 BOM
- zip 大小、条目数记进 `PACK-INFO.txt`

## 7. zip

- `tar.exe -a -c -f out.zip <目录>` 或 `Compress-Archive`，zip 放包目录同级。
- 打完抽查：解到临时目录，确认 `NEXT-AI.md` / `README.md` / `install.ps1` 在根、内容目录齐、条目名没有私人信息。
- 单文件超过 100MB 就别进 git，走 Releases。

## 8. 版本与来源

- 版本钉死：打包当天是什么版本就写什么，不写「最新」。
- 每个包记清来源：自己写的代码、第三方运行时（附上游地址与许可）、下载脚本能补的东西。
- 第三方运行时（客户端本体、模型、二进制引擎）默认不进公开仓库，放在 Releases 或让用户自己下。
