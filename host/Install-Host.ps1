<#
安装 PinBoardLock 的本机部分。只动当前用户，不需要管理员权限。先在 Chrome 里加载好插件，再跑这个。

  pwsh -NoProfile -ExecutionPolicy Bypass -File host\Install-Host.ps1
  ... -DefaultRoot D:\参考图             图默认下载到哪（调研单没写完整路径时放在它下面）
  ... -ExtensionId abcdef...             自动找不到扩展 ID 时手动给（侧边栏的提示里会写出你的 ID）
  ... -NoSkills                          不装 pin-research 技能
  ... -Uninstall                         卸载（删掉注册表里那一项和装过的技能）

做这几件事：
  1. 在 Chrome / Edge 的配置里找到你加载的 PinBoardLock 的扩展 ID（找的是指向本仓库 extension 文件夹的那个）
  2. 生成 host\pbl-host.cmd（用 node 启动 pbl-host.js）和 host\com.pinboardlock.host.json（告诉浏览器去哪找它、哪个扩展能用）
  3. 在注册表 HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pinboardlock.host（和 Edge 的同名位置）写上那个 json 的路径
  4. 生成或补全 host\config.json：调研单文件夹、默认下载根目录、PowerShell 7、gallery-dl、Billfish 的位置
  5. 把 pin-research 技能装给 Claude Code / Codex（skills\Install-Skills.ps1）
装完要在 chrome://extensions 里把 PinBoardLock 重新加载一次。
#>
param(
    [string]$ExtensionId,
    [string]$DefaultRoot,
    [switch]$NoSkills,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.pinboardlock.host'
$regKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)
$dir = $PSScriptRoot
$repo = Split-Path $dir -Parent
$extDir = Join-Path $repo 'extension'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if ($Uninstall) {
    foreach ($k in $regKeys) { if (Test-Path $k) { Remove-Item $k -Force; Write-Host "已删掉：$k" } }
    & (Join-Path $repo 'skills\Install-Skills.ps1') -Uninstall
    exit 0
}

# ── 0. 前提 ──
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '找不到 node。先装 Node.js 22.5 或更新的版本（winget install OpenJS.NodeJS.LTS），装完重新开一个终端再跑。' }
$ver = [version]((& $node --version) -replace '^v', '')
if ($ver -lt [version]'22.5.0') { throw "Node 版本太旧（$ver），要 22.5 以上（写 Billfish 数据库用的是 node:sqlite）。" }
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { throw '找不到 PowerShell 7（pwsh）。下载脚本要用它：winget install Microsoft.PowerShell，装完重新开一个终端再跑。' }

