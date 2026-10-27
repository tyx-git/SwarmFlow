<#
.SYNOPSIS
    SwarmFlow 构建脚本（Windows / PowerShell）。

.DESCRIPTION
    设计约束（与本仓库的约定一致）：
      * 不使用 npm / npx —— 全部通过 node 直接调用仓库内的本地入口，避免任何包管理器副作用
      * 不向 C 盘写产物 —— 输出只在仓库下的 dist\ 与 release\
      * build:exe 需要 Node >= 26（@opentui/core 依赖 node:ffi，且仅支持 win32-x64）。
        本脚本会自动挑选"满足版本要求的最高 node"（优先 nvm 安装目录），不要求你把默认版本切到 26

    任务（可组合，按依赖顺序执行）：
      typecheck  tsc -p tsconfig.json --noEmit（不产出文件）
      tui        tsc -p tsconfig.tui.json --noEmit（external/opentui 的 JSX 代码）
      dist       tsc -p tsconfig.build.json + 拷贝 assets/prompts/skills → dist\
      exe        构建单文件可执行：release\SwarmFlow-win32-x64\SwarmFlow.exe（含图标）
      icon       把 icons\swarmflow.ico 注入到已构建的 exe（ICO 由外部提供，不再由 PNG 生成）
      test       vitest run（可用 -TestPath 指定文件）
      all        typecheck → tui → dist → exe → test → 冒烟（默认）

.PARAMETER Task
    要执行的任务；可传多个：-Task typecheck,test
.PARAMETER NodePath
    显式指定用于构建的 node.exe（覆盖自动探测）
.PARAMETER TestPath
    只跑指定测试文件（相对仓库根），例如 -TestPath tests\task-store.test.ts
.PARAMETER SkipTests
    all 模式下跳过 test
.PARAMETER SkipSmoke
    跳过 exe 构建后的 --version 冒烟
.PARAMETER IcoPath
    icon 任务使用的 ICO 路径；默认 icons\swarmflow.ico。ICO 由外部生成，本脚本不负责制作

.NOTES
    宿主：PowerShell 7（pwsh）与 Windows PowerShell 5.1 均可运行。两处宿主差异已在本脚本内处理：
      * pwsh 7.3+ 默认把原生命令写到 stderr 的内容当错误处理（$PSNativeCommandUseErrorActionPreference）。
        本脚本显式关闭该行为，因为 postject 的 "signature seems corrupted"、exe 的
        ExperimentalWarning 等无害告警都会走 stderr —— 不关闭会让构建/冒烟中断。
      * 子脚本（set-exe-icon.ps1）用“当前宿主”执行，避免 pwsh 7 里套用 Windows PowerShell 5.1。
    本文件必须以 UTF-8 BOM 保存：5.1 在没有 BOM 时会按 ANSI 解析中文注释并直接报语法错误。

.EXAMPLE
    pwsh -File scripts\build.ps1
.EXAMPLE
    pwsh -File scripts\build.ps1 -Task exe -SkipSmoke
.EXAMPLE
    pwsh -File scripts\build.ps1 -Task tui
.EXAMPLE
    pwsh -File scripts\build.ps1 -Task test -TestPath tests\task-tools.test.ts
.EXAMPLE
    pwsh -File scripts\build.ps1 -Task icon
.EXAMPLE
    # Windows PowerShell 5.1 同样可用：
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Task typecheck
#>
[CmdletBinding()]
param(
    [ValidateSet("all", "typecheck", "tui", "dist", "exe", "icon", "test")]
    [string[]]$Task = @("all"),
    [string]$NodePath,
    [string[]]$TestPath,
    [switch]$SkipTests,
    [switch]$SkipSmoke,
    [string]$IcoPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# PowerShell 7.3+：原生命令写到 stderr 的内容会按 $ErrorActionPreference 处理。本脚本一律靠
# $LASTEXITCODE 判定成败，因此显式关闭该行为（5.1 没有这个变量，Test-Path variable: 会自动跳过）。
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# 中文输出在 5.1 / 7 下都要正常。stdout 被重定向时设置编码可能抛异常，忽略即可。
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}
catch { }

