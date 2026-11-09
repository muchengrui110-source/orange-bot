# dsh-mnemon 0.5.39 · 快速上手

这份是「装完之后怎么用」的一页纸。装不上、装完没反应，看根目录的 `NEXT-AI.md`。

## 1. 装完是什么样

- 侧栏多一个 **记忆系统**（英文 Memory System），里面是：状态 / 运行时记忆 / 项目档案 / 记忆空间 / 技能管理。
- 插件页多一组 **可组合记忆**：主策略、各组件、Provider、存储与界面设置，每个都有自己的一页和开关。
- 对话里多两样东西：回复下方的**回合记忆栏**（这一轮读到/写了哪些记忆），和回复下的**脑形图标**（把这条回复存进记忆）。

## 2. 第一次打开

1. 插件页 → 添加插件 → 输入 `dsh-mnemon` → 安装 → **立即启用**。
2. 侧栏 **记忆系统 → 状态**：能看到每个记忆组件和 Provider 的当前状态（哪个 Source 在跑、哪个 Provider 启用）。
3. 说一句值得记住的话（比如「以后写代码都用 4 空格缩进」），回复下的回合记忆栏会列出这一轮读写的记忆；点脑形图标可以把它存进指定位置，回执会写明存到了哪儿。
4. 插件页 → **可组合记忆**：选主策略（默认「分层策略」），需要再开增强。

## 3. 三层记忆（先搞清这个，别乱存）

| 层 | 存什么 | 怎么进上下文 | 工具 / 页面 |
|---|---|---|---|
| **热记忆**（运行时记忆） | 身份、偏好、协作约定、下一轮就需要的事实 | **每轮**以紧凑的 `USER.md` / `MEMORY.md` 注入 | `mnemon_runtime_memory`；页面「运行时记忆」 |
| **项目档案**（Documents） | 设计、调查、流程、交接材料等成篇的知识 | **先检索，相关时才读全文** | `mnemon_document_search` / `mnemon_document_create` / `mnemon_document_manage`；页面「项目档案」 |
| **记忆空间**（Memory Space） | 长期事实、决策、实体及其关系 | **按需**从已启用的 Provider 召回 | `mnemon_recall` / `mnemon_remember` / `mnemon_memory_bodies`；页面「记忆空间」 |

默认的**分层策略**让热记忆常驻，另外两层按需读；另一条「通用策略」把全部来源放进同一份预算由模型自己决定（默认关）。

口诀：**要每轮都记得 → 热记忆；成篇资料 → 档案；零散长期事实 → 记忆空间。**

## 4. 写热记忆（唯一正确姿势）

`MEMORY.md` / `USER.md` **是投影**（展示层），真正的数据是 `.mnemon\runtime\memories.json`。
所以：

- 写：只用 `mnemon_runtime_memory`（`action=add/replace/remove`，`target=user/memory`）。
- 读：不要手改文件；工具回执就是成功证据。
- 手改 `MEMORY.md` 的后果：下一次工具写入时会被投影覆盖，你写的东西直接消失；反过来手改也不会立即影响模型看到的内容。

什么时候值得写：用户纠正你、说「以后都这样」、给出稳定偏好、告诉你新的环境事实、项目里出现新的约定/决定。
什么时候别写：一次性的进度、你的猜测、raw dump、日志、密码密钥、能从代码/仓库一眼看出来的东西。

## 5. 项目档案（Documents）

