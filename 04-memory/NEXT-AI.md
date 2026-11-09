# 给下一个 AI 的交接说明（先读完再动手）

**一句话**：`dsh-mnemon` 0.5.39 是 DSH 的长期记忆插件。它把记忆分成三层——**热记忆**（每轮注入）、**项目档案**（按需检索）、**记忆空间**（Provider 承载的长期证据）——再挂一个实验性的**技能管理**（技能版本 / 自进化 / 回测）。它不是独立服务，是 DSH 进程内插件；数据默认落在 `%USERPROFILE%\.mnemon\`。

> **本包版本 0.5.39（2026-11-04 更新，上一版 0.5.34）。** 跨了 5 个版本，装法和数据位置都没变，直接覆盖装，`.mnemon` 里的记忆不用迁移。要点：
> - 0.5.35：Runtime 替换保留 importance；导入/同步溢出进 archive 不丢；技能管理加回收站；评测支持「需要图片输入」用例；OpenViking 严格写入。
> - 0.5.36：修技能复盘在多条待处理建议时崩（#495）；新建技能/改进已有技能的建议可分别控制（#498）；支持自选数据目录（#355）；适配 DSH 0.2.1-rc.3。
> - 0.5.37：技能草拟/回测可选模型（#508）；Runtime 容量可在设置里调、保留记录（#514）；embedding 模型校验（#511）。
> - 0.5.38：会话切换/隐藏面板不再重复读记忆（#530/#534）；空闲审查被工具守卫挡住时不硬跑（#533）；可选持久审查配额与冷却（#531）；修 ByteRover 在 Windows 的 npm CLI 启动（#527）。
> - 0.5.39：别的插件短路提示词组装时仍补记忆 View（#544）；PTC 准入限制在持久回合、损坏历史只做副本恢复（#545）；活动摘要保留 Unicode 代理对（#549）；技能草稿可选目标范围（#546）；支持 DSH 0.2.1-rc.5 / 0.2.2-alpha.2 工具契约（#547）。
> - **新版 `cordis.patch.yml` 加了警告**：不要把它的 insert 块抄进 profile 的 `cordis.patch.yml`，会重复 entry ID、设置页存不了（上游 issue #470）；profile 覆盖只写顶层 `- id: mnemon` 行。这条比 0.5.34 时更明确，手动安装最容易踩。

数据流：

```
                    ┌──────────────── DSH 进程 ────────────────────────────┐
Agent 一轮 ──tools──>│ dsh-mnemon (Core/Host)                              │
                     │   ├ Source: runtime        → <root>\runtime\        │
                     │   │    memories.json（事实源）                       │
                     │   │    MEMORY.md / USER.md（投影，每轮注入）          │
                     │   │    archived\（挤出去的本地归档）                  │
                     │   ├ Source: documents      → <root>\documents\      │
                     │   │    index.json（控制面事实源） active\（≤10MB）    │
                     │   │    archived\（冷归档，不占额度、默认不搜）        │
                     │   ├ Source: memory-spaces  → Providers              │
                     │   │    mnemon-native（默认，需要本机 mnemon CLI）     │
                     │   │    另外 8 个第三方（默认关，要服务/key）          │
                     │   ├ Source: skills         → DSH 的 SKILL.md 目录    │
                     │   └ Strategy: default-three-tier                    │
                     │        热记忆常驻 + 其余按需召回 → 组成这一轮 View    │
                     └─────────────────────────────────────────────────────┘
