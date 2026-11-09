# 身份与人设（dsh-persona 1.4.0）· 安装说明

给 DSH 装一页「身份与人设」：在里面写机器人是谁、怎么说话，改完 QQ 那边就按这个说话；还能给一个角色名，让它自己上网查资料学成人设。

- 版本：`dsh-persona` 1.4.0
- 依赖：DSH 本体；建议先装 `dsh-qq-bridge`（人格文件是它建的）
- 第三方依赖：**无**，不占端口，不联网装依赖

## 前置条件

| 项 | 要求 |
|---|---|
| DSH | 桌面版或 `dsh web` 都行 |
| DSH_HOME | 默认 `%USERPROFILE%\.dsh`；设了 `DSH_HOME` 环境变量就按那个 |
| QQ 桥接 | 建议先装：`personas.json` 是桥接建在 `<DSH_HOME>\qq-bridge\` 里的，人设页只是去编辑它 |
| Node | 只在「把插件打成 tgz」那一步用到；装 DSH 时一般已经有了 |

## 安装（6 步）

1. **解压**本包到任意固定目录（别放临时目录、别放桌面回收站那种会被清的位置）。
2. **跑落位脚本**（幂等，可反复跑）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   期望：打印 `包内自检通过：dsh-persona 1.4.0`，并把模板放成 `<DSH_HOME>\qq-bridge\personas.template.json`。
   已有同文件时显示「保留不动」，不会覆盖。

3. **打成 tgz**（这一步不能省，见下面的铁律）：

   ```powershell
   cd .\plugin
   npm pack
   ```

   期望：当前目录多出 `dsh-persona-1.4.0.tgz`。

4. **装进 DSH**：打开 DSH → 插件页 → 添加插件 → 选刚才的 `dsh-persona-1.4.0.tgz` → 安装 → 启用。
   （能联网的话，直接在插件页搜 `dsh-persona` 装 1.4.0 也一样。）

5. **重启 DSH**。

6. **进设置页**：左下角账号菜单 → 设置 → 左侧「身份与人设」。

## 装完先验这三件事

- 设置里有「身份与人设」，页面能看到四块：身份（默认人格）、QQ 会话人格、角色库、规则。
- 文件在：`<DSH_HOME>\qq-bridge\personas.json`（第一次打开设置页后才会生成）。
- 改一句话，在 QQ 里给机器人发一条消息，回复跟着变 → 通了。

## 铁律（就一条，但很致命）

**别从本地文件夹装这个插件。** 插件页里选「从本地文件夹安装」，或手改 `package.json` 写成 `link: <路径>`，pnpm 只会建软链、不装依赖，插件页会一直显示 `failed to import`。必须走 `npm pack` 出的 tgz，或者按包名装。

## 出问题

看本包根目录的 `NEXT-AI.md`：第三节是坑清单（G 段专门讲这个插件），最后一节是「症状 → 排查」对照表。

## 包里有什么

```
2-身份与人设-dsh-persona-v1.4.0\
  NEXT-AI.md              ← 给下一个 AI 的避坑说明书（最重要）
  README.md               ← 本文件
  install.ps1             ← 落位脚本（放模板、打印装法）
  docs\persona.md         ← 这个插件的功能与字段说明
  plugin\                 ← dsh-persona 1.4.0 本体
    package.json
    cordis.patch.yml
    lib\                  ← index / client / learn / mode / parse / speech / split
    templates\personas.template.json
    locale\ icon.svg README.md LICENSE
```

许可：MIT。
