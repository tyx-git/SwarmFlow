<#
.SYNOPSIS
    把 ICO 里的图标写进 Windows 可执行文件（PE 资源：RT_ICON + RT_GROUP_ICON）。

.DESCRIPTION
    只改图标资源，不动其它资源 —— SEA 的 NODE_SEA_BLOB 必须保留，因此
    BeginUpdateResource 的 bDeleteExistingResources 固定为 $false。

    关键点（踩过的坑）：**不要删除不存在的资源**。UpdateResource 删一个不存在的
    (type, name, language) 会返回 FALSE/87，并且会污染本次更新会话，使后续
    UpdateResource 全部失败（1359 ERROR_INTERNAL_ERROR）。所以这里先用
    EnumResourceNames/EnumResourceLanguages 枚举出真实存在的图标资源，
    只删除确实存在的项，再写入新图标。

    写入后用 LoadLibraryEx/FindResource 读回校验，尺寸不符即报错退出。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\set-exe-icon.ps1 -ExePath release\SwarmFlow.exe -IcoPath icons\swarmflow.ico
#>
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$IcoPath
)

$ErrorActionPreference = "Stop"

Add-Type -Namespace SwarmFlowIcon -Name Native -MemberDefinition @'
public delegate bool EnumResNameProc(IntPtr hModule, IntPtr lpType, IntPtr lpName, IntPtr lParam);
public delegate bool EnumResLangProc(IntPtr hModule, IntPtr lpType, IntPtr lpName, ushort wLanguage, IntPtr lParam);

[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr LoadLibraryEx(string lpLibFileName, IntPtr hFile, uint dwFlags);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool EnumResourceNames(IntPtr hModule, IntPtr lpType, EnumResNameProc lpEnumFunc, IntPtr lParam);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool EnumResourceLanguages(IntPtr hModule, IntPtr lpType, IntPtr lpName, EnumResLangProc lpEnumFunc, IntPtr lParam);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr FindResource(IntPtr hModule, IntPtr lpName, IntPtr lpType);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SizeofResource(IntPtr hModule, IntPtr hResInfo);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool FreeLibrary(IntPtr hModule);
'@

$RT_ICON = [IntPtr]3
$RT_GROUP_ICON = [IntPtr]14
$LANG = [uint16]1033
$LOAD_LIBRARY_AS_DATAFILE = 0x00000002

if (-not (Test-Path -LiteralPath $ExePath)) { throw "executable not found: $ExePath" }
if (-not (Test-Path -LiteralPath $IcoPath)) { throw "icon not found: $IcoPath" }

# ---- 解析 ICO（ICONDIRENTRY = 16 字节） ----
$bytes = [System.IO.File]::ReadAllBytes($IcoPath)
$count = [System.BitConverter]::ToUInt16($bytes, 4)
if ($count -le 0) { throw "icon contains no images: $IcoPath" }

$entries = @()
for ($i = 0; $i -lt $count; $i++) {
    $offset = 6 + 16 * $i
    $entries += [pscustomobject]@{
        Width      = [int]$bytes[$offset]
        Height     = [int]$bytes[$offset + 1]
        ColorCount = [int]$bytes[$offset + 2]
        Planes     = [System.BitConverter]::ToUInt16($bytes, $offset + 4)
        BitCount   = [System.BitConverter]::ToUInt16($bytes, $offset + 6)
        BytesInRes = [System.BitConverter]::ToUInt32($bytes, $offset + 8)
        Offset     = [System.BitConverter]::ToUInt32($bytes, $offset + 12)
    }
}
Write-Host ("icon frames: " + (($entries | ForEach-Object { if ($_.Width -eq 0) { "256" } else { $_.Width } }) -join ", "))

# ---- 组装 GRPICONDIR（每项 14 字节，含结尾 wID） ----
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$count)
for ($i = 0; $i -lt $count; $i++) {
    $entry = $entries[$i]
    $writer.Write([byte]$entry.Width)
    $writer.Write([byte]$entry.Height)
    $writer.Write([byte]$entry.ColorCount)
    $writer.Write([byte]0)
    $writer.Write([uint16]$entry.Planes)
    $writer.Write([uint16]$entry.BitCount)
    $writer.Write([uint32]$entry.BytesInRes)
    $writer.Write([uint16]($i + 1))
}
$writer.Flush()
$groupBytes = $stream.ToArray()
$stream.Dispose()