DSH WebUI：侧栏「记忆系统」/ 插件页「可组合记忆」──同进程 channel/RPC（不占端口）
外部（全部可选）：mnemon CLI（记忆空间/向量）、ollama 11434（embedding）、第三方 Provider、Git 同步仓库
```

三件必须先分清的事：

| 概念 | 事实源 | 谁写 | 谁读 |
|---|---|---|---|
| 热记忆 `MEMORY.md` / `USER.md` | `runtime\memories.json` | **只能** `mnemon_runtime_memory` | 每轮注入 |
| 项目档案 Documents | `documents\index.json` + `active\*.md` | `mnemon_document_create/manage`、页面 | `mnemon_document_search` |
| 记忆空间 Memory Space | Provider（默认 `~/.mnemon` 里的 Mnemon 数据） | `mnemon_remember`、页面 | `mnemon_recall`（**只搜已激活空间**） |

**没有自己的端口**。所有页面/工具都走 DSH 宿主。别按「端口没起来」排查。

---

## 一、安装顺序（别跳步）

1. **确认宿主版本**
   ```powershell
   node -v                      # 期望 v20 以上
   ```
   插件 `engines` 要求：`node >= 20`，DSH `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`。
   期望：能读到 `<DSH_HOME>\profiles\<profile>\package.json`。

2. **解压本包到固定目录**（别放临时目录；后面 `repair-legacy-session.mjs` 还要用）。

3. **落位（离线路线）**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName desktop
   ```
   期望输出：
   ```
   [OK]   包内自检通过：dsh-mnemon 0.5.39
   plugin\node_modules 里共 22 个目录：18 个 dsh-mnemon-* 子包 + 4 个外部依赖
   [OK]   dsh-mnemon 已落位
   ...（共 23 个目录）
   复制完成：新落位 23 个目录，保留 0 个已存在的目录
   ```
   再跑一次应该全是 `[保留] ... 已存在，保留不动`（幂等）。加 `-Force` 才覆盖。
   profile 名不是 `desktop` 就 `-ProfileName <名字>`；DSH_HOME 不在默认位置就 `-DshHome <路径>`。

4. **改 profile 的 `package.json`**（脚本故意不改它）：
   ```jsonc
   {
     "dependencies": { "dsh-mnemon": "0.5.39" },
     "dsh": { "profile": { "bundles": [ "...原有...", "dsh-mnemon" ] } }
   }
   ```
   期望：两个位置都有 `dsh-mnemon`。**只加 dependencies 不加 bundles = 插件不加载**。

5. **重启 DSH**（不是刷新页面；插件是进程内模块）。

6. **验收**：侧栏出现「记忆系统」→ 状态页能看到组件与 Provider。说不通就按第五节自检。

7. **（可选）装 Mnemon CLI**——只有「记忆空间」需要：
   ```powershell
   npm install --global @mnemon-dev/mnemon
   ```
   期望：`mnemon --version` 能跑。解析顺序是 `config.cliPath` → 环境变量 `MNEMON_CLI_PATH` → PATH 上的 `mnemon` → 常见安装路径（`%LOCALAPPDATA%\Programs\mnemon\mnemon.exe`、`%ProgramFiles%\mnemon\mnemon.exe`、GOPATH\bin 等）。

8. **（可选）向量召回**：插件 → 可组合记忆 → 本地向量嵌入 → 打开；默认 `http://localhost:11434` + `nomic-embed-text`（本地 ollama）。**默认是关的**，关着就是纯关键词/图召回。

9. **（可选）迁移旧数据**：页面里 ZIP 备份/恢复；或设 `MNEMON_DATA_DIR` 指到旧目录。换 `storageScope` **不会搬数据**（见 B2）。

---

## 二、三条铁律（违反会浪费你半天）

**铁律 1：`@deepseek-ai/*`、`react`、`react-dom` 由宿主提供，绝不要手动装进 profile；也绝不要用 `link:` 装本地文件夹。**

- 现象 A：插件页长期 `failed to import`，宿主日志 `ERR_MODULE_NOT_FOUND`（多半是 `@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`、`markdown-to-jsx`）。
- 现象 B：装上了但整页空白 / 报 React 版本不符。
- 原因：`link:` 让 pnpm 只建软链、不装依赖；手动装 `@deepseek-ai/*`/`react` 会与宿主自带的单例打架（hooks 报 invalid hook call）。
- 正确做法：本包已经把 **18 个子包 + zod + yaml + fflate + markdown-to-jsx** 全部带齐（`markdown-to-jsx` 是 `source-documents`/`source-skills` 的真实依赖，很容易漏），照 `install.ps1` 复制进 profile 的 `node_modules` 即可；在线装就用包名，别用路径。

**铁律 2：热记忆只能通过 `mnemon_runtime_memory` 写；`MEMORY.md` / `USER.md` 是投影，不是事实源。**

