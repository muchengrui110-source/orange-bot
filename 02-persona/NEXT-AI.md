# 给下一个 AI 的交接说明（先读完再动手）

**一句话**：这是 DSH 的「身份与人设」插件（`dsh-persona` 1.4.0）。它本身不跟 QQ 通信，只做一件事——在 DSH 设置里提供一个页面，读写 **QQ 桥接**用的那份人格文件 `<DSH_HOME>\qq-bridge\personas.json`，并且能联网把一个角色名学成人设。想让机器人换性格、改说话方式，装的是**这个包**；想让机器人能收发 QQ 消息，装的是 QQ 桥接包。

数据流：

```
QQ ↔ NapCat ↔ OneBot v11(WS) ↔ dsh-qq-bridge（插件）──┐
                                                        │ 每次收消息都重新读同一个文件
                                                        ▼
                                    <DSH_HOME>\qq-bridge\personas.json
                                                        ▲
                                                        │ 宿主侧 HTTP 路由（不占端口）
    DSH 设置页「身份与人设」                           │
    plugin\lib\client.js ──fetch──> plugin\lib\index.js ┘
                                      ├─ /dsh-persona/api/personas   读 / 保存（含备份 + 冲突检测）
                                      ├─ /dsh-persona/api/learn      联网学角色（萌娘百科/360/Bing + 当前模型）
                                      ├─ /dsh-persona/api/speech     说话习惯统计
                                      └─ /dsh-persona/api/split      长文本拆分
                                    运行时会生成 speech-habits.json（只存数字，不存原话）
```

要点：

- **不占端口**。API 挂在 DSH 自己的 web 服务上，路由前缀 `/dsh-persona/api/`。所以「端口冲突」这类排查在这个插件上不适用。
- **没有第三方依赖**。不用联网装依赖，`npm pack` 出来就能装。
- **它和桥接共享一个文件**，不是共享进程。两边各读各的；谁改了文件，另一边下一条消息就能看到（桥接每条消息都重读）。

---

## 一、安装顺序（别跳步）

