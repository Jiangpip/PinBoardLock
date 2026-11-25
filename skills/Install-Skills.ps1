<#
把 pin-research 技能装给本机的 AI 编程助手，让它们能直接出调研单并存进 sheets\。
只写当前用户的目录，不需要管理员权限。Install-Host.ps1 会顺手调用它，一般不用单独跑。

  .\Install-Skills.ps1                     装给找得到的 Claude Code 和 Codex
  .\Install-Skills.ps1 -ClaudeDir <目录>   Claude Code 的技能目录不在默认位置时（比如放进某个项目的 .claude\skills）
  .\Install-Skills.ps1 -Uninstall          删掉装过的 pin-research

默认位置：
  Claude Code  $env:CLAUDE_CONFIG_DIR\skills，没设就是 ~\.claude\skills
  Codex        $env:CODEX_HOME\skills，没设就是 ~\.codex\skills
对应的配置目录不存在（没装那个工具）就跳过。其他 AI 不用装：插件侧边栏有“复制给 AI 的说明”。
#>
param(
    [string]$ClaudeDir,
    [string]$CodexDir,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$src = Join-Path $PSScriptRoot 'pin-research'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Get-DefaultDir([string]$envValue, [string]$fallback) {
    $base = if ($envValue) { $envValue } else { Join-Path $HOME $fallback }
    if (Test-Path -LiteralPath $base) { return (Join-Path $base 'skills') }
    return $null
}

$targets = @()
$claude = if ($ClaudeDir) { $ClaudeDir } else { Get-DefaultDir $env:CLAUDE_CONFIG_DIR '.claude' }
$codex = if ($CodexDir) { $CodexDir } else { Get-DefaultDir $env:CODEX_HOME '.codex' }
if ($claude) { $targets += [pscustomobject]@{ Name = 'Claude Code'; Dir = $claude; Agents = $false } }
if ($codex) { $targets += [pscustomobject]@{ Name = 'Codex'; Dir = $codex; Agents = $true } }

if (-not $targets) {
    Write-Host '没找到 Claude Code（~\.claude）或 Codex（~\.codex），技能没装。用别的 AI 时，在插件侧边栏点“复制给 AI 的说明”贴给它就行。' -ForegroundColor Yellow
    return
}

$template = [IO.File]::ReadAllText((Join-Path $src 'SKILL.md'), $utf8).Replace('{{PBL_ROOT}}', $repo)

foreach ($t in $targets) {
    $dest = Join-Path $t.Dir 'pin-research'
    if ($Uninstall) {
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force; Write-Host "已删掉：$dest" }
        continue
    }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    [IO.File]::WriteAllText((Join-Path $dest 'SKILL.md'), $template, $utf8)
    if ($t.Agents) {
        New-Item -ItemType Directory -Force -Path (Join-Path $dest 'agents') | Out-Null
        Copy-Item -LiteralPath (Join-Path $src 'agents\openai.yaml') -Destination (Join-Path $dest 'agents\openai.yaml') -Force
    }
    Write-Host "已装 pin-research 技能（$($t.Name)）：$dest"
}