- 现象：手改 `MEMORY.md` 加了一条，下一次工具调用之后**消失了**；或者手改后模型这轮看不到新内容。
- 原因：事实源是 `<root>\runtime\memories.json`，两个 `.md` 是它的**生成投影**，每次写入都会重渲染。
- 正确做法：`mnemon_runtime_memory`（`action=add/replace/remove`，`target=user/memory`）；工具回执就是写入成功的证据。改完不要 echo 整个文件。
- 容量：`MEMORY.md` **10 KB**（`memoryLimitBytes=10240`）、`USER.md` **4 KB**（`userLimitBytes=4096`）、单条上限 **8 KB**。超了**不会丢数据**：先做容量整理，把条目归档进记忆空间；一个可写的空间都没有时退回本地归档 `<root>\runtime\archived\`，再继续写。硬塞超容量会报 `runtime-capacity`——正确反应是**拆条/精简/挪走**，不是调大上限。

**铁律 3：Documents 和 Memory Space 是两个世界，两个工具搜的东西不一样，别指望一个搜全。**

- `mnemon_document_search` → 只搜**项目档案**；**冷归档默认不搜**（要 `includeArchived: true`）。
- `mnemon_recall` → 只搜**已激活的记忆空间**里的记忆；没激活的空间、没装 CLI 的 native、没配置的第三方，都搜不出来。
- `mnemon_memory_bodies` 只用来**看空间目录/能力**，不要拿它当召回入口。
- 现象：「明明存过，就是搜不到」→ 90% 是搜错了层（档案去 recall、或者记忆去 document_search）。

---

## 三、坑清单

### A. 安装与加载

**A1 插件页 `failed to import`。**
原因：从文件夹/`link:` 装的（只建软链不装依赖）；或漏了 `markdown-to-jsx`/`zod`/`yaml`。
怎么办：`plugin\node_modules` 里核对 22 个目录都在；重跑 `install.ps1 -Force`；在线就按包名装 0.5.39。

**A2 只改了 `dependencies`，`dsh.profile.bundles` 没加。**
现象：`node_modules` 里有包，侧栏没有「记忆系统」。
原因：bundle 没被 profile 认领 → 插件没 mount。
怎么办：两处都加，重启。

**A3 复制进 `node_modules` 之后又跑了 `pnpm install`，包没了。**
现象：装好能用，某次 `pnpm install` 后插件页报找不到包。
原因：pnpm 按 lockfile 重建 `node_modules`，会清掉「不在依赖图里」的目录。
怎么办：`dependencies` 里必须有 `dsh-mnemon`（写版本号或 `file:` tgz）；清掉后重跑 `install.ps1`。

**A4 宿主版本对不上。**
现象：插件加载失败，提示 engines/不兼容；或设置页能开但工具全报错。
原因：`package.json` 的 `engines.dsh` 只允许 0.2.x；DSH 0.3+ 要换对应版本插件。
怎么办：`<DSH_HOME>` 里查 DSH 版本，装匹配的插件版本；别硬改 `engines` 蒙过去。

**A5 profile 选错（`desktop` / `web` / `headless`）。**
现象：脚本说 23 个目录落位成功，但打开的那个 DSH 里没有记忆系统。
原因：DSH 有几个 profile，你装进了 A，打开的是 B。
怎么办：`Get-ChildItem <DSH_HOME>\profiles` 看有哪几个；`-ProfileName` 指对；或两个都装。

**A6 装完没重启。**
现象：一切就位就是没有侧栏入口。怎么办：重启 DSH。

**A7 在线安装与离线包混装（两个版本并存）。**
现象：页面报版本错乱 / 设置读不到。
怎么办：只留一份；在插件页卸掉多余的，`dependencies` 只留 `0.5.39`。

### B. 存储位置与容量

**B1 数据到底在哪。**
默认 `~/.mnemon`（Windows：`%USERPROFILE%\.mnemon`）。四种 `storageScope`：
| 值 | 实际目录 |
|---|---|
| `global`（默认） | `~/.mnemon` |
| `workspace` | `<当前工作区>\.mnemon`（每个工作区自己一份） |
| `workspaces` | `<dataDir 或 ~/.mnemon>\workspaces\<工作区路径的 sha256>` |
| `custom` | `dataDir`（必须是绝对路径或 `~/` 开头） |
环境变量 `MNEMON_DATA_DIR` 会覆盖 `global` 的根目录。

**B2 换了 `storageScope` → 记忆好像全没了。**
原因：**换位置不会搬数据**，新目录从零开始。
怎么办：换回来；或用页面里的 ZIP 备份/恢复搬过去。要按工作区分，建议一开始就用 `workspace`。

**B3 热记忆写不进去、报 `runtime-capacity`。**
原因：`MEMORY.md` 超 10 KB / `USER.md` 超 4 KB / 单条超 8 KB。
怎么办：按铁律 2 精简或归档；先删过时条目（`action=remove`）、再写新的。别调大上限了事。

**B4 手改 `memories.json`。**
现象：整份记忆诡异回退、或投影乱掉。
原因：它有版本号与投影逻辑，还有 `.memories.lock`（超过 30 秒未更新的锁视为陈旧）。
怎么办：别手改。真坏了：停 DSH → 备份 `runtime\` → 删除 `memories.json` 让插件重建 → 从备份里挑条目用工具重写。

**B5 卡住不动，怀疑锁没释放。**
原因：进程崩溃留下 `.memories.lock`。
怎么办：停 DSH，删 `<root>\runtime\.memories.lock`，再起。

**B6 `state\machine.json` 丢了/被当备份恢复。**
原因：它是**本机身份**，故意不进备份（两台机器同 id 会让合并分不清来源）。
怎么办：丢了会自动重建；别手工从别的机器拷过来。

### C. 项目档案（Documents）

**C1 `mnemon_document_create` 没给 title → 报错。**（title 必填）

**C2 活跃档案总量上限固定 10 MB（`10485760` 字节），超了创建/更新会被拒。**
现象：「已先迁移 N 份旧档案，再创建活跃档案」。
怎么办：这是自动归档的前奏，等它做完再写；或先把不用的档案归档。

**C3 归档之后 `mnemon_document_search` 搜不到了。**
原因：**冷归档默认被排除**。
怎么办：查询时带 `includeArchived: true`；或去 `documents\archived\` 找原文。

**C4 归档不是纯移动。**
流程：独立任务 Agent 拟摘要 + 目标记忆空间 → Host 校验 → 写**冷索引** → 才移动原文。
如果**没有已启用且支持「精确写入 + 删除」的记忆空间**，原文直接进本地归档，**不建索引**（以后只能按文件找）。

**C5 以为档案会改项目里的源文件。**
不会。档案是 `.mnemon\documents\` 下的副本，`active\*.md` 带 frontmatter/哈希/修订号，**项目源文件只读**。

**C6 手写档案文件名乱来。**
`DOCUMENT_FILENAME_PATTERN` 有约束；别自己往 `active\` 里塞文件——用工具/页面建。

### D. 记忆空间与 Provider

**D1 默认只有 Mnemon Native 真正可用，而且它要本机 CLI。**
`dsh-mnemon-provider-*` 里的 npm 包是**驱动，不是二进制**。没有 CLI 时，记忆空间会退到「另一个 ready 的 Provider」，通常就是没有 → 空间看起来空。
现象：`mnemon_status` 报 CLI 不可用 / 记忆空间列表空 / 写入无回执。
怎么办：`npm i -g @mnemon-dev/mnemon`，或设 `config.cliPath` / 环境变量 `MNEMON_CLI_PATH`。

**D2 第三方 Provider 默认关。**
OpenViking / Honcho / Mem0 / Hindsight / Holographic / RetainDB / ByteRover / Supermemory —— 8 个都在包里，但**配置前不启用**；要各自的 endpoint/key（凭据只留在宿主，不会导出）。
现象：开了某个空间但召回一直空。
怎么办：去「记忆空间」页面确认该 Provider **已启用且已连接**，空间**已激活**。

**D3 「pinned / 激活」是读开关。**
关掉一个空间 = 不再参与召回，**数据不删**。`mnemon_recall` 省略 `memoryBodyIds` 时只搜**当前 pinned 的 active 空间**；一个都没激活 → 返回空，不报错。

**D4 能力因 Provider 而异。**
图谱遍历（`mnemon_related`）只有部分 Provider 支持（OpenViking 明确不支持）；`forget` 只对支持软删除的 Provider 有效；`link` 只对支持关系的有效。工具会回「provider 不支持」，这不是 bug。

**D5 远程 Provider = 记忆出本机。**
写进远程 Provider 的事实会被发到对应云端服务。敏感内容只放本地 Native / 档案。

**D6 异步 Provider 的回执是「已受理」。**
有的 Provider 等远程提炼任务完成才给真实回执。看到 pending 不等于失败，页面会标。

**D7 空间越开越多、召回质量下降。**
`recallQuality`（默认 `strict-v1`：低分阈值 0.25、高分 0.6、候选倍数 3、中等结果≤4、未知≤2）会压噪声；但太多重叠空间互相抢名额。
怎么办：合并（`mnemon_memory_body_merge`）或关掉不用的空间。

### E. 向量嵌入（embedding）

**E1 默认关（`embedding.enabled: false`）。**
关着就是**纯关键词/图召回**——同义不同词查不到。要语义召回才开。

**E2 开了还要服务在。**
默认 `http://localhost:11434`、模型 `nomic-embed-text`（ollama）。Endpoint 以 `/v1` 结尾时自动按 OpenAI 兼容协议（`/v1/embeddings` + Bearer）。
现象：开了 embedding 但召回没变好 → 大概率服务不可达。
怎么办：页面「测试状态」；确认 ollama 在跑、模型已拉。