1. **先装 QQ 桥接（强烈建议，不是硬性）**
   桥接第一次跑起来会创建 `<DSH_HOME>\qq-bridge\personas.json`。没装桥接，人设页也能装、能开，但那个目录和文件不存在，配了没人用。
   期望：`<DSH_HOME>\qq-bridge\` 目录存在。

2. **解压本包到固定目录**（别放临时目录，插件安装后 DSH 还会去读包里的 `templates\`）。

3. **跑落位脚本**

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   期望输出：
   ```
   [OK]   包内自检通过：dsh-persona 1.4.0
   DSH_HOME: <你的 DSH_HOME>
   [OK]   已放模板：<DSH_HOME>\qq-bridge\personas.template.json
   ```
   已有同名模板时是 `[保留] 已存在，保留不动`。加 `-Force` 才覆盖。参数 `-DshHome <路径>` 可指定 DSH_HOME。

4. **打成 tgz**

   ```powershell
   cd .\plugin
   npm pack
   ```

   期望：目录里出现 `dsh-persona-1.4.0.tgz`（约 50~60KB）。

5. **装进 DSH**：插件页 → 添加插件 → 选那个 tgz → 安装 → 启用。
   或者插件页直接搜包名 `dsh-persona` 装 1.4.0。

6. **重启 DSH**。
   期望：重启后左下角账号菜单 → 设置 → 左侧出现「身份与人设」（英文界面叫 Identity & Persona）。

7. **第一次打开页面**：看到「身份（默认人格）」「QQ 会话人格」「角色库」「规则」四块即成功。
   第一次保存后才会真的生成 `personas.json`；打开页面本身不写盘。

---

## 二、三条铁律（违反会浪费你半天）

**1. 永远别用「从本地文件夹安装」装这个插件，也别在 profile 里写 `link:`。**

- 现象：插件页显示 `failed to import`，或者插件装了但设置里没有「身份与人设」页；日志里 `ERR_MODULE_NOT_FOUND`。
- 原因：pnpm 对本地路径只会建软链（`link:`），不会解析依赖、也不会走 DSH 的 bundle 认领流程；有些版本连 `exports` 都对不上。
- 正确做法：`cd plugin && npm pack` 出 tgz 再装，或按包名装。见第四节 B1。

**2. 人设页和桥接必须指向同一个 `personas.json`（同一个 `personaFile`）。**

- 现象：设置页里改得很爽、保存成功、页面也显示改了，**QQ 那边一个字都不变**。
- 原因：桥接的 `config.personaFile` 和本插件的 `config.personaFile` 是两个独立配置，默认值恰好相同（`<DSH_HOME>\qq-bridge\personas.json`）。只要有一边被人改过（换 DSH_HOME、迁过目录、改过桥接配置），两边就分叉了。
- 怎么办：
  - 确认两边实际路径：
    ```powershell
    # 桥接侧
    Select-String -Path '<DSH_HOME>\profiles\<profile>\cordis.patch.yml' -Pattern 'personaFile' -Context 1,1
    # 本插件侧
    Get-Content .\plugin\cordis.patch.yml
    ```
  - 统一：改本插件 `plugin\cordis.patch.yml` 里 `id: dsh-persona` 的 `config.personaFile`，或在 profile 的 cordis 配置里按 id 覆盖；改完**重启 DSH**。

**3. 分清「改 personas.json」和「改插件配置」——生效方式完全不同。**

- 改 `personas.json`（人格正文、模式、规则、角色库）→ **不用重启**，桥接下一条 QQ 消息就生效（桥接每条消息重读文件）。
- 改 `cordis.patch.yml` / `personaFile` / `speechFile` / `provider` / `model` / 插件代码 → **必须重启 DSH**（模块与配置有缓存）。
- 现象反过来最常见：改完 patch 没重启，折腾半天以为配置不生效；或者改个称呼就重启 DSH，白等一轮。

---

## 三、坑清单

### A. 安装与加载

**A1 从文件夹装 → 插件页 `failed to import`。**
原因：`link:` 软链 + 依赖不解析。怎么办：`npm pack` 出 tgz 装，见铁律 1。

**A2 只把 `plugin` 目录拷进 DSH，没打 tgz。**
现象：安装「成功」但页面空白 / 控制台报找不到 `templates/personas.template.json`。
原因：插件用 `path.resolve(包根, 'templates', 'personas.template.json')` 找模板，包根结构不对就找不到，会退化到空骨架（`default.prompt` 为空）。
怎么办：整个 `plugin` 目录按包结构装（`package.json`、`lib\`、`templates\` 同一层），别只挑 `lib\`。

**A3 profile 的 `dsh.profile.bundles` 里没加 `dsh-persona`。**
现象：`node_modules` 里有这个包，但设置里没这一页。
原因：bundle 没被 profile 认领，插件没被 mount。
怎么办：profile 的 `package.json` 里两处都要有：
```json
{
  "dependencies": { "dsh-persona": "1.4.0" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-persona" ] } }
}
```
然后在该 profile 目录 `pnpm install`，重启 DSH。

**A4 装完没重启 DSH。**
现象：设置里就是没有「身份与人设」。
怎么办：重启。热重载在插件页里做（禁用 → 启用），有时也不够，重启最稳。

**A5 装了两份（一份 tgz、一份包名）→ 设置页出现两页同名。**
原因：DSH 会按不同来源各 mount 一个。
怎么办：插件页里卸掉多余的，`bundles` 里也只留一条。

### B. 和 QQ 桥接的关系（最容易搞错的一段）

**B1 第一次打开页面看到的是**空白人格**，不是示例角色。**
现象：`default.prompt` 是空的，角色库空的，以为模板没生效。
原因：桥接先启动时，会用**它自己的极简模板**创建 `personas.json`（`default.prompt: ""`，无 `characters`）。本插件的模板（内含「蓝色示例角色」）**只在 `personas.json` 完全不存在时**才会被当作初始内容，且**不会覆盖已有文件**。
怎么办（任选）：
- 直接页面里改；或
- 角色库里点「套用」把示例角色复制成当前会话模式；或
- 备份后删掉空的 `personas.json`，重启 DSH 让本插件用模板初始化（删之前先 `Copy-Item personas.json personas.json.manual-bak`）。

**B2 桥接没装 → `<DSH_HOME>\qq-bridge\` 不存在。**
现象：设置页能打开、能编辑、能保存（插件会自己 `mkdir -p`），但 QQ 那边没有任何反应（因为根本没桥接在跑）。
怎么办：先装桥接。人设页只是编辑工，不负责发消息。

**B3 改了 `personas.json` 里的 `chats` 键，写错格式 → 该会话一直用默认人格。**
原因：会话键是固定格式 `private:<QQ号>` / `group:<群号>`，写错（少冒号、用中文冒号、号码带空格）就对不上。
怎么办：在页面里通过「QQ 会话人格」列表选会话（它会读桥接落下的会话表），别手拼键名。

**B4 桥接读了旧内容。**
现象：刚保存完，QQ 里还是旧语气。
原因：桥接在**消息处理的最开始**读文件；正在处理的那一条仍用旧内容。
怎么办：等下一条；若还不变，按铁律 2 查两个 `personaFile` 是否同一个。

### C. `personas.json` 结构

顶层只有 5 个键，多写的键会被原样保留（不会丢，也不报错）：

```jsonc
{
  "version": 1,
  "note": "随便写，只是给人看的",
  "default": { "title": "默认", "prompt": "默认人格正文" },
  "chats": {
    "private:10001": {
      "active": "模式名",
      "modes": {
        "模式名": "一整段文字（老格式）",
        "另一个模式": {
          "title": "显示名",
          "identity": "你是谁",
          "behavior": "什么时候开口",
          "replyStyle": "怎么说话",
          "variants": ["备用风格 A", "备用风格 B"],
          "variantChance": 0.2
        }
      }
    }
  },
  "rules": { "规则名": "规则正文" },
  "characters": { "角色名": { "name": "...", "summary": "...", "prompt": "..." } }
}
```

**C1 模式有两种格式，可以在同一个 `modes` 里混用。**
- 老格式：字符串，`trim()` 后原样注入。
- 新格式：对象，按固定顺序拼成三段带小标题的正文：
  ```
  你是谁：
  <identity>

  什么时候开口：
  <behavior>

  说话方式：
  <replyStyle>
  ```
  空段整段跳过（连标签都不出）；三段全空 = 空正文。
- 现象：页面里预览的正文和 QQ 里实际注入的不一样。
  原因：有人只改了本插件的 `lib/mode.js` 而没同步桥接的 `lib/index.js`（两边各有一份 `composeModeBody`，标签文字与顺序是两边一字不差的约定）。
  怎么办：两边一起改，标签一个字都别动。

**C2 各字段有硬上限，超了静默截断（不报错）。**
- 模式三段：`identity` 4000 字、`behavior` 3000 字、`replyStyle` 4000 字；`title` 60；`variants` 最多 8 条、单条 200 字；`variantChance` 0~1（保留 3 位小数，≤0 视为 0）。
- 角色库：`title` 120 / `summary` 400 / `personality` 3000 / `speechStyle` 4000 / `address` 400 / `prompt` 20000；`catchphrases` / `examples` / `taboos` 各最多 20 条、单条 400 字。
- 现象：粘了一大段，保存后发现尾巴没了。原因就是这些上限。怎么办：写短、把细节拆成 `variants` 或角色字段。

**C3 `active` 指向不存在的模式名 → 自动落到第一个模式。**
现象：切了模式但语气没变。
怎么办：打开会话看一下 `active` 到底指向哪个模式名（大小写、空格都算不同）。

**C4 `chats` 里一个模式都没有 → 校验直接拒。**
现象：保存报错「会话「xxx」里有重复的性格名」或结构校验失败。
原因：`chats.<键>` 必须至少一个模式；模式名不能重复。
怎么办：先删掉空会话项，或在页面里正常「+ 新增模式」。

**C5 「套用」是复制，不是引用。**
现象：在角色库里把角色改了，套用过它的会话**没有跟着变**；反过来也一样。
原因：套用 = 把角色 `prompt` 复制成目标会话的一个模式（模式名 = 角色名）并设为 `active`，之后两边独立。
怎么办：改完角色再「套用」一次覆盖。想长期只维护一份，就把共用内容写进 `rules`。

**C6 `rules` 的拼接规则（三个细节，都有坑）。**
桥接在拼提示词时把 `rules` 接在人格正文后面（`composePersonaText`）：
- **总上限 6000 字**（常量 `PERSONA_RULES_MAX_CHARS`）。按 `Object.entries` 顺序累加，**超了的那条直接跳过**（不是截断），所以排在后面的规则可能永远不生效。
- **前 24 个字和当前模式正文重复的规则会被跳过**（判重逻辑 `body.includes(head)`，`head = value.slice(0, 24)`）——为了避免同一个意思说两遍白烧 token。
- 空值忽略；每条渲染成 `· 规则名：正文`，上面加一行「【共用规则】所有人格都适用」。
- 现象：写了 10 条规则，QQ 里只吃进去前几条。原因就是 6000 字上限。怎么办：规则写短句，把长内容挪进模式正文。

**C7 不认识的顶层字段会被原样保留，但保存时按 JSON 重排（缩进 2 空格）。**
现象：手写的注释（`//`）保存后全没了、报 JSON 错。
原因：`personas.json` 是严格 JSON，不支持注释。怎么办：注释写进 `note` 字段。

### D. 保存、备份与冲突

**D1 保存报 **409**，提示「重新读取」。**
原因：页面打开后文件被别处改过（agent 手改、另一个窗口、脚本）。插件用 `baseMtimeMs` 做乐观锁，对不上就 fail-closed，**不静默覆盖**。
怎么办：点「重新读取」再改；或手动合并后再读。

**D2 每次保存都会先备份成 `personas.json.bak-YYYYMMDD-HHMMSS`，只留最近 20 份。**
现象：目录里一堆 `.bak-*`，占地方。
怎么办：这是设计如此，别手动删最新的那几份。文件坏了就用最近一份覆盖回去。

**D3 写盘是「临时文件 + 原子改名」，不会留半个 JSON。**
但备份失败时会照常保存（只是没备份）。现象：保存成功但没生成 `.bak`。原因：目录权限/被占用。怎么办：先确认目录可写。

**D4 保存报「信任栅栏不可用」。**
原因：不是从 DSH 自己的页面打开的（比如用浏览器直接访问 API），或宿主 `connection` 服务不可用。写操作 fail-closed。
怎么办：从 DSH 的设置页操作；别用 curl 直接打保存接口。

**D5 手改了文件，但页面上显示的还是旧的。**
原因：页面是打开时读的快照。怎么办：点「重新读取」。

### E. 联网学角色（`/dsh-persona/api/learn`）

**E1 资料源是直连的，不要 API key**：萌娘百科、360 百科、360 搜索、Bing。提炼用的是 DSH **当前默认模型**，可用 `config.provider` / `config.model` 固定。

**E2 360 系会弹验证码（IP 限流）。**
现象：学习进度卡在「搜索」很久，或结果明显变差。
原因：360 百科/搜索被限流，流程降级成「萌娘 + 搜索摘要」。
怎么办：等一会儿再试；或换网络；或干脆手写人设更快。学习任务**不写盘**，失败不会污染文件。

**E3 学出来的结果只在内存里留 30 分钟**（`JOB_TTL_MS = 30 * 60 * 1000`），点「存入角色库」才写 `personas.json`。同时最多 2 个学习任务（`MAX_RUNNING = 2`），超了报「已经在学别的角色了」。

**E4 抓回来的东西必须人工核，别直接存。**
- 百科里的「设定」经常是二创拼的、或者干脆是另一个角色；`sources` 里给的是抓取来源，不是事实保证。
- 重点核：称呼、口头禅、性格反差、有没有把「某位真人/某个具体账号」的话当成角色设定（这就是隐私风险）。
- 现象：学出来的角色说话会冒出某个人名/某个账号的梗。怎么办：手动删掉那句，再存。

**E5 别把账号主人的私人信息喂进「补充说明」(`extra`) 或人格正文。**
`extra` 会进搜索与提炼上下文。要写「他喜欢的称呼」这种，用泛化说法。

**E6 学出来的角色会自动加一段「底线」**（`SAFETY_FOOTER`，含不承认是 AI、不对外透露真名/学校/学号/住址/手机号/账号/家人感情、不发照片截图路径）。
**但手写的模式、`default`、`rules` 不会自动加**——手动写人格时，隐私红线要自己抄进正文。这是最容易漏的一条。

**E7 学习任务不写盘、不改 `personas.json`；但它会把结果临时放内存 30 分钟。**重启 DSH = 未保存的学习结果全丢。

### F. 说话习惯统计（`speech-habits.json`）

**F1 只存数字，不存原话。**统计你自己的消息长度、行数、断句标点（句号/逗号/感叹号/问号/省略号/空格），桥接/系统拼出来的提示词不会被当成「人打的字」计入。
文件位置默认是 `personas.json` 旁边（`config.speechFile` 可改）。

**F2 攒够 8 条样本才生成节奏提示。**样本不够时页面上没有那段提示，不是坏了。

**F3 「清空统计」只清统计，不动人格文件。**别指望它恢复人格。

### G. 与语音插件联动

**G1 语音脚本按当前模式名去 `personas.json` 里读 `replyStyle` 抽语气。**
- 模式是老格式字符串 → 取不到 `replyStyle`，只能退回拿整段正文当 base，语气抽取会弱。
- 现象：语音发出来语气和文字人设对不上。怎么办：把模式改成三段式对象，把语气相关的写进 `replyStyle`。

**G2 发语音时桥接会带 `-Persona "<当前性格模式>"`。**模式名改了/重名了，语音就找不到对应语气。改模式名要两边一起看。

### H. 模板与人格内容（给维护者/写人设的人）

**H1 `plugin\templates\personas.template.json` 只在 `personas.json` 不存在时被当作初始内容，永不覆盖已有文件。**
现象：改了模板，已装好的人一点变化都没有。原因就是这个。怎么办：要么页面里手动改，要么备份后删 `personas.json` 重启。

**H2 模板只是**起步**。**里面那个「蓝色示例角色」是 DeepSeek 鲸鱼娘的二创人格，**默认人格就是它**——不换成自己的，机器人就会以这个身份说话。第一次用请至少改 `default.prompt`。

**H3 模板里的 `sources` 是收集素材的来源记录，不是「事实保证」，也不该含任何真实账号。**分发/二次分发前扫一遍（本包已经清过一遍）。

**H4 隐私红线写进正文，不要只写在文档里。**建议每个会话模式都带这三类：
- 不承认是 AI/模型/助手；
- 对外人（群、陌生人、私信里不熟的人）不透露账号主人的真名、学校、专业、学号、生日、住址、手机号、微信号、QQ 号、其他平台账号、家人与感情情况，不发照片/视频/截图/文件路径；
- 短句、口语、一句一条，不列清单、不总结陈词、不说教、不客服腔。
（`E6` 的自动底线就这三条；手写模式请自己抄。）

---

## 四、关键文件

包内：

| 路径 | 作用 |
|---|---|
| `plugin\package.json` | 包清单：`main = lib/index.js`，`dsh.bundle.patch = ./cordis.patch.yml` |
| `plugin\cordis.patch.yml` | 往 profile 插入 `id: dsh-persona` 一行；`config.personaFile / speechFile / provider / model` 在这里改 |
| `plugin\lib\index.js` | 宿主半边：读/写 `personas.json`（备份、原子写、409 冲突）、四个 API 路由、首次用模板初始化 |
| `plugin\lib\client.js` | 设置页「身份与人设」的全部 UI |
| `plugin\lib\learn.js` | 联网学角色：搜资料 → 拼语料 → 调模型提炼 → 加 `SAFETY_FOOTER` 底线 |
| `plugin\lib\parse.js` | 网页解析（萌娘/360 百科正文、防复制噪声、搜索结果） |
| `plugin\lib\speech.js` | 说话习惯统计与节奏提示（只存数字） |
| `plugin\lib\mode.js` | 三段式模式的字段、上限、`composeModeBody`（与桥接同约定） |
| `plugin\lib\split.js` | 长文本拆分 |
| `plugin\templates\personas.template.json` | 唯一的人格模板（示例角色 + 角色库资料） |
| `plugin\locale\{zh,en}.json` | 设置页标题：身份与人设 / Identity & Persona |
| `docs\persona.md` | 功能与字段说明（给人看的） |
| `install.ps1` | 落位脚本：校验、放模板、打印装法 |

运行时（不在包里，`<DSH_HOME>` = 默认 `%USERPROFILE%\.dsh`）：

| 路径 | 作用 |
|---|---|
| `<DSH_HOME>\qq-bridge\personas.json` | 人格正文（本插件与桥接共享的唯一事实源） |
| `<DSH_HOME>\qq-bridge\personas.json.bak-*` | 保存前自动备份，留最近 20 份 |
| `<DSH_HOME>\qq-bridge\personas.template.json` | `install.ps1` 放的模板副本 |
| `<DSH_HOME>\qq-bridge\speech-habits.json` | 说话习惯统计（只存数字） |
| `<DSH_HOME>\profiles\<profile>\package.json` | 装插件要改的 `dependencies` + `dsh.profile.bundles` |
| `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` | 按 id 覆盖 `dsh-persona` 配置的地方 |

---

## 五、自检清单（装完逐条跑，期望值写在注释里）

```powershell
# 0. 路径（按实际改）
$Pkg = '<包目录>'
$Dsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

# 1. 包内关键文件都在 → 期望 5 个 True
@(
  (Test-Path "$Pkg\plugin\package.json"),
  (Test-Path "$Pkg\plugin\lib\index.js"),
  (Test-Path "$Pkg\plugin\templates\personas.template.json"),
  (Test-Path "$Pkg\plugin\cordis.patch.yml"),
  (Test-Path "$Pkg\install.ps1")
)

# 2. 版本对 → 期望 dsh-persona 1.4.0
$j = [IO.File]::ReadAllText("$Pkg\plugin\package.json",[Text.Encoding]::UTF8) | ConvertFrom-Json
"$($j.name) $($j.version)"

# 3. 模板是合法 JSON、示例角色在、来源条数 → 期望 JSON OK sources=9
$t = [IO.File]::ReadAllText("$Pkg\plugin\templates\personas.template.json",[Text.Encoding]::UTF8) | ConvertFrom-Json
"JSON OK sources=$($t.characters.'蓝色示例角色'.sources.Count)"

# 4. 模板来源已脱敏 → 期望 True 和 False
$raw = [IO.File]::ReadAllText("$Pkg\plugin\templates\personas.template.json",[Text.Encoding]::UTF8)
$raw.Contains('moegirl.org.cn/DeepSeek%E5%A8%98')   # True：萌娘条目指向通用页
$raw.Contains('search.bilibili.com/all?keyword=')   # True：B站来源是搜索页，不是某个具体账号的视频

# 5. 人格文件在不在、结构对不对 → 期望 exists=True modes=...
$pf = Join-Path $Dsh 'qq-bridge\personas.json'
"exists=" + (Test-Path $pf)
if (Test-Path $pf) {
  $p = [IO.File]::ReadAllText($pf,[Text.Encoding]::UTF8) | ConvertFrom-Json
  "default.title=$($p.default.title)  chats=$(@($p.chats.PSObject.Properties).Count)  rules=$(@($p.rules.PSObject.Properties).Count)  characters=$(@($p.characters.PSObject.Properties).Count)"
}

# 6. install.ps1 语法 0 错误 + 有 BOM → 期望 0 和 True
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("$Pkg\install.ps1",[ref]$null,[ref]$e); $e.Count
$b=[IO.File]::ReadAllBytes("$Pkg\install.ps1"); ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)

# 7. 插件真的被 profile 认领 → 期望两行都能搜到 dsh-persona
Select-String -Path (Join-Path $Dsh 'profiles\<profile>\package.json') -Pattern 'dsh-persona'
```

最后一条**人工验**：打开 DSH → 设置 → 身份与人设，改一句「自称」，保存；在 QQ 里给机器人发一句话，看它下一条回复有没有换自称。换了 = 全线打通。

---

## 六、症状 → 排查

| 症状 | 先查 |
|---|---|
| 插件页 `failed to import` | 是不是从文件夹装的（铁律 1）；有没有走 `npm pack` 的 tgz |
| 设置里没有「身份与人设」 | 插件启用了吗？profile 的 `bundles` 里有 `dsh-persona` 吗？重启过吗？（A3/A4） |
| 页面能打开但一片空白 / 报找不到模板 | `templates\personas.template.json` 在不在包根同层（A2） |
| 设置页改了，QQ 没变 | 两边 `personaFile` 是不是同一个（铁律 2）；该会话 `active` 指向哪个模式（C3）；桥接是否在跑（B2） |
| 打开页面看到空白人格，不是示例角色 | 桥接先建了空的 `personas.json`，模板不覆盖已有文件（B1） |
| 保存报 409 | 文件被别处改过 → 点「重新读取」（D1） |
| 保存报「信任栅栏不可用」 | 不是从 DSH 页面打开 / 宿主 `connection` 服务异常（D4） |
| 保存成功但重启后回退 | 有没有改到另一份 `personas.json`（铁律 2）；备份 `.bak-*` 里挑最近一份对比 |
| 保存后内容被截断 | 打到字段上限了（C2） |
| 规则写了不生效 | 超 6000 字被跳过，或前 24 字与正文重复被判重（C6） |
| `personas.json` 打不开 / 报 JSON 错 | 手写注释了，或半个文件（C7/D2）；用最近的 `.bak-*` 覆盖回去 |
| 学角色卡在「搜索」 | 萌娘/360/Bing 不通或 360 验证码（E1/E2） |
| 学角色报「已经在学别的角色了」 | 同时最多 2 个任务（E3），等它结束 |
| 学出来的角色名字/梗不对 | 资料是二创拼的，必须人工核（E4） |
| 语音语气和文字人设不一致 | 模式是老格式字符串，取不到 `replyStyle`（G1） |
| 改完 `cordis.patch.yml` 没反应 | 没重启 DSH（铁律 3） |
| 保存后目录里多出一堆 `.bak-*` | 正常，只留 20 份（D2） |

---

## 七、本包不含什么（要自己补的）

| 不含 | 为什么 | 怎么补 |
|---|---|---|
| `personas.json`（真实人格正文） | 属于用户隐私数据，不进包 | 桥接首次启动会建一份极简的；或用本包模板初始化；或页面里现写 |
| `speech-habits.json` | 是运行产物，且含聊天节奏特征 | 插件运行后自动生成 |
| 任何真实角色/真人资料 | 脱敏红线 | 用页面「从互联网学习角色」现学，或自己写 |
| QQ 桥接插件 | 是另一个包 | 先装「QQ 桥接与 NapCat」那个包 |
| NapCat / OneBot 本体 | 同上 | 同上 |
| 语音插件（TTS）与音色文件 | 是另一个包 | 装「语音模型」那个包；音色靠用户自己录 |
| 模型权重 | 太大（GB 级），且与本插件无关 | 插件用 DSH 当前默认模型 |
| `.log` / `settings-ui.json` / `sessions.json` | 运行产物 + 隐私 | 运行时自动生成，别跨机器拷 |
| 插件更新器 | 无 | 换新版本就重复一遍「解压 → npm pack → 插件页装」 |

---

## 八、给下一个人/AI 的三句话总结

1. 这是个**编辑人格文件的设置页**，不碰 QQ 链路；QQ 链路是桥接包的活。
2. 装法只有一条正路：**`npm pack` 出 tgz（或按包名）**，别从文件夹装。
3. 改 `personas.json` 不用重启；改插件配置/`personaFile` 必须重启。两边指向同一个文件，否则永远白改。
