# PinBoardLock

在 Pinterest 上做参考图调研的 Chrome 插件：

- **锁定收藏夹**：把 Pinterest 的“保存（Save）”固定到你选的收藏夹（Board）或分区（Section），不用每次在下拉菜单里找。
- **调研单**：让 AI 把调研需求排成一组组搜索关键词（一组 = 一个分区），在侧边栏里点关键词搜图，保存的图自动进对应分区。
- **一键下载**：收集完点一下，把收藏夹下载到本地文件夹，分区变成子文件夹，只下新增的。用 [Billfish](https://www.billfish.cn/) 管图的话，还会给每张图写上来源链接和标签。

只支持 **Windows 10 / 11 + Chrome**（Edge 理论上可以，没测过）。

## 整个流程

1. 跟你用的 AI 说要调研什么，让它按规格出一份调研单（见下面“让 AI 出调研单”）。
2. 打开 PinBoardLock 侧边栏，选这份调研单。缺的收藏夹和分区点“新建这些”。
3. 点关键词，Pinterest 直接出搜索结果；看到合适的点“保存”，图自动进这一组的分区。
4. 收集完，在侧边栏点“⬇ 下载”→“开始”。

## 安装

需要：

| 东西 | 用来干什么 | 怎么装 |
|---|---|---|
| Chrome 116 以上 | 跑插件 | — |
| Node.js 22.5 以上 | 本机小程序（读调研单文件夹、跑下载、写 Billfish） | `winget install OpenJS.NodeJS.LTS` |
| PowerShell 7 | 下载脚本 | `winget install Microsoft.PowerShell` |
| gallery-dl | 下载 Pinterest 收藏夹 | `winget install mikf.gallery-dl` |
| Billfish（可选） | 写来源和标签 | 不用 Billfish 就只下载到文件夹 |

装完上面几样后**重新开一个终端**，然后：

1. **拿到代码**：`git clone` 或下载 ZIP 解压到一个固定的位置（之后别挪，挪了要重新装）。
2. **加载插件**：Chrome 打开 `chrome://extensions` → 右上角打开“开发者模式（Developer mode）”→“加载已解压的扩展程序（Load unpacked）”→ 选仓库里的 `extension` 文件夹。
3. **装本机部分**：在仓库目录里打开终端，运行
   ```
   pwsh -NoProfile -ExecutionPolicy Bypass -File host\Install-Host.ps1 -DefaultRoot D:\参考图
   ```
   `-DefaultRoot` 是图默认下载到哪，不写就是“图片\PinBoardLock”。脚本会：
   - 在 Chrome 的配置里找到你刚加载的插件（自动认扩展 ID），给它登记本机小程序（只写当前用户的注册表，不需要管理员权限）；
   - 找 PowerShell 7、gallery-dl、Billfish 在哪，写进 `host\config.json`；
   - 本机装了 Claude Code 或 Codex 的话，顺手装上 `pin-research` 技能（见下面）。
4. 回到 `chrome://extensions`，点 PinBoardLock 卡片上的刷新。
5. 打开并登录 Pinterest 网页，等几秒，左下角出现状态条就好了。

卸载：`pwsh -File host\Install-Host.ps1 -Uninstall`，再在 `chrome://extensions` 里移除插件。

想让 AI 助手代你装：把 [INSTALL_FOR_AI.md](INSTALL_FOR_AI.md) 交给它。

## 让 AI 出调研单

用什么 AI 都行，有三种接法：

| 你用的 | 怎么接 |
|---|---|
| **Claude Code / Codex** | 安装脚本已经装好 `pin-research` 技能。说“做个图片调研：……”或 `/pin-research <主题>`（Codex 里是 `$pin-research`），它会问清需求、把调研单直接存进 `sheets\`，侧边栏点“刷新”就有。 |
| **网页版 AI**（ChatGPT、Claude、Gemini、DeepSeek、Kimi、豆包、通义、元宝、Grok、Copilot、Perplexity、Poe） | 侧边栏“导入”→“复制给 AI 的说明”，贴给它，后面写上要调研的风格。它回了 JSON 代码块后，插件会自动收下，页面右下角有提示。 |
| **其他任何 AI** | 同样复制“给 AI 的说明”贴过去；把它回的 JSON 复制下来，点一下侧边栏空白处按 Ctrl+V 就导入了。 |

网页版自动收下靠的是认页面里的代码块（`<pre>`），各家改版后可能认不出，认不出时用 Ctrl+V。名单在 `extension\manifest.json` 里，想加别的网站就照着加一行。

Claude Code / Codex 的技能装在哪：Claude Code 是 `%CLAUDE_CONFIG_DIR%\skills` 或 `~\.claude\skills`，Codex 是 `%CODEX_HOME%\skills` 或 `~\.codex\skills`。要装到别处（比如某个项目的 `.claude\skills`）就单独跑 `skills\Install-Skills.ps1 -ClaudeDir <目录>`。技能模板在 `skills\pin-research\`，改了之后重跑一次安装。

调研单的格式见 [sheets/调研单规格.md](sheets/调研单规格.md)。

## 锁定收藏夹

- 点状态条或工具栏图标，在列表里点一个收藏夹或分区，它就是当前目标。
- 之后点 Pinterest 的“保存”，图都进当前目标。状态条旁边会提示实际存到了哪。
- 在 Pinterest 的下拉菜单里手动选别的收藏夹，不会被改。
- 按住 Alt 点保存，这一次不锁。
- 面板右上角的 LOCK 开关可以整体暂停。
- 状态条可以拖动，松手后吸到页面左侧或右侧，位置会记住。

## 调研单

一份调研单对应一个收藏夹，每个分组对应一个分区。

- **打开侧边栏**：点状态条 → 面板右上角“调研单 ▸”。侧边栏不随翻页关闭。
- **刷新**：侧边栏顶上的“刷新”把 `sheets\` 里的 `*.json` 都读进来；文件夹里有新的时按钮会变色。标题和收藏夹名都相同的算同一份，再导入是更新，计数保留。
- **点关键词**：Pinterest 标签页去搜这个词，锁定目标同时切到这一组的分区。关键词上的数字是这个词存了几张；灰底是看过的。底部“上一个 / 下一个”按顺序走。
- **新建**：收藏夹或分区还没建时，侧边栏顶部会列出缺什么，点“新建这些”才会去建。新建收藏夹默认公开，旁边可以切成私密（Secret）。
- **链接**：`https://www.pinterest.com/search/pins/?q=搜索词#plk=收藏夹名/分区名` 点开就搜这个词并切好目标；`node tools\sheet-link.js sheets\某调研单.json` 打印一条能导入整份调研单的链接（加 `--md` 再打印每个关键词的 Markdown 链接）。`#` 后面的部分不会发给 Pinterest。

## 下载（一键）

侧边栏列表下面的“⬇ 下载”按钮（用 Billfish 时叫“⬇ 下载 + 同步到 Billfish”）：

1. 先确认“下载到”的文件夹。默认是 `defaultRoot\调研主题`（调研单写了 `folder` 就用它），可以改，改过会记住。
2. 点“开始”，进度分三步：下载新图 / 等 Billfish 收录 / 写来源和标签。目标文件夹不在 Billfish 库里（或没用 Billfish）时后两步跳过。
3. 只下载上次之后新增的图（记录在目标文件夹的 `.pinterest-archive.sqlite3`）；分区变成同名子文件夹；视频不下载。
4. Pinterest 的收藏夹列表会把分区里的图再列一遍，脚本下载完按文件内容比对，把根目录里和分区重复的放进回收站。

同步是另起一个进程跑的，中途关掉侧边栏甚至浏览器都不影响；再打开侧边栏能看到上次的结果。

私密（Secret）收藏夹需要登录 cookie：导出成 cookies.txt 后把路径填进 `sync\boards.json` 的 `cookies`。

也可以不用插件，直接跑脚本：`sync\boards.json`（第一次一键同步后自动生成，格式见 `sync\boards.example.json`）里登记收藏夹，双击 `sync\Sync-PinterestBoards.cmd`。

### Billfish（可选）

下载到的文件夹在某个 Billfish 库里时（往上找得到 `.bf\billfish.db`），会接着做：

- Billfish 没开就帮你打开，等它把新图收录进去；
- 来源：文件名 `pinterest_<编号>.jpg` 写成 `https://www.pinterest.com/pin/<编号>/`；
- 标签：顶层标签 = 收藏夹名，子标签 = 分区名；分区名和库里别的标签重名时写成“收藏夹名/分区名”。
- 已经有来源的图不改来源；备注、评分不动；重复跑不会重复加。

这一步是直接改 Billfish 的数据库（SQLite），不是官方接口。每次写之前会把数据库备份到 `sync\backups\`；出问题就关掉 Billfish，把备份拷回库目录的 `.bf\billfish.db`。默认写之前会提示你先关掉 Billfish、写完再帮你打开；`host\config.json` 里 `writeWhileBillfishOpen` 改成 `true` 就开着直接写（作者自己这样用，标签在 Billfish 的标签栏里没马上出现时关开一次）。脚本写的来源进不了 Billfish 的搜索索引，按来源链接搜可能搜不到。

单独跑：`node sync\billfish-tag.js --dry-run` 先看会写什么，去掉 `--dry-run` 真写（Billfish 要关着）。

## 配置（`host\config.json`）

安装脚本会生成，之后可以手动改：

| 项 | 意思 |
|---|---|
| `sheetsDir` | 调研单文件夹，默认仓库里的 `sheets` |
| `defaultRoot` | 调研单没写完整路径时，下载到 `defaultRoot\文件夹名` |
| `galleryDl` | gallery-dl.exe 的位置；空 = 在 PATH 里找 |
| `pwsh` | PowerShell 7 的位置 |
| `billfish` | `"auto"`：文件夹在 Billfish 库里才写；`false`：只下载；`true`：必须写，不在库里就报错 |
| `billfishExe` | Billfish 程序的位置，填了才会自动帮你打开它 |
| `writeWhileBillfishOpen` | 见上面 Billfish 一节 |

## 工作方式

- `inject.js` 跑在 Pinterest 页面里，拦截 Pinterest 自己发出的 `RepinResource/create` 请求，把里面的 `board_id` 和分区换成目标，其他内容不动。
- 收藏夹列表来自 Pinterest 网页的内部接口（`BoardPickerBoardsResource`、`BoardsResource`、`BoardSectionsResource`），用的是页面已登录的会话，6 小时自动刷新一次。
- 新建收藏夹和分区走 `BoardResource/create`、`BoardSectionResource/create`，只在你点了“新建”之后才发；先重新读一遍列表，同名的不重复建。
- `sheet.js` 是调研单的纯逻辑（解析链接和 JSON、按名字找目标），内容脚本、侧边栏和 Node 工具共用。
- 本机小程序 `host\pbl-host.js` 走 Chrome 的 Native Messaging，只替插件读写 `sheets\`、跑下载脚本、写 Billfish。
- 数据只存在扩展的本地存储和你自己的硬盘上，不发往别处。

这些都不是官方公开接口，Pinterest 改版后可能失效。出问题时点侧边栏最下面一行的“复制诊断”，里面有最近 30 次保存和新建的记录，贴到 Issue 里。

下载下来的图版权归原作者，只作个人参考用。

## 目录

| 路径 | 作用 |
|---|---|
| `extension\` | Chrome 扩展（Manifest V3） |
| `host\` | 本机小程序和安装脚本 |
| `sync\` | 下载脚本、写 Billfish 的脚本 |
| `sheets\` | 调研单（`调研单规格.md` 是格式说明，`示例-*.json` 是示例；你自己的调研单不进 git） |
| `skills\` | 给 Claude Code / Codex 的 `pin-research` 技能模板和安装脚本 |
| `tools\` | `sheet-check.js` 检查调研单、`sheet-link.js` 生成链接、`build-icons.js` 生成图标、`check-privacy.ps1` 提交前的隐私检查 |
| `tests\` | 测试 |

## 测试

```
node tests\test-host.js
node tests\test-billfish.js [billfish.db 的副本]
node tests\test-inject.js extension\inject.js
node tests\test-sheet.js extension\sheet.js
node tests\harness.js <放截图的文件夹>
```

`harness.js` 会起一个本地假站点（端口 8717）和无头 Chrome（调试端口 9347），不碰真的 Pinterest。Chrome 不在默认位置时用环境变量 `CHROME` 指路径。

## 实测情况

| 功能 | 状态 |
|---|---|
| 锁定收藏夹、保存进分区 | 作者的真实账号上用过 |
| 一键下载 + 写 Billfish | 作者的真实库上跑过（300 多张，来源和标签在 Billfish 里显示正常） |
| 侧边栏、点关键词、`#plk=` 链接、新建收藏夹 / 分区 | 假 Pinterest 页面上的自动测试 |
| 网页版 AI 自动收下调研单 | 只在假页面测过；ChatGPT、Claude 以外的网站没测 |
| Edge | 没测 |
| 别的电脑上从零安装 | 没测 |

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)：个人、学习、非营利可以用、改、分享；不能商用。
