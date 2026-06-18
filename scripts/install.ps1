# SwarmFlow installer for Windows (x64 / arm64)
# Usage: irm https://raw.githubusercontent.com/tyx-git/SwarmFlow/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = if ($env:SWARMFLOW_REPO) { $env:SWARMFLOW_REPO } else { "tyx-git/SwarmFlow" }
$InstallDir = if ($env:SWARMFLOW_INSTALL_DIR) { $env:SWARMFLOW_INSTALL_DIR } else { "$env:USERPROFILE\.swarmflow\bin" }

# Pick the asset for the real OS architecture. PROCESSOR_ARCHITECTURE lies
# inside an emulated x64 PowerShell on an ARM64 machine, so prefer
# RuntimeInformation (reports the OS, not the process).
$Arch = "x64"
try {
    $OsArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    if ($OsArch -eq "Arm64") { $Arch = "arm64" }
} catch {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") { $Arch = "arm64" }
}
$Asset = "swarmflow-win32-$Arch.tar.gz"

if ($env:SWARMFLOW_VERSION) {
    $Url = "https://www.github.com/tyx-git/SwarmFlow"
} else {
    $Url = "https://www.github.com/tyx-git/SwarmFlow"
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "swarmflow-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
$TarballPath = Join-Path $TempDir $Asset

try {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $TarballPath -UseBasicParsing

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    tar -xzf $TarballPath -C $InstallDir
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to extract tarball"
        exit 1
    }

    # Add to user PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
        Write-Host ""
        Write-Host "Added $InstallDir to your PATH."
        Write-Host "Restart your terminal for PATH changes to take effect."
    }

    $SwarmflowExe = Join-Path $InstallDir "swarmflow.exe"
    if (Test-Path $SwarmflowExe) {
        $Version = & $SwarmflowExe --version 2>$null
        Write-Host ""
        Write-Host "Installed SwarmFlow $Version"
    } else {
        # Bun-compiled binaries on Windows may not have .exe extension
        $SwarmflowBin = Join-Path $InstallDir "swarmflow"
        if (Test-Path $SwarmflowBin) {
            $Version = & $SwarmflowBin --version 2>$null
            Write-Host ""
            Write-Host "Installed SwarmFlow $Version"
        } else {
            Write-Host ""
            Write-Host "Installed SwarmFlow"
        }
    }

    Write-Host ""
    Write-Host "To get started:"
    Write-Host "  swarmflow init"
} finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}
