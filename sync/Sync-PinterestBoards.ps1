#requires -Version 7
<#
把 Pinterest 收藏夹（Board）整包同步到本地文件夹，只下载上次之后新增的图。

  .\Sync-PinterestBoards.ps1                 同步 boards.json 里的全部收藏夹
  .\Sync-PinterestBoards.ps1 -Only 水墨      只同步名字里带“水墨”的
  .\Sync-PinterestBoards.ps1 -Name 风格调研-水墨感  只同步名字完全一样的那一个（插件的一键同步用这个）
  .\Sync-PinterestBoards.ps1 -Simulate       只列出会下载什么，不真的下载

boards.json 里每个收藏夹一项（插件一键同步时会自动登记，一般不用手写；格式见 boards.example.json）：
  { "name": "风格调研-水墨感", "url": "https://www.pinterest.com/用户名/收藏夹/", "dest": "D:\\参考图\\水墨感山水" }
收藏夹里的分区（Section）会变成 dest 下的同名子文件夹。
gallery-dl 的位置按这个顺序找：-GalleryDl 参数 → boards.json 的 galleryDl → PATH 里的 gallery-dl。
#>
param(
    [string]$Config = (Join-Path $PSScriptRoot 'boards.json'),
    [string]$Only,
    [string]$Name,
    [string]$GalleryDl,
    [switch]$Simulate
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $Config)) { throw "找不到配置文件：$Config" }
$cfg = Get-Content -LiteralPath $Config -Raw -Encoding utf8 | ConvertFrom-Json

$exe = if ($GalleryDl) { $GalleryDl } elseif ($cfg.galleryDl) { $cfg.galleryDl } else { (Get-Command gallery-dl -ErrorAction SilentlyContinue).Source }
if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { throw "找不到 gallery-dl（$exe）。装法见 README 的「装下载工具」，或在 host\config.json 的 galleryDl 写上 gallery-dl.exe 的完整路径。" }
$gdlConf = Join-Path $PSScriptRoot 'gallery-dl.conf.json'

$boards = @($cfg.boards | Where-Object { $_ -and $_.url -and $_.dest })
if ($Only) { $boards = @($boards | Where-Object { $_.name -like "*$Only*" }) }
if ($Name) { $boards = @($boards | Where-Object { $_.name -eq $Name }) }
if ($boards.Count -eq 0) {
    Write-Host "没有可同步的收藏夹。请在 $Config 的 boards 里加上 name / url / dest。" -ForegroundColor Yellow
    exit 1
}

function Get-ImageCount([string]$Path) {
    @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '.pinterest-archive*' }).Count
}

# Pinterest 的收藏夹列表会把分区里的图也列一遍，而且编号写法和分区列表里的不一样，
# gallery-dl 的下载记录认不出是同一张，结果分区里的图在根目录又下一份。
# 这里按文件内容比对：根目录里和某个分区文件一模一样的，放进回收站。
function Remove-SectionDuplicates([string]$Path) {
    $inSections = @{}
    Get-ChildItem -LiteralPath $Path -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Get-ChildItem -LiteralPath $_.FullName -Recurse -File | ForEach-Object {
            $inSections[(Get-FileHash -LiteralPath $_.FullName -Algorithm MD5).Hash] = $true
        }
    }
    if ($inSections.Count -eq 0) { return 0 }
    Add-Type -AssemblyName Microsoft.VisualBasic
    $removed = 0
    Get-ChildItem -LiteralPath $Path -File | Where-Object { $_.Name -notlike '.pinterest-archive*' } | ForEach-Object {
        if ($inSections.ContainsKey((Get-FileHash -LiteralPath $_.FullName -Algorithm MD5).Hash)) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin')
            $removed++
        }
    }
    return $removed
}

$summary = @()
foreach ($b in $boards) {
    $name = if ($b.name) { $b.name } else { $b.url }
    Write-Host ""
    Write-Host "== $name" -ForegroundColor Cyan
    Write-Host "   $($b.url)"
    Write-Host "   -> $($b.dest)"

    New-Item -ItemType Directory -Force -Path $b.dest | Out-Null
    $before = Get-ImageCount $b.dest

    $gdlArgs = @(
        '--config-ignore',
        '--config', $gdlConf,
        '--destination', $b.dest,
        '--download-archive', (Join-Path $b.dest '.pinterest-archive.sqlite3')
    )
    if ($cfg.cookies) { $gdlArgs += @('--cookies', $cfg.cookies) }
    if ($Simulate) { $gdlArgs += '--simulate' }
    $gdlArgs += $b.url

    & $exe @gdlArgs
    $code = $LASTEXITCODE
    $dups = if ($Simulate) { 0 } else { Remove-SectionDuplicates $b.dest }
    $after = Get-ImageCount $b.dest

    # 给本机小程序读的一行（host\pbl-host.js）
    Write-Host ("##PBL " + (@{ name = $name; before = $before; total = $after; dups = $dups; code = $code } | ConvertTo-Json -Compress))
    $summary += [pscustomobject]@{
        收藏夹 = $name
        新增   = $after - $before
        总数   = $after
        去掉重复 = $dups
        结果   = if ($code -eq 0) { '完成' } else { "gallery-dl 退出码 $code" }
    }
}

Write-Host ""
$summary | Format-Table -AutoSize
if ($summary | Where-Object { $_.结果 -ne '完成' }) { exit 1 }
