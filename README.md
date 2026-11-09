# DSH 插件四件套：QQ 桥接 / 身份与人设 / 语音 / 长期记忆

给 DeepSeek Harness（下称 DSH）用的四套东西，拼起来是：一个能上 QQ、有固定人设、会发语音、跨对话记得住人的本地 agent。全部本地跑，除了第一次下模型不联网。

仓库里是源码、脚本和文档；**带运行时的成品包在 Releases**（NapCat 本体 345MB、语音引擎 74MB 这种不进 git）。

## 四套是什么

| 目录 | 插件 | 版本 | 干嘛的 |
|---|---|---|---|
| `01-qq-bridge/` | dsh-qq-bridge | 1.6.2 | 通过 OneBot v11 把 QQ 私聊/群聊接进 DSH，收发消息、表情包、控制面 API |
| `02-persona/` | dsh-persona | 1.4.0 | DSH 设置页「身份与人设」，改写 QQ 桥接的 `personas.json`；给个角色名还能去互联网学人设 |
| `03-voice/` | Breeze 语音对接层 | 0.1.6 | 本地 TTS 服务（`:8137`）+ 网页工作室（`:8140`），桥接按人设锁音色、合成语音发回 QQ |
| `04-memory/` | dsh-mnemon | 0.5.39 | 分层长期记忆：热记忆 / 项目文档 / 记忆空间 / 技能 |

装序 **01 → 02 → 03 → 04**。02 要用 01 建出来的 personas.json 目录，03 的转发脚本也挂在 01 上，04 独立。

## 怎么装

1. 去 [Releases](../../releases) 下四个 zip。zip 里自带运行时和全部依赖，解压就能用。
2. 解压到一个**不含中文、不含空格**的目录，比如 `D:\tools\`。
3. 进包根目录，读 `README.md`，按里面的步数跑 `install.ps1`。
4. 每个包根目录都有一份 `NEXT-AI.md`——那是写给「下一个 AI」的避坑说明书。装之前先让它读完，能省掉大半排查时间。
5. 装完照 `NEXT-AI.md` 最后一节的自检清单跑一遍。

插件本身怎么进 DSH：**别从文件夹装**。用包名从 npm 装，或者拿包里的 tgz，否则插件页只会显示 `failed to import`。

## 先看这几条（都是踩出来的）

- **QQ 同号互踢**：同一个 QQ 号在同一台电脑上只允许一个 QQ NT 会话在线。NapCat 和桌面 QQ 同号必互相顶号，多开、换目录、装两份都没用。机器人给独立小号，或者桌面 QQ 和 NapCat 二选一。详见 [docs/napcat-qq-conflict.md](01-qq-bridge/docs/napcat-qq-conflict.md)。
- **改桥接代码不会热更**：动过 `plugin/lib/` 里的代码，要在 DSH 里把这个插件关一次再开，才会重载；重载会重连 WebSocket，会话能恢复。
- **PowerShell 5.1 + 中文**：`.ps1` 里含中文必须存成 UTF-8 **带 BOM**，否则按 GBK 解析直接语法错。改源码用编辑器，别用 `Get-Content`/`Set-Content` 来回倒——5.1 按 GBK 读，写回去整份乱码。
- **命令行里的中文路径**：`-File '<含中文的路径>'` 容易踩编码，找不到文件或参数被截断。包放英文路径最省事。
- **语音模型权重是非商用许可**：推理代码 Apache-2.0，模型权重是 BreezeBlue 非商用研究许可。自己用随便，生成的声音别拿去做商业发布。
- **记忆数据不在包里**：`.mnemon` 目录、`personas.json` 正文、登录二维码、日志、个人音色一律不进包，第一次启动自己生成/扫码。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 四套怎么接起来、每层为什么这么设计、关键接口和端口 |
| [docs/02-memory-layers.md](docs/02-memory-layers.md) | 长期记忆怎么分层：热记忆 / 分区 / 原文 / 机制层，怎么维护不烂掉 |
| [docs/03-packaging.md](docs/03-packaging.md) | 怎么把源码整理成能发出去的包：脱敏红线、自检、打包、验收 |
| `0X-*/NEXT-AI.md` | 每个包自己的避坑清单：现象 → 原因 → 怎么办，附自检命令和排查表 |
| `0X-*/docs/` | 专题：NapCat 与桌面 QQ 互踢、桥接安装、人设写法、语音配置 |

## 目录

```
dsh-plugins/
  01-qq-bridge/       桥接插件 + NapCat 配置示例 + 看门狗/二维码脚本
  02-persona/         人设插件 + 人设模板
  03-voice/           语音脚本 + 网页工作室 + 引擎占位（引擎 zip 在 Releases）
  04-memory/          记忆插件 + 18 个子包依赖（node_modules 一起带，离线可装）
  docs/               架构、记忆分层、打包脱敏
  tools/              打包维护工具链：脱敏扫描、验收、构建脚本
```

`01-qq-bridge/napcat/config.example/` 只有脱敏后的 OneBot 配置示例；NapCat 本体和它自带的 QQ 组件在 Releases 的 zip 里。

## 许可

四个插件的代码是 MIT，见各自 `LICENSE`。

第三方部分按上游许可：NapCat 来自 [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)（含腾讯 QQ 客户端组件，只适合自用/学习）；语音引擎来自 [HoppouAI/Breeze-TTS-2.cpp](https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp)（Apache-2.0，模型权重非商用）；记忆插件来自 [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon)（MIT）。这个仓库只放自己写的代码和文档，不再分发这些第三方运行时。