# $PSScriptRoot 在 5.1 / 7 下均可用；保留 $MyInvocation 兜底（例如被 dot-source 时）。
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root = Split-Path -Parent $ScriptDir
$ExeDir = Join-Path $Root "release\SwarmFlow-win32-x64"
$ExePath = Join-Path $ExeDir "SwarmFlow.exe"
$IconScript = Join-Path $Root "scripts\set-exe-icon.ps1"
if (-not $IcoPath) { $IcoPath = Join-Path $Root "icons\swarmflow.ico" }

$ColorConfigPath = Join-Path $Root "assets\ui-colors\color.json"
if (-not (Test-Path $ColorConfigPath)) { throw "颜色配置不存在：$ColorConfigPath" }
$UiColors = (Get-Content -Raw -LiteralPath $ColorConfigPath | ConvertFrom-Json).Theme.Common.buildConsole
if (-not $UiColors) { throw "颜色配置缺少 Theme.Common.buildConsole" }

$MinimumNodeForDist = 22
$MinimumNodeForExe = 26

function Write-Head([string]$Text) {
    Write-Host ""
    Write-Host ("=== " + $Text + " " + ("=" * [Math]::Max(0, 60 - $Text.Length))) -ForegroundColor $UiColors.header
}

function Write-Step([string]$Text) { Write-Host ("  -> " + $Text) -ForegroundColor $UiColors.step }
function Write-Ok([string]$Text) { Write-Host ("  OK " + $Text) -ForegroundColor $UiColors.success }
function Write-Warn2([string]$Text) { Write-Host ("  !! " + $Text) -ForegroundColor $UiColors.warning }

function Get-NodeMajor([string]$NodeExe) {
    $version = & $NodeExe -v 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $version) { return -1 }
    $parsed = 0
    if ([int]::TryParse(($version.TrimStart("v").Split(".")[0]), [ref]$parsed)) { return $parsed }
    return -1
}

function Get-NodeCandidates {
    $found = New-Object System.Collections.Generic.List[string]

    # nvm-windows：优先 NVM_HOME，其次 nvm.exe 旁边的 settings.txt 里的 root:
    $nvmRoots = New-Object System.Collections.Generic.List[string]
    if ($env:NVM_HOME -and (Test-Path $env:NVM_HOME)) { $nvmRoots.Add($env:NVM_HOME) }
    $nvmCmd = Get-Command nvm.exe -ErrorAction SilentlyContinue
    if ($nvmCmd) {
        $settingsPath = Join-Path (Split-Path -Parent $nvmCmd.Source) "settings.txt"
        if (Test-Path $settingsPath) {
            foreach ($line in Get-Content $settingsPath) {
                if ($line -match "^\s*root:\s*(.+?)\s*$") {
                    $candidate = $Matches[1].Trim()
                    if (Test-Path $candidate) { $nvmRoots.Add($candidate) }
                }
            }
        }
    }
    foreach ($nvmRoot in $nvmRoots) {
        foreach ($dir in Get-ChildItem -Path $nvmRoot -Directory -ErrorAction SilentlyContinue) {
            if ($dir.Name -notmatch "^v\d") { continue }
            $candidate = Join-Path $dir.FullName "node.exe"
            if (Test-Path $candidate) { $found.Add($candidate) }
        }
    }

    # PATH 上的 node（可能是 nvm 的软链，也可能不是）
    $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($pathNode) { $found.Add($pathNode.Source) }
    $pathNodeNoExt = Get-Command node -ErrorAction SilentlyContinue
    if ($pathNodeNoExt -and $pathNodeNoExt.Source) { $found.Add($pathNodeNoExt.Source) }

    return $found | Select-Object -Unique
}

