param(
    [Parameter(Mandatory = $true)][ValidateSet('inventory', 'inspect', 'remove-system-profile')][string] $Mode,
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
            modified_utc = $item.LastWriteTimeUtc.ToString('o')
            directory = $item.PSIsContainer
            reparse = [bool]($item.Attributes -band $reparse)
        }
        if ($Depth -gt 1 -and $item.PSIsContainer -and -not ($item.Attributes -band $reparse)) {
            Get-HomeInventory $item.FullName ($Depth - 1)
        }
    }
}

if ($Mode -eq 'inventory') {
    Get-HomeInventory $homePath 8 | Sort-Object path | ForEach-Object {
        "{0}`t{1}`t{2}`t{3}" -f $_.path, $_.bytes, $_.attributes, $_.modified_utc
    }
    exit 0
}

function Get-RunProcesses {
    # An orphan's original parent may already be gone; keep the creation
    # time and parent ID for matching processes on this dedicated runner.
    Get-CimInstance -ClassName Win32_Process -Property Name,ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ForEach-Object {
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
    } | Sort-Object pid
}

$cache = 'AppData\Local\Microsoft\Windows\INetCache'
$junction = "$cache\Content.IE5"
$roaming = 'AppData\Roaming'
$emptyRoaming = @($roaming, "$roaming\Microsoft")
$removableDirectories = @('AppData', 'AppData\Local', 'AppData\Local\Microsoft', 'AppData\Local\Microsoft\Windows', $cache) + $emptyRoaming
$emptyBootstrap = @('data', 'config', 'local', 'roaming')

function Test-AllowedProfileEntry($Item) {
    if ($Item.path -eq $junction) {
        return ($Item.directory -and $Item.reparse)
    }
    return ($removableDirectories -contains $Item.path -and $Item.directory -and -not $Item.reparse)
}

if ($Mode -eq 'inspect') {
    $files = New-Object 'System.Collections.Generic.List[object]'
    $inventoryError = $null
    try {
        Get-HomeInventory $homePath 8 | ForEach-Object { $files.Add($_) }
    } catch {
        $inventoryError = $_.Exception.Message
    }
    $processes = @()
    $processError = $null
    try {
        $processes = @(Get-RunProcesses)
    } catch {
        $processError = $_.Exception.Message
    }
    # The bootstrap creates only these four empty directories. A file or
    # additional directory outside the Windows profile allowlist is evidence.
    $violations = @($files | Where-Object {
        -not (Test-AllowedProfileEntry $_) -and
        -not ($emptyBootstrap -contains $_.path -and $_.directory -and -not $_.reparse)
    })
    [PSCustomObject]@{
        run_started_utc = $started.ToString('o')
        home = $homePath
        files = @($files | Sort-Object path)
        inventory_error = $inventoryError
        process_error = $processError
        surviving_process_candidates = $processes
        roaming = @($files | Where-Object { $_.path -eq $roaming -or $_.path.StartsWith("$roaming\", $comparison) })
        unexpected_home_entries = $violations
    } | ConvertTo-Json -Depth 4
    if ($violations.Count -ne 0) { exit 86 }
    if ($processes.Count -ne 0) { exit 87 }
    if ($inventoryError -or $processError) { exit 88 }
    exit 0
}

$processes = @(Get-RunProcesses)
if ($processes.Count -ne 0) {
    $processes | ConvertTo-Json -Depth 3
    throw 'Refusing native cleanup while matching processes from the test window are still alive.'
}

# Check every leftover before touching any. The only permitted reparse point
# is WinINet's Content.IE5 junction, which is removed without traversal.
$left = @(Get-HomeInventory $homePath ([int]::MaxValue))
$unexpected = @($left | Where-Object { -not (Test-AllowedProfileEntry $_) })
if ($unexpected.Count -ne 0) {
    $unexpected | ForEach-Object { Write-Output "Unexpected home leftover: $($_.path) [$($_.attributes)]" }
    throw 'Unexpected home leftovers; no native removal was attempted.'
}
if ($left.Count -eq 0) {
    throw 'No allowed Windows profile directory remains; not retrying native cleanup.'
}
foreach ($item in ($left | Sort-Object { $_.path.Length } -Descending)) {
    # Nonrecursive directory removal unlinks a junction. For ordinary
    # directories it succeeds only if they are still empty.
    [IO.Directory]::Delete((Join-Path $homePath $item.path), $false)
    Write-Output "Removed Windows profile entry: $($item.path) [$($item.attributes)]"
}