**E3 只在 Mnemon Native 生效，而且需要 Mnemon CLI。**
向量设置只作用于 Native 空间；页面提示「测试需要 Mnemon CLI」就是这个意思。

**E4 已有记忆没有向量 → 不参与语义匹配。**
现象：新写的能语义搜到，老的搜不到。
怎么办：页面里给对应空间点「补齐」（可能要多点几次，分批补）。

**E5 隐私：开启后记忆正文会发到该 Endpoint。**
远程 HTTP 是明文。只给本地或 HTTPS 服务开。

**E6 `apiKey` 存在 DSH 设置文件里，会跟着设置备份走。**别把带 key 的设置文件打包分发。

### F. 会话、升级、老数据

**F1 升级不会重建 `.mnemon`。**
换插件版本不搬、不清数据。但**降级**前先 ZIP 备份（新版本可能写了老版本读不懂的结构）。

**F2 老会话（v0）里的 Mnemon 摘要/子代理描述会让新版本认不出会话。**
现象：老会话打不开 / 工具报未知结构 / 子代理结果对不上。
怎么办（先停 DSH、先备份）：
```powershell
node "<本包>\plugin\dsh-mnemon\bin\repair-legacy-session.mjs" --help
node "<本包>\plugin\dsh-mnemon\bin\repair-legacy-session.mjs" --input <会话文件>                 # 只预览，不写
node "<本包>\plugin\dsh-mnemon\bin\repair-legacy-session.mjs" --input <会话文件> --output <新文件>  # 写新文件
```
它**不覆盖输入、也不覆盖已存在的输出**；有无法修复的形状时退出码 1、不写文件。修完的副本仍要 DSH 自己再校验。