function Resolve-Node([int]$MinimumMajor, [string]$Workload) {
    if ($NodePath) {
        if (-not (Test-Path $NodePath)) { throw "指定的 NodePath 不存在：$NodePath" }
        $major = Get-NodeMajor $NodePath
        if ($major -lt $MinimumMajor) {
            throw "NodePath 的版本过低（需要 >= $MinimumMajor，实际 v$major.0）：$NodePath"
        }
        return $NodePath
    }

    $best = $null
    $bestMajor = -1
    foreach ($candidate in Get-NodeCandidates) {
        $major = Get-NodeMajor $candidate
        if ($major -ge $MinimumMajor -and $major -gt $bestMajor) {
            $best = $candidate
            $bestMajor = $major
        }
    }
    if (-not $best) {
        $available = (Get-NodeCandidates | ForEach-Object { "    v$(Get-NodeMajor $_)  $_" }) -join "`n"
        throw @"
找不到满足 $Workload 要求的 Node（需要 >= v$MinimumMajor）。
已探测到的 node：
$available

安装办法（nvm-windows；下载落在 nvm 的 root，不在 C 盘）：
    nvm install 26.10.0
或手工放置（nvm 目录布局）：
    解压 node-v26.x.y-win-x64.zip 到 <nvm root>\v26.x.y\
"@
    }
    return $best
}

function Get-HostExe {
    # 用“当前宿主”执行子脚本：pwsh 7 下不要退回 powershell.exe（5.1），反之亦然。
    $isCore = $PSVersionTable.PSEdition -eq "Core"
    $exeName = if ($isCore) { "pwsh.exe" } else { "powershell.exe" }
    $local = Join-Path $PSHOME $exeName
    if (Test-Path $local) { return $local }
    $onPath = Get-Command $exeName -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}

function Invoke-HostScript([string]$ScriptPath, [string[]]$ScriptArguments, [string]$What) {
    $hostExe = Get-HostExe
    if (-not $hostExe) {
        Write-Warn2 "未找到 PowerShell 宿主，改为在当前会话内直接执行 $What"
        & $ScriptPath @ScriptArguments
        return
    }
    $hostArgs = @("-NoProfile")
    if ($env:OS -eq "Windows_NT") { $hostArgs += @("-ExecutionPolicy", "Bypass") }
    $hostArgs += @("-File", $ScriptPath) + $ScriptArguments
    Write-Step "宿主：$hostExe"
    & $hostExe @hostArgs
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（exit=$LASTEXITCODE）" }
}

function Invoke-Tool([string]$NodeExe, [string[]]$Arguments, [string]$What) {
    Write-Step "$What"
    & $NodeExe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$What 失败（exit=$LASTEXITCODE）" }
}

