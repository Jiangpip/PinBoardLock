# 给 AI 代装用的步骤（Claude Code / Codex 读这个）

用户说“帮我装 PinBoardLock”时按这里做。跟用户用他们的语言交流；每步做完看结果再走下一步。

## 前提

- Windows 10 / 11。不是 Windows 就告诉用户：目前只支持 Windows（本机小程序靠注册表登记、下载脚本是 PowerShell）。
- Chrome 116 以上。

## 步骤

1. **拿到代码**：用户给的是仓库地址就 `git clone` 到用户指定的目录（没指定就问；不要放在会被清理的临时目录）。已经解压好的就直接进那个目录。装好以后这个目录不能挪。

2. **检查依赖**，缺什么装什么（都是当前用户安装，不要用管理员权限）：
   - `node --version` 要 22.5 以上，没有就 `winget install OpenJS.NodeJS.LTS`
   - `pwsh --version` 要 7 以上，没有就 `winget install Microsoft.PowerShell`
   - `gallery-dl --version`，没有就 `winget install mikf.gallery-dl`
   - winget 装完后当前终端的 PATH 不会更新：让用户重新开一个终端，或者你自己用完整路径继续。
   - 问用户用不用 Billfish 管图。不用也没关系，只是不写来源和标签。

3. **加载插件——这一步必须用户自己手点**，你不能代替。把下面这段原样告诉用户（路径换成实际的仓库目录）：
   > 1. Chrome 地址栏打开 `chrome://extensions`
   > 2. 打开右上角「开发者模式」
   > 3. 点「加载已解压的扩展程序」，选 `<仓库目录>\extension`

   等用户说加载好了再继续。

4. **装本机部分**：问用户图默认下载到哪个文件夹，然后在仓库目录里运行
   ```
   pwsh -NoProfile -ExecutionPolicy Bypass -File host\Install-Host.ps1 -DefaultRoot <那个文件夹>
   ```
   - 报“没找到加载了这个文件夹的 PinBoardLock”：插件还没加载，或者加载的是别的目录。回到第 3 步。
   - 输出里 gallery-dl 显示“没找到”：装好后重新开终端再跑一次这条命令（会补上，不会覆盖已有设置）。
   - 它会顺手给本机的 Claude Code / Codex 装 `pin-research` 技能。

5. **收尾**：告诉用户
   > 1. 回到 `chrome://extensions`，点 PinBoardLock 卡片上的刷新
   > 2. 打开并登录 Pinterest 网页，左下角出现状态条就装好了
   > 3. 想做调研时跟我说“做个图片调研：……”

## 不要做的事

- 不要改用户的全局配置（Claude Code 设置、`~/.codex/config.toml` 等）。技能目录除外，那是安装脚本做的。
- 不要用管理员权限运行；安装只写当前用户的目录和注册表（HKCU）。
- 不要替用户登录 Pinterest，也不要拿用户的 cookie 去请求 Pinterest 接口。
- Billfish 开着时不要替用户关掉它。

## 排错速查

| 现象 | 处理 |
|---|---|
| 侧边栏提示“还没连上本机小程序” | 提示里有带扩展 ID 的完整命令，照着跑，再在 `chrome://extensions` 刷新插件 |
| 下载报“找不到 gallery-dl” | 在 `host\config.json` 的 `galleryDl` 写上 gallery-dl.exe 的完整路径 |
| 下载报“目标文件夹不在 Billfish 的库里” | `host\config.json` 的 `billfish` 是 `true`；不用 Billfish 就改成 `false` 或 `"auto"` |
| 其他问题 | 让用户点侧边栏最下面的“复制诊断”贴给你 |