**F3 备份/恢复。**
页面 ZIP 备份**包含私有记忆**（别乱传）；`state\`（本机身份）不在备份里。技能进化数据（建议、用例、复盘读过的对话）在存储根目录，**也不在备份之内**。

**F4 Git 同步默认关（`syncEnabled: false`）。**
开了会把同一份数据以可读文件发到你自己的仓库（默认分支 `mnemon-sync`、子目录 `mnemon/`），token 走环境变量或宿主凭据存储，别写进配置。

**F5 技能自进化默认关。**
在「可组合记忆 → 技能管理」里开；它只提建议 + 回测，**没有你采纳不会改任何 `SKILL.md`**。市场装的技能会被原文执行，安装前先预览。

### G. 开关与行为（`cordis.patch.yml` 默认值）

| 键 | 默认 | 踩坑点 |
|---|---|---|
| `routingGuidance` | `true` | 关掉模型就不知道自己该去查记忆，表现为「什么都想不起来」 |
| `lifecycleEnabled` | `true` | 关掉 = 不组装 View，页面/工具基本停摆 |
| `recallMode` | `guided` | `off` 只是不再提示；工具仍可用 |
| `writebackMode` | `guided` | 同上 |
| `idleReviewMs` | `30000` | 空闲 30 秒触发回顾；调太小学浪费 token |
| `tabEnabled` | `true` | 侧栏入口 |
| `writeEnabled` | `true` | **总写开关**；`false` = 整个插件只读（所有写工具回只读提示） |
| `remoteAccess` | `read-only` | 远程连接只能看；要远程管理改 `trusted-host` 并重启。现象：在非本机页面点保存没反应/提示只读 |
| `displayMode` | `sidebar` | `builtin` 挂到内置页里 |
| `embedding.enabled` | `false` | 见 E 段 |
| `recallQuality` | `strict-v1` | 阈值调松噪声大、调紧召回少 |
| `storageScope` / `dataDir` | `global` / — | 见 B 段；`custom` 必须给 `dataDir` |
| `runtimeMemory.memoryLimitBytes` / `userLimitBytes` | `10240` / `4096` | 见铁律 2 |
| `cliPath` | 空（自动找） | 自动找不到时填绝对路径 |
| `timeoutMs` / `defaultRecallLimit` | `10000` / `10` | 远端 Provider 慢就调大超时 |
| `syncEnabled` | `false` | 见 F4 |

改 `cordis.patch.yml` 或在 profile 的 cordis 配置里按 id 覆盖，然后**重启 DSH**。

### H. 工具选型（用错工具 = 白烧一轮）

| 想干的事 | 用哪个 |
|---|---|
| 改热记忆（偏好/约定/环境事实） | `mnemon_runtime_memory` |
| 建/改/归档成篇资料 | `mnemon_document_create` / `mnemon_document_manage` |
| 搜成篇资料 | `mnemon_document_search` |
| 看有哪些记忆空间 | `mnemon_memory_bodies` |
| 从记忆空间召回证据 | `mnemon_recall`（+ `mnemon_related` 走图） |
| 往记忆空间存一条长期事实 | `mnemon_remember`（要精确控制就 `mnemon_memory_body_*`） |
| 看健康度/Provider 状态 | `mnemon_status` |
| 页面里的只读视图路由 | `mnemon_view_route` / `mnemon_view_action` |
| 子代理往回收结果 | `mnemon_subagent_result` |

常见错：拿 `mnemon_document_search` 去搜记忆空间的记忆（搜不到）；拿 `mnemon_recall` 去搜档案（搜不到）；把一次性进度写进热记忆（撑爆 10 KB）。

---

## 四、关键文件

包内：

| 路径 | 作用 |
|---|---|
| `plugin\dsh-mnemon\package.json` | 包清单：`main=lib/index.js`、`dsh.bundle.patch`、9 个 provider/4 个 source/5 个 strategy 的**精确版本依赖**、engines |
| `plugin\dsh-mnemon\cordis.patch.yml` | 默认挂载与**所有默认开关**（见 G 段）；`id: mnemon` 是配置入口 |
| `plugin\dsh-mnemon\lib\index.js` | Core/Host：配置 schema、存储根、Provider 编排、工具定义、页面 RPC |
| `plugin\dsh-mnemon\lib\client.js` | 全部页面 UI（记忆系统 / 可组合记忆） |
| `plugin\dsh-mnemon\bin\repair-legacy-session.mjs` | 老会话修复（`--input` / `--output` / `--help`） |
| `plugin\dsh-mnemon\README.zh-CN.md` | 官方中文说明（功能全集，值得读） |
| `plugin\dsh-mnemon\SECURITY.md` | 信任边界（Source/Strategy 是**受信任的进程内代码**，不是沙箱） |
| `plugin\node_modules\dsh-mnemon-source-runtime\` | 热记忆：容量、投影、锁、归档 |
| `plugin\node_modules\dsh-mnemon-source-documents\` | 项目档案：索引、10MB 上限、归档 |
| `plugin\node_modules\dsh-mnemon-source-memory-spaces\` | 记忆空间父组件 + Provider SDK + **Native CLI 解析**（`lib\native-cli.js`） |
| `plugin\node_modules\dsh-mnemon-source-skills\` | 技能管理（实验性） |
| `plugin\node_modules\dsh-mnemon-strategy-default-three-tier\` | 默认主策略（分层） |
| `plugin\node_modules\dsh-mnemon-strategy-{general,auto-capture,light-context,scoped}\` | 另外 4 条策略（默认关） |
| `plugin\node_modules\dsh-mnemon-provider-*\` | 9 个 Provider 驱动 |
| `plugin\node_modules\{zod,yaml,fflate,markdown-to-jsx}\` | 外部运行时依赖（少一个就 `ERR_MODULE_NOT_FOUND`） |
| `install.ps1` | 离线落位（复制 23 个目录，幂等） |
| `docs\quickstart.md` | 装完怎么用（三层记忆、档案、空间、开关、容量） |

运行时（`<DSH_HOME>` 默认 `%USERPROFILE%\.dsh`；`<root>` 默认 `%USERPROFILE%\.mnemon`）：

| 路径 | 作用 |
|---|---|
| `<root>\runtime\memories.json` | 热记忆**事实源** |
| `<root>\runtime\MEMORY.md` / `USER.md` | **投影**，每轮注入；别手改 |
| `<root>\runtime\archived\` | 容量整理挤出去、又没有可写空间时的本地归档 |
| `<root>\runtime\.memories.lock` | 锁文件（30 秒陈旧） |
| `<root>\documents\index.json` | 档案**控制面事实源** |
| `<root>\documents\active\` / `archived\` | 活跃档案（≤10MB）/ 冷归档（不占额度） |
| `<root>\state\machine.json` | 本机身份（不进备份） |
| `<DSH_HOME>\profiles\<profile>\package.json` | 装插件要改的 `dependencies` + `dsh.profile.bundles` |
| `<DSH_HOME>\profiles\<profile>\node_modules\dsh-mnemon\` | 插件实际落地位置 |

---

## 五、自检清单（复制就能跑，期望值写在注释里）

```powershell
$Dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$Pkg = '<本包目录>'
$Prof = Join-Path $Dsh 'profiles\desktop'          # profile 名按实际改
$Root = if ($env:MNEMON_DATA_DIR) { $env:MNEMON_DATA_DIR } else { Join-Path $env:USERPROFILE '.mnemon' }