- **建**：`mnemon_document_create`（或页面上「新建」）。一份档案 = 目录里的一个 `.md`，控制面事实源是 `.mnemon\documents\index.json`。
- **搜**：`mnemon_document_search`（**只管 Documents**，搜不到记忆空间里的东西）。空查询 = 列出最近的档案。
- **改**：`mnemon_document_manage`（update）。frontmatter、哈希、修订号由控制层生成，原项目文件只读。
- **容量**：活跃档案总量固定 **≤ 10 MB**（`DOCUMENTS_ACTIVE_LIMIT_BYTES = 10485760`），**归档不占这个额度**。
- **归档**：页面里「归档」→ 由独立的任务 Agent 先拟摘要和目标记忆空间 → Host 校验后写**冷索引** → 才把原文移进 `documents\archived\`。没有「已启用 + 支持精确写入与删除」的记忆空间时，原文直接进本地归档目录，不建索引。
- 归档后原文档**不再出现在默认搜索结果里**（要显式 includeArchived 才能挖出来）。所以「昨天存的文档搜不到了」先看是不是被归档了。

## 6. 记忆空间（Memory Space）

- 一个记忆空间 = 由 Provider 承载、可独立命名、可独立开关的长期证据范围。
- **Provider**：默认只启用 **Mnemon Native**（官方、本地、有完整图谱和软删除）。另外 8 个（OpenViking / Honcho / Mem0 / Hindsight / Holographic / RetainDB / ByteRover / Supermemory）**在配置前保持关闭**；它们要么要远程服务、要么要 key，图谱/删除/枚举能力各不相同。
- **召回 vs 搜索**：`mnemon_recall` 搜**记忆空间里的记忆**；`mnemon_document_search` 搜**档案**。两个不是一回事，别用错。
- **pinned / 激活**：只有「已激活」的空间才会被召回；页面里关掉一个空间 = 它不再参与召回，**数据不会被删**。
- 一行一条的写入用 `mnemon_remember`；关系和删除用 `mnemon_link` / `mnemon_forget`（取决于 Provider 是否支持，页面会标）。

## 7. 开关速查（插件 → 可组合记忆 → 各组件）

| 配置键 | 默认 | 说明 |
|---|---|---|
| `storageScope` | `global`（`~/.mnemon`） | `global` 全局 / `workspace` 每个工作区一份 `.mnemon` / `workspaces` 集中存但按工作区分目录 / `custom` + `dataDir` 指定目录 |
| `recallMode` | `guided` | 引导模型什么时候召回；`off` = 不提示（工具仍可用） |
| `writebackMode` | `guided` | 引导模型什么时候写回；`off` = 不提示 |
| `routingGuidance` | `true` | 是否在提示词里给「该去哪层记忆」的路由提示 |
| `lifecycleEnabled` | `true` | 回合生命周期（组装 View、记录读写） |
| `idleReviewMs` | `30000` | 空闲多久后触发回顾（5s~10min） |
| `tabEnabled` | `true` | 侧栏「记忆系统」入口 |
| `writeEnabled` | `true` | 总写开关；关掉 = 整个插件只读 |
| `remoteAccess` | `read-only` | 远程连接只能看；改 `trusted-host` 并重启才允许远程管理 |
| `embedding.enabled` | **`false`** | 关着就是纯关键词/图召回；打开需要本地 ollama + `nomic-embed-text`（默认 endpoint `http://localhost:11434`） |
| `recallQuality` | `strict-v1` | 阈值 0.25/0.6、候选倍数 3、中等结果≤4、未知≤2 |
| `timeoutMs` / `defaultRecallLimit` | `10000` / `10` | 单次记忆操作超时 / 默认召回条数 |
| `runtimeMemory.memoryLimitBytes` / `userLimitBytes` | `10240` / `4096` | 热记忆容量（见下一节） |

## 8. 容量与压缩（最容易踩的一节）

- `MEMORY.md` 上限 **10 KB**（10240 字节）、`USER.md` 上限 **4 KB**（4096 字节），单条记忆上限 8 KB。
- 超了**不会报错丢数据**：先做容量整理（`maintenance`）——把可以外移的条目**归档进记忆空间**（按主题），再更新目标文件。
- 如果要写的空间一个都没有（全关 / 没有可用 Provider），就退回**本地归档**：移到 `.mnemon\runtime\archived\`，然后继续写。
- 单个工具调用想硬塞超容量的内容 → 报 `runtime-capacity` 错误，提示你先整理再重试。这时候该做的是**拆条 / 精简 / 挪去记忆空间**，不是调大上限（上限最大 1 MB，但不建议）。
- 归档 ≠ 删除：`archived\` 里的东西还在磁盘上，能查。

## 9. 数据在哪、怎么备份

```
%USERPROFILE%\.mnemon\                 （可用环境变量 MNEMON_DATA_DIR 改）
  runtime\
    memories.json      ← 热记忆的事实源（MEMORY.md / USER.md 是它的投影）
    MEMORY.md          ← 每轮注入
    USER.md            ← 每轮注入
    archived\          ← 容量整理挤出去、又没空间可放时的本地归档
  documents\
    index.json         ← 项目档案控制面事实源
    active\            ← 活跃档案（≤10MB）
    archived\          ← 归档原文
  state\
    machine.json       ← 本机身份（不随备份走）
```

- 页面里可以打 **ZIP 备份 / 恢复**；备份**包含**你的私有记忆，别乱传。
- 关掉组件**不会删数据**；换 `storageScope` 也**不会搬数据**（换位置 = 新目录从零开始），要迁移用 ZIP 备份。
- 第三方 Provider 的凭据只留在宿主，不会被导出。
- 用 Git 同步（可关，默认 `syncEnabled: false`）：把同一份数据以可读文件发到自己的仓库，另一台机器拉。

## 10. 顺手的几条

- 对话里想出题考记忆：直接让模型 `mnemon_document_search` 搜主题，或 `mnemon_recall` 搜空间。
- 「这轮到底读了什么」看回复下的回合记忆栏，点一下就在记忆系统里打开对应条目。
- 技能管理（实验性）：自进化**默认关闭**，在「可组合记忆 → 技能管理」里开；没有你的**采纳**不会改任何 `SKILL.md`。
- 版本：0.5.39；engines 要求 `node >= 20`、DSH `0.2.x`。升级不重建 `.mnemon`，但老会话数据可能要跑 `bin\repair-legacy-session.mjs`（看 `NEXT-AI.md` 第 E 节）。
