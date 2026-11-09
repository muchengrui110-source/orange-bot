# 身份与人设插件（dsh-persona 1.4.0）

DSH 设置里多一页「身份与人设」，写的就是 QQ 桥接用的那份人格文件（默认 `<DSH_HOME>\qq-bridge\personas.json`）。
`DSH_HOME` 默认是 `%USERPROFILE%\.dsh`。

## 能做什么

| 区域 | 对应字段 | 说明 |
|---|---|---|
| 从互联网学习角色 | `characters.<角色名>` | 输入名字 → 后台搜资料 → 用当前模型提炼成人设和说话方式 → 确认后存进角色库 |
| 角色库 | `characters.<角色名>` | 已存角色，可编辑、套用到会话、删除 |
| 身份（默认人格） | `default.title` / `default.prompt` | 没单独配过的聊天用它兜底 |
| QQ 会话人格 | `chats.<会话键>.active` / `.modes` | 每个聊天（`private:<QQ号>` / `group:<群号>`）一套模式，`active` 那个会拼进提示词 |
| 规则 | `rules` | 所有人格共用的短规则，键值对 |

「套用」= 把角色提示词复制成目标会话的一个模式（模式名 = 角色名）并设为当前生效；复制之后两边独立，改角色不会自动改已套用的模式，要重新套用一次。

## 安装

和桥接插件一样，**别从本地文件夹装**（pnpm 会写 `link:` 且不装依赖，插件页显示 `failed to import`）：

```powershell
cd plugin
npm pack            # 得到 dsh-persona-1.4.0.tgz
```

把 tgz 交给 DSH 的插件管理器安装，或写进 profile 的 `package.json` 再 `pnpm install`。这个包**没有第三方依赖**，不占端口，装完重启 DSH 或热重载即可。

## 自带什么

- 机制 + 一个性格模板（`plugin\templates\personas.template.json`，一个示例角色）
- `personas.json` 不存在时用它初始化；默认人格就是那个示例角色，内容随便改

## 和语音的关系

人设文本决定「怎么说」，声音由 `voice-personas.json` 决定「用什么嗓子」（见语音包的 `docs\voice.md`）。桥接发语音时带 `-Persona "<当前性格模式>"`，语音脚本会去 `personas.json` 里读那个模式的 `replyStyle` 抽语气，再套上 `voice-personas.json` 里配置的固定音色。

老格式（纯字符串模式）取不到 `replyStyle`，语音脚本只能退回用整段正文，语气抽取会弱一些——想让它读得准，模式尽量用三段式对象写。

## 数据文件（不要手改这两份之外的任何东西）

- `personas.json`：人格正文，插件和桥接都读它
- `speech-habits.json`：说话习惯统计（只存长度、行数、标点数量，**不存原话**），自动生成

## 许可

MIT。