# ── 1. 扩展 ID ──
function Find-ExtensionIds([string]$extPath) {
    $want = [IO.Path]::GetFullPath($extPath).TrimEnd('\').ToLowerInvariant()
    $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
    )
    $ids = @()
    foreach ($r in $roots) {
        if (-not (Test-Path -LiteralPath $r)) { continue }
        $profiles = Get-ChildItem -LiteralPath $r -Directory | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }
        foreach ($p in $profiles) {
            foreach ($f in 'Secure Preferences', 'Preferences') {
                $file = Join-Path $p.FullName $f
                if (-not (Test-Path -LiteralPath $file)) { continue }
                try { $j = [IO.File]::ReadAllText($file, $utf8) | ConvertFrom-Json } catch { continue }
                $settings = $j.extensions.settings
                if (-not $settings) { continue }
                foreach ($prop in $settings.PSObject.Properties) {
                    $path = $prop.Value.path
                    if ($path -and $path.TrimEnd('\').ToLowerInvariant() -eq $want) { $ids += $prop.Name }
                }
            }
        }
    }
    return @($ids | Select-Object -Unique)
}

$ids = if ($ExtensionId) { @($ExtensionId) } else { Find-ExtensionIds $extDir }
if (-not $ids) {
    throw @"
没找到加载了这个文件夹的 PinBoardLock：$extDir
先在 Chrome 打开 chrome://extensions → 打开“开发者模式” → “加载已解压的扩展程序” → 选上面这个文件夹，然后再跑一次。
还是找不到的话，打开插件侧边栏，提示里会写出完整命令（带 -ExtensionId）。
"@
}
foreach ($id in $ids) { if ($id -notmatch '^[a-p]{32}$') { throw "扩展 ID 应该是 32 个小写字母（a–p）：$id" } }

# ── 2. 启动用的 cmd 和给浏览器看的清单 ──
$cmd = Join-Path $dir 'pbl-host.cmd'
[IO.File]::WriteAllText($cmd, "@echo off`r`n`"$node`" `"%~dp0pbl-host.js`" %*`r`n", [System.Text.Encoding]::ASCII)
$manifest = Join-Path $dir "$hostName.json"
$obj = [ordered]@{
    name            = $hostName
    description     = 'PinBoardLock: read research sheets, download boards, write Billfish tags'
    path            = $cmd
    type            = 'stdio'
    allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
}
[IO.File]::WriteAllText($manifest, ($obj | ConvertTo-Json), $utf8)

# ── 3. 注册表 ──
foreach ($k in $regKeys) {
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name '(default)' -Value $manifest
}

# ── 4. 配置 ──
function Find-GalleryDl {
    $c = (Get-Command gallery-dl -ErrorAction SilentlyContinue).Source
    if ($c) { return $c }
    $link = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\gallery-dl.exe'
    if (Test-Path -LiteralPath $link) { return $link }
    return ''
}
function Find-Billfish {
    $p = (Get-Process -Name Billfish -ErrorAction SilentlyContinue | Select-Object -First 1).Path
    if ($p) { return $p }
    $uninst = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($u in $uninst) {
        $hit = Get-ItemProperty $u -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Billfish*' } | Select-Object -First 1
        if ($hit) {
            foreach ($cand in @($hit.DisplayIcon, (Join-Path ([string]$hit.InstallLocation) 'Billfish.exe'))) {
                if ($cand) {
                    $cand = ($cand -split ',')[0].Trim('"')
                    if ($cand -like '*Billfish.exe' -and (Test-Path -LiteralPath $cand)) { return $cand }
                }
            }
        }
    }
    foreach ($cand in @((Join-Path $env:ProgramFiles 'Billfish\Billfish.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\Billfish\Billfish.exe'))) {
        if (Test-Path -LiteralPath $cand) { return $cand }
    }
    return ''
}

$config = Join-Path $dir 'config.json'
$c = [ordered]@{}
if (Test-Path -LiteralPath $config) {
    $old = [IO.File]::ReadAllText($config, $utf8) | ConvertFrom-Json
    foreach ($p in $old.PSObject.Properties) { $c[$p.Name] = $p.Value }
}
$added = @()
function Set-Default([string]$key, $value) {
    if (-not $c.Contains($key) -or $null -eq $c[$key] -or ($c[$key] -is [string] -and -not $c[$key])) { $c[$key] = $value; $script:added += $key }
}
Set-Default 'sheetsDir' (Join-Path $repo 'sheets')
if ($DefaultRoot) { $c['defaultRoot'] = [IO.Path]::GetFullPath($DefaultRoot); $added += 'defaultRoot' }
else { Set-Default 'defaultRoot' (Join-Path ([Environment]::GetFolderPath('MyPictures')) 'PinBoardLock') }
Set-Default 'pwsh' $pwsh
Set-Default 'galleryDl' (Find-GalleryDl)
$bf = Find-Billfish
Set-Default 'billfishExe' $bf
if (-not $c.Contains('billfish')) { $c['billfish'] = if ($c['billfishExe']) { 'auto' } else { $false }; $added += 'billfish' }
if (-not $c.Contains('writeWhileBillfishOpen')) { $c['writeWhileBillfishOpen'] = $false; $added += 'writeWhileBillfishOpen' }
[IO.File]::WriteAllText($config, ($c | ConvertTo-Json), $utf8)

# ── 5. 技能 ──
if (-not $NoSkills) {
    Write-Host ''
    & (Join-Path $repo 'skills\Install-Skills.ps1')
}

# ── 结果 ──
Write-Host ''
Write-Host '已安装本机小程序。' -ForegroundColor Green
Write-Host "  扩展 ID       $($ids -join ', ')"
Write-Host "  配置          $config$(if ($added) { '（这次补上：' + ($added -join '、') + '）' })"
Write-Host "  默认下载到    $($c['defaultRoot'])"
Write-Host "  PowerShell 7  $($c['pwsh'])"
if ($c['galleryDl']) { Write-Host "  gallery-dl    $($c['galleryDl'])" }
else { Write-Host '  gallery-dl    没找到。下载图片要用它：winget install mikf.gallery-dl，装完重新开终端再跑一次本脚本（或者在 config.json 的 galleryDl 写上 gallery-dl.exe 的完整路径）。' -ForegroundColor Yellow }
if ($c['billfish'] -eq $false) { Write-Host '  Billfish      不用（只下载到文件夹）。以后装了 Billfish，把 config.json 的 billfish 改成 "auto" 并填上 billfishExe。' }
else { Write-Host "  Billfish      $(if ($c['billfishExe']) { $c['billfishExe'] } else { '（没填程序位置：同步时不会自动帮你打开 Billfish）' })" }
Write-Host ''
Write-Host '最后一步：到 chrome://extensions 把 PinBoardLock 重新加载一次。'
