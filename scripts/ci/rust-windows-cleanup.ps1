param(
    [Parameter(Mandatory = $true)][ValidateSet('inspect', 'remove-system-profile')][string] $Mode,
    [Parameter(Mandatory = $true)][string] $StartedAt,
    [Parameter(Mandatory = $true)][string] $Workspace,
    [Parameter(Mandatory = $true)][string] $ScratchHome
)

$ErrorActionPreference = 'Stop'
$started = [DateTimeOffset]::Parse($StartedAt).UtcDateTime
$workspacePath = [IO.Path]::GetFullPath($Workspace).TrimEnd([char[]]'\/')
$targetPath = Join-Path $workspacePath 'target'
$comparison = [StringComparison]::OrdinalIgnoreCase
$homePath = [IO.Path]::GetFullPath($ScratchHome).TrimEnd([char[]]'\/')
$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([char[]]'\/')
$reparse = [IO.FileAttributes]::ReparsePoint

if (([IO.Path]::GetDirectoryName($homePath) -ne $runnerTemp) -or
    ([IO.Path]::GetFileName($homePath) -notmatch '^mc-windows\.[A-Za-z0-9]+$')) {
    throw "Refusing to inspect or clean an unexpected home: $homePath"
}
for ($ancestor = (Get-Item -LiteralPath $homePath -Force); $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if ($ancestor.Attributes -band $reparse) {
        throw "Refusing to inspect or clean through a reparse point: $($ancestor.FullName)"
    }
}

function Get-HomeInventory([string] $Directory, [int] $Depth) {
    foreach ($item in (Get-ChildItem -LiteralPath $Directory -Force)) {
        [PSCustomObject]@{
            path = $item.FullName.Substring($homePath.Length + 1)
            bytes = if ($item.PSIsContainer) { $null } else { $item.Length }
            attributes = $item.Attributes.ToString()
        }
        if ($Depth -gt 1 -and $item.PSIsContainer -and -not ($item.Attributes -band $reparse)) {
            Get-HomeInventory $item.FullName ($Depth - 1)
        }
    }
}

# On the dedicated job runner, list candidates launched during the test window.
# An orphan's original parent may already be gone; keep its creation time and
# parent ID rather than excluding it for having no live parent.
$processes = @(Get-CimInstance -ClassName Win32_Process -Property Name,ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ForEach-Object {
    if (-not $_.CreationDate -or $_.CreationDate.ToUniversalTime() -lt $started) { return }
    $inTarget = $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$targetPath\", $comparison)
    $testExecutable = $inTarget -or $_.Name -match '-[a-f0-9]{16}\.exe$'
    if ((-not $testExecutable) -and $_.Name -notmatch '^(ck-mc|mc-mock-runner|cargo|git)\.exe$') { return }
    [PSCustomObject]@{
        name = $_.Name
        pid = $_.ProcessId
        parent_pid = $_.ParentProcessId
        started_utc = $_.CreationDate.ToUniversalTime().ToString('o')
        executable = $_.ExecutablePath
        command_line = $_.CommandLine
    }
} | Sort-Object pid)

if ($Mode -eq 'inspect') {
    $files = New-Object 'System.Collections.Generic.List[object]'
    $inventoryError = $null
    try {
        Get-HomeInventory $homePath 8 | ForEach-Object { $files.Add($_) }
    } catch {
        $inventoryError = $_.Exception.Message
    }
    [PSCustomObject]@{
        run_started_utc = $started.ToString('o')
        home = $homePath
        files = @($files | Sort-Object path)
        inventory_error = $inventoryError
        surviving_process_candidates = $processes
    } | ConvertTo-Json -Depth 4
    exit 0
}

if ($processes.Count -ne 0) {
    $processes | ConvertTo-Json -Depth 3
    throw 'Refusing native cleanup while matching processes from the test window are still alive.'
}

# Verify the whole remaining tree before touching it. Do not follow any
# reparse point or treat other AppData directories as Windows-owned caches.
$left = @(Get-HomeInventory $homePath ([int]::MaxValue))
$allowed = '^AppData(?:\\(?:Local|LocalLow)(?:\\Microsoft(?:\\.*)?)?)?$'
$ancestors = '^AppData(?:\\(?:Local|LocalLow)(?:\\Microsoft)?)?$'
$unexpected = @($left | Where-Object {
    ($_.path -notmatch $allowed -or $_.attributes -match 'ReparsePoint' -or
        ($_.path -match $ancestors -and $null -ne $_.bytes))
})
if ($unexpected.Count -ne 0) {
    $unexpected | ForEach-Object { Write-Output "Unexpected home leftover: $($_.path) [$($_.attributes)]" }
    throw 'Unexpected home leftovers; no native removal was attempted.'
}
$caches = @($left | Where-Object { $_.path -match '^AppData\\(?:Local|LocalLow)\\Microsoft$' })
if ($caches.Count -eq 0) {
    throw 'No Windows Microsoft profile directory remains; not retrying native cleanup.'
}
foreach ($cache in $caches) {
    Write-Output "Removing Windows profile directory: $($cache.path)"
    Remove-Item -LiteralPath (Join-Path $homePath $cache.path) -Recurse -Force
}