# 1. 插件本体在不在 → 期望 True / 0.5.39
Test-Path (Join-Path $Prof 'node_modules\dsh-mnemon\lib\index.js')
([IO.File]::ReadAllText((Join-Path $Prof 'node_modules\dsh-mnemon\package.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json).version

# 2. 22 个依赖目录齐不齐 → 期望 22, 缺 0
$nm = Join-Path $Prof 'node_modules'
$need = @(Get-ChildItem (Join-Path $Pkg 'plugin\node_modules') -Directory -Force | ForEach-Object { $_.Name })
"应有 $($need.Count) / 缺 $((@($need | Where-Object { -not (Test-Path (Join-Path $nm $_)) })).Count)"

# 3. profile 认领了吗 → 期望两行都命中 dsh-mnemon
Select-String -Path (Join-Path $Prof 'package.json') -Pattern 'dsh-mnemon'

# 4. 数据目录与事实源 → 期望 True + 文件大小
Test-Path $Root
Get-ChildItem (Join-Path $Root 'runtime') -Force -ErrorAction SilentlyContinue | Select-Object Name,Length

# 5. 热记忆容量 → 期望 MEMORY < 10240、USER < 4096
$m = Join-Path $Root 'runtime\MEMORY.md'; $u = Join-Path $Root 'runtime\USER.md'
if (Test-Path $m) { "MEMORY.md = $((Get-Item $m).Length) / 10240" }
if (Test-Path $u) { "USER.md = $((Get-Item $u).Length) / 4096" }

# 6. 档案上限 → 期望 active 合计 < 10485760
$act = Join-Path $Root 'documents\active'
if (Test-Path $act) { "documents\active = $((Get-ChildItem $act -Recurse -File | Measure-Object Length -Sum).Sum) / 10485760" }

# 7. Mnemon CLI（用记忆空间才需要）→ 期望打印路径
$cli = if ($env:MNEMON_CLI_PATH) { $env:MNEMON_CLI_PATH } else { (Get-Command mnemon -ErrorAction SilentlyContinue).Source }
if ($cli) { & $cli --version } else { 'CLI 未找到（热记忆/档案不依赖它，记忆空间才依赖）' }

# 8. 脚本自检 → 期望 errors=0 且 bom=True
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Pkg 'install.ps1'),[ref]$null,[ref]$e); "errors=$($e.Count)"
$b=[IO.File]::ReadAllBytes((Join-Path $Pkg 'install.ps1')); "bom=" + ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)

