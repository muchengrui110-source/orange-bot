# 长期记忆插件 dsh-mnemon 0.5.39 · 安装说明

给 DSH 装一套分层长期记忆：**热记忆**每轮自动带上，**项目档案**按需检索，**记忆空间**存长期事实，外加实验性的**技能管理**。

- 版本：`dsh-mnemon` 0.5.39（随包 18 个子包 + 4 个外部依赖）
- 宿主要求：DSH `0.2.x`（`0.2.0-rc.2` 或 `0.2.1-rc.2` 及以上）、Node `>= 20`
- 本包是**离线版**：依赖全带在 `plugin\node_modules\` 里，不用联网装依赖

## 版本（0.5.39，2026-11-04 更新）

本包是 0.5.39，上一版 0.5.34。跨了 5 个版本，装法和数据位置都没变，直接覆盖装即可，`.mnemon` 里的记忆不用迁移。

从 0.5.34 升上来注意三件事：

- 新版 `cordis.patch.yml` 顶部有警告：别把这个文件里的 insert 块抄进 profile 的 `cordis.patch.yml`，会重复 entry ID、设置页存不了（上游 issue #470）。profile 里只写顶层覆盖行。
- 0.5.37 起 Runtime 记忆容量可以在设置里调；0.5.38 起空闲审查有可选配额与冷却时间，默认不变。
- 0.5.39 起支持 DSH 0.2.1-rc.5 / 0.2.2-alpha.2 的工具契约，老宿主（0.2.0-rc.2、0.2.1-rc.2）仍然兼容。

## 装完是什么样

- 侧栏多个 **记忆系统**：状态 / 运行时记忆 / 项目档案 / 记忆空间 / 技能管理。
- 插件页多一组 **可组合记忆**：主策略、各组件、Provider、存储设置。
- 对话里回复下方出现**回合记忆栏**，还有把回复存进记忆的脑形图标。
- 数据落在 `%USERPROFILE%\.mnemon\`（可用 `MNEMON_DATA_DIR` 改）。

## 前置条件

| 项 | 要求 |
|---|---|
| DSH | 0.2.x；知道自己的 profile 名字（一般是 `desktop`） |
| Node | `>= 20`（DSH 自带运行时够用） |
| 磁盘 | 约 13 MB（装完的 node_modules） |
| 可选 | Mnemon CLI（想用「记忆空间」才需要，见第 6 步） |
| 可选 | 本地 ollama + `nomic-embed-text`（想要语义召回才需要，默认关） |

## 安装（两种路线，选一条）

### 路线 A：在线按包名装（最省事）

1. 打开 DSH → **插件页** → 添加插件 → 输入 `dsh-mnemon`。
2. 选 `0.5.39` → 安装 → **立即启用**。
3. **重启 DSH**。
4. 跳到下面「装完先验这四件事」。

### 路线 B：用本包离线装（没网 / 想锁版本）

1. **解压**本包到固定目录（别放临时目录）。
2. **跑落位脚本**（幂等，可反复跑）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   默认往 `<DSH_HOME>\profiles\desktop\node_modules\` 复制。profile 名不是 `desktop` 就加 `-ProfileName <名字>`；
   DSH_HOME 不在默认位置就加 `-DshHome <路径>`。
   期望：`包内自检通过：dsh-mnemon 0.5.39`，然后 23 个目录 `已落位`；再跑一次全是 `保留不动`。

3. **改 profile 的 `package.json`**（脚本不会替你改），加两处：

   ```json
   {
     "dependencies": {
       "dsh-mnemon": "0.5.39"
     },
     "dsh": {
       "profile": {
         "bundles": [ "@deepseek-ai/dsh-base", "...", "dsh-mnemon" ]
       }
     }
   }
   ```

4. **重启 DSH**。

5. 跳到下面「装完先验这四件事」。

## 装完先验这四件事

1. 侧栏有 **记忆系统**。
2. 记忆系统 → **状态**：能看到组件和 Provider 的当前状态。
3. 说一句值得记住的话，回复下方出现**回合记忆栏**。
4. 插件页 → **可组合记忆**：能看到主策略和组件页面。

## 第 6 步（可选）：把「记忆空间」用起来

热记忆和项目档案**不需要额外东西**，装完就能用。只有「记忆空间」需要 Provider：

- **默认 Provider 是 Mnemon Native**，它需要一个本机 `mnemon` 命令（npm 包装的是驱动，不是二进制）：

  ```powershell
  npm install --global @mnemon-dev/mnemon
  ```

  故意不联网的话，可以在 DSH 设置里把 `cliPath` 指到一个已有的 `mnemon.exe`，或者设环境变量 `MNEMON_CLI_PATH`。
- 另外 8 个 Provider（OpenViking / Honcho / Mem0 / Hindsight / Holographic / RetainDB / ByteRover / Supermemory）**默认关闭**，要远程服务或 key，配之前不会用。
- 想要**语义召回**（不是纯关键词）：插件 → 可组合记忆 → 本地向量嵌入 → 打开，默认指向 `http://localhost:11434` + `nomic-embed-text`（本地 ollama）。**默认是关的**。

## 铁律（三条，犯了会白折腾）

1. **别把 `@deepseek-ai/*`、`react`、`react-dom` 手动装进 profile**——它们由宿主提供，手动装会和宿主版本打架。
2. **别用 `link:` 装本地文件夹**——pnpm 只建软链、不装依赖，插件页只会显示 `failed to import`。
3. **别手改 `MEMORY.md` / `USER.md`**——它们是投影，写热记忆只用 `mnemon_runtime_memory` 工具。手改的内容会被覆盖。

## 出问题

看本包根目录的 `NEXT-AI.md`：第三节是坑清单（安装/存储/档案/记忆空间/嵌入/升级/隐私各一节），最后一节是「症状 → 排查」对照表。

## 包里有什么

```
4-长期记忆-dsh-mnemon-v0.5.39\
  NEXT-AI.md          ← 给下一个 AI 的避坑说明书（最重要）
  README.md           ← 本文件
  install.ps1         ← 离线落位脚本（复制到 profile 的 node_modules）
  docs\quickstart.md  ← 装完之后怎么用（三层记忆、档案、记忆空间、开关、容量）
  plugin\
    dsh-mnemon\       ← 插件本体（0.5.39）
    node_modules\     ← 18 个 dsh-mnemon-* 子包
                         9 个 provider-*（native/openviking/honcho/mem0/…）
                         4 个 source-*（runtime/documents/memory-spaces/skills）
                         5 个 strategy-*（default-three-tier/general/auto-capture/light-context/scoped）
                       + zod、yaml、fflate、markdown-to-jsx（外部依赖）
```

## 包里没有什么

- ❌ 你的记忆数据（`.mnemon\` 目录）—— 属于隐私，不随包。
- ❌ `@deepseek-ai/*`、`react`、`react-dom` —— 宿主提供。
- ❌ Mnemon CLI 的二进制 —— 用 `npm i -g @mnemon-dev/mnemon` 装。
- ❌ 嵌入模型 —— 用本地 ollama 拉 `nomic-embed-text`。
- ❌ 第三方 Provider 的账号/key。

许可：MIT（第三方 Provider 各自许可，见插件里的 `THIRD_PARTY_NOTICES.md`）。