# ---- 枚举已存在的图标资源（type, name, language），只删这些 ----
$module = [SwarmFlowIcon.Native]::LoadLibraryEx((Resolve-Path -LiteralPath $ExePath).Path, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($module -eq [IntPtr]::Zero) {
    throw "LoadLibraryEx for enumeration failed (win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

$existing = New-Object System.Collections.ArrayList
try {
    foreach ($type in @($RT_ICON, $RT_GROUP_ICON)) {
        $nameCollector = New-Object System.Collections.ArrayList
        $nameCallback = [SwarmFlowIcon.Native+EnumResNameProc] {
            param([IntPtr]$h, [IntPtr]$t, [IntPtr]$n, [IntPtr]$l)
            # 只处理数字型名称（图标资源本来就是 MAKEINTRESOURCE 形式）
            if ($n.ToInt64() -lt 0x10000) { [void]$nameCollector.Add($n.ToInt64()) }
            return $true
        }
        [void][SwarmFlowIcon.Native]::EnumResourceNames($module, $type, $nameCallback, [IntPtr]::Zero)

        foreach ($id in $nameCollector) {
            $langCollector = New-Object System.Collections.ArrayList
            $langCallback = [SwarmFlowIcon.Native+EnumResLangProc] {
                param([IntPtr]$h, [IntPtr]$t, [IntPtr]$n, [uint16]$lang, [IntPtr]$l)
                [void]$langCollector.Add($lang)
                return $true
            }
            [void][SwarmFlowIcon.Native]::EnumResourceLanguages($module, $type, [IntPtr]$id, $langCallback, [IntPtr]::Zero)
            foreach ($lang in $langCollector) {
                [void]$existing.Add([pscustomobject]@{ Type = $type; Id = $id; Lang = [uint16]$lang })
            }
        }
    }
}
finally {
    [void][SwarmFlowIcon.Native]::FreeLibrary($module)
}

$iconCount = @($existing | Where-Object { $_.Type -eq $RT_ICON }).Count
$groupCount = @($existing | Where-Object { $_.Type -eq $RT_GROUP_ICON }).Count
Write-Host "existing icon resources: $iconCount icon(s), $groupCount group(s)"

# ---- 写入 PE 资源 ----
$handle = [SwarmFlowIcon.Native]::BeginUpdateResource($ExePath, $false)
if ($handle -eq [IntPtr]::Zero) {
    throw "BeginUpdateResource failed (win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

$failure = $null
try {
    foreach ($item in $existing) {
        $removed = [SwarmFlowIcon.Native]::UpdateResource($handle, $item.Type, [IntPtr]$item.Id, $item.Lang, $null, 0)
        if (-not $removed) {
            throw "delete of type=$($item.Type) id=$($item.Id) lang=$($item.Lang) failed (win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
        }
    }

    for ($i = 0; $i -lt $count; $i++) {
        $entry = $entries[$i]
        $image = New-Object byte[] $entry.BytesInRes
        [Array]::Copy($bytes, [int]$entry.Offset, $image, 0, [int]$entry.BytesInRes)
        $ok = [SwarmFlowIcon.Native]::UpdateResource($handle, $RT_ICON, [IntPtr]($i + 1), $LANG, $image, [uint32]$image.Length)
        if (-not $ok) {
            throw "RT_ICON $($i + 1) update failed (win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
        }
    }

    $ok = [SwarmFlowIcon.Native]::UpdateResource($handle, $RT_GROUP_ICON, [IntPtr]1, $LANG, $groupBytes, [uint32]$groupBytes.Length)
    if (-not $ok) {
        throw "RT_GROUP_ICON update failed (win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
}
catch {
    $failure = $_
}
if ($failure) {
    [void][SwarmFlowIcon.Native]::EndUpdateResource($handle, $true)
    throw $failure
}
if (-not [SwarmFlowIcon.Native]::EndUpdateResource($handle, $false)) {
    throw "EndUpdateResource failed (win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

# ---- 读回校验 ----
$module = [SwarmFlowIcon.Native]::LoadLibraryEx((Resolve-Path -LiteralPath $ExePath).Path, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($module -eq [IntPtr]::Zero) {
    throw "LoadLibraryEx for verification failed (win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}
try {
    $iconInfo = [SwarmFlowIcon.Native]::FindResource($module, [IntPtr]1, $RT_ICON)
    $groupInfo = [SwarmFlowIcon.Native]::FindResource($module, [IntPtr]1, $RT_GROUP_ICON)
    if ($iconInfo -eq [IntPtr]::Zero -or $groupInfo -eq [IntPtr]::Zero) {
        throw "verification failed: icon resources not found after update"
    }
    $iconSize = [SwarmFlowIcon.Native]::SizeofResource($module, $iconInfo)
    $groupSize = [SwarmFlowIcon.Native]::SizeofResource($module, $groupInfo)
}
finally {
    [void][SwarmFlowIcon.Native]::FreeLibrary($module)
}

if ($iconSize -ne $entries[0].BytesInRes) {
    throw "verification failed: RT_ICON #1 is $iconSize bytes, expected $($entries[0].BytesInRes)"
}
if ($groupSize -ne $groupBytes.Length) {
    throw "verification failed: RT_GROUP_ICON #1 is $groupSize bytes, expected $($groupBytes.Length)"
}

Write-Host "icon applied: $ExePath"
Write-Host "  frames      : $count"
Write-Host "  RT_ICON #1  : $iconSize bytes"
Write-Host "  group #1    : $groupSize bytes"