function Invoke-Task([string]$Name) {
    switch ($Name) {
        "typecheck" {
            Write-Head "typecheck"
            $node = Resolve-Node $MinimumNodeForDist "typecheck"
            Write-Step "node: $node"
            Invoke-Tool $node @((Join-Path $Root "node_modules\typescript\bin\tsc"), "-p", "tsconfig.json", "--noEmit") "tsc --noEmit"
            Write-Ok "类型检查通过"
        }
        "tui" {
            Write-Head "tui（external/opentui 类型检查）"
            $node = Resolve-Node $MinimumNodeForDist "tui"
            Write-Step "node: $node"
            Invoke-Tool $node @((Join-Path $Root "node_modules\typescript\bin\tsc"), "-p", "tsconfig.tui.json") "tsc -p tsconfig.tui.json"
            Write-Ok "TUI 类型检查通过"
        }
        "dist" {
            Write-Head "dist"
            $node = Resolve-Node $MinimumNodeForDist "dist"
            Write-Step "node: $node"
            Invoke-Tool $node @((Join-Path $Root "node_modules\typescript\bin\tsc"), "-p", "tsconfig.build.json") "编译到 dist\"
            Invoke-Tool $node @((Join-Path $Root "scripts\copy-node-assets.mjs")) "拷贝 assets/prompts/skills"
            Write-Ok "dist\ 就绪"
        }
        "exe" {
            Write-Head "exe（单文件可执行，含图标）"
            $node = Resolve-Node $MinimumNodeForExe "build:exe"
            $fullVersion = (& $node -v).Trim()
            Write-Step "node: $node ($fullVersion)"
            Invoke-Tool $node @((Join-Path $Root "scripts\build-sea-exe.mjs")) "构建 SEA 可执行文件"
            if (-not (Test-Path $ExePath)) { throw "构建结束但没有产物：$ExePath" }
            $sizeMb = [Math]::Round((Get-Item $ExePath).Length / 1MB, 1)
            Write-Ok "产物：$ExePath ($sizeMb MB)"

            if (-not $SkipSmoke) {
                Write-Step "冒烟：SwarmFlow.exe --version"
                # 原生程序把 ExperimentalWarning 写到 stderr；在 ErrorActionPreference=Stop 下
                # PowerShell 会把它升级成终止错误，因此这一段临时放宽并显式读取退出码。
                $previousPreference = $ErrorActionPreference
                $ErrorActionPreference = "Continue"
                try {
                    $rawOutput = & $ExePath --version 2>&1
                    $smokeExit = $LASTEXITCODE
                }
                finally {
                    $ErrorActionPreference = $previousPreference
                }
                if ($smokeExit -ne 0) { throw "冒烟失败（exit=$smokeExit）" }
                $lines = @($rawOutput | ForEach-Object { $_.ToString() } | Where-Object { $_ -notmatch "ExperimentalWarning|trace-warnings" -and $_.Trim().Length -gt 0 })
                $versionLine = if ($lines.Count -gt 0) { $lines[$lines.Count - 1] } else { "(no output)" }
                Write-Ok "SwarmFlow.exe 可运行，版本：$versionLine"
            }
        }
        "icon" {
            Write-Head "icon（把 ICO 写入 exe）"
            if (-not (Test-Path $IcoPath)) {
                throw "缺少图标文件：$IcoPath。ICO 需自行生成（Photoshop 等）；本项目不再由 PNG 自动生成 ICO。"
            }
            Write-Step "使用 ICO：$IcoPath"
            if (-not (Test-Path $ExePath)) { throw "尚未构建 exe，无法注入图标：$ExePath（先跑 -Task exe）" }

            Write-Step "注入图标到 $ExePath"
            Invoke-HostScript -ScriptPath $IconScript -ScriptArguments @("-ExePath", $ExePath, "-IcoPath", $IcoPath) -What "set-exe-icon.ps1"
            Write-Ok "图标已写入"
        }
        "test" {
            Write-Head "test"
            $node = Resolve-Node $MinimumNodeForDist "test"
            Write-Step "node: $node"
            $vitest = Join-Path $Root "node_modules\vitest\vitest.mjs"
            $arguments = @($vitest, "run")
            if ($TestPath) { $arguments += $TestPath }
            Invoke-Tool $node $arguments "vitest run"
            Write-Ok "测试通过"
        }
        default { throw "未知任务：$Name" }
    }
}

# 任务参数都用相对仓库根的路径（tsconfig、vitest 的 root 解析都看 cwd）：
# 先切到仓库根，结束后恢复调用者位置——脚本可能被 dot-source，不能把别人的 cwd 留改。
Push-Location -LiteralPath $Root
try {
    $tasks = @()
    foreach ($item in $Task) {
        if ($item -eq "all") {
            $tasks += @("typecheck", "tui", "dist", "exe")
            if (-not $SkipTests) { $tasks += "test" }
        }
        else {
            $tasks += $item
        }
    }
    $tasks = $tasks | Select-Object -Unique

    $started = Get-Date
    Write-Host ""
    Write-Host "SwarmFlow build" -ForegroundColor $UiColors.title
    Write-Host ("  root  : " + $Root)
    Write-Host ("  tasks : " + ($tasks -join ", "))

    foreach ($name in $tasks) {
        Invoke-Task $name
    }

    $elapsed = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Write-Host ""
    Write-Host ("全部完成（" + $elapsed + "s）：" + ($tasks -join ", ")) -ForegroundColor $UiColors.success
}
finally {
    Pop-Location
}