# 9. 嵌入服务（可选，开了才需要）→ 期望 200
try { (Invoke-WebRequest -Uri 'http://localhost:11434/api/tags' -TimeoutSec 3 -UseBasicParsing).StatusCode } catch { 'ollama 未运行（embedding 默认关，不影响基本功能）' }
```

模型侧再验两下（比文件检查更真实）：

- 让模型调 `mnemon_status` —— 应返回组件/Provider 状态。
- 让它 `mnemon_document_search`（空查询）—— 应列出最近档案；`mnemon_recall` 一个明确主题 —— 有激活空间时应有结果、没有时是空但不报错。

---

## 六、症状 → 排查

| 症状 | 先查 |
|---|---|
| 插件页 `failed to import` / `ERR_MODULE_NOT_FOUND` | 是不是 `link:`；22 个依赖目录齐吗；`markdown-to-jsx` 在不在（A1） |
| 侧栏没有「记忆系统」 | `bundles` 加了吗；重启了吗；装错 profile 了吗（A2/A5/A6） |
| 装好一阵子又突然没了 | 是不是跑过 `pnpm install` 清掉了（A3） |
| 页面能开、全报「只读」 | `writeEnabled=false` 或 `remoteAccess=read-only` 且你不是本机（G） |
| `mnemon_runtime_memory` 报 `runtime-capacity` | 10KB/4KB/单条 8KB 满了（B3、铁律 2） |
| 手改 `MEMORY.md` 后内容消失 | 它是投影（铁律 2） |
| 记忆好像「全部没了」 | 换过 `storageScope`/`dataDir`，或 `MNEMON_DATA_DIR` 变了（B2） |
| `mnemon_document_search` 搜不到 | 搜的是记忆空间；或文档已冷归档（C3、铁律 3） |
| 建档案被拒 / 提示先迁移 | `active` 到 10MB 了（C2） |
| 归档后原文找不着 | 归档可能只落了本地目录、没建冷索引（C4） |
| `mnemon_recall` 一直空 | 空间没激活 / Provider 没启用 / Native 缺 CLI（D1/D2/D3） |
| `mnemon_status` 说 CLI 不可用 | `npm i -g @mnemon-dev/mnemon`，或 `cliPath` / `MNEMON_CLI_PATH`（D1） |
| 写入回执是 pending | 异步远端 Provider 正常行为（D6） |
| `mnemon_related` 说不支持 | 该 Provider 不支持图遍历（D4） |
| 语义搜不到同义词 | `embedding.enabled=false`，或已存记忆没向量（E1/E4） |
| 开了 embedding 没效果 | ollama 不在 11434 / 模型没拉 / 只在 Native 生效（E2/E3） |
| 老会话打不开、子代理结果错乱 | 跑 `repair-legacy-session.mjs`（先停 DSH、先备份）（F2） |
| 升级后想回退 | 先在旧版本里 ZIP 备份，别直接降级（F1） |
| 两台机器记忆串了 | 是不是把 `state\machine.json` 也拷过去了（B6） |
| 技能改了但没生效 | 自进化要你「采纳」才动文件（F5） |
| Git 同步老是冲突 | 同主题两边写法不同都会保留，要跑「记忆整理」接受方案（F4） |

---

## 七、本包不含什么

| 不含 | 为什么 | 怎么补 |
|---|---|---|
| 记忆数据 `.mnemon\`（runtime/documents/state） | 隐私，且是本机状态 | 装完自动生成；迁移用页面 ZIP 备份或 `MNEMON_DATA_DIR` |
| `@deepseek-ai/*`、`react`、`react-dom` | 宿主提供（手动装会版本打架） | 什么都不做；缺了是宿主问题 |
| Mnemon CLI 二进制 | npm 包只是驱动 | `npm i -g @mnemon-dev/mnemon`，或配 `cliPath` |
| 嵌入模型（`nomic-embed-text` 等） | 几百 MB 级，且要服务 | 本地 ollama：`ollama pull nomic-embed-text` |
| 第三方 Provider 的账号/key | 安全 | 在「记忆空间」页面各自配置，凭据留宿主 |
| 任何 `.log` / 备份 zip / Git 仓库 | 运行产物 + 隐私 | 运行后自动生成 |
| 用户自己的 `SKILL.md` / 技能数据 | 属于用户 | 插件读用户已有的技能目录 |

---

## 八、给下一个人/AI 的三句话总结

1. 三层记忆别混：**热记忆用 `mnemon_runtime_memory`（别手改 .md）、档案用 document 工具、空间用 recall/remember**。
2. 依赖铁律：**宿主给的不装、本地路径只用 `install.ps1` 复制、`markdown-to-jsx` 别漏**；改完 `package.json` 两处再重启。
3. 数据在 `~/.mnemon`；容量 10KB/4KB 自动归档、档案 10MB 归档不占额度、换 `storageScope` 不搬数据——先备份再动。
