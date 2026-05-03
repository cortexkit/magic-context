# Magic Context — Interactive Setup (Windows)
# Usage: irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex

Write-Host ""
Write-Host "  ✨ Magic Context — Setup" -ForegroundColor Cyan
Write-Host "  ────────────────────────"
Write-Host ""

$package = "@cortexkit/opencode-magic-context"
# Always pin "@latest": without an explicit version, bun x / npx resolve from
# their local on-disk cache rather than re-resolving the npm dist-tag, so a
# user who already installed an older version would keep getting the cached
# bundle even after a patch ships. "@latest" forces a registry round-trip.
$packageLatest = "$package@latest"

if (Get-Command bun -ErrorAction SilentlyContinue) {
    Write-Host "  → Using bun" -ForegroundColor Gray
    Write-Host ""
    & bun x --bun $packageLatest setup
} elseif (Get-Command npx -ErrorAction SilentlyContinue) {
    # Check Node version — @clack/prompts requires styleText from node:util (Node >= 20.12)
    $nodeVer = (node -v 2>$null) -replace '^v',''
    $parts = $nodeVer.Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 12)) {
        Write-Host "  ✗ Node.js $nodeVer is too old (requires >= 20.12)" -ForegroundColor Red
        Write-Host ""
        Write-Host "  Options:" -ForegroundColor Yellow
        Write-Host "    • Install bun (recommended): irm bun.sh/install.ps1 | iex"
        Write-Host "    • Upgrade Node.js: https://nodejs.org"
        Write-Host ""
        exit 1
    }
    Write-Host "  → Using npx (Node $nodeVer)" -ForegroundColor Gray
    Write-Host ""
    & npx -y $packageLatest setup
} else {
    Write-Host "  ✗ Neither bun nor npx found." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install one of:" -ForegroundColor Yellow
    Write-Host "    • bun:  irm bun.sh/install.ps1 | iex"
    Write-Host "    • node: https://nodejs.org (>= 20.12)"
    Write-Host ""
    exit 1
}
