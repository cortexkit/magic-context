# Packages a portable Windows install tree for local OpenCode use.
# Output layout:
#   artifact/magic-context-compiled/
#     plugin/   - OpenCode server + TUI plugin (@cortexkit/opencode-magic-context)
#     cli/      - magic-context CLI
#     INSTALL.md

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$outRoot = Join-Path $repoRoot "artifact/magic-context-compiled"
$pluginSrc = Join-Path $repoRoot "packages/plugin"
$cliSrc = Join-Path $repoRoot "packages/cli"

if (-not (Test-Path (Join-Path $pluginSrc "dist/index.js"))) {
  throw "packages/plugin/dist/index.js is missing. Run 'bun run build' first."
}

if (-not (Test-Path (Join-Path $cliSrc "dist/index.js"))) {
  throw "packages/cli/dist/index.js is missing. Run 'bun run build' first."
}

if (Test-Path $outRoot) {
  Remove-Item $outRoot -Recurse -Force
}

$pluginOut = Join-Path $outRoot "plugin"
$cliOut = Join-Path $outRoot "cli"
New-Item -ItemType Directory -Force -Path $pluginOut, $cliOut | Out-Null

function Copy-Tree {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if (-not (Test-Path $Source)) {
    throw "Source path not found: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

# OpenCode plugin: dist (server) + src/tui + src/shared (TUI export) + package.json
Copy-Item (Join-Path $pluginSrc "package.json") $pluginOut -Force
Copy-Tree -Source (Join-Path $pluginSrc "dist") -Destination (Join-Path $pluginOut "dist")
Copy-Tree -Source (Join-Path $pluginSrc "src/tui") -Destination (Join-Path $pluginOut "src/tui")
Copy-Tree -Source (Join-Path $pluginSrc "src/shared") -Destination (Join-Path $pluginOut "src/shared")

if (Test-Path (Join-Path $pluginSrc "README.md")) {
  Copy-Item (Join-Path $pluginSrc "README.md") $pluginOut -Force
}

# Runtime deps for dist/index.js externals and TUI TSX imports.
Push-Location $pluginOut
bun install --production
Pop-Location

# CLI
Copy-Item (Join-Path $cliSrc "package.json") $cliOut -Force
Copy-Tree -Source (Join-Path $cliSrc "dist") -Destination (Join-Path $cliOut "dist")
if (Test-Path (Join-Path $cliSrc "README.md")) {
  Copy-Item (Join-Path $cliSrc "README.md") $cliOut -Force
}

Push-Location $cliOut
bun install --production
Pop-Location

$installDoc = @"
# Magic Context — Windows compiled install

Extract this folder to e.g. ``D:\Coding\_tools\magic-context-compiled``.

## OpenCode config

**``%USERPROFILE%\.config\opencode\opencode.jsonc``** (server plugin):

```jsonc
"plugin": [
  "file:///D:/Coding/_tools/magic-context-compiled/plugin/dist/index.js"
]
```

**``%USERPROFILE%\.config\opencode\tui.jsonc``** (TUI side panel — use package directory, not dist/index.js):

```jsonc
"plugin": [
  "file:///D:/Coding/_tools/magic-context-compiled/plugin"
]
```

Do **not** point ``tui.jsonc`` at ``dist/index.js`` (that is the server export only).
Do **not** use ``dist/tui/index.js`` — the upstream build does not emit it; TUI loads ``exports["./tui"]`` → ``src/tui/index.tsx``.

Restart OpenCode after changing config.

## CLI

```powershell
bun "D:\Coding\_tools\magic-context-compiled\cli\dist\index.js" doctor
```

Or add ``cli`` to PATH and run ``magic-context doctor``.

## Verify

- ``plugin/dist/index.js`` exists
- ``plugin/src/tui/index.tsx`` exists
- ``plugin/package.json`` exports ``./tui`` → ``./src/tui/index.tsx``
"@

Set-Content -Path (Join-Path $outRoot "INSTALL.md") -Value $installDoc -Encoding utf8

Write-Host "Packaged artifact at $outRoot"
